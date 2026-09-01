'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const vscode = require('vscode');
const { resolvePackage } = require('./c_package_catalog');

const installLocks = new Map();
let packagePanel;
let environmentPanel;
let programmerPanel;

function expandHome(value) {
  const text = String(value || '').trim();
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith(`~${path.sep}`)) return path.join(os.homedir(), text.slice(2));
  return text;
}

function getManagedRoot(context) {
  const configured = String(vscode.workspace.getConfiguration('mikrobusRust').get('storageRoot', '') || '').trim();
  return configured ? path.resolve(expandHome(configured)) : context.globalStorageUri.fsPath;
}

function getPackagePaths(context) {
  const root = path.join(getManagedRoot(context), 'c-runtime');
  return {
    root,
    packages: path.join(root, 'packages'),
    registry: path.join(root, 'installed-packages.json'),
    staging: path.join(root, '.staging'),
    setups: path.join(root, 'setups')
  };
}

function packageKey(spec) {
  const version = String(spec.version || '').trim();
  return `${spec.kind}:${spec.name}${version ? `@${version}` : ''}`;
}

function safeName(value) {
  return String(value || '').trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'package';
}

function packageTarget(context, spec) {
  return path.join(
    getPackagePaths(context).packages,
    safeName(spec.kind),
    safeName(spec.name),
    safeName(spec.version || 'current')
  );
}

function readRegistry(context) {
  const registryPath = getPackagePaths(context).registry;
  if (!fs.existsSync(registryPath)) return { version: 1, packages: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return {
      version: 1,
      packages: Array.isArray(parsed.packages) ? parsed.packages : []
    };
  } catch (error) {
    throw new Error(`Installed C package registry is invalid: ${registryPath}. ${error.message}`);
  }
}

function writeRegistry(context, registry) {
  const registryPath = getPackagePaths(context).registry;
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const temporary = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, packages: registry.packages }, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, registryPath);
}

function getInstalledPackage(context, specOrKey) {
  const key = typeof specOrKey === 'string' ? specOrKey : packageKey(specOrKey);
  const entry = readRegistry(context).packages.find((item) => item.key === key);
  if (!entry || !entry.root || !fs.existsSync(entry.root)) return undefined;
  return entry;
}

function listInstalledPackages(context, includeEnvironment = true) {
  return readRegistry(context).packages
    .filter((entry) => includeEnvironment || !entry.environment)
    .filter((entry) => entry.root && fs.existsSync(entry.root))
    .sort((left, right) => `${left.kind}/${left.name}`.localeCompare(`${right.kind}/${right.name}`));
}

function findOnPath(names) {
  const value = process.env.PATH || process.env.Path || '';
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const directory of value.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidates = process.platform === 'win32' && !path.extname(name)
        ? extensions.map((extension) => path.join(directory, `${name}${extension.toLowerCase()}`))
        : [path.join(directory, name)];
      for (const candidate of candidates) {
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          // Continue searching.
        }
      }
    }
  }
  return undefined;
}

function bundledSevenZip() {
  try {
    const candidate = require('7zip-bin').path7za;
    if (!candidate || !fs.existsSync(candidate)) return undefined;
    if (process.platform !== 'win32') {
      try { fs.chmodSync(candidate, 0o755); } catch { return undefined; }
    }
    return candidate;
  } catch {
    return undefined;
  }
}

function ensureNotCancelled(token) {
  if (token?.isCancellationRequested) throw new Error('Package installation cancelled.');
}

function openResponse(url, token, redirectCount = 0) {
  ensureNotCancelled(token);
  if (redirectCount > 8) return Promise.reject(new Error(`Too many redirects while downloading ${url}.`));
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'http:' ? http : https;
    const request = transport.get(parsed, {
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': 'mikrobus-embedded-vscode-extension'
      }
    }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        openResponse(new URL(response.headers.location, parsed).toString(), token, redirectCount + 1)
          .then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => reject(new Error(
          `HTTP ${status} while downloading package${chunks.length ? `: ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}` : ''}`
        )));
        return;
      }
      resolve(response);
    });
    const cancellation = token?.onCancellationRequested(() => request.destroy(new Error('Package installation cancelled.')));
    request.setTimeout(45000, () => request.destroy(new Error('Package download timed out.')));
    request.on('error', reject);
    request.on('close', () => cancellation?.dispose());
  });
}

