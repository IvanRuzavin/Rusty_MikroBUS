#!/usr/bin/env python3
"""Build deterministic shared assets for the Rusty_MikroBUS General Release.

Packages:
  - sdk.7z from sdk/
  - mikroc_cmake.7z from mikroc_cmake/
  - database.db copied unchanged
  - sdk_manifest.json copied from sdk/manifest.json for inexpensive update checks
  - general_release_manifest.json with hashes/sizes/version summary

Click and Demo examples deliberately live in their own fixed releases
(`click-packages` and `demo-packages`) and are not part of this release.

The SDK version is controlled manually by sdk/manifest.json. Bump its `version`
field only when you want clients to report an SDK update.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
FIXED_EPOCH = 946684800  # 2000-01-01 UTC


class PackageError(RuntimeError):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk", default="sdk")
    parser.add_argument("--database", default="database.db")
    parser.add_argument("--mikroc-cmake", default="mikroc_cmake")
    parser.add_argument("--output", default="dist/general-release")
    parser.add_argument("--sevenzip", default="")
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


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_timestamps(root: Path) -> None:
    for item in sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        try:
            os.utime(item, (FIXED_EPOCH, FIXED_EPOCH), follow_symlinks=False)
        except OSError:
            pass
    os.utime(root, (FIXED_EPOCH, FIXED_EPOCH), follow_symlinks=False)


def copy_tree_for_archive(source: Path, stage: Path) -> None:
    shutil.copytree(source, stage, symlinks=True)
    normalize_timestamps(stage)


def create_archive(sevenzip: str, source: Path, output: Path, temp: Path) -> None:
    stage = temp / f"stage-{output.stem}"
    if stage.exists():
        shutil.rmtree(stage)
    copy_tree_for_archive(source, stage)

    files = sorted(
        item.relative_to(stage).as_posix()
        for item in stage.rglob("*")
        if item.is_file() or item.is_symlink()
    )
    if not files:
        raise PackageError(f"Refusing to create empty archive from {source}")

    output.parent.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    file_list = temp / f"{output.stem}.files.txt"
    file_list.write_text("\n".join(files) + "\n", encoding="utf-8")
    try:
        result = subprocess.run(
            [
                sevenzip, "a", "-t7z", "-mx=9", "-mmt=off",
                "-mtc=off", "-mtm=off", "-mta=off", str(output), f"@{file_list}",
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


def read_sdk_manifest(sdk_root: Path) -> dict[str, Any]:
    manifest_path = sdk_root / "manifest.json"
    if not manifest_path.is_file():
        raise PackageError(
            f"SDK manifest is missing: {manifest_path}. Create sdk/manifest.json with at least {{\"version\": \"0.1.0\"}}."
        )
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PackageError(f"Invalid SDK manifest JSON: {exc}") from exc
    version = str(manifest.get("version") or "").strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", version):
        raise PackageError(f"sdk/manifest.json version must be a semantic version, got {version!r}")
    return manifest


def main() -> int:
    options = parse_args()
    try:
        sdk = require_dir(options.sdk, "SDK")
        database = require_file(options.database, "Rust database")
        mikroc_cmake = require_dir(options.mikroc_cmake, "mikroc_cmake")
        sevenzip = resolve_sevenzip(options.sevenzip)
        sdk_manifest = read_sdk_manifest(sdk)

        output = Path(options.output).expanduser().resolve()
        shutil.rmtree(output, ignore_errors=True)
        output.mkdir(parents=True, exist_ok=True)

        assets: list[dict[str, Any]] = []
        with tempfile.TemporaryDirectory(prefix="general-release-") as temp_dir:
            temp = Path(temp_dir)
            for source, asset_name, kind in (
                (sdk, "sdk.7z", "sdk"),
                (mikroc_cmake, "mikroc_cmake.7z", "mikroc_cmake"),
            ):
                archive = output / asset_name
                print(f"Packing {source} -> {asset_name}")
                create_archive(sevenzip, source, archive, temp)
                assets.append({
                    "name": asset_name,
                    "kind": kind,
                    "sha256": sha256(archive),
                    "size": archive.stat().st_size,
                })

        database_out = output / "database.db"
        shutil.copy2(database, database_out)
        assets.append({
            "name": database_out.name,
            "kind": "database",
            "sha256": sha256(database_out),
            "size": database_out.stat().st_size,
        })

        sdk_manifest_out = output / "sdk_manifest.json"
        sdk_manifest_out.write_text(
            json.dumps(sdk_manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        assets.append({
            "name": sdk_manifest_out.name,
            "kind": "sdk-manifest",
            "sha256": sha256(sdk_manifest_out),
            "size": sdk_manifest_out.stat().st_size,
        })

        manifest = {
            "schemaVersion": SCHEMA_VERSION,
            "sdkVersion": str(sdk_manifest["version"]),
            "assets": sorted(assets, key=lambda item: item["name"].casefold()),
        }
        manifest_path = output / "general_release_manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

        print(f"General release assets created in {output}")
        print(f"SDK version: {sdk_manifest['version']}")
        return 0
    except PackageError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
