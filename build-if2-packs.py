#!/usr/bin/env python3
"""Build the IF2 generation-subset Pokémon packs.

Two-phase driver around the existing bundled-data pipeline:

  union   Build data/BundledData-if2/ for the UNION pool (gens 1-5,
          national dex 1..649) out of data/InfiniteFusion2 — same
          artifacts build-bundled-data.py produces for IF1, via the
          CC_* env overrides (species_pool.py / build-bundled-data.py).
          IF2's encrypted species.dat is decoded by extract-pif-dat.rb
          (XOR key from IF2's own 000_Encryption.rb).

  slice   Emit one content pack per (generation subset × families flag)
          variant (31 gen combos × 2 = 62 for gens 1-5) into
          packs/creature-if2/gen-<g>-<g>...[-fam]/pack.bin, by
          filtering/cropping the union tree — no pipeline re-runs.

  upload  Upload packs/creature-if2/ to the Hugging Face dataset
          (one repo, one subfolder per subset).

Usage:
  python3 build-if2-packs.py union [--with-shiny] [--jobs N]
  python3 build-if2-packs.py slice [--subsets 1,1-2,3-5] [--jobs N]
  python3 build-if2-packs.py upload
  python3 build-if2-packs.py all          # union + slice
  python3 build-if2-packs.py --list-subsets
"""

import argparse
import importlib.util
import itertools
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from PIL import Image

import content_pack
import species_pool

ROOT = Path(__file__).resolve().parent
IF2 = ROOT / "data" / "InfiniteFusion2"
SPLITNAMES_RB = (IF2 / "Data" / "Scripts" / "052_InfiniteFusion"
                 / "Fusion" / "Data" / "SplitNames.rb")
UNION_DIR = ROOT / "data" / "BundledData-if2"
PACKS_OUT = ROOT / "packs" / "creature-if2"
PACK_ID = "creature-if2"
HF_REPO = "TessaCoil/creature-pack-if2"

GENS = [1, 2, 3, 4, 5]

CELL_PX = 96
AUTOGEN_COLS = 10
CUSTOM_COLS = 20

# Sprite-pack (.pack) format — see generate_sprite_packs.py.
CRPP_MAGIC = b"CRPP"
# Shiny palette bin format — see shiny-palettes-to-bin.py.
SHIN_MAGIC = b"SHIN"
SHIN_VERSION = 2
SHIN_HEADER_BYTES = 16
SHIN_ENTRY_BYTES = 52  # u16 a, u16 b + 12 x 4B quantized triples


# ── Subsets ──────────────────────────────────────────────────────────
# A variant is (gen combo, families flag). 31 gen combos × 2 = 62 packs.
# The families flag closes the combo over evolution families (using the
# union build's evolution data): gen 1+2 +fam also includes gen-3/4
# evolutions and later-gen babies of gen-1/2 species (Crobat, Mamoswine,
# Munchlax…), and even gen-6/7 stragglers like Sylveon when IF2 has them.
def all_subsets() -> list[tuple[tuple[int, ...], bool]]:
    """Every (non-empty gen combo, families flag) pair — 62 for gens 1-5."""
    combos = []
    for r in range(1, len(GENS) + 1):
        combos.extend(itertools.combinations(GENS, r))
    return [(c, fam) for c in combos for fam in (False, True)]


def subset_key(combo: tuple[int, ...], fam: bool = False) -> str:
    return "gen-" + "-".join(str(g) for g in combo) + ("-fam" if fam else "")


def parse_subsets_arg(raw: str) -> list[tuple[tuple[int, ...], bool]]:
    """Parse --subsets '1,1-2,1-2-fam' into (combo, fam) tuples."""
    combos = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        fam = part.endswith("-fam")
        if fam:
            part = part[:-4]
        combo = tuple(sorted({int(g) for g in part.split("-")}))
        if not combo or any(g not in GENS for g in combo):
            raise ValueError(f"bad subset {part!r} (gens are {GENS})")
        if (combo, fam) not in combos:
            combos.append((combo, fam))
    return combos


