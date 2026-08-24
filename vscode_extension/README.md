# MikroBUS Rust Tools for Visual Studio Code

> Detailed technical README for the current MikroBUS Rust Tools development implementation.
>
> The extension brings the NECTO Studio / mikroSDK-style MCU configuration workflow into Visual Studio Code: install and maintain the development environment, select an MCU from a database, configure clock/register settings, generate MCU-specific Rust setup files, save reusable setups, bind a setup to a Rust workspace, and build, flash, erase, and debug the currently opened Rust application.

## Version 0.0.15 highlights

- Saved MCU configurations now contain a complete reusable build workspace: Cargo metadata, DRV, HAL, target/LL layers, generated pin mappings, selected core, startup, linker script, MCU header, and clock setup.
- A setup can be applied to a normal source folder containing `main.rs`; the project no longer needs a copy of the SDK tree.
- Build, flash, and debug compile the active Rust source directly through the reusable setup, preserving the original source path for diagnostics and breakpoints.
- The debug toolbar now includes extension-owned **Step Out** (`Shift+F11`) and **Restart Debugger** (`Ctrl+Shift+F5`) controls. Restart first uses the probe-rs DAP restart request and automatically relaunches the same configuration if the adapter rejects it.
- On Windows, probe-rs DAP now runs directly over stdin/stdout instead of a temporary localhost TCP port, avoiding the port race and firewall dependency in the previous launch path.
- Whenever execution stops, all local/static/global scopes exposed by probe-rs are printed to the Debug Console. The same dump can be requested from the debug toolbar with **Print Variables to Debug Console**.
- `examples/ips_display_2/` now uses the supplied Nucleo-F412ZG mikroBUS 1 mapping.
- `examples/oled_c/` contains a complete SSD1351-based OLED C Click Rust driver and demo for the same mikroBUS 1 socket.

---

## Table of contents

