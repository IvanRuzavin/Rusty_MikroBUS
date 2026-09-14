# MikroBUS Embedded Tools

**MikroBUS Embedded Tools** brings embedded **Rust** and **C** development for mikroBUS-based hardware into Visual Studio Code.

The extension can create reusable MCU/board setups, manage the required SDK/toolchain packages, build projects, program target hardware, erase devices and start hardware debugging without requiring a separate IDE for the normal development workflow.

It is designed around the MIKROE/NECTO package ecosystem and mikroBUS hardware model while keeping the actual development experience inside VS Code.

## Main features

- Configure a project from an **MCU** or a **development board / MCU card**.
- Keep reusable configured setups in the VS Code sidebar.
- Separate **Rust Environment** and **C Environment** workflows.
- Automatically manage databases, compiler packages, MCU core packages, BSP packages and programmer tools.
- Build, clean, flash, erase and debug directly from VS Code.
- Use **CODEGRIP**, **SEGGER J-Link**, **probe-rs**, **Microchip PICkit/ICD/EDBG-class tools** and **Renesas Flash Programmer** where applicable.
- Browse and install **Click Board examples** and **Demo examples** for both Rust and C.
- Shared managed installation root for Rust and C packages.
- Host support for **Linux, Windows and macOS**, with platform-aware package/tool discovery.

---

# Rust support

Rust projects use Cargo/rustup together with the generated MCU core, linker, startup, pin-mapping and mikroSDK configuration for the selected device.

## Rust toolchain

| Component | Support | Notes |
|---|---|---|
| **Rust / rustc** | Supported | Installed/managed through the normal Rust toolchain (`rustup`). |
| **Cargo** | Supported | Used for project build and dependency management. |
| **Rust embedded targets** | Database-driven | The required target triple is taken from the selected MCU metadata and installed with `rustup target add`. |
| **rust-analyzer** | Supported | Workspace configuration is generated for the selected embedded target/setup. |

## Rust programmers and debuggers

| Programmer / debugger | Programming | Debugging | Availability |
|---|:---:|:---:|---|
| **probe-rs (Auto-detect)** | ✅ | ✅ | Always available in Rust and selected by default. Uses probe-rs-supported debug probes such as ST-Link, J-Link and CMSIS-DAP-compatible probes. |
| **MIKROE CODEGRIP** | ✅ | ✅ | Shown when supported for the selected MCU by the programmer database. |
| **SEGGER J-Link** | ✅ | ✅ | Shown when supported for the selected MCU by the programmer database. |

## Rust MCU vendors

Rust MCU availability is intentionally **database-driven rather than hard-coded in the extension**. The shared SDK is installed once, while the MCU core is resolved from `MCU.SYSTEM_LIB` and downloaded on demand from the fixed **Rust Core Packages** release. The package catalog maps each system library to an architecture-qualified archive such as `arm_stm32f_2xx.7z`.

| Coverage | Status |
|---|---|
| **STMicroelectronics / STM32** | Supported and used by the current Rust build/flash/debug workflow. |
| **Other MCU vendors present in `database.db`** | Supported when the database entry has the required Rust target/HAL/BSP data and its `SYSTEM_LIB` is present in the Rust Core Packages catalog. New architecture packages are picked up without hard-coding them in the extension. |
| **Board / MCU-card vendors** | Database-driven; board and compatible MCU/card relationships are resolved from the current Rust database. |

The vendor filter in **Configure MCU or Board** always reflects the vendors that are actually available in the installed Rust database, so the UI remains accurate as device coverage grows.

---

# C support

C setups follow the same package-oriented model used by NECTO: select a device, choose a compatible compiler and programmer, install the required core/BSP/SDK packages, and generate a reusable CMake setup.

The current NECTO-compatible database is the compatibility authority: the extension only offers compiler/device combinations that are mapped for the selected MCU.

