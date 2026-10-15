// Tests focus-mode accrual logic (_focusReplay / _focusGrantsDue /
// _focusMult in static/creatures.js): the event-timeline replay that
// measures qualifying time (screen off OR app foreground) and stops at
// the session's chosen length, and the payout (9 pokémon and 45 items
// per hour; walking: +3 pokémon per km, +3 items per 4 km;
// all × the length bonus, ×1 → ×2 at a 1-day session, flat after).
//
// Run: node tests/focus-mode.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

// comment-aware brace extractor (same approach as tests/bag-sort.test.js)
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

const MIN = 60 * 1000;
const ctx = {
  Object, Array, Math, Number, JSON,
  FOCUS_CREATURE_MS: 5 * MIN / 0.75,
  FOCUS_ITEM_MS: MIN / 0.75,
  FOCUS_M_PER_CREATURE: 250 / 0.75,
  FOCUS_M_PER_ITEM: 1000 / 0.75,
  FOCUS_FULL_BONUS_MS: 24 * 60 * MIN,
};
vm.createContext(ctx);
vm.runInContext(extract('function _focusReplay('), ctx);
vm.runInContext(extract('function _focusMult('), ctx);
vm.runInContext(extract('function _focusGrantsDue('), ctx);
const replay = (events, from, to, state, need) =>
  vm.runInContext('_focusReplay(__e, __f, __t, __s, __n)',
    Object.assign(ctx, { __e: events, __f: from, __t: to, __s: state, __n: need }));
// Payout for q ms of focus + d metres, in a session of length t (default:
// a session exactly q long — the usual case, since you must finish).
const due = (q, d, t) =>
  vm.runInContext('_focusGrantsDue(__q, __d, __t)', Object.assign(ctx, { __q: q, __d: d, __t: t === undefined ? q : t }));
const mult = (t) => vm.runInContext('_focusMult(__t)', Object.assign(ctx, { __t: t }));

const FG = { screenOff: false, appFg: true };
const BG_AWAKE = { screenOff: false, appFg: false };

// ── 1. Foreground the whole span → everything qualifies ──
{
  const r = replay([], 0, 60 * MIN, FG);
  ok(r.qualifyingMs === 60 * MIN, '1: full foreground span qualifies');
  ok(r.state.appFg === true && r.state.screenOff === false, '1: state unchanged');
}

// ── 2. Backgrounding while awake pauses; re-foregrounding resumes ──
{
  const r = replay([
    { t: 10 * MIN, type: 'app_bg' },
    { t: 25 * MIN, type: 'app_fg' },
  ], 0, 60 * MIN, FG);
  ok(r.qualifyingMs === 10 * MIN + 35 * MIN, '2: backgrounded-awake span excluded');
  ok(r.state.appFg === true, '2: ends foreground');
}

// ── 3. Sleep counts fully (app_bg + screen_off … screen_on + app_fg) ──
// The two sub-second transition gaps (app_bg→screen_off at the start,
// screen_on→app_fg at the end) genuinely don't qualify under the
// "screen off OR foreground" rule — negligible at settle granularity.
{
  const r = replay([
    { t: 10 * MIN, type: 'app_bg' },
    { t: 10 * MIN + 500, type: 'screen_off' },
    { t: 50 * MIN, type: 'screen_on' },
    { t: 50 * MIN + 500, type: 'app_fg' },
  ], 0, 60 * MIN, FG);
  ok(r.qualifyingMs === 60 * MIN - 1000, '3: sleep span qualifies (minus transition gaps)');
}

// ── 4. iOS lock synonyms (locked/unlocked) behave like screen off/on ──
{
  const r = replay([
    { t: 5 * MIN, type: 'locked' },
    { t: 5 * MIN + 100, type: 'app_bg' },
    { t: 40 * MIN, type: 'unlocked' },
    { t: 40 * MIN + 100, type: 'app_fg' },
  ], 0, 60 * MIN, FG);
  ok(r.qualifyingMs === 60 * MIN - 100, '4: locked span qualifies (minus unlock gap)');
}

