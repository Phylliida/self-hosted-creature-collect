// nav.js — camera navigation state for the Mandelbox explorer. Headless-safe
// (no DOM): unit-tested in tests/mandelbox-app.test.js.
//
// Model: the camera lives at anchor C + offset (floatexp vec3). Orientation
// (fwd/right/up doubles) is fixed per session for now. All motion scales with
// 2^sceneE, where sceneE tracks the MEASURED DE at the camera (the clearance
// rule from the render experiments): as you dolly in with E the clearance
// shrinks, sceneE follows it, and every subsequent step is proportionally
// smaller — the classic exponential deep dive. Q backs out the same way.
//
// Controls (PC): W/S forward/back, A/D strafe, Space up, Shift down,
// E dolly in (zoom — "increases the scale of everything"), Q dolly out.

import { fe, feAdd, feSetD } from '../math/floatexp.js';

export const KEYMAP = {
  KeyW: 'fwd', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  Space: 'up', ShiftLeft: 'down', ShiftRight: 'down',
  KeyE: 'zin', KeyQ: 'zout',
};

const MOVE_RATE = 1.6;   // lateral/vertical speed, units of 2^sceneE per second
const DOLLY_RATE = 1.4;  // zoom dolly speed, units of 2^sceneE per second
const SCENE_MIN = -1080; // precision wall (ref prec 1150 − ~70 guard bits)
const SCENE_MAX = -6;    // whole-object scale

// Derive render/marcher parameters from the scene scale exponent.
export function deriveOpts(sceneE) {
  return {
    epsAbsE: Math.round(sceneE) - 14,
    tMaxE: Math.round(sceneE) + 8,
    maxIter: Math.min(2400, Math.ceil(-sceneE * 1.25 + 160)),
  };
}

// basis: { fwd, right, up } unit double[3]s.
export function createNav(basis, offset, sceneE) {
  const held = new Set();
  const state = {
    o: offset.map((x) => fe(x.m, x.e)),  // floatexp vec3, camera − C
    sceneE,                               // smoothed log2(clearance)
    basis,
    blockedFwd: false,                    // probe said interior ahead
  };
  const T = fe();

  function keydown(code) { if (KEYMAP[code]) { held.add(KEYMAP[code]); return true; } return false; }
  function keyup(code) { if (KEYMAP[code]) { held.delete(KEYMAP[code]); return true; } return false; }
  function clearKeys() { held.clear(); }

  // Add dir·(k·2^sceneE) to the offset. sceneE can be far below double range,
  // so split it into a fractional mantissa factor and an integer exponent.
  function step(dir, k) {
    const eInt = Math.floor(state.sceneE);
    const scale = k * 2 ** (state.sceneE - eInt);
    for (let i = 0; i < 3; i++) {
      feSetD(T, dir[i] * scale);
      if (T.m !== 0) T.e += eInt;
      feAdd(state.o[i], state.o[i], T);
    }
  }

  // Advance dt seconds. probeDeE: latest measured log2(DE at camera), or null
  // (unknown) or -Infinity (interior). Returns true if the camera moved.
  function tick(dt, probeDeE) {
    // sceneE follows the measured clearance (smoothed, clamped).
    if (probeDeE !== null && probeDeE !== -Infinity && Number.isFinite(probeDeE)) {
      const target = Math.max(SCENE_MIN, Math.min(SCENE_MAX, probeDeE));
      state.sceneE += Math.max(-8 * dt, Math.min(8 * dt, (target - state.sceneE) * 0.25));
    }
    state.blockedFwd = probeDeE === -Infinity;

    if (held.size === 0) return false;
    const { fwd, right, up } = state.basis;
    let moved = false;
    const m = MOVE_RATE * dt, z = DOLLY_RATE * dt;
    const go = (dir, k) => { step(dir, k); moved = true; };
    if (held.has('fwd') && !state.blockedFwd) go(fwd, m);
    if (held.has('back')) go(fwd, -m);
    if (held.has('left')) go(right, -m);
    if (held.has('right')) go(right, m);
    if (held.has('up')) go(up, m);
    if (held.has('down')) go(up, -m);
    if (held.has('zin') && !state.blockedFwd) go(fwd, z);
    if (held.has('zout')) go(fwd, -z);
    return moved;
  }

  // Jump to a preset standoff along direction v (unit double[3]).
  function jumpTo(v, standoffE) {
    for (let i = 0; i < 3; i++) { state.o[i] = fe(v[i], standoffE); }
    state.sceneE = Math.max(SCENE_MIN, Math.min(SCENE_MAX, standoffE - 9));
  }

  function offsetPlain() { return state.o.map((x) => ({ m: x.m, e: x.e })); }

  return { state, keydown, keyup, clearKeys, tick, jumpTo, offsetPlain, held };
}
