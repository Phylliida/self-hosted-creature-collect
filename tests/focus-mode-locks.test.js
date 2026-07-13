// Tests the focus-mode gesture handlers in static/index.html:
//   - the custom two-finger pinch (_focusTouchStart / _focusTouchMove) honours
//     the "Lock zoom" / "Lock rotate" Settings toggles, and
//   - _applyFocusMode disables double-tap zoom on entry and restores handlers
//     lock-aware on exit (so leaving focus mode doesn't undo an active lock).
//
// The handlers live in an inline <script> in index.html and are tightly bound
// to the MapLibre `map` object, so we extract the source block by brace
// matching (same trick as tests/bag-sort.test.js) and run it in a vm sandbox
// with a mock map + localStorage.
//
// Run: node tests/focus-mode-locks.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

// --- extract the focus-mode block from index.html --------------------------
const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf8');
const startMarker = 'let _pinchActive = false, _pinchStartDist';
const start = src.indexOf(startMarker);
if (start < 0) throw new Error('focus-mode block not found in index.html');
const applyIdx = src.indexOf('function _applyFocusMode(active)', start);
if (applyIdx < 0) throw new Error('_applyFocusMode not found');
// brace-match the _applyFocusMode body, comment/string aware
let i = src.indexOf('{', applyIdx), depth = 0, end = -1;
for (; i < src.length; i++) {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
  if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
  if (c === "'" || c === '"' || c === '`') { const q = c; for (i++; i < src.length && src[i] !== q; i++) { if (src[i] === '\\') i++; } continue; }
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
}
if (end < 0) throw new Error('could not brace-match _applyFocusMode');
const block = src.slice(start, end + 1);

// --- mock map --------------------------------------------------------------
function makeMap() {
  const calls = { setZoom: [], setBearing: [], doubleClickZoom: [], dragRotate: [], dragPan: [], touchZoomRotate: [] };
  let zoom = 15, bearing = 0;
  const rec = (name) => ({ enable() { calls[name].push('enable'); }, disable() { calls[name].push('disable'); } });
  return {
    calls,
    __reset() { for (const k in calls) calls[k].length = 0; zoom = 15; bearing = 0; },
    getZoom: () => zoom,
    setZoom: (z) => { zoom = z; calls.setZoom.push(z); },
    getBearing: () => bearing,
    setBearing: (b) => { bearing = b; calls.setBearing.push(b); },
    getCanvasContainer: () => ({ addEventListener() {}, removeEventListener() {} }),
    dragPan: rec('dragPan'),
    dragRotate: rec('dragRotate'),
    doubleClickZoom: rec('doubleClickZoom'),
    touchZoomRotate: {
      enable() { calls.touchZoomRotate.push('enable'); },
      disable() { calls.touchZoomRotate.push('disable'); },
      enableRotation() { calls.touchZoomRotate.push('enableRotation'); },
      disableRotation() { calls.touchZoomRotate.push('disableRotation'); },
    },
  };
}
function makeLS() {
  const store = {};
  return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
}

// --- driver harness appended to the extracted block -----------------------
const harness = `
function __setLocks(z, r) {
  localStorage.setItem('cc.lockZoom', z ? '1' : '0');
  localStorage.setItem('cc.lockRotate', r ? '1' : '0');
}
// start: two fingers vertical 100px apart (dist 100, angle 90deg)
// move:  fingers on the 45deg diagonal (dist ~141, angle 45deg) -> zoom in + twist
function __drivePinch(cfg) {
  _focusActive = true;
  _pinchActive = false;
  map.__reset();
  __setLocks(cfg.lockZoom, cfg.lockRotate);
  _focusTouchStart({ touches: [{ clientX: 0, clientY: 0 }, { clientX: 0, clientY: 100 }], preventDefault() {} });
  _focusTouchMove({ touches: [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 100 }], preventDefault() {} });
  return { setZoom: map.calls.setZoom.slice(), setBearing: map.calls.setBearing.slice() };
}
function __driveApply(cfg) {
  map.__reset();
  __setLocks(cfg.lockZoom, cfg.lockRotate);
  _applyFocusMode(cfg.active);
  return {
    doubleClickZoom: map.calls.doubleClickZoom.slice(),
    dragRotate: map.calls.dragRotate.slice(),
    touchZoomRotate: map.calls.touchZoomRotate.slice(),
    dragPan: map.calls.dragPan.slice(),
  };
}
`;

const ctx = vm.createContext({ map: makeMap(), localStorage: makeLS() });
vm.runInContext('let _focusActive = false;\n' + block + '\n' + harness, ctx);
const drivePinch = (cfg) => vm.runInContext('__drivePinch(' + JSON.stringify(cfg) + ')', ctx);
const driveApply = (cfg) => vm.runInContext('__driveApply(' + JSON.stringify(cfg) + ')', ctx);

// --- pinch: lock matrix ----------------------------------------------------
let r = drivePinch({ lockZoom: false, lockRotate: false });
ok(r.setZoom.length === 1, 'no locks: pinch zooms');
ok(r.setBearing.length === 1, 'no locks: twist rotates');

r = drivePinch({ lockZoom: true, lockRotate: false });
ok(r.setZoom.length === 0, 'lock zoom: pinch does NOT zoom');
ok(r.setBearing.length === 1, 'lock zoom: twist still rotates');

r = drivePinch({ lockZoom: false, lockRotate: true });
ok(r.setZoom.length === 1, 'lock rotate: pinch still zooms');
ok(r.setBearing.length === 0, 'lock rotate: twist does NOT rotate');

r = drivePinch({ lockZoom: true, lockRotate: true });
ok(r.setZoom.length === 0 && r.setBearing.length === 0, 'both locks: pinch is inert');

// --- _applyFocusMode(true): double-tap zoom off ----------------------------
r = driveApply({ active: true, lockZoom: false, lockRotate: false });
ok(r.doubleClickZoom.includes('disable'), 'entering focus disables double-tap zoom');
ok(r.dragRotate.includes('disable'), 'entering focus disables dragRotate');
ok(r.touchZoomRotate.includes('disable'), 'entering focus disables touchZoomRotate');

// --- _applyFocusMode(false): restore is lock-aware -------------------------
r = driveApply({ active: false, lockZoom: false, lockRotate: false });
ok(r.doubleClickZoom.includes('enable') && !r.doubleClickZoom.includes('disable'), 'exit, no locks: re-enables double-tap zoom');
ok(r.dragRotate.includes('enable'), 'exit, no locks: re-enables dragRotate');

r = driveApply({ active: false, lockZoom: true, lockRotate: false });
ok(r.doubleClickZoom.includes('disable') && !r.doubleClickZoom.includes('enable'), 'exit with zoom lock: double-tap zoom stays disabled');

r = driveApply({ active: false, lockZoom: false, lockRotate: true });
ok(r.dragRotate.includes('disable') && !r.dragRotate.includes('enable'), 'exit with rotate lock: dragRotate stays disabled');
ok(r.touchZoomRotate.includes('disableRotation'), 'exit with rotate lock: rotation stays disabled');

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
