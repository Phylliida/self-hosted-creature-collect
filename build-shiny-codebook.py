#!/usr/bin/env python3
"""Build the master shiny codebook and per-pack shiny-palettes.bin (v3).

Replaces the per-family-pair baked (φ, ΔL, κ) triples with a FROZEN global
codebook of K=128 shiny "types"; every family pair stores 12 indices into
it. Motivation: the old per-pair bake meant adding new art to a family
changed that pair's palette → re-bake → already-shipped shinies changed
colour. With a fixed codebook + an append-only master file, existing
entries never change; only genuinely new pairs are baked and appended.

Coverage: one master JSON (`data/shiny-codebook.json`) holds every family
pair of BOTH games, in per-game sections (the two games share the PIF
species id space — verified by species-names comparison — but were baked
against different art, so shared pairs keep their own per-game indices and
neither pack's existing shinies change):

  creature-fusion  data/BundledData      (gen 1-4 + fam pack)
  creature-if2     data/BundledData-if2  (IF2 union, gens 1-5 + closures;
                   art = union of IF1 + IF2 + Battlers custom sheets, see
                   merge-custom-art.py / build-if2-packs.py union)

Pipeline:
  --init (first run only): k-means the pooled transforms of BOTH existing
      bakes → 128-type codebook; snap every baked pair to 12 distinct
      codebook entries (greedy, most-constrained-first). Snapping costs
      mean OKLab ΔE ≈ 0.030 (~3 JND) — see probe-shiny-codebook.py.
  every run: gap-fill — for any roster pair missing from the master, bake
      12 transforms against that game's bundle (autogen + all custom art
      variants) and snap them. Pairs whose merged palette is empty even
      after the autogen fallback (truly grayscale art, e.g. Onix pairs —
      a hue transform is a visual no-op there) get a deterministic
      default: 12 farthest-spread codebook entries seeded by crc32(pair).
      Existing entries are NEVER recomputed — the master is append-only.
  output: per-game shiny-palettes.bin format v3 (same filename as v2, so
      pack builds and the runtime URL are unchanged).

Bin v3 layout (little-endian):
  0   4   magic 'SHIN'
  4   4   version (u32 = 3)
  8   4   entry count (u32)
  12  4   codebook size K (u32)
  16  K×4 codebook triples (same encoding as v2:
            phi int16 → /32767·π, deltaL int8 → /127·0.20,
            kappa u8 → 0.5 + /255)
  …   entries, sorted by (rootA, rootB), 16 bytes each:
        rootA u16, rootB u16, 12 × u8 codebook indices

Usage:
  python3 build-shiny-codebook.py --init      # first run (refused if master exists)
  python3 build-shiny-codebook.py             # append-only gap-fill + emit bins
  python3 build-shiny-codebook.py --verify    # round-trip bins vs master, stats
"""

import argparse
import importlib.util
import json
import math
import struct
import sys
import time
import zlib
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent

CODEBOOK_K = 128
TRIPLES_PER_PAIR = 12
DELTA_L_RANGE = 0.20
KAPPA_MIN, KAPPA_MAX = 0.5, 1.5
LOG_KAPPA_MAX = math.log(KAPPA_MAX)

MAGIC = b'SHIN'
VERSION = 3
HEADER_BYTES = 16
ENTRY_BYTES = 4 + TRIPLES_PER_PAIR  # u16 a, u16 b + 12 u8 indices

MASTER_PATH = HERE / 'data' / 'shiny-codebook.json'

GAMES = {
    'creature-fusion': {
        'bundle': HERE / 'data' / 'BundledData',
        'bake': HERE / 'data' / 'BundledData' / 'shiny-palettes.json',
        'bin': HERE / 'data' / 'BundledData' / 'shiny-palettes.bin',
    },
    'creature-if2': {
        'bundle': HERE / 'data' / 'BundledData-if2',
        'bake': HERE / 'data' / 'BundledData-if2' / 'shiny-palettes.json',
        'bin': HERE / 'data' / 'BundledData-if2' / 'shiny-palettes.bin',
    },
}

# Import the bake machinery (palette merge + scored sampler) so gap-fill
# bakes exactly the way build-shiny-palettes.py does.
_spec = importlib.util.spec_from_file_location(
    'bsp', HERE / 'build-shiny-palettes.py')
