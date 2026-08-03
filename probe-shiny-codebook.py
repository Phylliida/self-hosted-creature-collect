#!/usr/bin/env python3
"""Codebook analysis: how few global shiny "types" can the baked
per-family-pair palettes be discretized into?

Motivation: shinies are baked per family pair A×B (12 transforms each),
so when new art lands in a family, that pair's palette changes and the
re-bake shifts the shiny colours of species that already shipped. A
fixed global codebook of k (φ, ΔL, κ) transforms — with each pair
storing 12 indices into it — would be stable against new art. This
script measures how lossy that discretization is as a function of k.

Method:
  1. Load data/BundledData/shiny-palettes.json (gen 1-4 + fam pack,
     ~9801 pairs × 12 transforms).
  2. k-means the pooled transforms in the same normalized 4D space the
     bake uses for farthest-point sampling: (cos φ, sin φ, ΔL/0.2,
     ln κ / ln 1.5). Sweep k.
  3. Metrics per k:
       - param-space distance to centroid (mean / p95 / max)
       - perceptual loss: apply original vs snapped transform to a
         canonical OKLab colour grid; ΔE = OKLab euclidean distance
         (mean / p95 / max over transforms)
       - distinct codebook types per pair after snapping (of 12 slots)
       - "shiny-ness retention": how much of the original transform's
         distance-from-identity survives snapping
  4. Validation pass: recompute the REAL merged sprite palettes for a
     sample of pairs and re-measure ΔE against actual art colours, to
     ground the canonical-grid numbers.

Usage:
    python3 probe-shiny-codebook.py                 # full sweep
    python3 probe-shiny-codebook.py --no-validate   # skip sprite pass
"""

import argparse
import importlib.util
import json
import math
import time
from pathlib import Path

import numpy as np

DELTA_L_RANGE = 0.20        # ±0.20 OKLAB L  (probe-shiny-hue.py)
LOG_KAPPA_MAX = math.log(1.5)
CHROMA_THRESHOLD = 0.04

HERE = Path(__file__).resolve().parent


# ── Data loading ────────────────────────────────────────────────────

def load_bake(path):
    """Return (keys, triples) — triples is (n_pairs, 12, 3) float64."""
    data = json.loads(Path(path).read_text())
    keys = sorted(data.keys())
    kept, rows = [], []
    for k in keys:
        t = data[k]
        if len(t) != 12:
            continue
        kept.append(k)
        rows.append(t)
    return kept, np.array(rows, dtype=np.float64)


def normalize(triples):
    """(φ, ΔL, κ) → (cos φ, sin φ, ΔL/0.2, ln κ/ln 1.5)."""
    phi, dl, kp = triples[..., 0], triples[..., 1], triples[..., 2]
    return np.stack([np.cos(phi), np.sin(phi),
                     dl / DELTA_L_RANGE,
                     np.log(kp) / LOG_KAPPA_MAX], axis=-1)


# ── k-means (numpy, k-means++, chunked assignment) ──────────────────

def _assign(X, C, chunk=20000):
    out = np.empty(len(X), dtype=np.int32)
    for s in range(0, len(X), chunk):
        xb = X[s:s + chunk]
        d2 = ((xb[:, None, :] - C[None, :, :]) ** 2).sum(-1)
        out[s:s + chunk] = d2.argmin(1)
    return out


def _kmeans_pp(X, k, rng):
    idx = [rng.integers(len(X))]
    d2 = ((X - X[idx[0]]) ** 2).sum(-1)
    while len(idx) < k:
        probs = d2 / d2.sum()
        idx.append(rng.choice(len(X), p=probs))
        d2 = np.minimum(d2, ((X - X[idx[-1]]) ** 2).sum(-1))
    return X[np.array(idx)].copy()


def kmeans(X, k, seed=0, restarts=3, iters=60):
    best = None
    for r in range(restarts):
        rng = np.random.default_rng(seed + r)
        C = _kmeans_pp(X, k, rng)
        prev = None
        for _ in range(iters):
            a = _assign(X, C)
            newC = C.copy()
            for j in range(k):
                m = a == j
                if m.any():
                    newC[j] = X[m].mean(0)
            shift = float(np.abs(newC - C).max())
            C = newC
            if prev is not None and shift < 1e-6:
                break
            prev = shift
        a = _assign(X, C)
        inertia = float(((X - C[a]) ** 2).sum())
        if best is None or inertia < best[0]:
            best = (inertia, C, a)
    return best[1], best[2]


# ── Perceptual evaluation ───────────────────────────────────────────

