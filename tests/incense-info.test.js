// Tests the incense explainer + type-chart explorer helpers in
// static/creatures.js:
//   _typeStrongAgainst  (inverse of the offensive chart — "best egg types")
//   _typeDetailHtml     (one type's strong/weak/best-eggs card)
//   _incenseInfoHtml    (the "How incense works" copy)
//   _typeChartHtml      (the type picker grid + selected detail)
//
// Run: node tests/incense-info.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

// comment-aware brace extractor (same approach as tests/bag-sort.test.js)
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

// Type colors / chart come from the single source of truth — no more
// inline mirrors here (they used to duplicate creatures.js's constants,
// which now just delegate to global.Types).
require(path.join(__dirname, '..', 'static', 'types.js'));
const Types = globalThis.Types;
const ALL_TYPES = Types.list();

const ctx = {
  Object, Set, Array, Math, String, Number, JSON,
  global: { Types },                // _incenseDurationMs falls back to 30 min
  ALL_TYPES,
  _typeChartSel: null, _craftState: { step: 1, type: null, eggId: null },
};
vm.createContext(ctx);
for (const m of [
  'function escapeHtml(',
  'function _incenseDurationMs(',
  'function _ccTypeChip(',
  'function _ccTypeChips(',
  'function _typeDetailHtml(',
  'function _incenseInfoHtml(',
  'function _typeChartHtml(',
]) vm.runInContext(extract(m), ctx);

const call = (expr, extra) => vm.runInContext(expr, Object.assign(ctx, extra || {}));

// ── 1. Inverse offensive lookup = "best egg types for this incense" ──
ok(JSON.stringify(Types.strongAgainst('FIRE')) === JSON.stringify(['WATER', 'GROUND', 'ROCK']),
  '1: types super-effective vs Fire are Water/Ground/Rock (registry order)');
ok(JSON.stringify(Types.strongAgainst('NORMAL')) === JSON.stringify(['FIGHTING']),
  '1: only Fighting is super-effective vs Normal');
ok(Types.strongAgainst('GHOST').indexOf('DARK') >= 0,
  '1: Dark is super-effective vs Ghost');

// ── 2. Type detail card ──
{
  const fire = call('_typeDetailHtml("FIRE")');
  ok(/cc-typedetail-name">Fire</.test(fire), '2: detail card names the type');
  ok(fire.indexOf('Grass') >= 0 && fire.indexOf('Steel') >= 0,
    '2: Fire super-effective block lists Grass/Steel');
  ok(fire.indexOf('Best eggs for Fire Incense') >= 0, '2: has crafting-oriented best-eggs block');
  ok(fire.indexOf('Water') >= 0, '2: best-eggs block surfaces Water (strong vs Fire)');
  const normal = call('_typeDetailHtml("NORMAL")');
  ok(normal.indexOf('cc-tdb-none') >= 0, '2: Normal has no super-effective matchup → "none"');
}

// ── 3. Incense explainer copy ──
{
  const h = call('_incenseInfoHtml()');
  ok(h.indexOf('~30 min') >= 0, '3: mentions the 30-minute window');
  ok(h.indexOf('2×') >= 0, '3: mentions 2× (shiny / yield)');
  ok(h.indexOf('+50%') >= 0, '3: mentions the ~+50% extra spawns');
  ok(h.indexOf('40%') >= 0 && h.indexOf('30%') >= 0, '3: shows the 40/30/30 other-half split');
  ok(h.indexOf('cc-open-typechart') >= 0, '3: includes the "see the type chart" launcher');
}

// ── 4. Type chart grid ──
{
  const h = call('_typeChartHtml()', { _typeChartSel: 'WATER' });
  const btnCount = (h.match(/data-type="/g) || []).length;
  ok(btnCount === 18, '4: renders a button for every one of the 18 types');
  ok(/data-type="WATER" class="sel"/.test(h), '4: the selected type is marked .sel');
  ok(h.indexOf('cc-typedetail') >= 0, '4: embeds the selected type\'s detail card');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
