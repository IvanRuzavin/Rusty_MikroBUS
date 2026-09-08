## v0.7.46

### Environment and Click Board workflow improvements

- Rust Environment hardware catalogs now include board and MCU-card MCU search, simplified MCU/Vendor tables, and cleaner board tables without status columns.
- Rust Development Environment uses a larger C-style layout and buttons.
- The shared managed installation root can be changed from either C or Rust; installed content is migrated to the new path and removed from the old path.
- C Environment adds Click Board Examples with metadata download, search, category filtering, install/uninstall, and Open Project.
- C Environment adds Demo Examples with metadata download, search, install/uninstall, and Open Project.

## v0.7.45

### Debug fixes in 0.7.45

- RL78/G24 E2/E2 Lite debugging now uses the native Renesas Debug adapter instead of routing RL78 GDB through `cppdbg`. This removes the incorrect x86_64 architecture fallback and the pause/step `Cannot find bounds of current function` failure seen with the direct MI path.
- mikroC + CODEGRIP now sends the complete mikroDap debugger settings (`resetType`, `connectionType`, `speed`, `protocol`, and `Programming Type`) during DAP initialization, using the same per-MCU NECTO defaults already applied to CodegripGdbServer (for example PIC32 uses 2-wire EJTAG), and logs the effective initialization values.


- mikroC/mikroDap now installs a private matching Qt 6.9.1 Linux x64 runtime while rebuilding a mikroC setup. This prevents Ubuntu/system Qt modules such as Qt6DBus/Gui/Widgets/Network/Sql from being mixed with NECTO's Qt 6.9.1 Core and eliminates private-ABI symbol lookup failures.
- The private Qt runtime is downloaded from Qt's official 6.9.1 online repository and is used only for mikroDap through `LD_LIBRARY_PATH`/Qt plugin paths.
- C build-support revision is 56, so existing mikroC setups are restored/rebuilt once and receive the managed debugger runtime automatically.

## Changes in v0.7.43

- RL78/G24 E2/E2 Lite debug no longer relies on the Renesas VS Code adapter's incorrect `SINGLE_CORE` classification. For G24, the extension programs the HEX with RFP/`uart1`, launches Renesas `e2-server-gdb` directly, and connects through `cppdbg` using the RL78 GDB client.
- The direct G24 server command mirrors the known-good e2 studio topology: `-uCore= CPU|enabled|256|main`, `-uTraceCore= CPU`, target power off, and the matching G24 flash/reset parameters. RX continues to use `renesas-hardware`.
- e2 studio DebugComp files are preferred when present (known-good on the tested G24); otherwise the extension falls back to Renesas Platform / VS Code RL78 Support Files.

# MikroBUS Embedded Tools

## v0.7.37

- mikroC AI targets that already link directly to Intel HEX are now accepted as the final programming artifact. No objcopy/bin2hex conversion tool is required for those targets.


## v0.7.36

- Seeds `TOOLCHAIN_LANGUAGE` on the first workspace CMake configure command, matching NECTO/mikroSDK pre-`project()` language selection. This prevents the first configure from falling back to host C/ASM and reporting a missing `CMAKE_MikroC_COMPILE_OBJECT` before a second configure succeeds.


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

Ninja is resolved from PATH (or `mikrobusRust.cNinjaPath`). Non-mikroC setups use the configured/host CMake. mikroC setups install the managed NECTO CMake package plus the dedicated `mikroc_cmake` language-module package into `c-runtime/packages/tools`, so they do not depend on a host CMake implementation of the custom `MikroC` language.


## mikroC AI CMake and JCFG support

mikroC AI setups keep the compiler executable, CMake and build artifacts under the extension-managed `c-runtime` tree. The setup installs the managed CMake package and the four custom MikroC language modules (`CMakeDetermineMikroCCompiler.cmake`, `CMakeMikroCCompiler.cmake.in`, `CMakeMikroCInformation.cmake`, and `CMakeTestMikroCCompiler.cmake`). No local NECTO Studio installation is searched or required.

