// Completion list + species dex: name/type search and the Summary popup
// (static/creatures.js).
//   1. The views carry the search field, the Either/First/Second type
//      selects and a Summary button, and the view stack snapshots and
//      restores those filters.
//   2. _typesPassFilter — the pokédex's Either / First / Second rule.
//   3. _completionTypeSummary — per species type: species complete and
//      fusions seen, legendaries skipped.
//   4. _speciesDexPairs + _fusionTypeSummary — a species dex's fusions
//      (the set its % counts) grouped by fusion type.
//   5. _artTally — art counted like the fusion view's art grid.
//   7. The Incense sort: chance one incense spawn of a type is an unseen
//      fusion in scope (Spawns.incensePairOdds is checked against the
//      generator in tests/incense-odds.test.js).
//   6. The by-type sort (Type / % / Seen / Left, tap again to reverse)
//      and the completion list's per-type fusion counts (each fusion
//      once per type, so the numbers it shows and sorts by are real).
//
// Run: node tests/completion-summary.test.js
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

// ── 1. Markup + wiring ──
for (const view of ['completion', 'speciesdex']) {
  for (const id of ['Search', 'FilterType', 'FilterTypeA', 'FilterTypeB']) {
    ok(src.includes(`'${view}${id}'`) || src.includes(`id="${view}${id}"`), `1: ${view} has #${view}${id}`);
  }
  ok(src.includes(`class="${view}-summary-btn"`), `1: ${view} has a Summary button`);
  ok(src.includes(`_applyDexFilters(panel, '${view}', top.filters || null)`),
    `1: applyTopView restores ${view} filters (fresh push clears the name)`);
}
ok(/_captureDexFilters\(panel, top\.view\)/.test(extract('function _captureCurrentFilters(')),
  '1: pushView snapshots the name/type filters with the non-evolved toggle');