bsp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bsp)


# ── Transform space helpers ─────────────────────────────────────────

def normalize(triples):
    """(φ, ΔL, κ) → (cos φ, sin φ, ΔL/0.2, ln κ/ln 1.5) — the same
    normalized 4D space the bake's farthest-point sampler uses."""
    triples = np.asarray(triples, dtype=np.float64)
    phi, dl, kp = triples[..., 0], triples[..., 1], triples[..., 2]
    return np.stack([np.cos(phi), np.sin(phi),
                     dl / DELTA_L_RANGE,
                     np.log(kp) / LOG_KAPPA_MAX], axis=-1)


def denormalize(pts):
    """Inverse of normalize (for k-means centroids)."""
    pts = np.asarray(pts, dtype=np.float64)
    return np.stack([np.arctan2(pts[..., 1], pts[..., 0]),
                     pts[..., 2] * DELTA_L_RANGE,
                     np.exp(pts[..., 3] * LOG_KAPPA_MAX)], axis=-1)


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
        idx.append(rng.choice(len(X), p=d2 / d2.sum()))
        d2 = np.minimum(d2, ((X - X[idx[-1]]) ** 2).sum(-1))
    return X[np.array(idx)].copy()


def kmeans(X, k, seed=42, restarts=3, iters=60):
    best = None
    for r in range(restarts):
        rng = np.random.default_rng(seed + r)
        C = _kmeans_pp(X, k, rng)
        for _ in range(iters):
            a = _assign(X, C)
            newC = C.copy()
            for j in range(k):
                m = a == j
                if m.any():
                    newC[j] = X[m].mean(0)
            shift = float(np.abs(newC - C).max())
            C = newC
            if shift < 1e-6:
                break
        a = _assign(X, C)
        inertia = float(((X - C[a]) ** 2).sum())
        if best is None or inertia < best[0]:
            best = (inertia, C)
    return best[1]


# ── Snapping ────────────────────────────────────────────────────────

def snap_pair(norm12, C):
    """Assign a pair's 12 normalized transforms to 12 DISTINCT codebook
    entries, greedily, most-constrained (smallest nearest distance) first.
    Distinctness preserves the bake's within-pair variety — the 12 slots
    were farthest-point sampled to be different from each other."""
    d = ((norm12[:, None, :] - C[None, :, :]) ** 2).sum(-1)   # (12, K)
    order = np.argsort(d.min(1), kind='stable')
    used = np.zeros(len(C), dtype=bool)
    out = np.empty(len(norm12), dtype=np.int64)
    for i in order:
        di = d[i].copy()
        di[used] = np.inf
        j = int(di.argmin())
        used[j] = True
        out[i] = j
    return out


def default_pair(key, C):
    """Deterministic 12-entry assignment for pairs with no usable palette
    (truly grayscale art — a hue/chroma transform is a visual no-op, so
    this just completes the file stably). Farthest-point spread across
    the codebook, seeded by crc32(pair key) — stable across runs,
    unlike Python's salted hash()."""
    rng = np.random.default_rng(zlib.crc32(key.encode()) & 0xFFFFFFFF)
    chosen = [int(rng.integers(len(C)))]
    d2 = ((C - C[chosen[0]]) ** 2).sum(-1)
    while len(chosen) < TRIPLES_PER_PAIR:
        nxt = int(d2.argmax())
        chosen.append(nxt)
        d2 = np.minimum(d2, ((C - C[nxt]) ** 2).sum(-1))
    return np.array(sorted(chosen), dtype=np.int64)


