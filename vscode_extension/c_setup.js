'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const vscode = require('vscode');
const database = require('./c_database');
const packages = require('./c_package_manager');
const codegripCatalog = require('./c_codegrip_catalog');
const compilerSupport = require('./c_compiler_support');
const rfp = require('./c_rfp_backend');
const tiXds110 = require('./c_ti_xds110_backend');
const cmakeVisibility = require('./c_cmake_visibility');
const microchip = require('./c_microchip_backend');
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

function isSupportedProgrammer(programmer = {}) {
  return ['codegrip', 'segger_jlink', rfp.RFP_PROGRAMMER_UID, tiXds110.TI_XDS110_PROGRAMMER_UID].includes(String(programmer.uid || '')) ||
    microchip.isMicrochipProgrammer(programmer);
}

function metadataMcuName(metadata = {}) {
  return String(metadata?.device?.mcuName || metadata?.sdkConfig?.MCU_NAME || metadata?.device?.uid || '').trim();
}

function setupMcuName(setup = {}) {
  return metadataMcuName(setup.metadata || {});
}
const C_BUILD_SUPPORT_VERSION = 66;
const output = vscode.window.createOutputChannel('MikroBUS C');
let sourceMutationQueue = Promise.resolve();
let activeExternalDebugRuntime;
let cmakeVisibilityRefreshTimer;
let cmakeVisibilityRefreshRunning = false;
let globalCContext;

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

