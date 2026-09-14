(() => {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('packageGrid');
  const search = document.getElementById('search');
  const installedChip = document.getElementById('installedCount');
  const missingChip = document.getElementById('missingCount');
  const managedRoot = document.getElementById('managedRoot');
  const platformNotice = document.getElementById('platformNotice');
  const managerNotice = document.getElementById('managerNotice');
  const storageBar = document.getElementById('storageBar');
  const installAll = document.getElementById('installAll');
  const tabButtons = [...document.querySelectorAll('[data-tab]')];
  const viewTitle = document.getElementById('viewTitle');
  const viewSubtitle = document.getElementById('viewSubtitle');

  let generalPackages = [];
  let managerPackages = { core: [], codegrip: [], card: [], board: [] };
  let activeTab = 'general';
  let statusFilter = 'all';
  let hostPackageInstallSupported = true;

  const descriptors = {
    general: {
      title: 'Rust Development Environment',
      subtitle: 'Shared Rust environment components. Core, CODEGRIP, MCU Card and Board packages are managed in the tabs below.'
    },
    core: {
      title: 'Rust Core Packages',
      subtitle: 'Per-SYSTEM_LIB Rust core packages used by configured MCUs.'
    },
    codegrip: {
      title: 'CODEGRIP Packages',
      subtitle: 'Installed CODEGRIP GDB server and MCU-specific device packs shared by C and Rust setups.'
    },
    card: {
      title: 'Rust MCU Card Packages',
      subtitle: 'Per-MCUCard BSP packages resolved independently from the Rust hardware database.'
    },
    board: {
      title: 'Rust Board Packages',
      subtitle: 'Per-Board and per-Shield BSP packages resolved independently from the Rust hardware database.'
    }
  };

  function isInstalled(item) {
    return item?.status === 'installed' || item?.status === 'update';
  }

  function currentItems() {
    return activeTab === 'general' ? generalPackages : (managerPackages[activeTab] || []);
  }

  function switchTab(tab, request = true) {
    activeTab = descriptors[tab] ? tab : 'general';
    statusFilter = 'all';
    search.value = '';
    managerNotice.classList.add('hidden');
    managerNotice.textContent = '';

    const descriptor = descriptors[activeTab];
    viewTitle.textContent = descriptor.title;
    viewSubtitle.textContent = descriptor.subtitle;
    tabButtons.forEach((button) => button.classList.toggle('active', button.dataset.tab === activeTab));

    const isGeneral = activeTab === 'general';
    installAll.classList.toggle('hidden', !isGeneral);
    storageBar.classList.toggle('hidden', !isGeneral);
    platformNotice.classList.toggle('hidden', !isGeneral || hostPackageInstallSupported);

    if (isGeneral) {
      render();
      if (request) vscode.postMessage({ type: 'ready' });
      return;
    }

    root.innerHTML = '<div class="empty">Loading package catalog…</div>';
    updateCounts([]);
    if (request) vscode.postMessage({ type: 'manager', manager: activeTab });
  }

  function setStatusFilter(next) {
    statusFilter = statusFilter === next ? 'all' : next;
    render();
  }

  function updateCounts(items) {
    const installed = items.filter(isInstalled).length;
    const missing = Math.max(0, items.length - installed);

    installedChip.textContent = statusFilter === 'installed'
      ? `${installed} installed · showing only`
      : `${installed} installed`;
    missingChip.textContent = statusFilter === 'missing'
      ? `${missing} not installed · showing only`
      : `${missing} not installed`;

    installedChip.classList.toggle('active', statusFilter === 'installed');
    missingChip.classList.toggle('active', statusFilter === 'missing');
    installedChip.setAttribute('aria-pressed', String(statusFilter === 'installed'));
    missingChip.setAttribute('aria-pressed', String(statusFilter === 'missing'));
  }

  function render() {
    const all = currentItems();
    const query = search.value.trim().toLowerCase();
    updateCounts(all);

    const items = all.filter((item) => {
      if (statusFilter === 'installed' && !isInstalled(item)) return false;
      if (statusFilter === 'missing' && isInstalled(item)) return false;
      if (!query) return true;
      return JSON.stringify(item).toLowerCase().includes(query);
    });

    if (!items.length) {
      const filtered = statusFilter !== 'all';
      root.innerHTML = `<div class="empty">${filtered ? 'No packages match the selected installation filter.' : 'No matching packages.'}</div>`;
      return;
    }

    root.replaceChildren(...items.map(renderCard));
  }

  function renderCard(item) {
    const article = document.createElement('article');
    article.className = `card ${item.status || 'missing'}`;

    const info = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = item.displayName || item.name || item.key || 'Package';
    info.append(title);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const kind = document.createElement('span');
    kind.textContent = packageKind(item);
    const version = document.createElement('span');
    version.textContent = item.version || '';
    const status = document.createElement('span');
    status.textContent = item.status || 'missing';
    meta.append(kind);
    if (version.textContent) meta.append(version);
    meta.append(status);

    if (item.systemLib) {
      const systemLib = document.createElement('span');
      systemLib.textContent = item.systemLib;
      meta.append(systemLib);
    } else if (item.uid) {
      const uid = document.createElement('span');
      uid.textContent = item.uid;
      meta.append(uid);
    }
    info.append(meta);

    const location = item.root || item.expectedPath || item.installRelativePath || '';
    if (location) {
      const locationParagraph = document.createElement('p');
      const code = document.createElement('code');
      code.textContent = location;
      locationParagraph.append(code);
      info.append(locationParagraph);
    }

    const detail = item.detail || item.description || '';
    if (detail) {
      const detailElement = document.createElement('div');
      detailElement.className = 'refs';
      detailElement.textContent = detail;
      info.append(detailElement);
    }

    if (Array.isArray(item.references) && item.references.length) {
      const references = document.createElement('div');
      references.className = 'refs';
      references.textContent = `Used by setup: ${item.references.join(', ')}`;
      info.append(references);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(actionFor(item));
    article.append(info, actions);
    return article;
  }

  function packageKind(item) {
    if (activeTab === 'core') return 'rust-core';
    if (activeTab === 'codegrip') return item.kind || 'programmer-pack';
    if (activeTab === 'card') return 'bsp-card';
    if (activeTab === 'board') {
      if (item.entityType === 'shield') return 'bsp-shield';
      return 'bsp-board';
    }
    return item.kind || 'package';
  }

  function actionFor(item) {
    if (activeTab === 'general') return generalAction(item);
    return managerAction(item);
  }

  function generalAction(item) {
    if (item.status === 'unsupported') return actionButton('Unavailable', '', '', true);
    if (item.status === 'installed') {
      if (item.uninstallSupported) return actionButton(item.uninstallLabel || 'Uninstall', 'danger', 'uninstall', false, item.id);
      return actionButton('Uninstall unavailable', '', '', true);
    }
    if (item.status === 'update') {
      if (item.updateSupported) return actionButton(item.updateLabel || 'Update', '', 'update', false, item.id);
      return actionButton('Update unavailable', '', '', true);
    }
    if (item.installSupported) return actionButton(item.installLabel || 'Install', '', 'install', false, item.id);
    return actionButton('Unavailable', '', '', true);
  }

  function managerAction(item) {
    if (item.unavailable) return actionButton('Unavailable', '', '', true);
    if (item.status === 'installed') return actionButton('Uninstall', 'danger', 'managerUninstall', false, item.key);
    if (item.status === 'update') return actionButton('Update', '', 'managerInstall', false, item.key);
    if (activeTab === 'codegrip') return actionButton('Unavailable', '', '', true);
    return actionButton('Install', '', 'managerInstall', false, item.key);
  }

  function actionButton(text, className, action, disabled = false, value = '') {
    const button = document.createElement('button');
    if (className) button.className = className;
    button.textContent = text;
    button.disabled = disabled;
    if (action) button.dataset.action = action;
    if (value) button.dataset.value = value;
    return button;
  }

  root.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const value = button.dataset.value;
    if (!action || !value) return;

    if (action === 'install') vscode.postMessage({ type: 'install', id: value });
    else if (action === 'update') vscode.postMessage({ type: 'update', id: value });
    else if (action === 'uninstall') vscode.postMessage({ type: 'uninstall', id: value });
    else if (action === 'managerInstall') vscode.postMessage({ type: 'managerInstall', manager: activeTab, key: value });
    else if (action === 'managerUninstall') vscode.postMessage({ type: 'managerUninstall', manager: activeTab, key: value });
  });

  search.addEventListener('input', render);
  installedChip.addEventListener('click', () => setStatusFilter('installed'));
  missingChip.addEventListener('click', () => setStatusFilter('missing'));
  installAll.addEventListener('click', () => vscode.postMessage({ type: 'installAllGeneral' }));
  document.getElementById('changeRoot').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  tabButtons.forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));

  window.addEventListener('focus', () => {
    if (activeTab === 'general') vscode.postMessage({ type: 'ready' });
    else vscode.postMessage({ type: 'manager', manager: activeTab });
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message) return;

    if (message.type === 'status') {
      managedRoot.textContent = message.managedRoot || '';
      generalPackages = Array.isArray(message.packages) ? message.packages : [];
      hostPackageInstallSupported = ['win32', 'linux'].includes(message.platform);
      if (!hostPackageInstallSupported) {
        platformNotice.classList.remove('hidden');
        platformNotice.textContent = 'System dependency installation is currently implemented for Windows and Linux. Extension-managed package detection is still shown below.';
      } else {
        platformNotice.classList.add('hidden');
        platformNotice.textContent = '';
      }
      if (activeTab === 'general') render();
      return;
    }

    if (message.type === 'managerState' && message.manager) {
      managerPackages[message.manager] = Array.isArray(message.items) ? message.items : [];
      if (activeTab !== message.manager) return;
      if (message.error) {
        managerNotice.classList.remove('hidden');
        managerNotice.textContent = message.error;
      } else {
        managerNotice.classList.add('hidden');
        managerNotice.textContent = '';
      }
      render();
    }
  });

  switchTab('general', false);
  vscode.postMessage({ type: 'ready' });
})();