For each mikroC setup the extension generates `<MCU_NAME>.jcfg` from the selected MCU definition JSON using the same configuration-register calculation as NECTO `me.mcu`: selected/init field values are masked in, default bits outside defined fields are preserved, and `unused` bits are cleared. The JCFG remains a positional mikroC compiler input, while `-p${MCU_NAME}` is left untouched by the extension.

The generated toolchain now mirrors NECTO's `CMakeUtils::writeToolchainFile()` search-path model: `SEARCH_PATHS` is `${CMAKE_BINARY_DIR};<selected core>/def;${CMAKE_SOURCE_DIR}`. `.mcl` / `.emcl` files are treated as compiler-generated object outputs, not package prerequisites. The extension does not search for `.mlk`, does not rewrite PIC/PIC32/dsPIC MCU names, and does not generate a compiler wrapper. After the core is installed, `CORE_LIB` points at the generated `lib_core.a` for mikroSDK and application builds.

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

### v0.7.0 follow-up: GNU ASM driver and package/MCU filtering

- GNU ARM CMake builds now use `arm-none-eabi-gcc` as the ASM driver instead of invoking raw `arm-none-eabi-as`. This prevents CMake target definitions such as `PREINIT_SUPPORTED`, `_INCLUDE_INTERRUPT_CASES_`, and `OSC_KHZ=...` from becoming invalid `--defsym NAME` arguments.
- The compatible-MCU table shown after selecting a board now has its own search field and result count.
- Core, board, MCU-card, programmer and environment package views have a clickable installed-package counter that toggles an **installed only** filter. Packages with an available update are considered installed for this filter.
- Development Environment now exposes a separate **CODEGRIP packages** window containing the installed CODEGRIP server and MCU-specific `programmer-pack` packages used by C or Rust setups.



### v0.7.18 mikroC compiler parity fixes

- mikroC setup builds no longer leave `SEARCH_PATHS` empty. The generated toolchain discovers the managed compiler directory plus `Defs`, `Uses`, and directories containing `.mcl`/`.emcl` libraries and passes them through the core's existing `SEARCH_PATHS` mechanism. This fixes mikroC `error[432]: At least one Search Path must be specified`.
- Debug mikroC setup builds now mirror NECTO's common compiler options: `-C -SSA -MF -O11111114 -DBG -UICD`.
- PIC32 and ARM mikroC targets use `.emcl` intermediates, while PIC, dsPIC/PIC24, and AVR retain `.mcl`, matching the native compiler families.
- Generated normal CMake targets also receive the discovered `-SP...` paths, and static-library/application rules always include the current build directory as a search path.
- Auto-generated application projects use `LANGUAGES MikroC` when a mikroC setup is applied instead of incorrectly enabling `C ASM`.

### v0.7.9 Renesas RL78/RX compiler integration fixes

- LLVM RL78 application builds now mirror the NECTO RL78 core code model and link with `-nostartfiles`, preventing the compiler runtime `crt0.o` from colliding with the mikroSDK startup implementation of `__rl78_init`, `__rl78_fini`, `_rl78_run_init_array`, and `_rl78_run_fini_array`.
- LLVM RL78 application links now receive the installed MCU-specific `.ld` linker script, just like GNU/Clang ARM and RX targets.
- RX GCC no longer converts `CORE_NAME=RXv3` into the invalid `-mcpu=rxv3`. RX26T and generic RXv3 setups use the compiler-supported `rx66t` compatibility profile; exact RX13T/RX140/RX66T/RX72T families use their matching GCC profile.
- The C build-support revision is bumped so existing RL78/RX setups regenerate their toolchain files automatically.


### v0.7.35 mikroC object filename compatibility fix

