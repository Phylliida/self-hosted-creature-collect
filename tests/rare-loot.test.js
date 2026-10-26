// Rare pokéstop loot: the Candy Ball and the bonus-incense berries.
//
//   A. rollCollectibleItem — each berry from 0.75% of pokéstop spins, an
//      evo item from 1% (2.25 berries + half an evo item per 50 spins); balls
//      Poké : Great : Candy = 2 : 2 : 1 for the rest
//   B. _rollEvoItem — the data set's evo items, weighted 1 / (1 + held)
//   C. catalog — Candy Ball throwable at ~80% (between Poké and Great),
//      every berry a bonus incense with a drawn icon
//   D. bonus incense state — one at a time, consume, replace, expiry,
//      save import
//   E. effects — candy ×2 per source (×4 together), Calm Berry halves
//      the miss, sight berries widen the radius (ramped 50 m a refresh),
//      Care / Warm Berry double the meters the daycare / incubator get
//   F. wiring — catches and hatches multiply their candy, the throw uses
//      the boosted rate and names its ball, the bag warns on replace,
//      the save file carries the berry
//
// Run: node tests/rare-loot.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'static', 'creatures.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
// Comment/string-aware brace matcher. bodyOnly skips a destructured
// parameter list (the first '{' after ') {').
function extract(marker, bodyOnly) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  let i = bodyOnly ? src.indexOf(') {', start) + 2 : src.indexOf('{', start), depth = 0;
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
// Everything from the BONUS_INCENSE header through _catchShakeRate.
function bonusRegion() {
  const start = src.indexOf('  // ── Bonus incense (berries) ──');
  const fn = extract('function _catchShakeRate(');
  const end = src.indexOf(fn) + fn.length;
  if (start < 0 || end <= start) throw new Error('bonus region not found');
  return src.slice(start, end);
}
function constLine(name) {
  const m = new RegExp('^\\s*const ' + name + ' = [^\\n]*;$', 'm').exec(src);
  if (!m) throw new Error('const not found: ' + name);
  return m[0];
}

// A seeded PRNG for the sampling checks (mulberry32).
function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One world: the real catalog bits, a bag, localStorage, a clock.
function makeWorld(opts = {}) {
  let now = 1_800_000_000_000;
  const ls = new Map();
  const bag = Object.assign({}, opts.bag || {});
  const refreshes = [];
  const evoParams = opts.evoParams || null;
  const ctx = {
    Math, JSON, Object, Array, Set, Map, encodeURIComponent,
    Date: { now: () => now },
    localStorage: {
      getItem: (k) => (ls.has(k) ? ls.get(k) : null),
      setItem: (k, v) => ls.set(k, String(v)),
      removeItem: (k) => ls.delete(k),
    },
    readBag: () => bag,
    consumeItem: (k, n) => { if ((bag[k] || 0) < n) return false; bag[k] -= n; if (!bag[k]) delete bag[k]; return true; },
    _refreshSpawnsNow: () => refreshes.push(now),
    global: { Species: evoParams ? {
      allSpecies: () => [{ id: 1 }, { id: 2 }],
      evolutionsFor: (id) => (id === 1
        ? evoParams.map((p) => ({ method: 'Item', param: p }))
        : [{ method: 'Level', param: 16 }, { method: 'TradeItem', param: 'METALCOAT' }]),
    } : null },
    _EVO_ITEM_METHODS: new Set(['Item', 'TradeItem', 'DayHoldItem']),
    BUNDLED_BASE: '/bundled-data',
    _formatItemName: (k) => k,
    _packItems: new Map(),
  };
  // Stats-journal hooks (creatures.js "Stats journal") are no-ops here.
  Object.assign(ctx, { noteStat() {}, _statsNoteCatch() {}, _statsNoteEncounter() {} });
  vm.createContext(ctx);
  // The ITEMS literal (Poké / Great / Candy Ball …) needs its icon builder.
  vm.runInContext(extract('function _candyBallIcon('), ctx);
  vm.runInContext('var ITEMS = ' + extract('const ITEMS = ').replace(/^const ITEMS = /, '') + ';', ctx);
  vm.runInContext(extract('const EVO_ITEM_KEYS = [').replace('const ', 'var ').replace(/\]$/, '];').replace(/;?$/, ';'), ctx);
  for (const m of ['function _addEvoItem(', 'function getItemMeta(', 'function _evoItemOnDemand(',
    'function _evoItemParams(', 'function rollCollectibleItem(', 'function _rollEvoItem(',
    'function _stepScanRadius(', 'function _visibilityRadiusM(']) {
    vm.runInContext(extract(m), ctx);
  }
  for (const c of ['RARE_PER_SPIN', 'POKESTOP_ITEMS_PER_SPIN', 'RARE_LOOT_CHANCE', 'RARE_LOOT', 'BALL_LOOT', 'THROWABLE_BALL_KEYS',
    'VISIBILITY_RADIUS_M', 'RADIUS_RAMP_M']) {
    vm.runInContext(constLine(c).replace(/^\s*const /, 'var '), ctx);
  }
  vm.runInContext('var _evoParamSet = null;', ctx);
  vm.runInContext(bonusRegion(), ctx);
  const run = (code, args) => { ctx.__a = args || []; return vm.runInContext(code, ctx); };
  return { ctx, ls, bag, refreshes, run, tick: (ms) => { now += ms; }, now: () => now };
}

