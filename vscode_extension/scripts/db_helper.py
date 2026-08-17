#!/usr/bin/env python3
"""SQLite bridge for Mikro Rust Configurator.

Uses only Python's standard library so the VS Code extension does not need a
native Node SQLite dependency.
"""
import argparse
import json
import sqlite3
import sys


def connect(path):
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    return db


def list_mcus(db):
    rows = db.execute('SELECT NAME FROM MCU ORDER BY NAME COLLATE NOCASE').fetchall()
    return [row[0] for row in rows]


def mcu_details(db, name):
    row = db.execute(
        'SELECT Family.VENDOR AS vendor, Family.TARGET AS target, '
        'MCU.SYSTEM_LIB AS system_name, MCU.FAMILY AS family '
        'FROM MCU JOIN FAMILY ON MCU.FAMILY = FAMILY.NAME WHERE MCU.NAME = ?',
        (name,),
    ).fetchone()
    if row is None:
        raise ValueError(f'MCU not found in database: {name}')

    family_row = db.execute(
        'SELECT FAMILY.* FROM MCU JOIN FAMILY ON MCU.FAMILY = FAMILY.NAME WHERE MCU.NAME = ?',
        (name,),
    ).fetchone()
    columns = [d[0] for d in db.execute('SELECT * FROM FAMILY LIMIT 0').description]

    return {
        'name': name,
        'vendor': row['vendor'],
        'target': row['target'],
        'systemName': row['system_name'],
        'family': row['family'],
        'familyRecord': {
            'columns': columns,
            'raw': list(family_row) if family_row is not None else [],
            'named': dict(family_row) if family_row is not None else {},
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['list-mcus', 'mcu-details'])
    parser.add_argument('--db', required=True)
    parser.add_argument('--mcu')
    args = parser.parse_args()

    with connect(args.db) as db:
        if args.action == 'list-mcus':
            result = list_mcus(db)
        else:
            if not args.mcu:
                parser.error('--mcu is required for mcu-details')
            result = mcu_details(db, args.mcu)
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}), file=sys.stderr)
        sys.exit(2)
