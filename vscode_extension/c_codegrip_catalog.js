'use strict';

const http = require('http');
const https = require('https');

const CODEGRIP_CSV_URL = 'https://s3.us-west-2.amazonaws.com/software-update.mikroe.com/Codegrip/live/Codegrip-Prog-Debug.csv';

function ensureNotCancelled(token) {
  if (token?.isCancellationRequested) throw new Error('CODEGRIP catalog operation cancelled.');
}

function fetchText(url, token, redirectCount = 0) {
  ensureNotCancelled(token);
  if (redirectCount > 8) return Promise.reject(new Error(`Too many redirects while downloading ${url}.`));
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'http:' ? http : https;
    const request = transport.get(parsed, {
      headers: {
        Accept: 'text/csv,text/plain,*/*',
        'User-Agent': 'mikrobus-embedded-vscode-extension'
      }
    }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        fetchText(new URL(response.headers.location, parsed).toString(), token, redirectCount + 1)
          .then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => reject(new Error(
          `HTTP ${status} while downloading CODEGRIP catalog${chunks.length ? `: ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}` : ''}`
        )));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')));
      response.on('error', reject);
    });
    const cancellation = token?.onCancellationRequested(() => request.destroy(new Error('CODEGRIP catalog operation cancelled.')));
    request.setTimeout(45000, () => request.destroy(new Error('CODEGRIP catalog download timed out.')));
    request.on('error', reject);
    request.on('close', () => cancellation?.dispose());
  });
}

// RFC4180-style parser. The dependencies column contains quoted JSON with
// commas, so splitting lines/fields on ',' is not sufficient.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  if (field || row.length) {
    row.push(field);
    if (row.some((value) => value !== '')) rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows.shift().map((value) => String(value || '').trim());
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, String(values[index] || '').trim()])));
}

function parseDependencies(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map(String).map((item) => item.trim()).filter(Boolean) : [];
  } catch {
    return text.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
  }
}

function rowToPackage(row) {
  const packageName = String(row?.package_name || '').trim();
  const downloadUrl = String(row?.download_link || '').trim();
  if (!packageName || !downloadUrl) return undefined;
  return {
    packageName,
    packageVersion: String(row.package_version || '').trim() || 'current',
    displayName: String(row.display_name || packageName).trim(),
    installLocation: String(row.install_location || '').trim(),
    downloadUrl,
    dependencies: parseDependencies(row.dependencies),
    releaseDate: String(row.release_date || '').trim(),
    vendor: String(row.vendor || '').trim(),
    deviceName: String(row.name || '').trim()
  };
}

function packageIndex(rows) {
  const byName = new Map();
  for (const row of rows) {
    const pkg = rowToPackage(row);
    if (!pkg || byName.has(pkg.packageName.toLowerCase())) continue;
    byName.set(pkg.packageName.toLowerCase(), pkg);
  }
  return byName;
}

function resolveDependencyPackages(primary, rows) {
  const index = packageIndex(rows);
  const result = [];
  const seen = new Set();
  const visit = (pkg) => {
    if (!pkg || seen.has(pkg.packageName.toLowerCase())) return;
    seen.add(pkg.packageName.toLowerCase());
    result.push(pkg);
    for (const dependency of pkg.dependencies || []) {
      // The GDB server is a platform package and is not represented by a row
      // in this MCU-pack CSV. c_setup installs it through the normal managed
      // CODEGRIP package.
      if (dependency.toLowerCase() === 'codegrip_gdb_server') continue;
      const dependencyPackage = index.get(dependency.toLowerCase());
      if (!dependencyPackage) {
        throw new Error(`CODEGRIP package '${pkg.packageName}' depends on '${dependency}', but that package has no downloadable row in the catalog.`);
      }
      visit(dependencyPackage);
    }
  };
  visit(primary);
  return result;
}

function resolveDeviceFromRows(rows, deviceUid) {
  const requested = String(deviceUid || '').trim().toLowerCase();
  const matches = rows.filter((row) => String(row.name || '').trim().toLowerCase() === requested);
  if (!matches.length) throw new Error(`The CODEGRIP catalog has no entry for MCU ${deviceUid}.`);
  const row = matches.find((item) => String(item.download_link || '').trim()) || matches[0];
  const primary = rowToPackage(row);
  if (!primary) {
    throw new Error(`CODEGRIP is listed for ${deviceUid}, but no downloadable device-pack link is published in Codegrip-Prog-Debug.csv.`);
  }
  return {
    catalogUrl: CODEGRIP_CSV_URL,
    deviceUid,
    resolvedAt: new Date().toISOString(),
    programmers: String(row.programmers || '').trim(),
    debuggers: String(row.debuggers || '').trim(),
    category: String(row.category || '').trim(),
    packages: resolveDependencyPackages(primary, rows)
  };
}

function resolveDeviceFromCsv(text, deviceUid) {
  return resolveDeviceFromRows(parseCsv(text), deviceUid);
}

async function resolveDevice(deviceUid, token) {
  const text = await fetchText(CODEGRIP_CSV_URL, token);
  return resolveDeviceFromCsv(text, deviceUid);
}

function relativePacksInstallPath(installLocation) {
  const normalized = String(installLocation || '').replace(/\\/g, '/');
  const marker = '/packs/';
  const index = normalized.toLowerCase().indexOf(marker);
  if (index >= 0) return normalized.slice(index + marker.length).split('/').filter(Boolean);
  if (normalized.toLowerCase().endsWith('/packs')) return [];
  return [];
}

module.exports = {
  CODEGRIP_CSV_URL,
  fetchText,
  parseCsv,
  parseDependencies,
  rowToPackage,
  resolveDeviceFromRows,
  resolveDeviceFromCsv,
  resolveDevice,
  relativePacksInstallPath
};
