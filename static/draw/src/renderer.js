import { itemBBox, lodVisible, polygonVertices, rotCenter, ROTATABLE, drosteMatrix,
         refMatrices, refSources, refDepth, REFOPS, MAXREFSTACK } from './scene.js';
import { withAlpha, clamp, ribbonOutline, catmullRom, hueShiftedItem } from './util.js';
import { pixelRGBA } from './pixel.js';

// Scenes smaller than this cull with a plain linear scan (cheap, zero index
// overhead); at or above it the renderer builds an x-sorted spatial index so
// deep-zoom culling stops being O(N). Chosen so the index's build/sort cost is
// well below the scan it replaces by the time it engages.
const CULL_INDEX_MIN = 2000;

// Identity point map for the normal (CTM) render path: gradient anchors are built
// in world coords and the active CTM transforms them, so no per-point mapping.
const identPt = (x, y) => ({ x, y });

// Item types whose low-detail proxy is a single coloured dot (a faithful blob
// once the whole shape is only a few pixels on screen). Images, pixel sprites
// and text are NOT here — a flat dot would mis-represent them — so they always
// draw in full. See the screen-space LOD path in render().
const SPLATTABLE = new Set(['stroke', 'line', 'arrow', 'connector', 'polygon', 'rect', 'ellipse']);

// --- affine helpers for the Droste portal (src/scene.js makeDroste) ----------
// Affines are {a,b,c,d,e,f} setTransform tuples: x' = a·x + c·y + e,
// y' = b·x + d·y + f. `mat2mul(A,B)` is the composition A∘B (apply B, then A).
function mat2mul(A, B) {
  return {
    a: A.a * B.a + A.c * B.b,
    b: A.b * B.a + A.d * B.b,
    c: A.a * B.c + A.c * B.d,
    d: A.b * B.c + A.d * B.d,
    e: A.a * B.e + A.c * B.f + A.e,
    f: A.b * B.e + A.d * B.f + A.f,
  };
}
// Is screen point (px,py) inside the convex quad q[0..3] (one winding order)?
function pointInConvexQuad(px, py, q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) & 3];
    const cr = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    if (cr !== 0) { const s = cr > 0 ? 1 : -1; if (sign === 0) sign = s; else if (s !== sign) return false; }
  }
  return true;
}
function quadContainsRect(q, v) {
  return pointInConvexQuad(v.x0, v.y0, q) && pointInConvexQuad(v.x1, v.y0, q) &&
         pointInConvexQuad(v.x1, v.y1, q) && pointInConvexQuad(v.x0, v.y1, q);
}
function quadAABBIntersects(q, v) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of q) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
  return !(maxX < v.x0 || minX > v.x1 || maxY < v.y0 || minY > v.y1);
}

// --- DEEP-ZOOM render path (extreme zoom, part 2) -----------------------------
// Above this camera scale the normal setTransform path is unsafe: Canvas2D's CTM
// quantises tiny user-space path coords onto Skia's fixed-point grid (~2^28, fine
// detail vanishes) and float32-overflows the matrix (~2^128). So past the gate we
// switch to a SCREEN-SPACE path (CTM = dpr only): every vertex is transformed to
// CSS px in JS via the camera's cancellation-free worldToScreen, line widths are
// pre-multiplied by scale, and geometry is clipped to a bounded box so a far-
// off-screen vertex (which would map to ~10^120 px and overflow Skia) never
// reaches the canvas. Floating-origin rebasing (Scene.shiftAll) keeps the coords
// feeding worldToScreen small, so near-camera content stays crisp to 2^400.
// The gate sits comfortably below the 2^28 Skia ceiling. Proven by
// tests/_canvasctmprobe.mjs ("JS-transform path holds at every scale").
const DEEP_ZOOM_SCALE = 2 ** 23;

// Liang–Barsky: clip segment (x0,y0)->(x1,y1) to the axis-aligned box `b`
// {xmin,ymin,xmax,ymax}. Returns the visible sub-segment {x0,y0,x1,y1} or null.
// Huge finite inputs map to bounded outputs (the whole point — keep Skia fed only
// in-range coordinates), since the parameters t0,t1 are ratios of like magnitudes.
function clipSeg(x0, y0, x1, y1, b) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - b.xmin, b.xmax - x0, y0 - b.ymin, b.ymax - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; }   // parallel & outside this edge
    else {
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
  }
  return { x0: x0 + t0 * dx, y0: y0 + t0 * dy, x1: x0 + t1 * dx, y1: y0 + t1 * dy };
}

// Sutherland–Hodgman: clip polygon `pts` ({x,y}[]) to the axis-aligned box `b`.
// Used for FILLS only — the clip happens against a box larger than the viewport
// (the `box` built in _drawItemDeep), so the rectangular clip edges land off-screen
// and are never seen as fake fill boundaries. Strokes clip per-segment (clipSeg)
// instead, so they never trace the box edge.
function _clipAxis(pts, getC, val, keepGE) {
  if (!pts.length) return pts;
  const out = [];
  const inside = keepGE ? (c) => c >= val : (c) => c <= val;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], c = pts[(i + 1) % pts.length];
    const ca = getC(a), cc = getC(c);
    const ain = inside(ca), cin = inside(cc);
    if (ain) {
      out.push(a);
      if (!cin) out.push(lerpAt(a, c, getC, val));
    } else if (cin) {
      out.push(lerpAt(a, c, getC, val));
    }
  }
  return out;
}
function lerpAt(a, c, getC, val) {
  const t = (val - getC(a)) / (getC(c) - getC(a)); // getC(c)!==getC(a) when one is in, one out
  return { x: a.x + t * (c.x - a.x), y: a.y + t * (c.y - a.y) };
}
function clipPolygonBox(pts, b) {
  pts = _clipAxis(pts, (p) => p.x, b.xmin, true);
  pts = _clipAxis(pts, (p) => p.x, b.xmax, false);
  pts = _clipAxis(pts, (p) => p.y, b.ymin, true);
  pts = _clipAxis(pts, (p) => p.y, b.ymax, false);
  return pts;
}

/**
 * Owns the <canvas>, handles device-pixel-ratio, and paints everything:
 * adaptive grid, scene items (culled to the viewport), the in-progress draft,
 * and selection chrome. Geometry is drawn in world space via a combined
 * DPR×camera transform; UI chrome (grid, handles) is drawn in screen space.
 */