function cmakeDeclaresProject(directory) {
  const cmakeFile = path.join(directory, 'CMakeLists.txt');
  if (!fs.existsSync(cmakeFile)) return false;
  try {
    const text = fs.readFileSync(cmakeFile, 'utf8')
      .replace(/#[^\r\n]*/g, ' ');
    return /(^|[\r\n])\s*project\s*\(/im.test(text);
  } catch {
    return false;
  }
}

function findAppliedCProjectRoot(startPath, workspace) {
  let current = startPath || workspace;
  try {
    if (fs.existsSync(current) && fs.statSync(current).isFile()) current = path.dirname(current);
  } catch {
    current = workspace;
  }
  current = path.resolve(current);
  const boundary = path.resolve(workspace);
  while (pathIsInside(current, boundary)) {
    if (fs.existsSync(path.join(current, 'CMakeLists.txt')) &&
        fs.existsSync(path.join(current, '.vscode', 'mikrobus-c.json')) &&
        (current === boundary || cmakeDeclaresProject(current))) {
      return current;
    }
    if (current === boundary) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
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
  const applied = findAppliedCProjectRoot(current, boundary);
  if (applied) return applied;
  const cmakeAncestors = [];
  while (pathIsInside(current, boundary)) {
    if (fs.existsSync(path.join(current, 'CMakeLists.txt'))) {
      cmakeAncestors.push(current);
      // A nested CMakeLists that only contains add_executable()/add_subdirectory()
      // is not a standalone project.  The first ancestor that actually calls
      // project() is the owning top-level CMake project for the active file.
      if (cmakeDeclaresProject(current)) return current;
    }
    if (current === boundary) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (fs.existsSync(path.join(boundary, 'CMakeLists.txt'))) return boundary;
  // Some older/minimal projects omit project(). In that case use the highest
  // CMake ancestor rather than the nearest leaf CMakeLists.
  return cmakeAncestors.length ? cmakeAncestors[cmakeAncestors.length - 1] : boundary;
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

  const compilers = compilerSupport.filterCompilersForHost(database.listCompilers(context, devicePick.value.uid, supportedCompilerUids()));
  const compilerPick = await quickPick(compilers.map((compiler) => ({
    label: compiler.name,
    description: `${compiler.uid} ${compiler.version || ''}`.trim(),
    value: compiler
  })), { placeHolder: 'Select a C compiler', emptyMessage: `No supported C compiler is mapped to ${devicePick.value.uid}.` });
  if (!compilerPick) return;

  const bareMetalOnly = Number(devicePick.value.sdkSupport || 0) === 0;
  const modes = bareMetalOnly
    ? { value: 'bare-metal' }
    : await quickPick([
      { label: 'Bare metal (core files)', description: 'Build and install the MCU core only.', value: 'bare-metal' },
      { label: 'Full mikroSDK (SDK + core)', description: 'Build the MCU core, then the selected mikroSDK.', value: 'full-sdk' }
    ], { placeHolder: 'Select the setup type' });
  if (!modes) return;

  let sdkPick;
  if (modes.value === 'full-sdk') {
    const sdks = database.listSdks(context, devicePick.value.uid, compilerPick.value.uid);
    sdkPick = await quickPick(sdks.map((sdk) => ({
      label: `${sdk.name} ${sdk.version}`,
      description: sdk.uid,
      value: sdk
    })), { placeHolder: 'Select the supported mikroSDK version', emptyMessage: `No non-legacy mikroSDK is mapped to ${devicePick.value.uid} for ${compilerPick.value.uid}.` });
    if (!sdkPick) return;
  }

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
    .filter((programmer) => isSupportedProgrammer(programmer));
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

  const suggestedName = `${devicePick.value.uid} ${modes.value === 'full-sdk' ? `mikroSDK ${sdkPick?.value.version || ''}`.trim() : 'Bare Metal'}`;
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
    sdkUid: sdkPick?.value.uid,
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
  const adapter = compilerSupport.adapterFor(metadata.compiler.uid);
  if (isMikroCFamily(adapter?.family)) {
    result.push({
      kind: 'shared',
      name: 'mikroc_cmake',
      version: '0.1.0',
      displayName: 'mikroC CMake Language Modules',
      environment: true,
      installRelativePath: 'tools/mikroc-cmake'
    });
  }
  const mikroCSetup = isMikroCFamily(adapter?.family);
  // On Linux mikroC keeps using the NECTO CMake build because that is the
  // already-tested custom-language path. On Windows/macOS (and for normal C
  // compilers), install relocatable build tools automatically only when the
  // user has not configured them and they are not already discoverable.
  if (process.platform === 'linux' && mikroCSetup) {
    result.push({
      kind: 'shared',
      name: 'cmake',
      version: 'necto-live',
      displayName: 'NECTO CMake',
      environment: true,
      installRelativePath: 'tools/necto-cmake'
    });
  } else if (!resolveBuildTool('cmake', [], context)) {
    const managedCmake = packages.managedBuildToolPackageSpec('cmake');
    if (managedCmake) result.push(managedCmake);
  }
  if (!resolveBuildTool('ninja', ['ninja-build'], context)) {
    const managedNinja = packages.managedBuildToolPackageSpec('ninja');
    if (managedNinja) result.push(managedNinja);
  }
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
  if (metadata.programmer.uid === rfp.RFP_PROGRAMMER_UID) {
    result.push(packages.rfpProgrammerPackageSpec());
  }
  if (metadata.programmer.uid === 'codegrip') {
    const serverSpec = packages.codegripServerPackageSpec({ environment: true });
    if (!serverSpec) throw new Error(`CODEGRIP GDB Server package is not available for ${process.platform}.`);
    result.push(serverSpec);
    for (const pkg of setup?.codegripCatalog?.packages || []) result.push(codegripPackSpec(pkg));
  }
  if (microchip.isMicrochipProgrammer(metadata.programmer)) {
    const programmerSpec = packages.programmerPackageSpec(metadata.programmer);
    if (programmerSpec) result.push({ ...programmerSpec, environment: true });
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

function mikroCPlatformBinDirectory(root) {
  if (!root) return undefined;
  const platformDirectory = process.platform === 'win32' ? 'win64' : (process.platform === 'darwin' ? 'macos' : 'linux');
  const candidate = path.join(root, 'bin', platformDirectory);
  return fs.existsSync(candidate) ? candidate : undefined;
}

function debuggerFileNames(names) {
  if (process.platform !== 'win32') return names;
  return names.flatMap((name) => path.extname(name) ? [name] : [`${name}.exe`, name]);
}

function isPlainLldbExecutable(candidate) {
  const base = path.basename(String(candidate || '')).toLowerCase();
  return base === 'lldb' || base === 'lldb.exe';
}

function isUsableMiDebugger(candidate) {
  if (!candidate || !fs.existsSync(candidate)) return false;
  return !isPlainLldbExecutable(candidate);
}

function findArmGdbInRoot(root) {
  if (!root || !fs.existsSync(root)) return undefined;
  const names = new Set(debuggerFileNames(['arm-none-eabi-gdb']).map((name) => name.toLowerCase()));
  return findRecursive(root, (_candidate, name) => names.has(String(name || '').toLowerCase()), 10);
}

function findExistingArmGdb(context) {
  const onPath = packages.findOnPath(debuggerFileNames(['arm-none-eabi-gdb', 'gdb-multiarch']));
  if (onPath) return onPath;
  const installed = packages.listInstalledPackages(context, true);
  for (const entry of installed) {
    const found = findArmGdbInRoot(entry?.root);
    if (found) return found;
  }
  return undefined;
}

async function ensureClangArmMiDebugger(context, setup) {
  const family = String(compilerSupport.adapterFor(setup?.metadata?.compiler?.uid)?.family || '');
  if (family !== 'clang-arm') return setup?.tools?.gdb;

  if (isUsableMiDebugger(setup?.tools?.gdb)) return setup.tools.gdb;

  let gdb = findExistingArmGdb(context);
  if (!gdb) {
    const compilerDescriptor = {
      uid: 'gcc_arm_none_eabi',
      name: 'GNU Arm Embedded GDB',
      displayName: 'GNU Arm Embedded GDB (Clang debug support)',
      installerPackage: 'gcc_arm_compiler',
      cCompiler: 'bin/arm-none-eabi-gcc',
      cxxCompiler: 'bin/arm-none-eabi-g++',
      asmCompiler: 'bin/arm-none-eabi-as',
      gdbPath: 'bin/arm-none-eabi-gdb'
    };
    const entry = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Installing GNU Arm GDB for Clang debugging',
      cancellable: true
    }, async (progress, token) => {
      const spec = await packages.compilerPackageSpec(context, compilerDescriptor, token);
      return packages.ensurePackage(context, spec, progress, token);
    });
    gdb = findArmGdbInRoot(entry?.root);
  }

  if (!gdb) {
    throw new Error(
      'Clang ARM debugging requires a GDB/MI client. Plain lldb cannot be launched with --interpreter=mi. ' +
      'Install arm-none-eabi-gdb (or gdb-multiarch), or reinstall the managed GNU Arm debugger support package.'
    );
  }

  setup.tools = { ...(setup.tools || {}), gdb };
  try { writeJsonAtomic(setupFile(context, setup.id), setup); } catch {}
  output.appendLine(`Clang debug client: ${gdb} (compiler remains ${setup.metadata?.compiler?.name || 'Clang'}).`);
  return gdb;
}

function resolveToolchain(setup, installed) {
  const adapter = COMPILER_ADAPTERS[setup.metadata.compiler.uid];
  if (!adapter) throw new Error(`No C compiler adapter is registered for ${setup.metadata.compiler.uid}.`);
  const packageName = String(setup.metadata.compiler.packageName || '').trim();
  const allInstalled = [...installed.values(), ...packages.listInstalledPackages(setup.context, true)];
  const entry = allInstalled.find((item) => item.kind === 'toolchain' && item.name === packageName);
  const configuredRoots = setup.metadata.compiler.uid === 'gcc_arm_none_eabi' ? [configuredArmGccRoot()].filter(Boolean) : [];
  if (isMikroCFamily(adapter.family)) {
    const platformBin = mikroCPlatformBinDirectory(entry?.root);
    if (platformBin) configuredRoots.unshift(platformBin);
  }
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
  const ar = resolveTool(entry, adapter.executableNames.ar || [], '', configuredRoots);
  const ranlib = resolveTool(entry, adapter.executableNames.ranlib || [], '', configuredRoots);
  if (!c) throw new Error(`The ${setup.metadata.compiler.name} package is installed but its C compiler was not found.`);
  if (/^xc(8|16|32)$/.test(String(adapter.family || '')) && !ar) {
    throw new Error(`The ${adapter.language} package is installed but ${adapter.family}-ar was not found. Reinstall the managed ${adapter.language} compiler package.`);
  }
  return { c, cxx, asm: cmakeAsm, cmakeAsm, assembler, gdb, objcopy, ar, ranlib, adapter, root: entry?.root || path.dirname(c), packageEntry: entry };
}

function buildToolExecutableNames(name, alternatives = []) {
  const values = [name, ...alternatives].filter(Boolean);
  if (process.platform !== 'win32') return [...new Set(values)];
  return [...new Set(values.flatMap((value) => path.extname(value) ? [value] : [`${value}.exe`, value]))];
}

function resolveExecutableFromPathOrDirectory(value, names) {
  const configured = String(value || '').trim();
  if (!configured) return undefined;
  const expanded = path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir()));
  if (!fs.existsSync(expanded)) return undefined;
  try {
    if (fs.statSync(expanded).isFile()) return expanded;
    if (!fs.statSync(expanded).isDirectory()) return undefined;
  } catch { return undefined; }
  for (const name of names) {
    const direct = path.join(expanded, name);
    if (fs.existsSync(direct)) return direct;
  }
  return findRecursive(expanded, (_candidate, fileName) => names.some((name) =>
    process.platform === 'win32' ? fileName.toLowerCase() === name.toLowerCase() : fileName === name
  ), 5);
}

function commonBuildToolCandidates(name) {
  const tool = String(name || '').toLowerCase();
  const result = [];
  if (process.platform === 'win32') {
    const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
    const local = process.env.LOCALAPPDATA;
    const user = process.env.USERPROFILE;
    if (tool === 'cmake') {
      for (const root of programFiles) result.push(path.join(root, 'CMake', 'bin', 'cmake.exe'));
      if (local) result.push(path.join(local, 'Programs', 'CMake', 'bin', 'cmake.exe'));
    }
    if (user) {
      result.push(path.join(user, 'scoop', 'apps', tool, 'current', 'bin', `${tool}.exe`));
      result.push(path.join(user, 'scoop', 'shims', `${tool}.exe`));
    }
    // Visual Studio Build Tools commonly ships both CMake and Ninja even when
    // neither executable has been added to PATH.
    for (const root of programFiles) {
      for (const edition of ['BuildTools', 'Community', 'Professional', 'Enterprise']) {
        const base = path.join(root, 'Microsoft Visual Studio', '2022', edition, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake');
        if (tool === 'cmake') result.push(path.join(base, 'CMake', 'bin', 'cmake.exe'));
        if (tool === 'ninja') result.push(path.join(base, 'Ninja', 'ninja.exe'));
      }
    }
  } else if (process.platform === 'darwin') {
    if (tool === 'cmake') result.push('/Applications/CMake.app/Contents/bin/cmake');
    for (const prefix of ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']) {
      result.push(path.join(prefix, tool));
    }
  }
  return result.filter((candidate) => candidate && fs.existsSync(candidate));
}

function resolveInstalledBuildTool(context, name, names) {
  if (!context) return undefined;
  const entry = packages.listInstalledPackages(context, true).find((item) =>
    String(item?.kind || '').toLowerCase() === 'shared' && String(item?.name || '').toLowerCase() === String(name || '').toLowerCase()
  );
  if (!entry?.root) return undefined;
  return resolveExecutableFromPathOrDirectory(entry.root, names);
}

function resolveBuildTool(name, alternatives = [], context = globalCContext) {
  const names = buildToolExecutableNames(name, alternatives);
  const configured = String(vscode.workspace.getConfiguration('mikrobusRust').get(`c${name[0].toUpperCase()}${name.slice(1)}Path`, '') || '').trim();
  const configuredExecutable = resolveExecutableFromPathOrDirectory(configured, names);
  if (configuredExecutable) return configuredExecutable;
  const fromPath = packages.findOnPath(names);
  if (fromPath) return fromPath;
  const common = commonBuildToolCandidates(name)[0];
  if (common) return common;
  return resolveInstalledBuildTool(context, name, names);
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

function isMikroCFamily(family) {
  return String(family || '').startsWith('mikroc-');
}

function mikroCOutputExtension(family) {
  const normalized = String(family || '').toLowerCase();
  return normalized === 'mikroc-arm' || normalized === 'mikroc-pic32' ? '.emcl' : '.mcl';
}

function parseMikroCDefaultOptions(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return {}; }
}

function mikroCCompilerFlags(family, defaultOptions, buildType = 'Debug') {
  const normalized = String(family || '').toLowerCase();
  const options = parseMikroCDefaultOptions(defaultOptions);
  const flags = [];
  if (options.long_hex_format === true) flags.push('-LHF');
  if (normalized === 'mikroc-arm' && options.generate_bin === true) flags.push('-BIN');
  if (options.ANSI_pack === true) flags.push('-APB');
  if (options.case_sensitive !== false) flags.push('-C');
  if (options.dynamic_link_literals === true) flags.push('-Y');
  if (normalized === 'mikroc-arm' && String(options.ansi_data_type || '') === '4') flags.push('-ATYPE');
  // NECTO's PIC toolchain is the exception: PIC does not append -SSA here.
  if (normalized !== 'mikroc-pic') flags.push('-SSA');
  flags.push('-MF');
  const generateAdditional = options.generate_additional_files !== false ? '1' : '0';
  const optimization = /^[0-9]$/.test(String(options.ssa_optimization_level ?? '4'))
    ? String(options.ssa_optimization_level ?? '4')
    : '4';
  flags.push(`-O${generateAdditional.repeat(7)}${optimization}`);
  // NECTO keeps -DBG in both Debug and Release; -UICD is Debug-only.
  flags.push('-DBG');
  if (String(buildType || '').toLowerCase() === 'debug') flags.push('-UICD');
  return flags;
}

function mikroCSearchPathInfo(_realCompiler, _metadata = {}, options = {}) {
  // Match NECTO CMakeUtils::writeToolchainFile(): search the current build
  // directory, the selected core's def/ directory, and the current source
  // directory. .mcl/.emcl are compiler outputs and no .mlk discovery is
  // required here. CMake expressions are intentionally preserved so one
  // generated toolchain can be reused by core, SDK and workspace builds.
  const coreSource = String(options.coreSource || '').trim();
  const coreDefinitionDirectory = coreSource ? path.join(coreSource, 'def') : '';
  return {
    paths: ['${CMAKE_BINARY_DIR}', coreDefinitionDirectory, '${CMAKE_SOURCE_DIR}'].filter(Boolean),
    coreDefinitionDirectory,
    source: 'core-def'
  };
}

function resolveManagedBuildTool(installed, name, alternatives = []) {
  const entries = installed instanceof Map ? [...installed.values()] : Array.isArray(installed) ? installed : [];
  const entry = entries.find((item) => String(item?.kind || '').toLowerCase() === 'shared' && String(item?.name || '').toLowerCase() === String(name || '').toLowerCase());
  if (!entry?.root || !fs.existsSync(entry.root)) return undefined;
  return resolveExecutableFromPathOrDirectory(entry.root, buildToolExecutableNames(name, alternatives));
}

function resolveManagedNectoCmake(installed) {
  return resolveManagedBuildTool(installed, 'cmake');
}

function resolveManagedNinja(installed) {
  return resolveManagedBuildTool(installed, 'ninja', ['ninja-build']);
}

function resolveManagedMikroCCmakeModules(installed) {
  const entries = installed instanceof Map ? [...installed.values()] : Array.isArray(installed) ? installed : [];
  const entry = entries.find((item) => String(item?.kind || '').toLowerCase() === 'shared' && String(item?.name || '').toLowerCase() === 'mikroc_cmake');
  if (!entry?.root || !fs.existsSync(entry.root)) return undefined;
  const required = [
    'CMakeDetermineMikroCCompiler.cmake',
    'CMakeMikroCCompiler.cmake.in',
    'CMakeMikroCInformation.cmake',
    'CMakeTestMikroCCompiler.cmake'
  ];
  if (required.every((name) => fs.existsSync(path.join(entry.root, name)))) return entry.root;
  const determine = findRecursive(entry.root, (_candidate, name) => name === 'CMakeDetermineMikroCCompiler.cmake', 6);
  if (!determine) return undefined;
  const root = path.dirname(determine);
  return required.every((name) => fs.existsSync(path.join(root, name))) ? root : undefined;
}

function mikroCSearchPaths(realCompiler, metadata = {}, options = {}) {
  return mikroCSearchPathInfo(realCompiler, metadata, options).paths;
}

function definitionFileNames(mcuName, defFile) {
  const mcu = String(mcuName || '').trim();
  const configured = String(defFile || '').trim();
  const values = [configured, mcu ? `${mcu}.json` : '', configured.toUpperCase(), mcu ? `${mcu.toUpperCase()}.json` : ''];
  return [...new Set(values.filter(Boolean))];
}

function resolveCoreDefinitionFile(coreSource, mcuName, defFile) {
  if (!coreSource) return undefined;
  const defRoot = path.join(coreSource, 'def');
  const names = definitionFileNames(mcuName, defFile);
  for (const name of names) {
    const direct = path.join(defRoot, name);
    if (fs.existsSync(direct)) return direct;
  }
  const expected = new Set(names.map((name) => name.toLowerCase()));
  return expected.size
    ? findRecursive(defRoot, (_candidate, name) => expected.has(name.toLowerCase()), 4)
    : undefined;
}

function cmakeDeclaresMikroCLanguage(directory) {
  const cmakeFile = path.join(directory, 'CMakeLists.txt');
  if (!fs.existsSync(cmakeFile)) return false;
  try {
    return /project\s*\([^)]*LANGUAGES\s+MikroC\b/is.test(fs.readFileSync(cmakeFile, 'utf8'));
  } catch {
    return false;
  }
}

function locateCoreSource(root, compilerCorePath, mcuName, family = '') {
  if (!root) return undefined;
  const relative = String(compilerCorePath || '').replace(/[\\/]+/g, path.sep);
  const compilerRoot = relative && fs.existsSync(path.join(root, relative)) ? path.join(root, relative) : root;
  const expectedDef = `${String(mcuName || '').trim()}.json`.toLowerCase();

  if (isMikroCFamily(family)) {
    // mikroC core packages have a different contract from GCC/XC cores: their
    // root project is LANGUAGES MikroC, def/<MCU>.json is present, and there is
    // intentionally no include/core_header.h.in.
    const directCandidates = [compilerRoot, root].filter((item, index, all) => item && all.indexOf(item) === index);
    for (const candidate of directCandidates) {
      if (cmakeDeclaresMikroCLanguage(candidate) && resolveCoreDefinitionFile(candidate, mcuName)) return candidate;
    }
    if (expectedDef !== '.json') {
      const definition = findRecursive(compilerRoot, (_candidate, name) => name.toLowerCase() === expectedDef, 8);
      if (definition) {
        let current = path.dirname(definition);
        for (let depth = 0; depth < 8; depth += 1) {
          if (cmakeDeclaresMikroCLanguage(current)) return current;
          const parent = path.dirname(current);
          if (parent === current) break;
          current = parent;
        }
      }
    }
    const cmake = findRecursive(compilerRoot, (candidate, name) => name === 'CMakeLists.txt' && cmakeDeclaresMikroCLanguage(path.dirname(candidate)), 8);
    return cmake ? path.dirname(cmake) : undefined;
  }

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
  // Match me.mcu/McuSettings::calculateRegisterValues(): combine the selected
  // field values, preserve default bits outside all field masks, then clear the
  // register's unused bits. Keep every operation in uint32 space.
  const parseHex = (value) => (Number.parseInt(String(value ?? '0').replace(/^0x|\$/i, ''), 16) || 0) >>> 0;
  const defaultValue = parseHex(register?.default);
  const unused = parseHex(register?.unused);
  let allMasks = 0;
  let allValues = 0;
  for (const field of Array.isArray(register?.fields) ? register.fields : []) {
    const mask = parseHex(field?.mask);
    const fieldId = registerFieldId(register, field);
    const hasSelectedValue = Object.prototype.hasOwnProperty.call(selectedValues || {}, fieldId)
      && String(selectedValues[fieldId] ?? '').trim() !== '';
    // Empty UI values mean "keep the definition init value", matching NECTO.
    const selected = hasSelectedValue ? selectedValues[fieldId] : field?.init;
    allMasks = (allMasks | mask) >>> 0;
    allValues = (allValues | (parseHex(selected) & mask)) >>> 0;
  }
  return ((allValues | (defaultValue & (~allMasks >>> 0))) & (~unused >>> 0)) >>> 0;
}

function generateCoreHeader(coreSource, metadata, clockMHz, outputDirectory, registerValues = {}) {
  const templatePath = path.join(coreSource, 'include', 'core_header.h.in');
  const mcuName = metadataMcuName(metadata);
  const definitionPath = resolveCoreDefinitionFile(coreSource, mcuName, metadata?.device?.defFile);
  if (!fs.existsSync(templatePath)) throw new Error(`Core header template was not found: ${templatePath}`);
  if (!definitionPath || !fs.existsSync(definitionPath)) {
    const requested = metadata?.device?.defFile || `${mcuName}.json`;
    throw new Error(`MCU definition was not found for ${requested} (also tried uppercase/case-insensitive variants below ${path.join(coreSource, 'def')}).`);
  }
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

function normalizeJcfgAddress(value) {
  const raw = String(value ?? '0').trim();
  if (!raw) return '$0';
  if (raw.startsWith('$')) return `$${raw.slice(1).toUpperCase()}`;
  if (/^0x/i.test(raw)) return `$${raw.slice(2).toUpperCase()}`;
  return `$${raw.toUpperCase()}`;
}

function generateMikroCJcfg(coreSource, metadata, registerValues, outputDirectory, mcuNameOverride) {
  const mcuName = String(mcuNameOverride || metadataMcuName(metadata) || '').trim();
  if (!mcuName) throw new Error('Cannot generate mikroC JCFG without an MCU name.');
  const definitionPath = resolveCoreDefinitionFile(coreSource, mcuName, metadata?.device?.defFile);
  if (!definitionPath || !fs.existsSync(definitionPath)) {
    throw new Error(`Cannot generate ${mcuName}.jcfg because the MCU definition JSON was not found.`);
  }
  const definition = readJson(definitionPath, `${mcuName} definition`);
  const configRegisters = [];
  for (const register of Array.isArray(definition.config_registers) ? definition.config_registers : []) {
    if (register?.address === undefined || register?.address === null || String(register.address).trim() === '') continue;
    configRegisters.push({
      address: normalizeJcfgAddress(register.address),
      value: `$${defaultRegisterValue(register, registerValues || {}).toString(16)}`
    });
  }
  if (!configRegisters.length) {
    throw new Error(`Cannot generate ${mcuName}.jcfg because ${path.basename(definitionPath)} contains no configuration registers.`);
  }
  const payload = {
    back_door_key: '0',
    config_registers: configRegisters,
    data_type_size: '0',
    mcu_name: mcuName,
    stack_allocation: '0'
  };
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `${mcuName}.jcfg`);
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 4)}\n`, 'utf8');
  return outputPath;
}

function splitFlags(value) {
  return String(value || '').match(/(?:[^\s"]+|"[^"]*")+/g)?.map((item) => item.replace(/^"|"$/g, '')) || [];
}

function rxCoreDeclaredFlags(coreSource, coreName) {
  // RX core packages define their authoritative application/compiler options in
  // cmake/coreUtils.cmake::set_flags(flags), keyed by CORE_NAME. Read that
  // branch directly so the generated workspace toolchain follows the installed
  // core package instead of duplicating RX flags in the extension.
  const core = String(coreName || '').trim();
  if (!coreSource || !core) return [];
  const utilityFile = path.join(coreSource, 'cmake', 'coreUtils.cmake');
  if (!fs.existsSync(utilityFile)) return [];
  let text;
  try { text = fs.readFileSync(utilityFile, 'utf8'); } catch { return []; }

  const functionMatch = text.match(/function\s*\(\s*set_flags\b[^)]*\)([\s\S]*?)endfunction(?:\s*\([^)]*\))?/i);
  if (!functionMatch) return [];
  const body = functionMatch[1];
  const escapedCore = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const branchPattern = new RegExp(
    `(?:if|elseif)\\s*\\(\\s*\\$\\{CORE_NAME\\}\\s+STREQUAL\\s+["']?${escapedCore}["']?\\s*\\)([\\s\\S]*?)(?=\\belseif\\s*\\(|\\belse\\s*\\(|\\bendif\\s*\\()`,
    'i'
  );
  const branchMatch = body.match(branchPattern);
  if (!branchMatch) return [];
  const setMatch = branchMatch[1].match(/set\s*\(\s*\$\{flags\}\s+([\s\S]*?)\s+PARENT_SCOPE\s*\)/i);
  if (!setMatch) return [];
  const withoutComments = setMatch[1].replace(/(^|\s)#.*$/gm, '$1');
  return splitFlags(withoutComments.replace(/;/g, ' '));
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

function sdkPreProjectCmakeVariables(resolved = {}) {
  // mikroSDK_v2 checks TOOLCHAIN_LANGUAGE before project(). CMake loads the
  // toolchain file from project(), so this selector must also be provided on
  // the configure command line, exactly as NECTO does.
  const language = String(resolved?.adapter?.language || '').trim();
  return language ? { TOOLCHAIN_LANGUAGE: language } : {};
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

function coreSetFlagsBranch(coreSource, coreName) {
  // The installed core package is the source of truth for compatibility
  // diagnostics. Extract the selected CORE_NAME branch from
  // cmake/coreUtils.cmake::set_flags(flags) without duplicating it here.
  const core = String(coreName || '').trim();
  if (!coreSource || !core) return { found: false, text: '' };
  const utilityFile = path.join(coreSource, 'cmake', 'coreUtils.cmake');
  if (!fs.existsSync(utilityFile)) return { found: false, text: '' };
  let text;
  try { text = fs.readFileSync(utilityFile, 'utf8'); } catch { return { found: false, text: '' }; }
  const functionMatch = text.match(/function\s*\(\s*set_flags\b[^)]*\)([\s\S]*?)endfunction(?:\s*\([^)]*\))?/i);
  if (!functionMatch) return { found: false, text: '' };

  const escapedCore = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const coreCondition = new RegExp(`\\$\\{CORE_NAME\\}\\s+STREQUAL\\s+["']?${escapedCore}["']?`, 'i');
  const lines = functionMatch[1].split(/\r?\n/);
  let depth = 0;
  let capturing = false;
  let chainDepth = -1;
  const branch = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const keywordMatch = trimmed.match(/^(if|elseif|else|endif)\s*\(/i);
    const keyword = keywordMatch ? keywordMatch[1].toLowerCase() : '';
    if (capturing && depth === chainDepth && (keyword === 'elseif' || keyword === 'else' || keyword === 'endif')) break;
    if (!capturing && (keyword === 'if' || keyword === 'elseif') && coreCondition.test(trimmed)) {
      capturing = true;
      chainDepth = keyword === 'if' ? depth + 1 : depth;
    } else if (capturing) {
      branch.push(line);
    }
    if (keyword === 'if') depth += 1;
    else if (keyword === 'endif') depth = Math.max(0, depth - 1);
  }
  return { found: capturing, text: branch.join('\n') };
}

function coreDeclaredCompatibilityFlags(coreSource, coreName) {
  const branch = coreSetFlagsBranch(coreSource, coreName);
  if (!branch.found) return { found: false, flags: [] };
  const flags = [];
  // Import diagnostic compatibility switches directly from the package. Other
  // flags can contain nested MCU/FPU/linker logic and remain handled by the
  // architecture/compiler adapter.
  for (const match of branch.text.matchAll(/(?:^|[\s;])(-Wno-[A-Za-z0-9_.=+-]+)/g)) {
    if (!flags.includes(match[1])) flags.push(match[1]);
  }
  return { found: true, flags };
}

function coreCompatibilityFlags(coreName, identity = {}, coreSource = '') {
  const core = String(coreName || '').toUpperCase();
  const declared = coreDeclaredCompatibilityFlags(coreSource, core);
  const flags = declared.found ? [...declared.flags] : [];
  // Fallback only for old packages with no matching set_flags() branch. If a
  // branch exists, the installed package is authoritative, even when empty.
  if (!declared.found) {
    const legacyCores = new Set(['M0', 'M23', 'M3', 'M33EF', 'M4', 'M4EF', 'M4DSP', 'M7', 'M85']);
    if (legacyCores.has(core)) flags.push('-Wno-int-conversion', '-Wno-incompatible-function-pointer-types');
  }
  // Mirrors the package's POINTER_TYPE_ERROR compatibility for GCC 14.x.
  if (/arm-none-eabi-gcc/i.test(String(identity.name || '')) && versionAtLeast(identity.version, '14.2.1')) {
    if (!flags.includes('-Wno-incompatible-pointer-types')) flags.unshift('-Wno-incompatible-pointer-types');
  }
  return [...new Set(flags)];
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
    options.mikroCModuleRoot,
    options.compatibilityModuleRoot,
    options.infrastructureRoot,
    options.coreSource && path.join(options.coreSource, 'cmake'),
    path.join(options.installPrefix, 'lib', 'cmake')
  ].filter(Boolean).map(quoteCmake).join(';');
  const family = String(resolved.adapter?.family || '');
  const mikroC = isMikroCFamily(family);
  const mikroCFlags = mikroC ? mikroCCompilerFlags(family, metadata.compiler.defaultOptions, options.buildType || 'Debug') : [];
  const deviceCompilerFlags = splitFlags(metadata.device.compilerFlags);
  const deviceLinkerFlags = splitFlags(metadata.device.linkerFlags);
  // Match NECTO CMakeUtils::writeToolchainFile(): mikroC's generic CMake
  // language rules consume <FLAGS>, so the complete compiler flag string must
  // be available through CMAKE_MikroC_FLAGS in addition to the historical
  // COMPILER_FLAGS cache variable used by coreUtils.cmake custom commands.
  // NECTO appends both MCU compiler and linker flags to this same string.
  const mikroCAllFlags = mikroC
    ? [...mikroCFlags, ...deviceCompilerFlags, ...deviceLinkerFlags].filter(Boolean)
    : [];
  const mikroCPathInfo = mikroC ? mikroCSearchPathInfo(resolved.c, metadata, {
    coreSource: options.coreSource
  }) : { paths: [], coreDefinitionDirectory: '' };
  const mikroCPaths = mikroCPathInfo.paths;
  const mikroCDeviceName = mikroC
    ? String(options.mcuNameOverride || metadataMcuName(metadata) || '')
    : '';
  const settings = {
    ...completeSdkCmakeVariables(metadata),
    TOOLCHAIN_ID: metadata.compiler.uid,
    OSC: setup.clockMHz,
    OSC_KHZ: Number.isFinite(Number(setup.clockMHz)) ? Math.round(Number(setup.clockMHz) * 1000) : '',
    LOG_INTERFACE: applicationOutputCmakeValue(setup.applicationOutput),
    MIKROSDK_TYPE: setup.mode === 'full-sdk' ? 'mikrosdk' : 'baremetal',
    COMPILER_FLAGS: mikroCAllFlags.join(';'),
    LINKER_FLAGS: mikroCAllFlags.join(';'),
    SEARCH_PATHS: mikroCPaths.join(';'),
    JCFG_FILE: mikroC ? String(options.jcfgFile || '') : '',
    CORE_LIB: mikroC ? String(options.coreLib || '') : '',
    CMAKE_MikroC_OUTPUT_EXTENSION: mikroC ? mikroCOutputExtension(family) : '',
    CMAKE_MikroC_OUTPUT_EXTENSION_REPLACE: mikroC ? '1' : '',
    MIKROBUS_MIKROC_OUTPUT_EXTENSION: mikroC ? mikroCOutputExtension(family) : '',
    MIKROBUS_MIKROC_DEVICE_NAME: mikroCDeviceName
  };
  if (options.mcuNameOverride) settings.MCU_NAME = String(options.mcuNameOverride);
  const cacheSettings = Object.entries(settings).map(([key, value]) => `set(${key} "${quoteCmake(cmakeValue(value))}" CACHE STRING "" FORCE)`).join('\n');
  const armFlags = /^(gnu-arm|clang-arm)$/.test(String(resolved.adapter?.family || ''))
    ? armArchitectureFlags(metadata.sdkConfig.CORE_NAME, metadataMcuName(metadata))
    : [];
  const compatibilityFlags = /^(gnu-arm|clang-arm)$/.test(String(resolved.adapter?.family || ''))
    ? coreCompatibilityFlags(metadata.sdkConfig.CORE_NAME, compilerIdentity(resolved.c), options.coreSource)
    : [];
  const rxDeclaredFlags = family === 'gnu-rx'
    ? rxCoreDeclaredFlags(options.coreSource, metadata.sdkConfig.CORE_NAME)
    : [];
  const adapterFlags = compilerSupport.compilerSpecificFlags(resolved.adapter, metadata, armFlags, compatibilityFlags, rxDeclaredFlags);
  const compileFlags = mikroC ? [] : [...adapterFlags.compile, ...deviceCompilerFlags].filter(Boolean);
  const linkFlags = mikroC ? [] : [...adapterFlags.link, ...deviceLinkerFlags].filter(Boolean);
  const compileLine = compileFlags.length ? `add_compile_options(${compileFlags.map((flag) => `"${quoteCmake(flag)}"`).join(' ')})` : '';
  const linkLine = linkFlags.length ? `add_link_options(${linkFlags.map((flag) => `"${quoteCmake(flag)}"`).join(' ')})` : '';
  // Also seed the base C flags. This guarantees the core-declared diagnostic
  // compatibility switches survive target-level option manipulation and reach
  // every actual GCC/Clang C compile command.
  const compatibilityInitLine = compatibilityFlags.length
    ? `if(NOT DEFINED MIKROBUS_CORE_COMPAT_FLAGS_INIT_APPLIED)\nset(CMAKE_C_FLAGS_INIT "${quoteCmake(compatibilityFlags.join(' '))} \${CMAKE_C_FLAGS_INIT}")\nset(MIKROBUS_CORE_COMPAT_FLAGS_INIT_APPLIED TRUE CACHE INTERNAL "MikroBUS core compatibility flags initialized")\nendif()`
    : '';
  const acceptsGnuLinkerScript = /^(gnu-|clang-|xc32|llvm-rl78)/.test(family);
  const linker = options.linkerScript && acceptsGnuLinkerScript ? `add_link_options("-T${quoteCmake(options.linkerScript)}")` : '';
  // XC32 configuration objects are intentionally not passed through the
  // application link. mikroSDK supplies an explicit linker script which can
  // omit XC32's processor-definition .config_<address> mapping. The encoded
  // configuration bytes are therefore merged from the object into the final
  // Intel HEX after xc32-bin2hex. XC8/XC16 retain their existing link path.
  const xcConfigObjectLink = options.xcConfigObject && family !== 'xc32'
    ? `if(NOT DEFINED MIKROBUS_XC_CONFIG_OBJECT_LINKED)\nadd_link_options("${quoteCmake(options.xcConfigObject)}")\nset(MIKROBUS_XC_CONFIG_OBJECT_LINKED TRUE CACHE INTERNAL "MikroBUS XC configuration object linked")\nendif()`
    : '';
  const startup = options.startupFile ? `set(MIKROBUS_STARTUP_FILE "${quoteCmake(options.startupFile)}" CACHE FILEPATH "" FORCE)` : '';
  const cmakeAsmCompiler = resolved.adapter?.cmakeAsmViaCCompiler ? resolved.c : (resolved.cmakeAsm || resolved.asm || resolved.c);
  let xc8Rules = '';
  if (family === 'xc8') {
    const ruleFile = path.join(path.dirname(filePath), 'xc8-cmake-rules.cmake');
    const ruleText = `# XC8 PIC CMake rule overrides generated by MikroBUS Embedded Tools.\n` +
      `set(CMAKE_C_OUTPUT_EXTENSION ".p1")\n` +
      `set(CMAKE_ASM_OUTPUT_EXTENSION ".o")\n` +
      `set(CMAKE_EXECUTABLE_SUFFIX ".elf")\n` +
      `set(CMAKE_C_COMPILE_OBJECT "<CMAKE_C_COMPILER> <DEFINES> <INCLUDES> <FLAGS> -o <OBJECT> -c <SOURCE>")\n` +
      `set(CMAKE_C_CREATE_STATIC_LIBRARY "<CMAKE_AR> -r <TARGET> <OBJECTS>")\n` +
      `set(CMAKE_C_ARCHIVE_CREATE "<CMAKE_AR> -r <TARGET> <OBJECTS>")\n` +
      `set(CMAKE_C_ARCHIVE_APPEND "<CMAKE_AR> -r <TARGET> <OBJECTS>")\n` +
      `set(CMAKE_C_ARCHIVE_FINISH "")\n`;
    fs.writeFileSync(ruleFile, ruleText, 'utf8');
    xc8Rules = `set(CMAKE_USER_MAKE_RULES_OVERRIDE_C "${quoteCmake(ruleFile)}" CACHE FILEPATH "" FORCE)\n`;
  }
  const compilerLines = (mikroC ? [
    // Match NECTO: CMake invokes the real mikroC compiler directly.
    `set(CMAKE_MikroC_COMPILER "${quoteCmake(resolved.c)}" CACHE FILEPATH "" FORCE)`
  ] : [
    `set(CMAKE_C_COMPILER "${quoteCmake(resolved.c)}" CACHE FILEPATH "" FORCE)`,
    resolved.cxx ? `set(CMAKE_CXX_COMPILER "${quoteCmake(resolved.cxx)}" CACHE FILEPATH "" FORCE)` : '',
    cmakeAsmCompiler ? `set(CMAKE_ASM_COMPILER "${quoteCmake(cmakeAsmCompiler)}" CACHE FILEPATH "" FORCE)` : '',
    resolved.ar ? `set(CMAKE_AR "${quoteCmake(resolved.ar)}" CACHE FILEPATH "" FORCE)` : '',
    family === 'xc8' ? `set(CMAKE_RANLIB "" CACHE FILEPATH "" FORCE)` : (resolved.ranlib ? `set(CMAKE_RANLIB "${quoteCmake(resolved.ranlib)}" CACHE FILEPATH "" FORCE)` : '')
  ]).filter(Boolean).join('\n');
  const mikroCCompileOptions = ''; // Official NECTO CMake consumes COMPILER_FLAGS/SEARCH_PATHS.

  const text = `# Generated by MikroBUS Embedded Tools.\nset(CMAKE_SYSTEM_NAME Generic)\nset(CMAKE_SYSTEM_VERSION 1)\nset(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)\n${compilerLines}\n${xc8Rules}message(STATUS "MikroBUS compiler: ${quoteCmake(metadata.compiler.uid)} -> ${quoteCmake(resolved.c)}")\n${mikroC ? `message(STATUS "MikroBUS CMake language: MikroC")\nmessage(STATUS "MikroBUS mikroC core def: ${quoteCmake(mikroCPathInfo.coreDefinitionDirectory || '')}")\nmessage(STATUS "MikroBUS mikroC device: ${quoteCmake(mikroCDeviceName)}")\nmessage(STATUS "MikroBUS mikroC search paths: ${quoteCmake(mikroCPaths.join(';'))}")\nmessage(STATUS "MikroBUS mikroC JCFG: ${quoteCmake(options.jcfgFile || '')}")\nmessage(STATUS "MikroBUS mikroC core library: ${quoteCmake(options.coreLib || '')}")\n` : `message(STATUS "MikroBUS CMake ASM driver: ${quoteCmake(cmakeAsmCompiler)}")\nmessage(STATUS "MikroBUS core compatibility flags: ${quoteCmake(compatibilityFlags.join(' '))}")\n`}\n${compatibilityInitLine}\n${cacheSettings}\n${mikroC ? `set(CMAKE_MikroC_FLAGS "${quoteCmake(mikroCAllFlags.join(' '))}" CACHE STRING "" FORCE)\nset(CMAKE_EXE_LINKER_FLAGS "${quoteCmake(mikroCAllFlags.join(' '))}" CACHE STRING "" FORCE)\n` : ''}set(TOOLCHAIN_LANGUAGE "${quoteCmake(resolved.adapter.language)}" CACHE STRING "" FORCE)\nset(CMAKE_MODULE_PATH "${modulePaths}" CACHE STRING "" FORCE)\nif(DEFINED MIKROBUS_WORKSPACE_PREFIX_PATH)\n  set(CMAKE_PREFIX_PATH "\${MIKROBUS_WORKSPACE_PREFIX_PATH}" CACHE STRING "" FORCE)\nelse()\n  set(CMAKE_PREFIX_PATH "${quoteCmake(options.installPrefix)}" CACHE STRING "" FORCE)\nendif()\n${options.sdkSetupBuild ? 'set(SDK_SETUP_BUILD TRUE)' : ''}\n${startup}\nadd_compile_definitions(PREINIT_SUPPORTED)\n${/^(xc8|xc16|xc32)$/.test(family) ? 'add_compile_definitions("$<$<CONFIG:Debug>:__DEBUG>")' : ''}\n${family === 'xc32' ? 'if(MIKROBUS_HARDWARE_DEBUG)\n  message(STATUS "MikroBUS XC32 hardware debug: enabling -mdebugger")\n  add_compile_options("-mdebugger")\n  add_link_options("-mdebugger")\nendif()' : ''}\n${mikroCCompileOptions ? `add_compile_options(${mikroCCompileOptions})` : ''}\n${compileLine}\n${linkLine}\n${linker}\n${xcConfigObjectLink}\nset(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)\nset(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)\nset(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)\nset(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)\n`;
  fs.writeFileSync(filePath, text, 'utf8');
}

function isCmakePathDefinition(key) {
  const name = String(key || '');
  return name === 'CMAKE_MAKE_PROGRAM' ||
    name === 'CMAKE_INSTALL_PREFIX' ||
    name === 'CORE_LIB' ||
    name === 'SEARCH_PATHS' ||
    /(?:_PATH|_FILE|_DIR)$/.test(name);
}

function cmakeDefinitionValue(key, value) {
  const text = cmakeValue(value);
  // CMake treats backslashes in string values as escape introducers. Native
  // Windows paths such as C:\Users\... therefore become invalid when a
  // generated CMake module expands the cache variable (\U is not a valid
  // CMake escape). CMake accepts forward slashes on Windows, so normalize only
  // path-like cache definitions at the command-line boundary. Keep filesystem
  // paths native everywhere else in the extension.
  return isCmakePathDefinition(key) ? text.replace(/\\/g, '/') : text;
}

function cmakeDefinitionArgument(key, value) {
  return `-D${key}=${cmakeDefinitionValue(key, value)}`;
}

function cmakeDefinitions(values) {
  const args = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    args.push(cmakeDefinitionArgument(key, value));
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
  const extension = parsed.ext.toLowerCase();
  if (extension === '.hex') return executable;
  if (extension === '.elf') return path.join(parsed.dir, `${parsed.name}.hex`);
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

function generateMikroCLanguageSupport(compatibilityRoot) {
  fs.mkdirSync(compatibilityRoot, { recursive: true });
  const files = {
    'CMakeDetermineMikroCCompiler.cmake': [
      'if(NOT CMAKE_MikroC_COMPILER)',
      '  if(DEFINED ENV{MIKROC} AND NOT "$ENV{MIKROC}" STREQUAL "")',
      '    set(CMAKE_MikroC_COMPILER "$ENV{MIKROC}" CACHE FILEPATH "MikroC compiler" FORCE)',
      '  endif()',
      'endif()',
      'if(NOT CMAKE_MikroC_COMPILER)',
      '  message(FATAL_ERROR "CMAKE_MikroC_COMPILER is not set")',
      'endif()',
      'set(CMAKE_MikroC_COMPILER_ENV_VAR "MIKROC")',
      'set(CMAKE_MikroC_COMPILER_ID "MikroC")',
      'set(CMAKE_MikroC_COMPILER_ID_RUN 1)',
      'set(CMAKE_MikroC_COMPILER_WORKS TRUE)',
      'configure_file("${CMAKE_CURRENT_LIST_DIR}/CMakeMikroCCompiler.cmake.in" "${CMAKE_PLATFORM_INFO_DIR}/CMakeMikroCCompiler.cmake" @ONLY)',
      ''
    ].join('\n'),
    'CMakeMikroCCompiler.cmake.in': [
      'set(CMAKE_MikroC_COMPILER "@CMAKE_MikroC_COMPILER@")',
      'set(CMAKE_MikroC_COMPILER_ID "MikroC")',
      'set(CMAKE_MikroC_COMPILER_ID_RUN 1)',
      'set(CMAKE_MikroC_COMPILER_LOADED 1)',
      'set(CMAKE_MikroC_COMPILER_WORKS TRUE)',
      'set(CMAKE_MikroC_COMPILER_ENV_VAR "MIKROC")',
      'set(CMAKE_MikroC_SOURCE_FILE_EXTENSIONS c)',
      'set(CMAKE_MikroC_IGNORE_EXTENSIONS h;H;o;O;obj;OBJ;mcl;emcl;a)',
      'if(DEFINED MIKROBUS_MIKROC_OUTPUT_EXTENSION AND NOT "${MIKROBUS_MIKROC_OUTPUT_EXTENSION}" STREQUAL "")',
      '  set(CMAKE_MikroC_OUTPUT_EXTENSION "${MIKROBUS_MIKROC_OUTPUT_EXTENSION}")',
      'else()',
      '  set(CMAKE_MikroC_OUTPUT_EXTENSION ".mcl")',
      'endif()',
      'set(CMAKE_MikroC_OUTPUT_EXTENSION_REPLACE 1)',
      'set(CMAKE_MikroC_LINKER_PREFERENCE 40)',
      ''
    ].join('\n'),
    'CMakeMikroCInformation.cmake': [
      'cmake_path(CONVERT "${SEARCH_PATHS}" TO_CMAKE_PATH_LIST SEARCH_PATH_LIST NORMALIZE)',
      'list(TRANSFORM SEARCH_PATH_LIST PREPEND "\\"")',
      'list(TRANSFORM SEARCH_PATH_LIST APPEND "\\"")',
      'list(TRANSFORM SEARCH_PATH_LIST PREPEND "-SP")',
      'list(JOIN SEARCH_PATH_LIST " " SEARCH_PATHS_ARG)',
      'set(CMAKE_STATIC_LIBRARY_SUFFIX_MikroC ".a")',
      'set(CMAKE_EXECUTABLE_SUFFIX_MikroC ".hex")',
      'set(CMAKE_C_ARCHIVE_FINISH "")',
      'set(CMAKE_C_ARCHIVE_CREATE "<CMAKE_MikroC_COMPILER> -ARH -NRL -b\\"${CMAKE_BINARY_DIR}\\" ${SEARCH_PATHS_ARG} -out <TARGET> <OBJECTS>")',
      'set(CMAKE_INCLUDE_FLAG_MikroC "-IP")',
      'set(CMAKE_INCLUDE_FLAG_SEP_MikroC " -IP")',
      'set(CMAKE_MikroC_COMPILE_OBJECT "<CMAKE_MikroC_COMPILER> -p${MCU_NAME} -jcom -DL -NRL -b\\"${CMAKE_BINARY_DIR}\\" -fo${OSC} <FLAGS> <DEFINES> ${SEARCH_PATHS_ARG} \\"${JCFG_FILE}\\" <INCLUDES> -out <OBJECT> <SOURCE> \\"${CORE_LIB}\\"")',
      'set(CMAKE_MikroC_LINK_EXECUTABLE "<CMAKE_MikroC_COMPILER> -p${MCU_NAME} -NRL -b\\"${CMAKE_BINARY_DIR}\\" -fo${OSC} <LINK_FLAGS> ${SEARCH_PATHS_ARG} \\"${JCFG_FILE}\\" -out <TARGET> <OBJECTS> <LINK_LIBRARIES> \\"${CORE_LIB}\\"")',
      'set(CMAKE_MikroC_CREATE_STATIC_LIBRARY "<CMAKE_MikroC_COMPILER> -ARH -NRL -b\\"${CMAKE_BINARY_DIR}\\" ${SEARCH_PATHS_ARG} -out <TARGET> <OBJECTS> <LINK_LIBRARIES> \\"${CORE_LIB}\\"")',
      ''
    ].join('\n'),
    'CMakeTestMikroCCompiler.cmake': 'set(CMAKE_MikroC_COMPILER_WORKS TRUE CACHE INTERNAL "")\n'
  };
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(compatibilityRoot, name), contents, 'utf8');
  return compatibilityRoot;
}

function generateMikroeUtilsCompatibility(infrastructure, generatedRoot, options = {}) {
  const compatibilityRoot = path.join(generatedRoot, 'cmake');
  fs.mkdirSync(compatibilityRoot, { recursive: true });
  if (options.generateMikroCLanguageSupport === true) generateMikroCLanguageSupport(compatibilityRoot);
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
    `# core_install() below uses CMake package-export helpers directly. Do not\n` +
    `# rely on individual core/SDK CMakeLists.txt files to include these first.\n` +
    `include(GNUInstallDirs)\n` +
    `include(CMakePackageConfigHelpers)\n` +
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
    `  target_compile_definitions(\${target} PUBLIC OSC_KHZ=\${OSC_KHZ})\n` +
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
    boardUid: setup.selection?.boardUid || setup.boardUid || metadata.board?.uid || undefined,
    mode: setup.mode === 'bare-metal' ? 'bare-metal' : 'full-sdk'
  };
}

function refreshSetupMetadata(context, setup) {
  const selection = selectionFromSetup(setup);
  if (!selection.deviceUid || !selection.compilerUid || (!selection.sdkUid && selection.mode !== 'bare-metal') || !selection.programmerUid) {
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
  const names = process.platform === 'win32'
    ? ['CodegripGdbServer.exe', 'codegrip_gdb_server.exe', 'codegrip-gdb-server.exe']
    : ['CodegripGdbServer', 'codegrip_gdb_server', 'codegrip-gdb-server'];
  const candidates = names.flatMap((name) => [
    path.join(root, 'apps', name),
    path.join(root, 'apps', 'bin', name),
    path.join(root, 'bin', name),
    path.join(root, name)
  ]);
  if (process.platform === 'darwin') {
    candidates.unshift(path.join(root, 'apps', 'CodegripGdbServer.app', 'Contents', 'MacOS', 'CodegripGdbServer'));
  }
  return candidates;
}

function findCodegripServerExecutable(root) {
  const direct = codegripServerCandidates(root).find((candidate) => fs.existsSync(candidate));
  if (direct) return direct;
  return findRecursive(root, (_candidate, name) => {
    const normalized = String(name || '').replace(/\.exe$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return normalized === 'codegripgdbserver';
  }, 10);
}

function materializeCodegripRuntime(context, setup, installed) {
  if (setup.metadata.programmer.uid !== 'codegrip') return undefined;
  const serverSpec = packages.codegripServerPackageSpec({ environment: true });
  if (!serverSpec) throw new Error(`CODEGRIP GDB Server package is not available for ${process.platform}.`);
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


function cmakeQuotedString(value) {
  return String(value || '').replace(/\\/g, '/').replace(/"/g, '\\"');
}

function materializeSyntheticCardlessBoard(sdkSource, setup) {
  if (setup?.mode !== 'full-sdk') return undefined;
  const requirements = setup?.metadata?.packageRequirements || {};
  if (requirements.card || requirements.board) return undefined;

  const board = setup?.metadata?.board;
  const sdkConfig = setup?.metadata?.sdkConfig || {};
  const boardName = String(
    sdkConfig._MSDK_BOARD_NAME_
    || sdkConfig.MSDK_BOARD_NAME
    || board?.uid
    || 'GENERIC_BOARD'
  ).trim();
  if (!boardName) return undefined;

  // mikroSDK's board CMake defaults MCU_CARD to TRUE and later expands
  // _MSDK_MCU_CARD_NAME_ unquoted. Cardless generic targets therefore need a
  // board-specific CMake hook that turns MCU_CARD/DIP_SOCKET off before that
  // block executes. This uses mikroSDK's normal board discovery mechanism and
  // does not modify bsp/board/CMakeLists.txt.
  const folderName = `board_${boardName.toLowerCase().replace(/[^a-z0-9_]+/g, '_')}`;
  const boardRoot = path.join(sdkSource, 'bsp', 'board', 'include', 'boards', folderName);
  fs.mkdirSync(boardRoot, { recursive: true });

  const conditionValue = cmakeQuotedString(boardName);
  const cmakeText = [
    `if("\${_MSDK_BOARD_NAME_}" STREQUAL "${conditionValue}")`,
    `    set(BOARD_PATH "include/boards/${folderName}")`,
    '    set(MCU_CARD FALSE)',
    '    set(DIP_SOCKET FALSE)',
    '    set(MIKROBUS FALSE)',
    '    set(SHIELD FALSE)',
    '    set(PIM_SOCKET FALSE)',
    // bsp/board/CMakeLists.txt evaluates this variable unquoted later even
    // while DIP_SOCKET is FALSE, so keep a harmless non-empty sentinel.
    '    set(MSDK_FILTERED_DIP_SOCKET_TYPE "none")',
    'endif()',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(boardRoot, 'board.cmake'), cmakeText, 'utf8');

  const displayName = String(board?.name || boardName || 'Generic board').replace(/"/g, '\\"');
  const headerText = [
    '#ifndef _BOARD_H_',
    '#define _BOARD_H_',
    '',
    `#define BOARD_NAME "${displayName}"`,
    '',
    '#endif // _BOARD_H_',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(boardRoot, 'board.h'), headerText, 'utf8');
  return { boardName, folderName, boardRoot };
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
  const resolved = resolveToolchain(setup, installed);
  let currentXcPrivilegeFingerprint = '';
  if (process.platform === 'linux' && /^xc(8|16|32)$/.test(String(resolved.adapter?.family || ''))) {
    progress.report({ message: `Preparing ${setup.metadata.compiler.name || resolved.adapter?.language || 'Microchip XC'} license helper...` });
    const xclmFiles = await packages.ensureXcCompilerReady(context, setup.metadata.compiler, progress, token);
    currentXcPrivilegeFingerprint = xcPrivilegeFingerprint(xclmFiles);
  }
  const mikroCSetup = isMikroCFamily(resolved.adapter?.family);
  const managedNectoCmake = resolveManagedNectoCmake(installed);
  const managedNinja = resolveManagedNinja(installed);
  const managedMikroCCmakeModules = mikroCSetup ? resolveManagedMikroCCmakeModules(installed) : undefined;
  const cmake = managedNectoCmake || resolveBuildTool('cmake', [], context);
  const ninja = managedNinja || resolveBuildTool('ninja', ['ninja-build'], context);
  if (!cmake || !ninja) {
    throw new Error(
      `CMake and Ninja are required. The extension could not resolve or install managed build tools for ${process.platform}/${process.arch}. ` +
      'You can also set mikrobusRust.cCmakePath and mikrobusRust.cNinjaPath to an executable or containing directory.'
    );
  }
  if (mikroCSetup && process.platform === 'linux' && !managedNectoCmake) {
    throw new Error('The managed NECTO CMake package required for mikroC was not found after installation. Reinstall the C setup packages.');
  }
  if (mikroCSetup && !managedMikroCCmakeModules) {
    throw new Error('The managed mikroC CMake language package is incomplete. Expected CMakeDetermineMikroCCompiler.cmake, CMakeMikroCCompiler.cmake.in, CMakeMikroCInformation.cmake, and CMakeTestMikroCCompiler.cmake.');
  }
  if (managedNectoCmake) output.appendLine(`Managed NECTO CMake: ${managedNectoCmake}`);
  if (managedMikroCCmakeModules) output.appendLine(`Managed mikroC CMake modules: ${managedMikroCCmakeModules}`);
  output.appendLine(`Compiler DB C binary: ${setup.metadata.compiler.cCompiler || '(not set)'} -> ${resolved.c || '(not found)'}`);
  output.appendLine(`Compiler DB ASM binary: ${setup.metadata.compiler.asmCompiler || '(not set)'} -> ${resolved.assembler || '(not found)'}`);
  output.appendLine(`CMake ASM driver: ${resolved.cmakeAsm || resolved.asm || '(not found)'}`);
  const coreSpec = specs.find((spec) => spec.kind === 'core' && spec.name === setup.metadata.corePackageName);
  const coreRoot = coreSpec ? packageRoot(installed, coreSpec.kind, coreSpec.name, coreSpec.version) : undefined;
  const coreSource = locateCoreSource(coreRoot, setup.metadata.compiler.corePath, setup.metadata.coreMcuName || setup.metadata.sdkConfig.MCU_NAME, resolved.adapter?.family);
  if (!coreSource || !fs.existsSync(path.join(coreSource, 'CMakeLists.txt'))) throw new Error(`Core package '${setup.metadata.corePackageName}' does not contain a usable core for ${setup.metadata.coreMcuName || setup.metadata.sdkConfig.MCU_NAME}.`);
  const mikroCCoreDefinition = isMikroCFamily(resolved.adapter?.family)
    ? resolveCoreDefinitionFile(coreSource, setup.metadata.coreMcuName || setup.metadata.sdkConfig.MCU_NAME, setup.metadata?.device?.defFile)
    : undefined;
  const mikroCCoreMcuName = mikroCCoreDefinition ? path.basename(mikroCCoreDefinition, path.extname(mikroCCoreDefinition)) : undefined;
  if (mikroCCoreMcuName && mikroCCoreMcuName !== (setup.metadata.coreMcuName || setup.metadata.sdkConfig.MCU_NAME)) {
    output.appendLine(`mikroC core MCU filename normalization: ${setup.metadata.coreMcuName || setup.metadata.sdkConfig.MCU_NAME} -> ${mikroCCoreMcuName}`);
  }
  const setupRoot = setupDirectory(context, setup.id);
  const buildRoot = path.join(setupRoot, 'build');
  const installPrefix = path.join(setupRoot, 'install');
  const generatedRoot = path.join(setupRoot, 'generated');
  fs.mkdirSync(generatedRoot, { recursive: true });
  const mikroCJcfgFile = mikroCSetup
    ? generateMikroCJcfg(
        coreSource,
        setup.metadata,
        setup.registerValues || {},
        generatedRoot,
        mikroCCoreMcuName || setup.metadata.coreMcuName || setup.metadata.sdkConfig.MCU_NAME
      )
    : undefined;
  if (mikroCJcfgFile) output.appendLine(`Generated mikroC JCFG: ${mikroCJcfgFile}`);
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
  const compatibilityModuleRoot = generateMikroeUtilsCompatibility(infrastructure, generatedRoot, { generateMikroCLanguageSupport: false });
  const coreBuildRoot = path.join(buildRoot, 'core');
  const mikroCCore = mikroCSetup;
  let coreHeader;
  if (!mikroCCore) {
    // GCC/Clang/XC/Renesas core install rules consume
    // ${CMAKE_BINARY_DIR}/core_header.h and source/include/core_header.h.
    coreHeader = generateCoreHeader(coreSource, setup.metadata, setup.clockMHz, coreBuildRoot, setup.registerValues || {});
    const generatedHeaderCopy = path.join(generatedRoot, 'core_header.h');
    fs.copyFileSync(coreHeader, generatedHeaderCopy);
  }
  const coreToolchain = path.join(generatedRoot, 'core-toolchain.cmake');
  writeToolchain(coreToolchain, setup, resolved, {
    coreSource,
    compatibilityModuleRoot,
    infrastructureRoot: infrastructure.cmakeUtils,
    mikroCModuleRoot: managedMikroCCmakeModules,
    installPrefix,
    mcuNameOverride: mikroCCoreMcuName,
    jcfgFile: mikroCJcfgFile,
    coreLib: ''
  });
  progress.report({ message: `Building ${setupMcuName(setup)} core...` });
  const coreDefinitions = {
    CMAKE_MAKE_PROGRAM: ninja,
    CMAKE_TOOLCHAIN_FILE: coreToolchain,
    CMAKE_BUILD_TYPE: 'Debug',
    CMAKE_INSTALL_PREFIX: installPrefix,
    CMAKE_PREFIX_PATH: installPrefix,
    TEST_LIB_PATH: infrastructure.testLib,
    PREINIT_ROUTINE_PATH: infrastructure.preinit,
    ...completeSdkCmakeVariables(setup.metadata),
    ...(mikroCCoreMcuName ? { MCU_NAME: mikroCCoreMcuName } : {}),
    MIKROSDK_TYPE: setup.mode === 'full-sdk' ? 'mikrosdk' : 'baremetal',
    COMPILER_FLAGS: '',
    LINKER_FLAGS: '',
    SEARCH_PATHS: '',
    JCFG_FILE: mikroCJcfgFile || '',
    CORE_LIB: '',
    IS_BARE_METAL: setup.mode === 'bare-metal' ? 'TRUE' : 'FALSE',
    MCU_IS_DUALCORE: 'FALSE'
  };
  if (mikroCCore) {
    await configureBuildInstall(cmake, coreSource, coreBuildRoot, coreDefinitions, token);
  } else {
    await withTemporaryCoreHeader(coreSource, coreHeader, () => configureBuildInstall(cmake, coreSource, coreBuildRoot, coreDefinitions, token));
  }

  const mikroCCoreLib = mikroCSetup
    ? (findRecursive(installPrefix, (_candidate, name) => name === 'lib_core.a', 5) || path.join(installPrefix, 'lib', 'lib_core.a'))
    : undefined;
  if (mikroCSetup && (!mikroCCoreLib || !fs.existsSync(mikroCCoreLib))) {
    throw new Error(`mikroC core build completed but lib_core.a was not installed below ${installPrefix}.`);
  }
  if (mikroCCoreLib) output.appendLine(`mikroC core library: ${mikroCCoreLib}`);

  const linkerScript = findFirstByExtension(path.dirname(installPrefix), ['.ld', '.lds', '.gld', '.lkr']);
  const startupFile = findFirstByExtension(path.dirname(installPrefix), ['.s', '.S']);
  const xcConfiguration = await buildXcConfigurationObject(setup, resolved, coreSource, generatedRoot, token);
  if (xcConfiguration?.objectPath) output.appendLine(`XC configuration object: ${xcConfiguration.objectPath}`);
  const projectToolchain = path.join(generatedRoot, 'toolchain.cmake');
  writeToolchain(projectToolchain, setup, resolved, {
    coreSource,
    compatibilityModuleRoot,
    infrastructureRoot: infrastructure.cmakeUtils,
    mikroCModuleRoot: managedMikroCCmakeModules,
    installPrefix,
    linkerScript,
    startupFile,
    xcConfigObject: xcConfiguration?.objectPath,
    jcfgFile: mikroCJcfgFile,
    coreLib: mikroCCoreLib
  });

  if (setup.mode === 'full-sdk') {
    const sdkSpec = specs.find((spec) => spec.kind === 'sdk' && spec.name === 'mikrosdk');
    const sdkRoot = sdkSpec ? packageRoot(installed, sdkSpec.kind, sdkSpec.name, sdkSpec.version) : undefined;
    const sdkSource = locateSdkSource(sdkRoot);
    if (!sdkSource || !fs.existsSync(path.join(sdkSource, 'CMakeLists.txt'))) throw new Error('The latest mikroSDK package has no recognizable source root.');
    materializeSelectedBsp(context, sdkSource, setup, specs, installed);
    const syntheticBoard = materializeSyntheticCardlessBoard(sdkSource, setup);
    if (syntheticBoard) {
      output.appendLine(`Using cardless SDK board: ${syntheticBoard.boardName} -> ${syntheticBoard.folderName}`);
    }
    const sdkToolchain = path.join(generatedRoot, 'sdk-toolchain.cmake');
    writeToolchain(sdkToolchain, setup, resolved, {
      coreSource,
      compatibilityModuleRoot,
      infrastructureRoot: infrastructure.cmakeUtils,
      mikroCModuleRoot: managedMikroCCmakeModules,
      installPrefix,
      linkerScript,
      sdkSetupBuild: true,
      jcfgFile: mikroCJcfgFile,
      coreLib: mikroCCoreLib
    });
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
      // mikroSDK decides between `project(... LANGUAGES MikroC)` and
      // `project(... LANGUAGES C ASM)` before project() loads the toolchain.
      // NECTO therefore supplies TOOLCHAIN_LANGUAGE on the CMake command line.
      // Setting it only inside CMAKE_TOOLCHAIN_FILE is too late here and causes
      // host GCC/Clang to be selected for the SDK source tree.
      ...sdkPreProjectCmakeVariables(resolved),
      MIKROSDK_TYPE: 'mikrosdk',
      COMPILER_FLAGS: '',
      LINKER_FLAGS: '',
      SEARCH_PATHS: '',
      JCFG_FILE: mikroCJcfgFile || '',
      CORE_LIB: mikroCCoreLib || '',
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
  setup.paths = { installPrefix, toolchainFile: projectToolchain, linkerScript, startupFile, jcfgFile: mikroCJcfgFile, coreSource, xcConfigSource: xcConfiguration?.sourcePath, xcConfigObject: xcConfiguration?.objectPath };
  setup.tools = {
    cmake,
    ninja,
    compiler: resolved.c,
    gdb: resolved.gdb,
    objcopy: resolved.objcopy,
    ar: resolved.ar,
    rfpCli: setup.metadata.programmer.uid === rfp.RFP_PROGRAMMER_UID ? packages.managedRfpCli(context) : undefined
  };
  setup.buildSupportVersion = C_BUILD_SUPPORT_VERSION;
  if (currentXcPrivilegeFingerprint) setup.xcPrivilegeFingerprint = currentXcPrivilegeFingerprint;
  else delete setup.xcPrivilegeFingerprint;
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
    ? packages.getInstalledPackage(context, packages.codegripServerPackageSpec({ environment: true }))
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
    if (previousProgrammer !== selection.programmerUid || previousDevice !== selection.deviceUid || selection.programmerUid !== rfp.RFP_PROGRAMMER_UID) {
      delete setup.rfpProfile;
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
  const compilerFamily = compilerSupport.adapterFor(setup?.metadata?.compiler?.uid)?.family || '';
  const projectLanguages = isMikroCFamily(compilerFamily) ? 'MikroC' : 'C ASM';
  return `cmake_minimum_required(VERSION 3.20)\nproject(mikrobus_c_application LANGUAGES ${projectLanguages})\n\nfind_package(MikroC.Core REQUIRED)\n${fullSdk ? 'find_package(MikroSDK.Board REQUIRED)\n' : ''}file(GLOB_RECURSE APP_SOURCES CONFIGURE_DEPENDS "src/*.c")\nadd_executable(\${PROJECT_NAME} \${APP_SOURCES})\nif(DEFINED MIKROBUS_STARTUP_FILE AND EXISTS "\${MIKROBUS_STARTUP_FILE}")\n  target_sources(\${PROJECT_NAME} PRIVATE "\${MIKROBUS_STARTUP_FILE}")\nendif()\ntarget_link_libraries(\${PROJECT_NAME} PRIVATE MikroC.Core${fullSdk ? ' MikroSDK.Board' : ''})\nset_target_properties(\${PROJECT_NAME} PROPERTIES SUFFIX ".elf")\n`;
}

function starterMain() {
  return `#include <stdint.h>\n\nint main(void)\n{\n    for (;;) {\n        /* Application loop. */\n    }\n}\n`;
}

function cleanAppliedSetupArtifacts(root) {
  cmakeVisibility.clear(root);
  const extensionBuildRoot = path.join(root, '.mikrobus');
  fs.rmSync(extensionBuildRoot, { recursive: true, force: true });
  const bindingPath = path.join(root, '.vscode', 'mikrobus-c.json');
  fs.rmSync(bindingPath, { force: true });
}

function invalidateBuiltSetupArtifacts(context, setup) {
  const root = setupDirectory(context, setup.id);
  for (const name of ['build', 'install', 'generated']) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  delete setup.paths;
  delete setup.tools;
  delete setup.packageKeys;
  delete setup.builtAt;
  delete setup.lastElf;
  delete setup.lastHex;
  delete setup.sdkDriverPackages;
  writeJsonAtomic(setupFile(context, setup.id), setup);
}

async function refreshXcSetupIfPrivilegeChanged(context, setup) {
  const family = compilerFamilyForSetup(setup);
  if (process.platform !== 'linux' || !/^xc(8|16|32)$/.test(family)) return setup;
  const previous = String(setup.xcPrivilegeFingerprint || '');
  const xclmFiles = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Checking ${setup.metadata?.compiler?.name || 'Microchip XC'} license helper`,
    cancellable: true
  }, (progress, token) => packages.ensureXcCompilerReady(context, setup.metadata.compiler, progress, token));
  const current = xcPrivilegeFingerprint(xclmFiles);
  if (previous && current && previous === current) return setup;
  output.appendLine(`XC setup privilege state changed${previous ? '' : ' (legacy setup had no recorded XCLM state)'}; rebuilding ${setup.name} before Apply.`);
  invalidateBuiltSetupArtifacts(context, setup);
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Rebuilding XC setup after XCLM privilege change: ${setup.name}`,
    cancellable: true
  }, (progress, token) => ensureAndBuildSetup(context, setup, progress, token));
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
    setup = await refreshXcSetupIfPrivilegeChanged(context, setup);
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
    try {
      await refreshWorkspaceCmakeVisibility(context, root, {
        location: vscode.ProgressLocation.Window,
        title: `MikroBUS C: Evaluating active files for ${setup.name}...`
      });
    } catch (error) {
      // Applying the setup is still valid even if a user's CMake project does
      // not configure yet. Build will surface the full CMake error later.
      output.appendLine(`CMake Explorer visibility refresh skipped: ${error.message || error}`);
    }
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

function safeWorkspaceInstallPath(root) {
  return path.join(root, '.mikrobus', 'c-install');
}

function mirrorDirectoryStructure(source, target, maximumDepth = 16) {
  fs.mkdirSync(target, { recursive: true });
  if (!source || !fs.existsSync(source)) return;
  const queue = [{ source, target, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try { entries = fs.readdirSync(current.source, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const destination = path.join(current.target, entry.name);
      fs.mkdirSync(destination, { recursive: true });
      if (current.depth < maximumDepth) {
        queue.push({ source: path.join(current.source, entry.name), target: destination, depth: current.depth + 1 });
      }
    }
  }
}

function createStaticInstallPrefixDirectories(projectRoot, installPrefix) {
  if (!projectRoot || !fs.existsSync(projectRoot)) return;
  const queue = [projectRoot];
  while (queue.length) {
    const directory = queue.shift();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.mikrobus' || entry.name === 'node_modules') continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(candidate);
        continue;
      }
      if (!entry.isFile() || !(entry.name === 'CMakeLists.txt' || entry.name.toLowerCase().endsWith('.cmake'))) continue;
      let text;
      try { text = fs.readFileSync(candidate, 'utf8'); } catch { continue; }
      for (const match of text.matchAll(/\$\{CMAKE_INSTALL_PREFIX\}\/([A-Za-z0-9_.\/-]+)/g)) {
        const relative = String(match[1] || '').replace(/^\/+|\/+$/g, '');
        if (relative) fs.mkdirSync(path.join(installPrefix, relative), { recursive: true });
      }
    }
  }
}

function prepareWorkspaceInstallPrefix(root, setup) {
  const installPrefix = safeWorkspaceInstallPath(root);
  fs.mkdirSync(installPrefix, { recursive: true });
  // mikroSDK's install_headers() writes generated package headers directly
  // below CMAKE_INSTALL_PREFIX during the configure phase. Mirror only the
  // directory layout of the already-built setup prefix so those destinations
  // exist without copying/importing any installed MikroSDK targets.
  mirrorDirectoryStructure(setup?.paths?.installPrefix, installPrefix);
  createStaticInstallPrefixDirectories(root, installPrefix);
  return installPrefix;
}

function activeWorkspaceSource(root) {
  const document = vscode.window.activeTextEditor?.document;
  if (document?.uri?.scheme !== 'file' || !document.uri.fsPath || !pathIsInside(document.uri.fsPath, root)) return undefined;
  const extension = path.extname(document.uri.fsPath).toLowerCase();
  if (!new Set(['.c', '.cc', '.cpp', '.cxx', '.s', '.asm']).has(extension)) return undefined;
  return path.resolve(document.uri.fsPath);
}

async function configuredTargetForActiveSource(root, build) {
  const source = activeWorkspaceSource(root);
  if (!source) return undefined;
  const owning = cmakeVisibility.targetsForSource(root, build, source);
  if (!owning.length) return undefined;
  const executableTargets = owning.filter((target) => target.type === 'EXECUTABLE');
  const candidates = executableTargets.length ? executableTargets : owning;
  if (candidates.length === 1) return { source, target: candidates[0] };
  const selected = await quickPick(candidates.map((target) => ({
    label: target.name,
    description: target.type || 'CMake target',
    detail: `Owns ${path.relative(root, source)}`,
    value: target
  })), {
    placeHolder: `Select the CMake target to build for ${path.basename(source)}`,
    emptyMessage: 'No configured CMake target owns the active source file.'
  });
  return selected ? { source, target: selected.value } : undefined;
}



async function workspaceBuildEnvironment(context, root) {
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
  const compilerFamily = String(compilerSupport.adapterFor(setup.metadata?.compiler?.uid)?.family || '');
  if (process.platform === 'linux' && /^xc(8|16|32)$/.test(compilerFamily)) {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Preparing ${setup.metadata.compiler.name || compilerSupport.adapterFor(setup.metadata.compiler.uid)?.language || 'Microchip XC'} license helper`,
      cancellable: true
    }, (progress, token) => packages.ensureXcCompilerReady(context, setup.metadata.compiler, progress, token));
  }
  const cmake = setup.tools?.cmake && fs.existsSync(setup.tools.cmake) ? setup.tools.cmake : resolveBuildTool('cmake', [], context);
  const ninja = setup.tools?.ninja && fs.existsSync(setup.tools.ninja) ? setup.tools.ninja : resolveBuildTool('ninja', ['ninja-build'], context);
  if (!cmake || !ninja) throw new Error('CMake and Ninja are required for project builds.');
  return { setup, cmake, ninja };
}

function isMikroSdkSourceProject(root) {
  const cmakeFile = path.join(root, 'CMakeLists.txt');
  if (!fs.existsSync(cmakeFile)) return false;
  try {
    const text = fs.readFileSync(cmakeFile, 'utf8');
    return /find_package\s*\(\s*MikroC\.Core\b/i.test(text) &&
      /add_subdirectory\s*\(\s*drv\s*\)/i.test(text) &&
      /add_subdirectory\s*\(\s*bsp\s*\)/i.test(text) &&
      fs.existsSync(path.join(root, 'drv')) &&
      fs.existsSync(path.join(root, 'bsp'));
  } catch {
    return false;
  }
}

function workspacePrefixArguments(root, setup) {
  if (!isMikroSdkSourceProject(root)) return [cmakeDefinitionArgument('CMAKE_PREFIX_PATH', setup.paths.installPrefix)];
  const coreConfig = findInstalledPackageConfig(setup.paths.installPrefix, 'MikroC.Core');
  if (!coreConfig) {
    throw new Error(`The selected setup does not contain MikroC.CoreConfig.cmake below ${setup.paths.installPrefix}. Rebuild the setup first.`);
  }
  // A full SDK setup prefix also contains installed MikroSDK.Driver.*, Board,
  // HAL, etc. Exposing those while configuring the mikroSDK source tree would
  // import the installed targets before the same targets are created from
  // source. Use only the installed core package; every MikroSDK.* target then
  // comes from the checked-out source tree and its real CMake dependency graph.
  return [
    cmakeDefinitionArgument('MIKROBUS_WORKSPACE_PREFIX_PATH', ''),
    cmakeDefinitionArgument('MikroC.Core_DIR', path.dirname(coreConfig))
  ];
}

function workspaceSourceTreeDefinitionArguments(setup) {
  return [
    `-DLOG_INTERFACE=${applicationOutputCmakeValue(setup.applicationOutput)}`,
    `-DIS_BARE_METAL=${setup.mode === 'bare-metal' ? 'TRUE' : 'FALSE'}`,
    '-DMSDK_BUILD_TFT_MODULES=FALSE',
    '-DBUILD_LVGL_FROM_NECTO=FALSE',
    '-DMCU_IS_DUALCORE=FALSE'
  ];
}

function workspacePreProjectCmakeArguments(setup) {
  // Some NECTO/mikroSDK application CMakeLists choose their project() language
  // from TOOLCHAIN_LANGUAGE before project() is called. CMake only loads the
  // toolchain file while processing project(), so setting this variable only in
  // toolchain.cmake is one configure too late. Seed it on the first workspace
  // configure command too, matching the SDK bootstrap/NECTO behavior.
  const compilerUid = setup?.metadata?.compiler?.uid || setup?.selection?.compilerUid;
  const variables = sdkPreProjectCmakeVariables({ adapter: compilerSupport.adapterFor(compilerUid) });
  return Object.entries(variables).map(([key, value]) => cmakeDefinitionArgument(key, value));
}

async function configureWorkspaceProject(root, setup, cmake, ninja, token, options = {}) {
  const build = safeWorkspaceBuildPath(root);
  const workspaceInstallPrefix = prepareWorkspaceInstallPrefix(root, setup);
  const sdkSourceMode = isMikroSdkSourceProject(root);
  cmakeVisibility.prepareFileApiQuery(build);
  output.appendLine(`CMake project root: ${root}`);
  output.appendLine(`Workspace CMake install prefix: ${workspaceInstallPrefix}`);
  if (sdkSourceMode) {
    output.appendLine(`mikroSDK source-tree mode: using MikroC.Core from ${setup.paths.installPrefix}; SDK targets will be built from the opened source tree.`);
  }
  const sourceTreeDefinitions = sdkSourceMode ? workspaceSourceTreeDefinitionArguments(setup) : [];
  const preProjectDefinitions = workspacePreProjectCmakeArguments(setup);
  await runLogged(cmake, ['-S', root, '-B', build, '-G', 'Ninja',
    cmakeDefinitionArgument('CMAKE_MAKE_PROGRAM', ninja),
    cmakeDefinitionArgument('CMAKE_TOOLCHAIN_FILE', setup.paths.toolchainFile),
    ...preProjectDefinitions,
    cmakeDefinitionArgument('CMAKE_INSTALL_PREFIX', workspaceInstallPrefix),
    ...workspacePrefixArguments(root, setup),
    ...sourceTreeDefinitions,
    `-DMIKROBUS_HARDWARE_DEBUG=${options.hardwareDebug ? 'TRUE' : 'FALSE'}`,
    '-DCMAKE_BUILD_TYPE=Debug', '-DCMAKE_EXPORT_COMPILE_COMMANDS=1'], { token });
  // File API codemodel + cmakeFiles already knows which targets/source files and
  // included .cmake files survived all setup/database-dependent conditionals.
  cmakeVisibility.updateFromBuild(root, build, ninja);
  return build;
}

async function refreshWorkspaceCmakeVisibility(context, root = cProjectRoot(), options = {}) {
  const { setup, cmake, ninja } = await workspaceBuildEnvironment(context, root);
  return vscode.window.withProgress({
    location: options.location || vscode.ProgressLocation.Window,
    title: options.title || `MikroBUS C: Evaluating CMake configuration for ${setupMcuName(setup)}...`,
    cancellable: true
  }, async (_progress, token) => {
    const build = await configureWorkspaceProject(root, setup, cmake, ninja, token);
    cmakeVisibility.updateFromBuild(root, build, ninja);
    return { setup, build, cmake, ninja };
  });
}

async function buildWorkspace(context, options = {}) {
  try {
    const root = cProjectRoot();
    const { setup, cmake, ninja } = await workspaceBuildEnvironment(context, root);
    let build;
    let selectedTarget;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Building ${setup.name}`, cancellable: true }, async (progress, token) => {
      progress.report({ message: 'Configuring project...' });
      build = await configureWorkspaceProject(root, setup, cmake, ninja, token, options);
      selectedTarget = await configuredTargetForActiveSource(root, build);
      if (selectedTarget?.target?.name) {
        progress.report({ message: `Compiling CMake target ${selectedTarget.target.name}...` });
        output.appendLine(`Active source target: ${path.relative(root, selectedTarget.source)} -> ${selectedTarget.target.name}`);
        await runLogged(cmake, ['--build', build, '--target', selectedTarget.target.name], { token });
      } else {
        progress.report({ message: 'Compiling project...' });
        await runLogged(cmake, ['--build', build], { token });
      }
      // After compilation Ninja's dependency database contains the headers that
      // were actually selected by the compiler preprocessor under this MCU/setup.
      cmakeVisibility.updateFromBuild(root, build, ninja);
    });
    const targetArtifact = selectedTarget?.target?.type === 'EXECUTABLE'
      ? cmakeVisibility.executableArtifactForTarget(root, build, selectedTarget.target.name)
      : undefined;
    const elf = targetArtifact && fs.existsSync(targetArtifact) ? targetArtifact : findBuiltExecutable(build, root);
    if (!elf) throw new Error(`Build completed but no ELF executable output was found below ${build}.`);
    const hex = await ensureHex(setup, elf);
    setup.lastElf = elf;
    setup.lastHex = hex;
    setup.lastBuiltAt = new Date().toISOString();
    writeJsonAtomic(setupFile(context, setup.id), setup);
    vscode.window.showInformationMessage(`C build complete${selectedTarget?.target?.name ? ` (${selectedTarget.target.name})` : ''}: ${path.basename(elf)} + ${path.basename(hex)}`);
    return { setup, elf, hex, target: selectedTarget?.target?.name };
  } catch (error) {
    vscode.window.showErrorMessage(`MikroBUS C build: ${error.message || error}`);
    output.show(true);
  }
}

async function cleanWorkspace() {
  try {
    const root = cProjectRoot();
    const target = path.resolve(safeWorkspaceBuildPath(root));
    const installTarget = path.resolve(safeWorkspaceInstallPath(root));
    const parent = path.resolve(path.join(root, '.mikrobus'));
    if (path.dirname(target) !== parent || path.dirname(installTarget) !== parent) throw new Error(`Refusing to clean unexpected path below: ${parent}`);
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(installTarget, { recursive: true, force: true });
    cmakeVisibility.clear(root);
    vscode.window.showInformationMessage('MikroBUS C build output cleaned.');
  } catch (error) {
    vscode.window.showErrorMessage(`MikroBUS C clean: ${error.message || error}`);
  }
}

function compilerFamilyForSetup(setup) {
  return String(compilerSupport.adapterFor(setup?.metadata?.compiler?.uid)?.family || '');
}

function xcPrivilegeFingerprint(xclmFiles) {
  const rows = [];
  for (const filePath of Array.isArray(xclmFiles) ? xclmFiles : []) {
    try {
      const stat = fs.statSync(filePath);
      rows.push({
        path: path.resolve(filePath),
        uid: Number(stat.uid),
        gid: Number(stat.gid),
        mode: Number(stat.mode) & 0o7777,
        size: Number(stat.size),
        ctimeMs: Math.trunc(Number(stat.ctimeMs) || 0)
      });
    } catch {}
  }
  rows.sort((left, right) => left.path.localeCompare(right.path));
  return rows.length ? JSON.stringify(rows) : '';
}

function looksLikeIntelHex(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).size <= 0) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(256);
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, count).toString('ascii').trimStart().startsWith(':');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function intelHexRecord(address, type, data = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  const bytes = [payload.length & 0xFF, (address >> 8) & 0xFF, address & 0xFF, type & 0xFF, ...payload];
  const checksum = ((-bytes.reduce((sum, value) => (sum + value) & 0xFF, 0)) & 0xFF);
  return `:${bytes.map((value) => value.toString(16).toUpperCase().padStart(2, '0')).join('')}${checksum.toString(16).toUpperCase().padStart(2, '0')}`;
}

function parseIntelHex(text) {
  const memory = new Map();
  const preserved = [];
  let upper = 0;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith(':')) continue;
    let bytes;
    try { bytes = Buffer.from(line.slice(1), 'hex'); } catch { throw new Error(`Invalid Intel HEX record: ${line.slice(0, 40)}`); }
    if (bytes.length < 5) throw new Error(`Invalid Intel HEX record: ${line.slice(0, 40)}`);
    const length = bytes[0];
    const address = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    const data = bytes.subarray(4, 4 + length);
    const expected = bytes[4 + length];
    const sum = bytes.subarray(0, 5 + length).reduce((value, item) => (value + item) & 0xFF, 0);
    if (sum !== 0 || expected === undefined) throw new Error(`Intel HEX checksum error: ${line.slice(0, 40)}`);
    if (type === 0x00) {
      const absolute = (upper + address) >>> 0;
      for (let index = 0; index < data.length; index += 1) memory.set((absolute + index) >>> 0, data[index]);
    } else if (type === 0x02 && data.length === 2) {
      upper = (data.readUInt16BE(0) << 4) >>> 0;
    } else if (type === 0x04 && data.length === 2) {
      upper = (data.readUInt16BE(0) << 16) >>> 0;
    } else if (type === 0x03 || type === 0x05) {
      preserved.push({ type, data: Buffer.from(data) });
    }
  }
  return { memory, preserved };
}

function serializeIntelHex(parsed) {
  const memory = parsed?.memory instanceof Map ? parsed.memory : new Map();
  const addresses = [...memory.keys()].sort((left, right) => left - right);
  const lines = [];
  let upper = -1;
  let index = 0;
  while (index < addresses.length) {
    const start = addresses[index] >>> 0;
    const currentUpper = (start >>> 16) & 0xFFFF;
    if (currentUpper !== upper) {
      const data = Buffer.alloc(2);
      data.writeUInt16BE(currentUpper, 0);
      lines.push(intelHexRecord(0, 0x04, data));
      upper = currentUpper;
    }
    const low = start & 0xFFFF;
    const chunk = [];
    let expected = start;
    while (index < addresses.length && chunk.length < 16) {
      const address = addresses[index] >>> 0;
      if (address !== expected || ((address >>> 16) & 0xFFFF) !== upper) break;
      chunk.push(memory.get(address));
      expected = (expected + 1) >>> 0;
      index += 1;
    }
    lines.push(intelHexRecord(low, 0x00, Buffer.from(chunk)));
  }
  for (const record of parsed?.preserved || []) lines.push(intelHexRecord(0, record.type, record.data));
  lines.push(intelHexRecord(0, 0x01));
  return `${lines.join('\n')}\n`;
}

function xcConfigurationFieldId(word) {
  const group = String(word?.label_group || 'Configuration').trim() || 'Configuration';
  return `${group}.${String(word?.key || '').trim()}`;
}

function xcConfigurationDefinition(coreSource, setup) {
  const mcuName = setup?.metadata?.coreMcuName || setup?.metadata?.sdkConfig?.MCU_NAME || metadataMcuName(setup?.metadata);
  const definitionPath = resolveCoreDefinitionFile(coreSource, mcuName, setup?.metadata?.device?.defFile);
  if (!definitionPath || !fs.existsSync(definitionPath)) return { definitionPath, definition: undefined, mcuName };
  return { definitionPath, definition: readJson(definitionPath, `${mcuName} definition`), mcuName };
}

function xcConfigurationSelections(setup, coreSource = setup?.paths?.coreSource) {
  const family = compilerFamilyForSetup(setup);
  if (!/^xc(8|16|32)$/.test(family)) return [];
  const { definitionPath, definition, mcuName } = xcConfigurationDefinition(coreSource, setup);
  if (!definition) return [];
  const result = [];
  for (const word of Array.isArray(definition.config_words) ? definition.config_words : []) {
    const key = String(word?.key || '').trim();
    if (!key) continue;
    const fieldId = xcConfigurationFieldId(word);
    const configured = setup?.registerValues && Object.prototype.hasOwnProperty.call(setup.registerValues, fieldId)
      ? String(setup.registerValues[fieldId] ?? '').trim()
      : '';
    const requested = configured || String(word?.init ?? '').trim();
    if (!requested) continue;
    const settings = (Array.isArray(word.settings) ? word.settings : [])
      .map((setting) => String(setting?.value ?? '').trim())
      .filter(Boolean);
    const canonical = settings.find((value) => value.toLowerCase() === requested.toLowerCase()) || requested;
    if (settings.length && !settings.some((value) => value.toLowerCase() === requested.toLowerCase())) {
      throw new Error(`XC configuration ${key}=${requested} is not present in ${path.basename(definitionPath)} for ${mcuName}.`);
    }
    if (!/^[A-Za-z0-9_+.-]+$/.test(canonical)) {
      throw new Error(`XC configuration ${key} contains an unsupported pragma value '${canonical}'.`);
    }
    result.push({ key, value: canonical, group: String(word?.label_group || '').trim(), fieldId, source: configured ? 'setup' : 'init' });
  }
  return result;
}

function generateXcConfigurationSource(setup, coreSource, outputDirectory) {
  const family = compilerFamilyForSetup(setup);
  if (!/^xc(8|16|32)$/.test(family)) return undefined;
  const selections = xcConfigurationSelections(setup, coreSource);
  if (!selections.length) return undefined;
  fs.mkdirSync(outputDirectory, { recursive: true });
  const sourcePath = path.join(outputDirectory, 'xc_config_words.c');
  const lines = [
    '/* Generated by MikroBUS Embedded Tools. Do not edit. */',
    '/* Microchip XC configuration words from the selected MCU JSON. */',
    ''
  ];
  let previousGroup = '';
  for (const selection of selections) {
    if (selection.group && selection.group !== previousGroup) {
      lines.push(`/* ${selection.group} */`);
      previousGroup = selection.group;
    }
    lines.push(`#pragma config ${selection.key} = ${selection.value}`);
  }
  // Microchip's XC32 examples place configuration pragmas before <xc.h>.
  // Keeping the generated source in that canonical form also ensures the
  // device-specific declarations selected by -mprocessor are available while
  // the compiler materializes the .config_<address> input sections.
  lines.push('', '#include <xc.h>', '');
  fs.writeFileSync(sourcePath, `${lines.join('\n')}\n`, 'utf8');
  return { sourcePath, selections };
}

async function buildXcConfigurationObject(setup, resolved, coreSource, outputDirectory, token) {
  const generated = generateXcConfigurationSource(setup, coreSource, outputDirectory);
  if (!generated) return undefined;
  const family = compilerFamilyForSetup(setup);
  const objectPath = path.join(outputDirectory, family === 'xc8' ? 'xc_config_words.p1' : 'xc_config_words.o');
  const adapterFlags = compilerSupport.compilerSpecificFlags(resolved.adapter, setup.metadata, [], [], []);
  const deviceCompilerFlags = splitFlags(setup?.metadata?.device?.compilerFlags);
  const args = [...adapterFlags.compile, ...deviceCompilerFlags, '-c', generated.sourcePath, '-o', objectPath].filter(Boolean);
  const definitionPath = resolveCoreDefinitionFile(coreSource, setup?.metadata?.coreMcuName || setup?.metadata?.sdkConfig?.MCU_NAME || metadataMcuName(setup?.metadata), setup?.metadata?.device?.defFile);
  output.appendLine(`XC configuration words: compiling ${generated.selections.length} symbolic pragma(s) from ${path.basename(definitionPath || 'MCU JSON')}.`);
  await runLogged(resolved.c, args, { cwd: outputDirectory, token });
  if (!fs.existsSync(objectPath)) throw new Error(`${path.basename(resolved.c)} completed but did not create XC configuration object ${path.basename(objectPath)}.`);
  if (family === 'xc32') {
    const probeSetup = { ...setup, paths: { ...(setup?.paths || {}), xcConfigObject: objectPath } };
    const sections = xc32ConfigurationObjectSections(probeSetup);
    if (!sections.length) {
      throw new Error(`XC32 compiled ${generated.selections.length} #pragma config setting(s), but ${path.basename(objectPath)} contains no .config_<address> sections.`);
    }
    output.appendLine(`XC32 encoded configuration sections: ${sections.map((section) => `${section.key}->0x${section.address.toString(16).toUpperCase()}[${section.data.length}]`).join(', ')}`);
  }
  return { ...generated, objectPath };
}

// Numeric config_registers remain supported for older XC32 core packages.
// Modern XC definitions use symbolic config_words and are encoded by xc32-gcc
// from the generated #pragma config source above.
function xc32ConfigurationWords(setup) {
  if (compilerFamilyForSetup(setup) !== 'xc32') return [];
  const coreSource = setup?.paths?.coreSource;
  const mcuName = setup?.metadata?.coreMcuName || setup?.metadata?.sdkConfig?.MCU_NAME || metadataMcuName(setup?.metadata);
  const definitionPath = resolveCoreDefinitionFile(coreSource, mcuName, setup?.metadata?.device?.defFile);
  if (!definitionPath || !fs.existsSync(definitionPath)) return [];
  const definition = readJson(definitionPath, `${mcuName} definition`);
  if (Array.isArray(definition.config_words) && definition.config_words.length) return [];
  const result = [];
  for (const register of Array.isArray(definition.config_registers) ? definition.config_registers : []) {
    const rawAddress = String(register?.address ?? '').trim();
    if (!rawAddress) continue;
    const address = Number.parseInt(rawAddress.replace(/^\$|^0x/i, ''), 16);
    if (!Number.isFinite(address)) continue;
    result.push({
      key: String(register?.key || '').trim() || `0x${address.toString(16).toUpperCase()}`,
      address: address >>> 0,
      value: defaultRegisterValue(register, setup?.registerValues || {}) >>> 0,
      source: 'core-json',
      overwrite: true
    });
  }
  return result;
}

function elfSectionTable(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 64 || buffer[0] !== 0x7F || buffer[1] !== 0x45 || buffer[2] !== 0x4C || buffer[3] !== 0x46) {
    throw new Error(`${path.basename(filePath)} is not an ELF file.`);
  }
  const elfClass = buffer[4];
  const littleEndian = buffer[5] !== 2;
  const read16 = (offset) => littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const read32 = (offset) => littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const read64 = (offset) => {
    const value = littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`ELF offset in ${path.basename(filePath)} exceeds JavaScript's safe integer range.`);
    return Number(value);
  };
  let sectionOffset;
  let sectionEntrySize;
  let sectionCount;
  let sectionStringIndex;
  let sectionFieldOffsets;
  if (elfClass === 1) {
    sectionOffset = read32(32);
    sectionEntrySize = read16(46);
    sectionCount = read16(48);
    sectionStringIndex = read16(50);
    sectionFieldOffsets = { name:0, type:4, address:12, offset:16, size:20, wide:false };
  } else if (elfClass === 2) {
    sectionOffset = read64(40);
    sectionEntrySize = read16(58);
    sectionCount = read16(60);
    sectionStringIndex = read16(62);
    sectionFieldOffsets = { name:0, type:4, address:16, offset:24, size:32, wide:true };
  } else {
    throw new Error(`${path.basename(filePath)} uses an unsupported ELF class ${elfClass}.`);
  }
  if (!sectionOffset || !sectionEntrySize || !sectionCount || sectionStringIndex >= sectionCount) {
    throw new Error(`${path.basename(filePath)} has an invalid ELF section table.`);
  }
  const rawSections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const base = sectionOffset + (index * sectionEntrySize);
    if (base < 0 || base + sectionEntrySize > buffer.length) throw new Error(`${path.basename(filePath)} has a truncated ELF section table.`);
    const nameOffset = read32(base + sectionFieldOffsets.name);
    const type = read32(base + sectionFieldOffsets.type);
    const address = sectionFieldOffsets.wide ? read64(base + sectionFieldOffsets.address) : read32(base + sectionFieldOffsets.address);
    const offset = sectionFieldOffsets.wide ? read64(base + sectionFieldOffsets.offset) : read32(base + sectionFieldOffsets.offset);
    const size = sectionFieldOffsets.wide ? read64(base + sectionFieldOffsets.size) : read32(base + sectionFieldOffsets.size);
    rawSections.push({ index, nameOffset, type, address, offset, size });
  }
  const namesSection = rawSections[sectionStringIndex];
  if (!namesSection || namesSection.offset + namesSection.size > buffer.length) {
    throw new Error(`${path.basename(filePath)} has an invalid ELF section-name string table.`);
  }
  const names = buffer.subarray(namesSection.offset, namesSection.offset + namesSection.size);
  const sectionName = (offset) => {
    if (offset < 0 || offset >= names.length) return '';
    let end = offset;
    while (end < names.length && names[end] !== 0) end += 1;
    return names.subarray(offset, end).toString('utf8');
  };
  return rawSections.map((section) => {
    const name = sectionName(section.nameOffset);
    const hasFileData = section.type !== 8 && section.size > 0; // SHT_NOBITS has no bytes in the file.
    if (hasFileData && section.offset + section.size > buffer.length) {
      throw new Error(`${path.basename(filePath)} has a truncated ELF section '${name}'.`);
    }
    return {
      ...section,
      name,
      data: hasFileData ? Buffer.from(buffer.subarray(section.offset, section.offset + section.size)) : Buffer.alloc(0)
    };
  });
}

