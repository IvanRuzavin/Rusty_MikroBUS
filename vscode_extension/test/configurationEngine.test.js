'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const {
  fieldId,
  computeCoreHeader,
  renderCargoTemplates,
  deriveModuleImplementations,
  createPaths,
  loadMcuDefinition,
  applyConfiguration,
  readManifest,
} = require('../src/configurationEngine');

const definition = {
  clock: '120',
  config_registers: [
    {
      key: 'CFG0', address: '40000000', fields: [
        { key: 'MODE', label: 'Mode', mask: '0x3', init: '0x1', settings: [{ label: 'A', value: '0x1' }, { label: 'B', value: '0x2' }] },
        { key: 'LOCK', mask: '0x80', hidden: true, init: '0x80' },
      ],
    },
  ],
  language_list: [{
    language: 'RUST',
    module_list: [
      { module_name: 'gpio', sub_modules: [{ sub_module_name: 'gpio_a', pin_map_features: ['pa0', 'pa1'] }] },
      { module_name: 'uart', sub_modules: [{ sub_module_name: 'uart_1', pin_map_features: ['tx', 'rx'] }] },
    ],
  }],
};

test('computeCoreHeader preserves register OR semantics and clock conversion', () => {
  const id = fieldId(definition.config_registers[0], definition.config_registers[0].fields[0], 0);
  const header = computeCoreHeader(definition, { [id]: '0x2' }, 120);
  assert.match(header, /ADDRESS_CFG0: u32 = 0x40000000/);
  assert.match(header, /VALUE_CFG0: u32 = 0x00000082/);
  assert.match(header, /FOSC_KHZ_VALUE: u32 = 120000/);
});

test('renderCargoTemplates expands pin features and module lists', () => {
  const rendered = renderCargoTemplates(
    definition,
    'gpio_a = [{gpio_a_features}]\nuart_1 = [{uart_1_features}]\n',
    'gpio=[{gpio}]\nuart=[{uart}]\nfamily="{family}"\n',
    'stm32f4'
  );
  assert.match(rendered.familyCargo, /"pa0","pa1"/);
  assert.match(rendered.familyCargo, /"tx","rx"/);
  assert.match(rendered.halCargo, /gpio=\["gpio_a"\]/);
  assert.match(rendered.halCargo, /family="stm32f4"/);
});

test('deriveModuleImplementations preserves original FAMILY positional mapping', () => {
  const result = deriveModuleImplementations({ raw: ['name', 'vendor', 'target', 'other', 'gpio_v2', 'adc_v1', 'i2c_v3', 'spi_v4', 'tim_v2', 'uart_v5'], named: {} });
  assert.deepEqual(result, { gpioPort: 'gpio_v2', adc: 'adc_v1', i2c: 'i2c_v3', spi: 'spi_v4', tim: 'tim_v2', uart: 'uart_v5' });
});

async function write(file, content = '// fixture\n') {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf8');
}

