'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const childProcess = require('child_process');
const https = require('https');
const http = require('http');

const DEFAULT_REPOSITORY = 'IvanRuzavin/Rusty_MikroBUS';
const RELEASE_TAG = 'rust-bsp-packages';
const CATALOG_ASSET = 'rust_bsp_packages.json';
const PACKAGE_MARKER = '.rust-bsp-package.json';
const INSTALL_MARKER = '.rust-bsp-installed.json';
const CATALOG_CACHE_NAME = '.rust-bsp-packages-catalog.json';
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const CATALOG_SCHEMA_VERSION = 2;

let memoryCatalog;
let memoryCatalogRepository;
let memoryCatalogLoadedAt = 0;

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function getManagedRoot(context) {
  const configured = String(vscode.workspace.getConfiguration('mikrobusRust').get('storageRoot', '') || '').trim();
  return configured ? expandHome(configured) : context.globalStorageUri.fsPath;
}

function repositoryName() {
  const configured = String(
    vscode.workspace.getConfiguration('mikrobusRust').get('rustBspPackagesRepository', DEFAULT_REPOSITORY) || ''
  ).trim();
  return configured || DEFAULT_REPOSITORY;
}

function packagesRoot(context) {
  return path.join(getManagedRoot(context), 'rust-bsp-packages');
}

function packageInstallRoot(context, packageName) {
  return path.join(packagesRoot(context), packageName);
}

function catalogCachePath(context) {
  return path.join(packagesRoot(context), CATALOG_CACHE_NAME);
}

