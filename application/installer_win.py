import subprocess, urllib.request, os, shutil

from PyQt6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QLabel,
    QMainWindow,
    QScrollArea,
    QMessageBox,
    QHBoxLayout,
    QPushButton,
    QApplication
)

from PyQt6.QtGui import QPixmap
from PyQt6.QtCore import Qt

# Application directories
INSTALLER_DIR = os.path.join(os.path.dirname(__file__), 'installer')
RUNNER_DIR = os.path.join(os.path.dirname(__file__), 'runner')
os.makedirs(INSTALLER_DIR, exist_ok=True)

# URLs
VS_TOOLS_URL = 'https://aka.ms/vs/17/release/vs_BuildTools.exe'
RUST_URL = 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe'
ST_LINK_RAR_URL = 'https://download.mikroe.com/setups/drivers/mikroprog/arm/st-link-usb-drivers.rar'
OPENOCD_URL = 'https://github.com/xpack-dev-tools/openocd-xpack/releases/download/v0.12.0-7/xpack-openocd-0.12.0-7-win32-x64.zip'
ARM_NONE_EABI_URL = 'https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/download/v14.2.1-1.1/xpack-arm-none-eabi-gcc-14.2.1-1.1-win32-x64.zip'
# Direct segger download link requires verification, so I provide google deive exe file
SEGGER_URL = 'https://www.segger.com/downloads/jlink/JLink_Windows_V888_x86_64.exe'
PROBE_RS_PS_COMMAND = (
    'irm https://github.com/probe-rs/probe-rs/releases/download/v0.27.0/probe-rs-tools-installer.ps1 | iex'
)

dots = '.'

# Helper Functions
def file_exists_containing(path, needle):
    return any(needle in f for _, _, fs in os.walk(path) for f in fs)

def run_uninstall(directory_path):
    for root, _, files in os.walk(directory_path):
        for file in files:
            if 'uninstall' in file.lower():
                uninstaller_path = os.path.join(root, file)
                process = subprocess.Popen([uninstaller_path], shell=True)
                process.wait()

    return os.path.exists(directory_path)


def remove_directory(directory_path):
    shutil.rmtree(directory_path)

    return os.path.exists(directory_path)

def download_and_uninstall(url: str, filename: str, instance_contents, refresh_all=None):
    try:
        save_path = os.path.join(INSTALLER_DIR, filename)

        # Download file
        urllib.request.urlretrieve(url, save_path)

        # Run the installer
        install_path = instance_contents['vs_tools_path']
        subprocess.Popen([save_path], shell=True)
        refresh_all(instance_contents)

        return not os.path.exists(install_path)
    except:
        return False

def download_and_run(url: str, filename: str, instance_contents, refresh_all=None):
    try:
        save_path = os.path.join(INSTALLER_DIR, filename)

        # Download file
        if 'jlink' not in url:
            urllib.request.urlretrieve(url, save_path)
        else:
            process = subprocess.Popen(['start', SEGGER_URL], shell=True)
            process.wait()

        # Run the installer
        if 'rustup' in url:
            install_path = instance_contents['rustup_path']
            process = subprocess.Popen(['powershell.exe', '-ExecutionPolicy', 'Bypass', '-Command', '&', save_path], creationflags=subprocess.CREATE_NEW_CONSOLE)
            process.wait()
        elif 'jlink' in url:
            install_path = instance_contents['jlink_path']
        else:
            install_path = instance_contents['vs_tools_path']
            process = subprocess.Popen([save_path], shell=True)
            refresh_all(instance_contents)

        return os.path.exists(install_path)
    except:
        return False

def download_extract_to(url: str, output_dir: str, temp_name='temp.rar'):
    try:
        os.makedirs(output_dir, exist_ok=True)
        import patoolib
        rar_path = os.path.join(output_dir, temp_name)

        # Download file
        urllib.request.urlretrieve(url, rar_path)

        # Extract
        patoolib.extract_archive(rar_path, outdir=output_dir)

        # Cleanup
        os.remove(rar_path)

    except Exception as e:
        QMessageBox.critical(None, 'Extractor Error', f'Failed to extract archive: {e}')