# ── Union phase ──────────────────────────────────────────────────────
def union_env() -> dict:
    env = dict(os.environ)
    merged = ROOT / "data" / "MergedCustom"
    if not (merged / "spritesheets_custom").is_dir():
        raise SystemExit(
            f"{merged} missing — run `python3 merge-custom-art.py` first "
            "(merges IF1+IF2+Battlers custom art with IF1 indices preserved)")
    env.update({
        "CC_SPECIES_GENS": "1,2,3,4,5,6,7",  # full IF2 roster — family
        # closures may reach past gen 5 (Sylveon etc.); gen subsets still
        # filter to gens 1-5 at slice time.
        "CC_INFINITEFUSION": str(IF2),
        "CC_SPECIES_DAT": str(IF2 / "Data" / "species.dat"),
        "CC_SPLITNAMES_RB": str(SPLITNAMES_RB),
        "CC_CUSTOM_SHEETS_DIR": str(merged / "spritesheets_custom"),
        "CC_CREDITS_CSV": str(merged / "credits.csv"),
        "CC_BUNDLED_OUT": str(UNION_DIR),
    })
    return env


def write_empty_shin(path: Path) -> None:
    """A valid shiny-palettes.bin with zero entries (header only)."""
    path.write_bytes(SHIN_MAGIC + struct.pack("<III", SHIN_VERSION, 0, 0))


def cmd_union(args) -> None:
    env = union_env()
    print(f"→ Building union pool (gens {','.join(map(str, GENS))}) "
          f"from {IF2} → {UNION_DIR}")
    subprocess.run([sys.executable, "build-bundled-data.py"],
                   cwd=ROOT, env=env, check=True)
    if args.with_shiny:
        print("→ Baking shiny palettes for the union pool (slow)...")
        subprocess.run([
            sys.executable, "build-shiny-palettes.py", "--all",
            "--bundle-dir", str(UNION_DIR),
            "--output-json", str(UNION_DIR / "shiny-palettes.json"),
            "--jobs", str(args.jobs),
        ], cwd=ROOT, env=env, check=True)
        subprocess.run([
            sys.executable, "shiny-palettes-to-bin.py",
            "--input", str(UNION_DIR / "shiny-palettes.json"),
            "--output", str(UNION_DIR / "shiny-palettes.bin"),
        ], cwd=ROOT, env=env, check=True)
    if not (UNION_DIR / "shiny-palettes.bin").is_file():
        print("→ No shiny-palettes.bin — writing empty header-only bin")
        write_empty_shin(UNION_DIR / "shiny-palettes.bin")
    print("✓ union build done")


# ── Slice helpers ────────────────────────────────────────────────────
def load_gen_map() -> dict[int, int]:
    """PIF id -> generation number, for every id in the union pool
    (which spans gens 1-7 — the toggle dimension is gens 1-5, but
    family closures may pull in gen-6/7 species)."""
    mapping = species_pool.load_nat_dex_mapping(SPLITNAMES_RB)
    pool = json.loads((UNION_DIR / "species-pool.json").read_text())
    out = {}
    for pif in pool["species"]:
        national = mapping.get(pif, pif)
        for g, (lo, hi) in species_pool.GEN_NATIONAL_RANGES.items():
            if lo <= national <= hi:
                out[pif] = g
                break
    return out


def family_closure(ids: set[int], evos: dict) -> set[int]:
    """Close a species set over evolution families (undirected) — every
    species sharing a family with any member is included."""
    adj: dict[int, set[int]] = {}
    for src, rows in evos.items():
        s = int(src)
        adj.setdefault(s, set())
        for row in rows:
            adj[s].add(row[0])
            adj.setdefault(row[0], set()).add(s)
    out = set(ids)
    stack = list(ids)
    while stack:
        cur = stack.pop()
        for nxt in adj.get(cur, ()):
            if nxt not in out:
                out.add(nxt)
                stack.append(nxt)
    return out


