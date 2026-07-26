// worker.js — render worker for the Mandelbox explorer (module worker).
//
// Holds the reference orbit after init, then serves row-render jobs and
// camera DE probes. Jobs are INTERRUPTIBLE: each row is marched in adaptive
// ~60ms pixel spans with a macrotask yield between spans, so a 'cancel'
// message (new generation) aborts mid-chunk within one slice — and probe
// messages get answered between slices instead of queueing behind a long
// render. Every job posts a completion message (aborted or not) so the main
// thread's job-feeding bookkeeping stays exact.
//
// The handler is exported (createWorkerState) so Node tests can drive the
// exact message protocol without a browser; the bottom wires it to the real
// worker global when one exists.

import { renderSpan } from '../math/march.js';
import { perturbDE, makePerturbScratch } from '../math/perturb.js';

export function createWorkerState(post) {
  const st = {
    ref: null, curGen: 0, queue: [], pumping: false,
    sliceLen: 48, // pixels per span, adapted toward ~60ms
    scratch: makePerturbScratch(),
  };

  async function pump() {
    if (st.pumping) return;
    st.pumping = true;
    while (st.queue.length) {
      const job = st.queue.shift();
      if (job.gen < st.curGen) { post({ type: 'rows', gen: job.gen, aborted: true }); continue; }
      const { gen, W, H, y0, y1, cam, opts } = job;
      const rows = y1 - y0, n = W * rows;
      const out = {
        hit: new Uint8Array(n),
        nx: new Float32Array(n), ny: new Float32Array(n), nz: new Float32Array(n),
        steps: new Uint16Array(n), tlog: new Float32Array(n),
      };
      const o2 = { ...opts, scratch: st.scratch };
      const stats = { iters: 0, evals: 0, degen: 0 };
      const t0 = performance.now();
      let aborted = false;
      for (let j = y0; j < y1 && !aborted; j++) {
        for (let x = 0; x < W; x += st.sliceLen) {
          const x1 = Math.min(W, x + st.sliceLen);
          const ts = performance.now();
          const sp = renderSpan(st.ref, cam, W, H, j, x, x1, o2, out, (j - y0) * W + x);
          stats.iters += sp.iters; stats.evals += sp.evals; stats.degen += sp.degen;
          const ms = performance.now() - ts;
          if (ms > 1) st.sliceLen = Math.max(4, Math.min(512, Math.round(st.sliceLen * (0.4 + 0.6 * Math.min(4, 60 / ms)))));
          // Macrotask yield: lets cancel/probe messages in mid-chunk.
          await new Promise((r) => setTimeout(r, 0));
          if (job.gen < st.curGen) { aborted = true; break; }
        }
      }
      if (aborted) {
        post({ type: 'rows', gen, aborted: true });
      } else {
        post(
          { type: 'rows', gen, aborted: false, y0, y1, tMs: performance.now() - t0, ...out, stats },
          [out.hit.buffer, out.nx.buffer, out.ny.buffer, out.nz.buffer, out.steps.buffer, out.tlog.buffer],
        );
      }
    }
    st.pumping = false;
  }

  function handle(msg) {
    if (msg.type === 'init') {
      st.ref = msg.ref;
      post({ type: 'ready' });
      return;
    }
    if (msg.type === 'cancel') {
      if (msg.gen > st.curGen) st.curGen = msg.gen;
      return; // stale queued jobs report aborted when the pump reaches them
    }
    if (msg.type === 'probe') {
      const dc = { x: msg.dc[0], y: msg.dc[1], z: msg.dc[2] };
      const r = perturbDE(st.ref, dc, msg.maxIter, { scratch: st.scratch, drCapE: 12 - msg.floorE });
      let deE;
      if (r.interior) deE = -Infinity;
      else if (r.capped || r.de.m === 0) deE = msg.floorE;
      else deE = Math.log2(Math.abs(r.de.m)) + r.de.e;
      post({ type: 'probe', id: msg.id, deE });
      return;
    }
    if (msg.type === 'rows') {
      if (msg.gen > st.curGen) st.curGen = msg.gen;
      st.queue.push(msg);
      pump();
    }
  }

  return { handle, st };
}

// Wire to the real worker global (guarded so Node can import this module).
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') {
  const { handle } = createWorkerState((msg, transfer) => self.postMessage(msg, transfer || []));
  self.onmessage = (ev) => handle(ev.data);
  self.onerror = (e) => { try { self.postMessage({ type: 'fatal', message: String(e && e.message || e) }); } catch (err) { /* ignore */ } };
}
