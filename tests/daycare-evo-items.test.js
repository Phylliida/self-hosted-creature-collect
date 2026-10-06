// Tests _evoItemsForFamily in static/creatures.js against the REAL bundled
// species-evolutions.json — the daycare evo-item loot pool must offer every
// item the family can actually evolve with, including the TradeItem and
// DayHoldItem methods (Clamperl's Deep Sea items, Happiny's Oval Stone),
// not just rows with method === 'Item'.
//
// Run: node tests/daycare-evo-items.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

// comment-aware brace extractor (same approach as tests/guaranteed-catch.test.js)
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

const evos = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'data', 'BundledData', 'species-evolutions.json'), 'utf8'));

// Raw-data guard: the assertions below only exercise the original bug as
// long as the bundle still carries the row it was about.
ok(Array.isArray(evos['259']) &&
   evos['259'].some((e) => e[0] === 113 && e[1] === 'DayHoldItem' && e[2] === 'OVALSTONE'),
   'raw data: 259 (Happiny) still evolves to 113 via [DayHoldItem, OVALSTONE]');

// familyOf mirrors static/species.js's Species.familyOf (static/species.js:224):
// reverse "who evolves into me" index, walk parents to the root, BFS forward.
function buildSpecies(evolutions) {
  const rev = Object.create(null);
  for (const srcId of Object.keys(evolutions)) {
    for (const e of evolutions[srcId]) {
      const tgt = String(e[0]);
      if (!rev[tgt]) rev[tgt] = [];
      rev[tgt].push(+srcId);
    }
  }
  function evolutionsFor(idx) {
    const raw = evolutions[String(idx)];
    if (!Array.isArray(raw)) return [];
    return raw.map((e) => ({ target: e[0], method: e[1], param: e[2] }));
  }
  function familyOf(idx) {
    let cur = idx;
    const seen = new Set([cur]);
    while (true) {
      const pre = rev[String(cur)];
      if (!pre || !pre.length) break;
      const prev = pre[0];
      if (seen.has(prev)) break;
      seen.add(prev);
      cur = prev;
    }
    const family = [];
    const visited = new Set();
    const queue = [cur];
    while (queue.length) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      family.push(id);
      for (const e of evolutionsFor(id)) queue.push(e.target);
    }
    return family;
  }
  return { familyOf, evolutionsFor };
}

const ctx = {
  Number, Set, Map, Array, Object, Math, String,
  global: { Species: buildSpecies(evos) },
};
vm.createContext(ctx);
// _EVO_ITEM_METHODS is a one-line `const ... ;` the brace extractor can't
// grab, so slice from the marker to the first ';' after it.
const mi = src.indexOf('const _EVO_ITEM_METHODS');
if (mi < 0) throw new Error('marker not found: const _EVO_ITEM_METHODS');
vm.runInContext(src.slice(mi, src.indexOf(';', mi) + 1), ctx);
vm.runInContext(extract('function _evoItemsForFamily('), ctx);
const poolFor = (id) => vm.runInContext(`_evoItemsForFamily(${id})`, ctx);

const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

// Original-bug regression guard: Happiny → Chansey is the only DayHoldItem
// evolution in the bundled data; method === 'Item' filtering left this
// family's daycare evo-item pool empty. Every family member must surface it.
ok(same(poolFor(259), ['OVALSTONE']), '259 (Happiny) → [OVALSTONE] — the original DayHoldItem bug');
ok(same(poolFor(113), ['OVALSTONE']), '113 (Chansey) → [OVALSTONE] via family walk');
ok(same(poolFor(242), ['OVALSTONE']), '242 (Blissey) → [OVALSTONE] via family walk');

// Clamperl's two TradeItem branches (also excluded by the old filter)
// both surface, order-insensitively.
ok(same(poolFor(562), ['DEEPSEATOOTH', 'DEEPSEASCALE']),
   '562 (Clamperl) → both Deep Sea items (TradeItem)');

// A level-only family contributes no evo items.
ok(poolFor(1).length === 0, '1 (Bulbasaur, level-only family) → empty pool');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
