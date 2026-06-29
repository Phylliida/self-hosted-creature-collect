// THE SPECTRE — a STRICTLY CHIRAL APERIODIC MONOTILE (Smith–Myers–Kaplan–Goodman-
// Strauss, "A chiral aperiodic monotile", 2023). The honest capstone of the tiling
// arc: where the HAT (src/hat.js) is an "einstein with an ASTERISK" — it tiles the
// plane with a single shape but only if ~12% of the tiles are REFLECTED — the Spectre
// removes even that asterisk. A single shape tiles the whole plane aperiodically using
// ONLY rotations and translations; no mirror image is ever needed (and, with the
// curved "Spectre" edges, a reflected copy physically cannot fit at all).
//
// HOW IT TILES — the same family of METATILE SUBSTITUTION as the hat, but on a
// different prototile. The base shape is Tile(1,1): a 14-gon with alternating unit
// and √3 edges. Nine tile TYPES (Γ Δ Θ Λ Ξ Π Σ Φ Ψ) substitute into clusters of nine;
// eight of them are a single Tile(1,1), and Γ (the "Mystic") is a fused PAIR of
// Tile(1,1)s. After N substitutions a chosen supertile expands into a finite patch of
// congruent spectres. This is Craig S. Kaplan's construction (cs.uwaterloo.ca/~csk/
// spectre/spectre.js), ported faithfully here rather than reconstructed from memory —
// the sandbox has net access, so the known-correct source was fetched and saved
// verbatim in reference/csk_spectre.js, eliminating the transcription risk.
//
// THE CHIRALITY, MADE RIGOROUS. buildSupertiles pre-multiplies EVERY child placement
// by the reflection R = [-1,0,0,0,1,0]. So one substitution step flips handedness
// once, uniformly, for every child. A leaf tile at depth d therefore accumulates
// exactly d reflections — det(transform) = (-1)^d — the SAME for every tile at that
// depth. Hence no two tiles in a patch are mirror images of each other: the whole
// tiling is one handedness. (A global y-flip at render time mirrors the entire patch
// equally and changes nothing about that.) tests/_spectrecheck.mjs proves this — all
// tiles one signed-area sign — alongside monotile (one area), gap/overlap-freeness,
// growth, and a finite orientation count. This is the property that distinguishes the
// Spectre from the hat, whose _hatcheck proves the OPPOSITE (reflections are required).
//
// RENDERING. Each spectre is one whole polygon, so it rides penrose.js's `wholeTile`
// path exactly as the hat does: one filled, fully-stroked CLOSED polyline. By default
// we emit the CURVED Spectre outline (each straight edge replaced by a congruent
// bump/dent, sampled to a polyline) — the iconic "ghost" silhouette, and the shape for
// which reflection is impossible. A single fill colour is used for every tile,
// because every tile IS the same shape in the same handedness — the picture itself is
// the proof of "one monotile, no mirrors".

// ---------- affine geometry (identical convention to hat.js / hatviz) ----------
// A transform is [a,b,c,d,e,f]: (x,y) ↦ (a·x+b·y+c, d·x+e·y+f).
const PI = Math.PI;
const IDENT = [1, 0, 0, 0, 1, 0];
const pt = (x, y) => ({ x, y });
const padd = (p, q) => ({ x: p.x + q.x, y: p.y + q.y });
const psub = (p, q) => ({ x: p.x - q.x, y: p.y - q.y });
// o + a·p + b·q (an affine frame combination)
const pframe = (o, p, q, a, b) => ({ x: o.x + a * p.x + b * q.x, y: o.y + a * p.y + b * q.y });
const radians = (deg) => (deg * PI) / 180;

