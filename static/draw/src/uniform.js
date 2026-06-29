// Uniform tilings of the plane — the 3 REGULAR + 8 SEMIREGULAR (Archimedean)
// edge-to-edge tilings by regular polygons (every vertex the same configuration).
// This is the canonical COMPLETE, finite, named set of "tilings" most people
// picture (hexagons, the bathroom-floor octagon-and-square, the kagome lattice…),
// and the natural geometric companion to the symmetry-group families (the 17
// wallpaper + 7 frieze groups live in src/wallpaper.js / src/frieze.js): those
// classify *symmetries*; these are concrete *geometries*. See generators.js.
//
// REPRESENTATION. A tile is just its vertex loop: an array of [x,y] points (unit
// edge length). A tiling is defined by a MOTIF (a central polygon plus enough of
// its neighbourhood that lattice-translating it covers the plane) and two lattice
// vectors v1,v2. We deliberately let the motif OVER-specify (include neighbours
// that belong to adjacent cells): translating it by every i·v1+j·v2 produces
// duplicates, which a global centroid-dedupe removes. Over-specifying is safe;
// under-specifying leaves gaps — which tests/_uniformcheck.mjs catches (an
// interior edge bordered by <2 tiles). The checker independently proves each
// output is a real tiling: every tile a regular unit-edge polygon, edge-to-edge,
// every interior vertex matching the named configuration, and area density right.
//
// Coordinates use +y up (math convention); the generator wrapper flips y so the
// renderer's screen-down y is correct, exactly like src/penrose.js.

const TAU = Math.PI * 2;
const H = Math.sqrt(3) / 2;            // height of a unit equilateral triangle ≈ 0.8660
const SQ2 = Math.SQRT2;                // √2
const SILVER = 1 + SQ2;                // 1+√2 ≈ 2.4142 (octagon flat-to-flat)
const DODEC = 2 + Math.sqrt(3);        // 2+√3 ≈ 3.7321 (dodecagon flat-to-flat)

// Circumradius / apothem of a unit-edge regular n-gon.
const circum = n => 1 / (2 * Math.sin(Math.PI / n));
const apoth = n => 1 / (2 * Math.tan(Math.PI / n));

/** Vertex loop of a unit-edge regular n-gon, first vertex at angle `startDeg`. */
function reg(n, cx, cy, startDeg = 0) {
  const R = circum(n), a0 = startDeg * Math.PI / 180, out = [];
  for (let k = 0; k < n; k++) {
    const a = a0 + k * TAU / n;
    out.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  }
  return out;
}

// Vector helpers on [x,y].
const add = (p, q) => [p[0] + q[0], p[1] + q[1]];
const sub = (p, q) => [p[0] - q[0], p[1] - q[1]];
const rot = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]; };

/**
 * Build the unit-edge regular m-gon that shares the directed edge A→B and lies
 * on its LEFT (the side of the +90° normal of A→B). Returns the vertex loop with
 * A and B as its first two vertices. The fundamental "attach a polygon to an
 * existing edge" primitive used to grow the trickier motifs (snubs, 4.6.12).
 */
function onEdge(A, B, m) {
  const out = [A, B];
  let prev = A, cur = B;
  // Interior angle of a regular m-gon; we turn LEFT by (π − interior) at each step.
  const turn = Math.PI - (m - 2) * Math.PI / m;     // = exterior angle 2π/m
  for (let k = 0; k < m - 2; k++) {
    const dir = sub(cur, prev);                      // current edge direction
    const next = add(cur, rot(dir, turn));           // turn left
    out.push(next);
    prev = cur; cur = next;
  }
  return out;
}

const centroid = poly => {
  let x = 0, y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
};

// ---------------------------------------------------------------------------
// The 11 uniform tilings. Each builder returns { motif, v1, v2 }.
// `motif` is an array of vertex loops (a polygon + enough neighbours to cover a
// cell under lattice translation). Helpers below keep the data declarative.
// ---------------------------------------------------------------------------

// Regular triangle from three explicit points (kept verbatim — checker proves
// it is unit-edge equilateral).
const tri = (a, b, c) => [a, b, c];

