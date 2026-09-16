'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const TOSHIBA_CMSIS_DAP_PROGRAMMER_UID = 'toshiba_cmsis_dap';
const PY_OCD_VERSION = '0.45.1';

function deviceIdentity(device = {}) {
  return [
    device.mcuName,
    device.uid,
    device.name,
    device.familyUid,
    device.family_uid
  ].filter(Boolean).join(' ');
}

function isToshibaDevice(device = {}) {
  const vendor = String(device.vendor || '').trim();
  const identity = deviceIdentity(device);
  if (!/toshiba/i.test(vendor) && !/^TMPM/i.test(identity)) return false;
  // Keep the synthetic programmer scoped to the Toshiba families explicitly
  // supported by the current on-board CMSIS-DAP flow. Do not expose it for
  // unrelated Toshiba devices just because they also happen to be Cortex-M.
  return /\bTMPM(?:3H|4K|4L)[A-Z0-9]*/i.test(identity);
}

function syntheticProgrammer() {
  return {
    uid: TOSHIBA_CMSIS_DAP_PROGRAMMER_UID,
    name: 'Toshiba CMSIS-DAP (on-board)',
    description: 'CMSIS-DAP programming/debugging through pyOCD using the Toshiba CMSIS Device Family Pack shipped in the selected C Core package.',
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
  const expanded = configured.replace(/^~(?=$|[\\/])/, require('os').homedir());
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
      const candidates = process.platform === 'win32' && !path.extname(name)
        ? [`${name}.exe`, `${name}.cmd`, name]
        : [name];
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
  return process.platform === 'win32'
    ? path.join(root, 'Scripts', 'pyocd.exe')
    : path.join(root, 'bin', 'pyocd');
}

function managedPythonExecutable(managedRoot) {
  const root = managedPyocdRoot(managedRoot);
  return process.platform === 'win32'
    ? path.join(root, 'Scripts', 'python.exe')
    : path.join(root, 'bin', 'python');
}

function spawnCapture(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 30000,
    windowsHide: true
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error
  };
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
  if (configured) candidates.push({ command: path.resolve(configured.replace(/^~(?=$|[\\/])/, require('os').homedir())), prefixArgs: [] });
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
    proc.once('error', (error) => reject(error));
    proc.once('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${path.basename(command)} exited with code ${code}.`));
    });
  });
}

async function ensurePyocd(context, managedRoot, options = {}) {
  const existing = resolvePyocdExecutable(managedRoot);
  if (existing) return existing;
  const python = resolvePythonLauncher();
  if (!python) {
    throw new Error(
      'Toshiba CMSIS-DAP requires Python 3.9 or newer to install pyOCD. ' +
      'Install Python (including the venv module) or set mikrobusRust.cPythonPath / mikrobusRust.cPyocdPath.'
    );
  }
  const root = managedPyocdRoot(managedRoot);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  options.progress?.report?.({ message: `Creating managed pyOCD ${PY_OCD_VERSION} environment...` });
  const venv = await runStreaming(python.command, [...python.prefixArgs, '-m', 'venv', root], { channel: options.channel });
  void venv;
  const venvPython = managedPythonExecutable(managedRoot);
  if (!safeStat(venvPython)?.isFile()) {
    throw new Error(
      `Python could not create the managed pyOCD environment at ${root}. ` +
      'On Debian/Ubuntu install python3-venv, then rebuild the Toshiba C setup.'
    );
  }
  options.progress?.report?.({ message: `Installing pyOCD ${PY_OCD_VERSION}...` });
  await runStreaming(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', `pyocd==${PY_OCD_VERSION}`], { channel: options.channel });
  const executable = managedPyocdExecutable(managedRoot);
  if (!safeStat(executable)?.isFile()) throw new Error(`pyOCD ${PY_OCD_VERSION} was installed but ${executable} was not created.`);
  return executable;
}

function mcuFamilyToken(mcuName) {
  const match = String(mcuName || '').toUpperCase().match(/TMPM(?:3H|4K|4L|[34][A-Z0-9])/);
  return match ? match[0] : String(mcuName || '').toUpperCase().slice(0, 6);
}

function collectFiles(root, predicate, maximumDepth = 8) {
  if (!root || !safeStat(root)?.isDirectory()) return [];
  const result = [];
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(current.directory, entry.name);
      if (entry.isFile() && predicate(candidate, entry.name)) result.push(candidate);
      if (entry.isDirectory() && current.depth < maximumDepth && !['.git', 'build', 'target', 'node_modules'].includes(entry.name)) {
        queue.push({ directory: candidate, depth: current.depth + 1 });
      }
    }
  }
  return result;
}

function scorePackCandidate(candidate, mcuName, isExpanded) {
  const token = mcuFamilyToken(mcuName);
  const normalized = candidate.toUpperCase();
  let score = 0;
  if (token && normalized.includes(token)) score += 100;
  if (/TOSHIBA/.test(normalized)) score += 20;
  if (!isExpanded && /\.PACK$/i.test(candidate)) score += 5;
  if (isExpanded) {
    try {
      const pdscs = collectFiles(candidate, (_file, name) => /\.pdsc$/i.test(name), 1);
      for (const pdsc of pdscs) {
        const text = fs.readFileSync(pdsc, 'utf8').toUpperCase();
        if (String(mcuName || '').toUpperCase() && text.includes(String(mcuName).toUpperCase())) score += 1000;
        else if (token && text.includes(token)) score += 300;
      }
    } catch {}
  }
  return score;
}