async function makeFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mikro-rust-test-'));
  const cfg = { corePath: 'core', sdkPath: 'sdk', databasePath: 'application/database/test.db', corePlatform: 'arm/stm32' };
  const paths = createPaths(root, cfg);
  const mcu = {
    name: 'STM32F407VG', vendor: 'ST', family: 'STM32F4', target: 'thumbv7em-none-eabihf', systemName: 'stm32f4_system',
    familyRecord: { raw: ['STM32F4','ST','thumbv7em-none-eabihf','x','gpio_v2','adc_v1','i2c_v3','spi_v4','tim_v2','uart_v5'], named: {} },
  };

  await write(path.join(paths.corePlatformRoot, 'mcu_definitions', `${mcu.name}.json`), JSON.stringify(definition));
  await write(path.join(paths.corePlatformRoot, 'memory', mcu.name, 'memory.x'), 'MEMORY {}\n');
  await write(path.join(paths.corePlatformRoot, 'startup', `${mcu.name.toLowerCase()}.s`), '.section .text\n');
  await write(path.join(paths.corePlatformRoot, 'mcu_headers', mcu.name, 'lib.rs'), 'pub const MCU:u32=1;\n');
  await write(path.join(paths.corePlatformRoot, 'reset.rs'));
  await write(path.join(paths.corePlatformRoot, 'system', mcu.systemName, 'init_clock.rs'));
  await write(path.join(paths.corePlatformRoot, 'Cargo.toml'), '[package]\nname="core"\n');
  await write(path.join(paths.corePlatformRoot, 'lib.rs'));
  await write(path.join(paths.corePlatformRoot, 'common_header.rs'));

  const pinRoot = path.join(paths.corePlatformRoot, 'pin_mappings');
  await write(path.join(pinRoot, 'stm32f4', 'src', 'pins.rs'));
  await write(path.join(pinRoot, 'stm32f4', 'Cargo_family_template.toml'), 'gpio_a=[{gpio_a_features}]\nuart_1=[{uart_1_features}]\n');
  await write(path.join(pinRoot, 'hal_ll_Cargo_template.toml'), 'family="{family}"\ngpio=[{gpio}]\nuart=[{uart}]\n');
  await write(path.join(paths.sdkRoot, '.cargo', 'template_config.toml'), '[build]\ntarget="{compiling_target}"\n');

  await write(path.join(paths.sdkPlatformRoot, 'gpio', 'hal_ll_gpio', 'gpio.rs'), '// gpio\n');
  await write(path.join(paths.sdkPlatformRoot, 'gpio', 'gpio_port', 'gpio_v2', 'gpio_port.rs'), '// gpio port v2\n');
  await write(path.join(paths.sdkPlatformRoot, 'adc', 'adc_v1', 'adc.rs'), '// adc v1\n');
  await write(path.join(paths.sdkPlatformRoot, 'i2c', 'i2c_v3', 'i2c_master.rs'), '// i2c v3\n');
  await write(path.join(paths.sdkPlatformRoot, 'spi', 'spi_v4', 'spi_master.rs'), '// spi v4\n');
  await write(path.join(paths.sdkPlatformRoot, 'tim', 'tim_v2', 'tim.rs'), '// tim v2\n');
  await write(path.join(paths.sdkPlatformRoot, 'uart', 'uart_v5', 'uart.rs'), '// uart v5\n');
  await write(path.join(paths.sdkPlatformRoot, 'one_wire', 'implementation_1', 'one_wire.rs'), '// one wire\n');
  await write(path.join(paths.sdkPlatformRoot, 'src', '.keep'), '');

  return { root, paths, mcu };
}

test('applyConfiguration reproduces the standalone configurator file pipeline', async t => {
  const { root, paths, mcu } = await makeFixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const { definition: loaded } = await loadMcuDefinition(paths, mcu.name);
  const id = fieldId(loaded.config_registers[0], loaded.config_registers[0].fields[0], 0);
  const manifest = await applyConfiguration({ paths, mcu, definition: loaded, selections: { [id]: '0x2' }, clockMhz: 120 });
  assert.equal(manifest.mcu.name, mcu.name);
  assert.equal((await readManifest(paths)).clockMhz, 120);
  assert.equal(await fsp.readFile(path.join(paths.sdkRoot, '.cargo', 'config.toml'), 'utf8'), '[build]\ntarget="thumbv7em-none-eabihf"\n');
  assert.match(await fsp.readFile(path.join(paths.sdkRoot, '.setup', 'core', 'src', 'core_header.rs'), 'utf8'), /0x00000082/);
  assert.equal(await fsp.readFile(path.join(paths.sdkPlatformRoot, 'src', 'uart.rs'), 'utf8'), '// uart v5\n');
  assert.match(await fsp.readFile(path.join(paths.sdkPlatformRoot, 'Cargo.toml'), 'utf8'), /family="stm32f4"/);
  assert.equal(await fsp.readFile(path.join(paths.sdkRoot, '.setup', 'sdk', 'src', 'pins.rs'), 'utf8'), '// fixture\n');

  // Reconfiguration should replace the active setup cleanly.
  await applyConfiguration({ paths, mcu, definition: loaded, selections: { [id]: '0x1' }, clockMhz: 100 });
  const second = await readManifest(paths);
  assert.equal(second.clockMhz, 100);
  assert.match(await fsp.readFile(path.join(paths.sdkRoot, '.setup', 'core', 'src', 'core_header.rs'), 'utf8'), /0x00000081/);
});
