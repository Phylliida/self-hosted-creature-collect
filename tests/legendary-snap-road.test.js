// Tests the legendary snap geometry in static/index.html (the
// <legendary-snap-geometry> block): a legendary moves to the nearest point
// on any road or walking path — the walk graph's full lines, bends
// included, not just its intersections — or the nearest POI, whichever is
// closer. Runs the real functions (grid lookup included) on hand-built
// walk.bin (v3) graphs with known answers, then (when the downloaded
// Montreal regions are present in regions/) against a brute-force scan of
// every road segment.
//
// Run: node tests/legendary-snap-road.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
const a = src.indexOf('// <legendary-snap-geometry>'), b = src.indexOf('// </legendary-snap-geometry>');
ok(a > 0 && b > a, 'geometry block found in index.html');
const G = new Function(src.slice(a, b)
  + '\nreturn { _legSnapWalkView, _legSnapNearestOnWalk, _legSnapNearestPoi, _legSnapBuildGrid, _legSnapGridBuilder };')();

const M = 111320;
const distM = (lat1, lng1, lat2, lng2) =>
  Math.hypot((lng2 - lng1) * M * Math.cos(lat1 * Math.PI / 180), (lat2 - lat1) * M);

// ── A walk.bin v3 writer (the layout viewWalkRegion / build-walk-graph use) ──
// edges: [{ from, to, len, shape: [[lng, lat], ...] }] — written in the
// u8 / u16 / f32 weight order the format requires.
function zigzag(vals) {
  const out = [];
  for (const v of vals) {
    let z = (v << 1) ^ (v >> 31);
    z >>>= 0;
    while (z >= 0x80) { out.push((z & 0x7F) | 0x80); z >>>= 7; }
    out.push(z);
  }
  return out;
}
function buildWalk(nodes, edges) {
  edges = edges.slice().sort((x, y) => (x.len > 65535 ? 2 : x.len > 255 ? 1 : 0) - (y.len > 65535 ? 2 : y.len > 255 ? 1 : 0));
  const N = nodes.length, E = edges.length;
  const u8End = edges.filter((e) => e.len <= 255).length;
  const u16End = u8End + edges.filter((e) => e.len > 255 && e.len <= 65535).length;
  const al = (x) => (x + 3) & ~3;
  const blobs = edges.map((e) => {
    if (!e.shape || !e.shape.length) return null;
    // Deltas start from the stored (float32) node, as readers decode them.
    const d = [];
    let x = Math.round(Math.fround(nodes[e.from][0]) * 1e6), y = Math.round(Math.fround(nodes[e.from][1]) * 1e6);
    for (const [lng, lat] of e.shape) {
      const nx = Math.round(lng * 1e6), ny = Math.round(lat * 1e6);
      d.push(nx - x, ny - y); x = nx; y = ny;
    }
    return Uint8Array.from(zigzag(d));
  });
  const shaped = blobs.filter(Boolean);
  const shapesLen = shaped.reduce((n, s) => n + s.length, 0);
  const SE = shaped.length;
  const size = 48 + 16 * N + 8 * E + al(u8End) + al(2 * (u16End - u8End)) + 4 * (E - u16End)
    + al(1 * E) + al((E + 7) >> 3) + 4 * SE + al(2 * SE) + 0 + shapesLen;
  const buf = new ArrayBuffer(size), dv = new DataView(buf);
  'WALK'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  const hdr = [3, N, E, 0, 0, shapesLen, u8End, u16End, 1, SE];
  hdr.forEach((v, i) => dv.setUint32(4 + 4 * i, v, true));
  let off = 48;
  off += 8 * N;   // node ids (unused)
  nodes.forEach(([lng], i) => dv.setFloat32(off + 4 * i, lng, true)); off += 4 * N;
  nodes.forEach(([, lat], i) => dv.setFloat32(off + 4 * i, lat, true)); off += 4 * N;
  edges.forEach((e, i) => dv.setUint32(off + 4 * i, e.from, true)); off += 4 * E;
  edges.forEach((e, i) => dv.setUint32(off + 4 * i, e.to, true)); off += 4 * E;
  for (let i = 0; i < u8End; i++) dv.setUint8(off + i, Math.round(edges[i].len)); off += al(u8End);
  for (let i = u8End; i < u16End; i++) dv.setUint16(off + 2 * (i - u8End), Math.round(edges[i].len), true); off += al(2 * (u16End - u8End));
  for (let i = u16End; i < E; i++) dv.setFloat32(off + 4 * (i - u16End), edges[i].len, true); off += 4 * (E - u16End);
  for (let i = 0; i < E; i++) dv.setUint8(off + i, 0xFF); off += al(E);   // no names
  blobs.forEach((s, i) => { if (s) dv.setUint8(off + (i >> 3), dv.getUint8(off + (i >> 3)) | (1 << (i & 7))); });
  off += al((E + 7) >> 3);
  let so = 0, k = 0;
  const offs = off, lens = off + 4 * SE;
  blobs.forEach((s) => { if (!s) return; dv.setUint32(offs + 4 * k, so, true); dv.setUint16(lens + 2 * k, s.length, true); so += s.length; k++; });
  off = lens + al(2 * SE);
  for (const s of shaped) { new Uint8Array(buf, off, s.length).set(s); off += s.length; }
  return buf;
}
const lineLen = (pts) => { let L = 0; for (let i = 1; i < pts.length; i++) L += distM(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]); return L; };

