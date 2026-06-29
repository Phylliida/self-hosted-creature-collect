// THE HAT — an APERIODIC MONOTILE (the "einstein", Smith–Myers–Kaplan–Goodman-
// Strauss, 2023). The capstone of "all 2D tiling modes possible in math": a SINGLE
// shape that tiles the whole plane yet admits NO periodic tiling at all.
//
// Where penrose.js's three aperiodic tilings each need TWO prototiles (P3: thin+fat
// rhombus; Ammann–Beenker: square+rhombus; Pinwheel: a triangle + its mirror), the
// hat needs exactly ONE — every tile here is a congruent copy of the same 13-gon,
// differing only by rotation/translation and, for ~12% of them, REFLECTION. (That
// reflection requirement is why the hat is sometimes called an "einstein with an
// asterisk"; its chiral cousin the Spectre removes even that — a natural next step,
// see NOTES.md.)
//
// HOW IT TILES — a METATILE SUBSTITUTION, not a single-tile deflation. The hat does
// not substitute into scaled copies of itself; instead four "metatiles" H, T, P, F
// (clusters of hats) substitute into larger clusters of H/T/P/F, and the individual
// hats are read off the leaves. This is Craig S. Kaplan's H7/H8 construction
// (BSD-3, github.com/isohedral/hatviz), faithfully ported here. The geometry lives
// on a hex/kite lattice (hexPt below), every gluing is an exact edge-match
// (matchTwo), and the whole thing was PROVEN before this file shipped — see
// tests/_hatcheck.mjs: every tile is congruent to the prototile (one area value),
// the patch is overlap-free (rigorous pairwise) and gap-free (flood-fill on a fine
// grid finds no interior hole), tiles occur in finitely many (12) orientations, and
// hat counts grow by φ⁴ per substitution (linear inflation φ²).
//
// RENDERING. Each hat is a whole 13-gon, so it rides penrose.js's `wholeTile` path:
// one filled, fully-stroked closed polygon. hatItems() emits the same item spec the
// other aperiodic generators do (a `stroke` with `fill`), normalised to fit a given
// patch size. Two fill colours encode CHIRALITY (reflected vs not) — the visible
// signature of "this monotile needs its mirror image".

// ---------- affine geometry on the hex/kite lattice (ported from hatviz) ----------
// A transform is [a,b,c,d,e,f]: (x,y) ↦ (a·x+b·y+c, d·x+e·y+f). hexPt maps hex
// lattice coords to the plane, so every hat vertex is an exact lattice point and the
// substitution composes without drift.
const hr3 = Math.sqrt(3) / 2;
const PI = Math.PI;
const IDENT = [1, 0, 0, 0, 1, 0];
const pt = (x, y) => ({ x, y });
const hexPt = (x, y) => pt(x + 0.5 * y, hr3 * y);
const padd = (p, q) => ({ x: p.x + q.x, y: p.y + q.y });
const psub = (p, q) => ({ x: p.x - q.x, y: p.y - q.y });

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
const rotAbout = (p, a) => mul(ttrans(p.x, p.y), mul(trot(a), ttrans(-p.x, -p.y)));
const transPt = (M, P) => pt(M[0] * P.x + M[1] * P.y + M[2], M[3] * P.x + M[4] * P.y + M[5]);
// the unique affine map taking the unit segment to p→q, and segment p1→q1 to p2→q2.
const matchSeg = (p, q) => [q.x - p.x, p.y - q.y, p.x, q.y - p.y, q.x - p.x, p.y];
const matchTwo = (p1, q1, p2, q2) => mul(matchSeg(p2, q2), inv(matchSeg(p1, q1)));
function intersect(p1, q1, p2, q2) {
  const d = (q2.y - p2.y) * (q1.x - p1.x) - (q2.x - p2.x) * (q1.y - p1.y);
  const uA = ((q2.x - p2.x) * (p1.y - p2.y) - (q2.y - p2.y) * (p1.x - p2.x)) / d;
  return pt(p1.x + uA * (q1.x - p1.x), p1.y + uA * (q1.y - p1.y));
}

