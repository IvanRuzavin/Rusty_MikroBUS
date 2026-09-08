'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const vscode = require('vscode');
const packages = require('./c_package_manager');

const DEBUG_TYPE = 'mikrobus-mikroc-debug';

const ADAPTER_BY_COMPILER = Object.freeze({
  mikrocarm: 'mikroe:arm:gdb_rsp',
  mikrocpic: 'mikroe:pic:gdb_rsp',
  mikrocpic32: 'mikroe:pic32:gdb_rsp',
  mikrocdspic: 'mikroe:dspic:gdb_rsp',
  mikrocavr: 'mikroe:avr:gdb_rsp'
});

const QT_RUNTIME_VERSION = '6.9.1';
const QT_RUNTIME_URL = 'https://download.qt.io/online/qtsdkrepository/linux_x64/desktop/qt6_691/qt6_691/qt.qt6.691.linux_gcc_64/6.9.1-0-202505291653qtbase-Linux-RHEL_8_10-GCC-Linux-RHEL_8_10-X86_64.7z';

function qtRuntimePackageSpec() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`Managed mikroDap Qt runtime is currently defined for Linux x64 only (${process.platform}/${process.arch}).`);
  }
  return {
    kind: 'shared',
    name: 'mikrodap_qt_runtime',
    version: QT_RUNTIME_VERSION,
    displayName: `Qt ${QT_RUNTIME_VERSION} Runtime for mikroDap`,
    environment: true,
    installRelativePath: `tools/mikrodap-qt/${QT_RUNTIME_VERSION}`,
    downloadUrl: QT_RUNTIME_URL,
    detail: 'Private Qt runtime used only by the standalone mikroC debugger. Installed to avoid mixing host Qt libraries with mikroDap.'
  };
}

function adapterIdForCompiler(compilerUid) {
  return ADAPTER_BY_COMPILER[String(compilerUid || '').trim().toLowerCase()];
}

function isMikroCCompiler(compilerUid) {
  return Boolean(adapterIdForCompiler(compilerUid));
}

function dbgPathForArtifact(artifact) {
  if (!artifact) return undefined;
  const parsed = path.parse(String(artifact));
  return path.join(parsed.dir, `${parsed.name}.dbg`);
}

function findQtRuntimeLib(root) {
  if (!root || !fs.existsSync(root)) return undefined;
  const preferred = [
    path.join(root, 'lib'),
    path.join(root, 'gcc_64', 'lib'),
    path.join(root, QT_RUNTIME_VERSION, 'gcc_64', 'lib')
  ];
  for (const candidate of preferred) {
    if (fs.existsSync(path.join(candidate, 'libQt6Core.so.6'))) return candidate;
  }
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (fs.existsSync(path.join(current.directory, 'libQt6Core.so.6'))) return current.directory;
    if (current.depth >= 5) continue;
    let entries;
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  return undefined;
}

function runtimePaths(context) {
  if (process.platform !== 'linux') {
    throw new Error('Standalone mikroC debugging is currently packaged for Linux only.');
  }
  const root = path.join(context.extensionPath, 'resources', 'mikrodap', 'linux');
  const qtEntry = packages.getInstalledPackage(context, qtRuntimePackageSpec());
  const qtPackageRoot = qtEntry?.root;
  const qtLib = findQtRuntimeLib(qtPackageRoot);
  const qtInstallRoot = qtLib ? path.dirname(qtLib) : undefined;
  return {
    root,
    executable: path.join(root, 'bin', 'mikroDap'),
    lib: path.join(root, 'lib'),
    qtRoot: qtInstallRoot,
    qtLib,
    qtPlugins: qtInstallRoot ? path.join(qtInstallRoot, 'plugins') : undefined
  };
}

