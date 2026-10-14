// Tests the spawn bubbles ("nests") in static/spawns.js: ~1.7 km squares
// with one 500 m bubble each per UTC day; inside, the normal stream's density
// ramps from 1× (edge) to 2× (centre) and every spawn has one half that is
// the bubble's primary (2/3) or secondary (1/3) pokémon, the other half the
// usual weather draw; the centre holds a radar spawn ('E:B:' id) of their
// evolved forms for the whole day. Incense spawns inside have one half the
// bubble's pokémon and still the incense type, at the same density. Pack mode
// gets the same bubbles (so its spawns co-locate with fusion mode's) but no
// centre.
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

// ── 5. The pair: every spawn inside carries the primary or the secondary ─
const PAIR = T.pair(B.id);
const P = PAIR.primary, SEC = PAIR.secondary;
const slotT = (sp) => { const t = global.Species.typesFor(sp); return { head: t[0], body: t[1] || t[0] }; };
// Cells inside B and no other bubble (some of B's spawns belong to a neighbour).
const onlyB = (lat, lng) => { const a = T.around(lat, lng, NOW); return a.length === 1 && a[0].id === B.id; };
{
  console.log(`pair: primary #${P}, secondary #${SEC}`);
  let carries = 0, kept = 0, matched = 0, head = 0, prim = 0, sec = 0, solo = 0;
  for (const q of bubSpawns) {
    if (!onlyB(q.lat, q.lng)) continue;
    solo++;
    if ([q.speciesA, q.speciesB].some((sp) => sp === P || sp === SEC)) carries++;
    const p = plainById.get(q.id);
    if (!p) continue;
    matched++;
    // Exactly one slot was swapped for the bubble's pokémon; the other is the plain draw.
    const bodySwapped = q.speciesB === p.speciesB && (q.speciesA === P || q.speciesA === SEC);
    const headSwapped = q.speciesA === p.speciesA && (q.speciesB === P || q.speciesB === SEC);
    if (bodySwapped || headSwapped) kept++;
    if (q.speciesB !== p.speciesB) { head++; (q.speciesB === P ? prim++ : sec++); }
    else if (q.speciesA !== p.speciesA) { (q.speciesA === P ? prim++ : sec++); }
  }
  const swapped = prim + sec;
  console.log(`pair: ${solo} spawns, head swapped ${(head / swapped * 100).toFixed(0)}%,`
    + ` primary ${(prim / swapped * 100).toFixed(0)}% of swaps`);
  ok(solo > 300 && carries === solo, `5: every spawn in the bubble has the primary or secondary as a half (${carries}/${solo})`);
  ok(matched > 150 && kept === matched, `5: the other half is the plain weather draw (${kept}/${matched})`);
  ok(Math.abs(head / swapped - 0.5) < 0.08, '5: head or body is a coin flip');
  if (P !== SEC) ok(Math.abs(prim / swapped - 2 / 3) < 0.08, '5: the primary is in 2/3 of spawns, the secondary in 1/3');
}
// Across many bubbles: the pair follows the day's natural mix (so the
// daily/weekly types), and is sometimes the same pokémon twice.
{
  const mix = T.mix(DAY);
  let total = 0, same = 0, dailyP = 0;
  const daily = S.currentWeather(NOW).daily;
  const wide = S.bubblesNear(MTL[0], MTL[1], 40000, NOW);
  const counts = new Map();
  for (const b of wide) {
    const pr = T.pair(b.id);
    total++;
    if (pr.primary === pr.secondary) same++;
    counts.set(pr.primary, (counts.get(pr.primary) || 0) + 1);
    if (Object.values(slotT(pr.primary)).includes(daily)) dailyP++;
  }
  let expSame = 0, expDaily = 0, top = null;
  for (const [sp, v] of mix.share) {
    const f = v / mix.sum;
    expSame += f * f;
    if (Object.values(slotT(sp)).includes(daily)) expDaily += f;
    if (top == null || v > mix.share.get(top)) top = sp;
  }
  const expTop = mix.share.get(top) / mix.sum, gotTop = (counts.get(top) || 0) / total;
  console.log(`pairs: ${total} bubbles; primary of the ${daily} day type ${(dailyP / total * 100).toFixed(0)}% (mix ${(expDaily * 100).toFixed(0)}%),`
    + ` top species #${top} ${(gotTop * 100).toFixed(1)}% (mix ${(expTop * 100).toFixed(1)}%), same twice ${(same / total * 100).toFixed(1)}% (mix ${(expSame * 100).toFixed(1)}%)`);
  ok(total > 500, '5: plenty of bubbles in a 40 km radius');
  ok(Math.abs(dailyP / total - expDaily) < 0.05, '5: primaries follow the day\'s types');
  ok(Math.abs(gotTop - expTop) < 0.03, '5: the most common wild species is the most common primary');
  ok(same > 0 && Math.abs(same / total - expSame) < 0.03, '5: primary and secondary are sometimes the same pokémon');
  ok(JSON.stringify(T.pair(B.id)) === JSON.stringify(PAIR), '5: deterministic');
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
const halvesFrom = (c, pr) => {
  const fp = new Set(T.forwardForms(pr.primary)), fs = new Set(T.forwardForms(pr.secondary));
  return { ok: (fp.has(c.speciesB) && fs.has(c.speciesA)) || (fs.has(c.speciesB) && fp.has(c.speciesA)),
           primaryHead: fp.has(c.speciesB) };
};
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
    ok(halvesFrom(c, PAIR).ok, '7: its halves are the (evolved) primary and secondary');
    ok(S.spawnsInBbox(box, NOW).some((p) => p.id === c.id), '7: spawnsInBbox includes it (catchable when in range)');
    ok(!S.isSpawnIdStale(c.id, NOW + 3600000), '7: not stale later the same day');
    ok(S.isSpawnIdStale(c.id, NOW + DAY_MS), '7: stale the next day');
    ok(JSON.stringify(S.bubbleCentersInBbox(box, NOW + 7200000)[0]) === JSON.stringify(c), '7: deterministic');
    T.setEnabled(false);
    ok(S.bubbleCentersInBbox(box, NOW).length === 0, '7: no centre when bubbles are off');
    T.setEnabled(true);
  }
  // Across many bubbles: always the pair's lines, evolved where they can be.
  let total = 0, good = 0, primaryHead = 0, evolvable = 0, evolved = 0;
  for (const b of S.bubblesNear(MTL[0], MTL[1], 40000, NOW)) {
    const [cc] = S.bubbleCentersInBbox([b.lng - 1e-4, b.lat - 1e-4, b.lng + 1e-4, b.lat + 1e-4], NOW);
    if (!cc) continue;
    const pr = T.pair(b.id);
    const h = halvesFrom(cc, pr);
    total++;
    if (h.ok) good++;
    if (h.primaryHead) primaryHead++;
    const pForms = T.forwardForms(pr.primary);
    if (!(pForms.length === 1 && pForms[0] === pr.primary)) {
      evolvable++;
      if (cc.speciesA !== pr.primary && cc.speciesB !== pr.primary) evolved++;
    }
  }
  console.log(`centres: ${total} bubbles, primary as head ${(primaryHead / total * 100).toFixed(0)}%,`
    + ` evolved primary ${evolved}/${evolvable} where it can evolve`);
  ok(total > 500 && good === total, '7: every centre is the evolved primary + evolved secondary');
  ok(Math.abs(primaryHead / total - 0.5) < 0.06, '7: either order');
  ok(evolvable > 50 && evolved === evolvable, '7: a primary that can evolve always shows evolved');
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

