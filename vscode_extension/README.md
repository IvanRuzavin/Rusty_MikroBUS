# MikroBUS Embedded Tools

MikroBUS Embedded Tools adds reusable Rust and C MCU setups to VS Code. The existing Rust workflow is preserved. C support follows the NECTO setup order: install package dependencies, generate the MCU core configuration, build/install the core, and (for a full setup) build/install the selected mikroSDK on top of that core.

## C support at a glance

- The daily NECTO SQLite database drives MCU, compiler, SDK, package, board/card BSP and programmer compatibility.
- Compiler choices come from `CompilerToDevice` and are offered only when the selected device also resolves a compiler-specific core package from `Devices.installer_package`.
- `Compilers.c_compiler`, `cxx_compiler`, `asm_compiler`, `gdb_path`, `core_path` and `installer_package` are used directly by the managed toolchain/setup flow.
- The Development Environment has separate managers for **Compiler packages**, **Programmers**, **CODEGRIP packages**, **MCU Core packages**, **MCU Card BSP packages**, and **Board BSP packages**.
- Compiler, core and BSP packages are installed on demand when a setup needs them; the large monolithic C core bundle is no longer required.
- Full SDK setups use the latest `mikrosdk.7z` release plus only the required board/card BSP packages.
- Bare-metal setups build only the selected compiler-specific MCU core.
- CODEGRIP and SEGGER J-Link remain available according to database programmer mappings.

The C compiler adapter catalog covers every compiler currently connected to the `cmake` build system in the supplied NECTO database: GNU ARM, GNU RISC-V, Clang ARM/RISC-V, XC8/XC16/XC32, mikroC AI ARM/PIC/PIC32/dsPIC/AVR, LLVM RL78 and GCC RX.

## C workflow

1. Install the extension and open a workspace.
2. In the MikroBUS activity view, select **C**.
3. Open **Development Environment** and install/refresh the shared database/SDK/infrastructure packages. Compiler packages can be managed separately with **Compiler packages**.
4. Click **Create & Build C Setup** and select an MCU or board.
5. The compiler selector shows only compilers mapped to that target by `CompilerToDevice` that also have a matching core package mapping in `Devices.installer_package`.
6. Select the compiler, SDK mode, package, programmer and clock configuration. Building the setup automatically installs the selected compiler package and its compiler-specific core package if they are missing.
7. For a board/full-SDK setup, the required MCU-card and board BSP packages are installed and overlaid into the lightweight mikroSDK base.
8. Apply the reusable setup to a project whose root contains `CMakeLists.txt`, then build/flash/debug from the C commands.

Workspace output is placed in `.mikrobus/c-build`. Reusable setup artifacts and installed packages live under the extension-managed storage root.

## Managed C package sources

The C workflow does not query Kibana/Elasticsearch at runtime. Package identity and compatibility come from the local daily database, while downloads use direct package/release assets:

- database: daily `database_live.7z`;
- MCU cores: `core_packages` metadata + each package's `release_tag`;
- mikroSDK and BSPs: latest `mikrosdk_v2` GitHub release;
- compiler toolchains: direct NECTO compiler assets associated with `Compilers.installer_package` (with the existing xPack ARM GCC package retained for GNU ARM);
- infrastructure/programmers: the existing direct general-package and programmer assets.

Core selection is compiler-specific. For normal device rows, `Devices.installer_package[compilerUid]` identifies the core archive. For MCU-card relation rows, `Devices.sdk_config.MCU_NAME` resolves the actual MCU row first, then that MCU's compiler-keyed core mapping is used. `Compilers.core_path` provides the expected architecture/compiler subtree.

## Package installation behavior

Package installation is transactional:

- metadata is resolved before download;
- archives are downloaded to a staging directory;
- SHA-256 is checked when a hardcoded package entry provides one;
- the bundled 7-Zip extractor handles `.7z` packages;
- an existing package is replaced only after a new payload extracts successfully;
- installed state is recorded atomically;
- concurrent requests for the same package share one install operation.

