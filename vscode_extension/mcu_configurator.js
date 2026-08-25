const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const net = require('net');
const {
  normalizeConnectionProfile,
  normalizeDiscoveredDevice,
  discoverUsbCodegrips,
  programCodegrip,
  eraseCodegrip,
  prepareCodegripDebug,
  stopCodegripServer
} = require('./codegrip_backend');

let mcuPanel;
let outputChannel;
const debugServerProcesses = new Map();
const debugOwnedBreakpoints = new Map();
const debugVariableDumpTimers = new Map();
const debugVariableDumpInProgress = new Set();
let pendingDebugLaunch;
let pendingCodegripDebugLaunch;
const codegripDebugServers = new Map();

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
    bsp: path.join(root, 'bsp'),
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
    active: path.join(root, 'active.json'),
    workspaces: path.join(root, 'workspaces')
  };
}

function setupIdForMcu(mcuName) {
  return String(mcuName || 'mcu')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'mcu';
}

function setupWorkspaceRoot(context, setupId) {
  return path.join(getConfiguredSetupPaths(context).workspaces, setupIdForMcu(setupId));
}

function resolveSetupSdkRoot(context, setup) {
  const stored = String(setup?.sdkRoot || '').trim();
  if (stored) {
    return path.isAbsolute(stored)
      ? path.resolve(stored)
      : path.resolve(getConfiguredSetupPaths(context).root, stored);
  }
  return setupWorkspaceRoot(context, setup?.id || setup?.mcuName);
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
    : payload.selectionMode === 'board' && payload.boardUid
      ? registry.setups.find((setup) => setup.selectionMode === 'board' && setup.boardUid === payload.boardUid && setup.shieldUid === payload.shieldUid)
      : registry.setups.find((setup) => setup.selectionMode !== 'board' && String(setup.mcuName || '').toLowerCase() === String(result.mcuName || '').toLowerCase());
  const id = existing?.id || requestedId || (payload.selectionMode === 'board'
    ? setupIdForMcu(`${payload.boardUid}-${payload.shieldUid || 'no-shield'}`)
    : setupIdForMcu(result.mcuName));

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
    selectionMode: payload.selectionMode === 'board' ? 'board' : 'mcu',
    boardUid: payload.boardUid || undefined,
    boardName: payload.boardName || undefined,
    shieldUid: payload.shieldUid || undefined,
    shieldName: payload.shieldName || undefined,
    programmerUid: result.programmerUid || payload.programmerUid || 'SEGGER_JLINK',
    programmerName: result.programmerName || payload.programmerName || 'SEGGER J-Link',
    codegripConnection: result.programmerUid === 'MIKROE_CODEGRIP'
      ? normalizeDiscoveredDevice(result.codegripConnection || payload.codegripConnection)
      : undefined,
    sdkRoot: path.relative(getConfiguredSetupPaths(context).root, result.sdkRoot).split(path.sep).join('/'),
    artifactVersion: 1,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastBuiltAt: now
  };

  const index = registry.setups.findIndex((setup) => setup.id === id);
  if (index >= 0) registry.setups[index] = record;
  else registry.setups.push(record);
  writeConfiguredSetupRegistry(context, registry);
  setActiveSetupId(context, id);
  void vscode.commands.executeCommand('mikrobusRust.refreshSetupView');
  return { ...record, active: true };
}

function removeConfiguredSetup(context, id) {
  const registry = readConfiguredSetupRegistry(context);
  const setup = registry.setups.find((item) => item.id === id);
  if (!setup) throw new Error(`Configured setup '${id}' was not found.`);

  registry.setups = registry.setups.filter((item) => item.id !== id);
  writeConfiguredSetupRegistry(context, registry);

  if (getActiveSetupId(context) === id) {
    clearActiveSetupId(context);
  }

  const setupPaths = getConfiguredSetupPaths(context);
  const sdkRoot = resolveSetupSdkRoot(context, setup);
  if (isPathWithin(setupPaths.workspaces, sdkRoot)) {
    fs.rmSync(sdkRoot, { recursive: true, force: true });
  }

  void vscode.commands.executeCommand('mikrobusRust.refreshSetupView');
  return setup;
}

function createMikrobusDebugTracker(session, continueAfterConfiguration) {
  let configurationDoneRequestSeq;
  return {
    onWillReceiveMessage(message) {
      if (continueAfterConfiguration && message?.type === 'request' && message.command === 'configurationDone') {
        configurationDoneRequestSeq = message.seq;
      }
      if (
        message?.type === 'request' &&
        ['continue', 'next', 'stepIn', 'stepOut', 'restart', 'disconnect', 'terminate'].includes(message.command)
      ) {
        cancelScheduledVariableDump(session.id);
      }
    },
    onDidSendMessage(message) {
      if (
        continueAfterConfiguration &&
        configurationDoneRequestSeq !== undefined &&
        message?.type === 'response' &&
        message.request_seq === configurationDoneRequestSeq &&
        message.success !== false
      ) {
        configurationDoneRequestSeq = undefined;
        void continueFromResetToEntry(session);
      }
      if (message?.type === 'event' && message.event === 'stopped') {
        scheduleVariableDump(session, message.body?.threadId, message.body?.reason);
      }
    }
  };
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
    vscode.commands.registerCommand('mikrobusRust.dumpDebugVariables', async () => {
      await dumpDebugVariables();
    }),
    vscode.commands.registerCommand('mikrobusRust.eraseWorkspaceMcu', async () => {
      await runBoundWorkspaceAction(context, 'erase');
    }),
    vscode.debug.registerDebugAdapterDescriptorFactory('mikrobus-rust-debug', {
      async createDebugAdapterDescriptor(session) {
        const probeRsExecutable = resolveToolExecutable('probe-rs');
        const cwd = session.configuration.cwd || session.workspaceFolder?.uri?.fsPath || process.cwd();
        const channel = getOutputChannel();
        channel.appendLine(`Resolved probe-rs: ${probeRsExecutable}`);
        channel.appendLine(`probe-rs version: ${probeRsVersion(probeRsExecutable) || 'unknown'}`);

        const transport = process.platform === 'win32'
          ? vscode.workspace.getConfiguration('mikrobusRust').get('windowsDebugTransport', 'tcp')
          : 'tcp';
        if (process.platform === 'win32' && transport === 'stdio') {
          channel.appendLine('Starting probe-rs DAP through stdin/stdout transport (Windows opt-in).');
          return new vscode.DebugAdapterExecutable(
            probeRsExecutable,
            ['dap-server'],
            {
              cwd,
              env: buildToolEnvironment(probeRsExecutable)
            }
          );
        }

        const port = await findAvailableDebugPort();
        channel.appendLine(`Starting probe-rs DAP TCP server on 127.0.0.1:${port}${process.platform === 'win32' ? ' (Windows default)' : ''}.`);

        const child = childProcess.spawn(
          probeRsExecutable,
          ['dap-server', '--port', String(port)],
          {
            cwd,
            shell: false,
            windowsHide: true,
            env: buildToolEnvironment(probeRsExecutable)
          }
        );
        debugServerProcesses.set(session.id, child);
        child.stdout.on('data', (data) => channel.append(`[probe-rs] ${data.toString()}`));
        child.stderr.on('data', (data) => channel.append(`[probe-rs] ${data.toString()}`));
        child.on('spawn', () => channel.appendLine(`[probe-rs] DAP process started (PID ${child.pid}).`));
        child.on('error', (error) => {
          child.__mikrobusStartError = error;
          channel.appendLine(`[probe-rs] failed to start: ${error.message}`);
        });
        child.on('close', (code) => {
          channel.appendLine(`[probe-rs] DAP server exited with code ${code ?? -1}`);
          debugServerProcesses.delete(session.id);
        });

        try {
          await waitForDebugServer(port, child, 7000);
        } catch (error) {
          stopDebugServerProcess(session.id);
          throw error;
        }
        return new vscode.DebugAdapterServer(port, '127.0.0.1');
      }
    }),
    vscode.debug.onDidStartDebugSession((session) => {
      if (session.type === 'mikrobus-rust-debug' && pendingDebugLaunch) {
        const pending = pendingDebugLaunch;
        pendingDebugLaunch = undefined;
        if (pending.ownedBreakpoint) {
          debugOwnedBreakpoints.set(session.id, pending.ownedBreakpoint);
        }
        return;
      }
      if (
        session.type === 'cortex-debug' &&
        session.configuration.__mikrobusCodegrip === true &&
        pendingCodegripDebugLaunch &&
        session.configuration.__mikrobusCodegripToken === pendingCodegripDebugLaunch.token
      ) {
        const pending = pendingCodegripDebugLaunch;
        pendingCodegripDebugLaunch = undefined;
        codegripDebugServers.set(session.id, pending.runtime);
        void vscode.commands.executeCommand('setContext', 'mikrobusRust.codegripDebugActive', true);
      }
    }),
    vscode.debug.registerDebugAdapterTrackerFactory('mikrobus-rust-debug', {
      createDebugAdapterTracker(session) {
        return createMikrobusDebugTracker(session, true);
      }
    }),
    vscode.debug.registerDebugAdapterTrackerFactory('cortex-debug', {
      createDebugAdapterTracker(session) {
        if (session.configuration.__mikrobusCodegrip !== true) return undefined;
        return createMikrobusDebugTracker(session, false);
      }
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      stopDebugServerProcess(session.id);
      const codegripRuntime = codegripDebugServers.get(session.id);
      if (codegripRuntime) {
        codegripDebugServers.delete(session.id);
        void stopCodegripServer(codegripRuntime);
        if (codegripDebugServers.size === 0) {
          void vscode.commands.executeCommand('setContext', 'mikrobusRust.codegripDebugActive', false);
        }
      }
      cancelScheduledVariableDump(session.id);
      debugVariableDumpInProgress.delete(session.id);
      const breakpoint = debugOwnedBreakpoints.get(session.id);
      if (breakpoint) {
        vscode.debug.removeBreakpoints([breakpoint]);
        debugOwnedBreakpoints.delete(session.id);
      }
    }),
    {
      dispose() {
        for (const sessionId of [...debugServerProcesses.keys()]) stopDebugServerProcess(sessionId);
        for (const runtime of codegripDebugServers.values()) void stopCodegripServer(runtime);
        codegripDebugServers.clear();
        if (pendingCodegripDebugLaunch?.runtime) void stopCodegripServer(pendingCodegripDebugLaunch.runtime);
        pendingCodegripDebugLaunch = undefined;
      }
    }
  );
  void vscode.commands.executeCommand('setContext', 'mikrobusRust.codegripDebugActive', false);
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

