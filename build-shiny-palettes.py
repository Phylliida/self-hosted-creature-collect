#!/usr/bin/env python3
"""Bake per-family-pair shiny transforms.

For a family pair (familyOf(rootA), familyOf(rootB)), compute 12
(φ, ΔL, κ) transforms by:
  1. Merging palettes across every fusion sprite in the family pair.
  2. Running the 3D farthest-point sampler with soft scoring against
     the merged palette.

The 12 transforms are then SHARED across every fusion in the pair, so
"shiny variant #N" of Charmander × Pikachu looks like "the same shiny
family" as variant #N of Charizard × Raichu.

For the prototype, this script is invoked with one or more family
pairs and produces:
  - One JSON dump (params per pair) for inspection.
  - Per-pair contact sheets showing every fusion in the pair × 12
    shinies, so coherence is visible at a glance.

Once results look good across a handful of pairs, we'll run across
all ~5500 (root_a, root_b) pairs and bundle the output as
data/BundledData/shiny-palettes.json (or .bin if we quantize).

Usage:
    python3 build-shiny-palettes.py --pair 4 7
        # Charmander family × Squirtle family
    python3 build-shiny-palettes.py --pair 129 133 --pair 4 25
        # Magikarp × Eevee + Charmander × Pikachu

Output goes to ./probe-output/ alongside the existing probe sheets.
"""

import argparse
import importlib.util
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

from PIL import Image, ImageDraw


# ── Import the existing probe module so we share OKLAB + sampler ────

_here = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location(
    'probe_shiny_hue', _here / 'probe-shiny-hue.py')
probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe)


# ── Family expansion ────────────────────────────────────────────────

SUPPORTED_SPECIES_MAX = 150


def load_evolutions(bundle_dir):
    """Parse species-evolutions.json into a {src: [(tgt, method, param)]}
    dict and its reverse-evolution map."""
    path = bundle_dir / 'species-evolutions.json'
    evos = json.loads(path.read_text())
    rev = defaultdict(list)
    for src_str, targets in evos.items():
        src = int(src_str)
        for t in targets:
            rev[t[0]].append(src)
    return evos, rev


def family_of(species_id, evos, rev):
    """BFS forward from the species' family root, filtered to gen-1
    only. Mirrors the JS Species.familyOf logic — walk back to root,
    then walk forward collecting descendants."""
    cur = species_id
    seen = {cur}
    while True:
        pred = rev.get(cur)
        if not pred:
            break
        prev = pred[0]
        if prev in seen:
            break
        seen.add(prev)
        cur = prev
    root = cur

    family = []
    visited = set()
    queue = [root]
    while queue:
        node = queue.pop(0)
        if node in visited:
            continue
        if node > SUPPORTED_SPECIES_MAX:
            continue
        visited.add(node)
        family.append(node)
        for t in evos.get(str(node), []):
            queue.append(t[0])
    return family


# ── Sprite + variant access ─────────────────────────────────────────

# Cache for sheet files — same sheet (autogen or custom) is opened
# many times across all 160 of its cells, and reading a 960×1536 PNG
# is the most expensive thing in this script.
_SHEET_CACHE = {}


def _open_sheet(path):
    key = str(path)
    if key not in _SHEET_CACHE:
        if not path.is_file():
            _SHEET_CACHE[key] = None
        else:
            _SHEET_CACHE[key] = Image.open(path).convert('RGBA')
    return _SHEET_CACHE[key]


def open_fusion_cell(sprites_dir, a, b, suffix='', cell_size=96, cols=10):
    """Open one 96×96 cell out of a 10×16 fusion sheet.
      suffix == ''  → sprites/<A>/autogen/<A>.png
      suffix == 'a' → sprites/<A>/custom/<A>a.png  (and so on)
    Cell B is at column B%10, row B//10."""
    if suffix:
        sheet_path = sprites_dir / str(a) / 'custom' / f'{a}{suffix}.png'
    else:
        sheet_path = sprites_dir / str(a) / 'autogen' / f'{a}.png'
    sheet = _open_sheet(sheet_path)
    if sheet is None:
        return None
    col = b % cols
    row = b // cols
    x = col * cell_size
    y = row * cell_size
    return sheet.crop((x, y, x + cell_size, y + cell_size))


