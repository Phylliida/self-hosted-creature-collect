#!/usr/bin/env python3
"""Import a GMS monster data pack (e.g. the Neopets pack) and convert it
into our creature content pack format (pack.bin + pack.json).

GMS packs are single JSON files (pretty-printed, sometimes with trailing
garbage after the closing brace) with two top-level sections:
  data   — monsters / families / rarefamilies / types / items / ...
  images — base64-encoded PNG/GIF files keyed by filename

Output layout (staging → content_pack.write_pack):
  types.json        7 GMS types -> our type-registry schema
  species.json      per-monster solo registry entries (id 'neo:<gmsId>')
  categories.json   families as completion categories, rarefamilies
                    flagged legendary (they're the Pant Devil class)
  items.json        paintbrushes as evo items (books/TMs skipped for v1)
  sprites/<file>    decoded image bytes
  logo.png          pack emblem (first family icon)

Usage:
    python3 build-gms-pack.py neopet_srlhgr_data_v2.0.gmsdp.bin \
        --pack-id neopets --name "Neopets" --out packs/neopets
"""

import argparse
import base64
import json
import re
import sys
from pathlib import Path

import content_pack


def load_gms(path):
    text = Path(path).read_text(encoding="utf-8-sig")
    doc, _ = json.JSONDecoder().raw_decode(text)  # tolerate trailing garbage
    return doc


def type_id(gms_type):
    return gms_type.upper()


def convert_types(data):
    """GMS types: {t: {name, color, <defType>: multiplier, ...}} where
    multiplier is 2 / 1 / 0.5 / 0. Emit our types.json schema."""
    gms_types = data["types"]
    order = [type_id(t) for t in data.get("typesNames", list(gms_types))]
    out = {"order": order, "types": {}}
    for gms_id, row in gms_types.items():
        tid = type_id(gms_id)
        strong, weak, immune = [], [], []
        for k, v in row.items():
            if k not in gms_types:
                continue  # skip name/color/trainers/badges/tiles/etc.
            dt = type_id(k)
            if v == 2:
                strong.append(dt)
            elif v == 0.5:
                weak.append(dt)
            elif v == 0:
                immune.append(dt)
        out["types"][tid] = {
            "color": row.get("color", "#888888"),
            "displayName": row.get("name", tid.title()),
            "strong": strong,
            "weak": weak,
            "immune": immune,
        }
    return out


def convert_species(data):
    """Each GMS monster becomes a solo registry entry."""
    out = []
    for gms_id, m in data["monsters"].items():
        forms = m.get("forms") or [{}]
        types = []
        for tk in ("type1", "type2"):
            t = forms[0].get(tk)
            if t and type_id(t) not in types:
                types.append(type_id(t))
        evos = []
        for e in m.get("evolutions") or []:
            cond = e.get("conditions") or {}
            evos.append({
                "target": f"neo:{e['id']}",
                "item": cond.get("item"),
                "level": cond.get("level"),
            })
        out.append({
            "id": f"neo:{gms_id}",
            "name": forms[0].get("name", gms_id),
            "types": types,
            "dexentry": m.get("dexentry", ""),
            "growth": m.get("growth", "medium"),
            "genders": m.get("genders", [50, 50]),
            "forms": [
                {"gender": (f.get("conditions") or {}).get("gender", 0),
                 "icon": f.get("icon", ""),
                 "power": f.get("power", 1)}
                for f in forms
            ],
            "evolutions": evos,
        })
    return out


def _slug(name):
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return re.sub(r"-family$", "", s)


