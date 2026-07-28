// Tests the community-day feature in static/spawns.js:
//   - Week schedule: boundary at Monday 12:00 UTC (= Sunday midnight GMT-12),
//     with the event running every OTHER week (off weeks: speciesId null).
//   - Featured-species permutation: full-cycle coverage + 26-appearance
//     no-repeat across cycle boundaries (advances only on community weeks).
//   - Generation override: wild/evolved/incense spawns become fusions with
//     the featured species while a session is active at the QUERY MOMENT
//     (activation transforms all living spawns in place; expiry reverts
//     them); legendary stream exempt; inactive sessions leave every stream
//     bit-identical.
//   - Multi-player co-location: two players with active sessions (same week,
//     different windows) see identical spawns; same incense ⇒ identical
//     incense+community spawns, different incense ⇒ different ones.
//
// Run: node tests/community-day.test.js
'use strict';
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const DAY = 86400000, WEEK = 7 * DAY, HOUR = 3600000, MIN = 60000;

// spawns.js reads global.Types at load — types.js must be required first
// (same load order as index.html), and the Species stub must be in place
// before generation calls build their indices.
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
const POOL = S.SPAWNABLE_SPECIES_A;
const POOL_SET = new Set(POOL);

// ── 1) Week schedule ────────────────────────────────────────────
// 2026-07-20 is a Monday. The week boundary is Monday 12:00 UTC —
// i.e. Sunday 24:00 in GMT-12, the last timezone to leave Sunday.
{
  const monNoon = Date.UTC(2026, 6, 20, 12, 0, 0);
  const kBefore = S.communityWeekKey(monNoon - 1000);
  const kAfter = S.communityWeekKey(monNoon + 1000);
  ok(kAfter === kBefore + 1, '1: week key flips at Monday 12:00 UTC');
  ok(S.communityWeekKey(Date.UTC(2026, 6, 20, 0, 0, 0)) === kBefore,
    '1: does NOT flip at Monday 00:00 UTC');
  ok(S.communityWeekKey(Date.UTC(2026, 6, 19, 23, 59, 59)) === kBefore,
    '1: late Sunday UTC is still the old week');
  const info = S.communityDayInfo(monNoon + 1000);
  ok(info.weekKey === kAfter && info.weekEndMs === monNoon + WEEK,
    '1: weekEndMs is the next Monday 12:00 UTC');
  // Biweekly cadence: of any two consecutive weeks exactly one has a
  // featured species; off weeks report speciesId null.
  const onA = S.communityDayInfo(monNoon + 1000).speciesId != null;
  const onB = S.communityDayInfo(monNoon + WEEK + 1000).speciesId != null;
  const onC = S.communityDayInfo(monNoon + 2 * WEEK + 1000).speciesId != null;
  ok(onA !== onB && onB !== onC, '1: community weeks alternate with empty off weeks');
  ok(POOL_SET.has(info.speciesId) || info.speciesId === null,
    '1: featured species is in the wild pool (or an off week)');
}

// Helper: a timestamp inside an arbitrary week key, anchored to the
// known Monday above.
const MON_NOON = Date.UTC(2026, 6, 20, 12, 0, 0);
const K0 = S.communityWeekKey(MON_NOON + 1000);
function msOfWeek(weekKey) { return MON_NOON + (weekKey - K0) * WEEK + 1000; }

