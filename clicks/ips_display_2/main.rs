#![no_std]
#![no_main]
#![allow(non_upper_case_globals)]

use panic_halt as _;

use system::init_clock::delay_1sec;

mod ips_display_2;
mod mikrobus;

use ips_display_2::{
    Config, IpsDisplay2, Point, COLOR_BLACK, COLOR_BLUE, COLOR_CYAN, COLOR_LIME,
    COLOR_MAGENTA, COLOR_RED, COLOR_YELLOW,
};
use mikrobus::*;

#[unsafe(no_mangle)]
fn main() -> ! {
    let config = Config {
        sck: MIKROBUS_3_SCK,
        miso: MIKROBUS_3_MISO,
        mosi: MIKROBUS_3_MOSI,
        cs: MIKROBUS_3_CS,
        rst: MIKROBUS_3_RST,
        dc: MIKROBUS_3_INT,
        backlight: MIKROBUS_3_AN,
        spi_speed: 5_000_000,
    };

    let mut display = match IpsDisplay2::new(config) {
        Ok(display) => display,
        Err(_) => loop {},
    };
    if display.default_config().is_err() {
        loop {}
    }

    loop {
        let _ = display.fill_screen(COLOR_RED);
        delay_1sec();
        let _ = display.fill_screen(COLOR_LIME);
        delay_1sec();
        let _ = display.fill_screen(COLOR_BLUE);
        delay_1sec();

        let _ = display.fill_screen(COLOR_BLACK);
        let _ = display.draw_line(Point { x: 0, y: 0 }, Point { x: 239, y: 239 }, COLOR_BLUE);
        let _ = display.draw_line(Point { x: 239, y: 0 }, Point { x: 0, y: 239 }, COLOR_BLUE);
        let _ = display.draw_rectangle(Point { x: 40, y: 30 }, Point { x: 200, y: 100 }, COLOR_CYAN);
        let _ = display.draw_rectangle(Point { x: 40, y: 140 }, Point { x: 200, y: 210 }, COLOR_YELLOW);
        let _ = display.draw_circle(Point { x: 120, y: 120 }, 55, COLOR_MAGENTA);
        delay_1sec();
        delay_1sec();
    }
}
