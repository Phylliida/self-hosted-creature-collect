// Guards static/types.js — the single source of truth for Pokémon types
// and their effectiveness chart (global.Types).
//
//   (1) Order contract — the original 18 in the exact order spawns.js
//       seeds from; reordering would reshuffle every player's weather
//       and incense spawn streams.
//   (2) No-behavior-change pin — colors / strong / reduced(0.5×∪0×)
//       match the deleted creatures.js constants verbatim.
//   (3) Chart correctness — spot checks against the real Gen 6+ chart,
//       0× stored separately from 0.5×, reference integrity.
//   (4) register() — the content-pack extension point: appends without
//       disturbing the 18, offensive row + defensive patches work.
//   (5) Load order / wiring — types.js loads before spawns.js, spawns
//       loads headless against it, tracked everywhere for refresh.
//
// Run: node tests/types.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
require(path.join(root, 'static', 'types.js'));
const T = globalThis.Types;
ok(!!T, 'Types exported under Node');

// --- 1) order contract ---------------------------------------------------------
{
  const expect = [
    'NORMAL', 'FIRE', 'WATER', 'GRASS', 'ELECTRIC', 'ICE',
    'FIGHTING', 'POISON', 'GROUND', 'FLYING', 'PSYCHIC', 'BUG',
    'ROCK', 'GHOST', 'DRAGON', 'DARK', 'STEEL', 'FAIRY',
  ];
  ok(JSON.stringify(T.list()) === JSON.stringify(expect),
    '1: the 18 types in the exact contractual spawns order');
}

// --- 2) no-behavior-change pin (verbatim from the deleted constants) -----------
{
  const OLD_COLORS = {
    NORMAL: '#A8A77A', FIGHTING: '#C22E28', FLYING: '#A98FF3', POISON: '#A33EA1',
    GROUND: '#E2BF65', ROCK: '#B6A136', BUG: '#A6B91A', GHOST: '#735797',
    STEEL: '#B7B7CE', FIRE: '#EE8130', WATER: '#6390F0', GRASS: '#7AC74C',
    ELECTRIC: '#F7D02C', PSYCHIC: '#F95587', ICE: '#96D9D6', DRAGON: '#6F35FC',
    DARK: '#705746', FAIRY: '#D685AD',
  };
  for (const t of T.list()) {
    ok(T.color(t) === OLD_COLORS[t], '2: color for ' + t + ' unchanged (' + OLD_COLORS[t] + ')');
  }
  const OLD_REDUCED = {
    NORMAL: ['ROCK', 'STEEL', 'GHOST'], FIRE: ['FIRE', 'WATER', 'ROCK', 'DRAGON'],
    WATER: ['WATER', 'GRASS', 'DRAGON'], ELECTRIC: ['ELECTRIC', 'GRASS', 'DRAGON', 'GROUND'],
    GRASS: ['FIRE', 'GRASS', 'POISON', 'FLYING', 'BUG', 'DRAGON', 'STEEL'],
    ICE: ['FIRE', 'WATER', 'ICE', 'STEEL'], FIGHTING: ['POISON', 'FLYING', 'PSYCHIC', 'BUG', 'FAIRY', 'GHOST'],
    POISON: ['POISON', 'GROUND', 'ROCK', 'GHOST', 'STEEL'], GROUND: ['GRASS', 'BUG', 'FLYING'],
    FLYING: ['ELECTRIC', 'ROCK', 'STEEL'], PSYCHIC: ['PSYCHIC', 'STEEL', 'DARK'],
    BUG: ['FIRE', 'FIGHTING', 'POISON', 'FLYING', 'GHOST', 'STEEL', 'FAIRY'],
    ROCK: ['FIGHTING', 'GROUND', 'STEEL'], GHOST: ['DARK', 'NORMAL'], DRAGON: ['STEEL', 'FAIRY'],
    DARK: ['FIGHTING', 'DARK', 'FAIRY'], STEEL: ['FIRE', 'WATER', 'ELECTRIC', 'STEEL'],
    FAIRY: ['FIRE', 'POISON', 'STEEL'],
  };
  const OLD_STRONG = {
    NORMAL: [], FIRE: ['GRASS', 'ICE', 'BUG', 'STEEL'], WATER: ['FIRE', 'GROUND', 'ROCK'],
    ELECTRIC: ['WATER', 'FLYING'], GRASS: ['WATER', 'GROUND', 'ROCK'],
    ICE: ['GRASS', 'GROUND', 'FLYING', 'DRAGON'], FIGHTING: ['NORMAL', 'ICE', 'ROCK', 'DARK', 'STEEL'],
    POISON: ['GRASS', 'FAIRY'], GROUND: ['FIRE', 'ELECTRIC', 'POISON', 'ROCK', 'STEEL'],
    FLYING: ['GRASS', 'FIGHTING', 'BUG'], PSYCHIC: ['FIGHTING', 'POISON'],
    BUG: ['GRASS', 'PSYCHIC', 'DARK'], ROCK: ['FIRE', 'ICE', 'FLYING', 'BUG'],
    GHOST: ['PSYCHIC', 'GHOST'], DRAGON: ['DRAGON'], DARK: ['PSYCHIC', 'GHOST'],
    STEEL: ['ICE', 'ROCK', 'FAIRY'], FAIRY: ['FIGHTING', 'DRAGON', 'DARK'],
  };
  for (const t of T.list()) {
    const row = T.attackRow(t);
    ok(JSON.stringify(row.reduced) === JSON.stringify(OLD_REDUCED[t]),
      '2: reduced row for ' + t + ' matches the old merged set verbatim');
    ok(JSON.stringify(row.strong) === JSON.stringify(OLD_STRONG[t]),
      '2: strong row for ' + t + ' matches the old set verbatim');
  }
  // Craft/incense semantics helpers agree with the old set lookups.
  ok(T.isReduced('ELECTRIC', 'GROUND') && T.isReduced('FIGHTING', 'GHOST'),
    '2: isReduced covers the 0x cases (old merged semantics)');
  ok(!T.isReduced('FIRE', 'GRASS') && T.isSuperEffective('FIRE', 'GRASS'),
    '2: isSuperEffective separate from isReduced');
  ok(T.multiplier('SPLASH', 'FIRE') === 1, '2: unknown attacking type -> neutral 1x');
}

