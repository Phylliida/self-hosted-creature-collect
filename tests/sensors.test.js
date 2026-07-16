// Guards the Extras "Sensors" dashboard (static/extras-sensors.js) and its
// dual-platform native half (SensorProbePlugin.swift / .kt):
//
//   (1) SensorsCore pure math — compass points, heading derivation (iOS
//       webkitCompassHeading vs Android absolute alpha), tilt clamps,
//       RMS->dBFS, barometric trend classification, byte formatting.
//   (2) Invariants on the JS file: it must never open its own geolocation
//       watch (single-watch invariant — it subscribes to the map's watch
//       via the ExtrasSensors.onLocationFix hook) and must never fetch
//       (zero-network app).
//   (3) Wiring: script tag + refresh cache-delete + geolocate fan-out in
//       index.html; run.py version tracking; the native plugin present,
//       registered, and copied on BOTH platform CI builds; mic usage
//       strings/permissions in both workflows.
//
// Static source-assertion + unit-test hybrid (like tests/skymap.test.js).
// Run: node tests/sensors.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }
function eq(a, b, msg) { ok(Object.is(a, b), msg + ' (got ' + a + ', want ' + b + ')'); }

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// --- 1) SensorsCore (headless load: no document, no ExtrasRegisterTool) ----
require(path.join(root, 'static', 'extras-sensors.js'));
const C = globalThis.SensorsCore;
ok(!!C, 'SensorsCore exported under Node');

eq(C.compassPoint(0), 'N', 'compassPoint 0');
eq(C.compassPoint(359), 'N', 'compassPoint 359 wraps');
eq(C.compassPoint(100), 'E', 'compassPoint 100');
eq(C.compassPoint(-90), 'W', 'compassPoint handles negatives');
eq(C.compassPoint(202.5), 'SSW', 'compassPoint boundary');

eq(C.headingFrom({ webkitCompassHeading: 123.4 }, 0), 123.4,
  'headingFrom: iOS webkitCompassHeading passes through');
eq(C.headingFrom({ alpha: 90, absolute: true }, 0), 270,
  'headingFrom: absolute alpha converts CCW->CW');
eq(C.headingFrom({ alpha: 90, absolute: true }, 90), 0,
  'headingFrom: screen rotation compensated');
eq(C.headingFrom({ alpha: 90 }, 0), null,
  'headingFrom: non-absolute alpha has no north reference -> null');
eq(C.headingFrom({ webkitCompassHeading: -1, alpha: 10, absolute: true }, 0), 350,
  'headingFrom: invalid (negative) webkitCompassHeading falls through');

const t1 = C.tiltFrom(200, -120);
ok(t1.pitch === 90 && t1.roll === -90, 'tiltFrom clamps to ±90');
eq(C.tiltFrom(10.5, -3).pitch, 10.5, 'tiltFrom passes sane pitch');

eq(C.rmsToDb(1), 0, 'rmsToDb: full scale = 0 dBFS');
eq(C.rmsToDb(0), -90, 'rmsToDb: silence floors at -90');
ok(Math.abs(C.rmsToDb(0.1) + 20) < 1e-9, 'rmsToDb: 0.1 -> -20 dBFS');

// Trend: too few samples / too short a span -> null label
eq(C.pressureTrend([], Date.now()).label, null, 'trend: empty -> null');
{
  const now = 100 * 3600e3;
  const mk = (mins, hPa) => ({ t: now - mins * 60e3, hPa });
  eq(C.pressureTrend([mk(10, 1010), mk(8, 1010), mk(6, 1010), mk(4, 1010), mk(0, 1010)], now).label,
    null, 'trend: 10-min span too short');
  const steady = C.pressureTrend(
    [mk(60, 1010.1), mk(45, 1010), mk(30, 1010.1), mk(15, 1010), mk(0, 1010.05)], now);
  eq(steady.label, 'steady', 'trend: flat hour = steady');
  const falling = C.pressureTrend(
    [mk(90, 1012), mk(60, 1011), mk(30, 1010), mk(15, 1009.5), mk(0, 1009)], now);
  eq(falling.label, 'falling fast', 'trend: ~2 hPa/h drop = falling fast');
  ok(falling.rate3h < -3.5, 'trend: rate3h reflects the 3-hour equivalent');
  const rising = C.pressureTrend(
    [mk(120, 1009), mk(90, 1009.3), mk(60, 1009.6), mk(30, 1009.9), mk(0, 1010.2)], now);
  eq(rising.label, 'rising', 'trend: ~0.6 hPa/h climb = rising');
  // Samples older than the 3 h window are ignored
  const windowed = C.pressureTrend(
    [mk(600, 900), mk(60, 1010), mk(45, 1010), mk(30, 1010), mk(15, 1010), mk(0, 1010)], now);
  eq(windowed.label, 'steady', 'trend: ancient outlier outside 3 h window ignored');
}