def gap_fill_from(target_game, source_game, C4, games):
    """Fill target_game's missing roster pairs by COPYING source_game's
    assignments for the same family-pair keys — no baking. The frozen
    shared codebook makes source assignments meaningful for the target
    (same 128 types), which is the intended growth path: new roster
    pairs reuse the already-shipped assignments so adding species never
    shifts anyone's colours. Pairs the source section lacks get the
    deterministic default. Existing target entries are never touched."""
    roots, _ = load_roster(GAMES[target_game]['bundle'])
    target = games[target_game]
    source = games[source_game]
    missing = [(a, b) for a in roots for b in roots
               if f'{a}-{b}' not in target]
    n_copied = n_default = 0
    for a, b in missing:
        key = f'{a}-{b}'
        if key in source:
            target[key] = np.array(source[key], dtype=np.int64)
            n_copied += 1
        else:
            target[key] = default_pair(key, C4)
            n_default += 1
    print(f'  {target_game}: mirrored {n_copied:,} pairs from {source_game}, '
          f'{n_default:,} crc32 defaults (roster {len(roots)} roots, '
          f'{len(roots) ** 2:,} pairs)')
    return n_copied, n_default


# ── Game-local roster (no species_pool import — each bundle ships its
#    own species-pool.json + species-evolutions.json) ────────────────

def load_roster(bundle_dir):
    """Return sorted family-root ids for one game's bundle, driven by the
    bundle's own species-pool.json + species-evolutions.json.

    Roots are CANDY roots, mirroring static/creatures.js candyRootFor:
    walk to the earliest ancestor, then skip past baby ids (the bundle's
    species-pool.json 'babies' list). An earlier version anchored roots
    at the baby itself, which silently mismatched every client lookup
    for the 18 baby families (e.g. IF2 keyed Chansey pairs under
    Happiny 259 while the client asks for 113)."""
    pool_doc = json.loads((bundle_dir / 'species-pool.json').read_text())
    pool = set(pool_doc['species'])
    babies = set(pool_doc.get('babies', []))
    evos, rev = bsp.load_evolutions(bundle_dir)

    def family_of(sp):
        cur = sp
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
        family, visited, queue = [], set(), [root]
        while queue:
            node = queue.pop(0)
            if node in visited or node not in pool:
                continue
            visited.add(node)
            family.append(node)
            for t in evos.get(str(node), []):
                queue.append(t[0])
        return family

    def candy_root(sp):
        family = family_of(sp)
        i = 0
        while i < len(family) - 1 and family[i] in babies:
            i += 1
        return family[i]

    roots = sorted(sp for sp in pool if candy_root(sp) == sp)
    return roots, family_of


# ── Bin v3 ──────────────────────────────────────────────────────────

def encode_triple(phi, dl, kp):
    phi_q = max(-32767, min(32767, round(phi / math.pi * 32767)))
    dl_q = max(-127, min(127, round(dl / DELTA_L_RANGE * 127)))
    kp_q = round((max(KAPPA_MIN, min(KAPPA_MAX, kp)) - KAPPA_MIN)
                 / (KAPPA_MAX - KAPPA_MIN) * 255)
    return struct.pack('<hbB', phi_q, dl_q, kp_q)


def decode_triple(buf, off):
    phi_q, dl_q, kp_q = struct.unpack_from('<hbB', buf, off)
    return (phi_q / 32767 * math.pi,
            dl_q / 127 * DELTA_L_RANGE,
            KAPPA_MIN + kp_q / 255 * (KAPPA_MAX - KAPPA_MIN))


def pack_bin(codebook, pairs, out_path):
    keys = sorted((tuple(int(p) for p in k.split('-')), k) for k in pairs)
    buf = bytearray()
    buf += MAGIC
    buf += struct.pack('<III', VERSION, len(keys), len(codebook))
    for (phi, dl, kp) in codebook:
        buf += encode_triple(phi, dl, kp)
    for ((a, b), raw_key) in keys:
        idx = pairs[raw_key]
        if len(idx) != TRIPLES_PER_PAIR:
            raise ValueError(f'{raw_key}: expected 12 indices')
        if any(i < 0 or i >= len(codebook) for i in idx):
            raise ValueError(f'{raw_key}: index out of range')
        buf += struct.pack('<HH', a, b)
        buf += bytes(int(i) for i in idx)
    out_path.write_bytes(buf)
    return len(buf), len(keys)


# ── Master load/save ────────────────────────────────────────────────

def load_master(path):
    return json.loads(path.read_text())


