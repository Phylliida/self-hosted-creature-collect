// Tests the spawn bubbles ("nests") in static/spawns.js: ~1.7 km squares
// with one 500 m bubble each per UTC day; inside, the normal stream's density
// ramps from 1× (edge) to 2× (centre) and the species pick within each type
// leans on per-bubble Gaussian-softmax weights; the centre holds a radar spawn
// ('E:B:' id) for the whole day. Incense spawns inside use the weights for
// both halves but keep their density and type rule. Pack mode gets the same
// bubbles (so its spawns co-locate with fusion mode's) but no centre.
//
// Runs the real spawns.js against the bundled species data (same setup as
// legendary-rate / spawn-memo) and measures the stream directly, comparing
// against the plain stream via the _bubbleTest.setEnabled hook.
//
// Run: node tests/spawn-bubbles.test.js
'use strict';
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
require(path.join(root, 'static', 'types.js'));
const namesArr = require(path.join(root, 'data', 'BundledData', 'species-names.json'));
const typesMap = require(path.join(root, 'data', 'BundledData', 'species-types.json'));
const evosMap = require(path.join(root, 'data', 'BundledData', 'species-evolutions.json'));
global.Species = {
  typesFor(idx) { const t = typesMap[String(idx)]; return t ? t.filter(Boolean) : []; },
  evolutionsFor(idx) {
    const raw = evosMap[String(idx)];
    if (!Array.isArray(raw)) return [];
    return raw.map((e) => ({ target: e[0], method: e[1], param: e[2] }));
  },
  allSpecies() {
    const out = [];
    for (let i = 0; i < namesArr.length; i++) if (namesArr[i]) out.push({ id: i + 1, name: namesArr[i] });
    return out;
  },
};
require(path.join(root, 'static', 'spawns.js'));
const S = global.Spawns;
const T = S._bubbleTest;

const SCALE = 10000;
const DAY_MS = 86400000;
const NOW = Date.UTC(2026, 9, 13, 15, 0, 0);          // a fixed afternoon (UTC)
// The normal stream's weather sampler and nearestRadar read the real clock;
// pin it so the weather matches NOW's day whenever this runs.
Date.now = () => NOW;
const DAY = Math.floor(NOW / DAY_MS);
const MTL = [45.5017, -73.5673];
const M_PER_DEG = 111320;
const distM = (aLat, aLng, bLat, bLng) => {
  const dx = (aLng - bLng) * M_PER_DEG * Math.cos(bLat * Math.PI / 180);
  const dy = (aLat - bLat) * M_PER_DEG;
  return Math.hypot(dx, dy);
};
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// ── 1. Spacing: one within a 5–10 minute walk, not everywhere ──────────
{
  const near = [];
  let inside = 0, overlap = 0;
  const N = 3000;
  for (let k = 0; k < N; k++) {
    const lat = MTL[0] + (rnd() - 0.5) * 0.4, lng = MTL[1] + (rnd() - 0.5) * 0.6;
    const day = DAY + Math.floor(rnd() * 5);
    const list = S.bubblesNear(lat, lng, 4000, day * DAY_MS + 3600000);
    near.push(list.length ? list[0].distM : Infinity);
    const around = T.around(lat, lng, day * DAY_MS + 3600000);
    if (around.length) inside++;
    if (around.length > 1) overlap++;
  }
  near.sort((a, b) => a - b);
  const median = near[Math.floor(N / 2)];
  const within800 = near.filter((d) => d <= 800).length / N;
  console.log(`spacing: nearest centre median ${median.toFixed(0)} m, centre within 800 m ${(within800 * 100).toFixed(0)}%,`
    + ` inside a bubble ${(inside / N * 100).toFixed(0)}%, overlap ${(overlap / N * 100).toFixed(1)}%`);
  ok(median > 600 && median < 850, '1: nearest bubble centre ~720 m away on median (a 5–10 min walk)');
  ok(within800 > 0.5 && within800 < 0.7, '1: centre within 800 m for ~60% of spots');
  ok(inside / N > 0.2 && inside / N < 0.32, '1: about a quarter of the ground is inside a bubble');
  ok(overlap / N < 0.04, '1: overlaps are rare');
}

