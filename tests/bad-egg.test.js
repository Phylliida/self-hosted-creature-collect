// Tests the Bad Egg feature in static/creatures.js (2026-10-05):
// when a legendary × non-legendary creature is in the daycare, every egg
// roll everywhere comes out a Bad Egg. Bad Eggs:
//   - round-trip through readEggs/addEgg (pair-shaped + bad flag);
//   - are named "Bad Egg", typeless, and render the Togepi egg cell
//     (175) restyled monochrome (sheet cell 0 is empty art);
//   - never incubate and never hatch (eggReadyToHatch stays false);
//   - craft into exactly 3× incense of ANY type (no type-matching);
//   - are excluded from the New/Fresh badge (covered in egg-new-badge).
// The loot-side generation is covered in specials.test.js §6b/6c; the
// odds-popup copy in daycare-odds.test.js §8.
//
// Run: node tests/bad-egg.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
// Real type chart for the crafting-match math.
require(path.join(root, 'static', 'types.js'));

// comment-aware brace extractor (same approach as daycare-odds.test.js)
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
function makeCtx(extra) {
  const ctx = Object.assign({
    Object, Set, Map, Array, Math, String, Number, JSON, Date,
    global: { Types: globalThis.Types },
    localStorage: {
      _m: {},
      getItem(k) { return k in this._m ? this._m[k] : null; },
      setItem(k, v) { this._m[k] = String(v); },
      removeItem(k) { delete this._m[k]; },
    },
  }, extra || {});
  vm.createContext(ctx);
  return ctx;
}

// ── 1. storage round-trip ────────────────────────────────────────
{
  const ctx = makeCtx({ EGGS_KEY: 'cc.eggs.v1' });
  for (const m of ['function readEggs(', 'function writeEggs(', 'function addEgg(']) {
    vm.runInContext(extract(m), ctx);
  }
  const rec = vm.runInContext(
    'addEgg({ speciesA: 150, speciesB: 25, displaySpecies: 150, bad: true, sizeM: 1.2 })', ctx);
  ok(!!rec && rec.bad === true && rec.speciesA === 150 && rec.speciesB === 25,
    '1: addEgg keeps the bad flag and the parent pair');
  ok(vm.runInContext('addEgg({ speciesA: 1, speciesB: 4 })', ctx).bad === undefined,
    '1: normal pair eggs do NOT gain a bad flag');
  const eggs = vm.runInContext('readEggs()', ctx);
  ok(eggs.length === 2 && eggs[0].bad === true,
    '1: readEggs validator round-trips Bad Eggs (pair-shaped)');
}

// ── 2. crafting: any type, always 3× ─────────────────────────────
{
  const BAD = { id: 'eb', speciesA: 150, speciesB: 25, bad: true };
  const FIRE_EGG = { id: 'ef', speciesA: 4, speciesB: 5 };  // stubbed FIRE below
  const ctx = makeCtx({
    global: {
      Types: globalThis.Types,
      Species: { fusionTypesFor: (a, b) => (a === 4 ? ['FIRE'] : ['WATER']) },
    },
    readIncubator: () => [null, null],
    readEggs: () => [BAD, FIRE_EGG],
    _isSoloEgg: (e) => !!(e && typeof e.solo === 'string' && e.solo),
    creatureName: () => 'Solo',
    creatureTypes: () => [],
    fusionName: (a, b) => a + '×' + b,
  });
  for (const m of ['function _isBadEgg(', 'function _eggTypes(',
                   'function eggTypesNeutralOrEffectiveVs(', 'function craftMultiplier(',
                   'function _craftMultForEgg(', 'function _craftableEggsFor(']) {
    vm.runInContext(extract(m), ctx);
  }
  // Sanity on the unchanged pure function: FIRE vs WATER is resisted →
  // not craftable, and a neutral matchup multiplies 1×.
  ok(vm.runInContext('eggTypesNeutralOrEffectiveVs(["FIRE"], "WATER")', ctx) === false,
    '2: control — a pure-FIRE egg can\'t craft WATER incense');
  ok(vm.runInContext('craftMultiplier(["FIRE"], "FIRE")', ctx) === 1,
    '2: control — craftMultiplier unchanged for normal eggs');
  ok(vm.runInContext('_craftMultForEgg(__b, "WATER")', Object.assign(ctx, { __b: BAD })) === 3
    && vm.runInContext('_craftMultForEgg(__b, "FIRE")', Object.assign(ctx, { __b: BAD })) === 3
    && vm.runInContext('_craftMultForEgg(__b, "DRAGON")', Object.assign(ctx, { __b: BAD })) === 3,
    '2: Bad Egg crafts 3× of ANY incense type');
  const waterCraftable = vm.runInContext('_craftableEggsFor("WATER")', ctx);
  ok(waterCraftable.length === 1 && waterCraftable[0].id === 'eb',
    '2: Bad Egg is craftable into a type it can\'t match (FIRE egg excluded)');
  const grassCraftable = vm.runInContext('_craftableEggsFor("GRASS")', ctx);
  ok(grassCraftable.length === 2, '2: Bad Egg adds to normally-craftable lists too');
  // Slotted eggs stay excluded even when bad.
  const ctx2 = makeCtx({
    global: { Types: globalThis.Types, Species: { fusionTypesFor: () => ['FIRE'] } },
    readIncubator: () => ['eb', null],
    readEggs: () => [BAD],
    _isSoloEgg: () => false, creatureName: () => '', creatureTypes: () => [],
    fusionName: (a, b) => a + '×' + b,
  });
  for (const m of ['function _isBadEgg(', 'function _eggTypes(',
                   'function eggTypesNeutralOrEffectiveVs(', 'function _craftableEggsFor(']) {
    vm.runInContext(extract(m), ctx2);
  }
  ok(vm.runInContext('_craftableEggsFor("WATER")', ctx2).length === 0,
    '2: a Bad Egg in an incubator slot still can\'t be crafted');
}

