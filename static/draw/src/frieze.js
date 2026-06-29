// The 7 FRIEZE GROUPS — the 1-D sibling of the 17 wallpaper groups.
//
// A frieze (strip) pattern repeats in exactly ONE direction. Up to symmetry,
// every such pattern is classified by one of the SEVEN frieze groups — the
// middle term of the classical crystallographic trio (point groups · frieze
// groups · wallpaper groups). This module is the generative engine for all 7,
// built the same way `wallpaper.js` builds its 17:
//
//   group  =  (a 1-D lattice: one translation period p along the strip axis, +x)
//          +  (a few GENERATOR isometries that, with the period, generate every
//              symmetry of the strip).
//
// We BFS-CLOSE the generators under composition, reducing each result's
// translation ALONG THE STRIP modulo the period (the cross-strip component is
// always 0 — every frieze symmetry preserves the strip axis, so it can never
// translate across it). That finite set is the point group's cosets: the
// distinct copies of the motif inside ONE period. Tiling those across i·p fills
// the strip.
//
// Each coset is emitted as the SAME "placement" shape the wallpaper engine uses
// — {reflect, angle, tx, ty} — so the app drives frieze tilings through the very
// same rotateItemsAbout / reflectItemsAbout / translateItem primitives, with no
// new commit/draft path. tests/_friezecheck.mjs proves all 7 close to the right
// order (1,2,2,2,4,2,4) and that every placement is a valid isometry.
//
// Orientation convention (strip runs horizontally, period along +x, anchor on
// the centre line y=0):
//   • a HORIZONTAL mirror (axis = the centre line)      → ref(0):    (x,y)→(x,−y)
//   • a VERTICAL mirror (axis ⊥ the strip)              → ref(π/2):  (x,y)→(−x,y)
//   • a glide along the strip                           → glide(0,[p/2,0])
//   • a 2-fold rotation about a point on the centre line→ rot(π):    (x,y)→(−x,−y)

const EPS = 1e-7;

// ---------- 2×2 orthogonal-isometry algebra (anchor-local coordinates) ----------
// Same algebra as wallpaper.js, kept self-contained so this engine is a clean,
// independently-auditable sibling (the shared primitives are tiny and stable).
// An isometry acts on q (a point relative to the anchor) as q ↦ m·q + t.

const I = { m: [[1, 0], [0, 1]], t: [0, 0] };

/** Rotation by θ about the anchor (matches app rotateItemsAbout). */
function rot(theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  return { m: [[c, -s], [s, c]], t: [0, 0] };
}

/** Reflection across the line through the anchor at angle `a` (matches the app's
 *  reflectItemsAbout convention: Ref_a = [[cos2a, sin2a],[sin2a, −cos2a]]). */
function ref(a) {
  const c = Math.cos(2 * a), s = Math.sin(2 * a);
  return { m: [[c, s], [s, -c]], t: [0, 0] };
}

/** Glide: reflect across the line at angle `a` through the anchor, then translate
 *  by g. For a true strip glide g²=[p,0] lands on the lattice period. */
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

const r6 = x => Math.round(x * 1e6) / 1e6;

// ---------- closure (1-D lattice: reduce x mod period, keep y) ----------
/** Snap a translation into the home period: x mod p ∈ [0,p), y untouched (always
 *  0 for a frieze symmetry, but carried through for honesty). */
function reduceT(t, period) {
  let x = t[0] % period;
  if (x < -EPS) x += period;
  if (Math.abs(x) < EPS || Math.abs(x - period) < EPS) x = 0;   // snap ~0 / ~p → 0
  return [x, t[1]];
}

/** BFS-close `gens` (plus identity) under composition, reducing translations
 *  modulo the period. Returns the finite coset list, identity first, each {m,t}
 *  with t snapped into the home period. */
