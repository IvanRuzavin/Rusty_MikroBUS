# MikroBUS Rust Tools v0.0.9

Cross-platform VS Code tooling for the Rust mikroBUS SDK workflow.

## What changed in 0.0.9

- Fixes generated `.setup/sdk` crates on Linux when a core family contains `src/Lib.rs` instead of Cargo's expected lowercase `src/lib.rs`. The generator normalizes the copied crate entry point without modifying the installed core package.
- Adds workspace-native actions for the currently open Rust file after an MCU setup is applied.
- Adds editor title buttons for **Build**, **Build & Flash**, and **Debug**.
- Adds keyboard shortcuts while a Rust editor is active in a bound workspace:
  - `Ctrl+Shift+B` (macOS: `Cmd+Shift+B`) — build current `.rs`
  - `Ctrl+F5` (macOS: `Cmd+F5`) — build and flash current `.rs`
  - `F5` — build, flash and start an interactive probe-rs debug session

The current `.rs` file is saved and copied to `sdk/src/main.rs` before current-file build/flash/debug, matching the existing Rusty_MikroBUS test workflow.

## F5 debugging

F5 uses the installed `probe-rs` CLI directly as a VS Code Debug Adapter Protocol server. MikroBUS Rust Tools registers its own `mikrobus-rust-debug` adapter, resolves the generated ELF under `target/<rust-target>/debug/<cargo-package-name>`, starts `probe-rs dap-server`, flashes the ELF, halts after reset, and enters VS Code's normal debug UI. No second VS Code debugger extension is required.

## Build

```bash
npm run check
npx @vscode/vsce package
```
