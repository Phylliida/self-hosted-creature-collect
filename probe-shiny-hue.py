#!/usr/bin/env python3
"""Prototype shiny generation via smooth hue map: rotation + sinusoidal wobble.

For each chromatic (non-near-gray) pixel, applies the transform:
    h_new = h + φ + ε · sin(h − θ)
    L, chroma unchanged

φ is the global rotation. ε · sin(h − θ) is a smooth wobble that
warps the wheel non-uniformly, so different hue regions can shift
differently while neighbor relationships are preserved everywhere.
|ε| < 1 guarantees monotonicity (it stays a permutation of the circle).

Outputs a contact sheet: the original on the left, N shiny variants in
a grid on the right, each generated from seed=variant_index. Lets us
eyeball whether the smooth-permutation approach actually produces
pleasing results.

Usage:
    python3 probe-shiny-hue.py sprite.png
    python3 probe-shiny-hue.py --cell 4 data/BundledData/sprites/4/autogen/4.png
    python3 probe-shiny-hue.py --n 16 --cell 25 data/BundledData/sprites/25/autogen/25.png
"""

import argparse
import math
import random
import sys
from pathlib import Path
from PIL import Image, ImageDraw


# ── OKLAB ───────────────────────────────────────────────────────────
# Same conversion as probe-shiny-clusters.py — copy/pasted rather
# than imported because the dash in the filename makes import awkward
# and this prototype is meant to stand alone.

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


def oklab_to_linear_rgb(L, a, b):
    """OKLAB → linear sRGB (floats, may be outside [0, 1])."""
    Lc = L + 0.3963377774 * a + 0.2158037573 * b
    Mc = L - 0.1055613458 * a - 0.0638541728 * b
    Sc = L - 0.0894841775 * a - 1.2914855480 * b
    Ll = Lc ** 3
    Ml = Mc ** 3
    Sl = Sc ** 3
    return (
        +4.0767416621 * Ll - 3.3077115913 * Ml + 0.2309699292 * Sl,
        -1.2684380046 * Ll + 2.6097574011 * Ml - 0.3413193965 * Sl,
        -0.0041960863 * Ll - 0.7034186147 * Ml + 1.7076147010 * Sl,
    )


def oklab_to_rgb(L, a, b):
    rl, gl, bl = oklab_to_linear_rgb(L, a, b)
    return (
        max(0, min(255, round(_linear_to_srgb(rl) * 255))),
        max(0, min(255, round(_linear_to_srgb(gl) * 255))),
        max(0, min(255, round(_linear_to_srgb(bl) * 255))),
    )


def _in_gamut(linear_rgb, eps=1e-4):
    rl, gl, bl = linear_rgb
    return (-eps <= rl <= 1 + eps
            and -eps <= gl <= 1 + eps
            and -eps <= bl <= 1 + eps)


def gamut_clip_oklab(L, a, b, max_iter=20):
    """Reduce chroma along (L, hue)-const until the result fits in
    sRGB gamut. Bisection: known-in-gamut at chroma=0 (gray of the
    given L), known-out-of-gamut at chroma=current. Always converges.

    Returns (L, new_a, new_b, chroma_scale) where chroma_scale is in
    [0, 1] — 1 means no clipping was needed.
    """
    if _in_gamut(oklab_to_linear_rgb(L, a, b)):
        return L, a, b, 1.0
    lo, hi = 0.0, 1.0
    for _ in range(max_iter):
        mid = (lo + hi) / 2.0
        if _in_gamut(oklab_to_linear_rgb(L, a * mid, b * mid)):
            lo = mid
        else:
            hi = mid
    return L, a * lo, b * lo, lo


# ── Hue transform ───────────────────────────────────────────────────