function closeGroup(gens, period) {
  const key = g => g.m.flat().map(r6).join(',') + '|' +
                   reduceT(g.t, period).map(r6).join(',');
  const seen = new Map();
  const list = [];
  const add = g => {
    const cg = { m: g.m, t: reduceT(g.t, period) };
    const k = key(cg);
    if (seen.has(k)) return false;
    seen.set(k, cg); list.push(cg); return true;
  };
  add(I);
  gens.forEach(add);
  let grew = true, guard = 0;
  while (grew && guard++ < 32) {
    grew = false;
    const cur = list.slice();
    for (const g1 of cur) for (const g2 of cur) if (add(compose(g1, g2))) grew = true;
  }
  return list;
}

// ---------- the 7 groups ----------
// Each entry: a generator-builder (period → seed isometries). Keyed by a PREFIXED
// identifier ('fz_<iuc>'): the frieze groups p1/p2 share IUC notation with the
// wallpaper groups p1/p2 (they are genuinely different groups), so a distinct key
// keeps the shared `symmetry.group` namespace unambiguous. The clean IUC name and
// Conway nickname live in FRIEZE_GROUPS' label below.
const GROUPS = {
  // p1 (hop) — translations only.
  fz_p1:   () => [],
  // p11g (step) — a glide reflection along the strip; half-period offset.
  fz_p11g: (p) => [glide(0, [p / 2, 0])],
  // p1m1 (sidle) — vertical mirrors perpendicular to the strip.
  fz_p1m1: () => [ref(Math.PI / 2)],
  // p2 (spinning hop) — 2-fold rotations on the centre line.
  fz_p2:   () => [rot(Math.PI)],
  // p2mg (spinning sidle) — vertical mirror + glide ⇒ also 2-fold rotations.
  fz_p2mg: (p) => [ref(Math.PI / 2), glide(0, [p / 2, 0])],
  // p11m (jump) — one horizontal mirror along the centre line.
  fz_p11m: () => [ref(0)],
  // p2mm (spinning jump) — horizontal + vertical mirrors ⇒ also 2-fold rotations.
  fz_p2mm: () => [ref(0), ref(Math.PI / 2)],
};

/** Build the closed coset list for a group at the given period. */
function buildGroup(name, period) {
  const gen = GROUPS[name];
  if (!gen) return null;
  return closeGroup(gen(period), period);
}

/** Canonical order + human labels: prefixed id, the symmetry "story" (IUC name +
 *  Conway nickname), and the point-group order (copies per period). */
export const FRIEZE_GROUPS = [
  ['fz_p1',   'p1 · hop — translations only',            1],
  ['fz_p11g', 'p11g · step — glide reflection',          2],
  ['fz_p1m1', 'p1m1 · sidle — vertical mirrors',         2],
  ['fz_p2',   'p2 · spinning hop — 2-fold turns',        2],
  ['fz_p11m', 'p11m · jump — horizontal mirror',         2],
  ['fz_p2mg', 'p2mg · spinning sidle — mirror + glide',  4],
  ['fz_p2mm', 'p2mm · spinning jump — full symmetry',    4],
].map(([name, label, order]) => ({ name, label, order }));

export const FRIEZE_NAMES = FRIEZE_GROUPS.map(g => g.name);

export function isFriezeGroup(name) {
  return Object.prototype.hasOwnProperty.call(GROUPS, name);
}

// ---------- emit: cosets → flat placement list ----------
/** Convert a closed coset {m,t} into a renderable placement applied about the
 *  anchor: a rotation by `angle` (det +1) OR a reflection across the line at
 *  `angle` (det −1), followed by a translation (tx,ty). Identical shape to the
 *  wallpaper engine's placements, so the app's _applyPlacement drives both. */
function toPlacement(g) {
  if (det(g.m) > 0) {
    return { reflect: false, angle: Math.atan2(g.m[1][0], g.m[0][0]), tx: g.t[0], ty: g.t[1] };
  }
  return { reflect: true, angle: 0.5 * Math.atan2(g.m[0][1], g.m[0][0]), tx: g.t[0], ty: g.t[1] };
}

/** Period indices within `reps` of the anchor, nearest-first (0,−1,1,−2,2,…) so
 *  the home strip stays at the front and the identity copy is at index 0. */
function periodIndices(reps) {
  const out = [0];
  for (let i = 1; i <= reps; i++) { out.push(-i); out.push(i); }
  return out;
}

