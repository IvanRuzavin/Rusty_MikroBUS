const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');

let mcuPanel;
let outputChannel;

function getManagedRoot(context) {
  const configured = vscode.workspace.getConfiguration('mikrobusRust').get('storageRoot', '').trim();
  if (configured) {
    return expandHome(configured);
  }
  return context.globalStorageUri.fsPath;
}

function getManagedPaths(context) {
  const root = getManagedRoot(context);
  return {
    root,
    database: path.join(root, 'database', 'database_mikro_sdk_rust.db'),
    sdk: path.join(root, 'sdk'),
    core: path.join(root, 'core')
  };
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}


function getConfiguredSetupPaths(context) {
  const root = path.join(getManagedRoot(context), 'configured-setups');
  return {
    root,
    registry: path.join(root, 'setups.json'),
    active: path.join(root, 'active.json')
  };
}

function setupIdForMcu(mcuName) {
  return String(mcuName || 'mcu')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'mcu';
}

function readConfiguredSetupRegistry(context) {
  const setupPaths = getConfiguredSetupPaths(context);
  if (!fs.existsSync(setupPaths.registry)) {
    return { version: 1, setups: [] };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(setupPaths.registry, 'utf8'));
    const setups = Array.isArray(parsed.setups) ? parsed.setups : [];
    return { version: 1, setups };
  } catch (error) {
    throw new Error(`Configured setup registry is invalid: ${setupPaths.registry}`);
  }
}

function writeConfiguredSetupRegistry(context, registry) {
  const setupPaths = getConfiguredSetupPaths(context);
  fs.mkdirSync(setupPaths.root, { recursive: true });
  fs.writeFileSync(setupPaths.registry, JSON.stringify({ version: 1, setups: registry.setups }, null, 2) + '\n', 'utf8');
}

function getActiveSetupId(context) {
  const setupPaths = getConfiguredSetupPaths(context);
  if (!fs.existsSync(setupPaths.active)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(setupPaths.active, 'utf8'));
    return typeof parsed.id === 'string' ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

function setActiveSetupId(context, id) {
  const setupPaths = getConfiguredSetupPaths(context);
  fs.mkdirSync(setupPaths.root, { recursive: true });
  fs.writeFileSync(setupPaths.active, JSON.stringify({ id }, null, 2) + '\n', 'utf8');
}

function clearActiveSetupId(context) {
  const setupPaths = getConfiguredSetupPaths(context);
  fs.rmSync(setupPaths.active, { force: true });
}

function listConfiguredSetups(context) {
  const activeSetupId = getActiveSetupId(context);
  return readConfiguredSetupRegistry(context).setups
    .map((setup) => ({ ...setup, active: setup.id === activeSetupId }))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function findConfiguredSetup(context, id) {
  return readConfiguredSetupRegistry(context).setups.find((setup) => setup.id === id);
}

function findConfiguredSetupForMcu(context, mcuName) {
  const target = String(mcuName || '').toLowerCase();
  return readConfiguredSetupRegistry(context).setups.find((setup) => String(setup.mcuName || '').toLowerCase() === target);
}

function saveConfiguredSetup(context, payload, result) {
  const registry = readConfiguredSetupRegistry(context);
  const now = new Date().toISOString();
  const requestedId = typeof payload.setupId === 'string' && payload.setupId.trim() ? payload.setupId.trim() : undefined;
  const existing = requestedId
    ? registry.setups.find((setup) => setup.id === requestedId)
    : registry.setups.find((setup) => String(setup.mcuName || '').toLowerCase() === String(result.mcuName || '').toLowerCase());
  const id = existing?.id || requestedId || setupIdForMcu(result.mcuName);

  const record = {
    id,
    mcuName: result.mcuName,
    vendor: result.vendor,
    family: result.family,
    target: result.target,
    systemLib: result.systemLib,
    cfgTarget: result.cfgTarget,
    relativePlatform: result.relativePlatform,
    clockMhz: result.clockMhz,
    values: payload.values && typeof payload.values === 'object' ? payload.values : {},
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastBuiltAt: now
  };

  const index = registry.setups.findIndex((setup) => setup.id === id);
  if (index >= 0) registry.setups[index] = record;
  else registry.setups.push(record);
  writeConfiguredSetupRegistry(context, registry);
  setActiveSetupId(context, id);
  return { ...record, active: true };
}

function removeConfiguredSetup(context, id) {
  const registry = readConfiguredSetupRegistry(context);
  const setup = registry.setups.find((item) => item.id === id);
  if (!setup) throw new Error(`Configured setup '${id}' was not found.`);

  registry.setups = registry.setups.filter((item) => item.id !== id);
  writeConfiguredSetupRegistry(context, registry);

  if (getActiveSetupId(context) === id) {
    const paths = getManagedPaths(context);
    fs.rmSync(path.join(paths.sdk, '.setup'), { recursive: true, force: true });
    fs.rmSync(path.join(paths.sdk, '.cargo', 'config.toml'), { force: true });
    clearActiveSetupId(context);
  }

  return setup;
}

function registerMcuConfigurator(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('mikrobusRust.configureMcu', async () => {
      await openMcuConfigurator(context);
    }),
    vscode.commands.registerCommand('mikrobusRust.useSetupWithWorkspace', async (setupId) => {
      await useSetupWithCurrentWorkspace(context, setupId);
    }),
    vscode.commands.registerCommand('mikrobusRust.useCurrentRustFile', async () => {
      await useCurrentRustFileAsMain(context);
    }),
    vscode.commands.registerCommand('mikrobusRust.buildWorkspace', async () => {
      await runBoundWorkspaceAction(context, 'build');
    }),
    vscode.commands.registerCommand('mikrobusRust.flashWorkspace', async () => {
      await runBoundWorkspaceAction(context, 'flash');
    }),
    vscode.commands.registerCommand('mikrobusRust.buildFlashWorkspace', async () => {
      await runBoundWorkspaceAction(context, 'buildFlashCurrent');
    }),
    vscode.commands.registerCommand('mikrobusRust.buildCurrentFile', async () => {
      await runBoundWorkspaceAction(context, 'buildCurrent');
    }),
    vscode.commands.registerCommand('mikrobusRust.flashCurrentFile', async () => {
      await runBoundWorkspaceAction(context, 'flashCurrent');
    }),
    vscode.commands.registerCommand('mikrobusRust.debugCurrentFile', async () => {
      await debugCurrentRustFile(context);
    }),
    vscode.commands.registerCommand('mikrobusRust.eraseWorkspaceMcu', async () => {
      await runBoundWorkspaceAction(context, 'erase');
    }),
    vscode.debug.registerDebugAdapterDescriptorFactory('mikrobus-rust-debug', {
      createDebugAdapterDescriptor(session) {
        const probeRsExecutable = resolveToolExecutable('probe-rs');
        const cwd = session.workspaceFolder?.uri?.fsPath || process.cwd();
        return new vscode.DebugAdapterExecutable(
          probeRsExecutable,
          ['dap-server'],
          { cwd, env: buildToolEnvironment(probeRsExecutable) }
        );
      }
    })
  );
  void updateWorkspaceContext();
}

async function updateWorkspaceContext() {
  await vscode.commands.executeCommand('setContext', 'mikrobusRust.workspaceBound', Boolean(readWorkspaceBinding()));
}


function getOutputChannel() {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('MikroBUS Rust');
  }
  return outputChannel;
}

