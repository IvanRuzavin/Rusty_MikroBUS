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
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

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

function requestBuffer(url, token, cancellationLabel, redirects = 0) {
  ensureNotCancelled(token, cancellationLabel);
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
        resolve(requestBuffer(new URL(response.headers.location, url).toString(), token, cancellationLabel, redirects + 1));
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
    const cancellation = token?.onCancellationRequested(() => request.destroy(new Error(cancellationLabel)));
    request.on('close', () => cancellation?.dispose());
  });
}

async function downloadFile(url, destination, progress, token, cancellationLabel) {
  ensureNotCancelled(token, cancellationLabel);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });

  return new Promise((resolve, reject) => {
    const visit = (currentUrl, redirects) => {
      ensureNotCancelled(token, cancellationLabel);
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
      const cancellation = token?.onCancellationRequested(() => request.destroy(new Error(cancellationLabel)));
      request.on('close', () => cancellation?.dispose());
    };
    visit(url, 0);
  });
}

function ensureNotCancelled(token, label) {
  if (token?.isCancellationRequested) throw new Error(label);
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

function findExecutableOnPath(names) {
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      for (const extension of extensions) {
        const candidate = path.join(directory, `${name}${extension}`);
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {}
      }
    }
  }
  return undefined;
}

function sevenZipExecutable() {
  try {
    const sevenZipBin = require('7zip-bin');
    if (sevenZipBin?.path7za && fs.existsSync(sevenZipBin.path7za)) return sevenZipBin.path7za;
    if (sevenZipBin?.path7x && fs.existsSync(sevenZipBin.path7x)) return sevenZipBin.path7x;
  } catch {}
  const fallback = findExecutableOnPath(process.platform === 'win32' ? ['7z', '7za'] : ['7zz', '7z', '7za']);
  if (!fallback) throw new Error('7-Zip executable is unavailable. Reinstall the extension package.');
  return fallback;
}

function runProcess(executable, args, token, cancellationLabel) {
  ensureNotCancelled(token, cancellationLabel);
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      cancellation?.dispose();
      if (code === 0) resolve(output);
      else reject(new Error(`${path.basename(executable)} exited with code ${code}.\n${output}`.trim()));
    });
    const cancellation = token?.onCancellationRequested(() => child.kill());
  });
}