def apply_shiny(image, phi, eps, theta, chroma_threshold=0.04):
    """Apply h_new = h + φ + ε · sin(h − θ) to every chromatic pixel.

    phi, theta in radians. eps unitless (|eps| < 1 for monotonic).
    Pixels with OKLAB chroma below `chroma_threshold` are preserved
    as-is (outlines, eyewhites, near-grays — no meaningful hue).
    Out-of-gamut results get chroma-clipped back into sRGB rather
    than channel-clamped — avoids the splotchy artifacts the naive
    clamp produces when high-chroma hues rotate into a region sRGB
    can't represent.
    """
    w, h_dim = image.size
    out = Image.new('RGBA', (w, h_dim), (0, 0, 0, 0))
    src = image.load()
    dst = out.load()
    for y in range(h_dim):
        for x in range(w):
            r, g, b, a = src[x, y]
            if a < 200:
                continue
            L, oa, ob = rgb_to_oklab(r, g, b)
            chroma = math.sqrt(oa * oa + ob * ob)
            if chroma < chroma_threshold:
                dst[x, y] = (r, g, b, a)
                continue
            hue = math.atan2(ob, oa)
            new_hue = hue + phi + eps * math.sin(hue - theta)
            new_a = chroma * math.cos(new_hue)
            new_b = chroma * math.sin(new_hue)
            _, ga, gb, _ = gamut_clip_oklab(L, new_a, new_b)
            dst[x, y] = (*oklab_to_rgb(L, ga, gb), a)
    return out


# ── Parameter sampling ──────────────────────────────────────────────

def extract_sprite_test_colors(image, chroma_threshold=0.04, top_n=8,
                                alpha_threshold=200):
    """Pick the sprite's N most-frequent chromatic colors. Used as
    test inputs when scoring candidate shiny parameters — we judge
    a parameter triple by how the SOURCE sprite's palette would look
    after the transform, not against arbitrary test colors."""
    px = image.load()
    w, h_dim = image.size
    counts = {}
    for y in range(h_dim):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < alpha_threshold:
                continue
            L, oa, ob = rgb_to_oklab(r, g, b)
            chroma = math.sqrt(oa * oa + ob * ob)
            if chroma < chroma_threshold:
                continue
            key = (r, g, b)
            counts[key] = counts.get(key, 0) + 1
    sorted_colors = sorted(counts.items(), key=lambda kv: -kv[1])[:top_n]
    return [(rgb, w) for rgb, w in sorted_colors]


def _is_muddy(L, chroma, hue_deg):
    """Heuristic 'this color is unpleasant'. Catches the two zones
    that look ugly across most pixel art:
      - low-chroma + middle lightness: washed-out, no character.
      - dim browns (hue ~30-80°, L < 0.5, chroma < 0.12): dirt, mud.
    Doesn't reject dark colors generally — many sprites have
    legitimate deep shadows."""
    if chroma < 0.04:
        return True
    if 30 <= hue_deg <= 80 and L < 0.50 and chroma < 0.12:
        return True
    return False


def score_shiny_params(test_colors, phi, eps, theta):
    """Score a parameter triple against the sprite's test palette.

    Returns (good, score) where:
      good: bool — True if NO test color is severely clipped or muddy.
            Use this as the rejection gate.
      score: lower is better. Sum of (chroma loss + muddy weight).
             Use this to pick among accepted candidates.

    Severity bounds:
      - reject if any test color needs >65% chroma clip — past that,
        gamut compression visibly muddies the result. The threshold
        is loose enough to ALLOW rotating bright-high-L sprites
        (Charmander's orange at L=0.77) into the harder-to-represent
        blue/purple region, where sRGB only supports moderate chroma
        — those shinies come out slightly muted but still recognizable.
      - reject if any test color lands in the muddy heuristic above.
    """
    total_score = 0.0
    for (rgb, weight) in test_colors:
        L, oa, ob = rgb_to_oklab(*rgb)
        chroma = math.sqrt(oa * oa + ob * ob)
        hue = math.atan2(ob, oa)
        new_hue = hue + phi + eps * math.sin(hue - theta)
        new_a = chroma * math.cos(new_hue)
        new_b = chroma * math.sin(new_hue)
        _, _, _, chroma_scale = gamut_clip_oklab(L, new_a, new_b)
        # Effective chroma after gamut clip.
        eff_chroma = chroma * chroma_scale
        new_hue_deg = math.degrees(new_hue) % 360.0
        if chroma_scale < 0.35:
            return False, float('inf')  # severe gamut compression
        if _is_muddy(L, eff_chroma, new_hue_deg):
            return False, float('inf')
        total_score += (1.0 - chroma_scale) * weight
    return True, total_score


def sample_shiny_params(seed, test_colors, max_attempts=200):
    """Sample (phi, eps, theta) until we find params that don't
    produce muddy / heavily-clipped colors against the sprite's test
    palette. Deterministic from `seed`. Falls back to the last
    attempt if max_attempts is exhausted."""
    rng = random.Random(seed)
    last = None
    for _ in range(max_attempts):
        phi = math.radians(rng.uniform(60, 300))
        eps = rng.uniform(0.0, 0.4)
        theta = math.radians(rng.uniform(0.0, 360.0))
        good, _ = score_shiny_params(test_colors, phi, eps, theta)
        if good:
            return phi, eps, theta
        last = (phi, eps, theta)
    return last


