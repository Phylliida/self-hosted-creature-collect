// Tests the Pokédex completion "non-evolved only" filter:
//   computeSpeciesCompletion()   (static/creatures.js) now tags each row with
//   `evolved` (from _isEvolvedSpecies), and renderCompletion() offers a toggle
//   that lists / counts ONLY non-evolved species (the ones you actually CATCH
//   or HATCH — base forms + pre-evo babies), so the % answers "how much of the
//   catchable pool have I found".
//
// renderCompletion touches the DOM, so we can't run it headless. Instead we
// extract computeSpeciesCompletion (vm sandbox, same approach as
// completion-legendaries.test) and replicate the two pure pieces of the
// toggle's behavior:
//   1. list filter:      allRows.filter(r => !r.evolved)
//   2. headline aggregate: sum seen/total over rows that are neither legendary
//      nor (in non-evolved mode) evolved.
//
// Run: node tests/completion-nonevolved.test.js
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

// Stub pool: a 3-stage line {1 base → 2 mid → 3 final} plus a lone base {4}.
// Non-evolved (catch/hatch) set = {1, 4}. Evolved set = {2, 3}. No legendaries.
const SUPPORTED = new Set([1, 2, 3, 4]);
const EVOLVED = new Set([2, 3]);
const NONLEG_COUNT = 4; // no legendaries in this pool

// Seed one seen head-fusion per species so every species has non-zero seen and
// the filter's effect on the aggregate is observable.
//   1-2, 1-3, 1-4 → species 1 head seen = 3
//   2-1           → species 2 head seen = 1 (and species 1 body seen = 1)
//   3-4           → species 3 head seen = 1 (and species 4 body seen = 1)
const seenMap = { '1-2': 1, '1-3': 1, '1-4': 1, '2-1': 1, '3-4': 1 };

const ctx = {
  Object, Set, Array, Math, Map, Number, String, JSON,
  _supportedSet: () => SUPPORTED,
  _nonlegCount: () => NONLEG_COUNT,
  isLegendarySpecies: () => false,
  _isEvolvedSpecies: (id) => EVOLVED.has(id),
  supportedSpeciesSorted: () => [...SUPPORTED].sort((a, b) => a - b),
  readSeenFusions: () => seenMap,
};
vm.createContext(ctx);
vm.runInContext(extract('function computeSpeciesCompletion('), ctx);
const rows = () => vm.runInContext('computeSpeciesCompletion()', ctx);

// ── Every row carries the `evolved` flag from _isEvolvedSpecies ──────────
{
  const byId = new Map(rows().map((r) => [r.id, r]));
  ok(byId.get(1).evolved === false && byId.get(4).evolved === false,
    'base forms (1, 4) are evolved:false');
  ok(byId.get(2).evolved === true && byId.get(3).evolved === true,
    'evolved forms (2, 3) are evolved:true');
}

// ── The list filter drops exactly the evolved species ───────────────────
{
  const nonEvo = rows().filter((r) => !r.evolved);
  const ids = nonEvo.map((r) => r.id).sort((a, b) => a - b);
  ok(ids.length === 2 && ids[0] === 1 && ids[1] === 4,
    'non-evolved list is exactly {1, 4} (got {' + ids.join(', ') + '})');
}

// ── Aggregate over the FULL pool (toggle off) — sanity baseline ─────────
// head: 1→3, 2→1, 3→1 ; body: 1→1, 2→1, 3→1, 4→2. seen = head+body:
//   sp1 = 3+1 = 4, sp2 = 1+1 = 2, sp3 = 1+1 = 2, sp4 = 0+2 = 2. total each = 2·4 = 8.
{
  const all = rows().filter((r) => !r.legendary); // no legendaries here
  const seenAll = all.reduce((a, r) => a + r.seen, 0);
  const totalAll = all.reduce((a, r) => a + r.total, 0);
  ok(seenAll === 10 && totalAll === 32,
    'full-pool aggregate seen/total = 10/32 (got ' + seenAll + '/' + totalAll + ')');
}

// ── Aggregate over non-evolved only (toggle on) ─────────────────────────
// Keeps only sp1 (seen 4) and sp4 (seen 2) → 6 of 2·8 = 16 → 38%.
{
  const nonEvo = rows().filter((r) => !r.legendary && !r.evolved);
  const seenAll = nonEvo.reduce((a, r) => a + r.seen, 0);
  const totalAll = nonEvo.reduce((a, r) => a + r.total, 0);
  ok(nonEvo.length === 2, 'non-evolved aggregate iterates exactly 2 species');
  ok(seenAll === 6 && totalAll === 16,
    'non-evolved aggregate seen/total = 6/16 (got ' + seenAll + '/' + totalAll + ')');
  ok(Math.round(seenAll / totalAll * 100) === 38,
    'non-evolved % = 38 (got ' + Math.round(seenAll / totalAll * 100) + ')');
  // The two modes genuinely differ (else the toggle would be pointless).
  ok(Math.round(10 / 32 * 100) !== 38, 'non-evolved % differs from the full-pool %');
}

// ── "N/M complete" tally respects the non-evolved filter ────────────────
// A species is "complete" when seen >= total (8). None are complete here, but
// verify the tally denominator shrinks to the non-evolved count.
{
  const nonEvo = rows().filter((r) => !r.legendary && !r.evolved);
  ok(nonEvo.length === 2, 'complete-tally denominator is the non-evolved count (2)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
