(() => {
  const vscode = acquireVsCodeApi();
  const grid = document.getElementById('packageGrid');
  const installedCount = document.getElementById('installedCount');
  const missingCount = document.getElementById('missingCount');
  const managedRoot = document.getElementById('managedRoot');
  const platformLabel = document.getElementById('platformLabel');
  const notice = document.getElementById('platformNotice');
  const managerNotice = document.getElementById('managerNotice');
  let generalPackages = [];
  let managerPackages = { core: [], codegrip: [], bsp: [] };
  let activeTab = 'general';

  document.getElementById('installAll').addEventListener('click', () => vscode.postMessage({ type: 'installAllGeneral' }));
  document.getElementById('updateManaged').addEventListener('click', () => vscode.postMessage({ type: 'updateManagedAll' }));
  document.getElementById('settings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

  document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
    activeTab = button.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active', item.dataset.tab === activeTab));
    managerNotice.classList.add('hidden');
    if (activeTab === 'general') renderGeneral();
    else {
      grid.innerHTML = '<div class="empty">Loading package catalog…</div>';
      vscode.postMessage({ type: 'manager', manager: activeTab });
    }
  }));

  grid.addEventListener('click', (event) => {
    const install = event.target.closest('button[data-install]');
    if (install) {
      if (activeTab === 'general') vscode.postMessage({ type: 'install', id: install.dataset.install });
      else vscode.postMessage({ type: 'managerInstall', manager: activeTab, key: install.dataset.install });
      return;
    }
    const update = event.target.closest('button[data-update]');
    if (update) {
      if (activeTab === 'general') vscode.postMessage({ type: 'update', id: update.dataset.update });
      else vscode.postMessage({ type: 'managerInstall', manager: activeTab, key: update.dataset.update });
      return;
    }
    const uninstall = event.target.closest('button[data-uninstall]');
    if (uninstall) {
      if (activeTab === 'general') vscode.postMessage({ type: 'uninstall', id: uninstall.dataset.uninstall });
      else vscode.postMessage({ type: 'managerUninstall', manager: activeTab, key: uninstall.dataset.uninstall });
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message) return;
    if (message.type === 'status') {
      managedRoot.textContent = message.managedRoot || '';
      platformLabel.textContent = message.platformLabel || `${message.platform || ''} ${message.architecture || ''}`.trim();
      generalPackages = Array.isArray(message.packages) ? message.packages : [];
      if (!['win32', 'linux'].includes(message.platform)) {
        notice.classList.remove('hidden');
        notice.textContent = 'System dependency installation is currently implemented for Windows and Linux. Extension-managed package detection is still shown below.';
      } else {
        notice.classList.add('hidden');
        notice.textContent = '';
      }
      if (activeTab === 'general') renderGeneral();
      return;
    }
    if (message.type === 'managerState' && message.manager) {
      managerPackages[message.manager] = Array.isArray(message.items) ? message.items : [];
      if (activeTab === message.manager) {
        if (message.error) {
          managerNotice.classList.remove('hidden');
          managerNotice.textContent = message.error;
        } else {
          managerNotice.classList.add('hidden');
          managerNotice.textContent = '';
        }
        renderManager(message.manager);
      }
    }
  });

  function updateCounts(items) {
    const installed = items.filter((item) => item.status === 'installed' || item.status === 'update').length;
    installedCount.textContent = String(installed);
    missingCount.textContent = String(items.filter((item) => item.status === 'missing').length);
  }

  function renderGeneral() {
    updateCounts(generalPackages);
    grid.replaceChildren(...generalPackages.map(renderGeneralCard));
  }

  function renderManager(manager) {
    const items = managerPackages[manager] || [];
    updateCounts(items);
    if (!items.length) {
      grid.innerHTML = `<div class="empty">No ${manager === 'codegrip' ? 'CODEGRIP' : manager.toUpperCase()} packages are installed${manager === 'codegrip' ? '.' : ' or available in the current catalog.'}</div>`;
      return;
    }
    grid.replaceChildren(...items.map((item) => renderManagerCard(item, manager)));
  }

  function renderGeneralCard(item) {
    const article = baseCard(item, item.kind === 'managed' ? 'Extension managed' : 'System package');
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (item.status === 'installed') {
      actions.append(actionButton(item.updateSupported ? (item.updateLabel || 'Update') : 'Update unavailable', 'secondaryAction', 'update', item.id, !item.updateSupported));
      actions.append(actionButton(item.uninstallSupported ? (item.uninstallLabel || 'Uninstall') : 'Uninstall unavailable', 'dangerAction', 'uninstall', item.id, !item.uninstallSupported));
    } else {
      actions.append(actionButton(item.installSupported ? (item.installLabel || 'Install') : 'Manual install', '', 'install', item.id, !item.installSupported));
    }
    article.append(actions);
    return article;
  }

  function renderManagerCard(item, manager) {
    const bspKind = item.entityType === 'board' ? 'Rust Board BSP package' : item.entityType === 'card' ? 'Rust MCU Card BSP package' : item.entityType === 'shield' ? 'Rust Shield BSP package' : 'Rust BSP package';
    const article = baseCard(item, manager === 'core' ? 'Rust Core package' : manager === 'bsp' ? bspKind : 'CODEGRIP package');
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (item.status === 'installed') {
      actions.append(actionButton('Uninstall', 'dangerAction', 'uninstall', item.key));
    } else if (item.status === 'update') {
      actions.append(actionButton('Update', 'secondaryAction', 'update', item.key));
      actions.append(actionButton('Uninstall', 'dangerAction', 'uninstall', item.key));
    } else if (manager !== 'codegrip') {
      actions.append(actionButton('Install', '', 'install', item.key));
    }
    article.append(actions);
    return article;
  }

  function baseCard(item, kindLabel) {
    const article = document.createElement('article');
    article.className = `card status-${item.status}`;
    const heading = document.createElement('div'); heading.className = 'cardHeading';
    const titleWrap = document.createElement('div');
    const title = document.createElement('h2'); title.textContent = item.displayName || item.name;
    const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = kindLabel;
    titleWrap.append(title, kind);
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = labelForStatus(item.status);
    heading.append(titleWrap, badge);
    const description = document.createElement('p'); description.className = 'description'; description.textContent = item.description || item.detail || '';
    const detail = document.createElement('p'); detail.className = 'detail';
    detail.textContent = item.entityType && item.uid
      ? `${item.entityType === 'card' ? 'MCUCard' : item.entityType.charAt(0).toUpperCase() + item.entityType.slice(1)} UID: ${item.uid}`
      : item.systemLib
        ? `SYSTEM_LIB: ${item.systemLib}`
        : (item.detail && item.description ? item.detail : '');
    article.append(heading, description, detail);
    const location = item.expectedPath || item.root;
    if (location) {
      const pathRow = document.createElement('div'); pathRow.className = 'pathRow';
      const pathLabel = document.createElement('span'); pathLabel.textContent = 'Location';
      const expected = document.createElement('code'); expected.textContent = location;
      pathRow.append(pathLabel, expected); article.append(pathRow);
    }
    if (item.version) { const version = document.createElement('code'); version.className = 'version'; version.textContent = item.version; article.append(version); }
    return article;
  }

  function actionButton(text, className, dataName, value, disabled = false) {
    const button = document.createElement('button');
    if (className) button.className = className;
    button.dataset[dataName] = value;
    button.disabled = disabled;
    button.textContent = text;
    return button;
  }

  function labelForStatus(status) {
    if (status === 'installed') return 'Installed';
    if (status === 'update') return 'Update available';
    if (status === 'unsupported') return 'Unsupported host';
    return 'Missing';
  }

  vscode.postMessage({ type: 'ready' });
})();