// ── 5. Backgrounded, THEN screen turns off (used another app, then
//        slept): only the tail qualifies ──
{
  const r = replay([
    { t: 10 * MIN, type: 'app_bg' },     // left the app, still awake
    { t: 30 * MIN, type: 'screen_off' }, // then put the phone down
    { t: 50 * MIN, type: 'screen_on' },
    { t: 50 * MIN + 500, type: 'app_fg' },
  ], 0, 60 * MIN, FG);
  const want = 10 * MIN + 20 * MIN + (10 * MIN - 500); // fg + asleep + fg
  ok(r.qualifyingMs === want, '5: backgrounded-awake middle excluded, sleep counted');
}

// ── 6. Events outside [fromMs, toMs) are ignored; state chains ──
{
  const first = replay([{ t: 10 * MIN, type: 'app_bg' }], 0, 20 * MIN, FG);
  ok(first.qualifyingMs === 10 * MIN, '6: first window stops accruing at app_bg');
  ok(first.state.appFg === false, '6: first window ends backgrounded');
  // Second window chains off the first's end state; an event from
  // BEFORE fromMs must not leak in.
  const second = replay([{ t: 5 * MIN, type: 'app_fg' }], 20 * MIN, 40 * MIN, first.state);
  ok(second.qualifyingMs === 0, '6: stale event before fromMs ignored');
  ok(second.state.appFg === false, '6: still backgrounded');
  const third = replay([{ t: 25 * MIN, type: 'app_fg' }], 20 * MIN, 40 * MIN, second.state);
  ok(third.qualifyingMs === 15 * MIN, '6: resume mid-window accrues the tail');
}

// ── 7. Unsorted / malformed events don't corrupt the result ──
{
  const r = replay([
    { t: 30 * MIN, type: 'app_fg' },
    { t: 10 * MIN, type: 'app_bg' },
    { t: NaN, type: 'screen_off' },
    null,
    { t: 90 * MIN, type: 'screen_off' },   // beyond toMs
  ], 0, 60 * MIN, FG);
  ok(r.qualifyingMs === 10 * MIN + 30 * MIN, '7: out-of-order + junk events handled');
}

// ── 8. Web fallback shape: hidden tab = app_bg, screen always on ──
{
  // Tab hidden for the whole window.
  const r = replay([], 0, 60 * MIN, BG_AWAKE);
  ok(r.qualifyingMs === 0, '8: hidden tab accrues nothing on web');
}

// ── 9. The sandbox constants mirror creatures.js ──
{
  // So a rate change there can't leave this test validating a schedule
  // the game no longer runs.
  for (const k of ['FOCUS_CREATURE_MS', 'FOCUS_ITEM_MS', 'FOCUS_M_PER_CREATURE', 'FOCUS_M_PER_ITEM', 'FOCUS_FULL_BONUS_MS']) {
    const m = new RegExp('const ' + k + '\\s*=\\s*([^;]+);').exec(src);
    ok(!!m && vm.runInNewContext(m[1]) === ctx[k], `9: sandbox ${k} mirrors creatures.js`);
  }
}

// ── 10. The length bonus: ×1 → ×2 at a day, flat after ──
{
  ok(mult(0) === 1, '10: ×1 at zero length');
  ok(Math.abs(mult(60 * MIN) - (1 + 1 / 24)) < 1e-12, '10: ×1.04 for an hour');
  ok(Math.abs(mult(8 * 60 * MIN) - 4 / 3) < 1e-12, '10: ×1.33 for 8 hours');
  ok(mult(12 * 60 * MIN) === 1.5, '10: ×1.5 for 12 hours');
  ok(mult(24 * 60 * MIN) === 2, '10: ×2 for a day');
  ok(mult(3 * 24 * 60 * MIN) === 2, '10: still ×2 for 3 days');
  ok(mult(-5) === 1 && mult(NaN) === 1, '10: junk lengths are ×1');
}

