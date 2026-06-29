// APERIODIC TILINGS — the tilings the 17 wallpaper groups CANNOT express.
//
// Every PERIODIC plane pattern is one of the 17 wallpaper groups (see
// wallpaper.js); the 7 frieze groups (frieze.js) are their 1-D siblings; the
// point groups (mandala) are the 0-D ones. Together those classify everything
// with translational symmetry. This module is the honest "…and everything that
// has NONE": the APERIODIC tilings — patterns that tile the whole plane yet
// never repeat under any translation.
//
// They are a genuinely different KIND of object: there is no symmetry group, no
// lattice, no fundamental domain to draw into. So they are NOT a new entry in
// the symmetry-group dropdown — that would be a category error. They are
// procedural GENERATORS (siblings of generators.js): a recursive SUBSTITUTION
// (a.k.a. inflation/deflation) rule that starts from a seed patch and repeatedly
// replaces each tile with a golden-ratio-scaled cluster of smaller tiles. The
// union is gap-free and overlap-free at every step (the engine proves it — see
// tests/_penrosecheck.mjs: total tile area is exactly invariant under
// subdivision, every interior edge is shared by exactly two tiles, and no vertex
// lands mid-edge).
//
// Substitution tilings are SELF-SIMILAR under inflation — zoom in by φ and you
// meet the same two tiles again — which makes them a perfect citizen of an
// infinite-zoom canvas.
//
// We implement THREE aperiodic tilings as SUBSTITUTIONS. The first two render
// through the half-triangle pipeline; the third renders WHOLE polygon tiles:
//
//   • PENROSE P3 (5-fold, golden ratio φ): a THIN (36°) and a FAT (72°) rhombus,
//     via ROBINSON HALF-TRIANGLES (the standard construction, due to Robinson;
//     popularised in code by Jeff Preshing). The deflation rule acts directly on
//     the half-triangles.
//   • AMMANN–BEENKER (8-fold, silver ratio δ = 1+√2): a unit SQUARE and a 45°
//     RHOMBUS. The genuinely different symmetry order (8 vs 5). Its substitution
//     is the published one (square → 3 squares + 4 rhombi, rhombus → 2 squares +
//     3 rhombi; equivalently on the half-square triangle S and whole rhombus R:
//     S → 3S + 2R, R → 4S + 3R; matrix [[3,4],[2,3]], Perron eigenvalue δ²).
//     The child placements were derived from the canonical 8-basis-vector data
//     and PROVEN to tile each inflated parent exactly (gap- and overlap-free) —
//     see the derivation note in NOTES.md. AB's substitution naturally lives on
//     {half-square triangle, whole rhombus}, so it carries those through an
//     internal affine representation and a `finalize` step splits each rhombus
//     into two mirror halves (and leaves each half-square as-is) for rendering.
//   • PINWHEEL (Conway–Radin, inflation √5): a SINGLE prototile — the 1·2·√5 right
//     triangle and its mirror — subdivided into 5 copies at scale 1/√5. A
//     genuinely different KIND of aperiodicity: where P3 (5/10) and AB (8) place
//     tiles in finitely many orientations, the pinwheel's inflation rotation
//     arctan(1/2) is an irrational multiple of π, so its tiles occur in INFINITELY
//     MANY orientations ("statistical circular symmetry"). It is NOT edge-to-edge
//     (vertices land mid-edge — T-junctions), so it does not use the mirror
//     half-triangle fusion: a `wholeTile` spec renders each triangle as one filled,
//     fully-stroked polygon. Gap-/overlap-freeness is instead guaranteed by
//     construction — every parent is an EXACT partition into its 5 children
//     (area-invariant under deflation, children contained & non-overlapping) — see
//     the derivation note in NOTES.md. The two tile "colours" are the two
//     chiralities (right/left-handed); their asymptotic 1:1 ratio is the
//     substitution matrix [[2,3],[3,2]] eigenvector (Perron eigenvalue 5 = (√5)²).
//
// Each WHOLE tile is split into two mirror-image half-triangles along an internal
// diagonal; the render rule below fuses the halves back into whole tiles. A
// half-triangle is [color, A, B, C] (color 0 / 1 = the two tile types). The
// engine still has room for MORE substitution tilings (P2 kite/dart — see the
// honest-failure note in NOTES.md; the 2023 hat/spectre einstein monotile; the
// edge-to-edge 12-fold dodecagonal tilings — whose substitutions CROSS tile
// boundaries, so they need partial-tile bookkeeping, see NOTES.md) — each is a
// seed + a subdivide rule (+ optional finalize / wholeTile flag), gated on
// tests/_penrosecheck.mjs. The `wholeTile` path (see PINWHEEL below) hosts any
// tiling whose tiles are arbitrary polygons rather than fused mirror halves.
//
// RENDERING WHOLE TILES. One of a half-triangle's three edges is the INTERNAL
// DIAGONAL it shares with its mirror partner; the other two are real tile
// boundary edges. We FILL each half and stroke only its boundary edges, leaving
// the diagonal unstroked — so a tile's two halves, sharing the unstroked diagonal
// and one fill colour, merge seamlessly into a whole rhombus / kite / dart.
//
// We find that internal diagonal GENERICALLY (works for any substitution tiling,
// not just rhombi): an interior edge is a diagonal iff the two half-triangles
// meeting there are MIRROR IMAGES across it (reflecting one half's far vertex
// over the edge lands on the other half's far vertex). Edges between two DISTINCT
// tiles fail that test, so they stay stroked. tests/_penrosecheck.mjs verifies
// every half-triangle has at most one internal edge.

