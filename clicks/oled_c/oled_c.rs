//! `no_std` driver for the MikroE OLED C Click (SSD1351, 96 x 96).
//!
//! The initialization and signal roles are ported from the supplied mikroSDK
//! C driver. The public API adds RGB565 fills, rectangles, pixels, lines,
//! images, and compact 5 x 7 text without requiring a framebuffer.

use drv_digital_out::{
    digital_out_high, digital_out_init, digital_out_low, digital_out_t,
};
use drv_name::{pin_name_t, HAL_PIN_NC};
use drv_spi_master::{
    spi_master_config_t, spi_master_open, spi_master_set_default_write_data,
    spi_master_set_mode, spi_master_set_speed, spi_master_t, SPI_MASTER_MODE_DEFAULT,
};
use system::init_clock::delay_1ms;

pub const WIDTH: u8 = 96;
pub const HEIGHT: u8 = 96;
const COLUMN_OFFSET: u8 = 0x10;

const CMD_SET_COLUMN_ADDRESS: u8 = 0x15;
const CMD_SET_ROW_ADDRESS: u8 = 0x75;
const CMD_WRITE_RAM: u8 = 0x5C;
const CMD_SET_REMAP: u8 = 0xA0;
const CMD_SET_START_LINE: u8 = 0xA1;
const CMD_SET_OFFSET: u8 = 0xA2;
const CMD_MODE_NORMAL: u8 = 0xA6;
const CMD_SLEEP_ON: u8 = 0xAE;
const CMD_SLEEP_OFF: u8 = 0xAF;
const CMD_SET_RESET_PRECHARGE: u8 = 0xB1;
const CMD_CLOCK_DIVIDER: u8 = 0xB3;
const CMD_VSL: u8 = 0xB4;
const CMD_SECOND_PRECHARGE: u8 = 0xB6;
const CMD_VCOMH: u8 = 0xBE;
const CMD_CONTRAST: u8 = 0xC1;
const CMD_MASTER_CONTRAST: u8 = 0xC7;
const CMD_MUX_RATIO: u8 = 0xCA;
const CMD_COMMAND_LOCK: u8 = 0xFD;

pub const COLOR_BLACK: u16 = 0x0000;
pub const COLOR_WHITE: u16 = 0xFFFF;
pub const COLOR_RED: u16 = 0xF800;
pub const COLOR_LIME: u16 = 0x07E0;
pub const COLOR_BLUE: u16 = 0x001F;
pub const COLOR_CYAN: u16 = 0x07FF;
pub const COLOR_MAGENTA: u16 = 0xF81F;
pub const COLOR_YELLOW: u16 = 0xFFE0;

pub struct Config {
    pub sck: pin_name_t,
    pub miso: pin_name_t,
    pub mosi: pin_name_t,
    pub cs: pin_name_t,
    pub rw: pin_name_t,
    pub rst: pin_name_t,
    pub dc: pin_name_t,
    pub enable: pin_name_t,
    pub spi_speed: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            sck: HAL_PIN_NC,
            miso: HAL_PIN_NC,
            mosi: HAL_PIN_NC,
            cs: HAL_PIN_NC,
            rw: HAL_PIN_NC,
            rst: HAL_PIN_NC,
            dc: HAL_PIN_NC,
            enable: HAL_PIN_NC,
            spi_speed: 100_000,
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
pub enum Error {
    Spi,
    Pin,
    OutOfBounds,
    InvalidImage,
}

pub type Result<T> = core::result::Result<T, Error>;

pub struct OledC {
    spi: spi_master_t,
    cs: digital_out_t,
    _rw: digital_out_t,
    rst: digital_out_t,
    dc: digital_out_t,
    enable: digital_out_t,
}

impl OledC {
    pub fn new(config: Config) -> Result<Self> {
        let mut spi = spi_master_t::default();
        let mut spi_config = spi_master_config_t::default();
        spi_config.sck = config.sck;
        spi_config.miso = config.miso;
        spi_config.mosi = config.mosi;
        spi_master_open(&mut spi, spi_config).map_err(|_| Error::Spi)?;
        spi_master_set_default_write_data(&mut spi, 0).map_err(|_| Error::Spi)?;
        spi_master_set_mode(&mut spi, SPI_MASTER_MODE_DEFAULT).map_err(|_| Error::Spi)?;
        spi_master_set_speed(&mut spi, config.spi_speed).map_err(|_| Error::Spi)?;

        let mut cs = digital_out_t::default();
        let mut rw = digital_out_t::default();
        let mut rst = digital_out_t::default();
        let mut dc = digital_out_t::default();
        let mut enable = digital_out_t::default();
        digital_out_init(&mut cs, config.cs).map_err(|_| Error::Pin)?;
        digital_out_init(&mut rw, config.rw).map_err(|_| Error::Pin)?;
        digital_out_init(&mut rst, config.rst).map_err(|_| Error::Pin)?;
        digital_out_init(&mut dc, config.dc).map_err(|_| Error::Pin)?;
        digital_out_init(&mut enable, config.enable).map_err(|_| Error::Pin)?;

        digital_out_high(&mut cs).map_err(|_| Error::Pin)?;
        digital_out_low(&mut rw).map_err(|_| Error::Pin)?;
        digital_out_high(&mut dc).map_err(|_| Error::Pin)?;
        digital_out_low(&mut enable).map_err(|_| Error::Pin)?;

        Ok(Self {
            spi,
            cs,
            _rw: rw,
            rst,
            dc,
            enable,
        })
    }