// ── 2. Deterministic, shared, and rotating daily ───────────────────────
const today = S.bubblesNear(MTL[0], MTL[1], 3000, NOW);
{
  ok(today.length >= 2, '2: a few bubbles within 3 km (' + today.length + ')');
  ok(JSON.stringify(S.bubblesNear(MTL[0], MTL[1], 3000, NOW + 3600000)) === JSON.stringify(today),
    '2: same bubbles all day');
  const tomorrow = S.bubblesNear(MTL[0], MTL[1], 3000, NOW + DAY_MS);
  ok(JSON.stringify(tomorrow.map((b) => [b.lat, b.lng])) !== JSON.stringify(today.map((b) => [b.lat, b.lng])),
    '2: new bubbles the next UTC day');
  ok(today.every((b) => b.radiusM === 500 && b.distM <= 3000), '2: 500 m radius, within the asked radius');
  ok(today.every((b, k) => k === 0 || today[k - 1].distM <= b.distM), '2: nearest first');
}

// The bubble used for the stream measurements: today's nearest to Montreal.
const B = today[0];
const cosB = Math.cos(B.lat * Math.PI / 180);

// Every 3rd cell of the box around B (cells are ~11 m; a sparse sample keeps
// this fast while still covering every ring), over most of the day's ticks.
const tick0 = DAY * 1440;
const TICKS = 1300;
function scan(fn) {
  const latPad = 700 / M_PER_DEG, lngPad = 700 / (M_PER_DEG * cosB);
  const cx0 = Math.floor((B.lat - latPad + 90) * SCALE), cx1 = Math.ceil((B.lat + latPad + 90) * SCALE);
  const cy0 = Math.floor((B.lng - lngPad + 180) * SCALE), cy1 = Math.ceil((B.lng + lngPad + 180) * SCALE);
  for (let cx = cx0; cx <= cx1; cx += 3) {
    for (let cy = cy0; cy <= cy1; cy += 3) {
      const cLat = (cx + 0.5) / SCALE - 90, cLng = (cy + 0.5) / SCALE - 180;
      const r = distM(cLat, cLng, B.lat, B.lng) / 500;
      for (let t = tick0; t < tick0 + TICKS; t += 1) fn(cx, cy, t, r);
    }
  }
}
// Plain stream vs bubble stream over the same cell-ticks.
const RINGS = [[0, 0.5], [0.5, 1], [1.05, 1.4]];
const plain = RINGS.map(() => 0), bub = RINGS.map(() => 0);
const plainById = new Map();
const bubSpawns = [];
let plainSpawnsInside = 0;
const t0 = performance.now();
T.setEnabled(false);
scan((cx, cy, t, r) => {
  const p = S.generateCellAtTick(cx, cy, t, NOW);
  if (!p) return;
  const k = RINGS.findIndex(([a, b]) => r >= a && r < b);
  if (k >= 0) plain[k]++;
  plainById.set(p.id, Object.assign({ r }, p));
});
T.setEnabled(true);
scan((cx, cy, t, r) => {
  const p = S.generateCellAtTick(cx, cy, t, NOW);
  if (!p) return;
  const k = RINGS.findIndex(([a, b]) => r >= a && r < b);
  if (k >= 0) bub[k]++;
  if (r < 1) bubSpawns.push(p);
});
console.log(`stream scan: ${(performance.now() - t0).toFixed(0)} ms`);

// ── 3. Outside: untouched. Inside: every plain spawn kept, plus extras ──
{
  let outsideSame = 0, outsideTotal = 0, keptInside = 0, insideTotal = 0;
  const bubById = new Map(bubSpawns.map((p) => [p.id, p]));
  const strip = (p) => { const o = Object.assign({}, p); delete o.r; return JSON.stringify(o); };
  T.setEnabled(true);
  for (const [id, p] of plainById) {
    if (T.around(p.lat, p.lng, NOW).length === 0 && p.r >= 1.05) {
      outsideTotal++;
      const [cx, cy, t] = id.split(':').map(Number);
      const q = S.generateCellAtTick(cx, cy, t, NOW);
      if (q && JSON.stringify(q) === strip(p)) outsideSame++;
    } else if (p.r < 0.95) {
      insideTotal++;
      const q = bubById.get(id);
      if (q && q.lat === p.lat && q.lng === p.lng && q.level === p.level && q.sizeM === p.sizeM
          && q.startMs === p.startMs && q.variantSeed === p.variantSeed) keptInside++;
    }
  }
  ok(outsideTotal > 100 && outsideSame === outsideTotal,
    `3: outside every bubble, spawns are identical to the plain stream (${outsideSame}/${outsideTotal})`);
  ok(insideTotal > 100 && keptInside === insideTotal,
    `3: inside, every plain spawn still exists in place with the same level/size/birth (${keptInside}/${insideTotal})`);
}

