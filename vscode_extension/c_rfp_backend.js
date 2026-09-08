'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const vscode = require('vscode');
const packages = require('./c_package_manager');

const RFP_PROGRAMMER_UID = 'renesas_rfp';
const RFP_DOWNLOAD_URL = 'https://www.renesas.com/en/software-tool/renesas-flash-programmer-programming-gui';
const RENESAS_DEBUG_EXTENSION_ID = 'RenesasElectronicsCorporation.renesas-debug';

function syntheticProgrammer() {
  return {
    uid: RFP_PROGRAMMER_UID,
    name: 'Renesas Flash Programmer (rfp-cli)',
    description: 'Managed Renesas Flash Programmer CLI. Flash/erase uses rfp-cli; RX and RL78 setups using E2 or E2 Lite can debug through the Renesas Debug extension.',
    installerPackage: 'renesas_rfp',
    deviceSupportPackage: '',
    external: false,
    flashOnly: true
  };
}

function isRenesasDevice(device = {}) {
  const vendor = String(device.vendor || device.vendorName || '').toLowerCase();
  const family = String(device.familyUid || device.family_uid || '').toUpperCase();
  const uid = String(device.uid || device.mcuName || '').toUpperCase();
  return vendor.includes('renesas') || /^(RL78|RX|RA|RH850|RE\b)/.test(family) || /^R[57]/.test(uid);
}


function isRxDevice(metadata = {}) {
  const family = String(metadata?.device?.familyUid || metadata?.device?.family_uid || metadata?.familyUid || metadata?.family_uid || '').trim().toUpperCase();
  const mcu = String(metadata?.device?.mcuName || metadata?.device?.uid || metadata?.mcuName || metadata?.uid || '').trim().toUpperCase();
  return family.startsWith('RX') || /^R5F5/.test(mcu);
}

function isRl78Device(metadata = {}) {
  const family = String(metadata?.device?.familyUid || metadata?.device?.family_uid || metadata?.familyUid || metadata?.family_uid || '').trim().toUpperCase();
  const mcu = String(metadata?.device?.mcuName || metadata?.device?.uid || metadata?.mcuName || metadata?.uid || '').trim().toUpperCase();
  return family.includes('RL78') || /^R7F10/.test(mcu) || /^R7F1/.test(mcu);
}

