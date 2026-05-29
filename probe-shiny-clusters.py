#!/usr/bin/env python3
"""Probe color clustering for the shiny-generation pipeline.

Reads a sprite (or a cell of a sprite sheet), extracts its chromatic
colors in OKLAB space, k-means clusters them, and writes a side-by-
side visualization PNG so we can eyeball whether clusters split into
sensible regions (body / belly / accent) or get confused.

Used during early shiny-system development to validate the clustering
parameters before we commit to baking results into bundled JSON.

Three knobs that matter:
  --k                K for k-means (default 5)
  --chroma-threshold OKLAB chroma below which a pixel is "structural"
                     (gray/outline; preserved across all shinies).
                     Default 0.04.
  --dark/light-threshold   OKLAB L below/above which a pixel is
                           structural regardless of chroma. Catches
                           near-black outlines + near-white highlights.

Usage:
    # Single sprite file
    python3 probe-shiny-clusters.py path/to/sprite.png

    # Crop a cell out of a 10×16 PIF sheet (cell K at col K%10 row K//10)
    python3 probe-shiny-clusters.py data/BundledData/sprites/4/autogen/4.png --cell 4
    python3 probe-shiny-clusters.py data/BundledData/sprites/4/autogen/4.png --cell 25  # Charmander × Pikachu

    # Batch — useful for skimming many sprites at different params
    python3 probe-shiny-clusters.py --k 6 sprite1.png sprite2.png sprite3.png

    # Inspect cluster structure as JSON instead of writing a PNG
    python3 probe-shiny-clusters.py --json sprite.png

Output: probe-<basename>.png alongside each input. Three columns:
  [original sprite | cluster map (each px painted with its
  centroid color, structural preserved) | per-cluster swatches showing
  centroid + members weighted by pixel count]

When called from build-bundled-data.py: import extract_clusters().
"""

import argparse
import json
import math
import random
import sys
from pathlib import Path
from PIL import Image


# ── OKLAB conversion ────────────────────────────────────────────────
# Björn Ottosson's formula. OKLAB is perceptually uniform — Euclidean
# distance in OKLAB matches perceived color difference much better
# than RGB or HSL, which is what makes k-means work cleanly here.

def _srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _linear_to_srgb(c):
    return c * 12.92 if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055


def rgb_to_oklab(r, g, b):
    rl = _srgb_to_linear(r / 255.0)
    gl = _srgb_to_linear(g / 255.0)
    bl = _srgb_to_linear(b / 255.0)
    L = 0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl
    M = 0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl
    S = 0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl
    Lc = L ** (1 / 3.0) if L > 0 else 0.0
    Mc = M ** (1 / 3.0) if M > 0 else 0.0
    Sc = S ** (1 / 3.0) if S > 0 else 0.0
    return (
        0.2104542553 * Lc + 0.7936177850 * Mc - 0.0040720468 * Sc,
        1.9779984951 * Lc - 2.4285922050 * Mc + 0.4505937099 * Sc,
        0.0259040371 * Lc + 0.7827717662 * Mc - 0.8086757660 * Sc,
    )


def oklab_to_rgb(L, a, b):
    Lc = L + 0.3963377774 * a + 0.2158037573 * b
    Mc = L - 0.1055613458 * a - 0.0638541728 * b
    Sc = L - 0.0894841775 * a - 1.2914855480 * b
    Ll = Lc ** 3
    Ml = Mc ** 3
    Sl = Sc ** 3
    rl = +4.0767416621 * Ll - 3.3077115913 * Ml + 0.2309699292 * Sl
    gl = -1.2684380046 * Ll + 2.6097574011 * Ml - 0.3413193965 * Sl
    bl = -0.0041960863 * Ll - 0.7034186147 * Ml + 1.7076147010 * Sl
    return (
        max(0, min(255, round(_linear_to_srgb(rl) * 255))),
        max(0, min(255, round(_linear_to_srgb(gl) * 255))),
        max(0, min(255, round(_linear_to_srgb(bl) * 255))),
    )


def oklab_chroma(lab):
    _, a, b = lab
    return math.sqrt(a * a + b * b)


# ── Palette + cluster extraction ────────────────────────────────────

