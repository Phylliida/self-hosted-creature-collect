// Tests the daycare "i" odds popup math (_daycareOddsModel / _daycareOddsHtml
// in static/creatures.js) — that the shown probabilities match the actual loot
// model in _daycareLootAt for whatever is currently in the daycare.
//
// Run: node tests/daycare-odds.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

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

const NAMES = { 1: 'Bulbasaur', 4: 'Charmander', 7: 'Squirtle', 25: 'Pikachu', 26: 'Raichu' };
function build(slots, creatures) {
  const ctx = {
    Number, Set, Map, Array, Object, Math, String,
    DAYCARE_PROB_CANDY: 0.70, DAYCARE_PROB_EGG: 0.15, DAYCARE_LOOT_MILESTONE_M: 500,
    readDaycareSlots: () => slots,
    readNicknames: () => ({}),
    findCreature: (id) => creatures[id] || null,
    candyRootFor: (id) => (id === 26 ? 25 : id),   // Raichu → Pikachu root
    _eggRootFor: (id) => (id === 26 ? 25 : id),    // same here (no babies in this stub)
    speciesNameFor: (id) => NAMES[id] || ('#' + id),
    fusionName: (a, b) => (NAMES[a] || ('#' + a)) + '×' + (NAMES[b] || ('#' + b)),
    // Pikachu family (25/26) evolves via Thunder Stone; the others are level-only.
    _evoItemsForFamily: (id) => (id === 25 || id === 26) ? ['thunder_stone'] : [],
    ITEMS: { thunder_stone: { name: 'Thunder Stone' } },
    _formatItemName: (k) => k,
    escapeHtml: (s) => String(s),
    isFusionSeen: () => true,
    isFusionOwned: () => false,
  };
  vm.createContext(ctx);
  for (const fn of ['_fmtPct(', '_daycareOddsModel()', '_daycareOddsHtml()']) {
    vm.runInContext(extract('function ' + fn), ctx);
  }
  return {
    model: vm.runInContext('_daycareOddsModel()', ctx),
    html: vm.runInContext('_daycareOddsHtml()', ctx),
    pct: (x) => vm.runInContext('_fmtPct(__x)', Object.assign(ctx, { __x: x })),
  };
}

// ── 1. Two distinct slots; only one has an item evolution ──
{
  const { model, html } = build(
    [{ id: 'A', addedAt: 1 }, { id: 'B', addedAt: 2 }],
    {
      A: { id: 'A', name: 'AA', speciesA: 25, speciesB: 7 },   // Pikachu × Squirtle (Pikachu → Thunder Stone)
      B: { id: 'B', name: 'BB', speciesA: 4, speciesB: 1 },    // Charmander × Bulbasaur (no item evo)
    });
  ok(model.slots.length === 2, '1: two occupied slots');

  const s0 = model.slots[0];
  ok(close(s0.candyPct, 0.70) && close(s0.eggPct, 0.15) && close(s0.evoPct, 0.15), '1: slot with item-evo splits 70/15/15');
  ok(s0.candy.length === 2 && s0.candy[0].name === 'Pikachu' && close(s0.candy[0].pct, 0.35)
     && s0.candy[1].name === 'Squirtle' && close(s0.candy[1].pct, 0.35), '1: candy 50/50 of the 70% (0.35 each)');
  ok(s0.evo.length === 1 && s0.evo[0].name === 'Thunder Stone' && close(s0.evo[0].pct, 0.15), '1: single evo item takes the whole 15%');

  const s1 = model.slots[1];
  ok(close(s1.candyPct, 0.85) && s1.evoPct === 0 && s1.evo.length === 0, '1: no-item-evo pair → candy absorbs the evo 15% (85%)');
  ok(close(s1.candy[0].pct, 0.425) && close(s1.candy[1].pct, 0.425), '1: candy 50/50 of the 85% (0.425 each)');

  // Egg pools: F={25,4}, S={7,1}, U={25,4,7,1} → 4 naturals, 12 cross.
  ok(model.naturalPairs === 4 && model.crossPairs === 12, '1: 4 natural + 12 cross egg pairings');
  ok(model.eggContents.length === 16, '1: 16 distinct egg contents total');
  const sum = model.eggContents.reduce((t, e) => t + e.pct, 0);
  ok(close(sum, 1.0, 1e-9), '1: egg-content probabilities sum to 100%');
  const nat = model.eggContents.filter((e) => e.natural);
  const cross = model.eggContents.filter((e) => !e.natural);
  ok(nat.length === 4 && nat.every((e) => close(e.pct, 0.7 / 4)), '1: each natural pairing is 70%/4 = 17.5%');
  ok(cross.length === 12 && cross.every((e) => close(e.pct, 0.3 / 12)), '1: each cross pairing is 30%/12 = 2.5%');
  const pikaSquirt = model.eggContents.find((e) => e.name === 'Pikachu×Squirtle');
  ok(pikaSquirt && pikaSquirt.natural && close(pikaSquirt.pct, 0.175), '1: Pikachu×Squirtle is a 17.5% natural');
  ok(model.eggContents[0].pct >= model.eggContents[model.eggContents.length - 1].pct, '1: contents sorted high→low');

  ok(html.indexOf('Egg 15%') >= 0 && html.indexOf('Candy 70%') >= 0 && html.indexOf('Pikachu×Squirtle') >= 0,
     '1: popup HTML renders the split + an egg pairing');
  ok(html.indexOf('become extra candy') >= 0, '1: HTML notes the no-item slot folds evo into candy');
}

