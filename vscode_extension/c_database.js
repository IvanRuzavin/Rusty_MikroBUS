'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

function expandHome(value) {
  const text = String(value || '').trim();
  if (text === '~') return os.homedir();
  if (text.startsWith(`~${path.sep}`) || text.startsWith('~/')) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

function getManagedRoot(context) {
  const configured = String(vscode.workspace.getConfiguration('mikrobusRust').get('storageRoot', '') || '').trim();
  return configured ? path.resolve(expandHome(configured)) : context.globalStorageUri.fsPath;
}

function findFileRecursive(root, fileName, maxDepth = 5) {
  if (!root || !fs.existsSync(root) || maxDepth < 0) return undefined;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === fileName) return path.join(root, entry.name);
  }
  if (maxDepth === 0) return undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findFileRecursive(path.join(root, entry.name), fileName, maxDepth - 1);
    if (found) return found;
  }
  return undefined;
}

function resolveDatabasePath(context) {
  const configured = String(vscode.workspace.getConfiguration('mikrobusRust').get('cDatabasePath', '') || '').trim();
  const packageRoot = path.join(getManagedRoot(context), 'c-runtime', 'packages', 'database', 'C_database');
  const liveRoot = path.join(packageRoot, 'live');
  const legacyRoot = path.join(packageRoot, '0.0.1');
  const discoveredLiveDatabase = findFileRecursive(liveRoot, 'necto_db.db');
  const discoveredLegacyDatabase = findFileRecursive(legacyRoot, 'necto_db.db');
  const candidates = [
    configured ? path.resolve(expandHome(configured)) : undefined,
    discoveredLiveDatabase,
    path.join(liveRoot, 'necto_db.db'),
    path.join(liveRoot, 'database', 'necto_db.db'),
    // Keep the pre-0.7.0 location as a fallback so an existing installation can
    // still open while the daily database package is being installed.
    discoveredLegacyDatabase,
    path.join(legacyRoot, 'necto_db.db'),
    path.join(legacyRoot, 'database', 'necto_db.db'),
    path.join(getManagedRoot(context), 'database', 'necto_db.db'),
    path.join(os.homedir(), '.MIKROE', 'NECTOStudio7', 'databases', 'necto_db.db')
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function getDatabaseSync() {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch {
    throw new Error('C setup database access requires VS Code 1.101 or newer.');
  }
}

function normalizeRow(row) {
  if (!row) return row;
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    result[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return result;
}

function withDatabase(context, callback) {
  const databasePath = resolveDatabasePath(context);
  if (!databasePath || !fs.existsSync(databasePath)) {
    throw new Error(
      `NECTO setup database was not found. Set mikrobusRust.cDatabasePath to necto_db.db. ` +
      `Expected: ${databasePath || '<not configured>'}`
    );
  }
  const DatabaseSync = getDatabaseSync();
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return callback(db, databasePath);
  } finally {
    db.close();
  }
}

const REQUIRED_TABLES = [
  'Devices',
  'DeviceToPackage',
  'Packages',
  'Compilers',
  'CompilerToDevice',
  'SDKs',
  'SDKToCompiler',
  'SDKToDevice',
  'Programmers',
  'ProgrammerToDevice',
  'CompilerToProgrammer',
  'Boards',
  'BoardToDevice'
];

function validateDatabase(context) {
  return withDatabase(context, (db, databasePath) => {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        .map((row) => String(row.name))
    );
    const missing = REQUIRED_TABLES.filter((name) => !tables.has(name));
    if (missing.length > 0) {
      throw new Error(`${databasePath} is missing required NECTO table(s): ${missing.join(', ')}.`);
    }
    return databasePath;
  });
}

function parseJson(value, fallback = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function sdkConfigObject(value) {
  const parsed = parseJson(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed } : {};
}

function mergeSdkConfigSources(sources = {}) {
  const compiler = sdkConfigObject(sources.compiler);
  const device = sdkConfigObject(sources.device);
  const devicePackage = sdkConfigObject(sources.devicePackage);
  const board = sdkConfigObject(sources.board);
  return {
    sources: { compiler, device, devicePackage, board },
    merged: {
      _MSDK_BOARD_NAME_: 'GENERIC_BOARD',
      ...compiler,
      ...device,
      ...devicePackage,
      ...board
    }
  };
}

function versionParts(value) {
  return String(value || '').split(/[^0-9]+/).filter(Boolean).map((part) => Number(part));
}

function compareVersionsDescending(left, right) {
  const a = versionParts(left.version);
  const b = versionParts(right.version);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const difference = (b[i] || 0) - (a[i] || 0);
    if (difference !== 0) return difference;
  }
  return String(left.uid).localeCompare(String(right.uid));
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function listDevices(context, supportedCompilerUids) {
  if (!Array.isArray(supportedCompilerUids) || supportedCompilerUids.length === 0) return [];
  return withDatabase(context, (db) => db.prepare(`
    SELECT DISTINCT
      d.uid,
      d.name,
      d.vendor,
      d.family_uid AS familyUid,
      d.max_speed AS maxSpeed,
      d.flash,
      d.ram,
      d.def_file AS defFile,
      d.sdk_config AS sdkConfig
    FROM Devices d
    JOIN CompilerToDevice ctd ON ctd.device_uid = d.uid
    WHERE COALESCE(d.sdk_support, 0) = 1
      AND ctd.compiler_uid IN (${placeholders(supportedCompilerUids.length)})
      AND d.uid NOT LIKE 'MCU_CARD_%'
      AND d.uid NOT LIKE 'SIBRAIN_%'
    ORDER BY d.uid COLLATE NOCASE
  `).all(...supportedCompilerUids).map(normalizeRow).map((row) => ({
    ...row,
    mcuName: String(sdkConfigObject(row.sdkConfig).MCU_NAME || row.uid || '').trim()
  })));
}


function listBoards(context, supportedCompilerUids) {
  if (!Array.isArray(supportedCompilerUids) || supportedCompilerUids.length === 0) return [];
  return withDatabase(context, (db) => db.prepare(`
    SELECT
      b.uid,
      b.name,
      b.vendor,
      b.category,
      b.default_device AS defaultDevice,
      b.soldered_device AS solderedDevice,
      b.mikrobus_count AS mikrobusCount,
      COUNT(DISTINCT btd.device_uid) AS compatibleDeviceCount
    FROM Boards b
    JOIN BoardToDevice btd ON btd.board_uid = b.uid
    JOIN Devices d ON d.uid = btd.device_uid
    JOIN CompilerToDevice ctd ON ctd.device_uid = d.uid
    WHERE COALESCE(d.sdk_support, 0) = 1
      AND ctd.compiler_uid IN (${placeholders(supportedCompilerUids.length)})
    GROUP BY b.uid, b.name, b.vendor, b.category, b.default_device, b.soldered_device, b.mikrobus_count
    ORDER BY b.name COLLATE NOCASE, b.uid COLLATE NOCASE
  `).all(...supportedCompilerUids).map(normalizeRow));
}

function listBoardDevices(context, boardUid, supportedCompilerUids) {
  if (!Array.isArray(supportedCompilerUids) || supportedCompilerUids.length === 0) return [];
  return withDatabase(context, (db) => db.prepare(`
    SELECT DISTINCT
      d.uid,
      d.name,
      d.vendor,
      d.family_uid AS familyUid,
      d.max_speed AS maxSpeed,
      d.flash,
      d.ram,
      d.def_file AS defFile,
      d.sdk_config AS sdkConfig,
      CASE
        WHEN d.uid = NULLIF(b.soldered_device, '') THEN 0
        WHEN d.uid = NULLIF(b.default_device, '') THEN 1
        ELSE 2
      END AS boardPriority
    FROM Boards b
    JOIN BoardToDevice btd ON btd.board_uid = b.uid
    JOIN Devices d ON d.uid = btd.device_uid
    JOIN CompilerToDevice ctd ON ctd.device_uid = d.uid
    WHERE b.uid = ?
      AND COALESCE(d.sdk_support, 0) = 1
      AND ctd.compiler_uid IN (${placeholders(supportedCompilerUids.length)})
    ORDER BY boardPriority, d.uid COLLATE NOCASE
  `).all(boardUid, ...supportedCompilerUids).map(normalizeRow).map((row) => ({
    ...row,
    // BoardToDevice may point at an MCU-card relation row. Keep row.uid for
    // database joins, but expose the actual MCU identity from Devices.sdk_config.
    mcuName: String(sdkConfigObject(row.sdkConfig).MCU_NAME || row.uid || '').trim()
  })));
}

function getBoard(context, boardUid) {
  return withDatabase(context, (db) => {
    const row = normalizeRow(db.prepare(`
      SELECT uid, name, vendor, category, default_device AS defaultDevice,
             soldered_device AS solderedDevice, mikrobus_count AS mikrobusCount,
             sdk_config AS sdkConfig, installer_package AS installerPackage
      FROM Boards WHERE uid = ? LIMIT 1
    `).get(boardUid));
    return row ? { ...row, sdkConfig: parseJson(row.sdkConfig) } : undefined;
  });
}

function getDeviceCoreInfo(context, deviceUid, compilerUid) {
  return withDatabase(context, (db) => {
    const row = normalizeRow(db.prepare(`
      SELECT
        d.uid,
        d.name,
        d.vendor,
        d.family_uid AS familyUid,
        d.max_speed AS maxSpeed,
        d.flash,
        d.ram,
        d.def_file AS defFile,
        d.sdk_config AS deviceSdkConfig,
        d.installer_package AS installerPackage,
        c.uid AS compilerUid,
        c.name AS compilerName,
        c.version AS compilerVersion,
        c.core_path AS corePath
      FROM Devices d
      JOIN CompilerToDevice ctd ON ctd.device_uid = d.uid
      JOIN Compilers c ON c.uid = ctd.compiler_uid
      WHERE d.uid = ? AND c.uid = ?
      LIMIT 1
    `).get(deviceUid, compilerUid));
    if (!row) return undefined;
    const sdkConfig = parseJson(row.deviceSdkConfig);
    return {
      uid: row.uid,
      name: row.name,
      vendor: row.vendor,
      familyUid: row.familyUid,
      maxSpeed: row.maxSpeed,
      flash: Number(row.flash || 0),
      ram: Number(row.ram || 0),
      defFile: row.defFile || `${sdkConfig.MCU_NAME || row.uid}.json`,
      mcuName: String(sdkConfig.MCU_NAME || row.uid || '').trim(),
      coreName: String(sdkConfig.CORE_NAME || '').trim(),
      compilerUid: row.compilerUid,
      compilerName: row.compilerName,
      compilerVersion: row.compilerVersion,
      corePath: row.corePath,
      installerPackage: row.installerPackage,
      sdkConfig
    };
  });
}

function listCompilers(context, deviceUid, supportedCompilerUids) {
  if (!Array.isArray(supportedCompilerUids) || supportedCompilerUids.length === 0) return [];
  return withDatabase(context, (db) => {
    const device = normalizeRow(db.prepare('SELECT * FROM Devices WHERE uid = ? LIMIT 1').get(deviceUid));
    if (!device) return [];
    const rows = db.prepare(`
      SELECT
        c.uid,
        c.name,
        c.version,
        c.vendor,
        c.language,
        c.path,
        c.default_options AS defaultOptions,
        c.c_compiler AS cCompiler,
        c.cxx_compiler AS cxxCompiler,
        c.gdb_path AS gdbPath,
        c.asm_compiler AS asmCompiler,
        c.clangd_config AS clangdConfig,
        c.core_path AS corePath,
        c.installer_package AS installerPackage,
        c.sdk_config AS sdkConfig
      FROM Compilers c
      JOIN CompilerToDevice ctd ON ctd.compiler_uid = c.uid
      JOIN CompilerToBuildSystem ctb ON ctb.compiler_uid = c.uid AND ctb.build_system_uid = 'cmake'
      WHERE ctd.device_uid = ?
        AND c.uid IN (${placeholders(supportedCompilerUids.length)})
      ORDER BY c.name COLLATE NOCASE
    `).all(deviceUid, ...supportedCompilerUids).map(normalizeRow);

    // CompilerToDevice tells us that the compiler supports the MCU, while
    // Devices.installer_package tells us which compiler-specific core package
    // is actually available. Require both mappings before offering a compiler.
    return rows.map((row) => {
      const requirement = coreDeviceFor(db, device, row.uid);
      return requirement.packageName ? { ...row, corePackageName: requirement.packageName } : undefined;
    }).filter(Boolean);
  });
}

function listSdks(context, deviceUid, compilerUid) {
  return withDatabase(context, (db) => db.prepare(`
    SELECT DISTINCT s.uid, s.name, s.version, s.legacy
    FROM SDKs s
    JOIN SDKToCompiler stc ON stc.sdk_uid = s.uid
    JOIN SDKToDevice std ON std.sdk_uid = s.uid
    WHERE stc.compiler_uid = ?
      AND std.device_uid = ?
      AND COALESCE(s.legacy, 0) = 0
    ORDER BY s.version DESC
  `).all(compilerUid, deviceUid).map(normalizeRow).sort(compareVersionsDescending));
}

function listDevicePackages(context, deviceUid) {
  return withDatabase(context, (db) => db.prepare(`
    SELECT
      p.uid,
      p.name,
      p.pin_count AS pinCount,
      p.sdk_config AS sdkConfig,
      p.stm_sdk_config AS stmSdkConfig
    FROM DeviceToPackage dtp
    JOIN Packages p ON p.uid = dtp.package_uid
    WHERE dtp.device_uid = ?
    ORDER BY p.pin_count, p.name COLLATE NOCASE
  `).all(deviceUid).map(normalizeRow));
}



function listProgrammers(context, deviceUid, compilerUid) {
  return withDatabase(context, (db) => db.prepare(`
    SELECT
      p.uid,
      p.name,
      p.description,
      p.installer_package AS installerPackage,
      ptd.device_support_package AS deviceSupportPackage
    FROM ProgrammerToDevice ptd
    JOIN Programmers p ON p.uid = ptd.programer_uid
    JOIN CompilerToProgrammer ctp ON ctp.programmer_uid = p.uid
    WHERE ptd.device_uid = ?
      AND ctp.compiler_uid = ?
      AND COALESCE(p.hidden, 0) = 0
    ORDER BY CASE p.uid WHEN 'codegrip' THEN 0 WHEN 'segger_jlink' THEN 1 ELSE 2 END,
             p.name COLLATE NOCASE
  `).all(deviceUid, compilerUid).map(normalizeRow));
}

function corePackageName(installerPackage, compilerUid) {
  const parsed = parseJson(installerPackage, undefined);
  if (typeof parsed === 'string') return parsed;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return String(parsed[compilerUid] || '').trim();
  }
  return String(installerPackage || '').trim();
}

function supportPackageNames(value) {
  const parsed = parseJson(value, undefined);
  if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.trim()).filter(Boolean);
  const text = String(value || '').trim();
  return text && text !== '[""]' ? [text] : [];
}


