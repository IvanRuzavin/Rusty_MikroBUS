'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const packageCatalog = require('./c_package_catalog');

const MPLAB_SERVICES_EXTENSION_ID = 'Microchip.mplab-extensions-core';
const MPLAB_PLATFORM_EXTENSION_ID = 'Microchip.mplab-extensions-platforms';
const MPLAB_DEBUG_EXTENSION_ID = 'Microchip.mplab-core-da';
const MPLAB_DEBUG_TYPE = 'mplab-core-da';
const MPLAB_TOOL_PICKER = '${command:pickTool}';
const MICROCHIP_USB_VENDOR_IDS = new Set(['04d8', '03eb']);

const TOOL_NAMES = Object.freeze({
  pickit4_tool_support: 'PICkit 4',
  pickit5_tool_support: 'PICkit 5',
  pkob4_tool_support: 'PKOB4',
  powerdebugger_tool_support: 'Power Debugger',
  edbg_tool_support: 'EDBG',
  icd4_tool_support: 'ICD 4'
});

function programmerAsset(programmer = {}) {
  return packageCatalog.programmerToolAsset(
    programmer.packageName,
    programmer.installerPackage,
    programmer.installer_package,
    programmer.uid,
    programmer.name
  );
}

function isMicrochipProgrammer(programmer = {}) {
  return Boolean(programmerAsset(programmer));
}

function normalizeToolName(value) {
  const text = String(value || '').trim();
  const key = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (key === 'pickit4' || key === 'mplabpickit4') return 'PICkit 4';
  if (key === 'pickit5' || key === 'mplabpickit5') return 'PICkit 5';
  if (key === 'icd4' || key === 'mplabicd4') return 'ICD 4';
  if (key === 'pkob4' || key === 'pkob4toolsupport') return 'PKOB4';
  if (key === 'powerdebugger' || key === 'powerdebuggertoolsupport') return 'Power Debugger';
  if (key === 'edbg' || key === 'edbgtoolsupport') return 'EDBG';
  if (key === 'pickitbasic' || key === 'pickitbasictoolsupport') return 'PICkit Basic';
  return text;
}

function toolName(programmer = {}) {
  const asset = programmerAsset(programmer);
  if (!asset) return undefined;
  // The programmer database row is the best source when one tool-support pack
  // covers a specifically named physical tool. Normalize the common compact
  // spellings to the names used by the MPLAB Debug Adapter.
  const fromRow = normalizeToolName(programmer.name || programmer.uid);
  if (fromRow && !/tool support$/i.test(fromRow)) return fromRow;
  return TOOL_NAMES[asset.name] || normalizeToolName(asset.displayName.replace(/\s+Tool Support$/i, ''));
}

function mcuName(setupOrMetadata = {}) {
  const metadata = setupOrMetadata.metadata || setupOrMetadata;
  return String(metadata?.device?.mcuName || metadata?.sdkConfig?.MCU_NAME || metadata?.device?.uid || '').trim();
}

function recommendedInterface(setupOrMetadata = {}) {
  const mcu = mcuName(setupOrMetadata).toUpperCase();
  if (!mcu) return 'ICSP';

  // 8/16-bit PIC, dsPIC and MIPS PIC32 devices are normally programmed through
  // ICSP/ICD. This also covers PIC32MX/MM/MK/MZ.
  if (/^(PIC10|PIC12|PIC16|PIC18|PIC24|DSPIC|DSPIC|PIC32(?:MX|MM|MK|MZ))/.test(mcu)) return 'ICSP';

  // ARM-based Microchip/SAM devices use SWD in the common development flow.
  if (/^(PIC32C|PIC32CX|PIC32CK|PIC32CM|ATSAM|SAMD|SAME|SAMC|SAML|SAMR|SAMV|SAMS|SAMA)/.test(mcu)) return 'SWD';

  if (/^ATXMEGA/.test(mcu)) return 'PDI';

  // Modern AVR Dx/Ex/DU/EB/EA/SD parts and tinyAVR/megaAVR 0/1-series use
  // UPDI. Older AVR parts can still be selected in MPLAB; ICSP is a safer
  // fallback for those legacy devices.
  if (/^AVR(?:16|32|64|128)/.test(mcu)) return 'UPDI';
  if (/^ATTINY(?:1|2|3|4|8|16|32)\d{2,3}/.test(mcu)) return 'UPDI';
  if (/^ATMEGA(?:8|16|32|48)0[89]$/.test(mcu)) return 'UPDI';

  return 'ICSP';
}

