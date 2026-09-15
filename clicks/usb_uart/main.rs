#![no_std]
#![no_main]
#![allow(non_upper_case_globals)]

use panic_halt as _;
use system::init_clock::Delay_ms;
use drv_uart::{uart_config_t, uart_open, uart_print, uart_println, uart_set_baud, uart_set_blocking, uart_t, uart_write};

mod mikrobus;
mod usbuart;

use usbuart::*;


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
    if let Some(uart) = log_uart.as_mut() { let _ = uart_println(uart, " Application Init "); }
    Delay_ms(100);

    let config = UsbUartConfig {
        tx: mikrobus::MIKROBUS_1_TX,
        rx: mikrobus::MIKROBUS_1_RX,
        cts: mikrobus::MIKROBUS_1_RST,
        sleep: mikrobus::MIKROBUS_1_CS,
        power: mikrobus::MIKROBUS_1_PWM,
        rts: mikrobus::MIKROBUS_1_INT,
        ..Default::default()
    };
    let mut click = UsbUart::new(config).unwrap_or_else(|_| loop {});
    click.power_control(USBUART_POWER_ON);
    click.set_cts(USBUART_CTS_NOT_ACTIVE);
    click.set_mode(USBUART_MODE_NORMAL);
    if let Some(uart) = log_uart.as_mut() { let _ = uart_println(uart, " Application Task "); }

    let mut buffer = [0u8; 100];
    loop {
        if let Ok(length) = click.read(&mut buffer) {
            if length > 0 {
                if let Some(uart) = log_uart.as_mut() {
                    let _ = uart_write(uart, &mut buffer[..length], length);
                }
                buffer.fill(0);
            }
        }
    }
}
