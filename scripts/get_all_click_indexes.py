import time
import argparse
import json

from datetime import datetime
from elasticsearch import Elasticsearch


def fetch_current_indexed_packages(es: Elasticsearch, index_name: str):
    query_search = {
        "size": 5000,
        "query": {
            "match_all": {}
        }
    }

    response = None

    for retry in range(1, 11):
        try:
            response = es.search(
                index=index_name,
                body=query_search
            )

            if not response.get("timed_out", False):
                break

            print(f"Search query timed out - retry number {retry}")

        except Exception as e:
            print(
                f"Executing search query - retry number {retry}: {e}"
            )

        time.sleep(1)

    if response is None:
        raise RuntimeError(
            f"Failed to retrieve packages from Elasticsearch index "
            f"'{index_name}' after 10 attempts."
        )

    if response.get("timed_out", False):
        raise RuntimeError(
            f"Elasticsearch search on index '{index_name}' "
            f"timed out after 10 attempts."
        )

    all_packages = []

    for hit in response.get("hits", {}).get("hits", []):
        source = hit.get("_source", {})

        if "name" not in source:
            continue

        all_packages.append(source)

    # Sort alphabetically by package name
    all_packages.sort(
        key=lambda x: x.get("name", "").lower()
    )

    return all_packages


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Create Click and Demo metadata JSON from Elasticsearch."
    )

    parser.add_argument(
        "index",
        help="SDK packages Elasticsearch index."
    )

    parser.add_argument(
        "es_host",
        help="Elasticsearch host.",
        type=str
    )

    parser.add_argument(
        "es_user",
        help="Elasticsearch user.",
        type=str
    )

    parser.add_argument(
        "es_password",
        help="Elasticsearch password.",
        type=str
    )

    args = parser.parse_args()

    # Connect to Elasticsearch
    es = None

    for retry in range(1, 11):
        try:
            # Elasticsearch Python client 7.x compatible
            es = Elasticsearch(
                [args.es_host],
                http_auth=(args.es_user, args.es_password)
            )

            if es.ping():
                print("Connected to Elasticsearch.")
                break

        except Exception as e:
            print(
                f"Elasticsearch connection attempt {retry} failed: {e}"
            )

        if retry == 10:
            raise RuntimeError("Connection to Elasticsearch failed!")

        time.sleep(1)

    current_date = datetime.now().strftime("%Y-%m-%d")

    # Get all indexed packages
    all_packages = fetch_current_indexed_packages(
        es,
        args.index
    )

    print(f"Found {len(all_packages)} indexed packages.")

    # ---------------------------------------------------------
    # Click metadata
    # ---------------------------------------------------------

    # Dictionary where each category contains a list of Clicks
    metadata_clicks = {}

    click_count = 0

    # ---------------------------------------------------------
    # Demo metadata
    # ---------------------------------------------------------

    # Projects/demos have no category, so keep them in a flat list
    metadata_demos = []

    demo_count = 0

    # ---------------------------------------------------------
    # Process all packages
    # ---------------------------------------------------------

    for item in all_packages:
        item_type = item.get("type")

        # =====================================================
        # CLICK
        # =====================================================

        if item_type == "click":
            link = item.get("link")
            name = item.get("display_name")

            if not link:
                print(
                    f"Skipping Click '{item.get('name', 'UNKNOWN')}' "
                    f"because it has no link."
                )
                continue

            categories = item.get("categories", [])

            if not categories:
                print(
                    f"Skipping Click '{item.get('name', 'UNKNOWN')}' "
                    f"because it has no categories."
                )
                continue

            category = categories[0].get("slug")

            if not category:
                print(
                    f"Skipping Click '{item.get('name', 'UNKNOWN')}' "
                    f"because its first category has no slug."
                )
                continue

            metadata_item = {
                "name": name,
                "download_link": link
            }

            # Create category array if it doesn't exist yet
            if category not in metadata_clicks:
                metadata_clicks[category] = []

            # Add Click to its category
            metadata_clicks[category].append(metadata_item)

            click_count += 1

        # =====================================================
        # PROJECT / DEMO
        # =====================================================

        elif item_type == "project":
            link = item.get("link")
            name = item.get("display_name")
            clicks = item.get("clicks")
            # click_names = []
            # for click in clicks:
            #     click_names.append(click['name'])

            if not link:
                print(
                    f"Skipping Demo '{item.get('name', 'UNKNOWN')}' "
                    f"because it has no link."
                )
                continue

            metadata_item = {
                "name": name,
                "download_link": link,
                # "clicks": click_names
            }

            metadata_demos.append(metadata_item)

            demo_count += 1

    # ---------------------------------------------------------
    # Sort entries
    # ---------------------------------------------------------

    # Sort Clicks inside every category by display name
    for category in metadata_clicks:
        metadata_clicks[category].sort(
            key=lambda x: (x.get("name") or "").lower()
        )

    # Sort categories alphabetically
    metadata_clicks = dict(
        sorted(
            metadata_clicks.items(),
            key=lambda x: x[0].lower()
        )
    )

    # Sort demos alphabetically
    metadata_demos.sort(
        key=lambda x: (x.get("name") or "").lower()
    )

    # ---------------------------------------------------------
    # Write Click metadata
    # ---------------------------------------------------------

    with open(
        "metadata_clicks_c.json",
        "w",
        encoding="utf-8"
    ) as metadata_json_file:
        json.dump(
            metadata_clicks,
            metadata_json_file,
            indent=4,
            ensure_ascii=False
        )

    # ---------------------------------------------------------
    # Write Demo metadata
    # ---------------------------------------------------------

    with open(
        "metadata_demos_c.json",
        "w",
        encoding="utf-8"
    ) as metadata_json_file:
        json.dump(
            metadata_demos,
            metadata_json_file,
            indent=4,
            ensure_ascii=False
        )

    # ---------------------------------------------------------
    # Summary
    # ---------------------------------------------------------

    print(
        f"Created metadata_clicks_c.json with "
        f"{click_count} Click entries in "
        f"{len(metadata_clicks)} categories."
    )

    print(
        f"Created metadata_demos_c.json with "
        f"{demo_count} Demo entries."
    )