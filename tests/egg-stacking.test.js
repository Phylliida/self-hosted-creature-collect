// Tests the duplicate-egg stacking logic (static/creatures.js):
//   _eggStackKey — the display-level "same egg" relation: pair eggs by
//   content pair, Bad Eggs separately, solo eggs by special id.
//   _stackEggs — grouping into display stacks: representative is the
//   most-incubated member (ties: oldest), group order follows the
//   caller's sort.
//
// Run: node tests/egg-stacking.test.js
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

const ctx = {};
vm.createContext(ctx);
for (const m of ['function _isSoloEgg', 'function _isBadEgg',
                 'function eggIncubatedM',
                 'function _eggStackKey', 'function _stackEggs']) {
  vm.runInContext(extract(m), ctx);
}
const run = (code) => vm.runInContext(code, ctx);

const egg = (id, a, b, extra) => Object.assign(
  { id, speciesA: a, speciesB: b, incubatedM: 0, createdAt: 1 }, extra);

// --- _eggStackKey -----------------------------------------------------------
ok(run(`_eggStackKey(${JSON.stringify(egg('e1', 25, 7))})`) === '25-7',
  'pair egg keys on content pair');
ok(run(`_eggStackKey(${JSON.stringify(egg('e2', 25, 7, { bad: true }))})`) === '25-7-bad',
  'bad flag joins the key');
ok(run(`_eggStackKey(${JSON.stringify(egg('e3', 25, 7, { displaySpecies: 7 }))})`) === '25-7',
  'displaySpecies does not affect sameness');
ok(run(`_eggStackKey(${JSON.stringify({ id: 'e4', solo: 'mew', incubatedM: 0 })})`) === 'solo:mew',
  'solo eggs key on special id');

// --- _stackEggs: grouping ----------------------------------------------------
let stacks = run(`_stackEggs(${JSON.stringify([
  egg('e1', 25, 7), egg('e2', 25, 7), egg('e3', 25, 1),
])})`);
ok(stacks.length === 2, 'same pair collapses, different second species does not');
ok(stacks[0].length === 2 && stacks[1].length === 1, 'stack sizes 2 and 1');

stacks = run(`_stackEggs(${JSON.stringify([
  egg('ok1', 150, 25), egg('bad1', 150, 25, { bad: true }),
  egg('bad2', 150, 25, { bad: true }),
])})`);
ok(stacks.length === 2, 'bad eggs never mix with hatchable duplicates');
ok((stacks.find((s) => s.length === 2) || [])[0].bad === true,
  'bad eggs stack among themselves');

stacks = run(`_stackEggs(${JSON.stringify([
  { id: 's1', solo: 'mew', incubatedM: 0 },
  { id: 's2', solo: 'mew', incubatedM: 0 },
  { id: 's3', solo: 'celebi', incubatedM: 0 },
])})`);
ok(stacks.length === 2 && stacks[0].length === 2, 'solo eggs stack by special id');

// --- _stackEggs: representative ----------------------------------------------
stacks = run(`_stackEggs(${JSON.stringify([
  egg('low', 25, 7, { incubatedM: 100, createdAt: 5 }),
  egg('high', 25, 7, { incubatedM: 4000, createdAt: 9 }),
])})`);
ok(stacks.length === 1 && stacks[0][0].id === 'high',
  'representative is the most-incubated member');

stacks = run(`_stackEggs(${JSON.stringify([
  egg('newer', 25, 7, { createdAt: 9 }),
  egg('older', 25, 7, { createdAt: 3 }),
])})`);
ok(stacks[0][0].id === 'older', 'incubation ties break oldest-first');

stacks = run(`_stackEggs(${JSON.stringify([
  egg('plain1', 25, 7), egg('plain2', 25, 7),
])})`);
ok(stacks.length === 1 && stacks[0].length === 2,
  'legacy eggs without createdAt still stack');

// --- _stackEggs: order preservation ------------------------------------------
stacks = run(`_stackEggs(${JSON.stringify([
  egg('z', 4, 6), egg('a', 1, 2), egg('z2', 4, 6),
])})`);
ok(stacks.length === 2 && stacks[0][0].id === 'z' && stacks[1][0].id === 'a',
  'group order follows first occurrence (caller sort preserved)');

// --- edge cases ---------------------------------------------------------------
stacks = run(`_stackEggs(${JSON.stringify([egg('one', 1, 2)])})`);
ok(stacks.length === 1 && stacks[0].length === 1, 'singleton stays a 1-stack');
stacks = run(`_stackEggs([null, ${JSON.stringify(egg('x', 1, 2))}, undefined])`);
ok(stacks.length === 1 && stacks[0][0].id === 'x', 'null entries are skipped');
ok(run('_stackEggs([])').length === 0, 'empty input → empty output');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
