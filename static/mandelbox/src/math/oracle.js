// oracle.js — exact deep-zoom ground truth for one point.
//
// Runs the full Mandelbox orbit of c in BigInt fixed point (no reference, no
// deltas — every iterate exact at 2^-prec) and accumulates the scalar
// derivative dr in floatexp from the exact per-iteration data. Slow — this
// exists to validate the perturbation engine, and later to spot-check
// rendered pixels, exactly like fractals2's escapeBigInt oracle.
//
// The iteration/DE conventions (stage order, dr update, escape test on the
// NEW |Z|², DE = r/dr) mirror perturb.js step for step so results are
// directly comparable: any disagreement is a perturbation bug, not a
// convention mismatch.

import { bigToFe, toDouble } from './bignum.js';
import { mbCtx, bigStep, SCALE, SPH_LIN, SPH_INV } from './mandelbox.js';
import { fe, feMulD, feAddD, feSqrt, feDiv, feCopy } from './floatexp.js';

// c: { x, y, z: BigInt }, prec, maxIter.
// Returns { n, interior, de: floatexp, r: floatexp, dr: floatexp }.
export function oracleDE(c, prec, maxIter, trace = null) {
  const ctx = mbCtx(prec);
  let Zx = 0n, Zy = 0n, Zz = 0n;
  const dr = fe(1, 0);
  const r = fe(0, 0), de = fe(0, 0);

  for (let n = 1; n <= maxIter; n++) {
    const st = bigStep(Zx, Zy, Zz, c.x, c.y, c.z, ctx);

    // k from the exact ρ² (in SPH_INV, ρ² ∈ [¼,1) so the double conversion
    // keeps full relative precision).
    const k = st.reg === SPH_LIN ? 4 : (st.reg === SPH_INV ? 1 / toDouble(st.rho2, prec) : 1);
    feMulD(dr, dr, SCALE * k);
    feAddD(dr, dr, 1);

    Zx = st.nx; Zy = st.ny; Zz = st.nz;
    if (trace) trace(n, st, dr);

    if (st.z2 > ctx.BAIL) {
      feSqrt(r, bigToFe(st.z2, prec));
      feDiv(de, r, dr);
      return { n, interior: false, de, r, dr };
    }
  }
  feSqrt(r, bigToFe(mulAbs2(Zx, Zy, Zz, prec), prec));
  return { n: maxIter, interior: true, de, r, dr };
}

function mulAbs2(x, y, z, prec) {
  const P = BigInt(prec);
  return ((x * x + y * y + z * z) >> P);
}

// Escape-only variant (no dr bookkeeping) for boundary bisection: returns the
// escape iteration, or 0 if c did not escape within maxIter.
export function oracleEscapes(c, prec, maxIter) {
  const ctx = mbCtx(prec);
  let Zx = 0n, Zy = 0n, Zz = 0n;
  for (let n = 1; n <= maxIter; n++) {
    const st = bigStep(Zx, Zy, Zz, c.x, c.y, c.z, ctx);
    Zx = st.nx; Zy = st.ny; Zz = st.nz;
    if (st.z2 > ctx.BAIL) return n;
  }
  return 0;
}
