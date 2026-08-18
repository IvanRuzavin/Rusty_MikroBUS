const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const http = require('http');
const https = require('https');
const { registerMcuConfigurator } = require('./mcu_configurator');

const VERSIONS = {
  probeRs: '0.27.0',
  openocd: '0.12.0-7',
  armGcc: '14.2.1-1.1'
};

const URLS = {
  windows: {
    msvc: 'https://aka.ms/vs/17/release/vs_BuildTools.exe',
    rust: 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe',
    stlink: 'https://download.mikroe.com/setups/drivers/mikroprog/arm/st-link-usb-drivers.rar'
  },
  jlink: 'https://www.segger.com/downloads/jlink/',
  rustyMikrobus: 'https://github.com/IvanRuzavin/Rusty_MikroBUS/releases/latest',
  probeRsShell: `https://github.com/probe-rs/probe-rs/releases/download/v${VERSIONS.probeRs}/probe-rs-tools-installer.sh`,
  probeRsPowerShell: `https://github.com/probe-rs/probe-rs/releases/download/v${VERSIONS.probeRs}/probe-rs-tools-installer.ps1`,
  probeRsUdev: 'https://probe.rs/files/69-probe-rs.rules'
};

let setupView;

class MikrobusSetupViewProvider {
  constructor(context) {
    this.context = context;
  }

  resolveWebviewView(webviewView) {
    setupView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };

    webviewView.webview.html = getSetupHtml(webviewView.webview, this.context.extensionUri);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      await handleSetupMessage(message, webviewView, this.context);
    }, null, this.context.subscriptions);

    webviewView.onDidDispose(() => {
      if (setupView === webviewView) {
        setupView = undefined;
      }
    }, null, this.context.subscriptions);

    postStatus(webviewView, scanPackages(this.context), this.context);
  }
}

function activate(context) {
  registerMcuConfigurator(context);

  const provider = new MikrobusSetupViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'mikrobusRust.setupView',
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  const openSetup = vscode.commands.registerCommand('mikrobusRust.openSetup', async () => {
    await revealSetupView();
  });
  context.subscriptions.push(openSetup);

  void maybeShowFirstRunSetup(context);
}

async function maybeShowFirstRunSetup(context) {
  const version = context.extension.packageJSON.version || '0';
  const key = 'setup.lastAutoShownVersion';
  const lastShown = context.globalState.get(key);
  if (lastShown === version) {
    return;
  }

  const statuses = scanPackages(context);
  const missing = statuses.filter((item) => item.status !== 'installed');
  await context.globalState.update(key, version);

  if (missing.length > 0) {
    await revealSetupView();
  }
}

async function revealSetupView() {
  try {
    await vscode.commands.executeCommand('workbench.view.extension.mikrobusRust');
  } catch {
    // The generated focus command below is enough on VS Code versions
    // where the view-container command is not directly callable.
  }

  try {
    await vscode.commands.executeCommand('mikrobusRust.setupView.focus');
  } catch {
    // If the view is already visible, there is nothing else to do.
  }
}

async function handleSetupMessage(message, view, context) {
  if (!message || typeof message.type !== 'string') {
    return;
  }

  if (message.type === 'ready' || message.type === 'refresh') {
    postStatus(view, scanPackages(context), context);
    return;
  }

  if (message.type === 'install' && typeof message.id === 'string') {
    await handleInstallRequest(message.id, context);
    if (setupView) {
      postStatus(setupView, scanPackages(context), context);
    }
    return;
  }

  if (message.type === 'openSettings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'mikrobusRust.storageRoot');
    return;
  }

  if (message.type === 'configureMcu') {
    await vscode.commands.executeCommand('mikrobusRust.configureMcu');
  }
}

function postStatus(view, statuses, context) {
  if (!view) {
    return;
  }

  void view.webview.postMessage({
    type: 'status',
    platform: process.platform,
    architecture: os.arch(),
    platformLabel: getPlatformLabel(),
    managedRoot: getManagedRoot(context),
    packages: statuses
  });
}

function scanPackages(context) {
  const expected = getExpectedPaths(context);
  const definitions = getPackageDefinitions();

  return definitions.map((definition) => {
    const detected = detectPackage(definition.id, expected);
    const action = getInstallAction(definition.id, context);
    return {
      ...definition,
      ...detected,
      installSupported: Boolean(action),
      installLabel: action ? action.label : 'Manual install'
    };
  });
}

