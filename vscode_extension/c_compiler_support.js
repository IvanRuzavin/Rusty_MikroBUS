'use strict';

const process = require('process');

// Compiler package URLs are managed standalone assets. Linux mikroC uses the
// existing per-family compiler packages directly. The optional aggregate
// mikroc_compilers.7z bundle is only a non-Linux fallback because it contains
// Windows/macOS/Linux binaries in one archive; it is never downloaded on Linux.
// ARM GCC keeps the already-proven xPack asset used by the extension because
// that package is byte-layout compatible with Compilers.c_compiler/cxx_compiler.

const MIKROC_BUNDLE_URL = 'https://github.com/IvanRuzavin/Rusty_MikroBUS/releases/download/v0.0.1/mikroc_compilers.7z';
const MIKROC_BUNDLE_ASSETS = Object.freeze({
  mikroc_arm: {
    version: '0.0.1',
    installRelativePath: 'compilers/mikroc/arm/mikroc',
    payloadSubdir: 'ARM/mikroC',
    url: MIKROC_BUNDLE_URL
  },
  mikroc_pic: {
    version: '0.0.1',
    installRelativePath: 'compilers/mikroc/pic/mikroc',
    payloadSubdir: 'PIC/mikroC',
    url: MIKROC_BUNDLE_URL
  },
  mikroc_pic32: {
    version: '0.0.1',
    installRelativePath: 'compilers/mikroc/pic32/mikroc',
    payloadSubdir: 'PIC32/mikroC',
    url: MIKROC_BUNDLE_URL
  },
  mikroc_dspic: {
    version: '0.0.1',
    installRelativePath: 'compilers/mikroc/dspic/mikroc',
    payloadSubdir: 'dsPIC/mikroC',
    url: MIKROC_BUNDLE_URL
  },
  mikroc_avr: {
    version: '0.0.1',
    installRelativePath: 'compilers/mikroc/avr/mikroc',
    payloadSubdir: 'AVR/mikroC',
    url: MIKROC_BUNDLE_URL
  }
});

const LINUX_COMPILER_ASSETS = Object.freeze({
  gcc_riscv_compiler: {
    version: '10.2.1',
    installRelativePath: 'compilers/gcc/riscv',
    url: 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/gcc/riscv/linux/riscv32-unknown-elf-gcc.7z'
  },
  microchip_xc8_compiler: {
    version: '2.46.0',
    installRelativePath: 'compilers/xc8',
    url: 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/xc8/linux/xc8.7z'
  },
  microchip_xc32_compiler: {
    version: '4.35.0',
    installRelativePath: 'compilers/xc32',
    url: 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/xc32/linux/xc32.7z'
  },
  mikroc_arm: {
    version: '3.0.0',
    installRelativePath: 'compilers/mikroc/arm/mikroc',
    url: 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/mikroc/arm/linux/mikroc.7z'
  },
  microchip_xc16_compiler: {
    version: '2.10.0',
    installRelativePath: 'compilers/xc16',
    url: 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/xc16/linux/xc16.7z'
  },
  llvm_clang_compiler: {
    version: '18.0.0',
    installRelativePath: 'compilers/clang',
    url: 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/clang/linux/clang.7z'
  },
  mikroc_pic: {
    version: '3.0.0',
    installRelativePath: 'compilers/mikroc/pic/mikroc',
    url: 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/mikroc/pic/linux/mikroc.7z'
  },
  mikroc_dspic: {
    version: '3.0.0',
    installRelativePath: 'compilers/mikroc/dspic/mikroc',
    url: 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/mikroc/dspic/linux/mikroc.7z'
  },
  gcc_rx_compiler: {
    version: '14.2.0.202607',
    installRelativePath: 'compilers/gcc/rx',
    url: 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/gcc/rx/linux/rx-elf-gcc.7z'
  },
  llvm_rl78_compiler: {
    version: '17.0.1.202606',
    installRelativePath: 'compilers/llvm/rl78-s3',
    url: 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/llvm/rl78/linux/llvm-rl78-elf.7z'
  },
  // These two package names follow the same NECTO live compiler layout as the
  // supplied ARM/PIC/dsPIC mikroC links. They are separate compiler packages
  // in Compilers.installer_package.
  mikroc_pic32: {
    version: '3.0.0',
    installRelativePath: 'compilers/mikroc/pic32/mikroc',
    url: 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/mikroc/pic32/linux/mikroc.7z'
  },
  mikroc_avr: {
    version: '3.0.0',
    installRelativePath: 'compilers/mikroc/avr/mikroc',
    url: 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/mikroc/avr/linux/mikroc.7z'
  }
});