// ── 4. Density ramps from 1× at the edge to 2× at the centre ──────────
{
  // Expected multiplier over each ring (area-weighted mean of 1 + (1 − r)).
  const expect = RINGS.map(([a, b]) => (b <= 1 ? 2 - (2 / 3) * (b ** 3 - a ** 3) / (b ** 2 - a ** 2) : 1));
  const got = RINGS.map((_, k) => bub[k] / plain[k]);
  console.log('density ×: ' + RINGS.map(([a, b], k) => `${a}–${b}R ${got[k].toFixed(2)} (want ${expect[k].toFixed(2)}, n=${bub[k]})`).join(', '));
  for (let k = 0; k < RINGS.length; k++) {
    ok(Math.abs(got[k] - expect[k]) < 0.15, `4: ring ${RINGS[k][0]}–${RINGS[k][1]}R density ×${got[k].toFixed(2)} ≈ ${expect[k].toFixed(2)}`);
  }
}

// ── 5. Species bias: one or two species dominate each type ─────────────
{
  const shares = T.shares(B.id);
  const ranked = Array.from(shares.entries()).sort((a, b) => b[1] - a[1]);
  const [top, topShare] = ranked[0];
  const counts = new Map();
  let halves = 0;
  for (const p of bubSpawns) {
    for (const sp of [p.speciesA, p.speciesB]) { counts.set(sp, (counts.get(sp) || 0) + 1); halves++; }
  }
  const observed = (counts.get(top) || 0) / halves;
  const plainCounts = new Map();
  let plainHalves = 0;
  for (const p of plainById.values()) {
    if (p.r >= 1) continue;
    for (const sp of [p.speciesA, p.speciesB]) { plainCounts.set(sp, (plainCounts.get(sp) || 0) + 1); plainHalves++; }
  }
  const plainTop = (plainCounts.get(top) || 0) / plainHalves;
  console.log(`bias: top species #${top} predicted ${(topShare / 2 * 100).toFixed(1)}% of halves, observed ${(observed * 100).toFixed(1)}%,`
    + ` plain stream ${(plainTop * 100).toFixed(1)}%`);
  ok(Math.abs(observed - topShare / 2) < 0.03, '5: the most common species turns up as often as the weights predict');
  ok(observed > 1.5 * plainTop, '5: and more often than in the plain stream');
  // Within one type (the bias picks species inside a type): among heads of
  // the daily type, the top two species carry most picks.
  const daily = S.currentWeather(NOW).daily;
  const top2 = (list) => {
    const m = new Map();
    for (const sp of list) m.set(sp, (m.get(sp) || 0) + 1);
    const v = Array.from(m.values()).sort((x, y) => y - x);
    return { share: ((v[0] || 0) + (v[1] || 0)) / list.length, n: list.length, kinds: m.size };
  };
  const isDaily = (sp) => (global.Species.typesFor(sp)[0] === daily);
  const bTop = top2(bubSpawns.map((p) => p.speciesB).filter(isDaily));
  const pTop = top2(Array.from(plainById.values()).filter((p) => p.r < 1).map((p) => p.speciesB).filter(isDaily));
  console.log(`bias: ${daily} heads — top two species ${(bTop.share * 100).toFixed(0)}% in the bubble (n=${bTop.n}),`
    + ` ${(pTop.share * 100).toFixed(0)}% plain (n=${pTop.n}, ${pTop.kinds} species)`);
  ok(bTop.share > 0.45 && bTop.share > 1.8 * pTop.share, '5: within a type, one or two species carry most picks');
  let sum = 0;
  for (const v of shares.values()) sum += v;
  ok(Math.abs(sum - 2) < 1e-9, '5: species shares sum to 2 (two halves per spawn)');
  // The weights are exp(2.5 z), z ~ N(0, 1): log-weights / 2.5 look standard normal.
  const z = Array.from(T.weights(B.id).values()).map((w) => Math.log(w) / 2.5);
  const mean = z.reduce((a, c) => a + c, 0) / z.length;
  const sd = Math.sqrt(z.reduce((a, c) => a + (c - mean) ** 2, 0) / z.length);
  ok(Math.abs(mean) < 0.3 && Math.abs(sd - 1) < 0.25, `5: weights are Gaussian-softmax (z mean ${mean.toFixed(2)}, sd ${sd.toFixed(2)})`);
  // Same species, other bubble: the weights differ.
  const other = today[1];
  ok(Math.abs(T.weights(B.id).get(top) - T.weights(other.id).get(top)) > 1e-6, '5: each bubble has its own weights');
}

