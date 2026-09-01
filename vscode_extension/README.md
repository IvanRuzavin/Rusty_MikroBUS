# MikroBUS Embedded Tools

MikroBUS Embedded Tools adds reusable Rust and C MCU setups to VS Code. The existing Rust workflow is preserved. C support follows the NECTO setup order: install package dependencies, generate the MCU core configuration, build/install the core, and (for a full setup) build/install the selected mikroSDK on top of that core.

## C support at a glance

- NECTO-compatible SQLite data drives the compatible MCU, compiler, mikroSDK, package and programmer choices.
- `Compilers.core_path` plus `Devices.sdk_config.MCU_NAME` select the MCU core inside the single C core bundle.
- The C SDK package is fixed to mikroSDK 2.19.1 and uses the hardcoded `C_sdk.7z` bundle, including the BSP content required by mikroSDK.
- Compiler/programmer compatibility still comes from the database; package downloads themselves are direct and hardcoded.
- Bare-metal setups build core files only.
- Full mikroSDK setups build/install the core first, then build/install the supported SDK version.
- Missing packages install automatically when setup building begins. There is no package-by-package approval prompt.
- Managed C packages are listed in **MikroBUS C: Installed Packages** and can be inspected or uninstalled there.
- CODEGRIP and SEGGER J-Link are supported as programmer/debug selections. CODEGRIP uses the existing USB discovery, programming and GDB-server integration.

The first compiler adapter is `gcc_arm_none_eabi`. Additional C toolchains can be added without changing the package/database workflow by registering an adapter in `COMPILER_ADAPTERS` in `c_setup.js`.

## C workflow

1. Install this VSIX and open a workspace.
2. In the MikroBUS activity view, select **C** in the Rust/C environment switch.
3. Click **Install / update C environment**. The C database, complete C core bundle, mikroSDK 2.19.1, ARM GCC and CODEGRIP are resolved from hardcoded download URLs.
4. Click **Create & Build C Setup**.
5. Select MCU, compiler, bare metal or full SDK, MCU package, programmer and clock. mikroSDK is fixed to 2.19.1 for this bundle.
6. The extension reads `Compilers.core_path` and `Devices.sdk_config.MCU_NAME` from the C database to locate the correct MCU core inside `C_core.zip`.
7. Open any C/C++ source in the project. The extension walks upward to the project-root `CMakeLists.txt`; **Apply C Setup** writes only the setup binding under that project root and never creates or modifies application source files.
8. Build, flash and debug are available directly from the C editor title. For bound MikroBUS projects the generic Microsoft C/C++ active-file Run/Debug shortcut is hidden because single-file compilation is not valid for mikroSDK projects.

Workspace output is placed in `.mikrobus/c-build`. Reusable setup artifacts and installed packages live under the extension-managed storage root.

## Hardcoded C package sources

C package resolution does not use Kibana, Elasticsearch, a catalog proxy, credentials, or package-index queries. The extension contains direct package URLs for:

- C database: `C_database.7z`
- Complete C core collection: `C_core.zip`
- mikroSDK: fixed `2.19.1` `C_sdk.7z` archive (including BSPs)
- ARM GCC: the same xPack ARM GNU toolchain used by the existing embedded workflow
- CODEGRIP: platform-specific NECTO package URLs for Windows, Linux and macOS
- Shared NECTO support package URLs supplied for SRecord, debugger tools, clangd, CMake, clang-format and Tabnine where a platform URL is defined

Core selection is data-driven rather than package-name-driven. The selected compiler supplies `Compilers.core_path`, and the selected device supplies `MCU_NAME` from `Devices.sdk_config`. The extension searches that compiler subtree in `C_core.zip` for the matching MCU definition and uses the containing core project.

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

The C workflow now has the same visual starting point as the Rust workflow. Open **Create & Build C Setup** and choose **MCU** or **Board**. Board selection is resolved through the C database, and compatible ARM/GCC MCUs are shown when a board supports more than one device.

For the selected target, the extension resolves `Compilers.core_path` plus `Devices.sdk_config.MCU_NAME`, loads the matching core definition (`ARM/gcc_clang/.../def/<MCU_NAME>.json`), and renders all visible `config_registers` fields as GUI selectors. Those selections are written into the generated `core_header.h` used for the C core build.

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
