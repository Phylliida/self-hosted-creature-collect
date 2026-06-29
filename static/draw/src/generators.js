// Pure procedural-art generators. Each returns an array of *item spec* objects
// (no ids) in world coordinates; the app wraps them into real scene items.
// These exist to show off infinite zoom: several recurse down many octaves so
// there's fresh detail however far you zoom in.

import { penroseP3, ammannBeenker, pinwheel } from './penrose.js';
import { hatTiling } from './hat.js';
import { spectreTiling } from './spectre.js';
import { uniformTiling } from './uniform.js';
import { lavesTiling } from './laves.js';
import { bboxOfPoints } from './util.js';

const TAU = Math.PI * 2;

/** A recursive binary tree of line segments. Depth N → up to 2^N twigs. */
export function fractalTree({ depth = 11, len = 280, angle = 0.42, shrink = 0.74,
                              x = 0, y = 400, color = '#69db7c' } = {}) {
  const items = [];
  const rec = (px, py, dir, length, d) => {
    if (d > depth || length < 1e-7) return;
    const ex = px + Math.cos(dir) * length;
    const ey = py + Math.sin(dir) * length;
    const w = Math.max(length * 0.06, length * 0.012);
    const t = d / depth;
    // fade from trunk color to a leafy tip
    const col = d > depth - 3 ? '#b7f7c2' : color;
    items.push({ type: 'line', points: [{ x: px, y: py }, { x: ex, y: ey }], color: col, width: w });
    rec(ex, ey, dir - angle, length * shrink, d + 1);
    rec(ex, ey, dir + angle, length * shrink, d + 1);
  };
  rec(x, y, -Math.PI / 2, len, 0);
  return items;
}

/**
 * A logarithmic spiral of shrinking, rotating squares. Great for deep zoom:
 * with shrink 0.86 and 90 squares the smallest is ~0.86^90 ≈ 1.4e-6 of the
 * first, so you can zoom ~700,000× into the eye and still find structure.
 */