// ---------- the hat prototile (13 vertices, on the hex/kite lattice) ----------
const HAT_OUTLINE = [
  hexPt(0, 0), hexPt(-1, -1), hexPt(0, -2), hexPt(2, -2),
  hexPt(2, -1), hexPt(4, -2), hexPt(5, -1), hexPt(4, 0),
  hexPt(3, 0), hexPt(2, 2), hexPt(0, 3), hexPt(0, 2), hexPt(-1, 2)];

// ---------- the metatile tree ----------
// A HatTile is a leaf (one hat); a MetaTile is a cluster carrying an outline (a
// schematic grouping boundary, NOT the hat-union boundary — the hats overflow it,
// which is fine) and a list of transformed children (hats or sub-metatiles).
class HatTile {
  constructor(label) { this.label = label; this.isHat = true; this.shape = HAT_OUTLINE; }
}
class MetaTile {
  constructor(shape, width) { this.shape = shape; this.width = width; this.children = []; }
  addChild(T, geom) { this.children.push({ T, geom }); }
  evalChild(n, i) { return transPt(this.children[n].T, this.children[n].geom.shape[i]); }
  recentre() {
    let cx = 0, cy = 0;
    for (const p of this.shape) { cx += p.x; cy += p.y; }
    cx /= this.shape.length; cy /= this.shape.length;
    const tr = pt(-cx, -cy);
    for (let i = 0; i < this.shape.length; i++) this.shape[i] = padd(this.shape[i], tr);
    const M = ttrans(-cx, -cy);
    for (const ch of this.children) ch.T = mul(M, ch.T);
  }
}

const H1_hat = new HatTile('H1');   // the single REFLECTED hat in the H metatile
const H_hat = new HatTile('H');
const T_hat = new HatTile('T');
const P_hat = new HatTile('P');
const F_hat = new HatTile('F');

// The four base metatiles (level 1). Their hats are glued to the metatile outline
// edges by matchTwo; H1's transform carries a reflection ([…,−0.5,…] det<0).
const H_init = (function () {
  const o = [pt(0, 0), pt(4, 0), pt(4.5, hr3), pt(2.5, 5 * hr3), pt(1.5, 5 * hr3), pt(-0.5, hr3)];
  const m = new MetaTile(o, 2);
  m.addChild(matchTwo(HAT_OUTLINE[5], HAT_OUTLINE[7], o[5], o[0]), H_hat);
  m.addChild(matchTwo(HAT_OUTLINE[9], HAT_OUTLINE[11], o[1], o[2]), H_hat);
  m.addChild(matchTwo(HAT_OUTLINE[5], HAT_OUTLINE[7], o[3], o[4]), H_hat);
  m.addChild(mul(ttrans(2.5, hr3), mul([-0.5, -hr3, 0, hr3, -0.5, 0], [0.5, 0, 0, 0, -0.5, 0])), H1_hat);
  return m;
}());
const T_init = (function () {
  const o = [pt(0, 0), pt(3, 0), pt(1.5, 3 * hr3)];
  const m = new MetaTile(o, 2);
  m.addChild([0.5, 0, 0.5, 0, 0.5, hr3], T_hat);
  return m;
}());
const P_init = (function () {
  const o = [pt(0, 0), pt(4, 0), pt(3, 2 * hr3), pt(-1, 2 * hr3)];
  const m = new MetaTile(o, 2);
  m.addChild([0.5, 0, 1.5, 0, 0.5, hr3], P_hat);
  m.addChild(mul(ttrans(0, 2 * hr3), mul([0.5, hr3, 0, -hr3, 0.5, 0], [0.5, 0, 0, 0, 0.5, 0])), P_hat);
  return m;
}());
const F_init = (function () {
  const o = [pt(0, 0), pt(3, 0), pt(3.5, hr3), pt(3, 2 * hr3), pt(-1, 2 * hr3)];
  const m = new MetaTile(o, 2);
  m.addChild([0.5, 0, 1.5, 0, 0.5, hr3], F_hat);
  m.addChild(mul(ttrans(0, 2 * hr3), mul([0.5, hr3, 0, -hr3, 0.5, 0], [0.5, 0, 0, 0, 0.5, 0])), F_hat);
  return m;
}());

