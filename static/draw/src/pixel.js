// Pixel-art model + algorithms. DOM-FREE on purpose (so it unit-tests in node
// and is reused by both the renderer and the app). The pixel SPRITE is a normal
// world item that floats in the infinite canvas and stays crisp via the
// renderer's nearest-neighbour scaling — see Renderer._drawItem 'pixel' case.
//
// Item shape (geometry in WORLD coords, like the `image` item):
//   { type:'pixel', x, y, w, h,   // world placement box (w = pw*cell, h = ph*cell)
//     pw, ph,                     // pixel grid dimensions (columns × rows)
//     palette: ['#rrggbb', ...],  // indexed colours (≤255 entries)
//     data: [idx, idx, ...] }     // pw*ph palette indices, row-major; TRANSPARENT = empty
//
// `data` is a plain JS Array of small ints so the item JSON-serialises with ZERO
// special handling (the whole app assumes "items just serialize" — toJSON,
// localStorage, history snapshots, clipboard all rely on it). Sprite dimensions
// are capped (see MAX_DIM) so the array stays bounded. Cross-cutting fields
// (rot/opacity/locked/hidden/frame/parent/group/LOD) work exactly as for other
// box items.

import { rotatePoint } from './util.js';
import { quantize } from './gif.js';

/** Sentinel index for an empty / transparent cell. Palettes hold ≤255 colours. */
export const TRANSPARENT = 255;

/** Largest sprite we allow (keeps `data` + ImageData work bounded; gemma's flag). */
export const MAX_DIM = 256;

/** Default world units per pixel cell for a freshly-made sprite. */
export const DEFAULT_CELL = 8;

/**
 * Named preset palettes pixel artists actually use. Values are the canonical hex
 * lists for each (public, widely-published palettes). Index 0 is a sensible
 * "ink" colour for each so a fresh paint stroke reads immediately.
 */
export const PIXEL_PALETTES = {
  // PICO-8 fantasy-console palette (16).
  pico8: ['#000000', '#1D2B53', '#7E2553', '#008751', '#AB5236', '#5F574F',
          '#C2C3C7', '#FFF1E8', '#FF004D', '#FFA300', '#FFEC27', '#00E436',
          '#29ADFF', '#83769C', '#FF77A8', '#FFCCAA'],
  // DawnBringer 16 — a classic hand-tuned 16-colour ramp.
  db16: ['#140C1C', '#442434', '#30346D', '#4E4A4E', '#854C30', '#346524',
         '#D04648', '#757161', '#597DCE', '#D27D2C', '#8595A1', '#6DAA2C',
         '#D2AA99', '#6DC2CA', '#DAD45E', '#DEEED6'],
  // ARNE 16 — another well-known general-purpose palette.
  arne16: ['#000000', '#9D9D9D', '#FFFFFF', '#BE2633', '#E06F8B', '#493C2B',
           '#A46422', '#EB8931', '#F7E26B', '#2F484E', '#44891A', '#A3CE27',
           '#1B2632', '#005784', '#31A2F2', '#B2DCEF'],
  // 8-step grayscale ramp.
  gray8: ['#000000', '#242424', '#484848', '#6D6D6D',
          '#919191', '#B6B6B6', '#DADADA', '#FFFFFF'],
};

export const DEFAULT_PALETTE = 'pico8';

/** Clamp a sprite dimension into [1, MAX_DIM] (integer). */
export function clampDim(n) {
  n = Math.round(Number(n) || 1);
  return n < 1 ? 1 : n > MAX_DIM ? MAX_DIM : n;
}

let _pxSeq = 0;
function pixelId() { return 'px_' + (_pxSeq++).toString(36) + Math.round((performance?.now?.() || 0)).toString(36); }

/**
 * Build a new pixel sprite item. `pw`×`ph` cells, each `cell` world units, with
 * the top-left at world (x,y). The grid starts fully transparent unless `fill`
 * (a palette index) is given.
 */
export function makePixel(x, y, pw, ph, opts = {}) {
  pw = clampDim(pw); ph = clampDim(ph);
  const cell = opts.cell > 0 ? opts.cell : DEFAULT_CELL;
  const palette = (opts.palette && opts.palette.length)
    ? opts.palette.slice()
    : (PIXEL_PALETTES[opts.paletteName] || PIXEL_PALETTES[DEFAULT_PALETTE]).slice();
  const fill = opts.fill == null ? TRANSPARENT : opts.fill;
  const data = new Array(pw * ph).fill(fill);
  return {
    id: opts.id || pixelId(),
    type: 'pixel',
    x, y, w: pw * cell, h: ph * cell,
    pw, ph, palette, data,
  };
}

