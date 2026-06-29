import { uid, bboxOfPoints, distToSegment, dist, rectsIntersect, rectContains, pointInRect, rotatePoint } from './util.js';

/** Item types that carry an optional `rot` (radians) about their own centre.
 *  Point-based items (stroke/line/arrow) bake rotation into their points instead.
 *  `droste` is a rotatable frame box (its recursive contents ride the box's
 *  rot via the per-level transform — see renderer._drawDroste). */
export const ROTATABLE = new Set(['rect', 'ellipse', 'polygon', 'image', 'text', 'pixel', 'droste']);

/**
 * Item shapes (all geometry in world coordinates):
 *   stroke  : { points:[{x,y}...], color, width }
 *   line    : { points:[a,b], color, width }
 *   rect    : { x, y, w, h, color, width, fill }
 *   ellipse : { x, y, w, h, color, width, fill }
 *   text    : { x, y, text, color, size }   // size is world-units font size
 *   image   : { x, y, w, h, src }           // src is a data URL (or any URL)
 *   connector: { from, to, ax, ay, bx, by, color, width, arrow }
 *             // from/to are item ids; ax..by are the resolved endpoint world
 *             // coords (a cache kept fresh by App.resolveConnectors each render)
 *
 * Optional cross-cutting fields (attached only when non-default, to keep JSON
 * tidy): `opacity`, `rot`, `group`, `locked`, `hidden`, `minScale`/`maxScale`
 * (LOD), `widthMode:'screen'` (constant on-screen stroke width — see Renderer),
 * `frame` (0-based flipbook page index; absent = page 0 — see App.anim), and
 * `parent` (id of a parent item — see PARENTING below).
 *
 * PARENTING / hierarchy: an item may carry an optional `parent` id. Transforming
 * a parent (move/rotate/scale) cascades the SAME transform onto every descendant
 * — baked into their world geometry, since the whole model lives in world coords.
 * There are NO stored local transforms, so parenting/unparenting is a pure
 * relationship change with no geometry edit (nothing "pops"). A dangling `parent`
 * (target deleted) is treated as no parent, so delete+undo revives links for
 * free. The App owns the cascade + cycle rules; the Scene just answers tree
 * queries (childrenOf / descendantsOf / wouldCreateCycle).
 */

/**
 * A `fill` is EITHER a flat colour string ('#rrggbb') OR a gradient descriptor
 * object { type:'linear'|'radial'|'conic', stops:[{t,color}...], angle } whose
 * geometry is normalised to the item's own bbox (so it transforms — move/rotate/
 * scale — for free). The renderer resolves it to a CanvasGradient per draw, in
 * WORLD space for the normal path and SCREEN space for the deep-zoom path (so a
 * radial/conic gradient stays correct as you dive INTO it — the infinite-zoom
 * payoff). `cloneFill` deep-copies the descriptor so two items created from the
 * same style never SHARE (and later edit) one gradient object.
 */
export function cloneFill(f) {
  if (!f || typeof f === 'string') return f || null;
  return {
    type: f.type || 'linear',
    angle: f.angle || 0,
    stops: (f.stops || []).map(s => ({ t: s.t, color: s.color })),
  };
}

// Only attach `opacity` when it's actually translucent, to keep JSON tidy.
const op = s => (s && s.opacity != null && s.opacity < 1 ? { opacity: s.opacity } : {});
// Only attach `widthMode` when it's non-default. Absent / 'world' = the default
// where width is world units and scales with zoom. 'screen' = constant on-screen
// width. 'clamp' = scales with zoom but pinned to a [clampMin,clampMax] on-screen
// px range, so the bounds ride along. Keeps JSON tidy and width-mode-unaware items
// backward compatible.
const wm = s => {
  if (s && s.widthMode === 'screen') return { widthMode: 'screen' };
  if (s && s.widthMode === 'clamp') {
    return { widthMode: 'clamp', clampMin: s.clampMin ?? 1.5, clampMax: s.clampMax ?? 24 };
  }
  return {};
};
// Only attach `blend` when it's a real compositing mode. Absent / 'normal' =
// 'source-over' (the unchanged default — keeps JSON tidy and blend-unaware items
// backward compatible). The stored string is a Canvas2D globalCompositeOperation
// value AND a valid SVG mix-blend-mode value (the 16 CSS blend modes), so it
// serves both the renderer and SVG export verbatim. See Renderer._drawItem.
const bl = s => (s && s.blend && s.blend !== 'normal' ? { blend: s.blend } : {});

export function makeStroke(points, style) {
  return { id: uid('s'), type: 'stroke', points, color: style.color, width: style.width, ...wm(style), ...bl(style), ...op(style) };
}
export function makeLine(a, b, style) {
  return { id: uid('l'), type: 'line', points: [a, b], color: style.color, width: style.width, ...wm(style), ...bl(style), ...op(style) };
}
export function makeRect(x, y, w, h, style) {
  return { id: uid('r'), type: 'rect', x, y, w, h, color: style.color, width: style.width,
           fill: cloneFill(style.fill), ...wm(style), ...bl(style), ...op(style) };
}
export function makeEllipse(x, y, w, h, style) {
  return { id: uid('e'), type: 'ellipse', x, y, w, h, color: style.color, width: style.width,
           fill: cloneFill(style.fill), ...wm(style), ...bl(style), ...op(style) };
}
export function makeText(x, y, text, style) {
  return { id: uid('t'), type: 'text', x, y, text, color: style.color, size: style.size, ...bl(style), ...op(style) };
}
export function makeArrow(a, b, style) {
  return { id: uid('a'), type: 'arrow', points: [a, b], color: style.color, width: style.width, ...wm(style), ...bl(style), ...op(style) };
}
export function makePolygon(x, y, w, h, style) {
  return { id: uid('p'), type: 'polygon', x, y, w, h,
           sides: style.sides || 5, star: !!style.star,
           color: style.color, width: style.width, fill: cloneFill(style.fill), ...wm(style), ...bl(style), ...op(style) };
}
export function makeImage(x, y, w, h, src, style = {}) {
  return { id: uid('img'), type: 'image', x, y, w, h, src, ...bl(style), ...op(style) };
}
export function makeConnector(fromId, toId, style = {}) {
  return { id: uid('c'), type: 'connector', from: fromId, to: toId,
           ax: 0, ay: 0, bx: 0, by: 0,
           color: style.color, width: style.width, arrow: style.arrow !== false, ...wm(style), ...bl(style), ...op(style) };
}
/**
 * A LIVE recursive "Droste portal": a frame box (x,y,w,h,rot) inside which a
 * deep-copied SNAPSHOT of some art (`src`, with combined bbox `srcBBox`) is
 * redrawn at ever-shrinking scale — and because this is an infinite-zoom app,
 * MORE recursion levels appear as you zoom into the frame (depth is driven by
 * camera scale, not baked). The frame is itself one selectable object; the
 * recursive copies are decoration (rendered, never hit-tested). See
 * renderer._drawDroste for the per-level transform + culling.
 *   src     : array of plain item objects (no `droste` items — anti-recursion)
 *   srcBBox : { minX, minY, maxX, maxY } combined bbox of `src` at capture
 *   frame   : { x, y, w, h, rot } the portal rectangle (aspect ~ srcBBox)
 */