const BUILDERS = {
  // ---- 3 REGULAR ----------------------------------------------------------
  // 4.4.4.4 — the square tiling.
  '4.4.4.4': () => ({
    motif: [reg(4, 0.5, 0.5, 45)],
    v1: [1, 0], v2: [0, 1],
  }),

  // 3.3.3.3.3.3 — the triangular tiling (6 triangles per vertex).
  '3.3.3.3.3.3': () => ({
    motif: [tri([0, 0], [1, 0], [0.5, H]), tri([1, 0], [1.5, H], [0.5, H])],
    v1: [1, 0], v2: [0.5, H],
  }),

  // 6.6.6 — the hexagonal (honeycomb) tiling.
  '6.6.6': () => ({
    motif: [reg(6, 0, 0, 0)],
    v1: [1.5, H], v2: [0, 2 * H],
  }),

  // ---- 8 SEMIREGULAR (ARCHIMEDEAN) ---------------------------------------
  // 3.6.3.6 — trihexagonal (the kagome lattice): hexagon ringed by triangles.
  '3.6.3.6': () => {
    const hex = reg(6, 0, 0, 0);
    const motif = [hex];
    for (let k = 0; k < 6; k++) {              // a triangle on every hex edge
      motif.push(onEdge(hex[(k + 1) % 6], hex[k], 3));   // reversed edge → outward
    }
    return { motif, v1: [2, 0], v2: [1, 2 * H] };
  },

  // 3.4.6.4 — rhombitrihexagonal: hexagon, a square on each edge, triangles in
  // the corner gaps. Hex centres on a triangular lattice, spacing 1+√3.
  '3.4.6.4': () => {
    const hex = reg(6, 0, 0, 0);
    const motif = [hex];
    for (let k = 0; k < 6; k++) motif.push(onEdge(hex[(k + 1) % 6], hex[k], 4)); // square per edge
    for (const t of triGaps346(hex)) motif.push(t);                              // triangle per corner gap
    const R = 1 + Math.sqrt(3);
    return { motif, v1: [R * H, R / 2], v2: [0, R] };
  },

  // 4.8.8 — truncated square: octagons with small (45°-rotated) squares between.
  '4.8.8': () => {
    const c = SILVER / 2;
    return {
      motif: [reg(8, 0, 0, 22.5), reg(4, c, c, 0), reg(4, -c, c, 0), reg(4, c, -c, 0), reg(4, -c, -c, 0)],
      v1: [SILVER, 0], v2: [0, SILVER],
    };
  },

  // 3.12.12 — truncated hexagonal: dodecagons share alternate edges directly;
  // a triangle fills each of the OTHER six edges. (Adjacent dodecagons come from
  // lattice translation, so the motif is one dodecagon + its six gap triangles.)
  '3.12.12': () => {
    const dod = reg(12, 0, 0, 15);
    const motif = [dod];
    for (let k = 0; k < 12; k += 2) motif.push(onEdge(dod[(k + 1) % 12], dod[k], 3));
    return { motif, v1: [DODEC, 0], v2: [DODEC / 2, DODEC * H] };
  },

  // 3.3.3.4.4 — elongated triangular: rows of squares separated by rows of
  // triangles. Each square row is shifted half a unit from the next, so the
  // lattice is oblique: v2 = (½, 1+h).
  '3.3.3.4.4': () => ({
    motif: [
      [[0, 0], [1, 0], [1, 1], [0, 1]],                  // square
      [[0, 1], [1, 1], [0.5, 1 + H]],                    // up triangle
      [[0, 1], [0.5, 1 + H], [-0.5, 1 + H]],             // down triangle
    ],
    v1: [1, 0], v2: [0.5, 1 + H],
  }),

  // 4.6.12 — truncated trihexagonal (great rhombitrihexagonal): a dodecagon with
  // hexagons and squares attached to alternating edges. Dodecagon centres form a
  // triangular lattice of spacing 3+√3 (1 dodecagon : 2 hexagons : 3 squares).
  '4.6.12': () => {
    const dod = reg(12, 0, 0, 15);
    const motif = [dod];
    for (let k = 0; k < 12; k++) motif.push(onEdge(dod[(k + 1) % 12], dod[k], k % 2 === 0 ? 6 : 4));
    const S = 3 + Math.sqrt(3);
    return { motif, v1: [S, 0], v2: [S / 2, S * H] };
  },

  // 3.3.4.3.4 — snub square (CHIRAL). The central cluster (a square ringed by 4
  // triangles, each paired with a rhombus-partner triangle, plus 4 rotated
  // squares) is grown locally, then tiled by p4's square lattice (side √(2+√3),
  // tilted): v1 = (½, −(1+h)), v2 = (1+h, ½). Two square orientations per cell.
  '3.3.4.3.4': () => ({ motif: snubSquareCluster(), v1: [-0.5, -(1 + H)], v2: [1 + H, -0.5] }),

  // 3.3.3.3.6 — snub trihexagonal / snub hexagonal (CHIRAL): hexagons adrift in a
  // sea of triangles, 4 triangles + 1 hexagon at every vertex. Hexagon centres
  // form a triangular lattice of spacing √7, ROTATED ~19.1° (the snub angle) from
  // the hexagons (p6). The neighbour hexagon sits at (5/2, √3/2). 6-fold corona.
  '3.3.3.3.6': () => {
    const hex = reg(6, 0, 0, 0);
    const T1 = [[1, 0], [0.5, H], [1.5, H]];        // triangle on a hexagon edge
    const Ta = [[1, 0], [1.5, -H], [2, 0]];          // corner pair filling toward the neighbour
    const Tb = [[1, 0], [2, 0], [1.5, H]];
    const motif = [hex];
    for (let k = 0; k < 6; k++) {
      const a = k * Math.PI / 3;
      for (const t of [T1, Ta, Tb]) motif.push(t.map(p => rot(p, a)));
    }
    return { motif, v1: [2.5, H], v2: [0.5, 3 * H] };
  },
};

