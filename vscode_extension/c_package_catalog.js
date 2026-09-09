'use strict';

// C package metadata is intentionally hardcoded. The extension no longer needs
// Kibana, Elasticsearch, a proxy endpoint, credentials, or package-index queries.

const VERSIONS = Object.freeze({
  cBundle: '0.0.1',
  mikroSdk: 'latest',
  armGcc: '14.2.1-1.1',
  cmake: '3.31.12',
  ninja: '1.12.1'
});

const C_URLS = Object.freeze({
  mikrocCmake: 'https://github.com/IvanRuzavin/Rusty_MikroBUS/releases/download/v0.0.1/mikroc_cmake.7z',
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
    darwin: 'https://s3-us-west-2.amazonaws.com/software-update.mikroe.com/NECTOStudio7/development/codegrip/mac/codegrip.7z',
    linux: 'https://s3-us-west-2.amazonaws.com/software-update.mikroe.com/NECTOStudio7/development/codegrip/linux/codegrip.7z'
  },
  shared: {
    linux: {
      srecord: 'https://software-update.mikroe.com/NECTOStudio7/live/srecord/linux/srecord.7z',
      clangd: 'https://software-update.mikroe.com/NECTOStudio7/live/clangd/linux/clangd.7z',
      cmake: 'https://software-update.mikroe.com/NECTOStudio7/live/cmake/linux/cmake.7z',
      clang_format: 'https://software-update.mikroe.com/NECTOStudio7/live/clang_format/linux/clang_format.7z',
      tabnine: 'https://software-update.mikroe.com/NECTOStudio7/live/tabnine/linux/tabnine.7z'
    },
    win32: {},
    darwin: {}
  }
 });

function hostPackageSegment(platform = process.platform) {
  return ({ win32: 'win', darwin: 'mac', linux: 'linux' })[String(platform || '')];
}

function codegripUrlForPlatform(platform = process.platform) {
  const segment = hostPackageSegment(platform);
  return segment
    ? `https://s3-us-west-2.amazonaws.com/software-update.mikroe.com/NECTOStudio7/development/codegrip/${segment}/codegrip.7z`
    : undefined;
}

function managedBuildToolAsset(name, platform = process.platform, arch = process.arch) {
  const tool = String(name || '').toLowerCase();
  const host = String(platform || '');
  const cpu = String(arch || '');

  if (tool === 'cmake') {
    // Keep the already-proven NECTO package on Linux. Windows/macOS use
    // official relocatable CMake distributions so a C setup does not depend
    // on a system-wide CMake installation.
    if (host === 'linux') {
      return {
        version: 'necto-live',
        url: 'https://software-update.mikroe.com/NECTOStudio7/live/cmake/linux/cmake.7z'
      };
    }
    if (host === 'win32') {
      const suffix = cpu === 'arm64' ? 'arm64' : (cpu === 'ia32' ? 'i386' : 'x86_64');
      const file = `cmake-${VERSIONS.cmake}-windows-${suffix}.zip`;
      return {
        version: VERSIONS.cmake,
        url: `https://github.com/Kitware/CMake/releases/download/v${VERSIONS.cmake}/${file}`
      };
    }
    if (host === 'darwin') {
      const file = `cmake-${VERSIONS.cmake}-macos-universal.tar.gz`;
      return {
        version: VERSIONS.cmake,
        url: `https://github.com/Kitware/CMake/releases/download/v${VERSIONS.cmake}/${file}`
      };
    }
  }

  if (tool === 'ninja') {
    if (host === 'win32') {
      if (!['x64', 'arm64'].includes(cpu)) return undefined;
      const file = cpu === 'arm64' ? 'ninja-winarm64.zip' : 'ninja-win.zip';
      return {
        version: VERSIONS.ninja,
        url: `https://github.com/ninja-build/ninja/releases/download/v${VERSIONS.ninja}/${file}`
      };
    }
    if (host === 'darwin') {
      return {
        version: VERSIONS.ninja,
        url: `https://github.com/ninja-build/ninja/releases/download/v${VERSIONS.ninja}/ninja-mac.zip`
      };
    }
  }
  return undefined;
}

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
  if (process.platform === 'darwin') {
    const file = `xpack-arm-none-eabi-gcc-${VERSIONS.armGcc}-darwin-${arch}.tar.gz`;
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

  if (kind === 'shared' && name === 'mikroc_cmake') {
    return { version: String(spec.version || '0.0.1'), downloadUrl: C_URLS.mikrocCmake };
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
    const url = codegripUrlForPlatform(process.platform);
    if (!url) throw new Error(`The CODEGRIP package is not defined for ${process.platform}.`);
    return { version: '1.7.0', downloadUrl: url };
  }

  if (kind === 'shared' && (name === 'cmake' || name === 'ninja')) {
    const asset = managedBuildToolAsset(name, process.platform, process.arch);
    if (!asset?.url) throw new Error(`The managed ${name} package is not defined for ${process.platform}/${process.arch}.`);
    return { version: asset.version, downloadUrl: asset.url };
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
  managedBuildToolAsset,
  codegripUrlForPlatform,
  hostPackageSegment,
  _test: { selectCatalogSource, resolveDirect, C_URLS, VERSIONS, managedBuildToolAsset, codegripUrlForPlatform, hostPackageSegment }
};