function connectionProfile(setup = {}) {
  const saved = setup.microchipProfile || {};
  return {
    tool: String(saved.tool || toolName(setup.metadata?.programmer || {}) || '').trim(),
    interface: String(saved.interface || recommendedInterface(setup) || '').trim(),
    serial: String(saved.serial || '').trim()
  };
}

function shouldUseToolPicker(profile = {}) {
  // Let MPLAB enumerate the actual connected hardware when no serial has been
  // pinned. This is more robust than assuming the database display name is
  // exactly the USB/tool identity used by the current MPLAB backend.
  return !String(profile.serial || '').trim();
}

function commonConfiguration(setup, name) {
  const profile = connectionProfile(setup);
  if (!profile.tool) throw new Error(`Unable to map '${setup?.metadata?.programmer?.name || setup?.metadata?.programmer?.uid || 'programmer'}' to an MPLAB debugger tool.`);
  const device = mcuName(setup);
  if (!device) throw new Error('The selected C setup does not define an MCU name for the MPLAB Debug Adapter.');
  const result = {
    type: MPLAB_DEBUG_TYPE,
    name,
    device,
    tool: shouldUseToolPicker(profile) ? MPLAB_TOOL_PICKER : profile.tool,
    interface: profile.interface,
    // Private metadata used only by MikroBUS for diagnostics/preflight. The
    // debug adapter ignores unknown configuration fields.
    __mikrobusExpectedMicrochipTool: profile.tool
  };
  if (profile.serial) result.serial = profile.serial;
  return result;
}

function programConfiguration(setup, image, instanceId) {
  return {
    ...commonConfiguration(setup, `MikroBUS C Program: ${setup.name}`),
    request: 'launch',
    program: image,
    noDebug: true,
    stopOnEntry: false,
    __mikrobusMicrochipOperation: true,
    __mikrobusMicrochipInstance: instanceId
  };
}

function eraseConfiguration(setup, instanceId) {
  return {
    ...commonConfiguration(setup, `MikroBUS C Erase: ${setup.name}`),
    request: 'launch',
    noDebug: true,
    eraseOnly: true,
    __mikrobusMicrochipOperation: true,
    __mikrobusMicrochipInstance: instanceId
  };
}

function debugConfiguration(setup, elf, instanceId) {
  return {
    ...commonConfiguration(setup, `MikroBUS C MPLAB: ${setup.name}`),
    request: 'launch',
    program: elf,
    stopOnEntry: true,
    noDebug: false,
    __mikrobusMicrochipC: true,
    __mikrobusCDebug: true,
    __mikrobusCDebugInstance: instanceId
  };
}

function attachConfiguration(setup, elf, instanceId) {
  return {
    ...commonConfiguration(setup, `MikroBUS C MPLAB Attach: ${setup.name}`),
    request: 'attach',
    program: elf,
    stopAtConnect: true,
    __mikrobusMicrochipC: true,
    __mikrobusCDebug: true,
    __mikrobusCDebugInstance: instanceId
  };
}

function findOnPath(name) {
  const pathValue = String(process.env.PATH || '');
  for (const part of pathValue.split(path.delimiter)) {
    if (!part) continue;
    const candidate = path.join(part, name);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return undefined;
}

function readSmallFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch { return ''; }
}

