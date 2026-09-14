#!/usr/bin/env python3
"""Build deterministic Rust BSP packages per Board, MCUCard and Shield.

The Rust BSP database is the source of truth. Every enabled database entity with
an applicable BSP_PATH becomes an independent package:

    Board    -> board_<BOARD_UID>.7z
    MCUCard  -> card_<MCUCARD_UID>.7z
    Shield   -> shield_<SHIELD_UID>.7z

The package keeps the BSP file at the same path relative to bsp/ so multiple
installed packages can be materialized into one temporary sdk/bsp overlay.
Relationships (BoardToDevice, BoardToCard, CardToMCU and BoardToShield) remain
in the database and are intentionally not encoded into package membership.

The resulting rust_bsp_packages.json is used by the VS Code extension to map
an exact entity UID to the corresponding release asset and SHA-256 digest.
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
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 2
CATALOG_NAME = "rust_bsp_packages.json"
PACKAGE_MARKER = ".rust-bsp-package.json"


class PackageError(RuntimeError):
    pass


@dataclass(frozen=True)
class Entity:
    entity_type: str
    uid: str
    display_name: str
    bsp_path: str
    relation_counts: dict[str, int]

    @property
    def package_name(self) -> str:
        prefix = {
            "board": "board",
            "card": "card",
            "shield": "shield",
        }[self.entity_type]
        return f"{prefix}_{safe_id(self.uid)}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bsp", default="bsp", help="Path to the BSP source directory.")
    parser.add_argument("--database", required=True, help="Path to database_mikro_sdk_rust.db.")
    parser.add_argument("--output", default="dist/rust-bsp-packages")
    parser.add_argument("--sevenzip", default="")
    return parser.parse_args()


def required_directory(value: str, label: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise PackageError(f"{label} directory does not exist: {path}")
    return path


def required_file(value: str, label: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise PackageError(f"{label} file does not exist: {path}")
    return path


def resolve_sevenzip(configured: str) -> str:
    if configured:
        path = Path(configured).expanduser().resolve()
        if not path.is_file():
            raise PackageError(f"7-Zip executable does not exist: {path}")
        return str(path)
    for name in ("7zz", "7z", "7za"):
        executable = shutil.which(name)
        if executable:
            return executable
    raise PackageError("7-Zip was not found. Install 7z/7zz/7za or pass --sevenzip.")


def table_names(db: sqlite3.Connection) -> set[str]:
    return {
        str(row[0])
        for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def column_names(db: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]).upper() for row in db.execute(f"PRAGMA table_info({table})")}


def validate_schema(database: Path) -> None:
    required = {
        "Board": {"UID", "NAME", "BSP_PATH", "ENABLED"},
        "MCUCard": {"UID", "NAME", "BSP_PATH", "ENABLED"},
        "Shield": {"UID", "NAME", "BSP_PATH", "ENABLED"},
    }
    with sqlite3.connect(database) as db:
        tables = table_names(db)
        for table, columns in required.items():
            if table not in tables:
                raise PackageError(f"{database}: missing table {table}")
            missing = columns - column_names(db, table)
            if missing:
                raise PackageError(
                    f"{database}: table {table} is missing columns: {', '.join(sorted(missing))}"
                )


def safe_id(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value).strip()).strip("._-").lower()
    if not text:
        raise PackageError(f"Cannot create package name from empty/invalid UID: {value!r}")
    return text


def scalar(db: sqlite3.Connection, sql: str, *params: Any) -> int:
    try:
        row = db.execute(sql, params).fetchone()
    except sqlite3.OperationalError:
        return 0
    return int(row[0] if row and row[0] is not None else 0)


def read_entities(database: Path) -> list[Entity]:
    entities: list[Entity] = []
    skipped: list[str] = []
    with sqlite3.connect(database) as db:
        tables = table_names(db)

        for uid, name, bsp_path in db.execute(
            """
            SELECT UID, NAME, BSP_PATH
            FROM Board
            WHERE ENABLED = 1
            ORDER BY NAME COLLATE NOCASE, UID
            """
        ):
            uid = str(uid or "").strip()
            bsp_path = str(bsp_path or "").strip()
            if not uid or not bsp_path:
                skipped.append(f"Board {name or uid or '<unknown>'}: empty UID/BSP_PATH")
                continue
            counts = {
                "directMcuCount": scalar(db, "SELECT COUNT(DISTINCT DEVICE_NAME) FROM BoardToDevice WHERE BOARD_UID = ?", uid)
                if "BoardToDevice" in tables else 0,
                "cardCount": scalar(db, "SELECT COUNT(DISTINCT CARD_UID) FROM BoardToCard WHERE BOARD_UID = ?", uid)
                if "BoardToCard" in tables else 0,
                "shieldCount": scalar(db, "SELECT COUNT(DISTINCT SHIELD_UID) FROM BoardToShield WHERE BOARD_UID = ?", uid)
                if "BoardToShield" in tables else 0,
            }
            entities.append(Entity("board", uid, str(name or uid), bsp_path, counts))

        for uid, name, bsp_path in db.execute(
            """
            SELECT UID, NAME, BSP_PATH
            FROM MCUCard
            WHERE ENABLED = 1
            ORDER BY NAME COLLATE NOCASE, UID
            """
        ):
            uid = str(uid or "").strip()
            bsp_path = str(bsp_path or "").strip()
            if not uid or not bsp_path:
                skipped.append(f"MCUCard {name or uid or '<unknown>'}: empty UID/BSP_PATH")
                continue
            counts = {
                "mcuCount": scalar(db, "SELECT COUNT(DISTINCT DEVICE_NAME) FROM CardToMCU WHERE CARD_UID = ?", uid)
                if "CardToMCU" in tables else 0,
                "boardCount": scalar(db, "SELECT COUNT(DISTINCT BOARD_UID) FROM BoardToCard WHERE CARD_UID = ?", uid)
                if "BoardToCard" in tables else 0,
            }
            entities.append(Entity("card", uid, str(name or uid), bsp_path, counts))

        for uid, name, bsp_path in db.execute(
            """
            SELECT UID, NAME, BSP_PATH
            FROM Shield
            WHERE ENABLED = 1
            ORDER BY NAME COLLATE NOCASE, UID
            """
        ):
            uid = str(uid or "").strip()
            bsp_path = str(bsp_path or "").strip()
            if not uid or not bsp_path:
                skipped.append(f"Shield {name or uid or '<unknown>'}: empty UID/BSP_PATH")
                continue
            counts = {
                "boardCount": scalar(db, "SELECT COUNT(DISTINCT BOARD_UID) FROM BoardToShield WHERE SHIELD_UID = ?", uid)
                if "BoardToShield" in tables else 0,
            }
            entities.append(Entity("shield", uid, str(name or uid), bsp_path, counts))

    names: dict[str, Entity] = {}
    for entity in entities:
        key = entity.package_name.casefold()
        previous = names.get(key)
        if previous and (previous.entity_type, previous.uid) != (entity.entity_type, entity.uid):
            raise PackageError(
                f"Package-name collision: {previous.entity_type}:{previous.uid} and "
                f"{entity.entity_type}:{entity.uid} both map to {entity.package_name}"
            )
        names[key] = entity

    for message in skipped:
        print(f"WARNING: {message}", file=sys.stderr)

    if not entities:
        raise PackageError("No enabled Board/MCUCard/Shield rows with BSP_PATH were found.")
    return sorted(entities, key=lambda item: (item.entity_type, item.display_name.casefold(), item.uid.casefold()))


def resolve_bsp_file(bsp_root: Path, configured_path: str) -> tuple[Path, Path]:
    portable = str(configured_path or "").strip().replace("\\", "/").lstrip("/")
    if portable.casefold().startswith("bsp/"):
        portable = portable[4:]
    if not portable:
        raise PackageError("Database contains an empty BSP_PATH.")

    relative = Path(portable)
    resolved = (bsp_root / relative).resolve()
    try:
        resolved.relative_to(bsp_root.resolve())
    except ValueError as exc:
        raise PackageError(f"BSP path escapes the BSP root: {configured_path}") from exc
    if not resolved.is_file():
        raise PackageError(f"Required BSP file does not exist: {resolved}")
    return resolved, relative


def stage_entity(bsp_root: Path, entity: Entity, destination: Path) -> dict[str, Any]:
    source, relative = resolve_bsp_file(bsp_root, entity.bsp_path)
    target = destination / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)

    metadata: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "packageName": entity.package_name,
        "entityType": entity.entity_type,
        "uid": entity.uid,
        "displayName": entity.display_name,
        "bspPath": entity.bsp_path.replace("\\", "/"),
        "relativeBspPath": relative.as_posix(),
        **entity.relation_counts,
    }
    (destination / PACKAGE_MARKER).write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return metadata


def normalize_timestamps(root: Path) -> None:
    epoch = 946684800  # 2000-01-01 UTC
    for path in sorted(root.rglob("*"), key=lambda item: len(item.parts), reverse=True):
        try:
            os.utime(path, (epoch, epoch), follow_symlinks=False)
        except OSError:
            pass
    os.utime(root, (epoch, epoch), follow_symlinks=False)


def create_archive(sevenzip: str, stage: Path, output: Path) -> None:
    normalize_timestamps(stage)
    files = sorted(
        item.relative_to(stage).as_posix()
        for item in stage.rglob("*")
        if item.is_file() or item.is_symlink()
    )
    if not files:
        raise PackageError(f"Refusing to create empty package {output.name}")

    output.parent.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    file_list = stage.parent / f"{output.stem}.files.txt"
    file_list.write_text("\n".join(files) + "\n", encoding="utf-8")
    try:
        result = subprocess.run(
            [
                sevenzip,
                "a",
                "-t7z",
                "-mx=9",
                "-mmt=off",
                "-mtc=off",
                "-mtm=off",
                "-mta=off",
                str(output),
                f"@{file_list}",
            ],
            cwd=stage,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env={**os.environ, "TZ": "UTC"},
        )
        if result.returncode:
            raise PackageError(f"7-Zip failed for {output.name}:\n{result.stdout}")
    finally:
        file_list.unlink(missing_ok=True)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    options = parse_args()
    try:
        bsp_root = required_directory(options.bsp, "BSP")
        database = required_file(options.database, "Rust database")
        validate_schema(database)
        sevenzip = resolve_sevenzip(options.sevenzip)
        entities = read_entities(database)

        output = Path(options.output).expanduser().resolve()
        shutil.rmtree(output, ignore_errors=True)
        output.mkdir(parents=True, exist_ok=True)
        catalog_entries: list[dict[str, Any]] = []

        with tempfile.TemporaryDirectory(prefix="rust-bsp-entity-packages-") as temp_dir:
            temp = Path(temp_dir)
            for index, entity in enumerate(entities, start=1):
                stage = temp / entity.package_name
                stage.mkdir(parents=True)
                metadata = stage_entity(bsp_root, entity, stage)
                archive = output / f"{entity.package_name}.7z"
                print(
                    f"[{index}/{len(entities)}] {entity.entity_type:<6} "
                    f"{entity.display_name} [{entity.uid}] -> {archive.name}"
                )
                create_archive(sevenzip, stage, archive)
                catalog_entries.append(
                    {
                        "name": entity.package_name,
                        **metadata,
                        "asset": archive.name,
                        "sha256": sha256(archive),
                        "size": archive.stat().st_size,
                    }
                )

        counts = {
            entity_type: sum(1 for item in entities if item.entity_type == entity_type)
            for entity_type in ("board", "card", "shield")
        }
        catalog = {
            "schemaVersion": SCHEMA_VERSION,
            "packageModel": "entity",
            "counts": counts,
            "packages": sorted(
                catalog_entries,
                key=lambda item: (
                    item["entityType"],
                    str(item["displayName"]).casefold(),
                    str(item["uid"]).casefold(),
                ),
            ),
        }
        catalog_path = output / CATALOG_NAME
        catalog_path.write_text(
            json.dumps(catalog, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(
            f"Created {len(catalog_entries)} BSP packages "
            f"({counts['board']} boards, {counts['card']} cards, {counts['shield']} shields) in {output}"
        )
        return 0
    except PackageError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
