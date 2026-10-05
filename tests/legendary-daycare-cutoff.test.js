// Tests the legendary daycare cutoff in static/creatures.js (2026-10-05):
// legendaries hatched from eggs BEFORE the bad-egg rule shipped may be
// legendary × non-legendary fusions — a pairing the daycare now forbids —
// so they can't be placed back in. Wild-caught legendaries are unaffected.
//
//   - _legendaryTooOldForDaycare predicate semantics;
//   - the cutoff constant matches 2026-10-05T00:00:00-07:00;
//   - the Daycare built-in tag hides/refuses via the predicate;
//   - getInventoryCreatures carries fromEgg + caughtAt (the normalized
//     object is what tag predicates see — a dropped field silently
//     disables the rule).
//
// Run: node tests/legendary-daycare-cutoff.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'static', 'creatures.js'), 'utf8');
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

// ── 1. the constant is the intended instant ──────────────────────
const CUTOFF = Number((src.match(/const LEGENDARY_DAYCARE_CUTOFF_MS = (\d+)/) || [])[1]);
ok(CUTOFF === 1791183600000, '1: LEGENDARY_DAYCARE_CUTOFF_MS parsed from source');
ok(CUTOFF === Date.parse('2026-10-05T00:00:00-07:00'),
  '1: cutoff is 2026-10-05T00:00:00-07:00 (Pacific, game time)');

// ── 2. predicate semantics ───────────────────────────────────────
const LEG = new Set([150, 151]);
const ctx = {
  Number, Math,
  isLegendarySpecies: (id) => LEG.has(id),
  LEGENDARY_DAYCARE_CUTOFF_MS: CUTOFF,
};
vm.createContext(ctx);
vm.runInContext(extract('function _legendaryTooOldForDaycare('), ctx);
const pred = (c) => vm.runInContext('_legendaryTooOldForDaycare(__c)', Object.assign(ctx, { __c: c }));

ok(pred({ speciesA: 150, speciesB: 25, fromEgg: true, caughtAt: { timestamp: CUTOFF - 1 } }) === true,
  '2: hatched legendary caught just before the cutoff → blocked');
ok(pred({ speciesA: 25, speciesB: 150, fromEgg: true, caughtAt: { timestamp: CUTOFF - 86400000 } }) === true,
  '2: legendary on the B half counts too');
ok(pred({ speciesA: 150, speciesB: 25, fromEgg: true, caughtAt: { timestamp: CUTOFF } }) === false,
  '2: hatched exactly AT the cutoff → allowed');
ok(pred({ speciesA: 150, speciesB: 25, fromEgg: true, caughtAt: { timestamp: CUTOFF + 1 } }) === false,
  '2: hatched after the cutoff → allowed');
ok(pred({ speciesA: 150, speciesB: 25, caughtAt: { timestamp: CUTOFF - 1 } }) === false,
  '2: wild-caught (no fromEgg) pre-cutoff legendary → unaffected');
ok(pred({ speciesA: 150, speciesB: 25, fromEgg: false, caughtAt: { timestamp: 1 } }) === false,
  '2: explicit fromEgg:false → unaffected');
ok(pred({ speciesA: 150, speciesB: 25, fromEgg: true }) === true,
  '2: fromEgg with NO caughtAt → blocked (can\'t prove it post-dates the rule)');
ok(pred({ speciesA: 150, speciesB: 25, fromEgg: true, caughtAt: {} }) === true,
  '2: fromEgg with an unusable timestamp → blocked');
ok(pred({ speciesA: 4, speciesB: 25, fromEgg: true, caughtAt: { timestamp: 1 } }) === false,
  '2: non-legendary hatched long ago → unaffected');
ok(pred(null) === false && pred({}) === false,
  '2: null / shapeless input → not blocked');

// ── 3. Daycare built-in tag wiring (source-level) ────────────────
const tagStart = src.indexOf("name: 'Daycare',");
ok(tagStart > 0, '3: Daycare built-in tag present');
const tagBlock = src.slice(tagStart, tagStart + 3000);
ok(tagBlock.indexOf('_legendaryTooOldForDaycare') >= 0,
  '3: Daycare tag consults the cutoff predicate');
const visibleBody = tagBlock.slice(tagBlock.indexOf('visible:'), tagBlock.indexOf('onToggle:'));
ok(visibleBody.indexOf('_legendaryTooOldForDaycare') >= 0,
  '3: visible() hides the chip for blocked legendaries');
const toggleBody = tagBlock.slice(tagBlock.indexOf('onToggle:'));
ok(toggleBody.indexOf('_saveImageNotice') >= 0
  && toggleBody.indexOf('before Oct 5 2026') >= 0,
  '3: onToggle refuses with the explanatory notice');
ok(toggleBody.indexOf('isInDaycare') >= 0,
  '3: refusal only blocks ADDING (removal still possible)');

// ── 4. normalized inventory shape carries the fields ─────────────
const norm = extract('function getInventoryCreatures(');
ok(/\bfromEgg:\s*e\.fromEgg === true/.test(norm),
  '4: getInventoryCreatures carries fromEgg (tag predicates run on this object)');
ok(/\bcaughtAt:\s*e\.caughtAt/.test(norm),
  '4: getInventoryCreatures carries caughtAt');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
