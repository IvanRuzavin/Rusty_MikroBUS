'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const database = require('./c_database');
const packages = require('./c_package_manager');
const codegripCatalog = require('./c_codegrip_catalog');
const compilerSupport = require('./c_compiler_support');
const { openCConfigurator } = require('./c_configurator');
const {
  discoverUsbCodegrips,
  normalizeConnectionProfile,
  programCodegrip,
  eraseCodegrip,
  prepareCodegripDebug,
  stopCodegripServer
} = require('./codegrip_backend');

// Compiler compatibility comes from CompilerToDevice. Host invocation details
// are centralized separately so package/UI/setup code use one compiler model.
const COMPILER_ADAPTERS = compilerSupport.COMPILER_ADAPTERS;

const SUPPORTED_PROGRAMMERS = new Set(['codegrip', 'segger_jlink']);

function metadataMcuName(metadata = {}) {
  return String(metadata?.device?.mcuName || metadata?.sdkConfig?.MCU_NAME || metadata?.device?.uid || '').trim();
}

function setupMcuName(setup = {}) {
  return metadataMcuName(setup.metadata || {});
}
const C_BUILD_SUPPORT_VERSION = 22;
const output = vscode.window.createOutputChannel('MikroBUS C');
let sourceMutationQueue = Promise.resolve();
let activeExternalDebugRuntime;

function supportedCompilerUids() {
  return compilerSupport.supportedCompilerUids();
}

function safeId(value) {
  return String(value || '').trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'c-setup';
}

function quoteCmake(value) {
  return String(value || '').replace(/\\/g, '/').replace(/"/g, '\\"');
}

function workspaceRoot() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('Open a workspace folder before applying or building a C setup.');
  return folder.uri.fsPath;
}

function pathIsInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function findCmakeProjectRoot(startPath, workspace = workspaceRoot()) {
  let current = startPath || workspace;
  try {
    if (fs.existsSync(current) && fs.statSync(current).isFile()) current = path.dirname(current);
  } catch {
    current = workspace;
  }
  current = path.resolve(current);
  const boundary = path.resolve(workspace);
  while (pathIsInside(current, boundary)) {
    if (fs.existsSync(path.join(current, 'CMakeLists.txt'))) return current;
    if (current === boundary) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return fs.existsSync(path.join(boundary, 'CMakeLists.txt')) ? boundary : boundary;
}

function cProjectRoot() {
  const workspace = workspaceRoot();
  const editor = vscode.window.activeTextEditor;
  const document = editor?.document;
  if (document?.uri?.scheme === 'file' && document.uri.fsPath && pathIsInside(document.uri.fsPath, workspace)) {
    return findCmakeProjectRoot(document.uri.fsPath, workspace);
  }
  return findCmakeProjectRoot(workspace, workspace);
}

async function hideCppToolsActiveFileShortcut(root = cProjectRoot()) {
  try {
    const resource = vscode.Uri.file(root);
    const folder = vscode.workspace.getWorkspaceFolder?.(resource);
    const config = vscode.workspace.getConfiguration('C_Cpp', resource);
    if (!config?.update) return;
    const target = folder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
    await config.update('debugShortcut', false, target);
  } catch (error) {
    output.appendLine(`Could not hide the C/C++ active-file shortcut: ${error.message || error}`);
  }
}

function setupDirectory(context, setupId) {
  return path.join(packages.getPackagePaths(context).setups, safeId(setupId));
}

function setupFile(context, setupId) {
  return path.join(setupDirectory(context, setupId), 'setup.json');
}

function readJson(filePath, description) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${description || path.basename(filePath)} is invalid: ${error.message}`);
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function listSetups(context) {
  const root = packages.getPackagePaths(context).setups;
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const name of fs.readdirSync(root)) {
    const filePath = setupFile(context, name);
    if (!fs.existsSync(filePath)) continue;
    try {
      result.push(readJson(filePath, `C setup ${name}`));
    } catch (error) {
      output.appendLine(error.message);
    }
  }
  return result.sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function getWorkspaceBinding(root = cProjectRoot()) {
  const bindingPath = path.join(root, '.vscode', 'mikrobus-c.json');
  if (!fs.existsSync(bindingPath)) {
    throw new Error('This workspace has no C setup. Run “MikroBUS C: Apply Setup to Workspace”.');
  }
  return { bindingPath, binding: readJson(bindingPath, 'Workspace C setup binding') };
}

function getBoundSetup(context, root = cProjectRoot()) {
  const { binding } = getWorkspaceBinding(root);
  const filePath = setupFile(context, binding.setupId);
  if (!fs.existsSync(filePath)) throw new Error(`C setup '${binding.setupId}' no longer exists. Apply another setup.`);
  return readJson(filePath, `C setup ${binding.setupId}`);
}

function quickPick(items, options) {
  if (!items.length) throw new Error(options.emptyMessage || 'No compatible choices were found.');
  return vscode.window.showQuickPick(items, { ignoreFocusOut: true, matchOnDescription: true, matchOnDetail: true, ...options });
}

async function chooseSetupSelection(context) {
  database.validateDatabase(context);
  const devices = database.listDevices(context, supportedCompilerUids());
  const devicePick = await quickPick(devices.map((device) => ({
    label: device.uid,
    description: device.vendor || '',
    detail: `${device.name || device.uid} · ${device.flash || '?'} bytes flash · ${device.ram || '?'} bytes RAM`,
    value: device
  })), { placeHolder: 'Select a C target MCU', emptyMessage: 'No supported C targets are present in the configured database.' });
  if (!devicePick) return;

  const compilers = database.listCompilers(context, devicePick.value.uid, supportedCompilerUids());
  const compilerPick = await quickPick(compilers.map((compiler) => ({
    label: compiler.name,
    description: `${compiler.uid} ${compiler.version || ''}`.trim(),
    value: compiler
  })), { placeHolder: 'Select a C compiler', emptyMessage: `No supported C compiler is mapped to ${devicePick.value.uid}.` });
  if (!compilerPick) return;

  const modes = await quickPick([
    { label: 'Bare metal (core files)', description: 'Build and install the MCU core only.', value: 'bare-metal' },
    { label: 'Full mikroSDK (SDK + core)', description: 'Build the MCU core, then the selected mikroSDK.', value: 'full-sdk' }
  ], { placeHolder: 'Select the setup type' });
  if (!modes) return;

  const sdks = database.listSdks(context, devicePick.value.uid, compilerPick.value.uid);
  const sdkPick = await quickPick(sdks.map((sdk) => ({
    label: `${sdk.name} ${sdk.version}`,
    description: sdk.uid,
    value: sdk
  })), { placeHolder: modes.value === 'full-sdk' ? 'Select the supported mikroSDK version' : 'Select metadata version used for compatibility', emptyMessage: `No non-legacy mikroSDK is mapped to ${devicePick.value.uid} for ${compilerPick.value.uid}.` });
  if (!sdkPick) return;

  const devicePackages = database.listDevicePackages(context, devicePick.value.uid);
  const packagePick = devicePackages.length
    ? await quickPick(devicePackages.map((devicePackage) => ({
      label: devicePackage.name || devicePackage.uid,
      description: devicePackage.pinCount ? `${devicePackage.pinCount} pins` : devicePackage.uid,
      value: devicePackage
    })), { placeHolder: 'Select the MCU package' })
    : undefined;
  if (devicePackages.length && !packagePick) return;

  const programmers = database.listProgrammers(context, devicePick.value.uid, compilerPick.value.uid)
    .filter((programmer) => SUPPORTED_PROGRAMMERS.has(programmer.uid));
  const programmerPick = await quickPick(programmers.map((programmer) => ({
    label: programmer.name,
    description: programmer.uid,
    detail: programmer.description || '',
    value: programmer
  })), { placeHolder: 'Select programmer/debug probe', emptyMessage: `No supported programmer is mapped to ${devicePick.value.uid}.` });
  if (!programmerPick) return;

  const applicationOutputPick = await quickPick([
    { label: 'Debug Terminal (printf_me)', description: 'Build MikroSDK.Log with LOG_INTERFACE_STDOUT; no USB UART pins are required.', value: 'debug-terminal' },
    { label: 'UART', description: 'Build MikroSDK.Log with LOG_INTERFACE_UART and use the board USB_UART_RX / USB_UART_TX mapping.', value: 'uart' }
  ], { placeHolder: 'Select application output' });
  if (!applicationOutputPick) return;

  const defaultClock = String(devicePick.value.maxSpeed || '').replace(/\.0+$/, '');
  const clock = await vscode.window.showInputBox({
    title: 'MCU clock (MHz)',
    value: defaultClock,
    prompt: `Maximum reported by the database: ${defaultClock || 'not reported'} MHz`,
    ignoreFocusOut: true,
    validateInput: (value) => Number(value) > 0 ? undefined : 'Enter a positive clock frequency in MHz.'
  });
  if (!clock) return;

  const suggestedName = `${devicePick.value.uid} ${modes.value === 'full-sdk' ? `mikroSDK ${sdkPick.value.version}` : 'Bare Metal'}`;
  const name = await vscode.window.showInputBox({
    title: 'Reusable C setup name',
    value: suggestedName,
    ignoreFocusOut: true,
    validateInput: (value) => String(value).trim() ? undefined : 'Enter a setup name.'
  });
  if (!name) return;

  return {
    name: name.trim(),
    mode: modes.value,
    applicationOutput: applicationOutputPick.value,
    clockMHz: String(clock).trim(),
    deviceUid: devicePick.value.uid,
    compilerUid: compilerPick.value.uid,
    sdkUid: sdkPick.value.uid,
    packageUid: packagePick?.value.uid,
    programmerUid: programmerPick.value.uid
  };
}

function codegripPackSpec(pkg) {
  return {
    kind: 'programmer-pack',
    name: pkg.packageName,
    version: pkg.packageVersion || 'current',
    displayName: pkg.displayName || pkg.packageName,
    downloadUrl: pkg.downloadUrl,
    environment: false
  };
}

async function packageSpecs(context, metadata, mode, setup, token) {
  const core = await packages.corePackageSpec(context, metadata.packageRequirements?.core?.name || metadata.corePackageName, metadata.compiler.uid, token);
  const result = [
    { kind: 'database', name: 'C_database', version: 'live', displayName: 'NECTO live database', environment: true },
    core,
    { kind: 'infrastructure', name: 'unit_test_lib', version: 'general_packages_assets', displayName: 'Unit Test Library', environment: true },
    { kind: 'infrastructure', name: 'preinit', version: 'general_packages_assets', displayName: 'Preinit Routines', environment: true },
    { kind: 'infrastructure', name: 'mikroe_utils_common', version: 'general_packages_assets', displayName: 'MIKROE Common CMake Utilities', environment: true },
    await packages.compilerPackageSpec(context, metadata.compiler, token)
  ];
  if (mode === 'full-sdk') {
    result.push(await packages.sdkPackageSpec(token));
    if (metadata.packageRequirements?.card) {
      const cardRequirement = {
        ...metadata.packageRequirements.card,
        mcuName: String(
          metadata.packageRequirements.card.mcuName ||
          metadata.device?.mcuName ||
          metadata.sdkConfig?.MCU_NAME ||
          metadata.device?.uid ||
          ''
        ).trim()
      };
      result.push(await packages.bspPackageSpec('bsp-card', cardRequirement, token));
    }
    if (metadata.packageRequirements?.board) result.push(await packages.bspPackageSpec('bsp-board', metadata.packageRequirements.board, token));
  }
  if (metadata.programmer.uid === 'codegrip') {
    result.push({ kind: 'programmer', name: 'codegrip_gdb_server', version: '1.7.0', displayName: 'CODEGRIP Suite', environment: true });
    for (const pkg of setup?.codegripCatalog?.packages || []) result.push(codegripPackSpec(pkg));
  }
  return result;
}

async function buildPackageSpecs(context, metadata, mode, setup, token) {
  return packageSpecs(context, metadata, mode, setup, token);
}

function findRecursive(root, predicate, maximumDepth = 6) {
  if (!root || !fs.existsSync(root)) return undefined;
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(current.directory, entry.name);
      if ((entry.isFile() || entry.isSymbolicLink()) && predicate(candidate, entry.name)) return candidate;
      if (entry.isDirectory() && current.depth < maximumDepth) queue.push({ directory: candidate, depth: current.depth + 1 });
    }
  }
  return undefined;
}

function findDirectoryContaining(root, fileName, maximumDepth = 5) {
  const found = findRecursive(root, (_candidate, name) => name === fileName, maximumDepth);
  return found ? path.dirname(found) : undefined;
}

function configuredArmGccRoot() {
  const configured = String(vscode.workspace.getConfiguration('mikrobusRust').get('armGccBinPath', '') || '').trim();
  if (!configured) return undefined;
  const resolved = path.resolve(configured.replace(/^~(?=$|[\\/])/, require('os').homedir()));
  try { return fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved); } catch { return undefined; }
}

function executableExtensions(name) {
  return process.platform === 'win32' && !path.extname(name) ? [`${name}.exe`, name] : [name];
}

function resolveTool(toolchainEntry, names, relativeName, additionalRoots = []) {
  const roots = [...additionalRoots, toolchainEntry?.root].filter(Boolean);
  const relative = String(relativeName || '').replace(/[\\/]+/g, path.sep);
  for (const root of roots) {
    const direct = relative ? path.join(root, relative) : undefined;
    const candidates = direct ? [direct, ...executableExtensions(direct)] : [];
    for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
    for (const name of names || []) {
      const found = findRecursive(root, (_candidate, fileName) => executableExtensions(name).includes(fileName), 8);
      if (found) return found;
    }
  }
  return packages.findOnPath(names || []);
}

function resolveToolchain(setup, installed) {
  const adapter = COMPILER_ADAPTERS[setup.metadata.compiler.uid];
  if (!adapter) throw new Error(`No C compiler adapter is registered for ${setup.metadata.compiler.uid}.`);
  const packageName = String(setup.metadata.compiler.packageName || '').trim();
  const allInstalled = [...installed.values(), ...packages.listInstalledPackages(setup.context, true)];
  const entry = allInstalled.find((item) => item.kind === 'toolchain' && item.name === packageName);
  const configuredRoots = setup.metadata.compiler.uid === 'gcc_arm_none_eabi' ? [configuredArmGccRoot()].filter(Boolean) : [];
  // Compilers.path is NECTO's package-relative toolchain location; the
  // executable fields (c_compiler/cxx_compiler/asm_compiler/gdb_path) are the
  // authoritative binary paths. Always resolve the C compiler from c_compiler.
  const c = resolveTool(entry, adapter.executableNames.c, setup.metadata.compiler.cCompiler, configuredRoots);
  const hasCxx = Boolean(String(setup.metadata.compiler.cxxCompiler || '').trim()) || (adapter.executableNames.cxx || []).length > 0;
  const cxx = hasCxx ? resolveTool(entry, adapter.executableNames.cxx, setup.metadata.compiler.cxxCompiler, configuredRoots) : undefined;
  // Keep the raw assembler from Compilers.asm_compiler available for explicit
  // jobs, but use the compiler driver for CMake ASM whenever the adapter says
  // so. This is required for normal target_compile_definitions() on startup ASM.
  const assembler = resolveTool(entry, adapter.executableNames.asm, setup.metadata.compiler.asmCompiler, configuredRoots);
  const cmakeAsm = adapter.cmakeAsmViaCCompiler ? c : (assembler || c);
  const gdb = resolveTool(entry, adapter.executableNames.gdb, setup.metadata.compiler.gdbPath, configuredRoots);
  const objcopy = resolveTool(entry, adapter.executableNames.objcopy, '', configuredRoots);
  if (!c) throw new Error(`The ${setup.metadata.compiler.name} package is installed but its C compiler was not found.`);
  return { c, cxx, asm: cmakeAsm, cmakeAsm, assembler, gdb, objcopy, adapter, root: entry?.root || path.dirname(c), packageEntry: entry };
}

function resolveBuildTool(name, alternatives = []) {
  const configured = String(vscode.workspace.getConfiguration('mikrobusRust').get(`c${name[0].toUpperCase()}${name.slice(1)}Path`, '') || '').trim();
  if (configured && fs.existsSync(configured)) return configured;
  return packages.findOnPath([name, ...alternatives]);
}

function packageRoot(installed, kind, name, version) {
  const entry = installed.get(packages.packageKey({ kind, name, version }));
  if (!entry?.root || !fs.existsSync(entry.root)) throw new Error(`Installed package ${kind}:${name} has no usable payload.`);
  return entry.root;
}

function locateSdkSource(root) {
  const candidates = [path.join(root, 'src'), path.join(root, 'mikroSDK_v2', 'src')];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'CMakeLists.txt')))
    || findDirectoryContaining(root, 'CMakeLists.txt', 3);
}

function locateCoreSource(root, compilerCorePath, mcuName) {
  const relative = String(compilerCorePath || '').replace(/[\\/]+/g, path.sep);
  const compilerRoot = relative && fs.existsSync(path.join(root, relative)) ? path.join(root, relative) : root;
  const expectedDef = `${String(mcuName || '').trim()}.json`.toLowerCase();
  if (expectedDef !== '.json') {
    const definition = findRecursive(compilerRoot, (_candidate, name) => name.toLowerCase() === expectedDef, 8);
    if (definition) {
      let current = path.dirname(definition);
      for (let depth = 0; depth < 6; depth += 1) {
        if (fs.existsSync(path.join(current, 'CMakeLists.txt')) && fs.existsSync(path.join(current, 'include', 'core_header.h.in'))) return current;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
  }
  const direct = findRecursive(compilerRoot, (_candidate, name) => name === 'core_header.h.in', 8);
  return direct ? path.dirname(path.dirname(direct)) : undefined;
}

function registerFieldId(register, field) {
  return `${String(register?.key || '').trim()}.${String(field?.key || '').trim()}`;
}

function defaultRegisterValue(register, selectedValues = {}) {
  let value = Number.parseInt(String(register.default || register.unused || '0').replace(/^0x|\$/i, ''), 16) || 0;
  for (const field of Array.isArray(register.fields) ? register.fields : []) {
    const mask = Number.parseInt(String(field.mask || '0').replace(/^0x|\$/i, ''), 16) || 0;
    const fieldId = registerFieldId(register, field);
    const hasSelectedValue = Object.prototype.hasOwnProperty.call(selectedValues || {}, fieldId)
      && String(selectedValues[fieldId] ?? '').trim() !== '';
    // Range-backed fields (for example STM32 PLLN) used to be rendered as an
    // empty <select>, which saved an empty string into registerValues. Treat an
    // empty UI value as "no override" so the MCU JSON init value is preserved.
    const selected = hasSelectedValue ? selectedValues[fieldId] : field.init;
    const initial = Number.parseInt(String(selected || '0').replace(/^0x|\$/i, ''), 16) || 0;
    value = (value & ~mask) | (initial & mask);
  }
  return value >>> 0;
}

function generateCoreHeader(coreSource, metadata, clockMHz, outputDirectory, registerValues = {}) {
  const templatePath = path.join(coreSource, 'include', 'core_header.h.in');
  const definitionPath = path.join(coreSource, 'def', metadata.device.defFile);
  if (!fs.existsSync(templatePath)) throw new Error(`Core header template was not found: ${templatePath}`);
  if (!fs.existsSync(definitionPath)) throw new Error(`MCU definition was not found: ${definitionPath}`);
  const mcuName = metadataMcuName(metadata);
  const definition = readJson(definitionPath, `${mcuName} definition`);
  const defines = [];
  for (const register of Array.isArray(definition.config_registers) ? definition.config_registers : []) {
    const key = String(register.key || '').trim();
    if (!key) continue;
    const address = String(register.address || '0').replace(/^\$|^0x/i, '').toUpperCase();
    defines.push(`#define ADDRESS_${key.toUpperCase()} 0x${address}`);
    defines.push(`#define VALUE_${key.toUpperCase()} 0x${defaultRegisterValue(register, registerValues).toString(16).toUpperCase().padStart(8, '0')}`);
  }
  const clockKHz = Math.round(Number(clockMHz) * 1000);
  defines.push(`#define FOSC_KHZ_VALUE ${Number.isFinite(clockKHz) ? clockKHz : 0}`);
  defines.push(Number.isFinite(clockKHz) ? '#define FOSC_KHZ_VALUE_DEFINED' : '#define FOSC_KHZ_VALUE_NOT_DEFINED');
  defines.push(`#define ${mcuName}`);
  defines.push('#define MCU_NAME_DEFINED');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, 'core_header.h');
  fs.writeFileSync(outputPath, fs.readFileSync(templatePath, 'utf8').replace('%DEFINE_STRINGS%', `${defines.join('\n')}\n`), 'utf8');
  return outputPath;
}