export function makeDroste(src, srcBBox, frame, opts = {}) {
  return {
    id: uid('d'), type: 'droste',
    x: frame.x, y: frame.y, w: frame.w, h: frame.h, rot: frame.rot || 0,
    src, srcBBox,
    maxDepth: opts.maxDepth ?? 48,
    color: opts.color || '#7fd1ff',   // frame outline colour
    width: opts.width ?? 1,
    // VORTEX hue: degrees of hue rotation ADDED per recursion level (the live
    // portal's chromatic tunnel). Stored ONLY when non-zero so a plain portal is
    // byte-identical to pre-vortex JSON; the renderer treats absent as 0.
    ...(opts.hue ? { hue: opts.hue } : {}),
    ...op(opts),
  };
}

/**
 * The world→world affine M that maps a droste's source bbox onto its frame rect
 * (x,y,w,h,rot): M(srcBBox) === the frame, so applying it k times nests the art
 * k levels deep. A {a,b,c,d,e,f} tuple (x' = a·x + c·y + e, y' = b·x + d·y + f).
 * Aspect-preserved frames make it a pure similarity. This is the single source
 * of truth — renderer._drosteMatrix delegates here.
 */
export function drosteMatrix(it) {
  const sb = it.srcBBox;
  const W0 = sb.maxX - sb.minX, H0 = sb.maxY - sb.minY;
  const sx = it.w / W0, sy = it.h / H0;
  const th = it.rot || 0, cos = Math.cos(th), sin = Math.sin(th);
  const a = sx * cos, b = sx * sin, c = -sy * sin, d = sy * cos;
  const cxf = it.x + it.w / 2, cyf = it.y + it.h / 2;
  const e = cxf - (it.w / 2) * cos + (it.h / 2) * sin - (a * sb.minX + c * sb.minY);
  const f = cyf - (it.w / 2) * sin - (it.h / 2) * cos - (b * sb.minX + d * sb.minY);
  return { a, b, c, d, e, f };
}

/**
 * The self-similarity of a droste portal as a {scale, rot, x, y} similarity:
 * `scale` is the per-level shrink (== createDroste's `factor` when the frame is
 * aspect-preserved), `rot` the per-level rotation (== frame.rot), and (x,y) the
 * FIXED POINT the recursion converges to — the point a seamless Droste-zoom must
 * orbit. The fixed point solves M·p = p ⇒ (I − A)·p = [e,f]. For a non-square
 * frame the two axis scales differ; `scale` is then their geometric mean (no
 * single-ratio zoom is perfectly seamless, so the loop targets the conformal mean).
 */
export function drosteSelfSimilarity(it) {
  const m = drosteMatrix(it);
  const sx = Math.hypot(m.a, m.b);          // |column 1| = x-axis scale
  const sy = Math.hypot(m.c, m.d);          // |column 2| = y-axis scale
  const scale = Math.sqrt(sx * sy);
  const rot = Math.atan2(m.b, m.a);
  // (I − A)⁻¹ = 1/det · [[1−d, c],[b, 1−a]],  det = (1−a)(1−d) − c·b
  const det = (1 - m.a) * (1 - m.d) - m.c * m.b;
  let x, y;
  if (!isFinite(det) || Math.abs(det) < 1e-12) {
    x = it.x + it.w / 2; y = it.y + it.h / 2;   // degenerate (scale≈1): use centre
  } else {
    x = ((1 - m.d) * m.e + m.c * m.f) / det;
    y = (m.b * m.e + (1 - m.a) * m.f) / det;
  }
  return { scale, rot, x, y, sx, sy };
}

/** Point where the segment from box centre (cx,cy) toward (tx,ty) exits `box`. */
export function boxEdgePoint(cx, cy, tx, ty, box) {
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const eps = 1e-6 * (Math.abs(box.maxX - box.minX) + Math.abs(box.maxY - box.minY) + 1);
  let best = Infinity;
  const cand = [];
  if (dx > 0) cand.push((box.maxX - cx) / dx); else if (dx < 0) cand.push((box.minX - cx) / dx);
  if (dy > 0) cand.push((box.maxY - cy) / dy); else if (dy < 0) cand.push((box.minY - cy) / dy);
  for (const t of cand) {
    if (t < 0 || t > 1) continue;
    const px = cx + dx * t, py = cy + dy * t;
    if (px >= box.minX - eps && px <= box.maxX + eps && py >= box.minY - eps && py <= box.maxY + eps) {
      best = Math.min(best, t);
    }
  }
  if (!isFinite(best)) return { x: cx, y: cy };
  return { x: cx + dx * best, y: cy + dy * best };
}

/** Vertices (world coords) of a polygon/star item, fitted to its bbox. */
export function polygonVertices(it) {
  const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
  const rx = it.w / 2, ry = it.h / 2;
  const n = Math.max(3, it.sides || 5);
  const steps = it.star ? n * 2 : n;
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const ang = -Math.PI / 2 + (i / steps) * Math.PI * 2;
    const r = it.star ? (i % 2 === 0 ? 1 : 0.42) : 1;
    pts.push({ x: cx + Math.cos(ang) * rx * r, y: cy + Math.sin(ang) * ry * r });
  }
  return pts;
}