// --- 3) chart correctness vs the real Gen 6+ chart -----------------------------
{
  const cases = [
    ['ELECTRIC', 'GROUND', 0], ['GROUND', 'FLYING', 0], ['NORMAL', 'GHOST', 0],
    ['GHOST', 'NORMAL', 0], ['FIGHTING', 'GHOST', 0], ['POISON', 'STEEL', 0],
    ['PSYCHIC', 'DARK', 0], ['DRAGON', 'FAIRY', 0],
    ['FIGHTING', 'NORMAL', 2], ['STEEL', 'FAIRY', 2], ['GROUND', 'ELECTRIC', 2],
    ['FAIRY', 'DRAGON', 2], ['WATER', 'FIRE', 2], ['ICE', 'DRAGON', 2],
    ['FAIRY', 'STEEL', 0.5], ['FIRE', 'WATER', 0.5], ['GRASS', 'FIRE', 0.5],
    ['NORMAL', 'FIRE', 1], ['WATER', 'ELECTRIC', 1],
  ];
  for (const [atk, def, want] of cases) {
    ok(T.multiplier(atk, def) === want, '3: ' + atk + ' -> ' + def + ' is ' + want + 'x');
  }
  // 0x is stored separately from 0.5x now (the old chart merged them).
  ok(T.attackRow('ELECTRIC').immune.join() === 'GROUND' && !T.attackRow('ELECTRIC').weak.includes('GROUND'),
    '3: ELECTRIC has GROUND as immune, not weak');
  // Reference integrity: every id cited in any row is a known type.
  let refsOk = true;
  for (const t of T.list()) {
    const row = T.attackRow(t);
    for (const id of row.strong.concat(row.weak, row.immune)) {
      if (!T.isValid(id)) { refsOk = false; break; }
    }
  }
  ok(refsOk, '3: every chart reference is a registered type');
  // Inverse lookups line up with the rows.
  ok(JSON.stringify(T.strongAgainst('FIRE')) === JSON.stringify(['WATER', 'GROUND', 'ROCK']),
    '3: strongAgainst(FIRE) = Water/Ground/Rock (registry order)');
  ok(T.immuneAgainst('GROUND').join() === 'ELECTRIC', '3: only Electric is immune vs Ground');
  ok(T.reducedAgainst('GHOST').join().includes('NORMAL'),
    '3: reducedAgainst(GHOST) includes Normal (0x merged into the inverse view)');
  ok(T.displayName('ELECTRIC') === 'Electric' && T.displayName('SHADOW_MAGIC') === 'Shadow Magic',
    '3: displayName title-cases, underscores become spaces');
  ok(T.color('NOPE') === '#888' && !T.isValid('NOPE'), '3: unknown type -> #888, invalid');
}

