'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const TI_XDS110_PROGRAMMER_UID = 'ti_xds110';
const TI_EMBEDDED_DEBUG_EXTENSION_ID = 'ti-development-tools.ti-embedded-debug';
const XDS110_INTERFACE_CFG = './interface/xds110.cfg';
const MSPM0_LAUNCHPAD_CFG = './board/ti_mspm0_launchpad.cfg';

function syntheticProgrammer() {
  return {
    uid: TI_XDS110_PROGRAMMER_UID,
    name: 'TI XDS110 (LaunchPad onboard)',
    description: 'Programs and debugs MSPM0 LaunchPads through their onboard XDS110 using TI Embedded Debug/OpenOCD.',
    installerPackage: '',
    deviceSupportPackage: '',
    external: true,
    flashOnly: false
  };
}

function isMspm0Device(device = {}) {
  const identity = [
    device.mcuName,
    device.uid,
    device.familyUid,
    device.family_uid,
    device.name
  ].map((value) => String(value || '').toUpperCase()).join(' ');
  return /\bMSPM0[A-Z0-9_-]*/.test(identity);
}

function expandHome(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith(`~${path.sep}`)) return path.join(os.homedir(), text.slice(2));
  return text;
}

function normalizeExistingFile(value) {
  const candidate = expandHome(value);
  if (!candidate) return undefined;
  try {
    return fs.statSync(candidate).isFile() ? path.resolve(candidate) : undefined;
  } catch {
    return undefined;
  }
}

function hasOpenOcdScripts(root) {
  if (!root) return false;
  return fs.existsSync(path.join(root, 'interface', 'xds110.cfg')) &&
    fs.existsSync(path.join(root, 'board', 'ti_mspm0_launchpad.cfg'));
}

function scriptRootCandidates(openocd) {
  const dir = path.dirname(openocd);
  return [
    path.resolve(dir, '..', 'share', 'openocd', 'scripts'),
    path.resolve(dir, '..', '..', 'share', 'openocd', 'scripts'),
    path.resolve(dir, 'share', 'openocd', 'scripts')
  ];
}

function findTiResourceRoot() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Texas Instruments', 'ti-embedded-debug');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Texas Instruments', 'ti-embedded-debug');
  }
  return path.join(os.homedir(), '.config', 'Texas Instruments', 'ti-embedded-debug');
}

function findFileRecursive(root, names, maxDepth = 7) {
  if (!root || !fs.existsSync(root)) return undefined;
  const wanted = new Set((Array.isArray(names) ? names : [names]).map((name) => String(name).toLowerCase()));
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isFile() && wanted.has(entry.name.toLowerCase())) return path.join(current.directory, entry.name);
    }
    if (current.depth >= maxDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  return undefined;
}

function configuredOpenOcd() {
  const configured = String(vscode.workspace.getConfiguration('ti-embedded-debug').get('openocdExecutablePath', '') || '').trim();
  return normalizeExistingFile(configured);
}

function discoverOpenOcd() {
  const configured = configuredOpenOcd();
  if (configured) return configured;
  const root = findTiResourceRoot();
  const names = process.platform === 'win32' ? ['openocd.exe'] : ['openocd'];
  return findFileRecursive(path.join(root, 'openocd'), names, 7);
}

function discoverTiGdb() {
  const root = findTiResourceRoot();
  const names = process.platform === 'win32' ? ['arm-none-eabi-gdb.exe'] : ['arm-none-eabi-gdb'];
  return findFileRecursive(path.join(root, 'arm-none-eabi-gdb'), names, 7);
}

function resolveTools(setup = {}) {
  const explicitOpenOcd = normalizeExistingFile(setup.tools?.tiOpenOcd || setup.tools?.openocd);
  const openocd = explicitOpenOcd || discoverOpenOcd();
  if (!openocd) {
    throw new Error(
      'TI XDS110 requires TI Embedded Debug for VS Code and its OpenOCD dependency. ' +
      'Install ti-development-tools.ti-embedded-debug, run its "Install Dependencies" action, then retry.'
    );
  }

  const explicitScripts = String(setup.tools?.tiOpenOcdScripts || setup.tools?.openocdScripts || '').trim();
  const scriptCandidates = [
    explicitScripts ? path.resolve(expandHome(explicitScripts)) : undefined,
    ...scriptRootCandidates(openocd)
  ].filter(Boolean);
  const scripts = scriptCandidates.find(hasOpenOcdScripts);
  if (!scripts) {
    throw new Error(
      `TI OpenOCD was found at ${openocd}, but its MSPM0 scripts were not found. ` +
      'The required files are interface/xds110.cfg and board/ti_mspm0_launchpad.cfg. ' +
      'Use the OpenOCD installed by TI Embedded Debug rather than an older system OpenOCD.'
    );
  }

  const gdb = normalizeExistingFile(setup.tools?.gdb) || discoverTiGdb();
  return { openocd, scripts, gdb };
}

