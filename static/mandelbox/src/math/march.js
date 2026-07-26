// march.js — δ-space raymarching over the Mandelbox perturbation engine.
//
// Everything positional is CAMERA-RELATIVE to the high-precision anchor C
// (the reference orbit's center): ray origins are floatexp vec3 offsets from
// C, march distances t are floatexp, and each sample's δc = origin + t·dir
// feeds perturbDE directly. Ray DIRECTIONS are plain doubles — at 2^-1000
// zoom the whole frustum spans ~2^-990, so directions need no extended range,
// only positions do.
//
// Sphere tracing with a distance cone: a sample counts as a hit when
// DE ≤ max(pixFactor·t, epsAbs) — pixFactor·t is the pixel footprint at
// distance t, epsAbs the floor near t=0. Each DE evaluation passes a dr-cap
// derived from the current epsilon, so points at/inside the surface stop
// iterating as soon as DE is provably below resolution instead of running to
// maxIter (see perturb.js).
//
// The chaotic-tail DE noise documented in the README is handled the standard
// raymarcher way: a relax factor < 1 on every step.
//
// marchRayDouble/renderRowsDouble are the same algorithm in plain doubles
// over mandelboxDEDouble — the shallow-zoom path and the cross-check target
// for tests (identical constants ⇒ directly comparable outputs).

import { fe, feCopy, feSetD, feAdd, feMulD, feCmp, feToD } from './floatexp.js';
import { perturbDE, makePerturbScratch } from './perturb.js';
import { mandelboxDEDouble } from './mandelbox.js';

// --- small double vec3 helpers (directions/basis only) ---
function norm3(v) { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; }
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

