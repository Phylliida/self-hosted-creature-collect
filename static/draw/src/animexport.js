// src/animexport.js — render the stop-motion flipbook to shareable artifacts.
//
// The flipbook stores each page as items carrying an integer `frame`. To export,
// we render every page to an offscreen canvas with a FIXED camera fitted to the
// bounding box of ALL pages' content (so nothing jitters between frames), then:
//   • encodeGIF()      → a single looping animated .gif
//   • spriteSheet()    → one PNG with every page tiled into a grid (contact sheet)
//
// We reuse the real Renderer (and share its decoded-image cache) so exported
// frames look exactly like the canvas — just cropped to the artwork and with the
// grid / selection chrome / onion skins omitted.

import { Camera } from './camera.js';
import { Renderer } from './renderer.js';
import { itemBBox, drosteSelfSimilarity } from './scene.js';
import { clamp, downsampleRGBA } from './util.js';
import { encodeGIF } from './gif.js';

/** Supersample factor from opts.ss, clamped to a sane integer range (1..4).
 *  ss>1 renders the offscreen frame ss× larger then box-downsamples it, which
 *  kills the diagonal-edge AA shimmer that comes from rasterising a straight edge
 *  at two slightly different absolute camera scales (the documented loop gap). */
function ssFactor(opts) { return clamp(Math.round(opts.ss || 1), 1, 4); }

/** Union bbox of the given items (already-filtered), or null if none. */
function boundsOf(items) {
  if (!items.length) return null;
  let r = { ...itemBBox(items[0]) };
  for (let i = 1; i < items.length; i++) {
    const b = itemBBox(items[i]);
    if (b.minX < r.minX) r.minX = b.minX;
    if (b.minY < r.minY) r.minY = b.minY;
    if (b.maxX > r.maxX) r.maxX = b.maxX;
    if (b.maxY > r.maxY) r.maxY = b.maxY;
  }
  return r;
}

/**
 * Render every flipbook page to an offscreen canvas. Returns
 * { width, height, count, frames } where frames[i] is the RGBA pixel buffer
 * (Uint8ClampedArray) of page i. All frames share the same size and camera.
 *
 * opts.maxDim  — longest output edge in px (default 480, clamped 16..1024).
 * opts.pad     — fraction of margin around the artwork (default 0.12).
 * opts.bg      — background colour (default the live renderer's bg).
 */
export function renderFrames(app, opts = {}) {
  const maxDim = clamp(opts.maxDim || 480, 16, 1024);
  const pad = opts.pad != null ? opts.pad : 0.12;
  const scene = app.scene;

  // Ensure connector endpoints are current before snapshotting geometry.
  if (app.resolveConnectors) app.resolveConnectors();

  const count = Math.max(1, app.anim.count, (app._framesMaxUsed ? app._framesMaxUsed() + 1 : 1));

  // Crop to all visible artwork across every page, so the camera is stable.
  const visible = scene.items.filter(it => !it.hidden);
  let bbox = boundsOf(visible);
  if (!bbox || !(bbox.maxX > bbox.minX) || !(bbox.maxY > bbox.minY)) {
    bbox = { minX: -50, minY: -50, maxX: 50, maxY: 50 };
  }

  const wWorld = Math.max(1e-9, bbox.maxX - bbox.minX);
  const hWorld = Math.max(1e-9, bbox.maxY - bbox.minY);
  const aspect = wWorld / hWorld;
  let W, H;
  if (aspect >= 1) { W = maxDim; H = Math.round(maxDim / aspect); }
  else { H = maxDim; W = Math.round(maxDim * aspect); }
  W = clamp(W, 16, 1024); H = clamp(H, 16, 1024);

  // Supersample: render the offscreen buffer SS× larger, then box-downsample to
  // W×H. fitToRect's framing is resolution-independent (scale ∝ viewport, centre
  // fixed), so a larger viewport just means more pixels per world unit — a clean
  // supersample. The returned width/height stay W×H (the big canvas is internal).
  const ss = ssFactor(opts);
  const SW = W * ss, SH = H * ss;

  const canvas = document.createElement('canvas');
  canvas.width = SW; canvas.height = SH;
  const cam = new Camera(SW, SH);
  const r = new Renderer(canvas, cam);
  // Renderer's constructor sized itself to the window; pin it to our offscreen
  // buffer at dpr 1 and reuse the live image cache so bitmaps are ready.
  r.dpr = 1;
  canvas.width = SW; canvas.height = SH;
  cam.setViewport(SW, SH);
  r.showGrid = false;
  r.bg = opts.bg || app.renderer.bg;
  r.gridStyle = app.renderer.gridStyle;
  r._images = app.renderer._images;
  cam.fitToRect(bbox, pad);

  const byId = (id) => scene.byId(id);
  const frames = [];
  for (let f = 0; f < count; f++) {
    const items = scene.items.filter(it => !it.hidden && (it.frame || 0) === f);
    // Render this page full-strength (no onion skin, no chrome) by handing the
    // renderer a scene view holding only this page's items.
    r.render({ items, byId }, {});
    frames.push(downsampleRGBA(r.ctx.getImageData(0, 0, SW, SH).data, SW, SH, ss));
  }
  return { width: W, height: H, count, frames };
}

