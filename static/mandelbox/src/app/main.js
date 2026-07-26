// main.js — Mandelbox deep-zoom explorer (browser app).
//
// Boot: a locate worker bisects the surface point (or reconstructs it from
// the cached mu — exact, instant) and builds the reference orbit; render
// workers each get a copy and serve row jobs + camera DE probes. The app
// starts at a whole-object overview (preset 0) and the rAF loop integrates
// nav input (nav.js), probes DE at the camera (~8 Hz) so the scale exponent
// tracks measured clearance, and drives progressive rendering.
//
// Rendering is INTERRUPTIBLE: every generation bump broadcasts a cancel and
// workers abort mid-chunk within one ~60ms slice (see worker.js), so
// movement always restarts a fresh preview quickly. Quality toggle (fractals2
// Explore/Draw style): Explore renders everything at 1/3 canvas res; Hi-res
// renders idle frames at canvas res with 2×2 supersampling (rendered at 2×
// linear, smooth-downscaled). Moving previews are always Explore-res.
//
// Controls: W/S forward/back · A/D strafe · Space/Shift up/down ·
// E dive in (zoom) · Q back out · 0 overview · 1-5 depth presets ·
// T quality toggle · H help.

import { createNav, deriveOpts, KEYMAP } from './nav.js';
import { makeCamera } from '../math/march.js';

const LS_LOCALE = 'cc.mandelbox.locale.v1';
const LS_CAM = 'cc.mandelbox.cam.v1';
const LS_QUALITY = 'cc.mandelbox.quality.v1';
const DEFAULT_RAY = [1, 9, 4];
// ?depth=N (60..1040) shrinks the bisection for fast dev boots.
const DEFAULT_DEPTH = (() => {
  if (typeof location === 'undefined') return 1040;
  const d = parseInt(new URLSearchParams(location.search).get('depth') || '1040', 10);
  return Math.max(60, Math.min(1040, isNaN(d) ? 1040 : d));
})();
const PRESET_DEPTHS = DEFAULT_DEPTH === 1040
  ? [120, 300, 500, 750, 1015]
  : [1, 2, 3, 4, 5].map((k) => Math.max(40, Math.round(DEFAULT_DEPTH * k / 5) - 25));
const PRESETS = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4 };
const TILT = 0.8;
const PLANE_SCALE = 0.9;
const OVERVIEW_DIST = 14;    // camera distance for the whole-object view
const OVERVIEW_SCENEE = 3.5;
// Per-mode march tuning. cone scales the pixel-footprint hit epsilon DOWN:
// DE = r/dr is escape-time-quantized (≈2^12/2^n regardless of true
// distance), so a raw pixel cone reads the near-set fog floor as surface and
// renders "melted wax" — a tighter cone marches through it (at the price of
// more, smaller steps; hence the larger step budgets).
const MODES = {
  preview: { cone: 0.25, maxSteps: 160, relax: 0.95 },
  'idle-explore': { cone: 0.12, maxSteps: 400, relax: 0.85 },
  'idle-draw': { cone: 0.08, maxSteps: 500, relax: 0.85 },
};

if (typeof document !== 'undefined' && typeof Worker !== 'undefined') boot();

