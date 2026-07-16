// Guards the Extras microtonal tuner (static/extras-tuner.js).
//
//   (1) TunerCore.detectPitch — YIN autocorrelation on synthesized
//       waveforms: pure sines across the range, harmonic-rich tones
//       (fundamental wins), noise and silence rejected. Accuracy is
//       asserted in CENTS (< 3¢) since that's what the needle shows.
//   (2) Scale math — Scala cents-list normalization, nearest-degree
//       search with period stacking (incl. non-octave Bohlen-Pierce),
//       wrap-around to the next period's root, 12-EDO naming.
//   (3) Source/wiring invariants — mic only starts from a tap, the only
//       fetch is the local scala-db.json asset, script registered and
//       tracked everywhere it must be.
//
// Run: node tests/tuner.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
require(path.join(root, 'static', 'extras-tuner.js'));
const C = globalThis.TunerCore;
ok(!!C, 'TunerCore exported under Node');

const SR = 44100, N = 4096;
function sine(freq, amp) {
  const b = new Float32Array(N);
  for (let i = 0; i < N; i++) b[i] = (amp || 0.5) * Math.sin(2 * Math.PI * freq * i / SR);
  return b;
}
function centsOff(f, target) { return Math.abs(1200 * Math.log2(f / target)); }

// --- 1) pitch detection ------------------------------------------------------
for (const f of [82.41, 110, 196, 261.63, 329.63, 440, 587.33, 880, 1318.5]) {
  const r = C.detectPitch(sine(f), SR);
  ok(r && centsOff(r.freq, f) < 3, 'detectPitch: pure sine ' + f + ' Hz within 3 cents' +
    (r ? ' (got ' + r.freq.toFixed(2) + ')' : ' (got null)'));
}
{
  // harmonic-rich tone (decaying overtones, like a plucked string)
  const b = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    b[i] = 0.5 * Math.sin(2 * Math.PI * 220 * t)
         + 0.3 * Math.sin(2 * Math.PI * 440 * t + 0.7)
         + 0.2 * Math.sin(2 * Math.PI * 660 * t + 1.3)
         + 0.1 * Math.sin(2 * Math.PI * 880 * t + 2.1);
  }
  const r = C.detectPitch(b, SR);
  ok(r && centsOff(r.freq, 220) < 3,
    'detectPitch: harmonic tone locks the FUNDAMENTAL (got ' + (r ? r.freq.toFixed(2) : 'null') + ')');
}
{
  const silence = new Float32Array(N);
  ok(C.detectPitch(silence, SR) === null, 'detectPitch: silence -> null');
  let s = 12345;
  const noise = new Float32Array(N);
  for (let i = 0; i < N; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; noise[i] = (s / 0x7fffffff) - 0.5; }
  const r = C.detectPitch(noise, SR);
  ok(r === null || r.clarity < 0.6, 'detectPitch: white noise rejected or low clarity');
}