function getPackageDefinitions() {
  const commonManaged = [
    {
      id: 'openocd',
      name: 'OpenOCD Runner',
      description: `xPack OpenOCD ${VERSIONS.openocd}, matching the current PyQt application.`,
      kind: 'managed'
    },
    {
      id: 'armGcc',
      name: 'ARM GNU Toolchain',
      description: `xPack arm-none-eabi-gcc ${VERSIONS.armGcc}, matching the current debugger workflow.`,
      kind: 'managed'
    },
    {
      id: 'database',
      name: 'MikroBUS Rust Database',
      description: 'database_mikro_sdk_rust.db used to enumerate MCUs and family metadata.',
      kind: 'managed'
    },
    {
      id: 'sdk',
      name: 'Rust mikroSDK',
      description: 'Rust SDK source tree used to generate the target configuration.',
      kind: 'managed'
    },
    {
      id: 'core',
      name: 'MCU Core Package',
      description: 'MCU definitions, startup, linker, pin mappings and system initialization sources.',
      kind: 'managed'
    }
  ];

  if (process.platform === 'win32') {
    return [
      {
        id: 'msvc',
        name: 'MSVC Build Tools',
        description: 'Visual C++ build tools required by the Windows Rust/probe setup.',
        kind: 'system'
      },
      {
        id: 'rust',
        name: 'Rust Toolchain',
        description: 'rustup, rustc and cargo.',
        kind: 'system'
      },
      {
        id: 'probeRs',
        name: 'probe-rs',
        description: `probe-rs tools ${VERSIONS.probeRs}, used for programming and debugging.`,
        kind: 'system'
      },
      {
        id: 'stlink',
        name: 'ST-Link Driver',
        description: 'Windows ST-Link USB driver used by the existing workflow.',
        kind: 'system'
      },
      {
        id: 'jlink',
        name: 'SEGGER J-Link / J-Flash',
        description: 'SEGGER package; detection specifically checks for the J-Flash executable.',
        kind: 'system'
      },
      ...commonManaged
    ];
  }

  if (process.platform === 'linux') {
    return [
      {
        id: 'linuxBuild',
        name: 'Linux Build Prerequisites',
        description: 'Compiler/build utilities and libudev development support used by the Rust embedded tooling.',
        kind: 'system'
      },
      {
        id: 'rust',
        name: 'Rust Toolchain',
        description: 'rustup, rustc and cargo.',
        kind: 'system'
      },
      {
        id: 'probeRs',
        name: 'probe-rs',
        description: `probe-rs tools ${VERSIONS.probeRs}, used for programming and debugging.`,
        kind: 'system'
      },
      {
        id: 'udev',
        name: 'Debug Probe USB Access',
        description: 'probe-rs udev rules for non-root access to ST-Link, J-Link, CMSIS-DAP and other supported probes.',
        kind: 'system'
      },
      {
        id: 'jlink',
        name: 'SEGGER J-Link / J-Flash',
        description: 'SEGGER Linux software package; detection checks PATH and common /opt/SEGGER locations.',
        kind: 'system'
      },
      ...commonManaged
    ];
  }

  return [
    {
      id: 'unsupportedHost',
      name: 'Host Platform',
      description: 'This prototype currently provides installation profiles for Windows and Linux.',
      kind: 'system'
    },
    ...commonManaged
  ];
}

function getManagedRoot(context) {
  const configured = vscode.workspace.getConfiguration('mikrobusRust').get('storageRoot', '').trim();
  if (configured) {
    return expandHome(configured);
  }
  return context.globalStorageUri.fsPath;
}

function getExpectedPaths(context) {
  const managedRoot = getManagedRoot(context);
  const home = os.homedir();
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const windowsDir = process.env.WINDIR || 'C:\\Windows';

  return {
    managedRoot,
    msvc: path.join(programFilesX86, 'Microsoft Visual Studio', '2022', 'BuildTools'),
    vswhere: path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
    rustup: path.join(home, '.rustup'),
    cargoBin: path.join(home, '.cargo', 'bin'),
    jlinkWindowsRoot: path.join(programFiles, 'SEGGER'),
    jlinkLinuxRoot: '/opt/SEGGER',
    stlinkDriverRoot: path.join(windowsDir, 'System32', 'DriverStore', 'FileRepository'),
    udevRules: '/etc/udev/rules.d/69-probe-rs.rules',
    openocd: path.join(managedRoot, 'runner', `xpack-openocd-${VERSIONS.openocd}`),
    armGcc: path.join(managedRoot, 'runner', `xpack-arm-none-eabi-gcc-${VERSIONS.armGcc}`),
    database: path.join(managedRoot, 'database', 'database_mikro_sdk_rust.db'),
    sdk: path.join(managedRoot, 'sdk'),
    core: path.join(managedRoot, 'core')
  };
}

function detectPackage(id, expected) {
  switch (id) {
    case 'msvc':
      return detectMsvc(expected);
    case 'linuxBuild':
      return detectLinuxBuildPrerequisites();
    case 'rust':
      return detectRust(expected);
    case 'probeRs':
      return detectProbeRs(expected);
    case 'stlink':
      return detectStLinkDriver(expected);
    case 'udev':
      return detectUdevRules(expected);
    case 'jlink':
      return detectJLink(expected);
    case 'unsupportedHost':
      return {
        status: 'unsupported',
        detail: `No system dependency profile is defined for ${getPlatformLabel()}.`,
        expectedPath: '',
        version: ''
      };
    default:
      return detectManaged(id, expected);
  }
}

function detectMsvc(expected) {
  if (process.platform !== 'win32') {
    return unsupportedResult('MSVC is only used by the Windows profile.', expected.msvc);
  }

  if (fs.existsSync(expected.vswhere)) {
    try {
      const result = childProcess.spawnSync(expected.vswhere, [
        '-latest',
        '-products', '*',
        '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property', 'installationPath'
      ], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000
      });
      const installPath = String(result.stdout || '').trim();
      if (result.status === 0 && installPath) {
        return {
          status: 'installed',
          detail: 'Visual C++ build tools detected with vswhere.',
          expectedPath: installPath,
          version: ''
        };
      }
    } catch {
      // Fall back to the existing PyQt location check.
    }
  }

  return pathStatus(expected.msvc, 'Build Tools directory found.');
}

