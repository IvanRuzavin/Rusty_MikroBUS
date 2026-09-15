pub mod resources;

use drv_digital_out::{digital_out_high, digital_out_init, digital_out_low, digital_out_t};
use drv_name::{pin_name_t, HAL_PIN_NC};
use drv_spi_master::{
    spi_master_config_t, spi_master_open, spi_master_set_default_write_data,
    spi_master_set_mode, spi_master_set_speed, spi_master_t, spi_master_write,
    SPI_MASTER_MODE_DEFAULT,
};
use system::init_clock::Delay_ms;

pub const COLOR_BLACK: u16 = 0x0000;
pub const COLOR_RED: u16 = 0xF800;
pub const COLOR_LIME: u16 = 0x07E0;
pub const COLOR_BLUE: u16 = 0x001F;
pub const COLOR_CYAN: u16 = 0x07FF;
pub const COLOR_MAGENTA: u16 = 0xF81F;
pub const ROTATION_VERTICAL_0: u8 = 0;

const WIDTH: u16 = 240;
const HEIGHT: u16 = 240;

#[derive(Clone, Copy)]
pub struct Point {
    pub x: u16,
    pub y: u16,
}

pub struct IpsDisplay2Config {
    pub miso: pin_name_t,
    pub mosi: pin_name_t,
    pub sck: pin_name_t,
    pub cs: pin_name_t,
    pub rst: pin_name_t,
    pub dc: pin_name_t,
    pub backlight: pin_name_t,
    pub spi_speed: u32,
}

impl Default for IpsDisplay2Config {
    fn default() -> Self {
        Self {
            miso: HAL_PIN_NC,
            mosi: HAL_PIN_NC,
            sck: HAL_PIN_NC,
            cs: HAL_PIN_NC,
            rst: HAL_PIN_NC,
            dc: HAL_PIN_NC,
            backlight: HAL_PIN_NC,
            spi_speed: 5_000_000,
        }
    }
}

pub struct IpsDisplay2 {
    rst: digital_out_t,
    dc: digital_out_t,
    cs: digital_out_t,
    backlight: digital_out_t,
    spi: spi_master_t,
    rotation: u8,
}

impl IpsDisplay2 {
    pub fn new(config: IpsDisplay2Config) -> Result<Self, ()> {
        let mut spi = spi_master_t::default();
        let mut spi_config = spi_master_config_t::default();
        spi_config.sck = config.sck;
        spi_config.miso = config.miso;
        spi_config.mosi = config.mosi;
        spi_master_open(&mut spi, spi_config).map_err(|_| ())?;
        spi_master_set_default_write_data(&mut spi, 0).map_err(|_| ())?;
        spi_master_set_mode(&mut spi, SPI_MASTER_MODE_DEFAULT).map_err(|_| ())?;
        spi_master_set_speed(&mut spi, config.spi_speed).map_err(|_| ())?;

        let mut cs = digital_out_t::default();
        let mut rst = digital_out_t::default();
        let mut dc = digital_out_t::default();
        let mut backlight = digital_out_t::default();
        digital_out_init(&mut cs, config.cs).map_err(|_| ())?;
        digital_out_init(&mut rst, config.rst).map_err(|_| ())?;
        digital_out_init(&mut dc, config.dc).map_err(|_| ())?;
        digital_out_init(&mut backlight, config.backlight).map_err(|_| ())?;
        digital_out_high(&mut cs).map_err(|_| ())?;

        Ok(Self { rst, dc, cs, backlight, spi, rotation: 0 })
    }

    fn spi_write(&mut self, data: &mut [u8]) -> Result<(), ()> {
        let len = data.len();
        spi_master_write(&mut self.spi, data, len).map_err(|_| ())
    }

    fn command(&mut self, command: u8) -> Result<(), ()> {
        let mut byte = [command];
        digital_out_low(&mut self.cs).map_err(|_| ())?;
        digital_out_low(&mut self.dc).map_err(|_| ())?;
        let result = self.spi_write(&mut byte);
        let _ = digital_out_high(&mut self.cs);
        result
    }