def save_master(path, codebook, games):
    out = {
        'meta': {
            'format': 1,
            'k': len(codebook),
            'triplesPerPair': TRIPLES_PER_PAIR,
            'note': 'Append-only: existing pairs entries and the '
                    'codebook are frozen; only new pairs are appended.',
        },
        'codebook': [[round(x, 5) for x in t] for t in codebook],
        'games': {
            g: {'pairs': {k: [int(i) for i in v]
                          for k, v in sorted(
                              games[g].items(),
                              key=lambda kv: tuple(
                                  int(p) for p in kv[0].split('-')))}}
            for g in games
        },
    }
    path.write_text(json.dumps(out, indent=0) + '\n')


# ── Init + gap-fill ─────────────────────────────────────────────────

def init_codebook():
    """k-means the pooled transforms of both existing bakes (subsampled
    deterministically for speed — the distribution is near-uniform by
    sampler design, so 200k points characterize it fully)."""
    X = []
    for g, cfg in GAMES.items():
        bake = json.loads(cfg['bake'].read_text())
        trips = np.array([t for v in bake.values() for t in v],
                         dtype=np.float64)
        print(f'  {g}: {len(bake):,} pairs, {len(trips):,} transforms')
        X.append(trips)
    X = np.concatenate(X)
    rng = np.random.default_rng(42)
    sub = X[rng.choice(len(X), size=min(200_000, len(X)), replace=False)]
    print(f'  k-means k={CODEBOOK_K} on {len(sub):,} '
          f'(of {len(X):,}) transforms…')
    t0 = time.time()
    C = kmeans(normalize(sub), CODEBOOK_K)
    print(f'  codebook fit in {time.time() - t0:.0f}s')
    return denormalize(C)


def snap_bake(bake, C4):
    return {k: snap_pair(normalize(v), C4) for k, v in bake.items()}


def gap_fill(game, cfg, C4, pairs):
    """Bake + append any roster pair missing from the master's section.
    Existing entries are never touched (append-only)."""
    roots, family_of = load_roster(cfg['bundle'])
    bundle = cfg['bundle']
    cells = json.loads((bundle / 'cells.json').read_text())
    manifest = json.loads((bundle / 'manifest.json').read_text())
    sprites_dir = bundle / 'sprites'
    evos, rev = bsp.load_evolutions(bundle)

    missing = [(a, b) for a in roots for b in roots
               if f'{a}-{b}' not in pairs]
    if not missing:
        print(f'  {game}: roster {len(roots)} roots — complete, '
              f'nothing to bake')
        return 0, 0
    print(f'  {game}: {len(missing)} missing pairs to bake '
          f'(roster {len(roots)} roots = {len(roots) ** 2} pairs)')
    n_baked = n_default = 0
    t0 = time.time()
    for n, (a, b) in enumerate(missing):
        key = f'{a}-{b}'
        params, _tc, _ns = bsp.compute_family_pair_params(
            sprites_dir, family_of(a), family_of(b), cells, manifest,
            n=TRIPLES_PER_PAIR)
        if params:
            pairs[key] = snap_pair(normalize(params), C4)
            n_baked += 1
        else:
            pairs[key] = default_pair(key, C4)
            n_default += 1
        if (n + 1) % 25 == 0:
            print(f'    [{n + 1}/{len(missing)}] {time.time() - t0:.0f}s',
                  flush=True)
    print(f'  {game}: baked {n_baked}, gray-default {n_default} '
          f'({time.time() - t0:.0f}s)')
    return n_baked, n_default


def emit_bins(codebook, games):
    for g, cfg in GAMES.items():
        n_bytes, n_entries = pack_bin(codebook, games[g], cfg['bin'])
        print(f'  {cfg["bin"]}: {n_entries:,} entries, '
              f'{n_bytes:,} bytes ({n_bytes / 1024:.0f} KB)')


# ── Verify ──────────────────────────────────────────────────────────

