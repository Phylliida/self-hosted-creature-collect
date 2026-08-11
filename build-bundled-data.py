#!/usr/bin/env python3
"""Build data/BundledData/ — a self-contained snapshot of all the
data the client needs for the pool (species_pool.py) Pokémon.

Bundled into the iOS / Android wrapper IPA/APK so users can play
without the post-install bulk-download step.

Inputs live under data/InfiniteFusion/, except the custom variant
sheets + credits, which prefer the merged multi-source tree
data/MergedCustom/ (IF1+IF2+Battlers — run merge-custom-art.py first;
IF1 variant indices are preserved there by construction, so existing
creatures keep their images) and fall back to pure IF1 when the merge
hasn't been built. The Ruby Marshal `.dat` files (species.dat,
evolutions.dat) are decoded via `extract-pif-dat.rb`
(subprocess; needs `ruby` on PATH). Note: types.dat is NOT decoded —
the canonical type list + effectiveness chart lives in the app code at
static/types.js (global.Types), not in the bundled data.

Inputs:
  data/InfiniteFusion/Graphics/Battlers/spritesheets_autogen/<head>.png
      autogen sheets, 960×4896 (10×51 cells of 96px)
  data/MergedCustom/spritesheets_custom/<head>/<head>[v].png
      custom variant sheets (merged multi-source), 1920×… (20 cols of
      96px); fallback: the IF1-only tree under CustomBattlers/
  data/InfiniteFusion/Graphics/Battlers/Eggs/<id>.png
      per-species egg images (160×160), packed into one sprite sheet
  data/InfiniteFusion/Data/species.dat       Marshal: id_number → Species
  data/InfiniteFusion/Data/Scripts/052_InfiniteFusion/Fusion/SplitNames.rb
  data/MergedCustom/credits.csv (fallback: IF1 Data/sprites/Sprite_Credits.csv)

  icons/                 POI marker SVGs (the same files /icons serves)
  fonts/<stack>/*.pbf    map label glyphs (the same files /fonts serves)
  data/*.mbtiles         vector tiles — zoom 0..BASE_MAP_MAX_ZOOM
                         extracted to BundledData/tiles/<z>/<x>/<y>.pbf
                         (matches the /tiles URL layout)

Outputs (under data/BundledData/):
  split-names.json         array of [prefix, suffix] indexed by national dex
  credits.json             {"<a>-<b>": {variant_suffix: artist}}
  species-names.json       array (1-indexed: array[0] == "bulbasaur")
  species-types.json       {"<id>": [type1, type2|null]}, pool ids
  species-evolutions.json  {"<id>": [[target, method, param], ...]}, pool sources
  manifest.json            {"<head>": [variant_suffix, ...]}
  cells.json               {"<body>-<head>": [variant_index, ...]}
                           — which (body, head) fusions have non-blank
                           custom art under which variant indices.
                           Pre-computed at build so the runtime can
                           skip its old alpha-scan on first launch.
  sprites/<head>/autogen/<head>.png         autogen sheet cropped to
                                            first 150 partners
                                            (10 cols × 16 rows of 96px)
  sprites/<head>/custom/<head>[v].png       custom variant sheets,
                                            similarly cropped
                                            (20 cols × 8 rows)

Run:
  nix-shell  (to get python3 + pillow)
  python3 build-bundled-data.py

Idempotent — overwrites existing BundledData/ contents. Safe to re-run."""

import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("error: pillow (PIL) not found. Add `python3Packages.pillow` to "
          "shell.nix and re-enter the shell.", file=sys.stderr)
    sys.exit(1)

# ── Constants ────────────────────────────────────────────────────────────
#
# Allowed species pool lives in `species_pool.py` so every script in the
# pipeline (sprite packs, candy art, egg art) sees the same set. Layout
# is sparse — gen 1 contiguous 1..150 plus specific gen-2/3/4 picks.
# Sheet crop heights still derive from MAX_SPECIES (the largest id we
# need to position) — positional cells between gen 1 and the highest
# extra stay in the sheet but are mostly transparent (PNG compresses
# them away).
from species_pool import (  # noqa: E402
    ALLOWED_SPECIES, ALLOWED_SET, MAX_SPECIES,
    LEGENDARY_SPECIES, SPAWNABLE_SPECIES, CANDY_ROOT_BABIES,
)

CELL_PX = 96

# Sheets are 0-indexed: cell 0 is intentionally empty (so the natural
# species-id == cell-index math works directly). For species N to be
# present, the sheet needs to contain cells 0..N inclusive, so the
# row count is (N // cols) + 1, not ceil(N / cols).

