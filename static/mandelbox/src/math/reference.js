// reference.js — high-precision Mandelbox reference orbit for perturbation.
//
// Given a center C as fixed-point BigInts at precision `prec`, iterate the
// Mandelbox in exact fixed point and export everything the perturbation
// engine (perturb.js) needs:
//
//   Z_n            as doubles — O(bailout) magnitude, full relative precision.
//   fold residuals as FLOATEXP — this is the load-bearing difference from the
//                  2D engines. The Mandelbrot rebase test only ever compares
//                  against Z (fine in doubles), but Mandelbox region decisions
//                  compare the perturbed point against fold planes at ±1 and
//                  sphere shells at ρ²=¼,1 — O(1) surfaces where a double
//                  export would cap ABSOLUTE precision at ~2^-53. A δ ~ 2^-1000
//                  crossing decision needs the reference's distance-to-plane
//                  at δ's own scale, so we compute the residuals in BigInt
//                  (exact) and export them via bigToFe (53 significant bits at
//                  any magnitude).
//
// Per iteration n (stage arrays, valid for n = 0..len-1, describing the step
// Z_n → Z_{n+1}):
//   boxReg[3n+i]  region of Z_n component i: -1 (below −1), 0 (mid), 1 (above +1)
//   u[3n+i]       1 − Z_i   (floatexp as uM/uE pair) — distance below the +1 plane
//   w[3n+i]       Z_i + 1   (floatexp as wM/wE pair) — distance above the −1 plane
//   bx/by/bz[n]   B = boxFold(Z_n) as doubles
//   rho2[n]       |B|² as double (only ever used at O(1) scale)
//   sphReg[n]     sphere region of B: SPH_LIN / SPH_INV / SPH_ID
//   rM[n]         |B|² − ¼  (floatexp rMM/rME)
//   rF[n]         |B|² − 1  (floatexp rFM/rFE)

import { toDouble, bigToFe } from './bignum.js';
import { mbCtx, bigStep } from './mandelbox.js';

// center: { x, y, z: BigInt, prec }.  Returns the orbit object described
// above plus { len, escaped }: Z_0..Z_len are valid (Z_0 = 0), stage arrays
// cover n = 0..len-1, `escaped` says |Z_len| passed the bailout.
export function computeMbReference(center, maxIter, onProgress) {
  const { x: cx, y: cy, z: cz, prec } = center;
  const ctx = mbCtx(prec);
  const cap = maxIter;

  const zx = new Float64Array(cap + 1), zy = new Float64Array(cap + 1), zz = new Float64Array(cap + 1);
  const boxReg = new Int8Array(3 * cap);
  const uM = new Float64Array(3 * cap), uE = new Int32Array(3 * cap);
  const wM = new Float64Array(3 * cap), wE = new Int32Array(3 * cap);
  const bx = new Float64Array(cap), by = new Float64Array(cap), bz = new Float64Array(cap);
  const rho2 = new Float64Array(cap);
  const sphReg = new Int8Array(cap);
  const rMM = new Float64Array(cap), rME = new Int32Array(cap);
  const rFM = new Float64Array(cap), rFE = new Int32Array(cap);

  let Zx = 0n, Zy = 0n, Zz = 0n; // Z_0 = 0
  let len = 0, escaped = false;

  for (let n = 0; n < maxIter; n++) {
    // Box-plane residuals + regions of Z_n, exact then exported as floatexp.
    const comps = [Zx, Zy, Zz];
    for (let i = 0; i < 3; i++) {
      const t = comps[i];
      const u = bigToFe(ctx.ONE - t, prec);   // 1 − Z_i
      const w = bigToFe(t + ctx.ONE, prec);   // Z_i + 1
      const j = 3 * n + i;
      uM[j] = u.m; uE[j] = u.e;
      wM[j] = w.m; wE[j] = w.e;
      boxReg[j] = t > ctx.ONE ? 1 : (t < -ctx.ONE ? -1 : 0);
    }

    const st = bigStep(Zx, Zy, Zz, cx, cy, cz, ctx);

    bx[n] = toDouble(st.bx, prec); by[n] = toDouble(st.by, prec); bz[n] = toDouble(st.bz, prec);
    rho2[n] = toDouble(st.rho2, prec);
    sphReg[n] = st.reg;
    const rM = bigToFe(st.rho2 - ctx.MR2, prec);
    const rF = bigToFe(st.rho2 - ctx.FR2, prec);
    rMM[n] = rM.m; rME[n] = rM.e;
    rFM[n] = rF.m; rFE[n] = rF.e;

    Zx = st.nx; Zy = st.ny; Zz = st.nz;
    zx[n + 1] = toDouble(Zx, prec); zy[n + 1] = toDouble(Zy, prec); zz[n + 1] = toDouble(Zz, prec);
    len = n + 1;

    if (st.z2 > ctx.BAIL) { escaped = true; break; }
    if (onProgress && (n & 255) === 0) onProgress(n, maxIter);
  }

  return {
    prec, len, escaped,
    zx: zx.subarray(0, len + 1), zy: zy.subarray(0, len + 1), zz: zz.subarray(0, len + 1),
    boxReg: boxReg.subarray(0, 3 * len),
    uM: uM.subarray(0, 3 * len), uE: uE.subarray(0, 3 * len),
    wM: wM.subarray(0, 3 * len), wE: wE.subarray(0, 3 * len),
    bx: bx.subarray(0, len), by: by.subarray(0, len), bz: bz.subarray(0, len),
    rho2: rho2.subarray(0, len),
    sphReg: sphReg.subarray(0, len),
    rMM: rMM.subarray(0, len), rME: rME.subarray(0, len),
    rFM: rFM.subarray(0, len), rFE: rFE.subarray(0, len),
  };
}
