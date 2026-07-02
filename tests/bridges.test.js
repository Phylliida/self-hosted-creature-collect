// Equivalence + yield-behavior tests for the multimodal bridge builders
// (buildMultimodalBridges / buildMultimodalBridgesMulti in index.html).
// Run: node tests/bridges.test.js
//
// The two functions were switched from string grid keys + fixed-count
// yields to packed-integer keys + elapsed-time yields (stall-dump
// conviction, 2026-07-02: ~810ms unyielding grid build over 937k nodes).
// This test extracts the REAL functions out of index.html, runs them in
// Node against verbatim copies of the ORIGINAL algorithm on a full-scale
// synthetic dataset, and asserts byte-identical linking results.

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL: ' + msg); }
}

// ── extract the live code from index.html ──
const html = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf8');
function extract(marker) {
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) {
    const c = html[i];
    if (c === '/' && html[i + 1] === '/') {   // line comment (may contain quotes)
      while (i < html.length && html[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && html[i + 1] === '*') {   // block comment
      i = html.indexOf('*/', i + 2) + 1;
      continue;
    }
    if (c === "'" || c === '"') {             // string literal
      const q = c;
      for (i++; i < html.length && html[i] !== q; i++) { if (html[i] === '\\') i++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
}
const liveCode = [
  html.match(/const bridgeGridKey = [^\n]+/)[0],
  html.match(/let _bridgeCacheMulti = null;[^\n]*/)[0],
  extract('function bridgeYielder()'),
  extract('async function buildMultimodalBridges()'),
  extract('async function buildMultimodalBridgesMulti(multi)'),
].join('\n');

// ── shared stubs + synthetic world ──
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const haversineM = (lng1, lat1, lng2, lat2) => {
  const R = 6371000, d2r = Math.PI / 180;
  const dLat = (lat2 - lat1) * d2r, dLng = (lng2 - lng1) * d2r;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};
const packGlobalId = (r, i) => (((r & 0xFF) << 24) | (i & 0xFFFFFF)) >>> 0;

const rng = mulberry32(20260702);
const NODES_PER_REGION = 468579;              // ×2 ≈ the convicted 937k
const N_STOPS = 25595;
function makeRegion(regionIdx, regionId, lng0, lat0) {
  const nodeLng = new Float64Array(NODES_PER_REGION);
  const nodeLat = new Float64Array(NODES_PER_REGION);
  for (let i = 0; i < NODES_PER_REGION; i++) {
    nodeLng[i] = lng0 + (rng() - 0.5) * 0.6;
    nodeLat[i] = lat0 + (rng() - 0.5) * 0.4;
  }
  return { regionIdx, regionId, routingView: { nodeLng, nodeLat, N: NODES_PER_REGION } };
}
const regions = [makeRegion(0, 'region-A', -73.75, 45.5), makeRegion(1, 'region-B', -73.35, 45.55)];
const multi = {
  regions,
  lng: (gid) => regions[(gid >>> 24) & 0xFF].routingView.nodeLng[gid & 0xFFFFFF],
  lat: (gid) => regions[(gid >>> 24) & 0xFF].routingView.nodeLat[gid & 0xFFFFFF],
};
const stops = new Map();
for (let s = 0; s < N_STOPS; s++) {
  if (s % 20 === 19) {                        // 5% far away → unlinkable
    stops.set('stop' + s, { lng: -70 + rng(), lat: 40 + rng() });
  } else {                                     // near a random node
    const r = regions[s % 2], i = Math.floor(rng() * NODES_PER_REGION);
    stops.set('stop' + s, {
      lng: r.routingView.nodeLng[i] + (rng() - 0.5) * 0.004,
      lat: r.routingView.nodeLat[i] + (rng() - 0.5) * 0.004,
    });
  }
}
// legacy walkGraph view over region 0 only (merged-graph shape)
const walkGraph = {
  nodeCount: NODES_PER_REGION,
  _nodeLng: regions[0].routingView.nodeLng,
  _nodeLat: regions[0].routingView.nodeLat,
};

// ── reference: the ORIGINAL algorithms, verbatim (string keys) ──
function refBridgesMulti() {
  const GRID = 1000, MAX_LINK_M = 500, WALK_SPEED_MPS = 1.38;
  const out = { stopToWalkNode: new Map(), walkNodeToStops: new Map() };
  const cellCounts = new Map();
  for (const r of regions) {
    const lngs = r.routingView.nodeLng, lats = r.routingView.nodeLat, N = r.routingView.N;
    for (let i = 0; i < N; i++) {
      const k = Math.round(lngs[i] * GRID) + ',' + Math.round(lats[i] * GRID);
      cellCounts.set(k, (cellCounts.get(k) || 0) + 1);
    }
  }
  const walkGrid = new Map(), cellCursors = new Map();
  for (const k of cellCounts.keys()) { walkGrid.set(k, new Uint32Array(cellCounts.get(k))); cellCursors.set(k, 0); }
  for (const r of regions) {
    const lngs = r.routingView.nodeLng, lats = r.routingView.nodeLat, N = r.routingView.N;
    for (let i = 0; i < N; i++) {
      const k = Math.round(lngs[i] * GRID) + ',' + Math.round(lats[i] * GRID);
      const arr = walkGrid.get(k), pos = cellCursors.get(k);
      arr[pos] = packGlobalId(r.regionIdx, i);
      cellCursors.set(k, pos + 1);
    }
  }
  for (const [stopId, stop] of stops) {
    const cx = Math.round(stop.lng * GRID), cy = Math.round(stop.lat * GRID);
    let best = -1, bestD = Infinity;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      const cell = walkGrid.get((cx + dx) + ',' + (cy + dy));
      if (!cell) continue;
      for (let i = 0; i < cell.length; i++) {
        const gid = cell[i];
        const d = haversineM(multi.lng(gid), multi.lat(gid), stop.lng, stop.lat);
        if (d < bestD) { bestD = d; best = gid; }
      }
    }
    if (best !== -1 && bestD <= MAX_LINK_M) {
      const walkSec = bestD / WALK_SPEED_MPS;
      out.stopToWalkNode.set(stopId, { node: best, walkSec });
      if (!out.walkNodeToStops.has(best)) out.walkNodeToStops.set(best, []);
      out.walkNodeToStops.get(best).push([stopId, walkSec]);
    }
  }
  return out;
}
function refBridgesLegacy() {
  const GRID = 1000, MAX_LINK_M = 500, WALK_SPEED_MPS = 1.38;
  const out = { stopToWalkNode: new Map(), walkNodeToStops: new Map() };
  const wcount = walkGraph.nodeCount, wlngs = walkGraph._nodeLng, wlats = walkGraph._nodeLat;
  const cellCounts = new Map();
  for (let idx = 0; idx < wcount; idx++) {
    const k = Math.round(wlngs[idx] * GRID) + ',' + Math.round(wlats[idx] * GRID);
    cellCounts.set(k, (cellCounts.get(k) || 0) + 1);
  }
  const walkGrid = new Map(), cellCursors = new Map();
  for (const k of cellCounts.keys()) { walkGrid.set(k, new Uint32Array(cellCounts.get(k))); cellCursors.set(k, 0); }
  for (let idx = 0; idx < wcount; idx++) {
    const k = Math.round(wlngs[idx] * GRID) + ',' + Math.round(wlats[idx] * GRID);
    const arr = walkGrid.get(k), pos = cellCursors.get(k);
    arr[pos] = idx;
    cellCursors.set(k, pos + 1);
  }
  for (const [stopId, stop] of stops) {
    const cx = Math.round(stop.lng * GRID), cy = Math.round(stop.lat * GRID);
    let best = -1, bestD = Infinity;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      const cell = walkGrid.get((cx + dx) + ',' + (cy + dy));
      if (!cell) continue;
      for (let i = 0; i < cell.length; i++) {
        const id = cell[i];
        const d = haversineM(wlngs[id], wlats[id], stop.lng, stop.lat);
        if (d < bestD) { bestD = d; best = id; }
      }
    }
    if (best !== -1 && bestD <= MAX_LINK_M) {
      const walkSec = bestD / WALK_SPEED_MPS;
      out.stopToWalkNode.set(stopId, { node: best, walkSec });
      if (!out.walkNodeToStops.has(best)) out.walkNodeToStops.set(best, []);
      out.walkNodeToStops.get(best).push([stopId, walkSec]);
    }
  }
  return out;
}

function mapsEqual(a, b, label) {
  ok(a.size === b.size, label + ': size ' + a.size + ' vs ' + b.size);
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w === undefined) { ok(false, label + ': missing key ' + k); return; }
    if (JSON.stringify(v) !== JSON.stringify(w)) {
      ok(false, label + ': mismatch at ' + k + ': ' + JSON.stringify(v) + ' vs ' + JSON.stringify(w));
      return;
    }
  }
  ok(true, label + ': deep-equal');
}