def extract_palette(image, alpha_threshold=200):
    """Return {(r,g,b): pixel_count} for non-transparent pixels."""
    px = image.load()
    w, h = image.size
    counts = {}
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < alpha_threshold:
                continue
            key = (r, g, b)
            counts[key] = counts.get(key, 0) + 1
    return counts


def _kmeans_pp_init(points, weights, k, rng):
    """k-means++ seeding, weighted by (distance² × pixel_weight) so
    dominant colors are more likely to seed a cluster. Generic over
    point dimensionality (works for both 2D ab and 3D Lab points)."""
    n = len(points)
    dim = len(points[0])
    centroids = [points[rng.randrange(n)]]
    while len(centroids) < k:
        d2 = []
        for p in points:
            best = float('inf')
            for c in centroids:
                d = sum((p[i] - c[i]) ** 2 for i in range(dim))
                if d < best:
                    best = d
            d2.append(best)
        scores = [d * w for d, w in zip(d2, weights)]
        total = sum(scores)
        if total <= 0:
            # All remaining points coincide with existing centroids;
            # just pick anything new (or stop).
            for p in points:
                if p not in centroids:
                    centroids.append(p)
                    break
            else:
                break
            continue
        r = rng.uniform(0, total)
        cum = 0.0
        for p, s in zip(points, scores):
            cum += s
            if cum >= r:
                centroids.append(p)
                break
    return centroids


def kmeans_weighted(points, weights, k, max_iter=50, seed=42):
    """Weighted k-means in arbitrary dim. Returns (assignment, centroids).

    assignment[i] is the cluster index for points[i].
    centroids[j] is the weighted mean of cluster j (or a snapshot of
      the seeded centroid if the cluster emptied).
    """
    if not points:
        return [], []
    actual_k = min(k, len(points))
    dim = len(points[0])
    if actual_k == 1:
        # Trivially one cluster — compute the weighted mean.
        total_w = sum(weights) or 1
        centroid = tuple(
            sum(p[d] * w for p, w in zip(points, weights)) / total_w
            for d in range(dim)
        )
        return [0] * len(points), [centroid]
    rng = random.Random(seed)
    centroids = _kmeans_pp_init(points, weights, actual_k, rng)

    assignment = [0] * len(points)
    for _ in range(max_iter):
        # Assign each point to nearest centroid.
        moved = False
        for i, p in enumerate(points):
            best_j = 0
            best_d = float('inf')
            for j, c in enumerate(centroids):
                d = 0.0
                for d_idx in range(dim):
                    diff = p[d_idx] - c[d_idx]
                    d += diff * diff
                if d < best_d:
                    best_d = d
                    best_j = j
            if assignment[i] != best_j:
                assignment[i] = best_j
                moved = True

        # Recompute centroids (weighted).
        new_centroids = list(centroids)
        for j in range(actual_k):
            total_w = 0.0
            acc = [0.0] * dim
            for i, p in enumerate(points):
                if assignment[i] != j:
                    continue
                w = weights[i]
                total_w += w
                for d_idx in range(dim):
                    acc[d_idx] += p[d_idx] * w
            if total_w > 0:
                new_centroids[j] = tuple(a / total_w for a in acc)

        if not moved:
            centroids = new_centroids
            break
        centroids = new_centroids

    return assignment, centroids