// ── 6. Overlaps blend; density takes the closest centre ────────────────
{
  let found = null;
  for (let k = 0; k < 20000 && !found; k++) {
    const lat = MTL[0] + (rnd() - 0.5) * 0.6, lng = MTL[1] + (rnd() - 0.5) * 0.8;
    const a = T.around(lat, lng, NOW);
    if (a.length === 2) found = a;
  }
  ok(!!found, '6: overlapping bubbles exist somewhere nearby');
  if (found) ok(found.every((e) => e.f > 0 && e.f <= 1) && found[0].id !== found[1].id, '6: each overlap entry has its own closeness');
}

// ── 7. The centre: a radar spawn that lasts the bubble's day ───────────
{
  const box = [B.lng - 0.001, B.lat - 0.001, B.lng + 0.001, B.lat + 0.001];
  const centres = S.bubbleCentersInBbox(box, NOW);
  ok(centres.length === 1, '7: one centre spawn at the bubble centre');
  const c = centres[0];
  if (c) {
    ok(c.id === 'E:B:' + B.id, '7: id is E:B:<day:band:square> (a radar catch to creatures.js)');
    ok(c.lat === B.lat && c.lng === B.lng, '7: stands exactly at the centre');
    ok(c.startMs === DAY * DAY_MS && c.expireMs === (DAY + 1) * DAY_MS, '7: alive for the whole UTC day');
    ok(c.evolved === true && c.bubble === true, '7: flagged evolved (radar) + bubble');
    const shares = T.shares(B.id);
    const top = Array.from(shares.entries()).sort((a, b) => b[1] - a[1])[0][0];
    const topForms = new Set(T.forwardForms(top));
    ok(topForms.has(c.speciesA) || topForms.has(c.speciesB),
      '7: one half is the evolved form of the bubble\'s most common species');
    ok(S.spawnsInBbox(box, NOW).some((p) => p.id === c.id), '7: spawnsInBbox includes it (catchable when in range)');
    ok(!S.isSpawnIdStale(c.id, NOW + 3600000), '7: not stale later the same day');
    ok(S.isSpawnIdStale(c.id, NOW + DAY_MS), '7: stale the next day');
    ok(JSON.stringify(S.bubbleCentersInBbox(box, NOW + 7200000)[0]) === JSON.stringify(c), '7: deterministic');
    T.setEnabled(false);
    ok(S.bubbleCentersInBbox(box, NOW).length === 0, '7: no centre when bubbles are off');
    T.setEnabled(true);
  }
  // Across many bubbles: the other half is often the same species' line.
  let same = 0, total = 0, evolvedBoth = 0;
  const wide = S.bubblesNear(MTL[0], MTL[1], 40000, NOW);
  for (const b of wide) {
    const [cc] = S.bubbleCentersInBbox([b.lng - 1e-4, b.lat - 1e-4, b.lng + 1e-4, b.lat + 1e-4], NOW);
    if (!cc) continue;
    const top = Array.from(T.shares(b.id).entries()).sort((x, y) => y[1] - x[1])[0][0];
    const forms = new Set(T.forwardForms(top));
    total++;
    if (forms.has(cc.speciesA) && forms.has(cc.speciesB)) same++;
    if (T.forwardForms(cc.speciesA).length && T.forwardForms(cc.speciesB).length) evolvedBoth++;
  }
  console.log(`centres: ${total} bubbles, both halves from the top species' line in ${(same / total * 100).toFixed(0)}%`);
  ok(total > 500, '7: plenty of bubbles in a 40 km radius');
  ok(same / total > 0.15 && same / total < 0.6, '7: the other half is sometimes the same species\' line');
  ok(evolvedBoth === total, '7: both halves resolve to a species');
}

