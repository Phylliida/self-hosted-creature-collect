// Regression test for "zooming out makes POIs spinnable again".
//
// POI cooldowns used to be keyed on `${lng.toFixed(5)},${lat.toFixed(5)}`,
// an exact ~1.1m string match. The `local` vector source is served at
// native maxzoom 14, and the SAME POI quantizes onto a coarser tile grid
// at z12/z13 than at z14 — so its rendered lng/lat shifts a couple of
// meters when you zoom out, the exact key misses, and the POI reads as
// collectable again (free items, gray/pink overlay resets).
//
// The fix makes the cooldown lookup SPATIAL: any stored entry whose
// full-precision (x,y) is within POI_COOLDOWN_RADIUS_M (54m) of the query
// covers it — consistent with collecting already locking that radius.
//
// We extract the real functions from static/index.html (brace-matched,
// same approach as the other index.html unit tests) and drive them with
// a stubbed localStorage + Date.now.
//
// Run: node tests/poi-cooldown-zoom.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf8');

// Brace-matched function extractor (skips comments + strings).
function extractFn(marker) {
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
// Grab a `const NAME = <expr>;` declaration by name.
function extractConst(name) {
  const m = src.match(new RegExp('const ' + name + '\\s*=\\s*([^;]+);'));
  if (!m) throw new Error('const not found: ' + name);
  return 'const ' + name + ' = ' + m[1] + ';';
}

// --- fake localStorage backing the cooldown store ---
let store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

let NOW = 1_000_000_000_000;
const FakeDate = { now: () => NOW };

const ctx = {
  Object, Array, Math, Number, String, JSON,
  localStorage,
  Date: FakeDate,
  console,
};
vm.createContext(ctx);

const code = [
  extractConst('POI_COOLDOWN_MS'),
  extractConst('POI_COOLDOWN_RADIUS_M'),
  extractConst('POI_COOLDOWNS_KEY'),
  'const poiCooldownKey = ' + (src.match(/const poiCooldownKey = ([^;]+);/)[1]) + ';',
  extractFn('function haversineKm('),
  extractFn('function readPoiCooldowns('),
  extractFn('function writePoiCooldowns('),
  extractFn('function poiCooldownEntry('),
  extractFn('function poiCooldownMatches('),
  extractFn('function poiCooldownRemainingMs('),
  extractFn('function poiCooldownStatus('),
  // expose helpers to write entries the way markPoiCollected does
  'function _mark(lng, lat, t, cat){ const m = readPoiCooldowns(); m[poiCooldownKey(lng,lat)] = { t, c: cat||"", x: lng, y: lat }; writePoiCooldowns(m); }',
  'this.poiCooldownRemainingMs = poiCooldownRemainingMs;',
  'this.poiCooldownStatus = poiCooldownStatus;',
  'this._mark = _mark;',
  'this.POI_COOLDOWN_MS = POI_COOLDOWN_MS;',
  'this.POI_COOLDOWN_RADIUS_M = POI_COOLDOWN_RADIUS_M;',
].join('\n');

vm.runInContext(code, ctx);

const { poiCooldownRemainingMs, poiCooldownStatus, _mark, POI_COOLDOWN_MS } = ctx;

// A POI collected at high zoom (z14). Its z13-rendered coordinate is a
// few meters away — enough to change toFixed(5), well under 54m.
const highLng = -73.561234, highLat = 45.501987;
// ~3m north-east shift (a plausible z13 vs z14 quantization jump).
const zoomLng = highLng + 0.00003, zoomLat = highLat + 0.00002;

function reset() { store = {}; NOW = 1_000_000_000_000; }

// 1. Fresh collect at high zoom → both the exact spot and the shifted
//    (zoomed-out) coordinate are on cooldown.
reset();
_mark(highLng, highLat, NOW, 'cafe');
ok(poiCooldownRemainingMs(highLng, highLat) > 0, 'exact spot on cooldown right after collect');
ok(poiCooldownStatus(highLng, highLat) === 'active', 'exact spot status active');
ok(poiCooldownRemainingMs(zoomLng, zoomLat) > 0,
   'REGRESSION: zoomed-out coordinate still on cooldown (was spinnable before fix)');
ok(poiCooldownStatus(zoomLng, zoomLat) === 'active', 'zoomed-out coordinate status active');

// 2. After the 10-min cooldown elapses, both read "ready" (collected
//    before, available now) — not "none".
reset();
_mark(highLng, highLat, NOW, 'cafe');
NOW += POI_COOLDOWN_MS + 1;
ok(poiCooldownRemainingMs(zoomLng, zoomLat) === 0, 'zoomed-out coordinate collectable after cooldown');
ok(poiCooldownStatus(zoomLng, zoomLat) === 'ready', 'zoomed-out coordinate status ready after cooldown');
ok(poiCooldownStatus(highLng, highLat) === 'ready', 'exact coordinate status ready after cooldown');

// 3. A POI far away (well beyond the 54m lock radius) is unaffected.
reset();
_mark(highLng, highLat, NOW, 'cafe');
const farLng = highLng + 0.002, farLat = highLat + 0.002; // ~250m away
ok(poiCooldownRemainingMs(farLng, farLat) === 0, 'far POI is collectable');
ok(poiCooldownStatus(farLng, farLat) === 'none', 'far POI status none');

// 4. Two nearby entries with different timestamps: the location stays
//    locked until the LATER one expires (max remaining wins).
reset();
_mark(highLng, highLat, NOW, 'cafe');       // older
NOW += 5 * 60 * 1000;                        // 5 min later
_mark(highLng + 0.0001, highLat, NOW, 'atm'); // newer, ~8m east
NOW += 6 * 60 * 1000;                         // first entry now expired, second not
ok(poiCooldownRemainingMs(highLng, highLat) > 0,
   'location stays locked while the newer nearby entry is still active');

// 5. Legacy entries (bare-number timestamp, no x/y) still work via the
//    exact-key fallback.
reset();
store['cc.poiCooldowns.v1'] = JSON.stringify({ [`${highLng.toFixed(5)},${highLat.toFixed(5)}`]: NOW });
ok(poiCooldownRemainingMs(highLng, highLat) > 0, 'legacy bare-number entry: exact spot on cooldown');
ok(poiCooldownStatus(highLng, highLat) === 'active', 'legacy bare-number entry: status active');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