def sample_pure_rotation_params(seed):
    """Vanilla-Pokemon-style pure hue rotation. eps=0 (no wobble),
    theta=0 (irrelevant when eps=0). phi sampled uniformly across
    the full hue wheel — no rejection sampling, no gamut-loss check.
    Per-pixel gamut clipping still applies so we don't get splotchy
    artifacts, but we accept any rotation regardless of how muted
    the result becomes. Used to baseline the constrained-wobble
    approach against the naive one."""
    rng = random.Random(seed)
    phi = math.radians(rng.uniform(30, 330))
    return phi, 0.0, 0.0


# ── 3D perceptual sampling ──────────────────────────────────────────
# "Different shinies should feel different in mood, not just hue."
# Each shiny is a triple (phi, delta_l, kappa) — hue rotation,
# lightness shift, chroma scale. Far apart in this 3D space → far
# apart perceptually.

DELTA_L_RANGE = 0.20       # ±0.20 in OKLAB L (about ±15% perceived).
KAPPA_RANGE = (0.5, 1.5)   # half to 1.5× source saturation.


def apply_shiny_3d(image, phi, delta_l, kappa, chroma_threshold=0.04):
    """Apply 3D perceptual transform:
        L_new = L + delta_l          (clip to [0, 1])
        C_new = C * kappa
        h_new = h + phi
    Per-pixel gamut clipping at the end.

    Structural pixels (low chroma) are preserved as-is — outlines
    don't shift with lightness, eyewhites stay neutral.
    """
    w, h_dim = image.size
    out = Image.new('RGBA', (w, h_dim), (0, 0, 0, 0))
    src = image.load()
    dst = out.load()
    for y in range(h_dim):
        for x in range(w):
            r, g, b, a = src[x, y]
            if a < 200:
                continue
            L, oa, ob = rgb_to_oklab(r, g, b)
            chroma = math.sqrt(oa * oa + ob * ob)
            if chroma < chroma_threshold:
                dst[x, y] = (r, g, b, a)
                continue
            hue = math.atan2(ob, oa)
            new_L = max(0.0, min(1.0, L + delta_l))
            new_chroma = chroma * kappa
            new_hue = hue + phi
            new_a = new_chroma * math.cos(new_hue)
            new_b = new_chroma * math.sin(new_hue)
            _, ga, gb, _ = gamut_clip_oklab(new_L, new_a, new_b)
            dst[x, y] = (*oklab_to_rgb(new_L, ga, gb), a)
    return out


def score_3d_params(test_colors, phi, delta_l, kappa):
    """Reject if any test color would be severely clipped or muddy
    after the (phi, delta_l, kappa) transform."""
    for (rgb, _weight) in test_colors:
        L, oa, ob = rgb_to_oklab(*rgb)
        chroma = math.sqrt(oa * oa + ob * ob)
        hue = math.atan2(ob, oa)
        new_L = max(0.0, min(1.0, L + delta_l))
        new_chroma = chroma * kappa
        new_hue = hue + phi
        new_a = new_chroma * math.cos(new_hue)
        new_b = new_chroma * math.sin(new_hue)
        _, _, _, chroma_scale = gamut_clip_oklab(new_L, new_a, new_b)
        eff_chroma = new_chroma * chroma_scale
        new_hue_deg = math.degrees(new_hue) % 360.0
        if chroma_scale < 0.35:
            return False                       # severe gamut clip
        if eff_chroma < 0.025:
            return False                       # washed out to gray
        if _is_muddy(new_L, eff_chroma, new_hue_deg):
            return False
    return True


def build_synthetic_test_palette():
    """A representative cross-dex palette for universal shiny sampling.

    Just the mid band — 12 hues evenly spaced around the wheel at
    L=0.65, chroma=0.10. That's where most pixel-art sprite pixels
    live; extreme lights and darks are lower-chroma and get handled
    well by per-pixel gamut clipping, so testing them gates too many
    candidates without adding much signal.
    """
    palette = []
    L = 0.65
    chroma = 0.10
    for i in range(12):
        hue_rad = 2 * math.pi * i / 12
        a = chroma * math.cos(hue_rad)
        b = chroma * math.sin(hue_rad)
        rgb = oklab_to_rgb(L, a, b)
        palette.append((rgb, 1))
    return palette