function inv(T) {
  const det = T[0] * T[4] - T[1] * T[3];
  return [T[4] / det, -T[1] / det, (T[1] * T[5] - T[2] * T[4]) / det,
          -T[3] / det, T[0] / det, (T[2] * T[3] - T[0] * T[5]) / det];
}
function mul(A, B) {
  return [A[0] * B[0] + A[1] * B[3], A[0] * B[1] + A[1] * B[4], A[0] * B[2] + A[1] * B[5] + A[2],
          A[3] * B[0] + A[4] * B[3], A[3] * B[1] + A[4] * B[4], A[3] * B[2] + A[4] * B[5] + A[5]];
}
function trot(a) { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0]; }
const ttrans = (tx, ty) => [1, 0, tx, 0, 1, ty];
const transTo = (p, q) => ttrans(q.x - p.x, q.y - p.y);
const transPt = (M, P) => pt(M[0] * P.x + M[1] * P.y + M[2], M[3] * P.x + M[4] * P.y + M[5]);

// ---------- the Tile(1,1) prototile (14 vertices) ----------
// Verbatim from csk_spectre.js. Alternating unit and √3 edges; the 4 "key" vertices
// (indices 3,5,7,11) are the quad the substitution glues along.
const STRAIGHT_SPECTRE = [
  pt(0, 0),
  pt(1.0, 0.0),
  pt(1.5, -0.8660254037844386),
  pt(2.366025403784439, -0.36602540378443865),
  pt(2.366025403784439, 0.6339745962155614),
  pt(3.366025403784439, 0.6339745962155614),
  pt(3.866025403784439, 1.5),
  pt(3.0, 2.0),
  pt(2.133974596215561, 1.5),
  pt(1.6339745962155614, 2.3660254037844393),
  pt(0.6339745962155614, 2.3660254037844393),
  pt(-0.3660254037844386, 2.3660254037844393),
  pt(-0.866025403784439, 1.5),
  pt(0.0, 1.0),
];
const KEYS = [STRAIGHT_SPECTRE[3], STRAIGHT_SPECTRE[5], STRAIGHT_SPECTRE[7], STRAIGHT_SPECTRE[11]];

// The curved "Spectre" outline: replace each straight edge with a cubic bump (two
// control points offset ±0.6·|edge| perpendicular, alternating sign per edge — the
// matching bump/dent that lets neighbours interlock and forbids a reflected copy),
// then sample each cubic into a polyline. Returns one closed point list. Mirrors
// CurvyShape in csk_spectre.js, but flattened to vertices (our renderer draws
// polylines, not béziers). `samples` = points per edge.
function curvyOutline(samples = 8) {
  const src = STRAIGHT_SPECTRE;
  const out = [];
  let bump = true;
  let prev = src[src.length - 1];
  for (let i = 0; i < src.length; i++) {
    const p = src[i];
    const v = psub(p, prev);
    const w = pt(-v.y, v.x);               // perpendicular to the edge
    const b = bump ? 0.6 : -0.6;
    const c1 = pframe(prev, v, w, 0.33, b); // cubic control points
    const c2 = pframe(prev, v, w, 0.67, b);
    // sample the cubic prev→c1→c2→p at t = 1/samples … 1 (exclude t=0, it's `prev`)
    for (let k = 1; k <= samples; k++) {
      const t = k / samples, u = 1 - t;
      const a0 = u * u * u, a1 = 3 * u * u * t, a2 = 3 * u * t * t, a3 = t * t * t;
      out.push(pt(
        a0 * prev.x + a1 * c1.x + a2 * c2.x + a3 * p.x,
        a0 * prev.y + a1 * c1.y + a2 * c2.y + a3 * p.y));
    }
    bump = !bump;
    prev = p;
  }
  return out;
}

// ---------- the nine-tile substitution system ----------
// A Tile is a leaf (one spectre, drawn with `pts`, glued by `quad`). A Meta is a
// cluster (a list of {geom, T} children + its own glue quad).
class Tile {
  constructor(pts, label) { this.pts = pts; this.quad = KEYS; this.label = label; this.isLeaf = true; }
}
class Meta {
  constructor() { this.geoms = []; this.quad = []; }
  addChild(geom, T) { this.geoms.push({ geom, T }); }
}

