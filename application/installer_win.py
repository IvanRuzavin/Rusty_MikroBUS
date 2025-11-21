import subprocess, urllib.request, os, json

from PyQt6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QLabel,
    QMainWindow,
    QScrollArea,
    QMessageBox,
    QHBoxLayout,
    QPushButton
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
PROBE_RS_PS_COMMAND = (
    'irm https://github.com/probe-rs/probe-rs/releases/download/v0.27.0/probe-rs-tools-installer.ps1 | iex'
)

# Helper Functions
def update_instance_uid(instance_contents):
    with open(os.path.join(os.path.dirname(__file__), 'instance_uid.json'), 'w') as application_instance:
        json.dump(instance_contents, application_instance, indent = 4)

def download_and_run(url: str, filename: str, instance_contents):
    try:
        save_path = os.path.join(INSTALLER_DIR, filename)

        # Download file
        urllib.request.urlretrieve(url, save_path)

        # Run the installer
        if 'rustup' in url:
            process = subprocess.Popen(['powershell.exe', '-ExecutionPolicy', 'Bypass', '-Command', '&', save_path], creationflags=subprocess.CREATE_NEW_CONSOLE)
            instance_contents['installer']['rust'] = 'installed'
        else:
            process = subprocess.Popen([save_path], shell=True)
            instance_contents['installer']['msvc'] = 'installed'
        process.wait
        update_instance_uid(instance_contents)

        return True
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
        instance_contents['installer']['stlink'] = 'installed'
        update_instance_uid(instance_contents)

        return True
    except:
        return False

def install_openocd_runner(instance_contents):
    try:
        download_extract_to(OPENOCD_URL, RUNNER_DIR)
        instance_contents['installer']['openocd'] = 'installed'
        update_instance_uid(instance_contents)

        return True
    except:
        return False

def install_arm_runner(instance_contents):
    try:
        download_extract_to(ARM_NONE_EABI_URL, RUNNER_DIR)
        instance_contents['installer']['gcc'] = 'installed'
        update_instance_uid(instance_contents)

        return True
    except:
        return False

def install_probers(instance_contents):
    try:
        process = subprocess.Popen(['powershell.exe', '-ExecutionPolicy', 'Bypass', '-Command', PROBE_RS_PS_COMMAND], creationflags=subprocess.CREATE_NEW_CONSOLE)
        process.wait()
        instance_contents['installer']['probers'] = 'installed'
        update_instance_uid(instance_contents)

        return True
    except:
        return False

class StepCard(QWidget):
    def __init__(self, title, subtitle, button_text, callback, icon_path=None, installed=False):
        super().__init__()
        self.callback = callback

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
        self.btn = QPushButton(button_text)
        self.btn.setMinimumWidth(160)
        self.btn.clicked.connect(self.run_install)

        layout.addWidget(self.btn, alignment=Qt.AlignmentFlag.AlignRight)

        self.setLayout(layout)

        # Apply installed state if needed
        if installed:
            self.set_installed_state()

    def run_install(self):
        # Call user-provided install function
        success = self.callback()

        # If callback reports success → disable & greenify button
        if success:
            self.set_installed_state()

    def set_installed_state(self):
        self.btn.setEnabled(False)
        self.btn.setText("Installed")
        self.btn.setStyleSheet(
            """
            QPushButton {
                background-color: #7DFF7D;
                border-radius: 10px;
                font-weight: bold;
            }
            """
        )

class InstallerWindow(QMainWindow):
    def __init__(self, instance_contents):
        super().__init__()

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
                background-color: #2D73FF;
                color: white;
                border: none;
                border-radius: 12px;
                padding: 10px 18px;
                font-size: 15px;
            }

            QPushButton:hover {
                background-color: #437DFF;
            }

            QPushButton:pressed {
                background-color: #1E5DE3;
            }
        ''')

        if 'installer' not in instance_contents:
            instance_contents['installer'] = {
                'msvc': 'not_installed',
                'rust': 'not_installed',
                'stlink': 'not_installed',
                'probers': 'not_installed',
                'openocd': 'not_installed',
                'gcc': 'not_installed'
            }

        if os.path.exists(os.path.join(os.path.dirname(__file__), 'runner/xpack-arm-none-eabi-gcc-14.2.1-1.1')):
            instance_contents['installer']['gcc'] = 'installed'
        if os.path.exists(os.path.join(os.path.dirname(__file__), 'runner/xpack-openocd-0.12.0-7')):
            instance_contents['installer']['openocd'] = 'installed'
        update_instance_uid(instance_contents)

        self.setWindowTitle('Rust Toolchain Installer')
        self.resize(1000, 700)

        # Modern style applied
        self.apply_styles()

        scroll = QScrollArea()
        container = QWidget()
        layout = QVBoxLayout()
        layout.setSpacing(20)
        layout.setContentsMargins(20, 20, 20, 20)

        # Add a header image / sprite if you want
        header = QLabel()
        header.setText("Please install all the packages below to proceed!")
        header.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(header)

        # INSTALLATION STEPS AS CARDS
        layout.addWidget(StepCard(
            title='Install MSVC Build Tools',
            subtitle='Required for compiling Rust on Windows.',
            button_text='Install',
            callback=lambda: download_and_run(VS_TOOLS_URL, 'vs_BuildTools.exe', instance_contents),
            icon_path=os.path.join(os.path.dirname(__file__), 'sprites/msvc.png'),
            installed = instance_contents['installer']['msvc'] == 'installed'
        ))

        layout.addWidget(StepCard(
            title='Install Rust Toolchain',
            subtitle='Installs rustup and Rust compiler.',
            button_text='Install',
            callback=lambda: download_and_run(RUST_URL, 'rustup-init.exe', instance_contents),
            icon_path=os.path.join(os.path.dirname(__file__), 'sprites/rust.png'),
            installed = instance_contents['installer']['rust'] == 'installed'
        ))

        layout.addWidget(StepCard(
            title='Install ST-Link Drivers',
            subtitle='Required for debugging STM32 MCUs.',
            button_text='Install',
            callback=lambda: install_stlink(instance_contents),
            icon_path=os.path.join(os.path.dirname(__file__), 'sprites/stlink.png'),
            installed = instance_contents['installer']['stlink'] == 'installed'
        ))

        layout.addWidget(StepCard(
            title='Install Probe-rs Dependencies',
            subtitle='Executes the PowerShell command automatically.',
            button_text='Run',
            callback=lambda: install_probers(instance_contents),
            icon_path=os.path.join(os.path.dirname(__file__), 'sprites/powershell.png'),
            installed = instance_contents['installer']['probers'] == 'installed'
        ))

        layout.addWidget(StepCard(
            title='Install OpenOCD Runner',
            subtitle='Provides debugger backend.',
            button_text='Install',
            callback=lambda: install_openocd_runner(instance_contents),
            icon_path=os.path.join(os.path.dirname(__file__), 'sprites/openocd.png'),
            installed = instance_contents['installer']['openocd'] == 'installed'
        ))

        layout.addWidget(StepCard(
            title='Install ARM GCC Toolchain',
            subtitle='ARM none-eabi compiler.',
            button_text='Install',
            callback=lambda: install_arm_runner(instance_contents),
            icon_path=os.path.join(os.path.dirname(__file__), 'sprites/arm.png'),
            installed = instance_contents['installer']['gcc'] == 'installed'
        ))

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
