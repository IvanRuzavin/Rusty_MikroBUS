#!/usr/bin/env python3
"""Create an installable VSIX without npm dependencies.

For publishing to Marketplace, use the official @vscode/vsce tool. This helper
is intended for local/offline packaging and mirrors the basic VSIX OPC layout.
"""
from __future__ import annotations

import json
import os
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
name = manifest['name']
version = manifest['version']
publisher = manifest['publisher']
out = ROOT / f'{name}-{version}.vsix'

exclude_dirs = {'.git', '.vscode', 'test', 'docs', 'node_modules', '__pycache__'}
exclude_suffixes = {'.vsix', '.zip', '.pyc'}

files = []
for p in ROOT.rglob('*'):
    if not p.is_file():
        continue
    rel = p.relative_to(ROOT)
    if any(part in exclude_dirs for part in rel.parts):
        continue
    if p.suffix in exclude_suffixes:
        continue
    if rel.as_posix() in {'.gitignore', '.vscodeignore'}:
        continue
    files.append((p, Path('extension') / rel))

vsixmanifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id={quoteattr(name)} Version={quoteattr(version)} Publisher={quoteattr(publisher)}/>
    <DisplayName>{escape(manifest.get('displayName', name))}</DisplayName>
    <Description xml:space="preserve">{escape(manifest.get('description', ''))}</Description>
    <Tags>{escape(','.join(manifest.get('keywords', [])))}</Tags>
    <Categories>{escape(','.join(manifest.get('categories', [])))}</Categories>
    <GalleryFlags>Private</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value={quoteattr(manifest['engines']['vscode'])} />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
    </Properties>
    <Icon>extension/resources/icon.png</Icon>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/resources/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>
'''

content_types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="py" ContentType="text/x-python" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="md" ContentType="text/markdown" />
  <Override PartName="/extension.vsixmanifest" ContentType="text/xml" />
</Types>
'''

with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('[Content_Types].xml', content_types)
    zf.writestr('extension.vsixmanifest', vsixmanifest)
    for source, archive_path in sorted(files, key=lambda item: item[1].as_posix()):
        zf.write(source, archive_path.as_posix())

print(out)
