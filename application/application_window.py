import sys
import os
import subprocess
import urllib.request
from PyQt6.QtWidgets import (
    QApplication, QWidget, QPushButton, QVBoxLayout, QLabel, QHBoxLayout, QMessageBox, QMainWindow, QScrollArea
)
from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont, QGuiApplication

from project_setup_application import MCUConfigurator

# URLs
VS_TOOLS_URL = "https://aka.ms/vs/17/release/vs_BuildTools.exe"
RUST_URL = "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe"
ST_LINK_RAR_URL = "https://download.mikroe.com/setups/drivers/mikroprog/arm/st-link-usb-drivers.rar"
OPENOCD_URL = "https://github.com/xpack-dev-tools/openocd-xpack/releases/download/v0.12.0-7/xpack-openocd-0.12.0-7-win32-x64.zip"
ARM_NONE_EABI_URL = "https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/download/v14.2.1-1.1/xpack-arm-none-eabi-gcc-14.2.1-1.1-win32-x64.zip"
PROBE_RS_PS_COMMAND = (
    'powershell -ExecutionPolicy Bypass -c "irm https://github.com/probe-rs/probe-rs/releases/download/v0.27.0/probe-rs-tools-installer.ps1 | iex"'
)

INSTALLER_DIR = os.path.join(os.getcwd(), "installer")
RUNNER_DIR = os.path.join(os.getcwd(), "runner")
os.makedirs(INSTALLER_DIR, exist_ok=True)

# Helper Functions
def download_file(url, filename):
    try:
        save_path = os.path.join(INSTALLER_DIR, filename)
        urllib.request.urlretrieve(url, save_path)
        subprocess.run(["explorer", "/select,", save_path.replace('/', '\\')])
    except Exception as e:
        QMessageBox.critical(None, "Download Error", f"Failed to download {url}: {e}")

def download_and_extract_rar(url):
    try:
        import patoolib
        rar_path = os.path.join(INSTALLER_DIR, "st-link.rar")
        urllib.request.urlretrieve(url, rar_path)
        patoolib.extract_archive(rar_path, outdir=INSTALLER_DIR)
        os.remove(rar_path)
        subprocess.run(["explorer", INSTALLER_DIR])
    except Exception as e:
        QMessageBox.critical(None, "RAR Extraction Error", f"Failed to handle RAR: {e}")

def download_and_extract_rar_runner(url):
    try:
        import patoolib
        rar_path = os.path.join(INSTALLER_DIR, "st-link.rar")
        urllib.request.urlretrieve(url, rar_path)
        patoolib.extract_archive(rar_path, outdir=RUNNER_DIR)
        os.remove(rar_path)
    except Exception as e:
        QMessageBox.critical(None, "RAR Extraction Error", f"Failed to handle RAR: {e}")

def run_powershell_command(command):
    subprocess.Popen(["powershell.exe", "-ExecutionPolicy", "Bypass", "-Command", command], creationflags=subprocess.CREATE_NEW_CONSOLE)

def copy_to_clipboard(text):
    QGuiApplication.clipboard().setText(text)


# Main Window
class RustInstallerApp(QWidget):
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
        self.steps_window = InstallStepsWindow()
        self.steps_window.show()

# Separate Installation Steps Window
class InstallStepsWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Rust Toolchain Installation Steps")
        self.resize(800, 400)

        scroll = QScrollArea()
        container = QWidget()
        layout = QVBoxLayout()

        font_label = QFont("Arial", 11)
        font_button = QFont("Arial", 10)

        def step_row(description, url_or_cmd, download_text, download_func):
            row = QHBoxLayout()

            label = QLabel(description)
            label.setFont(font_label)
            label.setWordWrap(True)

            button_col = QVBoxLayout()
            if 'PowerShell' not in description:
                copy_btn = QPushButton("Copy Link")
            else:
                copy_btn = QPushButton("Copy Command")
            copy_btn.setFont(font_button)
            copy_btn.clicked.connect(lambda: copy_to_clipboard(url_or_cmd))

            download_btn = QPushButton(download_text)
            download_btn.setFont(font_button)
            download_btn.clicked.connect(download_func)

            button_col.addWidget(copy_btn)
            button_col.addWidget(download_btn)

            row.addWidget(label, stretch=3)
            row.addLayout(button_col, stretch=1)

            return row

        layout.addLayout(step_row(
            f"1) Install MSVC build tools (select C++ build tools):\n{VS_TOOLS_URL}",
            VS_TOOLS_URL,
            "Download",
            lambda: download_file(VS_TOOLS_URL, "vs_BuildTools.exe")
        ))

        layout.addLayout(step_row(
            f"2) Install Rust language support:\n{RUST_URL}",
            RUST_URL,
            "Download",
            lambda: download_file(RUST_URL, "rustup-init.exe")
        ))

        layout.addLayout(step_row(
            f"3) Install ST-Link drivers:\n{ST_LINK_RAR_URL}",
            ST_LINK_RAR_URL,
            "Download",
            lambda: download_and_extract_rar(ST_LINK_RAR_URL)
        ))

        layout.addLayout(step_row(
            f"4) Execute the following PowerShell command:\n{PROBE_RS_PS_COMMAND}",
            PROBE_RS_PS_COMMAND,
            "Execute",
            lambda: run_powershell_command(PROBE_RS_PS_COMMAND)
        ))

        layout.addLayout(step_row(
            f"5) Install OpenOCD runner:\n{OPENOCD_URL}",
            OPENOCD_URL,
            "Download",
            lambda: download_and_extract_rar_runner(OPENOCD_URL)
        ))

        layout.addLayout(step_row(
            f"6) Install ARM None Eabi runner:\n{ARM_NONE_EABI_URL}",
            ARM_NONE_EABI_URL,
            "Download",
            lambda: download_and_extract_rar_runner(ARM_NONE_EABI_URL)
        ))

        container.setLayout(layout)
        scroll.setWidget(container)
        scroll.setWidgetResizable(True)
        self.setCentralWidget(scroll)

# Run Application
if __name__ == '__main__':
    app = QApplication(sys.argv)
    main_window = RustInstallerApp()
    main_window.show()
    sys.exit(app.exec())