function ensureRuntime(context) {
  const runtime = runtimePaths(context);
  const required = [
    runtime.executable,
    path.join(runtime.lib, 'libinterfaces.so'),
    path.join(runtime.lib, 'libutils.so'),
    path.join(runtime.lib, 'libcmake_parser.so'),
    path.join(runtime.lib, 'libQt6Core5Compat.so.6'),
    path.join(runtime.lib, 'libicui18n.so.73'),
    path.join(runtime.lib, 'libicuuc.so.73'),
    path.join(runtime.lib, 'libicudata.so.73')
  ];
  if (!runtime.qtRoot || !runtime.qtLib) {
    throw new Error(
      `Managed Qt ${QT_RUNTIME_VERSION} runtime for mikroDap is not installed. ` +
      'Rebuild the mikroC workspace setup once so the extension can download and install it.'
    );
  }
  required.push(
    path.join(runtime.qtLib, 'libQt6Core.so.6'),
    path.join(runtime.qtLib, 'libQt6DBus.so.6'),
    path.join(runtime.qtLib, 'libQt6Gui.so.6'),
    path.join(runtime.qtLib, 'libQt6Network.so.6'),
    path.join(runtime.qtLib, 'libQt6Sql.so.6'),
    path.join(runtime.qtLib, 'libQt6Widgets.so.6')
  );
  const missing = required.filter((candidate) => !fs.existsSync(candidate));
  if (missing.length) throw new Error(`Managed mikroDap runtime is incomplete: ${missing.map(path.basename).join(', ')}`);
  try { fs.chmodSync(runtime.executable, 0o755); } catch {}
  return runtime;
}

function prependLibraryPaths(paths, current) {
  const entries = [
    ...paths.filter(Boolean),
    ...String(current || '').split(':').filter(Boolean)
  ];
  return [...new Set(entries)].join(':');
}

function probeRuntime(context) {
  const runtime = ensureRuntime(context);
  const env = {
    ...process.env,
    // Keep every Qt module on the same Qt 6.9.1 build. Earlier builds mixed
    // NECTO's QtCore with Ubuntu's QtDBus/Gui/Widgets/Network/Sql and failed
    // on Qt private-ABI symbols.
    LD_LIBRARY_PATH: prependLibraryPaths([runtime.qtLib, runtime.lib], process.env.LD_LIBRARY_PATH),
    QT_PLUGIN_PATH: runtime.qtPlugins || process.env.QT_PLUGIN_PATH || '',
    QT_QPA_PLATFORM_PLUGIN_PATH: runtime.qtPlugins
      ? path.join(runtime.qtPlugins, 'platforms')
      : (process.env.QT_QPA_PLATFORM_PLUGIN_PATH || '')
  };
  const result = childProcess.spawnSync('ldd', [runtime.executable], { encoding: 'utf8', env });
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const unresolved = text.split(/\r?\n/)
    .filter((line) => /=>\s+not found\s*$/.test(line))
    .map((line) => line.trim().split(/\s+/)[0]);
  if (unresolved.length) {
    throw new Error(
      `mikroDap cannot start because these managed Linux runtime libraries are missing: ${unresolved.join(', ')}. ` +
      'Rebuild the mikroC workspace setup to reinstall its private Qt runtime.'
    );
  }

  const qtLines = text.split(/\r?\n/)
    .filter((line) => /\blibQt6[^ ]*\.so/.test(line) && /=>/.test(line));
  const foreignQt = qtLines.filter((line) => {
    const match = line.match(/=>\s+(\S+)/);
    if (!match || match[1] === 'not') return false;
    const resolved = path.resolve(match[1]);
    return !resolved.startsWith(path.resolve(runtime.qtLib) + path.sep) &&
      !resolved.startsWith(path.resolve(runtime.lib) + path.sep);
  });
  if (foreignQt.length) {
    throw new Error(
      `mikroDap resolved Qt libraries outside its managed Qt ${QT_RUNTIME_VERSION} runtime: ` +
      foreignQt.map((line) => line.trim().split(/\s+/)[0]).join(', ') +
      '. Rebuild the mikroC workspace setup.'
    );
  }
  return { ...runtime, env };
}