function isPathWithin(parentPath, childPath) {
  const rel = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function findCompatibleSdkRoot(startPath) {
  if (!startPath) return undefined;
  let current;
  try {
    current = fs.statSync(startPath).isDirectory() ? path.resolve(startPath) : path.dirname(path.resolve(startPath));
  } catch {
    current = path.dirname(path.resolve(startPath));
  }

  for (let depth = 0; depth < 16; depth += 1) {
    const cargoToml = path.join(current, 'Cargo.toml');
    const templateConfig = path.join(current, '.cargo', 'template_config.toml');
    const targets = path.join(current, 'targets');
    if (fs.existsSync(cargoToml) && fs.existsSync(templateConfig) && fs.existsSync(targets)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function resolveCurrentWorkspaceSdk() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) {
    throw new Error('Open the Rust SDK project or its tests folder in VS Code first.');
  }

  const candidates = [];
  const activePath = vscode.window.activeTextEditor?.document?.uri?.scheme === 'file'
    ? vscode.window.activeTextEditor.document.uri.fsPath
    : undefined;
  if (activePath) candidates.push(activePath);
  for (const folder of folders) candidates.push(folder.uri.fsPath);

  for (const candidate of candidates) {
    const sdkRoot = findCompatibleSdkRoot(candidate);
    if (!sdkRoot) continue;
    const workspaceFolder = folders.find((folder) =>
      isPathWithin(sdkRoot, folder.uri.fsPath) || isPathWithin(folder.uri.fsPath, sdkRoot)
    ) || folders[0];
    return {
      sdkRoot,
      workspaceFolder,
      openedRoot: workspaceFolder.uri.fsPath,
      cargoToml: path.join(sdkRoot, 'Cargo.toml')
    };
  }

  throw new Error('This workspace is not a compatible rusty_mikrobus SDK. Expected Cargo.toml, .cargo/template_config.toml and targets/ in this folder or one of its parents.');
}

function getBindingPath(workspaceFolder) {
  return path.join(workspaceFolder.uri.fsPath, '.vscode', 'mikrobus-rust.json');
}

function readWorkspaceBinding() {
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const bindingPath = getBindingPath(folder);
    if (!fs.existsSync(bindingPath)) continue;
    try {
      const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
      const storedSdkRoot = String(binding.sdkRoot || '').trim();
      const sdkRoot = storedSdkRoot
        ? (path.isAbsolute(storedSdkRoot) ? storedSdkRoot : path.resolve(folder.uri.fsPath, storedSdkRoot))
        : findCompatibleSdkRoot(folder.uri.fsPath);
      return { ...binding, sdkRoot, bindingPath, workspaceFolder: folder };
    } catch {
      // Ignore an invalid binding here; the action that needs it will produce a clear message.
    }
  }
  return undefined;
}

function updateWorkspaceRustAnalyzer(workspaceFolder, sdkRoot, target) {
  const vscodeDir = path.join(workspaceFolder.uri.fsPath, '.vscode');
  const settingsPath = path.join(vscodeDir, 'settings.json');
  fs.mkdirSync(vscodeDir, { recursive: true });

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      throw new Error(`Cannot update Rust Analyzer because ${settingsPath} is not valid JSON.`);
    }
  }

  let cargoManifest = path.relative(workspaceFolder.uri.fsPath, path.join(sdkRoot, 'Cargo.toml')) || 'Cargo.toml';
  cargoManifest = cargoManifest.split(path.sep).join('/');
  const linked = Array.isArray(settings['rust-analyzer.linkedProjects'])
    ? [...settings['rust-analyzer.linkedProjects']]
    : [];
  if (!linked.includes(cargoManifest)) linked.push(cargoManifest);
  settings['rust-analyzer.linkedProjects'] = linked;
  if (target) settings['rust-analyzer.cargo.target'] = target;

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

function writeWorkspaceBinding(workspace, setup, generationResult) {
  const bindingPath = getBindingPath(workspace.workspaceFolder);
  fs.mkdirSync(path.dirname(bindingPath), { recursive: true });
  let sdkRootValue = path.relative(workspace.workspaceFolder.uri.fsPath, workspace.sdkRoot);
  if (!sdkRootValue) sdkRootValue = '.';
  sdkRootValue = sdkRootValue.split(path.sep).join('/');

  const binding = {
    version: 1,
    setupId: setup.id,
    mcuName: setup.mcuName,
    clockMhz: setup.clockMhz,
    target: setup.target,
    sdkRoot: sdkRootValue,
    configuredAt: new Date().toISOString(),
    setupRoot: path.relative(workspace.workspaceFolder.uri.fsPath, generationResult.setupRoot).split(path.sep).join('/')
  };
  fs.writeFileSync(bindingPath, JSON.stringify(binding, null, 2) + '\n', 'utf8');
  updateWorkspaceRustAnalyzer(workspace.workspaceFolder, workspace.sdkRoot, setup.target);
  void updateWorkspaceContext();
  return { ...binding, sdkRoot: workspace.sdkRoot, bindingPath, workspaceFolder: workspace.workspaceFolder };
}

async function chooseSetupIfNeeded(context, setupId) {
  if (setupId) {
    const setup = findConfiguredSetup(context, setupId);
    if (!setup) throw new Error(`Configured setup '${setupId}' was not found.`);
    return setup;
  }
  const setups = listConfiguredSetups(context);
  if (setups.length === 0) throw new Error('No configured MCU setups are available yet.');
  const chosen = await vscode.window.showQuickPick(
    setups.map((setup) => ({
      label: setup.mcuName,
      description: `${setup.clockMhz} MHz · ${setup.family || setup.target || ''}`,
      detail: setup.active ? 'Active configured setup' : 'Saved configured setup',
      setup
    })),
    { placeHolder: 'Select the MCU setup to use with the current Rust workspace' }
  );
  return chosen?.setup;
}