def prepare_test_palette(test_colors):
    """Pre-convert [(rgb, weight)] → [(L, chroma, hue, weight)].

    The OKLAB / polar conversion is invariant across all candidate
    (φ, ΔL, κ) triples we'll score against this palette, so doing it
    once per palette instead of once per (candidate × color) cuts
    most of the inner-loop cost. Big win for the family-pair bake
    where we evaluate ~2000 candidates per pair."""
    prepped = []
    for (rgb, w) in test_colors:
        L, oa, ob = rgb_to_oklab(*rgb)
        chroma = math.sqrt(oa * oa + ob * ob)
        hue = math.atan2(ob, oa)
        prepped.append((L, chroma, hue, w))
    return prepped


def score_3d_params_soft(test_colors, phi, delta_l, kappa):
    """Soft scoring: sum of (chroma-loss + 0.5×muddy-flag) per test
    color. Lower is better. Doesn't reject anything outright — used
    by the universal sampler where we want to RANK candidates rather
    than filter them, so we can still pick the best 12 even if every
    candidate has at least one problem color.

    Accepts either raw [(rgb, weight)] or pre-prepared
    [(L, chroma, hue, weight)] — auto-detected by tuple length."""
    if test_colors and len(test_colors[0]) == 4:
        return score_3d_params_soft_prepped(test_colors, phi, delta_l, kappa)
    return score_3d_params_soft_prepped(
        prepare_test_palette(test_colors), phi, delta_l, kappa)


def score_3d_params_soft_prepped(prepped, phi, delta_l, kappa):
    total = 0.0
    for (L, chroma, hue, _w) in prepped:
        new_L = max(0.0, min(1.0, L + delta_l))
        new_chroma = chroma * kappa
        new_hue = hue + phi
        new_a = new_chroma * math.cos(new_hue)
        new_b = new_chroma * math.sin(new_hue)
        _, _, _, chroma_scale = gamut_clip_oklab(new_L, new_a, new_b,
                                                  max_iter=10)
        eff_chroma = new_chroma * chroma_scale
        new_hue_deg = math.degrees(new_hue) % 360.0
        total += (1.0 - chroma_scale)
        if _is_muddy(new_L, eff_chroma, new_hue_deg):
            total += 0.5
    return total


_UNIVERSAL_SHINY_PARAMS_CACHE = None


def get_universal_shiny_params(n=12, seed=0,
                                candidate_pool=2000,
                                ranked_pool=200):
    """Compute (and cache) the universal N shiny transformations.

    Deterministic from `seed` — same params every run. These are the
    triples we'd freeze into a JS constant for the runtime shiny
    transform: one of them gets applied per shiny encounter, picked
    uniformly at catch time.

    Algorithm:
      1. Generate `candidate_pool` random triples.
      2. Score each against a cross-dex synthetic palette (soft score).
      3. Keep the top `ranked_pool` by lowest score.
      4. Farthest-point sample N from those, in normalized space.
    """
    global _UNIVERSAL_SHINY_PARAMS_CACHE
    if _UNIVERSAL_SHINY_PARAMS_CACHE is not None:
        return _UNIVERSAL_SHINY_PARAMS_CACHE

    test_colors = build_synthetic_test_palette()
    rng = random.Random(seed)
    log_kappa_max = math.log(KAPPA_RANGE[1])

    # Generate + score candidates.
    scored = []
    for _ in range(candidate_pool):
        phi = rng.uniform(-math.pi, math.pi)
        delta_l = rng.uniform(-DELTA_L_RANGE, DELTA_L_RANGE)
        kappa = rng.uniform(*KAPPA_RANGE)
        score = score_3d_params_soft(test_colors, phi, delta_l, kappa)
        scored.append((score, (phi, delta_l, kappa)))
    scored.sort(key=lambda s: s[0])
    candidates = [p for _, p in scored[:ranked_pool]]

    # Farthest-point sample, starting from identity.
    def normalize(p):
        phi, dl, kp = p
        return (math.cos(phi), math.sin(phi),
                dl / DELTA_L_RANGE, math.log(kp) / log_kappa_max)

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

    _UNIVERSAL_SHINY_PARAMS_CACHE = selected
    return selected