function pointInPolygon(px, py, verts) {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i].x, yi = verts[i].y, xj = verts[j].x, yj = verts[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/** Rough text extents in world units (longest line × ~0.6em wide, 1.1em tall). */
function textMetrics(it) {
  const lines = String(it.text).split('\n');
  const cols = lines.reduce((m, l) => Math.max(m, l.length), 1);
  return { w: cols * it.size * 0.6, h: lines.length * it.size * 1.1 };
}

// Per-item cache for the expensive point-array bbox scan. Keyed by the item
// object; the stored entry remembers WHICH points array it measured. Every
// committed geometry edit (scale/rotate/reflect/translate) replaces it.points
// with a fresh array via .map(), so an identity check correctly invalidates —
// no manual dirty-flagging, no risk of a stale box. The live draft mutates its
// own array in place but is drawn directly, never culled through here. A
// WeakMap keeps the cache OUT of the item objects, so toJSON/deep-clone/
// localStorage never see it and entries vanish when items are GC'd.
//
// ⚠️ INVARIANT (do not break): a committed item's points must be REPLACED, never
// mutated in place (`it.points = it.points.map(...)`, not `it.points[i].x = …`).
// In-place mutation keeps the array reference, so this cache — AND the spatial
// cull index built from it — would return a STALE box: the item would cull as if
// it never moved. Verified true today (only draft.points is mutated in place).
const _pointBoxCache = new WeakMap(); // it -> { pts, box }
function pointsBox(it) {
  const c = _pointBoxCache.get(it);
  if (c && c.pts === it.points) return c.box;
  const box = bboxOfPoints(it.points);
  _pointBoxCache.set(it, { pts: it.points, box });
  return box;
}

/** Axis-aligned bbox in the item's OWN (unrotated) frame — no padding. */
function localBox(it) {
  switch (it.type) {
    case 'stroke':
    case 'line':
    case 'arrow':
      return pointsBox(it);
    case 'connector':
      return bboxOfPoints([{ x: it.ax, y: it.ay }, { x: it.bx, y: it.by }]);
    case 'rect':
    case 'ellipse':
    case 'polygon':
    case 'image':
    case 'pixel':
    case 'droste': {
      const minX = Math.min(it.x, it.x + it.w);
      const minY = Math.min(it.y, it.y + it.h);
      return { minX, minY, maxX: minX + Math.abs(it.w), maxY: minY + Math.abs(it.h) };
    }
    case 'text': {
      const { w, h } = textMetrics(it);
      return { minX: it.x, minY: it.y, maxX: it.x + w, maxY: it.y + h };
    }
    default:
      return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
}

/**
 * Shift a single item's world geometry by (dx,dy), in place. Points-based items
 * get a FRESH points array — the bbox / cull-index caches key on the points
 * array's IDENTITY, so an in-place element mutation would leave a STALE box (the
 * item would cull as if it never moved). See the _pointBoxCache invariant above.
 * A droste portal also carries a world-space `src` snapshot + `srcBBox` that must
 * ride along, or its recursive contents jump relative to its frame.
 *
 * Used by floating-origin rebasing (Scene.shiftAll): the whole document is slid
 * so the active region sits near coordinate 0, where f64 has the most precision.
 */
export function shiftItem(it, dx, dy) {
  if (!dx && !dy) return;
  switch (it.type) {
    case 'stroke':
    case 'line':
    case 'arrow':
      if (Array.isArray(it.points)) it.points = it.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }));
      break;
    case 'connector':                       // ax..by are render caches (re-resolved each frame)
      it.ax += dx; it.ay += dy; it.bx += dx; it.by += dy;
      break;
    case 'droste':
      it.x += dx; it.y += dy;
      if (Array.isArray(it.src)) for (const s of it.src) shiftItem(s, dx, dy);
      if (it.srcBBox) it.srcBBox = { minX: it.srcBBox.minX + dx, minY: it.srcBBox.minY + dy,
                                     maxX: it.srcBBox.maxX + dx, maxY: it.srcBBox.maxY + dy };
      break;
    default:                                // rect, ellipse, polygon, image, text, pixel
      if (Number.isFinite(it.x)) it.x += dx;
      if (Number.isFinite(it.y)) it.y += dy;
  }
}

/** Centre of a rotatable item, in world units (the pivot its `rot` turns about). */
export function rotCenter(it) {
  if (it.type === 'text') { const { w, h } = textMetrics(it); return { x: it.x + w / 2, y: it.y + h / 2 }; }
  return { x: it.x + it.w / 2, y: it.y + it.h / 2 };
}

/** World-space bounding box for any item type, padded by half stroke width.
 *  For a rotated item this is the AABB of its rotated corners. */
export function itemBBox(it) {
  let b = localBox(it);
  if (it.rot && ROTATABLE.has(it.type)) {
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    let nx0 = Infinity, ny0 = Infinity, nx1 = -Infinity, ny1 = -Infinity;
    for (const [px, py] of [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]]) {
      const r = rotatePoint(px, py, cx, cy, it.rot);
      if (r.x < nx0) nx0 = r.x; if (r.y < ny0) ny0 = r.y;
      if (r.x > nx1) nx1 = r.x; if (r.y > ny1) ny1 = r.y;
    }
    b = { minX: nx0, minY: ny0, maxX: nx1, maxY: ny1 };
  }
  // Tiny epsilon so a degenerate (zero-area) item still has a non-empty bbox for
  // hit-testing / spatial queries. It MUST be relative to the item's own size, not
  // an absolute world constant: a fixed 1e-9 world units is sub-pixel at normal
  // zoom but balloons to ~6.6e26 px at 2^119 (1e-9·2^119), which dominates a
  // deep-zoom-drawn item's bbox and throws its selection AABB / rotate-scale
  // handles off to infinity (Danielle, 2026-06-28). Cap the epsilon at a small
  // fraction of the span so it can never exceed the geometry it pads. At normal
  // scale span·1e-3 ≫ 1e-9 so the cap is inactive — byte-identical to the old
  // fixed 1e-9 for any item ≥ 1e-6 world units across (i.e. all normal content);
  // a genuinely zero-extent point keeps the 1e-9 floor.
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const eps = span > 0 ? Math.min(1e-9, span * 1e-3) : 1e-9;
  const pad = (it.width || 0) / 2 + eps;
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

/** Area centroid + signed-area of a polygon (verts in order), via the shoelace
 *  formula. Returns {x,y,area,perim}; on a degenerate (≈zero-area) polygon the
 *  centroid falls back to the plain vertex average so it is never NaN. */
function polyCentroid(verts) {
  const n = verts.length;
  let a2 = 0, cx = 0, cy = 0, perim = 0;       // a2 = 2·signed area
  for (let i = 0; i < n; i++) {
    const p = verts[i], q = verts[(i + 1) % n];
    const cross = p.x * q.y - q.x * p.y;
    a2 += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
    perim += dist(p.x, p.y, q.x, q.y);
  }
  const area = a2 / 2;
  if (Math.abs(area) < 1e-12) {                // collinear / zero-area → vertex average
    let sx = 0, sy = 0;
    for (const v of verts) { sx += v.x; sy += v.y; }
    return { x: sx / n, y: sy / n, area: 0, perim };
  }
  return { x: cx / (3 * a2), y: cy / (3 * a2), area: Math.abs(area), perim };
}

/** Length-weighted centroid of a polyline (the balance point of a uniform-density
 *  WIRE along the path) + its total length. A single point returns that point,
 *  len 0. Used for open items (line/arrow/stroke) in the centre-of-mass pivot. */
function polylineCentroid(pts) {
  if (!pts || !pts.length) return { x: 0, y: 0, len: 0 };
  if (pts.length === 1) return { x: pts[0].x, y: pts[0].y, len: 0 };
  let cx = 0, cy = 0, len = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const l = dist(a.x, a.y, b.x, b.y);
    cx += (a.x + b.x) / 2 * l; cy += (a.y + b.y) / 2 * l; len += l;
  }
  if (len < 1e-12) return { x: pts[0].x, y: pts[0].y, len: 0 };
  return { x: cx / len, y: cy / len, len };
}

