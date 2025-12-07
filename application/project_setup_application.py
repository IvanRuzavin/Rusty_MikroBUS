import os, subprocess
import sys
import sqlite3
from PyQt6.QtWidgets import (
    QApplication,
    QWidget,
    QVBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QScrollArea,
    QGridLayout,
    QDialog
)
from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont, QPixmap

from custom_ide_window import ProjectWindow
from register_config_panel import RegisterConfigPanel

database_path = os.path.join(os.path.dirname(__file__))

cfg_lines = """
source [find interface/stlink.cfg]
transport select dapdirect_swd
source [find target/{target_name}]
"""

class MCUConfigurator(QWidget):
    def __init__(self, instance_contents):
        super().__init__()

        self.setWindowTitle("MCU Configuration")
        self.resize(900, 600)

        self.database = sqlite3.connect(instance_contents['database_path'])
        self.db_cursor = self.database.cursor()

        self.field_widgets = {}
        self.current_data = {}

        self.apply_style()
        self.init_ui()

    # -------------------------------------------------------
    # Global styles
    # -------------------------------------------------------
    def apply_style(self):
        self.setStyleSheet('''
            QWidget {
                background: qlineargradient(
                    spread:pad, x1:0, y1:0, x2:1, y2:1,
                    stop:0 #0F1C3F, stop:1 #1B2A5A
                );
                color: white;
                font-family: Arial;
            }

            .mcu_square {
                background: rgba(255,255,255,0.08);
                border-radius: 12px;
                border: 1px solid rgba(255,255,255,0.15);
            }

            QPushButton {
                background-color: #999999;
                color: white;
                border: none;
                border-radius: 10px;
                padding: 8px 14px;
                font-size: 14px;
            }

            QPushButton:hover {
                background-color: #437D00;
            }

            QPushButton:pressed {
                background-color: #1E5D00;
            }

            QScrollArea {
                background: transparent;
            }
        ''')

    # -------------------------------------------------------
    # Main UI
    # -------------------------------------------------------
    def init_ui(self):
        main_layout = QVBoxLayout()

        title = QLabel("Choose MCU")
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        title.setFont(QFont("Arial", 18, QFont.Weight.Bold))
        main_layout.addWidget(title)

        # Scroll area with MCU buttons
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        scroll.setSizeAdjustPolicy(QScrollArea.SizeAdjustPolicy.AdjustToContents)

        self.grid_container = QWidget()
        self.grid_layout = QGridLayout()
        self.grid_layout.setSpacing(20)
        self.grid_container.setLayout(self.grid_layout)

        self.grid_container.setMinimumWidth(self.width() - 40)
        scroll.setWidget(self.grid_container)
        main_layout.addWidget(scroll)

        if self.layout() == None:
            self.setLayout(main_layout)
        else:
            self.layout().addWidget(title)
            self.layout().addWidget(scroll)

        self.create_mcu_buttons()

    # -------------------------------------------------------
    # MCU selection grid
    # -------------------------------------------------------
    def create_mcu_buttons(self):
        self.db_cursor.execute("SELECT NAME FROM MCU")
        mcus = [row[0] for row in self.db_cursor.fetchall()]

        icon = QPixmap(os.path.join(os.getcwd(), 'application/sprites/mcu.png')).scaled(80, 80)

        self.mcu_buttons = []   # store widgets for later reflow

        for name in mcus:
            widget = QWidget()
            widget.setFixedSize(150, 150)  # SQUARE BUTTON
            widget.setObjectName("card")
            w_layout = QVBoxLayout(widget)
            w_layout.setContentsMargins(5,5,5,5)
            w_layout.setSpacing(5)

            img_label = QLabel()
            img_label.setPixmap(icon)
            img_label.setAlignment(Qt.AlignmentFlag.AlignCenter)

            btn = QPushButton(name)
            btn.clicked.connect(lambda _, n=name: self.show_register_config(n))

            w_layout.addWidget(img_label, alignment=Qt.AlignmentFlag.AlignCenter)
            w_layout.addWidget(btn)

            self.mcu_buttons.append(widget)

        self.reflow_grid()

    # -------------------------------------------------------
    # Clock config popup
    # -------------------------------------------------------
    def open_clock_config(self, mcu_name):
        dlg = QDialog(self)
        dlg.setWindowTitle(f"{mcu_name} Clock Configuration")
        dlg.resize(400, 200)
        dlg.setStyleSheet(self.styleSheet())

        layout = QVBoxLayout(dlg)

        lbl = QLabel("Clock (MHz):")
        self.clock_input = QLineEdit()
        layout.addWidget(lbl)
        layout.addWidget(self.clock_input)

        save = QPushButton("Save")
        save.clicked.connect(dlg.accept)
        layout.addWidget(save)

        dlg.exec()

    # -------------------------------------------------------
    # Load JSON and populate register fields
    # -------------------------------------------------------
    def resizeEvent(self, event):
        if self.grid_layout is not None:
            self.reflow_grid()
        super().resizeEvent(event)

    def reflow_grid(self):
        if not hasattr(self, "mcu_buttons"):
            return

        if self.grid_layout is None:
            return

        self.grid_layout.setAlignment(Qt.AlignmentFlag.AlignTop)

        width = self.grid_container.width()
        card_width = 160  # approximate square button size
        columns = max(1, width // card_width)

        # Clear grid
        for i in reversed(range(self.grid_layout.count())):
            item = self.grid_layout.itemAt(i)
            if item:
                self.grid_layout.removeItem(item)

        # Re-add in new layout
        row = 0
        col = 0
        for widget in self.mcu_buttons:
            self.grid_layout.addWidget(widget, row, col)
            col += 1
            if col >= columns:
                col = 0
                row += 1

    def clear_layout(self):
        layout = self.layout()
        if layout is None:
            return

        while layout.count():
            item = layout.takeAt(0)
            widget = item.widget()
            if widget:
                widget.deleteLater()

        # also destroy grid_layout reference
        self.grid_layout = None

    def show_register_config(self, mcu_name):
        self.clear_layout()
        self.grid_layout = None
        # Fetch vendor & target
        self.db_cursor.execute(
            "SELECT Family.VENDOR, Family.TARGET, MCU.SYSTEM_LIB, MCU.FAMILY "
            "FROM MCU JOIN FAMILY ON MCU.FAMILY = FAMILY.NAME "
            f"WHERE MCU.NAME = '{mcu_name}'"
        )
        vendor, target, system_name, family = self.db_cursor.fetchall()[0]

        # Clear the window and load the register panel
        for i in reversed(range(self.layout().count())):
            widget = self.layout().itemAt(i).widget()
            if widget:
                widget.setParent(None)

        self.register_panel = RegisterConfigPanel(self, system_name, mcu_name, vendor, target, family, self.db_cursor)
        self.layout().addWidget(self.register_panel)

    def show_mcu_selection(self):
        self.clear_layout()
        # Restore original MCU grid view (rebuild UI)
        self.init_ui()

# Run Application
if __name__ == '__main__':
    app = QApplication(sys.argv)
    win = MCUConfigurator()
    win.show()
    sys.exit(app.exec())