const PHI = (1 + Math.sqrt(5)) / 2;     // golden ratio φ = 1.6180339887…
const INV = 1 / PHI;                    // 1/φ = φ − 1 = 0.6180339887…

// ---------- vector helpers (points are [x, y]) ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
/** Point a fraction `t` of the way from a to b: a + (b−a)·t. */
const along = (a, b, t) => add(a, mul(sub(a, b), -t));

// ---------- P3 (rhombus) deflation ----------
// color 0 = thin half (acute golden triangle, 36-72-72).
// color 1 = fat  half (obtuse golden gnomon, 36-36-108).
// One deflation step (Preshing's rule), verified area-invariant in node:
//   thin → 1 thin + 1 fat      fat → 1 thin + 2 fat
function subdivideP3(tris) {
  const out = [];
  for (const [color, A, B, C] of tris) {
    if (color === 0) {
      const P = along(A, B, INV);
      out.push([0, C, P, B], [1, P, C, A]);
    } else {
      const Q = along(B, A, INV);
      const R = along(B, C, INV);
      out.push([1, R, C, A], [1, Q, R, B], [0, R, Q, A]);
    }
  }
  return out;
}

// ---------- seeds ----------
// A "sun": ten half-triangles fanned around the origin, apex at the centre, each
// spanning a 36° wedge of the unit circle, mirrored in alternating wedges so the
// halves pair into five whole tiles — a legal, ten-fold-symmetric seed patch.
function sunSeed(color) {
  const t = [];
  for (let i = 0; i < 10; i++) {
    let B = [Math.cos((2 * i - 1) * Math.PI / 10), Math.sin((2 * i - 1) * Math.PI / 10)];
    let C = [Math.cos((2 * i + 1) * Math.PI / 10), Math.sin((2 * i + 1) * Math.PI / 10)];
    if (i % 2 === 0) { const tmp = B; B = C; C = tmp; }   // mirror alternate wedges
    t.push([color, [0, 0], B, C]);
  }
  return t;
}

// ---------- Ammann–Beenker (8-fold) deflation ----------
// Silver ratio δ = 1 + √2 (the inflation factor). Two prototiles: a unit SQUARE
// (drawn as two 45-45-90 half-square triangles sharing the diagonal) and a 45°
// RHOMBUS (drawn as two isosceles halves sharing the LONG diagonal).
//
// The substitution carries an internal {shape, T} representation — shape is the
// half-square triangle 'sq' or the whole rhombus 'rh', T is the affine map from
// the canonical prototile to this tile. Children are placed in an 8-fold basis
// (eₖ = (cos45k°, sin45k°)); the placement data below was solved so each parent's
// children tile it exactly (proven gap-/overlap-free). `finalizeAB` then splits
// each rhombus into two mirror halves for the half-triangle render pipeline.
const SILVER = 1 + Math.SQRT2;
const ROOT2 = Math.SQRT2;

