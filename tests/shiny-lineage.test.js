// Tests for the "Shiny variants" dex feature:
//   - readSeenShinyVariants: union of live shiny captures + persisted credits
//   - _ancestorChain / _shinyLineageAncestors: reconstruct the evolve path a
//     shiny took, following SEEN nodes (pick one branch on ambiguity)
//   - backfillShinyLineage: one-time, credits self-evolved shinies to their
//     earlier lineage forms (already-seen only; skips radar 'E:' spawns)
//
// Fake evolution world: two linear 3-stage lines A:1→2→3, B:4→5→6.
//
// Run: node tests/shiny-lineage.test.js
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

// ── fake Species world ──
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
  localStorage: {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => lsStore.set(k, String(v)),
  },
  readCapturedCreatures: () => captures,
  readSeenFusions: () => seen,
  writeSeenFusions: (m) => { seen = m; },
  SHINY_LINEAGE_BACKFILL_KEY: 'cc.shinyLineageBackfill.v2',
};
vm.createContext(ctx);
for (const m of ['function _ancestorChain', 'function _shinyLineageAncestors',
                 'function _normShinyEntry', 'function _addShinyToEntry',
                 'function readSeenShinyVariants', 'function markFusionShinySeen',
                 'function backfillShinyLineage']) {
  vm.runInContext(extract(m), ctx);
}
const call = (name, ...args) => { ctx.__a = args; return vm.runInContext(`${name}(...__a)`, ctx); };
const seenHasFrom = (set) => (x, y) => set.has(`${x}-${y}`);

// ── A. _ancestorChain is linear, most-evolved first ──
ok(eq(call('_ancestorChain', 3), [3, 2, 1]), 'A: ancestorChain(3) = [3,2,1]');
ok(eq(call('_ancestorChain', 6), [6, 5, 4]), 'A: ancestorChain(6) = [6,5,4]');
ok(eq(call('_ancestorChain', 1), [1]), 'A: ancestorChain(base) = [base]');

// ── B. path reconstruction follows the SEEN branch ──
{
  const aFirst = seenHasFrom(new Set(['1-4', '2-4', '3-4', '3-5', '3-6']));
  ok(eq(call('_shinyLineageAncestors', 3, 6, aFirst), [[3, 5], [3, 4], [2, 4], [1, 4]]),
     'B: A-first seen path reconstructed');
  const bFirst = seenHasFrom(new Set(['1-4', '1-5', '1-6', '2-6', '3-6']));
  ok(eq(call('_shinyLineageAncestors', 3, 6, bFirst), [[2, 6], [1, 6], [1, 5], [1, 4]]),
     'B: B-first seen path reconstructed');
}
// ── C. genuine ambiguity (all nodes seen) → one consistent path, ends at base ──
{
  const all = seenHasFrom(new Set(['1-4','1-5','1-6','2-4','2-5','2-6','3-4','3-5','3-6']));
  const p = call('_shinyLineageAncestors', 3, 6, all);
  ok(p.length === 4, 'C: picks a single 4-node path (not the whole lattice)');
  ok(eq(p[p.length - 1], [1, 4]), 'C: path ends at the base fusion');
}
// ── D. single-sided evolution: linear, no branching ──
{
  const anySeen = () => true;
  ok(eq(call('_shinyLineageAncestors', 3, 9, anySeen), [[2, 9], [1, 9]]),
     'D: only side A evolves → [[2,9],[1,9]]');
  ok(eq(call('_shinyLineageAncestors', 7, 8, anySeen), []),
     'D: neither side evolves → no ancestors');
}

// ── E. readSeenShinyVariants unions captures + persisted, preserving art variant ──
{
  captures = [
    { speciesA: 1, speciesB: 4, variant: 2, shinyVariant: 3 },   // shiny style 3 at art variant 2
    { speciesA: 1, speciesB: 4, variant: 'auto', shinyVariant: null },
    { speciesA: 2, speciesB: 4, variant: 0, shinyVariant: 8 },
  ];
  seen = { '1-4': { shinyVariants: [{ variant: null, shinyVariant: 7 }] } };
  const r = call('readSeenShinyVariants', 1, 4)
    .sort((x, y) => x.shinyVariant - y.shinyVariant);
  ok(eq(r, [{ variant: 2, shinyVariant: 3 }, { variant: null, shinyVariant: 7 }]),
     'E: unions live capture (style 3 @ art 2) + persisted (style 7 @ best-available)');
  ok(call('readSeenShinyVariants', 9, 9).length === 0, 'E: empty when none');
  // legacy bare-number persisted entries still read as best-available:
  seen = { '2-2': { shinyVariants: [5] } };
  ok(eq(call('readSeenShinyVariants', 2, 2), [{ variant: null, shinyVariant: 5 }]),
     'E: tolerates legacy bare-number persisted format');
}

