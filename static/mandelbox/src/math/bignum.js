// bignum.js — fixed-point high-precision reals using BigInt.
//
// A real value v is stored as a BigInt m with  v = m / 2^prec.
// Core routines (mulShift, toDouble, fromDouble, decimal parsing) are shared
// with static/fractals2/src/math/bignum.js — kept as a copy so the mandelbox
// app stays self-contained. New here: bigToFe (fixed-point → floatexp), which
// is how the reference orbit exports fold-plane residuals at full RELATIVE
// precision no matter how tiny they are (a plain double export would flush
// residuals below 2^-1074 to zero and lose relative precision below 2^-1022).

import { feNorm } from './floatexp.js';

// round((a*b) / 2^prec)  — round-to-nearest (ties toward +inf, negligible bias).
export function mulShift(a, b, prec) {
  const prod = a * b;
  if (prec === 0) return prod;
  const half = 1n << BigInt(prec - 1);
  return (prod + half) >> BigInt(prec);
}

// trunc((a << prec) / b) — fixed-point division a/b. Truncation (not
// round-to-nearest) is fine: the reference carries 60+ guard bits below the
// deepest δ, so a 1-ulp-at-2^-prec slop is invisible to the perturbation.
export function divShift(a, b, prec) {
  return (a << BigInt(prec)) / b;
}

// Convert fixed-point BigInt -> JS double. Handles arbitrarily large prec.
export function toDouble(m, prec) {
  if (m === 0n) return 0;
  if (prec <= 1000) {
    const v = Number(m);
    if (v !== Infinity && v !== -Infinity) return v * Math.pow(2, -prec);
  }
  const neg = m < 0n;
  let a = neg ? -m : m;
  const bits = a.toString(2).length;
  let e = 0;
  if (bits > 60) {
    const s = bits - 60;
    a = a >> BigInt(s);
    e = s;
  }
  const v = Number(a) * Math.pow(2, e - prec);
  return neg ? -v : v;
}

// Convert fixed-point BigInt -> floatexp {m, e} with ~53 significant bits at
// ANY magnitude (this is the residual-export workhorse). Truncates below the
// 53rd bit (≤ 2^-52 relative — the same class as every other rounding here).
export function bigToFe(v, prec) {
  if (v === 0n) return { m: 0, e: 0 };
  const neg = v < 0n;
  let a = neg ? -v : v;
  const bits = a.toString(2).length;
  const shift = bits - 53;
  const mant = shift > 0 ? Number(a >> BigInt(shift)) : Number(a) * 2 ** -shift;
  return feNorm({ m: neg ? -mant : mant, e: shift - prec });
}

// Convert floatexp {m, e} -> fixed-point BigInt at the given prec (inverse of
// bigToFe; exact up to the 53-bit mantissa, which is all a floatexp carries).
export function feToBig(v, prec) {
  if (v.m === 0) return 0n;
  const mant = BigInt(Math.round(v.m * 2 ** 52));   // |v.m| ∈ [1,2) → 53-bit int
  const shift = BigInt(v.e - 52 + prec);
  return shift >= 0n ? mant << shift : mant >> -shift;
}

// Convert a JS double -> fixed-point BigInt at the given prec.
export function fromDouble(v, prec) {
  if (v === 0 || !isFinite(v)) return 0n;
  const neg = v < 0;
  v = Math.abs(v);
  let e = Math.floor(Math.log2(v));
  const mant = v / Math.pow(2, e); // in [1, 2)
  const mantInt = BigInt(Math.round(mant * Math.pow(2, 52))); // 53-bit integer
  const shift = e + prec - 52;
  let result;
  if (shift >= 0) result = mantInt << BigInt(shift);
  else result = mantInt >> BigInt(-shift);
  return neg ? -result : result;
}

// Parse a decimal string ("-1.7436e-3") -> fixed-point BigInt.
export function fromDecimalString(s, prec) {
  s = String(s).trim();
  let neg = false;
  if (s[0] === '-') { neg = true; s = s.slice(1); }
  else if (s[0] === '+') s = s.slice(1);
  let exp = 0;
  const eIdx = s.search(/[eE]/);
  if (eIdx >= 0) { exp = parseInt(s.slice(eIdx + 1), 10) || 0; s = s.slice(0, eIdx); }
  let [ip, fp = ''] = s.split('.');
  ip = ip || '0';
  let digits = BigInt(ip + fp);
  let tenPow = fp.length - exp; // value = digits / 10^tenPow
  let num = digits << BigInt(prec);
  let den;
  if (tenPow >= 0) {
    den = 10n ** BigInt(tenPow);
  } else {
    num = num * (10n ** BigInt(-tenPow));
    den = 1n;
  }
  let q = num / den;
  const r = num % den;
  if (r * 2n >= den) q += 1n;
  return neg ? -q : q;
}

// Convert fixed-point BigInt -> decimal string with `digits` fractional places.
export function toDecimalString(m, prec, digits = 60) {
  const neg = m < 0n;
  let a = neg ? -m : m;
  const num = a * (10n ** BigInt(digits));
  const p = BigInt(prec);
  const half = 1n << (p - 1n);
  let scaled = (num + half) >> p;
  let s = scaled.toString().padStart(digits + 1, '0');
  const cut = s.length - digits;
  const ip = s.slice(0, cut) || '0';
  const fp = s.slice(cut);
  return (neg ? '-' : '') + ip + (digits > 0 ? '.' + fp : '');
}

// Working precision (bits after the point) for a given view radius.
export function precForRadius(radius, guard = 64) {
  const zoomBits = radius > 0 ? Math.max(0, -Math.log2(radius)) : 0;
  return Math.ceil(zoomBits) + guard;
}
