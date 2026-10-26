// Daycare reward pills stack (static/creatures.js _daycareLootStacks /
// _daycareLootPillHtml): the same candy or evolution item earned more than
// once shows as ONE pill with a ×N badge that claims them all; eggs never
// stack (each egg has its own size).
//
// Run: node tests/daycare-loot-stack.test.js
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

const ctx = {
  _lootIconStyle: () => 'background:x',
  escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
};
vm.createContext(ctx);
for (const m of ['function _daycareLootStackKey(', 'function _daycareLootStacks(',
                 'function _daycareLootCountHtml(', 'function _daycareLootPillHtml(']) {
  vm.runInContext(extract(m), ctx);
}
const call = (name, ...args) => { ctx.__a = args; return vm.runInContext(`${name}(...__a)`, ctx); };

const candy1 = { kind: 'candy', species: 1, label: 'Bulbasaur candy' };
const candy4 = { kind: 'candy', species: 4, label: 'Charmander candy' };
const soloC = { kind: 'candy', solo: 'neo:a', label: 'Glitch candy' };
const stone = { kind: 'evo_item', itemKey: 'FIRESTONE', label: 'Fire Stone' };
const egg = (sz) => ({ kind: 'egg', speciesA: 1, speciesB: 4, sizeM: sz, label: 'Egg' });
const visible = [
  { n: 1, loot: candy1 }, { n: 2, loot: egg(0.5) }, { n: 3, loot: candy1 },
  { n: 4, loot: stone }, { n: 5, loot: candy4 }, { n: 6, loot: egg(0.5) },
  { n: 7, loot: candy1 }, { n: 8, loot: stone }, { n: 9, loot: soloC },
];
const stacks = call('_daycareLootStacks', visible);
const shape = stacks.map((s) => s.loot.kind + '[' + s.ns.join(',') + ']').join(' ');
ok(shape === 'candy[1,3,7] egg[2] evo_item[4,8] candy[5] egg[6] candy[9]',
  'same candy / same item stack in first-earned order; eggs stay separate (' + shape + ')');

const html1 = call('_daycareLootPillHtml', [1, 3, 7], candy1);
ok(/data-ns="1,3,7"/.test(html1) && /data-n="1"/.test(html1), 'stacked pill carries every milestone');
ok(/class="daycare-loot-count"[^>]*>3&times;</.test(html1), 'stacked pill shows a 3× badge');
ok(/aria-label="claim 3× Bulbasaur candy"/.test(html1), 'aria label says how many');
ok(/data-key="candy:1"/.test(html1), 'pill carries its stack key (live ticks join it)');
const htmlEgg = call('_daycareLootPillHtml', [2], egg(0.5));
ok(!/daycare-loot-count/.test(htmlEgg) && !/data-key/.test(htmlEgg), 'a single egg: no badge, no stack key');
ok(!/daycare-loot-count/.test(call('_daycareLootPillHtml', [5], candy4)), 'a single candy: no badge');

// The click handler claims every milestone in data-ns.
const click = extract('function _onPillClick(');
ok(/pill\.dataset\.ns \|\| pill\.dataset\.n/.test(click) && /for \(const n of ns\) if \(claimDaycareLoot\(slotId, n\)\)/.test(click),
  'tapping a stacked pill claims all of its milestones');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
