// Browser-app logic tests for the Mandelbox explorer (static/mandelbox/).
// The nav core (src/app/nav.js) is headless-safe and tested directly; the
// DOM/worker modules are import-checked (they guard their entry points, so a
// Node import validates syntax and the import graph without side effects).
//
// Run: node tests/mandelbox-app.test.js
'use strict';

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

async function main() {
  const base = '../static/mandelbox/src/';
  const NAV = await import(base + 'app/nav.js');
  const { createNav, deriveOpts, KEYMAP } = NAV;

  const basis = { fwd: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] };
  const zero = () => [{ m: 0, e: 0 }, { m: 0, e: 0 }, { m: 0, e: 0 }];
  const val = (x, eRef) => x.m === 0 ? 0 : x.m * 2 ** (x.e - eRef); // read at reference exponent

  // ---- movement mapping ----
  {
    const nav = createNav(basis, zero(), -100);
    ok(nav.keydown('KeyW'), 'W is mapped');
    ok(!nav.keydown('KeyZ'), 'unmapped key rejected');
    const moved = nav.tick(0.1, -100);
    ok(moved, 'W moves');
    // fwd = -z: offset z should be negative ~ 1.6*0.1*2^-100
    ok(val(nav.state.o[2], -100) < -0.1 && val(nav.state.o[2], -100) > -0.25, `W moves along fwd (${val(nav.state.o[2], -100)})`);
    ok(nav.state.o[0].m === 0 && nav.state.o[1].m === 0, 'W does not strafe');
    nav.keyup('KeyW');
    ok(!nav.tick(0.1, -100), 'keyup stops motion');
  }
  {
    const nav = createNav(basis, zero(), -100);
    nav.keydown('Space'); nav.keydown('ShiftLeft');
    nav.tick(0.1, -100);
    ok(Math.abs(val(nav.state.o[1], -100)) < 1e-12, 'up+down cancel');
    nav.clearKeys();
    nav.keydown('KeyD');
    nav.tick(0.1, -100);
    ok(val(nav.state.o[0], -100) > 0.1, 'D strafes +right');
  }

  // ---- zoom dolly + blocked-forward ----
  {
    const nav = createNav(basis, zero(), -100);
    nav.keydown('KeyE');
    nav.tick(0.1, -100);
    ok(val(nav.state.o[2], -100) < -0.05, 'E dives along fwd');
    nav.clearKeys();
    const before = nav.state.o[2].m * 2 ** nav.state.o[2].e;
    nav.keydown('KeyE'); nav.keydown('KeyW');
    nav.tick(0.1, -Infinity); // interior probe: forward blocked
    ok(nav.state.blockedFwd, 'interior probe sets blockedFwd');
    ok(nav.state.o[2].m * 2 ** nav.state.o[2].e === before, 'blocked: E/W do not advance');
    nav.clearKeys(); nav.keydown('KeyQ');
    nav.tick(0.1, -Infinity);
    ok(val(nav.state.o[2], -100) > -1e-3 * 0 || nav.state.o[2].m * 2 ** nav.state.o[2].e > before, 'Q backs out even when blocked');
  }

  // ---- sceneE tracks probes, clamps, deepens step size ----
  {
    const nav = createNav(basis, zero(), -100);
    for (let i = 0; i < 200; i++) nav.tick(0.05, -140);
    ok(Math.abs(nav.state.sceneE + 140) < 1, `sceneE converges to probe (${nav.state.sceneE})`);
    for (let i = 0; i < 2000; i++) nav.tick(0.05, -99999);
    ok(nav.state.sceneE >= -1080, `sceneE clamps at precision wall (${nav.state.sceneE})`);
    for (let i = 0; i < 2000; i++) nav.tick(0.05, 50);
    ok(nav.state.sceneE <= 4, `sceneE clamps at whole-object scale (${nav.state.sceneE})`);
  }
  {
    // Motion magnitude scales with 2^sceneE: same key, deeper scene, smaller step.
    const shallow = createNav(basis, zero(), -50);
    const deep = createNav(basis, zero(), -900);
    shallow.keydown('KeyW'); deep.keydown('KeyW');
    shallow.tick(0.1, null); deep.tick(0.1, null);
    ok(shallow.state.o[2].e > deep.state.o[2].e + 800, `step scales with sceneE (${shallow.state.o[2].e} vs ${deep.state.o[2].e})`);
    ok(Math.abs(shallow.state.o[2].m) - Math.abs(deep.state.o[2].m) < 1e-9, 'same mantissa magnitude');
  }

  // ---- jumpTo / jumpAbs + offsetPlain ----
  {
    const nav = createNav(basis, zero(), -50);
    nav.jumpTo([0.6, 0.8, 0], -493);
    ok(Math.abs(val(nav.state.o[0], -493) - 0.6) < 1e-12, 'jumpTo x');
    ok(Math.abs(val(nav.state.o[1], -493) - 0.8) < 1e-12, 'jumpTo y');
    ok(nav.state.sceneE === -502, `jumpTo seeds sceneE (${nav.state.sceneE})`);
    const p = nav.offsetPlain();
    ok(p.length === 3 && typeof p[0].m === 'number' && typeof p[0].e === 'number', 'offsetPlain shape');
    nav.jumpAbs([-13.5, 2.25, -0.75], 3.5);
    ok(Math.abs(val(nav.state.o[0], 0) + 13.5) < 1e-12, 'jumpAbs x');
    ok(Math.abs(val(nav.state.o[1], 0) - 2.25) < 1e-12, 'jumpAbs y');
    ok(nav.state.sceneE === 3.5, `jumpAbs sceneE within clamp (${nav.state.sceneE})`);
    nav.jumpAbs([1, 1, 1], 99);
    ok(nav.state.sceneE === 4, `jumpAbs clamps sceneE (${nav.state.sceneE})`);
  }

  // ---- deriveOpts ----
  {
    const a = deriveOpts(-100), b = deriveOpts(-1000);
    ok(a.epsAbsE === -114 && a.tMaxE === -92, `deriveOpts offsets (${a.epsAbsE}, ${a.tMaxE})`);
    ok(b.maxIter > a.maxIter, 'maxIter grows with depth');
    ok(b.maxIter <= 2400, 'maxIter capped');
  }

  // ---- KEYMAP covers the advertised control set ----
  {
    const want = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'KeyQ', 'KeyE'];
    ok(want.every((k) => KEYMAP[k]), 'all advertised controls mapped');
  }

  // ---- import-graph checks (guarded modules must import cleanly in Node) ----
  for (const mod of ['app/main.js', 'app/worker.js', 'app/locate-worker.js']) {
    try { await import(base + mod); ok(true, mod); }
    catch (e) { ok(false, `${mod} failed to import: ${e.message}`); }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
