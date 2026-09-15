#![no_std]
#![no_main]
#![allow(non_upper_case_globals)]

use panic_halt as _;
use system::init_clock::Delay_ms;
use drv_uart::{uart_config_t, uart_open, uart_println, uart_set_baud, uart_set_blocking, uart_t};

mod buzz;
mod mikrobus;

use buzz::*;


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

const Q: u16 = 250;
const E: u16 = Q / 2;
const S: u16 = Q / 4;
const H: u16 = 2 * Q;
const VOLUME: u16 = 100;

fn play_note(buzz: &mut Buzz, frequency: u16, duration: u16) {
    if frequency == 0 {
        Delay_ms((1 + duration) as u32);
        return;
    }
    let _ = buzz.play_sound(frequency, VOLUME, duration);
    Delay_ms((1 + duration) as u32);
}

fn imperial_march(buzz: &mut Buzz) {
    let sequence: &[(u16, u16)] = &[
        (BUZZ_NOTE_A6,Q),(BUZZ_NOTE_A6,Q),(BUZZ_NOTE_A6,Q),(BUZZ_NOTE_F6,E+S),(BUZZ_NOTE_C7,S),
        (BUZZ_NOTE_A6,Q),(BUZZ_NOTE_F6,E+S),(BUZZ_NOTE_C7,S),(BUZZ_NOTE_A6,H),
        (BUZZ_NOTE_E7,Q),(BUZZ_NOTE_E7,Q),(BUZZ_NOTE_E7,Q),(BUZZ_NOTE_F7,E+S),(BUZZ_NOTE_C7,S),
        (BUZZ_NOTE_AB6,Q),(BUZZ_NOTE_F6,E+S),(BUZZ_NOTE_C7,S),(BUZZ_NOTE_A6,H),
        (BUZZ_NOTE_A7,Q),(BUZZ_NOTE_A6,E+S),(BUZZ_NOTE_A6,S),(BUZZ_NOTE_A7,Q),(BUZZ_NOTE_AB7,E+S),
        (BUZZ_NOTE_G7,S),(BUZZ_NOTE_GB7,S),(BUZZ_NOTE_E7,Q),(BUZZ_NOTE_F7,E),(0,E),(BUZZ_NOTE_BB6,E),
        (BUZZ_NOTE_EB7,Q),(BUZZ_NOTE_D7,E+S),(BUZZ_NOTE_DB7,S),(BUZZ_NOTE_C7,S),(BUZZ_NOTE_B6,S),
        (BUZZ_NOTE_C7,E),(0,E),(BUZZ_NOTE_F6,E),(BUZZ_NOTE_AB6,Q),(BUZZ_NOTE_F6,E+S),(BUZZ_NOTE_A6,S),
        (BUZZ_NOTE_C7,Q),(BUZZ_NOTE_A6,E+S),(BUZZ_NOTE_C7,S),(BUZZ_NOTE_E7,H),
        (BUZZ_NOTE_A7,Q),(BUZZ_NOTE_A6,E+S),(BUZZ_NOTE_A6,S),(BUZZ_NOTE_A7,Q),(BUZZ_NOTE_AB7,E+S),
        (BUZZ_NOTE_G7,S),(BUZZ_NOTE_GB7,S),(BUZZ_NOTE_E7,S),(BUZZ_NOTE_F7,E),(0,E),(BUZZ_NOTE_BB6,E),
        (BUZZ_NOTE_EB7,Q),(BUZZ_NOTE_D7,E+S),(BUZZ_NOTE_DB7,S),(BUZZ_NOTE_C7,S),(BUZZ_NOTE_B6,S),
        (BUZZ_NOTE_C7,E),(0,E),(BUZZ_NOTE_F6,E),(BUZZ_NOTE_AB6,Q),(BUZZ_NOTE_F6,E+S),(BUZZ_NOTE_C7,S),
        (BUZZ_NOTE_A6,Q),(BUZZ_NOTE_F6,E+S),(BUZZ_NOTE_C7,S),(BUZZ_NOTE_AB6,H),
    ];
    for &(frequency, duration) in sequence {
        play_note(buzz, frequency, duration);
    }
}

#[unsafe(no_mangle)]
fn main() -> ! {
    let mut log_uart = init_log_uart();
    if let Some(uart) = log_uart.as_mut() {
        let _ = uart_println(uart, " Application Init ");
    }

    let config = BuzzConfig {
        pwm: mikrobus::MIKROBUS_1_PWM,
        ..Default::default()
    };
    let mut buzz = Buzz::new(config).unwrap_or_else(|_| {
        if let Some(uart) = log_uart.as_mut() {
            let _ = uart_println(uart, " Application Init Error.");
        }
        loop {}
    });
    let _ = buzz.set_duty_cycle(0.0);
    let _ = buzz.start();
    if let Some(uart) = log_uart.as_mut() {
        let _ = uart_println(uart, " Application Task ");
    }

    loop {
        if let Some(uart) = log_uart.as_mut() {
            let _ = uart_println(uart, "Playing the Imperial March melody ...");
        }
        imperial_march(&mut buzz);
        Delay_ms(10_000);
    }
}
