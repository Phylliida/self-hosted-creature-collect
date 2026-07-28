// Tests the egg "New"/"Fresh" overlay badge (static/creatures.js):
//   - newFreshLabelFor: '' when owned, "Fresh" when caught-but-evolved-away,
//     "New" otherwise — the same semantics as the encounter badge.
//   - _eggNewBadgeHtml: renders the pill for pair eggs, none for solo eggs
//     (and never the Art variants — an egg's art is unknown until hatching).
//
// Run: node tests/egg-new-badge.test.js
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

let captures = [];
let seen = {};
const ctx = {
  global: {},
  // isFusionOwned now routes through the captures store's O(1) index —
  // stub it against the fixture array.
  _capStore: { ownsFusion: (a, b) => captures.some((c) => c.speciesA === a && c.speciesB === b) },
  readCapturedCreatures: () => captures,
  readSeenFusions: () => seen,
};
vm.createContext(ctx);
for (const m of ['function caughtFusionsSet', 'function isFusionOwned',
                 'function newFreshLabelFor', 'function _isSoloEgg',
                 'function _eggNewBadgeHtml']) {
  vm.runInContext(extract(m), ctx);
}
const call = (name, ...args) => { ctx.__a = args; return vm.runInContext(`${name}(...__a)`, ctx); };

// ── A. label semantics ──────────────────────────────────────────
{
  captures = []; seen = {};
  ok(call('newFreshLabelFor', 1, 4) === 'New', 'A: never-caught fusion → New');

  seen = { '1-4': { caught: true } };
  ok(call('newFreshLabelFor', 1, 4) === 'Fresh', 'A: caught-then-evolved-away → Fresh');

  seen = { '1-4': {} };   // seen but never caught (e.g. fled encounter)
  ok(call('newFreshLabelFor', 1, 4) === 'New', 'A: seen-but-never-caught → New');

  captures = [{ speciesA: 1, speciesB: 4 }];
  seen = { '1-4': { caught: true } };
  ok(call('newFreshLabelFor', 1, 4) === '', 'A: currently owned → no label');

  ok(call('newFreshLabelFor', null, 4) === '' && call('newFreshLabelFor', 1, null) === '',
    'A: null species (solo) → no label');
}

// ── B. badge html ───────────────────────────────────────────────
{
  captures = []; seen = {};
  const html = call('_eggNewBadgeHtml', { speciesA: 1, speciesB: 4 });
  ok(/egg-new-badge/.test(html) && />New</.test(html), 'B: new fusion egg renders the New pill');

  seen = { '1-4': { caught: true } };
  ok(/>Fresh</.test(call('_eggNewBadgeHtml', { speciesA: 1, speciesB: 4 })),
    'B: caught-away fusion egg renders the Fresh pill');

  captures = [{ speciesA: 1, speciesB: 4 }];
  ok(call('_eggNewBadgeHtml', { speciesA: 1, speciesB: 4 }) === '',
    'B: owned fusion egg renders no pill');

  captures = []; seen = {};
  ok(call('_eggNewBadgeHtml', { solo: 'neo:a' }) === '',
    'B: solo (pack special) egg renders no pill');

  ok(!/Art/.test(call('_eggNewBadgeHtml', { speciesA: 2, speciesB: 5 })),
    'B: never an Art-variant badge on eggs');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