function splitFlags(value) {
  return String(value || '').match(/(?:[^\s"]+|"[^"]*")+/g)?.map((item) => item.replace(/^"|"$/g, '')) || [];
}

function armArchitectureFlags(coreName, mcuName) {
  const core = String(coreName || '').toUpperCase();
  if (core === 'M0') return [/^STM32F0/i.test(mcuName) ? '-mcpu=cortex-m0' : '-mcpu=cortex-m0plus', '-mthumb'];
  if (core === 'M0+') return ['-mcpu=cortex-m0plus', '-mthumb'];
  if (core === 'M23') return ['-mcpu=cortex-m23', '-mthumb', '-mfloat-abi=soft'];
  if (core === 'M3') return ['-mcpu=cortex-m3', '-mthumb'];
  if (core === 'M33EF') return ['-mcpu=cortex-m33', '-mthumb', '-mfloat-abi=hard'];
  if (core === 'M4' || core === 'M4EF') return ['-mcpu=cortex-m4', '-mthumb', '-mfloat-abi=hard', '-mfpu=fpv4-sp-d16'];
  if (core === 'M4DSP') return ['-mcpu=cortex-m4', '-mthumb', '-mfloat-abi=soft', '-mfpu=fpv4-sp-d16'];
  if (core === 'M7') {
    const doublePrecision = /^STM32(F7[67]|H7[2-5])/i.test(mcuName);
    return ['-mcpu=cortex-m7', '-mthumb', '-mfloat-abi=hard', doublePrecision ? '-mfpu=fpv5-d16' : '-mfpu=fpv5-sp-d16'];
  }
  if (core === 'M85') return ['-mcpu=cortex-m85', '-mthumb', '-mfloat-abi=hard', '-mfpu=fpv4-sp-d16'];
  return [];
}

function sdkCmakeVariables(sdkConfig = {}) {
  const config = sdkConfig && typeof sdkConfig === 'object' ? sdkConfig : {};
  const variables = {};

  // NECTO metadata predominantly stores mikroSDK variables as _MSDK_FOO_,
  // while a small number of database rows use MSDK_FOO. Publish both forms so
  // CMake consumers keep working regardless of which spelling is stored.
  for (const [key, value] of Object.entries(config)) {
    const text = cmakeValue(value);
    if (!text) continue;
    const underscored = String(key).match(/^_(MSDK_[A-Za-z0-9_]+)_$/);
    if (underscored) variables[underscored[1]] = text;
    else if (/^MSDK_[A-Za-z0-9_]+$/.test(String(key))) variables[`_${key}_`] = text;
  }

  // One legacy device row uses MCU_CARD_NAME without the MSDK prefix.
  if (config.MCU_CARD_NAME && !config._MSDK_MCU_CARD_NAME_) {
    variables._MSDK_MCU_CARD_NAME_ = cmakeValue(config.MCU_CARD_NAME);
  }
  return variables;
}

function cmakeValue(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(cmakeValue).join(';');
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

function normalizeApplicationOutput(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (normalized === 'uart' || normalized === 'log-interface-uart') return 'uart';
  if (normalized === 'stdout' || normalized === 'std-out' || normalized === 'debug-terminal' || normalized === 'printf-me' || normalized === 'printf') return 'debug-terminal';
  return 'debug-terminal';
}

function applicationOutputCmakeValue(value) {
  return normalizeApplicationOutput(value) === 'uart' ? 'LOG_INTERFACE_UART' : 'LOG_INTERFACE_STDOUT';
}

function completeSdkCmakeVariables(metadata = {}) {
  const config = metadata?.sdkConfig && typeof metadata.sdkConfig === 'object' ? metadata.sdkConfig : {};
  const variables = {};
  for (const [key, value] of Object.entries(config)) {
    // CMake cache variable names use the same identifier rules as normal
    // variables. Keep every database field in setup metadata, but only emit
    // syntactically valid keys to CMake.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const serialized = cmakeValue(value);
    if (serialized !== '') variables[key] = serialized;
  }
  Object.assign(variables, sdkCmakeVariables(config));
  Object.assign(variables, sdkMemoryVariables(metadata));
  return variables;
}

function versionAtLeast(version, required) {
  const left = String(version || '').split(/[^0-9]+/).filter(Boolean).map(Number);
  const right = String(required || '').split(/[^0-9]+/).filter(Boolean).map(Number);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const a = left[i] || 0;
    const b = right[i] || 0;
    if (a !== b) return a > b;
  }
  return true;
}

function compilerIdentity(executable) {
  const fallback = { name: path.basename(String(executable || '')), version: '' };
  if (!executable) return fallback;
  try {
    const result = childProcess.spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true });
    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    const versions = [...text.matchAll(/\b(\d+\.\d+(?:\.\d+)?)\b/g)].map((match) => match[1]);
    return {
      name: /arm-none-eabi-gcc/i.test(text) ? 'arm-none-eabi-gcc' : fallback.name,
      version: versions.find((value) => value.split('.').length >= 3) || versions[0] || ''
    };
  } catch {
    return fallback;
  }
}

function coreCompatibilityFlags(coreName, identity = {}) {
  const core = String(coreName || '').toUpperCase();
  const flags = [];
  // Mirror the compatibility portion of C_core/cmake/coreUtils.cmake::set_flags().
  // These are required by legacy mikroSDK sources when building with GCC 14.
  const coresWithLegacyConversionSuppressions = new Set(['M0', 'M23', 'M3', 'M33EF', 'M4', 'M4EF', 'M4DSP', 'M7', 'M85']);
  if (coresWithLegacyConversionSuppressions.has(core)) {
    if (/arm-none-eabi-gcc/i.test(String(identity.name || '')) && versionAtLeast(identity.version, '14.2.1')) {
      flags.push('-Wno-incompatible-pointer-types');
    }
    flags.push('-Wno-int-conversion', '-Wno-incompatible-function-pointer-types');
  }
  return flags;
}

function sdkMemoryVariables(metadata = {}) {
  const flash = Number(metadata?.device?.flash ?? 0);
  const ram = Number(metadata?.device?.ram ?? 0);
  if (!Number.isFinite(flash) || flash <= 0) {
    throw new Error(`${metadataMcuName(metadata) || 'Selected MCU'} does not define a valid Devices.flash value in bytes.`);
  }
  if (!Number.isFinite(ram) || ram <= 0) {
    throw new Error(`${metadataMcuName(metadata) || 'Selected MCU'} does not define a valid Devices.ram value in bytes.`);
  }
  return { MCU_FLASH: Math.trunc(flash), MCU_RAM: Math.trunc(ram) };
}

function expectedSdkDriverPackages(metadata = {}) {
  const mcuName = String(metadata?.sdkConfig?.MCU_NAME || metadata?.device?.uid || '').trim();
  const aiGenerated = String(metadata?.sdkConfig?.AI_GENERATED_SDK || '').toLowerCase();
  if (!mcuName || aiGenerated === 'true' || aiGenerated === '1') return [];
  // mikroSDK 2.19.1 set_module_support() enables these base driver modules for
  // every non-AI-generated target. GPIO is represented by three driver packages.
  return [
    'MikroSDK.Driver.ADC',
    'MikroSDK.Driver.GPIO.In',
    'MikroSDK.Driver.GPIO.Out',
    'MikroSDK.Driver.GPIO.Port',
    'MikroSDK.Driver.I2C.Master',
    'MikroSDK.Driver.PWM',
    'MikroSDK.Driver.SPI.Master',
    'MikroSDK.Driver.UART',
    'MikroSDK.Driver.OneWire'
  ];
}

function findInstalledPackageConfig(installPrefix, packageName) {
  const expectedName = `${packageName}Config.cmake`;
  return findRecursive(installPrefix, (_candidate, name) => name === expectedName, 8);
}