function installerPackageObject(value) {
  const parsed = parseJson(value, undefined);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  return undefined;
}

function bspPackageName(value) {
  const parsed = installerPackageObject(value);
  return String(parsed?.package || '').trim();
}

function sdkFolderName(config, key, fallback) {
  const value = String(sdkConfigObject(config)?.[key] || fallback || '').trim();
  return value.toLowerCase();
}

function coreDeviceFor(contextDb, device, compilerUid) {
  const config = sdkConfigObject(device?.sdk_config);
  const mcuName = String(config.MCU_NAME || device?.uid || '').trim();
  const directPackage = corePackageName(device?.installer_package, compilerUid);
  if (directPackage && !bspPackageName(device?.installer_package)) return { device, packageName: directPackage };
  const candidate = normalizeRow(contextDb.prepare(`
    SELECT * FROM Devices
    WHERE uid = ? AND uid NOT LIKE 'MCU_CARD_%' AND uid NOT LIKE 'SIBRAIN_%'
    LIMIT 1
  `).get(mcuName));
  const packageName = corePackageName(candidate?.installer_package, compilerUid);
  return { device: candidate || device, packageName };
}

function getDevicePackageRequirements(context, deviceUid, compilerUid, boardUid) {
  return withDatabase(context, (db) => {
    const device = normalizeRow(db.prepare('SELECT * FROM Devices WHERE uid = ? LIMIT 1').get(deviceUid));
    if (!device) throw new Error(`Device '${deviceUid}' was not found.`);
    const core = coreDeviceFor(db, device, compilerUid);
    if (!core.packageName) throw new Error(`${core.device?.uid || deviceUid} does not define a core installer package for ${compilerUid}.`);
    const deviceConfig = sdkConfigObject(device.sdk_config);
    const cardPackageName = bspPackageName(device.installer_package);
    const card = cardPackageName ? {
      name: cardPackageName,
      displayName: device.name || device.uid,
      folderName: sdkFolderName(device.sdk_config, '_MSDK_MCU_CARD_NAME_', cardPackageName),
      mcuName: String(deviceConfig.MCU_NAME || device.uid || '').trim(),
      deviceUid: device.uid,
      vendor: device.vendor
    } : undefined;
    const board = boardUid ? normalizeRow(db.prepare('SELECT * FROM Boards WHERE uid = ? LIMIT 1').get(boardUid)) : undefined;
    const boardPackageName = bspPackageName(board?.installer_package);
    const boardPackage = boardPackageName ? {
      name: boardPackageName,
      displayName: board.name || board.uid,
      folderName: sdkFolderName(board.sdk_config, '_MSDK_BOARD_NAME_', boardPackageName),
      boardUid: board.uid,
      vendor: board.vendor
    } : undefined;
    return {
      core: { name: core.packageName, deviceUid: core.device?.uid || deviceUid, compilerUid },
      card,
      board: boardPackage,
      mcuName: String(deviceConfig.MCU_NAME || device.uid || '').trim()
    };
  });
}