    fn command_with_data(&mut self, command: u8, data: &[u8]) -> Result<(), ()> {
        self.command(command)?;
        if data.is_empty() {
            return Ok(());
        }
        digital_out_low(&mut self.cs).map_err(|_| ())?;
        digital_out_high(&mut self.dc).map_err(|_| ())?;
        let mut offset = 0usize;
        while offset < data.len() {
            let count = core::cmp::min(64, data.len() - offset);
            let mut buffer = [0u8; 64];
            buffer[..count].copy_from_slice(&data[offset..offset + count]);
            self.spi_write(&mut buffer[..count])?;
            offset += count;
        }
        digital_out_high(&mut self.cs).map_err(|_| ())
    }

    pub fn set_rotation(&mut self, rotation: u8) -> Result<(), ()> {
        self.rotation = rotation;
        let value = match rotation {
            1 => 0xC0,
            2 => 0x60,
            3 => 0xA0,
            _ => { self.rotation = 0; 0x00 }
        };
        self.command_with_data(0x36, &[value])
    }

    fn set_position(&mut self, start: Point, end: Point) -> Result<(), ()> {
        if start.x > end.x || start.y > end.y || end.x >= WIDTH || end.y >= HEIGHT {
            return Err(());
        }
        let y_offset = if self.rotation == 1 { 80 } else { 0 };
        self.command_with_data(0x2A, &[
            (start.x >> 8) as u8, start.x as u8, (end.x >> 8) as u8, end.x as u8,
        ])?;
        let sy = start.y + y_offset;
        let ey = end.y + y_offset;
        self.command_with_data(0x2B, &[
            (sy >> 8) as u8, sy as u8, (ey >> 8) as u8, ey as u8,
        ])?;
        self.command(0x2C)
    }

    fn stream_solid_color(&mut self, color: u16, mut pixels: u32) -> Result<(), ()> {
        let mut buffer = [0u8; 128];
        for pair in buffer.chunks_exact_mut(2) {
            pair[0] = (color >> 8) as u8;
            pair[1] = color as u8;
        }
        digital_out_low(&mut self.cs).map_err(|_| ())?;
        digital_out_high(&mut self.dc).map_err(|_| ())?;
        while pixels > 0 {
            let count = core::cmp::min(64, pixels as usize);
            let bytes = count * 2;
            self.spi_write(&mut buffer[..bytes])?;
            pixels -= count as u32;
        }
        digital_out_high(&mut self.cs).map_err(|_| ())
    }

    pub fn fill_screen(&mut self, color: u16) -> Result<(), ()> {
        self.set_position(Point { x: 0, y: 0 }, Point { x: 239, y: 239 })?;
        self.stream_solid_color(color, 57_600)
    }

    pub fn draw_pixel(&mut self, point: Point, color: u16) -> Result<(), ()> {
        self.set_position(point, point)?;
        self.stream_solid_color(color, 1)
    }

    pub fn draw_line(&mut self, start: Point, end: Point, color: u16) -> Result<(), ()> {
        let (mut x0, mut y0) = (start.x as i32, start.y as i32);
        let (x1, y1) = (end.x as i32, end.y as i32);
        let dx = (x1 - x0).abs();
        let sx = if x0 < x1 { 1 } else { -1 };
        let dy = -(y1 - y0).abs();
        let sy = if y0 < y1 { 1 } else { -1 };
        let mut error = dx + dy;
        loop {
            self.draw_pixel(Point { x: x0 as u16, y: y0 as u16 }, color)?;
            if x0 == x1 && y0 == y1 { break; }
            let twice = 2 * error;
            if twice >= dy { error += dy; x0 += sx; }
            if twice <= dx { error += dx; y0 += sy; }
        }
        Ok(())
    }

    pub fn draw_rectangle(&mut self, start: Point, end: Point, color: u16) -> Result<(), ()> {
        self.draw_line(start, Point { x: end.x, y: start.y }, color)?;
        self.draw_line(start, Point { x: start.x, y: end.y }, color)?;
        self.draw_line(Point { x: start.x, y: end.y }, end, color)?;
        self.draw_line(Point { x: end.x, y: start.y }, end, color)
    }

