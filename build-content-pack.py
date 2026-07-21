#!/usr/bin/env python3
"""Build the creature content pack (pack.bin + pack.json manifest) for
upload to Hugging Face.

The pack is a TRANSPORT: its logical paths mirror data/BundledData/
byte-for-byte, path-for-path, so installing it on a client reproduces
today's data state exactly (same JSON shapes, same sprite bytes, same
key spaces — no new data model). See content_pack.py for the format.

Requires data/BundledData/ to be already built (run build-bundled-data.py
first if pieces are missing — this script only PACKS, never rebuilds).

Usage:
    python3 build-content-pack.py                     # full pack
    python3 build-content-pack.py --max-entries 200   # truncated, for iteration
"""

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
from collections import deque
from pathlib import Path

import content_pack
from species_pool import ALLOWED_SPECIES

ROOT = Path(__file__).resolve().parent
BUNDLED = ROOT / "data" / "BundledData"
DEFAULT_OUT = ROOT / "packs" / "creature-fusion"

# Mirrors LEGENDARY_SPECIES_SET in static/creatures.js (line ~3328) —
# keep in sync; completion scoring excludes these from the denominator.
LEGENDARY_SPECIES = {144, 145, 146, 150, 151}
# Mirrors CANDY_ROOT_BABIES in static/creatures.js (lines 317-326) —
# gen-2 baby pre-evolutions the candy root promotes past.
CANDY_ROOT_BABIES = {172, 173, 174, 175, 236, 238, 239, 240}

# Root-level bundled files every client needs (same logical path in pack).
ROOT_FILES = [
    "species-names.json", "species-types.json", "species-evolutions.json",
    "split-names.json", "cells.json", "manifest.json", "credits.json",
    "evo-items-list.json",
    "eggs.png", "egg-default.png", "egg-base.png", "egg-cracks.png",
    "candies.png", "shiny-palettes.bin",
]
# Subtrees included verbatim (logical path = relative path).
SUBTREES = ["sprites", "sprite-packs", "specials", "evo-items"]


def _node_dump(script):
    """Run a small node one-liner and return its stdout."""
    r = subprocess.run(
        ["node", "-e", script], cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"node dump failed:\n{r.stderr}")
    return r.stdout


def gen_types_json(staging):
    """Dump the canonical type registry (static/types.js) to JSON —
    same shape the runtime Types registry holds, so a client hydrates
    into the EXISTING data model."""
    out = _node_dump(
        "require('./static/types.js');const T=globalThis.Types;"
        "const o={order:T.list(),types:{}};"
        "for(const id of T.list()){const r=T.attackRow(id);"
        "o.types[id]={color:T.color(id),strong:r.strong,weak:r.weak,immune:r.immune};}"
        "console.log(JSON.stringify(o));")
    p = staging / "types.json"
    p.write_text(out, encoding="utf-8")
    return p


def gen_specials_json(staging):
    """Dump the solo-creature registry (static/specials.js)."""
    out = _node_dump(
        "require('./static/specials.js');"
        "console.log(JSON.stringify(globalThis.Specials.list()));")
    p = staging / "specials.json"
    p.write_text(out, encoding="utf-8")
    return p


def _families(evos):
    """Undirected family adjacency from species-evolutions.json."""
    adj = {}
    for src, rows in evos.items():
        src = int(src)
        adj.setdefault(src, set())
        for row in rows:
            tgt = int(row[0])
            adj[src].add(tgt)
            adj.setdefault(tgt, set()).add(src)
    return adj


def _candy_root(start, adj):
    """Walk the whole family, return the earliest non-baby id
    (mirrors candyRootFor in static/creatures.js)."""
    seen = {start}
    q = deque([start])
    while q:
        cur = q.popleft()
        for nxt in adj.get(cur, ()):
            if nxt not in seen:
                seen.add(nxt)
                q.append(nxt)
    candidates = [s for s in seen if s not in CANDY_ROOT_BABIES]
    return min(candidates) if candidates else min(seen)


def _reachable_forward(root, adj_directed):
    seen = {root}
    q = deque([root])
    while q:
        cur = q.popleft()
        for nxt in adj_directed.get(cur, ()):
            if nxt not in seen:
                seen.add(nxt)
                q.append(nxt)
    return seen


