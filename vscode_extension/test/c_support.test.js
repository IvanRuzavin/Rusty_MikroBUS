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
  ProgressLocation: { Notification: 15 }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const setup = require('../c_setup')._test;
  const database = require('../c_database')._test;
  const catalog = require('../c_package_catalog')._test;
  const packageManager = require('../c_package_manager')._test;
  const codegrip = require('../codegrip_backend')._test;
  const codegripCatalog = require('../c_codegrip_catalog');
  const rustMcu = require('../mcu_configurator')._test;

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
    assert.ok(packageManager.environmentSpecs().some((item) => item.name === 'gcc_arm_compiler'));
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
      c: process.execPath, cxx: process.execPath, asm: process.execPath,
      adapter: { language: 'GNU' }
    }, {
      compatibilityModuleRoot: toolchainRoot,
      infrastructureRoot: toolchainRoot,
      installPrefix: toolchainRoot
    });
    const toolchainText = fs.readFileSync(toolchainFile, 'utf8');
    assert.ok(toolchainText.includes('add_compile_definitions(PREINIT_SUPPORTED)'));
  } finally {
    fs.rmSync(toolchainRoot, { recursive: true, force: true });
  }

  assert.strictEqual(setup.C_BUILD_SUPPORT_VERSION, 11);

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
  assert.strictEqual(catalog.resolveDirect({ kind: 'sdk', name: 'mikrosdk', version: '2.19.1' }).downloadUrl,
    'https://github.com/IvanRuzavin/Rusty_MikroBUS/releases/download/v0.0.1/C_sdk.7z');

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
