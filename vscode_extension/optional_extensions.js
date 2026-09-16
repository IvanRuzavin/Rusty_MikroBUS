'use strict';

const vscode = require('vscode');

const EXTENSIONS = Object.freeze({
  CORTEX_DEBUG: Object.freeze({ id: 'marus25.cortex-debug', label: 'Cortex-Debug' }),
  CPPTOOLS: Object.freeze({ id: 'ms-vscode.cpptools', label: 'Microsoft C/C++' }),
  RENESAS_DEBUG: Object.freeze({ id: 'RenesasElectronicsCorporation.renesas-debug', label: 'Renesas Debug' }),
  MPLAB_SERVICES: Object.freeze({ id: 'Microchip.mplab-extensions-core', label: 'MPLAB Services' }),
  MPLAB_PLATFORM: Object.freeze({ id: 'Microchip.mplab-extensions-platforms', label: 'MPLAB Platform' }),
  MPLAB_DEBUG: Object.freeze({ id: 'Microchip.mplab-core-da', label: 'Microchip Debug Adapter for MPLAB' }),
  TI_EMBEDDED_DEBUG: Object.freeze({ id: 'ti-development-tools.ti-embedded-debug', label: 'TI Embedded Debug' })
});

function requirement(id, label) {
  return { id: String(id || '').trim(), label: String(label || id || '').trim() };
}

function uniqueRequirements(requirements = []) {
  const result = [];
  const seen = new Set();
  for (const item of requirements || []) {
    if (!item) continue;
    const normalized = typeof item === 'string' ? requirement(item, item) : requirement(item.id, item.label);
    if (!normalized.id || seen.has(normalized.id.toLowerCase())) continue;
    seen.add(normalized.id.toLowerCase());
    result.push(normalized);
  }
  return result;
}

function installedExtension(id) {
  try {
    return vscode.extensions?.getExtension?.(id);
  } catch {
    return undefined;
  }
}

async function installExtension(item, options = {}) {
  const spec = typeof item === 'string' ? requirement(item, item) : requirement(item.id, item.label);
  if (!spec.id) throw new Error('A VS Code extension id is required.');

  let extension = installedExtension(spec.id);
  if (!extension) {
    options.progress?.report?.({ message: `Installing ${spec.label}...` });
    try {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', spec.id);
    } catch (error) {
      throw new Error(`Could not install required VS Code extension ${spec.label} (${spec.id}): ${error?.message || error}`);
    }
    extension = installedExtension(spec.id);
  }

  if (!extension) {
    throw new Error(
      `${spec.label} (${spec.id}) is required for this setup, but VS Code did not make it available after installation. ` +
      'Reload the VS Code window and retry.'
    );
  }

  if (options.activate !== false && typeof extension.activate === 'function') {
    options.progress?.report?.({ message: `Activating ${spec.label}...` });
    try {
      await extension.activate();
    } catch (error) {
      throw new Error(
        `${spec.label} (${spec.id}) was installed but could not be activated: ${error?.message || error}. ` +
        'Reload the VS Code window and retry.'
      );
    }
  }
  return extension;
}

async function ensureExtensions(requirements, options = {}) {
  const specs = uniqueRequirements(requirements);
  for (const spec of specs) {
    await installExtension(spec, options);
  }
  return specs;
}

async function ensureExtensionsForSetup(requirements, title = 'Installing setup requirements...') {
  const specs = uniqueRequirements(requirements);
  const missing = specs.filter((spec) => !installedExtension(spec.id));
  if (!missing.length) return specs;
  if (typeof vscode.window?.withProgress !== 'function') {
    await ensureExtensions(missing, { activate: false });
    return specs;
  }
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title,
    cancellable: false
  }, (progress) => ensureExtensions(missing, { activate: false, progress }));
  return specs;
}

module.exports = {
  EXTENSIONS,
  installedExtension,
  installExtension,
  ensureExtensions,
  ensureExtensionsForSetup,
  _test: { requirement, uniqueRequirements }
};