function validateSdkDriverPackages(installPrefix, metadata = {}) {
  const expected = expectedSdkDriverPackages(metadata);
  const missing = expected.filter((packageName) => !findInstalledPackageConfig(installPrefix, packageName));
  if (missing.length) {
    throw new Error(`mikroSDK driver bootstrap for ${metadataMcuName(metadata) || 'selected MCU'} is incomplete. Missing: ${missing.join(', ')}.`);
  }
  return expected;
}

function writeToolchain(filePath, setup, resolved, options) {
  const metadata = setup.metadata;
  const modulePaths = [
    options.compatibilityModuleRoot,
    options.infrastructureRoot,
    options.coreSource && path.join(options.coreSource, 'cmake'),
    path.join(options.installPrefix, 'lib', 'cmake')
  ].filter(Boolean).map(quoteCmake).join(';');
  const settings = {
    ...completeSdkCmakeVariables(metadata),
    TOOLCHAIN_ID: metadata.compiler.uid,
    OSC: setup.clockMHz,
    OSC_KHZ: Number.isFinite(Number(setup.clockMHz)) ? Math.round(Number(setup.clockMHz) * 1000) : '',
    LOG_INTERFACE: applicationOutputCmakeValue(setup.applicationOutput)
  };
  const cacheSettings = Object.entries(settings).map(([key, value]) => `set(${key} "${quoteCmake(cmakeValue(value))}" CACHE STRING "" FORCE)`).join('\n');
  const deviceCompilerFlags = splitFlags(metadata.device.compilerFlags);
  const deviceLinkerFlags = splitFlags(metadata.device.linkerFlags);
  const armFlags = /^(gnu-arm|clang-arm)$/.test(String(resolved.adapter?.family || ''))
    ? armArchitectureFlags(metadata.sdkConfig.CORE_NAME, metadataMcuName(metadata))
    : [];
  const compatibilityFlags = resolved.adapter?.family === 'gnu-arm'
    ? coreCompatibilityFlags(metadata.sdkConfig.CORE_NAME, compilerIdentity(resolved.c))
    : [];
  const adapterFlags = compilerSupport.compilerSpecificFlags(resolved.adapter, metadata, armFlags, compatibilityFlags);
  const compileFlags = [...adapterFlags.compile, ...deviceCompilerFlags].filter(Boolean);
  const linkFlags = [...adapterFlags.link, ...deviceLinkerFlags].filter(Boolean);
  const compileLine = compileFlags.length ? `add_compile_options(${compileFlags.map((flag) => `"${quoteCmake(flag)}"`).join(' ')})` : '';
  const linkLine = linkFlags.length ? `add_link_options(${linkFlags.map((flag) => `"${quoteCmake(flag)}"`).join(' ')})` : '';
  const family = String(resolved.adapter?.family || '');
  const acceptsGnuLinkerScript = /^(gnu-|clang-|xc32)/.test(family);
  const linker = options.linkerScript && acceptsGnuLinkerScript ? `add_link_options("-T${quoteCmake(options.linkerScript)}")` : '';
  const startup = options.startupFile ? `set(MIKROBUS_STARTUP_FILE "${quoteCmake(options.startupFile)}" CACHE FILEPATH "" FORCE)` : '';
  const cmakeAsmCompiler = resolved.adapter?.cmakeAsmViaCCompiler ? resolved.c : (resolved.cmakeAsm || resolved.asm || resolved.c);
  const compilerLines = [
    `set(CMAKE_C_COMPILER "${quoteCmake(resolved.c)}" CACHE FILEPATH "" FORCE)`,
    resolved.cxx ? `set(CMAKE_CXX_COMPILER "${quoteCmake(resolved.cxx)}" CACHE FILEPATH "" FORCE)` : '',
    cmakeAsmCompiler ? `set(CMAKE_ASM_COMPILER "${quoteCmake(cmakeAsmCompiler)}" CACHE FILEPATH "" FORCE)` : ''
  ].filter(Boolean).join('\n');
  const text = `# Generated by MikroBUS Embedded Tools.\nset(CMAKE_SYSTEM_NAME Generic)\nset(CMAKE_SYSTEM_VERSION 1)\nset(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)\n${compilerLines}\nmessage(STATUS "MikroBUS compiler: ${quoteCmake(metadata.compiler.uid)} -> ${quoteCmake(resolved.c)}")\nmessage(STATUS "MikroBUS CMake ASM driver: ${quoteCmake(cmakeAsmCompiler)}")\n${cacheSettings}\nset(TOOLCHAIN_LANGUAGE "${quoteCmake(resolved.adapter.language)}" CACHE STRING "" FORCE)\nset(CMAKE_MODULE_PATH "${modulePaths}" CACHE STRING "" FORCE)\nset(CMAKE_PREFIX_PATH "${quoteCmake(options.installPrefix)}" CACHE STRING "" FORCE)\n${options.sdkSetupBuild ? 'set(SDK_SETUP_BUILD TRUE)' : ''}\n${startup}\nadd_compile_definitions(PREINIT_SUPPORTED)\n${compileLine}\n${linkLine}\n${linker}\nset(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)\nset(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)\nset(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)\nset(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)\n`;
  fs.writeFileSync(filePath, text, 'utf8');
}

function cmakeDefinitions(values) {
  const args = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    args.push(`-D${key}=${cmakeValue(value)}`);
  }
  return args;
}

function runLogged(executable, args, options = {}) {
  output.show(true);
  output.appendLine(`\n> ${path.basename(executable)} ${args.map((item) => /\s/.test(item) ? JSON.stringify(item) : item).join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(executable, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: false,
      windowsHide: true
    });
    const cancellation = options.token?.onCancellationRequested(() => child.kill());
    child.stdout.on('data', (chunk) => output.append(chunk.toString()));
    child.stderr.on('data', (chunk) => output.append(chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      cancellation?.dispose();
      if (options.token?.isCancellationRequested) reject(new Error('C build cancelled.'));
      else if (code === 0) resolve();
      else reject(new Error(`${path.basename(executable)} exited with code ${code}. See the MikroBUS C output.`));
    });
  });
}

async function withTemporaryCoreHeader(coreSource, generatedHeader, operation) {
  const run = async () => {
    const target = path.join(coreSource, 'include', 'core_header.h');
    const backup = fs.existsSync(target) ? fs.readFileSync(target) : undefined;
    fs.copyFileSync(generatedHeader, target);
    try {
      return await operation();
    } finally {
      if (backup) fs.writeFileSync(target, backup);
      else fs.rmSync(target, { force: true });
    }
  };
  const queued = sourceMutationQueue.then(run, run);
  sourceMutationQueue = queued.catch(() => {});
  return queued;
}

function findFirstByExtension(root, extensions) {
  return findRecursive(root, (_candidate, name) => extensions.some((extension) => name.toLowerCase().endsWith(extension)), 8);
}

function isElfExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 20) return false;
    const header = Buffer.alloc(20);
    const fd = fs.openSync(filePath, 'r');
    try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
    if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) return false;
    const littleEndian = header[5] !== 2;
    const type = littleEndian ? header.readUInt16LE(16) : header.readUInt16BE(16);
    return type === 2 || type === 3; // ET_EXEC / ET_DYN; object files are ET_REL (1).
  } catch {
    return false;
  }
}

function cmakeExecutableTargets(projectRoot) {
  const cmakePath = path.join(projectRoot, 'CMakeLists.txt');
  if (!fs.existsSync(cmakePath)) return [];
  let text;
  try { text = fs.readFileSync(cmakePath, 'utf8'); } catch { return []; }
  // Strip line comments before matching simple add_executable(target ...) calls.
  // If a project computes the target name dynamically, the ELF-header fallback
  // below still discovers the linked application.
  text = text.replace(/#[^\n\r]*/g, ' ');
  const result = [];
  const regex = /add_executable\s*\(\s*([^\s\)]+)/gi;
  let match;
  while ((match = regex.exec(text))) {
    const target = String(match[1] || '').replace(/^['"]|['"]$/g, '');
    if (!target || target.includes('$') || /^(ALIAS|IMPORTED)$/i.test(target)) continue;
    if (!result.includes(target)) result.push(target);
  }
  return result;
}

function findBuiltExecutable(root, projectRoot) {
  const targets = projectRoot ? cmakeExecutableTargets(projectRoot) : [];
  const candidates = [];
  const walk = (directory, depth = 0) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(candidate, depth + 1); continue; }
      if (!entry.isFile() || !isElfExecutable(candidate)) continue;
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(candidate).mtimeMs; } catch {}
      const parsed = path.parse(candidate);
      const logicalName = parsed.ext.toLowerCase() === '.elf' ? parsed.name : parsed.base;
      const targetRank = targets.indexOf(logicalName);
      candidates.push({ candidate, mtimeMs, targetRank: targetRank < 0 ? Number.MAX_SAFE_INTEGER : targetRank });
    }
  };
  walk(root);
  candidates.sort((left, right) => {
    const leftGenerated = left.candidate.replace(/\\/g, '/').includes('/CMakeFiles/') ? 1 : 0;
    const rightGenerated = right.candidate.replace(/\\/g, '/').includes('/CMakeFiles/') ? 1 : 0;
    return (left.targetRank - right.targetRank) || (leftGenerated - rightGenerated) || (right.mtimeMs - left.mtimeMs);
  });
  return candidates[0]?.candidate;
}

function hexPathForExecutable(executable) {
  const parsed = path.parse(executable);
  if (parsed.ext.toLowerCase() === '.elf') return path.join(parsed.dir, `${parsed.name}.hex`);
  return `${executable}.hex`;
}

function infrastructureLocations(installed) {
  const values = [...installed.values()].filter((entry) => entry.kind === 'infrastructure');
  const cmakeModuleFile = values.map((entry) => findRecursive(entry.root, (_candidate, name) =>
    name === 'mikroeUtilsCommon.cmake' || name === 'mikroeUtils.cmake', 8)).find(Boolean);
  const testFile = values.map((entry) => findRecursive(entry.root, (_candidate, name) => name === 'unit_test_api.c', 8)).find(Boolean);
  const preinitFile = values.map((entry) => findRecursive(entry.root, (_candidate, name) => name === 'preinit.c', 8)).find(Boolean);
  const cmakeUtils = cmakeModuleFile ? path.dirname(cmakeModuleFile) : undefined;
  const testLib = testFile ? path.dirname(path.dirname(testFile)) : undefined;
  const preinit = preinitFile ? path.dirname(path.dirname(preinitFile)) : undefined;
  return { cmakeModuleFile, cmakeUtils, testLib, preinit };
}

function generateMikroeUtilsCompatibility(infrastructure, generatedRoot) {
  const compatibilityRoot = path.join(generatedRoot, 'cmake');
  fs.mkdirSync(compatibilityRoot, { recursive: true });
  const outputPath = path.join(compatibilityRoot, 'mikroeUtils.cmake');
  const exportTemplatePath = path.join(compatibilityRoot, 'mikroeExportConfig.cmake.in');
  const commonModule = quoteCmake(infrastructure.cmakeModuleFile);

  // The released mikroe_utils_common archive currently contains
  // mikroeUtilsCommon.cmake, but not the mikroeExportConfig.cmake.in template
  // that its core_install() implementation expects beside the module. Keep the
  // downloaded package immutable and provide the missing template from the
  // generated compatibility directory instead.
  const exportTemplate = `@PACKAGE_INIT@\n\n` +
    `include(CMakeFindDependencyMacro)\n` +
    `@FIND_DEPS@\n\n` +
    `include("\${CMAKE_CURRENT_LIST_DIR}/@TARGET_NAME@Targets.cmake")\n\n` +
    `check_required_components(@TARGET_NAME@)\n`;
  fs.writeFileSync(exportTemplatePath, exportTemplate, 'utf8');

  const text = `# Generated by MikroBUS Embedded Tools.\n` +
    `# Compatibility layer for the managed general_packages layout.\n` +
    `include_guard(GLOBAL)\n` +
    `include("${commonModule}")\n\n` +
    `# The published mikroe_utils_common package omits mikroeExportConfig.cmake.in.\n` +
    `# Override core_install() so package exports use the generated template here.\n` +
    `function(core_install targetAlias)\n` +
    `  get_target_property(_targetName \${targetAlias} ALIASED_TARGET)\n` +
    `  get_target_property(linkLibs \${_targetName} INTERFACE_LINK_LIBRARIES)\n\n` +
    `  core_version_export(\${_targetName})\n` +
    `  preinit_support(\${_targetName})\n\n` +
    `  install(TARGETS \${_targetName}\n` +
    `    EXPORT \${targetAlias}Target\n` +
    `    LIBRARY DESTINATION \${CMAKE_INSTALL_LIBDIR}\n` +
    `    ARCHIVE DESTINATION \${CMAKE_INSTALL_LIBDIR}\n` +
    `    RUNTIME DESTINATION \${CMAKE_INSTALL_BINDIR}\n` +
    `  )\n` +
    `  install(EXPORT \${targetAlias}Target\n` +
    `    FILE \${targetAlias}Targets.cmake\n` +
    `    DESTINATION \${CMAKE_INSTALL_LIBDIR}/cmake/\${targetAlias}\n` +
    `  )\n\n` +
    `  set(TARGET_NAME \${targetAlias})\n` +
    `  set(findDepsList "")\n` +
    `  if(linkLibs AND NOT linkLibs MATCHES "-NOTFOUND$")\n` +
    `    foreach(LIB \${linkLibs})\n` +
    `      list(APPEND findDepsList "find_dependency(\${LIB})")\n` +
    `    endforeach()\n` +
    `  endif()\n` +
    `  if(findDepsList)\n` +
    `    list(JOIN findDepsList "\\n" FIND_DEPS)\n` +
    `  else()\n` +
    `    set(FIND_DEPS "")\n` +
    `  endif()\n\n` +
    `  configure_package_config_file("\${CMAKE_CURRENT_FUNCTION_LIST_DIR}/mikroeExportConfig.cmake.in"\n` +
    `    "\${CMAKE_CURRENT_BINARY_DIR}/\${targetAlias}Config.cmake"\n` +
    `    INSTALL_DESTINATION "\${CMAKE_INSTALL_LIBDIR}/cmake/\${targetAlias}"\n` +
    `  )\n` +
    `  write_basic_package_version_file(\n` +
    `    "\${CMAKE_CURRENT_BINARY_DIR}/\${targetAlias}ConfigVersion.cmake"\n` +
    `    VERSION \${CMAKE_PROJECT_VERSION}\n` +
    `    COMPATIBILITY AnyNewerVersion\n` +
    `    ARCH_INDEPENDENT\n` +
    `  )\n` +
    `  install(FILES\n` +
    `    "\${CMAKE_CURRENT_BINARY_DIR}/\${targetAlias}Config.cmake"\n` +
    `    "\${CMAKE_CURRENT_BINARY_DIR}/\${targetAlias}ConfigVersion.cmake"\n` +
    `    DESTINATION "\${CMAKE_INSTALL_LIBDIR}/cmake/\${targetAlias}"\n` +
    `  )\n` +
    `  install(FILES\n` +
    `    "\${TEST_LIB_PATH}/include/unit_test_api.h"\n` +
    `    "\${PREINIT_ROUTINE_PATH}/include/preinit.h"\n` +
    `    DESTINATION "\${CMAKE_INSTALL_LIBDIR}/../include/core"\n` +
    `  )\n` +
    `endfunction()\n\n` +
    `# The published add_fosc_macro() emits a C-style expression such as\n` +
    `# OSC_KHZ=216*1000UL for every language. GNU as rejects the UL suffix.\n` +
    `# The generated toolchain provides OSC_KHZ as an integer number of kHz,\n` +
    `# which is valid as both a C preprocessor definition and an ASM --defsym.\n` +
    `macro(add_fosc_macro target)\n` +
    `  if(NOT DEFINED OSC_KHZ OR "\${OSC_KHZ}" STREQUAL "")\n` +
    `    message(FATAL_ERROR "OSC_KHZ is not set by the generated toolchain.")\n` +
    `  endif()\n` +
    `  target_compile_definitions(\${target} PRIVATE OSC_KHZ=\${OSC_KHZ})\n` +
    `endmacro()\n\n` +
    `# mikroeUtilsCommon.cmake assumes ../../../../preinit from NECTO's normal\n` +
    `# package hierarchy. The extension keeps preinit in c-runtime/packages,\n` +
    `# so resolve it through PREINIT_ROUTINE_PATH instead.\n` +
    `macro(add_preinit_lib)\n` +
    `  if(NOT DEFINED PREINIT_ROUTINE_PATH OR "\${PREINIT_ROUTINE_PATH}" STREQUAL "")\n` +
    `    message(FATAL_ERROR "PREINIT_ROUTINE_PATH is not set.")\n` +
    `  endif()\n` +
    `  if(NOT EXISTS "\${PREINIT_ROUTINE_PATH}/CMakeLists.txt")\n` +
    `    message(FATAL_ERROR "Preinit package was not found at \${PREINIT_ROUTINE_PATH}.")\n` +
    `  endif()\n` +
    `  add_subdirectory("\${PREINIT_ROUTINE_PATH}" "\${CMAKE_BINARY_DIR}/preinit")\n` +
    `endmacro()\n`;
  fs.writeFileSync(outputPath, text, 'utf8');
  return compatibilityRoot;
}

async function configureBuildInstall(cmake, source, build, definitions, token) {
  fs.mkdirSync(build, { recursive: true });
  await runLogged(cmake, ['-S', source, '-B', build, '-G', 'Ninja', ...cmakeDefinitions(definitions)], { token });
  await runLogged(cmake, ['--build', build, '--target', 'all'], { token });
  await runLogged(cmake, ['--build', build, '--target', 'install'], { token });
}

function selectionFromSetup(setup = {}) {
  const metadata = setup.metadata || {};
  return {
    deviceUid: setup.selection?.deviceUid || metadata.device?.uid,
    compilerUid: setup.selection?.compilerUid || metadata.compiler?.uid,
    sdkUid: setup.selection?.sdkUid || metadata.sdk?.uid,
    packageUid: setup.selection?.packageUid || metadata.devicePackage?.uid || undefined,
    programmerUid: setup.selection?.programmerUid || metadata.programmer?.uid,
    boardUid: setup.selection?.boardUid || setup.boardUid || metadata.board?.uid || undefined
  };
}

function refreshSetupMetadata(context, setup) {
  const selection = selectionFromSetup(setup);
  if (!selection.deviceUid || !selection.compilerUid || !selection.sdkUid || !selection.programmerUid) {
    throw new Error(`C setup '${setup.name || setup.id || 'unknown'}' is missing database selection identifiers. Recreate the setup.`);
  }
  setup.selection = selection;
  setup.metadata = database.getSetupMetadata(context, selection);
  setup.boardUid = selection.boardUid || undefined;
  setup.boardName = setup.metadata.board?.name || setup.boardName || undefined;
  // Older C setups predate the NECTO-style Application Output selector.
  // Migrate them to Debug Terminal/printf_me, which is board-pin agnostic.
  setup.applicationOutput = normalizeApplicationOutput(setup.applicationOutput);
  setup.schemaVersion = 4;
  return setup;
}

function copyDirectoryContents(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) fs.cpSync(from, to, { recursive: true, force: true });
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function codegripServerCandidates(root) {
  if (!root) return [];
  if (process.platform === 'win32') {
    return [
      path.join(root, 'apps', 'CodegripGdbServer.exe'),
      path.join(root, 'apps', 'bin', 'CodegripGdbServer.exe')
    ];
  }
  if (process.platform === 'darwin') {
    return [path.join(root, 'apps', 'CodegripGdbServer.app', 'Contents', 'MacOS', 'CodegripGdbServer')];
  }
  return [path.join(root, 'apps', 'bin', 'CodegripGdbServer')];
}

function findCodegripServerExecutable(root) {
  const direct = codegripServerCandidates(root).find((candidate) => fs.existsSync(candidate));
  if (direct) return direct;
  return findRecursive(root, (_candidate, name) => /^CodegripGdbServer(?:\.exe)?$/i.test(name), 10);
}

function materializeCodegripRuntime(context, setup, installed) {
  if (setup.metadata.programmer.uid !== 'codegrip') return undefined;
  const serverSpec = { kind: 'programmer', name: 'codegrip_gdb_server', version: '1.7.0' };
  const serverEntry = installed.get(packages.packageKey(serverSpec)) || packages.getInstalledPackage(context, serverSpec);
  if (!serverEntry?.root) throw new Error('Managed CODEGRIP GDB server package was not installed.');
  const serverExecutable = findCodegripServerExecutable(serverEntry.root);
  if (!serverExecutable) throw new Error(`CodegripGdbServer was not found under ${serverEntry.root}.`);

  const runtimeRoot = path.join(setupDirectory(context, setup.id), 'codegrip');
  const packsRoot = path.join(runtimeRoot, 'packs');
  fs.rmSync(packsRoot, { recursive: true, force: true });
  fs.mkdirSync(packsRoot, { recursive: true });
  // Preserve any common packs/resources bundled with CodegripGdbServer, then
  // overlay the MCU-specific packs resolved from the live CSV.
  const sharedPacksRoot = findDirectoryNamed(serverEntry.root, 'packs', 8);
  if (sharedPacksRoot) copyDirectoryContents(sharedPacksRoot, packsRoot);
  const devicePacks = [];
  for (const pkg of setup.codegripCatalog?.packages || []) {
    const spec = codegripPackSpec(pkg);
    const entry = installed.get(packages.packageKey(spec)) || packages.getInstalledPackage(context, spec);
    if (!entry?.root) throw new Error(`CODEGRIP device pack '${pkg.packageName}' was not installed.`);
    const relativeParts = codegripCatalog.relativePacksInstallPath(pkg.installLocation);
    const installDirectory = path.join(packsRoot, ...relativeParts);
    copyDirectoryContents(entry.root, installDirectory);
    devicePacks.push({
      packageName: pkg.packageName,
      packageVersion: pkg.packageVersion,
      sourceUrl: pkg.downloadUrl,
      packageRoot: entry.root,
      installLocation: pkg.installLocation,
      installDirectory
    });
  }
  if (!devicePacks.length) throw new Error(`No CODEGRIP device pack was resolved for ${setupMcuName(setup)}.`);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(serverExecutable, 0o755); } catch {}
  }
  setup.codegripRuntime = {
    catalogUrl: setup.codegripCatalog.catalogUrl,
    catalogResolvedAt: setup.codegripCatalog.resolvedAt,
    serverRoot: serverEntry.root,
    serverExecutable,
    sharedPacksRoot,
    packsRoot,
    devicePacks
  };
  return setup.codegripRuntime;
}