// ── 10. Incense inside a bubble: the pair + the incense type, same density
{
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
      if (!onlyB(lat, lng)) continue;
      cells.push([cx, cy]);
    }
  }
  const run = (type, enabled) => {
    T.setEnabled(enabled);
    const out = new Map();
    for (const [cx, cy] of cells) {
      for (let t = tick0; t < tick0 + 900; t++) {
        const p = S.generateIncenseCellAtTick(cx, cy, t, type, NOW);
        if (p) out.set(p.id, p);
      }
    }
    return out;
  };
  const shows = (p, type) => slotT(p.speciesB).head === type || slotT(p.speciesA).body === type;
  const isPair = (sp) => sp === P || sp === SEC;
  const pairTypes = new Set([P, SEC].flatMap((sp) => [slotT(sp).head, slotT(sp).body]));

  // An incense type the pair doesn't have: the bubble's pokémon is one half,
  // the other half is from the incense type.
  const pool = (slot, type) => Object.keys(typesMap).some((k) => slotT(Number(k))[slot] === type);
  const NONE = global.Types.list().find((t) => !pairTypes.has(t) && pool('head', t) && pool('body', t));
  const plainInc = run(NONE, false), bubInc = run(NONE, true);
  const same = (p, q) => q && q.lat === p.lat && q.lng === p.lng && q.level === p.level
    && q.sizeM === p.sizeM && q.startMs === p.startMs && q.variantSeed === p.variantSeed;
  ok(plainInc.size > 100 && bubInc.size === plainInc.size
    && Array.from(plainInc.values()).every((p) => same(p, bubInc.get(p.id))),
    `10: incense density unchanged inside a bubble (${bubInc.size} ${NONE} spawns, same spots/levels/births)`);
  const partnered = Array.from(bubInc.values()).filter((p) =>
    (isPair(p.speciesB) && slotT(p.speciesA).body === NONE) || (isPair(p.speciesA) && slotT(p.speciesB).head === NONE));
  ok(partnered.length === bubInc.size,
    `10: ${NONE} incense (not the pair's type): the pair's pokémon + a ${NONE} half (${partnered.length}/${bubInc.size})`);

  // An incense type the primary has: the primary shows it, so the other half
  // is free (the incense stream's 40/30/30 other type), not always that type.
  const FREE = slotT(P).head;
  const freeInc = run(FREE, true);
  ok(Array.from(freeInc.values()).every((p) => shows(p, FREE)), `10: every ${FREE} incense spawn still has a ${FREE} half`);
  ok(Array.from(freeInc.values()).every((p) => isPair(p.speciesA) || isPair(p.speciesB)), '10: and the pair\'s pokémon as a half');
  const pHead = Array.from(freeInc.values()).filter((p) => p.speciesB === P);
  const freeShare = pHead.filter((p) => slotT(p.speciesA).body !== FREE).length / pHead.length;
  const w = S.currentWeather(NOW);
  const expFree = 1 - (0.4 / global.Types.list().length + 0.3 * (w.weekly === FREE) + 0.3 * (w.daily === FREE));
  console.log(`incense: ${FREE} with primary #${P} as head (n=${pHead.length}): other half not ${FREE} ${(freeShare * 100).toFixed(0)}%`
    + ` (free half predicts ~${(expFree * 100).toFixed(0)}%)`);
  ok(pHead.length > 20 && Math.abs(freeShare - expFree) < 0.15, '10: when the pokémon has the incense type, the other half is free');
  T.setEnabled(true);
}

