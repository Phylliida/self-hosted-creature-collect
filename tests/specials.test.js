// Guards the solo (non-fusion) creature support: static/specials.js
// (registry), the solo branches in static/creatures.js (helpers, dex,
// candy, eggs, daycare, hatch), and shiny-store's solo palettes.
//
//   (1) Registry — shape, category query, register() pack hook.
//   (2) Helpers — isSoloCreature / creatureKeyOf / creatureName /
//       creatureTypes (vm-extracted from creatures.js).
//   (3) Dex — markSoloSeen entry shape; completion math skips solo keys.
//   (4) Candy — awardCandyForSolo buckets under 'solo:<id>'.
//   (5) Eggs — readEggs/addEgg accept solo eggs; _eggName/_eggTypes/
//       _eggArtCss solo branches; hatchEgg hatches a solo egg into a
//       solo creature (dex seen + candy).
//   (6) Daycare — _daycareLootAt for a solo parent yields only solo
//       candy + solo duplication eggs.
//   (7) Shiny — solo triple table shape + override registration.
//   (8) Wiring — script order, refresh list, run.py, build-capacitor,
//       bundled sprite exists.
//
// Run: node tests/specials.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');

// types.js must load before specials/creatures (register validates types).
require(path.join(root, 'static', 'types.js'));
require(path.join(root, 'static', 'specials.js'));
const S = globalThis.Specials;

// --- 1) registry ---------------------------------------------------------------
{
  ok(!!S, 'Specials exported under Node');
  const m = S.get('missingno');
  ok(!!m && m.name === 'Missingno' && m.category === 'glitch',
    '1: Missingno registered as glitch');
  ok(Array.isArray(m.types) && m.types.length > 0
    && m.types.every((t) => globalThis.Types.isValid(t)),
    '1: Missingno types are valid Types ids');
  ok(S.isSolo('missingno') && !S.isSolo('pikachu'), '1: isSolo');
  ok(S.byCategory('glitch').length === 1 && S.byCategory('glitch')[0].id === 'missingno',
    '1: byCategory(glitch) has exactly Missingno');
  ok(S.spriteUrl('missingno').endsWith('/specials/missingno.png'), '1: spriteUrl');
  ok(S.register({ id: 'missingno' }) === false, '1: duplicate id rejected');
  ok(S.register({ id: 'BAD ID' }) === false, '1: invalid id rejected');
  ok(S.register({ id: 'testmon', name: 'Testmon', category: 'glitch', types: ['FIRE', 'NOPE'] }) === true,
    '1: pack register works');
  const tm = S.get('testmon');
  ok(tm && tm.types.join() === 'FIRE', '1: unknown types filtered at register');
  ok(S.list()[0].id === 'missingno', '1: registry order stable (append-only)');
  // Regression: GMS pack monsters carry namespaced ids ('neo:acar_1yellow').
  // The id validator used to reject ':' — register() returned false, the
  // monster never entered the registry, spriteUrl() stayed null, and no
  // neopets art ever rendered anywhere.
  ok(S.register({ id: 'neo:acar_1yellow', name: 'Acara', category: 'special',
    types: ['NORMAL'], sprite: 'sprites/acar_yellow_m.png' }) === true,
    '1: namespaced pack id (neo:…) accepted');
  ok(S.isSolo('neo:acar_1yellow'), '1: namespaced id isSolo');
  ok(S.spriteUrl('neo:acar_1yellow').endsWith('/sprites/acar_yellow_m.png'),
    '1: namespaced id spriteUrl resolves');
}

// --- helpers for vm extraction (same approach as radar-tag.test.js) ------------
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
    Object, Set, Map, Array, Math, String, Number, JSON, Promise, Date, console,
    global: {},
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

