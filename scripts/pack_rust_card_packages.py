#!/usr/bin/env python3
"""Build deterministic Rust MCU Card BSP packages from the MCUCard table."""
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
CATALOG_NAME = "rust_card_packages.json"
PACKAGE_MARKER = ".rust-card-package.json"

class PackageError(RuntimeError): pass

@dataclass(frozen=True)
class Entity:
    uid: str
    display_name: str
    bsp_path: str
    mcu_count: int
    board_count: int
    @property
    def package_name(self) -> str: return f"card_{safe_id(self.uid)}"

def parse_args() -> argparse.Namespace:
    p=argparse.ArgumentParser(description=__doc__); p.add_argument("--bsp",default="bsp"); p.add_argument("--database",required=True); p.add_argument("--output",default="dist/rust-card-packages"); p.add_argument("--sevenzip",default=""); return p.parse_args()

def required_directory(value:str,label:str)->Path:
    p=Path(value).expanduser().resolve()
    if not p.is_dir(): raise PackageError(f"{label} directory does not exist: {p}")
    return p

def required_file(value:str,label:str)->Path:
    p=Path(value).expanduser().resolve()
    if not p.is_file(): raise PackageError(f"{label} file does not exist: {p}")
    return p

def resolve_sevenzip(configured:str)->str:
    if configured:
        p=Path(configured).expanduser().resolve()
        if not p.is_file(): raise PackageError(f"7-Zip executable does not exist: {p}")
        return str(p)
    for name in ("7zz","7z","7za"):
        executable=shutil.which(name)
        if executable:return executable
    raise PackageError("7-Zip was not found. Install 7z/7zz/7za or pass --sevenzip.")

def safe_id(value:str)->str:
    text=re.sub(r"[^A-Za-z0-9._-]+","_",str(value).strip()).strip("._-").lower()
    if not text:raise PackageError(f"Cannot create package name from empty/invalid UID: {value!r}")
    return text

def table_names(db):return {str(r[0]) for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
def columns(db,table):return {str(r[1]).upper() for r in db.execute(f"PRAGMA table_info({table})")}
def scalar(db,sql,*params):
    try:r=db.execute(sql,params).fetchone()
    except sqlite3.OperationalError:return 0
    return int(r[0] if r and r[0] is not None else 0)

def validate_schema(database:Path)->None:
    with sqlite3.connect(database) as db:
        if "MCUCard" not in table_names(db):raise PackageError(f"{database}: missing table MCUCard")
        missing={"UID","NAME","BSP_PATH","ENABLED"}-columns(db,"MCUCard")
        if missing:raise PackageError(f"{database}: table MCUCard is missing columns: {', '.join(sorted(missing))}")

def read_entities(database:Path)->list[Entity]:
    result=[];skipped=[]
    with sqlite3.connect(database) as db:
        tables=table_names(db)
        for uid,name,bsp_path in db.execute("SELECT UID, NAME, BSP_PATH FROM MCUCard WHERE ENABLED=1 ORDER BY NAME COLLATE NOCASE, UID"):
            uid,bsp_path=str(uid or "").strip(),str(bsp_path or "").strip()
            if not uid or not bsp_path:skipped.append(f"MCUCard {name or uid or '<unknown>'}: empty UID/BSP_PATH");continue
            result.append(Entity(uid,str(name or uid),bsp_path,
                scalar(db,"SELECT COUNT(DISTINCT DEVICE_NAME) FROM CardToMCU WHERE CARD_UID = ?",uid) if "CardToMCU" in tables else 0,
                scalar(db,"SELECT COUNT(DISTINCT BOARD_UID) FROM BoardToCard WHERE CARD_UID = ?",uid) if "BoardToCard" in tables else 0))
    for message in skipped:print(f"WARNING: {message}",file=sys.stderr)
    if not result:raise PackageError("No enabled MCUCard rows with BSP_PATH were found.")
    return result

def resolve_bsp_file(bsp_root:Path,configured_path:str)->tuple[Path,Path]:
    portable=str(configured_path or "").strip().replace("\\","/").lstrip("/")
    if portable.casefold().startswith("bsp/"):portable=portable[4:]
    relative=Path(portable);resolved=(bsp_root/relative).resolve()
    try:resolved.relative_to(bsp_root.resolve())
    except ValueError as exc:raise PackageError(f"BSP path escapes the BSP root: {configured_path}") from exc
    if not resolved.is_file():raise PackageError(f"Required BSP file does not exist: {resolved}")
    return resolved,relative

def normalize_timestamps(root:Path)->None:
    epoch=946684800
    for item in sorted(root.rglob("*"),key=lambda p:len(p.parts),reverse=True):
        try:os.utime(item,(epoch,epoch),follow_symlinks=False)
        except OSError:pass
    os.utime(root,(epoch,epoch),follow_symlinks=False)

def create_archive(sevenzip:str,stage:Path,output:Path)->None:
    normalize_timestamps(stage);files=sorted(i.relative_to(stage).as_posix() for i in stage.rglob("*") if i.is_file() or i.is_symlink())
    output.parent.mkdir(parents=True,exist_ok=True);output.unlink(missing_ok=True);lst=stage.parent/f"{output.stem}.files.txt";lst.write_text("\n".join(files)+"\n")
    try:
        r=subprocess.run([sevenzip,"a","-t7z","-mx=9","-mmt=off","-mtc=off","-mtm=off","-mta=off",str(output),f"@{lst}"],cwd=stage,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env={**os.environ,"TZ":"UTC"})
        if r.returncode:raise PackageError(f"7-Zip failed for {output.name}:\n{r.stdout}")
    finally:lst.unlink(missing_ok=True)

def sha256(path:Path)->str:
    h=hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda:f.read(1024*1024),b""):h.update(chunk)
    return h.hexdigest()

