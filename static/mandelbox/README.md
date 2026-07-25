# Mandelbox deep zoom — perturbation core

Deep-zoom (2^1000-class) engine for the **3D Mandelbox** (scale 2), following
the architecture of `static/fractals2` (BigInt reference orbit + low-precision
perturbation + Zhuoran rebasing, oracle-validated). As far as we know nobody
has shipped 3D-fractal perturbation at these depths — existing Mandelbox
renderers top out around double precision (~10^13).

## Status

**Math core: done and validated** (`src/math/`, suite in
`tests/mandelbox-perturb.test.js` — 500 assertions, ~3 s):

- perturbed orbits match the exact BigInt oracle at **machine epsilon
  (~2e-16) per iteration through the entire tracked phase** (~870 iterations
  at depth 2^-1000) around a bisected real surface point;
- every box-fold / sphere-fold region-crossing branch is exercised both by
  engineered near-boundary centers and organically (thousands of crossings);
- escape iteration + DE validated against the oracle on fast-escaping
  references; interior verdicts validated under reduced iteration caps.

**Not yet built:** the raymarcher, workers, and UI (extras bubble).

## How it works

- `floatexp.js` — extended-range floats (mutating API, no per-op allocation).
  δ ~ 2^-1010 sits at the edge of double range and |δ|² is far below it.
- `bignum.js` — fixed-point BigInt reals (copied from fractals2) plus
  `bigToFe`: exports values at full *relative* precision at any magnitude.
- `mandelbox.js` — the iteration (z ← 2·sphereFold(boxFold(z)) + c, z₀ = 0,
  bailout |z|² > 65536, DE = |z|/dr with dr ← 2k·dr + 1). Everything is
  rational, so the reference/oracle run exactly in fixed point.
- `reference.js` — reference orbit. The key trick vs 2D: fold planes live at
  ±1 and ρ² ∈ {¼, 1} — O(1) surfaces where doubles have only absolute 2^-53
  precision — so the builder exports **fold residuals** (1−Zᵢ, Zᵢ+1, ρ²−¼,
  ρ²−1) computed in BigInt and stored as floatexp. Region decisions for a
  δ ~ 2^-1000 perturbation need exactly these.
- `perturb.js` — the delta recurrence. Each (reference region, perturbed
  region) pair reduces to an exact cancellation-free identity in δ and the
  residuals (see the file header). Both folds are continuous at their
  boundaries, so borderline classification is glitch-benign; the one real
  glitch mechanism (|z| ≪ |δ|) is handled by Zhuoran rebasing, and because
  the case identities are exact at ANY δ magnitude, post-rebase operation
  degrades gracefully to direct iteration.
- `oracle.js` — exact full-orbit ground truth (validation + future pixel
  spot-checks).

## Known behavior (not bugs)

After δ grows to O(1) the engine is effectively direct double-class
iteration, and the Mandelbox — unlike the Mandelbrot, which escapes within a
few iterations of divergence — can wander chaotically bounded for ~100
iterations. Forward values then drift from the oracle at λ~2/iter. This is
**backward-stable**: the result is exact for a point displaced ~2^-50 of the
pixel scale, so rendered images are correct; but per-pixel escape counts and
DE carry chaotic-tail noise near the surface. The future raymarcher should
use a conservative DE step factor (standard practice anyway).

## Next steps

1. Raymarcher in δ-space: camera-relative floatexp ray positions, march with
   DE (dr-cap early exit: once dr > r_bailout/needed-resolution the point
   reads as a hit), tetrahedron-gradient normals, simple shading.
2. Workers + progressive tiles (fractals2's worker.js pattern).
3. Navigation: high-precision camera anchor + double orientation; dive speed
   scaled by DE at camera; re-anchor reference on dive.
4. UI + extras bubble ("Fractals 3D"), permalinks with BigInt coords.
5. Perf, later: Mandelbox BLA (the per-case maps are affine in δ within a
   region combo — 3×3-matrix BLA over region-stable runs should skip most of
   the tracked phase).
