(() => {
  const vscode = acquireVsCodeApi();
  const grid = document.getElementById('packageGrid');
  const installedCount = document.getElementById('installedCount');
  const missingCount = document.getElementById('missingCount');
  const managedRoot = document.getElementById('managedRoot');
  const platformLabel = document.getElementById('platformLabel');
  const notice = document.getElementById('platformNotice');

  document.getElementById('refresh').addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
  });

  document.getElementById('configureMcu').addEventListener('click', () => {
    vscode.postMessage({ type: 'configureMcu' });
  });

  document.getElementById('settings').addEventListener('click', () => {
    vscode.postMessage({ type: 'openSettings' });
  });

  grid.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-install]');
    if (!button) {
      return;
    }
    vscode.postMessage({ type: 'install', id: button.dataset.install });
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.type !== 'status') {
      return;
    }

    managedRoot.textContent = message.managedRoot || '';
    platformLabel.textContent = message.platformLabel || `${message.platform || ''} ${message.architecture || ''}`.trim();

    const packages = Array.isArray(message.packages) ? message.packages : [];
    const installed = packages.filter((item) => item.status === 'installed').length;
    const missing = packages.filter((item) => item.status === 'missing').length;
    installedCount.textContent = String(installed);
    missingCount.textContent = String(missing);

    if (!['win32', 'linux'].includes(message.platform)) {
      notice.classList.remove('hidden');
      notice.textContent = 'System dependency installation is currently implemented for Windows and Linux. Extension-managed package detection is still shown below.';
    } else if (message.platform === 'linux') {
      notice.classList.remove('hidden');
      notice.textContent = 'Linux profile active: ST-Link does not need the Windows driver. Non-root debug-probe access is checked through the probe-rs udev rules instead.';
    } else {
      notice.classList.add('hidden');
      notice.textContent = '';
    }

    grid.replaceChildren(...packages.map(renderCard));
  });

  function renderCard(item) {
    const article = document.createElement('article');
    article.className = `card status-${item.status}`;

    const heading = document.createElement('div');
    heading.className = 'cardHeading';

    const titleWrap = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = item.name;
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = item.kind === 'managed' ? 'Extension managed' : 'System package';
    titleWrap.append(title, kind);

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = labelForStatus(item.status);
    heading.append(titleWrap, badge);

    const description = document.createElement('p');
    description.className = 'description';
    description.textContent = item.description;

    const detail = document.createElement('p');
    detail.className = 'detail';
    detail.textContent = item.detail || '';

    article.append(heading, description, detail);

    if (item.expectedPath) {
      const pathRow = document.createElement('div');
      pathRow.className = 'pathRow';
      const pathLabel = document.createElement('span');
      pathLabel.textContent = item.kind === 'managed' ? 'Expected' : 'Location / requirement';
      const expected = document.createElement('code');
      expected.textContent = item.expectedPath;
      pathRow.append(pathLabel, expected);
      article.append(pathRow);
    }

    if (item.version) {
      const version = document.createElement('code');
      version.className = 'version';
      version.textContent = item.version;
      article.append(version);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    const button = document.createElement('button');
    button.dataset.install = item.id;
    button.disabled = item.status === 'installed' || !item.installSupported;
    if (item.status === 'installed') {
      button.textContent = 'Installed';
    } else if (item.installSupported) {
      button.textContent = item.installLabel || 'Install';
    } else {
      button.textContent = 'Manual install';
    }
    actions.append(button);
    article.append(actions);

    return article;
  }

  function labelForStatus(status) {
    if (status === 'installed') return 'Installed';
    if (status === 'unsupported') return 'Unsupported host';
    return 'Missing';
  }

  vscode.postMessage({ type: 'ready' });
})();
