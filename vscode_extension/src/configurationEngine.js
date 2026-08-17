'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

function parseNumeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
  if (typeof value !== 'string') return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const parsed = /^0x/i.test(trimmed) ? Number.parseInt(trimmed, 16) : Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed >>> 0 : 0;
}

function fieldId(reg, field, index) {
  return `${reg.key}|${reg.address}|${field.key}|${index}`;
}

function defaultSelections(definition) {
  const selections = {};
  for (const reg of definition.config_registers || []) {
    (reg.fields || []).forEach((field, index) => {
      if (field.hidden) return;
      let value = field.init;
      if (Array.isArray(field.settings) && field.settings.length) {
        const initMatch = field.settings.find(item => String(item.value).toLowerCase() === String(field.init ?? '').toLowerCase());
        value = initMatch ? initMatch.value : field.settings[0].value;
      }
      selections[fieldId(reg, field, index)] = value ?? '0x0';
    });
  }
  return selections;
}

function computeCoreHeader(definition, selections, clockMhz) {
  const clock = Number.parseInt(String(clockMhz), 10);
  if (!Number.isFinite(clock) || clock <= 0) {
    throw new Error('Clock must be a positive integer in MHz.');
  }

  const lines = [];
  for (const reg of definition.config_registers || []) {
    let registerValue = 0;
    (reg.fields || []).forEach((field, index) => {
      const value = field.hidden
        ? (field.init ?? '0x0')
        : (selections[fieldId(reg, field, index)] ?? field.init ?? '0x0');
      registerValue = (registerValue | parseNumeric(value)) >>> 0;
    });
    lines.push(`pub const ADDRESS_${reg.key}: u32 = 0x${reg.address};`);
    lines.push(`pub const VALUE_${reg.key}: u32 = 0x${registerValue.toString(16).toUpperCase().padStart(8, '0')};`);
  }
  lines.push(`pub const FOSC_KHZ_VALUE: u32 = ${clock * 1000};`);
  return `${lines.join('\n')}\n`;
}

function getRustLanguageDefinition(definition) {
  const rust = (definition.language_list || []).find(item => String(item.language).toUpperCase() === 'RUST');
  if (!rust) throw new Error('MCU definition has no RUST entry in language_list.');
  return rust;
}

function renderCargoTemplates(definition, familyTemplate, halTemplate, familyName) {
  const rust = getRustLanguageDefinition(definition);
  let renderedFamily = familyTemplate;
  let renderedHal = halTemplate;

  for (const module of rust.module_list || []) {
    const moduleName = module.module_name;
    const subModules = [];
    for (const sub of module.sub_modules || []) {
      const features = Array.isArray(sub.pin_map_features) ? sub.pin_map_features : [];
      const featureText = features.map(v => JSON.stringify(v)).join(',');
      renderedFamily = renderedFamily.replaceAll(`{${sub.sub_module_name}_features}`, featureText);
      if (features.length) subModules.push(sub.sub_module_name);
    }
    renderedHal = renderedHal.replaceAll(`{${moduleName}}`, subModules.map(v => JSON.stringify(v)).join(','));
  }
  renderedHal = renderedHal.replaceAll('{family}', String(familyName).toLowerCase());
  return { familyCargo: renderedFamily, halCargo: renderedHal };
}

function normalizeKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function familyValue(record, aliases, fallbackIndex) {
  const named = record?.named || {};
  const normalizedAliases = aliases.map(normalizeKey);
  for (const [key, value] of Object.entries(named)) {
    if (normalizedAliases.includes(normalizeKey(key)) && value != null && value !== '') return value;
  }
  const raw = record?.raw || [];
  return raw[fallbackIndex];
}

function deriveModuleImplementations(familyRecord) {
  return {
    gpioPort: familyValue(familyRecord, ['gpio', 'gpio_port', 'gpioport'], 4),
    adc: familyValue(familyRecord, ['adc'], 5),
    i2c: familyValue(familyRecord, ['i2c'], 6),
    spi: familyValue(familyRecord, ['spi'], 7),
    tim: familyValue(familyRecord, ['tim', 'timer'], 8),
    uart: familyValue(familyRecord, ['uart'], 9),
  };
}

async function exists(filePath) {
  try { await fsp.access(filePath); return true; } catch (_) { return false; }
}

async function ensureFiles(paths) {
  const missing = [];
  for (const p of paths) {
    if (!(await exists(p))) missing.push(p);
  }
  if (missing.length) {
    throw new Error(`Configuration source files are missing:\n${missing.map(p => `  • ${p}`).join('\n')}`);
  }
}

async function copyFileEnsured(source, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.copyFile(source, destination);
}

async function copyTree(source, destination) {
  const stat = await fsp.stat(source);
  if (!stat.isDirectory()) throw new Error(`Expected directory: ${source}`);
  await fsp.mkdir(destination, { recursive: true });
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(src, dst);
    else if (entry.isFile()) await copyFileEnsured(src, dst);
  }
}