function xc32PhysicalConfigurationAddress(address) {
  const value = Number(address) >>> 0;
  // PIC32 configuration sections use KSEG0/KSEG1 virtual addresses in ELF
  // section names (for example .config_BFC0FFC0). Intel HEX/programmers use
  // the corresponding physical address (0x1FC0FFC0).
  if ((value >= 0x80000000 && value <= 0xBFFFFFFF)) return value & 0x1FFFFFFF;
  return value;
}

function xc32ConfigurationObjectSections(setup) {
  if (compilerFamilyForSetup(setup) !== 'xc32') return [];
  const objectPath = setup?.paths?.xcConfigObject;
  if (!objectPath || !fs.existsSync(objectPath)) return [];
  const result = [];
  for (const section of elfSectionTable(objectPath)) {
    const match = /^\.config_([0-9A-Fa-f]+)$/.exec(section.name);
    if (!match || !section.data.length) continue;
    const virtualAddress = Number.parseInt(match[1], 16);
    if (!Number.isFinite(virtualAddress)) continue;
    result.push({
      key: section.name,
      virtualAddress: virtualAddress >>> 0,
      address: xc32PhysicalConfigurationAddress(virtualAddress),
      data: Buffer.from(section.data),
      source: 'xc-config-object'
    });
  }
  result.sort((left, right) => left.address - right.address);
  return result;
}

