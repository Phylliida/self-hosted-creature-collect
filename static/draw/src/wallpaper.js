// The 17 WALLPAPER GROUPS — "all 2D tiling modes possible in mathematics".
//
// A repeating plane pattern is classified, up to symmetry, by exactly one of the
// 17 plane crystallographic (wallpaper) groups. This module is the generative
// engine for all of them, built from a tiny, auditable seed per group:
//
//   group  =  (a lattice: two translation vectors v1, v2)
//          +  (a few GENERATOR isometries that, together with the lattice,
//              generate every symmetry of the pattern).
//
// We BFS-CLOSE the generators — composing them and reducing each result's
// translation part modulo the lattice — until the set stops growing. That finite
// set is the point group's cosets: the distinct copies of the motif inside ONE
// unit cell. Tiling those cells across i·v1 + j·v2 fills the plane.
//
// Everything an isometry can be — rotation, reflection, glide reflection,
// translation — is a rigid motion q ↦ M·q + t with M a 2×2 orthogonal matrix
// (det ±1). The app already knows how to rotate, reflect and translate items
// about the symmetry anchor, so each closed coset is finally emitted as a plain
// "placement": rotate-by-θ OR reflect-across-line-at-angle, then translate.
//
// The math is the load-bearing part; tests/_wallpapercheck.mjs verifies, for all
// 17, that the closure is a closed group of the expected order and that the
// p3m1 / p31m labelling is assigned by the actual on-mirror rotation-centre test,
// not by hand.

const EPS = 1e-7;

// ---------- 2×2 orthogonal-isometry algebra (anchor-local coordinates) ----------
// An isometry acts on q (a point relative to the lattice anchor) as q ↦ m·q + t.

const I = { m: [[1, 0], [0, 1]], t: [0, 0] };

/** Rotation by θ about the anchor. */
function rot(theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  return { m: [[c, -s], [s, c]], t: [0, 0] };
}

/** Reflection across the line through the anchor at angle `a`. Matches the app's
 *  reflectItemsAbout convention: Ref_a = [[cos2a, sin2a], [sin2a, -cos2a]]. */
function ref(a) {
  const c = Math.cos(2 * a), s = Math.sin(2 * a);
  return { m: [[c, s], [s, -c]], t: [0, 0] };
}

/** Glide: reflect across the line at angle `a` through the anchor, then translate
 *  by g = [gx, gy] (world units). g² lands on a lattice vector for a true glide. */
function glide(a, g) {
  return { m: ref(a).m, t: [g[0], g[1]] };
}

/** Compose: (A∘B)(q) = A(B(q)) = A.m·B.m·q + A.m·B.t + A.t. */
function compose(A, B) {
  const a = A.m, b = B.m;
  const m = [
    [a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1]],
    [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1]],
  ];
  const t = [
    a[0][0] * B.t[0] + a[0][1] * B.t[1] + A.t[0],
    a[1][0] * B.t[0] + a[1][1] * B.t[1] + A.t[1],
  ];
  return { m, t };
}

function det(m) { return m[0][0] * m[1][1] - m[0][1] * m[1][0]; }

// ---------- lattice reduction ----------
// L has columns v1, v2. A translation t = α·v1 + β·v2, so [α,β] = L⁻¹·t. Reducing
// α,β into [0,1) snaps t into the home cell — two isometries are the same coset
// iff their linear parts match and their translations differ by a lattice vector.

function inv2(L) {
  const a = L[0][0], b = L[0][1], c = L[1][0], d = L[1][1];
  const k = a * d - b * c;
  return [[d / k, -b / k], [-c / k, a / k]];
}

function frac(x) {
  let f = x - Math.floor(x);
  if (f > 1 - EPS) f -= 1;          // snap ~1 → 0
  if (Math.abs(f) < EPS) f = 0;     // snap ~0 → 0
  return f;
}

/** Snap t into the home cell of the lattice with columns v1,v2 (Linv = inverse). */
function reduceT(t, L, Linv) {
  const a = frac(Linv[0][0] * t[0] + Linv[0][1] * t[1]);
  const b = frac(Linv[1][0] * t[0] + Linv[1][1] * t[1]);
  return [L[0][0] * a + L[0][1] * b, L[1][0] * a + L[1][1] * b];
}

const r6 = x => Math.round(x * 1e6) / 1e6;

