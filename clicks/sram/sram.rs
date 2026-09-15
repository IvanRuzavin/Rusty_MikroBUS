use drv_digital_out::{digital_out_high, digital_out_init, digital_out_low, digital_out_t};
use drv_name::{pin_name_t, HAL_PIN_NC};
use drv_spi_master::{
    spi_master_chip_select_polarity_t, spi_master_config_t, spi_master_deselect_device,
    spi_master_open, spi_master_read, spi_master_select_device, spi_master_set_chip_select_polarity,
    spi_master_set_default_write_data, spi_master_set_mode, spi_master_set_speed, spi_master_t,
    spi_master_write, SPI_MASTER_MODE_DEFAULT,
};
use system::init_clock::delay_22us;

const SRAM_ADDRESS_MASK: u32 = 0x00FF_FFFF;
const CMD_WRMR: u8 = 0x01;
const CMD_WRITE: u8 = 0x02;
const CMD_READ: u8 = 0x03;
const CMD_RDMR: u8 = 0x05;
const CMD_RESET_IO: u8 = 0xFF;

pub struct SramConfig {
    pub miso: pin_name_t,
    pub mosi: pin_name_t,
    pub sck: pin_name_t,
    pub cs: pin_name_t,
    pub hold: pin_name_t,
    pub spi_speed: u32,
}

impl Default for SramConfig {
    fn default() -> Self {
        Self {
            miso: HAL_PIN_NC,
            mosi: HAL_PIN_NC,
            sck: HAL_PIN_NC,
            cs: HAL_PIN_NC,
            hold: HAL_PIN_NC,
            spi_speed: 100_000,
        }
    }
}

pub struct Sram {
    spi: spi_master_t,
    _cs: digital_out_t,
    hold: digital_out_t,
    chip_select: pin_name_t,
}

impl Sram {
    pub fn new(config: SramConfig) -> Result<Self, ()> {
        let mut spi = spi_master_t::default();
        let mut spi_config = spi_master_config_t::default();
        spi_config.sck = config.sck;
        spi_config.miso = config.miso;
        spi_config.mosi = config.mosi;

        let mut cs = digital_out_t::default();
        let mut hold = digital_out_t::default();
        digital_out_init(&mut cs, config.cs).map_err(|_| ())?;
        digital_out_init(&mut hold, config.hold).map_err(|_| ())?;

        spi_master_open(&mut spi, spi_config).map_err(|_| ())?;
        spi_master_set_default_write_data(&mut spi, 0).map_err(|_| ())?;
        spi_master_set_speed(&mut spi, config.spi_speed).map_err(|_| ())?;
        spi_master_set_mode(&mut spi, SPI_MASTER_MODE_DEFAULT).map_err(|_| ())?;
        spi_master_set_chip_select_polarity(
            spi_master_chip_select_polarity_t::SPI_MASTER_CHIP_SELECT_POLARITY_ACTIVE_LOW,
        );
        spi_master_deselect_device(config.cs);
        digital_out_high(&mut hold).map_err(|_| ())?;

        Ok(Self { spi, _cs: cs, hold, chip_select: config.cs })
    }

    fn write(&mut self, buffer: &mut [u8]) -> Result<(), ()> {
        spi_master_select_device(self.chip_select);
        let len = buffer.len();
        let result = spi_master_write(&mut self.spi, buffer, len).map_err(|_| ());
        spi_master_deselect_device(self.chip_select);
        result
    }

    fn transfer(&mut self, write_buffer: &mut [u8], read_buffer: &mut [u8]) -> Result<(), ()> {
        spi_master_select_device(self.chip_select);
        let write_len = write_buffer.len();
        if spi_master_write(&mut self.spi, write_buffer, write_len).is_err() {
            spi_master_deselect_device(self.chip_select);
            return Err(());
        }
        let read_len = read_buffer.len();
        let result = spi_master_read(&mut self.spi, read_buffer, read_len).map_err(|_| ());
        spi_master_deselect_device(self.chip_select);
        result
    }

    pub fn write_byte(&mut self, address: u32, value: u8) -> Result<(), ()> {
        let address = address & SRAM_ADDRESS_MASK;
        let mut buffer = [
            CMD_WRITE,
            (address >> 16) as u8,
            (address >> 8) as u8,
            address as u8,
            value,
        ];
        self.write(&mut buffer)
    }

    pub fn read_byte(&mut self, address: u32) -> Result<u8, ()> {
        let address = address & SRAM_ADDRESS_MASK;
        let mut command = [
            CMD_READ,
            (address >> 16) as u8,
            (address >> 8) as u8,
            address as u8,
        ];
        let mut value = [0u8];
        self.transfer(&mut command, &mut value)?;
        Ok(value[0])
    }

    pub fn write_mode_register(&mut self, value: u8) -> Result<(), ()> {
        self.write(&mut [CMD_WRMR, value])
    }

    pub fn read_mode_register(&mut self) -> Result<u8, ()> {
        let mut command = [CMD_RDMR];
        let mut value = [0u8];
        self.transfer(&mut command, &mut value)?;
        Ok(value[0])
    }

    pub fn soft_reset(&mut self) -> Result<(), ()> {
        self.write(&mut [CMD_RESET_IO])
    }

    pub fn hold_transmission(&mut self) {
        let _ = digital_out_high(&mut self.hold);
        delay_22us();
        let _ = digital_out_low(&mut self.hold);
        delay_22us();
    }
}
