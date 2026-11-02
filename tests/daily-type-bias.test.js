// Daily type (static/spawns.js currentWeather):
//   - before DAILY_BIAS_FROM_DAY: a per-day hash;
//   - DAILY_BIAS_FROM_DAY … DAILY_URN_FROM_DAY: a weighted draw by days since
//     each type was last the daily one (0 for that week's weekly) — these
//     days were shown and must never change;
//   - from DAILY_URN_FROM_DAY: an urn of 3 of every type, drawn one a day in
//     a seeded order until empty, then refilled.
// Everything is deterministic (every player agrees). Spawns.dailyForecast
// gives tomorrow's odds: each type's share of what's left in the urn.
//
// Run: node tests/daily-type-bias.test.js
'use strict';
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const load = () => {
  for (const f of ['types.js', 'spawns.js']) delete require.cache[require.resolve(path.join(root, 'static', f))];
  require(path.join(root, 'static', 'types.js'));
  require(path.join(root, 'static', 'spawns.js'));
  return globalThis.Spawns;
};
const DAY = 86400000;
let S = load();
const CUT = S.DAILY_BIAS_FROM_DAY;
const URN = S.DAILY_URN_FROM_DAY;
const TYPES = globalThis.Types.list();
const N = TYPES.length, SIZE = 3 * N;
ok(CUT === Math.floor(Date.UTC(2026, 9, 27) / DAY), 'weighted draws start on the 2026-10-27 UTC day boundary');
ok(URN === Math.floor(Date.UTC(2026, 10, 3) / DAY), 'the urn starts on the 2026-11-03 UTC day boundary');

const at = (d, h = 12) => S.currentWeather(d * DAY + h * 3600000);

// The weighted days already shown never change.
const shown = ['FLYING', 'GROUND', 'GHOST', 'ELECTRIC', 'DARK', 'DRAGON', 'FIGHTING'];
ok(URN - CUT === shown.length && shown.every((t, i) => at(CUT + i).daily === t),
  'Oct 27 – Nov 2 keep the daily types players already saw');

// ── The urn ──
const URNS = 30;
const chain = [];
for (let d = URN; d < URN + URNS * SIZE; d++) chain.push(at(d).daily);
let everyUrnExact = true;
for (let u = 0; u < URNS; u++) {
  const counts = new Map();
  for (const t of chain.slice(u * SIZE, (u + 1) * SIZE)) counts.set(t, (counts.get(t) || 0) + 1);
  if (counts.size !== N || [...counts.values()].some((c) => c !== 3)) everyUrnExact = false;
}
ok(everyUrnExact, `every urn (${SIZE} days) has each of the ${N} types exactly 3 times`);
ok(new Set(chain.slice(0, SIZE).join(',')).size && chain.slice(0, SIZE).join() !== chain.slice(SIZE, 2 * SIZE).join(),
  'each refill is drawn in a new order');
ok([0, 5, 23.99].every((h) => at(URN + 10, h).daily === chain[10]), 'one type for the whole UTC day');
const gaps = [], last = new Map();
chain.forEach((t, i) => { if (last.has(t)) gaps.push(i - last.get(t)); last.set(t, i); });
const maxGap = Math.max(...gaps);
console.log(`urn chain: max gap ${maxGap} days, back-to-back repeats ${(gaps.filter((g) => g === 1).length / gaps.length * 100).toFixed(1)}%`);
ok(maxGap < 2 * SIZE, `no type is absent for two whole urns (max gap ${maxGap} < ${2 * SIZE})`);

// Days before the weighted era are unchanged (the old per-day hash).
const before = [];
for (let d = CUT - 30; d < CUT; d++) before.push(at(d).daily);
let anyRepeatOfWeekly = false;
for (let d = CUT - 400; d < CUT; d++) { const w = at(d); if (w.daily === w.weekly) anyRepeatOfWeekly = true; }
ok(anyRepeatOfWeekly, 'before the cut-over the old hash still applies (it could match the weekly)');

// ── Forecast ──
const fc = (d) => S.dailyForecast((d - 1) * DAY + 5 * 3600000);
ok(S.dailyForecast((CUT - 2) * DAY) === null, 'no forecast before the weighted draws');
ok(fc(CUT + 3).urn === null && Math.abs(fc(CUT + 3).odds.reduce((a, o) => a + o.p, 0) - 1) < 1e-9,
  'a weighted-era day still gets its weighted odds');
let sumsOk = true, actualOk = true, shareOk = true, freshOk = true, goneOk = true;
for (let d = URN; d < URN + 4 * SIZE; d++) {
  const f = fc(d), actual = at(d).daily, pos = (d - URN) % SIZE;
  if (Math.abs(f.odds.reduce((a, o) => a + o.p, 0) - 1) > 1e-9) sumsOk = false;
  if (!f.odds.some((o) => o.type === actual)) actualOk = false;
  if (f.urn.left !== SIZE - pos || f.odds.some((o) => Math.abs(o.p - o.left / f.urn.left) > 1e-12)) shareOk = false;
  if ((pos === 0) !== f.urn.fresh || (pos === 0 && f.odds.some((o) => o.left !== 3))) freshOk = false;
  // What's gone is exactly what this urn already drew 3 times.
  const drawn = new Map();
  for (const t of chain.slice(d - URN - pos, d - URN)) drawn.set(t, (drawn.get(t) || 0) + 1);
  const gone = TYPES.filter((t) => drawn.get(t) === 3);
  if (gone.join() !== f.urn.gone.join()) goneOk = false;
}
ok(sumsOk, 'forecast odds sum to 1');
ok(actualOk, 'tomorrow\'s actual type is always among the forecast');
ok(shareOk, 'each type\'s chance is its share of the balls left (tomorrow\'s included)');
ok(freshOk, 'a fresh urn: every type 3 left, flagged fresh');
ok(goneOk, 'the types listed as used up are the ones drawn 3 times already');

// Deterministic: a fresh load, asked out of order, gives the same days and forecast.
const fc500 = fc(URN + 500);
S = load();
ok(at(URN + 500).daily === chain[500], 'asking a far day first gives the same answer');
ok(JSON.stringify(fc(URN + 500)) === JSON.stringify(fc500), 'a fresh load gives the same forecast');
ok(chain.every((t, i) => at(URN + i).daily === t), 'a fresh load reproduces the whole chain');
ok(before.every((t, i) => at(CUT - 30 + i).daily === t), 'and the pre-cut-over days');
ok(shown.every((t, i) => at(CUT + i).daily === t), 'and the weighted days');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