async function atomicWrite(destination, content) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.mikro-rust-${process.pid}-${Date.now()}.tmp`;
  await fsp.writeFile(temp, content, 'utf8');
  try {
    await fsp.rename(temp, destination);
  } catch (error) {
    // Windows may reject rename-over-existing. Fall back to a replace sequence.
    if (error && ['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) {
      await fsp.rm(destination, { force: true });
      await fsp.rename(temp, destination);
    } else {
      await fsp.rm(temp, { force: true });
      throw error;
    }
  }
}

function createPaths(rootPath, config) {
  const resolveConfigured = value => path.isAbsolute(value) ? value : path.resolve(rootPath, value);
  const coreRoot = resolveConfigured(config.corePath);
  const sdkRoot = resolveConfigured(config.sdkPath);
  const databasePath = resolveConfigured(config.databasePath);
  const platform = config.corePlatform.replace(/[\\/]+/g, path.sep);
  return {
    rootPath,
    coreRoot,
    sdkRoot,
    databasePath,
    corePlatformRoot: path.join(coreRoot, platform),
    sdkPlatformRoot: path.join(sdkRoot, 'targets', platform),
  };
}

async function loadMcuDefinition(paths, mcuName) {
  const definitionPath = path.join(paths.corePlatformRoot, 'mcu_definitions', `${mcuName}.json`);
  const raw = await fsp.readFile(definitionPath, 'utf8');
  return { definitionPath, definition: JSON.parse(raw) };
}

async function applyConfiguration({ paths, mcu, definition, selections, clockMhz }) {
  const familyLower = String(mcu.family).toLowerCase();
  const modules = deriveModuleImplementations(mcu.familyRecord);
  const missingModuleNames = Object.entries(modules).filter(([, value]) => value == null || value === '').map(([key]) => key);
  if (missingModuleNames.length) {
    throw new Error(`FAMILY database row does not provide implementation identifiers for: ${missingModuleNames.join(', ')}`);
  }

  const pinRoot = path.join(paths.corePlatformRoot, 'pin_mappings');
  const familyPinRoot = path.join(pinRoot, familyLower);
  const coreSources = {
    memory: path.join(paths.corePlatformRoot, 'memory', mcu.name, 'memory.x'),
    startup: path.join(paths.corePlatformRoot, 'startup', `${mcu.name.toLowerCase()}.s`),
    mcuHeader: path.join(paths.corePlatformRoot, 'mcu_headers', mcu.name, 'lib.rs'),
    reset: path.join(paths.corePlatformRoot, 'reset.rs'),
    initClock: path.join(paths.corePlatformRoot, 'system', mcu.systemName, 'init_clock.rs'),
    cargo: path.join(paths.corePlatformRoot, 'Cargo.toml'),
    lib: path.join(paths.corePlatformRoot, 'lib.rs'),
    commonHeader: path.join(paths.corePlatformRoot, 'common_header.rs'),
    familyCargoTemplate: path.join(familyPinRoot, 'Cargo_family_template.toml'),
    halCargoTemplate: path.join(pinRoot, 'hal_ll_Cargo_template.toml'),
    pinSrc: path.join(familyPinRoot, 'src'),
    cargoConfigTemplate: path.join(paths.sdkRoot, '.cargo', 'template_config.toml'),
  };

  const moduleSources = {
    gpio: path.join(paths.sdkPlatformRoot, 'gpio', 'hal_ll_gpio', 'gpio.rs'),
    gpioPort: path.join(paths.sdkPlatformRoot, 'gpio', 'gpio_port', String(modules.gpioPort), 'gpio_port.rs'),
    adc: path.join(paths.sdkPlatformRoot, 'adc', String(modules.adc), 'adc.rs'),
    i2c: path.join(paths.sdkPlatformRoot, 'i2c', String(modules.i2c), 'i2c_master.rs'),
    spi: path.join(paths.sdkPlatformRoot, 'spi', String(modules.spi), 'spi_master.rs'),
    tim: path.join(paths.sdkPlatformRoot, 'tim', String(modules.tim), 'tim.rs'),
    uart: path.join(paths.sdkPlatformRoot, 'uart', String(modules.uart), 'uart.rs'),
    oneWire: path.join(paths.sdkPlatformRoot, 'one_wire', 'implementation_1', 'one_wire.rs'),
  };

  await ensureFiles([
    coreSources.memory, coreSources.startup, coreSources.mcuHeader, coreSources.reset,
    coreSources.initClock, coreSources.cargo, coreSources.lib, coreSources.commonHeader,
    coreSources.familyCargoTemplate, coreSources.halCargoTemplate, coreSources.pinSrc,
    coreSources.cargoConfigTemplate,
    ...Object.values(moduleSources),
  ]);

  const [familyTemplate, halTemplate, cargoConfigTemplate] = await Promise.all([
    fsp.readFile(coreSources.familyCargoTemplate, 'utf8'),
    fsp.readFile(coreSources.halCargoTemplate, 'utf8'),
    fsp.readFile(coreSources.cargoConfigTemplate, 'utf8'),
  ]);
  const rendered = renderCargoTemplates(definition, familyTemplate, halTemplate, familyLower);
  const coreHeader = computeCoreHeader(definition, selections, clockMhz);
  const cargoConfig = cargoConfigTemplate.replaceAll('{compiling_target}', mcu.target);

  const stage = path.join(paths.sdkRoot, `.setup.mikro-rust-stage-${process.pid}-${Date.now()}`);
  const stageCore = path.join(stage, 'core');
  const stageSdk = path.join(stage, 'sdk');
  await fsp.rm(stage, { recursive: true, force: true });
  await fsp.mkdir(path.join(stageCore, 'src'), { recursive: true });
  await fsp.mkdir(stageSdk, { recursive: true });

  try {
    await atomicWrite(path.join(stageCore, 'src', 'core_header.rs'), coreHeader);
    await copyFileEnsured(coreSources.memory, path.join(stageCore, 'memory.x'));
    await copyFileEnsured(coreSources.startup, path.join(stageCore, 'src', 'startup.s'));
    await copyFileEnsured(coreSources.mcuHeader, path.join(stageCore, 'src', 'mcu_header.rs'));
    await copyFileEnsured(coreSources.reset, path.join(stageCore, 'src', 'reset.rs'));
    await copyFileEnsured(coreSources.initClock, path.join(stageCore, 'src', 'init_clock.rs'));
    await copyFileEnsured(coreSources.cargo, path.join(stageCore, 'Cargo.toml'));
    await copyFileEnsured(coreSources.lib, path.join(stageCore, 'src', 'lib.rs'));
    await copyFileEnsured(coreSources.commonHeader, path.join(stageCore, 'src', 'common_header.rs'));
    await copyTree(coreSources.pinSrc, path.join(stageSdk, 'src'));
    await atomicWrite(path.join(stageSdk, 'Cargo.toml'), rendered.familyCargo);

    const manifest = {
      schemaVersion: 1,
      generatedBy: 'mikro-rust-configurator',
      generatedAt: new Date().toISOString(),
      mcu: {
        name: mcu.name,
        vendor: mcu.vendor,
        family: mcu.family,
        target: mcu.target,
        systemName: mcu.systemName,
      },
      clockMhz: Number.parseInt(String(clockMhz), 10),
      selections,
      modules,
      platform: path.relative(paths.coreRoot, paths.corePlatformRoot).replace(/\\/g, '/'),
    };
    await atomicWrite(path.join(stage, 'mikro-rust-config.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    // All source material has been validated before touching active project files.
    await atomicWrite(path.join(paths.sdkRoot, '.cargo', 'config.toml'), cargoConfig);
    await atomicWrite(path.join(paths.sdkPlatformRoot, 'Cargo.toml'), rendered.halCargo);
    const destinationMap = {
      gpio: 'gpio.rs', gpioPort: 'gpio_port.rs', adc: 'adc.rs', i2c: 'i2c_master.rs',
      spi: 'spi_master.rs', tim: 'tim.rs', uart: 'uart.rs', oneWire: 'one_wire.rs',
    };
    for (const [key, filename] of Object.entries(destinationMap)) {
      await copyFileEnsured(moduleSources[key], path.join(paths.sdkPlatformRoot, 'src', filename));
    }

    const activeSetup = path.join(paths.sdkRoot, '.setup');
    const oldSetup = path.join(paths.sdkRoot, `.setup.mikro-rust-old-${process.pid}-${Date.now()}`);
    let movedOldSetup = false;
    if (await exists(activeSetup)) {
      await fsp.rename(activeSetup, oldSetup);
      movedOldSetup = true;
    }
    try {
      await fsp.rename(stage, activeSetup);
    } catch (error) {
      if (movedOldSetup && !(await exists(activeSetup)) && await exists(oldSetup)) {
        await fsp.rename(oldSetup, activeSetup);
      }
      throw error;
    }
    await fsp.rm(oldSetup, { recursive: true, force: true });
    return manifest;
  } catch (error) {
    await fsp.rm(stage, { recursive: true, force: true });
    throw error;
  }
}

async function readManifest(paths) {
  const manifestPath = path.join(paths.sdkRoot, '.setup', 'mikro-rust-config.json');
  try {
    return JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch (_) {
    return undefined;
  }
}

module.exports = {
  parseNumeric,
  fieldId,
  defaultSelections,
  computeCoreHeader,
  renderCargoTemplates,
  deriveModuleImplementations,
  createPaths,
  loadMcuDefinition,
  applyConfiguration,
  readManifest,
};
