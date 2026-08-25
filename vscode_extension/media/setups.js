(() => {
  const vscode = acquireVsCodeApi();
  const setupList = document.getElementById('setupList');
  const emptyState = document.getElementById('emptyState');
  const projectState = document.getElementById('projectState');
  const error = document.getElementById('error');

  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  document.getElementById('configure').addEventListener('click', configure);
  document.getElementById('configureFirst').addEventListener('click', configure);
  document.getElementById('environment').addEventListener('click', () => vscode.postMessage({ type: 'environment' }));

  function configure() {
    vscode.postMessage({ type: 'configure' });
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'dashboardError') {
      error.textContent = message.message || 'Operation failed.';
      error.classList.remove('hidden');
      return;
    }
    if (message.type !== 'dashboardState') return;

    error.classList.add('hidden');
    const project = message.project || {};
    renderProject(project);
    const setups = Array.isArray(message.setups) ? message.setups : [];
    const workspace = message.workspace;
    emptyState.classList.toggle('hidden', setups.length > 0);
    setupList.classList.toggle('hidden', setups.length === 0);
    setupList.replaceChildren(...setups.map((setup) => renderSetup(setup, project, workspace)));
  });

  function renderProject(project) {
    projectState.className = `projectState ${project.hasCargoToml ? 'ready' : 'blocked'}`;
    const title = document.createElement('strong');
    title.textContent = project.available ? (project.workspaceName || 'Current project') : 'No project open';
    const root = document.createElement('code');
    root.textContent = project.openedRoot || '';
    const note = document.createElement('span');
    note.textContent = project.note || '';
    projectState.replaceChildren(title, root, note);
  }

  function renderSetup(setup, project, workspace) {
    const article = document.createElement('article');
    article.className = 'setupCard';
    const heading = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = setup.selectionMode === 'board'
      ? (setup.boardName || setup.boardUid || setup.mcuName)
      : setup.mcuName;
    const badge = document.createElement('span');
    const usedHere = workspace?.setupId === setup.id;
    badge.className = `badge ${usedHere ? 'used' : ''}`;
    badge.textContent = usedHere ? 'Used here' : (setup.selectionMode === 'board' ? 'Board' : 'MCU');
    heading.append(title, badge);

    const detail = document.createElement('p');
    detail.textContent = [
      setup.selectionMode === 'board' ? setup.mcuName : setup.family,
      `${setup.clockMhz} MHz`,
      setup.programmerName || 'SEGGER J-Link'
    ].filter(Boolean).join(' · ');
    const shield = document.createElement('p');
    shield.className = 'muted';
    shield.textContent = setup.selectionMode === 'board'
      ? (setup.shieldName ? `Shield: ${setup.shieldName}` : 'Shield: None (mikrobus.rs is not generated)')
      : setup.target || '';

    const apply = document.createElement('button');
    apply.className = 'primary';
    apply.textContent = usedHere ? 'Re-apply setup' : 'Apply to project';
    apply.disabled = !project.hasCargoToml;
    apply.title = project.hasCargoToml ? '' : 'Open a project with Cargo.toml in its root.';
    apply.addEventListener('click', () => {
      apply.disabled = true;
      apply.textContent = 'Applying…';
      vscode.postMessage({ type: 'apply', id: setup.id });
    });
    article.append(heading, detail, shield, apply);
    return article;
  }

  vscode.postMessage({ type: 'ready' });
})();
