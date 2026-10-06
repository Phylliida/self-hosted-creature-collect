// Tests the one-time illegitimate-legendary-egg migration
// (static/creatures.js): _migrateIllegitimateLegendaryEggs converts
// pre-feature legendary × non-legendary daycare eggs to Bad Eggs,
// while sparing valid pairings (both/neither legendary), solo eggs,
// already-bad eggs, and completion-egg rewards (legendary ×
// non-legendary WITHOUT displaySpecies created on/after 2026-08-10 —
// daycare eggs always carry displaySpecies since cross-breed).
//
// Run: node tests/bad-egg-migration.test.js
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

const MIGRATION_SRC = ['function _isSoloEgg', 'function _isBadEgg',
  'function _migrateIllegitimateLegendaryEggs'].map(extract).join('\n');

const LEGS = new Set([144, 150, 383]);  // articuno, mewtwo, groudon stand-ins
const COMPLETION_EARLIEST = Date.UTC(2026, 7, 10);

// Run the migration against a fixture box. Returns { eggs, writes,
// ejected, logs }. Date.now is always stubbed (default: inside the
// window) so the suite is wall-clock independent; the cutoff const
// itself is injected the way the module computes it (local Oct 6).
function migrate(eggs, now) {
  const writes = [], ejected = [], logs = [];
  const cutoffLocal = new Date(2026, 9, 6).getTime();
  const ctx = {
    BAD_EGG_MIGRATION_CUTOFF_MS: cutoffLocal,
    COMPLETION_EGG_EARLIEST_MS: COMPLETION_EARLIEST,
    Date: { now: () => (now == null ? cutoffLocal - 86400000 : now), UTC: Date.UTC },
    global: {},  // no Species.ensureLoaded → migration runs synchronously
    console: { info: (m) => logs.push(m) },
    isLegendarySpecies: (id) => LEGS.has(id),
    readEggs: () => eggs,
    writeEggs: (arr) => writes.push(arr),
    removeFromIncubator: (id) => ejected.push(id),
  };
  vm.createContext(ctx);
  vm.runInContext(MIGRATION_SRC, ctx);
  vm.runInContext('_migrateIllegitimateLegendaryEggs()', ctx);
  return { eggs, writes, ejected, logs };
}

const egg = (id, a, b, extra) => Object.assign(
  { id, speciesA: a, speciesB: b, incubatedM: 0, createdAt: Date.UTC(2026, 5, 1) }, extra);

// --- conversions --------------------------------------------------------------
{
  const e = egg('e1', 383, 25, { displaySpecies: 383 });  // groudon × pikachu
  const r = migrate([e]);
  ok(e.bad === true && r.writes.length === 1,
    'legendary × non-legendary with displaySpecies (daycare egg) converts');
  ok(r.ejected.length === 1 && r.ejected[0] === 'e1',
    'converted egg is ejected from the incubator');
  ok(r.logs.length === 1 && /1 pre-feature/.test(r.logs[0]),
    'conversion is logged');
}
{
  // Pre-cross-breed daycare egg: no displaySpecies, created before the
  // completion-egg feature existed → provably illegitimate.
  const e = egg('e1', 150, 25, { createdAt: Date.UTC(2026, 0, 15) });
  migrate([e]);
  ok(e.bad === true, 'no-displaySpecies egg predating completion feature converts');
}

// --- spared eggs ---------------------------------------------------------------
{
  const both = egg('e1', 383, 144, { displaySpecies: 383 });   // groudon × articuno
  const same = egg('e2', 383, 383, { displaySpecies: 383 });   // groudon × groudon
  const neither = egg('e3', 25, 7, { displaySpecies: 25 });
  const r = migrate([both, same, neither]);
  ok(!both.bad && !same.bad && !neither.bad && r.writes.length === 0,
    'legendary × legendary, same-species, and non-legendary pairs are untouched');
}
{
  // Completion-egg reward shape: legendary × non-legendary, no
  // displaySpecies, created on/after 2026-08-10.
  const e = egg('e1', 25, 383, { createdAt: Date.UTC(2026, 8, 1) });
  const r = migrate([e]);
  ok(!e.bad && r.writes.length === 0, 'completion-reward eggs stay valid');
  const boundary = egg('e2', 383, 25, { createdAt: COMPLETION_EARLIEST });
  migrate([boundary]);
  ok(!boundary.bad, 'completion-feature start date is inclusive');
}
{
  const e = egg('e1', 383, 25, { bad: true, displaySpecies: 383 });
  const r = migrate([e]);
  ok(e.bad === true && r.writes.length === 0, 'already-bad eggs are skipped (idempotent)');
}
{
  const e = { id: 'e1', solo: 'missingno', incubatedM: 0, createdAt: Date.UTC(2026, 0, 15) };
  const r = migrate([e]);
  ok(!e.bad && r.writes.length === 0, 'solo eggs are untouched');
}
{
  const e = egg('e1', 383, 25, { displaySpecies: 383 });
  delete e.createdAt;  // pre-createdAt legacy record: can't be a completion egg
  migrate([e]);
  ok(e.bad === true, 'missing createdAt cannot be a completion egg → converts');
}

// --- date gate ------------------------------------------------------------------
{
  const cutoffLocal = new Date(2026, 9, 6).getTime();
  const e = egg('e1', 383, 25, { displaySpecies: 383 });
  const r = migrate([e], cutoffLocal);  // on the cutoff → no migration
  ok(!e.bad && r.writes.length === 0, 'no migration on/after local Oct 6 2026');
}
{
  const cutoffLocal = new Date(2026, 9, 6).getTime();
  const e = egg('e1', 383, 25, { displaySpecies: 383 });
  const r = migrate([e], cutoffLocal - 1);  // just inside the window
  ok(e.bad === true, 'migration runs just before the cutoff');
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