- Fixed user-project and mikroSDK object names being generated as `main.c.emcl`, `log.c.emcl`, etc. instead of NECTO-compatible `main.emcl`, `log.emcl`.
- Sets `CMAKE_MikroC_OUTPUT_EXTENSION_REPLACE=1` in both the generated toolchain cache and generated MikroC compiler language metadata.
- This fixes mikroC linker `error[304]: object file name [...] does not match source file name [...]`.
- Applies to both `.emcl` families (ARM/PIC32) and `.mcl` families (PIC/dsPIC/AVR).
- C build-support revision 51 forces existing managed setups to regenerate.

### v0.7.34 mikroSDK mikroC compiler flags fix

- Propagates the resolved mikroC option string (`-C`, `-SSA`, `-MF`, optimization/debug flags, plus MCU compiler/linker flags) to `CMAKE_MikroC_FLAGS`, which is what the generic `CMakeMikroCInformation.cmake` compile rule consumes through `<FLAGS>`.
- Keeps `COMPILER_FLAGS`/`LINKER_FLAGS` populated for core-package compatibility and mirrors NECTO's toolchain generator by using the same resolved flag string for compiler and linker contexts.
- Fixes SDK failures where case-sensitive identifiers such as `bitmap_A`/`bitmap_a`, `LOG_ERROR`/`log_error`, and uppercase function-like macros collided because `-C` was missing from generic mikroC SDK compile commands.
- C build support revision is now 50 so existing setups regenerate their toolchains.

### v0.7.33 mikroSDK mikroC language bootstrap fix

- Passes `TOOLCHAIN_LANGUAGE=MikroC` on the mikroSDK CMake configure command line, matching NECTO.
- This is required because mikroSDK chooses `LANGUAGES MikroC` before `project()` loads `CMAKE_TOOLCHAIN_FILE`.
- Prevents the SDK bootstrap from silently selecting host GCC/Clang (`/usr/bin/cc`) for mikroC setups.
- Keeps the direct mikroC compiler and NECTO-equivalent core `def` search-path flow introduced in v0.7.32.

### v0.7.32 NECTO-equivalent mikroC CMake flow

- Removes `.mlk` / `Defs` / `Uses` discovery from the compiler package and removes the generated mikroC compiler wrapper.
- `CMAKE_MikroC_COMPILER` now points directly at the managed compiler executable and `-p${MCU_NAME}` is left unchanged.
- `SEARCH_PATHS` now mirrors NECTO: `${CMAKE_BINARY_DIR}`, the selected mikroSDK core `def/` directory, and `${CMAKE_SOURCE_DIR}`.
- `.mcl` / `.emcl` are treated as generated build outputs, matching the NECTO application source.
- Linux uses the existing per-family mikroC compiler packages directly and therefore does **not** download `mikroc_compilers.7z`. The aggregate bundle is retained only as a Windows/macOS fallback.
- Removes remaining local `~/.MIKROE/NECTOStudio7/...` filesystem fallbacks from database, CODEGRIP and J-Link discovery so the extension does not depend on an installed NECTO Studio.
- Build-support revision is 48 so existing C setups regenerate their toolchain files.

### v0.7.31 standalone mikroC compiler bundle (superseded by v0.7.32)

- All mikroC compiler families now use one standalone release asset: `mikroc_compilers.7z` from the Rusty_MikroBUS v0.0.1 GitHub release.
- The installer selects only the relevant family subtree (`ARM/mikroC`, `PIC/mikroC`, `PIC32/mikroC`, `dsPIC/mikroC`, or `AVR/mikroC`) and installs it into the existing managed compiler path.
- mikroC setup discovery no longer probes `~/.MIKROE/NECTOStudio*`; a local NECTO installation is neither required nor used as a fallback.
- The standalone bundle must include each family's `Defs` payload referenced by its `toolchain_definitions/manifest.json`; `Uses` should also be included for complete runtime/library resolution.

### v0.7.30 mikroC Defs/Uses compatibility fallback