const ARM_GCC_VERSION = '14.2.1-1.1';
function armGccAsset() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') {
    const file = `xpack-arm-none-eabi-gcc-${ARM_GCC_VERSION}-win32-x64.zip`;
    return { version: ARM_GCC_VERSION, installRelativePath: 'compilers/gcc/arm', url: `https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/download/v${ARM_GCC_VERSION}/${file}` };
  }
  if (process.platform === 'linux') {
    const file = `xpack-arm-none-eabi-gcc-${ARM_GCC_VERSION}-linux-${arch}.tar.gz`;
    return { version: ARM_GCC_VERSION, installRelativePath: 'compilers/gcc/arm', url: `https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/download/v${ARM_GCC_VERSION}/${file}` };
  }
  if (process.platform === 'darwin') {
    const file = `xpack-arm-none-eabi-gcc-${ARM_GCC_VERSION}-darwin-${arch}.tar.gz`;
    return { version: ARM_GCC_VERSION, installRelativePath: 'compilers/gcc/arm', url: `https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/download/v${ARM_GCC_VERSION}/${file}` };
  }
  return undefined;
}

function compilerAsset(installerPackage) {
  const name = String(installerPackage || '').trim();
  if (!name) return undefined;
  if (name === 'gcc_arm_compiler') return armGccAsset();
  // On Linux use the existing per-family mikroC package directly. The aggregate
  // bundle is only needed on Windows/macOS where this extension has no separate
  // first-party family URLs configured.
  if (process.platform === 'linux') return LINUX_COMPILER_ASSETS[name];
  if (MIKROC_BUNDLE_ASSETS[name]) return MIKROC_BUNDLE_ASSETS[name];
  return undefined;
}