def sample_3d_shiny_params_set(n, seed, test_colors,
                                candidate_pool=500, max_attempts=2000):
    """Farthest-point sample N triples in normalized perceptual space.

    Steps:
      1. Generate up to `candidate_pool` random triples that PASS the
         rejection check.
      2. From those, iteratively pick the one farthest from the
         running set (starting set = {identity = no transform}).

    Normalized coords for distance:
      - phi → (cos phi, sin phi)  — circular, so phi=π and phi=-π
                                     are the same point.
      - delta_l → delta_l / DELTA_L_RANGE  in [-1, 1]
      - kappa → log(kappa)/log(KAPPA_MAX)  in [~-1, 1]
    Identity = (1, 0, 0, 0) in this 4D space.

    Returns a list of n (phi, delta_l, kappa) tuples, ordered by
    selection order (the first is the most-different-from-identity,
    each subsequent is most-different-from-prior-selections).
    """
    rng = random.Random(seed)
    candidates = []
    attempts = 0
    log_kappa_max = math.log(KAPPA_RANGE[1])

    while len(candidates) < candidate_pool and attempts < max_attempts:
        attempts += 1
        phi = rng.uniform(-math.pi, math.pi)
        delta_l = rng.uniform(-DELTA_L_RANGE, DELTA_L_RANGE)
        kappa = rng.uniform(*KAPPA_RANGE)
        if score_3d_params(test_colors, phi, delta_l, kappa):
            candidates.append((phi, delta_l, kappa))

    def normalize(p):
        phi, dl, kp = p
        return (
            math.cos(phi),
            math.sin(phi),
            dl / DELTA_L_RANGE,
            math.log(kp) / log_kappa_max,
        )

    def dist_sq(a, b):
        return sum((a[i] - b[i]) ** 2 for i in range(4))

    # Identity = no rotation, no L shift, kappa = 1.
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
        if best_idx < 0:
            break
        chosen = candidates.pop(best_idx)
        selected.append(chosen)
        accepted.append(normalize(chosen))

    return selected


# ── Sheet rendering ─────────────────────────────────────────────────

def _crop_cell(image, cell_id, cell_size=96, cols=10):
    col = cell_id % cols
    row = cell_id // cols
    x = col * cell_size
    y = row * cell_size
    return image.crop((x, y, x + cell_size, y + cell_size))


def render_contact_sheet(image, out_path, n=12, scale=4, mode='wobble'):
    """[original | N shinies in a grid].

    mode:
      'wobble' — constrained rotation + sinusoidal wobble, rejection
                 sampled against the sprite's palette. Param labels:
                 (φ, ε, θ).
      'pure'   — pure uniform hue rotation. eps=0, theta=0. No
                 rejection sampling. Param labels: (φ).
      '3d'     — full 3D perceptual transform (hue + lightness +
                 chroma) with farthest-point sampling so the 12
                 shinies feel maximally distinct from each other and
                 the original. Param labels: (φ, ΔL, κ).
    """
    cols = math.ceil(math.sqrt(n))
    rows = math.ceil(n / cols)

    cell_w, cell_h = image.size
    sw, sh = cell_w * scale, cell_h * scale

    label_h = 14
    gap = 8
    pad = 12

    tile_h = sh + label_h
    grid_w = sw * cols + gap * (cols - 1)
    grid_h = tile_h * rows + gap * (rows - 1)
    canvas_w = sw + gap * 2 + grid_w + pad * 2
    canvas_h = max(sh, grid_h) + pad * 2

    canvas = Image.new('RGBA', (canvas_w, canvas_h), (28, 28, 28, 255))
    draw = ImageDraw.Draw(canvas)

    # Extract test colors once. The constrained samplers use these
    # to reject param triples that would muddy / clip the sprite's
    # dominant hues. Pure and universal modes skip this step (the
    # universal set was sampled against a cross-dex synthetic palette).
    test_colors = (extract_sprite_test_colors(image)
                   if mode in ('wobble', '3d') else None)

    # Pre-compute the 3D set since farthest-point sampling produces a
    # full ordered list at once (rather than one-per-index like the
    # other modes). `universal` uses the cached cross-dex set instead
    # of per-sprite sampling, so the same 12 transformations apply
    # everywhere — the candidate for production baking.
    three_d_set = None
    if mode == '3d':
        three_d_set = sample_3d_shiny_params_set(n, seed=0,
                                                  test_colors=test_colors)
        while len(three_d_set) < n:
            three_d_set.append((0.0, 0.0, 1.0))
    elif mode == 'universal':
        three_d_set = get_universal_shiny_params(n=n)
        while len(three_d_set) < n:
            three_d_set.append((0.0, 0.0, 1.0))

    # Original tile (vertically centered).
    orig_y = (canvas_h - sh) // 2
    canvas.paste(image.resize((sw, sh), Image.NEAREST), (pad, orig_y))
    draw.text((pad + 4, orig_y - 12), mode, fill=(180, 180, 180, 255))

    # Shinies grid.
    x0 = pad + sw + gap * 2
    y0 = (canvas_h - grid_h) // 2
    for i in range(n):
        if mode == 'pure':
            phi, eps, theta = sample_pure_rotation_params(i)
            shiny = apply_shiny(image, phi, eps, theta)
            label = f'#{i:02d}  φ={math.degrees(phi):.0f}°'
        elif mode == '3d' or mode == 'universal':
            phi, delta_l, kappa = three_d_set[i]
            shiny = apply_shiny_3d(image, phi, delta_l, kappa)
            label = (f'#{i:02d}  φ={math.degrees(phi):+.0f}°  '
                     f'ΔL={delta_l:+.2f}  κ={kappa:.2f}')
        else:  # wobble
            phi, eps, theta = sample_shiny_params(i, test_colors)
            shiny = apply_shiny(image, phi, eps, theta)
            label = (f'#{i:02d}  φ={math.degrees(phi):.0f}°  '
                     f'ε={eps:.2f}  θ={math.degrees(theta):.0f}°')
        scaled = shiny.resize((sw, sh), Image.NEAREST)
        col = i % cols
        row = i // cols
        sx = x0 + col * (sw + gap)
        sy = y0 + row * (tile_h + gap)
        canvas.paste(scaled, (sx, sy))
        draw.text((sx, sy + sh + 1), label, fill=(160, 160, 160, 255))

    canvas.save(out_path)