function applyXc32ConfigurationWords(setup, hexPath) {
  if (compilerFamilyForSetup(setup) !== 'xc32') return hexPath;
  if (!looksLikeIntelHex(hexPath)) throw new Error(`Cannot add XC32 configuration words because ${path.basename(hexPath)} is not Intel HEX.`);

  // For modern XC JSON definitions, #pragma config is compiled by XC32 into
  // .config_<virtual-address> ELF sections. The mikroSDK project uses an
  // explicit custom linker script, so those input sections are not guaranteed
  // to survive the normal application link. Read the compiler-encoded bytes
  // directly from the generated configuration object and merge them into the
  // final HEX after xc32-bin2hex. XC32 remains the authority for every symbolic
  // config_words value; the extension does not reproduce Microchip bit masks.
  const symbolicSections = xc32ConfigurationObjectSections(setup);
  if (symbolicSections.length) {
    const parsed = parseIntelHex(fs.readFileSync(hexPath, 'utf8'));
    for (const section of symbolicSections) {
      for (let index = 0; index < section.data.length; index += 1) {
        parsed.memory.set((section.address + index) >>> 0, section.data[index]);
      }
    }
    fs.writeFileSync(hexPath, serializeIntelHex(parsed), 'utf8');
    if (!looksLikeIntelHex(hexPath)) throw new Error(`XC32 symbolic configuration merge produced an invalid Intel HEX file: ${path.basename(hexPath)}.`);
    output.appendLine(`XC32 configuration sections merged from ${path.basename(setup.paths.xcConfigObject)}: ${symbolicSections.map((section) => `${section.key}->0x${section.address.toString(16).toUpperCase()}[${section.data.length}]`).join(', ')}`);
    return hexPath;
  }

  const { definition } = xcConfigurationDefinition(setup?.paths?.coreSource, setup);
  if (Array.isArray(definition?.config_words) && definition.config_words.length) {
    throw new Error(
      `XC32 configuration source was generated for ${metadataMcuName(setup?.metadata)}, but ${path.basename(setup?.paths?.xcConfigObject || 'xc_config_words.o')} contains no .config_<address> sections. ` +
      `Rebuild the C setup with the selected XC32 compiler before building the project.`
    );
  }

  // Older core packages can expose already-decoded numeric config_registers.
  const words = xc32ConfigurationWords(setup);
  if (!words.length) return hexPath;
  const parsed = parseIntelHex(fs.readFileSync(hexPath, 'utf8'));
  for (const word of words) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(word.value >>> 0, 0);
    for (let index = 0; index < bytes.length; index += 1) parsed.memory.set((word.address + index) >>> 0, bytes[index]);
  }
  fs.writeFileSync(hexPath, serializeIntelHex(parsed), 'utf8');
  if (!looksLikeIntelHex(hexPath)) throw new Error(`XC32 configuration-word injection produced an invalid Intel HEX file: ${path.basename(hexPath)}.`);
  output.appendLine(`XC32 numeric configuration registers: ${words.map((word) => `${word.key}@0x${word.address.toString(16).toUpperCase()}=0x${word.value.toString(16).toUpperCase().padStart(8, '0')}`).join(', ')}`);
  return hexPath;
}