def iter_fusion_variants(a, b, cells, manifest):
    """Yield every (slot_idx, suffix) variant that exists for (a, b)
    according to cells.json + manifest.json. Slot 0 is the autogen
    (empty suffix); other slots are custom-artist suffixes."""
    slots = cells.get(f'{a}-{b}')
    if not slots:
        return
    suffixes = manifest.get(str(b), [])
    for slot in slots:
        if slot < 0 or slot >= len(suffixes):
            continue
        yield slot, suffixes[slot]


# ── Merge palettes across a family pair ─────────────────────────────

def merge_family_pair_palette(sprites_dir, family_a, family_b,
                              cells, manifest, top_n=20):
    """Sum up the top-N chromatic colors of every fusion sprite +
    EVERY art variant of every fusion in family_a × family_b, weighted
    by pixel count.

    Variants are loaded from cells.json (which slots exist) ×
    manifest.json (slot → file suffix). Without variant coverage, the
    sampled transforms would constrain only against the autogen art —
    fine for autogen-only fusions but lets custom-artist variants
    slip past with muddy / clipped results. With variants the chosen
    transforms work across every painted rendition of the family.
    """
    combined = defaultdict(int)
    n_sprites = 0
    for a in family_a:
        for b in family_b:
            for (_slot, suffix) in iter_fusion_variants(a, b, cells, manifest):
                img = open_fusion_cell(sprites_dir, a, b, suffix=suffix)
                if img is None:
                    continue
                n_sprites += 1
                for (rgb, w) in probe.extract_sprite_test_colors(
                        img, top_n=top_n):
                    combined[rgb] += w
    return list(combined.items()), n_sprites


# ── Family-pair sampler ─────────────────────────────────────────────

def compute_family_pair_params(sprites_dir, family_a, family_b,
                                cells, manifest,
                                n=12, seed=None,
                                candidate_pool=2000, ranked_pool=200):
    """Compute the 12 shiny transforms for ONE family pair. Reuses
    the universal-sampler's soft-scoring code path but with a
    family-merged test palette (autogen + all custom art variants)
    instead of the synthetic universal palette."""
    test_colors, n_sprites = merge_family_pair_palette(
        sprites_dir, family_a, family_b, cells, manifest)
    if not test_colors:
        return [], [], 0

    if seed is None:
        # Hash the family roots so different pairs get different seeds
        # (avoids re-using the same RNG stream).
        seed = hash((family_a[0], family_b[0])) & 0xFFFFFFFF

    import random
    rng = random.Random(seed)
    log_kappa_max = math.log(probe.KAPPA_RANGE[1])

    # Pre-convert palette once — OKLAB / polar form is invariant
    # across all candidates, so doing it inside the scoring loop is
    # wasted work for the ~2000-candidate sweep.
    prepped = probe.prepare_test_palette(test_colors)

    scored = []
    for _ in range(candidate_pool):
        phi = rng.uniform(-math.pi, math.pi)
        delta_l = rng.uniform(-probe.DELTA_L_RANGE, probe.DELTA_L_RANGE)
        kappa = rng.uniform(*probe.KAPPA_RANGE)
        score = probe.score_3d_params_soft_prepped(
            prepped, phi, delta_l, kappa)
        scored.append((score, (phi, delta_l, kappa)))
    scored.sort(key=lambda s: s[0])
    candidates = [p for _, p in scored[:ranked_pool]]

    def normalize(p):
        phi, dl, kp = p
        return (math.cos(phi), math.sin(phi),
                dl / probe.DELTA_L_RANGE,
                math.log(kp) / log_kappa_max)

    def dist_sq(a, b):
        return sum((a[i] - b[i]) ** 2 for i in range(4))

    accepted = [(1.0, 0.0, 0.0, 0.0)]
    selected = []
    while len(selected) < n and candidates:
        best_idx = -1
        best_dist = -1.0
        for i, c in enumerate(candidates):
            nc = normalize(c)
            min_d = min(dist_sq(nc, a) for a in accepted)
            if min_d > best_dist:
                best_dist = min_d
                best_idx = i
        chosen = candidates.pop(best_idx)
        selected.append(chosen)
        accepted.append(normalize(chosen))
    return selected, test_colors, n_sprites


# ── Contact sheet rendering ─────────────────────────────────────────

