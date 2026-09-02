'use strict';

// C package metadata is intentionally hardcoded. The extension no longer needs
// Kibana, Elasticsearch, a proxy endpoint, credentials, or package-index queries.

const VERSIONS = Object.freeze({
  cBundle: '0.0.1',
  mikroSdk: 'latest',
  armGcc: '14.2.1-1.1'
});

const C_URLS = Object.freeze({
  database: 'https://github.com/MikroElektronika/general_packages/releases/download/general_packages_assets/database_live.7z',
  coreMetadata: 'https://github.com/MikroElektronika/core_packages/releases/download/v2.0.0/metadata.json',
  sdkLatestApi: 'https://api.github.com/repos/MikroElektronika/mikrosdk_v2/releases/latest',
  infrastructure: {
    unit_test_lib: 'https://github.com/MikroElektronika/general_packages/releases/download/general_packages_assets/unit_test_lib.7z',
    preinit: 'https://github.com/MikroElektronika/general_packages/releases/download/general_packages_assets/preinit.7z',
    mikroe_utils_common: 'https://github.com/MikroElektronika/general_packages/releases/download/general_packages_assets/mikroe_utils_common.7z'
  },
  codegrip: {
    win32: 'https://s3-us-west-2.amazonaws.com/software-update.mikroe.com/NECTOStudio7/development/codegrip/win/codegrip.7z',
    darwin: 'https://s3-us-west-2.amazonaws.com/software-update.mikroe.com/NECTOStudio7/development/codegrip/macos/codegrip.7z',
    linux: 'https://s3-us-west-2.amazonaws.com/software-update.mikroe.com/NECTOStudio7/development/codegrip/linux/codegrip.7z'
  },
  shared: {
    linux: {
      srecord: 'https://software-update.mikroe.com/NECTOStudio7/live/srecord/linux/srecord.7z',
      debuggers: 'https://software-update.mikroe.com/NECTOStudio7/live/debuggers/linux/debuggers.7z',
      clangd: 'https://software-update.mikroe.com/NECTOStudio7/live/clangd/linux/clangd.7z',
      cmake: 'https://software-update.mikroe.com/NECTOStudio7/live/cmake/linux/cmake.7z',
      clang_format: 'https://software-update.mikroe.com/NECTOStudio7/live/clang_format/linux/clang_format.7z',
      tabnine: 'https://software-update.mikroe.com/NECTOStudio7/live/tabnine/linux/tabnine.7z'
    },
    win32: {
      debuggers: 'https://software-update.mikroe.com/NECTOStudio7/live/debuggers/win/debuggers.7z'
    },
    darwin: {}
  }
});

function armGccAsset() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') {
    const file = `xpack-arm-none-eabi-gcc-${VERSIONS.armGcc}-win32-x64.zip`;
    return `https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/download/v${VERSIONS.armGcc}/${file}`;
  }
  if (process.platform === 'linux') {
    const file = `xpack-arm-none-eabi-gcc-${VERSIONS.armGcc}-linux-${arch}.tar.gz`;
    return `https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/download/v${VERSIONS.armGcc}/${file}`;
  }
  return undefined;
}

function resolveDirect(spec) {
  const kind = String(spec.kind || '').toLowerCase();
  const name = String(spec.name || '').toLowerCase();

  // MCU-specific CODEGRIP device packs are resolved from the live
  // Codegrip-Prog-Debug.csv catalog. Allow callers to provide that direct
  // asset URL without routing it through the removed Elasticsearch catalog.
  if (spec.downloadUrl) {
    return { version: String(spec.version || 'current'), downloadUrl: String(spec.downloadUrl) };
  }

  if (kind === 'database' || name === 'c_database') {
    return { version: String(spec.version || 'live'), downloadUrl: C_URLS.database };
  }
  if (kind === 'core') {
    throw new Error(`Core package '${spec.name}' must be resolved from core_packages metadata before installation.`);
  }
  if (kind === 'sdk' || name === 'mikrosdk') {
    if (!spec.downloadUrl) throw new Error('mikroSDK latest release must be resolved before installation.');
  }
  if (kind === 'infrastructure' && C_URLS.infrastructure[name]) {
    return { version: String(spec.version || 'general_packages_assets'), downloadUrl: C_URLS.infrastructure[name] };
  }
  if (kind === 'toolchain' && (name === 'gcc_arm_compiler' || name === 'arm_gcc')) {
    const url = armGccAsset();
    if (!url) throw new Error(`The hardcoded ARM GCC package is not defined for ${process.platform}/${process.arch}.`);
    return { version: VERSIONS.armGcc, downloadUrl: url };
  }
  if (kind === 'programmer' && (name.includes('codegrip') || name === 'codegrip')) {
    const url = C_URLS.codegrip[process.platform];
    if (!url) throw new Error(`The CODEGRIP package is not defined for ${process.platform}.`);
    return { version: '1.7.0', downloadUrl: url };
  }

  const shared = C_URLS.shared[process.platform]?.[name];
  if (shared) return { version: String(spec.version || ''), downloadUrl: shared };

  throw new Error(
    `No hardcoded C download link is defined for ${spec.kind}:${spec.name}. ` +
    'C packages no longer use Kibana/Elasticsearch.'
  );
}

async function resolvePackage(_context, spec) {
  return { name: spec.name, checksum: undefined, index: 'hardcoded', ...resolveDirect(spec) };
}

// Kept only for compatibility with older tests/callers. There is no remote catalog now.
function selectCatalogSource(response, requestedVersion) {
  const hits = Array.isArray(response?.hits?.hits) ? response.hits.hits : [];
  const sources = hits.map((hit) => hit?._source || hit).filter(Boolean);
  return sources.find((source) => !requestedVersion || String(source.version || '') === String(requestedVersion)) || sources[0];
}

function getCatalogConfig() {
  return { mode: 'hardcoded', infrastructurePackages: {} };
}

async function configureCatalog() {
  throw new Error('Package catalog configuration was removed. C package URLs are hardcoded in the extension.');
}

async function clearCatalogCredentials() {}

module.exports = {
  getCatalogConfig,
  resolvePackage,
  configureCatalog,
  clearCatalogCredentials,
  _test: { selectCatalogSource, resolveDirect, C_URLS, VERSIONS }
};