// Camera: offset (floatexp vec3, camera − C), look direction + plane scale
// (doubles). planeScale = tan(fov/2): the image plane spans ±planeScale at
// unit distance.
export function makeCamera(offset, lookDir, planeScale) {
  const fwd = norm3(lookDir);
  let upHint = Math.abs(fwd[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
  const right = norm3(cross3(fwd, upHint));
  const up = cross3(right, fwd);
  return { o: offset, fwd, right, up, planeScale };
}

// One ray. o: floatexp vec3 (origin − C); dir: unit double[3].
// opts: { maxIter, maxSteps, relax, pixFactor, epsAbs (fe), tMax (fe),
//         scratch (shared perturb scratch) }
// Returns { hit, t (fresh fe), steps, iters }.
export function marchRay(ref, o, dir, opts) {
  const { maxIter, maxSteps = 256, relax = 0.85, pixFactor, epsAbs, tMax } = opts;
  const scratch = opts.scratch || makePerturbScratch();
  const t = fe(), TT = fe(), HEPS = fe();
  const P = { x: fe(), y: fe(), z: fe() };
  let iters = 0;
  for (let step = 1; step <= maxSteps; step++) {
    feMulD(TT, t, dir[0]); feAdd(P.x, o[0], TT);
    feMulD(TT, t, dir[1]); feAdd(P.y, o[1], TT);
    feMulD(TT, t, dir[2]); feAdd(P.z, o[2], TT);
    feMulD(HEPS, t, pixFactor);
    if (feCmp(HEPS, epsAbs) < 0) feCopy(HEPS, epsAbs);
    const r = perturbDE(ref, P, maxIter, { scratch, drCapE: 12 - HEPS.e });
    iters += r.n;
    if (r.interior || r.capped || feCmp(r.de, HEPS) <= 0) {
      return { hit: true, t, steps: step, iters };
    }
    feMulD(TT, r.de, relax); feAdd(t, t, TT);
    if (feCmp(t, tMax) > 0) return { hit: false, t, steps: step, iters };
  }
  // Step budget exhausted: the ray is creeping through the fog crust hugging
  // the surface (DE is escape-time-quantized, see renderSpan). Treat as a hit
  // — AO shading darkens it like a crevice; returning a miss instead punches
  // background-colored speckle into lit surfaces.
  return { hit: true, t, steps: maxSteps, iters };
}

// Surface normal via the tetrahedron gradient of DE at p (floatexp vec3),
// probe radius h (fe). Returns a unit double[3], or null if degenerate
// (deep inside / all probes capped) — caller falls back to -dir.
const TETRA = [[1, -1, -1], [-1, -1, 1], [-1, 1, -1], [1, 1, 1]];
export function normalAt(ref, p, h, maxIter, scratch) {
  const Q = { x: fe(), y: fe(), z: fe() }, TT = fe();
  const de = [fe(), fe(), fe(), fe()];
  const drCapE = 22 - h.e; // resolve DE down to ~h·2^-10
  for (let k = 0; k < 4; k++) {
    feMulD(TT, h, TETRA[k][0]); feAdd(Q.x, p.x, TT);
    feMulD(TT, h, TETRA[k][1]); feAdd(Q.y, p.y, TT);
    feMulD(TT, h, TETRA[k][2]); feAdd(Q.z, p.z, TT);
    const r = perturbDE(ref, Q, maxIter, { scratch, drCapE });
    if (r.interior || r.capped) feSetD(de[k], 0);
    else feCopy(de[k], r.de);
  }
  const N = [fe(), fe(), fe()];
  for (let i = 0; i < 3; i++) {
    feMulD(N[i], de[0], TETRA[0][i]);
    for (let k = 1; k < 4; k++) { feMulD(TT, de[k], TETRA[k][i]); feAdd(N[i], N[i], TT); }
  }
  let emax = -Infinity;
  for (let i = 0; i < 3; i++) if (N[i].m !== 0 && N[i].e > emax) emax = N[i].e;
  if (emax === -Infinity) return null;
  const v = [0, 1, 2].map((i) => N[i].m === 0 ? 0 : N[i].m * 2 ** (N[i].e - emax));
  const l = Math.hypot(v[0], v[1], v[2]);
  if (!isFinite(l) || l < 1e-12) return null;
  return [v[0] / l, v[1] / l, v[2] / l];
}

// March pixels [x0, x1) of row j in a W×H frame, writing into caller-provided
// output arrays at offset `off`. This is the INTERRUPTIBLE unit: workers call
// it in small spans with an event-loop yield between spans so a cancel
// message can abort a render mid-chunk. Requires opts.scratch.
// Returns { iters, evals, degen }.
export function renderSpan(ref, cam, W, H, j, x0, x1, opts, out, off) {
  const aspect = W / H;
  // Hit-cone constant. DE = r/dr is escape-time-quantized (any point escaping
  // at iteration n reads ≲ 2^12/2^n regardless of true distance), so callers
  // may pass a pixFactor tighter than the raw pixel footprint to keep the
  // near-set "fog floor" from reading as surface.
  const pixFactor = opts.pixFactor !== undefined ? opts.pixFactor : 2 * cam.planeScale / H;
  const mopts = { ...opts, pixFactor };
  const P = { x: fe(), y: fe(), z: fe() }, TT = fe(), HFE = fe();
  const sy = (1 - 2 * (j + 0.5) / H) * cam.planeScale;
  let iters = 0, evals = 0, degen = 0;
  for (let i = x0; i < x1; i++) {
    const sx = (2 * (i + 0.5) / W - 1) * cam.planeScale * aspect;
    const dir = norm3([
      cam.fwd[0] + sx * cam.right[0] + sy * cam.up[0],
      cam.fwd[1] + sx * cam.right[1] + sy * cam.up[1],
      cam.fwd[2] + sx * cam.right[2] + sy * cam.up[2],
    ]);
    const r = marchRay(ref, cam.o, dir, mopts);
    iters += r.iters; evals += r.steps;
    const idx = off + (i - x0);
    out.steps[idx] = r.steps;
    if (!r.hit) { out.hit[idx] = 0; continue; }
    out.hit[idx] = 1;
    out.tlog[idx] = r.t.m === 0 ? -1e9 : Math.log2(Math.abs(r.t.m)) + r.t.e;
    // Hit point + normal (probe radius = half the local epsilon).
    feMulD(TT, r.t, dir[0]); feAdd(P.x, cam.o[0], TT);
    feMulD(TT, r.t, dir[1]); feAdd(P.y, cam.o[1], TT);
    feMulD(TT, r.t, dir[2]); feAdd(P.z, cam.o[2], TT);
    feMulD(HFE, r.t, pixFactor * 0.5);
    if (feCmp(HFE, opts.epsAbs) < 0) feCopy(HFE, opts.epsAbs);
    const n = normalAt(ref, P, HFE, opts.maxIter, opts.scratch);
    if (!n) degen++;
    const nn = n || [-dir[0], -dir[1], -dir[2]];
    out.nx[idx] = nn[0]; out.ny[idx] = nn[1]; out.nz[idx] = nn[2];
  }
  return { iters, evals, degen };
}

// Render scanline rows [y0, y1) of a W×H frame in one call (renderSpan loop).
// Worker-friendly: plain typed arrays out, no shading policy.
// Returns { y0, y1, hit (Uint8), nx/ny/nz (Float32), steps (Uint16),
//           tlog (Float32, log2 of hit distance), stats }.
export function renderRows(ref, cam, W, H, y0, y1, opts) {
  const rows = y1 - y0;
  const out = {
    hit: new Uint8Array(W * rows),
    nx: new Float32Array(W * rows), ny: new Float32Array(W * rows), nz: new Float32Array(W * rows),
    steps: new Uint16Array(W * rows),
    tlog: new Float32Array(W * rows),
  };
  const o2 = opts.scratch ? opts : { ...opts, scratch: makePerturbScratch() };
  const stats = { iters: 0, evals: 0, degen: 0 };
  for (let j = y0; j < y1; j++) {
    const st = renderSpan(ref, cam, W, H, j, 0, W, o2, out, (j - y0) * W);
    stats.iters += st.iters; stats.evals += st.evals; stats.degen += st.degen;
  }
  return { y0, y1, ...out, stats };
}

// --- plain-double twin (shallow zoom + cross-check oracle) ---

export function marchRayDouble(camPos, dir, opts) {
  const { maxIter, maxSteps = 256, relax = 0.85, pixFactor, epsAbsD, tMaxD } = opts;
  let t = 0, iters = 0;
  for (let step = 1; step <= maxSteps; step++) {
    const px = camPos[0] + t * dir[0], py = camPos[1] + t * dir[1], pz = camPos[2] + t * dir[2];
    const r = mandelboxDEDouble(px, py, pz, maxIter);
    iters += r.n;
    const de = r.interior ? 0 : r.de;
    const heps = Math.max(pixFactor * t, epsAbsD);
    if (de <= heps) return { hit: true, t, steps: step, iters };
    t += de * relax;
    if (t > tMaxD) return { hit: false, t, steps: step, iters };
  }
  return { hit: true, t, steps: maxSteps, iters }; // fog crust — see marchRay
}

export function normalAtDouble(camPos, px, py, pz, h, maxIter) {
  const d = TETRA.map((k) => {
    const r = mandelboxDEDouble(px + h * k[0], py + h * k[1], pz + h * k[2], maxIter);
    return r.interior ? 0 : r.de;
  });
  const v = [0, 1, 2].map((i) => d[0] * TETRA[0][i] + d[1] * TETRA[1][i] + d[2] * TETRA[2][i] + d[3] * TETRA[3][i]);
  const l = Math.hypot(v[0], v[1], v[2]);
  if (!isFinite(l) || l < 1e-30) return null;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function renderRowsDouble(camPos, cam, W, H, y0, y1, opts) {
  const rows = y1 - y0;
  const hit = new Uint8Array(W * rows);
  const nx = new Float32Array(W * rows), ny = new Float32Array(W * rows), nz = new Float32Array(W * rows);
  const steps = new Uint16Array(W * rows);
  const tlog = new Float32Array(W * rows);
  const aspect = W / H;
  const pixFactor = opts.pixFactor !== undefined ? opts.pixFactor : 2 * cam.planeScale / H;
  const mopts = { ...opts, pixFactor };
  for (let j = y0; j < y1; j++) {
    const sy = (1 - 2 * (j + 0.5) / H) * cam.planeScale;
    for (let i = 0; i < W; i++) {
      const sx = (2 * (i + 0.5) / W - 1) * cam.planeScale * aspect;
      const dir = norm3([
        cam.fwd[0] + sx * cam.right[0] + sy * cam.up[0],
        cam.fwd[1] + sx * cam.right[1] + sy * cam.up[1],
        cam.fwd[2] + sx * cam.right[2] + sy * cam.up[2],
      ]);
      const r = marchRayDouble(camPos, dir, mopts);
      const idx = (j - y0) * W + i;
      steps[idx] = r.steps;
      if (!r.hit) continue;
      hit[idx] = 1;
      tlog[idx] = r.t > 0 ? Math.log2(r.t) : -1e9;
      const h = Math.max(pixFactor * r.t * 0.5, opts.epsAbsD);
      const n = normalAtDouble(camPos,
        camPos[0] + r.t * dir[0], camPos[1] + r.t * dir[1], camPos[2] + r.t * dir[2], h, opts.maxIter);
      const nn = n || [-dir[0], -dir[1], -dir[2]];
      nx[idx] = nn[0]; ny[idx] = nn[1]; nz[idx] = nn[2];
    }
  }
  return { y0, y1, hit, nx, ny, nz, steps, tlog, stats: {} };
}
