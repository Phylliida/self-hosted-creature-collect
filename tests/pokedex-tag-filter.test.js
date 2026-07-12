// Regression test: the Pokédex (per-fusion) tag filter must work for
// per-capture built-in tags (Radar/Shiny/Hatched/Daycare), not just the
// fusion-intrinsic ones (Pure/Evolved/Evolvable).
//
// The bug: the dex filter tested each built-in predicate against a synthetic
// { speciesA, speciesB } stub. Per-capture predicates read fields that don't
// exist on that stub (spawnId, shinyVariant, fromEgg, id), so filtering the
// dex by "Radar" (etc.) matched nothing. Fix: a tag passes when the stub
// matches (intrinsic) OR any real capture of the fusion matches (per-capture).
//
// Run: node tests/pokedex-tag-filter.test.js
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

const ctx = {};
vm.createContext(ctx);
vm.runInContext(extract('function pokedexEntryPassesTags'), ctx);
const passes = (e, preds, caps) => {
  Object.assign(ctx, { __e: e, __p: preds, __c: caps });
  return vm.runInContext('pokedexEntryPassesTags(__e, __p, __c)', ctx);
};

// Representative built-in predicates (mirroring BUILTIN_TAGS in creatures.js).
const Radar = { predicate: (c) => c && typeof c.spawnId === 'string' && c.spawnId.startsWith('E:') };
const Shiny = { predicate: (c) => c && typeof c.shinyVariant === 'number' };
const Pure  = { predicate: (c) => c && c.speciesA != null && c.speciesA === c.speciesB };

const entry = (a, b) => ({ key: `${a}-${b}`, a, b });
const idx = (records) => {
  const m = new Map();
  for (const c of records) {
    const k = `${c.speciesA}-${c.speciesB}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(c);
  }
  return m;
};

// ── A. Radar (per-capture): matches only when a real E: capture exists ──
{
  const caps = idx([
    { speciesA: 68, speciesB: 359, spawnId: 'E:1:2:3:0' },   // radar catch of 68-359
    { speciesA: 1,  speciesB: 4,   spawnId: '1355:1:2:0' },   // normal catch of 1-4
  ]);
  ok(passes(entry(68, 359), [Radar], caps) === true,  'A: fusion with an E: capture passes Radar');
  ok(passes(entry(1, 4),    [Radar], caps) === false, 'A: fusion with only normal captures fails Radar');
  ok(passes(entry(7, 8),    [Radar], caps) === false, 'A: uncaught (seen-only) fusion fails Radar');
}

// ── B. Pure (intrinsic): matches on the stub regardless of captures ──
{
  const caps = idx([]);  // no captures at all
  ok(passes(entry(25, 25), [Pure], caps) === true,  'B: self-fusion passes Pure even with zero captures');
  ok(passes(entry(1, 4),   [Pure], caps) === false, 'B: real fusion fails Pure');
}

// ── C. Shiny (per-capture): matches when any capture of the fusion is shiny ──
{
  const caps = idx([
    { speciesA: 1, speciesB: 4, spawnId: 'x', shinyVariant: 7 },   // a shiny 1-4
    { speciesA: 1, speciesB: 4, spawnId: 'y', shinyVariant: null },
  ]);
  ok(passes(entry(1, 4), [Shiny], caps) === true, 'C: fusion with a shiny capture passes Shiny');
  ok(passes(entry(9, 9), [Shiny], caps) === false, 'C: fusion with no shiny capture fails Shiny');
}

// ── D. AND semantics across intrinsic + per-capture tags ──
{
  const caps = idx([
    { speciesA: 25, speciesB: 25, spawnId: 'E:9:9:9:0' },   // pure AND radar (25-25)
    { speciesA: 25, speciesB: 25, spawnId: 'normal' },      // pure, not radar
    { speciesA: 68, speciesB: 359, spawnId: 'E:1:1:1:0' },  // radar, not pure
  ]);
  ok(passes(entry(25, 25), [Pure, Radar], caps) === true,  'D: pure fusion with a radar capture passes Pure+Radar');
  ok(passes(entry(68, 359), [Pure, Radar], caps) === false, 'D: radar-but-not-pure fusion fails Pure+Radar');
  ok(passes(entry(1, 1), [Pure, Radar], caps) === false, 'D: pure fusion with no radar capture fails Pure+Radar');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