/**
 * Centre of mass + mass of ONE item, in world coords, for the "pivot centre of
 * mass" mode (an opt-in alternative to the bbox-centre pivot). Returns
 * {x, y, mass, len}.
 *
 * Mass model (gemma's call — keeps a mixed selection's pivot continuous, no jump
 * when a fill joins a line selection): 2D shapes use their filled AREA and area
 * centroid; 1D paths (line/arrow/stroke/connector) use length × stroke-width as a
 * "virtual area" and their length-weighted centroid, so a thick heavy line pulls
 * the pivot by its visual weight. `len` is the bare path/perimeter length, used
 * by the caller only as a last-resort weight when a whole selection sums to mass
 * 0 (e.g. width-0 hairlines); `mass` may be 0 for a single point.
 */
export function itemCentroidMass(it) {
  switch (it.type) {
    case 'stroke':
    case 'line':
    case 'arrow': {
      const c = polylineCentroid(it.points);
      return { x: c.x, y: c.y, mass: c.len * (it.width || 0), len: c.len };
    }
    case 'connector': {
      const mx = (it.ax + it.bx) / 2, my = (it.ay + it.by) / 2;
      const len = dist(it.ax, it.ay, it.bx, it.by);
      return { x: mx, y: my, mass: len * (it.width || 0), len };
    }
    case 'polygon': {
      let verts = polygonVertices(it);
      if (it.rot) { const c = rotCenter(it); verts = verts.map(p => rotatePoint(p.x, p.y, c.x, c.y, it.rot)); }
      const c = polyCentroid(verts);
      return { x: c.x, y: c.y, mass: c.area, len: c.perim };
    }
    case 'ellipse': {
      const c = rotCenter(it);                 // centre is rotation-invariant
      const rx = Math.abs(it.w) / 2, ry = Math.abs(it.h) / 2;
      return { x: c.x, y: c.y, mass: Math.PI * rx * ry, len: Math.PI * (rx + ry) };
    }
    case 'text': {
      const { w, h } = textMetrics(it);
      return { x: it.x + w / 2, y: it.y + h / 2, mass: Math.abs(w * h), len: 2 * (Math.abs(w) + Math.abs(h)) };
    }
    case 'rect':
    case 'image':
    case 'pixel':
    case 'droste':
    default: {
      const c = rotCenter(it);                 // centre is rotation-invariant
      const w = Math.abs(it.w || 0), h = Math.abs(it.h || 0);
      return { x: c.x, y: c.y, mass: w * h, len: 2 * (w + h) };
    }
  }
}

/** Does an item lie under world point (x,y) within `tol` world units? */
export function hitTest(it, x, y, tol) {
  // For a rotated box, map the query point into the item's local frame so the
  // existing axis-aligned tests below work unchanged.
  if (it.rot && ROTATABLE.has(it.type)) {
    const c = rotCenter(it);
    const p = rotatePoint(x, y, c.x, c.y, -it.rot);
    x = p.x; y = p.y;
  }
  const reach = tol + (it.width || 0) / 2;
  switch (it.type) {
    case 'stroke':
    case 'line':
    case 'arrow': {
      const p = it.points;
      for (let i = 1; i < p.length; i++) {
        if (distToSegment(x, y, p[i - 1].x, p[i - 1].y, p[i].x, p[i].y) <= reach) return true;
      }
      if (p.length === 1) return dist(x, y, p[0].x, p[0].y) <= reach;
      return false;
    }
    case 'connector':
      return distToSegment(x, y, it.ax, it.ay, it.bx, it.by) <= reach;
    case 'polygon': {
      const verts = polygonVertices(it);
      if (it.fill && pointInPolygon(x, y, verts)) return true;
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i], b = verts[(i + 1) % verts.length];
        if (distToSegment(x, y, a.x, a.y, b.x, b.y) <= reach) return true;
      }
      return false;
    }
    case 'image':
    case 'pixel':
    case 'droste': {
      // images / pixel sprites / recursive portals are rectangular: a hit
      // anywhere inside (plus reach) selects the whole object/frame.
      const r = normRect(it);
      return x >= r.minX - reach && x <= r.maxX + reach &&
             y >= r.minY - reach && y <= r.maxY + reach;
    }
    case 'rect': {
      const r = normRect(it);
      if (it.fill && pointInRect(x, y, r)) return true;
      return nearRectEdge(x, y, r, reach);
    }
    case 'ellipse': {
      const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
      const rx = Math.abs(it.w) / 2, ry = Math.abs(it.h) / 2;
      // only a truly degenerate (zero-radius) ellipse is unhittable. An absolute
      // 1e-9 world threshold made deep-zoom ellipses (rx ~1e-33 but hundreds of px
      // on screen) permanently un-clickable; the normalised math below is f64-safe
      // for any rx,ry > 0 (tol/reach are already screen-relative). (2026-06-28)
      if (!(rx > 0) || !(ry > 0)) return false;
      const nx = (x - cx) / rx, ny = (y - cy) / ry;
      const d = nx * nx + ny * ny;
      if (it.fill && d <= 1) return true;
      // distance from unit circle, scaled back approximately
      const ring = Math.abs(Math.sqrt(d) - 1) * Math.min(rx, ry);
      return ring <= reach;
    }
    case 'text': {
      // local (unrotated) box — the point is already in local space above
      return pointInRect(x, y, localBox(it));
    }
  }
  return false;
}

function normRect(it) {
  const minX = Math.min(it.x, it.x + it.w);
  const minY = Math.min(it.y, it.y + it.h);
  return { minX, minY, maxX: minX + Math.abs(it.w), maxY: minY + Math.abs(it.h) };
}
function nearRectEdge(x, y, r, reach) {
  const onX = x >= r.minX - reach && x <= r.maxX + reach;
  const onY = y >= r.minY - reach && y <= r.maxY + reach;
  const nearLeft = Math.abs(x - r.minX) <= reach && onY;
  const nearRight = Math.abs(x - r.maxX) <= reach && onY;
  const nearTop = Math.abs(y - r.minY) <= reach && onX;
  const nearBot = Math.abs(y - r.maxY) <= reach && onX;
  return nearLeft || nearRight || nearTop || nearBot;
}

/**
 * Zoom-dependent visibility (level of detail): an item may carry minScale /
 * maxScale (in camera pixels-per-world-unit). It only shows when the current
 * scale is within that band. This makes the canvas behave like nested worlds —
 * fine detail appears only once you zoom in far enough.
 */
export function lodVisible(it, scale) {
  if (it.minScale != null && scale < it.minScale) return false;
  if (it.maxScale != null && scale > it.maxScale) return false;
  return true;
}

