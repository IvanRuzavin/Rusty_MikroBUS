#![no_std]
#![no_main]
#![allow(non_upper_case_globals)]

use panic_halt as _;
use drv_uart::{
    uart_config_t, uart_open, uart_print, uart_println, uart_set_baud, uart_set_blocking,
    uart_t, uart_write,
};
use system::init_clock::Delay_ms;

mod eeprom;
mod mikrobus;

use eeprom::{Eeprom, EepromConfig, EEPROM_BLOCK_ADDR_START, EEPROM_NBYTES_PAGE};

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

#[unsafe(no_mangle)]
fn main() -> ! {
    let mut log_uart = init_log_uart();
    if let Some(uart) = log_uart.as_mut() {
        let _ = uart_println(uart, "---- Application Init ----");
    }

    let config = EepromConfig {
        wp: mikrobus::MIKROBUS_1_PWM,
        scl: mikrobus::MIKROBUS_1_SCL,
        sda: mikrobus::MIKROBUS_1_SDA,
        ..Default::default()
    };

    let mut eeprom = Eeprom::new(config).unwrap_or_else(|_| {
        if let Some(uart) = log_uart.as_mut() {
            let _ = uart_println(uart, " EEPROM communication init error.");
        }
        loop {}
    });

    if let Some(uart) = log_uart.as_mut() {
        let _ = uart_println(uart, "------ EEPROM Click ------");
        let _ = uart_println(uart, "---- Application Task ----");
    }

    let mut transfer_data = [0u8; EEPROM_NBYTES_PAGE];
    for (index, value) in transfer_data.iter_mut().enumerate() {
        *value = (index + 1) as u8;
    }

    loop {
        if eeprom.write_enable().is_err() {
            if let Some(uart) = log_uart.as_mut() {
                let _ = uart_println(uart, " Write-enable error.");
            }
            loop {}
        }

        if eeprom
            .write_page(EEPROM_BLOCK_ADDR_START, &transfer_data)
            .is_err()
        {
            if let Some(uart) = log_uart.as_mut() {
                let _ = uart_println(uart, " EEPROM page-write error.");
            }
            loop {}
        }

        if eeprom.write_protect().is_err() {
            if let Some(uart) = log_uart.as_mut() {
                let _ = uart_println(uart, " Write-protect error.");
            }
            loop {}
        }

        Delay_ms(1_000);

        let mut read_buffer = [0u8; EEPROM_NBYTES_PAGE];
        match eeprom.read_sequential(EEPROM_BLOCK_ADDR_START, &mut read_buffer) {
            Ok(()) => {
                if let Some(uart) = log_uart.as_mut() {
                    let _ = uart_print(uart, " Read data:");
                    for value in read_buffer {
                        let _ = uart_print(uart, " ");
                        uart_print_u32(uart, value as u32);
                        Delay_ms(300);
                    }
                    let _ = uart_println(uart, "");
                }
            }
            Err(()) => {
                if let Some(uart) = log_uart.as_mut() {
                    let _ = uart_println(uart, " EEPROM sequential-read error.");
                }
            }
        }

        Delay_ms(1_000);
    }
}
