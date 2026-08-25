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
    haltOnConnect: String(firstDefined(rawProfile, ['haltOnConnect', 'Halt on Connect'], 'Enabled')).trim() || 'Enabled'
  };
}

function selectDeviceParameters(profile) {
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

function responseStatusIsSuccess(status) {
  return status === 0 || status === '0';
}

function responseDescription(response) {
  const data = response?.response?.data;
  if (typeof data === 'string') return data.trim();
  if (data === undefined || data === null) return '';
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
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
      const request = this.pending.shift();
      if (!request) continue;
      clearTimeout(request.timer);
      const status = message?.response?.status;
      if (!responseStatusIsSuccess(status)) {
        const detail = responseDescription(message);
        request.reject(new Error(`CODEGRIP command '${request.command}' failed with status ${status ?? 'unknown'}${detail ? `: ${detail}` : ''}.`));
        continue;
      }
      request.resolve(message?.response?.data);
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
  const source = rawDevice.selectedDevice || rawDevice.selected_device || rawDevice.device || rawDevice;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const communicationType = String(firstDefined(source, ['communicationType', 'Communication Type'], '')).trim().toLowerCase();
  const serialNumber = String(firstDefined(source, ['serialNumber', 'Serial'], '')).trim();
  const hwTokens = String(firstDefined(source, ['hwTokens', 'Hardware tokens', 'Hardware Tokens'], '')).trim();
  if (communicationType !== 'usb' || !serialNumber || !hwTokens) return undefined;
  return {
    communicationType: 'usb',
    deviceName: String(firstDefined(source, ['deviceName', 'Name'], 'CODEGRIP')).trim() || 'CODEGRIP',
    serialNumber,
    hwTokens,
    ip: String(firstDefined(source, ['ip', 'Ip Address', 'IP Address'], '0.0.0.2')).trim() || '0.0.0.2',
    linkPortDebug: asPort(firstDefined(source, ['linkPortDebug', 'debugPort'], 0)),
    linkPortConfig: asPort(firstDefined(source, ['linkPortConfig', 'configPort'], 0)),
    sslEnable: asBoolean(firstDefined(source, ['sslEnable', 'ssl'], false)),
    linkPasswordDebug: '',
    linkPasswordConfig: ''
  };
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
      const key = `${normalized.serialNumber}\u0000${normalized.hwTokens}`;
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
  const runtime = await startCodegripServer(options);
  const notifications = [];
  const control = new CodegripControlClient(runtime.controlPort, {
    timeoutMs: options.commandTimeoutMs || 30000,
    onProgress(progress, response) {
      if (progress !== undefined) options.channel?.appendLine(`CODEGRIP USB scan progress: ${progress}%`);
      if (response) notifications.push(response);
    },
    onNotification(message) {
      notifications.push(message);
    }
  });
  runtime.control = control;
  const attempts = [];
  const commands = [
    ['scanDevices', { communicationType: 'usb' }],
    ['getDevices', { communicationType: 'usb' }],
    ['getConnectedDevices', { communicationType: 'usb' }],
    ['getAvailableDevices', { communicationType: 'usb' }],
    ['getDeviceList', { communicationType: 'usb' }],
    ['discoverDevices', { communicationType: 'usb' }],
    ['listDevices', { communicationType: 'usb' }],
    ['scanUsbDevices', {}],
    ['selectDevice', { communicationType: 'usb' }]
  ];
  try {
    await control.connect();
    for (const [command, parameters] of commands) {
      options.channel?.appendLine(`CODEGRIP USB discovery: ${command}`);
      try {
        const result = await control.send(command, parameters);
        let devices = extractDiscoveredDevices([result, notifications]);
        if (devices.length) return { devices, command };
        if (/scan|discover/i.test(command)) {
          await new Promise((resolve) => setTimeout(resolve, 600));
          devices = extractDiscoveredDevices(notifications);
          if (devices.length) return { devices, command };
        }
        attempts.push(`${command}: no USB devices returned`);
      } catch (error) {
        const detail = String(error.message || error).replace(/\s+/g, ' ').slice(0, 220);
        attempts.push(`${command}: ${detail}`);
        if (/timed out/i.test(detail)) break;
      }
    }
    throw new Error(
      'No USB CODEGRIP was returned by the installed CodegripGdbServer discovery API. ' +
      'Connect CODEGRIP by USB, close NECTO/CODEGRIP Suite sessions using it, and retry. ' +
      `Discovery attempts: ${attempts.join(' | ')}`
    );
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
  const args = ['--mcu', String(mcu), '--port', '0', '--cport', '0', '--packs', packsPath];
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
    let outputBuffer = '';
    let settled = false;
    let timer;
    const finishIfReady = () => {
      if (settled || !controlPort || !debugPort) return;
      settled = true;
      clearTimeout(timer);
      channel?.appendLine(`CODEGRIP control port: ${controlPort}`);
      channel?.appendLine(`CODEGRIP debug port: ${debugPort}`);
      resolve({ child, controlPort, debugPort });
    };
    const consumeLine = (line) => {
      const trimmed = line.trim();
      if (trimmed) channel?.appendLine(`[CODEGRIP] ${trimmed}`);
      const controlMatch = line.match(/Control port:\s*(\d+)/i);
      const debugMatch = line.match(/Debug port:\s*(\d+)/i);
      if (controlMatch) controlPort = Number(controlMatch[1]);
      if (debugMatch) debugPort = Number(debugMatch[1]);
      finishIfReady();
    };
    const consume = (data) => {
      outputBuffer += data.toString();
      const lines = outputBuffer.split(/\r?\n/);
      outputBuffer = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', (data) => channel?.append(`[CODEGRIP stderr] ${data.toString()}`));
    child.once('error', (error) => {
      if (settled) {
        channel?.appendLine(`[CODEGRIP] process error: ${error.message}`);
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      if (outputBuffer) consumeLine(outputBuffer);
      channel?.appendLine(`[CODEGRIP] server exited with code ${code ?? -1}.`);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`CodegripGdbServer exited before publishing its ports (exit code ${code ?? -1}).`));
    });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
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

async function configureControlClient(control, profile, channel) {
  const run = async (command, parameters) => {
    channel?.appendLine(`CODEGRIP control: ${command}`);
    return control.send(command, parameters);
  };
  await run('selectDevice', selectDeviceParameters(profile));
  if (profile.linkPasswordConfig) {
    await run('authenticate', { linkPasswordConfig: profile.linkPasswordConfig });
  }
  const options = [
    ['Protocol', profile.protocol],
    ['Speed', profile.speed],
    ['Reset Type', profile.resetType],
    ['Connection', profile.connection],
    ['Halt on Connect', profile.haltOnConnect]
  ];
  for (const [option, value] of options) {
    if (!value) continue;
    await run('setOptionValue', { group: 'Target Connection', option, value });
  }
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
    await configureControlClient(control, options.profile, options.channel);
    return runtime;
  } catch (error) {
    await stopCodegripServer(runtime);
    throw error;
  }
}

async function programCodegrip(options) {
  const runtime = await openConfiguredCodegrip(options);
  try {
    const hex = fs.readFileSync(options.hexFile, 'utf8');
    options.channel?.appendLine(`CODEGRIP control: programming (${options.debugEnable ? 'debug enabled' : 'program only'})`);
    await runtime.control.send('programming', {
      debugEnable: Boolean(options.debugEnable),
      fileType: 'hex',
      hex
    });
  } finally {
    await stopCodegripServer(runtime);
  }
}

async function eraseCodegrip(options) {
  const runtime = await openConfiguredCodegrip(options);
  try {
    const command = String(options.eraseCommand || 'erase').trim() || 'erase';
    options.channel?.appendLine(`CODEGRIP control: ${command} (erase)`);
    await runtime.control.send(command, {});
  } finally {
    await stopCodegripServer(runtime);
  }
}

async function prepareCodegripDebug(options) {
  const runtime = await openConfiguredCodegrip(options);
  try {
    const hex = fs.readFileSync(options.hexFile, 'utf8');
    options.channel?.appendLine('CODEGRIP control: programming (debug enabled)');
    await runtime.control.send('programming', {
      debugEnable: true,
      fileType: 'hex',
      hex
    });
    runtime.control.close();
    runtime.control = undefined;
    return runtime;
  } catch (error) {
    await stopCodegripServer(runtime);
    throw error;
  }
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
    responseDescription
  }
};
