// Guards the fix for "GPS being weird on iOS", now covering TWO invariants:
//
//   (1) The app's one geolocation watch must run with a BOUNDED timeout.
//       Without one, watchPosition's timeout defaults to Infinity, so on
//       iOS a slow or blocked high-accuracy lock (indoors, urban canyon,
//       cold GPS) leaves the watch silently hung — neither success nor
//       error ever fires, the dot never appears, spawns never load, and
//       the GeolocateControl button spins in "waiting" forever. That reads
//       as GPS being broken. OpenStreetMap's locate control always runs
//       with a timeout; we match that. This is invisible at runtime and was
//       ALREADY introduced once (passing our own positionOptions object
//       shallow-replaces MapLibre's default {..., timeout:6000} wholesale).
//
//   (2) SINGLE-WATCH invariant. The app runs exactly ONE OS-level watch —
//       MapLibre's GeolocateControl. creatures.js must NOT open its own
//       second navigator.geolocation.watchPosition; instead it subscribes
//       to the control's fixes via Creatures.onLocationFix(pos), pushed
//       from index.html's 'geolocate' handler. Two simultaneous
//       high-accuracy watches are exactly the GPS-churn / bridge-race
//       source the consolidation removed, so guard against a second one
//       creeping back.
//
// Static source-assertion test (like tests/bag-sort.test.js).
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

// --- 2) creatures.js must NOT open a second watch (single-watch invariant) --
// After consolidation the app runs exactly one OS-level geolocation watch
// (the GeolocateControl asserted above). creatures.js subscribes to it via
// Creatures.onLocationFix(pos) instead of running its own watchPosition.
{
  ok(!/navigator\.geolocation\.watchPosition/.test(creaturesSrc),
    'creatures.js: must NOT open its own watchPosition ' +
    '(single-watch: subscribe to the GeolocateControl via onLocationFix)');
  ok(/function onLocationFix\b/.test(creaturesSrc),
    'creatures.js: defines onLocationFix (the single-watch fix consumer)');
  ok(/\bonLocationFix\b/.test(creaturesSrc.slice(creaturesSrc.indexOf('global.Creatures'))),
    'creatures.js: exposes onLocationFix on the public API');
  ok(/window\.Creatures\.onLocationFix/.test(indexSrc),
    'index.html: forwards GeolocateControl fixes into Creatures.onLocationFix');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
