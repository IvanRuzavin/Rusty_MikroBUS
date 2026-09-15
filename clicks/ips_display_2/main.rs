#![no_std]
#![no_main]
#![allow(non_upper_case_globals)]

use panic_halt as _;
use system::init_clock::Delay_ms;
use drv_uart::{uart_config_t, uart_open, uart_print, uart_set_baud, uart_set_blocking, uart_t};

mod ipsdisplay2;
mod mikrobus;

use ipsdisplay2::{
    resources, IpsDisplay2, IpsDisplay2Config, Point, COLOR_BLACK, COLOR_BLUE,
    COLOR_CYAN, COLOR_LIME, COLOR_MAGENTA, COLOR_RED,
};


const ENABLE_UART_OUTPUT: bool = true;

fn init_log_uart() -> Option<uart_t> {
    if !ENABLE_UART_OUTPUT {
        return None;
    }

    let mut uart = uart_t::default();
    let mut config = uart_config_t::default();
    config.rx = mikrobus::USB_UART_RX;
    config.tx = mikrobus::USB_UART_TX;

    if uart_open(&mut uart, config).is_err() {
        return None;
    }
    if uart_set_baud(&mut uart, 115_200).is_err() {
        return None;
    }
    if uart_set_blocking(&mut uart, false).is_err() {
        return None;
    }

    Some(uart)
}

#[unsafe(no_mangle)]
fn main() -> ! {
    let mut log_uart = init_log_uart();
    if let Some(uart) = log_uart.as_mut() {
        let _ = uart_print(uart, " Application Init \r\n");
    }

    let config = IpsDisplay2Config {
        sck: mikrobus::MIKROBUS_1_SCK,
        miso: mikrobus::MIKROBUS_1_MISO,
        mosi: mikrobus::MIKROBUS_1_MOSI,
        cs: mikrobus::MIKROBUS_1_CS,
        rst: mikrobus::MIKROBUS_1_RST,
        backlight: mikrobus::MIKROBUS_1_AN,
        dc: mikrobus::MIKROBUS_1_INT,
        ..Default::default()
    };
    let mut display = IpsDisplay2::new(config).unwrap_or_else(|_| loop {});
    if display.default_config().is_err() { loop {} }
    if let Some(uart) = log_uart.as_mut() { let _ = uart_print(uart, " Application Task \r\n"); }

    loop {
        if let Some(uart) = log_uart.as_mut() { let _ = uart_print(uart, " Drawing MIKROE logo example\r\n"); }
        let _ = display.draw_picture(&resources::IPSDISPLAY2_IMG_MIKROE);
        Delay_ms(3_000);

        if let Some(uart) = log_uart.as_mut() { let _ = uart_print(uart, " Writing text example\r\n"); }
        let _ = display.fill_screen(COLOR_BLACK);
        Delay_ms(1_000);
        for (y, text) in [
            (50, "      MIKROE      "), (70, "   IPS Display 2  "), (90, "       Click      "),
            (110, "     240x240px    "), (130, "ST7789V controller"), (150, "   TEST EXAMPLE   "),
        ] { let _ = display.write_string(Point { x: 0, y }, text, COLOR_RED); }
        Delay_ms(3_000);

        if let Some(uart) = log_uart.as_mut() { let _ = uart_print(uart, " RGB fill screen example\r\n"); }
        for color in [COLOR_RED, COLOR_LIME, COLOR_BLUE] {
            let _ = display.fill_screen(color);
            Delay_ms(1_000);
        }

        if let Some(uart) = log_uart.as_mut() { let _ = uart_print(uart, " Drawing objects example\r\n"); }
        let _ = display.fill_screen(COLOR_BLACK);
        Delay_ms(1_000);
        let _ = display.draw_line(Point { x: 0, y: 0 }, Point { x: 239, y: 239 }, COLOR_BLUE);
        Delay_ms(1_000);
        let _ = display.draw_line(Point { x: 239, y: 0 }, Point { x: 0, y: 239 }, COLOR_BLUE);
        Delay_ms(1_000);
        let _ = display.draw_rectangle(Point { x: 60, y: 40 }, Point { x: 180, y: 100 }, COLOR_CYAN);
        Delay_ms(1_000);
        let _ = display.draw_rectangle(Point { x: 60, y: 140 }, Point { x: 180, y: 200 }, COLOR_CYAN);
        Delay_ms(1_000);
        let _ = display.draw_circle(Point { x: 120, y: 120 }, 120, COLOR_MAGENTA);
        Delay_ms(2_000);
    }
}