    pub fn default_config(&mut self) -> Result<()> {
        self.set_enabled(true)?;
        self.reset()?;

        self.command_with_data(CMD_COMMAND_LOCK, &mut [0x12])?;
        self.command_with_data(CMD_COMMAND_LOCK, &mut [0xB1])?;
        self.command(CMD_SLEEP_ON)?;
        self.command_with_data(CMD_SET_REMAP, &mut [0x32])?;
        self.command_with_data(CMD_MUX_RATIO, &mut [95])?;
        self.command_with_data(CMD_SET_START_LINE, &mut [0x80])?;
        self.command_with_data(CMD_SET_OFFSET, &mut [0x20])?;
        self.command_with_data(CMD_VCOMH, &mut [0x05])?;
        self.command_with_data(CMD_CLOCK_DIVIDER, &mut [0xF1])?;
        self.command_with_data(CMD_SET_RESET_PRECHARGE, &mut [0x32])?;
        self.command_with_data(CMD_SECOND_PRECHARGE, &mut [0x01])?;
        self.command_with_data(CMD_MASTER_CONTRAST, &mut [0xCF])?;
        self.command_with_data(CMD_CONTRAST, &mut [0x8A, 0x51, 0x8A])?;
        self.command_with_data(CMD_VSL, &mut [0xA0, 0xB5, 0x55])?;
        self.command(CMD_MODE_NORMAL)?;
        self.command(CMD_SLEEP_OFF)?;
        self.fill_screen(COLOR_BLACK)
    }

    pub fn set_enabled(&mut self, enabled: bool) -> Result<()> {
        if enabled {
            digital_out_high(&mut self.enable).map_err(|_| Error::Pin)
        } else {
            digital_out_low(&mut self.enable).map_err(|_| Error::Pin)
        }
    }

    pub fn fill_screen(&mut self, color: u16) -> Result<()> {
        self.fill_rectangle(0, 0, WIDTH, HEIGHT, color)
    }

    /// Fill an exclusive-end rectangle: `[x0, x1) x [y0, y1)`.
    pub fn fill_rectangle(
        &mut self,
        x0: u8,
        y0: u8,
        x1: u8,
        y1: u8,
        color: u16,
    ) -> Result<()> {
        self.set_window(x0, y0, x1, y1)?;
        let pixels = u32::from(x1 - x0) * u32::from(y1 - y0);
        self.write_solid_pixels(color, pixels)
    }

    pub fn draw_pixel(&mut self, x: u8, y: u8, color: u16) -> Result<()> {
        let x1 = x.checked_add(1).ok_or(Error::OutOfBounds)?;
        let y1 = y.checked_add(1).ok_or(Error::OutOfBounds)?;
        self.fill_rectangle(x, y, x1, y1, color)
    }

    pub fn draw_line(&mut self, x0: u8, y0: u8, x1: u8, y1: u8, color: u16) -> Result<()> {
        if x0 >= WIDTH || x1 >= WIDTH || y0 >= HEIGHT || y1 >= HEIGHT {
            return Err(Error::OutOfBounds);
        }

        let mut x = i16::from(x0);
        let mut y = i16::from(y0);
        let target_x = i16::from(x1);
        let target_y = i16::from(y1);
        let dx = (target_x - x).abs();
        let step_x = if x < target_x { 1 } else { -1 };
        let dy = -(target_y - y).abs();
        let step_y = if y < target_y { 1 } else { -1 };
        let mut error = dx + dy;

        loop {
            self.draw_pixel(x as u8, y as u8, color)?;
            if x == target_x && y == target_y {
                break;
            }
            let twice = error * 2;
            if twice >= dy {
                error += dy;
                x += step_x;
            }
            if twice <= dx {
                error += dx;
                y += step_y;
            }
        }
        Ok(())
    }