function detectLinuxBuildPrerequisites() {
  if (process.platform !== 'linux') {
    return unsupportedResult('Linux prerequisites are only used by the Linux profile.', 'system packages');
  }

  const checks = [
    { name: 'C/C++ compiler', ok: Boolean(findOnPath(['cc', 'gcc', 'clang'])) },
    { name: 'pkg-config', ok: commandVersion('pkg-config', ['--version']).ok },
    { name: 'libudev development files', ok: commandVersion('pkg-config', ['--exists', 'libudev']).ok },
    { name: 'cmake', ok: commandVersion('cmake', ['--version']).ok },
    { name: 'git', ok: commandVersion('git', ['--version']).ok },
    { name: 'curl', ok: commandVersion('curl', ['--version']).ok },
    { name: '7-Zip extractor', ok: Boolean(findOnPath(['7zz', '7z', '7za', 'bsdtar'])) }
  ];

  const missing = checks.filter((item) => !item.ok).map((item) => item.name);
  return {
    status: missing.length === 0 ? 'installed' : 'missing',
    detail: missing.length === 0
      ? 'Compiler, pkg-config, libudev, CMake, Git, curl and a 7-Zip-capable extractor are available.'
      : `Missing: ${missing.join(', ')}.`,
    expectedPath: getLinuxPackageHint(),
    version: ''
  };
}

function detectRust(expected) {
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  const rustup = commandVersionWithFallback('rustup', ['--version'], path.join(expected.cargoBin, `rustup${exeSuffix}`));
  const rustc = commandVersionWithFallback('rustc', ['--version'], path.join(expected.cargoBin, `rustc${exeSuffix}`));
  const cargo = commandVersionWithFallback('cargo', ['--version'], path.join(expected.cargoBin, `cargo${exeSuffix}`));
  const installed = rustup.ok && rustc.ok && cargo.ok;

  return {
    status: installed ? 'installed' : 'missing',
    detail: installed ? 'rustup, rustc and cargo are available.' : 'One or more Rust commands are unavailable.',
    expectedPath: expected.rustup,
    version: [rustup.output, rustc.output, cargo.output].filter(Boolean).join(' | ')
  };
}

function detectProbeRs(expected) {
  const result = commandVersion('probe-rs', ['--version']);
  const fallback = path.join(expected.cargoBin, process.platform === 'win32' ? 'probe-rs.exe' : 'probe-rs');
  const installed = result.ok || fs.existsSync(fallback);

  return {
    status: installed ? 'installed' : 'missing',
    detail: installed ? 'probe-rs executable found.' : 'probe-rs executable not found.',
    expectedPath: result.ok ? (findOnPath(['probe-rs']) || fallback) : fallback,
    version: result.output
  };
}

function detectStLinkDriver(expected) {
  if (process.platform !== 'win32') {
    return unsupportedResult('Linux does not require the Windows ST-Link driver.', expected.stlinkDriverRoot);
  }

  const found = findFile(
    expected.stlinkDriverRoot,
    'stlink_vcp.inf',
    2,
    (name) => name.toLowerCase().startsWith('stlink')
  );

  return {
    status: found ? 'installed' : 'missing',
    detail: found ? 'ST-Link driver INF found in DriverStore.' : 'stlink_vcp.inf not found in DriverStore.',
    expectedPath: found || path.join(expected.stlinkDriverRoot, 'stlink*', 'stlink_vcp.inf'),
    version: ''
  };
}

function detectUdevRules(expected) {
  if (process.platform !== 'linux') {
    return unsupportedResult('udev rules are only used by the Linux profile.', expected.udevRules);
  }

  const candidates = [
    expected.udevRules,
    '/usr/lib/udev/rules.d/69-probe-rs.rules',
    '/lib/udev/rules.d/69-probe-rs.rules'
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));

  return {
    status: found ? 'installed' : 'missing',
    detail: found ? 'probe-rs udev rules found.' : '69-probe-rs.rules was not found in the standard udev rule directories.',
    expectedPath: found || expected.udevRules,
    version: ''
  };
}

function detectJLink(expected) {
  if (process.platform === 'win32') {
    const onPath = findOnPath(['JFlash.exe']);
    const found = onPath || findFile(expected.jlinkWindowsRoot, 'JFlash.exe', 4);
    return {
      status: found ? 'installed' : 'missing',
      detail: found ? 'J-Flash executable found.' : 'JFlash.exe was not found under the SEGGER installation root or PATH.',
      expectedPath: found || path.join(expected.jlinkWindowsRoot, 'JLink*', 'JFlash.exe'),
      version: ''
    };
  }

  if (process.platform === 'linux') {
    const onPath = findOnPath(['JFlashExe', 'JFlash']);
    const fromOpt = findFirstNamedFile(expected.jlinkLinuxRoot, ['JFlashExe', 'JFlash'], 4);
    const found = onPath || fromOpt;
    return {
      status: found ? 'installed' : 'missing',
      detail: found ? 'SEGGER J-Flash executable found.' : 'J-Flash was not found on PATH or below /opt/SEGGER.',
      expectedPath: found || '/opt/SEGGER/JLink/JFlashExe',
      version: ''
    };
  }

  return unsupportedResult('J-Link detection is currently defined for Windows and Linux.', 'SEGGER J-Link installation');
}

