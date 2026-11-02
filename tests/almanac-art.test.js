// Guards the Sun / Astronomy hero art (global.AlmanacArt in
// static/extras-almanac.js) and how those tools are hosted:
//
//   (1) Sun path: sunrise / sunset / solar noon found from the drawn curve
//       agree with the almanac's own rise/set engine; midnight sun and polar
//       night have no crossings.
//   (2) Night sky: only planets above the horizon and in front of you are
//       drawn; the view faces south up north and north down south.
//   (3) Every SVG is self-contained (all url(#id) resolve, ids unique per
//       drawing, no NaN/undefined).
//   (4) Wiring: ExtrasAlmanac.mount for Stats, tool-root CSS (not the Extras
//       view ids), heroes rendered from the tools' compute().
//
// Run: node tests/almanac-art.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }
function near(a, b, tol, msg) { ok(Number.isFinite(a) && Math.abs(a - b) <= tol, msg + ' (got ' + a + ', want ' + b + ' ±' + tol + ')'); }

const root = path.join(__dirname, '..');
require(path.join(root, 'static', 'extras-almanac.js'));
const A = globalThis.Almanac, ART = globalThis.AlmanacArt;
ok(!!ART && typeof ART.sunPath === 'function' && typeof ART.nightSky === 'function', 'AlmanacArt exported under Node');

