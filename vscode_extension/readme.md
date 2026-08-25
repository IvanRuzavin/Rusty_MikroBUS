# MikroBUS Rust Tools

VS Code support for reusable mikroSDK Rust setups, project build/flash/debug actions, and MCU or board-based hardware configuration.

## Version 0.0.23

- Adds **Find USB CODEGRIP** to the MCU/board setup wizard whenever MIKROE CODEGRIP is selected.
- Discovers the attached local USB device, lets the user choose when several devices are returned, and saves its serial number, hardware tokens, and stable connection fields with the reusable setup.
- Disables **Build Configuration** for a CODEGRIP setup until a USB device has been discovered.
- Removes `mikrobusRust.codegripProfilePath` and the manually maintained connection-profile file. Flash, erase, and debug now use the device stored in the setup.
- Does not change any Development Environment package or tool paths.

Version 0.0.23 retains the complete 0.0.22 programmer integration and earlier setup behavior:

- Adds MIKROE CODEGRIP as a database-selected programmer/debugger alongside SEGGER J-Link.
- Implements the supplied `CodegripGdbServer` launch contract, dynamic ports, framed JSON control channel, USB/Wi-Fi selection, optional authentication, target options, Intel HEX programming, and external-GDB debugging.
- Converts Rust ELF files with the ARM GCC package already managed by Development Environment. Existing Development Environment package paths are unchanged.
- Uses Cortex-Debug only for CODEGRIP's GDB endpoint. The existing probe-rs DAP path remains unchanged for SEGGER J-Link setups.
- Keeps one Rust database and removes the incompatible Nucleo-F412ZG / Nucleo-144 Click Shield relationship.
- Routes standalone erase through a configurable CODEGRIP command. The supplied samples do not document that command, so `erase` is the compatibility default and any server rejection is displayed.

It also retains the complete 0.0.21 setup, BSP, board, shieldless-board, project, Windows-debug, and variable-printing behavior:

- Makes shields optional for board-based setups. A board remains buildable when it has no `BoardToShield` relationship.
- Adds an explicit **No shield (no mikrobus.rs)** choice for every board.
- Applies shieldless board setups to any project with a root `Cargo.toml` without generating `mikrobus.rs`.
- Keeps shield-backed setups unchanged: selecting a shield still generates the board/shield MikroBUS mapping beside `main.rs`.

- Moves all board and shield `.cfg` files out of the VSIX into an independently managed Board Support Package.
- Adds the Board Support Package to Development Environment install, update, and uninstall actions.
- Downloads `bsp.7z` directly from the Rusty_MikroBUS v0.0.1 release and installs it under the configured managed root.
- Resolves database `bsp/...` paths against the managed BSP package, so new boards and shields no longer require rebuilding the extension.
- Adds the Nucleo-F429ZI board with its complete CN7-CN12 pin mapping and native `STM32F429ZI` Rust SDK target.
- Connects Nucleo-F429ZI to the existing Nucleo-144 Click Shield, SEGGER J-Link/SWD programmer, and generated `mikrobus.rs` workflow.
- Uses native `STM32F412ZG` MCU support for the Nucleo-F412ZG board and removes the previous temporary compatibility mapping.
- Uses only the single Rust database configured by Development Environment. The extension no longer looks for or applies `database/rust_schema_extensions.sql` from its installation directory.
- Fixes Windows debug startup by using a standalone probe-rs TCP DAP server by default. The stdin/stdout transport remains available as a diagnostic opt-in.
- Prints the resolved probe-rs executable, version, DAP transport, TCP endpoint, process start, stderr, and exit status in the **MikroBUS Rust** output channel.
- Keeps VS Code's native **Restart** and **Step Out** controls and removes the duplicated extension controls.
- Automatically prints local, static, and global scopes exposed by probe-rs whenever execution stops. A manual variable-dump button remains in the debug toolbar.
- Makes **Configured Setups** the default Activity Bar view and lets a saved setup be applied directly to the opened Rust project.
- Disables **Apply** unless the selected workspace folder has `Cargo.toml` in its root.
- Opens the full tool installer/updater in a separate **Development Environment** window.
- Removes Build/Flash/Debug/Erase controls from the configuration window; the Rust editor-title shortcuts remain.
- Uses dedicated hammer, lightning, and eraser icons for Build, Flash, and Erase.
- Adds a scalable MCU/Board start step, programmer selection, board/shield selection, and board-generated `mikrobus.rs`.
- Extends the Rust database with `DeviceToProgrammer`, `BoardToDevice`, and `BoardToShield` relationships.