function listCoreInstallerPackages(context, compilerUids = []) {
  return withDatabase(context, (db) => {
    const filter = Array.isArray(compilerUids) && compilerUids.length ? new Set(compilerUids) : undefined;
    const result = new Map();
    const rows = db.prepare('SELECT uid, name, vendor, installer_package AS installerPackage FROM Devices WHERE COALESCE(sdk_support,0)=1').all().map(normalizeRow);
    for (const row of rows) {
      if (bspPackageName(row.installerPackage)) continue;
      const parsed = installerPackageObject(row.installerPackage);
      if (!parsed) {
        const direct = String(parseJson(row.installerPackage, row.installerPackage) || '').trim();
        if (direct) {
          const key = `:${direct}`;
          const current = result.get(key) || { name: direct, compilerUid: undefined, vendor: row.vendor, devices: [], displayName: direct };
          current.devices.push(row.uid);
          result.set(key, current);
        }
        continue;
      }
      for (const [compilerUid, packageNameRaw] of Object.entries(parsed)) {
        if (filter && !filter.has(compilerUid)) continue;
        const packageName = String(packageNameRaw || '').trim();
        if (!packageName) continue;
        const key = `${compilerUid}:${packageName}`;
        const current = result.get(key) || { name: packageName, compilerUid, vendor: row.vendor, devices: [], displayName: packageName };
        current.devices.push(row.uid);
        result.set(key, current);
      }
    }
    return [...result.values()].sort((a,b) => a.name.localeCompare(b.name));
  });
}