function releaseAssetUrl(repository, assetName) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(RELEASE_TAG)}/${encodeURIComponent(assetName)}`;
}

function ensureNotCancelled(token) {
  if (token?.isCancellationRequested) throw new Error('Rust BSP package installation cancelled.');
}

function normalizeEntityType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (!['board', 'card', 'shield'].includes(type)) {
    throw new Error(`Unsupported Rust BSP entity type '${value}'.`);
  }
  return type;
}

function requestBuffer(url, token, redirects = 0) {
  ensureNotCancelled(token);
  if (redirects > 10) return Promise.reject(new Error(`Too many redirects while downloading ${url}.`));

  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, {
      headers: {
        Accept: 'application/octet-stream, application/json;q=0.9, */*;q=0.8',
        'User-Agent': 'mikrobus-rust-vscode-extension'
      }
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolve(requestBuffer(new URL(response.headers.location, url).toString(), token, redirects + 1));
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`HTTP ${status} while downloading ${url}.`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.setTimeout(30000, () => request.destroy(new Error(`Connection timed out while downloading ${url}.`)));
    request.on('error', reject);
    const cancellation = token?.onCancellationRequested(() => request.destroy(new Error('Rust BSP package installation cancelled.')));
    request.on('close', () => cancellation?.dispose());
  });
}

async function downloadFile(url, destination, progress, token) {
  ensureNotCancelled(token);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });

  return new Promise((resolve, reject) => {
    const visit = (currentUrl, redirects) => {
      ensureNotCancelled(token);
      if (redirects > 10) {
        reject(new Error(`Too many redirects while downloading ${url}.`));
        return;
      }

      const client = currentUrl.startsWith('https:') ? https : http;
      const request = client.get(currentUrl, { headers: { 'User-Agent': 'mikrobus-rust-vscode-extension' } }, (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          visit(new URL(response.headers.location, currentUrl).toString(), redirects + 1);
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`HTTP ${status} while downloading ${currentUrl}.`));
          return;
        }

        const total = Number.parseInt(String(response.headers['content-length'] || '0'), 10) || 0;
        let received = 0;
        const stream = fs.createWriteStream(destination);
        response.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0 && progress) {
            progress.report({ message: `${path.basename(destination)} ${Math.round((received / total) * 100)}%` });
          }
        });
        response.pipe(stream);
        stream.on('finish', () => stream.close(resolve));
        stream.on('error', reject);
        response.on('error', reject);
      });
      request.setTimeout(30000, () => request.destroy(new Error(`Connection timed out while downloading ${currentUrl}.`)));
      request.on('error', reject);
      const cancellation = token?.onCancellationRequested(() => request.destroy(new Error('Rust BSP package installation cancelled.')));
      request.on('close', () => cancellation?.dispose());
    };
    visit(url, 0);
  });
}

function validateCatalog(data) {
  if (!data || data.schemaVersion !== CATALOG_SCHEMA_VERSION || data.packageModel !== 'entity' || !Array.isArray(data.packages)) {
    throw new Error(`${CATALOG_ASSET} has an unsupported or invalid schema.`);
  }

  const identities = new Set();
  for (const item of data.packages) {
    if (
      !item ||
      typeof item.name !== 'string' ||
      typeof item.asset !== 'string' ||
      typeof item.sha256 !== 'string' ||
      typeof item.entityType !== 'string' ||
      typeof item.uid !== 'string' ||
      typeof item.displayName !== 'string' ||
      typeof item.relativeBspPath !== 'string'
    ) {
      throw new Error(`${CATALOG_ASSET} contains an invalid package entry.`);
    }
    normalizeEntityType(item.entityType);
    if (!/^[0-9a-f]{64}$/i.test(item.sha256)) {
      throw new Error(`${CATALOG_ASSET}: invalid SHA-256 for ${item.name}.`);
    }
    const identity = `${item.entityType.toLowerCase()}\0${item.uid.toLowerCase()}`;
    if (identities.has(identity)) {
      throw new Error(`${CATALOG_ASSET}: duplicate ${item.entityType} UID '${item.uid}'.`);
    }
    identities.add(identity);
  }
  return data;
}

async function loadCatalog(context, token, options = {}) {
  const repository = repositoryName();
  if (
    !options.forceRefresh &&
    memoryCatalog &&
    memoryCatalogRepository === repository &&
    (Date.now() - memoryCatalogLoadedAt) < CATALOG_CACHE_TTL_MS
  ) {
    return memoryCatalog;
  }

  const cache = catalogCachePath(context);
  const url = releaseAssetUrl(repository, CATALOG_ASSET);
  try {
    const buffer = await requestBuffer(url, token);
    const catalog = validateCatalog(JSON.parse(buffer.toString('utf8')));
    await fs.promises.mkdir(path.dirname(cache), { recursive: true });
    await fs.promises.writeFile(cache, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    memoryCatalog = catalog;
    memoryCatalogRepository = repository;
    memoryCatalogLoadedAt = Date.now();
    return catalog;
  } catch (error) {
    if (fs.existsSync(cache)) {
      try {
        const catalog = validateCatalog(JSON.parse(fs.readFileSync(cache, 'utf8')));
        memoryCatalog = catalog;
        memoryCatalogRepository = repository;
        memoryCatalogLoadedAt = Date.now();
        return catalog;
      } catch {
        // Report the network/catalog error below.
      }
    }
    throw new Error(`Unable to load Rust BSP package catalog from ${url}: ${error?.message || error}`);
  }
}

function packageForEntity(catalog, entityType, uid) {
  const type = normalizeEntityType(entityType);
  const wanted = String(uid || '').trim().toLowerCase();
  if (!wanted) throw new Error(`Cannot resolve a Rust BSP ${type} package without a UID.`);

  const matches = catalog.packages.filter((item) =>
    String(item.entityType || '').toLowerCase() === type &&
    String(item.uid || '').toLowerCase() === wanted
  );
  if (matches.length === 0) {
    throw new Error(`No Rust BSP package is published for ${type} UID '${uid}'.`);
  }
  if (matches.length > 1) {
    throw new Error(`Rust BSP package catalog is ambiguous for ${type} UID '${uid}'.`);
  }
  return matches[0];
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function directoryHasContent(directory) {
  try {
    return fs.statSync(directory).isDirectory() && fs.readdirSync(directory).length > 0;
  } catch {
    return false;
  }
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function installedPackageMatches(target, spec) {
  if (!directoryHasContent(target)) return false;
  const marker = readJsonIfPresent(path.join(target, INSTALL_MARKER));
  return Boolean(
    marker &&
    marker.packageName === spec.name &&
    String(marker.entityType || '').toLowerCase() === String(spec.entityType || '').toLowerCase() &&
    String(marker.uid || '').toLowerCase() === String(spec.uid || '').toLowerCase() &&
    String(marker.sha256 || '').toLowerCase() === String(spec.sha256 || '').toLowerCase()
  );
}

function findExecutableOnPath(names) {
  for (const folder of String(process.env.PATH || '').split(path.delimiter)) {
    if (!folder) continue;
    for (const name of names) {
      const candidate = path.join(folder, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function sevenZipExecutable() {
  try {
    const bundled = require('7zip-bin').path7za;
    if (bundled && fs.existsSync(bundled)) {
      if (process.platform !== 'win32') {
        try { fs.chmodSync(bundled, 0o755); } catch {}
      }
      return bundled;
    }
  } catch {}

  const names = process.platform === 'win32' ? ['7zz.exe', '7z.exe', '7za.exe'] : ['7zz', '7z', '7za'];
  const found = findExecutableOnPath(names);
  if (!found) throw new Error('No bundled or system 7-Zip extractor was found.');
  return found;
}

function runProcess(executable, args, token) {
  ensureNotCancelled(token);
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${path.basename(executable)} exited with ${code}: ${output.trim()}`));
    });
    const cancellation = token?.onCancellationRequested(() => child.kill());
    child.on('close', () => cancellation?.dispose());
  });
}