// ── 11. Pack mode: same spots as fusion mode, the pair as solos, no centre
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
  const pr = T.pair(B.id);
  const centres = S.bubbleCentersInBbox([B.lng - 0.001, B.lat - 0.001, B.lng + 0.001, B.lat + 0.001], NOW);
  S.setPack(null);
  ok(pack.size > 50 && pack.size === fusion.size
    && Array.from(fusion.values()).every((f) => { const p = pack.get(f.id);
      return p && p.lat === f.lat && p.lng === f.lng && p.level === f.level && p.startMs === f.startMs; }),
    `11: pack spawns stand exactly where fusion spawns do inside a bubble (${pack.size})`);
  ok(pr && typeof pr.primary.key === 'string' && monsters.includes(pr.primary) && monsters.includes(pr.secondary),
    '11: the pack bubble\'s pair are pack monsters');
  const pairShare = Array.from(pack.values()).filter((p) => p.solo === pr.primary.key || p.solo === pr.secondary.key).length / pack.size;
  console.log(`pack: the pair (${pr.primary.key}, ${pr.secondary.key}) is ${(pairShare * 100).toFixed(0)}% of solos near the centre (uniform would be ~${(200 / 24).toFixed(0)}%)`);
  ok(pairShare > 0.4, '11: the solo is the bubble\'s pokémon about half the time (the head slot)');
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
