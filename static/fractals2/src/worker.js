// worker.js — module worker for the render pool. Two roles:
//   1. 'computeRef' (sent to one worker): pick/compute the reference orbit (deep)
//      or naive params (shallow), emit a quick coarse pass, and hand the data
//      back to the main thread.
//   2. 'render' (sent to every worker): render an assigned set of row-bands
//      using the reference data, streaming each band back.
//
// Cancellation: the main thread terminates the whole pool on a view change, so
// workers just run to completion. Every message carries `gen` for safety.
//
// Protocol:
//   in  : { type:'computeRef', gen, cxRaw, cyRaw, prec, radius, width, height,
//           maxIter, engine? }
//         { type:'render', gen, params, bands:[y0,...], bandRows }
//   out : { type:'progress', gen, phase, i, total }
//         { type:'refReady', gen, engine, params, relocations, refLen,
//                            coarse:{sn,snW,snH,step,glitch} }   (+transfer arrays)
//         { type:'band', gen, x0, y0, w, h, sn, glitch }    (+transfer sn/glitch buffers)
//         { type:'tilesDone', gen, glitches }
//         { type:'error', gen, message }
//
// Glitch overlay (debug): when params.showGlitch is set the coarse pass + each band
// also emit a per-pixel Uint8 mask (1 = Pauldelbrot glitch suspected) so the main
// thread can tint flagged pixels — mirrors the GPU shader's sn `.b` flag. The mask is
// built ONLY when requested, so default renders are byte-identical (the sn output never
// depends on the diagnostic; params.glitchTol just tunes the flag, like the GPU uniform).
//
// `params` is engine-specific and self-contained so a tile worker needs nothing
// else:  perturb -> { engine:'perturb', zx, zy, z2, len, offX, offY, scale,
//                     maxIter, width }
//        naive   -> { engine:'naive', x0, y0, scale, maxIter, width }

import { escapeNaive } from './math/naive.js';
import { chooseReference, engineForRadius } from './math/render.js';
import { extendReference } from './math/reference.js';
import { escapePerturb } from './math/perturb.js';
import { computeSeries } from './math/series.js';
import { toDouble } from './math/bignum.js';

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'computeRef') computeRef(m);
    else if (m.type === 'extendRef') extendRef(m);
    else if (m.type === 'computeSA') computeSA(m);
    else if (m.type === 'verifyPixels') verifyPixels(m);
    else if (m.type === 'scanProbes') scanProbes(m);
    else if (m.type === 'finishSA') finishSA(m);
    else if (m.type === 'render') renderBands(m);
  } catch (err) {
    self.postMessage({ type: 'error', gen: m.gen, message: String((err && err.stack) || err) });
  }
};

// PARALLEL SA COLD SCAN (Spawn 40). scanProbes: run computeSeries Pass-1 over a
// SLICE of the probe grid (each probe's recurrence is independent — min over slices
// is bit-identical to the serial scan; test/unit/sascan.test.mjs). The orbit arrives
// as a structured clone and is STASHED so the coordinator's finishSA (Pass-2 at the
// merged validN) doesn't need to resend it.
// in : { type:'scanProbes', gen, zx, zy, len, radius, dcHalfX, dcHalfY, maxIter, lo, hi }
// out: { type:'probesScanned', gen, lo, validN, stopped }
// in : { type:'finishSA', gen, len, radius, dcHalfX, dcHalfY, maxIter, validN, stopped }
// out: { type:'saFinished', gen, sa }
let scanOrbit = null;   // { gen, zx, zy } — stash for finishSA
function scanProbes(m) {
  scanOrbit = { gen: m.gen, zx: m.zx, zy: m.zy };
  const r = computeSeries({ zx: m.zx, zy: m.zy, len: m.len }, m.radius, m.dcHalfX, m.dcHalfY,
    { maxIter: m.maxIter, skipCap: Infinity, scanOnly: true, probeRange: [m.lo, m.hi] });
  self.postMessage({ type: 'probesScanned', gen: m.gen, lo: m.lo, validN: r.validN, stopped: r.stopped });
}
function finishSA(m) {
  if (!scanOrbit || scanOrbit.gen !== m.gen) {
    self.postMessage({ type: 'error', gen: m.gen, message: 'finishSA: no stashed orbit for gen' });
    return;
  }
  const sa = computeSeries({ zx: scanOrbit.zx, zy: scanOrbit.zy, len: m.len }, m.radius,
    m.dcHalfX, m.dcHalfY,
    { maxIter: m.maxIter, skipCap: Infinity, fixedValidN: m.validN, fixedStopped: m.stopped });
  self.postMessage({ type: 'saFinished', gen: m.gen, sa });
}

