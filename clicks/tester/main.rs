#![no_std]
#![no_main]
#![allow(non_upper_case_globals)]

use panic_halt as _;

use tester::{tester_init, tester_set_pin_high, tester_set_pin_low, Tester, TesterCfg};

mod delay;
mod logger;

use delay::delay_ms;
use logger::UartLogger;

mod mikrobus;

fn blink(pin: &mut drv_digital_out::digital_out_t) {
    tester_set_pin_high(pin);
    delay_ms(100);
    tester_set_pin_low(pin);
}

fn all_on(tester: &mut Tester) {
    tester_set_pin_high(&mut tester.mosi);
    tester_set_pin_high(&mut tester.miso);
    tester_set_pin_high(&mut tester.sck);
    tester_set_pin_high(&mut tester.cs);
    tester_set_pin_high(&mut tester.rst);
    tester_set_pin_high(&mut tester.an);
    tester_set_pin_high(&mut tester.pwm);
    tester_set_pin_high(&mut tester.int_pin);
    tester_set_pin_high(&mut tester.tx_pin);
    tester_set_pin_high(&mut tester.rx_pin);
    tester_set_pin_high(&mut tester.scl);
    tester_set_pin_high(&mut tester.sda);
}

fn all_off(tester: &mut Tester) {
    tester_set_pin_low(&mut tester.mosi);
    tester_set_pin_low(&mut tester.miso);
    tester_set_pin_low(&mut tester.sck);
    tester_set_pin_low(&mut tester.cs);
    tester_set_pin_low(&mut tester.rst);
    tester_set_pin_low(&mut tester.an);
    tester_set_pin_low(&mut tester.pwm);
    tester_set_pin_low(&mut tester.int_pin);
    tester_set_pin_low(&mut tester.tx_pin);
    tester_set_pin_low(&mut tester.rx_pin);
    tester_set_pin_low(&mut tester.scl);
    tester_set_pin_low(&mut tester.sda);
}

#[unsafe(no_mangle)]
pub extern "C" fn main() -> ! {
    let mut log = UartLogger::new(mikrobus::USB_UART_RX, mikrobus::USB_UART_TX)
        .unwrap_or_else(|_| loop {});
    let _ = writeln!(log, "---- Application Init ----");

    let mut tester = Tester::default();
    let cfg = TesterCfg {
        an: mikrobus::MIKROBUS_1_AN,
        rst: mikrobus::MIKROBUS_1_RST,
        cs: mikrobus::MIKROBUS_1_CS,
        pwm: mikrobus::MIKROBUS_1_PWM,
        int_pin: mikrobus::MIKROBUS_1_INT,
        scl: mikrobus::MIKROBUS_1_SCL,
        sda: mikrobus::MIKROBUS_1_SDA,
        sck: mikrobus::MIKROBUS_1_SCK,
        miso: mikrobus::MIKROBUS_1_MISO,
        mosi: mikrobus::MIKROBUS_1_MOSI,
        // Preserve the official C TESTER_MAP_MIKROBUS mapping. The Click's
        // TX test output drives the socket RX line and vice versa.
        tx_pin: mikrobus::MIKROBUS_1_RX,
        rx_pin: mikrobus::MIKROBUS_1_TX,
    };

    if tester_init(&mut tester, &cfg).is_err() {
        let _ = writeln!(log, "Tester Click initialization failed.");
        loop {}
    }

    all_off(&mut tester);
    let _ = writeln!(log, "Tester Click initialized. Starting pin sequence.");

    loop {
        // Same order as the official C example: left side top-to-bottom,
        // then right side top-to-bottom.
        blink(&mut tester.mosi);
        blink(&mut tester.miso);
        blink(&mut tester.sck);
        blink(&mut tester.cs);
        blink(&mut tester.rst);
        blink(&mut tester.an);
        blink(&mut tester.pwm);
        blink(&mut tester.int_pin);
        blink(&mut tester.tx_pin);
        blink(&mut tester.rx_pin);
        blink(&mut tester.scl);
        blink(&mut tester.sda);

        all_on(&mut tester);
        delay_ms(1000);
        all_off(&mut tester);
    }
}