/** Scale an item in place about (cx,cy) by factor s (geometry + stroke width). */
export function scaleItemAbout(it, cx, cy, s) {
  if (it.type === 'connector') return it; // endpoints are item-anchored; nothing to scale
  switch (it.type) {
    case 'stroke':
    case 'line':
    case 'arrow':
      // spread keeps per-point extras (e.g. brush pressure `p`) intact
      it.points = it.points.map(p => ({ ...p, x: cx + (p.x - cx) * s, y: cy + (p.y - cy) * s }));
      break;
    default:
      it.x = cx + (it.x - cx) * s;
      it.y = cy + (it.y - cy) * s;
      if (it.w != null) it.w *= s;
      if (it.h != null) it.h *= s;
      if (it.size != null) it.size *= s;
  }
  if (it.width != null) it.width *= s;
  // LOD thresholds scale with the geometry so nested copies reveal correctly
  if (it.minScale != null) it.minScale /= s;
  if (it.maxScale != null) it.maxScale /= s;
  return it;
}

/**
 * Rotate a set of items in place by `ang` radians about world pivot (px,py).
 * Box items accumulate `ang` into their `rot` and have their centre swung about
 * the pivot; point items (stroke/line/arrow) bake the rotation into their points.
 */
export function rotateItemsAbout(items, px, py, ang) {
  for (const it of items) {
    if (it.type === 'stroke' || it.type === 'line' || it.type === 'arrow') {
      // spread the original point so per-point extras (brush `p`) survive
      it.points = it.points.map(p => ({ ...p, ...rotatePoint(p.x, p.y, px, py, ang) }));
    } else if (ROTATABLE.has(it.type)) {
      const c = rotCenter(it);
      const nc = rotatePoint(c.x, c.y, px, py, ang);
      // shift x,y so the (unchanged-size) box re-centres on the swung centre
      it.x += nc.x - c.x; it.y += nc.y - c.y;
      it.rot = (it.rot || 0) + ang;
    }
  }
  return items;
}

/** Reflect (x,y) across the line through (cx,cy) at angle `a` (radians). */
export function reflectPoint(x, y, cx, cy, a) {
  const dx = x - cx, dy = y - cy;
  const c = Math.cos(2 * a), s = Math.sin(2 * a);
  return { x: cx + dx * c + dy * s, y: cy + dx * s - dy * c };
}

/**
 * Reflect a set of items in place across the world line through (cx,cy) at angle
 * `a`. Point items (stroke/line/arrow) reflect each point exactly. Box items
 * (rect/ellipse/…) reflect their centre and negate their rotation about the
 * axis (`rot' = 2a - rot`) — an EXACT reflection for the symmetric shapes the
 * drawing tools produce (rect/ellipse), and a symmetric (rotation-equivalent)
 * copy for regular polygons/stars. Connectors are item-anchored → no-op.
 * Used by the symmetry/mandala mode to build mirror copies.
 */
export function reflectItemsAbout(items, cx, cy, a) {
  for (const it of items) {
    if (it.type === 'stroke' || it.type === 'line' || it.type === 'arrow') {
      it.points = it.points.map(p => ({ ...p, ...reflectPoint(p.x, p.y, cx, cy, a) }));
    } else if (ROTATABLE.has(it.type)) {
      const c = rotCenter(it);
      const nc = reflectPoint(c.x, c.y, cx, cy, a);
      it.x += nc.x - c.x; it.y += nc.y - c.y;
      it.rot = 2 * a - (it.rot || 0);
    }
  }
  return items;
}

/** Translate an item in place by (dx,dy) world units. Returns the item. */
export function translateItem(it, dx, dy) {
  switch (it.type) {
    case 'connector':
      break; // endpoints follow the items it links; no independent position
    case 'stroke':
    case 'line':
    case 'arrow':
      it.points = it.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }));
      break;
    default:
      it.x += dx; it.y += dy;
  }
  return it;
}

// Below this many items, every spatial query (render cull, hit-test, marquee)
// just scans the array linearly — the proven path with zero index overhead. At
// or above it, the x-sorted spatial index earns its keep. Matches the renderer's
// CULL_INDEX_MIN so the same index serves both render culling and interaction.
const SPATIAL_MIN = 2000;

/**
 * The document: an ordered list of items plus a world-origin offset used for
 * deep-zoom precision rebasing. The scene fires `onChange` after mutations so
 * the app can persist & redraw.
 */
export class Scene {
  constructor() {
    this.items = [];
    this.onChange = null;
    this._index = new Map(); // id -> item
    this._rev = 0;           // monotonic doc revision — every geometry/style edit
                             // routes through _touch(), so consumers (cull index,
                             // bounds cache, minimap) can cheaply detect staleness
    this._boundsCache = null;
    this._spatial = null;    // x-sorted spatial index, lazily built, rev-cached
                             // (see _ensureSpatialIndex — shared by the renderer's
                             // viewport cull AND pick / marquee hit-testing)
    // Floating-origin offset for deep-zoom precision rebasing. Stored item coords
    // are "live" space; the TRUE world coordinate of anything = stored + origin.
    // The app slides the whole document (Scene.shiftAll) so the camera stays near
    // (0,0) at extreme zoom — keeping live magnitudes small, where f64 holds the
    // most precision — and banks the slide here so true coords stay invariant.
    // Defaults to (0,0) and only ever moves at extreme zoom, so normal documents
    // (and every existing test/snapshot) are byte-identical. See App._maybeRebase
    // and tests/_precisioncheck.mjs.
    this.origin = { x: 0, y: 0 };

    // ---- NAMED LAYERS (z-containers with per-layer compositing) ----
    // Ordered bottom→top. Every item belongs to exactly one layer (by `layerId`),
    // and a layer's POSITION here dominates item z-order across layers (items keep
    // their relative order WITHIN a layer — `_regroup` enforces it on the items
    // array so it stays the single source of z-truth for cull/pick/splat). A fresh
    // doc has ONE pristine base layer ('layer-0') and items carry NO layerId, so
    // the whole system is invisible — byte-identical JSON + render — until a second
    // layer is created, at which point every item is MATERIALISED with an explicit
    // layerId (see _materializeLayers). Per-layer opacity/blend composite the layer
    // as a unit via an offscreen buffer (renderer); hidden/locked cascade to its
    // items (isItemHidden/isItemLocked). The base layer's fixed id avoids spending
    // a uid() in the constructor, so existing item-id sequences are untouched.
    this.layers = [{ id: 'layer-0', name: 'Layer 1', hidden: false, locked: false, opacity: 1, blend: 'normal' }];
    this.activeLayerId = 'layer-0';
    this._layersRev = 0;     // bumped on any layer mutation; _layerLookup caches off it
    this._layerCache = null;
  }