function listCardInstallerPackages(context) {
  return withDatabase(context, (db) => db.prepare('SELECT uid, name, vendor, sdk_config AS sdkConfig, installer_package AS installerPackage FROM Devices WHERE COALESCE(sdk_support,0)=1').all().map(normalizeRow)
    .map((row) => {
      const name = bspPackageName(row.installerPackage);
      if (!name) return undefined;
      const config = sdkConfigObject(row.sdkConfig);
      return {
        name,
        displayName: row.name || row.uid,
        folderName: sdkFolderName(row.sdkConfig, '_MSDK_MCU_CARD_NAME_', name),
        mcuName: String(config.MCU_NAME || row.uid || '').trim(),
        deviceUid: row.uid,
        vendor: row.vendor
      };
    }).filter(Boolean).sort((a,b) => a.name.localeCompare(b.name)));
}

function listBoardInstallerPackages(context) {
  return withDatabase(context, (db) => db.prepare('SELECT uid, name, vendor, sdk_config AS sdkConfig, installer_package AS installerPackage FROM Boards').all().map(normalizeRow)
    .map((row) => {
      const name = bspPackageName(row.installerPackage);
      if (!name) return undefined;
      return { name, displayName: row.name || row.uid, folderName: sdkFolderName(row.sdkConfig, '_MSDK_BOARD_NAME_', name), boardUid: row.uid, vendor: row.vendor };
    }).filter(Boolean).sort((a,b) => a.name.localeCompare(b.name)));
}