const e8 = k => [Math.cos(k * Math.PI / 4), Math.sin(k * Math.PI / 4)];
const coord8 = list => list.reduce((a, c, i) => add(a, mul(e8(i), c)), [0, 0]);
const rotAB = (p, orient) => { const a = orient * Math.PI / 4, c = Math.cos(a), s = Math.sin(a); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]; };

// canonical prototiles (origin at the acute / right-angle corner)
const AB_SQ = [[0, 0], [1, 0], [1, 1]];                       // half-square: legs (0,0)-(1,0),(1,0)-(1,1); hyp (0,0)-(1,1)=√2
const AB_RH = [[0, 0], e8(0), add(e8(0), e8(1)), e8(1)];      // 45° rhombus, acute corner at origin
const protoAB = shape => (shape === 'sq' ? AB_SQ : AB_RH);

// affine transform {m:[a,b,c,d], t:[e,f]}: p ↦ (a·x+b·y+e, c·x+d·y+f)
const applyT = (T, p) => [T.m[0] * p[0] + T.m[1] * p[1] + T.t[0], T.m[2] * p[0] + T.m[3] * p[1] + T.t[1]];
// compose: result(p) = P(Q(p))
function composeT(P, Q) {
  const [a, b, c, d] = P.m, [e, f, g, h] = Q.m;
  return {
    m: [a * e + b * g, a * f + b * h, c * e + d * g, c * f + d * h],
    t: [a * Q.t[0] + b * Q.t[1] + P.t[0], c * Q.t[0] + d * Q.t[1] + P.t[1]],
  };
}

// Substitution data: parent shape → child [childShape, originBasisList, orient,
// handedness]. orient r ⇒ rotate the canonical child by r·45° and translate by
// the basis-coordinate origin (positions PROVEN by exact-cover to tile the
// δ-inflated parent). The SQUARE substitution is CHIRAL — the published rule
// distinguishes RSquare ('R') from its mirror LSquare ('L'), each recursing into
// a mirror-image child cluster. Getting this wrong yields a valid-but-wrong
// dissection whose half-squares never re-pair into clean squares (caught by the
// pairing + T-junction checks in tests/_penrosecheck.mjs). Rhombi are achiral.
const AB_SUB = {
  sq: [   // half-square → 3 half-squares + 2 rhombi  (area δ²/2)
    ['rh', [0], 0, 'rh'],
    ['rh', [1, 1, 0, -1], 2, 'rh'],
    ['sq', [0, 1], 0, 'L'],
    ['sq', [1, 1, 0, -1], 3, 'R'],
    ['sq', [1, 2, 1], 5, 'R'],
  ],
  rh: [   // rhombus → 4 half-squares + 3 rhombi  (area δ²·area(rhomb))
    ['rh', [], 0, 'rh'],
    ['rh', [1, 1, 1, -1], 0, 'rh'],
    ['rh', [1, 1, 1], 6, 'rh'],
    ['sq', [1, 1, 0, -1], 3, 'R'],
    ['sq', [1, 1, 1], 7, 'R'],
    ['sq', [0, 1], 0, 'L'],
    ['sq', [2, 1, 1, -1], 4, 'L'],
  ],
};

// Build each child's local transform q (canonical child → UNIT parent frame).
// The child sits at O + Rot(orient·45°)·proto in the δ-inflated parent; scale by
// 1/δ for the unit parent. For an 'L' (mirror) square we map canonical RSquare
// onto its triangle with the two 45° apexes SWAPPED — a reflecting (det<0)
// transform, so composition propagates the mirror to its whole subtree.
function abChildQ(shape, list, orient, hand) {
  const O = coord8(list);
  const verts = protoAB(shape).map(p => add(O, rotAB(p, orient)));   // δ-inflated-frame verts
  let A, t;
  if (shape === 'rh') {                       // achiral: a similarity fixed by the first edge
    const u = sub(verts[1], verts[0]);
    A = [u[0], -u[1], u[1], u[0]]; t = verts[0];
  } else {
    const [v0, v1, v2] = verts;               // v1 = right-angle corner (image of canonical (1,0))
    const [c0, c1, c2] = hand === 'L' ? [v2, v1, v0] : [v0, v1, v2];
    A = [c1[0] - c0[0], c2[0] - c1[0], c1[1] - c0[1], c2[1] - c1[1]]; t = c0;
  }
  return { m: [A[0] / SILVER, A[1] / SILVER, A[2] / SILVER, A[3] / SILVER], t: [t[0] / SILVER, t[1] / SILVER] };
}
const AB_CHILDREN = {};
for (const shape of Object.keys(AB_SUB))
  AB_CHILDREN[shape] = AB_SUB[shape].map(([cs, list, orient, hand]) => ({ shape: cs, q: abChildQ(cs, list, orient, hand) }));