async function ensureXc32CodegripDebugHex(setup, normalHex) {
  if (compilerFamilyForSetup(setup) !== 'xc32') return normalHex;
  if (!normalHex || !looksLikeIntelHex(normalHex)) {
    throw new Error('XC32 CODEGRIP debugging requires a valid Intel HEX image before the debug configuration can be enabled.');
  }
  const { definition, mcuName } = xcConfigurationDefinition(setup?.paths?.coreSource, setup);
  const debugWord = (Array.isArray(definition?.config_words) ? definition.config_words : [])
    .find((word) => String(word?.key || '').trim().toUpperCase() === 'DEBUG');
  if (!debugWord) {
    output.appendLine(`XC32 CODEGRIP debug: ${mcuName || metadataMcuName(setup?.metadata)} has no DEBUG config_words entry; using CODEGRIP debugEnable without a HEX fuse override.`);
    return normalHex;
  }
  const enabledValue = (Array.isArray(debugWord.settings) ? debugWord.settings : [])
    .map((setting) => String(setting?.value ?? '').trim())
    .find((value) => value.toUpperCase() === 'ON');
  if (!enabledValue) {
    output.appendLine(`XC32 CODEGRIP debug: DEBUG has no ON setting in the MCU JSON; using CODEGRIP debugEnable without a HEX fuse override.`);
    return normalHex;
  }
  const compiler = setup?.tools?.compiler;
  const adapter = compilerSupport.adapterFor(setup?.metadata?.compiler?.uid);
  if (!compiler || !fs.existsSync(compiler) || !adapter) {
    throw new Error('XC32 CODEGRIP debugging could not resolve the XC32 compiler needed to encode DEBUG=ON configuration words.');
  }
  const fieldId = xcConfigurationFieldId(debugWord);
  const debugSetup = {
    ...setup,
    registerValues: { ...(setup?.registerValues || {}), [fieldId]: enabledValue },
    paths: { ...(setup?.paths || {}) }
  };
  const parent = path.dirname(normalHex);
  const work = path.join(parent, '.mikrobus-xc32-codegrip-debug');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  try {
    const config = await buildXcConfigurationObject(
      debugSetup,
      { c: compiler, adapter },
      setup?.paths?.coreSource,
      work
    );
    if (!config?.objectPath) throw new Error('XC32 did not create a debug configuration object.');
    debugSetup.paths.xcConfigObject = config.objectPath;
    const parsed = path.parse(normalHex);
    const debugHex = path.join(parsed.dir, `${parsed.name}.codegrip-debug${parsed.ext || '.hex'}`);
    fs.copyFileSync(normalHex, debugHex);
    applyXc32ConfigurationWords(debugSetup, debugHex);
    output.appendLine(`XC32 CODEGRIP debug HEX: DEBUG=${enabledValue} encoded by XC32 -> ${debugHex}`);
    return debugHex;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function nativeXc8HexForElf(elf, maximumTimestampDeltaMs = 60000) {
  if (!elf || !fs.existsSync(elf)) return undefined;
  const parsed = path.parse(elf);
  const canonical = hexPathForExecutable(elf);
  const candidates = [canonical, `${elf}.hex`];
  try {
    for (const name of fs.readdirSync(parsed.dir || '.')) {
      if (!/\.hex$/i.test(name)) continue;
      const candidate = path.join(parsed.dir, name);
      const stem = path.basename(name, path.extname(name));
      if (stem === parsed.name || stem === parsed.base || stem.startsWith(`${parsed.name}.`)) candidates.push(candidate);
    }
  } catch {}
  let elfMtime = 0;
  try { elfMtime = fs.statSync(elf).mtimeMs; } catch {}
  const unique = [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
  const valid = unique.filter((candidate) => {
    if (!looksLikeIntelHex(candidate)) return false;
    if (!elfMtime) return true;
    try {
      // XC8 PIC creates ELF and HEX as peer outputs of the same link. The HEX
      // can be timestamped slightly before the ELF, so do not apply the generic
      // "HEX must be newer than ELF" post-processing rule here.
      return Math.abs(fs.statSync(candidate).mtimeMs - elfMtime) <= maximumTimestampDeltaMs;
    } catch {
      return false;
    }
  });
  valid.sort((left, right) => {
    if (left === path.resolve(canonical)) return -1;
    if (right === path.resolve(canonical)) return 1;
    try { return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs; } catch { return 0; }
  });
  return valid[0];
}

function microchipHexConversion(tool, family, elf, outputHex) {
  const executable = String(tool || '');
  const base = path.basename(executable).toLowerCase();
  if ((family === 'xc16' || family === 'xc32') && base.includes('bin2hex')) {
    // xc16/xc32-bin2hex do not accept an explicit output path. They derive the
    // HEX name by replacing the input ELF extension. The caller therefore has
    // to ensure the input actually has an .elf suffix.
    return { executable: tool, args: [elf], expected: hexPathForExecutable(elf), derivesOutputName: true };
  }
  return { executable: tool, args: ['-O', 'ihex', elf, outputHex], expected: outputHex, derivesOutputName: false };
}

function microchipBin2hexNeedsElfAlias(family, tool, elf) {
  const base = path.basename(String(tool || '')).toLowerCase();
  return (family === 'xc16' || family === 'xc32') && base.includes('bin2hex') && path.extname(String(elf || '')).toLowerCase() !== '.elf';
}

function isXc8AvrTarget(setup) {
  const mcu = String(metadataMcuName(setup?.metadata) || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return /^(ATMEGA|ATTINY|AVR|ATA)/.test(mcu);
}

async function ensureHex(setup, elf) {
  const family = compilerFamilyForSetup(setup);
  const finalize = (candidate) => family === 'xc32' ? applyXc32ConfigurationWords(setup, candidate) : candidate;
  // Some toolchains (notably mikroC AI) link the application directly as an
  // Intel HEX executable. In that case the CMake target artifact is already
  // the programmer-ready file; do not try to run objcopy/bin2hex on it.
  if (looksLikeIntelHex(elf)) return finalize(path.resolve(elf));

  const existing = hexPathForExecutable(elf);

  if (family === 'xc8' && !isXc8AvrTarget(setup)) {
    const nativeHex = nativeXc8HexForElf(elf);
    if (nativeHex) return nativeHex;
    throw new Error(`XC8 PIC completed the ELF link but no native Intel HEX output was found beside ${path.basename(elf)}. XC8 PIC is expected to emit ELF and HEX together; see the preceding xc8-cc link output.`);
  }

  if (fs.existsSync(existing)) {
    try {
      if (fs.statSync(existing).mtimeMs >= fs.statSync(elf).mtimeMs && looksLikeIntelHex(existing)) return finalize(existing);
    } catch {}
  }

  const preferredNames = family === 'xc16'
    ? ['xc16-bin2hex']
    : family === 'xc32'
      ? ['xc32-bin2hex', 'xc32-objcopy']
      : family === 'xc8' && isXc8AvrTarget(setup)
        ? ['avr-objcopy']
        : ['arm-none-eabi-objcopy'];
  const converter = setup.tools?.objcopy && fs.existsSync(setup.tools.objcopy)
    ? setup.tools.objcopy
    : packages.findOnPath(preferredNames);
  if (!converter) throw new Error(`No HEX conversion tool is available for ${setup.metadata?.compiler?.name || setup.metadata?.compiler?.uid || 'the selected compiler'} to create an Intel HEX file.`);

  let converterInput = elf;
  let temporaryElf;
  let generatedHex;
  if (microchipBin2hexNeedsElfAlias(family, converter, elf)) {
    const parsed = path.parse(elf);
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    temporaryElf = path.join(parsed.dir, `.${parsed.name}.mikrobus-bin2hex-${nonce}.elf`);
    fs.copyFileSync(elf, temporaryElf);
    converterInput = temporaryElf;
  }

  const command = microchipHexConversion(converter, family, converterInput, existing);
  generatedHex = command.expected;
  try {
    await runLogged(command.executable, command.args, { cwd: path.dirname(elf) });
    if (!looksLikeIntelHex(generatedHex)) {
      throw new Error(`${path.basename(command.executable)} completed but did not create a valid Intel HEX file ${path.basename(generatedHex)}.`);
    }
    if (path.resolve(generatedHex) !== path.resolve(existing)) {
      fs.copyFileSync(generatedHex, existing);
    }
    if (!looksLikeIntelHex(existing)) {
      throw new Error(`${path.basename(command.executable)} completed but the canonical Intel HEX output ${path.basename(existing)} is missing or invalid.`);
    }
    return finalize(existing);
  } finally {
    if (temporaryElf) {
      fs.rmSync(temporaryElf, { force: true });
      if (generatedHex && path.resolve(generatedHex) !== path.resolve(existing)) fs.rmSync(generatedHex, { force: true });
    }
  }
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
  const roots = [
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
    } else if (setup.metadata.programmer.uid === rfp.RFP_PROGRAMMER_UID) {
      if (!setup.rfpProfile) {
        setup.rfpProfile = await rfp.configureProfile(setup);
        if (!setup.rfpProfile) return;
        writeJsonAtomic(setupFile(context, setup.id), setup);
      }
      await withProgrammerStatus(setup, 'Programming', async (progress) => rfp.program(
        setup,
        hex || await ensureHex(setup, elf),
        setup.rfpProfile,
        { channel: output, cwd: cProjectRoot(), onStatus: (message) => progress.report({ message }) }
      ));
    } else if (setup.metadata.programmer.uid === tiXds110.TI_XDS110_PROGRAMMER_UID) {
      await withProgrammerStatus(setup, 'Programming', async (progress) => tiXds110.program(
        setup,
        elf,
        { channel: output, cwd: cProjectRoot(), onStatus: (message) => progress.report({ message }) }
      ));
    } else if (microchip.isMicrochipProgrammer(setup.metadata.programmer)) {
      const image = hex || await ensureHex(setup, elf);
      const profile = microchip.connectionProfile(setup);
      output.appendLine(`Starting MPLAB programmer: ${profile.tool} / ${profile.interface} / ${setupMcuName(setup)}.`);
      await withProgrammerStatus(setup, 'Programming', () => microchip.program(setup, image));
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
      await withProgrammerStatus(setup, 'Erasing', () => eraseJlink(setup));
    } else if (setup.metadata.programmer.uid === 'codegrip') {
      if (!setup.programmerProfile) {
        setup.programmerProfile = await selectCodegrip(context, setup);
        if (!setup.programmerProfile) return;
        writeJsonAtomic(setupFile(context, setup.id), setup);
      }
      const runtime = programmerRuntime(context, setup);
      const eraseCommand = String(vscode.workspace.getConfiguration('mikrobusRust').get('codegripEraseCommand', 'erase') || 'erase');
      await withProgrammerStatus(setup, 'Erasing', () => eraseCodegrip({
        ...runtime,
        profile: setup.programmerProfile,
        mcu: setupMcuName(setup),
        eraseCommand,
        channel: output
      }));
    } else if (setup.metadata.programmer.uid === rfp.RFP_PROGRAMMER_UID) {
      if (!setup.rfpProfile) {
        setup.rfpProfile = await rfp.configureProfile(setup);
        if (!setup.rfpProfile) return;
        writeJsonAtomic(setupFile(context, setup.id), setup);
      }
      await withProgrammerStatus(setup, 'Erasing', async (progress) => rfp.erase(
        setup,
        setup.rfpProfile,
        { channel: output, cwd: cProjectRoot(), onStatus: (message) => progress.report({ message }) }
      ));
    } else if (setup.metadata.programmer.uid === tiXds110.TI_XDS110_PROGRAMMER_UID) {
      await withProgrammerStatus(setup, 'Erasing', async (progress) => tiXds110.erase(
        setup,
        { channel: output, cwd: cProjectRoot(), onStatus: (message) => progress.report({ message }) }
      ));
    } else if (microchip.isMicrochipProgrammer(setup.metadata.programmer)) {
      const profile = microchip.connectionProfile(setup);
      output.appendLine(`Starting MPLAB erase: ${profile.tool} / ${profile.interface} / ${setupMcuName(setup)}.`);
      await withProgrammerStatus(setup, 'Erasing', () => microchip.erase(setup));
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


function findAvailableLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('Could not allocate a local Renesas GDB server port.'));
        else resolve(port);
      });
    });
  });
}