(async () => {
  // ── run the LIVE extracted code in a sandbox ──
  const marks = [], traces = [];
  let yields = 0, longestStretch = 0, lastYield = null;
  const ctx = {
    performance, console,
    setTimeout: (fn, ms) => {
      const now = performance.now();
      if (lastYield !== null) longestStretch = Math.max(longestStretch, now - lastYield);
      lastYield = now;
      yields++;
      return setTimeout(fn, ms);
    },
    window: { _ccStalls: { mark: (l, ms) => marks.push([l, Math.round(ms)]) } },
    _routeTrace: (name) => { traces.push(name); },
    haversineM, packGlobalId,
    WALK_SPEED_MPS: 1.38,
    walkGraph,
    scheduleIdx: { stops, stopToWalkNode: new Map(), walkNodeToStops: new Map() },
    Uint32Array, Map, Math, Promise, Infinity,
  };
  vm.createContext(ctx);
  vm.runInContext(liveCode, ctx);

  // multi variant
  lastYield = performance.now();
  const t0 = performance.now();
  await vm.runInContext('buildMultimodalBridgesMulti(__multi)',
    Object.assign(ctx, { __multi: multi }));
  const liveMultiMs = performance.now() - t0;
  const liveMulti = { stopToWalkNode: ctx.scheduleIdx.stopToWalkNode, walkNodeToStops: ctx.scheduleIdx.walkNodeToStops };

  const t1 = performance.now();
  const refMulti = refBridgesMulti();
  const refMultiMs = performance.now() - t1;

  mapsEqual(refMulti.stopToWalkNode, liveMulti.stopToWalkNode, 'multi stopToWalkNode');
  mapsEqual(refMulti.walkNodeToStops, liveMulti.walkNodeToStops, 'multi walkNodeToStops');
  ok(liveMulti.stopToWalkNode.size > N_STOPS * 0.9, 'most stops linked (' + liveMulti.stopToWalkNode.size + '/' + N_STOPS + ')');
  ok(marks.some((m) => m[0] === 'bridges-multi ~wall'), 'bridges-multi ~wall mark fired');
  const multiYields = yields, multiStretch = longestStretch;
  ok(multiYields > 5, 'multi build yielded to the event loop ' + multiYields + ' times');
  // threshold is generous: the vm sandbox inflates per-op cost 2-3x and
  // machine load adds noise; the regression this guards (no yields at all)
  // measured 722ms+ here. On-device stretches sit near the 40ms threshold.
  ok(multiStretch < 300, 'longest unyielded stretch ' + Math.round(multiStretch) + 'ms (<300ms; was one ~810ms block)');

  // ── cache behavior: same regions + same stops ⇒ instant restore ──
  ctx.scheduleIdx.stopToWalkNode = new Map();   // simulate the unload wipe
  ctx.scheduleIdx.walkNodeToStops = new Map();
  const tC = performance.now();
  await vm.runInContext('buildMultimodalBridgesMulti(__multi)', ctx);
  const cachedMs = performance.now() - tC;
  ok(traces.includes('bridgesMulti:cached'), 'second build hits the cache');
  ok(cachedMs < 100, 'cache hit is fast (' + Math.round(cachedMs) + 'ms)');
  mapsEqual(refMulti.stopToWalkNode, ctx.scheduleIdx.stopToWalkNode, 'cached stopToWalkNode');
  mapsEqual(refMulti.walkNodeToStops, ctx.scheduleIdx.walkNodeToStops, 'cached walkNodeToStops');

  // changed stops identity (schedule rebuild) ⇒ full rebuild
  traces.length = 0;
  ctx.scheduleIdx.stops = new Map(stops);
  await vm.runInContext('buildMultimodalBridgesMulti(__multi)', ctx);
  ok(traces.includes('bridgesMulti:start') && !traces.includes('bridgesMulti:cached'),
    'new stops map forces a rebuild');
  mapsEqual(refMulti.stopToWalkNode, ctx.scheduleIdx.stopToWalkNode, 'rebuilt stopToWalkNode');

  // changed region list ⇒ key mismatch ⇒ rebuild
  traces.length = 0;
  const multiRenamed = { ...multi, regions: [Object.assign({}, regions[0], { regionId: 'region-A2' }), regions[1]] };
  await vm.runInContext('buildMultimodalBridgesMulti(__multi2)', Object.assign(ctx, { __multi2: multiRenamed }));
  ok(traces.includes('bridgesMulti:start') && !traces.includes('bridgesMulti:cached'),
    'different region list forces a rebuild');
  ctx.scheduleIdx.stops = stops;  // restore for the legacy tests

  // legacy variant
  yields = 0; longestStretch = 0;
  ctx.scheduleIdx.stopToWalkNode = new Map();
  ctx.scheduleIdx.walkNodeToStops = new Map();
  lastYield = performance.now();
  const t2 = performance.now();
  await vm.runInContext('buildMultimodalBridges()', ctx);
  const liveLegacyMs = performance.now() - t2;
  const liveLegacy = { stopToWalkNode: ctx.scheduleIdx.stopToWalkNode, walkNodeToStops: ctx.scheduleIdx.walkNodeToStops };
  const refLegacy = refBridgesLegacy();
  mapsEqual(refLegacy.stopToWalkNode, liveLegacy.stopToWalkNode, 'legacy stopToWalkNode');
  mapsEqual(refLegacy.walkNodeToStops, liveLegacy.walkNodeToStops, 'legacy walkNodeToStops');
  ok(marks.some((m) => m[0] === 'bridges ~wall'), 'bridges ~wall mark fired');
  ok(longestStretch < 300, 'legacy longest unyielded stretch ' + Math.round(longestStretch) + 'ms (<300ms)');

  console.log('timing: live multi=' + Math.round(liveMultiMs) + 'ms (' + multiYields + ' yields, longest stretch '
    + Math.round(multiStretch) + 'ms) vs reference(single-block)=' + Math.round(refMultiMs) + 'ms; legacy live=' + Math.round(liveLegacyMs) + 'ms');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