// --- 2) creature helpers ---------------------------------------------------------
{
  const ctx = makeCtx({
    global: { Specials: S },
    fusionName: (a, b) => a + '×' + b,
    fusionTypesFor: () => ['FIRE', 'FLYING'],
  });
  for (const m of [
    'function isSoloCreature(', 'function creatureKeyOf(',
    'function creatureName(', 'function creatureTypes(',
  ]) vm.runInContext(extract(m), ctx);
  const call = (e) => vm.runInContext(e, ctx);
  const solo = { solo: 'missingno', speciesA: null, speciesB: null };
  const pair = { speciesA: 6, speciesB: 25 };
  ok(call('isSoloCreature(__x)', Object.assign(ctx, { __x: solo })) === true
    && call('isSoloCreature(__x)', Object.assign(ctx, { __x: pair })) === false
    && call('isSoloCreature(null)') === false, '2: isSoloCreature');
  ok(call('creatureKeyOf(__x)', Object.assign(ctx, { __x: solo })) === 'solo:missingno'
    && call('creatureKeyOf(__x)', Object.assign(ctx, { __x: pair })) === '6-25',
    '2: creatureKeyOf namespaces solos');
  ok(call('creatureName(__x)', Object.assign(ctx, { __x: solo })) === 'Missingno',
    '2: solo name from the registry');
  ok(JSON.stringify(call('creatureTypes(__x)', Object.assign(ctx, { __x: solo }))) === '["NORMAL"]'
    && JSON.stringify(call('creatureTypes(__x)', Object.assign(ctx, { __x: pair }))) === '["FIRE","FLYING"]',
    '2: creatureTypes branches');
}

// --- 3) dex: markSoloSeen + completion skip --------------------------------------
{
  let seenMap = {};
  const ctx = makeCtx({
    readSeenFusions: () => seenMap,
    writeSeenFusions: (m) => { seenMap = m; },
  });
  vm.runInContext(extract('function markSoloSeen('), ctx);
  vm.runInContext('markSoloSeen("missingno", "auto")', ctx);
  const entry = seenMap['solo:missingno'];
  ok(!!entry && typeof entry.firstSeen === 'number' && entry.variants
    && entry.variants.auto != null, '3: markSoloSeen writes a seenFusions-shaped entry');

  // Completion math: solo keys must NOT feed the fusion pair parsing.
  const completionCtx = makeCtx({
    readSeenFusions: () => ({
      'solo:missingno': { firstSeen: 1 },
      '6-25': { firstSeen: 1 },
      'not-a-pair': { firstSeen: 1 },
    }),
    _supportedSet: () => new Set([6, 25]),
    _nonlegCount: () => 2,
    isLegendarySpecies: () => false,
    _isEvolvedSpecies: () => false,
    supportedSpeciesSorted: () => [6, 25],
  });
  vm.runInContext(extract('function computeSpeciesCompletion('), completionCtx);
  const rows = vm.runInContext('computeSpeciesCompletion()', completionCtx);
  const six = rows.find((r) => r.id === 6);
  ok(six.seen === 1 && six.total === 4,
    '3: completion counts the pair only — solo + junk keys skipped');
}

// --- 4) solo candy -----------------------------------------------------------------
{
  let candyMap = {};
  const ctx = makeCtx({
    readCandyRaw: () => candyMap,
    writeCandy: (m) => { candyMap = m; },
    readCandy: () => candyMap,
  });
  for (const m of ['function bumpCandy(', 'function awardCandyForSolo(']) {
    vm.runInContext(extract(m), ctx);
  }
  vm.runInContext('awardCandyForSolo("missingno", 2); awardCandyForSolo("missingno", 1)', ctx);
  ok(candyMap['solo:missingno'] === 3, '4: solo candy buckets under solo:<id>');
}

