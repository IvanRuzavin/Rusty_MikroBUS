use drv_analog_in::{
    analog_in_config_t, analog_in_open, analog_in_read, analog_in_read_voltage,
    analog_in_set_resolution, analog_in_set_vref_value, analog_in_t,
    analog_in_resolution_t, ADC_RESOLUTION_DEFAULT,
};
use drv_name::{pin_name_t, HAL_PIN_NC};

pub struct PotConfig {
    pub an: pin_name_t,
    pub resolution: analog_in_resolution_t,
    pub vref: f32,
}

impl Default for PotConfig {
    fn default() -> Self {
        Self { an: HAL_PIN_NC, resolution: ADC_RESOLUTION_DEFAULT, vref: 3.3 }
    }
}

pub struct Pot {
    adc: analog_in_t,
}

impl Pot {
    pub fn new(config: PotConfig) -> Result<Self, ()> {
        let mut adc = analog_in_t::default();
        let mut adc_config = analog_in_config_t::default();
        adc_config.pin = config.an;
        analog_in_open(&mut adc, adc_config).map_err(|_| ())?;
        analog_in_set_vref_value(&mut adc, config.vref).map_err(|_| ())?;
        analog_in_set_resolution(&mut adc, config.resolution).map_err(|_| ())?;
        Ok(Self { adc })
    }

    pub fn read_raw(&mut self) -> Result<u16, ()> {
        analog_in_read(&mut self.adc).map_err(|_| ())
    }

    pub fn read_voltage(&mut self) -> Result<f32, ()> {
        analog_in_read_voltage(&mut self.adc).map_err(|_| ())
    }
}
