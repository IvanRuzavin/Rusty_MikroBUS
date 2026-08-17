'use strict';

const vscode = require('vscode');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { DatabaseClient } = require('./database');
const { ConfigurationPanel } = require('./configurationPanel');
const { createPaths, loadMcuDefinition, applyConfiguration, readManifest } = require('./configurationEngine');
const { runProcess, commandExists } = require('./process');

let dashboard;
let configPanel;
let statusBar;
let output;
let contextRef;

function workspaceFolder() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('Open a workspace folder before using Mikro Rust Configurator.');
  return folder;
}

function getRuntimeConfig() {
  const folder = workspaceFolder();
  const cfg = vscode.workspace.getConfiguration('mikroRust', folder.uri);
  let rootSetting = cfg.get('rootPath', '');
  let rootPath;
  if (!rootSetting) rootPath = folder.uri.fsPath;
  else rootPath = path.isAbsolute(rootSetting) ? rootSetting : path.resolve(folder.uri.fsPath, rootSetting);
  const values = {
    databasePath: cfg.get('databasePath', 'application/database/database_mikro_sdk_rust.db'),
    corePath: cfg.get('corePath', 'core'),
    sdkPath: cfg.get('sdkPath', 'sdk'),
    corePlatform: cfg.get('corePlatform', 'arm/stm32'),
    pythonPath: cfg.get('pythonPath', ''),
    installRustTargetOnConfigure: cfg.get('installRustTargetOnConfigure', true),
    openocdPath: cfg.get('openocdPath', 'openocd'),
    gdbPath: cfg.get('gdbPath', 'arm-none-eabi-gdb'),
    openocdInterfaceConfig: cfg.get('openocdInterfaceConfig', 'interface/stlink.cfg'),
    cortexDebugExtensionId: cfg.get('cortexDebugExtensionId', 'marus25.cortex-debug'),
  };
  return { folder, cfg, values, paths: createPaths(rootPath, values) };
}

async function state() {
  const runtime = getRuntimeConfig();
  return { paths: runtime.paths, manifest: await readManifest(runtime.paths) };
}

function database(runtime) {
  return new DatabaseClient(contextRef.extensionPath, runtime.values.pythonPath);
}

async function configureMcu(preferredName) {
  const runtime = getRuntimeConfig();
  const db = database(runtime);
  let name = preferredName;
  if (!name) {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Loading MCU database…' }, async () => {
      const mcus = await db.listMcus(runtime.paths.databasePath);
      const picked = await vscode.window.showQuickPick(
        mcus.map(mcu => ({ label: mcu, description: 'MCU' })),
        { title: 'Mikro Rust · Choose MCU', placeHolder: 'Type to search the MCU database', matchOnDescription: true }
      );
      name = picked?.label;
    });
  }
  if (!name) return;

  const mcu = await db.getMcuDetails(runtime.paths.databasePath, name);
  const { definition } = await loadMcuDefinition(runtime.paths, name);
  const manifest = await readManifest(runtime.paths);
  const compatibleManifest = manifest?.mcu?.name === name ? manifest : undefined;
  configPanel.show(mcu, definition, compatibleManifest);
}

async function reconfigure() {
  const runtime = getRuntimeConfig();
  const manifest = await readManifest(runtime.paths);
  if (!manifest?.mcu?.name) return configureMcu();
  return configureMcu(manifest.mcu.name);
}

