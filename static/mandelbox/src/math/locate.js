// locate.js — find a Mandelbox surface point at depth by bisection.
//
// Bisects μ along the ray c(μ) = μ·(dn/16) between an interior seed (μ=0 —
// the origin is a fixed point of the map) and an escaping outer seed, using
// the exact BigInt escape oracle with PROGRESSIVE precision and iteration
// budget: at bracket width 2^-k the predicate runs at ~k+100 bits and ~k+80
// iterations, so early (cheap) steps don't pay deep-zoom cost. All μ values
// are dyadic and every fixed-point conversion below is exact.
//
// "Interior" here means "does not escape within the budget" — exactly the
// property deep-zoom rendering cares about; the returned point's orbit stays
// interesting for ≥ targetBits-ish iterations.

import { oracleEscapes } from './oracle.js';

// dn: dyadic direction numerators over 16 (BigInts, e.g. [13n, 8n, 3n]);
// muMax: outer seed as an integer (c(muMax) must escape — asserted by caller);
// targetBits: bisect the bracket to ~2^-targetBits · muMax;
// prec/maxIter: cap for the deepest predicate calls.
// Returns { c: {x,y,z} BigInt at prec, mu: BigInt, scaleBits } for c(lo).
export function bisectSurface(dn, muMax, targetBits, prec, maxIter) {
  const S = targetBits + 10;
  const cOf = (mu, p) => {
    const sh = BigInt(p) - BigInt(S) - 4n;
    const mk = (d) => sh >= 0n ? (mu * d) << sh : (mu * d) >> -sh;
    return { x: mk(dn[0]), y: mk(dn[1]), z: mk(dn[2]) };
  };
  let lo = 0n;
  let hi = BigInt(muMax) << BigInt(S);
  for (let k = 1; k <= targetBits; k++) {
    const mid = (lo + hi) >> 1n;
    const p = Math.min(prec, k + 100);
    const n = oracleEscapes(cOf(mid, p), p, Math.min(maxIter, k + 80));
    if (n > 0) hi = mid; else lo = mid;
  }
  return { c: cOf(lo, prec), mu: lo, scaleBits: S };
}