// ── 1. A long straight road: snap straight across, not to a corner ────
const LAT = 45.5, LNG = -73.6;
const east = (m) => LNG + m / (M * Math.cos(LAT * Math.PI / 180));
const north = (m) => LAT + m / M;
{
  const nodes = [[LNG, LAT], [east(600), LAT]];
  const v = G._legSnapWalkView(buildWalk(nodes, [{ from: 0, to: 1, len: 600 }]));
  const hit = G._legSnapNearestOnWalk(v, north(30), east(300), 2000);
  ok(hit && Math.abs(hit.m - 30) < 0.5, `1: 30 m north of the middle of a 600 m road → moved 30 m (${hit && hit.m.toFixed(1)})`);
  ok(hit && Math.abs(distM(LAT, east(300), hit.lat, hit.lng)) < 0.5, '1: lands on the road right below, not at an intersection 300 m away');
  ok(G._legSnapNearestOnWalk(v, north(2500), east(300), 2000) === null, '1: nothing within 2 km → null');
}

// ── 2. A curved road: the bends count ─────────────────────────────────
{
  // A→B is 400 m east, but the road bulges 150 m north through two bends.
  const shape = [[east(100), north(150)], [east(300), north(150)]];
  const nodes = [[LNG, LAT], [east(400), LAT]];
  const pts = [nodes[0], ...shape, nodes[1]];
  const v = G._legSnapWalkView(buildWalk(nodes, [{ from: 0, to: 1, len: lineLen(pts), shape }]));
  const hit = G._legSnapNearestOnWalk(v, north(170), east(200), 2000);
  ok(hit && Math.abs(hit.m - 20) < 0.6, `2: 20 m from the bulge (bend points), not 170 m from the chord (${hit && hit.m.toFixed(1)})`);
}

// ── 3. Mixed graph: brute force agrees with the pruned scan ───────────
let seed = 9;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function brute(nodes, edges, lat, lng) {
  const kx = M * Math.cos(lat * Math.PI / 180);
  let best = Infinity;
  for (const e of edges) {
    const f32 = ([x, y]) => [Math.fround(x), Math.fround(y)];
    const micro = ([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6];
    const pts = [f32(nodes[e.from]), ...(e.shape || []).map(micro), f32(nodes[e.to])]
      .map(([x, y]) => [(x - lng) * kx, (y - lat) * M]);
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
      let t = L2 ? -(ax * vx + ay * vy) / L2 : 0; t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(ax + t * vx, ay + t * vy));
    }
  }
  return best;
}
{
  const nodes = [], edges = [];
  for (let i = 0; i < 300; i++) nodes.push([east(rnd() * 3000), north(rnd() * 3000)]);
  for (let i = 0; i < 500; i++) {
    const from = Math.floor(rnd() * 300), to = Math.floor(rnd() * 300);
    const shape = [];
    const nb = Math.floor(rnd() * 4);
    for (let k = 0; k < nb; k++) shape.push([east(rnd() * 3000), north(rnd() * 3000)]);
    const len = lineLen([nodes[from], ...shape, nodes[to]]);
    edges.push({ from, to, len: len > 255 ? len : Math.max(1, len), shape });
  }
  const v = G._legSnapWalkView(buildWalk(nodes, edges));
  let agree = 0;
  for (let k = 0; k < 200; k++) {
    const lat = north(rnd() * 3000), lng = east(rnd() * 3000);
    const hit = G._legSnapNearestOnWalk(v, lat, lng, 2000);
    if (hit && Math.abs(hit.m - brute(nodes, edges, lat, lng)) < 0.05) agree++;
  }
  ok(agree === 200, `3: grid lookup matches brute force on a random 500-edge graph with bends (${agree}/200)`);
  // Outside the graph's extent (up to ~1.8 km beyond it): still exact.
  let outside = 0, outsideAgree = 0;
  for (let k = 0; k < 100; k++) {
    const side = Math.floor(rnd() * 4), t = rnd() * 3000, d = 3000 + 200 + rnd() * 1600;
    const [x, y] = side === 0 ? [t, d] : side === 1 ? [t, -d + 3000] : side === 2 ? [d, t] : [-d + 3000, t];
    const lat = north(y), lng = east(x);
    const want = brute(nodes, edges, lat, lng);
    const hit = G._legSnapNearestOnWalk(v, lat, lng, 2000);
    if (want >= 2000) { if (!hit) outsideAgree++; continue; }
    outside++;
    if (hit && Math.abs(hit.m - want) < 0.05) outsideAgree++;
  }
  ok(outside > 20 && outsideAgree === 100, `3: and for spots outside the graph's extent (${outsideAgree}/100)`);
}

