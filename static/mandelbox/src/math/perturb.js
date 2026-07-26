// perturb.js — floatexp perturbation iteration for the Mandelbox, with
// Zhuoran rebasing.
//
// Given a reference orbit (reference.js) and a per-point delta δc = c − C
// (floatexp vec3, arbitrarily tiny), track δ_n = z_n − Z_{m} through the
// Mandelbox iteration. The map is piecewise "reflect/scale + translate", so
// the delta of one iteration is
//
//     δ' = SCALE · [ SF(BF(Z+δ)) − SF(BF(Z)) ] + δc
//
// computed WITHOUT catastrophic cancellation by exact per-case algebra:
//
//   boxFold  — with u = 1−Z_i, w = Z_i+1 (high-precision residuals from the
//     reference) and eUp = δ−u, eDn = δ+w classifying the perturbed point,
//     every (ref region, z region) pair reduces to a linear expression in
//     δ, u, w — e.g. mid→above is 2u − δ, above→mid is δ − 2u, same-side is
//     ±δ. These are IDENTITIES, not first-order approximations, so they stay
//     exact when δ is large (post-rebase) too.
//
//   sphereFold — with rM = ρ²−¼, rF = ρ²−1 (reference residuals),
//     dρ² = 2B·β + |β|² and eM = rM+dρ², eF = rF+dρ² classifying the
//     perturbed radius, each region pair reduces to a cancellation-free form,
//     e.g. inv→inv:  σ = (β·ρ²_B − B·dρ²) / (ρ²_z·ρ²_B)
//          lin→inv:  σ = (β − 4B·eM) / ρ²_z        (eM = O(β) at a crossing)
//          inv→lin:  σ = 4β + 4B·rM / ρ²_B          (rM = O(β) at a crossing)
//
// Both folds are continuous at their boundaries, so a borderline
// classification (|residual| ~ ulp) changes the result by O(ulp) — region
// decisions are glitch-benign. The one remaining glitch mechanism is the
// classic |z| ≪ |Z| cancellation, handled exactly as in fractals2:
//
//   rebase (Zhuoran): whenever |z'|² < |δ'|² or the reference is exhausted,
//   set δ := z' (true value), m := 0. Z_0 = 0, so this restarts the delta
//   against the orbit start and degrades gracefully to direct iteration —
//   which the exact identities above support at ANY δ magnitude.
//
// The scalar derivative dr uses the TRUE k (from the perturbed ρ²), so the
// returned DE = |z|/dr matches oracle.js step for step.

import { SCALE, BAILOUT2, SPH_LIN, SPH_INV, SPH_ID } from './mandelbox.js';
import {
  fe, feCopy, feSetD, feAdd, feSub, feMul, feMulD, feDiv, feAddD,
  feNeg, feSqrt, feCmp, feCmpD, feSign,
} from './floatexp.js';

// Reusable working state. A raymarch render calls perturbDE ~10^6 times;
// passing one scratch through opts avoids ~30 allocations per call. NOTE:
// with a shared scratch, the returned de/r/dr are views into it — read or
// feCopy them before the next perturbDE call on the same scratch.
export function makePerturbScratch() {
  return {
    d: [fe(), fe(), fe()], beta: [fe(), fe(), fe()], sig: [fe(), fe(), fe()],
    zf: [fe(), fe(), fe()],
    U: fe(), W: fe(), EUP: fe(), EDN: fe(), T1: fe(), T2: fe(), T3: fe(),
    DRHO: fe(), EM: fe(), EF: fe(), RHOZ: fe(), Z2: fe(), D2: fe(),
    R: fe(), DE: fe(), DR: fe(),
  };
}