// ---------- closure ----------
/** BFS-close `gens` (plus identity) under composition, reducing translations
 *  modulo the lattice (columns v1,v2). Returns the finite list of coset reps,
 *  identity first, each {m, t} with t snapped into the home cell. */
function closeGroup(gens, v1, v2) {
  const L = [[v1[0], v2[0]], [v1[1], v2[1]]];
  const Linv = inv2(L);
  const key = g => g.m.flat().map(r6).join(',') + '|' +
                   reduceT(g.t, L, Linv).map(r6).join(',');
  const seen = new Map();
  const list = [];
  const add = g => {
    const cg = { m: g.m, t: reduceT(g.t, L, Linv) };
    const k = key(cg);
    if (seen.has(k)) return false;
    seen.set(k, cg); list.push(cg); return true;
  };
  add(I);
  gens.forEach(add);
  let grew = true, guard = 0;
  while (grew && guard++ < 64) {
    grew = false;
    const cur = list.slice();
    for (const g1 of cur) for (const g2 of cur) if (add(compose(g1, g2))) grew = true;
  }
  return list;
}

// ---------- lattices ----------
// Concrete, deliberately-distinct cell shapes per Bravais class so each group
// reads unmistakably. `a`,`b` are the conventional rectangular cell dimensions
// the rect/centred-rect generators reference; v1,v2 are the PRIMITIVE basis the
// tiler steps along (for centred-rect that primitive basis IS the rhombus).
const OBLIQUE_ANGLE = 72 * Math.PI / 180;   // a generic non-special skew
const RECT_RATIO = 0.66;                    // b/a < 1 so rectangles read as rectangles
const RHOMBIC_RATIO = 0.62;                 // ≠1 and ≠√3 ⇒ a true rhombus, not square/hex

function lattice(kind, cell) {
  const d = cell;
  switch (kind) {
    case 'square':  return { v1: [d, 0], v2: [0, d], a: d, b: d };
    case 'rect':    return { v1: [d, 0], v2: [0, d * RECT_RATIO], a: d, b: d * RECT_RATIO };
    case 'rhombic': { const b = d * RHOMBIC_RATIO;
                      return { v1: [d / 2, b / 2], v2: [d / 2, -b / 2], a: d, b }; }
    case 'hex':     return { v1: [d, 0], v2: [d / 2, d * Math.sqrt(3) / 2], a: d, b: d };
    case 'oblique': return { v1: [d, 0], v2: [d * Math.cos(OBLIQUE_ANGLE), d * Math.sin(OBLIQUE_ANGLE)], a: d, b: d };
  }
}

// ---------- the 17 groups ----------
// Each entry: the lattice class + a generator-builder (a,b → seed isometries).
// p3m1 / p31m differ ONLY in mirror orientation on the hex lattice; their labels
// are assigned below by the genuine "are all 3-fold centres on mirrors?" test,
// so the two raw orientations are named hex-mirror-perp / hex-mirror-par here and
// resolved once at module load.
const RAW = {
  p1:   { lat: 'oblique', gens: () => [] },
  p2:   { lat: 'oblique', gens: () => [rot(Math.PI)] },
  pm:   { lat: 'rect',    gens: () => [ref(Math.PI / 2)] },
  pg:   { lat: 'rect',    gens: (a, b) => [glide(Math.PI / 2, [0, b / 2])] },
  cm:   { lat: 'rhombic', gens: () => [ref(Math.PI / 2)] },
  pmm:  { lat: 'rect',    gens: () => [ref(0), ref(Math.PI / 2)] },
  pmg:  { lat: 'rect',    gens: (a, b) => [rot(Math.PI), glide(Math.PI / 2, [0, b / 2])] },
  pgg:  { lat: 'rect',    gens: (a, b) => [rot(Math.PI), glide(0, [a / 2, b / 2])] },
  cmm:  { lat: 'rhombic', gens: () => [ref(0), ref(Math.PI / 2)] },
  p4:   { lat: 'square',  gens: () => [rot(Math.PI / 2)] },
  p4m:  { lat: 'square',  gens: () => [rot(Math.PI / 2), ref(0)] },
  p4g:  { lat: 'square',  gens: (a) => [rot(Math.PI / 2), glide(-Math.PI / 4, [a / 2, a / 2])] },
  p3:   { lat: 'hex',     gens: () => [rot(2 * Math.PI / 3)] },
  p6:   { lat: 'hex',     gens: () => [rot(Math.PI / 3)] },
  p6m:  { lat: 'hex',     gens: () => [rot(Math.PI / 3), ref(0)] },
  // hex 3-fold + a mirror; orientation decides p3m1 vs p31m (resolved at load):
  _hexMirrorPerp: { lat: 'hex', gens: () => [rot(2 * Math.PI / 3), ref(Math.PI / 2)] },
  _hexMirrorPar:  { lat: 'hex', gens: () => [rot(2 * Math.PI / 3), ref(0)] },
};

