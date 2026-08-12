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
    IF2_EGGS_DIR,
    AUTOGEN_CELL_PX,
    _autogen_solo_sprite,
    _load_family_roots,
)

# Shared species pool.
from species_pool import ALLOWED_SPECIES, ALLOWED_SET, MAX_SPECIES, env_path  # noqa: E402

EGG_PX = 160
EGG_COLS = 10

ROOT = Path(__file__).resolve().parent
OUT_DIR = env_path("CC_BUNDLED_OUT", ROOT / "data" / "BundledData")
EGGS_PATH = OUT_DIR / "eggs.png"


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
    already that size, so this is just a load + alpha-check. Falls
    back to the IF2 tree when IF1 never shipped the egg (high gen-3
    PIF ids)."""
    baby_path = PIF_EGGS_DIR / f"{baby_id}.png"
    if not baby_path.is_file():
        baby_path = IF2_EGGS_DIR / f"{baby_id}.png"
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
    """Walk the waterfall for one species. Returns a 160×160 cell
    suitable for pasting into the output sheet, or None if every tier
    fails."""
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
    # Final tier: the species' own autogen solo sprite. Covers species
    # with no egg art in either tree (most high gen-3 PIF ids) — the
    # IF2 autogen sheets carry their solo art.
    return _baby_autogen_cell(species)


def fill_egg_fallbacks() -> tuple[int, int]:
    """Read eggs.png, apply waterfall + family propagation, write
    eggs.png back. Returns (filled, blank) cell counts."""
    if not EGGS_PATH.is_file():
        print(f"error: eggs.png not found at {EGGS_PATH}. Run "
              "build-bundled-data.py first to compose the egg sheet.",
              file=sys.stderr)
        return (0, len(ALLOWED_SPECIES))

    eggs_sheet = Image.open(EGGS_PATH).convert("RGBA")
    family_roots = _load_family_roots()

    # Stage 1: pick the egg art for every distinct family root.
    # Cache by root id so e.g. Eevee's eight evolutions all reuse
    # one Eevee egg.
    root_eggs: dict[int, "Image.Image"] = {}
    for species in ALLOWED_SPECIES:
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
    for species in ALLOWED_SPECIES:
        root = family_roots.get(species, species)
        cell = root_eggs.get(root)
        if cell is None:
            continue
        col = species % EGG_COLS
        row = species // EGG_COLS
        out.paste(cell, (col * EGG_PX, row * EGG_PX), cell)
        filled += 1

    out.save(EGGS_PATH, optimize=True)
    return (filled, len(ALLOWED_SPECIES) - filled)


def main() -> None:
    print(f"→ Filling fallbacks in {EGGS_PATH.name}...")
    filled, blank = fill_egg_fallbacks()
    if filled == 0 and blank == len(ALLOWED_SPECIES):
        sys.exit(1)
    print(f"  {filled} egg cells filled, {blank} blank → {EGGS_PATH}")


if __name__ == "__main__":
    main()
