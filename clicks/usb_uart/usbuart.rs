use drv_digital_in::{digital_in_init, digital_in_read, digital_in_t};
use drv_digital_out::{digital_out_high, digital_out_init, digital_out_low, digital_out_t};
use drv_name::{pin_name_t, HAL_PIN_NC};
use drv_uart::{
    uart_config_t, uart_open, uart_read, uart_set_baud, uart_set_blocking, uart_t, uart_write,
};

pub const USBUART_MODE_SLEEP: u8 = 1;
pub const USBUART_MODE_NORMAL: u8 = 0;
pub const USBUART_CTS_ACTIVE: u8 = 1;
pub const USBUART_CTS_NOT_ACTIVE: u8 = 0;
pub const USBUART_POWER_ON: u8 = 1;
pub const USBUART_POWER_OFF: u8 = 0;

pub struct UsbUartConfig {
    pub rx: pin_name_t,
    pub tx: pin_name_t,
    pub cts: pin_name_t,
    pub sleep: pin_name_t,
    pub power: pin_name_t,
    pub rts: pin_name_t,
    pub baud_rate: u32,
    pub blocking: bool,
}

impl Default for UsbUartConfig {
    fn default() -> Self {
        Self {
            rx: HAL_PIN_NC,
            tx: HAL_PIN_NC,
            cts: HAL_PIN_NC,
            sleep: HAL_PIN_NC,
            power: HAL_PIN_NC,
            rts: HAL_PIN_NC,
            baud_rate: 115_200,
            blocking: false,
        }
    }
}

pub struct UsbUart {
    cts: digital_out_t,
    sleep: digital_out_t,
    power: digital_out_t,
    rts: digital_in_t,
    uart: uart_t,
}

impl UsbUart {
    pub fn new(config: UsbUartConfig) -> Result<Self, ()> {
        let mut uart = uart_t::default();
        let mut uart_config = uart_config_t::default();
        uart_config.rx = config.rx;
        uart_config.tx = config.tx;
        uart_open(&mut uart, uart_config).map_err(|_| ())?;
        uart_set_baud(&mut uart, config.baud_rate).map_err(|_| ())?;
        uart_set_blocking(&mut uart, config.blocking).map_err(|_| ())?;

        let mut cts = digital_out_t::default();
        let mut sleep = digital_out_t::default();
        let mut power = digital_out_t::default();
        let mut rts = digital_in_t::default();
        digital_out_init(&mut cts, config.cts).map_err(|_| ())?;
        digital_out_init(&mut sleep, config.sleep).map_err(|_| ())?;
        digital_out_init(&mut power, config.power).map_err(|_| ())?;
        digital_in_init(&mut rts, config.rts).map_err(|_| ())?;

        Ok(Self { cts, sleep, power, rts, uart })
    }

    pub fn write(&mut self, buffer: &mut [u8]) -> Result<usize, ()> {
        let len = buffer.len();
        uart_write(&mut self.uart, buffer, len).map_err(|_| ())
    }

    pub fn read(&mut self, buffer: &mut [u8]) -> Result<usize, ()> {
        let len = buffer.len();
        uart_read(&mut self.uart, buffer, len).map_err(|_| ())
    }

    pub fn power_control(&mut self, state: u8) {
        if state == USBUART_POWER_ON {
            let _ = digital_out_high(&mut self.power);
        } else {
            let _ = digital_out_low(&mut self.power);
        }
    }

    pub fn set_cts(&mut self, state: u8) {
        if state == USBUART_CTS_ACTIVE {
            let _ = digital_out_high(&mut self.cts);
        } else {
            let _ = digital_out_low(&mut self.cts);
        }
    }

    pub fn set_mode(&mut self, mode: u8) {
        if mode == USBUART_MODE_SLEEP {
            let _ = digital_out_high(&mut self.sleep);
        } else {
            let _ = digital_out_low(&mut self.sleep);
        }
    }

    pub fn rts(&mut self) -> Result<u8, ()> {
        digital_in_read(&mut self.rts).map_err(|_| ())
    }
}
