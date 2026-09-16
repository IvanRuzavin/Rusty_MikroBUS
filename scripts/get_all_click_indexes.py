#!/usr/bin/env python3
"""Generate C Click and/or Demo metadata JSON from the package Elasticsearch index."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from elasticsearch import Elasticsearch


def fetch_current_indexed_packages(es: Elasticsearch, index_name: str):
    query_search = {"size": 5000, "query": {"match_all": {}}}
    response = None

    for retry in range(1, 11):
        try:
            response = es.search(index=index_name, body=query_search)
            if not response.get("timed_out", False):
                break
            print(f"Search query timed out - retry number {retry}")
        except Exception as exc:
            print(f"Executing search query - retry number {retry}: {exc}")
        time.sleep(1)

    if response is None:
        raise RuntimeError(
            f"Failed to retrieve packages from Elasticsearch index '{index_name}' after 10 attempts."
        )
    if response.get("timed_out", False):
        raise RuntimeError(
            f"Elasticsearch search on index '{index_name}' timed out after 10 attempts."
        )

    all_packages = []
    for hit in response.get("hits", {}).get("hits", []):
        source = hit.get("_source", {})
        if "name" in source:
            all_packages.append(source)

    all_packages.sort(key=lambda item: item.get("name", "").lower())
    return all_packages


def build_click_metadata(all_packages):
    metadata_clicks = {}
    click_count = 0

    for item in all_packages:
        if item.get("type") != "click":
            continue
        link = item.get("link")
        name = item.get("display_name")
        if not link:
            print(f"Skipping Click '{item.get('name', 'UNKNOWN')}' because it has no link.")
            continue

        categories = item.get("categories", [])
        if not categories:
            print(f"Skipping Click '{item.get('name', 'UNKNOWN')}' because it has no categories.")
            continue
        category = categories[0].get("slug")
        if not category:
            print(
                f"Skipping Click '{item.get('name', 'UNKNOWN')}' because its first category has no slug."
            )
            continue

        metadata_clicks.setdefault(category, []).append({"name": name, "download_link": link})
        click_count += 1

    for category in metadata_clicks:
        metadata_clicks[category].sort(key=lambda item: (item.get("name") or "").lower())
    metadata_clicks = dict(sorted(metadata_clicks.items(), key=lambda item: item[0].lower()))
    return metadata_clicks, click_count


def build_demo_metadata(all_packages):
    metadata_demos = []
    demo_count = 0

    for item in all_packages:
        if item.get("type") != "project":
            continue
        link = item.get("link")
        name = item.get("display_name")
        if not link:
            print(f"Skipping Demo '{item.get('name', 'UNKNOWN')}' because it has no link.")
            continue
        metadata_demos.append({"name": name, "download_link": link})
        demo_count += 1

    metadata_demos.sort(key=lambda item: (item.get("name") or "").lower())
    return metadata_demos, demo_count


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("index", help="Click and Demo packages Elasticsearch index.")
    parser.add_argument("es_host", help="Elasticsearch host.")
    parser.add_argument("es_user", help="Elasticsearch user.")
    parser.add_argument("es_password", help="Elasticsearch password.")
    parser.add_argument(
        "--kind",
        choices=("all", "clicks", "demos"),
        default="all",
        help="Metadata family to write. Defaults to both for backwards compatibility.",
    )
    parser.add_argument(
        "--output-dir",
        default=".",
        help="Destination directory for generated metadata JSON.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    es = None
    for retry in range(1, 11):
        try:
            es = Elasticsearch([args.es_host], http_auth=(args.es_user, args.es_password))
            if es.ping():
                print("Connected to Elasticsearch.")
                break
        except Exception as exc:
            print(f"Elasticsearch connection attempt {retry} failed: {exc}")
        if retry == 10:
            raise RuntimeError("Connection to Elasticsearch failed!")
        time.sleep(1)

    all_packages = fetch_current_indexed_packages(es, args.index)
    print(f"Found {len(all_packages)} indexed packages.")

    output = Path(args.output_dir).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)

    if args.kind in {"all", "clicks"}:
        metadata_clicks, click_count = build_click_metadata(all_packages)
        click_path = output / "metadata_clicks_c.json"
        click_path.write_text(
            json.dumps(metadata_clicks, indent=4, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(
            f"Created {click_path.name} with {click_count} Click entries in "
            f"{len(metadata_clicks)} categories."
        )

    if args.kind in {"all", "demos"}:
        metadata_demos, demo_count = build_demo_metadata(all_packages)
        demo_path = output / "metadata_demos_c.json"
        demo_path.write_text(
            json.dumps(metadata_demos, indent=4, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"Created {demo_path.name} with {demo_count} Demo entries.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
