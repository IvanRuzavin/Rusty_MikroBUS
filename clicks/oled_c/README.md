# OLED C Click Rust example

This is a complete `no_std` Rust project for the SSD1351-based 96 x 96 OLED C Click on **mikroBUS 1 of the Nucleo-F412ZG Click shield**. It includes the controller initialization sequence, RGB565 screen and rectangle fills, pixels, Bresenham lines, RGB565 image transfer, compact text rendering, and a hardware demo.

Open `main.rs`, apply a reusable `STM32F412ZG` SDK setup from **MikroBUS Rust: Configure MCU**, and press:

- `Ctrl+Shift+B` to build;
- `Ctrl+F5` to build and flash;
- `F5` to debug.

## mikroBUS 1 wiring

The mappings are resolved directly from the supplied Nucleo-F412ZG `board.h` and Click shield `shield.h` files.

| OLED C signal | mikroBUS 1 | STM32F412ZG GPIO |
|---|---|---|
| R/W | AN | PC0 |
| Reset | RST | PA13 |
| Chip select | CS | PA4 |
| SPI clock | SCK | PB3 |
| SPI MISO | MISO | PB4 |
| SPI MOSI | MOSI | PB5 |
| Data/command | PWM | PC6 |
| Enable | INT | PF13 |

`mikrobus_1.rs` also defines the remaining RX, TX, SCL, and SDA pins for the socket.

> **Debug note:** `PA13` is also STM32F412ZG SWDIO. The supplied shield mapping assigns this pin to mikroBUS 1 RST, so OLED initialization can disconnect an active SWD debug session when reset is configured as GPIO. Build/flash remains usable; reliable live debugging requires alternate reset routing or a shield revision that does not reuse SWDIO.

## Files

- `main.rs` — executable OLED demo using mikroBUS 1;
- `oled_c.rs` — reusable SSD1351 driver;
- `mikrobus_1.rs` — full Nucleo-F412ZG mikroBUS 1 pin map.
