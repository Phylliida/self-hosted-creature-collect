// nav.js — camera navigation state for the Mandelbox explorer. Headless-safe
// (no DOM): unit-tested in tests/mandelbox-app.test.js.
//
// Model: the camera lives at anchor C + offset (floatexp vec3). Movement and
// scale are DECOUPLED: sceneE (the scale exponent driving epsilon/tMax/
// maxIter and all step sizes) changes ONLY via Q/E (and one-shot syncs after
// teleports, applied by the app from a clearance probe) — flying around
// never re-zooms the view. Translation speed is 2^sceneE × speedMul (the
// scroll-wheel multiplier), so Q + W together give the exponential dive.
//
// Controls (PC): W/S forward/back, A/D turn (yaw about the camera's up),
// Space up, Shift down, Q scale up (zoom in), E scale down (zoom out),
// scroll wheel: movement speed multiplier.

import { fe, feAdd, feSetD } from '../math/floatexp.js';

export const KEYMAP = {
  KeyW: 'fwd', KeyS: 'back', KeyA: 'turnL', KeyD: 'turnR',
  Space: 'up', ShiftLeft: 'down', ShiftRight: 'down',
  KeyQ: 'zin', KeyE: 'zout',
};

const MOVE_RATE = 1.6;   // lateral/vertical speed, units of 2^sceneE per second
const ZOOM_RATE = 5;     // Q/E scale change, bits per second (× speedMul)
const YAW_RATE = 1.1;    // turn speed, radians per second
const SPEED_MIN = 1 / 64, SPEED_MAX = 64;
const SCENE_MIN = -1080; // precision wall (ref prec 1150 − ~70 guard bits)
const SCENE_MAX = 4;     // whole-object overview scale (camera ~14 out)

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
    sceneE,                               // scale exponent (Q/E-controlled)
    basis,
    blockedFwd: false,                    // probe said interior (HUD indicator only)
    speedMul: 1,                          // scroll-wheel movement multiplier
    syncScale: false,                     // teleported: app applies next probe to sceneE
  };
  const T = fe();

  function keydown(code) { if (KEYMAP[code]) { held.add(KEYMAP[code]); return true; } return false; }
  function keyup(code) { if (KEYMAP[code]) { held.delete(KEYMAP[code]); return true; } return false; }
  function clearKeys() { held.clear(); }

  // Add dir·(k·2^eBase) to the offset. eBase can be far below double range,
  // so split it into a fractional mantissa factor and an integer exponent.
  function step(dir, k, eBase) {
    const eInt = Math.floor(eBase);
    const scale = k * 2 ** (eBase - eInt);
    for (let i = 0; i < 3; i++) {
      feSetD(T, dir[i] * scale);
      if (T.m !== 0) T.e += eInt;
      feAdd(state.o[i], state.o[i], T);
    }
  }

  // Advance dt seconds. probeDeE: latest measured log2(DE at camera), or null
  // (unknown) or -Infinity (interior — informational only: the HUD shows
  // "surface!", nothing is blocked). Movement never touches sceneE; Q/E
  // change ONLY sceneE. Translation speed is 2^sceneE — capped by the
  // measured clearance (~2·DE per second max), so approaching geometry
  // auto-slows without the render scale changing. Returns true if anything
  // changed.
  function tick(dt, probeDeE) {
    state.blockedFwd = probeDeE === -Infinity;

    if (held.size === 0) return false;
    const { fwd, right, up } = state.basis;
    let moved = false;
    let moveE = state.sceneE;
    if (Number.isFinite(probeDeE)) moveE = Math.min(moveE, probeDeE + 1);
    const m = MOVE_RATE * dt * state.speedMul;
    const z = ZOOM_RATE * dt * state.speedMul;
    const go = (dir, k) => { step(dir, k, moveE); moved = true; };
    if (held.has('fwd')) go(fwd, m);
    if (held.has('back')) go(fwd, -m);
    if (held.has('turnL')) { yaw(YAW_RATE * dt); moved = true; }
    if (held.has('turnR')) { yaw(-YAW_RATE * dt); moved = true; }
    if (held.has('up')) go(up, m);
    if (held.has('down')) go(up, -m);
    if (held.has('zin')) { state.sceneE = Math.max(SCENE_MIN, state.sceneE - z); moved = true; }
    if (held.has('zout')) { state.sceneE = Math.min(SCENE_MAX, state.sceneE + z); moved = true; }
    return moved;
  }

  // Scroll-wheel speed multiplier (clamped ×1/64 .. ×64).
  function adjustSpeed(factor) {
    state.speedMul = Math.max(SPEED_MIN, Math.min(SPEED_MAX, state.speedMul * factor));
    return state.speedMul;
  }

  // Yaw about the camera's own up axis (positive = turn left). Mutates the
  // shared basis object in place so every holder of the reference sees it.
  function yaw(a) {
    const { fwd, right, up } = state.basis;
    const c = Math.cos(a), s = Math.sin(a);
    const nf = [0, 1, 2].map((i) => fwd[i] * c - right[i] * s);
    const nl = Math.hypot(nf[0], nf[1], nf[2]) || 1;
    for (let i = 0; i < 3; i++) fwd[i] = nf[i] / nl;
    // right = fwd × up (the makeCamera convention), renormalized
    const nr = [fwd[1] * up[2] - fwd[2] * up[1], fwd[2] * up[0] - fwd[0] * up[2], fwd[0] * up[1] - fwd[1] * up[0]];
    const rl = Math.hypot(nr[0], nr[1], nr[2]) || 1;
    for (let i = 0; i < 3; i++) right[i] = nr[i] / rl;
  }

  // Jump to a preset standoff along direction v (unit double[3]). Teleports
  // flag syncScale: the app applies the next clearance probe to sceneE once,
  // so the landing scale matches the local geometry.
  function jumpTo(v, standoffE) {
    for (let i = 0; i < 3; i++) { state.o[i] = fe(v[i], standoffE); }
    state.sceneE = Math.max(SCENE_MIN, Math.min(SCENE_MAX, standoffE - 9));
    state.syncScale = true;
  }

  // Jump to an absolute offset given as plain doubles (whole-object views).
  function jumpAbs(offsetDoubles, sceneE) {
    for (let i = 0; i < 3; i++) { state.o[i] = fe(); feSetD(state.o[i], offsetDoubles[i]); }
    state.sceneE = Math.max(SCENE_MIN, Math.min(SCENE_MAX, sceneE));
    state.syncScale = true;
  }

  function offsetPlain() { return state.o.map((x) => ({ m: x.m, e: x.e })); }

  return { state, keydown, keyup, clearKeys, tick, jumpTo, jumpAbs, adjustSpeed, offsetPlain, held };
}
