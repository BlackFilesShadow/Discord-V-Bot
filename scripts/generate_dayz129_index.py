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
import re
from collections import Counter
from pathlib import Path
from typing import Callable
import xml.etree.ElementTree as ET

_COMMENT_RE = re.compile(r'<!--(.*?)-->', re.DOTALL)


def _fix_comment_body(match: "re.Match[str]") -> str:
    # Strict XML forbids "--" anywhere inside a comment body, AND forbids the
    # body ending in "-" (that would combine with the closing "-->"'s own
    # leading "-" into an illegal "--"). DayZ's own engine (and the official
    # Bohemia DZ_129 reference) tolerate decorative dash runs like
    # "<!-- ----MUMMY----------->" that ElementTree rejects. Comment content
    # is discarded by every consumer here anyway (never parsed or exposed),
    # so replacing every dash run with a single space is a pure
    # well-formedness fix that can never change parsed structure/types/events
    # - and unlike collapsing to "-", it can never itself re-create "--".
    return f'<!--{re.sub(r"-+", " ", match.group(1))}-->'


def parse_xml_lenient(path: Path) -> ET.Element:
    text = path.read_text(encoding='utf-8-sig')
    sanitized = _COMMENT_RE.sub(_fix_comment_body, text)
    return ET.fromstring(sanitized)

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
    root = parse_xml_lenient(path)
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
    root = parse_xml_lenient(path)
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


def parse_globals(path: Path) -> dict:
    root = parse_xml_lenient(path)
    return {
        v.get("name"): {"type": number_or_text(v.get("type")), "value": number_or_text(v.get("value"))}
        for v in root.findall("var") if v.get("name")
    }


def parse_economy_classes(path: Path) -> dict:
    root = parse_xml_lenient(path)
    return {
        child.tag: {k: number_or_text(v) for k, v in child.attrib.items()}
        for child in root
    }


def parse_economy_core(path: Path) -> dict:
    root = parse_xml_lenient(path)
    root_classes = []
    classes = root.find("classes")
    if classes is not None:
        for rc in classes.findall("rootclass"):
            root_classes.append({k: v for k, v in rc.attrib.items()})
    defaults = {}
    defaults_el = root.find("defaults")
    if defaults_el is not None:
        for d in defaults_el.findall("default"):
            name = d.get("name")
            if name:
                defaults[name] = number_or_text(d.get("value"))
    return {"rootClasses": root_classes, "defaults": defaults}


def parse_weather(path: Path) -> dict:
    root = parse_xml_lenient(path)
    sections = {}
    for section in root:
        if section.tag == "storm":
            sections[section.tag] = {k: number_or_text(v) for k, v in section.attrib.items()}
            continue
        block = {}
        for sub in section:
            block[sub.tag] = {k: number_or_text(v) for k, v in sub.attrib.items()}
        sections[section.tag] = block
    return {
        "reset": number_or_text(root.get("reset")),
        "enable": number_or_text(root.get("enable")),
        "sections": sections,
    }


def parse_limits_definition(path: Path) -> dict:
    root = parse_xml_lenient(path)
    out = {}
    tag_map = {"categories": "category", "tags": "tag", "usageflags": "usage", "valueflags": "value"}
    for group_tag, item_tag in tag_map.items():
        group = root.find(group_tag)
        out[group_tag] = [el.get("name") for el in group.findall(item_tag)] if group is not None else []
    return out


def parse_limits_definition_user(path: Path) -> dict:
    root = parse_xml_lenient(path)
    out = {}
    tag_map = {"usageflags": "usage", "valueflags": "value"}
    for group_tag, item_tag in tag_map.items():
        group = root.find(group_tag)
        users = {}
        if group is not None:
            for user in group.findall("user"):
                name = user.get("name")
                if name:
                    users[name] = [el.get("name") for el in user.findall(item_tag)]
        out[group_tag] = users
    return out


def parse_ignore_list(path: Path) -> list:
    root = parse_xml_lenient(path)
    return [t.get("name") for t in root.findall("type") if t.get("name")]


def parse_messages(path: Path) -> list:
    # Nur ECHTE, aktive <message>-Elemente. Die drei gelieferten Datensaetze
    # enthalten aktuell ausschliesslich auskommentierte Beispielnachrichten
    # (siehe docs/dayz-1.29-grounding.md) - ElementTree ignoriert Kommentare
    # automatisch, das Ergebnis ist deshalb korrekt leer statt die Beispiele
    # faelschlich als aktiv konfigurierte Nachrichten auszugeben.
    root = parse_xml_lenient(path)
    out = []
    for m in root.findall("message"):
        rec = {}
        for key in ("delay", "repeat", "deadline", "shutdown", "onconnect"):
            el = m.find(key)
            if el is not None and el.text is not None:
                rec[key] = number_or_text(el.text)
        text_el = m.find("text")
        if text_el is not None and text_el.text:
            rec["text"] = text_el.text
        if rec:
            out.append(rec)
    return out


