// Regression tests for the trip planner's yielding search
// (static/trip-planner.js planForward/planReverse).
// Run: node tests/trip-planner-search.test.js
//
// The planners were made async with elapsed-time yields after a field
// stall dump (2026-07-02) showed a 95km 3-alternative transit plan as a
// single 3.0s main-thread freeze. The GOLDEN expectations below were
// captured from the synchronous pre-change implementation on the same
// fixture — results must be identical, only the blocking behavior may
// differ.

'use strict';
const path = require('path');
require(path.join(__dirname, '..', 'static', 'trip-planner.js'));

let failed = 0, passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL: ' + msg); }
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(x) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

(async () => {
  // ── golden fixture: walk + one transit pattern ──
  // nodes 1-2-3 chain (1-2 = 100m, 2-3 = 5000m); stop A at node 2,
  // stop B at node 3; one trip departs A t=1000, arrives B t=1300.
  const edges = { 1: [[2, 100]], 2: [[1, 100], [3, 5000]], 3: [[2, 5000]] };
  const wg = {
    hasNode: (n) => n >= 1 && n <= 3,
    forEachNeighbor: (n, cb) => { for (const [to, w] of edges[n] || []) cb(to, w, { e: n + '-' + to }); },
  };
  const si = {
    walkNodeToStops: new Map([[2, [['A', 10]]], [3, [['B', 5]]]]),
    stopToWalkNode: new Map([['A', { node: 2, walkSec: 10 }], ['B', { node: 3, walkSec: 5 }]]),
    stopPatterns: new Map([['A', new Map([['P', 0]])], ['B', new Map([['P', 1]])]]),
    patternBboxStops: new Map([['P', [[0, 'A'], [1, 'B']]]]),
  };
  const activeTrips = (pid) => pid === 'P' ? [{ f: 1000, cum: [0, 300], trip: 'T1' }] : [];
  const tp = globalThis.TripPlanner.create({ walkGraph: wg, scheduleIdx: si, MinHeap, walkSpeedMps: 1.3 });

  const fwdP = tp.planForward(1, 3, 900, 1, 10, activeTrips);
  ok(typeof fwdP.then === 'function', 'planForward returns a Promise');
  const fwd = await fwdP;
  const rev = await tp.planReverse(1, 3, 2000, 1, 10, activeTrips);
  const strip = (r) => r && { startSec: r.startSec, endSec: r.endSec, steps: r.steps.map((s) => ({ type: s.type, tDep: +s.tDep.toFixed(3), tArr: +s.tArr.toFixed(3) })) };

  // captured from the synchronous pre-change planner (tp-fixture.js)
  const GOLDEN_FWD = { startSec: 900, endSec: 1305, steps: [
    { type: 'walk', tDep: 900, tArr: 976.923 },
    { type: 'access', tDep: 976.923, tArr: 986.923 },
    { type: 'transit', tDep: 1000, tArr: 1300 },
    { type: 'egress', tDep: 1300, tArr: 1305 }] };
  const GOLDEN_REV = { startSec: 903.0769230769231, endSec: 2000, steps: [
    { type: 'walk', tDep: 903.077, tArr: 980 },
    { type: 'access', tDep: 980, tArr: 990 },
    { type: 'transit', tDep: 1000, tArr: 1300 },
    { type: 'egress', tDep: 1995, tArr: 2000 }] };
  ok(JSON.stringify(strip(fwd)) === JSON.stringify(GOLDEN_FWD),
    'forward plan matches the pre-change golden: ' + JSON.stringify(strip(fwd)));
  ok(JSON.stringify(strip(rev)) === JSON.stringify(GOLDEN_REV),
    'reverse plan matches the pre-change golden: ' + JSON.stringify(strip(rev)));

  // unknown nodes still resolve to null
  ok((await tp.planForward(99, 3, 900, 1, 10, activeTrips)) === null, 'unknown origin → null');

  // ── stress: a long chain forces the search to actually yield ──
  const N = 400000;
  const chainNbrs = (n, cb) => {
    if (n > 0) cb(n - 1, 1, null);
    if (n < N - 1) cb(n + 1, 1, null);
  };
  const wg2 = { hasNode: (n) => n >= 0 && n < N, forEachNeighbor: chainNbrs };
  const si2 = {
    walkNodeToStops: new Map(), stopToWalkNode: new Map(),
    stopPatterns: new Map(), patternBboxStops: new Map(),
  };
  const tp2 = globalThis.TripPlanner.create({ walkGraph: wg2, scheduleIdx: si2, MinHeap, walkSpeedMps: 1.3 });

  let yields = 0, longestStretch = 0, lastYield = performance.now();
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => {
    const now = performance.now();
    longestStretch = Math.max(longestStretch, now - lastYield);
    lastYield = now;
    yields++;
    return realSetTimeout(fn, ms);
  };
  const t0 = performance.now();
  const long = await tp2.planForward(0, N - 1, 0, 1, 10, () => []);
  global.setTimeout = realSetTimeout;
  const wallMs = performance.now() - t0;

  ok(!!long, 'long chain route found');
  const expectSec = (N - 1) / 1.3;
  ok(Math.abs(long.endSec - expectSec) < 1e-6, 'chain cost exact (' + long.endSec + ' vs ' + expectSec + ')');
  ok(yields >= 1, 'search yielded to the event loop (' + yields + ' yields over ' + Math.round(wallMs) + 'ms)');
  ok(longestStretch < 200, 'longest sync stretch ' + Math.round(longestStretch) + 'ms (<200ms; was one multi-second block)');

  console.log('stress: ' + Math.round(wallMs) + 'ms wall, ' + yields + ' yields, longest stretch ' + Math.round(longestStretch) + 'ms');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
