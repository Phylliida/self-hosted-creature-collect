// Daily type (static/spawns.js currentWeather): from DAILY_BIAS_FROM_DAY
// each day's type is a weighted draw by how long each type has gone
// without being the daily one, 0 for that week's weekly — so the daily
// never repeats the weekly. Until DAILY_RAMP_FROM_DAY the weight is plain
// days-since; from then on it refills (1 → n over n days), holds, then
// climbs by n a day past day n + 2, so droughts stay short. Earlier days
// keep the old per-day hash; the chain is deterministic (every player
// agrees). Spawns.dailyForecast gives tomorrow's odds from the same weights.
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
const RAMP = S.DAILY_RAMP_FROM_DAY;
const N = globalThis.Types.list().length;
ok(CUT === Math.floor(Date.UTC(2026, 9, 27) / DAY), 'cut-over is the 2026-10-27 UTC day boundary');
ok(RAMP === Math.floor(Date.UTC(2026, 10, 3) / DAY), 'ramp starts on the 2026-11-03 UTC day boundary');

const at = (d, h = 12) => S.currentWeather(d * DAY + h * 3600000);

// The days-since days already shown before the ramp never change.
const shown = ['FLYING', 'GROUND', 'GHOST', 'ELECTRIC', 'DARK', 'DRAGON', 'FIGHTING'];
ok(RAMP - CUT === shown.length && shown.every((t, i) => at(CUT + i).daily === t),
  'Oct 27 – Nov 2 keep the daily types players already saw');

const DAYS = 730;
const chain = [];
for (let d = RAMP; d < RAMP + DAYS; d++) chain.push(at(d));

// Never the weekly.
ok(chain.every((w) => w.daily !== w.weekly), 'the daily type is never that week\'s weekly type');
// Same type all day (start, middle, end of the UTC day).
ok([0, 5, 23.99].every((h) => at(RAMP + 10, h).daily === chain[10].daily), 'one type for the whole UTC day');

// Droughts stay short and quick repeats rare, compared with a plain random pick.
const gaps = [];
const last = new Map();
chain.forEach((w, i) => { if (last.has(w.daily)) gaps.push(i - last.get(w.daily)); last.set(w.daily, i); });
const maxGap = Math.max(...gaps);
const quickRepeats = gaps.filter((g) => g <= 3).length / gaps.length;
const over30 = gaps.filter((g) => g > 30).length / gaps.length;
// Reference: the old per-day hash, over the DAYS before the cut-over.
const hGaps = [], hLast = new Map();
for (let i = 0; i < DAYS; i++) {
  const t = at(CUT - DAYS + i).daily;
  if (hLast.has(t)) hGaps.push(i - hLast.get(t));
  hLast.set(t, i);
}
const hMax = Math.max(...hGaps), hQuick = hGaps.filter((g) => g <= 3).length / hGaps.length;
console.log(`ramped chain: max gap ${maxGap} days, repeats within 3 days ${(quickRepeats * 100).toFixed(1)}%,`
  + ` gaps over 30 days ${(over30 * 100).toFixed(1)}% | old hash: max gap ${hMax},`
  + ` quick repeats ${(hQuick * 100).toFixed(1)}% (${N} types)`);
ok(maxGap < hMax && quickRepeats < hQuick / 2, 'fewer quick repeats and shorter droughts than the old hash');
ok(maxGap <= 45, `no type is absent for long (max gap ${maxGap} ≤ 45 days)`);
ok(over30 < 0.05, `gaps over 30 days are rare (${(over30 * 100).toFixed(1)}%)`);
ok(quickRepeats < 0.05, `a type rarely comes back within 3 days (${(quickRepeats * 100).toFixed(1)}%)`);
// Still every type, roughly evenly.
const counts = new Map();
for (const w of chain) counts.set(w.daily, (counts.get(w.daily) || 0) + 1);
const mean = DAYS / N;
ok(counts.size === N && [...counts.values()].every((c) => c > mean * 0.6 && c < mean * 1.4),
  'every type comes up, roughly evenly');