    pub fn draw_text(&mut self, text: &str, mut x: u8, mut y: u8, color: u16) -> Result<()> {
        let line_start = x;
        for byte in text.bytes() {
            if byte == b'\n' {
                x = line_start;
                y = y.checked_add(8).ok_or(Error::OutOfBounds)?;
                continue;
            }
            if x > WIDTH - 5 || y > HEIGHT - 7 {
                return Err(Error::OutOfBounds);
            }
            self.draw_character(byte, x, y, color)?;
            x = x.checked_add(6).ok_or(Error::OutOfBounds)?;
        }
        Ok(())
    }

    pub fn draw_rgb565_image(
        &mut self,
        x: u8,
        y: u8,
        width: u8,
        height: u8,
        pixels: &[u16],
    ) -> Result<()> {
        let x1 = x.checked_add(width).ok_or(Error::OutOfBounds)?;
        let y1 = y.checked_add(height).ok_or(Error::OutOfBounds)?;
        let expected = usize::from(width) * usize::from(height);
        if pixels.len() != expected {
            return Err(Error::InvalidImage);
        }
        self.set_window(x, y, x1, y1)?;

        self.begin_memory_write()?;
        let mut buffer = [0u8; 128];
        for chunk in pixels.chunks(64) {
            for (index, pixel) in chunk.iter().enumerate() {
                buffer[index * 2] = (*pixel >> 8) as u8;
                buffer[index * 2 + 1] = *pixel as u8;
            }
            let byte_count = chunk.len() * 2;
            drv_spi_master::spi_master_write(&mut self.spi, &mut buffer[..byte_count], byte_count)
                .map_err(|_| Error::Spi)?;
        }
        digital_out_high(&mut self.cs).map_err(|_| Error::Pin)
    }

    fn reset(&mut self) -> Result<()> {
        digital_out_high(&mut self.rst).map_err(|_| Error::Pin)?;
        delay_ms(1);
        digital_out_low(&mut self.rst).map_err(|_| Error::Pin)?;
        delay_ms(1);
        digital_out_high(&mut self.rst).map_err(|_| Error::Pin)?;
        delay_ms(100);
        Ok(())
    }

    fn set_window(&mut self, x0: u8, y0: u8, x1: u8, y1: u8) -> Result<()> {
        if x0 >= x1 || y0 >= y1 || x1 > WIDTH || y1 > HEIGHT {
            return Err(Error::OutOfBounds);
        }
        self.command_with_data(
            CMD_SET_COLUMN_ADDRESS,
            &mut [COLUMN_OFFSET + x0, COLUMN_OFFSET + x1 - 1],
        )?;
        self.command_with_data(CMD_SET_ROW_ADDRESS, &mut [y0, y1 - 1])
    }

    fn command(&mut self, command: u8) -> Result<()> {
        self.command_with_data(command, &mut [])
    }

    fn command_with_data(&mut self, command: u8, data: &mut [u8]) -> Result<()> {
        let mut command_buffer = [command];
        digital_out_low(&mut self.cs).map_err(|_| Error::Pin)?;
        digital_out_low(&mut self.dc).map_err(|_| Error::Pin)?;
        drv_spi_master::spi_master_write(&mut self.spi, &mut command_buffer, 1)
            .map_err(|_| Error::Spi)?;
        if !data.is_empty() {
            digital_out_high(&mut self.dc).map_err(|_| Error::Pin)?;
            let data_len = data.len();
            drv_spi_master::spi_master_write(&mut self.spi, data, data_len)
                .map_err(|_| Error::Spi)?;
        }
        digital_out_high(&mut self.cs).map_err(|_| Error::Pin)
    }

    fn begin_memory_write(&mut self) -> Result<()> {
        let mut command = [CMD_WRITE_RAM];
        digital_out_low(&mut self.cs).map_err(|_| Error::Pin)?;
        digital_out_low(&mut self.dc).map_err(|_| Error::Pin)?;
        drv_spi_master::spi_master_write(&mut self.spi, &mut command, 1)
            .map_err(|_| Error::Spi)?;
        digital_out_high(&mut self.dc).map_err(|_| Error::Pin)
    }

    fn write_solid_pixels(&mut self, color: u16, mut count: u32) -> Result<()> {
        let mut buffer = [0u8; 128];
        for pair in buffer.chunks_exact_mut(2) {
            pair[0] = (color >> 8) as u8;
            pair[1] = color as u8;
        }

        self.begin_memory_write()?;
        while count > 0 {
            let pixels = if count > 64 { 64 } else { count as usize };
            let byte_count = pixels * 2;
            drv_spi_master::spi_master_write(&mut self.spi, &mut buffer[..byte_count], byte_count)
                .map_err(|_| Error::Spi)?;
            count -= pixels as u32;
        }
        digital_out_high(&mut self.cs).map_err(|_| Error::Pin)
    }