All managed C packages are visible on the installed-packages page. If a removed package is referenced by a setup, the next setup/project build restores it automatically.

CMake and Ninja are host build tools. They are resolved from PATH, or can be set with `mikrobusRust.cCmakePath` and `mikrobusRust.cNinjaPath`.

## Hiding C support before packaging

Open `feature_flags.js` and change exactly this line:

```js
const C_LANGUAGE_SUPPORT = true;
```

to:

```js
const C_LANGUAGE_SUPPORT = false;
```

Then package the extension normally. The extension sets `mikrobusRust.cSupportEnabled` to false, does not register any C handlers, and all C Command Palette entries, editor buttons and keybindings remain hidden. Change it back to `true` for the Rust + C build.

## Existing Rust support

The Rust workflow remains available from the MikroBUS activity view. It provides reusable MCU/board setups, Rust SDK and BSP management, Rust Analyzer configuration, probe-rs/J-Link support, CODEGRIP USB discovery, project build/flash/debug/erase actions and managed development-environment packages.

## Packaging

```bash
npm install
npm run check
npm test
npm run build
```

Install the generated VSIX with **Extensions → Install from VSIX…**. Cortex-Debug remains an extension dependency and is used for GDB debugging.

## C visual hardware configuration

The C workflow now has the same visual starting point as the Rust workflow. Open **Create & Build C Setup** and choose **MCU** or **Board**. Board selection is resolved through the C database, and compatible MCU rows are shown when a board supports more than one device. The board-MCU table has its own search field.

For the selected target/compiler pair, the extension resolves `Compilers.core_path`, the compiler-keyed core package from `Devices.installer_package`, and `Devices.sdk_config.MCU_NAME`, then loads the matching core definition and renders all visible `config_registers` fields as GUI selectors. Those selections are written into the generated `core_header.h` used for the C core build.

The managed C environment also installs the hardcoded `unit_test_lib`, `preinit`, and `mikroe_utils_common` general packages required by the mikroSDK/core CMake flow.

## C core header generation

For C setups the selected clock/register values are resolved from the target definition JSON and rendered through `include/core_header.h.in`. The canonical generated header is written to the core CMake binary directory as `build/core/core_header.h`, because the core install rules install `${CMAKE_BINARY_DIR}/core_header.h`. A temporary copy is mirrored to the core source `include/core_header.h` only while the core target is being compiled, then the packaged core source is restored unchanged.

### C board and shield metadata

For full mikroSDK setups created from a board, the extension reads `Boards.sdk_config` from the bundled C database. NECTO metadata keys are translated for mikroSDK CMake as follows:

- `_MSDK_BOARD_NAME_` -> `MSDK_BOARD_NAME`
- `_MSDK_SHIELD_` -> `MSDK_SHIELD` when the shield field is present

MCU-only setups continue to use `MSDK_BOARD_NAME=GENERIC_BOARD`. The original sdk_config values (for example `HAS_MIKROBUS`) remain available in the generated toolchain cache as well.

### v0.4.6 C SDK setup fixes

- `MCU_FLASH` and `MCU_RAM` are taken directly from `Devices.flash` / `Devices.ram` as byte values and are passed to the mikroSDK configure as well as the generated toolchain cache.
- Full mikroSDK setups now use a two-stage SDK build. The first pass installs the driver/HAL packages, then the SDK is reconfigured so the BSP/Board package can discover those packages through `CMAKE_PREFIX_PATH`.
- For non-AI-generated targets the setup validates the base mikroSDK driver set: ADC, GPIO In/Out/Port, I2C Master, PWM, SPI Master, UART and OneWire.

## C application output

C setups expose the same application-output choice used by NECTO:

