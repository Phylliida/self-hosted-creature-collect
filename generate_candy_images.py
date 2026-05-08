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

import json
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
EVOLUTIONS_PATH = OUT_DIR / "species-evolutions.json"


def _load_family_roots() -> dict[int, int]:
    """Return {species_id: family_root_id} for species 1..MAX_SPECIES.

    Mirrors the JS `familyOf` walk: for each species, follow
    pre-evolutions (reverse of species-evolutions.json) back to the
    earliest ancestor reachable in our 1..150 dataset. Babies > 150
    aren't ingested as sources so the walk terminates at the gen-1
    root naturally — same outcome candyRootFor produces in
    creatures.js for our truncated-to-gen-1 data.

    Used to paste root candies into non-root family-member cells so
    e.g. Ivysaur's and Venusaur's cells both show Bulbasaur's candy
    art."""
    if not EVOLUTIONS_PATH.is_file():
        return {s: s for s in range(1, MAX_SPECIES + 1)}
    with open(EVOLUTIONS_PATH) as f:
        evos = json.load(f)
    rev: dict[int, list[int]] = {}
    for src_str, evolutions in evos.items():
        src = int(src_str)
        for evo in evolutions:
            if len(evo) < 1:
                continue
            target = int(evo[0])
            rev.setdefault(target, []).append(src)
    roots: dict[int, int] = {}
    for s in range(1, MAX_SPECIES + 1):
        cur = s
        seen = {cur}
        while True:
            pre = rev.get(cur)
            if not pre:
                break
            prev = pre[0]
            if prev in seen:
                break
            seen.add(prev)
            cur = prev
        roots[s] = cur
    return roots

# PIF source directory for per-species egg PNGs — used as a fallback
# when a gen-1 species' own egg cell is empty (PIF only ships egg art
# for base evolutions, so e.g. Pikachu has no 25.png because its base
# is Pichu (#172) in gen 2). For those, we crop the BABY's egg art
# instead so the candy bucket — which is keyed on the gen-1 species
# (Pikachu, not Pichu) — still has a recognizable visual identity.
PIF_EGGS_DIR = ROOT / "data" / "InfiniteFusion" / "Graphics" / "Battlers" / "Eggs"

# PIF autogen sprite sheets — used as a FINAL fallback for species
# that have no own egg art AND no baby egg art (Snorlax, Mr. Mime —
# their gen-4 babies aren't bundled in PIF's Eggs/ directory). The
# species' solo sprite lives at cell (id%10, id//10) of the
# <id>.png sheet (a sprite at that diagonal position is the species
# fusing with itself, which is just the canonical solo art).
PIF_AUTOGEN_SHEETS_DIR = (ROOT / "data" / "InfiniteFusion" / "Graphics"
                          / "Battlers" / "spritesheets_autogen")
AUTOGEN_CELL_PX = 96
AUTOGEN_COLS = 10

# Map of gen-1 species ID → baby ID whose egg PNG to use when the
# gen-1 cell is empty. Keys mirror the candy buckets that
# CANDY_ROOT_BABIES (in creatures.js) promotes past — Pichu's bucket
# is Pikachu, Cleffa's is Clefairy, etc., so each maps the *bucket
# species* to the baby whose art best represents it.
#
# Tyrogue branches into both Hitmonlee and Hitmonchan, so both
# point at 236.
# Baby art is preferred even when the baby itself has no egg PNG —
# Munchlax (446) and Mime Jr. (439) aren't in PIF's Eggs/ dir but
# they do appear in the autogen sprite sheets, so we fall back to
# their solo autogen sprite when no baby egg is found.
BABY_EGG_FALLBACK: dict[int, int] = {
    25:  172,   # Pikachu     ← Pichu
    35:  173,   # Clefairy    ← Cleffa
    39:  174,   # Jigglypuff  ← Igglybuff
    106: 236,   # Hitmonlee   ← Tyrogue
    107: 236,   # Hitmonchan  ← Tyrogue
    113: 440,   # Chansey     ← Happiny
    122: 439,   # Mr. Mime    ← Mime Jr.
    124: 238,   # Jynx        ← Smoochum
    125: 239,   # Electabuzz  ← Elekid
    126: 240,   # Magmar      ← Magby
    143: 446,   # Snorlax     ← Munchlax
}