// Runtime GPU precision SELF-TEST oracle (Spawn 33). The viewer samples scattered
// pixels of a just-completed deep GPU frame and sends them here with the SAME
// reference + SA + geometry the GPU used; escapePerturb (the CPU engine — itself
// BigInt-validated by probe-wall) recomputes each point and the mismatch counts go
// back. The comparison mirrors validate.js comparePerturb's faithfulness mode
// (CPU WITH the same SA, |Δn| ≤ 2 tolerated, inside-flips are mismatches) — the
// thing this detects is a GPU/driver df64 breakdown on hardware we never tested
// (e.g. a mobile GPU whose compiler defeats the optimization barrier).
// in : { type:'verifyPixels', gen, refId, zx?, zy?, z2?, len, offX, offY, scale,
//        maxIter, sa, points: [{x,y}], gpuSn: Float32Array, gpuIter: Float32Array }
// out: { type:'pixelsVerified', gen, compared, escapers, mism }
// ORBIT CACHING (Spawn 38): the viewer keeps ONE persistent verify worker and only
// sends the (multi-MB) orbit arrays when refId changes; a message without arrays
// reuses the cached ones. If the cache is missing (shouldn't happen — the viewer
// resends on refId change), reply with needRef so the viewer can retry with arrays.
let verifyOrbit = null;   // { refId, zx, zy, z2 }
function verifyPixels(m) {
  if (m.zx) verifyOrbit = { refId: m.refId, zx: m.zx, zy: m.zy, z2: m.z2 };
  if (!verifyOrbit || verifyOrbit.refId !== m.refId) {
    self.postMessage({ type: 'pixelsVerified', gen: m.gen, needRef: true });
    return;
  }
  const ref = { zx: verifyOrbit.zx, zy: verifyOrbit.zy, z2: verifyOrbit.z2, len: m.len };
  let compared = 0, escapers = 0, mism = 0, gpuInterior = 0, flips = 0;
  for (let k = 0; k < m.points.length; k++) {
    const pt = m.points[k];
    const dcx = m.offX + (pt.x + 0.5) * m.scale;
    const dcy = m.offY + (pt.y + 0.5) * m.scale;
    const o = escapePerturb(ref, dcx, dcy, m.maxIter, 1 << 16, 0, m.sa || null);
    const cpuInside = o.n >= m.maxIter, gpuInside = m.gpuSn[k] < 0;
    compared++;
    if (gpuInside) gpuInterior++;
    if (cpuInside && gpuInside) continue;          // interior/interior agreement
    escapers++;
    // inside-flips tracked separately (Spawn 35): a REGION of GPU-claims-interior
    // where the CPU says escape — Danielle's "smooth blob" artifact class — is
    // qualitatively serious even when it is a small fraction of the escaper total.
    if (cpuInside !== gpuInside) { mism++; if (!cpuInside) flips++; continue; }
    if (Math.abs(m.gpuIter[k] - o.n) > 2) mism++;
  }
  self.postMessage({ type: 'pixelsVerified', gen: m.gen, compared, escapers, mism, gpuInterior, flips });
}