# ── CLI ─────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument('paths', nargs='+', help='Sprite PNG file(s)')
    ap.add_argument('--cell', type=int, default=None,
                    help='Crop cell N from a 10×16 PIF sheet')
    ap.add_argument('--n', type=int, default=12,
                    help='Number of shiny variants to generate (default 12)')
    ap.add_argument('--scale', type=int, default=4,
                    help='Upscale factor for output (default 4)')
    ap.add_argument('--out-dir', type=Path, default=Path('probe-output'),
                    help='Where to write contact sheets')
    ap.add_argument('--mode', choices=['wobble', 'pure', '3d', 'universal'],
                    default='wobble',
                    help='Shiny sampler: wobble (rotation+sin wobble, '
                         'per-sprite rejection sampled); pure (φ-only '
                         'uniform); 3d (hue+lightness+chroma, per-'
                         'sprite farthest-point); universal (same 12 '
                         'transforms applied to every sprite — sampled '
                         'once against a synthetic cross-dex palette, '
                         'candidate for production bake).')
    ap.add_argument('--dump-universal', action='store_true',
                    help='Print the universal 12 (φ, ΔL, κ) triples '
                         'to stdout, formatted for pasting into a JS '
                         'constant. Skip image processing.')
    args = ap.parse_args()

    if args.dump_universal:
        params = get_universal_shiny_params(n=args.n)
        print('// Universal shiny transforms — paste into JS module.')
        print('const SHINY_TRANSFORMS = [')
        for i, (phi, dl, kp) in enumerate(params):
            print(f'  {{ phi: {phi:+.6f}, deltaL: {dl:+.4f}, kappa: {kp:.4f} }},'
                  f'  // φ={math.degrees(phi):+.0f}°  ΔL={dl:+.2f}  κ={kp:.2f}')
        print('];')
        return
    args.out_dir.mkdir(parents=True, exist_ok=True)

    for path_str in args.paths:
        path = Path(path_str)
        if not path.is_file():
            print(f'skip: {path} (not found)', file=sys.stderr)
            continue
        image = Image.open(path).convert('RGBA')
        if args.cell is not None:
            image = _crop_cell(image, args.cell)
        stem = path.stem if args.cell is None else f'{path.stem}-cell{args.cell}'
        suffix = '' if args.mode == 'wobble' else f'-{args.mode}'
        out = args.out_dir / f'shiny-{stem}{suffix}.png'
        render_contact_sheet(image, out, n=args.n, scale=args.scale,
                             mode=args.mode)
        print(f'{path.name}'
              f'{f" cell{args.cell}" if args.cell is not None else ""}'
              f' [{args.mode}]: {args.n} shinies → {out.name}')


if __name__ == '__main__':
    main()