async function extract7z(archive, destination, token) {
  await fs.promises.mkdir(destination, { recursive: true });
  await runProcess(sevenZipExecutable(), ['x', '-y', archive, `-o${destination}`], token);
}

async function replaceDirectory(source, target) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const backup = `${target}.mikrobus-backup-${Date.now()}`;
  const existed = fs.existsSync(target);
  if (existed) await fs.promises.rename(target, backup);
  try {
    await fs.promises.rename(source, target);
    if (existed) await fs.promises.rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (existed && fs.existsSync(backup)) await fs.promises.rename(backup, target).catch(() => {});
    throw error;
  }
}

async function installSpec(context, spec, progress, token, options = {}) {
  const target = packageInstallRoot(context, spec.name);
  if (!options.forceInstall && installedPackageMatches(target, spec)) {
    return { spec, root: target };
  }

  const tempRoot = path.join(
    getManagedRoot(context),
    '.install-temp',
    `rust-bsp-${spec.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const archive = path.join(tempRoot, spec.asset);
  const extractRoot = path.join(tempRoot, 'payload');
  await fs.promises.mkdir(tempRoot, { recursive: true });

  try {
    progress?.report({ message: `Downloading ${spec.displayName} BSP...` });
    await downloadFile(releaseAssetUrl(repositoryName(), spec.asset), archive, progress, token);
    const actual = await sha256File(archive);
    if (actual.toLowerCase() !== spec.sha256.toLowerCase()) {
      throw new Error(`SHA-256 mismatch for ${spec.asset}. Expected ${spec.sha256}, downloaded ${actual}.`);
    }

    progress?.report({ message: `Extracting ${spec.displayName} BSP...` });
    await extract7z(archive, extractRoot, token);
    let source = extractRoot;
    const nested = path.join(extractRoot, spec.name);
    if (directoryHasContent(nested) && fs.readdirSync(extractRoot).length === 1) source = nested;

    const marker = readJsonIfPresent(path.join(source, PACKAGE_MARKER));
    if (!marker) throw new Error(`${spec.asset} does not contain ${PACKAGE_MARKER}.`);
    if (
      marker.packageName !== spec.name ||
      String(marker.entityType || '').toLowerCase() !== String(spec.entityType || '').toLowerCase() ||
      String(marker.uid || '').toLowerCase() !== String(spec.uid || '').toLowerCase()
    ) {
      throw new Error(`${spec.asset} contains package metadata for a different BSP entity.`);
    }

    const payloadFile = path.join(source, spec.relativeBspPath);
    if (!fs.existsSync(payloadFile)) {
      throw new Error(`${spec.asset} does not contain required BSP file '${spec.relativeBspPath}'.`);
    }

    await replaceDirectory(source, target);
    await fs.promises.writeFile(
      path.join(target, INSTALL_MARKER),
      JSON.stringify({
        schemaVersion: CATALOG_SCHEMA_VERSION,
        packageName: spec.name,
        entityType: spec.entityType,
        uid: spec.uid,
        displayName: spec.displayName,
        bspPath: spec.bspPath,
        relativeBspPath: spec.relativeBspPath,
        sha256: spec.sha256,
        asset: spec.asset
      }, null, 2) + '\n',
      'utf8'
    );
    return { spec, root: target };
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function resolveEntitySpec(context, entityType, uid, token, options = {}) {
  let catalog = await loadCatalog(context, token, { forceRefresh: Boolean(options.forceCatalogRefresh) });
  try {
    return packageForEntity(catalog, entityType, uid);
  } catch (firstError) {
    if (options.forceCatalogRefresh) throw firstError;
    catalog = await loadCatalog(context, token, { forceRefresh: true });
    return packageForEntity(catalog, entityType, uid);
  }
}

async function ensureRustBspEntityPackage(context, entityType, uid, progress, token, options = {}) {
  const spec = await resolveEntitySpec(context, entityType, uid, token, options);
  return installSpec(context, spec, progress, token, options);
}

async function ensureRustBspSelection(context, selection, progress, token, options = {}) {
  const requests = [];
  if (selection?.boardUid) requests.push(['board', selection.boardUid]);
  if (selection?.mcuCardUid) requests.push(['card', selection.mcuCardUid]);
  if (selection?.shieldUid) requests.push(['shield', selection.shieldUid]);

  const result = { board: undefined, card: undefined, shield: undefined, packages: [] };
  for (const [entityType, uid] of requests) {
    ensureNotCancelled(token);
    const installed = await ensureRustBspEntityPackage(context, entityType, uid, progress, token, options);
    result[entityType] = installed;
    result.packages.push(installed);
  }
  return result;
}

function materializeRustBspSelection(selection, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });

  for (const installed of selection?.packages || []) {
    const relative = String(installed.spec.relativeBspPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relative || relative.split('/').some((segment) => segment === '..')) {
      throw new Error(`Invalid BSP package path '${installed.spec.relativeBspPath}' in ${installed.spec.name}.`);
    }
    const source = path.resolve(installed.root, relative);
    const target = path.resolve(destination, relative);
    if (!source.startsWith(path.resolve(installed.root) + path.sep)) {
      throw new Error(`Refusing to read outside installed BSP package ${installed.spec.name}.`);
    }
    if (!target.startsWith(path.resolve(destination) + path.sep)) {
      throw new Error(`Refusing to write outside temporary BSP overlay: ${relative}`);
    }
    if (!fs.existsSync(source)) {
      throw new Error(`Installed BSP package ${installed.spec.name} is missing ${relative}.`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }

  return destination;
}

function installedEntries(context) {
  const root = packagesRoot(context);
  if (!fs.existsSync(root)) return [];
  const entries = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const marker = readJsonIfPresent(path.join(root, item.name, INSTALL_MARKER));
    if (marker) entries.push({ ...marker, root: path.join(root, item.name) });
  }
  return entries;
}

function packageDetail(spec) {
  if (spec.entityType === 'board') {
    return `${spec.directMcuCount || 0} direct MCU(s), ${spec.cardCount || 0} MCU card(s), ${spec.shieldCount || 0} shield(s)`;
  }
  if (spec.entityType === 'card') {
    return `${spec.mcuCount || 0} MCU(s), used by ${spec.boardCount || 0} board(s)`;
  }
  return `Used by ${spec.boardCount || 0} board(s)`;
}

async function packageState(context, token) {
  let catalog;
  try {
    catalog = await loadCatalog(context, token);
  } catch {
    catalog = { packages: [] };
  }

  const installed = installedEntries(context);
  const installedMap = new Map(installed.map((item) => [String(item.packageName).toLowerCase(), item]));
  const items = catalog.packages.map((spec) => {
    const local = installedMap.get(spec.name.toLowerCase());
    return {
      key: spec.name,
      name: spec.name,
      displayName: spec.displayName,
      kind: 'rust-bsp',
      entityType: spec.entityType,
      uid: spec.uid,
      version: spec.sha256.slice(0, 12),
      status: local
        ? (String(local.sha256).toLowerCase() === String(spec.sha256).toLowerCase() ? 'installed' : 'update')
        : 'missing',
      root: local?.root || packageInstallRoot(context, spec.name),
      detail: packageDetail(spec)
    };
  });

  for (const local of installed) {
    if (items.some((item) => item.key.toLowerCase() === String(local.packageName).toLowerCase())) continue;
    const legacy = !local.entityType || !local.uid;
    items.push({
      key: local.packageName,
      name: local.packageName,
      displayName: local.displayName || local.packageName,
      kind: 'rust-bsp',
      entityType: local.entityType || 'legacy',
      uid: local.uid || '',
      version: String(local.sha256 || '').slice(0, 12),
      status: 'installed',
      root: local.root,
      detail: legacy
        ? 'Legacy per-SYSTEM_LIB BSP package. It can be safely uninstalled after switching to entity packages.'
        : 'Installed package is not present in the current catalog.'
    });
  }

  const order = { board: 0, card: 1, shield: 2, legacy: 3 };
  return items.sort((left, right) =>
    (order[left.entityType] ?? 9) - (order[right.entityType] ?? 9) ||
    String(left.displayName).localeCompare(String(right.displayName))
  );
}

async function installNamedPackage(context, name, progress, token) {
  const catalog = await loadCatalog(context, token);
  const spec = catalog.packages.find((item) => String(item.name).toLowerCase() === String(name).toLowerCase());
  if (!spec) throw new Error(`Rust BSP package '${name}' is not in the catalog.`);
  return installSpec(context, spec, progress, token, { forceInstall: true });
}

async function uninstallPackage(context, name) {
  const target = packageInstallRoot(context, name);
  const root = path.resolve(packagesRoot(context));
  const resolved = path.resolve(target);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to remove path outside Rust BSP package root: ${resolved}`);
  }
  await fs.promises.rm(resolved, { recursive: true, force: true });
  return true;
}

module.exports = {
  ensureRustBspEntityPackage,
  ensureRustBspSelection,
  materializeRustBspSelection,
  loadCatalog,
  packageForEntity,
  packagesRoot,
  packageInstallRoot,
  packageState,
  installNamedPackage,
  uninstallPackage,
  RELEASE_TAG,
  CATALOG_ASSET,
  _test: {
    validateCatalog,
    packageForEntity,
    installedPackageMatches,
    releaseAssetUrl,
    repositoryName,
    packageDetail
  }
};
