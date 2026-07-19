// Tests that the encounter ("battle") screen locks the player in once a ball is
// thrown: the backdrop tap-away and Flee handlers must NOT dismiss while a throw
// is in flight (_throwInFlight), but must dismiss freely before a throw.
//
// The bug: a backdrop tap mid-throw ran closeBattleScreen() while the async
// catch animation kept resolving — the caught creature then popped up over the
// map. The .throwing CSS only blanks the action panel, not the backdrop.
//
// The dismiss handlers are wired inside ensureBattleScreen() in
// static/creatures.js. Rather than build the whole battle DOM, we extract just
// the two addEventListener(...) statements from the real source and run them in
// a vm sandbox with a mock element, a spy closeBattleScreen, and a controllable
// _throwInFlight flag — so we test the shipped guard logic, not a copy of it.
//
// Run: node tests/encounter-throw-lock.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

// --- extract the two dismiss handlers from creatures.js --------------------
const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'creatures.js'), 'utf8');
const start = src.indexOf("el.querySelector('button.flee').addEventListener");
if (start < 0) throw new Error('flee handler wiring not found in creatures.js');
// End just after the backdrop handler's closing `});`. The backdrop handler is
// the second of the two and ends at the first `});` following its guard line.
const guardLine = src.indexOf('if (e.target === el', start);
if (guardLine < 0) throw new Error('backdrop guard not found in creatures.js');
const end = src.indexOf('});', guardLine);
if (end < 0) throw new Error('could not find end of backdrop handler');
const block = src.slice(start, end + 3);

// Sanity: the extracted block must actually reference the throw-in-flight guard,
// otherwise the guard was removed/renamed and this test is silently vacuous.
ok(/_throwInFlight/.test(block), 'extracted block references _throwInFlight');

// --- mock element + harness ------------------------------------------------
function makeHarness() {
  let backdropCb = null, fleeCb = null;
  const fleeBtn = { addEventListener: (t, cb) => { if (t === 'click') fleeCb = cb; } };
  const el = {
    querySelector: (sel) => (sel === 'button.flee' ? fleeBtn : null),
    addEventListener: (t, cb) => { if (t === 'click') backdropCb = cb; },
  };
  const ctx = {
    el,
    closeCount: 0,
    _throwInFlight: false,
    closeBattleScreen() { ctx.closeCount++; },
  };
  vm.createContext(ctx);
  vm.runInContext(block, ctx);
  return {
    ctx,
    setInFlight: (v) => { ctx._throwInFlight = v; },
    fireBackdrop: () => backdropCb && backdropCb({ target: el }),        // tap on backdrop itself
    fireInnerTap: () => backdropCb && backdropCb({ target: {} }),         // tap on info/action panel
    fireFlee: () => fleeCb && fleeCb(),
    closes: () => ctx.closeCount,
  };
}

// --- before a throw: dismissal works freely --------------------------------
{
  const h = makeHarness();
  h.fireBackdrop();
  ok(h.closes() === 1, 'backdrop tap dismisses before a throw');
  h.fireFlee();
  ok(h.closes() === 2, 'flee dismisses before a throw');
}

// --- inner-panel taps never dismiss (target !== el) ------------------------
{
  const h = makeHarness();
  h.fireInnerTap();
  ok(h.closes() === 0, 'tap on info/action panel does not dismiss (even pre-throw)');
}

// --- once a ball is in flight: locked in -----------------------------------
{
  const h = makeHarness();
  h.setInFlight(true);
  h.fireBackdrop();
  ok(h.closes() === 0, 'backdrop tap is ignored while a ball is in flight');
  h.fireFlee();
  ok(h.closes() === 0, 'flee is ignored while a ball is in flight');
}

// --- after the throw resolves (breakout): dismissal works again ------------
{
  const h = makeHarness();
  h.setInFlight(true);
  h.fireBackdrop();
  ok(h.closes() === 0, 'locked mid-throw');
  h.setInFlight(false); // breakout / catch resolved -> _throwInFlight reset
  h.fireBackdrop();
  ok(h.closes() === 1, 'backdrop dismisses again once the throw resolves');
}

// --- summary ---------------------------------------------------------------
if (failed) { console.error(`\n${failed} failed, ${passed} passed`); process.exit(1); }
console.log(`encounter-throw-lock: ${passed} passed`);