// (Re)compute the series-approximation coefficients for a CACHED reference orbit
// (Spawn 30). computeSeries is a heavy scan (hundreds of ms at extreme depth — it
// probes a 13×13 dc grid through ~all skipped iterations), so cache-hit renders must
// not run it on the main thread. The viewer sends the cached orbit doubles (a
// structured clone, ~ms) and the CURRENT view's dc box; skipCap Infinity matches the
// GPU path's no-coarse configuration.
// in : { type:'computeSA', gen, zx, zy, len, radius, dcHalfX, dcHalfY, maxIter }
// out: { type:'saReady', gen, sa }
function computeSA(job) {
  const sa = computeSeries({ zx: job.zx, zy: job.zy, len: job.len }, job.radius,
    job.dcHalfX, job.dcHalfY,
    { maxIter: job.maxIter, skipCap: Infinity, wantState: true,
      // resuming a BREACH-bound state cannot advance the skip (that bound is final for
      // ITS box) — a fresh scan at the current (smaller) box can, so drop the resume.
      resume: (job.saState && job.saState.stopped !== 'breach') ? job.saState : undefined });
  const saState = sa.state || null; delete sa.state;
  self.postMessage({ type: 'saReady', gen: job.gen, sa, saState });
}

// Extend a cached reference orbit from its BigInt tail (Spawn 30 — reference reuse).
// The viewer's cache holds the orbit computed by a previous render; when only maxIter
// grew (a same-center zoom-in), the orbit is EXTENDED by the few new iterations
// instead of rebuilt from 0 (extendReference resumes the exact BigInt state, so the
// merged orbit is bit-identical to a fresh full build — test/unit/refextend.test.mjs).
// in : { type:'extendRef', gen, cxRaw, cyRaw, prec, tailBx, tailBy, tailPm2, fromN, maxIter }
// out: { type:'refExtended', gen, zx, zy, z2 (the NEW segment only, transferred),
//        len (absolute), escaped, tailBx, tailBy }
function extendRef(job) {
  const { gen, cxRaw, cyRaw, prec, tailBx, tailBy, tailPm2, fromN, maxIter } = job;
  const center = { x: BigInt(cxRaw), y: BigInt(cyRaw), prec };
  const seg = extendReference(center, { bx: BigInt(tailBx), by: BigInt(tailBy), pm2: tailPm2 },
    fromN, maxIter,
    (i, total) => self.postMessage({ type: 'progress', gen, phase: 'reference', i, total }));
  // withSA (an SA-refresh tick): the viewer also cloned in the OLD orbit arrays —
  // merge them with the new segment and run computeSeries on the merged orbit HERE
  // (off-main; it's hundreds of ms at extreme depth). The merged arrays transfer
  // back and become the viewer's new cache copy (merged: true).
  if (job.withSA) {
    const w = job.withSA;
    const zx = new Float64Array(seg.len + 1), zy = new Float64Array(seg.len + 1), z2 = new Float64Array(seg.len + 1);
    zx.set(job.zxOld); zx.set(seg.zx, fromN + 1);
    zy.set(job.zyOld); zy.set(seg.zy, fromN + 1);
    z2.set(job.z2Old); z2.set(seg.z2, fromN + 1);
    const sa = computeSeries({ zx, zy, len: seg.len }, w.radius, w.dcHalfX, w.dcHalfY,
      { maxIter: w.maxIter, skipCap: Infinity, wantState: true,
        resume: (job.saState && job.saState.stopped !== 'breach') ? job.saState : undefined });
    const saState = sa.state || null; delete sa.state;
    self.postMessage({
      type: 'refExtended', gen, merged: true, zx, zy, z2, len: seg.len, escaped: seg.escaped,
      tailBx: seg.tailX.toString(), tailBy: seg.tailY.toString(), sa, saState,
    }, [zx.buffer, zy.buffer, z2.buffer]);
    return;
  }
  self.postMessage({
    type: 'refExtended', gen, merged: false,
    zx: seg.zx, zy: seg.zy, z2: seg.z2, len: seg.len, escaped: seg.escaped,
    tailBx: seg.tailX.toString(), tailBy: seg.tailY.toString(),
  }, [seg.zx.buffer, seg.zy.buffer, seg.z2.buffer]);
}

