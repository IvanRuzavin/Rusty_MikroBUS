#!/usr/bin/env python3
"""Build deterministic Rust BSP packages grouped by MCU.SYSTEM_LIB.

Package names intentionally match the Rust core package names, for example
system_stm32f_2xx under core/arm/stm32 becomes arm_stm32f_2xx.7z. The BSP
release/catalog is separate, so the identical logical package name is safe.

The script derives package membership from the Rust database:
- BoardToDevice boards for MCUs in the SYSTEM_LIB
- MCUCard + CardToMCU cards for those MCUs
- BoardToCard boards that accept those cards
- BoardToShield shields for every selected board

No architecture/vendor mapping is hard-coded. The architecture is discovered
from each MCU definition path under core/.
"""
from __future__ import annotations
import argparse, hashlib, json, os, re, shutil, sqlite3, subprocess, sys, tempfile
from dataclasses import dataclass, field
from pathlib import Path

SCHEMA_VERSION=1
CATALOG_NAME='rust_bsp_packages.json'
PACKAGE_MARKER='.rust-bsp-package.json'

class PackageError(RuntimeError): pass
@dataclass(frozen=True)
class McuRow: name:str; family:str; system_lib:str; architecture:str; platform:str
@dataclass
class Group:
    system_lib:str; architecture:str; platform:str; name:str; rows:list[McuRow]=field(default_factory=list)
    @property
    def mcus(self): return sorted({r.name for r in self.rows}, key=str.casefold)
    @property
    def families(self): return sorted({r.family for r in self.rows}, key=str.casefold)

def args():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--bsp',default='bsp'); p.add_argument('--core',default='core')
    p.add_argument('--database',required=True); p.add_argument('--output',default='dist/rust-bsp-packages')
    p.add_argument('--sevenzip',default=''); return p.parse_args()
def reqdir(v,n):
    p=Path(v).expanduser().resolve()
    if not p.is_dir(): raise PackageError(f'{n} directory does not exist: {p}')
    return p
def reqfile(v,n):
    p=Path(v).expanduser().resolve()
    if not p.is_file(): raise PackageError(f'{n} file does not exist: {p}')
    return p
def sevenzip(v):
    if v:
        p=Path(v).expanduser().resolve()
        if not p.is_file(): raise PackageError(f'7-Zip executable does not exist: {p}')
        return str(p)
    for n in ('7zz','7z','7za'):
        x=shutil.which(n)
        if x:return x
    raise PackageError('7-Zip was not found. Install 7z/7zz/7za or pass --sevenzip.')
