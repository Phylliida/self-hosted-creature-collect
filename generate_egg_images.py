#!/usr/bin/env python3
"""Fill in missing cells in data/BundledData/eggs.png using the
same waterfall of fallbacks generate_candy_images.py applies to
the candy sheet:

  1. Own egg art (already pasted by build_eggs_sheet from PIF source)
  2. Baby's egg PNG (Pichu→Pikachu, Cleffa→Clefairy, Happiny→Chansey,
     Munchlax→Snorlax — the BABY_EGG_FALLBACK map)
  3. Baby's autogen solo sprite (Munchlax 446 + Mime Jr. 439 don't
     have egg PNGs in PIF, but their autogen sheets exist)

Then a family-root propagation pass: every species' cell is
overwritten with the cell of its family root (so Ivysaur and Venusaur
both display Bulbasaur's egg, all 8 Eevee evolutions share Eevee's,
etc.). Same logic generate_candy_images.py uses internally.

Run order in build-bundled-data.py:
    build_eggs_sheet()           # PIF base art → 67 cells filled
    fill_egg_fallbacks()         # this script  → 150 cells filled
    build_candies_sheet()        # reads completed eggs.png

Idempotent — running this script repeatedly produces the same output
since each tier prefers the cell already in the sheet.

Run:
    python3 generate_egg_images.py
"""

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("error: pillow (PIL) not found. Add python3Packages.pillow to "
          "shell.nix and re-enter the shell.", file=sys.stderr)
    sys.exit(1)

# Reuse the helpers + maps from the candy generator. They were
# written for the candy waterfall but apply identically here — same
# tiers, same baby mapping, same family-root logic — so importing
# avoids drift between the two scripts.
from generate_candy_images import (
    BABY_EGG_FALLBACK,
    PIF_EGGS_DIR,
    AUTOGEN_CELL_PX,
    _autogen_solo_sprite,
    _load_family_roots,
)

# Constants — kept in sync with build-bundled-data.py.
MAX_SPECIES = 150
EGG_PX = 160
EGG_COLS = 10

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "data" / "BundledData"
EGGS_PATH = OUT_DIR / "eggs.png"
EGGS_LOOT_PATH = OUT_DIR / "eggs_loot.png"

# Display sheet for the daycare loot pill — eggs.png cells have
# 75%-transparent padding around the actual art, and per-species
# bbox heights vary (PIF egg ~60px, Munchlax-autogen-paste 96px),
# so scaling eggs.png with a single CSS background-size can't give
# uniform on-pill display heights. This sister sheet bbox-crops
# every cell + aspect-preserving-scales it into a uniform 40×40
# cell — same dimensions as candies.png — so eggs and candies share
# identical pill-rendering math.
EGGS_LOOT_PX = 40
EGGS_LOOT_PADDING = 1  # transparent margin inside each loot cell


def _own_cell(eggs_sheet: "Image.Image", species: int) -> "Image.Image | None":
    """Crop species' cell from the existing sheet; None if blank."""
    col = species % EGG_COLS
    row = species // EGG_COLS
    cell = eggs_sheet.crop((
        col * EGG_PX, row * EGG_PX,
        (col + 1) * EGG_PX, (row + 1) * EGG_PX,
    ))
    return cell if cell.getbbox() is not None else None


