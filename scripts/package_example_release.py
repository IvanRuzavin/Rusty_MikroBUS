#!/usr/bin/env python3
"""Build deterministic Rust Click or Demo assets for a dedicated fixed GitHub release.

The C example archives remain referenced by the Elasticsearch-generated metadata.
This packager owns the Rust examples stored in this repository and writes the Rust
metadata JSON next to those archives so each example family can be released
independently from the General Release.
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
from urllib.parse import quote

SCHEMA_VERSION = 1
FIXED_EPOCH = 946684800  # 2000-01-01 UTC


class PackageError(RuntimeError):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("clicks", "demos"))
    parser.add_argument("--source", required=True, help="clicks/ or demos/ source directory")
    parser.add_argument("--output", required=True, help="release output directory")
    parser.add_argument("--repository", required=True, help="GitHub owner/repository used in download URLs")
    parser.add_argument("--release-tag", required=True, help="Fixed GitHub release tag")
    parser.add_argument("--sevenzip", default="")
    return parser.parse_args()


def require_dir(value: str, label: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise PackageError(f"{label} directory does not exist: {path}")
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


def create_archive(sevenzip: str, source: Path, output: Path, temp: Path) -> None:
    stage = temp / f"stage-{output.stem}"
    shutil.rmtree(stage, ignore_errors=True)
    shutil.copytree(source, stage, symlinks=True)
    normalize_timestamps(stage)

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


def safe_asset_stem(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip()).strip("._-")
    if not text:
        raise PackageError(f"Cannot create package name from {value!r}")
    return text


def display_name(folder_name: str, suffix: str) -> str:
    return f"{folder_name.replace('_', ' ').title()} {suffix}"


def release_download_url(repository: str, tag: str, asset: str) -> str:
    return (
        f"https://github.com/{repository}/releases/download/"
        f"{quote(tag, safe='')}/{quote(asset, safe='')}"
    )


def child_dirs(root: Path) -> list[Path]:
    return sorted(
        (item for item in root.iterdir() if item.is_dir() and not item.name.startswith(".")),
        key=lambda p: p.name.casefold(),
    )


def main() -> int:
    options = parse_args()
    try:
        source = require_dir(options.source, options.kind.title())
        sevenzip = resolve_sevenzip(options.sevenzip)
        output = Path(options.output).expanduser().resolve()
        output.mkdir(parents=True, exist_ok=True)

        is_click = options.kind == "clicks"
        prefix = "rust_click" if is_click else "rust_demo"
        suffix = "Click" if is_click else "Demo"
        metadata_name = "metadata_clicks_rust.json" if is_click else "metadata_demos_rust.json"
        manifest_name = "click_packages_manifest.json" if is_click else "demo_packages_manifest.json"
        asset_kind = "rust-click" if is_click else "rust-demo"
        c_metadata_name = "metadata_clicks_c.json" if is_click else "metadata_demos_c.json"

        # The dedicated release owns one example family. Remove local Rust assets
        # from a previous packaging pass, while intentionally preserving the C
        # metadata file generated from Elasticsearch in the same output directory.
        for stale in output.glob(f"{prefix}_*.7z"):
            stale.unlink()
        (output / metadata_name).unlink(missing_ok=True)
        (output / manifest_name).unlink(missing_ok=True)

        items: list[dict[str, str]] = []
        assets: list[dict[str, object]] = []
        with tempfile.TemporaryDirectory(prefix=f"{options.kind}-release-") as temp_dir:
            temp = Path(temp_dir)
            folders = child_dirs(source)
            for index, folder in enumerate(folders, start=1):
                stem = safe_asset_stem(folder.name)
                asset_name = f"{prefix}_{stem}.7z"
                archive = output / asset_name
                print(f"[{index}/{len(folders)}] Packing {suffix} {folder.name} -> {asset_name}")
                create_archive(sevenzip, folder, archive, temp)
                items.append({
                    "name": display_name(folder.name, suffix),
                    "download_link": release_download_url(
                        options.repository, options.release_tag, asset_name
                    ),
                })
                assets.append({
                    "name": asset_name,
                    "kind": asset_kind,
                    "source": folder.name,
                    "sha256": sha256(archive),
                    "size": archive.stat().st_size,
                })

        sorted_items = sorted(items, key=lambda item: item["name"].casefold())
        metadata: object = {"Rust": sorted_items} if is_click else sorted_items
        metadata_path = output / metadata_name
        metadata_path.write_text(
            json.dumps(metadata, indent=4, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        assets.append({
            "name": metadata_name,
            "kind": f"{asset_kind}-metadata",
            "sha256": sha256(metadata_path),
            "size": metadata_path.stat().st_size,
        })

        c_metadata_path = output / c_metadata_name
        if c_metadata_path.is_file():
            assets.append({
                "name": c_metadata_name,
                "kind": "c-click-metadata" if is_click else "c-demo-metadata",
                "sha256": sha256(c_metadata_path),
                "size": c_metadata_path.stat().st_size,
            })

        manifest = {
            "schemaVersion": SCHEMA_VERSION,
            "packageModel": "click-examples" if is_click else "demo-examples",
            "releaseTag": options.release_tag,
            "rustPackageCount": len(sorted_items),
            "assets": sorted(assets, key=lambda item: str(item["name"]).casefold()),
        }
        manifest_path = output / manifest_name
        manifest_path.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

        print(f"Created {len(sorted_items)} Rust {suffix} package(s) in {output}")
        return 0
    except PackageError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