function detectManaged(id, expected) {
  if (id === 'openocd') {
    const exe = process.platform === 'win32' ? 'openocd.exe' : 'openocd';
    const executable = path.join(expected.openocd, 'bin', exe);
    return fileStatus(executable, expected.openocd, 'OpenOCD runner found.');
  }

  if (id === 'armGcc') {
    const exe = process.platform === 'win32' ? 'arm-none-eabi-gcc.exe' : 'arm-none-eabi-gcc';
    const executable = path.join(expected.armGcc, 'bin', exe);
    return fileStatus(executable, expected.armGcc, 'ARM GCC runner found.');
  }

  if (id === 'database') {
    return fileStatus(expected.database, expected.database, 'Application database found.');
  }

  if (id === 'sdk') {
    const present = directoryHasContent(expected.sdk);
    return {
      status: present ? 'installed' : 'missing',
      detail: present ? 'Rust SDK directory found.' : 'Rust SDK directory is missing or empty.',
      expectedPath: expected.sdk,
      version: ''
    };
  }

  if (id === 'core') {
    const present = directoryHasContent(expected.core);
    return {
      status: present ? 'installed' : 'missing',
      detail: present ? 'MCU core directory found.' : 'MCU core directory is missing or empty.',
      expectedPath: expected.core,
      version: ''
    };
  }

  return {
    status: 'missing',
    detail: 'Not detected.',
    expectedPath: expected.managedRoot,
    version: ''
  };
}

function getInstallAction(id, context) {
  if (process.platform === 'win32') {
    if (id === 'msvc') return externalAction('Open installer', URLS.windows.msvc);
    if (id === 'rust') return externalAction('Open rustup installer', URLS.windows.rust);
    if (id === 'probeRs') {
      return terminalAction(
        'Install in PowerShell',
        `Set-ExecutionPolicy -Scope Process Bypass; irm ${URLS.probeRsPowerShell} | iex`,
        'MikroBUS Rust - probe-rs',
        'powershell.exe'
      );
    }
    if (id === 'stlink') return externalAction('Open driver download', URLS.windows.stlink);
    if (id === 'jlink') return externalAction('Open SEGGER download', URLS.jlink);
  }

  if (process.platform === 'linux') {
    if (id === 'linuxBuild') {
      const command = getLinuxPrerequisiteInstallCommand();
      return command ? terminalAction('Install packages', command, 'MikroBUS Rust - prerequisites') : undefined;
    }
    if (id === 'rust') {
      return terminalAction(
        'Install Rust',
        `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`,
        'MikroBUS Rust - Rust'
      );
    }
    if (id === 'probeRs') {
      return terminalAction(
        'Install probe-rs',
        `curl --proto '=https' --tlsv1.2 -LsSf ${URLS.probeRsShell} | sh`,
        'MikroBUS Rust - probe-rs'
      );
    }
    if (id === 'udev') {
      return terminalAction(
        'Install udev rules',
        `curl --proto '=https' --tlsv1.2 -LsSf ${URLS.probeRsUdev} -o /tmp/69-probe-rs.rules && sudo install -m 0644 /tmp/69-probe-rs.rules /etc/udev/rules.d/69-probe-rs.rules && sudo udevadm control --reload && sudo udevadm trigger && rm -f /tmp/69-probe-rs.rules`,
        'MikroBUS Rust - udev'
      );
    }
    if (id === 'jlink') return externalAction('Open SEGGER download', URLS.jlink);
  }

  if (id === 'openocd') {
    const asset = getXpackAsset('openocd');
    return asset ? managedAction('Install automatically') : undefined;
  }

  if (id === 'armGcc') {
    const asset = getXpackAsset('armGcc');
    return asset ? managedAction('Install automatically') : undefined;
  }

  if (['database', 'sdk', 'core'].includes(id)) {
    return managedAction('Install automatically');
  }

  return undefined;
}

function externalAction(label, url) {
  return { type: 'external', label, url };
}

function terminalAction(label, command, terminalName, shellPath) {
  return { type: 'terminal', label, command, terminalName, shellPath };
}

function managedAction(label) {
  return { type: 'managed', label };
}

