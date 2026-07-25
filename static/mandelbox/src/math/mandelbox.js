// mandelbox.js — the Mandelbox iteration, in exact BigInt fixed point and in
// plain doubles.
//
// Standard scale-2 Mandelbox (Tglad's formula):
//     z_{n+1} = SCALE · sphereFold(boxFold(z_n)) + c ,   z_0 = 0
//   boxFold   (per component, fold limit 1):  t>1 → 2−t ;  t<−1 → −2−t ; else t
//   sphereFold (on ρ² = |v|²):  ρ² < ¼ → v·4 ;  ρ² < 1 → v/ρ² ;  else v
//
// Everything in the iteration is RATIONAL — compares, subtracts, multiplies,
// one division — so the reference orbit and the deep-zoom oracle can run in
// exact fixed point (no sqrt/trig, unlike the Mandelbulb). Both folds are
// CONTINUOUS at their boundaries (2−t = t at t=1; v·4 = v/ρ² at ρ²=¼; v/ρ² = v
// at ρ²=1), which is what makes borderline region classification benign for
// the perturbation engine.
//
// Distance estimate: the classic scalar-derivative DE. boxFold is a reflection
// (norm-preserving), sphereFold scales by k ∈ {4, 1/ρ², 1} (k ≥ 1 always), so
//     dr_{n+1} = SCALE·k_n·dr_n + 1 ,  dr_0 = 1 ,  DE = |z_N| / dr_N  at escape.
// Not a rigorous bound, but the standard raymarching estimator — and for
// oracle-vs-perturbation validation only agreement matters, since both sides
// compute the same quantity.

export const SCALE = 2;          // box scale s
export const BAILOUT2 = 65536;   // escape when |z|² > 2^16  (|z| > 256)

// Sphere-fold region codes shared by all engines.
export const SPH_LIN = 0;  // ρ² < ¼  → ×4
export const SPH_INV = 1;  // ρ² < 1  → ×(1/ρ²)
export const SPH_ID = 2;   // else    → ×1

// --- BigInt fixed-point context -------------------------------------------
// Precomputed constants for a given precision. All step functions are exact
// at 2^-prec (mulShift rounds, divShift truncates — both below guard bits).

import { mulShift, divShift } from './bignum.js';

export function mbCtx(prec) {
  const P = BigInt(prec);
  const ONE = 1n << P;
  return {
    prec, P, ONE,
    TWO: 2n << P,
    MR2: ONE >> 2n,               // ¼
    FR2: ONE,                     // 1
    BAIL: BigInt(BAILOUT2) << P,  // 65536
  };
}

// One component of boxFold in fixed point.
function bigFold(t, ctx) {
  if (t > ctx.ONE) return ctx.TWO - t;
  if (t < -ctx.ONE) return -ctx.TWO - t;
  return t;
}

// One full iteration from Z, returning every intermediate stage the reference
// builder and oracle need:
//   b*    : after boxFold          rho2 : |b|² (fixed point)
//   reg   : sphere-fold region     s*   : after sphereFold
//   n*    : next Z = SCALE·s + c   z2   : |next Z|² (fixed point)
export function bigStep(zx, zy, zz, cx, cy, cz, ctx) {
  const { prec } = ctx;
  const bx = bigFold(zx, ctx), by = bigFold(zy, ctx), bz = bigFold(zz, ctx);
  const rho2 = mulShift(bx, bx, prec) + mulShift(by, by, prec) + mulShift(bz, bz, prec);
  let reg, sx, sy, sz;
  if (rho2 < ctx.MR2) {
    reg = SPH_LIN; sx = bx << 2n; sy = by << 2n; sz = bz << 2n;
  } else if (rho2 < ctx.FR2) {
    reg = SPH_INV;
    sx = divShift(bx, rho2, ctx.prec);
    sy = divShift(by, rho2, ctx.prec);
    sz = divShift(bz, rho2, ctx.prec);
  } else {
    reg = SPH_ID; sx = bx; sy = by; sz = bz;
  }
  const nx = (sx << 1n) + cx, ny = (sy << 1n) + cy, nz = (sz << 1n) + cz; // SCALE = 2
  const z2 = mulShift(nx, nx, prec) + mulShift(ny, ny, prec) + mulShift(nz, nz, prec);
  return { bx, by, bz, rho2, reg, sx, sy, sz, nx, ny, nz, z2 };
}

// --- Plain-double DE (independent implementation) --------------------------
// Deliberately written from the formula, NOT via bigStep, so tests can catch
// convention bugs in the fixed-point path by comparing the two on
// short-escape-time points (where double rounding hasn't been chaotically
// amplified yet). Also the future shallow-zoom renderer path.
export function mandelboxDEDouble(cx, cy, cz, maxIter) {
  let zx = 0, zy = 0, zz = 0, dr = 1;
  for (let n = 1; n <= maxIter; n++) {
    let bx = zx > 1 ? 2 - zx : (zx < -1 ? -2 - zx : zx);
    let by = zy > 1 ? 2 - zy : (zy < -1 ? -2 - zy : zy);
    let bz = zz > 1 ? 2 - zz : (zz < -1 ? -2 - zz : zz);
    const rho2 = bx * bx + by * by + bz * bz;
    let k;
    if (rho2 < 0.25) k = 4;
    else if (rho2 < 1) k = 1 / rho2;
    else k = 1;
    dr = SCALE * k * dr + 1;
    zx = SCALE * k * bx + cx;
    zy = SCALE * k * by + cy;
    zz = SCALE * k * bz + cz;
    const z2 = zx * zx + zy * zy + zz * zz;
    if (z2 > BAILOUT2) {
      const r = Math.sqrt(z2);
      return { n, interior: false, de: r / dr, r, dr };
    }
  }
  return { n: maxIter, interior: true, de: 0, r: Math.sqrt(zx * zx + zy * zy + zz * zz), dr };
}