// One substitution step, in two halves (Kaplan's construction):
//   constructPatch  — glue 29 copies of the four input metatiles edge-to-edge.
//   constructMetatiles — carve four LARGER metatiles (H,T,P,F) out of that patch.
// `rules` entries: ['H'] seeds child 0; [parent, edge, type, edge'] glues a new
// `type` so its edge' meets `parent`'s `edge`; the 6-tuple matches across two
// existing children. (Verbatim from hatviz — proven correct in tests/_hatcheck.mjs.)
function constructPatch(H, T, P, F) {
  const rules = [
    ['H'], [0, 0, 'P', 2], [1, 0, 'H', 2], [2, 0, 'P', 2], [3, 0, 'H', 2], [4, 4, 'P', 2],
    [0, 4, 'F', 3], [2, 4, 'F', 3], [4, 1, 3, 2, 'F', 0], [8, 3, 'H', 0], [9, 2, 'P', 0],
    [10, 2, 'H', 0], [11, 4, 'P', 2], [12, 0, 'H', 2], [13, 0, 'F', 3], [14, 2, 'F', 1],
    [15, 3, 'H', 4], [8, 2, 'F', 1], [17, 3, 'H', 0], [18, 2, 'P', 0], [19, 2, 'H', 2],
    [20, 4, 'F', 3], [20, 0, 'P', 2], [22, 0, 'H', 2], [23, 4, 'F', 3], [23, 0, 'F', 3],
    [16, 0, 'P', 2], [9, 4, 0, 2, 'T', 2], [4, 0, 'F', 3]];
  const ret = new MetaTile([], H.width);
  const shapes = { H, T, P, F };
  for (const r of rules) {
    if (r.length === 1) {
      ret.addChild(IDENT, shapes[r[0]]);
    } else if (r.length === 4) {
      const poly = ret.children[r[0]].geom.shape;
      const T0 = ret.children[r[0]].T;
      const P0 = transPt(T0, poly[(r[1] + 1) % poly.length]);
      const Q0 = transPt(T0, poly[r[1]]);
      const npoly = shapes[r[2]].shape;
      ret.addChild(matchTwo(npoly[r[3]], npoly[(r[3] + 1) % npoly.length], P0, Q0), shapes[r[2]]);
    } else {
      const chP = ret.children[r[0]], chQ = ret.children[r[2]];
      const P0 = transPt(chQ.T, chQ.geom.shape[r[3]]);
      const Q0 = transPt(chP.T, chP.geom.shape[r[1]]);
      const npoly = shapes[r[4]].shape;
      ret.addChild(matchTwo(npoly[r[5]], npoly[(r[5] + 1) % npoly.length], P0, Q0), shapes[r[4]]);
    }
  }
  return ret;
}

function constructMetatiles(patch) {
  const bps1 = patch.evalChild(8, 2);
  const bps2 = patch.evalChild(21, 2);
  const rbps = transPt(rotAbout(bps1, -2.0 * PI / 3.0), bps2);
  const p72 = patch.evalChild(7, 2);
  const p252 = patch.evalChild(25, 2);
  const llc = intersect(bps1, rbps, patch.evalChild(6, 2), p72);
  let w = psub(patch.evalChild(6, 2), llc);
  const new_H_outline = [llc, bps1];
  w = transPt(trot(-PI / 3), w);
  new_H_outline.push(padd(new_H_outline[1], w));
  new_H_outline.push(patch.evalChild(14, 2));
  w = transPt(trot(-PI / 3), w);
  new_H_outline.push(psub(new_H_outline[3], w));
  new_H_outline.push(patch.evalChild(6, 2));
  const new_H = new MetaTile(new_H_outline, patch.width * 2);
  for (const ch of [0, 9, 16, 27, 26, 6, 1, 8, 10, 15]) new_H.addChild(patch.children[ch].T, patch.children[ch].geom);
  const new_P_outline = [p72, padd(p72, psub(bps1, llc)), bps1, llc];
  const new_P = new MetaTile(new_P_outline, patch.width * 2);
  for (const ch of [7, 2, 3, 4, 28]) new_P.addChild(patch.children[ch].T, patch.children[ch].geom);
  const new_F_outline = [bps2, patch.evalChild(24, 2), patch.evalChild(25, 0), p252, padd(p252, psub(llc, bps1))];
  const new_F = new MetaTile(new_F_outline, patch.width * 2);
  for (const ch of [21, 20, 22, 23, 24, 25]) new_F.addChild(patch.children[ch].T, patch.children[ch].geom);
  const AAA = new_H_outline[2];
  const BBB = padd(new_H_outline[1], psub(new_H_outline[4], new_H_outline[5]));
  const CCC = transPt(rotAbout(BBB, -PI / 3), AAA);
  const new_T = new MetaTile([BBB, CCC, AAA], patch.width * 2);
  new_T.addChild(patch.children[11].T, patch.children[11].geom);
  new_H.recentre(); new_P.recentre(); new_F.recentre(); new_T.recentre();
  return [new_H, new_T, new_P, new_F];
}