// ── 2) Permutation: full coverage per cycle, 26-appearance no-repeat ──
// The permutation advances one step per COMMUNITY week (off weeks don't
// consume slots), so community-week ordinals map to even weekKeys.
{
  const n = POOL.length;
  const cycles = 4;
  // Community-week ordinal idx == weekKey/2, so weekKey = 2·(c·n + i)
  // walks cycle c's permutation positions 0..n-1 exactly (engine cycle
  // boundaries are at idx ≡ 0 mod n).
  const perms = [];
  for (let c = 0; c < cycles; c++) {
    const seen = [];
    for (let i = 0; i < n; i++) {
      const info = S.communityDayInfo(msOfWeek(2 * (c * n + i)));
      ok(info.speciesId != null, '2: community week has a featured species');
      seen.push(info.speciesId);
    }
    ok(new Set(seen).size === n, '2: cycle ' + c + ' visits every pool species exactly once');
    ok(seen.every((id) => POOL_SET.has(id)), '2: cycle ' + c + ' stays within the pool');
    perms.push(seen);
  }
  for (let c = 1; c < cycles; c++) {
    const prevPos = new Map();
    perms[c - 1].forEach((id, i) => prevPos.set(id, i));
    let minGap = Infinity;
    for (let p = 0; p < n; p++) {
      const gap = p + (n - prevPos.get(perms[c][p]));
      if (gap < minGap) minGap = gap;
    }
    ok(minGap > 26, '2: cycles ' + (c - 1) + '→' + c + ': min recurrence gap '
      + minGap + ' appearances (> 26 ≈ 1 year at biweekly cadence)');
  }
  // Determinism: same week ⇒ same species, computed twice.
  ok(S.communityDayInfo(msOfWeek(200)).speciesId === S.communityDayInfo(msOfWeek(200)).speciesId,
    '2: communityDayInfo is deterministic');
}

// ── Generation fixtures ─────────────────────────────────────────
// A "now" inside a real COMMUNITY week (skip forward past any off week),
// a mid-town bbox, and that week's featured species. Sessions below are
// windows around `now`.
const NOW = (() => { let k = K0 + 7; while (S.communityDayInfo(msOfWeek(k)).speciesId == null) k++; return msOfWeek(k); })();
const BBOX = [-73.990, 40.740, -73.980, 40.750];
const X = S.communityDayInfo(NOW).speciesId;
const shape = (s) => [s.id, s.speciesA, s.speciesB, s.lat, s.lng, s.level, s.sizeM];
const wildOnly = (arr) => arr.filter((s) => !s.legendary && !s.evolved && !s.incense);

// ── 3) Inactive ⇒ streams bit-identical; active ⇒ wild override ──
{
  const baseline = S.spawnsInBbox(BBOX, NOW).map(shape);
  S.setCommunityDay({ speciesId: X, startMs: NOW - 30 * MIN, endMs: NOW + 60 * MIN });
  const active = S.spawnsInBbox(BBOX, NOW);
  const wild = wildOnly(active);
  ok(wild.length > 50, '3: enough wild spawns to test (' + wild.length + ')');
  ok(wild.every((s) => s.speciesA === X || s.speciesB === X),
    '3: every wild spawn has the featured species in a slot');
  ok(wild.every((s) => (s.speciesA === X ? POOL_SET.has(s.speciesB) : POOL_SET.has(s.speciesA))),
    '3: the other wild half is a wild-pool species');
  ok(new Set(wild.map((s) => (s.speciesA === X ? s.speciesB : s.speciesA))).size >= 25,
    '3: partners are diverse (uniform draw, not one or two species)');
  // The featured slot should be ~50/50.
  const inA = wild.filter((s) => s.speciesA === X).length;
  ok(inA / wild.length > 0.4 && inA / wild.length < 0.6,
    '3: featured slot balance ~50% (got ' + (100 * inA / wild.length).toFixed(1) + '% in A)');
  // Positions/levels/sizes are inherited from the underlying stream —
  // same ids as baseline, same count.
  ok(active.length === baseline.length, '3: active session keeps spawn count identical');
  const baseById = new Map(baseline.map((b) => [b[0], b]));
  ok(active.every((s) => {
    const b = baseById.get(s.id);
    return b && b[3] === s.lat && b[4] === s.lng && b[5] === s.level && b[6] === s.sizeM;
  }), '3: active session keeps ids/positions/levels/sizes identical');
  // Back to inactive ⇒ byte-for-byte the baseline again.
  S.setCommunityDay(null);
  const restored = S.spawnsInBbox(BBOX, NOW).map(shape);
  ok(JSON.stringify(restored) === JSON.stringify(baseline),
    '3: clearing the session restores the original stream exactly');
  // An ENDED session (endMs before the query moment) reverts everything —
  // the map goes back to normal the instant the pass runs out.
  S.setCommunityDay({ speciesId: X, startMs: NOW - 90 * MIN, endMs: NOW - 30 * MIN });
  const reverted = S.spawnsInBbox(BBOX, NOW).map(shape);
  S.setCommunityDay(null);
  ok(JSON.stringify(reverted) === JSON.stringify(baseline),
    '3: an ended session leaves no community morphs behind (revert-on-expiry)');
}