def _autogen_solo_sprite(species_id: int) -> "Image.Image | None":
    """Crop the species' solo sprite from PIF's autogen sheet —
    cell (id%10, id//10) of <id>.png is the species fused with
    itself = its canonical solo art. Final fallback for species
    that have no own egg art and no usable baby egg (Snorlax,
    Mr. Mime). Returns None if the sheet is missing or the
    diagonal cell is empty."""
    sheet_path = PIF_AUTOGEN_SHEETS_DIR / f"{species_id}.png"
    if not sheet_path.is_file():
        return None
    sheet = Image.open(sheet_path).convert("RGBA")
    col = species_id % AUTOGEN_COLS
    row = species_id // AUTOGEN_COLS
    cell = sheet.crop((
        col * AUTOGEN_CELL_PX,
        row * AUTOGEN_CELL_PX,
        (col + 1) * AUTOGEN_CELL_PX,
        (row + 1) * AUTOGEN_CELL_PX,
    ))
    return cell if cell.getbbox() else None


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

    # Tinted sphere with a soft dark-gray outline. Pure black reads
    # as harsh against the muted egg-art palette; ~70/70/70 keeps
    # the silhouette legible without competing visually with the
    # tinted body.
    draw.ellipse(
        (body_l, body_t, body_r, body_b),
        fill=(*twist_color, 255),
        outline=(70, 70, 70, 255),
        width=1,
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


def _generate_root_candy(species: int,
                          eggs_sheet: "Image.Image") -> "Image.Image | None":
    """Generate a single candy cell for `species`, walking the
    egg-art / baby-egg / baby-autogen fallback chain. Returns None
    if no source art is available at any tier."""
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
        # species whose base is a gen-2+ baby (Pichu→Pikachu,
        # Cleffa→Clefairy, Happiny→Chansey, Munchlax→Snorlax,
        # MimeJr→Mr.Mime, ...) come through empty. Walk a
        # waterfall of fallbacks until one provides art.
        #
        # Tier 1: baby's egg PNG. Pichu, Cleffa, Happiny etc.
        # have egg art in PIF — preferred since it matches the
        # visual style of the rest of the candy sheet.
        baby = BABY_EGG_FALLBACK.get(species)
        if baby is not None:
            baby_path = PIF_EGGS_DIR / f"{baby}.png"
            if baby_path.is_file():
                egg_cell = Image.open(baby_path).convert("RGBA")
                bbox = egg_cell.getbbox()
        # Tier 2: baby's autogen solo sprite. Munchlax (446) and
        # Mime Jr. (439) don't have egg PNGs in PIF but do have
        # autogen sheets, so we use the baby's solo silhouette
        # rather than falling back to the parent.
        if not bbox and baby is not None:
            solo = _autogen_solo_sprite(baby)
            if solo is not None:
                egg_cell = solo
                bbox = egg_cell.getbbox()
        if not bbox:
            return None
    # Shrink the bbox inward — drops the egg's dark outline pixels
    # plus a wider band of edge color, leaving just the inner
    # pattern. The pasted pattern then blends cleanly into the
    # wrapper's tinted body without an egg-shape silhouette.
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

    # Top ~58% — the colored species-distinguishing portion, above
    # the cream/white base most PIF eggs share.
    top_h = max(8, int(egg_cell.height * 0.58))
    egg_top = egg_cell.crop((0, 0, egg_cell.width, top_h))

    twist_color = dominant_egg_color(egg_top)
    return make_candy(CANDY_PX, egg_top, twist_color)


def build_candies_sheet() -> tuple[int, int]:
    """Read eggs.png, generate candy cells for every gen-1 species,
    and write candies.png. Each species' cell shows the candy art
    for its FAMILY ROOT — so e.g. Ivysaur and Venusaur both display
    Bulbasaur's candy. This matches how candy is bucketed at runtime
    (every member of a family contributes to / spends from the
    root's bucket).

    Returns (filled, missing) cell counts."""
    if not EGGS_PATH.is_file():
        print(f"error: eggs.png not found at {EGGS_PATH}. Run "
              "build-bundled-data.py first to compose the egg sheet.",
              file=sys.stderr)
        return (0, MAX_SPECIES)

    eggs_sheet = Image.open(EGGS_PATH).convert("RGBA")
    family_roots = _load_family_roots()

    out = Image.new(
        "RGBA",
        (CANDY_COLS * CANDY_PX, CANDY_ROWS_NEEDED * CANDY_PX),
        (0, 0, 0, 0),
    )

    # Stage 1: generate the candy cell for every distinct family
    # root. Cache by root id so we only do the work once per family
    # even when several members share a root (Eevee → 8 evolutions
    # all reuse the Eevee candy).
    root_candies: dict[int, "Image.Image"] = {}
    for species in range(1, MAX_SPECIES + 1):
        root = family_roots.get(species, species)
        if root in root_candies:
            continue
        candy = _generate_root_candy(root, eggs_sheet)
        if candy is not None:
            root_candies[root] = candy

    # Stage 2: paste the appropriate root's candy into every
    # member of its family — the root's own cell AND each
    # evolution's cell. Empty cells are species whose root has
    # no source art at any fallback tier (rare; visible in the
    # output sheet so we can spot what still needs fixing).
    filled = 0
    for species in range(1, MAX_SPECIES + 1):
        root = family_roots.get(species, species)
        candy = root_candies.get(root)
        if candy is None:
            continue
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