def gen_categories_json(staging, specials_defs):
    """categories.json — completion categories as data, mirroring today's
    semantics exactly: one category per supported species (head/body pair
    membership), legendaries flagged (excluded from the %), evolved forms
    flagged (hidden in non-evolved mode), plus one category per special
    category (glitch)."""
    names = json.loads((BUNDLED / "species-names.json").read_text(encoding="utf-8"))
    evos = json.loads((BUNDLED / "species-evolutions.json").read_text(encoding="utf-8"))
    adj = _families(evos)
    adj_directed = {int(k): {int(r[0]) for r in v} for k, v in evos.items()}

    categories = []
    for sid in sorted(ALLOWED_SPECIES):
        root = _candy_root(sid, adj)
        # evolved == reachable forward from the candy root, root itself
        # excluded (mirrors _isEvolvedSpecies in static/creatures.js).
        evolved = sid != root and sid in _reachable_forward(root, adj_directed)
        # species-names.json is a 0-indexed array (names[sid-1]), raw
        # lowercase — the client title-cases in Species.nameFor; mirror it.
        raw = names[sid - 1] if 0 < sid <= len(names) else ''
        categories.append({
            "id": f"species:{sid}",
            "name": (raw[:1].upper() + raw[1:]) if raw else f"#{sid}",
            "speciesId": sid,
            "legendary": sid in LEGENDARY_SPECIES,
            "evolved": evolved,
        })

    solo_categories = {}
    special_cats = []
    for d in specials_defs:
        cat = d.get("category") or "special"
        solo_categories[d["id"]] = [cat]
        if not any(c["id"] == cat for c in special_cats):
            special_cats.append({
                "id": cat,
                "name": cat[:1].upper() + cat[1:],
                "special": True,
            })

    doc = {
        "categories": categories + special_cats,
        "fusionRule": "a pair A×B belongs to categories species:A and species:B",
        "soloCategories": solo_categories,
    }
    p = staging / "categories.json"
    p.write_text(json.dumps(doc), encoding="utf-8")
    return p


def gather_entries(staging_files):
    """The full (logical_path, src_path) list, bundled-data-relative."""
    entries = []
    for name in ROOT_FILES:
        src = BUNDLED / name
        if not src.is_file():
            raise FileNotFoundError(
                f"{src} missing — run build-bundled-data.py first")
        entries.append((name, src))
    for sub in SUBTREES:
        base = BUNDLED / sub
        if not base.is_dir():
            raise FileNotFoundError(
                f"{base} missing — run build-bundled-data.py first")
        for f in sorted(base.rglob("*")):
            if f.is_file():
                entries.append((f.relative_to(BUNDLED).as_posix(), f))
    # Generated artifacts (types/specials/categories), same flat namespace.
    for logical, src in staging_files:
        entries.append((logical, src))
    # Pack logo: the map-button pokéball.
    entries.append(("logo.svg", ROOT / "static" / "poke-ball.svg"))
    return entries


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT,
                    help="output directory (default packs/creature-fusion)")
    ap.add_argument("--pack-id", default="creature-fusion")
    ap.add_argument("--max-entries", type=int, default=0,
                    help="truncate to N entries (iteration/testing)")
    args = ap.parse_args()

    t0 = time.time()
    print("→ Generating types.json / specials.json / categories.json …")
    with tempfile.TemporaryDirectory() as tmp:
        staging = Path(tmp)
        specials_defs = json.loads(_node_dump(
            "require('./static/specials.js');"
            "console.log(JSON.stringify(globalThis.Specials.list()));"))
        staging_files = [
            ("types.json", gen_types_json(staging)),
            ("specials.json", gen_specials_json(staging)),
            ("categories.json", gen_categories_json(staging, specials_defs)),
        ]
        entries = gather_entries(staging_files)
        if args.max_entries:
            # Truncated builds are for iteration/tests — always keep the
            # generated artifacts + logo regardless of the cap.
            extra = [e for e in entries
                     if e[1].parent == staging or e[0] == 'logo.svg']
            entries = entries[: args.max_entries]
            have = {logical for logical, _ in entries}
            entries += [e for e in extra if e[0] not in have]
        print(f"→ Packing {len(entries)} entries …")
        toc = content_pack.write_pack(
            entries, args.out / "pack.bin", args.out / "pack.json",
            pack_id=args.pack_id)

    total = sum(e["length"] for e in toc["entries"].values())
    print(f"✓ {len(toc['entries'])} entries, "
          f"{total / (1024**2):.1f} MB of content "
          f"({(args.out / 'pack.bin').stat().st_size / (1024**2):.1f} MB file) "
          f"in {time.time() - t0:.1f}s → {args.out}")
    for k in list(toc["entries"])[:3]:
        e = toc["entries"][k]
        print(f"    {k}: {e['length']} bytes @ {e['offset']}")


if __name__ == "__main__":
    sys.exit(main())
