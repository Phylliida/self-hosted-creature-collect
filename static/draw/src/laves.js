// The 11 LAVES tilings — the DUALS of the 11 uniform (Archimedean) tilings.
//
// A uniform tiling (src/uniform.js) is ISOGONAL: every vertex looks the same, the
// tiles are regular polygons of mixed shape. Its DUAL swaps that: it is ISOHEDRAL
// (face-transitive) — a SINGLE tile shape (generally NOT a regular polygon),
// repeated, with vertices of mixed valence. These 11 monohedral duals are the
// Laves (a.k.a. Catalan) tilings, and together with the uniform set they are the
// face-transitive ↔ vertex-transitive two sides of the same classification.
//
// CONSTRUCTION (the textbook planar dual — generative, not a lookup table). Take
// the uniform tiling. Put a dual VERTEX at the centre of every uniform FACE. For
// each uniform VERTEX v, the dual FACE around it is the polygon whose corners are
// the centres of the faces incident to v, in cyclic order. Because every uniform
// face is a regular polygon, its centroid is its circumcentre, so this is the
// exact Laves tiling — proven monohedral and edge-to-edge in tests/_lavescheck.mjs
// (every interior dual face is congruent, and each dual edge is shared by two
// faces). The two snub duals are the litmus tests: dual of 3.3.4.3.4 = the CAIRO
// pentagonal tiling, dual of 3.3.3.3.6 = the FLORET pentagonal tiling — both EMERGE
// (all-pentagon, the right angles) rather than being coded by hand.
//
// We reuse src/uniform.js wholesale (uniformTiles gives the regular-polygon faces);
// this module is only the dual map + an orientation colouring. Coordinates use +y
// up like uniform.js / penrose.js; the wrapper flips y for the screen-down renderer.

import { uniformTiles, uniformKinds, _internal } from './uniform.js';

const { centroid } = _internal;
const TAU = Math.PI * 2;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];

// Interior angle (radians) of polygon `loop` at its vertex nearest to point p
// (the angle subtended at the shared corner). Used to test that a uniform vertex
// is FULLY surrounded — its incident faces' angles sum to 2π — so its dual face is
// complete (boundary vertices, whose ring runs off the generated patch, are skipped).
function angleAtVertex(loop, p) {
  const vk = q => `${Math.round(q[0] * 1e4)},${Math.round(q[1] * 1e4)}`;
  const key = vk(p);
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    if (vk(loop[i]) !== key) continue;
    const a = sub(loop[(i - 1 + n) % n], loop[i]);
    const b = sub(loop[(i + 1) % n], loop[i]);
    const d = (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b));
    return Math.acos(Math.max(-1, Math.min(1, d)));
  }
  return 0;
}

/**
 * The Laves (dual) tiling of uniform `kind` as an array of vertex-loops (dual
 * faces), within radius `R`. Each face is the cyclically-ordered set of incident
 * uniform-face centres around one fully-surrounded uniform vertex.
 */
export function lavesTiles(kind, R = 7) {
  const tiles = uniformTiles(kind, R + 2.5);      // pad so vertices within R are fully ringed
  const vk = p => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
  const vmap = new Map();                          // vertex key → { pt, faces:[tileIndex] }
  tiles.forEach((loop, ti) => {
    for (const p of loop) {
      const k = vk(p);
      if (!vmap.has(k)) vmap.set(k, { pt: p, faces: [] });
      vmap.get(k).faces.push(ti);
    }
  });
  const out = [];
  for (const { pt, faces } of vmap.values()) {
    if (Math.hypot(pt[0], pt[1]) > R) continue;
    // fully surrounded? incident interior angles must sum to 2π (else a boundary
    // vertex with part of its ring off-patch → an incomplete, wrong dual face).
    let angSum = 0;
    for (const ti of faces) angSum += angleAtVertex(tiles[ti], pt);
    if (Math.abs(angSum - TAU) > 1e-3) continue;
    const cents = faces.map(ti => centroid(tiles[ti]));
    cents.sort((a, b) => Math.atan2(a[1] - pt[1], a[0] - pt[0]) - Math.atan2(b[1] - pt[1], b[0] - pt[0]));
    out.push(cents);
  }
  return out;
}

export function lavesKinds() { return uniformKinds(); }

// Orientation palette: colour each (congruent) Laves tile by its rotation, so
// adjacent tiles read distinctly and the chiral duals (Cairo, Floret) bloom into
// pinwheels. The hue index is the angle of the tile's first long edge, bucketed.
const ORIENT_FILLS = ['#ff8787', '#ffd43b', '#69db7c', '#4dabf7', '#b197fc', '#ffa94d', '#3bc9db', '#f783ac'];

function orientationIndex(loop, buckets) {
  // longest edge direction → a stable per-tile orientation; quantise to buckets.
  let best = -1, bi = 0;
  for (let i = 0; i < loop.length; i++) {
    const d = Math.hypot(...sub(loop[(i + 1) % loop.length], loop[i]));
    if (d > best) { best = d; bi = i; }
  }
  const e = sub(loop[(bi + 1) % loop.length], loop[bi]);
  let a = Math.atan2(e[1], e[0]); if (a < 0) a += TAU;
  return Math.floor((a / TAU) * buckets) % buckets;
}

/**
 * Generator wrapper: build the Laves dual of uniform `kind` as filled-polygon item
 * specs. Each dual face → one closed, filled `stroke` item (edges drawn as grout),
 * coloured by orientation. `size` is world units per uniform unit edge (kept equal
 * to the uniform generator so toggling dual ↔ uniform stays the same scale).
 */
export function lavesTiling({ kind = '3.3.4.3.4', size = 70, radius = 7, x = 0, y = 0,
                              fills = ORIENT_FILLS, edge = '#10121a', width = null } = {}) {
  const tiles = lavesTiles(kind, radius);
  const lw = width != null ? width : Math.max(size * 0.018, 0.4);
  const buckets = fills.length;
  const tx = ([px, py]) => ({ x: x + px * size, y: y - py * size });   // +y up → screen down
  return tiles.map(loop => ({
    type: 'stroke',
    points: loop.concat([loop[0]]).map(tx),
    color: edge,
    fill: fills[orientationIndex(loop, buckets)],
    width: lw,
  }));
}

export const _internal_laves = { lavesTiles, angleAtVertex, orientationIndex };
