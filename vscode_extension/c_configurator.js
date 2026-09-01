'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const database = require('./c_database');
const packages = require('./c_package_manager');

const SUPPORTED_COMPILERS = ['gcc_arm_none_eabi'];
const SUPPORTED_PROGRAMMERS = new Set(['codegrip', 'segger_jlink']);
let cPanel;
let pendingSetupId;

function readJson(filePath, description) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${description || path.basename(filePath)} is invalid: ${error.message}`);
  }
}

function findRecursive(root, predicate, maximumDepth = 10) {
  if (!root || !fs.existsSync(root)) return undefined;
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(current.directory, entry.name);
      if (entry.isFile() && predicate(candidate, entry.name)) return candidate;
      if (entry.isDirectory() && current.depth < maximumDepth) queue.push({ directory: candidate, depth: current.depth + 1 });
    }
  }
  return undefined;
}

function findDefinitionFile(coreRoot, corePath, fileName) {
  const normalizedPath = String(corePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  const expected = String(fileName || '').toLowerCase();
  const directRoot = path.join(coreRoot, ...String(corePath || '').split(/[\\/]+/).filter(Boolean));
  const roots = fs.existsSync(directRoot) ? [directRoot, coreRoot] : [coreRoot];
  for (const root of roots) {
    const preferred = findRecursive(root, (candidate, name) => {
      if (name.toLowerCase() !== expected) return false;
      const normalizedCandidate = candidate.replace(/\\/g, '/').toLowerCase();
      return !normalizedPath || normalizedCandidate.includes(`/${normalizedPath}/`);
    });
    if (preferred) return preferred;
  }
  return findRecursive(coreRoot, (_candidate, name) => name.toLowerCase() === expected);
}

function fieldId(register, field) {
  return `${String(register?.key || '').trim()}.${String(field?.key || '').trim()}`;
}

function serializeDefinition(definition) {
  return (Array.isArray(definition.config_registers) ? definition.config_registers : []).map((register) => ({
    key: register.key,
    label: register.label || register.key,
    address: register.address,
    fields: (Array.isArray(register.fields) ? register.fields : [])
      .filter((field) => !field.hidden)
      .map((field) => ({
        id: fieldId(register, field),
        key: field.key,
        label: field.label || field.key,
        init: field.init,
        mask: field.mask,
        settings: (Array.isArray(field.settings) ? field.settings : []).map((setting) => ({
          label: setting.label,
          value: setting.value
        }))
      }))
  })).filter((register) => register.fields.length > 0);
}

function listSavedSetups(context) {
  const root = packages.getPackagePaths(context).setups;
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const directory of fs.readdirSync(root)) {
    const file = path.join(root, directory, 'setup.json');
    if (!fs.existsSync(file)) continue;
    try {
      const setup = readJson(file, 'C setup');
      result.push({
        id: setup.id,
        name: setup.name,
        deviceUid: setup.metadata?.device?.uid,
        boardName: setup.boardName || setup.metadata?.board?.name,
        selectionMode: setup.selectionMode || 'mcu',
        clockMHz: setup.clockMHz,
        mode: setup.mode,
        builtAt: setup.builtAt
      });
    } catch {
      // Broken setup files are handled by the C setup workflow itself.
    }
  }
  return result.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function loadSavedSetup(context, setupId) {
  if (!setupId) return undefined;
  const file = path.join(packages.getPackagePaths(context).setups, String(setupId), 'setup.json');
  if (!fs.existsSync(file)) throw new Error(`C setup '${setupId}' no longer exists.`);
  return readJson(file, `C setup ${setupId}`);
}

function getCoreEntry(context) {
  return packages.getInstalledPackage(context, { kind: 'core', name: 'C_core', version: '0.0.1' });
}

function environmentState(context) {
  const missing = [];
  try { database.validateDatabase(context); } catch { missing.push('C database'); }
  if (!getCoreEntry(context)) missing.push('C core');
  return missing;
}

function loadDeviceDetail(context, deviceUid, compilerUid, boardUid) {
  const compilers = database.listCompilers(context, deviceUid, SUPPORTED_COMPILERS);
  if (!compilers.length) throw new Error(`No supported ARM GCC compiler is mapped to ${deviceUid}.`);
  const compiler = compilers.find((item) => item.uid === compilerUid) || compilers[0];
  const info = database.getDeviceCoreInfo(context, deviceUid, compiler.uid);
  if (!info) throw new Error(`Unable to resolve core metadata for ${deviceUid}/${compiler.uid}.`);

  const coreEntry = getCoreEntry(context);
  if (!coreEntry?.root) throw new Error('Install the C core package before opening MCU clock configuration.');
  const definitionFile = findDefinitionFile(coreEntry.root, info.corePath, info.defFile || `${info.mcuName}.json`);
  if (!definitionFile) {
    throw new Error(`C_core.zip does not contain ${info.corePath}/def/${info.defFile || `${info.mcuName}.json`}.`);
  }
  const definition = readJson(definitionFile, `${deviceUid} clock definition`);
  const sdks = database.listSdks(context, deviceUid, compiler.uid).filter((sdk) => String(sdk.version) === '2.19.1');
  if (!sdks.length) throw new Error(`mikroSDK 2.19.1 is not mapped to ${deviceUid}/${compiler.uid}.`);
  const devicePackages = database.listDevicePackages(context, deviceUid);
  const programmers = database.listProgrammers(context, deviceUid, compiler.uid)
    .filter((programmer) => SUPPORTED_PROGRAMMERS.has(programmer.uid));
  if (!programmers.length) throw new Error(`No supported CODEGRIP or J-Link programmer is mapped to ${deviceUid}.`);
  const board = boardUid ? database.getBoard(context, boardUid) : undefined;

  return {
    device: info,
    compiler,
    sdk: sdks[0],
    packages: devicePackages,
    programmers,
    board,
    definitionPath: definitionFile,
    clockMHz: String(definition.clock || info.maxSpeed || '').replace(/\.0+$/, ''),
    registers: serializeDefinition(definition)
  };
}

async function sendInitialState(panel, context) {
  const missing = environmentState(context);
  if (missing.length) {
    void panel.webview.postMessage({ type: 'environmentMissing', missing, managedRoot: packages.getManagedRoot(context) });
    return;
  }
  const mcus = database.listDevices(context, SUPPORTED_COMPILERS);
  const boards = database.listBoards(context, SUPPORTED_COMPILERS);
  void panel.webview.postMessage({
    type: 'initialState',
    mcus,
    boards,
    setups: listSavedSetups(context),
    count: mcus.length
  });
  if (pendingSetupId) {
    const setup = loadSavedSetup(context, pendingSetupId);
    const selection = setup.selection || {};
    const detail = loadDeviceDetail(
      context,
      selection.deviceUid || setup.metadata?.device?.uid,
      selection.compilerUid || setup.metadata?.compiler?.uid,
      selection.boardUid || setup.boardUid || setup.metadata?.board?.uid
    );
    void panel.webview.postMessage({
      type: 'editSetup',
      detail,
      selectionMode: setup.selectionMode === 'board' ? 'board' : 'mcu',
      setup: {
        id: setup.id,
        name: setup.name,
        mode: setup.mode,
        applicationOutput: setup.applicationOutput,
        clockMHz: setup.clockMHz,
        registerValues: setup.registerValues || {},
        packageUid: selection.packageUid || setup.metadata?.devicePackage?.uid,
        programmerUid: selection.programmerUid || setup.metadata?.programmer?.uid,
        boardUid: selection.boardUid || setup.boardUid || setup.metadata?.board?.uid
      }
    });
  }
}

async function handleMessage(message, panel, context) {
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'ready' || message.type === 'refresh') {
    await sendInitialState(panel, context);
    return;
  }
  if (message.type === 'openEnvironment') {
    await vscode.commands.executeCommand('mikrobusC.installEnvironment');
    await sendInitialState(panel, context);
    return;
  }
  if (message.type === 'selectMcu' && typeof message.uid === 'string') {
    const detail = loadDeviceDetail(context, message.uid, message.compilerUid);
    void panel.webview.postMessage({ type: 'deviceDetail', detail, selectionMode: 'mcu' });
    return;
  }
  if (message.type === 'selectBoard' && typeof message.uid === 'string') {
    const board = database.getBoard(context, message.uid);
    if (!board) throw new Error(`Board '${message.uid}' was not found in the C database.`);
    const devices = database.listBoardDevices(context, message.uid, SUPPORTED_COMPILERS);
    if (!devices.length) throw new Error(`${board.name || board.uid} has no supported ARM/GCC MCU mapping.`);
    if (devices.length === 1) {
      const detail = loadDeviceDetail(context, devices[0].uid, undefined, board.uid);
      void panel.webview.postMessage({ type: 'deviceDetail', detail, selectionMode: 'board' });
    } else {
      void panel.webview.postMessage({ type: 'boardDevices', board, devices });
    }
    return;
  }
  if (message.type === 'selectBoardDevice' && typeof message.boardUid === 'string' && typeof message.deviceUid === 'string') {
    const detail = loadDeviceDetail(context, message.deviceUid, message.compilerUid, message.boardUid);
    void panel.webview.postMessage({ type: 'deviceDetail', detail, selectionMode: 'board' });
    return;
  }
  if (message.type === 'buildConfiguration') {
    const payload = message.payload || {};
    const required = ['deviceUid', 'compilerUid', 'sdkUid', 'programmerUid', 'name'];
    const missing = required.filter((key) => !String(payload[key] || '').trim());
    if (missing.length) throw new Error(`Configuration is incomplete: ${missing.join(', ')}.`);
    if (!(Number(payload.clockMHz) > 0)) throw new Error('Clock must be a positive value in MHz.');
    const setup = await vscode.commands.executeCommand('mikrobusC.createSetupFromVisual', payload);
    if (setup) {
      if (payload.setupId) pendingSetupId = undefined;
      void panel.webview.postMessage({ type: 'configurationBuilt', setup, setups: listSavedSetups(context) });
      await vscode.commands.executeCommand('mikrobusRust.refreshSetupView');
    }
    return;
  }
  if (message.type === 'applySetup' && typeof message.id === 'string') {
    await vscode.commands.executeCommand('mikrobusC.applySetup', message.id);
    await vscode.commands.executeCommand('mikrobusRust.refreshSetupView');
    return;
  }
}

function nonce() {
  return crypto.randomBytes(16).toString('hex');
}

function html(webview, extensionUri) {
  const token = nonce();
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'mcu.css'));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'c_mcu.js'));
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${token}';">
<link rel="stylesheet" href="${style}"><title>MikroBUS C Hardware Configuration</title></head>
<body><div id="app" class="app">
<header class="topbar"><div><div class="eyebrow">MIKROBUS C</div><h1>Hardware Configuration</h1><p>Select a board or MCU, configure its clock registers from the core JSON, then build a reusable C setup.</p></div>
<div class="topActions"><button id="refresh" class="secondary">Refresh</button></div></header>
<div id="missingState" class="missing hidden"></div>
<main id="workspace" class="workspace hidden">
<section id="startView" class="pageView selectionStart"><div class="viewHeader"><div><div class="eyebrow">NEW C CONFIGURATION</div><h2>What do you want to start from?</h2><p>Board selection resolves its compatible MCU from the C database; MCU selection starts directly from the device.</p></div></div>
<div class="selectionCards"><button id="chooseMcuMode" class="selectionCard"><strong>MCU</strong><span>Choose a device directly, then configure its clock/register parameters, package and programmer.</span></button><button id="chooseBoardMode" class="selectionCard"><strong>Board</strong><span>Choose a development board, resolve a compatible MCU, then configure the same clock/register parameters.</span></button></div></section>

<section id="catalogView" class="pageView hidden"><div class="viewNav managerNav"><button class="secondary backStart">← MCU or Board</button></div><div class="viewHeader"><div><div class="eyebrow">AVAILABLE DEVICES</div><h2>MCU catalog</h2><p>Only MCUs mapped to the supported ARM GCC compiler are shown.</p></div><div class="catalogTools"><label class="searchBox"><span>Search</span><input id="mcuSearch" type="search" placeholder="MCU, vendor, family..."></label><div class="resultCount"><strong id="mcuCount">0</strong><span>MCUs</span></div></div></div><div class="tableShell"><table class="dataTable"><thead><tr><th>MCU</th><th>Vendor</th><th>Family</th><th>Max clock</th><th>Flash</th><th>RAM</th></tr></thead><tbody id="mcuTableBody"></tbody></table></div></section>

<section id="boardCatalogView" class="pageView hidden"><div class="viewNav managerNav"><button class="secondary backStart">← MCU or Board</button></div><div class="viewHeader"><div><div class="eyebrow">AVAILABLE BOARDS</div><h2>Board catalog</h2><p>Only boards with at least one supported ARM/GCC MCU are shown.</p></div><div class="catalogTools"><label class="searchBox"><span>Search</span><input id="boardSearch" type="search" placeholder="Board, vendor, category..."></label><div class="resultCount"><strong id="boardCount">0</strong><span>Boards</span></div></div></div><div class="tableShell"><table class="dataTable boardTable"><thead><tr><th>Board</th><th>Vendor</th><th>Category</th><th>Compatible MCUs</th></tr></thead><tbody id="boardTableBody"></tbody></table></div></section>

<section id="boardDeviceView" class="pageView hidden"><div class="viewNav managerNav"><button id="backToBoards" class="secondary">← Boards</button></div><div class="viewHeader"><div><div class="eyebrow">BOARD MCU</div><h2 id="boardDeviceTitle"></h2><p>This board supports multiple C targets. Select the MCU installed on the board or MCU card.</p></div></div><div class="tableShell"><table class="dataTable"><thead><tr><th>MCU</th><th>Vendor</th><th>Family</th><th>Max clock</th></tr></thead><tbody id="boardDeviceTableBody"></tbody></table></div></section>

<section id="loadingView" class="loadingView hidden"><div class="chipIcon">C</div><h2 id="loadingText">Loading...</h2></section>

<section id="configView" class="pageView hidden"><div class="viewNav"><button id="backToSelection" class="secondary">← Selection</button></div>
<div class="deviceHeader"><div><div class="eyebrow">C MCU SETTINGS</div><div class="titleWithBadge"><h2 id="selectedName"></h2><span class="statusBadge available">Core JSON</span></div></div><div class="metaGrid"><div><span>Vendor</span><strong id="selectedVendor"></strong></div><div><span>Family</span><strong id="selectedFamily"></strong></div><div><span>Compiler</span><code id="selectedCompiler"></code></div><div><span>Core path</span><code id="selectedCorePath"></code></div></div></div>
<section id="selectedBoardCard" class="clockSection card hidden"><div><h3 id="selectedBoardName"></h3><p id="selectedBoardInfo"></p></div></section>
<section class="clockSection card"><div><h3>Setup</h3><p>Choose how this reusable C environment will be built.</p></div><div class="cSetupOptions"><label class="clockInput">Setup name<input id="setupName" type="text"></label><label class="clockInput">Mode<select id="setupMode"><option value="full-sdk">mikroSDK 2.19.1 + core</option><option value="bare-metal">Bare metal core</option></select></label><label class="clockInput">Application output<select id="applicationOutput"><option value="debug-terminal">Debug Terminal (printf_me)</option><option value="uart">UART</option></select></label><label class="clockInput">MCU package<select id="packageSelect"></select></label><label class="clockInput">Programmer<select id="programmerSelect"></select></label></div></section>
<section class="clockSection card"><div><h3>System clock</h3><p>The default comes from <code>def/&lt;MCU_NAME&gt;.json</code>. The value is written to <code>FOSC_KHZ_VALUE</code>.</p></div><label class="clockInput">Clock (MHz)<input id="clockMhz" type="number" min="1" step="0.001"></label></section>
<section><div class="sectionHeading"><div><h3>Clock / configuration registers</h3><p>Visible options come directly from <code>config_registers</code> in the MCU JSON. Hidden fields preserve their JSON <code>init</code> value.</p></div></div><div id="registerGrid" class="registerGrid"></div></section>
<div class="definitionPath"><span>Definition</span><code id="definitionPath"></code></div>
<div class="generateBar"><div id="generationStatus" class="generationStatus"></div><button id="generate" class="primary">Build C Configuration</button></div></section>
</main></div><script nonce="${token}" src="${script}"></script></body></html>`;
}

async function openCConfigurator(context, setupId) {
  pendingSetupId = setupId || undefined;
  if (cPanel) {
    cPanel.reveal(vscode.ViewColumn.Active);
    await sendInitialState(cPanel, context);
    return;
  }
  cPanel = vscode.window.createWebviewPanel(
    'mikrobusC.hardwareConfigurator',
    'MikroBUS C: Hardware Configuration',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    }
  );
  cPanel.webview.html = html(cPanel.webview, context.extensionUri);
  cPanel.webview.onDidReceiveMessage(async (message) => {
    try {
      await handleMessage(message, cPanel, context);
    } catch (error) {
      const text = error?.message || String(error);
      vscode.window.showErrorMessage(`MikroBUS C: ${text}`);
      if (cPanel) void cPanel.webview.postMessage({ type: 'error', message: text });
    }
  }, null, context.subscriptions);
  cPanel.onDidDispose(() => { cPanel = undefined; pendingSetupId = undefined; }, null, context.subscriptions);
}

module.exports = {
  openCConfigurator,
  _test: { fieldId, serializeDefinition, findDefinitionFile }
};