ok(/_typesPassFilter\(_speciesTypes\(r\.id\)/.test(extract('function renderCompletion(')),
  '1: the completion list filters on the species\' own types');
ok(/_typesPassFilter\(fusionTypesFor\(a, b\)/.test(extract('function renderSpeciesDex(')),
  '1: a species dex filters on each fusion\'s types');
ok(!/isFusionSeen\(/.test(extract('function renderSpeciesDex(')),
  '1: renderSpeciesDex reads the seen map once (isFusionSeen re-reads it per call)');

// ── 2. Either / First / Second ──
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(extract('function _typesPassFilter('), ctx);
  const pass = (types, t, a, b) => vm.runInContext('_typesPassFilter(__ty, __t, __a, __b)',
    Object.assign(ctx, { __ty: types, __t: t, __a: a, __b: b }));
  ok(pass(['WATER'], '', '', '') === true, '2: no filter passes');
  ok(pass([], '', '', '') === true, '2: no filter passes even without type data');
  ok(pass(['WATER', 'FLYING'], 'FLYING', '', '') === true, '2: Either matches the second type');
  ok(pass(['WATER', 'FLYING'], '', 'FLYING', '') === false, '2: First is the first type only');
  ok(pass(['WATER', 'FLYING'], '', 'WATER', 'FLYING') === true, '2: First + Second together');
  ok(pass(['WATER'], '', '', 'WATER') === false, '2: a single-typed entry has no second type');
  ok(pass([], 'WATER', '', '') === false, '2: no type data fails an active filter');
}

// ── 3. Completion list per type ──
{
  const TYPES = { 1: ['GRASS', 'POISON'], 4: ['FIRE'], 7: ['WATER'], 150: ['PSYCHIC'] };
  const ctx = { Map, Set, _speciesTypes: (id) => TYPES[id] || [] };
  vm.createContext(ctx);
  vm.runInContext(extract('function _completionTypeSummary('), ctx);
  const rows = [
    { id: 1, seen: 10, total: 10, legendary: false },
    { id: 4, seen: 3, total: 10, legendary: false },
    { id: 7, seen: 10, total: 10, legendary: false },
    { id: 150, seen: 1, total: 10, legendary: true },
  ];
  const m = vm.runInContext('_completionTypeSummary(__r)', Object.assign(ctx, { __r: rows }));
  const g = (t) => m.get(t) || null;
  ok(g('GRASS') && g('GRASS').done === 1 && g('GRASS').count === 1, '3: Grass 1/1 complete');
  ok(g('POISON') && g('POISON').done === 1, '3: a dual type counts toward both types');
  ok(g('FIRE') && g('FIRE').done === 0 && g('FIRE').count === 1 && g('FIRE').seen === 3 && g('FIRE').total === 10,
    '3: Fire 0/1 complete, 3/10 fusions seen');
  ok(!m.has('PSYCHIC'), '3: legendaries are left out (as in the headline)');
}

// ── 4. Species dex pairs + per fusion type ──
{
  const POOL = [1, 2, 3, 150];
  const ctx = {
    Map, Set, Object,
    supportedSpeciesSorted: () => POOL,
    _isEvolvedSpecies: (id) => id === 2,
    isLegendarySpecies: (id) => id === 150,
    // fusion types: head = b's first type, body = a's
    fusionTypesFor: (a, b) => (a === b ? ['GRASS'] : [b === 3 ? 'FIRE' : 'GRASS', 'POISON']),
  };
  vm.createContext(ctx);
  vm.runInContext(extract('function _speciesDexPairs('), ctx);
  vm.runInContext(extract('function _fusionTypeSummary('), ctx);
  const pairs = vm.runInContext('_speciesDexPairs(1, false)', ctx);
  ok(pairs.length === 6, `4: partners 1,2,3 (not the legendary) → 6 fusions (got ${pairs.length})`);
  ok(vm.runInContext('_speciesDexPairs(1, true)', ctx).length === 4, '4: non-evolved toggle drops partner 2');
  const seen = { '1-3': {}, '3-1': {}, '1-1': {} };
  const m = vm.runInContext('_fusionTypeSummary(__p, __s)', Object.assign(ctx, { __p: pairs, __s: seen }));
  ok(m.get('FIRE') && m.get('FIRE').total === 1 && m.get('FIRE').seen === 1, '4: Fire: 1 fusion, seen');
  // pairs: 1×1 (both columns), 1-2, 2-1, 1-3, 3-1; seen 1-1, 1-3, 3-1.
  ok(m.get('POISON') && m.get('POISON').total === 4 && m.get('POISON').seen === 2,
    `4: Poison: 1-2, 2-1, 1-3, 3-1 → 2 of 4 seen (got ${JSON.stringify(m.get('POISON'))})`);
  ok(m.get('GRASS') && m.get('GRASS').total === 5 && m.get('GRASS').seen === 3,
    `4: Grass: the self-fusion in both columns + 1-2, 2-1, 3-1 → 3 of 5 seen (got ${JSON.stringify(m.get('GRASS'))})`);
}

// ── 5. Art ──
{
  const owned = new Set(['5-6']);
  const capVariants = { '5-6': ['1'], '1-2': ['2'] };
  const ctx = {
    Object, Set, parseInt,
    isFusionOwned: (a, b) => owned.has(`${a}-${b}`),
    _capStore: { variantKeysForFusion: (a, b) => new Set(capVariants[`${a}-${b}`] || []) },
  };
  vm.createContext(ctx);
  vm.runInContext(extract('function _artTally('), ctx);
  const counts = new Map([['1-2', 3], ['5-6', 2], ['8-9', 4]]);
  const seenMap = {
    '1-2': { variants: { 0: 1, auto: 1, 7: 1 } },   // seen 0; 7 is out of range; caught 2
    '3-4': {},                                       // no custom art → its autogen counts
  };
  const tally = (pairs) => vm.runInContext('_artTally(__p, __c, __s)',
    Object.assign(ctx, { __p: pairs, __c: counts, __s: seenMap }));
  let t = tally([[1, 2]]);
  ok(t.seen === 2 && t.total === 3, `5: 3 variants, seen 0 + caught 2 → 2/3 (got ${t.seen}/${t.total})`);
  t = tally([[3, 4]]);
  ok(t.seen === 1 && t.total === 1, '5: a seen fusion with no custom art → its autogen, 1/1');
  t = tally([[10, 11]]);
  ok(t.seen === 0 && t.total === 1, '5: an unseen fusion with no custom art → 0/1');
  t = tally([[5, 6]]);
  ok(t.seen === 1 && t.total === 2, '5: caught but missing from the seen map → its caught variant counts');
  t = tally([[8, 9]]);
  ok(t.seen === 0 && t.total === 4, '5: unseen with 4 variants → 0/4');
  t = tally([[1, 2], [3, 4], [10, 11], [5, 6], [8, 9]]);
  ok(t.seen === 4 && t.total === 11, `5: totals add up (got ${t.seen}/${t.total})`);
}

// ── 6. By-type sort + per-type fusion counts ──
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(extract('function _sortTypeEntries('), ctx);
  const E = [
    { t: 'NORMAL', seen: 5, total: 10 },   // 50%, 5 left
    { t: 'FIRE', seen: 9, total: 30 },     // 30%, 21 left
    { t: 'WATER', seen: 2, total: 4 },     // 50%, 2 left
    { t: 'GRASS', seen: 0, total: 8 },     // 0%, 8 left
  ];
  const order = (k, dir) => vm.runInContext('_sortTypeEntries(__e, __s)',
    Object.assign(ctx, { __e: E, __s: { k, dir } })).map((e) => e.t).join(',');
  ok(order('type', 'asc') === 'NORMAL,FIRE,WATER,GRASS', '6: Type keeps type order');
  ok(order('type', 'desc') === 'GRASS,WATER,FIRE,NORMAL', '6: Type reversed');
  ok(order('pct', 'desc') === 'NORMAL,WATER,FIRE,GRASS', '6: % high → low, ties in type order (got ' + order('pct', 'desc') + ')');
  ok(order('pct', 'asc') === 'GRASS,FIRE,NORMAL,WATER', '6: % low → high');
  ok(order('seen', 'desc') === 'FIRE,NORMAL,WATER,GRASS', '6: Seen most → fewest');
  ok(order('left', 'asc') === 'WATER,NORMAL,GRASS,FIRE', '6: Left fewest → most');
  ok(order('left', 'desc') === 'FIRE,GRASS,NORMAL,WATER', '6: Left reversed');
  ok(E.map((e) => e.t).join(',') === 'NORMAL,FIRE,WATER,GRASS', '6: the input list is not reordered in place');

  const sortSrc = extract('function _showCompletionSummary(');
  ok(/chipBtn\('pct', '%'\)/.test(sortSrc) && /chipBtn\('seen', 'Seen'\)/.test(sortSrc)
    && /chipBtn\('left', 'Left'\)/.test(sortSrc), '6: the popup has %, Seen and Left sort chips');
  ok(/k === cur\.k\s*\?\s*\{ k, dir: cur\.dir === 'asc' \? 'desc' : 'asc' \}/.test(sortSrc),
    '6: tapping the active chip reverses the direction');

  const TYPES = { 1: ['WATER'], 2: ['WATER', 'FLYING'], 3: ['FIRE'], 4: ['GRASS'] };
  const c2 = { Map, Set, Array, Object, _speciesTypes: (id) => TYPES[id] || [] };
  vm.createContext(c2);
  vm.runInContext(extract('function _listedTypeFusionCounts('), c2);
  const counts = (nonleg, listed, seen) => vm.runInContext('_listedTypeFusionCounts(__n, __l, __s)',
    Object.assign(c2, { __n: new Set(nonleg), __l: new Set(listed), __s: seen }));
  // non-legendary {1,2,3,4}; listed {1,2,3} (4 is e.g. evolved and hidden)
  const m = counts([1, 2, 3, 4], [1, 2, 3], { '1-2': {}, '3-3': {}, '2-4': {}, '5-1': {}, 'solo:x': {} });
  const g = (t) => JSON.stringify(m.get(t) || null);
  ok(g('WATER') === JSON.stringify({ seen: 2, total: 12 }),
    '6: Water: 12 fusions with 1 or 2 in a half; 1-2 and 2-4 seen, 1-2 once (got ' + g('WATER') + ')');
  ok(g('FLYING') === JSON.stringify({ seen: 2, total: 7 }), '6: Flying (got ' + g('FLYING') + ')');
  ok(g('FIRE') === JSON.stringify({ seen: 1, total: 7 }), '6: Fire: 3-3 once (got ' + g('FIRE') + ')');
  ok(!m.has('GRASS'), '6: an unlisted species adds no type of its own');

  // The 2kn − k² totals and the seen counts match a brute-force walk.
  {
    const T = ['WATER', 'FIRE', 'GRASS', 'FLYING'];
    const ids = Array.from({ length: 14 }, (_, i) => i + 1);
    for (const id of ids) TYPES[id] = [T[id % 4]].concat(id % 3 ? [T[(id + 1) % 4]] : []);
    const listed = ids.filter((id) => id % 5);
    const seen = {};
    for (const a of ids) for (const b of ids) if ((a * 7 + b * 3) % 4 === 0) seen[a + '-' + b] = {};
    const want = new Map();
    for (const a of ids) for (const b of ids) {
      const ts = new Set();
      if (listed.includes(a)) TYPES[a].forEach((t) => ts.add(t));
      if (listed.includes(b)) TYPES[b].forEach((t) => ts.add(t));
      for (const t of ts) {
        const e = want.get(t) || { seen: 0, total: 0 };
        e.total++; if (seen[a + '-' + b]) e.seen++;
        want.set(t, e);
      }
    }
    const got = counts(ids, listed, seen);
    ok(T.every((t) => JSON.stringify(got.get(t)) === JSON.stringify(want.get(t))),
      '6: per-type fusion counts match a brute-force walk of every pair');
  }
}

// ── 7. Incense ──
{
  // Two blocks: 75% body ∈ {1,2} × head ∈ {10}; 25% body ∈ {3} × head ∈ {10,11}.
  const BLOCKS = { FIRE: [
    { p: 0.75, bodies: [1, 2], heads: [10] },
    { p: 0.25, bodies: [3], heads: [10, 11] },
  ] };
  const ctx = { global: { Spawns: { incensePairOdds: (t) => BLOCKS[t] || [] } } };
  vm.createContext(ctx);
  vm.runInContext(extract('function _incenseNewChance('), ctx);
  vm.runInContext(extract('function _fmtChance('), ctx);
  const chance = (t, scope, seen) => vm.runInContext('_incenseNewChance(__t, __in, __s, 0)',
    Object.assign(ctx, { __t: t, __in: scope, __s: new Set(seen.map(([a, b]) => a * 65536 + b)) }));
  const all = () => true;
  ok(chance('FIRE', all, []) === 1, '7: nothing seen → every spawn is new');
  ok(Math.abs(chance('FIRE', all, [[1, 10]]) - (0.75 * 0.5 + 0.25)) < 1e-12, '7: seeing 1-10 halves the first block');
  ok(Math.abs(chance('FIRE', all, [[1, 10], [2, 10], [3, 10]]) - 0.125) < 1e-12, '7: only 3-11 left → 25% × ½');
  ok(Math.abs(chance('FIRE', (a, b) => a === 3, []) - 0.25) < 1e-12, '7: out-of-scope fusions never count as new');
  ok(chance('WATER', all, []) === 0, '7: a type that can\'t spawn → 0');
  const fmt = (p) => vm.runInContext('_fmtChance(__p)', Object.assign(ctx, { __p: p }));
  ok(fmt(0) === '0%' && fmt(0.00005) === '<0.01%' && fmt(0.0024) === '0.24%'
    && fmt(0.0234) === '2.3%' && fmt(0.456) === '46%', '7: chance formatting');

  const c3 = {};
  vm.createContext(c3);
  vm.runInContext(extract('function _sortTypeEntries('), c3);
  const E = [{ t: 'A', incense: 0.1 }, { t: 'B', incense: 0.3 }, { t: 'C', incense: 0.2 }];
  const order = (dir) => vm.runInContext('_sortTypeEntries(__e, __s)',
    Object.assign(c3, { __e: E, __s: { k: 'incense', dir } })).map((e) => e.t).join('');
  ok(order('desc') === 'BCA' && order('asc') === 'ACB', '7: Incense sorts by the chance, either way');
  ok(/chipBtn\('incense', 'Incense'\)/.test(extract('function _showCompletionSummary(')),
    '7: the popup has an Incense chip');
  ok(/incense: 'desc'/.test(src), '7: Incense starts with the best type first');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
