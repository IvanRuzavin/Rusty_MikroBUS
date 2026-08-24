# IPS Display 2 Click Rust example

Open `main.rs`, apply a configured MCU setup from **MikroBUS Rust: Configure MCU**, and press:

- `Ctrl+Shift+B` to build;
- `Ctrl+F5` to build and flash;
- `F5` to debug.

The example targets the ST7789V-based 240x240 IPS Display 2 Click. It contains the initialization sequence, rotation/window handling, RGB565 screen fill, pixel, line, rectangle, circle, and backlight control.

The pin block at the top of `main.rs` uses the SPI and GPIO pins exercised by the supplied STM32F412RE SDK tests. If your Click is on a different board or mikroBUS socket, replace only `PIN_SCK`, `PIN_MISO`, `PIN_MOSI`, `PIN_CS`, `PIN_RST`, `PIN_DC`, and `PIN_BACKLIGHT` with that socket's mapping.
