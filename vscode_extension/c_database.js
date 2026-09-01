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
  const managedDatabaseRoot = path.join(getManagedRoot(context), 'c-runtime', 'packages', 'database', 'C_database', '0.0.1');
  const discoveredManagedDatabase = findFileRecursive(managedDatabaseRoot, 'necto_db.db');
  const candidates = [
    configured ? path.resolve(expandHome(configured)) : undefined,
    discoveredManagedDatabase,
    path.join(managedDatabaseRoot, 'necto_db.db'),
    path.join(getManagedRoot(context), 'c-runtime', 'packages', 'database', 'C_database', '0.0.1', 'database', 'necto_db.db'),
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
      d.def_file AS defFile
    FROM Devices d
    JOIN CompilerToDevice ctd ON ctd.device_uid = d.uid
    WHERE COALESCE(d.sdk_support, 0) = 1
      AND ctd.compiler_uid IN (${placeholders(supportedCompilerUids.length)})
      AND d.uid NOT LIKE 'MCU_CARD_%'
      AND d.uid NOT LIKE 'SIBRAIN_%'
    ORDER BY d.uid COLLATE NOCASE
  `).all(...supportedCompilerUids).map(normalizeRow));
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
      AND d.uid NOT LIKE 'MCU_CARD_%'
      AND d.uid NOT LIKE 'SIBRAIN_%'
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
      AND d.uid NOT LIKE 'MCU_CARD_%'
      AND d.uid NOT LIKE 'SIBRAIN_%'
    ORDER BY boardPriority, d.uid COLLATE NOCASE
  `).all(boardUid, ...supportedCompilerUids).map(normalizeRow));
}

function getBoard(context, boardUid) {
  return withDatabase(context, (db) => {
    const row = normalizeRow(db.prepare(`
      SELECT uid, name, vendor, category, default_device AS defaultDevice,
             soldered_device AS solderedDevice, mikrobus_count AS mikrobusCount,
             sdk_config AS sdkConfig
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
      sdkConfig
    };
  });
}

function listCompilers(context, deviceUid, supportedCompilerUids) {
  if (!Array.isArray(supportedCompilerUids) || supportedCompilerUids.length === 0) return [];
  return withDatabase(context, (db) => db.prepare(`
    SELECT
      c.uid,
      c.name,
      c.version,
      c.vendor,
      c.language,
      c.path,
      c.c_compiler AS cCompiler,
      c.cxx_compiler AS cxxCompiler,
      c.gdb_path AS gdbPath,
      c.asm_compiler AS asmCompiler,
      c.core_path AS corePath,
      c.installer_package AS installerPackage,
      c.sdk_config AS sdkConfig
    FROM Compilers c
    JOIN CompilerToDevice ctd ON ctd.compiler_uid = c.uid
    WHERE ctd.device_uid = ?
      AND c.uid IN (${placeholders(supportedCompilerUids.length)})
    ORDER BY c.name COLLATE NOCASE
  `).all(deviceUid, ...supportedCompilerUids).map(normalizeRow));
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

    if (!device || !compiler || !sdk || !programmer) {
      throw new Error('The selected C setup is no longer complete in the NECTO database. Recreate it.');
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
    if (devicePackage) {
      sdkConfig._MSDK_PACKAGE_PIN_COUNT_ = String(devicePackage.pin_count || '').trim();
      sdkConfig._MSDK_PACKAGE_ID_ = String(
        packageConfig._MSDK_PACKAGE_NAME_ || devicePackage.uid || ''
      ).trim();
    }

    const mcuName = String(deviceConfig.MCU_NAME || device.uid || '').trim();
    if (!mcuName) {
      throw new Error(`${device.uid} does not define MCU_NAME in Devices.sdk_config.`);
    }
    if (!String(compiler.core_path || '').trim()) {
      throw new Error(`${compiler.uid} does not define Compilers.core_path.`);
    }

    return {
      device: {
        uid: device.uid,
        name: device.name,
        vendor: device.vendor,
        familyUid: device.family_uid,
        flash: Number(device.flash || 0),
        ram: Number(device.ram || 0),
        maxSpeed: device.max_speed,
        defFile: device.def_file,
        compilerFlags: device.compiler_flags || '',
        linkerFlags: device.linker_flags || ''
      },
      compiler: {
        uid: compiler.uid,
        name: compiler.name,
        version: compiler.version,
        packageName: String(compiler.installer_package || '').trim(),
        cCompiler: compiler.c_compiler,
        cxxCompiler: compiler.cxx_compiler,
        asmCompiler: compiler.asm_compiler,
        gdbPath: compiler.gdb_path,
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
        sdkConfig: boardConfig
      } : undefined,
      programmer: {
        uid: programmer.uid,
        name: programmer.name,
        packageName: String(programmer.installer_package || '').trim(),
        supportPackages: supportPackageNames(programmer.device_support_package)
      },
      corePackageName: 'C_core',
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
  getSetupMetadata,
  parseJson,
  _test: {
    versionParts,
    sdkConfigObject,
    mergeSdkConfigSources,
    compareVersionsDescending,
    corePackageName,
    supportPackageNames
  }
};