def parse_territories(path: Path) -> list:
    root = parse_xml_lenient(path)
    grouped: dict[str, dict] = {}
    for zone in root.iter("zone"):
        name = zone.get("name")
        if not name:
            continue
        dmin = number_or_text(zone.get("dmin"))
        dmax = number_or_text(zone.get("dmax"))
        radius = number_or_text(zone.get("r"))
        row = grouped.setdefault(name, {
            "name": name, "count": 0,
            "dminMin": dmin, "dminMax": dmin, "dmaxMin": dmax, "dmaxMax": dmax,
            "radiusMin": radius, "radiusMax": radius,
        })
        row["count"] += 1
        for key, value in (("dminMin", dmin), ("dmaxMin", dmax), ("radiusMin", radius)):
            if isinstance(value, (int, float)) and isinstance(row[key], (int, float)):
                row[key] = min(row[key], value)
        for key, value in (("dminMax", dmin), ("dmaxMax", dmax), ("radiusMax", radius)):
            if isinstance(value, (int, float)) and isinstance(row[key], (int, float)):
                row[key] = max(row[key], value)
    return sorted(grouped.values(), key=lambda r: r["name"])


def parse_event_groups(path: Path) -> dict:
    root = parse_xml_lenient(path)
    out = {}
    for group in root.findall("group"):
        name = group.get("name")
        if not name:
            continue
        counts: dict[str, int] = {}
        for child in group.findall("child"):
            t = child.get("type")
            if t:
                counts[t] = counts.get(t, 0) + 1
        out[name] = counts
    return out


def parse_random_presets(path: Path) -> dict:
    root = parse_xml_lenient(path)
    out = {}
    for preset in root:
        if preset.tag not in ("cargo", "attachments"):
            continue
        name = preset.get("name")
        if not name:
            continue
        items = [
            {"name": item.get("name"), "chance": number_or_text(item.get("chance"))}
            for item in preset.findall("item") if item.get("name")
        ]
        out[name] = {"kind": preset.tag, "chance": number_or_text(preset.get("chance")), "items": items}
    return out


def parse_effect_areas(path: Path) -> dict:
    obj = json.loads(path.read_text(encoding="utf-8-sig"))
    areas = []
    for area in obj.get("Areas", []):
        data = area.get("Data", {}) or {}
        areas.append({
            "name": area.get("AreaName"),
            "type": area.get("Type"),
            "triggerType": area.get("TriggerType"),
            "radius": data.get("Radius"),
            "posHeight": data.get("PosHeight"),
            "negHeight": data.get("NegHeight"),
        })
    safe_positions = obj.get("SafePositions", [])
    return {"areas": areas, "safePositionCount": len(safe_positions)}


def parse_spawnable_types(path: Path) -> dict:
    root = parse_xml_lenient(path)
    out = {}
    for t in root.findall("type"):
        name = t.get("name")
        if not name:
            continue
        rec: dict = {}
        if t.find("hoarder") is not None:
            rec["hoarder"] = True
        damage = t.find("damage")
        if damage is not None:
            rec["damage"] = {k: number_or_text(v) for k, v in damage.attrib.items()}
        attachments = []
        for att in t.findall("attachments"):
            entry = {"chance": number_or_text(att.get("chance"))}
            items = [i.get("name") for i in att.findall("item") if i.get("name")]
            if items:
                entry["items"] = items
            if att.get("preset"):
                entry["preset"] = att.get("preset")
            attachments.append(entry)
        if attachments:
            rec["attachments"] = attachments
        cargo = []
        for c in t.findall("cargo"):
            entry = {"chance": number_or_text(c.get("chance"))}
            items = [i.get("name") for i in c.findall("item") if i.get("name")]
            if items:
                entry["items"] = items
            if c.get("preset"):
                entry["preset"] = c.get("preset")
            cargo.append(entry)
        if cargo:
            rec["cargo"] = cargo
        if rec:
            out[name] = rec
    return out


def parse_player_spawn_points(path: Path) -> dict:
    root = parse_xml_lenient(path)
    out = {}
    for section in root:
        block = {}
        for sub in section:
            if sub.tag == "pos":
                continue
            leaves = {child.tag: number_or_text(child.text) for child in sub if child.text is not None}
            if leaves:
                block[sub.tag] = leaves
        if block:
            out[section.tag] = block
    return out


def parse_events(path: Path) -> dict:
    root = parse_xml_lenient(path)
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


TERRITORY_FILES = {
    "env/bear_territories.xml": "bear",
    "env/cattle_territories.xml": "cattle",
    "env/domestic_animals_territories.xml": "domesticAnimals",
    "env/fox_territories.xml": "fox",
    "env/hare_territories.xml": "hare",
    "env/hen_territories.xml": "hen",
    "env/pig_territories.xml": "pig",
    "env/red_deer_territories.xml": "redDeer",
    "env/roe_deer_territories.xml": "roeDeer",
    "env/sheep_goat_territories.xml": "sheepGoat",
    "env/wild_boar_territories.xml": "wildBoar",
    "env/wolf_territories.xml": "wolf",
    "env/zombie_territories.xml": "zombie",
}