function resolveCmsisPackPath(setup, options = {}) {
  const configured = String(vscode.workspace.getConfiguration('mikrobusRust').get('cToshibaCmsisPackPath', '') || '').trim();
  if (configured) {
    const resolved = path.resolve(configured.replace(/^~(?=$|[\\/])/, require('os').homedir()));
    if (safeStat(resolved)?.isFile() || safeStat(resolved)?.isDirectory()) return resolved;
    throw new Error(`mikrobusRust.cToshibaCmsisPackPath does not exist: ${resolved}`);
  }

  const previouslyResolved = setup?.paths?.toshibaCmsisPack;
  if (previouslyResolved && (safeStat(previouslyResolved)?.isFile() || safeStat(previouslyResolved)?.isDirectory())) {
    return path.resolve(previouslyResolved);
  }

  const mcuName = String(options.mcuName || setup?.metadata?.device?.mcuName || setup?.metadata?.sdkConfig?.MCU_NAME || '').trim();
  const roots = [
    options.coreRoot,
    setup?.paths?.corePackageRoot,
    options.coreSource,
    setup?.paths?.coreSource
  ].filter(Boolean).map((item) => path.resolve(item));
  const uniqueRoots = [...new Set(roots)];

  const packed = [];
  const expanded = [];
  for (const root of uniqueRoots) {
    if (!safeStat(root)?.isDirectory()) continue;
    packed.push(...collectFiles(root, (_file, name) => /\.pack$/i.test(name), 8));
    for (const pdsc of collectFiles(root, (_file, name) => /\.pdsc$/i.test(name), 8)) expanded.push(path.dirname(pdsc));
  }
  const uniquePacked = [...new Set(packed)];
  const uniqueExpanded = [...new Set(expanded)];
  const candidates = [
    ...uniquePacked.map((candidate) => ({ candidate, isExpanded: false })),
    ...uniqueExpanded.map((candidate) => ({ candidate, isExpanded: true }))
  ].sort((left, right) => scorePackCandidate(right.candidate, mcuName, right.isExpanded) - scorePackCandidate(left.candidate, mcuName, left.isExpanded));
  return candidates[0]?.candidate;
}

function probeArgs() {
  const configuredUid = String(vscode.workspace.getConfiguration('mikrobusRust').get('cToshibaCmsisDapUid', '') || '').trim();
  const selector = configuredUid
    ? (/^[A-Za-z0-9_.+-]+:/.test(configuredUid) ? configuredUid : `cmsisdap:${configuredUid}`)
    : 'cmsisdap:';
  // pyOCD accepts a probe plugin prefix as part of the UID selector. Using
  // cmsisdap: guarantees this C backend cannot silently attach to a J-Link or
  // ST-Link when several probe types are connected.
  return ['--uid', selector];
}

async function prepareRuntime(context, setup, options = {}) {
  if (!isToshibaDevice(setup?.metadata?.device || {})) throw new Error('The selected setup is not a supported Toshiba TMPM3H/TMPM4K/TMPM4L Cortex-M target.');
  const managedRoot = options.managedRoot;
  if (!managedRoot) throw new Error('The managed C package root is required to prepare Toshiba CMSIS-DAP support.');
  const pyocd = await ensurePyocd(context, managedRoot, options);
  const cmsisPack = resolveCmsisPackPath(setup, options);
  if (!cmsisPack) {
    throw new Error(
      `No Toshiba CMSIS Device Family Pack (.pack or expanded .pdsc tree) was found in the Core package for ${deviceIdentity(setup.metadata.device)}. ` +
      'Reinstall/update the Toshiba Core package or set mikrobusRust.cToshibaCmsisPackPath.'
    );
  }
  const target = String(setup?.metadata?.device?.mcuName || setup?.metadata?.sdkConfig?.MCU_NAME || setup?.metadata?.device?.uid || '').trim();
  if (!target) throw new Error('The Toshiba setup does not contain an MCU target name for pyOCD.');
  return { pyocd, cmsisPack, target, probeArgs: probeArgs() };
}

function commandArgs(runtime, subcommand, extra = []) {
  return [subcommand, '--target', runtime.target, '--pack', runtime.cmsisPack, ...runtime.probeArgs, ...extra];
}

async function program(runtime, image, options = {}) {
  options.onStatus?.('Connecting to Toshiba CMSIS-DAP...');
  await runStreaming(runtime.pyocd, commandArgs(runtime, 'load', [image]), options);
  options.onStatus?.('Programming complete.');
}

async function erase(runtime, options = {}) {
  options.onStatus?.('Erasing Toshiba target...');
  await runStreaming(runtime.pyocd, commandArgs(runtime, 'erase', ['--chip']), options);
  options.onStatus?.('Erase complete.');
}

function debugConfiguration(setup, projectRoot, elf, runtime, generation) {
  return {
    type: 'cortex-debug',
    request: 'launch',
    name: `MikroBUS C Toshiba CMSIS-DAP: ${setup.name}`,
    cwd: projectRoot,
    executable: elf,
    servertype: 'pyocd',
    serverpath: runtime.pyocd,
    targetId: runtime.target,
    cmsisPack: runtime.cmsisPack,
    serverArgs: runtime.probeArgs,
    gdbPath: setup.tools?.gdb,
    runToEntryPoint: 'main',
    __mikrobusToshibaCmsisDap: true,
    __mikrobusCDebugInstance: generation,
    __mikrobusCDebug: true
  };
}

module.exports = {
  TOSHIBA_CMSIS_DAP_PROGRAMMER_UID,
  PY_OCD_VERSION,
  isToshibaDevice,
  syntheticProgrammer,
  resolveCmsisPackPath,
  resolvePyocdExecutable,
  ensurePyocd,
  prepareRuntime,
  program,
  erase,
  debugConfiguration,
  _test: {
    deviceIdentity,
    mcuFamilyToken,
    scorePackCandidate,
    collectFiles,
    probeArgs,
    commandArgs,
    versionAtLeast,
    managedPyocdRoot,
    managedPyocdExecutable
  }
};