function resolveCurrentWorkspaceTarget() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) {
    throw new Error('Open the folder containing the Rust main.rs you want to use first.');
  }

  const activeUri = vscode.window.activeTextEditor?.document?.uri;
  const workspaceFolder = activeUri?.scheme === 'file'
    ? (vscode.workspace.getWorkspaceFolder(activeUri) || folders[0])
    : folders[0];
  const openedRoot = workspaceFolder.uri.fsPath;
  const cargoToml = path.join(openedRoot, 'Cargo.toml');
  return {
    workspaceFolder,
    openedRoot,
    cargoToml,
    hasCargoToml: fs.existsSync(cargoToml)
  };
}

function getCurrentProjectState() {
  try {
    const workspace = resolveCurrentWorkspaceTarget();
    return {
      available: true,
      workspaceName: workspace.workspaceFolder.name,
      openedRoot: workspace.openedRoot,
      cargoToml: workspace.cargoToml,
      hasCargoToml: workspace.hasCargoToml,
      note: workspace.hasCargoToml
        ? 'Ready to apply a configured setup.'
        : 'Open a project that has Cargo.toml in the workspace root before applying a setup.'
    };
  } catch (error) {
    return {
      available: false,
      hasCargoToml: false,
      note: error?.message || String(error)
    };
  }
}

function getSetupDashboardState(context) {
  return {
    setups: listConfiguredSetups(context),
    project: getCurrentProjectState(),
    workspace: serializeWorkspaceBinding(readWorkspaceBinding())
  };
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
  if (cargoManifest.startsWith('..') || path.isAbsolute(cargoManifest)) {
    cargoManifest = path.join(sdkRoot, 'Cargo.toml');
  }
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
  const sdkRoot = path.resolve(generationResult.sdkRoot);

  const binding = {
    version: 1,
    setupId: setup.id,
    mcuName: setup.mcuName,
    clockMhz: setup.clockMhz,
    target: setup.target,
    selectionMode: setup.selectionMode || 'mcu',
    boardUid: setup.boardUid,
    boardName: setup.boardName,
    shieldUid: setup.shieldUid,
    shieldName: setup.shieldName,
    programmerUid: setup.programmerUid,
    programmerName: setup.programmerName,
    sdkRoot,
    configuredAt: new Date().toISOString(),
    setupRoot: path.resolve(generationResult.setupRoot)
  };
  fs.writeFileSync(bindingPath, JSON.stringify(binding, null, 2) + '\n', 'utf8');
  updateWorkspaceRustAnalyzer(workspace.workspaceFolder, sdkRoot, setup.target);
  void updateWorkspaceContext();
  void vscode.commands.executeCommand('mikrobusRust.refreshSetupView');
  return { ...binding, sdkRoot, bindingPath, workspaceFolder: workspace.workspaceFolder };
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
  const workspace = resolveCurrentWorkspaceTarget();
  if (!workspace.hasCargoToml) {
    throw new Error(`Cannot apply a setup because Cargo.toml is not present in the project root: ${workspace.openedRoot}`);
  }
  const result = await ensurePortableSetupWorkspace(context, setup);

  let generatedMikrobus;
  if (shouldGenerateWorkspaceMikrobus(setup)) {
    generatedMikrobus = generateWorkspaceMikrobusFile(context, workspace, setup);
  }
  const binding = writeWorkspaceBinding(workspace, setup, result);
  const mikrobusMessage = generatedMikrobus
    ? ` Generated ${generatedMikrobus}.`
    : setup.selectionMode === 'board' && !setup.shieldUid
      ? ' No shield is selected, so mikrobus.rs was not generated.'
      : '';
  vscode.window.showInformationMessage(
    `${setup.mcuName} (${setup.clockMhz} MHz) is now applied to ${workspace.openedRoot}. The project does not need its own SDK tree.${mikrobusMessage}`
  );

  if (mcuPanel) {
    void mcuPanel.webview.postMessage({
      type: 'workspaceBindingChanged',
      workspace: serializeWorkspaceBinding(binding),
      setups: listConfiguredSetups(context)
    });
  }
  return binding;
}

function shouldGenerateWorkspaceMikrobus(setup) {
  return setup?.selectionMode === 'board' && Boolean(setup.boardUid) && Boolean(setup.shieldUid);
}

function readBoardShieldBsp(databasePath, boardUid, shieldUid) {
  return withDatabase(databasePath, (db) => {
    const row = db.prepare(`
      SELECT Board.BSP_PATH AS boardBspPath, Shield.BSP_PATH AS shieldBspPath,
             Board.NAME AS boardName, Shield.NAME AS shieldName
      FROM BoardToShield
      JOIN Board ON Board.UID = BoardToShield.BOARD_UID
      JOIN Shield ON Shield.UID = BoardToShield.SHIELD_UID
      WHERE Board.UID = ? AND Shield.UID = ?
      LIMIT 1
    `).get(boardUid, shieldUid);
    if (!row) throw new Error(`The selected board/shield relationship is no longer present in the Rust database.`);
    return normalizeSqlRow(row);
  });
}

function resolveBoardPin(boardConfig, reference) {
  const match = String(reference || '').match(/^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/);
  if (!match) return undefined;
  return boardConfig?.headers?.[match[1]]?.[match[2]] || undefined;
}

