#![no_std]
#![no_main]
#![allow(non_upper_case_globals)]

use panic_halt as _;
use system::init_clock::Delay_ms;
use drv_uart::{uart_config_t, uart_open, uart_print, uart_println, uart_set_baud, uart_set_blocking, uart_t, uart_write};

mod mikrobus;
mod sram;

use sram::{Sram, SramConfig};


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
    Delay_ms(100);
    if let Some(uart) = log_uart.as_mut() { let _ = uart_println(uart, "---- Application Init ----"); }

    let config = SramConfig {
        sck: mikrobus::MIKROBUS_1_SCK,
        miso: mikrobus::MIKROBUS_1_MISO,
        mosi: mikrobus::MIKROBUS_1_MOSI,
        cs: mikrobus::MIKROBUS_1_CS,
        hold: mikrobus::MIKROBUS_1_RST,
        ..Default::default()
    };
    let mut sram = Sram::new(config).unwrap_or_else(|_| loop {});

    if let Some(uart) = log_uart.as_mut() {
        let _ = uart_println(uart, "--------------------------");
        let _ = uart_println(uart, " ------ SRAM Click  ----- ");
        let _ = uart_println(uart, "--------------------------");
    }
    Delay_ms(1_000);

    let data = *b"mikroElektronika ";
    loop {
        if let Some(uart) = log_uart.as_mut() { let _ = uart_println(uart, " Writing text :"); }
        for (index, value) in data.iter().take(16).enumerate() {
            let _ = sram.write_byte(index as u32, *value);
            Delay_ms(100);
            if let Some(uart) = log_uart.as_mut() {
                let mut byte = [*value];
                let _ = uart_write(uart, &mut byte, 1);
            }
        }

        if let Some(uart) = log_uart.as_mut() { let _ = uart_println(uart, "
 Read text :"); }
        for index in 0..16u32 {
            if let Ok(value) = sram.read_byte(index) {
                if let Some(uart) = log_uart.as_mut() {
                    let mut byte = [value];
                    let _ = uart_write(uart, &mut byte, 1);
                }
            }
            Delay_ms(100);
        }
        if let Some(uart) = log_uart.as_mut() { let _ = uart_println(uart, "
--------------------------"); }
        Delay_ms(1_000);
    }
}
