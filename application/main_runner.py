import sys, os, json

import installer_win as installer

from PyQt6.QtWidgets import (
    QApplication,
    QWidget,
    QPushButton,
    QVBoxLayout,
    QLabel,
    QHBoxLayout
)

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont

from project_setup_application import MCUConfigurator

instance_contents = {
    'running_os': sys.platform,
    'vs_tools_path': 'c:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools',
    'rustup_path': f'{os.path.expanduser("~")}/.rustup',
    'probers_path': f'{os.path.expanduser("~")}/.cargo',
    'jlink_path': 'c:/Program Files/SEGGER',
    'stlink_path': 'c:/Windows/System32/DriverStore/FileRepository/stlink_vcp.inf',
    'gcc_path': os.path.join(os.path.dirname(__file__), 'runner/xpack-arm-none-eabi-gcc-14.2.1-1.1'),
    'openocd_path': os.path.join(os.path.dirname(__file__), 'runner/xpack-openocd-0.12.0-7'),
    'database_path': os.path.join(os.path.dirname(__file__), 'database/database_mikro_sdk_rust.db')
}

def apply_global_style(widget):
    widget.setStyleSheet("""
        QWidget {
            background-color: #0F1C3F;
            color: white;
            font-family: Arial;
        }

        QPushButton {
            background-color: #162A63;
            border: 2px solid #1C3C7A;
            padding: 10px;
            border-radius: 8px;
            font-size: 14px;
            color: white;
        }

        QPushButton:hover {
            background-color: #1C3C7A;
        }

        QPushButton:pressed {
            background-color: #0A1430;
        }
    """)

# Main Window
class RustyMikrobusApp(QWidget):
    def __init__(self):
        super().__init__()
        apply_global_style(self)
        self.setWindowTitle("Rust Toolchain Setup")
        self.resize(600, 300)
        self.init_ui()

    def launch_mcu_window(self):
        self.mcu_window = MCUConfigurator(instance_contents)
        self.mcu_window.show()
        self.close()

    def init_ui(self):
        layout = QVBoxLayout()

        question = QLabel("What would you like to do?")
        question.setAlignment(Qt.AlignmentFlag.AlignCenter)
        question.setFont(QFont("Arial", 14, QFont.Weight.Bold))
        layout.addWidget(question)

        button_layout = QHBoxLayout()

        self.install_button = QPushButton("I would like to install RUST toolchain for Windows")
        self.install_button.setMinimumHeight(80)
        self.install_button.setFont(QFont("Arial", 12))
        self.install_button.clicked.connect(self.show_install_steps)

        self.start_button = QPushButton("I would like to start my work with my RUST SDK project")
        self.start_button.setMinimumHeight(80)
        self.start_button.setFont(QFont("Arial", 12))
        self.start_button.clicked.connect(self.launch_mcu_window)

        button_layout.addWidget(self.install_button)
        button_layout.addWidget(self.start_button)

        layout.addLayout(button_layout)
        self.setLayout(layout)

    def show_install_steps(self):
        self.steps_window = installer.InstallerWindow(instance_contents)
        self.steps_window.show()

# Run Application
if __name__ == '__main__':
    if os.path.exists(os.path.join(os.path.dirname(__file__), 'instance_uid.json')):
        with open(os.path.join(os.path.dirname(__file__), 'instance_uid.json'), 'r') as application_instance:
            instance_contents = json.loads(application_instance.read())
    with open(os.path.join(os.path.dirname(__file__), 'instance_uid.json'), 'w') as application_instance:
        json.dump(instance_contents, application_instance, indent = 4)
    os.makedirs(os.path.join(os.path.dirname(__file__), 'database'), exist_ok=True)
    app = QApplication(sys.argv)
    main_window = RustyMikrobusApp()
    main_window.show()
    sys.exit(app.exec())