const fmt = (ms) => new Date(ms).toISOString().slice(11, 16);
const hourLabel = (h) => h + 'h';
const seen = new Set();
function checkSvg(svg, label) {
  ok(/^<svg[\s\S]*<\/svg>$/.test(svg), label + ': one svg');
  ok(!/undefined|NaN|null/.test(svg), label + ': no undefined/NaN/null');
  const ids = Array.from(svg.matchAll(/ id="([^"]+)"/g), (m) => m[1]);
  const set = new Set(ids);
  ok(set.size === ids.length, label + ': ids unique within the drawing');
  ok(Array.from(svg.matchAll(/url\(#([^)]+)\)/g), (m) => m[1]).every((r) => set.has(r)), label + ': every url(#id) resolves');
  for (const id of set) { ok(!seen.has(id), label + ': id ' + id + ' not reused by another drawing'); seen.add(id); }
}

// ── 1) sun path ──
const MTL = { lat: 45.5, lon: -73.57 };
const day0 = Date.parse('2026-11-02T05:00:00Z');  // local midnight, EST
let r = ART.sunPath(Object.assign({ day0, nowMs: Date.parse('2026-11-02T19:00:00Z'), fmt, hourLabel, motion: true }, MTL));
checkSvg(r.svg, 'sunPath Montréal');
const ev = A.sunEventsUTC(2026, 11, 2, MTL.lat, MTL.lon, -0.833);
const base = Date.UTC(2026, 10, 2);
near(r.rise, base + ev.rise * 60000, 2 * 60000, 'sunPath: sunrise agrees with the rise/set engine');
near(r.set, base + ev.set * 60000, 2 * 60000, 'sunPath: sunset agrees with the rise/set engine');
near(r.noon, base + ev.noon * 60000, 2 * 60000, 'sunPath: solar noon agrees');
near(r.noonAlt, 90 - 45.5 - 14.9, 1.5, 'sunPath: noon altitude ≈ 90° − lat + dec');
ok(/class="alm-spin"/.test(r.svg) && /↑ /.test(r.svg) && /↓ /.test(r.svg), 'sunPath: spinning sun + rise/set labels');
r = ART.sunPath(Object.assign({ day0, nowMs: Date.parse('2026-11-02T10:00:00Z'), fmt, hourLabel, motion: false }, MTL));
ok(!/alm-spin|alm-twinkle|alm-anim/.test(r.svg), 'sunPath: still when motion is off');
ok(!/class="alm-spin"/.test(r.svg), 'sunPath: a set sun has no rays');
const tromso = { lat: 69.65, lon: 18.96 };
r = ART.sunPath(Object.assign({ day0: Date.parse('2026-06-20T22:00:00Z'), nowMs: null, fmt, hourLabel }, tromso));
ok(r.rise == null && r.set == null && r.noonAlt > 0, 'sunPath: midnight sun has no rise or set');
checkSvg(r.svg, 'sunPath midnight sun');
r = ART.sunPath(Object.assign({ day0: Date.parse('2026-12-20T23:00:00Z'), nowMs: null, fmt, hourLabel }, tromso));
ok(r.rise == null && r.set == null && r.noonAlt < -0.833, 'sunPath: polar night has no rise or set');
ok(ART.skyColor(-30) !== ART.skyColor(30) && /^#[0-9a-f]{6}$/.test(ART.skyColor(3)), 'skyColor: night and day differ');

// ── 2) night sky ──
const skyMs = Date.parse('2026-11-02T23:30:00Z');
const ph = A.moonPhase(A.jde(A.jdFromMs(skyMs)));
let n = ART.nightSky(Object.assign({ skyMs, cycle: ph.cycle, illum: ph.illum, motion: true }, MTL));
checkSvg(n.svg, 'nightSky Montréal');
ok(n.planets.length > 0 && n.planets.every((p) => p.alt >= 1), 'nightSky: only planets above the horizon');
ok(n.planets.every((p) => Math.abs(A.norm180(p.az - 180)) <= 115), 'nightSky: up north it faces south');
for (const p of A.PLANET_ORDER) {
  const pa = A.planetAltAz(p, skyMs, MTL.lat, MTL.lon);
  const want = pa.alt >= 1 && Math.abs(A.norm180(pa.az - 180)) <= 115;
  ok(n.planets.some((q) => q.name === p) === want, 'nightSky: ' + p + (want ? ' drawn' : ' left out'));
}
ok(/>S</.test(n.svg) && /alm-svg-label/.test(n.svg), 'nightSky: compass + planet labels');
const syd = { lat: -33.87, lon: 151.21 };
n = ART.nightSky(Object.assign({ skyMs: Date.parse('2026-11-02T10:00:00Z'), cycle: 0.3, illum: 0.65 }, syd));
checkSvg(n.svg, 'nightSky Sydney');
ok(/>N</.test(n.svg) && !/>S</.test(n.svg), 'nightSky: down south it faces north');
ok(/scale\(-1 1\)/.test(n.svg), 'nightSky: the southern moon is mirrored');
ok(n.planets.every((p) => Math.abs(A.norm180(p.az - 0)) <= 115), 'nightSky: southern planets are in the northern sky');
// phases: the face appears once there's enough moon to wear one
const fullSky = ART.nightSky(Object.assign({ skyMs, cycle: 0.5, illum: 1 }, MTL)).svg;
const newSky = ART.nightSky(Object.assign({ skyMs, cycle: 0.02, illum: 0.004 }, MTL)).svg;
ok(/#7a5a26/.test(fullSky) && !/#7a5a26/.test(newSky), 'nightSky: full moon has a face, a new moon does not');

// ── 4) wiring ──
const src = fs.readFileSync(path.join(root, 'static', 'extras-almanac.js'), 'utf8');
ok(/global\.ExtrasAlmanac = \{\s*mount\(kind, container\)/.test(src), 'extras-almanac.js exposes ExtrasAlmanac.mount');
ok(/\.alm-tool input \{/.test(src) && !/#extras_sun input/.test(src), 'almanac CSS is scoped to the tool root, not the Extras view ids');
ok(/view\.classList\.add\('alm-tool'\);[\s\S]{0,80}alm-hero/.test(src), 'tools carry the root class and a hero');
ok(/renderSunHero\(hero, dt, lat, lon, now\)/.test(src) && /renderSkyHero\(hero, dt, lat, lon, now, ph, pn\)/.test(src), 'heroes render from compute()');
ok(!/function moonSvg/.test(src), 'the old flat moon picture is gone');
const cssStart = src.indexOf('style.textContent = `') + 'style.textContent = `'.length;
const css = src.slice(cssStart, src.indexOf('\n  `;', cssStart));
ok(css.length > 1000 && !/`/.test(css), 'no backticks inside the CSS template');
ok(/prefers-reduced-motion: reduce/.test(css), 'motion stops for reduced motion');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
