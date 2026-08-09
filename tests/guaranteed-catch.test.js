// Fairness tests for the guaranteed-catch accessibility mode
// (_guaranteedThrowPlan in static/creatures.js).
// Run: node tests/guaranteed-catch.test.js
//
// The mode's contract: one physical throw always catches, BUT
//   (a) it consumes exactly the balls a manual player rolling the same
//       odds would have consumed (hidden re-rolls pay real balls), and
//   (b) the visible sequence takes a FIXED time per ball type — 110%
//       of the EXPECTED total manual-throwing time (arc, suck-in,
//       shakes, end animation, plus a re-aim allowance per re-throw),
//       independent of how many hidden re-rolls actually happened —
//       so the mode is strain relief, never an advantage.

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL: ' + msg); }
}

// comment-aware brace extractor (same approach as tests/bridges.test.js)
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
const ctx = { Math };
vm.createContext(ctx);
vm.runInContext(extract('function _guaranteedThrowPlan(rate, rollShakes, tryConsume)'), ctx);
const plan = (rate, rollShakes, tryConsume) =>
  vm.runInContext('_guaranteedThrowPlan(__rate, __r, __c)',
    Object.assign(ctx, { __rate: rate, __r: rollShakes, __c: tryConsume }));

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mkRoll = (rng, rate) => () => {
  let n = 0;
  for (let i = 0; i < 3; i++) { if (rng() < rate) n++; else break; }
  return n;
};
// mirror of the planner's pacing constants — the manual-side reference
const ARC = 650, SUCK = 480, SHAKE = 700, CATCH_END = 540, BREAK = 700, REAIM = 400, MARGIN = 1.1;
// analytic expected manual-throwing time at shake rate r — mirror of
// the formula in _guaranteedThrowPlan
function expectedManualMs(rate) {
  const p = rate * rate * rate;
  const expShakes = rate + rate * rate + p;
  const expThrows = 1 / p;
  const expEnd = p * CATCH_END + (1 - p) * BREAK;
  return expThrows * (ARC + SUCK + expShakes * SHAKE + expEnd)
    + (expThrows - 1) * REAIM;
}
// what the same roll sequence costs a MANUAL player (animation time + balls)
function manualReference(rollShakes, maxBalls) {
  let balls = 0, ms = 0, caught = false;
  while (!caught && balls < maxBalls) {
    if (balls > 0) ms += REAIM;
    balls++;
    const s = rollShakes();
    caught = s === 3;
    ms += ARC + SUCK + s * SHAKE + (caught ? CATCH_END : BREAK);
  }
  return { balls, ms, caught };
}

// ── Monte-Carlo: both ball rates, 20k trials each, unlimited balls ──
for (const [name, rate, pCatch] of [['poke', 0.8879, 0.8879 ** 3], ['great', 0.9655, 0.9655 ** 3]]) {
  let ballSum = 0, timeSumM = 0;
  let identicalBalls = true, allWobblesOk = true, allCaught = true;
  const visibleTimes = new Set();
  const TRIALS = 20000;
  for (let t = 0; t < TRIALS; t++) {
    // same seed → the guaranteed planner and the manual player see the
    // exact same roll sequence
    const rngG = mulberry32(t * 2 + 1), rngM = mulberry32(t * 2 + 1);
    const p = plan(rate, mkRoll(rngG, rate), () => true);
    const m = manualReference(mkRoll(rngM, rate), Infinity);
    if (p.ballsUsed !== m.balls) identicalBalls = false;
    if (!p.caught) allCaught = false;
    ballSum += p.ballsUsed;
    visibleTimes.add(ARC + SUCK + CATCH_END + p.wobbles * (p.wobbleMs + p.pauseMs));
    timeSumM += m.ms;
    if (p.wobbles !== 3) allWobblesOk = false;
  }
  const fixedMs = MARGIN * expectedManualMs(rate);
  const theTime = [...visibleTimes][0];
  ok(identicalBalls, name + ': ball consumption identical to manual throwing on every trial');
  ok(visibleTimes.size === 1, name + ': visible time is EXACTLY constant across all trials (saw '
    + visibleTimes.size + ' distinct values)');
  ok(Math.abs(theTime - fixedMs) < 1e-6, name + ': constant time = 110% of expected manual time ('
    + theTime.toFixed(1) + 'ms vs ' + fixedMs.toFixed(1) + 'ms)');
  ok(allCaught, name + ': always caught (unlimited balls)');
  ok(allWobblesOk, name + ': always exactly 3 wobbles');
  const meanBalls = ballSum / TRIALS;
  ok(Math.abs(meanBalls - 1 / pCatch) < 0.05, name + ': mean balls ' + meanBalls.toFixed(3)
    + ' ≈ 1/p = ' + (1 / pCatch).toFixed(3));
  // the analytic formula itself tracks the simulated mean manual time
  const meanManual = timeSumM / TRIALS;
  ok(Math.abs(meanManual - expectedManualMs(rate)) / expectedManualMs(rate) < 0.02,
    name + ': expected-manual formula ≈ simulated mean (' + expectedManualMs(rate).toFixed(0)
    + 'ms vs ' + meanManual.toFixed(0) + 'ms)');
  // even the LUCKIEST manual player (first-throw catch, shortest
  // possible successful run) isn't beaten by the fixed time
  const shortestManual = ARC + SUCK + 3 * SHAKE + CATCH_END;
  ok(theTime >= MARGIN * shortestManual - 1e-9, name + ': fixed time ≥ 110% of a first-throw '
    + 'manual catch (' + (theTime / shortestManual).toFixed(3) + '×)');
  console.log('  ' + name + ': fixed time ' + theTime.toFixed(0) + 'ms, mean balls '
    + meanBalls.toFixed(3) + ' (1/p=' + (1 / pCatch).toFixed(3) + '), mean manual '
    + meanManual.toFixed(0) + 'ms');
}

// fixed time must be longer for the lower-odds ball
{
  const poke = MARGIN * expectedManualMs(0.8879);
  const great = MARGIN * expectedManualMs(0.9655);
  ok(poke > great, 'poke ball fixed time (' + poke.toFixed(0) + 'ms) > great ball ('
    + great.toFixed(0) + 'ms)');
}

// ── bag runs dry: honest failure, every rolled ball spent ──
{
  let extraLeft = 2;
  const p = plan(0.8879, () => 1 /* never 3 → never caught */, () => (extraLeft-- > 0));
  ok(p.caught === false, 'exhausted bag → not caught');
  ok(p.ballsUsed === 3, 'exhausted bag → all 3 balls consumed (got ' + p.ballsUsed + ')');
  ok(p.wobbleMs === 380 && p.pauseMs === 320, 'exhausted bag → break-out at normal pacing');
}

// ── instant triple-shake catch: same fixed time, 1 ball, 3 wobbles ──
{
  const p = plan(0.8879, () => 3, () => { throw new Error('should not consume extra'); });
  ok(p.caught && p.ballsUsed === 1 && p.wobbles === 3, 'first-roll catch: 1 ball, 3 wobbles');
  const visible = ARC + SUCK + CATCH_END + 3 * (p.wobbleMs + p.pauseMs);
  const fixedMs = MARGIN * expectedManualMs(0.8879);
  ok(Math.abs(visible - fixedMs) < 1e-6, 'first-roll catch takes the fixed time, not less ('
    + visible.toFixed(1) + 'ms vs ' + fixedMs.toFixed(1) + 'ms)');
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
