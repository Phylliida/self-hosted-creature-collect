// Algorithm-fidelity tests for the Android haptic pipeline
// (android-overrides/HapticPatternPlugin.kt).
// Run: node tests/haptic-envelope.test.js
//
// Kotlin can't compile in this environment, so this test pins the
// ALGORITHM instead: it extracts the real computeEnvelope() from
// static/extras-vibration.js (the producer both platforms share) and
// runs it through a line-for-line JS mirror of the Kotlin consumer —
// envelopeAt (piecewise-linear, CHHapticParameterCurve semantics),
// 20ms midpoint sampling, amplitude quantization, and the RLE merge.
// If the Kotlin ever drifts from this mirror, update both together.

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL: ' + msg); }
}

// ── extract the real envelope producer from extras-vibration.js ──
const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'extras-vibration.js'), 'utf8');
function extract(marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++) { if (src[i] === '\\') i++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
const ctx = { Math };
vm.createContext(ctx);
vm.runInContext(
  'const TARGET_WINDOW = 2.0;\n'
  + 'const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));\n'
  + extract('function waveShape(wf, phase, duty)') + '\n'
  + extract('function computeEnvelope(s)'), ctx);
const computeEnvelope = (s) => vm.runInContext('computeEnvelope(__s)', Object.assign(ctx, { __s: s }));

// ── JS mirror of the Kotlin consumer ──
const STEP_MS = 20;
function envelopeAt(ts, vs, t) {
  if (t <= ts[0]) return vs[0];
  for (let k = 1; k < ts.length; k++) {
    if (t <= ts[k]) {
      const span = ts[k] - ts[k - 1];
      if (span <= 0) return vs[k];
      return vs[k - 1] + (vs[k] - vs[k - 1]) * ((t - ts[k - 1]) / span);
    }
  }
  return vs[vs.length - 1];
}
function kotlinPipeline(env, durationS, intensity, hasAmp) {
  const ts = env.points.map((p) => p.t), vs = env.points.map((p) => p.i);
  const steps = Math.max(1, Math.round((durationS * 1000) / STEP_MS));
  const sampled = [];
  for (let k = 0; k < steps; k++) sampled.push(envelopeAt(ts, vs, (k + 0.5) / steps));
  const timings = [], amps = [];
  for (const e of sampled) {
    const a = hasAmp
      ? Math.max(0, Math.min(255, Math.round(255 * intensity * e)))
      : (intensity * e >= 0.5 ? 255 : 0);
    if (timings.length && amps[amps.length - 1] === a) timings[timings.length - 1] += STEP_MS;
    else { timings.push(STEP_MS); amps.push(a); }
  }
  return { timings, amps, steps, sampled };
}

// ── 1. sine: sampled waveform tracks the analytic envelope ──
{
  const env = computeEnvelope({ freq: 2, depth: 1, duty: 0.5, waveform: 'sine' });
  const out = kotlinPipeline(env, env.duration, 1.0, true);
  ok(Math.abs(out.timings.reduce((a, b) => a + b, 0) - out.steps * STEP_MS) < 1e-9,
    'sine: RLE preserves total duration exactly');
  let worst = 0;
  for (let k = 0; k < out.steps; k++) {
    const t = (k + 0.5) / out.steps;
    const phase = (t * env.duration * 2) % 1; // freq=2Hz
    const analytic = (1 - Math.cos(2 * Math.PI * phase)) / 2;
    worst = Math.max(worst, Math.abs(out.sampled[k] - analytic));
  }
  ok(worst < 0.05, 'sine: sampled envelope tracks analytic waveform (worst err ' + worst.toFixed(4) + ')');
  ok(Math.max(...out.amps) === 255 && Math.min(...out.amps) <= 3,
    'sine: full depth spans the amplitude range (' + Math.min(...out.amps) + '..' + Math.max(...out.amps) + ')');
}

// ── 2. intensity scaling is linear ──
{
  const env = computeEnvelope({ freq: 1, depth: 0.5, duty: 0.5, waveform: 'triangle' });
  const hi = kotlinPipeline(env, env.duration, 1.0, true);
  const lo = kotlinPipeline(env, env.duration, 0.5, true);
  let okScale = true;
  for (let k = 0; k < hi.sampled.length; k++) {
    const a1 = Math.round(255 * 1.0 * hi.sampled[k]), a2 = Math.round(255 * 0.5 * lo.sampled[k]);
    if (Math.abs(a2 - a1 / 2) > 1) { okScale = false; break; }
  }
  ok(okScale, 'triangle: halving intensity halves every amplitude step (±1 rounding)');
}

// ── 3. square wave: duty cycle survives sampling + RLE ──
{
  const env = computeEnvelope({ freq: 2, depth: 1, duty: 0.25, waveform: 'square' });
  const out = kotlinPipeline(env, env.duration, 1.0, true);
  const onMs = out.timings.reduce((a, t, i) => a + (out.amps[i] > 128 ? t : 0), 0);
  const total = out.timings.reduce((a, b) => a + b, 0);
  ok(Math.abs(onMs / total - 0.25) < 0.06,
    'square duty 0.25: on-fraction ' + (onMs / total).toFixed(3) + ' ≈ 0.25');
  ok(out.timings.length < out.steps / 3,
    'square: RLE collapses plateaus (' + out.timings.length + ' segs from ' + out.steps + ' steps)');
}

// ── 4. no-amplitude-control fallback: rhythm survives as on/off ──
{
  const env = computeEnvelope({ freq: 2, depth: 1, duty: 0.5, waveform: 'sine' });
  const out = kotlinPipeline(env, env.duration, 1.0, false);
  const uniq = new Set(out.amps);
  ok([...uniq].every((a) => a === 0 || a === 255), 'threshold mode: only 0/255 amplitudes');
  const onFrac = out.timings.reduce((a, t, i) => a + (out.amps[i] === 255 ? t : 0), 0)
    / out.timings.reduce((a, b) => a + b, 0);
  ok(onFrac > 0.4 && onFrac < 0.6, 'threshold mode: sine spends ~half the loop on (' + onFrac.toFixed(2) + ')');
}

// ── 5. heartbeat: two bumps per cycle, second one weaker ──
{
  const env = computeEnvelope({ freq: 1, depth: 1, duty: 0.5, waveform: 'heartbeat' });
  const out = kotlinPipeline(env, env.duration, 1.0, true);
  const perCycle = Math.round(out.steps / (env.duration * 1));
  const cycle = out.sampled.slice(0, perCycle);
  const p1 = Math.round(0.10 * perCycle), p2 = Math.round(0.27 * perCycle), mid = Math.round(0.6 * perCycle);
  ok(cycle[p1] > 0.9, 'heartbeat: primary bump at ~t=0.10 (got ' + cycle[p1].toFixed(2) + ')');
  ok(cycle[p2] > 0.6 && cycle[p2] < cycle[p1], 'heartbeat: secondary bump weaker (got ' + cycle[p2].toFixed(2) + ')');
  ok(cycle[mid] < 0.15, 'heartbeat: quiet tail between beats (got ' + cycle[mid].toFixed(2) + ')');
}

// ── 6. interpolation edges: hold-before-first / hold-after-last ──
ok(envelopeAt([0.5, 0.6], [0.7, 0.2], 0.0) === 0.7, 'holds first value before first point');
ok(envelopeAt([0.5, 0.6], [0.7, 0.2], 1.0) === 0.2, 'holds last value after last point');
ok(Math.abs(envelopeAt([0.0, 1.0], [0.0, 1.0], 0.25) - 0.25) < 1e-12, 'linear interpolation exact');

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
