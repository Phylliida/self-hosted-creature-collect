// Tests that Pokédex "completion %" excludes legendaries:
//   computeSpeciesCompletion()   (static/creatures.js)
//
// The completion model scores a species by how many fusions with it (head +
// body) you've seen, out of 2·N partners. Legendaries (~1/16000 spawns) are
// far too rare to fairly gate a "seen every fusion" goal, so:
//   - a fusion only advances a species when its PARTNER is non-legendary,
//   - the per-species denominator is 2·(non-legendary supported count),
//   - legendary species still appear as rows (flagged legendary:true) so the
//     completion dex can display them while renderCompletion() drops them
//     from the headline % and the "N/M complete" tally.
//
// We extract just computeSpeciesCompletion into a vm sandbox (same approach as
// theme-odds.test / incense-info.test) and feed it a small stub species pool.
//
// Run: node tests/completion-legendaries.test.js
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

// Stub species pool: 4 non-legendaries {1,2,3,4} + 2 legendaries {144,150}
// (the real GEN1 legendaries Mewtwo/Articuno both live in the supported pool).
const SUPPORTED = new Set([1, 2, 3, 4, 144, 150]);
const LEG = new Set([144, 145, 146, 150, 151]);
const NONLEG_COUNT = [...SUPPORTED].filter((id) => !LEG.has(id)).length; // 4

// seenFusions keys are "a-b". Cover: a plain non-leg fusion, a fusion whose
// partner is legendary (must NOT count for the non-leg species), the mirror
// where the legendary is the head, a self-fusion, and an out-of-pool partner.
let seenMap = {
  '1-2': 1,     // non-leg × non-leg
  '1-144': 1,   // 1 × Mewtwo  → partner legendary, must not advance species 1
  '144-1': 1,   // Mewtwo × 1  → advances Mewtwo (partner 1 non-leg), not 1's body
  '3-3': 1,     // self-fusion counts on both sides
  '2-5': 1,     // partner 5 not in the supported pool → ignored entirely
};

const ctx = {
  Object, Set, Array, Math, Map, Number, String, JSON,
  _supportedSet: () => SUPPORTED,
  _nonlegCount: () => NONLEG_COUNT,
  isLegendarySpecies: (id) => LEG.has(id),
  // In this stub pool nothing is an evolution (each id is its own family);
  // the non-evolved filter is exercised separately in completion-nonevolved.test.
  _isEvolvedSpecies: () => false,
  supportedSpeciesSorted: () => [...SUPPORTED].sort((a, b) => a - b),
  readSeenFusions: () => seenMap,
};
vm.createContext(ctx);
vm.runInContext(extract('function computeSpeciesCompletion('), ctx);
const rows = () => vm.runInContext('computeSpeciesCompletion()', ctx);

// ── Denominator excludes legendaries ────────────────────────────────────
{
  const r = rows();
  ok(r.every((x) => x.total === 2 * NONLEG_COUNT),
    'every row denominator is 2·(non-legendary count) = ' + (2 * NONLEG_COUNT));
}

// ── Legendaries are still present (displayed) and flagged ───────────────
{
  const byId = new Map(rows().map((x) => [x.id, x]));
  ok(byId.size === SUPPORTED.size, 'a row exists for every supported species (legendaries included)');
  ok(byId.get(144).legendary === true && byId.get(150).legendary === true,
    'legendary species carry legendary:true');
  ok(byId.get(1).legendary === false && byId.get(3).legendary === false,
    'non-legendary species carry legendary:false');
}

// ── A legendary PARTNER does not advance a non-legendary species ────────
{
  const byId = new Map(rows().map((x) => [x.id, x]));
  // Species 1: head from "1-2" counts (=1); "1-144" must NOT (partner legendary);
  // body from "144-1" must NOT (partner 144 legendary). → seen 1, not 2.
  ok(byId.get(1).seen === 1,
    'species 1 seen counts only the non-legendary partner (got ' + byId.get(1).seen + ', want 1)');
}

// ── A legendary species' OWN row still counts its non-legendary partners ─
{
  const byId = new Map(rows().map((x) => [x.id, x]));
  // Mewtwo(150) has no seen fusions → 0. Articuno? not used. Use 144:
  // "144-1" → head[144] (partner 1 non-leg) = 1; "1-144" → body[144] (partner 1) = 1.
  ok(byId.get(144).seen === 2,
    'legendary 144 still accrues its non-legendary partners (got ' + byId.get(144).seen + ', want 2)');
  ok(byId.get(150).seen === 0, 'legendary 150 with no seen fusions is 0');
}

// ── Self-fusion counts on both sides; out-of-pool partner ignored ───────
{
  const byId = new Map(rows().map((x) => [x.id, x]));
  ok(byId.get(3).seen === 2, 'self-fusion 3×3 counts head and body (got ' + byId.get(3).seen + ')');
  ok(byId.get(2).seen === 1, 'species 2 body from 1×2 counts; the out-of-pool 2×5 is ignored');
  ok(byId.get(4).seen === 0, 'species 4 (never fused) is 0');
}

// ── The aggregate contract renderCompletion() relies on ─────────────────
// renderCompletion filters out legendary rows for the headline % + tally.
{
  const nonLeg = rows().filter((x) => !x.legendary);
  ok(nonLeg.length === NONLEG_COUNT, 'aggregate iterates exactly the non-legendary rows (' + NONLEG_COUNT + ')');
  const totalAll = nonLeg.reduce((a, x) => a + x.total, 0);
  const seenAll = nonLeg.reduce((a, x) => a + x.seen, 0);
  // seen: sp1=1, sp2=1, sp3=2, sp4=0 → 4 seen of 4·8 = 32 → 13% (rounded).
  ok(seenAll === 4 && totalAll === 32, 'non-legendary seen/total sum as expected (' + seenAll + '/' + totalAll + ')');
  ok(Math.round(seenAll / totalAll * 100) === 13, 'overall % is computed over non-legendaries only');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
