# Mikro Rust Configurator

A VS Code extension for configuring **mikroSDK-like embedded Rust projects** using the same MCU-driven approach as the supplied NECTO-style Rust configuration application.

The extension moves the configuration workflow into VS Code instead of maintaining a separate PyQt IDE window. VS Code remains responsible for editing, terminals, source control, Rust Analyzer, tasks and debugging, while this extension handles MCU-specific project materialization.

## What it does

- Adds a dedicated **Mikro Rust** Activity Bar view with project/target status.
- Reads the existing `database_mikro_sdk_rust.db` MCU database.
- Provides fast searchable MCU selection through VS Code Quick Pick.
- Loads the selected MCU's JSON register definition.
- Opens a polished, responsive register configuration editor in the VS Code editor area.
- Preserves hidden register fields and ORs selected values exactly like the original application.
- Generates `FOSC_KHZ_VALUE` from the selected integer MHz clock.
- Recreates `sdk/.setup/core` with the selected:
  - `core_header.rs`
  - `memory.x`
  - `startup.s`
  - MCU header
  - reset implementation
  - clock initialization
  - core `Cargo.toml`
  - `lib.rs`
  - `common_header.rs`
- Recreates `sdk/.setup/sdk` from the correct family pin mappings.
- Generates the family Cargo feature list from `language_list -> RUST -> module_list` in the MCU JSON.
- Generates `sdk/targets/<platform>/Cargo.toml` from `hal_ll_Cargo_template.toml`.
- Selects GPIO/ADC/I2C/SPI/TIM/UART implementations from the existing `FAMILY` database row.
- Selects the common one-wire implementation used by the supplied app.
- Generates `.cargo/config.toml` with the MCU Rust target.
- Optionally runs `rustup target add <target>` after configuration.
- Stores a generated setup manifest in `sdk/.setup/mikro-rust-config.json` so the extension can restore target state after VS Code restarts.
- Provides **Build**, **Flash**, **Erase**, **Debug**, **Choose Example**, **Open Setup**, and **Diagnostics** commands.
- Uses VS Code Tasks for build/flash/erase, rather than a custom terminal widget.
- Supports optional graphical OpenOCD/GDB debugging through Cortex-Debug, with a raw OpenOCD terminal fallback.

## Expected project layout

The uploaded application did not contain the actual database, `core/`, or `sdk/` payloads, so the extension intentionally uses those existing assets rather than embedding copies.

By default it expects:

```text
<workspace>/
├── application/
│   └── database/
│       └── database_mikro_sdk_rust.db
├── core/
│   └── arm/
│       └── stm32/
└── sdk/
    ├── .cargo/
    │   └── template_config.toml
    ├── targets/
    │   └── arm/
    │       └── stm32/
    └── tests/
```

If these live elsewhere, configure **Settings → Mikro Rust Configurator**. Every path can be relative to the workspace or absolute.

## Use

1. Open the folder containing the Rust configuration assets in VS Code.
2. Click the **Mikro Rust** icon in the Activity Bar.
3. Run **Configure MCU**.
4. Search for and select an MCU from the SQLite database.
5. Select clock and register settings.
6. Click **Apply Configuration**.
7. Use the sidebar buttons for **Build**, **Flash**, **Debug**, or **Erase**.

You can also use the Command Palette and type `Mikro Rust:`.

## Database access

The extension deliberately avoids a native Node SQLite dependency.

It first tries the bundled `scripts/db_helper.py`, which only uses Python's standard-library `sqlite3` module. Python is auto-detected as `python3`, `python`, or Windows `py -3`. You can set a custom executable with `mikroRust.pythonPath`.

If Python is unavailable, the extension falls back to a system `sqlite3` executable using JSON output.

## Configuration settings

| Setting | Default | Purpose |
|---|---|---|
| `mikroRust.rootPath` | workspace root | Root containing core/SDK/database paths |
| `mikroRust.databasePath` | `application/database/database_mikro_sdk_rust.db` | SQLite MCU database |
| `mikroRust.corePath` | `core` | Core source root |
| `mikroRust.sdkPath` | `sdk` | Rust SDK root |
| `mikroRust.corePlatform` | `arm/stm32` | Shared platform subpath beneath core and sdk/targets |
| `mikroRust.pythonPath` | auto | Python executable for SQLite bridge |
| `mikroRust.installRustTargetOnConfigure` | `true` | Run `rustup target add` after generation |
| `mikroRust.openocdPath` | `openocd` | OpenOCD executable |
| `mikroRust.gdbPath` | `arm-none-eabi-gdb` | ARM GDB executable |
| `mikroRust.openocdInterfaceConfig` | `interface/stlink.cfg` | OpenOCD probe/interface config |
| `mikroRust.cortexDebugExtensionId` | `marus25.cortex-debug` | Optional graphical debug adapter |

## Mapping from the supplied Python application

The extension preserves the core setup semantics rather than porting the whole PyQt shell:

| Supplied application | VS Code extension |
|---|---|
| MCU card grid | Native searchable Quick Pick |
| `RegisterConfigPanel` | Responsive full editor webview |
| `save_parameters()` | Transactional configuration engine |
| PyQt code editor | Normal VS Code editor |
| PyQt output box | VS Code Tasks / Output panel |
| Project dropdown | `Choose Example` command |
| `cargo build` | VS Code Process Task |
| `cargo flash` | VS Code Process Task |
| `probe-rs erase` | Confirmed VS Code Process Task |
| Hand-managed GDB buttons | VS Code debug UI when Cortex-Debug is installed |

The old installer screen is intentionally not duplicated. Tool installation and updates are better kept separate from project generation; the extension includes **Run Diagnostics** to show which required tools/assets are present.

## Safety and consistency

Before changing the active project, the generator validates all source files needed for the selected MCU. It builds the new `.setup` directory in a staging location and only replaces the active setup after generation succeeds. External generated files are written using temporary files to reduce the chance of truncated configuration files.

The extension declares that it does **not** support untrusted workspaces because configuration can execute `rustup`, Cargo, probe-rs and OpenOCD-related tools.

## Development

No npm runtime dependencies are required.

```bash
npm run check
npm test
python3 test/db_helper_test.py
```

Press `F5` in a VS Code window opened on this extension folder to launch an Extension Development Host.

For normal VS Code packaging, Microsoft's supported flow is:

```bash
npx @vscode/vsce package --allow-missing-repository
```

A standard-library `scripts/package_vsix.py` is also included for offline/local packaging of this dependency-free extension.

## Current scope

The supplied application hard-codes the core platform as `arm/stm32`; this extension keeps that as the default but makes the platform path configurable so additional architecture/vendor layouts can be added without redesigning the UI.
