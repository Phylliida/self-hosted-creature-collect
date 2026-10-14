// Spawns.incensePairOdds (static/spawns.js) — the incense stream's spawn
// distribution, used by the completion Summary's "Incense" sort (chance
// one incense spawn is a fusion you haven't seen). Checked against the
// real generator, generateIncenseCellAtTick:
//   1. the blocks' p sum to 1, and every generated spawn lies in a block;
//   2. predicted P(spawn is in an arbitrary "unseen" set) matches the
//      generated frequency, for several incense types;
//   3. same under a community day (featured species in one slot).
//
// Run: node tests/incense-odds.test.js
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
// incensePairOdds is the location-free distribution; spawn bubbles lean the
// species inside them (tests/spawn-bubbles.test.js covers that), so compare
// against the generator with bubbles off.
S._bubbleTest.setEnabled(false);
const MIN = 60000;
// Midday, so every tick below shares one daily + weekly type.
const NOW = Date.UTC(2026, 6, 22, 12, 0, 0);

// An arbitrary "unseen" set (about a third of all pairs), and pairs
// with a half of today's type — the latter is what the 30% daily
// weight moves, so a wrong weight shows up there.
const w = S.currentWeather(NOW);
const unseen = (a, b) => (a * 7 + b * 13) % 3 === 0;
const daily = (a, b) => global.Species.typesFor(a).includes(w.daily)
  || global.Species.typesFor(b).includes(w.daily);

function predicted(blocks, inSet) {
  let p = 0;
  for (const blk of blocks) {
    let n = 0;
    for (const a of blk.bodies) for (const b of blk.heads) if (inSet(a, b)) n++;
    p += blk.p * n / (blk.bodies.length * blk.heads.length);
  }
  return p;
}
function generated(type, cells, ticks) {
  const out = [];
  const t0 = S.currentTick(NOW);
  for (let t = t0 - ticks; t < t0 + ticks; t++) {
    for (let cx = 200000; cx < 200000 + cells; cx++) {
      for (let cy = 300000; cy < 300000 + cells; cy++) {
        const sp = S.generateIncenseCellAtTick(cx, cy, t, type, NOW);
        if (sp) out.push(sp);
      }
    }
  }
  return out;
}
function check(label, type, cells, ticks) {
  const blocks = S.incensePairOdds(type, NOW);
  const sum = blocks.reduce((s, b) => s + b.p, 0);
  ok(blocks.length && Math.abs(sum - 1) < 1e-9, `${label}: block odds sum to 1 (${sum})`);
  const spawns = generated(type, cells, ticks);
  const inSupport = (sp) => blocks.some((b) => b.bodies.includes(sp.speciesA) && b.heads.includes(sp.speciesB));
  ok(spawns.length > 400 && spawns.every(inSupport),
    `${label}: every one of ${spawns.length} generated spawns lies in a block`);
  for (const [name, inSet] of [['unseen set', unseen], [`a ${w.daily} half`, daily]]) {
    const want = predicted(blocks, inSet);
    const got = spawns.filter((sp) => inSet(sp.speciesA, sp.speciesB)).length / spawns.length;
    const sigma = Math.sqrt(Math.max(want * (1 - want), 1e-4) / spawns.length);
    ok(Math.abs(got - want) < 4 * sigma,
      `${label}, ${name}: predicted ${(want * 100).toFixed(1)}%, generated ${(got * 100).toFixed(1)}% (±${(4 * sigma * 100).toFixed(1)})`);
  }
}

// ── 1 + 2. Incense types: an ordinary one, one with no primary-typed
// base form (only one placement works) and today's type ──
const onePlacement = ['FLYING', 'STEEL'].find((t) => S.incensePairOdds(t, NOW).every((b) => !b.heads.length
  || b.heads.every((h) => global.Species.typesFor(h)[0] !== t)));
for (const type of ['FIRE', onePlacement, w.daily].filter(Boolean)) check(type, type, 200, 20);

// ── 3. Community day: featured species in one slot ──
{
  const X = S.SPAWNABLE_SPECIES_A[5];
  S.setCommunityDay({ speciesId: X, startMs: NOW - 120 * MIN, endMs: NOW + 120 * MIN });
  const blocks = S.incensePairOdds('GRASS', NOW);
  ok(blocks.every((b) => b.bodies.includes(X) || b.heads.includes(X)),
    '3: community day — every block has the featured species in a slot');
  check('3: GRASS + community day', 'GRASS', 200, 20);
  S.setCommunityDay(null);
}

ok(S.incensePairOdds('NOT_A_TYPE', NOW).length === 0, 'an unknown type has no odds');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