// ── 3b. Very long roads ───────────────────────────────────────────────
{
  // A straight 40 km road, and a 70 km winding one whose ends are only
  // 10 km apart (its bends swing 30 km north): too wide for the grid, so
  // it goes in the long-road list.
  const wind = [[east(30000), north(30000)], [east(40000), north(30000)]];
  const nodes = [[east(-20000), LAT], [east(20000), LAT], [east(30000), north(-100)], [east(40000), north(-100)]];
  const edges = [{ from: 0, to: 1, len: 40000 },
    { from: 2, to: 3, len: lineLen([nodes[2], ...wind, nodes[3]]), shape: wind }];
  const v = G._legSnapWalkView(buildWalk(nodes, edges));
  const hit = G._legSnapNearestOnWalk(v, north(40), east(300), 2000);
  ok(hit && Math.abs(hit.m - 40) < 0.5, `3b: 40 m from a 40 km road, 20 km from its ends → found (${hit && hit.m.toFixed(1)})`);
  const top = G._legSnapNearestOnWalk(v, north(30050), east(35000), 2000);
  ok(top && Math.abs(top.m - 50) < 0.5, `3b: 50 m from the far bend of a winding road → found (${top && top.m.toFixed(1)})`);
  ok(v.grid && v.grid.big.length === 1, '3b: the winding road is in the long-road list, not spread over the grid');
}

// ── 3c. The app's stepped (background) build = the one-shot build ──────
{
  const nodes = [], edges = [];
  for (let i = 0; i < 2000; i++) nodes.push([east(rnd() * 20000), north(rnd() * 20000)]);
  for (let i = 0; i < 70000; i++) {
    const from = Math.floor(rnd() * 2000), to = Math.floor(rnd() * 2000);
    edges.push({ from, to, len: Math.max(1, lineLen([nodes[from], nodes[to]])) });
  }
  const buf = buildWalk(nodes, edges);
  const v1 = G._legSnapWalkView(buf), v2 = G._legSnapWalkView(buf);
  const g1 = G._legSnapBuildGrid(v1);
  const it = G._legSnapGridBuilder(v2);
  let steps = 0, step;
  while (!(step = it.next()).done) steps++;
  const g2 = step.value;
  ok(steps >= 4 && Buffer.compare(Buffer.from(g1.items.buffer), Buffer.from(g2.items.buffer)) === 0
    && Buffer.compare(Buffer.from(g1.start.buffer), Buffer.from(g2.start.buffer)) === 0,
    `3c: the stepped build (${steps} steps) makes the same grid`);
}

// ── 4. POIs: nearest, and only when nearer than the road ───────────────
{
  const pois = [{ lat: north(50), lng: east(0) }, { lat: north(400), lng: east(0) }, null];
  const hit = G._legSnapNearestPoi(pois, LAT, LNG, 2000);
  ok(hit && Math.abs(hit.m - 50) < 0.1 && hit.lat === pois[0].lat, '4: nearest POI');
  ok(G._legSnapNearestPoi(pois, LAT, LNG, 40) === null, '4: none closer than the bound (e.g. a nearer road) → null');
}

