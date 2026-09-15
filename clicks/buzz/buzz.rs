use drv_name::{pin_name_t, HAL_PIN_NC};
use drv_pwm::{
    pwm_config_t, pwm_open, pwm_set_duty, pwm_set_freq, pwm_start, pwm_stop, pwm_t,
};
use system::init_clock::Delay_ms;

pub const BUZZ_DEF_FREQ: u32 = 5_000;
pub const BUZZ_NOTE_F6: u16 = 1397;
pub const BUZZ_NOTE_AB6: u16 = 1661;
pub const BUZZ_NOTE_A6: u16 = 1760;
pub const BUZZ_NOTE_BB6: u16 = 1865;
pub const BUZZ_NOTE_B6: u16 = 1976;
pub const BUZZ_NOTE_C7: u16 = 2093;
pub const BUZZ_NOTE_DB7: u16 = 2217;
pub const BUZZ_NOTE_D7: u16 = 2349;
pub const BUZZ_NOTE_EB7: u16 = 2489;
pub const BUZZ_NOTE_E7: u16 = 2637;
pub const BUZZ_NOTE_F7: u16 = 2794;
pub const BUZZ_NOTE_GB7: u16 = 2960;
pub const BUZZ_NOTE_G7: u16 = 3136;
pub const BUZZ_NOTE_AB7: u16 = 3322;
pub const BUZZ_NOTE_A7: u16 = 3520;

pub struct BuzzConfig {
    pub pwm: pin_name_t,
    pub pwm_frequency: u32,
}

impl Default for BuzzConfig {
    fn default() -> Self {
        Self { pwm: HAL_PIN_NC, pwm_frequency: BUZZ_DEF_FREQ }
    }
}

pub struct Buzz {
    pwm: pwm_t,
    pub pwm_frequency: u32,
}

impl Default for Buzz {
    fn default() -> Self {
        Self { pwm: pwm_t::default(), pwm_frequency: BUZZ_DEF_FREQ }
    }
}

impl Buzz {
    pub fn new(config: BuzzConfig) -> Result<Self, ()> {
        let mut pwm = pwm_t::default();
        let mut pwm_config = pwm_config_t::default();
        pwm_config.pin = config.pwm;
        pwm_open(&mut pwm, pwm_config).map_err(|_| ())?;
        pwm_set_freq(&mut pwm, config.pwm_frequency).map_err(|_| ())?;
        Ok(Self { pwm, pwm_frequency: config.pwm_frequency })
    }

    pub fn set_duty_cycle(&mut self, duty: f32) -> Result<(), ()> {
        pwm_set_duty(&mut self.pwm, duty).map_err(|_| ())
    }

    pub fn start(&mut self) -> Result<(), ()> {
        pwm_start(&mut self.pwm).map_err(|_| ())
    }

    pub fn stop(&mut self) -> Result<(), ()> {
        pwm_stop(&mut self.pwm).map_err(|_| ())
    }

    pub fn play_sound(&mut self, frequency: u16, level: u16, duration_ms: u16) -> Result<(), ()> {
        pwm_set_freq(&mut self.pwm, frequency as u32).map_err(|_| ())?;
        self.pwm_frequency = frequency as u32;
        self.start()?;
        self.set_duty_cycle(level as f32 / 1000.0)?;
        Delay_ms(duration_ms as u32);
        self.stop()
    }
}
