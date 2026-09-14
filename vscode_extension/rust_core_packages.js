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
const RELEASE_TAG = 'rust-core-packages';
const CATALOG_ASSET = 'rust_core_packages.json';
const PACKAGE_MARKER = '.rust-core-package.json';
const INSTALL_MARKER = '.rust-core-installed.json';
const CATALOG_CACHE_NAME = '.rust-core-packages-catalog.json';

let memoryCatalog;
let memoryCatalogRepository;
let memoryCatalogLoadedAt = 0;
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

function getManagedRoot(context) {
  const configured = String(vscode.workspace.getConfiguration('mikrobusRust').get('storageRoot', '') || '').trim();
  if (configured) return expandHome(configured);
  return context.globalStorageUri.fsPath;
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function repositoryName() {
  const configured = String(
    vscode.workspace.getConfiguration('mikrobusRust').get('rustCorePackagesRepository', DEFAULT_REPOSITORY) || ''
  ).trim();
  return configured || DEFAULT_REPOSITORY;
}

function packagesRoot(context) {
  return path.join(getManagedRoot(context), 'rust-core-packages');
}

function packageInstallRoot(context, packageName) {
  return path.join(packagesRoot(context), packageName);
}

function catalogCachePath(context) {
  return path.join(packagesRoot(context), CATALOG_CACHE_NAME);
}

function legacyCoreRoot(context) {
  return path.join(getManagedRoot(context), 'core');
}

function releaseAssetUrl(repository, assetName) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(RELEASE_TAG)}/${encodeURIComponent(assetName)}`;
}

function ensureNotCancelled(token) {
  if (token?.isCancellationRequested) throw new Error('Rust core package installation cancelled.');
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
        const next = new URL(response.headers.location, url).toString();
        resolve(requestBuffer(next, token, redirects + 1));
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
    const cancellation = token?.onCancellationRequested(() => request.destroy(new Error('Rust core package installation cancelled.')));
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
      const request = client.get(currentUrl, {
        headers: { 'User-Agent': 'mikrobus-rust-vscode-extension' }
      }, (response) => {
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
      const cancellation = token?.onCancellationRequested(() => request.destroy(new Error('Rust core package installation cancelled.')));
      request.on('close', () => cancellation?.dispose());
    };
    visit(url, 0);
  });
}

function validateCatalog(data) {
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.packages)) {
    throw new Error(`${CATALOG_ASSET} has an unsupported or invalid schema.`);
  }
  for (const item of data.packages) {
    if (!item || typeof item.name !== 'string' || typeof item.asset !== 'string' ||
        typeof item.sha256 !== 'string' || typeof item.systemLib !== 'string') {
      throw new Error(`${CATALOG_ASSET} contains an invalid package entry.`);
    }
    if (!/^[0-9a-f]{64}$/i.test(item.sha256)) {
      throw new Error(`${CATALOG_ASSET}: invalid SHA-256 for ${item.name}.`);
    }
  }
  return data;
}

async function loadCatalog(context, token, options = {}) {
  const repository = repositoryName();
  if (!options.forceRefresh && memoryCatalog && memoryCatalogRepository === repository && (Date.now() - memoryCatalogLoadedAt) < CATALOG_CACHE_TTL_MS) return memoryCatalog;

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
        // Report the original network/catalog failure below.
      }
    }
    throw new Error(`Unable to load Rust core package catalog from ${url}: ${error?.message || error}`);
  }
}

function packageForSystemLib(catalog, systemLib) {
  const matches = catalog.packages.filter(
    (item) => String(item.systemLib || '').toLowerCase() === String(systemLib || '').toLowerCase()
  );
  if (matches.length === 0) {
    throw new Error(`No Rust core package is published for system library '${systemLib}'.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Rust core package catalog is ambiguous for '${systemLib}': ${matches.map((item) => item.name).join(', ')}.`
    );
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

function installedPackageMatches(target, packageSpec) {
  if (!directoryHasContent(target)) return false;
  const marker = readJsonIfPresent(path.join(target, INSTALL_MARKER));
  if (!marker) return false;
  return marker.packageName === packageSpec.name &&
    String(marker.systemLib || '').toLowerCase() === String(packageSpec.systemLib || '').toLowerCase() &&
    String(marker.sha256 || '').toLowerCase() === String(packageSpec.sha256 || '').toLowerCase();
}

function findExecutableOnPath(names) {
  const pathValue = process.env.PATH || '';
  for (const folder of pathValue.split(path.delimiter)) {
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
        try { fs.chmodSync(bundled, 0o755); } catch { /* best effort */ }
      }
      return bundled;
    }
  } catch {
    // Fall back to a host installation.
  }

  const names = process.platform === 'win32'
    ? ['7zz.exe', '7z.exe', '7za.exe']
    : ['7zz', '7z', '7za'];
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
  const executable = sevenZipExecutable();
  await runProcess(executable, ['x', '-y', archive, `-o${destination}`], token);
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

function legacyCoreSupports(context, metadata) {
  const root = legacyCoreRoot(context);
  if (!directoryHasContent(root)) return false;
  const targetSystem = String(metadata?.systemLib || '').toLowerCase();
  const mcuName = String(metadata?.name || '').toLowerCase();
  let systemFound = false;
  let definitionFound = false;
  const stack = [root];
  while (stack.length > 0 && (!systemFound || !definitionFound)) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (path.basename(path.dirname(full)).toLowerCase() === 'system' && entry.name.toLowerCase() === targetSystem) {
          systemFound = true;
        }
        stack.push(full);
      } else if (
        entry.isFile() &&
        path.basename(current).toLowerCase() === 'mcu_definitions' &&
        path.parse(entry.name).name.toLowerCase() === mcuName
      ) {
        definitionFound = true;
      }
    }
  }
  return systemFound && definitionFound;
}

async function ensureRustCorePackage(context, metadata, progress, token, options = {}) {
  const systemLib = String(metadata?.systemLib || '').trim();
  if (!systemLib) throw new Error(`MCU '${metadata?.name || ''}' has no SYSTEM_LIB in the Rust database.`);

  let catalog;
  try {
    catalog = await loadCatalog(context, token, { forceRefresh: Boolean(options.forceCatalogRefresh) });
  } catch (error) {
    if (legacyCoreSupports(context, metadata)) return legacyCoreRoot(context);
    throw error;
  }

  let packageSpec;
  try {
    packageSpec = packageForSystemLib(catalog, systemLib);
  } catch (error) {
    // A VS Code session may have cached the catalog before a newly-added
    // architecture/system library was published. Refresh once before failing.
    catalog = await loadCatalog(context, token, { forceRefresh: true });
    packageSpec = packageForSystemLib(catalog, systemLib);
  }
  const target = packageInstallRoot(context, packageSpec.name);
  if (!options.forceInstall && installedPackageMatches(target, packageSpec)) return target;

  const managedRoot = getManagedRoot(context);
  const tempRoot = path.join(
    managedRoot,
    '.install-temp',
    `rust-core-${packageSpec.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const archive = path.join(tempRoot, packageSpec.asset);
  const extractRoot = path.join(tempRoot, 'payload');
  await fs.promises.mkdir(tempRoot, { recursive: true });

  try {
    progress?.report({ message: `Downloading Rust core ${packageSpec.name}...` });
    const repository = repositoryName();
    await downloadFile(releaseAssetUrl(repository, packageSpec.asset), archive, progress, token);
    ensureNotCancelled(token);

    progress?.report({ message: `Verifying ${packageSpec.asset}...` });
    const actual = await sha256File(archive);
    if (actual.toLowerCase() !== packageSpec.sha256.toLowerCase()) {
      throw new Error(
        `SHA-256 mismatch for ${packageSpec.asset}. Expected ${packageSpec.sha256}, downloaded ${actual}.`
      );
    }

    progress?.report({ message: `Extracting Rust core ${packageSpec.name}...` });
    await extract7z(archive, extractRoot, token);
    ensureNotCancelled(token);

    let source = extractRoot;
    const nested = path.join(extractRoot, packageSpec.name);
    if (directoryHasContent(nested) && fs.readdirSync(extractRoot).length === 1) source = nested;

    const packageMarker = readJsonIfPresent(path.join(source, PACKAGE_MARKER));
    if (packageMarker) {
      if (packageMarker.packageName !== packageSpec.name ||
          String(packageMarker.systemLib || '').toLowerCase() !== systemLib.toLowerCase()) {
        throw new Error(`${packageSpec.asset} contains package metadata for a different system library.`);
      }
    }
    if (!directoryHasContent(source)) throw new Error(`${packageSpec.asset} extracted to an empty directory.`);

    progress?.report({ message: `Installing Rust core ${packageSpec.name}...` });
    await replaceDirectory(source, target);
    await fs.promises.writeFile(
      path.join(target, INSTALL_MARKER),
      JSON.stringify({
        schemaVersion: 1,
        packageName: packageSpec.name,
        systemLib: packageSpec.systemLib,
        sha256: packageSpec.sha256,
        asset: packageSpec.asset
      }, null, 2) + '\n',
      'utf8'
    );
    return target;
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function installedPackageSummary(context) {
  const root = packagesRoot(context);
  if (!fs.existsSync(root)) return { count: 0, root };
  let count = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (fs.existsSync(path.join(root, entry.name, INSTALL_MARKER))) count += 1;
  }
  return { count, root };
}

module.exports = {
  ensureRustCorePackage,
  loadCatalog,
  packageForSystemLib,
  packagesRoot,
  packageInstallRoot,
  installedPackageSummary,
  RELEASE_TAG,
  CATALOG_ASSET,
  _test: {
    validateCatalog,
    packageForSystemLib,
    installedPackageMatches,
    releaseAssetUrl,
    legacyCoreSupports,
    repositoryName,
    sevenZipExecutable
  }
};
