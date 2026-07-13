// Tests bag item ordering (_bagEntryRank / _sortedBagEntries in
// static/creatures.js): incense first, then evolution items, then poké
// balls, then anything else — with count-desc / name-asc inside a category.
//
// Run: node tests/bag-sort.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

// comment-aware brace extractor (same approach as tests/daycare-odds.test.js)
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

// Representative catalog: incense (has incenseType), evo items (in
// EVO_ITEM_SET), balls (have catchShakeRate), and a placeholder "other".
const ITEMS = {
  poke_ball: { name: 'Poké Ball', catchShakeRate: 0.8879 },
  great_ball: { name: 'Great Ball', catchShakeRate: 0.9655 },
  test_orb: { name: 'Test Orb' },
  THUNDERSTONE: { name: 'Thunder Stone' },
  FIRESTONE: { name: 'Fire Stone' },
  incense_fire: { name: 'Fire Incense', incenseType: 'FIRE' },
  incense_water: { name: 'Water Incense', incenseType: 'WATER' },
};
const EVO_ITEM_SET = new Set(['THUNDERSTONE', 'FIRESTONE']);

const ctx = { Object, Set, Array, Math, String, Number, ITEMS, EVO_ITEM_SET };
vm.createContext(ctx);
vm.runInContext(extract('function _bagEntryRank('), ctx);
vm.runInContext(extract('function _sortedBagEntries('), ctx);
const rank = (k) => vm.runInContext('_bagEntryRank(__k)', Object.assign(ctx, { __k: k }));
const sorted = (bag) => vm.runInContext('_sortedBagEntries(__bag)', Object.assign(ctx, { __bag: bag }));

// ── 1. Category ranks ──
ok(rank('incense_fire') === 0, '1: incense is rank 0');
ok(rank('THUNDERSTONE') === 1, '1: evo item is rank 1');
ok(rank('poke_ball') === 2, '1: poké ball is rank 2');
ok(rank('test_orb') === 3, '1: other item is rank 3');
ok(rank('totally_unknown_key') === 3, '1: unknown key falls to rank 3');

// ── 2. Full ordering across categories ──
{
  const entries = sorted({
    poke_ball: 5,
    incense_water: 1,
    THUNDERSTONE: 2,
    test_orb: 3,
    incense_fire: 1,
    FIRESTONE: 2,
    great_ball: 10,
    incense_grass: 0,   // zero count → dropped
  });
  const keys = entries.map(([k]) => k);
  ok(JSON.stringify(keys) === JSON.stringify([
    'incense_fire', 'incense_water',   // incense: same count → name asc
    'FIRESTONE', 'THUNDERSTONE',       // evo: same count → name asc (Fire < Thunder)
    'great_ball', 'poke_ball',         // balls: count desc (10 > 5)
    'test_orb',                        // other, last
  ]), '2: ordered incense → evo → balls → other, tiebroken by count then name');
  ok(!keys.includes('incense_grass'), '2: zero-count entry filtered out');
}

// ── 3. Count-desc dominates name within a category ──
{
  const entries = sorted({ incense_water: 9, incense_fire: 1 });
  ok(entries[0][0] === 'incense_water', '3: higher count sorts first despite later name');
}

// ── 4. Empty / all-zero bag → no entries ──
{
  ok(sorted({}).length === 0, '4: empty bag yields no entries');
  ok(sorted({ poke_ball: 0, THUNDERSTONE: 0 }).length === 0, '4: all-zero bag yields no entries');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