- **Debug Terminal (printf_me)** sets `LOG_INTERFACE=LOG_INTERFACE_STDOUT`. mikroSDK builds/exports the STDOUT logger, and `LOG_MAP_USB_UART()` becomes a pin-independent compatibility macro.
- **UART** sets `LOG_INTERFACE=LOG_INTERFACE_UART`. mikroSDK builds/exports the UART logger and `LOG_MAP_USB_UART()` uses the selected board's `USB_UART_RX` / `USB_UART_TX` definitions.

The selected value is stored in `setup.json`, written to generated toolchains, and passed explicitly while building mikroSDK. Existing setups migrate to Debug Terminal when rebuilt.

## C project/sidebar workflow (0.4.9)

Applying a C setup to an existing CMake project only writes `.vscode/mikrobus-c.json`; it does not create or modify application sources. A starter `CMakeLists.txt` and `src/main.c` are generated only for an empty workspace with no existing C/C++ sources.

Normal C builds now detect the final ELF executable even when the project's CMake target has no `.elf` suffix, then generate a sibling Intel HEX file with `arm-none-eabi-objcopy -O ihex`. The ELF remains the debug-symbol executable and the HEX is used for programming.

The C sidebar now mirrors the Rust setup dashboard: configured C setups are listed as cards with Apply, Rebuild and Remove actions. The only top-level actions are Configure MCU or Board and Development environment; an empty C setup list shows Configure my first setup.

## C Debug/J-Link parity (0.5.0)

C core and mikroSDK setup artifacts are now built with `CMAKE_BUILD_TYPE=Debug`, matching the Debug application build instead of mixing Release setup libraries with a Debug project. This keeps startup/core/SDK debug information and code-generation behavior aligned with the final application image.

SEGGER J-Link programming/debugging mirrors the NECTO plugin flow:

1. Build the project ELF and HEX.
2. Normalize Renesas R7 device names the same way as NECTO (remove the final four package characters before passing `-device`).
3. Program the HEX through `JLinkExe` using SWD at 4000 kHz.
4. Start `JLinkGDBServerCLExe` on port 2331 with `-singlerun`.
5. Start Cortex-Debug against that external server using the ELF for symbols and `loadFiles: []`, so GDB does not re-flash a different image.

`mikrobusRust.jlinkCommanderPath` and `mikrobusRust.jlinkGdbServerPath` can override SEGGER locations. If left empty, the extension checks PATH, the standard NECTO `packages/programmers/segger` directory and common SEGGER install roots.


## C debug entry breakpoint (0.5.2)

Renesas J-Link device normalization is restored to the existing NECTO behavior: R7 device UIDs have the final four package characters removed before `-device` is passed to SEGGER.

When **Debug** starts, the extension locates the project's `main.c` (preferring the active editor and the root `CMakeLists.txt` source references), finds the first executable-looking line inside `main()`, and adds a temporary VS Code source breakpoint there. Existing user breakpoints are reused rather than duplicated. A breakpoint created by the extension is removed automatically when that MikroBUS C debug session ends.

## C setup runtime additions (v0.5.3)

- Every generated C toolchain defines `PREINIT_SUPPORTED` globally.
- J-Link debugging uses Cortex-Debug's native `jlink` server type after the existing HEX pre-program step, so VS Code Restart/Stop owns the SEGGER server lifecycle.
- CODEGRIP setup creation downloads the live device-pack catalog from `https://s3.us-west-2.amazonaws.com/software-update.mikroe.com/Codegrip/live/Codegrip-Prog-Debug.csv`.
- When CODEGRIP is selected, the exact MCU row is resolved, the platform `CodegripGdbServer` package and catalog dependencies are installed, and MCU pack archives are overlaid into a setup-local `codegrip/packs` tree following the CSV `install_location` path.
- `setup.json` persists the catalog resolution plus `codegripRuntime.serverExecutable`, `codegripRuntime.packsRoot`, and per-pack installed/source paths. Flash/debug uses these stored paths first.
- Existing CODEGRIP setups are migrated when build support changes or when their stored runtime paths disappear.