/**
 * Render the CINEMATIC camera path to a smooth frame sequence — the payoff of an
 * infinite-zoom tool: a shareable zoom-journey. Instead of one frame per page
 * (fixed fit-camera), we step a virtual playhead along the timeline at a smooth
 * sub-frame rate, and for each step render the page that is live at that tick
 * through the INTERPOLATED camera (geometric zoom, shortest-arc rotation).
 *
 * The output canvas matches the LIVE viewport's aspect ratio, so the keyframe
 * framing is preserved exactly — a keyframe's px/world `scale` was captured at
 * the live viewport, so we rescale it by (outputW / liveW) to the export size.
 *
 * opts.maxDim    — longest output edge (default 480, clamped 16..1024).
 * opts.smoothFps — output frames per second of motion (default max(fps,12), ≤50).
 * opts.maxFrames — hard cap on total frames so a long timeline can't explode
 *                  (default 180, clamped 2..600); the tick-step grows to fit.
 * Returns { width, height, count, frames, delays, loop }.
 */
export function renderCinematicFrames(app, opts = {}) {
  const maxDim = clamp(opts.maxDim || 480, 16, 1024);
  const scene = app.scene;
  if (app.resolveConnectors) app.resolveConnectors();

  // match the live viewport aspect so pinned framing exports 1:1
  const liveW = Math.max(1, app.camera.width || 1);
  const liveH = Math.max(1, app.camera.height || 1);
  const aspect = liveW / liveH;
  let W, H;
  if (aspect >= 1) { W = maxDim; H = Math.round(maxDim / aspect); }
  else { H = maxDim; W = Math.round(maxDim * aspect); }
  W = clamp(W, 16, 1024); H = clamp(H, 16, 1024);
  const ss = ssFactor(opts);                // supersample factor (see ssFactor)
  const SW = W * ss, SH = H * ss;
  const scaleFactor = SW / liveW;           // live px/world → SUPERSAMPLED px/world

  const fps = clamp(opts.fps || app.anim.fps || 6, 1, 60);
  const total = Math.max(1e-6, app._timelineTicks());     // base ticks (Σ holds)
  const smoothFps = clamp(opts.smoothFps || Math.max(fps, 12), 1, 50);
  const maxFrames = clamp(opts.maxFrames || 180, 2, 600);
  let frameCount = Math.max(2, Math.round(total * smoothFps / fps));
  if (frameCount > maxFrames) frameCount = maxFrames;
  const tickStep = total / frameCount;      // covers [0, total) evenly
  const delayCs = Math.max(2, Math.round(100 / smoothFps));

  const canvas = document.createElement('canvas');
  canvas.width = SW; canvas.height = SH;
  const cam = new Camera(SW, SH);
  const r = new Renderer(canvas, cam);
  r.dpr = 1; canvas.width = SW; canvas.height = SH; cam.setViewport(SW, SH);
  r.showGrid = false;
  r.bg = opts.bg || app.renderer.bg;
  r.gridStyle = app.renderer.gridStyle;
  r._images = app.renderer._images;

  const loop = opts.loop != null ? opts.loop : (app.anim.loop !== false);
  const byId = (id) => scene.byId(id);
  const frames = [], delays = [];
  for (let i = 0; i < frameCount; i++) {
    const tick = Math.min(total - 1e-9, i * tickStep);
    const page = app._pageAtTick(tick);
    // looping export glides the wrap (last keyframe → first) so the GIF loops seamlessly
    const s = app.sampleCameraAtTick(tick, loop) || app.camera.serialize();
    cam.restore({ x: s.x, y: s.y, scale: s.scale * scaleFactor, rot: s.rot });
    const items = scene.items.filter(it => !it.hidden && (it.frame || 0) === page);
    r.render({ items, byId }, {});
    frames.push(downsampleRGBA(r.ctx.getImageData(0, 0, SW, SH).data, SW, SH, ss));
    delays.push(delayCs);
  }
  return { width: W, height: H, count: frameCount, frames, delays, loop };
}