    pub fn draw_circle(&mut self, center: Point, radius: u8, color: u16) -> Result<(), ()> {
        let (mut x, mut y) = (0i32, radius as i32);
        while x <= y {
            for (dx, dy) in [
                (x,y),(-x,y),(x,-y),(-x,-y),(y,x),(-y,x),(y,-x),(-y,-x)
            ] {
                let px = center.x as i32 + dx;
                let py = center.y as i32 + dy;
                if px >= 0 && py >= 0 && px < WIDTH as i32 && py < HEIGHT as i32 {
                    self.draw_pixel(Point { x: px as u16, y: py as u16 }, color)?;
                }
            }
            x += 1;
            if x * x + y * y > (radius as i32) * (radius as i32) { y -= 1; }
        }
        Ok(())
    }

    pub fn write_char(&mut self, point: Point, character: u8, color: u16) -> Result<(), ()> {
        if !(32..=126).contains(&character) { return Ok(()); }
        let font = &resources::IPSDISPLAY2_FONT_12X24;
        let mut position = (character as usize - 32) * 24 * 2;
        for y in 0..24usize {
            for x in 0..12usize {
                if font[position + x / 8] & (0x80 >> (x % 8)) != 0 {
                    self.draw_pixel(Point { x: point.x + x as u16, y: point.y + y as u16 }, color)?;
                }
            }
            position += 2;
        }
        Ok(())
    }

    pub fn write_string(&mut self, mut point: Point, text: &str, color: u16) -> Result<(), ()> {
        for character in text.bytes() {
            if point.x > 227 { point.x = 0; point.y += 24; }
            if point.y > 215 { point.y = 0; }
            self.write_char(point, character, color)?;
            point.x += 13;
        }
        Ok(())
    }

    pub fn draw_picture(&mut self, image: &[u16; 57_600]) -> Result<(), ()> {
        self.set_rotation(ROTATION_VERTICAL_0)?;
        self.set_position(Point { x: 0, y: 0 }, Point { x: 239, y: 239 })?;
        digital_out_low(&mut self.cs).map_err(|_| ())?;
        digital_out_high(&mut self.dc).map_err(|_| ())?;
        let mut offset = 0usize;
        let mut buffer = [0u8; 128];
        while offset < image.len() {
            let count = core::cmp::min(64, image.len() - offset);
            for (index, pixel) in image[offset..offset + count].iter().enumerate() {
                buffer[index * 2] = (pixel >> 8) as u8;
                buffer[index * 2 + 1] = *pixel as u8;
            }
            self.spi_write(&mut buffer[..count * 2])?;
            offset += count;
        }
        digital_out_high(&mut self.cs).map_err(|_| ())
    }

    pub fn default_config(&mut self) -> Result<(), ()> {
        let _ = digital_out_high(&mut self.dc);
        digital_out_low(&mut self.rst).map_err(|_| ())?;
        Delay_ms(1);
        digital_out_high(&mut self.rst).map_err(|_| ())?;
        Delay_ms(200);
        self.command(0x11)?;
        Delay_ms(120);
        self.set_rotation(0)?;
        self.command_with_data(0x3A, &[0x05])?;
        self.command_with_data(0xB2, &[0x0C,0x0C,0x00,0x33,0x33])?;
        self.command_with_data(0xB7, &[0x35])?;
        self.command_with_data(0xBB, &[0x3A])?;
        self.command_with_data(0xC2, &[0x01])?;
        self.command_with_data(0xC3, &[0x19])?;
        self.command_with_data(0xC4, &[0x20])?;
        self.command_with_data(0xC6, &[0x0F])?;
        self.command_with_data(0xD0, &[0xA4,0xB1])?;
        self.command_with_data(0xE0, &[0xD0,0x08,0x0E,0x09,0x09,0x05,0x31,0x33,0x48,0x17,0x14,0x15,0x31,0x34])?;
        self.command_with_data(0xE1, &[0xD0,0x08,0x0E,0x09,0x09,0x15,0x31,0x33,0x48,0x17,0x14,0x15,0x31,0x34])?;
        self.command(0x21)?;
        self.fill_screen(COLOR_BLACK)?;
        self.command(0x29)?;
        digital_out_high(&mut self.backlight).map_err(|_| ())?;
        Delay_ms(100);
        Ok(())
    }
}