    fn draw_character(&mut self, character: u8, x: u8, y: u8, color: u16) -> Result<()> {
        let glyph = glyph_5x7(character);
        for (column, bits) in glyph.iter().enumerate() {
            for row in 0..7u8 {
                if *bits & (1u8 << row) != 0 {
                    self.draw_pixel(x + column as u8, y + row, color)?;
                }
            }
        }
        Ok(())
    }
}

fn delay_ms(milliseconds: u16) {
    for _ in 0..milliseconds {
        delay_1ms();
    }
}

fn glyph_5x7(character: u8) -> [u8; 5] {
    let uppercase = if character.is_ascii_lowercase() {
        character - b'a' + b'A'
    } else {
        character
    };
    match uppercase {
        b' ' => [0x00, 0x00, 0x00, 0x00, 0x00],
        b'!' => [0x00, 0x00, 0x5F, 0x00, 0x00],
        b'-' => [0x08, 0x08, 0x08, 0x08, 0x08],
        b'.' => [0x00, 0x60, 0x60, 0x00, 0x00],
        b'/' => [0x20, 0x10, 0x08, 0x04, 0x02],
        b'0' => [0x3E, 0x51, 0x49, 0x45, 0x3E],
        b'1' => [0x00, 0x42, 0x7F, 0x40, 0x00],
        b'2' => [0x42, 0x61, 0x51, 0x49, 0x46],
        b'3' => [0x21, 0x41, 0x45, 0x4B, 0x31],
        b'4' => [0x18, 0x14, 0x12, 0x7F, 0x10],
        b'5' => [0x27, 0x45, 0x45, 0x45, 0x39],
        b'6' => [0x3C, 0x4A, 0x49, 0x49, 0x30],
        b'7' => [0x01, 0x71, 0x09, 0x05, 0x03],
        b'8' => [0x36, 0x49, 0x49, 0x49, 0x36],
        b'9' => [0x06, 0x49, 0x49, 0x29, 0x1E],
        b':' => [0x00, 0x36, 0x36, 0x00, 0x00],
        b'A' => [0x7E, 0x11, 0x11, 0x11, 0x7E],
        b'B' => [0x7F, 0x49, 0x49, 0x49, 0x36],
        b'C' => [0x3E, 0x41, 0x41, 0x41, 0x22],
        b'D' => [0x7F, 0x41, 0x41, 0x22, 0x1C],
        b'E' => [0x7F, 0x49, 0x49, 0x49, 0x41],
        b'F' => [0x7F, 0x09, 0x09, 0x09, 0x01],
        b'G' => [0x3E, 0x41, 0x49, 0x49, 0x7A],
        b'H' => [0x7F, 0x08, 0x08, 0x08, 0x7F],
        b'I' => [0x00, 0x41, 0x7F, 0x41, 0x00],
        b'J' => [0x20, 0x40, 0x41, 0x3F, 0x01],
        b'K' => [0x7F, 0x08, 0x14, 0x22, 0x41],
        b'L' => [0x7F, 0x40, 0x40, 0x40, 0x40],
        b'M' => [0x7F, 0x02, 0x0C, 0x02, 0x7F],
        b'N' => [0x7F, 0x04, 0x08, 0x10, 0x7F],
        b'O' => [0x3E, 0x41, 0x41, 0x41, 0x3E],
        b'P' => [0x7F, 0x09, 0x09, 0x09, 0x06],
        b'Q' => [0x3E, 0x41, 0x51, 0x21, 0x5E],
        b'R' => [0x7F, 0x09, 0x19, 0x29, 0x46],
        b'S' => [0x46, 0x49, 0x49, 0x49, 0x31],
        b'T' => [0x01, 0x01, 0x7F, 0x01, 0x01],
        b'U' => [0x3F, 0x40, 0x40, 0x40, 0x3F],
        b'V' => [0x1F, 0x20, 0x40, 0x20, 0x1F],
        b'W' => [0x3F, 0x40, 0x38, 0x40, 0x3F],
        b'X' => [0x63, 0x14, 0x08, 0x14, 0x63],
        b'Y' => [0x07, 0x08, 0x70, 0x08, 0x07],
        b'Z' => [0x61, 0x51, 0x49, 0x45, 0x43],
        _ => [0x02, 0x01, 0x51, 0x09, 0x06],
    }
}