async function useSetupWithCurrentWorkspace(context, setupId) {
  const setup = await chooseSetupIfNeeded(context, setupId);
  if (!setup) return undefined;
  const workspace = resolveCurrentWorkspaceSdk();
  const payload = {
    setupId: setup.id,
    mcuName: setup.mcuName,
    clockMhz: setup.clockMhz,
    values: setup.values || {}
  };

  const result = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Applying ${setup.mcuName} setup to ${path.basename(workspace.sdkRoot)}...`,
    cancellable: false
  }, async (progress) => generateMcuConfiguration(context, payload, progress, { sdkRoot: workspace.sdkRoot }));

  const binding = writeWorkspaceBinding(workspace, setup, result);
  vscode.window.showInformationMessage(
    `${setup.mcuName} (${setup.clockMhz} MHz) is now configured for ${workspace.openedRoot}.`,
    'Build & Flash current .rs'
  ).then(async (choice) => {
    if (choice === 'Build & Flash current .rs') {
      await runBoundWorkspaceAction(context, 'buildFlashCurrent');
    }
  });

  if (mcuPanel) {
    void mcuPanel.webview.postMessage({
      type: 'workspaceBindingChanged',
      workspace: serializeWorkspaceBinding(binding),
      setups: listConfiguredSetups(context)
    });
  }
  return binding;
}

function serializeWorkspaceBinding(binding) {
  if (!binding) return undefined;
  return {
    setupId: binding.setupId,
    mcuName: binding.mcuName,
    clockMhz: binding.clockMhz,
    target: binding.target,
    sdkRoot: binding.sdkRoot,
    bindingPath: binding.bindingPath,
    workspaceName: binding.workspaceFolder?.name,
    openedRoot: binding.workspaceFolder?.uri?.fsPath
  };
}

function requireWorkspaceBinding(context) {
  const binding = readWorkspaceBinding();
  if (!binding) {
    throw new Error('No MCU setup is bound to the current workspace. Open Configured setups and choose “Use with workspace”.');
  }
  const setup = findConfiguredSetup(context, binding.setupId);
  if (!setup) {
    throw new Error(`The workspace refers to configured setup '${binding.setupId}', but that setup no longer exists.`);
  }
  if (!binding.sdkRoot || !fs.existsSync(path.join(binding.sdkRoot, 'Cargo.toml'))) {
    throw new Error('The bound Rust SDK root is no longer available. Re-apply the setup to this workspace.');
  }
  return { binding, setup };
}

function getActiveRustSource(binding) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file' || path.extname(editor.document.uri.fsPath).toLowerCase() !== '.rs') {
    throw new Error('Open the Rust .rs file you want to use before running this action.');
  }
  const source = editor.document.uri.fsPath;
  if (!isPathWithin(binding.sdkRoot, source)) {
    throw new Error(`The active Rust file is outside the bound SDK root: ${binding.sdkRoot}`);
  }
  return source;
}

async function useCurrentRustFileAsMain(context) {
  const { binding, setup } = requireWorkspaceBinding(context);
  const source = getActiveRustSource(binding);
  await vscode.window.activeTextEditor.document.save();
  const destination = path.join(binding.sdkRoot, 'src', 'main.rs');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  vscode.window.showInformationMessage(`${path.basename(source)} is now the application main.rs for ${setup.mcuName}.`);
  return destination;
}

function executableFileName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function isExecutableFile(candidate) {
  if (!candidate) return false;
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutableOnPath(name, env = process.env) {
  const pathValue = env.PATH || env.Path || env.path || '';
  if (!pathValue) return undefined;
  const names = process.platform === 'win32'
    ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`]
    : [name];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const fileName of names) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), fileName);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function configuredToolPath(settingName) {
  const value = String(vscode.workspace.getConfiguration('mikrobusRust').get(settingName, '') || '').trim();
  return value ? expandHome(value) : undefined;
}

function rustCargoBinDirectories() {
  const directories = [];
  const cargoHome = String(process.env.CARGO_HOME || '').trim();
  if (cargoHome) directories.push(path.join(expandHome(cargoHome), 'bin'));
  directories.push(path.join(os.homedir(), '.cargo', 'bin'));
  return [...new Set(directories.map((item) => path.resolve(item)))];
}

function resolveToolExecutable(tool) {
  const definitions = {
    cargo: { setting: 'cargoPath', rustTool: true },
    rustup: { setting: 'rustupPath', rustTool: true },
    'probe-rs': { setting: 'probeRsPath', rustTool: true }
  };
  const definition = definitions[tool] || { rustTool: false };
  const explicit = definition.setting ? configuredToolPath(definition.setting) : undefined;
  if (explicit) {
    if (!isExecutableFile(explicit)) {
      throw new Error(`Configured ${tool} executable was not found or is not executable: ${explicit}`);
    }
    return explicit;
  }

  const fromPath = findExecutableOnPath(tool);
  if (fromPath) return fromPath;

  if (definition.rustTool) {
    for (const directory of rustCargoBinDirectories()) {
      const candidate = path.join(directory, executableFileName(tool));
      if (isExecutableFile(candidate)) return candidate;
    }
  }

  const expected = definition.rustTool
    ? path.join(os.homedir(), '.cargo', 'bin', executableFileName(tool))
    : tool;
  throw new Error(
    `${tool} executable was not found. Expected it on PATH or at ${expected}. ` +
    `If Rust/probe-rs was installed while VS Code was already running, restart VS Code. ` +
    `You can also set mikrobusRust.${definition.setting || `${tool}Path`} in Settings.`
  );
}

function buildToolEnvironment(executable) {
  const env = { ...process.env };
  const existingPath = env.PATH || env.Path || env.path || '';
  const pathEntries = [path.dirname(executable), ...rustCargoBinDirectories(), ...existingPath.split(path.delimiter)]
    .filter(Boolean);
  const seen = new Set();
  const normalized = [];
  for (const entry of pathEntries) {
    const key = process.platform === 'win32' ? entry.toLowerCase() : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(entry);
  }
  env.PATH = normalized.join(path.delimiter);
  if (process.platform === 'win32') env.Path = env.PATH;
  return env;
}

function runStreaming(executable, args, cwd, channel) {
  return new Promise((resolve, reject) => {
    channel.appendLine(`\n$ ${[executable, ...args].join(' ')}`);
    const child = childProcess.spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: buildToolEnvironment(executable)
    });
    child.stdout.on('data', (data) => channel.append(data.toString()));
    child.stderr.on('data', (data) => channel.append(data.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  });
}

async function executeChecked(channel, tool, args, cwd) {
  const executable = resolveToolExecutable(tool);
  channel.appendLine(`Resolved ${tool}: ${executable}`);
  const code = await runStreaming(executable, args, cwd, channel);
  if (code !== 0) throw new Error(`${tool} ${args.join(' ')} failed with exit code ${code}. See the MikroBUS Rust output.`);
}

function readCargoPackageName(cargoTomlPath) {
  const text = readRequired(cargoTomlPath);
  let inPackage = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      inPackage = trimmed === '[package]';
      continue;
    }
    if (!inPackage) continue;
    const match = trimmed.match(/^name\s*=\s*["']([^"']+)["']/);
    if (match) return match[1];
  }
  throw new Error(`Cannot determine [package] name from ${cargoTomlPath}.`);
}