// ── 8. Radar: the nearest centre shows up like any radar spawn ─────────
{
  const [nb] = S.bubblesNear(MTL[0], MTL[1], 3000, NOW);
  const near = S.nearestRadar(nb.lat + 0.0005, nb.lng, 5);
  ok(near.some((p) => p.id === 'E:B:' + nb.id), '8: nearestRadar includes the centre next to you');
}

// ── 9. Focus mode's roll has no location: no bubble code path ──────────
{
  const src = require('fs').readFileSync(path.join(root, 'static', 'spawns.js'), 'utf8');
  const at = src.indexOf('function rollWildEncounter()');
  const body = src.slice(at, src.indexOf('\n  }\n', at));
  ok(at > 0 && !/bubble/i.test(body), '9: rollWildEncounter (focus mode) ignores bubbles');
}

// ── 10. Incense inside a bubble: weighted halves, same type rule + density
{
  const TYPE = 'WATER';
  const latPad = 700 / M_PER_DEG, lngPad = 700 / (M_PER_DEG * cosB);
  const cx0 = Math.floor((B.lat - latPad + 90) * SCALE), cx1 = Math.ceil((B.lat + latPad + 90) * SCALE);
  const cy0 = Math.floor((B.lng - lngPad + 180) * SCALE), cy1 = Math.ceil((B.lng + lngPad + 180) * SCALE);
  // Cells well inside B and no other bubble (picked with bubbles on).
  T.setEnabled(true);
  const cells = [];
  for (let cx = cx0; cx <= cx1; cx += 4) {
    for (let cy = cy0; cy <= cy1; cy += 4) {
      const lat = (cx + 0.5) / SCALE - 90, lng = (cy + 0.5) / SCALE - 180;
      if (distM(lat, lng, B.lat, B.lng) / 500 >= 0.95) continue;
      if (T.around(lat, lng, NOW).length !== 1) continue;
      cells.push([cx, cy]);
    }
  }
  const run = (enabled) => {
    T.setEnabled(enabled);
    const out = new Map();
    for (const [cx, cy] of cells) {
      for (let t = tick0; t < tick0 + 900; t++) {
        const p = S.generateIncenseCellAtTick(cx, cy, t, TYPE, NOW);
        if (p) out.set(p.id, p);
      }
    }
    return out;
  };
  const plainInc = run(false), bubInc = run(true);
  const same = (p, q) => q && q.lat === p.lat && q.lng === p.lng && q.level === p.level
    && q.sizeM === p.sizeM && q.startMs === p.startMs && q.variantSeed === p.variantSeed;
  ok(plainInc.size > 100 && bubInc.size === plainInc.size
    && Array.from(plainInc.values()).every((p) => same(p, bubInc.get(p.id))),
    `10: incense density unchanged inside a bubble (${bubInc.size} spawns, same spots/levels/births)`);
  const types = (sp) => global.Species.typesFor(sp);
  const hasType = (p) => types(p.speciesB)[0] === TYPE || (types(p.speciesA)[1] || types(p.speciesA)[0]) === TYPE;
  ok(Array.from(bubInc.values()).every(hasType), '10: every incense spawn still has a ' + TYPE + ' half');
  // The incense half leans on the bubble's weights: top two species among
  // the WATER-typed halves, bubble vs plain.
  const waterHalves = (m) => {
    const out = [];
    for (const p of m.values()) {
      if (types(p.speciesB)[0] === TYPE) out.push(p.speciesB);
      if ((types(p.speciesA)[1] || types(p.speciesA)[0]) === TYPE) out.push(p.speciesA);
    }
    return out;
  };
  const top2share = (list) => {
    const m = new Map();
    for (const sp of list) m.set(sp, (m.get(sp) || 0) + 1);
    const v = Array.from(m.values()).sort((x, y) => y - x);
    return ((v[0] || 0) + (v[1] || 0)) / list.length;
  };
  const bTop = top2share(waterHalves(bubInc)), pTop = top2share(waterHalves(plainInc));
  console.log(`incense: ${TYPE} halves — top two species ${(bTop * 100).toFixed(0)}% in the bubble, ${(pTop * 100).toFixed(0)}% plain`);
  ok(bTop > 0.4 && bTop > 2 * pTop, '10: the incense half leans on the bubble\'s weights');
  // The other half too: the non-incense halves concentrate as well.
  const otherHalves = (m) => {
    const out = [];
    for (const p of m.values()) {
      const headWater = types(p.speciesB)[0] === TYPE;
      out.push(headWater ? p.speciesA : p.speciesB);
    }
    return out;
  };
  const effective = (list) => {
    const m = new Map();
    for (const sp of list) m.set(sp, (m.get(sp) || 0) + 1);
    let q = 0;
    for (const v of m.values()) q += (v / list.length) ** 2;
    return 1 / q;
  };
  const eB = effective(otherHalves(bubInc)), eP = effective(otherHalves(plainInc));
  console.log(`incense: other halves — effective species ${eB.toFixed(1)} in the bubble vs ${eP.toFixed(1)} plain`);
  ok(eB < 0.75 * eP, '10: the other half leans on the bubble\'s weights too');
  T.setEnabled(true);
}