// ── 2. Single pure fusion (Raichu×Raichu) — root collapse, no cross pairs ──
{
  const { model } = build(
    [{ id: 'A', addedAt: 1 }],
    { A: { id: 'A', name: 'R', speciesA: 26, speciesB: 26 } });   // both roots → Pikachu
  ok(model.slots.length === 1, '2: one occupied slot');
  const s = model.slots[0];
  ok(s.candy.length === 1 && s.candy[0].name === 'Pikachu' && close(s.candy[0].pct, 0.70),
     '2: same-root pair → 100% of the 70% is one candy');
  ok(close(s.evoPct, 0.15) && s.evo[0].name === 'Thunder Stone', '2: Raichu family still has the item evo');
  ok(model.eggContents.length === 1 && model.eggContents[0].name === 'Pikachu×Pikachu'
     && close(model.eggContents[0].pct, 1.0) && model.eggContents[0].natural,
     '2: only pairing possible → egg is Pikachu×Pikachu 100%');
  ok(model.naturalPairs === 1 && model.crossPairs === 0, '2: 1 natural, 0 cross');
}

// ── 3. Empty daycare ──
{
  const { model, html } = build([], {});
  ok(model.empty === true, '3: empty daycare reports empty');
  ok(html.indexOf('Put a pokémon in the daycare') >= 0, '3: empty popup prompts the user to add one');
}

// ── 4. Percent formatter ──
{
  const { pct } = build([], {});
  ok(pct(0.7) === '70%' && pct(0.15) === '15%' && pct(0.425) === '42.5%' && pct(0.3 / 12) === '2.5%',
     '4: _fmtPct trims whole numbers and keeps one decimal');
}

// ── 5. _eggRootFor: eggs hatch the family ROOT (the baby when it's in the
//       pack's dataset), unlike candyRootFor which skips babies ──
{
  const ctx = {
    Number, Set, Map, Array, Object, Math, String,
    global: {
      Species: {
        // IF2-style chains: Munchlax(446)→Snorlax(143), Pichu(172)→Pikachu(25)→Raichu(26)
        familyOf: (id) => ({ 143: [446, 143], 26: [172, 25, 26], 25: [172, 25], 1: [1] })[id] || [id],
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(extract('function _eggRootFor('), ctx);
  const rootOf = (id) => vm.runInContext(`_eggRootFor(${id})`, ctx);
  ok(rootOf(143) === 446, '5: Snorlax egg → Munchlax (baby in dataset)');
  ok(rootOf(26) === 172 && rootOf(25) === 172, '5: Raichu/Pikachu egg → Pichu');
  ok(rootOf(1) === 1, '5: baby-less family root is itself');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
