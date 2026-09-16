#!/usr/bin/env python3
"""Generate the DayZ 1.29 German-classname index from Bohemia's own stringtable.csv.

Fail-closed like generate_dayz129_index.py: the supplied stringtable.csv must
match the byte-verified manifest (size + SHA-256) before anything is
generated, and only rows with a REAL, already-verified 1.29 classname AND a
genuine (non-"$UNT$", non-empty) German translation are emitted. Nothing here
is guessed - every classname -> German-name pair traces directly back to a
row in Bohemia's own official localization file.
"""
from __future__ import annotations

import argparse
import base64
import csv
import gzip
import hashlib
import json
import re
import sys
from pathlib import Path

# Bohemia's stringtable keys look like:
#   str_cfgvehicles_petrollighter0      -> short display name (variant "0")
#   str_cfgvehicles_petrollighter1      -> long description (variant "1", ignored)
#   str_cfgvehicles_alicebag_black0     -> per-color display name (often "$UNT$..." = never localized)
#   str_cfgvehicles_alicebag_colorbase0 -> shared display name for ALL color variants of a family
KEY_RE = re.compile(r'^str_(cfgvehicles|cfgweapons|cfgmagazines)_([a-z0-9_]+)$')
COLORBASE_RE = re.compile(r'^(.*)_colorbase(\d)$')
COLOR_SUFFIXES = {
    'black', 'blue', 'brown', 'green', 'grey', 'gray', 'red', 'orange', 'yellow',
    'pink', 'white', 'beige', 'olive', 'tan', 'khaki', 'camo', 'dpm', 'flecktarn', 'ttsko',
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def validate_source(source: Path, manifest: dict) -> None:
    if not source.is_file():
        raise SystemExit(f'stringtable.csv nicht gefunden: {source}')
    size = source.stat().st_size
    digest = sha256(source)
    if size != manifest['size'] or digest != manifest['sha256']:
        raise SystemExit(
            'stringtable.csv weicht vom Manifest ab: '
            f'size={size}/{manifest["size"]} sha256={digest}/{manifest["sha256"]}'
        )


def load_real_type_names(index_json: Path) -> list[str]:
    with index_json.open(encoding='utf-8') as fh:
        index = json.load(fh)
    return index['allTypeNames']


def build_german_names(csv_path: Path, real_names: list[str]) -> dict[str, str]:
    compact_to_real: dict[str, str] = {}
    for name in real_names:
        compact = name.lower().replace('_', '')
        compact_to_real.setdefault(compact, name)

    direct: dict[str, str] = {}
    colorbase: dict[str, str] = {}

    with csv_path.open(encoding='utf-8-sig', newline='') as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            key = (row.get('Language') or '').strip()
            m = KEY_RE.match(key)
            if not m:
                continue
            _prefix, rest = m.groups()

            cb = COLORBASE_RE.match(rest)
            if cb:
                base, variant = cb.groups()
                if variant != '0':
                    continue
                german = (row.get('german') or '').strip()
                if not german or german.startswith('$UNT$'):
                    continue
                colorbase[base.replace('_', '')] = german
                continue

            # Only the short display-name variant ("0"); "1"/"2".. are descriptions.
            if not rest.endswith('0'):
                continue
            compact = rest[:-1].replace('_', '')
            real = compact_to_real.get(compact)
            if not real:
                continue
            german = (row.get('german') or '').strip()
            if not german or german.startswith('$UNT$'):
                continue
            direct[real] = german

    final = dict(direct)
    for name in real_names:
        if name in final:
            continue
        parts = name.split('_')
        if len(parts) >= 2 and parts[-1].lower() in COLOR_SUFFIXES:
            base_compact = ''.join(parts[:-1]).lower()
            if base_compact in colorbase:
                final[name] = colorbase[base_compact]

    return final


CHUNK_SIZE = 8000


def write_ts(mapping: dict[str, str], output: Path, source_sha256: str) -> None:
    raw = json.dumps(mapping, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    packed = gzip.compress(raw, compresslevel=9)
    b64 = base64.b64encode(packed).decode('ascii')
    b64_sha256 = hashlib.sha256(b64.encode('ascii')).hexdigest()

    output.parent.mkdir(parents=True, exist_ok=True)
    chunks_dir = output.parent / 'dayz129GermanNamesChunks'
    if chunks_dir.exists():
        for old in chunks_dir.glob('*.ts'):
            old.unlink()
    chunks_dir.mkdir(parents=True, exist_ok=True)

    chunk_names: list[str] = []
    for i in range(0, len(b64), CHUNK_SIZE):
        name = f'chunk{len(chunk_names):03d}'
        chunk_names.append(name)
        (chunks_dir / f'{name}.ts').write_text(
            f"export default '{b64[i:i + CHUNK_SIZE]}';\n", encoding='utf-8',
        )

    imports = '\n'.join(f"import {name} from './dayz129GermanNamesChunks/{name}';" for name in chunk_names)
    join_list = ', '.join(chunk_names)
    output.write_text(
        '// GENERATED by scripts/generate_dayz129_stringtable.py. Do not edit by hand.\n'
        '// Source: Bohemia\'s own stringtable.csv (official localization file), byte-verified\n'
        '// against data/dayz129/stringtable-source-manifest.json. Every entry traces to a real\n'
        '// row in that file for a classname already verified in the DayZ 1.29 types.xml index -\n'
        f'// nothing here is guessed. Source stringtable.csv SHA-256: {source_sha256}.\n'
        f'{imports}\n\n'
        f"export const DAYZ129_GERMAN_NAMES_GZIP_BASE64 = [{join_list}].join('');\n"
        f"export const DAYZ129_GERMAN_NAMES_GZIP_BASE64_SHA256 = '{b64_sha256}' as const;\n",
        encoding='utf-8',
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', required=True, type=Path, help='Path to the supplied stringtable.csv')
    ap.add_argument('--manifest', default='data/dayz129/stringtable-source-manifest.json', type=Path)
    ap.add_argument('--index', default='src/modules/ai/generated/dayz129IndexData.json.tmp', type=Path,
                     help='Decompressed DayZ 1.29 index JSON (allTypeNames) to cross-reference against')
    ap.add_argument('--output', default='src/modules/ai/generated/dayz129GermanNamesData.ts', type=Path)
    args = ap.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding='utf-8'))
    validate_source(args.source, manifest)

    real_names = load_real_type_names(args.index)
    mapping = build_german_names(args.source, real_names)

    write_ts(mapping, args.output, manifest['sha256'])
    print(f'Generated {len(mapping)} verified German classname entries -> {args.output}', file=sys.stderr)


if __name__ == '__main__':
    main()
