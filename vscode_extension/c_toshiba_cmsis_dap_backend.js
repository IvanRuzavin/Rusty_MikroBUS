'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const TOSHIBA_CMSIS_DAP_PROGRAMMER_UID = 'toshiba_cmsis_dap';
const PY_OCD_VERSION = '0.45.1';
const ARM_PACK_INDEX_URL = 'https://www.keil.com/pack/index.pidx';
const TOSHIBA_PACK_CACHE_SCHEMA = 1;

function deviceIdentity(device = {}) {
  return [device.mcuName, device.uid, device.name, device.familyUid, device.family_uid].filter(Boolean).join(' ');
}

function isToshibaDevice(device = {}) {
  const vendor = String(device.vendor || '').trim();
  const identity = deviceIdentity(device);
  // Toshiba Arm Cortex-M MCUs use TMPM part numbers. Keep this C-only backend
  // generic across every Toshiba TMPM family in the database; the CMSIS DFP
  // resolver below is the final authority on whether a device is supported.
  return /toshiba/i.test(vendor) ? /\bTMPM[A-Z0-9]+/i.test(identity) : /^TMPM[A-Z0-9]+/i.test(identity);
}

function syntheticProgrammer() {
  return {
    uid: TOSHIBA_CMSIS_DAP_PROGRAMMER_UID,
    name: 'Toshiba CMSIS-DAP (on-board)',
    description: 'Automatic Toshiba TMPM CMSIS-DAP programming/debugging through pyOCD. The extension resolves, downloads, and permanently caches the exact Toshiba CMSIS Device Family Pack for the selected MCU.',
    installerPackage: '',
    deviceSupportPackage: ''
  };
}

function safeStat(filePath) {
  try { return fs.statSync(filePath); } catch { return undefined; }
}

function executableFromConfiguredPath(value) {
  const configured = String(value || '').trim();
  if (!configured) return undefined;
  const expanded = configured.replace(/^~(?=$|[\\/])/, os.homedir());
  const resolved = path.resolve(expanded);
  const stat = safeStat(resolved);
  if (stat?.isFile()) return resolved;
  if (stat?.isDirectory()) {
    for (const name of process.platform === 'win32' ? ['pyocd.exe', 'pyocd.cmd', 'pyocd'] : ['pyocd']) {
      const candidate = path.join(resolved, name);
      if (safeStat(candidate)?.isFile()) return candidate;
    }
  }
  return undefined;
}

function findOnPath(names) {
  const directories = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidates = process.platform === 'win32' && !path.extname(name) ? [`${name}.exe`, `${name}.cmd`, name] : [name];
      for (const candidateName of candidates) {
        const candidate = path.join(directory, candidateName);
        if (safeStat(candidate)?.isFile()) return candidate;
      }
    }
  }
  return undefined;
}

function managedPyocdRoot(managedRoot) {
  return path.join(managedRoot, 'tools', `pyocd-${PY_OCD_VERSION}`);
}

function managedPyocdExecutable(managedRoot) {
  const root = managedPyocdRoot(managedRoot);
  return process.platform === 'win32' ? path.join(root, 'Scripts', 'pyocd.exe') : path.join(root, 'bin', 'pyocd');
}

function managedPythonExecutable(managedRoot) {
  const root = managedPyocdRoot(managedRoot);
  return process.platform === 'win32' ? path.join(root, 'Scripts', 'python.exe') : path.join(root, 'bin', 'python');
}

function toshibaPackRoot(managedRoot) {
  return path.join(managedRoot, 'tools', 'toshiba-cmsis-packs');
}

function toshibaPackFilesRoot(managedRoot) {
  return path.join(toshibaPackRoot(managedRoot), 'packs');
}

function toshibaPdscRoot(managedRoot) {
  return path.join(toshibaPackRoot(managedRoot), 'pdsc');
}

function toshibaPackCachePath(managedRoot) {
  return path.join(toshibaPackRoot(managedRoot), 'cache.json');
}

function spawnCapture(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 30000,
    windowsHide: true
  });
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || ''), error: result.error };
}

