// Tests the 100%-completion egg reward pickers (static/creatures.js):
//   _pickCompletionEggLegendary(counts, legendaryIds, hasCustomArt, rng)
//   _pickCompletionEggOrientation(customAB, customBA, rng)
//
// The legendary is dealt from a deck without replacement: candidates are
// the legendaries tied for the lowest grant count, so everyone reaches n
// before anyone reaches n+1. Only eggs granted by THIS feature bump the
// counts — wild/radar legendaries and daycare-bred legendary eggs don't.
// Within the deck, legendaries whose fusion with the completed species
// has custom (non-autogen) art are preferred; deck exclusion wins over
// the art preference.
//
// We extract just the two pure functions into a vm sandbox (same
// approach as completion-legendaries.test) and drive them with seeded
// rng stubs.
//
// Run: node tests/completion-egg.test.js
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

const LEGS = [144, 145, 146, 150, 151];
const ctx = { Object, Set, Array, Math, Map, Number, String, JSON, Infinity };
vm.createContext(ctx);
vm.runInContext(extract('function _pickCompletionEggLegendary('), ctx);
vm.runInContext(extract('function _pickCompletionEggOrientation('), ctx);

// rng from a fixed stream of values (cycles if exhausted).
function rngFrom(vals) {
  let i = 0;
  return () => vals[i++ % vals.length];
}
const noCustom = () => false;

// Driver: run inside the one context with globals swapped per call.
function pickLeg(counts, hasCustomArt, rng) {
  ctx.hasCustomArt = hasCustomArt;
  ctx.rng = rng;
  return vm.runInContext(
    `_pickCompletionEggLegendary(${JSON.stringify(counts)}, ${JSON.stringify(LEGS)}, hasCustomArt, rng)`,
    ctx);
}
function pickOrient(customAB, customBA, rngVal) {
  ctx.rng = () => rngVal;
  return vm.runInContext(
    `_pickCompletionEggOrientation(${customAB}, ${customBA}, rng)`, ctx);
}

// ── Empty counts → whole list is the deck, uniform over all ──────────
{
  const seen = new Set();
  for (let i = 0; i < LEGS.length; i++) {
    seen.add(pickLeg({}, noCustom, () => i / LEGS.length + 0.001));
  }
  ok(seen.size === LEGS.length,
    'fresh deck: every legendary reachable under uniform rng (got ' + seen.size + ')');
}

// ── Deck without replacement: ahead legendaries are excluded ─────────
{
  // 144 already granted once → only the 0-count legendaries are candidates.
  const counts = { 144: 1 };
  for (let i = 0; i < 200; i++) {
    const got = pickLeg(counts, noCustom, Math.random);
    ok(got !== 144, 'deck: legendary ahead in count is never picked (got 144)');
    if (got === 144) break;
  }
  // Everyone at 1 → 144 is a candidate again (round 2 begins).
  const all1 = { 144: 1, 145: 1, 146: 1, 150: 1, 151: 1 };
  const seen = new Set();
  for (let i = 0; i < LEGS.length; i++) {
    seen.add(pickLeg(all1, noCustom, () => i / LEGS.length + 0.001));
  }
  ok(seen.size === LEGS.length, 'deck: once counts tie, every legendary is back in the deck');
  // Mixed: two at 2, rest at 1 → deck is exactly the 1-count set.
  const mixed = { 144: 2, 145: 1, 146: 1, 150: 2, 151: 1 };
  for (let i = 0; i < 200; i++) {
    const got = pickLeg(mixed, noCustom, Math.random);
    ok(got === 145 || got === 146 || got === 151,
      'deck: only min-count legendaries are candidates (got ' + got + ')');
    if (!(got === 145 || got === 146 || got === 151)) break;
  }
}

// ── Custom-art preference applies WITHIN the deck only ───────────────
{
  // 145 has custom art and is in the deck → always picked.
  const counts = { 144: 1 };
  for (let i = 0; i < 100; i++) {
    const got = pickLeg(counts, (id) => id === 145, Math.random);
    ok(got === 145, 'custom-art deck member is always preferred (got ' + got + ')');
    if (got !== 145) break;
  }
  // 144 has custom art but is AHEAD in count → deck exclusion wins.
  for (let i = 0; i < 100; i++) {
    const got = pickLeg(counts, (id) => id === 144, Math.random);
    ok(got !== 144, 'deck exclusion beats custom-art preference (got 144)');
    if (got === 144) break;
  }
  // Two custom-art members in the deck → uniform between just those two.
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    seen.add(pickLeg(counts, (id) => id === 145 || id === 146, Math.random));
  }
  ok(seen.size === 2 && seen.has(145) && seen.has(146),
    'multiple custom-art deck members: uniform among them (got ' + [...seen].join(',') + ')');
  // No custom art anywhere → falls back to the whole deck.
  const seen2 = new Set();
  for (let i = 0; i < 300; i++) seen2.add(pickLeg(counts, noCustom, Math.random));
  ok(seen2.size === 4 && !seen2.has(144),
    'no custom art in deck: uniform over the whole deck (got ' + [...seen2].join(',') + ')');
}

// ── Orientation: exactly-one-custom wins, else coin-flip ─────────────
{
  ok(pickOrient(true, false, 0.99) === 'ab', 'orientation: only a×b custom → ab regardless of rng');
  ok(pickOrient(false, true, 0.01) === 'ba', 'orientation: only b×a custom → ba regardless of rng');
  ok(pickOrient(true, true, 0.3) === 'ab' && pickOrient(true, true, 0.7) === 'ba',
    'orientation: both custom → coin-flip');
  ok(pickOrient(false, false, 0.3) === 'ab' && pickOrient(false, false, 0.7) === 'ba',
    'orientation: neither custom → coin-flip');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