async function handleInstallRequest(id, context) {
  const definition = getPackageDefinitions().find((item) => item.id === id);
  if (!definition) {
    return;
  }

  const action = getInstallAction(id, context);
  if (!action) {
    vscode.window.showInformationMessage(`Automatic install guidance is not available for ${definition.name} on ${getPlatformLabel()}.`);
    return;
  }

  const expected = getExpectedPaths(context);
  const target = expectedPathFor(id, expected);
  const choice = await vscode.window.showWarningMessage(
    `${action.label} for ${definition.name}?${target ? `\n\nExpected/detected location:\n${target}` : ''}`,
    { modal: true },
    action.label
  );

  if (choice !== action.label) {
    return;
  }

  if (action.type === 'managed') {
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Installing ${definition.name}`,
        cancellable: true
      }, async (progress, token) => {
        await installManagedPackage(id, context, progress, token);
      });
      vscode.window.showInformationMessage(`${definition.name} installed successfully.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to install ${definition.name}: ${message}`);
    }
    return;
  }

  if (action.type === 'external') {
    await vscode.env.openExternal(vscode.Uri.parse(action.url));
    vscode.window.showInformationMessage(`Complete the ${definition.name} installation/download, then return to MikroBUS Rust Setup and click Refresh.`);
    return;
  }

  if (action.type === 'terminal') {
    const options = { name: action.terminalName || `MikroBUS Rust - ${definition.name}` };
    if (action.shellPath) {
      options.shellPath = action.shellPath;
    }
    const terminal = vscode.window.createTerminal(options);
    terminal.show(true);
    terminal.sendText(action.command, true);
    vscode.window.showInformationMessage(`Installation command started for ${definition.name}. When it finishes, click Refresh in the setup page.`);
  }
}

async function installManagedPackage(id, context, progress, token) {
  const expected = getExpectedPaths(context);
  const managedRoot = getManagedRoot(context);
  const tempRoot = path.join(managedRoot, '.install-temp', `${id}-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  await fs.promises.mkdir(tempRoot, { recursive: true });

  try {
    ensureNotCancelled(token);

    if (id === 'openocd' || id === 'armGcc') {
      await installXpackPackage(id, expected, tempRoot, progress, token);
    } else if (id === 'database') {
      await installDatabase(expected, tempRoot, progress, token);
    } else if (id === 'sdk' || id === 'core') {
      await installRustyArchive(id, expected, tempRoot, progress, token);
    } else {
      throw new Error(`No managed installer is defined for ${id}.`);
    }

    ensureNotCancelled(token);
    const verification = detectManaged(id, expected);
    if (verification.status !== 'installed') {
      throw new Error(`Installation completed, but verification failed: ${verification.detail}`);
    }
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    const parent = path.dirname(tempRoot);
    try {
      if ((await fs.promises.readdir(parent)).length === 0) {
        await fs.promises.rmdir(parent);
      }
    } catch {
      // Keep the shared temporary directory if another install is using it.
    }
  }
}

async function installXpackPackage(id, expected, tempRoot, progress, token) {
  const asset = getXpackAsset(id === 'openocd' ? 'openocd' : 'armGcc');
  if (!asset) {
    throw new Error(`No ${id} package is defined for ${getPlatformLabel()}.`);
  }

  const target = id === 'openocd' ? expected.openocd : expected.armGcc;
  const archivePath = path.join(tempRoot, asset.file);
  const extractRoot = path.join(tempRoot, 'extract');
  await fs.promises.mkdir(extractRoot, { recursive: true });

  progress.report({ message: `Downloading ${asset.file}...` });
  await downloadFile(asset.url, archivePath, progress, token);
  ensureNotCancelled(token);

  progress.report({ message: 'Extracting package...' });
  await extractArchive(archivePath, extractRoot, token);

  let source = path.join(extractRoot, path.basename(target));
  if (!directoryHasContent(source)) {
    const directories = (await fs.promises.readdir(extractRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    if (directories.length === 1) {
      source = path.join(extractRoot, directories[0].name);
    }
  }

  const exe = id === 'openocd'
    ? (process.platform === 'win32' ? 'openocd.exe' : 'openocd')
    : (process.platform === 'win32' ? 'arm-none-eabi-gcc.exe' : 'arm-none-eabi-gcc');
  const verificationFile = path.join(source, 'bin', exe);
  if (!fs.existsSync(verificationFile)) {
    throw new Error(`Downloaded archive does not contain the expected executable: ${verificationFile}`);
  }

  progress.report({ message: `Installing to ${target}...` });
  await replaceDirectory(source, target);
}

async function installDatabase(expected, tempRoot, progress, token) {
  const assetName = path.basename(expected.database);
  progress.report({ message: `Resolving latest Rusty_MikroBUS release asset ${assetName}...` });
  const assetUrl = await resolveLatestRustyAsset(assetName, token);
  const downloaded = path.join(tempRoot, assetName);

  progress.report({ message: `Downloading ${assetName}...` });
  await downloadFile(assetUrl, downloaded, progress, token);
  ensureNotCancelled(token);

  const stat = await fs.promises.stat(downloaded);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`${assetName} was downloaded but is empty.`);
  }

  await fs.promises.mkdir(path.dirname(expected.database), { recursive: true });
  await fs.promises.rm(expected.database, { force: true });
  await fs.promises.rename(downloaded, expected.database);
}

async function installRustyArchive(id, expected, tempRoot, progress, token) {
  const target = id === 'sdk' ? expected.sdk : expected.core;
  const assetName = `${id}.7z`;

  progress.report({ message: `Resolving latest Rusty_MikroBUS release asset ${assetName}...` });
  const assetUrl = await resolveLatestRustyAsset(assetName, token);
  const archivePath = path.join(tempRoot, assetName);
  const extractRoot = path.join(tempRoot, 'payload');
  await fs.promises.mkdir(extractRoot, { recursive: true });

  progress.report({ message: `Downloading ${assetName}...` });
  await downloadFile(assetUrl, archivePath, progress, token);
  ensureNotCancelled(token);

  progress.report({ message: `Extracting ${assetName}...` });
  await extractArchive(archivePath, extractRoot, token);

  let source = extractRoot;
  const nestedSameName = path.join(extractRoot, id);
  const entries = await fs.promises.readdir(extractRoot, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory() && entries[0].name.toLowerCase() === id.toLowerCase() && directoryHasContent(nestedSameName)) {
    source = nestedSameName;
  }

  if (!directoryHasContent(source)) {
    throw new Error(`${assetName} extracted successfully, but the resulting directory is empty.`);
  }

  progress.report({ message: `Installing to ${target}...` });
  await replaceDirectory(source, target);
}

async function resolveLatestRustyAsset(assetName, token) {
  ensureNotCancelled(token);
  const release = await fetchJson('https://api.github.com/repos/IvanRuzavin/Rusty_MikroBUS/releases/latest', token);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find((item) => item && item.name === assetName);
  if (!asset || !asset.browser_download_url) {
    const available = assets.map((item) => item && item.name).filter(Boolean).join(', ');
    throw new Error(`Latest Rusty_MikroBUS release does not contain ${assetName}.${available ? ` Available assets: ${available}` : ''}`);
  }
  return asset.browser_download_url;
}

async function fetchJson(url, token) {
  const buffer = await requestBuffer(url, token, {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'mikrobus-rust-vscode-extension'
  });
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON response from ${url}: ${error.message}`);
  }
}

async function downloadFile(url, destination, progress, token) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  await fs.promises.rm(partial, { force: true });

  let response;
  try {
    response = await openHttpResponse(url, token, {
      Accept: 'application/octet-stream',
      'User-Agent': 'mikrobus-rust-vscode-extension'
    });

    const total = Number(response.headers['content-length'] || 0);
    let received = 0;
    let lastReported = 0;
    const output = fs.createWriteStream(partial, { flags: 'wx' });

    await new Promise((resolve, reject) => {
      const cancel = token && token.onCancellationRequested(() => {
        response.destroy(new Error('Installation cancelled.'));
        output.destroy(new Error('Installation cancelled.'));
      });

      response.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0 && progress) {
          const percent = Math.floor((received / total) * 100);
          if (percent >= lastReported + 5 || percent === 100) {
            progress.report({ message: `Downloaded ${percent}%` });
            lastReported = percent;
          }
        }
      });
      response.on('error', reject);
      output.on('error', reject);
      output.on('finish', resolve);
      output.on('close', () => cancel && cancel.dispose());
      response.pipe(output);
    });

    ensureNotCancelled(token);
    await fs.promises.rename(partial, destination);
  } catch (error) {
    await fs.promises.rm(partial, { force: true }).catch(() => {});
    throw error;
  }
}

function requestBuffer(url, token, headers) {
  return openHttpResponse(url, token, headers).then((response) => new Promise((resolve, reject) => {
    const chunks = [];
    const cancel = token && token.onCancellationRequested(() => response.destroy(new Error('Installation cancelled.')));
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
      if (cancel) cancel.dispose();
      resolve(Buffer.concat(chunks));
    });
    response.on('error', (error) => {
      if (cancel) cancel.dispose();
      reject(error);
    });
  }));
}

function openHttpResponse(url, token, headers = {}, redirectCount = 0) {
  ensureNotCancelled(token);
  if (redirectCount > 8) {
    return Promise.reject(new Error(`Too many redirects while downloading ${url}.`));
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'http:' ? http : https;
    const request = transport.get(parsed, { headers }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, parsed).toString();
        openHttpResponse(next, token, headers, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 400).trim();
          reject(new Error(`HTTP ${status} for ${url}${body ? `: ${body}` : ''}`));
        });
        return;
      }
      resolve(response);
    });

    const cancel = token && token.onCancellationRequested(() => request.destroy(new Error('Installation cancelled.')));
    request.setTimeout(30000, () => request.destroy(new Error(`Connection timed out while downloading ${url}.`)));
    request.on('error', (error) => {
      if (cancel) cancel.dispose();
      reject(error);
    });
    request.on('close', () => {
      if (cancel) cancel.dispose();
    });
  });
}

async function extractArchive(archivePath, destination, token) {
  await fs.promises.mkdir(destination, { recursive: true });
  const lower = archivePath.toLowerCase();

  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    const tar = findOnPath(process.platform === 'win32' ? ['tar.exe', 'tar'] : ['tar']);
    if (!tar) throw new Error('tar was not found on PATH.');
    await runCommand(tar, ['-xzf', archivePath, '-C', destination], token);
    return;
  }

  if (lower.endsWith('.zip')) {
    if (process.platform === 'win32') {
      const tar = findOnPath(['tar.exe', 'tar']);
      if (tar) {
        await runCommand(tar, ['-xf', archivePath, '-C', destination], token);
        return;
      }
      const powershell = findOnPath(['powershell.exe', 'powershell']);
      if (!powershell) throw new Error('Neither tar.exe nor PowerShell was found for ZIP extraction.');
      const psPath = (value) => value.replace(/'/g, "''");
      await runCommand(powershell, ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${psPath(archivePath)}' -DestinationPath '${psPath(destination)}' -Force`], token);
      return;
    }
    const unzip = findOnPath(['unzip']);
    if (!unzip) throw new Error('unzip was not found on PATH.');
    await runCommand(unzip, ['-o', archivePath, '-d', destination], token);
    return;
  }

  if (lower.endsWith('.7z')) {
    const candidates = [];
    for (const name of ['7zz', '7z', '7za']) {
      const executable = findOnPath([name]);
      if (executable) candidates.push({ executable, args: ['x', '-y', archivePath, `-o${destination}`] });
    }
    if (process.platform === 'win32') {
      for (const candidate of [
        'C:\\Program Files\\7-Zip\\7z.exe',
        'C:\\Program Files (x86)\\7-Zip\\7z.exe'
      ]) {
        if (fs.existsSync(candidate)) candidates.push({ executable: candidate, args: ['x', '-y', archivePath, `-o${destination}`] });
      }
      const tar = findOnPath(['tar.exe', 'tar']);
      if (tar) candidates.push({ executable: tar, args: ['-xf', archivePath, '-C', destination] });
    } else {
      const bsdtar = findOnPath(['bsdtar']);
      if (bsdtar) candidates.push({ executable: bsdtar, args: ['-xf', archivePath, '-C', destination] });
    }

    if (candidates.length === 0) {
      throw new Error(process.platform === 'linux'
        ? 'A 7-Zip extractor is required for sdk.7z/core.7z. Install the Linux Build Prerequisites card first.'
        : 'A 7-Zip-capable extractor was not found. Install 7-Zip or use a Windows version that provides tar.exe with 7z support.');
    }

    let lastError;
    for (const candidate of candidates) {
      try {
        await runCommand(candidate.executable, candidate.args, token);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error(`Unable to extract ${archivePath}.`);
  }

  throw new Error(`Unsupported archive format: ${path.basename(archivePath)}`);
}

function runCommand(executable, args, token) {
  ensureNotCancelled(token);
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const limit = 12000;

    const cancel = token && token.onCancellationRequested(() => child.kill());
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-limit); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-limit); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (cancel) cancel.dispose();
      if (token && token.isCancellationRequested) {
        reject(new Error('Installation cancelled.'));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(executable)} exited with code ${code}.${stderr.trim() ? ` ${stderr.trim()}` : stdout.trim() ? ` ${stdout.trim()}` : ''}`));
    });
  });
}

async function replaceDirectory(source, target) {
  if (!directoryHasContent(source)) {
    throw new Error(`Cannot install from an empty directory: ${source}`);
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.rm(target, { recursive: true, force: true });
  try {
    await fs.promises.rename(source, target);
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      await fs.promises.cp(source, target, { recursive: true, force: true });
      await fs.promises.rm(source, { recursive: true, force: true });
      return;
    }
    throw error;
  }
}

function ensureNotCancelled(token) {
  if (token && token.isCancellationRequested) {
    throw new Error('Installation cancelled.');
  }
}

function getXpackAsset(kind) {
  const arch = os.arch();

  if (process.platform === 'win32') {
    if (arch !== 'x64') {
      return undefined;
    }
    if (kind === 'openocd') {
      const file = `xpack-openocd-${VERSIONS.openocd}-win32-x64.zip`;
      return {
        file,
        url: `https://github.com/xpack-dev-tools/openocd-xpack/releases/download/v${VERSIONS.openocd}/${file}`
      };
    }
    if (kind === 'armGcc') {
      const file = `xpack-arm-none-eabi-gcc-${VERSIONS.armGcc}-win32-x64.zip`;
      return {
        file,
        url: `https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/download/v${VERSIONS.armGcc}/${file}`
      };
    }
  }

  if (process.platform === 'linux' && ['x64', 'arm64'].includes(arch)) {
    const assetArch = arch === 'x64' ? 'x64' : 'arm64';
    if (kind === 'openocd') {
      const file = `xpack-openocd-${VERSIONS.openocd}-linux-${assetArch}.tar.gz`;
      return {
        file,
        url: `https://github.com/xpack-dev-tools/openocd-xpack/releases/download/v${VERSIONS.openocd}/${file}`
      };
    }
    if (kind === 'armGcc') {
      const file = `xpack-arm-none-eabi-gcc-${VERSIONS.armGcc}-linux-${assetArch}.tar.gz`;
      return {
        file,
        url: `https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/download/v${VERSIONS.armGcc}/${file}`
      };
    }
  }

  return undefined;
}