function normalizeRxDebugDevice(mcuName) {
  const normalized = String(mcuName || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
  // Renesas' RX GDB server uses the device code rather than the full package
  // orderable part number. For example RX26T R5F526TFCDFP is debugged as
  // R5F526TF. The first 8 characters are the canonical RX debugger device code.
  if (/^R5F[A-Z0-9]{5}/.test(normalized)) return normalized.slice(0, 8);
  return normalized;
}

function renesasDebuggerType(profile = {}) {
  if (profile.connection !== 'tool') return undefined;
  const tool = String(profile.tool || '').trim().toLowerCase();
  if (tool === 'e2l' || tool === 'e2lite') return 'E2LITE';
  if (tool === 'e2') return 'E2';
  return undefined;
}

function effectiveToolInterface(profile = {}) {
  const deviceType = String(profile.deviceType || '').trim().toUpperCase();
  const tool = String(profile.tool || '').trim().toLowerCase();
  const configured = String(profile.interface || '').trim().toLowerCase();
  // RFP talks to RL78 through the E2/E2 Lite TOOL0 path using 1-wire UART.
  // Older extension builds incorrectly saved FINE for this combination, so
  // normalize those existing profiles at execution time as well as in the UI.
  if (deviceType === 'RL78' && (tool === 'e2' || tool === 'e2l' || tool === 'e2lite')) return 'uart1';
  if (configured) return configured;
  if (deviceType === 'RA' || tool === 'jlink') return 'swd';
  return 'fine';
}

function normalizeRl78DebugDevice(mcuName) {
  return String(mcuName || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
}

function renesasRxDebugTarget(setup = {}, profile = {}) {
  if (!isRxDevice(setup.metadata || setup)) return undefined;
  const debuggerType = renesasDebuggerType(profile);
  if (!debuggerType) return undefined;
  const mcuName = setup?.metadata?.device?.mcuName || setup?.metadata?.device?.uid || setup?.mcuName || setup?.uid;
  const device = normalizeRxDebugDevice(mcuName);
  if (!device) return undefined;
  const interfaceName = String(profile.interface || 'fine').trim().toLowerCase();
  const target = {
    deviceFamily: 'RX',
    device,
    debuggerType,
    serverParameters: ['-uUseFine=', interfaceName === 'fine' ? '1' : '0']
  };
  return target;
}

function renesasRl78DebugTarget(setup = {}, profile = {}) {
  if (!isRl78Device(setup.metadata || setup)) return undefined;
  const debuggerType = renesasDebuggerType(profile);
  if (!debuggerType) return undefined;
  if (effectiveToolInterface(profile) !== 'uart1') return undefined;
  const mcuName = setup?.metadata?.device?.mcuName || setup?.metadata?.device?.uid || setup?.mcuName || setup?.uid;
  const device = normalizeRl78DebugDevice(mcuName);
  if (!device) return undefined;
  const target = {
    deviceFamily: 'RL78',
    device,
    debuggerType,
    // Mirror the known-good RL78/G24 e2 studio E2/E2 Lite profile.
    // Do NOT inject -uCore through serverParameters: Renesas Debug explicitly
    // manages that argument itself. For G24, disabling FAA tells the adapter to
    // select the CPU core while keeping the application as a single debug
    // session. The remaining values match the working e2 studio server profile.
    serverParameters: [
      '-w', '0',
      '-uSelfCodeSet=', '0',
      '-upermitFlash=', '1',
      '-uuseWideVoltageMode=', '1',
      '-ueraseRom=', '1',
      '-ubankSwapEnable=', '0',
      '-uresetOnReload=', '1',
      '-ustopTimerEmu=', '0',
      '-ustopSerialEmu=', '0',
      '-umaskInternalResetSignal=', '0',
      '-umaskTargetResetSignal=', '0',
      '-n', '0',
      '-uverifyOnWritingMemory=', '1',
      '-uAllowRRMDMM=', '0',
      '-uOSRestriction=', '0',
      '-uRelayBreak=', '1',
      '-uSyncMode=', 'async',
      '-uTraceCore=', 'CPU'
    ]
  };
  const family = String(setup?.metadata?.device?.familyUid || setup?.metadata?.device?.family_uid || setup?.familyUid || setup?.family_uid || '').trim().toUpperCase();
  if (family.includes('G24') || /^R7F101/.test(device)) {
    target.disabledCores = ['FAA'];
  }
  return target;
}

function renesasDebugTarget(setup = {}, profile = {}) {
  return renesasRxDebugTarget(setup, profile) || renesasRl78DebugTarget(setup, profile);
}

function defaultDeviceType(metadata = {}) {
  const family = String(metadata?.device?.familyUid || metadata?.device?.family_uid || '').trim().toUpperCase();
  const mcu = String(metadata?.device?.mcuName || metadata?.device?.uid || '').trim().toUpperCase();
  if (family.includes('RL78') || /^R7F10/.test(mcu)) return 'RL78';
  if (family.startsWith('RX1')) return 'RX100';
  if (family.startsWith('RX2')) return 'RX200';
  if (family.startsWith('RX6')) return 'RX600';
  if (family.startsWith('RX7')) return 'RX700';
  if (family.startsWith('RX')) {
    // RX device part numbers do not expose the RFP family directly. Current
    // mikroSDK RX26T support belongs to the RX200 RFP device group.
    if (/^R5F52/.test(mcu)) return 'RX200';
    if (/^R5F56/.test(mcu)) return 'RX600';
    if (/^R5F57/.test(mcu)) return 'RX700';
    return 'RX200';
  }
  if (family.startsWith('RA') || /^R7FA/.test(mcu)) return 'RA';
  if (family.startsWith('RH850')) return 'RH850';
  if (family.startsWith('RE')) return 'RE';
  return family || 'RL78';
}

function defaultProfile(setup = {}) {
  const deviceType = defaultDeviceType(setup.metadata || {});
  const family = String(setup?.metadata?.device?.familyUid || '').toUpperCase();
  const isRl78 = deviceType === 'RL78';
  const isRx = /^RX/.test(deviceType) || family.startsWith('RX');
  if (isRl78) {
    return {
      schemaVersion: 1,
      deviceType,
      connection: 'uart',
      port: process.platform === 'win32' ? 'COM3' : process.platform === 'darwin' ? '/dev/cu.usbserial' : '/dev/ttyUSB0',
      interface: 'uart',
      speed: 115200,
      dtrInv: true,
      reset: true,
      run: false
    };
  }
  if (isRx) {
    return {
      schemaVersion: 1,
      deviceType,
      connection: 'tool',
      tool: 'e2l',
      interface: 'fine',
      speed: undefined,
      dtrInv: false,
      reset: false,
      run: true
    };
  }
  return {
    schemaVersion: 1,
    deviceType,
    connection: 'tool',
    tool: 'e2l',
    interface: family.startsWith('RA') || deviceType === 'RA' ? 'swd' : 'fine',
    speed: undefined,
    dtrInv: false,
    reset: false,
    run: true
  };
}

function normalizeExecutableCandidate(candidate) {
  const configured = String(candidate || '').trim();
  if (!configured) return undefined;
  const expanded = configured.replace(/^~(?=$|[\\/])/, os.homedir());
  try {
    const stat = fs.statSync(expanded);
    if (stat.isFile()) return expanded;
    if (stat.isDirectory()) {
      for (const name of process.platform === 'win32' ? ['rfp-cli.exe', 'rfp-cli'] : ['rfp-cli']) {
        const file = path.join(expanded, name);
        if (fs.existsSync(file)) return file;
      }
    }
  } catch {}
  return undefined;
}

function resolveRfpCli(setup) {
  // RFP is a managed C programmer package. Do not silently execute a copy from
  // ~/Downloads or PATH: the setup must point at the version imported through
  // Development Environment -> Programmers.
  return normalizeExecutableCandidate(setup?.tools?.rfpCli);
}

async function configureProfile(setup, existing) {
  const base = { ...defaultProfile(setup), ...(existing || {}) };
  const connection = await vscode.window.showQuickPick([
    { label: 'UART / serial boot mode', description: 'Typical RL78 boot-mode programming', value: 'uart' },
    { label: 'E2 emulator Lite', description: 'Renesas E2 Lite probe (RL78 uses 1-wire UART)', value: 'e2l' },
    { label: 'E2 emulator', description: 'Renesas E2 programming probe', value: 'e2' },
    { label: 'J-Link', description: 'RFP programming through SEGGER J-Link where supported', value: 'jlink' }
  ], {
    title: `Configure RFP connection for ${setup?.metadata?.device?.mcuName || setup?.metadata?.device?.uid || 'Renesas MCU'}`,
    placeHolder: 'Select the connection used by rfp-cli',
    ignoreFocusOut: true
  });
  if (!connection) return undefined;

  const deviceType = await vscode.window.showInputBox({
    title: 'RFP device type',
    prompt: 'Value passed to rfp-cli -d. Examples: RL78, RX200, RA, RH850.',
    value: base.deviceType || defaultDeviceType(setup.metadata || {}),
    ignoreFocusOut: true,
    validateInput: (value) => String(value || '').trim() ? undefined : 'Enter an RFP device type.'
  });
  if (!deviceType) return undefined;

  if (connection.value === 'uart') {
    const port = await vscode.window.showInputBox({
      title: 'RFP serial port',
      value: base.connection === 'uart' && base.port ? String(base.port) : (process.platform === 'win32' ? 'COM3' : '/dev/ttyUSB0'),
      prompt: 'Serial port passed with -port.',
      ignoreFocusOut: true
    });
    if (!port) return undefined;
    const speedText = await vscode.window.showInputBox({
      title: 'RFP UART speed',
      value: String(base.speed || 115200),
      prompt: 'Baud rate passed with -s.',
      ignoreFocusOut: true,
      validateInput: (value) => Number(value) > 0 ? undefined : 'Enter a positive baud rate.'
    });
    if (!speedText) return undefined;
    const dtr = await vscode.window.showQuickPick([
      { label: 'Invert DTR', description: 'Pass -dtr-inv (matches the tested RL78 setup)', value: true },
      { label: 'Normal DTR', description: 'Do not pass -dtr-inv', value: false }
    ], { ignoreFocusOut: true, placeHolder: 'DTR behavior' });
    if (!dtr) return undefined;
    return {
      schemaVersion: 1,
      deviceType: String(deviceType).trim(),
      connection: 'uart',
      port: String(port).trim(),
      interface: 'uart',
      speed: Number(speedText),
      dtrInv: dtr.value,
      reset: true,
      run: false
    };
  }

  const normalizedDeviceType = String(deviceType).trim().toUpperCase();
  const defaultInterface = normalizedDeviceType === 'RL78' && (connection.value === 'e2' || connection.value === 'e2l')
    ? 'uart1'
    : (connection.value === 'jlink' || normalizedDeviceType === 'RA' ? 'swd' : 'fine');
  const interfaceName = await vscode.window.showInputBox({
    title: 'RFP interface',
    value: base.connection === 'tool' && base.tool === connection.value && base.interface ? String(base.interface) : defaultInterface,
    prompt: 'Interface passed with -if. Use uart1 for RL78 with E2/E2 Lite, fine for RX, and swd for RA.',
    ignoreFocusOut: true,
    validateInput: (value) => String(value || '').trim() ? undefined : 'Enter an interface.'
  });
  if (!interfaceName) return undefined;
  return {
    schemaVersion: 1,
    deviceType: String(deviceType).trim(),
    connection: 'tool',
    tool: connection.value,
    interface: String(interfaceName).trim(),
    speed: undefined,
    dtrInv: false,
    reset: false,
    run: true
  };
}

function connectionArgs(profile = {}) {
  const args = ['-d', String(profile.deviceType || '').trim()];
  if (profile.connection === 'uart') {
    args.push('-port', String(profile.port || '').trim(), '-if', String(profile.interface || 'uart').trim());
    if (profile.dtrInv) args.push('-dtr-inv');
    if (Number(profile.speed) > 0) args.push('-s', String(Math.trunc(Number(profile.speed))));
  } else {
    args.push('-t', String(profile.tool || 'e2l').trim(), '-if', effectiveToolInterface(profile));
  }
  return args;
}

function programArgs(profile, hexFile) {
  const args = connectionArgs(profile);
  if (profile.reset) args.push('-reset');
  if (profile.run) args.push('-run');
  args.push('-a', hexFile);
  return args;
}

function eraseArgs(profile) {
  const args = connectionArgs(profile);
  args.push('-e');
  return args;
}

function statusForLine(line) {
  const text = String(line || '').trim();
  if (!text) return undefined;
  if (/connecting the tool|connecting the target/i.test(text)) return 'Connecting...';
  if (/erase/i.test(text)) return 'Erasing...';
  if (/program|write/i.test(text)) return 'Programming...';
  if (/verif/i.test(text)) return 'Verifying...';
  if (/disconnect/i.test(text)) return 'Finishing...';
  return undefined;
}

function runRfp(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    options.channel?.appendLine(`\n> ${path.basename(executable)} ${args.map((item) => /\s/.test(item) ? JSON.stringify(item) : item).join(' ')}`);
    const child = childProcess.spawn(executable, args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      windowsHide: true
    });
    let buffer = '';
    const consume = (chunk) => {
      const text = chunk.toString();
      options.channel?.append(text);
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const status = statusForLine(line);
        if (status) options.onStatus?.(status);
      }
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('error', (error) => reject(new Error(`rfp-cli failed to start: ${error.message}`)));
    child.once('close', (code) => {
      if (buffer) {
        const status = statusForLine(buffer);
        if (status) options.onStatus?.(status);
      }
      if (code === 0) resolve();
      else reject(new Error(`rfp-cli exited with code ${code}. See the MikroBUS C output.`));
    });
  });
}

