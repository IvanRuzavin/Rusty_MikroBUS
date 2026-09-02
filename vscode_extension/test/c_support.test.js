'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const Module = require('module');

const vscodeMock = {
  window: {
    createOutputChannel() {
      return { append() {}, appendLine() {}, show() {}, dispose() {} };
    }
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration() { return { get(_key, fallback) { return fallback; } }; }
  },
  commands: { executeCommand() { return Promise.resolve(); } },
  ProgressLocation: { Notification: 15, Window: 10 }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const setup = require('../c_setup')._test;
  const databaseModule = require('../c_database');
  const database = databaseModule._test;
  const catalog = require('../c_package_catalog')._test;
  const packageManagerModule = require('../c_package_manager');
  const packageManager = packageManagerModule._test;
  const compilerSupport = require('../c_compiler_support');
  const codegrip = require('../codegrip_backend')._test;
  const codegripCatalog = require('../c_codegrip_catalog');
  const rustMcu = require('../mcu_configurator')._test;
  const cConfigurator = require('../c_configurator')._test;

  // config_registers settings_array fields must be materialized into real
  // register-bit values. STM32F756 PLLN=432 occupies bits 14:6 => 0x00006C00.
  const pllDefinition = {
    config_registers: [{
      key: 'RCC_PLLCFGR', address: '40023804', fields: [{
        hidden: false, key: 'PLLN', label: 'PLL multiplication factor',
        init: '00006C00', mask: '00007FC0',
        settings_array: { decrease: false, disabled_when_zero: false, inverted: false, min_value: '50', max_value: '432' }
      }]
    }]
  };
  const serializedPll = cConfigurator.serializeDefinition(pllDefinition);
  const pllOptions = serializedPll[0].fields[0].settings;
  assert.strictEqual(pllOptions.length, 383);
  assert.strictEqual(pllOptions[0].value, '00000C80'); // 50 << 6
  assert.strictEqual(pllOptions[pllOptions.length - 1].value, '00006C00'); // 432 << 6
  assert.strictEqual(cConfigurator.maskShift('00007FC0'), 6);

  const pllRegister = {
    default: '00000000',
    key: 'RCC_PLLCFGR',
    fields: [
      { key: 'PLLM', mask: '0000003F', init: '00000010' },
      { key: 'PLLN', mask: '00007FC0', init: '00006C00' },
      { key: 'PLLP', mask: '00030000', init: '00000000' },
      { key: 'PLLSRC', mask: '00400000', init: '00000000' },
      { key: 'PLLQ', mask: '0F000000', init: '09000000' }
    ]
  };
  assert.strictEqual(setup.defaultRegisterValue(pllRegister, {}), 0x09006C10);
  // Existing 0.7.4 setups contain an empty PLLN override because the UI had an
  // empty select. Empty overrides must now fall back to the MCU JSON init value.
  assert.strictEqual(setup.defaultRegisterValue(pllRegister, { 'RCC_PLLCFGR.PLLN': '' }), 0x09006C10);

  assert.strictEqual(rustMcu.normalizeJlinkDeviceName('R7FA6M4AF3CFB'), 'R7FA6M4AF');
  assert.strictEqual(rustMcu.normalizeJlinkDeviceName('STM32F412ZG'), 'STM32F412ZG');
  assert.strictEqual(rustMcu.isJlinkProgrammer({ programmerUid: 'SEGGER_JLINK', programmerName: 'SEGGER J-Link' }), true);
  assert.strictEqual(rustMcu.isJlinkProgrammer({ programmerUid: 'MIKROE_CODEGRIP', programmerName: 'CODEGRIP' }), false);
  assert.strictEqual(rustMcu.isCodegripProgrammer({ programmerUid: 'MIKROE_CODEGRIP' }), true);
  const fakeUsbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-jlink-usb-'));
  try {
    const stlink = path.join(fakeUsbRoot, '1-1');
    fs.mkdirSync(stlink);
    fs.writeFileSync(path.join(stlink, 'idVendor'), '0483\n');
    fs.writeFileSync(path.join(stlink, 'idProduct'), '374b\n');
    const jlink = path.join(fakeUsbRoot, '1-2');
    fs.mkdirSync(jlink);
    fs.writeFileSync(path.join(jlink, 'idVendor'), '1366\n');
    fs.writeFileSync(path.join(jlink, 'idProduct'), '0105\n');
    fs.writeFileSync(path.join(jlink, 'serial'), '123456789\n');
    fs.writeFileSync(path.join(jlink, 'product'), 'J-Link\n');
    const probes = rustMcu.findLocalJlinkUsbProbes(fakeUsbRoot);
    assert.strictEqual(probes.length, 1);
    assert.strictEqual(probes[0].serialNumber, '123456789');
    assert.strictEqual(rustMcu.shouldUseNativeJlink({ programmerUid: 'SEGGER_JLINK' }, probes), true);
    if (process.platform === 'linux') {
      assert.strictEqual(rustMcu.shouldUseNativeJlink({ programmerUid: 'SEGGER_JLINK' }, []), false);
    }
  } finally {
    fs.rmSync(fakeUsbRoot, { recursive: true, force: true });
  }
  const rustEntrySource = [
    '#[unsafe(no_mangle)]',
    'fn main() -> ! {',
    '    let mut output_1 = digital_out_t::default();',
    '    let mut output_2 = digital_out_t::default();',
    '    let mut output_3 = digital_out_t::default();',
    '',
    '    if digital_out_init(&mut output_1, pin_out_1).is_err()',
    '        || digital_out_init(&mut output_2, pin_out_2).is_err()',
    '        || digital_out_init(&mut output_3, pin_out_3).is_err()',
    '    {',
    '        loop {}',
    '    }',
    '}'
  ].join('\n');
  assert.strictEqual(rustMcu.findMainEntryLine(rustEntrySource), 2);
  assert.deepStrictEqual(rustMcu.rustCodegripPackSpec({
    packageName: 'codegrip_pack_stm32l0',
    packageVersion: '1.0.0',
    displayName: 'STM32L0 CODEGRIP Device Pack',
    downloadUrl: 'https://example/STM32L0.7z'
  }), {
    kind: 'programmer-pack',
    name: 'codegrip_pack_stm32l0',
    version: '1.0.0',
    displayName: 'STM32L0 CODEGRIP Device Pack',
    downloadUrl: 'https://example/STM32L0.7z',
    environment: false
  });

  assert.strictEqual(setup.safeId('STM32F4 Full SDK'), 'stm32f4-full-sdk');
  const cardMetadata = {
    device: { uid: 'MCU_CARD_FOR_STM32_STM32F756ZG', mcuName: 'STM32F756ZG', flash: 1048576, ram: 327680 },
    sdkConfig: { MCU_NAME: 'STM32F756ZG', CORE_NAME: 'M7', _MSDK_MCU_CARD_NAME_: 'MCU_CARD_FOR_STM32' }
  };
  assert.strictEqual(setup.metadataMcuName(cardMetadata), 'STM32F756ZG');
  assert.strictEqual(setup.setupMcuName({ metadata: cardMetadata }), 'STM32F756ZG');

  // Board BSP packages can be packed either as include/boards/<board> or as
  // board/include/boards/<board>. Both must materialize into the canonical
  // mikroSDK bsp/board/include/boards/<board> location.
  const bspMaterializeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-bsp-board-'));
  try {
    const bspRoot = path.join(bspMaterializeRoot, 'sdk', 'bsp');
    const legacyRoot = path.join(bspMaterializeRoot, 'legacy-package');
    const legacyBoard = path.join(legacyRoot, 'include', 'boards', 'board_uni_ds_v8');
    fs.mkdirSync(path.join(legacyBoard, 'extras'), { recursive: true });
    fs.writeFileSync(path.join(legacyBoard, 'board.h'), '// board');
    fs.writeFileSync(path.join(legacyBoard, 'board.cmake'), '# board');
    fs.writeFileSync(path.join(legacyBoard, 'extras', 'pins.h'), '// pins');
    const destination = setup.materializeBoardBspPackage(bspRoot, legacyRoot, 'board_uni_ds_v8', 'uni_ds_v8');
    assert.strictEqual(destination, path.join(bspRoot, 'board', 'include', 'boards', 'board_uni_ds_v8'));
    assert.ok(fs.existsSync(path.join(destination, 'board.h')));
    assert.ok(fs.existsSync(path.join(destination, 'board.cmake')));
    assert.ok(fs.existsSync(path.join(destination, 'extras', 'pins.h')));
    assert.strictEqual(fs.existsSync(path.join(bspRoot, 'include', 'boards', 'board_uni_ds_v8')), false);

    const modernRoot = path.join(bspMaterializeRoot, 'modern-package');
    const modernBoard = path.join(modernRoot, 'board', 'include', 'boards', 'board_uni_ds_v8');
    fs.mkdirSync(modernBoard, { recursive: true });
    fs.writeFileSync(path.join(modernBoard, 'board.h'), '// modern board');
    fs.writeFileSync(path.join(modernBoard, 'board.cmake'), '# modern board');
    setup.materializeBoardBspPackage(bspRoot, modernRoot, 'board_uni_ds_v8', 'uni_ds_v8');
    assert.strictEqual(fs.readFileSync(path.join(destination, 'board.h'), 'utf8'), '// modern board');
  } finally {
    fs.rmSync(bspMaterializeRoot, { recursive: true, force: true });
  }

  // MCU-card BSPs must be materialized under the MCU_NAME directory, matching
  // the path mikroSDK's board CMakeLists resolves at configure time.
  const cardBspRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-bsp-card-'));
  try {
    const bspRoot = path.join(cardBspRoot, 'sdk', 'bsp');
    const packageRoot = path.join(cardBspRoot, 'package');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'mcu_card.h'), '// stm32f756zg card');
    const legacyCardRoot = path.join(bspRoot, 'board', 'include', 'mcu_cards', 'mcu_card_for_stm32');
    fs.mkdirSync(legacyCardRoot, { recursive: true });
    fs.writeFileSync(path.join(legacyCardRoot, 'mcu_card.h'), '// legacy flat header');
    const destination = setup.materializeMcuCardBspPackage(
      bspRoot,
      packageRoot,
      'mcu_card_for_stm32',
      'STM32F756ZG',
      'mcu_card_for_stm32_stm32f756zg'
    );
    assert.strictEqual(destination, path.join(legacyCardRoot, 'STM32F756ZG'));
    assert.strictEqual(fs.readFileSync(path.join(destination, 'mcu_card.h'), 'utf8'), '// stm32f756zg card');
    assert.strictEqual(fs.existsSync(path.join(legacyCardRoot, 'mcu_card.h')), false);
  } finally {
    fs.rmSync(cardBspRoot, { recursive: true, force: true });
  }

  // Package cache identity/path is MCU-specific so two variants of one card
  // package can coexist and uninstall can delete only one MCU_NAME leaf.
  const packageLayoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-package-layout-'));
  try {
    const context = { globalStorageUri: { fsPath: packageLayoutRoot } };
    const cardSpec = {
      kind: 'bsp-card',
      name: 'mcu_card_for_stm32',
      version: 'latest',
      mcuName: 'STM32F756ZG',
      installRelativePath: 'bsp-card/mcu_card_for_stm32/STM32F756ZG'
    };
    assert.strictEqual(packageManagerModule.packageKey(cardSpec), 'bsp-card:mcu_card_for_stm32#STM32F756ZG@latest');
    assert.strictEqual(
      packageManagerModule.packageTarget(context, cardSpec),
      path.join(packageLayoutRoot, 'c-runtime', 'packages', 'bsp-card', 'mcu_card_for_stm32', 'STM32F756ZG')
    );
  } finally {
    fs.rmSync(packageLayoutRoot, { recursive: true, force: true });
  }

  // Uninstall cleanup removes the selected MCU-card's materialized SDK copy,
  // preserves sibling MCUs, and removes the legacy flat 0.7.2 header.
  const uninstallArtifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-uninstall-artifacts-'));
  try {
    const context = { globalStorageUri: { fsPath: uninstallArtifactsRoot } };
    const sdkRoot = path.join(uninstallArtifactsRoot, 'c-runtime', 'packages', 'sdk', 'mikrosdk');
    const cardRoot = path.join(sdkRoot, 'src', 'bsp', 'board', 'include', 'mcu_cards', 'mcu_card_for_stm32');
    const selectedRoot = path.join(cardRoot, 'STM32F756ZG');
    const siblingRoot = path.join(cardRoot, 'STM32F407ZG');
    fs.mkdirSync(selectedRoot, { recursive: true });
    fs.mkdirSync(siblingRoot, { recursive: true });
    fs.writeFileSync(path.join(selectedRoot, 'mcu_card.h'), '// selected');
    fs.writeFileSync(path.join(siblingRoot, 'mcu_card.h'), '// sibling');
    fs.writeFileSync(path.join(cardRoot, 'mcu_card.h'), '// legacy');
    const registry = { packages: [{ kind: 'sdk', name: 'mikrosdk', root: sdkRoot }] };
    packageManager.removeMaterializedPackageArtifacts(context, {
      key: 'bsp-card:mcu_card_for_stm32#STM32F756ZG@latest',
      kind: 'bsp-card',
      name: 'mcu_card_for_stm32',
      folderName: 'mcu_card_for_stm32',
      mcuName: 'STM32F756ZG'
    }, registry);
    assert.strictEqual(fs.existsSync(selectedRoot), false);
    assert.strictEqual(fs.existsSync(path.join(cardRoot, 'mcu_card.h')), false);
    assert.strictEqual(fs.existsSync(path.join(siblingRoot, 'mcu_card.h')), true);
  } finally {
    fs.rmSync(uninstallArtifactsRoot, { recursive: true, force: true });
  }

  const cardCmake = setup.completeSdkCmakeVariables(cardMetadata);
  assert.strictEqual(cardCmake.MCU_NAME, 'STM32F756ZG');
  assert.strictEqual(cardCmake._MSDK_MCU_CARD_NAME_, 'MCU_CARD_FOR_STM32');
  assert.deepStrictEqual(setup.splitFlags('-mcpu=cortex-m4 "-DVALUE=hello world"'), ['-mcpu=cortex-m4', '-DVALUE=hello world']);
  assert.deepStrictEqual(setup.armArchitectureFlags('M4EF', 'STM32F446RE'), ['-mcpu=cortex-m4', '-mthumb', '-mfloat-abi=hard', '-mfpu=fpv4-sp-d16']);
  assert.strictEqual(setup.defaultRegisterValue({
    default: '00000000',
    fields: [{ mask: '0000000F', init: '00000005' }, { mask: '000000F0', init: '000000A0' }]
  }), 0xA5);

  assert.strictEqual(setup.defaultRegisterValue({
    key: 'RCC_CFGR',
    default: '00000000',
    fields: [{ key: 'SW', mask: '00000003', init: '00000000' }]
  }, { 'RCC_CFGR.SW': '00000002' }), 0x2);
  assert.strictEqual(setup.registerFieldId({ key: 'RCC_CFGR' }, { key: 'SW' }), 'RCC_CFGR.SW');

  // Compiler availability requires both CompilerToDevice and a matching
  // compiler-specific core package in Devices.installer_package. Socket/card
  // rows resolve the core package through their sdk_config.MCU_NAME device.
  const compilerDbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-c-compiler-db-'));
  try {
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = path.join(compilerDbRoot, 'c-runtime', 'packages', 'database', 'C_database', 'live', 'necto_db.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE Devices(uid TEXT PRIMARY KEY, name TEXT, sdk_config TEXT, installer_package TEXT, sdk_support INTEGER);
      CREATE TABLE Compilers(uid TEXT PRIMARY KEY, name TEXT, version TEXT, vendor TEXT, language TEXT, path TEXT, default_options TEXT, c_compiler TEXT, cxx_compiler TEXT, gdb_path TEXT, asm_compiler TEXT, clangd_config TEXT, core_path TEXT, installer_package TEXT, sdk_config TEXT);
      CREATE TABLE CompilerToDevice(device_uid TEXT, compiler_uid TEXT);
      CREATE TABLE CompilerToBuildSystem(compiler_uid TEXT, build_system_uid TEXT);
      CREATE TABLE SDKs(uid TEXT PRIMARY KEY, name TEXT, version TEXT);
      CREATE TABLE Programmers(uid TEXT PRIMARY KEY, name TEXT, installer_package TEXT);
      CREATE TABLE ProgrammerToDevice(programer_uid TEXT, device_uid TEXT, device_support_package TEXT);
      INSERT INTO Devices VALUES ('STM32F756ZG','STM32F756ZG','{"MCU_NAME":"STM32F756ZG"}','{"gcc_arm_none_eabi":"arm_gcc_clang_stm32f7x","clang-llvm":"arm_gcc_clang_stm32f7x"}',1);
      INSERT INTO Devices VALUES ('MCU_CARD_FOR_STM32_STM32F756ZG','MCU CARD','{"MCU_NAME":"STM32F756ZG","_MSDK_MCU_CARD_NAME_":"MCU_CARD_FOR_STM32"}','{"package":"mcu_card_for_stm32_stm32f756zg"}',1);
      INSERT INTO Compilers VALUES ('gcc_arm_none_eabi','GCC for ARM','14.2','GNU','C','gcc/arm','{}','bin/arm-none-eabi-gcc','bin/arm-none-eabi-g++','bin/arm-none-eabi-gdb','bin/arm-none-eabi-as','','ARM/gcc_clang','gcc_arm_compiler','');
      INSERT INTO Compilers VALUES ('clang-llvm','Clang for ARM','18.0','LLVM','C, C++','clang','{}','bin/clang','bin/clang','bin/lldb-mi','bin/llvm-as','','ARM/gcc_clang','llvm_clang_compiler','');
      INSERT INTO Compilers VALUES ('mikrocarm','mikroC AI for ARM','3.0','MIKROE','mikroC','mikroc/arm','{}','mikroCARM','','','','','ARM/mikroC','mikroc_arm','');
      INSERT INTO CompilerToBuildSystem VALUES ('gcc_arm_none_eabi','cmake');
      INSERT INTO CompilerToBuildSystem VALUES ('clang-llvm','cmake');
      INSERT INTO CompilerToBuildSystem VALUES ('mikrocarm','cmake');
      INSERT INTO CompilerToDevice VALUES ('MCU_CARD_FOR_STM32_STM32F756ZG','gcc_arm_none_eabi');
      INSERT INTO CompilerToDevice VALUES ('MCU_CARD_FOR_STM32_STM32F756ZG','clang-llvm');
      INSERT INTO CompilerToDevice VALUES ('MCU_CARD_FOR_STM32_STM32F756ZG','mikrocarm');
      INSERT INTO SDKs VALUES ('mikrosdk','mikroSDK','2.0');
      INSERT INTO Programmers VALUES ('codegrip','CODEGRIP','codegrip_gdb_server');
      INSERT INTO ProgrammerToDevice VALUES ('codegrip','MCU_CARD_FOR_STM32_STM32F756ZG','');
    `);
    db.close();
    const context = { globalStorageUri: { fsPath: compilerDbRoot } };
    const mapped = databaseModule.listCompilers(context, 'MCU_CARD_FOR_STM32_STM32F756ZG', compilerSupport.supportedCompilerUids());
    assert.deepStrictEqual(mapped.map((item) => item.uid).sort(), ['clang-llvm', 'gcc_arm_none_eabi']);
    assert.ok(mapped.every((item) => item.corePackageName === 'arm_gcc_clang_stm32f7x'));

    const setupMetadata = databaseModule.getSetupMetadata(context, {
      deviceUid: 'MCU_CARD_FOR_STM32_STM32F756ZG',
      compilerUid: 'gcc_arm_none_eabi',
      sdkUid: 'mikrosdk',
      programmerUid: 'codegrip'
    });
    assert.strictEqual(setupMetadata.device.mcuName, 'STM32F756ZG');
    assert.strictEqual(setupMetadata.packageRequirements.card.name, 'mcu_card_for_stm32_stm32f756zg');
    assert.strictEqual(setupMetadata.packageRequirements.card.folderName, 'mcu_card_for_stm32');
    assert.strictEqual(setupMetadata.packageRequirements.card.mcuName, 'STM32F756ZG');
  } finally {
    fs.rmSync(compilerDbRoot, { recursive: true, force: true });
  }

  const codegripDebugConfig = setup.codegripCppDebugConfiguration({
    name: 'RA6M4 CODEGRIP',
    tools: { gdb: '/toolchain/bin/arm-none-eabi-gdb' },
    metadata: { device: { uid: 'R7FA6M4AF3CFB' } }
  }, '/project', '/project/.mikrobus/c-build/app', 23456, 'generation-test');
  assert.strictEqual(codegripDebugConfig.type, 'cppdbg');
  assert.strictEqual(codegripDebugConfig.request, 'launch');
  assert.strictEqual(codegripDebugConfig.miDebuggerServerAddress, '127.0.0.1:23456');
  assert.strictEqual(codegripDebugConfig.miDebuggerPath, '/toolchain/bin/arm-none-eabi-gdb');
  assert.strictEqual(codegripDebugConfig.launchCompleteCommand, 'exec-continue');
  assert.strictEqual(codegripDebugConfig.stopAtEntry, false);
  assert.ok(codegripDebugConfig.setupCommands.some((item) => item.text === '-gdb-set mem inaccessible-by-default off'));
  assert.strictEqual(JSON.stringify(codegripDebugConfig).includes('monitor reset halt'), false);
  assert.strictEqual(codegripDebugConfig.__mikrobusCodegripC, true);
  assert.strictEqual(codegripDebugConfig.__mikrobusCodegripGeneration, 'generation-test');
  assert.strictEqual(codegripDebugConfig.__mikrobusCDebugInstance, 'generation-test');
  assert.deepStrictEqual(codegripDebugConfig.presentation, { hidden: true });
  assert.strictEqual(setup.isCodegripRestartRequest({ type: 'request', command: 'restart' }), true);
  assert.strictEqual(setup.isCodegripRestartRequest({ type: 'request', command: 'disconnect', arguments: { restart: true } }), true);
  assert.strictEqual(setup.isCodegripRestartRequest({ type: 'request', command: 'disconnect', arguments: {} }), false);
  assert.strictEqual(setup.isCodegripFinalStopRequest({ type: 'request', command: 'disconnect', arguments: {} }), true);
  assert.strictEqual(setup.isCodegripFinalStopRequest({ type: 'request', command: 'disconnect', arguments: { restart: true } }), false);
  assert.strictEqual(setup.isCodegripFinalStopRequest({ type: 'request', command: 'terminate' }), true);

  const eraseScript = setup.jlinkEraseScript('R7FA6M4AF');
  assert.ok(eraseScript.includes('device R7FA6M4AF'));
  assert.ok(eraseScript.includes('\nerase\n'));
  assert.strictEqual(eraseScript.includes('loadfile'), false);

  // BoardToCard now drives board MCU selection through CardToMCU. A
  // dedicated one-MCU card entry is not required; STM32F756ZG must resolve
  // through the generic MCU_CARD_FOR_STM32 relation.
  const rustBoardDbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-rust-board-db-'));
  try {
    const { DatabaseSync } = require('node:sqlite');
    const rustBoardDb = path.join(rustBoardDbRoot, 'database.db');
    const db = new DatabaseSync(rustBoardDb);
    db.exec(`
      CREATE TABLE Board (UID TEXT PRIMARY KEY, NAME TEXT, VENDOR TEXT, BSP_PATH TEXT, CONFIG_JSON TEXT, ENABLED INTEGER);
      CREATE TABLE Family (NAME TEXT PRIMARY KEY, VENDOR TEXT, TARGET TEXT);
      CREATE TABLE MCU (NAME TEXT PRIMARY KEY, FAMILY TEXT, SYSTEM_LIB TEXT);
      CREATE TABLE BoardToDevice (BOARD_UID TEXT, DEVICE_NAME TEXT, IS_DEFAULT INTEGER, CONFIG_JSON TEXT, PRIMARY KEY (BOARD_UID, DEVICE_NAME));
      CREATE TABLE MCUCard (UID TEXT PRIMARY KEY, NAME TEXT, VENDOR TEXT, BSP_PATH TEXT, CONFIG_JSON TEXT, ENABLED INTEGER);
      CREATE TABLE BoardToCard (BOARD_UID TEXT, CARD_UID TEXT, IS_DEFAULT INTEGER, CONFIG_JSON TEXT, PRIMARY KEY (BOARD_UID, CARD_UID));
      CREATE TABLE CardToMCU (CARD_UID TEXT, DEVICE_NAME TEXT, IS_DEFAULT INTEGER, CONFIG_JSON TEXT, PRIMARY KEY (CARD_UID, DEVICE_NAME));
      INSERT INTO Board VALUES ('UNI_DS_V8','UNI-DS v8','MikroElektronika','bsp/boards/uni_ds_v8/board.cfg','{"mcuSelection":"card","mikrobusSource":"board-card"}',1);
      INSERT INTO Family VALUES ('F4','STMicroelectronics','thumbv7em-none-eabihf');
      INSERT INTO Family VALUES ('F7','STMicroelectronics','thumbv7em-none-eabihf');
      INSERT INTO MCU VALUES ('STM32F407ZG','F4','system_stm32f_4xx');
      INSERT INTO MCU VALUES ('STM32F756ZG','F7','system_stm32f_7xx');
      INSERT INTO MCUCard VALUES ('MCU_CARD_FOR_STM32','MCU CARD for STM32','MikroElektronika','bsp/cards/mcu_card_for_stm32/card.cfg','{"hardwareDevices":["STM32F407ZG","STM32F756ZG"]}',1);
      INSERT INTO BoardToCard VALUES ('UNI_DS_V8','MCU_CARD_FOR_STM32',0,'{}');
      INSERT INTO CardToMCU VALUES ('MCU_CARD_FOR_STM32','STM32F407ZG',1,'{}');
      INSERT INTO CardToMCU VALUES ('MCU_CARD_FOR_STM32','STM32F756ZG',0,'{}');
    `);
    db.close();
    const boardRows = rustMcu.readBoardList(rustBoardDb);
    assert.strictEqual(boardRows.length, 1);
    assert.strictEqual(boardRows[0].hasMcuCards, true);
    assert.strictEqual(boardRows[0].selectableMcuCount, 2);
    const boardOptions = rustMcu.readBoardMcuOptions(rustBoardDb, 'UNI_DS_V8');
    assert.deepStrictEqual(boardOptions.map((item) => item.mcuName), ['STM32F407ZG', 'STM32F756ZG']);
    assert.strictEqual(boardOptions[1].vendor, 'STMicroelectronics');
    assert.strictEqual(boardOptions[1].family, 'F7');
    assert.strictEqual(boardOptions[1].target, 'thumbv7em-none-eabihf');
    assert.strictEqual(boardOptions[1].systemLib, 'system_stm32f_7xx');
    const f756Card = rustMcu.resolveBoardMcuOption(rustBoardDb, 'UNI_DS_V8', 'STM32F756ZG');
    assert.strictEqual(f756Card.mcuCardUid, 'MCU_CARD_FOR_STM32');
    assert.strictEqual(f756Card.mcuCardBspPath, 'bsp/cards/mcu_card_for_stm32/card.cfg');
  } finally {
    fs.rmSync(rustBoardDbRoot, { recursive: true, force: true });
  }

  assert.deepStrictEqual(rustMcu.mergeBspConfig({
    headers: { CN1: { A: 'GPIO_A0', B: 'GPIO_B0' } },
    boardOnly: true
  }, {
    headers: { CN1: { A: 'GPIO_C1' } },
    cardOnly: true
  }), {
    headers: { CN1: { A: 'GPIO_C1', B: 'GPIO_B0' } },
    boardOnly: true,
    cardOnly: true
  });

  // A board setup is eligible for mikrobus.rs even when no shield is
  // selected. Native board mappings must therefore generate directly from
  // board.cfg/card.cfg rather than requiring BoardToShield.
  assert.strictEqual(rustMcu.shouldGenerateWorkspaceMikrobus({
    selectionMode: 'board',
    boardUid: 'NATIVE_BOARD'
  }), true);
  assert.strictEqual(rustMcu.shouldGenerateWorkspaceMikrobus({
    selectionMode: 'mcu',
    boardUid: 'NATIVE_BOARD'
  }), false);

  const nativeBoardConfig = {
    headers: {
      MB1: {
        AN: 'GPIO_A0',
        RST: 'GPIO_B1'
      }
    },
    mikrobus: {
      1: {
        AN: 'MB1.AN',
        RST: 'MB1.RST',
        CS: 'GPIO_C2'
      }
    }
  };
  assert.strictEqual(rustMcu.canBuildMikrobusRust(nativeBoardConfig, nativeBoardConfig), true);
  const nativeBoardRust = rustMcu.buildMikrobusRust(nativeBoardConfig, nativeBoardConfig, 'Native Board');
  assert.ok(nativeBoardRust.includes('Generated MikroBUS mapping for Native Board.'));
  assert.ok(nativeBoardRust.includes('pub const MIKROBUS_1_AN: pin_name_t = GPIO_A0;'));
  assert.ok(nativeBoardRust.includes('pub const MIKROBUS_1_RST: pin_name_t = GPIO_B1;'));
  assert.ok(nativeBoardRust.includes('pub const MIKROBUS_1_CS: pin_name_t = GPIO_C2;'));
  assert.strictEqual(nativeBoardRust.includes('with undefined'), false);

  const noMikrobusConfig = { headers: { CN1: { A: 'GPIO_A0' } } };
  assert.strictEqual(rustMcu.canBuildMikrobusRust(noMikrobusConfig, noMikrobusConfig), false);

  const mikrobusManifestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-rust-manifest-'));
  try {
    const manifestDir = path.dirname(rustMcu.setupMikrobusPath(mikrobusManifestRoot));
    fs.mkdirSync(manifestDir, { recursive: true });
    assert.strictEqual(rustMcu.isMikrobusGenerationResolved(mikrobusManifestRoot), false);
    fs.writeFileSync(path.join(manifestDir, 'selection.json'), JSON.stringify({ mikrobusGenerated: false }));
    assert.strictEqual(rustMcu.isMikrobusGenerationResolved(mikrobusManifestRoot), true);
  } finally {
    fs.rmSync(mikrobusManifestRoot, { recursive: true, force: true });
  }

  const rustWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-rust-workspace-'));
  const rustSetupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-rust-setup-'));
  try {
    fs.mkdirSync(path.join(rustWorkspaceRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(rustWorkspaceRoot, 'src', 'main.rs'), 'fn main() {}\n');
    fs.writeFileSync(path.join(rustWorkspaceRoot, 'mikrobus.rs'), '// stale root mapping\n');
    const generatedMikrobus = rustMcu.setupMikrobusPath(rustSetupRoot);
    fs.mkdirSync(path.dirname(generatedMikrobus), { recursive: true });
    fs.writeFileSync(generatedMikrobus, '// generated mapping\n');

    const copied = rustMcu.syncWorkspaceMikrobusFile(
      { openedRoot: rustWorkspaceRoot },
      { sdkRoot: rustSetupRoot }
    );
    assert.strictEqual(copied.copied, true);
    assert.strictEqual(copied.relativePath, 'src/mikrobus.rs');
    assert.strictEqual(fs.readFileSync(path.join(rustWorkspaceRoot, 'src', 'mikrobus.rs'), 'utf8'), '// generated mapping\n');
    assert.strictEqual(fs.existsSync(path.join(rustWorkspaceRoot, 'mikrobus.rs')), false);

    fs.rmSync(generatedMikrobus, { force: true });
    const removed = rustMcu.syncWorkspaceMikrobusFile(
      { openedRoot: rustWorkspaceRoot },
      { sdkRoot: rustSetupRoot }
    );
    assert.strictEqual(removed.copied, false);
    assert.deepStrictEqual(removed.deleted, ['src/mikrobus.rs']);
    assert.strictEqual(fs.existsSync(path.join(rustWorkspaceRoot, 'src', 'mikrobus.rs')), false);
  } finally {
    fs.rmSync(rustWorkspaceRoot, { recursive: true, force: true });
    fs.rmSync(rustSetupRoot, { recursive: true, force: true });
  }

  const codegripCsv = [
    'vendor,name,programmers,debuggers,category,package_name,package_version,display_name,install_location,download_link,dependencies,release_date',
    'Renesas,R7FA6M4AF3CFB,CODEGRIP,CODEGRIP,CODEGRIP Device Pack,codegrip_pack_ra6m4af,1.0.2,RA6M4AF CODEGRIP Device Pack,%APPLICATION_DATA_DIR%/packages/programmers/codegrip/packs/ARM/Renesas/RA6,https://example/RA6M4AF.7z,"[""codegrip_gdb_server""]",2025-07-29T00:00:00Z'
  ].join('\n');
  const resolvedCodegrip = codegripCatalog.resolveDeviceFromCsv(codegripCsv, 'R7FA6M4AF3CFB');
  assert.strictEqual(resolvedCodegrip.packages.length, 1);
  assert.strictEqual(resolvedCodegrip.packages[0].packageName, 'codegrip_pack_ra6m4af');
  assert.strictEqual(resolvedCodegrip.packages[0].downloadUrl, 'https://example/RA6M4AF.7z');
  assert.deepStrictEqual(codegripCatalog.relativePacksInstallPath(resolvedCodegrip.packages[0].installLocation), ['ARM', 'Renesas', 'RA6']);
  assert.deepStrictEqual(resolvedCodegrip.packages[0].dependencies, ['codegrip_gdb_server']);

  const codegripPayloadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-c-codegrip-payload-'));
  try {
    const nested = path.join(codegripPayloadRoot, 'some-wrapper', 'codegrip');
    fs.mkdirSync(path.join(nested, 'apps', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(nested, 'apps', 'bin', 'CodegripGdbServer'), 'server');
    assert.strictEqual(packageManager.findCodegripPayloadRoot(codegripPayloadRoot), nested);
    assert.strictEqual(packageManager.codegripServerInstalled(nested), true);
    assert.strictEqual(packageManager.isCodegripServerFileName('CodegripGdbServer'), true);
    assert.strictEqual(packageManager.isCodegripServerFileName('codegrip_gdb_server'), true);
    assert.strictEqual(packageManager.isCodegripServerFileName('codegrip-gdb-server'), true);
    assert.strictEqual(packageManager.isCodegripServerFileName('not-a-server'), false);
    assert.strictEqual(packageManager.isCodegripServerSpec({ kind: 'programmer', name: 'codegrip_gdb_server' }), true);
    assert.ok(packageManager.environmentSpecs().every((item) => item.kind !== 'programmer' && item.kind !== 'programmer-pack'));
    assert.ok(packageManager.environmentSpecs().some((item) => item.name === 'C_database'));
    assert.ok(packageManager.environmentSpecs().every((item) => item.kind !== 'toolchain'));
    const recursiveToolRoot = path.join(codegripPayloadRoot, 'recursive-tool-test');
    const recursiveTool = path.join(recursiveToolRoot, 'wrapper', 'bin', 'arm-none-eabi-gcc');
    fs.mkdirSync(path.dirname(recursiveTool), { recursive: true });
    fs.writeFileSync(recursiveTool, 'tool');
    assert.strictEqual(packageManager.findRecursive(recursiveToolRoot, (_candidate, name) => name === 'arm-none-eabi-gcc', 8), recursiveTool);
    packageManager.makeManagedToolchainExecutables(recursiveToolRoot, { kind: 'toolchain', toolchainBinaries: ['bin/arm-none-eabi-gcc'] });
    if (process.platform !== 'win32') assert.ok((fs.statSync(recursiveTool).mode & 0o111) !== 0);
    assert.ok(compilerSupport.supportedCompilerUids().includes('gcc_arm_none_eabi'));
    assert.ok(compilerSupport.supportedCompilerUids().includes('xpack-riscv-none-embed-gcc'));
    assert.ok(compilerSupport.supportedCompilerUids().includes('clang-llvm'));
    assert.ok(compilerSupport.supportedCompilerUids().includes('clang-llvm-riscv'));
    assert.ok(compilerSupport.supportedCompilerUids().includes('mchp_xc8'));
    assert.ok(compilerSupport.supportedCompilerUids().includes('mchp_xc16'));
    assert.ok(compilerSupport.supportedCompilerUids().includes('mchp_xc32'));
    assert.ok(compilerSupport.supportedCompilerUids().includes('llvm-rl78-elf'));
    assert.ok(compilerSupport.supportedCompilerUids().includes('rx-elf-gcc'));
    assert.ok(compilerSupport.supportedCompilerUids().includes('mikrocarm'));
    assert.ok(compilerSupport.supportedCompilerUids().includes('mikrocpic'));
    assert.ok(compilerSupport.supportedCompilerUids().includes('mikrocpic32'));
    assert.ok(compilerSupport.supportedCompilerUids().includes('mikrocdspic'));
    assert.ok(compilerSupport.supportedCompilerUids().includes('mikrocavr'));
    assert.strictEqual(compilerSupport.coreMetadataCompilerLabel('gcc_arm_none_eabi'), 'GCC');
    assert.strictEqual(compilerSupport.coreMetadataCompilerLabel('clang-llvm'), 'Clang');
    assert.strictEqual(compilerSupport.coreMetadataCompilerLabel('mchp_xc8'), 'XC8');
    assert.strictEqual(compilerSupport.coreMetadataCompilerLabel('mchp_xc16'), 'XC16');
    assert.strictEqual(compilerSupport.coreMetadataCompilerLabel('mchp_xc32'), 'XC32');
    assert.strictEqual(compilerSupport.coreMetadataCompilerLabel('llvm-rl78-elf'), 'LLVM');
    assert.strictEqual(compilerSupport.coreMetadataCompilerLabel('rx-elf-gcc'), 'gcc');
    assert.strictEqual(compilerSupport.coreMetadataCompilerLabel('mikrocarm'), 'mikroC AI');
    assert.strictEqual(compilerSupport.isGccCompiler('gcc_arm_none_eabi'), true);
    assert.strictEqual(compilerSupport.isGccCompiler('xpack-riscv-none-embed-gcc'), true);
    assert.strictEqual(compilerSupport.isGccCompiler('rx-elf-gcc'), true);
    assert.strictEqual(compilerSupport.isGccCompiler('clang-llvm'), false);
    const compilerChoices = [
      { uid: 'clang-llvm', name: 'Clang for ARM' },
      { uid: 'gcc_arm_none_eabi', name: 'GCC for ARM' },
      { uid: 'mikrocarm', name: 'mikroC AI for ARM' }
    ];
    assert.strictEqual(compilerSupport.preferredCompiler(compilerChoices)?.uid, 'gcc_arm_none_eabi');
    assert.strictEqual(compilerSupport.preferredCompiler(compilerChoices, 'clang-llvm')?.uid, 'clang-llvm');
    assert.strictEqual(compilerSupport.preferredCompiler([{ uid: 'clang-llvm' }, { uid: 'mikrocarm' }])?.uid, 'clang-llvm');
    if (process.platform === 'linux') {
      assert.strictEqual(compilerSupport.compilerAsset('gcc_riscv_compiler').url, 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/gcc/riscv/linux/riscv32-unknown-elf-gcc.7z');
      assert.strictEqual(compilerSupport.compilerAsset('microchip_xc8_compiler').url, 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/xc8/linux/xc8.7z');
      assert.strictEqual(compilerSupport.compilerAsset('microchip_xc16_compiler').url, 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/xc16/linux/xc16.7z');
      assert.strictEqual(compilerSupport.compilerAsset('microchip_xc32_compiler').url, 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/xc32/linux/xc32.7z');
      assert.strictEqual(compilerSupport.compilerAsset('llvm_clang_compiler').url, 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/clang/linux/clang.7z');
      assert.strictEqual(compilerSupport.compilerAsset('gcc_rx_compiler').url, 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/gcc/rx/linux/rx-elf-gcc.7z');
      assert.strictEqual(compilerSupport.compilerAsset('llvm_rl78_compiler').url, 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/llvm/rl78/linux/llvm-rl78-elf.7z');
    }
  assert.ok(packageManager.jsonAcceptHeader().includes('application/vnd.github+json'));
  assert.ok(packageManager.jsonAcceptHeader().includes('application/json'));
  } finally {
    fs.rmSync(codegripPayloadRoot, { recursive: true, force: true });
  }

  const renamedCodegripRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-c-codegrip-renamed-'));
  try {
    fs.mkdirSync(path.join(renamedCodegripRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(renamedCodegripRoot, 'bin', 'codegrip_gdb_server'), 'server');
    assert.strictEqual(packageManager.codegripServerInstalled(renamedCodegripRoot), true);
    assert.strictEqual(packageManager.findRecursiveCodegripServer(renamedCodegripRoot), path.join(renamedCodegripRoot, 'bin', 'codegrip_gdb_server'));
    assert.strictEqual(packageManager.inferCodegripPayloadRootFromExecutable(path.join(renamedCodegripRoot, 'bin', 'codegrip_gdb_server')), renamedCodegripRoot);
  } finally {
    fs.rmSync(renamedCodegripRoot, { recursive: true, force: true });
  }

  const codegripRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-c-codegrip-'));
  try {
    const context = { globalStorageUri: { fsPath: codegripRuntimeRoot } };
    const serverRoot = path.join(codegripRuntimeRoot, 'server');
    const packRoot = path.join(codegripRuntimeRoot, 'pack');
    fs.mkdirSync(path.join(serverRoot, 'apps', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(serverRoot, 'packs', 'common'), { recursive: true });
    fs.mkdirSync(packRoot, { recursive: true });
    fs.writeFileSync(path.join(serverRoot, 'apps', 'bin', 'CodegripGdbServer'), 'server');
    fs.writeFileSync(path.join(serverRoot, 'packs', 'common', 'base.dat'), 'base');
    fs.writeFileSync(path.join(packRoot, 'R7FA6M4AF3CFB.mcu'), 'mcu');
    const pkg = resolvedCodegrip.packages[0];
    const setupObject = {
      id: 'ra6m4-test',
      metadata: { programmer: { uid: 'codegrip' }, device: { uid: 'R7FA6M4AF3CFB' } },
      codegripCatalog: resolvedCodegrip
    };
    const installed = new Map([
      ['programmer:codegrip_gdb_server@1.7.0', { root: serverRoot }],
      [`programmer-pack:${pkg.packageName}@${pkg.packageVersion}`, { root: packRoot }]
    ]);
    const runtime = setup.materializeCodegripRuntime(context, setupObject, installed);
    assert.ok(fs.existsSync(runtime.serverExecutable));
    assert.ok(fs.existsSync(path.join(runtime.packsRoot, 'common', 'base.dat')));
    assert.ok(fs.existsSync(path.join(runtime.packsRoot, 'ARM', 'Renesas', 'RA6', 'R7FA6M4AF3CFB.mcu')));
  } finally {
    fs.rmSync(codegripRuntimeRoot, { recursive: true, force: true });
  }

  // Board sdk_config uses NECTO metadata keys with surrounding underscores,
  // while mikroSDK BSP CMake expects the non-underscored cache variables.
  assert.deepStrictEqual(setup.sdkCmakeVariables({
    _MSDK_BOARD_NAME_: 'BOARD_EK_RA6M4',
    HAS_MIKROBUS: 'true'
  }), { MSDK_BOARD_NAME: 'BOARD_EK_RA6M4' });
  assert.deepStrictEqual(setup.sdkCmakeVariables({
    _MSDK_BOARD_NAME_: 'BOARD_FPB_RA2E3',
    _MSDK_SHIELD_: 'shield_for_arduino_uno'
  }), {
    MSDK_BOARD_NAME: 'BOARD_FPB_RA2E3',
    MSDK_SHIELD: 'shield_for_arduino_uno'
  });
  assert.deepStrictEqual(setup.sdkCmakeVariables({
    _MSDK_BOARD_NAME_: 'GENERIC_BOARD'
  }), { MSDK_BOARD_NAME: 'GENERIC_BOARD' });

  assert.deepStrictEqual(setup.sdkCmakeVariables({
    MCU_NAME: 'R7FA6M4AF3CFB',
    CORE_NAME: 'M33EF',
    _MSDK_HAL_LOW_LEVEL_TARGET_: 'mikroe',
    _MSDK_ETH_PHY_CHIP_: 'NULL'
  }), {
    MSDK_HAL_LOW_LEVEL_TARGET: 'mikroe',
    MSDK_ETH_PHY_CHIP: 'NULL'
  });

  assert.deepStrictEqual(setup.completeSdkCmakeVariables({
    device: { uid: 'R7FA6M4AF3CFB', flash: 1048576, ram: 262144 },
    sdkConfig: {
      MCU_NAME: 'R7FA6M4AF3CFB',
      CORE_NAME: 'M33EF',
      _MSDK_HAL_LOW_LEVEL_TARGET_: 'mikroe',
      _MSDK_BOARD_NAME_: 'BOARD_EK_RA6M4'
    }
  }), {
    MCU_NAME: 'R7FA6M4AF3CFB',
    CORE_NAME: 'M33EF',
    _MSDK_HAL_LOW_LEVEL_TARGET_: 'mikroe',
    _MSDK_BOARD_NAME_: 'BOARD_EK_RA6M4',
    MSDK_HAL_LOW_LEVEL_TARGET: 'mikroe',
    MSDK_BOARD_NAME: 'BOARD_EK_RA6M4',
    MCU_FLASH: 1048576,
    MCU_RAM: 262144
  });

  assert.deepStrictEqual(setup.coreCompatibilityFlags('M33EF', {
    name: 'arm-none-eabi-gcc', version: '14.2.1'
  }), [
    '-Wno-incompatible-pointer-types',
    '-Wno-int-conversion',
    '-Wno-incompatible-function-pointer-types'
  ]);
  assert.deepStrictEqual(setup.coreCompatibilityFlags('M0+', {
    name: 'arm-none-eabi-gcc', version: '14.2.1'
  }), []);
  assert.strictEqual(setup.normalizeApplicationOutput('UART'), 'uart');
  assert.strictEqual(setup.normalizeApplicationOutput('Debug Terminal'), 'debug-terminal');
  assert.strictEqual(setup.normalizeApplicationOutput('LOG_INTERFACE_STDOUT'), 'debug-terminal');
  assert.strictEqual(setup.applicationOutputCmakeValue('uart'), 'LOG_INTERFACE_UART');
  assert.strictEqual(setup.applicationOutputCmakeValue('debug-terminal'), 'LOG_INTERFACE_STDOUT');
  assert.strictEqual(setup.hexPathForExecutable('/tmp/example.elf'), path.join('/tmp', 'example.hex'));
  assert.strictEqual(setup.hexPathForExecutable('/tmp/example_ipsdisplay2'), '/tmp/example_ipsdisplay2.hex');
  assert.strictEqual(setup.normalizeJlinkDeviceName('R7FA6M4AF3CFB'), 'R7FA6M4AF');
  assert.strictEqual(setup.normalizeJlinkDeviceName('STM32F446RE'), 'STM32F446RE');
  assert.strictEqual(setup.findCMainEntryLine([
    '#include <stdint.h>',
    '',
    'int main(void)',
    '{',
    '    // initialize application',
    '    application_init();',
    '    for (;;) {}',
    '}'
  ].join('\n')), 5);
  assert.strictEqual(setup.findCMainEntryLine('int main(void) { application_init(); return 0; }\n'), 0);

  const elfProbeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-c-elf-'));
  try {
    const objectFile = path.join(elfProbeRoot, 'CMakeFiles', 'main.c.obj');
    const executableFile = path.join(elfProbeRoot, 'example_ipsdisplay2');
    fs.mkdirSync(path.dirname(objectFile), { recursive: true });
    const makeElf = (type) => {
      const buffer = Buffer.alloc(20);
      buffer[0] = 0x7f; buffer[1] = 0x45; buffer[2] = 0x4c; buffer[3] = 0x46;
      buffer[4] = 1; buffer[5] = 1; // ELF32, little endian
      buffer.writeUInt16LE(type, 16);
      return buffer;
    };
    const unrelated = path.join(elfProbeRoot, 'newer_helper');
    const projectRoot = path.join(elfProbeRoot, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'CMakeLists.txt'), 'add_executable(example_ipsdisplay2 main.c)\n');
    fs.writeFileSync(objectFile, makeElf(1)); // ET_REL
    fs.writeFileSync(executableFile, makeElf(2)); // ET_EXEC
    fs.writeFileSync(unrelated, makeElf(2));
    const future = new Date(Date.now() + 10000);
    fs.utimesSync(unrelated, future, future);
    assert.strictEqual(setup.isElfExecutable(objectFile), false);
    assert.strictEqual(setup.isElfExecutable(executableFile), true);
    assert.deepStrictEqual(setup.cmakeExecutableTargets(projectRoot), ['example_ipsdisplay2']);
    assert.strictEqual(setup.findBuiltExecutable(elfProbeRoot, projectRoot), executableFile);
  } finally {
    fs.rmSync(elfProbeRoot, { recursive: true, force: true });
  }

  const cmakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-c-root-'));
  try {
    const nested = path.join(cmakeRoot, 'src', 'drivers');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(cmakeRoot, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n');
    const source = path.join(nested, 'main.c');
    fs.writeFileSync(source, 'int main(void){return 0;}\n');
    fs.writeFileSync(path.join(cmakeRoot, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nadd_executable(test src/drivers/main.c)\n');
    assert.strictEqual(setup.findCmakeProjectRoot(source, cmakeRoot), cmakeRoot);
    assert.strictEqual(setup.findProjectMainSource(cmakeRoot), source);
  } finally {
    fs.rmSync(cmakeRoot, { recursive: true, force: true });
  }

  const appliedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-c-apply-clean-'));
  try {
    fs.mkdirSync(path.join(appliedRoot, '.mikrobus', 'c-build'), { recursive: true });
    fs.mkdirSync(path.join(appliedRoot, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(appliedRoot, '.mikrobus', 'c-build', 'CMakeCache.txt'), 'old setup');
    fs.writeFileSync(path.join(appliedRoot, '.vscode', 'mikrobus-c.json'), '{"setupId":"old"}');
    fs.writeFileSync(path.join(appliedRoot, 'CMakeLists.txt'), 'project(example)');
    fs.writeFileSync(path.join(appliedRoot, 'main.c'), 'int main(void){return 0;}');
    setup.cleanAppliedSetupArtifacts(appliedRoot);
    assert.strictEqual(fs.existsSync(path.join(appliedRoot, '.mikrobus')), false);
    assert.strictEqual(fs.existsSync(path.join(appliedRoot, '.vscode', 'mikrobus-c.json')), false);
    assert.strictEqual(fs.existsSync(path.join(appliedRoot, 'CMakeLists.txt')), true);
    assert.strictEqual(fs.existsSync(path.join(appliedRoot, 'main.c')), true);
  } finally {
    fs.rmSync(appliedRoot, { recursive: true, force: true });
  }

  assert.strictEqual(setup.versionAtLeast('14.2.1', '14.2.1'), true);
  assert.strictEqual(setup.versionAtLeast('14.3.0', '14.2.1'), true);
  assert.strictEqual(setup.versionAtLeast('13.2.1', '14.2.1'), false);

  const mergedRa6 = database.mergeSdkConfigSources({
    compiler: { _MSDK_COMPILER_ID_: 'gcc_arm_none_eabi' },
    device: { MCU_NAME: 'R7FA6M4AF3CFB', CORE_NAME: 'M33EF', _MSDK_HAL_LOW_LEVEL_TARGET_: 'mikroe' },
    devicePackage: { _MSDK_PACKAGE_NAME_: 'CFB' },
    board: { _MSDK_BOARD_NAME_: 'BOARD_EK_RA6M4', HAS_MIKROBUS: 'true' }
  });
  assert.deepStrictEqual(mergedRa6.sources.device, {
    MCU_NAME: 'R7FA6M4AF3CFB', CORE_NAME: 'M33EF', _MSDK_HAL_LOW_LEVEL_TARGET_: 'mikroe'
  });
  assert.strictEqual(mergedRa6.merged.CORE_NAME, 'M33EF');
  assert.strictEqual(mergedRa6.merged._MSDK_BOARD_NAME_, 'BOARD_EK_RA6M4');
  assert.strictEqual(mergedRa6.merged.HAS_MIKROBUS, 'true');


  // MCU memory values come directly from Devices.flash/Devices.ram and are
  // already stored in bytes. No KiB/MiB conversion is applied.
  assert.deepStrictEqual(setup.sdkMemoryVariables({
    device: { uid: 'R7FA6M4AF3CFB', flash: 1048576, ram: 262144 }
  }), { MCU_FLASH: 1048576, MCU_RAM: 262144 });

  assert.deepStrictEqual(setup.expectedSdkDriverPackages({
    device: { uid: 'R7FA6M4AF3CFB' },
    sdkConfig: { MCU_NAME: 'R7FA6M4AF3CFB', CORE_NAME: 'M33EF' }
  }), [
    'MikroSDK.Driver.ADC',
    'MikroSDK.Driver.GPIO.In',
    'MikroSDK.Driver.GPIO.Out',
    'MikroSDK.Driver.GPIO.Port',
    'MikroSDK.Driver.I2C.Master',
    'MikroSDK.Driver.PWM',
    'MikroSDK.Driver.SPI.Master',
    'MikroSDK.Driver.UART',
    'MikroSDK.Driver.OneWire'
  ]);

  // core_header.h must be generated from include/core_header.h.in using the
  // selected/initial register values, and it must be suitable for placement
  // directly in the core CMake binary directory (the install rule reads it
  // from ${CMAKE_BINARY_DIR}/core_header.h).
  const headerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-c-header-'));
  try {
    const coreRoot = path.join(headerRoot, 'core');
    const outputRoot = path.join(headerRoot, 'build', 'core');
    fs.mkdirSync(path.join(coreRoot, 'include'), { recursive: true });
    fs.mkdirSync(path.join(coreRoot, 'def'), { recursive: true });
    fs.writeFileSync(path.join(coreRoot, 'include', 'core_header.h.in'), 'BEGIN\n%DEFINE_STRINGS%END\n');
    fs.writeFileSync(path.join(coreRoot, 'def', 'TEST_MCU.json'), JSON.stringify({
      config_registers: [
        { key: 'SYSTEM_A', address: '40000000', default: 'f0', fields: [
          { key: 'LOW', mask: '0f', init: '05' }
        ] },
        { key: 'SYSTEM_B', address: '40000004', default: '0', fields: [
          { key: 'SEL', mask: '03', init: '01' }
        ] }
      ]
    }));
    const generated = setup.generateCoreHeader(coreRoot, {
      device: { uid: 'TEST_MCU', defFile: 'TEST_MCU.json' }
    }, '200', outputRoot, { 'SYSTEM_B.SEL': '02' });
    assert.strictEqual(generated, path.join(outputRoot, 'core_header.h'));
    const generatedText = fs.readFileSync(generated, 'utf8');
    assert.ok(generatedText.includes('#define ADDRESS_SYSTEM_A 0x40000000'));
    assert.ok(generatedText.includes('#define VALUE_SYSTEM_A 0x000000F5'));
    assert.ok(generatedText.includes('#define VALUE_SYSTEM_B 0x00000002'));
    assert.ok(generatedText.includes('#define FOSC_KHZ_VALUE 200000'));
    assert.ok(generatedText.includes('#define TEST_MCU'));
  } finally {
    fs.rmSync(headerRoot, { recursive: true, force: true });
  }

  const toolchainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-c-toolchain-'));
  try {
    const toolchainFile = path.join(toolchainRoot, 'toolchain.cmake');
    setup.writeToolchain(toolchainFile, {
      clockMHz: '200', applicationOutput: 'debug-terminal',
      metadata: {
        device: { uid: 'R7FA6M4AF3CFB', flash: 1048576, ram: 262144, compilerFlags: '', linkerFlags: '' },
        compiler: { uid: 'gcc_arm_none_eabi' },
        sdkConfig: { MCU_NAME: 'R7FA6M4AF3CFB', CORE_NAME: 'M33EF' }
      }
    }, {
      c: '/toolchain/bin/arm-none-eabi-gcc',
      cxx: '/toolchain/bin/arm-none-eabi-g++',
      asm: '/toolchain/bin/arm-none-eabi-as',
      cmakeAsm: '/toolchain/bin/arm-none-eabi-as',
      assembler: '/toolchain/bin/arm-none-eabi-as',
      adapter: compilerSupport.adapterFor('gcc_arm_none_eabi')
    }, {
      compatibilityModuleRoot: toolchainRoot,
      infrastructureRoot: toolchainRoot,
      installPrefix: toolchainRoot
    });
    const toolchainText = fs.readFileSync(toolchainFile, 'utf8');
    assert.ok(toolchainText.includes('add_compile_definitions(PREINIT_SUPPORTED)'));
    assert.ok(toolchainText.includes('set(OSC_KHZ \"200000\" CACHE STRING \"\" FORCE)'));
  } finally {
    fs.rmSync(toolchainRoot, { recursive: true, force: true });
  }

  assert.strictEqual(setup.C_BUILD_SUPPORT_VERSION, 22);
  const setupSource = fs.readFileSync(path.join(__dirname, '..', 'c_setup.js'), 'utf8');
  assert.ok(setupSource.includes('const assembler = resolveTool'));
  assert.ok(setupSource.includes('const cmakeAsm = adapter.cmakeAsmViaCCompiler ? c'));
  assert.ok(setupSource.includes("mikrobusC.openCompilerPackages"));
  const configuratorSource = fs.readFileSync(path.join(__dirname, '..', 'c_configurator.js'), 'utf8');
  const configuratorClientSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'c_mcu.js'), 'utf8');
  const configuratorStyleSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'mcu.css'), 'utf8');
  assert.ok(configuratorSource.includes('id="boardDeviceSearch"'));
  assert.ok(configuratorSource.includes('id="compilerSelect"'));
  assert.ok(configuratorSource.includes("message.type === 'selectCompiler'"));
  assert.ok(configuratorSource.includes('compilerSupport.preferredCompiler(compilers, compilerUid)'));
  assert.ok(configuratorStyleSource.includes('.metaGrid select, .clockInput input, .clockInput select, .field select'));
  assert.ok(configuratorStyleSource.includes('background: var(--vscode-dropdown-background)'));
  assert.ok(configuratorClientSource.includes('filteredBoardDevices'));
  assert.ok(configuratorClientSource.includes("type: 'selectCompiler'"));
  assert.ok(setupSource.includes('metadata.packageRequirements.card.mcuName ||'));
  assert.ok(setupSource.includes('metadata.device?.mcuName ||'));
  assert.ok(setupSource.includes('metadata.sdkConfig?.MCU_NAME ||'));
  const packageManagerSource = fs.readFileSync(path.join(__dirname, '..', 'c_package_manager.js'), 'utf8');
  assert.ok(packageManagerSource.includes('Compiler packages'));
  assert.ok(packageManagerSource.includes("kind === 'compiler'"));
  assert.ok(packageManagerSource.includes('CODEGRIP packages'));
  assert.ok(packageManagerSource.includes("kind === 'codegrip'"));
  assert.ok(packageManagerSource.includes('installedOnly'));

  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(packageJson.activationEvents.includes('onCommand:mikrobusC.openCompilerPackages'));
  assert.ok(packageJson.contributes.commands.some((item) => item.command === 'mikrobusC.openCompilerPackages'));

  const infraRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-c-infra-'));
  try {
    const commonRoot = path.join(infraRoot, 'common');
    const testRoot = path.join(infraRoot, 'unit-test');
    const preinitRoot = path.join(infraRoot, 'preinit');
    fs.mkdirSync(commonRoot, { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(preinitRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(commonRoot, 'mikroeUtilsCommon.cmake'), [
      'macro(common_marker)',
      '  set(MIKROBUS_COMMON_INCLUDED TRUE)',
      'endmacro()',
      'macro(add_preinit_lib)',
      '  message(FATAL_ERROR "stock add_preinit_lib must be overridden")',
      'endmacro()',
      'macro(core_version_export lib)',
      '  target_compile_definitions(${lib} INTERFACE MikroCCoreVersion=1)',
      'endmacro()',
      'macro(preinit_support lib)',
      '  target_compile_definitions(${lib} INTERFACE PREINIT_SUPPORTED)',
      'endmacro()',
      ''
    ].join('\n'));
    fs.writeFileSync(path.join(testRoot, 'src', 'unit_test_api.c'), 'void unit_test_api(void) {}\n');
    fs.writeFileSync(path.join(preinitRoot, 'src', 'preinit.c'), 'void preinit(void) {}\n');
    fs.writeFileSync(path.join(preinitRoot, 'CMakeLists.txt'), [
      'cmake_minimum_required(VERSION 3.20)',
      'include(mikroeUtils)',
      'add_library(preinit_dummy INTERFACE)',
      ''
    ].join('\n'));

    const installed = new Map([
      ['common', { kind: 'infrastructure', name: 'mikroe_utils_common', root: commonRoot }],
      ['test', { kind: 'infrastructure', name: 'unit_test_lib', root: testRoot }],
      ['preinit', { kind: 'infrastructure', name: 'preinit', root: preinitRoot }]
    ]);
    const locations = setup.infrastructureLocations(installed);
    assert.strictEqual(locations.cmakeModuleFile, path.join(commonRoot, 'mikroeUtilsCommon.cmake'));
    assert.strictEqual(locations.cmakeUtils, commonRoot);
    assert.strictEqual(locations.testLib, testRoot);
    assert.strictEqual(locations.preinit, preinitRoot);

    const generatedRoot = path.join(infraRoot, 'generated');
    const compatibilityRoot = setup.generateMikroeUtilsCompatibility(locations, generatedRoot);
    const compatibilityFile = path.join(compatibilityRoot, 'mikroeUtils.cmake');
    const compatibilityText = fs.readFileSync(compatibilityFile, 'utf8');
    assert.ok(compatibilityText.includes('mikroeUtilsCommon.cmake'));
    assert.ok(compatibilityText.includes('PREINIT_ROUTINE_PATH'));
    assert.ok(compatibilityText.includes('add_subdirectory'));
    assert.ok(compatibilityText.includes('function(core_install targetAlias)'));
    assert.ok(compatibilityText.includes('mikroeExportConfig.cmake.in'));
    assert.ok(compatibilityText.includes('macro(add_fosc_macro target)'));
    assert.ok(compatibilityText.includes('OSC_KHZ=${OSC_KHZ}'));
    assert.ok(fs.existsSync(path.join(compatibilityRoot, 'mikroeExportConfig.cmake.in')));

    const smokeRoot = path.join(infraRoot, 'smoke');
    const smokeBuild = path.join(infraRoot, 'smoke-build');
    fs.mkdirSync(smokeRoot, { recursive: true });
    fs.writeFileSync(path.join(smokeRoot, 'CMakeLists.txt'), [
      'cmake_minimum_required(VERSION 3.20)',
      'project(mikrobus_compat_smoke VERSION 1 LANGUAGES C)',
      'include(GNUInstallDirs)',
      'include(CMakePackageConfigHelpers)',
      'include(mikroeUtils)',
      'common_marker()',
      'if(NOT MIKROBUS_COMMON_INCLUDED)',
      '  message(FATAL_ERROR "common module was not loaded")',
      'endif()',
      'add_preinit_lib()',
      'if(NOT TARGET preinit_dummy)',
      '  message(FATAL_ERROR "preinit target was not added")',
      'endif()',
      'file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/dummy.c" "void dummy(void) {}\n")',
      'add_library(core_dummy STATIC "${CMAKE_CURRENT_BINARY_DIR}/dummy.c")',
      'add_library(MikroC.Core ALIAS core_dummy)',
      'core_install(MikroC.Core)',
      'if(NOT EXISTS "${CMAKE_CURRENT_BINARY_DIR}/MikroC.CoreConfig.cmake")',
      '  message(FATAL_ERROR "core package config was not generated")',
      'endif()',
      ''
    ].join('\n'));
    const cmake = childProcess.spawnSync('cmake', [
      '-S', smokeRoot,
      '-B', smokeBuild,
      `-DCMAKE_MODULE_PATH=${compatibilityRoot};${commonRoot}`,
      `-DPREINIT_ROUTINE_PATH=${preinitRoot}`
    ], { encoding: 'utf8' });
    if (cmake.error && cmake.error.code === 'ENOENT') {
      process.stdout.write('CMake compatibility smoke test skipped: cmake not found.\n');
    } else {
      assert.strictEqual(cmake.status, 0, `${cmake.stdout}\n${cmake.stderr}`);
    }
  } finally {
    fs.rmSync(infraRoot, { recursive: true, force: true });
  }
  assert.strictEqual(catalog.resolveDirect({ kind: 'infrastructure', name: 'unit_test_lib', version: 'general_packages_assets' }).downloadUrl,
    'https://github.com/MikroElektronika/general_packages/releases/download/general_packages_assets/unit_test_lib.7z');
  assert.strictEqual(catalog.resolveDirect({ kind: 'infrastructure', name: 'preinit', version: 'general_packages_assets' }).downloadUrl,
    'https://github.com/MikroElektronika/general_packages/releases/download/general_packages_assets/preinit.7z');
  assert.strictEqual(catalog.resolveDirect({ kind: 'infrastructure', name: 'mikroe_utils_common', version: 'general_packages_assets' }).downloadUrl,
    'https://github.com/MikroElektronika/general_packages/releases/download/general_packages_assets/mikroe_utils_common.7z');
  assert.strictEqual(catalog.resolveDirect({ kind: 'database', name: 'C_database', version: 'live' }).downloadUrl,
    'https://github.com/MikroElektronika/general_packages/releases/download/general_packages_assets/database_live.7z');
  assert.throws(() => catalog.resolveDirect({ kind: 'sdk', name: 'mikrosdk', version: 'latest' }), /latest release must be resolved/);
  assert.strictEqual(catalog.resolveDirect({ kind: 'sdk', name: 'mikrosdk', version: 'latest', downloadUrl: 'https://example/mikrosdk.7z' }).downloadUrl,
    'https://example/mikrosdk.7z');

  assert.strictEqual(catalog.resolveDirect({ kind: 'programmer-pack', name: 'codegrip_pack_ra6m4af', version: '1.0.2', downloadUrl: 'https://example/RA6M4AF.7z' }).downloadUrl,
    'https://example/RA6M4AF.7z');

  assert.strictEqual(database.corePackageName('{"gcc_arm_none_eabi":"arm_gcc_clang_stm32f4hs"}', 'gcc_arm_none_eabi'), 'arm_gcc_clang_stm32f4hs');
  assert.deepStrictEqual(database.supportPackageNames('["codegrip_pack_stm32f4"]'), ['codegrip_pack_stm32f4']);

  const response = {
    hits: { hits: [
      { _source: { name: 'mikrosdk', version: '2.18.3', download_link: 'https://example/2183.7z' } },
      { _source: { name: 'mikrosdk', version: '2.19.1', download_link: 'https://example/2191.7z' } }
    ] }
  };
  assert.strictEqual(catalog.selectCatalogSource(response, '2.19.1').download_link, 'https://example/2191.7z');
  assert.strictEqual(packageManager.archiveNameFromUrl('https://example/releases/core.7z', { name: 'core' }), 'core.7z');
  assert.strictEqual(packageManager.safeName('../unsafe package'), '..-unsafe-package');
  assert.strictEqual(codegrip.responseStatusIsSuccess(0), true);
  assert.strictEqual(codegrip.responseStatusIsSuccess('1'), false);

  const cSetupSource = fs.readFileSync(path.join(__dirname, '..', 'c_setup.js'), 'utf8');
  const cDatabaseSource = fs.readFileSync(path.join(__dirname, '..', 'c_database.js'), 'utf8');
  const cMcuUiSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'c_mcu.js'), 'utf8');
  const cPackageManagerSource = fs.readFileSync(path.join(__dirname, '..', 'c_package_manager.js'), 'utf8');
  assert.ok(cSetupSource.includes('codegripCatalog.resolveDevice(setupMcuName(setup), token)'));
  assert.ok(cSetupSource.includes('mcu: setupMcuName(setup)'));
  assert.ok(cSetupSource.includes('defines.push(`#define ${mcuName}`)'));
  assert.ok(!cSetupSource.includes('codegripCatalog.resolveDevice(setup.metadata.device.uid, token)'));
  assert.ok(cDatabaseSource.includes('sdkConfig.MCU_NAME = mcuName'));
  assert.ok(cDatabaseSource.includes("sdkConfig._MSDK_MCU_CARD_NAME_ = deviceConfig._MSDK_MCU_CARD_NAME_"));
  assert.ok(cMcuUiSource.includes("appendCell(row, mcu.mcuName || mcu.uid, 'mcuNameCell')"));
  assert.ok(cMcuUiSource.includes("device.mcuName || device.uid"));
  assert.ok(cPackageManagerSource.includes("return openEnvironmentPackages(context, kind)"));
  assert.ok(cPackageManagerSource.includes("environmentViewKind"));
  assert.ok(cPackageManagerSource.includes("Package files are still present after uninstall"));

  const rustConfiguratorSource = fs.readFileSync(path.join(__dirname, '..', 'mcu_configurator.js'), 'utf8');
  const rustMcuUiSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'mcu.js'), 'utf8');
  const setupCssSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'setups.css'), 'utf8');
  const mcuCssSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'mcu.css'), 'utf8');
  assert.ok(!rustConfiguratorSource.includes('Find and select a USB CODEGRIP connection before building this configuration.'));
  assert.ok(rustConfiguratorSource.includes('No CODEGRIP USB device is stored in this setup; searching now...'));
  assert.ok(rustConfiguratorSource.includes('discoverUsbCodegrips({'));
  assert.ok(rustConfiguratorSource.includes('persistCodegripConnection(context, setup, normalized)'));
  assert.ok(!rustMcuUiSource.includes('(codegripSelected && !state.codegripConnection)'));
  assert.ok(rustMcuUiSource.includes('USB discovery is optional. The CODEGRIP device will be searched when Flash, Debug or Erase is used.'));
  assert.ok(setupCssSource.includes('flex-flow: row nowrap'));
  assert.ok(mcuCssSource.includes('flex-wrap: nowrap'));

  process.stdout.write('C support tests passed.\n');
} finally {
  Module._load = originalLoad;
}