def extract_clusters(image, k=5, chroma_threshold=0.04,
                    dark_threshold=0.10, light_threshold=0.95,
                    cluster_on='hue'):
    """The reusable entry point for build-bundled-data.py.

    Splits a sprite's palette into:
      structural — near-grays, near-blacks, near-whites that should
                   be preserved across all shinies (outlines, eye
                   whites, lineart). Identified by OKLAB chroma below
                   `chroma_threshold` OR L outside [dark, light].
      clusters   — chromatic palette entries grouped by OKLAB k-means.
                   Each cluster gets a centroid + member list. Shiny
                   variants then remap each cluster's centroid to a
                   new target color and re-render each pixel as
                   `new_centroid + (pixel_oklab - old_centroid)`.

    `cluster_on` controls the k-means distance metric:
      'hue' (default): cluster on hue ANGLE only. Each chromatic
                       (a, b) is normalized to unit length —
                       (cos h, sin h) — before clustering, so chroma
                       magnitude no longer affects membership. Light
                       teal + mid teal + dark teal cluster together
                       (same hue); light blue + light yellow split
                       apart (different hues). This is the principled
                       "perceptual hue clustering" the shiny remap
                       wants: rotate the cluster's hue, preserve
                       per-pixel chroma + lightness.
      'ab'  (compare): cluster on Cartesian (a, b). Approximates hue
                       clustering but with chroma magnitude smearing
                       the distance — over-segments single-hue regions
                       that have heavy shading.
      'lab' (compare): full 3D OKLAB. k-means treats lightness as a
                       clustering dimension, which means light pixels
                       of different hues can incorrectly cluster
                       together. The most-broken option, kept as a
                       flag for direct comparison.

    Returns a dict:
      {
        'palette_size': N,
        'structural': [{ rgb, weight, oklab }],
        'clusters': [{ centroid_oklab, centroid_rgb, members: [...],
                       total_weight }],
        'assignments': { rgb_tuple: cluster_idx | 'structural' },
      }
    """
    palette = extract_palette(image)
    structural = []
    chromatic_rgbs = []
    chromatic_labs = []
    chromatic_weights = []

    for rgb, count in palette.items():
        lab = rgb_to_oklab(*rgb)
        L, _, _ = lab
        chroma = oklab_chroma(lab)
        if (chroma < chroma_threshold
                or L < dark_threshold
                or L > light_threshold):
            structural.append({'rgb': rgb, 'weight': count, 'oklab': lab})
        else:
            chromatic_rgbs.append(rgb)
            chromatic_labs.append(lab)
            chromatic_weights.append(count)

    assignments = {s['rgb']: 'structural' for s in structural}
    clusters = []

    if chromatic_labs:
        if cluster_on == 'hue':
            # Normalize (a, b) to unit length so chroma magnitude
            # doesn't affect cluster membership — pure hue-angle
            # clustering via Euclidean distance on the unit circle.
            cluster_points = []
            for lab in chromatic_labs:
                _, a_, b_ = lab
                norm = math.sqrt(a_ * a_ + b_ * b_)
                if norm > 0:
                    cluster_points.append((a_ / norm, b_ / norm))
                else:
                    cluster_points.append((0.0, 0.0))
        elif cluster_on == 'ab':
            cluster_points = [(lab[1], lab[2]) for lab in chromatic_labs]
        else:
            cluster_points = chromatic_labs
        assign, centroids = kmeans_weighted(
            cluster_points, chromatic_weights, k)
        # Bucket members by cluster index.
        buckets = [[] for _ in centroids]
        for i, c_idx in enumerate(assign):
            buckets[c_idx].append({
                'rgb': chromatic_rgbs[i],
                'weight': chromatic_weights[i],
                'oklab': chromatic_labs[i],
            })
            assignments[chromatic_rgbs[i]] = c_idx
        for c_idx, members in enumerate(buckets):
            if not members:
                # Emptied cluster — synthesize a well-formed entry.
                if cluster_on == 'lab':
                    centroid_oklab = centroids[c_idx]
                else:
                    # 2D centroid; pad with L=0.5 for the missing axis.
                    centroid_oklab = (0.5, centroids[c_idx][0], centroids[c_idx][1])
            elif cluster_on == 'lab':
                centroid_oklab = centroids[c_idx]
            else:
                # 2D clustering: reconstruct L from weighted member Ls.
                # For 'hue', also reconstruct chroma from member chromas
                # so the centroid swatch reflects actual mid-shade
                # rather than a unit-circle abstraction.
                total_w = sum(m['weight'] for m in members)
                centroid_L = sum(
                    m['oklab'][0] * m['weight'] for m in members) / total_w
                if cluster_on == 'hue':
                    # Cluster centroid is on the unit circle (cos h,
                    # sin h); rescale to weighted-mean chroma.
                    mean_chroma = sum(
                        oklab_chroma(m['oklab']) * m['weight']
                        for m in members) / total_w
                    cos_h, sin_h = centroids[c_idx]
                    centroid_oklab = (
                        centroid_L,
                        cos_h * mean_chroma,
                        sin_h * mean_chroma,
                    )
                else:  # 'ab'
                    a_, b_ = centroids[c_idx]
                    centroid_oklab = (centroid_L, a_, b_)
            clusters.append({
                'centroid_oklab': centroid_oklab,
                'centroid_rgb': oklab_to_rgb(*centroid_oklab),
                'members': members,
                'total_weight': sum(m['weight'] for m in members),
            })
        # Sort clusters by descending total weight so the dominant
        # color is index 0 — useful when later code wants "the body
        # color" specifically.
        clusters.sort(key=lambda c: -c['total_weight'])
        # Rebuild assignments since indices changed.
        old_to_new = {}
        for new_idx, c in enumerate(clusters):
            for m in c['members']:
                old_to_new[m['rgb']] = new_idx
        for rgb in list(assignments.keys()):
            if assignments[rgb] != 'structural':
                assignments[rgb] = old_to_new[rgb]

    return {
        'palette_size': len(palette),
        'structural': structural,
        'clusters': clusters,
        'assignments': assignments,
    }


