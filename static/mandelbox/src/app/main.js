// main.js — Mandelbox deep-zoom explorer (browser app).
//
// Boot: a locate worker bisects the surface point (or reconstructs it from
// the cached mu — exact, instant) and builds the reference orbit; render
// workers each get a copy and serve row jobs + camera DE probes. The rAF
// loop integrates nav input (nav.js), probes DE at the camera (~8 Hz) so the
// scale exponent tracks measured clearance, and drives progressive
// rendering: coarse preview while moving, adaptive full resolution on idle.
//
// Controls: W/S forward/back · A/D strafe · Space/Shift up/down ·
// E dive in (zoom) · Q back out · 1-5 depth presets · H help.

import { createNav, deriveOpts, KEYMAP } from './nav.js';
import { makeCamera } from '../math/march.js';

const LS_LOCALE = 'cc.mandelbox.locale.v1';
const LS_CAM = 'cc.mandelbox.cam.v1';
const DEFAULT_RAY = [1, 9, 4];
// ?depth=N (60..1040) shrinks the bisection for fast dev boots.
const DEFAULT_DEPTH = (() => {
  if (typeof location === 'undefined') return 1040;
  const d = parseInt(new URLSearchParams(location.search).get('depth') || '1040', 10);
  return Math.max(60, Math.min(1040, isNaN(d) ? 1040 : d));
})();
const START_DEPTH = Math.min(120, DEFAULT_DEPTH - 20);
const PRESET_DEPTHS = DEFAULT_DEPTH === 1040
  ? [120, 300, 500, 750, 1015]
  : [1, 2, 3, 4, 5].map((k) => Math.max(40, Math.round(DEFAULT_DEPTH * k / 5) - 25));
const PRESETS = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4 };
const TILT = 0.8;
const PLANE_SCALE = 0.9;

if (typeof document !== 'undefined' && typeof Worker !== 'undefined') boot();