/** Encode the flipbook as an animated, looping GIF. Returns a Uint8Array.
 *  Base frame delay comes from the anim fps; each page can HOLD longer via its
 *  per-frame multiplier (app._holdAt) for eases/holds; loop from anim.loop.
 *  When a CAMERA PATH is set (≥1 pinned page) the export becomes cinematic —
 *  a smooth camera glide instead of discrete page flips — unless opts.cinematic
 *  is false (the sprite sheet / thumbnails still want the per-page path). */
export function exportGIF(app, opts = {}) {
  const cinematic = opts.cinematic !== false && app.hasCameraPath && app.hasCameraPath();
  if (cinematic) {
    const { width, height, frames, delays, loop } = renderCinematicFrames(app, opts);
    const dither = opts.dither != null ? opts.dither : !!app.anim.dither;
    return encodeGIF({ width, height, frames, delayCs: delays[0] || 6, delays, loop, dither });
  }
  const { width, height, frames } = renderFrames(app, opts);
  const fps = opts.fps || app.anim.fps || 6;
  const base = Math.max(2, Math.round(100 / fps));
  const holdAt = app._holdAt ? (f) => app._holdAt(f) : () => 1;
  const delays = frames.map((_, f) => Math.max(2, base * holdAt(f)));
  const loop = opts.loop != null ? opts.loop : (app.anim.loop !== false);
  const dither = opts.dither != null ? opts.dither : !!app.anim.dither;
  return encodeGIF({ width, height, frames, delayCs: base, delays, loop, dither });
}

/**
 * Render a SEAMLESS DROSTE ZOOM-LOOP: an endlessly-zooming movie made from one
 * live Droste portal. The payoff of an infinite-zoom + self-similarity engine —
 * a GIF you can loop forever with no visible seam.
 *
 * Why it loops perfectly: a portal is self-similar under the affine M that maps
 * its source bbox onto its frame (shrink σ ≈ `factor`, rotation φ = frame.rot,
 * fixed point p*). A camera that ORBITS p* and zooms IN by exactly 1/σ while
 * rotating by −φ over the loop ends one recursion level deeper — and since every
 * level is an identical copy, the last frame is pixel-identical to the first.
 * Formally cam(t=1) = cam(t=0)∘M⁻¹, and the scene is M-invariant *inside the
 * frame*, so frame[N] == frame[0]. The catch: that invariance only holds where
 * the viewport stays INSIDE the frame box (outside it, the finite level-0 art
 * breaks self-similarity) — so we frame the camera so its circumscribed circle
 * sits within p*'s clearance to the nearest frame edge, for every loop rotation.
 *
 * opts.maxDim — longest output edge (default 480, clamped 16..1024).
 * opts.aspect — output W/H (default 1, a square — the classic Droste framing).
 * opts.frames — frames in one loop (default 48, clamped 2..600).
 * opts.fps    — playback frames/sec (default 30, clamped 1..50).
 * opts.fill   — safety margin on the viewport-fits-frame test (default 1.12).
 * opts.wrap   — also render the t=1.0 frame as `wrapFrame` (seamlessness test).
 * Returns { width, height, count, frames, delays, loop:true, sim, s0 } or null.
 */