// 8 rhombi sharing their acute corner at the origin → an 8-fold-symmetric star seed.
function abStarSeed() {
  const t = [];
  for (let k = 0; k < 8; k++) {
    const th = k * Math.PI / 4, c = Math.cos(th), s = Math.sin(th);
    t.push({ shape: 'rh', T: { m: [c, -s, s, c], t: [0, 0] } });
  }
  return t;
}

function subdivideAB(tiles) {
  const out = [];
  for (const tile of tiles)
    for (const ch of AB_CHILDREN[tile.shape])
      out.push({ shape: ch.shape, T: composeT(tile.T, ch.q) });
  return out;
}

// Convert internal {shape,T} tiles → half-triangles [color,A,B,C]. A square is one
// half-triangle (its hypotenuse is the internal diagonal, fused with the adjacent
// square's half). A rhombus splits along its LONG diagonal into two mirror halves.
// color 0 = square, 1 = rhombus.
function finalizeAB(tiles) {
  const out = [];
  for (const { shape, T } of tiles) {
    if (shape === 'sq') {
      const [A, B, C] = AB_SQ.map(p => applyT(T, p));
      out.push([0, A, B, C]);                       // diagonal = C–A (hypotenuse)
    } else {
      const [P0, P1, P2, P3] = AB_RH.map(p => applyT(T, p));
      out.push([1, P0, P1, P2], [1, P0, P3, P2]);   // diagonal = P2–P0 (long), shared by both
    }
  }
  return out;
}

// ---------- Pinwheel (Conway–Radin, inflation √5) ----------
// One prototile: the right triangle with legs 2 (long) and 1 (short) and
// hypotenuse √5. Roles: P0_RIGHT is the right-angle corner; P0_SMALL is the
// far end of the long leg (the arctan½ ≈ 26.57° corner); P0_LARGE the far end of
// the short leg (the arctan2 ≈ 63.43° corner). A tile carries an affine map T
// (prototile → world); its CHIRALITY is sign(det T) — the two render "colours".
//
// THE SUBSTITUTION (derived from first principles, proven exact — see NOTES.md):
// drop the altitude from the right-angle corner to the hypotenuse; its foot F
// lands ON the hypotenuse and cuts off one child (γ). The remaining triangle has
// the parent's long leg as its hypotenuse; joining that hypotenuse's MIDPOINT M
// to the right-angle corner and to the two leg-midpoints fans it into four more
// children — so FOUR children meet at M (the midpoint of the long side), the
// defining pinwheel signature. All 5 children are 1·2·√5 triangles at scale 1/√5.
const ROOT5 = Math.sqrt(5);
const P0_SMALL = [0, 0], P0_RIGHT = [2, 0], P0_LARGE = [2, 1];   // prototile, right angle at (2,0)
// Each child as its (small, right, large) role-vertices in the unit prototile frame.
// F=(1.6,0.8) is the altitude foot (it lies on the hypotenuse y=x/2); M=(1,0) is
// the long-leg midpoint where T1..T4 meet.
const PIN_CHILDREN = [
  [[2, 0],     [1.6, 0.8], [2, 1]],       // γ  — cut off by the altitude
  [[0, 0],     [0.8, 0.4], [1, 0]],       // T1 \
  [[1, 0],     [1.8, 0.4], [2, 0]],       // T2  |  four around M=(1,0)
  [[1, 0],     [1.8, 0.4], [1.6, 0.8]],   // T3  |
  [[1.6, 0.8], [0.8, 0.4], [1, 0]],       // T4 /
];