- Keeps the extension-managed mikroC executable as the active compiler.
- Searches the managed compiler package first for the selected MCU `.mlk` and matching `Uses` libraries.
- If that payload is absent, discovers installed `~/.MIKROE/NECTOStudio7*` compiler trees and uses only their matching `Defs/Uses` directories as a compatibility source.
- Rewrites `-p${MCU_NAME}` only to the basename of a definition file that was actually found, e.g. `PIC32MZ2048EFH144` -> `P32MZ2048EFH144`.
- Bumps C build-support revision to 46 so existing mikroC setups regenerate automatically.

### v0.7.29 mikroC required device selector fix

- Fixes mikroC `error[367]: Device parameter missing` introduced by v0.7.28 when a managed compiler package has no standalone `.mlk`.
- JCFG configures MCU register values but does not replace the compiler device selector. The wrapper now preserves the incoming `-p${MCU_NAME}` exactly when no managed `.mlk` alias is found.
- If a matching managed `.mlk` is present, the wrapper can still rewrite the device selector to that real native basename (for example `PIC32...` to `P32...`).
- Split `-p MCU`, `-IP path`, and `-SP path` forms are normalized to the compact forms expected by mikroC.
- Build-support revision is 45, forcing v0.7.28 setups to regenerate the corrected wrapper automatically.

### v0.7.28 mikroC CMake/JCFG compatibility fix

- Restores a self-contained mikroC compiler wrapper for all mikroC families (ARM, PIC, PIC32, dsPIC/PIC24 and AVR) while continuing to use the managed NECTO CMake and `mikroc_cmake` packages.
- Handles the `-p${MCU_NAME}` argument still emitted by the managed MikroC CMake rules. **Note:** v0.7.28 incorrectly removed this argument when no managed `.mlk` was present; v0.7.29 corrects that regression because the compiler still requires a device selector.
- Restores `Defs`, `Uses`, `.mcl` and `.emcl` discovery inside the extension-managed compiler payload only. Host `~/.MIKROE/NECTOStudio*` installations remain completely ignored.
- JCFG generation now matches `me.mcu`: configuration-field values are masked, default bits are preserved outside field masks, `unused` bits are cleared, hexadecimal register values are not zero-padded, and `stack_allocation`, `back_door_key` and `data_type_size` are emitted as `"0"`.
- Build-support revision is 44, forcing existing mikroC setups to regenerate their toolchain/JCFG on the next rebuild.

### v0.7.25 self-contained mikroC builds with managed NECTO CMake

- mikroC builds no longer scan or reuse any files below `~/.MIKROE/NECTOStudio*`. The extension uses only packages installed below its own `c-runtime` directory.
- Removed legacy `.mlk` / `Defs` / `Uses` discovery and PIC/PIC32 native-name rewriting from the active setup path.
- Linux mikroC setups automatically install the official NECTO CMake package from the existing hardcoded live CMake asset and persist that managed CMake executable in the setup.
- The generated toolchain points `CMAKE_MikroC_COMPILER` directly at the managed mikroC compiler. The extension no longer generates or invokes `mikroc-compiler-wrapper.sh`.
- The extension no longer injects `-p${MCU_NAME}` into MikroC compile rules. That legacy option was the source of the false `File '<MCU>.mlk' not found` failure.
- `COMPILER_FLAGS` and `SEARCH_PATHS` remain exported from the selected database/compiler package so the official NECTO CMake MikroC language implementation can consume them.
- Build-support revision is 41, forcing existing setups to regenerate once after upgrading.

### v0.7.24 mikroC native device IDs and NECTO runtime paths

- fixes NECTO mikroC fallback discovery to use `packages/compilers/<Compilers.path>`
- uses the actual `.mlk` basename as the mikroC `-p` device identifier when available
- restores compiler-native PIC/PIC32/dsPIC aliases such as `P32MZ2048EFH144` instead of passing the database `PIC32...` UID directly
- keeps `Defs` and family/core-specific `Uses` directories on mikroC `SEARCH_PATHS`


### v0.7.42 standalone mikroC CODEGRIP debugging