function listCompilerInstallerPackages(context) {
  return withDatabase(context, (db) => {
    const rows = db.prepare(`
      SELECT
        c.uid,
        c.name,
        c.version,
        c.vendor,
        c.language,
        c.path,
        c.c_compiler AS cCompiler,
        c.cxx_compiler AS cxxCompiler,
        c.asm_compiler AS asmCompiler,
        c.gdb_path AS gdbPath,
        c.core_path AS corePath,
        c.installer_package AS installerPackage,
        COUNT(DISTINCT ctd.device_uid) AS mappedDeviceCount,
        COUNT(DISTINCT CASE WHEN COALESCE(d.sdk_support,0)=1 THEN ctd.device_uid END) AS supportedDeviceCount
      FROM Compilers c
      JOIN CompilerToBuildSystem ctb ON ctb.compiler_uid = c.uid AND ctb.build_system_uid = 'cmake'
      LEFT JOIN CompilerToDevice ctd ON ctd.compiler_uid = c.uid
      LEFT JOIN Devices d ON d.uid = ctd.device_uid
      WHERE COALESCE(c.installer_package,'') <> ''
      GROUP BY c.uid, c.name, c.version, c.vendor, c.language, c.path,
               c.c_compiler, c.cxx_compiler, c.asm_compiler, c.gdb_path,
               c.core_path, c.installer_package
      ORDER BY c.name COLLATE NOCASE
    `).all().map(normalizeRow);
    const grouped = new Map();
    for (const row of rows) {
      const packageName = String(row.installerPackage || '').trim();
      if (!packageName) continue;
      const current = grouped.get(packageName) || {
        name: packageName,
        displayName: row.name || packageName,
        compilerUids: [],
        compilerNames: [],
        databaseVersions: [],
        corePaths: [],
        binaryPaths: [],
        mappedDeviceCount: 0,
        supportedDeviceCount: 0
      };
      current.compilerUids.push(row.uid);
      current.compilerNames.push(row.name || row.uid);
      if (row.version && !current.databaseVersions.includes(row.version)) current.databaseVersions.push(row.version);
      if (row.corePath && !current.corePaths.includes(row.corePath)) current.corePaths.push(row.corePath);
      for (const binary of [row.cCompiler, row.cxxCompiler, row.asmCompiler, row.gdbPath]) {
        const value = String(binary || '').trim();
        if (value && !current.binaryPaths.includes(value)) current.binaryPaths.push(value);
      }
      current.mappedDeviceCount += Number(row.mappedDeviceCount || 0);
      current.supportedDeviceCount += Number(row.supportedDeviceCount || 0);
      if (current.compilerNames.length > 1) current.displayName = current.compilerNames.join(' / ');
      grouped.set(packageName, current);
    }
    return [...grouped.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  });
}

function listCmakeCompilers(context) {
  return withDatabase(context, (db) => db.prepare(`
    SELECT DISTINCT c.uid, c.name, c.version, c.vendor, c.language,
           c.path, c.c_compiler AS cCompiler, c.cxx_compiler AS cxxCompiler,
           c.asm_compiler AS asmCompiler, c.gdb_path AS gdbPath,
           c.core_path AS corePath, c.installer_package AS installerPackage,
           c.sdk_config AS sdkConfig
    FROM Compilers c
    JOIN CompilerToBuildSystem ctb ON ctb.compiler_uid = c.uid
    WHERE ctb.build_system_uid = 'cmake'
      AND COALESCE(c.installer_package,'') <> ''
    ORDER BY c.name COLLATE NOCASE
  `).all().map(normalizeRow));
}

function listProgrammerInstallerPackages(context) {
  return withDatabase(context, (db) => {
    return db.prepare(`SELECT uid, name, description, installer_package AS installerPackage FROM Programmers WHERE COALESCE(hidden,0)=0 ORDER BY name COLLATE NOCASE`).all().map(normalizeRow);
  });
}

function getSetupMetadata(context, selection) {
  return withDatabase(context, (db) => {
    const device = normalizeRow(db.prepare(`
      SELECT * FROM Devices WHERE uid = ? LIMIT 1
    `).get(selection.deviceUid));
    const compiler = normalizeRow(db.prepare(`
      SELECT * FROM Compilers WHERE uid = ? LIMIT 1
    `).get(selection.compilerUid));
    const sdk = normalizeRow(db.prepare(`
      SELECT * FROM SDKs WHERE uid = ? LIMIT 1
    `).get(selection.sdkUid));
    const compilerMapping = compiler && device
      ? db.prepare(`
          SELECT 1 AS ok
          FROM CompilerToDevice ctd
          JOIN CompilerToBuildSystem ctb ON ctb.compiler_uid = ctd.compiler_uid
          WHERE ctd.device_uid = ? AND ctd.compiler_uid = ? AND ctb.build_system_uid = 'cmake'
          LIMIT 1
        `).get(selection.deviceUid, selection.compilerUid)
      : undefined;
    const devicePackage = selection.packageUid
      ? normalizeRow(db.prepare('SELECT * FROM Packages WHERE uid = ? LIMIT 1').get(selection.packageUid))
      : undefined;
    const programmer = normalizeRow(db.prepare(`
        SELECT p.*, ptd.device_support_package AS device_support_package
        FROM Programmers p
        JOIN ProgrammerToDevice ptd ON ptd.programer_uid = p.uid
        WHERE p.uid = ? AND ptd.device_uid = ?
        LIMIT 1
      `).get(selection.programmerUid, selection.deviceUid));

    if (!device || !compiler || !sdk || !programmer || !compilerMapping) {
      throw new Error('The selected C setup is no longer complete or compiler-compatible in the NECTO database. Recreate it.');
    }

    const compilerConfig = sdkConfigObject(compiler.sdk_config);
    const deviceConfig = sdkConfigObject(device.sdk_config);
    const packageConfig = {
      ...sdkConfigObject(devicePackage?.sdk_config),
      ...sdkConfigObject(devicePackage?.stm_sdk_config)
    };
    const board = selection.boardUid
      ? normalizeRow(db.prepare('SELECT * FROM Boards WHERE uid = ? LIMIT 1').get(selection.boardUid))
      : undefined;
    const boardConfig = sdkConfigObject(board?.sdk_config);
    const mergedConfig = mergeSdkConfigSources({
      compiler: compilerConfig,
      device: deviceConfig,
      devicePackage: packageConfig,
      board: boardConfig
    });
    const sdkConfig = mergedConfig.merged;
    // MCU_NAME is the canonical target identity and must always come from the
    // selected Devices row. Board/package metadata may override other CMake
    // variables, but must never replace the actual MCU selected by the card.
    const mcuName = String(deviceConfig.MCU_NAME || device.uid || '').trim();
    if (!mcuName) {
      throw new Error(`${device.uid} does not define MCU_NAME in Devices.sdk_config.`);
    }
    sdkConfig.MCU_NAME = mcuName;
    if (Object.prototype.hasOwnProperty.call(deviceConfig, '_MSDK_MCU_CARD_NAME_')) {
      sdkConfig._MSDK_MCU_CARD_NAME_ = deviceConfig._MSDK_MCU_CARD_NAME_;
    }
    if (devicePackage) {
      sdkConfig._MSDK_PACKAGE_PIN_COUNT_ = String(devicePackage.pin_count || '').trim();
      sdkConfig._MSDK_PACKAGE_ID_ = String(
        packageConfig._MSDK_PACKAGE_NAME_ || devicePackage.uid || ''
      ).trim();
    }

    if (!String(compiler.core_path || '').trim()) {
      throw new Error(`${compiler.uid} does not define Compilers.core_path.`);
    }
    const coreRequirement = coreDeviceFor(db, device, compiler.uid);
    if (!coreRequirement.packageName) throw new Error(`${device.uid} does not define a core installer package for ${compiler.uid}.`);
    const cardPackageName = bspPackageName(device.installer_package);
    const boardPackageName = bspPackageName(board?.installer_package);
    const packageRequirements = {
      core: { name: coreRequirement.packageName, deviceUid: coreRequirement.device?.uid || device.uid, compilerUid: compiler.uid },
      card: cardPackageName ? {
        name: cardPackageName,
        folderName: sdkFolderName(device.sdk_config, '_MSDK_MCU_CARD_NAME_', cardPackageName),
        mcuName,
        deviceUid: device.uid,
        vendor: device.vendor
      } : undefined,
      board: boardPackageName ? { name: boardPackageName, folderName: sdkFolderName(board.sdk_config, '_MSDK_BOARD_NAME_', boardPackageName), boardUid: board.uid, vendor: board.vendor } : undefined
    };

    return {
      device: {
        // uid is retained only as the NECTO database relation key. All target
        // configuration/programmer/UI code should use mcuName instead.
        uid: device.uid,
        mcuName,
        name: device.name,
        vendor: device.vendor,
        familyUid: device.family_uid,
        flash: Number(device.flash || 0),
        ram: Number(device.ram || 0),
        maxSpeed: device.max_speed,
        defFile: device.def_file,
        compilerFlags: device.compiler_flags || '',
        linkerFlags: device.linker_flags || '',
        installerPackage: device.installer_package || ''
      },
      compiler: {
        uid: compiler.uid,
        name: compiler.name,
        version: compiler.version,
        packageName: String(compiler.installer_package || '').trim(),
        path: compiler.path || '',
        language: compiler.language || '',
        vendor: compiler.vendor || '',
        defaultOptions: compiler.default_options || '',
        cCompiler: compiler.c_compiler,
        cxxCompiler: compiler.cxx_compiler,
        asmCompiler: compiler.asm_compiler,
        gdbPath: compiler.gdb_path,
        clangdConfig: compiler.clangd_config || '',
        corePath: compiler.core_path
      },
      sdk: {
        uid: sdk.uid,
        name: sdk.name,
        version: sdk.version,
        packageName: 'mikrosdk'
      },
      devicePackage: devicePackage ? {
        uid: devicePackage.uid,
        name: devicePackage.name,
        pinCount: devicePackage.pin_count
      } : undefined,
      board: board ? {
        uid: board.uid,
        name: board.name,
        vendor: board.vendor,
        category: board.category,
        mikrobusCount: board.mikrobus_count,
        sdkConfig: boardConfig,
        installerPackage: board.installer_package || ''
      } : undefined,
      programmer: {
        uid: programmer.uid,
        name: programmer.name,
        packageName: String(programmer.installer_package || '').trim(),
        supportPackages: supportPackageNames(programmer.device_support_package)
      },
      packageRequirements,
      corePackageName: coreRequirement.packageName,
      coreMcuName: mcuName,
      // Keep the complete source maps as well as the merged map. This makes
      // setup.json self-describing and preserves future CMake variables added
      // to the database without requiring extension changes. Board values are
      // intentionally last and therefore override the same key from a device.
      sdkConfigSources: mergedConfig.sources,
      sdkConfig
    };
  });
}

module.exports = {
  resolveDatabasePath,
  validateDatabase,
  listDevices,
  listBoards,
  listBoardDevices,
  getBoard,
  getDeviceCoreInfo,
  listCompilers,
  listSdks,
  listDevicePackages,
  listProgrammers,
  getDevicePackageRequirements,
  listCoreInstallerPackages,
  listCardInstallerPackages,
  listBoardInstallerPackages,
  listCompilerInstallerPackages,
  listCmakeCompilers,
  listProgrammerInstallerPackages,
  getSetupMetadata,
  parseJson,
  _test: {
    versionParts,
    sdkConfigObject,
    mergeSdkConfigSources,
    compareVersionsDescending,
    corePackageName,
    supportPackageNames,
    installerPackageObject,
    bspPackageName,
    sdkFolderName
  }
};