/** World size of one cell of a sprite: { cw, ch }. */
export function cellSize(it) {
  return { cw: it.w / it.pw, ch: it.h / it.ph };
}

/**
 * Map a WORLD point to integer pixel coords of a sprite, honouring the sprite's
 * rotation. Returns { px, py } when inside the grid, else null. Strict floor so
 * the cursor never "bleeds" into the neighbouring cell (gemma's note).
 */
export function worldToPixel(it, wx, wy) {
  const r = worldToPixelUnclamped(it, wx, wy);
  if (!r) return null;
  if (r.px < 0 || r.py < 0 || r.px >= it.pw || r.py >= it.ph) return null;
  return r;
}

/** Like worldToPixel but WITHOUT the bounds check — returns the floored cell
 *  coords even outside the grid. Used to interpolate a drag whose cursor strays
 *  off the sprite: the line is computed in cell space and setPixel no-ops the
 *  out-of-range cells, so painting stops cleanly at the sprite edge. */
export function worldToPixelUnclamped(it, wx, wy) {
  if (it.rot) {
    const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    const p = rotatePoint(wx, wy, cx, cy, -it.rot);
    wx = p.x; wy = p.y;
  }
  const cw = it.w / it.pw, ch = it.h / it.ph;
  if (!(cw > 0) || !(ch > 0)) return null;
  return { px: Math.floor((wx - it.x) / cw), py: Math.floor((wy - it.y) / ch) };
}

/** Read a pixel index (TRANSPARENT when out of bounds). */
export function getPixel(it, px, py) {
  if (px < 0 || py < 0 || px >= it.pw || py >= it.ph) return TRANSPARENT;
  return it.data[py * it.pw + px];
}

/**
 * Set one pixel. Returns the PREVIOUS value (so the caller can record an undo
 * diff), or -1 when the coords are out of bounds / unchanged-flag is irrelevant.
 */
export function setPixel(it, px, py, idx) {
  if (px < 0 || py < 0 || px >= it.pw || py >= it.ph) return -1;
  const i = py * it.pw + px;
  const old = it.data[i];
  it.data[i] = idx;
  return old;
}

/** Integer cells on the line (x0,y0)→(x1,y1) via Bresenham (endpoints inclusive). */
export function bresenhamLine(x0, y0, x1, y1) {
  x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
  const cells = [];
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    cells.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
  return cells;
}

/** Cells of a rectangle from (x0,y0) to (x1,y1) inclusive — outline, or filled. */
export function rectCells(x0, y0, x1, y1, filled = false) {
  const lx = Math.min(x0, x1), rx = Math.max(x0, x1);
  const ty = Math.min(y0, y1), by = Math.max(y0, y1);
  const cells = [];
  if (filled) {
    for (let y = ty; y <= by; y++) for (let x = lx; x <= rx; x++) cells.push({ x, y });
    return cells;
  }
  for (let x = lx; x <= rx; x++) { cells.push({ x, y: ty }); if (by !== ty) cells.push({ x, y: by }); }
  for (let y = ty + 1; y < by; y++) { cells.push({ x: lx, y }); if (rx !== lx) cells.push({ x: rx, y }); }
  return cells;
}

/**
 * Cells of an ellipse fitted corner-to-corner into the bounding box (x0,y0)..
 * (x1,y1) — outline, or filled. Uses Alois Zingl's exact rasterised-ellipse
 * algorithm (a "Bresenham" ellipse), which fits the bounding rectangle precisely
 * and stays clean + 4-way symmetric for both even and odd spans (the canonical
 * pixel-art circle). For the filled variant we span-fill each row between the
 * outline's min/max x, which exactly matches the drawn outline.
 */
