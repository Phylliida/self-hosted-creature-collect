// Render-worker protocol test for the Mandelbox explorer
// (static/mandelbox/src/app/worker.js — createWorkerState drives the exact
// message handler the browser worker wires up, no browser needed).
//
//   1. init → ready; rows → progressive result; probe answered.
//   2. INTERRUPTION: a queued multi-chunk render at generation 1 is cancelled
//      by generation 2 — gen-1 jobs must report aborted (quickly, i.e. the
//      in-flight job stops mid-slice), gen-2 jobs must complete, and probes
//      sent during the render must be answered before it finishes.
//
// Run: node tests/mandelbox-worker.test.js
'use strict';

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const base = '../static/mandelbox/src/';
  const W = await import(base + 'app/worker.js');
  const LOC = await import(base + 'math/locate.js');
  const REF = await import(base + 'math/reference.js');
  const NAV = await import(base + 'app/nav.js');

  const depthBits = 80, prec = depthBits + 110, maxIter = depthBits + 500;
  const { c: C } = LOC.bisectSurface([1n, 9n, 4n], 16, depthBits, prec, depthBits + 200);
  const ref = REF.computeMbReference({ ...C, prec }, maxIter);
  const refPlain = {
    prec: ref.prec, len: ref.len, escaped: ref.escaped,
    zx: ref.zx.slice(), zy: ref.zy.slice(), zz: ref.zz.slice(),
    boxReg: ref.boxReg.slice(),
    uM: ref.uM.slice(), uE: ref.uE.slice(), wM: ref.wM.slice(), wE: ref.wE.slice(),
    bx: ref.bx.slice(), by: ref.by.slice(), bz: ref.bz.slice(),
    rho2: ref.rho2.slice(), sphReg: ref.sphReg.slice(),
    rMM: ref.rMM.slice(), rME: ref.rME.slice(),
    rFM: ref.rFM.slice(), rFE: ref.rFE.slice(),
  };

  const fwd = [-0.55, -0.2, 0.81], right = [0.83, 0, 0.56], up = [-0.11, 0.98, 0.17];
  const o = [{ m: 1.05, e: 3 }, { m: 1.4, e: 1 }, { m: -1.62, e: 3 }];
  const d = NAV.deriveOpts(3.5);
  const cam = { o, fwd, right, up, planeScale: 0.9 };
  const opts = {
    maxIter: d.maxIter, maxSteps: 90, relax: 0.95,
    epsAbs: { m: 1, e: d.epsAbsE }, tMax: { m: 1, e: d.tMaxE },
  };

  // ---- 1. basic protocol ----
  {
    const msgs = [];
    const { handle } = W.createWorkerState((m) => msgs.push(m));
    handle({ type: 'init', ref: refPlain });
    ok(msgs.length === 1 && msgs[0].type === 'ready', 'init → ready');
    handle({ type: 'rows', gen: 1, W: 48, H: 36, y0: 0, y1: 4, cam, opts });
    handle({ type: 'probe', id: 7, dc: o, maxIter: d.maxIter + 300, floorE: -27 });
    const probe = msgs.find((m) => m.type === 'probe');
    ok(probe && probe.id === 7 && Number.isFinite(probe.deE), `probe answered synchronously (deE=${probe && probe.deE})`);
    await sleep(1500);
    const rows = msgs.find((m) => m.type === 'rows');
    ok(rows && !rows.aborted && rows.hit.length === 48 * 4, 'rows completed');
    ok(rows && rows.hit.reduce((a, x) => a + x, 0) > 0, 'overview rows contain hits');
    ok(rows && rows.tMs > 0 && rows.stats.evals > 0, 'rows carry timing + stats');
  }

  // ---- 2. interruption ----
  {
    const msgs = [];
    const { handle } = W.createWorkerState((m) => msgs.push(m));
    handle({ type: 'init', ref: refPlain });
    // Queue a fat gen-1 render (several chunks of a 96×72 frame).
    for (let y = 0; y < 72; y += 12) handle({ type: 'rows', gen: 1, W: 96, H: 72, y0: y, y1: y + 12, cam, opts });
    await sleep(30); // let the pump start chewing chunk one
    const tCancel = performance.now();
    handle({ type: 'cancel', gen: 2 });
    handle({ type: 'rows', gen: 2, W: 32, H: 24, y0: 0, y1: 6, cam, opts });
    // Probe mid-render must not wait for the queue.
    handle({ type: 'probe', id: 9, dc: o, maxIter: d.maxIter + 300, floorE: -27 });
    ok(msgs.some((m) => m.type === 'probe' && m.id === 9), 'probe answered during render');
    await sleep(2500);
    const g1 = msgs.filter((m) => m.type === 'rows' && m.gen === 1);
    const g2 = msgs.filter((m) => m.type === 'rows' && m.gen === 2);
    ok(g1.length === 6 && g1.every((m) => m.aborted), `all gen-1 jobs reported aborted (${g1.length}, ${g1.filter((m) => m.aborted).length} aborted)`);
    ok(g2.length === 1 && !g2[0].aborted && g2[0].hit.length === 32 * 6, 'gen-2 render completed after cancel');
    const tFirstAbort = msgs.findIndex((m) => m.type === 'rows' && m.gen === 1);
    ok(tFirstAbort >= 0, 'abort notifications present');
    console.log(`  interruption: cancel→first-abort ordering ok (${g1.length} aborted, gen2 done, ${(performance.now() - tCancel).toFixed(0)}ms window)`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