// Affine map (proto → image) from corresponding (small, right, large) vertices.
function affineFromTri(p0, p1, p2, q0, q1, q2) {
  const px = sub(p1, p0), py = sub(p2, p0);             // prototile basis
  const det = px[0] * py[1] - px[1] * py[0] || 1e-18;
  const inv = [py[1] / det, -py[0] / det, -px[1] / det, px[0] / det];   // [px py]⁻¹
  const cx = sub(q1, q0), cy = sub(q2, q0);             // image basis
  const m = [
    cx[0] * inv[0] + cy[0] * inv[2], cx[0] * inv[1] + cy[0] * inv[3],
    cx[1] * inv[0] + cy[1] * inv[2], cx[1] * inv[1] + cy[1] * inv[3],
  ];
  return { m, t: [q0[0] - (m[0] * p0[0] + m[1] * p0[1]), q0[1] - (m[2] * p0[0] + m[3] * p0[1])] };
}
const detT = T => T.m[0] * T.m[3] - T.m[1] * T.m[2];
const PIN_Q = PIN_CHILDREN.map(([s, r, l]) => affineFromTri(P0_SMALL, P0_RIGHT, P0_LARGE, s, r, l));

// Seed: four prototile triangles tiling the 2×2 square [-1,1]² (two stacked 2×1
// rectangles, each split along its diagonal) — symmetric, fills the view, and
// (being an exact tiling of the square) keeps total area invariant under deflation.
function pinwheelSeed() {
  const tris = [
    [[-1, 0], [1, 0], [1, 1]], [[1, 1], [-1, 1], [-1, 0]],     // top rectangle
    [[-1, -1], [1, -1], [1, 0]], [[1, 0], [-1, 0], [-1, -1]],  // bottom rectangle
  ];
  return tris.map(([s, r, l]) => ({ T: affineFromTri(P0_SMALL, P0_RIGHT, P0_LARGE, s, r, l) }));
}

function subdividePinwheel(tiles) {
  const out = [];
  for (const { T } of tiles) for (const q of PIN_Q) out.push({ T: composeT(T, q) });
  return out;
}

// Internal {T} tiles → whole-triangle render tuples [color, A, B, C]. The triangle
// IS the tile (no mirror-half fusion); color = chirality (0 = right-handed, the
// prototile's; 1 = left-handed / reflected). aperiodicItems strokes all 3 edges.
function finalizePinwheel(tiles) {
  return tiles.map(({ T }) => [
    detT(T) < 0 ? 1 : 0, applyT(T, P0_SMALL), applyT(T, P0_RIGHT), applyT(T, P0_LARGE),
  ]);
}

// ---------- the tilings ----------
const TILINGS = {
  p3: {
    label: 'Penrose P3 · thin & fat rhombi',
    seed: () => sunSeed(0),
    subdivide: subdivideP3,
    fills: ['#4dabf7', '#b197fc'],          // [color0 = thin, color1 = fat]
    tileNames: ['thin rhombus', 'fat rhombus'],
    inflation: PHI,                         // count/area grow by φ² per deflation
    colorRatio: 1 / PHI,                    // asymptotic #thin / #fat → 1/φ (substitution eigenvector)
    maxDepth: 8,
  },
  ammann: {
    label: 'Ammann–Beenker · 8-fold (square + rhombus)',
    seed: abStarSeed,
    subdivide: subdivideAB,
    finalize: finalizeAB,                   // internal {shape,T} tiles → half-triangles
    fills: ['#ffd43b', '#63e6be'],          // [color0 = square (gold), color1 = rhombus (teal)]
    tileNames: ['square', 'rhombus'],
    inflation: SILVER,                      // count/area grow by δ²=(1+√2)² per deflation
    colorRatio: 1 / ROOT2,                  // asymptotic #square / #rhombus → 1/√2 (substitution eigenvector)
    maxDepth: 5,                            // δ²≈5.83× per step — clamp lower than P3
  },
  pinwheel: {
    label: 'Pinwheel · ∞ orientations (Conway–Radin)',
    seed: pinwheelSeed,
    subdivide: subdividePinwheel,
    finalize: finalizePinwheel,             // internal {T} tiles → whole triangles
    wholeTile: true,                        // render whole polygons, no mirror-half fusion
    edgeToEdge: false,                      // famously NOT edge-to-edge (T-junctions are expected)
    fills: ['#ff8787', '#74c0fc'],          // [color0 = right-handed, color1 = left-handed / mirror]
    tileNames: ['right triangle', 'left triangle'],
    inflation: ROOT5,                       // count/area grow by (√5)²=5 per deflation
    colorRatio: 1,                          // asymptotic #right / #left → 1 (matrix [[2,3],[3,2]] eigenvector)
    maxDepth: 6,                            // 5× per step
  },
};