function boot() {
  const $ = (id) => document.getElementById(id);
  const canvas = $('view'), ctx = canvas.getContext('2d');
  const statusEl = $('status'), scaleEl = $('scale'), hintEl = $('hint');
  ctx.imageSmoothingEnabled = false;

  // ---- display sizing (internal res is small; CSS stretches, pixelated) ----
  let FULLW = 288, FULLH = 216;
  function fitCanvas() {
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    FULLH = Math.max(120, Math.min(288, Math.round(FULLW / aspect)));
    canvas.width = FULLW; canvas.height = FULLH;
  }
  fitCanvas();

  // ---- state ----
  let workers = [], readyWorkers = 0;
  let nav = null, basis = null, bestV = null;
  let locale = null;      // { ray, depthBits, mu, scaleBits }
  let lastDeE = null;     // latest probed log2(DE at camera)
  let gen = 0, jobs = [], pending = 0, genMeta = null;
  let dirty = false, lastMoveT = 0, lastProbeT = 0, lastPreviewT = 0;
  let evalRate = 3000;    // evals/sec/worker (EMA, drives adaptive full res)
  let fullDone = false;
  const temp = document.createElement('canvas'), tctx = temp.getContext('2d');

  function setStatus(s) { statusEl.textContent = s; }

  // ---- boot: locate worker ----
  try { locale = JSON.parse(localStorage.getItem(LS_LOCALE) || 'null'); } catch (e) { locale = null; }
  if (!locale || locale.depthBits !== DEFAULT_DEPTH || String(locale.ray) !== String(DEFAULT_RAY)) locale = null;
  setStatus(locale ? 'rebuilding reference orbit…' : 'locating surface point (first run, ~10-30s)…');

  const locateW = new Worker(new URL('./locate-worker.js', import.meta.url), { type: 'module' });
  locateW.postMessage({
    ray: DEFAULT_RAY, depthBits: DEFAULT_DEPTH,
    mu: locale ? locale.mu : null, scaleBits: locale ? locale.scaleBits : null,
    standoffE: -(START_DEPTH - 7),
  });
  locateW.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'progress') {
      setStatus(`${msg.phase === 'bisect' ? 'locating surface point' : 'building reference orbit'}… ${Math.round(100 * msg.done / msg.total)}%`);
      return;
    }
    if (msg.type === 'done') {
      locale = { ray: DEFAULT_RAY, depthBits: DEFAULT_DEPTH, mu: msg.mu, scaleBits: msg.scaleBits };
      try { localStorage.setItem(LS_LOCALE, JSON.stringify(locale)); } catch (e) { /* private mode */ }
      if (!msg.best) { setStatus('no viable camera direction — reload to retry'); return; }
      bestV = msg.best.v;
      setup(msg.ref, msg.best);
      locateW.terminate();
    }
  };
  locateW.onerror = (e) => setStatus('locate failed: ' + e.message);

  // ---- setup after reference arrives ----
  function setup(refPlain, best) {
    const camT = makeCamera([], normTilt(best.v), PLANE_SCALE);
    basis = { fwd: camT.fwd, right: camT.right, up: camT.up };

    // Restore last camera if it belongs to this locale; else start preset.
    let savedCam = null;
    try { savedCam = JSON.parse(localStorage.getItem(LS_CAM) || 'null'); } catch (e) { savedCam = null; }
    if (savedCam && savedCam.mu === locale.mu && Array.isArray(savedCam.o)) {
      nav = createNav(basis, savedCam.o, savedCam.sceneE);
    } else {
      nav = createNav(basis, [{ m: 0, e: 0 }, { m: 0, e: 0 }, { m: 0, e: 0 }], best.camDeE);
      nav.jumpTo(best.v, -(START_DEPTH - 7));
      nav.state.sceneE = best.camDeE;
    }
    lastDeE = nav.state.sceneE;

    const n = Math.max(2, Math.min(12, (navigator.hardwareConcurrency || 4) - 1));
    setStatus(`starting ${n} render workers…`);
    for (let k = 0; k < n; k++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.busy = false;
      w.onmessage = (e) => onWorkerMsg(w, e.data);
      w.onerror = (e) => setStatus('worker error: ' + e.message);
      w.postMessage({ type: 'init', ref: refPlain });
      workers.push(w);
    }
  }
  function normTilt(v) {
    const perp = [-v[2], 0, v[0]];
    const pl = Math.hypot(...perp) || 1;
    return [-v[0] + TILT * perp[0] / pl, -v[1] + TILT * perp[1] / pl, -v[2] + TILT * perp[2] / pl];
  }

  function onWorkerMsg(w, msg) {
    if (msg.type === 'ready') {
      w.busy = false;
      if (++readyWorkers === workers.length) { sendProbe(); requestRender(true); }
      return;
    }
    if (msg.type === 'probe') {
      lastDeE = msg.deE;
      return;
    }
    if (msg.type === 'rows') {
      w.busy = false;
      if (msg.tMs > 0 && msg.stats && msg.stats.evals) {
        evalRate = 0.7 * evalRate + 0.3 * (msg.stats.evals / (msg.tMs / 1000));
      }
      if (msg.gen === gen) {
        blitRows(msg);
        pending--;
        if (pending === 0 && genMeta.isPreview === false) fullDone = true;
      }
      feed(w);
    }
  }

  // ---- render orchestration ----
  function currentCam() {
    return { o: nav.offsetPlain(), fwd: basis.fwd, right: basis.right, up: basis.up, planeScale: PLANE_SCALE };
  }
  function currentOpts(maxSteps, relax) {
    const d = deriveOpts(nav.state.sceneE);
    return {
      maxIter: d.maxIter, maxSteps, relax,
      epsAbs: { m: 1, e: d.epsAbsE }, tMax: { m: 1, e: d.tMaxE },
    };
  }

  function requestRender(preview) {
    if (readyWorkers < workers.length) return;
    gen++;
    fullDone = false;
    let W, H;
    if (preview) {
      W = Math.round(FULLW / 2.5); H = Math.round(FULLH / 2.5);
    } else {
      // Adaptive full res: aim for ~18s of estimated march time.
      const budget = 18 * evalRate * workers.length;
      const evalsPerPx = 22;
      let w = Math.round(Math.sqrt((budget / evalsPerPx) * (FULLW / FULLH)));
      W = Math.max(112, Math.min(FULLW, w)); H = Math.round(W * FULLH / FULLW);
    }
    genMeta = {
      W, H, isPreview: preview, t0: performance.now(),
      cam: currentCam(), opts: currentOpts(preview ? 90 : 300, preview ? 0.95 : 0.85),
      sceneE: nav.state.sceneE,
    };
    const CH = preview ? 6 : 3;
    jobs = [];
    for (let y = 0; y < H; y += CH) jobs.push({ y0: y, y1: Math.min(H, y + CH) });
    pending = jobs.length;
    for (const w of workers) if (!w.busy) feed(w);
    if (preview) lastPreviewT = performance.now();
  }

  function feed(w) {
    if (w.busy) return;
    const job = jobs.shift();
    if (!job) return;
    w.busy = true;
    w.postMessage({ type: 'rows', gen, W: genMeta.W, H: genMeta.H, y0: job.y0, y1: job.y1, cam: genMeta.cam, opts: genMeta.opts });
  }

  // ---- shading (ported from tools/render-demo.mjs) ----
  function blitRows(msg) {
    const { W, H } = genMeta;
    const rows = msg.y1 - msg.y0;
    const img = new ImageData(W, rows);
    const px = img.data;
    const { fwd, right, up } = basis;
    const L1 = norm3v(-fwd[0] + 0.55 * up[0] + 0.4 * right[0], -fwd[1] + 0.55 * up[1] + 0.4 * right[1], -fwd[2] + 0.55 * up[2] + 0.4 * right[2]);
    const L2 = norm3v(-0.25 * fwd[0] - 0.5 * up[0] - 0.8 * right[0], -0.25 * fwd[1] - 0.5 * up[1] - 0.8 * right[1], -0.25 * fwd[2] - 0.5 * up[2] - 0.8 * right[2]);
    const sceneE = genMeta.sceneE;
    for (let i = 0; i < W * rows; i++) {
      let r, g, b;
      if (!msg.hit[i]) {
        const ty = (msg.y0 + (i / W | 0)) / H;
        const glow = Math.min(1, msg.steps[i] / 120);
        r = 0.015 + 0.03 * (1 - ty) + 0.10 * glow;
        g = 0.02 + 0.035 * (1 - ty) + 0.09 * glow;
        b = 0.045 + 0.06 * (1 - ty) + 0.17 * glow;
      } else {
        const nxx = msg.nx[i], nyy = msg.ny[i], nzz = msg.nz[i];
        const lam1 = Math.max(0, nxx * L1[0] + nyy * L1[1] + nzz * L1[2]);
        const lam2 = Math.max(0, nxx * L2[0] + nyy * L2[1] + nzz * L2[2]);
        const ao = 0.35 + 0.65 / (1 + msg.steps[i] * 0.012);
        const fog = Math.max(0, Math.min(1, (msg.tlog[i] - (sceneE - 4)) / 11));
        const a0 = 0.72 + 0.22 * nxx, a1 = 0.68 + 0.18 * nyy, a2 = 0.74 + 0.24 * nzz;
        const kd = 0.3 + 0.8 * lam1;
        r = (a0 * kd + 0.15 * lam2) * ao;
        g = (a1 * kd + 0.20 * lam2) * ao;
        b = (a2 * kd + 0.39 * lam2) * ao;
        r = r * (1 - 0.3 * fog) + 0.04 * fog;
        g = g * (1 - 0.3 * fog) + 0.05 * fog;
        b = b * (1 - 0.3 * fog) + 0.09 * fog;
      }
      px[i * 4] = gamma(r); px[i * 4 + 1] = gamma(g); px[i * 4 + 2] = gamma(b); px[i * 4 + 3] = 255;
    }
    if (temp.width !== W || temp.height < rows) { temp.width = W; temp.height = Math.max(rows, 8); }
    tctx.putImageData(img, 0, 0);
    const sy = FULLH / genMeta.H, sx = FULLW / genMeta.W;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(temp, 0, 0, W, rows, 0, Math.round(msg.y0 * sy), FULLW, Math.max(1, Math.round(rows * sy)));
  }
  const gamma = (x) => Math.round(255 * Math.pow(Math.max(0, Math.min(1, x)), 1 / 1.9));
  const norm3v = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };

  // ---- probes ----
  let probeSeq = 0;
  function sendProbe() {
    if (!workers.length || !nav) return;
    const w = workers[probeSeq++ % workers.length];
    const d = deriveOpts(nav.state.sceneE);
    w.postMessage({ type: 'probe', id: probeSeq, dc: nav.offsetPlain(), maxIter: d.maxIter + 300, floorE: Math.round(nav.state.sceneE) - 30 });
    lastProbeT = performance.now();
  }

  // ---- input ----
  window.addEventListener('keydown', (e) => {
    if (e.repeat) { if (KEYMAP[e.code]) e.preventDefault(); return; }
    if (PRESETS[e.code] !== undefined && nav) {
      nav.jumpTo(bestV, -(PRESET_DEPTHS[PRESETS[e.code]] - 7));
      lastDeE = null;
      sendProbe();
      dirty = true; lastMoveT = performance.now();
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyH' || (e.key === '?')) { hintEl.hidden = !hintEl.hidden; return; }
    if (e.code === 'Escape') { hintEl.hidden = true; return; }
    if (nav && nav.keydown(e.code)) { hintEl.hidden = true; e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => { if (nav) nav.keyup(e.code); });
  window.addEventListener('blur', () => { if (nav) nav.clearKeys(); });
  window.addEventListener('resize', () => { fitCanvas(); if (nav) { dirty = true; lastMoveT = performance.now(); } });
  const persist = () => {
    if (!nav || !locale) return;
    try { localStorage.setItem(LS_CAM, JSON.stringify({ mu: locale.mu, o: nav.offsetPlain(), sceneE: nav.state.sceneE })); } catch (e) { /* ignore */ }
  };
  window.addEventListener('pagehide', persist);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persist(); });

  // ---- main loop ----
  let lastT = performance.now(), lastHud = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    if (!nav || readyWorkers < workers.length) return;

    const moved = nav.tick(dt, lastDeE);
    if (moved) {
      dirty = true; lastMoveT = t;
      if (t - lastProbeT > 120) sendProbe();
    }
    if (dirty && t - lastPreviewT > 160) {
      requestRender(true);
      dirty = false;
    }
    if (!dirty && nav.held.size === 0 && genMeta && genMeta.isPreview && pending === 0 && t - lastMoveT > 400) {
      requestRender(false);
    }
    if (t - lastHud > 150) {
      lastHud = t;
      const se = nav.state.sceneE;
      const dec = (se * Math.LN2 / Math.LN10).toFixed(0);
      scaleEl.textContent = `scale 2^${se.toFixed(1)} ≈ 10^${dec}${se <= -1079 ? ' · precision wall' : ''}${nav.state.blockedFwd ? ' · surface!' : ''}`;
      if (pending > 0) {
        const pct = Math.round(100 * (1 - pending / Math.max(1, Math.ceil(genMeta.H / (genMeta.isPreview ? 6 : 3)))));
        setStatus(`rendering ${genMeta.W}×${genMeta.H}${genMeta.isPreview ? ' preview' : ''}… ${pct}%`);
      } else if (fullDone) {
        setStatus(`idle · ${genMeta.W}×${genMeta.H} · ${workers.length} workers`);
      }
    }
  }
  requestAnimationFrame(frame);
}