export function ellipseCells(x0, y0, x1, y1, filled = false) {
  let lx = Math.min(x0, x1), rx = Math.max(x0, x1);
  let ty = Math.min(y0, y1), by = Math.max(y0, y1);
  const a = rx - lx, b = by - ty;          // diameters (>= 0)
  const outline = [];
  if (a === 0 && b === 0) {
    outline.push({ x: lx, y: ty });
  } else {
    const b1 = b & 1;
    let dx = 4 * (1 - a) * b * b, dy = 4 * (b1 + 1) * a * a;
    let err = dx + dy + b1 * a * a, e2;
    let yT = ty + ((b + 1) >> 1), yB = yT - b1;   // starting pixel rows
    const A = 8 * a * a, B = 8 * b * b;            // error-step increments
    let l = lx, r = rx;
    do {
      outline.push({ x: r, y: yT }); outline.push({ x: l, y: yT });
      outline.push({ x: l, y: yB }); outline.push({ x: r, y: yB });
      e2 = 2 * err;
      if (e2 <= dy) { yT++; yB--; err += dy += A; }              // y step
      if (e2 >= dx || 2 * err > dy) { l++; r--; err += dx += B; } // x step
    } while (l <= r);
    while (yT - yB < b) { // finish the tips of very flat ellipses (a small)
      outline.push({ x: l - 1, y: yT }); outline.push({ x: r + 1, y: yT++ });
      outline.push({ x: l - 1, y: yB }); outline.push({ x: r + 1, y: yB-- });
    }
  }
  if (!filled) return outline;
  // span-fill: for each row, fill from the outline's min x to its max x
  const rows = new Map();
  for (const c of outline) {
    const rec = rows.get(c.y);
    if (!rec) rows.set(c.y, { min: c.x, max: c.x });
    else { if (c.x < rec.min) rec.min = c.x; if (c.x > rec.max) rec.max = c.x; }
  }
  const cells = [];
  for (const [y, rec] of rows) for (let x = rec.min; x <= rec.max; x++) cells.push({ x, y });
  return cells;
}

/**
 * 4-connected flood fill from (px,py) to palette index `idx`. APPLIES the change
 * to it.data and returns the list of changed cells [{ i, before }] so the caller
 * can build a reversible history step. No-op (empty list) when the start cell is
 * already `idx` or out of bounds.
 */