function boot() {
  const $ = (id) => document.getElementById(id);
  const canvas = $('view'), ctx = canvas.getContext('2d');
  const statusEl = $('status'), scaleEl = $('scale'), hintEl = $('hint');
  const qBtns = Array.from(document.querySelectorAll('.qmode'));

  // ---- quality mode ----
  let quality = 'explore';
  try { quality = localStorage.getItem(LS_QUALITY) === 'draw' ? 'draw' : 'explore'; } catch (e) { /* ignore */ }
  function setQuality(q) {
    quality = q;
    try { localStorage.setItem(LS_QUALITY, q); } catch (e) { /* ignore */ }
    for (const b of qBtns) b.setAttribute('aria-pressed', String(b.dataset.mode === q));
    idleDone = false; // re-render idle frame in the new mode
    // Cancel an in-flight idle render of the old mode right away (previews
    // are left alone — movement owns them).
    if (nav && workers.length && readyWorkers === workers.length && pending > 0 && genMeta && genMeta.kind !== 'preview') {
      requestRender(quality === 'draw' ? 'idle-draw' : 'idle-explore');
      idleDone = true;
    }
  }
  for (const b of qBtns) b.addEventListener('click', () => { setQuality(b.dataset.mode); b.blur(); });

  // ---- display sizing (canvas = capped CSS res; CSS stretches to fill) ----
  let canvasW = 560, canvasH = 420, exploreW = 187, exploreH = 140;
  function fitCanvas() {
    const cssW = Math.max(320, window.innerWidth), cssH = Math.max(240, window.innerHeight);
    canvasW = Math.min(560, cssW);
    canvasH = Math.max(160, Math.round(canvasW * cssH / cssW));
    exploreW = Math.round(canvasW / 3);
    exploreH = Math.round(canvasH / 3);
    canvas.width = canvasW; canvas.height = canvasH;
  }
  fitCanvas();

  // ---- state ----
  let workers = [], readyWorkers = 0;
  let nav = null, basis = null, bestV = null, Cd = null;
  let locale = null;
  let lastDeE = null;
  let gen = 0, jobs = [], pending = 0, totalJobs = 0, genMeta = null;
  let dirty = false, idleDone = false, lastMoveT = 0, lastProbeT = 0, lastKickT = 0;
  const temp = document.createElement('canvas'), tctx = temp.getContext('2d');

  function setStatus(s) { statusEl.textContent = s; }
  setQuality(quality);

  // ---- boot: locate worker ----
  try { locale = JSON.parse(localStorage.getItem(LS_LOCALE) || 'null'); } catch (e) { locale = null; }
  if (!locale || locale.depthBits !== DEFAULT_DEPTH || String(locale.ray) !== String(DEFAULT_RAY)) locale = null;
  setStatus(locale ? 'rebuilding reference orbit…' : 'locating surface point (first run, ~10-30s)…');

  const locateW = new Worker(new URL('./locate-worker.js', import.meta.url), { type: 'module' });
  locateW.postMessage({
    ray: DEFAULT_RAY, depthBits: DEFAULT_DEPTH,
    mu: locale ? locale.mu : null, scaleBits: locale ? locale.scaleBits : null,
    standoffE: -(Math.min(120, DEFAULT_DEPTH - 20) - 7),
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
      Cd = msg.Cd;
      setup(msg.ref);
      locateW.terminate();
    }
  };
  locateW.onerror = (e) => setStatus('locate failed: ' + e.message);

  // ---- setup after reference arrives ----
  function setup(refPlain) {
    const camT = makeCamera([], normTilt(bestV), PLANE_SCALE);
    basis = { fwd: camT.fwd, right: camT.right, up: camT.up };
    nav = createNav(basis, [{ m: 0, e: 0 }, { m: 0, e: 0 }, { m: 0, e: 0 }], OVERVIEW_SCENEE);
    jumpHome();

    const n = Math.max(2, Math.min(12, (navigator.hardwareConcurrency || 4) - 1));
    setStatus(`starting ${n} render workers…`);
    for (let k = 0; k < n; k++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.outstanding = 0;
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
  // Whole-object view: camera OVERVIEW_DIST out along -fwd from the origin,
  // looking along fwd through the box (offset is relative to C).
  function jumpHome() {
    nav.jumpAbs([
      -OVERVIEW_DIST * basis.fwd[0] - Cd[0],
      -OVERVIEW_DIST * basis.fwd[1] - Cd[1],
      -OVERVIEW_DIST * basis.fwd[2] - Cd[2],
    ], OVERVIEW_SCENEE);
    lastDeE = null;
  }

  function onWorkerMsg(w, msg) {
    if (msg.type === 'ready') {
      if (++readyWorkers === workers.length) { sendProbe(); lastMoveT = performance.now(); requestRender('preview'); }
      return;
    }
    if (msg.type === 'probe') { lastDeE = msg.deE; return; }
    if (msg.type === 'rows') {
      w.outstanding--;
      if (!msg.aborted && msg.gen === gen) {
        blitRows(msg);
        pending--;
      }
      feed(w);
    }
  }

  // ---- render orchestration ----
  function currentCam() {
    return { o: nav.offsetPlain(), fwd: basis.fwd, right: basis.right, up: basis.up, planeScale: PLANE_SCALE };
  }
  function kindRes(kind) {
    if (kind === 'idle-draw') return { W: canvasW * 2, H: canvasH * 2 }; // 2×2 supersampling
    return { W: exploreW, H: exploreH };
  }

  function requestRender(kind) {
    if (readyWorkers < workers.length) return;
    gen++;
    for (const w of workers) w.postMessage({ type: 'cancel', gen });
    const { W, H } = kindRes(kind);
    const d = deriveOpts(nav.state.sceneE);
    const fast = kind === 'preview';
    const mode = MODES[kind];
    genMeta = {
      W, H, kind, t0: performance.now(),
      cam: currentCam(),
      opts: {
        maxIter: d.maxIter, maxSteps: mode.maxSteps, relax: mode.relax,
        pixFactor: mode.cone * 2 * PLANE_SCALE / H,
        epsAbs: { m: 1, e: d.epsAbsE }, tMax: { m: 1, e: d.tMaxE },
      },
      sceneE: nav.state.sceneE,
    };
    const CH = fast ? 4 : 2;
    jobs = [];
    for (let y = 0; y < H; y += CH) jobs.push({ y0: y, y1: Math.min(H, y + CH) });
    totalJobs = pending = jobs.length;
    for (const w of workers) feed(w);
    lastKickT = performance.now();
  }

  function feed(w) {
    while (w.outstanding < 2 && jobs.length) {
      const job = jobs.shift();
      w.outstanding++;
      w.postMessage({ type: 'rows', gen, W: genMeta.W, H: genMeta.H, y0: job.y0, y1: job.y1, cam: genMeta.cam, opts: genMeta.opts });
    }
  }

  // ---- shading ----
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
    const sy = canvasH / H;
    // Upscaling previews: pixelated. Downscaling supersampled rows: smooth.
    ctx.imageSmoothingEnabled = W > canvasW;
    ctx.drawImage(temp, 0, 0, W, rows, 0, Math.round(msg.y0 * sy), canvasW, Math.max(1, Math.ceil(rows * sy)));
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
    if (e.code === 'Digit0' && nav) {
      jumpHome(); sendProbe();
      dirty = true; lastMoveT = performance.now();
      e.preventDefault();
      return;
    }
    if (PRESETS[e.code] !== undefined && nav) {
      nav.jumpTo(bestV, -(PRESET_DEPTHS[PRESETS[e.code]] - 7));
      lastDeE = null;
      sendProbe();
      dirty = true; lastMoveT = performance.now();
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyT') { setQuality(quality === 'draw' ? 'explore' : 'draw'); return; }
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
    if (!nav || readyWorkers < workers.length || !workers.length) return;

    const moved = nav.tick(dt, lastDeE);
    if (moved) {
      dirty = true; idleDone = false; lastMoveT = t;
      if (t - lastProbeT > 120) sendProbe();
    }
    // Interruptible scheduling: movement kicks a fresh preview at most every
    // 200ms (cancel aborts the old one mid-slice); idle upgrades to the
    // quality-mode frame once the last preview finished.
    if (dirty && t - lastKickT > 200) {
      requestRender('preview');
      dirty = false;
    }
    if (!dirty && !idleDone && nav.held.size === 0 && genMeta && pending === 0 && t - lastMoveT > 400) {
      requestRender(quality === 'draw' ? 'idle-draw' : 'idle-explore');
      idleDone = true;
    }
    if (t - lastHud > 150) {
      lastHud = t;
      const se = nav.state.sceneE;
      const dec = (se * Math.LN2 / Math.LN10).toFixed(0);
      scaleEl.textContent = `scale 2^${se.toFixed(1)} ≈ 10^${dec}${se <= -1079 ? ' · precision wall' : ''}${nav.state.blockedFwd ? ' · surface!' : ''}`;
      if (pending > 0) {
        const pct = Math.round(100 * (1 - pending / Math.max(1, totalJobs)));
        setStatus(`rendering ${genMeta.W}×${genMeta.H} ${genMeta.kind}… ${pct}%`);
      } else if (genMeta) {
        setStatus(`idle · ${genMeta.kind} ${genMeta.W}×${genMeta.H} · ${quality} mode · ${workers.length} workers`);
      }
    }
  }
  requestAnimationFrame(frame);
}
