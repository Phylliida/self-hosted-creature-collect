// Guards the spawnsInBbox memo (static/spawns.js) against the
// brute-force definition it caches: every (cell, tick) in the scan
// window run through generateCellAtTick, kept if alive and inside the
// box. The memo is a per-cell ring of ticks (Oct 2026 rewrite for
// "the app lags on the bus"); these checks pin that it returns the
// same spawns on a moving player, across minute rollovers, after a
// teleport and a jump back in time, that it stays bounded on a long
// ride, and that the cells in view stay warm (no regeneration).
//
// Run: node tests/spawn-memo.test.js
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

const SCALE = 10000;
const LIFETIME_TICKS = Math.ceil(S.LIFETIME_MS / S.TICK_MS);
// creatures.js _spawnsAround: VISIBILITY_RADIUS_M + 15 around the player.
function bboxAt(lat, lng) {
  const padM = 115;
  const latPad = padM / 111000, lngPad = padM / (111000 * Math.cos(lat * Math.PI / 180));
  return [lng - lngPad, lat - latPad, lng + lngPad, lat + latPad];
}
// The unmemoized definition (normal stream + incense), same scan order.
function brute(bbox, now, gen) {
  const [west, south, east, north] = bbox;
  const curTick = S.currentTick(now);
  const out = [];
  for (let cx = Math.floor((south + 90) * SCALE); cx <= Math.ceil((north + 90) * SCALE); cx++) {
    for (let cy = Math.floor((west + 180) * SCALE); cy <= Math.ceil((east + 180) * SCALE); cy++) {
      for (let t = curTick - LIFETIME_TICKS; t <= curTick; t++) {
        const p = gen(cx, cy, t);
        if (!p || now < p.startMs || now >= p.expireMs) continue;
        if (p.lat < south || p.lat > north || p.lng < west || p.lng > east) continue;
        out.push(p);
      }
    }
  }
  return out;
}
const sig = (arr) => JSON.stringify(arr.map((p) =>
  [p.id, p.speciesA, p.speciesB, p.lat, p.lng, p.level, p.sizeM, p.startMs, p.variantSeed]));
function expectFull(bbox, now, msg) {
  const got = S.spawnsInBbox(bbox, now);
  const want = brute(bbox, now, (cx, cy, t) => S.generateCellAtTick(cx, cy, t, now))
    .concat(S.legendariesInBbox(bbox, now), S.evolvedInBbox(bbox, now));
  ok(sig(got) === sig(want), msg + ` (${got.length} vs ${want.length} spawns)`);
  return got;
}

const T0 = Date.UTC(2026, 9, 11, 17, 0, 7);
const LAT = 44.05, LNG0 = -123.09;
const mPerDegLng = 111320 * Math.cos(LAT * Math.PI / 180);

// ── 1. A 10-minute bus ride at 12 m/s, one fix a second ─────────────
let seen = 0;
expectFull(bboxAt(LAT, LNG0), T0, '1: cold scan matches brute force');
for (let s = 1; s <= 600; s++) {
  const lng = LNG0 + (12 * s) / mPerDegLng;
  const now = T0 + s * 1000;
  if (s % 60 === 0 || s === 53 || s === 54) {
    seen += expectFull(bboxAt(LAT, lng), now, `1: ride t=${s}s matches brute force`).length;
  } else {
    S.spawnsInBbox(bboxAt(LAT, lng), now);
  }
}
ok(seen > 0, '1: the ride saw spawns at all (test is meaningful)');

// ── 2. The memo stays bounded on a long ride ─────────────────────────
// A 120k-entry cap used to be hit ~3 min into a bus ride and the whole
// memo was dropped (one cold rescan of every visible cell-tick).
{
  const st = S._memoStats();
  const lng = LNG0 + (12 * 600) / mPerDegLng;
  const b = bboxAt(LAT, lng);
  const viewCells = (Math.ceil((b[3] + 90) * SCALE) - Math.floor((b[1] + 90) * SCALE) + 1)
    * (Math.ceil((b[2] + 180) * SCALE) - Math.floor((b[0] + 180) * SCALE) + 1);
  ok(st.cells <= st.maxCells + viewCells, `2: memo bounded (${st.cells} cells, cap ${st.maxCells})`);
}

// ── 3. Cells in view stay warm ───────────────────────────────────────
{
  const lng = LNG0 + (12 * 600) / mPerDegLng;
  const now = T0 + 600 * 1000 + 500;   // same minute as the last ride fix
  const m0 = S._memoStats().misses;
  S.spawnsInBbox(bboxAt(LAT, lng), now);
  ok(S._memoStats().misses === m0, '3: standing still in the same minute regenerates nothing');
  // The next minute: exactly one new tick per cell in view.
  const b = bboxAt(LAT, lng);
  const viewCells = (Math.ceil((b[3] + 90) * SCALE) - Math.floor((b[1] + 90) * SCALE) + 1)
    * (Math.ceil((b[2] + 180) * SCALE) - Math.floor((b[0] + 180) * SCALE) + 1);
  const nowNext = now + S.TICK_MS;
  const m1 = S._memoStats().misses;
  expectFull(b, nowNext, '3: after a minute rollover');
  ok(S._memoStats().misses - m1 === viewCells,
    `3: a rollover generates one tick per cell (${S._memoStats().misses - m1} vs ${viewCells})`);
  // Fill the memo past its cap with a far-away sweep, then come back
  // and stand still: eviction must not have dropped the cells in view.
  for (let k = 1; k <= 40; k++) S.spawnsInBbox(bboxAt(LAT + k * 0.003, lng), nowNext);
  S.spawnsInBbox(b, nowNext);
  const m2 = S._memoStats().misses;
  S.spawnsInBbox(b, nowNext);
  ok(S._memoStats().misses === m2, '3: eviction keeps the cells of the current scan');
  ok(S._memoStats().cells <= S._memoStats().maxCells + viewCells, '3: and stays bounded after the sweep');
}

// ── 4. Teleport, and a jump back in time (tests and resumes do this) ─
expectFull(bboxAt(45.52, -122.68), T0 + 3600 * 1000, '4: teleport to Portland an hour later');
expectFull(bboxAt(LAT, LNG0), T0, '4: back to the first fix\'s place and time');
expectFull(bboxAt(LAT, LNG0), T0 + 25 * 60 * 1000, '4: same place 25 min later (every tick replaced)');

// ── 5. Incense stream: same memo, same answers ───────────────────────
{
  const start = T0 + 2 * 3600 * 1000;
  S.setActiveIncense({ type: 'FIRE', startMs: start });
  let incSeen = 0;
  for (let s = 0; s <= 180; s++) {
    const lng = LNG0 + (12 * s) / mPerDegLng;
    const now = start + 5000 + s * 1000;
    const b = bboxAt(LAT, lng);
    if (s % 45 === 0) {
      const got = S.incenseSpawnsInBbox(b, now);
      const want = brute(b, now, (cx, cy, t) => S.generateIncenseCellAtTick(cx, cy, t, 'FIRE', now));
      ok(sig(got) === sig(want), `5: incense t=${s}s matches brute force (${got.length})`);
      incSeen += got.length;
    } else {
      S.incenseSpawnsInBbox(b, now);
    }
  }
  ok(incSeen > 0, '5: incense produced spawns (test is meaningful)');
  ok(S._memoStats().incCells <= S._memoStats().maxCells + 1000, '5: incense memo bounded');
  S.setActiveIncense(null);
}

console.log(`spawn-memo: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