// ── 3. never hatches ─────────────────────────────────────────────
{
  const ctx = makeCtx({
    INCUBATOR_HATCH_M: 5000,
    LEGENDARY_EGG_HATCH_M: 10000,
    isLegendarySpecies: (id) => id === 150,
  });
  for (const m of ['function _isSoloEgg(', 'function _isBadEgg(', 'function _isLegendaryEgg(',
                   'function eggHatchM(', 'function eggIncubatedM(', 'function eggReadyToHatch(']) {
    vm.runInContext(extract(m), ctx);
  }
  const bad = { id: 'eb', speciesA: 150, speciesB: 25, bad: true, incubatedM: 1e9 };
  ok(vm.runInContext('eggReadyToHatch(__b)', Object.assign(ctx, { __b: bad })) === false,
    '3: Bad Egg with massive incubatedM is still not ready');
  const normal = { id: 'en', speciesA: 1, speciesB: 4, incubatedM: 5000 };
  ok(vm.runInContext('eggReadyToHatch(__n)', Object.assign(ctx, { __n: normal })) === true,
    '3: control — a normal egg at its target IS ready');
  ok(vm.runInContext('eggHatchM(__b)', Object.assign(ctx, { __b: bad })) > 0,
    '3: eggHatchM still returns a sane display value for Bad Eggs');
}

// ── 4. incubation-distance display ───────────────────────────────
{
  const ctx = makeCtx({
    INCUBATOR_HATCH_M: 5000,
    LEGENDARY_EGG_HATCH_M: 10000,
    isLegendarySpecies: () => false,
  });
  for (const m of ['function _isSoloEgg(', 'function _isBadEgg(', 'function _isLegendaryEgg(',
                   'function eggHatchM(', 'function eggIncubatedM(', 'function _formatIncubationKm(']) {
    vm.runInContext(extract(m), ctx);
  }
  const bad = { id: 'eb', speciesA: 150, speciesB: 25, bad: true };
  ok(vm.runInContext('_formatIncubationKm(__b)', Object.assign(ctx, { __b: bad })) === "Can't hatch",
    '4: Bad Egg incubation label says it can\'t hatch (no bogus 0/5 km)');
  const normal = { id: 'en', speciesA: 1, speciesB: 4, incubatedM: 2500 };
  ok(vm.runInContext('_formatIncubationKm(__n)', Object.assign(ctx, { __n: normal })) === '2.50 / 5 km',
    '4: normal eggs keep the km/km format');
}

// ── 5. explainer modal copy + incubator-drop wiring ──────────────
{
  const ctx = makeCtx({});
  vm.runInContext(extract('function _badEggInfoHtml('), ctx);
  const html = vm.runInContext('_badEggInfoHtml()', ctx);
  ok(/legendary/i.test(html) && /non-legendary/.test(html),
    '5: explainer names the cause (legendary sharing with a non-legendary)');
  ok(/only breed with other legendaries/.test(html) && /never hatch/.test(html),
    '5: explainer says why it never hatches');
  ok(/3×/.test(html) && /any/.test(html) && /incense/.test(html),
    '5: explainer mentions the 3×-of-any-type craft yield');
  // Wiring: the drag-drop handler refuses Bad Eggs with this modal
  // instead of binding an incubator slot.
  ok(/_isBadEgg\(eggRec\)\)[\s\S]{0,200}_openInfoModal\(\{ title: 'Bad Egg'/.test(src),
    '5: incubator drop intercepts Bad Eggs with the info modal');
}

// ── 6. art: Togepi cell, monochrome ─────────────────────────────
{
  const ctx = makeCtx({
    BUNDLED_BASE: '/bundled',
    EGGS_SHEET_COLS: 10,
    EGGS_SHEET_ROWS: 43,
    BAD_EGG_ART_SPECIES: 175,
  });
  for (const m of ['function _isSoloEgg(', 'function _isBadEgg(',
                   'function _eggArtSpecies(', 'function _eggArtBackgroundCss(',
                   'function _eggArtCss(']) {
    vm.runInContext(extract(m), ctx);
  }
  const css = vm.runInContext(
    '_eggArtCss({ id: "eb", speciesA: 150, speciesB: 25, bad: true }, 48)', ctx);
  // Cell 175 → col 5, row 17; sheetCellPx = 128, inset = 40 →
  // position -(5*128+40)px -(17*128+40-1)px.
  ok(/eggs\.png/.test(css) && css.includes('-680px') && css.includes('-2215px'),
    '6: Bad Egg art renders the Togepi cell (175)');
  ok(!css.includes('-40px -39px'),
    '6: ...not the empty base cell 0');
  ok(/\.egg-tile\.egg-bad \.tile-art,\s*#creatureInventory \.craft-egg-art\.egg-bad\s*\{[^}]*grayscale\(1\)/
      .test(src),
    '6: grid + craft art are monochrome');
  ok(/\.daycare-loot-pill\.loot-bad \{[^}]*grayscale\(1\)/.test(src),
    '6: daycare loot pill is monochrome');
  ok(/BAD_EGG_ART_SPECIES\s*=\s*175/.test(src),
    '6: BAD_EGG_ART_SPECIES is the Togepi cell');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