function pythonVersion(candidate) {
  const result = spawnCapture(candidate.command, [...candidate.prefixArgs, '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], { timeout: 10000 });
  if (result.error || result.status !== 0) return undefined;
  const match = result.stdout.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return match.slice(1).map(Number);
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < Math.max(actual?.length || 0, minimum.length); index += 1) {
    const left = Number(actual?.[index] || 0);
    const right = Number(minimum[index] || 0);
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

function resolvePythonLauncher() {
  const configured = String(vscode.workspace.getConfiguration('mikrobusRust').get('cPythonPath', '') || '').trim();
  const candidates = [];
  if (configured) candidates.push({ command: path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir())), prefixArgs: [] });
  if (process.platform === 'win32') candidates.push({ command: 'py', prefixArgs: ['-3'] });
  candidates.push({ command: 'python3', prefixArgs: [] }, { command: 'python', prefixArgs: [] });
  for (const candidate of candidates) {
    const version = pythonVersion(candidate);
    if (version && versionAtLeast(version, [3, 9, 0])) return { ...candidate, version };
  }
  return undefined;
}

function resolvePyocdExecutable(managedRoot) {
  const configured = executableFromConfiguredPath(vscode.workspace.getConfiguration('mikrobusRust').get('cPyocdPath', ''));
  if (configured) return configured;
  const managed = managedPyocdExecutable(managedRoot);
  if (safeStat(managed)?.isFile()) return managed;
  return findOnPath(['pyocd']);
}

function runStreaming(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    options.channel?.appendLine?.(`\n> ${[command, ...args].map((value) => /\s/.test(String(value)) ? `"${String(value).replace(/"/g, '\\"')}"` : String(value)).join(' ')}`);
    const proc = childProcess.spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    proc.stdout?.on('data', (chunk) => { const text = chunk.toString(); output += text; options.channel?.append?.(text); });
    proc.stderr?.on('data', (chunk) => { const text = chunk.toString(); output += text; options.channel?.append?.(text); });
    proc.once('error', reject);
    proc.once('close', (code) => code === 0 ? resolve(output) : reject(new Error(`${path.basename(command)} exited with code ${code}.`)));
  });
}

async function ensurePyocd(context, managedRoot, options = {}) {
  const existing = resolvePyocdExecutable(managedRoot);
  if (existing) return existing;
  const python = resolvePythonLauncher();
  if (!python) {
    throw new Error('Toshiba CMSIS-DAP requires Python 3.9 or newer to install pyOCD. Install Python (including venv) or set mikrobusRust.cPythonPath / mikrobusRust.cPyocdPath.');
  }
  const root = managedPyocdRoot(managedRoot);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  options.progress?.report?.({ message: `Creating managed pyOCD ${PY_OCD_VERSION} environment...` });
  await runStreaming(python.command, [...python.prefixArgs, '-m', 'venv', root], { channel: options.channel });
  const venvPython = managedPythonExecutable(managedRoot);
  if (!safeStat(venvPython)?.isFile()) throw new Error(`Python could not create the managed pyOCD environment at ${root}. On Debian/Ubuntu install python3-venv.`);
  options.progress?.report?.({ message: `Installing pyOCD ${PY_OCD_VERSION}...` });
  await runStreaming(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', `pyocd==${PY_OCD_VERSION}`], { channel: options.channel });
  const executable = managedPyocdExecutable(managedRoot);
  if (!safeStat(executable)?.isFile()) throw new Error(`pyOCD ${PY_OCD_VERSION} was installed but ${executable} was not created.`);
  return executable;
}

function openResponse(url, redirectCount = 0, accept = 'application/octet-stream') {
  if (redirectCount > 10) return Promise.reject(new Error(`Too many redirects while downloading ${url}.`));
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'http:' ? http : https;
    const request = transport.get(parsed, {
      headers: { Accept: accept, 'User-Agent': 'mikrobus-embedded-vscode-extension' }
    }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        openResponse(new URL(response.headers.location, parsed).toString(), redirectCount + 1, accept).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => reject(new Error(`HTTP ${status} while downloading ${url}${chunks.length ? `: ${Buffer.concat(chunks).toString('utf8').slice(0, 240)}` : ''}`)));
        return;
      }
      resolve(response);
    });
    request.setTimeout(45000, () => request.destroy(new Error(`Connection timed out while downloading ${url}.`)));
    request.on('error', reject);
  });
}

async function fetchText(url) {
  const response = await openResponse(url, 0, 'application/xml,text/xml,text/plain,*/*;q=0.8');
  const chunks = [];
  await new Promise((resolve, reject) => {
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('error', reject);
    response.on('end', resolve);
  });
  return Buffer.concat(chunks).toString('utf8');
}

