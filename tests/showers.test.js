// Headless tests for the meteor-shower engine (static/extras-almanac.js).
// Run: node tests/showers.test.js

'use strict';
const path = require('path');
require(path.join(__dirname, '..', 'static', 'extras-almanac.js'));
const A = globalThis.Almanac;

let failed = 0, passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL: ' + msg); }
}
const DAY = 86400000;
const utc = (ms) => { const d = new Date(ms); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() }; };
const byName = (n) => A.METEOR_SHOWERS.find((s) => s.name === n);

// ── peak instants land on the published nights ──
function checkPeak(name, year, mo, dlo, dhi) {
  const t = utc(A.showerPeakMs(byName(name), year));
  ok(t.y === year && t.mo === mo && t.d >= dlo && t.d <= dhi,
    name + ' ' + year + ' peaks ' + mo + '/' + dlo + '-' + dhi + ', got ' + t.y + '-' + t.mo + '-' + t.d);
}
checkPeak('Perseids', 2026, 8, 12, 14);
checkPeak('Geminids', 2026, 12, 13, 15);
checkPeak('Quadrantids', 2026, 1, 2, 5);
checkPeak('Lyrids', 2026, 4, 21, 23);
checkPeak('Leonids', 2026, 11, 16, 18);
checkPeak('Perseids', 2027, 8, 12, 14);

// ── solver self-consistency: sun really is at peakLon at the solved instant ──
for (const s of A.METEOR_SHOWERS) {
  const pk = A.showerPeakMs(s, 2026);
  const lon = A.sunEcliptic(A.jde(A.jdFromMs(pk))).lonApp;
  const err = Math.abs(((lon - s.peakLon + 540) % 360) - 180);
  ok(err < 0.01, s.name + ': sun at peak is ' + lon.toFixed(3) + '°, want ' + s.peakLon + '°');
}

// ── activity windows: inside edges hit, outside edges miss (all showers) ──
for (const s of A.METEOR_SHOWERS) {
  const pk = A.showerPeakMs(s, 2026);
  const names = (ms) => A.activeShowers(ms).map((a) => a.shower.name);
  ok(names(pk - s.before * DAY + 3600000).includes(s.name), s.name + ' active just inside window start');
  ok(names(pk + s.after * DAY - 3600000).includes(s.name), s.name + ' active just inside window end');
  ok(!names(pk - (s.before + 2) * DAY).includes(s.name), s.name + ' inactive before window');
  ok(!names(pk + (s.after + 2) * DAY).includes(s.name), s.name + ' inactive after window');
}

// ── Perseids night 2026: Perseids first (closest peak), Aquariids still active ──
{
  const act = A.activeShowers(Date.UTC(2026, 7, 12, 6));
  ok(act.length >= 2, 'several showers active on Perseids night, got ' + act.length);
  ok(act[0].shower.name === 'Perseids', 'Perseids sort first near their peak, got ' + act[0].shower.name);
}

// ── quiet mid-March: nothing active, next up is the Lyrids ──
{
  const ms = Date.UTC(2026, 2, 15);
  ok(A.activeShowers(ms).length === 0, 'no shower active mid-March');
  const nx = A.nextShowerPeak(ms);
  ok(nx.shower.name === 'Lyrids' && utc(nx.peakMs).y === 2026, 'next after mid-March is Lyrids 2026, got ' + nx.shower.name);
}

// ── year wrap: Quadrantids straddle New Year ──
{
  const act = A.activeShowers(Date.UTC(2026, 11, 30));
  ok(act.some((a) => a.shower.name === 'Quadrantids' && utc(a.peakMs).y === 2027),
    'Dec 30 2026 sees the Quadrantids with their Jan 2027 peak');
}

// ── the beautiful cross-check: Aug 12 2026 is a total solar eclipse (new
//    moon), so the 2026 Perseids peak must be essentially moonless ──
{
  const act = A.activeShowers(Date.UTC(2026, 7, 12, 6));
  const per = act.find((a) => a.shower.name === 'Perseids');
  ok(per.moonIllum < 0.05, '2026 Perseids peak is moonless (eclipse day!), illum=' + per.moonIllum.toFixed(3));
}
// ── and the 2024 Perseids had a ~50% first-quarter moon (published) ──
{
  const pk = A.showerPeakMs(byName('Perseids'), 2024);
  const illum = A.moonPhase(A.jde(A.jdFromMs(pk))).illum;
  ok(illum > 0.35 && illum < 0.65, '2024 Perseids moon ~half lit, got ' + illum.toFixed(2));
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