// One perturbed DE evaluation.
//   ref     : orbit from computeMbReference
//   dc      : { x, y, z } floatexp — c − C, may be any magnitude
//   maxIter : iteration cap (match the oracle's for comparisons)
//   opts:
//     stats   : optional { boxCross, sphCross } — incremented when the
//               perturbed point lands in a different fold region than the
//               reference (lets tests assert crossings were exercised)
//     trace   : optional fn(n, m, zf, d) called once per iteration with the
//               true value and delta (validation hooks)
//     drCapE  : optional exponent — once DR's exponent reaches it, the DE is
//               provably below the caller's resolution (dr grows ≥2×/iter and
//               DE = r/dr with r ≤ ~2^12 at escape), so return early with
//               capped: true, de = 0. The raymarcher's interior/inside-eps
//               fast path.
//     scratch : optional makePerturbScratch() result
// Returns { n, interior, capped, de, r, dr, rebases } (de/r/dr floatexp).
export function perturbDE(ref, dc, maxIter, opts = {}) {
  const { stats = null, trace = null, drCapE = null } = opts;
  const S = opts.scratch || makePerturbScratch();
  const { len, boxReg, uM, uE, wM, wE, bx, by, bz, rho2, sphReg, rMM, rME, rFM, rFE, zx, zy, zz } = ref;
  const { d, beta, sig, zf, U, W, EUP, EDN, T1, T2, T3, DRHO, EM, EF, RHOZ, Z2, D2, R, DE, DR } = S;
  feSetD(d[0], 0); feSetD(d[1], 0); feSetD(d[2], 0);
  feSetD(DR, 1); feSetD(DE, 0); feSetD(R, 0);
  const ZARR = [zx, zy, zz];
  if (len < 1) return { n: 0, interior: true, capped: false, de: DE, r: R, dr: DR, rebases: 0 };

  let m = 0, rebases = 0;

  for (let n = 1; n <= maxIter; n++) {
    // ---- Stage A: boxFold difference β = BF(Z+δ) − BF(Z), per component ----
    for (let i = 0; i < 3; i++) {
      const j = 3 * m + i;
      U.m = uM[j]; U.e = uE[j];
      W.m = wM[j]; W.e = wE[j];
      const di = d[i], bi = beta[i];
      feSub(EUP, di, U);            // z_i − 1
      feAdd(EDN, di, W);            // z_i + 1
      const zReg = feSign(EUP) > 0 ? 1 : (feSign(EDN) < 0 ? -1 : 0);
      const rReg = boxReg[j];
      if (stats && zReg !== rReg) stats.boxCross++;
      if (rReg === 0) {
        if (zReg === 0) feCopy(bi, di);
        else if (zReg === 1) { feMulD(T1, U, 2); feSub(bi, T1, di); }        // 2u − δ
        else { feMulD(T1, W, -2); feSub(bi, T1, di); }                       // −2w − δ
      } else if (rReg === 1) {
        if (zReg === 1) feNeg(bi, di);
        else if (zReg === 0) { feMulD(T1, U, 2); feSub(bi, di, T1); }        // δ − 2u
        else { feAdd(T1, EDN, U); feNeg(T1, T1); feAddD(bi, T1, -2); }       // −2 − eDn − u
      } else {
        if (zReg === -1) feNeg(bi, di);
        else if (zReg === 0) { feMulD(T1, W, 2); feAdd(bi, di, T1); }        // δ + 2w
        else { feSub(T1, W, EUP); feAddD(bi, T1, 2); }                       // 2 − eUp + w
      }
    }

    // ---- Stage B: sphereFold difference σ = SF(B+β) − SF(B) ----
    const Bx = bx[m], By = by[m], Bz = bz[m], r2B = rho2[m];
    // dρ² = 2B·β + |β|²
    feMulD(DRHO, beta[0], 2 * Bx);
    feMulD(T1, beta[1], 2 * By); feAdd(DRHO, DRHO, T1);
    feMulD(T1, beta[2], 2 * Bz); feAdd(DRHO, DRHO, T1);
    feMul(T1, beta[0], beta[0]); feAdd(DRHO, DRHO, T1);
    feMul(T1, beta[1], beta[1]); feAdd(DRHO, DRHO, T1);
    feMul(T1, beta[2], beta[2]); feAdd(DRHO, DRHO, T1);

    EM.m = rMM[m]; EM.e = rME[m]; feAdd(EM, EM, DRHO);   // ρ²_z − ¼
    EF.m = rFM[m]; EF.e = rFE[m]; feAdd(EF, EF, DRHO);   // ρ²_z − 1
    const zSph = feSign(EM) < 0 ? SPH_LIN : (feSign(EF) < 0 ? SPH_INV : SPH_ID);
    const rSph = sphReg[m];
    if (stats && zSph !== rSph) stats.sphCross++;
    feSetD(RHOZ, r2B); feAdd(RHOZ, RHOZ, DRHO);          // ρ²_z (used at O(1) scale only)

    const BD0 = Bx, BD1 = By, BD2 = Bz;
    for (let i = 0; i < 3; i++) {
      const bi = beta[i], si = sig[i], Bi = i === 0 ? BD0 : (i === 1 ? BD1 : BD2);
      if (rSph === zSph) {
        if (rSph === SPH_LIN) feMulD(si, bi, 4);
        else if (rSph === SPH_ID) feCopy(si, bi);
        else { // inv → inv
          feMulD(T1, bi, r2B);
          feMulD(T2, DRHO, Bi);
          feSub(T1, T1, T2);
          feMulD(T3, RHOZ, r2B);
          feDiv(si, T1, T3);
        }
      } else if (rSph === SPH_LIN && zSph === SPH_INV) {
        feMulD(T2, EM, 4 * Bi); feSub(T1, bi, T2); feDiv(si, T1, RHOZ);      // (β − 4B·eM)/ρ²_z
      } else if (rSph === SPH_INV && zSph === SPH_LIN) {
        T2.m = rMM[m]; T2.e = rME[m];
        feMulD(T2, T2, 4 * Bi / r2B); feMulD(T1, bi, 4); feAdd(si, T1, T2);  // 4β + 4B·rM/ρ²_B
      } else if (rSph === SPH_INV && zSph === SPH_ID) {
        T2.m = rFM[m]; T2.e = rFE[m];
        feMulD(T2, T2, Bi / r2B); feAdd(si, bi, T2);                         // β + B·rF/ρ²_B
      } else if (rSph === SPH_ID && zSph === SPH_INV) {
        feMulD(T2, EF, Bi); feSub(T1, bi, T2); feDiv(si, T1, RHOZ);          // (β − B·eF)/ρ²_z
      } else if (rSph === SPH_LIN && zSph === SPH_ID) {
        feSetD(T2, 3 * Bi); feSub(si, bi, T2);                               // β − 3B
      } else { // id → lin
        feMulD(T1, bi, 4); feSetD(T2, 3 * Bi); feAdd(si, T1, T2);            // 4β + 3B
      }
    }

    // dr = SCALE·k·dr + 1 with the TRUE k of the perturbed point.
    const kz = zSph === SPH_LIN ? 4 : (zSph === SPH_ID ? 1 : 1 / (RHOZ.m * 2 ** RHOZ.e));
    feMulD(DR, DR, SCALE * kz);
    feAddD(DR, DR, 1);

    // dr-cap early exit: dr only grows (k ≥ 1), and DE = r/dr with r ≤ ~2^12
    // at escape, so DR.e ≥ drCapE proves DE is below the caller's resolution.
    if (drCapE !== null && DR.e >= drCapE) {
      return { n, interior: false, capped: true, de: DE, r: R, dr: DR, rebases };
    }

    // ---- Stage C: δ' = SCALE·σ + δc ; true value z' = Z_{m+1} + δ' ----
    for (let i = 0; i < 3; i++) {
      feMulD(d[i], sig[i], SCALE);
    }
    feAdd(d[0], d[0], dc.x); feAdd(d[1], d[1], dc.y); feAdd(d[2], d[2], dc.z);

    feAddD(zf[0], d[0], ZARR[0][m + 1]);
    feAddD(zf[1], d[1], ZARR[1][m + 1]);
    feAddD(zf[2], d[2], ZARR[2][m + 1]);

    feMul(Z2, zf[0], zf[0]);
    feMul(T1, zf[1], zf[1]); feAdd(Z2, Z2, T1);
    feMul(T1, zf[2], zf[2]); feAdd(Z2, Z2, T1);

    if (trace) trace(n, m, zf, d);

    if (feCmpD(Z2, BAILOUT2) > 0) {
      feSqrt(R, Z2);
      feDiv(DE, R, DR);
      return { n, interior: false, capped: false, de: DE, r: R, dr: DR, rebases };
    }

    m++;

    feMul(D2, d[0], d[0]);
    feMul(T1, d[1], d[1]); feAdd(D2, D2, T1);
    feMul(T1, d[2], d[2]); feAdd(D2, D2, T1);

    // Zhuoran rebasing: true value fell below the delta (cancellation ahead)
    // or the reference ran out — restart the delta against Z_0 = 0.
    if (m === len || feCmp(Z2, D2) < 0) {
      feCopy(d[0], zf[0]); feCopy(d[1], zf[1]); feCopy(d[2], zf[2]);
      m = 0;
      rebases++;
    }
  }
  return { n: maxIter, interior: true, capped: false, de: DE, r: R, dr: DR, rebases };
}
