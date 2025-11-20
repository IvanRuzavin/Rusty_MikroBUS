import sys

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

# Main Window
class RustyMikrobusApp(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Rust Toolchain Setup")
        self.resize(600, 300)
        self.init_ui()

    def launch_mcu_window(self):
        self.mcu_window = MCUConfigurator()
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
        self.steps_window = installer.InstallStepsWindow()
        self.steps_window.show()

# Separate Installation Steps Window


# Run Application
if __name__ == '__main__':
    app = QApplication(sys.argv)
    main_window = RustyMikrobusApp()
    main_window.show()
    sys.exit(app.exec())