async function downloadFile(url, destination, progress, token) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  fs.rmSync(partial, { force: true });
  const response = await openResponse(url, token);
  const total = Number(response.headers['content-length'] || 0);
  let received = 0;
  let reported = -10;
  const output = fs.createWriteStream(partial, { flags: 'wx' });
  try {
    await new Promise((resolve, reject) => {
      const cancellation = token?.onCancellationRequested(() => {
        response.destroy(new Error('Package installation cancelled.'));
        output.destroy(new Error('Package installation cancelled.'));
      });
      response.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0) {
          const percentage = Math.floor((received / total) * 100);
          if (percentage >= reported + 10) {
            progress?.report({ message: `Downloading ${percentage}%` });
            reported = percentage;
          }
        }
      });
      response.on('error', reject);
      output.on('error', reject);
      output.on('finish', resolve);
      output.on('close', () => cancellation?.dispose());
      response.pipe(output);
    });
    ensureNotCancelled(token);
    fs.renameSync(partial, destination);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
}

function runCommand(executable, args, token) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const cancellation = token?.onCancellationRequested(() => child.kill());
    child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-12000); });
    child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-12000); });
    child.on('error', reject);
    child.on('close', (code) => {
      cancellation?.dispose();
      if (token?.isCancellationRequested) {
        reject(new Error('Package installation cancelled.'));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${path.basename(executable)} exited with code ${code}.${output.trim() ? ` ${output.trim()}` : ''}`));
      }
    });
  });
}

async function extractArchive(archivePath, destination, token) {
  fs.mkdirSync(destination, { recursive: true });
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.7z')) {
    const sevenZip = bundledSevenZip() || findOnPath(['7zz', '7z', '7za']) || (process.platform === 'win32'
      ? ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe'].find(fs.existsSync)
      : undefined);
    if (!sevenZip) throw new Error('The bundled 7-Zip extractor is unavailable and no system 7-Zip was found.');
    await runCommand(sevenZip, ['x', '-y', archivePath, `-o${destination}`], token);
    return;
  }
  if (lower.endsWith('.zip')) {
    const unzip = findOnPath(process.platform === 'win32' ? ['tar.exe', 'tar'] : ['unzip']);
    if (!unzip) throw new Error('A ZIP extractor was not found.');
    await runCommand(unzip, path.basename(unzip).toLowerCase().startsWith('tar')
      ? ['-xf', archivePath, '-C', destination]
      : ['-o', archivePath, '-d', destination], token);
    return;
  }
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar.xz')) {
    const tar = findOnPath(process.platform === 'win32' ? ['tar.exe', 'tar'] : ['tar']);
    if (!tar) throw new Error('tar was not found.');
    await runCommand(tar, ['-xf', archivePath, '-C', destination], token);
    return;
  }
  throw new Error(`Unsupported package archive: ${path.basename(archivePath)}`);
}


function isCodegripServerSpec(spec) {
  return String(spec?.kind || '').toLowerCase() === 'programmer' &&
    String(spec?.name || '').toLowerCase() === 'codegrip_gdb_server';
}

function isCodegripServerFileName(name) {
  const raw = String(name || '');
  const withoutExe = raw.replace(/\.exe$/i, '');
  const normalized = withoutExe.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === 'codegripgdbserver' ||
    (normalized.includes('codegrip') && normalized.includes('gdb') && normalized.includes('server'));
}

function codegripServerCandidates(root) {
  if (!root) return [];
  const names = process.platform === 'win32'
    ? ['CodegripGdbServer.exe', 'codegrip_gdb_server.exe', 'codegrip-gdb-server.exe']
    : ['CodegripGdbServer', 'codegrip_gdb_server', 'codegrip-gdb-server'];
  if (process.platform === 'darwin') {
    return [
      path.join(root, 'apps', 'CodegripGdbServer.app', 'Contents', 'MacOS', 'CodegripGdbServer'),
      ...names.flatMap((name) => [path.join(root, 'apps', 'bin', name), path.join(root, 'bin', name), path.join(root, name)])
    ];
  }
  return names.flatMap((name) => [
    path.join(root, 'apps', name),
    path.join(root, 'apps', 'bin', name),
    path.join(root, 'bin', name),
    path.join(root, name)
  ]);
}

function findRecursiveCodegripServer(root, maximumDepth = 10) {
  if (!root || !fs.existsSync(root)) return undefined;
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(current.directory, entry.name);
      if ((entry.isFile() || entry.isSymbolicLink()) && isCodegripServerFileName(entry.name)) return candidate;
      if (entry.isDirectory() && current.depth < maximumDepth) queue.push({ directory: candidate, depth: current.depth + 1 });
    }
  }
  return undefined;
}

function findCodegripPayloadRoot(extractRoot) {
  // The CODEGRIP server archive and the MCU device-pack archives are separate
  // products. The live Codegrip-Prog-Debug.csv supplies the setup-specific
  // packs, so the server archive is valid even when it has no packs/ folder.
  // First find the nearest directory that has the standard apps/... server
  // layout, which also strips arbitrary archive wrapper directories.
  const queue = [{ directory: extractRoot, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (codegripServerCandidates(current.directory).some((candidate) => fs.existsSync(candidate))) return current.directory;
    if (current.depth >= 8) continue;
    let entries = [];
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  // Tolerate future server archive layouts too. In that case retain the
  // normalized payload root so companion DLLs/resources remain beside it.
  const normalized = normalizedPayloadRoot(extractRoot, { name: 'codegrip' });
  if (findRecursiveCodegripServer(normalized)) return normalized;
  if (findRecursiveCodegripServer(extractRoot)) return extractRoot;
  return undefined;
}

function codegripServerInstalled(root) {
  if (!root || !fs.existsSync(root)) return false;
  return Boolean(codegripServerCandidates(root).some((candidate) => fs.existsSync(candidate)) || findRecursiveCodegripServer(root));
}

function collectNestedArchives(root, maximumDepth = 6, maximumFiles = 12) {
  if (!root || !fs.existsSync(root)) return [];
  const result = [];
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length && result.length < maximumFiles) {
    const current = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(current.directory, entry.name);
      if (entry.isDirectory() && current.depth < maximumDepth) {
        queue.push({ directory: candidate, depth: current.depth + 1 });
      } else if (entry.isFile() && /\.(7z|zip|tgz|tar\.gz|tar\.xz)$/i.test(entry.name)) {
        result.push(candidate);
        if (result.length >= maximumFiles) break;
      }
    }
  }
  return result;
}

async function findCodegripPayloadIncludingNested(extractRoot, operationRoot, token) {
  const direct = findCodegripPayloadRoot(extractRoot);
  if (direct) return direct;
  const nestedArchives = collectNestedArchives(extractRoot);
  for (let index = 0; index < nestedArchives.length; index += 1) {
    const nestedRoot = path.join(operationRoot, `nested-codegrip-${index}`);
    try {
      await extractArchive(nestedArchives[index], nestedRoot, token);
    } catch {
      continue;
    }
    const payload = findCodegripPayloadRoot(nestedRoot);
    if (payload) return payload;
  }
  return undefined;
}

function inferCodegripPayloadRootFromExecutable(executable) {
  if (!executable) return undefined;
  const resolved = path.resolve(executable);
  const executableDir = path.dirname(resolved);
  if (path.basename(executableDir).toLowerCase() === 'bin') {
    const parent = path.dirname(executableDir);
    if (path.basename(parent).toLowerCase() === 'apps') return path.dirname(parent);
    // For layouts such as <root>/bin/codegrip_gdb_server, preserve the root so
    // sibling lib/resource directories are copied with the executable.
    return parent;
  }
  let current = executableDir;
  for (let depth = 0; depth < 8; depth += 1) {
    if (path.basename(current).toLowerCase() === 'codegrip') return current;
    if (path.basename(current).toLowerCase() === 'apps') return path.dirname(current);
    if (codegripServerCandidates(current).some((candidate) => fs.existsSync(candidate))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return executableDir;
}

function findExistingCodegripPayloadRoot(context) {
  const managedRoot = getManagedRoot(context);
  const configured = String(vscode.workspace.getConfiguration('mikrobusRust').get('codegripServerPath', '') || '').trim();
  const executableCandidates = [];
  if (configured) {
    const expanded = path.resolve(expandHome(configured));
    if (fs.existsSync(expanded)) {
      try {
        if (fs.statSync(expanded).isDirectory()) {
          executableCandidates.push(...codegripServerCandidates(expanded));
          const recursive = findRecursiveCodegripServer(expanded);
          if (recursive) executableCandidates.push(recursive);
        } else {
          executableCandidates.push(expanded);
        }
      } catch {}
    }
  }
  const roots = [
    path.join(managedRoot, 'runner', 'codegrip'),
    path.join(os.homedir(), '.MIKROE', 'NECTOStudio7', 'packages', 'programmers', 'codegrip')
  ];
  for (const root of roots) {
    executableCandidates.push(...codegripServerCandidates(root));
    const recursive = findRecursiveCodegripServer(root);
    if (recursive) executableCandidates.push(recursive);
  }
  const fromPath = findOnPath(process.platform === 'win32'
    ? ['CodegripGdbServer.exe', 'codegrip_gdb_server.exe', 'codegrip-gdb-server.exe']
    : ['CodegripGdbServer', 'codegrip_gdb_server', 'codegrip-gdb-server']);
  if (fromPath) executableCandidates.push(fromPath);

  for (const executable of executableCandidates) {
    if (!executable || !fs.existsSync(executable) || !isCodegripServerFileName(path.basename(executable))) continue;
    const root = inferCodegripPayloadRootFromExecutable(executable);
    if (root && fs.existsSync(root)) return root;
  }
  return undefined;
}
function directoryHasContent(directory) {
  try {
    return fs.statSync(directory).isDirectory() && fs.readdirSync(directory).length > 0;
  } catch {
    return false;
  }
}

function normalizedPayloadRoot(extractRoot, spec) {
  const entries = fs.readdirSync(extractRoot, { withFileTypes: true })
    .filter((entry) => entry.name !== '__MACOSX');
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(extractRoot, entries[0].name);
  }
  const exact = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === spec.name.toLowerCase());
  return exact ? path.join(extractRoot, exact.name) : extractRoot;
}

async function replaceDirectory(source, target) {
  if (!directoryHasContent(source)) throw new Error(`Package payload is empty: ${source}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const backup = `${target}.backup-${Date.now()}`;
  const hadTarget = fs.existsSync(target);
  if (hadTarget) fs.renameSync(target, backup);
  try {
    try {
      fs.renameSync(source, target);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      fs.cpSync(source, target, { recursive: true, force: true });
      fs.rmSync(source, { recursive: true, force: true });
    }
    if (hadTarget) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    if (hadTarget && fs.existsSync(backup)) fs.renameSync(backup, target);
    throw error;
  }
}

function archiveNameFromUrl(url, spec) {
  try {
    const name = path.basename(new URL(url).pathname);
    if (/\.(7z|zip|tar\.gz|tgz|tar\.xz)$/i.test(name)) return name;
  } catch {
    // Use the fallback below.
  }
  return `${safeName(spec.name)}.7z`;
}

function verifyChecksum(filePath, checksum) {
  if (!checksum) return;
  const normalized = String(checksum).replace(/^sha256:/i, '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) return;
  const actual = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  if (actual !== normalized) throw new Error(`SHA-256 verification failed for ${path.basename(filePath)}.`);
}

async function installPackageUnlocked(context, spec, progress, token) {
  const resolved = await resolvePackage(context, spec);
  const paths = getPackagePaths(context);
  const operationRoot = path.join(paths.staging, `${safeName(spec.name)}-${process.pid}-${Date.now()}`);
  const archivePath = path.join(operationRoot, archiveNameFromUrl(resolved.downloadUrl, spec));
  const extractRoot = path.join(operationRoot, 'payload');
  fs.mkdirSync(extractRoot, { recursive: true });
  try {
    progress?.report({ message: `Downloading ${spec.name}...` });
    await downloadFile(resolved.downloadUrl, archivePath, progress, token);
    verifyChecksum(archivePath, resolved.checksum);
    progress?.report({ message: `Installing ${spec.name}...` });
    await extractArchive(archivePath, extractRoot, token);
    let source = normalizedPayloadRoot(extractRoot, spec);
    if (isCodegripServerSpec(spec)) {
      source = await findCodegripPayloadIncludingNested(extractRoot, operationRoot, token);
      if (!source) {
        const existingRoot = findExistingCodegripPayloadRoot(context);
        if (existingRoot) {
          const fallbackCopy = path.join(operationRoot, 'existing-codegrip');
          fs.cpSync(existingRoot, fallbackCopy, { recursive: true, force: true });
          source = fallbackCopy;
        }
      }
      if (!source) {
        throw new Error(
          'CODEGRIP server was not found in the downloaded package (including nested archives), ' +
          'the Rust managed CODEGRIP package, the NECTO CODEGRIP installation, or PATH. ' +
          'MCU device packs are installed separately from Codegrip-Prog-Debug.csv.'
        );
      }
    }
    const target = packageTarget(context, spec);
    await replaceDirectory(source, target);
    if (isCodegripServerSpec(spec) && !codegripServerInstalled(target)) {
      throw new Error(`Installed CODEGRIP package is incomplete: ${target}.`);
    }
    if (isCodegripServerSpec(spec) && process.platform !== 'win32') {
      const executables = [...codegripServerCandidates(target)];
      const recursiveServer = findRecursiveCodegripServer(target);
      if (recursiveServer) executables.push(recursiveServer);
      for (const executable of new Set(executables)) {
        if (!fs.existsSync(executable)) continue;
        try { fs.chmodSync(executable, 0o755); } catch {}
      }
    }

    const registry = readRegistry(context);
    const key = packageKey(spec);
    const entry = {
      key,
      name: spec.name,
      displayName: spec.displayName || spec.name,
      kind: spec.kind,
      catalogGroup: spec.catalogGroup || spec.kind,
      version: resolved.version || spec.version || '',
      environment: Boolean(spec.environment),
      root: target,
      sourceUrl: resolved.downloadUrl,
      installedAt: new Date().toISOString()
    };
    const index = registry.packages.findIndex((item) => item.key === key);
    if (index >= 0) registry.packages[index] = entry;
    else registry.packages.push(entry);
    writeRegistry(context, registry);
    return entry;
  } finally {
    fs.rmSync(operationRoot, { recursive: true, force: true });
  }
}

async function ensurePackage(context, spec, progress, token) {
  const installed = getInstalledPackage(context, spec);
  const versionMatches = installed && (!spec.version || !installed.version || installed.version === spec.version);
  if (versionMatches) {
    // A previously installed CODEGRIP server package may have been extracted
    // by an older generic archive path and therefore miss CodegripGdbServer.
    // Device packs are intentionally not required here; they are managed per
    // setup from Codegrip-Prog-Debug.csv.
    if (isCodegripServerSpec(spec) && !codegripServerInstalled(installed.root)) {
      // Continue to installPackageUnlocked below.
    } else {
      // SDK contents may change while retaining the mikroSDK semantic version,
      // and live CODEGRIP catalog entries can redirect a package name/version to
      // a new asset URL. Track source URLs for both cases.
      const sourceSensitive = String(spec.kind || '').toLowerCase() === 'sdk' || Boolean(spec.downloadUrl);
      if (!sourceSensitive) return installed;
      const resolved = await resolvePackage(context, spec);
      if (installed.sourceUrl === resolved.downloadUrl) return installed;
    }
  }
  const key = packageKey(spec);
  if (installLocks.has(key)) return installLocks.get(key);
  const operation = installPackageUnlocked(context, spec, progress, token)
    .finally(() => installLocks.delete(key));
  installLocks.set(key, operation);
  return operation;
}

async function ensurePackages(context, specs, progress, token) {
  const unique = [];
  const seen = new Set();
  for (const spec of specs.filter((item) => item?.name)) {
    const key = packageKey(spec);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(spec);
  }
  const result = new Map();
  for (const spec of unique) {
    ensureNotCancelled(token);
    const entry = await ensurePackage(context, spec, progress, token);
    result.set(packageKey(spec), entry);
  }
  return result;
}

function setupReferences(context, packageEntry) {
  const setupRoot = getPackagePaths(context).setups;
  if (!fs.existsSync(setupRoot)) return [];
  const references = [];
  for (const name of fs.readdirSync(setupRoot)) {
    const setupPath = path.join(setupRoot, name, 'setup.json');
    if (!fs.existsSync(setupPath)) continue;
    try {
      const setup = JSON.parse(fs.readFileSync(setupPath, 'utf8'));
      if (Array.isArray(setup.packageKeys) && setup.packageKeys.includes(packageEntry.key)) {
        references.push(setup.name || setup.id || name);
      }
    } catch {
      // An invalid setup is reported by the setup workflow, not package listing.
    }
  }
  return references;
}

async function uninstallPackage(context, key) {
  const registry = readRegistry(context);
  const entry = registry.packages.find((item) => item.key === key);
  if (!entry) throw new Error(`Installed package '${key}' was not found.`);
  const references = setupReferences(context, entry);
  const warning = references.length > 0
    ? `\n\nUsed by: ${references.join(', ')}. Those setups will be rebuilt automatically on their next build.`
    : '';
  const selected = await vscode.window.showWarningMessage(
    `Uninstall ${entry.displayName || entry.name}?${warning}`,
    { modal: true },
    'Uninstall'
  );
  if (selected !== 'Uninstall') return false;
  const packagesRoot = path.resolve(getPackagePaths(context).packages);
  const target = path.resolve(entry.root);
  const relative = path.relative(packagesRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove a package outside the managed C package root: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  registry.packages = registry.packages.filter((item) => item.key !== key);
  writeRegistry(context, registry);
  return true;
}

function packagePanelHtml() {
  const nonce = crypto.randomBytes(16).toString('hex');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Installed C Packages</title><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:1000px;margin:auto}
header{display:flex;align-items:center;justify-content:space-between;gap:16px}.muted{color:var(--vscode-descriptionForeground)}
#packages{display:grid;gap:12px;margin-top:24px}.card{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:16px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.meta{display:flex;gap:8px;flex-wrap:wrap;color:var(--vscode-descriptionForeground);font-size:12px}code{font-family:var(--vscode-editor-font-family);word-break:break-all}
button{border:0;border-radius:3px;padding:7px 12px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}
.danger{background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder)}.empty{padding:32px;border:1px dashed var(--vscode-panel-border);text-align:center;border-radius:8px}
</style></head><body><header><div><h1>Installed C packages</h1><p class="muted">SDK, MCU core and device-support packages installed automatically by C setups.</p></div><button id="refresh">Refresh</button></header><main id="packages"></main>
<script nonce="${nonce}">const vscode=acquireVsCodeApi();const root=document.getElementById('packages');
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function render(items){if(!items.length){root.innerHTML='<div class="empty">No C packages are installed.</div>';return;}root.innerHTML=items.map(function(p){return '<article class="card"><div><h3>'+esc(p.displayName||p.name)+'</h3><div class="meta"><span>'+esc(p.kind)+'</span><span>'+esc(p.version||'version not reported')+'</span></div><p><code>'+esc(p.root)+'</code></p></div><button class="danger" data-key="'+esc(p.key)+'">Uninstall</button></article>';}).join('');}
document.getElementById('refresh').onclick=()=>vscode.postMessage({type:'refresh'});root.onclick=e=>{const key=e.target?.dataset?.key;if(key)vscode.postMessage({type:'uninstall',key});};
window.addEventListener('message',e=>{if(e.data?.type==='packages')render(e.data.items||[]);});vscode.postMessage({type:'ready'});</script></body></html>`;
}

function postPackageState(context) {
  if (!packagePanel) return;
  void packagePanel.webview.postMessage({
    type: 'packages',
    items: listInstalledPackages(context, true)
  });
}

async function openInstalledPackages(context) {
  if (packagePanel) {
    packagePanel.reveal(vscode.ViewColumn.Active);
    postPackageState(context);
    return;
  }
  packagePanel = vscode.window.createWebviewPanel(
    'mikrobusC.installedPackages',
    'MikroBUS C: Installed Packages',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  packagePanel.webview.html = packagePanelHtml();
  packagePanel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (message?.type === 'ready' || message?.type === 'refresh') postPackageState(context);
      if (message?.type === 'uninstall' && typeof message.key === 'string') {
        if (await uninstallPackage(context, message.key)) postPackageState(context);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`MikroBUS C packages: ${error.message || error}`);
    }
  }, null, context.subscriptions);
  packagePanel.onDidDispose(() => { packagePanel = undefined; }, null, context.subscriptions);
}

function infrastructureSpecs() {
  return [
    { kind: 'infrastructure', name: 'unit_test_lib', version: 'general_packages_assets', displayName: 'Unit Test Library', environment: true },
    { kind: 'infrastructure', name: 'preinit', version: 'general_packages_assets', displayName: 'Preinit Routines', environment: true },
    { kind: 'infrastructure', name: 'mikroe_utils_common', version: 'general_packages_assets', displayName: 'MIKROE Common CMake Utilities', environment: true }
  ];
}

function environmentSpecs() {
  return [
    { kind: 'database', name: 'C_database', version: '0.0.1', displayName: 'C Setup Database', environment: true },
    { kind: 'core', name: 'C_core', version: '0.0.1', displayName: 'C Core Collection', environment: true },
    { kind: 'sdk', name: 'mikrosdk', version: '2.19.1', displayName: 'mikroSDK 2.19.1', environment: true },
    ...infrastructureSpecs(),
    { kind: 'toolchain', name: 'gcc_arm_compiler', version: '14.2.1-1.1', displayName: 'GCC for ARM', environment: true }
  ];
}

function environmentPackageState(context) {
  return environmentSpecs().map((spec) => {
    const installed = getInstalledPackage(context, spec);
    return {
      key: packageKey(spec),
      kind: spec.kind,
      name: spec.name,
      displayName: spec.displayName || spec.name,
      version: spec.version || installed?.version || '',
      status: installed ? 'installed' : 'missing',
      root: installed?.root || packageTarget(context, spec),
      sourceUrl: installed?.sourceUrl || ''
    };
  });
}

function installedProgrammerPackages(context) {
  return listInstalledPackages(context, true)
    .filter((entry) => /^programmer(?:-pack)?$/i.test(String(entry.kind || '')))
    .map((entry) => ({ ...entry, references: setupReferences(context, entry) }));
}

function cManagerHtml(kind) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const isEnvironment = kind === 'environment';
  const title = isEnvironment ? 'C Development Environment' : 'Installed Programmer Packages';
  const subtitle = isEnvironment
    ? 'Extension-managed packages used by C setup creation and project builds.'
    : 'Programmer/debugger packages installed by C setups, including CODEGRIP server and MCU device packs.';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>${title}</title><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:1050px;margin:auto}header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap}.muted{color:var(--vscode-descriptionForeground)}.actions{display:flex;gap:8px;flex-wrap:wrap}button{border:0;border-radius:3px;padding:7px 12px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}button.danger{background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder)}button:disabled{opacity:.55;cursor:default}.summary{display:flex;gap:14px;margin-top:20px}.summary span{padding:5px 9px;border:1px solid var(--vscode-panel-border);border-radius:999px}.grid{display:grid;gap:12px;margin-top:20px}.card{border:1px solid var(--vscode-panel-border);border-left:3px solid var(--vscode-disabledForeground);border-radius:7px;padding:14px;display:flex;align-items:center;justify-content:space-between;gap:18px}.card.installed{border-left-color:var(--vscode-testing-iconPassed)}.card.missing{border-left-color:var(--vscode-testing-iconFailed)}h1,h3{margin:0}.meta{display:flex;gap:8px;flex-wrap:wrap;color:var(--vscode-descriptionForeground);font-size:12px;margin-top:5px}code{font-family:var(--vscode-editor-font-family);word-break:break-all;font-size:11px}.empty{padding:32px;border:1px dashed var(--vscode-panel-border);text-align:center;border-radius:8px}.refs{color:var(--vscode-descriptionForeground);font-size:11px;margin-top:7px}
</style></head><body><header><div><h1>${title}</h1><p class="muted">${subtitle}</p></div><div class="actions">${isEnvironment ? '<button id="installAll">Install all</button><button id="programmers" class="secondary">Installed programmer packages</button>' : '<button id="back" class="secondary">Back</button>'}<button id="refresh" class="secondary">Refresh</button></div></header>${isEnvironment ? '<section class="summary"><span id="installedCount">0 installed</span><span id="missingCount">0 missing</span></section>' : ''}<main id="packages" class="grid"></main>
<script nonce="${nonce}">const vscode=acquireVsCodeApi();const root=document.getElementById('packages');const env=${isEnvironment ? 'true' : 'false'};
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function render(items){if(env){const installed=items.filter(x=>x.status==='installed').length;document.getElementById('installedCount').textContent=installed+' installed';document.getElementById('missingCount').textContent=(items.length-installed)+' missing';}if(!items.length){root.innerHTML='<div class="empty">'+(env?'No environment packages are defined.':'No programmer packages are installed.')+'</div>';return;}root.innerHTML=items.map(p=>{const status=p.status||'installed';const refs=(p.references||[]);return '<article class="card '+esc(status)+'"><div><h3>'+esc(p.displayName||p.name)+'</h3><div class="meta"><span>'+esc(p.kind)+'</span><span>'+esc(p.version||'version not reported')+'</span><span>'+esc(status)+'</span></div><p><code>'+esc(p.root||'')+'</code></p>'+(refs.length?'<div class="refs">Used by setup: '+esc(refs.join(', '))+'</div>':'')+'</div><div class="actions">'+(status==='installed'?'<button class="danger" data-uninstall="'+esc(p.key)+'">Uninstall</button>':(env?'<button data-install="'+esc(p.key)+'">Install</button>':''))+'</div></article>';}).join('');}
root.onclick=e=>{const uninstall=e.target?.dataset?.uninstall;if(uninstall){vscode.postMessage({type:'uninstall',key:uninstall});return;}const install=e.target?.dataset?.install;if(install)vscode.postMessage({type:'install',key:install});};document.getElementById('refresh').onclick=()=>vscode.postMessage({type:'refresh'});${isEnvironment ? "document.getElementById('installAll').onclick=()=>vscode.postMessage({type:'installAll'});document.getElementById('programmers').onclick=()=>vscode.postMessage({type:'programmers'});" : "document.getElementById('back').onclick=()=>vscode.postMessage({type:'back'});"}window.addEventListener('message',e=>{if(e.data?.type==='state')render(e.data.items||[]);});vscode.postMessage({type:'ready'});</script></body></html>`;
}

function postEnvironmentState(context) {
  if (!environmentPanel) return;
  void environmentPanel.webview.postMessage({ type: 'state', items: environmentPackageState(context) });
}

function postProgrammerState(context) {
  if (!programmerPanel) return;
  void programmerPanel.webview.postMessage({ type: 'state', items: installedProgrammerPackages(context) });
}

async function installEnvironmentPackage(context, key) {
  const spec = environmentSpecs().find((item) => packageKey(item) === key);
  if (!spec) throw new Error(`Unknown C environment package '${key}'.`);
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing ${spec.displayName || spec.name}`, cancellable: true },
    (progress, token) => ensurePackage(context, spec, progress, token));
}

async function installAllEnvironmentPackages(context) {
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Installing MikroBUS C development environment', cancellable: true },
    (progress, token) => ensurePackages(context, environmentSpecs(), progress, token));
}

async function openProgrammerPackages(context) {
  if (programmerPanel) { programmerPanel.reveal(vscode.ViewColumn.Active); postProgrammerState(context); return; }
  programmerPanel = vscode.window.createWebviewPanel('mikrobusC.programmerPackages', 'MikroBUS C: Installed Programmer Packages', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  programmerPanel.webview.html = cManagerHtml('programmers');
  programmerPanel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (message?.type === 'ready' || message?.type === 'refresh') postProgrammerState(context);
      if (message?.type === 'back') {
        const current = programmerPanel;
        if (current) current.dispose();
        await openEnvironmentPackages(context);
        return;
      }
      if (message?.type === 'uninstall' && typeof message.key === 'string') { if (await uninstallPackage(context, message.key)) postProgrammerState(context); }
    } catch (error) { vscode.window.showErrorMessage(`MikroBUS C programmer packages: ${error.message || error}`); }
  }, null, context.subscriptions);
  programmerPanel.onDidDispose(() => { programmerPanel = undefined; }, null, context.subscriptions);
  postProgrammerState(context);
}

async function openEnvironmentPackages(context) {
  if (environmentPanel) { environmentPanel.reveal(vscode.ViewColumn.Active); postEnvironmentState(context); return; }
  environmentPanel = vscode.window.createWebviewPanel('mikrobusC.environmentPackages', 'MikroBUS C: Development Environment', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  environmentPanel.webview.html = cManagerHtml('environment');
  environmentPanel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (message?.type === 'ready' || message?.type === 'refresh') postEnvironmentState(context);
      if (message?.type === 'installAll') { await installAllEnvironmentPackages(context); postEnvironmentState(context); }
      if (message?.type === 'install' && typeof message.key === 'string') { await installEnvironmentPackage(context, message.key); postEnvironmentState(context); }
      if (message?.type === 'uninstall' && typeof message.key === 'string') { if (await uninstallPackage(context, message.key)) postEnvironmentState(context); }
      if (message?.type === 'programmers') await openProgrammerPackages(context);
    } catch (error) { vscode.window.showErrorMessage(`MikroBUS C environment: ${error.message || error}`); }
  }, null, context.subscriptions);
  environmentPanel.onDidDispose(() => { environmentPanel = undefined; }, null, context.subscriptions);
  postEnvironmentState(context);
}

module.exports = {
  getManagedRoot,
  getPackagePaths,
  packageKey,
  packageTarget,
  getInstalledPackage,
  listInstalledPackages,
  ensurePackage,
  ensurePackages,
  openInstalledPackages,
  openEnvironmentPackages,
  openProgrammerPackages,
  uninstallPackage,
  infrastructureSpecs,
  environmentSpecs,
  environmentPackageState,
  installedProgrammerPackages,
  installAllEnvironmentPackages,
  findOnPath,
  _test: {
    safeName,
    archiveNameFromUrl,
    normalizedPayloadRoot,
    isCodegripServerSpec,
    isCodegripServerFileName,
    findCodegripPayloadRoot,
    findRecursiveCodegripServer,
    codegripServerInstalled,
    collectNestedArchives,
    inferCodegripPayloadRootFromExecutable,
    findExistingCodegripPayloadRoot,
    environmentSpecs
  }
};
