// Fairness tests for the guaranteed-catch accessibility mode
// (_guaranteedThrowPlan in static/creatures.js).
// Run: node tests/guaranteed-catch.test.js
//
// The mode's contract: one physical throw always catches, BUT
//   (a) it consumes exactly the balls a manual player rolling the same
//       odds would have consumed (hidden re-rolls pay real balls), and
//   (b) the visible slowed sequence takes ≥ 110% of the animation time
//       those manual throws would have taken (plus re-aim allowance) —
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
vm.runInContext(extract('function _guaranteedThrowPlan(rollShakes, tryConsume)'), ctx);
const plan = (rollShakes, tryConsume) =>
  vm.runInContext('_guaranteedThrowPlan(__r, __c)', Object.assign(ctx, { __r: rollShakes, __c: tryConsume }));

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
const ARC = 650, SUCK = 480, SHAKE = 700, CATCH_END = 540, BREAK = 700, REAIM = 400;
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
  let worstMargin = Infinity, ballSum = 0, timeSumG = 0, timeSumM = 0;
  let identicalBalls = true, allWobblesOk = true, allPacingOk = true;
  const TRIALS = 20000;
  for (let t = 0; t < TRIALS; t++) {
    // same seed → the guaranteed planner and the manual player see the
    // exact same roll sequence
    const rngG = mulberry32(t * 2 + 1), rngM = mulberry32(t * 2 + 1);
    const p = plan(mkRoll(rngG, rate), () => true);
    const m = manualReference(mkRoll(rngM, rate), Infinity);
    if (p.ballsUsed !== m.balls) identicalBalls = false;
    ballSum += p.ballsUsed;
    const visible = ARC + SUCK + CATCH_END + p.wobbles * (p.wobbleMs + p.pauseMs);
    worstMargin = Math.min(worstMargin, visible / m.ms);
    timeSumG += visible; timeSumM += m.ms;
    if (!(p.caught && p.wobbles >= 3)) allWobblesOk = false;
    if (p.wobbleMs < 380 - 1e-9 || p.pauseMs < 320 - 1e-9) allPacingOk = false;
  }
  ok(identicalBalls, name + ': ball consumption identical to manual throwing on every trial');
  ok(worstMargin >= 1.1 - 1e-9, name + ': visible time ≥ 110% of manual animation time on EVERY trial (worst ' + worstMargin.toFixed(4) + ')');
  ok(allWobblesOk, name + ': always caught with ≥3 wobbles (unlimited balls)');
  ok(allPacingOk, name + ': shakes never faster than normal pacing');
  const meanBalls = ballSum / TRIALS;
  ok(Math.abs(meanBalls - 1 / pCatch) < 0.05, name + ': mean balls ' + meanBalls.toFixed(3) + ' ≈ 1/p = ' + (1 / pCatch).toFixed(3));
  console.log('  ' + name + ': mean balls ' + meanBalls.toFixed(3) + ' (1/p=' + (1 / pCatch).toFixed(3)
    + '), mean time ratio ' + (timeSumG / timeSumM).toFixed(3) + ', worst margin ' + worstMargin.toFixed(3));
}

// ── bag runs dry: honest failure, every rolled ball spent ──
{
  let extraLeft = 2;
  const p = plan(() => 1 /* never 3 → never caught */, () => (extraLeft-- > 0));
  ok(p.caught === false, 'exhausted bag → not caught');
  ok(p.ballsUsed === 3, 'exhausted bag → all 3 balls consumed (got ' + p.ballsUsed + ')');
  ok(p.wobbleMs === 380 && p.pauseMs === 320, 'exhausted bag → break-out at normal pacing');
}

// ── instant triple-shake catch: minimum stretch still ≥ margin ──
{
  const p = plan(() => 3, () => { throw new Error('should not consume extra'); });
  ok(p.caught && p.ballsUsed === 1 && p.wobbles === 3, 'first-roll catch: 1 ball, 3 wobbles');
  const visible = ARC + SUCK + CATCH_END + 3 * (p.wobbleMs + p.pauseMs);
  const manual = ARC + SUCK + 3 * SHAKE + CATCH_END;
  ok(visible >= 1.1 * manual - 1e-9, 'first-roll catch still ≥ 110% of the manual throw ('
    + (visible / manual).toFixed(3) + ')');
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