export function spiralSquares({ count = 90, size = 320, shrink = 0.9, turn = 0.5,
                                x = 0, y = 0 } = {}) {
  const items = [];
  const palette = ['#ff5b6e', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#b197fc'];
  let s = size, ang = 0, cx = x, cy = y;
  for (let i = 0; i < count; i++) {
    const half = s / 2;
    // four corners rotated by `ang` about (cx,cy)
    const pts = [[-half, -half], [half, -half], [half, half], [-half, half], [-half, -half]]
      .map(([dx, dy]) => ({
        x: cx + dx * Math.cos(ang) - dy * Math.sin(ang),
        y: cy + dx * Math.sin(ang) + dy * Math.cos(ang),
      }));
    items.push({ type: 'stroke', points: pts, color: palette[i % palette.length], width: Math.max(s * 0.02, s * 0.004) });
    // step the spiral inward toward a drifting center
    cx += Math.cos(ang) * s * 0.18;
    cy += Math.sin(ang) * s * 0.18;
    ang += turn;
    s *= shrink;
  }
  return items;
}

/**
 * A "Droste" stack of nested rings + ticks that recurses toward a point,
 * shrinking by `shrink` each step. Zooming the center reveals the same motif
 * forever (well, for `count` octaves).
 */
export function drosteRings({ count = 60, r = 300, shrink = 0.84, x = 0, y = 0,
                              color = '#5b8cff' } = {}) {
  const items = [];
  let radius = r;
  for (let i = 0; i < count; i++) {
    // approximate a circle with an ellipse item
    items.push({ type: 'ellipse', x: x - radius, y: y - radius, w: radius * 2, h: radius * 2,
                 color: i % 2 ? color : '#b197fc', width: Math.max(radius * 0.03, radius * 0.005), fill: null });
    // tick marks around the ring
    const ticks = 12;
    for (let k = 0; k < ticks; k++) {
      const a = (k / ticks) * TAU + i * 0.2;
      const inner = radius * 0.86, outer = radius * 1.0;
      items.push({
        type: 'line',
        points: [{ x: x + Math.cos(a) * inner, y: y + Math.sin(a) * inner },
                 { x: x + Math.cos(a) * outer, y: y + Math.sin(a) * outer }],
        color: '#e8e8ef', width: Math.max(radius * 0.012, radius * 0.003),
      });
    }
    radius *= shrink;
  }
  return items;
}

/** Sierpinski triangle as outlined triangles (strokes), depth octaves. */
export function sierpinski({ depth = 7, size = 520, x = 0, y = 0, color = '#ffd43b' } = {}) {
  const items = [];
  const h = size * Math.sqrt(3) / 2;
  const tri = (ax, ay, bx, by, cx, cy, d) => {
    if (d === 0) {
      items.push({ type: 'stroke',
        points: [{ x: ax, y: ay }, { x: bx, y: by }, { x: cx, y: cy }, { x: ax, y: ay }],
        color, width: Math.max(size * 0.0015, 0.05) });
      return;
    }
    const ab = [(ax + bx) / 2, (ay + by) / 2];
    const bc = [(bx + cx) / 2, (by + cy) / 2];
    const ca = [(cx + ax) / 2, (cy + ay) / 2];
    tri(ax, ay, ab[0], ab[1], ca[0], ca[1], d - 1);
    tri(ab[0], ab[1], bx, by, bc[0], bc[1], d - 1);
    tri(ca[0], ca[1], bc[0], bc[1], cx, cy, d - 1);
  };
  tri(x, y - h / 2, x - size / 2, y + h / 2, x + size / 2, y + h / 2, depth);
  return items;
}

// ============================ FRACTAL CURVES ============================
// A single continuous, self-similar polyline that threads through space — the
// "line" cousin of the recursive STAMP/PORTAL (which nest whole drawings) and of
// the TILING generators (which cover the plane with many tiles). Each `kind` is a
// deterministic, parameter-free curve whose detail multiplies with `order`, so it
// is a natural infinite-zoom citizen: more order ⇒ finer structure, same shape.

/** Hilbert space-filling curve: index→(x,y) on a 2^order grid (Wikipedia d2xy). */
function hilbertCurvePts(order) {
  const n = 1 << order, pts = [];
  for (let d = 0; d < n * n; d++) {
    let rx, ry, t = d, x = 0, y = 0;
    for (let s = 1; s < n; s *= 2) {
      rx = 1 & (t >> 1);
      ry = 1 & (t ^ rx);
      if (ry === 0) {
        if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
        const tmp = x; x = y; y = tmp;   // rotate the quadrant
      }
      x += s * rx; y += s * ry;
      t >>= 2;
    }
    pts.push({ x, y });
  }
  return pts;
}

/** Heighway dragon curve: 2^order unit segments, turning ±90° by the fold-bit rule. */
function dragonCurvePts(order) {
  const segs = 1 << order, step = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  let dir = 0, x = 0, y = 0;
  const pts = [{ x, y }];
  for (let i = 1; i <= segs; i++) {
    x += step[dir][0]; y += step[dir][1];
    pts.push({ x, y });
    // turn for the NEXT segment: left if the bit above the lowest set bit is 0
    const turn = (((i & -i) << 1) & i) === 0 ? 1 : 3;   // +1 left, +3 == −1 (mod 4) right
    dir = (dir + turn) & 3;
  }
  return pts;
}

/** Koch snowflake: a CLOSED curve — each side of a triangle subdivided `order` times. */
function kochSnowflakePts(order) {
  let pts = [0, 1, 2].map(k => {
    const a = -Math.PI / 2 + k * (2 * Math.PI / 3);
    return { x: Math.cos(a), y: Math.sin(a) };
  });
  pts.push({ ...pts[0] });                          // close the triangle
  const ang = -Math.PI / 3, c = Math.cos(ang), s = Math.sin(ang);   // outward bump (CCW)
  for (let o = 0; o < order; o++) {
    const next = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = (b.x - a.x) / 3, dy = (b.y - a.y) / 3;
      const p1 = { x: a.x + dx, y: a.y + dy };
      const p2 = { x: a.x + 2 * dx, y: a.y + 2 * dy };
      const vx = p2.x - p1.x, vy = p2.y - p1.y;      // the apex of the outward equilateral bump
      const apex = { x: p1.x + vx * c - vy * s, y: p1.y + vx * s + vy * c };
      next.push(a, p1, apex, p2);
    }
    next.push({ ...pts[pts.length - 1] });
    pts = next;
  }
  return pts;
}