def blank_and_crop_sheet(src: Path, dst: Path, cols: int,
                         rows_needed: int, keep: frozenset) -> None:
    """Copy a sprite sheet cropped to rows_needed rows, transparent-filling
    every body cell whose id is not in `keep`. Cell layout is 0-indexed
    with cell 0 empty (species id == cell index)."""
    img = Image.open(src)
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    height = min(img.height, rows_needed * CELL_PX)
    if height < img.height:
        img = img.crop((0, 0, img.width, height))
    cells_in_sheet = (img.height // CELL_PX) * cols
    blanks = [b for b in range(1, cells_in_sheet) if b not in keep]
    if blanks:
        clear = Image.new("RGBA", (CELL_PX, CELL_PX), (0, 0, 0, 0))
        for b in blanks:
            img.paste(clear, ((b % cols) * CELL_PX, (b // cols) * CELL_PX))
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst)


def slice_sprite_pack(src: Path, dst: Path, keep: frozenset) -> bool:
    """Rewrite a CRPP sprite pack keeping only entries whose partner id
    `a` is in `keep`. Returns False (writes nothing) if none survive."""
    buf = src.read_bytes()
    if buf[:4] != CRPP_MAGIC:
        raise ValueError(f"bad magic in {src}")
    (count,) = struct.unpack_from("<I", buf, 4)
    index_end = 8 + count * 16
    payload = buf[index_end:]
    kept = []
    for i in range(count):
        a, variant, offset, length = struct.unpack_from("<IiII", buf, 8 + i * 16)
        if a in keep:
            kept.append((a, variant, payload[offset:offset + length]))
    if not kept:
        return False
    out = bytearray()
    out += CRPP_MAGIC
    out += struct.pack("<I", len(kept))
    cursor = 0
    index = bytearray()
    blobs = bytearray()
    for a, variant, png in kept:
        index += struct.pack("<IiII", a, variant, cursor, len(png))
        blobs += png
        cursor += len(png)
    out += index + blobs
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(bytes(out))
    return True


def slice_shin(src: Path, dst: Path, keep: frozenset) -> None:
    """Filter a shiny-palettes.bin to entries whose (rootA, rootB) are
    both in `keep`. Entries stay sorted — filtering preserves order."""
    buf = src.read_bytes()
    if buf[:4] != SHIN_MAGIC:
        raise ValueError(f"bad magic in {src}")
    version, count, _ = struct.unpack_from("<III", buf, 4)
    entries = bytearray()
    kept = 0
    for i in range(count):
        off = SHIN_HEADER_BYTES + i * SHIN_ENTRY_BYTES
        a, b = struct.unpack_from("<HH", buf, off)
        if a in keep and b in keep:
            entries += buf[off:off + SHIN_ENTRY_BYTES]
            kept += 1
    dst.write_bytes(SHIN_MAGIC + struct.pack("<III", version, kept, 0) + entries)


def _load_bcp():
    """Import build-content-pack.py as a module (for its node dumps and
    category helpers)."""
    spec = importlib.util.spec_from_file_location(
        "bcp", ROOT / "build-content-pack.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def gen_categories(names: list, evos: dict, ids: list, legendaries: set,
                   babies: set, specials_defs: list,
                   bcp) -> dict:
    """categories.json for one subset — same semantics as
    build-content-pack.gen_categories_json but computed from the sliced
    names/evolutions so `evolved` flags match what the client derives."""
    adj = bcp._families(evos)
    adj_directed = {int(k): {int(r[0]) for r in v} for k, v in evos.items()}

    def candy_root(start: int) -> int:
        seen = {start}
        queue = [start]
        while queue:
            cur = queue.pop(0)
            for nxt in adj.get(cur, ()):
                if nxt not in seen:
                    seen.add(nxt)
                    queue.append(nxt)
        candidates = [s for s in seen if s not in babies]
        return min(candidates) if candidates else min(seen)

    categories = []
    for sid in sorted(ids):
        root = candy_root(sid)
        evolved = sid != root and sid in bcp._reachable_forward(root, adj_directed)
        raw = names[sid - 1] if 0 < sid <= len(names) else ""
        categories.append({
            "id": f"species:{sid}",
            "name": (raw[:1].upper() + raw[1:]) if raw else f"#{sid}",
            "speciesId": sid,
            "legendary": sid in legendaries,
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
    return {
        "categories": categories + special_cats,
        "fusionRule": "a pair A×B belongs to categories species:A and species:B",
        "soloCategories": solo_categories,
    }


# ── Slice phase ──────────────────────────────────────────────────────
# Multiprocessing worker state (slice --jobs N): each worker process
# gets its own gen_map + generic staging + build-content-pack import
# via the pool initializer.
_WORKER: dict = {}


def _slice_worker_init(gen_map: dict, generic_dir: str, specials_defs: list) -> None:
    _WORKER["gen_map"] = gen_map
    _WORKER["generic"] = {
        "dir": Path(generic_dir),
        "bcp": _load_bcp(),
        "specials_defs": specials_defs,
    }


def _slice_worker(variant: tuple[tuple[int, ...], bool]) -> tuple[str, int]:
    key = slice_subset(variant, _WORKER["gen_map"], _WORKER["generic"], PACKS_OUT)
    size = (PACKS_OUT / key / "pack.bin").stat().st_size
    return key, size


def slice_subset(variant: tuple[tuple[int, ...], bool], gen_map: dict[int, int],
                 generic: dict, out_root: Path) -> str:
    """Build packs/creature-if2/<subset-key>/ from the union tree.
    `variant` is (gen combo, families flag); `generic` carries the
    subset-independent staged files (types.json, specials.json, specials
    defs, logo). Returns the subset key."""
    combo, fam = variant
    key = subset_key(combo, fam)
    union_pool = json.loads((UNION_DIR / "species-pool.json").read_text())
    base = {p for p in union_pool["species"] if gen_map.get(p) in combo}
    if fam:
        union_evos = json.loads(
            (UNION_DIR / "species-evolutions.json").read_text())
        ids = sorted(family_closure(base, union_evos))
    else:
        ids = sorted(base)
    keep = frozenset(ids)
    smax = ids[-1]

    with tempfile.TemporaryDirectory() as tmp:
        staging = Path(tmp) / "stage"
        staging.mkdir()

        def wjson(name: str, data) -> None:
            (staging / name).write_text(
                json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8")

        # ── JSON artifacts ──────────────────────────────────────
        names = json.loads((UNION_DIR / "species-names.json").read_text())
        wjson("species-names.json",
              [n if (i + 1) in keep else "" for i, n in enumerate(names)])

        split = json.loads((UNION_DIR / "split-names.json").read_text())
        wjson("split-names.json",
              [v if i in keep else ["", ""] for i, v in enumerate(split)])

        types = json.loads((UNION_DIR / "species-types.json").read_text())
        wjson("species-types.json",
              {k: v for k, v in types.items() if int(k) in keep})

        evos = json.loads((UNION_DIR / "species-evolutions.json").read_text())
        evos = {
            k: [row for row in v if row[0] in keep]
            for k, v in evos.items() if int(k) in keep
        }
        evos = {k: v for k, v in evos.items() if v}
        wjson("species-evolutions.json", evos)

        cells = json.loads((UNION_DIR / "cells.json").read_text())
        wjson("cells.json", {
            k: v for k, v in cells.items()
            if all(int(p) in keep for p in k.split("-", 1))
        })

        manifest = json.loads((UNION_DIR / "manifest.json").read_text())
        wjson("manifest.json",
              {k: v for k, v in manifest.items() if int(k) in keep})

        credits = json.loads((UNION_DIR / "credits.json").read_text())
        wjson("credits.json", {
            k: v for k, v in credits.items()
            if all(int(p) in keep for p in k.split("-", 1))
        })

        # species-pool.json — spawnable derived from the sliced evos:
        # non-legendary, non-baby species that aren't the target of a
        # NON-BABY in-subset evolution — each family's first non-baby
        # form (Snorlax spawns even with Munchlax in the pack; babies
        # are egg-only, evolved forms candy-only).
        babies = set(union_pool["babies"]) & keep
        non_baby_targets = {
            row[0] for src, rows in evos.items() if int(src) not in babies
            for row in rows
        }
        legendaries = sorted(set(union_pool["legendaries"]) & keep)
        wjson("species-pool.json", {
            "species": ids,
            "legendaries": legendaries,
            "babies": sorted(babies),
            "spawnable": [s for s in ids
                          if s not in non_baby_targets
                          and s not in set(union_pool["legendaries"])
                          and s not in babies],
            "maxSpecies": smax,
        })

        wjson("categories.json", gen_categories(
            names, evos, ids, set(legendaries),
            set(union_pool["babies"]) & keep,
            generic["specials_defs"], generic["bcp"]))

        # Evo items used by the sliced evolutions only.
        item_params = sorted({
            row[2] for rows in evos.values() for row in rows
            if len(row) >= 3 and row[1] == "Item"
        })
        wjson("evo-items-list.json", {"items": item_params})
        for param in item_params:
            src = UNION_DIR / "evo-items" / f"{param}.png"
            if src.is_file():
                dst = staging / "evo-items" / f"{param}.png"
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, dst)

        # ── Sprite sheets: crop + blank out-of-subset body cells ──
        autogen_rows = (smax // AUTOGEN_COLS) + 1
        custom_rows = (smax // CUSTOM_COLS) + 1
        full = keep == frozenset(union_pool["species"])
        for head in ids:
            src_dir = UNION_DIR / "sprites" / str(head)
            if not src_dir.is_dir():
                continue
            for src in sorted(src_dir.rglob("*.png")):
                rel = src.relative_to(UNION_DIR)
                dst = staging / rel
                if full:
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(src, dst)
                elif "autogen" in src.parent.name:
                    blank_and_crop_sheet(src, dst, AUTOGEN_COLS,
                                         autogen_rows, keep)
                else:
                    blank_and_crop_sheet(src, dst, CUSTOM_COLS,
                                         custom_rows, keep)

        # ── Sprite packs: filter entries per partner ────────────
        packs_src = UNION_DIR / "sprite-packs"
        if packs_src.is_dir():
            for b in ids:
                src = packs_src / f"{b}.pack"
                if src.is_file():
                    slice_sprite_pack(src, staging / "sprite-packs" / f"{b}.pack",
                                      keep)

        # ── Shiny palettes: filter root pairs ───────────────────
        shin = UNION_DIR / "shiny-palettes.bin"
        if shin.is_file():
            slice_shin(shin, staging / "shiny-palettes.bin", keep)
        else:
            write_empty_shin(staging / "shiny-palettes.bin")

        # ── Positional sheets + specials: copy union as-is ──────
        for name in ("eggs.png", "candies.png", "egg-default.png",
                     "egg-base.png", "egg-cracks.png"):
            src = UNION_DIR / name
            if src.is_file():
                shutil.copyfile(src, staging / name)
        specials_src = UNION_DIR / "specials"
        if specials_src.is_dir():
            shutil.copytree(specials_src, staging / "specials")

        # ── Generic artifacts (same for every subset) ───────────
        for name in ("types.json", "specials.json", "logo.svg"):
            shutil.copyfile(generic["dir"] / name, staging / name)

        entries = [
            (f.relative_to(staging).as_posix(), f)
            for f in sorted(staging.rglob("*")) if f.is_file()
        ]
        out_dir = out_root / key
        content_pack.write_pack(entries, out_dir / "pack.bin",
                                out_dir / "pack.json", pack_id=PACK_ID)
    return key


def cmd_slice(args) -> None:
    if not (UNION_DIR / "species-pool.json").is_file():
        raise SystemExit(f"{UNION_DIR} missing — run `union` first")
    combos = (parse_subsets_arg(args.subsets) if args.subsets
              else all_subsets())
    gen_map = load_gen_map()
    print(f"→ Slicing {len(combos)} subset packs from {UNION_DIR}")

    # Generic staged files shared by every subset (node dumps are slow
    # enough to only do once).
    bcp = _load_bcp()
    generic_dir = Path(tempfile.mkdtemp(prefix="if2-generic-"))
    (generic_dir / "types.json").write_text(
        (bcp.gen_types_json(generic_dir)).read_text(), encoding="utf-8")
    (generic_dir / "specials.json").write_text(
        (bcp.gen_specials_json(generic_dir)).read_text(), encoding="utf-8")
    shutil.copyfile(ROOT / "static" / "poke-ball.svg", generic_dir / "logo.svg")
    generic = {
        "dir": generic_dir,
        "bcp": bcp,
        "specials_defs": json.loads((generic_dir / "specials.json").read_text()),
    }

    t0 = time.time()
    if args.jobs > 1 and len(combos) > 1:
        import multiprocessing as mp
        with mp.Pool(args.jobs, initializer=_slice_worker_init,
                     initargs=(gen_map, str(generic_dir),
                               generic["specials_defs"])) as pool:
            for i, (key, size) in enumerate(
                    pool.imap_unordered(_slice_worker, combos), 1):
                print(f"  [{i}/{len(combos)}] {key}: {size / (1024**2):.0f} MB "
                      f"({time.time() - t0:.0f}s elapsed)", flush=True)
    else:
        for i, combo in enumerate(combos, 1):
            key = slice_subset(combo, gen_map, generic, PACKS_OUT)
            size = (PACKS_OUT / key / "pack.bin").stat().st_size
            print(f"  [{i}/{len(combos)}] {key}: {size / (1024**2):.0f} MB "
                  f"({time.time() - t0:.0f}s elapsed)", flush=True)
    shutil.rmtree(generic_dir, ignore_errors=True)
    print(f"✓ {len(combos)} subset packs → {PACKS_OUT}")


def cmd_upload(_args) -> None:
    subprocess.run(
        ["scripts/upload-content-pack.sh", HF_REPO, str(PACKS_OUT.relative_to(ROOT))],
        cwd=ROOT, check=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", nargs="?",
                    choices=["union", "slice", "upload", "all"])
    ap.add_argument("--list-subsets", action="store_true",
                    help="print the subset keys as JSON and exit")
    ap.add_argument("--subsets", default="",
                    help="comma list of subsets to slice, e.g. '1,1-2,1-2-fam' "
                         "(default: all 62)")
    ap.add_argument("--with-shiny", action="store_true",
                    help="union: also bake shiny palettes (hours)")
    ap.add_argument("--jobs", type=int, default=1,
                    help="parallel workers (shiny bake, and slice across subsets). "
                         "WARNING: keep the shiny bake at 5 or below on this "
                         "machine — 32 workers hard-crashed it (twice).")
    args = ap.parse_args()

    if args.list_subsets:
        print(json.dumps([subset_key(c, fam) for c, fam in all_subsets()]))
        return
    if not args.command:
        ap.error("need a command (union/slice/upload/all) or --list-subsets")
    if args.command in ("union", "all"):
        cmd_union(args)
    if args.command in ("slice", "all"):
        cmd_slice(args)
    if args.command == "upload":
        cmd_upload(args)


if __name__ == "__main__":
    main()