def install_stlink(instance_contents):
    try:
        download_extract_to(ST_LINK_RAR_URL, INSTALLER_DIR)
        runner = os.path.join(INSTALLER_DIR, 'st_link_USB_driver', 'dpinst_amd64.exe')
        # subprocess.run(['explorer', INSTALLER_DIR])
        process = subprocess.Popen([runner], shell=True)
        process.wait()

        return os.path.exists(instance_contents['stlink_path'])
    except:
        return False

def install_openocd_runner(instance_contents):
    try:
        download_extract_to(OPENOCD_URL, RUNNER_DIR)

        return os.path.exists(instance_contents['openocd_path'])
    except:
        return False

def install_arm_runner(instance_contents):
    try:
        download_extract_to(ARM_NONE_EABI_URL, RUNNER_DIR)

        return os.path.exists(instance_contents['gcc_path'])
    except:
        return False

def install_probers(instance_contents):
    try:
        process = subprocess.Popen(['powershell.exe', '-ExecutionPolicy', 'Bypass', '-Command', PROBE_RS_PS_COMMAND], creationflags=subprocess.CREATE_NEW_CONSOLE)
        process.wait()

        return os.path.exists(instance_contents['probers_path'])
    except:
        return False

class StepCard(QWidget):
    def __init__(self, title, subtitle, inst_callback, uninst_callback, icon_path=None, installed=False, vs_tools_needed=False):
        super().__init__()
        self.title = title
        self.inst_callback = inst_callback
        self.uninst_callback = uninst_callback

        layout = QHBoxLayout()
        layout.setSpacing(20)

        # --- ICON ---
        if icon_path:
            image = QPixmap(icon_path)
            icon_label = QLabel()
            icon_label.setPixmap(
                image.scaled(150, 65, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
            )
            icon_label.setContentsMargins(75, 0, 0, 0)
            layout.addWidget(icon_label)
        else:
            layout.addSpacing(48)

        # --- TEXT COLUMN ---
        text_col = QVBoxLayout()

        title_lbl = QLabel(title)
        title_lbl.setStyleSheet("font-size: 17px; font-weight: bold;")

        subtitle_lbl = QLabel(subtitle)
        subtitle_lbl.setWordWrap(True)
        subtitle_lbl.setStyleSheet("font-size: 13px; color: #D0D0E0;")

        text_col.addWidget(title_lbl)
        text_col.addWidget(subtitle_lbl)
        layout.addLayout(text_col)

        # --- BUTTON ---
        self.btn = QPushButton('Install')
        self.btn.setMinimumWidth(160)
        self.btn.clicked.connect(self.run_install)
        layout.addWidget(self.btn)

        self.btn_uninst = QPushButton('Uninstall')
        self.btn_uninst.setEnabled(False)
        self.btn_uninst.setMinimumWidth(160)
        self.btn_uninst.clicked.connect(self.run_uninstall)
        layout.addWidget(self.btn_uninst)


        self.setLayout(layout)

        if 'Rust' in title or 'Probe-rs' in title:
            if vs_tools_needed:
                self.set_state_vs_tools_required()

        # Apply installed state if needed
        if installed:
            self.set_state_installed()
        else:
            self.set_state_uninstalled()

    def run_install(self):
        # Call user-provided install function
        pack_exists = self.inst_callback()

        # If callback reports success → disable & greenify button
        if pack_exists:
            self.set_state_installed()

    def run_uninstall(self):
        # Call user-provided install function
        pack_exists = self.uninst_callback()

        # If callback reports success → disable & greenify button
        if not pack_exists:
            self.set_state_uninstalled()

    def set_state_installed(self):
        self.btn.setEnabled(False)
        self.btn.setText("Installed")
        self.btn.setStyleSheet(
            """
            QPushButton {
                background-color: #5DB95D;
                border-radius: 10px;
                font-weight: normal;
            }
            """
        )
        if 'ST-Link' not in self.title:
            self.btn_uninst.setEnabled(True)
            self.btn_uninst.setText("Uninstall")
            self.btn_uninst.setStyleSheet(
                """
                QPushButton {
                    background-color: #E06666;
                    border-radius: 10px;
                    font-weight: bold;
                }
                QPushButton:hover {
                    background-color: #437D00;
                }

                QPushButton:pressed {
                    background-color: #1E5D00;
                }
                """
            )

    def set_state_uninstalled(self):
        self.btn.setEnabled(True)
        self.btn.setText("Install")
        self.btn.setStyleSheet(
            """
            QPushButton {
                background-color: #2D73FF;
                border-radius: 10px;
                font-weight: bold;
            }
            QPushButton:hover {
                background-color: #437D00;
            }

            QPushButton:pressed {
                background-color: #1E5D00;
            }
            """
        )
        self.btn_uninst.setEnabled(False)
        self.btn_uninst.setText("Uninstall")
        self.btn_uninst.setStyleSheet(
            """
            QPushButton {
                background-color: #999999;
                border-radius: 10px;
                font-weight: normal;
            }
            """
        )

    def set_state_vs_tools_required(self):
        self.btn.setEnabled(False)
        self.btn.setText("Install MSVC Tools")
        self.btn.setStyleSheet(
            """
            QPushButton {
                background-color: #999999;
                border-radius: 10px;
                font-weight: normal;
            }
            """
        )

    def refresh_rust_buttons(self, instance_contents):
        title = self.windowTitle() if hasattr(self, 'windowTitle') else ""

        if dots.len() == 0:
            dots = '.'
        elif dots.len() == 1:
            dots = '..'
        elif dots.len() == 2:
            dots = '...'
        else:
            dots = ''

        if 'MSVC' in self.title:
            self.btn.setEnabled(False)
            self.btn.setText(f'Installing{dots}')
            self.btn.setStyleSheet(
                """
                QPushButton {
                    background-color: #F1C232;
                    border-radius: 10px;
                    font-weight: bold;
                }
                """
            )
            QApplication.processEvents()

        if 'Rust' in self.title or 'Probe-rs' in self.title:
            # These are blocked unless MSVC is installed
            if os.path.exists(instance_contents['vs_tools_path']):
                # MSVC installed → enable normal button
                self.btn.setEnabled(True)
                self.btn.setText('Install')
                self.btn.setStyleSheet('')

class InstallerWindow(QMainWindow):
    def __init__(self, instance_contents):
        super().__init__()
        self.step_cards = []

        self.setStyleSheet('''
            QWidget {
                background: qlineargradient(
                    spread:pad, x1:0, y1:0, x2:1, y2:1,
                    stop:0 #0F1C3F, stop:1 #1B2A5A
                );
                color: white;
                font-family: Arial;
            }

            .card {
                background: rgba(255,255,255,0.08);
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 16px;
                padding: 16px;
            }

            QPushButton {
                background-color: #999999;
                color: white;
                border: none;
                border-radius: 12px;
                padding: 10px 18px;
                font-size: 15px;
            }

            QPushButton:hover {
                background-color: #437D00;
            }

            QPushButton:pressed {
                background-color: #1E5D00;
            }
        ''')

        self.setWindowTitle('Rust Toolchain Installer')
        self.resize(1300, 800)

        # Modern style applied
        self.apply_styles()

        scroll = QScrollArea()
        container = QWidget()
        layout = QVBoxLayout()
        layout.setSpacing(20)
        layout.setContentsMargins(20, 20, 20, 20)

        # Add a header image / sprite if you want
        header = QLabel()
        header.setText("Please install all the packages below so you can work with Rust applications!")
        header.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(header)

        # INSTALLATION STEPS AS CARDS
        card = StepCard(
            title       = 'Install MSVC Build Tools',
            subtitle    = 'C++ Build Tools are required.',
            inst_callback   = lambda: download_and_run(VS_TOOLS_URL, 'vs_BuildTools.exe', instance_contents, refresh_all=self.refresh_all),
            uninst_callback = lambda: download_and_uninstall(VS_TOOLS_URL, 'vs_BuildTools.exe', instance_contents, refresh_all=self.refresh_all),
            icon_path   = os.path.join(os.path.dirname(__file__), 'sprites/msvc.png'),
            installed   = os.path.exists(instance_contents['vs_tools_path'])
        )
        self.step_cards.append(card)
        layout.addWidget(card)

        card = StepCard(
            title       = 'Install Rust Toolchain',
            subtitle    = 'Installs rustup and Rust compiler.',
            inst_callback   = lambda: download_and_run(RUST_URL, 'rustup-init.exe', instance_contents),
            uninst_callback = lambda: remove_directory(instance_contents['rustup_path']),
            icon_path   = os.path.join(os.path.dirname(__file__), 'sprites/rust.png'),
            installed   = os.path.exists(instance_contents['rustup_path']),
            vs_tools_needed = not os.path.exists(instance_contents['vs_tools_path'])
        )
        self.step_cards.append(card)
        layout.addWidget(card)

        card = StepCard(
            title       = 'Install ST-Link Drivers',
            subtitle    = 'Required for debugging STM32 MCUs.',
            inst_callback   = lambda: install_stlink(instance_contents),
            uninst_callback = lambda: remove_directory(instance_contents['stlink_path']),
            icon_path   = os.path.join(os.path.dirname(__file__), 'sprites/stlink.png'),
            installed   = file_exists_containing(os.path.dirname(instance_contents['stlink_path']), instance_contents['stlink_path'].split('/')[-1])
        )
        self.step_cards.append(card)
        layout.addWidget(card)

        card = StepCard(
            title       = 'Install Probe-rs Dependencies',
            subtitle    = 'Executes the PowerShell command automatically.',
            inst_callback   = lambda: install_probers(instance_contents),
            uninst_callback = lambda: remove_directory(instance_contents['probers_path']),
            icon_path   = os.path.join(os.path.dirname(__file__), 'sprites/cargo.png'),
            installed   = os.path.exists(instance_contents['probers_path']),
            vs_tools_needed = not os.path.exists(instance_contents['vs_tools_path'])
        )
        self.step_cards.append(card)
        layout.addWidget(card)

        card = StepCard(
            title       = 'Install OpenOCD Runner',
            subtitle    = 'Provides debugger backend.',
            inst_callback   = lambda: install_openocd_runner(instance_contents),
            uninst_callback = lambda: remove_directory(instance_contents['openocd_path']),
            icon_path   = os.path.join(os.path.dirname(__file__), 'sprites/openocd.png'),
            installed   = os.path.exists(instance_contents['openocd_path']),
        )
        self.step_cards.append(card)
        layout.addWidget(card)

        card = StepCard(
            title       = 'Install ARM GCC Toolchain',
            subtitle    = 'ARM none-eabi compiler.',
            inst_callback   = lambda: install_arm_runner(instance_contents),
            uninst_callback = lambda: remove_directory(instance_contents['gcc_path']),
            icon_path   = os.path.join(os.path.dirname(__file__), 'sprites/arm.png'),
            installed   = os.path.exists(instance_contents['gcc_path']),
        )
        self.step_cards.append(card)
        layout.addWidget(card)

        card = StepCard(
            title       = 'Install SEGGER J-Link programmer',
            subtitle    = 'Provides connection backend.',
            inst_callback   = lambda: download_and_run(SEGGER_URL, 'jlink.exe', instance_contents),
            uninst_callback = lambda: run_uninstall(instance_contents['jlink_path']),
            icon_path   = os.path.join(os.path.dirname(__file__), 'sprites/segger.png'),
            installed   = os.path.exists(instance_contents['jlink_path']),
        )
        self.step_cards.append(card)
        layout.addWidget(card)

        layout.addStretch()
        container.setLayout(layout)
        scroll.setWidget(container)
        scroll.setWidgetResizable(True)
        self.setCentralWidget(scroll)

    def apply_styles(self):
        self.setStyleSheet('''
            QWidget {
                background: qlineargradient(
                    spread:pad, x1:0, y1:0, x2:1, y2:1,
                    stop:0 #0F1C3F, stop:1 #1B2A5A
                );
                color: white;
                font-family: Arial;
            }

            #card {
                background: rgba(255,255,255,0.08);
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 16px;
                padding: 16px;
            }

            QPushButton {
                background-color: #2D73FF;
                color: white;
                border: none;
                border-radius: 12px;
                padding: 10px 18px;
                font-size: 15px;
            }
            QPushButton:hover { background-color: #437DFF; }
            QPushButton:pressed { background-color: #1E5DE3; }
        ''')

    def refresh_all(self, instance_contents):
        for card in self.step_cards:
            card.refresh_rust_buttons(instance_contents)
