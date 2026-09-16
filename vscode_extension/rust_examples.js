'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const vscode = require('vscode');
const packages = require('./c_package_manager');

const CLICK_RELEASE_TAG = 'click-packages';
const DEMO_RELEASE_TAG = 'demo-packages';
const RELEASE_BASE = 'https://github.com/IvanRuzavin/Rusty_MikroBUS/releases/download';
const CLICK_METADATA_URL = `${RELEASE_BASE}/${CLICK_RELEASE_TAG}/metadata_clicks_rust.json`;
const DEMO_METADATA_URL = `${RELEASE_BASE}/${DEMO_RELEASE_TAG}/metadata_demos_rust.json`;

let clickPanel;
let demoPanel;
let clickCache;
let clickCacheAt = 0;
let demoCache;
let demoCacheAt = 0;
let clickSpecs = [];
let demoSpecs = [];

function requestBuffer(url, redirects = 0) {
  if (redirects > 8) return Promise.reject(new Error(`Too many redirects while downloading ${url}`));
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const request = client.get(parsed, {
      headers: {
        Accept: 'application/json, application/octet-stream;q=0.9, */*;q=0.8',
        'User-Agent': 'mikrobus-rust-vscode-extension'
      }
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        resolve(requestBuffer(new URL(response.headers.location, parsed).toString(), redirects + 1));
        return;
      }
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode || 'error'} while downloading ${url}`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('error', reject);
  });
}

async function fetchJson(url) {
  const buffer = await requestBuffer(url);
  try { return JSON.parse(buffer.toString('utf8')); }
  catch (error) { throw new Error(`Invalid JSON downloaded from ${url}: ${error.message}`); }
}

async function loadClickMetadata(force = false) {
  if (!force && clickCache && Date.now() - clickCacheAt < 10 * 60 * 1000) return clickCache;
  const parsed = await fetchJson(CLICK_METADATA_URL);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Rust Click metadata must be a JSON object keyed by category.');
  }
  const normalized = {};
  for (const [category, entries] of Object.entries(parsed)) {
    if (!Array.isArray(entries)) continue;
    normalized[category] = entries.filter((item) => item && typeof item === 'object' && item.name && item.download_link);
  }
  clickCache = normalized;
  clickCacheAt = Date.now();
  return normalized;
}

async function loadDemoMetadata(force = false) {
  if (!force && demoCache && Date.now() - demoCacheAt < 10 * 60 * 1000) return demoCache;
  const parsed = await fetchJson(DEMO_METADATA_URL);
  if (!Array.isArray(parsed)) throw new Error('Rust Demo metadata must be a JSON array.');
  demoCache = parsed.filter((item) => item && typeof item === 'object' && item.name && item.download_link);
  demoCacheAt = Date.now();
  return demoCache;
}

function archiveStem(url, fallback) {
  try { return path.basename(new URL(url).pathname).replace(/\.(zip|7z)$/i, ''); }
  catch { return fallback; }
}

function safeName(value) {
  return String(value || '').trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'example';
}

function clickSpec(category, item) {
  const displayName = String(item.name || '').trim();
  const downloadUrl = String(item.download_link || '').trim();
  const name = safeName(archiveStem(downloadUrl, displayName));
  return {
    kind: 'rust-click-example',
    name,
    version: 'current',
    displayName,
    environment: false,
    category: String(category || 'Rust'),
    downloadUrl,
    installRelativePath: `rust-click-examples/${name}`,
    detail: `Rust Click Board example · ${String(category || 'Rust')}`
  };
}

function demoSpec(item) {
  const displayName = String(item.name || '').trim();
  const downloadUrl = String(item.download_link || '').trim();
  const name = safeName(archiveStem(downloadUrl, displayName));
  return {
    kind: 'rust-demo-example',
    name,
    version: 'current',
    displayName,
    environment: false,
    downloadUrl,
    installRelativePath: `rust-demo-examples/${name}`,
    detail: 'Rust Demo example'
  };
}

async function availableClickSpecs(force = false) {
  const metadata = await loadClickMetadata(force);
  const result = [];
  for (const [category, entries] of Object.entries(metadata)) {
    for (const item of entries) result.push(clickSpec(category, item));
  }
  return result.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

async function availableDemoSpecs(force = false) {
  return (await loadDemoMetadata(force)).map(demoSpec).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function stateFor(context, spec) {
  const installed = packages.getInstalledPackage(context, spec);
  return {
    ...spec,
    key: packages.packageKey(spec),
    status: installed ? 'installed' : 'missing',
    root: installed?.root || packages.packageTarget(context, spec)
  };
}

function findProjectRoot(root) {
  if (!root || !fs.existsSync(root)) return undefined;
  const resolved = path.resolve(root);
  for (const marker of ['Cargo.toml', 'manifest.json']) {
    if (fs.existsSync(path.join(resolved, marker))) return resolved;
  }
  const queue = [{ dir: resolved, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
    if (entries.some((entry) => entry.isFile() && entry.name === 'Cargo.toml')) return current.dir;
    if (current.depth >= 6) continue;
    for (const entry of entries) {
      if (entry.isDirectory() && !['target', '.git', 'node_modules'].includes(entry.name)) {
        queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  }
  return resolved;
}

function examplesHtml(kind) {
  const isClick = kind === 'click';
  const title = isClick ? 'Rust Click Board Examples' : 'Rust Demo Examples';
  const noun = isClick ? 'Click Board' : 'Demo';
  const nonce = crypto.randomBytes(16).toString('hex');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>${title}</title><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:1180px;margin:auto}h1,h3{margin:0}.muted{color:var(--vscode-descriptionForeground)}.toolbar{display:grid;grid-template-columns:minmax(220px,1fr)${isClick ? ' minmax(180px,280px)' : ''};gap:10px;margin-top:20px}.toolbar input,.toolbar select{width:100%;box-sizing:border-box;padding:9px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}.summary{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}.summary span,.summary .filterChip{padding:5px 9px;border:1px solid var(--vscode-panel-border);border-radius:999px}.summary .filterChip{font:inherit;color:var(--vscode-foreground);background:transparent;cursor:pointer}.summary .filterChip:hover{background:var(--vscode-toolbar-hoverBackground)}.summary .filterChip.active{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.grid{display:grid;gap:10px;margin-top:18px}.card{border:1px solid var(--vscode-panel-border);border-left:3px solid var(--vscode-testing-iconFailed);border-radius:7px;padding:14px;display:flex;align-items:center;justify-content:space-between;gap:18px}.card.installed{border-left-color:var(--vscode-testing-iconPassed)}.meta{display:flex;gap:8px;flex-wrap:wrap;color:var(--vscode-descriptionForeground);font-size:12px;margin-top:6px}.actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}button{border:0;border-radius:3px;padding:8px 14px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}button.danger{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:1px solid var(--vscode-inputValidation-errorBorder,var(--vscode-panel-border))}.empty,.loading{padding:32px;border:1px dashed var(--vscode-panel-border);text-align:center;border-radius:8px;color:var(--vscode-descriptionForeground)}code{font-family:var(--vscode-editor-font-family);font-size:11px;word-break:break-all}@media(max-width:650px){.toolbar{grid-template-columns:1fr}.card{align-items:flex-start;flex-direction:column}.actions{justify-content:flex-start}}
</style></head><body><h1>${title}</h1><p class="muted">Browse, install and open Rust ${noun} example projects.</p>
<div class="toolbar"><input id="search" type="search" placeholder="Search ${noun} examples…" autocomplete="off">${isClick ? '<select id="category"><option value="">All categories</option></select>' : ''}</div>
<section class="summary"><span id="shown">0 shown</span><button id="installed" class="filterChip" type="button" title="Show only installed examples" aria-pressed="false">0 installed</button><span id="total">0 total</span></section><main id="packages" class="grid"><div class="loading">Downloading ${noun} metadata…</div></main>
<script nonce="${nonce}">const vscode=acquireVsCodeApi();const root=document.getElementById('packages');const search=document.getElementById('search');const category=${isClick ? "document.getElementById('category')" : 'null'};const installedChip=document.getElementById('installed');let all=[];let installedOnly=false;function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}function render(){const q=search.value.trim().toLowerCase();const cat=category?category.value:'';const items=all.filter(p=>(!installedOnly||p.status==='installed')&&(!cat||p.category===cat)&&(!q||[p.displayName,p.name,p.category].some(v=>String(v||'').toLowerCase().includes(q))));document.getElementById('shown').textContent=items.length+' shown';const installedCount=all.filter(p=>p.status==='installed').length;installedChip.textContent=installedOnly?installedCount+' installed · showing only':installedCount+' installed';installedChip.classList.toggle('active',installedOnly);installedChip.setAttribute('aria-pressed',String(installedOnly));document.getElementById('total').textContent=all.length+' total';if(!items.length){root.innerHTML='<div class="empty">No examples match this filter.</div>';return;}root.innerHTML=items.map(p=>'<article class="card '+esc(p.status||'missing')+'"><div><h3>'+esc(p.displayName)+'</h3><div class="meta">'+(p.category?'<span>'+esc(p.category)+'</span>':'')+'<span>'+esc(p.status||'missing')+'</span></div>'+(p.status==='installed'?'<p><code>'+esc(p.root||'')+'</code></p>':'')+'</div><div class="actions">'+(p.status==='installed'?'<button class="secondary" data-open="'+esc(p.key)+'">Open Project</button><button class="danger" data-uninstall="'+esc(p.key)+'">Uninstall</button>':'<button data-install="'+esc(p.key)+'">Install</button>')+'</div></article>').join('');}root.onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.install)vscode.postMessage({type:'install',key:b.dataset.install});else if(b.dataset.uninstall)vscode.postMessage({type:'uninstall',key:b.dataset.uninstall});else if(b.dataset.open)vscode.postMessage({type:'openProject',key:b.dataset.open});};search.oninput=render;if(category)category.onchange=render;installedChip.addEventListener('click',()=>{installedOnly=!installedOnly;render();});window.addEventListener('message',e=>{if(e.data?.type==='state'){all=e.data.items||[];if(category){const current=category.value;const categories=e.data.categories||[];category.innerHTML='<option value="">All categories</option>'+categories.map(c=>'<option value="'+esc(c)+'">'+esc(c)+'</option>').join('');category.value=categories.includes(current)?current:'';}render();}});vscode.postMessage({type:'ready'});</script></body></html>`;
}