def verify(master):
    codebook = [tuple(t) for t in master['codebook']]
    k = len(codebook)
    for g, cfg in GAMES.items():
        bin_path = cfg['bin']
        if not bin_path.is_file():
            print(f'  {g}: {bin_path} missing — skip')
            continue
        buf = bin_path.read_bytes()
        if buf[:4] != MAGIC:
            raise SystemExit(f'{bin_path}: bad magic')
        version, count, kk = struct.unpack_from('<III', buf, 4)
        if version != VERSION or kk != k:
            raise SystemExit(
                f'{bin_path}: version={version} K={kk}, '
                f'expected v{VERSION} K={k}')
        pairs = master['games'][g]['pairs']
        if count != len(pairs):
            raise SystemExit(
                f'{bin_path}: {count} entries, master has {len(pairs)}')
        max_d = 0.0
        off = HEADER_BYTES
        for (phi, dl, kp) in codebook:
            d = decode_triple(buf, off)
            max_d = max(max_d, abs(d[0] - phi), abs(d[1] - dl),
                        abs(d[2] - kp))
            off += 4
        n_distinct = []
        for i in range(count):
            a, b = struct.unpack_from('<HH', buf, off)
            idx = list(buf[off + 4:off + ENTRY_BYTES])
            want = pairs.get(f'{a}-{b}')
            if want is None:
                raise SystemExit(f'{bin_path}: entry {a}-{b} not in master')
            if [int(x) for x in want] != idx:
                raise SystemExit(f'{bin_path}: entry {a}-{b} indices differ')
            n_distinct.append(len(set(idx)))
            off += ENTRY_BYTES
        print(f'  {g}: OK — {count:,} entries, codebook round-trip '
              f'max dev {max_d:.6f}, distinct types/pair '
              f'mean {sum(n_distinct) / len(n_distinct):.1f} '
              f'min {min(n_distinct)}')


# ── Main ────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--init', action='store_true',
                    help='First run: derive the codebook from both '
                         'existing bakes and snap them. Refused if the '
                         'master already exists (append-only).')
    ap.add_argument('--verify', action='store_true',
                    help='Round-trip the emitted bins against the master '
                         'and print stats. No baking.')
    ap.add_argument('--mirror', nargs=2, metavar=('SOURCE', 'TARGET'),
                    help='Gap-fill TARGET\'s section by copying SOURCE\'s '
                         'assignments for the same pair keys (no baking — '
                         'the shared frozen codebook makes them portable). '
                         'Pairs SOURCE lacks get the crc32 default.')
    ap.add_argument('--master', type=Path, default=MASTER_PATH)
    args = ap.parse_args()

    if args.verify:
        verify(load_master(args.master))
        return

    if args.mirror:
        src_g, tgt_g = args.mirror
        if src_g not in GAMES or tgt_g not in GAMES:
            ap.error(f'--mirror games must be among {sorted(GAMES)}')
        master = load_master(args.master)
        codebook = [tuple(t) for t in master['codebook']]
        C4 = normalize(codebook)
        games = {g: {k: np.array(v, dtype=np.int64)
                     for k, v in master['games'][g]['pairs'].items()}
                 for g in GAMES}
        print(f'mirror {src_g} → {tgt_g}:')
        gap_fill_from(tgt_g, src_g, C4, games)
        save_master(args.master, codebook, games)
        total = sum(len(games[g]) for g in games)
        print(f'wrote {args.master} ({total:,} pairs total)')
        print('emitting bins:')
        emit_bins(codebook, games)
        return

    if args.init:
        if args.master.is_file():
            ap.error(f'{args.master} already exists — the master is '
                     'append-only; run without --init to gap-fill')
        print('deriving codebook from existing bakes:')
        codebook = init_codebook()
        C4 = normalize(codebook)
        games = {}
        for g, cfg in GAMES.items():
            bake = json.loads(cfg['bake'].read_text())
            games[g] = snap_bake(bake, C4)
            print(f'  {g}: snapped {len(games[g]):,} pairs')
    else:
        if not args.master.is_file():
            ap.error(f'{args.master} not found — run with --init first')
        master = load_master(args.master)
        codebook = [tuple(t) for t in master['codebook']]
        C4 = normalize(codebook)
        games = {g: {k: np.array(v, dtype=np.int64)
                     for k, v in master['games'][g]['pairs'].items()}
                 for g in GAMES}

    print('gap-fill:')
    for g, cfg in GAMES.items():
        gap_fill(g, cfg, C4, games[g])

    save_master(args.master, codebook, games)
    total = sum(len(games[g]) for g in games)
    print(f'wrote {args.master} ({total:,} pairs total)')
    print('emitting bins:')
    emit_bins(codebook, games)


if __name__ == '__main__':
    main()