// CompilerToDevice is the compatibility authority. This table only describes
// how to invoke the host compiler once a compatible compiler row is selected.
const COMPILER_ADAPTERS = Object.freeze({
  gcc_arm_none_eabi: {
    family: 'gnu-arm', language: 'GNU', cmakeAsmViaCCompiler: true,
    executableNames: { c:['arm-none-eabi-gcc'], cxx:['arm-none-eabi-g++'], asm:['arm-none-eabi-as'], gdb:['arm-none-eabi-gdb'], objcopy:['arm-none-eabi-objcopy'] }
  },
  'xpack-riscv-none-embed-gcc': {
    family: 'gnu-riscv', language: 'GNU', cmakeAsmViaCCompiler: true,
    executableNames: { c:['riscv32-unknown-elf-gcc'], cxx:['riscv32-unknown-elf-g++'], asm:['riscv32-unknown-elf-as'], gdb:['riscv32-unknown-elf-gdb'], objcopy:['riscv32-unknown-elf-objcopy'] }
  },
  'clang-llvm': {
    family: 'clang-arm', language: 'CLANG', cmakeAsmViaCCompiler: true,
    executableNames: { c:['clang'], cxx:['clang++','clang'], asm:['llvm-as'], gdb:['lldb-mi'], objcopy:['llvm-objcopy'] }
  },
  'clang-llvm-riscv': {
    family: 'clang-riscv', language: 'CLANG', cmakeAsmViaCCompiler: true,
    executableNames: { c:['clang'], cxx:['clang++','clang'], asm:['llvm-as'], gdb:['lldb-mi'], objcopy:['llvm-objcopy'] }
  },
  mchp_xc8: {
    family: 'xc8', language: 'XC8', cmakeAsmViaCCompiler: true,
    executableNames: { c:['xc8-cc'], cxx:[], asm:[], gdb:['pic8-gdb'], objcopy:['avr-objcopy'], ar:['xc8-ar'], ranlib:[] }
  },
  mchp_xc16: {
    family: 'xc16', language: 'XC16', cmakeAsmViaCCompiler: true,
    executableNames: { c:['xc16-gcc'], cxx:['xc16-g++'], asm:['xc16-as'], gdb:['pic16-gdb'], objcopy:['xc16-bin2hex'], ar:['xc16-ar'], ranlib:['xc16-ranlib'] }
  },
  mchp_xc32: {
    family: 'xc32', language: 'XC32', cmakeAsmViaCCompiler: true,
    executableNames: { c:['xc32-gcc'], cxx:['xc32-g++'], asm:['xc32-as'], gdb:['pic32-gdb'], objcopy:['xc32-bin2hex','xc32-objcopy'], ar:['xc32-ar'], ranlib:['xc32-ranlib'] }
  },
  'llvm-rl78-elf': {
    family: 'llvm-rl78', language: 'LLVM', cmakeAsmViaCCompiler: true,
    executableNames: { c:['clang'], cxx:['clang++'], asm:['llvm-as'], gdb:['rl78-elf-gdb'], objcopy:['llvm-objcopy','rl78-elf-objcopy'] }
  },
  'rx-elf-gcc': {
    family: 'gnu-rx', language: 'GNU', cmakeAsmViaCCompiler: true,
    executableNames: { c:['rx-elf-gcc'], cxx:['rx-elf++','rx-elf-g++'], asm:['rx-elf-as'], gdb:['rx-elf-gdb'], objcopy:['rx-elf-objcopy'] }
  },
  mikrocarm: {
    family: 'mikroc-arm', language: 'MikroC', cmakeAsmViaCCompiler: true,
    executableNames: { c:['mikroCARM','mikroc','mikroC'], cxx:[], asm:[], gdb:[], objcopy:[] }
  },
  mikrocpic: {
    family: 'mikroc-pic', language: 'MikroC', cmakeAsmViaCCompiler: true,
    executableNames: { c:['mikroCPIC1618','mikroc','mikroC'], cxx:[], asm:[], gdb:[], objcopy:[] }
  },
  mikrocpic32: {
    family: 'mikroc-pic32', language: 'MikroC', cmakeAsmViaCCompiler: true,
    executableNames: { c:['mikroCPIC32','mikroc','mikroC'], cxx:[], asm:[], gdb:[], objcopy:[] }
  },
  mikrocdspic: {
    family: 'mikroc-dspic', language: 'MikroC', cmakeAsmViaCCompiler: true,
    executableNames: { c:['mikroCdsPIC','mikroc','mikroC'], cxx:[], asm:[], gdb:[], objcopy:[] }
  },
  mikrocavr: {
    family: 'mikroc-avr', language: 'MikroC', cmakeAsmViaCCompiler: true,
    executableNames: { c:['mikroCAvr','mikroc','mikroC'], cxx:[], asm:[], gdb:[], objcopy:[] }
  }
});

const CORE_METADATA_COMPILER_LABEL = Object.freeze({
  gcc_arm_none_eabi: 'GCC',
  'xpack-riscv-none-embed-gcc': 'GCC',
  'clang-llvm': 'Clang',
  'clang-llvm-riscv': 'Clang',
  mchp_xc8: 'XC8',
  mchp_xc16: 'XC16',
  mchp_xc32: 'XC32',
  'llvm-rl78-elf': 'LLVM',
  'rx-elf-gcc': 'gcc',
  mikrocarm: 'mikroC AI',
  mikrocpic: 'mikroC AI',
  mikrocpic32: 'mikroC AI',
  mikrocdspic: 'mikroC AI',
  mikrocavr: 'mikroC AI'
});

function adapterFor(compilerUid) { return COMPILER_ADAPTERS[String(compilerUid || '')]; }
function isGccCompiler(compilerOrUid) {
  const uid = typeof compilerOrUid === 'string' ? compilerOrUid : compilerOrUid?.uid;
  return String(adapterFor(uid)?.family || '').startsWith('gnu-');
}
function preferredCompiler(compilers, requestedUid) {
  const items = Array.isArray(compilers) ? compilers : [];
  if (!items.length) return undefined;
  const requested = String(requestedUid || '').trim();
  if (requested) {
    const explicit = items.find((item) => String(item?.uid || '') === requested);
    if (explicit) return explicit;
  }
  return items.find(isGccCompiler) || items[0];
}
function supportedCompilerUids() { return Object.keys(COMPILER_ADAPTERS); }
function coreMetadataCompilerLabel(compilerUid) { return CORE_METADATA_COMPILER_LABEL[String(compilerUid || '')]; }

function riscvArchitectureFlags() { return ['-march=rv32imac', '-mabi=ilp32']; }

