// Daily type (static/spawns.js currentWeather): from DAILY_BIAS_FROM_DAY
// each day's type is a weighted draw — weight = days since the type was
// last the daily one, 0 for that week's weekly — so long-absent types come
// up more and the daily never repeats the weekly. Earlier days keep the
// old per-day hash; the chain is deterministic (every player agrees).
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
const N = globalThis.Types.list().length;
ok(CUT === Math.floor(Date.UTC(2026, 9, 27) / DAY), 'cut-over is the 2026-10-27 UTC day boundary');

const at = (d, h = 12) => S.currentWeather(d * DAY + h * 3600000);
const DAYS = 730;
const chain = [];
for (let d = CUT; d < CUT + DAYS; d++) chain.push(at(d));

// Never the weekly.
ok(chain.every((w) => w.daily !== w.weekly), 'the daily type is never that week\'s weekly type');
// Same type all day (start, middle, end of the UTC day).
ok([0, 5, 23.99].every((h) => at(CUT + 10, h).daily === chain[10].daily), 'one type for the whole UTC day');

// Long-absent types come back: the gap since a type was last daily stays
// short compared with a plain random pick.
const gaps = [];
const last = new Map();
chain.forEach((w, i) => { if (last.has(w.daily)) gaps.push(i - last.get(w.daily)); last.set(w.daily, i); });
const maxGap = Math.max(...gaps);
const quickRepeats = gaps.filter((g) => g <= 3).length / gaps.length;
// Reference: the old per-day hash, over the DAYS before the cut-over.
const hGaps = [], hLast = new Map();
for (let i = 0; i < DAYS; i++) {
  const t = at(CUT - DAYS + i).daily;
  if (hLast.has(t)) hGaps.push(i - hLast.get(t));
  hLast.set(t, i);
}
const hMax = Math.max(...hGaps), hQuick = hGaps.filter((g) => g <= 3).length / hGaps.length;
console.log(`biased chain: max gap ${maxGap} days, repeats within 3 days ${(quickRepeats * 100).toFixed(1)}%`
  + ` | old hash: max gap ${hMax}, quick repeats ${(hQuick * 100).toFixed(1)}% (${N} types)`);
ok(maxGap < hMax && quickRepeats < hQuick / 2, 'fewer quick repeats and shorter droughts than the old hash');
ok(maxGap <= 4 * N, `no type is absent for long (max gap ${maxGap} ≤ ${4 * N} days)`);
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

// Deterministic: a fresh load, asked out of order, gives the same chain.
S = load();
const far = at(CUT + 500).daily;
ok(far === chain[500].daily, 'asking a far day first gives the same answer (replayed, not order-dependent)');
ok(chain.every((w, i) => at(CUT + i).daily === w.daily), 'a fresh load reproduces the whole chain');
ok(before.every((t, i) => at(CUT - 30 + i).daily === t), 'and the pre-cut-over days');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