## Install

Install the packaged `.vsix` with **Extensions: Install from VSIX...**, then reload VS Code.

The extension requires VS Code 1.101 or newer. Its managed packages include the Rust database, BSP, SDK, core, ARM GCC, and OpenOCD. Rust, probe-rs, J-Link, and platform drivers are detected or installed through the Development Environment window.

## Normal workflow

1. Open the project directory that contains `Cargo.toml` at its root.
2. Open the **MikroBUS Rust** Activity Bar view.
3. If no setup exists, choose **Configure my first setup**.
4. Select **MCU** or **Board**.
5. Configure the device clock/register values and choose **SEGGER J-Link** or **MIKROE CODEGRIP**, according to the relationships in the single Rust database.
6. For a board setup, optionally select a compatible shield. Choose **No shield** when the board is used by itself.
7. Build the reusable setup, return to **Configured Setups**, and choose **Apply to project**.
8. Open the Rust file to run and use the editor-title buttons:
   - hammer: build
   - lightning: build and flash
   - debug icon: debug
   - eraser: erase MCU flash

Applying a setup writes a small `.vscode/mikrobus-rust.json` binding and Rust Analyzer settings to the project. The complete SDK layers live in extension-managed reusable setup storage, so the project does not need its own SDK tree.

Build/debug operations compile the active Rust file as a temporary Cargo binary from the reusable SDK. The temporary manifest entry is removed after the operation.

## Configured Setups view

The Activity Bar view always starts with saved setups. Each card shows the MCU or board, clock, programmer, shield, and whether it is already used by the current project.

`Apply to project` is disabled when:

- no folder is open; or
- `Cargo.toml` is not present directly in the selected workspace root.

The view-title tools button and the **Development environment** footer button open the full package/tool window. The circuit-board button opens Hardware Configuration.

## MCU and board configuration

The Hardware Configuration window starts with two modes:

### MCU

Select a Rust-supported MCU, configure its clock/register values, then select a compatible programmer. The updated database connects every current MCU to SEGGER J-Link and MIKROE CODEGRIP over SWD.

### Board

Select a board, clock/register values, and a programmer. The shield is optional. When a shield-backed setup is applied, the extension creates `mikrobus.rs` next to the active `main.rs`, or next to root/src `main.rs` when no main editor is active. A shieldless setup is still saved and applied normally, but no `mikrobus.rs` is generated.

The board data is:

| Board | MCU / Rust SDK target | Shield | Programmer |
|---|---|---|---|
| Nucleo-F412ZG | STM32F412ZG | Optional; no database relationship required | SEGGER J-Link or MIKROE CODEGRIP / SWD |
| Nucleo-F429ZI | STM32F429ZI | Click Shield for Nucleo-144 (4 sockets) | SEGGER J-Link or MIKROE CODEGRIP / SWD |

Both boards use their native Rust MCU definitions and database entries.

The BSP sources are installed independently from:

```text
https://github.com/IvanRuzavin/Rusty_MikroBUS/releases/download/v0.0.1/bsp.7z
```

They are extracted beneath `<managed root>/bsp` as:

- `bsp/boards/nucleo_f412zg/board.cfg`
- `bsp/boards/nucleo_f429zi/board.cfg`
- `bsp/shields/nucleo_144_click_shield/shield.cfg`

