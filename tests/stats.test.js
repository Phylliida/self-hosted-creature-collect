// Tests the Stats page's pure parts in static/creatures.js: the stats
// journal (counts per local day, flushed in batches, merged from a save
// by per-day maxima), the period maths (Monday weeks, month / year
// buckets, all time by month or year, ‹ › limits), the "same point last
// week" comparison, the Caught split at the journal's start, axis ticks,
// calendar shading, and the theme ramps: every theme in index.html must
// get chart shades that stay ordered and readable on its panel.
//
// Run: node tests/stats.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'static', 'creatures.js'), 'utf8');
// comment- and string-aware brace extractor (as in tests/focus-mode.test.js)
function extract(marker, from) {
  const start = src.indexOf(marker, from || 0);
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
// A `const name = …;` line (single statement, possibly multi-line arrow).
function constLine(name) {
  const re = new RegExp(`\\n  const ${name} = [\\s\\S]*?;\\n`);
  const m = src.match(re);
  if (!m) throw new Error('const not found: ' + name);
  return m[0];
}

// ── 1. Journal ──
const store = {};
const timers = [];
const ctx = {
  Object, Array, Math, Number, JSON, Date, Map, Set, String, RegExp,
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
  setTimeout: (fn) => { timers.push(fn); return timers.length; },
  clearTimeout: () => {},
  _logCreatureError: (w, e) => { throw e; },
};
vm.createContext(ctx);
vm.runInContext(`var STATS_KEY = 'cc.stats.v1'; var _statsPending = null, _statsTimer = null, _statsMuted = 0;`, ctx);
for (const f of ['function _localDayKey(', 'function _statsRead(', 'function _statsFlush(', 'function noteStat(',
  'function _statsInit(', 'function exportStats(', 'function mergeStats(']) vm.runInContext(extract(f), ctx);
const run = (code, vars) => vm.runInContext(code, Object.assign(ctx, vars || {}));
{
  const day = (y, m, d, h) => new Date(y, m - 1, d, h || 12).getTime();
  run('_statsInit()');
  const since = JSON.parse(store['cc.stats.v1']).since;
  ok(Number.isFinite(since), '1: init stamps "tracked since"');
  run('_statsInit()');
  ok(JSON.parse(store['cc.stats.v1']).since === since, '1: init leaves an existing journal alone');
  run(`noteStat('spins'); noteStat('spins'); noteStat('u:poke_ball', 3); noteStat('candy', 0); noteStat('candy', -2);`);
  run(`noteStat('spins', 1, __t)`, { __t: day(2026, 10, 1, 23) });
  ok(Object.keys(JSON.parse(store['cc.stats.v1']).days).length === 0, '1: counts wait for the flush');
  ok(timers.length === 1, '1: one flush scheduled for a burst of counts');
  timers.shift()();
  const j = JSON.parse(store['cc.stats.v1']);
  const today = run('_localDayKey()');
  ok(j.days[today].spins === 2 && j.days[today]['u:poke_ball'] === 3, '1: counts land on today');
  ok(!('candy' in j.days[today]), '1: zero / negative counts are ignored');
  ok(j.days['2026-10-01'].spins === 1, '1: a timestamp lands on its own local day');
  run(`_statsMuted = 1; noteStat('candy', 5); _statsMuted = 0; _statsFlush();`);
  ok(!JSON.parse(store['cc.stats.v1']).days[today].candy, '1: muted counts (candy migration) are dropped');
  // Wiping storage can't be undone by memory (only deltas are held).
  run(`noteStat('enc')`);
  delete store['cc.stats.v1'];
  run('_statsFlush()');
  const w = JSON.parse(store['cc.stats.v1']);
  ok(w.days[today].enc === 1 && !w.days[today].spins, '1: after a wipe only the pending count is written');
  // Merge from a save: per day + key, the larger wins; since → earlier.
  store['cc.stats.v1'] = JSON.stringify({ v: 1, since: 2000, days: { '2026-10-01': { spins: 4, enc: 2 } } });
  run(`mergeStats({ v: 1, since: 1000, days: { '2026-10-01': { spins: 3, enc: 5, evolved: 1 }, 'junk': { spins: 9 }, '2026-09-30': { candy: 'x', go: 2 } } })`);
  const mj = JSON.parse(store['cc.stats.v1']);
  ok(mj.days['2026-10-01'].spins === 4 && mj.days['2026-10-01'].enc === 5 && mj.days['2026-10-01'].evolved === 1, '1: merge keeps the larger count per key');
  ok(!mj.days.junk && mj.days['2026-09-30'].go === 2 && !('candy' in mj.days['2026-09-30']), '1: merge skips bad days and values');
  ok(mj.since === 1000, '1: merge takes the earlier "since"');
  run(`mergeStats({ v: 1, since: 1000, days: { '2026-10-01': { spins: 3, enc: 5, evolved: 1 } } })`);
  ok(JSON.stringify(JSON.parse(store['cc.stats.v1'])) === JSON.stringify(mj), '1: re-importing the same save changes nothing');
}

// ── 2. Periods ──
const pctx = { Object, Array, Math, Number, JSON, Date, Map, Set, String, RegExp };
vm.createContext(pctx);
for (const f of ['function _localDayKey(', 'function _stDay0(', 'function _stAddDays(', 'function _stParseDay(',
  'function _stEachDay(', 'function _stPeriod(', 'function _stAgg(', 'function _stCompare(', 'function _stNice(',
  'function _stHeatLevels(']) vm.runInContext(extract(f), pctx);
vm.runInContext(constLine('_stInc'), pctx);
const prun = (code, vars) => vm.runInContext(code, Object.assign(pctx, vars || {}));
const K = (d) => prun('_localDayKey(__d)', { __d: d });
{
  const idx = { first: '2025-03-10', since: '2026-10-14', days: new Map() };
  // A Thursday: the week runs Monday → Sunday.
  const thu = new Date(2026, 9, 15, 15).getTime();
  const w = prun(`_stPeriod('week', __a, __i)`, { __a: thu, __i: idx });
  ok(K(w.start) === '2026-10-12' && K(w.end) === '2026-10-19' && w.buckets.length === 7 && w.unit === 'day', '2: week = Mon 12 → Sun 18');
  ok(K(new Date(w.prevMs)) === '2026-10-05', '2: ‹ goes to the week before');
  const m = prun(`_stPeriod('month', __a, __i)`, { __a: new Date(2026, 1, 10).getTime(), __i: idx });
  ok(m.buckets.length === 28 && K(m.start) === '2026-02-01', '2: February 2026 has 28 day buckets');
  ok(K(new Date(m.nextMs)) === '2026-03-01', '2: › on a past month goes to the next');
  const y = prun(`_stPeriod('year', __a, __i)`, { __a: new Date(2025, 5, 1).getTime(), __i: idx });
  ok(y.buckets.length === 12 && y.unit === 'month', '2: a year has 12 month buckets');
  ok(y.prevMs === null, '2: no ‹ before the first data (2025 holds the first day)');
  const now = Date.now();
  const cur = prun(`_stPeriod('month', __a, __i)`, { __a: now, __i: idx });
  ok(cur.isCurrent && cur.nextMs === null, '2: the current month has no ›');
  const all = prun(`_stPeriod('all', __a, __i)`, { __a: now, __i: idx });
  ok(all.unit === 'month' && K(all.start) === '2025-03-01', '2: all time by month from the first data month');
  const old = prun(`_stPeriod('all', __a, __i)`, { __a: now, __i: Object.assign({}, idx, { first: '2019-06-01' }) });
  ok(old.unit === 'year' && old.buckets[0].s.getFullYear() === 2019, '2: over three years, all time goes by year');
  // DST: a week across the October change still has 7 one-day buckets.
  const dst = prun(`_stPeriod('week', __a, __i)`, { __a: new Date(2026, 9, 28).getTime(), __i: idx });
  ok(dst.buckets.every((b) => b.s.getHours() === 0) && new Set(dst.buckets.map((b) => K(b.s))).size === 7, '2: weeks stay 7 distinct midnights across DST');
}

// ── 3. Aggregation: the Caught split and "same point last week" ──
{
  const days = new Map();
  const add = (k, r) => days.set(k, Object.assign({ caps: [], types: {}, src: {}, usedBy: {}, foundBy: {}, focus: [] }, r));
  add('2026-10-12', { caught: 5, src: { wild: 5 }, types: { FIRE: 2 } });        // before tracking
  add('2026-10-14', { caught: 6, new: 2, fresh: 1, src: { wild: 4, egg: 2 }, types: { FIRE: 1, WATER: 3 }, balls: 7, used: 9, usedBy: { poke_ball: 7, berry: 2 } });
  const idx = { first: '2026-10-12', since: '2026-10-14', days };
  const a = prun(`_stAgg(__i, new Date(2026, 9, 12), new Date(2026, 9, 19))`, { __i: idx });
  ok(a.caught === 11 && a.caughtU === 5 && a.caughtT === 6, '3: Caught splits at the journal start (5 before, 6 after)');
  ok(a.new === 2 && a.fresh === 1, '3: New / Fresh add up');
  ok(a.types.FIRE === 3 && a.types.WATER === 3 && a.usedBy.poke_ball === 7, '3: maps merge');
  ok(a.wildT === 4, '3: catches that took a ball (tracked days, not hatches)');
  // Compare: a current period is measured against the same span before.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const p = { range: 'week', isCurrent: true, start: prun('_stAddDays(__t, -2)', { __t: today }), end: prun('_stAddDays(__t, 5)', { __t: today }) };
  p.prevStart = prun('_stAddDays(__s, -7)', { __s: p.start });
  const k0 = (n) => K(prun('_stAddDays(__t, __n)', { __t: today, __n: n }));
  const d2 = new Map();
  for (const n of [-9, -8, -7, -6, -2, -1, 0]) d2.set(k0(n), { caught: 1, caps: [], types: {}, src: {}, usedBy: {}, foundBy: {}, focus: [] });
  const c = prun(`_stCompare(__i, __p)`, { __i: { first: k0(-30), since: k0(-30), days: d2 }, __p: p });
  ok(c.cur.caught === 3 && c.days === 3, '3: this period so far = 3 days, 3 caught');
  ok(c.prev.caught === 3, '3: compared with the same 3 days a week earlier (not the whole week)');
}

// ── 4. Ticks + shading ──
{
  const nice = (max, fmt) => prun('_stNice(__m, __f)', { __m: max, __f: { fmt } });
  const n3 = nice(3);
  ok(n3.top === 4 && n3.step === 2, '4: max 3 → ticks 0, 2, 4');
  ok(nice(1).step === 1 && nice(1).top === 1, '4: counts never get fractional ticks');
  ok(nice(870).top === 1000 && nice(870).step === 500, '4: 870 → 0, 500, 1000');
  ok(nice(0).top === 2, '4: an empty chart still has an axis');
  ok(nice(20 * 60000, 'dur').step >= 15 * 60000, '4: focus time ticks are at least 15 min apart');
  const lv = prun('_stHeatLevels(__v)', { __v: [0, 0, 1, 1, 1] });
  ok(lv(1) === 4 && lv(0) === 0, '4: one distinct amount is full strength');
  const lv2 = prun('_stHeatLevels(__v)', { __v: [1, 2, 3, 4, 5, 6, 7, 8, 100] });
  ok(lv2(100) === 4 && lv2(1) === 1 && lv2(5) >= 2 && lv2(5) <= 3, '4: quartiles — one huge day doesn\'t wash the rest out');
}

// ── 5. Theme ramps: ordered and readable in every theme ──
{
  const rctx = { Object, Array, Math, Number, String };
  vm.createContext(rctx);
  for (const n of ['_stS2L', '_stL2S', '_stLum', '_stContrast', '_stHex']) vm.runInContext(constLine(n), rctx);
  for (const f of ['function _stLab(', 'function _stLch(', 'function _stRamp(']) vm.runInContext(extract(f), rctx);
  const html = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
  const t0 = html.indexOf('window.THEMES = {');
  const t1 = html.indexOf('\n  };', t0);
  const THEMES = vm.runInNewContext('(' + html.slice(html.indexOf('{', t0), t1 + 4).replace(/;\s*$/, '') + ')');
  const rgb = (h) => {
    h = String(h).trim();
    if (h.length === 4) h = '#' + [...h.slice(1)].map((x) => x + x).join('');
    return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  };
  const names = Object.keys(THEMES);
  ok(names.length >= 40, `5: read the themes from index.html (${names.length})`);
  const bad = [];
  for (const name of names) {
    const u = THEMES[name].ui || {};
    const bg = rgb(u.panelBg || '#ffffff'), acc = rgb(u.accent || '#b06cff');
    for (const n of [3, 4]) {
      const ramp = vm.runInContext('_stRamp(__a, __b, __n, 2.2, 8)', Object.assign(rctx, { __a: acc, __b: bg, __n: n }));
      const cs = ramp.map((h) => vm.runInContext('_stContrast(__x, __b)', Object.assign(rctx, { __x: rgb(h), __b: bg })));
      if (cs[0] < 2.0) bad.push(`${name}: palest step ${cs[0].toFixed(2)}:1`);
      for (let i = 1; i < cs.length; i++) if (cs[i] < cs[i - 1] * 1.12) bad.push(`${name}: steps ${i - 1}/${i} too close (${cs[i - 1].toFixed(2)} → ${cs[i].toFixed(2)})`);
    }
    const bar = vm.runInContext('_stRamp(__a, __b, 1, 4, 4)[0]', Object.assign(rctx, { __a: acc, __b: bg }));
    const cb = vm.runInContext('_stContrast(__x, __b)', Object.assign(rctx, { __x: rgb(bar), __b: bg }));
    if (cb < 3) bad.push(`${name}: bar ${cb.toFixed(2)}:1`);
  }
  ok(!bad.length, '5: every theme gets ordered, readable shades' + (bad.length ? ' — ' + bad.slice(0, 6).join('; ') : ''));
}

// ── 6. Line view: a monotone curve; calendar cell numbers ──
{
  const lctx = { Object, Array, Math, Number, String };
  vm.createContext(lctx);
  vm.runInContext(extract('function _stSmoothPath('), lctx);
  vm.runInContext(extract('function _stCellFmt('), lctx);
  // Spiky data (SVG y grows downward; 150 = the zero line).
  const pts = [[0, 150], [10, 20], [20, 150], [30, 150], [40, 140], [50, 30], [60, 31], [70, 150]];
  const d = vm.runInContext('_stSmoothPath(__p)', Object.assign(lctx, { __p: pts }));
  const segs = d.split('C').slice(1).map((c) => c.trim().split(/[ ,]+/).map(Number));
  ok(segs.length === pts.length - 1, '6: one cubic per gap between days');
  let within = true;
  segs.forEach((c, i) => {
    const lo = Math.min(pts[i][1], pts[i + 1][1]) - 1e-6, hi = Math.max(pts[i][1], pts[i + 1][1]) + 1e-6;
    if (c[1] < lo || c[1] > hi || c[3] < lo || c[3] > hi) within = false;
  });
  ok(within, '6: control points stay between neighbouring days (no dips below zero, no invented peaks)');
  ok(/^M0,150L10,20$/.test(vm.runInContext('_stSmoothPath(__p)', Object.assign(lctx, { __p: pts.slice(0, 2) }))), '6: two days → a straight segment');
  const cf = (m, v) => vm.runInContext('_stCellFmt(__m, __v)', Object.assign(lctx, { __m: m, __v: v }));
  ok(cf({}, 7) === '7' && cf({}, 1234) === '1.2K' && cf({}, 23456) === '23K', '6: counts fit a cell (7, 1.2K, 23K)');
  ok(cf({ fmt: 'dist' }, 5230) === '5.2' && cf({ fmt: 'dist' }, 12400) === '12', '6: distance in km (5.2, 12)');
  ok(cf({ fmt: 'dur' }, 45 * 60000) === '45m' && cf({ fmt: 'dur' }, 150 * 60000) === '2.5h', '6: focus time (45m, 2.5h)');
}

console.log(`stats: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
