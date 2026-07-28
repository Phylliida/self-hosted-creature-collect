// Tests the eggs-view toolbar logic (static/creatures.js):
//   _filterSortEggs — name search, first/second species search, Either/
//   First/Second type filters, New/Fresh tag chips (OR semantics), and
//   the "New" / "Species" sort orders.
//
// Run: node tests/eggs-filter.test.js
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

const NAMES = { 1: 'Alpha', 2: 'Beta', 3: 'Gamma', 4: 'Delta', 5: 'Epsilon', 6: 'Zeta' };
const TYPES = { '1-4': ['FIRE'], '2-5': ['WATER', 'GRASS'], '3-6': ['FIRE', 'FLYING'] };
let captures = [];
let seen = {};
const ctx = {
  global: {
    Species: {
      nameFor: (i) => NAMES[i] || ('#' + i),
      fusionTypesFor: (a, b) => TYPES[`${a}-${b}`] || [],
    },
  },
  // isFusionOwned now routes through the captures store's O(1) index —
  // stub it against the fixture array.
  _capStore: { ownsFusion: (a, b) => captures.some((c) => c.speciesA === a && c.speciesB === b) },
  readCapturedCreatures: () => captures,
  readSeenFusions: () => seen,
  fusionName: (a, b) => `F${a}x${b}`,
  creatureName: () => 'Solo',
  creatureTypes: () => ['PLAIN'],
};
vm.createContext(ctx);
for (const m of ['function caughtFusionsSet', 'function isFusionOwned',
                 'function newFreshLabelFor', 'function _isSoloEgg',
                 'function _eggName', 'function _eggTypes',
                 'function _filterSortEggs']) {
  vm.runInContext(extract(m), ctx);
}
const call = (name, ...args) => { ctx.__a = args; return vm.runInContext(`${name}(...__a)`, ctx); };

// Fixture: e1 = New, e2 = Fresh (caught-away), e3 = owned, e4 = solo.
const E1 = { id: 'e1', speciesA: 1, speciesB: 4, createdAt: 100 };
const E2 = { id: 'e2', speciesA: 2, speciesB: 5, createdAt: 200 };
const E3 = { id: 'e3', speciesA: 3, speciesB: 6, createdAt: 300 };
const E4 = { id: 'e4', solo: 'neo:a', createdAt: 400 };
let eggs;
const ids = (arr) => arr.map((e) => e.id).join(',');
const run = (opts) => call('_filterSortEggs', eggs, Object.assign({ tags: [], sort: 'new' }, opts));

function reset() {
  eggs = [E1, E2, E3, E4];
  seen = { '2-5': { caught: true } };
  captures = [{ speciesA: 3, speciesB: 6 }];
}
const NONE = { name: '', qA: '', qB: '', type: '', typeA: '', typeB: '' };
const withOpts = (o) => Object.assign({}, NONE, o);

// ── A. name + species search ────────────────────────────────────
reset();
ok(ids(run(withOpts({ name: 'f1x' }))) === 'e1', 'A: name search matches fused name (case-insensitive)');
ok(ids(run(withOpts({ qA: 'alph' }))) === 'e1', 'A: first-species search matches slot A');
ok(ids(run(withOpts({ qB: 'eps' }))) === 'e2', 'A: second-species search matches slot B');
ok(ids(run(withOpts({ qA: 'a', qB: 'delt' }))) === 'e1', 'A: first+second combine (AND)');
ok(ids(run(withOpts({ qA: 'zz' }))) === '', 'A: no match → empty');
ok(!ids(run(withOpts({ qA: 'o' }))).includes('e4'), 'A: solo eggs never satisfy species filters');

// ── B. type filters ─────────────────────────────────────────────
reset();
ok(ids(run(withOpts({ type: 'FIRE' }))) === 'e1,e3', 'B: Either matches any slot');
ok(ids(run(withOpts({ typeA: 'WATER' }))) === 'e2', 'B: First matches the primary slot');
ok(ids(run(withOpts({ typeB: 'GRASS' }))) === 'e2', 'B: Second matches the secondary slot');
ok(ids(run(withOpts({ typeB: 'FIRE' }))) === '', 'B: single-typed egg has no Second');
ok(ids(run(withOpts({ type: 'FIRE', typeA: 'WATER' }))) === '', 'B: type filters combine (AND)');

// ── C. New/Fresh tag chips ──────────────────────────────────────
reset();
ok(ids(run(withOpts({ tags: ['New'] }))) === 'e1', 'C: New chip → only never-caught eggs');
ok(ids(run(withOpts({ tags: ['Fresh'] }))) === 'e2', 'C: Fresh chip → only caught-away eggs');
{
  const both = ids(run(withOpts({ tags: ['New', 'Fresh'] })));
  ok(both.includes('e1') && both.includes('e2') && !both.includes('e3') && !both.includes('e4'),
    'C: both chips → OR (every unowned pair egg), not the empty AND');
}

// ── D. sort orders ──────────────────────────────────────────────
reset();
ok(ids(run(withOpts({ sort: 'new' }))) === 'e1,e2,e4,e3',
  'D: New sort (default desc) → New, then Fresh, then the rest most-recent-first');
ok(ids(run(withOpts({ sort: 'new', dir: 'asc' }))) === 'e3,e4,e2,e1',
  'D: New sort asc → exact reverse (unbadged first, oldest first)');
ok(ids(run(withOpts({ sort: 'species', dir: 'asc' }))) === 'e1,e2,e3,e4',
  'D: Species sort asc → alphabetical by egg name');
ok(ids(run(withOpts({ sort: 'species', dir: 'desc' }))) === 'e4,e3,e2,e1',
  'D: Species sort desc (default) → reverse alphabetical');
{
  // Recent tiebreak inside the same badge group.
  const E5 = { id: 'e5', speciesA: 4, speciesB: 1, createdAt: 250 };   // also New
  eggs = [E1, E5, E2];
  seen = { '2-5': { caught: true } }; captures = [];
  ok(ids(run(withOpts({ sort: 'new' }))) === 'e5,e1,e2',
    'D: New sort tiebreaks by recency within a badge group');
  ok(ids(run(withOpts({ sort: 'new', dir: 'asc' }))) === 'e2,e1,e5',
    'D: New sort asc reverses the tiebreak too');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