export const APERIODIC_TILINGS = Object.entries(TILINGS)
  .map(([name, spec]) => ({
    name, label: spec.label, tileNames: spec.tileNames, inflation: spec.inflation,
    colorRatio: spec.colorRatio, wholeTile: !!spec.wholeTile, edgeToEdge: spec.edgeToEdge !== false,
  }));

export const APERIODIC_NAMES = APERIODIC_TILINGS.map(t => t.name);

export function isAperiodicTiling(name) {
  return Object.prototype.hasOwnProperty.call(TILINGS, name);
}

/**
 * The raw half-triangles of `kind` after `depth` deflation steps, in unit
 * coordinates (the seed spans the unit circle). Each is [color, A, B, C] with
 * A,B,C = [x,y]. Returns [] for an unknown kind.
 */
export function tiles(kind, depth) {
  const spec = TILINGS[kind];
  if (!spec) return [];
  let t = spec.seed();
  const n = Math.max(0, Math.min(spec.maxDepth ?? 8, Math.round(depth)));   // clamp: grows by inflation²/step
  for (let i = 0; i < n; i++) t = spec.subdivide(t);
  if (spec.finalize) t = spec.finalize(t);                 // internal repr → half-triangles
  return t;
}

// ---------- internal-diagonal detection ----------
const vkey = p => `${Math.round(p[0] * 1e9)},${Math.round(p[1] * 1e9)}`;
const ekey = (a, b) => { const ka = vkey(a), kb = vkey(b); return ka < kb ? ka + '|' + kb : kb + '|' + ka; };

/** Reflect point p across the line through u and v. */
function reflectAcross(p, u, v) {
  const dx = v[0] - u[0], dy = v[1] - u[1];
  const L2 = dx * dx + dy * dy || 1e-18;
  const xx = p[0] - u[0], xy = p[1] - u[1];
  const dot = (xx * dx + xy * dy) / L2;
  return [u[0] + 2 * dot * dx - xx, u[1] + 2 * dot * dy - xy];
}