The VSIX contains no board or shield `.cfg` files. To add a board without rebuilding the extension, update `bsp.7z` and add its board/device relationship and `BSP_PATH` to the single Rust database. `BoardToShield` rows are optional and are needed only for shields that should generate `mikrobus.rs`. Users receive database and BSP updates through **Development Environment → Update managed**.

The BSP files preserve the supplied Nucleo connector and Click Shield relationships. C pin identifiers are normalized to the Rust SDK style when `mikrobus.rs` is generated. For example:

```rust
pub const MIKROBUS_1_SCL: pin_name_t = GPIO_F1;
pub const MIKROBUS_1_SDA: pin_name_t = GPIO_F0;
```

This intentionally avoids invalid C-style names such as `GPIO_PF0`.

## Database extension

The supplied NECTO database already models boards and board/device relationships, and separately models programmer/debugger compatibility. It does not provide the requested shield relationship in the Rust SDK database. The updated Rust database adds normalized entities and these explicit many-to-many relationships:

| Relationship | Purpose |
|---|---|
| `DeviceToProgrammer` | Supported programmer/debugger choices for each MCU |
| `BoardToDevice` | One or more Rust-compatible MCU targets for a board |
| `BoardToShield` | Shields that can be selected for a board |

The related `Programmer`, `Board`, and `Shield` tables carry stable UIDs, BSP paths, enable flags, and JSON extension fields. Version 0.0.22 adds `MIKROE_CODEGRIP` and its device links without changing the schema. Future programmers remain data-driven through the same tables.

All MCU, programmer, board, shield, and relationship tables live in one file:

```text
<VS Code globalStorage>/mikroe-dev.mikrobus-rust-tools/database/database_mikro_sdk_rust.db
```

On the reported Linux installation this resolves to:

```text
/home/ivan-ruzavin/.config/Code/User/globalStorage/mikroe-dev.mikrobus-rust-tools/database/database_mikro_sdk_rust.db
```

The extension opens that database read-only for configuration queries. It does not load another database, copy a schema beside the extension, or modify the database at runtime. Database replacement continues to use the existing Development Environment location.

## CODEGRIP setup and operation

Choose **MIKROE CODEGRIP** while building an MCU or board setup, connect it over USB, and choose **Find USB CODEGRIP**. If more than one local device is returned, select the required serial number. The extension stores the stable USB selector fields with the reusable setup, so the same lightning, debug, and eraser actions automatically use that CODEGRIP.

The extension checks these paths without changing any package location shown in Development Environment:

1. `mikrobusRust.codegripServerPath`, then `PATH`, then `~/.MIKROE/NECTOStudio7/packages/programmers/codegrip/apps/bin/CodegripGdbServer`;
2. `mikrobusRust.codegripPacksPath`, then the packs directory inferred from that server, then the standard NECTOStudio7 CODEGRIP package;
3. `mikrobusRust.armGccBinPath`, then `PATH`, then the existing managed `runner/xpack-arm-none-eabi-gcc-*/bin` package.

No connection-profile file is required. Discovery records the communication type, device name, serial number, hardware tokens, device IP, link ports, and SSL state. Process IDs, signal-strength samples, dynamic server ports, and passwords are not persisted.

The supplied CODEGRIP command examples document device selection after connection data is known, but do not name the Suite's discovery command. The extension therefore accepts USB-device results from the known framed control response/notification shapes and tries compatibility discovery command names. The **MikroBUS Rust** output channel lists the attempted command and any server rejection so a different installed server build can be diagnosed without hiding the error.

The server command is:

```text
CodegripGdbServer --mcu <MCU> --port 0 --cport 0 --packs <packs-directory>
```

Flash builds the Rust source, converts its ELF to Intel HEX, configures CODEGRIP, and sends `programming` with `debugEnable: false`. Debug sends `programming` with `debugEnable: true`, retains the server, then launches Cortex-Debug against the published GDB port. Debug Console variable printing remains available.

The database exposes CODEGRIP for all 38 MCUs currently present in the Rust SDK database. The installed CODEGRIP packs remain the final authority for a particular MCU. The supplied executable tests explicitly exercise STM32F407ZG; validate each additional physical MCU/probe combination before relying on it in production.