async function downloadFile(url, destination, options = {}) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  fs.rmSync(partial, { force: true });
  const response = await openResponse(url);
  const total = Number(response.headers['content-length'] || 0);
  let received = 0;
  const out = fs.createWriteStream(partial, { flags: 'wx' });
  try {
    await new Promise((resolve, reject) => {
      response.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0) options.progress?.report?.({ message: `Downloading Toshiba DFP ${Math.floor((received / total) * 100)}%` });
      });
      response.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      response.pipe(out);
    });
    fs.renameSync(partial, destination);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
}

function xmlAttributes(text) {
  const result = {};
  const regex = /([A-Za-z_][\w:.-]*)\s*=\s*["']([^"']*)["']/g;
  let match;
  while ((match = regex.exec(String(text || '')))) result[match[1]] = match[2];
  return result;
}

function parseToshibaPackIndex(xml) {
  const refs = [];
  const regex = /<pdsc\b([^>]*)\/?\s*>/gi;
  let match;
  while ((match = regex.exec(String(xml || '')))) {
    const attrs = xmlAttributes(match[1]);
    if (!/^toshiba$/i.test(String(attrs.vendor || ''))) continue;
    if (!attrs.name || !attrs.url) continue;
    // Programmer target support comes from Device Family Packs, not software/
    // Bluetooth-only packs.
    if (!/_DFP$/i.test(attrs.name)) continue;
    refs.push({ vendor: attrs.vendor, name: attrs.name, url: attrs.url, indexVersion: attrs.version || '' });
  }
  return refs;
}

function ensureTrailingSlash(url) {
  return String(url || '').endsWith('/') ? String(url) : `${String(url || '')}/`;
}

function pdscUrlForRef(ref) {
  return new URL(`${ref.vendor}.${ref.name}.pdsc`, ensureTrailingSlash(ref.url)).toString();
}

function packUrlFor(ref, version, pdscText = '') {
  const declaredUrl = String(pdscText || '').match(/<url>\s*([^<]+?)\s*<\/url>/i)?.[1]?.trim();
  const base = declaredUrl || ref.url;
  return new URL(`${ref.vendor}.${ref.name}.${version}.pack`, ensureTrailingSlash(base)).toString();
}

function pdscContainsTarget(pdscText, target) {
  const wanted = String(target || '').trim();
  if (!wanted) return false;
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b(?:Dname|Dvariant)\\s*=\\s*["']${escaped}["']`, 'i').test(String(pdscText || ''));
}

function versionTokens(value) {
  return String(value || '').split(/[._+-]/).map((token) => /^\d+$/.test(token) ? Number(token) : token.toLowerCase());
}

function compareVersions(left, right) {
  const a = versionTokens(left);
  const b = versionTokens(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av === bv) continue;
    if (typeof av === 'number' && typeof bv === 'number') return av - bv;
    return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
  }
  return 0;
}

function latestPdscReleaseVersion(pdscText, fallback = '') {
  const versions = [];
  const regex = /<release\b([^>]*)>/gi;
  let match;
  while ((match = regex.exec(String(pdscText || '')))) {
    const version = xmlAttributes(match[1]).version;
    if (version) versions.push(version);
  }
  if (!versions.length) return String(fallback || '').trim();
  versions.sort(compareVersions);
  return versions[versions.length - 1];
}

function readPackCache(managedRoot) {
  const filePath = toshibaPackCachePath(managedRoot);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed?.schema === TOSHIBA_PACK_CACHE_SCHEMA && parsed.targets && typeof parsed.targets === 'object') return parsed;
  } catch {}
  return { schema: TOSHIBA_PACK_CACHE_SCHEMA, targets: {} };
}

