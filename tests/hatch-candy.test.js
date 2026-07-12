// Test: hatching an egg awards 10 candy, each unit an independent 50/50
// coin flip between the two morphs' family roots (self-fusion → all to the
// one shared root). Normal 2-candy captures are unchanged (uniform 1/3).
//
// Run: node tests/hatch-candy.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'creatures.js'), 'utf8');
function extract(marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++) { if (src[i] === '\\') i++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
function mathWith(rng) { const M = Object.create(Math); M.random = rng; return M; }

// ── awardCandyForCapture: run it with identity roots + a recording bumpCandy ──
function awardWith(rng) {
  const candy = {};
  const ctx = {
    Math: mathWith(rng),
    candyRootFor: (idx) => idx,                       // identity: root == species here
    bumpCandy: (idx, n) => { candy[String(idx)] = (candy[String(idx)] || 0) + n; },
  };
  vm.createContext(ctx);
  vm.runInContext(extract('function awardCandyForCapture'), ctx);
  return { candy, call: (a, b, total) => vm.runInContext(`awardCandyForCapture(${a},${b},${JSON.stringify(total)})`, ctx) };
}

// A. total=10, every flip < 0.5 → all 10 to the first morph's root
{
  const w = awardWith(() => 0.4);
  w.call(1, 4, 10);
  ok(w.candy['1'] === 10 && w.candy['4'] === undefined, 'A: all flips to A → 10 candy on root A, none on B');
}
// B. total=10, every flip >= 0.5 → all 10 to the second morph's root
{
  const w = awardWith(() => 0.6);
  w.call(1, 4, 10);
  ok(w.candy['4'] === 10 && w.candy['1'] === undefined, 'B: all flips to B → 10 candy on root B, none on A');
}
// C. total=10, alternating flips → exact 5/5 split, and always sums to 10
{
  let i = 0;
  const w = awardWith(() => (i++ % 2 === 0 ? 0.4 : 0.6));  // even calls hit A
  w.call(1, 4, 10);
  ok(w.candy['1'] === 5 && w.candy['4'] === 5, 'C: alternating flips → 5/5 split');
  ok((w.candy['1'] || 0) + (w.candy['4'] || 0) === 10, 'C: total candy is exactly 10');
}
// D. self-fusion (same root both sides) → all 10 land on the one root, no flips needed
{
  const w = awardWith(() => { throw new Error('should not roll for self-fusion'); });
  w.call(7, 7, 10);
  ok(w.candy['7'] === 10, 'D: self-fusion → 10 candy on the shared root');
}
// E. regression: default capture (no total) still 2 candy, uniform 1/3 rule
{
  const lo = awardWith(() => 0.1);  lo.call(1, 4);   // r < 1/3 → 2 on A
  ok(lo.candy['1'] === 2 && lo.candy['4'] === undefined, 'E: normal capture r<1/3 → 2 on A');
  const mid = awardWith(() => 0.5); mid.call(1, 4);  // 1/3<=r<2/3 → 2 on B
  ok(mid.candy['4'] === 2 && mid.candy['1'] === undefined, 'E: normal capture mid → 2 on B');
  const hi = awardWith(() => 0.9);  hi.call(1, 4);   // r>=2/3 → 1+1
  ok(hi.candy['1'] === 1 && hi.candy['4'] === 1, 'E: normal capture r>=2/3 → 1+1 split');
}

// ── F. hatchEgg wiring: it passes total=10 to awardCandyForCapture ──
(async () => {
  const candyCalls = [];
  let captured = [];
  let eggs = [{ id: 'e1', speciesA: 1, speciesB: 4, sizeM: 1.2 }];
  const ctx = {
    Math, Date: { now: () => 1700000000000 },
    global: { CreatureCollectAPI: null },
    CANDY_HATCH_CAPTURE: 10,
    readEggs: () => eggs, writeEggs: (a) => { eggs = a; },
    eggReadyToHatch: () => true,
    _pickHatchVariant: async () => 'auto',
    _rollFreshShinyVariant: () => null,
    readCapturedCreatures: () => captured,
    writeCapturedCreatures: (l) => { captured = l; },
    markFusionSeen: () => {},
    removeFromIncubator: () => {},
    awardCandyForCapture: (a, b, total) => { candyCalls.push({ a, b, total }); },
  };
  vm.createContext(ctx);
  vm.runInContext(extract('async function hatchEgg'), ctx);
  await vm.runInContext('hatchEgg("e1")', ctx);

  ok(candyCalls.length === 1, 'F: awardCandyForCapture called once at hatch');
  ok(candyCalls[0] && candyCalls[0].total === 10, 'F: hatch awards a 10-candy haul');
  ok(candyCalls[0] && candyCalls[0].a === 1 && candyCalls[0].b === 4, 'F: candy awarded for the hatched fusion');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
