#!/usr/bin/env python3
"""
validate_rust_mcus.py

Zero-argument recursive validator for the published Rust MikroBUS environment.

Run:
    python3 validate_rust_mcus.py

The validator bootstraps everything needed from the same fixed GitHub release
channels used by the VS Code extension:

    General Release v0.1.0 / tag v0.1.0
        - sdk.7z
        - database.db
        - general_release_manifest.json

    Rust Core Packages / tag rust-core-packages
        - rust_core_packages.json
        - every Core package required by MCU.SYSTEM_LIB in database.db

    Rust MCU Card Packages / tag rust-card-packages
        - rust_card_packages.json
        - every enabled MCUCard package referenced by database.db

    Rust Board Packages / tag rust-board-packages
        - rust_board_packages.json
        - every enabled Board package referenced by database.db

The MCU list is also read from database.db, so no SDK/core/MCU-list arguments
are necessary. Package catalogs, package SHA-256 values, database availability,
and archive contents are validated before recursive builds start.

Optional environment overrides:
    MIKROBUS_RUST_REPOSITORY=owner/repository
    MIKROBUS_RUST_GENERAL_RELEASE_TAG=v0.1.0
    MIKROBUS_RUST_CORE_PACKAGES_REPOSITORY=owner/repository
    MIKROBUS_RUST_BOARD_PACKAGES_REPOSITORY=owner/repository
    MIKROBUS_RUST_CARD_PACKAGES_REPOSITORY=owner/repository
    MIKROBUS_RUST_7ZIP=/path/to/7z
    MIKROBUS_RUST_CARGO=/path/to/cargo
    MIKROBUS_RUST_RUSTUP=/path/to/rustup
    MIKROBUS_RUST_BUILD_TIMEOUT=900
    MIKROBUS_RUST_KEEP_TEMP=1

No third-party Python packages are required.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
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
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


SCRIPT_VERSION = "1.3.1"
BLANK_BIN_NAME = "mikrobus_validation_blank"
SETUP_STAGING_NAME = ".setup.__mikrobus_staging"

# One Cargo target directory is intentionally shared by all MCU validations in
# this single invocation. Cargo fingerprints changed generated sources, while
# retaining downloaded crates and unchanged compilation artifacts. The entire
# temporary workspace is deleted when the script exits.
CARGO_TARGET_DIR_NAME = ".bulk-validation-target"

# Optional environment controls. These do not add required CLI arguments.
ENV_DATABASE = "MIKROBUS_RUST_DATABASE"
ENV_BSP = "MIKROBUS_RUST_BSP"  # legacy/raw BSP tree fallback
ENV_BOARD_PACKAGES = "MIKROBUS_RUST_BOARD_PACKAGES"
ENV_CARD_PACKAGES = "MIKROBUS_RUST_CARD_PACKAGES"
ENV_BOARD_PACKAGES_REPOSITORY = "MIKROBUS_RUST_BOARD_PACKAGES_REPOSITORY"
ENV_CARD_PACKAGES_REPOSITORY = "MIKROBUS_RUST_CARD_PACKAGES_REPOSITORY"
ENV_7ZIP = "MIKROBUS_RUST_7ZIP"
ENV_CARGO = "MIKROBUS_RUST_CARGO"
ENV_RUSTUP = "MIKROBUS_RUST_RUSTUP"
ENV_TIMEOUT = "MIKROBUS_RUST_BUILD_TIMEOUT"
ENV_KEEP_TEMP = "MIKROBUS_RUST_KEEP_TEMP"
ENV_REPOSITORY = "MIKROBUS_RUST_REPOSITORY"
ENV_GENERAL_RELEASE_TAG = "MIKROBUS_RUST_GENERAL_RELEASE_TAG"
ENV_CORE_PACKAGES_REPOSITORY = "MIKROBUS_RUST_CORE_PACKAGES_REPOSITORY"

DEFAULT_REPOSITORY = "IvanRuzavin/Rusty_MikroBUS"
DEFAULT_GENERAL_RELEASE_TAG = "v0.1.0"
CORE_PACKAGES_RELEASE = "rust-core-packages"
CORE_PACKAGES_CATALOG = "rust_core_packages.json"
GENERAL_RELEASE_MANIFEST = "general_release_manifest.json"


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
            "Download the published Rust SDK/database/Core/Board/Card packages "
            "and recursively validate every MCU/setup. No positional arguments are required."
        )
    )
    parser.add_argument(
        "--version", action="version", version=f"%(prog)s {SCRIPT_VERSION}"
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


def _release_asset_url(repository: str, tag: str, asset: str) -> str:
    return (
        f"https://github.com/{repository}/releases/download/"
        f"{urllib.parse.quote(tag, safe='')}/{urllib.parse.quote(asset, safe='')}"
    )


def _download_file(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "mikrobus-rust-bulk-validator"})
    try:
        with urllib.request.urlopen(request, timeout=90) as response, destination.open("wb") as handle:
            shutil.copyfileobj(response, handle)
    except Exception as exc:
        raise ValidationError(f"Failed to download required release asset {url}: {exc}") from exc


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _sevenzip_executable() -> str:
    configured = os.environ.get(ENV_7ZIP, "").strip()
    if configured:
        candidate = Path(configured).expanduser().resolve()
        if not candidate.is_file():
            raise ValidationError(f"{ENV_7ZIP} points to a missing executable: {candidate}")
        return str(candidate)
    for executable in ("7zz", "7z", "7za"):
        found = shutil.which(executable)
        if found:
            return found
    raise ValidationError(
        "7-Zip is required to bootstrap the published Rust SDK/Core/Board/Card packages. "
        f"Install 7z/7zz/7za or set {ENV_7ZIP}."
    )


def _extract_7z(archive: Path, destination: Path, sevenzip: str) -> None:
    shutil.rmtree(destination, ignore_errors=True)
    destination.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [sevenzip, "x", "-y", str(archive), f"-o{destination}"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if result.returncode != 0:
        raise ValidationError(f"7-Zip failed extracting {archive.name}:\n{result.stdout}")


def _manifest_asset(manifest: dict[str, Any], asset_name: str) -> dict[str, Any]:
    assets = manifest.get("assets")
    if not isinstance(assets, list):
        raise ValidationError(f"{GENERAL_RELEASE_MANIFEST} does not contain an assets array.")
    matches = [item for item in assets if isinstance(item, dict) and item.get("name") == asset_name]
    if len(matches) != 1:
        raise ValidationError(
            f"Expected exactly one '{asset_name}' entry in {GENERAL_RELEASE_MANIFEST}, found {len(matches)}."
        )
    spec = matches[0]
    digest = str(spec.get("sha256") or "")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
        raise ValidationError(f"{GENERAL_RELEASE_MANIFEST}: {asset_name} has an invalid SHA-256.")
    return spec


def _download_manifest_asset(
    repository: str,
    tag: str,
    manifest: dict[str, Any],
    asset_name: str,
    destination: Path,
) -> Path:
    spec = _manifest_asset(manifest, asset_name)
    _download_file(_release_asset_url(repository, tag, asset_name), destination)
    actual = _file_sha256(destination)
    expected = str(spec["sha256"])
    if actual.casefold() != expected.casefold():
        raise ValidationError(
            f"SHA-256 mismatch for {asset_name}: expected {expected}, downloaded {actual}."
        )
    return destination


def load_all_mcus(database: Path) -> list[str]:
    with sqlite3.connect(database) as db:
        rows = db.execute(
            """
            SELECT NAME
            FROM MCU
            WHERE trim(coalesce(SYSTEM_LIB, '')) <> ''
            ORDER BY NAME COLLATE NOCASE
            """
        ).fetchall()
    result = [str(row[0]).strip() for row in rows if str(row[0] or "").strip()]
    if not result:
        raise ValidationError(f"No Rust MCU rows with SYSTEM_LIB were found in {database}.")
    return result


def _required_system_libs(database: Path) -> list[str]:
    with sqlite3.connect(database) as db:
        rows = db.execute(
            """
            SELECT DISTINCT SYSTEM_LIB
            FROM MCU
            WHERE trim(coalesce(SYSTEM_LIB, '')) <> ''
            ORDER BY SYSTEM_LIB COLLATE NOCASE
            """
        ).fetchall()
    return [str(row[0]).strip() for row in rows if str(row[0] or "").strip()]


def _merge_tree(source: Path, destination: Path) -> None:
    for item in sorted(source.rglob("*"), key=lambda p: (len(p.parts), p.as_posix().casefold())):
        relative = item.relative_to(source)
        if relative.as_posix() == ".rust-core-package.json":
            continue
        target = destination / relative
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        if item.is_symlink():
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists() or target.is_symlink():
                target.unlink()
            target.symlink_to(os.readlink(item))
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_file():
            if _file_sha256(target) != _file_sha256(item):
                raise ValidationError(
                    f"Conflicting files while merging Rust Core packages: {relative}"
                )
            continue
        shutil.copy2(item, target)


class PublishedEnvironmentBootstrap:
    def __init__(self, temp_root: Path):
        self.temp_root = temp_root
        self.repository = os.environ.get(ENV_REPOSITORY, "").strip() or DEFAULT_REPOSITORY
        self.general_tag = (
            os.environ.get(ENV_GENERAL_RELEASE_TAG, "").strip() or DEFAULT_GENERAL_RELEASE_TAG
        )
        self.core_repository = (
            os.environ.get(ENV_CORE_PACKAGES_REPOSITORY, "").strip() or self.repository
        )
        self.sevenzip = _sevenzip_executable()
        self.download_root = temp_root / ".published-downloads"

    def _general_manifest(self) -> dict[str, Any]:
        path = self.download_root / "general" / GENERAL_RELEASE_MANIFEST
        _download_file(
            _release_asset_url(self.repository, self.general_tag, GENERAL_RELEASE_MANIFEST),
            path,
        )
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise ValidationError(f"Invalid {GENERAL_RELEASE_MANIFEST}: {exc}") from exc
        if not isinstance(data, dict) or data.get("schemaVersion") != 1:
            raise ValidationError(f"{GENERAL_RELEASE_MANIFEST} has an unsupported schema.")
        return data

    def _core_catalog(self) -> dict[str, Any]:
        path = self.download_root / "core" / CORE_PACKAGES_CATALOG
        _download_file(
            _release_asset_url(self.core_repository, CORE_PACKAGES_RELEASE, CORE_PACKAGES_CATALOG),
            path,
        )
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise ValidationError(f"Invalid {CORE_PACKAGES_CATALOG}: {exc}") from exc
        if not isinstance(data, dict) or data.get("schemaVersion") != 1 or not isinstance(data.get("packages"), list):
            raise ValidationError(f"{CORE_PACKAGES_CATALOG} has an unsupported schema.")
        return data

    def _bootstrap_core(self, database: Path) -> tuple[Path, int]:
        catalog = self._core_catalog()
        merged_root = self.temp_root / "core"
        merged_root.mkdir(parents=True, exist_ok=True)
        package_count = 0
        for system_lib in _required_system_libs(database):
            matches = [
                item for item in catalog["packages"]
                if isinstance(item, dict)
                and str(item.get("systemLib", "")).casefold() == system_lib.casefold()
            ]
            if len(matches) != 1:
                raise ValidationError(
                    f"Expected exactly one published Rust Core package for SYSTEM_LIB '{system_lib}', found {len(matches)}."
                )
            spec = matches[0]
            for key in ("name", "asset", "sha256", "systemLib"):
                if not str(spec.get(key, "")).strip():
                    raise ValidationError(f"Core package for {system_lib} is missing '{key}'.")
            expected_sha = str(spec["sha256"])
            if not re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha):
                raise ValidationError(f"Core package {spec['name']} has an invalid SHA-256.")
            archive = self.download_root / "core" / "archives" / str(spec["asset"])
            _download_file(
                _release_asset_url(self.core_repository, CORE_PACKAGES_RELEASE, str(spec["asset"])),
                archive,
            )
            actual_sha = _file_sha256(archive)
            if actual_sha.casefold() != expected_sha.casefold():
                raise ValidationError(
                    f"SHA-256 mismatch for Core package {archive.name}: expected {expected_sha}, downloaded {actual_sha}."
                )
            extracted = self.download_root / "core" / "packages" / str(spec["name"])
            _extract_7z(archive, extracted, self.sevenzip)
            marker_path = extracted / ".rust-core-package.json"
            try:
                marker = json.loads(marker_path.read_text(encoding="utf-8"))
            except Exception as exc:
                raise ValidationError(f"{archive.name} is missing/has invalid .rust-core-package.json: {exc}") from exc
            if str(marker.get("systemLib", "")).casefold() != system_lib.casefold():
                raise ValidationError(
                    f"{archive.name} marker SYSTEM_LIB does not match {system_lib}."
                )
            _merge_tree(extracted, merged_root)
            package_count += 1
        return merged_root, package_count

    def bootstrap(self) -> tuple[Path, Path, Path, int]:
        manifest = self._general_manifest()
        general_root = self.download_root / "general"
        sdk_archive = _download_manifest_asset(
            self.repository,
            self.general_tag,
            manifest,
            "sdk.7z",
            general_root / "sdk.7z",
        )
        database = _download_manifest_asset(
            self.repository,
            self.general_tag,
            manifest,
            "database.db",
            general_root / "database.db",
        )
        sdk_root = self.temp_root / "published-sdk"
        _extract_7z(sdk_archive, sdk_root, self.sevenzip)
        if not (sdk_root / "Cargo.toml").is_file():
            raise ValidationError(f"Published sdk.7z does not contain Cargo.toml at its root: {sdk_root}")
        core_root, core_count = self._bootstrap_core(database)
        return sdk_root, core_root, database, core_count


def preflight_bsp_packages(database: Path, resolver: "BspPackageResolver") -> tuple[int, int]:
    with sqlite3.connect(database) as db:
        db.row_factory = sqlite3.Row
        boards = db.execute(
            """
            SELECT UID, NAME, BSP_PATH
            FROM Board
            WHERE ENABLED = 1 AND trim(coalesce(BSP_PATH, '')) <> ''
            ORDER BY NAME COLLATE NOCASE, UID
            """
        ).fetchall()
        cards = db.execute(
            """
            SELECT UID, NAME, BSP_PATH
            FROM MCUCard
            WHERE ENABLED = 1 AND trim(coalesce(BSP_PATH, '')) <> ''
            ORDER BY NAME COLLATE NOCASE, UID
            """
        ).fetchall()

    for row in boards:
        uid = str(row["UID"] or "").strip()
        path = str(row["BSP_PATH"] or "").strip()
        if not uid or not path:
            raise ValidationError(f"Enabled Board '{row['NAME']}' is missing UID or BSP_PATH in database.db.")
        resolver.resolve("board", uid, path)

    for row in cards:
        uid = str(row["UID"] or "").strip()
        path = str(row["BSP_PATH"] or "").strip()
        if not uid or not path:
            raise ValidationError(f"Enabled MCUCard '{row['NAME']}' is missing UID or BSP_PATH in database.db.")
        resolver.resolve("card", uid, path)

    return len(boards), len(cards)


def discover_database(sdk_root: Path, core_root: Path) -> Path:
    env_value = os.environ.get(ENV_DATABASE, "").strip()
    candidates: list[Path] = []

    if env_value:
        candidates.append(Path(env_value).expanduser())

    candidates.extend(
        [
            sdk_root / "database.db",
            sdk_root.parent / "database" / "database.db",
            sdk_root.parent / "database.db",
            core_root.parent / "database" / "database.db",
            core_root.parent / "database.db",
            Path.cwd() / "database.db",
            # Legacy filename fallback during migration.
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


def discover_legacy_bsp_root(sdk_root: Path, core_root: Path) -> Path | None:
    """Find a raw/legacy bsp/ tree as an offline fallback."""
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
    return None


class BspPackageResolver:
    """Resolve Board/Shield and MCUCard BSPs from their independent packages.

    Resolution order:
      1. already installed rust-board-packages / rust-card-packages;
      2. a raw legacy bsp/ tree (useful when validating directly in the repo);
      3. the fixed GitHub Board/Card package releases, downloaded into a temp cache.

    This mirrors the VS Code extension's split package model while keeping the
    validator's original three positional arguments unchanged.
    """

    DEFAULT_REPOSITORY = "IvanRuzavin/Rusty_MikroBUS"
    BOARD_RELEASE = "rust-board-packages"
    BOARD_CATALOG = "rust_board_packages.json"
    CARD_RELEASE = "rust-card-packages"
    CARD_CATALOG = "rust_card_packages.json"

    def __init__(self, sdk_root: Path, core_root: Path, cache_root: Path):
        self.sdk_root = sdk_root
        self.core_root = core_root
        self.cache_root = cache_root
        self.legacy_root = discover_legacy_bsp_root(sdk_root, core_root)
        self.board_root = self._discover_package_root(ENV_BOARD_PACKAGES, "rust-board-packages")
        self.card_root = self._discover_package_root(ENV_CARD_PACKAGES, "rust-card-packages")
        self._catalog_cache: dict[str, dict[str, Any]] = {}
        self._sevenzip: str | None = None

    def _discover_package_root(self, env_name: str, directory_name: str) -> Path | None:
        configured = os.environ.get(env_name, "").strip()
        candidates: list[Path] = []
        if configured:
            candidates.append(Path(configured).expanduser())
        candidates.extend(
            [
                self.sdk_root.parent / directory_name,
                self.core_root.parent / directory_name,
                Path.cwd() / directory_name,
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
        return None

    @staticmethod
    def _portable_bsp_path(configured_path: str) -> str:
        portable = str(configured_path or "").strip().replace("\\", "/").lstrip("/")
        if portable.casefold().startswith("bsp/"):
            portable = portable[4:]
        if not portable or any(part == ".." for part in Path(portable).parts):
            raise ValidationError(f"Invalid BSP path in database: {configured_path!r}")
        return portable

    def _raw_file(self, configured_path: str) -> Path | None:
        if self.legacy_root is None:
            return None
        portable = self._portable_bsp_path(configured_path)
        resolved = (self.legacy_root / portable).resolve()
        try:
            resolved.relative_to(self.legacy_root.resolve())
        except ValueError:
            return None
        return resolved if resolved.is_file() else None

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any] | None:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else None
        except Exception:
            return None

    def _local_package_file(
        self,
        root: Path | None,
        entity_type: str,
        uid: str,
        configured_path: str,
        marker_names: tuple[str, ...],
    ) -> Path | None:
        if root is None or not root.is_dir():
            return None
        wanted_uid = uid.casefold()
        portable = self._portable_bsp_path(configured_path)
        for child in root.iterdir():
            if not child.is_dir():
                continue
            marker: dict[str, Any] | None = None
            for marker_name in marker_names:
                marker = self._read_json(child / marker_name)
                if marker:
                    break
            if not marker:
                continue
            if str(marker.get("entityType", "")).casefold() != entity_type.casefold():
                continue
            if str(marker.get("uid", "")).casefold() != wanted_uid:
                continue
            relative = str(marker.get("relativeBspPath") or portable).replace("\\", "/")
            candidate = (child / relative).resolve()
            try:
                candidate.relative_to(child.resolve())
            except ValueError:
                raise ValidationError(f"Package {child} contains an invalid relativeBspPath: {relative}")
            if not candidate.is_file():
                raise ValidationError(f"Installed {entity_type} package for {uid} is missing {relative}: {child}")
            return candidate
        return None

    @staticmethod
    def _repo_env(entity_type: str) -> str:
        return ENV_CARD_PACKAGES_REPOSITORY if entity_type == "card" else ENV_BOARD_PACKAGES_REPOSITORY

    def _repository(self, entity_type: str) -> str:
        return os.environ.get(self._repo_env(entity_type), "").strip() or self.DEFAULT_REPOSITORY

    @staticmethod
    def _release_info(entity_type: str) -> tuple[str, str, str, tuple[str, ...]]:
        if entity_type == "card":
            return (
                BspPackageResolver.CARD_RELEASE,
                BspPackageResolver.CARD_CATALOG,
                "card-entity",
                (".rust-card-installed.json", ".rust-card-package.json"),
            )
        return (
            BspPackageResolver.BOARD_RELEASE,
            BspPackageResolver.BOARD_CATALOG,
            "board-entity",
            (".rust-board-installed.json", ".rust-board-package.json"),
        )

    @staticmethod
    def _release_url(repository: str, release_tag: str, asset: str) -> str:
        return (
            f"https://github.com/{repository}/releases/download/"
            f"{urllib.parse.quote(release_tag, safe='')}/{urllib.parse.quote(asset, safe='')}"
        )

    @staticmethod
    def _download(url: str, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(url, headers={"User-Agent": "mikrobus-rust-bulk-validator"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response, destination.open("wb") as handle:
                shutil.copyfileobj(response, handle)
        except Exception as exc:
            raise ValidationError(f"Failed to download {url}: {exc}") from exc

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _catalog(self, entity_type: str) -> dict[str, Any]:
        family = "card" if entity_type == "card" else "board"
        cached = self._catalog_cache.get(family)
        if cached is not None:
            return cached
        release_tag, catalog_asset, package_model, _markers = self._release_info(entity_type)
        repository = self._repository(entity_type)
        local_catalog = self.cache_root / family / catalog_asset
        if not local_catalog.is_file():
            self._download(self._release_url(repository, release_tag, catalog_asset), local_catalog)
        try:
            catalog = json.loads(local_catalog.read_text(encoding="utf-8"))
        except Exception as exc:
            raise ValidationError(f"Invalid {catalog_asset}: {exc}") from exc
        if not isinstance(catalog, dict) or catalog.get("schemaVersion") != 1 or catalog.get("packageModel") != package_model:
            raise ValidationError(f"{catalog_asset} has an unsupported schema/packageModel.")
        packages = catalog.get("packages")
        if not isinstance(packages, list):
            raise ValidationError(f"{catalog_asset} does not contain a packages array.")
        self._catalog_cache[family] = catalog
        return catalog

    def _sevenzip_executable(self) -> str:
        if self._sevenzip:
            return self._sevenzip
        configured = os.environ.get(ENV_7ZIP, "").strip()
        if configured:
            candidate = Path(configured).expanduser().resolve()
            if not candidate.is_file():
                raise ValidationError(f"{ENV_7ZIP} points to a missing executable: {candidate}")
            self._sevenzip = str(candidate)
            return self._sevenzip
        for executable in ("7zz", "7z", "7za"):
            found = shutil.which(executable)
            if found:
                self._sevenzip = found
                return found
        raise ValidationError(
            "7-Zip is required to download split Rust Board/MCU Card packages. "
            f"Install 7z/7zz/7za, set {ENV_7ZIP}, or provide a raw BSP tree via {ENV_BSP}."
        )

    def _download_package(self, entity_type: str, uid: str, configured_path: str) -> Path:
        catalog = self._catalog(entity_type)
        wanted = uid.casefold()
        matches = [
            item for item in catalog["packages"]
            if isinstance(item, dict)
            and str(item.get("entityType", "")).casefold() == entity_type.casefold()
            and str(item.get("uid", "")).casefold() == wanted
        ]
        if len(matches) != 1:
            raise ValidationError(
                f"Expected exactly one published Rust {entity_type} package for UID '{uid}', found {len(matches)}."
            )
        spec = matches[0]
        for key in ("name", "asset", "sha256", "relativeBspPath"):
            if not str(spec.get(key, "")).strip():
                raise ValidationError(f"Published {entity_type} package for {uid} is missing '{key}'.")
        if not re.fullmatch(r"[0-9a-fA-F]{64}", str(spec["sha256"])):
            raise ValidationError(f"Published {entity_type} package for {uid} has an invalid SHA-256.")

        family = "card" if entity_type == "card" else "board"
        package_root = self.cache_root / family / "packages" / str(spec["name"])
        marker_name = ".rust-card-package.json" if entity_type == "card" else ".rust-board-package.json"
        expected_file = package_root / str(spec["relativeBspPath"])
        marker = self._read_json(package_root / marker_name)
        if marker and expected_file.is_file() and str(marker.get("uid", "")).casefold() == wanted:
            return expected_file

        release_tag, _catalog_asset, _package_model, _markers = self._release_info(entity_type)
        repository = self._repository(entity_type)
        archive = self.cache_root / family / "archives" / str(spec["asset"])
        if not archive.is_file() or self._sha256(archive).casefold() != str(spec["sha256"]).casefold():
            self._download(self._release_url(repository, release_tag, str(spec["asset"])), archive)
        actual = self._sha256(archive)
        if actual.casefold() != str(spec["sha256"]).casefold():
            raise ValidationError(
                f"SHA-256 mismatch for {archive.name}: expected {spec['sha256']}, downloaded {actual}."
            )

        shutil.rmtree(package_root, ignore_errors=True)
        package_root.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            [self._sevenzip_executable(), "x", "-y", str(archive), f"-o{package_root}"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        if result.returncode != 0:
            raise ValidationError(f"7-Zip failed extracting {archive.name}:\n{result.stdout}")

        marker = self._read_json(package_root / marker_name)
        if not marker:
            raise ValidationError(f"{archive.name} does not contain {marker_name}.")
        if str(marker.get("entityType", "")).casefold() != entity_type.casefold() or str(marker.get("uid", "")).casefold() != wanted:
            raise ValidationError(f"{archive.name} contains metadata for a different {entity_type} entity.")
        expected_file = package_root / str(spec["relativeBspPath"])
        if not expected_file.is_file():
            raise ValidationError(f"{archive.name} is missing {spec['relativeBspPath']}.")
        return expected_file

    def resolve(self, entity_type: str, uid: str, configured_path: str, logger: Logger | None = None) -> Path:
        type_name = entity_type.casefold()
        if type_name not in {"board", "card", "shield"}:
            raise ValidationError(f"Unsupported Rust BSP package entity type: {entity_type}")
        release_type = "card" if type_name == "card" else type_name
        root = self.card_root if type_name == "card" else self.board_root
        _release_tag, _catalog_asset, _package_model, markers = self._release_info(type_name)
        local = self._local_package_file(root, type_name, uid, configured_path, markers)
        if local:
            if logger:
                logger.write(f"Resolved {type_name} BSP from installed split package: {local}")
            return local

        raw = self._raw_file(configured_path)
        if raw:
            if logger:
                logger.write(f"Resolved {type_name} BSP from raw/legacy BSP tree: {raw}")
            return raw

        downloaded = self._download_package(type_name, uid, configured_path)
        if logger:
            logger.write(f"Resolved {type_name} BSP from split GitHub package release: {downloaded}")
        return downloaded

    def description(self) -> str:
        parts = []
        if self.board_root:
            parts.append(f"board={self.board_root}")
        if self.card_root:
            parts.append(f"card={self.card_root}")
        if self.legacy_root:
            parts.append(f"raw={self.legacy_root}")
        if not parts:
            parts.append("on-demand GitHub Board/Card packages")
        return ", ".join(parts)

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

    # Match the VS Code extension and the C BSP USB_UART_TX/RX convention.
    # The selected MCU Card has already been merged into board_config, so a
    # connector reference such as RIGHT_CN.P160 resolves to the concrete GPIO.
    usb_uart = board_config.get("usb_uart")
    if isinstance(usb_uart, dict):
        lines.append("// USB UART")
        for signal in ("TX", "RX"):
            reference = usb_uart.get(signal)
            if reference is None or not str(reference).strip():
                continue
            pin = resolve_board_pin(board_config, reference)
            if pin:
                lines.append(f"pub const USB_UART_{signal}: pin_name_t = {pin};")
            else:
                lines.append(f"// USB_UART_{signal} is not routed ({reference}).")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def install_board_card_setup(
    staging_root: Path,
    combination: BoardCardCombination,
    mcu: str,
    bsp_resolver: BspPackageResolver,
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

    board_source = bsp_resolver.resolve(
        "board", combination.board_uid, combination.board_bsp_path, logger
    )
    card_source = bsp_resolver.resolve(
        "card", combination.card_uid, combination.card_bsp_path, logger
    )
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
    bsp_resolver: BspPackageResolver | None = None,
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
            if bsp_resolver is None:
                raise ValidationError(
                    "Board+card validation requires the split Board/Card BSP package resolver."
                )
            logger.section("BOARD + MCU CARD BSP")
            mikrobus_generated = install_board_card_setup(
                staging_root, board_card, mcu, bsp_resolver, logger
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

        # Only identifier-only braces are template placeholders. TOML inline
        # tables are also written with braces, for example:
        #
        #     mcu_definition = { path = "../../targets/arm/stm32/hal_ll_target_names" }
        #
        # A broad ``\{[^{}]+\}`` check incorrectly classifies those perfectly
        # valid TOML inline tables as unresolved template placeholders.
        placeholder_pattern = r"\{([A-Za-z_][A-Za-z0-9_]*)\}"
        unresolved_family = sorted(set(
            re.findall(placeholder_pattern, family_template)
        ))
        unresolved_hal = sorted(set(
            re.findall(placeholder_pattern, hal_template)
        ))
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


def find_panic_dependency(cargo_toml: Path) -> str | None:
    """
    Return the Rust crate name of a direct panic-handler dependency.

    A dependency being present in Cargo.toml is not enough to make its
    #[panic_handler] available to a binary: the binary must reference the
    crate so rustc links it.  Only the package's direct [dependencies] table
    is considered here; mentions in metadata/workspace/dev-dependencies must
    not suppress the validator's fallback panic handler.
    """
    try:
        data = tomllib.loads(cargo_toml.read_text(encoding="utf-8"))
    except Exception:
        return None

    dependencies = data.get("dependencies")
    if not isinstance(dependencies, dict):
        return None

    panic_packages = {
        "panic-halt",
        "panic-abort",
        "panic-semihosting",
    }

    for alias, spec in dependencies.items():
        alias_text = str(alias).strip()
        package_name = alias_text
        if isinstance(spec, dict):
            package_name = str(spec.get("package", alias_text)).strip()

        normalized_alias = alias_text.replace("_", "-").casefold()
        normalized_package = package_name.replace("_", "-").casefold()
        if (
            normalized_alias not in panic_packages
            and normalized_package not in panic_packages
        ):
            continue

        crate = alias_text.replace("-", "_")
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", crate):
            return crate

    return None


def crate_link_statement(crate: str, edition: str) -> str:
    """Force a dependency crate into the final validation binary."""
    if edition == "2015":
        return f"extern crate {crate};"
    return f"use {crate} as _;"


def blank_source(cargo_toml: Path, include_mikrobus: bool = False) -> str:
    dependencies = collect_local_setup_dependencies(cargo_toml)
    edition = rust_edition(cargo_toml)
    panic_dependency = find_panic_dependency(cargo_toml)

    lines = [
        "#![no_std]",
        "#![no_main]",
        "",
    ]

    linked_crates: set[str] = set()
    for dependency in dependencies:
        lines.append(crate_link_statement(dependency, edition))
        linked_crates.add(dependency)

    # panic-halt/panic-abort/panic-semihosting only contribute their
    # #[panic_handler] when the binary actually references the crate. Cargo
    # compiling the dependency is not sufficient to link that handler.
    if panic_dependency and panic_dependency not in linked_crates:
        lines.append(crate_link_statement(panic_dependency, edition))
        linked_crates.add(panic_dependency)

    if linked_crates:
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

    # If the project has no direct panic-handler crate, provide a deterministic
    # minimal handler so the synthetic blank application can be linked.
    if not panic_dependency:
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
    bsp_description: str | None,
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
        "bsp_packages": bsp_description,
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
        f"BSP packages: {bsp_description or '(not needed/resolved yet)'}",
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
    bsp_resolver: BspPackageResolver | None,
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
            if bsp_resolver is None:
                raise ValidationError("Rust Board/Card BSP package resolver was not initialized.")

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
            bsp_resolver=bsp_resolver,
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
    parse_args()

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_root = Path.cwd() / f"rust_mcu_validation_{timestamp}"
    logs_root = report_root / "logs"
    logs_root.mkdir(parents=True, exist_ok=True)

    temp_root = Path(tempfile.mkdtemp(prefix="mikrobus-rust-bulk-"))
    working_sdk = temp_root / "sdk-working"
    cargo_target_dir = temp_root / CARGO_TARGET_DIR_NAME

    try:
        print("Rust MCU bulk validator")
        print(f"  Version:  {SCRIPT_VERSION}")
        print("  Mode:     zero-argument published-environment bootstrap")
        print(f"  Temp:     {temp_root}")
        print()
        print("Bootstrapping General Release, Core packages and database...", flush=True)
        bootstrap = PublishedEnvironmentBootstrap(temp_root)
        sdk_root, core_root, database, core_package_count = bootstrap.bootstrap()

        validate_database_schema(database)
        mcus = load_all_mcus(database)
        cargo = resolve_executable(ENV_CARGO, "cargo")
        rustup = resolve_executable(ENV_RUSTUP, "rustup")
        try:
            timeout = int(os.environ.get(ENV_TIMEOUT, "900"))
        except ValueError:
            raise ValidationError(f"{ENV_TIMEOUT} must be an integer number of seconds.")

        if not (sdk_root / ".cargo" / "template_config.toml").is_file():
            raise ValidationError(
                "Published Rust SDK .cargo/template_config.toml not found: "
                f"{sdk_root / '.cargo' / 'template_config.toml'}"
            )

        print(f"Published SDK:      {sdk_root}")
        print(f"Published database: {database}")
        print(f"Core packages:      {core_package_count} downloaded/verified")
        print(f"MCUs from database: {len(mcus)}")
        print()

        print("Creating one disposable SDK working copy...", flush=True)
        copy_sdk_layers(sdk_root, working_sdk)
        print("Disposable SDK ready.", flush=True)

        bsp_resolver = BspPackageResolver(
            sdk_root, core_root, temp_root / ".rust-bsp-package-cache"
        )
        print("Preflighting every enabled Board and MCU Card package...", flush=True)
        board_package_count, card_package_count = preflight_bsp_packages(database, bsp_resolver)
        bsp_description = (
            f"{bsp_resolver.description()}; preflight verified "
            f"{board_package_count} board package(s), {card_package_count} card package(s)"
        )
        print(f"Board packages:     {board_package_count} downloaded/verified")
        print(f"MCU Card packages:  {card_package_count} downloaded/verified")
        print()

    except ValidationError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        shutil.rmtree(temp_root, ignore_errors=True)
        return 2
    except Exception as error:
        print(f"ERROR: bootstrap failed: {error}", file=sys.stderr)
        shutil.rmtree(temp_root, ignore_errors=True)
        return 2

    print(f"  Cargo:    {cargo}")
    print(f"  Rustup:   {rustup}")
    print(f"  Reports:  {report_root}")
    print()

    results: list[ValidationResult] = []
    rust_targets: dict[str, tuple[bool, str]] = {}
    interrupted = False

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
                result = metadata_failure_result(requested_mcu, error, log_path, report_root)
                results.append(result)
                print_progress(index, len(mcus), requested_mcu, f"FAIL Direct MCU [metadata] {error}")
                write_reports(
                    report_root, results, sdk_root, core_root, database, len(mcus), bsp_description
                )
                continue

            combinations, cards_without_boards = read_board_card_combinations(database, metadata.name)
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
                        bsp_resolver=bsp_resolver,
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
                        bsp_description,
                    )
            if interrupted:
                break

    finally:
        keep_temp = os.environ.get(ENV_KEEP_TEMP, "").strip().lower() in {
            "1", "true", "yes", "on"
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
    print(f"Validation complete: {passed} passed, {failed} failed across {len(results)} checks")
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
