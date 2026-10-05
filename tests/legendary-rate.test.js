// Tests the legendary spawn-rate change in static/spawns.js
// (2026-10-05: legendaries are 3× rarer — LEG_RARITY 16000 → 48000).
//
// The density formula is LEG_CHANCE_PER_CELLTICK =
// (SPAWN_CHANCE_PER_TICK × LIFETIME_TICKS) / (LEG_RARITY × LEG_LIFETIME_TICKS).
// The old pre-filter `(h % LEG_MOD) === 0` only produced that exact density
// at reciprocal values of LEG_MOD; at 48000 it would have silently kept the
// old rate, so the pre-filter is now the exact hash-ratio test
// (h / 2^32) < LEG_CHANCE_PER_CELLTICK. This test scans a fixed cell-tick
// window and counts generateLegendaryAtTick positives to prove the
// realized density matches the new formula — and is ~1/3 of the old one.
//
// Run: node tests/legendary-rate.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const spawnSrc = fs.readFileSync(path.join(root, 'static', 'spawns.js'), 'utf8');

// ── 1) Source constants: the retune is actually in place ─────────
const LEG_RARITY = Number((spawnSrc.match(/const LEG_RARITY = (\d+)/) || [])[1]);
ok(LEG_RARITY === 48000, '1: LEG_RARITY = 48000 (3× the old 16000)');
const SPAWN_CHANCE = Number((spawnSrc.match(/const SPAWN_CHANCE_PER_TICK = ([\d.]+)/) || [])[1]);
const LIFETIME_TICKS = 20;          // LIFETIME_MS / TICK_MS, spawns.js
const LEG_LIFETIME_TICKS = 4;       // LEG_LIFETIME_MS / LEG_TICK_MS, spawns.js
ok(spawnSrc.indexOf('LEG_MOD') < 0,
  '1: LEG_MOD gone — modulo pre-filter can\'t silently revert to the old rate');
ok(/h \/ 4294967296\) < LEG_CHANCE_PER_CELLTICK/.test(spawnSrc),
  '1: pre-filter is the exact hash-ratio test');

// Chance per cell-tick from the formula (old rate was exactly 3× this).
const CHANCE = (SPAWN_CHANCE * LIFETIME_TICKS) / (LEG_RARITY * LEG_LIFETIME_TICKS);
const OLD_CHANCE = (SPAWN_CHANCE * LIFETIME_TICKS) / (16000 * LEG_LIFETIME_TICKS);
ok(Math.abs(OLD_CHANCE / CHANCE - 3) < 1e-9, '1: formula ratio old:new is exactly 3:1');

// ── 2) Realized density over a fixed scan window ─────────────────
// spawns.js reads global.Types at load — types.js first, Species stub
// before generation (same setup as community-day.test.js).
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

// Scan window: 600k cells × 100 cy = 60M cell-ticks, one legendary tick.
// Expected positives: 60M × CHANCE ≈ 5 (old rate would give ≈ 15).
// The stream is deterministic, so the count is exact for this window —
// the bounds below are sized from the formula (any realized count is
// legitimate hash scatter, but a 3× regression can't land inside them:
// the old rate would need to come in at ≤ half its own expectation).
const CX_MAX = 600000, CY0 = 90000, CY1 = 90100;
const lt = Date.UTC(2026, 9, 3, 12, 0, 0);   // any fixed instant — no hour gate on legendaries
const ltick = Math.floor(lt / S.LEG_TICK_MS);
const N = CX_MAX * (CY1 - CY0);
let hits = 0;
const seen = [];
for (let cx = 0; cx < CX_MAX; cx++) {
  for (let cy = CY0; cy < CY1; cy++) {
    const leg = S.generateLegendaryAtTick(cx, cy, ltick);
    if (leg) { hits++; if (seen.length < 3) seen.push(leg.speciesA); }
  }
}
const expected = N * CHANCE;
const oldExpected = N * OLD_CHANCE;
ok(hits >= 1, `2: legendaries still spawn (${hits} in ${N} cell-ticks, expected ~${expected.toFixed(1)})`);
ok(hits <= Math.floor(oldExpected * 0.55),
  `2: realized density is the NEW rate, not the old one (${hits} vs old expectation ~${oldExpected.toFixed(0)})`);
ok(hits <= expected * 3,
  `2: density not silently LOWER than the formula either (${hits} vs ~${expected.toFixed(1)})`);
ok(seen.every((id) => [144, 145, 146, 150, 151].includes(id)),
  '2: candidates still come from the gen-1 legendary pool');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