// --- 5) eggs: validation, helpers, hatch --------------------------------------------
{
  const ctx = makeCtx({ EGGS_KEY: 'cc.eggs.v1' });
  for (const m of ['function readEggs(', 'function writeEggs(', 'function addEgg(']) {
    vm.runInContext(extract(m), ctx);
  }
  vm.runInContext('addEgg({ speciesA: 4, speciesB: 7, sizeM: 1.1 })', ctx);
  const soloRec = vm.runInContext('addEgg({ solo: "missingno", sizeM: 0.9 })', ctx);
  ok(!!soloRec && soloRec.solo === 'missingno' && soloRec.speciesA === undefined,
    '5: addEgg accepts solo eggs');
  ok(vm.runInContext('addEgg({ sizeM: 1 })', ctx) === null,
    '5: addEgg still rejects shapeless eggs');
  const eggs = vm.runInContext('readEggs()', ctx);
  ok(eggs.length === 2 && eggs[1].solo === 'missingno',
    '5: readEggs keeps solo eggs (and pair eggs)');
}
{
  // egg render helpers
  const ctx = makeCtx({
    global: { Specials: S },
    fusionName: (a, b) => a + '×' + b,
    fusionTypesFor: () => [],
    creatureName: (e) => S.get(e.solo).name,
    creatureTypes: (e) => S.get(e.solo).types.slice(),
    _eggArtSpecies: (e) => e.speciesA,
    _eggArtBackgroundCss: () => 'SHEET',
  });
  for (const m of ['function _isSoloEgg(', 'function _eggName(', 'function _eggTypes(', 'function _eggArtCss(']) {
    vm.runInContext(extract(m), ctx);
  }
  const soloEgg = { solo: 'missingno' };
  const pairEgg = { speciesA: 4, speciesB: 7 };
  ok(vm.runInContext('_eggName(__e)', Object.assign(ctx, { __e: soloEgg })) === 'Missingno',
    '5: _eggName solo');
  ok(JSON.stringify(vm.runInContext('_eggTypes(__e)', Object.assign(ctx, { __e: soloEgg }))) === '["NORMAL"]',
    '5: _eggTypes solo');
  ok(vm.runInContext('_eggArtCss(__e, 48)', Object.assign(ctx, { __e: soloEgg }))
      .includes('/specials/missingno.png'),
    '5: _eggArtCss solo uses the full-PNG sprite');
  ok(vm.runInContext('_eggArtCss(__e, 48)', Object.assign(ctx, { __e: pairEgg })) === 'SHEET',
    '5: _eggArtCss pair path unchanged');
}
{
  // hatchEgg: solo egg -> solo creature + dex seen + candy
  let captured = [];
  let seenMap = {};
  let candyMap = {};
  const soloEggRec = {
    id: 'e-solo-1', solo: 'missingno', sizeM: 0.9,
    incubatedM: 1e9, createdAt: 1,
  };
  const ctx = makeCtx({
    global: { Specials: S, CreatureCollectAPI: null },
    readEggs: () => [soloEggRec],
    writeEggs: () => {},
    readCapturedCreatures: () => captured,
    writeCapturedCreatures: (arr) => { captured = arr; },
    readSeenFusions: () => seenMap,
    writeSeenFusions: (m) => { seenMap = m; },
    readCandyRaw: () => candyMap,
    writeCandy: (m) => { candyMap = m; },
    removeFromIncubator: () => {},
    _updateEggBubble: () => {},
    _rollFreshShinyVariant: () => null,
    eggReadyToHatch: () => true,
    CANDY_HATCH_CAPTURE: 10,
    _userLat: null, _userLng: null,
  });
  for (const m of [
    'function bumpCandy(', 'function awardCandyForSolo(', 'function markSoloSeen(',
    'async function hatchEgg(',
  ]) vm.runInContext(extract(m), ctx);
  return Promise.resolve(vm.runInContext('hatchEgg("e-solo-1")', ctx)).then((entry) => {
    ok(!!entry && entry.solo === 'missingno' && entry.speciesA === null
      && entry.fromEgg === true && entry.level === 1,
      '5: hatchEgg(solo egg) -> solo creature record');
    ok(!!seenMap['solo:missingno'], '5: hatch marks the solo dex entry seen');
    ok(candyMap['solo:missingno'] === 10, '5: hatch awards solo candy (hatch rate)');

    // --- 6) daycare loot: solo parent -> solo candy / duplication eggs ----------
    require(path.join(root, 'static', 'spawns.js'));  // real getRng (needs global.Types, already loaded)
    const slot = { id: 'c-solo-1', addedAt: 123, distM: 1e6, claimed: [] };
    const dcCtx = makeCtx({
      global: { Specials: S, Spawns: globalThis.Spawns },
      findCreature: () => ({ id: 'c-solo-1', solo: 'missingno', speciesA: null, speciesB: null }),
      readDaycareSlots: () => [slot],
      candyRootFor: (x) => x,
      speciesNameFor: () => 'X',
      fusionName: () => 'X',
      _evoItemsForFamily: () => [],
      ITEMS: {},
      _formatItemName: () => 'X',
      isSoloCreature: (c) => !!(c && typeof c.solo === 'string' && c.solo),
      DAYCARE_PROB_CANDY: 0.70,
      DAYCARE_PROB_EGG: 0.15,
    });
    vm.runInContext(extract('function _daycareLootAt('), dcCtx);
    let sawCandy = 0, sawEgg = 0;
    for (let n = 1; n <= 60; n++) {
      const loot = vm.runInContext(`_daycareLootAt(${JSON.stringify(slot)}, ${n})`, dcCtx);
      if (!loot) { failed++; console.error('FAIL: 6: null loot at n=' + n); continue; }
      if (loot.kind === 'candy') {
        sawCandy++;
        if (loot.solo !== 'missingno' || !/Missingno candy/.test(loot.label)) {
          failed++; console.error('FAIL: 6: bad solo candy loot ' + JSON.stringify(loot));
        }
      } else if (loot.kind === 'egg') {
        sawEgg++;
        if (loot.solo !== 'missingno' || loot.sizeM < 0.5 || loot.sizeM > 2.0
            || !/Missingno egg/.test(loot.label)) {
          failed++; console.error('FAIL: 6: bad solo egg loot ' + JSON.stringify(loot));
        }
      } else {
        failed++; console.error('FAIL: 6: unexpected loot kind for solo parent: ' + loot.kind);
      }
    }
    ok(sawCandy > 0 && sawEgg > 0 && sawCandy + sawEgg === 60,
      `6: solo daycare yields only solo candy + duplication eggs (${sawCandy} candy, ${sawEgg} eggs)`);

    // --- 7) shiny solo triples -------------------------------------------------
    require(path.join(root, 'static', 'shiny-store.js'));
    const SH = globalThis.ShinyStore;
    const t0 = SH.getSoloTriple('missingno', 0);
    const t5 = SH.getSoloTriple('missingno', 5);
    ok(t0 && typeof t0.phi === 'number' && typeof t0.deltaL === 'number' && typeof t0.kappa === 'number',
      '7: default solo triple exists (no palette bin needed)');
    ok(t0.phi !== t5.phi, '7: variants differ');
    ok(SH.getSoloTriple('missingno', 12) === null && SH.getSoloTriple('missingno', -1) === null,
      '7: out-of-range variant -> null');
    SH.registerSoloTriples('custom', new Array(36).fill(0.5));
    ok(SH.getSoloTriple('custom', 3).phi === 0.5, '7: pack override registration');

    // --- 8) wiring ---------------------------------------------------------------
    const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
    ok(indexSrc.includes('<script src="/static/specials.js"></script>')
      && indexSrc.indexOf('<script src="/static/specials.js"></script>')
         < indexSrc.indexOf('<script src="/static/creatures.js"></script>'),
      '8: specials.js loads BEFORE creatures.js');
    ok(indexSrc.includes("'/static/specials.js'"), '8: specials.js in the refresh cache-delete list');
    const runPy = fs.readFileSync(path.join(root, 'run.py'), 'utf8');
    ok(/_TRACKED_JS = \{[\s\S]*?specials\.js[\s\S]*?\}/.test(runPy)
      && /_SCRIPT_VERSION_FILES = \[[\s\S]*?specials\.js[\s\S]*?\]/.test(runPy),
      '8: run.py: specials.js tracked');
    const buildCap = fs.readFileSync(path.join(root, 'scripts', 'build-capacitor.sh'), 'utf8');
    ok(buildCap.includes('"specials.js"'), '8: build-capacitor.sh: specials.js stamped');
    ok(fs.existsSync(path.join(root, 'data', 'BundledData', 'specials', 'missingno.png')),
      '8: bundled specials/missingno.png exists');
    ok(fs.existsSync(path.join(root, 'data', 'specials', 'missingno.png')),
      '8: source sprite at data/specials/missingno.png');
    const bbd = fs.readFileSync(path.join(root, 'build-bundled-data.py'), 'utf8');
    ok(/def build_specials\(/.test(bbd) && /build_specials\(\)/.test(bbd),
      '8: build-bundled-data.py builds specials sprites');

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
}