function resolveBuiltProgramBinary(binding, setup) {
  const packageName = readCargoPackageName(path.join(binding.sdkRoot, 'Cargo.toml'));
  const executableName = process.platform === 'win32' ? `${packageName}.exe` : packageName;
  const candidates = [
    setup.target ? path.join(binding.sdkRoot, 'target', setup.target, 'debug', executableName) : undefined,
    path.join(binding.sdkRoot, 'target', 'debug', executableName)
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;
  throw new Error(`Cargo build completed, but the debug ELF was not found. Expected one of: ${candidates.join(', ')}`);
}

async function debugCurrentRustFile(context) {
  const { binding, setup } = requireWorkspaceBinding(context);
  const channel = getOutputChannel();
  channel.show(true);
  channel.appendLine(`\n=== ${setup.mcuName} · ${setup.clockMhz} MHz · Debug current Rust file ===`);
  channel.appendLine(`SDK root: ${binding.sdkRoot}`);

  await useCurrentRustFileAsMain(context);
  await executeChecked(channel, 'cargo', ['build'], binding.sdkRoot);
  const programBinary = resolveBuiltProgramBinary(binding, setup);
  const probeRsExecutable = resolveToolExecutable('probe-rs');
  channel.appendLine(`Debug ELF: ${programBinary}`);
  channel.appendLine(`Resolved probe-rs: ${probeRsExecutable}`);

  const started = await vscode.debug.startDebugging(binding.workspaceFolder, {
    type: 'mikrobus-rust-debug',
    request: 'launch',
    name: `MikroBUS Rust: ${setup.mcuName}`,
    cwd: binding.sdkRoot,
    chip: setup.mcuName,
    connectUnderReset: true,
    flashingConfig: {
      flashingEnabled: true,
      haltAfterReset: true,
      formatOptions: { binaryFormat: 'elf' }
    },
    coreConfigs: [{
      coreIndex: 0,
      programBinary
    }],
    consoleLogLevel: 'Console'
  });
  if (!started) throw new Error('VS Code did not start the probe-rs debug session.');
}

async function runBoundWorkspaceAction(context, action) {
  const { binding, setup } = requireWorkspaceBinding(context);
  const channel = getOutputChannel();
  channel.show(true);
  channel.appendLine(`\n=== ${setup.mcuName} · ${setup.clockMhz} MHz ===`);
  channel.appendLine(`SDK root: ${binding.sdkRoot}`);

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `MikroBUS Rust: ${action === 'erase' ? 'Erasing' : action === 'flash' ? 'Flashing' : 'Building'} ${setup.mcuName}...`,
    cancellable: false
  }, async () => {
    if (action === 'buildFlashCurrent' || action === 'flashCurrent') {
      await useCurrentRustFileAsMain(context);
      await executeChecked(channel, 'cargo', ['build'], binding.sdkRoot);
      await executeChecked(channel, 'cargo', ['flash', '--chip', setup.mcuName, '--connect-under-reset'], binding.sdkRoot);
      return;
    }
    if (action === 'buildCurrent') {
      await useCurrentRustFileAsMain(context);
      await executeChecked(channel, 'cargo', ['build'], binding.sdkRoot);
      return;
    }
    if (action === 'build') {
      await executeChecked(channel, 'cargo', ['build'], binding.sdkRoot);
      return;
    }
    if (action === 'flash') {
      await executeChecked(channel, 'cargo', ['flash', '--chip', setup.mcuName, '--connect-under-reset'], binding.sdkRoot);
      return;
    }
    if (action === 'erase') {
      await executeChecked(channel, 'probe-rs', ['erase', '--chip', setup.mcuName], binding.sdkRoot);
      return;
    }
    throw new Error(`Unknown workspace action '${action}'.`);
  });

  vscode.window.showInformationMessage(
    action === 'buildFlashCurrent' || action === 'flashCurrent'
      ? `${setup.mcuName}: current Rust file built and flashed successfully.`
      : action === 'buildCurrent'
        ? `${setup.mcuName}: current Rust file built successfully.`
        : `${setup.mcuName}: ${action} completed successfully.`
  );
}

async function openMcuConfigurator(context) {
  if (mcuPanel) {
    mcuPanel.reveal(vscode.ViewColumn.Active);
    await sendInitialState(mcuPanel, context);
    return;
  }

  mcuPanel = vscode.window.createWebviewPanel(
    'mikrobusRust.mcuConfigurator',
    'MikroBUS Rust: MCU Configuration',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    }
  );

  mcuPanel.webview.html = getMcuHtml(mcuPanel.webview, context.extensionUri);

  mcuPanel.onDidDispose(() => {
    mcuPanel = undefined;
  }, null, context.subscriptions);

  mcuPanel.webview.onDidReceiveMessage(async (message) => {
    try {
      await handleMcuMessage(message, mcuPanel, context);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`MikroBUS Rust: ${text}`);
      if (mcuPanel) {
        void mcuPanel.webview.postMessage({ type: 'error', message: text });
      }
    }
  }, null, context.subscriptions);
}

async function sendInitialState(panel, context) {
  if (!panel) return;

  const paths = getManagedPaths(context);
  const missing = [];
  if (!fs.existsSync(paths.database)) missing.push('database');
  if (!fs.existsSync(paths.core)) missing.push('core');
  if (!fs.existsSync(paths.sdk)) missing.push('sdk');

  if (missing.length > 0) {
    void panel.webview.postMessage({
      type: 'environmentMissing',
      missing,
      managedRoot: paths.root
    });
    return;
  }

  const mcus = readMcuList(paths.database);
  const setups = listConfiguredSetups(context);
  void panel.webview.postMessage({
    type: 'mcuList',
    mcus,
    setups,
    activeSetupId: getActiveSetupId(context),
    workspace: serializeWorkspaceBinding(readWorkspaceBinding()),
    managedRoot: paths.root,
    count: mcus.length
  });
}

