# SRAM Click Rust example

This package is structured for the **reusable setup** workflow used by MikroBUS Rust Tools.
It intentionally contains no hard-coded SDK/Core paths and no standalone Click-driver Cargo crate.

## Use

1. Open this folder in VS Code.
2. Configure/select a Rust MCU/Board setup in MikroBUS Rust Tools.
3. Apply that setup to this workspace. The extension generates `mikrobus.rs` beside `main.rs`.
4. Open `main.rs` and use the extension's **Build Current Rust File**, **Build & Flash Current Rust File**, or debug action.

The Click itself uses `MIKROBUS_1_*` constants from generated `mikrobus.rs`.
Logging uses generated `USB_UART_RX` / `USB_UART_TX` at 115200 baud.
Boards without a routed USB UART need that mapping added to their BSP before this logging example can compile.

## Files

- `Cargo.toml` — portable project marker used by the extension.
- `main.rs` — example application.
- `sram.rs` — Click driver translated from the supplied C package.
- `reference_c/` — original C source retained for comparison.