def cols(db,t): return {str(r[1]).upper() for r in db.execute(f'PRAGMA table_info({t})')}
def tables(db): return {str(r[0]) for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
def validate(dbp):
    required={'MCU':{'NAME','FAMILY','SYSTEM_LIB'},'Board':{'UID','BSP_PATH','ENABLED'},'BoardToDevice':{'BOARD_UID','DEVICE_NAME'},'Shield':{'UID','BSP_PATH','ENABLED'},'BoardToShield':{'BOARD_UID','SHIELD_UID'}}
    with sqlite3.connect(dbp) as db:
        ts=tables(db)
        for t,c in required.items():
            if t not in ts: raise PackageError(f'{dbp}: missing table {t}')
            miss=c-cols(db,t)
            if miss: raise PackageError(f'{dbp}: table {t} missing columns: {", ".join(sorted(miss))}')
def definitions(core):
    idx={}
    for d in core.rglob('mcu_definitions'):
        if not d.is_dir(): continue
        for f in d.iterdir():
            if f.is_file():
                k=f.stem.casefold()
                if k in idx: raise PackageError(f'Duplicate MCU definition: {f.stem}')
                idx[k]=f
    if not idx: raise PackageError(f'No mcu_definitions found under {core}')
    return idx
def package_name(arch,syslib):
    suffix=re.sub(r'^system_','',syslib,flags=re.I)
    combined=suffix if suffix.casefold().startswith(arch.casefold()) else f'{arch}_{suffix}'
    combined=re.sub(r'[^a-z0-9._-]+','_',combined.lower()); combined=re.sub(r'_+','_',combined).strip('._-')
    if not combined: raise PackageError('Generated empty package name')
    return combined
def groups(core,dbp):
    defs=definitions(core); out={}
    with sqlite3.connect(dbp) as db:
        rows=db.execute("SELECT NAME,FAMILY,SYSTEM_LIB FROM MCU WHERE trim(coalesce(SYSTEM_LIB,''))<>'' ORDER BY NAME COLLATE NOCASE").fetchall()
    for name,family,syslib in rows:
        name,family,syslib=map(lambda x:str(x or '').strip(),(name,family,syslib))
        d=defs.get(name.casefold())
        if not d: continue
        platform_root=d.parent.parent; rel=platform_root.relative_to(core)
        if not rel.parts: continue
        arch=rel.parts[0]; key=(rel.as_posix().casefold(),syslib.casefold())
        g=out.get(key)
        if not g:
            g=Group(syslib,arch,rel.as_posix(),package_name(arch,syslib)); out[key]=g
        g.rows.append(McuRow(name,family,syslib,arch,rel.as_posix()))
    result=sorted(out.values(), key=lambda g:g.name)
    if not result: raise PackageError('No BSP package groups could be derived from database/core intersection.')
    return result
def rowdicts(cur):
    names=[d[0] for d in cur.description]; return [dict(zip(names,r)) for r in cur.fetchall()]
def selected_bsp_rows(dbp, mcus):
    qs=','.join('?' for _ in mcus); params=list(mcus)
    with sqlite3.connect(dbp) as db:
        ts=tables(db)
        board_rows=rowdicts(db.execute(f'''SELECT DISTINCT Board.UID uid, Board.BSP_PATH bsp_path FROM BoardToDevice JOIN Board ON Board.UID=BoardToDevice.BOARD_UID WHERE Board.ENABLED=1 AND BoardToDevice.DEVICE_NAME IN ({qs})''',params))
        card_rows=[]
        if {'MCUCard','CardToMCU','BoardToCard'}<=ts:
            card_rows=rowdicts(db.execute(f'''SELECT DISTINCT MCUCard.UID uid, MCUCard.BSP_PATH bsp_path FROM CardToMCU JOIN MCUCard ON MCUCard.UID=CardToMCU.CARD_UID WHERE MCUCard.ENABLED=1 AND CardToMCU.DEVICE_NAME IN ({qs})''',params))
            if card_rows:
                ids=[r['uid'] for r in card_rows]; cqs=','.join('?' for _ in ids)
                extra=rowdicts(db.execute(f'''SELECT DISTINCT Board.UID uid, Board.BSP_PATH bsp_path FROM BoardToCard JOIN Board ON Board.UID=BoardToCard.BOARD_UID WHERE Board.ENABLED=1 AND BoardToCard.CARD_UID IN ({cqs})''',ids))
                by={str(r['uid']):r for r in board_rows}; by.update({str(r['uid']):r for r in extra}); board_rows=list(by.values())
        shield_rows=[]
        if board_rows:
            ids=[r['uid'] for r in board_rows]; bqs=','.join('?' for _ in ids)
            shield_rows=rowdicts(db.execute(f'''SELECT DISTINCT Shield.UID uid, Shield.BSP_PATH bsp_path FROM BoardToShield JOIN Shield ON Shield.UID=BoardToShield.SHIELD_UID WHERE Shield.ENABLED=1 AND BoardToShield.BOARD_UID IN ({bqs})''',ids))
    return board_rows,card_rows,shield_rows
def resolve_bsp(bsp,pathstr):
    raw=str(pathstr or '').strip().replace('\\','/').lstrip('/')
    if raw.lower().startswith('bsp/'): raw=raw[4:]
    if not raw: raise PackageError('Database contains an empty BSP_PATH.')
    p=(bsp/raw).resolve()
    try:p.relative_to(bsp)
    except ValueError: raise PackageError(f'BSP path escapes root: {pathstr}')
    if not p.is_file(): raise PackageError(f'Required BSP file does not exist: {p}')
    return p,Path(raw)
def stage(bsp,dbp,g,dest):
    boards,cards,shields=selected_bsp_rows(dbp,g.mcus)
    seen=set()
    for r in [*boards,*cards,*shields]:
        src,rel=resolve_bsp(bsp,r['bsp_path']); key=rel.as_posix().casefold()
        if key in seen: continue
        seen.add(key); target=dest/rel; target.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(src,target)
    marker={'schemaVersion':1,'packageName':g.name,'architecture':g.architecture,'platform':g.platform,'systemLib':g.system_lib,'families':g.families,'mcus':g.mcus,'mcuCount':len(g.mcus),'boardCount':len(boards),'cardCount':len(cards),'shieldCount':len(shields)}
    (dest/PACKAGE_MARKER).write_text(json.dumps(marker,indent=2,sort_keys=True)+'\n',encoding='utf8')
    return marker
def normalize(root):
    epoch=946684800
    for p in sorted(root.rglob('*'),key=lambda p:len(p.parts),reverse=True):
        try:os.utime(p,(epoch,epoch),follow_symlinks=False)
        except OSError:pass
    os.utime(root,(epoch,epoch),follow_symlinks=False)
def archive(z,stagep,out):
    normalize(stagep); files=sorted(p.relative_to(stagep).as_posix() for p in stagep.rglob('*') if p.is_file() or p.is_symlink())
    if not files: raise PackageError(f'Empty package {out.name}')
    out.parent.mkdir(parents=True,exist_ok=True); out.unlink(missing_ok=True)
    lf=stagep.parent/(out.stem+'.files.txt'); lf.write_text('\n'.join(files)+'\n',encoding='utf8')
    try:
        r=subprocess.run([z,'a','-t7z','-mx=9','-mmt=off','-mtc=off','-mtm=off','-mta=off',str(out),f'@{lf}'],cwd=stagep,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env={**os.environ,'TZ':'UTC'})
        if r.returncode: raise PackageError(f'7-Zip failed for {out.name}:\n{r.stdout}')
    finally: lf.unlink(missing_ok=True)
def sha(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for c in iter(lambda:f.read(1024*1024),b''):h.update(c)
    return h.hexdigest()
def shafile(p,d): p.with_name(p.name+'.sha256').write_text(f'{d}  {p.name}\n',encoding='ascii')
def main():
    a=args()
    try:
        bsp=reqdir(a.bsp,'BSP'); core=reqdir(a.core,'Core'); dbp=reqfile(a.database,'Rust database'); validate(dbp); z=sevenzip(a.sevenzip); gs=groups(core,dbp); out=Path(a.output).expanduser().resolve(); shutil.rmtree(out,ignore_errors=True); out.mkdir(parents=True)
        cat=[]
        with tempfile.TemporaryDirectory(prefix='rust-bsp-packages-') as td:
            for i,g in enumerate(gs,1):
                st=Path(td)/g.name; st.mkdir(); meta=stage(bsp,dbp,g,st); ar=out/f'{g.name}.7z'; print(f'[{i}/{len(gs)}] {g.name}: {meta["boardCount"]} boards, {meta["cardCount"]} cards, {meta["shieldCount"]} shields'); archive(z,st,ar); d=sha(ar); shafile(ar,d); cat.append({'name':g.name,'asset':ar.name,'sha256':d,'size':ar.stat().st_size,**{k:meta[k] for k in ('architecture','platform','systemLib','families','mcus','mcuCount','boardCount','cardCount','shieldCount')}})
        cp=out/CATALOG_NAME; cp.write_text(json.dumps({'schemaVersion':1,'packages':sorted(cat,key=lambda x:x['name'])},indent=2,sort_keys=True)+'\n',encoding='utf8'); shafile(cp,sha(cp)); print(f'Created {len(cat)} package(s) in {out}'); return 0
    except PackageError as e: print(f'ERROR: {e}',file=sys.stderr); return 1
if __name__=='__main__': raise SystemExit(main())