function ensureBspSkeleton(context, sdkSource) {
  const bspRoot = path.join(sdkSource, 'bsp');
  const skeleton = path.join(context.extensionPath, 'resources', 'c_bsp_skeleton');
  if (!fs.existsSync(skeleton)) throw new Error(`Bundled BSP skeleton is missing: ${skeleton}`);
  // The lightweight mikroSDK archive intentionally carries no full BSP catalog.
  // Rebuild only the setup-specific board/card overlay so uninstalled or previously
  // selected BSPs do not remain usable accidentally from an earlier setup build.
  fs.rmSync(path.join(bspRoot, 'board', 'include', 'boards'), { recursive: true, force: true });
  fs.rmSync(path.join(bspRoot, 'board', 'include', 'mcu_cards'), { recursive: true, force: true });
  copyDirectoryContents(skeleton, bspRoot);
  return bspRoot;
}

function findBspBoardSource(root, folderName) {
  const normalized = String(folderName || '').trim().toLowerCase();
  if (!root || !normalized) return undefined;

  // mikroSDK BSP assets have existed in both of these layouts. Always consume
  // the board directory itself and normalize it into the SDK skeleton below.
  for (const candidate of [
    path.join(root, 'board', 'include', 'boards', normalized),
    path.join(root, 'include', 'boards', normalized),
    path.join(root, normalized)
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }

  // Be tolerant of case differences in archive folder names.
  const named = findDirectoryNamed(root, normalized, 7);
  if (named && (fs.existsSync(path.join(named, 'board.cmake')) || fs.existsSync(path.join(named, 'board.h')))) return named;

  // Last-resort compatibility for one-board archives that omit the expected
  // folder level entirely. The DB-provided folderName remains authoritative
  // for the destination path.
  const cmake = findRecursive(root, (_candidate, name) => name.toLowerCase() === 'board.cmake', 7);
  if (cmake) return path.dirname(cmake);
  const header = findRecursive(root, (_candidate, name) => name.toLowerCase() === 'board.h', 7);
  return header ? path.dirname(header) : undefined;
}

function materializeBoardBspPackage(bspRoot, entryRoot, folderName, packageName = folderName) {
  const normalized = String(folderName || '').trim().toLowerCase();
  if (!normalized) throw new Error(`Board BSP '${packageName}' has no database-defined destination folder.`);
  const source = findBspBoardSource(entryRoot, normalized);
  if (!source) throw new Error(`Board BSP '${packageName}' does not contain board.h or board.cmake.`);
  const destination = path.join(bspRoot, 'board', 'include', 'boards', normalized);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  copyDirectoryContents(source, destination);
  return destination;
}

function materializeMcuCardBspPackage(bspRoot, entryRoot, folderName, mcuName, packageName = folderName) {
  const normalizedFolder = String(folderName || '').trim().toLowerCase();
  const normalizedMcu = String(mcuName || '').trim();
  if (!normalizedFolder) throw new Error(`MCU-card BSP '${packageName}' has no database-defined destination folder.`);
  if (!normalizedMcu) throw new Error(`MCU-card BSP '${packageName}' has no MCU_NAME in Devices.sdk_config.`);
  const header = findRecursive(entryRoot, (_candidate, name) => name.toLowerCase() === 'mcu_card.h', 8);
  if (!header) throw new Error(`MCU-card BSP '${packageName}' does not contain mcu_card.h.`);
  const cardRoot = path.join(bspRoot, 'board', 'include', 'mcu_cards', normalizedFolder);
  const destination = path.join(cardRoot, normalizedMcu);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(header, path.join(destination, 'mcu_card.h'));
  fs.rmSync(path.join(cardRoot, 'mcu_card.h'), { force: true });
  return destination;
}

function materializeSelectedBsp(context, sdkSource, setup, specs, installed) {
  const bspRoot = ensureBspSkeleton(context, sdkSource);
  for (const spec of specs.filter((item) => item.kind === 'bsp-board' || item.kind === 'bsp-card')) {
    const entry = installed.get(packages.packageKey(spec)) || packages.getInstalledPackage(context, spec);
    if (!entry?.root) throw new Error(`BSP package '${spec.name}' was not installed.`);
    if (spec.kind === 'bsp-board') {
      const folderName = String(spec.folderName || setup.metadata.packageRequirements?.board?.folderName || '').toLowerCase();
      materializeBoardBspPackage(bspRoot, entry.root, folderName, spec.name);
      continue;
    }
    // MCU-card packages are MCU-specific even when the upstream archive only
    // contains a plain mcu_card.h. mikroSDK resolves the card header through
    // <card>/<MCU_NAME>/mcu_card.h, so preserve the database MCU_NAME level.
    const folderName = String(spec.folderName || setup.metadata.packageRequirements?.card?.folderName || '').toLowerCase();
    const mcuName = String(spec.mcuName || setup.metadata.packageRequirements?.card?.mcuName || setupMcuName(setup) || '').trim();
    materializeMcuCardBspPackage(bspRoot, entry.root, folderName, mcuName, spec.name);
  }
}

async function ensureAndBuildSetup(context, setup, progress, token) {
  refreshSetupMetadata(context, setup);
  if (setup.metadata.programmer.uid === 'codegrip' && !(setup.codegripCatalog?.packages || []).length) {
    progress.report({ message: `Reading live CODEGRIP device-pack catalog for ${setupMcuName(setup)}...` });
    setup.codegripCatalog = await codegripCatalog.resolveDevice(setupMcuName(setup), token);
  }
  writeJsonAtomic(setupFile(context, setup.id), setup);
  setup.context = context;
  const specs = await buildPackageSpecs(context, setup.metadata, setup.mode, setup, token);
  progress.report({ message: 'Resolving required packages...' });
  const installed = await packages.ensurePackages(context, specs, progress, token);
  if (setup.metadata.programmer.uid === 'codegrip') {
    progress.report({ message: `Preparing CODEGRIP device packs for ${setupMcuName(setup)}...` });
    materializeCodegripRuntime(context, setup, installed);
  }
  const cmake = resolveBuildTool('cmake');
  const ninja = resolveBuildTool('ninja', ['ninja-build']);
  if (!cmake || !ninja) {
    throw new Error('CMake and Ninja are required. Install them system-wide or set mikrobusRust.cCmakePath and mikrobusRust.cNinjaPath.');
  }
  const resolved = resolveToolchain(setup, installed);
  output.appendLine(`Compiler DB C binary: ${setup.metadata.compiler.cCompiler || '(not set)'} -> ${resolved.c || '(not found)'}`);
  output.appendLine(`Compiler DB ASM binary: ${setup.metadata.compiler.asmCompiler || '(not set)'} -> ${resolved.assembler || '(not found)'}`);
  output.appendLine(`CMake ASM driver: ${resolved.cmakeAsm || resolved.asm || '(not found)'}`);
  const coreSpec = specs.find((spec) => spec.kind === 'core' && spec.name === setup.metadata.corePackageName);
  const coreRoot = coreSpec ? packageRoot(installed, coreSpec.kind, coreSpec.name, coreSpec.version) : undefined;
  const coreSource = locateCoreSource(coreRoot, setup.metadata.compiler.corePath, setup.metadata.coreMcuName || setup.metadata.sdkConfig.MCU_NAME);
  if (!coreSource || !fs.existsSync(path.join(coreSource, 'CMakeLists.txt'))) throw new Error(`Core package '${setup.metadata.corePackageName}' does not contain a usable core for ${setup.metadata.coreMcuName || setup.metadata.sdkConfig.MCU_NAME}.`);
  const setupRoot = setupDirectory(context, setup.id);
  const buildRoot = path.join(setupRoot, 'build');
  const installPrefix = path.join(setupRoot, 'install');
  const generatedRoot = path.join(setupRoot, 'generated');
  fs.mkdirSync(generatedRoot, { recursive: true });
  const infrastructure = infrastructureLocations(installed);
  const requiredInfrastructure = {
    cmakeModuleFile: infrastructure.cmakeModuleFile,
    testLib: infrastructure.testLib,
    preinit: infrastructure.preinit
  };
  const missingInfrastructure = Object.entries(requiredInfrastructure).filter(([, value]) => !value).map(([key]) => key);
  if (missingInfrastructure.length) {
    throw new Error(`C_core/mikroSDK build support is incomplete: ${missingInfrastructure.join(', ')}.`);
  }
  const compatibilityModuleRoot = generateMikroeUtilsCompatibility(infrastructure, generatedRoot);
  // The core CMake install rules consume ${CMAKE_BINARY_DIR}/core_header.h.
  // Generate the canonical configured header directly in the core build tree,
  // then temporarily mirror it to source/include/core_header.h while compiling.
  // This matches the core package contract without permanently mutating C_core.
  const coreBuildRoot = path.join(buildRoot, 'core');
  const coreHeader = generateCoreHeader(coreSource, setup.metadata, setup.clockMHz, coreBuildRoot, setup.registerValues || {});
  const generatedHeaderCopy = path.join(generatedRoot, 'core_header.h');
  fs.copyFileSync(coreHeader, generatedHeaderCopy);
  const coreToolchain = path.join(generatedRoot, 'core-toolchain.cmake');
  writeToolchain(coreToolchain, setup, resolved, { coreSource, compatibilityModuleRoot, infrastructureRoot: infrastructure.cmakeUtils, installPrefix });
  progress.report({ message: `Building ${setupMcuName(setup)} core...` });
  await withTemporaryCoreHeader(coreSource, coreHeader, () => configureBuildInstall(cmake, coreSource, coreBuildRoot, {
    CMAKE_MAKE_PROGRAM: ninja,
    CMAKE_TOOLCHAIN_FILE: coreToolchain,
    CMAKE_BUILD_TYPE: 'Debug',
    CMAKE_INSTALL_PREFIX: installPrefix,
    CMAKE_PREFIX_PATH: installPrefix,
    TEST_LIB_PATH: infrastructure.testLib,
    PREINIT_ROUTINE_PATH: infrastructure.preinit,
    ...completeSdkCmakeVariables(setup.metadata),
    IS_BARE_METAL: setup.mode === 'bare-metal' ? 'TRUE' : 'FALSE',
    MCU_IS_DUALCORE: 'FALSE'
  }, token));

  const linkerScript = findFirstByExtension(path.dirname(installPrefix), ['.ld', '.lds', '.gld', '.lkr']);
  const startupFile = findFirstByExtension(path.dirname(installPrefix), ['.s', '.S']);
  const projectToolchain = path.join(generatedRoot, 'toolchain.cmake');
  writeToolchain(projectToolchain, setup, resolved, { coreSource, compatibilityModuleRoot, infrastructureRoot: infrastructure.cmakeUtils, installPrefix, linkerScript, startupFile });

  if (setup.mode === 'full-sdk') {
    const sdkSpec = specs.find((spec) => spec.kind === 'sdk' && spec.name === 'mikrosdk');
    const sdkRoot = sdkSpec ? packageRoot(installed, sdkSpec.kind, sdkSpec.name, sdkSpec.version) : undefined;
    const sdkSource = locateSdkSource(sdkRoot);
    if (!sdkSource || !fs.existsSync(path.join(sdkSource, 'CMakeLists.txt'))) throw new Error('The latest mikroSDK package has no recognizable source root.');
    materializeSelectedBsp(context, sdkSource, setup, specs, installed);
    const sdkToolchain = path.join(generatedRoot, 'sdk-toolchain.cmake');
    writeToolchain(sdkToolchain, setup, resolved, { coreSource, compatibilityModuleRoot, infrastructureRoot: infrastructure.cmakeUtils, installPrefix, linkerScript, sdkSetupBuild: true });
    const sdkDefinitions = {
      CMAKE_MAKE_PROGRAM: ninja,
      CMAKE_TOOLCHAIN_FILE: sdkToolchain,
      CMAKE_BUILD_TYPE: 'Debug',
      CMAKE_INSTALL_PREFIX: installPrefix,
      CMAKE_PREFIX_PATH: installPrefix,
      TEST_LIB_PATH: infrastructure.testLib,
      PREINIT_ROUTINE_PATH: infrastructure.preinit,
      ...completeSdkCmakeVariables(setup.metadata),
      LOG_INTERFACE: applicationOutputCmakeValue(setup.applicationOutput),
      IS_BARE_METAL: 'FALSE',
      MSDK_BUILD_TFT_MODULES: 'FALSE',
      BUILD_LVGL_FROM_NECTO: 'FALSE',
      MCU_IS_DUALCORE: 'FALSE'
    };

    // mikroSDK's board CMake is configured before drv/hal/targets. On a fresh
    // setup the Board target therefore cannot discover the driver package
    // configs until those modules have been installed once. Bootstrap the SDK
    // into the setup prefix, validate the expected base modules, then configure
    // a clean final build so MikroSDK.Board sees ADC/GPIO/I2C/PWM/SPI/UART/
    // OneWire during its own configure step.
    progress.report({ message: `Bootstrapping mikroSDK driver modules...` });
    const sdkBootstrapBuild = path.join(buildRoot, 'sdk-bootstrap');
    fs.rmSync(sdkBootstrapBuild, { recursive: true, force: true });
    await configureBuildInstall(cmake, sdkSource, sdkBootstrapBuild, sdkDefinitions, token);
    const sdkDriverPackages = validateSdkDriverPackages(installPrefix, setup.metadata);
    setup.sdkDriverPackages = sdkDriverPackages;

    progress.report({ message: `Building mikroSDK board configuration...` });
    const sdkBuild = path.join(buildRoot, 'sdk');
    fs.rmSync(sdkBuild, { recursive: true, force: true });
    await configureBuildInstall(cmake, sdkSource, sdkBuild, sdkDefinitions, token);
  }

  delete setup.context;
  setup.packageKeys = specs.map(packages.packageKey);
  setup.paths = { installPrefix, toolchainFile: projectToolchain, linkerScript, startupFile };
  setup.tools = { cmake, ninja, compiler: resolved.c, gdb: resolved.gdb, objcopy: resolved.objcopy };
  setup.buildSupportVersion = C_BUILD_SUPPORT_VERSION;
  setup.builtAt = new Date().toISOString();
  writeJsonAtomic(setupFile(context, setup.id), setup);
  return setup;
}

function findDirectoryNamed(root, directoryName, maximumDepth = 7) {
  if (!root || !fs.existsSync(root)) return undefined;
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(current.directory, entry.name);
      if (entry.name.toLowerCase() === String(directoryName).toLowerCase()) return candidate;
      if (current.depth < maximumDepth) queue.push({ directory: candidate, depth: current.depth + 1 });
    }
  }
  return undefined;
}

