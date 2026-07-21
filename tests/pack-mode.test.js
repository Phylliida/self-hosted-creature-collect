// Guards the multi-pack runtime: Packs registry, pack-aware spawns
// (co-location), record/egg tagging, solo evolution, and the
// install/serving namespacing.
//
// Run: node tests/pack-mode.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');

// --- 1) Packs registry ---------------------------------------------------------
{
  const ls = {};
  globalThis.localStorage = {
    getItem: (k) => (k in ls ? ls[k] : null),
    setItem: (k, v) => { ls[k] = String(v); },
    removeItem: (k) => { delete ls[k]; },
  };
  require(path.join(root, 'static', 'packs.js'));
  const P = globalThis.Packs;
  ok(P.active() === 'creature-fusion', '1: default pack is creature-fusion');
  ok(P.activeName() === 'Pokémon' && !P.isSoloMode(), '1: fusion mode by default');
  ok(P.setActive('neopets') === true && P.active() === 'neopets' && P.isSoloMode(),
    '1: switch to neopets works');
  ok(P.setActive('nope') === false && P.active() === 'neopets', '1: unknown pack rejected');
  ok(P.packOfRecord({}) === 'creature-fusion', '1: legacy record → creature-fusion');
  ok(P.packOfRecord({ pack: 'neopets' }) === 'neopets', '1: explicit pack field wins');
  P.setActive('creature-fusion');
  delete globalThis.localStorage;
}

// --- 2) pack-aware spawns: weather, solos, CO-LOCATION ---------------------------
{
  require(path.join(root, 'static', 'types.js'));
  require(path.join(root, 'static', 'spawns.js'));
  const S = globalThis.Spawns;
  const types = ['PLAIN', 'FLUFFY', 'SLIPPERY', 'AQUATIC', 'FLIGHT', 'CUTE', 'TOUGH'];
  const monsters = [
    { key: 'neo:a', types: ['AQUATIC', 'CUTE'] },
    { key: 'neo:b', types: ['PLAIN'] },
    { key: 'neo:c', types: ['TOUGH'] },
  ];
  const rares = [{ key: 'neo:rare1', types: ['PLAIN'] }];
  const now = Date.now();
  const bbox = [-73.990, 40.740, -73.980, 40.750];

  S.setPack({ id: 'neopets', types, monsters: [...monsters, ...rares], rares });
  const w = S.currentWeather(now);
  ok(types.includes(w.daily) && types.includes(w.weekly),
    '2: pack weather stays within the pack types');
  const packSpawns = S.spawnsInBbox(bbox, now);
  ok(packSpawns.length > 0 && packSpawns.every((s) => typeof s.solo === 'string'),
    '2: pack mode produces solo spawns');
  ok(packSpawns.every((s) => s.speciesA === undefined && s.speciesB === undefined),
    '2: pack spawns carry no pair fields');

  // Co-location: fusion mode (stub species) produces the same spawns at
  // the same places with identical derived values.
  globalThis.Species = { typesFor: () => ['NORMAL'], allSpecies: () => [{ id: 1 }] };
  S.setPack(null);
  const fusionSpawns = S.spawnsInBbox(bbox, now);
  const byId = new Map(packSpawns.map((s) => [s.id, s]));
  let same = 0, total = 0;
  for (const f of fusionSpawns) {
    const p = byId.get(f.id);
    if (!p) continue;
    total++;
    if (p.lat === f.lat && p.lng === f.lng && p.level === f.level
        && p.sizeM === f.sizeM && p.startMs === f.startMs
        && p.variantSeed === f.variantSeed) same++;
  }
  ok(total > 0 && total === fusionSpawns.length && same === total,
    `2: CO-LOCATION — ${same}/${total} spawns share id + geometry + level + size + birth + variantSeed`);

  // Restore pack → identical spawns again (deterministic across switches).
  S.setPack({ id: 'neopets', types, monsters, rares });
  ok(S.spawnsInBbox(bbox, now).length === packSpawns.length,
    '2: pack re-switch is deterministic');
  S.setPack(null);
  delete globalThis.Species;
}