const elen = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * For each half-triangle return the index (0,1,2) of its INTERNAL diagonal edge
 * — edge0=(A,B), edge1=(B,C), edge2=(C,A) — or -1 if it has none (a half whose
 * mirror partner fell outside the patch).
 *
 * The diagonal is the edge a tile shares with its mirror partner. Two criteria,
 * BOTH required, because either alone over-detects:
 *   • the two halves are MIRROR IMAGES across the edge (reflecting one half's far
 *     vertex over the edge lands on the other's); and
 *   • the edge is NOT a tile SIDE — its length differs from the common side
 *     length `s`. Adjacent DISTINCT tiles can also meet mirror-symmetrically
 *     across a shared SIDE (length s); without the length gate such a side would
 *     be wrongly marked internal, two real tiles would merge, and — since a tile
 *     has only one skip slot — a genuine diagonal elsewhere would get stroked.
 * For the equilateral P3 rhombi every tile has exactly two side edges (= s) and
 * one diagonal (≠ s), so this picks each tile's unique diagonal unambiguously.
 */
function internalEdges(ts) {
  const E = ts.map(([, A, B, C]) => [[A, B], [B, C], [C, A]]);
  // common side length s = the most frequent edge length across the patch
  const r6 = x => Math.round(x * 1e6) / 1e6;
  const hist = new Map();
  for (const e of E) for (const [u, v] of e) { const L = r6(elen(u, v)); hist.set(L, (hist.get(L) || 0) + 1); }
  let s = 1, best = -1;
  for (const [L, n] of hist) if (n > best) { best = n; s = L; }
  const map = new Map();            // edgekey → [{ti, ei, far}]
  for (let ti = 0; ti < ts.length; ti++) {
    const [, A, B, C] = ts[ti];
    const far = [C, A, B];          // vertex opposite edge ei
    for (let ei = 0; ei < 3; ei++) {
      const k = ekey(E[ti][ei][0], E[ti][ei][1]);
      (map.get(k) || map.set(k, []).get(k)).push({ ti, ei, far: far[ei] });
    }
  }
  const skip = new Array(ts.length).fill(-1);
  const tol2 = 1e-12;
  for (const list of map.values()) {
    if (list.length !== 2) continue;
    const [p, q] = list;
    const [u, v] = E[p.ti][p.ei];
    if (Math.abs(elen(u, v) - s) < s * 1e-3) continue;     // a tile SIDE, not a diagonal
    const r = reflectAcross(p.far, u, v);
    const dx = r[0] - q.far[0], dy = r[1] - q.far[1];
    if (dx * dx + dy * dy < tol2) { skip[p.ti] = p.ei; skip[q.ti] = q.ei; }
  }
  return skip;
}

// ---------- item-spec emission (generator shape) ----------
/**
 * Build renderable item specs for an aperiodic tiling, in WORLD coordinates,
 * ready for app.generate (which only adds ids). Half-triangle tilings (P3, AB)
 * emit one `stroke` per half, FILLED by its tile type and stroking every edge
 * EXCEPT its internal diagonal — so mirror pairs merge into whole rhombi / kites /
 * darts. WHOLE-TILE tilings (`spec.wholeTile`, e.g. Pinwheel) skip the diagonal
 * machinery entirely: each [color,A,B,C] tuple is a whole triangle, drawn closed
 * with all three edges stroked. `size` is the patch radius in world units.
 */
export function aperiodicItems(kind, {
  depth = 5, size = 540, x = 0, y = 0,
  fills = null, edge = '#10121a', width = null,
} = {}) {
  const spec = TILINGS[kind];
  if (!spec) return [];
  const fill = fills || spec.fills;
  const ts = tiles(kind, depth);
  const skip = spec.wholeTile ? null : internalEdges(ts);   // whole tiles: never fuse
  // Stroke width: a small fraction of the tile edge so deep zoom stays crisp.
  // Tiles shrink by 1/inflation per deflation step, so scale the width to match.
  const shrink = 1 / (spec.inflation || PHI);
  const lw = width != null ? width : Math.max(size * Math.pow(shrink, depth + 1) * 0.06, 0.4);
  const tx = ([px, py]) => ({ x: x + px * size, y: y - py * size });   // +y up → screen down
  return ts.map(([color, A, B, C], i) => {
    const V = [A, B, C];
    // Order points so the (open) polyline traverses the two boundary edges and
    // the unstroked gap is the internal diagonal; fill() auto-closes the triangle.
    // s=0 skip (A,B) → [B,C,A]; s=1 skip (B,C) → [C,A,B]; s=2 skip (C,A) → [A,B,C];
    // s=-1 / whole-tile → closed [A,B,C,A], stroke all three edges.
    const s = skip ? skip[i] : -1;
    let pts;
    if (s === 0) pts = [V[1], V[2], V[0]];
    else if (s === 1) pts = [V[2], V[0], V[1]];
    else if (s === 2) pts = [V[0], V[1], V[2]];
    else pts = [V[0], V[1], V[2], V[0]];
    return {
      type: 'stroke',
      points: pts.map(tx),
      color: edge,
      fill: fill[color] || fill[0],
      width: lw,
    };
  });
}

// Generator-shaped wrappers (registered in generators.js GENERATORS).
export function penroseP3(opts = {}) { return aperiodicItems('p3', opts); }
// AB grows ~5.8×/step, so default to a shallower depth than P3 for a snappy build.
export function ammannBeenker(opts = {}) { return aperiodicItems('ammann', { depth: 3, ...opts }); }
// Pinwheel grows 5×/step; depth 4 from the 4-tile seed ≈ 2500 triangles — snappy & rich.
export function pinwheel(opts = {}) { return aperiodicItems('pinwheel', { depth: 4, ...opts }); }

// Exposed for the standalone math check (tests/_penrosecheck.mjs).
export const _internal = {
  PHI, INV, SILVER, ROOT5, subdivideP3, sunSeed, subdivideAB, abStarSeed, finalizeAB,
  subdividePinwheel, pinwheelSeed, finalizePinwheel, PIN_Q, P0_SMALL, P0_RIGHT, P0_LARGE, detT,
  TILINGS, tiles, internalEdges, reflectAcross,
};