/**
 * Lévy C curve: each segment A→B is replaced by the two legs A→M→B of a right
 * isosceles triangle whose apex M sits a consistent perpendicular-LEFT half-length
 * off the segment. That single replacement, iterated, is exactly the Lévy IFS (two
 * similarities of ratio 1/√2, rotations ±45°): order N → 2^N segments, and the
 * always-same-side bump is what makes it curl into its organic "C". M = A + ½(d +
 * d⊥) where d = B−A and d⊥ = (−dy, dx) — i.e. d rotated +45° and scaled by 1/√2.
 */
function levyCurvePts(order) {
  let pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
  for (let o = 0; o < order; o++) {
    const next = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      next.push({ x: a.x + 0.5 * (dx - dy), y: a.y + 0.5 * (dy + dx) }, b);
    }
    pts = next;
  }
  return pts;
}

/** Gosper (flowsnake): a HEXAGONAL space-filler via the classic A/B L-system. */
function gosperCurvePts(order) {
  const rules = { A: 'A-B--B+A++AA+B-', B: '+A-BB--B-A++A+B' };
  let s = 'A';
  for (let o = 0; o < order; o++) {
    let out = '';
    for (const ch of s) out += rules[ch] || ch;
    s = out;
  }
  const turn = Math.PI / 3;                          // 60°
  let x = 0, y = 0, a = 0;
  const pts = [{ x, y }];
  for (const ch of s) {
    if (ch === 'A' || ch === 'B') { x += Math.cos(a); y += Math.sin(a); pts.push({ x, y }); }
    else if (ch === '+') a += turn;
    else if (ch === '-') a -= turn;
  }
  return pts;
}

// Per-kind registry: default/cap order, ink colour, raw integer-lattice builder.
const CURVE_KINDS = {
  hilbert: { defOrder: 6,  maxOrder: 8,  color: '#4dabf7', build: hilbertCurvePts },
  dragon:  { defOrder: 12, maxOrder: 16, color: '#ff6b6b', build: dragonCurvePts },
  levy:    { defOrder: 14, maxOrder: 16, color: '#da77f2', build: levyCurvePts },
  koch:    { defOrder: 4,  maxOrder: 7,  color: '#74c0fc', build: kochSnowflakePts },
  gosper:  { defOrder: 4,  maxOrder: 5,  color: '#69db7c', build: gosperCurvePts },
};

/**
 * Public per-kind order metadata for the UI: { kind: { defOrder, maxOrder } }. The
 * fractal-curve picker reads this so the order slider's MAX adapts to the chosen
 * curve (Hilbert caps at 8, Dragon/Lévy at 16, Gosper at 5) and snaps to the kind's
 * default when you switch curves — the caps stay defined in ONE place (above), not
 * duplicated into the markup. minOrder is a universal 1 (order 0 is degenerate).
 */
export function curveOrderMeta() {
  const out = {};
  for (const k in CURVE_KINDS) out[k] = { defOrder: CURVE_KINDS[k].defOrder, maxOrder: CURVE_KINDS[k].maxOrder, minOrder: 1 };
  return out;
}

/**
 * A single fractal / space-filling CURVE as one continuous `stroke` item. `kind` ∈
 * {hilbert, dragon, levy, koch, gosper}; `order` sets the recursion depth (per-kind default
 * if omitted, clamped to a sane cap so a fat-fingered order can't ask for billions of
 * points). The raw integer lattice is uniformly scaled to fit `size` and centred on
 * (x,y); the stroke width tracks the finest segment so the structure stays legible at
 * every order. Deterministic ⇒ trivially testable (see curves.spec.js / _curvecheck.mjs).
 */
export function fractalCurve({ kind = 'hilbert', order = null, size = 560, x = 0, y = 0, color = null } = {}) {
  const C = CURVE_KINDS[kind] || CURVE_KINDS.hilbert;
  const o = order == null ? C.defOrder : Math.max(0, Math.min(C.maxOrder, order | 0));
  const raw = C.build(o);
  const bb = bboxOfPoints(raw);
  const span = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) || 1;
  const k = size / span;
  const ox = (bb.minX + bb.maxX) / 2, oy = (bb.minY + bb.maxY) / 2;
  const pts = raw.map(p => ({ x: x + (p.x - ox) * k, y: y + (p.y - oy) * k }));
  let segWorld = size * 0.02;
  if (pts.length > 1) segWorld = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || segWorld;
  const width = Math.max(segWorld * 0.18, size * 0.0006);
  return [{ type: 'stroke', points: pts, color: color || C.color, width }];
}