// The nine base tiles (level 0). Eight are a single Tile(1,1); Γ is the "Mystic" — a
// fused pair (one spectre + a second rotated 30° about vertex 8). `outline` is the
// leaf point list (straight or curved); the glue quad + Mystic offset always use the
// straight key geometry, exactly as upstream.
function buildSpectreBase(curved = false, samples = SAMPLES) {
  const outline = curved ? curvyOutline(samples) : STRAIGHT_SPECTRE;
  const ret = {};
  for (const lab of ['Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Phi', 'Psi']) {
    ret[lab] = new Tile(outline, lab);
  }
  const mystic = new Meta();
  mystic.addChild(new Tile(outline, 'Gamma1'), IDENT);
  mystic.addChild(new Tile(outline, 'Gamma2'),
    mul(ttrans(STRAIGHT_SPECTRE[8].x, STRAIGHT_SPECTRE[8].y), trot(PI / 6)));
  mystic.quad = KEYS;
  ret['Gamma'] = mystic;
  return ret;
}

// One substitution step: assemble nine new supertiles from the current `sys`. The
// placement transforms Ts are walked round the quad by `t_rules` (turn, from-vertex,
// to-vertex), then EVERY one is reflected by R — the single move that makes the whole
// construction chiral. (Verbatim from csk_spectre.js; proven in _spectrecheck.mjs.)
function buildSupertiles(sys) {
  const quad = sys['Delta'].quad;
  const R = [-1, 0, 0, 0, 1, 0];
  const t_rules = [
    [60, 3, 1], [0, 2, 0], [60, 3, 1], [60, 3, 1],
    [0, 2, 0], [60, 3, 1], [-120, 3, 3]];
  const Ts = [IDENT];
  let total_ang = 0;
  let rot = IDENT;
  const tquad = [...quad];
  for (const [ang, from, to] of t_rules) {
    total_ang += ang;
    if (ang !== 0) {
      rot = trot(radians(total_ang));
      for (let i = 0; i < 4; i++) tquad[i] = transPt(rot, quad[i]);
    }
    const ttt = transTo(tquad[to], transPt(Ts[Ts.length - 1], quad[from]));
    Ts.push(mul(ttt, rot));
  }
  for (let idx = 0; idx < Ts.length; idx++) Ts[idx] = mul(R, Ts[idx]);

  const super_rules = {
    'Gamma':  ['Pi', 'Delta', 'null', 'Theta', 'Sigma', 'Xi', 'Phi', 'Gamma'],
    'Delta':  ['Xi', 'Delta', 'Xi', 'Phi', 'Sigma', 'Pi', 'Phi', 'Gamma'],
    'Theta':  ['Psi', 'Delta', 'Pi', 'Phi', 'Sigma', 'Pi', 'Phi', 'Gamma'],
    'Lambda': ['Psi', 'Delta', 'Xi', 'Phi', 'Sigma', 'Pi', 'Phi', 'Gamma'],
    'Xi':     ['Psi', 'Delta', 'Pi', 'Phi', 'Sigma', 'Psi', 'Phi', 'Gamma'],
    'Pi':     ['Psi', 'Delta', 'Xi', 'Phi', 'Sigma', 'Psi', 'Phi', 'Gamma'],
    'Sigma':  ['Xi', 'Delta', 'Xi', 'Phi', 'Sigma', 'Pi', 'Lambda', 'Gamma'],
    'Phi':    ['Psi', 'Delta', 'Psi', 'Phi', 'Sigma', 'Pi', 'Phi', 'Gamma'],
    'Psi':    ['Psi', 'Delta', 'Psi', 'Phi', 'Sigma', 'Psi', 'Phi', 'Gamma'],
  };
  const super_quad = [
    transPt(Ts[6], quad[2]),
    transPt(Ts[5], quad[1]),
    transPt(Ts[3], quad[2]),
    transPt(Ts[0], quad[1])];

  const ret = {};
  for (const [lab, subs] of Object.entries(super_rules)) {
    const sup = new Meta();
    for (let idx = 0; idx < 8; idx++) {
      if (subs[idx] === 'null') continue;
      sup.addChild(sys[subs[idx]], Ts[idx]);
    }
    sup.quad = super_quad;
    ret[lab] = sup;
  }
  return ret;
}