- mikroC AI projects no longer use Microsoft `cppdbg`/ordinary GDB for CODEGRIP debug. The extension now launches the same native `mikroDap` architecture used by NECTO and selects the family backend from the compiler UID: `mikroe:arm:gdb_rsp`, `mikroe:pic:gdb_rsp`, `mikroe:pic32:gdb_rsp`, `mikroe:dspic:gdb_rsp`, or `mikroe:avr:gdb_rsp`.
- The managed Linux runtime contains `mikroDap`, its NECTO-specific shared-library dependencies, ICU 73, and all five `mikroe_*_gdb_rsp.so` backends. Ordinary Qt6 Gui/Widgets/Network/Sql libraries are resolved from the Linux host. No installed NECTO Studio filesystem is used.
- A VS Code inline DAP proxy injects NECTO-compatible `projectParameters` and `debuggerSettings`, points launch at the compiler-generated `.dbg` database, and preserves NECTO's initialize → `.dbg` launch → breakpoint ordering. CODEGRIP remains responsible for programming the generated HEX and providing the dynamic RSP port.
- GCC/LLVM CODEGRIP debugging stays on the existing `cppdbg` path; only mikroC compilers use `mikroDap`. Build-support revision is 55 so existing mikroC setups are regenerated once to persist the exact selected core source path required by mikroDap.

### v0.7.41

- RL78/G24 E2/E2 Lite debug now mirrors the proven e² studio CPU debug profile: externally powered target (`-w 0`), G24 flash/debug settings, CPU trace selection, and FAA disabled in the Renesas VS Code target so the adapter can generate the CPU core descriptor itself. `-uCore` is intentionally not injected through `serverParameters`, matching Renesas Debug guidance.

### v0.7.40 RX core-declared project flags

- RX GCC setup generation now reads the selected core package's `cmake/coreUtils.cmake::set_flags(flags)` branch for the active `CORE_NAME` and propagates that exact list into the workspace application toolchain. The installed RX core is therefore the source of truth for project flags rather than a duplicated JavaScript table.
- For RXv3 this carries the full core list into application compilation, including `-Wno-incompatible-pointer-types -fno-builtin -ffunction-sections -fdata-sections -fomit-frame-pointer -Og -fdiagnostics-parseable-fixits -nostartfiles -fno-strict-aliasing -fno-common -misa=v3 -fpu -mlittle-endian-data`.
- The same core-declared flags are supplied to the compiler-driver link. Extension-specific RX link requirements (`-Wl,--gc-sections` and, for RXv3/RX26T, `-Wl,-u,_PowerON_Reset_PC`) are appended without replacing the core flags.
- Older or atypical RX core packages that do not expose a parseable `set_flags()` continue to use the existing RX fallback flag mapping. Build-support revision is 54, so existing RX setups regenerate once after upgrading.

### v0.7.39 RL78 external-power debug fix

- RL78 E2/E2 Lite hardware debug now passes `serverParameters: ["-w", "0"]` to Renesas Debug. Renesas' RL78 GDB server defaults `-w` to `1` (emulator powers the target), while the managed RFP E2/E2 Lite path leaves emulator power OFF. This keeps Debug in the same power mode as the known-good RFP connection and avoids power-source conflicts on externally powered boards such as the RL78/G24 FPB.
- The change is runtime-only; existing RL78 setups do not need to be rebuilt.

### v0.7.38 RL78 E2/E2 Lite hardware debugging

