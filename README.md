# Rusty MikroBUS

Rusty MikroBUS is an embedded C and Rust development environment built around mikroSDK hardware data and reusable target configurations.

The project combines a VS Code extension, managed C and Rust development environments, board and MCU metadata, programmer/debugger integration, and project setup automation so applications can be prepared for supported targets without carrying a full SDK copy inside every project.

## Main capabilities

- MCU and development-board configuration from a shared hardware database
- Reusable target setups with clock and target configuration
- Board, MCU-card, shield, and mikroBUS mapping support
- Managed C toolchains with CMake/Ninja-based builds
- SEGGER J-Link programming and debugging workflow
- MIKROE CODEGRIP USB discovery, programming, erase, and GDB debugging
- Extension-managed SDK, core, database, BSP, runner, and tool packages
- Rust Analyzer project integration
- Build, flash, debug, and erase actions directly from VS Code

## How the SDK is handled

The SDK is maintained separately from user projects.

The **Development Environment** installs and updates the packages used by the extension under its managed storage location. These packages include the Rust mikroSDK sources, MCU core files, hardware database, board support data, and the development/programming tools that can be managed directly by the extension.

When a hardware setup is created, the extension builds a **reusable SDK workspace** for that setup. It starts from the managed SDK layers and prepares only the target-specific configuration needed for the selected MCU or board, including:

- compilation target configuration;
- MCU register and clock configuration;
- startup and linker files;
- MCU headers and core initialization;
- family-specific pin mappings and HAL implementations;
- board/shield information when applicable.

The resulting setup is stored centrally and can be reused by multiple projects. Updating or rebuilding a setup does not require placing the full mikroSDK source tree in the application repository.

## Applying a setup to a project

A project only needs a `Cargo.toml` in its root before a saved setup can be applied.

**Apply Setup to Project** connects the opened project to the reusable SDK configuration instead of copying the SDK into the project. The extension creates a small VS Code binding file and updates Rust Analyzer so the editor resolves the correct SDK workspace and Rust target.

Conceptually, the flow is:

```text
Managed packages
      │
      ├── database
      ├── BSP
      ├── Rust mikroSDK
      └── MCU core
      │
      ▼
Hardware Setup Configuration
      │
      ▼
Reusable target SDK workspace
      │
      ├── MCU / board configuration
      ├── clock and register values
      ├── selected programmer
      └── optional board + shield mapping
      │
      ▼
Apply Setup to Project
      │
      ├── .vscode/mikrobus-rust.json
      ├── Rust Analyzer configuration
      └── mikrobus.rs when required
      │
      ▼
Build / Program / Debug
```

For board configurations with a supported mikroBUS shield, applying the setup also generates `mikrobus.rs` next to the project application source. A board without a shield can still use the same setup flow without generating that file.

## Hardware configuration

Hardware support is driven by the project database rather than being hard-coded into the VS Code UI.

The configuration flow can represent:

- direct MCU setups;
- boards with a directly assigned MCU;
- boards that use replaceable MCU cards;
- optional compatible shields;
- supported programmer/debugger relationships.

This allows new hardware relationships to be delivered through the database and BSP packages while keeping the extension workflow consistent.

## Programmer and debugger support

Status legend: **✅ Supported** means the complete programming/debugging workflow is implemented for the applicable targets. **🟡 Partial** means the integration is available with the restrictions described in the notes. **—** means there is no dedicated integration in that environment.