For **Microchip XC8/XC16/XC32**, MCU JSON files that expose symbolic `config_words` are handled natively. For XC32, the compiler-encoded `.config_<address>` sections are read directly from the generated configuration object and merged into the final Intel HEX, so custom mikroSDK linker scripts cannot discard the configuration words. Numeric `config_registers` definitions remain supported for older package formats.

## C compilers

| Compiler family | Architectures / MCU families | Build | Debug notes |
|---|---|:---:|---|
| **GNU Arm Embedded** | ARM Cortex-M | ✅ | GDB-based debugging with supported programmers. |
| **GNU RISC-V** | RISC-V | ✅ | GDB-based flow where the selected device/programmer supports it. |
| **LLVM/Clang ARM** | ARM Cortex-M | ✅ | Uses Clang for build and an ARM GDB client for embedded debug sessions. |
| **LLVM/Clang RISC-V** | RISC-V | ✅ | Clang build flow with compatible debug backend. |
| **Microchip XC8** | PIC 8-bit / supported XC8 targets | ✅ | Debugging is supported through compatible Microchip hardware programmers. CODEGRIP remains available for programming but its Debug button is intentionally disabled for XC setups. |
| **Microchip XC16** | dsPIC / PIC24 | ✅ | Debugging is supported through compatible Microchip hardware programmers. CODEGRIP remains available for programming but its Debug button is intentionally disabled for XC setups. |
| **Microchip XC32** | PIC32 and supported 32-bit Microchip targets | ✅ | Debugging is supported through compatible Microchip hardware programmers. CODEGRIP remains available for programming but its Debug button is intentionally disabled for XC setups. |
| **mikroC AI for ARM** | ARM | ✅ | CODEGRIP programming supported; VS Code CODEGRIP debugging is intentionally disabled — use NECTO Studio for mikroC debugging. |
| **mikroC AI for PIC** | PIC | ✅ | Programming support follows the selected programmer mapping. |
| **mikroC AI for PIC32** | PIC32 | ✅ | Programming support follows the selected programmer mapping. |
| **mikroC AI for dsPIC** | dsPIC / PIC24 | ✅ | Programming support follows the selected programmer mapping. |
| **mikroC AI for AVR** | AVR | ✅ | Programming support follows the selected programmer mapping. |
| **LLVM RL78** | Renesas RL78 | ✅ | E2/E2 Lite hardware debugging supported through the Renesas debug tooling. |
| **GNU RX** | Renesas RX | ✅ | E2/E2 Lite hardware debugging supported through the Renesas debug tooling. |

## C programmers and debuggers

| Programmer / debugger | Programming | Debugging | Notes |
|---|:---:|:---:|---|
| **MIKROE CODEGRIP** | ✅ | Conditional | Database-driven MCU support. VS Code debug is disabled for **XC8/XC16/XC32 + CODEGRIP** (use a Microchip programmer for XC debugging) and for **mikroC + CODEGRIP** (use NECTO Studio). |
| **Microchip PICkit 4 / PICkit 5** | ✅ | ✅ | Uses the official **Debug Adapter for MPLAB** and its connected-tool picker. On Linux the extension checks USB access and can install the required udev rule when permissions are missing. |
| **Microchip ICD 4** | ✅ | ✅ | Uses the official **Debug Adapter for MPLAB** and automatic connected-tool discovery. |
| **Microchip PKOB4 / Power Debugger / EDBG / PICkit Basic mappings** | ✅ | ✅ | Exposed when the selected database row maps the tool-support package to the MCU/compiler; programming/erase/debug use the MPLAB adapter backend and connected-tool discovery. |
| **SEGGER J-Link** | ✅ | ✅ | Uses J-Link Commander / J-Link GDB Server where supported. |
| **Renesas Flash Programmer (RFP)** | ✅ | Conditional | UART programming is supported. Hardware debugging is enabled only for **E2** and **E2 Lite** profiles. |
| **Renesas E2 / E2 Lite** | ✅ | ✅ | RL78/RX debug integration uses the Renesas tooling/support files. |
| **Renesas UART boot / UART emulator profile** | ✅ | ❌ | Debug remains visible but disabled; use E2 or E2 Lite for hardware debugging. |