eq(C.fmtBytes(512 * 1024), '512 KB', 'fmtBytes KB');
eq(C.fmtBytes(3.5 * 1024 * 1024 * 1024), '3.50 GB', 'fmtBytes GB');
eq(C.fmtBytes(NaN), '—', 'fmtBytes NaN');

// --- 2) Invariants on the dashboard source ---------------------------------
const sns = read('static', 'extras-sensors.js');
ok(!/navigator\.geolocation\.(watchPosition|getCurrentPosition)/.test(sns),
  'extras-sensors.js: never opens its own geolocation watch/one-shot ' +
  '(single-watch invariant — must use the ExtrasSensors.onLocationFix feed)');
ok(/global\.ExtrasSensors\s*=/.test(sns) && /onLocationFix/.test(sns),
  'extras-sensors.js: exposes the onLocationFix feed hook');
ok(!/\bfetch\s*\(|XMLHttpRequest/.test(sns),
  'extras-sensors.js: zero-network (no fetch/XHR)');
ok(/ExtrasRegisterTool/.test(sns) && /id:\s*'sensors'/.test(sns),
  'extras-sensors.js: registers as an Extras tool');
ok(/getUserMedia/.test(sns) && /onclick/.test(sns),
  'extras-sensors.js: mic meter present and gated behind a tap');
ok(/stopMic\(\)/.test(sns.slice(sns.indexOf('function stop()'))),
  'extras-sensors.js: hiding the tool stops the microphone');

// --- 3) Wiring --------------------------------------------------------------
const indexSrc = read('static', 'index.html');
ok(indexSrc.includes('<script src="/static/extras-sensors.js"></script>'),
  'index.html: script tag present');
ok(indexSrc.includes("'/static/extras-sensors.js'"),
  'index.html: refresh-button cache-delete list includes extras-sensors.js');
ok(/window\.ExtrasSensors\s*&&\s*typeof window\.ExtrasSensors\.onLocationFix/.test(indexSrc),
  'index.html: geolocate fan-out feeds ExtrasSensors.onLocationFix');
ok(/window\._ccLatestFix\s*=/.test(indexSrc),
  'index.html: latest fix stashed for late-opening dashboard');

const runPy = read('run.py');
ok(/_TRACKED_JS = \{[\s\S]*?extras-sensors\.js[\s\S]*?\}/.test(runPy),
  'run.py: extras-sensors.js in _TRACKED_JS');
ok(/_SCRIPT_VERSION_FILES = \[[\s\S]*?extras-sensors\.js[\s\S]*?\]/.test(runPy),
  'run.py: extras-sensors.js in _SCRIPT_VERSION_FILES');

// Native plugin, both platforms
const swift = read('ios-overrides', 'SensorProbePlugin.swift');
ok(/jsName = "SensorProbe"/.test(swift), 'iOS plugin: jsName SensorProbe');
ok(/CMAltimeter/.test(swift) && /\* 10\.0/.test(swift),
  'iOS plugin: barometer via CMAltimeter, kPa->hPa conversion');
ok(/notifyListeners\("reading"/.test(swift), 'iOS plugin: streams reading events');
const kt = read('android-overrides', 'SensorProbePlugin.kt');
ok(/@CapacitorPlugin\(name = "SensorProbe"\)/.test(kt), 'Android plugin: jsName SensorProbe');
ok(/TYPE_PRESSURE/.test(kt) && /TYPE_MAGNETIC_FIELD/.test(kt) && /TYPE_LIGHT/.test(kt),
  'Android plugin: pressure + magnetometer + light sensors');
ok(/notifyListeners\("reading"/.test(kt), 'Android plugin: streams reading events');
ok(/handleOnPause/.test(kt), 'Android plugin: pauses with the app');

const iosWf = read('.github', 'workflows', 'ios-build.yml');
ok(/cp ios-overrides\/SensorProbePlugin\.swift/.test(iosWf),
  'ios-build.yml: copies SensorProbePlugin.swift');
ok(/NSMicrophoneUsageDescription/.test(iosWf),
  'ios-build.yml: mic usage description for the level meter');
const rb = read('ios-overrides', 'inject-into-xcodeproj.rb');
ok(/SensorProbePlugin\.swift/.test(rb), 'inject-into-xcodeproj.rb: plugin in NEW_FILES');
const bridgeVc = read('ios-overrides', 'AppBridgeViewController.swift');
ok(/registerPluginInstance\(SensorProbePlugin\(\)\)/.test(bridgeVc),
  'AppBridgeViewController: registers SensorProbePlugin');

const andWf = read('.github', 'workflows', 'android-build.yml');
ok(/registerPlugin\(SensorProbePlugin\.class\);/.test(andWf),
  'android-build.yml: MainActivity registers SensorProbePlugin');
ok(/RECORD_AUDIO/.test(andWf),
  'android-build.yml: RECORD_AUDIO permission for the mic meter');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