async function postClickState(context, force = false) {
  if (!clickPanel) return;
  clickSpecs = await availableClickSpecs(force);
  const items = clickSpecs.map((spec) => stateFor(context, spec));
  const categories = [...new Set(items.map((item) => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  void clickPanel.webview.postMessage({ type: 'state', items, categories });
}

async function postDemoState(context, force = false) {
  if (!demoPanel) return;
  demoSpecs = await availableDemoSpecs(force);
  void demoPanel.webview.postMessage({ type: 'state', items: demoSpecs.map((spec) => stateFor(context, spec)) });
}

async function installExample(context, kind, key) {
  const list = kind === 'click' ? clickSpecs : demoSpecs;
  let spec = list.find((item) => packages.packageKey(item) === key);
  if (!spec) {
    const refreshed = kind === 'click' ? await availableClickSpecs(false) : await availableDemoSpecs(false);
    spec = refreshed.find((item) => packages.packageKey(item) === key);
  }
  if (!spec) throw new Error(`Example '${key}' is no longer present in metadata.`);
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing ${spec.displayName}`, cancellable: true }, async (progress, token) => {
    await packages.ensurePackage(context, spec, progress, token);
  });
}

async function openProject(context, key, expectedKind) {
  const entry = packages.getInstalledPackage(context, key);
  if (!entry || entry.kind !== expectedKind) throw new Error('The Rust example is not installed.');
  const root = findProjectRoot(entry.root);
  if (!root) throw new Error(`${entry.displayName || entry.name} does not contain a Rust project that can be opened.`);
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), false);
}

async function openClickExamples(context) {
  if (clickPanel) { clickPanel.reveal(vscode.ViewColumn.Active); await postClickState(context, false); return; }
  clickPanel = vscode.window.createWebviewPanel('mikrobusRust.clickExamples', 'MikroBUS Rust: Click Board Examples', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  clickPanel.webview.html = examplesHtml('click');
  clickPanel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (message?.type === 'ready') await postClickState(context, true);
      if (message?.type === 'install' && typeof message.key === 'string') { await installExample(context, 'click', message.key); await postClickState(context, false); }
      if (message?.type === 'uninstall' && typeof message.key === 'string') { if (await packages.uninstallPackage(context, message.key)) await postClickState(context, false); }
      if (message?.type === 'openProject' && typeof message.key === 'string') await openProject(context, message.key, 'rust-click-example');
    } catch (error) { vscode.window.showErrorMessage(`MikroBUS Rust Click Board Examples: ${error.message || error}`); }
  }, null, context.subscriptions);
  clickPanel.onDidDispose(() => { clickPanel = undefined; }, null, context.subscriptions);
  await postClickState(context, true);
}

async function openDemoExamples(context) {
  if (demoPanel) { demoPanel.reveal(vscode.ViewColumn.Active); await postDemoState(context, false); return; }
  demoPanel = vscode.window.createWebviewPanel('mikrobusRust.demoExamples', 'MikroBUS Rust: Demo Examples', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  demoPanel.webview.html = examplesHtml('demo');
  demoPanel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (message?.type === 'ready') await postDemoState(context, true);
      if (message?.type === 'install' && typeof message.key === 'string') { await installExample(context, 'demo', message.key); await postDemoState(context, false); }
      if (message?.type === 'uninstall' && typeof message.key === 'string') { if (await packages.uninstallPackage(context, message.key)) await postDemoState(context, false); }
      if (message?.type === 'openProject' && typeof message.key === 'string') await openProject(context, message.key, 'rust-demo-example');
    } catch (error) { vscode.window.showErrorMessage(`MikroBUS Rust Demo Examples: ${error.message || error}`); }
  }, null, context.subscriptions);
  demoPanel.onDidDispose(() => { demoPanel = undefined; }, null, context.subscriptions);
  await postDemoState(context, true);
}

module.exports = {
  openClickExamples,
  openDemoExamples,
  _test: { clickSpec, demoSpec, findProjectRoot, examplesHtml }
};