// Days before the cut-over are unchanged (the old per-day hash).
const before = [];
for (let d = CUT - 30; d < CUT; d++) before.push(at(d).daily);
let anyRepeatOfWeekly = false;
for (let d = CUT - 400; d < CUT; d++) { const w = at(d); if (w.daily === w.weekly) anyRepeatOfWeekly = true; }
ok(anyRepeatOfWeekly, 'before the cut-over the old hash still applies (it could match the weekly)');

// ── Forecast ────────────────────────────────────────────────────────────
// fc(d) = the forecast made during day d - 1 for day d.
const fc = (d) => S.dailyForecast((d - 1) * DAY + 5 * 3600000);
ok(S.dailyForecast((CUT - 2) * DAY) === null, 'no forecast before the weighted chain exists');
let sumsOk = true, weeklyOk = true, actualOk = true, todayLowest = true, newWeekOk = true;
const bins = [[0, 0.02], [0.02, 0.06], [0.06, 0.15], [0.15, 0.35], [0.35, 1.01]].map((b) => ({ lo: b[0], hi: b[1], p: 0, hit: 0, n: 0 }));
for (let d = RAMP; d < RAMP + 3000; d++) {
  const f = fc(d), w = at(d), today = at(d - 1);
  if (Math.abs(f.odds.reduce((a, o) => a + o.p, 0) - 1) > 1e-9) sumsOk = false;
  if (f.weekly !== w.weekly || f.odds.some((o) => o.type === f.weekly)) weeklyOk = false;
  if (f.newWeek !== (Math.floor(d / 7) !== Math.floor((d - 1) / 7))) newWeekOk = false;
  if (!f.odds.some((o) => o.type === w.daily)) actualOk = false;
  // Today's type has weight 1 tomorrow — the least likely (unless it's tomorrow's weekly).
  const mine = f.odds.find((o) => o.type === today.daily);
  if (mine && mine.p !== f.odds[f.odds.length - 1].p) todayLowest = false;
  for (const o of f.odds) {
    const b = bins.find((x) => o.p >= x.lo && o.p < x.hi);
    b.n++; b.p += o.p; if (o.type === w.daily) b.hit++;
  }
}
ok(sumsOk, 'forecast odds sum to 1');
ok(weeklyOk, 'forecast leaves out tomorrow\'s weekly type (and names it)');
ok(newWeekOk, 'forecast flags when tomorrow starts a new week');
ok(actualOk, 'the actual daily type always had a nonzero forecast');
ok(todayLowest, 'today\'s type is the least likely tomorrow');
// Calibration: within each probability band, the types forecast there come
// up about as often as forecast.
for (const b of bins) {
  if (b.n < 200) continue;
  const exp = b.p / b.n, got = b.hit / b.n;
  console.log(`  forecast ${b.lo}–${b.hi}: predicted ${(exp * 100).toFixed(1)}%, happened ${(got * 100).toFixed(1)}% (n=${b.n})`);
  ok(Math.abs(got - exp) < Math.max(0.01, exp * 0.2), `forecast is calibrated in the ${b.lo}–${b.hi} band`);
}

// Deterministic: a fresh load, asked out of order, gives the same chain and forecast.
const fc500 = fc(RAMP + 500);
S = load();
const far = at(RAMP + 500).daily;
ok(far === chain[500].daily, 'asking a far day first gives the same answer (replayed, not order-dependent)');
ok(JSON.stringify(fc(RAMP + 500)) === JSON.stringify(fc500), 'a fresh load gives the same forecast');
S = load();
ok(JSON.stringify(fc(RAMP + 500)) === JSON.stringify(fc500), 'forecast first (before any weather call) agrees too');
ok(chain.every((w, i) => at(RAMP + i).daily === w.daily), 'a fresh load reproduces the whole chain');
ok(before.every((t, i) => at(CUT - 30 + i).daily === t), 'and the pre-cut-over days');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