function getLinuxPrerequisiteInstallCommand() {
  if (findOnPath(['apt-get'])) {
    return 'sudo apt-get update && sudo apt-get install -y build-essential pkg-config libudev-dev cmake git curl 7zip';
  }
  if (findOnPath(['dnf'])) {
    return 'sudo dnf install -y gcc gcc-c++ make pkgconf-pkg-config systemd-devel cmake git curl p7zip p7zip-plugins';
  }
  if (findOnPath(['pacman'])) {
    return 'sudo pacman -S --needed base-devel pkgconf systemd cmake git curl 7zip';
  }
  if (findOnPath(['zypper'])) {
    return 'sudo zypper install -y gcc gcc-c++ make pkg-config systemd-devel cmake git curl 7zip';
  }
  return undefined;
}

function getLinuxPackageHint() {
  if (findOnPath(['apt-get'])) return 'APT: build-essential pkg-config libudev-dev cmake git curl 7zip';
  if (findOnPath(['dnf'])) return 'DNF: gcc gcc-c++ make pkgconf-pkg-config systemd-devel cmake git curl p7zip';
  if (findOnPath(['pacman'])) return 'pacman: base-devel pkgconf systemd cmake git curl 7zip';
  if (findOnPath(['zypper'])) return 'zypper: gcc gcc-c++ make pkg-config systemd-devel cmake git curl 7zip';
  return 'compiler + pkg-config + libudev development files + cmake + git + curl + 7-Zip extractor';
}