function writePackCache(managedRoot, cache) {
  const filePath = toshibaPackCachePath(managedRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(cache, null, 2)}\n`);
}

function cachedPackForTarget(managedRoot, target) {
  const key = String(target || '').trim().toUpperCase();
  if (!key) return undefined;
  const entry = readPackCache(managedRoot).targets[key];
  if (!entry?.path) return undefined;
  const resolved = path.resolve(entry.path);
  return safeStat(resolved)?.isFile() ? { ...entry, path: resolved } : undefined;
}

function listCachedPacks(managedRoot) {
  const cache = readPackCache(managedRoot);
  return Object.entries(cache.targets).map(([target, entry]) => ({ target, ...entry })).filter((entry) => entry.path && safeStat(entry.path)?.isFile());
}

async function loadPdsc(ref, managedRoot, options = {}) {
  fs.mkdirSync(toshibaPdscRoot(managedRoot), { recursive: true });
  const local = path.join(toshibaPdscRoot(managedRoot), `${ref.vendor}.${ref.name}.pdsc`);
  // Descriptor files are small. Refresh on resolution so newly published pack
  // versions are detected, while falling back to the cached descriptor if the
  // vendor site is temporarily unavailable.
  try {
    const text = await fetchText(pdscUrlForRef(ref));
    fs.writeFileSync(local, text);
    return text;
  } catch (error) {
    if (safeStat(local)?.isFile()) {
      options.channel?.appendLine?.(`Toshiba PDSC refresh failed for ${ref.name}; using cached descriptor: ${error.message || error}`);
      return fs.readFileSync(local, 'utf8');
    }
    throw error;
  }
}

async function resolveToshibaPack(target, managedRoot, options = {}) {
  const cached = cachedPackForTarget(managedRoot, target);
  if (cached && !options.forceRefresh) return cached;

  options.progress?.report?.({ message: `Resolving Toshiba CMSIS pack for ${target}...` });
  options.channel?.appendLine?.(`Resolving Toshiba CMSIS Device Family Pack for ${target} from the Arm Pack Index...`);
  const indexXml = await fetchText(ARM_PACK_INDEX_URL);
  const refs = parseToshibaPackIndex(indexXml);
  if (!refs.length) throw new Error('The Arm CMSIS Pack Index did not contain any Toshiba Device Family Pack entries.');

  const failures = [];
  for (const ref of refs) {
    let pdsc;
    try { pdsc = await loadPdsc(ref, managedRoot, options); }
    catch (error) { failures.push(`${ref.name}: ${error.message || error}`); continue; }
    if (!pdscContainsTarget(pdsc, target)) continue;

    const version = latestPdscReleaseVersion(pdsc, ref.indexVersion);
    if (!version) throw new Error(`Toshiba pack ${ref.name} contains ${target}, but no pack version could be determined.`);
    const url = packUrlFor(ref, version, pdsc);
    const fileName = `${ref.vendor}.${ref.name}.${version}.pack`;
    const destination = path.join(toshibaPackFilesRoot(managedRoot), fileName);
    if (!safeStat(destination)?.isFile()) {
      options.progress?.report?.({ message: `Downloading ${fileName}...` });
      options.channel?.appendLine?.(`Downloading Toshiba DFP: ${url}`);
      await downloadFile(url, destination, options);
    } else {
      options.channel?.appendLine?.(`Using cached Toshiba DFP: ${destination}`);
    }

    const cache = readPackCache(managedRoot);
    cache.targets[String(target).trim().toUpperCase()] = {
      vendor: ref.vendor,
      packName: ref.name,
      version,
      path: destination,
      url,
      resolvedAt: new Date().toISOString()
    };
    writePackCache(managedRoot, cache);
    return { ...cache.targets[String(target).trim().toUpperCase()] };
  }

  throw new Error(
    `No Toshiba CMSIS Device Family Pack in the current Arm Pack Index contains MCU '${target}'. ` +
    `Checked ${refs.length} Toshiba DFP descriptors.${failures.length ? ` Some descriptors could not be read: ${failures.slice(0, 3).join('; ')}` : ''}`
  );
}

function sanitizeProbeText(value) {
  return String(value || '').replace(/\x00/g, '').trim();
}

function sanitizeProbeUid(value) {
  return sanitizeProbeText(value).replace(/^cmsisdap:/i, '');
}

function parseProbeList(output) {
  const probes = [];
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = sanitizeProbeText(rawLine);
    if (!/^\d+\s+/.test(line)) continue;
    const columns = line.split(/\s{2,}/).map(sanitizeProbeText).filter(Boolean);
    if (columns.length < 3 || !/^\d+$/.test(columns[0])) continue;
    probes.push({ index: Number(columns[0]), name: columns[1] || '', uniqueId: sanitizeProbeUid(columns[2] || ''), target: columns.slice(3).join('  ') });
  }
  return probes;
}

function cmsisDapProbesFromList(output) {
  return parseProbeList(output).filter((probe) => /CMSIS[- ]DAP/i.test(probe.name));
}

function toshibaTmpmProbesFromList(output) {
  return cmsisDapProbesFromList(output).filter((probe) => /(?:TOSHIBA|TMPM)/i.test(probe.name));
}

function scanProbes(pyocd, options = {}) {
  const result = spawnCapture(pyocd, ['list', '--probes'], { timeout: options.timeout || 15000, env: options.env });
  if (result.error) throw new Error(`Unable to enumerate debug probes with pyOCD: ${result.error.message || result.error}`);
  return { ...result, probes: parseProbeList(result.stdout), cmsisDapProbes: cmsisDapProbesFromList(result.stdout), toshibaTmpmProbes: toshibaTmpmProbesFromList(result.stdout) };
}

function detectToshibaProbe(pyocd, options = {}) {
  const result = scanProbes(pyocd, options);
  if (result.toshibaTmpmProbes.length === 1) {
    const probe = result.toshibaTmpmProbes[0];
    options.channel?.appendLine?.(`Toshiba TMPM CMSIS-DAP detected: ${probe.name} [${probe.uniqueId || 'no serial'}]`);
    return probe;
  }
  if (result.toshibaTmpmProbes.length > 1) {
    throw new Error(`More than one Toshiba TMPM CMSIS-DAP probe is connected (${result.toshibaTmpmProbes.map((p) => `${p.name} [${p.uniqueId}]`).join(', ')}). Disconnect the extra Toshiba debugger and retry.`);
  }
  const detail = [result.stdout, result.stderr].map((value) => sanitizeProbeText(value)).filter(Boolean).join('\n');
  throw new Error(
    'No Toshiba TMPM CMSIS-DAP probe is accessible. Connect the board PWR/DBG port and make sure USB permissions allow normal-user access.' +
    (process.platform === 'linux' ? ' On Linux, install the 0930:6504 (or board-specific) udev rule and reconnect the board.' : '') +
    (detail ? `\npyOCD probe scan output:\n${detail}` : '')
  );
}

async function prepareRuntime(context, setup, options = {}) {
  if (!isToshibaDevice(setup?.metadata?.device || {})) throw new Error('The selected setup is not a Toshiba TMPM Cortex-M target.');
  const managedRoot = options.managedRoot;
  if (!managedRoot) throw new Error('The managed C package root is required to prepare Toshiba CMSIS-DAP support.');
  const pyocd = await ensurePyocd(context, managedRoot, options);
  const target = String(setup?.metadata?.device?.mcuName || setup?.metadata?.sdkConfig?.MCU_NAME || setup?.metadata?.device?.uid || '').trim();
  if (!target) throw new Error('The Toshiba setup does not contain an MCU target name.');

  // Do not pre-scan/open the CMSIS-DAP probe here. The older TMPM067 on-board
  // debugger can enumerate successfully and then leave its HID/USB interface
  // temporarily unavailable to the immediately following pyOCD process.
  // Program/Erase/Debug therefore use a single pyOCD process and let pyOCD
  // discover/open the connected probe itself. The exact Toshiba DFP is still
  // resolved and supplied explicitly with --pack.
  const pack = await resolveToshibaPack(target, managedRoot, options);
  return { pyocd, cmsisPack: pack.path, pack, target, probeArgs: [] };
}

function commandArgs(runtime, subcommand, extra = []) {
  return [subcommand, '--target', runtime.target, '--pack', runtime.cmsisPack, '--no-wait', ...extra];
}

async function program(runtime, image, options = {}) {
  options.onStatus?.('Connecting to Toshiba TMPM CMSIS-DAP...');
  await runStreaming(runtime.pyocd, commandArgs(runtime, 'load', ['--format', 'elf', image]), options);
  options.onStatus?.('Programming complete.');
}

async function erase(runtime, options = {}) {
  options.onStatus?.('Erasing Toshiba target...');
  await runStreaming(runtime.pyocd, commandArgs(runtime, 'erase', ['--chip']), options);
  options.onStatus?.('Erase complete.');
}

function freeTcpPort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function stopProcessTree(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    proc.once('close', done);
    try {
      if (process.platform === 'win32') {
        childProcess.spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          .once('close', done);
      } else {
        proc.kill('SIGINT');
      }
    } catch {
      done();
      return;
    }
    setTimeout(() => {
      if (finished || proc.exitCode !== null) return done();
      try { proc.kill(process.platform === 'win32' ? undefined : 'SIGTERM'); } catch {}
      setTimeout(() => {
        if (finished || proc.exitCode !== null) return done();
        try { proc.kill(process.platform === 'win32' ? undefined : 'SIGKILL'); } catch {}
        done();
      }, 800).unref?.();
    }, 800).unref?.();
  });
}

async function startGdbServer(runtime, options = {}) {
  const host = '127.0.0.1';
  const gdbPort = await freeTcpPort(host);
  let telnetPort = await freeTcpPort(host);
  while (telnetPort === gdbPort) telnetPort = await freeTcpPort(host);
  const args = [
    'gdbserver',
    '--port', String(gdbPort),
    '--telnet-port', String(telnetPort),
    '--target', runtime.target,
    '--pack', runtime.cmsisPack,
    '--no-wait',
    '--persist'
  ];
  options.channel?.appendLine?.(`\n> ${[runtime.pyocd, ...args].map((value) => /\s/.test(String(value)) ? `"${String(value).replace(/"/g, '\\"')}"` : String(value)).join(' ')}`);

  const proc = childProcess.spawn(runtime.pyocd, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let settled = false;
  const readyPattern = new RegExp(`GDB server listening on port\\s+${gdbPort}\\b`, 'i');

  const waitReady = new Promise((resolve, reject) => {
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const onData = (chunk) => {
      const text = chunk.toString();
      output += text;
      options.channel?.append?.(text);
      if (readyPattern.test(output)) finish();
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.once('error', (error) => finish(error));
    proc.once('close', (code) => {
      if (!settled) finish(new Error(`pyOCD GDB server exited before becoming ready (code ${code}).${output ? `\n${output.trim()}` : ''}`));
    });
    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for pyOCD GDB server to listen on ${host}:${gdbPort}.${output ? `\n${output.trim()}` : ''}`));
    }, options.timeout || 15000);
  });

  try {
    await waitReady;
  } catch (error) {
    await stopProcessTree(proc);
    throw error;
  }

  options.channel?.appendLine?.(`Toshiba pyOCD GDB server ready on ${host}:${gdbPort}.`);
  return { ...runtime, process: proc, host, gdbPort, telnetPort };
}

