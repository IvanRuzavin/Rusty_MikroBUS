'use strict';

// C package metadata is intentionally hardcoded. The extension no longer needs
// Kibana, Elasticsearch, a proxy endpoint, credentials, or package-index queries.

const VERSIONS = Object.freeze({
  cBundle: '0.0.1',
  mikroSdk: 'latest',
  armGcc: '14.2.1-1.1',
  cmake: '3.31.12',
  ninja: '1.12.1',
  codegripGdbServer: Object.freeze({
    win32: '1.1.12',
    darwin: '1.1.9',
    linux: '1.1.12'
  })
});



const PROGRAMMER_TOOL_ASSETS = Object.freeze({
  pickitbasic_tool_support: Object.freeze({
    name: 'pickitbasic_tool_support',
    displayName: 'PICkitBasic Tool Support',
    version: '2.0.469',
    url: 'https://packs.download.microchip.com/Microchip.PICkitBasic_TP.2.0.469.atpack',
    installRelativePath: 'packsfolder/Microchip/PICkitBasic_TP/2.0.469',
    aliases: ['pickitbasic', 'pickit basic', 'pickitbasic tool support']
  }),
  pickit4_tool_support: Object.freeze({
    name: 'pickit4_tool_support',
    displayName: 'PICkit4 Tool Support',
    version: '3.0.2732',
    url: 'https://packs.download.microchip.com/Microchip.PICkit4_TP.3.0.2732.atpack',
    installRelativePath: 'packsfolder/Microchip/PICkit4_TP/3.0.2732',
    aliases: ['pickit4', 'pickit 4', 'pickit4 tool support']
  }),
  pickit5_tool_support: Object.freeze({
    name: 'pickit5_tool_support',
    displayName: 'PICkit5 Tool Support',
    version: '3.0.1208',
    url: 'https://packs.download.microchip.com/Microchip.PICkit5_TP.3.0.1208.atpack',
    installRelativePath: 'packsfolder/Microchip/PICkit5_TP/3.0.1208',
    aliases: ['pickit5', 'pickit 5', 'pickit5 tool support']
  }),
  pkob4_tool_support: Object.freeze({
    name: 'pkob4_tool_support',
    displayName: 'PKOB4 Tool Support',
    version: '2.0.1881',
    url: 'https://packs.download.microchip.com/Microchip.PKOB4_TP.2.0.1881.atpack',
    installRelativePath: 'packsfolder/Microchip/PKOB4_TP/2.0.1881',
    aliases: ['pkob4', 'pkob 4', 'pkob4 tool support']
  }),
  powerdebugger_tool_support: Object.freeze({
    name: 'powerdebugger_tool_support',
    displayName: 'PowerDebugger Tool Support',
    version: '1.9.1199',
    url: 'https://packs.download.microchip.com/Microchip.PowerDebugger_TP.1.9.1199.atpack',
    installRelativePath: 'packsfolder/Microchip/PowerDebugger_TP/1.9.1199',
    aliases: ['powerdebugger', 'power debugger', 'powerdebugger tool support']
  }),
  edbg_tool_support: Object.freeze({
    name: 'edbg_tool_support',
    displayName: 'EDBG Tool Support',
    version: '1.7.1191',
    url: 'https://packs.download.microchip.com/Microchip.EDBG_TP.1.7.1191.atpack',
    installRelativePath: 'packsfolder/Microchip/EDBG_TP/1.7.1191',
    aliases: ['edbg', 'edbg tool support']
  }),
  icd4_tool_support: Object.freeze({
    name: 'icd4_tool_support',
    displayName: 'ICD4 Tool Support',
    version: '3.0.2524',
    url: 'https://packs.download.microchip.com/Microchip.ICD4_TP.3.0.2524.atpack',
    installRelativePath: 'packsfolder/Microchip/ICD4_TP/3.0.2524',
    aliases: ['icd4', 'icd 4', 'icd4 tool support']
  })
});

function normalizeProgrammerToolKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function programmerToolAsset(...candidates) {
  const wanted = new Set(candidates.map(normalizeProgrammerToolKey).filter(Boolean));
  if (!wanted.size) return undefined;
  for (const asset of Object.values(PROGRAMMER_TOOL_ASSETS)) {
    const identities = [asset.name, asset.displayName, ...(asset.aliases || [])]
      .map(normalizeProgrammerToolKey)
      .filter(Boolean);
    if (identities.some((identity) => wanted.has(identity))) return asset;
  }
  return undefined;
}

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
  codegripGdbServer: {
    win32: 'https://s3-us-west-2.amazonaws.com/software-update.mikroe.com/Codegrip/live/codegrip_gdb_server/win/codegrip_gdb_server.7z',
    darwin: 'https://s3-us-west-2.amazonaws.com/software-update.mikroe.com/Codegrip/live/codegrip_gdb_server/mac/codegrip_gdb_server.7z',
    linux: 'https://s3-us-west-2.amazonaws.com/software-update.mikroe.com/Codegrip/live/codegrip_gdb_server/linux/codegrip_gdb_server.7z'
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

function codegripServerAsset(platform = process.platform) {
  const host = String(platform || '');
  const url = C_URLS.codegripGdbServer[host];
  const version = VERSIONS.codegripGdbServer[host];
  return url && version ? { version, url } : undefined;
}

function codegripUrlForPlatform(platform = process.platform) {
  return codegripServerAsset(platform)?.url;
}

function codegripVersionForPlatform(platform = process.platform) {
  return codegripServerAsset(platform)?.version;
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
    if (host === 'linux') {
      if (!['x64', 'arm64'].includes(cpu)) return undefined;
      const file = cpu === 'arm64' ? 'ninja-linux-aarch64.zip' : 'ninja-linux.zip';
      return {
        version: VERSIONS.ninja,
        url: `https://github.com/ninja-build/ninja/releases/download/v${VERSIONS.ninja}/${file}`
      };
    }
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
  if (kind === 'programmer') {
    const programmerAsset = programmerToolAsset(spec.name, spec.displayName);
    if (programmerAsset?.url) {
      return { version: programmerAsset.version, downloadUrl: programmerAsset.url };
    }
  }
  if (kind === 'programmer' && (name.includes('codegrip') || name === 'codegrip')) {
    const asset = codegripServerAsset(process.platform);
    if (!asset?.url) throw new Error(`The CODEGRIP GDB Server package is not defined for ${process.platform}.`);
    return { version: asset.version, downloadUrl: asset.url };
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
  codegripServerAsset,
  codegripUrlForPlatform,
  codegripVersionForPlatform,
  hostPackageSegment,
  programmerToolAsset,
  _test: { selectCatalogSource, resolveDirect, C_URLS, VERSIONS, PROGRAMMER_TOOL_ASSETS, managedBuildToolAsset, codegripServerAsset, codegripUrlForPlatform, codegripVersionForPlatform, hostPackageSegment, programmerToolAsset, normalizeProgrammerToolKey }
};