// --- helpers for vm extraction -----------------------------------------------------
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
// Variant for functions with destructured params: the body's opening
// brace is the first '{' after the parameter list's matching ')'.
function extractFn(marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  let i = src.indexOf('(', start), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) break; }
  }
  const bodyOpen = src.indexOf('{', i);
  let d = 0, j = bodyOpen;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '/' && src[j + 1] === '/') { while (j < src.length && src[j] !== '\n') j++; continue; }
    if (c === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (j++; j < src.length && src[j] !== q; j++) { if (src[j] === '\\') j++; }
      continue;
    }
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) break; }
  }
  return src.slice(start, j + 1);
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

// --- 3) record/egg pack tagging ------------------------------------------------------
{
  ok(/entry\.pack = global\.Packs\.active\(\)/.test(src),
    '3: captures + grants tag the active pack');
  ok(/pack: egg\.pack \|\| \(global\.Packs/.test(src),
    '3: addEgg tags the active pack');
  ok(src.includes("else if (!isSoloEgg) entry.pack = 'creature-fusion';"),
    '3: pair hatches always land in creature-fusion');
  ok(src.includes('global.Packs.packOfRecord(c) === activePack'),
    '3: inventory filters by active pack');
  ok(src.includes("(e.pack || 'creature-fusion') === activePack"),
    '3: eggs view + egg bubble filter by active pack');
}

// --- 4) solo evolution ------------------------------------------------------------------
{
  let captured = [];
  let bagMap = {};
  let seenMap = {};
  const ctx = makeCtx({
    global: {},
    readCapturedCreatures: () => captured,
    writeCapturedCreatures: (arr) => { captured = arr; },
    readBag: () => bagMap,
    readSeenFusions: () => seenMap,
    writeSeenFusions: (m) => { seenMap = m; },
    isSoloCreature: (c) => !!(c && typeof c.solo === 'string' && c.solo),
    markSoloSeen: (id) => { seenMap['solo:' + id] = { firstSeen: 1 }; },
    consumeItem: (key, n) => {
      if ((bagMap[key] || 0) < n) return false;
      bagMap[key] -= n; return true;
    },
  });
  for (const m of ['function _canAffordSoloEvolution(', 'async function performSoloEvolution(']) {
    vm.runInContext(extractFn(m), ctx);
  }
  captured = [{
    id: 'c-1', solo: 'neo:acar_1yellow', speciesA: null, speciesB: null,
    level: 12, shinyVariant: 3, caughtAt: { timestamp: 1 },
  }];
  bagMap = { neo_paintbrush_red: 1 };
  seenMap = { 'solo:neo:acar_1yellow': { firstSeen: 1 } };
  Promise.resolve(vm.runInContext(
    `performSoloEvolution({ creatureId: 'c-1', target: 'neo:acar_2red',
       itemKey: 'neo_paintbrush_red', level: 10 })`, ctx)).then((updated) => {
    ok(!!updated && updated.solo === 'neo:acar_2red' && updated.level === 12
      && updated.shinyVariant === 3,
      '4: solo evolution mutates the record, keeps level + shiny');
    ok(bagMap.neo_paintbrush_red === 0, '4: paintbrush consumed');
    ok(!!seenMap['solo:neo:acar_2red'], '4: new form marked seen');
    ok(seenMap['solo:neo:acar_1yellow'].caught === true, '4: old form flagged caught-away');

    // Level gate blocks
    captured = [{ id: 'c-2', solo: 'neo:acar_1yellow', level: 5, speciesA: null, speciesB: null }];
    bagMap = { neo_paintbrush_red: 1 };
    return vm.runInContext(
      `performSoloEvolution({ creatureId: 'c-2', target: 'neo:acar_2red',
         itemKey: 'neo_paintbrush_red', level: 10 })`, ctx);
  }).then((blocked) => {
    ok(blocked === null && bagMap.neo_paintbrush_red === 1,
      '4: level gate blocks evolution without consuming the item');

    // --- 5) install/serving namespacing + wiring -----------------------------------
    require(path.join(root, 'static', 'pack-install.js'));
    const PI = globalThis.PackInstall;
    ok(PI.metaKey('neopets') === 'cc.contentPack.neopets.v1'
      && PI.metaKey() === 'cc.contentPack.creature-fusion.v1',
      '5: per-pack meta slots');
    const hf = PI.sourceForMode('static-hf', '', 'TessaCoil/neopets-pack', 'neopets');
    ok(hf.packBinUrl === 'https://huggingface.co/datasets/TessaCoil/neopets-pack/resolve/main/pack.bin',
      '5: per-pack HF source URL');
    const local = PI.sourceForMode('bbox-flask', '', null, 'neopets');
    ok(local.packBinUrl === '/pack-files/neopets/pack.bin', '5: per-pack local source URL');

    const swift = fs.readFileSync(path.join(root, 'ios-overrides', 'LocalServer.swift'), 'utf8');
    ok(swift.includes('activePackId') && swift.includes('active.txt'),
      '5: LocalServer reads the active-pack marker');
    ok(swift.indexOf('appendingPathComponent(activePackId(cdir))')
       < swift.indexOf('cdir.appendingPathComponent(rel)'),
      '5: LocalServer tries the active pack dir before the legacy root');

    const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
    ok(indexSrc.includes('<script src="/static/packs.js"></script>')
      && indexSrc.indexOf('<script src="/static/packs.js"></script>')
         < indexSrc.indexOf('<script src="/static/pack-install.js"></script>'),
      '5: packs.js loads before pack-install.js');
    ok(indexSrc.includes("'/static/packs.js'"), '5: packs.js in the refresh cache-delete list');
    ok(indexSrc.includes('loadActivePackData()'), '5: boot loads the active pack data');
    const runPy = fs.readFileSync(path.join(root, 'run.py'), 'utf8');
    ok(/_TRACKED_JS = \{[\s\S]*?packs\.js[\s\S]*?\}/.test(runPy)
      && /_SCRIPT_VERSION_FILES = \[[\s\S]*?packs\.js[\s\S]*?\]/.test(runPy),
      '5: run.py: packs.js tracked');
    ok(/@app\.route\("\/pack-files\/<packId>\/<path:fname>"\)/.test(runPy),
      '5: run.py: /pack-files/<id> route exists');
    const buildCap = fs.readFileSync(path.join(root, 'scripts', 'build-capacitor.sh'), 'utf8');
    ok(buildCap.includes('"packs.js"'), '5: build-capacitor.sh: packs.js stamped');

    const creatures = fs.readFileSync(path.join(root, 'static', 'creatures.js'), 'utf8');
    ok(creatures.includes('class="pack-swap-btn"') && creatures.includes('_showPackPicker'),
      '5: swap button next to the pack name + picker');
    ok(creatures.includes('packdex-view') && creatures.includes('function renderPackDex('),
      '5: pack dex view exists');
    ok(creatures.includes("pushView({ view: 'packdex' })"),
      '5: Pokédex button branches to pack dex in solo mode');
    // Regression: solo spawns must never reach the pair-keyed
    // cell/variant sprite machinery (undefined.pack / undefined.png).
    ok(/async function resolveSpawnVariant\(spawn\) \{\s*\/\/ Solo spawns[\s\S]{0,200}?return 'auto';/.test(creatures),
      '5: resolveSpawnVariant short-circuits solo spawns');
    ok(/records\s*\n?\s*\.filter\(\(\{ spawn \}\) => !\(typeof spawn\.solo === 'string' && spawn\.solo\)\)/.test(creatures)
      || creatures.includes(".filter(({ spawn }) => !(typeof spawn.solo === 'string' && spawn.solo))"),
      '5: addMarkersBatch keeps solo spawns out of the variant batch read');
    ok(creatures.includes('// Preload is pair-only'),
      '5: SpriteStore.preload is pair-only (no undefined-undefined entries)');
    ok(/if \(typeof spawn\.solo === 'string' && spawn\.solo\) \{\s*showCreatureArt\(img, \{ solo: spawn\.solo/.test(creatures),
      '5: marker batch routes solo spawns to showCreatureArt, not SpriteStore');

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