def canonical_grid():
    """OKLab (L, a, b) grid covering where sprite pixels live."""
    cols = []
    for L in (0.35, 0.5, 0.65, 0.8):
        for C in (0.05, 0.08, 0.11, 0.14):
            for i in range(24):
                h = 2 * math.pi * i / 24
                cols.append((L, C * math.cos(h), C * math.sin(h)))
    return np.array(cols, dtype=np.float64)


def apply_transform(lab, triples):
    """Vectorized apply_shiny_3d (minus gamut clip — it affects original
    and snapped transforms nearly identically, and ΔE between the two is
    what we measure). lab: (..., 3), triples: (..., 3) → (..., 3)."""
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    phi, dl, kp = triples[..., 0], triples[..., 1], triples[..., 2]
    C = np.sqrt(a * a + b * b)
    h = np.arctan2(b, a)
    newL = np.clip(L + dl, 0.0, 1.0)
    newC = C * kp
    return np.stack([newL,
                     newC * np.cos(h + phi),
                     newC * np.sin(h + phi)], axis=-1)


def delta_e_stats(triples, snapped, grid, chunk=8192):
    """Per-transform mean ΔE over the grid → (mean, p95, max) across
    transforms, plus mean per-transform shinyness-retention ratio."""
    flat_t = triples.reshape(-1, 3)
    flat_s = snapped.reshape(-1, 3)
    des, ratios = [], []
    for s in range(0, len(flat_t), chunk):
        t = flat_t[s:s + chunk]
        q = flat_s[s:s + chunk]
        orig = apply_transform(grid[None, :, :], t[:, None, :])   # (n, G, 3)
        quant = apply_transform(grid[None, :, :], q[:, None, :])
        de = np.sqrt(((orig - quant) ** 2).sum(-1))               # (n, G)
        des.append(de.mean(1))
        # shiny-ness: mean distance of transformed colour from source
        d_orig = np.sqrt(((orig - grid[None]) ** 2).sum(-1)).mean(1)
        d_quant = np.sqrt(((quant - grid[None]) ** 2).sum(-1)).mean(1)
        ratios.append(d_quant / np.maximum(d_orig, 1e-9))
    des = np.concatenate(des)
    ratios = np.concatenate(ratios)
    return {
        'de_mean': float(des.mean()),
        'de_p95': float(np.percentile(des, 95)),
        'de_max': float(des.max()),
        'retention_mean': float(ratios.mean()),
        'retention_frac_below_0.8': float((ratios < 0.8).mean()),
    }


# ── Real-palette validation ─────────────────────────────────────────

def load_bake_module():
    spec = importlib.util.spec_from_file_location(
        'bsp', HERE / 'build-shiny-palettes.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def validate_with_real_palettes(keys, triples, codebooks, n_pairs=120,
                                bundle_dir='data/BundledData', seed=7):
    """Recompute real merged palettes for a sample of pairs and measure
    weighted mean ΔE (over actual art colours, weighted by pixel count)
    between original and snapped transforms, for a few k values."""
    bsp = load_bake_module()
    bundle = Path(bundle_dir)
    evos, rev = bsp.load_evolutions(bundle)
    cells = json.loads((bundle / 'cells.json').read_text())
    manifest = json.loads((bundle / 'manifest.json').read_text())
    sprites_dir = bundle / 'sprites'

    rng = np.random.default_rng(seed)
    sample = rng.choice(len(keys), size=min(n_pairs, len(keys)),
                        replace=False)

    # Collect palettes first (the slow part), once for all k.
    palettes = {}   # pair index → (L, a, b, weight) arrays
    t0 = time.time()
    for n, i in enumerate(sample):
        rootA, rootB = (int(x) for x in keys[i].split('-'))
        fa = bsp.family_of(rootA, evos, rev)
        fb = bsp.family_of(rootB, evos, rev)
        test_colors, _ = bsp.merge_family_pair_palette(
            sprites_dir, fa, fb, cells, manifest)
        if not test_colors:
            continue
        prepped = bsp.probe.prepare_test_palette(test_colors)
        L = np.array([p[0] for p in prepped])
        C = np.array([p[1] for p in prepped])
        h = np.array([p[2] for p in prepped])
        w = np.array([p[3] for p in prepped], dtype=np.float64)
        lab = np.stack([L, C * np.cos(h), C * np.sin(h)], axis=-1)
        palettes[i] = (lab, w)
        if (n + 1) % 30 == 0:
            print(f'    palettes: {n + 1}/{len(sample)} '
                  f'({time.time() - t0:.0f}s)', flush=True)

    out = {}
    for k, (centroids_triples, assign) in codebooks.items():
        des = []
        for i, (lab, w) in palettes.items():
            t = triples[i]                       # (12, 3)
            q = centroids_triples[assign[i]]     # (12, 3)
            orig = apply_transform(lab[None], t[:, None])
            quant = apply_transform(lab[None], q[:, None])
            de = np.sqrt(((orig - quant) ** 2).sum(-1))   # (12, ncolours)
            des.append((de * w[None]).sum(1) / w.sum())
        des = np.concatenate(des)
        out[k] = {
            'de_mean': float(des.mean()),
            'de_p95': float(np.percentile(des, 95)),
            'de_max': float(des.max()),
            'n_pairs': len(palettes),
        }
    return out