async function handleMcuMessage(message, panel, context) {
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'ready' || message.type === 'refresh') {
    await sendInitialState(panel, context);
    return;
  }

  if (message.type === 'openSetup') {
    await vscode.commands.executeCommand('mikrobusRust.openSetup');
    return;
  }

  if (message.type === 'selectMcu' && typeof message.name === 'string') {
    const paths = getManagedPaths(context);
    const detail = loadMcuDetail(paths, message.name);
    const setup = findConfiguredSetupForMcu(context, message.name);
    void panel.webview.postMessage({ type: 'mcuDetail', detail, setup: setup ? { ...setup, active: setup.id === getActiveSetupId(context) } : undefined });
    return;
  }

  if (message.type === 'editSetup' && typeof message.id === 'string') {
    const setup = findConfiguredSetup(context, message.id);
    if (!setup) throw new Error(`Configured setup '${message.id}' was not found.`);
    const paths = getManagedPaths(context);
    const detail = loadMcuDetail(paths, setup.mcuName);
    void panel.webview.postMessage({ type: 'mcuDetail', detail, setup: { ...setup, active: setup.id === getActiveSetupId(context) } });
    return;
  }

  if (message.type === 'generateConfiguration') {
    const payload = message.payload || {};
    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Generating MikroBUS Rust configuration for ${payload.mcuName || 'MCU'}...`,
      cancellable: false
    }, async (progress) => {
      progress.report({ message: 'Validating MCU and register settings...' });
      return generateMcuConfiguration(context, payload, progress);
    });

    const setup = saveConfiguredSetup(context, payload, result);
    const detailText = result.warning
      ? `Configuration generated and saved. ${result.warning}`
      : `Configuration generated and saved for ${result.mcuName}.`;
    vscode.window.showInformationMessage(detailText);
    void panel.webview.postMessage({
      type: 'generationComplete',
      result: { ...result, setup },
      setups: listConfiguredSetups(context),
      activeSetupId: getActiveSetupId(context)
    });
    return;
  }

  if (message.type === 'rebuildSetup' && typeof message.id === 'string') {
    const setup = findConfiguredSetup(context, message.id);
    if (!setup) throw new Error(`Configured setup '${message.id}' was not found.`);
    const payload = {
      setupId: setup.id,
      mcuName: setup.mcuName,
      clockMhz: setup.clockMhz,
      values: setup.values || {}
    };
    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Rebuilding MikroBUS Rust configuration for ${setup.mcuName}...`,
      cancellable: false
    }, async (progress) => generateMcuConfiguration(context, payload, progress));
    const saved = saveConfiguredSetup(context, payload, result);
    vscode.window.showInformationMessage(`Rebuilt configuration for ${setup.mcuName}.`);
    void panel.webview.postMessage({
      type: 'rebuildComplete',
      result: { ...result, setup: saved },
      setups: listConfiguredSetups(context),
      activeSetupId: getActiveSetupId(context)
    });
    return;
  }

  if (message.type === 'useSetupWithWorkspace' && typeof message.id === 'string') {
    await useSetupWithCurrentWorkspace(context, message.id);
    void panel.webview.postMessage({
      type: 'workspaceBindingChanged',
      workspace: serializeWorkspaceBinding(readWorkspaceBinding()),
      setups: listConfiguredSetups(context)
    });
    return;
  }

  if (message.type === 'workspaceAction' && typeof message.action === 'string') {
    if (message.action === 'debugCurrent') {
      await debugCurrentRustFile(context);
    } else {
      await runBoundWorkspaceAction(context, message.action);
    }
    void panel.webview.postMessage({ type: 'workspaceActionComplete', action: message.action });
    return;
  }

  if (message.type === 'removeSetup' && typeof message.id === 'string') {
    const setup = findConfiguredSetup(context, message.id);
    if (!setup) throw new Error(`Configured setup '${message.id}' was not found.`);
    const confirmation = await vscode.window.showWarningMessage(
      `Remove configured setup for ${setup.mcuName}?`,
      { modal: true, detail: getActiveSetupId(context) === setup.id ? 'This is the active setup. Its generated sdk/.setup output will also be removed.' : 'The saved MCU/clock/register configuration will be removed.' },
      'Remove'
    );
    if (confirmation !== 'Remove') return;
    const workspaceBinding = readWorkspaceBinding();
    if (workspaceBinding?.setupId === message.id) {
      if (workspaceBinding.sdkRoot) {
        fs.rmSync(path.join(workspaceBinding.sdkRoot, '.setup'), { recursive: true, force: true });
        fs.rmSync(path.join(workspaceBinding.sdkRoot, '.cargo', 'config.toml'), { force: true });
      }
      fs.rmSync(workspaceBinding.bindingPath, { force: true });
      void updateWorkspaceContext();
    }
    removeConfiguredSetup(context, message.id);
    void panel.webview.postMessage({
      type: 'setupRemoved',
      removedId: message.id,
      setups: listConfiguredSetups(context),
      activeSetupId: getActiveSetupId(context),
      workspace: serializeWorkspaceBinding(readWorkspaceBinding())
    });
    return;
  }
}

function getDatabaseSync() {
  try {
    // VS Code 1.101+ uses a Node 22 extension host. node:sqlite is available there.
    // Keeping this require lazy produces a clear message on older VS Code versions.
    return require('node:sqlite').DatabaseSync;
  } catch (error) {
    throw new Error('SQLite support requires VS Code 1.101 or newer. Please update VS Code and reload the extension.');
  }
}

function withDatabase(databasePath, callback) {
  const DatabaseSync = getDatabaseSync();
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function readMcuList(databasePath) {
  return withDatabase(databasePath, (db) => {
    const statement = db.prepare(`
      SELECT
        MCU.NAME AS name,
        FAMILY.VENDOR AS vendor,
        FAMILY.TARGET AS target,
        MCU.SYSTEM_LIB AS systemLib,
        MCU.FAMILY AS family
      FROM MCU
      JOIN FAMILY ON MCU.FAMILY = FAMILY.NAME
      ORDER BY MCU.NAME COLLATE NOCASE
    `);
    return statement.all().map(normalizeSqlRow);
  });
}

function readMcuMetadata(databasePath, mcuName) {
  return withDatabase(databasePath, (db) => {
    const statement = db.prepare(`
      SELECT
        MCU.NAME AS name,
        FAMILY.VENDOR AS vendor,
        FAMILY.TARGET AS target,
        MCU.SYSTEM_LIB AS systemLib,
        MCU.FAMILY AS family
      FROM MCU
      JOIN FAMILY ON MCU.FAMILY = FAMILY.NAME
      WHERE MCU.NAME = ?
      LIMIT 1
    `);
    const row = statement.get(mcuName);
    if (!row) throw new Error(`MCU '${mcuName}' is not present in the database.`);
    return normalizeSqlRow(row);
  });
}

function readFamilyImplementationMetadata(databasePath, mcuName) {
  return withDatabase(databasePath, (db) => {
    const columns = db.prepare('PRAGMA table_info(FAMILY)').all().map(normalizeSqlRow);
    if (columns.length < 10) {
      throw new Error(`FAMILY table has ${columns.length} columns; the PyQt workflow expects at least 10.`);
    }

    const row = db.prepare(`
      SELECT FAMILY.*
      FROM MCU
      JOIN FAMILY ON MCU.FAMILY = FAMILY.NAME
      WHERE MCU.NAME = ?
      LIMIT 1
    `).get(mcuName);
    if (!row) throw new Error(`FAMILY data for '${mcuName}' was not found.`);

    const normalized = normalizeSqlRow(row);
    const valueAt = (index) => normalized[String(columns[index].name)];

    return {
      gpio: String(valueAt(4) ?? ''),
      adc: String(valueAt(5) ?? ''),
      i2c: String(valueAt(6) ?? ''),
      spi: String(valueAt(7) ?? ''),
      tim: String(valueAt(8) ?? ''),
      uart: String(valueAt(9) ?? ''),
      columns: columns.map((column) => String(column.name))
    };
  });
}

function normalizeSqlRow(row) {
  if (!row) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return out;
}

function loadMcuDetail(paths, mcuName) {
  const metadata = readMcuMetadata(paths.database, mcuName);
  const definitionPath = findMcuDefinition(paths.core, mcuName);
  if (!definitionPath) {
    throw new Error(`MCU definition JSON not found for ${mcuName} under ${paths.core}.`);
  }

  const definition = JSON.parse(fs.readFileSync(definitionPath, 'utf8'));
  const registers = (definition.config_registers || []).map((reg, regIndex) => ({
    key: reg.key,
    address: reg.address,
    fields: (reg.fields || []).map((field, fieldIndex) => ({
      id: `${regIndex}:${fieldIndex}`,
      key: field.key,
      label: field.label || field.key,
      mask: field.mask,
      init: field.init,
      hidden: Boolean(field.hidden),
      settings: (field.settings || []).map((setting) => ({
        label: setting.label,
        value: setting.value
      }))
    })).filter((field) => !field.hidden)
  })).filter((reg) => reg.fields.length > 0);

  return {
    ...metadata,
    clock: String(definition.clock ?? ''),
    definitionPath,
    registers
  };
}

function findMcuDefinition(coreRoot, mcuName) {
  const stm32Path = path.join(coreRoot, 'arm', 'stm32', 'mcu_definitions', `${mcuName}.json`);
  if (fs.existsSync(stm32Path)) return stm32Path;

  return findFileRecursively(coreRoot, `${mcuName}.json`, (candidate) => path.basename(path.dirname(candidate)) === 'mcu_definitions');
}

function findFileRecursively(root, fileName, predicate) {
  if (!fs.existsSync(root)) return undefined;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name === fileName && (!predicate || predicate(full))) {
        return full;
      }
    }
  }
  return undefined;
}