export function floodFill(it, px, py, idx) {
  const target = getPixel(it, px, py);
  if (px < 0 || py < 0 || px >= it.pw || py >= it.ph) return [];
  if (target === idx) return [];
  const W = it.pw, H = it.ph, data = it.data;
  const changes = [];
  const stack = [py * W + px];
  const seen = new Uint8Array(W * H);
  seen[py * W + px] = 1;
  while (stack.length) {
    const i = stack.pop();
    if (data[i] !== target) continue;
    changes.push({ i, before: data[i] });
    data[i] = idx;
    const x = i % W, y = (i / W) | 0;
    if (x > 0 && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
    if (x < W - 1 && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && !seen[i - W]) { seen[i - W] = 1; stack.push(i - W); }
    if (y < H - 1 && !seen[i + W]) { seen[i + W] = 1; stack.push(i + W); }
  }
  return changes;
}

/** Parse '#rrggbb' (or '#rgb') to [r,g,b]. Returns [0,0,0] on garbage. */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return [0, 0, 0];
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (!isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Format [r,g,b] (0..255, clamped) as a lowercase '#rrggbb' hex string. */
export function rgbToHex(r, g, b) {
  const h = (n) => (n < 0 ? 0 : n > 255 ? 255 : Math.round(n)).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

/**
 * RGBA bytes (Uint8ClampedArray, length pw*ph*4) for a sprite — TRANSPARENT
 * cells get alpha 0. Used by the renderer's offscreen ImageData and by PNG
 * export. The palette is parsed once per call (not per pixel).
 */
export function pixelRGBA(it) {
  const { pw, ph, data, palette } = it;
  const rgb = palette.map(hexToRgb);
  const out = new Uint8ClampedArray(pw * ph * 4);
  for (let i = 0; i < data.length; i++) {
    const idx = data[i];
    const o = i * 4;
    if (idx === TRANSPARENT || idx >= rgb.length || idx < 0) { out[o + 3] = 0; continue; }
    const c = rgb[idx];
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
  }
  return out;
}

/** Pre-parse a palette ['#rrggbb'…] to [[r,g,b]…] for repeated nearest matching. */
export function paletteRGB(palette) { return palette.map(hexToRgb); }

/**
 * Index of the palette colour nearest (r,g,b), using the perceptual "redmean"
 * weighting — a cheap approximation that beats plain RGB distance (green counts
 * most; the red/blue weights shift with overall brightness), without the cost of
 * a full Lab conversion (gemma flagged Euclidean-RGB as a trap). `rgb` is the
 * pre-parsed [[r,g,b]…] palette. Returns 0 for an empty palette.
 */
export function nearestPaletteIndex(rgb, r, g, b) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < rgb.length; i++) {
    const c = rgb[i];
    const rmean = (c[0] + r) / 2;
    const dr = c[0] - r, dg = c[1] - g, db = c[2] - b;
    const d = (2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Quantize a source RGBA bitmap (`src` = RGBA bytes, length sw*sh*4) down to a
 * pw×ph grid of palette indices. Each target cell ALPHA-WEIGHTED-BOX-AVERAGES the
 * source pixels under it (a cohesive distillation, not a sparkly nearest-neighbour
 * sample — gemma's flag) then snaps the average to the nearest palette colour
 * (perceptual redmean). Cells whose mean alpha is below `alphaThreshold` (0..255,
 * default 128) become TRANSPARENT, preserving cut-outs. Returns a plain Array of
 * pw*ph palette indices (row-major) — JSON-clean, like every other sprite field.
 */
export function quantizeImage(src, sw, sh, pw, ph, palette, opts = {}) {
  pw = clampDim(pw); ph = clampDim(ph);
  const rgb = paletteRGB(palette);
  const aThresh = opts.alphaThreshold == null ? 128 : opts.alphaThreshold;
  const data = new Array(pw * ph).fill(TRANSPARENT);
  if (!(sw > 0) || !(sh > 0) || rgb.length === 0) return data;
  for (let py = 0; py < ph; py++) {
    const sy0 = Math.floor(py * sh / ph);
    const sy1 = Math.max(sy0 + 1, Math.floor((py + 1) * sh / ph));
    for (let px = 0; px < pw; px++) {
      const sx0 = Math.floor(px * sw / pw);
      const sx1 = Math.max(sx0 + 1, Math.floor((px + 1) * sw / pw));
      let ar = 0, ag = 0, ab = 0, aa = 0, n = 0;
      for (let y = sy0; y < sy1 && y < sh; y++) {
        for (let x = sx0; x < sx1 && x < sw; x++) {
          const o = (y * sw + x) * 4, al = src[o + 3];
          ar += src[o] * al; ag += src[o + 1] * al; ab += src[o + 2] * al;
          aa += al; n++;
        }
      }
      if (n === 0 || aa / n < aThresh) continue; // stays TRANSPARENT
      data[py * pw + px] = nearestPaletteIndex(rgb, ar / aa, ag / aa, ab / aa);
    }
  }
  return data;
}

/**
 * Build a representative N-colour palette FROM a source RGBA bitmap by MEDIAN-CUT
 * — the same deterministic algorithm src/gif.js uses to quantize the flipbook into
 * a global GIF palette, reused here so "turn a photo into pixel art" extracts the
 * image's OWN colours instead of snapping it to a fixed preset (PICO-8 etc.).
 *
 * Pixels with alpha below `alphaThreshold` (0..255, default 128) are ignored so a
 * transparent background never pulls a palette slot. `src` is RGBA bytes (length
 * sw*sh*4). Returns an array of '#rrggbb' strings: deduped (median-cut box means
 * can rarely collide) and ordered dark→light by Rec.601 luma so the swatch strip
 * reads as a ramp. The size is min(maxColors, distinct opaque colours), clamped to
 * [1,255]. A fully-transparent / empty image yields ['#000000'].
 */
export function buildPaletteFromImage(src, sw, sh, maxColors = 16, opts = {}) {
  const aThresh = opts.alphaThreshold == null ? 128 : opts.alphaThreshold;
  const cap = Math.max(1, Math.min(255, maxColors | 0));
  const hist = new Map();
  for (let i = 0; i + 3 < src.length; i += 4) {
    if (src[i + 3] < aThresh) continue;
    const key = (src[i] << 16) | (src[i + 1] << 8) | src[i + 2];
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  if (hist.size === 0) return ['#000000'];
  const { palette } = quantize(hist, cap);
  const seen = new Set();
  const hexes = [];
  for (const c of palette) {
    const hex = rgbToHex(c[0], c[1], c[2]);
    if (seen.has(hex)) continue;
    seen.add(hex);
    hexes.push(hex);
  }
  hexes.sort((a, b) => luma601(a) - luma601(b));
  return hexes;
}

/** Rec.601 perceptual luma of a '#rrggbb' colour (for ordering swatches). */
function luma601(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Resample a sprite's `data` (pw×ph) to npw×nph. Nearest-neighbour is the correct
 * resampler for indexed pixel art (no colour interpolation → the palette stays
 * intact). `mode`:
 *   'scale' — stretch the art to the new size (each target cell samples the
 *             proportional source cell);
 *   'crop'  — keep pixels 1:1 anchored top-left, cropping (smaller) or
 *             TRANSPARENT-padding (larger).
 * Returns a NEW plain Array (the caller swaps it in as one undoable step).
 */
export function resizePixelData(data, pw, ph, npw, nph, mode = 'scale') {
  npw = clampDim(npw); nph = clampDim(nph);
  const out = new Array(npw * nph).fill(TRANSPARENT);
  for (let y = 0; y < nph; y++) {
    let sy;
    if (mode === 'crop') { if (y >= ph) continue; sy = y; }
    else sy = Math.min(ph - 1, Math.floor(y * ph / nph));
    for (let x = 0; x < npw; x++) {
      let sx;
      if (mode === 'crop') { if (x >= pw) continue; sx = x; }
      else sx = Math.min(pw - 1, Math.floor(x * pw / npw));
      out[y * npw + x] = data[sy * pw + sx];
    }
  }
  return out;
}

/**
 * Mirror a sprite's `data` (pw×ph) across an axis, returning a NEW plain Array.
 * `axis` 'h' flips LEFT↔RIGHT (each row reversed); 'v' flips TOP↔BOTTOM (the row
 * ORDER reversed). Dimensions are unchanged. A pure index remap — indexed cells
 * just move, no colour interpolation — so it's nearest-neighbour-exact and its
 * OWN inverse (flip twice on the same axis === identity). DOM-free → node-testable.
 */
export function flipData(data, pw, ph, axis = 'h') {
  const out = new Array(pw * ph);
  const horiz = axis !== 'v'; // default/'h' → horizontal
  for (let y = 0; y < ph; y++) {
    const sy = horiz ? y : ph - 1 - y;
    for (let x = 0; x < pw; x++) {
      const sx = horiz ? pw - 1 - x : x;
      out[y * pw + x] = data[sy * pw + sx];
    }
  }
  return out;
}

/**
 * Rotate a sprite's `data` 90° — `dir` 'cw' (clockwise) or 'ccw'
 * (counter-clockwise). The grid dimensions SWAP: a pw×ph sprite becomes ph×pw, so
 * this returns `{ data, pw, ph }` carrying the NEW dimensions (the caller swaps
 * the world box too). A pure index remap into a freshly-allocated buffer — never
 * an in-place shuffle (which corrupts a non-square grid). Four CW rotations, or
 * one CW + one CCW, return the original exactly. DOM-free → node-testable.
 */
export function rotateData90(data, pw, ph, dir = 'cw') {
  const npw = ph, nph = pw;          // dimensions swap
  const out = new Array(npw * nph);
  const ccw = dir === 'ccw';
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      // CW : source (x,y) → dest (ph-1-y, x);  CCW : source (x,y) → dest (y, pw-1-x)
      const nx = ccw ? y : ph - 1 - y;
      const ny = ccw ? pw - 1 - x : x;
      out[ny * npw + nx] = data[y * pw + x];
    }
  }
  return { data: out, pw: npw, ph: nph };
}

/**
 * Replace every cell holding palette index `from` with `to`, IN PLACE — the
 * classic indexed-colour "merge / palette-swap" remap. Returns the list of flat
 * indices that changed (so the caller can build ONE compact reversible step —
 * each changed cell went from→to, no need to store a per-cell before/after). The
 * freed `from` slot is intentionally LEFT in the palette (the caller decides
 * whether to clear it; surprise-deleting a slot is hostile). `to` may be
 * TRANSPARENT (erase that colour) or `from` TRANSPARENT (fill the empties). No-op
 * (empty) when from===to. DOM-free → node-testable.
 */
export function remapIndex(data, from, to) {
  from |= 0; to |= 0;
  if (from === to) return [];
  const idxs = [];
  for (let i = 0; i < data.length; i++) if (data[i] === from) { data[i] = to; idxs.push(i); }
  return idxs;
}

/**
 * Exchange palette indices `a` and `b` across the whole buffer, IN PLACE (every
 * `a` becomes `b` and vice-versa). Done in a SINGLE pass that reads each cell's
 * ORIGINAL value once, so it can't fall into the "a→b then b→a turns everything
 * into a" trap (gemma's flag). Returns { aIdx, bIdx } — the flat indices that
 * held `a` and `b` BEFORE the swap — so the caller can build one reversible step.
 * Either index may be TRANSPARENT. No-op ({aIdx:[],bIdx:[]}) when a===b.
 */
export function swapIndex(data, a, b) {
  a |= 0; b |= 0;
  const aIdx = [], bIdx = [];
  if (a === b) return { aIdx, bIdx };
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v === a) { data[i] = b; aIdx.push(i); }
    else if (v === b) { data[i] = a; bIdx.push(i); }
  }
  return { aIdx, bIdx };
}

// ---------------------------------------------------------------------------
// Rectangular-SELECTION region ops (the marquee toolkit). All DOM-free and pure
// (none mutate the buffer they read from — moveRegion/flipRegion/rotateRegion
// return a NEW buffer; extractRegion returns a fresh block; blitRegion/fillRegion
// mutate the buffer they're HANDED, the in-place "stamp"/"clear" primitives the
// returning helpers compose). Out-of-grid cells are clipped (blit/fill) or read
// TRANSPARENT (extract), so a marquee that strays off the sprite is always safe.
// ---------------------------------------------------------------------------

/**
 * Copy a rw×rh sub-rectangle out of a pw×ph buffer starting at (rx,ry), returning
 * a NEW plain Array (row-major, length rw*rh). Cells outside the source grid read
 * TRANSPARENT — so a marquee partly off the sprite yields a clean padded block.
 * The "copy" primitive for the rectangular selection.
 *
 * `mask` (optional, Uint8Array length rw*rh in the region's local frame, 1 =
 * selected) restricts the copy to a NON-rectangular shape: unmasked cells read
 * TRANSPARENT, so the lifted block has the irregular selection's holes. Absent
 * mask = the whole rectangle (the marquee case — byte-identical to before).
 */
export function extractRegion(data, pw, ph, rx, ry, rw, rh, mask) {
  rx |= 0; ry |= 0; rw = Math.max(0, rw | 0); rh = Math.max(0, rh | 0);
  const out = new Array(rw * rh).fill(TRANSPARENT);
  for (let y = 0; y < rh; y++) {
    const sy = ry + y;
    if (sy < 0 || sy >= ph) continue;
    for (let x = 0; x < rw; x++) {
      if (mask && !mask[y * rw + x]) continue;
      const sx = rx + x;
      if (sx < 0 || sx >= pw) continue;
      out[y * rw + x] = data[sy * pw + sx];
    }
  }
  return out;
}

/**
 * Write a sw×sh source block into a pw×ph dest buffer at (dx,dy), IN PLACE,
 * clipping anything outside the dest grid (negative or past-edge offsets are fine
 * — source and dest indices clip independently). When `composite` is true,
 * TRANSPARENT source cells are SKIPPED so the block floats over what's beneath
 * (Aseprite-style); otherwise every cell is written (a flat replace). Returns the
 * dest buffer.
 */
export function blitRegion(dest, pw, ph, src, sw, sh, dx, dy, opts = {}) {
  dx |= 0; dy |= 0; sw |= 0; sh |= 0;
  const composite = !!opts.composite;
  for (let y = 0; y < sh; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= ph) continue;
    for (let x = 0; x < sw; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= pw) continue;
      const v = src[y * sw + x];
      if (composite && v === TRANSPARENT) continue;
      dest[ty * pw + tx] = v;
    }
  }
  return dest;
}

/**
 * Fill a sub-rectangle of a pw×ph buffer with `idx`, IN PLACE, clipped to the
 * grid. The "clear" primitive (idx=TRANSPARENT) for a rectangular selection.
 * Returns the buffer. `mask` (optional, local-frame Uint8Array length rw*rh)
 * restricts the fill to the selected cells of a non-rectangular selection.
 */
export function fillRegion(data, pw, ph, rx, ry, rw, rh, idx, mask) {
  rx |= 0; ry |= 0; rw = Math.max(0, rw | 0); rh = Math.max(0, rh | 0);
  for (let y = 0; y < rh; y++) {
    const ty = ry + y;
    if (ty < 0 || ty >= ph) continue;
    for (let x = 0; x < rw; x++) {
      if (mask && !mask[y * rw + x]) continue;
      const tx = rx + x;
      if (tx < 0 || tx >= pw) continue;
      data[ty * pw + tx] = idx;
    }
  }
  return data;
}

/**
 * Move a selection `sel` ({x,y,w,h[,mask]} in cells) by (dx,dy) cells, returning
 * a NEW buffer (the input is never mutated). The block is LIFTED first (read out),
 * the source cells cleared to TRANSPARENT, then the block COMPOSITE-stamped at the
 * offset — so transparent holes let the art beneath show through, and an
 * overlapping move can't corrupt itself (lift-before-clear order; gemma's flag).
 * A `sel.mask` lifts/clears only the masked (non-rectangular) cells; without it
 * the whole rect moves (byte-identical to the marquee case). Anything pushed off
 * the grid is clipped away.
 */
export function moveRegion(data, pw, ph, sel, dx, dy) {
  const out = data.slice();
  const block = extractRegion(data, pw, ph, sel.x, sel.y, sel.w, sel.h, sel.mask);
  fillRegion(out, pw, ph, sel.x, sel.y, sel.w, sel.h, TRANSPARENT, sel.mask);
  blitRegion(out, pw, ph, block, sel.w, sel.h, sel.x + (dx | 0), sel.y + (dy | 0), { composite: true });
  return out;
}

/**
 * Flip the contents of a selection in place (left↔right 'h' or top↔bottom 'v'),
 * returning a NEW buffer. For a plain rectangle the block is transformed as a UNIT
 * (a flat replace within the rect), so dimensions are unchanged and the op is its
 * own inverse. With a `sel.mask` only the masked cells are lifted, the source
 * masked cells cleared, and the mirrored block COMPOSITE-stamped back — so an
 * irregular selection flips in place over (without erasing) the art around it; the
 * caller mirrors the mask too (via flipData) so the marquee follows.
 */
export function flipRegion(data, pw, ph, sel, axis = 'h') {
  const out = data.slice();
  const block = extractRegion(data, pw, ph, sel.x, sel.y, sel.w, sel.h, sel.mask);
  const flipped = flipData(block, sel.w, sel.h, axis);
  if (sel.mask) {
    fillRegion(out, pw, ph, sel.x, sel.y, sel.w, sel.h, TRANSPARENT, sel.mask);
    blitRegion(out, pw, ph, flipped, sel.w, sel.h, sel.x, sel.y, { composite: true });
  } else {
    blitRegion(out, pw, ph, flipped, sel.w, sel.h, sel.x, sel.y, { composite: false });
  }
  return out;
}

/**
 * Rotate the contents of a selection 90° ('cw'/'ccw'), returning `{ data, sel }`
 * — a NEW buffer and the (possibly re-shaped) selection rect {x,y,w,h}. A
 * non-square selection's width/height SWAP, so the rotated block is re-anchored
 * about the selection's CENTRE (rounded to whole cells) and the source is cleared
 * first; anything past the grid edge is clipped. For a plain rectangle the block
 * is replaced as a unit (flat). With a `sel.mask` only the masked cells are
 * lifted/cleared and the rotated block is COMPOSITE-stamped (so it spins in place
 * over the surrounding art); the caller rotates the mask too (via rotateData90)
 * and merges it into the returned rect.
 */
export function rotateRegion(data, pw, ph, sel, dir = 'cw') {
  const out = data.slice();
  const block = extractRegion(data, pw, ph, sel.x, sel.y, sel.w, sel.h, sel.mask);
  const rot = rotateData90(block, sel.w, sel.h, dir); // { data, pw:sel.h, ph:sel.w }
  const nw = rot.pw, nh = rot.ph;
  const cx = sel.x + sel.w / 2, cy = sel.y + sel.h / 2; // spin about the centre
  const nx = Math.round(cx - nw / 2), ny = Math.round(cy - nh / 2);
  fillRegion(out, pw, ph, sel.x, sel.y, sel.w, sel.h, TRANSPARENT, sel.mask);
  blitRegion(out, pw, ph, rot.data, nw, nh, nx, ny, { composite: !!sel.mask });
  return { data: out, sel: { x: nx, y: ny, w: nw, h: nh } };
}

// ---------------------------------------------------------------------------
// Non-rectangular (MASK) selections — the magic-wand toolkit. A selection is
// {x,y,w,h} for a plain rectangle, or {x,y,w,h,mask} where `mask` is a Uint8Array
// (length w*h, local row-major frame, 1 = selected) carving an irregular shape
// out of the bounding box. The region ops above honour `sel.mask`; these helpers
// BUILD masks (flood by colour, invert, boolean-combine). All DOM-free.
//
// Canonical form: a mask whose every cell is set is normalised back to a plain
// rectangle (no `mask` field), so a wand over a solid block behaves exactly like
// a rectangular marquee and re-uses its well-trodden paths.
// ---------------------------------------------------------------------------

/**
 * Rasterise a selection to a full pw×ph occupancy grid (Uint8Array, 1 = selected).
 * A null selection → all-zero. Cells outside the grid are dropped. The inverse of
 * gridToSelection; together they make invert / boolean-combine trivial.
 */
export function selectionToGrid(sel, pw, ph) {
  const g = new Uint8Array(pw * ph);
  if (!sel) return g;
  for (let y = 0; y < sel.h; y++) {
    const gy = sel.y + y;
    if (gy < 0 || gy >= ph) continue;
    for (let x = 0; x < sel.w; x++) {
      const gx = sel.x + x;
      if (gx < 0 || gx >= pw) continue;
      if (sel.mask ? sel.mask[y * sel.w + x] : 1) g[gy * pw + gx] = 1;
    }
  }
  return g;
}

/**
 * Collapse a full pw×ph occupancy grid back to a tight-bbox selection
 * { x, y, w, h, mask } — or null when nothing is set. The mask is dropped when the
 * bbox is solidly filled (canonical-rectangle form). The mask is a fresh
 * Uint8Array in the bbox's local frame.
 */
export function gridToSelection(g, pw, ph) {
  let minx = pw, miny = ph, maxx = -1, maxy = -1;
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      if (!g[y * pw + x]) continue;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
  }
  if (maxx < 0) return null;
  const w = maxx - minx + 1, h = maxy - miny + 1;
  const mask = new Uint8Array(w * h);
  let solid = true;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = g[(miny + y) * pw + (minx + x)];
      mask[y * w + x] = v;
      if (!v) solid = false;
    }
  }
  return solid ? { x: minx, y: miny, w, h } : { x: minx, y: miny, w, h, mask };
}

