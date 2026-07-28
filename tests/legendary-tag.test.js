// Tests the "Legendary" built-in tag (static/creatures.js BUILTIN_TAGS):
// the real entry is lifted out of the source and its predicate evaluated
// against the real LEGENDARY_SPECIES_SET. Also pins the documented
// lockstep between creatures.js's LEGENDARY_SPECIES_SET and spawns.js's
// GEN1_LEGENDARY_IDS.
//
// Run: node tests/legendary-tag.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'creatures.js'), 'utf8');
const spawnsSrc = fs.readFileSync(path.join(__dirname, '..', 'static', 'spawns.js'), 'utf8');

// ── A. legendary id sets exist and are in lockstep ──────────────
const parseIds = (s, re) => ((s.match(re) || [])[1] || '')
  .split(',').map((x) => Number(x.trim())).filter(Number.isFinite);
const CREATURE_IDS = parseIds(src, /LEGENDARY_SPECIES_SET\s*=\s*new Set\(\[([\d,\s]+)\]\)/);
const SPAWNS_IDS = parseIds(spawnsSrc, /GEN1_LEGENDARY_IDS\s*=\s*\[([\d,\s]+)\]/);
ok(CREATURE_IDS.length > 0, 'A: LEGENDARY_SPECIES_SET parsed from creatures.js');
ok(SPAWNS_IDS.length > 0, 'A: GEN1_LEGENDARY_IDS parsed from spawns.js');
ok(JSON.stringify([...CREATURE_IDS].sort()) === JSON.stringify([...SPAWNS_IDS].sort()),
  'A: the two legendary id sets are in lockstep');

// ── B. the real Legendary builtin entry ─────────────────────────
const entrySrc = (src.match(/\{\s*name: 'Legendary',[\s\S]*?\},\n/) || [])[0];
ok(!!entrySrc, 'B: Legendary entry found in BUILTIN_TAGS');
const ctx = { isLegendarySpecies: (id) => CREATURE_IDS.includes(id) };
vm.createContext(ctx);
const entry = vm.runInContext('(' + entrySrc.replace(/,\s*$/, '') + ')', ctx);

ok(entry.name === 'Legendary', 'B: tag is named Legendary');
ok(typeof entry.description === 'string' && entry.description.length > 0,
  'B: has a description (shown in the Tags view)');
ok(typeof entry.predicate === 'function', 'B: has a predicate');

// ── C. predicate semantics ──────────────────────────────────────
const LEG = CREATURE_IDS[0];
const LEG2 = CREATURE_IDS[1] || CREATURE_IDS[0];
ok(entry.predicate({ speciesA: LEG, speciesB: 25 }) === true, 'C: legendary on the A side');
ok(entry.predicate({ speciesA: 25, speciesB: LEG }) === true, 'C: legendary on the B side');
ok(entry.predicate({ speciesA: LEG, speciesB: LEG2 }) === true, 'C: legendary on both sides');
ok(entry.predicate({ speciesA: 25, speciesB: 4 }) === false, 'C: no legendary side → false');
ok(!entry.predicate(null), 'C: null creature → falsy');
ok(!entry.predicate({}), 'C: missing halves (solo) → falsy');
for (const id of CREATURE_IDS) {
  ok(entry.predicate({ speciesA: id, speciesB: 1 }) === true, 'C: id ' + id + ' counts as legendary');
}

// ── D. intrinsic shape: works on the pokédex's synthetic stub ───
// The dex tag filter tests predicates against a bare { speciesA, speciesB }
// stub first (see pokedexEntryPassesTags) — the predicate must not read
// any per-capture fields. If it fires on the stub, it's intrinsic.
ok(entry.predicate({ speciesA: LEG, speciesB: 1 }) === true,
  'D: fires on a bare {speciesA, speciesB} stub (pokédex-filterable)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