function programmerRuntime(context, setup) {
  const programmer = setup.metadata.programmer;
  if (programmer.uid === 'codegrip') {
    const storedExecutable = setup.codegripRuntime?.serverExecutable;
    const storedPacks = setup.codegripRuntime?.packsRoot;
    if (storedExecutable && storedPacks && fs.existsSync(storedExecutable) && fs.existsSync(storedPacks)) {
      return { executable: storedExecutable, packsPath: storedPacks };
    }
  }
  const serverEntry = programmer.uid === 'codegrip'
    ? packages.getInstalledPackage(context, { kind: 'programmer', name: 'codegrip_gdb_server', version: '1.7.0' })
    : undefined;
  const roots = [serverEntry?.root].filter(Boolean);
  const executable = roots.map(findCodegripServerExecutable).find(Boolean);
  const packsPath = roots.map((root) => findDirectoryNamed(root, 'packs', 7)).find(Boolean);
  return { executable, packsPath };
}

async function selectCodegrip(context, setup) {
  const runtime = programmerRuntime(context, setup);
  if (!runtime.executable || !runtime.packsPath) throw new Error('Installed CODEGRIP server or device pack could not be located.');
  const result = await discoverUsbCodegrips({ ...runtime, mcu: setupMcuName(setup), channel: output });
  const selected = await quickPick(result.devices.map((device) => ({
    label: device.deviceName || 'CODEGRIP',
    description: device.serialNumber,
    detail: device.ip || 'USB',
    value: device
  })), { placeHolder: 'Select the USB CODEGRIP for this setup' });
  return selected ? normalizeConnectionProfile(selected.value) : undefined;
}

async function createSetupFromSelection(context, selection) {
  try {
    if (!selection) return;
    const metadata = database.getSetupMetadata(context, selection);
    const setupName = String(selection.name || `${metadata.device.mcuName || selection.deviceUid} C Setup`).trim();
    let existing;
    if (selection.setupId) {
      const existingFile = setupFile(context, selection.setupId);
      if (!fs.existsSync(existingFile)) throw new Error(`C setup '${selection.setupId}' no longer exists.`);
      existing = readJson(existingFile, `C setup ${selection.setupId}`);
    }
    const id = existing?.id || `${safeId(setupName)}-${crypto.createHash('sha1').update(`${selection.deviceUid}:${selection.compilerUid}:${selection.sdkUid}:${Date.now()}`).digest('hex').slice(0, 8)}`;
    const previousProgrammer = existing?.metadata?.programmer?.uid || existing?.selection?.programmerUid;
    const previousDevice = existing?.metadata?.device?.uid || existing?.selection?.deviceUid;
    let setup = {
      ...(existing || {}),
      schemaVersion: 4,
      id,
      name: setupName,
      mode: selection.mode === 'bare-metal' ? 'bare-metal' : 'full-sdk',
      applicationOutput: normalizeApplicationOutput(selection.applicationOutput),
      clockMHz: String(selection.clockMHz || selection.clockMhz || metadata.device.maxSpeed || '').trim(),
      registerValues: selection.registerValues || selection.values || {},
      selectionMode: selection.selectionMode === 'board' ? 'board' : 'mcu',
      boardUid: selection.boardUid || undefined,
      boardName: selection.boardName || metadata.board?.name || undefined,
      selection: {
        deviceUid: selection.deviceUid,
        compilerUid: selection.compilerUid,
        sdkUid: selection.sdkUid,
        packageUid: selection.packageUid || undefined,
        programmerUid: selection.programmerUid,
        boardUid: selection.boardUid || undefined
      },
      metadata,
      createdAt: existing?.createdAt || new Date().toISOString(),
      reconfiguredAt: existing ? new Date().toISOString() : undefined
    };

    // Reconfiguration must not reuse CMake caches/libraries generated for the
    // previous clock/register/output/programmer selection. Keep setup.json and
    // its stable ID, but rebuild all generated content from scratch.
    if (existing) {
      const root = setupDirectory(context, id);
      for (const name of ['build', 'install', 'generated', 'codegrip']) {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
      }
      delete setup.paths;
      delete setup.tools;
      delete setup.packageKeys;
      delete setup.builtAt;
      delete setup.lastElf;
      delete setup.lastHex;
      delete setup.sdkDriverPackages;
    }
    if (previousProgrammer !== selection.programmerUid || previousDevice !== selection.deviceUid || selection.programmerUid !== 'codegrip') {
      delete setup.programmerProfile;
      delete setup.codegripCatalog;
      delete setup.codegripRuntime;
    }
    writeJsonAtomic(setupFile(context, id), setup);
    setup = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `${existing ? 'Reconfiguring' : 'Building'} C setup: ${setupName}`,
      cancellable: true
    }, (progress, token) => ensureAndBuildSetup(context, setup, progress, token));
    if (setup.metadata.programmer.uid === 'codegrip') {
      try {
        setup.programmerProfile = await selectCodegrip(context, setup);
        writeJsonAtomic(setupFile(context, setup.id), setup);
      } catch (error) {
        output.appendLine(`CODEGRIP selection deferred: ${error.message}`);
        vscode.window.showWarningMessage(`C setup built. CODEGRIP hardware will be selected on first flash: ${error.message}`);
      }
    }
    vscode.window.showInformationMessage(`C setup '${setup.name}' was ${existing ? 'reconfigured' : 'built'} and is ready to apply.`);
    return setup;
  } catch (error) {
    vscode.window.showErrorMessage(`MikroBUS C setup: ${error.message || error}`);
    output.show(true);
    throw error;
  }
}

async function createSetup(context) {
  const selection = await chooseSetupSelection(context);
  if (!selection) return;
  return createSetupFromSelection(context, selection);
}