async function applyFromPanel(payload) {
  const runtime = getRuntimeConfig();
  const manifest = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Configuring ${payload.mcu.name}`, cancellable: false },
    async progress => {
      progress.report({ message: 'Generating core, linker and HAL setup…' });
      return applyConfiguration({ paths: runtime.paths, ...payload });
    }
  );

  if (runtime.values.installRustTargetOnConfigure) {
    try {
      output.appendLine(`[rustup] target add ${manifest.mcu.target}`);
      const result = await runProcess('rustup', ['target', 'add', manifest.mcu.target], { cwd: runtime.paths.sdkRoot, allowNonZero: true });
      output.append(result.stdout); output.append(result.stderr);
      if (result.code !== 0) vscode.window.showWarningMessage(`Configuration succeeded, but rustup could not add ${manifest.mcu.target}. See “Mikro Rust” output.`);
    } catch (error) {
      output.appendLine(`[rustup] ${error.message}`);
      vscode.window.showWarningMessage(`Configuration succeeded, but rustup is unavailable: ${error.message}`);
    }
  }

  await updateUi();
  vscode.window.showInformationMessage(`${manifest.mcu.name} configured successfully for ${manifest.mcu.target}.`);
  return manifest;
}

async function runProcessTask(name, executable, args, cwd, problemMatchers = []) {
  const folder = workspaceFolder();
  const definition = { type: 'mikro-rust', task: name };
  const execution = new vscode.ProcessExecution(executable, args, { cwd });
  const task = new vscode.Task(definition, folder, name, 'Mikro Rust', execution, problemMatchers);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: false, showReuseMessage: true };
  return vscode.tasks.executeTask(task);
}

async function requireManifest() {
  const runtime = getRuntimeConfig();
  const manifest = await readManifest(runtime.paths);
  if (!manifest?.mcu?.name) {
    const choice = await vscode.window.showWarningMessage('Configure an MCU before running this command.', 'Configure MCU');
    if (choice === 'Configure MCU') await configureMcu();
    return undefined;
  }
  return { runtime, manifest };
}

async function buildProject() {
  const current = await requireManifest(); if (!current) return;
  return runProcessTask('Build', 'cargo', ['build'], current.runtime.paths.sdkRoot, ['$rustc']);
}

async function flashProject() {
  const current = await requireManifest(); if (!current) return;
  return runProcessTask('Flash', 'cargo', ['flash', '--chip', current.manifest.mcu.name, '--connect-under-reset'], current.runtime.paths.sdkRoot);
}

async function eraseMcu() {
  const current = await requireManifest(); if (!current) return;
  const answer = await vscode.window.showWarningMessage(`Erase all flash on ${current.manifest.mcu.name}?`, { modal: true }, 'Erase MCU');
  if (answer !== 'Erase MCU') return;
  return runProcessTask('Erase', 'probe-rs', ['erase', '--chip', current.manifest.mcu.name], current.runtime.paths.sdkRoot);
}

async function selectExample() {
  const runtime = getRuntimeConfig();
  const testsDir = path.join(runtime.paths.sdkRoot, 'tests');
  if (!fs.existsSync(testsDir)) throw new Error(`Examples directory not found: ${testsDir}`);
  const entries = (await fsp.readdir(testsDir, { withFileTypes: true })).filter(e => e.isFile()).map(e => e.name).sort();
  const picked = await vscode.window.showQuickPick(entries, { title: 'Mikro Rust · Choose Example', placeHolder: 'Copy an example to sdk/src/main.rs' });
  if (!picked) return;
  const src = path.join(testsDir, picked);
  const dst = path.join(runtime.paths.sdkRoot, 'src', 'main.rs');
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(src, dst);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(dst));
  await vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage(`${picked} configured as main.rs.`);
}

async function openGeneratedSetup() {
  const runtime = getRuntimeConfig();
  const setup = path.join(runtime.paths.sdkRoot, '.setup');
  if (!fs.existsSync(setup)) {
    vscode.window.showWarningMessage('No generated .setup directory exists yet.');
    return;
  }
  const manifest = path.join(setup, 'mikro-rust-config.json');
  if (fs.existsSync(manifest)) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(manifest));
    await vscode.window.showTextDocument(doc);
  } else {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(setup));
  }
}

function openocdTargetFor(mcuName) {
  // Preserve the convention used by the supplied application: first seven MCU characters + "x.cfg".
  return `target/${String(mcuName).slice(0, 7).toLowerCase()}x.cfg`;
}

async function debugMcu() {
  const current = await requireManifest(); if (!current) return;
  const { runtime, manifest } = current;
  const extension = vscode.extensions.getExtension(runtime.values.cortexDebugExtensionId);
  const executable = path.join(runtime.paths.sdkRoot, 'target', manifest.mcu.target, 'debug', 'mikrosdk');
  const openocdTarget = openocdTargetFor(manifest.mcu.name);

  if (extension) {
    const debugConfig = {
      type: 'cortex-debug',
      request: 'launch',
      name: `Mikro Rust: ${manifest.mcu.name}`,
      cwd: runtime.paths.sdkRoot,
      executable,
      servertype: 'openocd',
      configFiles: [runtime.values.openocdInterfaceConfig, openocdTarget],
      runToEntryPoint: 'main',
      showDevDebugOutput: 'none',
    };
    return vscode.debug.startDebugging(runtime.folder, debugConfig);
  }

  const choice = await vscode.window.showWarningMessage(
    `Graphical debugging requires ${runtime.values.cortexDebugExtensionId}. You can start OpenOCD in a VS Code terminal instead.`,
    'Start OpenOCD', 'Cancel'
  );
  if (choice !== 'Start OpenOCD') return;
  const terminal = vscode.window.createTerminal({ name: `OpenOCD · ${manifest.mcu.name}`, cwd: runtime.paths.sdkRoot });
  terminal.show();
  const quote = v => process.platform === 'win32' ? `"${String(v).replace(/"/g, '\\"')}"` : `'${String(v).replace(/'/g, `'\\''`)}'`;
  terminal.sendText(`${quote(runtime.values.openocdPath)} -f ${quote(runtime.values.openocdInterfaceConfig)} -c ${quote('transport select dapdirect_swd')} -f ${quote(openocdTarget)}`);
}