# ── Visualization ───────────────────────────────────────────────────

def _crop_cell(image, cell_id, cell_size=96, cols=10):
    """Return a single 96×96 cell out of a PIF-style sprite sheet."""
    col = cell_id % cols
    row = cell_id // cols
    x = col * cell_size
    y = row * cell_size
    return image.crop((x, y, x + cell_size, y + cell_size))


def render_probe(image, result, out_path, scale=4):
    """Write [original | cluster map | swatches] PNG.

    `scale` upscales the 96×96 sprite for legibility on retina screens.
    """
    w, h = image.size
    sw, sh = w * scale, h * scale
    border = 8
    swatch_w = sw // 3
    canvas_w = sw * 2 + swatch_w + border * 4
    canvas_h = sh + border * 2
    canvas = Image.new('RGBA', (canvas_w, canvas_h), (32, 32, 32, 255))

    # Column 1: original (scaled nearest-neighbor).
    canvas.paste(image.resize((sw, sh), Image.NEAREST), (border, border))

    # Column 2: cluster map. Each chromatic pixel painted with its
    # cluster centroid; structural pixels preserved.
    cluster_map = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    cpx = cluster_map.load()
    ipx = image.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = ipx[x, y]
            if a < 200:
                continue
            key = (r, g, b)
            assignment = result['assignments'].get(key, 'structural')
            if assignment == 'structural':
                cpx[x, y] = (r, g, b, a)
            else:
                cr, cg, cb = result['clusters'][assignment]['centroid_rgb']
                cpx[x, y] = (cr, cg, cb, a)
    canvas.paste(cluster_map.resize((sw, sh), Image.NEAREST),
                 (sw + border * 2, border))

    # Column 3: per-cluster swatches. For each cluster, a vertical band
    # sized by total pixel weight. Top half of band = centroid; bottom
    # half = members tiled by their individual weights (so you can see
    # the shade variation in the source palette that got merged).
    swatch_canvas = Image.new('RGBA', (swatch_w, sh), (24, 24, 24, 255))
    spx = swatch_canvas.load()
    total = sum(c['total_weight'] for c in result['clusters']) or 1
    y_cursor = 0
    for c in result['clusters']:
        band_h = max(4, int(c['total_weight'] / total * sh))
        cr, cg, cb = c['centroid_rgb']
        # Centroid bar (top half of band).
        centroid_h = band_h // 2
        for y in range(y_cursor, min(y_cursor + centroid_h, sh)):
            for x in range(swatch_w):
                spx[x, y] = (cr, cg, cb, 255)
        # Members (bottom half), divided by relative weight.
        members_y0 = y_cursor + centroid_h
        members_y1 = min(y_cursor + band_h, sh)
        members_band = members_y1 - members_y0
        if members_band > 0 and c['members']:
            mtotal = sum(m['weight'] for m in c['members']) or 1
            mx_cursor = 0
            for m in c['members']:
                mw = max(1, int(m['weight'] / mtotal * swatch_w))
                mr, mg, mb = m['rgb']
                for y in range(members_y0, members_y1):
                    for x in range(mx_cursor, min(mx_cursor + mw, swatch_w)):
                        spx[x, y] = (mr, mg, mb, 255)
                mx_cursor += mw
                if mx_cursor >= swatch_w:
                    break
        # Separator line below the band.
        if y_cursor + band_h < sh:
            for x in range(swatch_w):
                spx[x, y_cursor + band_h - 1] = (16, 16, 16, 255)
        y_cursor += band_h
    canvas.paste(swatch_canvas, (sw * 2 + border * 3, border))

    canvas.save(out_path)