function parseNumber(value) {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value !== 'string') {
    return 0;
  }

  return Number.parseInt(value.replace(/^0x/i, ''), 16) || 0;
}

function buildRegisterHeader(definition, selectedValues, clockMhz) {
  const collected = new Map();

  for (let regIndex = 0; regIndex < (definition.config_registers || []).length; regIndex += 1) {
    const reg = definition.config_registers[regIndex];
    const combinedKey = `${reg.key}|${reg.address}`;
    let registerValue = 0;

    for (let fieldIndex = 0; fieldIndex < (reg.fields || []).length; fieldIndex += 1) {
      const field = reg.fields[fieldIndex];
      let value;

      if (field.hidden) {
        value = field.init ?? '0x0';
      } else {
        const fieldId = `${regIndex}:${fieldIndex}`;
        const selected = selectedValues[fieldId];
        const allowed = (field.settings || []).map((setting) => String(setting.value));
        if (selected !== undefined && allowed.includes(String(selected))) {
          value = selected;
        } else {
          value = field.init ?? (field.settings && field.settings[0] ? field.settings[0].value : '0x0');
        }
      }

      registerValue |= parseNumber(value);
    }

    collected.set(combinedKey, registerValue >>> 0);
  }

  const lines = [];
  for (const [combinedKey, registerValue] of collected.entries()) {
    const separator = combinedKey.indexOf('|');
    const regName = combinedKey.slice(0, separator);
    const address = combinedKey.slice(separator + 1);
    lines.push(`pub const ADDRESS_${regName}: u32 = 0x${String(address).replace(/^0x/i, '')};`);
    lines.push(`pub const VALUE_${regName}: u32 = 0x${registerValue.toString(16).toUpperCase().padStart(8, '0')};`);
  }
  lines.push(`pub const FOSC_KHZ_VALUE: u32 = ${clockMhz * 1000};`);
  return lines.join('\n');
}