async function diagnostics() {
  const runtime = getRuntimeConfig();
  output.clear(); output.show(true);
  output.appendLine('Mikro Rust Configurator diagnostics');
  output.appendLine('===================================');
  output.appendLine(`Root:     ${runtime.paths.rootPath}`);
  output.appendLine(`Database: ${runtime.paths.databasePath}`);
  output.appendLine(`Core:     ${runtime.paths.corePlatformRoot}`);
  output.appendLine(`SDK:      ${runtime.paths.sdkRoot}\n`);

  const checks = [
    ['Root', fs.existsSync(runtime.paths.rootPath), runtime.paths.rootPath],
    ['Database', fs.existsSync(runtime.paths.databasePath), runtime.paths.databasePath],
    ['Core platform', fs.existsSync(runtime.paths.corePlatformRoot), runtime.paths.corePlatformRoot],
    ['SDK', fs.existsSync(runtime.paths.sdkRoot), runtime.paths.sdkRoot],
  ];
  for (const [name, ok, detail] of checks) output.appendLine(`${ok ? '✓' : '✗'} ${name}: ${detail}`);

  const tools = [
    ['rustc', 'rustc', ['--version']], ['cargo', 'cargo', ['--version']], ['rustup', 'rustup', ['--version']],
    ['cargo-flash', 'cargo', ['flash', '--version']], ['probe-rs', 'probe-rs', ['--version']],
    ['OpenOCD', runtime.values.openocdPath, ['--version']], ['GDB', runtime.values.gdbPath, ['--version']],
  ];
  output.appendLine('');
  let allOk = checks.every(c => c[1]);
  for (const [name, command, args] of tools) {
    const result = await commandExists(command, args); allOk = allOk && result.ok;
    output.appendLine(`${result.ok ? '✓' : '✗'} ${name}: ${result.detail}`);
  }

  try {
    const mcus = await database(runtime).listMcus(runtime.paths.databasePath);
    output.appendLine(`\n✓ MCU database query: ${mcus.length} MCU entries`);
  } catch (error) {
    allOk = false; output.appendLine(`\n✗ MCU database query: ${error.message}`);
  }
  vscode.window.showInformationMessage(allOk ? 'Mikro Rust diagnostics passed.' : 'Mikro Rust diagnostics found issues. See the output panel.');
}

async function updateUi() {
  let manifest;
  try { manifest = (await state()).manifest; } catch (_) { manifest = undefined; }
  if (statusBar) {
    if (manifest?.mcu?.name) {
      statusBar.text = `$(circuit-board) ${manifest.mcu.name}`;
      statusBar.tooltip = `Mikro Rust: ${manifest.mcu.target} · ${manifest.clockMhz} MHz`;
      statusBar.command = 'mikroRust.reconfigure';
      statusBar.show();
    } else {
      statusBar.text = '$(circuit-board) Configure Rust MCU';
      statusBar.tooltip = 'Mikro Rust Configurator';
      statusBar.command = 'mikroRust.configure';
      statusBar.show();
    }
  }
  await dashboard?.refresh();
}

function registerCommand(context, name, fn) {
  context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => {
    try { return await fn(...args); }
    catch (error) {
      output?.appendLine(`[${name}] ${error.stack || error.message}`);
      vscode.window.showErrorMessage(error.message || String(error));
    }
  }));
}

function activate(context) {
  contextRef = context;
  output = vscode.window.createOutputChannel('Mikro Rust');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 55);
  configPanel = new ConfigurationPanel(context.extensionUri, applyFromPanel);
  dashboard = new DashboardProvider(context.extensionUri, state);

  context.subscriptions.push(output, statusBar, vscode.window.registerWebviewViewProvider('mikroRust.dashboard', dashboard));
  registerCommand(context, 'mikroRust.configure', () => configureMcu());
  registerCommand(context, 'mikroRust.reconfigure', reconfigure);
  registerCommand(context, 'mikroRust.build', buildProject);
  registerCommand(context, 'mikroRust.flash', flashProject);
  registerCommand(context, 'mikroRust.erase', eraseMcu);
  registerCommand(context, 'mikroRust.debug', debugMcu);
  registerCommand(context, 'mikroRust.selectExample', selectExample);
  registerCommand(context, 'mikroRust.openGeneratedSetup', openGeneratedSetup);
  registerCommand(context, 'mikroRust.diagnostics', diagnostics);
  registerCommand(context, 'mikroRust.refreshDashboard', updateUi);

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('mikroRust')) updateUi();
  }));
  updateUi();
}

function deactivate() {}

module.exports = { activate, deactivate, openocdTargetFor };
