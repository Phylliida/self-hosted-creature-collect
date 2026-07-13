// Tests for the encounter "Fresh" badge feature:
//   - markFusionCaughtAway: flags a dex row as "caught then evolved away"
//   - backfillCaughtAwayLineage: one-time, flags pre-existing evolved-away
//     lineage forms of current captures (already-seen only; skips 'E:' spawns)
//   - mergeSeenFusions: backup restore ORs the `caught` flag in monotonically
//
// The badge decision itself (in openBattleScreen) is the trivial one-liner
//   ownsFusion ? '' : (caughtAway ? 'Fresh' : 'New')
// where caughtAway = !ownsFusion && seenEntry.caught — so the real logic under
// test is the `caught` flag's lifecycle, covered below.
//
// Fake evolution world: two linear 3-stage lines A:1→2→3, B:4→5→6.
//
// Run: node tests/fresh-annotation.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

// ── fake Species world (same as shiny-lineage.test.js) ──
const inA = (x) => x >= 1 && x <= 3, inB = (x) => x >= 4 && x <= 6;
const Species = {
  familyOf: (x) => inA(x) ? [1, 2, 3] : inB(x) ? [4, 5, 6] : [x],
  evolutionsFor: (x) => ({ 1: [2], 2: [3], 4: [5], 5: [6] }[x] || []).map((t) => ({ target: t })),
};

let seen = {};
let captures = [];
const lsStore = new Map();
const ctx = {
  global: { Species },
  performance: { now: () => 0 },
  localStorage: {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => lsStore.set(k, String(v)),
  },
  readCapturedCreatures: () => captures,
  readSeenFusions: () => seen,
  writeSeenFusions: (m) => { seen = m; },
  CAUGHT_AWAY_BACKFILL_KEY: 'cc.caughtAwayBackfill.v1',
};
vm.createContext(ctx);
for (const m of ['function _ancestorChain', 'function _shinyLineageAncestors',
                 'function _normShinyEntry', 'function markFusionCaughtAway',
                 'function backfillCaughtAwayLineage', 'function mergeSeenFusions']) {
  vm.runInContext(extract(m), ctx);
}
const call = (name, ...args) => { ctx.__a = args; return vm.runInContext(`${name}(...__a)`, ctx); };

// ── A. markFusionCaughtAway flags an already-seen row, idempotently ──
{
  seen = { '1-4': {} };
  call('markFusionCaughtAway', 1, 4);
  ok(seen['1-4'].caught === true, 'A: flags an already-seen fusion');
  call('markFusionCaughtAway', 1, 4);           // idempotent, no throw
  ok(seen['1-4'].caught === true, 'A: idempotent re-flag stays true');
  call('markFusionCaughtAway', 9, 9);           // unseen → no phantom row
  ok(!seen['9-9'], 'A: never mints an entry for an unseen fusion');
  call('markFusionCaughtAway', null, 4);        // null guard
  ok(!('null-4' in seen), 'A: null species is a no-op');
}

// ── B. backfill flags the seen evolved-away lineage of a current capture ──
{
  lsStore.clear();
  // Own the fully-evolved (3,6); the A-first path is what's in the dex.
  captures = [{ speciesA: 3, speciesB: 6, spawnId: 'normal-1' }];
  seen = { '1-4': {}, '2-4': {}, '3-4': {}, '3-5': {}, '3-6': {} };
  call('backfillCaughtAwayLineage');
  ok(seen['1-4'].caught && seen['2-4'].caught && seen['3-4'].caught && seen['3-5'].caught,
     'B: every seen ancestor on the taken path is flagged caught');
  ok(!seen['3-6'].caught, 'B: the still-owned final form itself is not flagged (isFusionOwned covers it)');
  ok(lsStore.get('cc.caughtAwayBackfill.v1') === '1', 'B: one-time flag set');
}

// ── C. radar (E:) evolved capture is skipped (its earlier forms weren't caught) ──
{
  lsStore.clear();
  captures = [{ speciesA: 3, speciesB: 6, spawnId: 'E:1:2:3:0' }];
  seen = { '1-4': {}, '2-4': {}, '3-4': {}, '3-5': {}, '3-6': {} };
  call('backfillCaughtAwayLineage');
  ok(!seen['1-4'].caught && !seen['3-5'].caught, 'C: radar-caught evolved form does not backfill "Fresh"');
}

// ── D. only-existing: unseen lineage nodes are never minted ──
{
  lsStore.clear();
  captures = [{ speciesA: 3, speciesB: 6, spawnId: 'n' }];
  seen = { '3-6': {}, '1-4': {} };   // intermediates NOT seen
  call('backfillCaughtAwayLineage');
  ok(Object.keys(seen).sort().join() === '1-4,3-6', 'D: no phantom fusion entries created');
  // Best-effort: the base (1-4) sits on the reconstructed default path and IS
  // in the dex, so it's credited; the unseen intermediates simply aren't minted.
  ok(seen['1-4'].caught === true, 'D: a seen node on the reconstructed path is still credited');
}

// ── E. one-time flag no-ops a second run ──
{
  lsStore.clear();
  lsStore.set('cc.caughtAwayBackfill.v1', '1');
  captures = [{ speciesA: 3, speciesB: 6, spawnId: 'normal' }];
  seen = { '1-4': {}, '2-4': {}, '3-4': {}, '3-5': {}, '3-6': {} };
  call('backfillCaughtAwayLineage');
  ok(!seen['1-4'].caught, 'E: no-op when the one-time flag is already set');
}

// ── F. mergeSeenFusions ORs `caught` in monotonically (backup restore) ──
{
  const merged = call('mergeSeenFusions', { '1-4': {} }, { '1-4': { caught: true } });
  ok(merged['1-4'].caught === true, 'F: OR-in caught onto an already-known fusion');
}
{
  const merged = call('mergeSeenFusions', { '1-4': { caught: true } }, { '1-4': {} });
  ok(merged['1-4'].caught === true, 'F: an import without the flag never clears a local caught');
}
{
  const merged = call('mergeSeenFusions', {}, { '2-5': { firstSeen: 1, caught: true } });
  ok(merged['2-5'].caught === true, 'F: a brand-new fusion carries its caught flag through restore');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
