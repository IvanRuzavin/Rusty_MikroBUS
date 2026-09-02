'use strict';

const process = require('process');

// Compiler package URLs are the NECTO live compiler assets supplied for Linux.
// ARM GCC keeps the already-proven xPack asset used by the extension because
// that package is byte-layout compatible with Compilers.c_compiler/cxx_compiler.
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
    installRelativePath: 'compilers/mikroc/arm',
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
    installRelativePath: 'compilers/mikroc/pic',
    url: 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/mikroc/pic/linux/mikroc.7z'
  },
  mikroc_dspic: {
    version: '3.0.0',
    installRelativePath: 'compilers/mikroc/dspic',
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
    installRelativePath: 'compilers/mikroc/pic32',
    url: 'https://software-update.mikroe.com/NECTOStudio7/live/compilers/mikroc/pic32/linux/mikroc.7z'
  },
  mikroc_avr: {
    version: '3.0.0',
    installRelativePath: 'compilers/mikroc/avr',
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
  return undefined;
}

function compilerAsset(installerPackage) {
  const name = String(installerPackage || '').trim();
  if (!name) return undefined;
  if (name === 'gcc_arm_compiler') return armGccAsset();
  if (process.platform === 'linux') return LINUX_COMPILER_ASSETS[name];
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
    executableNames: { c:['clang'], cxx:['clang++','clang'], asm:['llvm-as'], gdb:['lldb-mi','lldb'], objcopy:['llvm-objcopy'] }
  },
  'clang-llvm-riscv': {
    family: 'clang-riscv', language: 'CLANG', cmakeAsmViaCCompiler: true,
    executableNames: { c:['clang'], cxx:['clang++','clang'], asm:['llvm-as'], gdb:['lldb-mi','lldb'], objcopy:['llvm-objcopy'] }
  },
  mchp_xc8: {
    family: 'xc8', language: 'XC8', cmakeAsmViaCCompiler: true,
    executableNames: { c:['xc8-cc'], cxx:[], asm:[], gdb:['pic8-gdb'], objcopy:[] }
  },
  mchp_xc16: {
    family: 'xc16', language: 'XC16', cmakeAsmViaCCompiler: true,
    executableNames: { c:['xc16-gcc'], cxx:['xc16-g++'], asm:['xc16-as'], gdb:['pic16-gdb'], objcopy:['xc16-bin2hex'] }
  },
  mchp_xc32: {
    family: 'xc32', language: 'XC32', cmakeAsmViaCCompiler: true,
    executableNames: { c:['xc32-gcc'], cxx:['xc32-g++'], asm:['xc32-as'], gdb:['pic32-gdb'], objcopy:['xc32-bin2hex','xc32-objcopy'] }
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
    family: 'mikroc-arm', language: 'mikroC', cmakeAsmViaCCompiler: true,
    executableNames: { c:['mikroCARM','mikroc','mikroC'], cxx:[], asm:[], gdb:[], objcopy:[] }
  },
  mikrocpic: {
    family: 'mikroc-pic', language: 'mikroC', cmakeAsmViaCCompiler: true,
    executableNames: { c:['mikroCPIC1618','mikroc','mikroC'], cxx:[], asm:[], gdb:[], objcopy:[] }
  },
  mikrocpic32: {
    family: 'mikroc-pic32', language: 'mikroC', cmakeAsmViaCCompiler: true,
    executableNames: { c:['mikroCPIC32','mikroc','mikroC'], cxx:[], asm:[], gdb:[], objcopy:[] }
  },
  mikrocdspic: {
    family: 'mikroc-dspic', language: 'mikroC', cmakeAsmViaCCompiler: true,
    executableNames: { c:['mikroCdsPIC','mikroc','mikroC'], cxx:[], asm:[], gdb:[], objcopy:[] }
  },
  mikrocavr: {
    family: 'mikroc-avr', language: 'mikroC', cmakeAsmViaCCompiler: true,
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
function rxArchitectureFlags(coreName) {
  const core = String(coreName || '').toLowerCase();
  if (core.includes('rxv3')) return ['-mcpu=rxv3'];
  if (core.includes('rxv2')) return ['-mcpu=rxv2'];
  if (core.includes('rxv1')) return ['-mcpu=rx100'];
  return [];
}

function compilerSpecificFlags(adapter, metadata, armFlags = [], compatibilityFlags = []) {
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
      compile: ['--target=arm-none-eabi', ...armFlags, '-fms-extensions', '-ffunction-sections', '-fdata-sections', '-fno-common'],
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
  if (family === 'gnu-rx') {
    const arch = rxArchitectureFlags(metadata?.sdkConfig?.CORE_NAME);
    return { compile:[...arch, '-ffunction-sections', '-fdata-sections'], link:[...arch, '-Wl,--gc-sections'] };
  }
  if (family === 'xc8') return { compile: mcu ? [`-mcpu=${mcu}`] : [], link: mcu ? [`-mcpu=${mcu}`] : [] };
  if (family === 'xc16') return { compile: mcu ? [`-mcpu=${mcu}`] : [], link: mcu ? [`-mcpu=${mcu}`] : [] };
  if (family === 'xc32') return { compile: mcu ? [`-mprocessor=${mcu}`] : [], link: mcu ? [`-mprocessor=${mcu}`] : [] };
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
  COMPILER_ADAPTERS,
  LINUX_COMPILER_ASSETS,
  ARM_GCC_VERSION
};
