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

# Shared species pool.
from species_pool import ALLOWED_SPECIES, ALLOWED_SET, MAX_SPECIES, env_path  # noqa: E402

EGG_PX = 160
EGG_COLS = 10

# Quarter the egg cell resolution. Smaller source pixels = chunkier
# rendering when the consuming UI scales the candy up with
# `image-rendering: pixelated`. Output sheet is 400×640.
CANDY_PX = EGG_PX // 4
CANDY_COLS = EGG_COLS
CANDY_ROWS_NEEDED = (MAX_SPECIES // CANDY_COLS) + 1

ROOT = Path(__file__).resolve().parent
OUT_DIR = env_path("CC_BUNDLED_OUT", ROOT / "data" / "BundledData")
EGGS_PATH = OUT_DIR / "eggs.png"
CANDIES_PATH = OUT_DIR / "candies.png"
EVOLUTIONS_PATH = OUT_DIR / "species-evolutions.json"


def _load_family_roots() -> dict[int, int]:
    """Return {species_id: family_root_id} for every species in
    ALLOWED_SPECIES.

    Mirrors the JS `familyOf` walk: for each species, follow
    pre-evolutions (reverse of species-evolutions.json) back to the
    earliest ancestor reachable in our allowed dataset. Babies outside
    ALLOWED aren't ingested as sources so the walk terminates at the
    base form naturally — same outcome candyRootFor produces in
    creatures.js.

    Used to paste root candies into non-root family-member cells so
    e.g. Ivysaur's and Venusaur's cells both show Bulbasaur's candy
    art."""
    if not EVOLUTIONS_PATH.is_file():
        return {s: s for s in ALLOWED_SPECIES}
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
    for s in ALLOWED_SPECIES:
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
PIF_ROOT = env_path("CC_INFINITEFUSION", ROOT / "data" / "InfiniteFusion")
PIF_EGGS_DIR = PIF_ROOT / "Graphics" / "Battlers" / "Eggs"

# PIF autogen sprite sheets — used as a FINAL fallback for species
# that have no own egg art AND no baby egg art (Snorlax, Mr. Mime —
# their gen-4 babies aren't bundled in PIF's Eggs/ directory). The
# species' solo sprite lives at cell (id%10, id//10) of the
# <id>.png sheet (a sprite at that diagonal position is the species
# fusing with itself, which is just the canonical solo art).
PIF_AUTOGEN_SHEETS_DIR = (PIF_ROOT / "Graphics"
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


def _find_pattern_height(img: "Image.Image",
                         cream_threshold: float = 0.5) -> int:
    """How many rows from the top count as pattern (i.e. NOT the
    cream-white egg base). Scans bottom-upward and returns the y
    just past the first row whose non-cream ratio crosses the
    threshold — that's where the colored pattern ends and the
    cream base begins.

    For images with no cream base (autogen-paste fallbacks like
    Munchlax / Mime Jr., where the whole image is silhouette), the
    scan never crosses the threshold and we return the full image
    height — every row is pattern.

    A row is "cream" when ≥ cream_threshold of its OPAQUE pixels
    are near-white (RGB ≥ 230, with a touch of slack on B for the
    slight warmth in the PIF cream tone). Transparent pixels are
    ignored so a row with sparse pattern dots over transparent
    padding still counts toward the pattern."""
    rgba = img.convert("RGBA")
    w, h = rgba.size
    if w == 0 or h == 0:
        return h
    pixels = list(rgba.getdata())
    for y in range(h - 1, -1, -1):
        row_start = y * w
        opaque = 0
        white = 0
        for i in range(w):
            r, g, b, a = pixels[row_start + i]
            if a < 128:
                continue
            opaque += 1
            if r > 230 and g > 230 and b > 220:
                white += 1
        if opaque == 0:
            continue
        if white / opaque < cream_threshold:
            # First row from the bottom that's mostly NOT cream —
            # pattern ends here (inclusive).
            return y + 1
    # Whole image is cream (extremely unusual). Fall back to full
    # height rather than collapse the crop to nothing.
    return h


def _extend_pattern_to_square(pattern: "Image.Image",
                              target_size: int) -> "Image.Image":
    """Aspect-preserving fit + mirror-reflection extension of a
    pattern into a target_size × target_size canvas.

    The pattern is scaled so its longest side fits target_size
    (no horizontal-vs-vertical squashing), then the gaps along the
    shorter side are filled by reflecting the pattern at its
    edges. Mirror reflection is the classic seamless-extension
    technique: pixels match across the boundary because the
    reflected copy's edge IS the original's edge, so the extended
    texture looks continuous instead of cut off or tiled with
    visible seams. Repeats the reflection if the gap is larger
    than the pattern itself, so very-thin source patterns still
    fill the full canvas without empty space."""
    pw, ph = pattern.size
    if pw == 0 or ph == 0:
        return Image.new("RGBA", (target_size, target_size), (0, 0, 0, 0))

    scale = target_size / max(pw, ph)
    new_w = max(1, int(round(pw * scale)))
    new_h = max(1, int(round(ph * scale)))
    scaled = pattern.resize((new_w, new_h), Image.NEAREST)

    canvas = Image.new("RGBA", (target_size, target_size), (0, 0, 0, 0))
    ox = (target_size - new_w) // 2
    oy = (target_size - new_h) // 2
    canvas.paste(scaled, (ox, oy), scaled)

    flipped_v = scaled.transpose(Image.FLIP_TOP_BOTTOM) if new_h > 0 else None
    flipped_h = scaled.transpose(Image.FLIP_LEFT_RIGHT) if new_w > 0 else None

    # Vertical extensions. The flipped copy's bottom-row matches the
    # original's bottom-row at the seam (and top-row to top-row), so
    # pasting flipped at y=oy-new_h (above) and y=oy+new_h (below)
    # produces a continuous mirror reflection. Each successive copy
    # alternates flipped-vs-not as we tile outward.
    if flipped_v is not None:
        # Above
        y = oy - new_h
        flip = flipped_v
        unflip = scaled
        toggle = True
        while y + new_h > 0:
            canvas.paste(flip if toggle else unflip, (ox, y),
                         flip if toggle else unflip)
            toggle = not toggle
            y -= new_h
        # Below
        y = oy + new_h
        flip = flipped_v
        unflip = scaled
        toggle = True
        while y < target_size:
            canvas.paste(flip if toggle else unflip, (ox, y),
                         flip if toggle else unflip)
            toggle = not toggle
            y += new_h

    # Horizontal extensions for the SCALED row of canvas (oy..oy+new_h).
    # Combined with the vertical mirror tiling above, this only
    # matters when the pattern is taller than wide — most egg crops
    # are wider than tall (we take the top 58% of an oval), so this
    # branch is usually a no-op.
    if flipped_h is not None:
        x = ox - new_w
        flip = flipped_h
        unflip = scaled
        toggle = True
        while x + new_w > 0:
            canvas.paste(flip if toggle else unflip, (x, oy),
                         flip if toggle else unflip)
            toggle = not toggle
            x -= new_w
        x = ox + new_w
        flip = flipped_h
        unflip = scaled
        toggle = True
        while x < target_size:
            canvas.paste(flip if toggle else unflip, (x, oy),
                         flip if toggle else unflip)
            toggle = not toggle
            x += new_w

    return canvas


def make_candy(size: int, egg_top: "Image.Image",
               twist_color: tuple[int, int, int]) -> "Image.Image":
    """Compose a single candy cell — a tinted sphere with a 1 px
    black outline and the cropped egg pattern (aspect-preserved
    and mirror-extended) showing through.

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

    # Tinted sphere with a soft mid-gray outline. Pure black reads
    # as harsh against the muted egg-art palette; ~110/110/110 sits
    # softly enough to define the silhouette without competing
    # visually with the tinted body.
    draw.ellipse(
        (body_l, body_t, body_r, body_b),
        fill=(*twist_color, 255),
        outline=(110, 110, 110, 255),
        width=1,
    )

    # Aspect-preserving fit + mirror-reflection extension. Gives the
    # pattern continuous coverage of the body region without the
    # squashing that a plain resize-to-square produced (egg patterns
    # are roughly 2:1 after the top-58% crop, so a square resize
    # vertically squished them).
    inset = 2
    inner_d = max(1, diameter - inset * 2)
    egg_resized = _extend_pattern_to_square(egg_top, inner_d)

    # Circular mask at native resolution.
    circle_mask = Image.new("L", (inner_d, inner_d), 0)
    ImageDraw.Draw(circle_mask).ellipse(
        (0, 0, inner_d - 1, inner_d - 1), fill=255)

    # Multiply by the extended pattern's alpha so any transparent
    # areas the source had (gaps in the egg art, padding the mirror
    # inherits) don't paint over the body's tinted backdrop.
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

    # Detect where the colored pattern transitions into the cream
    # base and crop above that. Beats a fixed top-N% ratio because
    # eggs vary in how tall their colored portion is, and autogen-
    # paste fallbacks (Munchlax, Mime Jr.) have no cream at all and
    # benefit from using the whole silhouette as pattern.
    top_h = max(8, _find_pattern_height(egg_cell))
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
        return (0, len(ALLOWED_SPECIES))

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
    for species in ALLOWED_SPECIES:
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
    for species in ALLOWED_SPECIES:
        root = family_roots.get(species, species)
        candy = root_candies.get(root)
        if candy is None:
            continue
        ccol = species % CANDY_COLS
        crow = species // CANDY_COLS
        out.paste(candy, (ccol * CANDY_PX, crow * CANDY_PX), candy)
        filled += 1

    out.save(CANDIES_PATH, optimize=True)
    return (filled, len(ALLOWED_SPECIES) - filled)


def main() -> None:
    print(f"→ Composing candies sprite sheet from {EGGS_PATH.name}...")
    filled, missing = build_candies_sheet()
    if filled == 0 and missing == len(ALLOWED_SPECIES):
        sys.exit(1)
    print(f"  {filled} candy cells filled, {missing} blank "
          f"→ {CANDIES_PATH}")


if __name__ == "__main__":
    main()
