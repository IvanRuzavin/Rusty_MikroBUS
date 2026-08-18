# MikroBUS Rust Tools v0.0.12

This build fixes the embedded debug lifecycle. F5 now starts `probe-rs dap-server` on a local TCP port and connects VS Code with `DebugAdapterServer`, which works with older probe-rs releases such as 0.27 as well as current releases. The currently opened Rust file is compiled directly as a temporary Cargo binary target so DWARF points to the original file and source breakpoints bind correctly. A temporary breakpoint is placed at the first executable line of `main()`, the target is flashed and halted after reset, then execution continues to that source breakpoint.

It also includes the MCU JSON hexadecimal parsing correction (`01000000` is interpreted as hexadecimal, not decimal) and retains the v0.0.10 development-environment update/uninstall controls.


## Erase MCU

When a Rust workspace is bound to a configured MCU setup, the Rust editor toolbar exposes **Erase MCU** next to Build / Flash / Debug. The action asks for confirmation and runs `probe-rs erase --chip <MCU>`. It erases target flash only; it does not remove the saved setup.
