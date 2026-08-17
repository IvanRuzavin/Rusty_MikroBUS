# Architecture

## Design goal

The standalone app combines three concerns: dependency installation, project configuration, and a small custom IDE/debug UI. In VS Code, only the project-configuration concern needs to be custom. The workbench already provides the other IDE facilities.

## Main components

- `src/extension.js` — activation, commands, tasks, status bar, debug integration and workspace settings.
- `src/dashboard.js` — Activity Bar dashboard.
- `src/configurationPanel.js` — responsive MCU/register editor webview.
- `src/configurationEngine.js` — filesystem-only configuration logic; intentionally independent from the VS Code API so it is unit-testable.
- `src/database.js` — database bridge and Python/sqlite3 fallback logic.
- `scripts/db_helper.py` — parameterized SQLite queries using Python stdlib.
- `src/process.js` — shell-free child process helper.

## Configuration transaction

1. Resolve workspace paths.
2. Read MCU metadata from SQLite.
3. Load `mcu_definitions/<MCU>.json`.
4. Validate clock and register selections.
5. Resolve every source file required by the selected MCU/family.
6. Fail before mutation if any required source is missing.
7. Build `sdk/.setup.mikro-rust-stage-*`.
8. Generate core constants and Cargo templates.
9. Update SDK generated target files using temporary-file writes.
10. Rename the staged setup to `sdk/.setup`.
11. Persist `mikro-rust-config.json`.
12. Optionally install the Rust target.

## Compatibility with the original database

The original Python code accesses implementation selectors by positional indexes in `FAMILY.*`:

- index 4: GPIO port implementation
- index 5: ADC
- index 6: I2C
- index 7: SPI
- index 8: TIM
- index 9: UART

The extension first tries semantic FAMILY column names when available, then deliberately falls back to these same indexes for compatibility.

## Debug model

The original application manually creates OpenOCD and GDB subprocesses and translates UI buttons to GDB CLI commands. In VS Code this duplicates the Debug Adapter Protocol UI. The extension therefore starts a normal Cortex-Debug configuration when that adapter is installed. The derived OpenOCD target keeps the original first-seven-characters convention (`stm32f4x.cfg` style). A raw OpenOCD terminal remains available as a fallback.
