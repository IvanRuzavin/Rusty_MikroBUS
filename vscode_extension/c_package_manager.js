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
const compilerSupport = require('./c_compiler_support');

const installLocks = new Map();
let packagePanel;
let environmentPanel;
let environmentViewKind = 'environment';

const CORE_METADATA_URL = 'https://github.com/MikroElektronika/core_packages/releases/download/v2.0.0/metadata.json';
const MIKROSDK_LATEST_API = 'https://api.github.com/repos/MikroElektronika/mikrosdk_v2/releases/latest';

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

function legacyPackageKey(spec) {
  const version = String(spec.version || '').trim();
  return `${spec.kind}:${spec.name}${version ? `@${version}` : ''}`;
}

function packageKey(spec) {
  const version = String(spec.version || '').trim();
  const instance = String(spec.kind || '').toLowerCase() === 'bsp-card'
    ? String(spec.mcuName || spec.deviceUid || '').trim()
    : '';
  return `${spec.kind}:${spec.name}${instance ? `#${safeName(instance)}` : ''}${version ? `@${version}` : ''}`;
}

function safeName(value) {
  return String(value || '').trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'package';
}

function packageTarget(context, spec) {
  const packagesRoot = path.resolve(getPackagePaths(context).packages);
  if (spec.installRelativePath) {
    const segments = String(spec.installRelativePath).replace(/\\/g, '/').split('/').filter(Boolean);
    if (!segments.length || segments.some((segment) => segment === '..' || segment === '.')) throw new Error(`Invalid package install path for ${spec.name}.`);
    const target = path.resolve(packagesRoot, ...segments);
    const relative = path.relative(packagesRoot, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Package install path escapes the managed package root: ${target}`);
    return target;
  }
  return path.join(packagesRoot, safeName(spec.kind), safeName(spec.name), safeName(spec.version || 'current'));
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

function findRecursive(root, predicate, maximumDepth = 8) {
  if (!root || !fs.existsSync(root)) return undefined;
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(current.directory, entry.name);
      if (entry.isFile() && predicate(candidate, entry.name)) return candidate;
      if (entry.isDirectory() && current.depth < maximumDepth) queue.push({ directory: candidate, depth: current.depth + 1 });
    }
  }
  return undefined;
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

function openResponse(url, token, redirectCount = 0, accept = 'application/octet-stream') {
  ensureNotCancelled(token);
  if (redirectCount > 8) return Promise.reject(new Error(`Too many redirects while downloading ${url}.`));
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'http:' ? http : https;
    const request = transport.get(parsed, {
      headers: {
        Accept: accept,
        'User-Agent': 'mikrobus-embedded-vscode-extension',
        ...(parsed.hostname === 'api.github.com' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {})
      }
    }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        openResponse(new URL(response.headers.location, parsed).toString(), token, redirectCount + 1, accept)
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


function jsonAcceptHeader() {
  return 'application/vnd.github+json, application/json;q=0.9, */*;q=0.8';
}

async function fetchJson(url, token) {
  const response = await openResponse(url, token, 0, jsonAcceptHeader());
  const chunks = [];
  await new Promise((resolve, reject) => {
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('error', reject);
    response.on('end', resolve);
  });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (error) { throw new Error(`Invalid JSON downloaded from ${url}: ${error.message}`); }
}

let coreMetadataCache;
let coreMetadataLoadedAt = 0;
async function loadCoreMetadata(_context, token, force = false) {
  if (!force && coreMetadataCache && Date.now() - coreMetadataLoadedAt < 15 * 60 * 1000) return coreMetadataCache;
  const parsed = await fetchJson(CORE_METADATA_URL, token);
  const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.packages) ? parsed.packages : []);
  coreMetadataCache = items;
  coreMetadataLoadedAt = Date.now();
  return items;
}

let latestSdkCache;
let latestSdkLoadedAt = 0;
async function latestMikroSdkRelease(token, force = false) {
  if (!force && latestSdkCache && Date.now() - latestSdkLoadedAt < 10 * 60 * 1000) return latestSdkCache;
  const release = await fetchJson(MIKROSDK_LATEST_API, token);
  const tag = String(release?.tag_name || '').trim();
  if (!tag) throw new Error('Latest mikroSDK GitHub release has no tag_name.');
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const sdkAsset = assets.find((asset) => /^mikrosdk\.7z$/i.test(String(asset?.name || '')));
  latestSdkCache = { tag, version: tag.replace(/^mikroSDK[-_]?/i, '').replace(/^v/i, ''), assets, sdkUrl: sdkAsset?.browser_download_url || `https://github.com/MikroElektronika/mikrosdk_v2/releases/download/${encodeURIComponent(tag)}/mikrosdk.7z` };
  latestSdkLoadedAt = Date.now();
  return latestSdkCache;
}

function coreInstallRelativePath(metadata) {
  const location = String(metadata?.install_location || '').replace(/\\\\/g, '/');
  const marker = '/packages/core/';
  const index = location.toLowerCase().indexOf(marker);
  const relative = index >= 0 ? location.slice(index + marker.length) : '';
  return relative ? `core/${relative}` : `core/${safeName(metadata?.name)}`;
}

async function corePackageSpec(context, packageName, compilerUid, token) {
  const items = await loadCoreMetadata(context, token);
  const metadata = items.find((item) => String(item?.name || '') === String(packageName || ''));
  if (!metadata) throw new Error(`Core package '${packageName}' is not present in core_packages metadata.`);
  if (compilerUid && Array.isArray(metadata.compilers) && metadata.compilers.length) {
    const expected = compilerSupport.coreMetadataCompilerLabel(compilerUid);
    if (expected) {
      const compatible = metadata.compilers.some((value) => String(value || '').trim().toLowerCase() === expected.toLowerCase());
      if (!compatible) {
        throw new Error(`Core package '${packageName}' metadata does not list ${expected} (${compilerUid}) as a compatible compiler.`);
      }
    }
  }
  const releaseTag = String(metadata.release_tag || '').trim();
  if (!releaseTag) throw new Error(`Core package '${packageName}' has no release_tag in metadata.`);
  return {
    kind: 'core',
    name: packageName,
    version: String(metadata.version || 'current'),
    displayName: metadata.display_name || packageName,
    environment: false,
    compilerUid,
    installRelativePath: coreInstallRelativePath(metadata),
    downloadUrl: `https://github.com/MikroElektronika/core_packages/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(packageName)}.7z`,
    metadata
  };
}


async function compilerPackageSpec(context, compilerOrGroup, token) {
  const installerPackage = String(compilerOrGroup?.installerPackage || compilerOrGroup?.packageName || compilerOrGroup?.name || '').trim();
  if (!installerPackage) throw new Error('Compiler row does not define Compilers.installer_package.');
  const asset = compilerSupport.compilerAsset(installerPackage);
  if (!asset?.url) {
    throw new Error(`No managed compiler download is defined for ${installerPackage} on ${process.platform}/${process.arch}.`);
  }
  const compilerUids = Array.isArray(compilerOrGroup?.compilerUids)
    ? compilerOrGroup.compilerUids
    : [compilerOrGroup?.uid].filter(Boolean);
  const displayName = compilerOrGroup?.displayName || compilerOrGroup?.name || installerPackage;
  const toolchainBinaries = Array.isArray(compilerOrGroup?.binaryPaths)
    ? compilerOrGroup.binaryPaths
    : [compilerOrGroup?.cCompiler, compilerOrGroup?.cxxCompiler, compilerOrGroup?.asmCompiler, compilerOrGroup?.gdbPath]
        .map((value) => String(value || '').trim()).filter(Boolean);
  return {
    kind: 'toolchain',
    name: installerPackage,
    version: String(asset.version || compilerOrGroup?.version || 'current'),
    displayName,
    environment: false,
    compilerUid: compilerUids.join(', '),
    compilerUids,
    toolchainBinaries,
    installRelativePath: asset.installRelativePath || `compilers/${safeName(installerPackage)}`,
    downloadUrl: asset.url,
    detail: compilerOrGroup?.supportedDeviceCount !== undefined
      ? `${compilerOrGroup.supportedDeviceCount} SDK-supported device mapping(s); ${compilerOrGroup.mappedDeviceCount || compilerOrGroup.supportedDeviceCount || 0} total mapping(s).`
      : undefined
  };
}

async function sdkPackageSpec(token) {
  const release = await latestMikroSdkRelease(token);
  return { kind: 'sdk', name: 'mikrosdk', version: 'latest', resolvedVersion: release.version, displayName: `mikroSDK ${release.version}`, environment: true, downloadUrl: release.sdkUrl, installRelativePath: 'sdk/mikrosdk' };
}

async function bspPackageSpec(kind, item, token) {
  const release = await latestMikroSdkRelease(token);
  const name = String(item?.name || '').trim();
  if (!name) throw new Error('BSP package has no name.');
  const asset = release.assets.find((candidate) => String(candidate?.name || '').toLowerCase() === `${name}.7z`.toLowerCase());
  if (!asset?.browser_download_url) throw new Error(`BSP package '${name}.7z' is not present in the latest mikroSDK release (${release.tag}).`);
  const downloadUrl = asset.browser_download_url;
  const mcuName = kind === 'bsp-card' ? String(item?.mcuName || '').trim() : '';
  if (kind === 'bsp-card' && !mcuName) throw new Error(`MCU-card package '${name}' has no MCU_NAME in Devices.sdk_config.`);
  return {
    kind,
    name,
    version: 'latest',
    resolvedVersion: release.version,
    displayName: item.displayName || name,
    environment: false,
    downloadUrl,
    folderName: item.folderName,
    mcuName: mcuName || undefined,
    deviceUid: item.deviceUid,
    boardUid: item.boardUid,
    detail: mcuName ? `MCU: ${mcuName}` : undefined,
    // MCU-card packages are installed into an MCU-specific leaf. Multiple MCU
    // variants can therefore coexist under the same package directory and an
    // uninstall removes only the selected MCU_NAME payload.
    installRelativePath: kind === 'bsp-card'
      ? `${kind}/${safeName(name)}/${safeName(mcuName)}`
      : `${kind}/${safeName(name)}`
  };
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

function makeManagedToolchainExecutables(root, spec) {
  if (process.platform === 'win32' || String(spec?.kind || '').toLowerCase() !== 'toolchain' || !root || !fs.existsSync(root)) return;
  const requested = Array.isArray(spec.toolchainBinaries) ? spec.toolchainBinaries : [];
  const candidates = new Set();
  for (const relativeRaw of requested) {
    const relative = String(relativeRaw || '').replace(/[\\/]+/g, path.sep).replace(/^[/\\]+/, '');
    if (!relative) continue;
    const direct = path.join(root, relative);
    if (fs.existsSync(direct)) candidates.add(direct);
    const base = path.basename(relative);
    if (base) {
      const found = findRecursive(root, (_candidate, name) => name === base, 8);
      if (found) candidates.add(found);
    }
  }
  // Some compiler package rows (notably mikroC) store only the logical
  // executable name in c_compiler. If the archive wraps the payload in an
  // extra directory, the recursive lookup above still finds it.
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) fs.chmodSync(candidate, 0o755);
    } catch {}
  }
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
    if (String(spec.kind || '').toLowerCase() === 'bsp-card') {
      const cardHeader = findRecursive(source, (_candidate, fileName) => fileName.toLowerCase() === 'mcu_card.h', 10)
        || findRecursive(extractRoot, (_candidate, fileName) => fileName.toLowerCase() === 'mcu_card.h', 10);
      if (!cardHeader) throw new Error(`MCU-card BSP '${spec.name}' does not contain mcu_card.h.`);
      const normalizedCard = path.join(operationRoot, 'normalized-card');
      fs.rmSync(normalizedCard, { recursive: true, force: true });
      fs.mkdirSync(normalizedCard, { recursive: true });
      // Keep any sibling files that belong to this MCU-card payload, but strip
      // archive wrapper / board/include/mcu_cards directories from the cache.
      fs.cpSync(path.dirname(cardHeader), normalizedCard, { recursive: true, force: true });
      source = normalizedCard;
    }
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
    if (String(spec.kind || '').toLowerCase() === 'bsp-card') {
      // Migrate the pre-0.7.3 unscoped cache (<package>/payload...) to the new
      // <package>/<MCU_NAME>/ layout. Existing 0.7.3 MCU siblings are preserved.
      const migrationRegistry = readRegistry(context);
      const legacyKey = legacyPackageKey(spec);
      const legacy = migrationRegistry.packages.find((item) => item.key === legacyKey);
      if (legacy) {
        const packageParent = path.dirname(target);
        const siblingRoots = migrationRegistry.packages
          .filter((item) => item.key !== legacyKey && item.kind === spec.kind && item.name === spec.name && item.root)
          .map((item) => path.resolve(item.root))
          .filter((root) => path.dirname(root) === path.resolve(packageParent) && fs.existsSync(root));
        if (!siblingRoots.length && path.resolve(legacy.root || '') === path.resolve(packageParent)) {
          fs.rmSync(packageParent, { recursive: true, force: true });
        }
        migrationRegistry.packages = migrationRegistry.packages.filter((item) => item.key !== legacyKey);
        writeRegistry(context, migrationRegistry);
      }
    }
    await replaceDirectory(source, target);
    makeManagedToolchainExecutables(target, spec);
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
      version: spec.resolvedVersion || resolved.version || spec.version || '',
      environment: Boolean(spec.environment),
      root: target,
      sourceUrl: resolved.downloadUrl,
      folderName: spec.folderName,
      mcuName: spec.mcuName,
      deviceUid: spec.deviceUid,
      boardUid: spec.boardUid,
      installedAt: new Date().toISOString()
    };
    registry.packages = registry.packages.filter((item) => item.key === key || path.resolve(item.root || '') !== path.resolve(target));
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
  const versionMatches = installed && (!spec.version || spec.version === 'latest' || !installed.version || installed.version === spec.version);
  if (versionMatches && !spec.alwaysRefresh) {
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
      const sourceSensitive = ['sdk','core','bsp-card','bsp-board'].includes(String(spec.kind || '').toLowerCase()) || Boolean(spec.downloadUrl);
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
  const references = [];
  const setupRoot = getPackagePaths(context).setups;
  if (fs.existsSync(setupRoot)) {
    for (const name of fs.readdirSync(setupRoot)) {
      const setupPath = path.join(setupRoot, name, 'setup.json');
      if (!fs.existsSync(setupPath)) continue;
      try {
        const setup = JSON.parse(fs.readFileSync(setupPath, 'utf8'));
        if (Array.isArray(setup.packageKeys) && setup.packageKeys.includes(packageEntry.key)) {
          references.push(setup.name || setup.id || name);
        }
      } catch {
        // An invalid C setup is reported by the setup workflow, not package listing.
      }
    }
  }

  // Programmer packages are shared by both language environments. Protect
  // packages referenced by Rust CODEGRIP setups as well as C setups.
  const rustRegistry = path.join(getManagedRoot(context), 'configured-setups', 'setups.json');
  if (fs.existsSync(rustRegistry)) {
    try {
      const registry = JSON.parse(fs.readFileSync(rustRegistry, 'utf8'));
      for (const setup of Array.isArray(registry.setups) ? registry.setups : []) {
        const keys = [];
        if (/codegrip/i.test(`${setup.programmerUid || ''} ${setup.programmerName || ''}`)) {
          keys.push('programmer:codegrip_gdb_server@1.7.0');
          for (const pkg of setup.codegripCatalog?.packages || []) {
            keys.push(`programmer-pack:${pkg.packageName}@${pkg.packageVersion || 'current'}`);
          }
        }
        if (keys.includes(packageEntry.key)) references.push(`Rust: ${setup.mcuName || setup.id}`);
      }
    } catch {
      // Ignore an invalid Rust registry here; Rust setup loading reports it.
    }
  }
  return [...new Set(references)];
}