// Walk a metatile tree `level` deep, accumulating transforms, emitting every leaf
// hat as {reflected, pts}. A hat is reflected iff its accumulated transform has
// negative determinant (signed area of the placed polygon flips).
function collectHats(geom, S, level, out) {
  if (geom.isHat) {
    const pts = HAT_OUTLINE.map(p => transPt(S, p));
    out.push({ reflected: (S[0] * S[4] - S[1] * S[3]) < 0, pts });
    return;
  }
  if (level > 0) for (const ch of geom.children) collectHats(ch.geom, mul(S, ch.T), level - 1, out);
}

/**
 * The hats of the H supertile after `depth` substitution steps, in native (hat-
 * unit) coordinates. Returns [{reflected:boolean, pts:[{x,y}×13]}]. Counts per
 * depth: 0→4, 1→25, 2→169, 3→1156, 4→7921 (squared alternate-Fibonacci).
 */
export function hatTiles(depth = 3) {
  let tiles = [H_init, T_init, P_init, F_init];
  let level = 1;
  const n = Math.max(0, Math.min(6, Math.round(depth)));
  for (let i = 0; i < n; i++) {
    const patch = constructPatch(...tiles);
    tiles = constructMetatiles(patch);
    level++;
  }
  const out = [];
  collectHats(tiles[0], IDENT, level, out);
  return out;
}

/**
 * Renderable item specs for a hat patch, in WORLD coordinates, ready for
 * app.generate. Each hat is one filled, fully-stroked closed 13-gon (the
 * `wholeTile` render path). The patch is centred on (x,y) and scaled so its larger
 * extent spans ~2·size. `fills` = [unreflected, reflected] (chirality colours).
 */
export function hatItems({
  depth = 3, size = 540, x = 0, y = 0,
  fills = ['#74c0fc', '#ffa94d'], edge = '#10121a', width = null,
} = {}) {
  const hats = hatTiles(depth);
  if (!hats.length) return [];
  // normalise: centre the patch at origin and scale its larger half-extent to `size`
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const h of hats) for (const p of h.pts) {
    if (p.x < mnx) mnx = p.x; if (p.x > mxx) mxx = p.x;
    if (p.y < mny) mny = p.y; if (p.y > mxy) mxy = p.y;
  }
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
  const half = Math.max(mxx - mnx, mxy - mny) / 2 || 1;
  const s = size / half;
  // +y up in tiling coords → screen down
  const tx = p => ({ x: x + (p.x - cx) * s, y: y - (p.y - cy) * s });
  const lw = width != null ? width : Math.max(size * 0.004, 0.4);
  return hats.map(h => ({
    type: 'stroke',
    points: [...h.pts.map(tx), tx(h.pts[0])],   // closed polygon
    color: edge,
    fill: h.reflected ? fills[1] : fills[0],
    width: lw,
  }));
}

// Generator-shaped wrapper (registered in generators.js GENERATORS).
// depth 3 = 1156 hats: a rich, snappy screenful that still shows the metatile
// hierarchy. (depth 4 = 7921 — available but heavier.)
export function hatTiling(opts = {}) { return hatItems({ depth: 3, ...opts }); }

// Exposed for the standalone math proof (tests/_hatcheck.mjs).
export const _internal = {
  hr3, HAT_OUTLINE, H_init, T_init, P_init, F_init,
  constructPatch, constructMetatiles, collectHats, hatTiles,
  IDENT, transPt, mul, ttrans,
};
