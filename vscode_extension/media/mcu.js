(() => {
  const vscode = acquireVsCodeApi();

  const state = {
    mcus: [],
    boards: [],
    filtered: [],
    setups: [],
    activeSetupId: undefined,
    detail: undefined,
    currentSetup: undefined,
    selectionMode: undefined,
    selectedBoard: undefined,
    shields: [],
    programmers: [],
    project: { available: false, hasCargoToml: false },
    workspaceBinding: undefined,
    view: 'start'
  };

  const missingState = document.getElementById('missingState');
  const workspace = document.getElementById('workspace');
  const startView = document.getElementById('startView');
  const catalogView = document.getElementById('catalogView');
  const boardCatalogView = document.getElementById('boardCatalogView');
  const configView = document.getElementById('configView');
  const setupsView = document.getElementById('setupsView');
  const mcuTableBody = document.getElementById('mcuTableBody');
  const boardTableBody = document.getElementById('boardTableBody');
  const setupTableBody = document.getElementById('setupTableBody');
  const mcuCount = document.getElementById('mcuCount');
  const setupCount = document.getElementById('setupCount');
  const search = document.getElementById('mcuSearch');
  const registerGrid = document.getElementById('registerGrid');
  const generateButton = document.getElementById('generate');
  const generationStatus = document.getElementById('generationStatus');

  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  document.getElementById('showSetups').addEventListener('click', showConfiguredSetups);
  document.getElementById('showSetupsFromConfig').addEventListener('click', showConfiguredSetups);
  document.getElementById('chooseMcuMode').addEventListener('click', showCatalog);
  document.getElementById('chooseBoardMode').addEventListener('click', showBoardCatalog);
  document.getElementById('backToStartFromMcus').addEventListener('click', showStart);
  document.getElementById('backToStartFromBoards').addEventListener('click', showStart);
  document.getElementById('backToMcus').addEventListener('click', showSelectionCatalog);
  document.getElementById('backToMcusFromSetups').addEventListener('click', showStart);

  search.addEventListener('input', filterMcuList);

  generateButton.addEventListener('click', () => {
    if (!state.detail) return;
    const values = collectRegisterValues();
    const clockMhz = document.getElementById('clockMhz').value;
    const shieldSelect = document.getElementById('shieldSelect');
    const shieldUid = shieldSelect.value || undefined;

    generationStatus.textContent = state.currentSetup ? 'Updating and rebuilding configuration...' : 'Building configuration...';
    generateButton.disabled = true;
    vscode.postMessage({
      type: 'generateConfiguration',
      payload: {
        setupId: state.currentSetup?.id,
        mcuName: state.detail.name,
        clockMhz,
        values,
        selectionMode: state.selectionMode || 'mcu',
        boardUid: state.selectedBoard?.uid,
        boardName: state.selectedBoard?.name,
        shieldUid,
        shieldName: shieldUid ? selectedOptionLabel(shieldSelect) : undefined,
        programmerUid: document.getElementById('programmerSelect').value,
        programmerName: selectedOptionLabel(document.getElementById('programmerSelect'))
      }
    });
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'environmentMissing') {
      state.mcus = [];
      workspace.classList.add('hidden');
      missingState.classList.remove('hidden');
      missingState.innerHTML = '';
      const title = document.createElement('h2');
      title.textContent = 'Environment packages are missing';
      const p = document.createElement('p');
      p.textContent = `Install ${message.missing.join(', ')} from the MikroBUS Rust sidebar before configuring an MCU.`;
      const code = document.createElement('code');
      code.textContent = message.managedRoot || '';
      const button = document.createElement('button');
      button.textContent = 'Open Environment Setup';
      button.addEventListener('click', () => vscode.postMessage({ type: 'openEnvironment' }));
      missingState.append(title, p, code, button);
      return;
    }

    if (message.type === 'mcuList') {
      missingState.classList.add('hidden');
      workspace.classList.remove('hidden');
      state.mcus = Array.isArray(message.mcus) ? message.mcus : [];
      state.boards = Array.isArray(message.boards) ? message.boards : [];
      state.setups = Array.isArray(message.setups) ? message.setups : [];
      state.activeSetupId = message.activeSetupId;
      state.workspaceBinding = message.workspace;
      state.project = message.project || { available: false, hasCargoToml: false };
      filterMcuList();
      renderBoardTable();
      renderConfiguredSetups();
      updateTopCounts();
      if (state.view === 'start') showStart();
      return;
    }

    if (message.type === 'mcuDetail') {
      state.detail = message.detail;
      state.currentSetup = message.setup;
      state.selectionMode = 'mcu';
      state.selectedBoard = undefined;
      state.shields = [];
      state.programmers = Array.isArray(message.programmers) ? message.programmers : [];
      renderMcuDetail(message.detail, message.setup);
      showView('config');
      return;
    }

    if (message.type === 'boardDetail') {
      state.detail = message.mcu;
      state.currentSetup = message.setup;
      state.selectionMode = 'board';
      state.selectedBoard = message.board;
      state.shields = Array.isArray(message.shields) ? message.shields : [];
      state.programmers = Array.isArray(message.programmers) ? message.programmers : [];
      renderMcuDetail(message.mcu, message.setup);
      showView('config');
      return;
    }

    if (message.type === 'generationComplete') {
      generateButton.disabled = false;
      state.setups = Array.isArray(message.setups) ? message.setups : state.setups;
      state.activeSetupId = message.activeSetupId;
      const result = message.result || {};
      state.currentSetup = result.setup;
      generationStatus.textContent = result.warning
        ? `Generated and saved. ${result.warning}`
        : `Generated and saved successfully: ${result.setupRoot || ''}`;
      generateButton.textContent = 'Update & Rebuild Configuration';
      document.getElementById('setupState').textContent = 'Saved setup';
      document.getElementById('setupState').className = 'statusBadge configured';
      filterMcuList();
      renderBoardTable();
      renderConfiguredSetups();
      updateTopCounts();
      setSetupsStatus(result.warning ? `Generated with warning: ${result.warning}` : `Generated ${result.mcuName || 'configuration'} successfully.`);
      showConfiguredSetups();
      return;
    }

    if (message.type === 'workspaceBindingChanged') {
      state.workspaceBinding = message.workspace;
      state.setups = Array.isArray(message.setups) ? message.setups : state.setups;
      renderConfiguredSetups();
      renderBoardTable();
      updateTopCounts();
      setSetupsStatus(message.workspace ? `${message.workspace.mcuName} is now used by the current Rust workspace.` : 'Workspace binding updated.');
      showConfiguredSetups();
      return;
    }

    if (message.type === 'workspaceActionComplete') {
      setSetupsStatus(`Workspace ${message.action || 'operation'} completed successfully.`);
      return;
    }

    if (message.type === 'rebuildComplete') {
      state.setups = Array.isArray(message.setups) ? message.setups : state.setups;
      state.activeSetupId = message.activeSetupId;
      renderConfiguredSetups();
      filterMcuList();
      renderBoardTable();
      updateTopCounts();
      setSetupsStatus(`Rebuilt ${message.result?.mcuName || 'configuration'} successfully.`);
      return;
    }

    if (message.type === 'setupRemoved') {
      state.setups = Array.isArray(message.setups) ? message.setups : state.setups;
      state.activeSetupId = message.activeSetupId;
      state.workspaceBinding = message.workspace;
      renderConfiguredSetups();
      filterMcuList();
      renderBoardTable();
      updateTopCounts();
      setSetupsStatus('Configured setup removed.');
      return;
    }

    if (message.type === 'error') {
      generateButton.disabled = false;
      generationStatus.textContent = message.message || 'Configuration failed.';
      setSetupsStatus(message.message || 'Operation failed.', true);
    }
  });

  function updateTopCounts() {
    setupCount.textContent = String(state.setups.length);
  }

  function filterMcuList() {
    const query = search.value.trim().toLowerCase();
    state.filtered = !query
      ? state.mcus
      : state.mcus.filter((mcu) => [mcu.name, mcu.family, mcu.vendor, mcu.target, mcu.systemLib]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query)));
    renderMcuTable();
  }

  function renderMcuTable() {
    mcuCount.textContent = String(state.filtered.length);
    mcuTableBody.replaceChildren(...state.filtered.map((mcu) => {
      const row = document.createElement('tr');
      row.tabIndex = 0;
      row.className = 'clickableRow';
      row.addEventListener('click', () => requestMcu(mcu.name));
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          requestMcu(mcu.name);
        }
      });

      appendCell(row, mcu.name, 'mcuNameCell');
      appendCell(row, mcu.vendor || '—');
      appendCell(row, mcu.family || '—');
      appendCodeCell(row, mcu.target || '—');
      appendCodeCell(row, mcu.systemLib || '—');

      const statusCell = document.createElement('td');
      const saved = setupForMcu(mcu.name);
      const badge = document.createElement('span');
      if (saved) {
        badge.className = saved.id === state.activeSetupId ? 'statusBadge active' : 'statusBadge configured';
        badge.textContent = saved.id === state.activeSetupId ? 'Active' : 'Configured';
      } else {
        badge.className = 'statusBadge available';
        badge.textContent = 'Available';
      }
      statusCell.append(badge);
      row.append(statusCell);
      return row;
    }));
  }

  function requestMcu(name) {
    generationStatus.textContent = '';
    showLoading(`Loading ${name}...`);
    vscode.postMessage({ type: 'selectMcu', name });
  }

  function renderBoardTable() {
    document.getElementById('boardCount').textContent = String(state.boards.length);
    boardTableBody.replaceChildren(...state.boards.map((board) => {
      const row = document.createElement('tr');
      row.tabIndex = 0;
      row.className = 'clickableRow';
      const open = () => requestBoard(board.uid, board.name);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });
      appendCell(row, board.name || board.uid, 'mcuNameCell');
      appendCell(row, board.vendor || '—');
      appendCodeCell(row, board.mcuName || '—');
      const saved = state.setups.find((setup) => setup.selectionMode === 'board' && setup.boardUid === board.uid);
      const statusCell = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = saved ? 'statusBadge configured' : 'statusBadge available';
      badge.textContent = saved ? 'Configured' : 'Available';
      statusCell.append(badge);
      row.append(statusCell);
      return row;
    }));
  }

  function requestBoard(uid, name) {
    generationStatus.textContent = '';
    showLoading(`Loading ${name || uid}...`);
    vscode.postMessage({ type: 'selectBoard', uid });
  }

  function renderMcuDetail(detail, setup) {
    document.getElementById('selectedName').textContent = detail.name || '';
    document.getElementById('selectedVendor').textContent = detail.vendor || '—';
    document.getElementById('selectedFamily').textContent = detail.family || '—';
    document.getElementById('selectedTarget').textContent = detail.target || '—';
    document.getElementById('selectedSystem').textContent = detail.systemLib || '—';
    document.getElementById('clockMhz').value = setup?.clockMhz ?? detail.clock ?? '';

    const boardCard = document.getElementById('boardSelectionCard');
    const shieldSelect = document.getElementById('shieldSelect');
    if (state.selectionMode === 'board' && state.selectedBoard) {
      boardCard.classList.remove('hidden');
      document.getElementById('selectedBoardName').textContent = state.selectedBoard.name || state.selectedBoard.uid;
      const shieldHint = state.shields.length === 0
        ? 'No compatible shield is configured. This setup will not generate mikrobus.rs.'
        : 'Shield selection is optional. Choose No shield to apply the board without generating mikrobus.rs.';
      document.getElementById('selectedBoardDevice').textContent = `Hardware MCU ${state.selectedBoard.config?.hardwareDevice || '—'} · Rust compatibility MCU ${detail.name || '—'} · ${shieldHint}`;
      const noShieldOption = document.createElement('option');
      noShieldOption.value = '';
      noShieldOption.textContent = 'No shield (no mikrobus.rs)';
      noShieldOption.selected = setup ? !setup.shieldUid : !state.shields.some((shield) => shield.isDefault);
      shieldSelect.replaceChildren(noShieldOption, ...state.shields.map((shield) => {
        const option = document.createElement('option');
        option.value = shield.uid;
        option.textContent = `${shield.name} (${shield.mikrobusCount} mikroBUS)`;
        option.selected = setup?.shieldUid ? setup.shieldUid === shield.uid : Boolean(shield.isDefault);
        return option;
      }));
    } else {
      boardCard.classList.add('hidden');
      shieldSelect.replaceChildren();
    }

    const programmerSelect = document.getElementById('programmerSelect');
    programmerSelect.replaceChildren(...state.programmers.map((programmer) => {
      const option = document.createElement('option');
      option.value = programmer.uid;
      option.textContent = `${programmer.name} · ${programmer.interface || programmer.transport || ''}`;
      option.selected = setup?.programmerUid ? setup.programmerUid === programmer.uid : programmer.uid === 'SEGGER_JLINK';
      return option;
    }));
    generateButton.disabled = state.programmers.length === 0;

    const stateBadge = document.getElementById('setupState');
    if (setup) {
      const isActive = setup.id === state.activeSetupId || setup.active;
      stateBadge.textContent = isActive ? 'Active setup' : 'Saved setup';
      stateBadge.className = isActive ? 'statusBadge active' : 'statusBadge configured';
      generateButton.textContent = 'Update & Rebuild Configuration';
    } else {
      stateBadge.textContent = 'Not configured';
      stateBadge.className = 'statusBadge available';
      generateButton.textContent = 'Build Configuration';
    }

    generationStatus.textContent = '';
    const savedValues = setup?.values || {};
    const registerCards = [];
    for (const register of detail.registers || []) {
      const card = document.createElement('article');
      card.className = 'registerCard';

      const head = document.createElement('div');
      head.className = 'registerHead';
      const title = document.createElement('h4');
      title.textContent = register.key || 'Register';
      const address = document.createElement('code');
      address.textContent = register.address || '';
      head.append(title, address);
      card.append(head);

      const fields = document.createElement('div');
      fields.className = 'fieldGrid';
      for (const field of register.fields || []) {
        const wrapper = document.createElement('label');
        wrapper.className = 'field';
        const label = document.createElement('span');
        label.textContent = field.label || field.key;
        const select = document.createElement('select');
        select.dataset.fieldId = field.id;
        const selectedValue = Object.prototype.hasOwnProperty.call(savedValues, field.id)
          ? String(savedValues[field.id])
          : String(field.init ?? '');

        for (const setting of field.settings || []) {
          const option = document.createElement('option');
          option.value = String(setting.value);
          option.textContent = setting.label;
          if (String(setting.value) === selectedValue || String(setting.value).toLowerCase() === selectedValue.toLowerCase()) {
            option.selected = true;
          }
          select.append(option);
        }
        wrapper.append(label, select);
        fields.append(wrapper);
      }
      card.append(fields);
      registerCards.push(card);
    }
    registerGrid.replaceChildren(...registerCards);
  }

  function selectedOptionLabel(select) {
    const text = select?.selectedOptions?.[0]?.textContent || '';
    return text.split(' · ')[0].replace(/ \(\d+ mikroBUS\)$/, '').trim() || undefined;
  }

  function collectRegisterValues() {
    const values = {};
    registerGrid.querySelectorAll('select[data-field-id]').forEach((select) => {
      values[select.dataset.fieldId] = select.value;
    });
    return values;
  }

  function renderConfiguredSetups() {
    setupCount.textContent = String(state.setups.length);
    renderWorkspaceBinding();
    const empty = document.getElementById('setupEmpty');
    const table = document.getElementById('setupTable');
    if (state.setups.length === 0) {
      empty.classList.remove('hidden');
      table.classList.add('hidden');
      setupTableBody.replaceChildren();
      return;
    }

    empty.classList.add('hidden');
    table.classList.remove('hidden');
    setupTableBody.replaceChildren(...state.setups.map((setup) => {
      const row = document.createElement('tr');
      appendCell(row, setup.selectionMode === 'board' ? (setup.boardName || setup.boardUid || setup.mcuName) : (setup.mcuName || '—'), 'mcuNameCell');
      appendCell(row, [setup.vendor, setup.family].filter(Boolean).join(' / ') || '—');
      appendCell(row, `${setup.clockMhz ?? '—'} MHz`);
      appendCodeCell(row, setup.target || '—');
      appendCell(row, formatDate(setup.updatedAt));

      const statusCell = document.createElement('td');
      const status = document.createElement('span');
      const isActive = setup.id === state.activeSetupId || setup.active;
      const usedHere = state.workspaceBinding?.setupId === setup.id;
      status.className = usedHere ? 'statusBadge active' : (isActive ? 'statusBadge active' : 'statusBadge configured');
      status.textContent = usedHere ? 'Used here' : (isActive ? 'Active' : 'Saved');
      statusCell.append(status);
      row.append(statusCell);

      const actionsCell = document.createElement('td');
      actionsCell.className = 'actionsCell';
      const applyButton = actionButton(usedHere ? 'Re-apply to workspace' : 'Apply to workspace', () => {
        setSetupsStatus(`Applying ${setup.mcuName} to current Rust workspace...`);
        vscode.postMessage({ type: 'useSetupWithWorkspace', id: setup.id });
      }, usedHere ? 'primaryAction' : '');
      applyButton.disabled = !state.project.hasCargoToml;
      applyButton.title = state.project.hasCargoToml
        ? ''
        : 'Open a project with Cargo.toml in the workspace root before applying a setup.';
      actionsCell.append(
        applyButton,
        actionButton('Edit clock/settings', () => {
          showLoading(`Loading ${setup.mcuName}...`);
          vscode.postMessage({ type: 'editSetup', id: setup.id });
        }),
        actionButton('Rebuild', () => {
          setSetupsStatus(`Rebuilding ${setup.mcuName}...`);
          vscode.postMessage({ type: 'rebuildSetup', id: setup.id });
        }),
        actionButton('Remove', () => vscode.postMessage({ type: 'removeSetup', id: setup.id }), 'danger')
      );
      row.append(actionsCell);
      return row;
    }));
  }

  function renderWorkspaceBinding() {
    const card = document.getElementById('workspaceBindingCard');
    if (!state.workspaceBinding) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    document.getElementById('workspaceBindingTitle').textContent = `${state.workspaceBinding.mcuName} · ${state.workspaceBinding.clockMhz} MHz`;
    document.getElementById('workspaceBindingPath').textContent = `Reusable setup: ${state.workspaceBinding.sdkRoot || '—'} · Project: ${state.workspaceBinding.openedRoot || state.workspaceBinding.workspaceName || '—'}`;
  }

  function setupForMcu(mcuName) {
    const key = String(mcuName || '').toLowerCase();
    return state.setups.find((setup) => setup.selectionMode !== 'board' && String(setup.mcuName || '').toLowerCase() === key);
  }

  function actionButton(label, action, extraClass = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `smallButton ${extraClass}`.trim();
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  }

  function appendCell(row, value, className = '') {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    cell.textContent = value;
    row.append(cell);
  }

  function appendCodeCell(row, value) {
    const cell = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = value;
    cell.append(code);
    row.append(cell);
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
  }

  function showConfiguredSetups() {
    renderConfiguredSetups();
    setSetupsStatus('');
    showView('setups');
  }

  function showCatalog() {
    state.selectionMode = 'mcu';
    state.detail = undefined;
    state.currentSetup = undefined;
    generationStatus.textContent = '';
    showView('catalog');
    search.focus();
  }

  function showBoardCatalog() {
    state.selectionMode = 'board';
    state.detail = undefined;
    state.currentSetup = undefined;
    generationStatus.textContent = '';
    renderBoardTable();
    showView('boards');
  }

  function showStart() {
    state.selectionMode = undefined;
    state.detail = undefined;
    state.currentSetup = undefined;
    generationStatus.textContent = '';
    showView('start');
  }

  function showSelectionCatalog() {
    if (state.selectionMode === 'board') showBoardCatalog();
    else showCatalog();
  }

  function showLoading(text) {
    document.getElementById('loadingText').textContent = text;
    showView('loading');
  }

  function showView(view) {
    state.view = view;
    startView.classList.toggle('hidden', view !== 'start');
    catalogView.classList.toggle('hidden', view !== 'catalog');
    boardCatalogView.classList.toggle('hidden', view !== 'boards');
    configView.classList.toggle('hidden', view !== 'config');
    setupsView.classList.toggle('hidden', view !== 'setups');
    document.getElementById('loadingView').classList.toggle('hidden', view !== 'loading');
  }

  function setSetupsStatus(text, isError = false) {
    const target = document.getElementById('setupsStatus');
    target.textContent = text;
    target.classList.toggle('errorText', Boolean(isError));
  }

  vscode.postMessage({ type: 'ready' });
})();