export function renderDrosteLoopFrames(app, it, opts = {}) {
  if (!it || it.type !== 'droste' || !it.src || !it.src.length) return null;
  const scene = app.scene;
  if (app.resolveConnectors) app.resolveConnectors();

  const sim = drosteSelfSimilarity(it);          // { scale:σ, rot:φ, x, y }
  const sigma = sim.scale;
  if (!(sigma > 1e-6) || sigma >= 0.999) return null;  // must genuinely shrink

  const maxDim = clamp(opts.maxDim || 480, 16, 1024);
  const aspect = opts.aspect || 1;
  let W, H;
  if (aspect >= 1) { W = maxDim; H = Math.round(maxDim / aspect); }
  else { H = maxDim; W = Math.round(maxDim * aspect); }
  W = clamp(W, 16, 1024); H = clamp(H, 16, 1024);
  // Supersample SS× then box-downsample to W×H — this is the headline fix for the
  // diagonal-edge AA shimmer documented as the loop's one quality gap. The seam
  // stays byte-identical: frame[0] and the wrap frame are rendered from the SAME
  // camera math (only s0 is scaled by SS), so their SS× buffers are bit-identical
  // and the deterministic downsample maps them to identical output pixels.
  const ss = ssFactor(opts);
  const SW = W * ss, SH = H * ss;

  // Frame the camera so the viewport's circumscribed circle fits within the
  // clearance from the fixed point p* to the NEAREST frame edge (works for
  // off-centre p* and for any loop rotation, since the camera spins). p* in the
  // frame's local axes: clearance = min(w/2 − |lx|, h/2 − |ly|).
  const cxf = it.x + it.w / 2, cyf = it.y + it.h / 2;
  const th = it.rot || 0, cth = Math.cos(th), sth = Math.sin(th);
  const dx = sim.x - cxf, dy = sim.y - cyf;
  const lx = cth * dx + sth * dy, ly = -sth * dx + cth * dy;
  const clearance = Math.min(it.w / 2 - Math.abs(lx), it.h / 2 - Math.abs(ly));
  // A clean loop needs the fixed point WELL inside the frame: only then does the
  // recursion self-nest (M(frame) ⊆ frame) so the camera has valid art to dive
  // into. An off-centre frame pushes p* toward (or past) an edge → the dive lands
  // in the clipped-away region (blank). Refuse rather than ship an empty movie.
  if (!(clearance > 0.12 * Math.min(it.w, it.h))) return null;
  const fill = opts.fill || 1.12;                 // >1 ⇒ frame edge comfortably outside
  const viewRadiusPx = Math.hypot(SW, SH) / 2;    // circumscribed circle of the (SS×) viewport
  const s0 = (fill * viewRadiusPx) / clearance;   // px/world at phase 0 (the loosest frame)

  const frameCount = clamp(Math.round(opts.frames || 48), 2, 600);
  const ratio = 1 / sigma;                        // total zoom over one loop (>1 ⇒ zoom in)
  const dRot = -sim.rot;                           // counter-rotate one level's spin
  const cx = sim.x, cy = sim.y;
  const fps = clamp(opts.fps || 30, 1, 50);
  const delayCs = Math.max(2, Math.round(100 / fps));

  const canvas = document.createElement('canvas');
  canvas.width = SW; canvas.height = SH;
  const cam = new Camera(SW, SH);
  const r = new Renderer(canvas, cam);
  r.dpr = 1; canvas.width = SW; canvas.height = SH; cam.setViewport(SW, SH);
  r.showGrid = false;
  r.drawDrosteFrame = false;                       // no editing chrome in the movie
  r.bg = opts.bg || app.renderer.bg;
  r.gridStyle = app.renderer.gridStyle;
  r._images = app.renderer._images;

  const byId = (id) => scene.byId(id);
  // Render ONLY the portal — its recursion (levels 1,2,3…) is a self-contained,
  // perfectly self-similar tower, so every loop wrap is identical. The surrounding
  // REAL level-0 art is deliberately excluded: it is the one thing in the scene
  // with no self-similar counterpart (zooming in just makes it bigger, with no
  // deeper copy to replace it), so drawing it would break the seam wherever it
  // intrudes into the frame. The dive is INTO the portal, so this is also correct.
  // SPIN survives the loop (the camera counter-rotates one level's spin each wrap,
  // dRot above), but per-level HUE cannot: a seamless loop zooms in by exactly one
  // level, which would shift every level's hue by one step — there is no "camera
  // hue" to cancel it, so a hued portal would seam in colour at the wrap. Hue is an
  // *infinite-dive* effect; a closed loop drops it, exactly as it drops the
  // non-self-similar level-0 art. Render a hue-stripped clone (geometry untouched).
  const loopIt = it.hue ? (() => { const c = { ...it }; delete c.hue; return c; })() : it;
  const items = [loopIt];
  // scale(t) = s0·ratio^t = s0·exp(t·ln ratio) — exponential ⇒ constant zoom speed.
  const renderAt = (t) => {
    cam.restore({ x: cx, y: cy, scale: s0 * Math.pow(ratio, t), rot: dRot * t });
    r.render({ items, byId }, {});
    return downsampleRGBA(r.ctx.getImageData(0, 0, SW, SH).data, SW, SH, ss);
  };

  const frames = [], delays = [];
  for (let i = 0; i < frameCount; i++) {           // phases 0 … (N−1)/N; phase N == phase 0
    frames.push(renderAt(i / frameCount));
    delays.push(delayCs);
  }
  const out = { width: W, height: H, count: frameCount, frames, delays, loop: true, sim, s0 };
  if (opts.wrap) out.wrapFrame = renderAt(1.0);    // the would-be frame[N] — must equal frame[0]
  return out;
}

