//! Nucleo-F412ZG Click shield mikroBUS 1 mapping.
//!
//! Values come from the supplied `board.h` and `shield.h` connector maps.

#![allow(dead_code)]

use drv_name::*;

pub const MIKROBUS_1_AN: pin_name_t = GPIO_C0;
pub const MIKROBUS_1_RST: pin_name_t = GPIO_A6;
pub const MIKROBUS_1_CS: pin_name_t = GPIO_A4;
pub const MIKROBUS_1_SCK: pin_name_t = GPIO_B3;
pub const MIKROBUS_1_MISO: pin_name_t = GPIO_B4;
pub const MIKROBUS_1_MOSI: pin_name_t = GPIO_B5;
pub const MIKROBUS_1_PWM: pin_name_t = GPIO_C6;
pub const MIKROBUS_1_INT: pin_name_t = GPIO_A5;
pub const MIKROBUS_1_RX: pin_name_t = GPIO_A10;
pub const MIKROBUS_1_TX: pin_name_t = GPIO_A9;
// pub const MIKROBUS_1_SCL: pin_name_t = GPIO_F1;
// pub const MIKROBUS_1_SDA: pin_name_t = GPIO_F0;