## C setup maintenance / CODEGRIP reliability (0.5.4)

- Applying a C setup now removes the extension-owned `.mikrobus/` project tree and the previous `.vscode/mikrobus-c.json` binding before writing the new setup binding. Project `CMakeLists.txt` and source files are never touched.
- Each configured C setup card now has **Reconfigure**, which reopens the visual C configurator with the existing MCU/board, clock, register values, MCU package, programmer and Application Output preselected. Reconfiguration keeps the same setup ID but rebuilds generated core/SDK/toolchain output from a clean setup build/install tree.
- The C CODEGRIP server installer now follows the Rust-side package contract: it locates a payload containing `apps/.../CodegripGdbServer` plus `packs/`, validates the installed layout, fixes executable permissions, and automatically reinstalls malformed legacy `codegrip_gdb_server@1.7.0` package contents.
- J-Link Stop has an additional fallback for debugger/server combinations that stall on a direct disconnect: the extension automatically issues the same **Restart then Stop** sequence that works manually, while guarding against recursive stop requests.

### C development environment manager (v0.5.5)

When the sidebar is in C mode, **Development environment** now opens a C-specific package manager instead of immediately installing packages. It lists the extension-managed C database, core, mikroSDK, infrastructure support packages, and ARM GCC with current install state. The page provides **Install all**, individual Install actions for missing packages, and **Uninstall** for installed packages.

Programmer/debugger packages are managed separately through **Installed programmer packages**. That view lists installed `programmer` and `programmer-pack` entries such as `codegrip_gdb_server` and MCU-specific CODEGRIP packs, with uninstall actions and setup-use information.

The CODEGRIP server archive is no longer required to contain a populated `packs/` directory. `CodegripGdbServer` is installed from the platform server archive, while MCU device packs are resolved independently from `Codegrip-Prog-Debug.csv` and materialized into each CODEGRIP setup's own `codegrip/packs` tree.


### v0.5.6 CODEGRIP package compatibility

The C CODEGRIP installer now accepts historical and package-style server executable names (`CodegripGdbServer`, `codegrip_gdb_server`, and `codegrip-gdb-server`), checks nested archives inside the downloaded CODEGRIP bundle, and can reuse an existing Rust-managed, NECTO-installed, configured, or PATH CODEGRIP server by copying it into the C-managed package root. MCU device packs remain resolved separately from `Codegrip-Prog-Debug.csv`.

The **Installed Programmer Packages** page now includes a **Back** button that returns directly to the C **Development Environment** page.

### v0.5.7 CODEGRIP attach and MCU erase

- C CODEGRIP debugging now uses Cortex-Debug `request: attach`, matching the working Rust CODEGRIP path. The image is programmed with `debugEnable=true` before attach, and `overrideAttachCommands` prevents Cortex-Debug from sending unsupported `monitor reset halt` / `monitor halt` Rcmd commands to CodegripGdbServer.
- After CODEGRIP attach/configuration completes, the extension continues from the server's initial halted state to the existing automatic first-line breakpoint in `main.c`.
- C projects now expose an **Erase MCU** editor action next to Build / Flash / Debug. J-Link uses a JLink Commander `erase` script; CODEGRIP uses the configured control-server erase command.

### C CODEGRIP Restart and Stop lifecycle (v0.5.8)

C CODEGRIP debug sessions now suppress Cortex-Debug's generic reset/end-session monitor commands. VS Code Restart performs a full CODEGRIP debug relaunch (stop the current GDB/session and server, then program/start/attach again), while Stop first allows a clean GDB disconnect and force-closes CodegripGdbServer after a short grace period if the external session stalls.


### C CODEGRIP debugger lifecycle (v0.5.9)

