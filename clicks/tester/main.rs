#![no_std]
#![no_main]
#![allow(non_upper_case_globals)]

use drv_digital_out::digital_out_t;
use panic_halt as _;
use system::init_clock::Delay_ms;
use drv_uart::{uart_config_t, uart_open, uart_println, uart_set_baud, uart_set_blocking, uart_t};

mod mikrobus;
mod tester;

use tester::{tester_init, tester_set_pin_high, tester_set_pin_low, Tester, TesterCfg};


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

fn blink(pin: &mut digital_out_t) {
    tester_set_pin_high(pin);
    Delay_ms(100);
    tester_set_pin_low(pin);
}

fn all_on(tester: &mut Tester) {
    tester_set_pin_high(&mut tester.mosi); tester_set_pin_high(&mut tester.miso);
    tester_set_pin_high(&mut tester.sck); tester_set_pin_high(&mut tester.cs);
    tester_set_pin_high(&mut tester.rst); tester_set_pin_high(&mut tester.an);
    tester_set_pin_high(&mut tester.pwm); tester_set_pin_high(&mut tester.int_pin);
    tester_set_pin_high(&mut tester.tx_pin); tester_set_pin_high(&mut tester.rx_pin);
    tester_set_pin_high(&mut tester.scl); tester_set_pin_high(&mut tester.sda);
}
fn all_off(tester: &mut Tester) {
    tester_set_pin_low(&mut tester.mosi); tester_set_pin_low(&mut tester.miso);
    tester_set_pin_low(&mut tester.sck); tester_set_pin_low(&mut tester.cs);
    tester_set_pin_low(&mut tester.rst); tester_set_pin_low(&mut tester.an);
    tester_set_pin_low(&mut tester.pwm); tester_set_pin_low(&mut tester.int_pin);
    tester_set_pin_low(&mut tester.tx_pin); tester_set_pin_low(&mut tester.rx_pin);
    tester_set_pin_low(&mut tester.scl); tester_set_pin_low(&mut tester.sda);
}

#[unsafe(no_mangle)]
fn main() -> ! {
    let mut log_uart = init_log_uart();
    if let Some(uart) = log_uart.as_mut() { let _ = uart_println(uart, "---- Application Init ----"); }

    let mut tester = Tester::default();
    let config = TesterCfg {
        an: mikrobus::MIKROBUS_1_AN, rst: mikrobus::MIKROBUS_1_RST,
        cs: mikrobus::MIKROBUS_1_CS, pwm: mikrobus::MIKROBUS_1_PWM,
        int_pin: mikrobus::MIKROBUS_1_INT, scl: mikrobus::MIKROBUS_1_SCL,
        sda: mikrobus::MIKROBUS_1_SDA, sck: mikrobus::MIKROBUS_1_SCK,
        miso: mikrobus::MIKROBUS_1_MISO, mosi: mikrobus::MIKROBUS_1_MOSI,
        tx_pin: mikrobus::MIKROBUS_1_RX, rx_pin: mikrobus::MIKROBUS_1_TX,
    };

    if tester_init(&mut tester, &config).is_err() {
        if let Some(uart) = log_uart.as_mut() { let _ = uart_println(uart, "Tester Click initialization failed."); }
        loop {}
    }
    all_off(&mut tester);
    if let Some(uart) = log_uart.as_mut() { let _ = uart_println(uart, "Tester Click initialized. Starting pin sequence."); }

    loop {
        blink(&mut tester.mosi); blink(&mut tester.miso); blink(&mut tester.sck); blink(&mut tester.cs);
        blink(&mut tester.rst); blink(&mut tester.an); blink(&mut tester.pwm); blink(&mut tester.int_pin);
        blink(&mut tester.tx_pin); blink(&mut tester.rx_pin); blink(&mut tester.scl); blink(&mut tester.sda);
        all_on(&mut tester); Delay_ms(1_000); all_off(&mut tester);
    }
}