function makeInitializationOptions(options) {
  // mikroDap's family backends read these settings by their exact NECTO
  // setting paths. Supplying only hardware_debuger/port is not sufficient:
  // the native PIC/PIC32/ARM/etc. adapters also query resetType,
  // connectionType, speed, protocol and Programming Type during initialize.
  // Some backend builds do not guard a missing setting and can crash before
  // returning InitializeResponse, so always provide the complete debug set.
  const debuggerSettings = {
    resetType: options.resetType || 'Hardware reset',
    connectionType: options.connectionType || 'Normal',
    speed: options.speed || '',
    protocol: options.protocol || '',
    'Programming Type': options.programmingType || 'debugging',
    hardware_debuger: {
      settings: {
        ip_address: options.ipAddress || '127.0.0.1',
        port: String(options.port),
        remote_commands: options.remoteCommands || ''
      },
      name: options.tool || 'codegrip'
    }
  };

  return {
    adapterID: options.adapterID,
    projectParameters: {
      mcu: options.mcu,
      compilerPath: options.compilerPath,
      core_path: options.corePath,
      write_to_std: Boolean(options.writeToStd),
      automatization_run: false
    },
    debuggerSettings
  };
}

function encodeDapMessage(message) {
  const json = JSON.stringify(message);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`, 'utf8');
}

class DapFrameParser {
  constructor(onMessage) {
    this.buffer = Buffer.alloc(0);
    this.onMessage = onMessage;
  }

  push(chunk) {
    if (!chunk?.length) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (true) {
      const boundary = this.buffer.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const header = this.buffer.subarray(0, boundary).toString('ascii');
      const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!match) {
        // Drop one malformed header block instead of wedging the whole adapter.
        this.buffer = this.buffer.subarray(boundary + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = boundary + 4;
      if (this.buffer.length < bodyStart + length) return;
      const payload = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      try { this.onMessage(JSON.parse(payload)); } catch {}
    }
  }
}

class MikroDapProxy {
  constructor(context, session, output) {
    this.context = context;
    this.session = session;
    this.output = output;
    this.emitter = new vscode.EventEmitter();
    this.onDidSendMessage = this.emitter.event;
    this.pendingLaunch = undefined;
    this.pendingInitialized = undefined;
    this.childInitialized = false;
    this.disposed = false;

    const configuration = session.configuration || {};
    const options = configuration.__mikrobusMikroCOptions || {};
    this.options = options;
    const runtime = probeRuntime(context);
    output?.appendLine(`Starting mikroDap: ${runtime.executable}`);
    output?.appendLine(`mikroC DAP backend: ${options.adapterID}; DBG: ${options.dbgFile}`);

    this.child = childProcess.spawn(runtime.executable, [], {
      cwd: path.dirname(runtime.executable),
      env: runtime.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.parser = new DapFrameParser((message) => this.onChildMessage(message));
    this.child.stdout?.on('data', (chunk) => this.parser.push(chunk));
    this.child.stderr?.on('data', (chunk) => output?.append(chunk.toString()));
    this.child.once('error', (error) => {
      output?.appendLine(`mikroDap process error: ${error.message || error}`);
      this.emitter.fire({ type: 'event', event: 'output', body: { category: 'stderr', output: `mikroDap: ${error.message || error}\n` } });
    });
    this.child.once('exit', (code, signal) => {
      output?.appendLine(`mikroDap exited${code !== null ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}.`);
      if (!this.childInitialized && !this.disposed) {
        this.emitter.fire({
          type: 'event',
          event: 'output',
          body: {
            category: 'stderr',
            output: `mikroDap terminated before debugger initialization completed${signal ? ` (${signal})` : ''}. See the MikroBUS output channel for the initialization settings used.\n`
          }
        });
      }
    });
  }

  send(message) {
    if (this.disposed || !this.child?.stdin?.writable) return;
    this.child.stdin.write(encodeDapMessage(message));
  }

  transformedInitialize(message) {
    const custom = makeInitializationOptions(this.options);
    this.output?.appendLine(
      `mikroDap initialize: adapter=${custom.adapterID}, mcu=${custom.projectParameters.mcu}, ` +
      `tool=${custom.debuggerSettings.hardware_debuger.name}, port=${custom.debuggerSettings.hardware_debuger.settings.port}, ` +
      `protocol=${custom.debuggerSettings.protocol || '<default>'}, speed=${custom.debuggerSettings.speed || '<default>'}, ` +
      `reset=${custom.debuggerSettings.resetType}, connection=${custom.debuggerSettings.connectionType}, ` +
      `mode=${custom.debuggerSettings['Programming Type']}.`
    );
    return {
      ...message,
      arguments: {
        ...(message.arguments || {}),
        adapterID: custom.adapterID,
        projectParameters: custom.projectParameters,
        debuggerSettings: custom.debuggerSettings
      }
    };
  }

  transformedLaunch(message) {
    return {
      ...message,
      arguments: {
        noDebug: Boolean(message.arguments?.noDebug),
        name: this.options.dbgFile,
        tool: this.options.tool || 'codegrip'
      }
    };
  }

  handleMessage(message) {
    if (message?.type === 'request' && message.command === 'initialize') {
      this.send(this.transformedInitialize(message));
      return;
    }
    if (message?.type === 'request' && message.command === 'launch') {
      this.pendingLaunch = this.transformedLaunch(message);
      if (this.childInitialized) this.sendPendingLaunch();
      return;
    }
    this.send(message);
  }

  sendPendingLaunch() {
    if (!this.pendingLaunch) return;
    const request = this.pendingLaunch;
    this.pendingLaunch = undefined;
    this.send(request);
  }

  onChildMessage(message) {
    // mikroDap follows NECTO's sequence: initialize -> initialized event ->
    // LaunchRequest(.dbg). VS Code sends launch before waiting for initialized.
    // Queue VS Code's launch until mikroDap says it is initialized, then delay
    // the initialized event until launch succeeds. This preserves both sides'
    // expected ordering and prevents breakpoint/configuration requests racing
    // ahead of the mikroC debug database load.
    if (message?.type === 'event' && message.event === 'initialized') {
      this.childInitialized = true;
      this.pendingInitialized = message;
      this.sendPendingLaunch();
      return;
    }
    if (message?.type === 'response' && message.command === 'launch') {
      this.emitter.fire(message);
      if (this.pendingInitialized) {
        const initialized = this.pendingInitialized;
        this.pendingInitialized = undefined;
        this.emitter.fire(initialized);
      }
      return;
    }
    this.emitter.fire(message);
  }

  dispose() {
    this.disposed = true;
    try { this.child?.stdin?.end(); } catch {}
    if (this.child && this.child.exitCode === null) {
      try { this.child.kill(); } catch {}
    }
    this.emitter.dispose();
  }
}

function register(context, output) {
  const factory = vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
    createDebugAdapterDescriptor(session) {
      return new vscode.DebugAdapterInlineImplementation(new MikroDapProxy(context, session, output));
    }
  });
  context.subscriptions.push(factory);
  return factory;
}

function debugConfiguration(options) {
  return {
    type: DEBUG_TYPE,
    request: 'launch',
    name: options.name || 'MikroBUS mikroC CODEGRIP',
    cwd: options.cwd,
    program: options.dbgFile,
    presentation: { hidden: true },
    __mikrobusMikroC: true,
    __mikrobusCodegripC: true,
    __mikrobusCDebug: true,
    __mikrobusCDebugInstance: options.generation,
    __mikrobusCodegripGeneration: options.generation,
    __mikrobusMikroCOptions: {
      adapterID: options.adapterID,
      mcu: options.mcu,
      compilerPath: options.compilerPath,
      corePath: options.corePath,
      writeToStd: Boolean(options.writeToStd),
      ipAddress: options.ipAddress || '127.0.0.1',
      port: String(options.port),
      remoteCommands: options.remoteCommands || '',
      resetType: options.resetType || 'Hardware reset',
      connectionType: options.connectionType || 'Normal',
      speed: options.speed || '',
      protocol: options.protocol || '',
      programmingType: options.programmingType || 'debugging',
      tool: options.tool || 'codegrip',
      dbgFile: options.dbgFile
    }
  };
}

module.exports = {
  DEBUG_TYPE,
  ADAPTER_BY_COMPILER,
  adapterIdForCompiler,
  isMikroCCompiler,
  dbgPathForArtifact,
  qtRuntimePackageSpec,
  makeInitializationOptions,
  encodeDapMessage,
  DapFrameParser,
  debugConfiguration,
  ensureRuntime,
  probeRuntime,
  register
};