- RL78 C setups using the managed **Renesas Flash Programmer (`rfp-cli`)** now expose **Debug** when the saved RFP connection is **E2 emulator Lite** or **E2 emulator**, matching the existing RX hardware-debug workflow. Flash/Erase remains with RFP; Debug is delegated to the official **Renesas Debug** VS Code adapter (`renesas-hardware`).
- RL78 E2/E2 Lite programming uses **`-if uart1` (1-wire UART)** rather than RX's FINE interface. The configurator now defaults to `uart1` for this combination, and older saved RL78 E2/E2 Lite profiles that contain `fine` are normalized to `uart1` at execution time.
- The generated Renesas Debug target uses `deviceFamily: "RL78"`, the full RL78 device code (for example `R7F101GLG`), and `debuggerType: "E2LITE"` or `"E2"`. Direct UART boot-mode RFP profiles remain programming-only.
- Host requirement: install the **Renesas RL78 Support Files** and E2/E2 Lite USB driver through Renesas Platform / Quick Install.

### v0.7.23 mikroC AI device-definition compatibility

- mikroC AI setup creation no longer requires a standalone `Defs/<MCU>.mlk` file. The NECTO database/core `MCU_NAME` is the authoritative compiler target, matching current NECTO mikroC AI packages where the MCU can be compiled without exposing a separate `.mlk` definition in the compiler payload.
- Legacy `.mlk`, `Defs`, `Uses`, `.mcl`, and `.emcl` content is still discovered when present and added to `SEARCH_PATHS`; it is now optional compatibility/search-path enrichment rather than a pre-build requirement.
- The mikroC compiler wrapper no longer rewrites `-pPIC...`/`-pPIC32...`/`-pdsPIC...` targets to `P...` names inferred from `.mlk` filenames. It only normalizes split `-IP`/`-SP` arguments into the compact form expected by mikroC.
- The C build-support revision is bumped so existing mikroC setups regenerate their generated toolchain files automatically.

### v0.7.22 RX E2 Lite hardware debugging

- Renesas RX C setups that use the managed **Renesas Flash Programmer (`rfp-cli`)** with **E2 emulator Lite** or **E2** now expose the normal **Debug** workflow. RFP remains responsible for Flash/Erase; Debug is handed to the official **Renesas Debug** VS Code adapter (`renesas-hardware`), which owns the E2/E2 Lite GDB server and loads the built ELF.
- RX debugger targets are normalized from the full package/orderable MCU name to the Renesas RX debugger device code (for example `R5F526TFCDFP` → `R5F526TF`). The saved RFP `fine` interface maps to the Renesas GDB server FINE setting.
- UART RFP profiles remain programming-only. If an RX setup is still configured for UART (or RFP J-Link), Debug explains that the setup must use E2 Lite/E2 instead.
- The extension now depends on **Renesas Debug**. The Renesas **RX Support Files** and E2/E2 Lite USB driver must also be installed through the Renesas tooling on the host.

### v0.7.7 Managed RFP, bare-metal catalog, and XC8 CMake support

- Renesas `rfp-cli` is now imported into the managed C programmer packages instead of being used from `~/Downloads`. The official Renesas package can be selected from Development Environment → Programmers.
- MCU rows with `Devices.sdk_support = 0` are visible in the C configurator and are forced to **Bare metal core** mode.
- XC8/PIC CMake builds use `.p1` intermediate files and `xc8-ar` for static libraries instead of the host `ar`.

### v0.7.6 Renesas RFP and active-CMake Explorer view

- Every Renesas C target now gets a synthetic **Renesas Flash Programmer (`rfp-cli`)** programmer choice even when the NECTO database has no ProgrammerToDevice/CompilerToProgrammer mapping for it. The first flash asks for the connection and stores it per setup. RL78 defaults match UART boot-mode programming (`-d RL78 -port /dev/ttyUSB0 -if uart -dtr-inv -s 115200 -reset`); RX26T-style targets default to E2 Lite/FINE (`-d RX200 -t e2l -if fine -run`).
- Renesas Flash Programmer is managed under `c-runtime/packages/programmer/renesas_rfp/current`. Because Renesas distributes RFP through an authenticated/licensed download, the Programmer package Install action asks you to select the official downloaded archive/folder once, copies the RFP runtime into managed storage, and all Renesas setups use that managed copy afterwards. The extension does not execute `rfp-cli` from `~/Downloads` or PATH.
- RFP Flash and Erase keep the VS Code status-bar programming indicator active for the complete CLI operation. `rfp-cli` itself remains a flash/erase tool; since v0.7.22, RX setups using E2 Lite/E2 delegate Debug to the Renesas Debug VS Code adapter, while UART RFP profiles remain programming-only.
- The Explorer now dims C/C++/ASM/CMake files and folders that are not part of the active configured CMake graph. The extension configures the root `CMakeLists.txt` with the active MikroBUS setup/toolchain, requests CMake File API `codemodel-v2` and `cmakeFiles-v1`, and therefore follows nested `include(...)`, `add_subdirectory(...)`, setup `MCU_NAME`, board/package variables and other database-driven definitions.
- After a successful build, Ninja dependency data is included as well, so headers selected by the actual compiler/preprocessor remain normal while unused headers can be dimmed. Before the first build headers are intentionally left undecorated to avoid false negatives. Saving CMake files refreshes the view automatically.

