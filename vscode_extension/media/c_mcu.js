(() => {
  const vscode = acquireVsCodeApi();
  const state = {
    mcus: [],
    boards: [],
    filteredMcus: [],
    filteredBoards: [],
    detail: undefined,
    selectionMode: undefined,
    selectedBoard: undefined,
    boardDevices: [],
    setups: [],
    editingSetupId: undefined,
    view: 'start'
  };

  const views = {
    start: document.getElementById('startView'),
    mcus: document.getElementById('catalogView'),
    boards: document.getElementById('boardCatalogView'),
    boardDevices: document.getElementById('boardDeviceView'),
    loading: document.getElementById('loadingView'),
    config: document.getElementById('configView')
  };
  const workspace = document.getElementById('workspace');
  const missingState = document.getElementById('missingState');
  const mcuSearch = document.getElementById('mcuSearch');
  const boardSearch = document.getElementById('boardSearch');
  const mcuTableBody = document.getElementById('mcuTableBody');
  const boardTableBody = document.getElementById('boardTableBody');
  const boardDeviceTableBody = document.getElementById('boardDeviceTableBody');
  const registerGrid = document.getElementById('registerGrid');
  const generateButton = document.getElementById('generate');
  const generationStatus = document.getElementById('generationStatus');

  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  document.getElementById('chooseMcuMode').addEventListener('click', () => showView('mcus'));
  document.getElementById('chooseBoardMode').addEventListener('click', () => showView('boards'));
  document.querySelectorAll('.backStart').forEach((button) => button.addEventListener('click', () => showView('start')));
  document.getElementById('backToBoards').addEventListener('click', () => showView('boards'));
  document.getElementById('backToSelection').addEventListener('click', () => showView(state.selectionMode === 'board' ? 'boards' : 'mcus'));
  mcuSearch.addEventListener('input', renderMcuTable);
  boardSearch.addEventListener('input', renderBoardTable);
  generateButton.addEventListener('click', buildConfiguration);

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'environmentMissing') {
      workspace.classList.add('hidden');
      missingState.classList.remove('hidden');
      missingState.replaceChildren();
      const title = document.createElement('h2');
      title.textContent = 'C environment packages are missing';
      const text = document.createElement('p');
      text.textContent = `Install ${message.missing.join(', ')} before opening the visual C clock configuration.`;
      const root = document.createElement('code');
      root.textContent = message.managedRoot || '';
      const button = document.createElement('button');
      button.textContent = 'Install C Environment';
      button.addEventListener('click', () => vscode.postMessage({ type: 'openEnvironment' }));
      missingState.append(title, text, root, button);
      return;
    }

    if (message.type === 'initialState') {
      missingState.classList.add('hidden');
      workspace.classList.remove('hidden');
      state.mcus = Array.isArray(message.mcus) ? message.mcus : [];
      state.boards = Array.isArray(message.boards) ? message.boards : [];
      state.setups = Array.isArray(message.setups) ? message.setups : [];
      renderMcuTable();
      renderBoardTable();
      if (state.view === 'loading') showView('start');
      return;
    }

    if (message.type === 'boardDevices') {
      state.selectionMode = 'board';
      state.selectedBoard = message.board;
      state.boardDevices = Array.isArray(message.devices) ? message.devices : [];
      document.getElementById('boardDeviceTitle').textContent = message.board?.name || message.board?.uid || 'Board';
      renderBoardDeviceTable();
      showView('boardDevices');
      return;
    }

    if (message.type === 'deviceDetail') {
      state.editingSetupId = undefined;
      state.detail = message.detail;
      state.selectionMode = message.selectionMode === 'board' ? 'board' : 'mcu';
      state.selectedBoard = message.detail?.board;
      renderDetail(message.detail);
      showView('config');
      return;
    }

    if (message.type === 'editSetup') {
      state.editingSetupId = message.setup?.id;
      state.detail = message.detail;
      state.selectionMode = message.selectionMode === 'board' ? 'board' : 'mcu';
      state.selectedBoard = message.detail?.board;
      renderDetail(message.detail);
      applyExistingSetup(message.setup || {});
      showView('config');
      return;
    }

    if (message.type === 'configurationBuilt') {
      state.editingSetupId = undefined;
      state.setups = Array.isArray(message.setups) ? message.setups : state.setups;
      generationStatus.textContent = `Configuration '${message.setup?.name || ''}' built successfully and is ready to apply.`;
      generateButton.disabled = false;
      generateButton.textContent = 'Build Another C Configuration';
      return;
    }

    if (message.type === 'error') {
      generationStatus.textContent = message.message || 'The operation failed.';
      generationStatus.classList.add('errorText');
      generateButton.disabled = false;
      return;
    }
  });

  function showView(name) {
    state.view = name;
    Object.entries(views).forEach(([key, element]) => element.classList.toggle('hidden', key !== name));
    if (name === 'mcus') mcuSearch.focus();
    if (name === 'boards') boardSearch.focus();
  }

  function showLoading(text) {
    document.getElementById('loadingText').textContent = text;
    showView('loading');
  }

  function textMatches(values, query) {
    return values.filter(Boolean).some((value) => String(value).toLowerCase().includes(query));
  }

  function renderMcuTable() {
    const query = mcuSearch.value.trim().toLowerCase();
    state.filteredMcus = query
      ? state.mcus.filter((mcu) => textMatches([mcu.uid, mcu.name, mcu.vendor, mcu.familyUid], query))
      : state.mcus;
    document.getElementById('mcuCount').textContent = String(state.filteredMcus.length);
    mcuTableBody.replaceChildren(...state.filteredMcus.map((mcu) => {
      const row = clickableRow(() => {
        state.selectionMode = 'mcu';
        state.selectedBoard = undefined;
        showLoading(`Loading ${mcu.uid} clock configuration...`);
        vscode.postMessage({ type: 'selectMcu', uid: mcu.uid });
      });
      appendCell(row, mcu.uid, 'mcuNameCell');
      appendCell(row, mcu.vendor || '—');
      appendCell(row, mcu.familyUid || '—');
      appendCell(row, mcu.maxSpeed ? `${trimNumber(mcu.maxSpeed)} MHz` : '—');
      appendCell(row, formatBytes(mcu.flash));
      appendCell(row, formatBytes(mcu.ram));
      return row;
    }));
  }

  function renderBoardTable() {
    const query = boardSearch.value.trim().toLowerCase();
    state.filteredBoards = query
      ? state.boards.filter((board) => textMatches([board.uid, board.name, board.vendor, board.category], query))
      : state.boards;
    document.getElementById('boardCount').textContent = String(state.filteredBoards.length);
    boardTableBody.replaceChildren(...state.filteredBoards.map((board) => {
      const row = clickableRow(() => {
        state.selectionMode = 'board';
        state.selectedBoard = board;
        showLoading(`Resolving ${board.name || board.uid}...`);
        vscode.postMessage({ type: 'selectBoard', uid: board.uid });
      });
      appendCell(row, board.name || board.uid, 'mcuNameCell');
      appendCell(row, board.vendor || '—');
      appendCell(row, board.category || '—');
      appendCell(row, String(board.compatibleDeviceCount || 0));
      return row;
    }));
  }

  function renderBoardDeviceTable() {
    boardDeviceTableBody.replaceChildren(...state.boardDevices.map((mcu) => {
      const row = clickableRow(() => {
        showLoading(`Loading ${mcu.uid} clock configuration...`);
        vscode.postMessage({ type: 'selectBoardDevice', boardUid: state.selectedBoard.uid, deviceUid: mcu.uid });
      });
      appendCell(row, mcu.uid, 'mcuNameCell');
      appendCell(row, mcu.vendor || '—');
      appendCell(row, mcu.familyUid || '—');
      appendCell(row, mcu.maxSpeed ? `${trimNumber(mcu.maxSpeed)} MHz` : '—');
      return row;
    }));
  }

  function renderDetail(detail) {
    const device = detail.device || {};
    document.getElementById('selectedName').textContent = device.uid || device.mcuName || '';
    document.getElementById('selectedVendor').textContent = device.vendor || '—';
    document.getElementById('selectedFamily').textContent = device.familyUid || '—';
    document.getElementById('selectedCompiler').textContent = `${detail.compiler?.name || detail.compiler?.uid || '—'} ${detail.compiler?.version || ''}`.trim();
    document.getElementById('selectedCorePath').textContent = detail.device?.corePath || detail.compiler?.corePath || '—';
    document.getElementById('definitionPath').textContent = detail.definitionPath || '—';
    document.getElementById('clockMhz').value = detail.clockMHz || trimNumber(device.maxSpeed) || '';

    const boardCard = document.getElementById('selectedBoardCard');
    if (detail.board) {
      boardCard.classList.remove('hidden');
      document.getElementById('selectedBoardName').textContent = detail.board.name || detail.board.uid;
      document.getElementById('selectedBoardInfo').textContent = `${detail.board.vendor || '—'} · ${detail.board.category || 'Board'} · ${detail.board.mikrobusCount || 0} mikroBUS socket(s) · MCU ${device.uid}`;
    } else {
      boardCard.classList.add('hidden');
    }

    const defaultName = detail.board ? `${detail.board.name || detail.board.uid} - ${device.uid}` : `${device.uid} C Setup`;
    document.getElementById('setupName').value = defaultName;
    document.getElementById('setupMode').value = 'full-sdk';
    // Match NECTO's Application Output concept. Debug Terminal uses the
    // mikroSDK STDOUT logger, whose LOG_MAP_USB_UART macro does not require
    // USB_UART_RX / USB_UART_TX board definitions.
    document.getElementById('applicationOutput').value = 'debug-terminal';

    const packageSelect = document.getElementById('packageSelect');
    const packageOptions = (detail.packages || []).map((item) => option(item.uid, `${item.name || item.uid}${item.pinCount ? ` · ${item.pinCount} pins` : ''}`));
    if (!packageOptions.length) packageOptions.push(option('', 'Default / no package metadata'));
    packageSelect.replaceChildren(...packageOptions);

    const programmerSelect = document.getElementById('programmerSelect');
    programmerSelect.replaceChildren(...(detail.programmers || []).map((item) => option(item.uid, item.name || item.uid, item.uid === 'codegrip')));

    const cards = [];
    for (const register of detail.registers || []) {
      const card = document.createElement('article');
      card.className = 'registerCard';
      const head = document.createElement('div');
      head.className = 'registerHead';
      const title = document.createElement('h4');
      title.textContent = register.label || register.key || 'Register';
      const address = document.createElement('code');
      address.textContent = `${register.key || ''}${register.address ? ` · 0x${String(register.address).replace(/^0x/i, '')}` : ''}`;
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
        for (const setting of field.settings || []) {
          const item = option(String(setting.value), setting.label || setting.value, equalsHex(setting.value, field.init));
          select.append(item);
        }
        wrapper.append(label, select);
        fields.append(wrapper);
      }
      card.append(fields);
      cards.push(card);
    }
    registerGrid.replaceChildren(...cards);
    generationStatus.textContent = `${cards.length} configurable clock/register block(s) loaded from ${pathBase(detail.definitionPath)}.`;
    generationStatus.classList.remove('errorText');
    generateButton.disabled = false;
    generateButton.textContent = 'Build C Configuration';
  }

  function applyExistingSetup(setup) {
    document.getElementById('setupName').value = setup.name || document.getElementById('setupName').value;
    if (setup.mode) document.getElementById('setupMode').value = setup.mode;
    if (setup.applicationOutput) document.getElementById('applicationOutput').value = setup.applicationOutput;
    if (setup.clockMHz) document.getElementById('clockMhz').value = setup.clockMHz;
    if (setup.packageUid && Array.from(document.getElementById('packageSelect').options).some((item) => item.value === String(setup.packageUid))) {
      document.getElementById('packageSelect').value = String(setup.packageUid);
    }
    if (setup.programmerUid && Array.from(document.getElementById('programmerSelect').options).some((item) => item.value === String(setup.programmerUid))) {
      document.getElementById('programmerSelect').value = String(setup.programmerUid);
    }
    for (const select of registerGrid.querySelectorAll('select[data-field-id]')) {
      const selected = setup.registerValues?.[select.dataset.fieldId];
      if (selected !== undefined && Array.from(select.options).some((item) => equalsHex(item.value, selected))) {
        const match = Array.from(select.options).find((item) => equalsHex(item.value, selected));
        if (match) select.value = match.value;
      }
    }
    generationStatus.textContent = `Editing existing setup '${setup.name || setup.id || ''}'. Change clock, register values, programmer or application output, then rebuild.`;
    generationStatus.classList.remove('errorText');
    generateButton.disabled = false;
    generateButton.textContent = 'Reconfigure C Setup';
  }

  function buildConfiguration() {
    const detail = state.detail;
    if (!detail) return;
    const name = document.getElementById('setupName').value.trim();
    const clockMHz = document.getElementById('clockMhz').value;
    if (!name) {
      generationStatus.textContent = 'Enter a setup name.';
      generationStatus.classList.add('errorText');
      return;
    }
    if (!(Number(clockMHz) > 0)) {
      generationStatus.textContent = 'Enter a positive system clock in MHz.';
      generationStatus.classList.add('errorText');
      return;
    }
    const values = {};
    registerGrid.querySelectorAll('select[data-field-id]').forEach((select) => { values[select.dataset.fieldId] = select.value; });
    const payload = {
      setupId: state.editingSetupId,
      name,
      mode: document.getElementById('setupMode').value,
      applicationOutput: document.getElementById('applicationOutput').value,
      clockMHz,
      registerValues: values,
      selectionMode: state.selectionMode || 'mcu',
      boardUid: detail.board?.uid,
      boardName: detail.board?.name,
      deviceUid: detail.device.uid,
      compilerUid: detail.compiler.uid,
      sdkUid: detail.sdk.uid,
      packageUid: document.getElementById('packageSelect').value || undefined,
      programmerUid: document.getElementById('programmerSelect').value
    };
    generationStatus.textContent = `${state.editingSetupId ? 'Reconfiguring' : 'Building'} ${name}...`;
    generationStatus.classList.remove('errorText');
    generateButton.disabled = true;
    vscode.postMessage({ type: 'buildConfiguration', payload });
  }

  function clickableRow(action) {
    const row = document.createElement('tr');
    row.className = 'clickableRow';
    row.tabIndex = 0;
    row.addEventListener('click', action);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        action();
      }
    });
    return row;
  }

  function appendCell(row, value, className = '') {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    cell.textContent = value ?? '—';
    row.append(cell);
  }

  function option(value, label, selected = false) {
    const item = document.createElement('option');
    item.value = String(value ?? '');
    item.textContent = String(label ?? value ?? '');
    item.selected = Boolean(selected);
    return item;
  }

  function equalsHex(left, right) {
    const normalize = (value) => String(value ?? '').replace(/^0x/i, '').replace(/^0+/, '').toLowerCase() || '0';
    return normalize(left) === normalize(right);
  }

  function trimNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? String(number) : String(value || '').replace(/\.0+$/, '');
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return '—';
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) ? 1 : 0)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(bytes % 1024 ? 1 : 0)} KB`;
    return `${bytes} B`;
  }

  function pathBase(value) {
    return String(value || '').split(/[\\/]/).pop() || 'MCU JSON';
  }

  vscode.postMessage({ type: 'ready' });
})();
