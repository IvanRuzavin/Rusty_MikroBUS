# MikroBUS Rust Tools

MikroBUS Rust Tools brings embedded Rust project setup, hardware configuration, tool management, programming, and debugging into VS Code.

The extension is designed around reusable MCU and board configurations. Configure the hardware once, apply that setup to a Rust project, and use the same environment for building, programming, debugging, and flash erase operations.

## What you can do

- **Configure MCUs and development boards** from the MikroBUS Rust database.
- **Create reusable hardware setups** with clock configuration, target settings, board information, shields, and programmer selection.
- Use **SEGGER J-Link** or **MIKROE CODEGRIP** according to the programmer support defined for the selected target.
- **Detect a connected USB CODEGRIP** directly from the setup configuration and store that connection with the reusable setup.
- **Apply a saved setup to an existing Rust project** without copying the complete SDK into the project.
- Automatically configure **Rust Analyzer** for the selected target and reusable SDK workspace.
- Generate `mikrobus.rs` automatically when a board setup uses a supported mikroBUS shield.
- **Build, program, debug, and erase** the configured MCU directly from VS Code.
- Install, update, detect, and manage the tools and packages required by the development workflow from one **Development Environment** view.

## Development Environment

Open **MikroBUS Rust: Development Environment** to check the tools and packages required by the extension.

The extension manages its own copies of the project-specific packages, including:

- MikroBUS Rust database
- Board Support Package
- Rust mikroSDK
- MCU core package
- MIKROE CODEGRIP package and MCU packs
- OpenOCD
- ARM GNU Toolchain

Host tools and system requirements such as Rust, Cargo, probe-rs, SEGGER J-Link, USB access rules, drivers, and build prerequisites are detected separately. When installation can be automated safely, the Development Environment provides the corresponding action; otherwise it opens or describes the appropriate system installation path.

By default, managed packages are stored in the extension's VS Code global storage. A different location can be selected with the `mikrobusRust.storageRoot` setting.

> Managed CODEGRIP package installation is currently intended for Linux x64. Existing CODEGRIP installations can also be used by configuring the server and packs paths in VS Code settings.

## Basic workflow

1. Install the extension and reload VS Code.
2. Open **MikroBUS Rust** from the Activity Bar.
3. Open **Development Environment** and install or resolve the required tools and packages.
4. Open a Rust project with `Cargo.toml` in the project root.
5. Choose **Configure MCU or Board**.
6. Select the target hardware and configure its clock and target options.
7. Select a supported programmer:
   - **SEGGER J-Link**, or
   - **MIKROE CODEGRIP**.
8. When using CODEGRIP, choose **Find USB CODEGRIP** and select the connected device.
9. Build the configuration and save it as a reusable setup.
10. From **Configured Setups**, choose **Apply to project**.
11. Open the Rust source you want to run and use the editor actions to build, program, debug, or erase the device.

## Applying a setup to a project

Applying a setup keeps the SDK outside your project and creates only the project integration required by VS Code.

The extension:

- creates `.vscode/mikrobus-rust.json` to bind the project to the selected reusable setup;
- updates `.vscode/settings.json` so Rust Analyzer uses the generated SDK workspace and compilation target;
- generates `mikrobus.rs` when the selected board uses a supported mikroBUS shield;
- reuses the generated MCU setup for future build, program, and debug operations.

Your project must contain `Cargo.toml` directly in its root before a setup can be applied.

## Programming and debugging

### SEGGER J-Link

J-Link setups use the Rust embedded tooling flow provided by probe-rs for programming, erase, and debugging. The extension prepares the correct target configuration and launches the debug session from VS Code.

### MIKROE CODEGRIP

CODEGRIP setups use `CodegripGdbServer` and the matching MCU packs. The extension can discover the attached USB CODEGRIP, preserve its connection information with the setup, program the generated application, erase the target, and start a GDB debug session through Cortex-Debug.

## Editor actions

When a configured setup is applied to the current project, Rust files expose quick actions for:

- **Build**
- **Build & Flash**
- **Debug**
- **Erase**

The current Rust source can be used as the application entry point without requiring the complete SDK tree to be stored inside the project.

## Installation

Install the packaged `.vsix` from VS Code:

1. Open **Extensions**.
2. Open the Extensions menu.
3. Choose **Install from VSIX...**.
4. Select the MikroBUS Rust Tools `.vsix` file.
5. Reload VS Code when prompted.
6. Open **MikroBUS Rust → Development Environment** and resolve any missing tools or packages.

Cortex-Debug is used for CODEGRIP GDB debugging and is declared as an extension dependency.

## More information

For more details, visit https://github.com/IvanRuzavin/Rusty_MikroBUS
