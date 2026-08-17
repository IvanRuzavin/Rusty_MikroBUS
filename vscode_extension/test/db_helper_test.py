#!/usr/bin/env python3
import json
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'scripts' / 'db_helper.py'

with tempfile.TemporaryDirectory() as tmp:
    db_path = Path(tmp) / 'test.db'
    db = sqlite3.connect(db_path)
    db.execute('CREATE TABLE FAMILY (NAME TEXT, VENDOR TEXT, TARGET TEXT, OTHER TEXT, GPIO TEXT, ADC TEXT, I2C TEXT, SPI TEXT, TIM TEXT, UART TEXT)')
    db.execute('CREATE TABLE MCU (NAME TEXT, FAMILY TEXT, SYSTEM_LIB TEXT)')
    db.execute("INSERT INTO FAMILY VALUES ('STM32F4','ST','thumbv7em-none-eabihf','x','g','a','i','s','t','u')")
    db.execute("INSERT INTO MCU VALUES ('STM32F407VG','STM32F4','sys')")
    db.commit(); db.close()

    listed = subprocess.check_output([sys.executable, str(HELPER), 'list-mcus', '--db', str(db_path)], text=True)
    assert json.loads(listed) == ['STM32F407VG']
    details = subprocess.check_output([sys.executable, str(HELPER), 'mcu-details', '--db', str(db_path), '--mcu', 'STM32F407VG'], text=True)
    value = json.loads(details)
    assert value['target'] == 'thumbv7em-none-eabihf'
    assert value['familyRecord']['raw'][4] == 'g'
print('db_helper_test: ok')