  /**
   * Slide EVERY item's geometry by (dx,dy) and bank the inverse into `origin`, so
   * the TRUE world coordinate (stored + origin) of everything is unchanged — a
   * purely book-keeping move with no visible effect when the camera is shifted by
   * the same delta in lock-step (which the caller does). O(N); only called on an
   * actual rebase (rare — extreme pan at extreme zoom), never per frame.
   */
  shiftAll(dx, dy) {
    if (!dx && !dy) return;
    for (const it of this.items) shiftItem(it, dx, dy);
    this.origin.x -= dx; this.origin.y -= dy;   // true = stored + origin stays constant
    this._touch();                              // invalidate bounds + spatial index, redraw
  }

  _touch() { this._rev++; this._boundsCache = null; if (this.onChange) this.onChange(); }

  /**
   * Build (or reuse) the x-sorted spatial index: one `{it, zi, minX..maxY}`
   * entry per item, ascending `minX`, plus `maxW` (the TRUE global max item
   * width — the lower-bound of any x-slice search starts at `minX - maxW`, so it
   * MUST be the real max or a wide item gets falsely culled). Rebuilt ONLY when
   * `_rev` changes (every geometry/style edit bumps it via `_touch`) or the items
   * array is swapped — never on pure pan/zoom. itemBBox is rev-stable (its point
   * cache invalidates when an item's points array is replaced), so a cached entry
   * bbox always equals a fresh `itemBBox(it)` at the same `_rev`.
   *
   * This is the single source of truth for the index; `renderer._cullCandidates`
   * binary-searches these same entries for the viewport, and `queryEntries` below
   * does the same for hit-testing — so a huge scene pays ONE O(N log N) build per
   * edit, not one per consumer.
   */
  _ensureSpatialIndex() {
    const items = this.items;
    const cur = this._spatial;
    if (cur && cur.items === items && cur.rev === this._rev) return cur;
    const n = items.length;
    const entries = new Array(n);
    let maxW = 0;
    for (let i = 0; i < n; i++) {
      const it = items[i];
      const b = itemBBox(it);
      entries[i] = { it, zi: i, minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
      const w = b.maxX - b.minX;
      if (w > maxW && isFinite(w)) maxW = w;   // empty/degenerate boxes don't widen the search
    }
    entries.sort((a, b) => a.minX - b.minX);   // ascending minX (Infinity boxes sort last)
    this._spatial = { items, rev: this._rev, entries, maxW };
    return this._spatial;
  }

  /**
   * Index entries whose (padded) bbox intersects the world `rect`, via a
   * binary-searched x-slice then a y-reject. Returns `null` below SPATIAL_MIN
   * items — the caller should linear-scan (the index isn't worth its build cost
   * for small scenes, and below the threshold it may not even be built). Entries
   * come back in x-sorted order; callers that need z-order sort by `.zi`.
   *
   * The overlap test is identical to `rectsIntersect(itemBBox(it), rect)`, so the
   * returned set exactly matches a brute-force `items.filter(...)` — just without
   * touching the items that can't possibly be near `rect`.
   */
  queryEntries(rect) {
    if (this.items.length < SPATIAL_MIN) return null;
    const { entries, maxW } = this._ensureSpatialIndex();
    const n = entries.length;
    // lower bound: first entry whose minX >= rect.minX - maxW. Anything left of
    // that ends before the rect begins (its maxX <= minX + maxW < rect.minX).
    let lo = 0, hi = n; const target = rect.minX - maxW;
    while (lo < hi) { const m = (lo + hi) >> 1; if (entries[m].minX < target) lo = m + 1; else hi = m; }
    // upper bound: first entry whose minX > rect.maxX — nothing past it overlaps in x.
    let ulo = lo, uhi = n; const xmax = rect.maxX;
    while (ulo < uhi) { const m = (ulo + uhi) >> 1; if (entries[m].minX <= xmax) ulo = m + 1; else uhi = m; }
    const hiEnd = ulo;
    const out = [];
    for (let i = lo; i < hiEnd; i++) {
      const e = entries[i];
      if (e.maxX < rect.minX) continue;                       // right edge left of the rect
      if (e.maxY < rect.minY || e.minY > rect.maxY) continue; // y reject
      out.push(e);
    }
    return out;
  }

  add(item) {
    // New items join the ACTIVE layer (only tagged once layers are non-trivial —
    // a single-layer doc leaves items layerId-free, byte-identical to before).
    if (this.layers.length > 1 && item.layerId == null) item.layerId = this.activeLayerId;
    this._insertGrouped(item);
    this._index.set(item.id, item);
    this._touch();
    return item;
  }
  addMany(items) {
    const multi = this.layers.length > 1;
    for (const it of items) {
      if (multi && it.layerId == null) it.layerId = this.activeLayerId;
      this.items.push(it); this._index.set(it.id, it);
    }
    if (multi && items.length) this._regroupItems();   // restore the grouped invariant once
    if (items.length) this._touch();
  }

  /** Append `item` at the END of its layer's contiguous run (front-most within
   *  the layer), preserving the grouped-by-layer-order invariant. A single-layer
   *  doc (or a layerId-less item) just pushes — the byte-identical fast path. */
  _insertGrouped(item) {
    if (this.layers.length <= 1 || item.layerId == null) { this.items.push(item); return; }
    const rankOf = this._layerRankFn();
    const mine = rankOf(item);
    const arr = this.items;
    let idx = arr.length;                      // default: very top
    for (let i = 0; i < arr.length; i++) { if (rankOf(arr[i]) > mine) { idx = i; break; } }
    arr.splice(idx, 0, item);
  }
  remove(id) {
    const i = this.items.findIndex(it => it.id === id);
    if (i >= 0) {
      const [it] = this.items.splice(i, 1);
      this._index.delete(id);
      this._touch();
      return it;
    }
    return null;
  }
  removeMany(ids) {
    const set = new Set(ids);
    let removed = 0;
    this.items = this.items.filter(it => {
      if (set.has(it.id)) { this._index.delete(it.id); removed++; return false; }
      return true;
    });
    if (removed) this._touch();
    return removed;
  }
  byId(id) { return this._index.get(id) || null; }

  // ---- parenting / hierarchy queries ----
  /** Direct children of `id` (items whose `parent` === id), in document z-order. */
  childrenOf(id) { return this.items.filter(it => it.parent === id); }

  /** All transitive descendant ids of the given id(s) — children, grandchildren,
   *  … — EXCLUDING the seed ids themselves. Cycle/danger-safe via a visited set.
   *  O(N): builds the parent→children index once, then walks it. */
  descendantsOf(ids) {
    const seeds = Array.isArray(ids) ? ids : [ids];
    const byParent = new Map(); // parentId -> [childId]
    for (const it of this.items) {
      if (it.parent == null) continue;
      if (!byParent.has(it.parent)) byParent.set(it.parent, []);
      byParent.get(it.parent).push(it.id);
    }
    const out = new Set();
    const visited = new Set(seeds); // guard against pre-existing cycles
    const stack = [...seeds];
    while (stack.length) {
      const kids = byParent.get(stack.pop());
      if (!kids) continue;
      for (const kid of kids) {
        if (!visited.has(kid)) { visited.add(kid); out.add(kid); stack.push(kid); }
      }
    }
    return out;
  }

  /** Would making `childId` a child of `newParentId` create a cycle? True if
   *  they're the same item or `newParentId` is already a descendant of `childId`. */
  wouldCreateCycle(childId, newParentId) {
    if (childId === newParentId) return true;
    return this.descendantsOf(childId).has(newParentId);
  }

  // ---- named layers ----
  _touchLayers() { this._layersRev++; this._layerCache = null; }

  /** Cached id→{layer,rank} map + hidden/locked id Sets, rebuilt only when the
   *  layers array mutates (rare) — keeps per-item visibility checks O(1). */
  _layerLookup() {
    if (this._layerCache) return this._layerCache;
    const map = new Map(), hidden = new Set(), locked = new Set();
    this.layers.forEach((L, i) => {
      map.set(L.id, { layer: L, rank: i });
      if (L.hidden) hidden.add(L.id);
      if (L.locked) locked.add(L.id);
    });
    this._layerCache = { map, hidden, locked, baseId: this.layers[0].id };
    return this._layerCache;
  }
  /** A fast rank(item) closure (snapshot of current layer order). */
  _layerRankFn() {
    const lk = this._layerLookup();
    const base = lk.baseId;
    return (it) => { const e = lk.map.get(it.layerId || base); return e ? e.rank : 0; };
  }

  layerById(id) { return this.layers.find(L => L.id === id) || null; }
  /** The layer object an item belongs to (explicit layerId, else the bottom layer). */
  layerOf(it) { const lk = this._layerLookup(); const e = lk.map.get(it.layerId || lk.baseId); return e ? e.layer : this.layers[0]; }
  /** Effective on-canvas hidden / un-grabbable = item's own flag OR its layer's. */
  isItemHidden(it) { if (it.hidden) return true; const lk = this._layerLookup(); return lk.hidden.has(it.layerId || lk.baseId); }
  isItemLocked(it) { if (it.locked) return true; const lk = this._layerLookup(); return lk.locked.has(it.layerId || lk.baseId); }

  /** Give EVERY layerId-less item an explicit id (= the bottom/base layer). Run
   *  before any op that can change which layer is the bottom one, so "no layerId ⇒
   *  base" can never silently re-bind an item to a different layer. */
  _materializeLayers() {
    const baseId = this.layers[0].id;
    for (const it of this.items) if (it.layerId == null) it.layerId = baseId;
  }

  /** Stable-sort the items array by layer rank (V8 sort is stable), so all of a
   *  layer's items are contiguous and in layer order — keeping the items array the
   *  one true z-order. Items keep their relative order within a layer. */
  _regroupItems() {
    if (this.layers.length <= 1) return;
    const rankOf = this._layerRankFn();
    this.items.sort((a, b) => rankOf(a) - rankOf(b));
  }

  /** Add a new layer above `aboveId` (default: top). Becomes the active layer. */
  addLayer(name, { aboveId } = {}) {
    this._materializeLayers();                 // pin existing items before reshaping
    const L = { id: uid('L'), name: name || `Layer ${this.layers.length + 1}`,
                hidden: false, locked: false, opacity: 1, blend: 'normal' };
    let idx = this.layers.length;
    if (aboveId != null) { const i = this.layers.findIndex(x => x.id === aboveId); if (i >= 0) idx = i + 1; }
    this.layers.splice(idx, 0, L);
    this.activeLayerId = L.id;
    this._touchLayers(); this._regroupItems(); this._touch();
    return L;
  }

  /** Remove a layer (never the last one); its items fall to the neighbour below
   *  (or, when removing the bottom, the new bottom). Returns the items' new
   *  layerId so the App can build an undo. */
  removeLayer(id) {
    if (this.layers.length <= 1) return null;
    const i = this.layers.findIndex(L => L.id === id);
    if (i < 0) return null;
    this._materializeLayers();
    const targetIdx = i > 0 ? i - 1 : 1;
    const targetId = this.layers[targetIdx].id;
    for (const it of this.items) if (it.layerId === id) it.layerId = targetId;
    this.layers.splice(i, 1);
    if (this.activeLayerId === id) this.activeLayerId = this.layers[Math.min(i, this.layers.length - 1)].id;
    this._touchLayers(); this._regroupItems(); this._touch();
    return targetId;
  }

  /** Move a layer one step down (-1) or up (+1) in the stack. */
  moveLayer(id, dir) {
    this._materializeLayers();
    const i = this.layers.findIndex(L => L.id === id);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= this.layers.length) return false;
    const [L] = this.layers.splice(i, 1);
    this.layers.splice(j, 0, L);
    this._touchLayers(); this._regroupItems(); this._touch();
    return true;
  }