// ── 4) Legendary stream exempt ──────────────────────────────────
// Sweep cell-ticks until a few legendaries surface (they're ~1 in 4M
// cell-ticks, so scan adaptively); output must be identical with and
// without a session.
{
  const lt = S.currentLegTick(NOW);
  const sweep = () => {
    const out = [];
    for (let cx = 0; cx <= 300000 && out.length < 3; cx++) {
      for (let cy = 90000; cy < 90100 && out.length < 3; cy++) {
        for (const l of [lt - 1, lt]) {
          const p = S.generateLegendaryAtTick(cx, cy, l);
          if (p) out.push(shape(p));
        }
      }
    }
    return out;
  };
  S.setCommunityDay(null);
  const off = sweep();
  S.setCommunityDay({ speciesId: X, startMs: NOW - 30 * MIN, endMs: NOW + 60 * MIN });
  const on = sweep();
  S.setCommunityDay(null);
  ok(off.length > 0, '4: legendary sweep found spawns (' + off.length + ')');
  ok(JSON.stringify(on) === JSON.stringify(off), '4: legendary stream ignores community day');
}

// ── 5) Evolved (radar) stream override ──────────────────────────
{
  // Mirror of the engine's evolved-pool construction (forward descendants
  // of the wild pool) so the partner draw can be checked.
  const loaded = new Set(namesArr.map((_, i) => i + 1));
  const evoSet = new Set();
  for (const base of POOL) {
    const stack = [base], seen = new Set([base]);
    while (stack.length) {
      for (const e of global.Species.evolutionsFor(stack.pop())) {
        if (seen.has(e.target)) continue;
        seen.add(e.target);
        if (loaded.has(e.target)) evoSet.add(e.target);
        stack.push(e.target);
      }
    }
  }
  const et = S.currentEvoTick(NOW);
  const sess = { speciesId: X, startMs: NOW - 30 * MIN, endMs: NOW + 60 * MIN };
  S.setCommunityDay(sess);
  const spawns = [];
  for (let cx = 70000; cx < 70300 && spawns.length < 30; cx++) {
    for (let cy = 80000; cy < 80300 && spawns.length < 30; cy++) {
      for (const e of [et - 1, et]) {
        // Query-time semantics: every spawn generated while the session
        // is active at the query moment adopts the override, whatever
        // its age.
        const p = S.generateEvolvedAtTick(cx, cy, e, NOW);
        if (p) spawns.push(p);
      }
    }
  }
  S.setCommunityDay(null);
  ok(spawns.length >= 3, '5: evolved sweep found spawns (' + spawns.length + ')');
  ok(spawns.every((s) => s.speciesA === X || s.speciesB === X),
    '5: every evolved spawn has the featured species in a slot');
  ok(spawns.every((s) => (s.speciesA === X ? evoSet.has(s.speciesB) : evoSet.has(s.speciesA))),
    '5: the other evolved half is an evolved-form species');

  // nearestRadar (the blip source) uses the REAL clock for aliveness +
  // query-time activity, so drive it with a real-time session.
  const realNow = Date.now();
  const liveSess = { speciesId: X, startMs: realNow - 30 * MIN, endMs: realNow + 60 * MIN };
  S.setCommunityDay(liveSess);
  const radarOn = S.nearestRadar(45.5, -73.6, 10, 20000);
  S.setCommunityDay(null);
  const radarEvo = radarOn.filter((s) => !s.legendary);
  ok(radarEvo.length > 0, '5: nearestRadar found evolved targets (' + radarEvo.length + ')');
  ok(radarEvo.every((s) => s.speciesA === X || s.speciesB === X),
    '5: radar blips transform while the session is live');
  const endedSess = { speciesId: X, startMs: realNow - 90 * MIN, endMs: realNow - 30 * MIN };
  S.setCommunityDay(endedSess);
  const radarOff = S.nearestRadar(45.5, -73.6, 10, 20000);
  S.setCommunityDay(null);
  ok(radarOff.filter((s) => !s.legendary).every((s) => s.speciesA !== X && s.speciesB !== X),
    '5: radar blips revert once the session has ended');
}