// ── 11. Pack mode: same spots as fusion mode, monsters weighted, no centre
{
  const types = ['PLAIN', 'FLUFFY', 'AQUATIC'];
  const monsters = [];
  for (let k = 0; k < 24; k++) monsters.push({ key: 'neo:' + k, types: [types[k % 3]] });
  const cells = [];
  for (let cx = Math.floor((B.lat + 90) * SCALE) - 30; cx <= Math.floor((B.lat + 90) * SCALE) + 30; cx += 3) {
    for (let cy = Math.floor((B.lng + 180) * SCALE) - 30; cy <= Math.floor((B.lng + 180) * SCALE) + 30; cy += 3) cells.push([cx, cy]);
  }
  const gen = () => {
    const out = new Map();
    for (const [cx, cy] of cells) for (let t = tick0; t < tick0 + 1200; t++) {
      const p = S.generateCellAtTick(cx, cy, t, NOW);
      if (p) out.set(p.id, p);
    }
    return out;
  };
  const fusion = gen();
  S.setPack({ id: 'test', types, monsters, rares: [] });
  const pack = gen();
  const keyCounts = new Map();
  for (const p of pack.values()) keyCounts.set(p.solo, (keyCounts.get(p.solo) || 0) + 1);
  const topKey = Math.max(...keyCounts.values()) / pack.size;
  const centres = S.bubbleCentersInBbox([B.lng - 0.001, B.lat - 0.001, B.lng + 0.001, B.lat + 0.001], NOW);
  S.setPack(null);
  ok(pack.size > 50 && pack.size === fusion.size
    && Array.from(fusion.values()).every((f) => { const p = pack.get(f.id);
      return p && p.lat === f.lat && p.lng === f.lng && p.level === f.level && p.startMs === f.startMs; }),
    `11: pack spawns stand exactly where fusion spawns do inside a bubble (${pack.size})`);
  console.log(`pack: top monster ${(topKey * 100).toFixed(0)}% of spawns near the centre (uniform would be ~${(100 / 24).toFixed(0)}%)`);
  ok(topKey > 3 / 24, '11: pack monsters lean on the bubble\'s weights');
  ok(centres.length === 0, '11: no centre spawn in pack mode');
}

// ── 12. Cost: a cold refresh-sized scan at a bubble centre ─────────────
{
  const bbox = (lat, lng) => {
    const latPad = 115 / M_PER_DEG, lngPad = 115 / (M_PER_DEG * Math.cos(lat * Math.PI / 180));
    return [lng - lngPad, lat - latPad, lng + lngPad, lat + latPad];
  };
  const time = (enabled) => {
    T.setEnabled(enabled);
    const t1 = process.hrtime.bigint();
    for (let k = 0; k < 4; k++) { T.setEnabled(enabled); S.spawnsInBbox(bbox(B.lat, B.lng + k * 0.004), NOW); }
    return Number(process.hrtime.bigint() - t1) / 4e6;
  };
  time(true);
  const off = time(false), on = time(true);
  console.log(`cold refresh at a centre: ${on.toFixed(1)} ms with bubbles, ${off.toFixed(1)} ms without`);
  ok(on < off * 1.5 + 5, '12: bubbles add little to a cold refresh');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