// Renesas RX application code must use the same ABI/ISA switches as the
// selected NECTO core package. In particular the RXv3/RX26T core is built with
// -misa=v3 -fpu -mlittle-endian-data, not a guessed -mcpu=<older-family> alias.
// Keep this helper for older RXv1/RXv2 packages while using the authoritative
// RXv3 switches from rx_gcc_r5f526tfc/cmake/coreUtils.cmake.
function rxArchitectureFlags(metadata = {}) {
  const family = String(metadata?.device?.familyUid || '').trim().toUpperCase();
  const core = String(metadata?.sdkConfig?.CORE_NAME || '').trim().toUpperCase();
  if (core === 'RXV3' || family === 'RX26T') return ['-misa=v3', '-fpu', '-mlittle-endian-data'];
  const exactFamilyMap = {
    RX13T: 'rx13t',
    RX140: 'rx140',
    RX66T: 'rx66t',
    RX72T: 'rx72t'
  };
  const mapped = exactFamilyMap[family];
  if (mapped) return [`-mcpu=${mapped}`];
  if (core === 'RXV2') return ['-mcpu=rx64m'];
  if (core === 'RXV1') return ['-mcpu=rx600'];
  return [];
}

function rxCompilerFlags(metadata = {}, declaredCoreFlags = []) {
  const arch = rxArchitectureFlags(metadata);
  const core = String(metadata?.sdkConfig?.CORE_NAME || '').trim().toUpperCase();
  const family = String(metadata?.device?.familyUid || '').trim().toUpperCase();
  const declared = Array.isArray(declaredCoreFlags) ? declaredCoreFlags.filter(Boolean) : [];
  if (declared.length) {
    // Use the selected RX core package's set_flags() output verbatim for both
    // compile and compiler-driver link invocations. The core package remains
    // the source of truth; link-only extension requirements are layered on top.
    const linkExtras = ['-Wl,--gc-sections'];
    if (core === 'RXV3' || family === 'RX26T') linkExtras.push('-Wl,-u,_PowerON_Reset_PC');
    return { compile: [...declared], link: [...declared, ...linkExtras] };
  }
  if (core === 'RXV3' || family === 'RX26T') {
    const compile = [
      '-Wno-incompatible-pointer-types',
      '-fno-builtin',
      '-ffunction-sections',
      '-fdata-sections',
      '-fomit-frame-pointer',
      '-Og',
      '-fdiagnostics-parseable-fixits',
      '-fno-strict-aliasing',
      '-fno-common',
      ...arch
    ];
    // Fallback for older/atypical RX packages that do not expose set_flags().
    // The RX core archive contains startup/renesas/<mcu>.S. Suppress GCC's
    // libgloss crt0.o and mark _PowerON_Reset_PC undefined so ld extracts that
    // startup member from MikroC.Core even when the user's own CMakeLists only
    // links the core library.
    const link = [
      '-nostartfiles',
      '-Og',
      ...arch,
      '-Wl,--gc-sections',
      '-Wl,-u,_PowerON_Reset_PC'
    ];
    return { compile, link };
  }
  return {
    compile: [...arch, '-ffunction-sections', '-fdata-sections'],
    link: [...arch, '-Wl,--gc-sections']
  };
}

function rl78CompilerFlags() {
  // Mirrors RL78/LLVM coreUtils.cmake::set_flags() from the NECTO core package.
  // Keep the application ABI/code model aligned with the prebuilt core.
  return [
    '-Wno-int-conversion',
    '-Wno-incompatible-function-pointer-types',
    '-fno-builtin',
    '-ffunction-sections',
    '-fdata-sections',
    '-fomit-frame-pointer',
    '-mmirror-source-common',
    '-mcommon-rom',
    '-fno-aligned-allocation',
    '-mnear-code',
    '-mnear-data',
    '-Og',
    '-fdiagnostics-parseable-fixits',
    '-fno-strict-aliasing',
    '-mcpu=s2',
    '-mdisable-mda'
  ];
}