function enumerateLinuxMicrochipUsb(sysRoot = '/sys/bus/usb/devices', devRoot = '/dev/bus/usb') {
  const result = [];
  let entries = [];
  try { entries = fs.readdirSync(sysRoot, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const root = path.join(sysRoot, entry.name);
    const vendor = readSmallFile(path.join(root, 'idVendor')).toLowerCase();
    if (!MICROCHIP_USB_VENDOR_IDS.has(vendor)) continue;
    const bus = readSmallFile(path.join(root, 'busnum'));
    const device = readSmallFile(path.join(root, 'devnum'));
    const node = /^\d+$/.test(bus) && /^\d+$/.test(device)
      ? path.join(devRoot, bus.padStart(3, '0'), device.padStart(3, '0'))
      : '';
    let accessible = false;
    if (node) {
      try {
        fs.accessSync(node, fs.constants.R_OK | fs.constants.W_OK);
        accessible = true;
      } catch {}
    }
    result.push({
      vendor,
      productId: readSmallFile(path.join(root, 'idProduct')).toLowerCase(),
      manufacturer: readSmallFile(path.join(root, 'manufacturer')),
      product: readSmallFile(path.join(root, 'product')),
      serial: readSmallFile(path.join(root, 'serial')),
      node,
      accessible
    });
  }
  return result;
}

function normalizeUsbName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function linuxUsbStatus(expectedTool, sysRoot, devRoot) {
  const devices = enumerateLinuxMicrochipUsb(sysRoot, devRoot);
  const wanted = normalizeUsbName(expectedTool);
  let matching = devices.filter((item) => {
    const text = normalizeUsbName(`${item.manufacturer} ${item.product}`);
    return wanted && (text.includes(wanted) || wanted.includes(text));
  });
  // Some firmware exposes a generic Microchip/Atmel USB product name. If only
  // one supported vendor device is attached, it is still useful for the access
  // preflight even if we cannot classify the model from sysfs text.
  if (!matching.length && devices.length === 1) matching = devices.slice();
  return {
    devices,
    matching,
    present: matching.length > 0,
    accessible: matching.some((item) => item.accessible),
    inaccessibleNodes: matching.filter((item) => item.node && !item.accessible).map((item) => item.node)
  };
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function installLinuxUsbRule(deviceNodes = []) {
  const pkexec = ['/usr/bin/pkexec', '/bin/pkexec', findOnPath('pkexec')].find((item) => item && fs.existsSync(item));
  if (!pkexec) throw new Error('pkexec is not installed, so VS Code cannot install the Microchip USB udev rule automatically.');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-mplab-usb-'));
  const ruleFile = path.join(tempRoot, '70-mikrobus-microchip-tools.rules');
  const rules = [
    '# MikroBUS Embedded Tools - allow MPLAB access to Microchip/Atmel debug probes',
    'SUBSYSTEM=="usb", ATTR{idVendor}=="04d8", MODE="0666"',
    'SUBSYSTEM=="usb", ATTR{idVendor}=="03eb", MODE="0666"',
    ''
  ].join('\n');
  fs.writeFileSync(ruleFile, rules, 'utf8');

  const safeNodes = [...new Set(deviceNodes)]
    .filter((item) => /^\/dev\/bus\/usb\/\d{3}\/\d{3}$/.test(String(item || '')));
  const shell = `set -e\n` +
    `install -m 0644 "$1" /etc/udev/rules.d/70-mikrobus-microchip-tools.rules\n` +
    `if command -v udevadm >/dev/null 2>&1; then udevadm control --reload-rules || true; fi\n` +
    `shift\n` +
    `for node in "$@"; do chmod a+rw "$node" || true; done\n`;
  try {
    await execFileAsync(pkexec, ['/bin/sh', '-c', shell, 'mikrobus-mplab-usb', ruleFile, ...safeNodes]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function ensureLinuxUsbAccess(setup) {
  if (process.platform !== 'linux') return;
  const profile = connectionProfile(setup);
  const status = linuxUsbStatus(profile.tool);
  if (!status.present || status.accessible || !status.inaccessibleNodes.length) return;

  const detail = status.matching.map((item) =>
    `${item.product || profile.tool}${item.serial ? ` (${item.serial})` : ''}: ${item.node || 'USB node unavailable'}`
  ).join('\n');
  const action = await vscode.window.showWarningMessage(
    `${profile.tool} is connected, but VS Code does not have read/write access to its USB device. ` +
    'MPLAB may report this as "no programmer detected". Install a udev rule for Microchip/Atmel debug probes?',
    { modal: true, detail },
    'Fix USB access'
  );
  if (action !== 'Fix USB access') {
    throw new Error(`${profile.tool} is connected but its USB device is not accessible to the current user.`);
  }
  await installLinuxUsbRule(status.inaccessibleNodes);
  const after = linuxUsbStatus(profile.tool);
  if (after.present && !after.accessible) {
    throw new Error(
      `${profile.tool} is still not accessible after installing the udev rule. ` +
      'Reconnect the programmer once, then retry.'
    );
  }
}

async function ensureExtension(extensionId, label) {
  let extension = vscode.extensions.getExtension(extensionId);
  if (!extension) {
    try {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', extensionId);
    } catch {}
    extension = vscode.extensions.getExtension(extensionId);
  }
  if (!extension) throw new Error(`${label} (${extensionId}) is required. Install it and reload VS Code.`);
  await extension.activate();
  return extension;
}

async function ensureDebugExtension(setup) {
  // mplab-core-da requires MPLAB Services; Platform owns the backend process
  // used by the current Microchip extension stack. Activate all three in a
  // deterministic order so a program/debug request cannot race first startup.
  await ensureExtension(MPLAB_SERVICES_EXTENSION_ID, 'MPLAB Services');
  await ensureExtension(MPLAB_PLATFORM_EXTENSION_ID, 'MPLAB Platform');
  const extension = await ensureExtension(MPLAB_DEBUG_EXTENSION_ID, 'Microchip Debug Adapter for MPLAB');
  await ensureLinuxUsbAccess(setup);
  return extension;
}


async function runTransient(configuration, setup, timeoutMs = 180000) {
  await ensureDebugExtension(setup);
  const folder = vscode.workspace.workspaceFolders?.[0];
  const instanceId = configuration.__mikrobusMicrochipInstance;
  let sessionId;
  let finished = false;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const cleanup = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    startDisposable.dispose();
    stopDisposable.dispose();
  };
  const startDisposable = vscode.debug.onDidStartDebugSession((session) => {
    if (session.type !== MPLAB_DEBUG_TYPE) return;
    if (session.configuration?.__mikrobusMicrochipInstance !== instanceId) return;
    sessionId = session.id;
  });
  const stopDisposable = vscode.debug.onDidTerminateDebugSession((session) => {
    if (session.type !== MPLAB_DEBUG_TYPE) return;
    if (session.configuration?.__mikrobusMicrochipInstance !== instanceId && (!sessionId || session.id !== sessionId)) return;
    cleanup();
    resolveDone();
  });
  const timer = setTimeout(() => {
    cleanup();
    rejectDone(new Error(`MPLAB operation did not finish within ${Math.round(timeoutMs / 1000)} seconds.`));
  }, timeoutMs);

  try {
    const started = await vscode.debug.startDebugging(folder, configuration, { suppressDebugView: true, compact: true });
    if (!started) throw new Error('VS Code did not start the MPLAB programmer operation.');
    await done;
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function program(setup, image) {
  const instanceId = `microchip-program-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await runTransient(programConfiguration(setup, image, instanceId), setup);
}

async function erase(setup) {
  const instanceId = `microchip-erase-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await runTransient(eraseConfiguration(setup, instanceId), setup);
}

async function startAttach(setup, elf, instanceId) {
  await ensureDebugExtension(setup);
  const configuration = attachConfiguration(setup, elf, instanceId);
  const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], configuration);
  if (!started) throw new Error('VS Code did not start the MPLAB debug session.');
  return configuration;
}

module.exports = {
  MPLAB_SERVICES_EXTENSION_ID,
  MPLAB_PLATFORM_EXTENSION_ID,
  MPLAB_DEBUG_EXTENSION_ID,
  MPLAB_DEBUG_TYPE,
  MPLAB_TOOL_PICKER,
  programmerAsset,
  isMicrochipProgrammer,
  normalizeToolName,
  toolName,
  recommendedInterface,
  connectionProfile,
  programConfiguration,
  eraseConfiguration,
  debugConfiguration,
  attachConfiguration,
  ensureDebugExtension,
  ensureLinuxUsbAccess,
  program,
  erase,
  startAttach,
  _test: {
    programmerAsset,
    isMicrochipProgrammer,
    normalizeToolName,
    toolName,
    recommendedInterface,
    connectionProfile,
    programConfiguration,
    eraseConfiguration,
    debugConfiguration,
    attachConfiguration,
    shouldUseToolPicker,
    enumerateLinuxMicrochipUsb,
    linuxUsbStatus
  }
};