function resolvedBspMetadata(context, entry) {
  if (!/^bsp-(?:card|board)$/i.test(String(entry?.kind || ''))) return entry || {};
  const result = { ...(entry || {}) };
  if (result.folderName && (result.kind !== 'bsp-card' || result.mcuName)) return result;
  try {
    const db = require('./c_database');
    const candidates = result.kind === 'bsp-card'
      ? db.listCardInstallerPackages(context)
      : db.listBoardInstallerPackages(context);
    const match = candidates.find((item) => {
      if (String(item.name || '') !== String(result.name || '')) return false;
      if (result.deviceUid && item.deviceUid) return String(item.deviceUid) === String(result.deviceUid);
      if (result.boardUid && item.boardUid) return String(item.boardUid) === String(result.boardUid);
      return true;
    });
    if (match) Object.assign(result, match);
  } catch {
    // The database may itself be the package being removed. Registry metadata
    // is sufficient for packages installed by 0.7.3 and newer.
  }
  return result;
}

function managedSdkBspRoots(context, registry) {
  const roots = new Set();
  const sdkEntries = (registry?.packages || []).filter((item) => item.kind === 'sdk' && item.root);
  sdkEntries.push({ root: path.join(getPackagePaths(context).packages, 'sdk', 'mikrosdk') });
  for (const sdk of sdkEntries) {
    for (const candidate of [path.join(sdk.root, 'src', 'bsp'), path.join(sdk.root, 'bsp')]) {
      if (fs.existsSync(candidate)) roots.add(path.resolve(candidate));
    }
  }
  return [...roots];
}

