// Pokéstop "Collect items" button must stay live while the card is
// open: opening a ready stop in range, then walking away without
// tapping, has to flip the label to "Too far · N m" (it used to stop
// polling once ready and leave a stale, silently-failing button).
//
// Slices syncPoiCollectButton/startPoiCollectCountdown out of
// index.html and drives them against stubs with a fake setInterval.
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const html = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf8');
const start = html.indexOf('  let _poiCooldownTimer = null;');
const end = html.indexOf('  function renderPoiCard(poi)');
if (start < 0 || end < 0) throw new Error('could not slice collect-button code out of index.html');
const src = html.slice(start, end);

const btn = { disabled: false, textContent: '', set innerHTML(v) { this.textContent = v; } };
const card = { classList: { contains: (c) => c === 'show' && cardShown } };
let cardShown = true;
const stop = { lng: -73.6, lat: 45.5 };
let pos = { lat: 45.5, lng: -73.6 };          // standing on the stop
let cooldownMs = 0;
let tick = null;

const env = {
  document: { getElementById: (id) => (id === 'poiCard' ? card : id === 'poiCardCollect' ? btn : null) },
  localStorage: { getItem: () => JSON.stringify(stop) },
  window: {},
  SELECTED_KEY: 'sel',
  POI_COLLECT_MAX_DISTANCE_M: 60,
  applyCooldownStyleToSelectedMarker: () => {},
  haversineKm: (a, b, c, d) => {
    const R = 6371, r = Math.PI / 180;
    const dLat = (c - a) * r, dLng = (d - b) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  },
  poiCooldownRemainingMs: () => cooldownMs,
  setInterval: (fn) => { tick = fn; return 1; },
  clearInterval: () => { tick = null; },
};
env.lastKnownPos = null;
const fns = new Function(...Object.keys(env), 'getPos',
  src.replace(/lastKnownPos/g, 'getPos()')
  + '\nreturn { startPoiCollectCountdown, stopPoiCollectCountdown };')(
  ...Object.values(env), () => pos);

// Open a ready stop while in range.
fns.startPoiCollectCountdown();
ok(btn.textContent === 'Collect items' && !btn.disabled, 'ready in range → Collect items');
ok(tick != null, 'poll keeps running while ready');

// Walk ~200 m away without tapping.
pos = { lat: 45.5018, lng: -73.6 };
tick && tick();
ok(btn.disabled, 'out of range → disabled');
ok(/^Too far · \d+ m$/.test(btn.textContent), 'out of range → Too far label, got ' + btn.textContent);

// Walk back.
pos = { lat: 45.5, lng: -73.6 };
tick && tick();
ok(btn.textContent === 'Collect items' && !btn.disabled, 'back in range → Collect items again');

// Cooldown still counts down as before.
cooldownMs = 65000;
tick && tick();
ok(btn.textContent === 'Available in 1:05', 'cooldown label, got ' + btn.textContent);

// Closing the card stops the poll.
cardShown = false;
tick && tick();
ok(tick == null, 'hidden card stops the poll');

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
