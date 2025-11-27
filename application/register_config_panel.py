# register_config_panel.py
import os
import json
import subprocess
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QLabel, QPushButton,
    QScrollArea, QGridLayout, QComboBox, QLineEdit,
    QHBoxLayout, QMessageBox, QSizePolicy, QLayout
)
from PyQt6.QtCore import Qt, QSize
from PyQt6.QtGui import QFont


class RegisterConfigPanel(QWidget):
    """
    Register configuration panel:
    - Two columns when window wide enough, otherwise one.
    - Labels above corresponding controls.
    - Clock input spans full width of its column.
    - Combobox wheel events disabled.
    - Rounded corners for input controls and buttons via stylesheet.
    """

    def __init__(self, parent_window, database, mcu_name, vendor, target):
        super().__init__()
        self.parent_window = parent_window
        self.database = database
        self.db_cursor = database.cursor()
        self.mcu_name = mcu_name
        self.vendor = vendor
        self.target = target

        # Will hold (label_widget, control_widget, combined_key, mask) tuples for layout management
        self._fields = []        # visible fields -> tuples (label_widget, control_widget, combined_key, mask)
        self.hidden_fields = {}  # combined_key -> list of (mask, value_hex)

        self.current_data = {}
        self.clock_input = None

        # Layout bookkeeping for responsive grid
        self.columns = 2
        self.column_threshold = 700  # window width threshold to switch from 1->2 columns (tweak as needed)

        self._build_ui()
        self._load_register_config()
        self._apply_styles()

    # -----------------------
    # UI creation
    # -----------------------
    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 12, 16, 12)
        root.setSpacing(12)

        title = QLabel(f"{self.mcu_name} Register Configuration")
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        title.setFont(QFont("Arial", 16, QFont.Weight.Bold))
        root.addWidget(title)

        # Back button row
        back_row = QHBoxLayout()
        back_btn = QPushButton("← Back to MCU Selection")
        back_btn.setFixedHeight(36)
        back_btn.clicked.connect(self.on_back_pressed)
        back_row.addWidget(back_btn, alignment=Qt.AlignmentFlag.AlignLeft)
        root.addLayout(back_row)

        # Clock container ABOVE the scroll area
        clock_container = QVBoxLayout()
        clock_container.setSpacing(6)
        clock_container.setContentsMargins(0, 0, 0, 0)

        self.clock_label = QLabel("Clock (MHz):")
        self.clock_label.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)

        self.clock_input = QLineEdit()
        self.clock_input.setMinimumHeight(36)
        self.clock_input.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

        clock_container.addWidget(self.clock_label)
        clock_container.addWidget(self.clock_input)

        # Add BEFORE scroll area
        root.addLayout(clock_container)

        # Scroll area to hold the grid
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        root.addWidget(self.scroll, stretch=1)

        # Container inside scroll
        self.form_widget = QWidget()
        self.form_layout = QGridLayout(self.form_widget)
        # spacing and margins
        self.form_layout.setContentsMargins(12, 12, 12, 12)
        self.form_layout.setHorizontalSpacing(24)
        self.form_layout.setVerticalSpacing(16)
        # placeholder so we can reflow easily
        self.scroll.setWidget(self.form_widget)

        # Save button
        save_btn = QPushButton("Save Parameters")
        save_btn.setFixedHeight(42)
        save_btn.clicked.connect(self.save_parameters)
        root.addWidget(save_btn)

        # Ensure the top-level layout is set (already by passing self to QVBoxLayout)
        self.setLayout(root)

    # -----------------------
    # Load JSON definition & create controls
    # -----------------------
    def _load_register_config(self):
        # Adjust path to match where your JSON files are stored
        filepath = os.path.join(os.getcwd(), 'core/arm/stm32/mcu_definitions', f'{self.mcu_name}.json')
        if not os.path.exists(filepath):
            QMessageBox.critical(self, "Error", f"MCU definition file missing:\n{filepath}")
            return

        with open(filepath, "r", encoding="utf-8") as f:
            self.current_data = json.load(f)

        self.clock_input.setText(self.current_data['clock'])
        self.clock_input.setMinimumHeight(36)
        self.clock_input.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

        # Now register fields
        for reg in self.current_data.get("config_registers", []):
            reg_key = reg["key"]
            addr = reg["address"]
            combined_key = f"{reg_key}|{addr}"

            for field in reg["fields"]:
                label_text = field.get("label", field["key"])
                label_widget = QLabel(label_text)
                label_widget.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)

                # hidden field (no UI) -> record only
                if field.get("hidden", False):
                    self.hidden_fields.setdefault(combined_key, []).append((field["mask"], field.get("init", "0x0")))
                    continue

                combo = QComboBox()
                combo.setMinimumHeight(36)
                combo.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)

                # disable accidental wheel scrolling
                combo.wheelEvent = lambda event: None

                init_value = field.get("init", "")
                if "settings" in field:
                    for setting in field["settings"]:
                        combo.addItem(setting["label"], setting["value"])
                        # Try to match init value (compare lowercased)
                        if isinstance(setting["value"], str) and isinstance(init_value, str):
                            if init_value.lower() == setting["value"].lower():
                                combo.setCurrentText(setting["label"])

                # keep track for later reading/writing
                self._fields.append((label_widget, combo, combined_key, field.get("mask")))

        # After creating controls, perform initial layout
        self._reflow_fields()

    # -----------------------
    # Reflow / responsive layout
    # -----------------------
    def _reflow_fields(self):
        """
        Arrange widgets from self._fields into the grid layout using self.columns columns.
        We will remove existing items from form_layout and reinsert.
        Each field is a pair label-above-control placed in a QVBoxLayout and then placed into the grid.
        """
        # Clear existing layout items
        self._clear_layout(self.form_layout)

        if not self._fields:
            return

        cols = self.columns
        row = 0
        col = 0

        for (label_widget, control_widget, combined_key, mask) in self._fields:
            # wrapper vertical layout for label above control
            wrapper = QVBoxLayout()
            wrapper.setSpacing(6)
            wrapper.setContentsMargins(0, 0, 0, 0)
            # ensure control expands horizontally in its column
            control_widget.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

            wrapper.addWidget(label_widget)
            wrapper.addWidget(control_widget)

            # Add wrapper to grid at (row, col)
            # QGridLayout.addLayout expects the layout itself
            self.form_layout.addLayout(wrapper, row, col)

            col += 1
            if col >= cols:
                col = 0
                row += 1

        # Add stretch to push items to top if there is extra vertical space
        # Create an empty spacer row by adding a dummy widget with expanding vertical policy
        spacer = QWidget()
        spacer.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        # place spacer in the grid spanning all columns at next row
        self.form_layout.addWidget(spacer, row + 1, 0, 1, cols)

        # update geometry
        self.form_widget.updateGeometry()

    def _clear_layout(self, layout: QLayout):
        """Remove and delete items from a layout safely."""
        while layout.count():
            item = layout.takeAt(0)
            if item is None:
                continue
            widget = item.widget()
            if widget:
                widget.deleteLater()
            else:
                child_layout = item.layout()
                if child_layout:
                    self._clear_layout(child_layout)

    # -----------------------
    # Resize event -> switch between 1/2 columns
    # -----------------------
    def resizeEvent(self, event):
        w = self.width()
        desired_columns = 2 if w >= self.column_threshold else 1
        if desired_columns != self.columns:
            self.columns = desired_columns
            self._reflow_fields()
        super().resizeEvent(event)

    # -----------------------
    # Back button handler
    # -----------------------
    def on_back_pressed(self):
        # Assumes parent_window implements show_mcu_selection(); keep same behavior as before
        try:
            self.parent_window.show_mcu_selection()
        except Exception:
            # Fallback: if parent doesn't provide that, just close this widget
            self.close()

    # -----------------------
    # Save parameters
    # -----------------------
    def save_parameters(self):
        # Clock value
        try:
            clock_mhz = int(self.clock_input.text())
        except Exception:
            QMessageBox.critical(self, "Error", "Clock must be an integer (MHz).")
            return

        # Build the register header output
        core_header_output = []
        # For each visible field that has a combined_key != "CLOCK"
        collected = {}
        for label, control, combined_key, mask in self._fields:
            if combined_key is None or combined_key == "CLOCK":
                continue
            # control is QComboBox
            value_hex = control.currentData()
            if value_hex is None:
                # skip or default to 0
                continue
            try:
                value_int = int(value_hex, 16)
            except Exception:
                # if not hex, try decimal
                try:
                    value_int = int(value_hex)
                except Exception:
                    value_int = 0
            collected.setdefault(combined_key, 0)
            collected[combined_key] |= value_int

        # include hidden fields
        for combined_key, items in self.hidden_fields.items():
            for mask, value_hex in items:
                try:
                    val = int(value_hex, 16)
                except Exception:
                    try:
                        val = int(value_hex)
                    except Exception:
                        val = 0
                collected.setdefault(combined_key, 0)
                collected[combined_key] |= val

        # produce constants
        for combined_key, reg_value in collected.items():
            reg_name, addr = combined_key.split("|")
            core_header_output.append(f"pub const ADDRESS_{reg_name}: u32 = 0x{addr};")
            core_header_output.append(f"pub const VALUE_{reg_name}: u32 = 0x{reg_value:08X};")

        core_header_output.append(f"pub const FOSC_KHZ_VALUE: u32 = {clock_mhz * 1000};")

        setup_folder = os.path.join(os.getcwd(), '.setup')
        os.makedirs(setup_folder, exist_ok=True)
        with open(os.path.join(setup_folder, "core_header.rs"), "w", encoding="utf-8") as f:
            f.write("\n".join(core_header_output))

        # Add rust target (non-blocking warning: subprocess.run is used as before)
        subprocess.run(f"rustup target add {self.target}", shell=True)

        QMessageBox.information(self, "Success", "MCU configuration saved.")
        # Original behavior: close parent window - keep same
        try:
            self.parent_window.close()
        except Exception:
            self.close()

    # -----------------------
    # Styling
    # -----------------------
    def _apply_styles(self):
        # Global styling for rounded corners and padding.
        # Note: styling of combobox dropdown view sometimes needs a separate selector.
        self.setStyleSheet("""
        QWidget {
            background: qlineargradient(x1:0, y1:0, x2:1, y2:1, stop:0 #0F1C3F, stop:1 #1B2A5A);
            color: white;
            font-family: Arial;
        }
        QLineEdit, QComboBox, QPushButton {
            border-radius: 10px;
            padding: 6px;
            background: rgba(255,255,255,0.06);
            color: white;
            border: 1px solid rgba(255,255,255,0.12);
        }
        QLabel {
            color: #E6EEF8;
        }
        QComboBox QAbstractItemView {
            border-radius: 10px;
            selection-background-color: rgba(67,125,0,0.9);
        }
        QScrollArea {
            background: transparent;
            border: none;
        }
        QPushButton:hover {
            background-color: rgba(67,125,0,0.9);
        }
        QPushButton:pressed {
            background-color: rgba(30,93,0,0.9);
        }
        """)
        self.clock_input.setStyleSheet("""
            QLineEdit {
                background: rgba(0, 30, 80, 0.45);   /* darker blue */
                border: 1px solid rgba(255,255,255,0.18);
                border-radius: 10px;
                padding: 6px;
                color: white;
            }
        """)