/**
 * MAGIC WAND: build a selection from a seed cell by colour. Matches cells holding
 * the same palette index as the seed (TRANSPARENT counts as a colour, so clicking
 * empty space selects the background blob). `opts.contiguous` (default true) =
 * 4-connected flood from the seed (just the touching blob); false = GLOBAL (every
 * cell of that index anywhere). Returns a tight-bbox { x,y,w,h[,mask] } or null
 * when the seed is off-grid. DOM-free → node-testable.
 */
export function magicWandMask(data, pw, ph, sx, sy, opts = {}) {
  sx |= 0; sy |= 0;
  if (sx < 0 || sy < 0 || sx >= pw || sy >= ph) return null;
  const contiguous = opts.contiguous !== false;
  const target = data[sy * pw + sx];
  const g = new Uint8Array(pw * ph);
  if (contiguous) {
    const stack = [sy * pw + sx];
    const seen = new Uint8Array(pw * ph);
    seen[sy * pw + sx] = 1;
    while (stack.length) {
      const i = stack.pop();
      if (data[i] !== target) continue;
      g[i] = 1;
      const x = i % pw, y = (i / pw) | 0;
      if (x > 0 && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < pw - 1 && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && !seen[i - pw]) { seen[i - pw] = 1; stack.push(i - pw); }
      if (y < ph - 1 && !seen[i + pw]) { seen[i + pw] = 1; stack.push(i + pw); }
    }
  } else {
    for (let i = 0; i < g.length; i++) if (data[i] === target) g[i] = 1;
  }
  return gridToSelection(g, pw, ph);
}