| Programmer / debugger | C Environment | Rust Environment | Current scope |
| --- | :---: | :---: | --- |
| **MIKROE CODEGRIP** | 🟡 Partial | ✅ Supported | C: programming and erase are supported for compatible database targets; debugging is available only for supported GDB-capable toolchains and is intentionally disabled for XC8/XC16/XC32 and mikroC setups. Rust: USB discovery, programming, erase, and GDB debugging are supported. |
| **SEGGER J-Link** | ✅ Supported | ✅ Supported | Programming/erase through J-Link Commander and source debugging through J-Link GDB Server + Cortex-Debug. |
| **probe-rs (auto-detect)** | — | ✅ Supported | Universal Rust backend for programming, erase, and debugging with probes supported by probe-rs. This covers ST-Link, CMSIS-DAP, J-Link, and other compatible probes without requiring a dedicated database programmer entry. |
| **Microchip MPLAB tools** — PICkit 4, PICkit 5, ICD 4, PKOB4, Power Debugger, EDBG, PICkit Basic | ✅ Supported | — | C-only integration through the MPLAB Debug Adapter for compatible XC8/XC16/XC32 targets. Programming, erase, and hardware-debug launch are implemented. |
| **Renesas RFP + E2 / E2 Lite** | 🟡 Partial | — | Programming and erase use `rfp-cli`. Hardware debugging is available only when the setup uses an E2 or E2 Lite connection and the Renesas Debug extension/support files are installed. Other RFP connections remain programming-only. |
| **TI XDS110 (LaunchPad onboard)** | ✅ Supported | — | C support for MSPM0 LaunchPads, including MSPM0C1, MSPM0G3, MSPM0L1, and MSPM0L2 families. Uses TI OpenOCD/XDS110 for flash, erase, and Cortex-Debug sessions; successful flash ends with an explicit nRST board reset. |

Other programmer/debugger entries that may exist in the NECTO database are not automatically considered supported by this extension. For example, MPLAB Snap, ICD 5, ICE 4, JTAGICE3, mEDBG/PKOB nano, the mikroProg families, and simulator entries are currently not implemented by the C adapter unless a dedicated backend is added.

## Compiler support

Compiler status describes the toolchain integration itself. Debug availability can additionally depend on the selected programmer/debugger, target family, and host-side vendor tools.

| Compiler / toolchain | C Environment | Rust Environment | Notes |
| --- | :---: | :---: | --- |
| **GNU Arm Embedded GCC** | ✅ Supported | — | ARM C/C++ compilation; also supplies the GDB client used by several ARM debug workflows. |
| **Clang/LLVM for ARM** | ✅ Supported | — | ARM C/C++ compilation. The extension can resolve/install GNU Arm GDB as the MI debugger while keeping Clang as the compiler. |
| **GNU RISC-V GCC** | ✅ Supported | — | RISC-V C/C++ compilation for database-compatible targets. |
| **Clang/LLVM for RISC-V** | ✅ Supported | — | RISC-V C/C++ compilation for database-compatible targets. |
| **Microchip XC8** | ✅ Supported | — | PIC/AVR C compilation. Hardware debugging requires a supported Microchip MPLAB programmer/debugger; CODEGRIP debugging is not enabled for XC8. |
| **Microchip XC16** | ✅ Supported | — | PIC24/dsPIC C compilation. Hardware debugging requires a supported Microchip MPLAB programmer/debugger; CODEGRIP debugging is not enabled for XC16. |
| **Microchip XC32** | ✅ Supported | — | PIC32 C compilation. Hardware-debug builds use the XC32 debugger-specific link path and a supported Microchip MPLAB programmer/debugger; CODEGRIP debugging is not enabled for XC32. |
| **GCC for Renesas RX** | ✅ Supported | — | RX C/C++ compilation. Hardware debugging is integrated through Renesas E2/E2 Lite. |
| **LLVM for Renesas RL78** | ✅ Supported | — | RL78 C/C++ compilation. Hardware debugging is integrated through Renesas E2/E2 Lite. |
| **mikroC AI for ARM** | 🟡 Partial | — | Build and programming workflows are supported. VS Code source debugging is not currently available through the CODEGRIP path. |
| **mikroC AI for PIC / PIC32 / dsPIC / AVR** | 🟡 Partial | — | Build and programming workflows are supported. VS Code source debugging is not currently available through the CODEGRIP path. |
| **Rust (`rustc` + Cargo via rustup)** | — | ✅ Supported | Rust compilation is driven by the target triple stored in the Rust hardware database and integrated with Rust Analyzer. |

