#![no_std]
#![no_main]
#![allow(non_upper_case_globals)]

use panic_halt as _;
use system::init_clock::Delay_ms;
use drv_uart::{uart_config_t, uart_open, uart_print, uart_println, uart_set_baud, uart_set_blocking, uart_t, uart_write};

mod mikrobus;
mod pot;

use pot::{Pot, PotConfig};


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


fn uart_print_u32(uart: &mut uart_t, mut value: u32) {
    let mut buffer = [0u8; 10];
    let mut start = buffer.len();

    if value == 0 {
        let mut zero = [b'0'];
        let _ = uart_write(uart, &mut zero, 1);
        return;
    }

    while value > 0 {
        start -= 1;
        buffer[start] = b'0' + (value % 10) as u8;
        value /= 10;
    }

    let len = buffer.len() - start;
    let _ = uart_write(uart, &mut buffer[start..], len);
}

fn uart_print_fixed(uart: &mut uart_t, value: f32, decimals: u32) {
    let scale = match decimals {
        0 => 1u32,
        1 => 10u32,
        2 => 100u32,
        _ => 1000u32,
    };

    let negative = value < 0.0;
    let absolute = if negative { -value } else { value };
    let scaled = (absolute * scale as f32 + 0.5) as u32;
    let integer = scaled / scale;
    let fraction = scaled % scale;

    if negative {
        let mut minus = [b'-'];
        let _ = uart_write(uart, &mut minus, 1);
    }

    uart_print_u32(uart, integer);

    if decimals > 0 {
        let mut dot = [b'.'];
        let _ = uart_write(uart, &mut dot, 1);

        let width = decimals.min(3) as usize;
        let mut digits = [b'0'; 3];
        let mut remainder = fraction;
        let mut index = width;
        while index > 0 {
            index -= 1;
            digits[index] = b'0' + (remainder % 10) as u8;
            remainder /= 10;
        }
        let _ = uart_write(uart, &mut digits[..width], width);
    }
}

#[unsafe(no_mangle)]
fn main() -> ! {
    let mut log_uart = init_log_uart();
    if let Some(uart) = log_uart.as_mut() { let _ = uart_println(uart, " Application Init "); }

    let config = PotConfig { an: mikrobus::MIKROBUS_1_AN, ..Default::default() };
    let mut pot = Pot::new(config).unwrap_or_else(|_| {
        if let Some(uart) = log_uart.as_mut() { let _ = uart_println(uart, " Communication init."); }
        loop {}
    });
    if let Some(uart) = log_uart.as_mut() { let _ = uart_println(uart, " Application Task "); }

    loop {
        if let Ok(voltage) = pot.read_voltage() {
            if let Some(uart) = log_uart.as_mut() {
                let _ = uart_print(uart, " AN Voltage : ");
                uart_print_fixed(uart, voltage, 3);
                let _ = uart_println(uart, "[V]");
            }
            Delay_ms(1_000);
        }
    }
}