function expectedPathFor(id, expected) {
  const map = {
    msvc: expected.msvc,
    linuxBuild: getLinuxPackageHint(),
    rust: expected.rustup,
    probeRs: path.join(expected.cargoBin, process.platform === 'win32' ? 'probe-rs.exe' : 'probe-rs'),
    stlink: expected.stlinkDriverRoot,
    udev: expected.udevRules,
    jlink: process.platform === 'win32'
      ? path.join(expected.jlinkWindowsRoot, 'JLink*', 'JFlash.exe')
      : '/opt/SEGGER/JLink/JFlashExe',
    openocd: expected.openocd,
    armGcc: expected.armGcc,
    database: expected.database,
    sdk: expected.sdk,
    core: expected.core
  };
  return map[id] || '';
}

function pathStatus(target, successMessage) {
  const present = fs.existsSync(target);
  return {
    status: present ? 'installed' : 'missing',
    detail: present ? successMessage : 'Expected location not found.',
    expectedPath: target,
    version: ''
  };
}

function fileStatus(file, displayPath, successMessage) {
  const present = fs.existsSync(file);
  return {
    status: present ? 'installed' : 'missing',
    detail: present ? successMessage : 'Expected file not found.',
    expectedPath: displayPath,
    version: ''
  };
}

function unsupportedResult(detail, expectedPath) {
  return {
    status: 'unsupported',
    detail,
    expectedPath: expectedPath || '',
    version: ''
  };
}