function generatedProjectCmake(setup) {
  const fullSdk = setup.mode === 'full-sdk';
  return `cmake_minimum_required(VERSION 3.20)\nproject(mikrobus_c_application LANGUAGES C ASM)\n\nfind_package(MikroC.Core REQUIRED)\n${fullSdk ? 'find_package(MikroSDK.Board REQUIRED)\n' : ''}file(GLOB_RECURSE APP_SOURCES CONFIGURE_DEPENDS "src/*.c")\nadd_executable(\${PROJECT_NAME} \${APP_SOURCES})\nif(DEFINED MIKROBUS_STARTUP_FILE AND EXISTS "\${MIKROBUS_STARTUP_FILE}")\n  target_sources(\${PROJECT_NAME} PRIVATE "\${MIKROBUS_STARTUP_FILE}")\nendif()\ntarget_link_libraries(\${PROJECT_NAME} PRIVATE MikroC.Core${fullSdk ? ' MikroSDK.Board' : ''})\nset_target_properties(\${PROJECT_NAME} PROPERTIES SUFFIX ".elf")\n`;
}

function starterMain() {
  return `#include <stdint.h>\n\nint main(void)\n{\n    for (;;) {\n        /* Application loop. */\n    }\n}\n`;
}

function cleanAppliedSetupArtifacts(root) {
  const extensionBuildRoot = path.join(root, '.mikrobus');
  fs.rmSync(extensionBuildRoot, { recursive: true, force: true });
  const bindingPath = path.join(root, '.vscode', 'mikrobus-c.json');
  fs.rmSync(bindingPath, { force: true });
}

async function applySetup(context, explicitSetupId) {
  try {
    const available = listSetups(context).filter((setup) => setup.builtAt && setup.paths?.toolchainFile);
    let setup = explicitSetupId ? available.find((item) => item.id === explicitSetupId) : undefined;
    if (!setup) {
      const selected = await quickPick(available.map((item) => ({
        label: item.name,
        description: `${setupMcuName(item)} · ${item.mode === 'full-sdk' ? `mikroSDK ${item.metadata.sdk.version}` : 'bare metal'}`,
        detail: item.metadata.programmer.name,
        value: item
      })), { placeHolder: 'Select a built C setup', emptyMessage: 'No built C setups exist. Create one first.' });
      setup = selected?.value;
    }
    if (!setup) return;
    const root = cProjectRoot();
    const cmakePath = path.join(root, 'CMakeLists.txt');
    if (!fs.existsSync(cmakePath)) {
      throw new Error(`No CMakeLists.txt was found at the detected C project root: ${root}. Open the project folder (or a C file below it) and try again.`);
    }
    // The project-local CMake cache, generated HEX/ELF metadata and temporary
    // programmer files are setup-specific. Never carry them across Apply.
    cleanAppliedSetupArtifacts(root);
    const vscodeDirectory = path.join(root, '.vscode');
    fs.mkdirSync(vscodeDirectory, { recursive: true });
    writeJsonAtomic(path.join(vscodeDirectory, 'mikrobus-c.json'), { schemaVersion: 1, setupId: setup.id, setupName: setup.name });
    await hideCppToolsActiveFileShortcut(root);
    await updateWorkspaceContext();
    vscode.window.showInformationMessage(`Applied C setup '${setup.name}' to ${path.basename(root)}.`);
  } catch (error) {
    vscode.window.showErrorMessage(`MikroBUS C apply setup: ${error.message || error}`);
  }
}