export class Renderer {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = camera;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.showGrid = true;
    this.gridStyle = 'lines'; // 'lines' | 'dots'
    this.bg = '#0e0f13';
    this.gridColor = '#ffffff';
    this._images = new Map(); // src -> { img, loaded, broken }
    // Pixel-sprite bitmap cache: id -> { canvas, dataRef, palRef, pw, ph }. The
    // tiny pw×ph offscreen canvas is rebuilt only when the sprite's `data` or
    // `palette` ARRAY REFERENCE changes (edits replace the ref / call
    // invalidatePixel) — so reference identity is the dirty flag. drawImage then
    // upscales it nearest-neighbour for crisp infinite-zoom pixels.
    this._pixelCache = new Map();
    // Spatial cull index: items sorted by bbox.minX so we can binary-search the
    // viewport's x-slice instead of scanning all N each frame. The index lives on
    // the SCENE now (scene._ensureSpatialIndex), built once per doc revision and
    // shared with pick()/marquee hit-testing; _cullCandidates just searches it, so
    // pan/zoom stays free and there's a single index, not one per consumer.
    // Screen-space LOD: when the WHOLE on-screen footprint of an item is below
    // lodSplatPx, it collapses to a single batched dot rather than a full path —
    // so a fit-all view of a huge scene stops issuing one stroke() per item. On
    // by default (a transparent optimization); flip via the test API setSceneLOD.
    this.sceneLOD = true;
    this.lodSplatPx = 3.5;     // collapse to a dot below this on-screen size (px).
                               // Above it, stroke paths decimate toward ~1 segment
                               // per screen pixel until they reach full detail.
    this.lastSplat = 0;        // how many items collapsed to a dot last frame
    this.lastDrosteLevels = 0; // recursion levels drawn last frame (all portals) —
                               // rises as you zoom INTO a Droste portal (infinite zoom)
    this.drawDrosteFrame = true; // dashed portal-edge chrome; off for clean exports
                                 // (the seamless Droste-loop GIF, like showGrid)
    this.onAsyncLoad = null;  // called when a deferred image bitmap finishes loading
    this.resize();
  }

  /**
   * Lazily decode an image `src` into a cached HTMLImageElement. Returns the
   * cache entry immediately; when an async decode completes it flips `loaded`
   * (or `broken`) and fires `onAsyncLoad` so the app can repaint. Reused across
   * frames so panning/zooming never re-decodes.
   */
  _image(src) {
    let entry = this._images.get(src);
    if (entry) return entry;
    entry = { img: new Image(), loaded: false, broken: false };
    entry.img.onload = () => { entry.loaded = true; this.onAsyncLoad && this.onAsyncLoad(); };
    entry.img.onerror = () => { entry.broken = true; this.onAsyncLoad && this.onAsyncLoad(); };
    entry.img.src = src;
    // data URLs may already be decoded synchronously in some engines
    if (entry.img.complete && entry.img.naturalWidth) entry.loaded = true;
    this._images.set(src, entry);
    return entry;
  }

  /** Kick off decoding of every image src in the scene so bitmaps are ready
   *  before they scroll into view (and so pendingImages is meaningful even when
   *  an image is currently culled offscreen). */
  warmImages(scene) {
    for (const it of scene.items) if (it.type === 'image' && it.src) this._image(it.src);
  }

  /** How many image items still have an undecoded bitmap (test/UX hook). */
  pendingImages(scene) {
    let n = 0;
    for (const it of scene.items) {
      if (it.type !== 'image' || !it.src) continue;
      const e = this._images.get(it.src);
      if (!e || (!e.loaded && !e.broken)) n++;
    }
    return n;
  }

  /** Cached pw×ph offscreen canvas for a pixel sprite, rebuilt only when its
   *  `data`/`palette` array reference (or dimensions) change. */
  _pixelCanvas(it) {
    const e = this._pixelCache.get(it.id);
    if (e && e.dataRef === it.data && e.palRef === it.palette && e.pw === it.pw && e.ph === it.ph) {
      return e.canvas;
    }
    const cv = (e && e.pw === it.pw && e.ph === it.ph) ? e.canvas : document.createElement('canvas');
    cv.width = it.pw; cv.height = it.ph;
    const c2 = cv.getContext('2d');
    const img = c2.createImageData(it.pw, it.ph);
    img.data.set(pixelRGBA(it));
    c2.putImageData(img, 0, 0);
    this._pixelCache.set(it.id, { canvas: cv, dataRef: it.data, palRef: it.palette, pw: it.pw, ph: it.ph });
    return cv;
  }

  /** Force a rebuild of a sprite's cached bitmap (used after in-place edits,
   *  where the `data` array is mutated without changing its reference). */
  invalidatePixel(id) { this._pixelCache.delete(id); }

  resize() {
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = window.innerWidth, h = window.innerHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.camera.setViewport(w, h);
  }

  _screenSpace() { this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }
  _worldSpace() {
    const m = this.camera.matrix(), d = this.dpr;
    // device = dpr · (world→css css matrix). Pre-scaling the output by dpr
    // multiplies all six components; rotation rides along in m automatically.
    this.ctx.setTransform(m.a * d, m.b * d, m.c * d, m.d * d, m.e * d, m.f * d);
  }

  /**
   * Viewport-cull candidate list. Below CULL_INDEX_MIN items we return the
   * items array unchanged — the proven linear scan, zero overhead for the
   * common case. Above it, an x-sorted spatial index lets us binary-search the
   * slice of items whose bbox can overlap `cull`, so deep-zoom into a huge
   * scene no longer pays O(N) per frame just to discard everything off-screen.
   *
   * The index is rebuilt ONLY when scene._rev changes (every geometry/style edit
   * bumps it via scene._touch) or when the items array itself is swapped — never
   * on pure pan/zoom. It is rebuilt wholesale from scene.items, so it can never
   * contain a deleted item (no zombie refs). Connector endpoints are resolved
   * before render and only move when a linked item moves (which bumps _rev),
   * so their cached boxes stay consistent.
   */
  _cullCandidates(scene, cull) {
    const items = scene.items;
    if (items.length < CULL_INDEX_MIN) return items;
    // The x-sorted index now lives on the scene (shared with hit-testing/marquee),
    // built once per doc revision; we just binary-search its entries here.
    const { entries, maxW } = scene._ensureSpatialIndex();
    const n = entries.length;
    // lower bound: first entry whose minX >= cull.minX - maxW. Anything left of
    // that ends before the rect begins (its maxX <= minX + maxW < cull.minX).
    let lo = 0, hi = n; const target = cull.minX - maxW;
    while (lo < hi) { const m = (lo + hi) >> 1; if (entries[m].minX < target) lo = m + 1; else hi = m; }
    // upper bound: first entry whose minX > cull.maxX — nothing from here on can
    // overlap in x (the list is minX-sorted). So [lo, hiEnd) is the x-slice.
    let ulo = lo, uhi = n; const xmax = cull.maxX;
    while (ulo < uhi) { const m = (ulo + uhi) >> 1; if (entries[m].minX <= xmax) ulo = m + 1; else uhi = m; }
    const hiEnd = ulo;
    // When the x-slice is most of the scene (e.g. fit-all, where nothing is culled
    // in x), the index's per-frame collect + z-sort + map costs MORE than it saves
    // — fall back to the already z-ordered items array and let the loop's per-item
    // cull do the rejecting. The index only earns its keep when zoomed in, where
    // the slice is a small fraction of N (the case it exists for).
    if (hiEnd - lo > (n >> 1)) return scene.items;
    const out = [];
    for (let i = lo; i < hiEnd; i++) {
      const e = entries[i];
      if (e.maxX < cull.minX) continue;                       // right edge left of the rect
      if (e.maxY < cull.minY || e.minY > cull.maxY) continue; // y reject
      out.push(e);
    }
    // The index is minX-sorted, but items MUST paint in z-order (their position
    // in scene.items) so overlaps stack correctly — restore it via the stored
    // index. Cheap when zoomed in (few candidates).
    out.sort((a, b) => a.zi - b.zi);
    return out.map(e => e.it);
  }

  /** Full repaint. `state` carries draft/selection info from the app. */
  render(scene, state = {}) {
    const { ctx, camera } = this;
    this._scene = scene;          // op copies resolve their sources through it
    this._refStack = [];          // op reference chain being drawn (depth guard)
    this._refBudget = 30000;      // node budget for cyclic-program expansion
    this._screenSpace();
    ctx.clearRect(0, 0, camera.width, camera.height);
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, camera.width, camera.height);

    if (this.showGrid) this._drawGrid();

    // Scene items in world space (culled).
    const scale = camera.scale;
    // EXTREME ZOOM: past the gate, draw items in screen space (CTM = dpr only) with
    // JS-transformed, clipped geometry — the full camera matrix would quantise/over-
    // flow Canvas2D here (see DEEP_ZOOM_SCALE). Below the gate this is the exact
    // byte-identical world-space path. The grid/chrome paths are unaffected.
    const deep = scale > DEEP_ZOOM_SCALE;
    if (deep) this._screenSpace(); else this._worldSpace();
    const view = camera.visibleWorldRect();
    // expand cull rect slightly so wide strokes near edges still draw
    const margin = camera.screenToWorldLen(64);
    const cull = { minX: view.minX - margin, minY: view.minY - margin,
                   maxX: view.maxX + margin, maxY: view.maxY + margin };
    const selected = state.selectedIds instanceof Set ? state.selectedIds : new Set();
    const fv = state.frame || null;                         // flipbook page view, or null
    // Screen-space LOD setup. Items smaller than splatPx on screen are batched
    // into per-(colour,alpha) dot fills, flushed in z-order chunks; the rest draw
    // in full, with strokes above splat size shedding path points toward ~1/px.
    // wmin floors a sub-pixel item to a still-visible dot. (The per-candidate loop
    // lives in _paintItems now, shared by the flat pass and the per-layer passes.)
    const lod = this.sceneLOD && !deep;        // splat batches in world space; off at deep zoom
    const splatPx = this.lodSplatPx;
    const wmin = camera.screenToWorldLen(0.85);
    this.lastDrosteLevels = 0;
    // Candidate list: the full items array for small scenes, or the spatial
    // index's viewport x-slice for large ones (same per-item culling in _paintItems).
    const candidates = this._cullCandidates(scene, cull);
    const layers = scene.layers || null;
    const baseId = layers ? layers[0].id : null;
    const paintOpts = { deep, lod, splatPx, wmin, cull, fv, scale, layerId: null, hiddenSet: null, baseId };

    // NAMED LAYERS: composite layer-by-layer through an offscreen buffer ONLY when
    // a VISIBLE layer actually changes the result (opacity<1 or a real blend mode).
    // Otherwise — the overwhelming common case, incl. every layers-unaware document
    // — fall through to the single flat pass, which is byte-identical to the
    // pre-layers renderer (it only additionally skips items in a HIDDEN layer).
    const needsComposite = !!(layers && layers.length > 1 &&
      layers.some(L => !L.hidden && ((L.opacity != null && L.opacity < 1) || (L.blend && L.blend !== 'normal'))));
    if (needsComposite) {
      const t = this._compositeLayers(scene, candidates, layers, paintOpts);
      this.lastDrawn = t.drawn; this.lastSplat = t.splatted;
    } else {
      const lk = scene._layerLookup ? scene._layerLookup() : null;
      paintOpts.hiddenSet = (lk && lk.hidden.size) ? lk.hidden : null;
      const t = this._paintItems(scene, candidates, paintOpts);
      this.lastDrawn = t.drawn; this.lastSplat = t.splatted;
    }

    // Re-establish the item-drawing space for the draft: the composite path left
    // the transform on an offscreen buffer; the flat path already has it set (this
    // re-set is the same matrix, a visual no-op there).
    if (deep) this._screenSpace(); else this._worldSpace();
    // Draft (in-progress) item. Under mandala mode the app hands us the live-
    // mirrored copies of the draft to draw instead. Routed through the same path
    // as committed items so a fresh stroke stays crisp at extreme zoom too.
    const drawDraft = (d) => deep ? this._drawItemDeep(d, true) : this._drawItem(d, true);
    if (state.symDrafts) { for (const d of state.symDrafts) drawDraft(d); }
    else if (state.draft) drawDraft(state.draft);

    // Selection chrome & marquee in screen space.
    this._screenSpace();
    if (state.pixelEdit) this._drawPixelOverlay(state.pixelEdit, state.pixelMirror, state.pixelSel);
    if (state.symmetry) this._drawSymmetry(state.symmetry);
    if (state.motionPath) this._drawMotionPath(state.motionPath);
    if (state.guides) this._drawGuides(state.guides);
    if (selected.size) this._drawSelection(scene, selected, state.activeId);
    if (state.scaleHandles) this._drawScaleHandles(state.scaleHandles);
    if (state.rotHandle) this._drawRotHandle(state.rotHandle);
    if (state.pivot) this._drawPivot(state.pivot);
    if (state.refGuide) this._drawSpinGuide(state.refGuide);
    if (state.marquee) this._drawMarquee(state.marquee);
    if (state.eraserCursor) this._drawEraserCursor(state.eraserCursor);
  }

  /**
   * The shared per-candidate paint loop. Draws into the CURRENT `this.ctx` (which
   * the caller has put into the right space + transform — the main canvas for the
   * flat pass, an offscreen buffer for a composited layer). Each call owns its OWN
   * splat map and flushes it before returning, so a layer's sub-pixel dots stay
   * inside that layer's buffer (and thus respect its opacity/blend) — never spilled
   * onto the final composite (gemma's per-layer-flush catch).
   *
   * Filters: `o.hiddenSet` (Set of hidden layer ids — flat pass only) drops items
   * in a hidden layer; `o.layerId` (per-layer pass) keeps ONLY that layer's items.
   * With both null + no hidden layers this is byte-identical to the original loop.
   */
  _paintItems(scene, candidates, o) {
    const { deep, lod, splatPx, wmin, cull, fv, scale, layerId, hiddenSet, baseId } = o;
    const splat = lod ? new Map() : null;
    let drawn = 0, splatted = 0;
    for (const it of candidates) {
      if (it.hidden) continue;                              // per-item eye toggle
      if (hiddenSet && hiddenSet.has(it.layerId || baseId)) continue;       // hidden LAYER
      if (layerId != null && (it.layerId || baseId) !== layerId) continue;  // this-layer-only pass
      if (!lodVisible(it, scale)) continue;                 // zoom-dependent visibility
      if (it.type === 'connector' && (!scene.byId(it.from) || !scene.byId(it.to))) continue; // dangling
      // flipbook: skip off-page items, ghost neighbouring pages (onion skin)
      let alphaMul = 1, tint = null;
      if (fv) {
        const fs = this._frameStyle(it, fv);
        if (!fs) continue;
        alphaMul = fs.alpha; tint = fs.tint;
      }
      const b = itemBBox(it, id => scene.byId(id));
      if (b.maxX < cull.minX || b.minX > cull.maxX || b.maxY < cull.minY || b.minY > cull.maxY) continue;
      // on-screen footprint: the larger of the two bbox dimensions, in px
      const sizePx = Math.max(b.maxX - b.minX, b.maxY - b.minY) * scale;
      // Splat tier: the whole shape is sub-perceptual → one batched dot. Only for
      // opaque, un-tinted, splattable items (onion ghosts / sprites keep full draw).
      // A blended item is NEVER splatted: blend modes aren't associative, so a
      // batched per-colour dot would composite differently than the real stack.
      if (lod && sizePx < splatPx && alphaMul === 1 && !tint && !it.blend && SPLATTABLE.has(it.type)) {
        this._addSplat(splat, it, b, wmin);
        drawn++; splatted++;
        continue;
      }
      // A full-detail item interrupts the splat run: flush the dots accumulated so
      // far so they paint UNDER it, preserving z-order (painter's algorithm). In
      // the common huge-scene case everything splats, so there's no interruption
      // and the whole frame collapses to ONE batched flush at the end.
      if (splat && splat.size) { this._flushSplat(splat); splat.clear(); }
      if (deep) this._drawItemDeep(it, false, alphaMul, tint);
      else this._drawItem(it, false, alphaMul, tint, sizePx);
      drawn++;
    }
    if (splat && splat.size) this._flushSplat(splat);
    return { drawn, splatted };
  }

  /** A reused screen-sized offscreen canvas for per-layer compositing. ONE buffer
   *  total (each blended layer is rendered then blitted before the next), so memory
   *  is a single screen canvas regardless of how many layers blend. Sized to the
   *  main canvas's backing store so the blit is a 1:1 device-pixel copy. */
  _ensureLayerBuffer() {
    const cw = this.canvas.width, ch = this.canvas.height;
    let b = this._layerBuf;
    if (!b) { b = document.createElement('canvas'); this._layerBuf = b; }
    if (b.width !== cw || b.height !== ch) { b.width = cw; b.height = ch; }
    return b;
  }

  /**
   * Per-layer compositing pass (only taken when a visible layer has opacity<1 or a
   * real blend mode). Walks layers BOTTOM→TOP:
   *   • a plain (opacity 1, normal) layer draws straight onto the main canvas in
   *     order — identical pixels to the flat pass, no buffer cost;
   *   • a translucent/blended layer renders ALONE into the reused offscreen buffer
   *     (we swap this.ctx so the shared draw path targets it), then blits the buffer
   *     onto the main canvas with the layer's opacity + globalCompositeOperation —
   *     so the whole layer composites against everything beneath it AS A UNIT.
   * Hidden layers are skipped entirely. Works on both the world-CTM and deep-zoom
   * (screen-space) paths because the buffer is just a screen-resolution canvas.
   */
  _compositeLayers(scene, candidates, layers, baseOpts) {
    const { deep } = baseOpts;
    const mainCtx = this.ctx;
    const setSpace = () => { if (deep) this._screenSpace(); else this._worldSpace(); };
    let drawn = 0, splatted = 0;
    let buf = null, bufCtx = null;
    for (const L of layers) {
      if (L.hidden) continue;
      const opacity = (L.opacity == null) ? 1 : L.opacity;
      const blend = (L.blend && L.blend !== 'normal') ? L.blend : 'source-over';
      const composited = opacity < 1 || blend !== 'source-over';
      if (!composited) {
        this.ctx = mainCtx; setSpace();
        const t = this._paintItems(scene, candidates, { ...baseOpts, layerId: L.id });
        drawn += t.drawn; splatted += t.splatted;
        continue;
      }
      if (!buf) { buf = this._ensureLayerBuffer(); bufCtx = buf.getContext('2d'); }
      bufCtx.setTransform(1, 0, 0, 1, 0, 0);
      bufCtx.clearRect(0, 0, buf.width, buf.height);
      this.ctx = bufCtx; setSpace();
      const t = this._paintItems(scene, candidates, { ...baseOpts, layerId: L.id });
      drawn += t.drawn; splatted += t.splatted;
      this.ctx = mainCtx;
      mainCtx.save();
      mainCtx.setTransform(1, 0, 0, 1, 0, 0);     // device-pixel 1:1 blit
      mainCtx.globalAlpha = opacity;
      mainCtx.globalCompositeOperation = blend;
      mainCtx.drawImage(buf, 0, 0);
      mainCtx.restore();
    }
    this.ctx = mainCtx;
    return { drawn, splatted };
  }

  /**
   * Accumulate one sub-perceptual item into the splat map as a small rect, keyed
   * by (colour, opacity) so a whole colour batches into ONE fill(). A stroke-only
   * shape splats in its stroke colour, a filled shape in its fill colour — the
   * dominant ink either way. The rect is the item's world bbox, floored to wmin so
   * a sub-pixel item still shows a dot. Coords are flat (x,y,w,h,…) to avoid
   * per-item object allocation across tens of thousands of items.
   */
  _addSplat(map, it, b, wmin) {
    // A gradient fill is an object, not paintable as a flat splat — fall back to
    // the first stop (or the stroke colour) for the sub-pixel LOD dot.
    const flatFill = typeof it.fill === 'string' ? it.fill
                   : (it.fill && it.fill.stops && it.fill.stops[0] ? it.fill.stops[0].color : null);
    const color = flatFill || it.color || '#ffffff';
    const op = it.opacity == null ? 1 : it.opacity;
    // Opaque is the hot path (the overwhelming majority of a mass scene), so its
    // key is the bare colour string — no allocation. Translucent items fold alpha
    // into the key so they bucket separately without colliding with opaque ones.
    const key = op === 1 ? color : color + '@' + op;
    let bucket = map.get(key);
    if (!bucket) { bucket = { color, alpha: op, rects: [] }; map.set(key, bucket); }
    let x = b.minX, y = b.minY, w = b.maxX - b.minX, h = b.maxY - b.minY;
    if (!(w > wmin)) { x = (b.minX + b.maxX) / 2 - wmin / 2; w = wmin; }
    if (!(h > wmin)) { y = (b.minY + b.maxY) / 2 - wmin / 2; h = wmin; }
    bucket.rects.push(x, y, w, h);
  }

  /** Paint every batched splat bucket — one fillStyle set per distinct
   *  (colour, opacity), then a tight fillRect loop (canvas's fast path, no path
   *  object). Called in world space, after the detailed item pass. */
  _flushSplat(map) {
    const { ctx } = this;
    for (const bucket of map.values()) {
      ctx.globalAlpha = bucket.alpha;
      ctx.fillStyle = bucket.color;
      const r = bucket.rects;
      for (let i = 0; i < r.length; i += 4) ctx.fillRect(r[i], r[i + 1], r[i + 2], r[i + 3]);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Flipbook page styling for an item, given the view {current, onion, tint}.
   * Returns null to hide the item, else { alpha, tint } where alpha multiplies
   * its opacity and tint (a flat colour) marks an onion-skin ghost. The current
   * page draws at full strength in its own colours; adjacent pages within the
   * onion reach fade with distance and tint warm (past) / cool (future), the
   * traditional-animation convention.
   */
  _frameStyle(it, fv) {
    const df = (it.frame || 0) - fv.current;
    if (df === 0) return { alpha: 1, tint: null };
    const onion = fv.onion || 0;
    if (onion <= 0 || Math.abs(df) > onion) return null;
    const fade = 1 - (Math.abs(df) - 1) / (onion + 0.6); // nearer ghosts stronger
    const alpha = 0.34 * Math.max(0.12, fade);
    const tint = fv.tint ? (df < 0 ? '#ff6b6b' : '#5b8cff') : null;
    return { alpha, tint };
  }

  // ---- grid ----
  _drawGrid() {
    const { ctx, camera } = this;
    // EXTREME ZOOM: far above the gate the adaptive minor/major spacing falls below
    // the ULP of the view coordinates, so the `wx += step` stepping loops could stall
    // (and a grid at 2^400 conveys nothing). Draw only the cheap, loop-free origin
    // axes when on screen, then bail. Below the gate the grid is unchanged.
    if (camera.scale > DEEP_ZOOM_SCALE) { this._drawOriginAxes(); return; }
    const targetPx = 78;                    // desired screen gap between minor lines
    const worldPerTarget = targetPx / camera.scale;
    const pow = Math.pow(10, Math.floor(Math.log10(worldPerTarget)));
    // choose 1/2/5 multiple so minor spacing lands near targetPx
    let step = pow;
    for (const m of [1, 2, 5, 10]) {
      if (pow * m * camera.scale >= targetPx) { step = pow * m; break; }
      step = pow * m;
    }
    const minorPx = step * camera.scale;
    const majorStep = step * 5;

    // fade minor grid as it approaches major spacing / gets dense
    const minorAlpha = clamp((minorPx - 6) / 60, 0, 1) * 0.06;
    const majorAlpha = 0.12;

    const view = camera.visibleWorldRect();
    ctx.lineWidth = 1;

    // When the view is rotated, world grid lines are no longer axis-aligned on
    // screen, so we draw them in WORLD space (they rotate with the canvas). The
    // unrotated path stays pixel-snapped (Math.round + 0.5) and byte-identical.
    if (camera.rot !== 0) { this._drawGridRotated(step, majorStep, minorAlpha, majorAlpha, view); return; }

    const drawSet = (spacing, alpha) => {
      if (alpha <= 0.001) return;
      ctx.strokeStyle = withAlpha(this.gridColor, alpha);
      ctx.beginPath();
      const startX = Math.floor(view.minX / spacing) * spacing;
      for (let wx = startX; wx <= view.maxX; wx += spacing) {
        const sx = Math.round((wx - camera.x) * camera.scale + camera.width / 2) + 0.5;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, camera.height);
      }
      const startY = Math.floor(view.minY / spacing) * spacing;
      for (let wy = startY; wy <= view.maxY; wy += spacing) {
        const sy = Math.round((wy - camera.y) * camera.scale + camera.height / 2) + 0.5;
        ctx.moveTo(0, sy); ctx.lineTo(camera.width, sy);
      }
      ctx.stroke();
    };

    if (this.gridStyle === 'dots') {
      this._drawDots(step, view, Math.min(minorAlpha * 2.2, 0.18));
      this._drawDots(majorStep, view, 0.3);
    } else {
      drawSet(step, minorAlpha);
      drawSet(majorStep, majorAlpha);
    }

    // emphasize the world origin axes
    const o = camera.worldToScreen(0, 0);
    if (o.x >= 0 && o.x <= camera.width) {
      ctx.strokeStyle = withAlpha('#5b8cff', 0.35);
      ctx.beginPath(); ctx.moveTo(o.x + 0.5, 0); ctx.lineTo(o.x + 0.5, camera.height); ctx.stroke();
    }
    if (o.y >= 0 && o.y <= camera.height) {
      ctx.strokeStyle = withAlpha('#5b8cff', 0.35);
      ctx.beginPath(); ctx.moveTo(0, o.y + 0.5); ctx.lineTo(camera.width, o.y + 0.5); ctx.stroke();
    }
  }

  /** The world-origin axes only — drawn in screen space (loop-free, so safe at any
   *  scale). Used as the sole grid at extreme zoom (see _drawGrid's gate). For a
   *  rotated view the axes are projected & viewport-clipped; unrotated they're the
   *  pixel-snapped lines through worldToScreen(0,0). */
  _drawOriginAxes() {
    const { ctx, camera } = this;
    const o = camera.worldToScreen(0, 0);
    if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) return;
    ctx.strokeStyle = withAlpha('#5b8cff', 0.35);
    ctx.lineWidth = 1;
    if (camera.rot === 0) {
      if (o.x >= 0 && o.x <= camera.width) {
        ctx.beginPath(); ctx.moveTo(o.x + 0.5, 0); ctx.lineTo(o.x + 0.5, camera.height); ctx.stroke();
      }
      if (o.y >= 0 && o.y <= camera.height) {
        ctx.beginPath(); ctx.moveTo(0, o.y + 0.5); ctx.lineTo(camera.width, o.y + 0.5); ctx.stroke();
      }
      return;
    }
    const far = camera.screenToWorldLen(Math.hypot(camera.width, camera.height) * 2);
    const box = { xmin: 0, ymin: 0, xmax: camera.width, ymax: camera.height };
    const axes = [
      [camera.worldToScreen(-far, 0), camera.worldToScreen(far, 0)],   // X axis (y=0)
      [camera.worldToScreen(0, -far), camera.worldToScreen(0, far)],   // Y axis (x=0)
    ];
    for (const [p, q] of axes) {
      const c = clipSeg(p.x, p.y, q.x, q.y, box);
      if (c) { ctx.beginPath(); ctx.moveTo(c.x0, c.y0); ctx.lineTo(c.x1, c.y1); ctx.stroke(); }
    }
  }

  /** Grid for a rotated view: drawn in world space so the lines turn with the
   *  canvas. `view` is the (enlarged) visible world AABB; world segments spanning
   *  it cover the rotated viewport. World line widths keep an ~constant screen px. */
  _drawGridRotated(step, majorStep, minorAlpha, majorAlpha, view) {
    const { ctx, camera } = this;
    this._worldSpace();
    const lw = camera.screenToWorldLen(1);
    const lineSet = (spacing, alpha) => {
      if (alpha <= 0.001) return;
      ctx.strokeStyle = withAlpha(this.gridColor, alpha);
      ctx.lineWidth = lw;
      ctx.beginPath();
      const startX = Math.floor(view.minX / spacing) * spacing;
      for (let wx = startX; wx <= view.maxX; wx += spacing) { ctx.moveTo(wx, view.minY); ctx.lineTo(wx, view.maxY); }
      const startY = Math.floor(view.minY / spacing) * spacing;
      for (let wy = startY; wy <= view.maxY; wy += spacing) { ctx.moveTo(view.minX, wy); ctx.lineTo(view.maxX, wy); }
      ctx.stroke();
    };
    const dotSet = (spacing, alpha) => {
      if (alpha <= 0.002) return;
      const px = spacing * camera.scale;
      if (px < 6) return;
      const sz = camera.screenToWorldLen(Math.min(2.4, Math.max(1.2, px * 0.03)));
      ctx.fillStyle = withAlpha(this.gridColor, alpha);
      const startX = Math.floor(view.minX / spacing) * spacing;
      const startY = Math.floor(view.minY / spacing) * spacing;
      for (let wx = startX; wx <= view.maxX; wx += spacing)
        for (let wy = startY; wy <= view.maxY; wy += spacing)
          ctx.fillRect(wx - sz / 2, wy - sz / 2, sz, sz);
    };

    if (this.gridStyle === 'dots') {
      dotSet(step, Math.min(minorAlpha * 2.2, 0.18));
      dotSet(majorStep, 0.3);
    } else {
      lineSet(step, minorAlpha);
      lineSet(majorStep, majorAlpha);
    }

    // world origin axes (only when the axis crosses the visible AABB)
    ctx.strokeStyle = withAlpha('#5b8cff', 0.35);
    ctx.lineWidth = lw;
    if (view.minX <= 0 && 0 <= view.maxX) { ctx.beginPath(); ctx.moveTo(0, view.minY); ctx.lineTo(0, view.maxY); ctx.stroke(); }
    if (view.minY <= 0 && 0 <= view.maxY) { ctx.beginPath(); ctx.moveTo(view.minX, 0); ctx.lineTo(view.maxX, 0); ctx.stroke(); }

    this._screenSpace();
  }

  _drawDots(spacing, view, alpha) {
    if (alpha <= 0.002) return;
    const { ctx, camera } = this;
    const px = spacing * camera.scale;
    if (px < 6) return; // too dense to be useful
    const size = Math.min(2.4, Math.max(1.2, px * 0.03));
    ctx.fillStyle = withAlpha(this.gridColor, alpha);
    const startX = Math.floor(view.minX / spacing) * spacing;
    const startY = Math.floor(view.minY / spacing) * spacing;
    for (let wx = startX; wx <= view.maxX; wx += spacing) {
      const sx = (wx - camera.x) * camera.scale + camera.width / 2;
      for (let wy = startY; wy <= view.maxY; wy += spacing) {
        const sy = (wy - camera.y) * camera.scale + camera.height / 2;
        ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
      }
    }
  }

  // ---- gradient fills -------------------------------------------------------
  // A `fill` is a flat colour STRING or a gradient OBJECT (see scene.js). Both
  // render paths resolve the object to a CanvasGradient here; a string passes
  // through untouched, so flat fills are byte-identical to before.

  /** Unrotated, world-frame fill bbox of a fillable item → {cx,cy,hw,hh} (centre +
   *  half-extents). Rotation is applied by the caller's `map` (deep) or the CTM
   *  (normal), so this stays in the item's local axis-aligned frame. */
  _fillBBoxLocal(it) {
    switch (it.type) {
      case 'rect': case 'ellipse': {
        const x = Math.min(it.x, it.x + it.w), y = Math.min(it.y, it.y + it.h);
        const w = Math.abs(it.w), h = Math.abs(it.h);
        return { cx: x + w / 2, cy: y + h / 2, hw: w / 2, hh: h / 2 };
      }
      case 'polygon': return this._bboxOfPts(polygonVertices(it));
      case 'stroke':  return this._bboxOfPts(it.points);
    }
    return null;
  }
  _bboxOfPts(pts) {
    if (!pts || !pts.length) return null;
    let nx = Infinity, ny = Infinity, xx = -Infinity, xy = -Infinity;
    for (const p of pts) { if (p.x < nx) nx = p.x; if (p.y < ny) ny = p.y; if (p.x > xx) xx = p.x; if (p.y > xy) xy = p.y; }
    return { cx: (nx + xx) / 2, cy: (ny + xy) / 2, hw: (xx - nx) / 2, hh: (xy - ny) / 2 };
  }

  /** Resolve `fillCol` (string | gradient-object | null) to a fillStyle value.
   *  `map` transforms a LOCAL world point to the drawing space (identity for the
   *  normal CTM path; rotate-then-screen for the deep path). `lenScale` converts a
   *  world length to that space (1 normal; camera.scale deep). `angleOffset` is the
   *  rotation to bake into a conic's start angle (0 normal — the CTM rotates; item+
   *  view rotation deep). Returns a string or CanvasGradient. */
  _resolveFill(it, fillCol, map, lenScale, angleOffset) {
    if (!fillCol || typeof fillCol === 'string') return fillCol;
    const bb = this._fillBBoxLocal(it);
    const stops = (fillCol.stops && fillCol.stops.length >= 2)
      ? fillCol.stops : [{ t: 0, color: '#000' }, { t: 1, color: '#fff' }];
    if (!bb) return stops[0].color;          // unfillable type → first stop, flat
    const ctx = this.ctx, { cx, cy, hw, hh } = bb, ang = fillCol.angle || 0;
    let g;
    if (fillCol.type === 'radial') {
      const c = map(cx, cy);
      const r = Math.max(Math.hypot(hw, hh) * lenScale, 0.01);
      g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
    } else if (fillCol.type === 'conic' && ctx.createConicGradient) {
      const c = map(cx, cy);
      g = ctx.createConicGradient(ang + angleOffset, c.x, c.y);
    } else {                                  // 'linear' (and conic fallback)
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const ext = Math.abs(hw * dx) + Math.abs(hh * dy) || Math.max(hw, hh, 0.01);
      const p0 = map(cx - dx * ext, cy - dy * ext);
      const p1 = map(cx + dx * ext, cy + dy * ext);
      g = ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
    }
    for (const s of stops) {
      const t = Math.min(1, Math.max(0, s.t));
      try { g.addColorStop(t, s.color); } catch { /* bad colour → skip stop */ }
    }
    return g;
  }

  // ---- items ----
  /**
   * Paint one item. `alphaMul` scales its opacity (used for onion-skin ghosts);
   * `tint` overrides its colour with a flat ghost colour (and suppresses fills),
   * also for onion skinning. Both default to the no-op identity so normal draws
   * are byte-identical to before.
   */
  _drawItem(it, isDraft = false, alphaMul = 1, tint = null, lodPx = Infinity) {
    const { ctx, camera } = this;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = (it.opacity == null ? 1 : it.opacity) * alphaMul;
    // Per-item blend mode (multiply/screen/…): composites the item against
    // everything painted below it in z-order. Reset to 'source-over' at the end
    // (mirrors globalAlpha) so it never leaks into the splat flush or chrome.
    ctx.globalCompositeOperation = (it.blend && it.blend !== 'normal') ? it.blend : 'source-over';
    const col = tint || it.color;          // onion ghosts draw in a flat tint
    const fillCol = tint ? null : it.fill; // tint ⇒ stroke-only ghost (no fill)
    // Stroke width has three modes:
    //   'world' (default)  width is world units → scales freely with zoom.
    //   'screen'           a constant on-screen pixel width, zoom-independent.
    //   'clamp'            world units that scale with zoom BUT whose on-screen
    //                      thickness is pinned to a [clampMin,clampMax] px range —
    //                      so deep zoom never collapses a stroke to a hairline nor
    //                      balloons it off-screen. (The infinite-zoom sweet spot.)
    const minWorldWidth = camera.screenToWorldLen(0.75); // keep hairlines visible
    let lw;
    if (it.widthMode === 'screen') {
      lw = camera.screenToWorldLen(Math.max(it.width || 1, 0.75));
    } else if (it.widthMode === 'clamp') {
      const naturalPx = camera.worldToScreenLen(Math.max(it.width || 1, 0));
      const lo = Math.max(it.clampMin ?? 1.5, 0.75);
      const hi = Math.max(it.clampMax ?? 24, lo);
      lw = camera.screenToWorldLen(Math.min(Math.max(naturalPx, lo), hi));
    } else {
      lw = Math.max(it.width || 1, minWorldWidth);
    }

    // Rotated box items draw in a locally-rotated world frame; point items bake
    // their rotation into the geometry so they need no transform here. A droste
    // portal is excluded — it sets its own per-level transform (rot folds into M).
    const rotated = !!it.rot && ROTATABLE.has(it.type) && it.type !== 'droste';
    if (rotated) {
      const c = rotCenter(it);
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(it.rot);
      ctx.translate(-c.x, -c.y);
    }

    switch (it.type) {
      case 'stroke': {
        const p = it.points;
        if (!p.length) break;
        if (it.taper) { this._drawRibbon(it, lw, col); break; }   // pressure/tapered brush
        ctx.beginPath();
        ctx.moveTo(p[0].x, p[0].y);
        if (p.length === 1) { ctx.lineTo(p[0].x + 1e-6, p[0].y); }
        else if (p.length > 12 && !fillCol && Math.round(lodPx) < p.length - 1) {
          // Screen-space decimation, targeting ~1 segment per on-screen pixel of
          // footprint (sub-pixel detail is invisible). Stride the points, always
          // keeping the last. Skipped for FILLED strokes (tiling tiles) whose
          // closed area must stay exact. The point-count crossover means as you
          // zoom in, segments rise toward the full count and decimation bows out
          // SEAMLESSLY — no hard threshold where detail suddenly pops in.
          const segs = clamp(Math.round(lodPx), 4, p.length - 1);
          const stride = Math.max(1, Math.floor((p.length - 1) / segs));
          for (let i = stride; i < p.length - 1; i += stride) ctx.lineTo(p[i].x, p[i].y);
          ctx.lineTo(p[p.length - 1].x, p[p.length - 1].y);
        }
        else { for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y); }
        // Optional fill: a stroke with `fill` set is a closed path (fill() auto-
        // closes it). Used by the aperiodic-tiling generator to paint tiles whose
        // shared internal diagonal is left unstroked. No-op for ordinary strokes
        // (makeStroke never sets fill); `fillCol` is null in tint/ghost mode.
        if (fillCol && p.length >= 3) { ctx.fillStyle = this._resolveFill(it, fillCol, identPt, 1, 0); ctx.fill(); }
        ctx.strokeStyle = col;
        ctx.lineWidth = lw;
        ctx.stroke();
        break;
      }
      case 'line': {
        const [a, b] = it.points;
        ctx.strokeStyle = col;
        ctx.lineWidth = lw;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        break;
      }
      case 'arrow': {
        const [a, b] = it.points;
        this._drawArrowSeg(a, b, col, lw, true);
        break;
      }
      case 'connector': {
        const a = { x: it.ax, y: it.ay }, b = { x: it.bx, y: it.by };
        this._drawArrowSeg(a, b, col, lw, it.arrow !== false);
        break;
      }
      case 'polygon': {
        const verts = polygonVertices(it);
        if (!verts.length) break;
        ctx.beginPath();
        ctx.moveTo(verts[0].x, verts[0].y);
        for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
        ctx.closePath();
        if (fillCol) { ctx.fillStyle = this._resolveFill(it, fillCol, identPt, 1, 0); ctx.fill(); }
        ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke();
        break;
      }
      case 'rect': {
        if (fillCol) { ctx.fillStyle = this._resolveFill(it, fillCol, identPt, 1, 0); ctx.fillRect(it.x, it.y, it.w, it.h); }
        ctx.strokeStyle = col; ctx.lineWidth = lw;
        ctx.strokeRect(it.x, it.y, it.w, it.h);
        break;
      }
      case 'ellipse': {
        const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
        const rx = Math.abs(it.w / 2), ry = Math.abs(it.h / 2);
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        if (fillCol) { ctx.fillStyle = this._resolveFill(it, fillCol, identPt, 1, 0); ctx.fill(); }
        ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke();
        break;
      }
      case 'image': {
        const x = Math.min(it.x, it.x + it.w), y = Math.min(it.y, it.y + it.h);
        const w = Math.abs(it.w), h = Math.abs(it.h);
        const entry = it.src ? this._image(it.src) : null;
        if (entry && entry.loaded) {
          // crisper downscales when an image is shrunk far below native size
          ctx.imageSmoothingEnabled = true;
          try { ctx.drawImage(entry.img, x, y, w, h); }
          catch { this._drawImagePlaceholder(x, y, w, h, true); }
        } else {
          this._drawImagePlaceholder(x, y, w, h, entry ? entry.broken : true);
        }
        break;
      }
      case 'pixel': {
        // crisp nearest-neighbour upscale of the tiny cached bitmap → infinite
        // zoom keeps hard pixel edges. Onion ghosts just fade (a flat tint of a
        // multi-colour sprite is meaningless), so `tint` is ignored here.
        const x = Math.min(it.x, it.x + it.w), y = Math.min(it.y, it.y + it.h);
        const w = Math.abs(it.w), h = Math.abs(it.h);
        const cv = this._pixelCanvas(it);
        const prevSmooth = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        try { ctx.drawImage(cv, x, y, w, h); } catch { /* zero-size during edits */ }
        ctx.imageSmoothingEnabled = prevSmooth;
        break;
      }
      case 'text': {
        ctx.fillStyle = col;
        ctx.textBaseline = 'top';
        ctx.font = `${it.size}px ui-sans-serif, system-ui, sans-serif`;
        const lines = String(it.text).split('\n');
        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], it.x, it.y + i * it.size * 1.1);
        }
        break;
      }
      case 'droste': {
        this._drawDroste(it, alphaMul);
        break;
      }
      case 'fold':
      case 'spin':
      case 'glide': {
        this._drawRefCopies(it, alphaMul, tint);
        break;
      }
    }
    if (rotated) ctx.restore();
    if (isDraft) { /* draft uses same styling; hook kept for future ghosting */ }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---- BY-REFERENCE transform ops (fold / spin / glide) ---------------------
  // An op stores only a guide + source ids (see scene.js); here we re-draw each
  // SOURCE under the op's rigid transform(s). Sources are drawn through the
  // normal _drawItem path under a ctx.transform, so every style/width/gradient
  // rule applies unchanged (the transforms are rigid: no scale distortion).
  //
  // PROGRAMS: ops auto-link into one cyclic program in placement order, and
  // EVERY op expands at top level — the drawing is the union of all op-words
  // applied to the base content (each word is drawn once, by its outermost
  // op). A source that is itself an op recurses: its entry is pushed onto
  // _refStack, and refDepth caps how often each op may appear in one chain —
  // so placing glide then fold then spin yields glide∘fold∘spin applied to
  // the accumulated output, round after round. Guides are never part of the
  // recursion: they draw only at top level, so pivots / fold lines / glide
  // arrows are never copied. Guards: MAXREFSTACK chain cap + _refBudget node
  // cap per frame — a pathological doc truncates instead of hanging.

  _drawRefCopies(it, alphaMul, tint) {
    const scene = this._scene;
    const topLevel = this._refStack.length === 0;
    if (scene && this._refStack.filter(id => id === it.id).length <= refDepth(it)
               && this._refStack.length < MAXREFSTACK && this._refBudget > 0) {
      const byId = id => scene.byId(id);
      const scale = this.camera.scale;
      for (const m of refMatrices(it)) {
        this.ctx.save();
        this.ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
        for (const s of refSources(it, byId, this._refStack)) {
          if (this._refBudget-- <= 0) { this.ctx.restore(); if (topLevel) this._drawRefGuide(it); return; }
          if (s.hidden || !lodVisible(s, scale)) continue;
          const isOp = REFOPS.has(s.type);
          if (isOp) this._refStack.push(s.id);   // entering the op: one application
          this._drawItem(s, false, alphaMul, tint);
          if (isOp) this._refStack.pop();
        }
        this.ctx.restore();
      }
    }
    // Guides are top-level chrome only — never copied by the recursion above.
    if (topLevel) this._drawRefGuide(it);
  }

  /** The op's on-canvas guide — fold line / spin pivot crosshair / glide
   *  arrow — drawn faint so there's always something visible to grab. */
  _drawRefGuide(it) {
    const { ctx, camera } = this;
    const px = n => camera.screenToWorldLen(n);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = withAlpha('#5b8cff', 0.55);
    ctx.lineWidth = px(1.2);
    if (it.type === 'spin') {
      const r = px(8);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(it.cx - r, it.cy); ctx.lineTo(it.cx + r, it.cy);
      ctx.moveTo(it.cx, it.cy - r); ctx.lineTo(it.cx, it.cy + r);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(it.cx, it.cy, r * 0.45, 0, Math.PI * 2); ctx.stroke();
    } else if (it.type === 'glide') {
      ctx.setLineDash([px(6), px(4)]);
      this._drawArrowSeg({ x: it.ax, y: it.ay }, { x: it.bx, y: it.by }, withAlpha('#5b8cff', 0.55), px(1.2), true);
    } else {
      ctx.setLineDash([px(6), px(4)]);
      ctx.beginPath();
      ctx.moveTo(it.ax, it.ay); ctx.lineTo(it.bx, it.by);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Screen-space placement preview for the spin tool: a bright crosshair at the
   *  chosen pivot, a dashed arm to the cursor, and the swept-angle arc (sampled
   *  in world space so it stays correct under canvas rotation). `g` is
   *  {pivot, arm?, ang0?, angle?} in world coords. */
  _drawSpinGuide(g) {
    const { ctx, camera } = this;
    const c = camera.worldToScreen(g.pivot.x, g.pivot.y);
    ctx.save();
    ctx.strokeStyle = withAlpha('#5b8cff', 0.9);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(c.x - 9, c.y); ctx.lineTo(c.x + 9, c.y);
    ctx.moveTo(c.x, c.y - 9); ctx.lineTo(c.x, c.y + 9);
    ctx.stroke();
    if (g.arm) {
      const a = camera.worldToScreen(g.arm.x, g.arm.y);
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(a.x, a.y); ctx.stroke();
      ctx.setLineDash([]);
      if (g.angle && g.ang0 != null) {
        const rw = Math.hypot(g.arm.x - g.pivot.x, g.arm.y - g.pivot.y);
        ctx.beginPath();
        const steps = Math.max(8, Math.ceil(Math.abs(g.angle) / (Math.PI / 36)));
        for (let i = 0; i <= steps; i++) {
          const th = g.ang0 + g.angle * (i / steps);
          const p = camera.worldToScreen(g.pivot.x + Math.cos(th) * rw, g.pivot.y + Math.sin(th) * rw);
          i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ---- EXTREME ZOOM: screen-space item draw (above DEEP_ZOOM_SCALE) ----------
  // Mirrors _drawItem, but every vertex is transformed to CSS px in JS via the
  // camera's cancellation-free map (NOT the CTM), line widths are pre-scaled, and
  // geometry is clipped to a bounded box. So the astronomical scale never enters
  // Canvas2D's matrix or its path coordinates — the one render path that survives
  // to 2^400 (tests/_canvasctmprobe.mjs). Raster/text/portal types fall back to
  // the world-CTM _drawItem (correct to ~2^28 as before — no regression there).

  /** Rotate world points about centre `c` by `ang` (item rotation, done in JS so it
   *  survives the screen-space map; an isotropic scale preserves the angle). */
  _rotWorld(pts, c, ang) {
    const co = Math.cos(ang), si = Math.sin(ang);
    return pts.map(p => { const dx = p.x - c.x, dy = p.y - c.y;
      return { x: c.x + co * dx - si * dy, y: c.y + si * dx + co * dy }; });
  }

  /** Stroke a screen-space polyline, clipping each segment to `box` (so a far-off-
   *  screen vertex never reaches Skia). Connectivity is preserved across unclipped
   *  runs (one path → real joins); breaks only at clip boundaries, which sit off
   *  screen. `closed` adds the wrap-around segment (rect/polygon/ellipse outline). */
  _strokeClippedPath(sp, box, closed) {
    const ctx = this.ctx, n = sp.length;
    if (n < 2) return;
    ctx.beginPath();
    let px = NaN, py = NaN;
    const segEnd = closed ? n : n - 1;
    for (let i = 0; i < segEnd; i++) {
      const a = sp[i], b = sp[(i + 1) % n];
      const c = clipSeg(a.x, a.y, b.x, b.y, box);
      if (!c) { px = NaN; py = NaN; continue; }
      if (c.x0 !== px || c.y0 !== py) ctx.moveTo(c.x0, c.y0);
      ctx.lineTo(c.x1, c.y1);
      px = c.x1; py = c.y1;
    }
    ctx.stroke();
  }

  /** Fill a screen-space polygon, clipped (Sutherland–Hodgman) to `box`. The box is
   *  larger than the viewport, so its rectangular clip edges stay off-screen and are
   *  never seen as a fake fill boundary. */
  _fillClippedPoly(sp, box) {
    const cl = clipPolygonBox(sp, box);
    if (cl.length < 3) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(cl[0].x, cl[0].y);
    for (let i = 1; i < cl.length; i++) ctx.lineTo(cl[i].x, cl[i].y);
    ctx.closePath();
    ctx.fill();
  }

  _drawItemDeep(it, isDraft = false, alphaMul = 1, tint = null) {
    const t = it.type;
    // Not yet ported to the screen-space path → draw via the world CTM. Correct to
    // the ~2^28 Skia ceiling (quantises beyond) — identical to pre-batch behaviour,
    // so no regression; these are the "come second" types (NOTES extreme-zoom pt 2).
    if (t === 'image' || t === 'pixel' || t === 'text' || t === 'droste' || t === 'fold' || t === 'spin' || t === 'glide') {
      this._worldSpace();
      this._drawItem(it, isDraft, alphaMul, tint);
      this._screenSpace();
      return;
    }
    const { ctx, camera } = this;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = (it.opacity == null ? 1 : it.opacity) * alphaMul;
    // Blend mode is pure compositing → scale-invariant, so the deep-zoom path
    // sets the SAME composite op as the normal path. (image/pixel/text/droste
    // already returned above via _drawItem, which handles its own blend.)
    ctx.globalCompositeOperation = (it.blend && it.blend !== 'normal') ? it.blend : 'source-over';
    const col = tint || it.color;            // onion ghosts draw in a flat tint
    const fillCol = tint ? null : it.fill;   // tint ⇒ stroke-only ghost (no fill)

    const sc = camera.scale, rot = camera.rot;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const W2 = camera.width / 2, H2 = camera.height / 2, cmx = camera.x, cmy = camera.y;
    // world → screen px — the SAME map as camera.worldToScreen, inlined. After
    // floating-origin rebasing both operands are near 0, so this is cancellation-free.
    const toS = (wx, wy) => { const dx = wx - cmx, dy = wy - cmy;
      return { x: sc * (cos * dx - sin * dy) + W2, y: sc * (sin * dx + cos * dy) + H2 }; };

    // World line width (same three modes as _drawItem) → screen px. Pitfall A: with
    // the scale out of the CTM, ctx.lineWidth is now screen px, so multiply by scale.
    const minWorldWidth = camera.screenToWorldLen(0.75);
    let lw;
    if (it.widthMode === 'screen') {
      lw = camera.screenToWorldLen(Math.max(it.width || 1, 0.75));
    } else if (it.widthMode === 'clamp') {
      const naturalPx = camera.worldToScreenLen(Math.max(it.width || 1, 0));
      const lo = Math.max(it.clampMin ?? 1.5, 0.75);
      const hi = Math.max(it.clampMax ?? 24, lo);
      lw = camera.screenToWorldLen(Math.min(Math.max(naturalPx, lo), hi));
    } else {
      lw = Math.max(it.width || 1, minWorldWidth);
    }
    const md = Math.max(camera.width, camera.height);
    let lwScreen = lw * sc;
    if (!(lwScreen >= 0)) lwScreen = 0;
    if (lwScreen > md * 2) lwScreen = md * 2;   // a 'world'-width line wider than the screen just fills it
    // Clip box: a few viewports beyond the edges so fill clip-edges and wide-stroke
    // caps land off-screen, yet coords stay far below Skia's float32 ceiling.
    const m = md * 3 + lwScreen;
    const box = { xmin: -m, ymin: -m, xmax: camera.width + m, ymax: camera.height + m };

    // Gradient-fill anchors map LOCAL world coords → screen, applying the item's
    // own rotation (in JS, like the geometry) then the world→screen map. Radius is
    // a world length → screen px (×scale); a conic's start angle absorbs item+view
    // rotation (no CTM rotation to lean on at deep zoom).
    const drot = it.rot || 0;
    const dmap = drot
      ? (() => { const c = rotCenter(it), cc = Math.cos(drot), ss = Math.sin(drot);
          return (x, y) => { const dx = x - c.x, dy = y - c.y;
            return toS(c.x + cc * dx - ss * dy, c.y + ss * dx + cc * dy); }; })()
      : toS;
    const dAngleOff = drot + rot;

    switch (t) {
      case 'stroke': {
        const p = it.points;
        if (!p.length) break;
        if (it.taper) { this._drawRibbonDeep(it, lw, col, box, toS); break; }
        const sp = p.map(q => toS(q.x, q.y));
        if (fillCol && p.length >= 3) { ctx.fillStyle = this._resolveFill(it, fillCol, dmap, sc, dAngleOff); this._fillClippedPoly(sp, box); }
        ctx.strokeStyle = col; ctx.lineWidth = lwScreen;
        if (p.length === 1) { const a = sp[0]; this._strokeClippedPath([a, { x: a.x + 1e-3, y: a.y }], box, false); }
        else this._strokeClippedPath(sp, box, false);
        break;
      }
      case 'line': {
        const [a, b] = it.points;
        ctx.strokeStyle = col; ctx.lineWidth = lwScreen;
        this._strokeClippedPath([toS(a.x, a.y), toS(b.x, b.y)], box, false);
        break;
      }
      case 'arrow': {
        const [a, b] = it.points;
        this._drawArrowSegDeep(a, b, col, lwScreen, lw, true, box, toS);
        break;
      }
      case 'connector': {
        this._drawArrowSegDeep({ x: it.ax, y: it.ay }, { x: it.bx, y: it.by },
          col, lwScreen, lw, it.arrow !== false, box, toS);
        break;
      }
      case 'polygon': {
        let verts = polygonVertices(it);
        if (!verts.length) break;
        if (it.rot) verts = this._rotWorld(verts, rotCenter(it), it.rot);
        const sp = verts.map(v => toS(v.x, v.y));
        if (fillCol) { ctx.fillStyle = this._resolveFill(it, fillCol, dmap, sc, dAngleOff); this._fillClippedPoly(sp, box); }
        ctx.strokeStyle = col; ctx.lineWidth = lwScreen;
        this._strokeClippedPath(sp, box, true);
        break;
      }
      case 'rect': {
        let corners = [{ x: it.x, y: it.y }, { x: it.x + it.w, y: it.y },
                       { x: it.x + it.w, y: it.y + it.h }, { x: it.x, y: it.y + it.h }];
        if (it.rot) corners = this._rotWorld(corners, rotCenter(it), it.rot);
        const sp = corners.map(v => toS(v.x, v.y));
        if (fillCol) { ctx.fillStyle = this._resolveFill(it, fillCol, dmap, sc, dAngleOff); this._fillClippedPoly(sp, box); }
        ctx.strokeStyle = col; ctx.lineWidth = lwScreen;
        this._strokeClippedPath(sp, box, true);
        break;
      }
      case 'ellipse': {
        const ecx = it.x + it.w / 2, ecy = it.y + it.h / 2;
        const rx = Math.abs(it.w / 2), ry = Math.abs(it.h / 2);
        // segment count from on-screen circumference (~2px/seg), capped. A gigantic
        // ellipse you're inside shows a near-straight arc per visible chord, so the
        // cap stays accurate (curvature over the viewport is negligible).
        const a = Math.abs(sc * rx), b2 = Math.abs(sc * ry);
        const N = clamp(Math.round(Math.PI * (a + b2) / 2) || 24, 24, 2048);
        const er = it.rot || 0, erc = Math.cos(er), ers = Math.sin(er);
        const sp = [];
        for (let i = 0; i < N; i++) {
          const th = (i / N) * Math.PI * 2;
          const lx = Math.cos(th) * rx, ly = Math.sin(th) * ry;   // item-local frame
          const wx = ecx + erc * lx - ers * ly, wy = ecy + ers * lx + erc * ly;
          sp.push(toS(wx, wy));
        }
        if (fillCol) { ctx.fillStyle = this._resolveFill(it, fillCol, dmap, sc, dAngleOff); this._fillClippedPoly(sp, box); }
        ctx.strokeStyle = col; ctx.lineWidth = lwScreen;
        this._strokeClippedPath(sp, box, true);
        break;
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Screen-space arrow/connector: shaft + filled head, all built in world then
   *  mapped & clipped. Head size uses the WORLD width (lwWorld) exactly as
   *  _drawArrowSeg; ctx.lineWidth is the pre-scaled screen width. */
  _drawArrowSegDeep(aW, bW, color, lwScreen, lwWorld, withHead, box, toS) {
    const ctx = this.ctx;
    ctx.strokeStyle = color; ctx.lineWidth = lwScreen;
    const ang = Math.atan2(bW.y - aW.y, bW.x - aW.x);
    const len = Math.hypot(bW.x - aW.x, bW.y - aW.y);
    if (!withHead) { this._strokeClippedPath([toS(aW.x, aW.y), toS(bW.x, bW.y)], box, false); return; }
    ctx.fillStyle = color;
    const head = Math.min(len * 0.4, Math.max(lwWorld * 3.5, len * 0.12));
    const sxW = bW.x - Math.cos(ang) * head * 0.8, syW = bW.y - Math.sin(ang) * head * 0.8;
    this._strokeClippedPath([toS(aW.x, aW.y), toS(sxW, syW)], box, false);
    const h1 = { x: bW.x - Math.cos(ang - 0.5) * head, y: bW.y - Math.sin(ang - 0.5) * head };
    const h2 = { x: bW.x - Math.cos(ang + 0.5) * head, y: bW.y - Math.sin(ang + 0.5) * head };
    this._fillClippedPoly([toS(bW.x, bW.y), toS(h1.x, h1.y), toS(h2.x, h2.y)], box);
  }

  /** Screen-space variable-width brush: build the ribbon outline in WORLD (half-
   *  widths in world units, same as _drawRibbon), map to screen, clip-fill. */
  _drawRibbonDeep(it, lwWorld, col, box, toS) {
    const { ctx, camera } = this;
    let p = it.points;
    const base = lwWorld / 2;
    const minHalf = camera.screenToWorldLen(0.35);
    ctx.fillStyle = col;
    if (p.length === 1) {
      const r = Math.max(minHalf, base);                       // world radius
      const N = clamp(Math.round(Math.PI * Math.max(1, camera.worldToScreenLen(r))) || 12, 12, 512);
      const sp = [];
      for (let i = 0; i < N; i++) { const th = (i / N) * Math.PI * 2;
        sp.push(toS(p[0].x + Math.cos(th) * r, p[0].y + Math.sin(th) * r)); }
      this._fillClippedPoly(sp, box);
      return;
    }
    if (it.smooth && p.length >= 3) {
      let len = 0;
      for (let i = 1; i < p.length; i++) len += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
      const avgPx = camera.worldToScreenLen(len / (p.length - 1));
      const segs = clamp(Math.round(avgPx / 7), 4, 48);
      p = catmullRom(p, segs);
    }
    const outline = ribbonOutline(p, i => Math.max(minHalf, base * (p[i].p == null ? 1 : p[i].p)));
    if (!outline || !outline.length) return;
    this._fillClippedPoly(outline.map(o => toS(o.x, o.y)), box);
  }

  /** The world→world affine M taking the source bbox onto the frame rect (one
   *  recursion level); shared with scene.drosteMatrix (single source of truth). */
  _drosteMatrix(it) { return drosteMatrix(it); }

  /** Paint one recursion level: set the absolute device transform to
   *  camera∘M^k (×dpr), then draw every snapshot item under it. */
  _drawDrosteLevel(Mk, baseCSS, dpr, src, opacity) {
    const { ctx } = this;
    const m = mat2mul(baseCSS, Mk);
    ctx.setTransform(m.a * dpr, m.b * dpr, m.c * dpr, m.d * dpr, m.e * dpr, m.f * dpr);
    for (const s of src) {
      if (s.hidden || s.type === 'droste') continue; // never nest a portal (∞ guard)
      this._drawItem(s, false, opacity);
    }
  }

  /** The portal's snapshot, hue-rotated for recursion level `k` (each item's ink
   *  shifted hueDeg·k° round the wheel — the chromatic-tunnel vortex). Memoised
   *  per level on the renderer, keyed by (src ref, hueDeg), so a steady portal
   *  rebuilds nothing frame-to-frame; the cache resets if the art or hue change
   *  (a new src array / hue value). Geometry is shared by reference (read-only). */
  _drosteSrcForLevel(it, k, src, hueDeg) {
    let cache = this._drosteHueCache;
    if (!cache || cache.src !== src || cache.hue !== hueDeg) {
      cache = this._drosteHueCache = { src, hue: hueDeg, levels: new Map() };
    }
    let lv = cache.levels.get(k);
    if (!lv) {
      const deg = hueDeg * k;
      lv = src.map(s => hueShiftedItem(s, deg));
      cache.levels.set(k, lv);
    }
    return lv;
  }

  /**
   * Render a LIVE recursive Droste portal: the deep-copied snapshot `it.src` is
   * redrawn inside the frame at M, M², M³ … toward the recursion's fixed point.
   * Because the depth is driven by the on-screen size of each level, zooming
   * INTO the frame reveals more levels for free — the infinite-zoom payoff.
   *
   * Levels are drawn outer→inner so the deeper (smaller, central) copy paints on
   * top, exactly like a real Droste image. A lag-by-one occlusion test skips any
   * level whose successor already covers the whole viewport (so diving deep
   * doesn't redraw the astronomically-large early levels), and the loop stops
   * once a level is sub-pixel. Everything is clipped to the frame rect.
   */
  _drawDroste(it, alphaMul = 1) {
    const { ctx, camera } = this;
    const sb = it.srcBBox, src = it.src;
    const W0 = sb ? sb.maxX - sb.minX : 0, H0 = sb ? sb.maxY - sb.minY : 0;
    if (src && src.length && W0 > 1e-9 && H0 > 1e-9) {
      const M = this._drosteMatrix(it);
      const baseCSS = camera.matrix();
      const dpr = this.dpr;
      const opacity = (it.opacity == null ? 1 : it.opacity) * alphaMul;
      const hueDeg = +it.hue || 0;   // VORTEX hue: degrees added per recursion level
      const view = { x0: 0, y0: 0, x1: camera.width, y1: camera.height };
      const corners = [[sb.minX, sb.minY], [sb.maxX, sb.minY], [sb.maxX, sb.maxY], [sb.minX, sb.maxY]];
      const quadOf = (m) => corners.map(([x, y]) =>
        camera.worldToScreen(m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f));

      ctx.save();
      // Clip to the frame (level-1 region = M(srcBBox)); contains every nested level.
      const lvl1 = mat2mul(baseCSS, M);
      ctx.setTransform(lvl1.a * dpr, lvl1.b * dpr, lvl1.c * dpr, lvl1.d * dpr, lvl1.e * dpr, lvl1.f * dpr);
      ctx.beginPath(); ctx.rect(sb.minX, sb.minY, W0, H0); ctx.clip();

      const maxD = Math.min(it.maxDepth || 48, 256);
      let Mk = { ...M };          // M¹
      let pending = null;          // a level awaiting its successor's occlusion verdict
      let levels = 0;
      const draw = (lvl) => {
        if (lvl.sizePx >= 0.5 && quadAABBIntersects(lvl.quad, view)) {
          // VORTEX hue: level k's ink is rotated hueDeg·k round the wheel, so the
          // tunnel cycles through the spectrum as you dive (memoised per level).
          const lsrc = hueDeg ? this._drosteSrcForLevel(it, lvl.level, src, hueDeg) : src;
          this._drawDrosteLevel(lvl.Mk, baseCSS, dpr, lsrc, opacity);
          levels++;
        }
      };
      for (let k = 1; k <= maxD; k++) {
        const quad = quadOf(Mk);
        const sizePx = Math.hypot(quad[2].x - quad[0].x, quad[2].y - quad[0].y);
        if (!isFinite(sizePx)) break;
        const cur = { Mk, quad, sizePx, tiny: sizePx < 0.5, level: k };
        if (pending) {
          // Draw the pending (outer) level unless this (inner) one fully covers the view.
          const occluded = !cur.tiny && quadContainsRect(cur.quad, view);
          if (!occluded) draw(pending);
        }
        if (cur.tiny) { pending = null; break; } // this & all deeper levels sub-pixel
        pending = cur;
        Mk = mat2mul(M, Mk);       // advance to M^(k+1)
      }
      if (pending) draw(pending);   // last level: no successor ⇒ never occluded
      ctx.restore();
      this.lastDrosteLevels += levels;
    }
    if (this.drawDrosteFrame) this._drawDrosteFrame(it);
  }

  /** A calm dashed outline tracing the portal's frame edge, so an empty or
   *  finished portal is still findable and selectable. Drawn in world space
   *  (current CTM) with a screen-constant width/dash. */
  _drawDrosteFrame(it) {
    const { ctx, camera } = this;
    const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    const th = it.rot || 0, cos = Math.cos(th), sin = Math.sin(th);
    const hw = it.w / 2, hh = it.h / 2;
    const corner = (sx, sy) => ({ x: cx + cos * sx * hw - sin * sy * hh, y: cy + sin * sx * hw + cos * sy * hh });
    const p = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    ctx.save();
    ctx.globalAlpha = 0.55 * (it.opacity == null ? 1 : it.opacity);
    ctx.strokeStyle = it.color || '#7fd1ff';
    ctx.lineWidth = camera.screenToWorldLen(1.25);
    const dash = camera.screenToWorldLen(6);
    ctx.setLineDash([dash, dash]);
    ctx.beginPath();
    ctx.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(p[i].x, p[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /** Draw a line a→b, optionally capped with a filled arrowhead at b. */
  _drawArrowSeg(a, b, color, lw, withHead) {
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!withHead) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); return; }
    ctx.fillStyle = color;
    const head = Math.min(len * 0.4, Math.max(lw * 3.5, len * 0.12));
    // shaft stops short of the head so the tip is crisp
    const sx = b.x - Math.cos(ang) * head * 0.8, sy = b.y - Math.sin(ang) * head * 0.8;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(sx, sy); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - Math.cos(ang - 0.5) * head, b.y - Math.sin(ang - 0.5) * head);
    ctx.lineTo(b.x - Math.cos(ang + 0.5) * head, b.y - Math.sin(ang + 0.5) * head);
    ctx.closePath(); ctx.fill();
  }

  /** Paint a variable-width "brush" stroke: a filled ribbon whose half-width at
   *  each point is the base half-width times that point's pressure `p`. Recomputed
   *  every frame in world space, so it stays crisp at any zoom (a tiny floor keeps
   *  it visible when zoomed far out). A 1-point stroke renders as a round dab. */
  _drawRibbon(it, lw, col = it.color) {
    const { ctx, camera } = this;
    let p = it.points;
    const base = lw / 2;
    const minHalf = camera.screenToWorldLen(0.35);
    ctx.fillStyle = col;
    if (p.length === 1) {
      ctx.beginPath();
      ctx.arc(p[0].x, p[0].y, Math.max(minHalf, base), 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    // Catmull-Rom smoothing: resample at a density tied to on-screen size so the
    // curve stays smooth when zoomed in, cheap when small. World-space → crisp.
    if (it.smooth && p.length >= 3) {
      let len = 0;
      for (let i = 1; i < p.length; i++) len += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
      const avgPx = camera.worldToScreenLen(len / (p.length - 1));
      const segs = clamp(Math.round(avgPx / 7), 4, 48);
      p = catmullRom(p, segs);
    }
    const outline = ribbonOutline(p, i => Math.max(minHalf, base * (p[i].p == null ? 1 : p[i].p)));
    if (!outline || !outline.length) return;
    ctx.beginPath();
    ctx.moveTo(outline[0].x, outline[0].y);
    for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i].x, outline[i].y);
    ctx.closePath();
    ctx.fill();
  }

  /** Placeholder frame shown while an image decodes (or when it fails). */
  _drawImagePlaceholder(x, y, w, h, broken) {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = withAlpha(broken ? '#ff5b6e' : '#5b8cff', 0.10);
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = withAlpha(broken ? '#ff5b6e' : '#5b8cff', 0.6);
    ctx.lineWidth = this.camera.screenToWorldLen(1);
    ctx.setLineDash([this.camera.screenToWorldLen(6), this.camera.screenToWorldLen(4)]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    // diagonal cross conveys "image" without needing a font
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + w, y + h);
    ctx.moveTo(x + w, y); ctx.lineTo(x, y + h);
    ctx.stroke();
    ctx.restore();
  }

  // ---- selection ----
  _drawSelection(scene, ids, activeId = null) {
    const { ctx, camera } = this;
    // Only distinguish the "active" item when it actually matters (a multi-select,
    // where active = the parent target for Ctrl+P). It gets a solid warm outline.
    const showActive = activeId != null && ids.size > 1 && ids.has(activeId);
    let any = false, R = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    // A world AABB drawn as a 4-corner screen quad — an axis-aligned rectangle
    // when the view is upright, correctly turned when the canvas is rotated.
    const quad = (b) => {
      const p0 = camera.worldToScreen(b.minX, b.minY);
      const p1 = camera.worldToScreen(b.maxX, b.minY);
      const p2 = camera.worldToScreen(b.maxX, b.maxY);
      const p3 = camera.worldToScreen(b.minX, b.maxY);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.closePath();
      ctx.stroke();
    };
    for (const id of ids) {
      const it = scene.byId(id);
      if (!it || it.hidden) continue;
      if (!lodVisible(it, camera.scale)) continue; // don't frame invisible items
      any = true;
      const b = itemBBox(it, id => scene.byId(id));
      const isActive = showActive && id === activeId;
      if (isActive) {
        ctx.strokeStyle = withAlpha('#ffb454', 0.95); // warm = active / parent target
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = withAlpha('#5b8cff', 0.9);
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
      }
      quad(b);
      ctx.setLineDash([]);
      R.minX = Math.min(R.minX, b.minX); R.minY = Math.min(R.minY, b.minY);
      R.maxX = Math.max(R.maxX, b.maxX); R.maxY = Math.max(R.maxY, b.maxY);
    }
    if (any && ids.size > 1) {
      const m = camera.screenToWorldLen(3); // ~3px outset, in world units
      ctx.strokeStyle = withAlpha('#5b8cff', 0.5);
      quad({ minX: R.minX - m, minY: R.minY - m, maxX: R.maxX + m, maxY: R.maxY + m });
    }
  }

  /** Live smart-guide lines while dragging: a thin magenta line at each snapped
   *  alignment, spanning the union of the moving selection and the matched target.
   *  `guides` are in WORLD coords ({axis,pos,lo,hi,grid}); we project here so the
   *  guide tracks the snap exactly through zoom/pan. Grid guides are dashed. */
  _drawGuides(guides) {
    const { ctx, camera } = this;
    ctx.save();
    ctx.lineWidth = 1;
    for (const g of guides) {
      ctx.strokeStyle = withAlpha('#ff4d8d', g.grid ? 0.55 : 0.95);
      ctx.setLineDash(g.grid ? [5, 4] : []);
      ctx.beginPath();
      if (g.axis === 'x') {
        const x = camera.worldToScreen(g.pos, g.lo).x;
        const ya = camera.worldToScreen(g.pos, g.lo).y, yb = camera.worldToScreen(g.pos, g.hi).y;
        ctx.moveTo(x, Math.min(ya, yb) - 12); ctx.lineTo(x, Math.max(ya, yb) + 12);
      } else {
        const y = camera.worldToScreen(g.lo, g.pos).y;
        const xa = camera.worldToScreen(g.lo, g.pos).x, xb = camera.worldToScreen(g.hi, g.pos).x;
        ctx.moveTo(Math.min(xa, xb) - 12, y); ctx.lineTo(Math.max(xa, xb) + 12, y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  /** Small square grab handles at the selection corners for uniform resize. */
  _drawScaleHandles(handles) {
    const { ctx } = this;
    const sz = 4; // half-side in px
    ctx.lineWidth = 1.5;
    for (const h of handles) {
      ctx.fillStyle = withAlpha('#0e0f13', 0.9);
      ctx.strokeStyle = withAlpha('#5b8cff', 0.9);
      ctx.beginPath();
      ctx.rect(h.x - sz, h.y - sz, sz * 2, sz * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  /** A small round grab handle above the selection for free rotation. */
  _drawRotHandle(h) {
    const { ctx } = this;
    ctx.strokeStyle = withAlpha('#5b8cff', 0.85);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(h.x, h.y + 22); ctx.lineTo(h.x, h.y);   // stalk down to the bbox top
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha('#0e0f13', 0.9); ctx.fill();
    ctx.stroke();
  }

  /** The transform pivot marker: a small target with a crosshair. Warm/solid
   *  when the user has moved it (custom), cool/hollow when it's the auto centre. */
  _drawPivot(p) {
    const { ctx } = this;
    const col = p.custom ? '#ffb454' : '#5b8cff';
    const r = 7;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = withAlpha(col, 0.95);
    ctx.fillStyle = withAlpha('#0e0f13', p.custom ? 0.55 : 0.0);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    if (p.custom) ctx.fill();
    ctx.stroke();
    // crosshair through the centre, extending just past the ring
    ctx.beginPath();
    ctx.moveTo(p.x - r - 4, p.y); ctx.lineTo(p.x + r + 4, p.y);
    ctx.moveTo(p.x, p.y - r - 4); ctx.lineTo(p.x, p.y + r + 4);
    ctx.stroke();
    // centre dot
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(col, 0.95);
    ctx.fill();
  }

  /**
   * The mandala/symmetry overlay: a soft fill of the FUNDAMENTAL DOMAIN (the region
   * you draw into — `domain` polygon for wallpaper groups, or `wedge` {a0,a1} sector
   * for mandala mode), faint radial guide spokes showing the N wedges (plus dashed
   * bisectors when kaleidoscope mirror is on), the lattice crosses / dashed unit cell
   * for a wallpaper group, and a warm, grabbable anchor handle at the symmetry centre.
   * `s` = {x, y, slices, mirror, active, grid, cell, domain, wedge} in screen space.
   */
  _drawSymmetry(s) {
    const { ctx, camera } = this;
    const R = Math.hypot(camera.width, camera.height); // reach the far corner
    ctx.save();
    // Fundamental-domain highlight — the one region you draw into, which the symmetry
    // then replicates to fill the plane. A soft warm fill (echoing the warm anchor =
    // "the active zone"), painted FIRST so the spoke/cell guides read on top of it.
    const domFill = withAlpha('#ffb454', 0.13);
    if (s.domain && s.domain.length >= 3) {
      ctx.fillStyle = domFill;
      ctx.beginPath();
      ctx.moveTo(s.domain[0].x, s.domain[0].y);
      for (let i = 1; i < s.domain.length; i++) ctx.lineTo(s.domain[i].x, s.domain[i].y);
      ctx.closePath();
      ctx.fill();
    }
    if (s.wedge) {                       // mandala sector (screen-space angles)
      ctx.fillStyle = domFill;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x + Math.cos(s.wedge.a0) * R, s.y + Math.sin(s.wedge.a0) * R);
      ctx.arc(s.x, s.y, R, s.wedge.a0, s.wedge.a1);
      ctx.closePath();
      ctx.fill();
    }
    if (s.active) {
      const n = Math.max(1, s.slices);
      ctx.lineWidth = 1;
      ctx.strokeStyle = withAlpha('#5b8cff', 0.18);
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const ang = k * (Math.PI * 2) / n;
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x + Math.cos(ang) * R, s.y + Math.sin(ang) * R);
      }
      ctx.stroke();
      if (s.mirror) {
        ctx.setLineDash([4, 5]);
        ctx.strokeStyle = withAlpha('#5b8cff', 0.12);
        ctx.beginPath();
        for (let k = 0; k < n; k++) {
          const ang = k * (Math.PI * 2) / n + Math.PI / n; // wedge bisectors
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(s.x + Math.cos(ang) * R, s.y + Math.sin(ang) * R);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // wallpaper lattice: a faint cool cross at each tile (mandala) centre
    if (s.grid && s.grid.length) {
      ctx.strokeStyle = withAlpha('#5b8cff', 0.32);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const p of s.grid) {
        ctx.moveTo(p.x - 5, p.y); ctx.lineTo(p.x + 5, p.y);
        ctx.moveTo(p.x, p.y - 5); ctx.lineTo(p.x, p.y + 5);
      }
      ctx.stroke();
    }
    // wallpaper unit cell: a dashed parallelogram outlining the ONE repeating tile,
    // so it reads "draw in here — the group fills the rest of the plane".
    if (s.cell && s.cell.length === 4) {
      ctx.strokeStyle = withAlpha('#5b8cff', 0.5);
      ctx.lineWidth = 1.25;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(s.cell[0].x, s.cell[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(s.cell[i].x, s.cell[i].y);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // anchor handle (warm = grabbable, like a custom pivot)
    const col = '#ffb454', r = 8;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = withAlpha(col, 0.95);
    ctx.fillStyle = withAlpha('#0e0f13', 0.5);
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x - r - 4, s.y); ctx.lineTo(s.x + r + 4, s.y);
    ctx.moveTo(s.x, s.y - r - 4); ctx.lineTo(s.x, s.y + r + 4);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(s.x, s.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(col, 0.95); ctx.fill();
    ctx.restore();
  }

  /**
   * The cinematic MOTION-PATH overlay (a composition aid; never in the export).
   * ONE visual language — the camera's framing rectangle — describes the whole
   * flight-plan: BOLD numbered frames mark the pinned "shots" the camera settles
   * on, and FAINT frames sampled at EQUAL ticks along the glide are the velocity
   * readout (they bunch where the camera is slow — near a keyframe under ease-in-
   * out — and spread where it's fast). So a pure zoom DIVE reads as nested rings
   * and a PAN as a marching snake, with no separate gauge. `mp` = {keyframes,
   * samples, currentPage} of camera snapshots {x,y,scale,rot} in WORLD space; each
   * rect is the region that camera frames at the live viewport aspect, projected
   * through the current editing camera. A tether joins the sample centres, drawn
   * only where the centre actually moves (so a pure dive shows no central blob).
   */
  _drawMotionPath(mp) {
    const { ctx, camera } = this;
    const COOL = '#5b8cff', WARM = '#ffb454';
    const SANE = 1e7;   // beyond this many px the projection is off into infinity — skip
    const onScreenish = p => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) < SANE && Math.abs(p.y) < SANE;
    // World corners of the rect a camera frames, projected to the current view.
    // null when any corner blows past sane pixel coords (a keyframe far outside the
    // current zoom) — skip rather than stroke a near-infinite polygon.
    const corners = (cam) => {
      const hw = (camera.width / 2) / cam.scale, hh = (camera.height / 2) / cam.scale;
      const cs = Math.cos(cam.rot), sn = Math.sin(cam.rot);
      const out = [];
      for (const [ox, oy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
        const p = camera.worldToScreen(cam.x + cs * ox + sn * oy, cam.y - sn * ox + cs * oy);  // world = centre + R(-rot)·(ox,oy)
        if (!onScreenish(p)) return null;
        out.push(p);
      }
      return out;
    };
    const tracePoly = (pts) => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
    };
    ctx.save();
    ctx.lineJoin = 'round';

    // 1) FAINT sample frames — the velocity readout (equal-tick spacing ⇒ density).
    // VELOCITY-MAPPED OPACITY (gemma's refinement): fade each frame by how far it
    // sits from its neighbour, so the overlay reads as a momentum HEAT-MAP — bright
    // where the camera dwells (frames bunched), dim where it races (frames spread).
    // The "spacing" is the mean on-screen displacement of the four CORNERS from the
    // previous sample, so it captures BOTH a pan (corners translate) and a dive
    // (corners breathe out/in as the frame resizes) — bright near every keyframe.
    ctx.lineWidth = 1;
    const sampleCorners = (mp.samples || []).map(s => corners(s));
    for (let i = 0; i < sampleCorners.length; i++) {
      const c = sampleCorners[i];
      if (!c) continue;
      const prev = i > 0 ? sampleCorners[i - 1] : sampleCorners[i + 1];   // forward-diff the first
      let d = 0;
      if (prev) { for (let k = 0; k < 4; k++) d += Math.hypot(c[k].x - prev[k].x, c[k].y - prev[k].y); d /= 4; }
      const alpha = 0.08 + 0.22 / (1 + d / 12);   // reciprocal falloff: ~0.30 dwelling → ~0.08 racing
      ctx.strokeStyle = withAlpha(COOL, alpha);
      tracePoly(c); ctx.stroke();
    }
    // tether through the sample CENTRES — only segments that actually move on
    // screen (a pure dive keeps the centre fixed, so no central ink blob).
    const centres = (mp.samples || []).map(s => camera.worldToScreen(s.x, s.y));
    ctx.strokeStyle = withAlpha(COOL, 0.3);
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    for (let i = 1; i < centres.length; i++) {
      const a = centres[i - 1], b = centres[i];
      if (!onScreenish(a) || !onScreenish(b)) continue;
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1.5) continue;   // ε — skip near-stationary
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // 2) BOLD keyframe frames — the "shots". Current page warm, the rest cool.
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const kf of (mp.keyframes || [])) {
      const isCur = kf.page === mp.currentPage;
      const col = isCur ? WARM : COOL;
      const c = corners(kf);
      const ctr = camera.worldToScreen(kf.x, kf.y);
      if (c) {
        ctx.strokeStyle = withAlpha(col, isCur ? 0.95 : 0.72);
        ctx.lineWidth = isCur ? 2 : 1.5;
        tracePoly(c);
        ctx.stroke();
      }
      // centre crosshair tick
      if (onScreenish(ctr)) {
        ctx.strokeStyle = withAlpha(col, 0.8);
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(ctr.x - 5, ctr.y); ctx.lineTo(ctr.x + 5, ctr.y);
        ctx.moveTo(ctr.x, ctr.y - 5); ctx.lineTo(ctr.x, ctr.y + 5);
        ctx.stroke();
      }
      // numbered badge at the rect's top-left corner (distinct per nested/side
      // rect), falling back to just above the centre tick when the rect is undrawable.
      const label = String(kf.page + 1);
      let lx, ly;
      if (c) { lx = c[0].x; ly = c[0].y; }
      else if (onScreenish(ctr)) { lx = ctr.x - 4; ly = ctr.y - 20; }
      else continue;
      const w = ctx.measureText(label).width;
      ctx.fillStyle = withAlpha('#0e0f13', 0.82);
      ctx.fillRect(lx + 2, ly + 2, w + 8, 16);
      ctx.fillStyle = withAlpha(col, 0.98);
      ctx.fillText(label, lx + 6, ly + 4);
    }
    ctx.restore();
  }

  /** While editing a pixel sprite: a bright border around it + a faint per-cell
   *  grid once the cells are big enough on screen to aim at. `it` is the sprite
   *  item; we project its (possibly rotated) box via the camera. */
  _drawPixelOverlay(it, mirror, sel) {
    const { ctx, camera } = this;
    const cw = (it.w / it.pw) * camera.scale; // on-screen cell size (px)
    const ch = (it.h / it.ph) * camera.scale;
    ctx.save();
    // work in the sprite's rotated screen frame so the grid lines up when turned
    const c = camera.worldToScreen(it.x + it.w / 2, it.y + it.h / 2);
    ctx.translate(c.x, c.y);
    // the sprite's own rotation PLUS the view rotation, so the overlay stays
    // glued to the (world-space) sprite when the canvas is turned.
    const spin = (it.rot || 0) + camera.rot;
    if (spin) ctx.rotate(spin);
    const W = it.w * camera.scale, H = it.h * camera.scale;
    const ox = -W / 2, oy = -H / 2;
    // per-cell grid (only when cells are comfortably clickable)
    if (cw >= 7 && ch >= 7) {
      ctx.strokeStyle = withAlpha('#ffffff', 0.18);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < it.pw; i++) { const x = ox + i * cw; ctx.moveTo(x, oy); ctx.lineTo(x, oy + H); }
      for (let j = 1; j < it.ph; j++) { const y = oy + j * ch; ctx.moveTo(ox, y); ctx.lineTo(ox + W, y); }
      ctx.stroke();
    }
    // mirror-painting axes (cyan, dashed) — drawn through the sprite centre
    if (mirror && (mirror.x || mirror.y)) {
      ctx.strokeStyle = withAlpha('#22d3ee', 0.9);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      if (mirror.x) { ctx.moveTo(0, oy); ctx.lineTo(0, oy + H); } // vertical axis
      if (mirror.y) { ctx.moveTo(ox, 0); ctx.lineTo(ox + W, 0); } // horizontal axis
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // sprite border (accent)
    ctx.strokeStyle = withAlpha('#ffd43b', 0.95);
    ctx.lineWidth = 2;
    ctx.strokeRect(ox, oy, W, H);
    // SELECT marquee: "marching ants" (a dark base line under a bright dashed line)
    // over the selected cells, with a faint fill so the region reads at a glance.
    // Drawn last so it sits above the grid + border. A plain rectangle traces its
    // bbox; a wand (mask) selection traces the irregular cell boundary.
    if (sel && sel.mask) {
      const m = sel.mask, sw = sel.w, sh = sel.h;
      const on = (lx, ly) => lx >= 0 && ly >= 0 && lx < sw && ly < sh && m[ly * sw + lx];
      // faint fill of the selected cells
      ctx.fillStyle = withAlpha('#ffffff', 0.12);
      for (let ly = 0; ly < sh; ly++) for (let lx = 0; lx < sw; lx++) {
        if (!m[ly * sw + lx]) continue;
        ctx.fillRect(ox + (sel.x + lx) * cw, oy + (sel.y + ly) * ch, cw, ch);
      }
      // boundary = every cell edge facing an unselected neighbour
      const edges = (p) => {
        for (let ly = 0; ly < sh; ly++) for (let lx = 0; lx < sw; lx++) {
          if (!m[ly * sw + lx]) continue;
          const x0 = ox + (sel.x + lx) * cw + 0.5, y0 = oy + (sel.y + ly) * ch + 0.5;
          if (!on(lx, ly - 1)) { p.moveTo(x0, y0); p.lineTo(x0 + cw, y0); }
          if (!on(lx, ly + 1)) { p.moveTo(x0, y0 + ch); p.lineTo(x0 + cw, y0 + ch); }
          if (!on(lx - 1, ly)) { p.moveTo(x0, y0); p.lineTo(x0, y0 + ch); }
          if (!on(lx + 1, ly)) { p.moveTo(x0 + cw, y0); p.lineTo(x0 + cw, y0 + ch); }
        }
      };
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.strokeStyle = withAlpha('#000000', 0.85);
      ctx.beginPath(); edges(ctx); ctx.stroke();
      ctx.strokeStyle = withAlpha('#ffffff', 0.95);
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); edges(ctx); ctx.stroke();
      ctx.setLineDash([]);
    } else if (sel) {
      const sx = ox + sel.x * cw, sy = oy + sel.y * ch;
      const swd = sel.w * cw, shd = sel.h * ch;
      ctx.fillStyle = withAlpha('#ffffff', 0.12);
      ctx.fillRect(sx, sy, swd, shd);
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.strokeStyle = withAlpha('#000000', 0.85);
      ctx.strokeRect(sx + 0.5, sy + 0.5, swd, shd);
      ctx.strokeStyle = withAlpha('#ffffff', 0.95);
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(sx + 0.5, sy + 0.5, swd, shd);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  _drawMarquee(m) {
    const { ctx } = this;
    const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
    const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
    ctx.fillStyle = withAlpha('#5b8cff', 0.10);
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = withAlpha('#5b8cff', 0.8);
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  }

  _drawEraserCursor(c) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha('#ff5b6e', 0.9);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
