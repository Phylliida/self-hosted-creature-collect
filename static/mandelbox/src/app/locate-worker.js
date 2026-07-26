// locate-worker.js — one-shot boot worker: bisect (or reconstruct) the
// surface point, build the reference orbit, pick the best-clearance camera
// direction, and hand everything to the main thread.

import { bisectSurface, muToC } from '../math/locate.js';
import { computeMbReference } from '../math/reference.js';
import { perturbDE } from '../math/perturb.js';
import { fe } from '../math/floatexp.js';

const CAM_CANDS = [[0.8, 0.5, 0.33], [-0.7, 0.6, -0.4], [0.25, -0.9, 0.42], [0.6, 0.2, -0.75], [-0.3, -0.5, 0.8], [13, 8, 3], [-13, -8, -3]];
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };

// Guarded so Node can import this module for syntax checking.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') self.onmessage = (ev) => {
  const { ray, depthBits, mu, scaleBits, standoffE } = ev.data;
  const prec = depthBits + 110;
  const maxIter = depthBits + 500;
  const dn = ray.map(BigInt);

  let C, muBig, S;
  if (mu) {
    muBig = BigInt(mu); S = scaleBits;
    C = muToC(dn, muBig, S, prec);
  } else {
    const r = bisectSurface(dn, 16, depthBits, prec, maxIter,
      (k, total) => self.postMessage({ type: 'progress', phase: 'bisect', done: k, total }));
    C = r.c; muBig = r.mu; S = r.scaleBits;
  }

  const ref = computeMbReference({ ...C, prec }, maxIter,
    (n, total) => self.postMessage({ type: 'progress', phase: 'ref', done: n, total }));

  // Best-clearance camera direction at the requested standoff.
  let best = null;
  for (const cand of CAM_CANDS) {
    const v = norm3(cand);
    const o = { x: fe(v[0], standoffE), y: fe(v[1], standoffE), z: fe(v[2], standoffE) };
    const r = perturbDE(ref, o, maxIter, {});
    if (r.interior || r.capped || r.de.m === 0) continue;
    const deE = Math.log2(Math.abs(r.de.m)) + r.de.e;
    if (!best || deE > best.camDeE) best = { v, camDeE: deE };
  }

  const refPlain = {
    prec: ref.prec, len: ref.len, escaped: ref.escaped,
    zx: ref.zx.slice(), zy: ref.zy.slice(), zz: ref.zz.slice(),
    boxReg: ref.boxReg.slice(),
    uM: ref.uM.slice(), uE: ref.uE.slice(), wM: ref.wM.slice(), wE: ref.wE.slice(),
    bx: ref.bx.slice(), by: ref.by.slice(), bz: ref.bz.slice(),
    rho2: ref.rho2.slice(), sphReg: ref.sphReg.slice(),
    rMM: ref.rMM.slice(), rME: ref.rME.slice(),
    rFM: ref.rFM.slice(), rFE: ref.rFE.slice(),
  };
  self.postMessage(
    { type: 'done', mu: muBig.toString(), scaleBits: S, refLen: ref.len, best, ref: refPlain },
    Object.values(refPlain).filter((v) => ArrayBuffer.isView(v)).map((v) => v.buffer),
  );
};