function buildMikrobusRust(boardConfig, shieldConfig, boardName, shieldName) {
  const lines = [
    `//! Generated MikroBUS mapping for ${boardName} with ${shieldName}.`,
    '//! Generated by MikroBUS Rust Tools. Re-apply the setup to regenerate this file.',
    '',
    '#![allow(dead_code)]',
    '',
    'use drv_name::*;',
    ''
  ];
  const sockets = Object.entries(shieldConfig?.mikrobus || {}).sort(([left], [right]) => Number(left) - Number(right));
  for (const [socket, signals] of sockets) {
    lines.push(`// mikroBUS ${socket}`);
    for (const [signal, reference] of Object.entries(signals)) {
      const pin = resolveBoardPin(boardConfig, reference);
      if (pin) lines.push(`pub const MIKROBUS_${socket}_${signal}: pin_name_t = ${pin};`);
      else lines.push(`// MIKROBUS_${socket}_${signal} is not routed (${reference}).`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function findWorkspaceMainRust(workspace) {
  const candidates = [
    path.join(workspace.openedRoot, 'main.rs'),
    path.join(workspace.openedRoot, 'src', 'main.rs')
  ];
  const active = vscode.window.activeTextEditor?.document?.uri?.fsPath;
  if (active && path.basename(active).toLowerCase() === 'main.rs' && isPathWithin(workspace.openedRoot, active)) {
    candidates.unshift(active);
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function generateWorkspaceMikrobusFile(context, workspace, setup) {
  const paths = getManagedPaths(context);
  validateDatabaseSchema(paths.database);
  const bsp = readBoardShieldBsp(paths.database, setup.boardUid, setup.shieldUid);
  const boardPath = resolveManagedBspFile(paths, bsp.boardBspPath);
  const shieldPath = resolveManagedBspFile(paths, bsp.shieldBspPath);
  const mainRust = findWorkspaceMainRust(workspace);
  if (!mainRust) throw new Error('The board setup was applied, but main.rs was not found in the project root or src directory.');
  const boardConfig = JSON.parse(readRequired(boardPath));
  const shieldConfig = JSON.parse(readRequired(shieldPath));
  const destination = path.join(path.dirname(mainRust), 'mikrobus.rs');
  fs.writeFileSync(destination, buildMikrobusRust(boardConfig, shieldConfig, bsp.boardName, bsp.shieldName), 'utf8');
  return path.relative(workspace.openedRoot, destination).split(path.sep).join('/');
}

function resolveManagedBspFile(paths, configuredPath) {
  const portablePath = String(configuredPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!portablePath) throw new Error('The Rust database contains an empty BSP path.');

  // Database paths are stored as bsp/boards/... and bsp/shields/.... The
  // independently managed package itself is installed at <managed root>/bsp.
  const packageRelativePath = portablePath.toLowerCase().startsWith('bsp/')
    ? portablePath.slice(4)
    : portablePath;
  const resolved = path.resolve(paths.bsp, packageRelativePath);
  if (!isPathWithin(paths.bsp, resolved)) {
    throw new Error(`Refusing to read a BSP file outside the managed BSP package: ${configuredPath}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Required BSP file was not found: ${resolved}. Update the Board Support Package in Development Environment.`);
  }
  return resolved;
}

function serializeWorkspaceBinding(binding) {
  if (!binding) return undefined;
  return {
    setupId: binding.setupId,
    mcuName: binding.mcuName,
    clockMhz: binding.clockMhz,
    target: binding.target,
    selectionMode: binding.selectionMode,
    boardUid: binding.boardUid,
    boardName: binding.boardName,
    shieldUid: binding.shieldUid,
    shieldName: binding.shieldName,
    programmerUid: binding.programmerUid,
    programmerName: binding.programmerName,
    sdkRoot: binding.sdkRoot,
    bindingPath: binding.bindingPath,
    workspaceName: binding.workspaceFolder?.name,
    openedRoot: binding.workspaceFolder?.uri?.fsPath
  };
}

function requireWorkspaceBinding(context) {
  const binding = readWorkspaceBinding();
  if (!binding) {
    throw new Error('No MCU setup is bound to the current workspace. Open Configured setups and choose “Apply to workspace”.');
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
  if (!binding.workspaceFolder || !isPathWithin(binding.workspaceFolder.uri.fsPath, source)) {
    throw new Error(`The active Rust file is outside the workspace to which this setup is applied: ${binding.workspaceFolder?.uri?.fsPath || ''}`);
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

function isCodegripProgrammer(setup) {
  return /codegrip/i.test(`${setup?.programmerUid || ''} ${setup?.programmerName || ''}`);
}

function resolveCodegripExecutable() {
  const executableName = executableFileName('CodegripGdbServer');
  const configured = configuredToolPath('codegripServerPath');
  if (configured) {
    const candidate = fs.existsSync(configured) && fs.statSync(configured).isDirectory()
      ? path.join(configured, executableName)
      : configured;
    if (!isExecutableFile(candidate)) {
      throw new Error(`Configured CodegripGdbServer was not found or is not executable: ${candidate}`);
    }
    return candidate;
  }

  const fromPath = findExecutableOnPath('CodegripGdbServer');
  if (fromPath) return fromPath;

  const codegripPackageRoot = path.join(
    os.homedir(), '.MIKROE', 'NECTOStudio7', 'packages', 'programmers', 'codegrip'
  );
  const nectoCandidate = process.platform === 'win32'
    ? path.join(codegripPackageRoot, 'apps', 'CodegripGdbServer.exe')
    : process.platform === 'darwin'
      ? path.join(codegripPackageRoot, 'apps', 'CodegripGdbServer.app', 'Contents', 'MacOS', 'CodegripGdbServer')
      : path.join(codegripPackageRoot, 'apps', 'bin', 'CodegripGdbServer');
  if (isExecutableFile(nectoCandidate)) return nectoCandidate;

  throw new Error(
    `CodegripGdbServer was not found. Set mikrobusRust.codegripServerPath to the executable or its directory. ` +
    `The detected NECTO location was ${nectoCandidate}.`
  );
}

function inferCodegripPackageRoot(serverExecutable) {
  let current = path.resolve(path.dirname(serverExecutable));
  for (let depth = 0; depth < 8; depth += 1) {
    if (path.basename(current).toLowerCase() === 'codegrip') return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function resolveCodegripPacksPath(serverExecutable) {
  const configured = configuredToolPath('codegripPacksPath');
  const inferredRoot = inferCodegripPackageRoot(serverExecutable);
  const candidates = [
    configured,
    inferredRoot ? path.join(inferredRoot, 'packs') : undefined,
    path.join(os.homedir(), '.MIKROE', 'NECTOStudio7', 'packages', 'programmers', 'codegrip', 'packs')
  ].filter(Boolean);
  const found = candidates.find((candidate) => {
    try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
  });
  if (found) return found;
  throw new Error(
    `CODEGRIP packs were not found. Set mikrobusRust.codegripPacksPath to the packs directory. ` +
    `Checked: ${candidates.join(', ')}`
  );
}

function codegripOperationOptions(setup, channel) {
  const executable = resolveCodegripExecutable();
  const packsPath = resolveCodegripPacksPath(executable);
  const discovered = normalizeDiscoveredDevice(setup?.codegripConnection);
  if (!discovered) {
    throw new Error(
      'This CODEGRIP setup has no discovered USB connection. Reopen Hardware Configuration, select CODEGRIP, ' +
      'choose Find USB CODEGRIP, and rebuild the setup.'
    );
  }
  const profile = normalizeConnectionProfile(discovered);
  channel.appendLine(`CODEGRIP USB device: ${discovered.deviceName} (${discovered.serialNumber})`);
  channel.appendLine(`Programmer profile: ${setup.programmerName || 'MIKROE CODEGRIP'} (${setup.programmerUid || 'MIKROE_CODEGRIP'})`);
  return {
    executable,
    packsPath,
    mcu: setup.mcuName,
    profile,
    eraseCommand: String(vscode.workspace.getConfiguration('mikrobusRust').get('codegripEraseCommand', 'erase') || 'erase').trim(),
    channel
  };
}

function codegripDiscoveryOptions(mcuName, channel) {
  const executable = resolveCodegripExecutable();
  return {
    executable,
    packsPath: resolveCodegripPacksPath(executable),
    mcu: mcuName,
    channel,
    commandTimeoutMs: 8000
  };
}

function resolveArmGccExecutable(context, toolName) {
  const executableName = executableFileName(toolName);
  const configured = configuredToolPath('armGccBinPath');
  if (configured) {
    let candidate = path.join(configured, executableName);
    if (fs.existsSync(configured) && fs.statSync(configured).isFile()) {
      candidate = path.basename(configured).toLowerCase() === executableName.toLowerCase()
        ? configured
        : path.join(path.dirname(configured), executableName);
    }
    if (!isExecutableFile(candidate)) {
      throw new Error(`Configured ARM GCC tool was not found or is not executable: ${candidate}`);
    }
    return candidate;
  }

  const fromPath = findExecutableOnPath(toolName);
  if (fromPath) return fromPath;

  const runnerRoot = path.join(getManagedRoot(context), 'runner');
  let directories = [];
  try {
    directories = fs.readdirSync(runnerRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('xpack-arm-none-eabi-gcc-'))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left));
  } catch {
    // Development Environment may not have installed ARM GCC yet.
  }
  for (const directory of directories) {
    const candidate = path.join(runnerRoot, directory, 'bin', executableName);
    if (isExecutableFile(candidate)) return candidate;
  }

  throw new Error(
    `${toolName} was not found. Install ARM GCC in Development Environment, add it to PATH, or set mikrobusRust.armGccBinPath to its bin directory.`
  );
}

async function withCodegripHex(context, programBinary, channel, action) {
  const objcopy = resolveArmGccExecutable(context, 'arm-none-eabi-objcopy');
  const hexFile = path.join(
    os.tmpdir(),
    `mikrobus-codegrip-${process.pid}-${Date.now()}-${path.basename(programBinary).replace(/[^a-z0-9_.-]+/gi, '-')}.hex`
  );
  channel.appendLine(`Resolved ARM objcopy: ${objcopy}`);
  const code = await runStreaming(objcopy, ['-O', 'ihex', programBinary, hexFile], path.dirname(programBinary), channel);
  if (code !== 0) throw new Error(`arm-none-eabi-objcopy failed with exit code ${code}. See the MikroBUS Rust output.`);
  try {
    return await action(hexFile);
  } finally {
    fs.rmSync(hexFile, { force: true });
  }
}

async function flashElfWithCodegrip(context, setup, programBinary, channel) {
  const options = codegripOperationOptions(setup, channel);
  await withCodegripHex(context, programBinary, channel, async (hexFile) => {
    await programCodegrip({ ...options, hexFile, debugEnable: false });
  });
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function findAvailableDebugPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('Could not allocate a local DAP TCP port.'));
        else resolve(port);
      });
    });
  });
}

async function waitForDebugServer(port, child, timeoutMs) {
  // Do not probe the DAP port by opening a socket here: older probe-rs
  // versions accept a single DAP client, so a readiness connection can steal
  // the session from VS Code. Give the child a short startup window instead
  // and fail early if it exits.
  const startupWindow = Math.min(timeoutMs, process.platform === 'win32' ? 1200 : 500);
  const startedAt = Date.now();
  while (Date.now() - startedAt < startupWindow) {
    if (child.__mikrobusStartError) {
      throw new Error(`probe-rs dap-server could not be started: ${child.__mikrobusStartError.message}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`probe-rs dap-server exited before VS Code could connect (exit code ${child.exitCode}).`);
    }
    await delay(50);
  }
  if (child.exitCode !== null) {
    throw new Error(`probe-rs dap-server exited before VS Code could connect (exit code ${child.exitCode}).`);
  }
}

function probeRsVersion(executable) {
  try {
    const result = childProcess.spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 5000,
      env: buildToolEnvironment(executable)
    });
    return String(result.stdout || result.stderr || '').trim();
  } catch {
    return '';
  }
}

function stopDebugServerProcess(sessionId) {
  const child = debugServerProcesses.get(sessionId);
  if (!child) return;
  debugServerProcesses.delete(sessionId);
  try {
    if (!child.killed) child.kill();
  } catch {
    // The process may already be gone.
  }
}

function activeMikrobusDebugSession() {
  const session = vscode.debug.activeDebugSession;
  const isProbeRs = session?.type === 'mikrobus-rust-debug';
  const isCodegrip = session?.type === 'cortex-debug' && session.configuration.__mikrobusCodegrip === true;
  if (!session || (!isProbeRs && !isCodegrip)) {
    throw new Error('No active MikroBUS Rust debug session. Start debugging a Rust file first.');
  }
  return session;
}

async function activeDebugThreadId(session) {
  const response = await session.customRequest('threads');
  const threadId = response?.threads?.[0]?.id;
  if (threadId === undefined) {
    throw new Error('The debugger did not report an active target thread. Pause at a source line and try again.');
  }
  return threadId;
}

function boundedIntegerSetting(name, fallback, minimum, maximum) {
  const configured = Number(vscode.workspace.getConfiguration('mikrobusRust').get(name, fallback));
  if (!Number.isFinite(configured)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(configured)));
}

function variableDumpSettings() {
  const configuration = vscode.workspace.getConfiguration('mikrobusRust');
  return {
    enabled: configuration.get('dumpVariablesOnStop', true),
    maxDepth: boundedIntegerSetting('variableDumpMaxDepth', 5, 0, 16),
    maxEntries: boundedIntegerSetting('variableDumpMaxEntries', 5000, 100, 20000),
    maxValueLength: boundedIntegerSetting('variableDumpMaxValueLength', 512, 64, 8192)
  };
}

function cancelScheduledVariableDump(sessionId) {
  const timer = debugVariableDumpTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  debugVariableDumpTimers.delete(sessionId);
}

function scheduleVariableDump(session, threadId, reason) {
  if (!variableDumpSettings().enabled) return;
  cancelScheduledVariableDump(session.id);
  const timer = setTimeout(() => {
    debugVariableDumpTimers.delete(session.id);
    void dumpDebugVariablesForSession(session, threadId, reason).catch((error) => {
      const detail = error?.message || String(error);
      getOutputChannel().appendLine(`Automatic variable dump was unavailable: ${detail}`);
    });
  }, 600);
  debugVariableDumpTimers.set(session.id, timer);
}

function sanitizeDebugText(value, maxLength) {
  const compact = String(value ?? '').replace(/\r?\n/g, '\\n').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}

function isExcludedDebugScope(scope) {
  const name = String(scope?.name || '');
  return scope?.presentationHint === 'registers' || /register|peripheral/i.test(name);
}

function isGlobalDebugScope(scope) {
  return /static|global/i.test(String(scope?.name || ''));
}

function formatDebugVariable(variable, depth, maxValueLength) {
  const indent = '  '.repeat(depth + 1);
  const name = sanitizeDebugText(variable?.name || '<unnamed>', maxValueLength);
  const type = sanitizeDebugText(variable?.type || '', maxValueLength);
  const value = sanitizeDebugText(variable?.value || '<not available>', maxValueLength);
  return `${indent}${name}${type ? `: ${type}` : ''} = ${value}`;
}

async function expandDebugVariables(session, variablesReference, depth, state) {
  if (!variablesReference || state.count >= state.settings.maxEntries) {
    if (state.count >= state.settings.maxEntries) state.truncated = true;
    return;
  }
  if (state.seenReferences.has(variablesReference)) {
    state.lines.push(`${'  '.repeat(depth + 1)}<already expanded>`);
    return;
  }
  state.seenReferences.add(variablesReference);

  let variables;
  try {
    const remaining = state.settings.maxEntries - state.count;
    const response = await session.customRequest('variables', {
      variablesReference,
      start: 0,
      count: remaining
    });
    variables = Array.isArray(response?.variables) ? response.variables : [];
  } catch (error) {
    state.lines.push(`${'  '.repeat(depth + 1)}<unable to expand: ${sanitizeDebugText(error?.message || error, state.settings.maxValueLength)}>`);
    return;
  }

  for (const variable of variables) {
    if (state.count >= state.settings.maxEntries) {
      state.truncated = true;
      break;
    }
    state.lines.push(formatDebugVariable(variable, depth, state.settings.maxValueLength));
    state.count += 1;

    const childReference = Number(variable?.variablesReference || 0);
    if (!childReference) continue;
    if (depth >= state.settings.maxDepth) {
      state.lines.push(`${'  '.repeat(depth + 2)}<max depth reached>`);
      continue;
    }
    await expandDebugVariables(session, childReference, depth + 1, state);
  }
}

function frameDescription(frame, index, maxValueLength) {
  const name = sanitizeDebugText(frame?.name || '<anonymous>', maxValueLength);
  const source = frame?.source?.path || frame?.source?.name;
  const location = source
    ? ` @ ${sanitizeDebugText(source, maxValueLength)}${frame?.line ? `:${frame.line}` : ''}`
    : '';
  return `Frame ${index}: ${name}${location}`;
}

function appendVariableDump(session, text) {
  if (vscode.debug.activeDebugSession?.id === session.id && vscode.debug.activeDebugConsole) {
    vscode.debug.activeDebugConsole.appendLine(text);
    return;
  }
  getOutputChannel().appendLine(text);
}

async function dumpDebugVariablesForSession(session, requestedThreadId, reason = 'manual') {
  if (debugVariableDumpInProgress.has(session.id)) return;
  debugVariableDumpInProgress.add(session.id);
  try {
    const settings = variableDumpSettings();
    const threadId = requestedThreadId ?? await activeDebugThreadId(session);
    const stackResponse = await session.customRequest('stackTrace', {
      threadId,
      startFrame: 0,
      levels: 256
    });
    const frames = Array.isArray(stackResponse?.stackFrames) ? stackResponse.stackFrames : [];
    if (!frames.length) {
      throw new Error('The debugger did not expose a stack frame. Pause at a Rust source line and try again.');
    }

    const state = {
      settings,
      lines: [`\n=== MikroBUS Rust variables (${reason || 'stopped'}) ===`],
      count: 0,
      truncated: false,
      seenReferences: new Set()
    };
    let includedScopes = 0;

    for (let frameIndex = 0; frameIndex < frames.length && state.count < settings.maxEntries; frameIndex += 1) {
      const frame = frames[frameIndex];
      let scopesResponse;
      try {
        scopesResponse = await session.customRequest('scopes', { frameId: frame.id });
      } catch (error) {
        state.lines.push(frameDescription(frame, frameIndex, settings.maxValueLength));
        state.lines.push(`  <unable to read scopes: ${sanitizeDebugText(error?.message || error, settings.maxValueLength)}>`);
        continue;
      }
      const scopes = (Array.isArray(scopesResponse?.scopes) ? scopesResponse.scopes : [])
        .filter((scope) => !isExcludedDebugScope(scope))
        .filter((scope) => frameIndex === 0 || !isGlobalDebugScope(scope));
      if (!scopes.length) continue;

      state.lines.push(frameDescription(frame, frameIndex, settings.maxValueLength));
      for (const scope of scopes) {
        if (state.count >= settings.maxEntries) {
          state.truncated = true;
          break;
        }
        includedScopes += 1;
        state.lines.push(`  [${sanitizeDebugText(scope.name || 'Variables', settings.maxValueLength)}]`);
        await expandDebugVariables(session, Number(scope.variablesReference || 0), 0, state);
      }
    }

    if (!includedScopes) {
      state.lines.push('[No local, static, or global variable scopes were exposed at this stop.]');
    } else if (!state.count) {
      state.lines.push('[The exposed variable scopes are empty at this stop.]');
    }
    if (state.truncated || state.count >= settings.maxEntries) {
      state.lines.push(`[Variable dump truncated after ${settings.maxEntries} entries.]`);
    }
    state.lines.push(`=== End variables (${state.count} entries) ===`);
    appendVariableDump(session, state.lines.join('\n'));
  } finally {
    debugVariableDumpInProgress.delete(session.id);
  }
}

async function dumpDebugVariables() {
  const session = activeMikrobusDebugSession();
  const threadId = await activeDebugThreadId(session);
  await dumpDebugVariablesForSession(session, threadId, 'manual request');
}

function cargoTomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function debugBinName() {
  return 'mikrobus_debug_current';
}

function resolveBuiltNamedBinary(binding, setup, binName) {
  const candidates = [
    setup.target ? path.join(binding.sdkRoot, 'target', setup.target, 'debug', binName) : undefined,
    setup.target ? path.join(binding.sdkRoot, 'target', setup.target, 'debug', `${binName}.exe`) : undefined,
    path.join(binding.sdkRoot, 'target', 'debug', binName),
    path.join(binding.sdkRoot, 'target', 'debug', `${binName}.exe`)
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;
  throw new Error(`Cargo build completed, but the debug ELF was not found. Expected one of: ${candidates.join(', ')}`);
}

async function withTemporaryRustBinary(binding, source, binName, action) {
  const cargoToml = path.join(binding.sdkRoot, 'Cargo.toml');
  const original = readRequired(cargoToml);
  let manifestSource = path.relative(binding.sdkRoot, source);
  if (!manifestSource || (process.platform === 'win32' && path.parse(manifestSource).root)) {
    manifestSource = source;
  }
  manifestSource = manifestSource.split(path.sep).join('/');
  const startMarker = '# --- MIKROBUS RUST TEMP DEBUG TARGET BEGIN ---';
  const endMarker = '# --- MIKROBUS RUST TEMP DEBUG TARGET END ---';
  const markerPattern = new RegExp(`\\n?${startMarker.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}[\\s\\S]*?${endMarker.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\n?`, 'g');
  const cleanManifest = original.replace(markerPattern, '\n').trimEnd();
  const temporaryTarget = [
    '', '', startMarker,
    '[[bin]]',
    `name = ${cargoTomlString(binName)}`,
    `path = ${cargoTomlString(manifestSource)}`,
    endMarker, ''
  ].join('\n');

  fs.writeFileSync(cargoToml, `${cleanManifest}${temporaryTarget}`, 'utf8');
  try {
    return await action(binName);
  } finally {
    fs.writeFileSync(cargoToml, `${cleanManifest}\n`, 'utf8');
  }
}

async function buildCurrentRustSourceForDebug(binding, setup, source, channel) {
  const binName = debugBinName();
  return withTemporaryRustBinary(binding, source, binName, async () => {
    await executeChecked(channel, 'cargo', ['build', '--bin', binName], binding.sdkRoot);
    return { programBinary: resolveBuiltNamedBinary(binding, setup, binName), binName };
  });
}

async function buildCurrentRustSource(binding, setup, source, channel, flash) {
  const binName = 'mikrobus_current';
  return withTemporaryRustBinary(binding, source, binName, async () => {
    await executeChecked(channel, 'cargo', ['build', '--bin', binName], binding.sdkRoot);
    const programBinary = resolveBuiltNamedBinary(binding, setup, binName);
    if (flash) {
      await executeChecked(
        channel,
        'cargo',
        ['flash', '--bin', binName, '--chip', setup.mcuName, '--connect-under-reset'],
        binding.sdkRoot
      );
    }
    return { programBinary, binName };
  });
}

function findMainEntryLine(sourceText) {
  const lines = sourceText.split(/\r?\n/);
  let mainLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/\bfn\s+main\s*\(/.test(lines[i])) {
      mainLine = i;
      break;
    }
  }
  if (mainLine < 0) return 0;
  for (let i = mainLine + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    if (trimmed === '{' || trimmed === '}') continue;
    return i;
  }
  return mainLine;
}

function sameFilePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function ensureEntryBreakpoint(source) {
  const line = findMainEntryLine(readRequired(source));
  for (const breakpoint of vscode.debug.breakpoints) {
    if (!(breakpoint instanceof vscode.SourceBreakpoint)) continue;
    if (!sameFilePath(breakpoint.location.uri.fsPath, source)) continue;
    if (breakpoint.location.range.start.line === line) {
      return { breakpoint, line, owned: false };
    }
  }
  const location = new vscode.Location(vscode.Uri.file(source), new vscode.Position(line, 0));
  const breakpoint = new vscode.SourceBreakpoint(location, true);
  vscode.debug.addBreakpoints([breakpoint]);
  return { breakpoint, line, owned: true };
}

async function continueFromResetToEntry(session) {
  const channel = getOutputChannel();
  // haltAfterReset keeps the core safe while VS Code sends source breakpoints.
  // Once the adapter reports a stopped thread, continue so execution lands on
  // the temporary first-line breakpoint (or an earlier user breakpoint).
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const threadsResponse = await session.customRequest('threads');
      const threadId = threadsResponse?.threads?.[0]?.id;
      if (threadId !== undefined) {
        await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
        await delay(350);
        await session.customRequest('continue', { threadId });
        channel.appendLine('Debugger continued from reset; waiting for the first source breakpoint.');
        return;
      }
    } catch {
      // The launch/configuration handshake is still in progress.
    }
    await delay(100);
  }
  channel.appendLine('Debugger stayed halted after reset. Press Continue once to run to the first source breakpoint.');
}

async function debugCurrentRustFile(context) {
  const { binding, setup } = requireWorkspaceBinding(context);
  const channel = getOutputChannel();
  channel.show(true);
  channel.appendLine(`\n=== ${setup.mcuName} · ${setup.clockMhz} MHz · Debug current Rust file ===`);
  channel.appendLine(`Reusable setup: ${binding.sdkRoot}`);

  const source = getActiveRustSource(binding);
  const editor = vscode.window.activeTextEditor;
  if (editor) await editor.document.save();

  const { programBinary } = await buildCurrentRustSourceForDebug(binding, setup, source, channel);
  if (isCodegripProgrammer(setup)) {
    const cortexDebug = vscode.extensions.getExtension('marus25.cortex-debug');
    if (!cortexDebug) {
      throw new Error('CODEGRIP debugging requires the Cortex-Debug extension (marus25.cortex-debug). Install it and reload VS Code.');
    }
    await cortexDebug.activate();
    const gdbPath = resolveArmGccExecutable(context, 'arm-none-eabi-gdb');
    const options = codegripOperationOptions(setup, channel);
    channel.appendLine(`Debug source: ${source}`);
    channel.appendLine(`Debug ELF: ${programBinary}`);
    channel.appendLine(`Resolved ARM GDB: ${gdbPath}`);

    const runtime = await withCodegripHex(context, programBinary, channel, (hexFile) => (
      prepareCodegripDebug({ ...options, hexFile })
    ));
    const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    pendingCodegripDebugLaunch = { token, runtime };
    try {
      const started = await vscode.debug.startDebugging(binding.workspaceFolder, {
        type: 'cortex-debug',
        request: 'launch',
        name: `MikroBUS Rust CODEGRIP: ${setup.mcuName}`,
        servertype: 'external',
        gdbTarget: `127.0.0.1:${runtime.debugPort}`,
        executable: programBinary,
        gdbPath,
        cwd: binding.sdkRoot,
        device: setup.mcuName,
        interface: 'swd',
        overrideLaunchCommands: [
          'set mem inaccessible-by-default off',
          'tbreak main',
          'continue'
        ],
        showDevDebugOutput: 'none',
        __mikrobusCodegrip: true,
        __mikrobusCodegripToken: token
      });
      if (!started) throw new Error('VS Code did not start the CODEGRIP debug session.');
      return;
    } catch (error) {
      if (pendingCodegripDebugLaunch?.token === token) pendingCodegripDebugLaunch = undefined;
      await stopCodegripServer(runtime);
      throw error;
    }
  }

  const probeRsExecutable = resolveToolExecutable('probe-rs');
  const entry = ensureEntryBreakpoint(source);
  channel.appendLine(`Debug source: ${source}`);
  channel.appendLine(`Debug ELF: ${programBinary}`);
  channel.appendLine(`Resolved probe-rs: ${probeRsExecutable}`);
  channel.appendLine(`Programmer profile: ${setup.programmerName || 'SEGGER J-Link'} (${setup.programmerUid || 'SEGGER_JLINK'})`);
  channel.appendLine(`Entry breakpoint: ${path.basename(source)}:${entry.line + 1}`);

  pendingDebugLaunch = {
    source,
    ownedBreakpoint: entry.owned ? entry.breakpoint : undefined
  };

  const started = await vscode.debug.startDebugging(binding.workspaceFolder, {
    type: 'mikrobus-rust-debug',
    request: 'launch',
    name: `MikroBUS Rust: ${setup.mcuName}`,
    cwd: binding.sdkRoot,
    chip: setup.mcuName,
    wireProtocol: 'Swd',
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
  if (!started) {
    pendingDebugLaunch = undefined;
    if (entry.owned) vscode.debug.removeBreakpoints([entry.breakpoint]);
    throw new Error('VS Code did not start the probe-rs debug session.');
  }
}

async function runBoundWorkspaceAction(context, action) {
  const { binding, setup } = requireWorkspaceBinding(context);
  const useCodegrip = isCodegripProgrammer(setup);

  if (action === 'erase') {
    const confirmation = await vscode.window.showWarningMessage(
      `Erase all flash memory on ${setup.mcuName}?`,
      { modal: true, detail: `Project: ${binding.workspaceFolder?.uri?.fsPath || ''}\nReusable setup: ${binding.sdkRoot}\nMCU: ${setup.mcuName}\nProgrammer: ${setup.programmerName || setup.programmerUid}\n\nThis will erase the MCU flash through ${useCodegrip ? 'CODEGRIP' : 'probe-rs'}. The configured setup itself will not be removed.` },
      'Erase MCU'
    );
    if (confirmation !== 'Erase MCU') return;
  }

  const channel = getOutputChannel();
  channel.show(true);
  channel.appendLine(`\n=== ${setup.mcuName} · ${setup.clockMhz} MHz ===`);
  channel.appendLine(`Reusable setup: ${binding.sdkRoot}`);

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `MikroBUS Rust: ${action === 'erase' ? 'Erasing' : action === 'flash' ? 'Flashing' : 'Building'} ${setup.mcuName}...`,
    cancellable: false
  }, async () => {
    if (action === 'buildFlashCurrent' || action === 'flashCurrent') {
      const source = getActiveRustSource(binding);
      const editor = vscode.window.activeTextEditor;
      if (editor) await editor.document.save();
      const result = await buildCurrentRustSource(binding, setup, source, channel, !useCodegrip);
      if (useCodegrip) await flashElfWithCodegrip(context, setup, result.programBinary, channel);
      return;
    }
    if (action === 'buildCurrent') {
      const source = getActiveRustSource(binding);
      const editor = vscode.window.activeTextEditor;
      if (editor) await editor.document.save();
      await buildCurrentRustSource(binding, setup, source, channel, false);
      return;
    }
    if (action === 'build') {
      await executeChecked(channel, 'cargo', ['build'], binding.sdkRoot);
      return;
    }
    if (action === 'flash') {
      if (useCodegrip) {
        await executeChecked(channel, 'cargo', ['build'], binding.sdkRoot);
        await flashElfWithCodegrip(context, setup, resolveBuiltProgramBinary(binding, setup), channel);
      } else {
        await executeChecked(channel, 'cargo', ['flash', '--chip', setup.mcuName, '--connect-under-reset'], binding.sdkRoot);
      }
      return;
    }
    if (action === 'erase') {
      if (useCodegrip) {
        await eraseCodegrip(codegripOperationOptions(setup, channel));
      } else {
        await executeChecked(channel, 'probe-rs', ['erase', '--chip', setup.mcuName], binding.sdkRoot);
      }
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
    'MikroBUS Rust: Hardware Configuration',
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
  if (!fs.existsSync(paths.bsp)) missing.push('bsp');
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

  validateDatabaseSchema(paths.database);
  const mcus = readMcuList(paths.database);
  const boards = readBoardList(paths.database);
  const setups = listConfiguredSetups(context);
  void panel.webview.postMessage({
    type: 'mcuList',
    mcus,
    boards,
    setups,
    activeSetupId: getActiveSetupId(context),
    workspace: serializeWorkspaceBinding(readWorkspaceBinding()),
    project: getCurrentProjectState(),
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

  if (message.type === 'openEnvironment') {
    await vscode.commands.executeCommand('mikrobusRust.openEnvironmentSetup');
    return;
  }

  if (message.type === 'selectMcu' && typeof message.name === 'string') {
    const paths = getManagedPaths(context);
    validateDatabaseSchema(paths.database);
    const detail = loadMcuDetail(paths, message.name);
    const programmers = readProgrammersForDevice(paths.database, message.name);
    const setup = findConfiguredSetupForMcu(context, message.name);
    void panel.webview.postMessage({ type: 'mcuDetail', detail, programmers, setup: setup ? { ...setup, active: setup.id === getActiveSetupId(context) } : undefined });
    return;
  }

  if (message.type === 'selectBoard' && typeof message.uid === 'string') {
    const paths = getManagedPaths(context);
    const boardDetail = loadBoardDetail(paths, message.uid);
    const setup = listConfiguredSetups(context).find((item) => item.boardUid === message.uid);
    void panel.webview.postMessage({
      type: 'boardDetail',
      ...boardDetail,
      setup: setup ? { ...setup, active: setup.id === getActiveSetupId(context) } : undefined
    });
    return;
  }

  if (message.type === 'editSetup' && typeof message.id === 'string') {
    const setup = findConfiguredSetup(context, message.id);
    if (!setup) throw new Error(`Configured setup '${message.id}' was not found.`);
    const paths = getManagedPaths(context);
    if (setup.selectionMode === 'board' && setup.boardUid) {
      const boardDetail = loadBoardDetail(paths, setup.boardUid);
      void panel.webview.postMessage({ type: 'boardDetail', ...boardDetail, setup: { ...setup, active: setup.id === getActiveSetupId(context) } });
      return;
    }
    const detail = loadMcuDetail(paths, setup.mcuName);
    const programmers = readProgrammersForDevice(paths.database, setup.mcuName);
    void panel.webview.postMessage({ type: 'mcuDetail', detail, programmers, setup: { ...setup, active: setup.id === getActiveSetupId(context) } });
    return;
  }

  if (message.type === 'discoverCodegripUsb' && typeof message.mcuName === 'string') {
    const mcuName = message.mcuName.trim();
    const paths = getManagedPaths(context);
    validateDatabaseSchema(paths.database);
    const supported = readProgrammersForDevice(paths.database, mcuName)
      .some((programmer) => programmer.uid === 'MIKROE_CODEGRIP');
    if (!supported) throw new Error(`CODEGRIP is not configured as a supported programmer for ${mcuName}.`);
    const channel = getOutputChannel();
    channel.show(true);
    channel.appendLine(`\n=== ${mcuName} · Find USB CODEGRIP ===`);
    const discovery = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Searching for USB CODEGRIP devices...',
      cancellable: false
    }, () => discoverUsbCodegrips(codegripDiscoveryOptions(mcuName, channel)));
    let device = discovery.devices[0];
    if (discovery.devices.length > 1) {
      const choice = await vscode.window.showQuickPick(
        discovery.devices.map((candidate) => ({
          label: candidate.deviceName || 'CODEGRIP',
          description: candidate.serialNumber,
          detail: `USB · ${candidate.hwTokens}`,
          device: candidate
        })),
        { placeHolder: 'Select the USB CODEGRIP for this setup' }
      );
      device = choice?.device;
    }
    if (!device) {
      void panel.webview.postMessage({ type: 'codegripUsbDiscoveryCancelled' });
      return;
    }
    channel.appendLine(`Selected USB CODEGRIP: ${device.deviceName} (${device.serialNumber})`);
    void panel.webview.postMessage({
      type: 'codegripUsbDiscovered',
      device,
      discoveryCommand: discovery.command
    });
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
      return buildPortableSetupWorkspace(context, payload, progress);
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
      values: setup.values || {},
      selectionMode: setup.selectionMode || 'mcu',
      boardUid: setup.boardUid,
      boardName: setup.boardName,
      shieldUid: setup.shieldUid,
      shieldName: setup.shieldName,
      programmerUid: setup.programmerUid || 'SEGGER_JLINK',
      programmerName: setup.programmerName || 'SEGGER J-Link',
      codegripConnection: setup.codegripConnection
    };
    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Rebuilding MikroBUS Rust configuration for ${setup.mcuName}...`,
      cancellable: false
    }, async (progress) => buildPortableSetupWorkspace(context, payload, progress));
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

function validateDatabaseSchema(databasePath) {
  if (!fs.existsSync(databasePath)) {
    throw new Error(`Rust database was not found at the configured Development Environment path: ${databasePath}`);
  }
  const requiredTables = [
    'Family',
    'MCU',
    'Programmer',
    'Board',
    'Shield',
    'DeviceToProgrammer',
    'BoardToDevice',
    'BoardToShield'
  ];
  const available = withDatabase(databasePath, (db) => new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name))
  ));
  const missing = requiredTables.filter((table) => !available.has(table));
  if (missing.length > 0) {
    throw new Error(
      `The single Rust database at ${databasePath} is missing required table(s): ${missing.join(', ')}. ` +
      'Update that database file in Development Environment; the extension does not use a secondary database or schema file.'
    );
  }
}

function parseDatabaseJson(value) {
  try {
    return JSON.parse(String(value || '{}'));
  } catch {
    return {};
  }
}

function readBoardList(databasePath) {
  return withDatabase(databasePath, (db) => db.prepare(`
    SELECT
      Board.UID AS uid,
      Board.NAME AS name,
      Board.VENDOR AS vendor,
      Board.BSP_PATH AS bspPath,
      Board.CONFIG_JSON AS configJson,
      BoardToDevice.DEVICE_NAME AS mcuName
    FROM Board
    JOIN BoardToDevice ON BoardToDevice.BOARD_UID = Board.UID
    WHERE Board.ENABLED = 1 AND BoardToDevice.IS_DEFAULT = 1
    ORDER BY Board.NAME COLLATE NOCASE
  `).all().map((row) => {
    const normalized = normalizeSqlRow(row);
    return { ...normalized, config: parseDatabaseJson(normalized.configJson) };
  }));
}

function readProgrammersForDevice(databasePath, mcuName) {
  return withDatabase(databasePath, (db) => db.prepare(`
    SELECT
      Programmer.UID AS uid,
      Programmer.NAME AS name,
      Programmer.VENDOR AS vendor,
      Programmer.KIND AS kind,
      Programmer.TRANSPORT AS transport,
      Programmer.CONFIG_JSON AS configJson,
      DeviceToProgrammer.INTERFACE AS interface,
      DeviceToProgrammer.PRIORITY AS priority
    FROM DeviceToProgrammer
    JOIN Programmer ON Programmer.UID = DeviceToProgrammer.PROGRAMMER_UID
    WHERE DeviceToProgrammer.DEVICE_NAME = ? AND Programmer.ENABLED = 1
    ORDER BY DeviceToProgrammer.PRIORITY, Programmer.NAME COLLATE NOCASE
  `).all(mcuName).map((row) => {
    const normalized = normalizeSqlRow(row);
    return { ...normalized, config: parseDatabaseJson(normalized.configJson) };
  }));
}

function readShieldsForBoard(databasePath, boardUid) {
  return withDatabase(databasePath, (db) => db.prepare(`
    SELECT
      Shield.UID AS uid,
      Shield.NAME AS name,
      Shield.VENDOR AS vendor,
      Shield.BSP_PATH AS bspPath,
      Shield.MIKROBUS_COUNT AS mikrobusCount,
      BoardToShield.IS_DEFAULT AS isDefault,
      Shield.CONFIG_JSON AS configJson
    FROM BoardToShield
    JOIN Shield ON Shield.UID = BoardToShield.SHIELD_UID
    WHERE BoardToShield.BOARD_UID = ? AND Shield.ENABLED = 1
    ORDER BY BoardToShield.IS_DEFAULT DESC, Shield.NAME COLLATE NOCASE
  `).all(boardUid).map((row) => {
    const normalized = normalizeSqlRow(row);
    return { ...normalized, config: parseDatabaseJson(normalized.configJson) };
  }));
}

function loadBoardDetail(paths, boardUid) {
  validateDatabaseSchema(paths.database);
  const board = readBoardList(paths.database).find((item) => item.uid === boardUid);
  if (!board) throw new Error(`Board '${boardUid}' is not present in the Rust database.`);
  return {
    board,
    mcu: loadMcuDetail(paths, board.mcuName),
    shields: readShieldsForBoard(paths.database, boardUid),
    programmers: readProgrammersForDevice(paths.database, board.mcuName)
  };
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
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return 0;
  const trimmed = value.trim();
  if (/^0x[0-9a-f]+$/i.test(trimmed)) return Number.parseInt(trimmed.slice(2), 16);
  // MCU definition JSON stores register values as bare hexadecimal strings
  // (for example "01000000" for RCC_CR.PLLON), not decimal strings.
  if (/^[0-9a-f]+$/i.test(trimmed)) return Number.parseInt(trimmed, 16);
  return 0;
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

function portableSetupIsComplete(sdkRoot) {
  return [
    path.join(sdkRoot, 'Cargo.toml'),
    path.join(sdkRoot, '.cargo', 'config.toml'),
    path.join(sdkRoot, '.setup', 'core', 'Cargo.toml'),
    path.join(sdkRoot, '.setup', 'sdk', 'Cargo.toml'),
    path.join(sdkRoot, 'drv'),
    path.join(sdkRoot, 'hal'),
    path.join(sdkRoot, 'targets')
  ].every((required) => fs.existsSync(required));
}

function copySdkLayers(sourceSdkRoot, destinationSdkRoot) {
  const excludedRoots = new Set(['target', '.setup', '.git', '.vscode']);
  fs.cpSync(sourceSdkRoot, destinationSdkRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceSdkRoot, source);
      if (!relative) return true;
      const normalized = relative.split(path.sep).join('/');
      const rootName = normalized.split('/')[0];
      if (excludedRoots.has(rootName)) return false;
      if (normalized === '.cargo/config.toml') return false;
      if (normalized.startsWith('.setup.__mikrobus_')) return false;
      return true;
    }
  });
}