def main()->int:
    o=parse_args()
    try:
        bsp=required_directory(o.bsp,"BSP");db_path=required_file(o.database,"Rust database");validate_schema(db_path);sevenzip=resolve_sevenzip(o.sevenzip);entities=read_entities(db_path)
        out=Path(o.output).expanduser().resolve();shutil.rmtree(out,ignore_errors=True);out.mkdir(parents=True,exist_ok=True);entries=[]
        with tempfile.TemporaryDirectory(prefix="rust-card-packages-") as td:
            temp=Path(td)
            for index,e in enumerate(entities,1):
                stage=temp/e.package_name;stage.mkdir(parents=True);source,relative=resolve_bsp_file(bsp,e.bsp_path);target=stage/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
                metadata={"schemaVersion":SCHEMA_VERSION,"packageName":e.package_name,"entityType":"card","uid":e.uid,"displayName":e.display_name,"bspPath":e.bsp_path.replace("\\","/"),"relativeBspPath":relative.as_posix(),"mcuCount":e.mcu_count,"boardCount":e.board_count}
                (stage/PACKAGE_MARKER).write_text(json.dumps(metadata,indent=2,sort_keys=True)+"\n")
                archive=out/f"{e.package_name}.7z";print(f"[{index}/{len(entities)}] card {e.display_name} [{e.uid}] -> {archive.name}");create_archive(sevenzip,stage,archive)
                entries.append({"name":e.package_name,**metadata,"asset":archive.name,"sha256":sha256(archive),"size":archive.stat().st_size})
        catalog={"schemaVersion":SCHEMA_VERSION,"packageModel":"card-entity","counts":{"card":len(entries)},"packages":sorted(entries,key=lambda i:(str(i['displayName']).casefold(),str(i['uid']).casefold()))}
        (out/CATALOG_NAME).write_text(json.dumps(catalog,indent=2,sort_keys=True)+"\n")
        print(f"Created {len(entries)} Rust MCU Card packages in {out}");return 0
    except PackageError as error:print(f"ERROR: {error}",file=sys.stderr);return 1

if __name__=="__main__":raise SystemExit(main())