async function program(setup, hexFile, profile, options = {}) {
  const executable = resolveRfpCli(setup);
  if (!executable) throw new Error('Managed rfp-cli was not found. Install Renesas Flash Programmer from MikroBUS C: Development Environment → Programmers.');
  await runRfp(executable, programArgs(profile, hexFile), options);
}

async function erase(setup, profile, options = {}) {
  const executable = resolveRfpCli(setup);
  if (!executable) throw new Error('Managed rfp-cli was not found. Install Renesas Flash Programmer from MikroBUS C: Development Environment → Programmers.');
  await runRfp(executable, eraseArgs(profile), options);
}

module.exports = {
  RFP_PROGRAMMER_UID,
  RFP_DOWNLOAD_URL,
  RENESAS_DEBUG_EXTENSION_ID,
  syntheticProgrammer,
  isRenesasDevice,
  isRxDevice,
  isRl78Device,
  normalizeRxDebugDevice,
  normalizeRl78DebugDevice,
  renesasDebuggerType,
  effectiveToolInterface,
  renesasRxDebugTarget,
  renesasRl78DebugTarget,
  renesasDebugTarget,
  defaultDeviceType,
  defaultProfile,
  configureProfile,
  resolveRfpCli,
  connectionArgs,
  programArgs,
  eraseArgs,
  program,
  erase,
  _test: { isRenesasDevice, isRxDevice, isRl78Device, normalizeRxDebugDevice, normalizeRl78DebugDevice, renesasDebuggerType, effectiveToolInterface, renesasRxDebugTarget, renesasRl78DebugTarget, renesasDebugTarget, defaultDeviceType, defaultProfile, connectionArgs, programArgs, eraseArgs, statusForLine }
};
