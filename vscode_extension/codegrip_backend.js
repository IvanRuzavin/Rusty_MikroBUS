const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 15000;

function firstDefined(source, keys, fallback = undefined) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return fallback;
}

function asBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', 'yes', 'enabled', '1'].includes(normalized)) return true;
  if (['false', 'no', 'disabled', '0'].includes(normalized)) return false;
  return fallback;
}

function asPort(value) {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : 0;
}

function normalizeConnectionProfile(rawProfile) {
  if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) {
    throw new Error('The CODEGRIP connection profile must be a JSON object.');
  }
  const communicationType = String(firstDefined(rawProfile, ['communicationType', 'Communication Type'], 'usb')).trim().toLowerCase();
  if (!['usb', 'wifi'].includes(communicationType)) {
    throw new Error(`Unsupported CODEGRIP communication type '${communicationType}'. Use 'usb' or 'wifi'.`);
  }

  const serialNumber = String(firstDefined(rawProfile, ['serialNumber', 'Serial'], '')).trim();
  if (!serialNumber) throw new Error('The CODEGRIP connection profile must contain serialNumber or Serial.');

  return {
    communicationType,
    serialNumber,
    ip: String(firstDefined(rawProfile, ['ip', 'Ip Address', 'IP Address'], '')).trim(),
    hwTokens: String(firstDefined(rawProfile, ['hwTokens', 'Hardware tokens', 'Hardware Tokens'], '')).trim(),
    linkPortDebug: asPort(firstDefined(rawProfile, ['linkPortDebug', 'debugPort'], 0)),
    linkPortConfig: asPort(firstDefined(rawProfile, ['linkPortConfig', 'configPort'], 0)),
    sslEnable: asBoolean(firstDefined(rawProfile, ['sslEnable', 'ssl'], false)),
    linkPasswordDebug: String(firstDefined(rawProfile, ['linkPasswordDebug', 'debugPassword'], '')),
    linkPasswordConfig: String(firstDefined(rawProfile, ['linkPasswordConfig', 'configPassword'], '')),
    protocol: String(firstDefined(rawProfile, ['protocol', 'Protocol'], 'SWD')).trim() || 'SWD',
    speed: String(firstDefined(rawProfile, ['speed', 'Speed'], '')).trim(),
    resetType: String(firstDefined(rawProfile, ['resetType', 'Reset Type'], 'Hardware reset')).trim() || 'Hardware reset',
    connection: String(firstDefined(rawProfile, ['connection', 'Connection'], 'Under reset')).trim() || 'Under reset',
    haltOnConnect: String(firstDefined(rawProfile, ['haltOnConnect', 'Halt on Connect'], 'Enabled')).trim() || 'Enabled',
    remotePassword: String(firstDefined(rawProfile, ['remotePassword', 'remote_password', 'password'], '')),
    selectedDevice: rawProfile.rawDevice && typeof rawProfile.rawDevice === 'object'
      ? { ...rawProfile.rawDevice }
      : { ...rawProfile }
  };
}

function responseStatusIsSuccess(status) {
  return status === 0 || status === '0';
}

function responseDescription(message) {
  const response = message?.response;
  if (typeof response === 'string') return response.trim();
  if (response === undefined || response === null) return '';
  if (typeof response?.statusMsg === 'string' && response.statusMsg.trim()) {
    return response.statusMsg.trim();
  }
  if (typeof response?.data === 'string' && response.data.trim()) {
    return response.data.trim();
  }
  try {
    return JSON.stringify(response);
  } catch {
    return String(response);
  }
}

function commandResponseFailed(message) {
  const status = message?.response?.status;
  return status !== undefined && status !== null && !responseStatusIsSuccess(status);
}

class CodegripControlClient {
  constructor(port, options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = Number(port);
    this.timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
    this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    this.onNotification = typeof options.onNotification === 'function' ? options.onNotification : () => {};
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
  }