(async () => {
  // ── A. loot roll ──
  {
    const w = makeWorld({ evoParams: ['FIRESTONE', 'WATERSTONE'] });
    const c = w.run('RARE_LOOT_CHANCE');
    ok(near(c, 0.01 / 3.5, 1e-12), 'A: each item rolls each rare kind at 1% / 3.5');
    // index.html's Collect handler must still hand out 1–6 items (mean
    // 3.5), or the per-spin rate drifts.
    ok(/const count = 1 \+ Math\.floor\(Math\.random\(\) \* 6\);/.test(html)
      && w.run('POKESTOP_ITEMS_PER_SPIN') === (1 + 2 + 3 + 4 + 5 + 6) / 6,
      'A: POKESTOP_ITEMS_PER_SPIN matches the Collect handler’s 1–6 items');
    // Scripted rolls: the first draw picks the rare band, the next a ball
    // (weights 2:2:1 of 5).
    const seq = (xs) => { let i = 0; return () => xs[i++]; };
    const roll = (xs) => w.run('rollCollectibleItem(__a[0])', [seq(xs)]);
    // Berry bands are 0.75 c wide, the evo band a full c.
    ok(roll([0]) === 'candy_berry' && roll([c * 0.74]) === 'candy_berry', 'A: band 1 → Candy Berry');
    ok(roll([c * 0.76]) === 'calm_berry', 'A: band 2 → Calm Berry');
    ok(roll([c * 1.8]) === 'hawkeye_berry', 'A: band 3 → Hawk-Eye Berry');
    ok(roll([c * 2.99]) === 'owleye_berry', 'A: band 4 → Owl-Eye Berry');
    ok(roll([c * 3.01]) === 'care_berry' && roll([c * 3.74]) === 'care_berry', 'A: band 5 → Care Berry');
    ok(roll([c * 3.76]) === 'warm_berry' && roll([c * 4.49]) === 'warm_berry', 'A: band 6 → Warm Berry');
    ok(['FIRESTONE', 'WATERSTONE', 'METALCOAT'].includes(roll([c * 4.51, 0.5]))
      && ['FIRESTONE', 'WATERSTONE', 'METALCOAT'].includes(roll([c * 5.49, 0.5])), 'A: band 7 → an evolution item');
    ok(roll([c * 5.51, 0.00]) === 'poke_ball', 'A: past the rare bands → balls, Poké first');
    ok(roll([0.5, 0.39]) === 'poke_ball' && roll([0.5, 0.41]) === 'great_ball', 'A: Poké 0–40% of the ball draw, then Great');
    ok(roll([0.99, 0.79]) === 'great_ball' && roll([0.99, 0.81]) === 'candy_ball', 'A: Candy Ball the last 20%');

    // Whole spins, as the Collect handler does them.
    const SPINS = 300000;
    const counts = w.run(`(() => {
      const rng = __a[0], c = {};
      let items = 0;
      for (let s = 0; s < __a[1]; s++) {
        const n = 1 + Math.floor(rng() * 6);
        for (let i = 0; i < n; i++) {
          let k = rollCollectibleItem(rng);
          if (/^[A-Z]+$/.test(k)) k = 'evo';
          c[k] = (c[k] || 0) + 1;
          items++;
        }
      }
      c.__items = items;
      return c;
    })()`, [rngFrom(7), SPINS]);
    const perSpin = (k) => (counts[k] || 0) / SPINS;
    for (const k of ['candy_berry', 'calm_berry', 'hawkeye_berry', 'owleye_berry', 'care_berry', 'warm_berry']) {
      ok(near(perSpin(k), 0.0075, 0.0006), `A: ${k} from ≈0.75% of spins (got ${(perSpin(k) * 100).toFixed(2)}%)`);
    }
    ok(near(perSpin('evo'), 0.01, 0.0007), `A: evo item from ≈1% of spins (got ${(perSpin('evo') * 100).toFixed(2)}%)`);
    const berries50 = 50 * ['candy_berry', 'calm_berry', 'hawkeye_berry', 'owleye_berry', 'care_berry', 'warm_berry'].reduce((a, k) => a + perSpin(k), 0);
    ok(near(berries50, 2.25, 0.12), `A: 50 spins ≈ 2.25 berries (got ${berries50.toFixed(2)})`);
    ok(near(50 * perSpin('evo'), 0.5, 0.05), `A: …and ≈ half an evolution item (got ${(50 * perSpin('evo')).toFixed(2)})`);
    const f = (k) => (counts[k] || 0) / counts.__items;
    ok(near(f('poke_ball'), 0.3943, 0.003) && near(f('great_ball'), 0.3943, 0.003),
      `A: Poké / Great ≈ 39.4% of items each (got ${(f('poke_ball') * 100).toFixed(1)} / ${(f('great_ball') * 100).toFixed(1)})`);
    ok(near(f('candy_ball'), 0.1971, 0.003), `A: Candy Ball ≈ 19.7% — half the Great Ball rate (got ${(f('candy_ball') * 100).toFixed(1)}%)`);
    ok(Object.keys(counts).length === 11, 'A: nothing else drops');
  }

  // ── B. evolution-item weighting ──
  {
    const w = makeWorld({ evoParams: ['MAGNETSTONE', 'FIRESTONE', 'WATERSTONE'], bag: { MAGNETSTONE: 79, WATERSTONE: 1 } });
    const rng = rngFrom(11);
    const c = {};
    const N = 200000;
    for (let i = 0; i < N; i++) { const k = w.run('_rollEvoItem(__a[0])', [rng]); c[k] = (c[k] || 0) + 1; }
    // Pool: MAGNETSTONE 1/80, FIRESTONE 1, WATERSTONE 1/2, METALCOAT 1 (TradeItem).
    const tot = 1 / 80 + 1 + 1 / 2 + 1;
    ok(near(c.FIRESTONE / N, 1 / tot, 0.006) && near(c.METALCOAT / N, 1 / tot, 0.006),
      'B: items you have none of share the top weight (TradeItem items count)');
    ok(near(c.WATERSTONE / N, 0.5 / tot, 0.006), 'B: holding 1 halves the weight');
    ok(near(c.MAGNETSTONE / N, (1 / 80) / tot, 0.0015), 'B: holding 79 → 1/80 the weight');
    ok(Object.keys(c).length === 4, 'B: only items the species evolve with');
    const noData = makeWorld({});
    const k = noData.run('_rollEvoItem(__a[0])', [rngFrom(3)]);
    ok(noData.run('EVO_ITEM_KEYS').includes(k), 'B: species data not loaded → the bundled evo-item list');
    const meta = w.run('getItemMeta(__a[0])', [w.run('_rollEvoItem(__a[0])', [() => 0])]);
    ok(meta && meta.evoItem, 'B: the rolled item has a bag entry');
  }

  // ── C. catalog ──
  {
    const w = makeWorld({});
    const items = w.run('ITEMS');
    const cube = (r) => r * r * r;
    ok(w.run('THROWABLE_BALL_KEYS').includes('candy_ball'), 'C: Candy Ball is throwable');
    const pc = cube(items.poke_ball.catchShakeRate), gc = cube(items.great_ball.catchShakeRate), cc = cube(items.candy_ball.catchShakeRate);
    ok(near(cc, 0.80, 0.005) && pc < cc && cc < gc, `C: Candy Ball catches ~80%, between Poké (${pc.toFixed(2)}) and Great (${gc.toFixed(2)})`);
    ok(items.candy_ball.candyMult === 2, 'C: Candy Ball doubles candy');
    for (const k of ['candy_ball', 'candy_berry', 'calm_berry', 'hawkeye_berry', 'owleye_berry', 'care_berry', 'warm_berry']) {
      const icon = items[k] && items[k].icon;
      const svg = icon && icon.startsWith('data:image/svg+xml,') ? decodeURIComponent(icon.slice(19)) : '';
      ok(/^<svg [^>]*xmlns='http:\/\/www\.w3\.org\/2000\/svg'[^>]*>[\s\S]*<\/svg>$/.test(svg), `C: ${k} has an inline SVG icon`);
      const open = (svg.match(/<(?!\/)[a-zA-Z]/g) || []).length;
      const close = (svg.match(/<\/[a-zA-Z]+>|\/>/g) || []).length;
      ok(open === close, `C: ${k} SVG tags balance (${open} / ${close})`);
    }
    for (const k of ['candy_berry', 'calm_berry', 'hawkeye_berry', 'owleye_berry', 'care_berry', 'warm_berry']) {
      ok(items[k].bonusIncense === true && /^Bonus incense: for \d+ min, /.test(items[k].desc), `C: ${k} is a bonus incense`);
    }
    const B = w.run('BONUS_INCENSE');
    ok(B.candy_berry.minutes === 15 && B.calm_berry.minutes === 15 && B.hawkeye_berry.minutes === 5
      && B.owleye_berry.minutes === 15, 'C: 15 / 15 / 5 / 15 minutes');
    ok(B.hawkeye_berry.sightMult === 3 && B.owleye_berry.sightMult === 2, 'C: Hawk-Eye 3×, Owl-Eye 2×');
    ok(B.care_berry.minutes === 30 && B.warm_berry.minutes === 30, 'C: Care / Warm Berry last 30 minutes');
    ok(B.care_berry.daycareMult === 2 && B.warm_berry.eggMult === 2, 'C: Care Berry 2× daycare, Warm Berry 2× eggs');
  }

  // ── D. bonus incense state ──
  {
    const w = makeWorld({ bag: { calm_berry: 2, hawkeye_berry: 1 } });
    ok(w.run('activateBonusIncense("candy_berry")') === false, 'D: none in the bag → nothing starts');
    ok(w.run('readActiveBonusIncense()') === null, 'D: …and nothing is active');
    ok(w.run('activateBonusIncense("calm_berry")') === true && w.bag.calm_berry === 1, 'D: using one consumes one');
    ok(w.run('readActiveBonusIncense()').key === 'calm_berry', 'D: it is active');
    w.tick(5 * 60000);
    ok(w.run('activateBonusIncense("hawkeye_berry")') === true, 'D: another replaces it');
    ok(w.run('readActiveBonusIncense()').key === 'hawkeye_berry' && w.bag.calm_berry === 1, 'D: only one burns; the replaced one is gone');
    ok(w.refreshes.length === 2, 'D: each start refreshes the spawn view (sight may change)');
    ok(near(w.run('bonusIncenseRemainingMs()'), 5 * 60000, 1), 'D: Hawk-Eye has 5 min');
    w.tick(5 * 60000 - 1);
    ok(w.run('readActiveBonusIncense()') !== null, 'D: still burning just before the end');
    w.tick(1);
    ok(w.run('readActiveBonusIncense()') === null && !w.ls.has('cc.activeBonusIncense.v1'), 'D: expires on the wall clock and clears its key');
    // Save import keeps the original start; ignores expired / unknown.
    w.run('setActiveBonusIncenseState(__a[0])', [{ key: 'owleye_berry', startMs: w.now() - 10 * 60000 }]);
    ok(near(w.run('bonusIncenseRemainingMs()'), 5 * 60000, 1), 'D: imported berry keeps its remaining time');
    w.run('setActiveBonusIncenseState(__a[0])', [{ key: 'candy_berry', startMs: w.now() - 16 * 60000 }]);
    ok(w.run('readActiveBonusIncense()').key === 'owleye_berry', 'D: an expired import is ignored');
    w.run('setActiveBonusIncenseState(__a[0])', [{ key: 'nope', startMs: w.now() }]);
    ok(w.run('readActiveBonusIncense()').key === 'owleye_berry', 'D: an unknown key is ignored');
  }

  // ── E. effects ──
  {
    const w = makeWorld({ bag: { candy_berry: 1, calm_berry: 1, hawkeye_berry: 1, owleye_berry: 1 } });
    const mult = (k) => w.run('_candyMultiplier(__a[0])', [k]);
    const rate = (k) => w.run('_catchShakeRate(ITEMS[__a[0]])', [k]);
    const p = (r) => r * r * r;
    const items = w.run('ITEMS');
    ok(mult(null) === 1 && mult('poke_ball') === 1 && mult('candy_ball') === 2, 'E: no berry: Candy Ball 2×, others 1×');
    ok(rate('poke_ball') === items.poke_ball.catchShakeRate, 'E: no berry: catch rate unchanged');
    ok(w.run('_visibilityRadiusM()') === 100, 'E: no berry: 100 m');

    w.run('activateBonusIncense("candy_berry")');
    ok(mult(null) === 2 && mult('great_ball') === 2 && mult('candy_ball') === 4, 'E: Candy Berry: 2× (hatches too), 4× with a Candy Ball');
    ok(rate('great_ball') === items.great_ball.catchShakeRate && w.run('_visibilityRadiusM()') === 100, 'E: Candy Berry touches nothing else');

    w.run('activateBonusIncense("calm_berry")');
    ok(mult('candy_ball') === 2, 'E: replacing the Candy Berry ends its bonus');
    for (const k of ['poke_ball', 'great_ball', 'candy_ball']) {
      const before = 1 - p(items[k].catchShakeRate), after = 1 - p(rate(k));
      ok(near(after, before / 2, 1e-9), `E: Calm Berry halves the miss for ${k} (${(before * 100).toFixed(1)}% → ${(after * 100).toFixed(1)}%)`);
    }

    w.run('activateBonusIncense("hawkeye_berry")');
    ok(w.run('_visibilityRadiusM()') === 300, 'E: Hawk-Eye: 300 m');
    w.run('activateBonusIncense("owleye_berry")');
    ok(w.run('_visibilityRadiusM()') === 200, 'E: Owl-Eye: 200 m');
    w.tick(15 * 60000);
    ok(w.run('_visibilityRadiusM()') === 100, 'E: back to 100 m when it runs out');

    const step = (cur, target) => w.run('_stepScanRadius(__a[0], __a[1])', [cur, target]);
    const ramp = [];
    for (let r = 100; r < 300; ) { r = step(r, 300); ramp.push(r); }
    ok(ramp.join(',') === '150,200,250,300', 'E: the scan grows 50 m a refresh up to 300 m');
    ok(step(300, 100) === 100 && step(250, 200) === 200, 'E: …and shrinks at once');
    ok(step(100, 100) === 100, 'E: steady at 100 m');
  }

  // ── E2. Care / Warm Berry through the real _creditMeters ──
  {
    const w = makeWorld({ bag: { care_berry: 1, warm_berry: 1 } });
    let slots = [{ id: 's1', distM: 0 }];
    let eggs = [{ id: 'e1', incubatedM: 0 }];
    const lootTicks = [];
    Object.assign(w.ctx, {
      window: { dispatchEvent: (e) => { if (e.type === 'cc-daycare-loot-tick') lootTicks.push(e.detail); } },
      CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } },
      _summaryCache: null, _localDayKey: () => 'd', _stepsDayKey: (k) => k + 's',
      _idbPutSummary: async () => {},
      readDaycareSlots: () => slots.map((s) => ({ ...s })), writeDaycareSlots: (v) => { slots = v; },
      _applyDaycareConversionsToSlot: () => false,
      DAYCARE_LOOT_MILESTONE_M: 1000,
      readIncubator: () => ['e1'], readEggs: () => eggs.map((e) => ({ ...e })), writeEggs: (v) => { eggs = v; },
      _isBadEgg: () => false, eggIncubatedM: (e) => e.incubatedM || 0, eggHatchM: () => 5000,
    });
    vm.runInContext(extract('function _creditMeters('), w.ctx);
    const credit = (m) => w.run('_creditMeters(__a[0], 0, 0)', [m]);
    credit(100);
    ok(slots[0].distM === 100 && eggs[0].incubatedM === 100, 'E2: no berry: 1×');
    w.run('activateBonusIncense("care_berry")');
    credit(100);
    ok(slots[0].distM === 300 && eggs[0].incubatedM === 200, 'E2: Care Berry: daycare 2×, eggs 1×');
    credit(400);
    ok(slots[0].distM === 1100 && lootTicks.length === 1, 'E2: …so daycare drops come twice as fast');
    w.run('activateBonusIncense("warm_berry")');
    credit(100);
    ok(slots[0].distM === 1200 && eggs[0].incubatedM === 800, 'E2: Warm Berry: eggs 2×, daycare 1×');
    credit(10000);
    ok(eggs[0].incubatedM === 5000, 'E2: eggs still cap at their hatch distance');
    w.tick(30 * 60000);
    credit(100);
    ok(slots[0].distM === 11300 && eggs[0].incubatedM === 5000, 'E2: back to 1× when it runs out');
  }

  // ── F. wiring ──
  {
    // Catches: the real recordCaptureFromSpawn, candy from _candyMultiplier.
    const w = makeWorld({ bag: { candy_berry: 1 } });
    const awarded = [];
    Object.assign(w.ctx, {
      _whenReady: async () => {}, _whenPoisReady: async () => {},
      _markers: new Map(), _shinyBySpawn: new Map(),
      resolveSpawnVariant: async () => 0, _resolveShinyForCatch: () => null,
      _capStore: { add: () => {} },
      CANDY_LEGENDARY_CAPTURE: 50, CANDY_EVOLVED_CAPTURE: 20,
      awardCandyForCapture: (a, b, n) => awarded.push(n),
      awardCandyForSolo: (id, n) => awarded.push(n),
      _logCreatureError: (where, e) => { throw e; },
      markSpawnCaught: () => {}, removeMarker: () => {},
      readCapturedCreatures: () => [1, 2],
      navigator: {},
    });
    w.ctx.global.Packs = null;
    w.ctx.global.CreatureCollectAPI = null;
    vm.runInContext(extract('async function recordCaptureFromSpawn('), w.ctx);
    const catchWith = async (spawn, ballKey) => {
      w.ctx.__s = spawn; w.ctx.__o = ballKey ? { ballKey } : undefined;
      await vm.runInContext('recordCaptureFromSpawn(__s, __o)', w.ctx);
      return awarded[awarded.length - 1];
    };
    const wild = { id: 'x', speciesA: 1, speciesB: 4, lat: null, lng: null };
    ok(await catchWith(wild, 'poke_ball') === 2, 'F: wild catch, no bonus → 2 candy');
    ok(await catchWith(wild, 'candy_ball') === 4, 'F: Candy Ball → 4');
    ok(await catchWith({ ...wild, evolved: true }, 'candy_ball') === 40, 'F: radar (evolved) catch with a Candy Ball → 40');
    w.run('activateBonusIncense("candy_berry")');
    ok(await catchWith({ ...wild, legendary: true }, 'candy_ball') === 200, 'F: legendary + Candy Ball + Candy Berry → 200 (4×)');
    ok(await catchWith(wild) === 4, 'F: a focus grant (no ball) still gets the berry\'s 2×');

    // Hatches: the real hatchEgg.
    const hatchCalls = [];
    let eggs = [{ id: 'e1', speciesA: 1, speciesB: 4, sizeM: 1 }];
    Object.assign(w.ctx, {
      CANDY_HATCH_CAPTURE: 10,
      readEggs: () => eggs, writeEggs: (a) => { eggs = a; },
      eggReadyToHatch: () => true,
      _pickHatchVariant: async () => 'auto',
      _rollFreshShinyVariant: () => null,
      markFusionSeen: () => {}, removeFromIncubator: () => {}, _updateEggBubble: () => {},
      awardCandyForCapture: (a, b, n) => hatchCalls.push(n),
    });
    w.ctx.global.CreatureCollectAPI = null;
    vm.runInContext(extract('async function hatchEgg('), w.ctx);
    await vm.runInContext('hatchEgg("e1")', w.ctx);
    ok(hatchCalls[0] === 20, 'F: egg hatch under a Candy Berry → 20 candy (2× of 10)');

    // The throw: boosted rate, and it tells the capture which ball landed.
    const tb = extract('async function _throwBallImpl(');
    ok(/const rate = _catchShakeRate\(meta\);/.test(tb), 'F: the throw rolls at _catchShakeRate (Calm Berry; Steady Catch shares it)');
    ok(/_guaranteedThrowPlan\(rate,/.test(tb), 'F: Steady Catch plans with that same rate');
    ok(/recordCaptureFromSpawn\(spawn, \{ ballKey \}\)/.test(tb), 'F: the catch records which ball landed it');
    ok(/_spawnsAround\(cLat, cLng, focusOn, _radiusNowM\)/.test(extract('function refreshSpawnOverlay(')),
      'F: the spawn overlay scans the ramped radius');

    // Bag: Use button, ordering, and the replace warning.
    const w2 = makeWorld({ bag: { calm_berry: 1, candy_berry: 1 } });
    const msgs = [];
    let answer = true;
    Object.assign(w2.ctx, {
      confirm: (m) => { msgs.push(m); return answer; }, alert: (m) => msgs.push('alert:' + m),
      renderBag: () => {},
    });
    vm.runInContext(extract('function _confirmUseBonusIncense('), w2.ctx);
    w2.run('_confirmUseBonusIncense("calm_berry")');
    ok(/^Use a Calm Berry\?\n\nFor 15 minutes, wild pokémon break out/.test(msgs[0]) && !/replaces/.test(msgs[0]),
      'F: first use asks, with no replace warning');
    w2.tick(3 * 60000);
    answer = false;
    w2.run('_confirmUseBonusIncense("candy_berry")');
    ok(/Only one bonus incense burns at a time: this replaces your active Calm Berry \(~12 min left\)/.test(msgs[1]),
      'F: using another warns it replaces the active one');
    ok(w2.run('readActiveBonusIncense()').key === 'calm_berry' && w2.bag.candy_berry === 1, 'F: declining changes nothing');
    const rb = extract('function renderBag(');
    ok(/bag-use-bonus/.test(rb) && /_confirmUseBonusIncense\(btn\.dataset\.bonus\)/.test(rb), 'F: berries get a Use button');
    ok(/bag-bonus-banner/.test(rb) && /bag-bonus-countdown/.test(rb), 'F: an active berry shows a countdown banner');
    // Bag ordering (berries right after the community pass) is bag-sort.test.js's.

    // Save file.
    ok(/activeBonusIncense: \(window\.Creatures && window\.Creatures\.getActiveBonusIncense\)/.test(html), 'F: the save exports the active berry');
    ok(/window\.Creatures\.setActiveBonusIncenseState\(data\.activeBonusIncense\)/.test(html), 'F: …and a load adopts it');
    ok(/getActiveBonusIncense: readActiveBonusIncense,/.test(src) && /\n\s+setActiveBonusIncenseState,\n/.test(src), 'F: both are exported');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