# ── CLI ─────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument('paths', nargs='+', help='Sprite PNG file(s)')
    ap.add_argument('--k', type=int, default=5, help='K for k-means')
    ap.add_argument('--chroma-threshold', type=float, default=0.04,
                    help='OKLAB chroma below which pixels are structural')
    ap.add_argument('--dark-threshold', type=float, default=0.10,
                    help='OKLAB L below which pixels are structural')
    ap.add_argument('--light-threshold', type=float, default=0.95,
                    help='OKLAB L above which pixels are structural')
    ap.add_argument('--cell', type=int, default=None,
                    help='Crop cell N out of a 10×16 PIF sheet '
                         '(N at col N%%10, row N//10). Useful for '
                         'probing one fusion from a sheet of 160.')
    ap.add_argument('--cluster-on', choices=['hue', 'ab', 'lab'], default='hue',
                    help='Distance metric for k-means. hue (default) '
                         'clusters by hue angle only (chroma magnitude '
                         "doesn't affect membership). ab clusters on "
                         '(a, b) Cartesian — approximates hue but '
                         'over-segments heavily-shaded single-hue '
                         'regions. lab clusters on full 3D OKLAB and '
                         'mis-groups light pixels of different hues.')
    ap.add_argument('--scale', type=int, default=4,
                    help='Upscale factor for output PNG (default 4)')
    ap.add_argument('--out-dir', type=Path, default=Path('probe-output'),
                    help='Where to write probe-*.png files '
                         '(default: ./probe-output/)')
    ap.add_argument('--json', action='store_true',
                    help='Print cluster JSON to stdout, skip PNG write')
    args = ap.parse_args()
    if not args.json:
        args.out_dir.mkdir(parents=True, exist_ok=True)

    for path_str in args.paths:
        path = Path(path_str)
        if not path.is_file():
            print(f'skip: {path} (not found)', file=sys.stderr)
            continue
        image = Image.open(path).convert('RGBA')
        if args.cell is not None:
            image = _crop_cell(image, args.cell)
        result = extract_clusters(
            image,
            k=args.k,
            chroma_threshold=args.chroma_threshold,
            dark_threshold=args.dark_threshold,
            light_threshold=args.light_threshold,
            cluster_on=args.cluster_on,
        )
        if args.json:
            # Compact JSON summary — full member lists would be noisy.
            print(json.dumps({
                'path': str(path),
                'cell': args.cell,
                'palette_size': result['palette_size'],
                'structural_count': len(result['structural']),
                'clusters': [
                    {
                        'idx': i,
                        'centroid_rgb': c['centroid_rgb'],
                        'centroid_oklab': [round(x, 4) for x in c['centroid_oklab']],
                        'total_weight': c['total_weight'],
                        'member_count': len(c['members']),
                        'top_members': [
                            {'rgb': m['rgb'], 'weight': m['weight']}
                            for m in sorted(c['members'],
                                            key=lambda m: -m['weight'])[:5]
                        ],
                    }
                    for i, c in enumerate(result['clusters'])
                ],
            }, indent=2))
            continue
        stem = path.stem if args.cell is None else f'{path.stem}-cell{args.cell}'
        out = args.out_dir / f'probe-{stem}.png'
        render_probe(image, result, out, scale=args.scale)
        n_chrom = sum(len(c['members']) for c in result['clusters'])
        print(f'{path.name}'
              f'{f" cell{args.cell}" if args.cell is not None else ""}: '
              f'{result["palette_size"]} colors → '
              f'{len(result["structural"])} structural + '
              f'{n_chrom} chromatic in {len(result["clusters"])} clusters '
              f'→ {out.name}')


if __name__ == '__main__':
    main()
