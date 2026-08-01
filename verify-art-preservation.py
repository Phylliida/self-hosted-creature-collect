#!/usr/bin/env python3
"""Verify that the merged-art IF2 union build preserves the art of every
creature in recent save files.

For every distinct (speciesA, speciesB, variant) triple with a numeric
variant in the N most recent saves, compare the sprite-pack entry
(a, variant) in data/BundledData/sprite-packs/<b>.pack (CURRENT pack)
against data/BundledData-if2/sprite-packs/<b>.pack (merged build) —
this is exactly the lookup the native client does for a stored variant
(see generate_sprite_packs.py: entry variant == creature.variant slot).

Comparison is on decoded pixels (PNG encoding details could differ
between builds even for identical art).

Usage: python3 verify-art-preservation.py [n_saves] [save1.json save2.json ...]
"""

import json
import re
import struct
import sys
from io import BytesIO
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
OLD_PACKS = ROOT / "data" / "BundledData" / "sprite-packs"
NEW_PACKS = ROOT / "data" / "BundledData-if2" / "sprite-packs"


def read_pack_entry(path: Path, a: int, variant: int):
    """Return the PNG bytes for (a, variant) from a CRPP sprite pack,
    or None if absent."""
    if not path.is_file():
        return None
    buf = path.read_bytes()
    if buf[:4] != b"CRPP":
        raise ValueError(f"bad magic: {path}")
    (count,) = struct.unpack_from("<I", buf, 4)
    index_end = 8 + count * 16
    for i in range(count):
        ea, ev, eo, el = struct.unpack_from("<IiII", buf, 8 + i * 16)
        if ea == a and ev == variant:
            return buf[index_end + eo: index_end + eo + el]
    return None


def pixels(png: bytes):
    with Image.open(BytesIO(png)) as img:
        return img.convert("RGBA").tobytes()


def recent_saves(n: int) -> list[Path]:
    saves = []
    for f in (ROOT / "saves").glob("*.json"):
        m = re.search(r"_(\d+)\.json$", f.name)
        if m:
            saves.append((int(m.group(1)), f))
    return [f for _, f in sorted(saves)[-n:]]


def main() -> None:
    args = sys.argv[1:]
    n = 4
    if args and args[0].isdigit():
        n, args = int(args[0]), args[1:]
    save_paths = [Path(a) for a in args] if args else recent_saves(n)
    print(f"checking saves: {[p.name for p in save_paths]}")

    triples = set()
    for p in save_paths:
        data = json.loads(p.read_text())
        for c in data.get("captured", []):
            a, b, v = c.get("speciesA"), c.get("speciesB"), c.get("variant")
            if isinstance(a, int) and isinstance(b, int) and isinstance(v, int):
                triples.add((a, b, v))
    print(f"distinct (a, b, variant): {len(triples)}")

    identical = changed = missing_new = missing_old = 0
    changed_list = []
    missing_new_list = []
    for a, b, v in sorted(triples):
        old_png = read_pack_entry(OLD_PACKS / f"{b}.pack", a, v)
        new_png = read_pack_entry(NEW_PACKS / f"{b}.pack", a, v)
        if old_png is None:
            missing_old += 1      # variant from an older data era
            continue
        if new_png is None:
            missing_new += 1      # art LOST in the merged build
            missing_new_list.append((a, b, v))
            continue
        if old_png == new_png or pixels(old_png) == pixels(new_png):
            identical += 1
        else:
            changed += 1
            changed_list.append((a, b, v))

    print(f"identical: {identical}")
    print(f"changed:   {changed}   {changed_list[:20]}")
    print(f"missing in merged build: {missing_new}   {missing_new_list[:20]}")
    print(f"missing in current build (older era, skipped): {missing_old}")
    sys.exit(1 if (changed or missing_new) else 0)


if __name__ == "__main__":
    main()