async function rebuildBoundSetup(context) {
  try {
    let setup = getBoundSetup(context);
    setup = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Rebuilding C setup: ${setup.name}`,
      cancellable: true
    }, (progress, token) => ensureAndBuildSetup(context, setup, progress, token));
    vscode.window.showInformationMessage(`C setup '${setup.name}' rebuilt.`);
  } catch (error) {
    vscode.window.showErrorMessage(`MikroBUS C setup build: ${error.message || error}`);
  }
}

function safeWorkspaceBuildPath(root) {
  return path.join(root, '.mikrobus', 'c-build');
}



async function buildWorkspace(context) {
  try {
    const root = cProjectRoot();
    let setup = getBoundSetup(context, root);
    const missing = (setup.packageKeys || []).some((key) => !packages.getInstalledPackage(context, key));
    const staleBuildSupport = setup.buildSupportVersion !== C_BUILD_SUPPORT_VERSION;
    const missingCodegripRuntime = setup.metadata?.programmer?.uid === 'codegrip' && (
      !setup.codegripRuntime?.serverExecutable || !fs.existsSync(setup.codegripRuntime.serverExecutable) ||
      !setup.codegripRuntime?.packsRoot || !fs.existsSync(setup.codegripRuntime.packsRoot)
    );
    if (missing || staleBuildSupport || missingCodegripRuntime || !setup.paths?.toolchainFile || !fs.existsSync(setup.paths.toolchainFile)) {
      setup = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Restoring C setup: ${setup.name}`,
        cancellable: true
      }, (progress, token) => ensureAndBuildSetup(context, setup, progress, token));
    }
    const cmake = setup.tools?.cmake && fs.existsSync(setup.tools.cmake) ? setup.tools.cmake : resolveBuildTool('cmake');
    const ninja = setup.tools?.ninja && fs.existsSync(setup.tools.ninja) ? setup.tools.ninja : resolveBuildTool('ninja', ['ninja-build']);
    if (!cmake || !ninja) throw new Error('CMake and Ninja are required for project builds.');
    const build = safeWorkspaceBuildPath(root);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Building ${setup.name}`, cancellable: true }, async (progress, token) => {
      progress.report({ message: 'Configuring project...' });
      await runLogged(cmake, ['-S', root, '-B', build, '-G', 'Ninja',
        `-DCMAKE_MAKE_PROGRAM=${ninja}`,
        `-DCMAKE_TOOLCHAIN_FILE=${setup.paths.toolchainFile}`,
        `-DCMAKE_PREFIX_PATH=${setup.paths.installPrefix}`,
        '-DCMAKE_BUILD_TYPE=Debug', '-DCMAKE_EXPORT_COMPILE_COMMANDS=1'], { token });
      progress.report({ message: 'Compiling project...' });
      await runLogged(cmake, ['--build', build], { token });
    });
    const elf = findBuiltExecutable(build, root);
    if (!elf) throw new Error(`Build completed but no ELF executable output was found below ${build}.`);
    const hex = await ensureHex(setup, elf);
    setup.lastElf = elf;
    setup.lastHex = hex;
    setup.lastBuiltAt = new Date().toISOString();
    writeJsonAtomic(setupFile(context, setup.id), setup);
    vscode.window.showInformationMessage(`C build complete: ${path.basename(elf)} + ${path.basename(hex)}`);
    return { setup, elf, hex };
  } catch (error) {
    vscode.window.showErrorMessage(`MikroBUS C build: ${error.message || error}`);
    output.show(true);
  }
}

async function cleanWorkspace() {
  try {
    const root = cProjectRoot();
    const target = path.resolve(safeWorkspaceBuildPath(root));
    const parent = path.resolve(path.join(root, '.mikrobus'));
    if (path.dirname(target) !== parent) throw new Error(`Refusing to clean unexpected path: ${target}`);
    fs.rmSync(target, { recursive: true, force: true });
    vscode.window.showInformationMessage('MikroBUS C build output cleaned.');
  } catch (error) {
    vscode.window.showErrorMessage(`MikroBUS C clean: ${error.message || error}`);
  }
}

async function ensureHex(setup, elf) {
  const existing = hexPathForExecutable(elf);
  if (fs.existsSync(existing)) {
    try {
      if (fs.statSync(existing).mtimeMs >= fs.statSync(elf).mtimeMs) return existing;
    } catch {}
  }
  const objcopy = setup.tools?.objcopy && fs.existsSync(setup.tools.objcopy)
    ? setup.tools.objcopy
    : packages.findOnPath(['arm-none-eabi-objcopy']);
  if (!objcopy) throw new Error('arm-none-eabi-objcopy is required to create a CODEGRIP HEX file.');
  await runLogged(objcopy, ['-O', 'ihex', elf, existing]);
  return existing;
}

function normalizeJlinkDeviceName(mcuName) {
  const value = String(mcuName || '').trim();
  // Match the existing NECTO SEGGER integration: Renesas R7 package suffixes
  // are removed before passing the device selector to J-Link.
  // Example: R7FA6M4AF3CFB -> R7FA6M4AF.
  if (/^R7/i.test(value) && value.length > 4) return value.slice(0, -4);
  return value;
}

function configuredExecutable(value, executableNames = []) {
  const configured = String(value || '').trim();
  if (!configured) return undefined;
  if (fs.existsSync(configured)) {
    try {
      if (fs.statSync(configured).isFile()) return configured;
      if (fs.statSync(configured).isDirectory()) {
        for (const name of executableNames) {
          const candidate = path.join(configured, name);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch {}
  }
  return undefined;
}

function standardJlinkRoots() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const roots = [
    home && path.join(home, '.MIKROE', 'NECTOStudio7', 'packages', 'programmers', 'segger'),
    process.platform === 'darwin' ? '/Applications/SEGGER/JLink' : undefined,
    process.platform === 'linux' ? '/opt/SEGGER/JLink' : undefined,
    process.platform === 'win32' && process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'SEGGER', 'JLink') : undefined,
    process.platform === 'win32' && process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'SEGGER', 'JLink') : undefined
  ];
  return roots.filter(Boolean);
}

function resolveJlinkExecutable(configKey, executableNames) {
  const configured = vscode.workspace.getConfiguration('mikrobusRust').get(configKey, '');
  const explicit = configuredExecutable(configured, executableNames);
  if (explicit) return explicit;
  const onPath = packages.findOnPath(executableNames);
  if (onPath) return onPath;
  for (const root of standardJlinkRoots()) {
    const direct = configuredExecutable(root, executableNames);
    if (direct) return direct;
    const recursive = findRecursive(root, (_candidate, name) => executableNames.some((item) => item.toLowerCase() === name.toLowerCase()), 4);
    if (recursive) return recursive;
  }
  return undefined;
}

function resolveJlinkTools() {
  const commanderNames = process.platform === 'win32' ? ['JLink.exe', 'JLinkExe.exe'] : ['JLinkExe'];
  const serverNames = process.platform === 'win32' ? ['JLinkGDBServerCL.exe', 'JLinkGDBServerCLExe.exe'] : ['JLinkGDBServerCLExe', 'JLinkGDBServerCL'];
  return {
    commander: resolveJlinkExecutable('jlinkCommanderPath', commanderNames),
    gdbServer: resolveJlinkExecutable('jlinkGdbServerPath', serverNames)
  };
}

async function flashJlink(setup, hex) {
  const tools = resolveJlinkTools();
  if (!tools.commander) {
    throw new Error('J-Link Commander was not found. Set mikrobusRust.jlinkCommanderPath or install SEGGER J-Link/NECTO SEGGER programmer files.');
  }
  const device = normalizeJlinkDeviceName(setupMcuName(setup));
  output.appendLine(`J-Link target: ${device} (MCU ${setupMcuName(setup)})`);
  const commandFile = path.join(path.dirname(hex), '.mikrobus-jlink-flash.jlink');
  fs.writeFileSync(commandFile, [
    device ? `device ${device}` : '',
    'connect',
    `loadfile "${hex.replace(/\\/g, '/')}"`,
    'r',
    'g',
    'exit',
    ''
  ].filter((line, index) => line || index > 0).join('\n'), 'utf8');
  const args = [];
  if (device) args.push('-device', device);
  args.push('-if', 'SWD', '-speed', '4000', '-AutoConnect', '1', '-NoGui', '1', '-ExitOnError', '1', '-CommandFile', commandFile);
  try {
    await runLogged(tools.commander, args);
  } finally {
    try { fs.rmSync(commandFile, { force: true }); } catch {}
  }
}

function startJlinkGdbServer(setup) {
  const tools = resolveJlinkTools();
  if (!tools.gdbServer) {
    throw new Error('J-Link GDB Server was not found. Set mikrobusRust.jlinkGdbServerPath or install SEGGER J-Link/NECTO SEGGER programmer files.');
  }
  const device = normalizeJlinkDeviceName(setupMcuName(setup));
  output.appendLine(`J-Link GDB target: ${device} (MCU ${setupMcuName(setup)})`);
  const port = 2331;
  const args = ['-if', 'SWD', '-speed', '4000', '-port', String(port), '-nogui'];
  if (device) args.push('-device', device);
  args.push('-singlerun');
  output.appendLine(`\n> ${tools.gdbServer} ${args.join(' ')}`);
  const processHandle = childProcess.spawn(tools.gdbServer, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let earlyError;
  processHandle.stdout?.on('data', (chunk) => output.append(chunk.toString()));
  processHandle.stderr?.on('data', (chunk) => output.append(chunk.toString()));
  processHandle.once('error', (error) => { earlyError = error; });
  return new Promise((resolve, reject) => {
    const finish = () => {
      if (earlyError) return reject(new Error(`J-Link GDB Server failed: ${earlyError.message}`));
      if (processHandle.exitCode !== null) return reject(new Error(`J-Link GDB Server exited early with code ${processHandle.exitCode}.`));
      resolve({ process: processHandle, port, device, gdbServer: tools.gdbServer });
    };
    processHandle.once('spawn', () => setTimeout(finish, 900));
    processHandle.once('error', (error) => reject(new Error(`J-Link GDB Server failed: ${error.message}`)));
  });
}

async function stopJlinkGdbServer(runtime) {
  const processHandle = runtime?.process;
  if (!processHandle || processHandle.exitCode !== null) return;
  try { processHandle.kill(); } catch {}
}


function codegripProgressToStatus(progress) {
  return (value) => {
    const percent = Number(value);
    if (!Number.isFinite(percent) || percent < 0) return;
    progress.report({ message: `${Math.max(0, Math.min(100, Math.round(percent)))}%` });
  };
}

async function withProgrammerStatus(setup, action, task) {
  const programmer = setup?.metadata?.programmer?.name || setup?.metadata?.programmer?.uid || 'programmer';
  return vscode.window.withProgress({
    // ProgressLocation.Window is the VS Code status bar. Keep this visible for
    // the complete physical programming operation, including Debug pre-flash.
    location: vscode.ProgressLocation.Window,
    title: `MikroBUS C: ${action} ${setupMcuName(setup)} with ${programmer}...`,
    cancellable: false
  }, async (progress) => {
    progress.report({ message: 'Starting...' });
    return task(progress);
  });
}

async function flashWorkspace(context) {
  try {
    const built = await buildWorkspace(context);
    if (!built) return;
    const { setup, elf, hex } = built;
    if (setup.metadata.programmer.uid === 'segger_jlink') {
      await withProgrammerStatus(setup, 'Programming', () => flashJlink(setup, hex));
    } else if (setup.metadata.programmer.uid === 'codegrip') {
      if (!setup.programmerProfile) {
        setup.programmerProfile = await selectCodegrip(context, setup);
        if (!setup.programmerProfile) return;
        writeJsonAtomic(setupFile(context, setup.id), setup);
      }
      const runtime = programmerRuntime(context, setup);
      await withProgrammerStatus(setup, 'Programming', async (progress) => programCodegrip({
        ...runtime,
        profile: setup.programmerProfile,
        mcu: setupMcuName(setup),
        hexFile: hex || await ensureHex(setup, elf),
        channel: output,
        onProgress: codegripProgressToStatus(progress)
      }));
    } else {
      throw new Error(`Programmer '${setup.metadata.programmer.uid}' is not implemented by this C adapter.`);
    }
    vscode.window.showInformationMessage(`Flashed ${path.basename(elf)} with ${setup.metadata.programmer.name}.`);
  } catch (error) {
    vscode.window.showErrorMessage(`MikroBUS C flash: ${error.message || error}`);
    output.show(true);
  }
}


function jlinkEraseScript(device) {
  return [
    device ? `device ${device}` : '',
    'connect',
    'erase',
    'r',
    'exit',
    ''
  ].filter((line, index) => line || index > 0).join('\n');
}

async function eraseJlink(setup, projectRoot = cProjectRoot()) {
  const tools = resolveJlinkTools();
  if (!tools.commander) {
    throw new Error('J-Link Commander was not found. Set mikrobusRust.jlinkCommanderPath or install SEGGER J-Link/NECTO SEGGER programmer files.');
  }
  const device = normalizeJlinkDeviceName(setupMcuName(setup));
  const runtimeDirectory = path.join(projectRoot, '.mikrobus');
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const commandFile = path.join(runtimeDirectory, '.mikrobus-jlink-erase.jlink');
  fs.writeFileSync(commandFile, jlinkEraseScript(device), 'utf8');
  const args = [];
  if (device) args.push('-device', device);
  args.push('-if', 'SWD', '-speed', '4000', '-AutoConnect', '1', '-NoGui', '1', '-ExitOnError', '1', '-CommandFile', commandFile);
  output.appendLine(`J-Link erase target: ${device} (MCU ${setupMcuName(setup)})`);
  try {
    await runLogged(tools.commander, args);
  } finally {
    try { fs.rmSync(commandFile, { force: true }); } catch {}
  }
}

async function eraseWorkspace(context) {
  try {
    const setup = getBoundSetup(context);
    const answer = await vscode.window.showWarningMessage(
      `Erase MCU ${setupMcuName(setup)} using ${setup.metadata.programmer.name || setup.metadata.programmer.uid}?`,
      { modal: true },
      'Erase MCU'
    );
    if (answer !== 'Erase MCU') return;

    if (setup.metadata.programmer.uid === 'segger_jlink') {
      await eraseJlink(setup);
    } else if (setup.metadata.programmer.uid === 'codegrip') {
      if (!setup.programmerProfile) {
        setup.programmerProfile = await selectCodegrip(context, setup);
        if (!setup.programmerProfile) return;
        writeJsonAtomic(setupFile(context, setup.id), setup);
      }
      const runtime = programmerRuntime(context, setup);
      const eraseCommand = String(vscode.workspace.getConfiguration('mikrobusRust').get('codegripEraseCommand', 'erase') || 'erase');
      await eraseCodegrip({
        ...runtime,
        profile: setup.programmerProfile,
        mcu: setupMcuName(setup),
        eraseCommand,
        channel: output
      });
    } else {
      throw new Error(`Erase with '${setup.metadata.programmer.uid}' is not implemented.`);
    }
    vscode.window.showInformationMessage(`Erased ${setupMcuName(setup)} with ${setup.metadata.programmer.name || setup.metadata.programmer.uid}.`);
  } catch (error) {
    vscode.window.showErrorMessage(`MikroBUS C erase: ${error.message || error}`);
    output.show(true);
  }
}


function findCMainEntryLine(sourceText) {
  const lines = String(sourceText || '').split(/\r?\n/);
  let mainLine = -1;
  let bodyStarted = false;
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i += 1) {
    if (mainLine < 0 && /\bmain\s*\(/.test(lines[i])) mainLine = i;
    if (mainLine < 0) continue;

    let text = lines[i];
    if (!bodyStarted) {
      const brace = text.indexOf('{');
      if (brace < 0) continue;
      bodyStarted = true;
      text = text.slice(brace + 1);
      if (!text.trim()) continue;
    } else if (i === mainLine) {
      continue;
    }

    let cleaned = '';
    for (let j = 0; j < text.length; j += 1) {
      if (inBlockComment) {
        if (text[j] === '*' && text[j + 1] === '/') { inBlockComment = false; j += 1; }
        continue;
      }
      if (text[j] === '/' && text[j + 1] === '*') { inBlockComment = true; j += 1; continue; }
      if (text[j] === '/' && text[j + 1] === '/') break;
      cleaned += text[j];
    }
    const trimmed = cleaned.trim();
    if (!trimmed || trimmed === '{' || trimmed === '}' || trimmed.startsWith('#')) continue;
    return i;
  }
  return mainLine >= 0 ? mainLine : 0;
}

function findProjectMainSource(projectRoot = cProjectRoot()) {
  const editorPath = vscode.window.activeTextEditor?.document?.uri?.fsPath;
  if (editorPath && path.basename(editorPath).toLowerCase() === 'main.c' && pathIsInside(editorPath, projectRoot)) {
    return editorPath;
  }

  const rootMain = path.join(projectRoot, 'main.c');
  if (fs.existsSync(rootMain)) return rootMain;

  const cmakePath = path.join(projectRoot, 'CMakeLists.txt');
  if (fs.existsSync(cmakePath)) {
    try {
      const cmake = fs.readFileSync(cmakePath, 'utf8').replace(/#[^\n\r]*/g, ' ');
      const matches = cmake.match(/[^\s()"']*main\.c/gi) || [];
      for (const match of matches) {
        const candidate = path.resolve(projectRoot, match.replace(/^['"]|['"]$/g, ''));
        if (pathIsInside(candidate, projectRoot) && fs.existsSync(candidate)) return candidate;
      }
    } catch {}
  }

  return findRecursive(projectRoot, (candidate, name) => {
    if (name.toLowerCase() !== 'main.c') return false;
    const normalized = candidate.replace(/\\/g, '/');
    return !normalized.includes('/.mikrobus/') && !normalized.includes('/build/') && !normalized.includes('/.git/');
  }, 8);
}

function sameFilePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function ensureCMainEntryBreakpoint(projectRoot = cProjectRoot()) {
  const source = findProjectMainSource(projectRoot);
  if (!source || !fs.existsSync(source)) return undefined;
  const line = findCMainEntryLine(fs.readFileSync(source, 'utf8'));
  for (const breakpoint of vscode.debug.breakpoints || []) {
    if (!(breakpoint instanceof vscode.SourceBreakpoint)) continue;
    if (!sameFilePath(breakpoint.location.uri.fsPath, source)) continue;
    if (breakpoint.location.range.start.line === line) {
      return { breakpoint, source, line, owned: false };
    }
  }
  const location = new vscode.Location(vscode.Uri.file(source), new vscode.Position(line, 0));
  const breakpoint = new vscode.SourceBreakpoint(location, true);
  vscode.debug.addBreakpoints([breakpoint]);
  output.appendLine(`Automatic main.c breakpoint: ${source}:${line + 1}`);
  return { breakpoint, source, line, owned: true };
}

function codegripCppDebugConfiguration(setup, projectRoot, elf, debugPort, generation) {
  const gdbPath = setup.tools?.gdb;
  return {
    type: 'cppdbg',
    request: 'launch',
    name: `MikroBUS C CODEGRIP: ${setup.name}`,
    presentation: { hidden: true },
    program: elf,
    cwd: projectRoot,
    MIMode: 'gdb',
    miDebuggerPath: gdbPath,
    miDebuggerServerAddress: `127.0.0.1:${debugPort}`,
    stopAtEntry: false,
    externalConsole: false,
    // CODEGRIP starts the MCU halted. cppdbg connects to the remote GDB server,
    // installs VS Code breakpoints, then continues the existing target instead
    // of trying to launch/download a new image.
    launchCompleteCommand: 'exec-continue',
    setupCommands: [
      {
        description: 'Allow access to all MCU memory regions',
        text: '-gdb-set mem inaccessible-by-default off',
        ignoreFailures: true
      }
    ],
    __mikrobusCodegripC: true,
    __mikrobusCodegripGeneration: generation,
    __mikrobusCDebugInstance: generation,
    __mikrobusCDebug: true
  };
}


async function debugWorkspace(context, debugOptions = {}) {
  let debugRuntime;
  let entryBreakpoint;
  let debugInstanceId;
  try {
    const built = await buildWorkspace(context);
    if (!built) return;
    const { setup, elf, hex } = built;
    const projectRoot = cProjectRoot();
    entryBreakpoint = ensureCMainEntryBreakpoint(projectRoot);
    let configuration;
    if (setup.metadata.programmer.uid === 'segger_jlink') {
      // Program the exact generated HEX first, then let Cortex-Debug own the
      // J-Link GDB server process. Native servertype=jlink is important here:
      // VS Code Restart/Stop can then restart/terminate the server cleanly.
      await withProgrammerStatus(setup, 'Programming for debug', () => flashJlink(setup, hex));
      const jlinkTools = resolveJlinkTools();
      if (!jlinkTools.gdbServer) {
        throw new Error('J-Link GDB Server was not found. Set mikrobusRust.jlinkGdbServerPath or install SEGGER J-Link/NECTO SEGGER programmer files.');
      }
      const jlinkDevice = normalizeJlinkDeviceName(setupMcuName(setup));
      debugInstanceId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      configuration = {
        type: 'cortex-debug', request: 'launch', name: `MikroBUS C J-Link: ${setup.name}`,
        cwd: projectRoot, executable: elf, servertype: 'jlink',
        serverpath: jlinkTools.gdbServer, device: jlinkDevice, interface: 'swd',
        serverArgs: ['-speed', '4000'],
        gdbPath: setup.tools?.gdb, runToEntryPoint: 'main', loadFiles: [],
        __mikrobusJlink: true, __mikrobusCDebugInstance: debugInstanceId, __mikrobusCDebug: true
      };
    } else if (setup.metadata.programmer.uid === 'codegrip') {
      if (!setup.programmerProfile) {
        setup.programmerProfile = await selectCodegrip(context, setup);
        if (!setup.programmerProfile) return;
        writeJsonAtomic(setupFile(context, setup.id), setup);
      }
      const cppTools = vscode.extensions.getExtension('ms-vscode.cpptools');
      if (!cppTools) {
        throw new Error('CODEGRIP debugging requires the Microsoft C/C++ extension (ms-vscode.cpptools). Install it and reload VS Code.');
      }
      await cppTools.activate();
      const runtime = programmerRuntime(context, setup);
      debugRuntime = await withProgrammerStatus(setup, 'Programming for debug', async (progress) => prepareCodegripDebug({
        ...runtime,
        profile: setup.programmerProfile,
        mcu: setupMcuName(setup),
        hexFile: hex || await ensureHex(setup, elf),
        channel: output,
        onProgress: codegripProgressToStatus(progress)
      }));
      debugInstanceId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const generation = debugInstanceId;
      activeExternalDebugRuntime = { runtime: debugRuntime, setupId: setup.id, generation };
      output.appendLine(`Starting cppdbg against CODEGRIP GDB at 127.0.0.1:${debugRuntime.debugPort}.`);
      configuration = codegripCppDebugConfiguration(setup, projectRoot, elf, debugRuntime.debugPort, generation);
    } else {
      throw new Error(`Debugging with '${setup.metadata.programmer.uid}' is not implemented.`);
    }
    const startOptions = debugOptions.restartParentSession ? {
      parentSession: debugOptions.restartParentSession,
      lifecycleManagedByParent: false,
      compact: true,
      consoleMode: vscode.DebugConsoleMode?.MergeWithParent,
      suppressDebugView: true
    } : undefined;
    const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], configuration, startOptions);
    if (!started) throw new Error('VS Code did not start the debug session.');
    if (debugRuntime || entryBreakpoint?.owned) {
      const disposable = vscode.debug.onDidTerminateDebugSession((session) => {
        if (session.configuration?.__mikrobusCDebug !== true) return;
        if (session.configuration?.__mikrobusCDebugInstance !== debugInstanceId) return;
        disposable.dispose();
        if (entryBreakpoint?.owned) vscode.debug.removeBreakpoints([entryBreakpoint.breakpoint]);
        if (debugRuntime) {
          if (activeExternalDebugRuntime?.runtime === debugRuntime) activeExternalDebugRuntime = undefined;
          void stopCodegripServer(debugRuntime);
        }
      });
    }
  } catch (error) {
    if (entryBreakpoint?.owned) vscode.debug.removeBreakpoints([entryBreakpoint.breakpoint]);
    if (debugRuntime) {
      if (activeExternalDebugRuntime?.runtime === debugRuntime) activeExternalDebugRuntime = undefined;
      await stopCodegripServer(debugRuntime);
    }
    vscode.window.showErrorMessage(`MikroBUS C debug: ${error.message || error}`);
    output.show(true);
  }
}

function getCSetupDashboardState(context) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  let root = folder?.uri.fsPath;
  try { if (folder) root = cProjectRoot(); } catch {}
  let binding;
  if (root) {
    const bindingPath = path.join(root, '.vscode', 'mikrobus-c.json');
    if (fs.existsSync(bindingPath)) {
      try { binding = readJson(bindingPath, 'Workspace C setup binding'); } catch {}
    }
  }
  const cSetups = listSetups(context).map((setup) => ({
    id: setup.id,
    name: setup.name,
    selectionMode: setup.selectionMode || setup.selection?.selectionMode || (setup.boardUid ? 'board' : 'mcu'),
    boardName: setup.boardName || setup.metadata?.board?.name,
    boardUid: setup.boardUid || setup.metadata?.board?.uid,
    mcuName: setupMcuName(setup),
    family: setup.metadata?.device?.family,
    clockMHz: setup.clockMHz,
    mode: setup.mode,
    applicationOutput: normalizeApplicationOutput(setup.applicationOutput),
    programmerName: setup.metadata?.programmer?.name || setup.metadata?.programmer?.uid,
    builtAt: setup.builtAt,
    lastElf: setup.lastElf,
    lastHex: setup.lastHex
  }));
  return {
    cSetups,
    cWorkspace: binding ? { setupId: binding.setupId, setupName: binding.setupName } : undefined,
    cProject: {
      available: Boolean(root),
      workspaceName: folder?.name,
      openedRoot: root || '',
      bound: Boolean(binding),
      note: root ? (binding ? `Using C setup: ${binding.setupName || binding.setupId}` : 'No C setup is applied to this workspace.') : 'Open a project folder to apply a C setup.'
    }
  };
}

async function rebuildSetupById(context, setupId) {
  try {
    const filePath = setupFile(context, setupId);
    if (!fs.existsSync(filePath)) throw new Error(`C setup '${setupId}' no longer exists.`);
    let setup = readJson(filePath, `C setup ${setupId}`);
    setup = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Rebuilding C setup: ${setup.name}`,
      cancellable: true
    }, (progress, token) => ensureAndBuildSetup(context, setup, progress, token));
    vscode.window.showInformationMessage(`C setup '${setup.name}' rebuilt.`);
    return setup;
  } catch (error) {
    vscode.window.showErrorMessage(`MikroBUS C setup build: ${error.message || error}`);
    output.show(true);
    throw error;
  }
}