async function generateMcuConfiguration(context, payload, progress, options = {}) {
  const managedPaths = getManagedPaths(context);
  const paths = { ...managedPaths, sdk: options.sdkRoot ? path.resolve(options.sdkRoot) : managedPaths.sdk };
  const mcuName = String(payload.mcuName || '').trim();
  const clockMhz = Number.parseInt(String(payload.clockMhz || ''), 10);
  const selectedValues = payload.values && typeof payload.values === 'object' ? payload.values : {};

  if (!mcuName) throw new Error('Select an MCU before generating the configuration.');
  if (!Number.isInteger(clockMhz) || clockMhz <= 0) throw new Error('Clock must be a positive integer in MHz.');

  for (const required of [paths.database, paths.sdk, paths.core]) {
    if (!fs.existsSync(required)) throw new Error(`Required managed package is missing: ${required}`);
  }

  const metadata = readMcuMetadata(paths.database, mcuName);
  const familyImpl = readFamilyImplementationMetadata(paths.database, mcuName);
  const definitionPath = findMcuDefinition(paths.core, mcuName);
  if (!definitionPath) throw new Error(`MCU definition JSON not found for ${mcuName}.`);
  const definition = JSON.parse(fs.readFileSync(definitionPath, 'utf8'));

  const mcuDefinitionsRoot = path.dirname(definitionPath);
  const platformCoreRoot = path.dirname(mcuDefinitionsRoot);
  const relativePlatform = path.relative(paths.core, platformCoreRoot);
  const sdkTargetRoot = path.join(paths.sdk, 'targets', relativePlatform);
  const familyLower = String(metadata.family || '').toLowerCase();

  progress.report({ message: 'Generating core register constants...' });
  const coreHeader = buildRegisterHeader(definition, selectedValues, clockMhz);

  const setupRoot = path.join(paths.sdk, '.setup');
  const stagingRoot = path.join(paths.sdk, '.setup.__mikrobus_staging');
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(stagingRoot, 'core', 'src'), { recursive: true });
  fs.mkdirSync(path.join(stagingRoot, 'sdk'), { recursive: true });

  try {
    const coreSetup = path.join(stagingRoot, 'core');
    const coreSrc = path.join(coreSetup, 'src');
    fs.writeFileSync(path.join(coreSrc, 'core_header.rs'), coreHeader, 'utf8');

    progress.report({ message: 'Selecting startup, linker and MCU header files...' });
    copyRequired(path.join(platformCoreRoot, 'memory', mcuName, 'memory.x'), path.join(coreSetup, 'memory.x'));
    copyRequired(path.join(platformCoreRoot, 'startup', `${mcuName.toLowerCase()}.s`), path.join(coreSrc, 'startup.s'));
    copyRequired(path.join(platformCoreRoot, 'mcu_headers', mcuName, 'lib.rs'), path.join(coreSrc, 'mcu_header.rs'));
    copyRequired(path.join(platformCoreRoot, 'reset.rs'), path.join(coreSrc, 'reset.rs'));
    copyRequired(path.join(platformCoreRoot, 'system', metadata.systemLib, 'init_clock.rs'), path.join(coreSrc, 'init_clock.rs'));
    copyRequired(path.join(platformCoreRoot, 'Cargo.toml'), path.join(coreSetup, 'Cargo.toml'));
    copyRequired(path.join(platformCoreRoot, 'lib.rs'), path.join(coreSrc, 'lib.rs'));
    copyRequired(path.join(platformCoreRoot, 'common_header.rs'), path.join(coreSrc, 'common_header.rs'));

    progress.report({ message: 'Updating Rust compilation target...' });
    const templateConfig = path.join(paths.sdk, '.cargo', 'template_config.toml');
    const cargoConfig = path.join(paths.sdk, '.cargo', 'config.toml');
    const configText = readRequired(templateConfig).replaceAll('{compiling_target}', metadata.target);
    fs.mkdirSync(path.dirname(cargoConfig), { recursive: true });
    fs.writeFileSync(cargoConfig, configText, 'utf8');

    progress.report({ message: 'Generating pin mappings and HAL module features...' });
    const pinMappingsRoot = path.join(platformCoreRoot, 'pin_mappings');
    const familyPinRoot = path.join(pinMappingsRoot, familyLower);
    const sdkSetup = path.join(stagingRoot, 'sdk');
    copyDirectoryRequired(path.join(familyPinRoot, 'src'), path.join(sdkSetup, 'src'));
    normalizeRustCrateEntryPoint(sdkSetup);

    let familyTemplate = readRequired(path.join(familyPinRoot, 'Cargo_family_template.toml'));
    let halLlTemplate = readRequired(path.join(pinMappingsRoot, 'hal_ll_Cargo_template.toml'));

    const rustLanguage = (definition.language_list || []).find((entry) => String(entry.language || '').toUpperCase() === 'RUST');
    if (!rustLanguage) throw new Error(`${mcuName}.json does not contain a RUST language_list entry.`);

    for (const module of rustLanguage.module_list || []) {
      const moduleName = module.module_name;
      const enabledSubModules = [];
      for (const subModule of module.sub_modules || []) {
        const subName = subModule.sub_module_name;
        const features = Array.isArray(subModule.pin_map_features) ? subModule.pin_map_features : [];
        const featureText = features.map((feature) => `"${feature}"`).join(',');
        if (featureText) enabledSubModules.push(`"${subName}"`);
        familyTemplate = familyTemplate.replaceAll(`{${subName}_features}`, featureText);
      }
      halLlTemplate = halLlTemplate
        .replaceAll(`{${moduleName}}`, enabledSubModules.join(','))
        .replaceAll('{family}', familyLower);
    }

    fs.writeFileSync(path.join(sdkSetup, 'Cargo.toml'), familyTemplate, 'utf8');
    fs.mkdirSync(sdkTargetRoot, { recursive: true });
    fs.writeFileSync(path.join(sdkTargetRoot, 'Cargo.toml'), halLlTemplate, 'utf8');

    progress.report({ message: 'Selecting family-specific HAL implementations...' });
    const targetSrc = path.join(sdkTargetRoot, 'src');
    fs.mkdirSync(targetSrc, { recursive: true });

    copyRequired(path.join(sdkTargetRoot, 'gpio', 'hal_ll_gpio', 'gpio.rs'), path.join(targetSrc, 'gpio.rs'));
    copyRequired(path.join(sdkTargetRoot, 'gpio', 'gpio_port', requireImplementation(familyImpl.gpio, 'GPIO'), 'gpio_port.rs'), path.join(targetSrc, 'gpio_port.rs'));
    copyRequired(path.join(sdkTargetRoot, 'adc', requireImplementation(familyImpl.adc, 'ADC'), 'adc.rs'), path.join(targetSrc, 'adc.rs'));
    copyRequired(path.join(sdkTargetRoot, 'i2c', requireImplementation(familyImpl.i2c, 'I2C'), 'i2c_master.rs'), path.join(targetSrc, 'i2c_master.rs'));
    copyRequired(path.join(sdkTargetRoot, 'spi', requireImplementation(familyImpl.spi, 'SPI'), 'spi_master.rs'), path.join(targetSrc, 'spi_master.rs'));
    copyRequired(path.join(sdkTargetRoot, 'tim', requireImplementation(familyImpl.tim, 'TIM'), 'tim.rs'), path.join(targetSrc, 'tim.rs'));
    copyRequired(path.join(sdkTargetRoot, 'uart', requireImplementation(familyImpl.uart, 'UART'), 'uart.rs'), path.join(targetSrc, 'uart.rs'));
    copyRequired(path.join(sdkTargetRoot, 'one_wire', 'implementation_1', 'one_wire.rs'), path.join(targetSrc, 'one_wire.rs'));

    progress.report({ message: 'Committing generated .setup configuration...' });
    fs.rmSync(setupRoot, { recursive: true, force: true });
    fs.renameSync(stagingRoot, setupRoot);

    let warning = '';
    progress.report({ message: `Ensuring Rust target ${metadata.target} is installed...` });
    try {
      const rustupExecutable = resolveToolExecutable('rustup');
      const rustupResult = await runProcess(rustupExecutable, ['target', 'add', metadata.target], paths.sdk, buildToolEnvironment(rustupExecutable));
      if (rustupResult.code !== 0) {
        warning = `rustup target add ${metadata.target} returned ${rustupResult.code}; generated files are still available.`;
      }
    } catch (error) {
      warning = `Could not run rustup target add ${metadata.target}; generated files are still available.`;
    }

    return {
      mcuName,
      clockMhz,
      target: metadata.target,
      vendor: metadata.vendor,
      family: metadata.family,
      systemLib: metadata.systemLib,
      cfgTarget: `${mcuName.slice(0, 7).toLowerCase()}x.cfg`,
      relativePlatform,
      setupRoot,
      coreHeader: path.join(setupRoot, 'core', 'src', 'core_header.rs'),
      cargoConfig: path.join(paths.sdk, '.cargo', 'config.toml'),
      warning
    };
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function requireImplementation(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} implementation is empty in the FAMILY database row.`);
  return text;
}

function copyRequired(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Required source file not found: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyDirectoryRequired(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Required source directory not found: ${source}`);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
}

