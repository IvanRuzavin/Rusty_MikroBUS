(() => {
  const vscode = acquireVsCodeApi();
  const setupList = document.getElementById('setupList');
  const emptyState = document.getElementById('emptyState');
  const projectState = document.getElementById('projectState');
  const error = document.getElementById('error');
  const rustDashboard = document.getElementById('rustDashboard');
  const cDashboard = document.getElementById('cDashboard');
  const environmentTitle = document.getElementById('environmentTitle');
  const cSetupList = document.getElementById('cSetupList');
  const cEmptyState = document.getElementById('cEmptyState');
  const cProjectState = document.getElementById('cProjectState');
  let activeEnvironment = 'rust';

  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  document.getElementById('configure').addEventListener('click', configure);
  document.getElementById('configureFirst').addEventListener('click', configure);
  document.getElementById('environment').addEventListener('click', () => vscode.postMessage({ type: 'environment' }));
  document.getElementById('selectRust').addEventListener('click', () => selectEnvironment('rust'));
  document.getElementById('selectC').addEventListener('click', () => selectEnvironment('c'));
  document.getElementById('cConfigureFirst').addEventListener('click', configure);

  function configure() { vscode.postMessage({ type: 'configure' }); }
  function selectEnvironment(environment) {
    if (environment === activeEnvironment) return;
    vscode.postMessage({ type: 'selectEnvironment', environment });
  }

  function renderEnvironment(message) {
    activeEnvironment = message.environment === 'c' && message.cSupportEnabled ? 'c' : 'rust';
    const isC = activeEnvironment === 'c';
    rustDashboard.classList.toggle('hidden', isC);
    cDashboard.classList.toggle('hidden', !isC);
    document.getElementById('selectRust').classList.toggle('active', !isC);
    document.getElementById('selectC').classList.toggle('active', isC);
    document.getElementById('selectC').classList.toggle('hidden', !message.cSupportEnabled);
    environmentTitle.textContent = isC ? 'C environment' : 'Rust setups';
    document.getElementById('configure').textContent = 'Configure MCU or Board';
    document.getElementById('environment').textContent = 'Development environment';
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

    renderEnvironment(message);
    error.classList.add('hidden');
    if (activeEnvironment === 'c') {
      const project = message.cProject || {};
      const setups = Array.isArray(message.cSetups) ? message.cSetups : [];
      const workspace = message.cWorkspace;
      renderCProject(project);
      cEmptyState.classList.toggle('hidden', setups.length > 0);
      cSetupList.classList.toggle('hidden', setups.length === 0);
      cSetupList.replaceChildren(...setups.map((setup) => renderCSetup(setup, project, workspace)));
      return;
    }

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
    const root = document.createElement('code'); root.textContent = project.openedRoot || '';
    const note = document.createElement('span'); note.textContent = project.note || '';
    projectState.replaceChildren(title, root, note);
  }

  function renderCProject(project) {
    cProjectState.className = `projectState ${project.available ? (project.bound ? 'ready' : 'blocked') : 'blocked'}`;
    const title = document.createElement('strong');
    title.textContent = project.available ? (project.workspaceName || 'Current project') : 'No project open';
    const root = document.createElement('code'); root.textContent = project.openedRoot || '';
    const note = document.createElement('span'); note.textContent = project.note || '';
    cProjectState.replaceChildren(title, root, note);
  }

  function renderCSetup(setup, project, workspace) {
    const article = document.createElement('article'); article.className = 'setupCard';
    const heading = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = setup.name || setup.boardName || setup.mcuName || 'C setup';
    const usedHere = workspace?.setupId === setup.id;
    const badge = document.createElement('span');
    badge.className = `badge ${usedHere ? 'used' : ''}`;
    badge.textContent = usedHere ? 'Used here' : (setup.selectionMode === 'board' ? 'Board' : 'MCU');
    heading.append(title, badge);

    const detail = document.createElement('p');
    const output = setup.applicationOutput === 'uart' ? 'UART output' : 'Debug Terminal';
    detail.textContent = [setup.boardName || setup.mcuName, setup.boardName ? setup.mcuName : '', setup.clockMHz ? `${setup.clockMHz} MHz` : '', setup.mode === 'full-sdk' ? 'mikroSDK' : 'Bare metal', output].filter(Boolean).join(' · ');
    const programmer = document.createElement('p'); programmer.className = 'muted';
    programmer.textContent = setup.programmerName ? `Programmer: ${setup.programmerName}` : '';

    const actions = document.createElement('div'); actions.className = 'setupActions';
    const apply = document.createElement('button');
    apply.className = 'primary applyButton';
    apply.textContent = usedHere ? 'Re-apply setup' : 'Apply to project';
    apply.disabled = !project.available;
    apply.title = project.available ? '' : 'Open a project folder first.';
    apply.addEventListener('click', () => vscode.postMessage({ type: 'cApply', id: setup.id }));
    const reconfigure = document.createElement('button'); reconfigure.className = 'secondary editButton'; reconfigure.textContent = 'Reconfigure'; reconfigure.title = 'Change clock/register settings, programmer or application output'; reconfigure.addEventListener('click', () => vscode.postMessage({ type: 'cReconfigure', id: setup.id }));
    const rebuild = document.createElement('button'); rebuild.className = 'secondary editButton'; rebuild.textContent = 'Rebuild'; rebuild.addEventListener('click', () => vscode.postMessage({ type: 'cRebuild', id: setup.id }));
    const remove = document.createElement('button'); remove.className = 'removeButton'; remove.textContent = '×'; remove.title = 'Remove configured C setup'; remove.setAttribute('aria-label', `Remove ${title.textContent}`); remove.addEventListener('click', () => vscode.postMessage({ type: 'cRemove', id: setup.id }));
    actions.append(apply, reconfigure, rebuild, remove);
    article.append(heading, detail, programmer, actions);
    return article;
  }

  function renderSetup(setup, project, workspace) {
    const article = document.createElement('article'); article.className = 'setupCard';
    const heading = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = setup.selectionMode === 'board' ? (setup.boardName || setup.boardUid || setup.mcuName) : setup.mcuName;
    const badge = document.createElement('span');
    const usedHere = workspace?.setupId === setup.id;
    badge.className = `badge ${usedHere ? 'used' : ''}`;
    badge.textContent = usedHere ? 'Used here' : (setup.selectionMode === 'board' ? 'Board' : 'MCU');
    heading.append(title, badge);
    const detail = document.createElement('p');
    detail.textContent = [setup.selectionMode === 'board' ? setup.mcuName : setup.family, `${setup.clockMhz} MHz`, setup.programmerName || 'SEGGER J-Link'].filter(Boolean).join(' · ');
    const shield = document.createElement('p'); shield.className = 'muted';
    shield.textContent = setup.selectionMode === 'board' ? (setup.shieldName ? `Shield: ${setup.shieldName}` : 'Shield: None (mikrobus.rs is not generated)') : setup.target || '';
    const actions = document.createElement('div'); actions.className = 'setupActions';
    const apply = document.createElement('button'); apply.className = 'primary applyButton'; apply.textContent = usedHere ? 'Re-apply setup' : 'Apply to project'; apply.disabled = !project.hasCargoToml; apply.title = project.hasCargoToml ? '' : 'Open a project with Cargo.toml in its root.'; apply.addEventListener('click', () => { apply.disabled = true; apply.textContent = 'Applying…'; vscode.postMessage({ type: 'apply', id: setup.id }); });
    const edit = document.createElement('button'); edit.className = 'secondary editButton'; edit.textContent = 'Edit'; edit.addEventListener('click', () => vscode.postMessage({ type: 'edit', id: setup.id }));
    const remove = document.createElement('button'); remove.className = 'removeButton'; remove.textContent = '×'; remove.title = 'Remove configured setup'; remove.setAttribute('aria-label', `Remove ${title.textContent || setup.mcuName || 'configured setup'}`); remove.addEventListener('click', () => vscode.postMessage({ type: 'remove', id: setup.id }));
    actions.append(apply, edit, remove); article.append(heading, detail, shield, actions); return article;
  }

  vscode.postMessage({ type: 'ready' });
})();
