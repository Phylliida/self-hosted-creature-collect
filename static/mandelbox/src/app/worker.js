// worker.js — render worker for the Mandelbox explorer (module worker).
// Holds the reference orbit after init, then serves row-render jobs and
// camera DE probes. Plain {m, e} objects arriving via postMessage are valid
// floatexp values as-is.

import { renderRows } from '../math/march.js';
import { perturbDE, makePerturbScratch } from '../math/perturb.js';

let ref = null;
const scratch = makePerturbScratch();

// Guarded so Node can import this module for syntax checking.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    ref = msg.ref;
    self.postMessage({ type: 'ready' });
    return;
  }
  if (msg.type === 'probe') {
    // DE at a point (the camera). Returns log2(DE); floorE when the dr-cap
    // proves DE is below the requested floor; -Infinity for interior.
    const dc = { x: msg.dc[0], y: msg.dc[1], z: msg.dc[2] };
    const r = perturbDE(ref, dc, msg.maxIter, { scratch, drCapE: 12 - msg.floorE });
    let deE;
    if (r.interior) deE = -Infinity;
    else if (r.capped || r.de.m === 0) deE = msg.floorE;
    else deE = Math.log2(Math.abs(r.de.m)) + r.de.e;
    self.postMessage({ type: 'probe', id: msg.id, deE });
    return;
  }
  if (msg.type === 'rows') {
    const { gen, W, H, y0, y1, cam, opts } = msg;
    const t0 = performance.now();
    const r = renderRows(ref, cam, W, H, y0, y1, opts);
    self.postMessage(
      { type: 'rows', gen, y0, y1, tMs: performance.now() - t0, hit: r.hit, nx: r.nx, ny: r.ny, nz: r.nz, steps: r.steps, tlog: r.tlog, stats: r.stats },
      [r.hit.buffer, r.nx.buffer, r.ny.buffer, r.nz.buffer, r.steps.buffer, r.tlog.buffer],
    );
  }
};
