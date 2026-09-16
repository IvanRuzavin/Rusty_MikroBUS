# EEPROM Click Rust example

This package is structured for the **reusable setup** workflow used by MikroBUS Rust Tools.
It intentionally contains no hard-coded SDK/Core paths and no standalone Click-driver Cargo crate.

The Rust driver is a direct port of the supplied **EEPROM Click** C package (`MIKROE-1200`, C package version `2.2.1`).
The Click uses I2C for EEPROM access and the mikroBUS PWM pin as the hardware write-protect (`WP`) signal.

## Implemented API

- `EepromConfig` — SCL/SDA/WP pin mapping, I2C speed and hardware address selection.
- `Eeprom::new()` — initializes I2C, applies the 7-bit EEPROM address and enables writes by default.
- `write_byte()` — writes one byte at an 8-bit EEPROM address.
- `write_page()` — writes one 16-byte page and waits for the internal write cycle.
- `read_byte()` — reads one byte.
- `read_sequential()` — reads 1 to 256 bytes beginning at a selected address.
- `write_enable()` — drives WP low.
- `write_protect()` — drives WP high.
- `EepromAddressSelector` — supports address selections 0 through 7 (`0x50` through `0x57`).

## Example behavior

The example mirrors the supplied C demo:

1. Initialize EEPROM Click on `MIKROBUS_1`.
2. Fill a 16-byte page with values `1..16`.
3. Enable writes and write the page at address `0x00`.
4. Enable hardware write protection.
5. Read the same 16 bytes back sequentially.
6. Print the values through the generated USB-UART mapping.

## Use

1. Open this folder in VS Code.
2. Configure/select a Rust MCU/Board setup in MikroBUS Rust Tools.
3. Apply that setup to this workspace. The extension generates `mikrobus.rs` beside `main.rs`.
4. Open `main.rs` and use **Build Current Rust File**, **Build & Flash Current Rust File**, or a debug action.

The Click uses these generated mappings:

- `MIKROBUS_1_SCL`
- `MIKROBUS_1_SDA`
- `MIKROBUS_1_PWM` for EEPROM WP
- `USB_UART_RX` / `USB_UART_TX` for example logging

Boards without a routed USB UART can still use the driver; disable `ENABLE_UART_OUTPUT` in `main.rs` or provide the appropriate USB-UART BSP mapping.

## Files

- `Cargo.toml` — portable project marker used by the extension.
- `main.rs` — EEPROM Click demo application.
- `eeprom.rs` — Rust EEPROM Click driver.
