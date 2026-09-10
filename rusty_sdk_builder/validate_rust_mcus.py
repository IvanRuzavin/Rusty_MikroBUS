#!/usr/bin/env python3
"""
validate_rust_mcus.py

Standalone bulk validator for the Rust MikroBUS environment.

Required positional arguments:
    1) Rust SDK path
    2) Rust core path
    3) MCU list (a file path, or a comma-separated list)

The Rust database is intentionally NOT a required CLI argument. It is
auto-discovered from the same managed layout used by the VS Code extension:

    <managed-root>/sdk
    <managed-root>/core
    <managed-root>/database/database_mikro_sdk_rust.db

If your database lives elsewhere, set:
    MIKROBUS_RUST_DATABASE=/path/to/database_mikro_sdk_rust.db

Per MCU the validator:
    1. Always validates the direct/bare MCU setup.
    2. Resolves the MCU/family metadata and MCU JSON.
    3. Generates the same .setup/core and .setup/sdk structure used by the
       VS Code extension.
    4. Runs Cargo setup validation and a real blank-project build/link.
    5. Searches every enabled MCUCard.CONFIG_JSON for the MCU.
    6. For every matching MCU card, discovers every enabled BoardToCard board.
    7. Treats every discovered Board + MCU-card combination as a mandatory
       additional build check, validating CardToMCU consistency, board/card BSP
       merge, selection.json, and generated mikrobus.rs when the board exposes
       a resolvable mikroBUS mapping.
    8. Deletes the generated setup and target overlay after every individual
       direct or board/card check before moving to the next configuration.
    9. Continues after failures and writes CSV/JSON/per-configuration logs.

The database and BSP package remain auto-discovered so the command line still
has only the three requested positional arguments. For non-standard layouts:
    MIKROBUS_RUST_DATABASE=/path/to/database_mikro_sdk_rust.db
    MIKROBUS_RUST_BSP=/path/to/bsp

No third-party Python packages are required.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import tomllib
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


SCRIPT_VERSION = "1.1.0"
BLANK_BIN_NAME = "mikrobus_validation_blank"
SETUP_STAGING_NAME = ".setup.__mikrobus_staging"

# One Cargo target directory is intentionally shared by all MCU validations in
# this single invocation. Cargo fingerprints changed generated sources, while
# retaining downloaded crates and unchanged compilation artifacts. The entire
# temporary workspace is deleted when the script exits.
CARGO_TARGET_DIR_NAME = ".bulk-validation-target"

# Optional environment controls. These do not add required CLI arguments.
ENV_DATABASE = "MIKROBUS_RUST_DATABASE"
ENV_BSP = "MIKROBUS_RUST_BSP"
ENV_CARGO = "MIKROBUS_RUST_CARGO"
ENV_RUSTUP = "MIKROBUS_RUST_RUSTUP"
ENV_TIMEOUT = "MIKROBUS_RUST_BUILD_TIMEOUT"
ENV_KEEP_TEMP = "MIKROBUS_RUST_KEEP_TEMP"


class ValidationError(RuntimeError):
    pass


@dataclass
class McuMetadata:
    name: str
    family: str
    vendor: str
    target: str
    system_lib: str
    gpio: str
    adc: str
    i2c: str
    spi: str
    tim: str
    uart: str
    one_wire: str


@dataclass
class BoardCardCombination:
    board_uid: str
    board_name: str
    board_bsp_path: str
    card_uid: str
    card_name: str
    card_bsp_path: str
    card_config_json: str
    card_to_mcu_present: bool


@dataclass
class ValidationResult:
    mcu: str
    configuration_type: str = "mcu"
    configuration: str = "Direct MCU"
    board_uid: str = ""
    board_name: str = ""
    card_uid: str = ""
    card_name: str = ""
    vendor: str = ""
    family: str = ""
    target: str = ""
    clock_mhz: int | None = None
    setup_generated: bool = False
    mikrobus_generated: bool = False
    setup_check: bool = False
    blank_build: bool = False
    status: str = "FAILED"
    failed_stage: str = ""
    error: str = ""
    elapsed_seconds: float = 0.0
    log_file: str = ""


class Logger:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._file = path.open("w", encoding="utf-8", errors="replace")

    def close(self) -> None:
        self._file.close()

    def write(self, text: str = "") -> None:
        self._file.write(text + "\n")
        self._file.flush()

    def section(self, title: str) -> None:
        self.write()
        self.write("=" * 78)
        self.write(title)
        self.write("=" * 78)

    def command(self, args: list[str], cwd: Path) -> None:
        quoted = " ".join(shell_display(arg) for arg in args)
        self.write(f"$ (cd {cwd}) {quoted}")


def shell_display(value: str) -> str:
    if not value:
        return "''"
    if re.fullmatch(r"[A-Za-z0-9_./:=+,@%-]+", value):
        return value
    return "'" + value.replace("'", "'\"'\"'") + "'"


def safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._") or "mcu"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate and build every requested Rust MCU setup using the same "
            "core/SDK contract as the MikroBUS VS Code extension."
        )
    )
    parser.add_argument("sdk", help="Path to the extracted Rust SDK directory.")
    parser.add_argument("core", help="Path to the extracted Rust core directory.")
    parser.add_argument(
        "mcus",
        help=(
            "Path to MCU list (.txt/.csv/.json), or a comma-separated MCU list. "
            "Text files may contain one MCU per line."
        ),
    )
    return parser.parse_args()


def require_directory(value: str, label: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise ValidationError(f"{label} directory does not exist: {path}")
    return path


def resolve_executable(env_name: str, default: str) -> str:
    configured = os.environ.get(env_name, "").strip()
    executable = configured or default

    # Explicit paths are validated here; PATH-resolved commands are checked by
    # shutil.which.
    candidate = Path(executable).expanduser()
    if candidate.parent != Path(".") or candidate.is_absolute():
        candidate = candidate.resolve()
        if not candidate.is_file():
            raise ValidationError(f"{env_name} points to a missing executable: {candidate}")
        return str(candidate)

    resolved = shutil.which(executable)
    if not resolved:
        raise ValidationError(
            f"Required executable '{executable}' was not found in PATH. "
            f"Set {env_name} if it is installed elsewhere."
        )
    return resolved


def discover_database(sdk_root: Path, core_root: Path) -> Path:
    env_value = os.environ.get(ENV_DATABASE, "").strip()
    candidates: list[Path] = []

    if env_value:
        candidates.append(Path(env_value).expanduser())

    candidates.extend(
        [
            sdk_root / "database_mikro_sdk_rust.db",
            sdk_root.parent / "database" / "database_mikro_sdk_rust.db",
            sdk_root.parent / "database_mikro_sdk_rust.db",
            core_root.parent / "database" / "database_mikro_sdk_rust.db",
            core_root.parent / "database_mikro_sdk_rust.db",
            Path.cwd() / "database_mikro_sdk_rust.db",
        ]
    )

    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if resolved.is_file():
            return resolved

    rendered = "\n".join(f"  - {candidate.resolve()}" for candidate in candidates)
    raise ValidationError(
        "Rust MCU database was not found. The script keeps the CLI to the three "
        "requested arguments by auto-discovering the database.\n"
        "Expected the VS Code managed layout or set "
        f"{ENV_DATABASE}.\nChecked:\n{rendered}"
    )


def discover_bsp_root(sdk_root: Path, core_root: Path) -> Path:
    """Find the independently managed BSP package without adding a CLI arg."""
    env_value = os.environ.get(ENV_BSP, "").strip()
    candidates: list[Path] = []

    if env_value:
        candidates.append(Path(env_value).expanduser())

    candidates.extend(
        [
            sdk_root / "bsp",
            sdk_root.parent / "bsp",
            core_root.parent / "bsp",
            Path.cwd() / "bsp",
        ]
    )

    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if resolved.is_dir():
            return resolved

    rendered = "\n".join(f"  - {candidate.resolve()}" for candidate in candidates)
    raise ValidationError(
        "A requested MCU is used by at least one MCU card, so board+card "
        "validation is mandatory, but the managed BSP package was not found.\n"
        "Expected the VS Code managed layout or set "
        f"{ENV_BSP}=/path/to/bsp.\nChecked:\n{rendered}"
    )


def card_config_mcus(config_json: str) -> set[str]:
    """Return MCU names declared by MCUCard.CONFIG_JSON."""
    try:
        data = json.loads(config_json or "{}")
    except json.JSONDecodeError as exc:
        raise ValidationError(f"Invalid MCUCard.CONFIG_JSON: {exc}") from exc

    if not isinstance(data, dict):
        return set()

    values: list[str] = []
    single = data.get("hardwareDevice")
    if isinstance(single, str) and single.strip():
        values.append(single.strip())

    multiple = data.get("hardwareDevices")
    if isinstance(multiple, list):
        values.extend(str(item).strip() for item in multiple if str(item).strip())

    return {value.casefold() for value in values}


def read_board_card_combinations(database: Path, mcu: str) -> tuple[list[BoardCardCombination], list[str]]:
    """
    Discover board+card checks from MCUCard.CONFIG_JSON.

    CONFIG_JSON is deliberately the trigger, as requested.  CardToMCU is then
    validated separately because the VS Code extension resolves an actual board
    setup through BoardToCard -> CardToMCU.

    Returns:
        combinations
        matching card names that currently have no enabled BoardToCard board
    """
    target = mcu.casefold()
    combinations: list[BoardCardCombination] = []
    cards_without_boards: list[str] = []

    with sqlite3.connect(database) as db:
        db.row_factory = sqlite3.Row
        cards = db.execute(
            """
            SELECT UID, NAME, BSP_PATH, CONFIG_JSON
            FROM MCUCard
            WHERE ENABLED = 1
            ORDER BY NAME COLLATE NOCASE, UID
            """
        ).fetchall()

        for card in cards:
            if target not in card_config_mcus(str(card["CONFIG_JSON"] or "{}")):
                continue

            card_uid = str(card["UID"])
            relation = db.execute(
                """
                SELECT 1
                FROM CardToMCU
                WHERE CARD_UID = ? AND lower(DEVICE_NAME) = lower(?)
                LIMIT 1
                """,
                (card_uid, mcu),
            ).fetchone()
            card_to_mcu_present = relation is not None

            boards = db.execute(
                """
                SELECT Board.UID, Board.NAME, Board.BSP_PATH
                FROM BoardToCard
                JOIN Board ON Board.UID = BoardToCard.BOARD_UID
                WHERE BoardToCard.CARD_UID = ? AND Board.ENABLED = 1
                ORDER BY Board.NAME COLLATE NOCASE, Board.UID
                """,
                (card_uid,),
            ).fetchall()

            if not boards:
                cards_without_boards.append(str(card["NAME"]))
                continue

            for board in boards:
                combinations.append(
                    BoardCardCombination(
                        board_uid=str(board["UID"]),
                        board_name=str(board["NAME"]),
                        board_bsp_path=str(board["BSP_PATH"]),
                        card_uid=card_uid,
                        card_name=str(card["NAME"]),
                        card_bsp_path=str(card["BSP_PATH"]),
                        card_config_json=str(card["CONFIG_JSON"] or "{}"),
                        card_to_mcu_present=card_to_mcu_present,
                    )
                )

    return combinations, cards_without_boards


def load_mcu_list(spec: str) -> list[str]:
    candidate = Path(spec).expanduser()
    values: list[str]

    if candidate.is_file():
        suffix = candidate.suffix.lower()
        if suffix == ".json":
            data = json.loads(candidate.read_text(encoding="utf-8"))
            if isinstance(data, list):
                values = [str(item) for item in data]
            elif isinstance(data, dict) and isinstance(data.get("mcus"), list):
                values = [str(item) for item in data["mcus"]]
            else:
                raise ValidationError(
                    f"JSON MCU list must be an array or {{\"mcus\": [...]}}: {candidate}"
                )
        elif suffix == ".csv":
            rows = list(csv.reader(candidate.read_text(encoding="utf-8").splitlines()))
            values = []
            for row_index, row in enumerate(rows):
                if not row:
                    continue
                value = row[0].strip()
                if row_index == 0 and value.lower() in {"mcu", "mcu_name", "name", "device"}:
                    continue
                if value:
                    values.append(value)
        else:
            values = []
            for raw in candidate.read_text(encoding="utf-8").splitlines():
                line = raw.split("#", 1)[0].strip()
                if not line:
                    continue
                # Also accept comma-separated values in a text file.
                values.extend(part.strip() for part in line.split(",") if part.strip())
    else:
        values = [part.strip() for part in spec.split(",") if part.strip()]

    # Stable de-duplication while preserving requested order.
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        mcu = value.strip()
        if not mcu:
            continue
        key = mcu.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(mcu)

    if not result:
        raise ValidationError("The MCU list is empty.")
    return result


def validate_database_schema(database: Path) -> None:
    required = {
        "MCU": {"NAME", "FAMILY", "SYSTEM_LIB"},
        "FAMILY": {
            "NAME",
            "VENDOR",
            "TARGET",
            "PATH_GPIO_PORT",
            "PATH_IMPL_ADC",
            "PATH_IMPL_I2C",
            "PATH_IMPL_SPI",
            "PATH_IMPL_TIM",
            "PATH_IMPL_UART",
        },
        "MCUCard": {"UID", "NAME", "BSP_PATH", "CONFIG_JSON", "ENABLED"},
        "CardToMCU": {"CARD_UID", "DEVICE_NAME"},
        "BoardToCard": {"BOARD_UID", "CARD_UID"},
        "Board": {"UID", "NAME", "BSP_PATH", "ENABLED"},
    }

    with sqlite3.connect(database) as db:
        for table, columns in required.items():
            existing = {
                str(row[1]).upper()
                for row in db.execute(f"PRAGMA table_info({table})").fetchall()
            }
            missing = columns - existing
            if missing:
                raise ValidationError(
                    f"{database}: table {table} is missing columns: "
                    + ", ".join(sorted(missing))
                )


def read_mcu_metadata(database: Path, mcu: str) -> McuMetadata:
    with sqlite3.connect(database) as db:
        db.row_factory = sqlite3.Row
        row = db.execute(
            """
            SELECT
                MCU.NAME AS name,
                MCU.FAMILY AS family,
                MCU.SYSTEM_LIB AS system_lib,
                FAMILY.VENDOR AS vendor,
                FAMILY.TARGET AS target,
                FAMILY.PATH_GPIO_PORT AS gpio,
                FAMILY.PATH_IMPL_ADC AS adc,
                FAMILY.PATH_IMPL_I2C AS i2c,
                FAMILY.PATH_IMPL_SPI AS spi,
                FAMILY.PATH_IMPL_TIM AS tim,
                FAMILY.PATH_IMPL_UART AS uart
            FROM MCU
            JOIN FAMILY ON MCU.FAMILY = FAMILY.NAME
            WHERE MCU.NAME = ?
            LIMIT 1
            """,
            (mcu,),
        ).fetchone()

        if row is None:
            # Friendly case-insensitive fallback, while still returning the
            # canonical database spelling.
            row = db.execute(
                """
                SELECT
                    MCU.NAME AS name,
                    MCU.FAMILY AS family,
                    MCU.SYSTEM_LIB AS system_lib,
                    FAMILY.VENDOR AS vendor,
                    FAMILY.TARGET AS target,
                    FAMILY.PATH_GPIO_PORT AS gpio,
                    FAMILY.PATH_IMPL_ADC AS adc,
                    FAMILY.PATH_IMPL_I2C AS i2c,
                    FAMILY.PATH_IMPL_SPI AS spi,
                    FAMILY.PATH_IMPL_TIM AS tim,
                    FAMILY.PATH_IMPL_UART AS uart
                FROM MCU
                JOIN FAMILY ON MCU.FAMILY = FAMILY.NAME
                WHERE lower(MCU.NAME) = lower(?)
                LIMIT 1
                """,
                (mcu,),
            ).fetchone()

        if row is None:
            raise ValidationError(f"MCU '{mcu}' is not present in {database.name}.")

        def required_value(key: str, label: str) -> str:
            value = str(row[key] or "").strip()
            if not value:
                raise ValidationError(
                    f"{mcu}: {label} is empty in the MCU/FAMILY database metadata."
                )
            return value

        return McuMetadata(
            name=str(row["name"]),
            family=required_value("family", "family"),
            vendor=required_value("vendor", "vendor"),
            target=required_value("target", "Rust compilation target"),
            system_lib=required_value("system_lib", "system library"),
            gpio=required_value("gpio", "GPIO implementation"),
            adc=required_value("adc", "ADC implementation"),
            i2c=required_value("i2c", "I2C implementation"),
            spi=required_value("spi", "SPI implementation"),
            tim=required_value("tim", "TIM implementation"),
            uart=required_value("uart", "UART implementation"),
            one_wire="implementation_1",
        )


def find_file_recursively(root: Path, file_name: str) -> Path | None:
    # os.walk is substantially cheaper than repeated recursive globbing when
    # validating thousands of MCUs.
    for current, dirs, files in os.walk(root):
        # Avoid irrelevant/build folders if a core archive happens to contain them.
        dirs[:] = [d for d in dirs if d not in {".git", "target", "__pycache__"}]
        if file_name in files and Path(current).name == "mcu_definitions":
            return Path(current) / file_name
    return None


def find_mcu_definition(core_root: Path, mcu: str) -> Path:
    # Same fast path currently used by the extension.
    stm32 = core_root / "arm" / "stm32" / "mcu_definitions" / f"{mcu}.json"
    if stm32.is_file():
        return stm32

    found = find_file_recursively(core_root, f"{mcu}.json")
    if found:
        return found
    raise ValidationError(f"MCU definition JSON not found for {mcu} under {core_root}.")


def parse_register_number(value: Any) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if not isinstance(value, str):
        return 0

    text = value.strip()
    if re.fullmatch(r"0x[0-9a-fA-F]+", text):
        return int(text[2:], 16)
    # Deliberately mirrors the extension: bare strings in MCU definitions are
    # treated as hexadecimal register values.
    if re.fullmatch(r"[0-9a-fA-F]+", text):
        return int(text, 16)
    return 0


def definition_clock_mhz(definition: dict[str, Any], mcu: str) -> int:
    raw = definition.get("clock")
    try:
        clock = int(str(raw).strip(), 10)
    except (TypeError, ValueError):
        clock = 0
    if clock <= 0:
        raise ValidationError(
            f"{mcu}.json has no positive default 'clock'. "
            "Bulk validation requires the MCU definition default clock."
        )
    return clock


def build_register_header(definition: dict[str, Any], clock_mhz: int) -> str:
    lines: list[str] = []

    for register in definition.get("config_registers", []) or []:
        reg_name = str(register.get("key", "")).strip()
        address = str(register.get("address", "")).strip()
        if not reg_name:
            continue

        register_value = 0
        for field in register.get("fields", []) or []:
            value = field.get("init")
            if value is None:
                settings = field.get("settings", []) or []
                value = settings[0].get("value", "0x0") if settings else "0x0"
            register_value |= parse_register_number(value)

        register_value &= 0xFFFFFFFF
        lines.append(
            f"pub const ADDRESS_{reg_name}: u32 = 0x{address.removeprefix('0x').removeprefix('0X')};"
        )
        lines.append(
            f"pub const VALUE_{reg_name}: u32 = 0x{register_value:08X};"
        )

    lines.append(f"pub const FOSC_KHZ_VALUE: u32 = {clock_mhz * 1000};")
    return "\n".join(lines) + "\n"


def copy_required(source: Path, destination: Path) -> None:
    if not source.is_file():
        raise ValidationError(f"Required source file not found: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def copy_directory_required(source: Path, destination: Path) -> None:
    if not source.is_dir():
        raise ValidationError(f"Required source directory not found: {source}")
    shutil.rmtree(destination, ignore_errors=True)
    shutil.copytree(source, destination)


def normalize_rust_crate_entry_point(crate_root: Path) -> Path:
    src_root = crate_root / "src"
    expected = src_root / "lib.rs"
    if expected.is_file():
        return expected
    if not src_root.is_dir():
        raise ValidationError(f"Generated Rust crate source directory is missing: {src_root}")

    for child in src_root.iterdir():
        if child.is_file() and child.name.lower() == "lib.rs":
            shutil.copy2(child, expected)
            return expected

    raise ValidationError(f"Generated Rust crate is missing src/lib.rs: {crate_root}")


def copy_sdk_layers(source_sdk: Path, destination_sdk: Path) -> None:
    """
    Create the one disposable SDK copy used by the complete validation run.

    This matches the extension's portable setup exclusions.
    """
    excluded_roots = {"target", ".setup", ".git", ".vscode"}

    def ignore(directory: str, names: list[str]) -> set[str]:
        directory_path = Path(directory)
        try:
            relative = directory_path.resolve().relative_to(source_sdk)
            depth = len(relative.parts)
        except ValueError:
            depth = 99

        ignored: set[str] = set()
        if depth == 0:
            ignored.update(name for name in names if name in excluded_roots)
            ignored.update(
                name for name in names if name.startswith(".setup.__mikrobus_")
            )
        if directory_path.name == ".cargo" and "config.toml" in names:
            ignored.add("config.toml")
        return ignored

    shutil.copytree(source_sdk, destination_sdk, ignore=ignore)


def restore_platform_target(
    source_sdk: Path,
    working_sdk: Path,
    relative_platform: Path,
) -> Path:
    source = source_sdk / "targets" / relative_platform
    destination = working_sdk / "targets" / relative_platform
    if not source.is_dir():
        raise ValidationError(f"SDK target platform directory not found: {source}")
    shutil.rmtree(destination, ignore_errors=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, destination)
    return destination


def replace_placeholders(text: str, replacements: dict[str, str]) -> str:
    for key, value in replacements.items():
        text = text.replace("{" + key + "}", value)
    return text


def merge_bsp_config(base: Any, overlay: Any) -> Any:
    """Recursive object merge matching the VS Code extension."""
    if not isinstance(overlay, dict):
        return base
    out = dict(base) if isinstance(base, dict) else {}
    for key, value in overlay.items():
        if isinstance(value, dict):
            out[key] = merge_bsp_config(out.get(key), value)
        else:
            out[key] = value
    return out


def resolve_board_pin(board_config: dict[str, Any], reference: Any) -> str | None:
    raw = str(reference or "").strip()
    if re.fullmatch(r"GPIO_[A-Za-z0-9_]+", raw):
        return raw
    match = re.fullmatch(r"([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)", raw)
    if not match:
        return None
    headers = board_config.get("headers")
    if not isinstance(headers, dict):
        return None
    header = headers.get(match.group(1))
    if not isinstance(header, dict):
        return None
    pin = header.get(match.group(2))
    return str(pin) if pin else None


def has_mikrobus_mappings(config: Any) -> bool:
    if not isinstance(config, dict):
        return False
    mikrobus = config.get("mikrobus")
    return isinstance(mikrobus, dict) and bool(mikrobus)


def can_build_mikrobus_rust(board_config: dict[str, Any]) -> bool:
    if not has_mikrobus_mappings(board_config):
        return False
    mikrobus = board_config["mikrobus"]
    return any(
        isinstance(signals, dict)
        and any(resolve_board_pin(board_config, ref) for ref in signals.values())
        for signals in mikrobus.values()
    )


def _socket_sort_key(item: tuple[Any, Any]) -> tuple[int, str]:
    key = str(item[0])
    try:
        return (0, f"{int(key):08d}")
    except ValueError:
        return (1, key.casefold())


def build_mikrobus_rust(board_config: dict[str, Any], board_name: str) -> str:
    lines = [
        f"//! Generated MikroBUS mapping for {board_name}.",
        "//! Generated by MikroBUS Rust Tools bulk validator.",
        "",
        "#![allow(dead_code)]",
        "",
        "use drv_name::*;",
        "",
    ]
    mikrobus = board_config.get("mikrobus", {})
    for socket, signals in sorted(mikrobus.items(), key=_socket_sort_key):
        lines.append(f"// mikroBUS {socket}")
        if isinstance(signals, dict):
            for signal, reference in signals.items():
                pin = resolve_board_pin(board_config, reference)
                if pin:
                    lines.append(
                        f"pub const MIKROBUS_{socket}_{signal}: pin_name_t = {pin};"
                    )
                else:
                    lines.append(
                        f"// MIKROBUS_{socket}_{signal} is not routed ({reference})."
                    )
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def resolve_bsp_file(bsp_root: Path, configured_path: str) -> Path:
    portable = str(configured_path or "").strip().replace("\\", "/").lstrip("/")
    if not portable:
        raise ValidationError("The Rust database contains an empty BSP path.")
    if portable.casefold().startswith("bsp/"):
        portable = portable[4:]

    resolved = (bsp_root / portable).resolve()
    try:
        resolved.relative_to(bsp_root.resolve())
    except ValueError as exc:
        raise ValidationError(
            f"Refusing to read a BSP file outside the managed BSP package: {configured_path}"
        ) from exc
    if not resolved.is_file():
        raise ValidationError(
            f"Required BSP file was not found: {resolved}. "
            "Update the Board Support Package."
        )
    return resolved


def install_board_card_setup(
    staging_root: Path,
    combination: BoardCardCombination,
    mcu: str,
    bsp_root: Path,
    logger: Logger,
) -> bool:
    """Create .setup/bsp exactly for a board + MCU-card selection."""
    if not combination.card_to_mcu_present:
        raise ValidationError(
            f"MCUCard.CONFIG_JSON says card '{combination.card_name}' supports {mcu}, "
            "but CardToMCU has no matching row. The extension cannot resolve this "
            "BoardToCard -> CardToMCU setup."
        )

    selected_bsp_root = staging_root / "bsp"
    selected_bsp_root.mkdir(parents=True, exist_ok=True)

    board_source = resolve_bsp_file(bsp_root, combination.board_bsp_path)
    card_source = resolve_bsp_file(bsp_root, combination.card_bsp_path)
    copy_required(board_source, selected_bsp_root / "board.cfg")
    copy_required(card_source, selected_bsp_root / "card.cfg")

    try:
        board_config = json.loads(board_source.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValidationError(f"Invalid board BSP JSON {board_source}: {exc}") from exc
    try:
        card_config = json.loads(card_source.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValidationError(f"Invalid MCU-card BSP JSON {card_source}: {exc}") from exc

    board_config = merge_bsp_config(board_config, card_config)
    mikrobus_generated = can_build_mikrobus_rust(board_config)
    if mikrobus_generated:
        (selected_bsp_root / "mikrobus.rs").write_text(
            build_mikrobus_rust(board_config, combination.board_name),
            encoding="utf-8",
        )

    selection = {
        "boardUid": combination.board_uid,
        "boardName": combination.board_name,
        "mcuName": mcu,
        "mcuCardUid": combination.card_uid,
        "mcuCardName": combination.card_name,
        "boardBspPath": combination.board_bsp_path,
        "mcuCardBspPath": combination.card_bsp_path,
        "shieldUid": None,
        "shieldName": None,
        "mikrobusGenerated": mikrobus_generated,
        "mikrobusSource": "board" if mikrobus_generated else None,
    }
    (selected_bsp_root / "selection.json").write_text(
        json.dumps(selection, indent=2) + "\n", encoding="utf-8"
    )

    logger.write(f"Board: {combination.board_name} [{combination.board_uid}]")
    logger.write(f"MCU card: {combination.card_name} [{combination.card_uid}]")
    logger.write(f"Board BSP: {board_source}")
    logger.write(f"Card BSP: {card_source}")
    logger.write(f"mikrobus.rs generated: {mikrobus_generated}")
    return mikrobus_generated


def generate_setup(
    source_sdk: Path,
    working_sdk: Path,
    core_root: Path,
    metadata: McuMetadata,
    definition_path: Path,
    definition: dict[str, Any],
    clock_mhz: int,
    logger: Logger,
    board_card: BoardCardCombination | None = None,
    bsp_root: Path | None = None,
) -> tuple[Path, Path, bool]:
    """Mirror generateMcuConfiguration() for direct and board+card setups."""
    mcu = metadata.name
    platform_core_root = definition_path.parent.parent
    try:
        relative_platform = platform_core_root.relative_to(core_root)
    except ValueError as exc:
        raise ValidationError(
            f"MCU platform root is not inside the supplied core directory: {platform_core_root}"
        ) from exc

    logger.write(f"Definition: {definition_path}")
    logger.write(f"Platform core: {platform_core_root}")
    logger.write(f"Relative platform: {relative_platform}")
    logger.write(f"Family: {metadata.family}")
    logger.write(f"Target: {metadata.target}")
    logger.write(f"System lib: {metadata.system_lib}")
    logger.write(f"Clock: {clock_mhz} MHz")

    sdk_target_root = restore_platform_target(
        source_sdk, working_sdk, relative_platform
    )

    # Remove all per-MCU generated state left by the previous iteration.
    setup_root = working_sdk / ".setup"
    staging_root = working_sdk / SETUP_STAGING_NAME
    shutil.rmtree(setup_root, ignore_errors=True)
    shutil.rmtree(staging_root, ignore_errors=True)

    config_path = working_sdk / ".cargo" / "config.toml"
    config_path.unlink(missing_ok=True)

    (staging_root / "core" / "src").mkdir(parents=True, exist_ok=True)
    (staging_root / "sdk").mkdir(parents=True, exist_ok=True)

    mikrobus_generated = False
    try:
        if board_card is not None:
            if bsp_root is None:
                raise ValidationError(
                    "Board+card validation requires the managed BSP package."
                )
            logger.section("BOARD + MCU CARD BSP")
            mikrobus_generated = install_board_card_setup(
                staging_root, board_card, mcu, bsp_root, logger
            )

        core_setup = staging_root / "core"
        core_src = core_setup / "src"

        (core_src / "core_header.rs").write_text(
            build_register_header(definition, clock_mhz),
            encoding="utf-8",
        )

        copy_required(
            platform_core_root / "memory" / mcu / "memory.x",
            core_setup / "memory.x",
        )
        copy_required(
            platform_core_root / "startup" / f"{mcu.lower()}.s",
            core_src / "startup.s",
        )
        copy_required(
            platform_core_root / "mcu_headers" / mcu / "lib.rs",
            core_src / "mcu_header.rs",
        )
        copy_required(platform_core_root / "reset.rs", core_src / "reset.rs")
        copy_required(
            platform_core_root / "system" / metadata.system_lib / "init_clock.rs",
            core_src / "init_clock.rs",
        )
        copy_required(platform_core_root / "Cargo.toml", core_setup / "Cargo.toml")
        copy_required(platform_core_root / "lib.rs", core_src / "lib.rs")
        copy_required(
            platform_core_root / "common_header.rs",
            core_src / "common_header.rs",
        )

        template_config = working_sdk / ".cargo" / "template_config.toml"
        if not template_config.is_file():
            raise ValidationError(f"Required source file not found: {template_config}")
        config_text = template_config.read_text(encoding="utf-8").replace(
            "{compiling_target}", metadata.target
        )
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(config_text, encoding="utf-8")

        pin_mappings_root = platform_core_root / "pin_mappings"
        family_pin_root = pin_mappings_root / metadata.family.lower()
        sdk_setup = staging_root / "sdk"

        copy_directory_required(family_pin_root / "src", sdk_setup / "src")
        normalize_rust_crate_entry_point(sdk_setup)

        family_template_path = family_pin_root / "Cargo_family_template.toml"
        hal_template_path = pin_mappings_root / "hal_ll_Cargo_template.toml"

        if not family_template_path.is_file():
            raise ValidationError(f"Required source file not found: {family_template_path}")
        if not hal_template_path.is_file():
            raise ValidationError(f"Required source file not found: {hal_template_path}")

        family_template = family_template_path.read_text(encoding="utf-8")
        hal_template = hal_template_path.read_text(encoding="utf-8")

        rust_language = None
        for entry in definition.get("language_list", []) or []:
            if str(entry.get("language", "")).upper() == "RUST":
                rust_language = entry
                break
        if rust_language is None:
            raise ValidationError(
                f"{mcu}.json does not contain a RUST language_list entry."
            )

        for module in rust_language.get("module_list", []) or []:
            module_name = str(module.get("module_name", ""))
            enabled_submodules: list[str] = []

            for submodule in module.get("sub_modules", []) or []:
                sub_name = str(submodule.get("sub_module_name", ""))
                features = submodule.get("pin_map_features", []) or []
                feature_text = ",".join(f'"{feature}"' for feature in features)
                if feature_text:
                    enabled_submodules.append(f'"{sub_name}"')
                family_template = family_template.replace(
                    "{" + sub_name + "_features}", feature_text
                )

            hal_template = hal_template.replace(
                "{" + module_name + "}", ",".join(enabled_submodules)
            )

        # Cargo_family_template.toml is a FAMILY-WIDE superset.  An MCU JSON
        # intentionally lists only the peripherals/submodules implemented by
        # that specific MCU.  Therefore placeholders for omitted peripherals
        # are valid and must render as an empty TOML feature array:
        #
        #     uart9 = [{uart9_features}]  ->  uart9 = []
        #
        # The VS Code generator historically replaced only placeholders that
        # occurred in language_list, which leaves invalid TOML for MCUs that
        # do not implement every peripheral represented by the family template.
        omitted_feature_tokens = sorted(set(
            re.findall(r"\{([A-Za-z0-9_]+_features)\}", family_template)
        ))
        if omitted_feature_tokens:
            logger.write(
                "Optional peripheral feature placeholders defaulted to empty: "
                + ", ".join(omitted_feature_tokens)
            )
            family_template = re.sub(
                r"\{[A-Za-z0-9_]+_features\}", "", family_template
            )

        # hal_ll_Cargo_template.toml follows the same superset model at module
        # level.  Render {family}, then make modules absent from this MCU empty.
        hal_template = hal_template.replace("{family}", metadata.family.lower())
        omitted_module_tokens = sorted(set(
            token for token in re.findall(r"\{([A-Za-z0-9_]+)\}", hal_template)
            if token != "family"
        ))
        if omitted_module_tokens:
            logger.write(
                "Optional HAL module placeholders defaulted to empty: "
                + ", ".join(omitted_module_tokens)
            )
            hal_template = re.sub(r"\{[A-Za-z0-9_]+\}", "", hal_template)

        # Anything template-like left at this point is not one of the supported
        # optional feature/module placeholders and should fail early with a
        # useful diagnostic instead of reaching Cargo as malformed TOML.
        unresolved_family = sorted(set(re.findall(r"\{[^{}]+\}", family_template)))
        unresolved_hal = sorted(set(re.findall(r"\{[^{}]+\}", hal_template)))
        if unresolved_family or unresolved_hal:
            details = []
            if unresolved_family:
                details.append("family template: " + ", ".join(unresolved_family))
            if unresolved_hal:
                details.append("HAL template: " + ", ".join(unresolved_hal))
            raise ValidationError(
                f"{mcu}: unresolved Rust Cargo template placeholders after rendering: "
                + "; ".join(details)
            )

        (sdk_setup / "Cargo.toml").write_text(family_template, encoding="utf-8")
        sdk_target_root.mkdir(parents=True, exist_ok=True)
        (sdk_target_root / "Cargo.toml").write_text(hal_template, encoding="utf-8")

        target_src = sdk_target_root / "src"
        target_src.mkdir(parents=True, exist_ok=True)

        copy_required(
            sdk_target_root / "gpio" / "hal_ll_gpio" / "gpio.rs",
            target_src / "gpio.rs",
        )
        copy_required(
            sdk_target_root
            / "gpio"
            / "gpio_port"
            / metadata.gpio
            / "gpio_port.rs",
            target_src / "gpio_port.rs",
        )
        copy_required(
            sdk_target_root / "adc" / metadata.adc / "adc.rs",
            target_src / "adc.rs",
        )
        copy_required(
            sdk_target_root / "i2c" / metadata.i2c / "i2c_master.rs",
            target_src / "i2c_master.rs",
        )
        copy_required(
            sdk_target_root / "spi" / metadata.spi / "spi_master.rs",
            target_src / "spi_master.rs",
        )
        copy_required(
            sdk_target_root / "tim" / metadata.tim / "tim.rs",
            target_src / "tim.rs",
        )
        copy_required(
            sdk_target_root / "uart" / metadata.uart / "uart.rs",
            target_src / "uart.rs",
        )

        # The current extension has this fixed to implementation_1. Prefer the
        # database field when present, but fall back to that exact behavior.
        one_wire_impl = metadata.one_wire or "implementation_1"
        one_wire_source = (
            sdk_target_root / "one_wire" / one_wire_impl / "one_wire.rs"
        )
        if not one_wire_source.is_file():
            one_wire_source = (
                sdk_target_root
                / "one_wire"
                / "implementation_1"
                / "one_wire.rs"
            )
        copy_required(one_wire_source, target_src / "one_wire.rs")

        setup_root.parent.mkdir(parents=True, exist_ok=True)
        staging_root.rename(setup_root)

        required_outputs = [
            setup_root / "core" / "Cargo.toml",
            setup_root / "core" / "src" / "core_header.rs",
            setup_root / "core" / "memory.x",
            setup_root / "sdk" / "Cargo.toml",
            config_path,
            sdk_target_root / "Cargo.toml",
        ]
        missing = [str(path) for path in required_outputs if not path.exists()]
        if missing:
            raise ValidationError(
                "Generated setup is incomplete. Missing:\n  - "
                + "\n  - ".join(missing)
            )

        return setup_root, sdk_target_root, mikrobus_generated
    except Exception:
        shutil.rmtree(staging_root, ignore_errors=True)
        raise


def ensure_rust_target(
    target: str,
    rustup: str,
    installed_or_attempted: dict[str, tuple[bool, str]],
    logger: Logger,
    timeout: int,
) -> None:
    if target in installed_or_attempted:
        ok, message = installed_or_attempted[target]
        logger.write(f"rustup target cache: {target}: {message}")
        if not ok:
            raise ValidationError(message)
        return

    logger.section(f"RUST TARGET: {target}")
    result = run_command(
        [rustup, "target", "add", target],
        cwd=Path.cwd(),
        logger=logger,
        timeout=timeout,
        extra_env=None,
    )
    if result != 0:
        message = f"rustup target add {target} failed with exit code {result}"
        installed_or_attempted[target] = (False, message)
        raise ValidationError(message)

    message = f"Rust target {target} is installed."
    installed_or_attempted[target] = (True, message)
    logger.write(message)


def run_command(
    args: list[str],
    cwd: Path,
    logger: Logger,
    timeout: int,
    extra_env: dict[str, str] | None,
) -> int:
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)

    logger.command(args, cwd)

    process = subprocess.Popen(
        args,
        cwd=str(cwd),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    try:
        output, _ = process.communicate(timeout=timeout if timeout > 0 else None)
    except subprocess.TimeoutExpired:
        process.kill()
        output, _ = process.communicate()
        if output:
            for line in output.splitlines():
                logger.write(line)
        logger.write(f"[TIMEOUT] Command exceeded {timeout} seconds.")
        return 124
    except KeyboardInterrupt:
        process.kill()
        process.communicate()
        raise

    if output:
        for line in output.splitlines():
            logger.write(line)

    return int(process.returncode or 0)


def cargo_setup_check(
    cargo: str,
    working_sdk: Path,
    target: str,
    cargo_target_dir: Path,
    logger: Logger,
    timeout: int,
) -> None:
    logger.section("SETUP CARGO CHECK")
    code = run_command(
        [
            cargo,
            "check",
            "--manifest-path",
            str(working_sdk / "Cargo.toml"),
            "--target",
            target,
        ],
        cwd=working_sdk,
        logger=logger,
        timeout=timeout,
        extra_env={"CARGO_TARGET_DIR": str(cargo_target_dir)},
    )
    if code != 0:
        raise ValidationError(f"Cargo setup check failed with exit code {code}.")


def collect_local_setup_dependencies(cargo_toml: Path) -> list[str]:
    """
    Find dependency aliases that point into .setup so the temporary blank
    binary explicitly references the generated runtime/SDK crates.
    """
    try:
        data = tomllib.loads(cargo_toml.read_text(encoding="utf-8"))
    except Exception:
        return []

    found: list[str] = []

    def visit(node: Any) -> None:
        if not isinstance(node, dict):
            return
        deps = node.get("dependencies")
        if isinstance(deps, dict):
            for alias, spec in deps.items():
                if not isinstance(spec, dict):
                    continue
                dep_path = str(spec.get("path", "")).replace("\\", "/")
                if ".setup/" in dep_path or dep_path.startswith(".setup"):
                    crate = str(alias).replace("-", "_")
                    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", crate):
                        found.append(crate)
        for value in node.values():
            if isinstance(value, dict):
                visit(value)

    visit(data)

    unique: list[str] = []
    seen: set[str] = set()
    for item in found:
        if item not in seen:
            seen.add(item)
            unique.append(item)
    return unique


def rust_edition(cargo_toml: Path) -> str:
    try:
        data = tomllib.loads(cargo_toml.read_text(encoding="utf-8"))
        return str(data.get("package", {}).get("edition", "2015"))
    except Exception:
        return "2015"


def blank_source(cargo_toml: Path, include_mikrobus: bool = False) -> str:
    dependencies = collect_local_setup_dependencies(cargo_toml)
    edition = rust_edition(cargo_toml)

    lines = [
        "#![no_std]",
        "#![no_main]",
        "",
    ]

    for dependency in dependencies:
        lines.append(f"use {dependency} as _;")

    if dependencies:
        lines.append("")

    if include_mikrobus:
        # blank.rs lives in .bulk-validation/, so this path reaches the exact
        # generated file that Apply Setup would copy into a user's project.
        lines.extend([
            '#[path = "../.setup/bsp/mikrobus.rs"]',
            "mod mikrobus;",
            "",
        ])

    # Unsafe attributes require the wrapper syntax in Rust 2024.
    no_mangle = "#[unsafe(no_mangle)]" if edition == "2024" else "#[no_mangle]"

    lines.extend(
        [
            no_mangle,
            'pub extern "C" fn main() -> ! {',
            "    loop {",
            "        core::hint::spin_loop();",
            "    }",
            "}",
            "",
        ]
    )

    # If the SDK manifest already carries a panic crate, let it provide the
    # handler. Otherwise add the canonical minimal handler to make this a real
    # standalone blank embedded application.
    try:
        data = tomllib.loads(cargo_toml.read_text(encoding="utf-8"))
        manifest_text = json.dumps(data).lower()
    except Exception:
        manifest_text = ""
    has_panic_dependency = any(
        token in manifest_text
        for token in (
            "panic-halt",
            "panic_halt",
            "panic-abort",
            "panic_abort",
            "panic-semihosting",
            "panic_semihosting",
        )
    )
    if not has_panic_dependency:
        lines.extend(
            [
                "#[panic_handler]",
                "fn panic(_info: &core::panic::PanicInfo) -> ! {",
                "    loop {",
                "        core::hint::spin_loop();",
                "    }",
                "}",
                "",
            ]
        )

    return "\n".join(lines)


def cargo_blank_build(
    cargo: str,
    working_sdk: Path,
    target: str,
    cargo_target_dir: Path,
    logger: Logger,
    timeout: int,
    include_mikrobus: bool = False,
) -> None:
    logger.section("BLANK PROJECT BUILD")

    cargo_toml = working_sdk / "Cargo.toml"
    original_manifest = cargo_toml.read_text(encoding="utf-8")

    validation_root = working_sdk / ".bulk-validation"
    validation_root.mkdir(parents=True, exist_ok=True)
    blank_rs = validation_root / "blank.rs"
    blank_rs.write_text(
        blank_source(cargo_toml, include_mikrobus=include_mikrobus),
        encoding="utf-8",
    )

    relative_source = blank_rs.relative_to(working_sdk).as_posix()
    marker_begin = "# --- MIKROBUS BULK VALIDATION TARGET BEGIN ---"
    marker_end = "# --- MIKROBUS BULK VALIDATION TARGET END ---"

    addition = (
        "\n\n"
        f"{marker_begin}\n"
        "[[bin]]\n"
        f'name = "{BLANK_BIN_NAME}"\n'
        f'path = "{relative_source}"\n'
        f"{marker_end}\n"
    )

    cargo_toml.write_text(original_manifest.rstrip() + addition, encoding="utf-8")

    try:
        code = run_command(
            [
                cargo,
                "build",
                "--manifest-path",
                str(cargo_toml),
                "--bin",
                BLANK_BIN_NAME,
                "--target",
                target,
            ],
            cwd=working_sdk,
            logger=logger,
            timeout=timeout,
            extra_env={"CARGO_TARGET_DIR": str(cargo_target_dir)},
        )
        if code != 0:
            raise ValidationError(f"Blank project build failed with exit code {code}.")
    finally:
        cargo_toml.write_text(original_manifest, encoding="utf-8")
        shutil.rmtree(validation_root, ignore_errors=True)


def cleanup_after_mcu(
    source_sdk: Path,
    working_sdk: Path,
    relative_platform: Path | None,
) -> None:
    shutil.rmtree(working_sdk / ".setup", ignore_errors=True)
    shutil.rmtree(working_sdk / SETUP_STAGING_NAME, ignore_errors=True)
    shutil.rmtree(working_sdk / ".bulk-validation", ignore_errors=True)
    (working_sdk / ".cargo" / "config.toml").unlink(missing_ok=True)

    # The generated target tree is explicitly deleted after each MCU. It will
    # be restored from the pristine SDK before the next MCU using that platform.
    if relative_platform is not None:
        shutil.rmtree(
            working_sdk / "targets" / relative_platform,
            ignore_errors=True,
        )


def write_reports(
    report_root: Path,
    results: list[ValidationResult],
    sdk_root: Path,
    core_root: Path,
    database: Path,
    requested_count: int,
    bsp_root: Path | None,
) -> None:
    csv_path = report_root / "results.csv"
    json_path = report_root / "results.json"
    summary_path = report_root / "summary.txt"

    fieldnames = list(asdict(results[0]).keys()) if results else list(
        ValidationResult(mcu="").__dict__.keys()
    )

    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for result in results:
            writer.writerow(asdict(result))

    passed = sum(result.status == "PASSED" for result in results)
    failed = sum(result.status == "FAILED" for result in results)
    direct_total = sum(result.configuration_type == "mcu" for result in results)
    board_card_total = sum(result.configuration_type == "board+card" for result in results)
    direct_passed = sum(
        result.configuration_type == "mcu" and result.status == "PASSED"
        for result in results
    )
    board_card_passed = sum(
        result.configuration_type == "board+card" and result.status == "PASSED"
        for result in results
    )

    payload = {
        "script_version": SCRIPT_VERSION,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "sdk": str(sdk_root),
        "core": str(core_root),
        "database": str(database),
        "bsp": str(bsp_root) if bsp_root else None,
        "requested_mcus": requested_count,
        "total_checks": len(results),
        "direct_mcu_checks": direct_total,
        "board_card_checks": board_card_total,
        "passed": passed,
        "failed": failed,
        "results": [asdict(result) for result in results],
    }
    json_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    stage_counts: dict[str, int] = {}
    for result in results:
        if result.status == "FAILED":
            stage = result.failed_stage or "unknown"
            stage_counts[stage] = stage_counts.get(stage, 0) + 1

    lines = [
        "Rust MCU bulk validation",
        "========================",
        f"Requested MCUs:       {requested_count}",
        f"Total build checks:   {len(results)}",
        f"  Direct MCU:         {direct_passed}/{direct_total} passed",
        f"  Board + MCU card:   {board_card_passed}/{board_card_total} passed",
        f"Passed overall:       {passed}",
        f"Failed overall:       {failed}",
        "",
        f"SDK:      {sdk_root}",
        f"Core:     {core_root}",
        f"Database: {database}",
        f"BSP:      {bsp_root if bsp_root else '(not needed/resolved yet)'}",
        "",
    ]
    if stage_counts:
        lines.append("Failures by stage:")
        for stage, count in sorted(stage_counts.items()):
            lines.append(f"  {stage}: {count}")
        lines.append("")

    lines.extend(
        [
            f"CSV:  {csv_path}",
            f"JSON: {json_path}",
            f"Logs: {report_root / 'logs'}",
        ]
    )
    summary_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def print_progress(index: int, total: int, mcu: str, message: str) -> None:
    print(f"[{index:>5}/{total:<5}] {mcu:<28} {message}", flush=True)


def run_configuration_check(
    *,
    mcu_index: int,
    mcu_total: int,
    check_index: int,
    sdk_root: Path,
    working_sdk: Path,
    core_root: Path,
    database: Path,
    metadata: McuMetadata,
    definition_path: Path,
    definition: dict[str, Any],
    clock_mhz: int,
    relative_platform: Path,
    cargo: str,
    rustup: str,
    rust_targets: dict[str, tuple[bool, str]],
    cargo_target_dir: Path,
    timeout: int,
    logs_root: Path,
    report_root: Path,
    board_card: BoardCardCombination | None,
    bsp_root: Path | None,
    bsp_error: str | None,
) -> ValidationResult:
    if board_card is None:
        configuration_type = "mcu"
        configuration = "Direct MCU"
        slug = "direct"
    else:
        configuration_type = "board+card"
        configuration = f"{board_card.board_name} + {board_card.card_name}"
        slug = f"{safe_name(board_card.board_name)}__{safe_name(board_card.card_name)}"

    log_path = logs_root / (
        f"{mcu_index:05d}_{safe_name(metadata.name)}_{check_index:03d}_{slug}.log"
    )
    logger = Logger(log_path)
    result = ValidationResult(
        mcu=metadata.name,
        configuration_type=configuration_type,
        configuration=configuration,
        board_uid=board_card.board_uid if board_card else "",
        board_name=board_card.board_name if board_card else "",
        card_uid=board_card.card_uid if board_card else "",
        card_name=board_card.card_name if board_card else "",
        vendor=metadata.vendor,
        family=metadata.family,
        target=metadata.target,
        clock_mhz=clock_mhz,
        log_file=str(log_path.relative_to(report_root)),
    )
    started = time.monotonic()

    print_progress(
        mcu_index,
        mcu_total,
        metadata.name,
        f"START {configuration}",
    )

    try:
        logger.write(f"Rust MCU bulk validator v{SCRIPT_VERSION}")
        logger.write(f"MCU: {metadata.name}")
        logger.write(f"Configuration: {configuration}")
        logger.write(f"SDK: {sdk_root}")
        logger.write(f"Core: {core_root}")
        logger.write(f"Database: {database}")

        if board_card is not None:
            result.failed_stage = "database-relation"
            if not board_card.card_to_mcu_present:
                raise ValidationError(
                    f"MCUCard.CONFIG_JSON contains {metadata.name} for "
                    f"'{board_card.card_name}', but CardToMCU does not contain "
                    "the same MCU/card relationship."
                )

            result.failed_stage = "bsp-discovery"
            if bsp_error:
                raise ValidationError(bsp_error)
            if bsp_root is None:
                raise ValidationError("Managed BSP package was not resolved.")

        result.failed_stage = "rust-target"
        ensure_rust_target(
            metadata.target,
            rustup,
            rust_targets,
            logger,
            timeout,
        )

        result.failed_stage = "setup-generation"
        logger.section("SETUP GENERATION")
        _setup_root, _sdk_target_root, mikrobus_generated = generate_setup(
            source_sdk=sdk_root,
            working_sdk=working_sdk,
            core_root=core_root,
            metadata=metadata,
            definition_path=definition_path,
            definition=definition,
            clock_mhz=clock_mhz,
            logger=logger,
            board_card=board_card,
            bsp_root=bsp_root,
        )
        result.setup_generated = True
        result.mikrobus_generated = mikrobus_generated

        result.failed_stage = "setup-check"
        cargo_setup_check(
            cargo,
            working_sdk,
            metadata.target,
            cargo_target_dir,
            logger,
            timeout,
        )
        result.setup_check = True

        result.failed_stage = "blank-project-build"
        cargo_blank_build(
            cargo,
            working_sdk,
            metadata.target,
            cargo_target_dir,
            logger,
            timeout,
            include_mikrobus=mikrobus_generated,
        )
        result.blank_build = True

        result.status = "PASSED"
        result.failed_stage = ""
        print_progress(
            mcu_index,
            mcu_total,
            metadata.name,
            f"PASS {configuration}",
        )

    except KeyboardInterrupt:
        result.status = "FAILED"
        result.error = "Interrupted by user."
        logger.section("INTERRUPTED")
        logger.write(result.error)
        raise
    except Exception as error:
        result.status = "FAILED"
        result.error = str(error)
        logger.section("FAILURE")
        logger.write(f"Stage: {result.failed_stage}")
        logger.write(f"Error: {error}")
        print_progress(
            mcu_index,
            mcu_total,
            metadata.name,
            f"FAIL {configuration} [{result.failed_stage}] {error}",
        )
    finally:
        result.elapsed_seconds = round(time.monotonic() - started, 3)
        try:
            cleanup_after_mcu(sdk_root, working_sdk, relative_platform)
        except Exception as cleanup_error:
            logger.section("CLEANUP WARNING")
            logger.write(str(cleanup_error))
        logger.close()

    return result


def metadata_failure_result(
    requested_mcu: str,
    error: Exception,
    log_path: Path,
    report_root: Path,
) -> ValidationResult:
    logger = Logger(log_path)
    logger.section("METADATA FAILURE")
    logger.write(str(error))
    logger.close()
    return ValidationResult(
        mcu=requested_mcu,
        configuration_type="mcu",
        configuration="Direct MCU",
        status="FAILED",
        failed_stage="metadata",
        error=str(error),
        log_file=str(log_path.relative_to(report_root)),
    )


def main() -> int:
    args = parse_args()

    try:
        sdk_root = require_directory(args.sdk, "Rust SDK")
        core_root = require_directory(args.core, "Rust core")
        database = discover_database(sdk_root, core_root)
        validate_database_schema(database)
        mcus = load_mcu_list(args.mcus)

        cargo = resolve_executable(ENV_CARGO, "cargo")
        rustup = resolve_executable(ENV_RUSTUP, "rustup")

        try:
            timeout = int(os.environ.get(ENV_TIMEOUT, "900"))
        except ValueError:
            raise ValidationError(
                f"{ENV_TIMEOUT} must be an integer number of seconds."
            )

        if not (sdk_root / "Cargo.toml").is_file():
            raise ValidationError(f"Rust SDK Cargo.toml not found: {sdk_root / 'Cargo.toml'}")
        if not (sdk_root / ".cargo" / "template_config.toml").is_file():
            raise ValidationError(
                "Rust SDK .cargo/template_config.toml not found: "
                f"{sdk_root / '.cargo' / 'template_config.toml'}"
            )

    except ValidationError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_root = Path.cwd() / f"rust_mcu_validation_{timestamp}"
    logs_root = report_root / "logs"
    logs_root.mkdir(parents=True, exist_ok=True)

    temp_root = Path(tempfile.mkdtemp(prefix="mikrobus-rust-bulk-"))
    working_sdk = temp_root / "sdk"
    cargo_target_dir = temp_root / CARGO_TARGET_DIR_NAME

    print("Rust MCU bulk validator")
    print(f"  SDK:      {sdk_root}")
    print(f"  Core:     {core_root}")
    print(f"  Database: {database}")
    print(f"  MCUs:     {len(mcus)}")
    print(f"  Cargo:    {cargo}")
    print(f"  Rustup:   {rustup}")
    print(f"  Reports:  {report_root}")
    print(f"  Temp:     {temp_root}")
    print()

    try:
        print("Creating one disposable SDK working copy...", flush=True)
        copy_sdk_layers(sdk_root, working_sdk)
        print("Disposable SDK ready.\n", flush=True)
    except Exception as error:
        print(f"ERROR: could not prepare working SDK: {error}", file=sys.stderr)
        shutil.rmtree(temp_root, ignore_errors=True)
        return 2

    results: list[ValidationResult] = []
    rust_targets: dict[str, tuple[bool, str]] = {}
    interrupted = False
    bsp_root: Path | None = None
    bsp_error: str | None = None
    bsp_discovery_attempted = False

    try:
        for index, requested_mcu in enumerate(mcus, start=1):
            try:
                metadata = read_mcu_metadata(database, requested_mcu)
                definition_path = find_mcu_definition(core_root, metadata.name)
                definition = json.loads(definition_path.read_text(encoding="utf-8"))
                clock_mhz = definition_clock_mhz(definition, metadata.name)
                platform_core_root = definition_path.parent.parent
                relative_platform = platform_core_root.relative_to(core_root)
            except KeyboardInterrupt:
                interrupted = True
                break
            except Exception as error:
                log_path = logs_root / f"{index:05d}_{safe_name(requested_mcu)}_metadata.log"
                result = metadata_failure_result(
                    requested_mcu, error, log_path, report_root
                )
                results.append(result)
                print_progress(
                    index,
                    len(mcus),
                    requested_mcu,
                    f"FAIL Direct MCU [metadata] {error}",
                )
                write_reports(
                    report_root,
                    results,
                    sdk_root,
                    core_root,
                    database,
                    len(mcus),
                    bsp_root,
                )
                continue

            combinations, cards_without_boards = read_board_card_combinations(
                database, metadata.name
            )

            if combinations and not bsp_discovery_attempted:
                bsp_discovery_attempted = True
                try:
                    bsp_root = discover_bsp_root(sdk_root, core_root)
                    print(f"Resolved BSP package: {bsp_root}")
                except ValidationError as error:
                    bsp_error = str(error)
                    print(f"WARNING: {bsp_error}", file=sys.stderr)

            print_progress(
                index,
                len(mcus),
                metadata.name,
                f"{len(combinations)} board+card check(s) discovered from MCUCard.CONFIG_JSON",
            )
            for card_name in cards_without_boards:
                print_progress(
                    index,
                    len(mcus),
                    metadata.name,
                    f"INFO card has no enabled boards: {card_name}",
                )

            checks: list[BoardCardCombination | None] = [None, *combinations]
            for check_index, board_card in enumerate(checks, start=1):
                try:
                    result = run_configuration_check(
                        mcu_index=index,
                        mcu_total=len(mcus),
                        check_index=check_index,
                        sdk_root=sdk_root,
                        working_sdk=working_sdk,
                        core_root=core_root,
                        database=database,
                        metadata=metadata,
                        definition_path=definition_path,
                        definition=definition,
                        clock_mhz=clock_mhz,
                        relative_platform=relative_platform,
                        cargo=cargo,
                        rustup=rustup,
                        rust_targets=rust_targets,
                        cargo_target_dir=cargo_target_dir,
                        timeout=timeout,
                        logs_root=logs_root,
                        report_root=report_root,
                        board_card=board_card,
                        bsp_root=bsp_root,
                        bsp_error=bsp_error,
                    )
                    results.append(result)
                except KeyboardInterrupt:
                    interrupted = True
                    break
                finally:
                    write_reports(
                        report_root,
                        results,
                        sdk_root,
                        core_root,
                        database,
                        len(mcus),
                        bsp_root,
                    )

            if interrupted:
                break

    finally:
        keep_temp = os.environ.get(ENV_KEEP_TEMP, "").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        if keep_temp:
            print(f"\nKeeping temporary workspace because {ENV_KEEP_TEMP}=1:")
            print(f"  {temp_root}")
        else:
            shutil.rmtree(temp_root, ignore_errors=True)

    passed = sum(result.status == "PASSED" for result in results)
    failed = sum(result.status == "FAILED" for result in results)
    direct = sum(result.configuration_type == "mcu" for result in results)
    board_card = sum(result.configuration_type == "board+card" for result in results)

    print()
    print("=" * 72)
    print(
        f"Validation complete: {passed} passed, {failed} failed "
        f"across {len(results)} checks"
    )
    print(f"  Direct MCU checks:     {direct}")
    print(f"  Board + card checks:   {board_card}")
    print(f"Reports: {report_root}")
    print(f"  {report_root / 'summary.txt'}")
    print(f"  {report_root / 'results.csv'}")
    print(f"  {report_root / 'results.json'}")
    print(f"  {report_root / 'logs'}")
    print("=" * 72)

    if interrupted:
        return 130
    return 0 if failed == 0 and len(results) >= len(mcus) else 1


if __name__ == "__main__":
    raise SystemExit(main())