  connect() {
    if (this.socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting to CODEGRIP control port ${this.host}:${this.port}.`));
      }, this.timeoutMs);
      const connectError = (error) => {
        clearTimeout(timer);
        this.socket = undefined;
        reject(new Error(`Cannot connect to CODEGRIP control port ${this.host}:${this.port}: ${error.message}`));
      };
      socket.once('error', connectError);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', connectError);
        resolve();
      });
      socket.on('data', (chunk) => this.consume(chunk));
      socket.on('error', (error) => this.failAll(error));
      socket.on('close', () => {
        if (this.pending.length) this.failAll(new Error('CODEGRIP closed the control connection.'));
        this.socket = undefined;
      });
    });
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!match) {
        this.failAll(new Error(`CODEGRIP returned an invalid control header: ${header}`));
        this.buffer = Buffer.alloc(0);
        return;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      let message;
      try {
        message = JSON.parse(body);
      } catch (error) {
        this.failAll(new Error(`CODEGRIP returned invalid JSON: ${error.message}`));
        continue;
      }
      if (message?.type === 'progress') {
        this.onProgress(message?.response?.progress, message?.response);
        continue;
      }
      if (message?.type !== 'cmdResponse') {
        this.onNotification(message);
        continue;
      }

      // NECTO's CODEGRIP protocol includes the command name in every
      // cmdResponse. Prefer matching by command, but fall back to FIFO for
      // older server builds that omit it.
      const responseCommand = String(message?.command || '');
      let requestIndex = responseCommand
        ? this.pending.findIndex((item) => item.command === responseCommand)
        : 0;
      if (requestIndex < 0) {
        this.onNotification(message);
        continue;
      }
      const [request] = this.pending.splice(requestIndex, 1);
      if (!request) continue;
      clearTimeout(request.timer);

      // scan/getAllOptions responses do not carry a status field at all.
      // Treat status as an error only when the server actually supplied it.
      if (commandResponseFailed(message)) {
        const status = message?.response?.status;
        const detail = responseDescription(message);
        request.reject(new Error(`CODEGRIP command '${request.command}' failed with status ${status}${detail ? `: ${detail}` : ''}.`));
        continue;
      }
      request.resolve(message?.response);
    }
  }

  failAll(error) {
    while (this.pending.length) {
      const request = this.pending.shift();
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  send(command, parameters = {}) {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error('CODEGRIP control client is not connected.'));
    }
    const body = Buffer.from(JSON.stringify({ command, parameters }), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((item) => item.timer === timer);
        if (index >= 0) this.pending.splice(index, 1);
        reject(new Error(`CODEGRIP command '${command}' timed out after ${this.timeoutMs} ms.`));
      }, this.timeoutMs);
      this.pending.push({ command, resolve, reject, timer });
      this.socket.write(Buffer.concat([header, body]), (error) => {
        if (!error) return;
        const index = this.pending.findIndex((item) => item.timer === timer);
        if (index >= 0) this.pending.splice(index, 1);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  close() {
    if (!this.socket) return;
    this.socket.end();
    this.socket.destroy();
    this.socket = undefined;
  }
}

function normalizeDiscoveredDevice(rawDevice) {
  if (!rawDevice || typeof rawDevice !== 'object' || Array.isArray(rawDevice)) return undefined;
  const source = rawDevice.rawDevice || rawDevice.selectedDevice || rawDevice.selected_device || rawDevice.device || rawDevice;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;

  const communicationType = String(firstDefined(source, ['communicationType', 'Communication Type'], '')).trim().toLowerCase();
  const serialNumber = String(firstDefined(source, ['serialNumber', 'Serial'], '')).trim();
  if (communicationType !== 'usb' || !serialNumber) return undefined;

  const normalized = {
    ...source,
    communicationType: 'usb',
    deviceName: String(firstDefined(source, ['deviceName', 'Name'], 'CODEGRIP')).trim() || 'CODEGRIP',
    serialNumber,
    ip: String(firstDefined(source, ['ip', 'Ip Address', 'IP Address'], '0.0.0.2')).trim() || '0.0.0.2',
    sslEnable: asBoolean(firstDefined(source, ['sslEnable', 'ssl'], false)),
    rawDevice: { ...source }
  };

  const hwTokens = firstDefined(source, ['hwTokens', 'Hardware tokens', 'Hardware Tokens'], undefined);
  if (hwTokens !== undefined && hwTokens !== null) normalized.hwTokens = hwTokens;
  return normalized;
}

function extractDiscoveredDevices(value) {
  const devices = [];
  const seenObjects = new Set();
  const seenDevices = new Set();
  const visit = (item, depth) => {
    if (depth > 8 || item === undefined || item === null) return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (typeof item !== 'object' || seenObjects.has(item)) return;
    seenObjects.add(item);
    const normalized = normalizeDiscoveredDevice(item);
    if (normalized) {
      const key = `${normalized.communicationType}\u0000${normalized.serialNumber}\u0000${normalized.ip || ''}`;
      if (!seenDevices.has(key)) {
        seenDevices.add(key);
        devices.push(normalized);
      }
    }
    for (const [key, child] of Object.entries(item)) {
      if (/device|result|response|data|usb/i.test(key)) visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return devices;
}

async function discoverUsbCodegrips(options) {
  const runtime = await startCodegripServer({ ...options, closeMode: 'always' });
  const control = new CodegripControlClient(runtime.controlPort, {
    timeoutMs: options.commandTimeoutMs || 30000,
    onProgress(progress, response) {
      if (progress !== undefined) options.channel?.appendLine(`CODEGRIP USB scan progress: ${progress}%`);
      if (response?.info) options.channel?.appendLine(`CODEGRIP: ${response.info}`);
    }
  });
  runtime.control = control;
  try {
    await control.connect();
    options.channel?.appendLine('CODEGRIP USB discovery: scan');
    const response = await control.send('scan', {
      communication_type: 'usb',
      addresses: []
    });
    const devices = extractDiscoveredDevices(response)
      .filter((device) => device.communicationType === 'usb');
    if (!devices.length) {
      throw new Error(
        'No USB CODEGRIP was returned by CodegripGdbServer. Connect CODEGRIP by USB, ' +
        'close any NECTO/CODEGRIP Suite session currently using it, and retry.'
      );
    }
    return { devices, command: 'scan' };
  } finally {
    await stopCodegripServer(runtime);
  }
}

function startCodegripServer(options) {
  const { executable, packsPath, mcu, channel } = options;
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (!fs.existsSync(executable)) throw new Error(`CodegripGdbServer was not found: ${executable}`);
  if (!fs.existsSync(packsPath) || !fs.statSync(packsPath).isDirectory()) {
    throw new Error(`CODEGRIP packs directory was not found: ${packsPath}`);
  }
  const args = ['--mcu', String(mcu), '--packs', packsPath];
  const closeMode = String(options.closeMode || 'always');
  if (closeMode === 'always') {
    args.push('--stop', 'gdb', '--stop', 'control');
  } else if (closeMode === 'debug') {
    args.push('--stop', 'gdb');
  } else if (closeMode === 'control') {
    args.push('--stop', 'control');
  }
  args.push('--port', '0', '--cport', '0', '--portCore2', '0');
  channel?.appendLine(`Resolved CODEGRIP server: ${executable}`);
  channel?.appendLine(`CODEGRIP packs: ${packsPath}`);
  channel?.appendLine(`Starting CODEGRIP for ${mcu} with dynamic control/debug ports.`);

  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(executable, args, {
      cwd: path.dirname(executable),
      shell: false,
      windowsHide: true,
      env: process.env
    });
    let controlPort;
    let debugPort;
    let debugSecondPort;
    let initializationFinished = false;
    let outputBuffer = '';
    let settled = false;
    let timer;
    let finishTimer;
    const finishIfReady = () => {
      if (settled || finishTimer || !initializationFinished || !controlPort || !debugPort) return;
      // The current server prints the second-core port immediately after the
      // primary debug port. Give the merged stream one short turn to consume
      // that line before publishing the runtime.
      finishTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel?.appendLine(`CODEGRIP control port: ${controlPort}`);
        channel?.appendLine(`CODEGRIP debug port: ${debugPort}`);
        if (debugSecondPort) channel?.appendLine(`CODEGRIP second debug port: ${debugSecondPort}`);
        resolve({ child, controlPort, debugPort, debugSecondPort });
      }, 25);
    };
    const consumeLine = (line) => {
      const trimmed = line.trim();
      if (trimmed) channel?.appendLine(`[CODEGRIP] ${trimmed}`);
      if (/Mikroe servers:\s*Initialization finished\./i.test(line)) initializationFinished = true;
      const controlMatch = line.match(/Control port:\s*(\d+)/i);
      const debugMatch = line.match(/Debug port:\s*(\d+)/i);
      const debugSecondMatch = line.match(/Debug second port:\s*(\d+)/i);
      if (controlMatch) controlPort = Number(controlMatch[1]);
      if (debugMatch) debugPort = Number(debugMatch[1]);
      if (debugSecondMatch) debugSecondPort = Number(debugSecondMatch[1]);
      finishIfReady();
    };
    const consume = (data) => {
      outputBuffer += data.toString();
      const lines = outputBuffer.split(/\r?\n/);
      outputBuffer = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    };
    child.stdout?.on('data', consume);
    // NECTO merges stdout/stderr before parsing server status. Do the same so
    // port publication is detected regardless of which stream the server uses.
    child.stderr?.on('data', consume);
    child.once('error', (error) => {
      if (settled) {
        channel?.appendLine(`[CODEGRIP] process error: ${error.message}`);
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(finishTimer);
      reject(error);
    });
    child.once('close', (code) => {
      if (outputBuffer) consumeLine(outputBuffer);
      channel?.appendLine(`[CODEGRIP] server exited with code ${code ?? -1}.`);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(finishTimer);
      reject(new Error(`CodegripGdbServer exited before publishing its ports (exit code ${code ?? -1}).`));
    });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(finishTimer);
      try { child.kill(); } catch { /* already stopped */ }
      reject(new Error(`CodegripGdbServer did not publish control/debug ports within ${timeoutMs} ms.`));
    }, timeoutMs);
  });
}

async function stopCodegripServer(runtime) {
  if (!runtime) return;
  runtime.control?.close();
  const child = runtime.child;
  if (!child || child.killed || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already stopped */ }
      resolve();
    }, 1500);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill('SIGTERM'); } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function nectoDefaultOptionValues(mcu) {
  const name = String(mcu || '');
  const values = new Map([
    ['Connection', 'Normal'],
    ['Erase Type', 'Sector erase'],
    ['Halt on Connect', 'Disabled'],
    ['Protocol', 'SWD'],
    ['Reset Type', 'Hardware reset'],
    ['Speed', '4 MHz'],
    ['Verify Type', 'CRC'],
    ['Verify after Write', 'Enabled']
  ]);

  if (/^PIC32.+$/.test(name)) values.set('Protocol', '2-wire EJTAG');
  if (/^(PIC32|MK|TM4C|GD32).+$/.test(name)) values.set('Erase Type', 'Mass erase');
  if (/^STM32.+$/.test(name)) values.set('Erase Type', 'Erase and unlock');
  if (/^(MK|STM32|GD32).+$/.test(name)) values.set('Connection', 'Under reset');
  if (/^(MK|TM4C|STM32|GD32).+$/.test(name)) values.set('Halt on Connect', 'Enabled');
  return values;
}

function flattenServerOptions(response) {
  const groups = Array.isArray(response) ? response : [];
  const result = [];
  for (const groupEntry of groups) {
    const group = String(groupEntry?.group || '');
    const options = Array.isArray(groupEntry?.options) ? groupEntry.options : [];
    for (const optionEntry of options) {
      const option = String(optionEntry?.option || '');
      if (!group || !option) continue;
      result.push({
        group,
        option,
        values: Array.isArray(optionEntry?.values) ? optionEntry.values.map(String) : []
      });
    }
  }
  return result;
}

function selectDeviceParameters(profile) {
  if (profile?.selectedDevice && typeof profile.selectedDevice === 'object') {
    return { ...profile.selectedDevice };
  }
  return {
    communicationType: profile.communicationType,
    serialNumber: profile.serialNumber,
    ip: profile.ip,
    hwTokens: profile.hwTokens,
    linkPortDebug: profile.linkPortDebug,
    linkPortConfig: profile.linkPortConfig,
    sslEnable: profile.sslEnable,
    linkPasswordDebug: profile.linkPasswordDebug,
    linkPasswordConfig: profile.linkPasswordConfig
  };
}

async function configureControlClient(control, profile, channel, mcu) {
  const run = async (command, parameters) => {
    channel?.appendLine(`CODEGRIP control: ${command}`);
    return control.send(command, parameters);
  };

  // NECTO obtains the option schema from the server and stores the selected
  // values with their real server group names. The extension has no separate
  // CODEGRIP target-options UI yet, so apply NECTO's defaults to every option
  // that the installed server actually advertises.
  const allOptions = await run('getAllOptions', {});
  const desired = nectoDefaultOptionValues(mcu);
  for (const serverOption of flattenServerOptions(allOptions)) {
    const value = desired.get(serverOption.option);
    if (!value) continue;
    if (serverOption.values.length && !serverOption.values.includes(value)) {
      channel?.appendLine(`CODEGRIP: skipping ${serverOption.option}=${value}; value is not advertised by this server/MCU.`);
      continue;
    }
    await run('setOptionValue', {
      group: serverOption.group,
      option: serverOption.option,
      value
    });
  }

  // Keep the same ordering used by Codegrip::setOptions() in NECTO.
  await run('selectDevice', selectDeviceParameters(profile));
  await run('authenticate', { linkPasswordDebug: profile.remotePassword || '' });
}

async function openConfiguredCodegrip(options) {
  const runtime = await startCodegripServer(options);
  const control = new CodegripControlClient(runtime.controlPort, {
    timeoutMs: options.commandTimeoutMs || 120000,
    onProgress(progress) {
      if (progress !== undefined) options.channel?.appendLine(`CODEGRIP progress: ${progress}%`);
    }
  });
  runtime.control = control;
  try {
    await control.connect();
    await configureControlClient(control, options.profile, options.channel, options.mcu);
    return runtime;
  } catch (error) {
    await stopCodegripServer(runtime);
    throw error;
  }
}

async function programCodegrip(options) {
  const runtime = await openConfiguredCodegrip({ ...options, closeMode: 'always' });
  try {
    const hex = fs.readFileSync(options.hexFile, 'utf8');
    options.channel?.appendLine(`CODEGRIP control: programming (${options.debugEnable ? 'debug enabled' : 'program only'})`);
    const response = await runtime.control.send('programming', {
      debugEnable: Boolean(options.debugEnable),
      hex
    });
    if (response?.status !== undefined && !responseStatusIsSuccess(response.status)) {
      throw new Error(`CODEGRIP programming failed with status ${response.status}${response.statusMsg ? `: ${response.statusMsg}` : ''}.`);
    }
  } finally {
    await stopCodegripServer(runtime);
  }
}

async function eraseCodegrip(options) {
  const runtime = await openConfiguredCodegrip({ ...options, closeMode: 'always' });
  try {
    const command = String(options.eraseCommand || 'erase').trim() || 'erase';
    options.channel?.appendLine(`CODEGRIP control: ${command} (erase)`);
    const response = await runtime.control.send(command, {});
    if (response?.status !== undefined && !responseStatusIsSuccess(response.status)) {
      throw new Error(`CODEGRIP erase failed with status ${response.status}${response.statusMsg ? `: ${response.statusMsg}` : ''}.`);
    }
  } finally {
    await stopCodegripServer(runtime);
  }
}

async function prepareCodegripDebug(options) {
  // Mirror NECTO's Codegrip::programJob(..., true) + beginDebugSession():
  //   1. program the image with debugEnable=true using a short-lived control server;
  //   2. start a fresh debug server with --stop gdb, configure the selected probe/MCU,
  //      then disconnect the control socket. The server remains alive only while GDB
  //      is connected and exits naturally when the debugger disconnects.
  await programCodegrip({ ...options, debugEnable: true });

  const runtime = await openConfiguredCodegrip({ ...options, closeMode: 'debug' });
  runtime.control.close();
  runtime.control = undefined;
  return runtime;
}

module.exports = {
  normalizeConnectionProfile,
  normalizeDiscoveredDevice,
  extractDiscoveredDevices,
  selectDeviceParameters,
  CodegripControlClient,
  startCodegripServer,
  stopCodegripServer,
  configureControlClient,
  programCodegrip,
  eraseCodegrip,
  prepareCodegripDebug,
  discoverUsbCodegrips,
  _test: {
    asBoolean,
    asPort,
    responseStatusIsSuccess,
    responseDescription,
    commandResponseFailed,
    nectoDefaultOptionValues,
    flattenServerOptions
  }
};
