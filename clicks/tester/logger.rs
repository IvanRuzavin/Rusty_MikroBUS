use core::fmt::{self, Write};
use drv_name::pin_name_t;
use drv_uart::{uart_config_t, uart_open, uart_print, uart_t};

pub struct UartLogger {
    uart: uart_t,
}

impl UartLogger {
    pub fn new(rx: pin_name_t, tx: pin_name_t) -> Result<Self, ()> {
        let mut uart = uart_t::default();
        let mut cfg = uart_t::default().config;
        cfg.rx = rx;
        cfg.tx = tx;
        cfg.baud = 115_200;
        uart_open(&mut uart, cfg).map_err(|_| ())?;
        Ok(Self { uart })
    }

    pub fn print(&mut self, text: &str) { let _ = uart_print(&mut self.uart, text); }
}

impl Write for UartLogger {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        uart_print(&mut self.uart, s).map(|_| ()).map_err(|_| fmt::Error)
    }
}
