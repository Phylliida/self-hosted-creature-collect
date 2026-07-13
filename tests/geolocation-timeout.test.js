// Guards the fix for "GPS being weird on iOS".
//
// Both of the app's location watches must run with a BOUNDED timeout.
// Without one, watchPosition's timeout defaults to Infinity, so on iOS a
// slow or blocked high-accuracy lock (indoors, urban canyon, cold GPS)
// leaves the watch silently hung — neither the success nor the error
// callback ever fires, the dot never appears, spawns never load, and the
// GeolocateControl button spins in "waiting" forever. That reads to the
// user as GPS being broken. OpenStreetMap's locate control always runs
// with a timeout; we now match that.
//
// This is a static source-assertion test (like tests/bag-sort.test.js): it
// reads the two option literals and asserts each declares enableHighAccuracy
// plus a finite, positive timeout. It exists because the MapLibre default
// timeout was ALREADY silently dropped once — passing our own
// positionOptions object shallow-replaces MapLibre's default
// {enableHighAccuracy:false, maximumAge:0, timeout:6000} wholesale — so this
// regression is invisible at runtime and easy to reintroduce.
//
// Run: node tests/geolocation-timeout.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
const creaturesSrc = fs.readFileSync(path.join(root, 'static', 'creatures.js'), 'utf8');

// Pull "timeout: <number>" out of an option-object body and validate it is a
// real, bounded budget (finite integer > 0 and <= 60s — a sane ceiling).
function assertBoundedTimeout(body, label) {
  const m = body.match(/timeout\s*:\s*(\d+)/);
  ok(!!m, `${label}: option object must declare a timeout`);
  if (!m) return;
  const v = Number(m[1]);
  ok(Number.isFinite(v) && v > 0 && v <= 60000,
    `${label}: timeout must be finite, positive and <= 60000 (got ${m[1]})`);
}

// --- 1) MapLibre GeolocateControl positionOptions (the blue-dot watch) -----
{
  const at = indexSrc.indexOf('positionOptions:');
  ok(at >= 0, 'index.html: GeolocateControl positionOptions present');
  // positionOptions is a flat literal (no nested braces), so read to the
  // first closing brace.
  const open = indexSrc.indexOf('{', at);
  const close = indexSrc.indexOf('}', open);
  const body = indexSrc.slice(open, close + 1);
  ok(/enableHighAccuracy\s*:\s*true/.test(body),
    'index.html: positionOptions keeps enableHighAccuracy:true (walking game needs GPS-grade fixes)');
  assertBoundedTimeout(body, 'index.html positionOptions');
}

// --- 2) creatures.js startLocationWatch() watchPosition options ------------
// The options object is the third argument to watchPosition; it is the only
// place enableHighAccuracy appears in the file.
{
  const at = creaturesSrc.indexOf('enableHighAccuracy');
  ok(at >= 0, 'creatures.js: watchPosition options object present');
  const open = creaturesSrc.lastIndexOf('{', at);
  const close = creaturesSrc.indexOf('}', at);
  const body = creaturesSrc.slice(open, close + 1);
  ok(/enableHighAccuracy\s*:\s*true/.test(body),
    'creatures.js: watch keeps enableHighAccuracy:true');
  assertBoundedTimeout(body, 'creatures.js watchPosition');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
