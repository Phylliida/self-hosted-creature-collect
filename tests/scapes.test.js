// Guards the Extras soundscapes tool (static/extras-scapes.js).
//
//   (1) ScapesCore — seeded RNG determinism, noise generators (bounds,
//       spectral ordering white > pink > brown via zero-crossing rate),
//       and the baked event textures (droplets/crackles/chirps/thunder
//       actually deposit energy onto silence, within headroom).
//   (2) Design invariants — completely fetch-free (the textures are
//       synthesized, not sampled); playback deliberately survives the
//       panel closing (no stop-on-hide of the audio graph); sleep-timer
//       fade is scheduled on the AUDIO clock so it fires while JS
//       sleeps; iOS background-audio wiring present (UIBackgroundModes
//       + AVAudioSession .playback).
//
// Run: node tests/scapes.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
require(path.join(root, 'static', 'extras-scapes.js'));
const C = globalThis.ScapesCore;
ok(!!C, 'ScapesCore exported under Node');

const SR = 44100;

// --- 1) RNG + noise ----------------------------------------------------------
{
  const a = C.makeRng(42), b = C.makeRng(42), c = C.makeRng(43);
  const sa = [a(), a(), a()], sb = [b(), b(), b()], sc = [c(), c(), c()];
  ok(sa.every((v, i) => v === sb[i]), 'makeRng: same seed -> same sequence');
  ok(sa.some((v, i) => v !== sc[i]), 'makeRng: different seed -> different sequence');
  ok(sa.every((v) => v >= 0 && v < 1), 'makeRng: values in [0,1)');
}
function gen(kind, seconds) {
  const arr = new Float32Array(Math.floor(SR * seconds));
  const rng = C.makeRng(7);
  C['fill' + kind](arr, rng);
  return arr;
}
const white = gen('White', 2), pink = gen('Pink', 2), brown = gen('Brown', 2);
ok(C.peak(white) <= 1.0001, 'white noise bounded');
ok(C.peak(pink) <= 1.2, 'pink noise bounded');
ok(Math.abs(C.peak(brown) - 0.8) < 0.01, 'brown noise normalized to 0.8 peak');
{
  const mean = white.reduce((s, v) => s + v, 0) / white.length;
  ok(Math.abs(mean) < 0.01, 'white noise ~zero mean');
}
{
  const zw = C.zeroCrossRate(white), zp = C.zeroCrossRate(pink), zb = C.zeroCrossRate(brown);
  ok(zw > zp && zp > zb,
    'spectral tilt ordering: white (' + zw.toFixed(3) + ') > pink (' + zp.toFixed(3) +
    ') > brown (' + zb.toFixed(3) + ')');
  ok(zb < 0.05, 'brown noise is genuinely low-frequency (rare zero crossings)');
}

// --- baked textures on silence ----------------------------------------------
function baked(fn, seconds, ...args) {
  const arr = new Float32Array(Math.floor(SR * seconds));
  const rng = C.makeRng(99);
  C[fn](arr, SR, rng, ...args);
  return arr;
}
for (const [fn, secs, args] of [
  ['addDroplets', 4, [14, 1]],
  ['addCrackles', 4, [9, 1]],
  ['addChirps', 6, [1]],
  ['addThunder', 20, [1]],
]) {
  const arr = baked(fn, secs, ...args);
  const p = C.peak(arr);
  ok(p > 0.03, fn + ': deposits audible events onto silence (peak ' + p.toFixed(3) + ')');
  ok(p <= 2.0, fn + ': stays within sane pre-normalization headroom');
  // events are sparse: most samples stay silent
  let quiet = 0;
  for (let i = 0; i < arr.length; i++) if (Math.abs(arr[i]) < 1e-4) quiet++;
  ok(quiet / arr.length > 0.3, fn + ': texture is event-like, not a constant wash');
}
{
  // determinism end-to-end: same seed bakes identical textures
  const a = baked('addDroplets', 2, 14, 1), b = baked('addDroplets', 2, 14, 1);
  ok(a.every((v, i) => v === b[i]), 'baked textures deterministic per seed');
}

// --- 2) design invariants ----------------------------------------------------
const src = fs.readFileSync(path.join(root, 'static', 'extras-scapes.js'), 'utf8');
ok(!/\bfetch\s*\(|XMLHttpRequest|\.mp3|\.ogg|\.wav/.test(src),
  'scapes: fully synthesized — no fetch, no sample files');
ok(/linearRampToValueAtTime\(0\.0001,\s*sleepDeadline\)/.test(src),
  'scapes: sleep fade scheduled on the audio clock (survives JS suspension)');
ok(/NOT stop playback/i.test(src.replace(/\n\/\/ {0,5}/g, ' ')),
  'scapes: documented keep-playing-on-close contract');
{
  // the visibility check() must only gate the UI ticker, never stopScape/stopAll
  const at = src.indexOf('const check = ()');
  const body = src.slice(at, src.indexOf('};', at));
  ok(at > 0 && !/stopAll|stopScape/.test(body),
    'scapes: hiding the panel stops only the UI ticker, not the audio');
}
ok(/ExtrasRegisterTool/.test(src) && /id:\s*'scapes'/.test(src),
  'scapes: registers as an Extras tool');

const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
ok(indexSrc.includes('<script src="/static/extras-scapes.js"></script>'),
  'index.html: scapes script tag present');
ok(indexSrc.includes("'/static/extras-scapes.js'"),
  'index.html: scapes in the refresh cache-delete list');
const runPy = fs.readFileSync(path.join(root, 'run.py'), 'utf8');
ok(/_TRACKED_JS = \{[\s\S]*?extras-scapes\.js[\s\S]*?\}/.test(runPy)
  && /_SCRIPT_VERSION_FILES = \[[\s\S]*?extras-scapes\.js[\s\S]*?\]/.test(runPy),
  'run.py: scapes tracked for live-update');

const iosWf = fs.readFileSync(path.join(root, '.github', 'workflows', 'ios-build.yml'), 'utf8');
ok(/UIBackgroundModes/.test(iosWf) && /string audio/.test(iosWf),
  'ios-build.yml: UIBackgroundModes audio (playback survives screen lock)');
const bridgeVc = fs.readFileSync(path.join(root, 'ios-overrides', 'AppBridgeViewController.swift'), 'utf8');
ok(/AVAudioSession/.test(bridgeVc) && /\.playback/.test(bridgeVc) && /mixWithOthers/.test(bridgeVc),
  'AppBridgeViewController: AVAudioSession .playback + mixWithOthers');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
