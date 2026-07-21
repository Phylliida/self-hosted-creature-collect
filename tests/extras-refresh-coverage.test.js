// Refresh / live-update coverage guard for ALL Extras code.
//
// The Refresh button and the native live-update flow only pick up files
// that are listed in every one of these places:
//   1. static/index.html  — the emergency-refresh cache-delete list
//      (flat files) + the subtree prefix sweep (mini-app directories)
//   2. run.py             — _TRACKED_JS / _TRACKED_HTML (serve no-store)
//      and _SCRIPT_VERSION_FILES (the version map live-update diffs)
//   3. scripts/build-capacitor.sh — the bundled-app stamp lists (a file
//      missing there reads as "stale" on first launch and gets
//      needlessly re-downloaded)
// This test fails if an extras file drops out of any of them — or if a
// NEW file appears in a mini-app subtree without being registered.
//
// Run: node tests/extras-refresh-coverage.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
const runPy = fs.readFileSync(path.join(root, 'run.py'), 'utf8');
const buildCap = fs.readFileSync(path.join(root, 'scripts', 'build-capacitor.sh'), 'utf8');

// --- canonical file lists ----------------------------------------------------
const FLAT_EXTRAS_JS = [
  'extras.js', 'extras-apps.js', 'extras-almanac.js', 'extras-vibration.js',
  'extras-skymap.js', 'extras-sudoku.js', 'extras-sensors.js',
  'extras-tuner.js', 'extras-scapes.js', 'extras-todos.js',
];
const FLAT_APPS_HTML = ['synth.html', 'quiver.html'];
const SUBTREE_DIRS = ['draw', 'pixelart', 'fractals2', 'mandelbrot'];
const SUBTREE_HTML = [
  'pixelart/index.html', 'draw/index.html',
  'fractals2/index.html', 'mandelbrot/index.html',
];
const SUBTREE_CSS = ['draw/style.css', 'fractals2/styles.css', 'mandelbrot/style.css'];
const SUBTREE_JS = [
  'pixelart/app.js',
  ...['animexport', 'app', 'camera', 'commands', 'frieze', 'generators', 'gif',
      'hat', 'history', 'laves', 'minimap', 'penrose', 'pixel', 'renderer',
      'scene', 'spectre', 'storage', 'svg', 'uniform', 'util', 'wallpaper']
    .map((n) => 'draw/src/' + n + '.js'),
  ...['flightRecorder', 'main', 'palette', 'pngMetadata', 'viewer', 'worker']
    .map((n) => 'fractals2/src/' + n + '.js'),
  ...['glsl', 'gpu-worker-client', 'gpu-worker', 'renderer', 'validate']
    .map((n) => 'fractals2/src/gpu/' + n + '.js'),
  ...['bignum', 'bla', 'naive', 'perturb', 'reference', 'render', 'series']
    .map((n) => 'fractals2/src/math/' + n + '.js'),
  ...['favorites', 'flightRecorder', 'fxp', 'index', 'mandelbrotAbsFamily',
      'mandelbrotAbsFamilyPerturbation', 'mandelbrotBurningShip',
      'mandelbrotBurningShipPerturbation', 'mandelbrotFloat', 'mandelbrotFxP',
      'mandelbrotGyre', 'mandelbrotGyrePerturbation', 'mandelbrotKali',
      'mandelbrotKaliPerturbation', 'mandelbrotLyra', 'mandelbrotMirage',
      'mandelbrotMiragePerturbation', 'mandelbrotMultibrot',
      'mandelbrotMultibrotPerturbation', 'mandelbrotPerturbation',
      'mandelbrotPerturbationExtFloat', 'mandelbrotPhoenix',
      'mandelbrotPhoenixPerturbation', 'mandelbrotTricorn',
      'mandelbrotTricornPerturbation', 'mandelbrotWebGPU', 'palette',
      'pngMetadata', 'referencePointProvider', 'sharedCalculations',
      'workerContext', 'worker']
    .map((n) => 'mandelbrot/' + n + '.js'),
];

// --- 1) flat extras JS: covered everywhere ------------------------------------
for (const f of FLAT_EXTRAS_JS) {
  ok(indexSrc.includes(`'/static/${f}'`), `index.html: ${f} in the refresh cache-delete list`);
  ok(new RegExp('_TRACKED_JS = \\{[\\s\\S]*?' + f.replace('.', '\\.')).test(runPy),
    `run.py: ${f} in _TRACKED_JS`);
  ok(new RegExp('_SCRIPT_VERSION_FILES = \\[[\\s\\S]*?' + f.replace('.', '\\.')).test(runPy),
    `run.py: ${f} in _SCRIPT_VERSION_FILES`);
  ok(buildCap.includes(`"${f}"`), `build-capacitor.sh: ${f} in the stamp lists`);
}

// --- 2) flat iframe apps (synth/quiver) ---------------------------------------
for (const f of FLAT_APPS_HTML) {
  ok(indexSrc.includes(`'/static/${f}'`), `index.html: ${f} in the refresh cache-delete list`);
  ok(/_TRACKED_HTML = \{[\s\S]*?synth\.html[\s\S]*?quiver\.html/.test(runPy),
    'run.py: synth/quiver in _TRACKED_HTML');
  ok(buildCap.includes(`"${f}"`), `build-capacitor.sh: ${f} in the stamp lists`);
}

// --- 3) mini-app subtrees ------------------------------------------------------
// The refresh button sweeps cached entries by directory prefix, so new
// files in these apps never need the index.html list edited.
ok(/\(draw\|pixelart\|fractals2\|mandelbrot\)/.test(indexSrc) && indexSrc.includes('c.keys()'),
  'index.html: refresh sweeps the draw/pixelart/fractals2/mandelbrot cache prefixes');

// run.py shares one set of subtree constants across _TRACKED_JS /
// _TRACKED_HTML / _SCRIPT_VERSION_FILES — assert the wiring exists, then
// that every file is in the constants.
ok(runPy.includes('_TRACKED_JS |= set(_SUBTREE_JS)'),
  'run.py: _SUBTREE_JS folded into _TRACKED_JS (served no-store)');
ok(runPy.includes('*_SUBTREE_HTML'), 'run.py: _SUBTREE_HTML folded into _TRACKED_HTML');
ok(runPy.includes('] + _SUBTREE_JS + _SUBTREE_HTML + _SUBTREE_CSS'),
  'run.py: subtree files folded into _SCRIPT_VERSION_FILES (live-update map)');

for (const f of [...SUBTREE_JS, ...SUBTREE_HTML, ...SUBTREE_CSS]) {
  ok(fs.existsSync(path.join(root, 'static', f)), `on disk: static/${f} exists`);
  ok(runPy.includes(`"${f}"`), `run.py: ${f} in the subtree lists`);
  ok(buildCap.includes(`"${f}"`), `build-capacitor.sh: ${f} in the subtree lists`);
}

// Reverse drift guard: every code file inside the subtree directories must
// be registered (vendor/ third-party bundles excepted — they ride the
// bundled app and are not versioned).
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
for (const d of SUBTREE_DIRS) {
  const files = walk(path.join(root, 'static', d))
    .map((p) => path.relative(path.join(root, 'static'), p).split(path.sep).join('/'))
    .filter((f) => /\.(js|html|css)$/.test(f) && !f.includes('/vendor/'));
  for (const f of files) {
    ok(runPy.includes(`"${f}"`), `run.py: ${f} registered (new file in ${d}/ subtree?)`);
    ok(buildCap.includes(`"${f}"`), `build-capacitor.sh: ${f} registered (new file in ${d}/ subtree?)`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