The supplied command set demonstrates erase as part of programming but does not name a standalone erase command. Version 0.0.23 sends `mikrobusRust.codegripEraseCommand`, defaulting to `erase`. If the server rejects it, the returned status and text are shown; set the exact command supported by that server version.

## Windows debugging

The probe-rs backend retained by version 0.0.23 starts probe-rs as:

```text
probe-rs dap-server --port <temporary-local-port>
```

VS Code connects through `DebugAdapterServer` at `127.0.0.1`. This replaces the Windows stdin/stdout default that could stall immediately after `Starting probe-rs DAP through stdin/stdout transport (Windows)`.

Expected output now includes:

```text
Resolved probe-rs: C:\Users\...\.cargo\bin\probe-rs.exe
probe-rs version: probe-rs 0.32.0
Starting probe-rs DAP TCP server on 127.0.0.1:... (Windows default).
[probe-rs] DAP process started (PID ...).
```

If the session still does not open:

1. Open **View > Output > MikroBUS Rust** and check the probe-rs version, process error, and exit code.
2. Confirm the configured executable with `probe-rs --version` in a new terminal.
3. Test `probe-rs dap-server --port 50000` manually and stop it with Ctrl+C.
4. Check that local security software permits a loopback connection to `127.0.0.1`.
5. Set `mikrobusRust.probeRsPath` to the exact `probe-rs.exe` if multiple installations exist.

The setting `mikrobusRust.windowsDebugTransport` can be changed to `stdio` only for comparison/diagnostics. `tcp` is the supported default.

The extension launches with SWD, connects under reset, flashes the ELF, halts safely, installs an entry breakpoint in the active `main.rs`, and continues from reset to source. Step Out and Restart use VS Code's native debug toolbar buttons.

## Debug variables

`mikrobusRust.dumpVariablesOnStop` defaults to `true`. On each stopped event the extension requests every stack frame and prints:

- local scopes for every visible frame;
- static/global scopes exposed on the top frame; and
- nested children up to the configured limits.

The selected debug adapter and Rust debug information decide which optimized-away or hardware-only values are available. Values that the adapter does not expose cannot be reconstructed by the extension.

Limits can be tuned with:

| Setting | Default |
|---|---:|
| `mikrobusRust.variableDumpMaxDepth` | 5 |
| `mikrobusRust.variableDumpMaxEntries` | 5000 |
| `mikrobusRust.variableDumpMaxValueLength` | 512 |

Use **MikroBUS Rust: Print Variables to Debug Console** for an on-demand dump while paused.

## Commands

| Command | Purpose |
|---|---|
| `MikroBUS Rust: Open Configured Setups` | Reveal the default Activity Bar setup list |
| `MikroBUS Rust: Development Environment` | Open all tool/package controls |
| `MikroBUS Rust: Configure MCU or Board` | Open hardware configuration |
| `MikroBUS Rust: Apply Setup to Current Workspace` | Apply a saved reusable setup |
| `MikroBUS Rust: Build Current Rust File` | Build the active Rust source |
| `MikroBUS Rust: Build & Flash Current Rust File` | Build and flash the active Rust source |
| `MikroBUS Rust: Debug Current Rust File` | Start probe-rs DAP or CODEGRIP external-GDB debugging, according to the setup |
| `MikroBUS Rust: Erase Configured MCU` | Erase the selected MCU |
| `MikroBUS Rust: Print Variables to Debug Console` | Dump visible variables while paused |

## Development checks

```text
npm run check
npm test
npx @vscode/vsce package --allow-missing-repository --skip-license
```

The release verification also exercises the database migration, board/shield queries, Rust pin generation, package contents, and the Windows TCP debug-adapter descriptor.

## References

- probe-rs debugger: https://probe.rs/docs/tools/debugger/
- Cortex-Debug external server support: https://github.com/Marus/cortex-debug
- VS Code debug adapter API: https://code.visualstudio.com/api/references/vscode-api
