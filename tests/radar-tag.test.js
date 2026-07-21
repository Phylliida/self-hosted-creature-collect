// Regression test: the 'Radar' built-in tag must survive the inventory
// normalization step.
//
// The bug: builtin-tag predicates run on the object returned by
// getInventoryCreatures(), NOT the raw stored capture. That normalizer
// rebuilds each record with an explicit field list and dropped `spawnId`,
// so the Radar predicate (spawnId starts with 'E:') was always false —
// radar catches showed no tag on the card/detail and the collection
// "Radar" filter returned nothing. Fix: carry spawnId through.
//
// Run: node tests/radar-tag.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

// comment-aware brace extractor (same approach as the other creatures.js tests)
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

// The actual 'Radar' predicate from BUILTIN_TAGS (kept in sync with creatures.js).
const radarPredicate = (c) => c && typeof c.spawnId === 'string' && c.spawnId.startsWith('E:');

function normalize(records) {
  const ctx = {
    performance: { now: () => 0 },
    readCapturedCreatures: () => records,
    fusionName: () => 'Test Fusion',
    creatureName: () => 'Test Fusion',
    _perfMark: () => {},
    _invPerf: { fn: { getInventory: {} } },
  };
  vm.createContext(ctx);
  vm.runInContext(extract('function getInventoryCreatures'), ctx);
  return vm.runInContext('getInventoryCreatures()', ctx);
}

// ── A. spawnId round-trips through normalization (the dropped field) ──
{
  const out = normalize([
    { id: 'c1', spawnId: 'E:1:2:3:0', speciesA: 68, speciesB: 359, level: 10, sizeM: 1 },
    { id: 'c2', spawnId: '1355:1064:2973:0', speciesA: 1, speciesB: 4, level: 5, sizeM: 1 },
    { id: 'c3', spawnId: null, fromEgg: true, speciesA: 7, speciesB: 8, level: 1, sizeM: 1 },
  ]);
  ok(out[0].spawnId === 'E:1:2:3:0', 'A: evolved/radar spawnId preserved');
  ok(out[1].spawnId === '1355:1064:2973:0', 'A: normal spawnId preserved');
  ok(out[2].spawnId === null, 'A: egg (null spawnId) preserved');
}

// ── B. Radar predicate now resolves correctly on the normalized object ──
{
  const out = normalize([
    { id: 'c1', spawnId: 'E:1:2:3:0', speciesA: 68, speciesB: 359, level: 10, sizeM: 1 },
    { id: 'c2', spawnId: '1355:1064:2973:0', speciesA: 1, speciesB: 4, level: 5, sizeM: 1 },
    { id: 'c3', spawnId: null, fromEgg: true, speciesA: 7, speciesB: 8, level: 1, sizeM: 1 },
  ]);
  ok(radarPredicate(out[0]) === true, 'B: radar catch (E:) is tagged Radar');
  ok(radarPredicate(out[1]) === false, 'B: normal catch is NOT tagged Radar');
  ok(radarPredicate(out[2]) === false, 'B: egg hatch is NOT tagged Radar');
}

// ── C. solo field round-trips (non-fusion special creatures) ──
{
  const out = normalize([
    { id: 'c1', solo: 'missingno', speciesA: null, speciesB: null, level: 5, sizeM: null },
    { id: 'c2', spawnId: '1:2:3:0', speciesA: 1, speciesB: 4, level: 5, sizeM: 1 },
  ]);
  ok(out[0].solo === 'missingno', 'C: solo id preserved through normalization');
  ok(out[1].solo === null, 'C: fusion records normalize solo to null');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
