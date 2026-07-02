// Headless tests for the Sky Map CORE (static/extras-skymap.js).
// Run: node tests/skymap.test.js
// The extras files bail out before any DOM work under Node, so loading them
// just populates globalThis.SkyMapCore / globalThis.Almanac.

'use strict';
const path = require('path');
require(path.join(__dirname, '..', 'static', 'extras-almanac.js'));
require(path.join(__dirname, '..', 'static', 'extras-skymap.js'));

const C = globalThis.SkyMapCore;
const A = globalThis.Almanac;

let failed = 0, passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL: ' + msg); }
}
function near(a, b, tol, msg) {
  ok(Math.abs(a - b) <= tol, msg + ' (got ' + a + ', want ' + b + ' ±' + tol + ')');
}

// ── catalog decode ──
const stars = C.decodeStars();
const lines = C.decodeLines();
ok(stars.length === 1627, 'star count is 1627, got ' + stars.length);
ok(lines.length === 150, 'polyline count is 150, got ' + lines.length);
ok(C.CONST_LABELS.length === 89, 'label count is 89, got ' + C.CONST_LABELS.length);
ok(stars[0].name === 'Sirius', 'brightest star is Sirius, got ' + stars[0].name);
near(stars[0].mag, -1.4, 0.15, 'Sirius magnitude');

// published J2000 positions (rounded catalog: ±0.05° encoding + source rounding)
function findStar(name) { return stars.find((s) => s.name === name); }
const sirius = findStar('Sirius'), vega = findStar('Vega'), polaris = findStar('Polaris');
ok(!!vega && !!polaris, 'Vega and Polaris present in catalog');
near(sirius.ra, 101.29, 0.1, 'Sirius RA');
near(sirius.dec, -16.72, 0.1, 'Sirius dec');
near(vega.ra, 279.23, 0.1, 'Vega RA');
near(vega.dec, 38.78, 0.1, 'Vega dec');
near(polaris.ra, 37.95, 0.3, 'Polaris RA');
near(polaris.dec, 89.26, 0.1, 'Polaris dec');

// every decoded star is in range
ok(stars.every((s) => s.ra >= 0 && s.ra < 360 && s.dec >= -90 && s.dec <= 90 && s.mag <= 5.01),
  'all stars decode into valid ranges');
ok(lines.every((p) => p.every((q) => q.ra >= 0 && q.ra < 360 && q.dec >= -90 && q.dec <= 90)),
  'all line points decode into valid ranges');

// ── sidereal time matches the Almanac engine exactly ──
for (const ms of [Date.UTC(2026, 0, 1), Date.UTC(2026, 6, 2, 15, 30), Date.UTC(1999, 11, 31, 23, 59)]) {
  const jd = ms / 86400000 + 2440587.5;
  near(C.gmst(jd), A.gmst(jd), 1e-9, 'gmst matches Almanac at jd ' + jd);
}

// ── altAz reproduces Almanac's sun alt/az when fed the same ra/dec ──
{
  const ms = Date.UTC(2026, 6, 2, 18, 0), lat = 45.5, lon = -73.6;
  const jdUT = ms / 86400000 + 2440587.5;
  const eq = A.sunEquatorial(A.jde(jdUT));
  const mine = C.altAz(eq.ra, eq.dec, ms, lat, lon);
  const ref = A.sunAltAz(ms, lat, lon);
  near(mine.alt, ref.alt, 1e-6, 'altAz altitude matches sunAltAz');
  near(mine.az, ref.az, 1e-6, 'altAz azimuth matches sunAltAz');
}

// ── Polaris altitude ≈ observer latitude (the navigator's rule) ──
for (const [lat, lon] of [[45.5, -73.6], [51.5, 0], [10, 100]]) {
  const aa = C.altAz(polaris.ra, polaris.dec, Date.UTC(2026, 3, 15, 3, 0), lat, lon);
  near(aa.alt, lat, 1.0, 'Polaris altitude ~= latitude ' + lat);
  ok(aa.az < 2 || aa.az > 358, 'Polaris azimuth ~= north at lat ' + lat + ' (got ' + aa.az + ')');
}

// ── Sirius culmination from Greenwich: alt_max = 90 − |lat − dec| ──
{
  const lat = 51.4769, lon = 0;
  let maxAlt = -90;
  const base = Date.UTC(2026, 0, 1);
  for (let m = 0; m < 1440; m += 2) {
    const aa = C.altAz(sirius.ra, sirius.dec, base + m * 60000, lat, lon);
    if (aa.alt > maxAlt) maxAlt = aa.alt;
  }
  near(maxAlt, 90 - Math.abs(lat - sirius.dec), 0.1, 'Sirius culmination altitude from Greenwich');
}

// ── projection geometry: zenith centre, horizon radius R, N up, E left ──
{
  const R = 100;
  const z = C.project(90, 123, R);
  near(Math.hypot(z.x, z.y), 0, 1e-9, 'zenith projects to centre');
  const n = C.project(0, 0, R);
  near(n.x, 0, 1e-9, 'north on horizon: x'); near(n.y, -R, 1e-9, 'north on horizon: y (up)');
  const e = C.project(0, 90, R);
  near(e.x, -R, 1e-9, 'east on horizon: x (LEFT — chart is mirrored)'); near(e.y, 0, 1e-9, 'east on horizon: y');
  const s = C.project(0, 180, R);
  near(s.x, 0, 1e-9, 'south x'); near(s.y, R, 1e-9, 'south y (down)');
  const mid = C.project(45, 0, R);
  near(Math.hypot(mid.x, mid.y), R * Math.tan(22.5 * Math.PI / 180), 1e-9, 'stereographic radius at alt 45');
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
