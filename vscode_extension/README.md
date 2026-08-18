# MikroBUS Rust Tools v0.0.6

Cross-platform VS Code extension prototype for the Rust mikroBUS workflow.

## Environment sidebar

The MikroBUS Rust Activity Bar view keeps the existing Windows/Linux dependency checks and automatic installation for extension-managed packages.

## MCU configuration workflow

`MikroBUS Rust: Configure MCU` opens a main editor view with three states:

1. **MCU catalog** — all database MCUs are shown as a searchable table with MCU name, vendor, family, Rust target, system library and configuration status.
2. **MCU settings** — selecting a table row replaces the catalog with only that MCU's metadata, system clock and JSON-driven register fields.
3. **Configured setups** — saved MCU configurations can be edited, rebuilt or removed.

A configured setup stores the selected MCU, clock and register values under the extension-managed root:

```text
<managed-root>/configured-setups/
├── setups.json
└── active.json
```

The most recently built setup is the active setup and continues to generate the PyQt-compatible output in:

```text
<managed-root>/sdk/.setup
```

Rebuilding a different saved setup makes it active. Removing the active setup also removes `sdk/.setup` and the generated `.cargo/config.toml`.

At this stage one saved setup is maintained per MCU. Reconfiguring the same MCU updates that saved setup instead of creating duplicate variants.

## Build

```bash
npm run check
npm run build
```

Or directly:

```bash
npx @vscode/vsce package
```


## Rust tool discovery

Workspace build/flash commands do not rely only on the PATH inherited by the VS Code extension host. The extension resolves `cargo`, `rustup`, and `probe-rs` from PATH and the standard Rust `~/.cargo/bin` (or `%USERPROFILE%\.cargo\bin`) location, then injects that directory into child process PATH. Optional `mikrobusRust.cargoPath`, `mikrobusRust.rustupPath`, and `mikrobusRust.probeRsPath` settings can override discovery.