def convert_categories(data):
    """Families = completion categories (like pokémon species
    categories); rarefamilies are the legendary tier. soloCategories
    maps each monster to its family's category."""
    categories = []
    solo_categories = {}
    for fam in data.get("families", []):
        cid = _slug(fam["name"])
        categories.append({
            "id": cid,
            "name": fam["name"],
            "icon": fam.get("icon", ""),
            "legendary": False,
            "members": [f"neo:{m['id']}" for m in fam.get("members", [])],
        })
        for m in fam.get("members", []):
            solo_categories[f"neo:{m['id']}"] = [cid]
    for fam in data.get("rarefamilies", []):
        cid = _slug(fam["name"])
        categories.append({
            "id": cid,
            "name": fam["name"],
            "icon": fam.get("icon", ""),
            "legendary": True,
            "members": [f"neo:{m['id']}" for m in fam.get("members", [])],
        })
        for m in fam.get("members", []):
            solo_categories[f"neo:{m['id']}"] = [cid]
    return {"categories": categories, "soloCategories": solo_categories}


def convert_items(data):
    """Paintbrushes are the evolution items (the pokémon Fire Stone
    analogue). Books/TMs and misc shop items are skipped for v1."""
    out = []
    for name, item in data.get("items", {}).items():
        if not name.endswith("Paintbrush"):
            continue
        key = "neo_paintbrush_" + re.sub(r"[^a-z0-9]+", "_",
                                         name.lower().replace(" paintbrush", "")).strip("_")
        out.append({
            "key": key,
            "name": name,
            "icon": item.get("icon", ""),
            "kind": "evo",
        })
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("gms", help="path to the GMS .bin data pack")
    ap.add_argument("--pack-id", required=True, help="e.g. neopets")
    ap.add_argument("--name", required=True, help='display name, e.g. "Neopets"')
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    doc = load_gms(args.gms)
    data, images = doc["data"], doc.get("images", {})
    print(f"→ {args.gms}: {len(data['monsters'])} monsters, "
          f"{len(data.get('families', []))} families, "
          f"{len(data.get('rarefamilies', []))} rare families, "
          f"{len(data['types'])} types, {len(images)} images")

    staging = args.out / ".staging"
    if staging.exists():
        import shutil
        shutil.rmtree(staging)
    (staging / "sprites").mkdir(parents=True)

    (staging / "types.json").write_text(
        json.dumps(convert_types(data)), encoding="utf-8")
    (staging / "species.json").write_text(
        json.dumps(convert_species(data)), encoding="utf-8")
    (staging / "categories.json").write_text(
        json.dumps(convert_categories(data)), encoding="utf-8")
    (staging / "items.json").write_text(
        json.dumps(convert_items(data)), encoding="utf-8")
    (staging / "pack-info.json").write_text(json.dumps({
        "id": args.pack_id,
        "name": args.name,
        "gmsVersion": doc.get("versionName", ""),
        "author": data.get("generalAuthorName", ""),
        "authorLink": data.get("generalAuthorLink", ""),
    }), encoding="utf-8")

    # Images: decode base64 to real files. First family icon doubles as
    # the pack emblem (logo.png).
    entries = []
    logo_written = False
    first_family_icon = (data.get("families") or [{}])[0].get("icon")
    for fname, b64 in sorted(images.items()):
        raw = base64.b64decode(b64)
        dst = staging / "sprites" / fname
        dst.write_bytes(raw)
        entries.append((f"sprites/{fname}", dst))
        if not logo_written and fname == first_family_icon:
            (staging / "logo.png").write_bytes(raw)
            logo_written = True

    for name in ("types.json", "species.json", "categories.json",
                 "items.json", "pack-info.json"):
        entries.append((name, staging / name))
    if logo_written:
        entries.append(("logo.png", staging / "logo.png"))

    args.out.mkdir(parents=True, exist_ok=True)
    toc = content_pack.write_pack(
        entries, args.out / "pack.bin", args.out / "pack.json",
        pack_id=args.pack_id)
    total = sum(e["length"] for e in toc["entries"].values())
    print(f"✓ {len(toc['entries'])} entries, "
          f"{total / (1024**2):.1f} MB → {args.out}")


if __name__ == "__main__":
    sys.exit(main())
