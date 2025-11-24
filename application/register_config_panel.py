import os
import json
import subprocess
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QLabel, QPushButton,
    QScrollArea, QFormLayout, QComboBox, QHBoxLayout,
    QMessageBox
)
from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont


class RegisterConfigPanel(QWidget):
    """
    This widget displays the register configuration fields
    for a selected MCU and handles save_parameters().
    """
    def __init__(self, parent_window, database, mcu_name, vendor, target):
        super().__init__()
        self.parent_window = parent_window
        self.database = database
        self.db_cursor = database.cursor()
        self.mcu_name = mcu_name
        self.vendor = vendor
        self.target = target

        self.current_data = {}
        self.field_widgets = {}
        self.hidden_fields = {}
        self.clock_input = None

        self.build_ui()
        self.load_register_config()

    # -------------------------------------------------------
    # Build UI
    # -------------------------------------------------------
    def build_ui(self):
        layout = QVBoxLayout(self)
        title = QLabel(f"{self.mcu_name} Register Configuration")
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        title.setFont(QFont("Arial", 18, QFont.Weight.Bold))

        layout.addWidget(title)

        # Back button
        back_btn = QPushButton("← Back to MCU Selection")
        back_btn.clicked.connect(self.on_back_pressed)
        back_btn.setFixedHeight(40)
        layout.addWidget(back_btn)

        # Registers scroll area
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        layout.addWidget(self.scroll, stretch=1)

        self.form_widget = QWidget()
        self.form_layout = QFormLayout(self.form_widget)
        self.form_layout.setContentsMargins(20, 20, 20, 20)
        self.form_layout.setSpacing(12)

        self.scroll.setWidget(self.form_widget)

        # Save button
        save_btn = QPushButton("Save Parameters")
        save_btn.clicked.connect(self.save_parameters)
        save_btn.setFixedHeight(45)
        layout.addWidget(save_btn)

    # -------------------------------------------------------
    # Load Registers from JSON definition
    # -------------------------------------------------------
    def load_register_config(self):
        filepath = os.path.join(os.getcwd(), 'core/arm/stm32/mcu_definitions', f'{self.mcu_name}.json')
        if not os.path.exists(filepath):
            QMessageBox.critical(self, "Error", f"MCU definition file missing:\n{filepath}")
            return

        with open(filepath, "r") as f:
            self.current_data = json.load(f)

        # Create form rows
        for reg in self.current_data.get("config_registers", []):
            reg_key = reg["key"]
            addr = reg["address"]
            combined_key = f"{reg_key}|{addr}"

            for field in reg["fields"]:
                label = field.get("label", field["key"])
                mask = field["mask"]
                init_value = field.get("init", "")

                # Hidden fields → no UI
                if field.get("hidden", False):
                    self.hidden_fields.setdefault(combined_key, []).append((mask, init_value))
                    continue

                combo = QComboBox()

                if "settings" in field:
                    for setting in field["settings"]:
                        combo.addItem(setting["label"], setting["value"])
                        if init_value.lower() == setting["value"].lower():
                            combo.setCurrentText(setting["label"])

                self.form_layout.addRow(QLabel(label), combo)
                self.field_widgets.setdefault(combined_key, []).append((mask, combo))

        # Clock setting
        from PyQt6.QtWidgets import QLineEdit
        lbl = QLabel("Clock (MHz):")
        self.clock_input = QLineEdit()
        self.clock_input.setPlaceholderText("Enter system clock in MHz")
        self.form_layout.addRow(lbl, self.clock_input)

    # -------------------------------------------------------
    # Back to MCU selection
    # -------------------------------------------------------
    def on_back_pressed(self):
        self.parent_window.show_mcu_selection()

    # -------------------------------------------------------
    # SAVE PARAMETERS
    # -------------------------------------------------------
    def save_parameters(self):
        # Get clock
        try:
            clock_mhz = int(self.clock_input.text())
        except:
            QMessageBox.critical(self, "Error", "Clock must be an integer (MHz).")
            return

        # Build the register header output
        core_header_output = []
        for key, fields in self.field_widgets.items():
            reg_name, addr = key.split("|")
            reg_value = 0

            # visible fields
            for mask, combo in fields:
                value_hex = combo.currentData()
                value_int = int(value_hex, 16)
                reg_value |= value_int

            # hidden fields
            for mask, value_hex in self.hidden_fields.get(key, []):
                reg_value |= int(value_hex, 16)

            core_header_output.append(f"pub const ADDRESS_{reg_name}: u32 = 0x{addr};")
            core_header_output.append(f"pub const VALUE_{reg_name}: u32 = 0x{reg_value:08X};")

        core_header_output.append(f"pub const FOSC_KHZ_VALUE: u32 = {clock_mhz * 1000};")

        # Write file
        with open("core/system/src/core_header.rs", "w") as f:
            f.write("\n".join(core_header_output))

        # Add rust target
        subprocess.run(f"rustup target add {self.target}", shell=True)

        QMessageBox.information(self, "Success", "MCU configuration saved.")
        self.parent_window.close()