// ── F. backfill: credit self-evolved shiny to the seen lineage path ──
const shinyPair = (arr) => (arr || []).map((e) => e.shinyVariant);
{
  lsStore.clear();
  captures = [{ speciesA: 3, speciesB: 6, variant: 1, shinyVariant: 5, spawnId: 'normal-1' }];
  // Only the A-first path is in the dex (that's the path actually taken).
  seen = { '1-4': {}, '2-4': {}, '3-4': {}, '3-5': {}, '3-6': {} };
  call('backfillShinyLineage');
  ok(eq(seen['1-4'].shinyVariants, [{ variant: null, shinyVariant: 5 }]),
     'F: base fusion credited (art unknown → null)');
  ok(eq(shinyPair(seen['2-4'].shinyVariants), [5]) && eq(shinyPair(seen['3-4'].shinyVariants), [5])
     && eq(shinyPair(seen['3-5'].shinyVariants), [5]), 'F: intermediate forms credited');
  ok(!seen['3-6'].shinyVariants, 'F: the final form itself is not double-credited (shows via capture)');
  ok(lsStore.get('cc.shinyLineageBackfill.v2') === '1', 'F: one-time flag set');
}
// ── G. radar (E:) shiny is NOT backfilled; already-run flag no-ops ──
{
  lsStore.clear();
  captures = [{ speciesA: 3, speciesB: 6, variant: 0, shinyVariant: 2, spawnId: 'E:1:2:3:0' }];
  seen = { '1-4': {}, '2-4': {}, '3-4': {}, '3-5': {}, '3-6': {} };
  call('backfillShinyLineage');
  ok(!seen['1-4'].shinyVariants && !seen['3-5'].shinyVariants, 'G: radar-caught evolved shiny is skipped');

  lsStore.set('cc.shinyLineageBackfill.v2', '1');
  captures = [{ speciesA: 3, speciesB: 6, variant: 0, shinyVariant: 4, spawnId: 'normal' }];
  seen = { '1-4': {}, '3-6': {} };
  call('backfillShinyLineage');
  ok(!seen['1-4'].shinyVariants, 'G: no-op when the one-time flag is already set');
}
// ── I. markFusionShinySeen preserves the exact art variant (evolve hook) ──
{
  seen = { '1-4': {} };
  call('markFusionShinySeen', 1, 4, 2, 9);   // art variant 2, shiny style 9
  ok(eq(seen['1-4'].shinyVariants, [{ variant: 2, shinyVariant: 9 }]),
     'I: records {variant:2, shinyVariant:9}');
  call('markFusionShinySeen', 1, 4, 2, 9);   // duplicate pair → no change
  ok(seen['1-4'].shinyVariants.length === 1, 'I: dedupes identical (art, style) pair');
  call('markFusionShinySeen', 1, 4, 5, 9);   // same style, different art → new cell
  ok(seen['1-4'].shinyVariants.length === 2, 'I: same style at a different art variant is a distinct entry');
  call('markFusionShinySeen', 9, 9, 0, 1);   // unseen fusion → no-op
  ok(!seen['9-9'], 'I: never mints an entry for an unseen fusion');
}
// ── H. only-existing: unseen lineage nodes are never minted ──
{
  lsStore.clear();
  captures = [{ speciesA: 3, speciesB: 6, shinyVariant: 1, spawnId: 'n' }];
  seen = { '3-6': {}, '1-4': {} };   // intermediates NOT seen
  call('backfillShinyLineage');
  ok(Object.keys(seen).sort().join() === '1-4,3-6', 'H: no phantom fusion entries created');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
