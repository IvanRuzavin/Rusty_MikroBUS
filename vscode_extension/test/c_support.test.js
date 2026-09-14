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
  const rustCorePackages = require('../rust_core_packages')._test;
  const rustBoardPackages = require('../rust_board_packages')._test;
  const rustCardPackages = require('../rust_card_packages')._test;
  const cConfigurator = require('../c_configurator')._test;
  const rfp = require('../c_rfp_backend')._test;
  const cmakeVisibility = require('../c_cmake_visibility')._test;
  const microchip = require('../c_microchip_backend')._test;
  const tiXds110Module = require('../c_ti_xds110_backend');
  const tiXds110 = tiXds110Module._test;

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

  assert.strictEqual(rfp.defaultDeviceType({ device: { familyUid: 'RL78/G24', mcuName: 'R7F101GLG' } }), 'RL78');
  assert.strictEqual(rfp.defaultDeviceType({ device: { familyUid: 'RX26T', mcuName: 'R5F526TFCDFP' } }), 'RX200');
  assert.strictEqual(rfp.defaultDeviceType({ device: { familyUid: 'RA6M4', mcuName: 'R7FA6M4AF' } }), 'RA');
  const rl78Rfp = rfp.defaultProfile({ metadata: { device: { familyUid: 'RL78/G24', mcuName: 'R7F101GLG' } } });
  rl78Rfp.port = '/dev/ttyUSB0';
  assert.deepStrictEqual(rfp.programArgs(rl78Rfp, '/tmp/app.hex'), [
    '-d', 'RL78', '-port', '/dev/ttyUSB0', '-if', 'uart', '-dtr-inv', '-s', '115200', '-reset', '-a', '/tmp/app.hex'
  ]);
  const rl78E2Lite = {
    ...rl78Rfp,
    connection: 'tool',
    tool: 'e2l',
    interface: 'uart1',
    speed: undefined,
    dtrInv: false,
    reset: false,
    run: true
  };
  assert.deepStrictEqual(rfp.programArgs(rl78E2Lite, '/tmp/rl78.hex'), [
    '-d', 'RL78', '-t', 'e2l', '-if', 'uart1', '-run', '-a', '/tmp/rl78.hex'
  ]);
  // Profiles created by older extension versions incorrectly saved FINE for
  // RL78 + E2/E2 Lite. Runtime normalization must transparently correct them.
  assert.deepStrictEqual(rfp.connectionArgs({ ...rl78E2Lite, interface: 'fine' }), [
    '-d', 'RL78', '-t', 'e2l', '-if', 'uart1'
  ]);
  assert.strictEqual(rfp.effectiveToolInterface({ ...rl78E2Lite, interface: 'fine' }), 'uart1');
  assert.strictEqual(rfp.isRl78Device({ device: { familyUid: 'RL78/G24', mcuName: 'R7F101GLG' } }), true);
  assert.strictEqual(rfp.normalizeRl78DebugDevice('R7F101GLG'), 'R7F101GLG');
  const rl78TargetE2Lite = rfp.renesasRl78DebugTarget(
    { metadata: { device: { familyUid: 'RL78/G24', mcuName: 'R7F101GLG' } } },
    rl78E2Lite
  );
  assert.strictEqual(rl78TargetE2Lite.deviceFamily, 'RL78');
  assert.strictEqual(rl78TargetE2Lite.device, 'R7F101GLG');
  assert.strictEqual(rl78TargetE2Lite.debuggerType, 'E2LITE');
  assert.deepStrictEqual(rl78TargetE2Lite.disabledCores, ['FAA']);
  assert.strictEqual(rl78TargetE2Lite.serverParameters.includes('-uCore='), false);
  assert.deepStrictEqual(rl78TargetE2Lite.serverParameters.slice(-4), ['-uSyncMode=', 'async', '-uTraceCore=', 'CPU']);

  const rl78TargetE2 = rfp.renesasDebugTarget(
    { metadata: { device: { familyUid: 'RL78/G24', mcuName: 'R7F101GLG' } } },
    { ...rl78E2Lite, tool: 'e2', interface: 'fine' }
  );
  assert.strictEqual(rl78TargetE2.deviceFamily, 'RL78');
  assert.strictEqual(rl78TargetE2.device, 'R7F101GLG');
  assert.strictEqual(rl78TargetE2.debuggerType, 'E2');
  assert.deepStrictEqual(rl78TargetE2.disabledCores, ['FAA']);
  assert.strictEqual(rl78TargetE2.serverParameters.includes('-uCore='), false);

  const rxRfp = rfp.defaultProfile({ metadata: { device: { familyUid: 'RX26T', mcuName: 'R5F526TFCDFP' } } });
  assert.deepStrictEqual(rfp.programArgs(rxRfp, '/tmp/rx.hex'), [
    '-d', 'RX200', '-t', 'e2l', '-if', 'fine', '-run', '-a', '/tmp/rx.hex'
  ]);
  assert.strictEqual(rfp.isRxDevice({ device: { familyUid: 'RX26T', mcuName: 'R5F526TFCDFP' } }), true);
  assert.strictEqual(rfp.normalizeRxDebugDevice('R5F526TFCDFP'), 'R5F526TF');
  assert.strictEqual(rfp.renesasDebuggerType(rxRfp), 'E2LITE');
  assert.deepStrictEqual(
    rfp.renesasRxDebugTarget(
      { metadata: { device: { familyUid: 'RX26T', mcuName: 'R5F526TFCDFP' } } },
      rxRfp
    ),
    {
      deviceFamily: 'RX',
      device: 'R5F526TF',
      debuggerType: 'E2LITE',
      serverParameters: ['-uUseFine=', '1']
    }
  );
  assert.strictEqual(
    rfp.renesasRxDebugTarget(
      { metadata: { device: { familyUid: 'RX26T', mcuName: 'R5F526TFCDFP' } } },
      { ...rxRfp, connection: 'uart', interface: 'uart' }
    ),
    undefined
  );
  const rxDebugConfig = setup.renesasRfpDebugConfiguration(
    { name: 'RX26T test', metadata: { device: { familyUid: 'RX26T', mcuName: 'R5F526TFCDFP' } } },
    '/tmp/project',
    '/tmp/project/build/app.elf',
    rxRfp,
    'test-generation'
  );
  assert.strictEqual(rxDebugConfig.type, 'renesas-hardware');
  assert.strictEqual(rxDebugConfig.request, 'launch');
  assert.strictEqual(rxDebugConfig.program, '/tmp/project/build/app.elf');
  assert.strictEqual(rxDebugConfig.target.deviceFamily, 'RX');
  assert.strictEqual(rxDebugConfig.target.device, 'R5F526TF');
  assert.strictEqual(rxDebugConfig.target.debuggerType, 'E2LITE');
  assert.deepStrictEqual(rxDebugConfig.target.serverParameters, ['-uUseFine=', '1']);
  assert.strictEqual(
    setup.isSetupDebugAvailable({
      metadata: { programmer: { uid: 'renesas_rfp' }, device: { familyUid: 'RX26T', mcuName: 'R5F526TFCDFP' } },
      rfpProfile: rxRfp
    }),
    true
  );
  assert.strictEqual(
    setup.isSetupDebugAvailable({
      metadata: { programmer: { uid: 'renesas_rfp' }, device: { familyUid: 'RX26T', mcuName: 'R5F526TFCDFP' } },
      rfpProfile: { ...rxRfp, connection: 'uart', interface: 'uart' }
    }),
    false
  );
  assert.strictEqual(
    setup.isSetupDebugAvailable({
      metadata: { programmer: { uid: 'renesas_rfp' }, device: { familyUid: 'RL78/G24', mcuName: 'R7F101GLG' } }
    }),
    false
  );
  assert.strictEqual(
    setup.isSetupDebugAvailable({
      name: 'RL78 G24 E2 Lite',
      metadata: { programmer: { uid: 'renesas_rfp' }, device: { familyUid: 'RL78/G24', mcuName: 'R7F101GLG' } },
      rfpProfile: rl78E2Lite
    }),
    true
  );
  assert.strictEqual(
    setup.isSetupDebugAvailable({
      name: 'RL78 G24 legacy E2 profile',
      metadata: { programmer: { uid: 'renesas_rfp' }, device: { familyUid: 'RL78/G24', mcuName: 'R7F101GLG' } },
      rfpProfile: { ...rl78E2Lite, interface: 'fine' }
    }),
    true
  );
  const rl78DebugConfig = setup.renesasRfpDebugConfiguration(
    { name: 'RL78/G24 test', metadata: { device: { familyUid: 'RL78/G24', mcuName: 'R7F101GLG' } } },
    '/tmp/rl78-project',
    '/tmp/rl78-project/build/app.elf',
    rl78E2Lite,
    'rl78-test-generation'
  );
  assert.strictEqual(rl78DebugConfig.type, 'renesas-hardware');
  assert.strictEqual(rl78DebugConfig.request, 'launch');
  assert.strictEqual(rl78DebugConfig.program, '/tmp/rl78-project/build/app.elf');
  assert.strictEqual(rl78DebugConfig.target.deviceFamily, 'RL78');
  assert.strictEqual(rl78DebugConfig.target.device, 'R7F101GLG');
  assert.strictEqual(rl78DebugConfig.target.debuggerType, 'E2LITE');
  assert.deepStrictEqual(rl78DebugConfig.target.disabledCores, ['FAA']);
  assert.deepStrictEqual(rl78DebugConfig.target.serverParameters, [
    '-w', '0',
    '-uSelfCodeSet=', '0',
    '-upermitFlash=', '1',
    '-uuseWideVoltageMode=', '1',
    '-ueraseRom=', '1',
    '-ubankSwapEnable=', '0',
    '-uresetOnReload=', '1',
    '-ustopTimerEmu=', '0',
    '-ustopSerialEmu=', '0',
    '-umaskInternalResetSignal=', '0',
    '-umaskTargetResetSignal=', '0',
    '-n', '0',
    '-uverifyOnWritingMemory=', '1',
    '-uAllowRRMDMM=', '0',
    '-uOSRestriction=', '0',
    '-uRelayBreak=', '1',
    '-uSyncMode=', 'async',
    '-uTraceCore=', 'CPU'
  ]);
  assert.strictEqual(rl78DebugConfig.target.serverParameters.includes('-uCore='), false);
  assert.strictEqual(setup.isRl78G24Setup({ metadata: { device: { familyUid: 'RL78/G24', mcuName: 'R7F101GLG' } } }), true);
  assert.strictEqual(setup.isRl78G24Setup({ metadata: { device: { familyUid: 'RL78/G23', mcuName: 'R7F100ABC' } } }), false);
  const directRl78Args = setup.rl78G24ServerArgs(rl78DebugConfig.target, 61234);
  assert.deepStrictEqual(directRl78Args.slice(0, 8), ['-p', '61234', '-g', 'E2LITE', '-t', 'R7F101GLG', '-uConnectionTimeout=', '30']);
  assert.strictEqual(directRl78Args.includes('CPU|enabled|256|main'), true);
  assert.strictEqual(directRl78Args.includes('SINGLE_CORE|enabled|1|main'), false);
  const directRl78Config = setup.renesasRl78DirectCppDebugConfiguration(
    { name: 'RL78/G24 direct', metadata: { device: { familyUid: 'RL78/G24', mcuName: 'R7F101GLG' } } },
    '/tmp/rl78-project',
    '/tmp/rl78-project/build/app.elf',
    rl78E2Lite,
    'rl78-direct-generation',
    { server: '/tmp/e2-server-gdb', gdb: '/tmp/rl78-elf-gdb' },
    61234
  );
  assert.strictEqual(directRl78Config.type, 'cppdbg');
  assert.strictEqual(directRl78Config.miDebuggerPath, '/tmp/rl78-elf-gdb');
  assert.strictEqual(directRl78Config.debugServerPath, '/tmp/e2-server-gdb');
  assert.strictEqual(directRl78Config.miDebuggerServerAddress, '127.0.0.1:61234');
  assert.strictEqual(directRl78Config.debugServerArgs.includes('CPU|enabled|256|main'), true);
  assert.strictEqual(directRl78Config.debugServerArgs.includes('SINGLE_CORE'), false);
  assert.strictEqual(directRl78Config.__mikrobusRenesasRl78Direct, true);
  assert.strictEqual(
    setup.isSetupDebugAvailable({ metadata: { programmer: { uid: 'segger_jlink' } } }),
    true
  );

  const managedRfpSpec = packageManagerModule.rfpProgrammerPackageSpec();
  assert.strictEqual(managedRfpSpec.kind, 'programmer');
  assert.strictEqual(managedRfpSpec.name, 'renesas_rfp');
  assert.strictEqual(managedRfpSpec.manualInstall, 'rfp');
  assert.strictEqual(managedRfpSpec.installRelativePath, 'programmer/renesas_rfp/current');
  assert.strictEqual(Boolean(managedRfpSpec.external), false);
  const fakeRfpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-rfp-managed-'));
  try {
    const cli = path.join(fakeRfpRoot, process.platform === 'win32' ? 'rfp-cli.exe' : 'rfp-cli');
    fs.writeFileSync(cli, 'rfp');
    assert.strictEqual(packageManager.findRfpCliInRoot(fakeRfpRoot), cli);
  } finally {
    fs.rmSync(fakeRfpRoot, { recursive: true, force: true });
  }

  assert.strictEqual(rustMcu.normalizeJlinkDeviceName('R7FA6M4AF3CFB'), 'R7FA6M4AF');
  assert.strictEqual(rustMcu.normalizeJlinkDeviceName('STM32F412ZG'), 'STM32F412ZG');
  assert.strictEqual(rustMcu.isJlinkProgrammer({ programmerUid: 'SEGGER_JLINK', programmerName: 'SEGGER J-Link' }), true);
  assert.strictEqual(rustMcu.isJlinkProgrammer({ programmerUid: 'MIKROE_CODEGRIP', programmerName: 'CODEGRIP' }), false);
  assert.strictEqual(rustMcu.isCodegripProgrammer({ programmerUid: 'MIKROE_CODEGRIP' }), true);
  assert.strictEqual(rustMcu.isProbeRsProgrammer({ programmerUid: 'PROBE_RS' }), true);
  assert.strictEqual(rustMcu.isProbeRsProgrammer({ programmerName: 'probe-rs (Auto-detect)' }), true);
  {
    const reports = [];
    const reporter = rustMcu.probeRsProgressReporter({ report: (value) => reports.push(value) }, 'Programming');
    rustMcu.updateProbeRsProgressFromOutput('Erasing ✔ 100% [####################]\n', reporter, 'Programming');
    rustMcu.updateProbeRsProgressFromOutput('Programming ✔ 52% [##########----------]\n', reporter, 'Programming');
    rustMcu.updateProbeRsProgressFromOutput('Programming ✔ 100% [####################] Finished in 0.55s\n', reporter, 'Programming');
    reporter(100, 'Programming: 100%');
    assert.ok(reports.some((item) => /Erasing: 100%/.test(item.message || '')));
    assert.ok(reports.some((item) => /Programming: 52%/.test(item.message || '')));
    assert.ok(reports.some((item) => item.message === 'Programming: 100%'));
    assert.ok(reports.some((item) => Number(item.increment) > 0));
  }
  const probeRsGdbConfig = rustMcu.probeRsGdbCppDebugConfiguration(
    { mcuName: 'STM32F756ZG' },
    { sdkRoot: '/tmp/rust-sdk' },
    '/tmp/project/main.rs',
    '/tmp/rust-sdk/target/thumbv7em-none-eabi/debug/app',
    '/tmp/gcc/bin/arm-none-eabi-gdb',
    1337,
    'probe-token'
  );
  assert.strictEqual(probeRsGdbConfig.type, 'cppdbg');
  assert.strictEqual(probeRsGdbConfig.miDebuggerServerAddress, '127.0.0.1:1337');
  assert.strictEqual(probeRsGdbConfig.launchCompleteCommand, 'exec-continue');
  assert.strictEqual(probeRsGdbConfig.targetArchitecture, 'arm');
  assert.strictEqual(probeRsGdbConfig.useExtendedRemote, false);
  assert.ok(probeRsGdbConfig.setupCommands.some((item) => item.text === '-gdb-set scheduler-locking off'));
  assert.ok(probeRsGdbConfig.setupCommands.some((item) => item.text === '-gdb-set schedule-multiple off'));
  assert.strictEqual(probeRsGdbConfig.__mikrobusProbeRsGdb, true);
  assert.deepStrictEqual(rustMcu.parseProbeRsSemver('probe-rs 0.32.0'), [0, 32, 0]);
  assert.deepStrictEqual(rustMcu.parseProbeRsSemver('probe-rs v1.2.3'), [1, 2, 3]);
  assert.strictEqual(rustMcu.semverAtLeast([0, 32, 0], [0, 32, 0]), true);
  assert.strictEqual(rustMcu.semverAtLeast([0, 31, 0], [0, 32, 0]), false);

  {
    const reports = [];
    const reporter = rustMcu.jlinkProgressReporter({ report: (value) => reports.push(value) }, 'Programming');
    rustMcu.updateJlinkProgressFromOutput('Connecting to target via SWD...\nCortex-M7 identified\n', reporter, 'Programming');
    rustMcu.updateJlinkProgressFromOutput('Downloading file... 50 %\n', reporter, 'Programming');
    rustMcu.updateJlinkProgressFromOutput('O.K.\n', reporter, 'Programming');
    reporter(100, 'Programming: 100%');
    assert.ok(reports.some((item) => /Connected to J-Link target/.test(item.message || '')));
    assert.ok(reports.some((item) => /50% flash write/.test(item.message || '')));
    assert.ok(reports.some((item) => item.message === 'Programming: 100%'));
    assert.ok(reports.some((item) => Number(item.increment) > 0));
  }
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
      assert.strictEqual(rustMcu.shouldUseNativeJlink({ programmerUid: 'SEGGER_JLINK' }, []), true);
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
      INSERT INTO Devices VALUES ('DSPIC33EP512MU814','dsPIC33EP512MU814','{"MCU_NAME":"dsPIC33EP512MU814"}','{"mikrocdspic":"dspic_mikroc_dspic33e"}',1);
      INSERT INTO Devices VALUES ('SIBRAIN_FOR_DSPIC33EP512MU814','SIBRAIN for dsPIC','{"MCU_NAME":"dsPIC33EP512MU814","_MSDK_MCU_CARD_NAME_":"SIBRAIN_FOR_DSPIC33EP512MU814"}','{"package":"sibrain_for_dspic33ep512mu814"}',1);
      INSERT INTO Compilers VALUES ('gcc_arm_none_eabi','GCC for ARM','14.2','GNU','C','gcc/arm','{}','bin/arm-none-eabi-gcc','bin/arm-none-eabi-g++','bin/arm-none-eabi-gdb','bin/arm-none-eabi-as','','ARM/gcc_clang','gcc_arm_compiler','');
      INSERT INTO Compilers VALUES ('clang-llvm','Clang for ARM','18.0','LLVM','C, C++','clang','{}','bin/clang','bin/clang','bin/lldb-mi','bin/llvm-as','','ARM/gcc_clang','llvm_clang_compiler','');
      INSERT INTO Compilers VALUES ('mikrocarm','mikroC AI for ARM','3.0','MIKROE','mikroC','mikroc/arm','{}','mikroCARM','','','','','ARM/mikroC','mikroc_arm','');
      INSERT INTO Compilers VALUES ('mikrocdspic','mikroC AI for dsPIC','7.0','MIKROE','mikroC','mikroc/dspic','{}','mikroCdsPIC','','','','','dsPIC/mikroC','mikroc_dspic','');
      INSERT INTO CompilerToBuildSystem VALUES ('gcc_arm_none_eabi','cmake');
      INSERT INTO CompilerToBuildSystem VALUES ('clang-llvm','cmake');
      INSERT INTO CompilerToBuildSystem VALUES ('mikrocarm','cmake');
      INSERT INTO CompilerToBuildSystem VALUES ('mikrocdspic','cmake');
      INSERT INTO CompilerToDevice VALUES ('MCU_CARD_FOR_STM32_STM32F756ZG','gcc_arm_none_eabi');
      INSERT INTO CompilerToDevice VALUES ('MCU_CARD_FOR_STM32_STM32F756ZG','clang-llvm');
      INSERT INTO CompilerToDevice VALUES ('MCU_CARD_FOR_STM32_STM32F756ZG','mikrocarm');
      INSERT INTO CompilerToDevice VALUES ('SIBRAIN_FOR_DSPIC33EP512MU814','mikrocdspic');
      INSERT INTO SDKs VALUES ('mikrosdk','mikroSDK','2.0');
      INSERT INTO Programmers VALUES ('codegrip','CODEGRIP','codegrip_gdb_server');
      INSERT INTO ProgrammerToDevice VALUES ('codegrip','MCU_CARD_FOR_STM32_STM32F756ZG','');
    `);
    db.close();
    const context = { globalStorageUri: { fsPath: compilerDbRoot } };
    const mapped = databaseModule.listCompilers(context, 'MCU_CARD_FOR_STM32_STM32F756ZG', compilerSupport.supportedCompilerUids());
    assert.deepStrictEqual(mapped.map((item) => item.uid).sort(), ['clang-llvm', 'gcc_arm_none_eabi']);
    assert.ok(mapped.every((item) => item.corePackageName === 'arm_gcc_clang_stm32f7x'));

    const dsPicMapped = databaseModule.listCompilers(context, 'SIBRAIN_FOR_DSPIC33EP512MU814', compilerSupport.supportedCompilerUids());
    assert.deepStrictEqual(dsPicMapped.map((item) => item.uid), ['mikrocdspic']);
    assert.strictEqual(dsPicMapped[0].corePackageName, 'dspic_mikroc_dspic33e');

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

  // sdk_support=0 remains bare-metal-first, but a valid SDK mapping can use
  // an unambiguous GENERIC_* BoardToDevice relation for full-SDK builds.
  const genericBoardDbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-generic-board-db-'));
  try {
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = path.join(genericBoardDbRoot, 'generic.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE Boards(uid TEXT PRIMARY KEY, name TEXT, vendor TEXT, category TEXT, default_device TEXT, soldered_device TEXT, mikrobus_count INTEGER, sdk_config TEXT, installer_package TEXT);
      CREATE TABLE BoardToDevice(board_uid TEXT, device_uid TEXT);
      INSERT INTO Boards VALUES ('GENERIC_RL78_BOARD','Generic RL78 Board','Renesas','Development Systems','','',0,'{"_MSDK_BOARD_NAME_":"GENERIC_RL78_BOARD"}',NULL);
      INSERT INTO BoardToDevice VALUES ('GENERIC_RL78_BOARD','R7F101GLG');
    `);
    const inferred = databaseModule._test.preferredGenericBoardForDb(db, 'R7F101GLG');
    assert.strictEqual(inferred.uid, 'GENERIC_RL78_BOARD');
    assert.strictEqual(inferred.sdkConfig._MSDK_BOARD_NAME_, 'GENERIC_RL78_BOARD');
    db.close();
  } finally {
    fs.rmSync(genericBoardDbRoot, { recursive: true, force: true });
  }

  // Cardless SDK boards are materialized through the normal board discovery
  // hook so stock bsp/board/CMakeLists.txt never evaluates an undefined
  // _MSDK_MCU_CARD_NAME_.
  const syntheticBoardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-cardless-board-'));
  try {
    const sdkSource = path.join(syntheticBoardRoot, 'sdk');
    fs.mkdirSync(path.join(sdkSource, 'bsp', 'board', 'include', 'boards'), { recursive: true });
    const synthetic = setup.materializeSyntheticCardlessBoard(sdkSource, {
      mode: 'full-sdk',
      metadata: {
        board: { uid: 'GENERIC_RL78_BOARD', name: 'Generic RL78 Board' },
        sdkConfig: { _MSDK_BOARD_NAME_: 'GENERIC_RL78_BOARD' },
        packageRequirements: {}
      }
    });
    assert.strictEqual(synthetic.folderName, 'board_generic_rl78_board');
    const boardCmake = fs.readFileSync(path.join(synthetic.boardRoot, 'board.cmake'), 'utf8');
    const boardHeader = fs.readFileSync(path.join(synthetic.boardRoot, 'board.h'), 'utf8');
    assert.ok(boardCmake.includes('set(MCU_CARD FALSE)'));
    assert.ok(boardCmake.includes('set(DIP_SOCKET FALSE)'));
    assert.ok(boardCmake.includes('set(MSDK_FILTERED_DIP_SOCKET_TYPE "none")'));
    assert.ok(boardCmake.includes('GENERIC_RL78_BOARD'));
    assert.ok(boardHeader.includes('Generic RL78 Board'));
  } finally {
    fs.rmSync(syntheticBoardRoot, { recursive: true, force: true });
  }

  // Explorer dimming is based on CMake's configured codemodel rather than
  // source-tree heuristics. Nested CMake inputs and selected target sources are
  // active; sibling source/header files that are not in the configuration dim.
  const visibilityRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-cmake-visibility-'));
  try {
    const build = path.join(visibilityRoot, '.mikrobus', 'c-build');
    const reply = path.join(build, '.cmake', 'api', 'v1', 'reply');
    fs.mkdirSync(path.join(visibilityRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(visibilityRoot, 'cmake'), { recursive: true });
    fs.mkdirSync(reply, { recursive: true });
    fs.writeFileSync(path.join(visibilityRoot, 'CMakeLists.txt'), 'project(mikrobus_visibility LANGUAGES C)\ninclude(cmake/selected.cmake)\nadd_subdirectory(tests/i2c)\n');
    fs.writeFileSync(path.join(visibilityRoot, 'cmake', 'selected.cmake'), '# selected\n');
    fs.writeFileSync(path.join(visibilityRoot, 'cmake', 'unused.cmake'), '# unused\n');
    fs.mkdirSync(path.join(visibilityRoot, 'tests', 'i2c'), { recursive: true });
    fs.writeFileSync(path.join(visibilityRoot, 'tests', 'i2c', 'CMakeLists.txt'), 'add_executable(test_default_i2c main.c)\n');
    fs.writeFileSync(path.join(visibilityRoot, 'tests', 'i2c', 'main.c'), 'int main(void){return 0;}\n');
    // A stale binding created by pre-0.7.12 nearest-CMake detection must not
    // turn this add_executable-only leaf into a standalone project root.
    fs.mkdirSync(path.join(visibilityRoot, 'tests', 'i2c', '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(visibilityRoot, 'tests', 'i2c', '.vscode', 'mikrobus-c.json'), '{}\n');
    fs.writeFileSync(path.join(visibilityRoot, 'src', 'unused.c'), 'void unused(void){}\n');
    fs.writeFileSync(path.join(visibilityRoot, 'src', 'unused.h'), '#pragma once\n');
    fs.writeFileSync(path.join(reply, 'cmakeFiles-v1.json'), JSON.stringify({ inputs: [
      { path: 'CMakeLists.txt', isGenerated: false },
      { path: 'cmake/selected.cmake', isGenerated: false },
      { path: 'tests/i2c/CMakeLists.txt', isGenerated: false }
    ] }));
    fs.mkdirSync(path.join(build, 'tests', 'i2c'), { recursive: true });
    fs.writeFileSync(path.join(build, 'tests', 'i2c', 'test_default_i2c'), 'elf');
    fs.writeFileSync(path.join(reply, 'target-app.json'), JSON.stringify({
      name: 'test_default_i2c', id: 'test_default_i2c::@test', type: 'EXECUTABLE',
      sources: [{ path: 'tests/i2c/main.c' }],
      artifacts: [{ path: 'tests/i2c/test_default_i2c' }]
    }));
    fs.writeFileSync(path.join(reply, 'codemodel-v2.json'), JSON.stringify({
      paths: { source: visibilityRoot, build },
      configurations: [{ targets: [{ name: 'test_default_i2c', id: 'test_default_i2c::@test', jsonFile: 'target-app.json' }] }]
    }));
    fs.writeFileSync(path.join(reply, 'index-test.json'), JSON.stringify({ objects: [
      { kind: 'cmakeFiles', jsonFile: 'cmakeFiles-v1.json' },
      { kind: 'codemodel', jsonFile: 'codemodel-v2.json' }
    ] }));
    fs.writeFileSync(path.join(build, 'compile_commands.json'), JSON.stringify([{ file: path.join(visibilityRoot, 'tests', 'i2c', 'main.c') }]));
    const snapshot = cmakeVisibility.snapshotFromBuild(visibilityRoot, build, undefined);
    const norm = cmakeVisibility.normalizePath;
    assert.ok(snapshot.activeFiles.has(norm(path.join(visibilityRoot, 'CMakeLists.txt'))));
    assert.ok(snapshot.activeFiles.has(norm(path.join(visibilityRoot, 'cmake', 'selected.cmake'))));
    assert.ok(snapshot.activeFiles.has(norm(path.join(visibilityRoot, 'tests', 'i2c', 'main.c'))));
    assert.ok(snapshot.inactiveFiles.has(norm(path.join(visibilityRoot, 'src', 'unused.c'))));
    // Headers are left undecorated until the first compile populates Ninja's
    // dependency database, avoiding false negatives for transitive #includes.
    assert.strictEqual(snapshot.inactiveFiles.has(norm(path.join(visibilityRoot, 'src', 'unused.h'))), false);
    assert.ok(snapshot.inactiveFiles.has(norm(path.join(visibilityRoot, 'cmake', 'unused.cmake'))));

    const activeSource = path.join(visibilityRoot, 'tests', 'i2c', 'main.c');
    assert.strictEqual(setup.findCmakeProjectRoot(activeSource, visibilityRoot), visibilityRoot);
    const owners = cmakeVisibility.targetsForSource(visibilityRoot, build, activeSource);
    assert.strictEqual(owners.length, 1);
    assert.strictEqual(owners[0].name, 'test_default_i2c');
    assert.strictEqual(owners[0].type, 'EXECUTABLE');
    assert.strictEqual(
      cmakeVisibility.executableArtifactForTarget(visibilityRoot, build, 'test_default_i2c'),
      path.join(build, 'tests', 'i2c', 'test_default_i2c')
    );

    // A mikroSDK source checkout must not expose the already-installed SDK
    // packages from the setup prefix, otherwise source targets can collide with
    // imported MikroSDK.* targets. Only MikroC.Core is taken from the setup.
    fs.mkdirSync(path.join(visibilityRoot, 'drv'), { recursive: true });
    fs.mkdirSync(path.join(visibilityRoot, 'bsp'), { recursive: true });
    fs.writeFileSync(path.join(visibilityRoot, 'CMakeLists.txt'), [
      'project(MikroSDK LANGUAGES C)',
      'find_package(MikroC.Core)',
      'add_subdirectory(bsp)',
      'add_subdirectory(drv)',
      ''
    ].join('\n'));
    const installPrefix = path.join(visibilityRoot, 'setup-install');
    const coreConfigDir = path.join(installPrefix, 'lib', 'cmake', 'MikroC.Core');
    fs.mkdirSync(coreConfigDir, { recursive: true });
    fs.writeFileSync(path.join(coreConfigDir, 'MikroC.CoreConfig.cmake'), '# core config\n');
    assert.strictEqual(setup.isMikroSdkSourceProject(visibilityRoot), true);
    assert.deepStrictEqual(setup.workspacePrefixArguments(visibilityRoot, { paths: { installPrefix } }), [
      '-DMIKROBUS_WORKSPACE_PREFIX_PATH=',
      `-DMikroC.Core_DIR=${coreConfigDir}`
    ]);

    const sourceTreeArgs = setup.workspaceSourceTreeDefinitionArguments({ mode: 'full-sdk', applicationOutput: 'debug-terminal' });
    assert.deepStrictEqual(
      setup.sdkPreProjectCmakeVariables({ adapter: compilerSupport.adapterFor('mikrocpic32') }),
      { TOOLCHAIN_LANGUAGE: 'MikroC' }
    );
    assert.deepStrictEqual(
      setup.sdkPreProjectCmakeVariables({ adapter: compilerSupport.adapterFor('gcc_arm_none_eabi') }),
      { TOOLCHAIN_LANGUAGE: 'GNU' }
    );
    assert.deepStrictEqual(
      setup.workspacePreProjectCmakeArguments({ metadata: { compiler: { uid: 'mikrocpic32' } } }),
      ['-DTOOLCHAIN_LANGUAGE=MikroC']
    );
    assert.deepStrictEqual(
      setup.workspacePreProjectCmakeArguments({ metadata: { compiler: { uid: 'gcc_arm_none_eabi' } } }),
      ['-DTOOLCHAIN_LANGUAGE=GNU']
    );
    assert.ok(sourceTreeArgs.includes('-DLOG_INTERFACE=LOG_INTERFACE_STDOUT'));
    assert.ok(sourceTreeArgs.includes('-DIS_BARE_METAL=FALSE'));
    assert.ok(sourceTreeArgs.includes('-DMSDK_BUILD_TFT_MODULES=FALSE'));
    assert.ok(sourceTreeArgs.includes('-DBUILD_LVGL_FROM_NECTO=FALSE'));

    // Workspace/source-tree configuration must never fall back to /usr/local.
    // mikroSDK install_headers() runs configure_file() during configure, so the
    // private install prefix needs the expected destination directories before
    // CMake evaluates the source graph.
    fs.mkdirSync(path.join(installPrefix, 'include', 'drv'), { recursive: true });
    fs.mkdirSync(path.join(visibilityRoot, 'platform', 'sample'), { recursive: true });
    fs.writeFileSync(path.join(visibilityRoot, 'platform', 'sample', 'CMakeLists.txt'),
      'install_headers(${CMAKE_INSTALL_PREFIX}/include/platform MikroSDK.Sample sample.h)\n');
    const workspaceInstall = setup.prepareWorkspaceInstallPrefix(visibilityRoot, { paths: { installPrefix } });
    assert.strictEqual(workspaceInstall, path.join(visibilityRoot, '.mikrobus', 'c-install'));
    assert.ok(fs.existsSync(path.join(workspaceInstall, 'include', 'drv')));
    assert.ok(fs.existsSync(path.join(workspaceInstall, 'include', 'platform')));

    const configureSmoke = path.join(visibilityRoot, 'prefix-smoke');
    fs.mkdirSync(configureSmoke, { recursive: true });
    fs.writeFileSync(path.join(configureSmoke, 'template.in'), '@VALUE@\n');
    fs.writeFileSync(path.join(configureSmoke, 'CMakeLists.txt'), [
      'cmake_minimum_required(VERSION 3.20)',
      'project(prefix_smoke LANGUAGES NONE)',
      'set(VALUE ok)',
      'configure_file(${CMAKE_CURRENT_SOURCE_DIR}/template.in ${CMAKE_INSTALL_PREFIX}/include/platform/generated.tmp)',
      ''
    ].join('\n'));
    const smokeBuild = path.join(configureSmoke, 'build');
    const smoke = childProcess.spawnSync('cmake', ['-S', configureSmoke, '-B', smokeBuild, `-DCMAKE_INSTALL_PREFIX=${workspaceInstall}`], { encoding: 'utf8' });
    assert.strictEqual(smoke.status, 0, `${smoke.stdout}\n${smoke.stderr}`);
    assert.ok(fs.existsSync(path.join(workspaceInstall, 'include', 'platform', 'generated.tmp')));
  } finally {
    fs.rmSync(visibilityRoot, { recursive: true, force: true });
  }

  // RFP is synthesized for Renesas devices even when ProgrammerToDevice and
  // CompilerToProgrammer contain no RFP row at all.
  const rfpDbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-rfp-db-'));
  try {
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = path.join(rfpDbRoot, 'c-runtime', 'packages', 'database', 'C_database', 'live', 'necto_db.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE Devices(uid TEXT PRIMARY KEY, vendor TEXT, family_uid TEXT);
      CREATE TABLE Programmers(uid TEXT PRIMARY KEY, name TEXT, description TEXT, installer_package TEXT, hidden INTEGER);
      CREATE TABLE ProgrammerToDevice(programer_uid TEXT, device_uid TEXT, device_support_package TEXT);
      CREATE TABLE CompilerToProgrammer(programmer_uid TEXT, compiler_uid TEXT);
      INSERT INTO Devices VALUES ('R5F526TFCDFP','Renesas Electronics','RX26T');
      INSERT INTO Devices VALUES ('STM32F756ZG','STMicroelectronics','STM32');
    `);
    db.close();
    const context = { globalStorageUri: { fsPath: rfpDbRoot } };
    const renesasProgrammers = databaseModule.listProgrammers(context, 'R5F526TFCDFP', 'rx-elf-gcc');
    assert.ok(renesasProgrammers.some((item) => item.uid === 'renesas_rfp'));
    const stmProgrammers = databaseModule.listProgrammers(context, 'STM32F756ZG', 'gcc_arm_none_eabi');
    assert.strictEqual(stmProgrammers.some((item) => item.uid === 'renesas_rfp'), false);
  } finally {
    fs.rmSync(rfpDbRoot, { recursive: true, force: true });
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

  const xc32CodegripDebugConfig = setup.codegripCppDebugConfiguration({
    name: 'PIC32MZ CODEGRIP',
    tools: { gdb: '/toolchain/bin/pic32-gdb' },
    metadata: { compiler: { uid: 'mchp_xc32' }, device: { uid: 'PIC32MZ2048EFH144' } }
  }, '/project', '/project/.mikrobus/c-build/app', 24567, 'xc32-generation-test');
  assert.strictEqual(xc32CodegripDebugConfig.miDebuggerPath, '/toolchain/bin/pic32-gdb');
  assert.strictEqual(xc32CodegripDebugConfig.miDebuggerArgs, undefined);
  assert.strictEqual(xc32CodegripDebugConfig.setupCommands.some((item) => /architecture|endian/i.test(item.text)), false);
  assert.ok(xc32CodegripDebugConfig.setupCommands.some((item) => item.text === '-gdb-set mem inaccessible-by-default off'));
  const xc32ArchitectureConfig = setup.codegripCppDebugConfiguration({
    name: 'PIC32MZ CODEGRIP probed architecture',
    tools: { gdb: '/toolchain/bin/pic32-gdb' },
    metadata: { compiler: { uid: 'mchp_xc32' }, device: { uid: 'PIC32MZ2048EFH144' } }
  }, '/project', '/project/.mikrobus/c-build/app', 24570, 'xc32-architecture-test', { gdbArchitecture: 'mips:isa32r2' });
  assert.ok(String(xc32ArchitectureConfig.miDebuggerArgs || '').includes('set architecture mips:isa32r2'));
  assert.strictEqual(xc32ArchitectureConfig.setupCommands.some((item) => /architecture/i.test(item.text)), false);

  const xc16CodegripDebugConfig = setup.codegripCppDebugConfiguration({
    name: 'dsPIC CODEGRIP',
    tools: { gdb: '/toolchain/bin/pic16-gdb' },
    metadata: { compiler: { uid: 'mchp_xc16' }, device: { uid: 'dsPIC33EP512MU810' } }
  }, '/project', '/project/.mikrobus/c-build/app', 24568, 'xc16-generation-test');
  assert.strictEqual(xc16CodegripDebugConfig.miDebuggerPath, '/toolchain/bin/pic16-gdb');
  assert.strictEqual(xc16CodegripDebugConfig.miDebuggerArgs, undefined);

  const xc8CodegripDebugConfig = setup.codegripCppDebugConfiguration({
    name: 'PIC18 CODEGRIP',
    tools: { gdb: '/toolchain/bin/pic8-gdb' },
    metadata: { compiler: { uid: 'mchp_xc8' }, device: { uid: 'PIC18F47K42' } }
  }, '/project', '/project/.mikrobus/c-build/app', 24569, 'xc8-generation-test');
  assert.strictEqual(xc8CodegripDebugConfig.miDebuggerPath, '/toolchain/bin/pic8-gdb');
  assert.strictEqual(xc8CodegripDebugConfig.miDebuggerArgs, undefined);
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
      CREATE TABLE Programmer (UID TEXT PRIMARY KEY, NAME TEXT, VENDOR TEXT, KIND TEXT, TRANSPORT TEXT, CONFIG_JSON TEXT, ENABLED INTEGER);
      CREATE TABLE DeviceToProgrammer (DEVICE_NAME TEXT, PROGRAMMER_UID TEXT, INTERFACE TEXT, PRIORITY INTEGER, PRIMARY KEY (DEVICE_NAME, PROGRAMMER_UID));
      INSERT INTO Board VALUES ('UNI_DS_V8','UNI-DS v8','MikroElektronika','bsp/boards/uni_ds_v8/board.cfg','{"mcuSelection":"card","mikrobusSource":"board-card"}',1);
      INSERT INTO Family VALUES ('F4','STMicroelectronics','thumbv7em-none-eabihf');
      INSERT INTO Family VALUES ('F7','STMicroelectronics','thumbv7em-none-eabihf');
      INSERT INTO MCU VALUES ('STM32F407ZG','F4','system_stm32f_4xx');
      INSERT INTO MCU VALUES ('STM32F756ZG','F7','system_stm32f_7xx');
      INSERT INTO MCUCard VALUES ('MCU_CARD_FOR_STM32','MCU CARD for STM32','MikroElektronika','bsp/cards/mcu_card_for_stm32/card.cfg','{"hardwareDevices":["STM32F407ZG","STM32F756ZG"]}',1);
      INSERT INTO BoardToCard VALUES ('UNI_DS_V8','MCU_CARD_FOR_STM32',0,'{}');
      INSERT INTO CardToMCU VALUES ('MCU_CARD_FOR_STM32','STM32F407ZG',1,'{}');
      INSERT INTO CardToMCU VALUES ('MCU_CARD_FOR_STM32','STM32F756ZG',0,'{}');
      INSERT INTO Programmer VALUES ('SEGGER_JLINK','SEGGER J-Link','SEGGER','debug','SWD','{}',1);
      INSERT INTO Programmer VALUES ('MIKROE_CODEGRIP','MIKROE CODEGRIP','MikroElektronika','debug','SWD','{}',1);
      INSERT INTO DeviceToProgrammer VALUES ('STM32F756ZG','SEGGER_JLINK','SWD',10);
      INSERT INTO DeviceToProgrammer VALUES ('STM32F756ZG','MIKROE_CODEGRIP','SWD',20);
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
    const rustProgrammers = rustMcu.readProgrammersForDevice(rustBoardDb, 'STM32F756ZG');
    assert.strictEqual(rustProgrammers[0].uid, 'PROBE_RS');
    assert.strictEqual(rustProgrammers[0].universal, true);
    assert.strictEqual(rustProgrammers.some((item) => item.uid === 'SEGGER_JLINK'), true);
    assert.strictEqual(rustProgrammers.some((item) => item.uid === 'MIKROE_CODEGRIP'), true);
    const unknownMcuProgrammers = rustMcu.readProgrammersForDevice(rustBoardDb, 'NOT_IN_PROGRAMMER_DB');
    assert.deepStrictEqual(unknownMcuProgrammers.map((item) => item.uid), ['PROBE_RS']);
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
    assert.deepStrictEqual(compilerSupport.adapterFor('clang-llvm').executableNames.gdb, ['lldb-mi']);
    assert.strictEqual(setup.isPlainLldbExecutable('/toolchain/bin/lldb'), true);
    assert.strictEqual(setup.isPlainLldbExecutable('/toolchain/bin/lldb-mi'), false);
    if (process.platform === 'linux') {
      assert.strictEqual(compilerSupport.compilerAsset('gcc_riscv_compiler').url, 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/gcc/riscv/linux/riscv32-unknown-elf-gcc.7z');
      assert.strictEqual(compilerSupport.compilerAsset('microchip_xc8_compiler').url, 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/xc8/linux/xc8.7z');
      assert.strictEqual(compilerSupport.compilerAsset('microchip_xc16_compiler').url, 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/xc16/linux/xc16.7z');
      assert.strictEqual(compilerSupport.compilerAsset('microchip_xc32_compiler').url, 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/xc32/linux/xc32.7z');
      assert.strictEqual(compilerSupport.compilerAsset('llvm_clang_compiler').url, 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/clang/linux/clang.7z');
      assert.strictEqual(compilerSupport.compilerAsset('gcc_rx_compiler').url, 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/gcc/rx/linux/rx-elf-gcc.7z');
      assert.strictEqual(compilerSupport.compilerAsset('llvm_rl78_compiler').url, 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/llvm/rl78/linux/llvm-rl78-elf.7z');
      const linuxMikroCAssets = {
        mikroc_arm: 'arm', mikroc_pic: 'pic', mikroc_pic32: 'pic32', mikroc_dspic: 'dspic', mikroc_avr: 'avr'
      };
      for (const [name, family] of Object.entries(linuxMikroCAssets)) {
        const asset = compilerSupport.compilerAsset(name);
        assert.strictEqual(asset.url, `https://software-update.mikroe.com/NECTOStudio7/live/compilers/mikroc/${family}/linux/mikroc.7z`);
        assert.strictEqual(asset.payloadSubdir, undefined);
      }
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
      [`programmer:codegrip_gdb_server@${catalog.codegripVersionForPlatform(process.platform)}`, { root: serverRoot }],
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
  }), ['-Wno-incompatible-pointer-types']);

  // ARM compatibility diagnostics must come from the installed core package,
  // not from a duplicated table in the extension. Preserve an explicitly empty
  // core branch (M0+) and import the M7 warning suppressions used by Clang.
  const declaredArmCoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-arm-core-flags-'));
  try {
    const cmakeRoot = path.join(declaredArmCoreRoot, 'cmake');
    fs.mkdirSync(cmakeRoot, { recursive: true });
    fs.writeFileSync(path.join(cmakeRoot, 'coreUtils.cmake'), [
      'function(set_flags flags)',
      '    if (${CORE_NAME} STREQUAL "M0+")',
      '        set(${flags} -std=gnu99 -mcpu=cortex-m0plus -mthumb ${POINTER_TYPE_ERROR} PARENT_SCOPE)',
      '    elseif (${CORE_NAME} STREQUAL "M7")',
      '        set(M7_FPU_FLAG -mfpu=fpv5-d16)',
      '        if(${MCU_NAME} MATCHES "^STM32.+$")',
      '            if(NOT ${MCU_NAME} MATCHES "^STM32(F7[67]|H7[2-5]).+$")',
      '                set(M7_FPU_FLAG -mfpu=fpv5-sp-d16)',
      '            endif()',
      '        endif()',
      '        set(${flags} -std=gnu99 -mcpu=cortex-m7 -mthumb ${POINTER_TYPE_ERROR} -mfloat-abi=hard ${M7_FPU_FLAG} -ffunction-sections -fdata-sections -fno-common -fmessage-length=0 -Wno-int-conversion -Wno-incompatible-function-pointer-types PARENT_SCOPE)',
      '    endif()',
      'endfunction()',
      ''
    ].join('\n'), 'utf8');
    assert.deepStrictEqual(setup.coreDeclaredCompatibilityFlags(declaredArmCoreRoot, 'M7'), {
      found: true,
      flags: ['-Wno-int-conversion', '-Wno-incompatible-function-pointer-types']
    });
    assert.deepStrictEqual(setup.coreCompatibilityFlags('M7', { name: 'clang', version: '18.0.0' }, declaredArmCoreRoot), [
      '-Wno-int-conversion',
      '-Wno-incompatible-function-pointer-types'
    ]);
    assert.deepStrictEqual(setup.coreDeclaredCompatibilityFlags(declaredArmCoreRoot, 'M0+'), { found: true, flags: [] });
    assert.deepStrictEqual(setup.coreCompatibilityFlags('M0+', { name: 'clang', version: '18.0.0' }, declaredArmCoreRoot), []);
  } finally {
    fs.rmSync(declaredArmCoreRoot, { recursive: true, force: true });
  }
  assert.strictEqual(setup.normalizeApplicationOutput('UART'), 'uart');
  assert.strictEqual(setup.normalizeApplicationOutput('Debug Terminal'), 'debug-terminal');
  assert.strictEqual(setup.normalizeApplicationOutput('LOG_INTERFACE_STDOUT'), 'debug-terminal');
  assert.strictEqual(setup.applicationOutputCmakeValue('uart'), 'LOG_INTERFACE_UART');
  assert.strictEqual(setup.applicationOutputCmakeValue('debug-terminal'), 'LOG_INTERFACE_STDOUT');
  assert.strictEqual(setup.hexPathForExecutable('/tmp/example.elf'), path.join('/tmp', 'example.hex'));
  assert.strictEqual(setup.hexPathForExecutable('/tmp/example.hex'), '/tmp/example.hex');

  // XC8 PIC emits ELF and Intel HEX as peer outputs of the same link. The HEX
  // can have an earlier mtime than the ELF and must not fall through to objcopy.
  {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-xc8-hex-'));
    const elf = path.join(temp, 'blink.elf');
    const hex = path.join(temp, 'blink.hex');
    fs.writeFileSync(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]));
    fs.writeFileSync(hex, ':020000040000FA\n:00000001FF\n');
    const now = Date.now() / 1000;
    fs.utimesSync(hex, now - 1, now - 1);
    fs.utimesSync(elf, now, now);
    assert.strictEqual(setup.nativeXc8HexForElf(elf), hex);
    assert.strictEqual(setup.looksLikeIntelHex(hex), true);
  }

  // Microchip bin2hex utilities do not accept GNU objcopy syntax.
  {
    const xc16 = setup.microchipHexConversion('/opt/xc16/bin/xc16-bin2hex', 'xc16', '/tmp/app.elf', '/tmp/app.hex');
    assert.deepStrictEqual(xc16.args, ['/tmp/app.elf']);
    const xc32 = setup.microchipHexConversion('/opt/xc32/bin/xc32-bin2hex', 'xc32', '/tmp/app.elf', '/tmp/app.hex');
    assert.deepStrictEqual(xc32.args, ['/tmp/app.elf']);
    const xc32Objcopy = setup.microchipHexConversion('/opt/xc32/bin/xc32-objcopy', 'xc32', '/tmp/app.elf', '/tmp/app.hex');
    assert.deepStrictEqual(xc32Objcopy.args, ['-O', 'ihex', '/tmp/app.elf', '/tmp/app.hex']);
    assert.strictEqual(setup.microchipBin2hexNeedsElfAlias('xc32', '/opt/xc32/bin/xc32-bin2hex', '/tmp/app'), true);
    assert.strictEqual(setup.microchipBin2hexNeedsElfAlias('xc32', '/opt/xc32/bin/xc32-bin2hex', '/tmp/app.elf'), false);
    assert.strictEqual(setup.microchipBin2hexNeedsElfAlias('xc16', '/opt/xc16/bin/xc16-bin2hex', '/tmp/app.out'), true);
    assert.strictEqual(setup.microchipBin2hexNeedsElfAlias('xc32', '/opt/xc32/bin/xc32-objcopy', '/tmp/app'), false);
  }
  // Microchip XC definitions use symbolic config_words. They must remain
  // symbolic all the way to the XC compiler so #pragma config can encode the
  // device-specific DEVCFG/DEVCP bits without the extension guessing masks.
  {
    const xcDefinition = {
      config_words: [
        {
          init: 'OFF', key: 'FMIIEN', label: 'Ethernet RMII/MII Enable', label_group: 'DEVCFG3',
          settings: [
            { label: 'RMII Enabled', value: 'OFF' },
            { label: 'MII Enabled', value: 'ON' }
          ]
        },
        {
          init: 'DIV_3', key: 'FPLLIDIV', label: 'System PLL Input Divider', label_group: 'DEVCFG2',
          settings: [
            { label: '2x Divider', value: 'DIV_2' },
            { label: '3x Divider', value: 'DIV_3' }
          ]
        },
        {
          init: 'SPLL', key: 'FNOSC', label: 'Oscillator Selection Bits', label_group: 'DEVCFG1',
          settings: [
            { label: 'System PLL', value: 'SPLL' },
            { label: 'Primary Oscillator', value: 'POSC' }
          ]
        }
      ],
      mcu: 'PIC32MZ2048EFH144',
      clock: 200
    };
    const serialized = cConfigurator.serializeDefinition(xcDefinition);
    assert.deepStrictEqual(serialized.map((item) => item.key), ['DEVCFG3', 'DEVCFG2', 'DEVCFG1']);
    assert.strictEqual(serialized[0].fields[0].id, 'DEVCFG3.FMIIEN');
    assert.strictEqual(serialized[1].fields[0].init, 'DIV_3');
    assert.deepStrictEqual(serialized[1].fields[0].settings.map((item) => item.value), ['DIV_2', 'DIV_3']);

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-xc-config-words-'));
    try {
      const core = path.join(temp, 'core');
      const generatedRoot = path.join(temp, 'generated');
      fs.mkdirSync(path.join(core, 'def'), { recursive: true });
      fs.writeFileSync(path.join(core, 'def', 'PIC32MZ2048EFH144.json'), JSON.stringify(xcDefinition));
      const xcSetup = {
        metadata: {
          compiler: { uid:'mchp_xc32' },
          coreMcuName:'PIC32MZ2048EFH144',
          sdkConfig:{ MCU_NAME:'PIC32MZ2048EFH144' },
          device:{ defFile:'PIC32MZ2048EFH144.json', compilerFlags:'' }
        },
        registerValues: { 'DEVCFG2.FPLLIDIV':'DIV_2' }
      };
      const selections = setup.xcConfigurationSelections(xcSetup, core);
      assert.deepStrictEqual(selections.map(({ key, value, source }) => ({ key, value, source })), [
        { key:'FMIIEN', value:'OFF', source:'init' },
        { key:'FPLLIDIV', value:'DIV_2', source:'setup' },
        { key:'FNOSC', value:'SPLL', source:'init' }
      ]);
      const generated = setup.generateXcConfigurationSource(xcSetup, core, generatedRoot);
      const source = fs.readFileSync(generated.sourcePath, 'utf8');
      assert.ok(source.includes('#pragma config FMIIEN = OFF'));
      assert.ok(source.includes('#pragma config FPLLIDIV = DIV_2'));
      assert.ok(source.includes('#pragma config FNOSC = SPLL'));
      assert.ok(source.indexOf('#pragma config FNOSC = SPLL') < source.indexOf('#include <xc.h>'));

      const makeElf32WithConfigSections = (filePath) => {
        const names = Buffer.from('\0.shstrtab\0.config_BFC0FFC0\0.config_BFC0FFDC\0', 'ascii');
        const nameShstr = 1;
        const nameCfg3 = names.indexOf(Buffer.from('.config_BFC0FFC0'));
        const nameDevcp = names.indexOf(Buffer.from('.config_BFC0FFDC'));
        const shoff = 0x100;
        const shentsize = 40;
        const shnum = 4;
        const buffer = Buffer.alloc(shoff + shentsize * shnum, 0);
        buffer[0] = 0x7F; buffer[1] = 0x45; buffer[2] = 0x4C; buffer[3] = 0x46;
        buffer[4] = 1; // ELF32
        buffer[5] = 1; // little endian
        buffer[6] = 1;
        buffer.writeUInt16LE(1, 16); // ET_REL
        buffer.writeUInt16LE(8, 18); // EM_MIPS
        buffer.writeUInt32LE(1, 20);
        buffer.writeUInt32LE(shoff, 32);
        buffer.writeUInt16LE(52, 40);
        buffer.writeUInt16LE(shentsize, 46);
        buffer.writeUInt16LE(shnum, 48);
        buffer.writeUInt16LE(1, 50);
        names.copy(buffer, 0x80);
        Buffer.from('fffffffcc6'.slice(0, 8), 'hex');
        Buffer.from('ffffffc6', 'hex').copy(buffer, 0xC0);
        Buffer.from('ffffffff', 'hex').copy(buffer, 0xC4);
        const writeSection = (index, nameOffset, type, address, offset, size) => {
          const base = shoff + index * shentsize;
          buffer.writeUInt32LE(nameOffset, base + 0);
          buffer.writeUInt32LE(type, base + 4);
          buffer.writeUInt32LE(address >>> 0, base + 12);
          buffer.writeUInt32LE(offset, base + 16);
          buffer.writeUInt32LE(size, base + 20);
          buffer.writeUInt32LE(1, base + 32);
        };
        writeSection(1, nameShstr, 3, 0, 0x80, names.length);
        writeSection(2, nameCfg3, 1, 0, 0xC0, 4);
        writeSection(3, nameDevcp, 1, 0, 0xC4, 4);
        fs.writeFileSync(filePath, buffer);
      };

      const configObject = path.join(generatedRoot, 'xc_config_words.o');
      makeElf32WithConfigSections(configObject);
      const sections = setup.xc32ConfigurationObjectSections({ ...xcSetup, paths:{ coreSource:core, xcConfigObject:configObject } });
      assert.deepStrictEqual(sections.map((item) => [item.key, item.address, item.data.toString('hex')]), [
        ['.config_BFC0FFC0', 0x1FC0FFC0, 'ffffffc6'],
        ['.config_BFC0FFDC', 0x1FC0FFDC, 'ffffffff']
      ]);
      assert.strictEqual(setup.xc32PhysicalConfigurationAddress(0xBFC0FFC0), 0x1FC0FFC0);

      const toolchainFile = path.join(generatedRoot, 'toolchain.cmake');
      setup.writeToolchain(toolchainFile, {
        ...xcSetup,
        mode: 'full-sdk', clockMHz: '200', applicationOutput: 'debug-terminal',
        metadata: {
          ...xcSetup.metadata,
          device: { ...xcSetup.metadata.device, uid:'PIC32MZ2048EFH144', flash:2097152, ram:524288, linkerFlags:'' },
          sdkConfig: { ...xcSetup.metadata.sdkConfig, CORE_NAME:'MICROAPTIV_FP' }
        }
      }, {
        c:'/opt/xc32/bin/xc32-gcc',
        adapter:compilerSupport.adapterFor('mchp_xc32')
      }, { installPrefix:temp, xcConfigObject:configObject });
      const toolchainText = fs.readFileSync(toolchainFile, 'utf8');
      assert.ok(!toolchainText.includes('MIKROBUS_XC_CONFIG_OBJECT_LINKED'));
      // Symbolic config_words must not be guessed into raw values by the old
      // numeric register path. Instead, merge XC32's own encoded .config bytes.
      xcSetup.paths = { coreSource: core, xcConfigObject: configObject };
      assert.deepStrictEqual(setup.xc32ConfigurationWords(xcSetup), []);
      const symbolicHex = path.join(temp, 'symbolic.hex');
      fs.writeFileSync(symbolicHex, ':020000041D00DD\n:0400000001020304F2\n:00000001FF\n');
      setup.applyXc32ConfigurationWords(xcSetup, symbolicHex);
      const merged = setup.parseIntelHex(fs.readFileSync(symbolicHex, 'utf8'));
      assert.strictEqual(Buffer.from([0,1,2,3].map((i) => merged.memory.get(0x1FC0FFC0 + i))).toString('hex'), 'ffffffc6');
      assert.strictEqual(Buffer.from([0,1,2,3].map((i) => merged.memory.get(0x1FC0FFDC + i))).toString('hex'), 'ffffffff');
    } finally {
      fs.rmSync(temp, { recursive:true, force:true });
    }
  }

  // Older numeric config_registers remain supported for XC32 packages that
  // explicitly provide address/default/mask metadata.
  {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-xc32-numeric-config-'));
    try {
      const core = path.join(temp, 'core');
      fs.mkdirSync(path.join(core, 'def'), { recursive: true });
      fs.writeFileSync(path.join(core, 'def', 'PIC32LEGACY.json'), JSON.stringify({
        config_registers: [
          { key:'DEVCFG0', address:'$1FC0FFCC', default:'FFFFF7D3', unused:'00000000', fields:[] }
        ]
      }));
      const hex = path.join(temp, 'app.hex');
      fs.writeFileSync(hex, ':020000041D00DD\n:0400000001020304F2\n:00000001FF\n');
      const xcSetup = {
        metadata: { compiler:{ uid:'mchp_xc32' }, coreMcuName:'PIC32LEGACY', sdkConfig:{ MCU_NAME:'PIC32LEGACY' }, device:{} },
        paths: { coreSource: core }, registerValues: {}
      };
      setup.applyXc32ConfigurationWords(xcSetup, hex);
      const parsed = setup.parseIntelHex(fs.readFileSync(hex, 'utf8'));
      assert.deepStrictEqual(
        Buffer.from([0,1,2,3].map((index) => parsed.memory.get(0x1FC0FFCC + index))),
        Buffer.from('d3f7ffff', 'hex')
      );
    } finally {
      fs.rmSync(temp, { recursive:true, force:true });
    }
  }

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

  // Core definition lookup must survive dsPIC/DSPIC filename casing differences
  // on Linux. Prefer exact/uppercase names, then fall back to case-insensitive
  // lookup so both historical package spellings are accepted.
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-dspic-case-'));
  try {
    const coreRoot = path.join(caseRoot, 'core');
    fs.mkdirSync(path.join(coreRoot, 'include'), { recursive: true });
    fs.mkdirSync(path.join(coreRoot, 'def'), { recursive: true });
    fs.writeFileSync(path.join(coreRoot, 'include', 'core_header.h.in'), '%DEFINE_STRINGS%');
    fs.writeFileSync(path.join(coreRoot, 'def', 'DSPIC33CK256MP508.json'), JSON.stringify({ config_registers: [] }));
    assert.strictEqual(
      setup.resolveCoreDefinitionFile(coreRoot, 'dsPIC33CK256MP508', 'dsPIC33CK256MP508.json'),
      path.join(coreRoot, 'def', 'DSPIC33CK256MP508.json')
    );
    assert.strictEqual(
      cConfigurator.findDefinitionFile(coreRoot, '', 'dsPIC33CK256MP508.json'),
      path.join(coreRoot, 'def', 'DSPIC33CK256MP508.json')
    );
    const generated = setup.generateCoreHeader(coreRoot, {
      device: { uid: 'dsPIC33CK256MP508', mcuName: 'dsPIC33CK256MP508', defFile: 'dsPIC33CK256MP508.json' }
    }, '100', path.join(caseRoot, 'build'));
    assert.ok(fs.readFileSync(generated, 'utf8').includes('#define dsPIC33CK256MP508'));
  } finally {
    fs.rmSync(caseRoot, { recursive: true, force: true });
  }

  const mikroCCoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-mikroc-core-'));
  try {
    fs.mkdirSync(path.join(mikroCCoreRoot, 'def'), { recursive: true });
    fs.mkdirSync(path.join(mikroCCoreRoot, 'cmake'), { recursive: true });
    fs.writeFileSync(path.join(mikroCCoreRoot, 'CMakeLists.txt'), [
      'cmake_minimum_required(VERSION 3.20)',
      'project(Core VERSION 1 LANGUAGES MikroC)',
      ''
    ].join('\n'));
    fs.writeFileSync(path.join(mikroCCoreRoot, 'cmake', 'coreUtils.cmake'), '# mikroC core marker\n');
    fs.writeFileSync(path.join(mikroCCoreRoot, 'def', 'PIC18F97J94.json'), '{}\n');
    assert.strictEqual(
      setup.locateCoreSource(mikroCCoreRoot, 'PIC/mikroC', 'PIC18F97J94', 'mikroc-pic'),
      mikroCCoreRoot
    );
    assert.strictEqual(setup.isMikroCFamily('mikroc-pic'), true);
    assert.strictEqual(setup.isMikroCFamily('xc8'), false);
  } finally {
    fs.rmSync(mikroCCoreRoot, { recursive: true, force: true });
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

  const mikroCToolchainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-mikroc-toolchain-'));
  try {
    const toolchainFile = path.join(mikroCToolchainRoot, 'toolchain.cmake');
    const compatibilityRoot = path.join(mikroCToolchainRoot, 'cmake');
    const mikroCBin = path.join(mikroCToolchainRoot, 'compiler', 'mikroCPIC1618');
    const coreSource = path.join(mikroCToolchainRoot, 'core', 'PIC', 'mikroC', 'pic_mikroc_pic18');
    fs.mkdirSync(path.dirname(mikroCBin), { recursive: true });
    fs.mkdirSync(path.join(coreSource, 'def'), { recursive: true });
    fs.writeFileSync(mikroCBin, '');
    setup.writeToolchain(toolchainFile, {
      mode: 'full-sdk', clockMHz: '64', applicationOutput: 'debug-terminal',
      metadata: {
        device: { uid: 'PIC18F97J94', mcuName: 'PIC18F97J94', flash: 131072, ram: 3862, compilerFlags: '', linkerFlags: '' },
        compiler: { uid: 'mikrocpic', name: 'mikroC AI for PIC', path: 'mikroc/pic/mikroc', defaultOptions: '{"ANSI_pack":false,"case_sensitive":true,"dynamic_link_literals":false,"generate_additional_files":true,"long_hex_format":false,"ssa_optimization_level":"4"}' },
        sdkConfig: { MCU_NAME: 'PIC18F97J94', CORE_NAME: 'P18' }
      }
    }, {
      c: mikroCBin,
      root: path.dirname(mikroCBin),
      adapter: compilerSupport.adapterFor('mikrocpic')
    }, {
      coreSource,
      compatibilityModuleRoot: compatibilityRoot,
      infrastructureRoot: mikroCToolchainRoot,
      mikroCModuleRoot: path.join(mikroCToolchainRoot, 'mikroc-cmake'),
      installPrefix: mikroCToolchainRoot,
      jcfgFile: path.join(mikroCToolchainRoot, 'PIC18F97J94.jcfg'),
      coreLib: path.join(mikroCToolchainRoot, 'lib', 'lib_core.a')
    });
    const toolchainText = fs.readFileSync(toolchainFile, 'utf8');
    assert.ok(toolchainText.includes(`set(CMAKE_MikroC_COMPILER "${mikroCBin.replace(/\\/g, '/')}`));
    assert.ok(!toolchainText.includes('mikroc-compiler-wrapper'));
    assert.ok(!fs.existsSync(path.join(mikroCToolchainRoot, 'mikroc-compiler-wrapper.sh')));
    assert.ok(!fs.existsSync(path.join(mikroCToolchainRoot, 'mikroc-compiler-wrapper.cmd')));
    assert.ok(toolchainText.includes('set(TOOLCHAIN_LANGUAGE "MikroC"'));
    assert.ok(toolchainText.includes('set(MIKROSDK_TYPE "mikrosdk"'));
    assert.ok(toolchainText.includes('MikroBUS mikroC device: PIC18F97J94'));
    assert.ok(toolchainText.includes(`MikroBUS mikroC core def: ${path.join(coreSource, 'def').replace(/\\/g, '/')}`));
    assert.ok(toolchainText.includes('set(COMPILER_FLAGS "-C;-MF;-O11111114;-DBG;-UICD" CACHE STRING "" FORCE)'));
    assert.ok(toolchainText.includes('set(LINKER_FLAGS "-C;-MF;-O11111114;-DBG;-UICD" CACHE STRING "" FORCE)'));
    assert.ok(toolchainText.includes('set(CMAKE_MikroC_FLAGS "-C -MF -O11111114 -DBG -UICD" CACHE STRING "" FORCE)'));
    assert.ok(toolchainText.includes('set(CMAKE_EXE_LINKER_FLAGS "-C -MF -O11111114 -DBG -UICD" CACHE STRING "" FORCE)'));
    const expectedSearchPaths = `\${CMAKE_BINARY_DIR};${path.join(coreSource, 'def').replace(/\\/g, '/')};\${CMAKE_SOURCE_DIR}`;
    assert.ok(toolchainText.includes(`set(SEARCH_PATHS "${expectedSearchPaths}" CACHE STRING "" FORCE)`));
    assert.ok(toolchainText.includes('set(JCFG_FILE "'));
    assert.ok(toolchainText.includes('PIC18F97J94.jcfg'));
    assert.ok(toolchainText.includes('set(CORE_LIB "'));
    assert.ok(toolchainText.includes('lib_core.a'));
    assert.ok(toolchainText.includes('mikroc-cmake'));
    assert.ok(toolchainText.includes('set(CMAKE_MikroC_OUTPUT_EXTENSION ".mcl" CACHE STRING "" FORCE)'));
    assert.ok(toolchainText.includes('set(CMAKE_MikroC_OUTPUT_EXTENSION_REPLACE "1" CACHE STRING "" FORCE)'));
    assert.ok(!toolchainText.includes('add_compile_options('));

    const searchInfo = setup.mikroCSearchPathInfo(mikroCBin, {}, { coreSource });
    assert.deepStrictEqual(searchInfo.paths, [
      '${CMAKE_BINARY_DIR}', path.join(coreSource, 'def'), '${CMAKE_SOURCE_DIR}'
    ]);
    assert.strictEqual(searchInfo.coreDefinitionDirectory, path.join(coreSource, 'def'));

    const platformBundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-mikroc-platform-bin-'));
    try {
      const expectedPlatform = process.platform === 'win32' ? 'win64' : (process.platform === 'darwin' ? 'macos' : 'linux');
      const expectedBin = path.join(platformBundleRoot, 'bin', expectedPlatform);
      fs.mkdirSync(expectedBin, { recursive: true });
      assert.strictEqual(setup.mikroCPlatformBinDirectory(platformBundleRoot), expectedBin);
    } finally {
      fs.rmSync(platformBundleRoot, { recursive: true, force: true });
    }

    assert.strictEqual(setup.mikroCOutputExtension('mikroc-pic'), '.mcl');
    assert.strictEqual(setup.mikroCOutputExtension('mikroc-dspic'), '.mcl');
    assert.strictEqual(setup.mikroCOutputExtension('mikroc-avr'), '.mcl');
    assert.strictEqual(setup.mikroCOutputExtension('mikroc-pic32'), '.emcl');
    assert.strictEqual(setup.mikroCOutputExtension('mikroc-arm'), '.emcl');
    setup.generateMikroCLanguageSupport(compatibilityRoot);
    const compilerModuleText = fs.readFileSync(path.join(compatibilityRoot, 'CMakeMikroCCompiler.cmake.in'), 'utf8');
    assert.ok(compilerModuleText.includes('set(CMAKE_MikroC_OUTPUT_EXTENSION_REPLACE 1)'));
    assert.deepStrictEqual(setup.mikroCCompilerFlags('mikroc-pic', '{"case_sensitive":true,"generate_additional_files":true,"ssa_optimization_level":"4"}', 'Debug'), ['-C', '-MF', '-O11111114', '-DBG', '-UICD']);
    assert.deepStrictEqual(setup.mikroCCompilerFlags('mikroc-pic32', '{"case_sensitive":true,"generate_additional_files":true,"ssa_optimization_level":"4"}', 'Debug'), ['-C', '-SSA', '-MF', '-O11111114', '-DBG', '-UICD']);

    const managedCmakeRoot = path.join(mikroCToolchainRoot, 'managed-cmake');
    const managedCmake = path.join(managedCmakeRoot, 'bin', process.platform === 'win32' ? 'cmake.exe' : 'cmake');
    fs.mkdirSync(path.dirname(managedCmake), { recursive: true });
    fs.writeFileSync(managedCmake, '');
    const moduleRoot = path.join(mikroCToolchainRoot, 'managed-mikroc-cmake');
    fs.mkdirSync(moduleRoot, { recursive: true });
    for (const name of ['CMakeDetermineMikroCCompiler.cmake', 'CMakeMikroCCompiler.cmake.in', 'CMakeMikroCInformation.cmake', 'CMakeTestMikroCCompiler.cmake']) {
      fs.writeFileSync(path.join(moduleRoot, name), '# module\n');
    }
    const installed = new Map([
      ['shared:cmake@necto-live', { kind: 'shared', name: 'cmake', root: managedCmakeRoot }],
      ['shared:mikroc_cmake@0.0.1', { kind: 'shared', name: 'mikroc_cmake', root: moduleRoot }]
    ]);
    assert.strictEqual(setup.resolveManagedNectoCmake(installed), managedCmake);
    assert.strictEqual(setup.resolveManagedMikroCCmakeModules(installed), moduleRoot);
  } finally {
    fs.rmSync(mikroCToolchainRoot, { recursive: true, force: true });
  }

  const mikroCJcfgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-mikroc-jcfg-'));
  try {
    const coreRoot = path.join(mikroCJcfgRoot, 'core');
    const defRoot = path.join(coreRoot, 'def');
    fs.mkdirSync(defRoot, { recursive: true });
    fs.writeFileSync(path.join(defRoot, 'PIC32MZ2048EFH144.json'), JSON.stringify({
      config_registers: [
        {
          key: 'DEVCFG0', address: '$1FC0FFCC', default: 'FFFF0000',
          fields: [
            { key: 'VISIBLE', mask: '0000000F', init: '00000001' },
            { key: 'HIDDEN', mask: '000000F0', init: '000000A0', hidden: true }
          ]
        },
        { key: 'DEVCP0', address: '0x1FC0FFDC', default: 'FFFFFFFF', fields: [] },
        { key: 'SMALL', address: '1234', default: '0000000F', unused: '00000008', fields: [] }
      ],
      back_door_key: 'SHOULD_NOT_BE_USED',
      data_type_size: 'SHOULD_NOT_BE_USED',
      stack_allocation: 'SHOULD_NOT_BE_USED'
    }, null, 2));
    const jcfg = setup.generateMikroCJcfg(coreRoot, {
      device: { uid: 'PIC32MZ2048EFH144', mcuName: 'PIC32MZ2048EFH144', defFile: 'PIC32MZ2048EFH144.json' },
      sdkConfig: { MCU_NAME: 'PIC32MZ2048EFH144' }
    }, { 'DEVCFG0.VISIBLE': '00000003' }, mikroCJcfgRoot);
    const parsed = JSON.parse(fs.readFileSync(jcfg, 'utf8'));
    assert.strictEqual(parsed.mcu_name, 'PIC32MZ2048EFH144');
    assert.deepStrictEqual(parsed.config_registers, [
      { address: '$1FC0FFCC', value: '$ffff00a3' },
      { address: '$1FC0FFDC', value: '$ffffffff' },
      { address: '$1234', value: '$7' }
    ]);
    assert.strictEqual(parsed.back_door_key, '0');
    assert.strictEqual(parsed.data_type_size, '0');
    assert.strictEqual(parsed.stack_allocation, '0');
  } finally {
    fs.rmSync(mikroCJcfgRoot, { recursive: true, force: true });
  }

  const rl78ToolchainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-rl78-toolchain-'));
  try {
    const toolchainFile = path.join(rl78ToolchainRoot, 'toolchain.cmake');
    const linkerScript = path.join(rl78ToolchainRoot, 'r7f101glg.ld');
    setup.writeToolchain(toolchainFile, {
      clockMHz: '48', applicationOutput: 'debug-terminal',
      metadata: {
        device: { uid: 'R7F101GLG', familyUid: 'G24', flash: 131072, ram: 12288, compilerFlags: '', linkerFlags: '' },
        compiler: { uid: 'llvm-rl78-elf' },
        sdkConfig: { MCU_NAME: 'R7F101GLG', CORE_NAME: 'RL78' }
      }
    }, {
      c: '/toolchain/bin/clang',
      cxx: '/toolchain/bin/clang++',
      asm: '/toolchain/bin/llvm-as',
      cmakeAsm: '/toolchain/bin/clang',
      adapter: compilerSupport.adapterFor('llvm-rl78-elf')
    }, {
      compatibilityModuleRoot: rl78ToolchainRoot,
      infrastructureRoot: rl78ToolchainRoot,
      installPrefix: rl78ToolchainRoot,
      linkerScript
    });
    const toolchainText = fs.readFileSync(toolchainFile, 'utf8');
    assert.ok(toolchainText.includes('"-nostartfiles"'));
    assert.ok(toolchainText.includes('"-mcpu=s2"'));
    assert.ok(toolchainText.includes('"-mmirror-source-common"'));
    assert.ok(toolchainText.includes(`add_link_options("-T${linkerScript}")`));
    const flags = compilerSupport.compilerSpecificFlags(compilerSupport.adapterFor('llvm-rl78-elf'), {
      device: { uid: 'R7F101GLG', familyUid: 'G24' }, sdkConfig: { MCU_NAME: 'R7F101GLG', CORE_NAME: 'RL78' }
    });
    assert.ok(flags.link.includes('-nostartfiles'));
    assert.ok(flags.link.includes('-mcpu=s2'));
    assert.ok(flags.link.includes('-mdisable-mda'));
    assert.ok(flags.link.includes('-mnear-code'));
    assert.ok(flags.link.includes('-mnear-data'));
    assert.ok(flags.link.includes('-mmirror-source-common'));
    assert.ok(flags.link.includes('-mcommon-rom'));
    assert.ok(flags.compile.includes('-mcpu=s2'));
    assert.ok(toolchainText.includes('\"-mdisable-mda\"'));
    assert.ok(toolchainText.includes('\"-mnear-code\"'));
    assert.ok(toolchainText.includes('\"-mnear-data\"'));
  } finally {
    fs.rmSync(rl78ToolchainRoot, { recursive: true, force: true });
  }

  const rxToolchainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-rx-toolchain-'));
  try {
    const rxCoreSource = path.join(rxToolchainRoot, 'core');
    fs.mkdirSync(path.join(rxCoreSource, 'cmake'), { recursive: true });
    fs.writeFileSync(path.join(rxCoreSource, 'cmake', 'coreUtils.cmake'), `
function(set_flags flags)
    if (\${CORE_NAME} STREQUAL "RXv3")
        set(\${flags} -Wno-incompatible-pointer-types -fno-builtin -ffunction-sections -fdata-sections -fomit-frame-pointer -Og -fdiagnostics-parseable-fixits -nostartfiles -fno-strict-aliasing -fno-common -misa=v3 -fpu -mlittle-endian-data PARENT_SCOPE)
    else()
        message(FATAL_ERROR "MCU Core not supported.")
    endif()
endfunction()
`);
    assert.deepStrictEqual(setup.rxCoreDeclaredFlags(rxCoreSource, 'RXv3'), [
      '-Wno-incompatible-pointer-types', '-fno-builtin', '-ffunction-sections', '-fdata-sections',
      '-fomit-frame-pointer', '-Og', '-fdiagnostics-parseable-fixits', '-nostartfiles',
      '-fno-strict-aliasing', '-fno-common', '-misa=v3', '-fpu', '-mlittle-endian-data'
    ]);
    const toolchainFile = path.join(rxToolchainRoot, 'toolchain.cmake');
    setup.writeToolchain(toolchainFile, {
      clockMHz: '120', applicationOutput: 'debug-terminal',
      metadata: {
        device: { uid: 'R5F526T8ADFL', familyUid: 'RX26T', flash: 131072, ram: 49152, compilerFlags: '', linkerFlags: '' },
        compiler: { uid: 'rx-elf-gcc' },
        sdkConfig: { MCU_NAME: 'R5F526T8ADFL', CORE_NAME: 'RXv3' }
      }
    }, {
      c: '/toolchain/bin/rx-elf-gcc',
      cxx: '/toolchain/bin/rx-elf++',
      asm: '/toolchain/bin/rx-elf-as',
      cmakeAsm: '/toolchain/bin/rx-elf-gcc',
      adapter: compilerSupport.adapterFor('rx-elf-gcc')
    }, {
      coreSource: rxCoreSource,
      compatibilityModuleRoot: rxToolchainRoot,
      infrastructureRoot: rxToolchainRoot,
      installPrefix: rxToolchainRoot
    });
    const toolchainText = fs.readFileSync(toolchainFile, 'utf8');
    assert.ok(toolchainText.includes('"-misa=v3"'));
    assert.ok(toolchainText.includes('"-fpu"'));
    assert.ok(toolchainText.includes('"-mlittle-endian-data"'));
    assert.ok(toolchainText.includes('"-nostartfiles"'));
    assert.ok(toolchainText.includes('"-Wl,-u,_PowerON_Reset_PC"'));
    // The selected core's set_flags() list is authoritative for the application.
    // In particular -nostartfiles now appears in the project compile options too,
    // proving the list came from coreUtils.cmake rather than the fallback table.
    assert.match(toolchainText, /add_compile_options\([^\n]*"-nostartfiles"/);
    assert.ok(!toolchainText.includes('-mcpu=rx66t'));
    assert.ok(!toolchainText.includes('-mcpu=rxv3'));
    assert.deepStrictEqual(compilerSupport.rxArchitectureFlags({
      device: { familyUid: 'RX26T' }, sdkConfig: { CORE_NAME: 'RXv3' }
    }), ['-misa=v3', '-fpu', '-mlittle-endian-data']);
    const rxFlags = compilerSupport.rxCompilerFlags({
      device: { familyUid: 'RX26T' }, sdkConfig: { CORE_NAME: 'RXv3' }
    });
    assert.ok(rxFlags.compile.includes('-fno-builtin'));
    assert.ok(rxFlags.compile.includes('-fomit-frame-pointer'));
    assert.ok(rxFlags.compile.includes('-fno-common'));
    assert.ok(rxFlags.link.includes('-nostartfiles'));
    assert.ok(rxFlags.link.includes('-Wl,-u,_PowerON_Reset_PC'));
  } finally {
    fs.rmSync(rxToolchainRoot, { recursive: true, force: true });
  }

  const xc8ToolchainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-xc8-toolchain-'));
  try {
    const toolchainFile = path.join(xc8ToolchainRoot, 'toolchain.cmake');
    setup.writeToolchain(toolchainFile, {
      clockMHz: '64', applicationOutput: 'debug-terminal',
      metadata: {
        device: { uid: 'PIC18F97J94', mcuName: 'PIC18F97J94', flash: 131072, ram: 3862, compilerFlags: '', linkerFlags: '' },
        compiler: { uid: 'mchp_xc8' },
        sdkConfig: { MCU_NAME: 'PIC18F97J94', CORE_NAME: 'P18', _MSDK_COMPILER_ID_: 'XC8' }
      }
    }, {
      c: '/toolchain/bin/xc8-cc',
      asm: '/toolchain/bin/xc8-cc',
      cmakeAsm: '/toolchain/bin/xc8-cc',
      ar: '/toolchain/bin/xc8-ar',
      adapter: compilerSupport.adapterFor('mchp_xc8')
    }, {
      compatibilityModuleRoot: xc8ToolchainRoot,
      infrastructureRoot: xc8ToolchainRoot,
      installPrefix: xc8ToolchainRoot
    });
    const toolchainText = fs.readFileSync(toolchainFile, 'utf8');
    const rulesText = fs.readFileSync(path.join(xc8ToolchainRoot, 'xc8-cmake-rules.cmake'), 'utf8');
    assert.ok(toolchainText.includes('set(CMAKE_AR "/toolchain/bin/xc8-ar"'));
    assert.ok(toolchainText.includes('"-mcpu=18F97J94"'));
    assert.ok(!toolchainText.includes('-mcpu=PIC18F97J94'));
    assert.ok(toolchainText.includes('add_compile_definitions("$<$<CONFIG:Debug>:__DEBUG>")'));
    assert.ok(toolchainText.includes('CMAKE_USER_MAKE_RULES_OVERRIDE_C'));
    assert.ok(rulesText.includes('set(CMAKE_C_OUTPUT_EXTENSION ".p1")'));
    assert.ok(rulesText.includes('set(CMAKE_EXECUTABLE_SUFFIX ".elf")'));
    assert.ok(rulesText.includes('<CMAKE_AR> -r <TARGET> <OBJECTS>'));
    assert.deepStrictEqual(compilerSupport.adapterFor('mchp_xc8').executableNames.ar, ['xc8-ar']);
    assert.deepStrictEqual(compilerSupport.adapterFor('mchp_xc8').executableNames.objcopy, ['avr-objcopy']);
  } finally {
    fs.rmSync(xc8ToolchainRoot, { recursive: true, force: true });
  }

  assert.strictEqual(compilerSupport.microchipProcessorName('xc8', 'PIC18F97J94'), '18F97J94');
  assert.strictEqual(compilerSupport.microchipProcessorName('xc16', 'dsPIC33CK256MP508'), '33CK256MP508');
  assert.strictEqual(compilerSupport.microchipProcessorName('xc16', 'PIC24FJ256GA705'), '24FJ256GA705');
  assert.strictEqual(compilerSupport.microchipProcessorName('xc32', 'PIC32MZ2048EFH144'), '32MZ2048EFH144');
  assert.strictEqual(compilerSupport.microchipProcessorName('xc32', 'ATSAME54P20A'), 'ATSAME54P20A');

  for (const [uid, family, arName, ranlibName, processorFlag] of [
    ['mchp_xc16', 'xc16', 'xc16-ar', 'xc16-ranlib', '-mcpu=33CK256MP508'],
    ['mchp_xc32', 'xc32', 'xc32-ar', 'xc32-ranlib', '-mprocessor=32MZ2048EFH144']
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `mikrobus-${family}-toolchain-`));
    try {
      const toolchainFile = path.join(root, 'toolchain.cmake');
      const mcu = family === 'xc16' ? 'dsPIC33CK256MP508' : 'PIC32MZ2048EFH144';
      setup.writeToolchain(toolchainFile, {
        clockMHz: '120', applicationOutput: 'debug-terminal',
        metadata: {
          device: { uid: mcu, mcuName: mcu, flash: 1, ram: 1, compilerFlags: '', linkerFlags: '' },
          compiler: { uid },
          sdkConfig: { MCU_NAME: mcu, CORE_NAME: family === 'xc16' ? 'dsPIC33' : 'MIPS32', _MSDK_COMPILER_ID_: family.toUpperCase() }
        }
      }, {
        c: `/toolchain/bin/${family}-gcc`,
        asm: `/toolchain/bin/${family}-gcc`,
        cmakeAsm: `/toolchain/bin/${family}-gcc`,
        ar: `/toolchain/bin/${arName}`,
        ranlib: `/toolchain/bin/${ranlibName}`,
        adapter: compilerSupport.adapterFor(uid)
      }, {
        compatibilityModuleRoot: root,
        infrastructureRoot: root,
        installPrefix: root
      });
      const text = fs.readFileSync(toolchainFile, 'utf8');
      assert.ok(text.includes(`set(CMAKE_AR "/toolchain/bin/${arName}"`));
      assert.ok(text.includes(`set(CMAKE_RANLIB "/toolchain/bin/${ranlibName}"`));
      assert.ok(text.includes(`"${processorFlag}"`));
      if (family === 'xc32') {
        assert.ok(text.includes('if(MIKROBUS_HARDWARE_DEBUG)'));
        assert.ok(text.includes('add_compile_options("-mdebugger")'));
        assert.ok(text.includes('add_link_options("-mdebugger")'));
      }
      assert.ok(text.includes('if(DEFINED MIKROBUS_WORKSPACE_PREFIX_PATH)'));
      assert.deepStrictEqual(compilerSupport.adapterFor(uid).executableNames.ar, [arName]);
      assert.deepStrictEqual(compilerSupport.adapterFor(uid).executableNames.ranlib, [ranlibName]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // Managed Microchip XC toolchains require XCLM to be root-owned + setuid on Linux.
  assert.strictEqual(packageManager.isXcCompilerUid('mchp_xc8'), true);
  assert.strictEqual(packageManager.isXcCompilerUid('mchp_xc16'), true);
  assert.strictEqual(packageManager.isXcCompilerUid('mchp_xc32'), true);
  assert.strictEqual(packageManager.isXcCompilerUid('gcc_arm_none_eabi'), false);
  assert.strictEqual(packageManager.isXcToolchainSpec({ kind:'toolchain', compilerUids:['mchp_xc32'] }), true);
  assert.strictEqual(packageManager.isXcToolchainSpec({ kind:'toolchain', compilerUids:['gcc_arm_none_eabi'] }), false);
  assert.strictEqual(packageManager.xclmSetuidRootFromStat({ uid:0, gid:0, mode:0o104755 }), true);
  assert.strictEqual(packageManager.xclmSetuidRootFromStat({ uid:1000, gid:1000, mode:0o100755 }), false);
  assert.strictEqual(packageManager.xclmSetuidRootFromStat({ uid:0, gid:0, mode:0o100755 }), false);
  const xclmRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-xclm-find-'));
  try {
    const xclmPath = path.join(xclmRoot, 'XC32', 'bin', process.platform === 'win32' ? 'xclm.exe' : 'xclm');
    fs.mkdirSync(path.dirname(xclmPath), { recursive:true });
    fs.writeFileSync(xclmPath, 'xclm');
    assert.deepStrictEqual(packageManager.findXclmExecutables(xclmRoot), [path.resolve(xclmPath)]);
    assert.match(packageManager.xclmManualSetupCommand(xclmPath), /chmod 4755/);
  } finally {
    fs.rmSync(xclmRoot, { recursive:true, force:true });
  }
  const cSetupSourceForXclm = fs.readFileSync(path.join(__dirname, '..', 'c_setup.js'), 'utf8');
  assert.ok(cSetupSourceForXclm.includes('ensureXcCompilerReady'));
  const cPackageManagerSourceForXclm = fs.readFileSync(path.join(__dirname, '..', 'c_package_manager.js'), 'utf8');
  assert.ok(cPackageManagerSourceForXclm.includes('if (isXcToolchainSpec(spec)) await ensureXclmPrivilegesAtRoot(target, progress, token);'));

  const privilegeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-xclm-fingerprint-'));
  try {
    const privilegeFile = path.join(privilegeRoot, 'xclm');
    fs.writeFileSync(privilegeFile, 'x');
    fs.chmodSync(privilegeFile, 0o755);
    const privilegeA = setup.xcPrivilegeFingerprint([privilegeFile]);
    fs.chmodSync(privilegeFile, 0o700);
    const privilegeB = setup.xcPrivilegeFingerprint([privilegeFile]);
    assert.notStrictEqual(privilegeA, privilegeB);
  } finally {
    fs.rmSync(privilegeRoot, { recursive:true, force:true });
  }
  assert.ok(cSetupSourceForXclm.includes('rebuilding ${setup.name} before Apply'));

  assert.strictEqual(setup.C_BUILD_SUPPORT_VERSION, 65);

  const armGdbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-arm-gdb-'));
  try {
    const gdbName = process.platform === 'win32' ? 'arm-none-eabi-gdb.exe' : 'arm-none-eabi-gdb';
    const gdbPath = path.join(armGdbRoot, 'bin', gdbName);
    fs.mkdirSync(path.dirname(gdbPath), { recursive: true });
    fs.writeFileSync(gdbPath, 'gdb');
    assert.strictEqual(setup.findArmGdbInRoot(armGdbRoot), gdbPath);
  } finally {
    fs.rmSync(armGdbRoot, { recursive: true, force: true });
  }


  const mikrocCodegripAvailability = setup.cDebugAvailability({
    metadata: {
      compiler: { uid: 'mikrocarm' },
      programmer: { uid: 'codegrip' }
    }
  });
  assert.strictEqual(mikrocCodegripAvailability.available, false);
  assert.strictEqual(mikrocCodegripAvailability.reason, 'mikroc-codegrip');
  assert.match(mikrocCodegripAvailability.hint, /NECTO Studio/);
  for (const compilerUid of ['mchp_xc8', 'mchp_xc16', 'mchp_xc32']) {
    const xcCodegripAvailability = setup.cDebugAvailability({
      metadata: {
        compiler: { uid: compilerUid },
        programmer: { uid: 'codegrip' }
      }
    });
    assert.strictEqual(xcCodegripAvailability.available, false);
    assert.strictEqual(xcCodegripAvailability.reason, 'xc-codegrip');
    assert.match(xcCodegripAvailability.hint, /Microchip programmers/);
  }
  const renesasUartAvailability = setup.cDebugAvailability({
    metadata: {
      compiler: { uid: 'llvm-rl78-elf' },
      programmer: { uid: 'renesas_rfp' },
      device: { uid: 'R7F124FPJ5xFB' }
    },
    rfpProfile: { connection: 'uart', interface: 'uart1' }
  });
  assert.strictEqual(renesasUartAvailability.available, false);
  assert.strictEqual(renesasUartAvailability.reason, 'renesas-e2-required');
  assert.match(renesasUartAvailability.hint, /E2 and E2 Lite/);

  const clangToolchainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-clang-compat-'));
  try {
    const clangCoreCmakeRoot = path.join(clangToolchainRoot, 'core', 'cmake');
    fs.mkdirSync(clangCoreCmakeRoot, { recursive: true });
    fs.writeFileSync(path.join(clangCoreCmakeRoot, 'coreUtils.cmake'), [
      'function(set_flags flags)',
      '    if (${CORE_NAME} STREQUAL "M4")',
      '        set(${flags} -std=gnu99 -mcpu=cortex-m4 -mthumb ${POINTER_TYPE_ERROR} -Wno-int-conversion -Wno-incompatible-function-pointer-types PARENT_SCOPE)',
      '    endif()',
      'endfunction()',
      ''
    ].join('\n'), 'utf8');
    const clangToolchain = path.join(clangToolchainRoot, 'toolchain.cmake');
    setup.writeToolchain(clangToolchain, {
      clockMHz: '168', applicationOutput: 'none', mode: 'full-sdk',
      metadata: {
        device: { uid: 'STM32F407ZG', mcuName: 'STM32F407ZG', flash: 1048576, ram: 131072, compilerFlags: '', linkerFlags: '' },
        compiler: { uid: 'clang-llvm' },
        sdkConfig: { MCU_NAME: 'STM32F407ZG', CORE_NAME: 'M4', _MSDK_COMPILER_ID_: 'Clang' }
      }
    }, {
      c: '/toolchain/bin/clang', cxx: '/toolchain/bin/clang++', asm: '/toolchain/bin/clang', cmakeAsm: '/toolchain/bin/clang',
      adapter: compilerSupport.adapterFor('clang-llvm')
    }, {
      coreSource: path.join(clangToolchainRoot, 'core'),
      compatibilityModuleRoot: clangToolchainRoot,
      infrastructureRoot: clangToolchainRoot,
      installPrefix: clangToolchainRoot
    });
    const clangText = fs.readFileSync(clangToolchain, 'utf8');
    assert.ok(clangText.includes('"-Wno-int-conversion"'));
    assert.ok(clangText.includes('"-Wno-incompatible-function-pointer-types"'));
    assert.ok(clangText.includes('set(CMAKE_C_FLAGS_INIT "-Wno-int-conversion -Wno-incompatible-function-pointer-types ${CMAKE_C_FLAGS_INIT}")'));
  } finally {
    fs.rmSync(clangToolchainRoot, { recursive: true, force: true });
  }

  const cleanupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-obsolete-mikroc-debug-'));
  try {
    const cleanupContext = { globalStorageUri: { fsPath: cleanupRoot } };
    const packagesRoot = path.join(cleanupRoot, 'c-runtime', 'packages');
    const qtRoot = path.join(packagesRoot, 'tools', 'mikrodap-qt', '6.9.1');
    const debugRoot = path.join(packagesRoot, 'shared', 'debuggers', 'current');
    fs.mkdirSync(qtRoot, { recursive: true });
    fs.mkdirSync(debugRoot, { recursive: true });
    const registryPath = path.join(cleanupRoot, 'c-runtime', 'installed-packages.json');
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({ version: 1, packages: [
      { key: 'shared:mikrodap_qt_runtime@6.9.1', name: 'mikrodap_qt_runtime', root: qtRoot },
      { key: 'shared:debuggers@current', name: 'debuggers', root: debugRoot }
    ] }));
    assert.strictEqual(packageManager.cleanupObsoleteMikroCDebugArtifacts(cleanupContext), true);
    assert.strictEqual(fs.existsSync(path.join(packagesRoot, 'tools', 'mikrodap-qt')), false);
    assert.strictEqual(fs.existsSync(path.join(packagesRoot, 'shared', 'debuggers')), false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(registryPath, 'utf8')).packages, []);
  } finally {
    fs.rmSync(cleanupRoot, { recursive: true, force: true });
  }

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
  assert.ok(setupSource.includes('Workspace CMake install prefix:'));
  assert.ok(setupSource.includes('`-DCMAKE_INSTALL_PREFIX=${workspaceInstallPrefix}`'));
  assert.ok(setupSource.includes('...preProjectDefinitions'));
  assert.ok(setupSource.includes('workspacePreProjectCmakeArguments'));
  assert.ok(setupSource.includes("'-DMSDK_BUILD_TFT_MODULES=FALSE'"));
  assert.ok(setupSource.includes('metadata.packageRequirements.card.mcuName ||'));
  assert.ok(setupSource.includes('metadata.device?.mcuName ||'));
  assert.ok(setupSource.includes('metadata.sdkConfig?.MCU_NAME ||'));
  assert.ok(!setupSource.includes('function mikroCNectoPackageRoots'));
  assert.ok(!setupSource.includes('mikroc-compiler-wrapper'));
  assert.ok(!setupSource.includes('requireManagedMikroCDefinition'));
  assert.ok(setupSource.includes("paths: ['${CMAKE_BINARY_DIR}', coreDefinitionDirectory, '${CMAKE_SOURCE_DIR}']"));
  const compilerSupportSource = fs.readFileSync(path.join(__dirname, '..', 'c_compiler_support.js'), 'utf8');
  for (const family of ['arm', 'pic', 'dspic', 'pic32', 'avr']) {
    assert.ok(compilerSupportSource.includes(`installRelativePath: 'compilers/mikroc/${family}/mikroc'`));
  }
  const payloadSelectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-mikroc-bundle-select-'));
  try {
    const expectedPayload = path.join(payloadSelectRoot, 'PIC32', 'mikroC');
    fs.mkdirSync(expectedPayload, { recursive: true });
    fs.writeFileSync(path.join(expectedPayload, 'marker.txt'), 'ok');
    assert.strictEqual(packageManager.normalizedPayloadRoot(payloadSelectRoot, {
      name: 'mikroc_pic32', payloadSubdir: 'PIC32/mikroC'
    }), expectedPayload);
    assert.throws(() => packageManager.normalizedPayloadRoot(payloadSelectRoot, {
      name: 'mikroc_pic32', payloadSubdir: '../escape'
    }), /Invalid package payload subdirectory|escapes the extraction root/);
  } finally {
    fs.rmSync(payloadSelectRoot, { recursive: true, force: true });
  }

  const packageManagerSource = fs.readFileSync(path.join(__dirname, '..', 'c_package_manager.js'), 'utf8');
  assert.ok(packageManagerSource.includes('const layoutMatches ='));
  assert.ok(packageManagerSource.includes('Compiler packages'));
  assert.ok(packageManagerSource.includes("kind === 'compiler'"));
  assert.ok(packageManagerSource.includes('CODEGRIP packages'));
  assert.ok(packageManagerSource.includes("kind === 'codegrip'"));
  assert.ok(packageManagerSource.includes("let statusFilter='all'"));
  assert.ok(packageManagerSource.includes('id="installedCount"'));
  assert.ok(packageManagerSource.includes('id="missingCount"'));
  assert.ok(packageManagerSource.includes('data-manager="environment"'));
  assert.ok(packageManagerSource.includes('metadata_demos_c.json'));
  assert.ok(packageManagerSource.includes("kind: 'demo-example'"));
  assert.ok(packageManagerSource.includes('Demo Examples'));
  const demoSpec = packageManager.demoExampleSpec({
    name: 'Analog Input Demo',
    download_link: 'https://example.invalid/mikroe-demo-sdk-analogin.zip'
  });
  assert.strictEqual(demoSpec.kind, 'demo-example');
  assert.strictEqual(demoSpec.name, 'mikroe-demo-sdk-analogin');
  assert.strictEqual(demoSpec.installRelativePath, 'demo-examples/mikroe-demo-sdk-analogin');
  const demoProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-demo-project-'));
  try {
    const nestedProject = path.join(demoProjectRoot, 'payload', 'demo-app');
    fs.mkdirSync(nestedProject, { recursive: true });
    fs.writeFileSync(path.join(nestedProject, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n');
    assert.strictEqual(packageManager.resolveExampleProjectRoot({ root: demoProjectRoot }), nestedProject);
  } finally {
    fs.rmSync(demoProjectRoot, { recursive: true, force: true });
  }

  const rustCoreCatalog = rustCorePackages.validateCatalog({
    schemaVersion: 1,
    packages: [
      { name: 'arm_stm32f_2xx', asset: 'arm_stm32f_2xx.7z', sha256: 'a'.repeat(64), systemLib: 'system_stm32f_2xx' },
      { name: 'mips_pic32mz', asset: 'mips_pic32mz.7z', sha256: 'b'.repeat(64), systemLib: 'system_pic32mz' },
      { name: 'rl78_g24', asset: 'rl78_g24.7z', sha256: 'c'.repeat(64), systemLib: 'system_rl78_g24' }
    ]
  });
  assert.strictEqual(rustCorePackages.packageForSystemLib(rustCoreCatalog, 'system_stm32f_2xx').name, 'arm_stm32f_2xx');
  assert.strictEqual(rustCorePackages.packageForSystemLib(rustCoreCatalog, 'SYSTEM_PIC32MZ').name, 'mips_pic32mz');
  assert.strictEqual(rustCorePackages.packageForSystemLib(rustCoreCatalog, 'system_rl78_g24').name, 'rl78_g24');
  assert.ok(rustCorePackages.releaseAssetUrl('owner/repo', 'arm_stm32f_2xx.7z').includes('/rust-core-packages/arm_stm32f_2xx.7z'));

  const rustBoardCatalog = rustBoardPackages.validateCatalog({
    schemaVersion: 1,
    packageModel: 'board-entity',
    packages: [
      { name: 'board_board-a', asset: 'board_board-a.7z', sha256: 'd'.repeat(64), entityType: 'board', uid: 'BOARD-A', displayName: 'Board A', relativeBspPath: 'boards/a.json' },
      { name: 'shield_shield-a', asset: 'shield_shield-a.7z', sha256: 'e'.repeat(64), entityType: 'shield', uid: 'SHIELD-A', displayName: 'Shield A', relativeBspPath: 'shields/a.json' }
    ]
  });
  assert.strictEqual(rustBoardPackages.packageForEntity(rustBoardCatalog, 'board', 'board-a').name, 'board_board-a');
  assert.strictEqual(rustBoardPackages.packageForEntity(rustBoardCatalog, 'shield', 'SHIELD-A').name, 'shield_shield-a');
  assert.ok(rustBoardPackages.releaseAssetUrl('owner/repo', 'board_board-a.7z').includes('/rust-board-packages/board_board-a.7z'));

  const rustCardCatalog = rustCardPackages.validateCatalog({
    schemaVersion: 1,
    packageModel: 'card-entity',
    packages: [
      { name: 'card_card-a', asset: 'card_card-a.7z', sha256: 'f'.repeat(64), entityType: 'card', uid: 'CARD-A', displayName: 'Card A', relativeBspPath: 'cards/a.json' }
    ]
  });
  assert.strictEqual(rustCardPackages.packageForEntity(rustCardCatalog, 'card', 'card-a').name, 'card_card-a');
  assert.ok(rustCardPackages.releaseAssetUrl('owner/repo', 'card_card-a.7z').includes('/rust-card-packages/card_card-a.7z'));

  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.strictEqual(packageJson.version, '0.8.17');
  assert.strictEqual(packageJson.publisher, 'IvanRuzavin');
  assert.strictEqual(packageJson.author, 'IvanRuzavin');
  assert.strictEqual(packageJson.license, 'MIT');
  assert.ok(packageJson.extensionDependencies.includes('Microchip.mplab-core-da'));
  assert.ok(packageJson.extensionDependencies.includes('ti-development-tools.ti-embedded-debug'));
  assert.strictEqual(tiXds110Module.isMspm0Device({ uid: 'MSPM0G3507' }), true);
  assert.strictEqual(tiXds110Module.isMspm0Device({ familyUid: 'MSPM0L13XX' }), true);
  assert.strictEqual(tiXds110Module.isMspm0Device({ uid: 'STM32F756ZG' }), false);
  assert.strictEqual(tiXds110.tclQuote('/tmp/a b/app.elf'), '{/tmp/a b/app.elf}');
  const tiBackendSource = fs.readFileSync(path.join(__dirname, '..', 'c_ti_xds110_backend.js'), 'utf8');
  assert.match(tiBackendSource, /flash erase_sector 0 0 last/);
  assert.doesNotMatch(tiBackendSource, /['"]mspm0_mass_erase['"]/);
  assert.ok(packageJson.extensionDependencies.includes('Microchip.mplab-extensions-core'));
  assert.ok(packageJson.extensionDependencies.includes('Microchip.mplab-extensions-platforms'));
  assert.ok(packageJson.contributes.commands.some((item) =>
    item.command === 'mikrobusC.debugUnavailableXcCodegrip' &&
    item.enablement === 'false' && /Microchip programmers/.test(item.title)));
  assert.match(packageJson.description || '', /Embedded Rust and C development/i);
  const publicReadme = fs.readFileSync(path.join(__dirname, '..', 'readme.md'), 'utf8');
  assert.match(publicReadme, /# MikroBUS Embedded Tools/);
  assert.match(publicReadme, /# Rust support/);
  assert.match(publicReadme, /# C support/);
  assert.match(publicReadme, /\| Compiler family \| Architectures \/ MCU families \|/);
  assert.match(publicReadme, /\| Programmer \/ debugger \| Programming \| Debugging \|/);
  assert.strictEqual(/##?\s+v0\.|changelog/i.test(publicReadme), false);
  assert.strictEqual(fs.existsSync(path.join(__dirname, '..', 'LICENSE')), true);
  assert.strictEqual(packageJson.icon, 'media/mikrobus-module-3d-transparent.png');
  assert.strictEqual(
    packageJson.contributes.viewsContainers.activitybar.find((item) => item.id === 'mikrobusRust')?.icon,
    'media/mikrobus-module-3d-transparent.png'
  );
  assert.strictEqual(
    packageJson.contributes.commands.find((item) => item.command === 'mikrobusC.debug')?.icon,
    '$(debug-alt)'
  );
  assert.strictEqual(packageJson.activationEvents.includes('onDebug:mikrobus-mikroc-debug'), false);
  assert.strictEqual(packageJson.contributes.debuggers.some((item) => item.type === 'mikrobus-mikroc-debug'), false);
  assert.strictEqual(fs.existsSync(path.join(__dirname, '..', 'c_mikroc_debug.js')), false);
  assert.strictEqual(fs.existsSync(path.join(__dirname, '..', 'resources', 'mikrodap')), false);
  const disabledMikrocDebugCommand = packageJson.contributes.commands.find((item) => item.command === 'mikrobusC.debugUnavailableMikrocCodegrip');
  const disabledRenesasDebugCommand = packageJson.contributes.commands.find((item) => item.command === 'mikrobusC.debugUnavailableRenesasE2');
  assert.strictEqual(disabledMikrocDebugCommand?.enablement, 'false');
  assert.match(disabledMikrocDebugCommand?.title || '', /NECTO Studio/);
  assert.strictEqual(disabledRenesasDebugCommand?.enablement, 'false');
  assert.match(disabledRenesasDebugCommand?.title || '', /E2 and E2 Lite/);
  assert.strictEqual(
    packageJson.contributes.commands.find((item) => item.command === 'mikrobusRust.debugCurrentFile')?.icon,
    '$(debug-alt)'
  );
  assert.strictEqual(packageJson.contributes.commands.some((item) => item.command === 'mikrobusRust.dumpDebugVariables'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(packageJson.contributes.menus, 'view/title'), false);
  const extensionNavigationUiSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.strictEqual(extensionNavigationUiSource.includes('<button id="configureMcu"'), false);
  const rustConfiguratorUiSource = fs.readFileSync(path.join(__dirname, '..', 'mcu_configurator.js'), 'utf8');
  assert.strictEqual(rustConfiguratorUiSource.includes('id="showSetups"'), false);
  assert.strictEqual(rustConfiguratorUiSource.includes('id="showSetupsFromConfig"'), false);
  const cCompilerManagerHtml = packageManager.cManagerHtml('compiler');
  assert.strictEqual(cCompilerManagerHtml.includes('aria-label="Go to previous view"'), false);
  assert.strictEqual(cCompilerManagerHtml.includes('>Back</button>'), false);
  assert.ok(cCompilerManagerHtml.includes('data-manager="compiler"'));
  assert.ok(cCompilerManagerHtml.includes('id="installedCount"'));
  assert.ok(cCompilerManagerHtml.includes('id="missingCount"'));
  assert.strictEqual(Object.prototype.hasOwnProperty.call(packageJson.contributes.menus, 'debug/toolBar'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(packageJson.contributes.configuration.properties, 'mikrobusRust.dumpVariablesOnStop'), false);

  const rustCodegripDebug = rustMcu.rustCodegripCppDebugConfiguration(
    { mcuName: 'STM32F756ZG' },
    { sdkRoot: '/tmp/rust-sdk' },
    '/tmp/project/main.rs',
    '/tmp/rust-sdk/target/thumbv7em-none-eabi/debug/app',
    '/tmp/gcc/bin/arm-none-eabi-gdb',
    4242,
    'token-1'
  );
  assert.strictEqual(rustCodegripDebug.type, 'cppdbg');
  assert.strictEqual(rustCodegripDebug.request, 'launch');
  assert.strictEqual(rustCodegripDebug.MIMode, 'gdb');
  assert.strictEqual(rustCodegripDebug.miDebuggerServerAddress, '127.0.0.1:4242');
  assert.strictEqual(rustCodegripDebug.launchCompleteCommand, 'exec-continue');
  assert.strictEqual(rustCodegripDebug.__mikrobusCodegripRust, true);
  assert.strictEqual(rustCodegripDebug.__mikrobusRustSource, '/tmp/project/main.rs');
  assert.strictEqual(rustMcu.isCodegripRestartRequest({ type: 'request', command: 'restart' }), true);
  assert.strictEqual(rustMcu.isCodegripRestartRequest({ type: 'request', command: 'disconnect', arguments: { restart: true } }), true);
  assert.strictEqual(rustMcu.isCodegripFinalStopRequest({ type: 'request', command: 'disconnect', arguments: { restart: false } }), true);
  const rustProgressReports = [];
  const rustProgress = rustMcu.codegripProgressReporter({ report(value) { rustProgressReports.push(value); } }, 'Programming');
  rustProgress(10);
  rustProgress(42);
  rustProgress(30);
  rustProgress(100);
  assert.deepStrictEqual(rustProgressReports.map((item) => item.increment), [0, 10, 32, 0, 58]);
  assert.strictEqual(rustProgressReports[rustProgressReports.length - 1].message, 'Programming: 100%');
  const rustConfiguratorHtmlSource = fs.readFileSync(path.join(__dirname, '..', 'mcu_configurator.js'), 'utf8');
  assert.ok(
    rustConfiguratorHtmlSource.indexOf('Programmer<select id="programmerSelect"') <
    rustConfiguratorHtmlSource.indexOf('Clock (MHz)<input id="clockMhz"'),
    'Rust programmer selector must appear to the left of the clock value.'
  );
  assert.ok(rustConfiguratorHtmlSource.includes('id="mcuVendorFilter"'));
  assert.ok(rustConfiguratorHtmlSource.includes('id="boardVendorFilter"'));
  assert.ok(rustConfiguratorHtmlSource.includes('id="boardMcuVendorFilter"'));
  assert.ok(rustConfiguratorHtmlSource.includes('System clock and programmer'));
  const rustConfiguratorClientSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'mcu.js'), 'utf8');
  assert.ok(rustConfiguratorClientSource.includes('populateVendorFilter(mcuVendorFilter, state.mcus)'));
  assert.ok(rustConfiguratorClientSource.includes('populateVendorFilter(boardVendorFilter, state.boards)'));
  assert.ok(rustConfiguratorClientSource.includes('populateVendorFilter(boardMcuVendorFilter, state.boardMcuOptions)'));
  const cConfiguratorHtmlSource = fs.readFileSync(path.join(__dirname, '..', 'c_configurator.js'), 'utf8');
  assert.ok(cConfiguratorHtmlSource.includes('id="cMcuVendorFilter"'));
  assert.ok(cConfiguratorHtmlSource.includes('id="cBoardVendorFilter"'));
  assert.ok(cConfiguratorHtmlSource.includes('id="cBoardDeviceVendorFilter"'));
  const cConfiguratorClientSourceForFilters = fs.readFileSync(path.join(__dirname, '..', 'media', 'c_mcu.js'), 'utf8');
  assert.ok(cConfiguratorClientSourceForFilters.includes('populateVendorFilter(mcuVendorFilter, state.mcus)'));
  assert.ok(cConfiguratorClientSourceForFilters.includes('populateVendorFilter(boardVendorFilter, state.boards)'));
  assert.ok(cConfiguratorClientSourceForFilters.includes('populateVendorFilter(boardDeviceVendorFilter, state.boardDevices)'));
  assert.ok(packageJson.extensionDependencies.includes('RenesasElectronicsCorporation.renesas-debug'));
  assert.strictEqual(Boolean(packageJson.contributes?.configuration?.properties?.['mikrobusRust.rfpCliPath']), false);
  assert.ok(configuratorSource.includes('bareMetalOnly'));
  assert.ok(configuratorSource.includes('bareMetalRecommended'));
  assert.ok(configuratorClientSource.includes("'Bare metal' : 'mikroSDK'"));
  const databaseSource = fs.readFileSync(path.join(__dirname, '..', 'c_database.js'), 'utf8');
  assert.ok(databaseSource.includes('COALESCE(d.sdk_support, 0) AS sdkSupport'));
  assert.ok(!/function listDevices[\s\S]{0,900}WHERE COALESCE\(d\.sdk_support, 0\) = 1/.test(databaseSource));
  assert.ok(packageJson.activationEvents.includes('onCommand:mikrobusC.openCompilerPackages'));
  assert.ok(packageJson.contributes.commands.some((item) => item.command === 'mikrobusC.openCompilerPackages'));
  assert.ok(packageJson.activationEvents.includes('onCommand:mikrobusC.openDemoExamples'));
  assert.ok(packageJson.contributes.commands.some((item) => item.command === 'mikrobusC.openDemoExamples'));

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
    assert.ok(compatibilityText.includes('include(GNUInstallDirs)'));
    assert.ok(compatibilityText.includes('include(CMakePackageConfigHelpers)'));
    assert.ok(compatibilityText.includes('PREINIT_ROUTINE_PATH'));
    assert.ok(compatibilityText.includes('add_subdirectory'));
    assert.ok(compatibilityText.includes('function(core_install targetAlias)'));
    assert.ok(compatibilityText.includes('mikroeExportConfig.cmake.in'));
    assert.ok(compatibilityText.includes('macro(add_fosc_macro target)'));
    assert.ok(compatibilityText.includes('target_compile_definitions(${target} PUBLIC OSC_KHZ=${OSC_KHZ})'));
    assert.ok(fs.existsSync(path.join(compatibilityRoot, 'mikroeExportConfig.cmake.in')));

    const smokeRoot = path.join(infraRoot, 'smoke');
    const smokeBuild = path.join(infraRoot, 'smoke-build');
    fs.mkdirSync(smokeRoot, { recursive: true });
    fs.writeFileSync(path.join(smokeRoot, 'CMakeLists.txt'), [
      'cmake_minimum_required(VERSION 3.20)',
      'project(mikrobus_compat_smoke VERSION 1 LANGUAGES C)',
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
      'file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/consumer.c" "#ifndef OSC_KHZ\n#error OSC_KHZ_not_propagated\n#endif\nvoid consumer(void) {}\n")',
      'add_library(core_dummy STATIC "${CMAKE_CURRENT_BINARY_DIR}/dummy.c")',
      'add_library(MikroC.Core ALIAS core_dummy)',
      'add_fosc_macro(core_dummy)',
      'get_target_property(_core_interface_defs core_dummy INTERFACE_COMPILE_DEFINITIONS)',
      'if(NOT "OSC_KHZ=64000" IN_LIST _core_interface_defs)',
      '  message(FATAL_ERROR "OSC_KHZ was not exported by MikroC.Core: ${_core_interface_defs}")',
      'endif()',
      'add_library(sdk_consumer STATIC "${CMAKE_CURRENT_BINARY_DIR}/consumer.c")',
      'target_link_libraries(sdk_consumer PRIVATE core_dummy)',
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
      `-DPREINIT_ROUTINE_PATH=${preinitRoot}`,
      '-DOSC_KHZ=64000'
    ], { encoding: 'utf8' });
    if (cmake.error && cmake.error.code === 'ENOENT') {
      process.stdout.write('CMake compatibility smoke test skipped: cmake not found.\n');
    } else {
      assert.strictEqual(cmake.status, 0, `${cmake.stdout}\n${cmake.stderr}`);
      const cmakeBuild = childProcess.spawnSync('cmake', ['--build', smokeBuild, '--target', 'sdk_consumer'], { encoding: 'utf8' });
      assert.strictEqual(cmakeBuild.status, 0, `${cmakeBuild.stdout}\n${cmakeBuild.stderr}`);
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
  assert.strictEqual(catalog.resolveDirect({ kind: 'shared', name: 'cmake', version: 'necto-live' }).downloadUrl,
    'https://software-update.mikroe.com/NECTOStudio7/live/cmake/linux/cmake.7z');
  assert.strictEqual(catalog.codegripUrlForPlatform('win32'),
    'https://s3-us-west-2.amazonaws.com/software-update.mikroe.com/Codegrip/live/codegrip_gdb_server/win/codegrip_gdb_server.7z');
  assert.strictEqual(catalog.codegripUrlForPlatform('darwin'),
    'https://s3-us-west-2.amazonaws.com/software-update.mikroe.com/Codegrip/live/codegrip_gdb_server/mac/codegrip_gdb_server.7z');
  assert.strictEqual(catalog.codegripUrlForPlatform('linux'),
    'https://s3-us-west-2.amazonaws.com/software-update.mikroe.com/Codegrip/live/codegrip_gdb_server/linux/codegrip_gdb_server.7z');
  assert.strictEqual(catalog.codegripVersionForPlatform('linux'), '1.1.12');
  assert.strictEqual(catalog.codegripVersionForPlatform('win32'), '1.1.12');
  assert.strictEqual(catalog.codegripVersionForPlatform('darwin'), '1.1.9');
  assert.strictEqual(catalog.programmerToolAsset('pickitbasic_tool_support').url,
    'https://packs.download.microchip.com/Microchip.PICkitBasic_TP.2.0.469.atpack');
  assert.strictEqual(catalog.programmerToolAsset('PICkit 4').version, '3.0.2732');
  assert.strictEqual(catalog.programmerToolAsset('PICkit 5').version, '3.0.1208');
  assert.strictEqual(catalog.programmerToolAsset('PKOB4').version, '2.0.1881');
  assert.strictEqual(catalog.programmerToolAsset('PowerDebugger').version, '1.9.1199');
  assert.strictEqual(catalog.programmerToolAsset('EDBG').version, '1.7.1191');
  assert.strictEqual(catalog.programmerToolAsset('ICD4').version, '3.0.2524');
  assert.strictEqual(catalog.programmerToolAsset('Debugger Simulation'), undefined);
  assert.strictEqual(catalog.programmerToolAsset('mikroProg for ARM'), undefined);
  assert.strictEqual(catalog.resolveDirect({ kind: 'programmer', name: 'pickit4_tool_support' }).downloadUrl,
    'https://packs.download.microchip.com/Microchip.PICkit4_TP.3.0.2732.atpack');

  assert.strictEqual(microchip.isMicrochipProgrammer({ uid: 'pickit4', name: 'PICkit 4', installerPackage: 'pickit4_tool_support' }), true);
  assert.strictEqual(microchip.isMicrochipProgrammer({ uid: 'gdb_general', name: 'GDB General' }), false);
  assert.strictEqual(microchip.isMicrochipProgrammer({ uid: 'mikroprog_arm', name: 'mikroProg for ARM', installerPackage: 'mikroprog_arm' }), false);
  assert.strictEqual(microchip.toolName({ name: 'PICkit4 Tool Support', installerPackage: 'pickit4_tool_support' }), 'PICkit 4');
  assert.strictEqual(microchip.toolName({ name: 'ICD4', installerPackage: 'icd4_tool_support' }), 'ICD 4');
  assert.strictEqual(microchip.toolName({ name: 'PowerDebugger', installerPackage: 'powerdebugger_tool_support' }), 'Power Debugger');
  assert.strictEqual(microchip.recommendedInterface({ device: { mcuName: 'PIC32MZ2048EFH144' } }), 'ICSP');
  assert.strictEqual(microchip.recommendedInterface({ device: { mcuName: 'dsPIC33EP512MU810' } }), 'ICSP');
  assert.strictEqual(microchip.recommendedInterface({ device: { mcuName: 'PIC18F47K42' } }), 'ICSP');
  assert.strictEqual(microchip.recommendedInterface({ device: { mcuName: 'ATSAMD51J20A' } }), 'SWD');
  assert.strictEqual(microchip.recommendedInterface({ device: { mcuName: 'ATxmega128A1U' } }), 'PDI');
  assert.strictEqual(microchip.recommendedInterface({ device: { mcuName: 'AVR128DA48' } }), 'UPDI');
  const mplabProgram = microchip.programConfiguration({
    name: 'PIC32MZ PICkit 5',
    metadata: { device: { mcuName: 'PIC32MZ2048EFH144' }, programmer: { name: 'PICkit 5', packageName: 'pickit5_tool_support' } }
  }, '/tmp/app.hex', 'mplab-program-test');
  assert.strictEqual(mplabProgram.type, 'mplab-core-da');
  assert.strictEqual(mplabProgram.request, 'launch');
  assert.strictEqual(mplabProgram.program, '/tmp/app.hex');
  assert.strictEqual(mplabProgram.noDebug, true);
  assert.strictEqual(mplabProgram.device, 'PIC32MZ2048EFH144');
  assert.strictEqual(mplabProgram.tool, '${command:pickTool}');
  assert.strictEqual(mplabProgram.__mikrobusExpectedMicrochipTool, 'PICkit 5');
  assert.strictEqual(mplabProgram.interface, 'ICSP');
  const mplabAttach = microchip.attachConfiguration({
    name: 'PIC32MZ ICD4',
    metadata: { device: { mcuName: 'PIC32MZ2048EFH144' }, programmer: { name: 'ICD4', packageName: 'icd4_tool_support' } }
  }, '/tmp/app.elf', 'mplab-debug-test');
  assert.strictEqual(mplabAttach.request, 'attach');
  assert.strictEqual(mplabAttach.program, '/tmp/app.elf');
  assert.strictEqual(mplabAttach.stopAtConnect, true);
  assert.strictEqual(mplabAttach.tool, '${command:pickTool}');
  assert.strictEqual(mplabAttach.__mikrobusExpectedMicrochipTool, 'ICD 4');
  const mplabPinned = microchip.programConfiguration({
    name: 'Pinned PICkit 5',
    microchipProfile: { serial: 'ABC123', tool: 'PICkit 5', interface: 'ICSP' },
    metadata: { device: { mcuName: 'PIC32MZ2048EFH144' }, programmer: { name: 'PICkit 5', packageName: 'pickit5_tool_support' } }
  }, '/tmp/app.hex', 'mplab-pinned-test');
  assert.strictEqual(mplabPinned.tool, 'PICkit 5');
  assert.strictEqual(mplabPinned.serial, 'ABC123');
  const mplabDebug = microchip.debugConfiguration({
    name: 'PIC32MZ PICkit 5 Debug',
    metadata: { device: { mcuName: 'PIC32MZ2048EFH144' }, programmer: { name: 'PICkit 5', packageName: 'pickit5_tool_support' } }
  }, '/tmp/app.elf', 'mplab-debug-launch-test');
  assert.strictEqual(mplabDebug.request, 'launch');
  assert.strictEqual(mplabDebug.noDebug, false);
  assert.strictEqual(mplabDebug.stopOnEntry, true);
  const usbFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mikrobus-mplab-usb-'));
  try {
    const sysRoot = path.join(usbFixture, 'sys');
    const devRoot = path.join(usbFixture, 'dev');
    const sysDevice = path.join(sysRoot, '1-1');
    const devNode = path.join(devRoot, '001', '002');
    fs.mkdirSync(sysDevice, { recursive: true });
    fs.mkdirSync(path.dirname(devNode), { recursive: true });
    fs.writeFileSync(path.join(sysDevice, 'idVendor'), '04d8\n');
    fs.writeFileSync(path.join(sysDevice, 'idProduct'), '1234\n');
    fs.writeFileSync(path.join(sysDevice, 'busnum'), '1\n');
    fs.writeFileSync(path.join(sysDevice, 'devnum'), '2\n');
    fs.writeFileSync(path.join(sysDevice, 'manufacturer'), 'Microchip Technology Inc.\n');
    fs.writeFileSync(path.join(sysDevice, 'product'), 'MPLAB PICkit 5\n');
    fs.writeFileSync(path.join(sysDevice, 'serial'), 'TEST123\n');
    fs.writeFileSync(devNode, 'usb');
    const usbStatus = microchip.linuxUsbStatus('PICkit 5', sysRoot, devRoot);
    assert.strictEqual(usbStatus.present, true);
    assert.strictEqual(usbStatus.accessible, true);
    assert.strictEqual(usbStatus.matching[0].serial, 'TEST123');
    assert.strictEqual(usbStatus.matching[0].node, devNode);
  } finally {
    fs.rmSync(usbFixture, { recursive: true, force: true });
  }
  assert.strictEqual(setup.isSupportedProgrammer({ uid: 'pickit5', name: 'PICkit 5', installerPackage: 'pickit5_tool_support' }), true);
  assert.strictEqual(setup.isSupportedProgrammer({ uid: 'debugger_simulation', name: 'Debugger Simulation' }), false);
  assert.strictEqual(cConfigurator.isSupportedProgrammer({ uid: 'pickit4', name: 'PICkit 4', installerPackage: 'pickit4_tool_support' }), true);

  const downloadableProgrammers = packageManager.programmerSpecsFromRows([
    { uid: 'codegrip', name: 'CODEGRIP', installerPackage: 'codegrip_gdb_server' },
    { uid: 'pickit4', name: 'PICkit 4', installerPackage: 'pickit4_tool_support' },
    { uid: 'gdb_general', name: 'GDB General', installerPackage: '' },
    { uid: 'debugger_simulation', name: 'Debugger Simulation', installerPackage: '' },
    { uid: 'mikroprog_arm', name: 'mikroProg for ARM', installerPackage: 'mikroprog_arm' },
    { uid: 'segger_jlink', name: 'SEGGER J-Link', installerPackage: '' }
  ]);
  assert.strictEqual(downloadableProgrammers.length, 2);
  assert.strictEqual(typeof packageManagerModule.programmerPackageSpec, 'function');
  assert.strictEqual(packageManagerModule.programmerPackageSpec({ uid: 'pickit5-db-row', name: 'PICkit 5', packageName: 'pickit5_tool_support' }).name, 'pickit5_tool_support');
  assert.ok(downloadableProgrammers.some((item) => item.name === 'codegrip_gdb_server'));
  assert.ok(downloadableProgrammers.some((item) => item.name === 'pickit4_tool_support'));
  assert.strictEqual(packageManager.archiveNameFromUrl(
    'https://packs.download.microchip.com/Microchip.PICkit4_TP.3.0.2732.atpack',
    { name: 'pickit4_tool_support' }
  ), 'Microchip.PICkit4_TP.3.0.2732.atpack');
  assert.strictEqual(catalog.hostPackageSegment('darwin'), 'mac');
  assert.match(catalog.managedBuildToolAsset('cmake', 'win32', 'x64').url, /cmake-3\.31\.12-windows-x86_64\.zip$/);
  assert.match(catalog.managedBuildToolAsset('cmake', 'darwin', 'arm64').url, /cmake-3\.31\.12-macos-universal\.tar\.gz$/);
  assert.match(catalog.managedBuildToolAsset('ninja', 'linux', 'x64').url, /ninja-linux\.zip$/);
  assert.match(catalog.managedBuildToolAsset('ninja', 'linux', 'arm64').url, /ninja-linux-aarch64\.zip$/);
  assert.match(catalog.managedBuildToolAsset('ninja', 'win32', 'x64').url, /ninja-win\.zip$/);
  assert.match(catalog.managedBuildToolAsset('ninja', 'win32', 'arm64').url, /ninja-winarm64\.zip$/);
  assert.match(catalog.managedBuildToolAsset('ninja', 'darwin', 'arm64').url, /ninja-mac\.zip$/);
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

  const tiXds110Source = fs.readFileSync(path.join(__dirname, '..', 'c_ti_xds110_backend.js'), 'utf8');
  assert.ok(tiXds110Source.includes("'mspm0_board_reset'"));
  assert.ok(tiXds110Source.includes("'shutdown'"));
  assert.ok(!tiXds110Source.includes('verify reset exit'));
  const cSetupSource = fs.readFileSync(path.join(__dirname, '..', 'c_setup.js'), 'utf8');
  assert.ok(cSetupSource.includes('microchip.debugConfiguration(setup, debugElf, debugInstanceId)'));
  assert.ok(cSetupSource.includes('Programming configuration for debug'));
  const cDatabaseSource = fs.readFileSync(path.join(__dirname, '..', 'c_database.js'), 'utf8');
  const cMcuUiSource = fs.readFileSync(path.join(__dirname, '..', 'media', 'c_mcu.js'), 'utf8');
  const cPackageManagerSource = fs.readFileSync(path.join(__dirname, '..', 'c_package_manager.js'), 'utf8');
  assert.ok(cSetupSource.includes('codegripCatalog.resolveDevice(setupMcuName(setup), token)'));
  assert.ok(cSetupSource.includes('mcu: setupMcuName(setup)'));
  assert.ok(cSetupSource.includes("if (looksLikeIntelHex(elf)) return finalize(path.resolve(elf));"));
  assert.ok(cSetupSource.includes('defines.push(`#define ${mcuName}`)'));
  assert.ok(!cSetupSource.includes('codegripCatalog.resolveDevice(setup.metadata.device.uid, token)'));
  assert.ok(cDatabaseSource.includes('sdkConfig.MCU_NAME = mcuName'));
  assert.ok(cDatabaseSource.includes("sdkConfig._MSDK_MCU_CARD_NAME_ = deviceConfig._MSDK_MCU_CARD_NAME_"));
  assert.ok(cDatabaseSource.includes('preferredGenericBoardForDb'));
  assert.ok(cMcuUiSource.includes("appendCell(row, mcu.mcuName || mcu.uid, 'mcuNameCell')"));
  assert.ok(cMcuUiSource.includes("device.mcuName || device.uid"));
  assert.ok(cMcuUiSource.includes('Bare metal is the default, but a mapped mikroSDK is available'));
  assert.ok(cPackageManagerSource.includes("return openEnvironmentPackages(context, kind)"));
  assert.ok(cPackageManagerSource.includes("environmentViewKind"));
  assert.ok(cPackageManagerSource.includes("Package files are still present after uninstall"));
  assert.ok(cPackageManagerSource.includes("lower.endsWith('.atpack')"));
  assert.ok(cPackageManagerSource.includes('programmerSpecsFromRows(db.listProgrammerInstallerPackages(context))'));
  assert.ok(!cPackageManagerSource.includes('general_packages_assets/${encodeURIComponent(packageName)}.7z'));

  const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.ok(extensionSource.includes('/Codegrip/live/codegrip_gdb_server/mac/codegrip_gdb_server.7z'));
  assert.ok(!extensionSource.includes('/NECTOStudio7/development/codegrip/'));
  assert.ok(extensionSource.includes("return URLS.codegrip[process.platform]"));
  assert.ok(cSetupSource.includes("managedBuildToolPackageSpec('cmake')"));
  assert.ok(cSetupSource.includes("managedBuildToolPackageSpec('ninja')"));
  assert.ok(cSetupSource.includes('Visual Studio Build Tools commonly ships both CMake and Ninja'));
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