/**
 * The full set of motif placements for `group` at `period` spacing, tiled `reps`
 * periods out from the anchor along +x. Each placement is {reflect, angle, tx,
 * ty}; index 0 is the geometric identity (untransformed copy at the anchor).
 * Apply each as: reflect ? reflectAbout(anchor,angle) : rotateAbout(anchor,angle);
 * then translate(tx,ty).
 */
export function friezePlacements(group, period, reps) {
  const cosets = buildGroup(group, period);
  if (!cosets) return [{ reflect: false, angle: 0, tx: 0, ty: 0 }];
  const places = cosets.map(toPlacement);
  const idx = periodIndices(Math.max(0, Math.round(reps)));
  const out = [];
  for (const i of idx)
    for (const p of places)
      out.push({ reflect: p.reflect, angle: p.angle, tx: p.tx + i * period, ty: p.ty });
  return out;
}

/** Copies-per-period (point-group order) for `group`, for previews/tests/UI. */
export function friezeCellCount(group) {
  const cosets = buildGroup(group, 100);
  return cosets ? cosets.length : 1;
}

// ---------- strip geometry (the teaching guide) ----------
// The strip's cross-axis HEIGHT is a presentation choice — a frieze is unbounded
// across the strip, so nothing fixes it mathematically. We read the strip as a
// little wider than tall (a band), centred on the anchor's centre line.
const BAND_RATIO = 0.62;
export function friezeBandHeight(period) { return period * BAND_RATIO; }

/** Signed area of a polygon [[x,y],…] (shoelace). */
function polyArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Sutherland–Hodgman clip of a convex polygon to the half-plane {x: n·x ≤ c}. */
function clipHalfPlane(poly, nx, ny, c) {
  const out = [];
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const da = nx * a[0] + ny * a[1] - c;
    const db = nx * b[0] + ny * b[1] - c;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}

/**
 * The FUNDAMENTAL DOMAIN of a frieze group at `period` spacing, in anchor-local
 * coordinates — the single region of the home strip whose images under the whole
 * group tile the strip exactly once ("draw in HERE; the symmetry fills the rest
 * of the strip"). Same Dirichlet (Voronoi) construction as wallpaper.js: the set
 * of points at least as close to a generic seed s as to every group image of s,
 * intersected with the home strip band. Returns a polygon [{x,y}] (CCW), or null
 * for an unknown group.
 */
export function friezeFundamentalDomain(group, period) {
  const cosets = buildGroup(group, period);
  if (!cosets) return null;
  const h = friezeBandHeight(period);
  const eps = period * 0.02;                         // small ⇒ apex pins to anchor
  const s = [eps * Math.cos(0.4), eps * Math.sin(0.4)];
  const s2 = s[0] * s[0] + s[1] * s[1];
  // The home strip band, centred on the anchor: x∈[−p/2,p/2], y∈[−h/2,h/2].
  let poly = [[-period / 2, -h / 2], [period / 2, -h / 2],
              [period / 2, h / 2], [-period / 2, h / 2]];
  // Orbit of s: every coset, tiled a couple of periods out, clips the band by its
  // perpendicular bisector with s.
  for (let i = -2; i <= 2; i++) {
    for (const g of cosets) {
      const px = g.m[0][0] * s[0] + g.m[0][1] * s[1] + g.t[0] + i * period;
      const py = g.m[1][0] * s[0] + g.m[1][1] * s[1] + g.t[1];
      const dx = px - s[0], dy = py - s[1];
      if (dx * dx + dy * dy < EPS) continue;         // s itself (identity image)
      // keep { x : |x−s|² ≤ |x−p|² } ⇔ 2·x·(p−s) ≤ |p|²−|s|²
      poly = clipHalfPlane(poly, 2 * dx, 2 * dy, (px * px + py * py) - s2);
      if (poly.length < 3) return null;
    }
  }
  if (polyArea(poly) < 0) poly.reverse();            // normalise to CCW
  return poly.map(([x, y]) => ({ x, y }));
}

// Exposed for the standalone math check (tests/_friezecheck.mjs).
export const _internal = { buildGroup, closeGroup, GROUPS, det, compose, rot, ref, glide, reduceT };