/** Build the closed coset list + lattice for a raw spec at the given cell size. */
function buildRaw(spec, cell) {
  const lat = lattice(spec.lat, cell);
  const gens = spec.gens(lat.a, lat.b);
  const cosets = closeGroup(gens, lat.v1, lat.v2);
  return { lat, cosets };
}

// ---- resolve p3m1 vs p31m by the rotation-centre-on-mirror invariant ----
// p3m1: every 3-fold centre lies on a mirror line (*333).
// p31m: a 3-fold centre sits OFF all mirror lines (3*3).
// We test the deep honeycomb 3-fold centre (the triangle centroid) against the
// group's mirror lines; whichever orientation puts it ON a mirror is p3m1.

/** Distance from point p to the mirror line of reflection coset `g` (anchor-local). */
function distToMirror(g, p) {
  // mirror line: fixed points of q ↦ m·q + t  ⇒ direction = eigenvector(+1) of m,
  // passing through any fixed point. Easier: reflect p and take half the move ⊥.
  const rp = [g.m[0][0] * p[0] + g.m[0][1] * p[1] + g.t[0],
              g.m[1][0] * p[0] + g.m[1][1] * p[1] + g.t[1]];
  return Math.hypot(rp[0] - p[0], rp[1] - p[1]) / 2;
}

function allThreeFoldCentresOnMirror(built, cell) {
  const mirrors = built.cosets.filter(g => det(g.m) < 0);
  if (!mirrors.length) return false;
  // The honeycomb 3-fold centre nearest the anchor: triangle centroid of the
  // hex cell, (v1+v2)/3, plus its lattice images. Test it against every mirror,
  // including mirror lines shifted by lattice vectors (±v1, ±v2, ...).
  const { v1, v2 } = built.lat;
  const centroid = [(v1[0] + v2[0]) / 3, (v1[1] + v2[1]) / 3];
  const shifts = [];
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++)
    shifts.push([i * v1[0] + j * v2[0], i * v1[1] + j * v2[1]]);
  // centre is "on a mirror" if some mirror (in some lattice copy) passes through it
  return mirrors.some(g => shifts.some(s => {
    const gg = { m: g.m, t: [g.t[0] + s[0], g.t[1] + s[1]] };
    return distToMirror(gg, centroid) < cell * 1e-3;
  }));
}

// Resolve once, at a reference cell size, so GROUPS is the proper 17-name table.
const _refCell = 100;
const _perp = buildRaw(RAW._hexMirrorPerp, _refCell);
const _par  = buildRaw(RAW._hexMirrorPar, _refCell);
const _perpIsP3m1 = allThreeFoldCentresOnMirror(_perp, _refCell);
const P3M1_SPEC = _perpIsP3m1 ? RAW._hexMirrorPerp : RAW._hexMirrorPar;
const P31M_SPEC = _perpIsP3m1 ? RAW._hexMirrorPar : RAW._hexMirrorPerp;

const GROUPS = {
  p1: RAW.p1, p2: RAW.p2, pm: RAW.pm, pg: RAW.pg, cm: RAW.cm,
  pmm: RAW.pmm, pmg: RAW.pmg, pgg: RAW.pgg, cmm: RAW.cmm,
  p4: RAW.p4, p4m: RAW.p4m, p4g: RAW.p4g,
  p3: RAW.p3, p3m1: P3M1_SPEC, p31m: P31M_SPEC,
  p6: RAW.p6, p6m: RAW.p6m,
};

/** Canonical order + human labels (name, the symmetry "story", point-group
 *  order, and a Bravais-flavoured `family` for grouping in menus). */