// ── 11. Time payout: 9 pokémon + 45 items an hour, × bonus ──
{
  const a = due(0, 0);
  ok(a.creatures === 0 && a.items === 0, '11: nothing at 0');
  const b = due(6 * MIN, 0);
  ok(b.creatures === 0 && b.items === 4, `11: no pokémon yet at 6 min, 4 items (got ${b.creatures}/${b.items})`);
  const c = due(7 * MIN, 0);
  ok(c.creatures === 1 && c.items === 5, `11: 7 min = 1 pokémon + 5 items (got ${c.creatures}/${c.items})`);
  const d = due(60 * MIN, 0);
  ok(d.creatures === 9 && d.items === 46, `11: 1 h = 9 pokémon + 46 items at ×1.04 (got ${d.creatures}/${d.items})`);
  const e = due(8 * 60 * MIN, 0);
  ok(e.creatures === 96 && e.items === 480, `11: 8 h = 96 pokémon + 480 items at ×1.33 (got ${e.creatures}/${e.items})`);
  const f = due(24 * 60 * MIN, 0);
  ok(f.creatures === 432 && f.items === 2160, `11: a day = 432 pokémon + 2160 items at ×2 (got ${f.creatures}/${f.items})`);
  const g = due(48 * 60 * MIN, 0);
  ok(g.creatures === 864 && g.items === 4320, '11: two days, still ×2: twice a day');
}

// ── 12. Walking: +3 pokémon / km, +3 items / 4 km, × the same bonus ──
{
  const a = due(0, 333, 0);
  ok(a.creatures === 0 && a.items === 0, '12: nothing under ⅓ km');
  const b = due(0, 334, 0);
  ok(b.creatures === 1 && b.items === 0, '12: first pokémon at ⅓ km');
  const c = due(0, 1000, 0);
  ok(c.creatures === 3 && c.items === 0, `12: 1 km = 3 pokémon, no item yet (got ${c.creatures}/${c.items})`);
  const c2 = due(0, 4000, 0);
  ok(c2.creatures === 12 && c2.items === 3, `12: 4 km = 12 pokémon + 3 items (got ${c2.creatures}/${c2.items})`);
  const d = due(60 * MIN, NaN);
  ok(d.creatures === 9 && d.items === 46, '12: NaN distance falls back to the time rate');
  // 12 h with 5 km at ×1.5: (108 + 15) × 1.5 pokémon, (540 + 3.75) × 1.5 items.
  const e = due(12 * 60 * MIN, 5000);
  ok(e.creatures === 184 && e.items === 815, `12: time + walking stack, both × the bonus (got ${e.creatures}/${e.items})`);
  ok(due(60 * MIN, 0, 24 * 60 * MIN).creatures === 18, '12: the bonus follows the session length, not the time so far');
}

// ── 13. Replay stops at the session's length ──
{
  // All foreground, need 30 min of a 60-min window: reached at +30 min.
  const r = replay([], 0, 60 * MIN, FG, 30 * MIN);
  ok(r.qualifyingMs === 30 * MIN && r.reachedAtMs === 30 * MIN, '13: stops at the need, reached mid-window');
  // Backgrounded (awake) from 10 to 40 min: 10 min before + 20 after →
  // the 30 min are done at 60.
  const ev = [{ t: 10 * MIN, type: 'app_bg' }, { t: 40 * MIN, type: 'app_fg' }];
  const r2 = replay(ev, 0, 70 * MIN, FG, 30 * MIN);
  ok(r2.qualifyingMs === 30 * MIN && r2.reachedAtMs === 60 * MIN, `13: a paused stretch pushes completion later (${r2.reachedAtMs / MIN} min)`);
  ok(r2.state.appFg === true, '13: state still tracks events after completion');
  // Not enough time yet: no reachedAt, everything counted.
  const r3 = replay(ev, 0, 60 * MIN, FG, 45 * MIN);   // 10 + 20 = 30 < 45
  ok(r3.qualifyingMs === 30 * MIN && r3.reachedAtMs === null, '13: short of the need → not reached');
  // No need given (open-ended old sessions): counts everything.
  const r4 = replay([], 0, 60 * MIN, FG);
  ok(r4.qualifyingMs === 60 * MIN && r4.reachedAtMs === null, '13: no need → plain replay');
  // Sleeping counts toward it too.
  const r5 = replay([{ t: 5 * MIN, type: 'screen_off' }, { t: 6 * MIN, type: 'app_bg' }], 0, 60 * MIN, FG, 20 * MIN);
  ok(r5.reachedAtMs === 20 * MIN, '13: asleep (screen off) keeps counting toward the length');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
