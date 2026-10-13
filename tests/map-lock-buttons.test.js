// Tests that "Lock rotate" hides the map compass and "Lock zoom" hides the
// +/- buttons (the user asked for them gone, not just dimmed).
//
// Hiding the compass is also part of the rotate lock itself: MapLibre's
// NavigationControl compass resets the bearing to north on click and carries
// its own drag-to-rotate handler bound straight to the button element, so
// applyRotateLock's handler teardown never reached it.
//
// Same extraction trick as tests/focus-mode-locks.test.js: the functions live in
// an inline <script> in index.html bound to the MapLibre `map` object, so we
// brace-match them out of the source and run them in a vm sandbox.
//
// Run: node tests/map-lock-buttons.test.js
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
const block = matchFn('function applyZoomLock(locked)') + '\n'
            + matchFn('function applyRotateLock(locked)');

// --- mocks -----------------------------------------------------------------
function makeHandler(log, name) {
  return {
    enable() { log.push(name + '.enable'); }, disable() { log.push(name + '.disable'); },
    enableRotation() { log.push(name + '.enableRotation'); },
    disableRotation() { log.push(name + '.disableRotation'); },
  };
}
function run() {
  const log = [];
  const classes = new Set();
  const map = {
    getZoom: () => 15, getBearing: () => 42,
    setMinZoom(z) { log.push('setMinZoom:' + z); }, setMaxZoom(z) { log.push('setMaxZoom:' + z); },
    setBearing(b) { log.push('setBearing:' + b); },
  };
  for (const h of ['dragRotate', 'touchZoomRotate', 'touchPitch', 'scrollZoom', 'boxZoom', 'doubleClickZoom']) {
    map[h] = makeHandler(log, h);
  }
  const document = { documentElement: { classList: {
    toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
  } } };
  const ctx = vm.createContext({ map, document });
  vm.runInContext('let _zoomLockSnapshot = null;\nlet _rotateLockSnapshot = null;\n' + block, ctx);
  const call = (fn, locked) => vm.runInContext(fn + '(' + JSON.stringify(locked) + ')', ctx);
  return { classes, log, call };
}

// --- rotate lock: class on <html> hides the compass ------------------------
{
  const { classes, log, call } = run();
  ok(!classes.has('cc-rotate-locked'), 'baseline: compass shown');

  call('applyRotateLock', true);
  ok(classes.has('cc-rotate-locked'), 'lock on: cc-rotate-locked added (hides the compass)');
  ok(log.includes('dragRotate.disable') && log.includes('touchZoomRotate.disableRotation'),
     'lock on: rotate gestures still disabled');

  call('applyRotateLock', false);
  ok(!classes.has('cc-rotate-locked'), 'lock off: compass back');
  ok(log.includes('dragRotate.enable'), 'lock off: rotate gestures back');

  // Idempotent — the settings restore path can call this twice.
  call('applyRotateLock', true); call('applyRotateLock', true);
  ok(classes.has('cc-rotate-locked'), 'lock on twice: still hidden');
  ok(!classes.has('cc-zoom-locked'), 'rotate lock leaves the zoom buttons alone');
}

// --- zoom lock: class on <html> hides +/- ----------------------------------
{
  const { classes, log, call } = run();
  call('applyZoomLock', true);
  ok(classes.has('cc-zoom-locked'), 'lock on: cc-zoom-locked added (hides +/-)');
  ok(log.includes('setMinZoom:15') && log.includes('setMaxZoom:15'), 'lock on: zoom still clamped');
  ok(!classes.has('cc-rotate-locked'), 'zoom lock leaves the compass alone');

  call('applyZoomLock', false);
  ok(!classes.has('cc-zoom-locked'), 'lock off: +/- back');
}

// --- startup sets the classes before the map's style loads -----------------
// applyZoomLock(true) waits for 'load' (setMinZoom needs a ready map), so the
// toggle setup sets the class itself or the buttons flash visible at boot.
for (const [toggle, cls] of [['lockZoomToggle', 'cc-zoom-locked'], ['lockRotateToggle', 'cc-rotate-locked']]) {
  const at = src.indexOf(`const ${toggle} = document.getElementById('${toggle}');`);
  ok(at > 0, `${toggle} setup found`);
  const setup = src.slice(at, src.indexOf('addEventListener', at));
  ok(setup.includes(`classList.toggle('${cls}', ${toggle}.checked)`), `${toggle} applies ${cls} at startup`);
}

// --- the CSS + group tag the hiding depends on -----------------------------
{
  const rule = (sel) => {
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^{]*\\{([^}]*)\\}');
    const m = src.match(re);
    return m ? m[1] : null;
  };
  const hide = rule('html.cc-rotate-locked .maplibregl-ctrl-compass,');
  ok(hide && /display\s*:\s*none/.test(hide), 'CSS hides the compass under cc-rotate-locked');
  const hideRule = src.slice(src.indexOf('html.cc-rotate-locked .maplibregl-ctrl-compass,'));
  const sel = hideRule.slice(0, hideRule.indexOf('{'));
  ok(sel.includes('html.cc-zoom-locked .maplibregl-ctrl-zoom-in'), 'CSS hides zoom-in under cc-zoom-locked');
  ok(sel.includes('html.cc-zoom-locked .maplibregl-ctrl-zoom-out'), 'CSS hides zoom-out under cc-zoom-locked');
  ok(sel.includes('html.cc-zoom-locked.cc-rotate-locked .cc-nav-ctrl'), 'CSS hides the empty group when both locks are on');
  const lone = rule('html.cc-zoom-locked .maplibregl-ctrl-compass');
  ok(lone && /border-top\s*:\s*0/.test(lone), 'lone compass loses the divider above it');

  const nav = src.indexOf("map.addControl(new maplibregl.NavigationControl(), 'bottom-right');");
  ok(nav > 0, 'NavigationControl added');
  ok(/classList\.add\('cc-nav-ctrl'\)/.test(src.slice(nav, nav + 400)), 'NavigationControl group tagged cc-nav-ctrl right after');
  ok(!src.includes('cc-compass-locked'), 'old dim-the-compass class is gone');
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