export const WALLPAPER_GROUPS = [
  ['p1',   'p1 · translations only',          1,  'Rotations'],
  ['p2',   'p2 · 2-fold rotations',           2,  'Rotations'],
  ['pm',   'pm · parallel mirrors',           2,  'Mirrors & glides'],
  ['pg',   'pg · parallel glides',            2,  'Mirrors & glides'],
  ['cm',   'cm · mirror + glide (rhombic)',   2,  'Mirrors & glides'],
  ['pmm',  'pmm · rectangle of mirrors',      4,  'Mirrors & glides'],
  ['pmg',  'pmg · mirrors + 2-fold + glides', 4,  'Mirrors & glides'],
  ['pgg',  'pgg · glides + 2-fold',           4,  'Mirrors & glides'],
  ['cmm',  'cmm · two mirrors + 2-fold',      4,  'Mirrors & glides'],
  ['p4',   'p4 · 4-fold rotations',           4,  'Square (4-fold)'],
  ['p4m',  'p4m · 4-fold + mirrors',          8,  'Square (4-fold)'],
  ['p4g',  'p4g · 4-fold + glides',           8,  'Square (4-fold)'],
  ['p3',   'p3 · 3-fold rotations',           3,  'Hexagonal (3 & 6-fold)'],
  ['p3m1', 'p3m1 · 3-fold, all on mirrors',   6,  'Hexagonal (3 & 6-fold)'],
  ['p31m', 'p31m · 3-fold, some off mirrors', 6,  'Hexagonal (3 & 6-fold)'],
  ['p6',   'p6 · 6-fold rotations',           6,  'Hexagonal (3 & 6-fold)'],
  ['p6m',  'p6m · 6-fold + mirrors',          12, 'Hexagonal (3 & 6-fold)'],
].map(([name, label, order, family]) => ({ name, label, order, family }));

export const WALLPAPER_NAMES = WALLPAPER_GROUPS.map(g => g.name);

export function isWallpaperGroup(name) { return Object.prototype.hasOwnProperty.call(GROUPS, name); }

// ---------- emit: cosets + lattice → flat placement list ----------
/** Convert a closed coset {m,t} into a renderable placement the app applies about
 *  the anchor: a rotation by `angle` (det +1) OR a reflection across the line at
 *  `angle` (det −1), followed by a translation (tx,ty). */
function toPlacement(g) {
  if (det(g.m) > 0) {
    return { reflect: false, angle: Math.atan2(g.m[1][0], g.m[0][0]), tx: g.t[0], ty: g.t[1] };
  }
  return { reflect: true, angle: 0.5 * Math.atan2(g.m[0][1], g.m[0][0]), tx: g.t[0], ty: g.t[1] };
}

/** Lattice cell offsets within `reps` steps of the anchor, nearest-first so the
 *  un-shifted home cell stays at index 0. */
function cellOffsets(lat, reps) {
  const { v1, v2 } = lat;
  const offs = [];
  for (let j = -reps; j <= reps; j++)
    for (let i = -reps; i <= reps; i++)
      offs.push({ ox: i * v1[0] + j * v2[0], oy: i * v1[1] + j * v2[1] });
  offs.sort((p, q) => (p.ox * p.ox + p.oy * p.oy) - (q.ox * q.ox + q.oy * q.oy));
  return offs;
}

/**
 * The full set of motif placements for `group` at `cell` spacing, tiled `reps`
 * cells out from the anchor. Each placement is {reflect, angle, tx, ty}; index 0
 * is the geometric identity (untransformed copy at the anchor). Apply each as:
 *   reflect ? reflectAbout(anchor, angle) : rotateAbout(anchor, angle);  then
 *   translate(tx, ty).
 */
export function wallpaperPlacements(group, cell, reps) {
  const spec = GROUPS[group];
  if (!spec) return [{ reflect: false, angle: 0, tx: 0, ty: 0 }];
  const { lat, cosets } = buildRaw(spec, cell);
  const places = cosets.map(toPlacement);
  const offs = cellOffsets(lat, Math.max(0, Math.round(reps)));
  const out = [];
  for (const { ox, oy } of offs)
    for (const p of places)
      out.push({ reflect: p.reflect, angle: p.angle, tx: p.tx + ox, ty: p.ty + oy });
  return out;
}

