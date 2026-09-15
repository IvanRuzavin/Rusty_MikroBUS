#!/usr/bin/env python3
"""Build deterministic Rust core packages grouped by MCU.SYSTEM_LIB.

Each package preserves the original core layout, but includes only the MCU-specific
files required by the MCUs that use one system library. Package names are:

    <architecture>_<system-lib-without-system_>.7z

Example:
    core/arm/stm32/system/system_stm32f_2xx
        -> arm_stm32f_2xx.7z

The MCU -> SYSTEM_LIB/FAMILY relationship comes from database.db,
so new architectures/platforms are discovered from the core tree rather than
being hard-coded in this script.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

SCHEMA_VERSION = 1
CATALOG_NAME = "rust_core_packages.json"
PACKAGE_MARKER = ".rust-core-package.json"
PRUNED_PLATFORM_DIRS = {
    "mcu_definitions",
    "mcu_headers",
    "memory",
    "startup",
    "system",
    "pin_mappings",
}


class PackageError(RuntimeError):
    pass


@dataclass(frozen=True)
class McuRow:
    name: str
    family: str
    system_lib: str


@dataclass
class PackageGroup:
    platform_root: Path
    platform_relative: Path
    architecture: str
    system_lib: str
    package_name: str
    rows: list[McuRow] = field(default_factory=list)

    @property
    def families(self) -> list[str]:
        return sorted({row.family for row in self.rows}, key=str.casefold)

    @property
    def mcus(self) -> list[str]:
        return sorted({row.name for row in self.rows}, key=str.casefold)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", default="core", help="Core directory to package.")
    parser.add_argument(
        "--database",
        required=True,
        help="Path to database.db used to map MCUs to SYSTEM_LIB.",
    )
    parser.add_argument("--output", default="dist/rust-core-packages", help="Output directory.")
    parser.add_argument(
        "--sevenzip",
        default="",
        help="Optional 7z/7zz/7za executable. Auto-detected when omitted.",
    )
    parser.add_argument(
        "--fail-unassigned",
        action="store_true",
        help="Fail if an MCU definition exists in core but has no matching MCU database row.",
    )
    parser.add_argument(
        "--fail-missing-definitions",
        action="store_true",
        help="Fail if the database references an MCU whose definition is not present in this core checkout.",
    )
    return parser.parse_args()


def require_dir(value: str, label: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise PackageError(f"{label} directory does not exist: {path}")
    return path


def require_file(value: str, label: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise PackageError(f"{label} file does not exist: {path}")
    return path


def find_sevenzip(configured: str) -> str:
    if configured:
        path = Path(configured).expanduser().resolve()
        if not path.is_file():
            raise PackageError(f"7-Zip executable does not exist: {path}")
        return str(path)

    for name in ("7zz", "7z", "7za"):
        found = shutil.which(name)
        if found:
            return found
    raise PackageError("7-Zip was not found. Install 7z/7zz/7za or pass --sevenzip.")


def validate_database_schema(database: Path) -> None:
    required = {
        "MCU": {"NAME", "FAMILY", "SYSTEM_LIB"},
    }
    with sqlite3.connect(database) as db:
        for table, columns in required.items():
            existing = {
                str(row[1]).upper()
                for row in db.execute(f"PRAGMA table_info({table})").fetchall()
            }
            missing = columns - existing
            if missing:
                raise PackageError(
                    f"{database}: table {table} is missing column(s): {', '.join(sorted(missing))}"
                )


def read_mcu_rows(database: Path) -> list[McuRow]:
    validate_database_schema(database)
    with sqlite3.connect(database) as db:
        rows = db.execute(
            """
            SELECT NAME, FAMILY, SYSTEM_LIB
            FROM MCU
            WHERE trim(coalesce(SYSTEM_LIB, '')) <> ''
            ORDER BY NAME COLLATE NOCASE
            """
        ).fetchall()

    result = []
    for name, family, system_lib in rows:
        name = str(name or "").strip()
        family = str(family or "").strip()
        system_lib = str(system_lib or "").strip()
        if not name or not family or not system_lib:
            continue
        result.append(McuRow(name=name, family=family, system_lib=system_lib))
    if not result:
        raise PackageError(f"No MCU rows with SYSTEM_LIB were found in {database}.")
    return result


def definition_index(core_root: Path) -> dict[str, Path]:
    index: dict[str, Path] = {}
    duplicates: dict[str, list[Path]] = {}
    for folder in core_root.rglob("mcu_definitions"):
        if not folder.is_dir():
            continue
        for definition in folder.iterdir():
            if not definition.is_file():
                continue
            key = definition.stem.casefold()
            if key in index:
                duplicates.setdefault(key, [index[key]]).append(definition)
            else:
                index[key] = definition
    if duplicates:
        details = "\n".join(
            f"  {name}: " + ", ".join(str(path) for path in paths)
            for name, paths in sorted(duplicates.items())
        )
        raise PackageError(f"Duplicate MCU definition names were found:\n{details}")
    if not index:
        raise PackageError(f"No mcu_definitions directories were found under {core_root}.")
    return index


def sanitize_package_name(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9._-]+", "_", value)
    value = re.sub(r"_+", "_", value).strip("._-")
    if not value:
        raise PackageError("Generated an empty package name.")
    return value


def package_name(architecture: str, system_lib: str) -> str:
    suffix = re.sub(r"^system_", "", system_lib, flags=re.IGNORECASE)
    # Avoid names such as rl78_rl78_g24 or rx_rx26t when SYSTEM_LIB already
    # starts with the architecture name. ARM + STM32 still becomes the desired
    # arm_stm32... form.
    combined = suffix if suffix.casefold().startswith(architecture.casefold()) else f"{architecture}_{suffix}"
    return sanitize_package_name(combined)


def build_groups(core_root: Path, rows: list[McuRow]) -> tuple[list[PackageGroup], set[str], list[str]]:
    definitions = definition_index(core_root)
    groups: dict[tuple[Path, str], PackageGroup] = {}
    assigned: set[str] = set()
    missing_definitions: list[str] = []

    for row in rows:
        definition = definitions.get(row.name.casefold())
        if not definition:
            missing_definitions.append(row.name)
            continue

        assigned.add(row.name.casefold())
        platform_root = definition.parent.parent
        try:
            relative_platform = platform_root.relative_to(core_root)
        except ValueError as exc:
            raise PackageError(f"Definition is outside core root: {definition}") from exc
        if not relative_platform.parts:
            raise PackageError(f"Cannot determine architecture for {definition}.")

        architecture = relative_platform.parts[0]
        system_dir = platform_root / "system" / row.system_lib
        if not system_dir.is_dir():
            raise PackageError(
                f"{row.name}: database SYSTEM_LIB '{row.system_lib}' does not exist at {system_dir}"
            )

        key = (platform_root, row.system_lib.casefold())
        group = groups.get(key)
        if group is None:
            group = PackageGroup(
                platform_root=platform_root,
                platform_relative=relative_platform,
                architecture=architecture,
                system_lib=row.system_lib,
                package_name=package_name(architecture, row.system_lib),
            )
            groups[key] = group
        group.rows.append(row)

    names: dict[str, PackageGroup] = {}
    for group in groups.values():
        existing = names.get(group.package_name)
        if existing and (
            existing.platform_relative != group.platform_relative
            or existing.system_lib.casefold() != group.system_lib.casefold()
        ):
            raise PackageError(
                f"Package name collision '{group.package_name}': "
                f"{existing.platform_relative}/{existing.system_lib} and "
                f"{group.platform_relative}/{group.system_lib}"
            )
        names[group.package_name] = group

    ordered = sorted(groups.values(), key=lambda item: item.package_name)
    if not ordered:
        raise PackageError("No package groups could be built from the intersection of the database and core tree.")
    return ordered, assigned, sorted(missing_definitions, key=str.casefold)


def copy_path(source: Path, destination: Path) -> None:
    if source.is_dir():
        shutil.copytree(source, destination, dirs_exist_ok=True, copy_function=shutil.copy2)
    elif source.is_file():
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    else:
        raise PackageError(f"Required core path does not exist: {source}")


def find_casefold_child(parent: Path, name: str) -> Path | None:
    target = name.casefold()
    if not parent.is_dir():
        return None
    for child in parent.iterdir():
        if child.name.casefold() == target:
            return child
    return None


def copy_selected_mcu_entry(source_root: Path, dest_root: Path, mcu: str, *, kind: str) -> None:
    if not source_root.is_dir():
        raise PackageError(f"Required {kind} directory is missing: {source_root}")

    if kind == "mcu_definitions":
        matches = [p for p in source_root.iterdir() if p.is_file() and p.stem.casefold() == mcu.casefold()]
    elif kind in {"mcu_headers", "memory"}:
        child = find_casefold_child(source_root, mcu)
        matches = [child] if child else []
    elif kind == "startup":
        matches = [
            p for p in source_root.iterdir()
            if (p.is_file() and p.stem.casefold() == mcu.casefold())
            or (p.is_dir() and p.name.casefold() == mcu.casefold())
        ]
    else:
        raise PackageError(f"Unknown MCU-scoped core directory: {kind}")

    if not matches:
        raise PackageError(f"{mcu}: no {kind} entry found below {source_root}")

    for source in matches:
        copy_path(source, dest_root / source.name)


def copy_pin_mappings(
    platform_root: Path,
    dest_platform: Path,
    selected_families: Iterable[str],
    all_platform_families: Iterable[str],
) -> None:
    source = platform_root / "pin_mappings"
    if not source.is_dir():
        raise PackageError(f"pin_mappings directory is missing: {source}")

    destination = dest_platform / "pin_mappings"
    destination.mkdir(parents=True, exist_ok=True)
    selected = {family.casefold() for family in selected_families}
    all_family_names = {family.casefold() for family in all_platform_families}

    for child in sorted(source.iterdir(), key=lambda p: p.name.casefold()):
        if child.is_file():
            copy_path(child, destination / child.name)
            continue

        # Family directories are filtered. Any non-family directory is shared
        # infrastructure and is included in every package for this platform.
        if child.name.casefold() in all_family_names and child.name.casefold() not in selected:
            continue
        copy_path(child, destination / child.name)

    for family in selected_families:
        if find_casefold_child(source, family) is None:
            raise PackageError(
                f"Family pin mapping '{family.lower()}' required by a package is missing below {source}"
            )


def stage_package(
    core_root: Path,
    group: PackageGroup,
    all_platform_rows: list[McuRow],
    staging_root: Path,
) -> None:
    source_platform = group.platform_root
    dest_platform = staging_root / group.platform_relative
    dest_platform.mkdir(parents=True, exist_ok=True)

    # Copy future/shared platform content automatically while excluding only the
    # directories that need system-lib / MCU / family filtering.
    for child in sorted(source_platform.iterdir(), key=lambda p: p.name.casefold()):
        if child.name in PRUNED_PLATFORM_DIRS:
            continue
        copy_path(child, dest_platform / child.name)

    copy_path(
        source_platform / "system" / group.system_lib,
        dest_platform / "system" / group.system_lib,
    )

    all_platform_families = {row.family.lower() for row in all_platform_rows}
    copy_pin_mappings(
        source_platform,
        dest_platform,
        (family.lower() for family in group.families),
        all_platform_families,
    )

    for mcu in group.mcus:
        for kind in ("mcu_definitions", "mcu_headers", "memory", "startup"):
            copy_selected_mcu_entry(
                source_platform / kind,
                dest_platform / kind,
                mcu,
                kind=kind,
            )

    marker = {
        "schemaVersion": SCHEMA_VERSION,
        "packageName": group.package_name,
        "architecture": group.architecture,
        "platform": group.platform_relative.as_posix(),
        "systemLib": group.system_lib,
        "families": group.families,
        "mcuCount": len(group.mcus),
    }
    (staging_root / PACKAGE_MARKER).write_text(
        json.dumps(marker, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def normalize_mtimes(root: Path) -> None:
    # Archive timestamps must not depend on checkout time, otherwise every run
    # would get a new archive hash even when the package contents are unchanged.
    epoch = 946684800  # 2000-01-01T00:00:00Z
    for path in sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        try:
            os.utime(path, (epoch, epoch), follow_symlinks=False)
        except OSError:
            pass
    os.utime(root, (epoch, epoch), follow_symlinks=False)


def build_archive(sevenzip: str, staging_root: Path, archive: Path) -> None:
    normalize_mtimes(staging_root)
    files = sorted(
        path.relative_to(staging_root).as_posix()
        for path in staging_root.rglob("*")
        if path.is_file() or path.is_symlink()
    )
    if not files:
        raise PackageError(f"Refusing to create empty package {archive.name}.")

    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.unlink(missing_ok=True)
    list_file = staging_root.parent / f"{archive.stem}.files.txt"
    list_file.write_text("\n".join(files) + "\n", encoding="utf-8")
    try:
        command = [
            sevenzip,
            "a",
            "-t7z",
            "-mx=9",
            "-mmt=off",
            "-mtc=off",
            "-mtm=off",
            "-mta=off",
            str(archive),
            f"@{list_file}",
        ]
        result = subprocess.run(
            command,
            cwd=staging_root,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env={**os.environ, "TZ": "UTC"},
        )
        if result.returncode != 0:
            raise PackageError(
                f"7-Zip failed for {archive.name} with exit code {result.returncode}:\n{result.stdout}"
            )
    finally:
        list_file.unlink(missing_ok=True)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_sha_file(path: Path, digest: str) -> None:
    path.with_name(path.name + ".sha256").write_text(
        f"{digest}  {path.name}\n",
        encoding="ascii",
    )


def main() -> int:
    args = parse_args()
    try:
        core_root = require_dir(args.core, "Core")
        database = require_file(args.database, "Rust database")
        output = Path(args.output).expanduser().resolve()
        sevenzip = find_sevenzip(args.sevenzip)
        rows = read_mcu_rows(database)
        groups, assigned, missing_definitions = build_groups(core_root, rows)

        if missing_definitions:
            message = (
                f"WARNING: {len(missing_definitions)} MCU database row(s) have SYSTEM_LIB but no definition in this core checkout: "
                + ", ".join(missing_definitions[:20])
                + (" ..." if len(missing_definitions) > 20 else "")
            )
            print(message, file=sys.stderr)
            if args.fail_missing_definitions:
                raise PackageError(message.replace("WARNING: ", ""))

        definitions = definition_index(core_root)
        unassigned = sorted(
            (path.stem for key, path in definitions.items() if key not in assigned),
            key=str.casefold,
        )
        if unassigned:
            message = (
                f"WARNING: {len(unassigned)} core MCU definition(s) have no MCU row with SYSTEM_LIB: "
                + ", ".join(unassigned[:20])
                + (" ..." if len(unassigned) > 20 else "")
            )
            print(message, file=sys.stderr)
            if args.fail_unassigned:
                raise PackageError(message.replace("WARNING: ", ""))

        shutil.rmtree(output, ignore_errors=True)
        output.mkdir(parents=True, exist_ok=True)

        rows_by_platform: dict[Path, list[McuRow]] = {}
        definition_by_name = definition_index(core_root)
        for row in rows:
            definition = definition_by_name.get(row.name.casefold())
            if definition:
                rows_by_platform.setdefault(definition.parent.parent, []).append(row)

        catalog_packages = []
        with tempfile.TemporaryDirectory(prefix="rust-core-packages-") as temp:
            temp_root = Path(temp)
            for index, group in enumerate(groups, start=1):
                staging = temp_root / group.package_name
                staging.mkdir(parents=True)
                stage_package(
                    core_root,
                    group,
                    rows_by_platform.get(group.platform_root, group.rows),
                    staging,
                )

                archive = output / f"{group.package_name}.7z"
                print(
                    f"[{index}/{len(groups)}] {group.package_name}: "
                    f"{len(group.mcus)} MCU(s), {', '.join(group.families)}"
                )
                build_archive(sevenzip, staging, archive)
                digest = sha256(archive)
                write_sha_file(archive, digest)
                catalog_packages.append(
                    {
                        "name": group.package_name,
                        "asset": archive.name,
                        "sha256": digest,
                        "size": archive.stat().st_size,
                        "architecture": group.architecture,
                        "platform": group.platform_relative.as_posix(),
                        "systemLib": group.system_lib,
                        "families": group.families,
                        "mcuCount": len(group.mcus),
                    }
                )
                shutil.rmtree(staging, ignore_errors=True)

        catalog = {
            "schemaVersion": SCHEMA_VERSION,
            "packages": sorted(catalog_packages, key=lambda item: item["name"]),
        }
        catalog_path = output / CATALOG_NAME
        catalog_path.write_text(
            json.dumps(catalog, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        catalog_digest = sha256(catalog_path)
        write_sha_file(catalog_path, catalog_digest)

        print(f"\nCreated {len(catalog_packages)} package(s) in {output}")
        print(f"Catalog: {catalog_path}")
        return 0
    except PackageError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
