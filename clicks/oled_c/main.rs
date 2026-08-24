#![no_std]
#![no_main]
#![allow(non_upper_case_globals)]

use panic_halt as _;
use system::init_clock::delay_1sec;

mod mikrobus_1;
mod oled_c;

use mikrobus_1::*;
use oled_c::{
    Config, OledC, COLOR_BLACK, COLOR_BLUE, COLOR_CYAN, COLOR_LIME, COLOR_MAGENTA,
    COLOR_RED, COLOR_WHITE, COLOR_YELLOW,
};

#[unsafe(no_mangle)]
fn main() -> ! {
    let config = Config {
        sck: MIKROBUS_1_SCK,
        miso: MIKROBUS_1_MISO,
        mosi: MIKROBUS_1_MOSI,
        cs: MIKROBUS_1_CS,
        rw: MIKROBUS_1_AN,
        rst: MIKROBUS_1_RST,
        dc: MIKROBUS_1_PWM,
        enable: MIKROBUS_1_INT,
        spi_speed: 100_000,
    };

    let mut display = match OledC::new(config) {
        Ok(display) => display,
        Err(_) => loop {},
    };
    if display.default_config().is_err() {
        loop {}
    }

    let _ = display.fill_screen(COLOR_WHITE);
    let _ = display.draw_text("Hello", 15, 10, COLOR_BLACK);
    let _ = display.draw_text("this is demo", 9, 30, COLOR_BLUE);
    let _ = display.draw_text("OLED C Click", 9, 50, COLOR_RED);
    delay_1sec();
    delay_1sec();

    loop {
        let _ = display.fill_screen(COLOR_WHITE);
        let colors = [
            COLOR_RED,
            COLOR_YELLOW,
            COLOR_LIME,
            COLOR_CYAN,
            COLOR_BLUE,
            COLOR_MAGENTA,
        ];
        for (index, color) in colors.iter().enumerate() {
            let inset = (index as u8) * 6;
            let _ = display.fill_rectangle(inset, inset, 96 - inset, 96 - inset, *color);
            delay_1sec();
        }

        let _ = display.fill_screen(COLOR_BLACK);
        let _ = display.draw_line(0, 0, 95, 95, COLOR_CYAN);
        let _ = display.draw_line(95, 0, 0, 95, COLOR_CYAN);
        let _ = display.draw_line(0, 48, 95, 48, COLOR_YELLOW);
        let _ = display.draw_line(48, 0, 48, 95, COLOR_YELLOW);
        delay_1sec();
        delay_1sec();

        for y in 0..8u8 {
            for x in 0..8u8 {
                let color = if (x + y) & 1 == 0 {
                    COLOR_BLUE
                } else {
                    COLOR_MAGENTA
                };
                let _ = display.fill_rectangle(x * 12, y * 12, x * 12 + 12, y * 12 + 12, color);
            }
        }
        delay_1sec();
        delay_1sec();
    }
}