# Autogen sheets are 10 cols × 51 rows of 96px cells in source (covers
# up to species 509). For MAX_SPECIES=478 we need rows 0..47 = 48 rows.
AUTOGEN_COLS = 10
AUTOGEN_ROWS_NEEDED = (MAX_SPECIES // AUTOGEN_COLS) + 1
AUTOGEN_HEIGHT_NEEDED = AUTOGEN_ROWS_NEEDED * CELL_PX

# Custom sheets are 20 cols × 29 rows in source (covers up to species
# 579). For MAX_SPECIES=478 we need rows 0..23 = 24 rows.
CUSTOM_COLS = 20
CUSTOM_ROWS_NEEDED = (MAX_SPECIES // CUSTOM_COLS) + 1
CUSTOM_HEIGHT_NEEDED = CUSTOM_ROWS_NEEDED * CELL_PX

ROOT = Path(__file__).resolve().parent

# Path overrides for building from an alternate game tree (used by
# build-if2-packs.py for the InfiniteFusion2 generation-subset packs).
# Defaults preserve the original IF1 behavior exactly.
def _env_path(name: str, default: Path) -> Path:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    p = Path(raw)
    return p if p.is_absolute() else ROOT / p


INFINITEFUSION = _env_path("CC_INFINITEFUSION", ROOT / "data" / "InfiniteFusion")
# Sprite sheet sources live inside InfiniteFusion's Graphics tree —
# Battlers/ is for the autogen sheets, CustomBattlers/ for custom.
AUTOGEN_SHEETS_DIR = INFINITEFUSION / "Graphics" / "Battlers" / "spritesheets_autogen"
# IF1's autogen tree stops at head 501, and its sheets only cover
# bodies 0..509 — the high PIF gen-3 ids (502+) have autogen art only
# in the IF2 tree. build_autogen_sheet composites: IF1 rows stay
# canonical, missing rows/heads come from this tree. When
# CC_INFINITEFUSION already points at the IF2 tree this is a no-op.
AUTOGEN_FALLBACK_DIR = _env_path(
    "CC_AUTOGEN_FALLBACK_DIR",
    ROOT / "data" / "InfiniteFusion2" / "Graphics" / "Battlers"
    / "spritesheets_autogen")
# Custom art: prefer the merged multi-source tree (IF1 + IF2 + legacy
# Battlers — see merge-custom-art.py) once it has been built. IF1
# variant indices are preserved there BY CONSTRUCTION, so existing
# creatures' stored variants render the identical images while
# new-source art appends variants and covers heads IF1 never had.
# Pure IF1 is the fallback when the merge hasn't been run.
_MERGED = ROOT / "data" / "MergedCustom"
CUSTOM_SHEETS_DIR = _env_path(
    "CC_CUSTOM_SHEETS_DIR",
    (_MERGED / "spritesheets_custom")
    if (_MERGED / "spritesheets_custom").is_dir()
    else (INFINITEFUSION / "Graphics" / "CustomBattlers"
          / "spritesheets" / "spritesheets_custom"))
EGGS_DIR = INFINITEFUSION / "Graphics" / "Battlers" / "Eggs"
EVO_ITEMS_SRC = INFINITEFUSION / "Graphics" / "Items"
SPECIES_DAT = _env_path("CC_SPECIES_DAT", INFINITEFUSION / "Data" / "species.dat")
CREDITS_CSV = _env_path(
    "CC_CREDITS_CSV",
    (_MERGED / "credits.csv")
    if (_MERGED / "credits.csv").is_file()
    else (INFINITEFUSION / "Data" / "sprites" / "Sprite_Credits.csv"))
SPLITNAMES_RB = _env_path(
    "CC_SPLITNAMES_RB",
    INFINITEFUSION / "Data" / "Scripts" / "052_InfiniteFusion" / "Fusion" / "SplitNames.rb",
)
EXTRACTOR_SCRIPT = ROOT / "extract-pif-dat.rb"

# App-data sources — the same files /icons and /fonts serve at runtime.
ICONS_SRC = ROOT / "icons"
FONTS_SRC = ROOT / "fonts"
DATA_DIR = ROOT / "data"

# Base-map tile extraction range. Mirrors `BASE_MAP_MAX_ZOOM = 5`
# in static/index.html — the "Download App Data" button prefetches
# the world at z0..z5 (~3 MB total). Bundling the same tiles lets
# us drop the prefetch step in the native app.
BASE_MAP_MAX_ZOOM = 5

OUT_DIR = _env_path("CC_BUNDLED_OUT", ROOT / "data" / "BundledData")

# Egg sprite sheet layout. 160×160 cells matches the upstream files;
# 10 cols mirrors the autogen sheet convention so the client can use
# the same indexing math: cell index == species id, with cell 0
# intentionally empty (so 150 species need 151 cells = 16 rows).
EGG_PX = 160
EGG_COLS = 10
EGG_ROWS_NEEDED = (MAX_SPECIES // EGG_COLS) + 1  # 16

# Regex for parsing SplitNames.rb entries. Captures the [prefix, suffix]
# string pair from each `["...", "..."],` line.
SPLIT_NAMES_RE = re.compile(
    r"""\[\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]"""
)

# Filename pattern for custom variant sheets: <head>[<variant>].png
# where <variant> is one or more lowercase letters (e.g., "1.png" base,
# "1a.png", "1b.png", "1ab.png"). Captures the variant suffix.
CUSTOM_FILENAME_RE = re.compile(r"^(\d+)([a-z]*)\.png$")

# Regex for parsing the credits CSV. Lines look like:
#   1.5,artistname,main,
#   1.5a,artistname,alt,reference;pikmin;bulborb
# Captures (a, b, variant_suffix, artist).
_CREDITS_KEY_RE = re.compile(r"^(\d+)\.(\d+)([a-z]*)$")


# ── Helpers ──────────────────────────────────────────────────────────────
def crop_sheet(src: Path, dst: Path, max_height: int) -> None:
    """Open `src`, crop to (full_width × max_height) — the first
    MAX_SPECIES partners worth of cells — and save to `dst`. Skips if
    the source is shorter than max_height (already small enough)."""
    img = Image.open(src)
    if img.height <= max_height:
        # Already smaller than the crop window; just copy.
        shutil.copyfile(src, dst)
        return
    cropped = img.crop((0, 0, img.width, max_height))
    cropped.save(dst, optimize=True)


def build_autogen_sheet(head: int, dst: Path) -> bool:
    """Write the bundled autogen sheet for one head. The canonical IF1
    sheet is the base; body rows IF1 never generated (its sheets stop
    at body 509 — the gen-3 high PIF ids) are filled from the IF2
    tree's sheet for the same head. Only rows IF1 lacks come from IF2,
    so no existing cell's art changes. Heads IF1 doesn't cover at all
    use the IF2 sheet wholesale. Returns False when neither tree has
    the head's sheet."""
    primary = AUTOGEN_SHEETS_DIR / f"{head}.png"
    fallback = AUTOGEN_FALLBACK_DIR / f"{head}.png"
    if primary.is_file():
        base_path = primary
    elif fallback.is_file():
        base_path = fallback
    else:
        return False
    need_w = AUTOGEN_COLS * CELL_PX
    need_h = AUTOGEN_HEIGHT_NEEDED
    base = Image.open(base_path).convert("RGBA")
    dst.parent.mkdir(parents=True, exist_ok=True)
    if base.height >= need_h:
        base.crop((0, 0, need_w, need_h)).save(dst, optimize=True)
        return True
    out = Image.new("RGBA", (need_w, need_h), (0, 0, 0, 0))
    out.paste(base, (0, 0))
    if base_path == primary and fallback.is_file():
        fb = Image.open(fallback).convert("RGBA")
        fb_h = min(fb.height, need_h)
        if fb_h > base.height:
            out.paste(fb.crop((0, base.height, need_w, fb_h)),
                      (0, base.height))
    out.save(dst, optimize=True)
    return True


# Alpha threshold matches sprites.js ALPHA_MIN — pixels with
# alpha > 8 are treated as opaque, anything ≤ 8 as transparent.
# Used for tight-bbox cropping so individual sprite PNGs match
# what the runtime would produce.
ALPHA_MIN = 8


def trim_alpha(img: "Image.Image"):
    """Return (bbox, trimmed) for the non-transparent region of an
    RGBA image, or (None, None) if every pixel has alpha ≤ ALPHA_MIN.
    Implementation: build a binary alpha mask via PIL's point() LUT
    (C-fast), then call getbbox() on the mask. Avoids a numpy dep."""
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    alpha = img.split()[3]
    lut = [0 if a <= ALPHA_MIN else 255 for a in range(256)]
    mask = alpha.point(lut, mode="L")
    bbox = mask.getbbox()
    if bbox is None:
        return None, None
    return bbox, img.crop(bbox)


def alpha_scan_custom_sheet(sheet_path: Path, cols: int, max_height: int) -> list[int]:
    """Open a custom variant sheet and return the list of body indices
    (from ALLOWED_SPECIES) whose 96×96 cell has any opaque pixel above
    ALPHA_MIN. Used to populate cells.json so the runtime can pick a
    variant slot for each fusion without alpha-scanning at startup."""
    sheet = Image.open(sheet_path).convert("RGBA")
    bodies: list[int] = []
    for body in ALLOWED_SPECIES:
        col = body % cols
        row = body // cols
        x0, y0 = col * CELL_PX, row * CELL_PX
        x1, y1 = x0 + CELL_PX, y0 + CELL_PX
        if x1 > sheet.width or y1 > sheet.height or y1 > max_height:
            continue
        bbox, _ = trim_alpha(sheet.crop((x0, y0, x1, y1)))
        if bbox is not None:
            bodies.append(body)
    return bodies


_NAT_DEX_MAPPING_RE = re.compile(r"(\d+)\s*=>\s*(\d+)")


def build_split_names() -> list:
    """Parse SplitNames.rb and re-emit a [prefix, suffix] array indexed
    by **PIF id_number**. The source SPLIT_NAMES table is positional by
    *national dex*, and PIF's runtime translates PIF id_number → national
    dex via NAT_DEX_MAPPING (declared in the same file) before lookup —
    see FusedSpecies.rb's calculate_name. We mirror that here at build
    time so the client can keep doing a simple `table[id]` lookup.

    Gen 1 and most of gen 2 have id_number == national_dex; gen 3+
    diverges (Mawile national 303 → PIF 300, etc.) — without the
    translation Mawile fusions inherit Skitty's suffix. The path comes
    from SPLITNAMES_RB (CC_SPLITNAMES_RB override) since game trees
    disagree on the directory depth (IF2 nests it one level deeper)."""
    path = SPLITNAMES_RB
    text = path.read_text(encoding="utf-8", errors="replace")

    # 1. The positional [prefix, suffix] table — national-dex indexed.
    natdex_table: list[list[str]] = []
    for m in SPLIT_NAMES_RE.finditer(text):
        natdex_table.append([m.group(1), m.group(2)])

    # 2. The PIF id_number → national_dex map, parsed out of the same
    #    file. We scope to the NAT_DEX_MAPPING = { ... } block so a
    #    stray `=>` elsewhere in the file doesn't bleed in.
    pif_to_nat: dict[int, int] = {}
    mapping_match = re.search(
        r"NAT_DEX_MAPPING\s*=\s*\{(.*?)\}",
        text, re.DOTALL,
    )
    if mapping_match:
        block = mapping_match.group(1)
        for m in _NAT_DEX_MAPPING_RE.finditer(block):
            pif_to_nat[int(m.group(1))] = int(m.group(2))
    else:
        print("  ⚠ NAT_DEX_MAPPING block not found in SplitNames.rb")

    # 3. Build the output array indexed by PIF id, length MAX_SPECIES+1.
    #    For each allowed PIF species, translate to national dex (if it
    #    differs) and read SplitNames at that position.
    out: list[list[str]] = [["", ""] for _ in range(MAX_SPECIES + 1)]
    for pif_id in ALLOWED_SPECIES:
        nat_id = pif_to_nat.get(pif_id, pif_id)
        if 0 < nat_id < len(natdex_table):
            out[pif_id] = list(natdex_table[nat_id])
    return out


def build_credits() -> dict:
    """Parse Sprite_Credits.csv, filter to fusions where both species
    are in 1..MAX_SPECIES, and group as {"a-b": {variant: artist}}."""
    path = CREDITS_CSV
    out: dict[str, dict[str, str]] = {}
    with path.open(encoding="utf-8", errors="replace") as f:
        for raw in f:
            parts = raw.rstrip("\r\n").split(",")
            if len(parts) < 2:
                continue
            key = parts[0].strip()
            artist = parts[1].strip()
            if not key or not artist or "." not in key:
                continue
            a_str, rest = key.split(".", 1)
            if not a_str.isdigit():
                continue
            m = _CREDITS_KEY_RE.match(f"{a_str}.{rest}")
            if not m:
                continue
            a = int(m.group(1))
            b = int(m.group(2))
            variant = m.group(3)
            if a not in ALLOWED_SET or b not in ALLOWED_SET:
                continue
            d = out.setdefault(f"{a}-{b}", {})
            d.setdefault(variant, artist)
    return out


_species_cache: dict | None = None


def load_species_dat() -> dict:
    """Subprocess-shell out to extract-pif-dat.rb to decode species.dat
    (Ruby Marshal binary). Returns the full normalised dict — keyed by
    the species symbol-as-string (e.g. "BULBASAUR"). Cached so we only
    run the extraction once per script invocation."""
    global _species_cache
    if _species_cache is not None:
        return _species_cache
    if not SPECIES_DAT.is_file():
        raise FileNotFoundError(f"missing: {SPECIES_DAT}")
    if not EXTRACTOR_SCRIPT.is_file():
        raise FileNotFoundError(f"missing: {EXTRACTOR_SCRIPT}")
    print(f"  → ruby {EXTRACTOR_SCRIPT.name} {SPECIES_DAT.name}")
    proc = subprocess.run(
        ["ruby", str(EXTRACTOR_SCRIPT), str(SPECIES_DAT)],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"extract-pif-dat.rb failed (exit {proc.returncode}):\n{proc.stderr}"
        )
    _species_cache = json.loads(proc.stdout)
    return _species_cache


def build_species_names() -> list:
    """Lowercase species names indexed by national-dex number for every
    species in ALLOWED_SET. Output is a contiguous 1-indexed array of
    length MAX_SPECIES; slots whose id isn't in ALLOWED_SET get the
    empty string (the client's `nameFor` returns `#N` for empty slots
    and `allSpecies` skips them, so they don't pollute autocomplete)."""
    species = load_species_dat()
    by_id_num: dict[int, str] = {}
    for entry in species.values():
        idn = entry.get("id_number")
        name = entry.get("real_name") or entry.get("id")
        if not isinstance(idn, int) or not name:
            continue
        if idn in ALLOWED_SET:
            by_id_num[idn] = str(name).lower()
    return [by_id_num.get(i, "") for i in range(1, MAX_SPECIES + 1)]


def build_species_types() -> dict:
    """Map id_number → [primary_type, secondary_type|null] for ids in
    ALLOWED_SET. PIF stores @types as either a single symbol or a
    2-element array of symbols on each Species; we normalise to
    always-array-of-2."""
    species = load_species_dat()
    out: dict[str, list] = {}
    for entry in species.values():
        idn = entry.get("id_number")
        if not isinstance(idn, int) or idn not in ALLOWED_SET:
            continue
        # PIF's GameData::Species exposes @type1 / @type2 (recent
        # essentials) OR @types as an array. Handle both shapes.
        t1 = entry.get("type1")
        t2 = entry.get("type2")
        if t1 is None and isinstance(entry.get("types"), list):
            ts = entry["types"]
            t1 = ts[0] if len(ts) >= 1 else None
            t2 = ts[1] if len(ts) >= 2 else None
        if t1 is None:
            continue
        # Normalise None / equal-to-primary → null secondary.
        if t2 is None or t2 == t1:
            out[str(idn)] = [t1, None]
        else:
            out[str(idn)] = [t1, t2]
    return out


def _id_symbol_to_number_map(species: dict) -> dict[str, int]:
    """Reverse-lookup: species symbol (e.g. "IVYSAUR") → id_number int.
    Used to convert evolution targets (which are stored as symbols) into
    numeric IDs the client renders."""
    out: dict[str, int] = {}
    for entry in species.values():
        sym = entry.get("id")
        idn = entry.get("id_number")
        if isinstance(sym, str) and isinstance(idn, int):
            out[sym] = idn
    return out


def build_species_evolutions() -> dict:
    """Map source id_number → [[target_id_number, method, param], ...]
    for sources in ALLOWED_SET. Targets are also filtered to
    ALLOWED_SET — an evolution pointing at an out-of-pool species is
    dropped (the client couldn't render it anyway). PIF stores
    @evolutions on each Species as [[target_symbol, method_symbol,
    param, prevolution?], ...]; we drop prevolution rows and resolve
    target symbols → numbers."""
    species = load_species_dat()
    sym_to_num = _id_symbol_to_number_map(species)
    # Methods that genuinely require an item. The client evolves with candy and
    # only enforces *item* conditions, so when a target offers both an item
    # method (e.g. Linking Cord, Reaper Cloth) and a level/move fallback, the
    # fallback would let the player skip the required item. Keep only the item
    # method for such targets — see the dedup below.
    ITEM_METHODS = {"Item", "TradeItem", "DayHoldItem"}
    out: dict[str, list] = {}
    for entry in species.values():
        idn = entry.get("id_number")
        if not isinstance(idn, int) or idn not in ALLOWED_SET:
            continue
        evos = entry.get("evolutions") or []
        rows: list = []
        for ev in evos:
            if not isinstance(ev, list) or len(ev) < 2:
                continue
            # Pokemon Essentials stores prevolutions inline (4th
            # element is True for the reverse). Skip those.
            if len(ev) >= 4 and ev[3] is True:
                continue
            target_sym = ev[0]
            method = ev[1]
            param = ev[2] if len(ev) >= 3 else None
            target_num = sym_to_num.get(str(target_sym))
            if target_num is None or target_num not in ALLOWED_SET:
                continue
            rows.append([target_num, str(method), param])
        # Drop a non-item method when the same target also has an item method,
        # so item-gated (trade-style) evolutions actually require the item.
        item_targets = {r[0] for r in rows if r[1] in ITEM_METHODS}
        if item_targets:
            rows = [r for r in rows if r[1] in ITEM_METHODS or r[0] not in item_targets]
        if rows:
            out[str(idn)] = rows
    return out


def build_species_pool(evos: dict) -> dict:
    """Emit species-pool.json — the client-side replacement for the
    hardcoded pool constants (SUPPORTED_SPECIES_SET in creatures.js,
    SPAWNVABLE_SPECIES_A in spawns.js, etc.). Values for the default
    pool are exactly the current hardcoded ones, so gameplay is
    unchanged when the client reads this file.

    spawnable: curated SPAWNVABLE_SPECIES for the default pool; in gens
    mode (CC_SPECIES_GENS) derived: non-legendary, non-baby species that
    aren't the evolution target of a NON-BABY in-pool species — i.e.
    wild spawns are each family's first non-baby form (Snorlax spawns
    even when Munchlax is in the pack; babies are egg-only, evolved
    forms are candy-only)."""
    non_baby_targets = set()
    babies = set(CANDY_ROOT_BABIES)
    for src, rows in evos.items():
        if int(src) in babies:
            continue
        for row in rows:
            non_baby_targets.add(row[0])
    legendaries = sorted(LEGENDARY_SPECIES)
    if SPAWNABLE_SPECIES is not None:
        spawnable = sorted(SPAWNABLE_SPECIES)
    else:
        spawnable = [
            s for s in ALLOWED_SPECIES
            if s not in non_baby_targets
            and s not in LEGENDARY_SPECIES
            and s not in CANDY_ROOT_BABIES
        ]
    return {
        "species": list(ALLOWED_SPECIES),
        "legendaries": legendaries,
        "babies": sorted(CANDY_ROOT_BABIES),
        "spawnable": spawnable,
        "maxSpecies": MAX_SPECIES,
    }


def process_custom_head(head: int) -> tuple[list[str], dict[str, list[int]]]:
    """Crop each variant sheet for `head` to MAX_SPECIES rows, save to
    BundledData/sprites/<head>/custom/<head>[v].png, and alpha-scan
    every cell to record which (body, variant_index) pairs have art.

    Sheets stay sheet-shaped (one PNG per variant per head) so the
    bundle file count stays modest. The runtime fetches the sheet
    once per (head, variant), uses CSS background-position / canvas
    crop on demand for individual cells, and reads cells.json instead
    of alpha-scanning at startup.

    Returns (suffixes, cells_for_head) — same shape as before."""
    custom_src = CUSTOM_SHEETS_DIR / str(head)
    if not custom_src.is_dir():
        return [], {}

    sheets: list[tuple[str, Path]] = []
    for sheet_path in sorted(custom_src.iterdir()):
        m = CUSTOM_FILENAME_RE.match(sheet_path.name)
        if not m:
            continue
        if int(m.group(1)) != head:
            continue
        sheets.append((m.group(2), sheet_path))
    if not sheets:
        return [], {}
    # Canonical (length, lex) order so variant_index is stable.
    sheets.sort(key=lambda p: (len(p[0]), p[0]))

    suffixes = [s for s, _ in sheets]
    out_dir = OUT_DIR / "sprites" / str(head) / "custom"
    out_dir.mkdir(parents=True, exist_ok=True)
    cells_for_head: dict[str, list[int]] = {}

    for variant_index, (suffix, sheet_path) in enumerate(sheets):
        # Ship the sheet itself, cropped to first MAX_SPECIES partners.
        crop_sheet(sheet_path, out_dir / sheet_path.name, CUSTOM_HEIGHT_NEEDED)
        # Alpha-scan to populate cells.json.
        for body in alpha_scan_custom_sheet(sheet_path, CUSTOM_COLS, CUSTOM_HEIGHT_NEEDED):
            cells_for_head.setdefault(str(body), []).append(variant_index)

    for k in cells_for_head:
        cells_for_head[k].sort()
    return suffixes, cells_for_head


def build_sprites_and_manifest() -> tuple[dict, dict]:
    """Crop autogen + custom sprite sheets per head species into
    BundledData/sprites/<head>/{autogen,custom}/<head>[v].png. Each
    sheet contains the first MAX_SPECIES partners' worth of cells in
    a fixed grid (10×16 autogen, 20×8 custom). Runtime renders an
    individual cell via CSS / canvas crop against the sheet URL.

    Returns (manifest, cells):
      manifest = {"<head>": [variant_suffix, ...]}
      cells    = {"<body>-<head>": [variant_index, ...]} listing which
                 (body, head) fusions have non-blank custom art for
                 which variants — saves the runtime an alpha-scan."""
    manifest: dict[str, list[str]] = {}
    cells: dict[str, list[int]] = {}

    # Live progress on stdout — overwrites the same line via \r so
    # the user can tell the slow per-species loop is making forward
    # progress and hasn't wedged. Final newline printed after the
    # loop so the next "→" status line lands cleanly.
    is_tty = sys.stdout.isatty()
    total = len(ALLOWED_SPECIES)
    for done, head in enumerate(ALLOWED_SPECIES, start=1):
        if is_tty:
            print(
                f"\r  cropping sprite sheets: {done}/{total} "
                f"(head={head}, {done * 100 // total}%)",
                end="", flush=True,
            )
        # Autogen: composite the canonical sheet with fallback rows
        # (IF1's sheets stop at body 509; the gen-3 high PIF ids only
        # have autogen art in the IF2 tree). No per-cell decomposition.
        build_autogen_sheet(
            head, OUT_DIR / "sprites" / str(head) / "autogen" / f"{head}.png")

        # Custom variants: crop sheets, alpha-scan for cells.json.
        suffixes, cells_for_head = process_custom_head(head)
        if suffixes:
            manifest[str(head)] = suffixes
        for body_str, variant_indices in cells_for_head.items():
            cells[f"{body_str}-{head}"] = variant_indices
    if is_tty:
        # Erase the in-progress line so the summary lines below print
        # without the trailing percentage hanging around.
        print("\r" + " " * 60 + "\r", end="", flush=True)
    return manifest, cells


def build_eggs_sheet() -> tuple[int, int]:
    """Compose all egg PNGs (1..MAX_SPECIES) into a single sprite
    sheet at BundledData/eggs.png. Cells are EGG_PX × EGG_PX in an
    EGG_COLS-wide grid; missing eggs leave the cell transparent
    (only the base-evolution Pokémon have egg art upstream — the
    client can fall back to the head species' egg for evolutions).
    Also copies the standalone helper images (default egg, base
    overlay, cracking animation frame). Returns (cells_present,
    cells_missing)."""
    if not EGGS_DIR.is_dir():
        print(f"  ⚠ no Eggs directory at {EGGS_DIR}, skipping")
        return (0, len(ALLOWED_SPECIES))

    sheet = Image.new(
        "RGBA",
        (EGG_COLS * EGG_PX, EGG_ROWS_NEEDED * EGG_PX),
        (0, 0, 0, 0),
    )
    present = 0
    for species in ALLOWED_SPECIES:
        path = EGGS_DIR / f"{species}.png"
        if not path.is_file():
            continue
        with Image.open(path) as img:
            img = img.convert("RGBA")
            # 0-indexed cell layout: species N → cell N (cell 0 is
            # intentionally left empty so the client uses
            # `cellIndex = speciesId` directly).
            col = species % EGG_COLS
            row = species // EGG_COLS
            sheet.paste(img, (col * EGG_PX, row * EGG_PX), img)
        present += 1

    sheet_path = OUT_DIR / "eggs.png"
    sheet.save(sheet_path, optimize=True)

    # Standalone helpers — used as fallbacks (default egg when no
    # species art exists) and for the hatching animation frames.
    for src_name, dst_name in [
        ("000.png", "egg-default.png"),
        ("egg_base.png", "egg-base.png"),
        ("000_cracks.png", "egg-cracks.png"),
    ]:
        src = EGGS_DIR / src_name
        if src.is_file():
            shutil.copyfile(src, OUT_DIR / dst_name)
    return (present, len(ALLOWED_SPECIES) - present)


def build_specials() -> int:
    """Normalize solo-creature ("specials", e.g. Missingno) sprites from
    data/specials/*.png into BundledData/specials/<id>.png.

    Specials are non-fusion creatures — they live outside the (head,
    body) sheet/pack key space entirely and are served as plain
    full-PNG files (same trick as evo-items/). Sources may be
    palette-mode with transparency-index (Missingno is), so each is
    converted to RGBA and pasted CENTERED on a CELL_PX × CELL_PX
    transparent canvas (no upscaling — the same convention the egg
    fallback generator uses). Returns the count of sprites written."""
    src_dir = ROOT / "data" / "specials"
    if not src_dir.is_dir():
        print("  ⚠ no data/specials directory, skipping")
        return 0
    dst_dir = OUT_DIR / "specials"
    dst_dir.mkdir(parents=True, exist_ok=True)
    count = 0
    for src in sorted(src_dir.glob("*.png")):
        with Image.open(src) as img:
            img = img.convert("RGBA")
            canvas = Image.new("RGBA", (CELL_PX, CELL_PX), (0, 0, 0, 0))
            x = (CELL_PX - img.width) // 2
            y = (CELL_PX - img.height) // 2
            canvas.paste(img, (x, y), img)
        canvas.save(dst_dir / src.name, optimize=True)
        count += 1
    return count


def copy_evo_items(evos: dict) -> int:
    """Copy evolution-item PNGs (Fire Stone, Thunder Stone, Linking
    Cord, etc.) from PIF's Graphics/Items/ into BundledData/evo-items/.

    The set of items copied is derived from the evolutions data:
    every distinct `param` of an `Item` evolution method becomes a
    file name (PARAM.png). Plus a manifest (evo-items-list.json) so
    static hosts and the runtime "Download App Data" flow can
    enumerate without needing directory listings.

    Returns the count of items successfully copied.
    """
    items = set()
    for evo_list in evos.values():
        for evo in evo_list:
            if len(evo) >= 3 and evo[1] == "Item":
                items.add(evo[2])
    items_sorted = sorted(items)

    if not EVO_ITEMS_SRC.is_dir():
        print(f"  ⚠ no Items directory at {EVO_ITEMS_SRC}, skipping evo items")
        write_json(OUT_DIR / "evo-items-list.json", {"items": []})
        return 0

    dst = OUT_DIR / "evo-items"
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)

    copied: list[str] = []
    missing: list[str] = []
    for name in items_sorted:
        src_path = EVO_ITEMS_SRC / f"{name}.png"
        if not src_path.is_file():
            missing.append(name)
            continue
        shutil.copyfile(src_path, dst / f"{name}.png")
        copied.append(name)

    write_json(OUT_DIR / "evo-items-list.json", {"items": copied})

    if missing:
        print(f"  ⚠ {len(missing)} evo-item PNGs missing in source: {missing}")
    return len(copied)


def copy_app_data() -> tuple[int, int]:
    """Copy icons/ + fonts/ into BundledData/. Also writes two
    listing JSONs (icons-list.json + fonts-list.json) so static
    hosts (GitHub Pages, jsdelivr, etc.) — which can't enumerate
    directories — let the client know what's available.
    Returns (icon_count, font_glyph_count)."""
    icon_count = 0
    font_count = 0

    if ICONS_SRC.is_dir():
        dst = OUT_DIR / "icons"
        if dst.exists():
            shutil.rmtree(dst)
        # ignore=shutil.ignore_patterns(...) skips junk like .DS_Store
        # and editor backup files; keep only SVGs and obvious siblings.
        shutil.copytree(ICONS_SRC, dst,
                        ignore=shutil.ignore_patterns(".*", "*.bak", "*~"))
        svg_files = sorted(p.name for p in dst.glob("*.svg"))
        icon_count = len(svg_files)
        # Listing mirrors the /iconslist endpoint shape: {"files": [...]}.
        write_json(OUT_DIR / "icons-list.json", {"files": svg_files})
    else:
        print(f"  ⚠ no icons directory at {ICONS_SRC}, skipping")

    if FONTS_SRC.is_dir():
        dst = OUT_DIR / "fonts"
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(FONTS_SRC, dst,
                        ignore=shutil.ignore_patterns(".*", "*.bak", "*~"))
        # Per-stack listing keyed by stack name. Mirrors what
        # /fontslist/<stack> returns at runtime, just one combined
        # file (small, and the runtime usually only needs one stack).
        stacks: dict[str, list[str]] = {}
        for stack_dir in sorted(p for p in dst.iterdir() if p.is_dir()):
            files = sorted(p.name for p in stack_dir.glob("*.pbf"))
            stacks[stack_dir.name] = files
            font_count += len(files)
        write_json(OUT_DIR / "fonts-list.json", stacks)
    else:
        print(f"  ⚠ no fonts directory at {FONTS_SRC}, skipping")

    return (icon_count, font_count)


def bundle_regions_manifest() -> int:
    """Copy the static-region manifest into BundledData.

    Two possible sources, in preference order:
      1. regions/index.json — output of build-regions.py. Has the
         ACTUAL packed byte size per artifact + explicit region IDs +
         relative file paths. Preferred when present.
      2. regions-na.json — output of partition-regions.py (size
         estimates only, before files have been built). Used as a
         fallback so the manifest is available even before the full
         build runs.

    Normalized to a consistent client-facing shape so the page's
    RegionPicker doesn't have to handle both schemas:

        {
          "regions": [
            { "id": "region-0000",
              "bbox": [w, s, e, n],
              "sizes": { walk, poi, housenumbers, tiles } },
            ...
          ],
          "source": "build" | "plan",
          "n_regions": N
        }

    `source` tells the client whether sizes are actual or estimated.
    """
    build_src = ROOT / "regions" / "index.json"
    plan_src = ROOT / "regions-na.json"

    if build_src.exists():
        data = json.loads(build_src.read_text())
        entries = []
        for r in data.get("regions", []):
            entries.append({
                "id": r["id"],
                "bbox": r["bbox"],
                "sizes": r["sizes"],
            })
        source = "build"
    elif plan_src.exists():
        data = json.loads(plan_src.read_text())
        substantive = [
            r for r in data.get("regions", [])
            if r.get("leaf_reason") != "empty"
        ]
        entries = []
        for i, r in enumerate(substantive):
            entries.append({
                "id": f"region-{i:04d}",
                "bbox": r["bbox"],
                "sizes": r["sizes"],
            })
        source = "plan"
    else:
        print(f"  WARN: neither {build_src} nor {plan_src} exists — "
              f"skipping regions manifest")
        return 0

    out = {
        "regions": entries,
        "source": source,
        "n_regions": len(entries),
    }
    dst = OUT_DIR / "regions.json"
    dst.write_text(json.dumps(out))
    return 1


def bundle_base_map_tiles() -> int:
    """Extract zoom 0..BASE_MAP_MAX_ZOOM tiles from every .mbtiles in
    data/ and copy them into BundledData/tiles/<z>/<x>/<y>.pbf. These
    are the same tiles the runtime "Download App Data" button
    prefetches via the SW; bundling them drops that step.

    The tile_data column in mbtiles is gzipped on disk. Capacitor's
    WKURLSchemeHandler serves bundled files as raw bytes without
    setting `Content-Encoding: gzip`, so MapLibre would receive
    gzip bytes and fail to parse. We decompress at build time so the
    bundled .pbf is plain protobuf — works the same whether served
    by Flask (which now also returns raw, see run.py) or Capacitor.
    The size hit is ~3x larger on disk but tiles are small enough
    (~5–15 KB each) that the total stays manageable.

    Multiple .mbtiles files may overlap (per-region downloads). For
    each (z, x, y) we keep the LARGEST raw-data tile.
    Returns the number of tiles written."""
    mbtiles_paths = sorted(DATA_DIR.glob("*.mbtiles"))
    if not mbtiles_paths:
        print(f"  ⚠ no .mbtiles files in {DATA_DIR}, skipping base-map tiles")
        return 0

    import gzip as _gzip
    def _decompress(data: bytes) -> bytes:
        # mbtiles tiles can be gzip, raw protobuf, or other encodings.
        # Detect gzip by magic bytes (1f 8b) and decompress; otherwise
        # pass through unchanged.
        if len(data) >= 2 and data[0] == 0x1f and data[1] == 0x8b:
            try:
                return _gzip.decompress(data)
            except OSError:
                return data
        return data

    best: dict[tuple[int, int, int], bytes] = {}
    for path in mbtiles_paths:
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            cur = conn.execute(
                "SELECT zoom_level, tile_column, tile_row, tile_data "
                "FROM tiles WHERE zoom_level <= ?",
                (BASE_MAP_MAX_ZOOM,),
            )
            for z, x, y_tms, data in cur:
                y = (1 << z) - 1 - y_tms
                key = (z, x, y)
                raw = _decompress(bytes(data))
                if key not in best or len(raw) > len(best[key]):
                    best[key] = raw

    out_root = OUT_DIR / "tiles"
    for (z, x, y), data in best.items():
        dst = out_root / str(z) / str(x) / f"{y}.pbf"
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
    return len(best)


def write_json(path: Path, data, *, compact=True) -> None:
    """Write JSON to `path`. Compact for production payloads, indented
    when easier to eyeball during debugging."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if compact:
        path.write_text(
            json.dumps(data, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
    else:
        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


# ── Main ─────────────────────────────────────────────────────────────────
def main() -> None:
    if OUT_DIR.exists():
        print(f"→ Wiping existing {OUT_DIR}")
        shutil.rmtree(OUT_DIR)
    OUT_DIR.mkdir(parents=True)

    print("→ Parsing SplitNames.rb...")
    split_names = build_split_names()
    write_json(OUT_DIR / "split-names.json", split_names)
    print(f"  {len(split_names)} entries")

    print(f"→ Filtering credits to {len(ALLOWED_SPECIES)} allowed species' fusions...")
    credits = build_credits()
    write_json(OUT_DIR / "credits.json", credits)
    print(f"  {len(credits)} fusion cells with at least one credit")

    # All three derive from the same species.dat — load_species_dat()
    # is cached so the Ruby subprocess only runs once.
    print("→ Extracting names from species.dat...")
    names = build_species_names()
    write_json(OUT_DIR / "species-names.json", names)
    print(f"  {len(names)} names")

    print("→ Extracting types from species.dat...")
    types = build_species_types()
    write_json(OUT_DIR / "species-types.json", types)
    print(f"  {len(types)} type entries")

    print("→ Extracting evolutions from species.dat...")
    evos = build_species_evolutions()
    write_json(OUT_DIR / "species-evolutions.json", evos)
    print(f"  {len(evos)} evolution entries")

    print("→ Writing species pool manifest...")
    pool = build_species_pool(evos)
    write_json(OUT_DIR / "species-pool.json", pool)
    print(f"  {len(pool['species'])} species, {len(pool['legendaries'])} legendaries, "
          f"{len(pool['spawnable'])} spawnable")

    print("→ Pre-cropping sprite cells (this is the slow part)...")
    manifest, cells = build_sprites_and_manifest()
    write_json(OUT_DIR / "manifest.json", manifest)
    write_json(OUT_DIR / "cells.json", cells)
    print(f"  {len(manifest)} species have custom variants")
    print(f"  {len(cells)} (head, body) fusions have ≥1 custom variant")

    print("→ Composing eggs sprite sheet...")
    egg_present, egg_missing = build_eggs_sheet()
    print(f"  {egg_present} egg cells filled, {egg_missing} blank "
          "(species without dedicated egg art)")

    # Fill in remaining egg cells using the same waterfall the candy
    # generator applies (baby egg → baby autogen → family-root
    # propagation), so eggs.png ends up with full coverage for every
    # gen-1 species. Kept in its own module for fast iteration.
    print("→ Filling egg sprite-sheet fallbacks...")
    from generate_egg_images import fill_egg_fallbacks
    egg_present, egg_missing = fill_egg_fallbacks()
    print(f"  {egg_present} egg cells filled, {egg_missing} blank")

    # Candy sheet derives from eggs.png (just composed above) — kept
    # in its own module so the candy compositing can be iterated
    # quickly without re-running the slow sprite/egg/tile passes.
    # Run `python3 generate_candy_images.py` directly during tweaks.
    print("→ Composing candy sprite sheet from eggs.png...")
    from generate_candy_images import build_candies_sheet
    candy_present, candy_missing = build_candies_sheet()
    print(f"  {candy_present} candy cells filled, {candy_missing} blank")

    # Pre-cropped sprite packs — one binary file per partner that
    # bundles every (a, variant) cell as tight-bbox PNG bytes plus a
    # small index. The runtime first-launch step imports these
    # directly into IDB by byte-slicing, skipping the slow on-device
    # decode + canvas crop + toBlob path that the original
    # bulkDownload still uses for the web build. Lives in its own
    # module so it can be iterated standalone.
    print("→ Pre-cropping sprite cells into per-partner pack files...")
    from generate_sprite_packs import build_sprite_packs as _build_packs
    pack_count, pack_cells = _build_packs()
    print(f"  {pack_count} packs, {pack_cells} cells total")

    print("→ Copying evolution-item art...")
    evo_item_count = copy_evo_items(evos)
    print(f"  {evo_item_count} evolution items")

    print("→ Normalizing special (solo-creature) sprites...")
    specials_count = build_specials()
    print(f"  {specials_count} special sprites")

    print("→ Copying app data (icons + fonts)...")
    icon_count, font_count = copy_app_data()
    print(f"  {icon_count} POI icons, {font_count} font glyph PBFs")

    print("→ Bundling regions manifest...")
    region_count = bundle_regions_manifest()
    print(f"  {region_count} manifest file")

    print(f"→ Extracting base-map tiles (z0..z{BASE_MAP_MAX_ZOOM})...")
    tile_count = bundle_base_map_tiles()
    print(f"  {tile_count} tiles")

    # ── Summary ────────────────────────────────────────────────
    total_files = 0
    total_bytes = 0
    for p in OUT_DIR.rglob("*"):
        if p.is_file():
            total_files += 1
            total_bytes += p.stat().st_size
    print(f"\n✓ Wrote {total_files} files, "
          f"{total_bytes / (1024*1024):.1f} MB total → {OUT_DIR}")


if __name__ == "__main__":
    main()