// The consistent central cluster of the snub square tiling, grown by a short
// edge flood-fill from per-edge ROLES (square edge → triangle; triangle → 2
// squares + 1 rhombus-partner triangle). The flood-fill's local partner rule is
// only globally consistent within this small cluster — beyond it the handedness
// becomes ambiguous (a triangle is reachable from either square-neighbour) — so
// we grow just the cluster and let the lattice extend it.
function snubSquareCluster(R = 1.45) {
  const tiles = [], queue = [], seen = new Set();
  const ckey = c => `${Math.round(c[0] * 1e3)},${Math.round(c[1] * 1e3)}`;
  function push(pts, roles) {
    const c = centroid(pts);
    if (Math.hypot(...c) > R) return;
    const k = ckey(c);
    if (seen.has(k)) return;
    seen.add(k);
    const t = { pts, roles };
    tiles.push(t); queue.push(t);
  }
  push([[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]], ['triBase', 'triBase', 'triBase', 'triBase']);
  while (queue.length) {
    const t = queue.shift(), n = t.pts.length;
    for (let i = 0; i < n; i++) {
      const role = t.roles[i];
      if (role === 'filled') continue;
      const p = t.pts[i], q = t.pts[(i + 1) % n];     // tile interior on left of p→q; neighbour = onEdge(q,p,…)
      if (role === 'sq') {
        push(onEdge(q, p, 4), ['filled', 'triBase', 'triBase', 'triBase']);
      } else {
        // a triangle. triBase: base here, partner + square on the slants;
        // triPartner: came across the partner edge, both other edges squares.
        const roles = role === 'triBase'
          ? ['filled', 'triPartner', 'sq']            // chirality: partner = first slant
          : ['filled', 'sq', 'sq'];
        push(onEdge(q, p, 3), roles);
      }
    }
  }
  return tiles.map(t => t.pts);
}

// 3.4.6.4 triangle gaps: one triangle pointing out at each hex vertex.
function triGaps346(hex) {
  const out = [];
  for (let k = 0; k < 6; k++) {
    const v = hex[k];
    // the two squares adjacent to this vertex contribute their outer corners;
    // the triangle is v + those two corners. Build by attaching a triangle to
    // the two square edges meeting at v — simplest: reflect v across far point.
    const ang = Math.atan2(v[1], v[0]);
    const tipA = add(v, [Math.cos(ang - Math.PI / 6), Math.sin(ang - Math.PI / 6)]);
    const tipB = add(v, [Math.cos(ang + Math.PI / 6), Math.sin(ang + Math.PI / 6)]);
    out.push([v, tipA, tipB]);
  }
  return out;
}

export function uniformKinds() {
  return Object.keys(BUILDERS);
}

/** Build the raw tiling: an array of vertex-loops covering radius `R`. */
export function uniformTiles(kind, R = 7) {
  const b = BUILDERS[kind];
  if (!b) return [];
  const { motif, v1, v2 } = b();
  const out = [];
  const seen = new Set();
  // lattice index range to cover the disk
  const span = Math.ceil(R / Math.min(Math.hypot(...v1), Math.hypot(...v2))) + 3;
  for (let i = -span; i <= span; i++) {
    for (let j = -span; j <= span; j++) {
      const off = [i * v1[0] + j * v2[0], i * v1[1] + j * v2[1]];
      for (const poly of motif) {
        const moved = poly.map(p => [p[0] + off[0], p[1] + off[1]]);
        const c = centroid(moved);
        if (Math.hypot(c[0], c[1]) > R) continue;
        const key = `${Math.round(c[0] * 1e4)},${Math.round(c[1] * 1e4)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(moved);
      }
    }
  }
  return out;
}

// Fill colour by polygon side-count, so each tiling reads as a clear two/three
// colour pattern (triangles coral, squares gold, hexagons green, octagons blue,
// dodecagons violet). Matches the palette family used elsewhere in the app.
const FILL_BY_N = { 3: '#ff8787', 4: '#ffd43b', 6: '#69db7c', 8: '#4dabf7', 12: '#b197fc' };

/**
 * Generator wrapper: build a uniform tiling as filled-polygon item specs. Each
 * tile becomes one closed, filled `stroke` item (edges drawn as grout). `kind`
 * picks one of the 11 tilings; `size` is world units per unit edge.
 */
export function uniformTiling({ kind = '4.8.8', size = 70, radius = 7, x = 0, y = 0,
                                fills = FILL_BY_N, edge = '#10121a', width = null } = {}) {
  const tiles = uniformTiles(kind, radius);
  const lw = width != null ? width : Math.max(size * 0.018, 0.4);
  const tx = ([px, py]) => ({ x: x + px * size, y: y - py * size });   // +y up → screen down
  return tiles.map(loop => ({
    type: 'stroke',
    points: loop.concat([loop[0]]).map(tx),          // closed → every edge stroked
    color: edge,
    fill: fills[loop.length] || '#ced4da',
    width: lw,
  }));
}

export const _internal = { reg, onEdge, centroid, circum, apoth, BUILDERS, H, SILVER, DODEC };
