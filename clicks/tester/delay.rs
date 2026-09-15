use system::init_clock::{delay_1ms, delay_5ms, delay_10ms, delay_100ms, delay_1sec};

pub fn delay_ms(mut ms: u32) {
    while ms >= 1000 { delay_1sec(); ms -= 1000; }
    while ms >= 100 { delay_100ms(); ms -= 100; }
    while ms >= 10 { delay_10ms(); ms -= 10; }
    if ms >= 5 { delay_5ms(); ms -= 5; }
    while ms > 0 { delay_1ms(); ms -= 1; }
}
