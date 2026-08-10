// Tests focus-mode accrual logic (_focusReplay / _focusGrantsDue in
// static/creatures.js): the event-timeline replay that measures
// qualifying time (screen off OR app foreground), and the grant
// schedule (base: 1 creature per hour, 1 item per 30 min; distance
// bounties: +1 creature per 0.5 km, +1 item per 1 km).
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
  FOCUS_CREATURE_MS: 60 * MIN,
  FOCUS_ITEM_MS: 30 * MIN,
  FOCUS_M_PER_CREATURE: 500,
  FOCUS_M_PER_ITEM: 1000,
};
vm.createContext(ctx);
vm.runInContext(extract('function _focusReplay('), ctx);
vm.runInContext(extract('function _focusGrantsDue('), ctx);
const replay = (events, from, to, state) =>
  vm.runInContext('_focusReplay(__e, __f, __t, __s)',
    Object.assign(ctx, { __e: events, __f: from, __t: to, __s: state }));
const due = (q, d) =>
  vm.runInContext('_focusGrantsDue(__q, __d)', Object.assign(ctx, { __q: q, __d: d }));

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

// ── 9. Base schedule: 1 creature / hour, 1 item / 30 min ──
{
  const a = due(0, 0);
  ok(a.creatures === 0 && a.items === 0, '9: nothing at 0');
  const b = due(29 * MIN + 59000, 0);
  ok(b.creatures === 0 && b.items === 0, '9: nothing just before 30 min');
  const c = due(30 * MIN, 0);
  ok(c.creatures === 0 && c.items === 1, '9: first item at 30 min');
  const d = due(60 * MIN, 0);
  ok(d.creatures === 1 && d.items === 2, '9: first creature at 1 hour, 2 items');
  const e = due(8 * 60 * MIN, 0);
  ok(e.creatures === 8 && e.items === 16, '9: overnight sleep = 8 creatures + 16 items');
}

// ── 10. Distance bounties: +1 creature / 0.5 km, +1 item / 1 km ──
{
  const a = due(0, 499);
  ok(a.creatures === 0 && a.items === 0, '10: nothing under 0.5 km');
  const b = due(0, 500);
  ok(b.creatures === 1 && b.items === 0, '10: first creature at 0.5 km');
  const c = due(0, 1000);
  ok(c.creatures === 2 && c.items === 1, '10: 1 km = 2 creatures + 1 item');
  const d = due(0, 15000);
  ok(d.creatures === 30 && d.items === 15, '10: 15 km = 30 creatures + 15 items');
  // Garbage distance → base rate only.
  const e = due(60 * MIN, NaN);
  ok(e.creatures === 1 && e.items === 2, '10: NaN distance falls back to base rate');
  // Combined: 2 hours + 5 km.
  const f = due(2 * 60 * MIN, 5000);
  ok(f.creatures === 2 + 10 && f.items === 4 + 5, '10: time + distance stack');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
