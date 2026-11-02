// Guards the Extras "Weather" tool (static/extras-weather.js):
//
//   (1) Routing: which weather service covers a point (Canada -> ECCC,
//       US -> NWS, elsewhere -> Open-Meteo), incl. the tricky border towns.
//   (2) Code tables: every source's condition codes land on a condition
//       that has art; the text fallback catches the rest.
//   (3) Normalisers against recorded API responses (tests/fixtures/weather).
//   (4) WeatherCore.load end to end with a fake fetch: the exact requests
//       per source, coordinate rounding, fallback to Open-Meteo, and NO
//       retry storm when offline.
//   (5) Art: every condition x day/night renders a self-contained SVG whose
//       gradient references all resolve, with unique ids per SVG.
//   (6) Zero-network invariants on the file: fetch only inside the one JSON
//       helper, CORE.load called only from the Load button handler, no
//       timers that could load on their own.
//   (7) Wiring: deferred-script list, refresh cache-delete list, run.py
//       version tracking, build-capacitor stamp lists.
//
// Run: node tests/weather.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }
function eq(a, b, msg) { ok(Object.is(a, b), msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function near(a, b, tol, msg) { ok(Number.isFinite(a) && Math.abs(a - b) <= tol, msg + ' (got ' + a + ', want ' + b + ' ±' + tol + ')'); }

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const fixture = (n) => JSON.parse(read('tests', 'fixtures', 'weather', n));

require(path.join(root, 'static', 'extras-weather.js'));
const W = globalThis.WeatherCore;
ok(!!W, 'WeatherCore exported under Node');

(async function main() {
  // ── 1) routing ────────────────────────────────────────────────────────
  const ROUTES = [
    ['Montréal', 45.50, -73.57, 'eccc'], ['Toronto', 43.65, -79.38, 'eccc'],
    ['Vancouver', 49.28, -123.12, 'eccc'], ['Victoria', 48.43, -123.37, 'eccc'],
    ['Windsor ON', 42.28, -82.98, 'eccc'], ['Kingston ON', 44.23, -76.48, 'eccc'],
    ['Thunder Bay', 48.38, -89.25, 'eccc'], ['Halifax', 44.65, -63.57, 'eccc'],
    ["St. John's", 47.56, -52.71, 'eccc'], ['Iqaluit', 63.75, -68.52, 'eccc'],
    ['Whitehorse', 60.72, -135.05, 'eccc'], ['Atlin BC', 59.58, -133.70, 'eccc'],
    ['Prince Rupert', 54.31, -130.32, 'eccc'], ['Edmundston', 47.37, -68.32, 'eccc'],
    ['Sherbrooke', 45.40, -71.89, 'eccc'], ['Yellowknife', 62.45, -114.37, 'eccc'],
    ['Burlington VT', 44.48, -73.21, 'nws'], ['New York', 40.71, -74.00, 'nws'],
    ['Seattle', 47.61, -122.33, 'nws'], ['Port Angeles', 48.12, -123.43, 'nws'],
    ['Detroit', 42.38, -83.10, 'nws'], ['Buffalo', 42.89, -78.85, 'nws'],
    ['Watertown NY', 43.97, -75.91, 'nws'], ['Massena NY', 44.93, -74.89, 'nws'],
    ['Bangor ME', 44.80, -68.77, 'nws'], ['Duluth', 46.79, -92.10, 'nws'],
    ['Anchorage', 61.22, -149.90, 'nws'], ['Juneau', 58.30, -134.42, 'nws'],
    ['Skagway', 59.45, -135.31, 'nws'], ['Ketchikan', 55.34, -131.65, 'nws'],
    ['Honolulu', 21.31, -157.86, 'nws'], ['San Juan PR', 18.47, -66.11, 'nws'],
    ['Key West', 24.56, -81.78, 'nws'], ['El Paso', 31.76, -106.49, 'nws'],
    ['Paris', 48.86, 2.35, 'openmeteo'], ['Tokyo', 35.68, 139.69, 'openmeteo'],
    ['Tijuana', 32.50, -117.02, 'openmeteo'], ['Ciudad Juárez', 31.69, -106.42, 'openmeteo'],
    ['Mexico City', 19.43, -99.13, 'openmeteo'], ['Nuuk', 64.18, -51.72, 'openmeteo'],
    ['Pituffik', 76.53, -68.70, 'openmeteo'], ['Nassau', 25.05, -77.35, 'openmeteo'],
    ['Havana', 23.11, -82.37, 'openmeteo'], ['Sydney', -33.87, 151.21, 'openmeteo'],
  ];
  for (const [name, lat, lon, want] of ROUTES) eq(W.routeFor(lat, lon), want, 'route ' + name);

  const rl = W.roundLoc({ lat: 45.50876, lon: -73.56734 });
  ok(rl.lat === 45.51 && rl.lon === -73.57, 'roundLoc: 2 decimals (~1 km)');
  eq(W.roundLoc({ lat: 0, lon: 190 }).lon, -170, 'roundLoc wraps longitude');

  // ── 2) code tables ────────────────────────────────────────────────────
  const CONDS = Object.keys(W.CONDS);
  for (const c of Object.values(W.ECCC_CODES)) ok(CONDS.includes(c), 'ECCC code maps to known cond ' + c);
  for (const c of Object.values(W.NWS_CODES)) ok(CONDS.includes(c), 'NWS code maps to known cond ' + c);
  for (const [k, v] of Object.entries(W.WMO)) ok(CONDS.includes(v[0]) && v[1], 'WMO ' + k + ' maps + has text');
  for (const c of CONDS) ok(Number.isFinite(W.RANK[c]), 'RANK covers ' + c);
  eq(W.ecccCond(2, ''), 'partly', 'ECCC 02 = mix of sun and cloud');
  eq(W.ecccCond(16, ''), 'snow', 'ECCC 16 = light snow');
  eq(W.ecccCond(29, 'Snow at times heavy'), 'heavy-snow', 'ECCC unknown code falls back to the text');
  eq(W.nwsCond('https://api.weather.gov/icons/land/day/bkn/rain_showers,40?size=medium', 'Mostly Cloudy then Chance Rain Showers'),
    'rain', 'NWS two-part icon takes the more significant half');
  eq(W.nwsCond('https://api.weather.gov/icons/land/night/sct?size=small', 'Partly Cloudy'), 'partly', 'NWS sct');
  eq(W.nwsCond('https://api.weather.gov/icons/land/day/rain?size=small', 'Heavy Rain'), 'heavy-rain', 'NWS text can sharpen the icon');
  eq(W.nwsCond('https://api.weather.gov/icons/land/day/tsra_hi,30/tsra?size=small', ''), 'thunder', 'NWS tsra');
  eq(W.wmoCond(95), 'thunder', 'WMO 95');
  eq(W.wmoText(0, true), 'Sunny', 'WMO 0 by day reads Sunny');
  eq(W.wmoText(0, false), 'Clear', 'WMO 0 by night reads Clear');
  const TEXTS = [
    ['Chance of flurries or rain showers', 'mix'], ['Periods of light snow', 'flurries'],
    ['Rain at times heavy', 'heavy-rain'], ['Freezing drizzle', 'freezing-rain'],
    ['A mix of sun and cloud', 'partly'], ['Mainly cloudy', 'mostly'], ['Overcast', 'cloudy'],
    ['Patchy Fog', 'fog'], ['Areas of Smoke', 'smoke'], ['Blowing snow', 'heavy-snow'],
    ['Slight Chance Showers And Thunderstorms', 'thunder'], ['Sunny', 'clear'], ['Mostly Clear', 'few'],
    ['Breezy', 'windy'], ['', null],
  ];
  for (const [t, want] of TEXTS) eq(W.textCond(t), want, 'textCond "' + t + '"');

  // ── 3) normalisers ────────────────────────────────────────────────────
  const q = { lat: 45.5, lon: -73.57 };
  const ec = W.fromEccc(fixture('eccc-montreal.json'), q, 3.2);
  eq(ec.src, 'eccc', 'ECCC: src');
  eq(ec.place, 'Montréal', 'ECCC: place name');
  eq(ec.tz, 'America/Toronto', 'ECCC: Quebec -> America/Toronto');
  ok(ec.now && Number.isFinite(ec.now.tempC) && ec.now.observed, 'ECCC: observed current conditions');
  ok(ec.now.cond && CONDS.includes(ec.now.cond), 'ECCC: current cond mapped');
  ok(Number.isFinite(ec.now.hPa) && ec.now.hPa > 900 && ec.now.hPa < 1100, 'ECCC: kPa -> hPa');
  eq(ec.hours.length, 8, 'ECCC: hourly rows (fixture keeps 8)');
  ok(ec.hours.every((h) => Number.isFinite(h.t) && Number.isFinite(h.tempC) && CONDS.includes(h.cond)), 'ECCC: hourly rows complete');
  ok(ec.hours.every((h, i) => i === 0 || h.t - ec.hours[i - 1].t === 3600000), 'ECCC: hourly rows an hour apart');
  ok(ec.days.length >= 3, 'ECCC: day/night periods merged into days');
  ok(ec.days.every((d, i) => i === 0 || d.key > ec.days[i - 1].key), 'ECCC: day keys strictly increasing');
  const first = ec.days[0];
  ok(first.onlyNight && first.loC != null && first.hiC == null, 'ECCC: issued in the evening -> first day is "Tonight" only');
  ok(ec.days[1].hiC != null && ec.days[1].loC != null && ec.days[1].text && ec.days[1].nightText, 'ECCC: full day has high, low, day + night text');
  eq(W.weekdayOf(ec.days[1].key), 1, 'ECCC: "Monday" lands on a Monday');
  eq(ec.alerts.length, 0, 'ECCC: no warnings in the Montréal fixture');

  const ew = W.fromEccc(fixture('eccc-warning.json'), q, 10);
  ok(ew.alerts.length >= 1, 'ECCC: warnings parsed');
  ok(/FOG/.test(ew.alerts[0].title) && ew.alerts[0].level === 'yellow', 'ECCC: yellow fog advisory');
  ok(Number.isFinite(ew.alerts[0].expires), 'ECCC: alert expiry parsed');

  const nq = { lat: 44.48, lon: -73.21 };
  const nw = W.fromNws(fixture('nws-points.json'), fixture('nws-forecast.json'), fixture('nws-hourly.json'), fixture('nws-alerts.json'), nq);
  eq(nw.place, 'Burlington, VT', 'NWS: place');
  eq(nw.tz, 'America/New_York', 'NWS: zone');
  eq(nw.hours.length, 8, 'NWS: hourly rows');
  near(nw.hours[0].tempC, (49 - 32) * 5 / 9, 1e-9, 'NWS: °F -> °C');
  near(nw.hours[0].windKph, 8 * 1.609344, 1e-9, 'NWS: mph -> km/h');
  ok(nw.now && !nw.now.observed && nw.now.tempC === nw.hours[0].tempC, 'NWS: "now" is the current forecast hour');
  ok(Number.isFinite(nw.now.feelsC), 'NWS: feels-like computed');
  ok(nw.days.length >= 3 && nw.days[0].onlyNight, 'NWS: evening issue starts with Tonight');
  ok(nw.days[1].hiC != null && nw.days[1].loC != null, 'NWS: day has high + low');
  eq(nw.alerts.length, 1, 'NWS: alert parsed');
  eq(nw.alerts[0].level, 'yellow', 'NWS: Moderate -> yellow');
  ok(/WHAT/.test(nw.alerts[0].text), 'NWS: alert text kept');

  const oq = { lat: 48.86, lon: 2.35 };
  const om = W.fromOpenMeteo(fixture('openmeteo-paris.json'), oq);
  eq(om.tz, 'Europe/Paris', 'Open-Meteo: zone');
  eq(om.hours.length, 24, 'Open-Meteo: 24 hours');
  eq(om.days.length, 7, 'Open-Meteo: 7 days');
  ok(om.days.every((d, i) => i === 0 || d.key === W.addDays(om.days[i - 1].key, 1)), 'Open-Meteo: consecutive local days');
  ok(om.now && Number.isFinite(om.now.feelsC) && om.now.windDir, 'Open-Meteo: apparent temp + compass wind');
  ok(om.days.every((d) => CONDS.includes(d.cond) && d.hiC >= d.loC), 'Open-Meteo: days complete');

  // ── sun + feels-like ──
  // Montréal, 2026-06-21: sunrise ~05:05, sunset ~20:46 EDT.
  const st = W.sunTimes(Date.parse('2026-06-21T16:00:00Z'), 45.5, -73.57, 'America/Toronto');
  near(st.rise, Date.parse('2026-06-21T09:05:00Z'), 4 * 60000, 'sunTimes: Montréal midsummer sunrise');
  near(st.set, Date.parse('2026-06-22T00:46:00Z'), 4 * 60000, 'sunTimes: Montréal midsummer sunset');
  ok(W.isDay(Date.parse('2026-06-21T16:00:00Z'), 45.5, -73.57), 'isDay at noon');
  ok(!W.isDay(Date.parse('2026-06-21T05:00:00Z'), 45.5, -73.57), 'not isDay at 1 am');
  const polar = W.sunTimes(Date.parse('2026-06-21T12:00:00Z'), 78.2, 15.6, 'Arctic/Longyearbyen');
  ok(polar.rise == null && polar.set == null && polar.up, 'sunTimes: midnight sun has no rise/set');
  near(W.feelsLike(-10, 70, 30), -19.5, 0.6, 'wind chill -10 °C @ 30 km/h');
  near(W.feelsLike(32, 60, 5), 37, 1.5, 'heat index 32 °C @ 60%');
  eq(W.feelsLike(18, 50, 10), 18, 'mild air feels like itself');

  // ── 4) load end-to-end with a fake fetch ─────────────────────────────
  function fakeFetch(routes) {
    const calls = [];
    const f = async (url, init) => {
      calls.push({ url, init });
      for (const [re, body] of routes) {
        if (re.test(url)) {
          if (body instanceof Error) throw body;
          if (typeof body === 'number') return { ok: false, status: body, json: async () => ({}) };
          return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
        }
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    f.calls = calls;
    return f;
  }

  let ff = fakeFetch([
    [/citypageweather-realtime\/items\?/, fixture('eccc-ids.json')],
    [/citypageweather-realtime\/items\/qc-147\?/, fixture('eccc-montreal.json')],
  ]);
  let m = await W.load({ lat: 45.50876, lon: -73.56734 }, { fetch: ff, now: 1 });
  eq(m.src, 'eccc', 'load: Montréal -> ECCC');
  eq(m.fetchedAt, 1, 'load: fetchedAt stamped');
  eq(ff.calls.length, 2, 'load: ECCC = id search + one city');
  ok(/bbox=-74\.14,45\.11,-73\.00,45\.91/.test(ff.calls[0].url), 'load: bbox built from the ROUNDED point (' + ff.calls[0].url + ')');
  ok(/items\/qc-147\?f=json$/.test(ff.calls[1].url), 'load: nearest place qc-147 (Montréal) fetched');
  ok(m.distKm < 5, 'load: distance to the forecast place kept');
  ok(ff.calls.every((c) => c.init && c.init.credentials === 'omit' && c.init.referrerPolicy === 'no-referrer' && c.init.cache === 'no-store'),
    'load: no credentials, no referrer, no HTTP cache');
  ok(ff.calls.every((c) => Object.keys(c.init.headers || {}).every((h) => /^accept$/i.test(h))),
    'load: only CORS-safelisted headers (no preflight)');

  ff = fakeFetch([
    [/api\.weather\.gov\/points\/44\.48,-73\.21$/, fixture('nws-points.json')],
    [/gridpoints\/BTV\/89,57\/forecast$/, fixture('nws-forecast.json')],
    [/gridpoints\/BTV\/89,57\/forecast\/hourly$/, fixture('nws-hourly.json')],
    [/alerts\/active\?point=44\.48,-73\.21$/, fixture('nws-alerts.json')],
  ]);
  m = await W.load({ lat: 44.4812, lon: -73.2129 }, { fetch: ff });
  eq(m.src, 'nws', 'load: Burlington -> NWS');
  eq(ff.calls.length, 4, 'load: NWS = points + forecast + hourly + alerts');
  ok(m.alerts.length === 1 && m.hours.length === 8, 'load: NWS hourly + alerts merged');

  ff = fakeFetch([
    [/api\.weather\.gov\/points\//, fixture('nws-points.json')],
    [/gridpoints\/BTV\/89,57\/forecast$/, fixture('nws-forecast.json')],
    [/gridpoints\/BTV\/89,57\/forecast\/hourly$/, 500],
    [/alerts\/active/, new TypeError('Failed to fetch')],
  ]);
  m = await W.load({ lat: 44.48, lon: -73.21 }, { fetch: ff });
  ok(m.src === 'nws' && m.hours.length === 0 && m.days.length >= 3, 'load: NWS hourly/alerts failures are non-fatal');

  // A hostile/odd points response must not send us to another host.
  ff = fakeFetch([
    [/api\.weather\.gov\/points\//, { properties: { forecast: 'https://evil.example/x' } }],
    [/open-meteo/, fixture('openmeteo-paris.json')],
  ]);
  m = await W.load({ lat: 44.48, lon: -73.21 }, { fetch: ff });
  ok(!ff.calls.some((c) => /evil/.test(c.url)), 'load: NWS follow-up URLs must be api.weather.gov');
  eq(m.src, 'openmeteo', 'load: bad NWS answer falls back to Open-Meteo');
  eq(m.fellBackFrom, 'nws', 'load: fallback recorded');

  ff = fakeFetch([[/open-meteo/, fixture('openmeteo-paris.json')]]);
  m = await W.load({ lat: 48.8566, lon: 2.3522 }, { fetch: ff });
  eq(m.src, 'openmeteo', 'load: Paris -> Open-Meteo');
  eq(ff.calls.length, 1, 'load: Open-Meteo = one request');
  ok(/latitude=48\.86&longitude=2\.35&/.test(ff.calls[0].url), 'load: Open-Meteo gets the rounded point');
  ok(!('fellBackFrom' in m), 'load: no fallback flag on a primary success');

  // ECCC finds nothing nearby -> widen 3x, then Open-Meteo.
  ff = fakeFetch([
    [/citypageweather-realtime\/items\?/, { type: 'FeatureCollection', features: [] }],
    [/open-meteo/, fixture('openmeteo-paris.json')],
  ]);
  m = await W.load({ lat: 45.5, lon: -73.57 }, { fetch: ff });
  eq(ff.calls.filter((c) => /citypage/.test(c.url)).length, 3, 'load: ECCC search widens three times');
  eq(m.fellBackFrom, 'eccc', 'load: empty ECCC search falls back to Open-Meteo');

  // Offline: exactly one attempt, no fallback hammering.
  ff = fakeFetch([[/./, new TypeError('Failed to fetch')]]);
  let err = null;
  try { await W.load({ lat: 45.5, lon: -73.57 }, { fetch: ff }); } catch (e) { err = e; }
  ok(err && err.kind === 'offline', 'load: network failure -> kind offline');
  eq(ff.calls.length, 1, 'load: offline stops after the first request');

  // The service worker turns failures into an empty 504.
  ff = fakeFetch([[/./, 504]]);
  err = null;
  try { await W.load({ lat: 48.86, lon: 2.35 }, { fetch: ff }); } catch (e) { err = e; }
  ok(err && err.kind === 'offline', 'load: SW 504 reads as offline');

  ff = fakeFetch([[/./, 503]]);
  err = null;
  try { await W.load({ lat: 48.86, lon: 2.35 }, { fetch: ff }); } catch (e) { err = e; }
  ok(err && err.kind === 'http' && err.status === 503, 'load: HTTP errors carry the status');

  // Timeout via AbortController.
  const hang = (url, init) => new Promise((_, rej) => {
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
  });
  err = null;
  try { await W.load({ lat: 48.86, lon: 2.35 }, { fetch: hang, timeoutMs: 30 }); } catch (e) { err = e; }
  ok(err && err.kind === 'timeout', 'load: slow service -> kind timeout');

  // ── 5) art ────────────────────────────────────────────────────────────
  function checkSvg(svg, label) {
    ok(/^<svg[\s\S]*<\/svg>$/.test(svg), label + ': one svg element');
    ok(!/undefined|NaN|null/.test(svg), label + ': no undefined/NaN/null in markup');
    const ids = new Set(Array.from(svg.matchAll(/ id="([^"]+)"/g), (x) => x[1]));
    const refs = Array.from(svg.matchAll(/url\(#([^)]+)\)/g), (x) => x[1]);
    ok(refs.every((r) => ids.has(r)), label + ': every url(#id) resolves inside the svg');
    return ids;
  }
  const seen = new Set();
  for (const c of CONDS) {
    for (const day of [true, false]) {
      for (const motion of [true, false]) {
        const svg = W.scene(c, day, { at: Date.parse('2026-11-01T15:00:00Z'), lat: 45.5, tempC: 4, motion });
        const ids = checkSvg(svg, 'scene ' + c + (day ? ' day' : ' night') + (motion ? '' : ' still'));
        for (const id of ids) { ok(!seen.has(id), 'unique gradient id ' + id); seen.add(id); }
        if (!motion) ok(!/class="wx-(rain|snow|fall|drift|spin|bolt|flash|twinkle)/.test(svg), 'scene ' + c + ' still: no motion classes');
      }
      const icon = W.icon(c, day, 32);
      for (const id of checkSvg(icon, 'icon ' + c + (day ? ' day' : ' night'))) { ok(!seen.has(id), 'unique icon id ' + id); seen.add(id); }
      ok(['light', 'dark'].includes(W.sceneInk(c, day)), 'sceneInk ' + c);
    }
  }
  ok(/wx-bolt/.test(W.scene('thunder', true)), 'thunder scene has the lightning');
  ok(/wx-snow/.test(W.scene('snow', true)) && /wx-rain/.test(W.scene('rain', false)), 'snow/rain scenes animate their precipitation');
  ok(W.scene('nonsense', true).includes('Partly cloudy'), 'unknown condition falls back to partly cloudy art');
  // Seasons follow the hemisphere.
  eq(W.seasonFor(Date.parse('2026-07-10T12:00:00Z'), 45), 'summer', 'July is summer up north');
  eq(W.seasonFor(Date.parse('2026-07-10T12:00:00Z'), -34), 'winter', 'July is winter down south');
  eq(W.seasonFor(Date.parse('2026-11-01T12:00:00Z'), 45), 'autumn', 'November is autumn up north');

  // ── 6) zero-network invariants (source) ───────────────────────────────
  const src = read('static', 'extras-weather.js');
  const code = src.replace(/\/\/[^\n]*/g, '');  // ignore comments
  const fetchCalls = code.match(/\bfetch\w*\s*\(/g) || [];
  const fetchFnCalls = code.match(/\bfetchFn\s*\(/g) || [];
  eq(fetchFnCalls.length, 1, 'only makeFetchJson calls the injected fetch');
  ok(!/\bglobal\.fetch\s*\(|\bwindow\.fetch\s*\(|(^|[^.\w])fetch\s*\(/m.test(code), 'no direct fetch() calls anywhere');
  ok(!/XMLHttpRequest|sendBeacon|new\s+WebSocket|EventSource|importScripts/.test(code), 'no other network APIs');
  const loadCalls = code.match(/CORE\.load\s*\(/g) || [];
  eq(loadCalls.length, 1, 'CORE.load is called from exactly one place');
  const handler = /async function onLoadClick\(\)\s*\{([\s\S]*?)\n    \}\n    loadBtn\.addEventListener\('click', onLoadClick\);/.exec(code);
  ok(handler && /CORE\.load\s*\(/.test(handler[1]), 'that place is the Load button click handler');
  ok((code.match(/onLoadClick/g) || []).length === 2, 'onLoadClick is only defined + bound to the button (never called directly)');
  const uiPart = code.slice(code.indexOf("if (typeof document === 'undefined'"));
  ok(!/setInterval|setTimeout|requestAnimationFrame|visibilitychange|addEventListener\('online'/.test(uiPart),
    'UI has no timers or wake-up hooks that could load on their own');
  ok(!/geolocation\.(watchPosition|getCurrentPosition)/.test(code), 'never opens its own GPS watch (reads the shared fix)');
  ok(fetchCalls.length >= 1, 'sanity: the helper exists');

  // ── 7) wiring ─────────────────────────────────────────────────────────
  const indexSrc = read('static', 'index.html');
  const runPy = read('run.py');
  const buildCap = read('scripts', 'build-capacitor.sh');
  ok(/_CC_DEFERRED_SCRIPTS = \[[\s\S]*?'\/static\/extras-weather\.js'[\s\S]*?\]/.test(indexSrc), 'index.html: deferred script list loads extras-weather.js');
  const list = /_CC_DEFERRED_SCRIPTS = \[([\s\S]*?)\]/.exec(indexSrc);
  ok(list && list[1].indexOf("'/static/extras.js'") < list[1].indexOf("'/static/extras-weather.js'"), 'index.html: after extras.js (needs ExtrasRegisterTool)');
  ok(/c\.delete\(u\)/.test(indexSrc) && indexSrc.includes("'/static/extras-weather.js','/static/synth.html'"), 'index.html: in the refresh cache-delete list');
  ok(/_TRACKED_JS = \{[\s\S]*?"extras-weather\.js"/.test(runPy), 'run.py: _TRACKED_JS');
  ok(/_SCRIPT_VERSION_FILES = \[[\s\S]*?"extras-weather\.js"/.test(runPy), 'run.py: _SCRIPT_VERSION_FILES');
  ok(buildCap.includes('"extras-weather.js"'), 'build-capacitor.sh: stamp list');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
