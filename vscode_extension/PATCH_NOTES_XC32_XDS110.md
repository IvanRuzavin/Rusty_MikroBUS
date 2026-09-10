# XC32 hardware-debug + TI XDS110 candidate patch

## Microchip XC32

The extension's Microchip debug flow currently performs two MPLAB sessions:

1. Program the final HEX (`noDebug: true`). This is currently required because the XC32 configuration-word object is intentionally not linked into the application ELF; its configuration bytes are merged into the HEX after linking.
2. Start a real MPLAB debug launch using the ELF.

The candidate patch keeps that flow, but changes the build used by Microchip XC32 hardware debug so that both compilation and linking receive `-mdebugger` via `MIKROBUS_HARDWARE_DEBUG=TRUE`.

This is intentionally enabled only for the Debug command with a Microchip programmer + XC32. Ordinary builds/flashing and CODEGRIP paths are unchanged.

### If `TARGET_NOT_IN_DEBUG_MODE` remains

Inspect these next:

- the generated `xc_config_words.c`, especially `ICESEL` and oscillator/PLL configuration;
- the physical PGEC/PGED pair used by the board/programmer;
- the final custom XC32 linker script and link map, especially whether the debug executive reservation sections/memory are preserved (`.dbg_excpt`, `.dbg_code`, `.dbg_data`, `debug_exec_mem`).

Because the project uses an explicit custom XC32 linker script, `-mdebugger` is the first required fix but may not be sufficient if that script replaced the normal XC32 debug reservations.

## TI MSPM0 + onboard XDS110

Adds a synthetic programmer named:

`TI XDS110 (LaunchPad onboard)`

for MSPM0 devices.

The backend uses TI Embedded Debug's bundled OpenOCD/GDB and Cortex-Debug with:

- `interface/xds110.cfg`
- `board/ti_mspm0_launchpad.cfg`

Programming uses OpenOCD's `program <ELF> verify reset exit` helper.

Erasing uses `flash erase_sector 0 0 last` rather than `mspm0_mass_erase`, because OpenOCD explicitly does not support `mspm0_mass_erase` on MSPM0C devices.

Debug launches Cortex-Debug with TI OpenOCD and the MCU name as `deviceName`.

### Host prerequisite

Install `ti-development-tools.ti-embedded-debug` and run its **Install Dependencies** action. On Linux, install the TI udev rules as described by the TI extension.

## Validation performed

- `npm run check` — PASS
- `npm test` — PASS (`C support tests passed.`)

The changes have not been hardware-tested in this environment. Test the XC32 path on the PIC32MZ/PICkit 5 and the XDS110 path on at least one MSPM0 LaunchPad before merging.


## Follow-up: MSPM0 reset + Linux build tools

- XDS110 Flash now performs `program <ELF> verify`, then calls `mspm0_board_reset`, then `shutdown`. This gives MSPM0 LaunchPads an explicit nRST toggle after programming.
- Added official Ninja 1.12.1 managed packages for Linux x64 (`ninja-linux.zip`) and Linux arm64 (`ninja-linux-aarch64.zip`).
- Linux now includes managed CMake/Ninja in the C Development Environment package set, matching Windows/macOS behavior and fixing clean VS Code installations that do not already have Ninja on PATH.