// --- 2) scale math -----------------------------------------------------------
{
  const s = C.scaleDegrees([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200]);
  ok(s.period === 1200 && s.degrees.length === 12 && s.degrees[0] === 0 && s.degrees[11] === 1100,
    'scaleDegrees: 12-tone cents list normalizes to 12 pitch classes');
  const neg = C.scaleDegrees([-100, 700, 1200]);
  ok(neg.degrees.includes(1100), 'scaleDegrees: negative cents wrap into [0, period)');
  ok(C.scaleDegrees([0]) === null || C.scaleDegrees([-5]) === null,
    'scaleDegrees: non-positive period rejected');
}
{
  // 12-EDO with root C4 (A440): A above root is exactly 440
  const rootHz = 440 * Math.pow(2, -9 / 12);
  const hit = C.nearestDegree(440, rootHz, { edo: 12 });
  ok(hit.deg === 9 && Math.abs(hit.off) < 1e-6 && Math.abs(hit.targetHz - 440) < 1e-6,
    'nearestDegree: 12-EDO A440 dead on (deg 9, 0 cents)');
  const sharp = C.nearestDegree(445, rootHz, { edo: 12 });
  ok(sharp.deg === 9 && Math.abs(sharp.off - 19.56) < 0.1,
    'nearestDegree: 445 Hz reads +19.56 cents sharp of A');
  // wrap: 2 cents under the octave -> next period's root, -2 cents
  const wrap = C.nearestDegree(rootHz * Math.pow(2, 1198 / 1200), rootHz, { edo: 12 });
  ok(wrap.deg === 0 && wrap.periodIndex === 1 && Math.abs(wrap.off + 2) < 0.01,
    'nearestDegree: wraps to the next period root (-2 cents)');
}
{
  // Bohlen-Pierce: 13 equal steps of a 1902-cent tritave
  const cents = [];
  for (let i = 1; i <= 13; i++) cents.push(1902 * i / 13);
  const bp = C.scaleDegrees(cents);
  ok(Math.abs(bp.period - 1902) < 1e-9 && bp.degrees.length === 13,
    'scaleDegrees: Bohlen-Pierce tritave period preserved');
  const rootHz = 220;
  const tritave = C.nearestDegree(220 * Math.pow(2, 1902 / 1200), rootHz, bp);
  ok(tritave.deg === 0 && tritave.periodIndex === 1 && Math.abs(tritave.off) < 1e-6,
    'nearestDegree: one tritave up = next-period root in BP');
  const step5 = C.nearestDegree(220 * Math.pow(2, (5 * 1902 / 13 + 4) / 1200), rootHz, bp);
  ok(step5.deg === 5 && Math.abs(step5.off - 4) < 0.01,
    'nearestDegree: BP degree 5, +4 cents');
}
{
  const a = C.freqToNote12(440, 440);
  ok(a.name === 'A' && a.octave === 4 && Math.abs(a.off) < 1e-9, 'freqToNote12: A4');
  const c = C.freqToNote12(261.6256, 440);
  ok(c.name === 'C' && c.octave === 4 && Math.abs(c.off) < 0.01, 'freqToNote12: C4');
  const b = C.freqToNote12(466.16, 440);
  ok(b.name === 'A♯' && b.octave === 4, 'freqToNote12: A♯4');
  const off432 = C.freqToNote12(432, 432);
  ok(off432.name === 'A' && Math.abs(off432.off) < 1e-9, 'freqToNote12: honours A4 calibration');
}

// --- 3) source/wiring invariants --------------------------------------------
const src = fs.readFileSync(path.join(root, 'static', 'extras-tuner.js'), 'utf8');
ok(!/getUserMedia[\s\S]{0,400}?buildTuner/.test('') && /startBtn\.onclick/.test(src) && /getUserMedia/.test(src),
  'tuner: mic starts only from the Start button tap');
{
  const fetches = src.match(/fetch\(([^)]*)\)/g) || [];
  ok(fetches.length === 1 && fetches[0].includes('/static/scala-db.json'),
    'tuner: the ONLY fetch is the local scala-db.json asset (zero-network)');
}
ok(/window\.SCALA_DB|global\.SCALA_DB/.test(src),
  'tuner: honours a preloaded SCALA_DB (test/headless hook, same as synth)');
ok(/stopMic\(/.test(src) && /visibilitychange/.test(src),
  'tuner: mic torn down when the tool hides');

const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
ok(indexSrc.includes('<script src="/static/extras-tuner.js"></script>'),
  'index.html: tuner script tag present');
ok(indexSrc.includes("'/static/extras-tuner.js'"),
  'index.html: tuner in the refresh cache-delete list');
const runPy = fs.readFileSync(path.join(root, 'run.py'), 'utf8');
ok(/_TRACKED_JS = \{[\s\S]*?extras-tuner\.js[\s\S]*?\}/.test(runPy)
  && /_SCRIPT_VERSION_FILES = \[[\s\S]*?extras-tuner\.js[\s\S]*?\]/.test(runPy),
  'run.py: tuner tracked for live-update');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