function tclQuote(value) {
  return `{${String(value).replace(/\\/g, '/').replace(/}/g, '\\}')}}`;
}

function runOpenOcd(tools, commands, options = {}) {
  const args = [
    '-s', tools.scripts,
    '-f', XDS110_INTERFACE_CFG,
    '-f', MSPM0_LAUNCHPAD_CFG
  ];
  for (const command of commands) args.push('-c', command);
  const channel = options.channel;
  if (channel) {
    channel.show(true);
    channel.appendLine(`\n> ${path.basename(tools.openocd)} ${args.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ')}`);
  }
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(tools.openocd, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: false,
      windowsHide: true
    });
    child.stdout.on('data', (chunk) => channel?.append(chunk.toString()));
    child.stderr.on('data', (chunk) => channel?.append(chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`TI OpenOCD exited with code ${code}. See the MikroBUS C output.`));
    });
  });
}

async function program(setup, image, options = {}) {
  if (!image || !fs.existsSync(image)) throw new Error(`TI programming image does not exist: ${image}`);
  const tools = resolveTools(setup);
  options.onStatus?.('Connecting to XDS110...');
  await runOpenOcd(tools, [
    // Keep OpenOCD alive after program/verify so we can use the MSPM0-specific
    // board reset. mspm0_board_reset toggles the device nRST line, which is
    // more explicit/reliable for LaunchPads than relying only on generic reset.
    `program ${tclQuote(path.resolve(image))} verify`,
    'mspm0_board_reset',
    'shutdown'
  ], options);
  options.onStatus?.('Programming complete; target reset through nRST.');
}

async function erase(setup, options = {}) {
  const tools = resolveTools(setup);
  options.onStatus?.('Connecting to XDS110...');
  await runOpenOcd(tools, [
    'init',
    'reset halt',
    // Use the generic MAIN-bank erase path for every MSPM0 family. OpenOCD's
    // mspm0_mass_erase helper is explicitly unsupported on MSPM0C devices.
    'flash erase_sector 0 0 last',
    'mspm0_board_reset',
    'shutdown'
  ], options);
  options.onStatus?.('Erase complete.');
}

function debugConfiguration(setup, projectRoot, elf, instanceId) {
  const tools = resolveTools(setup);
  const mcu = String(setup.metadata?.device?.mcuName || setup.metadata?.sdkConfig?.MCU_NAME || setup.metadata?.device?.uid || '').trim();
  const configuration = {
    type: 'cortex-debug',
    request: 'launch',
    name: `MikroBUS C XDS110: ${setup.name}`,
    cwd: projectRoot,
    executable: elf,
    servertype: 'openocd',
    serverpath: tools.openocd,
    searchDir: [tools.scripts],
    configFiles: [XDS110_INTERFACE_CFG, MSPM0_LAUNCHPAD_CFG],
    runToEntryPoint: 'main',
    showDevDebugOutput: 'none',
    deviceName: mcu,
    __mikrobusTiXds110: true,
    __mikrobusCDebugInstance: instanceId,
    __mikrobusCDebug: true
  };
  if (tools.gdb) configuration.gdbPath = tools.gdb;
  return configuration;
}

function linuxUdevHint() {
  if (process.platform !== 'linux') return '';
  return 'On Linux, TI Embedded Debug also requires its TI udev rules installation script to be run once with sudo.';
}

module.exports = {
  TI_XDS110_PROGRAMMER_UID,
  TI_EMBEDDED_DEBUG_EXTENSION_ID,
  XDS110_INTERFACE_CFG,
  MSPM0_LAUNCHPAD_CFG,
  syntheticProgrammer,
  isMspm0Device,
  resolveTools,
  program,
  erase,
  debugConfiguration,
  linuxUdevHint,
  _test: { expandHome, hasOpenOcdScripts, scriptRootCandidates, tclQuote }
};