def render_family_pair_sheet(sprites_dir, family_a, family_b, params,
                              out_path, scale=3):
    """Big grid: one row per fusion in family_a × family_b; columns
    are [original, shiny#0, shiny#1, ..., shiny#11]. Lets us eyeball
    coherence across the family + variety across the shinies in one
    glance."""
    fusions = [(a, b) for a in family_a for b in family_b]
    n_shinies = len(params)
    cols = 1 + n_shinies
    rows = len(fusions)

    cell_w = 96
    cell_h = 96
    sw, sh = cell_w * scale, cell_h * scale
    gap = 6
    label_h = 14
    pad = 12
    label_col = 80   # left-side label for each fusion row

    canvas_w = label_col + cols * (sw + gap) + pad * 2
    canvas_h = pad * 2 + rows * (sh + label_h + gap) + label_h + 4
    canvas = Image.new('RGBA', (canvas_w, canvas_h), (28, 28, 28, 255))
    draw = ImageDraw.Draw(canvas)

    # Column header — show param summary for each shiny slot.
    header_y = pad
    for c, (phi, dl, kp) in enumerate(params):
        x = pad + label_col + (c + 1) * (sw + gap) - sw
        label = (f'#{c:02d}  φ={math.degrees(phi):+.0f}°  '
                 f'ΔL={dl:+.2f}  κ={kp:.2f}')
        draw.text((x, header_y), label, fill=(180, 180, 180, 255))

    base_y = header_y + label_h + 4

    for r, (a, b) in enumerate(fusions):
        img = open_fusion_cell(sprites_dir, a, b)
        y = base_y + r * (sh + label_h + gap)
        draw.text((pad, y + sh // 2 - 6),
                  f'#{a}×{b}', fill=(180, 180, 180, 255))
        if img is None:
            draw.text((pad + label_col, y + sh // 2 - 6),
                      '(missing)', fill=(120, 80, 80, 255))
            continue
        # Original (column 0)
        canvas.paste(img.resize((sw, sh), Image.NEAREST),
                     (pad + label_col, y))
        # Shinies
        for c, (phi, dl, kp) in enumerate(params):
            shiny = probe.apply_shiny_3d(img, phi, dl, kp)
            x = pad + label_col + (c + 1) * (sw + gap)
            canvas.paste(shiny.resize((sw, sh), Image.NEAREST), (x, y))

    canvas.save(out_path)


# ── CLI ─────────────────────────────────────────────────────────────

def enumerate_family_roots(evos, rev, max_species=SUPPORTED_SPECIES_MAX):
    """Return sorted list of family-root species IDs in the supported
    range. A root is a species whose `family_of(...)` returns itself
    as the first element (no predecessor)."""
    roots = []
    for sp in range(1, max_species + 1):
        fam = family_of(sp, evos, rev)
        if fam and fam[0] == sp:
            roots.append(sp)
    return roots


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument('--pair', nargs=2, type=int, action='append',
                    metavar=('A', 'B'),
                    help='Family pair to test, given as two species '
                         'IDs (each will be expanded to its family). '
                         'Repeat the flag for multiple pairs.')
    ap.add_argument('--all', action='store_true',
                    help='Bake all family-root × family-root pairs. '
                         'Writes the production JSON; takes 1-3 hours.')
    ap.add_argument('--output-json', type=Path, default=None,
                    help='Where to write the bake JSON. Default: '
                         'data/BundledData/shiny-palettes.json for --all, '
                         'probe-output/shiny-palettes-test.json otherwise.')
    ap.add_argument('--bundle-dir', type=Path,
                    default=Path('data/BundledData'),
                    help='Path to BundledData (for species-evolutions.json '
                         'and the sprites/ tree). Default: data/BundledData')
    ap.add_argument('--out-dir', type=Path, default=Path('probe-output'),
                    help='Where to write per-pair contact sheets '
                         '(skipped in --all mode unless --render-samples '
                         'is set since 5500+ sheets is too many).')
    ap.add_argument('--render-samples', type=int, default=0,
                    help='In --all mode, render contact sheets for N '
                         'evenly-spaced sample pairs so we can spot-'
                         'check coherence after the bake (default: 0).')
    ap.add_argument('--scale', type=int, default=3,
                    help='Upscale factor per cell in contact sheets')
    ap.add_argument('--n', type=int, default=12,
                    help='Shinies per family pair')
    args = ap.parse_args()

    if not args.pair and not args.all:
        ap.error('need --pair or --all')

    args.out_dir.mkdir(parents=True, exist_ok=True)
    sprites_dir = args.bundle_dir / 'sprites'
    evos, rev = load_evolutions(args.bundle_dir)
    cells = json.loads((args.bundle_dir / 'cells.json').read_text())
    manifest = json.loads((args.bundle_dir / 'manifest.json').read_text())

    # ── --all mode: bake every (root_a, root_b) family pair. ────
    if args.all:
        roots = enumerate_family_roots(evos, rev)
        pair_list = [(a, b) for a in roots for b in roots]
        total = len(pair_list)
        print(f'baking {total} family pairs ({len(roots)} roots × '
              f'{len(roots)} roots)')
        sample_indices = set()
        if args.render_samples > 0 and total > 0:
            step = max(1, total // args.render_samples)
            sample_indices = set(range(0, total, step))[:args.render_samples] \
                if isinstance(sample_indices, list) else \
                {i for i in range(0, total, step)}

        bake = {}
        import time
        t_start = time.time()
        for i, (rootA, rootB) in enumerate(pair_list):
            family_a = family_of(rootA, evos, rev)
            family_b = family_of(rootB, evos, rev)
            params, _, n_sprites = compute_family_pair_params(
                sprites_dir, family_a, family_b, cells, manifest, n=args.n)
            if not params:
                continue
            bake[f'{rootA}-{rootB}'] = [
                # 3 floats per triple, rounded for compact JSON
                [round(phi, 5), round(dl, 5), round(kp, 5)]
                for (phi, dl, kp) in params
            ]
            if i in sample_indices:
                out_png = args.out_dir / f'shiny-family-{rootA}-{rootB}.png'
                render_family_pair_sheet(
                    sprites_dir, family_a, family_b, params, out_png,
                    scale=args.scale)
            # Progress log every 50 pairs.
            if (i + 1) % 50 == 0:
                elapsed = time.time() - t_start
                rate = (i + 1) / elapsed
                eta = (total - i - 1) / rate
                print(f'  [{i+1}/{total}] {rate:.1f} pairs/s, '
                      f'ETA {eta/60:.1f}m '
                      f'(last: {rootA}×{rootB}, {n_sprites} sprites)')

        out_json = args.output_json or (
            args.bundle_dir / 'shiny-palettes.json')
        out_json.write_text(json.dumps(bake, separators=(',', ':')))
        elapsed = time.time() - t_start
        size_kb = out_json.stat().st_size / 1024
        print(f'\nbake complete in {elapsed/60:.1f}m')
        print(f'  {len(bake)} family pairs')
        print(f'  → {out_json}  ({size_kb:.1f} KB)')
        return

    # ── --pair mode: test one or more pairs (existing behavior) ───
    json_out = {}
    for (rootA_seed, rootB_seed) in args.pair:
        family_a = family_of(rootA_seed, evos, rev)
        family_b = family_of(rootB_seed, evos, rev)
        if not family_a or not family_b:
            print(f'skip: families empty for {rootA_seed}, {rootB_seed}',
                  file=sys.stderr)
            continue
        rootA = family_a[0]
        rootB = family_b[0]
        n_fusion_cells = len(family_a) * len(family_b)
        print(f'pair {rootA}×{rootB}: families {family_a} × {family_b} '
              f'= {n_fusion_cells} fusion cells')
        params, test_colors, n_sprites = compute_family_pair_params(
            sprites_dir, family_a, family_b, cells, manifest, n=args.n)
        print(f'  merged from {n_sprites} sprites '
              f'(autogen + variants across family)')
        print(f'  palette: {len(test_colors)} unique chromatic entries '
              f' → sampled {len(params)} transforms')
        for i, (phi, dl, kp) in enumerate(params):
            print(f'    #{i:02d}  φ={math.degrees(phi):+.0f}°  '
                  f'ΔL={dl:+.2f}  κ={kp:.2f}')

        json_out[f'{rootA}-{rootB}'] = [
            {'phi': phi, 'deltaL': dl, 'kappa': kp}
            for (phi, dl, kp) in params
        ]
        out_png = args.out_dir / f'shiny-family-{rootA}-{rootB}.png'
        render_family_pair_sheet(
            sprites_dir, family_a, family_b, params, out_png,
            scale=args.scale)
        print(f'  → {out_png}')

    out_json = args.out_dir / 'shiny-palettes-test.json'
    out_json.write_text(json.dumps(json_out, indent=2))
    print(f'JSON dump → {out_json}')


if __name__ == '__main__':
    main()
