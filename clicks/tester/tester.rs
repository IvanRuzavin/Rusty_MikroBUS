/****************************************************************************
**
** Copyright (C) ${COPYRIGHT_YEAR} MikroElektronika d.o.o.
** Contact: https://www.mikroe.com/contact
**
** This file is part of the mikroSDK package
**
****************************************************************************/
#![no_std]

use drv_digital_out::{
    digital_out_high, digital_out_init, digital_out_low, digital_out_t,
};
use drv_name::{pin_name_t, HAL_PIN_NC};

pub const TESTER_OK: u8 = 0x00;
pub const TESTER_INIT_ERROR: u8 = 0xFF;

#[derive(Clone, Copy)]
pub struct TesterCfg {
    pub scl: pin_name_t,
    pub sda: pin_name_t,
    pub sck: pin_name_t,
    pub miso: pin_name_t,
    pub mosi: pin_name_t,
    pub cs: pin_name_t,
    pub tx_pin: pin_name_t,
    pub rx_pin: pin_name_t,
    pub an: pin_name_t,
    pub rst: pin_name_t,
    pub pwm: pin_name_t,
    pub int_pin: pin_name_t,
}

impl Default for TesterCfg {
    fn default() -> Self {
        Self {
            scl: HAL_PIN_NC,
            sda: HAL_PIN_NC,
            sck: HAL_PIN_NC,
            miso: HAL_PIN_NC,
            mosi: HAL_PIN_NC,
            cs: HAL_PIN_NC,
            tx_pin: HAL_PIN_NC,
            rx_pin: HAL_PIN_NC,
            an: HAL_PIN_NC,
            rst: HAL_PIN_NC,
            pwm: HAL_PIN_NC,
            int_pin: HAL_PIN_NC,
        }
    }
}

pub struct Tester {
    pub scl: digital_out_t,
    pub sda: digital_out_t,
    pub sck: digital_out_t,
    pub miso: digital_out_t,
    pub mosi: digital_out_t,
    pub cs: digital_out_t,
    pub tx_pin: digital_out_t,
    pub rx_pin: digital_out_t,
    pub an: digital_out_t,
    pub rst: digital_out_t,
    pub pwm: digital_out_t,
    pub int_pin: digital_out_t,
}

impl Default for Tester {
    fn default() -> Self {
        Self {
            scl: digital_out_t::default(),
            sda: digital_out_t::default(),
            sck: digital_out_t::default(),
            miso: digital_out_t::default(),
            mosi: digital_out_t::default(),
            cs: digital_out_t::default(),
            tx_pin: digital_out_t::default(),
            rx_pin: digital_out_t::default(),
            an: digital_out_t::default(),
            rst: digital_out_t::default(),
            pwm: digital_out_t::default(),
            int_pin: digital_out_t::default(),
        }
    }
}

pub fn tester_init(ctx: &mut Tester, cfg: &TesterCfg) -> Result<(), ()> {
    digital_out_init(&mut ctx.scl, cfg.scl).map_err(|_| ())?;
    digital_out_init(&mut ctx.sda, cfg.sda).map_err(|_| ())?;
    digital_out_init(&mut ctx.sck, cfg.sck).map_err(|_| ())?;
    digital_out_init(&mut ctx.miso, cfg.miso).map_err(|_| ())?;
    digital_out_init(&mut ctx.mosi, cfg.mosi).map_err(|_| ())?;
    digital_out_init(&mut ctx.cs, cfg.cs).map_err(|_| ())?;
    digital_out_init(&mut ctx.tx_pin, cfg.tx_pin).map_err(|_| ())?;
    digital_out_init(&mut ctx.rx_pin, cfg.rx_pin).map_err(|_| ())?;
    digital_out_init(&mut ctx.an, cfg.an).map_err(|_| ())?;
    digital_out_init(&mut ctx.rst, cfg.rst).map_err(|_| ())?;
    digital_out_init(&mut ctx.pwm, cfg.pwm).map_err(|_| ())?;
    digital_out_init(&mut ctx.int_pin, cfg.int_pin).map_err(|_| ())?;
    Ok(())
}

pub fn tester_set_pin_high(pin: &mut digital_out_t) {
    let _ = digital_out_high(pin);
}

pub fn tester_set_pin_low(pin: &mut digital_out_t) {
    let _ = digital_out_low(pin);
}
