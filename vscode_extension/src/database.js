'use strict';

const fs = require('fs');
const path = require('path');
const { runProcess } = require('./process');

class DatabaseClient {
  constructor(extensionPath, pythonPath = '') {
    this.extensionPath = extensionPath;
    this.pythonPath = pythonPath;
    this._runner = undefined;
  }

  async listMcus(databasePath) {
    this._assertDb(databasePath);
    try {
      return await this._pythonCall('list-mcus', databasePath);
    } catch (pythonError) {
      try {
        return await this._sqliteCall('list-mcus', databasePath);
      } catch (sqliteError) {
        throw new Error(
          `Cannot read MCU database. Python helper failed: ${pythonError.message}. ` +
          `sqlite3 fallback failed: ${sqliteError.message}`
        );
      }
    }
  }

  async getMcuDetails(databasePath, mcuName) {
    this._assertDb(databasePath);
    try {
      return await this._pythonCall('mcu-details', databasePath, mcuName);
    } catch (pythonError) {
      try {
        return await this._sqliteCall('mcu-details', databasePath, mcuName);
      } catch (sqliteError) {
        throw new Error(
          `Cannot read MCU details. Python helper failed: ${pythonError.message}. ` +
          `sqlite3 fallback failed: ${sqliteError.message}`
        );
      }
    }
  }

  _assertDb(databasePath) {
    if (!fs.existsSync(databasePath)) {
      throw new Error(`MCU database not found: ${databasePath}`);
    }
  }

  async _findPython() {
    if (this._runner) return this._runner;
    const candidates = [];
    if (this.pythonPath) candidates.push({ command: this.pythonPath, prefix: [] });
    if (process.platform === 'win32') {
      candidates.push({ command: 'py', prefix: ['-3'] }, { command: 'python', prefix: [] }, { command: 'python3', prefix: [] });
    } else {
      candidates.push({ command: 'python3', prefix: [] }, { command: 'python', prefix: [] });
    }

    for (const candidate of candidates) {
      try {
        const result = await runProcess(candidate.command, [...candidate.prefix, '--version'], { allowNonZero: true });
        if (result.code === 0) {
          this._runner = candidate;
          return candidate;
        }
      } catch (_) {
        // try next candidate
      }
    }
    throw new Error('No usable Python 3 interpreter found');
  }

  async _pythonCall(action, databasePath, mcuName) {
    const python = await this._findPython();
    const helper = path.join(this.extensionPath, 'scripts', 'db_helper.py');
    const args = [...python.prefix, helper, action, '--db', databasePath];
    if (mcuName) args.push('--mcu', mcuName);
    const result = await runProcess(python.command, args);
    return JSON.parse(result.stdout);
  }

  async _sqliteCall(action, databasePath, mcuName) {
    const escapeSql = value => String(value).replace(/'/g, "''");
    if (action === 'list-mcus') {
      const query = 'SELECT NAME AS name FROM MCU ORDER BY NAME COLLATE NOCASE;';
      const result = await runProcess('sqlite3', ['-json', databasePath, query]);
      return JSON.parse(result.stdout || '[]').map(row => row.name);
    }

    const name = escapeSql(mcuName);
    const detailQuery =
      `SELECT Family.VENDOR AS vendor, Family.TARGET AS target, MCU.SYSTEM_LIB AS systemName, MCU.FAMILY AS family ` +
      `FROM MCU JOIN FAMILY ON MCU.FAMILY = FAMILY.NAME WHERE MCU.NAME = '${name}';`;
    const familyQuery =
      `SELECT FAMILY.* FROM MCU JOIN FAMILY ON MCU.FAMILY = FAMILY.NAME WHERE MCU.NAME = '${name}';`;

    const detailResult = await runProcess('sqlite3', ['-json', databasePath, detailQuery]);
    const details = JSON.parse(detailResult.stdout || '[]')[0];
    if (!details) throw new Error(`MCU not found in database: ${mcuName}`);

    const familyResult = await runProcess('sqlite3', ['-json', databasePath, familyQuery]);
    const familyNamed = JSON.parse(familyResult.stdout || '[]')[0] || {};
    const columns = Object.keys(familyNamed);
    const raw = columns.map(key => familyNamed[key]);
    return {
      name: mcuName,
      vendor: details.vendor,
      target: details.target,
      systemName: details.systemName,
      family: details.family,
      familyRecord: { columns, raw, named: familyNamed },
    };
  }
}

module.exports = { DatabaseClient };