## C MCU vendors

C device coverage comes from the current NECTO-compatible database and the available core/compiler packages. The extension includes dedicated handling for the following major vendor/family groups and also follows additional compatible database mappings as they are added.

| MCU vendor | Families / examples handled by the extension |
|---|---|
| **STMicroelectronics** | STM32 ARM Cortex-M families. |
| **Microchip** | PIC, PIC18, PIC24, dsPIC, PIC32, AVR/ATmega/ATtiny and supported SAM/XC32 targets. |
| **Renesas** | RA/ARM devices through normal ARM toolchains, plus dedicated **RL78** and **RX** compiler/programmer/debug flows. |
| **NXP / Freescale** | ARM/Kinetis-class devices when present in the compatibility database and selected programmer mappings. |
| **Texas Instruments** | Supported ARM devices such as TM4C-class targets when present in the database/programmer catalog. |
| **GigaDevice** | GD32-class ARM devices when present in the database/programmer catalog. |
| **Other NECTO database vendors** | Available automatically when a compatible compiler, core package and supported programmer mapping are present. |

The MCU and board configuration screens provide a **Vendor** filter generated from the live database, which is the definitive list for the currently installed package set.

---

# Development Environment

The extension can manage the packages needed by a setup rather than requiring every tool to be installed manually.

### Rust Environment

- Rust toolchain / Cargo
- probe-rs
- CODEGRIP programmer packages
- ARM GNU tools used by debugger/conversion flows
- Rust MCU database
- Rust mikroSDK
- MCU core packages
- MCU Card BSP packages
- Board and Shield BSP packages

### C Environment

- Compiler packages
- Programmer packages, including Microchip PICkit/ICD/EDBG tool-support packs
- CODEGRIP device/server packages
- MCU core packages
- Board and MCU-card BSP packages
- mikroSDK
- CMake and Ninja support, including managed Windows/macOS fallbacks
- NECTO-compatible device database

---

# Typical workflow

## Rust

1. Open **MikroBUS Embedded Tools** from the Activity Bar.
2. Select **Rust Environment**.
3. Open **Configure MCU or Board** and select the target hardware.
4. Select the programmer/debug backend and clock configuration.
5. Create the reusable setup and apply it to a workspace.
6. Build, Flash or Debug the current Rust project directly from the editor/extension actions.

## C

1. Open **MikroBUS Embedded Tools** from the Activity Bar.
2. Switch to **C Environment**.
3. Open **Development Environment** if compiler/programmer packages need to be installed or updated.
4. Create a setup from an MCU or board.
5. Select the compatible compiler and programmer offered by the database.
6. Build the setup and use **Build**, **Flash**, **Erase** or **Debug** from VS Code.

---

# Platform support

| Host OS | Status |
|---|---|
| **Linux** | ✅ Supported |
| **Windows** | ✅ Supported |
| **macOS** | ✅ Supported |

Some vendor tools are distributed separately and may still require their normal vendor installer, USB driver or license on the host system.

# Data and package sources

The extension uses MIKROE/NECTO-compatible package metadata and public package infrastructure for device databases, MCU cores, mikroSDK/BSP content and programmer support. Compatibility is resolved dynamically, so device/compiler/programmer availability can grow without requiring a hard-coded MCU list in the extension itself.

# License

This extension is released under the **MIT License**. See [LICENSE](LICENSE).

Third-party SDKs, compilers, programmer tools, device packs and downloaded vendor packages remain subject to their own licenses.

# Developer

**IvanRuzavin**

Repository: [IvanRuzavin/Rusty_MikroBUS](https://github.com/IvanRuzavin/Rusty_MikroBUS)
