#!/usr/bin/env python3
"""Generate data/BundledData/candies.png from data/BundledData/eggs.png.

Each candy reuses the species-distinguishing top portion of its egg
as the candy body's pattern, tinted by the egg's dominant color.
Sheet indexing matches eggs.png (cell N at column N % cols, row
N // cols) so the runtime can use the same lookup math.

Split out of build-bundled-data.py so the candy compositing can be
iterated quickly — full build is multi-minute, this script runs in
a couple of seconds and only needs eggs.png to exist on disk.

Run:
    nix-shell  (to get python3 + pillow)
    python3 generate-candy-images.py
"""

import sys
from collections import Counter
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageDraw
except ImportError:
    print("error: pillow (PIL) not found. Add python3Packages.pillow to "
          "shell.nix and re-enter the shell.", file=sys.stderr)
    sys.exit(1)

# ── Constants — kept in sync with build-bundled-data.py ────────────────
MAX_SPECIES = 150
EGG_PX = 160
EGG_COLS = 10

# Quarter the egg cell resolution. Smaller source pixels = chunkier
# rendering when the consuming UI scales the candy up with
# `image-rendering: pixelated`. Output sheet is 400×640.
CANDY_PX = EGG_PX // 4
CANDY_COLS = EGG_COLS
CANDY_ROWS_NEEDED = (MAX_SPECIES // CANDY_COLS) + 1

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "data" / "BundledData"
EGGS_PATH = OUT_DIR / "eggs.png"
CANDIES_PATH = OUT_DIR / "candies.png"

# PIF source directory for per-species egg PNGs — used as a fallback
# when a gen-1 species' own egg cell is empty (PIF only ships egg art
# for base evolutions, so e.g. Pikachu has no 25.png because its base
# is Pichu (#172) in gen 2). For those, we crop the BABY's egg art
# instead so the candy bucket — which is keyed on the gen-1 species
# (Pikachu, not Pichu) — still has a recognizable visual identity.
PIF_EGGS_DIR = ROOT / "data" / "InfiniteFusion" / "Graphics" / "Battlers" / "Eggs"

# Map of gen-1 species ID → baby ID whose egg PNG to use when the
# gen-1 cell is empty. Keys mirror the candy buckets that
# CANDY_ROOT_BABIES (in creatures.js) promotes past — Pichu's bucket
# is Pikachu, Cleffa's is Clefairy, etc., so each maps the *bucket
# species* to the baby whose art best represents it.
#
# Tyrogue branches into both Hitmonlee and Hitmonchan, so both
# point at 236.
BABY_EGG_FALLBACK: dict[int, int] = {
    25:  172,   # Pikachu     ← Pichu
    35:  173,   # Clefairy    ← Cleffa
    39:  174,   # Jigglypuff  ← Igglybuff
    106: 236,   # Hitmonlee   ← Tyrogue
    107: 236,   # Hitmonchan  ← Tyrogue
    124: 238,   # Jynx        ← Smoochum
    125: 239,   # Electabuzz  ← Elekid
    126: 240,   # Magmar      ← Magby
}


def dominant_egg_color(img: "Image.Image") -> tuple[int, int, int]:
    """Most-common opaque non-near-white color in an image. Used to
    tint the candy wrapper to roughly match the species' egg
    coloring. Skips the cream/white base shared across PIF egg art
    so the result is the species-distinguishing color, not the
    constant base."""
    rgba = img.convert("RGBA")
    counter: Counter = Counter()
    for r, g, b, a in rgba.getdata():
        if a < 200:
            continue
        if r > 230 and g > 230 and b > 220:
            continue
        counter[(r, g, b)] += 1
    if not counter:
        return (200, 120, 200)  # fallback purple if egg is all white/empty
    return counter.most_common(1)[0][0]


def make_candy(size: int, egg_top: "Image.Image",
               twist_color: tuple[int, int, int]) -> "Image.Image":
    """Compose a single candy cell — a tinted sphere with a 1 px
    black outline and the cropped egg pattern showing through.

    Drawn at native resolution (no supersample) so the edges stay
    sharp and pixelated, matching the chunky aesthetic of the
    underlying egg/sprite art."""
    candy = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(candy)

    # Sphere geometry — diameter ~80% of the cell so the outline
    # has breathing room from the cell boundary.
    cx = size // 2
    cy = size // 2
    diameter = int(size * 0.80)
    radius = diameter // 2
    body_l = cx - radius
    body_t = cy - radius
    body_r = cx + radius
    body_b = cy + radius

    # Tinted sphere with 2 px outline.
    draw.ellipse(
        (body_l, body_t, body_r, body_b),
        fill=(*twist_color, 255),
        outline=(0, 0, 0, 255),
        width=2,
    )

    # Inset so the egg paste sits comfortably inside the outline.
    inset = 2
    inner_d = max(1, diameter - inset * 2)
    # NEAREST so the resize preserves the egg art's chunky source
    # pixels instead of blurring them under a smooth interpolator.
    egg_resized = egg_top.resize((inner_d, inner_d), Image.NEAREST)

    # Circular mask at native resolution.
    circle_mask = Image.new("L", (inner_d, inner_d), 0)
    ImageDraw.Draw(circle_mask).ellipse(
        (0, 0, inner_d - 1, inner_d - 1), fill=255)

    # Multiply by the egg's own alpha so transparent padding around
    # the egg pattern doesn't paste through the sphere's rim.
    egg_alpha = egg_resized.split()[3]
    combined_mask = ImageChops.multiply(circle_mask, egg_alpha)

    candy.paste(egg_resized, (body_l + inset, body_t + inset), combined_mask)

    return candy


def build_candies_sheet() -> tuple[int, int]:
    """Read eggs.png, generate candy cells, write candies.png.
    Returns (filled, missing) cell counts."""
    if not EGGS_PATH.is_file():
        print(f"error: eggs.png not found at {EGGS_PATH}. Run "
              "build-bundled-data.py first to compose the egg sheet.",
              file=sys.stderr)
        return (0, MAX_SPECIES)

    eggs_sheet = Image.open(EGGS_PATH).convert("RGBA")

    out = Image.new(
        "RGBA",
        (CANDY_COLS * CANDY_PX, CANDY_ROWS_NEEDED * CANDY_PX),
        (0, 0, 0, 0),
    )

    filled = 0
    for species in range(1, MAX_SPECIES + 1):
        ecol = species % EGG_COLS
        erow = species // EGG_COLS
        egg_cell = eggs_sheet.crop((
            ecol * EGG_PX,
            erow * EGG_PX,
            (ecol + 1) * EGG_PX,
            (erow + 1) * EGG_PX,
        ))
        bbox = egg_cell.getbbox()
        if not bbox:
            # PIF only ships egg art for base evolutions, so gen-1
            # species whose base is a gen-2 baby (Pichu→Pikachu,
            # Cleffa→Clefairy, ...) come through empty. For those we
            # load the baby's egg PNG directly from PIF source — the
            # candy bucket is still keyed on the gen-1 species (which
            # is what the user sees as "Pikachu candy"), but its
            # visual identity comes from the baby's egg art.
            baby = BABY_EGG_FALLBACK.get(species)
            if baby is None:
                continue
            baby_path = PIF_EGGS_DIR / f"{baby}.png"
            if not baby_path.is_file():
                continue
            egg_cell = Image.open(baby_path).convert("RGBA")
            bbox = egg_cell.getbbox()
            if not bbox:
                continue
        # Shrink the bbox inward before cropping — drops the egg's
        # dark outline pixels (1-2 px wide in PIF art) plus a wider
        # band of edge color/shading, leaving just the inner
        # pattern. With the egg silhouette gone the pasted pattern
        # blends cleanly into the wrapper's tinted body instead of
        # reading as an egg-shape inside a candy-shape.
        OUTLINE_TRIM = 12
        bx0, by0, bx1, by1 = bbox
        bw = bx1 - bx0
        bh = by1 - by0
        if bw > OUTLINE_TRIM * 3 and bh > OUTLINE_TRIM * 3:
            bbox = (
                bx0 + OUTLINE_TRIM,
                by0 + OUTLINE_TRIM,
                bx1 - OUTLINE_TRIM,
                by1 - OUTLINE_TRIM,
            )
        egg_cell = egg_cell.crop(bbox)

        # Top ~58% — the colored species-distinguishing portion,
        # above the cream/white base most PIF eggs share.
        top_h = max(8, int(egg_cell.height * 0.58))
        egg_top = egg_cell.crop((0, 0, egg_cell.width, top_h))

        twist_color = dominant_egg_color(egg_top)
        candy = make_candy(CANDY_PX, egg_top, twist_color)

        ccol = species % CANDY_COLS
        crow = species // CANDY_COLS
        out.paste(candy, (ccol * CANDY_PX, crow * CANDY_PX), candy)
        filled += 1

    out.save(CANDIES_PATH, optimize=True)
    return (filled, MAX_SPECIES - filled)


def main() -> None:
    print(f"→ Composing candies sprite sheet from {EGGS_PATH.name}...")
    filled, missing = build_candies_sheet()
    if filled == 0 and missing == MAX_SPECIES:
        sys.exit(1)
    print(f"  {filled} candy cells filled, {missing} blank "
          f"→ {CANDIES_PATH}")


if __name__ == "__main__":
    main()
