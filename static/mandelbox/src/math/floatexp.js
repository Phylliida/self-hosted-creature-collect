// floatexp.js — extended-range floating point for the Mandelbox deep-zoom engine.
//
// A value is m · 2^e with m a double normalized to [1,2) (or 0) and e a JS
// integer. Doubles alone die twice on the way to 2^1000 zooms: pixel deltas
// are ~2^-1010 (edge of normal range) and their squares (|δ|², dot products)
// are ~2^-2020 (underflow to 0). floatexp keeps ~53 bits of mantissa at any
// exponent, which is exactly what perturbation needs — full RELATIVE
// precision on tiny values.
//
// API style: every arithmetic op is MUTATING — feAdd(out, a, b) writes into
// `out` and returns it. The perturbation inner loop runs ~10^5 ops per DE
// evaluation; allocating a result object per op would swamp the GC. Callers
// preallocate temporaries with fe() and reuse them. `out` may alias `a` or
// `b` (every op reads its inputs before writing).

const BUF = new DataView(new ArrayBuffer(8));

// Renormalize x in place so |x.m| ∈ [1,2) (m === 0 ⇒ e = 0). Uses the IEEE
// exponent bits directly (no log2 — exact and fast); the subnormal branch
// pre-scales by 2^200 so exponent extraction works there too.
export function feNorm(x) {
  let m = x.m;
  if (m === 0) { x.e = 0; return x; }
  BUF.setFloat64(0, m);
  let ex = (BUF.getUint16(0) >> 4) & 0x7ff;
  if (ex === 0) { // subnormal mantissa — rescale into normal range first
    m *= 2 ** 200; x.e -= 200;
    BUF.setFloat64(0, m);
    ex = (BUF.getUint16(0) >> 4) & 0x7ff;
  }
  const k = ex - 1023;
  if (k !== 0) { m *= 2 ** -k; x.e += k; }
  x.m = m;
  return x;
}

// Construct a normalized floatexp from mantissa/exponent (both optional).
export function fe(m = 0, e = 0) { return feNorm({ m, e }); }

export function feCopy(o, a) { o.m = a.m; o.e = a.e; return o; }
export function feSetD(o, d) { o.m = d; o.e = 0; return feNorm(o); }
export function feIsZero(a) { return a.m === 0; }
export function feSign(a) { return Math.sign(a.m); }
export function feNeg(o, a) { o.m = -a.m; o.e = a.e; return o; }
export function feAbs(o, a) { o.m = Math.abs(a.m); o.e = a.e; return o; }

// out = a + b. If the exponents differ by more than 60 bits the smaller
// operand is below the rounding error of the larger and is dropped.
export function feAdd(o, a, b) {
  if (a.m === 0) return feCopy(o, b);
  if (b.m === 0) return feCopy(o, a);
  const d = a.e - b.e;
  if (d > 60) return feCopy(o, a);
  if (d < -60) return feCopy(o, b);
  if (d >= 0) { o.m = a.m + b.m * 2 ** -d; o.e = a.e; }
  else { o.m = b.m + a.m * 2 ** d; o.e = b.e; }
  return feNorm(o);
}

const NEGT = { m: 0, e: 0 };
export function feSub(o, a, b) { NEGT.m = -b.m; NEGT.e = b.e; return feAdd(o, a, NEGT); }

export function feMul(o, a, b) { o.m = a.m * b.m; o.e = a.e + b.e; return feNorm(o); }
export function feMulD(o, a, d) { o.m = a.m * d; o.e = a.e; return feNorm(o); }
export function feDiv(o, a, b) { o.m = a.m / b.m; o.e = a.e - b.e; return feNorm(o); }

const ADDT = { m: 0, e: 0 };
export function feAddD(o, a, d) { ADDT.m = d; ADDT.e = 0; feNorm(ADDT); return feAdd(o, a, ADDT); }

// out = sqrt(a), a ≥ 0. Shift to an even exponent so e halves exactly.
export function feSqrt(o, a) {
  if (a.m === 0) { o.m = 0; o.e = 0; return o; }
  let m = a.m, e = a.e;
  if (e & 1) { m *= 2; e -= 1; }
  o.m = Math.sqrt(m); o.e = e >> 1;
  return feNorm(o);
}

// Signed three-way compare: -1, 0, or 1. Relies on normalization (compare
// signs, then exponents, then mantissas).
export function feCmp(a, b) {
  const sa = Math.sign(a.m), sb = Math.sign(b.m);
  if (sa !== sb) return sa < sb ? -1 : 1;
  if (sa === 0) return 0;
  if (a.e !== b.e) return (a.e > b.e ? 1 : -1) * sa;
  return a.m === b.m ? 0 : (a.m > b.m ? 1 : -1) * 1;
}

const CMPT = { m: 0, e: 0 };
export function feCmpD(a, d) { CMPT.m = d; CMPT.e = 0; feNorm(CMPT); return feCmp(a, CMPT); }

// To double. Exponents beyond double range round to 0 / ±Infinity, which is
// the behavior callers want (feToD is only used on O(1)-scale quantities or
// for diagnostics).
export function feToD(a) { return a.m * 2 ** a.e; }

export function feToString(a) { return `${a.m}p${a.e >= 0 ? '+' : ''}${a.e}`; }