// Build a per-pixel escape closure + a glitch accumulator from `params`. `fn(px,py)`
// returns the smooth count and records the pixel's glitch flag in `state.lastGlitched`
// (read by the mask builders when params.showGlitch is set — see the file header).
function makeEscape(params) {
  const state = { glitches: 0, lastGlitched: false };
  let fn;
  if (params.engine === 'perturb') {
    const ref = { zx: params.zx, zy: params.zy, z2: params.z2, len: params.len };
    const { offX, offY, scale, maxIter, glitchTol, sa } = params;
    fn = (px, py) => {
      const r = escapePerturb(ref, offX + px * scale, offY + py * scale, maxIter, 1 << 16, glitchTol, sa);
      if (r.glitched) state.glitches++;
      state.lastGlitched = r.glitched;
      return r.n >= maxIter ? -1 : r.sn;
    };
  } else {
    const { x0, y0, scale, maxIter } = params;
    fn = (px, py) => {
      const r = escapeNaive(x0 + px * scale, y0 + py * scale, maxIter);
      state.lastGlitched = false;   // naive has no perturbation reference -> no glitch concept
      return r.n >= maxIter ? -1 : r.sn;
    };
  }
  return { fn, state };
}

function coarsePass(esc, width, height, step, showGlitch) {
  const { fn, state } = esc;
  const snW = Math.ceil(width / step);
  const snH = Math.ceil(height / step);
  const sn = new Float64Array(snW * snH);
  const glitch = showGlitch ? new Uint8Array(snW * snH) : null;
  for (let sy = 0; sy < snH; sy++) {
    const py = Math.min(sy * step, height - 1);
    for (let sx = 0; sx < snW; sx++) {
      const px = Math.min(sx * step, width - 1);
      const idx = sy * snW + sx;
      sn[idx] = fn(px, py);
      if (glitch) glitch[idx] = state.lastGlitched ? 1 : 0;
    }
  }
  return { sn, snW, snH, step, glitch };
}