function removeEmptyDirectory(directory) {
  try {
    if (fs.existsSync(directory) && fs.statSync(directory).isDirectory() && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  } catch {
    // Empty-parent cleanup is cosmetic; the actual payload removal is verified.
  }
}

function invalidateReferencingSetupArtifacts(context, entry) {
  const setupRoot = getPackagePaths(context).setups;
  if (!fs.existsSync(setupRoot)) return;
  for (const name of fs.readdirSync(setupRoot)) {
    const directory = path.join(setupRoot, name);
    const setupPath = path.join(directory, 'setup.json');
    if (!fs.existsSync(setupPath)) continue;
    let setup;
    try {
      setup = JSON.parse(fs.readFileSync(setupPath, 'utf8'));
    } catch {
      // Invalid setup JSON is reported by the normal setup loader.
      continue;
    }
    if (!(setup.packageKeys || []).includes(entry.key)) continue;
    for (const child of ['build', 'install', 'generated', 'codegrip', 'FileStartup', 'FileLinker']) {
      fs.rmSync(path.join(directory, child), { recursive: true, force: true });
    }
    delete setup.builtAt;
    delete setup.paths;
    delete setup.tools;
    delete setup.sdkDriverPackages;
    delete setup.codegripRuntime;
    const temporary = `${setupPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(setup, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, setupPath);
  }
}

function removeMaterializedPackageArtifacts(context, entry, registry) {
  const metadata = resolvedBspMetadata(context, entry);
  if (metadata.kind === 'bsp-board' && metadata.folderName) {
    for (const bspRoot of managedSdkBspRoots(context, registry)) {
      fs.rmSync(path.join(bspRoot, 'board', 'include', 'boards', String(metadata.folderName).toLowerCase()), { recursive: true, force: true });
    }
  }
  if (metadata.kind === 'bsp-card' && metadata.folderName) {
    const folderName = String(metadata.folderName).toLowerCase();
    const mcuName = String(metadata.mcuName || '').trim();
    for (const bspRoot of managedSdkBspRoots(context, registry)) {
      const cardRoot = path.join(bspRoot, 'board', 'include', 'mcu_cards', folderName);
      if (mcuName) fs.rmSync(path.join(cardRoot, mcuName), { recursive: true, force: true });
      // 0.7.2 materialized a flat header here. 0.7.3 uses only MCU_NAME
      // subdirectories, so remove the obsolete file during any card uninstall.
      fs.rmSync(path.join(cardRoot, 'mcu_card.h'), { force: true });
      removeEmptyDirectory(cardRoot);
    }
  }

  // Every package type can contribute generated files to a setup's build or
  // install prefix. Keep the setup selection itself, but invalidate/remove its
  // generated artifacts so an uninstalled package cannot remain usable from a
  // stale setup cache.
  invalidateReferencingSetupArtifacts(context, entry);
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
  // Remove copies/materializations first while registry metadata is still
  // available, then remove the package's managed root itself.
  removeMaterializedPackageArtifacts(context, entry, registry);
  fs.rmSync(target, { recursive: true, force: true });
  if (fs.existsSync(target)) {
    throw new Error(`Package files are still present after uninstall: ${target}`);
  }
  registry.packages = registry.packages.filter((item) => item.key !== key);
  writeRegistry(context, registry);
  // Clean empty per-package parents without ever climbing above packages/.
  removeEmptyDirectory(path.dirname(target));
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
    { kind: 'database', name: 'C_database', version: 'live', displayName: 'NECTO live database', environment: true, alwaysRefresh: true },
    { kind: 'sdk', name: 'mikrosdk', version: 'latest', displayName: 'mikroSDK (latest)', environment: true, dynamic: 'sdk' },
    ...infrastructureSpecs()
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

function managerDescriptor(kind) {
  if (kind === 'environment') return { title: 'C Development Environment', subtitle: 'Shared C runtime components. MCU cores and BSPs are installed separately and only when needed.' };
  if (kind === 'compiler') return { title: 'Compiler Packages', subtitle: 'Compiler toolchains from the NECTO Compilers table. Compatibility is determined by CompilerToDevice and per-compiler core package mappings.' };
  if (kind === 'core') return { title: 'MCU Core Packages', subtitle: 'Per-MCU compiler core packages referenced by Devices.installer_package.' };
  if (kind === 'card') return { title: 'MCU Card BSP Packages', subtitle: 'MCU-card BSP packages referenced by Devices.installer_package.' };
  if (kind === 'board') return { title: 'Board BSP Packages', subtitle: 'Board BSP packages referenced by Boards.installer_package.' };
  if (kind === 'codegrip') return { title: 'CODEGRIP Packages', subtitle: 'Installed CODEGRIP GDB server and MCU-specific device packs used by C or Rust setups.' };
  return { title: 'Programmer Packages', subtitle: 'Programmer support packages referenced by the database.' };
}

function cManagerHtml(kind) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const env = kind === 'environment';
  const descriptor = managerDescriptor(kind);
  const managerButtons = env
    ? '<button data-manager="compiler" class="secondary">Compiler packages</button><button data-manager="programmers" class="secondary">Programmers</button><button data-manager="codegrip" class="secondary">CODEGRIP packages</button><button data-manager="core" class="secondary">Core packages</button><button data-manager="card" class="secondary">MCU card packages</button><button data-manager="board" class="secondary">Board packages</button>'
    : '<button id="back" class="secondary">Back</button>';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>${descriptor.title}</title><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:1180px;margin:auto}header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap}.muted{color:var(--vscode-descriptionForeground)}.actions{display:flex;gap:8px;flex-wrap:wrap}button{border:0;border-radius:3px;padding:7px 12px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}button.danger{background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder)}button:disabled{opacity:.5;cursor:default}.summary{display:flex;gap:14px;margin-top:20px;align-items:center}.summary span,.summary .filterChip{padding:5px 9px;border:1px solid var(--vscode-panel-border);border-radius:999px}.summary .filterChip{color:var(--vscode-foreground);background:transparent}.summary .filterChip.active{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-color:var(--vscode-focusBorder)}.grid{display:grid;gap:10px;margin-top:20px}.card{border:1px solid var(--vscode-panel-border);border-left:3px solid var(--vscode-disabledForeground);border-radius:7px;padding:13px;display:flex;align-items:center;justify-content:space-between;gap:18px}.card.installed{border-left-color:var(--vscode-testing-iconPassed)}.card.update{border-left-color:var(--vscode-editorWarning-foreground)}.card.missing{border-left-color:var(--vscode-testing-iconFailed)}h1,h3{margin:0}.meta{display:flex;gap:8px;flex-wrap:wrap;color:var(--vscode-descriptionForeground);font-size:12px;margin-top:5px}code{font-family:var(--vscode-editor-font-family);word-break:break-all;font-size:11px}.empty{padding:32px;border:1px dashed var(--vscode-panel-border);text-align:center;border-radius:8px}.refs{color:var(--vscode-descriptionForeground);font-size:11px;margin-top:7px}.search{margin-top:18px;width:100%;box-sizing:border-box;padding:8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}
</style></head><body><header><div><h1>${descriptor.title}</h1><p class="muted">${descriptor.subtitle}</p></div><div class="actions">${env ? '<button id="installAll">Install shared environment</button>' : ''}${managerButtons}<button id="refresh" class="secondary">Refresh</button></div></header><section class="summary"><button id="installedCount" class="filterChip" title="Show only packages already installed locally">0 installed</button><span id="missingCount">0 missing</span></section><input id="search" class="search" placeholder="Filter packages…"><main id="packages" class="grid"></main>
<script nonce="${nonce}">const vscode=acquireVsCodeApi();const root=document.getElementById('packages');const installedChip=document.getElementById('installedCount');let all=[];let installedOnly=false;function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}function isInstalled(p){return p.status==='installed'||p.status==='update';}function render(){const q=document.getElementById('search').value.toLowerCase();const installed=all.filter(isInstalled).length;const items=all.filter(x=>(!installedOnly||isInstalled(x))&&JSON.stringify(x).toLowerCase().includes(q));installedChip.textContent=installedOnly?installed+' installed · showing only':installed+' installed';installedChip.classList.toggle('active',installedOnly);installedChip.setAttribute('aria-pressed',String(installedOnly));document.getElementById('missingCount').textContent=(all.length-installed)+' not installed';if(!items.length){root.innerHTML='<div class="empty">'+(installedOnly?'No installed packages match this filter.':'No matching packages.')+'</div>';return;}root.innerHTML=items.map(p=>{const refs=p.references||[];const action=p.unavailable?'<button disabled>Unavailable</button>':(p.external?'<button data-open="'+esc(p.externalUrl||'')+'">Open download page</button>':(p.status==='installed'?'<button class="danger" data-uninstall="'+esc(p.key)+'">Uninstall</button>':'<button data-install="'+esc(p.key)+'">'+(p.status==='update'?'Update':'Install')+'</button>'));return '<article class="card '+esc(p.status||'missing')+'"><div><h3>'+esc(p.displayName||p.name)+'</h3><div class="meta"><span>'+esc(p.kind)+'</span><span>'+esc(p.version||'')+'</span><span>'+esc(p.status||'missing')+'</span>'+(p.compilerUid?'<span>'+esc(p.compilerUid)+'</span>':'')+'</div><p><code>'+esc(p.root||p.installRelativePath||'')+'</code></p>'+(p.detail?'<div class="refs">'+esc(p.detail)+'</div>':'')+(refs.length?'<div class="refs">Used by setup: '+esc(refs.join(', '))+'</div>':'')+'</div><div class="actions">'+action+'</div></article>';}).join('');}root.onclick=e=>{const u=e.target?.dataset?.uninstall;if(u){vscode.postMessage({type:'uninstall',key:u});return;}const i=e.target?.dataset?.install;if(i){vscode.postMessage({type:'install',key:i});return;}const o=e.target?.dataset?.open;if(o)vscode.postMessage({type:'openExternal',url:o});const m=e.target?.dataset?.manager;if(m)vscode.postMessage({type:'manager',manager:m});};document.getElementById('search').oninput=render;installedChip.onclick=()=>{installedOnly=!installedOnly;render();};document.getElementById('refresh').onclick=()=>vscode.postMessage({type:'refresh'});${env ? "document.getElementById('installAll').onclick=()=>vscode.postMessage({type:'installAll'});document.querySelectorAll('[data-manager]').forEach(x=>x.onclick=()=>vscode.postMessage({type:'manager',manager:x.dataset.manager}));" : "document.getElementById('back').onclick=()=>vscode.postMessage({type:'back'});"}window.addEventListener('message',e=>{if(e.data?.type==='state'){all=e.data.items||[];render();}});vscode.postMessage({type:'ready'});</script></body></html>`;
}

function packageStateFromSpecs(context, specs) {
  const installedAll = listInstalledPackages(context, true);
  return specs.map((spec) => {
    const exact = getInstalledPackage(context, spec);
    const same = installedAll.find((item) => {
      if (item.kind !== spec.kind || item.name !== spec.name) return false;
      if (String(spec.kind || '').toLowerCase() !== 'bsp-card') return true;
      const installedMcu = String(item.mcuName || '').trim();
      const requestedMcu = String(spec.mcuName || '').trim();
      // Legacy 0.7.2 entries have no mcuName and should be offered as an
      // update/migration. 0.7.3 scoped entries only match their own MCU.
      return !installedMcu || installedMcu === requestedMcu;
    });
    const resolvedChanged = Boolean(exact && spec.resolvedVersion && exact.version && String(exact.version) !== String(spec.resolvedVersion));
    const sourceChanged = Boolean(exact && spec.downloadUrl && exact.sourceUrl && String(exact.sourceUrl) !== String(spec.downloadUrl));
    const status = exact ? ((spec.alwaysRefresh || resolvedChanged || sourceChanged) ? 'update' : 'installed') : (same ? 'update' : 'missing');
    return { ...spec, key: packageKey(spec), status, root: exact?.root || same?.root || packageTarget(context, spec), sourceUrl: exact?.sourceUrl || same?.sourceUrl || spec.downloadUrl || '', references: same ? setupReferences(context, same) : [] };
  });
}

async function availableManagerSpecs(context, kind, token) {
  const db = require('./c_database');
  if (kind === 'environment') {
    const result = [];
    for (const spec of environmentSpecs()) result.push(spec.dynamic === 'sdk' ? await sdkPackageSpec(token) : spec);
    return result;
  }
  if (kind === 'compiler') {
    const result = [];
    for (const item of db.listCompilerInstallerPackages(context)) {
      try { result.push(await compilerPackageSpec(context, item, token)); }
      catch (error) {
        result.push({ kind:'toolchain', name:item.name, version:item.databaseVersions?.[0] || 'unavailable', displayName:item.displayName || item.name, unavailable:true, detail:error.message, compilerUid:(item.compilerUids || []).join(', ') });
      }
    }
    return result;
  }
  if (kind === 'core') {
    const requirements = db.listCoreInstallerPackages(context);
    const unique = new Map();
    for (const item of requirements) {
      if (unique.has(item.name)) continue;
      try { unique.set(item.name, await corePackageSpec(context, item.name, item.compilerUid, token)); }
      catch (error) { unique.set(item.name, { kind:'core', name:item.name, version:'unresolved', displayName:item.name, unavailable:true, external:true, detail:error.message }); }
    }
    return [...unique.values()];
  }
  if (kind === 'card') {
    const unique = new Map();
    for (const item of db.listCardInstallerPackages(context)) {
      const identity = `${item.name}:${item.mcuName || item.deviceUid || ''}`;
      if (unique.has(identity)) continue;
      try { unique.set(identity, await bspPackageSpec('bsp-card', item, token)); }
      catch (error) { unique.set(identity, { kind:'bsp-card', name:item.name, version:'unavailable', displayName:item.displayName || item.name, unavailable:true, detail:error.message, folderName:item.folderName, mcuName:item.mcuName, deviceUid:item.deviceUid }); }
    }
    return [...unique.values()];
  }
  if (kind === 'board') {
    const unique = new Map();
    for (const item of db.listBoardInstallerPackages(context)) {
      if (unique.has(item.name)) continue;
      try { unique.set(item.name, await bspPackageSpec('bsp-board', item, token)); }
      catch (error) { unique.set(item.name, { kind:'bsp-board', name:item.name, version:'unavailable', displayName:item.displayName || item.name, unavailable:true, detail:error.message, folderName:item.folderName }); }
    }
    return [...unique.values()];
  }
  if (kind === 'codegrip') {
    return listInstalledPackages(context, true)
      .filter((entry) => entry.kind === 'programmer-pack' || (entry.kind === 'programmer' && entry.name === 'codegrip_gdb_server'))
      .map((entry) => ({
        kind: entry.kind,
        name: entry.name,
        version: entry.version || '',
        displayName: entry.displayName || (entry.kind === 'programmer-pack' ? `CODEGRIP MCU pack: ${entry.name}` : 'CODEGRIP Suite'),
        detail: entry.kind === 'programmer-pack' ? 'MCU-specific CODEGRIP device pack installed on demand.' : 'CODEGRIP GDB server.'
      }));
  }
  return db.listProgrammerInstallerPackages(context).map((item) => {
    const packageName = String(item.installerPackage || '').trim();
    if (item.uid === 'segger_jlink' && !packageName) return { kind:'programmer', name:'segger_jlink', version:'external', displayName:item.name, external:true, externalUrl:'https://www.segger.com/downloads/jlink/', detail:item.description };
    if (!packageName) return { kind:'programmer', name:item.uid, version:'external', displayName:item.name, external:true, detail:item.description || 'No installer package is defined in the database.' };
    if (item.uid === 'codegrip') return { kind:'programmer', name:'codegrip_gdb_server', version:'1.7.0', displayName:item.name, environment:false };
    return { kind:'programmer', name:packageName, version:'general_packages_assets', displayName:item.name, environment:false, downloadUrl:`https://github.com/MikroElektronika/general_packages/releases/download/general_packages_assets/${encodeURIComponent(packageName)}.7z`, detail:item.description };
  });
}

async function postManagerState(context, kind, panel) {
  if (!panel) return;
  const specs = await availableManagerSpecs(context, kind, undefined);
  const items = packageStateFromSpecs(context, specs).map((item) => {
    return item;
  });
  void panel.webview.postMessage({ type:'state', items });
}

async function installManagerPackage(context, kind, key) {
  await vscode.window.withProgress({ location:vscode.ProgressLocation.Notification, title:'Installing C package', cancellable:true }, async (progress, token) => {
    const specs = await availableManagerSpecs(context, kind, token);
    const spec = specs.find((item) => packageKey(item) === key);
    if (!spec) throw new Error(`Package '${key}' is no longer available.`);
    if (spec.external || spec.unavailable) throw new Error(`${spec.displayName || spec.name} is externally installed and cannot be downloaded by the extension.`);
    await ensurePackage(context, spec, progress, token);
  });
}

async function showEnvironmentPackageView(context, kind = 'environment') {
  if (!environmentPanel) return;
  environmentViewKind = ['environment', 'compiler', 'programmers', 'codegrip', 'core', 'card', 'board'].includes(kind)
    ? kind
    : 'environment';
  const descriptor = managerDescriptor(environmentViewKind);
  environmentPanel.title = `MikroBUS C: ${descriptor.title}`;
  environmentPanel.webview.html = cManagerHtml(environmentViewKind);
}

async function openPackageManager(context, kind) {
  return openEnvironmentPackages(context, kind);
}

async function installAllEnvironmentPackages(context) {
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Installing MikroBUS C development environment', cancellable: true }, async (progress, token) => {
    const specs = [];
    for (const spec of environmentSpecs()) specs.push(spec.dynamic === 'sdk' ? await sdkPackageSpec(token) : spec);
    await ensurePackages(context, specs, progress, token);
  });
}