// ── 5. Real Montreal map data (when downloaded into regions/) ──────────
const regionDirs = ['region-0361', 'region-0530'].map((id) => path.join(root, 'regions', id));
if (regionDirs.every((d) => fs.existsSync(path.join(d, 'walk.bin')))) {
  const read = (p) => { let x = fs.readFileSync(p); if (x[0] === 0x1f && x[1] === 0x8b) x = zlib.gunzipSync(x); return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength); };
  const views = regionDirs.map((d) => G._legSnapWalkView(read(path.join(d, 'walk.bin'))));
  ok(views.every(Boolean), '5: real walk.bin files parse');
  // The lookup's length bound: no drawn line is longer than 1.05 × its
  // stored length + 10 m (bends are simplified and quantized).
  // Every segment as flat local data for a brute-force check.
  const segs = [];
  let overLong = 0, edgesChecked = 0;
  for (const v of views) {
    for (let e = 0; e < v.E; e++) {
      const fa = v.edgeFrom[e], tb = v.edgeTo[e];
      const pts = [[v.nodeLng[fa], v.nodeLat[fa]]];
      if (v.bits[e >>> 5] & (1 << (e & 31))) {
        let si = v.rank[e >>> 5];
        for (let k = 0; k < (e & 31); k++) if (v.bits[e >>> 5] & (1 << k)) si++;
        const bytes = v.shapes.subarray(v.sparseOff[si], v.sparseOff[si] + v.sparseLen[si]);
        const d = [];
        for (let i = 0; i < bytes.length;) { let val = 0, sh = 0, by; do { by = bytes[i++]; val |= (by & 0x7F) << sh; sh += 7; } while (by & 0x80); d.push((val >>> 1) ^ -(val & 1)); }
        let x = Math.round(v.nodeLng[fa] * 1e6), y = Math.round(v.nodeLat[fa] * 1e6);
        for (let k = 0; k + 1 < d.length; k += 2) { x += d[k]; y += d[k + 1]; pts.push([x / 1e6, y / 1e6]); }
      }
      pts.push([v.nodeLng[tb], v.nodeLat[tb]]);
      for (let k = 1; k < pts.length; k++) segs.push(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]);
      const stored = e < v.u8End ? v.w8[e] : e < v.u16End ? v.w16[e - v.u8End] : v.w32[e - v.u16End];
      const drawn = lineLen(pts);
      if (drawn > 1.05 * stored + 10) overLong++;
      edgesChecked++;
    }
  }
  ok(edgesChecked > 1e6 && overLong === 0, `5: every edge's line fits the length bound (${overLong} of ${edgesChecked} over)`);
  const S = Float64Array.from(segs);
  const bruteReal = (lat, lng) => {
    const kx = M * Math.cos(lat * Math.PI / 180);
    let best = Infinity;
    for (let k = 0; k < S.length; k += 4) {
      const ax = (S[k] - lng) * kx, ay = (S[k + 1] - lat) * M, vx = (S[k + 2] - lng) * kx - ax, vy = (S[k + 3] - lat) * M - ay;
      const L2 = vx * vx + vy * vy;
      let t = L2 ? -(ax * vx + ay * vy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(ax + t * vx, ay + t * vy);
      if (d < best) best = d;
    }
    return best;
  };
  let agree = 0, n = 0, worst = 0;
  const moved = [];
  // Grids are built on first use; time that separately from lookups.
  const b0 = process.hrtime.bigint();
  for (const v of views) G._legSnapNearestOnWalk(v, 45.5, -73.6, 2000);
  const buildMs = Number(process.hrtime.bigint() - b0) / 1e6;
  let scanMs = 0;
  for (let k = 0; k < 120; k++) {
    const lat = 45.44 + rnd() * 0.16, lng = -73.70 + rnd() * 0.17;
    const s0 = process.hrtime.bigint();
    let best = null;
    for (const v of views) { const h = G._legSnapNearestOnWalk(v, lat, lng, best ? best.m : 2000); if (h) best = h; }
    scanMs += Number(process.hrtime.bigint() - s0) / 1e6;
    const want = bruteReal(lat, lng);
    n++;
    if (best && Math.abs(best.m - want) < 0.05) agree++;
    worst = Math.max(worst, best ? Math.abs(best.m - want) : Infinity);
    if (best) moved.push(best.m);
  }
  moved.sort((x, y) => x - y);
  console.log(`montreal: ${segs.length / 4} road segments; moved median ${moved[moved.length >> 1].toFixed(0)} m,`
    + ` max ${moved[moved.length - 1].toFixed(0)} m; grids built in ${buildMs.toFixed(0)} ms,`
    + ` (${(views.reduce((t, v) => t + v.grid.items.byteLength + v.grid.start.byteLength, 0) / 1048576).toFixed(1)} MB),`
    + ` then ${(scanMs / n).toFixed(2)} ms per lookup (both regions)`);
  ok(scanMs / n < 5, '5: a lookup reads only the roads around it (a few ms at most)');
  ok(agree === n, `5: matches the exact nearest road point everywhere (${agree}/${n}, worst off by ${worst.toFixed(3)} m)`);
  ok(moved[moved.length >> 1] < 25, '5: in the city a legendary moves only metres onto the nearest road or path');
} else {
  console.log('5: skipped (regions/region-0361 and region-0530 not downloaded here)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
