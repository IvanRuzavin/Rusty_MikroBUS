'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { nonce, escapeHtml } = require('./ui');

class DashboardProvider {
  constructor(extensionUri, getState) {
    this.extensionUri = extensionUri;
    this.getState = getState;
    this.view = undefined;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage(message => {
      const commandMap = {
        configure: 'mikroRust.configure',
        reconfigure: 'mikroRust.reconfigure',
        build: 'mikroRust.build',
        flash: 'mikroRust.flash',
        erase: 'mikroRust.erase',
        debug: 'mikroRust.debug',
        example: 'mikroRust.selectExample',
        setup: 'mikroRust.openGeneratedSetup',
        diagnostics: 'mikroRust.diagnostics',
        refresh: 'mikroRust.refreshDashboard',
      };
      if (commandMap[message?.type]) vscode.commands.executeCommand(commandMap[message.type]);
    });
    this.refresh();
  }

  async refresh() {
    if (!this.view) return;
    let state;
    try { state = await this.getState(); }
    catch (error) { state = { error: error.message }; }
    this.view.webview.html = this._html(this.view.webview, state);
  }

  _html(webview, state) {
    const n = nonce();
    const configured = Boolean(state?.manifest?.mcu?.name);
    const mcu = state?.manifest?.mcu || {};
    const rootReady = Boolean(state?.paths && fs.existsSync(state.paths.rootPath));
    const dbReady = Boolean(state?.paths && fs.existsSync(state.paths.databasePath));
    const coreReady = Boolean(state?.paths && fs.existsSync(state.paths.corePlatformRoot));
    const sdkReady = Boolean(state?.paths && fs.existsSync(state.paths.sdkRoot));
    const badge = (ok, label) => `<span class="badge ${ok ? 'ok' : 'bad'}"><span class="dot"></span>${escapeHtml(label)}</span>`;

    return `<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${n}'; script-src 'nonce-${n}';">
<style nonce="${n}">
*{box-sizing:border-box}body{margin:0;padding:14px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font-family:var(--vscode-font-family)}
.hero{padding:14px;border:1px solid var(--vscode-panel-border);border-radius:12px;background:linear-gradient(145deg,color-mix(in srgb,var(--vscode-focusBorder) 12%,transparent),transparent 70%);margin-bottom:12px}.kicker{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--vscode-descriptionForeground);font-weight:700}.title{font-size:18px;font-weight:700;margin:5px 0 6px}.sub{font-size:12px;line-height:1.45;color:var(--vscode-descriptionForeground)}
.section{margin:15px 0 7px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--vscode-descriptionForeground);font-weight:700}.card{border:1px solid var(--vscode-panel-border);border-radius:10px;padding:12px;margin-bottom:9px;background:var(--vscode-editor-background)}.mcu{font-size:16px;font-weight:700;margin-bottom:5px}.meta{display:grid;grid-template-columns:auto 1fr;gap:4px 8px;font-size:11px;color:var(--vscode-descriptionForeground)}.meta b{color:var(--vscode-foreground);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.badges{display:flex;flex-wrap:wrap;gap:6px}.badge{display:inline-flex;align-items:center;gap:5px;font-size:10px;border:1px solid var(--vscode-panel-border);border-radius:999px;padding:4px 7px;color:var(--vscode-descriptionForeground)}.dot{width:6px;height:6px;border-radius:50%;background:var(--vscode-errorForeground)}.ok .dot{background:var(--vscode-testing-iconPassed)}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}.actions .wide{grid-column:1/-1}button{min-width:0;border:1px solid transparent;border-radius:6px;padding:7px 8px;cursor:pointer;font:inherit;font-size:11px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:hover{filter:brightness(1.07)}.error{border-color:var(--vscode-inputValidation-errorBorder);color:var(--vscode-errorForeground);font-size:11px;line-height:1.45}.path{font-family:var(--vscode-editor-font-family);font-size:10px;word-break:break-all;color:var(--vscode-descriptionForeground);margin-top:8px}
</style></head><body>
<div class="hero"><div class="kicker">Embedded Rust</div><div class="title">Mikro Rust</div><div class="sub">NECTO-style configuration for mikroSDK-like Rust projects.</div></div>
${state?.error ? `<div class="card error">${escapeHtml(state.error)}</div>` : ''}
<div class="section">Workspace</div>
<div class="card"><div class="badges">${badge(rootReady,'Root')}${badge(dbReady,'Database')}${badge(coreReady,'Core')}${badge(sdkReady,'SDK')}</div>${state?.paths ? `<div class="path">${escapeHtml(state.paths.rootPath)}</div>` : ''}</div>
<div class="section">Target</div>
${configured ? `<div class="card"><div class="mcu">${escapeHtml(mcu.name)}</div><div class="meta"><span>Family</span><b>${escapeHtml(mcu.family)}</b><span>Target</span><b>${escapeHtml(mcu.target)}</b><span>Clock</span><b>${escapeHtml(state.manifest.clockMhz)} MHz</b><span>System</span><b>${escapeHtml(mcu.systemName)}</b></div></div>` : `<div class="card"><div class="sub">No MCU has been configured by this extension yet.</div></div>`}
<div class="section">Configuration</div><div class="actions">
<button class="primary wide" data-cmd="${configured ? 'reconfigure' : 'configure'}">${configured ? 'Reconfigure MCU' : 'Configure MCU'}</button>
<button data-cmd="example">Choose Example</button><button data-cmd="setup">Open Setup</button>
</div>
<div class="section">Project</div><div class="actions"><button class="primary" data-cmd="build">Build</button><button data-cmd="flash">Flash</button><button data-cmd="debug">Debug</button><button data-cmd="erase">Erase</button></div>
<div class="section">Tools</div><div class="actions"><button class="wide" data-cmd="diagnostics">Run Diagnostics</button></div>
<script nonce="${n}">const vscode=acquireVsCodeApi();document.querySelectorAll('[data-cmd]').forEach(b=>b.addEventListener('click',()=>vscode.postMessage({type:b.dataset.cmd})));</script>
</body></html>`;
  }
}

module.exports = { DashboardProvider };
