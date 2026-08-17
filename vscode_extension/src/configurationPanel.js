'use strict';

const vscode = require('vscode');
const { nonce, escapeHtml, jsonForScript } = require('./ui');
const { defaultSelections, fieldId } = require('./configurationEngine');

class ConfigurationPanel {
  constructor(extensionUri, onApply) {
    this.extensionUri = extensionUri;
    this.onApply = onApply;
    this.panel = undefined;
  }

  show(mcu, definition, initialManifest) {
    if (this.panel) this.panel.dispose();
    this.panel = vscode.window.createWebviewPanel(
      'mikroRust.configuration',
      `Configure ${mcu.name}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const selections = { ...defaultSelections(definition), ...(initialManifest?.selections || {}) };
    const clock = initialManifest?.clockMhz ?? definition.clock ?? '';
    this.panel.webview.html = this._html(this.panel.webview, mcu, definition, selections, clock);
    this.panel.webview.onDidReceiveMessage(async message => {
      if (message?.type === 'apply') {
        try {
          await this.onApply({
            mcu,
            definition,
            clockMhz: message.clockMhz,
            selections: message.selections || {},
          });
          this.panel?.webview.postMessage({ type: 'applied' });
        } catch (error) {
          this.panel?.webview.postMessage({ type: 'error', message: error.message });
        }
      } else if (message?.type === 'close') {
        this.panel?.dispose();
      }
    });
    this.panel.onDidDispose(() => { this.panel = undefined; });
  }

  _html(webview, mcu, definition, selections, clock) {
    const n = nonce();
    const fields = [];
    for (const reg of definition.config_registers || []) {
      (reg.fields || []).forEach((field, index) => {
        if (field.hidden) return;
        fields.push({
          id: fieldId(reg, field, index),
          register: reg.key,
          address: reg.address,
          key: field.key,
          label: field.label || field.key,
          init: field.init,
          settings: field.settings || [],
        });
      });
    }

    const data = { mcu, fields, selections, clock };
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${n}'; script-src 'nonce-${n}';">
<style nonce="${n}">
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0 0 92px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .hero { padding: 30px 32px 26px; background: linear-gradient(135deg, color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent), transparent 64%); border-bottom: 1px solid var(--vscode-panel-border); }
  .eyebrow { color: var(--vscode-descriptionForeground); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .12em; }
  h1 { margin: 7px 0 10px; font-size: 28px; line-height: 1.15; }
  .subtitle { max-width: 820px; color: var(--vscode-descriptionForeground); line-height: 1.55; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
  .chip { border: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); border-radius: 999px; padding: 6px 10px; font-size: 12px; }
  .content { padding: 24px 32px; max-width: 1180px; margin: 0 auto; }
  .section-title { display:flex; justify-content:space-between; gap:16px; align-items:end; margin: 8px 0 12px; }
  .section-title h2 { margin:0; font-size:17px; }
  .section-title span { color:var(--vscode-descriptionForeground); font-size:12px; }
  .clock-card { display:grid; grid-template-columns: minmax(180px, 1fr) minmax(180px, 320px); gap:22px; align-items:center; border:1px solid var(--vscode-panel-border); background:var(--vscode-sideBar-background); border-radius:12px; padding:18px; margin-bottom:24px; }
  .clock-card strong { display:block; margin-bottom:4px; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; line-height:1.45; }
  .grid { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:12px; }
  .field { border:1px solid var(--vscode-panel-border); background:var(--vscode-sideBar-background); border-radius:10px; padding:14px; min-width:0; }
  .field-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:9px; }
  .field label { font-weight:600; line-height:1.3; }
  .reg { color:var(--vscode-descriptionForeground); font-size:11px; font-family:var(--vscode-editor-font-family); white-space:nowrap; }
  input, select { width:100%; min-height:34px; border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); background:var(--vscode-input-background); color:var(--vscode-input-foreground); padding:6px 9px; border-radius:6px; outline:none; }
  input:focus, select:focus { border-color:var(--vscode-focusBorder); }
  .empty { padding:24px; text-align:center; border:1px dashed var(--vscode-panel-border); border-radius:10px; color:var(--vscode-descriptionForeground); }
  .footer { position:fixed; left:0; right:0; bottom:0; display:flex; justify-content:flex-end; align-items:center; gap:10px; padding:14px 24px; background:color-mix(in srgb, var(--vscode-editor-background) 92%, transparent); border-top:1px solid var(--vscode-panel-border); backdrop-filter: blur(10px); }
  .status { margin-right:auto; color:var(--vscode-descriptionForeground); font-size:12px; max-width:52%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  button { border:1px solid transparent; border-radius:6px; padding:8px 14px; cursor:pointer; font:inherit; }
  button.primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
  button.primary:hover { background:var(--vscode-button-hoverBackground); }
  button.secondary { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
  button:disabled { opacity:.55; cursor:default; }
  @media (max-width: 760px) { .hero,.content { padding-left:18px; padding-right:18px; } .grid { grid-template-columns:1fr; } .clock-card { grid-template-columns:1fr; } }
</style>
</head>
<body>
  <div class="hero">
    <div class="eyebrow">NECTO-style Rust configuration</div>
    <h1>${escapeHtml(mcu.name)}</h1>
    <div class="subtitle">Select the clock and configuration-register values. Applying this setup generates the same core, linker, startup, pin-mapping and HAL selection files used by the supplied application, but directly inside the VS Code workspace.</div>
    <div class="chips">
      <div class="chip">${escapeHtml(mcu.vendor || 'Vendor')}</div>
      <div class="chip">Family: ${escapeHtml(mcu.family)}</div>
      <div class="chip">Target: ${escapeHtml(mcu.target)}</div>
      <div class="chip">System: ${escapeHtml(mcu.systemName)}</div>
    </div>
  </div>
  <main class="content">
    <div class="section-title"><h2>Clock</h2><span>Used to generate FOSC_KHZ_VALUE</span></div>
    <div class="clock-card">
      <div><strong>System clock</strong><div class="muted">Enter the MCU clock in MHz. The original configurator requires an integer value.</div></div>
      <input id="clock" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(clock)}" aria-label="Clock in MHz">
    </div>
    <div class="section-title"><h2>Configuration registers</h2><span>${fields.length} configurable field${fields.length === 1 ? '' : 's'}</span></div>
    <div id="grid" class="grid"></div>
  </main>
  <div class="footer">
    <div id="status" class="status">Ready to configure</div>
    <button id="cancel" class="secondary">Cancel</button>
    <button id="apply" class="primary">Apply Configuration</button>
  </div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const data = ${jsonForScript(data)};
  const selections = { ...data.selections };
  const grid = document.getElementById('grid');
  const status = document.getElementById('status');
  const apply = document.getElementById('apply');

  function makeField(field) {
    const card = document.createElement('div');
    card.className = 'field';
    const head = document.createElement('div'); head.className = 'field-head';
    const label = document.createElement('label'); label.textContent = field.label;
    const reg = document.createElement('span'); reg.className = 'reg'; reg.textContent = field.register + ' @ 0x' + field.address;
    head.append(label, reg); card.appendChild(head);
    const select = document.createElement('select');
    select.setAttribute('aria-label', field.label);
    for (const setting of field.settings) {
      const option = document.createElement('option');
      option.value = setting.value; option.textContent = setting.label;
      if (String(selections[field.id]).toLowerCase() === String(setting.value).toLowerCase()) option.selected = true;
      select.appendChild(option);
    }
    if (!field.settings.length) {
      const option = document.createElement('option'); option.value = field.init || '0x0'; option.textContent = field.init || '0x0'; select.appendChild(option);
    }
    selections[field.id] = select.value;
    select.addEventListener('change', () => { selections[field.id] = select.value; status.textContent = 'Unsaved changes'; });
    card.appendChild(select); return card;
  }
  if (data.fields.length) data.fields.forEach(field => grid.appendChild(makeField(field)));
  else { const empty = document.createElement('div'); empty.className='empty'; empty.textContent='This MCU definition has no visible configuration-register fields.'; grid.appendChild(empty); }
  document.getElementById('clock').addEventListener('input', () => { status.textContent = 'Unsaved changes'; });
  document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({type:'close'}));
  apply.addEventListener('click', () => {
    const clockMhz = document.getElementById('clock').value;
    if (!/^\\d+$/.test(clockMhz) || Number(clockMhz) <= 0) { status.textContent = 'Clock must be a positive integer in MHz'; return; }
    apply.disabled = true; status.textContent = 'Generating configuration…';
    vscode.postMessage({ type:'apply', clockMhz:Number(clockMhz), selections });
  });
  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'applied') { status.textContent = 'Configuration applied successfully'; apply.disabled = false; apply.textContent = 'Apply Again'; }
    if (msg.type === 'error') { status.textContent = msg.message || 'Configuration failed'; apply.disabled = false; }
  });
</script>
</body>
</html>`;
  }
}

module.exports = { ConfigurationPanel };