function normalizeRustCrateEntryPoint(crateRoot) {
  const srcRoot = path.join(crateRoot, 'src');
  const expected = path.join(srcRoot, 'lib.rs');
  if (fs.existsSync(expected)) return expected;
  if (!fs.existsSync(srcRoot)) throw new Error(`Generated Rust crate source directory is missing: ${srcRoot}`);

  const caseInsensitiveMatch = fs.readdirSync(srcRoot, { withFileTypes: true })
    .find((entry) => entry.isFile() && entry.name.toLowerCase() === 'lib.rs');
  if (!caseInsensitiveMatch) {
    throw new Error(`Generated Rust crate is missing src/lib.rs: ${crateRoot}`);
  }

  // Some existing core packages use "Lib.rs". Cargo requires the conventional
  // lowercase src/lib.rs path on case-sensitive filesystems such as Linux.
  fs.copyFileSync(path.join(srcRoot, caseInsensitiveMatch.name), expected);
  return expected;
}

function readRequired(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Required source file not found: ${filePath}`);
  return fs.readFileSync(filePath, 'utf8');
}

function runProcess(executable, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(executable, args, {
      cwd,
      windowsHide: true,
      shell: false,
      env
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function getMcuHtml(webview, extensionUri) {
  const nonce = getNonce();
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'mcu.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'mcu.js'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>MikroBUS Rust MCU Configuration</title>
</head>
<body>
  <div id="app" class="app">
    <header class="topbar">
      <div>
        <div class="eyebrow">MIKROBUS RUST</div>
        <h1>MCU Configuration</h1>
        <p>Choose a device, configure its clock/registers, and manage previously built MCU setups.</p>
      </div>
      <div class="topActions">
        <button id="showSetups" class="secondary">Configured setups <span id="setupCount" class="buttonCount">0</span></button>
        <button id="refresh" class="secondary">Refresh database</button>
        <button id="openSetup" class="secondary">Environment setup</button>
      </div>
    </header>

    <div id="missingState" class="missing hidden"></div>

    <main id="workspace" class="workspace hidden">
      <section id="catalogView" class="pageView">
        <div class="viewHeader">
          <div>
            <div class="eyebrow">AVAILABLE DEVICES</div>
            <h2>MCU catalog</h2>
            <p>Select a row to open that MCU's clock and register configuration.</p>
          </div>
          <div class="catalogTools">
            <label class="searchBox">
              <span>Search</span>
              <input id="mcuSearch" type="search" placeholder="MCU, vendor, family, target..." autocomplete="off">
            </label>
            <div class="resultCount"><strong id="mcuCount">0</strong><span>MCUs</span></div>
          </div>
        </div>

        <div class="tableShell">
          <table class="dataTable mcuTable">
            <thead>
              <tr>
                <th>MCU</th>
                <th>Vendor</th>
                <th>Family</th>
                <th>Rust target</th>
                <th>System library</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody id="mcuTableBody"></tbody>
          </table>
        </div>
      </section>

      <section id="loadingView" class="loadingView hidden">
        <div class="chipIcon">µ</div>
        <h2 id="loadingText">Loading MCU...</h2>
      </section>

      <section id="configView" class="pageView hidden">
        <div class="viewNav">
          <button id="backToMcus" class="secondary">← All MCUs</button>
          <button id="showSetupsFromConfig" class="secondary">Configured setups</button>
        </div>

        <div class="deviceHeader">
          <div>
            <div class="eyebrow">MCU SETTINGS</div>
            <div class="titleWithBadge">
              <h2 id="selectedName"></h2>
              <span id="setupState" class="statusBadge available">Not configured</span>
            </div>
          </div>
          <div class="metaGrid">
            <div><span>Vendor</span><strong id="selectedVendor"></strong></div>
            <div><span>Family</span><strong id="selectedFamily"></strong></div>
            <div><span>Rust target</span><code id="selectedTarget"></code></div>
            <div><span>System library</span><code id="selectedSystem"></code></div>
          </div>
        </div>

        <section class="clockSection card">
          <div>
            <h3>System clock</h3>
            <p>Changing this value updates <code>FOSC_KHZ_VALUE</code> when the setup is built.</p>
          </div>
          <label class="clockInput">Clock (MHz)<input id="clockMhz" type="number" min="1" step="1"></label>
        </section>

        <section>
          <div class="sectionHeading">
            <div><h3>Clock / configuration registers</h3><p>Options come directly from the selected MCU JSON. Hidden fields keep their JSON initialization value.</p></div>
          </div>
          <div id="registerGrid" class="registerGrid"></div>
        </section>

        <div class="generateBar">
          <div id="generationStatus" class="generationStatus"></div>
          <button id="generate" class="primary">Build Configuration</button>
        </div>
      </section>

      <section id="setupsView" class="pageView hidden">
        <div class="viewNav managerNav">
          <button id="backToMcusFromSetups" class="secondary">← All MCUs</button>
        </div>
        <div class="viewHeader setupsHeader">
          <div>
            <div class="eyebrow">SAVED CONFIGURATIONS</div>
            <h2>Configured setups</h2>
            <p>Reopen a setup to change its clock/register settings, rebuild it as the active <code>sdk/.setup</code>, or remove it.</p>
          </div>
        </div>
        <div id="workspaceBindingCard" class="workspaceBindingCard hidden">
          <div>
            <div class="eyebrow">CURRENT RUST WORKSPACE</div>
            <h3 id="workspaceBindingTitle">No setup selected</h3>
            <p id="workspaceBindingPath"></p>
          </div>
          <div class="workspaceActions">
            <button id="workspaceBuild" class="secondary">Build current .rs</button>
            <button id="workspaceFlash" class="primary">Build &amp; Flash current .rs</button>
            <button id="workspaceDebug" class="primary">Debug current .rs (F5)</button>
            <button id="workspaceErase" class="secondary">Erase MCU</button>
          </div>
        </div>
        <div id="setupsStatus" class="managerStatus"></div>
        <div id="setupEmpty" class="emptyManager hidden">
          <div class="chipIcon">µ</div>
          <h3>No configured setups yet</h3>
          <p>Build an MCU configuration and it will appear here.</p>
        </div>
        <div id="setupTable" class="tableShell hidden">
          <table class="dataTable setupTable">
            <thead>
              <tr>
                <th>MCU</th>
                <th>Vendor / family</th>
                <th>Clock</th>
                <th>Rust target</th>
                <th>Last updated</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="setupTableBody"></tbody>
          </table>
        </div>
      </section>
    </main>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) value += chars.charAt(Math.floor(Math.random() * chars.length));
  return value;
}

module.exports = {
  registerMcuConfigurator,
  openMcuConfigurator,
  _test: {
    getManagedPaths,
    readMcuList,
    readMcuMetadata,
    readFamilyImplementationMetadata,
    loadMcuDetail,
    buildRegisterHeader,
    generateMcuConfiguration,
    getConfiguredSetupPaths,
    readConfiguredSetupRegistry,
    listConfiguredSetups,
    saveConfiguredSetup,
    removeConfiguredSetup,
    findCompatibleSdkRoot,
    resolveToolExecutable,
    buildToolEnvironment,
    normalizeRustCrateEntryPoint,
    readCargoPackageName,
    resolveBuiltProgramBinary
  }
};