  /** Reorder the whole stack to match `ids` bottom→top (used by undo/redo). */
  applyLayerOrder(ids) {
    this._materializeLayers();
    const next = [];
    for (const id of ids) { const L = this.layerById(id); if (L) next.push(L); }
    for (const L of this.layers) if (!next.includes(L)) next.push(L);  // keep any unmentioned
    if (next.length === this.layers.length) this.layers = next;
    this._touchLayers(); this._regroupItems(); this._touch();
  }

  /** Patch a layer's props (name/hidden/locked/opacity/blend). Pure compositing/
   *  flag change — no geometry move, no reorder. */
  setLayerProps(id, props) {
    const L = this.layerById(id); if (!L) return;
    Object.assign(L, props);
    this._touchLayers(); this._touch();
  }

  /** Reassign the given items to `layerId` and restore grouping. */
  assignToLayer(ids, layerId) {
    if (!this.layerById(layerId)) return;
    this._materializeLayers();
    const set = ids instanceof Set ? ids : new Set(ids);
    for (const it of this.items) if (set.has(it.id)) it.layerId = layerId;
    this._regroupItems(); this._touch();
  }

  /** Ids of items in a layer, in z-order (bottom→top within the layer). */
  itemsInLayer(id) {
    const baseId = this.layers[0].id;
    return this.items.filter(it => (it.layerId || baseId) === id);
  }

  clear() {
    if (!this.items.length) return;
    this.items = [];
    this._index.clear();
    this._touch();
  }

  /** Reorder items to match the given id sequence (used by z-order undo/redo). */
  _applyOrder(ids) {
    const next = [];
    for (const id of ids) { const it = this._index.get(id); if (it) next.push(it); }
    // keep any items not mentioned (shouldn't happen) at the end
    if (next.length !== this.items.length) {
      const seen = new Set(ids);
      for (const it of this.items) if (!seen.has(it.id)) next.push(it);
    }
    this.items = next;
    this._touch();
  }

  count() { return this.items.length; }