# (relative Pfad, Ziel-Schluessel im Map-Objekt, Parser-Funktion). Jede Datei
# wird nur geparst, wenn sie im Manifest dieser Karte tatsaechlich gelistet
# ist (z.B. db/messages.xml fehlt bei Sakhal) - fehlende Dateien liefern
# bewusst keinen leeren Platzhalter, damit "nicht vorhanden" von "leer"
# unterscheidbar bleibt.
SINGLE_FILE_PARSERS: list[tuple[str, str, "Callable[[Path], object]"]] = [
    ("db/globals.xml", "globals", parse_globals),
    ("db/economy.xml", "economyClasses", parse_economy_classes),
    ("db/messages.xml", "messages", parse_messages),
    ("cfgeconomycore.xml", "economyCore", parse_economy_core),
    ("cfgweather.xml", "weather", parse_weather),
    ("cfglimitsdefinition.xml", "limitsDefinition", parse_limits_definition),
    ("cfglimitsdefinitionuser.xml", "limitsDefinitionUser", parse_limits_definition_user),
    ("cfgignorelist.xml", "ignoreList", parse_ignore_list),
    ("cfgeventgroups.xml", "eventGroups", parse_event_groups),
    ("cfgrandompresets.xml", "randomPresets", parse_random_presets),
    ("cfgeffectarea.json", "effectAreas", parse_effect_areas),
    ("cfgspawnabletypes.xml", "spawnableTypes", parse_spawnable_types),
    ("cfgplayerspawnpoints.xml", "playerSpawnPoints", parse_player_spawn_points),
]


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

        present = {rel.lower() for rel in files}
        for rel, key, parser in SINGLE_FILE_PARSERS:
            if rel not in present:
                continue
            map_data[key] = parser(root / rel)

        territories = {}
        for rel, animal in TERRITORY_FILES.items():
            if rel not in present:
                continue
            territories[animal] = parse_territories(root / rel)
        if territories:
            map_data["territories"] = territories

        index["maps"][map_name] = map_data

    index["allFileBasenames"] = sorted(all_basenames)
    index["allRelativePaths"] = sorted(all_paths)
    index["allTypeNames"] = sorted(all_types, key=str.lower)
    index["allEventNames"] = sorted(all_events, key=str.lower)
    return index


CHUNK_SIZE = 8000


def write_ts(index: dict, output: Path) -> None:
    raw = json.dumps(index, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    packed = gzip.compress(raw, compresslevel=9)
    b64 = base64.b64encode(packed).decode("ascii")
    b64_sha256 = hashlib.sha256(b64.encode("ascii")).hexdigest()

    output.parent.mkdir(parents=True, exist_ok=True)
    chunks_dir = output.parent / "dayz129IndexChunks"
    if chunks_dir.exists():
        for old in chunks_dir.glob("*.ts"):
            old.unlink()
    chunks_dir.mkdir(parents=True, exist_ok=True)

    # Ein einzelner Base64-String dieser Groesse als eine einzige lange Zeile
    # in einer committeten Datei hat in diesem Repo schon einmal spaeten Schaden
    # im komprimierten Stream verursacht (siehe die vorherige, sehr fragile
    # chunk+repair-Rekonstruktion, die diese Funktion ersetzt). Aufteilen in
    # handliche Chunk-Dateien ist die bewaehrte, sichere Form; zusaetzlich wird
    # ein SHA-256 der vollstaendigen Base64-Nutzlast eingebettet, damit
    # getDayz129Index() eine kuenftige Beschaedigung sofort und fail-closed
    # erkennt, statt sie still zu laden.
    chunk_names: list[str] = []
    for i in range(0, len(b64), CHUNK_SIZE):
        name = f"chunk{len(chunk_names):03d}"
        chunk_names.append(name)
        (chunks_dir / f"{name}.ts").write_text(
            f"export default '{b64[i:i + CHUNK_SIZE]}';\n", encoding="utf-8",
        )

    imports = "\n".join(f"import {name} from './dayz129IndexChunks/{name}';" for name in chunk_names)
    join_list = ", ".join(chunk_names)
    output.write_text(
        "// GENERATED by scripts/generate_dayz129_index.py. Do not edit by hand.\n"
        "// Source: supplied three DayZ 1.29 ZIPs, byte-verified against user-source-manifest.json.\n"
        f"{imports}\n\n"
        f"export const DAYZ129_INDEX_GZIP_BASE64 = [{join_list}].join('');\n"
        f"export const DAYZ129_INDEX_GZIP_BASE64_SHA256 = '{b64_sha256}' as const;\n",
        encoding="utf-8",
    )
    print(
        f"Generated {output}: raw={len(raw)} bytes gzip={len(packed)} bytes "
        f"b64_chunks={len(chunk_names)} "
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