async function reconfigureSetupById(context, setupId) {
  const filePath = setupFile(context, setupId);
  if (!fs.existsSync(filePath)) throw new Error(`C setup '${setupId}' no longer exists.`);
  await openCConfigurator(context, setupId);
}

async function removeSetupById(context, setupId) {
  const filePath = setupFile(context, setupId);
  if (!fs.existsSync(filePath)) return;
  let setup;
  try { setup = readJson(filePath, `C setup ${setupId}`); } catch { setup = { id: setupId, name: setupId }; }
  const answer = await vscode.window.showWarningMessage(`Remove C setup '${setup.name || setupId}'?`, { modal: true }, 'Remove');
  if (answer !== 'Remove') return;
  fs.rmSync(setupDirectory(context, setupId), { recursive: true, force: true });
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    let projectRoot = folder.uri.fsPath;
    try { projectRoot = cProjectRoot(); } catch {}
    const bindingPath = path.join(projectRoot, '.vscode', 'mikrobus-c.json');
    if (fs.existsSync(bindingPath)) {
      try {
        const binding = readJson(bindingPath, 'Workspace C setup binding');
        if (binding.setupId === setupId) fs.rmSync(bindingPath, { force: true });
      } catch {}
    }
  }
  await updateWorkspaceContext();
  vscode.window.showInformationMessage(`Removed C setup '${setup.name || setupId}'.`);
}

async function updateWorkspaceContext() {
  let root;
  try { root = cProjectRoot(); } catch {}
  const hasCmake = Boolean(root && fs.existsSync(path.join(root, 'CMakeLists.txt')));
  const bound = Boolean(root && fs.existsSync(path.join(root, '.vscode', 'mikrobus-c.json')));
  await vscode.commands.executeCommand('setContext', 'mikrobusRust.cWorkspaceBound', bound);
  await vscode.commands.executeCommand('setContext', 'mikrobusRust.cProjectReady', bound && hasCmake);
  if (bound) await hideCppToolsActiveFileShortcut(root);
}

function guardedCommand(context, name, callback) {
  context.subscriptions.push(vscode.commands.registerCommand(name, callback));
}


async function installCEnvironment(context) {
  // In C mode the Development environment action is a package-management
  // dashboard. Environment packages are managed separately from programmer
  // packages, and the user can install all or uninstall individual items.
  await packages.openEnvironmentPackages(context);
}
function isCodegripRestartRequest(message) {
  if (message?.type !== 'request') return false;
  if (message.command === 'restart') return true;
  return message.command === 'disconnect' && message.arguments?.restart === true;
}

function isCodegripFinalStopRequest(message) {
  if (message?.type !== 'request') return false;
  if (message.command === 'terminate') return true;
  return message.command === 'disconnect' && message.arguments?.restart !== true;
}

function registerDebugRuntimeLifecycle(context) {
  const jlinkStopFallback = new Set();
  const codegripStopTimers = new Map();
  const codegripRestartRequested = new Map();

  const scheduleCodegripCleanup = (session, runtime, delayMs = 3500) => {
    if (!runtime || codegripStopTimers.has(session.id)) return;
    const timer = setTimeout(() => {
      codegripStopTimers.delete(session.id);
      if (activeExternalDebugRuntime?.runtime !== runtime) return;
      output.appendLine('CODEGRIP Stop cleanup: GDB server did not exit after debugger disconnect; terminating it.');
      void stopCodegripServer(runtime).finally(() => {
        if (activeExternalDebugRuntime?.runtime === runtime) activeExternalDebugRuntime = undefined;
      });
    }, delayMs);
    codegripStopTimers.set(session.id, timer);
  };

  // J-Link remains on Cortex-Debug. Preserve its existing restart-before-stop fallback.
  const cortexTrackerFactory = vscode.debug.registerDebugAdapterTrackerFactory('cortex-debug', {
    createDebugAdapterTracker(session) {
      if (session.configuration?.__mikrobusCDebug !== true) return undefined;
      return {
        onWillReceiveMessage(message) {
          if (message?.type !== 'request' || !['disconnect', 'terminate'].includes(message.command)) return;
          if (session.configuration?.__mikrobusJlink !== true) return;
          if (jlinkStopFallback.has(session.id)) return;
          jlinkStopFallback.add(session.id);
          void (async () => {
            try {
              output.appendLine('J-Link Stop fallback: restarting debug session before stop...');
              try {
                await session.customRequest('restart', {});
              } catch {
                await vscode.commands.executeCommand('workbench.action.debug.restart');
              }
              await new Promise((resolve) => setTimeout(resolve, 450));
              await vscode.commands.executeCommand('workbench.action.debug.stop');
            } catch (error) {
              output.appendLine(`J-Link Stop fallback failed: ${error.message || error}`);
            } finally {
              setTimeout(() => jlinkStopFallback.delete(session.id), 1500);
            }
          })();
        },
        onExit() {
          jlinkStopFallback.delete(session.id);
        }
      };
    }
  });

  // CODEGRIP uses cppdbg against a CodegripGdbServer started with --stop gdb.
  // A normal Stop is intentionally left alone: GDB disconnects and the server
  // exits naturally. Restart is different: cppdbg disconnects from the current
  // remote server, which correctly makes --stop gdb terminate that server, but
  // cppdbg cannot reconnect to the now-dead dynamic port. Record the restart
  // intent here and perform a completely fresh CODEGRIP debug launch only after
  // VS Code confirms that the old debug session has terminated. This serializes
  // probe ownership and avoids the v0.5.x race where a new programming server
  // was started while the previous GDB/debug adapter was still alive.
  const cppTrackerFactory = vscode.debug.registerDebugAdapterTrackerFactory('cppdbg', {
    createDebugAdapterTracker(session) {
      if (session.configuration?.__mikrobusCodegripC !== true) return undefined;
      return {
        onWillReceiveMessage(message) {
          if (isCodegripRestartRequest(message)) {
            output.appendLine('CODEGRIP Restart requested; waiting for the current debugger session to terminate cleanly...');
            codegripRestartRequested.set(session.id, Date.now());
            const timer = codegripStopTimers.get(session.id);
            if (timer) clearTimeout(timer);
            codegripStopTimers.delete(session.id);
            return;
          }
          if (!isCodegripFinalStopRequest(message)) return;
          codegripRestartRequested.delete(session.id);
          const active = activeExternalDebugRuntime;
          if (active?.runtime && active.generation === session.configuration?.__mikrobusCodegripGeneration) {
            scheduleCodegripCleanup(session, active.runtime);
          }
        },
        onExit() {
          const timer = codegripStopTimers.get(session.id);
          if (timer) clearTimeout(timer);
          codegripStopTimers.delete(session.id);
          const active = activeExternalDebugRuntime;
          if (!active || active.generation !== session.configuration?.__mikrobusCodegripGeneration) return;
          activeExternalDebugRuntime = undefined;
          void stopCodegripServer(active.runtime);
        }
      };
    }
  });

  const codegripTermination = vscode.debug.onDidTerminateDebugSession((session) => {
    if (session.configuration?.__mikrobusCodegripC !== true) return;
    const restartRequested = codegripRestartRequested.has(session.id);
    codegripRestartRequested.delete(session.id);
    const timer = codegripStopTimers.get(session.id);
    if (timer) clearTimeout(timer);
    codegripStopTimers.delete(session.id);
    if (!restartRequested) return;

    // onDidTerminateDebugSession is the synchronization point we were missing:
    // the old GDB/debug adapter is now gone and --stop gdb has released CODEGRIP.
    // Relaunch through the normal debugWorkspace path so programming, dynamic
    // ports, device configuration and the automatic main.c breakpoint are all
    // recreated exactly as for the first Debug command. The replacement is
    // started as a compact child of this terminated session so VS Code hides
    // the superseded parent and keeps only the newest CODEGRIP session visible.
    void (async () => {
      try {
        output.appendLine('CODEGRIP Restart: previous debug session terminated; starting a fresh CODEGRIP debug session.');
        // Yield one event-loop turn so cpptools can finish disposing the old MI
        // engine before a new one is created. This is not a timing-based probe
        // delay; termination has already been confirmed above.
        await new Promise((resolve) => setImmediate(resolve));
        await debugWorkspace(context, { restartParentSession: session });
      } catch (error) {
        output.appendLine(`CODEGRIP Restart failed: ${error.message || error}`);
        vscode.window.showErrorMessage(`CODEGRIP Restart failed: ${error.message || error}`);
      }
    })();
  });

  context.subscriptions.push(cortexTrackerFactory, cppTrackerFactory, codegripTermination, {
    dispose() {
      for (const timer of codegripStopTimers.values()) clearTimeout(timer);
      codegripStopTimers.clear();
      codegripRestartRequested.clear();
      jlinkStopFallback.clear();
      const active = activeExternalDebugRuntime;
      activeExternalDebugRuntime = undefined;
      if (active?.runtime) void stopCodegripServer(active.runtime);
    }
  });
}

function registerCSupport(context) {
  registerDebugRuntimeLifecycle(context);
  guardedCommand(context, 'mikrobusC.createSetup', () => openCConfigurator(context));
  guardedCommand(context, 'mikrobusC.createSetupFromVisual', (selection) => createSetupFromSelection(context, selection));
  guardedCommand(context, 'mikrobusC.buildSetup', () => rebuildBoundSetup(context));
  guardedCommand(context, 'mikrobusC.applySetup', (setupId) => applySetup(context, setupId));
  guardedCommand(context, 'mikrobusC.build', () => buildWorkspace(context));
  guardedCommand(context, 'mikrobusC.clean', cleanWorkspace);
  guardedCommand(context, 'mikrobusC.flash', () => flashWorkspace(context));
  guardedCommand(context, 'mikrobusC.debug', () => debugWorkspace(context));
  guardedCommand(context, 'mikrobusC.erase', () => eraseWorkspace(context));
  guardedCommand(context, 'mikrobusC.openInstalledPackages', () => packages.openInstalledPackages(context));
  guardedCommand(context, 'mikrobusC.openCompilerPackages', () => packages.openCompilerPackages(context));
  guardedCommand(context, 'mikrobusC.installEnvironment', () => installCEnvironment(context));
  guardedCommand(context, 'mikrobusC.rebuildSetupById', (setupId) => rebuildSetupById(context, setupId));
  guardedCommand(context, 'mikrobusC.reconfigureSetupById', (setupId) => reconfigureSetupById(context, setupId));
  guardedCommand(context, 'mikrobusC.removeSetupById', (setupId) => removeSetupById(context, setupId));
  context.subscriptions.push(output, vscode.workspace.onDidChangeWorkspaceFolders(updateWorkspaceContext), vscode.window.onDidChangeActiveTextEditor(updateWorkspaceContext), vscode.workspace.onDidCreateFiles(updateWorkspaceContext), vscode.workspace.onDidDeleteFiles(updateWorkspaceContext));
  void updateWorkspaceContext();
}

module.exports = {
  registerCSupport,
  getCSetupDashboardState,
  rebuildSetupById,
  reconfigureSetupById,
  removeSetupById,
  _test: {
    safeId,
    defaultRegisterValue,
    registerFieldId,
    splitFlags,
    armArchitectureFlags,
    generatedProjectCmake,
    starterMain,
    isElfExecutable,
    findBuiltExecutable,
    cmakeExecutableTargets,
    findCmakeProjectRoot,
    hexPathForExecutable,
    normalizeJlinkDeviceName,
    jlinkEraseScript,
    codegripCppDebugConfiguration,
    isCodegripRestartRequest,
    isCodegripFinalStopRequest,
    findCMainEntryLine,
    findProjectMainSource,
    locateCoreSource,
    infrastructureLocations,
    generateMikroeUtilsCompatibility,
    generateCoreHeader,
    sdkCmakeVariables,
    completeSdkCmakeVariables,
    sdkMemoryVariables,
    normalizeApplicationOutput,
    applicationOutputCmakeValue,
    versionAtLeast,
    coreCompatibilityFlags,
    writeToolchain,
    codegripPackSpec,
    materializeCodegripRuntime,
    findCodegripServerExecutable,
    findBspBoardSource,
    materializeBoardBspPackage,
    materializeMcuCardBspPackage,
    cleanAppliedSetupArtifacts,
    selectionFromSetup,
    expectedSdkDriverPackages,
    validateSdkDriverPackages,
    metadataMcuName,
    setupMcuName,
    C_BUILD_SUPPORT_VERSION
  }
};