/**
 * Invert a selection over the whole pw×ph grid: select every cell NOT currently
 * selected, tight-bboxed. A null/empty selection inverts to the full grid; a
 * full-grid selection inverts to null (nothing left). Holes in the original
 * become the selection and vice-versa.
 */
export function invertSelectionMask(sel, pw, ph) {
  const g = selectionToGrid(sel, pw, ph);
  for (let i = 0; i < g.length; i++) g[i] = g[i] ? 0 : 1;
  return gridToSelection(g, pw, ph);
}

/**
 * Boolean-combine two selections over a pw×ph grid. `mode`:
 *   'replace'   — just `b`;
 *   'add'       — union (a ∪ b);
 *   'subtract'  — a minus b;
 *   'intersect' — a ∩ b.
 * Returns a tight-bbox { x,y,w,h[,mask] } or null when the result is empty. Used
 * by the wand's Shift (add) / Alt (subtract) modifiers.
 */
export function combineSelections(a, b, pw, ph, mode = 'add') {
  if (mode === 'replace') return b ? gridToSelection(selectionToGrid(b, pw, ph), pw, ph) : null;
  const ga = selectionToGrid(a, pw, ph);
  const gb = selectionToGrid(b, pw, ph);
  for (let i = 0; i < ga.length; i++) {
    if (mode === 'add') ga[i] = (ga[i] || gb[i]) ? 1 : 0;
    else if (mode === 'subtract') ga[i] = (ga[i] && !gb[i]) ? 1 : 0;
    else if (mode === 'intersect') ga[i] = (ga[i] && gb[i]) ? 1 : 0;
  }
  return gridToSelection(ga, pw, ph);
}