1. [Overview](#overview)
2. [What the extension is trying to achieve](#what-the-extension-is-trying-to-achieve)
3. [Current architecture](#current-architecture)
4. [Compiler, programmer, debugger, SDK and core summary](#compiler-programmer-debugger-sdk-and-core-summary)
5. [Supported host platforms](#supported-host-platforms)
6. [Development environment setup](#development-environment-setup)
7. [Where packages are downloaded from](#where-packages-are-downloaded-from)
8. [Extension-managed storage layout](#extension-managed-storage-layout)
9. [Package update and uninstall behavior](#package-update-and-uninstall-behavior)
10. [MCU database and device catalog](#mcu-database-and-device-catalog)
11. [MCU configuration GUI](#mcu-configuration-gui)
12. [How register and clock configuration is generated](#how-register-and-clock-configuration-is-generated)
13. [What happens when a setup is built](#what-happens-when-a-setup-is-built)
14. [Generated `.setup` layout](#generated-setup-layout)
15. [Why HAL and DRV are not copied into `.setup`](#why-hal-and-drv-are-not-copied-into-setup)
16. [Configured setup manager](#configured-setup-manager)
17. [Applying a setup to a workspace](#applying-a-setup-to-a-workspace)
18. [Standalone/minimal Rust projects](#standaloneminimal-rust-projects)
19. [Build workflow](#build-workflow)
20. [Flash workflow](#flash-workflow)
21. [Erase workflow](#erase-workflow)
22. [F5 debugging and breakpoints](#f5-debugging-and-breakpoints)
23. [Keyboard shortcuts and editor actions](#keyboard-shortcuts-and-editor-actions)
24. [Rust Analyzer integration](#rust-analyzer-integration)
25. [Supported devices](#supported-devices)
26. [VS Code settings](#vs-code-settings)
27. [Commands contributed by the extension](#commands-contributed-by-the-extension)
28. [Typical end-to-end workflow](#typical-end-to-end-workflow)
29. [Important implementation details and current limitations](#important-implementation-details-and-current-limitations)
30. [Troubleshooting](#troubleshooting)
31. [Building the VSIX](#building-the-vsix)

---

# Overview

**MikroBUS Rust Tools** is a Visual Studio Code extension for configuring and using the Rust mikroSDK environment with supported MCUs.

The extension follows the same general architecture as the existing PyQt configuration tool and the NECTO Studio + mikroSDK workflow:

```text
MCU database
    +
MCU JSON definition
    +
MCU core package
    +
Rust mikroSDK
    +
selected clock/register values
        |
        v
Generated MCU setup
        |
        +--> Rust compilation target
        +--> startup/linker files
        +--> MCU register constants
        +--> pin mappings
        +--> family-specific low-level implementations
        |
        v
Rust application
        |
        +--> Build
        +--> Flash
        +--> Erase
        +--> F5 Debug
```

The extension has two main user interfaces:

- **MikroBUS Rust Activity Bar / sidebar** — development environment installation, detection, update and uninstall.
- **MCU Configuration editor page** — MCU catalog, clock/register configuration, configured setup management, workspace binding and project actions.

---

# What the extension is trying to achieve

The project model is intentionally small.

A user application can look approximately like this:

```text
blink/
├── Cargo.toml
└── src/
    └── main.rs
```

or, for a very small test-oriented workflow:

```text
blink/
└── gpio.rs
```

The application should **not** need its own copy of the complete mikroSDK, HAL, driver library, MCU headers, linker files, startup files or MCU database.

Those large/shared components are maintained once by the extension.

The selected setup supplies the target-specific information:

```text
Application source
        |
        v
Selected configured setup
  MCU = STM32F412RE
  Clock = 100 MHz
  Register selections = ...
        |
        v
Extension-managed SDK + core
        |
        v
Build / Flash / Debug
```

Changing from one MCU to another is intended to become primarily a configuration operation rather than a source-tree replacement operation.

---

# Current architecture

The current implementation contains the following layers:

```text
Visual Studio Code
|
+-- MikroBUS Rust extension
|   |
|   +-- Environment Setup sidebar
|   |   +-- package detection
|   |   +-- install
|   |   +-- update
|   |   +-- uninstall
|   |
|   +-- MCU Configuration webview
|   |   +-- MCU catalog
|   |   +-- register/clock configuration
|   |   +-- setup manager
|   |   +-- workspace binding
|   |
|   +-- Build/Flash/Erase commands
|   |
|   +-- probe-rs Debug Adapter integration
|
+-- Extension-managed packages
|   +-- database
|   +-- sdk
|   +-- core
|   +-- OpenOCD
|   +-- ARM GNU Toolchain
|
+-- System packages
    +-- Rust/rustup/cargo
    +-- probe-rs tools
    +-- USB driver/udev access
    +-- optional SEGGER J-Link/J-Flash
```

The extension requires **VS Code 1.101.0 or newer**. The MCU database layer uses Node's built-in `node:sqlite` API, so the extension intentionally targets the newer VS Code extension-host runtime.

---

# Compiler, programmer, debugger, SDK and core summary

This distinction is important because several packages are installed, but not all of them are used by the same execution path.

| Purpose | Current tool | How it is used |
|---|---|---|
| Rust package/build driver | **Cargo** | `cargo build`, temporary Cargo debug target, `cargo flash` |
| Rust compiler | **rustc**, installed through **rustup** | Compiles the application and SDK crates for the target triple selected by the MCU database |
| Rust target manager | **rustup** | `rustup target add <target>` when a setup is generated |
| Primary programmer | **probe-rs tools / cargo-flash** | `cargo flash --chip <MCU> --connect-under-reset` |
| Flash erase | **probe-rs** | `probe-rs erase --chip <MCU>` |
| Primary debugger | **probe-rs DAP server** | stdin/stdout DAP on Windows; localhost TCP DAP on Linux/macOS |
| USB probe support | **ST-Link / J-Link / CMSIS-DAP through probe-rs** | probe-rs communicates with the physical probe; Linux uses udev rules |
| Rust SDK | **Rusty_MikroBUS `sdk.7z`** | Permanent shared HAL/DRV/targets/application package structure |
| MCU core | **Rusty_MikroBUS `core.7z`** | MCU JSON definitions, memory files, startup, system initialization, pin mappings, headers |
| Device database | **`database_mikro_sdk_rust.db`** | MCU list, family, target, system library and family-specific implementation selection |
| Auxiliary ARM C toolchain | **xPack ARM GNU Toolchain 14.2.1-1.1** | Installed and managed by the extension, but **not used by the primary Rust `cargo build` path today** |
| Auxiliary debug server | **xPack OpenOCD 0.12.0-7** | Installed and managed for parity/future OpenOCD/GDB workflows; **F5 currently uses probe-rs instead** |
| Optional SEGGER tools | **J-Link / J-Flash** | Detected and lifecycle-guided, but the standard Flash/F5 commands currently use probe-rs rather than J-Flash |

## Important compiler clarification

The extension downloads an ARM GNU Toolchain package, but the current Rust application is **not compiled with `arm-none-eabi-gcc`**.

The primary build command is:

```bash
cargo build
```

Cargo invokes the Rust toolchain/rustc for the target selected from the database, for example:

```text
thumbv7m-none-eabi
thumbv7em-none-eabi
```

The ARM GNU Toolchain package is kept because it is useful for the broader embedded/debug toolchain and future OpenOCD/GDB workflows, and because it matches the direction of the original PyQt environment.

---

# Supported host platforms

## Windows

The current system-dependency profile is implemented for **Windows x64**.

The extension checks/uses:

- MSVC Build Tools
- Rust toolchain
- probe-rs
- ST-Link Windows driver
- SEGGER J-Link/J-Flash
- extension-managed OpenOCD
- extension-managed ARM GCC
- extension-managed database
- extension-managed Rust mikroSDK
- extension-managed core

The xPack OpenOCD and ARM GCC automatic download definitions currently use **Windows x64** assets.

## Linux

The current Linux profile supports:

- Linux x64
- Linux ARM64 for the managed xPack packages

The extension checks/uses:

- compiler/build prerequisites
- `pkg-config`
- libudev development files
- CMake
- Git
- curl
- 7-Zip-capable extraction
- Rust toolchain
- probe-rs
- probe-rs udev rules
- SEGGER J-Link/J-Flash if installed
- extension-managed OpenOCD
- extension-managed ARM GCC
- extension-managed database
- extension-managed Rust mikroSDK
- extension-managed core

## Other hosts

The UI can still show extension-managed package information, but the system dependency installation profile is currently explicitly implemented for Windows and Linux.

---

# Development environment setup

After installation, the extension contributes a **MikroBUS Rust** icon to the VS Code Activity Bar.

Opening it displays **Development environment setup** in the Primary Sidebar.

On the first activation of a new extension version, the extension scans the environment. If required packages are missing, it automatically reveals this setup view.

The page displays:

```text
Development environment setup

Platform: Linux x64 / Linux arm64 / Windows x64
Installed: N
Missing: M

Extension-managed root:
<path>

[Configure MCU] [Update managed] [Refresh]
```

Each dependency is represented by a card.

A missing package offers an installation action where supported:

```text
OpenOCD
Status: Missing
Expected: <managed-root>/runner/xpack-openocd-0.12.0-7

[Install automatically]
```

An installed package can expose:

```text
[Update]
[Uninstall]
```

The package scan distinguishes between:

- **system packages** — installed into the host operating system/user Rust environment;
- **extension-managed packages** — owned by MikroBUS Rust Tools under its managed root.

---

# Where packages are downloaded from

## Rust

### Linux

The Rust installer is started through:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Source:

```text
https://sh.rustup.rs
```

### Windows

The extension opens the official x86_64 MSVC rustup bootstrap executable:

```text
https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe
```

Rust is not pinned to one compiler release by the extension. The installed rustup toolchain manages the Rust version.

---

## probe-rs

The current preferred probe-rs tools version in the extension is:

```text
0.32.0
```

### Linux installer

```text
https://github.com/probe-rs/probe-rs/releases/download/v0.32.0/probe-rs-tools-installer.sh
```

The extension runs:

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/probe-rs/probe-rs/releases/download/v0.32.0/probe-rs-tools-installer.sh \
  | sh
```

### Windows installer

```text
https://github.com/probe-rs/probe-rs/releases/download/v0.32.0/probe-rs-tools-installer.ps1
```

The extension opens PowerShell and executes the installer script.

probe-rs supplies the tools used by the extension for:

- `probe-rs`
- `cargo flash`
- DAP debugging
- target erase

---

## probe-rs Linux udev rules

Source:

```text
https://probe.rs/files/69-probe-rs.rules
```

The extension installs the rules to:

```text
/etc/udev/rules.d/69-probe-rs.rules
```

and reloads/triggers udev.

These rules provide non-root USB access for supported debug probes such as ST-Link, J-Link and CMSIS-DAP devices.

---

## OpenOCD

Pinned version:

```text
xPack OpenOCD 0.12.0-7
```

Release source:

```text
https://github.com/xpack-dev-tools/openocd-xpack/releases
```

Examples used by the extension:

```text
Windows x64:
https://github.com/xpack-dev-tools/openocd-xpack/releases/download/v0.12.0-7/xpack-openocd-0.12.0-7-win32-x64.zip

Linux x64:
https://github.com/xpack-dev-tools/openocd-xpack/releases/download/v0.12.0-7/xpack-openocd-0.12.0-7-linux-x64.tar.gz

Linux ARM64:
https://github.com/xpack-dev-tools/openocd-xpack/releases/download/v0.12.0-7/xpack-openocd-0.12.0-7-linux-arm64.tar.gz
```

OpenOCD is extension-managed.

**Current note:** normal Flash and F5 Debug do not invoke OpenOCD; they use probe-rs.

---

## ARM GNU Toolchain

Pinned xPack version:

```text
14.2.1-1.1
```

Release source:

```text
https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases
```

Examples used by the extension:

```text
Windows x64:
https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/download/v14.2.1-1.1/xpack-arm-none-eabi-gcc-14.2.1-1.1-win32-x64.zip

Linux x64:
https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/download/v14.2.1-1.1/xpack-arm-none-eabi-gcc-14.2.1-1.1-linux-x64.tar.gz

Linux ARM64:
https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/download/v14.2.1-1.1/xpack-arm-none-eabi-gcc-14.2.1-1.1-linux-arm64.tar.gz
```

**Current note:** `cargo build` uses the Rust compiler/rustc, not this GCC executable.

---

## Rust mikroSDK, MCU core and database

These packages are resolved dynamically from the **latest GitHub release** of:

```text
https://github.com/IvanRuzavin/Rusty_MikroBUS
```

The extension queries:

```text
https://api.github.com/repos/IvanRuzavin/Rusty_MikroBUS/releases/latest
```

and looks for the exact release asset names:

```text
database_mikro_sdk_rust.db
sdk.7z
core.7z
```

Therefore:

- **Database** is downloaded from the latest release asset named `database_mikro_sdk_rust.db`.
- **Rust mikroSDK** is downloaded from `sdk.7z`.
- **MCU Core Package** is downloaded from `core.7z`.

The SDK/core versions are therefore release-driven rather than hardcoded inside the extension.

---

## Windows MSVC Build Tools

The extension opens:

```text
https://aka.ms/vs/17/release/vs_BuildTools.exe
```

MSVC is system-managed and is not stored under the extension-managed root.

---

## Windows ST-Link driver

The current driver source configured by the extension is:

```text
https://download.mikroe.com/setups/drivers/mikroprog/arm/st-link-usb-drivers.rar
```

The extension detects an ST-Link driver by searching the Windows DriverStore for `stlink_vcp.inf`.

---

## SEGGER J-Link / J-Flash

SEGGER download page:

```text
https://www.segger.com/downloads/jlink/
```

The extension does not silently install or remove SEGGER software.

Detection checks for J-Flash specifically:

```text
Windows:
PATH or C:\Program Files\SEGGER\...\JFlash.exe

Linux:
PATH or /opt/SEGGER/.../JFlashExe
```

J-Link/J-Flash is treated as a system package.

---

# Extension-managed storage layout

Unless overridden in settings, the extension uses VS Code's `globalStorageUri` as its managed root.

The actual location is supplied by VS Code and is displayed in the Environment Setup sidebar.

Conceptually:

```text
<managed-root>/
|
+-- database/
|   +-- database_mikro_sdk_rust.db
|
+-- sdk/
|   +-- Cargo.toml
|   +-- .cargo/
|   +-- hal/
|   +-- drv/
|   +-- targets/
|   +-- platform/
|   +-- src/
|   +-- .setup/                 # generated active configuration
|   +-- ...
|
+-- core/
|   +-- arm/
|   |   +-- stm32/
|   |       +-- mcu_definitions/
|   |       +-- memory/
|   |       +-- startup/
|   |       +-- mcu_headers/
|   |       +-- system/
|   |       +-- pin_mappings/
|   |       +-- ...
|   +-- ...
|
+-- runner/
|   +-- xpack-openocd-0.12.0-7/
|   +-- xpack-arm-none-eabi-gcc-14.2.1-1.1/
|
+-- configured-setups/
|   +-- setups.json
|   +-- active.json
|
+-- .install-temp/              # temporary package staging
```

The root can be overridden with:

```text
mikrobusRust.storageRoot
```

---

# Package update and uninstall behavior

## Extension-managed packages

These are fully controlled by the extension:

- OpenOCD
- ARM GNU Toolchain
- database
- Rust mikroSDK
- MCU core

They support:

- Install
- Update/reinstall
- Uninstall
- bulk **Update managed**

## Safe update process

Managed packages are first downloaded/extracted into a staging directory:

```text
<managed-root>/.install-temp/<package>-<timestamp>-<random>/
```

For directory packages, replacement uses a backup pattern:

```text
old target
   |
   +--> target.mikrobus-backup-<timestamp>

new package
   |
   +--> target
```

If installation succeeds, the backup is deleted.

If installation fails, the extension attempts to restore the previous installation.

The database update uses the same general backup/restore idea for the database file.

## Uninstall safety

The extension refuses to recursively remove a managed package path if the resolved path is outside the configured managed root.

This prevents an incorrect configuration from causing an arbitrary directory deletion.

## System packages

System packages are handled conservatively:

- Rust uninstall uses `rustup self uninstall`.
- probe-rs uninstall removes installed probe-rs/cargo-flash/cargo-embed tool executables from Cargo's bin directory.
- Linux udev uninstall removes only the extension's `69-probe-rs.rules` target and reloads udev.
- Linux prerequisite packages are **not automatically removed**, because other development environments may depend on them.
- MSVC/ST-Link/J-Link use native system uninstall guidance rather than recursive deletion.

---

# MCU database and device catalog

The extension reads:

```text
<managed-root>/database/database_mikro_sdk_rust.db
```

The current implementation uses SQLite through Node's built-in `node:sqlite` `DatabaseSync` API.

The MCU catalog query is conceptually:

```sql
SELECT
    MCU.NAME,
    FAMILY.VENDOR,
    FAMILY.TARGET,
    MCU.SYSTEM_LIB,
    MCU.FAMILY
FROM MCU
JOIN FAMILY ON MCU.FAMILY = FAMILY.NAME
ORDER BY MCU.NAME;
```

The catalog displays general information such as:

- MCU
- Vendor
- Family
- Rust compilation target
- System library
- setup status

The GUI supports searching/filtering the device table.

Status can indicate:

- **Available** — MCU exists in the database and has no saved setup.
- **Configured** — a saved setup exists.
- **Active** — the setup is the most recently generated/active setup.

Clicking an MCU replaces the catalog with the selected MCU's configuration page. The MCU table is not kept beside the configuration controls.

The user can explicitly return with **All MCUs**.

---

# MCU configuration GUI

After selecting a device, the main editor displays only that MCU's configuration.

Example conceptually:

```text
MCU SETTINGS

STM32F412RE
Vendor          stm
Family          F4
Rust target     thumbv7em-none-eabi
System library  system_stm32f_4xx

System clock
Clock (MHz): [100]

Clock / configuration registers

RCC_CR
  Internal high-speed clock enable        [ ... ]
  External high-speed clock enable        [ ... ]
  Main PLL enable                         [ ... ]
  ...

RCC_PLLCFGR
  PLLM                                    [ ... ]
  PLLN                                    [ ... ]
  PLLP                                    [ ... ]
  ...

[Build Configuration]
```

The register UI is generated dynamically from the MCU JSON definition from the core package.

For example:

```text
core/.../mcu_definitions/STM32F412RE.json
```

The extension searches the installed core recursively for the matching `<MCU>.json` file.

---

# How register and clock configuration is generated

This section is especially important because the values in `core_header.rs` directly affect MCU startup.

## Source JSON representation

MCU definition JSON files store register values as hexadecimal strings, often **without** a `0x` prefix:

```json
{
    "key": "PLLON",
    "init": "01000000",
    "mask": "01000000",
    "settings": [
        {
            "label": "PLL OFF",
            "value": "00000000"
        },
        {
            "label": "PLL ON",
            "value": "01000000"
        }
    ]
}
```

The extension intentionally interprets:

```text
01000000
```

as:

```text
0x01000000
```

and **not decimal 1,000,000**.

This is critical for correct RCC/configuration register generation.

## Field selection algorithm

For every register:

1. Iterate through all fields.
2. If the field is hidden, use its JSON `init` value.
3. If the field is visible and a saved/user selection exists, use that selected setting value.
4. Otherwise fall back to `init`, or the first setting if no `init` exists.
5. Parse the selected string as hexadecimal.
6. Bitwise-OR all field values into one 32-bit register value.

Conceptually:

```text
VALUE_RCC_CR =
    HSION
  | HSEON
  | HSEBYP
  | CSSON
  | PLLON
  | PLLI2SON
  | HSITRIM
  | ...
```

The result is emitted as uppercase, zero-padded 32-bit hexadecimal.

## Generated core header

Example:

```rust
pub const ADDRESS_RCC_CR: u32 = 0x40023800;
pub const VALUE_RCC_CR: u32 = 0x01000081;

pub const ADDRESS_RCC_PLLCFGR: u32 = 0x40023804;
pub const VALUE_RCC_PLLCFGR: u32 = 0x04003210;

pub const FOSC_KHZ_VALUE: u32 = 100000;
```

## Clock MHz field

The explicit Clock MHz control generates:

```rust
pub const FOSC_KHZ_VALUE: u32 = clock_mhz * 1000;
```

For example:

```text
100 MHz -> FOSC_KHZ_VALUE = 100000
```

### Current limitation

The extension **does not currently calculate PLL/register settings automatically from the MHz value**.

The actual hardware clock configuration is still defined by the selected JSON register fields.

Therefore the Clock MHz field and the RCC selections must describe the same intended configuration.

A future improvement should calculate/validate the actual resulting SYSCLK and reject inconsistent combinations.

### Additional current register-generation note

The current implementation builds each register from its field selections. JSON-level `default` and `unused` values are not separately OR-ed into the generated register value. The field data is therefore expected to describe the bits that must be emitted.

---

# What happens when a setup is built

When **Build Configuration** or **Update & Rebuild Configuration** is pressed, the extension performs the following sequence.

## 1. Validate required managed packages

It requires:

```text
database
sdk
core
```

## 2. Read MCU metadata from the database

The extension obtains:

```text
MCU name
Vendor
Family
Rust target
System library
```

For example:

```text
STM32F412RE
Vendor: stm
Family: F4
Target: thumbv7em-none-eabi
System library: system_stm32f_4xx
```

## 3. Read family implementation selections

The original PyQt workflow uses positional columns from the `FAMILY` table.

The extension preserves this compatibility behavior.

It reads `PRAGMA table_info(FAMILY)` and takes family-specific implementations from the corresponding database columns for:

```text
GPIO
ADC
I2C
SPI
TIM
UART
```

The database also contains the one-wire implementation metadata, although the current generator selects `one_wire/implementation_1` directly.

## 4. Locate the MCU JSON definition

The core is searched for:

```text
<MCU>.json
```

For example:

```text
STM32F412RE.json
```

## 5. Generate `core_header.rs`

The selected register settings are converted into constants such as:

```rust
ADDRESS_RCC_CR
VALUE_RCC_CR
ADDRESS_RCC_PLLCFGR
VALUE_RCC_PLLCFGR
FOSC_KHZ_VALUE
```

## 6. Generate through a staging `.setup`

The extension first creates:

```text
sdk/.setup.__mikrobus_staging/
```

This prevents a half-generated configuration from immediately replacing the working `.setup`.

## 7. Select core files

From the core package it selects/copies:

```text
memory/<MCU>/memory.x
startup/<mcu-lowercase>.s
mcu_headers/<MCU>/lib.rs
reset.rs
system/<SYSTEM_LIB>/init_clock.rs
Cargo.toml
lib.rs
common_header.rs
```

into the generated core crate.

## 8. Generate Cargo target configuration

The extension reads:

```text
sdk/.cargo/template_config.toml
```

and replaces:

```text
{compiling_target}
```

with the target read from the database, for example:

```text
thumbv7em-none-eabi
```

The result is written to:

```text
sdk/.cargo/config.toml
```

## 9. Generate MCU/family pin mapping crate

The generator locates:

```text
core/<platform>/pin_mappings/<family>/
```

and copies its `src` tree into:

```text
sdk/.setup/sdk/src/
```

It reads the MCU JSON `language_list` entry for `RUST`, enumerates module/submodule `pin_map_features`, and substitutes those feature lists into the family Cargo templates.

## 10. Normalize Rust crate entry point

Some core packages historically contained:

```text
Lib.rs
```

with a capital `L`.

Cargo expects:

```text
lib.rs
```

on case-sensitive systems such as Linux.

The generator therefore checks the generated `.setup/sdk/src` directory and, when necessary, creates a correctly named lowercase `lib.rs` from a case-insensitive match.

## 11. Select low-level family implementations

The extension updates the appropriate SDK target implementation files using the database family mapping.

For STM32 this includes:

```text
targets/arm/stm32/src/gpio.rs
targets/arm/stm32/src/gpio_port.rs
targets/arm/stm32/src/adc.rs
targets/arm/stm32/src/i2c_master.rs
targets/arm/stm32/src/spi_master.rs
targets/arm/stm32/src/tim.rs
targets/arm/stm32/src/uart.rs
targets/arm/stm32/src/one_wire.rs
```

These files are selected from the family-specific implementation directories recorded in the database.

## 12. Commit `.setup`

If generation succeeds:

```text
sdk/.setup
```

is removed and the staging setup is renamed into place.

## 13. Install the Rust target

The extension resolves `rustup` and runs:

```bash
rustup target add <database-target>
```

For example:

```bash
rustup target add thumbv7em-none-eabi
```

If this command fails, the generated files remain available and the extension reports a warning.

## 14. Save the configured setup

The MCU, clock and selected register values are saved into the extension's setup registry.

After a successful generation the GUI automatically goes to **Configured Setups**.

---

# Generated `.setup` layout

A generated setup looks approximately like this:

```text
sdk/.setup/
|
+-- core/
|   +-- Cargo.toml
|   +-- memory.x
|   +-- src/
|       +-- core_header.rs
|       +-- startup.s
|       +-- mcu_header.rs
|       +-- reset.rs
|       +-- init_clock.rs
|       +-- common_header.rs
|       +-- lib.rs
|
+-- sdk/
    +-- Cargo.toml
    +-- src/
        +-- lib.rs
        +-- gpio.rs
        +-- adc.rs
        +-- i2c.rs
        +-- spi.rs
        +-- tim.rs
        +-- uart.rs
        +-- ...
```

The exact pin-mapping source files depend on the family package.

---

# Why HAL and DRV are not copied into `.setup`

This is intentional.

The permanent Rust mikroSDK already contains the generic HAL and driver layers:

```text
sdk/
├── hal/
├── drv/
├── targets/
└── .setup/
```

The generated `.setup` only contains the target-specific/generated crates needed to parameterize the shared SDK.

The dependency structure is conceptually:

```text
Application
    |
    v
DRV layer                sdk/drv
    |
    v
HAL layer                sdk/hal
    |
    v
Low-level target         sdk/targets/...
    |
    +--> MCU definition  sdk/.setup/sdk
    |
    +--> system/core     sdk/.setup/core
```

During a normal Cargo build, crates from `sdk/hal` and `sdk/drv` are compiled directly from their permanent SDK locations.

Therefore `.setup` does **not** need duplicate copies of the complete HAL and DRV trees.

---

# Configured setup manager

Generated configurations are saved under:

```text
<managed-root>/configured-setups/
├── setups.json
├── active.json
└── workspaces/
    └── <setup-id>/
        ├── Cargo.toml
        ├── .cargo/config.toml
        ├── .setup/
        ├── drv/
        ├── hal/
        ├── platform/
        └── targets/
```

## `setups.json`

A saved setup contains information similar to:

```json
{
  "id": "stm32f412re",
  "mcuName": "STM32F412RE",
  "vendor": "stm",
  "family": "F4",
  "target": "thumbv7em-none-eabi",
  "systemLib": "system_stm32f_4xx",
  "clockMhz": 100,
  "sdkRoot": "workspaces/stm32f412re",
  "artifactVersion": 1,
  "values": {
    "0:0": "00000001",
    "0:4": "01000000"
  },
  "createdAt": "...",
  "updatedAt": "...",
  "lastBuiltAt": "..."
}
```

The `values` object stores the selected JSON setting values by register/field index.

## `active.json`

This records the setup currently considered active:

```json
{
  "id": "stm32f412re"
}
```

## One saved setup per MCU

The current registry model uses one setup record per MCU.

Reconfiguring the same MCU updates the existing record rather than automatically creating multiple named variants.

## Setup manager actions

Each configured setup exposes:

- **Apply to workspace**
- **Edit clock/settings**
- **Rebuild**
- **Remove**

### Edit clock/settings

Reloads the MCU page and restores the saved clock/register selections.

### Rebuild

Regenerates the configuration from the saved definition without requiring the user to reopen every setting.

This is useful after updating SDK/core/database packages.

### Remove

Deletes the setup record.

If the setup is bound to the current workspace, the extension also removes the workspace binding/generated configuration associated with that setup.

---

# Applying a setup to a workspace

The extension supports a workspace-binding model.

A setup can be selected from **Configured Setups** and applied using:

```text
Apply to workspace
```

The extension then:

1. resolves the setup's complete extension-managed build workspace;
2. creates a lightweight binding in the source workspace;
3. updates Rust Analyzer to use the reusable setup manifest and target;
4. exposes Build / Flash / Debug / Erase actions for the active Rust source.

The binding is stored in:

```text
<workspace>/.vscode/mikrobus-rust.json
```

A binding contains data similar to:

```json
{
  "version": 1,
  "setupId": "stm32f412re",
  "mcuName": "STM32F412RE",
  "clockMhz": 100,
  "target": "thumbv7em-none-eabi",
  "sdkRoot": "...",
  "configuredAt": "...",
  "setupRoot": "..."
}
```

---

# Standalone/minimal Rust projects

Every configured MCU setup owns an independent complete SDK build workspace. The user's application source remains in the normal project folder.

Conceptually:

```text
my-blink-project/
├── .vscode/
│   └── mikrobus-rust.json
└── main.rs

          uses
           |
           v
<managed-root>/configured-setups/workspaces/stm32f412re/
├── hal/
├── drv/
├── targets/
├── .setup/
└── Cargo.toml
```

Build, flash, and debug temporarily register the active `.rs` file as a Cargo binary target in that reusable setup. The manifest is restored immediately after the operation. The source is not copied, so compiler diagnostics and DWARF breakpoint paths continue to identify the file open in VS Code.

---

# Build workflow

## Build Current Rust File

Shortcut:

```text
Ctrl+Shift+B
```

macOS key declaration:

```text
Cmd+Shift+B
```

when the editor language is Rust and a MikroBUS setup is bound.

The command:

1. requires a workspace binding;
2. saves the active Rust file;
3. verifies that the file is inside the bound source workspace;
4. registers it temporarily as `mikrobus_current` in the reusable setup;
5. resolves Cargo;
6. runs:

```bash
cargo build
```

from the bound SDK root.

Output appears in:

```text
Output -> MikroBUS Rust
```

## Build Current Project

The extension also exposes a project-level command that simply runs:

```bash
cargo build
```

in the bound SDK root without replacing `src/main.rs` first.

---

# Flash workflow

Shortcut:

```text
Ctrl+F5
```

for an active Rust file in a bound workspace.

The current-file flash workflow is:

```text
active .rs file
     |
     v
save
     |
     v
copy to sdk/src/main.rs
     |
     v
cargo build
     |
     v
cargo flash --chip <MCU> --connect-under-reset
```

For example:

```bash
cargo flash --chip STM32F412RE --connect-under-reset
```

The configured MCU name is used directly as the probe-rs chip identifier.

## ST-Link / Nucleo use case

For a Nucleo board with an onboard ST-Link, the current primary path is:

```text
VS Code
   |
   v
cargo flash / probe-rs
   |
   v
ST-Link USB probe
   |
   v
STM32 MCU
```

Linux requires suitable udev access; Windows requires the relevant USB driver.

---

# Erase workflow

When a workspace is bound, **Erase MCU** is available in the Rust editor toolbar and in the configured-workspace controls.

The extension displays a modal confirmation containing the exact MCU before erasing.

If confirmed it runs:

```bash
probe-rs erase --chip <MCU>
```

Example:

```bash
probe-rs erase --chip STM32F412RE
```

Erase affects MCU flash only.

It does **not** remove:

- saved setup
- workspace binding
- SDK/core packages
- clock/register setup record

---

# F5 debugging and breakpoints

Shortcut:

```text
F5
```

when a Rust editor is active and the workspace has a MikroBUS setup binding.

The extension implements its own VS Code debugger type:

```text
mikrobus-rust-debug
```

with display label:

```text
MikroBUS Rust (probe-rs)
```

## Why the debugger uses probe-rs DAP directly

On Windows, the extension launches:

```bash
probe-rs dap-server
```

through a VS Code `DebugAdapterExecutable`. DAP messages travel over the child process stdin/stdout, so Windows does not need a temporary localhost port or a firewall exception.

On Linux and macOS, the extension retains the existing launch:

```bash
probe-rs dap-server --port <free-local-port>
```

and returns a VS Code `DebugAdapterServer` pointing at:

```text
127.0.0.1:<port>
```

This is a TCP DAP connection on non-Windows hosts.

The extension does not need a second third-party VS Code debugger extension for this path.

## Debugging the current `.rs` file directly

For F5, the extension temporarily adds the active source as a Cargo binary target to the reusable setup manifest:

```toml
# temporary, inserted only for the debug build
[[bin]]
name = "mikrobus_debug_current"
path = "<path-to-the-opened-rs-file>"
```

It then runs:

```bash
cargo build --bin mikrobus_debug_current
```

Immediately after the build, the original Cargo manifest is restored.

The resulting ELF is expected at a path such as:

```text
target/<rust-target>/debug/mikrobus_debug_current
```

## First-line stop behavior

Before launching, the extension examines the active source file and finds:

```rust
fn main(...)
```

It then finds the first non-empty executable source line after `main` and creates a temporary VS Code source breakpoint there if the user has not already placed one.

This gives the desired behavior:

```text
F5
 |
 v
build current file directly
 |
 v
start probe-rs DAP server
 |
 v
flash ELF
 |
 v
halt after reset
 |
 v
VS Code sends all user breakpoints
 |
 v
continue
 |
 v
stop at first executable line of main()
```

## Debug launch parameters

The generated debug launch includes:

```text
chip: <configured MCU>
connectUnderReset: true
flashingEnabled: true
haltAfterReset: true
binary format: ELF
core index: 0
```

## Breakpoints

Because the current Rust source is compiled directly as the temporary Cargo target, DWARF references the original `.rs` path.

Therefore breakpoints set in the VS Code editor can bind to that file.

The temporary first-line breakpoint created by the extension is removed when the debug session ends.

## Debug views

The actual variables/register/stack features available are provided by the probe-rs DAP implementation and VS Code debug UI. The intended GUI includes normal VS Code areas such as:

```text
VARIABLES
WATCH
CALL STACK
BREAKPOINTS
```

plus the standard debug toolbar for continue/step/restart/stop where supported by the adapter/target.

After every `stopped` DAP event, the extension also prints all non-register variable scopes exposed by probe-rs into the Debug Console. It includes locals from the active call stack and prints static/global scopes once. Arrays, structures, references, and other child values are recursively expanded within the configured safety limits. Variables removed by Rust/LLVM optimization or not exposed by the debug adapter cannot be recovered by the extension.

The extension also contributes direct controls for these operations:

- **MikroBUS Rust: Step Out** sends a DAP `stepOut` request for the active probe-rs thread.
- **MikroBUS Rust: Restart Debugger** sends a DAP `restart` request. If restart is rejected, the extension stops and relaunches the same configuration automatically.
- **MikroBUS Rust: Print Variables to Debug Console** requests the same variable dump manually while execution is paused.

---

# Keyboard shortcuts and editor actions

When:

```text
editorLangId == rust
```

and:

```text
mikrobusRust.workspaceBound == true
```

MikroBUS Rust contributes editor-title actions.

| Action | Shortcut | Command |
|---|---|---|
| Build current `.rs` | `Ctrl+Shift+B` | `MikroBUS Rust: Build Current Rust File` |
| Build + flash current `.rs` | `Ctrl+F5` | `MikroBUS Rust: Build & Flash Current Rust File` |
| Debug current `.rs` | `F5` | `MikroBUS Rust: Debug Current Rust File` |
| Step out of function | `Shift+F11` | `MikroBUS Rust: Step Out` |
| Restart debugger | `Ctrl+Shift+F5` | `MikroBUS Rust: Restart Debugger` |
| Print paused variables | Command/debug toolbar | `MikroBUS Rust: Print Variables to Debug Console` |
| Erase MCU | toolbar button | `MikroBUS Rust: Erase Configured MCU` |

These keybindings are scoped to a bound Rust workspace so the extension does not globally replace F5/Ctrl+F5 behavior in unrelated files.

---

# Rust Analyzer integration

Applying a setup updates:

```text
<workspace>/.vscode/settings.json
```

The extension maintains:

```json
{
  "rust-analyzer.linkedProjects": [
    "<path-to-sdk-Cargo.toml>"
  ],
  "rust-analyzer.cargo.target": "thumbv7em-none-eabi"
}
```

If the user workspace already contains its own `Cargo.toml`, it is also added to `rust-analyzer.linkedProjects` if not already present.

This is particularly useful when only an SDK tests folder or a standalone source folder is opened in VS Code.

---

# Supported devices

The following **37 devices are currently marked as supported for this extension workflow**.

The Rust target and system library values shown below come from the current MikroBUS Rust database schema used by the extension.

## Family summary

| Family | Supported devices | Rust target |
|---|---:|---|
| STM32F2 | 2 | `thumbv7m-none-eabi` |
| STM32L1 | 1 | `thumbv7m-none-eabi` |
| STM32F4 | 29 | `thumbv7em-none-eabi` |
| STM32F7 | 5 | `thumbv7em-none-eabi` |
| **Total** | **37** | — |

## Detailed supported-device table

| Supported | MCU | Family | Rust target | System library |
|---|---|---|---|---|
| ✅ | STM32F479II | F4 | `thumbv7em-none-eabi` | `system_stm32f_4hs` |
| ✅ | STM32F429ZI | F4 | `thumbv7em-none-eabi` | `system_stm32f_4hs` |
| ✅ | STM32F412RE | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F412ZG | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F405ZG | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F217ZG | F2 | `thumbv7m-none-eabi` | `system_stm32f_2xx` |
| ✅ | STM32L152RE | L1 | `thumbv7m-none-eabi` | `system_stm32l_1xx` |
| ✅ | STM32F207ZG | F2 | `thumbv7m-none-eabi` | `system_stm32f_2xx` |
| ✅ | STM32F407IG | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F407IE | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F417IE | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F417IG | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F415ZG | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F407ZG | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F417ZG | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F407ZE | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F417ZE | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F405ZE | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F415ZE | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F405VG | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F415VG | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F407VG | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F417VG | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F405VE | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F415VE | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F407VE | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F417VE | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F405OE | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F405OZ | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F415OZ | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F405RG | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F415RG | F4 | `thumbv7em-none-eabi` | `system_stm32f_4xx` |
| ✅ | STM32F723IE | F7 | `thumbv7em-none-eabi` | `system_stm32f_7xx` |
| ✅ | STM32F723ZE | F7 | `thumbv7em-none-eabi` | `system_stm32f_7xx` |
| ✅ | STM32F777NI | F7 | `thumbv7em-none-eabi` | `system_stm32f_7xx` |
| ✅ | STM32F756NG | F7 | `thumbv7em-none-eabi` | `system_stm32f_7xx` |
| ✅ | STM32F756ZG | F7 | `thumbv7em-none-eabi` | `system_stm32f_7xx` |

> **Important:** the database may contain additional MCU records. The table above is the explicit device set currently declared supported for this extension workflow. Presence in the database alone should not be interpreted as validated hardware support unless the corresponding core files, pin mappings and family implementations are also present and tested.

---

# VS Code settings

The extension contributes the following settings.

## `mikrobusRust.storageRoot`

Optional root directory for extension-managed packages.

Default:

```text
empty
```

When empty, VS Code's extension `globalStorageUri` is used.

Example:

```json
{
  "mikrobusRust.storageRoot": "/home/user/.mikrobus-rust"
}
```

or Windows:

```json
{
  "mikrobusRust.storageRoot": "C:\\MIKROE\\MikroBUSRust"
}
```

## `mikrobusRust.cargoPath`

Optional absolute path to Cargo.

Example:

```json
{
  "mikrobusRust.cargoPath": "/home/user/.cargo/bin/cargo"
}
```

If empty, the extension tries:

1. `PATH`
2. `$CARGO_HOME/bin`
3. `~/.cargo/bin`

## `mikrobusRust.rustupPath`

Optional absolute path to rustup.

Fallback search follows the same Rust tool directories.

## `mikrobusRust.probeRsPath`

Optional absolute path to `probe-rs`.

Fallback search:

1. `PATH`
2. `$CARGO_HOME/bin`
3. `~/.cargo/bin`

The resolved executable directory and Cargo bin directories are prepended to the child process `PATH` before build/flash/debug commands are launched.

This avoids the common VS Code desktop-launch problem where Rust was installed but `~/.cargo/bin` was not present in the extension host's inherited PATH.

## Debug Console variable dump settings

The variable dump is enabled by default and can be adjusted with:

| Setting | Default | Purpose |
|---|---:|---|
| `mikrobusRust.dumpVariablesOnStop` | `true` | Print variables after every debugger stop. |
| `mikrobusRust.variableDumpMaxDepth` | `5` | Maximum recursive child depth (`0` prints only top-level values). |
| `mikrobusRust.variableDumpMaxEntries` | `5000` | Maximum values printed by one dump. |
| `mikrobusRust.variableDumpMaxValueLength` | `512` | Maximum characters printed for each name, type, or value. |

Set `mikrobusRust.dumpVariablesOnStop` to `false` to disable automatic output while retaining the manual debug-toolbar command.

---

# Commands contributed by the extension

The extension currently contributes commands including:

```text
MikroBUS Rust: Open Setup
MikroBUS Rust: Configure MCU
MikroBUS Rust: Apply Setup to Current Workspace
MikroBUS Rust: Use Current Rust File as main.rs
MikroBUS Rust: Build Current Project
MikroBUS Rust: Flash Current Project
MikroBUS Rust: Build & Flash Current Rust File
MikroBUS Rust: Erase Configured MCU
MikroBUS Rust: Build Current Rust File
MikroBUS Rust: Debug Current Rust File
MikroBUS Rust: Step Out
MikroBUS Rust: Restart Debugger
MikroBUS Rust: Print Variables to Debug Console
```

These can be found in the VS Code Command Palette.

---

# Typical end-to-end workflow

## First-time setup

```text
1. Install the VSIX.
2. Reload VS Code.
3. Open the MikroBUS Rust Activity Bar icon.
4. Install missing packages.
5. Ensure Rust, probe-rs, database, SDK and core show Installed.
6. On Linux, install udev rules.
```

## Create an MCU setup

```text
1. Click Configure MCU.
2. Search/select an MCU.
3. Enter the intended clock MHz.
4. Review/select all required clock/register fields.
5. Click Build Configuration.
6. The extension generates the setup.
7. The GUI switches to Configured Setups.
```

## Apply the setup

```text
1. Open the Rust workspace/source folder.
2. Open Configured Setups.
3. Choose the MCU setup.
4. Click Apply to workspace.
5. The extension selects the setup's complete reusable build workspace.
6. The workspace receives .vscode/mikrobus-rust.json.
7. Rust Analyzer is pointed at the selected target/backend.
```

## Build an application

Open the desired Rust file and press:

```text
Ctrl+Shift+B
```

## Flash an application

Connect the board/debug probe and press:

```text
Ctrl+F5
```

The extension builds and runs:

```bash
cargo flash --chip <MCU> --connect-under-reset
```

## Debug an application

Place breakpoints in the opened Rust file and press:

```text
F5
```

The extension builds that source as a direct temporary Cargo binary, starts probe-rs DAP, flashes/halt-resets the MCU and stops at the first executable line of `main()`.

Continue execution to reach additional user breakpoints.

## Erase the MCU

Click **Erase MCU** and confirm the exact target.

The extension runs:

```bash
probe-rs erase --chip <MCU>
```

---

# Important implementation details and current limitations

This section describes the current implementation accurately rather than the final desired architecture.

## 1. One setup per MCU

The setup registry currently updates an existing MCU record rather than creating arbitrary named variants for the same MCU.

Future support could add names such as:

```text
STM32F407VG - 168 MHz HSE
STM32F407VG - 16 MHz HSI
```

without overwriting one another.

## 2. Clock MHz does not synthesize PLL values

The MHz box writes `FOSC_KHZ_VALUE`.

The actual RCC configuration still comes from the JSON register selections.

Automatic PLL solving/validation is a logical future improvement.

## 3. Register `default`/`unused` handling

Current generation ORs the selected field values. It does not independently apply the register-level JSON `default` or `unused` values.

## 4. The generator modifies target files in the SDK backend

In addition to `.setup`, generation writes family-selected low-level files under:

```text
sdk/targets/<platform>/src/
```

and updates that target's generated Cargo manifest.

This follows the existing PyQt/mikroSDK approach but means the selected SDK backend is an active generated build environment, not a completely immutable package.

## 5. Generic HAL/DRV remain shared

`hal/` and `drv/` are not copied into `.setup` because the normal Cargo dependency graph references them from the SDK itself.

## 6. Current build-current-file behavior copies source to SDK `src/main.rs`

This is compatible with the original PyQt test-file workflow.

It means the SDK backend's `src/main.rs` is overwritten when a different source is selected for normal Build/Flash-current-file actions.

## 7. Debug intentionally does not use that copied `main.rs`

F5 compiles the original source path directly to preserve source file/DWARF breakpoint identity.

## 8. OpenOCD and ARM GCC are not the primary current runtime backend

They are installed/maintained, but:

```text
Build  -> Cargo/rustc
Flash  -> cargo flash / probe-rs
Debug  -> probe-rs DAP
Erase  -> probe-rs
```

## 9. J-Link/J-Flash is optional in the current standard path

The Environment Setup page can detect/manage guidance for SEGGER tools, but normal Flash/F5 currently uses probe-rs.

## 10. Current debugger assumes core index 0

The generated probe-rs debug configuration currently uses:

```text
coreIndex = 0
```

Multi-core/AMP target selection is not implemented in this Rust extension yet.

## 11. Debug transport is host-specific

On Windows, the extension starts `probe-rs dap-server` as a VS Code debug-adapter process and uses stdin/stdout DAP. On Linux and macOS, it allocates a free localhost port and starts the DAP server there. The non-Windows server process is terminated when the VS Code debug session ends.

## 12. Supported-device validation is narrower than database enumeration

The MCU catalog may show more database entries than the explicit supported list in this README. A device is only practically usable if the complete core/SDK assets required by the generator are present.

---

# Troubleshooting

## `spawn cargo ENOENT`

Cause:

VS Code's extension host cannot resolve Cargo from its inherited PATH.

The extension now also checks:

```text
$CARGO_HOME/bin
~/.cargo/bin
```

If necessary configure:

```json
{
  "mikrobusRust.cargoPath": "/home/user/.cargo/bin/cargo"
}
```

Then reload VS Code.

---

## `probe-rs` not found

Verify:

```bash
~/.cargo/bin/probe-rs --version
```

or set:

```json
{
  "mikrobusRust.probeRsPath": "/home/user/.cargo/bin/probe-rs"
}
```

---

## Linux probe permission error

Install/update the **Debug Probe USB Access** card.

Expected rule:

```text
/etc/udev/rules.d/69-probe-rs.rules
```

Then reconnect the USB probe if necessary.

---

## `.setup/sdk/Cargo.toml` says no targets specified

Check:

```text
.setup/sdk/src/lib.rs
```

The current generator automatically normalizes historical `Lib.rs` casing to lowercase `lib.rs` on Linux.

Rebuild the setup with the current extension version.

---

## Register values look completely wrong

MCU JSON register values are hexadecimal even when they do not have `0x`.

Example:

```text
01000000 = 0x01000000
```

The current generator handles this correctly.

If a setup was generated by an older extension build that interpreted these strings as decimal, rebuild the setup.

---

## Build works but board does nothing

Check, in this order:

1. exact configured MCU matches the physical chip;
2. clock/register settings are internally valid;
3. configured GPIO pin exists on the selected package;
4. the source uses the actual board LED/peripheral pin;
5. the application reaches `main()` under F5;
6. the debugger is not stuck in startup/system clock initialization;
7. the selected MCU JSON/core/system library corresponds to the device.

F5 is particularly useful here because it can distinguish a successful flash from a firmware that never reaches `main()`.

---

## Breakpoint is hollow/unbound

F5 should compile the **opened source file directly** as the temporary `mikrobus_debug_current` Cargo target.

Check the MikroBUS Rust output for:

```text
Debug source: <your actual file>
Debug ELF: .../mikrobus_debug_current
Entry breakpoint: <file>:<line>
```

If the debug source path is not the file where the breakpoint was placed, the workspace/source binding needs to be corrected.

---

## Flash succeeds but probe-rs reports core running when halt was expected

The Flash command and the F5 Debug command are separate paths.

For source-level diagnosis, use F5. The debug launch requests:

```text
connectUnderReset = true
haltAfterReset = true
```

and then continues to the first source breakpoint after VS Code finishes configuring breakpoints.

---

# Building the VSIX

From the extension source directory:

```bash
npm install
npx @vscode/vsce package
```

or use the provided npm script:

```bash
npm run build
```

The JavaScript source can be checked with:

```bash
npm run check
```

The current check script validates:

```text
extension.js
mcu_configurator.js
media/setup.js
media/mcu.js
```

Install a generated VSIX with:

```bash
code --install-extension mikrobus-rust-tools-<version>.vsix --force
```

Then reload VS Code:

```text
Ctrl+Shift+P
Developer: Reload Window
```

---

# Quick reference

```text
ENVIRONMENT
  Rust/rustup/cargo        System
  probe-rs 0.32.0          System/user Cargo bin
  udev / ST-Link driver    System
  J-Link/J-Flash           Optional system tool
  OpenOCD 0.12.0-7         Extension managed
  ARM GCC 14.2.1-1.1       Extension managed
  database                 Extension managed; latest Rusty_MikroBUS release
  SDK                      Extension managed; latest Rusty_MikroBUS release
  core                     Extension managed; latest Rusty_MikroBUS release

BUILD
  Ctrl+Shift+B
  cargo build

FLASH
  Ctrl+F5
  cargo build
  cargo flash --chip <MCU> --connect-under-reset

DEBUG
  F5
  cargo build --bin mikrobus_debug_current
  Windows: probe-rs dap-server (stdin/stdout)
  Linux/macOS: probe-rs dap-server --port <localhost-port>
  flash ELF
  halt after reset
  stop at first executable line of main()
  use normal VS Code breakpoints
  print exposed locals/statics/globals to Debug Console

ERASE
  Erase MCU button
  probe-rs erase --chip <MCU>

MCU SETUP
  Database + MCU JSON + core + SDK
  -> core_header.rs
  -> memory.x
  -> startup.s
  -> MCU header
  -> init_clock.rs
  -> .cargo/config.toml
  -> pin mapping crate
  -> family-specific low-level implementation files
```

---

# License / project status

The current extension manifest is marked:

```text
UNLICENSED
```

This README describes the current development implementation and should be updated together with the extension when package versions, supported devices, download sources, setup schema or build/debug architecture change.
