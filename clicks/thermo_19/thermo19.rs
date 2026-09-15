use drv_digital_in::{digital_in_init, digital_in_read, digital_in_t};
use drv_name::{pin_name_t, HAL_PIN_NC};
use drv_one_wire::{
    one_wire_match_rom, one_wire_open, one_wire_read_byte, one_wire_read_rom,
    one_wire_rom_address_t, one_wire_search_first_device, one_wire_skip_rom, one_wire_t,
    one_wire_write_byte,
};
use system::init_clock::Delay_ms;

pub const THERMO19_GPIO_0: u8 = 0;
pub const THERMO19_GPIO_1: u8 = 1;

const FAMILY_CODE: u8 = 0x3B;
const ADDRESS_ALL: u8 = 0xFF;
const RESOLUTION_MASK: u8 = 0x60;
const RESOLUTION_8BIT: u8 = 0x00;
const RESOLUTION_9BIT: u8 = 0x20;
const RESOLUTION_10BIT: u8 = 0x40;
const RESOLUTION_12BIT: u8 = 0x60;
const DEFAULT_CONFIG: u8 = RESOLUTION_12BIT | 0x10;

pub struct Thermo19Config {
    pub gp0: pin_name_t,
    pub gp1: pin_name_t,
    pub alt: pin_name_t,
    pub gpio_select: u8,
}

impl Default for Thermo19Config {
    fn default() -> Self {
        Self { gp0: HAL_PIN_NC, gp1: HAL_PIN_NC, alt: HAL_PIN_NC, gpio_select: THERMO19_GPIO_0 }
    }
}

pub struct Thermo19 {
    alt: digital_in_t,
    one_wire: one_wire_t,
    rom_address: one_wire_rom_address_t,
    config: u8,
    address: u8,
}

impl Default for Thermo19 {
    fn default() -> Self {
        Self {
            alt: digital_in_t::default(),
            one_wire: one_wire_t::default(),
            rom_address: one_wire_rom_address_t { address: [0; 8] },
            config: 0,
            address: ADDRESS_ALL,
        }
    }
}

impl Thermo19 {
    pub fn new(config: Thermo19Config) -> Result<Self, ()> {
        let mut this = Self::default();
        this.one_wire.data_pin = if config.gpio_select == THERMO19_GPIO_0 {
            config.gp0
        } else {
            config.gp1
        };
        one_wire_open(&mut this.one_wire).map_err(|_| ())?;
        digital_in_init(&mut this.alt, config.alt).map_err(|_| ())?;
        Ok(this)
    }

    pub fn default_config(&mut self) -> Result<(), ()> {
        self.address = ADDRESS_ALL;
        self.check_communication()?;
        self.write_scratchpad(0xFFFF, 0x0000, DEFAULT_CONFIG)
    }

    pub fn check_communication(&mut self) -> Result<(), ()> {
        one_wire_read_rom(&mut self.one_wire, &mut self.rom_address).map_err(|_| ())?;
        if self.rom_address.address[0] != FAMILY_CODE {
            return Err(());
        }

        let mut searched = one_wire_rom_address_t { address: [0; 8] };
        one_wire_search_first_device(&mut self.one_wire, &mut searched).map_err(|_| ())?;
        if self.rom_address.address != searched.address {
            return Err(());
        }
        Ok(())
    }

    fn select_device(&mut self) -> Result<(), ()> {
        if self.address == ADDRESS_ALL {
            one_wire_skip_rom(&mut self.one_wire).map_err(|_| ())
        } else {
            one_wire_match_rom(&mut self.one_wire, &mut self.rom_address).map_err(|_| ())
        }
    }

    pub fn start_measurement(&mut self) -> Result<(), ()> {
        self.select_device()?;
        one_wire_write_byte(&mut self.one_wire, &[0x44], 1).map_err(|_| ())
    }

    pub fn read_scratchpad(&mut self, scratchpad: &mut [u8; 8]) -> Result<(), ()> {
        self.select_device()?;
        one_wire_write_byte(&mut self.one_wire, &[0xBE], 1).map_err(|_| ())?;
        let mut data = [0u8; 9];
        one_wire_read_byte(&mut self.one_wire, &mut data, 9).map_err(|_| ())?;
        if data[8] != crc8_maxim(&data[..8]) {
            return Err(());
        }
        if self.address != ADDRESS_ALL && (data[2] & 0x0F) != (self.address & 0x0F) {
            return Err(());
        }
        scratchpad.copy_from_slice(&data[..8]);
        Ok(())
    }

    pub fn write_scratchpad(&mut self, high_alarm: u16, low_alarm: u16, config: u8) -> Result<(), ()> {
        self.config = config;
        let data = [
            0x4E,
            config,
            (high_alarm >> 8) as u8,
            high_alarm as u8,
            (low_alarm >> 8) as u8,
            low_alarm as u8,
        ];
        self.select_device()?;
        one_wire_write_byte(&mut self.one_wire, &data, data.len()).map_err(|_| ())
    }

    pub fn read_temperature(&mut self) -> Result<f32, ()> {
        self.start_measurement()?;
        match self.config & RESOLUTION_MASK {
            RESOLUTION_8BIT => Delay_ms(30),
            RESOLUTION_9BIT => Delay_ms(50),
            RESOLUTION_10BIT => Delay_ms(100),
            RESOLUTION_12BIT => Delay_ms(400),
            _ => return Err(()),
        }

        let mut scratchpad = [0u8; 8];
        self.read_scratchpad(&mut scratchpad)?;
        let raw = ((scratchpad[1] as i16) << 8) | scratchpad[0] as i16;
        Ok(raw as f32 * 0.0625)
    }

    pub fn alert_pin(&mut self) -> Result<u8, ()> {
        digital_in_read(&mut self.alt).map_err(|_| ())
    }
}

fn crc8_maxim(data: &[u8]) -> u8 {
    let mut crc = 0u8;
    for &value in data {
        let mut current = value;
        for _ in 0..8 {
            let mix = (crc ^ current) & 0x01;
            crc >>= 1;
            if mix != 0 {
                crc ^= 0x8C;
            }
            current >>= 1;
        }
    }
    crc
}