CODEGRIP C debugging now uses a Cortex-Debug `launch` session with launch/reset commands overridden so no flash/reset monitor commands are sent. The target is programmed before debugging, and the external CodegripGdbServer remains alive across VS Code Restart. Stop Debugging first executes the GDB-local `disconnect` command; the extension then terminates CodegripGdbServer, with a delayed force-close only as a fallback.

### C CODEGRIP debugger lifecycle (v0.6.0)

C CODEGRIP debugging now mirrors the NECTO CODEGRIP plugin's server lifetime instead of keeping CodegripGdbServer persistent. After programming with `debugEnable=true`, the extension starts a fresh server with the equivalent of NECTO's `ServerClose::CloseAfterDebug` (`--stop gdb`), applies the saved CODEGRIP options/device selection through the control port, and then disconnects the control client.

For the VS Code debugger frontend, C CODEGRIP sessions now use Microsoft's `cppdbg` adapter rather than Cortex-Debug's external-server mode. `cppdbg` connects directly through `miDebuggerServerAddress`, loads symbols from the built ELF without downloading it, installs normal VS Code source breakpoints, and uses `launchCompleteCommand: exec-continue` so the CODEGRIP-halted target runs to the automatically-created first executable line in `main.c`. When GDB disconnects, `--stop gdb` lets CodegripGdbServer terminate naturally; the extension retains only a delayed process cleanup fallback.

J-Link debugging remains on Cortex-Debug's native J-Link server integration.

### CODEGRIP serialized Restart lifecycle (v0.6.1)

CODEGRIP keeps the working NECTO-style `--stop gdb` + `cppdbg` path. Stop Debugging is unchanged. Restart requests (`restart` or DAP `disconnect` with `restart: true`) are recorded, the extension waits for `onDidTerminateDebugSession`, and only after the previous GDB/debug adapter has fully terminated does it invoke the normal fresh CODEGRIP debug flow. This rebuilds if necessary, programs with `debugEnable=true`, allocates fresh dynamic ports, starts a new `--stop gdb` server, recreates the automatic `main.c` breakpoint, and starts `cppdbg`. There is no fixed restart delay and no overlap between old and new CODEGRIP sessions.


### Compact CODEGRIP restart sessions (v0.6.2)

CODEGRIP Restart still creates a fresh `--stop gdb` server and a fresh `cppdbg` session after the previous session has fully terminated, but replacement sessions are now started as compact child sessions of the session they replace. VS Code therefore collapses the superseded parent in the CALL STACK instead of accumulating visible CODEGRIP session entries. The dynamically-created CODEGRIP debug configuration is also marked `presentation.hidden`. Each CODEGRIP server/debug session has an internal generation ID; cleanup from an older session is ignored if a newer generation is active, so Restart always operates on the newest CODEGRIP runtime.

## Rust programmer integration (0.6.3)

Rust CODEGRIP setups now use the same live programmer-package model as C. When a CODEGRIP setup is created or an older setup needs migration, the extension resolves the exact MCU name through `Codegrip-Prog-Debug.csv`, installs `codegrip_gdb_server` plus the required MCU device-pack dependencies in the shared programmer cache, and materializes a setup-local `codegrip/packs` tree. The resolved catalog and runtime paths are stored with the Rust setup.

The CODEGRIP server package is shared between Rust and C. The Rust Development Environment now detects/installs that shared `codegrip_gdb_server` package rather than requiring a separate monolithic Rust `runner/codegrip` package with all MCU packs bundled inside it.

Rust **SEGGER J-Link** setups now use SEGGER J-Link directly through Cortex-Debug instead of routing J-Link through probe-rs DAP. J-Link debug uses the native J-Link GDB server at 4 MHz SWD, while Rust Flash and Erase use J-Link Commander. probe-rs remains the fallback for programmer profiles that are neither CODEGRIP nor SEGGER J-Link.