# ── Main ────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--input', default='data/BundledData/shiny-palettes.json')
    ap.add_argument('--ks', type=int, nargs='+',
                    default=[8, 12, 16, 24, 32, 48, 64, 96, 128, 192,
                             256, 384])
    ap.add_argument('--validate-pairs', type=int, default=120,
                    help='Pairs to sample for the real-palette pass')
    ap.add_argument('--no-validate', action='store_true')
    ap.add_argument('--out', default='probe-output/shiny-codebook.json')
    args = ap.parse_args()

    keys, triples = load_bake(args.input)
    n_pairs = len(keys)
    print(f'{n_pairs} family pairs × 12 transforms = '
          f'{n_pairs * 12} transforms')

    X = normalize(triples)                    # (n, 12, 4)
    Xf = X.reshape(-1, 4)

    # Distribution sanity check.
    phi = triples[..., 0].ravel()
    dl = triples[..., 1].ravel()
    kp = triples[..., 2].ravel()
    print(f'φ deg: mean |φ|={np.degrees(np.abs(phi)).mean():.0f}  '
          f'ΔL: [{dl.min():.2f},{dl.max():.2f}] '
          f'mean|ΔL|={np.abs(dl).mean():.3f}  '
          f'κ: [{kp.min():.2f},{kp.max():.2f}] mean={kp.mean():.2f}')

    grid = canonical_grid()
    results = {}
    codebooks = {}
    validate_ks = {16, 32, 64, 128, 256} & set(args.ks)

    print(f'\n{"k":>4} | {"param mean":>10} {"p95":>6} | '
          f'{"ΔE mean":>7} {"p95":>6} {"max":>6} | '
          f'{"types/pair":>10} | {"retention":>9} {"%<0.8":>6}')
    print('-' * 86)
    for k in args.ks:
        t0 = time.time()
        C, a = kmeans(Xf, k, seed=42)
        assign = a.reshape(n_pairs, 12)
        # Centroids back to (φ, ΔL, κ).
        cx, cy, cd, ck = C[:, 0], C[:, 1], C[:, 2], C[:, 3]
        cent_triples = np.stack([
            np.arctan2(cy, cx),
            cd * DELTA_L_RANGE,
            np.exp(ck * LOG_KAPPA_MAX)], axis=-1)
        snapped = cent_triples[assign]         # (n, 12, 3)

        d = np.sqrt(((Xf - C[a]) ** 2).sum(-1))
        distinct = np.array([len(np.unique(row)) for row in assign])
        stats = delta_e_stats(triples, snapped, grid)
        results[k] = {
            'param_mean': float(d.mean()),
            'param_p95': float(np.percentile(d, 95)),
            'param_max': float(d.max()),
            'distinct_mean': float(distinct.mean()),
            'distinct_min': int(distinct.min()),
            **stats,
        }
        if k in validate_ks:
            codebooks[k] = (cent_triples, assign)
        print(f'{k:>4} | {d.mean():>10.3f} '
              f'{np.percentile(d, 95):>6.3f} | '
              f'{stats["de_mean"]:>7.4f} {stats["de_p95"]:>6.4f} '
              f'{stats["de_max"]:>6.4f} | '
              f'{distinct.mean():>5.1f} ({distinct.min():>2d}) | '
              f'{stats["retention_mean"]:>9.3f} '
              f'{stats["retention_frac_below_0.8"] * 100:>5.1f}%'
              f'   [{time.time() - t0:.0f}s]', flush=True)

    if not args.no_validate and codebooks:
        print(f'\nvalidation on real sprite palettes '
              f'({args.validate_pairs} sampled pairs):')
        val = validate_with_real_palettes(
            keys, triples, codebooks, n_pairs=args.validate_pairs)
        for k, v in val.items():
            print(f'  k={k:>3}: real-art ΔE mean={v["de_mean"]:.4f} '
                  f'p95={v["de_p95"]:.4f} max={v["de_max"]:.4f} '
                  f'(canonical-grid mean was '
                  f'{results[k]["de_mean"]:.4f})')
        results['_validation'] = val

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(results, indent=2))
    print(f'\nwrote {args.out}')


if __name__ == '__main__':
    main()
