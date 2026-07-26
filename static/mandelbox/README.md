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

**Raymarcher: done and validated** (`src/math/march.js`, suite in
`tests/mandelbox-march.test.js`):

- δ-space sphere tracing: floatexp ray origins/distances relative to the
  reference anchor, double directions, cone epsilon (pixel footprint · t),
  dr-cap early exit, tetrahedron-gradient normals;
- pixel-perfect agreement (mask, hit distance, normals) with an independent
  plain-double marcher on a shallow scene, and an exact-oracle spot check at
  depth 2^-650 confirming a marched hit point sits on the surface (oracle DE
  2^-652.8 vs epsilon 2^-652.7);
- `tools/render-demo.mjs` renders PNGs across worker threads with a
  parallel "location scout" (the Mandelbox has big flat fold-faces; candidate
  surface rays are tiny-rendered and scored for visual interest first).
  `renders/mandelbox-2p1040.png` is a 256×192 frame at zoom depth **2^-1040**
  (~10^313×): 3.7M perturbed DE evaluations, 112 s on 44 workers.

Hard-won scene-scaling rules (from testing, they will matter for the app):

- **Standoff rule:** camera at ~2^-(depthBits−7) from the bisected surface
  point. Farther out, every nearby orbit takes many more folds and DE
  collapses tens of bits below the standoff ("foam") — unmarchable.
- **Clearance rule:** the visible scene sits at the scale of the MEASURED DE
  at the camera (often 10-20 bits below standoff in foamy locales); epsilon
  floor and tMax must derive from it, not from the standoff.
- **Camera-relative lights** (key over the shoulder), since world-space light
  directions are meaningless inside the fractal.

**Browser app: working** (`index.html` + `src/app/`, served at
`/static/mandelbox/index.html`; logic suite in `tests/mandelbox-app.test.js`):

- **Controls:** W/S fly forward/back, A/D turn (yaw about the camera's up),
  Space/Shift up/down, Q dive in / E back out (zoom = scale), 0 whole-box
  overview (also the boot view), 1-5 depth presets, T quality toggle,
  G GPU/CPU toggle, H help. All motion scales with
  2^sceneE, and sceneE tracks the MEASURED DE at the camera (probed ~8Hz
  through a render worker), so holding E is an exponential dive with steps
  that shrink as the surface approaches — "increases the scale of
  everything". Interior probes soft-block forward motion (Q always escapes).
- **Quality toggle** (fractals2 Explore/Draw style, persisted): Explore
  renders everything at 1/3 canvas res; Hi-res renders idle frames at canvas
  res with 2×2 supersampling (rendered 2× linear, smooth-downscaled). Moving
  previews are always Explore-res.
- **Interruptible rendering:** workers march each row in adaptive ~60ms pixel
  spans (march.js renderSpan) with an event-loop yield between spans; a
  generation bump broadcasts cancel and aborts in-flight chunks within one
  slice, so movement restarts previews immediately and DE probes never queue
  behind a long render. Protocol (incl. cancellation) is node-tested in
  tests/mandelbox-worker.test.js via the exported createWorkerState.
- **Boot:** a locate worker bisects the surface point at 2^-1040 (first run
  ~10-30s; μ cached in localStorage `cc.mandelbox.locale.v1` → later boots
  reconstruct it exactly and skip straight to the ~1s reference build). The
  camera state persists in `cc.mandelbox.cam.v1`.
- **Rendering:** module render workers (hardwareConcurrency−1, ≤12) each hold
  the reference orbit and serve row jobs + DE probes; coarse preview frames
  while keys are held, adaptive full resolution (~18s budget from a measured
  evals/sec EMA) on idle; chunks shade + blit on arrival (in onmessage, not
  rAF — deliberately, so rendering also completes under headless screenshot
  verification).
- **GPU rendering** (`src/gpu/`, default when WebGL2 + float render targets
  exist; CPU workers remain for probes, fallback, and ground truth): the
  entire perturbation DE — floatexp arithmetic included — runs in GLSL.
  floatexp is vec2(mantissa float32 normalized ±[1,2), exponent carried in a
  float), normalized via floatBitsToInt/intBitsToFloat with exact power-of-two
  scaling, so exponents reach ±2^24 ≫ any zoom. The reference orbit + fold
  residuals live in 7 one-texel-wide RGBA32F/RGBA32I textures; marching is
  progressive (per-pixel state in ping-pong RGBA32F, ~adaptive K DE evals per
  frame targeting ~11ms) with a second pass for tetrahedron normals.
  **Validation** (fractals2 validate.js philosophy, via `?selftest=1&gpucheck=1`
  — renders the idle frame on CPU then GPU and reports agreement): shallow
  scenes pixel-exact (mask/t/normals 100%); deep fog-crust scenes agree on
  the hit mask 100% while t/normals scatter — that is the documented
  backward-stable chaotic-tail noise sampled at 24-bit vs 53-bit mantissas,
  not a defect (the CPU wouldn't match a higher-precision oracle there
  either). 24-bit relative-to-pixel-scale accuracy is the rendering bar.
- **Dev knobs:** `?depth=N` (60..1040) shrinks the bisection for fast boots;
  `?selftest=1` hides the hint overlay, waits for the first clearance probe,
  and chains preview → idle → done from worker messages/MessageChannel
  instead of rAF, so a firefox-headless screenshot (with the delayed-load
  trick — rAF/timers never fire there) captures the app's TRUE idle-quality
  frame; `?gpucheck=1` adds the GPU-vs-CPU comparison; `?preset=1..5` starts
  the selftest at a depth preset; `?tiny=1` shrinks the canvas so deep CPU
  ground-truth frames stay affordable; `?gpu=0` disables the GPU path.
  Headless firefox on this box has real-GPU WebGL2, so all of this runs
  without a browser session (small windows render fastest).
- **Caching note:** module files must not be served stale as a SET (a cached
  old march.js against a new worker.js kills workers with a bare import
  error). run.py serves these subtrees no-store on web, so this only bites
  header-less dev servers.
- Nav core (`src/app/nav.js`) is headless-safe and unit-tested; boot + full
  worker pipeline verified with the repo's firefox-headless screenshot trick
  (delayed-load page holds the load event while workers render).

**Not yet built:** extras bubble ("Fractals 3D"), touch controls, camera
rotation (orientation is fixed per session), permalinks.

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

1. Browser app: canvas UI, in-browser workers (fractals2's worker.js
   pattern), progressive resolution.
2. Navigation: high-precision camera anchor + double orientation; dive speed
   scaled by DE at camera; re-anchor reference on dive (the scout/clearance
   logic in tools/render-demo.mjs is the prototype).
3. UI + extras bubble ("Fractals 3D"), permalinks with BigInt coords.
4. Perf, later: Mandelbox BLA (the per-case maps are affine in δ within a
   region combo — 3×3-matrix BLA over region-stable runs should skip most of
   the tracked phase). Supersampling for the blade edges.