function computeRef(job) {
  const { gen, cxRaw, cyRaw, prec, radius, width, height, maxIter } = job;
  const cx = BigInt(cxRaw), cy = BigInt(cyRaw);
  const engine = job.engine || engineForRadius(radius);
  const aspect = width / height;
  const scale = (2 * radius) / height;

  let params, relocations = 0, refLen = 0, saBox = null, refCache = null;
  if (engine === 'perturb') {
    const viewHP = { x: cx, y: cy, prec, radius, width, height };
    const sel = chooseReference(viewHP, maxIter, {
      onProgress: (i, total) => self.postMessage({ type: 'progress', gen, phase: 'reference', i, total }),
    });
    const { ref, center } = sel;
    relocations = sel.relocations; refLen = ref.len;
    // Reference-reuse cache material (Spawn 30): the chosen reference POINT (may be
    // relocated), its prec, its escape state, and the BigInt tail for extension. The
    // viewer stows this (plus copies of the arrays) so a later same-neighborhood
    // render can skip or merely extend this build. BigInt tails ride as strings.
    refCache = {
      cx: center.x.toString(), cy: center.y.toString(), prec,
      escaped: ref.escaped, tailBx: ref.tailX.toString(), tailBy: ref.tailY.toString(),
    };
    const refOffX = toDouble(center.x - cx, prec);
    const refOffY = toDouble(center.y - cy, prec);
    const offX = -radius * aspect - refOffX, offY = -radius - refOffY;
    params = {
      engine, zx: ref.zx, zy: ref.zy, z2: ref.z2, len: ref.len,
      offX, offY, scale, maxIter, width,
    };
    // Series approximation is computed AFTER the no-SA coarse pass below, so the coarse
    // pass's minimum escape iteration can cap the skip (the dense step-8 coarse catches an
    // isolated early-escaping pixel that might fall between the SA probe grid points). Stash
    // its inputs here; the FULL-frame dc-box corners bound the SA truncation validity.
    if (job.series === true && !job.showGlitch) {
      const dcFarX = offX + (width - 1) * scale, dcFarY = offY + (height - 1) * scale;
      saBox = { ref, dcHalfX: Math.max(Math.abs(offX), Math.abs(dcFarX)),
                dcHalfY: Math.max(Math.abs(offY), Math.abs(dcFarY)) };
      // the dc box the SA coeffs will be validated against — cached alongside the
      // reference so a later zoom-in (smaller box ⊂ this box) can REUSE the coeffs
      refCache.saBox = { dcHalfX: saBox.dcHalfX, dcHalfY: saBox.dcHalfY };
    }
  } else {
    const cxd = toDouble(cx, prec), cyd = toDouble(cy, prec);
    params = { engine, x0: cxd - radius * aspect, y0: cyd - radius, scale, maxIter, width };
  }
  // Glitch-overlay knobs travel inside params so the redistributed render bands inherit
  // them (params is echoed back in refReady, then fanned to the tile workers). Default
  // renders leave showGlitch off (no mask) and glitchTol undefined (escapePerturb's
  // standard 1e-6) — the diagnostic never affects sn, so the render stays byte-identical.
  params.showGlitch = !!job.showGlitch;
  params.glitchTol = job.glitchTol;

  // GPU does the full render itself, so skip the CPU coarse pass when not wanted. The coarse
  // pass runs with NO series approximation (params.sa is still unset here) so it doubles as
  // the SA escape oracle below — a dense step-8 sampling of the real escape times.
  const wantCoarse = job.wantCoarse !== false;
  const coarse = wantCoarse ? coarsePass(makeEscape(params), width, height, 8, params.showGlitch) : null;

  // Now compute the series approximation (skip the leading iterations for every band pixel —
  // a huge deep-zoom win, ~90%+ skip below 2^-120, ~2.5× faster). Capped by the coarse pass's
  // MINIMUM escape iteration so the skip can never pass an early-escaping pixel. Bit-exact on
  // well-conditioned pixels; rare ill-conditioned boundary pixels differ by the same measure-
  // zero amount any double method does vs BigInt (see series.js, tools/crosscheck-sa.mjs).
  if (saBox) {
    let minEsc = Infinity;
    if (coarse) { const s = coarse.sn; for (let i = 0; i < s.length; i++) if (s[i] >= 0 && s[i] < minEsc) minEsc = s[i]; }
    const skipCap = Number.isFinite(minEsc) ? Math.floor(minEsc) : Infinity;
    if (job.parallelSA && refCache) {
      // PARALLEL SA (Spawn 40): the viewer fans the probe scan across the pool —
      // don't scan here. sa arrives via scanProbes/finishSA; dispatch waits on it.
      params.sa = null;
      refCache.saPending = true;
    } else {
      const saR = computeSeries(saBox.ref, radius, saBox.dcHalfX, saBox.dcHalfY,
        { maxIter, skipCap, wantState: true });
      // the resumable scan state rides in refCache (viewer cache), NOT in params.sa
      // (which is re-cloned into every GPU render plan)
      if (saR.state && refCache) { refCache.saState = saR.state; delete saR.state; }
      params.sa = saR;
    }
  }

  // arrays we hand off (and lose) to the main thread for tile distribution / GPU upload
  const transfers = [];
  if (coarse) { transfers.push(coarse.sn.buffer); if (coarse.glitch) transfers.push(coarse.glitch.buffer); }
  if (engine === 'perturb') transfers.push(params.zx.buffer, params.zy.buffer, params.z2.buffer);
  self.postMessage({ type: 'refReady', gen, engine, params, relocations, refLen, coarse, refCache }, transfers);
}

function renderBands(job) {
  const { gen, params, bands, bandRows, width, height } = job;
  const { fn, state } = makeEscape(params);
  const showGlitch = !!params.showGlitch;
  for (const y0 of bands) {
    const h = Math.min(bandRows, height - y0);
    const sn = new Float64Array(width * h);
    const glitch = showGlitch ? new Uint8Array(width * h) : null;
    for (let j = 0; j < h; j++) {
      const py = y0 + j;
      for (let px = 0; px < width; px++) {
        const idx = j * width + px;
        sn[idx] = fn(px, py);
        if (glitch) glitch[idx] = state.lastGlitched ? 1 : 0;
      }
    }
    const transfer = [sn.buffer];
    if (glitch) transfer.push(glitch.buffer);
    self.postMessage({ type: 'band', gen, x0: 0, y0, w: width, h, sn, glitch }, transfer);
  }
  self.postMessage({ type: 'tilesDone', gen, glitches: state.glitches });
}