The Rust `main()` entry-line parser now places the temporary source breakpoint on the first executable-looking statement in the function body. For a multiline boolean initialization expression this prevents the automatic entry breakpoint from being placed on a continuation such as the second `|| digital_out_init(...)` line. Native J-Link additionally uses the exported `main` symbol as its run-to-entry point.

## Rust programmer probe routing (0.6.4)

On Linux, selecting **SEGGER J-Link** now distinguishes the installed SEGGER software from a physically connected J-Link USB probe. A real SEGGER USB probe (VID `1366`) keeps the native J-Link/Cortex-Debug path. If no physical J-Link is present, the Rust workflow falls back to probe-rs so onboard probes such as the Nucleo ST-LINK can still flash, erase and debug instead of timing out inside JLinkGDBServer/JLinkExe.

The probe-rs fallback now attempts a normal SWD connection first. Flash operations retry once with connect-under-reset only if normal connection fails, and debug no longer forces connect-under-reset by default. This keeps normal Nucleo/ST-LINK startup fast while retaining an under-reset recovery path for targets that need it.


## Rust setup UX and lazy CODEGRIP discovery (0.6.5)

- Rust configured-setup action buttons use the same single-row layout as C setup cards.
- A Rust setup using CODEGRIP can be built without a CODEGRIP connected by USB. Setup creation only resolves/downloads the shared CODEGRIP server and the MCU-specific pack(s) from the live `Codegrip-Prog-Debug.csv` catalog.
- If a Rust CODEGRIP setup has no saved USB connection, Flash, Debug, or Erase performs USB discovery on demand. One discovered device is selected automatically; multiple devices produce a quick-pick. The selected USB CODEGRIP is then stored in the reusable setup for later operations.

## Rust BoardToCard MCU selection (0.6.6)

Boards backed by `BoardToCard` are now shown once in the Rust board catalog and expose an MCU selector after the board is opened. The selector is populated from every valid `BoardToCard -> MCUCard -> CardToMCU` relationship rather than only `IS_DEFAULT` rows.

Selecting an MCU automatically resolves the matching MCU card and stores its UID/name/BSP path in the reusable setup and workspace binding. Setup generation validates the relationship against the database and copies the selected `board.cfg` and `card.cfg` into `.setup/bsp/` with a `selection.json` manifest. When a board/shield setup generates `mikrobus.rs`, the selected card configuration is overlaid on the generic board configuration so MCU-card pin mappings are applied automatically.

This means a dedicated one-MCU alias card is no longer required. For example, after removing `STM32F756ZG_MCU_CARD`, `UNI_DS_V8 + STM32F756ZG` resolves through `MCU_CARD_FOR_STM32` and uses `bsp/cards/mcu_card_for_stm32/card.cfg`.

## Rust board MCU table, project mikrobus sync and database refresh (0.6.7)

- Opening a board that uses `BoardToCard -> MCUCard -> CardToMCU` now shows its compatible MCUs in a dedicated table instead of a drop-down. The table uses the same MCU metadata as the main MCU catalog and also shows the resolved MCU card.
- Board/shield setup generation now stores the generated `mikrobus.rs` inside the reusable setup at `.setup/bsp/mikrobus.rs`. Applying a setup copies that exact file beside the project's `main.rs`, overwriting an older mapping. Applying a setup with no generated `mikrobus.rs` removes stale project-level `mikrobus.rs` files from the project root or `src/`.
- **Refresh database** in the Rust Hardware Configuration window now downloads the latest `database_mikro_sdk_rust.db` release asset through the managed package installer and atomically replaces the local managed database instead of only re-reading the existing file.

## Native board mikroBUS generation without shields (0.6.8)