  /** All items whose bbox intersects the world rect, in document z-order. Uses
   *  the spatial index for big scenes; an exact-match linear scan below it. */
  itemsInRect(rect) {
    const ents = this.queryEntries(rect);
    if (ents === null) return this.items.filter(it => rectsIntersect(itemBBox(it), rect));
    ents.sort((a, b) => a.zi - b.zi);               // restore document z-order
    return ents.map(e => e.it);
  }
  /** Items fully contained in rect (for marquee selection). Skips hidden &
   *  locked items — neither can be grabbed by a selection rectangle. The index
   *  yields an overlap superset; the rectContains test then keeps only the fully
   *  enclosed ones, so the result is identical to a full linear scan. */
  itemsContainedIn(rect) {
    const ents = this.queryEntries(rect);
    const cand = ents === null ? this.items : (ents.sort((a, b) => a.zi - b.zi), ents.map(e => e.it));
    return cand.filter(it => !this.isItemHidden(it) && !this.isItemLocked(it) && rectContains(rect, itemBBox(it)));
  }

  /** Top-most item under a world point, or null. Optional `filter` excludes
   *  items. Hidden items are always skipped (they aren't on screen); `locked`
   *  is left to the caller's `filter` so e.g. connectors can still target them.
   *
   *  Big scenes query the spatial index for the small set of items whose bbox is
   *  within `tol` of the point (a `tol`-expanded window is a correct superset:
   *  any true hit lies within `tol` of the item's padded bbox), then hit-test
   *  those in z-order. This turns a per-pointer-event O(N) scan — felt as drag
   *  jank when erasing/hovering over tens of thousands of items — into O(log N +
   *  candidates). Below the threshold it's the original exact linear scan. */
  pick(x, y, tol, filter = null) {
    const ents = this.queryEntries({ minX: x - tol, minY: y - tol, maxX: x + tol, maxY: y + tol });
    if (ents === null) {
      for (let i = this.items.length - 1; i >= 0; i--) {
        const it = this.items[i];
        if (this.isItemHidden(it)) continue;
        if (filter && !filter(it)) continue;
        if (it.type === 'connector' && (!this._index.get(it.from) || !this._index.get(it.to))) continue;
        if (hitTest(it, x, y, tol)) return it;
      }
      return null;
    }
    ents.sort((a, b) => b.zi - a.zi);               // top-most (highest z) first
    for (const e of ents) {
      const it = e.it;
      if (this.isItemHidden(it)) continue;
      if (filter && !filter(it)) continue;
      if (it.type === 'connector' && (!this._index.get(it.from) || !this._index.get(it.to))) continue;
      if (hitTest(it, x, y, tol)) return it;
    }
    return null;
  }

  /** Bounding box of the whole document (or null when empty). Cached per doc
   *  revision: pure pan/zoom (which never calls _touch) reuses it, so the
   *  minimap / fit-all stop re-scanning every item each frame. A fresh copy is
   *  returned so callers that mutate the result can't corrupt the cache. */
  bounds() {
    if (!this.items.length) return null;
    if (this._boundsCache && this._boundsCache.rev === this._rev) return { ...this._boundsCache.box };
    let r = itemBBox(this.items[0]);
    r = { ...r };
    for (let i = 1; i < this.items.length; i++) {
      const b = itemBBox(this.items[i]);
      if (b.minX < r.minX) r.minX = b.minX;
      if (b.minY < r.minY) r.minY = b.minY;
      if (b.maxX > r.maxX) r.maxX = b.maxX;
      if (b.maxY > r.maxY) r.maxY = b.maxY;
    }
    this._boundsCache = { rev: this._rev, box: r };
    return { ...r };
  }

  toJSON() {
    // Persist live coords + the floating origin SEPARATELY: folding origin back
    // into coords would re-introduce the very cancellation rebasing avoids (a
    // deep-zoom detail at stored 2^-390 would vanish into a unit-scale origin).
    // `origin` is emitted only when non-zero, so ordinary documents stay byte-
    // identical to the pre-rebasing format.
    const o = this.origin;
    const out = (o.x || o.y)
      ? { version: 2, items: this.items, origin: { x: o.x, y: o.y } }
      : { version: 2, items: this.items };
    // Emit layers only when NON-TRIVIAL (more than the pristine base) — a plain
    // single-layer doc stays byte-identical to the pre-layers format.
    if (this._layersNonTrivial()) { out.layers = this.layers; out.activeLayerId = this.activeLayerId; }
    return out;
  }
  /** True when the layer state carries information a re-load would otherwise lose
   *  (a doc the user actually touched) — false for the untouched default. */
  _layersNonTrivial() {
    if (this.layers.length !== 1) return true;
    const L = this.layers[0];
    return L.id !== 'layer-0' || L.name !== 'Layer 1' || L.hidden || L.locked ||
           L.opacity < 1 || (L.blend && L.blend !== 'normal');
  }
  loadJSON(data, { merge = false } = {}) {
    const items = (data && Array.isArray(data.items)) ? data.items : [];
    if (!merge) {
      this.items = []; this._index.clear();
      const o = data && data.origin;
      this.origin = (o && Number.isFinite(o.x) && Number.isFinite(o.y)) ? { x: o.x, y: o.y } : { x: 0, y: 0 };
      if (data && Array.isArray(data.layers) && data.layers.length) {
        this.layers = data.layers.map(normalizeLayer);
        this.activeLayerId = (data.activeLayerId && this.layerById(data.activeLayerId)) ? data.activeLayerId : this.layers[0].id;
      } else {
        this.layers = [{ id: 'layer-0', name: 'Layer 1', hidden: false, locked: false, opacity: 1, blend: 'normal' }];
        this.activeLayerId = 'layer-0';
      }
      this._touchLayers();
    }
    for (const it of items) {
      if (!it.id) it.id = uid('x');
      this.items.push(it);
      this._index.set(it.id, it);
    }
    this._reconcileItemLayers();   // drop layerIds that don't resolve (orphans → base)
    this._touch();
  }
  /** Re-home any item whose layerId names a layer that isn't present (paste from
   *  another doc, a hand-edited file) onto the base layer, so nothing renders into
   *  a phantom layer. */
  _reconcileItemLayers() {
    if (this.layers.length <= 1) return;
    const lk = this._layerLookup();
    const baseId = this.layers[0].id;
    for (const it of this.items) if (it.layerId != null && !lk.map.has(it.layerId)) it.layerId = baseId;
  }
}

/** Validate/normalise a persisted layer record into the canonical shape. */
function normalizeLayer(L) {
  L = L || {};
  const opacity = (typeof L.opacity === 'number' && L.opacity >= 0 && L.opacity <= 1) ? L.opacity : 1;
  return {
    id: L.id || uid('L'),
    name: typeof L.name === 'string' ? L.name : 'Layer',
    hidden: !!L.hidden,
    locked: !!L.locked,
    opacity,
    blend: typeof L.blend === 'string' ? L.blend : 'normal',
  };
}
