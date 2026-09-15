#!/usr/bin/env python3
"""Build deterministic Rust Board BSP packages from Board and Shield tables.

Every enabled Board with BSP_PATH becomes board_<BOARD_UID>.7z.
Every enabled Shield with BSP_PATH becomes shield_<SHIELD_UID>.7z.
Shields intentionally live in the Board package release because they are selected
as an overlay of a board setup, while MCUCard packages have their own release.
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

SCHEMA_VERSION = 1
CATALOG_NAME = "rust_board_packages.json"
PACKAGE_MARKER = ".rust-board-package.json"

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
        return f"{self.entity_type}_{safe_id(self.uid)}"

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bsp", default="bsp", help="Path to the BSP source directory.")
    parser.add_argument("--database", required=True, help="Path to database.db.")
    parser.add_argument("--output", default="dist/rust-board-packages")
    parser.add_argument("--sevenzip", default="")
    return parser.parse_args()

def required_directory(value: str, label: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_dir(): raise PackageError(f"{label} directory does not exist: {path}")
    return path

def required_file(value: str, label: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_file(): raise PackageError(f"{label} file does not exist: {path}")
    return path

def resolve_sevenzip(configured: str) -> str:
    if configured:
        path = Path(configured).expanduser().resolve()
        if not path.is_file(): raise PackageError(f"7-Zip executable does not exist: {path}")
        return str(path)
    for name in ("7zz", "7z", "7za"):
        executable = shutil.which(name)
        if executable: return executable
    raise PackageError("7-Zip was not found. Install 7z/7zz/7za or pass --sevenzip.")

def table_names(db: sqlite3.Connection) -> set[str]:
    return {str(row[0]) for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}

def column_names(db: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]).upper() for row in db.execute(f"PRAGMA table_info({table})")}

def validate_schema(database: Path) -> None:
    required = {"Board": {"UID", "NAME", "BSP_PATH", "ENABLED"}, "Shield": {"UID", "NAME", "BSP_PATH", "ENABLED"}}
    with sqlite3.connect(database) as db:
        tables = table_names(db)
        for table, columns in required.items():
            if table not in tables: raise PackageError(f"{database}: missing table {table}")
            missing = columns - column_names(db, table)
            if missing: raise PackageError(f"{database}: table {table} is missing columns: {', '.join(sorted(missing))}")

def safe_id(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value).strip()).strip("._-").lower()
    if not text: raise PackageError(f"Cannot create package name from empty/invalid UID: {value!r}")
    return text

def scalar(db: sqlite3.Connection, sql: str, *params: Any) -> int:
    try: row = db.execute(sql, params).fetchone()
    except sqlite3.OperationalError: return 0
    return int(row[0] if row and row[0] is not None else 0)

def read_entities(database: Path) -> list[Entity]:
    entities: list[Entity] = []
    skipped: list[str] = []
    with sqlite3.connect(database) as db:
        tables = table_names(db)
        for uid, name, bsp_path in db.execute("SELECT UID, NAME, BSP_PATH FROM Board WHERE ENABLED = 1 ORDER BY NAME COLLATE NOCASE, UID"):
            uid, bsp_path = str(uid or "").strip(), str(bsp_path or "").strip()
            if not uid or not bsp_path:
                skipped.append(f"Board {name or uid or '<unknown>'}: empty UID/BSP_PATH"); continue
            entities.append(Entity("board", uid, str(name or uid), bsp_path, {
                "directMcuCount": scalar(db, "SELECT COUNT(DISTINCT DEVICE_NAME) FROM BoardToDevice WHERE BOARD_UID = ?", uid) if "BoardToDevice" in tables else 0,
                "cardCount": scalar(db, "SELECT COUNT(DISTINCT CARD_UID) FROM BoardToCard WHERE BOARD_UID = ?", uid) if "BoardToCard" in tables else 0,
                "shieldCount": scalar(db, "SELECT COUNT(DISTINCT SHIELD_UID) FROM BoardToShield WHERE BOARD_UID = ?", uid) if "BoardToShield" in tables else 0,
            }))
        for uid, name, bsp_path in db.execute("SELECT UID, NAME, BSP_PATH FROM Shield WHERE ENABLED = 1 ORDER BY NAME COLLATE NOCASE, UID"):
            uid, bsp_path = str(uid or "").strip(), str(bsp_path or "").strip()
            if not uid or not bsp_path:
                skipped.append(f"Shield {name or uid or '<unknown>'}: empty UID/BSP_PATH"); continue
            entities.append(Entity("shield", uid, str(name or uid), bsp_path, {
                "boardCount": scalar(db, "SELECT COUNT(DISTINCT BOARD_UID) FROM BoardToShield WHERE SHIELD_UID = ?", uid) if "BoardToShield" in tables else 0,
            }))
    for message in skipped: print(f"WARNING: {message}", file=sys.stderr)
    if not entities: raise PackageError("No enabled Board/Shield rows with BSP_PATH were found.")
    names: dict[str, Entity] = {}
    for entity in entities:
        key = entity.package_name.casefold()
        if key in names and names[key] != entity: raise PackageError(f"Package-name collision for {entity.package_name}")
        names[key] = entity
    return sorted(entities, key=lambda item: (item.entity_type, item.display_name.casefold(), item.uid.casefold()))

def resolve_bsp_file(bsp_root: Path, configured_path: str) -> tuple[Path, Path]:
    portable = str(configured_path or "").strip().replace("\\", "/").lstrip("/")
    if portable.casefold().startswith("bsp/"): portable = portable[4:]
    if not portable: raise PackageError("Database contains an empty BSP_PATH.")
    relative = Path(portable)
    resolved = (bsp_root / relative).resolve()
    try: resolved.relative_to(bsp_root.resolve())
    except ValueError as exc: raise PackageError(f"BSP path escapes the BSP root: {configured_path}") from exc
    if not resolved.is_file(): raise PackageError(f"Required BSP file does not exist: {resolved}")
    return resolved, relative

def stage_entity(bsp_root: Path, entity: Entity, destination: Path) -> dict[str, Any]:
    source, relative = resolve_bsp_file(bsp_root, entity.bsp_path)
    target = destination / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    metadata = {"schemaVersion": SCHEMA_VERSION, "packageName": entity.package_name, "entityType": entity.entity_type, "uid": entity.uid,
                "displayName": entity.display_name, "bspPath": entity.bsp_path.replace("\\", "/"), "relativeBspPath": relative.as_posix(), **entity.relation_counts}
    (destination / PACKAGE_MARKER).write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return metadata

def normalize_timestamps(root: Path) -> None:
    epoch = 946684800
    for item in sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        try: os.utime(item, (epoch, epoch), follow_symlinks=False)
        except OSError: pass
    os.utime(root, (epoch, epoch), follow_symlinks=False)

def create_archive(sevenzip: str, stage: Path, output: Path) -> None:
    normalize_timestamps(stage)
    files = sorted(item.relative_to(stage).as_posix() for item in stage.rglob("*") if item.is_file() or item.is_symlink())
    if not files: raise PackageError(f"Refusing to create empty package {output.name}")
    output.parent.mkdir(parents=True, exist_ok=True); output.unlink(missing_ok=True)
    file_list = stage.parent / f"{output.stem}.files.txt"; file_list.write_text("\n".join(files) + "\n", encoding="utf-8")
    try:
        result = subprocess.run([sevenzip, "a", "-t7z", "-mx=9", "-mmt=off", "-mtc=off", "-mtm=off", "-mta=off", str(output), f"@{file_list}"], cwd=stage, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env={**os.environ, "TZ": "UTC"})
        if result.returncode: raise PackageError(f"7-Zip failed for {output.name}:\n{result.stdout}")
    finally: file_list.unlink(missing_ok=True)

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""): digest.update(chunk)
    return digest.hexdigest()

def main() -> int:
    options = parse_args()
    try:
        bsp_root = required_directory(options.bsp, "BSP"); database = required_file(options.database, "Rust database")
        validate_schema(database); sevenzip = resolve_sevenzip(options.sevenzip); entities = read_entities(database)
        output = Path(options.output).expanduser().resolve(); shutil.rmtree(output, ignore_errors=True); output.mkdir(parents=True, exist_ok=True)
        catalog_entries: list[dict[str, Any]] = []
        with tempfile.TemporaryDirectory(prefix="rust-board-packages-") as temp_dir:
            temp = Path(temp_dir)
            for index, entity in enumerate(entities, start=1):
                stage = temp / entity.package_name; stage.mkdir(parents=True)
                metadata = stage_entity(bsp_root, entity, stage); archive = output / f"{entity.package_name}.7z"
                print(f"[{index}/{len(entities)}] {entity.entity_type:<6} {entity.display_name} [{entity.uid}] -> {archive.name}")
                create_archive(sevenzip, stage, archive)
                catalog_entries.append({"name": entity.package_name, **metadata, "asset": archive.name, "sha256": sha256(archive), "size": archive.stat().st_size})
        counts = {kind: sum(1 for entity in entities if entity.entity_type == kind) for kind in ("board", "shield")}
        catalog = {"schemaVersion": SCHEMA_VERSION, "packageModel": "board-entity", "counts": counts,
                   "packages": sorted(catalog_entries, key=lambda item: (item["entityType"], str(item["displayName"]).casefold(), str(item["uid"]).casefold()))}
        (output / CATALOG_NAME).write_text(json.dumps(catalog, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"Created {len(catalog_entries)} Rust Board packages ({counts['board']} boards, {counts['shield']} shields) in {output}")
        return 0
    except PackageError as error:
        print(f"ERROR: {error}", file=sys.stderr); return 1

if __name__ == "__main__": raise SystemExit(main())