/** Encode a portal's seamless Droste zoom-loop as a looping .gif (Uint8Array),
 *  or null if `it` is not a usable portal. */
export function exportDrosteLoopGIF(app, it, opts = {}) {
  const res = renderDrosteLoopFrames(app, it, opts);
  if (!res) return null;
  const dither = opts.dither != null ? opts.dither : !!app.anim.dither;
  return encodeGIF({ width: res.width, height: res.height, frames: res.frames,
                     delayCs: res.delays[0] || 4, delays: res.delays, loop: true, dither });
}

/**
 * Tile every page into a single contact-sheet canvas (a sprite sheet). Returns
 * { canvas, cols, rows, tileW, tileH, width, height }. Grid is as square as
 * possible; an optional 1px gap separates tiles on the live bg colour.
 */
export function spriteSheet(app, opts = {}) {
  const { width: tileW, height: tileH, count, frames } = renderFrames(app, opts);
  const gap = opts.gap != null ? opts.gap : 2;
  const cols = opts.cols || Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const W = cols * tileW + (cols + 1) * gap;
  const H = rows * tileH + (rows + 1) * gap;

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = opts.bg || app.renderer.bg;
  ctx.fillRect(0, 0, W, H);

  // Paint each rendered frame into its grid cell.
  const tmp = document.createElement('canvas');
  tmp.width = tileW; tmp.height = tileH;
  const tctx = tmp.getContext('2d');
  for (let i = 0; i < count; i++) {
    const col = i % cols, row = (i / cols) | 0;
    const x = gap + col * (tileW + gap), y = gap + row * (tileH + gap);
    const img = new ImageData(new Uint8ClampedArray(frames[i]), tileW, tileH);
    tctx.putImageData(img, 0, 0);
    ctx.drawImage(tmp, x, y);
  }
  return { canvas, cols, rows, tileW, tileH, width: W, height: H };
}