function quoteDebugServerArg(value) {
  const text = String(value ?? '');
  if (!/[\\s|"']/u.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function rl78G24ServerArgs(target, port) {
  return [
    '-p', String(port),
    '-g', target.debuggerType,
    '-t', target.device,
    '-uConnectionTimeout=', '30',
    '-umFreq=', '0',
    '-usFreq=', '0',
    '-umClock=', '1',
    '-w', '0',
    '-usupplyVoltage=', '0',
    '-ucommMethod=', '0',
    '-uSelfCodeSet=', '0',
    '-usecurityID=', '00000000000000000000',
    '-usecurityIdSize', '10',
    '-upermitFlash=', '1',
    '-uuseWideVoltageMode=', '1',
    '-ueraseRom=', '1',
    '-ubankSwapEnable=', '0',
    '-uresetOnReload=', '1',
    '-ustopTimerEmu=', '0',
    '-ustopSerialEmu=', '0',
    '-umaskInternalResetSignal=', '0',
    '-umaskTargetResetSignal=', '0',
    '-n', '0',
    '-uverifyOnWritingMemory=', '1',
    '-uAllowRRMDMM=', '0',
    '-uOSRestriction=', '0',
    '-uRelayBreak=', '1',
    '-l',
    '-uCore=', 'CPU|enabled|256|main',
    '-uSyncMode=', 'async',
    '-uTraceCore=', 'CPU',
    '-uFirstGDB=', 'main',
    '--english',
    '--gdbVersion=', '16.2'
  ];
}

function isRl78G24Setup(setup = {}) {
  const family = String(setup?.metadata?.device?.familyUid || setup?.metadata?.device?.family_uid || '').toUpperCase();
  const mcu = String(setup?.metadata?.device?.mcuName || setup?.metadata?.device?.uid || '').toUpperCase();
  return family.includes('G24') || /^R7F101/.test(mcu);
}

function findFileRecursive(root, names, maxDepth = 5, depth = 0) {
  if (!root || depth > maxDepth || !fs.existsSync(root)) return undefined;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return undefined; }
  const wanted = new Set(names.map((name) => process.platform === 'win32' ? name.toLowerCase() : name));
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const key = process.platform === 'win32' ? entry.name.toLowerCase() : entry.name;
    if (wanted.has(key)) return path.join(root, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findFileRecursive(path.join(root, entry.name), names, maxDepth, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function renesasDebugCompRoots() {
  const roots = [];
  const home = os.homedir();
  // Prefer e2 studio support files when present. The user's G24/E2 session is
  // known-good there, while current Renesas VS Code support files misclassify
  // G24 as SINGLE_CORE.
  const eclipseRoot = path.join(home, '.eclipse');
  if (fs.existsSync(eclipseRoot)) {
    try {
      const entries = fs.readdirSync(eclipseRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('com.renesas.platform_'))
        .map((entry) => path.join(eclipseRoot, entry.name, 'DebugComp'))
        .filter((candidate) => fs.existsSync(candidate));
      entries.sort((a, b) => {
        try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
      });
      roots.push(...entries);
    } catch {}
  }
  roots.push(
    path.join(home, '.renesas', 'platform', 'DebugComp'),
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'renesaselectronicscorporation.renesas-debug', 'DebugComp')
      : path.join(home, '.config', 'Code', 'User', 'globalStorage', 'renesaselectronicscorporation.renesas-debug', 'DebugComp')
  );
  return [...new Set(roots)].filter((candidate) => fs.existsSync(candidate));
}

function resolveRl78DirectDebugTools() {
  const serverNames = process.platform === 'win32' ? ['e2-server-gdb.exe'] : ['e2-server-gdb'];
  const gdbNames = process.platform === 'win32' ? ['rl78-elf-gdb.exe'] : ['rl78-elf-gdb'];
  const roots = renesasDebugCompRoots();
  for (const root of roots) {
    const server = findFileRecursive(path.join(root, 'RL78'), serverNames, 3) || findFileRecursive(root, serverNames, 4);
    const gdb = findFileRecursive(root, gdbNames, 4);
    if (server && gdb) return { server, gdb, root };
  }
  const anyServer = roots.map((root) => findFileRecursive(path.join(root, 'RL78'), serverNames, 3) || findFileRecursive(root, serverNames, 4)).find(Boolean);
  const anyGdb = roots.map((root) => findFileRecursive(root, gdbNames, 4)).find(Boolean);
  if (anyServer && anyGdb) return { server: anyServer, gdb: anyGdb, root: path.dirname(anyServer) };
  throw new Error(
    'RL78 direct debugging could not locate e2-server-gdb and rl78-elf-gdb. Install Renesas RL78 Support Files through Renesas Quick Install (or e2 studio RL78 debug support).'
  );
}

function renesasRl78DirectCppDebugConfiguration(setup, projectRoot, elf, profile, generation, tools, port) {
  const target = rfp.renesasRl78DebugTarget(setup, profile);
  if (!target) throw new Error('RL78 direct E2/E2 Lite debugging requires an RFP E2/E2 Lite profile using uart1.');
  const args = rl78G24ServerArgs(target, port);
  return {
    type: 'cppdbg',
    request: 'launch',
    name: `MikroBUS C ${target.debuggerType === 'E2LITE' ? 'E2 Lite' : 'E2'} RL78/G24: ${setup.name}`,
    presentation: { hidden: true },
    program: elf,
    cwd: projectRoot,
    MIMode: 'gdb',
    miDebuggerPath: tools.gdb,
    miDebuggerServerAddress: `127.0.0.1:${port}`,
    debugServerPath: tools.server,
    debugServerArgs: args.map(quoteDebugServerArg).join(' '),
    serverStarted: 'GDB:',
    filterStdout: true,
    filterStderr: true,
    externalConsole: false,
    stopAtEntry: false,
    launchCompleteCommand: 'exec-continue',
    __mikrobusRenesas: true,
    __mikrobusRenesasRl78: true,
    __mikrobusRenesasRl78Direct: true,
    __mikrobusCDebugInstance: generation,
    __mikrobusCDebug: true
  };
}

function renesasRfpDebugConfiguration(setup, projectRoot, elf, profile, generation) {
  const target = rfp.renesasDebugTarget(setup, profile);
  if (!target) {
    throw new Error('Renesas hardware debug requires an RFP setup configured for E2 Lite or E2. RL78 uses the uart1 RFP interface; RX uses FINE. UART boot mode and RFP J-Link profiles cannot use this debug path.');
  }
  return {
    type: 'renesas-hardware',
    request: 'launch',
    name: `MikroBUS C ${target.debuggerType === 'E2LITE' ? 'E2 Lite' : 'E2'}: ${setup.name}`,
    presentation: { hidden: true },
    program: elf,
    cwd: projectRoot,
    target,
    __mikrobusRenesas: true,
    __mikrobusRenesasRx: target.deviceFamily === 'RX',
    __mikrobusRenesasRl78: target.deviceFamily === 'RL78',
    __mikrobusCDebugInstance: generation,
    __mikrobusCDebug: true
  };
}

async function ensureRenesasDebugExtension(deviceFamily = 'Renesas') {
  const extension = vscode.extensions?.getExtension(rfp.RENESAS_DEBUG_EXTENSION_ID);
  if (!extension) {
    const family = String(deviceFamily || 'Renesas').toUpperCase();
    const supportFiles = family === 'RL78' ? 'Renesas RL78 Support Files' : family === 'RX' ? 'Renesas RX Support Files' : 'Renesas device-family Support Files';
    throw new Error(
      `${family} E2/E2 Lite debugging requires the Renesas Debug extension (${rfp.RENESAS_DEBUG_EXTENSION_ID}). ` +
      `Install/enable it and install the ${supportFiles} through Renesas Platform → Quick Install.`
    );
  }
  await extension.activate();
  return extension;
}


function xc32GdbArchitecture(gdbPath) {
  if (!gdbPath || !fs.existsSync(gdbPath)) return undefined;
  for (const architecture of ['mips:isa32r2', 'mips:isa32', 'mips']) {
    let result;
    try {
      result = childProcess.spawnSync(
        gdbPath,
        ['--batch', '-nx', '-ex', `set architecture ${architecture}`, '-ex', 'show architecture'],
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
      );
    } catch {
      continue;
    }
    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.error) continue;
    if (/undefined item|not recognized|unknown architecture|requires an argument|not supported/i.test(text)) continue;
    if (result.status === 0) return architecture;
  }
  return undefined;
}

function codegripCppDebugConfiguration(setup, projectRoot, elf, debugPort, generation, options = {}) {
  const gdbPath = setup.tools?.gdb;
  const compilerFamily = compilerFamilyForSetup(setup);
  const gdbName = path.basename(String(gdbPath || '')).toLowerCase();
  const armTarget = compilerFamily.endsWith('-arm') || /arm(?:-none)?-eabi-gdb/.test(gdbName);
  const setupCommands = [{
    description: 'Allow access to all MCU memory regions',
    text: '-gdb-set mem inaccessible-by-default off',
    ignoreFailures: true
  }];
  if (armTarget) {
    setupCommands.push({
      description: 'Prefer hardware breakpoints for read-only target code',
      text: '-gdb-set breakpoint auto-hw on',
      ignoreFailures: true
    });
  }
  return {
    type: 'cppdbg',
    request: 'launch',
    name: `MikroBUS C CODEGRIP: ${setup.name}`,
    presentation: { hidden: true },
    program: elf,
    cwd: projectRoot,
    MIMode: 'gdb',
    miDebuggerPath: gdbPath,
    ...(options.gdbArchitecture ? {
      // pic32-gdb variants do not all accept architecture selection through
      // MI `-gdb-set`. Probe the compiler's GDB first and, when supported,
      // execute the console command before cppdbg establishes the remote link.
      miDebuggerArgs: `-ex "set architecture ${options.gdbArchitecture}" -ex "set endian little"`
    } : {}),
    miDebuggerServerAddress: `127.0.0.1:${debugPort}`,
    ...(armTarget ? {
      targetArchitecture: 'arm',
      useExtendedRemote: false,
      hardwareBreakpoints: { require: true }
    } : {}),
    stopAtEntry: false,
    externalConsole: false,
    // Let the compiler-provided GDB infer the target architecture from the ELF
    // and CODEGRIP's remote target description. Forcing `set architecture`
    // through cppdbg's MI layer breaks Microchip PIC GDB variants (for example
    // pic32-gdb rejects the transformed `-gdb-set architecture` request).
    launchCompleteCommand: 'exec-continue',
    setupCommands,
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
    const selectedSetup = getBoundSetup(context, cProjectRoot());
    const availability = cDebugAvailability(selectedSetup);
    if (!availability.available) {
      vscode.window.showInformationMessage(availability.hint);
      return;
    }
    if (selectedSetup.metadata?.programmer?.uid === rfp.RFP_PROGRAMMER_UID) {
      if (!selectedSetup.rfpProfile) {
        selectedSetup.rfpProfile = await rfp.configureProfile(selectedSetup);
        if (!selectedSetup.rfpProfile) return;
        writeJsonAtomic(setupFile(context, selectedSetup.id), selectedSetup);
      }
      if (!rfp.renesasDebugTarget(selectedSetup, selectedSetup.rfpProfile)) {
        const connection = selectedSetup.rfpProfile.connection === 'uart'
          ? 'UART boot mode'
          : `${selectedSetup.rfpProfile.tool || 'selected RFP tool'} / ${selectedSetup.rfpProfile.interface || 'default interface'}`;
        const family = rfp.isRl78Device(selectedSetup.metadata || selectedSetup) ? 'RL78' : 'RX';
        const requiredInterface = family === 'RL78' ? 'uart1 (1-wire UART)' : 'fine';
        throw new Error(
          `Debug is not available for the current RFP connection (${connection}). ` +
          `For ${family} hardware debugging, configure this setup for E2 emulator Lite (or E2) using ${requiredInterface}.`
        );
      }
    }
    const selectedCompilerFamily = compilerFamilyForSetup(selectedSetup);
    const microchipXc32Debug = microchip.isMicrochipProgrammer(selectedSetup.metadata?.programmer) && selectedCompilerFamily === 'xc32';
    if (microchipXc32Debug) {
      output.appendLine('XC32 hardware debug build: enabling -mdebugger so the linker can reserve PIC32 debug-executive resources.');
    }
    const built = await buildWorkspace(context, { hardwareDebug: microchipXc32Debug });
    if (!built) return;
    const { setup, elf, hex } = built;
    if (String(compilerSupport.adapterFor(setup.metadata?.compiler?.uid)?.family || '') === 'clang-arm') {
      await ensureClangArmMiDebugger(context, setup);
    }
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
    } else if (setup.metadata.programmer.uid === tiXds110.TI_XDS110_PROGRAMMER_UID) {
      debugInstanceId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      configuration = tiXds110.debugConfiguration(setup, projectRoot, elf, debugInstanceId);
      output.appendLine(`Starting TI XDS110/OpenOCD debug for ${setupMcuName(setup)}.`);
      const udevHint = tiXds110.linuxUdevHint();
      if (udevHint) output.appendLine(udevHint);
    } else if (setup.metadata.programmer.uid === rfp.RFP_PROGRAMMER_UID) {
      if (!setup.rfpProfile) {
        setup.rfpProfile = await rfp.configureProfile(setup);
        if (!setup.rfpProfile) return;
        writeJsonAtomic(setupFile(context, setup.id), setup);
      }
      const debugTarget = rfp.renesasDebugTarget(setup, setup.rfpProfile);
      debugInstanceId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const rfpInterface = setup.rfpProfile.connection === 'tool' ? rfp.effectiveToolInterface(setup.rfpProfile) : (setup.rfpProfile.interface || 'default');
      // Use Renesas' own DAP adapter for RL78 as well as RX. The previous
      // G24 workaround launched e2-server-gdb directly and attached through
      // Microsoft's cppdbg. cppdbg cannot reliably identify the RL78 target
      // architecture and, after a pause, may issue MI frame/step operations
      // against an invalid frame (for example PC=0xFFFF), producing
      // "Cannot find bounds of current function" and stale-session behaviour.
      // Current Renesas Debug versions support RL78 with E2/E2 Lite directly
      // and own the server/GDB lifecycle. For G24, c_rfp_backend supplies
      // disabledCores=['FAA']; -uCore is intentionally left to Renesas Debug.
      await ensureRenesasDebugExtension(debugTarget?.deviceFamily);
      configuration = renesasRfpDebugConfiguration(setup, projectRoot, elf, setup.rfpProfile, debugInstanceId);
      const debugFamily = configuration.target.deviceFamily;
      output.appendLine(
        `Starting Renesas ${debugFamily} hardware debug: ${configuration.target.debuggerType} / ` +
        `${configuration.target.device} / RFP ${rfpInterface}.`
      );
      if (debugFamily === 'RL78' && isRl78G24Setup(setup)) {
        output.appendLine('RL78/G24: using native Renesas Debug adapter; FAA is disabled and Renesas Debug owns CPU core/GDB-server setup.');
      }
      output.appendLine('Renesas Debug will load the built ELF and own the E2/E2 Lite GDB server for this session.');
      output.appendLine(`Host requirement: Renesas ${debugFamily} Support Files and the E2/E2 Lite USB driver must be installed (Renesas Platform -> Quick Install -> Renesas ${debugFamily}).`);
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
      const family = compilerFamilyForSetup(setup);
      if (/^xc(?:8|16|32)$/.test(family) && !setup.tools?.gdb) {
        throw new Error(`${family.toUpperCase()} + CODEGRIP debugging requires the compiler package GDB client (pic8-gdb/pic16-gdb/pic32-gdb), but no GDB executable was resolved for this setup.`);
      }
      const programmerHex = hex || await ensureHex(setup, elf);
      const debugHex = await ensureXc32CodegripDebugHex(setup, programmerHex);
      output.appendLine(`CODEGRIP debug client: ${setup.tools?.gdb || '(no GDB resolved)'}${/^xc(?:8|16|32)$/.test(family) ? ` / ${family.toUpperCase()}` : ''}.`);
      debugRuntime = await withProgrammerStatus(setup, 'Programming for debug', async (progress) => prepareCodegripDebug({
        ...runtime,
        profile: setup.programmerProfile,
        mcu: setupMcuName(setup),
        hexFile: debugHex,
        channel: output,
        onProgress: codegripProgressToStatus(progress)
      }));
      debugInstanceId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const generation = debugInstanceId;
      activeExternalDebugRuntime = { runtime: debugRuntime, setupId: setup.id, generation };
      let gdbArchitecture;
      if (family === 'xc32') {
        gdbArchitecture = xc32GdbArchitecture(setup.tools?.gdb);
        output.appendLine(gdbArchitecture
          ? `PIC32 GDB architecture preselection: ${gdbArchitecture} (console command before remote connect).`
          : 'PIC32 GDB architecture preselection: compiler GDB will infer the architecture from the ELF/remote target description.');
      }
      output.appendLine(`Starting cppdbg against CODEGRIP GDB at 127.0.0.1:${debugRuntime.debugPort}.`);
      configuration = codegripCppDebugConfiguration(
        setup,
        projectRoot,
        elf,
        debugRuntime.debugPort,
        generation,
        { gdbArchitecture }
      );
    } else if (microchip.isMicrochipProgrammer(setup.metadata.programmer)) {
      // Program the final HEX first so oscillator/PLL/ICESEL and the other XC
      // configuration words match the setup exactly. Do NOT follow that with
      // an MPLAB "attach" request: program-only (`noDebug: true`) intentionally
      // leaves the target in production mode, while attach expects the device
      // to already be in debug mode. A real MPLAB debug launch programs the
      // debug executive and lets the hardware debugger own the DEBUG config
      // bit, which is how MPLAB itself enters debug mode.
      const programmerHex = hex || await ensureHex(setup, elf);
      const profile = microchip.connectionProfile(setup);
      output.appendLine(
        `MPLAB debug pre-program: expected ${profile.tool} / ${profile.interface} / ${setupMcuName(setup)}. ` +
        `${profile.serial ? `Pinned serial ${profile.serial}.` : 'MPLAB will enumerate the connected tool.'}`
      );
      await withProgrammerStatus(setup, 'Programming configuration for debug', () => microchip.program(setup, programmerHex));
      let debugElf = elf;
      if (path.extname(debugElf).toLowerCase() !== '.elf') {
        const parsedDebugElf = path.parse(debugElf);
        debugElf = path.join(parsedDebugElf.dir, `${parsedDebugElf.name}.mplab-debug.elf`);
        fs.copyFileSync(elf, debugElf);
      }
      debugInstanceId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      output.appendLine(
        `Starting MPLAB Debug Adapter launch with symbols from ${debugElf}. ` +
        'The Microchip hardware debugger will manage the DEBUG configuration bit and enter target debug mode.'
      );
      await microchip.ensureDebugExtension(setup);
      configuration = microchip.debugConfiguration(setup, debugElf, debugInstanceId);
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

function cDebugAvailability(setup) {
  if (!setup) return { available: false, reason: 'no-setup', hint: 'No C setup is selected.' };
  const programmerUid = String(setup.metadata?.programmer?.uid || '');
  const compilerFamily = String(compilerSupport.adapterFor(setup.metadata?.compiler?.uid)?.family || '');
  if (programmerUid === 'codegrip' && /^xc(?:8|16|32)$/.test(compilerFamily)) {
    return {
      available: false,
      reason: 'xc-codegrip',
      hint: 'Debug is supported only with Microchip programmers for XC8, XC16 and XC32 setups.'
    };
  }
  if (programmerUid === 'codegrip' && isMikroCFamily(compilerFamily)) {
    return {
      available: false,
      reason: 'mikroc-codegrip',
      hint: 'Debug is not available in VS Code for mikroC setups with CODEGRIP. Use NECTO Studio for that purpose.'
    };
  }
  if (programmerUid === rfp.RFP_PROGRAMMER_UID) {
    const profile = setup.rfpProfile || rfp.defaultProfile(setup);
    if (!rfp.renesasDebugTarget(setup, profile)) {
      return {
        available: false,
        reason: 'renesas-e2-required',
        hint: 'Debug is supported only with Renesas E2 and E2 Lite. Select E2 or E2 Lite as the programmer connection.'
      };
    }
  }
  return { available: true, reason: '', hint: '' };
}

function isSetupDebugAvailable(setup) {
  return cDebugAvailability(setup).available;
}

async function updateWorkspaceContext() {
  let root;
  try { root = cProjectRoot(); } catch {}
  const hasCmake = Boolean(root && fs.existsSync(path.join(root, 'CMakeLists.txt')));
  const bound = Boolean(root && fs.existsSync(path.join(root, '.vscode', 'mikrobus-c.json')));
  let debugAvailable = false;
  let debugUnavailableMikrocCodegrip = false;
  let debugUnavailableXcCodegrip = false;
  let debugUnavailableRenesasE2Required = false;
  let rfpSelected = false;
  if (bound && hasCmake && globalCContext) {
    try {
      const setup = getBoundSetup(globalCContext, root);
      rfpSelected = setup.metadata?.programmer?.uid === rfp.RFP_PROGRAMMER_UID;
      const availability = cDebugAvailability(setup);
      debugAvailable = availability.available;
      debugUnavailableMikrocCodegrip = availability.reason === 'mikroc-codegrip';
      debugUnavailableXcCodegrip = availability.reason === 'xc-codegrip';
      debugUnavailableRenesasE2Required = availability.reason === 'renesas-e2-required';
    } catch {
      debugAvailable = false;
      debugUnavailableMikrocCodegrip = false;
      debugUnavailableXcCodegrip = false;
      debugUnavailableRenesasE2Required = false;
      rfpSelected = false;
    }
  }
  await vscode.commands.executeCommand('setContext', 'mikrobusRust.cWorkspaceBound', bound);
  await vscode.commands.executeCommand('setContext', 'mikrobusRust.cProjectReady', bound && hasCmake);
  await vscode.commands.executeCommand('setContext', 'mikrobusRust.cDebugAvailable', debugAvailable);
  await vscode.commands.executeCommand('setContext', 'mikrobusRust.cDebugUnavailableMikrocCodegrip', debugUnavailableMikrocCodegrip);
  await vscode.commands.executeCommand('setContext', 'mikrobusRust.cDebugUnavailableXcCodegrip', debugUnavailableXcCodegrip);
  await vscode.commands.executeCommand('setContext', 'mikrobusRust.cDebugUnavailableRenesasE2Required', debugUnavailableRenesasE2Required);
  await vscode.commands.executeCommand('setContext', 'mikrobusRust.cRfpSelected', rfpSelected);
  if (bound) await hideCppToolsActiveFileShortcut(root);
}

function scheduleCmakeVisibilityRefresh(context, document) {
  let root;
  try { root = cProjectRoot(); } catch { return; }
  if (!root || !fs.existsSync(path.join(root, '.vscode', 'mikrobus-c.json'))) return;
  if (document?.uri?.scheme === 'file' && !pathIsInside(document.uri.fsPath, root)) return;
  if (document) {
    const base = path.basename(document.uri.fsPath);
    if (base !== 'CMakeLists.txt' && path.extname(base).toLowerCase() !== '.cmake') return;
  }
  if (cmakeVisibilityRefreshTimer) clearTimeout(cmakeVisibilityRefreshTimer);
  cmakeVisibilityRefreshTimer = setTimeout(() => {
    cmakeVisibilityRefreshTimer = undefined;
    if (cmakeVisibilityRefreshRunning) return;
    cmakeVisibilityRefreshRunning = true;
    void refreshWorkspaceCmakeVisibility(context, root).catch((error) => {
      output.appendLine(`Automatic CMake Explorer visibility refresh failed: ${error.message || error}`);
    }).finally(() => { cmakeVisibilityRefreshRunning = false; });
  }, 600);
}

async function configureRfpConnection(context) {
  try {
    const root = cProjectRoot();
    const setup = getBoundSetup(context, root);
    if (setup.metadata?.programmer?.uid !== rfp.RFP_PROGRAMMER_UID) {
      throw new Error('The active C setup is not using Renesas Flash Programmer (rfp-cli).');
    }
    const profile = await rfp.configureProfile(setup, setup.rfpProfile);
    if (!profile) return;
    setup.rfpProfile = profile;
    writeJsonAtomic(setupFile(context, setup.id), setup);
    await updateWorkspaceContext();
    vscode.window.showInformationMessage(`Updated RFP connection for ${setupMcuName(setup)}.`);
  } catch (error) {
    vscode.window.showErrorMessage(`MikroBUS C RFP: ${error.message || error}`);
  }
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
  globalCContext = context;
  cmakeVisibility.register(context);
  try { packages.cleanupObsoleteMikroCDebugArtifacts(context); } catch (error) { output.appendLine(`Legacy mikroC debug cleanup: ${error.message || error}`); }
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
  guardedCommand(context, 'mikrobusC.configureRfpConnection', () => configureRfpConnection(context));
  guardedCommand(context, 'mikrobusC.openInstalledPackages', () => packages.openInstalledPackages(context));
  guardedCommand(context, 'mikrobusC.openCompilerPackages', () => packages.openCompilerPackages(context));
  guardedCommand(context, 'mikrobusC.installEnvironment', () => installCEnvironment(context));
  guardedCommand(context, 'mikrobusC.rebuildSetupById', (setupId) => rebuildSetupById(context, setupId));
  guardedCommand(context, 'mikrobusC.reconfigureSetupById', (setupId) => reconfigureSetupById(context, setupId));
  guardedCommand(context, 'mikrobusC.removeSetupById', (setupId) => removeSetupById(context, setupId));
  context.subscriptions.push(
    output,
    vscode.workspace.onDidChangeWorkspaceFolders(updateWorkspaceContext),
    vscode.window.onDidChangeActiveTextEditor(updateWorkspaceContext),
    vscode.workspace.onDidCreateFiles((event) => { void updateWorkspaceContext(); for (const uri of event.files || []) scheduleCmakeVisibilityRefresh(context, { uri }); }),
    vscode.workspace.onDidDeleteFiles((event) => { void updateWorkspaceContext(); for (const uri of event.files || []) scheduleCmakeVisibilityRefresh(context, { uri }); }),
    vscode.workspace.onDidSaveTextDocument((document) => scheduleCmakeVisibilityRefresh(context, document)),
    { dispose() { if (cmakeVisibilityRefreshTimer) clearTimeout(cmakeVisibilityRefreshTimer); cmakeVisibilityRefreshTimer = undefined; globalCContext = undefined; } }
  );
  void updateWorkspaceContext();
  try {
    const root = cProjectRoot();
    const build = safeWorkspaceBuildPath(root);
    const setup = getBoundSetup(context, root);
    const ninja = setup.tools?.ninja && fs.existsSync(setup.tools.ninja) ? setup.tools.ninja : resolveBuildTool('ninja', ['ninja-build']);
    if (fs.existsSync(build)) cmakeVisibility.updateFromBuild(root, build, ninja);
  } catch {}
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
    rxCoreDeclaredFlags,
    coreSetFlagsBranch,
    coreDeclaredCompatibilityFlags,
    armArchitectureFlags,
    generatedProjectCmake,
    starterMain,
    isElfExecutable,
    findBuiltExecutable,
    cmakeExecutableTargets,
    findCmakeProjectRoot,
    hexPathForExecutable,
    compilerFamilyForSetup,
    looksLikeIntelHex,
    intelHexRecord,
    parseIntelHex,
    serializeIntelHex,
    xcConfigurationFieldId,
    xcConfigurationSelections,
    generateXcConfigurationSource,
    buildXcConfigurationObject,
    xc32ConfigurationWords,
    elfSectionTable,
    xc32PhysicalConfigurationAddress,
    xc32ConfigurationObjectSections,
    applyXc32ConfigurationWords,
    ensureXc32CodegripDebugHex,
    xcPrivilegeFingerprint,
    nativeXc8HexForElf,
    microchipHexConversion,
    microchipBin2hexNeedsElfAlias,
    ensureHex,
    isXc8AvrTarget,
    normalizeJlinkDeviceName,
    jlinkEraseScript,
    codegripCppDebugConfiguration,
    xc32GdbArchitecture,
    isSupportedProgrammer,
    renesasRfpDebugConfiguration,
    isRl78G24Setup,
    rl78G24ServerArgs,
    renesasRl78DirectCppDebugConfiguration,
    cDebugAvailability,
    isSetupDebugAvailable,
    isCodegripRestartRequest,
    isCodegripFinalStopRequest,
    findCMainEntryLine,
    findProjectMainSource,
    locateCoreSource,
    resolveCoreDefinitionFile,
    isMikroCFamily,
    mikroCPlatformBinDirectory,
    mikroCOutputExtension,
    parseMikroCDefaultOptions,
    mikroCCompilerFlags,
    mikroCSearchPathInfo,
    mikroCSearchPaths,
    resolveManagedNectoCmake,
    resolveManagedMikroCCmakeModules,
    generateMikroCJcfg,
    infrastructureLocations,
    generateMikroCLanguageSupport,
    generateMikroeUtilsCompatibility,
    generateCoreHeader,
    sdkCmakeVariables,
    completeSdkCmakeVariables,
    sdkMemoryVariables,
    normalizeApplicationOutput,
    applicationOutputCmakeValue,
    sdkPreProjectCmakeVariables,
    versionAtLeast,
    coreCompatibilityFlags,
    writeToolchain,
    codegripPackSpec,
    materializeCodegripRuntime,
    findCodegripServerExecutable,
    findBspBoardSource,
    materializeBoardBspPackage,
    materializeMcuCardBspPackage,
    materializeSyntheticCardlessBoard,
    cleanAppliedSetupArtifacts,
    invalidateBuiltSetupArtifacts,
    refreshXcSetupIfPrivilegeChanged,
    safeWorkspaceInstallPath,
    prepareWorkspaceInstallPrefix,
    isMikroSdkSourceProject,
    workspacePrefixArguments,
    workspaceSourceTreeDefinitionArguments,
    workspacePreProjectCmakeArguments,
    selectionFromSetup,
    expectedSdkDriverPackages,
    validateSdkDriverPackages,
    metadataMcuName,
    setupMcuName,
    isPlainLldbExecutable,
    isUsableMiDebugger,
    findArmGdbInRoot,
    isCmakePathDefinition,
    cmakeDefinitionValue,
    cmakeDefinitionArgument,
    cmakeDefinitions,
    C_BUILD_SUPPORT_VERSION
  }
};