function replacePortableSetupDirectory(stagingRoot, targetRoot) {
  const backupRoot = `${targetRoot}.__mikrobus_backup`;
  fs.rmSync(backupRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
  let backedUp = false;
  try {
    if (fs.existsSync(targetRoot)) {
      fs.renameSync(targetRoot, backupRoot);
      backedUp = true;
    }
    fs.renameSync(stagingRoot, targetRoot);
    fs.rmSync(backupRoot, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(targetRoot) && backedUp && fs.existsSync(backupRoot)) {
      fs.renameSync(backupRoot, targetRoot);
    }
    throw error;
  }
}

function remapGeneratedResult(result, stagingRoot, targetRoot) {
  const remap = (value) => {
    if (!value || !isPathWithin(stagingRoot, value)) return value;
    return path.join(targetRoot, path.relative(stagingRoot, value));
  };
  return {
    ...result,
    sdkRoot: targetRoot,
    setupRoot: remap(result.setupRoot),
    coreHeader: remap(result.coreHeader),
    cargoConfig: remap(result.cargoConfig)
  };
}

function setupIdForPayload(context, payload) {
  const requested = String(payload.setupId || '').trim();
  if (requested) return requested;
  if (payload.selectionMode === 'board' && payload.boardUid) {
    const existing = listConfiguredSetups(context).find((setup) =>
      setup.selectionMode === 'board' && setup.boardUid === payload.boardUid && setup.shieldUid === payload.shieldUid
    );
    return existing?.id || setupIdForMcu(`${payload.boardUid}-${payload.shieldUid || 'no-shield'}`);
  }
  const existing = listConfiguredSetups(context).find((setup) =>
    setup.selectionMode !== 'board' && String(setup.mcuName || '').toLowerCase() === String(payload.mcuName || '').toLowerCase()
  );
  return existing?.id || setupIdForMcu(payload.mcuName);
}

async function buildPortableSetupWorkspace(context, payload, progress) {
  const managedPaths = getManagedPaths(context);
  const setupId = setupIdForPayload(context, payload);
  const targetRoot = setupWorkspaceRoot(context, setupId);
  const stagingRoot = `${targetRoot}.__mikrobus_staging`;

  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(stagingRoot), { recursive: true });
  try {
    progress.report({ message: 'Copying complete SDK layers into the reusable setup...' });
    copySdkLayers(managedPaths.sdk, stagingRoot);
    const generated = await generateMcuConfiguration(
      context,
      { ...payload, setupId },
      progress,
      { sdkRoot: stagingRoot }
    );
    progress.report({ message: 'Saving reusable SDK setup...' });
    replacePortableSetupDirectory(stagingRoot, targetRoot);
    return remapGeneratedResult(generated, stagingRoot, targetRoot);
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function ensurePortableSetupWorkspace(context, setup) {
  const sdkRoot = resolveSetupSdkRoot(context, setup);
  if (portableSetupIsComplete(sdkRoot)) {
    return {
      ...setup,
      sdkRoot,
      setupRoot: path.join(sdkRoot, '.setup'),
      coreHeader: path.join(sdkRoot, '.setup', 'core', 'src', 'core_header.rs'),
      cargoConfig: path.join(sdkRoot, '.cargo', 'config.toml')
    };
  }

  const payload = {
    setupId: setup.id,
    mcuName: setup.mcuName,
    clockMhz: setup.clockMhz,
    values: setup.values || {},
    selectionMode: setup.selectionMode || 'mcu',
    boardUid: setup.boardUid,
    boardName: setup.boardName,
    shieldUid: setup.shieldUid,
    shieldName: setup.shieldName,
    programmerUid: setup.programmerUid,
    programmerName: setup.programmerName,
    codegripConnection: setup.codegripConnection
  };
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Creating complete reusable setup for ${setup.mcuName}...`,
    cancellable: false
  }, async (progress) => buildPortableSetupWorkspace(context, payload, progress));
}

async function generateMcuConfiguration(context, payload, progress, options = {}) {
  const managedPaths = getManagedPaths(context);
  const paths = { ...managedPaths, sdk: options.sdkRoot ? path.resolve(options.sdkRoot) : managedPaths.sdk };
  const mcuName = String(payload.mcuName || '').trim();
  const clockMhz = Number.parseInt(String(payload.clockMhz || ''), 10);
  const selectedValues = payload.values && typeof payload.values === 'object' ? payload.values : {};

  if (!mcuName) throw new Error('Select an MCU before generating the configuration.');
  if (!Number.isInteger(clockMhz) || clockMhz <= 0) throw new Error('Clock must be a positive integer in MHz.');

  for (const required of [paths.database, paths.bsp, paths.sdk, paths.core]) {
    if (!fs.existsSync(required)) throw new Error(`Required managed package is missing: ${required}`);
  }

  validateDatabaseSchema(paths.database);
  progress.report({ message: 'Installing managed board and shield BSP configuration files...' });
  copyDirectoryRequired(paths.bsp, path.join(paths.sdk, 'bsp'));

  const metadata = readMcuMetadata(paths.database, mcuName);
  const programmerUid = String(payload.programmerUid || 'SEGGER_JLINK').trim();
  const programmers = readProgrammersForDevice(paths.database, mcuName);
  const selectedProgrammer = programmers.find((programmer) => programmer.uid === programmerUid);
  if (!selectedProgrammer) {
    throw new Error(`Select a supported programmer for ${mcuName} before generating the configuration.`);
  }
  const codegripConnection = selectedProgrammer.uid === 'MIKROE_CODEGRIP'
    ? normalizeDiscoveredDevice(payload.codegripConnection)
    : undefined;
  if (selectedProgrammer.uid === 'MIKROE_CODEGRIP' && !codegripConnection) {
    throw new Error('Find and select a USB CODEGRIP connection before building this configuration.');
  }
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
      selectionMode: payload.selectionMode === 'board' ? 'board' : 'mcu',
      boardUid: payload.boardUid || undefined,
      boardName: payload.boardName || undefined,
      shieldUid: payload.shieldUid || undefined,
      shieldName: payload.shieldName || undefined,
      programmerUid: selectedProgrammer.uid,
      programmerName: selectedProgrammer.name,
      codegripConnection,
      sdkRoot: paths.sdk,
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
  <title>MikroBUS Rust Hardware Configuration</title>
</head>
<body>
  <div id="app" class="app">
    <header class="topbar">
      <div>
        <div class="eyebrow">MIKROBUS RUST</div>
        <h1>Hardware Configuration</h1>
        <p>Configure a bare MCU or a board with an optional shield, then manage reusable Rust SDK setups.</p>
      </div>
      <div class="topActions">
        <button id="showSetups" class="secondary">Configured setups <span id="setupCount" class="buttonCount">0</span></button>
        <button id="refresh" class="secondary">Refresh database</button>
      </div>
    </header>

    <div id="missingState" class="missing hidden"></div>

    <main id="workspace" class="workspace hidden">
      <section id="startView" class="pageView selectionStart">
        <div class="viewHeader">
          <div>
            <div class="eyebrow">NEW CONFIGURATION</div>
            <h2>What do you want to configure?</h2>
            <p>Start from a bare MCU, or select a board and optionally add a compatible shield for MikroBUS mapping.</p>
          </div>
        </div>
        <div class="selectionCards">
          <button id="chooseMcuMode" class="selectionCard">
            <strong>MCU</strong>
            <span>Choose a supported device, configure clock/registers, and select a programmer.</span>
          </button>
          <button id="chooseBoardMode" class="selectionCard">
            <strong>Board</strong>
            <span>Choose a board, optionally add a shield, then configure its compatible MCU and programmer.</span>
          </button>
        </div>
      </section>

      <section id="catalogView" class="pageView hidden">
        <div class="viewNav managerNav"><button id="backToStartFromMcus" class="secondary">← MCU or Board</button></div>
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

      <section id="boardCatalogView" class="pageView hidden">
        <div class="viewNav managerNav"><button id="backToStartFromBoards" class="secondary">← MCU or Board</button></div>
        <div class="viewHeader">
          <div>
            <div class="eyebrow">AVAILABLE BOARDS</div>
            <h2>Board catalog</h2>
            <p>Select a board to choose its optional shield, clock settings, and programmer.</p>
          </div>
          <div class="resultCount"><strong id="boardCount">0</strong><span>Boards</span></div>
        </div>
        <div class="tableShell">
          <table class="dataTable boardTable">
            <thead><tr><th>Board</th><th>Vendor</th><th>Rust compatibility MCU</th><th>Status</th></tr></thead>
            <tbody id="boardTableBody"></tbody>
          </table>
        </div>
      </section>

      <section id="loadingView" class="loadingView hidden">
        <div class="chipIcon">µ</div>
        <h2 id="loadingText">Loading MCU...</h2>
      </section>

      <section id="configView" class="pageView hidden">
        <div class="viewNav">
          <button id="backToMcus" class="secondary">← Selection</button>
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

        <section id="boardSelectionCard" class="clockSection card hidden">
          <div>
            <h3 id="selectedBoardName">Board and optional shield</h3>
            <p id="selectedBoardDevice"></p>
          </div>
          <label class="clockInput">Shield (optional)<select id="shieldSelect"></select></label>
        </section>

        <section>
          <div class="sectionHeading">
            <div><h3>Clock / configuration registers</h3><p>Options come directly from the selected MCU JSON. Hidden fields keep their JSON initialization value.</p></div>
          </div>
          <div id="registerGrid" class="registerGrid"></div>
        </section>

        <section class="clockSection card programmerSection">
          <div>
            <h3>Programmer / debugger</h3>
            <p>The available programmers come from <code>DeviceToProgrammer</code>.</p>
          </div>
          <label class="clockInput">Programmer<select id="programmerSelect"></select></label>
        </section>

        <section id="codegripConnectionCard" class="codegripConnectionCard card hidden">
          <div>
            <h3>CODEGRIP USB connection</h3>
            <p>Connect CODEGRIP over USB, then scan for it. The discovered serial number and hardware tokens are stored with this setup.</p>
          </div>
          <div class="codegripConnectionActions">
            <button id="findCodegripUsb" class="secondary">Find USB CODEGRIP</button>
            <span id="codegripConnectionStatus" class="connectionStatus">No USB CODEGRIP selected</span>
            <div id="codegripConnectionDetails" class="connectionDetails hidden">
              <span>Device<strong id="codegripDeviceName">—</strong></span>
              <span>Serial number<code id="codegripSerialNumber">—</code></span>
              <span>Hardware tokens<code id="codegripHwTokens">—</code></span>
            </div>
          </div>
        </section>

        <div class="generateBar">
          <div id="generationStatus" class="generationStatus"></div>
          <button id="generate" class="primary">Build Configuration</button>
        </div>
      </section>

      <section id="setupsView" class="pageView hidden">
        <div class="viewNav managerNav">
          <button id="backToMcusFromSetups" class="secondary">← MCU or Board</button>
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
                <th>Setup</th>
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
  getSetupDashboardState,
  useSetupWithCurrentWorkspace,
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
    sanitizeDebugText,
    isExcludedDebugScope,
    isGlobalDebugScope,
    formatDebugVariable,
    expandDebugVariables,
    validateDatabaseSchema,
    readBoardList,
    readProgrammersForDevice,
    readShieldsForBoard,
    buildMikrobusRust,
    shouldGenerateWorkspaceMikrobus,
    resolveManagedBspFile,
    normalizeRustCrateEntryPoint,
    readCargoPackageName,
    resolveBuiltProgramBinary
  }
};
