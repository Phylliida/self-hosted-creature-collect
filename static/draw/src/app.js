import { Camera } from './camera.js';
import { Scene, makeStroke, makeLine, makeRect, makeEllipse, makeText, makeArrow, makePolygon,
         makeImage, makeConnector, makeDroste, makeFold, makeSpin, makeGlide, REFOPS, boxEdgePoint, translateItem, scaleItemAbout, rotateItemsAbout,
         reflectItemsAbout, itemBBox, itemCentroidMass, lodVisible, drosteSelfSimilarity, cloneFill } from './scene.js';
import { Renderer } from './renderer.js';
import { Minimap } from './minimap.js';
import { History, addItemsCmd, removeItemsCmd, moveItemsCmd, reorderCmd } from './history.js';
import { simplify, debounce, clamp, dist, formatZoom, formatCoord, pointInRect, catmullRom, shiftHue, hueShiftedItem } from './util.js';
import { GENERATORS, curveOrderMeta } from './generators.js';
import { sceneToSVG } from './svg.js';
import { exportGIF, spriteSheet, renderFrames, renderDrosteLoopFrames, exportDrosteLoopGIF } from './animexport.js';
import { makePixel, worldToPixel, worldToPixelUnclamped, getPixel, bresenhamLine,
         rectCells, ellipseCells, floodFill, pixelRGBA, clampDim, TRANSPARENT, MAX_DIM,
         PIXEL_PALETTES, DEFAULT_PALETTE, DEFAULT_CELL,
         quantizeImage, resizePixelData, buildPaletteFromImage,
         remapIndex, swapIndex, flipData, rotateData90,
         extractRegion, blitRegion, fillRegion, moveRegion, flipRegion, rotateRegion,
         magicWandMask, invertSelectionMask, combineSelections } from './pixel.js';
import * as storage from './storage.js';
import { buildCommands, contextHint } from './commands.js';
import { wallpaperPlacements, wallpaperCellCount, wallpaperLattice, fundamentalDomain,
         isWallpaperGroup, WALLPAPER_GROUPS, WALLPAPER_NAMES } from './wallpaper.js';
import { friezePlacements, friezeCellCount, friezeFundamentalDomain, friezeBandHeight,
         isFriezeGroup, FRIEZE_GROUPS, FRIEZE_NAMES } from './frieze.js';

const PALETTE = [
  '#e8e8ef', '#ff5b6e', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9',
  '#4dabf7', '#5b8cff', '#b197fc', '#f783ac', '#9c6644', '#0e0f13',
];

// The 16 CSS blend modes (same set the per-item Blend <select> offers) used to
// populate each layer head's blend dropdown. v = the canvas/SVG value, t = label.
const LAYER_BLEND_MODES = [
  { v: 'normal', t: 'Normal' }, { v: 'multiply', t: 'Multiply' }, { v: 'screen', t: 'Screen' },
  { v: 'overlay', t: 'Overlay' }, { v: 'darken', t: 'Darken' }, { v: 'lighten', t: 'Lighten' },
  { v: 'color-dodge', t: 'Dodge' }, { v: 'color-burn', t: 'Burn' }, { v: 'hard-light', t: 'Hard light' },
  { v: 'soft-light', t: 'Soft light' }, { v: 'difference', t: 'Difference' }, { v: 'exclusion', t: 'Exclusion' },
  { v: 'hue', t: 'Hue' }, { v: 'saturation', t: 'Saturation' }, { v: 'color', t: 'Color' },
  { v: 'luminosity', t: 'Luminosity' },
];

/** Clamp a user-supplied "palette size" into a sensible [2,64] integer range
 *  (the median-cut convert builds at most this many slots; default 16). */
const clampColors = (n) => Math.max(2, Math.min(64, Math.round(Number(n) || 16)));

/** Move selected ids one step toward front (dir>0) or back (dir<0), keeping
 *  relative order and never letting selected items pass through each other. */
function shiftOrder(ids, sel, dir) {
  const arr = ids.slice();
  if (dir > 0) {
    for (let i = arr.length - 2; i >= 0; i--)
      if (sel.has(arr[i]) && !sel.has(arr[i + 1])) { const t = arr[i]; arr[i] = arr[i + 1]; arr[i + 1] = t; }
  } else {
    for (let i = 1; i < arr.length; i++)
      if (sel.has(arr[i]) && !sel.has(arr[i - 1])) { const t = arr[i]; arr[i] = arr[i - 1]; arr[i - 1] = t; }
  }
  return arr;
}

/** Validate a camera-keyframe snapshot (a camera.serialize() = {x,y,scale,rot})
 *  or return null. Scale must be finite and positive; rot defaults to 0. Used to
 *  scrub keyframes coming from localStorage / loaded documents so a corrupt slot
 *  can never poison the cinematic path. */
function sanitizeCam(c) {
  if (!c || typeof c !== 'object') return null;
  const x = +c.x, y = +c.y, scale = +c.scale, rot = +c.rot;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale) || scale <= 0) return null;
  return { x, y, scale, rot: Number.isFinite(rot) ? rot : 0 };
}

/** Interpolate between two camera keyframes at parameter t∈[0,1]. Position is
 *  linear; rotation follows the SHORTEST arc; ZOOM is GEOMETRIC —
 *  scale = a·(b/a)^t = exp(lerp(ln a, ln b, t)) — so equal time steps multiply
 *  the zoom by a constant factor (perceptually constant-velocity diving, the
 *  whole point of an infinite-zoom tool). The geometric midpoint of 1→100 is 10,
 *  not 50.5. */
function lerpCamera(a, b, t) {
  const lin = (p, q) => p + (q - p) * t;
  const TAU = Math.PI * 2;
  let dr = (b.rot - a.rot) % TAU;
  if (dr > Math.PI) dr -= TAU; else if (dr < -Math.PI) dr += TAU;
  return {
    x: lin(a.x, b.x),
    y: lin(a.y, b.y),
    scale: a.scale * Math.pow(b.scale / a.scale, t),
    rot: a.rot + dr * t,
  };
}

/** Camera-glide EASING curves. Each remaps the raw segment progress t∈[0,1] —
 *  every curve fixes the endpoints ease(0)=0, ease(1)=1, so a keyframe is hit
 *  exactly; only the VELOCITY between keyframes is reshaped. Applied per segment
 *  (including the cyclic wrap), so 'smooth'/'smoother' bring the camera to a near
 *  stop at each pinned page (a cinematic "settle on the shot, then glide on"),
 *  while 'in'/'out' bias the dive toward a slow launch / a gentle arrival.
 *  'linear' is the DEFAULT (constant velocity) and the identity map, so the
 *  geometric-zoom contract — equal ticks multiply scale by a constant — is the
 *  out-of-the-box behaviour; the others are an opt-in motion choice. */
const EASE_MODES = [
  { id: 'linear',   label: 'Linear',    f: t => t },
  { id: 'smooth',   label: 'Smooth',    f: t => t * t * (3 - 2 * t) },                 // smoothstep (cubic)
  { id: 'smoother', label: 'Smoother',  f: t => t * t * t * (t * (t * 6 - 15) + 10) }, // smootherstep (quintic)
  { id: 'in',       label: 'Ease in',   f: t => t * t },                               // accelerate — slow launch
  { id: 'out',      label: 'Ease out',  f: t => t * (2 - t) },                         // decelerate — gentle arrival
];
const EASE_BY_ID = new Map(EASE_MODES.map(m => [m.id, m]));
/** Remap segment progress through the named easing curve (clamped, linear on an
 *  unknown id). Pure — the whole cinematic path stays a deterministic function. */
function easeProgress(t, mode) {
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const m = EASE_BY_ID.get(mode);
  return m ? m.f(u) : u;
}

class App {
  constructor() {
    this.canvas = document.getElementById('canvas');
    this.camera = new Camera(window.innerWidth, window.innerHeight);
    this.scene = new Scene();
    this.renderer = new Renderer(this.canvas, this.camera);
    this.history = new History(this.scene);
    this.minimap = new Minimap(document.getElementById('minimap'), this.camera, this.scene);

    this.tool = 'pen';
    this.style = { color: '#e8e8ef', width: 3, fill: null, fillOn: false, fillColor: '#5b8cff',
                   fillType: 'flat', fillColor2: '#b14bff', fillAngle: 0,
                   textSize: 24, sides: 5, star: true, opacity: 1, widthMode: 'world',
                   clampMin: 1.5, clampMax: 24, blend: 'normal' };
    this.snap = false;           // grid snap (drawing + move) — toggled by #snapToggle
    // Smart guides: while dragging a selection, snap its bbox edges/centres to
    // OTHER items' edges/centres (and the grid when `snap` is on), drawing live
    // magenta guide lines at the matched alignment. ON by default. Alt bypasses.
    this.guides = { on: true };
    this.activeGuides = null;     // guide segments (world coords) for the live drag
    this._snapCands = null;       // snap target cache, built once per move gesture
    // Auto-pivot mode for rotate/scale: false = centre of the selection's bbox
    // (default); true = the selection's true CENTRE OF MASS (area/mass-weighted
    // centroid — a triangle pivots at its centroid, not the bbox middle). A
    // user-dropped custom pivot (Shift+P) always overrides either. See _pivotWorld.
    this.comPivot = false;
    this._loadSnapCfg();
    // Recursive-stamp / portal recursion knobs (Danielle's 2026-06-27 ask). The
    // CHILD ZOOM is the per-level scale: each nested copy is this fraction of its
    // parent's size (0.42 → each generation is 42% the last → a shrinking pile).
    // It drives BOTH the baked recursive STAMP and the live Droste PORTAL frame
    // (the same quantity: how much each nested copy shrinks). LEVELS is how many
    // shrinking generations the STAMP bakes (the portal is always ∞, so it ignores
    // this). Defaults match the prior hardcoded values → behaviour byte-identical
    // until the user touches a slider.
    this.stampFactor = 0.42;
    this.stampDepth = 3;
    // VORTEX-STAMP knobs: per-level spin (deg) + hue step (deg) + opacity fade
    // (0..1 fraction). All zero by default → the stamp is a plain concentric pile
    // and every clone is byte-identical to before (each effect is guarded off at 0).
    this.stampSpin = 0;
    this.stampHue = 0;
    this.stampFade = 0;
    // DRIFT: per-level TRANSLATE offset (signed fraction of the selection's bbox,
    // −1..1) along the selection's +X axis. 0 = a centred pile; non-zero makes the
    // shrinking copies wander off-axis into a drifting spiral / comet-tail (Spin
    // sweeps that axis around, so one signed knob spans every arm shape). Guarded
    // off at 0 → byte-identical clones. Stamp-only (see recursiveStamp / DESIGN 74).
    this.stampDrift = 0;
    this._loadStampCfg();
    this.brushSmooth = true;     // Catmull-Rom smoothing for new brush strokes

    // Stop-motion flipbook ("sticky-note flipbook — draw each page"). OFF by
    // default, so the app is a normal infinite canvas until you turn it on.
    // Each item carries an optional `frame` (0-based page; absent = page 0).
    // `holds[f]` = how many base ticks (1/fps) page f is shown — per-frame
    // timing for holds/eases. Default 1 each. Kept in sync with frame insert/
    // delete (incl. undo). `fps` is the base rate; a hold of 2 = twice as long.
    // `cams[f]` = an optional per-page CAMERA KEYFRAME {x,y,scale,rot} (a
    // camera.serialize() snapshot) or null. When ≥1 page is pinned, playback
    // glides the camera between the pinned pages — "cinematic zoom": position
    // lerps, rotation takes the shortest arc, and ZOOM interpolates GEOMETRICALLY
    // (constant velocity in log-space) so an infinite-zoom dive feels even. The
    // array rides the same splices as `holds` through add/dup/delete/reorder.
    this.anim = { on: false, current: 0, count: 1, onion: 1, fps: 6,
                  tint: true, loop: true, playing: false, holds: [1], cams: [null],
                  dither: false, ease: 'linear', showPath: true, hq: true };
    this._playTimer = null;   // requestAnimationFrame id while playing
    this._preplayCam = null;  // editing camera saved for non-destructive preview

    // Symmetry / mandala mode. OFF by default. When on, anything drawn with a
    // drawing tool (pen/brush/line/arrow/rect/ellipse/star) is expanded into
    // `slices` radial copies about (cx,cy) — plus a mirrored copy of each when
    // `mirror` is on (a kaleidoscope) — all baked into ONE group on commit, so
    // undo/flipbook/selection treat the mandala as a single entity. The centre
    // is a draggable on-canvas anchor; defaults to the world origin.
    // `grid` is the sibling TRANSLATIONAL (wallpaper) mode: the radial result is
    // tiled across a cols×rows lattice (spacing dx,dy world units), centred on the
    // same anchor → a grid of mandalas. OFF by default; composes with radial.
    // `group` selects one of the 17 mathematical WALLPAPER GROUPS (p1…p6m). When
    // set (and `on`), it OVERRIDES the radial/grid path: anything drawn is tiled by
    // that group's full symmetry — its rotations, mirrors and glide reflections —
    // across a `cell`-spaced lattice, `reps` cells out from the anchor. null ⇒ the
    // legacy radial+grid behaviour is byte-identical. See src/wallpaper.js.
    // `showDomain` highlights the FUNDAMENTAL DOMAIN — the one region you actually
    // draw into, which the symmetry then replicates to fill the plane. A teaching
    // aid (the user's recurring "make it accessible" theme): a soft tint of the
    // mandala wedge, or of a wallpaper group's Dirichlet fundamental cell. On by
    // default; only ever painted while symmetry is on. See wallpaper.fundamentalDomain.
    this.symmetry = { on: false, slices: 6, mirror: false, cx: 0, cy: 0,
                      grid: { on: false, cols: 3, rows: 3, dx: 120, dy: 120 },
                      group: null, cell: 160, reps: 2, showDomain: true };

    // Pixel-art mode ("in addition to regular mode, support pixel art features").
    // A pixel SPRITE is a normal world item (type 'pixel') that floats in the
    // infinite canvas and stays crisp via nearest-neighbour upscaling. `editing`
    // routes canvas presses to the sprite's raster tools instead of vector
    // drawing; `targetId` is the sprite under edit. `tool`/`color`/the new-sprite
    // defaults (pw/ph/cell/paletteName) persist; `editing`/`targetId` do not.
    this.pixel = { editing: false, panelOpen: false, targetId: null, tool: 'pencil', color: 0,
                   rectFill: false, pw: 32, ph: 32, cell: DEFAULT_CELL,
                   paletteName: DEFAULT_PALETTE,
                   // image→sprite convert: when `fromImage` is on, derive the
                   // sprite's palette from the image itself (median-cut to `colors`
                   // slots) instead of snapping to the named preset.
                   fromImage: false, colors: 16,
                   // mirror/symmetry painting: reflect every plotted cell across
                   // the sprite's vertical (x) and/or horizontal (y) mid-axis.
                   mirror: { x: false, y: false },
                   // SELECT marquee + MAGIC WAND: `sel` is the current selection
                   // (or null) — {x,y,w,h} for a rectangle, or {x,y,w,h,mask} for a
                   // non-rectangular (wand) shape; `clip` an internal pixel
                   // clipboard {pw,ph,data} (or null) that survives across sprites
                   // for cut/copy/paste. `wandContiguous` = the wand selects only
                   // the touching colour blob (vs every cell of that colour). The
                   // selection + clipboard are ephemeral (not persisted).
                   sel: null, clip: null, wandContiguous: true };
    this._loadPixel();

    // interaction state
    this.draft = null;
    // Spin-tool placement state: the pivot set by the first click (awaiting the
    // angle-sweep drag), and the live guide preview handed to the renderer.
    this._spinPivot = null;
    this._refGuide = null;
    this.selectedIds = new Set();
    // The "active" item — the most recently clicked member of the selection. It
    // is the PARENT target for parentSelection() (Blender-style) and is drawn
    // with a distinct outline so the parenting action never feels random.
    this._activeId = null;
    // Custom transform pivot (world coords) for rotate/scale. null = auto, which
    // means the selection's bbox centre. Set by dragging the pivot marker; clears
    // when the selection is fully replaced or emptied. Not persisted (ephemeral UI).
    this.pivot = null;
    this.marquee = null;
    this.eraserCursor = null;
    this.pointers = new Map();   // pointerId -> {x,y} screen
    this.active = null;          // current single-pointer gesture
    this.pinch = null;
    this.spaceDown = false;
    this.mouseWorld = { x: 0, y: 0 };

    this._dirty = true;
    this._stats = { frames: 0, lastRenderMs: 0 };

    this.autosave = debounce(() => storage.saveLocal(this.scene, this.camera), 400);
    // rebuild the Objects/layers list off the hot path (coalesces edit bursts)
    this._scheduleLayers = debounce(() => this._renderLayers(), 120);
    // rebuild the flipbook thumbnail strip off the hot path (re-renders only
    // when the document content actually changed — guarded by _docRev)
    this._scheduleThumbs = debounce(() => this._renderThumbs(), 160);
    this._docRev = 0;        // bumped on every doc mutation; thumbs cache key
    this._thumbSig = null;   // last-rendered thumbnail signature

    this.scene.onChange = () => { this._docRev++; this.requestRender(); this.autosave(); this._updateHud(); };
    this.history.onChange = () => { this._updateUndoRedo(); };
    // repaint when a deferred image bitmap finishes decoding
    this.renderer.onAsyncLoad = () => this.requestRender();

    this._bindUI();
    this._bindInput();
    this._bindKeys();
    this._bindImageDrop();
    this._buildSwatches();
    this._bindPixelUI();
    this._bindPalette();
    this._initMobile();

    this._restore();
    this._restoreAnim();
    this._loadSymmetry();
    this._syncSymmetryUI();
    this._loadBookmarks();
    this._renderBookmarks();
    this._renderLayers();
    // Objects + Bookmarks panels collapse by default (a calm first load — see
    // their HTML). Only restore a saved EXPANDED state; default/'collapsed' stays.
    try { if (localStorage.getItem('infinizoom.layersCollapsed') === '0') this.toggleLayersPanel(false); } catch { /* ignore */ }
    try { if (localStorage.getItem('infinizoom.bookmarksCollapsed') === '0') this.toggleBookmarkPanel(false); } catch { /* ignore */ }
    try { if (localStorage.getItem('infinizoom.focusMode') === '1') this.setFocus(true, { silent: true }); } catch { /* ignore */ }
    this._updateAnimUI();
    this._syncPixelUI();
    this._startLoop();
    this._installTestApi();
    this._updateHud();
    this._updateUndoRedo();
    this.setTool('pen');
    // A genuine first-run newcomer already gets the coachmark welcome (just draw /
    // ⌘K for any command / scroll to zoom · drag to pan). Firing the near-identical
    // "ready" toast at the same instant, in the same lower band, is a DOUBLE welcome
    // — overwhelm exactly when calm matters most (the §1.3 "don't crowd the onramp"
    // principle). So the ready-toast is now a *returning-user* liveness cue only:
    // first run → one welcome (the coachmark); thereafter → the brief toast.
    let coachSeen = false;
    try { coachSeen = localStorage.getItem('infinizoom.coachSeen') === '1'; } catch { /* ignore */ }
    if (coachSeen) this._toast('∞ Infinizoom ready — draw, scroll to zoom, drag to pan');
    this._initCoachmark();
  }

  // ---------------- coordinate helpers ----------------
  evtScreen(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  toWorld(sx, sy) { return this.camera.screenToWorld(sx, sy); }

  /** Grid step in world units, matching the renderer's adaptive grid. */
  gridStep() {
    const targetPx = 78;
    const worldPerTarget = targetPx / this.camera.scale;
    const pow = Math.pow(10, Math.floor(Math.log10(worldPerTarget)));
    let step = pow;
    for (const m of [1, 2, 5, 10]) {
      step = pow * m;
      if (pow * m * this.camera.scale >= targetPx) break;
    }
    return step;
  }
  maybeSnap(p) {
    if (!this.snap) return p;
    const s = this.gridStep();
    return { x: Math.round(p.x / s) * s, y: Math.round(p.y / s) * s };
  }

  // ---------------- snapping / smart guides ----------------
  /** Toggle grid snap (drawing + drag). Keeps the checkbox + storage in sync. */
  setSnap(on) {
    this.snap = !!on;
    const el = document.getElementById('snapToggle'); if (el) el.checked = this.snap;
    this._saveSnapCfg();
  }
  /** Toggle smart guides (snap-to-item-edges while dragging). */
  setGuides(on) {
    this.guides.on = !!on;
    const el = document.getElementById('guidesToggle'); if (el) el.checked = this.guides.on;
    this._saveSnapCfg();
  }
  _saveSnapCfg() {
    try { localStorage.setItem('infinizoom.snapcfg', JSON.stringify({ snap: this.snap, guides: this.guides.on, comPivot: this.comPivot })); } catch {}
  }
  _loadSnapCfg() {
    try {
      const r = JSON.parse(localStorage.getItem('infinizoom.snapcfg') || 'null');
      if (r) { this.snap = !!r.snap; this.guides.on = r.guides !== false; this.comPivot = !!r.comPivot; }
    } catch {}
  }

  /** Recursion CHILD ZOOM — the per-level scale (0.05..0.95). Each nested copy is
   *  this fraction of its parent. Drives the recursive stamp + the Droste portal
   *  frame. `pct` is the slider's percentage (5..95); stored as a 0..1 fraction. */
  setStampFactor(pct) {
    const n = Number.isFinite(+pct) ? +pct : 42;   // guard NaN/'' — but keep a literal 0 (→ clamps to floor)
    const f = Math.min(0.95, Math.max(0.05, n / 100));
    this.stampFactor = f;
    const el = document.getElementById('stampFactor'); if (el) el.value = Math.round(f * 100);
    const v = document.getElementById('stampFactorVal'); if (v) v.textContent = Math.round(f * 100) + '%';
    this._saveStampCfg();
  }
  getStampFactor() { return this.stampFactor; }

  /** Recursion LEVELS — how many shrinking generations the stamp bakes (1..8).
   *  The live portal is always infinite, so it ignores this. */
  setStampDepth(n) {
    const raw = Number.isFinite(+n) ? +n : 3;      // guard NaN/'' — but keep 0/negatives (→ clamps to floor 1)
    const d = Math.min(8, Math.max(1, Math.round(raw)));
    this.stampDepth = d;
    const el = document.getElementById('stampDepth'); if (el) el.value = d;
    const v = document.getElementById('stampDepthVal'); if (v) v.textContent = d;
    this._saveStampCfg();
  }
  getStampDepth() { return this.stampDepth; }

  /** Recursion SPIN — degrees each nested copy is rotated MORE than the last,
   *  about the same shrink centre. 0° = a concentric pile; non-zero winds the
   *  stamp into a logarithmic SPIRAL (the vortex). Stored in degrees (−180..180). */
  setStampSpin(deg) {
    const raw = Number.isFinite(+deg) ? +deg : 0;
    const d = Math.min(180, Math.max(-180, Math.round(raw)));
    this.stampSpin = d;
    const el = document.getElementById('stampSpin'); if (el) el.value = d;
    const v = document.getElementById('stampSpinVal'); if (v) v.textContent = d + '°';
    this._saveStampCfg();
  }
  getStampSpin() { return this.stampSpin; }

  /** Recursion HUE STEP — degrees each nested copy's colour is rotated MORE than
   *  the last around the colour wheel. 0° = no shift; non-zero = a chromatic
   *  vortex. Stored in degrees (−180..180). */
  setStampHue(deg) {
    const raw = Number.isFinite(+deg) ? +deg : 0;
    const d = Math.min(180, Math.max(-180, Math.round(raw)));
    this.stampHue = d;
    const el = document.getElementById('stampHue'); if (el) el.value = d;
    const v = document.getElementById('stampHueVal'); if (v) v.textContent = d + '°';
    this._saveStampCfg();
  }
  getStampHue() { return this.stampHue; }

  /** Recursion FADE — the per-level opacity DROP (as a PERCENT, 0..90), so the
   *  spiral dims as it dives. Stored as the integer percent the slider shows; the
   *  stamp BUTTON converts it to the 0..1 drop the recursiveStamp() fn wants. Each
   *  copy keeps (1−fade/100) of the previous level's opacity. 0% = no fade. */
  setStampFade(pct) {
    const raw = Number.isFinite(+pct) ? +pct : 0;
    const p = Math.min(90, Math.max(0, Math.round(raw)));
    this.stampFade = p;
    const el = document.getElementById('stampFade'); if (el) el.value = p;
    const v = document.getElementById('stampFadeVal'); if (v) v.textContent = p + '%';
    this._saveStampCfg();
  }
  getStampFade() { return this.stampFade; }

  /** Recursion DRIFT — the per-level TRANSLATE offset, as a signed PERCENT (−100..100)
   *  of the selection's larger bbox dimension, applied along the selection's +X axis.
   *  0% = a centred pile; non-zero drifts each shrinking copy off-axis into a spiral
   *  arm / comet-tail. Spin (if any) rotates the drift direction per level, so this one
   *  signed knob reaches every arm shape. Stored as the integer percent the slider shows;
   *  the stamp BUTTON converts it to the −1..1 fraction recursiveStamp() wants. */
  setStampDrift(pct) {
    const raw = Number.isFinite(+pct) ? +pct : 0;
    const p = Math.min(100, Math.max(-100, Math.round(raw)));
    this.stampDrift = p;
    const el = document.getElementById('stampDrift'); if (el) el.value = p;
    const v = document.getElementById('stampDriftVal'); if (v) v.textContent = p + '%';
    this._saveStampCfg();
  }
  getStampDrift() { return this.stampDrift; }

  _saveStampCfg() {
    try {
      localStorage.setItem('infinizoom.stampcfg', JSON.stringify({
        factor: this.stampFactor, depth: this.stampDepth,
        spin: this.stampSpin, hue: this.stampHue, fade: this.stampFade,
        drift: this.stampDrift,
      }));
    } catch {}
  }
  _loadStampCfg() {
    try {
      const r = JSON.parse(localStorage.getItem('infinizoom.stampcfg') || 'null');
      if (r) {
        if (Number.isFinite(r.factor)) this.stampFactor = Math.min(0.95, Math.max(0.05, r.factor));
        if (Number.isFinite(r.depth))  this.stampDepth  = Math.min(8, Math.max(1, Math.round(r.depth)));
        if (Number.isFinite(r.spin))   this.stampSpin   = Math.min(180, Math.max(-180, Math.round(r.spin)));
        if (Number.isFinite(r.hue))    this.stampHue    = Math.min(180, Math.max(-180, Math.round(r.hue)));
        if (Number.isFinite(r.fade))   this.stampFade   = Math.min(90, Math.max(0, Math.round(r.fade)));
        if (Number.isFinite(r.drift))  this.stampDrift  = Math.min(100, Math.max(-100, Math.round(r.drift)));
      }
    } catch {}
  }

  /** Snap pixel threshold — a key must fall within this many SCREEN px of a target. */
  get _snapPx() { return 6; }

  /** Build the snap-target cache from every NON-moving, on-screen item: its bbox
   *  left/centre/right (x) and top/middle/bottom (y). Run once per drag gesture
   *  (cheap — culled to the viewport, capped) since the targets don't move. */
  _buildSnapCands(excludeIds) {
    const cands = { xs: [], ys: [] };
    if (!this.guides.on) return cands; // grid targets are computed inline in _snapBBox
    const cam = this.camera;
    const tl = this.toWorld(0, 0), br = this.toWorld(cam.width, cam.height);
    const vminX = Math.min(tl.x, br.x), vmaxX = Math.max(tl.x, br.x);
    const vminY = Math.min(tl.y, br.y), vmaxY = Math.max(tl.y, br.y);
    let n = 0;
    for (const it of this.scene.items) {
      if (it.hidden || excludeIds.has(it.id)) continue;
      if (it.type === 'connector') continue;            // connectors resolve dynamically
      if (!lodVisible(it, cam.scale)) continue;
      const b = itemBBox(it);
      if (b.maxX < vminX || b.minX > vmaxX || b.maxY < vminY || b.minY > vmaxY) continue; // off-screen
      const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
      cands.xs.push({ v: b.minX, box: b }, { v: cx, box: b }, { v: b.maxX, box: b });
      cands.ys.push({ v: b.minY, box: b }, { v: cy, box: b }, { v: b.maxY, box: b });
      if (++n >= 500) break;                            // keep gesture-start cheap on huge docs
    }
    return cands;
  }

  /** Given a desired (moving) bbox in world coords, return the snap adjustment
   *  {dx,dy} that aligns its nearest edge/centre to a candidate or grid line, plus
   *  the guide segments to draw. `e` (a pointer event) lets Alt bypass snapping. */
  _snapBBox(bbox, cands, e) {
    const out = { dx: 0, dy: 0, guides: [] };
    if (e && e.altKey) return out;                      // Alt = free placement
    if (!this.guides.on && !this.snap) return out;
    const thr = this.camera.screenToWorldLen(this._snapPx);
    const cx = (bbox.minX + bbox.maxX) / 2, cy = (bbox.minY + bbox.maxY) / 2;
    const keysX = [bbox.minX, cx, bbox.maxX];
    const keysY = [bbox.minY, cy, bbox.maxY];
    const pick = (keys, candList, gridOn) => {
      let best = null; // { adj, pos, box, grid }
      if (this.guides.on && candList) {
        for (const k of keys) for (const c of candList) {
          const d = c.v - k;
          if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.adj)))
            best = { adj: d, pos: c.v, box: c.box, grid: false };
        }
      }
      if (gridOn) {
        const step = this.gridStep();
        for (const k of keys) {
          const g = Math.round(k / step) * step, d = g - k;
          if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.adj)))
            best = { adj: d, pos: g, box: null, grid: true };
        }
      }
      return best;
    };
    const bx = pick(keysX, cands && cands.xs, this.snap);
    const by = pick(keysY, cands && cands.ys, this.snap);
    if (bx) out.dx = bx.adj;
    if (by) out.dy = by.adj;
    // guides span the union of the snapped moving bbox and the matched target box
    const sb = { minX: bbox.minX + out.dx, maxX: bbox.maxX + out.dx,
                 minY: bbox.minY + out.dy, maxY: bbox.maxY + out.dy };
    if (bx) {
      let lo = sb.minY, hi = sb.maxY;
      if (bx.box) { lo = Math.min(lo, bx.box.minY); hi = Math.max(hi, bx.box.maxY); }
      out.guides.push({ axis: 'x', pos: bx.pos, lo, hi, grid: bx.grid });
    }
    if (by) {
      let lo = sb.minX, hi = sb.maxX;
      if (by.box) { lo = Math.min(lo, by.box.minX); hi = Math.max(hi, by.box.maxX); }
      out.guides.push({ axis: 'y', pos: by.pos, lo, hi, grid: by.grid });
    }
    return out;
  }

  /** Combined world bbox of the SEED selection (no LOD filter) — the box that
   *  snaps while dragging. Null when nothing is selected. */
  _seedBBox() {
    const items = this._selectionItems();
    if (!items.length) return null;
    let b = { ...itemBBox(items[0]) };
    for (const it of items) {
      const ib = itemBBox(it);
      b.minX = Math.min(b.minX, ib.minX); b.minY = Math.min(b.minY, ib.minY);
      b.maxX = Math.max(b.maxX, ib.maxX); b.maxY = Math.max(b.maxY, ib.maxY);
    }
    return b;
  }

  /** During a uniform resize the grabbed corner slides along the ray
   *  pivot → corner0 as the factor f grows: corner(f) = pivot + f·(corner0−pivot).
   *  Find an f near `target` that lands the corner's x (or y) exactly on a snap
   *  candidate (other item edge/centre, or a grid line) within the pixel
   *  threshold, and return it + the guide line. Falls back to `target`. */
  _snapScaleFactor(a, target, e) {
    const out = { factor: target, guides: [] };
    if (e && e.altKey) return out;
    if (!this.guides.on && !this.snap) return out;
    const cands = this._snapCands;
    const scale = this.camera.scale, thrPx = this._snapPx;
    const cx0 = a.corner0.x - a.pivot.x, cy0 = a.corner0.y - a.pivot.y;
    let best = null; // { f, axis, pos, grid }
    const consider = (f, axis, pos, grid) => {
      if (!isFinite(f) || f <= 0.02) return;
      const coord0 = axis === 'x' ? Math.abs(cx0) : Math.abs(cy0);
      const distPx = coord0 * Math.abs(f - target) * scale; // corner→line gap on screen
      if (distPx <= thrPx && (!best || Math.abs(f - target) < Math.abs(best.f - target)))
        best = { f, axis, pos, grid };
    };
    if (this.guides.on && cands) {
      if (Math.abs(cx0) > 1e-9) for (const c of cands.xs) consider((c.v - a.pivot.x) / cx0, 'x', c.v, false);
      if (Math.abs(cy0) > 1e-9) for (const c of cands.ys) consider((c.v - a.pivot.y) / cy0, 'y', c.v, false);
    }
    if (this.snap) {
      const step = this.gridStep();
      const curX = a.pivot.x + target * cx0, curY = a.pivot.y + target * cy0;
      if (Math.abs(cx0) > 1e-9) { const g = Math.round(curX / step) * step; consider((g - a.pivot.x) / cx0, 'x', g, true); }
      if (Math.abs(cy0) > 1e-9) { const g = Math.round(curY / step) * step; consider((g - a.pivot.y) / cy0, 'y', g, true); }
    }
    if (best) {
      out.factor = best.f;
      const cxw = a.pivot.x + best.f * cx0, cyw = a.pivot.y + best.f * cy0;
      if (best.axis === 'x')
        out.guides.push({ axis: 'x', pos: best.pos, lo: Math.min(a.pivot.y, cyw), hi: Math.max(a.pivot.y, cyw), grid: best.grid });
      else
        out.guides.push({ axis: 'y', pos: best.pos, lo: Math.min(a.pivot.x, cxw), hi: Math.max(a.pivot.x, cxw), grid: best.grid });
    }
    return out;
  }

  // ---------------- align / distribute ----------------
  /** Align every selected item's bbox to the selection's combined bbox.
   *  mode: 'left'|'hcenter'|'right' (X axis) or 'top'|'vcenter'|'bottom' (Y axis).
   *  Each item is translated; a selected PARENT drags its (unselected) subtree
   *  along, but a co-selected child gets its own alignment delta (nearest selected
   *  ancestor wins). One reversible history step. Needs ≥2 items. */
  alignSelection(mode) {
    const seeds = this._selectionItems().filter(it => !this.scene.isItemLocked(it));
    if (seeds.length < 2) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const boxes = new Map();
    for (const it of seeds) {
      const b = itemBBox(it); boxes.set(it.id, b);
      minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const deltas = new Map();
    for (const it of seeds) {
      const b = boxes.get(it.id);
      let dx = 0, dy = 0;
      switch (mode) {
        case 'left':    dx = minX - b.minX; break;
        case 'right':   dx = maxX - b.maxX; break;
        case 'hcenter': dx = cx - (b.minX + b.maxX) / 2; break;
        case 'top':     dy = minY - b.minY; break;
        case 'bottom':  dy = maxY - b.maxY; break;
        case 'vcenter': dy = cy - (b.minY + b.maxY) / 2; break;
        default: return;
      }
      deltas.set(it.id, { dx, dy });
    }
    this._applyAlignDeltas(deltas, `align ${mode}`);
  }

  /** Evenly distribute the selected items' centres along an axis ('h' or 'v').
   *  The two extreme items stay put; the interior ones are spaced equally between
   *  them. One reversible history step. Needs ≥3 items. */
  distributeSelection(axis) {
    const seeds = this._selectionItems().filter(it => !this.scene.isItemLocked(it));
    if (seeds.length < 3) return;
    const cOf = axis === 'v'
      ? (b) => (b.minY + b.maxY) / 2
      : (b) => (b.minX + b.maxX) / 2;
    const arr = seeds.map(it => ({ it, c: cOf(itemBBox(it)) })).sort((a, b) => a.c - b.c);
    const first = arr[0].c, last = arr[arr.length - 1].c;
    const step = (last - first) / (arr.length - 1);
    const deltas = new Map();
    arr.forEach((e, i) => {
      if (i === 0 || i === arr.length - 1) return;       // endpoints anchor the span
      const d = (first + step * i) - e.c;
      deltas.set(e.it.id, axis === 'v' ? { dx: 0, dy: d } : { dx: d, dy: 0 });
    });
    this._applyAlignDeltas(deltas, `distribute ${axis}`);
  }

  /** Apply a per-seed translation map as one reversible step. Each affected item
   *  (seed ∪ descendants) takes the delta of its NEAREST selected ancestor, so a
   *  parent drags its subtree while a co-selected child overrides for its own. */
  _applyAlignDeltas(deltaBySeed, label) {
    if (!deltaBySeed.size) return;
    const scene = this.scene;
    const affected = this._transformClosure([...deltaBySeed.keys()]);
    const entries = [];
    for (const id of affected) {
      let cur = id, guard = 0, d = null;
      while (cur != null && guard++ < 100000) {
        if (deltaBySeed.has(cur)) { d = deltaBySeed.get(cur); break; }
        const it = scene.byId(cur); cur = it ? (it.parent ?? null) : null;
      }
      if (d && (d.dx || d.dy)) entries.push({ id, dx: d.dx, dy: d.dy });
    }
    if (!entries.length) return;
    this.history.push({
      label,
      do() { for (const e of entries) { const it = scene.byId(e.id); if (it) translateItem(it, e.dx, e.dy); } scene._touch(); },
      undo() { for (const e of entries) { const it = scene.byId(e.id); if (it) translateItem(it, -e.dx, -e.dy); } scene._touch(); },
    });
    this._updateHud();
    this.requestRender();
  }

  // ---------------- tools / style ----------------
  setTool(name) {
    // picking any tool leaves pixel-edit mode (the raster tools live on their own
    // panel, so a tool-button press means "back to vector drawing")
    if (this.pixel && this.pixel.editing) this.endPixelEdit();
    this.tool = name;
    // contextual disclosure (gemma's smart-default): picking a tool surfaces the
    // style-panel section that holds its options, so they're right there when
    // relevant — the brush's smooth/taper + the star's points live in Shape & brush.
    if (name === 'brush' || name === 'star') this._revealSection('sect-shape');
    this.commitText();
    // fold/spin/glide CAPTURE the selection when they commit (drag a guide /
    // sweep an angle), so unlike the other drawing tools they must not clear it.
    if (name !== 'select' && !REFOPS.has(name)) { this.selectedIds.clear(); this.pivot = null; this._activeId = null; }
    this._spinPivot = null; this._refGuide = null;
    document.querySelectorAll('.tool').forEach(b =>
      b.classList.toggle('active', b.dataset.tool === name));
    this.canvas.className = '';
    this.canvas.classList.add('tool-' + name);
    this._updateHud();
    this.requestRender();
  }
  getTool() { return this.tool; }

  setStyle(partial) {
    Object.assign(this.style, partial);
    // mirror into UI
    if (partial.color !== undefined) document.getElementById('color').value = partial.color;
    if (partial.width !== undefined) {
      document.getElementById('width').value = partial.width;
      document.getElementById('widthVal').textContent = partial.width;
    }
    if (partial.sides !== undefined) {
      document.getElementById('sides').value = partial.sides;
      document.getElementById('sidesVal').textContent = partial.sides;
    }
    if (partial.star !== undefined) document.getElementById('starToggle').checked = partial.star;
    if (partial.opacity !== undefined) {
      document.getElementById('opacity').value = partial.opacity;
      document.getElementById('opacityVal').textContent = Math.round(partial.opacity * 100) + '%';
    }
    if (partial.blend !== undefined) {
      const sel = document.getElementById('blend'); if (sel) sel.value = partial.blend;
    }
    if (partial.widthMode !== undefined) {
      const sel = document.getElementById('widthMode');
      if (sel) sel.value = partial.widthMode;
      this._syncWidthModeUI();
    }
    if (partial.clampMin !== undefined) {
      const el = document.getElementById('clampMin'); if (el) el.value = this.style.clampMin;
    }
    if (partial.clampMax !== undefined) {
      const el = document.getElementById('clampMax'); if (el) el.value = this.style.clampMax;
    }
    // apply to current selection
    const fillable = new Set(['rect', 'ellipse', 'polygon']);
    const strokeable = new Set(['stroke', 'line', 'arrow', 'rect', 'ellipse', 'polygon', 'connector']);
    const clampChanged = partial.clampMin !== undefined || partial.clampMax !== undefined;
    if (this.selectedIds.size && (partial.color || partial.width || partial.fill !== undefined ||
                                  partial.sides !== undefined || partial.star !== undefined ||
                                  partial.opacity !== undefined || partial.widthMode !== undefined ||
                                  partial.blend !== undefined || clampChanged)) {
      for (const id of this.selectedIds) {
        const it = this.scene.byId(id);
        if (!it) continue;
        if (partial.color) it.color = partial.color;
        if (partial.width) it.width = partial.width;
        if (partial.fill !== undefined && fillable.has(it.type)) it.fill = cloneFill(partial.fill);
        if (partial.sides !== undefined && it.type === 'polygon') it.sides = partial.sides;
        if (partial.star !== undefined && it.type === 'polygon') it.star = partial.star;
        if (partial.opacity !== undefined) {
          if (partial.opacity >= 1) delete it.opacity; else it.opacity = partial.opacity;
        }
        if (partial.blend !== undefined) {
          if (partial.blend === 'normal') delete it.blend; else it.blend = partial.blend;
        }
        if (partial.widthMode !== undefined && strokeable.has(it.type)) {
          if (partial.widthMode === 'screen') {
            it.widthMode = 'screen'; delete it.clampMin; delete it.clampMax;
          } else if (partial.widthMode === 'clamp') {
            it.widthMode = 'clamp'; it.clampMin = this.style.clampMin; it.clampMax = this.style.clampMax;
          } else {
            delete it.widthMode; delete it.clampMin; delete it.clampMax;
          }
        }
        // Live-tune the range of an item that's already in clamp mode.
        if (clampChanged && it.widthMode === 'clamp') {
          if (partial.clampMin !== undefined) it.clampMin = this.style.clampMin;
          if (partial.clampMax !== undefined) it.clampMax = this.style.clampMax;
        }
      }
      this.scene._touch();
    }
    this._highlightSwatch();
    this.requestRender();
  }
  getStyle() { return { ...this.style }; }
  /** Reveal the clamp [min,max] px controls only while clamp mode is active —
   *  progressive disclosure: the range only means something in that mode. */
  _syncWidthModeUI() {
    const row = document.getElementById('clampRow');
    if (row) row.hidden = this.style.widthMode !== 'clamp';
  }
  /** Progressive disclosure for the Fill control: the gradient type only appears
   *  once Fill is on, the end colour only for a gradient, the angle only for the
   *  direction-bearing gradients (linear/conic). Keeps the panel calm by default. */
  _syncFillUI() {
    const on = this.style.fillOn, t = this.style.fillType || 'flat';
    const grad = on && t !== 'flat';
    const set = (id, hidden) => { const el = document.getElementById(id); if (el) el.hidden = hidden; };
    set('fillTypeRow', !on);
    set('fillColor2', !grad);
    set('fillAngleRow', !(on && (t === 'linear' || t === 'conic')));
    const sel = document.getElementById('fillType'); if (sel) sel.value = t;
  }
  get drawStyle() {
    return { color: this.style.color, width: this.style.width,
             fill: this._styleFill(), size: this.style.textSize,
             sides: this.style.sides, star: this.style.star, opacity: this.style.opacity,
             widthMode: this.style.widthMode, blend: this.style.blend,
             clampMin: this.style.clampMin, clampMax: this.style.clampMax };
  }

  /** drawStyle for a NEW interactively-drawn stroke/shape, with its stroke width
   *  ANCHORED to the current zoom so the nib looks like the slider's pixel value AT
   *  THE MOMENT OF DRAWING — at any scale. The width slider means "screen px"; a
   *  'world'/'clamp' item stores width in WORLD units, so the on-screen thickness is
   *  width·scale. Storing the literal slider value makes a line drawn at 2^400 zoom
   *  render as 3·2^400 px (clamped to a screen-filling blob — the "can't draw when
   *  zoomed in too far / it doesn't render" bug) and one drawn while zoomed OUT an
   *  invisible hairline. Dividing by scale fixes both: the stroke becomes a tiny
   *  REAL detail in the infinite canvas that reads as ~slider-px the instant you
   *  draw it, then grows/shrinks with zoom like any world-space geometry. 'screen'
   *  mode is already in px (zoom-invariant) so it's left untouched. At scale 1 this
   *  is byte-identical to drawStyle (width/1 === width), so non-zoomed drawing and
   *  all existing tests are unaffected. */
  _newItemStyle() {
    const st = this.drawStyle;
    const s = this.camera.scale;
    if (st.widthMode !== 'screen' && s > 0 && Number.isFinite(s)) st.width = st.width / s;
    return st;
  }

  /** Build the current fill value from the style: null (off), a flat colour
   *  string, or a gradient descriptor object (see scene.js / renderer._resolveFill).
   *  A FRESH object each call so no two items share one gradient. */
  _styleFill() {
    if (!this.style.fillOn) return null;
    const t = this.style.fillType || 'flat';
    if (t === 'flat') return this.style.fillColor;
    return {
      type: t,
      angle: (this.style.fillAngle || 0) * Math.PI / 180,
      stops: [{ t: 0, color: this.style.fillColor }, { t: 1, color: this.style.fillColor2 }],
    };
  }

  // ---------------- pointer input ----------------
  _bindInput() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => this._onDown(e));
    c.addEventListener('pointermove', e => this._onMove(e));
    c.addEventListener('pointerup', e => this._onUp(e));
    c.addEventListener('pointercancel', e => this._onUp(e));
    // Double-click: reset a custom pivot if you hit its marker, otherwise enter
    // pixel-edit mode when a pixel sprite is under the cursor.
    c.addEventListener('dblclick', e => {
      const s = this.evtScreen(e);
      if (this.pivot) {
        const pm = this._pivotScreen();
        if (pm && dist(s.x, s.y, pm.x, pm.y) <= 10) { this.clearPivot(); this._toast('pivot reset'); return; }
      }
      if (!this.pixel.editing) {
        const w = this.toWorld(s.x, s.y);
        const it = this.scene.pick(w.x, w.y, this.camera.screenToWorldLen(5));
        if (it && it.type === 'pixel') { this.editPixel(it.id); this._toast('Pixel edit — Esc to finish'); }
      }
    });
    c.addEventListener('pointerleave', () => { this.eraserCursor = null; this.requestRender(); });
    c.addEventListener('wheel', e => this._onWheel(e), { passive: false });
    c.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('resize', () => { this.renderer.resize(); this.minimap._resize(); this._applyCompact(); this.requestRender(); });

    const mini = document.getElementById('minimap');
    mini.addEventListener('pointerdown', e => {
      const r = mini.getBoundingClientRect();
      const w = this.minimap.clickToWorld(e.clientX - r.left, e.clientY - r.top);
      if (w) { this.camera.x = w.x; this.camera.y = w.y; this.requestRender(); }
    });
  }

  _onWheel(e) {
    e.preventDefault();
    const s = this.evtScreen(e);
    if (e.ctrlKey || e.metaKey) {
      // pinch-zoom on trackpads sends ctrl+wheel
      const factor = Math.exp(-e.deltaY * 0.01);
      this.camera.zoomBy(factor, s.x, s.y);
    } else if (e.shiftKey) {
      this.camera.panByScreen(-e.deltaY, 0);
    } else if (e.altKey) {
      this.camera.panByScreen(0, -e.deltaY);
    } else {
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.camera.zoomBy(factor, s.x, s.y);
    }
    this._updateHud();
    this.requestRender();
  }

  _onDown(e) {
    if (this.anim.playing) this.stop();   // interacting stops flipbook playback
    try { this.canvas.setPointerCapture?.(e.pointerId); } catch { /* synthetic events */ }
    const s = this.evtScreen(e);
    this.pointers.set(e.pointerId, s);

    if (this.pointers.size === 2) { this._beginPinch(); return; }
    if (this.pointers.size > 2) return;

    const panMode = this.tool === 'pan' || this.spaceDown || e.button === 1 || e.button === 2;
    const w = this.maybeSnap(this.toWorld(s.x, s.y));

    // Alt+click = eyedropper: sample the colour under the cursor. In pixel-edit
    // mode it samples the pixel's palette index instead of an item colour.
    if (e.altKey && e.button === 0) {
      const wp = this.toWorld(s.x, s.y);
      if (this.pixel.editing && this._pixelTarget()) this._pixelEyedrop(wp);
      else this.eyedrop(wp.x, wp.y);
      this.pointers.delete(e.pointerId);
      this.requestRender();
      return;
    }

    // Pixel-art edit mode: route a left press to the sprite's raster tools.
    // Pan (space / middle / right) still falls through so you can navigate.
    if (this.pixel.editing && this._pixelTarget() && e.button === 0 && !this.spaceDown) {
      this._pixelDown(s, e);
      this.requestRender();
      return;
    }

    // Symmetry anchor: grab the on-canvas centre handle (any drawing tool) when
    // mandala mode is on and the press lands on it, instead of starting a draw.
    if (this.symmetry.on && e.button === 0) {
      const a = this._symAnchorScreen();
      if (a && dist(s.x, s.y, a.x, a.y) <= 12) {
        this.active = { kind: 'symcenter' };
        this.draft = null;
        this.requestRender();
        return;
      }
    }

    if (panMode) {
      this.active = { kind: 'pan', startScreen: s, last: s };
      this.canvas.classList.add('panning');
      return;
    }

    // Zoom-anchored style so the nib reads as the slider's px value at this scale
    // (see _newItemStyle — the fix for "can't draw when zoomed in too far").
    const ns = this._newItemStyle();
    switch (this.tool) {
      case 'pen':
        this.draft = makeStroke([w], ns);
        this.active = { kind: 'pen' };
        break;
      case 'brush':
        this.draft = makeStroke([{ x: w.x, y: w.y, p: this._brushPressure(e, s, null) }], ns);
        this.draft.taper = true;
        this.active = { kind: 'brush', lastScreen: s, lastT: performance.now() };
        break;
      case 'line':
        this.draft = makeLine(w, w, ns);
        this.active = { kind: 'shape', start: w };
        break;
      case 'rect':
        this.draft = makeRect(w.x, w.y, 0, 0, ns);
        this.active = { kind: 'shape', start: w };
        break;
      case 'ellipse':
        this.draft = makeEllipse(w.x, w.y, 0, 0, ns);
        this.active = { kind: 'shape', start: w };
        break;
      case 'arrow':
        this.draft = makeArrow(w, w, ns);
        this.active = { kind: 'shape', start: w };
        break;
      case 'star':
        this.draft = makePolygon(w.x, w.y, 0, 0, ns);
        this.active = { kind: 'shape', start: w };
        break;
      case 'fold':
        // drag out the mirror line (a line draft IS the preview); on release the
        // selection (or everything) is referenced by a new fold item
        this.draft = makeLine(w, w, ns);
        this.active = { kind: 'foldline', start: w };
        break;
      case 'glide':
        // drag the copy offset as an arrow (tail = here, head = where the copy lands)
        this.draft = makeArrow(w, w, ns);
        this.active = { kind: 'glideline', start: w };
        break;
      case 'spin':
        if (!this._spinPivot) {
          // stage 1: place the pivot; the next press starts the angle sweep
          this._spinPivot = w;
          this._refGuide = { pivot: w };
        } else {
          this.draft = makeLine(this._spinPivot, w, ns);
          this.active = { kind: 'spinarm', pivot: this._spinPivot,
                          ang0: Math.atan2(w.y - this._spinPivot.y, w.x - this._spinPivot.x) };
        }
        break;
      case 'eraser':
        this.active = { kind: 'erase', removed: [] };
        this._eraseAt(w, s);
        break;
      case 'text':
        this._startText(s, w);
        break;
      case 'select':
        this._beginSelect(s, w, e);
        break;
      case 'connector':
        this._beginConnector(s, w);
        break;
    }
    this.requestRender();
  }

  _onMove(e) {
    const s = this.evtScreen(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, s);
    this.mouseWorld = this.toWorld(s.x, s.y);
    this._updateHud();

    if (this.pinch && this.pointers.size >= 2) { this._updatePinch(); return; }

    if (this.tool === 'eraser' && !this.active) {
      this.eraserCursor = { x: s.x, y: s.y, r: this.camera.worldToScreenLen(this._eraseRadiusWorld()) };
      this.requestRender();
    }

    if (!this.active) return;
    const w = this.maybeSnap(this.toWorld(s.x, s.y));

    switch (this.active.kind) {
      case 'pan': {
        const dx = s.x - this.active.last.x, dy = s.y - this.active.last.y;
        this.camera.panByScreen(dx, dy);
        this.active.last = s;
        break;
      }
      case 'pen': {
        const last = this.draft.points[this.draft.points.length - 1];
        const minMove = this.camera.screenToWorldLen(1.2);
        if (dist(last.x, last.y, w.x, w.y) >= minMove) this.draft.points.push(w);
        break;
      }
      case 'brush': {
        const last = this.draft.points[this.draft.points.length - 1];
        const minMove = this.camera.screenToWorldLen(1.2);
        if (dist(last.x, last.y, w.x, w.y) >= minMove) {
          const pr = this._brushPressure(e, s, this.active);
          this.draft.points.push({ x: w.x, y: w.y, p: pr });
          this.active.lastScreen = s;
          this.active.lastT = performance.now();
        }
        break;
      }
      case 'shape': {
        this._updateShape(this.active.start, w, e);
        break;
      }
      case 'foldline':
      case 'glideline': {
        let end = w;
        if (e && e.shiftKey) end = this._constrainAngle(this.active.start, w);
        this.draft.points = [this.active.start, end];
        break;
      }
      case 'spinarm': {
        const p = this.active.pivot;
        let ang = Math.atan2(w.y - p.y, w.x - p.x) - this.active.ang0;
        if (e && e.shiftKey) { const step = Math.PI / 12; ang = Math.round(ang / step) * step; }
        this.active.angle = ang;
        this.draft.points = [p, w];
        this._refGuide = { pivot: p, arm: w, ang0: this.active.ang0, angle: ang };
        break;
      }
      case 'erase':
        this._eraseAt(w, s);
        this.eraserCursor = { x: s.x, y: s.y, r: this.camera.worldToScreenLen(this._eraseRadiusWorld()) };
        break;
      case 'move': {
        // Absolute positioning from the gesture's start bbox so snapping is stable
        // (incremental deltas would jitter against a snap line). Snap the moving
        // bbox to other items' edges/centres (+ grid when on), draw guide lines.
        const a = this.active;
        const wr = this.toWorld(s.x, s.y); // raw (unsnapped) world point
        const rawDx = wr.x - a.startWorld.x, rawDy = wr.y - a.startWorld.y;
        // a.bbox0 is the seed bbox captured at gesture start; absent only if the
        // selection was somehow empty — then move without snapping.
        const snap = a.bbox0
          ? this._snapBBox({ minX: a.bbox0.minX + rawDx, minY: a.bbox0.minY + rawDy,
                             maxX: a.bbox0.maxX + rawDx, maxY: a.bbox0.maxY + rawDy }, this._snapCands, e)
          : { dx: 0, dy: 0, guides: [] };
        const finalDx = rawDx + snap.dx, finalDy = rawDy + snap.dy;
        const ddx = finalDx - a.applied.dx, ddy = finalDy - a.applied.dy;
        if (ddx || ddy) {
          // parent transforms cascade to descendants (closure captured at gesture start)
          for (const id of a.ids) { const it = this.scene.byId(id); if (it) translateItem(it, ddx, ddy); }
          a.applied.dx = finalDx; a.applied.dy = finalDy;
          this.scene._touch();
        }
        this.activeGuides = snap.guides.length ? snap.guides : null;
        break;
      }
      case 'connect': {
        const wr = this.toWorld(s.x, s.y);
        if (this.draft) { this.draft.bx = wr.x; this.draft.by = wr.y; }
        break;
      }
      case 'rotate': {
        const pivot = this.active.pivot;
        const wr = this.toWorld(s.x, s.y); // raw (unsnapped) world point for the angle
        const cur = Math.atan2(wr.y - pivot.y, wr.x - pivot.x);
        let target = cur - this.active.startAngle;
        if (e && e.shiftKey) { const step = Math.PI / 12; target = Math.round(target / step) * step; }
        const d = target - this.active.applied;
        if (d) {
          const items = this.active.ids.map(id => this.scene.byId(id)).filter(Boolean);
          rotateItemsAbout(items, pivot.x, pivot.y, d);
          this.active.applied = target;
          this.scene._touch();
        }
        break;
      }
      case 'scale': {
        const a = this.active;
        const wr = this.toWorld(s.x, s.y); // raw (unsnapped) world point
        // project the pointer onto the corner→pivot diagonal to get a uniform factor
        const proj = (wr.x - a.pivot.x) * a.dirx + (wr.y - a.pivot.y) * a.diry;
        let target = proj / a.baseLen;
        if (e && e.shiftKey) {
          target = Math.round(target / 0.25) * 0.25; // ⇧ snaps to ¼ steps (no smart snap)
          this.activeGuides = null;
        } else {
          // smart guides: nudge the factor so the grabbed corner lands on a guide line
          const sn = this._snapScaleFactor(a, target, e);
          target = sn.factor;
          this.activeGuides = sn.guides.length ? sn.guides : null;
        }
        const minS = 0.02;
        if (!(target > minS)) target = minS; // never flip/collapse the selection
        const factor = target / a.applied;
        if (factor > 0 && isFinite(factor) && Math.abs(factor - 1) > 1e-12) {
          const items = a.ids.map(id => this.scene.byId(id)).filter(Boolean);
          for (const it of items) scaleItemAbout(it, a.pivot.x, a.pivot.y, factor);
          a.applied = target;
          this.scene._touch();
        }
        break;
      }
      case 'pivot': {
        let wr = this.toWorld(s.x, s.y);
        // ⇧ snaps the pivot to the nearest of the selection bbox's 9 key points
        // (4 corners, 4 edge midpoints, centre) — the chef's-kiss snap.
        if (e && e.shiftKey) wr = this._snapPivot(wr);
        this.pivot = { x: wr.x, y: wr.y };
        break;
      }
      case 'symcenter': {
        const wr = this.toWorld(s.x, s.y); // raw world; the anchor is a free point
        this.symmetry.cx = wr.x; this.symmetry.cy = wr.y;
        break;
      }
      case 'marquee':
        this.marquee = { ...this.marquee, x1: s.x, y1: s.y };
        break;
      case 'pixel': {
        const a = this.active;
        const t = this.scene.byId(a.target); if (!t) break;
        const wr = this.toWorld(s.x, s.y);
        const r = worldToPixelUnclamped(t, wr.x, wr.y); if (!r) break;
        if (a.shape === 'paint') {
          // interpolate so a fast drag leaves no gaps (Bresenham, gemma's note)
          for (const c of bresenhamLine(a.last.px, a.last.py, r.px, r.py)) this._pixelPlotM(t, c.x, c.y, a.idx, a.diff);
          a.last = r;
        } else if (a.shape === 'line' || a.shape === 'rect' || a.shape === 'ellipse') {
          // live preview: revert the previous preview, then re-stamp from start
          for (const [i, before] of a.diff) t.data[i] = before;
          a.diff.clear();
          const cells = a.shape === 'line'
            ? bresenhamLine(a.start.px, a.start.py, r.px, r.py)
            : a.shape === 'ellipse'
              ? ellipseCells(a.start.px, a.start.py, r.px, r.py, a.filled)
              : rectCells(a.start.px, a.start.py, r.px, r.py, a.filled);
          for (const c of cells) this._pixelPlotM(t, c.x, c.y, a.idx, a.diff);
        }
        this._invalidatePixel(t.id);
        break;
      }
      case 'pixelmarquee': {
        const a = this.active;
        const t = this.scene.byId(a.target); if (!t) break;
        const wr = this.toWorld(s.x, s.y);
        const raw = worldToPixelUnclamped(t, wr.x, wr.y); if (!raw) break;
        const cell = this._clampCell(t, raw);
        if (cell.px !== a.startCell.px || cell.py !== a.startCell.py) a.moved = true;
        this.pixel.sel = this._rectFromCells(a.startCell, cell);
        break;
      }
      case 'pixelselmove': {
        const a = this.active;
        const t = this.scene.byId(a.target); if (!t) break;
        const wr = this.toWorld(s.x, s.y);
        const raw = worldToPixelUnclamped(t, wr.x, wr.y); if (!raw) break;
        const cell = this._clampCell(t, raw);
        const dx = cell.px - a.startCell.px, dy = cell.py - a.startCell.py;
        if (dx !== 0 || dy !== 0) a.moved = true;
        // recompute from the pristine snapshot each frame (origin + cumulative
        // delta), so dragging off-grid then back restores cleanly
        t.data = moveRegion(a.before, t.pw, t.ph, a.origSel, dx, dy);
        this.pixel.sel = this._clampMaskedSel(t, { x: a.origSel.x + dx, y: a.origSel.y + dy, w: a.origSel.w, h: a.origSel.h, mask: a.origSel.mask });
        this._invalidatePixel(t.id);
        break;
      }
    }
    this.requestRender();
  }

  _onUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pinch && this.pointers.size < 2) {
      this.pinch = null;
      // Lifting out of a twist near upright snaps flat — an easy "find 0°" on touch.
      if (this.camera.rot !== 0 && Math.abs(this.camera.rot) < 0.07) { // ~4°
        this.camera.rotateTo(0); this._updateHud(); this.requestRender();
      }
    }
    this.canvas.classList.remove('panning');
    if (!this.active) { this.requestRender(); return; }

    const a = this.active;
    this.active = null;

    switch (a.kind) {
      case 'pen': this._commitStroke(); break;
      case 'brush': this._commitBrush(); break;
      case 'shape': this._commitShape(); break;
      case 'foldline': this._commitFold(); break;
      case 'glideline': this._commitGlide(); break;
      case 'spinarm': this._commitSpin(a.angle ?? 0); break;
      case 'erase':
        if (a.removed.length) this.history.pushApplied(removeItemsCmd(this.scene, a.removed));
        this.eraserCursor = null;
        break;
      case 'move':
        this.activeGuides = null; this._snapCands = null;
        if (Math.abs(a.applied.dx) > 1e-9 || Math.abs(a.applied.dy) > 1e-9) {
          // record reversible move (already applied) over the whole subtree, so
          // undo reverses the parent AND every cascaded descendant atomically
          const ids = a.ids;
          const dx = a.applied.dx, dy = a.applied.dy;
          this.history.pushApplied({
            label: `move ${ids.length}`,
            do() { for (const id of ids) { const it = app.scene.byId(id); if (it) translateItem(it, dx, dy); } app.scene._touch(); },
            undo() { for (const id of ids) { const it = app.scene.byId(id); if (it) translateItem(it, -dx, -dy); } app.scene._touch(); },
          });
        }
        break;
      case 'rotate':
        if (Math.abs(a.applied) > 1e-9) {
          const ids = a.ids, pivot = a.pivot, ang = a.applied, scene = this.scene;
          const grab = () => ids.map(id => scene.byId(id)).filter(Boolean);
          this.history.pushApplied({
            label: `rotate ${ids.length}`,
            do() { rotateItemsAbout(grab(), pivot.x, pivot.y, ang); scene._touch(); },
            undo() { rotateItemsAbout(grab(), pivot.x, pivot.y, -ang); scene._touch(); },
          });
        }
        break;
      case 'scale':
        this.activeGuides = null; this._snapCands = null;
        if (Math.abs(a.applied - 1) > 1e-9) {
          const ids = a.ids, pivot = a.pivot, sc = a.applied, scene = this.scene;
          const grab = () => ids.map(id => scene.byId(id)).filter(Boolean);
          this.history.pushApplied({
            label: `scale ${ids.length}`,
            do() { for (const it of grab()) scaleItemAbout(it, pivot.x, pivot.y, sc); scene._touch(); },
            undo() { for (const it of grab()) scaleItemAbout(it, pivot.x, pivot.y, 1 / sc); scene._touch(); },
          });
        }
        break;
      case 'connect': this._endConnector(this.evtScreen(e), a); break;
      case 'symcenter': this._saveSymmetry(); break;
      case 'marquee': this._commitMarquee(); break;
      case 'pixel': this._pushPixelDiff(a.target, a.diff); break;
      case 'pixelmarquee': this._commitPixelMarquee(a); break;
      case 'pixelselmove': this._commitPixelSelMove(a); break;
    }
    this.requestRender();
    storage.saveLocal(this.scene, this.camera);
  }

  // ---- symmetry / mandala ----
  /** True when symmetry would actually multiply a drawn item (≥2 slices, or a
   *  single-slice mirror, or a wallpaper group). A lone slice with no mirror is
   *  just normal drawing. */
  _symmetryActive() { const s = this.symmetry; return s.on && (this._groupActive() || s.slices > 1 || s.mirror || this._gridActive()); }

  /** True when a WALLPAPER GROUP is the active symmetry — it overrides the
   *  radial/grid path entirely (the group fully defines the tiling). */
  _wallpaperActive() { const s = this.symmetry; return !!(s.on && s.group && isWallpaperGroup(s.group)); }

  /** True when a FRIEZE (strip) GROUP is the active symmetry — the 1-D sibling of
   *  the wallpaper path. Like it, the group fully defines the tiling, overriding
   *  the radial/grid path. */
  _friezeActive() { const s = this.symmetry; return !!(s.on && s.group && isFriezeGroup(s.group)); }

  /** True when ANY mathematical tiling group (wallpaper or frieze) is the active
   *  symmetry. Both share the placement shape, so the clone/draft path is one. */
  _groupActive() { return this._wallpaperActive() || this._friezeActive(); }

  /** The flat placement list ({reflect,angle,tx,ty} each) for the active tiling
   *  group — wallpaper across a 2-D lattice, frieze along a 1-D strip — or null
   *  when no group is active. Index 0 is always the identity copy at the anchor. */
  _groupPlacements() {
    const s = this.symmetry;
    if (this._wallpaperActive()) return wallpaperPlacements(s.group, s.cell, s.reps);
    if (this._friezeActive()) return friezePlacements(s.group, s.cell, s.reps);
    return null;
  }

  /** True when the translational (wallpaper) lattice would actually tile copies
   *  (≥2 cells on either axis). A 1×1 grid is just the single radial result. */
  _gridActive() { const g = this.symmetry.grid; return !!(g && g.on && (g.cols > 1 || g.rows > 1)); }

  /** Lattice translation offsets (world units) for the wallpaper grid, CENTRED on
   *  the symmetry anchor. Returns `[{ox:0,oy:0}]` when the grid is inactive (so the
   *  clone/draft builders are byte-identical to the pure-radial path). Sorted by
   *  distance from the centre so the un-translated copy stays at index 0. */
  _gridOffsets() {
    const g = this.symmetry.grid;
    if (!this._gridActive()) return [{ ox: 0, oy: 0 }];
    const cols = Math.round(clamp(g.cols, 1, 12)), rows = Math.round(clamp(g.rows, 1, 12));
    const offs = [];
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++)
        offs.push({ ox: (i - (cols - 1) / 2) * g.dx, oy: (j - (rows - 1) / 2) * g.dy });
    offs.sort((a, b) => (a.ox * a.ox + a.oy * a.oy) - (b.ox * b.ox + b.oy * b.oy));
    return offs;
  }

  /** World-space lattice cell centres for the active wallpaper group, `reps` cells
   *  out from the anchor — the points the on-canvas lattice guide marks. [] when no
   *  wallpaper group is active. */
  _wallpaperLatticePoints() {
    if (!this._wallpaperActive()) return [];
    const s = this.symmetry;
    const lat = wallpaperLattice(s.group, s.cell);
    const reps = Math.round(clamp(s.reps, 0, 4));
    const pts = [];
    for (let j = -reps; j <= reps; j++)
      for (let i = -reps; i <= reps; i++)
        pts.push({ x: s.cx + i * lat.v1[0] + j * lat.v2[0],
                   y: s.cy + i * lat.v1[1] + j * lat.v2[1] });
    return pts;
  }

  /** The 4 world-space corners of the home unit cell for the active wallpaper
   *  group — the parallelogram {anchor, +v1, +v1+v2, +v2}. This is where the cosets
   *  reduce to, i.e. the tile that repeats. [] when no wallpaper group is active. */
  wallpaperCellCorners() {
    if (!this._wallpaperActive()) return [];
    const s = this.symmetry;
    const { v1, v2 } = wallpaperLattice(s.group, s.cell);
    return [
      { x: s.cx, y: s.cy },
      { x: s.cx + v1[0], y: s.cy + v1[1] },
      { x: s.cx + v1[0] + v2[0], y: s.cy + v1[1] + v2[1] },
      { x: s.cx + v2[0], y: s.cy + v2[1] },
    ];
  }

  /** World-space polygon of the active wallpaper group's FUNDAMENTAL DOMAIN — the
   *  one region you draw into that the group then tiles across the whole plane.
   *  [] when no group is active, or when the group is p1 (a single coset per cell:
   *  the whole cell IS the domain, already shown by the dashed parallelogram). */
  fundamentalDomainCorners() {
    if (!this._wallpaperActive()) return [];
    const s = this.symmetry;
    if (wallpaperCellCount(s.group) < 2) return [];   // p1 — domain == the cell
    const poly = fundamentalDomain(s.group, s.cell);
    if (!poly || poly.length < 3) return [];
    return poly.map(p => ({ x: s.cx + p.x, y: s.cy + p.y }));
  }

  /** World-space period-centre points along the strip for the active frieze group,
   *  `reps` periods either side of the anchor — the crosses the strip guide marks
   *  (the 1-D analogue of the wallpaper lattice crosses). [] when no frieze group
   *  is active. */
  _friezeLatticePoints() {
    if (!this._friezeActive()) return [];
    const s = this.symmetry;
    const reps = Math.round(clamp(s.reps, 0, 4));
    const pts = [];
    for (let i = -reps; i <= reps; i++) pts.push({ x: s.cx + i * s.cell, y: s.cy });
    return pts;
  }

  /** The 4 world-space corners of the home STRIP CELL for the active frieze group:
   *  the band [−p/2,p/2]×[−h/2,h/2] centred on the anchor — the one repeating tile
   *  (drawn as a dashed box, same as the wallpaper unit cell). [] when no frieze
   *  group is active. */
  friezeStripCorners() {
    if (!this._friezeActive()) return [];
    const s = this.symmetry;
    const p = s.cell, h = friezeBandHeight(p);
    return [
      { x: s.cx - p / 2, y: s.cy - h / 2 },
      { x: s.cx + p / 2, y: s.cy - h / 2 },
      { x: s.cx + p / 2, y: s.cy + h / 2 },
      { x: s.cx - p / 2, y: s.cy + h / 2 },
    ];
  }

  /** World-space polygon of the active frieze group's FUNDAMENTAL DOMAIN — the one
   *  region of the strip you draw into that the group tiles to fill it. [] when no
   *  frieze group is active, or for p1 (the whole strip cell IS the domain, already
   *  shown by the dashed band). */
  friezeFundamentalDomainCorners() {
    if (!this._friezeActive()) return [];
    const s = this.symmetry;
    if (friezeCellCount(s.group) < 2) return [];   // p1 — domain == the strip cell
    const poly = friezeFundamentalDomain(s.group, s.cell);
    if (!poly || poly.length < 3) return [];
    return poly.map(p => ({ x: s.cx + p.x, y: s.cy + p.y }));
  }

  /** The fundamental WEDGE for radial (mandala) mode, as screen-space start/end
   *  angles (matching how the spoke guide is drawn): the sector you draw into that
   *  the N rotations (and mirror) replicate around the anchor. Cyclic C_N ⇒ a
   *  2π/N sector; dihedral D_N (mirror on) ⇒ half that, π/N, bounded by a mirror.
   *  null when a wallpaper group is active or there's no actual radial symmetry. */
  _mandalaWedge() {
    const s = this.symmetry;
    if (this._wallpaperActive()) return null;
    const N = Math.max(1, Math.round(s.slices));
    if (!s.mirror && N < 2) return null;              // a lone slice → no distinct domain
    return { a0: 0, a1: s.mirror ? Math.PI / N : (Math.PI * 2) / N };
  }

  /** The symmetry overlay state for the renderer: the anchor handle, the radial
   *  spoke guide (mandala only), the lattice cell crosses, and — for a wallpaper
   *  group — the dashed outline of the one repeating unit cell. Null when symmetry
   *  is off (no anchor to show). */
  _symmetryRenderState() {
    const a = this._symAnchorScreen();
    if (!a) return null;
    const wp = this._wallpaperActive();
    const fz = this._friezeActive();
    const grp = wp || fz;                       // a tiling group (vs radial/mandala)
    const toScreen = p => { const s = this.camera.worldToScreen(p.x, p.y); return { x: s.x, y: s.y }; };
    let grid = null;
    if (wp) grid = this._wallpaperLatticePoints().map(toScreen);
    else if (fz) grid = this._friezeLatticePoints().map(toScreen);
    else if (this._gridActive()) grid = this._gridOffsets().map(o => toScreen({ x: this.symmetry.cx + o.ox, y: this.symmetry.cy + o.oy }));
    // Fundamental-domain highlight ("draw here, symmetry fills the rest"): the group's
    // Dirichlet cell (wallpaper or frieze — world→screen so it tracks pan/zoom/rotate),
    // or the mandala wedge (screen-space angles, aligning with the spoke guide).
    let domain = null, wedge = null;
    if (this.symmetry.showDomain) {
      if (wp) { const d = this.fundamentalDomainCorners(); if (d.length >= 3) domain = d.map(toScreen); }
      else if (fz) { const d = this.friezeFundamentalDomainCorners(); if (d.length >= 3) domain = d.map(toScreen); }
      else wedge = this._mandalaWedge();
    }
    const cellCorners = wp ? this.wallpaperCellCorners() : fz ? this.friezeStripCorners() : null;
    return {
      x: a.x, y: a.y,
      slices: Math.max(1, Math.round(this.symmetry.slices)),
      mirror: this.symmetry.mirror,
      active: this._symmetryActive() && !grp,   // radial spokes belong to mandala mode only
      grid,
      cell: cellCorners ? cellCorners.map(toScreen) : null,
      domain, wedge,
    };
  }

  /** Screen position of the draggable symmetry anchor, or null when off. */
  _symAnchorScreen() {
    if (!this.symmetry.on) return null;
    const sc = this.camera.worldToScreen(this.symmetry.cx, this.symmetry.cy);
    return { x: sc.x, y: sc.y };
  }

  /** Expand freshly-drawn item(s) into the full set of radial (+mirror) copies
   *  about the symmetry centre. Every copy is a DEEP clone with a new id, and
   *  all copies share one fresh group id so the mandala is a single entity for
   *  undo / selection / flipbook. The originals passed in are NOT reused (the
   *  identity slice k=0 is itself a clone), so callers can discard them. */
  /** Apply one wallpaper PLACEMENT (a closed coset of the group) to a set of item
   *  clones, in place: the orientation part (rotation OR reflection about the
   *  anchor) then its in-cell translation. Reuses the same isometry primitives as
   *  the radial/mirror path, so box-item rotation/reflection stays exact. */
  _applyPlacement(cs, pl, cx, cy) {
    if (pl.reflect) reflectItemsAbout(cs, cx, cy, pl.angle);
    else if (pl.angle) rotateItemsAbout(cs, cx, cy, pl.angle);
    if (pl.tx || pl.ty) for (const c of cs) translateItem(c, pl.tx, pl.ty);
  }

  /** Commit-side expansion for a TILING GROUP (wallpaper or frieze): deep-clone the
   *  motif once per placement, all sharing one fresh group id so the whole tiling is
   *  a single undo/selection entity. `places` is the group's placement list (index 0
   *  is the identity copy). */
  _tilingClones(base, places) {
    const { cx, cy } = this.symmetry;
    const gid = 'grp_' + Math.random().toString(36).slice(2, 9);
    const out = [];
    for (const pl of places) {
      const cs = base.map(it => {
        const c = JSON.parse(JSON.stringify(it));
        c.id = 'sym_' + Math.random().toString(36).slice(2, 9);
        c.group = gid;
        return c;
      });
      this._applyPlacement(cs, pl, cx, cy);
      out.push(...cs);
    }
    return out;
  }

  /** Live preview copies of the in-progress draft under the active tiling group
   *  (shallow clones — same simplify guard as the radial path bounds per-frame
   *  cost when the placement count is large). */
  _tilingDrafts(places) {
    const { cx, cy } = this.symmetry;
    let draft = this.draft;
    if (places.length > 24 && draft.points && draft.points.length > 32) {
      draft = { ...draft, points: simplify(draft.points, this.camera.screenToWorldLen(1.2)) };
    }
    const out = [];
    for (const pl of places) {
      const c = { ...draft };
      this._applyPlacement([c], pl, cx, cy);
      out.push(c);
    }
    return out;
  }

  _symmetryClones(base) {
    const places = this._groupPlacements();
    if (places) return this._tilingClones(base, places);
    const { cx, cy, slices, mirror } = this.symmetry;
    const N = Math.max(1, Math.round(slices));
    const gid = 'grp_' + Math.random().toString(36).slice(2, 9);
    const offsets = this._gridOffsets();
    const out = [];
    // composition order (companion's call): Motif → Radial → Grid. The radial copy
    // is built about the shared anchor, THEN the whole mandala is shifted to its
    // lattice cell → a grid of mandalas, each centred on its own lattice point.
    const emit = (ox, oy, transform) => {
      const cs = base.map(it => {
        const c = JSON.parse(JSON.stringify(it));
        c.id = 'sym_' + Math.random().toString(36).slice(2, 9);
        c.group = gid;
        return c;
      });
      transform(cs);
      if (ox || oy) for (const c of cs) translateItem(c, ox, oy);
      out.push(...cs);
    };
    for (const { ox, oy } of offsets) {
      for (let k = 0; k < N; k++) {
        const ang = k * (Math.PI * 2) / N;
        emit(ox, oy, cs => { if (ang) rotateItemsAbout(cs, cx, cy, ang); });
        // a mirrored copy of each slice → dihedral (kaleidoscope) symmetry
        if (mirror) emit(ox, oy, cs => { reflectItemsAbout(cs, cx, cy, 0); if (ang) rotateItemsAbout(cs, cx, cy, ang); });
      }
    }
    return out;
  }

  /** Live preview copies of the in-progress draft (shallow clones — the
   *  transforms replace `points`/x/y on each clone, never touching the draft).
   *  Returns null when symmetry isn't active so the normal single draft draws. */
  _symmetryDrafts() {
    if (!this.draft || !this._symmetryActive()) return null;
    const places = this._groupPlacements();
    if (places) return this._tilingDrafts(places);
    const { cx, cy, slices, mirror } = this.symmetry;
    const N = Math.max(1, Math.round(slices));
    const offsets = this._gridOffsets();
    // Clone-explosion guard (companion's flag): when the lattice multiplies the
    // copy count, simplify a long draft ONCE so the per-frame ghost cost stays
    // bounded. Only the live preview is approximated — the commit is exact.
    let draft = this.draft;
    const copies = offsets.length * N * (mirror ? 2 : 1);
    if (copies > 24 && draft.points && draft.points.length > 32) {
      draft = { ...draft, points: simplify(draft.points, this.camera.screenToWorldLen(1.2)) };
    }
    const out = [];
    const emit = (ox, oy, transform) => {
      const c = { ...draft }; transform([c]);
      if (ox || oy) translateItem(c, ox, oy);
      out.push(c);
    };
    for (const { ox, oy } of offsets) {
      for (let k = 0; k < N; k++) {
        const ang = k * (Math.PI * 2) / N;
        emit(ox, oy, cs => { if (ang) rotateItemsAbout(cs, cx, cy, ang); });
        if (mirror) emit(ox, oy, cs => { reflectItemsAbout(cs, cx, cy, 0); if (ang) rotateItemsAbout(cs, cx, cy, ang); });
      }
    }
    return out;
  }

  /** Commit chokepoint for the drawing tools: applies symmetry expansion (when
   *  active), tags the flipbook frame, and pushes ONE reversible add command.
   *  Returns the items actually added (the originals, or the mandala clones —
   *  index 0 is always the geometric identity copy of the first drawn item). */
  _commitDrawn(items) {
    const all = this._symmetryActive() ? this._symmetryClones(items) : items;
    this._assignFrame(all);
    this.history.push(addItemsCmd(this.scene, all));
    return all;
  }

  setSymmetry(partial) {
    // `grid` is a nested object — MERGE it (Object.assign would otherwise drop the
    // unspecified sub-fields) before assigning the scalar symmetry fields.
    if (partial && partial.grid) {
      Object.assign(this.symmetry.grid, partial.grid);
      partial = { ...partial }; delete partial.grid;
    }
    Object.assign(this.symmetry, partial);
    this.symmetry.slices = Math.round(clamp(this.symmetry.slices, 1, 24));
    const g = this.symmetry.grid;
    g.cols = Math.round(clamp(g.cols, 1, 12));
    g.rows = Math.round(clamp(g.rows, 1, 12));
    g.dx = Number.isFinite(g.dx) ? g.dx : 120;
    g.dy = Number.isFinite(g.dy) ? g.dy : 120;
    // wallpaper group: keep only a known name (or null = legacy radial/grid);
    // clamp the lattice spacing and how many cells we tile out from the anchor.
    if (this.symmetry.group != null && !isWallpaperGroup(this.symmetry.group) && !isFriezeGroup(this.symmetry.group)) this.symmetry.group = null;
    this.symmetry.cell = clamp(Number.isFinite(this.symmetry.cell) ? this.symmetry.cell : 160, 8, 4000);
    this.symmetry.reps = Math.round(clamp(Number.isFinite(this.symmetry.reps) ? this.symmetry.reps : 2, 0, 4));
    // showDomain defaults ON: undefined ⇒ true, only an explicit false turns it off.
    this.symmetry.showDomain = this.symmetry.showDomain !== false;
    this._saveSymmetry();
    this._syncSymmetryUI();
    this.requestRender();
    return this.getSymmetry();
  }
  getSymmetry() { return { ...this.symmetry, grid: { ...this.symmetry.grid } }; }
  toggleSymmetry(force) { return this.setSymmetry({ on: force == null ? !this.symmetry.on : !!force }); }
  setSymmetryCenter(x, y) { return this.setSymmetry({ cx: x, cy: y }); }
  /** Snap the symmetry centre to the current view centre (UI "centre here"). */
  symmetryCenterToView() { return this.setSymmetry({ cx: this.camera.x, cy: this.camera.y }); }

  /** Select a WALLPAPER GROUP (one of the 17 names, or null/'' to return to the
   *  legacy radial/grid path). Turning a group ON also flips the master toggle so
   *  the tiling takes effect immediately, mirroring the grid checkbox's grammar. */
  setWallpaperGroup(name) {
    const group = (name && (isWallpaperGroup(name) || isFriezeGroup(name))) ? name : null;
    return this.setSymmetry(group ? { group, on: true } : { group: null });
  }
  /** Alias reading as the unified concept: select any tiling group (wallpaper OR
   *  frieze) by name, or null/'' to return to the legacy radial/grid path. */
  setTilingGroup(name) { return this.setWallpaperGroup(name); }
  /** The 17 wallpaper groups as {name,label,order,family} for menus/tests. */
  wallpaperGroups() { return WALLPAPER_GROUPS.map(g => ({ ...g })); }
  /** The 7 frieze (strip) groups as {name,label,order} for menus/tests. */
  friezeGroups() { return FRIEZE_GROUPS.map(g => ({ ...g })); }
  /** How many motif copies a commit would create right now for the active tiling
   *  group (cosets × tiled cells/periods), or 0 when none is active. */
  wallpaperPlacementCount() {
    const places = this._groupPlacements();
    return places ? places.length : 0;
  }

  /** Fill the #symGroup <select> once with the 17 groups, grouped by family via
   *  <optgroup> so the menu reads as four scannable buckets under the "Mandala"
   *  default. Idempotent — clears any prior options past the first. */
  _populateWallpaperGroups() {
    const sel = document.getElementById('symGroup');
    if (!sel) return;
    while (sel.options.length > 1) sel.remove(1);   // keep option[0] = "Mandala (radial)"
    let group = null, optg = null;
    for (const g of WALLPAPER_GROUPS) {
      if (g.family !== group) {
        group = g.family;
        optg = document.createElement('optgroup');
        optg.label = g.family;
        sel.appendChild(optg);
      }
      const o = document.createElement('option');
      o.value = g.name; o.textContent = g.label;
      optg.appendChild(o);
    }
    // The 7 FRIEZE (strip) groups in their own bucket — the 1-D sibling family.
    const fopt = document.createElement('optgroup');
    fopt.label = 'Frieze (strip)';
    for (const g of FRIEZE_GROUPS) {
      const o = document.createElement('option');
      o.value = g.name; o.textContent = g.label;
      fopt.appendChild(o);
    }
    sel.appendChild(fopt);
  }

  /** Short toast label for picking a group, e.g. "p4m · 4-fold + mirrors" or a
   *  frieze group's "p2mg · spinning sidle — mirror + glide". */
  _wallpaperToastLabel(name) {
    const g = WALLPAPER_GROUPS.find(w => w.name === name) || FRIEZE_GROUPS.find(w => w.name === name);
    return g ? g.label : name;
  }

  /** Reflect the symmetry model into its DOM controls + the toolbar toggle. */
  _syncSymmetryUI() {
    const s = this.symmetry;
    // #symOn is a MODE toggle (aria-pressed button), the in-section twin of the
    // toolbar #symToggleTop — same grammar, both pure reflections of s.on.
    const on = document.getElementById('symOn');
    if (on) { on.classList.toggle('active', s.on); on.setAttribute('aria-pressed', s.on ? 'true' : 'false'); }
    const mir = document.getElementById('symMirror'); if (mir) mir.checked = s.mirror;
    const dom = document.getElementById('symDomain'); if (dom) dom.checked = s.showDomain;
    const sl = document.getElementById('symSlices'); if (sl) sl.value = s.slices;
    const sv = document.getElementById('symSlicesVal'); if (sv) sv.textContent = s.slices;
    const g = s.grid;
    const gOn = document.getElementById('symGrid'); if (gOn) gOn.checked = g.on;
    const gc = document.getElementById('symCols'); if (gc) gc.value = g.cols;
    const gcv = document.getElementById('symColsVal'); if (gcv) gcv.textContent = g.cols;
    const gr = document.getElementById('symRows'); if (gr) gr.value = g.rows;
    const grv = document.getElementById('symRowsVal'); if (grv) grv.textContent = g.rows;
    const gs = document.getElementById('symSpacing'); if (gs && document.activeElement !== gs) gs.value = Math.round(g.dx);
    // wallpaper group: the Pattern <select> + its param block. Exactly one of the
    // mandala / group param blocks is shown (progressive disclosure), so the panel
    // only ever surfaces the controls that actually apply to the chosen pattern.
    const wp = this._wallpaperActive();
    const fz = this._friezeActive();
    const grp = wp || fz;
    const grpSel = document.getElementById('symGroup');
    if (grpSel && document.activeElement !== grpSel) grpSel.value = grp ? s.group : '';
    const mandala = document.getElementById('symMandala'); if (mandala) mandala.hidden = grp;
    const grpRow = document.getElementById('symGroupRow'); if (grpRow) grpRow.hidden = !grp;
    const cellIn = document.getElementById('symCell'); if (cellIn && document.activeElement !== cellIn) cellIn.value = Math.round(s.cell);
    const repsIn = document.getElementById('symReps'); if (repsIn) repsIn.value = s.reps;
    const repsVal = document.getElementById('symRepsVal'); if (repsVal) repsVal.textContent = s.reps;
    const note = document.getElementById('symGroupNote');
    if (note) {
      if (wp) {
        const info = WALLPAPER_GROUPS.find(w => w.name === s.group);
        const per = wallpaperCellCount(s.group);
        note.textContent = `${info ? info.label : s.group} — ${per} cop${per === 1 ? 'y' : 'ies'} per cell, ${this.wallpaperPlacementCount()} drawn.`;
      } else if (fz) {
        const info = FRIEZE_GROUPS.find(w => w.name === s.group);
        const per = friezeCellCount(s.group);
        note.textContent = `${info ? info.label : s.group} — ${per} cop${per === 1 ? 'y' : 'ies'} per period, ${this.wallpaperPlacementCount()} drawn.`;
      } else note.textContent = '';
    }
    const top = document.getElementById('symToggleTop');
    if (top) { top.classList.toggle('active', s.on); top.setAttribute('aria-pressed', s.on ? 'true' : 'false'); }
    // Smart-default (contextual progressive disclosure): the moment mandala mode
    // turns ON, expand the Symmetry section so its controls are right there — but
    // only on the rising edge, so the user can still collapse it while it stays on.
    if (s.on && !this._symWasOn) this._revealSection('sect-symmetry');
    this._symWasOn = s.on;
  }

  /** Open a collapsible style-panel <details> section by id (no-op if absent). */
  _revealSection(id) { const el = document.getElementById(id); if (el && 'open' in el) el.open = true; }

  _saveSymmetry() { try { localStorage.setItem('infinizoom.symmetry', JSON.stringify(this.symmetry)); } catch { /* private mode */ } }
  _loadSymmetry() {
    try {
      const raw = localStorage.getItem('infinizoom.symmetry');
      if (raw) {
        const v = JSON.parse(raw);
        if (v && typeof v === 'object') {
          // merge grid defaults so an older saved shape (no grid) keeps full fields
          const grid = { ...this.symmetry.grid, ...(v.grid && typeof v.grid === 'object' ? v.grid : {}) };
          Object.assign(this.symmetry, v);
          this.symmetry.grid = grid;
          // sanitise the wallpaper fields a stale/old save might carry
          if (this.symmetry.group != null && !isWallpaperGroup(this.symmetry.group) && !isFriezeGroup(this.symmetry.group)) this.symmetry.group = null;
          if (!Number.isFinite(this.symmetry.cell)) this.symmetry.cell = 160;
          if (!Number.isFinite(this.symmetry.reps)) this.symmetry.reps = 2;
          if (typeof this.symmetry.showDomain !== 'boolean') this.symmetry.showDomain = true;
        }
      }
    } catch { /* ignore corrupt */ }
  }

  // ---- pen / shapes ----
  _commitStroke() {
    if (!this.draft) return;
    const eps = this.camera.screenToWorldLen(0.6);
    let pts = simplify(this.draft.points, eps);
    if (pts.length === 0) { this.draft = null; return; }
    const it = makeStroke(pts, { color: this.draft.color, width: this.draft.width, widthMode: this.draft.widthMode,
                                 clampMin: this.draft.clampMin, clampMax: this.draft.clampMax });
    this.draft = null;
    this._commitDrawn([it]);
  }

  // ---- brush (pressure / tapered strokes) ----
  /** Per-point pressure in (0,1]. Uses a genuine stylus pressure signal when one
   *  is present; otherwise derives it from pointer SPEED (fast = thin), which
   *  gives a lively, calligraphic feel even with a plain mouse. */
  _brushPressure(e, s, active) {
    let pr = null;
    // a mouse reports a constant 0.5 — only trust pressure from a real pen/touch
    if (e && e.pointerType && e.pointerType !== 'mouse' && e.pressure > 0) pr = e.pressure;
    if (active && active.lastScreen) {
      const dt = Math.max(1, performance.now() - active.lastT);
      const speed = dist(s.x, s.y, active.lastScreen.x, active.lastScreen.y) / dt; // px/ms
      const speedFactor = clamp(1 - speed / 2.2, 0.28, 1);
      pr = pr == null ? speedFactor : pr * 0.6 + speedFactor * 0.4;
    } else if (pr == null) {
      pr = 0.8; // a confident starting dab
    }
    return clamp(pr, 0.05, 1);
  }

  /** Ramp the first/last ~20% of points down to a fine point so the stroke
   *  enters and leaves on a tapered nib. Blends toward a small ABSOLUTE tip
   *  pressure (not a fraction of the captured value) so the very ends are always
   *  the thinnest part of the stroke, whatever the pen speed was there. */
  _taperEnds(pts) {
    const n = pts.length;
    if (n < 3) return pts;
    const span = Math.max(1, Math.floor(n * 0.22));
    const TIP = 0.06;
    return pts.map((pt, i) => {
      const edge = Math.min(i, n - 1 - i);
      if (edge >= span) return pt;
      const u = edge / span;                        // 0 at the very tip → ~1 inside
      const base = pt.p == null ? 1 : pt.p;
      return { ...pt, p: TIP + (base - TIP) * u };
    });
  }

  _commitBrush() {
    if (!this.draft) return;
    const eps = this.camera.screenToWorldLen(0.6);
    let pts = simplify(this.draft.points, eps);       // RDP keeps whole point objects → `p` survives
    if (pts.length === 0) { this.draft = null; return; }
    pts = this._taperEnds(pts);
    const it = makeStroke(pts, { color: this.draft.color, width: this.draft.width,
                                 widthMode: this.draft.widthMode, opacity: this.draft.opacity,
                                 clampMin: this.draft.clampMin, clampMax: this.draft.clampMax });
    it.taper = true;
    if (this.brushSmooth) it.smooth = true;
    this.draft = null;
    this._commitDrawn([it]);
  }

  _updateShape(start, w, e) {
    const d = this.draft;
    if (d.type === 'line' || d.type === 'arrow') {
      let end = w;
      if (e && e.shiftKey) end = this._constrainAngle(start, w);
      d.points = [start, end];
    } else {
      let ww = w.x - start.x, hh = w.y - start.y;
      if (e && e.shiftKey) { const m = Math.max(Math.abs(ww), Math.abs(hh)); ww = Math.sign(ww || 1) * m; hh = Math.sign(hh || 1) * m; }
      d.x = start.x; d.y = start.y; d.w = ww; d.h = hh;
    }
  }
  _constrainAngle(a, b) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const step = Math.PI / 4;
    const snapped = Math.round(ang / step) * step;
    const len = dist(a.x, a.y, b.x, b.y);
    return { x: a.x + Math.cos(snapped) * len, y: a.y + Math.sin(snapped) * len };
  }
  _commitShape() {
    const d = this.draft;
    this.draft = null;
    if (!d) return;
    if (d.type === 'line' || d.type === 'arrow') {
      const [a, b] = d.points;
      if (dist(a.x, a.y, b.x, b.y) < this.camera.screenToWorldLen(2)) return;
    } else if (Math.abs(d.w) < this.camera.screenToWorldLen(2) && Math.abs(d.h) < this.camera.screenToWorldLen(2)) {
      return;
    }
    this._commitDrawn([d]);
  }

  // ---- fold / spin / glide: BY-REFERENCE transform ops ----
  // The tools place GUIDES; the op captures BASE (non-op) content at commit
  // time — the current selection, or everything not already referenced. Ops
  // auto-link into ONE cyclic program in placement order: the new op is
  // appended to the previous op's ids and points back at the first, so the
  // expansion applies the ops' transforms in the order they were placed,
  // round after round (pan rotate fold pan rotate fold …) — a live fractal
  // with nothing ever baked. `depth` (default 1) = rounds; see bumpRefDepth.

  /** Base (non-op) ids a new op should capture: the selection, else everything
   *  not already referenced by an op (re-referencing would double-draw). */
  _refSourceIds() {
    const taken = new Set();
    for (const it of this.scene.items)
      if (REFOPS.has(it.type) && Array.isArray(it.ids)) for (const id of it.ids) taken.add(id);
    const base = it => it && !REFOPS.has(it.type) && !taken.has(it.id);
    const sel = [...this.selectedIds].map(id => this.scene.byId(id)).filter(base);
    return (sel.length ? sel : this.scene.items.filter(base)).map(it => it.id);
  }

  /** Add `item` (a fresh fold/spin/glide) and link it into the op program:
   *  every program op gains the newly captured base ids (each op applies its
   *  transform to ALL content), the previous op links to the new one, and the
   *  new one points back at the first — one cyclic program in placement order.
   *  One undoable step covering the add + all link mutations. */
  _commitRef(item, baseIds) {
    const scene = this.scene;
    const ops = scene.items.filter(it => REFOPS.has(it.type));
    const first = ops[0] || null, prev = ops[ops.length - 1] || null;
    item.ids.push(...baseIds);
    if (prev) item.ids.push(first.id);          // close the loop in placement order
    this._assignFrame([item]);
    this.history.push({
      label: item.type,
      do() {
        for (const op of ops) for (const id of baseIds) if (!op.ids.includes(id)) op.ids.push(id);
        if (prev && !prev.ids.includes(item.id)) prev.ids.push(item.id);
        scene.addMany([item]);
        scene._touch();
      },
      undo() {
        scene.removeMany([item.id]);
        if (prev) { const i = prev.ids.lastIndexOf(item.id); if (i >= 0) prev.ids.splice(i, 1); }
        for (const op of ops) for (const id of baseIds) { const i = op.ids.lastIndexOf(id); if (i >= 0) op.ids.splice(i, 1); }
        scene._touch();
      },
    });
    const rounds = prev ? ' · linked into the program (iterate deeper for more rounds)' : '';
    this._toast(`${item.type} placed — live by reference${rounds}`);
  }

  _commitFold() {
    const d = this.draft;
    this.draft = null;
    if (!d) return;
    const [a, b] = d.points;
    if (dist(a.x, a.y, b.x, b.y) < this.camera.screenToWorldLen(2)) return;
    const ids = this._refSourceIds();
    if (!ids.length && !this.scene.items.some(it => REFOPS.has(it.type))) {
      this._toast('Nothing to fold — draw something first'); return;
    }
    this._commitRef(makeFold([], a, b), ids);
  }

  _commitGlide() {
    const d = this.draft;
    this.draft = null;
    if (!d) return;
    const [a, b] = d.points;
    if (dist(a.x, a.y, b.x, b.y) < this.camera.screenToWorldLen(2)) return;
    const ids = this._refSourceIds();
    if (!ids.length && !this.scene.items.some(it => REFOPS.has(it.type))) {
      this._toast('Nothing to glide — draw something first'); return;
    }
    this._commitRef(makeGlide([], a, b), ids);
  }

  _commitSpin(angle) {
    const pivot = this._spinPivot;
    this.draft = null;
    this._spinPivot = null;
    this._refGuide = null;
    if (!pivot || Math.abs(angle) < Math.PI / 180) return;   // swept < ~1°: cancel
    const ids = this._refSourceIds();
    if (!ids.length && !this.scene.items.some(it => REFOPS.has(it.type))) {
      this._toast('Nothing to spin — draw something first'); return;
    }
    // Copy count: when the swept angle divides the circle, complete the rosette
    // (the k = n copy would land exactly on the originals, so n−1 copies). Any
    // other angle gives ONE rotated copy — the primitive for composing fractals.
    const n = Math.round(Math.PI * 2 / Math.abs(angle));
    const closes = n >= 2 && Math.abs(n * Math.abs(angle) - Math.PI * 2) < 0.02;
    const count = closes ? n - 1 : 1;
    this._commitRef(makeSpin([], pivot.x, pivot.y, angle, count), ids);
    const deg = Math.round(angle * 180 / Math.PI);
    this._toast(closes ? `Spin: rosette of ${n} × ${deg}°` : `Spin: one copy at ${deg}°`);
  }

  /** Adjust the recursion DEPTH (rounds) of the program containing the selected
   *  op(s), as one undoable step. The whole linked program moves together. */
  bumpRefDepth(d) {
    const scene = this.scene;
    const map = scene.refRootMap();
    const seed = [...this.selectedIds].map(id => scene.byId(id)).find(it => it && REFOPS.has(it.type));
    if (!seed) return;
    const root = map.get(seed.id) || seed;
    const program = scene.items.filter(it => REFOPS.has(it.type) && (map.get(it.id) || it) === root);
    const changes = program
      .map(it => ({ it, had: 'depth' in it, before: it.depth ?? 1, after: clamp((it.depth ?? 1) + d, 1, 12) }))
      .filter(c => c.after !== c.before);
    if (!changes.length) { this._toast(d > 0 ? 'Recursion depth already at max (12)' : 'Already at 1 round'); return; }
    this.history.push({
      label: 'ref depth',
      do() { for (const c of changes) c.it.depth = c.after; scene._touch(); },
      undo() { for (const c of changes) { if (c.had) c.it.depth = c.before; else delete c.it.depth; } scene._touch(); },
    });
    this._toast(`Recursion depth → ${changes[0].after} round${changes[0].after === 1 ? '' : 's'}`);
    this.requestRender();
  }

  // ---- eraser ----
  _lodFilter() { const s = this.camera.scale; return it => lodVisible(it, s) && this._frameInteractive(it); }
  /** Pick filter for selection/erase: also excludes locked items (hidden ones
   *  are already skipped inside Scene.pick). Connectors keep the looser
   *  _lodFilter so they can still snap onto a locked object. */
  _selFilter() { const s = this.camera.scale; return it => lodVisible(it, s) && !this.scene.isItemLocked(it) && this._frameInteractive(it); }

  /** In flipbook mode only items on the current page can be picked/edited;
   *  off-page pages are onion-skin ghosts. With flipbook OFF, everything is live. */
  _frameInteractive(it) { return !this.anim.on || (it.frame || 0) === this.anim.current; }

  /** Sample the colour of the top-most item under a world point into the palette. */
  eyedrop(wx, wy) {
    const hit = this.scene.pick(wx, wy, this.camera.screenToWorldLen(6), this._lodFilter());
    if (hit && hit.color) { this.setStyle({ color: hit.color }); this._toast(`Picked ${hit.color}`); return hit.color; }
    return null;
  }

  _eraseRadiusWorld() { return this.camera.screenToWorldLen(10) + this.style.width / 2; }
  _eraseAt(w, _s) {
    const tol = this._eraseRadiusWorld();
    const hit = this.scene.pick(w.x, w.y, tol, this._selFilter()); // never erase locked/hidden
    if (hit && this.active && !this.active.removed.includes(hit)) {
      this.active.removed.push(hit);
      this.scene.remove(hit.id);
      // erasing an endpoint item takes its connectors with it
      if (hit.type !== 'connector') {
        for (const c of this._connectorsReferencing([hit.id])) {
          if (!this.active.removed.includes(c)) { this.active.removed.push(c); this.scene.remove(c.id); }
        }
      }
    }
  }

  // ---- selection ----
  /** Build a move gesture: capture the closure, the start grab point, the seed
   *  bbox to snap, and the per-gesture snap-target cache (other items don't move
   *  during the drag, so the cache is computed once here). */
  _moveGesture(w) {
    const ids = this._transformClosure(this.selectedIds);
    this._snapCands = this._buildSnapCands(new Set(ids));
    this.activeGuides = null;
    return { kind: 'move', startWorld: w, bbox0: this._seedBBox(), applied: { dx: 0, dy: 0 }, ids };
  }

  _beginSelect(s, w, e) {
    // Grabbing the rotation handle starts a rotate gesture (highest priority).
    // Grabbing a CUSTOM pivot marker repositions it (highest priority). The auto
    // (selection-centre) marker is display-only so clicking the centre still drags
    // the selection — a custom pivot is created with Shift+P / setPivot first.
    if (this.pivot) {
      const pm = this._pivotScreen();
      if (pm && dist(s.x, s.y, pm.x, pm.y) <= 9) { this.active = { kind: 'pivot' }; return; }
    }
    const handle = this._rotHandleScreen();
    if (handle && dist(s.x, s.y, handle.x, handle.y) <= handle.r + 6) {
      const pivot = this._pivotWorld();
      if (pivot) {
        this.active = { kind: 'rotate', pivot, applied: 0,
                        startAngle: Math.atan2(w.y - pivot.y, w.x - pivot.x),
                        ids: this._transformClosure(this.selectedIds) };
        return;
      }
    }
    // Grabbing a corner handle starts a uniform resize about the opposite corner
    // (the diagonally-opposite corner stays pinned, like a standard vector editor).
    const handles = this._scaleHandlesScreen();
    if (handles) {
      for (const h of handles) {
        if (dist(s.x, s.y, h.x, h.y) <= 9) {
          // Default scale pivot is the diagonally-opposite corner; a custom pivot
          // (set via the pivot marker) overrides it so the corner drag scales the
          // selection about the user's chosen point instead.
          const pivx = this.pivot ? this.pivot.x : h.ox;
          const pivy = this.pivot ? this.pivot.y : h.oy;
          const dx = h.wx - pivx, dy = h.wy - pivy;
          const baseLen = Math.hypot(dx, dy);
          // guard a genuinely degenerate (zero-size) selection — in SCREEN px, so a
          // deep-zoom shape (tiny world baseLen but large on screen) still scales.
          if (baseLen * this.camera.scale > 1e-3) {
            const ids = this._transformClosure(this.selectedIds);
            // smart guides during resize: snap the grabbed corner to other items'
            // edges/centres (uniform scale slides it along the corner→pivot ray)
            this._snapCands = this._buildSnapCands(new Set(ids));
            this.activeGuides = null;
            this.active = { kind: 'scale', pivot: { x: pivx, y: pivy },
                            dirx: dx / baseLen, diry: dy / baseLen, baseLen,
                            corner0: { x: h.wx, y: h.wy }, applied: 1, ids };
            return;
          }
        }
      }
    }
    const tol = this.camera.screenToWorldLen(6);
    // If clicking inside the bbox of an already-selected item, drag the whole
    // selection — even over an unfilled interior. This matches vector editors.
    if (this.selectedIds.size && !e.shiftKey) {
      for (const id of this.selectedIds) {
        const it = this.scene.byId(id);
        if (it && !this.scene.isItemLocked(it) && pointInRect(w.x, w.y, itemBBox(it))) {
          this.active = this._moveGesture(w);
          return;
        }
      }
    }
    const hit = this.scene.pick(w.x, w.y, tol, this._selFilter());
    if (hit) {
      const members = this._groupMembers(hit); // grouped items select as a unit
      if (e.shiftKey) {
        const allIn = members.every(id => this.selectedIds.has(id));
        for (const id of members) allIn ? this.selectedIds.delete(id) : this.selectedIds.add(id);
      } else if (!this.selectedIds.has(hit.id)) {
        this.selectedIds = new Set(members);
        this.pivot = null;   // selection fully replaced → drop any custom pivot
      }
      this._activeId = hit.id; // the just-clicked item becomes the parent target
      if (this.selectedIds.size) {
        this.active = this._moveGesture(w);
      }
    } else {
      if (!e.shiftKey) { this.selectedIds.clear(); this.pivot = null; this._activeId = null; }
      this.marquee = { x0: s.x, y0: s.y, x1: s.x, y1: s.y };
      this.active = { kind: 'marquee' };
    }
    this._updateHud();
  }
  _commitMarquee() {
    if (!this.marquee) return;
    const a = this.toWorld(this.marquee.x0, this.marquee.y0);
    const b = this.toWorld(this.marquee.x1, this.marquee.y1);
    const rect = { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
    if (Math.abs(this.marquee.x1 - this.marquee.x0) > 3 || Math.abs(this.marquee.y1 - this.marquee.y0) > 3) {
      const hits = this.scene.itemsContainedIn(rect);
      for (const it of hits) if (this._frameInteractive(it)) this.selectedIds.add(it.id);
      this._expandSelectionGroups(); // pull in the rest of any touched group
    }
    this.marquee = null;
    this._updateHud();
  }
  deleteSelection() {
    if (!this.selectedIds.size) return;
    const items = [...this.selectedIds].map(id => this.scene.byId(id)).filter(Boolean);
    const ids = new Set(items.map(i => i.id));
    // also drop connectors that would be left dangling, in the same undo step
    const orphans = this._connectorsReferencing(ids).filter(c => !ids.has(c.id));
    this.history.push(removeItemsCmd(this.scene, [...items, ...orphans]));
    this.selectedIds.clear();
    this._activeId = null;
    this._updateHud();
  }
  selectAll() {
    this.selectedIds = new Set(this.scene.items.filter(i => !this.scene.isItemLocked(i) && !this.scene.isItemHidden(i) && this._frameInteractive(i)).map(i => i.id));
    this._activeId = null;
    if (this.tool !== 'select') this.setTool('select');
    this._updateHud();
    this.requestRender();
  }

  /** Move the selection by a world-space delta as one undoable step (arrow keys). */
  nudgeSelection(dx, dy) {
    if (!this.selectedIds.size || (!dx && !dy)) return;
    // a locked SEED can't be nudged, but its (cascaded) descendants ride along
    const seeds = [...this.selectedIds].filter(id => { const it = this.scene.byId(id); return it && !this.scene.isItemLocked(it); });
    if (!seeds.length) return;
    const ids = this._transformClosure(seeds);
    this.history.push(moveItemsCmd(this.scene, ids, dx, dy, translateItem));
    this._updateHud();
    this.requestRender();
  }

  // ---- parenting: transform closure ----
  /** The ids a transform gesture actually affects: the seed selection plus ALL
   *  descendants (parent transforms cascade down the tree). Descendants ride
   *  along regardless of lock/hidden — a parent link is a rigid structural bond,
   *  so the whole assembly moves as one. The transform PIVOT, handles and
   *  selection visuals still track only the seed selection (so children orbit the
   *  parent, Blender-style), but the geometry edit reaches the whole subtree. */
  _transformClosure(seedIds) {
    const set = new Set(seedIds);
    for (const d of this.scene.descendantsOf([...set])) set.add(d);
    return [...set];
  }

  // ---- rotation ----
  _selectionItems() { return [...this.selectedIds].map(id => this.scene.byId(id)).filter(Boolean); }

  /** Clear the current selection (the inspector's Deselect affordance + a hook
   *  callers can share). No-op when nothing is selected. */
  deselectAll() {
    if (!this.selectedIds.size) return;
    this.selectedIds.clear();
    this._activeId = null;
    this.pivot = null;
    this._updateHud();
    this.requestRender();
  }

  /** Friendly display name for an item type (drives the contextual inspector). */
  _typeName(it) {
    switch (it.type) {
      case 'stroke': return 'Stroke';
      case 'line': return 'Line';
      case 'arrow': return 'Arrow';
      case 'rect': return 'Rectangle';
      case 'ellipse': return 'Ellipse';
      case 'polygon': return it.star ? 'Star' : 'Polygon';
      case 'text': return 'Text';
      case 'image': return 'Image';
      case 'connector': return 'Connector';
      case 'pixel': return 'Pixel sprite';
      default: return it.type ? it.type[0].toUpperCase() + it.type.slice(1) : 'Object';
    }
  }

  /** "W × H" of a single item's world-space bbox, at a sensible precision. */
  _selDimsLabel(it) {
    const b = itemBBox(it);
    const r = v => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
    return `${r(b.maxX - b.minX)} × ${r(b.maxY - b.minY)}`;
  }

  /** "2 rectangles · 1 line" — counts by friendly type for a multi-selection. */
  _typeBreakdown(items) {
    const counts = {};
    for (const it of items) { const n = this._typeName(it); counts[n] = (counts[n] || 0) + 1; }
    return Object.entries(counts)
      .map(([n, c]) => (c > 1 ? `${c} ${n.toLowerCase()}s` : n.toLowerCase()))
      .join(' · ');
  }

  /** Contextual selection inspector: reflect WHAT is selected (type + size) and
   *  make the already-live "edits apply to the selection" behaviour visible.
   *  Cheap signature guard (sorted ids + doc revision) so the chokepoint
   *  (_updateHud, fired on every pointer move) touches the DOM only when the
   *  selection set or geometry actually changes. */
  _syncSelectionUI() {
    const el = document.getElementById('sel-inspector');
    if (!el) return;
    const ids = [...this.selectedIds].sort();
    const sig = ids.join(',') + '#' + this._docRev;
    if (sig === this._selUiSig) return;
    this._selUiSig = sig;
    const items = ids.map(id => this.scene.byId(id)).filter(Boolean);
    if (!items.length) { el.hidden = true; return; }
    el.hidden = false;
    const title = document.getElementById('sel-title');
    const meta = document.getElementById('sel-meta');
    if (items.length === 1) {
      if (title) title.textContent = this._typeName(items[0]);
      if (meta) meta.textContent = this._selDimsLabel(items[0]);
    } else {
      if (title) title.textContent = `${items.length} selected`;
      if (meta) meta.textContent = this._typeBreakdown(items);
    }
  }

  /** World-space centre of the current selection's combined bbox (rotation pivot). */
  _selectionWorldCenter() {
    const items = this._selectionItems();
    if (!items.length) return null;
    let b = { ...itemBBox(items[0]) };
    for (const it of items) {
      const ib = itemBBox(it);
      b.minX = Math.min(b.minX, ib.minX); b.minY = Math.min(b.minY, ib.minY);
      b.maxX = Math.max(b.maxX, ib.maxX); b.maxY = Math.max(b.maxY, ib.maxY);
    }
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  }

  /** World-space CENTRE OF MASS of the current selection: the area/mass-weighted
   *  centroid of all selected items (a triangle balances at its centroid, not its
   *  bbox middle). Each item contributes (centroid, mass); 2D shapes weigh by area,
   *  1D paths by length×stroke-width (see itemCentroidMass). Falls back to a length-
   *  weighted, then plain, average when the selection has no area (e.g. hairlines /
   *  bare points). Null when nothing is selected. */
  _selectionCenterOfMass() {
    const items = this._selectionItems();
    if (!items.length) return null;
    let mx = 0, my = 0, m = 0;   // mass-weighted accumulator (area / virtual-area)
    let lx = 0, ly = 0, L = 0;   // length-weighted fallback
    let sx = 0, sy = 0, n = 0;   // plain-average last resort
    for (const it of items) {
      const c = itemCentroidMass(it);
      if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
      if (c.mass > 0) { mx += c.x * c.mass; my += c.y * c.mass; m += c.mass; }
      if (c.len > 0) { lx += c.x * c.len; ly += c.y * c.len; L += c.len; }
      sx += c.x; sy += c.y; n++;
    }
    if (m > 0) return { x: mx / m, y: my / m };
    if (L > 0) return { x: lx / L, y: ly / L };
    if (n > 0) return { x: sx / n, y: sy / n };
    return this._selectionWorldCenter();
  }

  /** Effective transform pivot in world coords: the user's custom pivot if set,
   *  else (comPivot mode) the selection's centre of mass, else its bbox centre.
   *  Null when nothing is selected. */
  _pivotWorld() {
    if (!this.selectedIds.size) return null;
    if (this.pivot) return this.pivot;
    return this.comPivot ? this._selectionCenterOfMass() : this._selectionWorldCenter();
  }

  /** Toggle the auto-pivot mode between bbox centre and centre of mass. Keeps the
   *  checkbox + storage in sync; a live custom pivot is untouched (it still wins). */
  setComPivot(on) {
    this.comPivot = !!on;
    const el = document.getElementById('comPivotToggle'); if (el) el.checked = this.comPivot;
    this._saveSnapCfg();
    this.requestRender();
  }
  toggleComPivot() { this.setComPivot(!this.comPivot); }

  /** Screen position + custom flag of the pivot marker, or null. Shown only for
   *  the select tool with a live selection (like the rotate/scale handles). */
  _pivotScreen() {
    if (this.tool !== 'select' || !this.selectedIds.size) return null;
    const p = this._pivotWorld();
    if (!p) return null;
    const sc = this.camera.worldToScreen(p.x, p.y);
    return { x: sc.x, y: sc.y, custom: !!this.pivot };
  }

  /** Snap a world point to the nearest of the selection bbox's 9 key points
   *  (corners, edge midpoints, centre) for ⇧-drag of the pivot. */
  _snapPivot(w) {
    const b = this._selectionWorldAABB() || this._selectionWorldCenter();
    if (!b) return w;
    if (b.minX === undefined) return b; // a single point selection
    const xs = [b.minX, (b.minX + b.maxX) / 2, b.maxX];
    const ys = [b.minY, (b.minY + b.maxY) / 2, b.maxY];
    let best = w, bestD = Infinity;
    for (const x of xs) for (const y of ys) {
      const d = (x - w.x) ** 2 + (y - w.y) ** 2;
      if (d < bestD) { bestD = d; best = { x, y }; }
    }
    return best;
  }

  /** Reset the transform pivot to auto (selection bbox centre). */
  clearPivot() { this.pivot = null; this.requestRender(); }

  /** Shift+P: drop a custom pivot at the current auto-pivot (the bbox centre, or the
   *  centre of mass when that mode is on), then drag it to taste — or clear it back to
   *  auto if one is already set. No-op with no selection. */
  togglePivot() {
    if (!this.selectedIds.size) return;
    if (this.pivot) { this.pivot = null; this._toast('pivot reset to centre'); }
    else {
      const c = this.comPivot ? this._selectionCenterOfMass() : this._selectionWorldCenter();
      if (!c) return;
      this.pivot = { x: c.x, y: c.y };
      this._toast('pivot set — drag it to move, ⇧ snaps, double-click resets');
    }
    this.requestRender();
  }

  /** Set a custom transform pivot in world coords (used by tests / API). */
  setPivot(x, y) {
    if (!this.selectedIds.size) return;
    this.pivot = { x, y };
    this.requestRender();
  }

  /** Screen-space AABB enclosing the visible selection, or null. */
  _selectionAABBScreen() {
    if (!this.selectedIds.size) return null;
    let any = false, R = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const id of this.selectedIds) {
      const it = this.scene.byId(id);
      if (!it || !lodVisible(it, this.camera.scale)) continue;
      any = true;
      const b = itemBBox(it);
      const tl = this.camera.worldToScreen(b.minX, b.minY);
      const br = this.camera.worldToScreen(b.maxX, b.maxY);
      R.minX = Math.min(R.minX, tl.x); R.minY = Math.min(R.minY, tl.y);
      R.maxX = Math.max(R.maxX, br.x); R.maxY = Math.max(R.maxY, br.y);
    }
    return any ? R : null;
  }

  /** Screen position of the rotation grab handle above the selection, or null. */
  _rotHandleScreen() {
    if (this.tool !== 'select' || !this.selectedIds.size) return null;
    const R = this._selectionAABBScreen();
    if (!R) return null;
    return { x: (R.minX + R.maxX) / 2, y: R.minY - 22, r: 6 };
  }

  /** World-space AABB of the visible selection (union of item bboxes), or null. */
  _selectionWorldAABB() {
    const items = this._selectionItems().filter(it => lodVisible(it, this.camera.scale));
    if (!items.length) return null;
    let b = { ...itemBBox(items[0]) };
    for (const it of items) {
      const ib = itemBBox(it);
      b.minX = Math.min(b.minX, ib.minX); b.minY = Math.min(b.minY, ib.minY);
      b.maxX = Math.max(b.maxX, ib.maxX); b.maxY = Math.max(b.maxY, ib.maxY);
    }
    return b;
  }

  /** The four corner resize handles (screen px), each tagged with its own world
   *  corner (wx,wy) and the diagonally-opposite corner (ox,oy) used as the scale
   *  pivot. Null unless the select tool has a non-degenerate selection. */
  _scaleHandlesScreen() {
    if (this.tool !== 'select' || !this.selectedIds.size) return null;
    const b = this._selectionWorldAABB();
    if (!b) return null;
    // "a point can't be resized" — measured in SCREEN px, not world units. A
    // deep-zoom shape spans < 1e-12 world units yet can be hundreds of px on
    // screen; an absolute world threshold wrongly hid its resize handles at high
    // zoom (Danielle, 2026-06-28).
    const sc = this.camera.scale;
    if ((b.maxX - b.minX) * sc < 1 && (b.maxY - b.minY) * sc < 1) return null;
    const corners = [
      { wx: b.minX, wy: b.minY, ox: b.maxX, oy: b.maxY }, // nw, pivot se
      { wx: b.maxX, wy: b.minY, ox: b.minX, oy: b.maxY }, // ne, pivot sw
      { wx: b.maxX, wy: b.maxY, ox: b.minX, oy: b.minY }, // se, pivot nw
      { wx: b.minX, wy: b.maxY, ox: b.maxX, oy: b.minY }, // sw, pivot ne
    ];
    return corners.map(c => {
      const sc = this.camera.worldToScreen(c.wx, c.wy);
      return { x: sc.x, y: sc.y, wx: c.wx, wy: c.wy, ox: c.ox, oy: c.oy };
    });
  }

  /** Uniformly scale the selection by `factor` about a pivot (default: selection
   *  centre). Reversible. Used by the test API and the ⤢/⤡ buttons. */
  scaleSelection(factor, pivot = null) {
    if (!this.selectedIds.size || !(factor > 0) || Math.abs(factor - 1) < 1e-12) return;
    const b = this._selectionWorldAABB();
    const p = pivot || this.pivot ||
      (this.comPivot ? this._selectionCenterOfMass()
                     : (b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : null));
    if (!p) return;
    const ids = this._transformClosure(this.selectedIds), scene = this.scene;
    const grab = () => ids.map(id => scene.byId(id)).filter(Boolean);
    this.history.push({
      label: `scale ${ids.length}`,
      do() { for (const it of grab()) scaleItemAbout(it, p.x, p.y, factor); scene._touch(); },
      undo() { for (const it of grab()) scaleItemAbout(it, p.x, p.y, 1 / factor); scene._touch(); },
    });
    this.requestRender();
  }

  /** Rotate the selection by `ang` radians about a pivot (default: selection centre). */
  rotateSelection(ang, pivot = null) {
    if (!this.selectedIds.size || !ang) return;
    const p = pivot || this.pivot || (this.comPivot ? this._selectionCenterOfMass() : this._selectionWorldCenter());
    if (!p) return;
    const ids = this._transformClosure(this.selectedIds);
    const scene = this.scene;
    const grab = () => ids.map(id => scene.byId(id)).filter(Boolean);
    this.history.push({
      label: `rotate ${ids.length}`,
      do() { rotateItemsAbout(grab(), p.x, p.y, ang); scene._touch(); },
      undo() { rotateItemsAbout(grab(), p.x, p.y, -ang); scene._touch(); },
    });
    this.requestRender();
  }

  // ---- grouping ----
  /** All item ids sharing a group with `it` (or just [it.id] if it is ungrouped). */
  _groupMembers(it) {
    if (!it) return [];
    if (!it.group) return [it.id];
    return this.scene.items.filter(o => o.group === it.group).map(o => o.id);
  }
  /** Grow the current selection so any touched group is selected whole. */
  _expandSelectionGroups() {
    const groups = new Set();
    for (const id of this.selectedIds) { const it = this.scene.byId(id); if (it && it.group) groups.add(it.group); }
    if (!groups.size) return;
    for (const it of this.scene.items) if (it.group && groups.has(it.group)) this.selectedIds.add(it.id);
  }

  /** Tag all selected items with one fresh group id (reversible). Needs ≥2 items. */
  groupSelection() {
    const ids = [...this.selectedIds];
    if (ids.length < 2) { this._toast('Select 2+ items to group'); return null; }
    const gid = 'grp_' + Math.random().toString(36).slice(2, 9);
    const scene = this.scene;
    const before = ids.map(id => ({ id, group: scene.byId(id)?.group ?? null }));
    this.history.push({
      label: `group ${ids.length}`,
      do() { for (const id of ids) { const it = scene.byId(id); if (it) it.group = gid; } scene._touch(); },
      undo() { for (const { id, group } of before) { const it = scene.byId(id); if (it) { if (group == null) delete it.group; else it.group = group; } } scene._touch(); },
    });
    this._toast(`Grouped ${ids.length} items`);
    this.requestRender();
    return gid;
  }

  /** Remove the group tag from every member of any group in the selection. */
  ungroupSelection() {
    const groups = new Set();
    for (const id of this.selectedIds) { const it = this.scene.byId(id); if (it && it.group) groups.add(it.group); }
    if (!groups.size) return 0;
    const before = this.scene.items.filter(it => it.group && groups.has(it.group)).map(it => ({ id: it.id, group: it.group }));
    const scene = this.scene;
    this.history.push({
      label: 'ungroup',
      do() { for (const { id } of before) { const it = scene.byId(id); if (it) delete it.group; } scene._touch(); },
      undo() { for (const { id, group } of before) { const it = scene.byId(id); if (it) it.group = group; } scene._touch(); },
    });
    this._toast(`Ungrouped ${before.length} items`);
    this.requestRender();
    return before.length;
  }

  /** Re-map group ids on a freshly-cloned item set so clones stay grouped among
   *  themselves but distinct from the originals. Mutates items in place. */
  _remapGroups(items) {
    const map = new Map();
    for (const c of items) {
      if (!c.group) continue;
      if (!map.has(c.group)) map.set(c.group, 'grp_' + Math.random().toString(36).slice(2, 9));
      c.group = map.get(c.group);
    }
  }

  // ---- parenting: clone re-linking ----
  /** After cloning a set, re-point each clone's `parent` at the cloned parent
   *  when the parent was part of the copy (so a duplicated parent+child stays a
   *  family); otherwise leave the original parent id (the clone stays parented to
   *  the original). A dangling parent is harmless — treated as a root. */
  _relinkParents(items, idMap) {
    for (const it of items) {
      if (it.parent == null) continue;
      if (idMap.has(it.parent)) it.parent = idMap.get(it.parent);
    }
  }

  // ---- parenting ----
  /** The parent target for parentSelection(): the active (last-clicked) item if
   *  it's still in the selection, else the most-recently-added selected item
   *  (Set preserves insertion order). Null when nothing is selected. */
  _parentTarget() {
    if (this._activeId && this.selectedIds.has(this._activeId)) return this._activeId;
    const arr = [...this.selectedIds];
    return arr.length ? arr[arr.length - 1] : null;
  }

  /** Parent every OTHER selected item to the active (last-clicked) item, so
   *  transforming the parent now cascades onto them. Skips any that would create
   *  a cycle (can't parent to your own descendant) or are already there.
   *  Reversible as one atomic step. */
  parentSelection() {
    if (this.selectedIds.size < 2) { this._toast('Select 2+ items, then parent to the active one'); return 0; }
    const target = this._parentTarget();
    if (!target) return 0;
    const scene = this.scene;
    const changes = []; // { id, before }
    let skipped = 0;
    for (const id of this.selectedIds) {
      if (id === target) continue;
      const it = scene.byId(id);
      if (!it) continue;
      if (scene.wouldCreateCycle(id, target)) { skipped++; continue; } // would loop the tree
      if (it.parent === target) continue;                              // already parented here
      changes.push({ id, before: it.parent ?? null });
    }
    if (!changes.length) {
      this._toast(skipped ? 'Skipped — would create a parenting cycle' : 'Already parented');
      return 0;
    }
    this.history.push({
      label: `parent ${changes.length}`,
      do() { for (const { id } of changes) { const it = scene.byId(id); if (it) it.parent = target; } scene._touch(); },
      undo() { for (const { id, before } of changes) { const it = scene.byId(id); if (it) { if (before == null) delete it.parent; else it.parent = before; } } scene._touch(); },
    });
    this._toast(`Parented ${changes.length} item${changes.length === 1 ? '' : 's'}${skipped ? ` (skipped ${skipped})` : ''}`);
    this.requestRender();
    return changes.length;
  }

  /** Clear the `parent` of every selected item (detach from its hierarchy).
   *  Reversible. Geometry is untouched — nothing moves. */
  unparentSelection() {
    const scene = this.scene;
    const changes = [];
    for (const id of this.selectedIds) {
      const it = scene.byId(id);
      if (it && it.parent != null) changes.push({ id, before: it.parent });
    }
    if (!changes.length) { this._toast('Nothing to unparent'); return 0; }
    this.history.push({
      label: `unparent ${changes.length}`,
      do() { for (const { id } of changes) { const it = scene.byId(id); if (it) delete it.parent; } scene._touch(); },
      undo() { for (const { id, before } of changes) { const it = scene.byId(id); if (it) it.parent = before; } scene._touch(); },
    });
    this._toast(`Unparented ${changes.length} item${changes.length === 1 ? '' : 's'}`);
    this.requestRender();
    return changes.length;
  }

  /** Re-parent ONE item to a new parent (or null to detach) — the model op
   *  behind drag-to-reparent in the Objects panel. Cycle-guarded (can't drop
   *  onto your own descendant) and a single reversible step. Geometry is
   *  untouched (world coords), so nothing moves. Returns true if it changed. */
  reparentItem(childId, newParentId) {
    const scene = this.scene;
    const it = scene.byId(childId);
    if (!it) return false;
    const after = newParentId == null ? null : newParentId;
    if (after === childId) return false;                       // can't parent to self
    if (after != null) {
      if (!scene.byId(after)) return false;                   // dropped on nothing
      if (scene.wouldCreateCycle(childId, after)) { this._toast('Skipped — would create a parenting cycle'); return false; }
    }
    const before = it.parent ?? null;
    if (before === after) return false;                       // already there
    this.history.push({
      label: after ? 'reparent' : 'unparent',
      do() { const x = scene.byId(childId); if (x) { if (after == null) delete x.parent; else x.parent = after; } scene._touch(); },
      undo() { const x = scene.byId(childId); if (x) { if (before == null) delete x.parent; else x.parent = before; } scene._touch(); },
    });
    this._toast(after ? `Reparented → ${this._layerLabel(scene.byId(after)).trim()}` : 'Unparented (now a root)');
    this.requestRender();
    return true;
  }

  // ---- connectors ----
  /** After cloning a subgraph, re-point cloned connectors at the cloned items
   *  (when both ends were copied), so the copy stays internally wired. */
  _relinkConnectors(items, idMap) {
    for (const it of items) {
      if (it.type !== 'connector') continue;
      if (idMap.has(it.from)) it.from = idMap.get(it.from);
      if (idMap.has(it.to)) it.to = idMap.get(it.to);
    }
  }

  /** Fold/spin/glide clones: re-point source ids that were copied in the SAME
   *  batch at the new clones (copy a motif + its op together and the new op
   *  references the new motif). Ids outside the batch stay as-is — the
   *  by-reference link to the live originals is the point of these items. */
  _relinkRefs(items, idMap) {
    for (const it of items) {
      if (!REFOPS.has(it.type) || !Array.isArray(it.ids)) continue;
      it.ids = it.ids.map(id => idMap.get(id) || id);
    }
  }

  _itemCenter(it) { const b = itemBBox(it); return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }; }

  /** Recompute one connector's endpoint cache (ax..by) from the items it links,
   *  clipping each end to the linked item's bbox edge. Leaves danglers untouched. */
  _resolveConnector(it) {
    const A = this.scene.byId(it.from), B = this.scene.byId(it.to);
    if (!A || !B) return false;
    const ba = itemBBox(A), bb = itemBBox(B);
    const ca = { x: (ba.minX + ba.maxX) / 2, y: (ba.minY + ba.maxY) / 2 };
    const cb = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
    const a = boxEdgePoint(ca.x, ca.y, cb.x, cb.y, ba);
    const b = boxEdgePoint(cb.x, cb.y, ca.x, ca.y, bb);
    it.ax = a.x; it.ay = a.y; it.bx = b.x; it.by = b.y;
    return true;
  }
  /** Refresh every connector's endpoint cache so they track their items. Cheap;
   *  run before any render or bounds query. Does not mutate the document model. */
  resolveConnectors() {
    for (const it of this.scene.items) if (it.type === 'connector') this._resolveConnector(it);
  }

  /** Connectors whose `from`/`to` falls in the given id set. */
  _connectorsReferencing(ids) {
    const set = ids instanceof Set ? ids : new Set(ids);
    return this.scene.items.filter(it => it.type === 'connector' && (set.has(it.from) || set.has(it.to)));
  }

  /** Create a connector linking two existing items. Returns its id (or null). */
  addConnector(fromId, toId, style = {}) {
    if (fromId === toId || !this.scene.byId(fromId) || !this.scene.byId(toId)) return null;
    const it = makeConnector(fromId, toId,
      { color: this.style.color, width: this.style.width, arrow: true, ...style });
    this._resolveConnector(it);
    this._assignFrame([it]);
    this.history.push(addItemsCmd(this.scene, [it]));
    this._toast('Connected');
    return it.id;
  }

  _beginConnector(s, w) {
    const from = this.scene.pick(w.x, w.y, this.camera.screenToWorldLen(6), this._lodFilter());
    if (!from || from.type === 'connector') { this.active = null; return; }
    const c = this._itemCenter(from);
    const wr = this.toWorld(s.x, s.y);
    this.draft = { type: 'connector', from: from.id, to: from.id,
                   ax: c.x, ay: c.y, bx: wr.x, by: wr.y,
                   color: this.style.color, width: this.style.width, arrow: true };
    this.active = { kind: 'connect', from: from.id };
  }
  _endConnector(s, a) {
    this.draft = null;
    if (!a) return;
    const w = this.toWorld(s.x, s.y);
    const target = this.scene.pick(w.x, w.y, this.camera.screenToWorldLen(6), this._lodFilter());
    if (target && target.id !== a.from && target.type !== 'connector') {
      // Anchor the connector's world width to the current zoom (like _newItemStyle)
      // so a connector drawn at deep zoom isn't a screen-filling blob. Connectors
      // carry no widthMode (always world), so always divide. At scale 1: unchanged.
      const s = this.camera.scale;
      const width = (s > 0 && Number.isFinite(s)) ? this.style.width / s : this.style.width;
      this.addConnector(a.from, target.id, { width });
    }
  }

  // ---- pinch ----
  _beginPinch() {
    const pts = [...this.pointers.values()];
    this.draft = null; this.active = null;
    const ang = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
    this.pinch = {
      startDist: dist(pts[0].x, pts[0].y, pts[1].x, pts[1].y),
      startScale: this.camera.scale,
      lastMid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
      startAngle: ang,    // angle of the finger-line at gesture start
      lastAngle: ang,
      twisted: false,     // latched true once the twist clears the deadzone
    };
  }
  _updatePinch() {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const d = dist(pts[0].x, pts[0].y, pts[1].x, pts[1].y);
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const targetScale = this.pinch.startScale * (d / Math.max(this.pinch.startDist, 1));
    this.camera.zoomTo(targetScale, mid.x, mid.y);
    this.camera.panByScreen(mid.x - this.pinch.lastMid.x, mid.y - this.pinch.lastMid.y);
    this.pinch.lastMid = mid;

    // Two-finger TWIST → canvas rotation. A small deadzone keeps a straight
    // pinch-zoom from wobbling the canvas; once a real twist is detected the
    // gesture stays engaged and rotation tracks incrementally about the midpoint.
    const ang = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
    const norm = (a) => (a > Math.PI ? a - 2 * Math.PI : a < -Math.PI ? a + 2 * Math.PI : a);
    if (!this.pinch.twisted && Math.abs(norm(ang - this.pinch.startAngle)) > 0.052) { // ~3°
      this.pinch.twisted = true;
    }
    if (this.pinch.twisted) this.camera.rotateBy(norm(ang - this.pinch.lastAngle), mid.x, mid.y);
    this.pinch.lastAngle = ang;

    this._updateHud();
    this.requestRender();
  }

  // ---- text ----
  _startText(s, w) {
    this.commitText();
    const ed = document.getElementById('text-editor');
    this._textPos = w;
    ed.value = '';
    ed.classList.add('active');
    ed.style.left = s.x + 'px';
    ed.style.top = s.y + 'px';
    const px = Math.max(8, this.camera.worldToScreenLen(this.style.textSize));
    ed.style.fontSize = px + 'px';
    ed.style.color = this.style.color;
    ed.style.minWidth = '120px';
    ed.style.height = (px * 1.3) + 'px';
    this._textOpenAt = performance.now();
    ed.focus();                              // focus now (deterministic for tests)
    requestAnimationFrame(() => { if (ed.classList.contains('active')) ed.focus(); });
  }
  commitText() {
    const ed = document.getElementById('text-editor');
    if (!ed.classList.contains('active')) return;
    const text = ed.value;
    ed.classList.remove('active');
    if (text.trim() && this._textPos) {
      const it = makeText(this._textPos.x, this._textPos.y, text,
        { color: this.style.color, size: this.style.textSize });
      this._assignFrame([it]);
      this.history.push(addItemsCmd(this.scene, [it]));
    }
    this._textPos = null;
  }

  // ---------------- view ops ----------------
  zoomAtCenter(factor) { this.camera.zoomBy(factor); this._updateHud(); this.requestRender(); }
  resetView() { this.camera.x = 0; this.camera.y = 0; this.camera.scale = 1; this.camera.rot = 0; this._updateHud(); this.requestRender(); }

  /**
   * Floating-origin rebasing — the heart of jitter-free EXTREME zoom. The render
   * & interaction transform is `screen = scale·(world − camera)`; when both world
   * and camera are large f64s but their true difference is sub-pixel (the case at
   * deep zoom), the subtraction loses ~log2(magnitude) bits → visible jitter, and
   * past ~2^28 the small leftover even quantises away. The fix: keep the camera
   * (and therefore the in-view geometry) near coordinate 0, where f64 has the most
   * precision, by sliding the WHOLE document plus every other world-space anchor
   * by one quantised offset whenever the camera drifts too far for the current
   * zoom. Nothing moves on screen (camera + content shift in lock-step); only the
   * stored magnitudes shrink. The slide is banked in scene.origin so true coords
   * are invariant. See tests/_precisioncheck.mjs for the proof, and DESIGN.md.
   *
   * Returns true iff a rebase happened. Skipped mid-gesture / mid-playback (those
   * capture coordinate snapshots a slide would desync).
   */
  _maybeRebase() {
    if (this.active || (this.anim && this.anim.playing)) return false;
    const cam = this.camera;
    if (!Number.isFinite(cam.x) || !Number.isFinite(cam.y) || !(cam.scale > 0)) return false;
    // |camera| beyond `bound` costs more than REBASE_BUDGET_PX of error (error ≈
    // |camera|·scale·2⁻⁵²). Act only past a hysteresis margin so we never churn.
    const REBASE_BUDGET_PX = 0.03, HYST = 8;
    const bound = (REBASE_BUDGET_PX * 4503599627370496 /* 2^52 */) / cam.scale;
    if (Math.abs(cam.x) <= bound * HYST && Math.abs(cam.y) <= bound * HYST) return false;
    // Snap the shift to a power-of-two grid sized to `bound`: N·2^k is exactly
    // representable (N integer, well under 2^53 since we rebase promptly), so the
    // subtraction adds no rounding of its own, and repeated rebases land on the
    // same lattice — no slow drift (gemma's "quantized rebasing"). At extreme zoom
    // `bound` (and so the cell) is far below 1 — that is correct and REQUIRED: a
    // cell floored at 1 would leave up to half a world-unit of camera residual,
    // which at 2^400 scale is astronomically many pixels of error.
    const cell = 2 ** Math.round(Math.log2(Math.max(bound, 1e-300)));
    const dx = Math.round(cam.x / cell) * cell;
    const dy = Math.round(cam.y / cell) * cell;
    if (!dx && !dy) return false;
    // Move EVERYTHING by (−dx,−dy): camera, document, and every other world-space
    // coordinate holder, so the picture is identical but the camera sits near 0.
    cam.x -= dx; cam.y -= dy;
    this.scene.shiftAll(-dx, -dy);                 // items (incl. droste src) + origin += (dx,dy)
    if (this.pivot) { this.pivot.x -= dx; this.pivot.y -= dy; }
    if (Array.isArray(this.bookmarks))
      for (const b of this.bookmarks) { if (Number.isFinite(b.x)) b.x -= dx; if (Number.isFinite(b.y)) b.y -= dy; }
    if (this.anim && Array.isArray(this.anim.cams))
      for (const c of this.anim.cams) { if (c) { c.x -= dx; c.y -= dy; } }
    if (this.symmetry) { this.symmetry.cx -= dx; this.symmetry.cy -= dy; }
    this._rebaseCount = (this._rebaseCount || 0) + 1;
    return true;
  }

  /** Rotate the whole view by `dRad` about a screen anchor (default centre) —
   *  turning the canvas like a sheet of paper. Grid, geometry and sprites all
   *  spin together; objects are NOT modified (that's rotateSelection). */
  rotateCanvas(dRad, sx = this.camera.width / 2, sy = this.camera.height / 2) {
    this.camera.rotateBy(dRad, sx, sy);
    this._updateHud(); this.requestRender();
  }
  /** Snap the view back to upright (0°), keeping the centre world point fixed. */
  resetRotation() {
    if (!this.camera.rot) return;
    this.camera.rotateTo(0);
    this._updateHud(); this.requestRender();
    this._toast('Canvas upright');
  }
  fitAll() {
    this.resolveConnectors(); // ensure connector bounds are current before fitting
    const b = this.scene.bounds();
    if (!b) { this.resetView(); return; }
    this.camera.fitToRect(b, 0.16);
    this._updateHud(); this.requestRender();
    this._toast('Zoomed to fit');
  }

  // ---------------- UI wiring ----------------
  _bindUI() {
    document.querySelectorAll('.tool').forEach(b =>
      b.addEventListener('click', () => this.setTool(b.dataset.tool)));

    document.getElementById('undo').onclick = () => this.undo();
    document.getElementById('redo').onclick = () => this.redo();
    document.getElementById('zoomIn').onclick = () => this.zoomAtCenter(1.25);
    document.getElementById('zoomOut').onclick = () => this.zoomAtCenter(1 / 1.25);
    document.getElementById('zoomFit').onclick = () => this.fitAll();
    document.getElementById('zoomReset').onclick = () => this.resetView();

    document.getElementById('color').oninput = e => this.setStyle({ color: e.target.value });
    document.getElementById('width').oninput = e => this.setStyle({ width: parseFloat(e.target.value) });
    document.getElementById('widthMode').onchange = e => this.setStyle({ widthMode: e.target.value });
    const clampMinEl = document.getElementById('clampMin');
    const clampMaxEl = document.getElementById('clampMax');
    if (clampMinEl) clampMinEl.oninput = e => {
      const v = Math.max(0.75, parseFloat(e.target.value) || 1.5);
      this.setStyle({ clampMin: Math.min(v, this.style.clampMax) });
    };
    if (clampMaxEl) clampMaxEl.oninput = e => {
      const v = Math.max(0.75, parseFloat(e.target.value) || 24);
      this.setStyle({ clampMax: Math.max(v, this.style.clampMin) });
    };
    this._syncWidthModeUI();
    this._syncFillUI();
    document.getElementById('sides').oninput = e => this.setStyle({ sides: parseInt(e.target.value, 10) });
    document.getElementById('opacity').oninput = e => this.setStyle({ opacity: parseFloat(e.target.value) });
    { const el = document.getElementById('blend'); if (el) el.onchange = e => this.setStyle({ blend: e.target.value }); }
    document.getElementById('starToggle').onchange = e => this.setStyle({ star: e.target.checked });
    document.getElementById('fillOn').onchange = e => { this.style.fillOn = e.target.checked; this._syncFillUI(); this._applyFillToSelection(); };
    document.getElementById('fillColor').oninput = e => { this.style.fillColor = e.target.value; if (this.style.fillOn) this._applyFillToSelection(); };
    { const el = document.getElementById('fillColor2'); if (el) el.oninput = e => { this.style.fillColor2 = e.target.value; if (this.style.fillOn && this.style.fillType !== 'flat') this._applyFillToSelection(); }; }
    { const el = document.getElementById('fillType'); if (el) el.onchange = e => { this.style.fillType = e.target.value; this._syncFillUI(); if (this.style.fillOn) this._applyFillToSelection(); }; }
    { const el = document.getElementById('fillAngle'); if (el) el.oninput = e => {
        this.style.fillAngle = parseFloat(e.target.value);
        const v = document.getElementById('fillAngleVal'); if (v) v.textContent = Math.round(this.style.fillAngle) + '°';
        if (this.style.fillOn && (this.style.fillType === 'linear' || this.style.fillType === 'conic')) this._applyFillToSelection();
      }; }
    { const d = document.getElementById('sel-deselect'); if (d) d.onclick = () => this.deselectAll(); }

    // Clear is destructive, so make it deliberate: the first click ARMS the
    // button ("Click again to clear"), a second click within 3s actually clears.
    // A non-modal confirm (§2.7) that adds zero friction once you mean it; the
    // clear itself is still undo-toasted, so it's belt-and-braces.
    const clearBtn = document.getElementById('clearBtn');
    // Capture the FULL rest markup (icon + " Clear"), so arming → text-only
    // warning → disarm restores the line-icon, not a bare word.
    const clearRestHtml = clearBtn.innerHTML;
    const disarmClear = () => {
      this._clearArmed = false;
      clearTimeout(this._clearArmT);
      clearBtn.classList.remove('armed');
      clearBtn.innerHTML = clearRestHtml;
    };
    clearBtn.onclick = () => {
      if (!this.scene.count()) { disarmClear(); this._toast('Nothing to clear'); return; }
      if (this._clearArmed) { disarmClear(); this.clearAll(); return; }
      this._clearArmed = true;
      clearBtn.classList.add('armed');
      clearBtn.textContent = 'Click again to clear';
      clearTimeout(this._clearArmT);
      this._clearArmT = setTimeout(disarmClear, 3000);
    };
    // Focus-mode chrome controls: the ⛶ HUD chip enters it, the exit chip leaves.
    const focusChip = document.getElementById('hud-focus');
    if (focusChip) focusChip.onclick = () => this.toggleFocus();
    const focusExit = document.getElementById('focus-exit');
    if (focusExit) focusExit.onclick = () => this.setFocus(false);
    // The rotation badge (shown only when turned) is a one-click "set upright".
    const rotChip = document.getElementById('hud-rot');
    if (rotChip) rotChip.onclick = () => this.resetRotation();

    document.getElementById('exportPng').onclick = () => { this.render(); storage.downloadPNG(this.canvas); this._toast('Exported PNG'); };
    document.getElementById('exportSvg').onclick = () => { this.resolveConnectors(); storage.downloadSVG(sceneToSVG(this.scene)); this._toast('Exported SVG'); };
    document.getElementById('exportJson').onclick = () => { storage.downloadJSON(this.scene); this._toast('Exported JSON'); };
    document.getElementById('importJson').onclick = () => document.getElementById('importFile').click();
    document.getElementById('importFile').onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      try { const data = await storage.readFileAsJSON(f); this.loadDoc(data); this._toast('Imported drawing'); }
      catch { this._toast('Import failed — invalid JSON'); }
      e.target.value = '';
    };

    document.getElementById('addImageBtn').onclick = () => document.getElementById('imageFile').click();
    document.getElementById('imageFile').onchange = e => {
      const f = e.target.files[0];
      if (f) this.loadImageFile(f, { x: this.camera.width / 2, y: this.camera.height / 2 });
      e.target.value = '';
    };

    document.getElementById('gridToggle').onchange = e => { this.renderer.showGrid = e.target.checked; this.requestRender(); };
    document.getElementById('gridStyle').onchange = e => { this.renderer.gridStyle = e.target.value; this.requestRender(); };
    document.getElementById('minimapToggle').onchange = e => {
      this.minimap.enabled = e.target.checked;
      document.getElementById('minimap').classList.toggle('hidden', !e.target.checked);
      this.requestRender();
    };
    const snapEl = document.getElementById('snapToggle');
    if (snapEl) { snapEl.checked = this.snap; snapEl.onchange = e => this.setSnap(e.target.checked); }
    const guidesEl = document.getElementById('guidesToggle');
    if (guidesEl) { guidesEl.checked = this.guides.on; guidesEl.onchange = e => this.setGuides(e.target.checked); }
    const comEl = document.getElementById('comPivotToggle');
    if (comEl) { comEl.checked = this.comPivot; comEl.onchange = e => this.setComPivot(e.target.checked); }
    // Recursion knobs: child-zoom (per-level scale) + levels (stamp depth). Sync
    // the inputs to the persisted values, then live-update on drag.
    const sfEl = document.getElementById('stampFactor');
    if (sfEl) { sfEl.oninput = e => this.setStampFactor(e.target.value); this.setStampFactor(Math.round(this.stampFactor * 100)); }
    const sdEl = document.getElementById('stampDepth');
    if (sdEl) { sdEl.oninput = e => this.setStampDepth(e.target.value); this.setStampDepth(this.stampDepth); }
    // VORTEX knobs: spin is always visible (the headline); hue + fade + drift tuck
    // behind a "Vortex extras" disclosure. Sync inputs to the persisted values, then
    // live-update on drag.
    const ssEl = document.getElementById('stampSpin');
    if (ssEl) { ssEl.oninput = e => this.setStampSpin(e.target.value); this.setStampSpin(this.stampSpin); }
    const shEl = document.getElementById('stampHue');
    if (shEl) { shEl.oninput = e => this.setStampHue(e.target.value); this.setStampHue(this.stampHue); }
    const sgEl = document.getElementById('stampFade');
    if (sgEl) { sgEl.oninput = e => this.setStampFade(e.target.value); this.setStampFade(this.stampFade); }
    const seEl = document.getElementById('stampDrift');
    if (seEl) { seEl.oninput = e => this.setStampDrift(e.target.value); this.setStampDrift(this.stampDrift); }
    const vtEl = document.getElementById('vortexToggle');
    const vrEl = document.getElementById('vortexRows');
    if (vtEl && vrEl) {
      // Auto-open the extras if a persisted hue/fade/drift is already non-default, so a
      // returning user sees the controls that are actually shaping their stamp.
      if (this.stampHue || this.stampFade || this.stampDrift) { vtEl.checked = true; vrEl.hidden = false; }
      vtEl.onchange = e => { vrEl.hidden = !e.target.checked; };
    }
    document.getElementById('brushSmooth').onchange = e => { this.brushSmooth = e.target.checked; };

    // symmetry / mandala controls
    // both on-switches funnel through the ONE writer (toggleSymmetry → setSymmetry);
    // the toolbar twin (#symToggleTop, below) shares the exact same path.
    document.getElementById('symOn').onclick = () => this.toggleSymmetry();
    document.getElementById('symMirror').onchange = e => this.setSymmetry({ mirror: e.target.checked });
    const symDomain = document.getElementById('symDomain');
    if (symDomain) symDomain.onchange = e => this.setSymmetry({ showDomain: e.target.checked });
    document.getElementById('symSlices').oninput = e => this.setSymmetry({ slices: +e.target.value });
    document.getElementById('symCenter').onclick = () => { this.symmetryCenterToView(); this._toast('Symmetry centred'); };
    // wallpaper / translational grid controls — enabling the grid also flips the
    // master toggle on so the lattice takes effect immediately.
    const symGrid = document.getElementById('symGrid');
    if (symGrid) symGrid.onchange = e => this.setSymmetry(e.target.checked ? { grid: { on: true }, on: true } : { grid: { on: false } });
    const symCols = document.getElementById('symCols');
    if (symCols) symCols.oninput = e => this.setSymmetry({ grid: { cols: +e.target.value } });
    const symRows = document.getElementById('symRows');
    if (symRows) symRows.oninput = e => this.setSymmetry({ grid: { rows: +e.target.value } });
    const symSpacing = document.getElementById('symSpacing');
    if (symSpacing) symSpacing.oninput = e => { const v = Math.max(1, +e.target.value || 0); this.setSymmetry({ grid: { dx: v, dy: v } }); };
    // wallpaper GROUP picker — the 17 plane symmetry groups (overrides the radial/
    // grid path). The <select> is populated once from the engine's canonical list.
    this._populateWallpaperGroups();
    const symGroup = document.getElementById('symGroup');
    if (symGroup) symGroup.onchange = e => {
      this.setWallpaperGroup(e.target.value || null);
      if (e.target.value) this._toast(this._wallpaperToastLabel(e.target.value));
    };
    const symCell = document.getElementById('symCell');
    if (symCell) symCell.oninput = e => { const v = Math.max(1, +e.target.value || 0); this.setSymmetry({ cell: v }); };
    const symReps = document.getElementById('symReps');
    if (symReps) symReps.oninput = e => this.setSymmetry({ reps: +e.target.value });
    document.getElementById('symToggleTop').onclick = () => {
      const on = this.toggleSymmetry().on;
      this._toast(on ? 'Symmetry on' : 'Symmetry off');
    };

    // flipbook / stop-motion controls
    document.getElementById('flipToggle').onclick = () => this.toggleFlipbook();
    document.getElementById('flipPrev').onclick = () => this.prevFrame();
    document.getElementById('flipNext').onclick = () => this.nextFrame();
    document.getElementById('flipScrub').oninput = e => this.setFrame(parseInt(e.target.value, 10));
    document.getElementById('flipAdd').onclick = () => this.addFrame();
    document.getElementById('flipDup').onclick = () => this.duplicateFrame();
    document.getElementById('flipDel').onclick = () => this.deleteFrame();
    document.getElementById('flipPlay').onclick = () => this.togglePlay();
    // Pin / re-aim the page's camera; ⇧-click clears it (cinematic zoom path).
    document.getElementById('flipCam').onclick = e => { if (e.shiftKey) this.clearPageCamera(); else this.setPageCamera(); };
    document.getElementById('flipFps').onchange = e => this.setFps(parseInt(e.target.value, 10));
    document.getElementById('flipHold').onchange = e => this.setFrameHold(this.anim.current, parseInt(e.target.value, 10));
    document.getElementById('flipOnion').oninput = e => this.setOnion(parseInt(e.target.value, 10));
    document.getElementById('flipTint').onchange = e => this.setTint(e.target.checked);
    document.getElementById('flipLoop').onchange = e => this.setLoop(e.target.checked);
    document.getElementById('flipDither').onchange = e => this.setDither(e.target.checked);
    { const hq = document.getElementById('flipHQ'); if (hq) hq.onchange = e => this.setHQ(e.target.checked); }
    document.getElementById('flipEase').onchange = e => this.setEase(e.target.value);
    document.getElementById('flipPath').onchange = e => this.setShowPath(e.target.checked);
    document.getElementById('flipGif').onclick = () => this.downloadGIF();
    document.getElementById('flipSheet').onclick = () => this.downloadSpriteSheet();

    document.querySelectorAll('.gen-row button').forEach(b =>
      b.addEventListener('click', () => this.generate(b.dataset.gen, {}, { clear: false, fit: true })));

    // The 11 uniform (regular + Archimedean) tilings share one grouped <select>:
    // the kind flows in as a generator option rather than a button per tiling.
    const uniformGo = document.getElementById('uniformGo');
    if (uniformGo) uniformGo.addEventListener('click', () => {
      const kind = document.getElementById('uniformKind').value;
      const dual = document.getElementById('uniformDual');
      this.generate(dual && dual.checked ? 'laves' : 'uniform', { kind }, { clear: false, fit: true });
    });

    // The fractal CURVES (Hilbert / Dragon / Lévy / Koch / Gosper) share one <select>,
    // the same shape as the uniform tilings — plus an ORDER slider whose cap adapts to
    // the chosen curve (so it can't ask for billions of points) and which snaps to that
    // curve's sweet-spot default when you switch curves. The kind + order both flow in
    // as generator options; the per-kind caps live ONCE in generators.js (curveOrderMeta).
    const curveKind = document.getElementById('curveKind');
    const curveOrder = document.getElementById('curveOrder');
    const curveOrderVal = document.getElementById('curveOrderVal');
    const meta = curveOrderMeta();
    // Reflect the slider into its readout; optionally re-range + reset to the kind default.
    const syncCurveOrder = (resetToDefault) => {
      if (!curveOrder) return;
      const m = meta[curveKind ? curveKind.value : 'hilbert'] || meta.hilbert;
      curveOrder.min = m.minOrder;
      curveOrder.max = m.maxOrder;
      if (resetToDefault) curveOrder.value = m.defOrder;
      else curveOrder.value = Math.max(m.minOrder, Math.min(m.maxOrder, +curveOrder.value));
      if (curveOrderVal) curveOrderVal.textContent = curveOrder.value;
    };
    if (curveKind) curveKind.addEventListener('change', () => syncCurveOrder(true));
    if (curveOrder) curveOrder.addEventListener('input', () => syncCurveOrder(false));
    syncCurveOrder(true);   // initialise to the default kind's sweet spot on load
    const curveGo = document.getElementById('curveGo');
    if (curveGo) curveGo.addEventListener('click', () => {
      const kind = curveKind.value;
      const order = curveOrder ? +curveOrder.value : undefined;
      this.generate('curve', { kind, order }, { clear: false, fit: true });
    });

    document.getElementById('toBack').onclick = () => this.sendToBack();
    document.getElementById('toFront').onclick = () => this.bringToFront();
    document.getElementById('raise').onclick = () => this.raiseSelection();
    document.getElementById('lower').onclick = () => this.lowerSelection();
    document.getElementById('rotL').onclick = () => this.rotateSelection(-Math.PI / 12);
    document.getElementById('rotR').onclick = () => this.rotateSelection(Math.PI / 12);
    document.getElementById('scaleDown').onclick = () => this.scaleSelection(1 / 1.1);
    document.getElementById('scaleUp').onclick = () => this.scaleSelection(1.1);
    document.getElementById('groupBtn').onclick = () => this.groupSelection();
    document.getElementById('ungroupBtn').onclick = () => this.ungroupSelection();
    document.getElementById('parentBtn').onclick = () => this.parentSelection();
    document.getElementById('unparentBtn').onclick = () => this.unparentSelection();
    document.getElementById('lockBtn').onclick = () => this.toggleLockSelection();
    document.getElementById('hideBtn').onclick = () => this.toggleHideSelection();
    document.getElementById('showAllBtn').onclick = () => this.showAll();
    document.getElementById('unlockAllBtn').onclick = () => this.unlockAll();
    { const b = document.getElementById('addLayerBtn'); if (b) b.onclick = () => this.addLayer(); }
    document.getElementById('layerCollapse').onclick = () => this.toggleLayersPanel();
    document.getElementById('lodFar').onclick = () => this.setSelectionLOD('far');
    document.getElementById('lodAll').onclick = () => this.setSelectionLOD('all');
    document.getElementById('lodNear').onclick = () => this.setSelectionLOD('near');
    document.getElementById('alignLeft').onclick = () => this.alignSelection('left');
    document.getElementById('alignHCenter').onclick = () => this.alignSelection('hcenter');
    document.getElementById('alignRight').onclick = () => this.alignSelection('right');
    document.getElementById('alignTop').onclick = () => this.alignSelection('top');
    document.getElementById('alignVCenter').onclick = () => this.alignSelection('vcenter');
    document.getElementById('alignBottom').onclick = () => this.alignSelection('bottom');
    document.getElementById('distributeH').onclick = () => this.distributeSelection('h');
    document.getElementById('distributeV').onclick = () => this.distributeSelection('v');
    document.getElementById('stampBtn').onclick = () => this.recursiveStamp({ factor: this.stampFactor, depth: this.stampDepth, spin: this.stampSpin, hue: this.stampHue, fade: this.stampFade / 100, drift: this.stampDrift / 100 });
    { const pb = document.getElementById('portalBtn'); if (pb) pb.onclick = () => this.createDroste({ factor: this.stampFactor, rot: this.stampSpin * Math.PI / 180, hue: this.stampHue }); }
    { const lb = document.getElementById('drosteLoopBtn'); if (lb) lb.onclick = () => this.downloadDrosteLoop(); }
    document.getElementById('addBookmark').onclick = () => this.addBookmark();
    // persist the Bookmarks section's open/closed state across reloads — covers both
    // the API (toggleBookmarkPanel) and a manual click on the section caret.
    const bmSect = document.getElementById('bookmark-sect');
    if (bmSect) bmSect.addEventListener('toggle', () => {
      try { localStorage.setItem('infinizoom.bookmarksCollapsed', bmSect.open ? '0' : '1'); } catch { /* ignore */ }
    });

    const ed = document.getElementById('text-editor');
    ed.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); ed.value = ''; ed.classList.remove('active'); this._textPos = null; }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.commitText(); }
      e.stopPropagation();
    });
    ed.addEventListener('blur', () => {
      // Ignore the spurious blur that can fire right as the editor opens
      // (e.g. focus contention with the canvas). Re-grab focus instead of
      // committing an empty box out of existence.
      if (ed.classList.contains('active') && performance.now() - (this._textOpenAt || 0) < 250) {
        requestAnimationFrame(() => { if (ed.classList.contains('active')) ed.focus(); });
        return;
      }
      this.commitText();
    });
    ed.addEventListener('input', () => {
      ed.style.width = 'auto';
      ed.style.width = Math.max(120, ed.scrollWidth + 4) + 'px';
      ed.style.height = 'auto';
      ed.style.height = ed.scrollHeight + 'px';
    });

    this._enhanceSteppers();
  }

  /* ── One number language: tactile steppers (CRITIQUE §2.5) ───────────────
     Wrap every [data-stepper] number input in a −/+ frame so a value is bumped
     by touch instead of typed — the field's native spinner arrows are a ~2px
     target, unhittable on a finger. The <input> is preserved verbatim (id, min/
     max/step, editability) and the buttons just fire input&change on it, so the
     existing handlers + the whole test API keep working unchanged. The input's
     own arrow keys stay the keyboard path, so the buttons sit OUT of the tab
     order (aria-hidden) — a pure pointer/touch convenience, like a real spinner. */
  _enhanceSteppers() {
    document.querySelectorAll('input[type="number"][data-stepper]').forEach((input) => {
      if (input.closest('.stepper')) return; // idempotent
      const wrap = document.createElement('span');
      wrap.className = 'stepper';
      input.parentNode.insertBefore(wrap, input);
      const mk = (cls, sym, verb) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'step-btn ' + cls;
        b.tabIndex = -1;
        b.setAttribute('aria-hidden', 'true');
        b.dataset.stepFor = input.id;
        b.title = verb + ' ' + (input.getAttribute('aria-label') || input.id);
        b.textContent = sym;
        return b;
      };
      const dn = mk('step-dn', '−', 'Decrease'); // U+2212 minus sign
      const up = mk('step-up', '+', 'Increase');
      wrap.appendChild(dn);
      wrap.appendChild(input);
      wrap.appendChild(up);
      this._bindStepHold(dn, input, -1);
      this._bindStepHold(up, input, +1);
      const sync = () => this._syncStepperBounds(wrap, input);
      input.addEventListener('input', sync);
      input.addEventListener('change', sync);
      // some fields are gated disabled by another control (e.g. pxColors by the
      // "palette from image" checkbox) — mirror that onto the buttons
      new MutationObserver(sync).observe(input, { attributes: true, attributeFilter: ['disabled'] });
      sync();
    });
  }

  /** Bump `input` by one step in `dir` (±1), clamped to [min,max]; fires
   *  input&change so the field's existing handler runs. No-op (and no event) at
   *  a bound or when disabled. */
  _stepField(input, dir) {
    if (input.disabled) return;
    const step = Math.abs(parseFloat(input.step)) || 1;
    const min = input.min !== '' ? parseFloat(input.min) : -Infinity;
    const max = input.max !== '' ? parseFloat(input.max) : Infinity;
    let v = parseFloat(input.value);
    if (!isFinite(v)) v = isFinite(min) ? min : 0;
    const dec = (String(step).split('.')[1] || '').length;
    let next = Math.min(max, Math.max(min, v + dir * step));
    next = parseFloat(next.toFixed(dec)); // kill binary-float fuzz (e.g. 0.1+0.2)
    if (next === v) return; // already at the bound — don't churn an event
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Disable the −/+ buttons at the value's bounds (and when the input is
   *  disabled), so the frame honestly shows when a direction is dead. */
  _syncStepperBounds(wrap, input) {
    const min = input.min !== '' ? parseFloat(input.min) : -Infinity;
    const max = input.max !== '' ? parseFloat(input.max) : Infinity;
    const v = parseFloat(input.value);
    const dis = input.disabled;
    const dn = wrap.querySelector('.step-dn');
    const up = wrap.querySelector('.step-up');
    if (dn) dn.disabled = dis || (isFinite(v) && v <= min);
    if (up) up.disabled = dis || (isFinite(v) && v >= max);
    wrap.classList.toggle('is-disabled', dis);
  }

  /** Tap = one step; press-and-hold = repeat (380ms delay, then 70ms cadence)
   *  — a real spinner's feel without making the user mash the button. Pointer-
   *  down drives the press (immediate step + repeat); a `click` with no preceding
   *  pointer (synthetic / assistive-tech activation) also steps once, but a real
   *  press swallows its trailing click so a tap never double-steps. */
  _bindStepHold(btn, input, dir) {
    let delay = null, repeat = null, viaPointer = false;
    const stop = () => { clearTimeout(delay); clearInterval(repeat); delay = repeat = null; };
    btn.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button > 0) return; // primary button / touch only
      e.preventDefault(); // keep focus where it is; don't start a text selection
      viaPointer = true;
      this._stepField(input, dir);
      delay = setTimeout(() => { repeat = setInterval(() => this._stepField(input, dir), 70); }, 380);
    });
    btn.addEventListener('click', () => {
      if (viaPointer) { viaPointer = false; return; } // real press already stepped
      this._stepField(input, dir);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
  }

  _applyFillToSelection() {
    const fill = this._styleFill();
    if (this.selectedIds.size) {
      for (const id of this.selectedIds) {
        const it = this.scene.byId(id);
        if (it && (it.type === 'rect' || it.type === 'ellipse' || it.type === 'polygon')) {
          it.fill = cloneFill(fill);   // fresh copy per item — never share a gradient
        }
      }
      this.scene._touch();
    }
    this.requestRender();
  }

  _buildSwatches() {
    const wrap = document.getElementById('swatches');
    wrap.innerHTML = '';
    for (const c of PALETTE) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = c;
      b.dataset.color = c;
      b.title = c;
      b.onclick = () => this.setStyle({ color: c });
      wrap.appendChild(b);
    }
    this._highlightSwatch();
  }
  _highlightSwatch() {
    document.querySelectorAll('.swatch').forEach(b =>
      b.classList.toggle('active', b.dataset.color === this.style.color));
  }

  // ---------------- keyboard ----------------
  _bindKeys() {
    window.addEventListener('keydown', e => {
      if (document.getElementById('text-editor').classList.contains('active')) return;
      const meta = e.metaKey || e.ctrlKey;

      // ---- Command palette (Transparency): ⌘/Ctrl+K toggles from anywhere; '/'
      //      opens it when you're not typing in a field. While it's open, its own
      //      input owns the keyboard, so swallow everything else here. ----
      if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); this.togglePalette(); return; }
      if (this._paletteOpen) return;
      if (e.key === '/' && !this._typingInField()) { e.preventDefault(); this.openPalette(); return; }

      // ---- Focus mode (recess) ----
      // Tab toggles it — the convention — but ONLY while "on the canvas" (focus on
      // body/canvas, not on a chrome button or field), so native keyboard
      // navigation of the panels and dialogs is never hijacked (a11y).
      if (e.key === 'Tab' && !this._typingInField() &&
          (document.activeElement === document.body || document.activeElement === this.canvas || !document.activeElement)) {
        e.preventDefault(); this.toggleFocus(); return;
      }
      // Esc leaves focus mode first (before it falls through to clearing a selection).
      if (e.key === 'Escape' && this.focusMode) { e.preventDefault(); this.setFocus(false); return; }

      if (e.code === 'Space' && !this.spaceDown) { this.spaceDown = true; this.canvas.style.cursor = 'grab'; }

      if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
      if (meta && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }

      // While pixel-editing, Ctrl/⌘ + A/C/X/V act on the rectangular SELECTION
      // (the sprite's own pixels) rather than the vector scene — intercept BEFORE
      // the vector select-all / copy / cut / paste below. Undo/redo above is shared.
      if (this.pixel.editing && meta && !e.shiftKey) {
        const k = e.key.toLowerCase();
        if (k === 'a') { e.preventDefault(); this.selectAllPixels(); return; }
        if (k === 'i') { e.preventDefault(); this.invertPixelSelection(); this._toast(this.pixel.sel ? 'Inverted selection' : 'Nothing left'); return; }
        if (k === 'c') { e.preventDefault(); this._toast(this.copyPixelSelection() ? 'Copied selection' : 'No selection'); return; }
        if (k === 'x') { e.preventDefault(); this._toast(this.cutPixelSelection() ? 'Cut selection' : 'No selection'); return; }
        if (k === 'v') { e.preventDefault(); this._toast(this.pastePixelSelection() ? 'Pasted' : 'Clipboard empty'); return; }
      }

      if (meta && e.key.toLowerCase() === 'a') { e.preventDefault(); this.selectAll(); return; }
      if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); storage.downloadJSON(this.scene); this._toast('Saved JSON'); return; }
      if (meta && e.key.toLowerCase() === 'd') { e.preventDefault(); this.duplicateSelection(); return; }
      if (meta && e.key.toLowerCase() === 'c') { e.preventDefault(); this.copySelection(); return; }
      if (meta && e.key.toLowerCase() === 'x') { e.preventDefault(); this.cutSelection(); return; }
      if (meta && e.key.toLowerCase() === 'v') { e.preventDefault(); this.paste(); return; }
      if (meta && e.key.toLowerCase() === 'g') { e.preventDefault(); e.shiftKey ? this.ungroupSelection() : this.groupSelection(); return; }
      // Parenting (Blender-style): Ctrl/⌘+P parents the selection to the active
      // item; Alt+P clears the parent. Using e.code so the modifiers don't change
      // which physical key we match. (preventDefault on Ctrl+P also blocks print.)
      if (meta && !e.shiftKey && e.code === 'KeyP') { e.preventDefault(); this.parentSelection(); return; }
      if (e.altKey && !meta && e.code === 'KeyP') { e.preventDefault(); this.unparentSelection(); return; }

      // In pixel-edit mode, the letter keys pick raster tools (not vector tools),
      // arrows nudge the selection, and Esc clears the marquee then finishes
      // editing. Undo/redo (handled above) still work.
      if (this.pixel.editing && !meta) {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (this.pixel.sel) { this.deselectPixels(); this._toast('Selection cleared'); }
          else { this.endPixelEdit(); this._toast('Pixel edit done'); }
          return;
        }
        // Arrow keys move the selected block a cell at a time (×5 with Shift).
        if (this.pixel.sel && e.key.startsWith('Arrow')) {
          e.preventDefault();
          const st = e.shiftKey ? 5 : 1;
          let dx = 0, dy = 0;
          if (e.key === 'ArrowLeft') dx = -st; else if (e.key === 'ArrowRight') dx = st;
          else if (e.key === 'ArrowUp') dy = -st; else if (e.key === 'ArrowDown') dy = st;
          this.movePixelSelection(dx, dy);
          return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          // with a marquee, clear its cells; otherwise don't delete the sprite
          if (this.pixel.sel) { e.preventDefault(); if (this.clearPixelSelection()) this._toast('Cleared selection'); }
          return;
        }
        if (!e.altKey) {
          const map = { b: 'pencil', p: 'pencil', n: 'pencil', e: 'eraser', g: 'fill',
                        l: 'line', r: 'rect', o: 'ellipse', c: 'ellipse', i: 'eyedropper',
                        m: 'select', w: 'wand' };
          const pt = map[e.key.toLowerCase()];
          if (pt) { e.preventDefault(); this.setPixelTool(pt); return; }
        }
      }

      if (e.key === 'Delete' || e.key === 'Backspace') { if (this.selectedIds.size) { e.preventDefault(); this.deleteSelection(); } return; }
      if (e.key === 'Escape') { this.selectedIds.clear(); this._activeId = null; this.draft = null; this.active = null; this._spinPivot = null; this._refGuide = null; this.requestRender(); return; }

      // Shift+L / Shift+H lock / hide the selection (must run before the
      // lowercase tool switch, where 'l' = line and 'h' = pan).
      if (e.shiftKey && !meta && e.key.toLowerCase() === 'l') { e.preventDefault(); this.toggleLockSelection(); return; }
      if (e.shiftKey && !meta && e.key.toLowerCase() === 'h') { e.preventDefault(); this.toggleHideSelection(); return; }
      // Shift+P drops (or clears) a custom transform pivot at the selection centre
      // (before the lowercase switch, where 'p' = pen).
      if (e.shiftKey && !meta && e.key.toLowerCase() === 'p') { e.preventDefault(); this.togglePivot(); return; }

      // In flipbook mode with nothing selected, ←/→ flip between pages. (When
      // something is selected, the arrows nudge it — handled just below.)
      if (this.anim.on && !this.selectedIds.size && !meta &&
          (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        e.key === 'ArrowLeft' ? this.prevFrame() : this.nextFrame();
        return;
      }

      // Arrow keys nudge the selection — 1px on screen, ×10 with Shift. Using
      // screen px keeps the felt step constant at any zoom.
      if (e.key.startsWith('Arrow') && this.selectedIds.size && !meta) {
        e.preventDefault();
        const step = this.camera.screenToWorldLen(e.shiftKey ? 10 : 1);
        let dx = 0, dy = 0;
        if (e.key === 'ArrowLeft') dx = -step;
        else if (e.key === 'ArrowRight') dx = step;
        else if (e.key === 'ArrowUp') dy = -step;
        else if (e.key === 'ArrowDown') dy = step;
        this.nudgeSelection(dx, dy);
        return;
      }

      // z-order: ] front / [ back, with Ctrl for one-step raise/lower
      if (e.key === ']') { e.preventDefault(); meta ? this.raiseSelection() : this.bringToFront(); return; }
      if (e.key === '[') { e.preventDefault(); meta ? this.lowerSelection() : this.sendToBack(); return; }

      switch (e.key.toLowerCase()) {
        case 'p': this.setTool('pen'); break;
        case 'b': this.setTool('brush'); break;
        case 'l': this.setTool('line'); break;
        case 'a': this.setTool('arrow'); break;
        case 'r': this.setTool('rect'); break;
        case 'o': this.setTool('ellipse'); break;
        case 's': this.setTool('star'); break;
        case 't': this.setTool('text'); break;
        case 'v': this.setTool('select'); break;
        case 'c': this.setTool('connector'); break;
        case 'e': this.setTool('eraser'); break;
        case 'h': this.setTool('pan'); break;
        case 'j': this.setTool('fold'); break;
        case 'k': this.setTool('spin'); break;
        case 'n': this.setTool('glide'); break;
        case 'f': this.fitAll(); break;
        case '0': this.resetView(); break;
        case '+': case '=': this.zoomAtCenter(1.25); break;
        case '-': case '_': this.zoomAtCenter(1 / 1.25); break;
        case 'g': { const t = document.getElementById('gridToggle'); t.checked = !t.checked; t.onchange({ target: t }); break; }
        case 'm': { const on = this.toggleSymmetry().on; this._toast(on ? 'Mandala mode on' : 'Mandala mode off'); break; }
        // ',' / '.' rotate the SELECTION when something is selected, else rotate
        // the whole CANVAS — the same "context by selection" idiom the arrow keys
        // use (nudge selection vs flip flipbook pages). 15° steps land cleanly on 0.
        case ',': e.preventDefault(); this.selectedIds.size ? this.rotateSelection(-Math.PI / 12) : this.rotateCanvas(-Math.PI / 12); break;
        case '.': e.preventDefault(); this.selectedIds.size ? this.rotateSelection(Math.PI / 12) : this.rotateCanvas(Math.PI / 12); break;
        case '<': if (this.selectedIds.size) { e.preventDefault(); this.scaleSelection(1 / 1.1); } break;
        case '>': if (this.selectedIds.size) { e.preventDefault(); this.scaleSelection(1.1); } break;
      }
    });
    window.addEventListener('keyup', e => {
      if (e.code === 'Space') { this.spaceDown = false; this.canvas.style.cursor = ''; }
    });
  }

  // ---------------- clipboard ----------------
  copySelection() {
    if (!this.selectedIds.size) return 0;
    this.clipboard = [...this.selectedIds]
      .map(id => this.scene.byId(id))
      .filter(Boolean)
      .map(it => { const c = JSON.parse(JSON.stringify(it)); c._src = c.id; delete c.id; return c; });
    this._toast(`Copied ${this.clipboard.length}`);
    return this.clipboard.length;
  }
  cutSelection() {
    const n = this.copySelection();
    if (n) this.deleteSelection();
    return n;
  }
  paste() {
    if (!this.clipboard || !this.clipboard.length) return 0;
    const idMap = new Map();
    const clones = this.clipboard.map(c => {
      const n = JSON.parse(JSON.stringify(c));
      const src = n._src; delete n._src;
      n.id = `pst_${(this._pasteSeq = (this._pasteSeq || 0) + 1).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      if (src) idMap.set(src, n.id);
      return n;
    });
    this._relinkConnectors(clones, idMap);
    this._relinkRefs(clones, idMap);
    this._relinkParents(clones, idMap);
    this._remapGroups(clones);
    let b = itemBBox(clones[0]); b = { ...b };
    for (const c of clones) { const ib = itemBBox(c); b.minX = Math.min(b.minX, ib.minX); b.minY = Math.min(b.minY, ib.minY); b.maxX = Math.max(b.maxX, ib.maxX); b.maxY = Math.max(b.maxY, ib.maxY); }
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    // land the paste centred on the current view
    const dx = this.camera.x - cx, dy = this.camera.y - cy;
    for (const c of clones) translateItem(c, dx, dy);
    this._assignFrame(clones);
    this.history.push(addItemsCmd(this.scene, clones));
    this.selectedIds = new Set(clones.map(c => c.id));
    this._updateHud();
    this._toast(`Pasted ${clones.length}`);
    return clones.length;
  }

  duplicateSelection() {
    if (!this.selectedIds.size) return;
    const off = this.camera.screenToWorldLen(16);
    const idMap = new Map();
    const clones = [...this.selectedIds].map(id => {
      const it = this.scene.byId(id);
      if (!it) return null;
      const c = JSON.parse(JSON.stringify(it));
      c.id = 'dup_' + Math.random().toString(36).slice(2, 9);
      idMap.set(id, c.id);
      translateItem(c, off, off);
      return c;
    }).filter(Boolean);
    this._relinkConnectors(clones, idMap);
    this._relinkRefs(clones, idMap);
    this._relinkParents(clones, idMap);
    this._remapGroups(clones);
    this._assignFrame(clones);
    this.history.push(addItemsCmd(this.scene, clones));
    this.selectedIds = new Set(clones.map(c => c.id));
    this._updateHud();
  }

  // ---------------- images ----------------
  /** Accept image files dropped onto the canvas, or pasted from the OS clipboard. */
  _bindImageDrop() {
    const c = this.canvas;
    c.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    c.addEventListener('drop', e => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files || [])].filter(f => /^image\//.test(f.type));
      if (!files.length) return;
      const s = this.evtScreen(e);
      files.forEach((f, i) => this.loadImageFile(f, { x: s.x + i * 14, y: s.y + i * 14 }));
    });
    // OS-clipboard image paste (separate from the in-app Ctrl+V clipboard)
    window.addEventListener('paste', e => {
      const items = [...(e.clipboardData?.items || [])];
      const imgItem = items.find(it => /^image\//.test(it.type));
      if (!imgItem) return;
      const file = imgItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      this.loadImageFile(file, { x: this.camera.width / 2, y: this.camera.height / 2 });
    });
  }

  /** World-space size for an image with the given natural pixel dimensions,
   *  scaled so it lands at a comfortable on-screen size (native px, capped). */
  _imageWorldSize(natW, natH) {
    natW = Math.max(1, natW || 1); natH = Math.max(1, natH || 1);
    const cap = Math.min(this.camera.width, this.camera.height) * 0.7;
    const longest = Math.max(natW, natH);
    const screenLongest = Math.min(longest, cap);
    const k = screenLongest / longest;                 // shrink-to-fit factor
    const screenW = natW * k, screenH = natH * k;
    return { w: this.camera.screenToWorldLen(screenW), h: this.camera.screenToWorldLen(screenH) };
  }

  /** Read an image File, decode its natural size, and drop it centred on a screen point. */
  loadImageFile(file, screenPoint) {
    const reader = new FileReader();
    reader.onload = () => this.placeImageDataURL(reader.result, screenPoint);
    reader.onerror = () => this._toast('Could not read image');
    reader.readAsDataURL(file);
  }

  /** Place an image from a data URL, centred on a screen point, at native-ish size. */
  placeImageDataURL(src, screenPoint = { x: this.camera.width / 2, y: this.camera.height / 2 }) {
    const probe = new Image();
    probe.onload = () => {
      const { w, h } = this._imageWorldSize(probe.naturalWidth, probe.naturalHeight);
      const c = this.toWorld(screenPoint.x, screenPoint.y);
      this.addImageItem(c.x - w / 2, c.y - h / 2, w, h, src, { select: true });
      this._toast(`Placed ${probe.naturalWidth}×${probe.naturalHeight} image`);
    };
    probe.onerror = () => this._toast('Invalid image data');
    probe.src = src;
  }

  /** Add an image item (world coords/size) through history. Returns the item id. */
  addImageItem(x, y, w, h, src, { select = false } = {}) {
    const it = makeImage(x, y, w, h, src, { opacity: this.style.opacity });
    if (src) this.renderer._image(src);   // begin decoding immediately
    this._assignFrame([it]);
    this.history.push(addItemsCmd(this.scene, [it]));
    if (select) { this.selectedIds = new Set([it.id]); if (this.tool !== 'select') this.setTool('select'); }
    this._updateHud();
    return it.id;
  }

  /** Count image items whose bitmap hasn't decoded yet (test/UX hook). */
  imagesPending() { return this.renderer.pendingImages(this.scene); }

  // ---------------- z-order ----------------
  _reorderSelection(mode) {
    if (!this.selectedIds.size) return;
    const before = this.scene.items.map(i => i.id);
    const sel = this.selectedIds;
    const selIds = before.filter(id => sel.has(id));
    const rest = before.filter(id => !sel.has(id));
    let after;
    if (mode === 'front') after = [...rest, ...selIds];
    else if (mode === 'back') after = [...selIds, ...rest];
    else if (mode === 'up') after = shiftOrder(before, sel, +1);
    else if (mode === 'down') after = shiftOrder(before, sel, -1);
    else return;
    if (after.join() === before.join()) return;
    this.history.push(reorderCmd(this.scene, before, after));
    this.requestRender();
  }
  bringToFront() { this._reorderSelection('front'); }
  sendToBack() { this._reorderSelection('back'); }
  raiseSelection() { this._reorderSelection('up'); }
  lowerSelection() { this._reorderSelection('down'); }

  // ---------------- lock / hide (layer flags) ----------------
  /** Set a boolean flag ('locked'|'hidden') on a set of items, reversibly.
   *  The flag is deleted (not set false) when off so JSON stays tidy. */
  _setFlag(ids, flag, on) {
    ids = (ids instanceof Set ? [...ids] : Array.isArray(ids) ? ids.slice() : [ids])
            .filter(id => this.scene.byId(id));
    if (!ids.length) return;
    const scene = this.scene;
    const before = ids.map(id => ({ id, v: !!scene.byId(id)[flag] }));
    const set = (id, v) => { const it = scene.byId(id); if (it) { if (v) it[flag] = true; else delete it[flag]; } };
    this.history.push({
      label: `${on ? '' : 'un'}${flag} ${ids.length}`,
      do() { for (const id of ids) set(id, on); scene._touch(); },
      undo() { for (const { id, v } of before) set(id, v); scene._touch(); },
    });
  }

  setLocked(ids, on) {
    const list = ids instanceof Set ? [...ids] : Array.isArray(ids) ? ids : [ids];
    this._setFlag(list, 'locked', on);
    if (on) for (const id of list) this.selectedIds.delete(id); // a locked item can't stay selected
    this._updateHud(); this.requestRender();
  }
  setHidden(ids, on) {
    const list = ids instanceof Set ? [...ids] : Array.isArray(ids) ? ids : [ids];
    this._setFlag(list, 'hidden', on);
    if (on) for (const id of list) this.selectedIds.delete(id);
    this._updateHud(); this.requestRender();
  }

  toggleLockSelection() {
    const ids = [...this.selectedIds];
    if (!ids.length) { this._toast('Select something to lock'); return; }
    const anyUnlocked = ids.some(id => !this.scene.byId(id)?.locked);
    this.setLocked(ids, anyUnlocked);
    this._toast(anyUnlocked ? `🔒 Locked ${ids.length}` : `🔓 Unlocked ${ids.length}`);
  }
  toggleHideSelection() {
    const ids = [...this.selectedIds];
    if (!ids.length) { this._toast('Select something to hide'); return; }
    const anyVisible = ids.some(id => !this.scene.byId(id)?.hidden);
    this.setHidden(ids, anyVisible);
    this._toast(anyVisible ? `Hid ${ids.length}` : `Showed ${ids.length}`);
  }
  /** Recovery hatches — work on the WHOLE document, so items beyond the panel's
   *  display cap are always reachable. */
  showAll() {
    const ids = this.scene.items.filter(i => i.hidden).map(i => i.id);
    if (!ids.length) { this._toast('Nothing hidden'); return 0; }
    this.setHidden(ids, false); this._toast(`Showed ${ids.length}`); return ids.length;
  }
  unlockAll() {
    const ids = this.scene.items.filter(i => i.locked).map(i => i.id);
    if (!ids.length) { this._toast('Nothing locked'); return 0; }
    this.setLocked(ids, false); this._toast(`Unlocked ${ids.length}`); return ids.length;
  }
  lockedCount() { return this.scene.items.reduce((n, i) => n + (i.locked ? 1 : 0), 0); }
  hiddenCount() { return this.scene.items.reduce((n, i) => n + (i.hidden ? 1 : 0), 0); }

  // ---------------- named layers ----------------
  /** Capture enough state to reverse ANY structural layer op (add/remove/move/
   *  assign): the layer list, the active layer, every item's layerId, and the
   *  full z-order. Restoring all four reproduces the exact prior document. O(N),
   *  but structural layer ops are user-initiated and rare. */
  _layerSnapshot() {
    return {
      layers: this.scene.layers.map(L => ({ ...L })),
      activeLayerId: this.scene.activeLayerId,
      order: this.scene.items.map(i => i.id),
      itemLayerIds: new Map(this.scene.items.map(i => [i.id, i.layerId])),
    };
  }
  _restoreLayerSnapshot(snap) {
    const scene = this.scene;
    scene.layers = snap.layers.map(L => ({ ...L }));
    scene.activeLayerId = snap.activeLayerId;
    for (const it of scene.items) {
      const lid = snap.itemLayerIds.get(it.id);
      if (lid == null) delete it.layerId; else it.layerId = lid;
    }
    scene._layerCache = null; scene._layersRev++;
    scene._applyOrder(snap.order);    // restores exact z-order (+ _touch)
  }
  /** Run a structural layer mutation as one reversible step (snapshot → mutate →
   *  record before/after). pushApplied keeps the live mutation as the current
   *  state; redo re-applies the after-snapshot. */
  _layerStructureOp(label, mutate) {
    const before = this._layerSnapshot();
    mutate();
    const after = this._layerSnapshot();
    const self = this;
    this.history.pushApplied({
      label,
      do() { self._restoreLayerSnapshot(after); },
      undo() { self._restoreLayerSnapshot(before); },
    });
    this.requestRender(); this._renderLayers(); this._updateHud();
  }
  /** Reversibly set a single layer property (name/hidden/locked/opacity/blend).
   *  Light command (no item/order snapshot) — safe for sliders & toggles. */
  _commitLayerProp(id, prop, from, to) {
    if (from === to) { this.requestRender(); this._renderLayers(); return; }
    const scene = this.scene;
    this.history.push({
      label: `layer ${prop}`,
      do() { scene.setLayerProps(id, { [prop]: to }); },
      undo() { scene.setLayerProps(id, { [prop]: from }); },
    });
    this.requestRender(); this._renderLayers();
  }

  /** Add a new (empty) layer above the active one; it becomes active. */
  addLayer(name) {
    let id = null;
    this._layerStructureOp('add layer', () => { id = this.scene.addLayer(name).id; });
    this._toast('Layer added'); return id;
  }
  /** Remove a layer (never the last); its items fall to the layer below. */
  removeLayer(id) {
    if (this.scene.layers.length <= 1) { this._toast('Keep at least one layer'); return false; }
    if (!this.scene.layerById(id)) return false;
    this._layerStructureOp('remove layer', () => this.scene.removeLayer(id));
    this._toast('Layer removed'); return true;
  }
  /** Move a layer one step down (-1) or up (+1) the stack. */
  moveLayer(id, dir) {
    if (!this.scene.layerById(id)) return false;
    let ok = false;
    this._layerStructureOp('move layer', () => { ok = this.scene.moveLayer(id, dir); });
    return ok;
  }
  /** The layer new strokes go into. Pure editor state (not undoable). */
  setActiveLayer(id) {
    if (!this.scene.layerById(id) || this.scene.activeLayerId === id) { this._renderLayers(); return; }
    this.scene.activeLayerId = id;
    this._renderLayers();
    const L = this.scene.layerById(id);
    if (L) this._toast(`Drawing on “${L.name}”`);
  }
  /** Move the current selection into `layerId` as one reversible step. */
  assignSelectionToLayer(layerId) {
    const ids = [...this.selectedIds];
    if (!ids.length) { this._toast('Select items to move first'); return; }
    if (!this.scene.layerById(layerId)) return;
    this._layerStructureOp('assign layer', () => this.scene.assignToLayer(ids, layerId));
    const L = this.scene.layerById(layerId);
    this._toast(`Moved ${ids.length} to “${L ? L.name : 'layer'}”`);
  }
  setLayerHidden(id, on) { const L = this.scene.layerById(id); if (L) this._commitLayerProp(id, 'hidden', !!L.hidden, !!on); }
  setLayerLocked(id, on) { const L = this.scene.layerById(id); if (L) this._commitLayerProp(id, 'locked', !!L.locked, !!on); }
  setLayerOpacity(id, v) { const L = this.scene.layerById(id); if (L) this._commitLayerProp(id, 'opacity', L.opacity == null ? 1 : L.opacity, clamp(+v, 0, 1)); }
  setLayerBlend(id, v) { const L = this.scene.layerById(id); if (L) this._commitLayerProp(id, 'blend', L.blend || 'normal', v || 'normal'); }
  renameLayer(id, name) {
    const L = this.scene.layerById(id); if (!L) return;
    const n = String(name == null ? '' : name).trim();
    if (n) this._commitLayerProp(id, 'name', L.name, n);
  }
  _promptRenameLayer(id) {
    const L = this.scene.layerById(id); if (!L) return;
    const name = window.prompt('Layer name', L.name);
    if (name != null) this.renameLayer(id, name);
  }

  // ---------------- objects / layers panel ----------------
  /** A short, glanceable label for an item row. */
  _layerLabel(it) {
    let glyph = { stroke: '✏️', line: '╱', arrow: '➤', rect: '▭', ellipse: '◯',
                  polygon: '★', text: 'T', image: '🖼', connector: '⇢' }[it.type] || '•';
    let name = it.type;
    if (it.type === 'stroke' && it.taper) { glyph = '🖌️'; name = 'brush'; }
    if (it.type === 'text') name += ' “' + String(it.text).replace(/\s+/g, ' ').slice(0, 10) + '”';
    if (it.group) name += ' ⊞';
    return `${glyph} ${name}`;
  }

  _selectFromPanel(id) {
    const it = this.scene.byId(id);
    if (!it || this.scene.isItemLocked(it) || this.scene.isItemHidden(it)) return; // can't grab what you can't touch — use the toggles
    this.selectedIds = new Set(this._groupMembers(it));
    this._activeId = id; // panel-clicked row becomes the active (parent target)
    if (this.tool !== 'select') this.setTool('select');
    this._updateHud();
    this.requestRender();
  }

  _layerRow(it, depth = 0) {
    const row = document.createElement('div');
    row.className = 'layer-row' + (this.selectedIds.has(it.id) ? ' sel' : '')
                                + (it.id === this._activeId ? ' active' : '');
    row.dataset.id = it.id;
    if (depth) row.style.setProperty('--depth', depth);

    const name = document.createElement('button');
    name.className = 'lr-name';
    // a faint "└ " guide marks a child row at a glance
    name.textContent = (depth ? '└ ' : '') + this._layerLabel(it);
    name.title = it.id + (it.parent ? `  (child of ${it.parent})` : '');
    // a real drag re-parents and suppresses this click so it never also selects
    name.onclick = () => { if (this._suppressLayerClick) return; this._selectFromPanel(it.id); };

    const hide = document.createElement('button');
    hide.className = 'lr-tog lr-hide' + (it.hidden ? '' : ' on');
    hide.textContent = it.hidden ? '🚫' : '👁';
    hide.title = it.hidden ? 'Show' : 'Hide';
    hide.onclick = (e) => { e.stopPropagation(); this.setHidden([it.id], !it.hidden); };

    const lock = document.createElement('button');
    lock.className = 'lr-tog lr-lock' + (it.locked ? ' on' : '');
    lock.textContent = it.locked ? '🔒' : '🔓';
    lock.title = it.locked ? 'Unlock' : 'Lock';
    lock.onclick = (e) => { e.stopPropagation(); this.setLocked([it.id], !it.locked); };

    row.append(name, hide, lock);
    row.addEventListener('pointerdown', e => this._beginRowDrag(e, it.id));
    return row;
  }

  /** Pointer-drag an Objects-panel row to re-parent it. Drop ONTO another row →
   *  parent to that item (cycle-guarded); drop onto the panel's empty space →
   *  unparent (detach to a root). Distinguished from a click by a movement
   *  threshold; the target row / unparent zone highlights live. */
  _beginRowDrag(e, id) {
    if (e.button !== 0) return;
    if (e.target.closest('.lr-tog')) return;        // the hide/lock toggles handle themselves
    const panel = document.getElementById('layers-panel');
    if (!panel) return;
    const srcRow = e.currentTarget;
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    const clearHi = () => {
      for (const r of panel.querySelectorAll('.layer-row.drop-into')) r.classList.remove('drop-into');
      panel.classList.remove('drop-unparent');
    };
    // what's under the pointer: a droppable row (not the source), the panel
    // (→ unparent), or nothing (→ cancel)
    const targetAt = (ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!el) return { kind: 'none' };
      const row = el.closest('.layer-row');
      if (row && row !== srcRow && row.dataset.id) return { kind: 'row', row, id: row.dataset.id };
      if (panel.contains(el)) return { kind: 'unparent' };
      return { kind: 'none' };
    };
    const onMove = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 6) return;
        dragging = true; srcRow.classList.add('drag-src');
      }
      clearHi();
      const t = targetAt(ev);
      if (t.kind === 'row') t.row.classList.add('drop-into');
      else if (t.kind === 'unparent') panel.classList.add('drop-unparent');
    };
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      if (dragging) {
        const t = targetAt(ev);
        if (t.kind === 'row') this.reparentItem(id, t.id);
        else if (t.kind === 'unparent') this.reparentItem(id, null);
        this._suppressLayerClick = true;             // swallow the trailing select-click
        setTimeout(() => { this._suppressLayerClick = false; }, 0);
      }
      clearHi();
      srcRow.classList.remove('drag-src');
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  }

  /** Rebuild the Objects list, front-most first (top of z-stack on top). Capped
   *  for performance; recovery actions in the header cover anything past the cap. */
  /** Collapse / expand the Objects panel's list ("hide the list of all elements").
   *  Persisted, and the (hidden) list rebuild is skipped while collapsed. */
  toggleLayersPanel(force) {
    const panel = document.getElementById('layers-panel');
    if (!panel) return;
    const on = force === undefined ? !panel.classList.contains('collapsed') : !!force;
    panel.classList.toggle('collapsed', on);
    const btn = document.getElementById('layerCollapse');
    if (btn) { btn.textContent = on ? '▸' : '▾'; btn.setAttribute('aria-expanded', String(!on)); }
    try { localStorage.setItem('infinizoom.layersCollapsed', on ? '1' : '0'); } catch { /* ignore */ }
    if (!on) this._renderLayers(); // rebuild the list we skipped while collapsed
  }
  _layersCollapsed() {
    const panel = document.getElementById('layers-panel');
    return !!(panel && panel.classList.contains('collapsed'));
  }

  /** Collapse / expand the Bookmarks section (a <details> in the Action panel).
   *  `force` is the COLLAPSE flag (true = collapse, false = expand) to preserve the
   *  old API: collapseBookmarks(false) expands. Collapsed at rest so an empty list
   *  never shows on first load; adding a bookmark auto-expands it (see addBookmark).
   *  Persisted via the section's `toggle` event (see _bindUI), so manual caret
   *  clicks persist too. */
  toggleBookmarkPanel(force) {
    const sect = document.getElementById('bookmark-sect');
    if (!sect) return;
    const collapse = force === undefined ? sect.open : !!force;
    sect.open = !collapse;
    // persist synchronously on the API path (the <details> `toggle` event is async,
    // so a programmatic reload right after could otherwise race the write); the
    // toggle listener in _bindUI covers manual caret clicks.
    try { localStorage.setItem('infinizoom.bookmarksCollapsed', collapse ? '1' : '0'); } catch { /* ignore */ }
  }
  _bookmarksCollapsed() {
    const sect = document.getElementById('bookmark-sect');
    return !!(sect && !sect.open);
  }

  // ---------------- mobile / compact layout ----------------
  // On narrow screens the floating aux panels would overlap and bury the canvas,
  // so we turn them into one-at-a-time modal bottom-sheet DRAWERS, opened from a
  // fixed bottom dock. Driven by matchMedia → body.compact (the CSS @media block
  // does the actual layout; this only manages the open/close state + body class).
  _initMobile() {
    this._openDrawer = null;
    // drawer name → panel element id
    // Bookmarks fold into the Actions drawer now (no dedicated dock button), so the
    // dock is 4 buttons: style / objects / film / actions.
    this._drawerIds = {
      style: 'style-panel', objects: 'layers-panel',
      film: 'anim-panel', actions: 'action-panel',
    };
    this._mq = window.matchMedia('(max-width: 760px)');
    const onChange = () => this._applyCompact();
    if (this._mq.addEventListener) this._mq.addEventListener('change', onChange);
    else if (this._mq.addListener) this._mq.addListener(onChange); // older API
    this._applyCompact();

    document.querySelectorAll('#mobile-dock [data-drawer]').forEach(b =>
      b.addEventListener('click', () => this.toggleDrawer(b.dataset.drawer)));
    const scrim = document.getElementById('drawer-scrim');
    if (scrim) scrim.addEventListener('click', () => this.closeDrawers());
  }
  /** Reflect the current viewport into body.compact; close drawers when leaving
   *  mobile so the desktop layout is never left in a half-open state. Also called
   *  from the window resize handler so it tracks viewport changes in tests. */
  _applyCompact() {
    if (!this._mq) return;
    const m = this._mq.matches;
    document.body.classList.toggle('compact', m);
    if (!m && this._openDrawer) this.closeDrawers();
  }
  isCompact() { return document.body.classList.contains('compact'); }
  currentDrawer() { return this._openDrawer; }

  /** Toggle a drawer: open it if closed, close it if it's the one already open. */
  toggleDrawer(name) {
    if (this._openDrawer === name) { this.closeDrawers(); return null; }
    return this.openDrawer(name);
  }
  /** Open a single aux panel as a bottom-sheet drawer (closes any other first). */
  openDrawer(name) {
    const id = this._drawerIds && this._drawerIds[name];
    if (!id) return null;
    this.closeDrawers();
    const el = document.getElementById(id);
    if (!el) return null;
    el.classList.add('open');
    this._openDrawer = name;
    document.body.classList.add('drawer-open');
    this._syncDock();
    // make sure freshly-revealed content is current
    if (name === 'objects') this._renderLayers();
    else if (name === 'film' && this.anim.on) this._renderThumbs();
    return name;
  }
  closeDrawers() {
    document.querySelectorAll('.panel.is-drawer.open').forEach(el => el.classList.remove('open'));
    this._openDrawer = null;
    document.body.classList.remove('drawer-open');
    this._syncDock();
  }
  _syncDock() {
    document.querySelectorAll('#mobile-dock [data-drawer]').forEach(b =>
      b.classList.toggle('active', b.dataset.drawer === this._openDrawer));
  }

  /** Keep the collapsed-header object count live (updates even while the list is
   *  hidden, so the badge stays honest — driven via the debounced _scheduleLayers
   *  off _updateHud). Empty string ⇒ the pill hides (`:empty`). */
  _updateLayerCount() {
    const badge = document.getElementById('layerCount');
    if (!badge) return;
    const n = this.scene.count();
    badge.textContent = n ? String(n) : '';
  }
  /** One layer header row: name (click=activate, dbl-click=rename), opacity
   *  slider, blend select, hide/lock toggles, "move selection here" + delete.
   *  Only shown when the doc has >1 layer — a single-layer doc keeps the calm,
   *  layer-chrome-free item list of before. */
  _layerHeadRow(L) {
    const scene = this.scene;
    const head = document.createElement('div');
    head.className = 'layer-head' + (L.id === scene.activeLayerId ? ' active' : '');
    head.dataset.layer = L.id;

    const name = document.createElement('button');
    name.className = 'lh-name';
    name.textContent = L.name;
    name.title = `Draw here (active) · double-click to rename · ${scene.itemsInLayer(L.id).length} item(s)`;
    name.onclick = () => this.setActiveLayer(L.id);
    name.ondblclick = (e) => { e.preventDefault(); this._promptRenameLayer(L.id); };

    const op = document.createElement('input');
    op.type = 'range'; op.className = 'lh-op';
    op.min = '0'; op.max = '1'; op.step = '0.01';
    op.value = String(L.opacity == null ? 1 : L.opacity);
    op.title = 'Layer opacity';
    op.oninput = () => {
      if (!this._layerOpDrag) this._layerOpDrag = { id: L.id, from: (L.opacity == null ? 1 : L.opacity) };
      scene.setLayerProps(L.id, { opacity: parseFloat(op.value) });   // live preview, no history
      this.requestRender();
    };
    op.onchange = () => {                                              // commit one undo step on release
      const d = this._layerOpDrag; this._layerOpDrag = null;
      this._commitLayerProp(L.id, 'opacity', d ? d.from : (L.opacity == null ? 1 : L.opacity), parseFloat(op.value));
    };

    const blend = document.createElement('select');
    blend.className = 'lh-blend';
    blend.title = 'Layer blend mode';
    for (const m of LAYER_BLEND_MODES) {
      const o = document.createElement('option');
      o.value = m.v; o.textContent = m.t;
      if ((L.blend || 'normal') === m.v) o.selected = true;
      blend.appendChild(o);
    }
    blend.onchange = () => this._commitLayerProp(L.id, 'blend', L.blend || 'normal', blend.value);

    const hide = document.createElement('button');
    hide.className = 'lr-tog lh-hide' + (L.hidden ? '' : ' on');
    hide.textContent = L.hidden ? '🚫' : '👁';
    hide.title = L.hidden ? 'Show layer' : 'Hide layer';
    hide.onclick = (e) => { e.stopPropagation(); this._commitLayerProp(L.id, 'hidden', !!L.hidden, !L.hidden); };

    const lock = document.createElement('button');
    lock.className = 'lr-tog lh-lock' + (L.locked ? ' on' : '');
    lock.textContent = L.locked ? '🔒' : '🔓';
    lock.title = L.locked ? 'Unlock layer' : 'Lock layer';
    lock.onclick = (e) => { e.stopPropagation(); this._commitLayerProp(L.id, 'locked', !!L.locked, !L.locked); };

    const up = document.createElement('button');
    up.className = 'lh-move'; up.textContent = '▲'; up.title = 'Move layer up';
    up.onclick = (e) => { e.stopPropagation(); this.moveLayer(L.id, +1); };
    const down = document.createElement('button');
    down.className = 'lh-move'; down.textContent = '▼'; down.title = 'Move layer down';
    down.onclick = (e) => { e.stopPropagation(); this.moveLayer(L.id, -1); };

    const assign = document.createElement('button');
    assign.className = 'lh-assign'; assign.textContent = '⤵';
    assign.title = 'Move the selected items into this layer';
    assign.disabled = this.selectedIds.size === 0;
    assign.onclick = (e) => { e.stopPropagation(); this.assignSelectionToLayer(L.id); };

    const del = document.createElement('button');
    del.className = 'lh-del'; del.textContent = '✕';
    del.title = 'Delete layer (its items fall to the layer below)';
    del.disabled = scene.layers.length <= 1;
    del.onclick = (e) => { e.stopPropagation(); this.removeLayer(L.id); };

    head.append(name, op, blend, hide, lock, up, down, assign, del);
    return head;
  }

  _renderLayers() {
    const wrap = document.getElementById('layer-list');
    if (!wrap) return;
    this._updateLayerCount();
    // Collapsed hides the list on desktop only (the mobile drawer is the
    // disclosure), so skip the rebuild only when actually hidden.
    if (this._layersCollapsed() && !this.isCompact()) return;
    const scene = this.scene;
    const total = scene.items.length;
    const CAP = 120;
    wrap.innerHTML = '';
    const frag = document.createDocumentFragment();
    let shown = 0;

    // Render an item list (front-most first) with the parenting tree, scoped to
    // the given items. A child whose parent is outside `itemList` (e.g. on another
    // layer) shows as a root within this list, so nothing is hidden behind it.
    const renderItemTree = (itemList) => {
      const inSet = new Set(itemList.map(i => i.id));
      const childrenByParent = new Map();                  // parentId -> [items], front-most first
      const roots = [];
      for (let i = itemList.length - 1; i >= 0; i--) {     // reverse doc order = front-on-top
        const it = itemList[i];
        const pid = (it.parent != null && this.scene.byId(it.parent) && inSet.has(it.parent)) ? it.parent : null;
        if (pid == null) roots.push(it);
        else { if (!childrenByParent.has(pid)) childrenByParent.set(pid, []); childrenByParent.get(pid).push(it); }
      }
      const visited = new Set();                           // guard against cycles
      const walk = (it, depth) => {
        if (shown >= CAP || visited.has(it.id)) return;
        visited.add(it.id);
        frag.appendChild(this._layerRow(it, depth));
        shown++;
        const kids = childrenByParent.get(it.id);
        if (kids) for (const k of kids) { if (shown >= CAP) break; walk(k, depth + 1); }
      };
      for (const r of roots) { if (shown >= CAP) break; walk(r, 0); }
    };

    if (scene.layers.length <= 1) {
      // Calm default: a flat item list, no layer chrome (byte-identical to before).
      renderItemTree(scene.items);
    } else {
      // Layered: a header per layer, top-most layer first (front-on-top), each
      // followed by its own items. Items are already grouped by layer on the array;
      // filtering per layer keeps the panel correct regardless.
      const baseId = scene.layers[0].id;
      for (let li = scene.layers.length - 1; li >= 0; li--) {
        const L = scene.layers[li];
        frag.appendChild(this._layerHeadRow(L));
        if (shown >= CAP) continue;
        renderItemTree(scene.items.filter(it => (it.layerId || baseId) === L.id));
      }
    }

    if (total > shown) {
      const more = document.createElement('div');
      more.className = 'layer-more';
      more.textContent = `+${total - shown} more — use 👁 / 🔓 above to reach all`;
      frag.appendChild(more);
    }
    wrap.appendChild(frag);
  }

  // ---------------- level-of-detail (zoom-dependent visibility) ----------------
  /** mode: 'near' (show only when zoomed in past now), 'far' (only zoomed out), 'all'. */
  setSelectionLOD(mode) {
    if (!this.selectedIds.size) return;
    const s = this.camera.scale;
    const ids = [...this.selectedIds];
    const before = ids.map(id => { const it = this.scene.byId(id); return { minScale: it?.minScale ?? null, maxScale: it?.maxScale ?? null }; });
    const apply = (it) => {
      if (mode === 'near') { it.minScale = s; it.maxScale = null; }
      else if (mode === 'far') { it.maxScale = s; it.minScale = null; }
      else { it.minScale = null; it.maxScale = null; }
    };
    const scene = this.scene;
    this.history.push({
      label: `lod ${mode}`,
      do() { for (const id of ids) { const it = scene.byId(id); if (it) apply(it); } scene._touch(); },
      undo() { ids.forEach((id, i) => { const it = scene.byId(id); if (it) { it.minScale = before[i].minScale; it.maxScale = before[i].maxScale; } }); scene._touch(); },
    });
    const label = mode === 'near' ? 'zoom-in only' : mode === 'far' ? 'zoom-out only' : 'always visible';
    this._toast(`LOD: ${this.selectedIds.size} item(s) → ${label}`);
    this.requestRender();
  }

  /** Count items currently visible at the present zoom (LOD pass). */
  visibleCount() {
    const s = this.camera.scale;
    let n = 0;
    for (const it of this.scene.items) if (lodVisible(it, s)) n++;
    return n;
  }

  // ---------------- recursive stamp (manual fractals) ----------------
  /** Drop `depth` progressively smaller copies of the selection toward its
   *  centre, each scaled by `factor`. Repeat to build a Droste-style fractal. */
  recursiveStamp({ factor = 0.42, depth = 3, anchor = null, spin = 0, hue = 0, fade = 0, drift = 0 } = {}) {
    if (!this.selectedIds.size) return 0;
    const items = [...this.selectedIds].map(id => this.scene.byId(id)).filter(Boolean);
    if (!items.length) return 0;
    let b = itemBBox(items[0]);
    b = { ...b };
    for (const it of items) { const ib = itemBBox(it); b.minX = Math.min(b.minX, ib.minX); b.minY = Math.min(b.minY, ib.minY); b.maxX = Math.max(b.maxX, ib.maxX); b.maxY = Math.max(b.maxY, ib.maxY); }
    // Centre the nested copies shrink toward: an explicit anchor wins; otherwise
    // the selection's EFFECTIVE pivot — custom Shift+P → centre of mass → bbox
    // centre, the SAME dispatch rotate/scale use (see _pivotWorld). So the COM
    // toggle and a dropped pivot make off-centre fractals, consistently.
    const piv = anchor || this._pivotWorld() || { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    const cx = piv.x, cy = piv.y;
    // VORTEX knobs (all default-off → byte-identical clones when untouched). Spin
    // & scale both happen about the SAME centre, so they commute — they share one
    // fixed point, no matrix order to worry about. Each effect ACCUMULATES per level
    // (×(k+1)) for a true logarithmic spiral / smooth chromatic ramp, and stays GUARDED
    // behind a non-zero check so a 0 never bakes a stray `rot:0` / `opacity` into the
    // JSON. (DRIFT, below, is the one knob that deliberately MOVES that fixed point.)
    const spinRad = ((+spin || 0) * Math.PI) / 180;
    const hueDeg = +hue || 0;
    const fadeF = Math.min(0.95, Math.max(0, +fade || 0));
    const driftF = +drift || 0;
    // DRIFT — the per-level TRANSLATE. The recursion is the iterated similarity
    // T(q) = L·q + t (q measured from the pivot), L = factor·R(spin) the per-step
    // shrink+turn, t the per-step world shift (driftF · the larger bbox side, along
    // +X). Level k's copy is T^(k+1) = L^(k+1)·q + Σ_{j=0..k} L^j·t. The scale+rotate
    // below already build the L^(k+1)·q part about the pivot; this adds the closed-form
    // offset Σ_{j=0..k} L^j·t as a plain world translate. We accumulate it iteratively:
    // `term` is the current L^j·t (rotated factor·R(spin) each step), `acc` the partial
    // sum. acc holds offsetVec_k at the top of level k. With driftF 0 the whole block is
    // skipped → the scale+rotate path is byte-identical to a pre-drift stamp.
    const refDim = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    const t0x = driftF * refDim, t0y = 0;     // per-step shift t = L^0·t (j=0 term)
    const cosS = Math.cos(spinRad), sinS = Math.sin(spinRad);
    let termX = t0x, termY = t0y;             // current L^j·t
    let accX = t0x, accY = t0y;               // Σ_{j=0..k} L^j·t  (== offsetVec_0 now)
    const clones = [];
    let s = factor;
    for (let k = 0; k < depth; k++) {
      for (const it of items) {
        const c = JSON.parse(JSON.stringify(it));
        c.id = `st_${(this._stampSeq = (this._stampSeq || 0) + 1).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        delete c.parent; // fractal copies are standalone, not part of the hierarchy
        scaleItemAbout(c, cx, cy, s);
        if (spinRad) rotateItemsAbout([c], cx, cy, spinRad * (k + 1));
        if (hueDeg) this._shiftItemHue(c, hueDeg * (k + 1));
        if (fadeF) c.opacity = (c.opacity == null ? 1 : c.opacity) * Math.pow(1 - fadeF, k + 1);
        if (driftF) translateItem(c, accX, accY);   // + offsetVec_k
        clones.push(c);
      }
      // advance the offset sum for the NEXT level: term ← L·term, acc ← acc + term.
      if (driftF) {
        const nx = factor * (cosS * termX - sinS * termY);
        const ny = factor * (sinS * termX + cosS * termY);
        termX = nx; termY = ny;
        accX += termX; accY += termY;
      }
      s *= factor;
    }
    this._assignFrame(clones);
    this.history.push(addItemsCmd(this.scene, clones));
    this.selectedIds = new Set(clones.map(c => c.id));
    this._updateHud();
    const vortex = spinRad || hueDeg || fadeF || driftF;
    this._toast(`${vortex ? '🌀 Vortex-stamped' : 'Stamped'} ${clones.length} nested copies`);
    return clones.length;
  }

  /** Rotate the hue of a stamped clone's ink by `deg` degrees — its stroke colour,
   *  a flat fill, or every stop of a gradient fill. Greys are left grey; anything
   *  non-hex passes through untouched (see util.shiftHue). The chromatic vortex. */
  _shiftItemHue(c, deg) {
    if (!deg) return;
    // Delegate to the shared util (single source of truth — also used by the live
    // portal renderer). It returns a shallow CLONE; copy the recoloured ink back
    // onto `c` in place (the caller owns `c`, a fresh stamp clone).
    const s = hueShiftedItem(c, deg);
    c.color = s.color;
    c.fill = s.fill;
  }

  /**
   * Create a LIVE recursive Droste portal from the current selection. Unlike the
   * recursive STAMP (which bakes a few finite shrinking copies as real items),
   * this captures a SNAPSHOT of the selected art and drops a frame box inside it;
   * the renderer redraws the snapshot ever-deeper, revealing more levels as you
   * zoom into the frame — the one feature that truly lives on an infinite canvas.
   *
   * `factor` sizes the frame relative to the source bbox (the per-level shrink).
   * `rot` (radians) tilts the frame → an infinite logarithmic SPIRAL (the vortex
   * Spin, carried over from the baked stamp). `hue` (degrees PER LEVEL) rotates
   * each deeper level's ink a step further round the colour wheel → an endless
   * chromatic tunnel (the vortex Hue). Both default 0 ⇒ a plain portal, and a 0
   * `hue` is never stored, so existing portals stay byte-identical. (FADE is left
   * to the finite stamp on purpose: on an INFINITE dive a per-level opacity drop
   * would recede the whole view toward transparency — a vanishing destination,
   * not depth — so the knob would stop meaning what it means on the stamp.)
   */
  createDroste({ factor = 0.42, rot = 0, hue = 0, anchor = null, maxDepth = 48 } = {}) {
    if (!this.selectedIds.size) { this._toast('Select art first, then make a portal'); return null; }
    // Snapshot the selection, excluding any existing portal (no nested ∞ recursion).
    const items = [...this.selectedIds]
      .map(id => this.scene.byId(id)).filter(Boolean)
      .filter(it => it.type !== 'droste');
    if (!items.length) { this._toast('Pick non-portal art to recurse'); return null; }
    let b = { ...itemBBox(items[0]) };
    for (const it of items) {
      const ib = itemBBox(it);
      b.minX = Math.min(b.minX, ib.minX); b.minY = Math.min(b.minY, ib.minY);
      b.maxX = Math.max(b.maxX, ib.maxX); b.maxY = Math.max(b.maxY, ib.maxY);
    }
    const W0 = b.maxX - b.minX, H0 = b.maxY - b.minY;
    if (!(W0 > 1e-9) || !(H0 > 1e-9)) { this._toast('Selection is too thin to recurse'); return null; }
    // Deep-copy the snapshot; strip hierarchy refs so it is self-contained.
    const src = items.map(it => { const c = JSON.parse(JSON.stringify(it)); delete c.parent; delete c.group; return c; });
    const srcBBox = { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
    // Frame: a scaled copy of the source bbox (aspect preserved ⇒ M is a pure
    // similarity), centred on the source by default → a clean self-nesting.
    const fw = W0 * factor, fh = H0 * factor;
    const cx = anchor ? anchor.x : (b.minX + b.maxX) / 2;
    const cy = anchor ? anchor.y : (b.minY + b.maxY) / 2;
    const it = makeDroste(src, srcBBox,
      { x: cx - fw / 2, y: cy - fh / 2, w: fw, h: fh, rot }, { maxDepth, hue });
    this._assignFrame([it]);
    this.history.push(addItemsCmd(this.scene, [it]));
    this.selectedIds = new Set([it.id]);
    this._activeId = it.id;
    this._updateHud();
    this.requestRender();
    this._toast('Recursive portal — zoom into it to dive ∞');
    return it;
  }

  /** The portal a Droste-loop export should target: the selected one if a single
   *  portal is selected, else the scene's only portal, else null. */
  _targetDroste() {
    const sel = [...this.selectedIds].map(id => this.scene.byId(id))
      .filter(it => it && it.type === 'droste');
    if (sel.length === 1) return sel[0];
    const all = this.scene.items.filter(it => it.type === 'droste');
    if (all.length === 1) return all[0];
    return sel[0] || null;   // ambiguous multi-portal: first selected, or nothing
  }

  /** Encode the targeted portal's seamless zoom-loop GIF (Uint8Array | null). */
  exportDrosteLoopBytes(opts = {}) {
    this.stop();
    const it = opts.id ? this.scene.byId(opts.id) : this._targetDroste();
    return exportDrosteLoopGIF(this, it, { ...opts, ss: this._exportSS(opts) });
  }

  /** Encode + download the targeted portal as a seamlessly-looping Droste-zoom .gif. */
  downloadDrosteLoop(opts = {}) {
    const it = opts.id ? this.scene.byId(opts.id) : this._targetDroste();
    if (!it || it.type !== 'droste') {
      this._toast('Select a recursive portal to loop ∞');
      return;
    }
    try {
      const bytes = exportDrosteLoopGIF(this, it, { ...opts, ss: this._exportSS(opts) });
      if (!bytes) { this._toast('Re-center the portal on its art to loop it ∞'); return; }
      storage.downloadGIF(bytes, 'droste-loop.gif');
      this._toast(`🌀 Exported seamless Droste loop (${(bytes.length / 1024) | 0} KB)`);
    } catch (e) {
      console.warn('Droste-loop export failed', e);
      this._toast('Droste-loop export failed');
    }
  }

  // ---------------- bookmarks + animated fly-to ----------------
  _loadBookmarks() {
    try { this.bookmarks = JSON.parse(localStorage.getItem('infinizoom.bookmarks') || '[]'); }
    catch { this.bookmarks = []; }
    if (!Array.isArray(this.bookmarks)) this.bookmarks = [];
  }
  _saveBookmarks() {
    try { localStorage.setItem('infinizoom.bookmarks', JSON.stringify(this.bookmarks)); } catch { /* ignore */ }
  }
  addBookmark(name) {
    if (!this.bookmarks) this._loadBookmarks();
    const cam = this.camera.serialize();
    const bm = { name: name || `View ${this.bookmarks.length + 1}`, ...cam };
    this.bookmarks.push(bm);
    this._saveBookmarks();
    this._renderBookmarks();
    this.toggleBookmarkPanel(false); // contextual reveal — show the list you just added to
    this._toast(`Bookmarked “${bm.name}”`);
    return bm;
  }
  removeBookmark(index) {
    if (!this.bookmarks) return;
    this.bookmarks.splice(index, 1);
    this._saveBookmarks();
    this._renderBookmarks();
  }
  gotoBookmark(index, animate = true) {
    const bm = this.bookmarks && this.bookmarks[index];
    if (!bm) return;
    if (animate) this.flyTo(bm, 700);
    else { this.camera.restore(bm); this._updateHud(); this.requestRender(); }
  }

  /** Smoothly animate the camera to a target {x,y,scale}. Scale is eased in
   *  log space so even billion-fold jumps feel natural. */
  flyTo(target, duration = 700) {
    if (this._flying) cancelAnimationFrame(this._flying);
    const start = this.camera.serialize();
    const end = { x: target.x, y: target.y, scale: clamp(target.scale || start.scale, this.camera.minScale, this.camera.maxScale) };
    if (duration <= 0) { this.camera.restore(end); this._updateHud(); this.requestRender(); return Promise.resolve(); }
    const t0 = performance.now();
    const ls = Math.log(start.scale), le = Math.log(end.scale);
    const ease = u => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
    return new Promise(resolve => {
      const step = () => {
        const u = clamp((performance.now() - t0) / duration, 0, 1);
        const e = ease(u);
        this.camera.scale = Math.exp(ls + (le - ls) * e);
        this.camera.x = start.x + (end.x - start.x) * e;
        this.camera.y = start.y + (end.y - start.y) * e;
        this._updateHud();
        this.requestRender();
        if (u < 1) { this._flying = requestAnimationFrame(step); }
        else { this._flying = null; resolve(); }
      };
      this._flying = requestAnimationFrame(step);
    });
  }

  _renderBookmarks() {
    const wrap = document.getElementById('bookmark-list');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!this.bookmarks) this._loadBookmarks();
    const badge = document.getElementById('bmCount');
    if (badge) badge.textContent = this.bookmarks.length ? String(this.bookmarks.length) : '';
    for (let i = 0; i < this.bookmarks.length; i++) {
      const bm = this.bookmarks[i];
      const row = document.createElement('div');
      row.className = 'bm-row';
      const go = document.createElement('button');
      go.className = 'bm-go';
      go.textContent = bm.name;
      go.title = `Fly to ${bm.name} (${formatZoom(bm.scale)})`;
      go.onclick = () => this.gotoBookmark(i, true);
      const del = document.createElement('button');
      del.className = 'bm-del';
      del.textContent = '×';
      del.title = 'Delete bookmark';
      del.onclick = (e) => { e.stopPropagation(); this.removeBookmark(i); };
      row.append(go, del);
      wrap.appendChild(row);
    }
  }

  // ---------------- flipbook / stop-motion animation ----------------
  /** The page an item lives on (absent `frame` ⇒ page 0). */
  frameOf(it) { return it ? (it.frame || 0) : 0; }

  /** Highest page index any item currently occupies (0 if none). */
  _framesMaxUsed() {
    let m = 0;
    for (const it of this.scene.items) { const f = it.frame || 0; if (f > m) m = f; }
    return m;
  }

  /** Keep page count ≥ pages actually drawn, and current page within range. */
  _reconcileFrames() {
    this.anim.count = Math.max(1, this.anim.count | 0, this._framesMaxUsed() + 1);
    this.anim.current = clamp(this.anim.current | 0, 0, this.anim.count - 1);
    this._normalizeHolds();
    this._normalizeCams();
  }

  /** Per-frame hold (how many base ticks page f shows for); ≥1. */
  _holdAt(f) { const h = this.anim.holds; return Math.max(1, (h && h[f]) | 0 || 1); }

  /** Ensure the holds array is exactly `count` long, each an integer in [1,20]. */
  _normalizeHolds() {
    const a = this.anim;
    if (!Array.isArray(a.holds)) a.holds = [];
    a.holds.length = a.count;
    for (let i = 0; i < a.count; i++) a.holds[i] = clamp(a.holds[i] | 0 || 1, 1, 20);
  }

  /** Ensure the cams (camera-keyframe) array is exactly `count` long; each slot
   *  is either a sanitised {x,y,scale,rot} snapshot or null (no keyframe). */
  _normalizeCams() {
    const a = this.anim;
    if (!Array.isArray(a.cams)) a.cams = [];
    a.cams.length = a.count;
    for (let i = 0; i < a.count; i++) a.cams[i] = sanitizeCam(a.cams[i]);
  }

  // ---------------- cinematic camera path (per-page keyframes) ----------------
  /** Total timeline length in base ticks (Σ holds). */
  _timelineTicks() { let s = 0; for (let f = 0; f < this.anim.count; f++) s += this._holdAt(f); return s; }
  /** Tick at which page `f` begins (Σ holds of the pages before it). */
  _frameStartTick(f) { let s = 0; const n = clamp(f | 0, 0, this.anim.count); for (let i = 0; i < n; i++) s += this._holdAt(i); return s; }
  /** Which page is showing at timeline position `tick` (each page owns
   *  [start, start+hold) ticks; the last page absorbs the end-point). */
  _pageAtTick(tick) {
    let s = 0;
    for (let f = 0; f < this.anim.count; f++) { const h = this._holdAt(f); if (tick < s + h) return f; s += h; }
    return this.anim.count - 1;
  }
  /** True iff at least one page carries a camera keyframe. */
  hasCameraPath() { const c = this.anim.cams; return Array.isArray(c) && c.some(Boolean); }
  /** The pinned pages as {tick, cam} stops, in timeline order. */
  _cameraStops() {
    this._normalizeCams();
    const out = [];
    for (let f = 0; f < this.anim.count; f++) { const c = this.anim.cams[f]; if (c) out.push({ tick: this._frameStartTick(f), cam: c }); }
    return out;
  }
  /** Sample the camera path at timeline position `tick` → {x,y,scale,rot} or
   *  null when no page is pinned. Interpolates GEOMETRICALLY on scale between
   *  adjacent stops. By default it CLAMPS to the first/last keyframe outside the
   *  pinned span (deterministic, used by the export-frame math + tests). When
   *  `cyclic` is true (looping playback/export) the wrap region — past the last
   *  stop and before the first — GLIDES from the last keyframe back to the first
   *  across the timeline seam, so a loop is seamless instead of snapping. */
  sampleCameraAtTick(tick, cyclic = false) {
    const stops = this._cameraStops();
    if (!stops.length) return null;
    const ease = t => easeProgress(t, this.anim.ease);   // shape each segment's velocity
    const first = stops[0], last = stops[stops.length - 1];
    if (cyclic && stops.length >= 2) {
      const total = this._timelineTicks();
      const gap = (total - last.tick) + first.tick;     // wrap-segment length
      if (gap > 0) {
        if (tick >= last.tick) return lerpCamera(last.cam, first.cam, ease((tick - last.tick) / gap));
        if (tick < first.tick) return lerpCamera(last.cam, first.cam, ease((total - last.tick + tick) / gap));
      }
    }
    if (tick <= first.tick) return { ...first.cam };
    if (tick >= last.tick) return { ...last.cam };
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      if (tick >= a.tick && tick <= b.tick) {
        const span = b.tick - a.tick;
        return lerpCamera(a.cam, b.cam, span > 0 ? ease((tick - a.tick) / span) : 0);
      }
    }
    return { ...last.cam };
  }

  /** Pin the current view as page `f`'s camera keyframe (default: current page).
   *  Animation metadata — persisted like holds/fps, not an undo step. */
  setPageCamera(f = this.anim.current) {
    this._ensureFlipbook();
    this._normalizeCams();
    f = clamp(f | 0, 0, this.anim.count - 1);
    this.anim.cams[f] = this.camera.serialize();
    this._saveAnim();
    this._updateAnimUI();
    this.requestRender();
    this._toast(`📷 Camera pinned to page ${f + 1}`);
    return this.anim.cams[f];
  }
  /** Remove page `f`'s camera keyframe (default: current). Returns whether one
   *  was actually cleared. */
  clearPageCamera(f = this.anim.current) {
    this._normalizeCams();
    f = clamp(f | 0, 0, this.anim.count - 1);
    const had = !!this.anim.cams[f];
    this.anim.cams[f] = null;
    if (had) { this._saveAnim(); this._updateAnimUI(); this.requestRender(); this._toast(`Camera cleared from page ${f + 1}`); }
    return had;
  }
  /** This page's camera keyframe, or null. */
  pageCamera(f = this.anim.current) { this._normalizeCams(); return this.anim.cams[clamp(f | 0, 0, this.anim.count - 1)] || null; }
  /** How many pages are pinned. */
  cameraKeyframeCount() { this._normalizeCams(); return this.anim.cams.filter(Boolean).length; }

  /** The on-canvas MOTION-PATH overlay state, or null when it shouldn't show.
   *  It's the cinematic flight-plan made visible in the EDITING view (a
   *  composition tool — see the path before you play). Returns:
   *   • `keyframes` — the pinned pages as {page, ...cam} stops, in timeline order
   *     (the bold, numbered "shot" frames the camera settles on);
   *   • `samples` — the path sampled at EQUAL ticks (faint concentric frames whose
   *     SPACING is the velocity readout: bunched where the camera is slow — near a
   *     keyframe under ease-in-out — and spread where it's fast). One visual
   *     language (the framing rectangle) describes BOTH pan and zoom, so a pure
   *     dive reads as nested rings and a pan as a marching snake.
   *  Suppressed while PLAYING (the camera is already moving the path then, so the
   *  plan overlay would just be noise) and never reaches the GIF export (that uses
   *  a separate offscreen renderer with empty state). Gated on a path existing +
   *  the `Show path` opt-in. The framing rect each camera sees is computed from the
   *  LIVE viewport aspect in the renderer (matching how the cinematic export frames). */
  _motionPathRenderState() {
    if (!this.anim.on || !this.anim.showPath || this.anim.playing || !this.hasCameraPath()) return null;
    const stops = this._cameraStops();          // {tick, cam} for each pinned page, in order
    if (!stops.length) return null;
    const keyframes = [];
    for (let f = 0; f < this.anim.count; f++) {
      const c = this.anim.cams[f];
      if (c) keyframes.push({ page: f, x: c.x, y: c.y, scale: c.scale, rot: c.rot });
    }
    // Sample the path at equal ticks. With ≥2 stops, march across the pinned span
    // (or the full timeline including the cyclic wrap when looping) so the easing
    // shows; a single stop has nothing to interpolate, so no samples.
    const samples = [];
    if (stops.length >= 2) {
      const cyclic = !!this.anim.loop;
      const t0 = cyclic ? 0 : stops[0].tick;
      const t1 = cyclic ? this._timelineTicks() : stops[stops.length - 1].tick;
      const span = t1 - t0;
      const N = clamp(Math.round(span * 6), 24, 72);  // ~6 samples per base tick, bounded
      for (let i = 0; i <= N; i++) {
        const s = this.sampleCameraAtTick(t0 + (span * i) / N, cyclic);
        if (s) samples.push(s);
      }
    }
    return { keyframes, samples, currentPage: this.anim.current };
  }

  /** Tag freshly-created items with the active page (no-op when flipbook is off,
   *  so a normal infinite-canvas drawing never grows a `frame` field). */
  _assignFrame(items) {
    if (!this.anim.on) return items;
    const f = this.anim.current;
    for (const it of (Array.isArray(items) ? items : [items])) {
      if (f) it.frame = f; else delete it.frame; // page 0 is implicit
    }
    return items;
  }

  _itemsOnFrame(f) { return this.scene.items.filter(it => (it.frame || 0) === f); }
  /** How many items live on a page (default: the current one). */
  frameItemCount(f = this.anim.current) { return this._itemsOnFrame(f).length; }

  _ensureFlipbook() { if (!this.anim.on) this.setFlipbook(true); }

  /** Turn flipbook mode on/off. Turning on snaps the page count to what's drawn. */
  setFlipbook(on) {
    on = !!on;
    if (on === this.anim.on) { this._updateAnimUI(); return; }
    this.anim.on = on;
    if (on) this._reconcileFrames(); else this.stop();
    this.selectedIds.clear();           // a selection may now be off-page
    this._afterAnimChange();
    this._toast(on ? '🎬 Flipbook on — each page is a frame' : 'Flipbook off');
  }
  toggleFlipbook() { this.setFlipbook(!this.anim.on); }

  /** Jump to page i (clamped). Pure navigation — not an undo step. */
  setFrame(i) {
    this._ensureFlipbook();
    this.anim.current = clamp(i | 0, 0, this.anim.count - 1);
    this.selectedIds.clear();
    this._afterAnimChange();
  }
  nextFrame() { if (this.anim.count) this.setFrame((this.anim.current + 1) % this.anim.count); }
  prevFrame() { if (this.anim.count) this.setFrame((this.anim.current - 1 + this.anim.count) % this.anim.count); }

  /** Insert a blank page right after the current one (undoable). */
  addFrame() {
    this._ensureFlipbook();
    const at = this.anim.current, app = this, scene = this.scene;
    const shifted = scene.items.filter(it => (it.frame || 0) > at).map(it => it.id);
    const oldCount = this.anim.count, oldCur = this.anim.current;
    this.history.push({
      label: 'add frame',
      do() {
        for (const id of shifted) { const it = scene.byId(id); if (it) it.frame = (it.frame || 0) + 1; }
        app.anim.holds.splice(at + 1, 0, 1);  // new blank page holds 1
        app.anim.cams.splice(at + 1, 0, null); // …and starts unpinned
        app.anim.count = oldCount + 1; app.anim.current = at + 1; scene._touch(); app._afterAnimChange();
      },
      undo() {
        for (const id of shifted) { const it = scene.byId(id); if (it) { it.frame = (it.frame || 0) - 1; if (!it.frame) delete it.frame; } }
        app.anim.holds.splice(at + 1, 1);
        app.anim.cams.splice(at + 1, 1);
        app.anim.count = oldCount; app.anim.current = oldCur; scene._touch(); app._afterAnimChange();
      },
    });
    this._toast(`Added page ${at + 2}`);
  }

  /** Duplicate the current page's drawing onto a fresh page after it (undoable).
   *  The heart of stop-motion: copy a page, then nudge things a little. */
  duplicateFrame() {
    this._ensureFlipbook();
    const at = this.anim.current, app = this, scene = this.scene;
    const shifted = scene.items.filter(it => (it.frame || 0) > at).map(it => it.id);
    const src = this._itemsOnFrame(at);
    const idMap = new Map();
    const clones = src.map(it => {
      const c = JSON.parse(JSON.stringify(it));
      c.id = `fd_${(this._fdupSeq = (this._fdupSeq || 0) + 1).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      c.frame = at + 1;
      idMap.set(it.id, c.id);
      return c;
    });
    this._relinkConnectors(clones, idMap);
    this._relinkRefs(clones, idMap);
    this._remapGroups(clones);
    const oldCount = this.anim.count, oldCur = this.anim.current;
    this.history.push({
      label: 'duplicate frame',
      do() {
        for (const id of shifted) { const it = scene.byId(id); if (it) it.frame = (it.frame || 0) + 1; }
        scene.addMany(clones);
        app.anim.holds.splice(at + 1, 0, app._holdAt(at)); // dup inherits the page's hold
        app.anim.cams.splice(at + 1, 0, sanitizeCam(app.anim.cams[at])); // …and its camera keyframe
        app.anim.count = oldCount + 1; app.anim.current = at + 1; app._afterAnimChange();
      },
      undo() {
        scene.removeMany(clones.map(c => c.id));
        for (const id of shifted) { const it = scene.byId(id); if (it) { it.frame = (it.frame || 0) - 1; if (!it.frame) delete it.frame; } }
        app.anim.holds.splice(at + 1, 1);
        app.anim.cams.splice(at + 1, 1);
        app.anim.count = oldCount; app.anim.current = oldCur; app._afterAnimChange();
      },
    });
    this._toast(`Duplicated page → ${at + 2}`);
  }

  /** Delete the current page (its items and the slot), pulling later pages down.
   *  The final remaining page can't be removed — it's just emptied. (undoable) */
  deleteFrame() {
    this._ensureFlipbook();
    const scene = this.scene, app = this;
    if (this.anim.count <= 1) {
      const items = this._itemsOnFrame(0);
      if (items.length) this.history.push(removeItemsCmd(scene, items));
      this.anim.current = 0; this._afterAnimChange();
      return;
    }
    const at = this.anim.current;
    const doomed = this._itemsOnFrame(at);
    const snapshot = doomed.map(it => ({ item: it, index: scene.items.indexOf(it) })).sort((a, b) => a.index - b.index);
    const shifted = scene.items.filter(it => (it.frame || 0) > at).map(it => it.id);
    const oldCount = this.anim.count, oldCur = this.anim.current;
    const newCur = Math.min(at, oldCount - 2);
    const removedHold = this._holdAt(at);
    const removedCam = sanitizeCam(this.anim.cams[at]);
    this.history.push({
      label: 'delete frame',
      do() {
        scene.removeMany(doomed.map(i => i.id));
        for (const id of shifted) { const it = scene.byId(id); if (it) { it.frame = (it.frame || 0) - 1; if (!it.frame) delete it.frame; } }
        app.anim.holds.splice(at, 1);
        app.anim.cams.splice(at, 1);
        app.anim.count = oldCount - 1; app.anim.current = newCur; app._afterAnimChange();
      },
      undo() {
        for (const id of shifted) { const it = scene.byId(id); if (it) it.frame = (it.frame || 0) + 1; }
        for (const { item, index } of snapshot) { const a = Math.min(index, scene.items.length); scene.items.splice(a, 0, item); scene._index.set(item.id, item); }
        app.anim.holds.splice(at, 0, removedHold);
        app.anim.cams.splice(at, 0, removedCam);
        app.anim.count = oldCount; app.anim.current = oldCur; scene._touch(); app._afterAnimChange();
      },
    });
    this._toast(`Deleted page ${at + 1}`);
  }

  /** Reassign the selection onto another page (cross-frame edit, undoable). */
  moveSelectionToFrame(target) {
    if (!this.anim.on || !this.selectedIds.size) return;
    target = clamp(target | 0, 0, this.anim.count - 1);
    const ids = [...this.selectedIds].filter(id => this.scene.byId(id));
    if (!ids.length) return;
    const scene = this.scene;
    const before = ids.map(id => ({ id, frame: scene.byId(id).frame || 0 }));
    const setF = (id, f) => { const it = scene.byId(id); if (it) { if (f) it.frame = f; else delete it.frame; } };
    this.history.push({
      label: 'move to frame',
      do() { for (const id of ids) setF(id, target); scene._touch(); },
      undo() { for (const { id, frame } of before) setF(id, frame); scene._touch(); },
    });
    this.selectedIds.clear();           // they've left the current page
    this._afterAnimChange();
    this._toast(`Moved ${ids.length} to page ${target + 1}`);
  }

  /** Reorder pages: pull page `from` out and drop it at position `to` (undoable).
   *  Every item's `frame` is remapped, the per-page `holds` slot rides along
   *  (array-move splice), and the current page follows the moved one. Count is
   *  unchanged — it's a permutation of the page axis, so a no-op when from===to.
   *  This is the model op behind drag-to-reorder on the thumbnail strip. */
  moveFrame(from, to) {
    this._ensureFlipbook();
    const count = this.anim.count;
    from = clamp(from | 0, 0, count - 1);
    to = clamp(to | 0, 0, count - 1);
    if (from === to) return false;
    const scene = this.scene, app = this;
    // where each old page index lands after pulling `from` and inserting at `to`
    const remap = (f) =>
      f === from ? to
      : from < to ? (f > from && f <= to ? f - 1 : f)
      : (f >= to && f < from ? f + 1 : f);
    // capture only the items whose page actually changes (cheap + exact undo)
    const affected = scene.items
      .map(it => ({ id: it.id, before: it.frame || 0 }))
      .filter(e => remap(e.before) !== e.before);
    const oldCur = this.anim.current;
    const oldHolds = this.anim.holds.slice();
    const newHolds = oldHolds.slice();
    const [h] = newHolds.splice(from, 1); newHolds.splice(to, 0, h);
    // the camera keyframe rides along with its page (same array-move)
    this._normalizeCams();
    const oldCams = this.anim.cams.slice();
    const newCams = oldCams.slice();
    const [c] = newCams.splice(from, 1); newCams.splice(to, 0, c);
    const setF = (id, f) => { const it = scene.byId(id); if (it) { if (f) it.frame = f; else delete it.frame; } };
    this.history.push({
      label: 'reorder pages',
      do() {
        for (const { id, before } of affected) setF(id, remap(before));
        app.anim.holds = newHolds.slice();
        app.anim.cams = newCams.slice();
        app.anim.current = to; scene._touch(); app._afterAnimChange();
      },
      undo() {
        for (const { id, before } of affected) setF(id, before);
        app.anim.holds = oldHolds.slice();
        app.anim.cams = oldCams.slice();
        app.anim.current = oldCur; scene._touch(); app._afterAnimChange();
      },
    });
    this._toast(`Moved page ${from + 1} → ${to + 1}`);
    return true;
  }

  // ---- playback ----
  play() {
    this._ensureFlipbook();
    if (this.anim.count <= 1) { this._toast('Add pages to animate first'); return; }
    if (this.anim.playing) return;
    this.anim.playing = true;
    this.selectedIds.clear();
    // Cinematic preview is NON-DESTRUCTIVE: remember the editing camera and put
    // it back when playback stops, so previewing a zoom never strands you at 1000×.
    this._preplayCam = this.hasCameraPath() ? this.camera.serialize() : null;
    // Single wall-clock for both content (page flips) and camera (the tween),
    // started at the current page so playing from the middle continues from there.
    this._playStartMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._playBaseTick = this._frameStartTick(this.anim.current);
    this._updateAnimUI(); this.requestRender();
    this._step();
  }
  _step() {
    if (!this.anim.playing) return;
    const total = this._timelineTicks();
    const msPerTick = 1000 / clamp(this.anim.fps, 1, 60);
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let tick = this._playBaseTick + (now - this._playStartMs) / msPerTick;
    const path = this.hasCameraPath();
    if (this.anim.loop) {
      tick = total > 0 ? ((tick % total) + total) % total : 0;
    } else if (tick >= total) {
      // settle on the final page + its camera, then stop (without the preview
      // restore — a non-looping play ends ON the last keyframe by design)
      this.anim.current = this.anim.count - 1;
      if (path) this._applyCamera(this.sampleCameraAtTick(total));
      this._preplayCam = null;
      this.stop();
      return;
    }
    const page = this._pageAtTick(tick);
    const pageChanged = page !== this.anim.current;
    if (pageChanged) { this.anim.current = page; this._updateAnimUI(); }
    if (path) { this._applyCamera(this.sampleCameraAtTick(tick, this.anim.loop)); this.requestRender(); }
    else if (pageChanged) this.requestRender();
    this._playTimer = requestAnimationFrame(() => this._step());
  }
  /** Move the live camera onto a path sample. The minimap viewport rect follows
   *  via the normal render cycle (requestRender → render → minimap.render). */
  _applyCamera(sample) {
    if (sample) this.camera.restore(sample);
  }
  stop() {
    if (this._playTimer != null) { cancelAnimationFrame(this._playTimer); this._playTimer = null; }
    if (this.anim.playing) {
      this.anim.playing = false;
      // restore the editing camera saved at play() (non-destructive preview)
      if (this._preplayCam) { this.camera.restore(this._preplayCam); this._preplayCam = null; }
      this._afterAnimChange();
    }
  }
  togglePlay() { this.anim.playing ? this.stop() : this.play(); }

  setOnion(n) { this.anim.onion = clamp(n | 0, 0, 5); this._afterAnimChange(); }
  setFps(n) { this.anim.fps = clamp(n | 0, 1, 60); this._saveAnim(); this._updateAnimUI(); }
  setTint(on) { this.anim.tint = !!on; this._afterAnimChange(); }
  setLoop(on) { this.anim.loop = !!on; this._saveAnim(); this._updateAnimUI(); }
  /** Toggle Floyd–Steinberg dithering for the GIF export (smooths gradients
   *  past the 256-colour cap). Export-only metadata, persisted like fps/loop. */
  setDither(on) { this.anim.dither = !!on; this._saveAnim(); this._updateAnimUI(); return this.anim.dither; }
  /** Toggle HQ export: ON renders movies/sheets at 2× and box-downsamples (gamma-
   *  correct), erasing the diagonal-edge AA shimmer on line-heavy art at the cost
   *  of slower, slightly larger exports. Export-only, persisted like dither. */
  setHQ(on) { this.anim.hq = !!on; this._saveAnim(); this._updateAnimUI(); return this.anim.hq; }
  /** Choose the camera-glide easing curve (see EASE_MODES). Reshapes the velocity
   *  of the cinematic dive between pinned pages without moving the keyframes;
   *  persisted like fps/loop. Unknown ids fall back to 'linear'. */
  setEase(mode) {
    this.anim.ease = EASE_BY_ID.has(mode) ? mode : 'linear';
    this._saveAnim(); this._updateAnimUI();
    if (this.hasCameraPath()) this.requestRender();
    return this.anim.ease;
  }
  /** Toggle the on-canvas motion-path overlay (the cinematic flight-plan drawn in
   *  the editing view — see _motionPathRenderState). Persisted like fps/loop/ease;
   *  only repaints when a path exists (nothing to show otherwise). */
  setShowPath(on) {
    this.anim.showPath = !!on;
    this._saveAnim(); this._updateAnimUI();
    if (this.hasCameraPath()) this.requestRender();
    return this.anim.showPath;
  }

  /** Set how long a page holds (× the base 1/fps), 1..20. Per-frame timing —
   *  persisted like fps (not an undo step), repaints so the preview updates. */
  setFrameHold(f = this.anim.current, h) {
    this._ensureFlipbook();
    this._normalizeHolds();
    f = clamp(f | 0, 0, this.anim.count - 1);
    this.anim.holds[f] = clamp(h | 0 || 1, 1, 20);
    this._saveAnim();
    this._updateAnimUI();
    this.requestRender();
    this._toast(`Page ${f + 1} holds ${this.anim.holds[f]}×`);
    return this.anim.holds[f];
  }

  // ---------------- animation export (shareable artifacts) ----------------
  /** Resolve the supersample factor for an export: an explicit opts.ss wins,
   *  else HQ mode renders 2× and box-downsamples (crisp, AA-clean diagonals),
   *  and HQ-off renders 1:1 (faster, smaller GIFs). */
  _exportSS(opts = {}) {
    if (opts.ss != null) return clamp(opts.ss | 0 || 1, 1, 4);
    return this.anim.hq ? 2 : 1;
  }

  /** Encode the flipbook pages as an animated GIF (Uint8Array). Stops playback
   *  first so the export is a clean off-screen render, not a mid-flip snapshot. */
  exportGifBytes(opts = {}) {
    this.stop();
    return exportGIF(this, { ...opts, ss: this._exportSS(opts) });
  }

  /** Encode + download the flipbook as a looping .gif. */
  downloadGIF(opts = {}) {
    if (this._framesMaxUsed() < 1 && this.anim.count <= 1) {
      this._toast('Add pages to export an animation');
      return;
    }
    try {
      const bytes = this.exportGifBytes(opts);
      storage.downloadGIF(bytes);
      this._toast(`🎞 Exported GIF (${this.anim.count} frames, ${(bytes.length / 1024) | 0} KB)`);
    } catch (e) {
      console.warn('GIF export failed', e);
      this._toast('GIF export failed');
    }
  }

  /** Build the sprite-sheet (contact sheet) canvas of every page. */
  exportSpriteCanvas(opts = {}) {
    this.stop();
    return spriteSheet(this, { ...opts, ss: this._exportSS(opts) });
  }

  /** Build + download the sprite sheet as a PNG. */
  downloadSpriteSheet(opts = {}) {
    try {
      const { canvas, cols, rows } = this.exportSpriteCanvas(opts);
      storage.downloadCanvasPNG(canvas);
      this._toast(`▦ Exported sprite sheet (${cols}×${rows})`);
    } catch (e) {
      console.warn('Sprite sheet export failed', e);
      this._toast('Sprite-sheet export failed');
    }
  }

  /** Persist + refresh UI + repaint after any flipbook state change. */
  _afterAnimChange() {
    this._reconcileFrames();
    this._saveAnim();
    this._updateAnimUI();
    this._updateHud();
    this.requestRender();
  }

  _saveAnim() {
    const a = this.anim;
    try {
      localStorage.setItem('infinizoom.anim', JSON.stringify({
        on: a.on, current: a.current, count: a.count,
        onion: a.onion, fps: a.fps, tint: a.tint, loop: a.loop, holds: a.holds,
        cams: a.cams, dither: a.dither, ease: a.ease, showPath: a.showPath, hq: a.hq,
      }));
    } catch { /* ignore */ }
  }
  _restoreAnim() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem('infinizoom.anim') || 'null'); } catch { s = null; }
    if (s && typeof s === 'object') {
      this.anim.on = !!s.on;
      this.anim.onion = clamp(s.onion == null ? 1 : s.onion, 0, 5);
      this.anim.fps = clamp(s.fps == null ? 6 : s.fps, 1, 60);
      this.anim.tint = s.tint !== false;
      this.anim.loop = s.loop !== false;
      this.anim.dither = !!s.dither;
      this.anim.hq = s.hq !== false;               // default ON (crisp 2× export)
      this.anim.ease = EASE_BY_ID.has(s.ease) ? s.ease : 'linear';
      this.anim.showPath = s.showPath !== false;   // default ON (discoverability)
      this.anim.count = Math.max(1, s.count | 0);
      this.anim.current = clamp(s.current | 0, 0, this.anim.count - 1);
      if (Array.isArray(s.holds)) this.anim.holds = s.holds.map(x => clamp(x | 0 || 1, 1, 20));
      if (Array.isArray(s.cams)) this.anim.cams = s.cams.map(sanitizeCam);
    }
    this.anim.playing = false;
    this._reconcileFrames();
  }

  /** Refresh the flipbook panel to match anim state. */
  _updateAnimUI() {
    const on = this.anim.on;
    const tgl = document.getElementById('flipToggle');
    if (tgl) tgl.classList.toggle('active', on);
    const ctrls = document.getElementById('flip-controls');
    if (ctrls) ctrls.classList.toggle('hidden', !on);
    const thumbs = document.getElementById('flip-thumbs');
    if (thumbs) thumbs.classList.toggle('hidden', !on);
    document.body.classList.toggle('flip-on', on); // lifts the toast clear of the panel
    if (!on) return;
    const n = this.frameItemCount();
    const ind = document.getElementById('flipIndicator');
    if (ind) ind.textContent = `${this.anim.current + 1} / ${this.anim.count} · ${n} item${n === 1 ? '' : 's'}`;
    const scrub = document.getElementById('flipScrub');
    if (scrub && document.activeElement !== scrub) { scrub.max = String(this.anim.count - 1); scrub.value = String(this.anim.current); }
    const play = document.getElementById('flipPlay');
    if (play) {
      const playUse = play.querySelector('use');
      if (playUse) playUse.setAttribute('href', this.anim.playing ? '#ic-pause' : '#ic-play');
      play.title = this.anim.playing ? 'Pause' : 'Play';
      play.classList.toggle('active', this.anim.playing);
    }
    const cam = document.getElementById('flipCam');
    if (cam) {
      const pinned = !!this.pageCamera();
      const total = this.cameraKeyframeCount();
      cam.classList.toggle('active', pinned);
      cam.title = pinned
        ? `Camera pinned to page ${this.anim.current + 1}${total > 1 ? ` (${total} pinned — play to glide)` : ' (pin a 2nd page, then play)'} — click to re-aim, ⇧click to clear`
        : 'Pin this view as the page\'s camera — play glides between pinned pages (cinematic zoom)';
    }
    const fps = document.getElementById('flipFps'); if (fps && document.activeElement !== fps) fps.value = String(this.anim.fps);
    const hold = document.getElementById('flipHold'); if (hold && document.activeElement !== hold) hold.value = String(this._holdAt(this.anim.current));
    const onion = document.getElementById('flipOnion'); if (onion && document.activeElement !== onion) onion.value = String(this.anim.onion);
    const tint = document.getElementById('flipTint'); if (tint) tint.checked = this.anim.tint;
    const loop = document.getElementById('flipLoop'); if (loop) loop.checked = this.anim.loop;
    const dither = document.getElementById('flipDither'); if (dither) dither.checked = this.anim.dither;
    const hq = document.getElementById('flipHQ'); if (hq) hq.checked = this.anim.hq;
    // Camera-glide easing only matters once a path exists — keep it hidden until
    // then (progressive disclosure: don't show a knob with nothing to act on).
    const hasPath = this.hasCameraPath();
    const easeRow = document.getElementById('flipEaseRow');
    if (easeRow) easeRow.classList.toggle('hidden', !hasPath);
    const easeSel = document.getElementById('flipEase');
    if (easeSel && document.activeElement !== easeSel) easeSel.value = this.anim.ease;
    // Motion-path toggle — same progressive disclosure as ease (nothing to draw
    // until a path exists, so the knob stays hidden until then).
    const pathRow = document.getElementById('flipPathRow');
    if (pathRow) pathRow.classList.toggle('hidden', !hasPath);
    const pathChk = document.getElementById('flipPath');
    if (pathChk) pathChk.checked = this.anim.showPath;
    this._highlightThumb();
  }

  /** Mark the current page's thumbnail active and scroll it into view. Cheap —
   *  no re-render (just a class toggle), so it's safe to call on every nav. */
  _highlightThumb() {
    const container = document.getElementById('flip-thumbs');
    if (!container) return;
    this._updateThumbHolds();             // keep the ×N badges in sync (cheap)
    this._updateThumbCams();              // keep the 📷 keyframe badges in sync
    let active = null;
    for (const el of container.children) {
      const on = (el.dataset.frame | 0) === this.anim.current;
      el.classList.toggle('active', on);
      if (on) active = el;
    }
    if (active) {
      const left = active.offsetLeft, right = left + active.offsetWidth;
      if (left < container.scrollLeft) container.scrollLeft = left - 4;
      else if (right > container.scrollLeft + container.clientWidth) container.scrollLeft = right - container.clientWidth + 4;
    }
  }

  /**
   * Rebuild the flipbook thumbnail strip — one mini-render of every page, click
   * to jump to it. Reuses the export pipeline's renderFrames (fixed camera fit
   * to all pages, no grid/chrome) so each thumbnail previews exactly what that
   * page will export as. Skips the work entirely when nothing changed since the
   * last build (signature = page count + doc revision), so navigating pages or
   * idle HUD refreshes only re-highlight, never re-render.
   */
  _renderThumbs() {
    const container = document.getElementById('flip-thumbs');
    if (!container) return;
    if (!this.anim.on) { container.innerHTML = ''; this._thumbSig = null; return; }

    const sig = `${this.anim.count}:${this._docRev}`;
    if (sig === this._thumbSig && container.childElementCount === this.anim.count) {
      this._highlightThumb();
      return;
    }

    let pack;
    try { pack = renderFrames(this, { maxDim: 56, pad: 0.16 }); }
    catch (e) { console.warn('thumbnail render failed', e); return; }
    const { width, height, count, frames } = pack;

    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const cell = document.createElement('button');
      cell.className = 'flip-thumb';
      cell.dataset.frame = String(i);
      cell.title = `Go to page ${i + 1}`;
      const cv = document.createElement('canvas');
      cv.width = width; cv.height = height;
      cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frames[i]), width, height), 0, 0);
      const num = document.createElement('span');
      num.className = 'flip-thumb-num';
      num.textContent = String(i + 1);
      const hold = document.createElement('span'); // "×N" badge — filled in by _updateThumbHolds
      hold.className = 'flip-thumb-hold';
      // 📷 camera-keyframe badge (bottom-right) — shown when the page is pinned;
      // click it to clear that page's keyframe (the path's "remove a stop").
      const camb = document.createElement('span');
      camb.className = 'flip-thumb-cam';
      camb.textContent = '📷';
      camb.title = 'Camera pinned — click to clear';
      camb.addEventListener('pointerdown', e => e.stopPropagation()); // don't start a reorder drag
      camb.addEventListener('click', e => { e.stopPropagation(); this.clearPageCamera(i); });
      cell.appendChild(cv);
      cell.appendChild(num);
      cell.appendChild(hold);
      cell.appendChild(camb);
      cell.addEventListener('pointerdown', e => this._beginThumbDrag(e, i));
      // a real drag suppresses the click so it never also navigates
      cell.addEventListener('click', () => { if (this._suppressThumbClick) return; this.setFrame(i); });
      container.appendChild(cell);
    }
    this._thumbSig = sig;
    this._highlightThumb();
  }

  /** Refresh the per-page "×N" hold badges on the strip — text only (no canvas
   *  re-render), so it's cheap to run on every nav and on a hold edit. */
  _updateThumbHolds() {
    const container = document.getElementById('flip-thumbs');
    if (!container) return;
    for (const cell of container.children) {
      const badge = cell.querySelector('.flip-thumb-hold');
      if (!badge) continue;
      const h = this._holdAt(cell.dataset.frame | 0);
      if (h > 1) { badge.textContent = `×${h}`; badge.classList.add('on'); }
      else { badge.textContent = ''; badge.classList.remove('on'); }
    }
  }

  /** Refresh the per-page 📷 camera-keyframe badges — toggles a class, no canvas
   *  re-render, so it's cheap to run on every nav / pin / clear. */
  _updateThumbCams() {
    const container = document.getElementById('flip-thumbs');
    if (!container) return;
    this._normalizeCams();
    for (const cell of container.children) {
      const badge = cell.querySelector('.flip-thumb-cam');
      if (!badge) continue;
      badge.classList.toggle('on', !!this.anim.cams[cell.dataset.frame | 0]);
    }
  }

  /** Pointer-drag a thumbnail to reorder pages. Distinguishes a click (navigate)
   *  from a drag (reorder) by a small movement threshold; the drop slot is the
   *  gap nearest the pointer's x. Commits via the undoable moveFrame. */
  _beginThumbDrag(e, from) {
    if (e.button !== 0) return;
    const container = document.getElementById('flip-thumbs');
    if (!container) return;
    const startX = e.clientX;
    const srcCell = e.currentTarget;
    let dragging = false;
    const cells = () => [...container.querySelectorAll('.flip-thumb')];
    const clearHi = () => { for (const c of cells()) c.classList.remove('drop-before', 'drop-after'); };
    // insertion gap 0..N from the pointer's x (before the first thumb whose mid is past x)
    const gapAt = (clientX) => {
      const cs = cells();
      for (let i = 0; i < cs.length; i++) {
        const r = cs[i].getBoundingClientRect();
        if (clientX < r.left + r.width / 2) return i;
      }
      return cs.length;
    };
    const onMove = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 6) return;        // still a click
        dragging = true; srcCell.classList.add('drag-src');
      }
      clearHi();
      const g = gapAt(ev.clientX), cs = cells();
      if (g >= cs.length) { if (cs.length) cs[cs.length - 1].classList.add('drop-after'); }
      else cs[g].classList.add('drop-before');
    };
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      if (dragging) {
        const g = gapAt(ev.clientX);
        const to = g <= from ? g : g - 1;                     // gap → final page index
        this.moveFrame(from, to);
        this._suppressThumbClick = true;                      // swallow the trailing click
        setTimeout(() => { this._suppressThumbClick = false; }, 0);
      }
      clearHi();
      srcCell.classList.remove('drag-src');
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  }

  // ---------------- generators ----------------
  /** Build a procedural scene. Returns the number of items created. */
  generate(name, opts = {}, { clear = false, fit = true } = {}) {
    const fn = GENERATORS[name];
    if (!fn) { this._toast(`Unknown generator: ${name}`); return 0; }
    const specs = fn(opts);
    const items = specs.map(s => {
      this._genSeq = (this._genSeq || 0) + 1;
      return { ...s, id: `g_${this._genSeq.toString(36)}_${Math.random().toString(36).slice(2, 6)}` };
    });
    this._assignFrame(items);
    if (clear && this.scene.count()) {
      const old = this.scene.items.slice();
      const scene = this.scene;
      this.history.push({
        label: `generate ${name}`,
        do() { scene.removeMany(old.map(i => i.id)); scene.addMany(items); },
        undo() { scene.removeMany(items.map(i => i.id)); scene.addMany(old); },
      });
    } else {
      this.history.push(addItemsCmd(this.scene, items));
    }
    if (fit) this.fitAll();
    this._toast(`Generated ${name} — ${items.length} shapes`);
    return items.length;
  }

  // ---------------- doc ops ----------------
  undo() { this.history.undo(); this._updateHud(); this.requestRender(); }
  redo() { this.history.redo(); this._updateHud(); this.requestRender(); }

  clearAll() {
    if (!this.scene.count()) return;
    const items = this.scene.items.slice();
    this.history.push(removeItemsCmd(this.scene, items));
    this.selectedIds.clear();
    this._activeId = null;
    // Recoverable by design: the clear is already on the undo stack, and the
    // toast surfaces a one-tap way back so a misfire never eats the drawing.
    this._toast(`Cleared ${items.length} item${items.length === 1 ? '' : 's'}`, {
      action: { label: 'Undo', onClick: () => this.undo() },
    });
  }

  loadDoc(data) {
    const doc = data && data.doc ? data.doc : data;
    this.scene.loadJSON(doc || { items: [] });
    if (data && data.camera) this.camera.restore(data.camera);
    this.renderer.warmImages(this.scene);
    this.history.clear();
    this.selectedIds.clear();
    this._activeId = null;
    this.stop();
    this._reconcileFrames();          // page count tracks the loaded drawing
    this._updateAnimUI();
    this._updateHud();
    this.requestRender();
  }

  _restore() {
    const saved = storage.loadLocal();
    if (saved) {
      this.scene.loadJSON(saved.doc || { items: [] });
      this.camera.restore(saved.camera);
      this.renderer.warmImages(this.scene);
    }
  }

  // ---------------- pixel-art mode ----------------
  /** The sprite currently being pixel-edited, or null. */
  _pixelTarget() { return this.pixel.editing ? this.scene.byId(this.pixel.targetId) : null; }

  /** Force the renderer to rebuild a sprite's cached bitmap (in-place edits keep
   *  the same `data` reference, so we signal the change explicitly). */
  _invalidatePixel(id) { this.renderer.invalidatePixel(id); }

  /** Plot one cell into a sprite, recording the pre-edit value in `diff` (only the
   *  first time a cell is touched) so the gesture is reversible. Out-of-range cells
   *  are silently skipped — so a drag straying off the sprite paints up to the edge. */
  _pixelPlot(t, px, py, idx, diff) {
    if (px < 0 || py < 0 || px >= t.pw || py >= t.ph) return;
    const i = py * t.pw + px;
    if (!diff.has(i)) diff.set(i, t.data[i]);
    t.data[i] = idx;
  }

  /** The cells to touch for a paint at (px,py): the cell itself plus its mirror
   *  image(s) across the sprite's vertical / horizontal mid-axis when mirror
   *  painting is on. 1, 2, or 4 cells. */
  _mirrorCells(t, px, py) {
    const out = [{ px, py }];
    const m = this.pixel.mirror;
    if (m && m.x) out.push({ px: t.pw - 1 - px, py });
    if (m && m.y) out.push({ px, py: t.ph - 1 - py });
    if (m && m.x && m.y) out.push({ px: t.pw - 1 - px, py: t.ph - 1 - py });
    return out;
  }

  /** Plot a cell and all its mirror images (the interactive paint path; the
   *  test-API single-cell paint stays unmirrored + deterministic). */
  _pixelPlotM(t, px, py, idx, diff) {
    for (const c of this._mirrorCells(t, px, py)) this._pixelPlot(t, c.px, c.py, idx, diff);
  }

  /** Begin a raster-tool gesture on the active sprite at screen point `s`. */
  _pixelDown(s, e) {
    const t = this._pixelTarget(); if (!t) return;
    const w = this.toWorld(s.x, s.y);
    const tool = this.pixel.tool;
    if (tool === 'eyedropper') { this._pixelEyedrop(w); return; }
    if (tool === 'select') { this._pixelSelectDown(s, e, w, t); return; }
    if (tool === 'wand') { this._pixelWandDown(e, w, t); return; }
    const start = worldToPixel(t, w.x, w.y);
    if (!start) return; // press began outside the sprite → ignore
    const idx = (tool === 'eraser') ? TRANSPARENT : this.pixel.color;
    const diff = new Map();
    if (tool === 'fill') {
      // flood the start cell + each mirror image (mirror makes symmetric fills)
      for (const s of this._mirrorCells(t, start.px, start.py))
        for (const ch of floodFill(t, s.px, s.py, idx)) if (!diff.has(ch.i)) diff.set(ch.i, ch.before);
      this.active = { kind: 'pixel', shape: 'fill', idx, diff, target: t.id };
    } else if (tool === 'line' || tool === 'rect' || tool === 'ellipse') {
      this._pixelPlotM(t, start.px, start.py, idx, diff);
      this.active = { kind: 'pixel', shape: tool, idx, diff, start, target: t.id,
                      filled: (tool === 'rect' || tool === 'ellipse') && this.pixel.rectFill };
    } else { // pencil / eraser
      this._pixelPlotM(t, start.px, start.py, idx, diff);
      this.active = { kind: 'pixel', shape: 'paint', idx, diff, last: start, target: t.id };
    }
    this._invalidatePixel(t.id);
  }

  /** Sample the pixel under a world point → set it as the active paint colour. */
  _pixelEyedrop(w) {
    const t = this._pixelTarget(); if (!t) return;
    const m = worldToPixel(t, w.x, w.y); if (!m) return;
    const idx = getPixel(t, m.px, m.py);
    if (idx !== TRANSPARENT && idx < t.palette.length) { this.setPixelColor(idx); this._toast('Picked colour ' + idx); }
  }

  /** Commit a finished gesture's diff as ONE reversible history step. */
  _pushPixelDiff(id, diff) {
    const it = this.scene.byId(id); if (!it || !diff || !diff.size) return;
    const entries = [];
    for (const [i, before] of diff) { const after = it.data[i]; if (after !== before) entries.push({ i, before, after }); }
    if (!entries.length) return;
    const app = this;
    // already applied during the gesture → pushApplied (do() only re-runs on redo)
    this.history.pushApplied({
      label: `pixels ${entries.length}`,
      do() { const t = app.scene.byId(id); if (!t) return; for (const e of entries) t.data[e.i] = e.after; app._invalidatePixel(id); app.scene._touch(); },
      undo() { const t = app.scene.byId(id); if (!t) return; for (const e of entries) t.data[e.i] = e.before; app._invalidatePixel(id); app.scene._touch(); },
    });
    this.scene._touch(); // persist + bump docRev now
  }

  // ---- rectangular SELECT marquee ----
  // The marquee is a rectangle of cells (`this.pixel.sel = {x,y,w,h}`) you drag
  // out with the 'select' tool. Dragging INSIDE it moves the lifted block live;
  // cut/copy/paste/clear/flip/rotate act on it as ONE undoable step each, all
  // built on the pure pixel.js region ops. Selection-only changes (drawing a new
  // marquee, deselecting, moving the marquee over empty space) are NOT pushed to
  // history — like a tool/colour choice, they're transient UI state.

  /** Clamp a (possibly out-of-grid) cell to the sprite's valid cell range. */
  _clampCell(t, c) { return { px: Math.max(0, Math.min(t.pw - 1, c.px)), py: Math.max(0, Math.min(t.ph - 1, c.py)) }; }
  /** Is cell `c` inside selection rect `sel`? */
  _cellInSel(c, sel) { return c.px >= sel.x && c.px < sel.x + sel.w && c.py >= sel.y && c.py < sel.y + sel.h; }
  /** Selection rect spanning two (inclusive) cells. */
  _rectFromCells(a, b) {
    const x = Math.min(a.px, b.px), y = Math.min(a.py, b.py);
    return { x, y, w: Math.abs(a.px - b.px) + 1, h: Math.abs(a.py - b.py) + 1 };
  }
  /** Intersect a rect with the sprite grid → clamped rect, or null if disjoint. */
  _clampSelToGrid(t, r) {
    const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
    const x1 = Math.min(t.pw, r.x + r.w), y1 = Math.min(t.ph, r.y + r.h);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  /** Clamp a selection to the grid, cropping its mask to match (so the mask length
   *  always equals w*h). A masked sel that lands entirely off-grid → null; one
   *  whose surviving mask is solidly filled drops to a plain rect. Falls back to
   *  _clampSelToGrid for an unmasked (rectangular) selection. */
  _clampMaskedSel(t, sel) {
    if (!sel) return null;
    const c = this._clampSelToGrid(t, sel);
    if (!c || !sel.mask) return c;
    const ddx = c.x - sel.x, ddy = c.y - sel.y;
    const m = new Uint8Array(c.w * c.h);
    let any = false, solid = true;
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      const v = sel.mask[(ddy + y) * sel.w + (ddx + x)];
      m[y * c.w + x] = v;
      if (v) any = true; else solid = false;
    }
    if (!any) return null;
    return solid ? c : { x: c.x, y: c.y, w: c.w, h: c.h, mask: m };
  }
  _sameData(a, b) { if (a === b) return true; if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
  _sameSel(a, b) { if (!a && !b) return true; if (!a || !b) return false; return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h; }

  /** Begin a marquee gesture: drag inside an existing selection → live MOVE,
   *  else rubber-band a new rectangle. A press off the sprite clears the
   *  selection (click-to-deselect). */
  _pixelSelectDown(s, e, w, t) {
    const start = worldToPixel(t, w.x, w.y); // strict: null when off the sprite
    if (!start) { if (this.pixel.sel) { this.pixel.sel = null; this._syncPixelUI(); } this.active = null; return; }
    const sel = this.pixel.sel;
    if (sel && !e.shiftKey && this._cellInSel(start, sel)) {
      this.active = { kind: 'pixelselmove', target: t.id, before: t.data.slice(),
                      origSel: { ...sel }, startCell: start, moved: false };
    } else {
      this.active = { kind: 'pixelmarquee', target: t.id, startCell: start, moved: false };
      this.pixel.sel = this._rectFromCells(start, start);
    }
  }

  /** Magic-wand click: select the colour blob under the cursor. Plain click
   *  replaces the selection; Shift adds (union), Alt subtracts. No drag gesture —
   *  the wand acts on press; the live MOVE of a wand selection is done with the
   *  ⬚ select tool (drag inside the bbox), exactly as for a rectangle. */
  _pixelWandDown(e, w, t) {
    this.active = null; // wand is a click, not a drag — _onUp sees no gesture
    const c = worldToPixel(t, w.x, w.y);
    if (!c) return; // press off the sprite → leave the selection alone
    const mode = e.shiftKey ? 'add' : (e.altKey ? 'subtract' : 'replace');
    this.magicWandSelect(c.px, c.py, { mode }, t.id);
  }

  /** Build a wand selection at cell (px,py). `opts.contiguous` (default = the
   *  panel toggle) flood-selects the touching blob, else every cell of that
   *  colour. `opts.mode` 'replace' (default) | 'add' | 'subtract' combines with
   *  the current selection. No history — the selection is transient UI state. */
  magicWandSelect(px, py, opts = {}, id = this.pixel.targetId) {
    const it = this.scene.byId(id); if (!it || it.type !== 'pixel') return false;
    const contiguous = opts.contiguous != null ? opts.contiguous : this.pixel.wandContiguous;
    const blob = magicWandMask(it.data, it.pw, it.ph, px | 0, py | 0, { contiguous });
    const mode = opts.mode || 'replace';
    if (mode === 'replace' || !this.pixel.sel) this.pixel.sel = blob;
    else if (!blob) { /* nothing matched → leave the selection unchanged */ }
    else this.pixel.sel = combineSelections(this.pixel.sel, blob, it.pw, it.ph, mode);
    this._syncPixelUI(); this.requestRender();
    return !!this.pixel.sel;
  }

  /** Invert the current selection across the whole sprite (select everything NOT
   *  selected). A full selection inverts to nothing. No history (transient). */
  invertPixelSelection(id = this.pixel.targetId) {
    const it = this.scene.byId(id); if (!it || it.type !== 'pixel') return false;
    this.pixel.sel = invertSelectionMask(this.pixel.sel, it.pw, it.ph);
    this._syncPixelUI(); this.requestRender();
    return true;
  }

  /** Pointer-up after a marquee drag: a pure click (never left its start cell)
   *  deselects; any drag keeps the rubber-banded rect. No history step (selection
   *  is transient UI state). */
  _commitPixelMarquee(a) {
    if (!a.moved) this.pixel.sel = null;
    this._syncPixelUI();
  }

  /** Pointer-up after a live move: commit the data change as ONE reversible step
   *  (full-array snapshot, like flip/resize). A move that changed nothing (empty
   *  region, or dragged back to origin) updates only the marquee, no history. */
  _commitPixelSelMove(a) {
    const t = this.scene.byId(a.target); if (!t) return;
    const before = a.before, after = t.data;
    if (this._sameData(before, after)) { this._syncPixelUI(); return; }
    const finalSel = this.pixel.sel ? { ...this.pixel.sel } : null;
    this._pushPixelRegionStep(t.id, before, after, { ...a.origSel }, finalSel, 'move selection', true);
  }

  /** Sprite + current selection for a region op, or null if either is missing. */
  _selCtx(id = this.pixel.targetId) {
    const it = this.scene.byId(id);
    if (!it || it.type !== 'pixel' || !this.pixel.sel) return null;
    return { it, sel: this.pixel.sel };
  }

  /** Push a reversible "swap the whole data buffer (and the marquee rect)" step.
   *  `after` may already be live on the item (alreadyApplied) — as it is for a
   *  live move — else we apply it here. Both data and selection are restored on
   *  undo so the marquee tracks its block. */
  _pushPixelRegionStep(id, before, after, beforeSel, afterSel, label, alreadyApplied = false) {
    const app = this;
    if (!alreadyApplied) {
      const it = this.scene.byId(id); if (!it) return;
      it.data = after;
      this.pixel.sel = afterSel ? { ...afterSel } : null;
      this._invalidatePixel(id);
    }
    this.history.pushApplied({
      label,
      do() { const t = app.scene.byId(id); if (!t) return; t.data = after; app.pixel.sel = afterSel ? { ...afterSel } : null; app._invalidatePixel(id); app.scene._touch(); app._syncPixelUI(); },
      undo() { const t = app.scene.byId(id); if (!t) return; t.data = before; app.pixel.sel = beforeSel ? { ...beforeSel } : null; app._invalidatePixel(id); app.scene._touch(); app._syncPixelUI(); },
    });
    this.scene._touch();
    this._syncPixelUI();
    this.requestRender();
  }

  /** Set the marquee to an explicit rect (clamped to the grid), or clear it with
   *  null. Returns false when the rect lies entirely off the sprite. */
  setPixelSelection(rect, id = this.pixel.targetId) {
    const it = this.scene.byId(id);
    if (!it || it.type !== 'pixel') return false;
    if (!rect) { this.pixel.sel = null; this._syncPixelUI(); this.requestRender(); return true; }
    const s = this._clampSelToGrid(it, { x: rect.x | 0, y: rect.y | 0, w: Math.max(1, rect.w | 0), h: Math.max(1, rect.h | 0) });
    this.pixel.sel = s;
    this._syncPixelUI(); this.requestRender();
    return !!s;
  }
  getPixelSelection() {
    const s = this.pixel.sel;
    if (!s) return null;
    const out = { x: s.x, y: s.y, w: s.w, h: s.h };
    if (s.mask) out.mask = Array.from(s.mask); // plain array → JSON-safe for tests
    return out;
  }

  /** Select the whole sprite (no history — selection is transient). */
  selectAllPixels(id = this.pixel.targetId) {
    const it = this.scene.byId(id); if (!it || it.type !== 'pixel') return false;
    this.pixel.sel = { x: 0, y: 0, w: it.pw, h: it.ph };
    this._syncPixelUI(); this.requestRender();
    return true;
  }
  /** Drop the marquee (no history). */
  deselectPixels() { if (!this.pixel.sel) return false; this.pixel.sel = null; this._syncPixelUI(); this.requestRender(); return true; }

  /** Erase the selected cells to TRANSPARENT (the marquee stays). One step. */
  clearPixelSelection(id = this.pixel.targetId) {
    const ctx = this._selCtx(id); if (!ctx) return false;
    const { it, sel } = ctx;
    const before = it.data;
    const after = before.slice();
    fillRegion(after, it.pw, it.ph, sel.x, sel.y, sel.w, sel.h, TRANSPARENT, sel.mask);
    if (this._sameData(before, after)) return false; // already empty
    this._pushPixelRegionStep(it.id, before, after, { ...sel }, { ...sel }, 'clear selection');
    return true;
  }

  /** Copy the selected block to the internal pixel clipboard (NOT undoable — it
   *  changes no sprite data, and survives cut→undo so the buffer isn't lost). */
  copyPixelSelection(id = this.pixel.targetId) {
    const ctx = this._selCtx(id); if (!ctx) return false;
    const { it, sel } = ctx;
    // a masked (wand) copy lifts only the selected cells — holes stay TRANSPARENT,
    // so a later (composite) paste lets the art beneath show through the shape.
    this.pixel.clip = { pw: sel.w, ph: sel.h, data: extractRegion(it.data, it.pw, it.ph, sel.x, sel.y, sel.w, sel.h, sel.mask) };
    return true;
  }

  /** Cut = copy to clipboard + clear the region (the clear is the undoable step;
   *  the clipboard is untouched by undo). */
  cutPixelSelection(id = this.pixel.targetId) {
    const ctx = this._selCtx(id); if (!ctx) return false;
    this.copyPixelSelection(id);
    this.clearPixelSelection(id); // no-op (no step) if the region was already empty
    return true;
  }

  /**
   * Stamp the clipboard onto the sprite. Anchors at an explicit `{x,y}` cell, else
   * the current marquee's top-left, else (0,0). Composites by default (transparent
   * clipboard cells let the art beneath show through) — pass `{composite:false}`
   * for a flat replace. One reversible step; the marquee becomes the pasted region
   * so you can immediately drag it. Returns false when the clipboard is empty.
   */
  pastePixelSelection(opts = {}, id = this.pixel.targetId) {
    if (typeof opts === 'string') { id = opts; opts = {}; } // pastePixelSelection(id)
    const it = this.scene.byId(id); if (!it || it.type !== 'pixel') return false;
    const clip = this.pixel.clip; if (!clip) return false;
    const ax = opts.x != null ? (opts.x | 0) : (this.pixel.sel ? this.pixel.sel.x : 0);
    const ay = opts.y != null ? (opts.y | 0) : (this.pixel.sel ? this.pixel.sel.y : 0);
    const before = it.data;
    const after = before.slice();
    blitRegion(after, it.pw, it.ph, clip.data, clip.pw, clip.ph, ax, ay, { composite: opts.composite !== false });
    const beforeSel = this.pixel.sel ? { ...this.pixel.sel } : null;
    const afterSel = this._clampSelToGrid(it, { x: ax, y: ay, w: clip.pw, h: clip.ph });
    this._pushPixelRegionStep(it.id, before, after, beforeSel, afterSel, 'paste');
    return true;
  }

  /** Move the selected block by (dx,dy) cells (composite, lift-before-clear). One
   *  step when pixels actually change; a move over empty space just slides the
   *  marquee (no history). */
  movePixelSelection(dx, dy, id = this.pixel.targetId) {
    const ctx = this._selCtx(id); if (!ctx) return false;
    const { it, sel } = ctx;
    dx |= 0; dy |= 0;
    if (!dx && !dy) return false;
    const before = it.data;
    const after = moveRegion(before, it.pw, it.ph, sel, dx, dy);
    const afterSel = this._clampMaskedSel(it, { x: sel.x + dx, y: sel.y + dy, w: sel.w, h: sel.h, mask: sel.mask });
    if (this._sameData(before, after)) { this.pixel.sel = afterSel; this._syncPixelUI(); this.requestRender(); return true; }
    this._pushPixelRegionStep(it.id, before, after, { ...sel }, afterSel, 'move selection');
    return true;
  }

  /** Flip the selected block in place (axis 'h'/'v'). The marquee — and a wand
   *  mask — mirrors with it. One step. */
  flipPixelSelection(axis = 'h', id = this.pixel.targetId) {
    const ctx = this._selCtx(id); if (!ctx) return false;
    const { it, sel } = ctx;
    axis = axis === 'v' ? 'v' : 'h';
    const before = it.data;
    const after = flipRegion(before, it.pw, it.ph, sel, axis);
    if (this._sameData(before, after)) return false; // 1-wide/1-tall or empty
    const afterSel = sel.mask
      ? { x: sel.x, y: sel.y, w: sel.w, h: sel.h, mask: flipData(sel.mask, sel.w, sel.h, axis) }
      : { ...sel };
    this._pushPixelRegionStep(it.id, before, after, { ...sel }, afterSel, `flip selection ${axis}`);
    return true;
  }

  /** Rotate the selected block 90° (dir 'cw'/'ccw'), spinning about its centre;
   *  a non-square selection's w/h swap. The marquee — and a wand mask — rotates
   *  with it. One step. */
  rotatePixelSelection(dir = 'cw', id = this.pixel.targetId) {
    const ctx = this._selCtx(id); if (!ctx) return false;
    const { it, sel } = ctx;
    dir = dir === 'ccw' ? 'ccw' : 'cw';
    const before = it.data;
    const r = rotateRegion(before, it.pw, it.ph, sel, dir);
    const rotMask = sel.mask ? rotateData90(sel.mask, sel.w, sel.h, dir).data : null;
    const afterSel = this._clampMaskedSel(it, rotMask ? { ...r.sel, mask: rotMask } : r.sel);
    if (this._sameData(before, r.data) && this._sameSel(sel, afterSel)) return false;
    this._pushPixelRegionStep(it.id, before, r.data, { ...sel }, afterSel, `rotate selection ${dir}`);
    return true;
  }

  /** Create a fresh pixel sprite centred in the view and enter edit mode. */
  newPixelSprite(opts = {}) {
    const pw = clampDim(opts.pw ?? this.pixel.pw);
    const ph = clampDim(opts.ph ?? this.pixel.ph);
    const cell = (opts.cell ?? this.pixel.cell) > 0 ? (opts.cell ?? this.pixel.cell) : DEFAULT_CELL;
    const paletteName = opts.paletteName ?? this.pixel.paletteName;
    const c = this.camera.screenToWorld(this.camera.width / 2, this.camera.height / 2);
    const x = (opts.x ?? c.x) - (pw * cell) / 2;
    const y = (opts.y ?? c.y) - (ph * cell) / 2;
    const it = makePixel(x, y, pw, ph, { cell, paletteName });
    this._assignFrame([it]);
    this.history.push(addItemsCmd(this.scene, [it]));
    this.pixel.pw = pw; this.pixel.ph = ph; this.pixel.cell = cell; this.pixel.paletteName = paletteName;
    if (this.pixel.color >= it.palette.length) this.pixel.color = 0;
    this._savePixel();
    this.editPixel(it.id);
    return it.id;
  }

  /** Enter pixel-edit mode on a sprite. Returns false for a non-pixel id. */
  editPixel(id) {
    const it = this.scene.byId(id);
    if (!it || it.type !== 'pixel') return false;
    this.commitText();
    this.pixel.editing = true;
    this.pixel.targetId = id;
    this.pixel.sel = null; // a fresh edit starts with no marquee
    if (this.pixel.color >= it.palette.length || this.pixel.color < 0) this.pixel.color = 0;
    // sensible exit state: the sprite stays selected under the 'select' tool, but
    // presses are intercepted for painting (set tool directly to avoid setTool's
    // endPixelEdit). The yellow overlay frames the sprite.
    this.tool = 'select';
    document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === 'select'));
    this.selectedIds = new Set([id]); this._activeId = id; this.pivot = null; this.draft = null;
    this.canvas.className = ''; this.canvas.classList.add('tool-pixel');
    document.body.classList.add('pixel-editing');
    this._openPixelPanel(true);
    this._syncPixelUI();
    this._updateHud();
    this.requestRender();
    return true;
  }

  /** Leave pixel-edit mode (keeps the panel open so you can make another sprite). */
  endPixelEdit() {
    if (!this.pixel.editing) return;
    this.pixel.editing = false;
    this.pixel.targetId = null;
    this.pixel.sel = null;
    document.body.classList.remove('pixel-editing');
    this.canvas.classList.remove('tool-pixel');
    this._syncPixelUI();
    this.requestRender();
  }

  setPixelTool(name) {
    this.pixel.tool = name;
    // Contextual disclosure: picking the marquee/wand reveals the Selection
    // section (its verbs are otherwise collapsed), mirroring the style panel's
    // symmetry auto-open. Cheap, no-op if the section isn't present.
    if (name === 'select' || name === 'wand') this._revealSection('sect-px-select');
    this._savePixel();
    this._syncPixelUI();
  }
  setPixelColor(idx) {
    this.pixel.color = idx | 0;
    this._savePixel();
    this._syncPixelUI();
  }
  setRectFill(on) { this.pixel.rectFill = !!on; this._savePixel(); this._syncPixelUI(); }

  /** Toggle mirror/symmetry painting on the 'x' (vertical axis) or 'y'
   *  (horizontal axis) — every plotted cell is reflected across the sprite's
   *  mid-axis so you paint symmetric halves at once. */
  setPixelMirror(axis, on) {
    if (axis !== 'x' && axis !== 'y') return;
    this.pixel.mirror[axis] = !!on;
    this._savePixel();
    this._syncPixelUI();
    this.requestRender(); // the overlay axis guide appears/disappears
  }
  getPixelMirror() { return { x: !!this.pixel.mirror.x, y: !!this.pixel.mirror.y }; }

  /** Default palette for NEW sprites (existing sprites keep their own palette). */
  setPixelPalette(name) {
    if (!PIXEL_PALETTES[name]) return;
    this.pixel.paletteName = name;
    if (this.pixel.color >= PIXEL_PALETTES[name].length) this.pixel.color = 0;
    this._savePixel();
    this._syncPixelUI();
  }

  /** When ON, image→sprite convert derives the palette from the image itself
   *  (median-cut) instead of the named preset. */
  setPixelFromImage(on) { this.pixel.fromImage = !!on; this._savePixel(); this._syncPixelUI(); }
  /** Number of palette slots median-cut extracts when converting from an image. */
  setPixelColors(n) { this.pixel.colors = clampColors(n); this._savePixel(); this._syncPixelUI(); }

  /** Redefine the active palette slot's colour on the edited sprite (undoable;
   *  recolours every pixel using that index since the model is indexed-colour). */
  setPixelSlotColor(hex) {
    const t = this._pixelTarget(); if (!t) return;
    const idx = this.pixel.color;
    if (idx < 0 || idx >= t.palette.length) return;
    if (t.palette[idx] === hex) return;
    const id = t.id, app = this;
    const before = t.palette.slice();
    const after = t.palette.slice(); after[idx] = hex;
    this.history.push({
      label: 'palette',
      do() { const it = app.scene.byId(id); if (it) { it.palette = after; app._invalidatePixel(id); app.scene._touch(); } },
      undo() { const it = app.scene.byId(id); if (it) { it.palette = before; app._invalidatePixel(id); app.scene._touch(); } },
    });
    this._syncPixelUI();
  }

  /**
   * REMAP every pixel of palette index `from` to index `to` across the edited
   * sprite (or an explicit id) — the classic "merge / palette-swap" recolour.
   * Unlike setPixelSlotColor (which REDEFINES a slot's hex, leaving indices put),
   * this MOVES pixels between slots, freeing `from`. The vacated slot is left in
   * the palette on purpose (gemma: don't surprise-delete it). `to` may be
   * TRANSPARENT (erase that colour) and `from` may be TRANSPARENT (fill empties).
   * ONE reversible step storing just the changed flat indices (compact — not a
   * per-pixel before/after diff). Returns the changed-cell count.
   */
  remapPixelColor(from, to, id = this.pixel.targetId) {
    const it = this.scene.byId(id);
    if (!it || it.type !== 'pixel') return 0;
    from |= 0; to |= 0;
    if (from === to) return 0;
    const idxs = remapIndex(it.data, from, to); // applies the change now
    if (!idxs.length) return 0;
    this._invalidatePixel(id);
    const app = this;
    // already applied → pushApplied (do() re-runs only on redo; idempotent here)
    this.history.pushApplied({
      label: `replace ${from}→${to} (${idxs.length})`,
      do() { const t = app.scene.byId(id); if (!t) return; for (const i of idxs) t.data[i] = to; app._invalidatePixel(id); app.scene._touch(); },
      undo() { const t = app.scene.byId(id); if (!t) return; for (const i of idxs) t.data[i] = from; app._invalidatePixel(id); app.scene._touch(); },
    });
    this.scene._touch();
    this._syncPixelUI();
    return idxs.length;
  }

  /**
   * SWAP palette indices `a` and `b` everywhere on the edited sprite (or an
   * explicit id) — every `a` becomes `b` and vice-versa (a true exchange, both
   * slots kept). ONE reversible step storing the two changed-index sets. Returns
   * the total changed-cell count.
   */
  swapPixelColor(a, b, id = this.pixel.targetId) {
    const it = this.scene.byId(id);
    if (!it || it.type !== 'pixel') return 0;
    a |= 0; b |= 0;
    if (a === b) return 0;
    const { aIdx, bIdx } = swapIndex(it.data, a, b); // applies the change now
    if (!aIdx.length && !bIdx.length) return 0;
    this._invalidatePixel(id);
    const app = this;
    this.history.pushApplied({
      label: `swap ${a}↔${b} (${aIdx.length + bIdx.length})`,
      do() { const t = app.scene.byId(id); if (!t) return; for (const i of aIdx) t.data[i] = b; for (const i of bIdx) t.data[i] = a; app._invalidatePixel(id); app.scene._touch(); },
      undo() { const t = app.scene.byId(id); if (!t) return; for (const i of aIdx) t.data[i] = a; for (const i of bIdx) t.data[i] = b; app._invalidatePixel(id); app.scene._touch(); },
    });
    this.scene._touch();
    this._syncPixelUI();
    return aIdx.length + bIdx.length;
  }

  /**
   * Mirror the edited sprite (or `id`) left↔right ('h') or top↔bottom ('v') — a
   * one-shot WHOLE-sprite flip (a standard pixel-artist op). Palette + dimensions
   * are untouched; only `data` is rewritten. ONE reversible step (flip is its own
   * inverse, but we store before/after explicitly — nearly every cell moves, so a
   * compact index-list diff wouldn't help; the full-array snapshot matches the
   * resize step's precedent). Returns false on a no-op (a 1-wide h-flip / 1-tall
   * v-flip changes nothing).
   */
  flipPixel(axis = 'h', id = this.pixel.targetId) {
    const it = this.scene.byId(id); if (!it || it.type !== 'pixel') return false;
    axis = axis === 'v' ? 'v' : 'h';
    if ((axis === 'h' && it.pw < 2) || (axis === 'v' && it.ph < 2)) return false;
    const before = it.data;
    const after = flipData(it.data, it.pw, it.ph, axis);
    const scene = this.scene, app = this;
    this.history.push({
      label: `flip ${axis}`,
      do() { const t = scene.byId(id); if (!t) return; t.data = after; app._invalidatePixel(id); scene._touch(); },
      undo() { const t = scene.byId(id); if (!t) return; t.data = before; app._invalidatePixel(id); scene._touch(); },
    });
    this.pixel.sel = null; // whole-sprite flip moves content out from under the marquee
    this._syncPixelUI(); this.requestRender();
    return true;
  }

  /**
   * Rotate the edited sprite (or `id`) 90° — `dir` 'cw' / 'ccw'. The grid
   * dimensions SWAP (pw↔ph); the world box swaps w↔h too, pinned about its CENTRE
   * so the sprite spins IN PLACE and the cells stay square. The sprite's world
   * rotation (`rot`) is a separate placement concern and is left untouched — this
   * rotates the CONTENT. ONE reversible step. Returns false on a no-op (1×1).
   */
  rotatePixel90(dir = 'cw', id = this.pixel.targetId) {
    const it = this.scene.byId(id); if (!it || it.type !== 'pixel') return false;
    dir = dir === 'ccw' ? 'ccw' : 'cw';
    if (it.pw < 2 && it.ph < 2) return false; // 1×1 — nothing to rotate
    const before = { data: it.data, pw: it.pw, ph: it.ph, w: it.w, h: it.h, x: it.x, y: it.y };
    const rot = rotateData90(it.data, it.pw, it.ph, dir);
    // swap the world footprint, keeping the box CENTRE fixed (spin in place)
    const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    const nw = it.h, nh = it.w;
    const after = { data: rot.data, pw: rot.pw, ph: rot.ph, w: nw, h: nh, x: cx - nw / 2, y: cy - nh / 2 };
    const scene = this.scene, app = this;
    this.history.push({
      label: `rotate ${dir}`,
      do() { const t = scene.byId(id); if (!t) return; Object.assign(t, after); app._invalidatePixel(id); scene._touch(); },
      undo() { const t = scene.byId(id); if (!t) return; Object.assign(t, before); app._invalidatePixel(id); scene._touch(); },
    });
    this.pixel.sel = null; // dims swap → cell-coords marquee no longer valid
    this._syncPixelUI(); this.requestRender();
    return true;
  }

  /** Read the current "replace with" target index from the panel select (falls
   *  back to TRANSPARENT if the control isn't present). */
  _pxReplaceTarget() {
    const sel = document.getElementById('pxReplaceTo');
    return sel && sel.value !== '' ? (sel.value | 0) : TRANSPARENT;
  }

  /**
   * Convert an `image` item (explicit id, else the single selected image) into an
   * editable indexed pixel SPRITE that occupies the SAME world box — the headline
   * "turn a picture into pixel art" move. The source bitmap is drawn to an
   * offscreen canvas (capped + smoothing-downscaled so getImageData stays bounded
   * and pre-averaged) then quantizeImage box-averages it to the sprite grid and
   * snaps each cell to the chosen palette (perceptual match, alpha preserved).
   * ONE reversible step (adds the sprite in the image's z-slot, removes the
   * image). Returns the new sprite id, or null.
   */
  convertImageToSprite(id, opts = {}) {
    // ergonomic: allow convertImageToSprite(opts) — an options object as the first
    // arg (no explicit id; the selected image is used). Guards the common call
    // convertImageToSprite({ fromImage, colors, size, paletteName }).
    if (id && typeof id === 'object') { opts = id; id = opts.id ?? null; }
    let img = id ? this.scene.byId(id) : null;
    if (!img && this.selectedIds.size === 1) img = this.scene.byId([...this.selectedIds][0]);
    if (!img || img.type !== 'image' || !img.src) { this._toast('Select one image to convert'); return null; }
    const entry = this.renderer._image(img.src);
    if (!entry || !entry.loaded || !entry.img.naturalWidth) { this._toast('Image still loading — try again'); return null; }
    const natW = entry.img.naturalWidth, natH = entry.img.naturalHeight;
    // target resolution: longest side = `size` (default = new-sprite W), aspect-kept
    const size = clampDim(opts.size ?? this.pixel.pw ?? 48);
    let pw, ph;
    if (natW >= natH) { pw = size; ph = clampDim(Math.round(size * natH / natW)); }
    else { ph = size; pw = clampDim(Math.round(size * natW / natH)); }
    // cap the source so a huge image can't make a giant getImageData buffer
    const cap = 512;
    let sw = natW, sh = natH;
    if (Math.max(sw, sh) > cap) { const k = cap / Math.max(sw, sh); sw = Math.max(1, Math.round(sw * k)); sh = Math.max(1, Math.round(sh * k)); }
    const cv = document.createElement('canvas'); cv.width = sw; cv.height = sh;
    const cx = cv.getContext('2d');
    cx.imageSmoothingEnabled = true;
    try { cx.drawImage(entry.img, 0, 0, sw, sh); } catch { this._toast('Cannot draw image'); return null; }
    let src;
    try { src = cx.getImageData(0, 0, sw, sh).data; }
    catch { this._toast('Cannot read image pixels (cross-origin?)'); return null; }
    // Palette: derive it FROM the image (median-cut) when requested — the headline
    // batch-19 move that makes this a general pixel-art engine, not just a PICO-8
    // converter — else snap to the chosen named preset.
    const fromImage = opts.fromImage ?? this.pixel.fromImage;
    let palette, paletteName = null;
    if (fromImage) {
      const colors = clampColors(opts.colors ?? this.pixel.colors);
      palette = buildPaletteFromImage(src, sw, sh, colors, { alphaThreshold: opts.alphaThreshold });
    } else {
      paletteName = opts.paletteName ?? this.pixel.paletteName;
      palette = (PIXEL_PALETTES[paletteName] || PIXEL_PALETTES[DEFAULT_PALETTE]);
    }
    const data = quantizeImage(src, sw, sh, pw, ph, palette, { alphaThreshold: opts.alphaThreshold });
    // sprite occupies the image's exact world box (non-square cells are fine —
    // the pixel pipeline computes cw/ch per axis everywhere)
    const sprite = makePixel(img.x, img.y, pw, ph, { palette: palette.slice() });
    sprite.w = img.w; sprite.h = img.h; sprite.data = data;
    if (img.rot) sprite.rot = img.rot;
    if (img.opacity != null) sprite.opacity = img.opacity;
    if (img.frame != null) sprite.frame = img.frame;
    if (img.parent != null) sprite.parent = img.parent;
    const scene = this.scene;
    const imgIndex = scene.items.indexOf(img);
    this.history.push({
      label: 'image→sprite',
      do() {
        scene.removeMany([img.id]);
        const at = Math.min(imgIndex, scene.items.length);
        scene.items.splice(at, 0, sprite); scene._index.set(sprite.id, sprite); scene._touch();
      },
      undo() {
        scene.removeMany([sprite.id]);
        const at = Math.min(imgIndex, scene.items.length);
        scene.items.splice(at, 0, img); scene._index.set(img.id, img); scene._touch();
      },
    });
    this.selectedIds = new Set([sprite.id]); this._activeId = sprite.id;
    this.pixel.pw = pw; this.pixel.ph = ph;
    if (paletteName) this.pixel.paletteName = paletteName; // image-derived has no preset name
    this._savePixel();
    this.editPixel(sprite.id);
    this._toast(fromImage ? `Converted to ${pw}×${ph} · ${palette.length}-colour palette`
                          : `Converted to ${pw}×${ph} sprite`);
    return sprite.id;
  }

  /**
   * Resize the edited sprite (or `id`) to npw×nph. `mode`:
   *   'scale' — change the RESOLUTION, art resampled to fill the SAME world box
   *             (cells get bigger/smaller);
   *   'crop'  — change the CANVAS, pixels stay 1:1 and the world footprint
   *             grows/shrinks (crops or TRANSPARENT-extends, top-left anchored).
   * ONE reversible step. Returns false on a no-op.
   */
  resizePixel(npw, nph, mode = 'scale', id = this.pixel.targetId) {
    const it = this.scene.byId(id); if (!it || it.type !== 'pixel') return false;
    npw = clampDim(npw); nph = clampDim(nph);
    if (npw === it.pw && nph === it.ph) return false;
    const before = { pw: it.pw, ph: it.ph, data: it.data, w: it.w, h: it.h };
    const newData = resizePixelData(it.data, it.pw, it.ph, npw, nph, mode);
    let after;
    if (mode === 'crop') {
      const cw = it.w / it.pw, ch = it.h / it.ph; // keep cell size → footprint changes
      after = { pw: npw, ph: nph, data: newData, w: npw * cw, h: nph * ch };
    } else { // scale: same world box, new resolution
      after = { pw: npw, ph: nph, data: newData, w: it.w, h: it.h };
    }
    const scene = this.scene, app = this;
    this.history.push({
      label: 'resize sprite',
      do() { const t = scene.byId(id); if (!t) return; Object.assign(t, after); app._invalidatePixel(id); scene._touch(); },
      undo() { const t = scene.byId(id); if (!t) return; Object.assign(t, before); app._invalidatePixel(id); scene._touch(); },
    });
    this.pixel.sel = null; // dimensions change → marquee no longer valid
    this._syncPixelUI();
    this.requestRender();
    return true;
  }

  /** Render a sprite to a native (or `scale`×) PNG canvas (nearest-neighbour). */
  exportPixelCanvas(id = this.pixel.targetId, scale = 1) {
    const it = this.scene.byId(id);
    if (!it || it.type !== 'pixel') return null;
    scale = Math.max(1, Math.round(scale));
    const src = document.createElement('canvas');
    src.width = it.pw; src.height = it.ph;
    const sc = src.getContext('2d');
    const img = sc.createImageData(it.pw, it.ph);
    img.data.set(pixelRGBA(it));
    sc.putImageData(img, 0, 0);
    if (scale === 1) return src;
    const out = document.createElement('canvas');
    out.width = it.pw * scale; out.height = it.ph * scale;
    const oc = out.getContext('2d');
    oc.imageSmoothingEnabled = false;
    oc.drawImage(src, 0, 0, out.width, out.height);
    return out;
  }
  downloadPixelPNG(id = this.pixel.targetId, scale = 8) {
    const cv = this.exportPixelCanvas(id, scale);
    if (cv) { storage.downloadCanvasPNG(cv, 'sprite.png'); this._toast('Exported sprite PNG'); }
  }

  /** Paint one cell on a sprite as a standalone undoable step (no pointer needed
   *  — used by the test API and could back a future scripting hook). */
  _apiPaintPixel(id, px, py, idx) {
    const it = this.scene.byId(id); if (!it || it.type !== 'pixel') return false;
    const diff = new Map();
    this._pixelPlot(it, px, py, idx, diff);
    this._invalidatePixel(id);
    this._pushPixelDiff(id, diff);
    return diff.size > 0;
  }
  /** Flood fill on a sprite as a standalone undoable step. */
  _apiFillPixel(id, px, py, idx) {
    const it = this.scene.byId(id); if (!it || it.type !== 'pixel') return false;
    const diff = new Map();
    for (const ch of floodFill(it, px, py, idx)) if (!diff.has(ch.i)) diff.set(ch.i, ch.before);
    this._invalidatePixel(id);
    this._pushPixelDiff(id, diff);
    return diff.size > 0;
  }

  /** Test/inspection helpers. */
  pixelData(id) { const it = this.scene.byId(id); return it && it.type === 'pixel' ? it.data.slice() : null; }
  pixelAt(id, px, py) { const it = this.scene.byId(id); return it && it.type === 'pixel' ? getPixel(it, px, py) : null; }
  pixelInfo(id) {
    const it = this.scene.byId(id);
    if (!it || it.type !== 'pixel') return null;
    return { pw: it.pw, ph: it.ph, palette: it.palette.slice(), cell: it.w / it.pw };
  }

  // ---- pixel UI ----
  _loadPixel() {
    try {
      const raw = localStorage.getItem('infinizoom.pixel');
      if (!raw) return;
      const p = JSON.parse(raw);
      const keep = ['tool', 'color', 'rectFill', 'pw', 'ph', 'cell', 'paletteName'];
      for (const k of keep) if (p[k] !== undefined) this.pixel[k] = p[k];
      if (p.mirror) this.pixel.mirror = { x: !!p.mirror.x, y: !!p.mirror.y };
      if (p.fromImage !== undefined) this.pixel.fromImage = !!p.fromImage;
      if (p.colors !== undefined) this.pixel.colors = clampColors(p.colors);
      if (p.wandContiguous !== undefined) this.pixel.wandContiguous = !!p.wandContiguous;
      if (!PIXEL_PALETTES[this.pixel.paletteName]) this.pixel.paletteName = DEFAULT_PALETTE;
    } catch { /* ignore */ }
  }
  _savePixel() {
    try {
      const { tool, color, rectFill, pw, ph, cell, paletteName, mirror, fromImage, colors, wandContiguous } = this.pixel;
      localStorage.setItem('infinizoom.pixel', JSON.stringify({ tool, color, rectFill, pw, ph, cell, paletteName, mirror, fromImage, colors, wandContiguous }));
    } catch { /* ignore */ }
  }
  /** The ONE state-writer for pixel mode. `this.pixel.panelOpen` is the single
   *  source of truth (NOT the DOM `.hidden` class); the panel, the body flag and
   *  the toolbar button's pressed-state are all pure downstream reflections of it,
   *  exactly like _syncSymmetryUI does for symmetry. (§2.8.) */
  _openPixelPanel(on) {
    on = !!on;
    this.pixel.panelOpen = on;
    const panel = document.getElementById('pixel-panel');
    if (panel) panel.classList.toggle('hidden', !on);
    // the pixel panel overlays the style panel; hide the latter so it doesn't
    // bleed through below the (shorter) pixel panel
    document.body.classList.toggle('pixel-panel-open', on);
    const btn = document.getElementById('pixelToggleTop');
    if (btn) { btn.classList.toggle('active', on); btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  }
  togglePixelPanel(force) {
    const panel = document.getElementById('pixel-panel');
    if (!panel) return;
    // read the state field, not the DOM — one source of truth
    const open = force == null ? !this.pixel.panelOpen : !!force;
    this._openPixelPanel(open);
    // opening with a single pixel sprite selected → jump straight into editing it
    if (open && !this.pixel.editing && this.selectedIds.size === 1) {
      const it = this.scene.byId([...this.selectedIds][0]);
      if (it && it.type === 'pixel') this.editPixel(it.id);
    }
    if (!open && this.pixel.editing) this.endPixelEdit();
  }
  _bindPixelUI() {
    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    on('pixelToggleTop', 'click', () => this.togglePixelPanel());
    on('pixelDone', 'click', () => { this.endPixelEdit(); this._openPixelPanel(false); });
    on('pxNew', 'click', () => {
      const pw = clampDim(document.getElementById('pxW').value);
      const ph = clampDim(document.getElementById('pxH').value);
      const cell = Math.max(1, Number(document.getElementById('pxCell').value) || DEFAULT_CELL);
      const paletteName = document.getElementById('pxPalette').value;
      this.newPixelSprite({ pw, ph, cell, paletteName });
      this._toast(`New ${pw}×${ph} sprite — paint away`);
    });
    on('pxConvert', 'click', () => this.convertImageToSprite());
    on('pxPalette', 'change', e => this.setPixelPalette(e.target.value));
    on('pxFromImage', 'change', e => this.setPixelFromImage(e.target.checked));
    on('pxColors', 'change', e => this.setPixelColors(e.target.value));
    on('pxRectFill', 'change', e => this.setRectFill(e.target.checked));
    on('pxMirrorX', 'click', () => this.setPixelMirror('x', !this.pixel.mirror.x));
    on('pxMirrorY', 'click', () => this.setPixelMirror('y', !this.pixel.mirror.y));
    on('pxResize', 'click', () => {
      const w = clampDim(document.getElementById('pxResizeW').value);
      const h = clampDim(document.getElementById('pxResizeH').value);
      const mode = document.getElementById('pxResizeMode').value;
      if (this.resizePixel(w, h, mode)) this._toast(`Resized to ${w}×${h}`);
    });
    on('pxSlot', 'input', e => this.setPixelSlotColor(e.target.value));
    on('pxReplace', 'click', () => {
      const n = this.remapPixelColor(this.pixel.color, this._pxReplaceTarget());
      this._toast(n ? `Replaced ${n} cell${n === 1 ? '' : 's'}` : 'No pixels of that colour');
    });
    on('pxSwap', 'click', () => {
      const n = this.swapPixelColor(this.pixel.color, this._pxReplaceTarget());
      this._toast(n ? `Swapped ${n} cell${n === 1 ? '' : 's'}` : 'Nothing to swap');
    });
    on('pxFlipH', 'click', () => { if (this.flipPixel('h')) this._toast('Flipped horizontally'); });
    on('pxFlipV', 'click', () => { if (this.flipPixel('v')) this._toast('Flipped vertically'); });
    on('pxRotCCW', 'click', () => { if (this.rotatePixel90('ccw')) this._toast('Rotated 90° ↺'); });
    on('pxRotCW', 'click', () => { if (this.rotatePixel90('cw')) this._toast('Rotated 90° ↻'); });
    // rectangular SELECT marquee actions (picking ⬚ switches to the select tool)
    on('pxSelAll', 'click', () => { this.setPixelTool('select'); this.selectAllPixels(); });
    on('pxSelNone', 'click', () => this.deselectPixels());
    on('pxSelInvert', 'click', () => { this.invertPixelSelection(); this._toast(this.pixel.sel ? 'Inverted selection' : 'Nothing left'); });
    on('pxWandContiguous', 'change', e => { this.pixel.wandContiguous = !!e.target.checked; this._savePixel(); });
    on('pxSelClear', 'click', () => { this._toast(this.clearPixelSelection() ? 'Cleared selection' : 'No selection'); });
    on('pxSelCut', 'click', () => { this._toast(this.cutPixelSelection() ? 'Cut selection' : 'No selection'); });
    on('pxSelCopy', 'click', () => { this._toast(this.copyPixelSelection() ? 'Copied selection' : 'No selection'); });
    on('pxSelPaste', 'click', () => { this._toast(this.pastePixelSelection() ? 'Pasted' : 'Clipboard empty'); });
    on('pxSelFlipH', 'click', () => { this._toast(this.flipPixelSelection('h') ? 'Flipped selection' : 'No selection'); });
    on('pxSelFlipV', 'click', () => { this._toast(this.flipPixelSelection('v') ? 'Flipped selection' : 'No selection'); });
    on('pxSelRotCCW', 'click', () => { this._toast(this.rotatePixelSelection('ccw') ? 'Rotated selection ↺' : 'No selection'); });
    on('pxSelRotCW', 'click', () => { this._toast(this.rotatePixelSelection('cw') ? 'Rotated selection ↻' : 'No selection'); });
    on('pxExport', 'click', () => {
      const scale = Math.max(1, Math.round(Number(document.getElementById('pxScale').value) || 8));
      this.downloadPixelPNG(this.pixel.targetId, scale);
    });
    document.querySelectorAll('#pixel-panel [data-pxtool]').forEach(b =>
      b.addEventListener('click', () => this.setPixelTool(b.dataset.pxtool)));
    // keep new-sprite default inputs in the model as you tweak them
    on('pxW', 'change', e => { this.pixel.pw = clampDim(e.target.value); this._savePixel(); });
    on('pxH', 'change', e => { this.pixel.ph = clampDim(e.target.value); this._savePixel(); });
    on('pxCell', 'change', e => { this.pixel.cell = Math.max(1, Number(e.target.value) || DEFAULT_CELL); this._savePixel(); });
  }
  /** The palette the swatch grid + slot editor reflect: the edited sprite's own
   *  palette, or the new-sprite default when nothing is being edited. */
  _activePalette() {
    const t = this._pixelTarget();
    return t ? t.palette : (PIXEL_PALETTES[this.pixel.paletteName] || PIXEL_PALETTES[DEFAULT_PALETTE]);
  }
  _syncPixelUI() {
    // new-sprite default inputs
    const setVal = (id, v) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = v; };
    setVal('pxW', this.pixel.pw); setVal('pxH', this.pixel.ph); setVal('pxCell', this.pixel.cell);
    const palSel = document.getElementById('pxPalette'); if (palSel) palSel.value = this.pixel.paletteName;
    const rf = document.getElementById('pxRectFill'); if (rf) rf.checked = this.pixel.rectFill;
    const wc = document.getElementById('pxWandContiguous'); if (wc) wc.checked = !!this.pixel.wandContiguous;
    // image→sprite palette source: checkbox + colour-count; the preset dropdown is
    // greyed while "from image" is active, the colour-count enabled only then.
    const fi = document.getElementById('pxFromImage'); if (fi) fi.checked = !!this.pixel.fromImage;
    setVal('pxColors', this.pixel.colors);
    if (palSel) palSel.disabled = !!this.pixel.fromImage;
    const pxColors = document.getElementById('pxColors'); if (pxColors) pxColors.disabled = !this.pixel.fromImage;
    // mirror toggles
    const mx = document.getElementById('pxMirrorX');
    if (mx) { mx.classList.toggle('active', !!this.pixel.mirror.x); mx.setAttribute('aria-pressed', this.pixel.mirror.x ? 'true' : 'false'); }
    const my = document.getElementById('pxMirrorY');
    if (my) { my.classList.toggle('active', !!this.pixel.mirror.y); my.setAttribute('aria-pressed', this.pixel.mirror.y ? 'true' : 'false'); }
    // resize inputs reflect the edited sprite's current dimensions
    const t = this._pixelTarget();
    if (t) { setVal('pxResizeW', t.pw); setVal('pxResizeH', t.ph); }
    // active tool highlight
    document.querySelectorAll('#pixel-panel [data-pxtool]').forEach(b =>
      b.classList.toggle('active', b.dataset.pxtool === this.pixel.tool));
    // palette swatches
    const pal = this._activePalette();
    if (this.pixel.color >= pal.length) this.pixel.color = 0;
    const wrap = document.getElementById('pxSwatches');
    if (wrap) {
      wrap.innerHTML = '';
      pal.forEach((c, i) => {
        const b = document.createElement('button');
        b.className = 'px-swatch' + (i === this.pixel.color ? ' active' : '');
        b.style.background = c;
        b.title = `${i}: ${c}`;
        b.dataset.idx = i;
        b.onclick = () => this.setPixelColor(i);
        wrap.appendChild(b);
      });
    }
    const slot = document.getElementById('pxSlot');
    if (slot && document.activeElement !== slot) {
      const c = pal[this.pixel.color];
      if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) slot.value = c;
    }
    // "replace with" target select: every palette colour + Transparent. Rebuilt
    // off the active palette (skip while focused so an open dropdown isn't yanked).
    const repl = document.getElementById('pxReplaceTo');
    if (repl && document.activeElement !== repl) {
      const prev = repl.value;
      repl.innerHTML = '';
      pal.forEach((c, i) => {
        const o = document.createElement('option');
        o.value = i; o.textContent = `${i}: ${c}`;
        repl.appendChild(o);
      });
      const tr = document.createElement('option');
      tr.value = TRANSPARENT; tr.textContent = 'Transparent';
      repl.appendChild(tr);
      // keep the prior choice if it's still a valid option, else default to the
      // next palette slot after the active one (a sensible non-identity target)
      const valid = [...repl.options].some(o => o.value === prev);
      repl.value = valid && prev !== '' ? prev : String(pal.length > 1 ? (this.pixel.color + 1) % pal.length : TRANSPARENT);
    }
    // selection actions: greyed unless a marquee exists (Paste needs a clipboard) —
    // an at-a-glance onramp to what's currently possible
    const hasSel = !!this.pixel.sel, hasClip = !!this.pixel.clip;
    const setDis = (id, dis) => { const el = document.getElementById(id); if (el) el.disabled = dis; };
    for (const id of ['pxSelNone', 'pxSelInvert', 'pxSelClear', 'pxSelCut', 'pxSelCopy', 'pxSelFlipH', 'pxSelFlipV', 'pxSelRotCCW', 'pxSelRotCW'])
      setDis(id, !hasSel);
    setDis('pxSelPaste', !hasClip);
  }

  // ---------------- render loop ----------------
  requestRender() { this._dirty = true; }
  render() {
    const t0 = performance.now();
    this._maybeRebase();      // floating-origin: keep the camera near (0,0) at deep zoom
    this.resolveConnectors(); // keep connector endpoints glued to their items
    const gk = this.active && this.active.kind;
    // while editing a sprite, the yellow pixel overlay frames it — suppress the
    // vector selection box + transform handles so they don't invite false grabs.
    const pxEdit = this._pixelTarget();
    this.renderer.render(this.scene, {
      pixelEdit: pxEdit,
      pixelMirror: pxEdit ? this.pixel.mirror : null,
      pixelSel: pxEdit ? this.pixel.sel : null,
      draft: this.draft, selectedIds: pxEdit ? new Set() : this.selectedIds, activeId: this._activeId,
      // mandala/wallpaper: live-tiled draft + the on-canvas anchor, spoke & lattice guides
      symDrafts: this._symmetryDrafts(),
      symmetry: this._symmetryRenderState(),
      marquee: this.marquee, eraserCursor: this.eraserCursor,
      // smart-guide lines while dragging or resizing (world coords; projected by the renderer)
      guides: (gk === 'move' || gk === 'scale') ? this.activeGuides : null,
      rotHandle: (pxEdit || gk === 'rotate') ? null : this._rotHandleScreen(),
      // hide the corner handles mid-transform so they don't clutter the gesture
      scaleHandles: (pxEdit || gk === 'scale' || gk === 'rotate' || gk === 'marquee') ? null : this._scaleHandlesScreen(),
      // transform pivot marker (shown during rotate/scale so you see what you spin about)
      pivot: (pxEdit || gk === 'marquee') ? null : this._pivotScreen(),
      // spin-tool placement preview (pivot crosshair + swept-angle arc)
      refGuide: this._refGuide,
      // flipbook: which page is live + onion-skin reach (no onion during playback)
      frame: this.anim.on ? { current: this.anim.current,
                              onion: this.anim.playing ? 0 : this.anim.onion,
                              tint: this.anim.tint } : null,
      // cinematic camera flight-plan made visible in the editing view (composition aid)
      motionPath: this._motionPathRenderState(),
    });
    this.minimap.render();
    this._stats.lastRenderMs = performance.now() - t0;
    this._stats.lastDrawn = this.renderer.lastDrawn || 0;
    this._stats.lastSplat = this.renderer.lastSplat || 0;   // items collapsed to a dot by screen-space LOD
    this._stats.frames++;
  }
  _startLoop() {
    const loop = () => {
      if (this._dirty) { this._dirty = false; this.render(); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---------------- HUD ----------------
  _updateHud() {
    document.getElementById('hud-zoom').textContent = formatZoom(this.camera.scale);
    // Show TRUE world coords (live + floating origin) so the readout doesn't jump
    // when a deep-zoom rebase slides the live coordinate system. origin is (0,0)
    // in normal use, so this is identical to the raw coords there.
    const ox = this.scene.origin.x, oy = this.scene.origin.y;
    document.getElementById('hud-coord').textContent =
      `${formatCoord(this.mouseWorld.x + ox)}, ${formatCoord(this.mouseWorld.y + oy)}`;
    const n = this.scene.count();
    const sel = this.selectedIds.size;
    document.getElementById('hud-count').textContent =
      sel ? `${sel}/${n} selected` : `${n} item${n === 1 ? '' : 's'}`;
    document.getElementById('hud-tool').textContent = this.tool;
    const rotEl = document.getElementById('hud-rot');
    if (rotEl) {
      const deg = Math.round(this.camera.rot * 180 / Math.PI);
      if (deg === 0) { rotEl.hidden = true; }
      else { rotEl.hidden = false; rotEl.textContent = `${deg}°`; }
    }
    this._updateHint();
    this._syncSelectionUI();                          // contextual selection inspector
    if (this._scheduleLayers) this._scheduleLayers(); // refresh Objects list (debounced)
    if (this.anim.on) this._updateAnimUI();           // keep the page item-count live
    if (this.anim.on && this._scheduleThumbs) this._scheduleThumbs(); // refresh thumbnail strip (debounced)
  }
  _updateUndoRedo() {
    document.getElementById('undo').disabled = !this.history.canUndo();
    document.getElementById('redo').disabled = !this.history.canRedo();
  }

  // A passive status line, OR — when `opts.action` is given — a recovery surface:
  // the toast becomes interactive and carries a prominent inline button (e.g.
  // "Undo" after a destructive action). That turns the §2.7 "scary destructive
  // action" into something instantly reversible without a modal.
  _toast(msg, opts = {}) {
    const t = document.getElementById('toast');
    const { action = null, duration = action ? 5000 : 1800 } = opts;
    t.textContent = '';
    const span = document.createElement('span');
    span.className = 'toast-text';
    span.textContent = msg;
    t.appendChild(span);
    t.classList.toggle('has-action', !!action);
    if (action) {
      const btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.onclick = () => {
        clearTimeout(this._toastT);
        t.classList.remove('show', 'has-action');
        try { action.onClick(); } catch { /* ignore */ }
      };
      t.appendChild(btn);
    }
    t.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('show', 'has-action'), duration);
  }

  // ---------------- focus mode (recess) ----------------
  // One toggle that makes ALL chrome recede so only the canvas is left — the
  // §1.1 fix the redesign kept deferring. Reached by Tab, the ⛶ HUD chip, the
  // palette, or by clicking the lone exit chip; left by Tab / Esc / that chip.
  setFocus(on, { silent = false } = {}) {
    on = !!on;
    if (on === !!this.focusMode) return this.focusMode;
    this.focusMode = on;
    document.body.classList.toggle('focus-mode', on);
    const exit = document.getElementById('focus-exit');
    if (exit) exit.setAttribute('aria-hidden', on ? 'false' : 'true');
    const chip = document.getElementById('hud-focus');
    if (chip) chip.classList.toggle('active', on);
    try { localStorage.setItem('infinizoom.focusMode', on ? '1' : '0'); } catch { /* ignore */ }
    if (!silent) this._toast(on ? 'Focus mode — panels hidden · Tab or Esc to exit' : 'Focus mode off');
    return this.focusMode;
  }
  toggleFocus(force) { return this.setFocus(force === undefined ? !this.focusMode : !!force); }

  // ---------------- First-run coachmark (onboarding, §1.3 / C5) ----------------
  // The §1.3 "easy onramps for newcomers" fix: a one-time, NON-BLOCKING welcome
  // that points at the three onramps (draw / command palette / zoom-pan). It is
  // pointer-events:none, so the user dismisses it simply by starting to use the
  // app — action = consent, no "Got it" button to break flow. Anchored just above
  // the HUD so it reads as a label for the real ⌘K chip below (gemma's "spatial
  // bridge"), not a splash screen. Shown only on a genuine first run; re-summon
  // any time from the palette ("Getting started…").
  _initCoachmark() {
    const el = document.getElementById('coachmark');
    if (!el) return;
    const k = document.getElementById('coach-cmdkey');     // platform-correct label, mirrors the HUD chip
    if (k) k.textContent = this._isMac ? '⌘K' : 'Ctrl K';
    let seen = false;
    try { seen = localStorage.getItem('infinizoom.coachSeen') === '1'; } catch { /* ignore */ }
    if (seen) return;                                       // stays .hidden — never shown again
    this.showCoach();
  }

  /** Show the coachmark and arm its self-dismissal (also the palette re-summon). */
  showCoach() {
    const el = document.getElementById('coachmark');
    if (!el) return;
    el.classList.remove('hidden');
    el.setAttribute('aria-hidden', 'false');
    this._coachAbort?.abort();
    this._coachAbort = new AbortController();
    const sig = this._coachAbort.signal;
    const off = () => this._dismissCoach();
    // Defer one frame: animate in AND arm the dismissal listeners only after the
    // (re)summon event has finished dispatching, so the very click / Enter that
    // opened it can't instantly close it again.
    requestAnimationFrame(() => {
      el.classList.add('show');
      window.addEventListener('pointerdown', off, { capture: true, signal: sig });
      window.addEventListener('keydown', off, { capture: true, signal: sig });
      window.addEventListener('wheel', off, { capture: true, passive: true, signal: sig });
    });
    // Safety auto-fade for a user who only reads it and never touches anything.
    clearTimeout(this._coachT);
    this._coachT = setTimeout(off, 14000);
  }

  _dismissCoach() {
    const el = document.getElementById('coachmark');
    this._coachAbort?.abort(); this._coachAbort = null;
    clearTimeout(this._coachT); this._coachT = null;
    try { localStorage.setItem('infinizoom.coachSeen', '1'); } catch { /* ignore */ }
    if (!el || el.classList.contains('hidden')) return;
    el.classList.remove('show');
    el.setAttribute('aria-hidden', 'true');
    setTimeout(() => el.classList.add('hidden'), 450);     // hide after the fade — leave no inert overlay
  }

  // ---------------- Transparency: command palette + contextual hint ----------------
  // One registry (commands.js) → two visibility surfaces. The palette is the
  // GLOBAL onramp (search any action, learn its shortcut); the hint line is the
  // LOCAL one (what does this tool / these modifiers do right now).
  _bindPalette() {
    this._isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
    this.commands = buildCommands(this);
    this._cmdById = new Map(this.commands.map(c => [c.id, c]));
    this._paletteOpen = false;
    this._paletteSel = -1;
    this._paletteRows = [];                 // visible rows in display order
    this._mods = { shift: false, alt: false, meta: false, space: false };

    const cmdBtn = document.getElementById('hud-cmd');
    if (cmdBtn) { cmdBtn.textContent = this._isMac ? '⌘K' : 'Ctrl K'; cmdBtn.onclick = () => this.togglePalette(); }

    const input = document.getElementById('palette-input');
    if (input) {
      input.addEventListener('input', () => this._paletteFilter(input.value));
      input.addEventListener('keydown', e => this._paletteKey(e));
    }
    const overlay = document.getElementById('palette');
    if (overlay) overlay.addEventListener('pointerdown', e => { if (e.target === overlay) this.closePalette(); });

    // Track modifier state for the reactive hint line (cheap; only re-renders the
    // hint when a tracked modifier actually changes, so key auto-repeat is free).
    const track = (e, spaceDown) => {
      const m = this._mods;
      const sig = `${m.shift}${m.alt}${m.meta}${m.space}`;
      m.shift = e.shiftKey; m.alt = e.altKey; m.meta = e.metaKey || e.ctrlKey;
      if (e.code === 'Space') m.space = spaceDown;
      if (`${m.shift}${m.alt}${m.meta}${m.space}` !== sig) this._updateHint();
    };
    window.addEventListener('keydown', e => track(e, true), true);
    window.addEventListener('keyup', e => track(e, false), true);
    window.addEventListener('blur', () => { this._mods = { shift: false, alt: false, meta: false, space: false }; this._updateHint(); });
  }

  _typingInField() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }
  _fmtKeys(keys) {
    return (keys || []).map(k => (k === 'Mod' ? (this._isMac ? '⌘' : 'Ctrl') : k));
  }

  openPalette() {
    if (this._paletteOpen) return;
    const overlay = document.getElementById('palette');
    const input = document.getElementById('palette-input');
    if (!overlay || !input) return;
    this._paletteOpen = true;
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    input.value = '';
    this._paletteFilter('');
    input.focus();
  }
  closePalette() {
    if (!this._paletteOpen) return;
    this._paletteOpen = false;
    const overlay = document.getElementById('palette');
    const input = document.getElementById('palette-input');
    if (overlay) { overlay.classList.add('hidden'); overlay.setAttribute('aria-hidden', 'true'); }
    if (input) input.blur();
  }
  togglePalette() { this._paletteOpen ? this.closePalette() : this.openPalette(); }

  // subsequence (fuzzy) match: every query char appears in order within `hay`
  _fuzzy(hay, q) {
    let i = 0;
    for (let j = 0; j < hay.length && i < q.length; j++) if (hay[j] === q[i]) i++;
    return i === q.length;
  }
  _cmdScore(c, query) {
    if (!query) return 1;
    const title = c.title.toLowerCase();
    const hay = (title + ' ' + c.cat + ' ' + (c.keywords || '')).toLowerCase();
    if (title.startsWith(query)) return 100;
    if (title.includes(query)) return 70;
    if (hay.includes(query)) return 45;
    if (this._fuzzy(title, query)) return 30;
    if (this._fuzzy(hay, query)) return 15;
    return 0;
  }
  _paletteFilter(q) {
    const query = (q || '').trim().toLowerCase();
    const avail = this.commands.filter(c => !c.when || c.when(this));
    if (!query) { this._renderPalette(avail, true); return; }
    const scored = [];
    for (const c of avail) { const s = this._cmdScore(c, query); if (s > 0) scored.push({ c, s }); }
    scored.sort((a, b) => b.s - a.s);
    this._renderPalette(scored.map(x => x.c), false);
  }

  _renderPalette(cmds, grouped) {
    const list = document.getElementById('palette-list');
    const empty = document.getElementById('palette-empty');
    if (!list) return;
    list.textContent = '';
    this._paletteRows = [];
    if (!cmds.length) { if (empty) empty.classList.remove('hidden'); return; }
    if (empty) empty.classList.add('hidden');

    const addRow = (c) => {
      const enabled = !c.enabled || c.enabled(this);
      const idx = this._paletteRows.length;
      const row = document.createElement('div');
      row.className = 'pal-row' + (enabled ? '' : ' disabled');
      row.setAttribute('role', 'option');
      row.id = 'pal-' + c.id;
      row.dataset.id = c.id;
      const ic = document.createElement('span'); ic.className = 'pal-icon'; ic.textContent = c.icon || '·'; row.appendChild(ic);
      const ti = document.createElement('span'); ti.className = 'pal-title'; ti.textContent = c.title; row.appendChild(ti);
      const ks = document.createElement('span'); ks.className = 'pal-keys';
      for (const k of this._fmtKeys(c.keys)) { const e = document.createElement('span'); e.className = 'pal-key'; e.textContent = k; ks.appendChild(e); }
      row.appendChild(ks);
      row.addEventListener('pointerenter', () => this._paletteSelect(idx));
      row.addEventListener('click', () => { if (enabled) this._paletteRun(c); });
      list.appendChild(row);
      this._paletteRows.push({ cmd: c, enabled, el: row });
    };

    if (grouped) {
      let lastCat = null;
      for (const c of cmds) {
        if (c.cat !== lastCat) { const h = document.createElement('div'); h.className = 'pal-cat'; h.textContent = c.cat; list.appendChild(h); lastCat = c.cat; }
        addRow(c);
      }
    } else {
      for (const c of cmds) addRow(c);
    }
    this._paletteSel = -1;
    this._paletteSelect(this._firstEnabledRow());
  }

  _firstEnabledRow() {
    for (let i = 0; i < this._paletteRows.length; i++) if (this._paletteRows[i].enabled) return i;
    return this._paletteRows.length ? 0 : -1;
  }
  _paletteSelect(idx) {
    if (idx < 0 || idx >= this._paletteRows.length) return;
    const prev = this._paletteRows[this._paletteSel];
    if (prev) prev.el.setAttribute('aria-selected', 'false');
    this._paletteSel = idx;
    const row = this._paletteRows[idx];
    row.el.setAttribute('aria-selected', 'true');
    row.el.scrollIntoView({ block: 'nearest' });
    const input = document.getElementById('palette-input');
    if (input) input.setAttribute('aria-activedescendant', row.el.id);
  }
  _paletteMove(dir) {
    if (!this._paletteRows.length) return;
    let i = this._paletteSel;
    for (let n = 0; n < this._paletteRows.length; n++) {
      i = (i + dir + this._paletteRows.length) % this._paletteRows.length;
      if (this._paletteRows[i].enabled) { this._paletteSelect(i); return; }
    }
  }
  _paletteKey(e) {
    e.stopPropagation();
    // the open palette owns the keyboard — handle its own close chord here, since
    // stopPropagation keeps the window-level ⌘/Ctrl+K from ever seeing this.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); this.closePalette(); return; }
    if (e.key === 'Escape') { e.preventDefault(); this.closePalette(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); this._paletteMove(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); this._paletteMove(-1); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = this._paletteRows[this._paletteSel];
      if (row && row.enabled) this._paletteRun(row.cmd);
      return;
    }
  }
  _paletteRun(c) {
    this.closePalette();
    try { c.run(this); } catch (err) { console.error('command failed:', c.id, err); }
    // search-to-learn: echo the shortcut they could have pressed next time.
    const keys = this._fmtKeys(c.keys);
    this._toast(keys.length ? `${c.title}  ·  ${keys.join(' ')}` : c.title);
  }

  /** Rebuild the contextual hint line from the current tool/selection/modifiers. */
  _updateHint() {
    const el = document.getElementById('hud-hint');
    if (!el) return;
    const h = contextHint(this, this._mods);
    el.textContent = '';
    const base = document.createElement('span'); base.className = 'hint-base'; base.textContent = h.base; el.appendChild(base);
    for (const m of h.mods) {
      const span = document.createElement('span');
      span.className = 'hint-mod' + (m.active ? ' active' : '');
      const kbd = document.createElement('kbd'); kbd.textContent = m.key; span.appendChild(kbd);
      span.appendChild(document.createTextNode(' ' + m.label));
      el.appendChild(span);
    }
    this._lastHint = h;
  }

  // ---------------- test API ----------------
  _installTestApi() {
    window.app = this;
    window.__INFINIZOOM__ = {
      version: 2,
      ready: true,
      setTool: n => this.setTool(n),
      getTool: () => this.tool,
      setStyle: s => this.setStyle(s),
      getStyle: () => this.getStyle(),
      itemCount: () => this.scene.count(),
      getItems: () => JSON.parse(JSON.stringify(this.scene.items)),
      selectedCount: () => this.selectedIds.size,
      undo: () => this.undo(),
      redo: () => this.redo(),
      canUndo: () => this.history.canUndo(),
      canRedo: () => this.history.canRedo(),
      undoDepth: () => this.history.undoStack.length,
      clear: () => this.clearAll(),
      selectAll: () => this.selectAll(),
      deselectAll: () => this.deselectAll(),
      deleteSelection: () => this.deleteSelection(),
      copy: () => this.copySelection(),
      cut: () => this.cutSelection(),
      paste: () => this.paste(),
      duplicate: () => this.duplicateSelection(),
      clipboardCount: () => (this.clipboard || []).length,
      getCamera: () => this.camera.serialize(),
      setCamera: c => { this.camera.restore(c); this._updateHud(); this.requestRender(); },
      // Floating-origin rebasing introspection (extreme zoom).
      origin: () => ({ x: this.scene.origin.x, y: this.scene.origin.y }),
      rebaseCount: () => this._rebaseCount || 0,
      maybeRebase: () => this._maybeRebase(),
      // Set scale directly, BYPASSING camera.maxScale, anchored at a screen point —
      // for deep-zoom tests that need to drive past the interactive clamp.
      setScaleRaw: (s, sx, sy) => {
        const cam = this.camera;
        const ax = sx == null ? cam.width / 2 : sx, ay = sy == null ? cam.height / 2 : sy;
        const before = cam.screenToWorld(ax, ay);
        cam.scale = s;
        const after = cam.screenToWorld(ax, ay);
        cam.x += before.x - after.x; cam.y += before.y - after.y;
        this._updateHud(); this.requestRender();
      },
      zoomBy: (f, sx, sy) => { this.camera.zoomBy(f, sx, sy); this._updateHud(); this.requestRender(); },
      rotateBy: (rad, sx, sy) => { this.camera.rotateBy(rad, sx, sy); this._updateHud(); this.requestRender(); },
      rotateCanvas: (rad, sx, sy) => this.rotateCanvas(rad, sx, sy),
      resetRotation: () => this.resetRotation(),
      resetView: () => this.resetView(),
      fitAll: () => this.fitAll(),
      worldToScreen: (x, y) => this.camera.worldToScreen(x, y),
      screenToWorld: (x, y) => this.camera.screenToWorld(x, y),
      bounds: () => this.scene.bounds(),
      toJSON: () => this.scene.toJSON(),
      toSVG: opts => { this.resolveConnectors(); return sceneToSVG(this.scene, opts); },
      loadJSON: d => this.loadDoc(d),
      stats: () => ({ ...this._stats }),
      drawnCount: () => { this.render(); return this.renderer.lastDrawn || 0; },
      // helpers that build geometry directly (world coords). They land on the
      // active flipbook page (when flipbook is on) just like interactive drawing.
      // drawing-tool adders honour mandala mode (off by default → unchanged); the
      // returned id is the identity copy, valid whether or not symmetry expanded.
      addStroke: (points, style) => {
        const it = makeStroke(points, { ...this.drawStyle, ...style });
        return this._commitDrawn([it])[0].id;
      },
      addRect: (x, y, w, h, style) => {
        const it = makeRect(x, y, w, h, { ...this.drawStyle, ...style });
        return this._commitDrawn([it])[0].id;
      },
      addEllipse: (x, y, w, h, style) => {
        const it = makeEllipse(x, y, w, h, { ...this.drawStyle, ...style });
        return this._commitDrawn([it])[0].id;
      },
      addText: (x, y, text, style) => {
        const it = makeText(x, y, text, { ...this.drawStyle, ...style });
        this._assignFrame([it]); this.history.push(addItemsCmd(this.scene, [it])); return it.id;
      },
      addArrow: (a, b, style) => {
        const it = makeArrow(a, b, { ...this.drawStyle, ...style });
        return this._commitDrawn([it])[0].id;
      },
      addPolygon: (x, y, w, h, style) => {
        const it = makePolygon(x, y, w, h, { ...this.drawStyle, ...style });
        this._assignFrame([it]); this.history.push(addItemsCmd(this.scene, [it])); return it.id;
      },
      addImage: (x, y, w, h, src, opts) => this.addImageItem(x, y, w, h, src, opts || {}),
      // brush / tapered strokes — points may be [{x,y,p}] or [[x,y,p]] (p optional)
      addBrushStroke: (points, style = {}) => {
        const pts = (points || []).map(p => Array.isArray(p)
          ? { x: p[0], y: p[1], p: p[2] == null ? 1 : p[2] }
          : { x: p.x, y: p.y, ...(p.p == null ? {} : { p: p.p }) });
        const it = makeStroke(pts, { ...this.drawStyle, ...style });
        it.taper = true;
        if (style.smooth !== false) it.smooth = true; // brush strokes smooth by default
        this._assignFrame([it]);
        this.history.push(addItemsCmd(this.scene, [it]));
        return it.id;
      },
      smoothPoints: (points, segs) => catmullRom(points, segs == null ? 12 : segs),
      placeImage: (src, sx, sy) => this.placeImageDataURL(src, { x: sx ?? this.camera.width / 2, y: sy ?? this.camera.height / 2 }),
      imagesPending: () => this.imagesPending(),
      generate: (name, opts, flags) => this.generate(name, opts, flags),
      generators: () => Object.keys(GENERATORS),
      curveOrderMeta: () => curveOrderMeta(),
      // z-order
      bringToFront: () => this.bringToFront(),
      sendToBack: () => this.sendToBack(),
      raise: () => this.raiseSelection(),
      lower: () => this.lowerSelection(),
      order: () => this.scene.items.map(i => i.id),
      // level of detail
      setLOD: mode => this.setSelectionLOD(mode),
      visibleCount: () => this.visibleCount(),
      // screen-space LOD (the batched-dot optimization for huge fit-all scenes)
      setSceneLOD: on => { this.renderer.sceneLOD = !!on; this.requestRender(); },
      sceneLODEnabled: () => this.renderer.sceneLOD,
      splatCount: () => { this.render(); return this.renderer.lastSplat || 0; },
      // rotation
      rotateSelection: (ang, pivot) => this.rotateSelection(ang, pivot),
      rotHandle: () => this._rotHandleScreen(),
      scaleSelection: (factor, pivot) => this.scaleSelection(factor, pivot),
      scaleHandles: () => this._scaleHandlesScreen(),
      nudgeSelection: (dx, dy) => this.nudgeSelection(dx, dy),
      // align / distribute / smart guides + snapping
      alignSelection: mode => this.alignSelection(mode),
      distributeSelection: axis => this.distributeSelection(axis),
      setGuides: on => this.setGuides(on),
      guidesEnabled: () => this.guides.on,
      setSnap: on => this.setSnap(on),
      snapEnabled: () => this.snap,
      activeGuides: () => (this.activeGuides || []).map(g => ({ ...g })),
      // snap a hypothetical moving bbox against the CURRENT scene (excluding the
      // selection) — returns {dx,dy,guides}. Lets tests assert the snap engine
      // deterministically without driving a pointer drag.
      snapInfo: bbox => {
        const ex = new Set(this._transformClosure(this.selectedIds));
        return this._snapBBox(bbox, this._buildSnapCands(ex), null);
      },
      // custom transform pivot
      setPivot: (x, y) => this.setPivot(x, y),
      clearPivot: () => this.clearPivot(),
      togglePivot: () => this.togglePivot(),
      getPivot: () => { const p = this._pivotWorld(); return p ? { x: p.x, y: p.y, custom: !!this.pivot, com: this.comPivot } : null; },
      pivotScreen: () => this._pivotScreen(),
      setComPivot: (on) => this.setComPivot(on),
      getComPivot: () => this.comPivot,
      centerOfMass: () => this._selectionCenterOfMass(),
      bboxCenter: () => this._selectionWorldCenter(),
      // grouping
      group: () => this.groupSelection(),
      ungroup: () => this.ungroupSelection(),
      groupOf: id => { const it = this.scene.byId(id); return it ? (it.group || null) : null; },
      // parenting / hierarchy
      parent: () => this.parentSelection(),
      unparent: () => this.unparentSelection(),
      reparentItem: (childId, newParentId = null) => this.reparentItem(childId, newParentId),
      parentOf: id => { const it = this.scene.byId(id); return it ? (it.parent ?? null) : null; },
      childrenOf: id => this.scene.childrenOf(id).map(i => i.id),
      descendantsOf: id => [...this.scene.descendantsOf(id)],
      setActive: id => { this._activeId = id; this.requestRender(); },
      activeId: () => this._activeId,
      // lock / hide (layer flags)
      setLocked: (ids, on) => this.setLocked(ids, on),
      setHidden: (ids, on) => this.setHidden(ids, on),
      lockSelection: () => this.toggleLockSelection(),
      hideSelection: () => this.toggleHideSelection(),
      showAll: () => this.showAll(),
      unlockAll: () => this.unlockAll(),
      isLocked: id => !!this.scene.byId(id)?.locked,
      isHidden: id => !!this.scene.byId(id)?.hidden,
      lockedCount: () => this.lockedCount(),
      hiddenCount: () => this.hiddenCount(),
      renderLayers: () => this._renderLayers(),
      collapseLayers: (on) => this.toggleLayersPanel(on === undefined ? undefined : !!on),
      layersCollapsed: () => this._layersCollapsed(),
      // ---- named layers ----
      layers: () => this.scene.layers.map(L => ({ ...L })),
      layerCount: () => this.scene.layers.length,
      activeLayer: () => this.scene.activeLayerId,
      layerOf: id => { const it = this.scene.byId(id); return it ? (it.layerId || this.scene.layers[0].id) : null; },
      itemsInLayer: lid => this.scene.itemsInLayer(lid).map(i => i.id),
      addLayer: name => this.addLayer(name),
      removeLayer: id => this.removeLayer(id),
      moveLayer: (id, dir) => this.moveLayer(id, dir),
      setActiveLayer: id => this.setActiveLayer(id),
      renameLayer: (id, name) => this.renameLayer(id, name),
      assignToLayer: (ids, lid) => { if (this.scene.layerById(lid)) this._layerStructureOp('assign layer', () => this.scene.assignToLayer(ids, lid)); },
      assignSelectionToLayer: lid => this.assignSelectionToLayer(lid),
      setLayerHidden: (id, on) => this.setLayerHidden(id, on),
      setLayerLocked: (id, on) => this.setLayerLocked(id, on),
      setLayerOpacity: (id, v) => this.setLayerOpacity(id, v),
      setLayerBlend: (id, v) => this.setLayerBlend(id, v),
      layerHidden: id => { const L = this.scene.layerById(id); return !!(L && L.hidden); },
      layerLocked: id => { const L = this.scene.layerById(id); return !!(L && L.locked); },
      isItemHidden: id => { const it = this.scene.byId(id); return it ? this.scene.isItemHidden(it) : false; },
      isItemLocked: id => { const it = this.scene.byId(id); return it ? this.scene.isItemLocked(it) : false; },
      collapseBookmarks: (on) => this.toggleBookmarkPanel(on === undefined ? undefined : !!on),
      bookmarksCollapsed: () => this._bookmarksCollapsed(),
      // mobile / compact drawer system
      isCompact: () => this.isCompact(),
      openDrawer: (name) => this.openDrawer(name),
      toggleDrawer: (name) => this.toggleDrawer(name),
      closeDrawers: () => this.closeDrawers(),
      currentDrawer: () => this.currentDrawer(),
      // connectors
      addConnector: (from, to, style) => this.addConnector(from, to, style || {}),
      resolveConnectors: () => this.resolveConnectors(),
      // flipbook / stop-motion animation
      flipbook: () => ({ ...this.anim }),
      setFlipbook: on => this.setFlipbook(on),
      toggleFlipbook: () => this.toggleFlipbook(),
      currentFrame: () => this.anim.current,
      frameCount: () => this.anim.count,
      setFrame: i => this.setFrame(i),
      nextFrame: () => this.nextFrame(),
      prevFrame: () => this.prevFrame(),
      addFrame: () => this.addFrame(),
      duplicateFrame: () => this.duplicateFrame(),
      deleteFrame: () => this.deleteFrame(),
      moveFrame: (from, to) => this.moveFrame(from, to),
      moveSelectionToFrame: f => this.moveSelectionToFrame(f),
      frameItemCount: f => this.frameItemCount(f),
      frameOf: id => this.frameOf(this.scene.byId(id)),
      play: () => this.play(),
      stop: () => this.stop(),
      isPlaying: () => this.anim.playing,
      // cinematic camera path (per-page keyframes)
      setPageCamera: f => this.setPageCamera(f),
      clearPageCamera: f => this.clearPageCamera(f),
      pageCamera: f => { const c = this.pageCamera(f); return c ? { ...c } : null; },
      cameraKeyframeCount: () => this.cameraKeyframeCount(),
      hasCameraPath: () => this.hasCameraPath(),
      sampleCameraAtTick: (t, cyclic) => { const s = this.sampleCameraAtTick(t, cyclic); return s ? { ...s } : null; },
      timelineTicks: () => this._timelineTicks(),
      frameStartTick: f => this._frameStartTick(f),
      pageAtTick: t => this._pageAtTick(t),
      setOnion: n => this.setOnion(n),
      setFps: n => this.setFps(n),
      setTint: on => this.setTint(on),
      setLoop: on => this.setLoop(on),
      setDither: on => this.setDither(on),
      getDither: () => this.anim.dither,
      setHQ: on => this.setHQ(on),
      getHQ: () => this.anim.hq,
      // Supersample QA: render the flipbook export and return one frame's raw RGBA
      // + dims, so tests can measure antialiasing (a 2× supersample turns a hard
      // diagonal edge into a band of intermediate-luma pixels). Keep maxDim small.
      exportFrame0: (opts = {}) => {
        const res = renderFrames(this, opts);
        return { width: res.width, height: res.height, count: res.count, data: Array.from(res.frames[0]) };
      },
      // cinematic camera-glide easing curve
      setEase: mode => this.setEase(mode),
      getEase: () => this.anim.ease,
      easeModes: () => EASE_MODES.map(m => m.id),
      // motion-path overlay (the cinematic flight-plan drawn in the editing view)
      setShowPath: on => this.setShowPath(on),
      getShowPath: () => this.anim.showPath,
      motionPathState: () => { const s = this._motionPathRenderState(); return s ? JSON.parse(JSON.stringify(s)) : null; },
      // thumbnail strip
      renderThumbs: () => { this._renderThumbs(); return document.querySelectorAll('#flip-thumbs .flip-thumb').length; },
      thumbCount: () => document.querySelectorAll('#flip-thumbs .flip-thumb').length,
      activeThumb: () => {
        const el = document.querySelector('#flip-thumbs .flip-thumb.active');
        return el ? (el.dataset.frame | 0) : -1;
      },
      clickThumb: i => { const el = document.querySelector(`#flip-thumbs .flip-thumb[data-frame="${i}"]`); if (el) el.click(); return this.anim.current; },
      // per-frame timing (holds/eases)
      setFrameHold: (f, h) => this.setFrameHold(f, h),
      frameHold: (f = this.anim.current) => this._holdAt(f),
      frameHolds: () => this.anim.holds.slice(0, this.anim.count),
      // animation export — GIF bytes as a plain array (serialises across the
      // test boundary), sprite-sheet metadata + dataURL, and the downloaders.
      exportGifBytes: opts => Array.from(this.exportGifBytes(opts)),
      exportSprite: (opts = {}) => {
        const s = this.exportSpriteCanvas(opts);
        return { width: s.width, height: s.height, cols: s.cols, rows: s.rows,
                 tileW: s.tileW, tileH: s.tileH, dataURL: s.canvas.toDataURL('image/png') };
      },
      downloadGIF: opts => this.downloadGIF(opts),
      downloadSpriteSheet: opts => this.downloadSpriteSheet(opts),
      // symmetry / mandala
      setSymmetry: partial => this.setSymmetry(partial),
      getSymmetry: () => this.getSymmetry(),
      toggleSymmetry: force => this.toggleSymmetry(force),
      setSymmetryCenter: (x, y) => this.setSymmetryCenter(x, y),
      symmetryCenterToView: () => this.symmetryCenterToView(),
      symAnchorScreen: () => this._symAnchorScreen(),
      symGridOffsets: () => this._gridOffsets(),
      symGridActive: () => this._gridActive(),
      // wallpaper groups (the 17 plane symmetry groups)
      setWallpaperGroup: name => this.setWallpaperGroup(name),
      wallpaperGroups: () => this.wallpaperGroups(),
      wallpaperActive: () => this._wallpaperActive(),
      wallpaperPlacementCount: () => this.wallpaperPlacementCount(),
      wallpaperCellCorners: () => this.wallpaperCellCorners(),
      // frieze groups (the 7 strip symmetry groups — the 1-D sibling)
      setFriezeGroup: name => this.setWallpaperGroup(name),
      setTilingGroup: name => this.setTilingGroup(name),
      friezeGroups: () => this.friezeGroups(),
      friezeActive: () => this._friezeActive(),
      friezeStripCorners: () => this.friezeStripCorners(),
      friezeFundamentalDomainCorners: () => this.friezeFundamentalDomainCorners(),
      // fundamental-domain highlight ("draw here, symmetry fills the rest")
      fundamentalDomainCorners: () => this.fundamentalDomainCorners(),
      mandalaWedge: () => this._mandalaWedge(),
      setShowDomain: v => this.setSymmetry({ showDomain: !!v }),
      showDomain: () => this.symmetry.showDomain,
      symRenderState: () => this._symmetryRenderState(),
      // pixel art
      newPixelSprite: opts => this.newPixelSprite(opts || {}),
      editPixel: id => this.editPixel(id),
      endPixelEdit: () => this.endPixelEdit(),
      isPixelEditing: () => this.pixel.editing,
      pixelPanelOpen: () => this.pixel.panelOpen,
      togglePixelPanel: force => this.togglePixelPanel(force),
      pixelTarget: () => this.pixel.targetId,
      setPixelTool: name => this.setPixelTool(name),
      getPixelTool: () => this.pixel.tool,
      setPixelColor: idx => this.setPixelColor(idx),
      getPixelColor: () => this.pixel.color,
      setRectFill: on => this.setRectFill(on),
      setPixelPalette: name => this.setPixelPalette(name),
      setPixelSlotColor: hex => this.setPixelSlotColor(hex),
      remapPixelColor: (from, to, id) => this.remapPixelColor(from, to, id),
      swapPixelColor: (a, b, id) => this.swapPixelColor(a, b, id),
      flipPixel: (axis, id) => this.flipPixel(axis, id),
      rotatePixel90: (dir, id) => this.rotatePixel90(dir, id),
      // rectangular SELECT marquee
      setPixelSelection: (rect, id) => this.setPixelSelection(rect, id),
      getPixelSelection: () => this.getPixelSelection(),
      magicWandSelect: (px, py, opts, id) => this.magicWandSelect(px, py, opts || {}, id),
      invertPixelSelection: id => this.invertPixelSelection(id),
      setWandContiguous: on => { this.pixel.wandContiguous = !!on; this._savePixel(); this._syncPixelUI(); },
      getWandContiguous: () => this.pixel.wandContiguous,
      selectAllPixels: id => this.selectAllPixels(id),
      deselectPixels: () => this.deselectPixels(),
      clearPixelSelection: id => this.clearPixelSelection(id),
      copyPixelSelection: id => this.copyPixelSelection(id),
      cutPixelSelection: id => this.cutPixelSelection(id),
      pastePixelSelection: (opts, id) => this.pastePixelSelection(opts, id),
      movePixelSelection: (dx, dy, id) => this.movePixelSelection(dx, dy, id),
      flipPixelSelection: (axis, id) => this.flipPixelSelection(axis, id),
      rotatePixelSelection: (dir, id) => this.rotatePixelSelection(dir, id),
      pixelClip: () => this.pixel.clip ? { pw: this.pixel.clip.pw, ph: this.pixel.clip.ph, data: this.pixel.clip.data.slice() } : null,
      pixelData: id => this.pixelData(id),
      pixelAt: (id, px, py) => this.pixelAt(id, px, py),
      pixelInfo: id => this.pixelInfo(id),
      pixelPalettes: () => Object.keys(PIXEL_PALETTES),
      paintPixel: (id, px, py, idx) => this._apiPaintPixel(id, px, py, idx),
      fillPixel: (id, px, py, idx) => this._apiFillPixel(id, px, py, idx),
      setPixelMirror: (axis, on) => this.setPixelMirror(axis, on),
      getPixelMirror: () => this.getPixelMirror(),
      setPixelFromImage: on => this.setPixelFromImage(on),
      setPixelColors: n => this.setPixelColors(n),
      getPixelConvert: () => ({ fromImage: !!this.pixel.fromImage, colors: this.pixel.colors }),
      convertImageToSprite: (id, opts) => this.convertImageToSprite(id, opts || {}),
      resizePixel: (npw, nph, mode, id) => this.resizePixel(npw, nph, mode, id),
      exportPixelDataURL: (id, scale) => { const cv = this.exportPixelCanvas(id, scale == null ? 1 : scale); return cv ? cv.toDataURL('image/png') : null; },
      downloadPixelPNG: (id, scale) => this.downloadPixelPNG(id, scale),
      // recursive stamp + live Droste portal
      stamp: opts => this.recursiveStamp(opts),
      // recursion knobs (child-zoom / levels) the stamp & portal buttons read from
      setStampFactor: pct => this.setStampFactor(pct),
      getStampFactor: () => this.getStampFactor(),
      setStampDepth: n => this.setStampDepth(n),
      getStampDepth: () => this.getStampDepth(),
      // vortex-stamp knobs (per-level spin / hue / fade)
      setStampSpin: deg => this.setStampSpin(deg),
      getStampSpin: () => this.getStampSpin(),
      setStampHue: deg => this.setStampHue(deg),
      getStampHue: () => this.getStampHue(),
      setStampFade: pct => this.setStampFade(pct),
      getStampFade: () => this.getStampFade(),
      setStampDrift: pct => this.setStampDrift(pct),
      getStampDrift: () => this.getStampDrift(),
      createDroste: opts => { const it = this.createDroste(opts || {}); return it ? it.id : null; },
      drosteLevels: () => this.renderer.lastDrosteLevels,
      // seamless Droste zoom-loop export (built on the portal's self-similarity)
      drosteSelfSim: (id) => { const it = id ? this.scene.byId(id) : this._targetDroste(); return it && it.type === 'droste' ? drosteSelfSimilarity(it) : null; },
      drosteLoopBytes: opts => { const b = this.exportDrosteLoopBytes(opts || {}); return b ? Array.from(b) : null; },
      drosteLoopInfo: (opts = {}) => {
        const it = opts.id ? this.scene.byId(opts.id) : this._targetDroste();
        const res = renderDrosteLoopFrames(this, it, opts);
        return res ? { count: res.count, width: res.width, height: res.height, sim: res.sim, s0: res.s0 } : null;
      },
      // Seamlessness metric: how close frame[0] is to the would-be frame[N] (the
      // loop's wrap), vs a half-loop control. Returns summed-3-channel pixel diffs.
      drosteSeam: (opts = {}) => {
        const it = opts.id ? this.scene.byId(opts.id) : this._targetDroste();
        const o = { maxDim: 96, frames: 8, ...opts, wrap: true };
        const res = renderDrosteLoopFrames(this, it, o);
        if (!res) return null;
        const f0 = res.frames[0], fw = res.wrapFrame, fc = res.frames[Math.floor(res.count / 2)];
        const diff = (a, b) => {
          let sum = 0, max = 0, hot = 0; const px = a.length / 4;
          for (let i = 0; i < a.length; i += 4) {
            const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
            sum += d; if (d > max) max = d; if (d > 96) hot++;
          }
          return { mean: sum / px, max, hot, hotFrac: hot / px };
        };
        return { seam: diff(f0, fw), control: diff(f0, fc), count: res.count, width: res.width, height: res.height };
      },
      // Preview the loop as a horizontal filmstrip PNG (data URL): every loop
      // frame, then a repeat of the wrap frame — if seamless, the last cell looks
      // continuous with the first. Used by tests/_drosteloopshot.mjs.
      drosteLoopStripDataURL: (opts = {}) => {
        const it = opts.id ? this.scene.byId(opts.id) : this._targetDroste();
        const cols = clamp(opts.cols || 8, 2, 24);
        const res = renderDrosteLoopFrames(this, it, { maxDim: opts.maxDim || 130, ...opts, frames: cols, wrap: true });
        if (!res) return null;
        const W = res.width, H = res.height, gap = 3;
        const cells = [...res.frames, res.wrapFrame];   // append the would-be frame[N]
        const cv = document.createElement('canvas');
        cv.width = cells.length * W + (cells.length + 1) * gap; cv.height = H + 2 * gap;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#1b1d24'; ctx.fillRect(0, 0, cv.width, cv.height);
        const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
        const tctx = tmp.getContext('2d');
        cells.forEach((f, i) => {
          tctx.putImageData(new ImageData(new Uint8ClampedArray(f), W, H), 0, 0);
          ctx.drawImage(tmp, gap + i * (W + gap), gap);
        });
        return cv.toDataURL('image/png');
      },
      // bookmarks + fly-to
      addBookmark: name => this.addBookmark(name),
      removeBookmark: i => this.removeBookmark(i),
      gotoBookmark: (i, animate) => this.gotoBookmark(i, animate),
      bookmarks: () => (this.bookmarks || []).slice(),
      flyTo: (target, dur) => this.flyTo(target, dur),
      pick: (wx, wy, tol = 5) => { const it = this.scene.pick(wx, wy, tol); return it ? it.id : null; },
      eyedrop: (wx, wy) => this.eyedrop(wx, wy),
      select: ids => { this.selectedIds = new Set(ids); this._activeId = ids.length ? ids[ids.length - 1] : null; this._updateHud(); this.requestRender(); },
      render: () => this.render(),
      dataURL: () => this.canvas.toDataURL('image/png'),
      // command palette + contextual hint (Transparency / batch 26)
      openPalette: () => this.openPalette(),
      closePalette: () => this.closePalette(),
      togglePalette: () => this.togglePalette(),
      paletteOpen: () => this._paletteOpen,
      paletteItems: () => this._paletteRows.map(r => ({ id: r.cmd.id, title: r.cmd.title, cat: r.cmd.cat, enabled: r.enabled })),
      paletteSelected: () => { const r = this._paletteRows[this._paletteSel]; return r ? r.cmd.id : null; },
      filterPalette: q => { const el = document.getElementById('palette-input'); if (el) el.value = q; this._paletteFilter(q); },
      runCommand: id => { const c = this._cmdById.get(id); if (!c) return false; if (c.when && !c.when(this)) return false; if (c.enabled && !c.enabled(this)) return false; this._paletteRun(c); return true; },
      commandIds: () => this.commands.map(c => c.id),
      commandCount: () => this.commands.length,
      hintText: () => (document.getElementById('hud-hint')?.textContent || ''),
      hintMods: () => (this._lastHint?.mods || []).map(m => ({ key: m.key, label: m.label, active: m.active })),
      setMods: m => { this._mods = { shift: false, alt: false, meta: false, space: false, ...(m || {}) }; this._updateHint(); },
      // focus mode (recess)
      setFocus: on => this.setFocus(on),
      toggleFocus: force => this.toggleFocus(force),
      focusActive: () => !!this.focusMode,
      // first-run coachmark (onboarding)
      coachVisible: () => { const el = document.getElementById('coachmark'); return !!el && el.classList.contains('show'); },
      coachSeen: () => { try { return localStorage.getItem('infinizoom.coachSeen') === '1'; } catch { return false; } },
      showCoach: () => this.showCoach(),
      dismissCoach: () => this._dismissCoach(),
    };
  }
}

const app = new App();
window.__app = app;

// ── Host bridge ──────────────────────────────────────────────────
// When this app runs inside the creature-collect "Extras → Draw"
// window (an <iframe> on the same origin), the parent reaches in
// through window.DrawApp to save the current drawing into its folder
// and to load a saved one back. getDrawing/loadDrawing use the exact
// {doc, camera} shape the local autosave already round-trips
// (storage.saveLocal / loadDoc), so a saved drawing restores cleanly.
window.DrawApp = {
  // Serialize the live drawing + view (mirrors storage.saveLocal's payload).
  getDrawing() {
    return { doc: app.scene.toJSON(), camera: app.camera.serialize() };
  },
  // Restore a drawing saved by getDrawing(). loadDoc accepts {doc, camera},
  // rebuilds the scene, restores the view, clears undo history, and repaints.
  loadDrawing(data) {
    if (data) app.loadDoc(data);
  },
  // Start a fresh drawing — same as the settings "Clear" (clearAll is
  // undoable, so a misfire is recoverable). The host's New button gates
  // this behind its own confirm popup.
  newDrawing() { app.clearAll(); },
  // Undo / redo proxies so the host's top-bar buttons drive the same
  // command stack as the in-app undo/redo. No-ops when the stack is empty.
  undo() { app.undo(); },
  redo() { app.redo(); },
  // Small JPEG preview of the current canvas for the folder grid. The
  // renderer paints an opaque background every frame, so the live canvas
  // already carries the paper colour — just downscale it. Capped at 256px
  // wide so previews stay tiny inside the exported save file.
  thumbnail() {
    try {
      const src = app.canvas;
      if (!src || !src.width || !src.height) return null;
      const scale = Math.min(1, 256 / src.width);
      const w = Math.max(1, Math.round(src.width * scale));
      const h = Math.max(1, Math.round(src.height * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(src, 0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.72);
    } catch (e) { return null; }
  },
};
