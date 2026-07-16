// Guards the fixes for "GPS jumps around on iOS" (shared-CLLocationManager
// accuracy clobbering + stale / out-of-order fix delivery).
//
// Root-cause chain (see @capacitor/geolocation's iOS GeolocationPlugin.swift,
// identical in v6 and v7):
//
//   - The native plugin drives EVERY call through one shared
//     CLLocationManager. getCurrentPosition({enableHighAccuracy:false})
//     sets desiredAccuracy = kCLLocationAccuracyThreeKilometers on that
//     shared manager, silently downgrading the GeolocateControl's live
//     watch to cell-tower-grade fixes — the dot leaps blocks away.
//   - ensureLocationPermission() used to fire exactly such a coarse
//     one-shot on every load / focus / visibility flip. Its
//     navigator.permissions guard can never trip under the Capacitor shim:
//     the page never asks WebKit for geolocation, so WebKit's page-level
//     permission state stays 'prompt' forever.
//   - The plugin ignores maximumAge (CoreLocation replays a stale cached
//     fix when a watch starts) and reports locations.first — the OLDEST
//     fix of each CoreLocation batch — so bursty bridge delivery can move
//     the reported position backwards in time.
//
// Invariants:
//   (1) ensureLocationPermission primes via the Capacitor permissions API
//       (checkPermissions/requestPermissions) and RETURNS before the web
//       getCurrentPosition fallback whenever the plugin exists.
//   (2) The iOS shim's getCurrentPosition forces enableHighAccuracy:true,
//       so no one-shot call can ever coarsen the shared manager again.
//   (3) The iOS shim's watch callback drops stale fixes (maximumAge
//       stand-in) and out-of-order fixes (locations.first batch bug)
//       before fanning out. The Android BgLoc path keeps its own guard.
//
// Static source-assertion test (like tests/geolocation-timeout.test.js).
// Run: node tests/geolocation-ios-accuracy.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');

// Slice a named block out of the source between two anchors, asserting both
// anchors exist so a refactor that moves code fails loudly instead of
// silently testing the wrong region.
function slice(label, startAnchor, endAnchor) {
  const a = indexSrc.indexOf(startAnchor);
  ok(a >= 0, `${label}: start anchor found ("${startAnchor.slice(0, 40)}...")`);
  const b = indexSrc.indexOf(endAnchor, a);
  ok(b > a, `${label}: end anchor found ("${endAnchor.slice(0, 40)}...")`);
  return (a >= 0 && b > a) ? indexSrc.slice(a, b) : '';
}

// --- 1) ensureLocationPermission: Capacitor permissions API, not a fix ----
{
  const body = slice('ensureLocationPermission',
    'async function ensureLocationPermission()',
    'ensureLocationPermission();');

  const check = body.indexOf('checkPermissions()');
  ok(check >= 0,
    'ensureLocationPermission: primes via the Capacitor checkPermissions API');
  ok(/requestPermissions\(\)/.test(body),
    'ensureLocationPermission: requests via the Capacitor requestPermissions API');

  const oneShot = body.indexOf('navigator.geolocation.getCurrentPosition');
  ok(oneShot >= 0,
    'ensureLocationPermission: keeps the web getCurrentPosition fallback');
  ok(check >= 0 && oneShot > check,
    'ensureLocationPermission: Capacitor branch comes BEFORE the web fallback');
  const ret = body.indexOf('return;', check);
  ok(check >= 0 && ret >= 0 && ret < oneShot,
    'ensureLocationPermission: Capacitor branch returns before the web ' +
    'fallback can fire a coarse one-shot');
  ok(!/enableHighAccuracy\s*:\s*false/.test(body.slice(0, oneShot < 0 ? undefined : oneShot)),
    'ensureLocationPermission: no coarse getCurrentPosition reachable on Capacitor');
}

// --- 2) iOS shim getCurrentPosition must force enableHighAccuracy:true ----
// The iOS shim is the `else if (Geo)` branch ("Non-Android Capacitor").
{
  const body = slice('iOS shim',
    '// Non-Android Capacitor (iOS)',
    '// Memory footprint badge');

  ok(/Geo\.getCurrentPosition\(\{\s*\.\.\.\(opts \|\| \{\}\),\s*enableHighAccuracy:\s*true\s*\}\)/.test(body),
    'iOS shim: getCurrentPosition forces enableHighAccuracy:true over caller ' +
    'opts (a coarse one-shot would set the SHARED CLLocationManager to 3 km ' +
    'accuracy, downgrading the live watch)');

  // --- 3) watch callback drops stale and out-of-order fixes ---------------
  ok(/STALE_FIX_THRESHOLD_MS/.test(body),
    'iOS shim: declares a stale-fix threshold (native plugin ignores maximumAge)');
  ok(/Date\.now\(\)\s*-\s*ts\s*>\s*STALE_FIX_THRESHOLD_MS/.test(body),
    'iOS shim: watch callback drops fixes older than the stale threshold');
  ok(/ts\s*<=\s*entry\.lastTs/.test(body),
    'iOS shim: watch callback drops out-of-order fixes (locations.first ' +
    'reports the OLDEST fix of each CoreLocation batch)');
  ok(/entry\.lastTs\s*=\s*ts/.test(body),
    'iOS shim: watch callback advances the last-seen timestamp');
}

// --- Android BgLoc path keeps its own stale-fix guard ----------------------
{
  const body = slice('Android BgLoc path',
    '// Android-only path: route watchPosition',
    '// Non-Android Capacitor (iOS)');
  ok(/STALE_FIX_THRESHOLD_MS/.test(body),
    'Android BgLoc path: stale-fix guard still present');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
