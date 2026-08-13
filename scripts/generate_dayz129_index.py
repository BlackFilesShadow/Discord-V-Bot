#!/usr/bin/env python3
"""Generate the compact DayZ 1.29 runtime index.

The generator is intentionally fail-closed: every file listed in the user ZIP
manifest must exist in the supplied extracted dataset roots and match size +
SHA-256 before runtime data is generated. Public Bohemia sources are a semantic
cross-check, not a substitute value source when the supplied ZIPs differ.
"""
from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
from collections import Counter
from pathlib import Path
import xml.etree.ElementTree as ET

MAP_DIRS = {
    "chernarus": "dayzOffline.chernarusplus",
    "livonia": "dayzOffline.enoch",
    "sakhal": "dayzOffline.sakhal",
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def clean_tag(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def number_or_text(value: str | None):
    if value is None:
        return None
    value = value.strip()
    try:
        return int(value)
    except ValueError:
        try:
            return float(value)
        except ValueError:
            return value


def xml_summary(path: Path) -> dict:
    root = ET.parse(path).getroot()
    tags = Counter(clean_tag(el.tag) for el in root.iter())
    attrs = Counter(attr for el in root.iter() for attr in el.attrib)
    top = Counter(clean_tag(child.tag) for child in list(root))
    return {
        "root": clean_tag(root.tag),
        "elementCounts": dict(tags.most_common()),
        "attributeCounts": dict(attrs.most_common()),
        "topLevelTags": dict(top.most_common()),
    }


def walk_json(value, prefix: str, out: Counter) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{prefix}.{key}" if prefix else key
            out[path] += 1
            walk_json(child, path, out)
    elif isinstance(value, list):
        path = f"{prefix}[]"
        out[path] += len(value)
        for child in value:
            walk_json(child, path, out)


def json_summary(path: Path) -> dict:
    obj = json.loads(path.read_text(encoding="utf-8-sig"))
    paths: Counter = Counter()
    walk_json(obj, "", paths)
    return {"rootType": type(obj).__name__, "keyPaths": dict(paths.most_common(300))}


def parse_types(path: Path) -> dict:
    root = ET.parse(path).getroot()
    result = {}
    for node in root.findall("type"):
        name = node.get("name")
        if not name:
            continue
        rec = {}
        for key in ("nominal", "lifetime", "restock", "min", "quantmin", "quantmax", "cost"):
            el = node.find(key)
            if el is not None and el.text is not None:
                rec[key] = number_or_text(el.text)
        flags = node.find("flags")
        if flags is not None:
            rec["flags"] = {k: number_or_text(v) for k, v in flags.attrib.items()}
        for key in ("category", "usage", "value", "tag"):
            values = [el.get("name") for el in node.findall(key) if el.get("name")]
            if values:
                rec[key] = values
        result[name] = rec
    return result


def parse_events(path: Path) -> dict:
    root = ET.parse(path).getroot()
    result = {}
    for node in root.findall("event"):
        name = node.get("name")
        if not name:
            continue
        rec = {}
        for key in (
            "nominal", "min", "max", "lifetime", "restock", "saferadius",
            "distanceradius", "cleanupradius", "secondary", "position", "limit", "active",
        ):
            el = node.find(key)
            if el is not None and el.text is not None:
                rec[key] = number_or_text(el.text)
        flags = node.find("flags")
        if flags is not None:
            rec["flags"] = {k: number_or_text(v) for k, v in flags.attrib.items()}
        children = node.find("children")
        if children is not None:
            rec["children"] = [
                {k: number_or_text(v) for k, v in child.attrib.items()}
                for child in children.findall("child")
            ]
        result[name] = rec
    return result


def validate_source(source: Path, manifest: dict) -> None:
    errors: list[str] = []
    for map_name, files in manifest["maps"].items():
        root = source / MAP_DIRS[map_name]
        for rel, expected in files.items():
            path = root / rel
            if not path.is_file():
                errors.append(f"{map_name}:{rel}: missing")
                continue
            size = path.stat().st_size
            digest = sha256(path)
            if size != expected["size"] or digest != expected["sha256"]:
                errors.append(
                    f"{map_name}:{rel}: mismatch size={size}/{expected['size']} "
                    f"sha256={digest}/{expected['sha256']}"
                )
    if errors:
        preview = "\n".join(errors[:30])
        extra = f"\n... and {len(errors)-30} more" if len(errors) > 30 else ""
        raise SystemExit("DZ_129 does not match supplied ZIP manifest:\n" + preview + extra)


def build_index(source: Path, manifest: dict) -> dict:
    index = {
        "version": manifest["version"],
        "sourceTag": manifest["tag"],
        "verifiedAgainstUserManifest": True,
        "maps": {},
        "allFileBasenames": [],
        "allRelativePaths": [],
        "allTypeNames": [],
        "allEventNames": [],
    }
    all_basenames: set[str] = set()
    all_paths: set[str] = set()
    all_types: set[str] = set()
    all_events: set[str] = set()

    for map_name, files in manifest["maps"].items():
        root = source / MAP_DIRS[map_name]
        map_data = {"mission": MAP_DIRS[map_name], "files": {}, "types": {}, "events": {}}
        for rel in sorted(files):
            path = root / rel
            entry = {
                "size": path.stat().st_size,
                "sha256": sha256(path),
            }
            suffix = path.suffix.lower()
            if suffix == ".xml":
                entry["structure"] = xml_summary(path)
            elif suffix == ".json":
                entry["structure"] = json_summary(path)
            elif suffix == ".map":
                entry["structure"] = {"format": "binary-map"}
            else:
                entry["structure"] = {"format": suffix.lstrip(".") or "unknown"}
            map_data["files"][rel] = entry
            all_basenames.add(path.name.lower())
            all_paths.add(rel.lower())

        map_data["types"] = parse_types(root / "db/types.xml")
        map_data["events"] = parse_events(root / "db/events.xml")
        all_types.update(map_data["types"])
        all_events.update(map_data["events"])
        index["maps"][map_name] = map_data

    index["allFileBasenames"] = sorted(all_basenames)
    index["allRelativePaths"] = sorted(all_paths)
    index["allTypeNames"] = sorted(all_types, key=str.lower)
    index["allEventNames"] = sorted(all_events, key=str.lower)
    return index


def write_ts(index: dict, output: Path) -> None:
    raw = json.dumps(index, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    packed = gzip.compress(raw, compresslevel=9)
    b64 = base64.b64encode(packed).decode("ascii")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        "// GENERATED by scripts/generate_dayz129_index.py. Do not edit by hand.\n"
        "// Source: supplied three DayZ 1.29 ZIPs, byte-verified against user-source-manifest.json.\n"
        f"export const DAYZ129_INDEX_GZIP_BASE64 = '{b64}' as const;\n",
        encoding="utf-8",
    )
    print(
        f"Generated {output}: raw={len(raw)} bytes gzip={len(packed)} bytes "
        f"types={len(index['allTypeNames'])} events={len(index['allEventNames'])} "
        f"paths={len(index['allRelativePaths'])}"
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, type=Path, help="directory containing the three extracted user mission roots")
    ap.add_argument("--manifest", default="data/dayz129/user-source-manifest.json", type=Path)
    ap.add_argument("--output", default="src/modules/ai/generated/dayz129IndexData.ts", type=Path)
    args = ap.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    validate_source(args.source, manifest)
    write_ts(build_index(args.source, manifest), args.output)


if __name__ == "__main__":
    main()