- Rust board setups now attempt to generate `.setup/bsp/mikrobus.rs` for every selected board, even when **No shield** is selected.
- If `board.cfg` exposes a native `mikrobus` mapping, it is resolved after any selected MCU-card overlay and written to `mikrobus.rs`.
- When a shield is selected and provides its own `mikrobus` mapping, that shield routing takes precedence. A shield is therefore optional rather than a prerequisite for generation.
- Boards with no compatible shields show the shield selector disabled/grayed out. Boards with compatible shields keep the selector enabled and still allow **No shield**.
- The reusable setup manifest records whether mikroBUS generation was attempted successfully, so older v0.6.7 board setups are rebuilt once and boards without a resolvable mapping are not rebuilt on every Apply.

## C on-demand core and BSP packages (0.7.0)

- The C database package now uses the daily `database_live.7z` asset from `MikroElektronika/general_packages`. The Development Environment treats it as a live/refreshable package so the same URL can be downloaded again after the database is updated.
- The monolithic `C_core` package is no longer part of the C Development Environment. The selected MCU core package is resolved from `Devices.installer_package`, matched against the official `core_packages` `metadata.json`, downloaded from its `release_tag`, and installed in its metadata-defined `packages/core/<architecture>/<compiler>/<package>` folder.
- The Development Environment now opens separate package managers for **Programmers**, **MCU Core Packages**, **MCU Card BSP Packages**, and **Board BSP Packages**, with install/update/uninstall actions.
- Full mikroSDK setups resolve the latest `mikrosdk.7z` release dynamically. The SDK base is lightweight; the selected MCU-card and board BSP archives are installed on demand from the same mikroSDK release.
- MCU-card BSP destination folder names come from `_MSDK_MCU_CARD_NAME_` in the database rather than from the archive name. Board package destinations use `_MSDK_BOARD_NAME_`.
- Before a full-SDK setup is built, the required core, MCU-card BSP, and board BSP packages are ensured automatically. The setup-specific BSP overlay is rebuilt cleanly so stale board/card files from a previous setup are not reused.
- This release intentionally does **not** include Renesas `rfp-cli` integration or CMake file-graying/visibility work.

### v0.7.0 follow-up: GNU ASM driver and package/MCU filtering

- GNU ARM CMake builds now use `arm-none-eabi-gcc` as the ASM driver instead of invoking raw `arm-none-eabi-as`. This prevents CMake target definitions such as `PREINIT_SUPPORTED`, `_INCLUDE_INTERRUPT_CASES_`, and `OSC_KHZ=...` from becoming invalid `--defsym NAME` arguments.
- The compatible-MCU table shown after selecting a board now has its own search field and result count.
- Core, board, MCU-card, programmer and environment package views have a clickable installed-package counter that toggles an **installed only** filter. Packages with an available update are considered installed for this filter.
- Development Environment now exposes a separate **CODEGRIP packages** window containing the installed CODEGRIP server and MCU-specific `programmer-pack` packages used by C or Rust setups.


### v0.7.1 compiler packages and multi-toolchain setups

- Added a separate **Compiler Packages** manager with search, installed-only filtering, install, update and uninstall actions.
- Setup creation now enumerates compiler choices from `CompilerToDevice`; the selected compiler must also resolve a compiler-specific core package from `Devices.installer_package`.
- Compiler packages are installed automatically when a setup requiring them is built.
- The generated CMake toolchain resolves compiler binaries from the selected `Compilers` row instead of assuming ARM GCC.
- GNU compiler families use their compiler driver for CMake ASM while retaining the raw `asm_compiler` binary for explicit assembler jobs. This also avoids the invalid raw-GNU-as `--defsym NAME` issue for target compile definitions.
- The current adapter set covers all 14 compiler IDs mapped to CMake in the supplied database.

### GNU ARM compiler / assembler handling

For GNU ARM, `Compilers.c_compiler` and `Compilers.asm_compiler` are treated as two distinct installed binaries. The raw assembler remains available from the database metadata, but CMake ASM targets use the GCC driver so mikroSDK compile definitions are passed as `-D...` rather than invalid bare `--defsym` arguments. Generated toolchain files force this choice in the CMake cache and print both compiler paths during configuration.