Managed compiler-package availability is host-dependent. The current package catalog provides the broadest managed C toolchain coverage on Linux; ARM GCC is also managed on Windows/macOS, and mikroC has a non-Linux bundle fallback.

## MCU support coverage

The counts below are derived from the C and Rust hardware databases rather than being hard-coded into the README.

For the **C Environment**, the main count represents distinct MCU identities that have at least one compiler supported by the extension and a matching MCU core package. Board and MCU-card aliases are collapsed to their underlying MCU. The **C + mikroSDK** column is the subset also marked with `sdk_support = 1`, meaning a full mikroSDK setup is available; the remaining C targets are primarily used through the bare-metal/core workflow.

For the **Rust Environment**, the count comes directly from the Rust database `MCU` table joined to its `Family` vendor information.

| Vendor | C Environment | C + mikroSDK | Rust Environment |
| --- | ---: | ---: | ---: |
| ABOV | 210 | 0 | 0 |
| Analog Devices | 1 | 0 | 0 |
| ArteryTek | 275 | 0 | 0 |
| Atmel | 208 | 90 | 0 |
| Cmsemicon | 107 | 0 | 0 |
| Geehy | 153 | 0 | 0 |
| GigaDevice | 663 | 14 | 0 |
| HDSC | 131 | 0 | 0 |
| Holtek | 353 | 0 | 0 |
| Infineon | 1,832 | 0 | 0 |
| Microchip | 2,069 | 911 | 0 |
| MindMotion | 157 | 0 | 0 |
| NXP | 1,212 | 124 | 0 |
| Nuvoton | 801 | 3 | 0 |
| Renesas | 905 | 561 | 0 |
| SONiX | 69 | 0 | 0 |
| Silicon Labs | 1,217 | 0 | 0 |
| STMicroelectronics | 1,308 | 1,014 | 326 |
| Texas Instruments | 125 | 71 | 0 |
| Toshiba | 312 | 18 | 0 |
| **Total** | **12,108** | **2,806** | **326** |

The current Rust database contains STM32 **F2 (38)**, **F4 (155)**, **F7 (77)**, and **L1 (56)** devices, for a total of **326 STMicroelectronics MCUs**.

## SEGGER J-Link workflow

For a J-Link setup, the extension uses the selected target configuration with the Rust embedded tooling flow for programming, erase, and debugging.

![Setup Configuration and J-Link programming](docs/media/jlink-rust.gif)

## MIKROE CODEGRIP workflow

CODEGRIP is integrated as both a development-environment package and a programmer/debugger.

During setup configuration, the extension can start `CodegripGdbServer`, scan for connected USB CODEGRIP devices, and save the selected device information with the reusable hardware setup.

For target operations, the extension uses the CODEGRIP server and MCU packs for programming and erase. Debugging starts a CODEGRIP GDB server and attaches VS Code through Cortex-Debug, while keeping the connection and target configuration associated with the saved setup.

![Setup Configuration, CODEGRIP detection and programming](docs/media/codegrip-rust.gif)

## Development Environment

The VS Code extension provides a single view for checking the host development environment.

Project-specific packages such as the database, BSP, Rust SDK, MCU core, CODEGRIP package, OpenOCD, ARM GNU tools, C compilers, CMake, and Ninja can be managed by the extension where a managed package is available. Host-level dependencies such as Rust, probe-rs, SEGGER software, USB access rules, vendor debug extensions/drivers, and other build prerequisites are detected and presented with the appropriate installation path for the current platform.

This keeps setup reproducible while avoiding unnecessary system-wide assumptions for project-owned packages.

## Installing the VS Code extension

1. Download the packaged `.vsix` from the repository releases.
2. In VS Code, open **Extensions**.
3. Choose **Install from VSIX...**.
4. Reload VS Code.
5. Open the **MikroBUS Rust** Activity Bar view.
6. Open **Development Environment** and resolve the required packages and tools.
7. Create a hardware setup and apply it to a Rust or C project.

## Repository

The repository contains the VS Code integration and the packages used to construct the managed C and Rust embedded development environments.