/** Cosets-per-cell (point-group order) for `group`, for previews/tests/UI. */
export function wallpaperCellCount(group, cell = 100) {
  const spec = GROUPS[group];
  return spec ? buildRaw(spec, cell).cosets.length : 1;
}

/** The lattice basis (v1,v2) + conventional cell (a,b) for `group` at `cell`, for
 *  drawing the cell guide. */
export function wallpaperLattice(group, cell) {
  const spec = GROUPS[group];
  return spec ? buildRaw(spec, cell).lat : lattice('square', cell);
}

// ---------- fundamental domain (the one region you actually draw into) ----------
/** Signed area of a polygon given as [[x,y], ...] (shoelace). */
function polyArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Sutherland–Hodgman clip of a convex polygon `poly` ([[x,y],...]) to the
 *  half-plane { x : nx·x + ny·y ≤ c }. Returns the clipped polygon (may be empty). */
function clipHalfPlane(poly, nx, ny, c) {
  const out = [];
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const da = nx * a[0] + ny * a[1] - c;
    const db = nx * b[0] + ny * b[1] - c;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {       // edge crosses the line
      const t = da / (da - db);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}

/**
 * The FUNDAMENTAL DOMAIN of a wallpaper group at `cell` spacing, in anchor-local
 * world coordinates — the single region whose images under the whole group tile
 * the plane exactly once. The teaching payload: "draw in HERE; the symmetry fills
 * the rest of the plane."
 *
 * Construction: the DIRICHLET (Voronoi) cell of a seed point s with trivial
 * stabiliser — the set of points at least as close to s as to every group image of
 * s. That convex region is always a fundamental domain (area = cellArea / cosets),
 * and the construction is fully general: it bounds the glide-only groups (pg, pgg,
 * pmg, p4g) too, where no mirror line is available to clip against.
 *
 * We seed s *close to the anchor* in a deliberately generic direction (0.4 rad ≠
 * any 0/30/45/60/90° mirror axis, so the stabiliser is trivial). Pinning the seed
 * to the symmetry centre makes the Dirichlet cell's apex land on the rotation/
 * mirror point, so the result reads as the textbook wedge/strip students recognise
 * rather than an off-centre Wigner–Seitz blob. Returns a polygon [{x,y}] (CCW),
 * or null for an unknown group.
 */
export function fundamentalDomain(group, cell) {
  const spec = GROUPS[group];
  if (!spec) return null;
  const { lat, cosets } = buildRaw(spec, cell);
  const eps = cell * 0.02;                       // small ⇒ apex pins to the anchor
  const s = [eps * Math.cos(0.4), eps * Math.sin(0.4)];
  const s2 = s[0] * s[0] + s[1] * s[1];
  // Orbit of s: every coset, tiled a couple of cells out — enough neighbours that
  // the local Voronoi cell is fully determined by the bisectors we clip against.
  const offs = cellOffsets(lat, 2);
  // Start from a box around s certain to contain the cell, clip by each bisector.
  const H = cell * 1.8;
  let poly = [[s[0] - H, s[1] - H], [s[0] + H, s[1] - H],
              [s[0] + H, s[1] + H], [s[0] - H, s[1] + H]];
  for (const { ox, oy } of offs) {
    for (const g of cosets) {
      const px = g.m[0][0] * s[0] + g.m[0][1] * s[1] + g.t[0] + ox;
      const py = g.m[1][0] * s[0] + g.m[1][1] * s[1] + g.t[1] + oy;
      const dx = px - s[0], dy = py - s[1];
      if (dx * dx + dy * dy < EPS) continue;     // s itself (the identity image)
      // keep { x : |x−s|² ≤ |x−p|² } ⇔ 2·x·(p−s) ≤ |p|²−|s|²
      poly = clipHalfPlane(poly, 2 * dx, 2 * dy, (px * px + py * py) - s2);
      if (poly.length < 3) return null;          // degenerate (shouldn't happen)
    }
  }
  if (polyArea(poly) < 0) poly.reverse();        // normalise to CCW
  return poly.map(([x, y]) => ({ x, y }));
}

// Exposed for the standalone math check (tests/_wallpapercheck.mjs).
export const _internal = { buildRaw, GROUPS, RAW, det, compose, distToMirror,
                           allThreeFoldCentresOnMirror, _perpIsP3m1 };
