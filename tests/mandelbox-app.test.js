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
  }

  // ---- yaw (A/D turn about the up axis, offset unchanged) ----
  {
    const b = { fwd: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] };
    const nav = createNav(b, zero(), -100);
    nav.keydown('KeyA');
    nav.tick(0.5, -100);
    // turn left: fwd rotates toward -right (−x)
    ok(b.fwd[0] < -0.3, `A turns fwd toward -right (fwd.x=${b.fwd[0].toFixed(3)})`);
    ok(Math.abs(Math.hypot(...b.fwd) - 1) < 1e-9, 'fwd stays unit');
    ok(Math.abs(b.fwd[0] * b.up[0] + b.fwd[1] * b.up[1] + b.fwd[2] * b.up[2]) < 1e-9, 'no roll (fwd ⊥ up)');
    ok(Math.abs(b.right[0] * b.fwd[0] + b.right[1] * b.fwd[1] + b.right[2] * b.fwd[2]) < 1e-9, 'right ⊥ fwd');
    ok(nav.state.o.every((x) => x.m === 0), 'turning does not move the camera');
    nav.clearKeys(); nav.keydown('KeyD');
    nav.tick(0.5, -100);
    ok(Math.abs(b.fwd[0]) < 1e-9 && Math.abs(b.fwd[2] + 1) < 1e-9, 'D turns back (symmetry)');
  }

  // ---- Q/E are PURE scale (no translation); movement never changes scale ----
  {
    const nav = createNav(basis, zero(), -100);
    nav.keydown('KeyQ');
    nav.tick(0.1, -100);
    ok(nav.state.sceneE < -100, `Q scales up / zooms in (sceneE ${nav.state.sceneE})`);
    ok(nav.state.o.every((x) => x.m === 0), 'Q does not translate');
    nav.clearKeys(); nav.keydown('KeyE');
    const before = nav.state.sceneE;
    nav.tick(0.1, -100);
    ok(nav.state.sceneE > before, 'E scales down / zooms out');
    ok(nav.state.o.every((x) => x.m === 0), 'E does not translate');
    nav.clearKeys(); nav.keydown('KeyW');
    const se = nav.state.sceneE;
    for (let i = 0; i < 50; i++) nav.tick(0.05, -100 - i); // probe values changing
    ok(nav.state.sceneE === se, 'movement + probe changes never alter sceneE');
    ok(nav.state.o[2].m !== 0, 'W did translate');
  }

  // ---- interior indicator (informational, never blocks) + clamps ----
  {
    const nav = createNav(basis, zero(), -100);
    nav.keydown('KeyW');
    nav.tick(0.1, -Infinity); // interior probe
    ok(nav.state.blockedFwd, 'interior probe sets the surface! indicator');
    ok(nav.state.o[2].m !== 0, 'W still advances into the surface (no blocking)');
    nav.clearKeys(); nav.keydown('KeyQ');
    for (let i = 0; i < 5000; i++) nav.tick(0.05, null);
    ok(nav.state.sceneE === -1080, `Q clamps at precision wall (${nav.state.sceneE})`);
    nav.clearKeys(); nav.keydown('KeyE');
    for (let i = 0; i < 5000; i++) nav.tick(0.05, null);
    ok(nav.state.sceneE === 4, `E clamps at whole-object scale (${nav.state.sceneE})`);
  }

  // ---- scroll-wheel speed multiplier ----
  {
    const nav = createNav(basis, zero(), -100);
    ok(Math.abs(nav.adjustSpeed(2) - 2) < 1e-12, 'adjustSpeed multiplies');
    nav.keydown('KeyW');
    nav.tick(0.1, null);
    const fast = Math.abs(val(nav.state.o[2], -100));
    const nav2 = createNav(basis, zero(), -100);
    nav2.keydown('KeyW');
    nav2.tick(0.1, null);
    const slow = Math.abs(val(nav2.state.o[2], -100));
    ok(Math.abs(fast / slow - 2) < 1e-9, `speedMul scales movement (${(fast / slow).toFixed(3)}×)`);
    for (let i = 0; i < 100; i++) nav.adjustSpeed(10);
    ok(nav.state.speedMul === 64, `speed clamps high (${nav.state.speedMul})`);
    for (let i = 0; i < 100; i++) nav.adjustSpeed(0.1);
    ok(nav.state.speedMul === 1 / 64, `speed clamps low (${nav.state.speedMul})`);
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
    ok(nav.state.syncScale === true, 'jumpTo flags one-shot scale sync');
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
    ok(KEYMAP.KeyA === 'turnL' && KEYMAP.KeyD === 'turnR', 'A/D are turns');
    ok(KEYMAP.KeyQ === 'zin' && KEYMAP.KeyE === 'zout', 'Q zooms in, E zooms out');
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