// Walk a supertile tree, accumulating transforms, emitting every leaf spectre as
// {label, T (accumulated transform), pts (in patch coords)}.
function collectTiles(geom, S, out) {
  if (geom.isLeaf) {
    out.push({ label: geom.label, T: S, pts: geom.pts.map(p => transPt(S, p)) });
    return;
  }
  for (const g of geom.geoms) collectTiles(g.geom, mul(S, g.T), out);
}

const SAMPLES = 8; // bézier samples per curved edge

/**
 * The spectres of a chosen supertile after `depth` substitutions, in native Tile(1,1)
 * coordinates. Returns [{label, T:[a,b,c,d,e,f], pts:[{x,y}…]}]. Tiles are the curved
 * Spectre outline when `curved` (default false → the straight Tile(1,1) 14-gon, used
 * by the math proof). `seed` selects which of the nine supertiles to expand.
 */
export function spectreTiles(depth = 3, { curved = false, seed = 'Delta', samples = SAMPLES } = {}) {
  const n = Math.max(0, Math.min(6, Math.round(depth)));
  let sys = buildSpectreBase(curved, samples);
  for (let i = 0; i < n; i++) sys = buildSupertiles(sys);
  const out = [];
  collectTiles(sys[seed], IDENT, out);
  return out;
}

/**
 * Renderable item specs for a spectre patch, in WORLD coordinates, ready for
 * app.generate. Each spectre is one filled, fully-stroked closed polygon (the
 * `wholeTile` render path). The patch is centred on (x,y) and scaled so its larger
 * extent spans ~2·size. A SINGLE fill is used for every tile — they are all the same
 * shape in the same handedness (that uniformity is the whole point).
 */
export function spectreItems({
  depth = 3, size = 540, x = 0, y = 0, curved = true, seed = 'Delta', samples = SAMPLES,
  fill = '#9775fa', edge = '#10121a', width = null,
} = {}) {
  const tiles = spectreTiles(depth, { curved, seed, samples });
  if (!tiles.length) return [];
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const t of tiles) for (const p of t.pts) {
    if (p.x < mnx) mnx = p.x; if (p.x > mxx) mxx = p.x;
    if (p.y < mny) mny = p.y; if (p.y > mxy) mxy = p.y;
  }
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
  const half = Math.max(mxx - mnx, mxy - mny) / 2 || 1;
  const s = size / half;
  // +y up in tiling coords → screen down (a global y-flip; preserves relative chirality)
  const tx = p => ({ x: x + (p.x - cx) * s, y: y - (p.y - cy) * s });
  const lw = width != null ? width : Math.max(size * 0.0045, 0.5);
  return tiles.map(t => ({
    type: 'stroke',
    points: [...t.pts.map(tx), tx(t.pts[0])],   // closed polygon
    color: edge,
    fill,
    width: lw,
  }));
}

// Generator-shaped wrapper (registered in generators.js GENERATORS).
// depth 3 from the Δ supertile = a rich, snappy screenful that still shows the
// substitution hierarchy. (Higher depth available but heavier — curved tiles carry
// ~8 points per edge.)
export function spectreTiling(opts = {}) { return spectreItems({ depth: 3, ...opts }); }

// Exposed for the standalone math proof (tests/_spectrecheck.mjs).
export const _internal = {
  STRAIGHT_SPECTRE, KEYS, curvyOutline,
  buildSpectreBase, buildSupertiles, collectTiles, spectreTiles,
  IDENT, transPt, mul, ttrans,
};