// --- 4) register(): the pack extension point ------------------------------------
{
  const before = T.list().slice();
  ok(T.register({ id: 'FIRE' }) === false, '4: duplicate id rejected');
  ok(T.register({ id: 'not a type!' }) === false, '4: invalid id rejected');
  ok(T.register({
    id: 'ELDRITCH', color: '#5E3A8C',
    strong: ['FAIRY'], weak: ['STEEL'], immune: [],
    defStrong: ['DARK'], defWeak: ['FIGHTING'], defImmune: ['PSYCHIC'],
  }) === true, '4: custom type registers');
  ok(T.list().length === 19 && JSON.stringify(T.list().slice(0, 18)) === JSON.stringify(before),
    '4: new type appended; the original 18 order untouched');
  ok(T.multiplier('ELDRITCH', 'FAIRY') === 2 && T.multiplier('ELDRITCH', 'STEEL') === 0.5,
    '4: offensive row works');
  ok(T.multiplier('DARK', 'ELDRITCH') === 2 && T.multiplier('FIGHTING', 'ELDRITCH') === 0.5
    && T.multiplier('PSYCHIC', 'ELDRITCH') === 0,
    '4: defensive patches land on existing types');
  ok(T.color('ELDRITCH') === '#5E3A8C' && T.displayName('ELDRITCH') === 'Eldritch',
    '4: color + display name work for the new type');
  ok(T.register({ id: 'BROKEN', strong: ['ELDRITCH', 'NO_SUCH_TYPE'] }) === true
    && JSON.stringify(T.attackRow('BROKEN').strong) === JSON.stringify(['ELDRITCH']),
    '4: unknown ids in a pack row are filtered out');
}

// --- 5) load order + wiring ------------------------------------------------------
{
  // spawns.js must load headless against Types and produce valid weather.
  delete require.cache[require.resolve(path.join(root, 'static', 'spawns.js'))];
  require(path.join(root, 'static', 'spawns.js'));
  const w = globalThis.Spawns.currentWeather(Date.now());
  ok(w && T.isValid(w.daily) && T.isValid(w.weekly),
    '5: spawns.js loads headless; currentWeather returns registered types');

  const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
  ok(indexSrc.includes('<script src="/static/types.js"></script>')
    && indexSrc.indexOf('<script src="/static/types.js"></script>')
       < indexSrc.indexOf('<script src="/static/spawns.js"></script>'),
    '5: index.html loads types.js BEFORE spawns.js');
  ok(indexSrc.includes("'/static/types.js'"), '5: index.html: types.js in the refresh cache-delete list');
  const runPy = fs.readFileSync(path.join(root, 'run.py'), 'utf8');
  ok(/_TRACKED_JS = \{[\s\S]*?types\.js[\s\S]*?\}/.test(runPy)
    && /_SCRIPT_VERSION_FILES = \[[\s\S]*?types\.js[\s\S]*?\]/.test(runPy),
    '5: run.py: types.js tracked for live-update');
  const buildCap = fs.readFileSync(path.join(root, 'scripts', 'build-capacitor.sh'), 'utf8');
  ok(buildCap.includes('"types.js"'), '5: build-capacitor.sh: types.js in the stamp lists');
  // No stray copies of the chart left behind in the app code.
  const creatures = fs.readFileSync(path.join(root, 'static', 'creatures.js'), 'utf8');
  ok(!/const (TYPE_COLORS|_TYPE_REDUCED|_TYPE_STRONG|TYPE_FILTER_LIST)\b/.test(creatures),
    '5: creatures.js no longer defines its own chart/colors');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