### v0.7.1 compiler packages and multi-toolchain setups

- Added a separate **Compiler Packages** manager with search, installed-only filtering, install, update and uninstall actions.
- Setup creation now enumerates compiler choices from `CompilerToDevice`; the selected compiler must also resolve a compiler-specific core package from `Devices.installer_package`.
- Compiler packages are installed automatically when a setup requiring them is built.
- The generated CMake toolchain resolves compiler binaries from the selected `Compilers` row instead of assuming ARM GCC.
- GNU compiler families use their compiler driver for CMake ASM while retaining the raw `asm_compiler` binary for explicit assembler jobs. This also avoids the invalid raw-GNU-as `--defsym NAME` issue for target compile definitions.
- The current adapter set covers all 14 compiler IDs mapped to CMake in the supplied database.

### GNU ARM compiler / assembler handling

For GNU ARM, `Compilers.c_compiler` and `Compilers.asm_compiler` are treated as two distinct installed binaries. The raw assembler remains available from the database metadata, but CMake ASM targets use the GCC driver so mikroSDK compile definitions are passed as `-D...` rather than invalid bare `--defsym` arguments. Generated toolchain files force this choice in the CMake cache and print both compiler paths during configuration.


## 0.7.21

- RXv3/RX26T application builds now mirror the selected Renesas RX GCC core ABI (`-misa=v3 -fpu -mlittle-endian-data`) instead of using the older `-mcpu=rx66t` compatibility guess.
- RX executable links now use `-nostartfiles`, preventing GCC/newlib `libgloss` from injecting its incompatible `crt0.o`.
- RX links force `_PowerON_Reset_PC` undefined at link start (`-Wl,-u,_PowerON_Reset_PC`) so the MCU-specific startup object already stored in `MikroC.Core` is extracted even when an existing project CMakeLists only links `MikroC.Core`.
- RXv3 compile options now mirror the attached core package's `set_flags()` options, keeping application objects ABI-compatible with the installed core.

## 0.7.20

- mikroC device identifiers are now normalized separately from NECTO/core MCU names. For example `PIC32MZ2048EFH144` resolves to compiler-native `P32MZ2048EFH144`, `PIC18F97J94` to `P18F97J94`, `dsPIC33...` to `P33...`, and `PIC24...` to `P24...`. Core source filenames continue to use the database name.
- mikroC setup generation now resolves the actual `<MCU>.mlk` definition directory and the corresponding precompiled `Uses` library directories before configuring a core. A compiler executable directory alone is no longer treated as a sufficient `SEARCH_PATHS` value.
- Standard and Experimental NECTO 7 package trees are used as a compatibility fallback when the extension-managed mikroC executable archive does not contain `Defs`/`Uses`.
- mikroC compiler flags are now generated from the database `default_options` exactly like the NECTO toolchain plugins: PIC omits `-SSA`; dsPIC/PIC32/ARM/AVR enable it; ARM handles `-BIN`/`-ATYPE`; `-DBG` is retained and `-UICD` is Debug-only.