async function stopGdbServer(runtime) {
  await stopProcessTree(runtime?.process);
}

function debugConfiguration(setup, projectRoot, elf, runtime, generation) {
  if (!runtime?.gdbPort) throw new Error('The Toshiba pyOCD GDB server is not running.');
  return {
    type: 'cortex-debug', request: 'launch', name: `MikroBUS C Toshiba CMSIS-DAP: ${setup.name}`,
    cwd: projectRoot, executable: elf, servertype: 'external',
    gdbTarget: `${runtime.host || '127.0.0.1'}:${runtime.gdbPort}`,
    gdbPath: setup.tools?.gdb, runToEntryPoint: 'main',
    // For an external server Cortex-Debug otherwise falls back to generic
    // OpenOCD-style launch commands. Make the pyOCD sequence explicit: load
    // the current ELF, reset+halt, then let runToEntryPoint continue to main.
    overrideLaunchCommands: ['monitor reset halt', 'load', 'monitor reset halt'],
    overrideResetCommands: ['monitor reset halt'],
    __mikrobusToshibaCmsisDap: true, __mikrobusCDebugInstance: generation, __mikrobusCDebug: true
  };
}

module.exports = {
  TOSHIBA_CMSIS_DAP_PROGRAMMER_UID,
  PY_OCD_VERSION,
  ARM_PACK_INDEX_URL,
  isToshibaDevice,
  syntheticProgrammer,
  resolvePyocdExecutable,
  ensurePyocd,
  resolveToshibaPack,
  listCachedPacks,
  scanProbes,
  prepareRuntime,
  program,
  erase,
  startGdbServer,
  stopGdbServer,
  debugConfiguration,
  _test: {
    deviceIdentity,
    versionAtLeast,
    managedPyocdRoot,
    managedPyocdExecutable,
    toshibaPackRoot,
    toshibaPackCachePath,
    xmlAttributes,
    parseToshibaPackIndex,
    pdscUrlForRef,
    packUrlFor,
    pdscContainsTarget,
    latestPdscReleaseVersion,
    compareVersions,
    sanitizeProbeText,
    sanitizeProbeUid,
    parseProbeList,
    cmsisDapProbesFromList,
    toshibaTmpmProbesFromList,
    commandArgs,
    freeTcpPort,
    readPackCache,
    cachedPackForTarget,
    listCachedPacks
  }
};