async function openCompilerPackages(context){return openPackageManager(context,'compiler');}
async function openProgrammerPackages(context){return openPackageManager(context,'programmers');}
async function openCodegripPackages(context){return openPackageManager(context,'codegrip');}
async function openCorePackages(context){return openPackageManager(context,'core');}
async function openCardPackages(context){return openPackageManager(context,'card');}
async function openBoardPackages(context){return openPackageManager(context,'board');}

async function openEnvironmentPackages(context, initialKind = 'environment') {
  if (environmentPanel) {
    environmentPanel.reveal(vscode.ViewColumn.Active);
    await showEnvironmentPackageView(context, initialKind);
    return;
  }
  environmentPanel=vscode.window.createWebviewPanel('mikrobusC.environmentPackages','MikroBUS C: Development Environment',vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true});
  environmentPanel.webview.onDidReceiveMessage(async(message)=>{try{
    const activeKind = environmentViewKind;
    if(message?.type==='ready'||message?.type==='refresh')await postManagerState(context,activeKind,environmentPanel);
    if(message?.type==='installAll'){
      await installAllEnvironmentPackages(context);
      await postManagerState(context,activeKind,environmentPanel);
    }
    if(message?.type==='install'&&typeof message.key==='string'){
      await installManagerPackage(context,activeKind,message.key);
      await postManagerState(context,activeKind,environmentPanel);
    }
    if(message?.type==='uninstall'&&typeof message.key==='string'){
      if(await uninstallPackage(context,message.key))await postManagerState(context,activeKind,environmentPanel);
    }
    if(message?.type==='openExternal'&&message.url)await vscode.env.openExternal(vscode.Uri.parse(message.url));
    if(message?.type==='manager'&&typeof message.manager==='string')await showEnvironmentPackageView(context,message.manager);
    if(message?.type==='back')await showEnvironmentPackageView(context,'environment');
  }catch(error){vscode.window.showErrorMessage(`MikroBUS C ${environmentViewKind} packages: ${error.message||error}`);}},null,context.subscriptions);
  environmentPanel.onDidDispose(()=>{environmentPanel=undefined;environmentViewKind='environment';},null,context.subscriptions);
  await showEnvironmentPackageView(context, initialKind);
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
  openCompilerPackages,
  openProgrammerPackages,
  openCodegripPackages,
  openCorePackages,
  openCardPackages,
  openBoardPackages,
  uninstallPackage,
  infrastructureSpecs,
  environmentSpecs,
  environmentPackageState,
  installedProgrammerPackages,
  installAllEnvironmentPackages,
  findOnPath,
  loadCoreMetadata,
  latestMikroSdkRelease,
  corePackageSpec,
  compilerPackageSpec,
  sdkPackageSpec,
  bspPackageSpec,
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
    environmentSpecs,
    jsonAcceptHeader,
    findRecursive,
    makeManagedToolchainExecutables,
    resolvedBspMetadata,
    managedSdkBspRoots,
    removeMaterializedPackageArtifacts,
    invalidateReferencingSetupArtifacts
  }
};
