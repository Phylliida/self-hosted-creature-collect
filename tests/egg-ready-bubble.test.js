// Regression test: the map "egg ready to hatch" bubble's visibility rule.
//
// A small egg-with-crack bubble joins the bottom-right map control cluster and
// is shown ONLY when at least one egg has finished incubating (walked the full
// INCUBATOR_HATCH_M in an incubator slot). Tapping it hatches that egg and
// jumps to the new creature. This pins the visibility predicate
// (`_anyEggReadyToHatch`) + the underlying threshold (`eggReadyToHatch`) so a
// future edit can't accidentally surface the bubble for un-incubated eggs or
// hide it when one is genuinely ready.
//
// Run: node tests/egg-ready-bubble.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

// comment-aware brace extractor (same approach as radar-autogen-label.test.js)
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

// Pull the threshold constants straight out of the source so the test stays in
// lockstep with the real values if they're ever retuned.
const HATCH_M = Number((src.match(/const INCUBATOR_HATCH_M\s*=\s*(\d+)/) || [])[1]);
ok(Number.isFinite(HATCH_M) && HATCH_M > 0, 'threshold: INCUBATOR_HATCH_M parsed from source');
const LEG_HATCH_M = Number((src.match(/const LEGENDARY_EGG_HATCH_M\s*=\s*(\d+)/) || [])[1]);
ok(Number.isFinite(LEG_HATCH_M) && LEG_HATCH_M > HATCH_M,
  'threshold: LEGENDARY_EGG_HATCH_M parsed from source (longer than the normal target)');
const LEG_IDS = ((src.match(/LEGENDARY_SPECIES_SET\s*=\s*new Set\(\[([\d,\s]+)\]\)/) || [])[1] || '')
  .split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
ok(LEG_IDS.length > 0, 'threshold: legendary species set parsed from source');

const ctx = {
  INCUBATOR_HATCH_M: HATCH_M,
  LEGENDARY_EGG_HATCH_M: LEG_HATCH_M,
  isLegendarySpecies: (id) => LEG_IDS.includes(id),
};
vm.createContext(ctx);
vm.runInContext(extract('function _isSoloEgg'), ctx);
vm.runInContext(extract('function _isLegendaryEgg'), ctx);
vm.runInContext(extract('function eggHatchM'), ctx);
vm.runInContext(extract('function eggIncubatedM'), ctx);
vm.runInContext(extract('function eggReadyToHatch'), ctx);
vm.runInContext(extract('function _anyEggReadyToHatch'), ctx);
const eggReadyToHatch = vm.runInContext('eggReadyToHatch', ctx);
const anyReady = vm.runInContext('_anyEggReadyToHatch', ctx);

const egg = (m) => ({ id: 'e1', speciesA: 1, speciesB: 2, incubatedM: m });
const legEgg = (m) => ({ id: 'e2', speciesA: LEG_IDS[0], speciesB: 2, incubatedM: m });

// ── A. threshold: ready iff incubatedM has reached the full distance ──
ok(eggReadyToHatch(egg(HATCH_M)) === true, 'A: exactly at threshold → ready');
ok(eggReadyToHatch(egg(HATCH_M + 1)) === true, 'A: past threshold → ready');
ok(eggReadyToHatch(egg(HATCH_M - 1)) === false, 'A: one metre short → not ready');
ok(eggReadyToHatch(egg(0)) === false, 'A: freshly slotted → not ready');
ok(eggReadyToHatch({ id: 'x', speciesA: 1, speciesB: 2 }) === false, 'A: no incubatedM field → not ready');

// ── A2. legendary eggs use the longer target, on either fusion side ──
ok(eggReadyToHatch(legEgg(HATCH_M)) === false, 'A2: legendary egg at 5 km → NOT ready');
ok(eggReadyToHatch(legEgg(LEG_HATCH_M - 1)) === false, 'A2: legendary egg one metre short → not ready');
ok(eggReadyToHatch(legEgg(LEG_HATCH_M)) === true, 'A2: legendary egg at its target → ready');
ok(eggReadyToHatch({ id: 'e3', speciesA: 2, speciesB: LEG_IDS[0], incubatedM: LEG_HATCH_M }) === true,
  'A2: legendary on the B side counts too');
ok(eggReadyToHatch({ id: 'e4', solo: 'neo:a', incubatedM: HATCH_M }) === true,
  'A2: solo eggs keep the normal target');

// ── B. bubble predicate: visible iff SOME egg is ready ──
ok(anyReady([]) === false, 'B: no eggs → bubble hidden');
ok(anyReady([egg(0), egg(HATCH_M - 100)]) === false, 'B: only in-progress eggs → hidden');
ok(anyReady([egg(0), egg(HATCH_M)]) === true, 'B: one ready among several → shown');
ok(anyReady([egg(HATCH_M), egg(HATCH_M + 500)]) === true, 'B: all ready → shown');

// ── C. defensive: non-array input never shows the bubble (readEggs failure) ──
ok(anyReady(null) === false, 'C: null → hidden');
ok(anyReady(undefined) === false, 'C: undefined → hidden');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
