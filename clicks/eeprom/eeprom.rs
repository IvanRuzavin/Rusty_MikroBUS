use drv_digital_out::{digital_out_high, digital_out_init, digital_out_low, digital_out_t};
use drv_i2c_master::{
    i2c_master_config_t, i2c_master_open, i2c_master_read, i2c_master_set_slave_address,
    i2c_master_set_speed, i2c_master_speed_t, i2c_master_t, i2c_master_write,
    i2c_master_write_then_read,
};
use drv_name::{pin_name_t, HAL_PIN_NC};
use system::init_clock::Delay_ms;

pub const EEPROM_BLOCK_ADDR_START: u8 = 0x00;
pub const EEPROM_BLOCK_ADDR_MIDDLE: u8 = 0x80;
pub const EEPROM_BLOCK_ADDR_END: u8 = 0xFF;

pub const EEPROM_NBYTES_MIN: usize = 1;
pub const EEPROM_NBYTES_PAGE: usize = 16;
pub const EEPROM_NBYTES_MAX: usize = 256;

const EEPROM_DEFAULT_SLAVE_ADDR: u8 = 0x50;

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum EepromAddressSelector {
    Sel0 = 0,
    Sel1 = 1,
    Sel2 = 2,
    Sel3 = 3,
    Sel4 = 4,
    Sel5 = 5,
    Sel6 = 6,
    Sel7 = 7,
}

impl Default for EepromAddressSelector {
    fn default() -> Self {
        Self::Sel0
    }
}

pub struct EepromConfig {
    pub wp: pin_name_t,
    pub scl: pin_name_t,
    pub sda: pin_name_t,
    pub address_selector: EepromAddressSelector,
    pub i2c_speed: i2c_master_speed_t,
}

impl Default for EepromConfig {
    fn default() -> Self {
        Self {
            wp: HAL_PIN_NC,
            scl: HAL_PIN_NC,
            sda: HAL_PIN_NC,
            address_selector: EepromAddressSelector::Sel0,
            i2c_speed: i2c_master_speed_t::I2C_MASTER_SPEED_100K,
        }
    }
}

pub struct Eeprom {
    wp: digital_out_t,
    i2c: i2c_master_t,
    slave_address: u8,
}

impl Eeprom {
    pub fn new(config: EepromConfig) -> Result<Self, ()> {
        let mut i2c = i2c_master_t::default();
        let mut i2c_config = i2c_master_config_t::default();
        i2c_config.scl = config.scl;
        i2c_config.sda = config.sda;

        i2c_master_open(&mut i2c, i2c_config).map_err(|_| ())?;

        let slave_address = EEPROM_DEFAULT_SLAVE_ADDR | config.address_selector as u8;
        i2c_master_set_slave_address(&mut i2c, slave_address).map_err(|_| ())?;
        i2c_master_set_speed(&mut i2c, config.i2c_speed).map_err(|_| ())?;

        let mut wp = digital_out_t::default();
        digital_out_init(&mut wp, config.wp).map_err(|_| ())?;
        digital_out_low(&mut wp).map_err(|_| ())?;

        Ok(Self {
            wp,
            i2c,
            slave_address,
        })
    }

    pub fn slave_address(&self) -> u8 {
        self.slave_address
    }

    pub fn write_byte(&mut self, register_address: u8, value: u8) -> Result<(), ()> {
        let mut buffer = [register_address, value];
        let len = buffer.len();
        i2c_master_write(&mut self.i2c, &mut buffer, len).map_err(|_| ())
    }

    pub fn write_page(
        &mut self,
        register_address: u8,
        data: &[u8; EEPROM_NBYTES_PAGE],
    ) -> Result<(), ()> {
        let mut buffer = [0u8; EEPROM_NBYTES_PAGE + 1];
        buffer[0] = register_address;
        buffer[1..].copy_from_slice(data);

        let len = buffer.len();
        i2c_master_write(&mut self.i2c, &mut buffer, len).map_err(|_| ())?;

        // Match the supplied C driver: wait for the EEPROM internal page-write
        // cycle before allowing a subsequent operation.
        Delay_ms(1_000);
        Ok(())
    }

    pub fn read_byte(&mut self, register_address: u8) -> Result<u8, ()> {
        let mut address = [register_address];
        let mut value = [0u8];

        i2c_master_write(&mut self.i2c, &mut address, 1).map_err(|_| ())?;
        i2c_master_read(&mut self.i2c, &mut value, 1).map_err(|_| ())?;
        Ok(value[0])
    }

    pub fn read_sequential(
        &mut self,
        register_address: u8,
        data_out: &mut [u8],
    ) -> Result<(), ()> {
        if data_out.len() < EEPROM_NBYTES_MIN || data_out.len() > EEPROM_NBYTES_MAX {
            return Err(());
        }

        let mut address = [register_address];
        let read_len = data_out.len();
        i2c_master_write_then_read(&mut self.i2c, &mut address, 1, data_out, read_len)
            .map_err(|_| ())
    }

    pub fn write_enable(&mut self) -> Result<(), ()> {
        digital_out_low(&mut self.wp).map_err(|_| ())
    }

    pub fn write_protect(&mut self) -> Result<(), ()> {
        digital_out_high(&mut self.wp).map_err(|_| ())
    }
}
