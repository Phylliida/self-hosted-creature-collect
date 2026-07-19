// Tests that the map compass button goes inert when "Lock rotate" is on.
//
// MapLibre's NavigationControl compass resets the bearing to north on click and
// carries its own drag-to-rotate handler bound straight to the button element —
// neither routes through map.dragRotate, so applyRotateLock's handler teardown
// never reached it. _applyCompassLock neutralises the button itself.
//
// Same extraction trick as tests/focus-mode-locks.test.js: the functions live in
// an inline <script> in index.html bound to the MapLibre `map` object, so we
// brace-match them out of the source and run them in a vm sandbox.
//
// Run: node tests/compass-rotate-lock.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

// --- extract the two functions from index.html -----------------------------
const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf8');

// Brace-match a function body starting at `from`, comment/string aware.
function matchFn(marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('not found in index.html: ' + marker);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') { const q = c; for (i++; i < src.length && src[i] !== q; i++) { if (src[i] === '\\') i++; } continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error('could not brace-match: ' + marker);
}
const block = matchFn('function _applyCompassLock(locked)') + '\n'
            + matchFn('function applyRotateLock(locked)');

// --- mocks -----------------------------------------------------------------
// `present: false` models the early restore path where NavigationControl hasn't
// been added to the DOM yet, so applyRotateLock must defer to map.once('load').
function makeMap(present) {
  const btn = {
    disabled: false,
    _classes: new Set(),
    _attrs: {},
    classList: { toggle(c, on) { if (on) btn._classes.add(c); else btn._classes.delete(c); } },
    setAttribute(k, v) { btn._attrs[k] = v; },
    removeAttribute(k) { delete btn._attrs[k]; },
  };
  const noop = { enable() {}, disable() {}, enableRotation() {}, disableRotation() {} };
  const deferred = [];
  return {
    __btn: btn,
    __deferred: deferred,
    __runLoad() { const q = deferred.splice(0); q.forEach((f) => f()); },
    getContainer: () => ({
      querySelector: (sel) => (present && sel === '.maplibregl-ctrl-compass' ? btn : null),
    }),
    getBearing: () => 42,
    setBearing() {},
    once(ev, fn) { if (ev === 'load') deferred.push(fn); },
    dragRotate: noop,
    touchZoomRotate: noop,
    touchPitch: noop,
  };
}
function makeLS() {
  const store = {};
  return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
}

function run(present) {
  const map = makeMap(present);
  const ctx = vm.createContext({ map, localStorage: makeLS() });
  vm.runInContext('let _rotateLockSnapshot = null;\n' + block, ctx);
  const call = (locked) => vm.runInContext('applyRotateLock(' + JSON.stringify(locked) + ')', ctx);
  return { map, call, ls: ctx.localStorage };
}

// --- compass is disabled while the lock is on ------------------------------
{
  const { map, call } = run(true);
  const btn = map.__btn;

  ok(btn.disabled === false, 'baseline: compass starts enabled');

  call(true);
  ok(btn.disabled === true, 'lock on: compass button is disabled (kills click -> resetNorth)');
  ok(btn._classes.has('cc-compass-locked'), 'lock on: cc-compass-locked class added (pointer-events:none kills drag-rotate)');
  ok(btn._attrs['aria-disabled'] === 'true', 'lock on: aria-disabled set');

  call(false);
  ok(btn.disabled === false, 'lock off: compass button re-enabled');
  ok(!btn._classes.has('cc-compass-locked'), 'lock off: cc-compass-locked class removed');
  ok(!('aria-disabled' in btn._attrs), 'lock off: aria-disabled cleared');

  // Idempotent — the settings restore path can call this twice.
  call(true); call(true);
  ok(btn.disabled === true && btn._classes.has('cc-compass-locked'), 'lock on twice: still locked');
}

// --- deferred path: control not in the DOM yet -----------------------------
{
  const { map, call } = run(false);
  call(true);
  ok(map.__deferred.length === 1, 'compass missing: defers to map.once("load")');
}

// The deferred callback re-reads localStorage rather than closing over the
// original argument, so a toggle flipped before 'load' fires still wins.
{
  const map = makeMap(false);
  const ls = makeLS();
  const ctx = vm.createContext({ map, localStorage: ls });
  vm.runInContext('let _rotateLockSnapshot = null;\n' + block, ctx);

  ls.setItem('cc.lockRotate', '1');
  vm.runInContext('applyRotateLock(true)', ctx);
  ok(map.__deferred.length === 1, 'deferred: queued while compass absent');

  // User turns the lock back off before the map finishes loading.
  ls.setItem('cc.lockRotate', '0');
  // Compass shows up now.
  map.getContainer = () => ({ querySelector: () => map.__btn });
  map.__runLoad();
  ok(map.__btn.disabled === false, 'deferred: honours the current setting, not the stale argument');
}

// --- the CSS the lock depends on actually exists ---------------------------
{
  const css = src.slice(src.indexOf('.maplibregl-ctrl-compass.cc-compass-locked'));
  ok(css.startsWith('.maplibregl-ctrl-compass.cc-compass-locked'), 'cc-compass-locked rule exists in index.html');
  const body = css.slice(0, css.indexOf('}'));
  ok(/pointer-events\s*:\s*none/.test(body), 'cc-compass-locked sets pointer-events:none (blocks drag-rotate)');
  ok(/opacity\s*:/.test(body), 'cc-compass-locked dims the button so it reads as inactive');
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