async function extract7z(archive, destination, token, cancellationLabel) {
  await fs.promises.mkdir(destination, { recursive: true });
  await runProcess(sevenZipExecutable(), ['x', '-y', archive, `-o${destination}`], token, cancellationLabel);
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

function materializeRustBspPackages(installedPackages, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });

  for (const installed of installedPackages || []) {
    if (!installed) continue;
    const relative = String(installed.spec.relativeBspPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relative || relative.split('/').some((segment) => segment === '..')) {
      throw new Error(`Invalid BSP package path '${installed.spec.relativeBspPath}' in ${installed.spec.name}.`);
    }
    const root = path.resolve(installed.root);
    const source = path.resolve(installed.root, relative);
    const target = path.resolve(destination, relative);
    if (!source.startsWith(root + path.sep)) {
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

function createRustEntityPackageManager(config) {
  const allowedTypes = new Set(config.allowedEntityTypes.map((value) => String(value).toLowerCase()));
  let memoryCatalog;
  let memoryCatalogRepository;
  let memoryCatalogLoadedAt = 0;

  function normalizeEntityType(value) {
    const type = String(value || '').trim().toLowerCase();
    if (!allowedTypes.has(type)) throw new Error(`Unsupported ${config.label} entity type '${value}'.`);
    return type;
  }

  function repositoryName() {
    const settings = vscode.workspace.getConfiguration('mikrobusRust');
    const configured = String(settings.get(config.repositorySetting, '') || '').trim();
    if (configured) return configured;
    if (config.legacyRepositorySetting) {
      const legacy = String(settings.get(config.legacyRepositorySetting, '') || '').trim();
      if (legacy) return legacy;
    }
    return DEFAULT_REPOSITORY;
  }

  function packagesRoot(context) {
    return path.join(getManagedRoot(context), config.packagesRootName);
  }

  function packageInstallRoot(context, packageName) {
    return path.join(packagesRoot(context), packageName);
  }

  function catalogCachePath(context) {
    return path.join(packagesRoot(context), config.catalogCacheName);
  }

  function releaseAssetUrl(repository, assetName) {
    return `https://github.com/${repository}/releases/download/${encodeURIComponent(config.releaseTag)}/${encodeURIComponent(assetName)}`;
  }

  function validateCatalog(data) {
    if (!data || data.schemaVersion !== config.schemaVersion || data.packageModel !== config.packageModel || !Array.isArray(data.packages)) {
      throw new Error(`${config.catalogAsset} has an unsupported or invalid schema.`);
    }
    const identities = new Set();
    for (const item of data.packages) {
      if (
        !item || typeof item.name !== 'string' || typeof item.asset !== 'string' || typeof item.sha256 !== 'string' ||
        typeof item.entityType !== 'string' || typeof item.uid !== 'string' || typeof item.displayName !== 'string' ||
        typeof item.relativeBspPath !== 'string'
      ) {
        throw new Error(`${config.catalogAsset} contains an invalid package entry.`);
      }
      normalizeEntityType(item.entityType);
      if (!/^[0-9a-f]{64}$/i.test(item.sha256)) throw new Error(`${config.catalogAsset}: invalid SHA-256 for ${item.name}.`);
      const identity = `${item.entityType.toLowerCase()}\0${item.uid.toLowerCase()}`;
      if (identities.has(identity)) throw new Error(`${config.catalogAsset}: duplicate ${item.entityType} UID '${item.uid}'.`);
      identities.add(identity);
    }
    return data;
  }

  async function loadCatalog(context, token, options = {}) {
    const repository = repositoryName();
    if (!options.forceRefresh && memoryCatalog && memoryCatalogRepository === repository && (Date.now() - memoryCatalogLoadedAt) < CATALOG_CACHE_TTL_MS) {
      return memoryCatalog;
    }
    const cache = catalogCachePath(context);
    const url = releaseAssetUrl(repository, config.catalogAsset);
    try {
      const buffer = await requestBuffer(url, token, config.cancellationLabel);
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
        } catch {}
      }
      throw new Error(`Unable to load ${config.label} catalog from ${url}: ${error?.message || error}`);
    }
  }

  function packageForEntity(catalog, entityType, uid) {
    const type = normalizeEntityType(entityType);
    const wanted = String(uid || '').trim().toLowerCase();
    if (!wanted) throw new Error(`Cannot resolve a ${config.label} ${type} package without a UID.`);
    const matches = catalog.packages.filter((item) => String(item.entityType || '').toLowerCase() === type && String(item.uid || '').toLowerCase() === wanted);
    if (matches.length === 0) throw new Error(`No ${config.label} package is published for ${type} UID '${uid}'.`);
    if (matches.length > 1) throw new Error(`${config.label} catalog is ambiguous for ${type} UID '${uid}'.`);
    return matches[0];
  }

  function installedPackageMatches(target, spec) {
    if (!directoryHasContent(target)) return false;
    const marker = readJsonIfPresent(path.join(target, config.installMarker));
    return Boolean(
      marker && marker.packageName === spec.name &&
      String(marker.entityType || '').toLowerCase() === String(spec.entityType || '').toLowerCase() &&
      String(marker.uid || '').toLowerCase() === String(spec.uid || '').toLowerCase() &&
      String(marker.sha256 || '').toLowerCase() === String(spec.sha256 || '').toLowerCase()
    );
  }

  async function installSpec(context, spec, progress, token, options = {}) {
    const target = packageInstallRoot(context, spec.name);
    if (!options.forceInstall && installedPackageMatches(target, spec)) return { spec, root: target };

    const tempRoot = path.join(getManagedRoot(context), '.install-temp', `${config.tempPrefix}-${spec.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const archive = path.join(tempRoot, spec.asset);
    const extractRoot = path.join(tempRoot, 'payload');
    await fs.promises.mkdir(tempRoot, { recursive: true });
    try {
      progress?.report({ message: `Downloading ${spec.displayName}...` });
      await downloadFile(releaseAssetUrl(repositoryName(), spec.asset), archive, progress, token, config.cancellationLabel);
      const actual = await sha256File(archive);
      if (actual.toLowerCase() !== spec.sha256.toLowerCase()) {
        throw new Error(`SHA-256 mismatch for ${spec.asset}. Expected ${spec.sha256}, downloaded ${actual}.`);
      }

      progress?.report({ message: `Extracting ${spec.displayName}...` });
      await extract7z(archive, extractRoot, token, config.cancellationLabel);
      let source = extractRoot;
      const nested = path.join(extractRoot, spec.name);
      if (directoryHasContent(nested) && fs.readdirSync(extractRoot).length === 1) source = nested;

      const marker = readJsonIfPresent(path.join(source, config.packageMarker));
      if (!marker) throw new Error(`${spec.asset} does not contain ${config.packageMarker}.`);
      if (
        marker.packageName !== spec.name ||
        String(marker.entityType || '').toLowerCase() !== String(spec.entityType || '').toLowerCase() ||
        String(marker.uid || '').toLowerCase() !== String(spec.uid || '').toLowerCase()
      ) {
        throw new Error(`${spec.asset} contains package metadata for a different entity.`);
      }
      const payloadFile = path.join(source, spec.relativeBspPath);
      if (!fs.existsSync(payloadFile)) throw new Error(`${spec.asset} does not contain required BSP file '${spec.relativeBspPath}'.`);

      await replaceDirectory(source, target);
      await fs.promises.writeFile(path.join(target, config.installMarker), JSON.stringify({
        schemaVersion: config.schemaVersion,
        packageName: spec.name,
        entityType: spec.entityType,
        uid: spec.uid,
        displayName: spec.displayName,
        bspPath: spec.bspPath,
        relativeBspPath: spec.relativeBspPath,
        sha256: spec.sha256,
        asset: spec.asset
      }, null, 2) + '\n', 'utf8');
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

  async function ensureEntityPackage(context, entityType, uid, progress, token, options = {}) {
    const spec = await resolveEntitySpec(context, entityType, uid, token, options);
    return installSpec(context, spec, progress, token, options);
  }

  function installedEntries(context) {
    const root = packagesRoot(context);
    if (!fs.existsSync(root)) return [];
    const entries = [];
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const marker = readJsonIfPresent(path.join(root, item.name, config.installMarker));
      if (marker) entries.push({ ...marker, root: path.join(root, item.name) });
    }
    return entries;
  }

  async function packageState(context, token) {
    let catalog;
    try { catalog = await loadCatalog(context, token); }
    catch { catalog = { packages: [] }; }
    const installed = installedEntries(context);
    const installedMap = new Map(installed.map((item) => [String(item.packageName).toLowerCase(), item]));
    const items = catalog.packages.map((spec) => {
      const local = installedMap.get(spec.name.toLowerCase());
      return {
        key: spec.name,
        name: spec.name,
        displayName: spec.displayName,
        kind: config.itemKind,
        entityType: spec.entityType,
        uid: spec.uid,
        version: spec.sha256.slice(0, 12),
        status: local ? (String(local.sha256).toLowerCase() === String(spec.sha256).toLowerCase() ? 'installed' : 'update') : 'missing',
        root: local?.root || packageInstallRoot(context, spec.name),
        detail: config.packageDetail(spec)
      };
    });
    for (const local of installed) {
      if (items.some((item) => item.key.toLowerCase() === String(local.packageName).toLowerCase())) continue;
      items.push({
        key: local.packageName,
        name: local.packageName,
        displayName: local.displayName || local.packageName,
        kind: config.itemKind,
        entityType: local.entityType || 'legacy',
        uid: local.uid || '',
        version: String(local.sha256 || '').slice(0, 12),
        status: 'installed',
        root: local.root,
        detail: 'Installed package is not present in the current catalog.'
      });
    }
    return items.sort((a, b) => {
      const typeOrder = config.entityOrder || {};
      return (typeOrder[a.entityType] ?? 9) - (typeOrder[b.entityType] ?? 9) || String(a.displayName).localeCompare(String(b.displayName));
    });
  }

  async function installNamedPackage(context, name, progress, token) {
    const catalog = await loadCatalog(context, token);
    const spec = catalog.packages.find((item) => String(item.name).toLowerCase() === String(name).toLowerCase());
    if (!spec) throw new Error(`${config.label} package '${name}' is not in the catalog.`);
    return installSpec(context, spec, progress, token, { forceInstall: true });
  }

  async function uninstallPackage(context, name) {
    const target = packageInstallRoot(context, name);
    const root = path.resolve(packagesRoot(context));
    const resolved = path.resolve(target);
    if (!resolved.startsWith(root + path.sep)) throw new Error(`Refusing to remove path outside ${config.label} package root: ${resolved}`);
    await fs.promises.rm(resolved, { recursive: true, force: true });
    return true;
  }

  return {
    ensureEntityPackage,
    loadCatalog,
    packageForEntity,
    packagesRoot,
    packageInstallRoot,
    packageState,
    installNamedPackage,
    uninstallPackage,
    RELEASE_TAG: config.releaseTag,
    CATALOG_ASSET: config.catalogAsset,
    _test: { validateCatalog, packageForEntity, installedPackageMatches, releaseAssetUrl, repositoryName }
  };
}

module.exports = {
  createRustEntityPackageManager,
  materializeRustBspPackages,
  getManagedRoot,
  _test: { directoryHasContent, readJsonIfPresent }
};