function commandVersionWithFallback(command, args, fallbackPath) {
  const primary = commandVersion(command, args);
  if (primary.ok || !fallbackPath || !fs.existsSync(fallbackPath)) {
    return primary;
  }
  return commandVersion(fallbackPath, args);
}

function commandVersion(command, args) {
  try {
    const result = childProcess.spawnSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
      shell: false
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim().split(/\r?\n/)[0] || '';
    return { ok: result.status === 0, output };
  } catch {
    return { ok: false, output: '' };
  }
}

function findOnPath(names) {
  const pathValue = process.env.PATH || '';
  const directories = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];

  for (const directory of directories) {
    for (const name of names) {
      const hasExtension = Boolean(path.extname(name));
      const candidates = hasExtension ? [name] : extensions.map((extension) => `${name}${extension}`);
      for (const candidate of candidates) {
        const fullPath = path.join(directory, candidate);
        try {
          if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            return fullPath;
          }
        } catch {
          // Ignore inaccessible PATH entries.
        }
      }
    }
  }
  return undefined;
}

function findFile(root, targetName, maxDepth, directoryFilter) {
  return findFirstNamedFile(root, [targetName], maxDepth, directoryFilter);
}

function findFirstNamedFile(root, targetNames, maxDepth, directoryFilter) {
  if (!root || !fs.existsSync(root)) {
    return undefined;
  }

  const wanted = new Set(targetNames.map((name) => name.toLowerCase()));

  function walk(current, depth) {
    if (depth > maxDepth) {
      return undefined;
    }

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const entry of entries) {
      if (entry.isFile() && wanted.has(entry.name.toLowerCase())) {
        return path.join(current, entry.name);
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (depth === 0 && directoryFilter && !directoryFilter(entry.name)) {
        continue;
      }
      const found = walk(path.join(current, entry.name), depth + 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  return walk(root, 0);
}

function directoryHasContent(directory) {
  try {
    return fs.existsSync(directory) && fs.statSync(directory).isDirectory() && fs.readdirSync(directory).length > 0;
  } catch {
    return false;
  }
}

function expandHome(value) {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function getPlatformLabel() {
  const names = {
    win32: 'Windows',
    linux: 'Linux',
    darwin: 'macOS'
  };
  return `${names[process.platform] || process.platform} ${os.arch()}`;
}

function getSetupHtml(webview, extensionUri) {
  const nonce = getNonce();
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'setup.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'setup.js'));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>MikroBUS Rust Setup</title>
</head>
<body>
  <main class="page">
    <header class="hero">
      <div>
        <p class="eyebrow">MIKROBUS RUST</p>
        <h1>Development environment setup</h1>
        <p class="subtitle">The extension detects the current host platform and checks the packages required by the Rust MikroBUS workflow.</p>
      </div>
      <div class="heroActions"><button id="configureMcu" class="secondary">Configure MCU</button><button id="refresh" class="secondary">Refresh</button></div>
    </header>

    <section class="summary" aria-live="polite">
      <div><strong id="installedCount">–</strong><span>installed</span></div>
      <div><strong id="missingCount">–</strong><span>missing</span></div>
      <div class="storage platformStorage"><span>Platform</span><code id="platformLabel">Loading…</code></div>
      <div class="storage"><span>Extension-managed root</span><code id="managedRoot">Loading…</code><button id="settings" class="linkButton">Change</button></div>
    </section>

    <div id="platformNotice" class="notice hidden"></div>
    <section id="packageGrid" class="grid" aria-label="Package status"></section>

    <footer>
      <p>System packages use the host-specific installer or an integrated terminal command. OpenOCD, ARM GCC, database, SDK and core are downloaded, extracted and installed automatically into the extension-managed root.</p>
    </footer>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

function deactivate() {}

module.exports = { activate, deactivate };