// ── 6) Incense + community ──────────────────────────────────────
{
  const tick = S.currentTick(NOW);
  const incenseSpawns = (type) => {
    const out = [];
    for (let cx = 100000; cx < 100400; cx++) {
      for (let cy = 110000; cy < 110400; cy++) {
        const p = S.generateIncenseCellAtTick(cx, cy, tick, type, NOW);
        if (p) out.push(p);
      }
    }
    return out;
  };
  S.setActiveIncense({ type: 'FIRE', startMs: NOW - 5 * MIN });
  S.setCommunityDay({ speciesId: X, startMs: NOW - 30 * MIN, endMs: NOW + 60 * MIN });
  const fire = incenseSpawns('FIRE');
  ok(fire.length > 20, '6: enough incense spawns to test (' + fire.length + ')');
  ok(fire.every((s) => s.speciesA === X || s.speciesB === X),
    '6: every incense+community spawn has the featured species in a slot');
  ok(fire.every((s) => {
    const other = s.speciesA === X ? s.speciesB : s.speciesA;
    return global.Species.typesFor(other).includes('FIRE');
  }), '6: the other incense half always carries the incense type');
  // Community off ⇒ incense stream back to its normal self.
  S.setCommunityDay(null);
  const baselineFire = incenseSpawns('FIRE').map(shape);
  S.setCommunityDay({ speciesId: X, startMs: NOW - 30 * MIN, endMs: NOW + 60 * MIN });
  S.setCommunityDay(null);
  ok(JSON.stringify(incenseSpawns('FIRE').map(shape)) === JSON.stringify(baselineFire),
    '6: clearing the session restores the plain incense stream exactly');
  S.setActiveIncense(null);
}

// ── 7) Multi-player co-location ─────────────────────────────────
// Two players, same week (same featured species), different session
// windows — both active at NOW. Everything either can see at NOW must
// be identical: the override draws seed from (cell, tick) only, and a
// spawn alive at NOW overlaps both sessions.
{
  const sessA = { speciesId: X, startMs: NOW - 30 * MIN, endMs: NOW + 60 * MIN };
  const sessB = { speciesId: X, startMs: NOW - 5 * MIN, endMs: NOW + 25 * MIN };
  S.setCommunityDay(sessA);
  const rawA = S.spawnsInBbox(BBOX, NOW);
  const viewA = rawA.map(shape);
  S.setCommunityDay(sessB);
  const viewB = S.spawnsInBbox(BBOX, NOW).map(shape);
  S.setCommunityDay(null);
  ok(JSON.stringify(viewA) === JSON.stringify(viewB),
    '7: two active players see identical wild+radar spawns');
  ok(rawA.length > 0 && rawA.every((s) => s.legendary
      || s.speciesA === X || s.speciesB === X),
    '7: the shared view is fully community-morphs (legendaries excepted)');

  // Same incense ⇒ identical incense spawns; different incense ⇒ different.
  const tick = S.currentTick(NOW);
  const sweep = (type, sess) => {
    S.setActiveIncense({ type, startMs: sess.startMs });
    S.setCommunityDay(sess);
    const out = [];
    for (let cx = 100000; cx < 100400; cx++) {
      for (let cy = 110000; cy < 110400; cy++) {
        const p = S.generateIncenseCellAtTick(cx, cy, tick, type, NOW);
        if (p) out.push(shape(p));
      }
    }
    S.setActiveIncense(null); S.setCommunityDay(null);
    return out;
  };
  const aFire = sweep('FIRE', sessA), bFire = sweep('FIRE', sessB), bWater = sweep('WATER', sessB);
  ok(aFire.length > 20, '7: incense sweep found spawns (' + aFire.length + ')');
  ok(JSON.stringify(aFire) === JSON.stringify(bFire),
    '7: same incense + active community ⇒ identical spawns across players');
  ok(JSON.stringify(aFire) !== JSON.stringify(bWater),
    '7: different incense types ⇒ different incense+community spawns');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