def _baby_egg_cell(baby_id: int) -> "Image.Image | None":
    """Load PIF's <baby>.png as a 160×160 cell. PIF baby eggs are
    already that size, so this is just a load + alpha-check."""
    baby_path = PIF_EGGS_DIR / f"{baby_id}.png"
    if not baby_path.is_file():
        return None
    img = Image.open(baby_path).convert("RGBA")
    if img.getbbox() is None:
        return None
    if img.size == (EGG_PX, EGG_PX):
        return img
    # Defensive — center on a 160×160 canvas if upstream ever ships
    # a non-standard size.
    canvas = Image.new("RGBA", (EGG_PX, EGG_PX), (0, 0, 0, 0))
    w, h = img.size
    canvas.paste(img, ((EGG_PX - w) // 2, (EGG_PX - h) // 2), img)
    return canvas


def _baby_autogen_cell(baby_id: int) -> "Image.Image | None":
    """Pull the baby's solo autogen sprite (96×96) and center it on
    a 160×160 canvas so the result drops cleanly into eggs.png. The
    centered-not-scaled paste keeps the autogen art at native
    resolution; downstream display (egg list cells, candy crop)
    handles further scaling. Used for Munchlax/Mime Jr. — gen-4 baby
    species PIF didn't ship dedicated egg PNGs for."""
    solo = _autogen_solo_sprite(baby_id)
    if solo is None:
        return None
    canvas = Image.new("RGBA", (EGG_PX, EGG_PX), (0, 0, 0, 0))
    sx = (EGG_PX - AUTOGEN_CELL_PX) // 2
    sy = (EGG_PX - AUTOGEN_CELL_PX) // 2
    canvas.paste(solo, (sx, sy), solo)
    return canvas


def _fetch_egg(species: int, eggs_sheet: "Image.Image") -> "Image.Image | None":
    """Walk the three-tier waterfall for one species. Returns a
    160×160 cell suitable for pasting into the output sheet, or
    None if every tier fails."""
    own = _own_cell(eggs_sheet, species)
    if own is not None:
        return own
    baby = BABY_EGG_FALLBACK.get(species)
    if baby is not None:
        cell = _baby_egg_cell(baby)
        if cell is not None:
            return cell
        cell = _baby_autogen_cell(baby)
        if cell is not None:
            return cell
    return None


def fill_egg_fallbacks() -> tuple[int, int]:
    """Read eggs.png, apply waterfall + family propagation, write
    eggs.png back. Returns (filled, blank) cell counts."""
    if not EGGS_PATH.is_file():
        print(f"error: eggs.png not found at {EGGS_PATH}. Run "
              "build-bundled-data.py first to compose the egg sheet.",
              file=sys.stderr)
        return (0, MAX_SPECIES)

    eggs_sheet = Image.open(EGGS_PATH).convert("RGBA")
    family_roots = _load_family_roots()

    # Stage 1: pick the egg art for every distinct family root.
    # Cache by root id so e.g. Eevee's eight evolutions all reuse
    # one Eevee egg.
    root_eggs: dict[int, "Image.Image"] = {}
    for species in range(1, MAX_SPECIES + 1):
        root = family_roots.get(species, species)
        if root in root_eggs:
            continue
        cell = _fetch_egg(root, eggs_sheet)
        if cell is not None:
            root_eggs[root] = cell

    # Stage 2: paste the appropriate root's egg into every member
    # of its family. Empty cells are species whose root has no
    # source art at any tier (rare with the current data).
    out = Image.new("RGBA", eggs_sheet.size, (0, 0, 0, 0))
    filled = 0
    for species in range(1, MAX_SPECIES + 1):
        root = family_roots.get(species, species)
        cell = root_eggs.get(root)
        if cell is None:
            continue
        col = species % EGG_COLS
        row = species // EGG_COLS
        out.paste(cell, (col * EGG_PX, row * EGG_PX), cell)
        filled += 1

    out.save(EGGS_PATH, optimize=True)
    return (filled, MAX_SPECIES - filled)


def build_eggs_loot_sheet() -> tuple[int, int]:
    """Bbox-crop each cell of eggs.png and aspect-preserving-scale
    it into a uniform EGGS_LOOT_PX cell. The result mirrors
    candies.png cell-for-cell, so the daycare loot pill can render
    eggs and candies through identical CSS — every species' egg
    displays at the same on-pill height as a candy, regardless of
    how much transparent padding the original cell had or whether
    the source was a PIF egg PNG or a Munchlax-autogen-paste.

    Aspect-preserving fit keeps tall sources (Munchlax silhouette
    ~96×96) from squashing horizontally; they shrink uniformly to
    fit within EGGS_LOOT_PX − 2 × EGGS_LOOT_PADDING. NEAREST
    resample preserves chunky source pixels, matching the
    pixelated rendering aesthetic.

    Returns (filled, blank) cell counts."""
    if not EGGS_PATH.is_file():
        print(f"error: eggs.png not found at {EGGS_PATH}.", file=sys.stderr)
        return (0, MAX_SPECIES)

    eggs_sheet = Image.open(EGGS_PATH).convert("RGBA")
    cols = EGG_COLS
    rows_needed = (MAX_SPECIES // cols) + 1
    out = Image.new(
        "RGBA",
        (cols * EGGS_LOOT_PX, rows_needed * EGGS_LOOT_PX),
        (0, 0, 0, 0),
    )

    target_inner = EGGS_LOOT_PX - 2 * EGGS_LOOT_PADDING
    filled = 0
    for species in range(1, MAX_SPECIES + 1):
        col = species % cols
        row = species // cols
        cell = eggs_sheet.crop((
            col * EGG_PX, row * EGG_PX,
            (col + 1) * EGG_PX, (row + 1) * EGG_PX,
        ))
        bbox = cell.getbbox()
        if bbox is None:
            continue
        cropped = cell.crop(bbox)
        cw, ch = cropped.size
        scale = min(target_inner / cw, target_inner / ch)
        nw = max(1, int(round(cw * scale)))
        nh = max(1, int(round(ch * scale)))
        scaled = cropped.resize((nw, nh), Image.NEAREST)
        ox = col * EGGS_LOOT_PX + (EGGS_LOOT_PX - nw) // 2
        oy = row * EGGS_LOOT_PX + (EGGS_LOOT_PX - nh) // 2
        out.paste(scaled, (ox, oy), scaled)
        filled += 1

    out.save(EGGS_LOOT_PATH, optimize=True)
    return (filled, MAX_SPECIES - filled)


def main() -> None:
    print(f"→ Filling fallbacks in {EGGS_PATH.name}...")
    filled, blank = fill_egg_fallbacks()
    if filled == 0 and blank == MAX_SPECIES:
        sys.exit(1)
    print(f"  {filled} egg cells filled, {blank} blank → {EGGS_PATH}")
    print(f"→ Building uniform-size loot sheet {EGGS_LOOT_PATH.name}...")
    lf, lb = build_eggs_loot_sheet()
    print(f"  {lf} egg loot cells filled, {lb} blank → {EGGS_LOOT_PATH}")


if __name__ == "__main__":
    main()