function microchipProcessorName(family, mcuName) {
  const raw = String(mcuName || '').trim();
  if (!raw) return '';
  const familyId = String(family || '').toLowerCase();
  // The database stores marketing-style names (PIC18F..., PIC24F...,
  // dsPIC33..., PIC32...), while the XC command-line drivers use the
  // abbreviated processor identifier.  This mirrors the forms emitted by
  // NECTO/MPLAB: 18F97J94, 24FJ..., 33CK..., 32MZ....
  if (familyId === 'xc8') {
    return raw.replace(/^PIC(?=1[0268])/i, '');
  }
  if (familyId === 'xc16') {
    return raw
      .replace(/^dsPIC(?=3[03])/i, '')
      .replace(/^PIC(?=24)/i, '');
  }
  if (familyId === 'xc32') {
    return raw.replace(/^PIC(?=32)/i, '');
  }
  return raw;
}

function compilerSpecificFlags(adapter, metadata, armFlags = [], compatibilityFlags = [], coreDeclaredFlags = []) {
  const family = String(adapter?.family || '');
  const mcu = String(metadata?.sdkConfig?.MCU_NAME || metadata?.device?.mcuName || metadata?.device?.uid || '').trim();
  if (family === 'gnu-arm') {
    return {
      compile: [...armFlags, ...compatibilityFlags, '-fms-extensions', '-ffunction-sections', '-fdata-sections', '-fno-common', '-fmessage-length=0'],
      link: [...armFlags, '--specs=nosys.specs', '-Wl,-gc-sections,--print-memory-usage']
    };
  }
  if (family === 'clang-arm') {
    return {
      compile: ['--target=arm-none-eabi', ...armFlags, ...compatibilityFlags, '-fms-extensions', '-ffunction-sections', '-fdata-sections', '-fno-common'],
      link: ['--target=arm-none-eabi', ...armFlags, '-Wl,--gc-sections']
    };
  }
  if (family === 'gnu-riscv') {
    const arch = riscvArchitectureFlags();
    return { compile:[...arch, '-ffunction-sections', '-fdata-sections', '-fno-common'], link:[...arch, '-Wl,--gc-sections'] };
  }
  if (family === 'clang-riscv') {
    const arch = riscvArchitectureFlags();
    return { compile:['--target=riscv32-unknown-elf', ...arch, '-ffunction-sections', '-fdata-sections'], link:['--target=riscv32-unknown-elf', ...arch, '-Wl,--gc-sections'] };
  }
  if (family === 'gnu-rx') return rxCompilerFlags(metadata, coreDeclaredFlags);
  if (family === 'llvm-rl78') {
    const compile = rl78CompilerFlags();
    // RL78 LLVM selects its compiler-runtime variant at link time from the
    // CPU/memory-model/MDA options. Keep those options identical to the core
    // compilation or Clang may pull an ABI-incompatible runtime (notably the
    // S2 hardware-MDA multiply/divide helpers). The mikroSDK startup file owns
    // __rl78_init/__rl78_fini and the init/fini array runners, so also suppress
    // Clang's bundled crt0.o.
    const link = [
      '-nostartfiles',
      '-mcpu=s2',
      '-mdisable-mda',
      '-mnear-code',
      '-mnear-data',
      '-mmirror-source-common',
      '-mcommon-rom',
      '-Og'
    ];
    return { compile, link };
  }
  if (family === 'xc8') {
    const processor = microchipProcessorName(family, mcu);
    return { compile: processor ? [`-mcpu=${processor}`] : [], link: processor ? [`-mcpu=${processor}`] : [] };
  }
  if (family === 'xc16') {
    const processor = microchipProcessorName(family, mcu);
    return { compile: processor ? [`-mcpu=${processor}`] : [], link: processor ? [`-mcpu=${processor}`] : [] };
  }
  if (family === 'xc32') {
    const processor = microchipProcessorName(family, mcu);
    return { compile: processor ? [`-mprocessor=${processor}`] : [], link: processor ? [`-mprocessor=${processor}`] : [] };
  }
  // LLVM-RL78 and mikroC packages carry architecture selection in their own
  // compiler/core integration. Do not inject GNU ARM flags into them.
  return { compile: [], link: [] };
}

module.exports = {
  compilerAsset,
  adapterFor,
  isGccCompiler,
  preferredCompiler,
  supportedCompilerUids,
  coreMetadataCompilerLabel,
  compilerSpecificFlags,
  rxArchitectureFlags,
  rxCompilerFlags,
  rl78CompilerFlags,
  microchipProcessorName,
  COMPILER_ADAPTERS,
  LINUX_COMPILER_ASSETS,
  ARM_GCC_VERSION
};