/** A field of concentric "flowers" — quick, colorful, fills the screen. */
export function flowerField({ rows = 4, cols = 6, gap = 220, x = -550, y = -330 } = {}) {
  const items = [];
  const palette = ['#ff5b6e', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#b197fc', '#f783ac'];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = x + c * gap, cy = y + r * gap;
      const petals = 6 + ((r + c) % 4);
      const rad = 60 + ((r * c) % 30);
      const col = palette[(r * cols + c) % palette.length];
      for (let p = 0; p < petals; p++) {
        const a = (p / petals) * TAU;
        items.push({ type: 'ellipse',
          x: cx + Math.cos(a) * rad * 0.5 - rad * 0.4,
          y: cy + Math.sin(a) * rad * 0.5 - rad * 0.2,
          w: rad * 0.8, h: rad * 0.4, color: col, width: 2, fill: null });
      }
      items.push({ type: 'ellipse', x: cx - 12, y: cy - 12, w: 24, h: 24, color: '#ffd43b', width: 2, fill: '#ffd43b' });
    }
  }
  return items;
}

export const GENERATORS = {
  tree: fractalTree,
  spiral: spiralSquares,
  droste: drosteRings,
  sierpinski,
  // FRACTAL CURVES — one continuous self-similar polyline (Hilbert / Dragon / Koch /
  // Gosper), picked by opts.kind. The "line" cousin of the recursive stamp: not a pile
  // of nested copies but a SINGLE line that threads through space, finer with each order.
  // See fractalCurve above; math proven in tests/_curvecheck.mjs.
  curve: fractalCurve,
  flowers: flowerField,
  // Penrose P3 rhombus tiling — the canonical APERIODIC tiling (no translational
  // symmetry, so not a wallpaper group). Self-similar under inflation → endless
  // deep-zoom structure. See src/penrose.js.
  penrose: penroseP3,
  // Ammann–Beenker — the 8-fold aperiodic tiling (square + 45° rhombus, silver
  // ratio 1+√2). A genuinely different symmetry order from Penrose's 5-fold.
  ammann: ammannBeenker,
  // Pinwheel (Conway–Radin) — one right triangle subdivided into 5 (inflation √5).
  // Its inflation rotation arctan½ is irrational·π, so tiles appear in INFINITELY
  // MANY orientations — a different KIND of aperiodicity from the finite-fold ones.
  pinwheel,
  // The HAT — the 2023 aperiodic MONOTILE ("einstein"): a SINGLE 13-gon that tiles
  // the plane but never periodically. The capstone of the tiling suite. Built by a
  // metatile (H/T/P/F) substitution; ~12% of tiles are reflected (the two fill
  // colours). See src/hat.js; math proven in tests/_hatcheck.mjs.
  hat: hatTiling,
  // The SPECTRE — the STRICTLY CHIRAL aperiodic monotile (2023): the hat without its
  // "asterisk". A single curved "ghost" shape tiles the plane aperiodically using only
  // rotations and translations — NO reflected copies, ever (one fill colour, because
  // every tile is the same shape in the same handedness). Built by Kaplan's nine-tile
  // substitution on Tile(1,1). See src/spectre.js; math proven in tests/_spectrecheck.mjs.
  spectre: spectreTiling,
  // The 11 UNIFORM tilings — the 3 regular + 8 semiregular (Archimedean) edge-to-edge
  // tilings by regular polygons (the canonical, finite, named set of "tilings"). One
  // generator parameterised by opts.kind (a vertex-config string like '4.8.8'); the UI
  // exposes the 11 via a single grouped <select>. Math proven in tests/_uniformcheck.mjs.
  uniform: uniformTiling,
  // The 11 LAVES tilings — the DUAL (Catalan) of each uniform tiling: ISOHEDRAL
  // (one tile shape repeated) where the uniform is isogonal. Generated as the
  // planar dual (a dual vertex at each uniform face centre; a dual face around each
  // uniform vertex), so all 11 — incl. the CAIRO and FLORET pentagonal tilings —
  // EMERGE from src/uniform.js rather than being hand-coded. opts.kind picks the
  // uniform tiling to dualise. Math proven in tests/_lavescheck.mjs.
  laves: lavesTiling,
};
