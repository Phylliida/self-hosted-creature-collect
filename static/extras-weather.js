// Extras -> Weather: the forecast for where you are, from the weather service
// that covers your area, drawn as a little animated scene.
//
// Zero-data contract: NOTHING in this file touches the network until the
// person taps "Load forecast (uses data)". The last forecast is kept in
// localStorage (cc.weather.v1) and shown again, offline, on later visits with
// its age. There is no auto-refresh of any kind.
//
// Sources (keyless, CORS-enabled, picked by where the point is):
//   - Canada -> Environment and Climate Change Canada (api.weather.gc.ca): the
//               official city forecast for the nearest of ~840 places, with
//               its weather warnings.
//   - US     -> National Weather Service (api.weather.gov), with alerts.
//   - anywhere else, or when the above fails -> Open-Meteo
//               (api.open-meteo.com), which serves the best national weather
//               model for the area.
// The point is rounded to 0.01 degrees (~1 km) before it leaves the device.
// A typical load is 1-4 small requests, ~1-8 KB on the wire.
//
// Every source is normalised into one metric model (fromEccc / fromNws /
// fromOpenMeteo) and every source's condition codes map onto one set of
// conditions, each with a hand-built SVG scene (the big card) and icon (the
// hourly / daily rows).
//
// Pure logic + art live on global.WeatherCore so tests/weather.test.js can run
// them under Node against recorded API fixtures (tests/fixtures/weather/).
//
// NOTE: the CSS below lives inside a template literal -- never put a backtick
// inside it (even in a comment), it terminates the string.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve (if tracked)
  if (global._scriptVersions) global._scriptVersions['extras-weather.js'] = SCRIPT_VERSION;

  const CORE = {};
  const D2R = Math.PI / 180;

  // ════════════════════════════════════════════════════════════════════
  // CONDITIONS
  // ════════════════════════════════════════════════════════════════════
  // One vocabulary for every source. Each id has a scene + an icon.
  const CONDS = {
    clear: 'Clear', few: 'Mainly clear', partly: 'Partly cloudy',
    mostly: 'Mostly cloudy', cloudy: 'Cloudy', fog: 'Fog', haze: 'Haze',
    smoke: 'Smoke', dust: 'Dust', drizzle: 'Drizzle', showers: 'Showers',
    rain: 'Rain', 'heavy-rain': 'Heavy rain', 'freezing-rain': 'Freezing rain',
    mix: 'Rain and snow', flurries: 'Flurries', snow: 'Snow',
    'heavy-snow': 'Heavy snow', hail: 'Hail', thunder: 'Thunderstorm',
    windy: 'Windy', tornado: 'Tornado', hot: 'Hot', cold: 'Cold',
  };
  CORE.CONDS = CONDS;
  CORE.condLabel = (cond, day) => {
    if (cond === 'clear') return day ? 'Sunny' : 'Clear';
    if (cond === 'few') return day ? 'Mainly sunny' : 'Mainly clear';
    return CONDS[cond] || '';
  };

  // How much a condition "matters" when a period mixes several (an NWS icon
  // like bkn/rain_showers,40 is "mostly cloudy then showers" -> showers).
  const RANK = {
    clear: 0, few: 1, partly: 2, mostly: 3, cloudy: 4, hot: 5, cold: 5,
    windy: 6, haze: 7, smoke: 8, dust: 8, fog: 9, drizzle: 10, showers: 11,
    rain: 12, flurries: 13, mix: 14, snow: 15, 'freezing-rain': 16,
    'heavy-rain': 17, 'heavy-snow': 18, hail: 19, thunder: 20, tornado: 21,
  };
  CORE.RANK = RANK;

  // Free-text fallback, for codes a table doesn't know. Order matters: the
  // most specific / most severe wording wins.
  CORE.textCond = function (text) {
    const t = String(text || '').toLowerCase();
    if (!t) return null;
    if (/tornado|funnel|waterspout/.test(t)) return 'tornado';
    if (/hail/.test(t)) return 'hail';
    if (/thunder|t-storm|tstorm/.test(t)) return 'thunder';
    if (/freezing|ice pellet|sleet|glaze/.test(t)) return 'freezing-rain';
    if (/blizzard|blowing snow|drifting snow|heavy snow|snow at times heavy|snow squall/.test(t)) return 'heavy-snow';
    if (/(rain|shower|drizzle)[^.]*(snow|flurr)|(snow|flurr)[^.]*(rain|shower)|wintry mix/.test(t)) return 'mix';
    if (/flurr|snow shower|light snow|snow grains/.test(t)) return 'flurries';
    if (/snow/.test(t)) return 'snow';
    if (/heavy rain|rain at times heavy|heavy shower|downpour|torrential/.test(t)) return 'heavy-rain';
    if (/drizzle/.test(t)) return 'drizzle';
    if (/shower/.test(t)) return 'showers';
    if (/rain|precip/.test(t)) return 'rain';
    if (/smoke/.test(t)) return 'smoke';
    if (/dust|sand/.test(t)) return 'dust';
    if (/haze/.test(t)) return 'haze';
    if (/fog|mist/.test(t)) return 'fog';
    if (/wind|breezy|blustery|gust/.test(t)) return 'windy';
    if (/mostly cloudy|mainly cloudy|considerable cloud/.test(t)) return 'mostly';
    if (/overcast|cloudy/.test(t) && !/partly|mix of sun|periods/.test(t)) return 'cloudy';
    if (/partly|mix of sun|cloudy periods|partly sunny|increasing cloud|clearing/.test(t)) return 'partly';
    if (/mostly sunny|mainly sunny|mostly clear|mainly clear|few clouds/.test(t)) return 'few';
    if (/sunny|clear|fair/.test(t)) return 'clear';
    if (/\bhot\b|heat/.test(t)) return 'hot';
    if (/\bcold\b|frigid/.test(t)) return 'cold';
    return null;
  };

  // Environment Canada icon codes (00-29 day, 30-39 night, 40+ special).
  // Built from a sweep of every citypage forecast's code/text pairs.
  const ECCC_CODES = {
    0: 'clear', 1: 'few', 2: 'partly', 3: 'mostly', 4: 'mostly', 5: 'partly',
    6: 'showers', 7: 'mix', 8: 'flurries', 9: 'thunder', 10: 'cloudy',
    11: 'rain', 12: 'rain', 13: 'heavy-rain', 14: 'freezing-rain', 15: 'mix',
    16: 'snow', 17: 'snow', 18: 'heavy-snow', 19: 'thunder', 20: 'fog',
    23: 'haze', 24: 'fog', 25: 'heavy-snow', 26: 'cold', 27: 'hail',
    28: 'drizzle', 30: 'clear', 31: 'few', 32: 'partly', 33: 'mostly',
    34: 'mostly', 35: 'partly', 36: 'showers', 37: 'mix', 38: 'flurries',
    39: 'thunder', 40: 'heavy-snow', 41: 'tornado', 42: 'tornado', 43: 'windy',
    44: 'smoke', 45: 'dust', 46: 'hail', 47: 'dust', 48: 'tornado',
  };
  CORE.ECCC_CODES = ECCC_CODES;
  CORE.ecccCond = (code, text) => {
    const n = typeof code === 'number' ? code : parseInt(code, 10);
    return (Number.isFinite(n) && ECCC_CODES[n]) || CORE.textCond(text);
  };

  // NWS icon codes (api.weather.gov/icons).
  const NWS_CODES = {
    skc: 'clear', few: 'few', sct: 'partly', bkn: 'mostly', ovc: 'cloudy',
    wind_skc: 'windy', wind_few: 'windy', wind_sct: 'windy', wind_bkn: 'windy',
    wind_ovc: 'windy', snow: 'snow', rain_snow: 'mix', rain_sleet: 'mix',
    snow_sleet: 'mix', fzra: 'freezing-rain', rain_fzra: 'freezing-rain',
    snow_fzra: 'freezing-rain', sleet: 'freezing-rain', rain: 'rain',
    rain_showers: 'rain', rain_showers_hi: 'showers', tsra: 'thunder',
    tsra_sct: 'thunder', tsra_hi: 'thunder', tornado: 'tornado',
    hurricane: 'heavy-rain', tropical_storm: 'heavy-rain', dust: 'dust',
    smoke: 'smoke', haze: 'haze', hot: 'hot', cold: 'cold',
    blizzard: 'heavy-snow', fog: 'fog',
  };
  CORE.NWS_CODES = NWS_CODES;
  CORE.nwsCond = function (icon, text) {
    const m = /\/icons\/land\/(?:day|night)\/([^?#]+)/.exec(icon || '');
    let best = null;
    if (m) {
      for (const seg of m[1].split('/')) {
        const c = NWS_CODES[seg.split(',')[0]];
        if (c && (best == null || RANK[c] > RANK[best])) best = c;
      }
    }
    // The words can be sharper than the icon ("Heavy Rain" under a plain
    // rain icon), never weaker.
    const t = CORE.textCond(text);
    if (t && (best == null || RANK[t] > RANK[best])) best = t;
    return best;
  };

  // WMO weather interpretation codes (Open-Meteo).
  const WMO = {
    0: ['clear', 'Clear'], 1: ['few', 'Mainly clear'], 2: ['partly', 'Partly cloudy'],
    3: ['cloudy', 'Overcast'], 45: ['fog', 'Fog'], 48: ['fog', 'Freezing fog'],
    51: ['drizzle', 'Light drizzle'], 53: ['drizzle', 'Drizzle'], 55: ['drizzle', 'Heavy drizzle'],
    56: ['freezing-rain', 'Freezing drizzle'], 57: ['freezing-rain', 'Freezing drizzle'],
    61: ['rain', 'Light rain'], 63: ['rain', 'Rain'], 65: ['heavy-rain', 'Heavy rain'],
    66: ['freezing-rain', 'Light freezing rain'], 67: ['freezing-rain', 'Freezing rain'],
    71: ['snow', 'Light snow'], 73: ['snow', 'Snow'], 75: ['heavy-snow', 'Heavy snow'],
    77: ['flurries', 'Snow grains'], 80: ['showers', 'Light showers'], 81: ['showers', 'Showers'],
    82: ['heavy-rain', 'Heavy showers'], 85: ['flurries', 'Snow showers'],
    86: ['heavy-snow', 'Heavy snow showers'], 95: ['thunder', 'Thunderstorm'],
    96: ['hail', 'Thunderstorm with hail'], 99: ['hail', 'Thunderstorm with heavy hail'],
  };
  CORE.WMO = WMO;
  CORE.wmoCond = (code) => (WMO[code] ? WMO[code][0] : null);
  CORE.wmoText = (code, day) => {
    if (code === 0 || code === 1) return CORE.condLabel(WMO[code][0], day);
    return WMO[code] ? WMO[code][1] : '';
  };

  // ════════════════════════════════════════════════════════════════════
  // GEOGRAPHY: which weather service covers a point
  // ════════════════════════════════════════════════════════════════════
  // Coarse Canada outline, [lon, lat], good to ~10-20 km along the US
  // border (Juan de Fuca, the 49th parallel, the Great Lakes, the St
  // Lawrence, the Maine border, the Alaska panhandle), generous out at sea.
  // A point near the line gets the neighbour's forecast, which is fine.
  const CANADA = [
    [-141.0, 72.0], [-141.0, 60.3], [-139.1, 60.35], [-137.5, 59.0],
    [-136.5, 59.6], [-135.5, 59.8], [-133.4, 58.4], [-131.8, 56.7],
    [-130.0, 55.9], [-130.0, 55.3], [-130.6, 54.75], [-133.8, 54.5],
    [-134.0, 52.0], [-127.5, 48.5], [-124.75, 48.5], [-123.45, 48.25],
    [-123.2, 48.35], [-123.25, 48.6], [-123.05, 48.77], [-123.32, 49.0],
    [-95.15, 49.0], [-94.65, 48.72], [-93.4, 48.6], [-92.0, 48.35],
    [-90.8, 48.2], [-89.6, 48.0], [-88.4, 48.3], [-86.0, 47.15],
    [-84.85, 46.9], [-84.55, 46.47], [-84.35, 46.5], [-84.1, 46.25],
    [-83.45, 45.95], [-82.5, 45.3], [-82.15, 44.0], [-82.42, 43.0],
    [-82.5, 42.65], [-82.93, 42.35], [-83.08, 42.3], [-83.13, 42.05],
    [-82.7, 41.67], [-82.4, 41.68], [-81.25, 42.2], [-80.0, 42.45],
    [-79.0, 42.85], [-78.92, 42.9], [-79.05, 43.26], [-78.7, 43.62],
    [-77.0, 43.65], [-76.35, 44.1], [-75.85, 44.4], [-75.3, 44.85],
    [-74.75, 45.0], [-74.67, 45.0], [-71.5, 45.01], [-71.08, 45.3],
    [-70.66, 45.47], [-70.25, 45.95], [-70.05, 46.6], [-69.22, 47.45],
    [-68.6, 47.25], [-68.3, 47.35], [-67.79, 47.07], [-67.78, 45.95],
    [-67.42, 45.6], [-67.28, 45.19], [-66.95, 44.8], [-67.1, 44.4],
    [-66.8, 43.8], [-65.5, 42.5], [-60.0, 43.0], [-52.0, 45.5],
    [-51.5, 50.0], [-58.0, 60.0], [-60.0, 62.0], [-57.5, 66.5],
    [-60.0, 70.0], [-68.0, 75.0], [-73.8, 78.5], [-67.0, 80.5],
    [-63.0, 82.0], [-60.0, 84.0], [-141.0, 84.0],
  ];
  function inPoly(lon, lat, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  CORE.inCanada = (lat, lon) => inPoly(lon, lat, CANADA);

  // US / Mexico border, west to east: south of this line is Mexico.
  const MEX = [[-117.13, 32.53], [-114.72, 32.72], [-111.07, 31.33],
    [-108.21, 31.33], [-108.21, 31.78], [-106.53, 31.78], [-104.92, 30.6],
    [-103.2, 28.97], [-102.4, 29.77], [-101.4, 29.77], [-100.4, 28.3],
    [-99.5, 27.5], [-99.1, 26.4], [-97.14, 25.95]];
  function mexBorderLat(lon) {
    if (lon <= MEX[0][0]) return MEX[0][1];
    for (let i = 1; i < MEX.length; i++) {
      if (lon <= MEX[i][0]) {
        const a = MEX[i - 1], b = MEX[i];
        return a[1] + (b[1] - a[1]) * (lon - a[0]) / (b[0] - a[0]);
      }
    }
    return 25.8;  // Gulf of Mexico
  }
  CORE.inUS = function (lat, lon) {
    const box = (s, n, w, e) => lat >= s && lat <= n && lon >= w && lon <= e;
    if (box(24.3, 49.5, -125.0, -66.8)) {
      if (CORE.inCanada(lat, lon)) return false;
      if (lon < -97.14 + 1e-9 ? lat < mexBorderLat(lon) : (lon < -90 && lat < 25.8)) return false;
      if (lon > -79.3 && lat < 27.3) return false;  // Bahamas
      return true;
    }
    return box(51, 72, -180, -129.9) && !CORE.inCanada(lat, lon)   // Alaska
      || box(51, 55, 172, 180)                                        // Aleutians
      || box(18.5, 22.6, -160.6, -154.6)                              // Hawaii
      || box(17.6, 18.6, -67.4, -64.5)                                // PR + USVI
      || box(13.2, 20.6, 144.5, 146.1)                                // Guam + NMI
      || box(-14.6, -14.1, -171.1, -168.1);                           // Am. Samoa
  };
  CORE.routeFor = (lat, lon) => (CORE.inCanada(lat, lon) ? 'eccc' : CORE.inUS(lat, lon) ? 'nws' : 'openmeteo');

  // ~1 km grid: enough for a forecast, too coarse to pinpoint a home.
  CORE.roundLoc = function (loc) {
    let lon = ((loc.lon + 540) % 360) - 180;
    if (lon === -180 && loc.lon > 0) lon = 180;
    return { lat: Math.round(loc.lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
  };

  CORE.km = function (lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
  };

  // ════════════════════════════════════════════════════════════════════
  // SUN + FEELS-LIKE (so day/night art and "feels like" are consistent
  // across sources, and work offline from the cached forecast)
  // ════════════════════════════════════════════════════════════════════
  CORE.sunAlt = function (ms, lat, lon) {
    const d = ms / 86400000 - 10957.5;  // days since J2000.0
    const g = (357.529 + 0.98560028 * d) * D2R;
    const q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
    const e = (23.439 - 0.00000036 * d) * D2R;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
    const ha = (gmst * 15 + lon) * D2R - ra;
    const s = Math.sin(lat * D2R) * Math.sin(dec) + Math.cos(lat * D2R) * Math.cos(dec) * Math.cos(ha);
    return Math.asin(Math.max(-1, Math.min(1, s))) / D2R;
  };
  CORE.isDay = (ms, lat, lon) => CORE.sunAlt(ms, lat, lon) > -0.833;

  // Sunrise / sunset on the local calendar day (in tz) containing `ms`.
  // { rise, set } in ms, either may be null (polar day / night).
  CORE.sunTimes = function (ms, lat, lon, tz) {
    const key = CORE.dayKey(ms, tz);
    const STEP = 10 * 60000;
    let rise = null, set = null;
    let prevT = ms - 26 * 3600000, prevUp = CORE.isDay(prevT, lat, lon);
    for (let t = prevT + STEP; t <= ms + 26 * 3600000; t += STEP) {
      const up = CORE.isDay(t, lat, lon);
      if (up !== prevUp) {
        let lo = prevT, hi = t;  // refine to ~30 s
        for (let i = 0; i < 5; i++) {
          const mid = (lo + hi) / 2;
          if (CORE.isDay(mid, lat, lon) === prevUp) lo = mid; else hi = mid;
        }
        const at = Math.round((lo + hi) / 2);
        if (CORE.dayKey(at, tz) === key) {
          if (up && rise == null) rise = at;
          if (!up && set == null) set = at;
        }
      }
      prevT = t; prevUp = up;
    }
    return { rise, set, up: CORE.isDay(ms, lat, lon) };
  };

  // Wind chill (Environment Canada formula) below 10 C, heat index above
  // ~27 C; otherwise the air temperature.
  CORE.feelsLike = function (t, rh, v) {
    if (!Number.isFinite(t)) return null;
    if (t <= 10 && Number.isFinite(v) && v > 4.8) {
      const p = Math.pow(v, 0.16);
      return 13.12 + 0.6215 * t - 11.37 * p + 0.3965 * t * p;
    }
    if (t >= 26.7 && Number.isFinite(rh) && rh >= 40) {
      const f = t * 9 / 5 + 32;
      const hi = -42.379 + 2.04901523 * f + 10.14333127 * rh - 0.22475541 * f * rh
        - 0.00683783 * f * f - 0.05481717 * rh * rh + 0.00122874 * f * f * rh
        + 0.00085282 * f * rh * rh - 0.00000199 * f * f * rh * rh;
      return (hi - 32) * 5 / 9;
    }
    return t;
  };

  // Temperature unit: the tool's own °C/°F toggle ('c' | 'f') wins; until
  // it's touched, follow the app's distance units (miles -> °F).
  CORE.tempUnit = (pref, appUnits) => (pref === 'c' || pref === 'f' ? pref : appUnits === 'mi' ? 'f' : 'c');
  CORE.tempIn = (c, unit) => (unit === 'f' ? c * 9 / 5 + 32 : c);

  // ════════════════════════════════════════════════════════════════════
  // TIME HELPERS (forecasts are shown in the forecast location's zone)
  // ════════════════════════════════════════════════════════════════════
  const _dtf = new Map();
  function dtf(tz, opts) {
    const k = tz + '|' + JSON.stringify(opts);
    let f = _dtf.get(k);
    if (!f) {
      try { f = new Intl.DateTimeFormat('en-CA', Object.assign({ timeZone: tz }, opts)); }
      catch (_) { f = new Intl.DateTimeFormat('en-CA', Object.assign({ timeZone: 'UTC' }, opts)); }
      _dtf.set(k, f);
    }
    return f;
  }
  // 'YYYY-MM-DD' of the local calendar day in tz.
  CORE.dayKey = (ms, tz) => dtf(tz || 'UTC', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  CORE.addDays = function (key, n) {
    const d = new Date(key + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  CORE.weekdayOf = (key) => new Date(key + 'T12:00:00Z').getUTCDay();

  // Province -> zone for Environment Canada places (their feed has none).
  const PROV_TZ = {
    bc: 'America/Vancouver', ab: 'America/Edmonton', sk: 'America/Regina',
    mb: 'America/Winnipeg', on: 'America/Toronto', qc: 'America/Toronto',
    nb: 'America/Moncton', ns: 'America/Halifax', pe: 'America/Halifax',
    nl: 'America/St_Johns', yt: 'America/Whitehorse', nt: 'America/Yellowknife',
    nu: 'America/Iqaluit',
  };

  // ════════════════════════════════════════════════════════════════════
  // NORMALISERS -> one metric model
  // ════════════════════════════════════════════════════════════════════
  //   { v, src, srcName, place, region, distKm, lat, lon, tz, issuedAt,
  //     now:   { t, tempC, feelsC, cond, text, windKph, windDir, gustKph,
  //              rh, hPa, dewC, observed },
  //     hours: [{ t, tempC, cond, text, pop }],
  //     days:  [{ key, hiC, loC, cond, text, nightCond, nightText, pop,
  //               onlyNight }],
  //     alerts:[{ title, level: red|orange|yellow|grey, text, expires, url }] }
  const num = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  // Environment Canada wraps nearly every leaf as { en, fr }.
  const en = (o) => (o && typeof o === 'object' && ('en' in o)) ? o.en : o;
  const val = (o) => (o && typeof o === 'object' && ('value' in o)) ? en(o.value) : en(o);
  const COMPASS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  CORE.compass = (deg) => (Number.isFinite(deg) ? COMPASS16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16] : null);
  const popFromText = (t) => { const m = /(\d{1,3})\s*(?:percent|%)\s*chance/i.exec(t || ''); return m ? Math.min(100, +m[1]) : null; };
  const maxPop = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));

  function blankModel(src, srcName, q) {
    return { v: 1, src, srcName, place: null, region: null, distKm: null,
      lat: q.lat, lon: q.lon, tz: 'UTC', issuedAt: null, now: null,
      hours: [], days: [], alerts: [] };
  }
  function fillFeels(now) {
    if (now && now.feelsC == null) now.feelsC = CORE.feelsLike(now.tempC, now.rh, now.windKph);
    return now;
  }

  CORE.fromEccc = function (item, q, distKm) {
    const p = (item && item.properties) || {};
    const m = blankModel('eccc', 'Environment Canada', q);
    m.place = en(p.name) || null;
    m.region = en(p.region) || null;
    m.distKm = Number.isFinite(distKm) ? distKm : null;
    const id = String(item.id || p.identifier || '');
    m.tz = PROV_TZ[id.split('-')[0]] || 'America/Toronto';

    const cc = p.currentConditions || {};
    const hf = ((p.hourlyForecastGroup || {}).hourlyForecasts) || [];
    m.hours = hf.map((h) => {
      const text = en(h.condition) || '';
      return {
        t: Date.parse(en(h.timestamp)),
        tempC: num(val(h.temperature)),
        cond: CORE.ecccCond(num(val(h.iconCode)), text),
        text,
        pop: num(val(h.lop)),
        windKph: num(val(h.wind && h.wind.speed)),
      };
    }).filter((h) => Number.isFinite(h.t));

    const tC = num(val(cc.temperature));
    if (tC != null) {
      const text = en(cc.condition) || '';
      const kpa = num(val(cc.pressure));
      m.now = {
        t: Date.parse(en(cc.timestamp)) || null,
        tempC: tC, feelsC: null,
        cond: CORE.ecccCond(num(val(cc.iconCode)), text) || (m.hours[0] && m.hours[0].cond) || null,
        text,
        windKph: num(val(cc.wind && cc.wind.speed)),
        windDir: val(cc.wind && cc.wind.direction) || null,
        gustKph: num(val(cc.wind && cc.wind.gust)) || null,
        rh: num(val(cc.relativeHumidity)),
        hPa: kpa != null ? kpa * 10 : null,
        dewC: num(val(cc.dewpoint)),
        observed: true,
        station: val(cc.station) || null,
      };
    } else if (m.hours.length) {
      const h = m.hours[0];
      m.now = { t: h.t, tempC: h.tempC, feelsC: null, cond: h.cond, text: h.text,
        windKph: h.windKph, windDir: null, gustKph: null, rh: null, hPa: null,
        dewC: null, observed: false };
    }
    fillFeels(m.now);

    // Days: text periods ("Tonight", "Monday", "Monday night", ...) carry no
    // dates, so anchor them on the issue time and walk the weekday names.
    const fg = p.forecastGroup || {};
    const issued = Date.parse(en(fg.timestamp)) || (m.now && m.now.t) || Date.now();
    m.issuedAt = issued;
    const baseKey = CORE.dayKey(issued, m.tz);
    const byKey = new Map();
    let lastKey = baseKey;
    for (const fc of (fg.forecasts || [])) {
      const name = String(en(fc.period && fc.period.textForecastName) || en(fc.period && fc.period.value) || '');
      const lower = name.toLowerCase();
      const night = /night/.test(lower);
      let key;
      if (/^(today|tonight|this )/.test(lower)) key = baseKey;
      else {
        const wd = WEEKDAYS.findIndex((w) => lower.startsWith(w));
        key = lastKey;
        if (wd >= 0) {
          for (let i = 0; i < 8; i++) {
            const k = CORE.addDays(baseKey, i);
            if (CORE.weekdayOf(k) === wd && k >= lastKey) { key = k; break; }
          }
        }
      }
      lastKey = key;
      const af = fc.abbreviatedForecast || {};
      const shortText = en(af.textSummary) || '';
      const longText = en(fc.textSummary) || shortText;
      const cond = CORE.ecccCond(num(val(af.icon)), shortText);
      let hi = null, lo = null;
      for (const t of ((fc.temperatures || {}).temperature || [])) {
        const cls = en(t.class), v = num(val(t));
        if (cls === 'high') hi = v; else if (cls === 'low') lo = v;
      }
      let d = byKey.get(key);
      if (!d) { d = { key, hiC: null, loC: null, cond: null, text: '', nightCond: null, nightText: '', pop: null, onlyNight: false }; byKey.set(key, d); }
      const pop = popFromText(longText);
      if (night) {
        d.nightCond = cond; d.nightText = longText;
        if (lo != null) d.loC = lo;
      } else {
        d.cond = cond; d.text = longText;
        if (hi != null) d.hiC = hi;
        if (lo != null && d.loC == null) d.loC = lo;
      }
      d.pop = maxPop(d.pop, pop);
    }
    m.days = Array.from(byKey.values()).map((d) => {
      if (!d.cond) { d.onlyNight = true; d.cond = d.nightCond; }
      return d;
    });

    m.alerts = (p.warnings || []).map((w) => {
      const type = String(en(w.type) || '').toLowerCase();
      if (type === 'ended') return null;
      const colour = String(en(w.alertColourLevel) || '').toLowerCase();
      const level = ['red', 'orange', 'yellow'].includes(colour) ? colour
        : type === 'warning' ? 'orange' : type === 'watch' ? 'yellow' : 'grey';
      return { title: en(w.description) || 'Weather alert', level, text: '',
        expires: Date.parse(en(w.expiryTime)) || null, url: en(w.url) || null };
    }).filter(Boolean);
    return m;
  };

  const fToC = (f) => (Number.isFinite(f) ? (f - 32) * 5 / 9 : null);
  const toC = (t, unit) => (unit === 'F' ? fToC(num(t)) : num(t));
  // "8 to 14 mph" / "10 mph" / "13 to 22 km/h" -> km/h of the upper figure.
  const nwsWind = (s) => {
    const m = /(\d+)(?:\s*to\s*(\d+))?\s*(mph|km\/h)/i.exec(s || '');
    if (!m) return null;
    const v = +(m[2] || m[1]);
    return /mph/i.test(m[3]) ? v * 1.609344 : v;
  };
  const NWS_SEVERITY = { Extreme: 'red', Severe: 'orange', Moderate: 'yellow', Minor: 'grey' };

  CORE.fromNws = function (points, forecast, hourly, alerts, q) {
    const pp = (points && points.properties) || {};
    const m = blankModel('nws', 'National Weather Service', q);
    const rl = pp.relativeLocation && pp.relativeLocation.properties;
    if (rl) {
      m.place = [rl.city, rl.state].filter(Boolean).join(', ') || null;
      const dm = rl.distance && num(rl.distance.value);
      m.distKm = dm != null ? dm / 1000 : null;
    }
    m.tz = pp.timeZone || 'UTC';
    const fp = (forecast && forecast.properties) || {};
    m.issuedAt = Date.parse(fp.updateTime || fp.generatedAt) || null;

    const hp = ((hourly && hourly.properties) || {}).periods || [];
    m.hours = hp.slice(0, 48).map((h) => ({
      t: Date.parse(h.startTime),
      tempC: toC(h.temperature, h.temperatureUnit),
      cond: CORE.nwsCond(h.icon, h.shortForecast),
      text: h.shortForecast || '',
      pop: h.probabilityOfPrecipitation ? num(h.probabilityOfPrecipitation.value) : null,
      windKph: nwsWind(h.windSpeed),
      windDir: h.windDirection || null,
      rh: h.relativeHumidity ? num(h.relativeHumidity.value) : null,
      dewC: h.dewpoint ? num(h.dewpoint.value) : null,
    })).filter((h) => Number.isFinite(h.t));

    const periods = fp.periods || [];
    const h0 = m.hours[0];
    const p0 = periods[0];
    if (h0) {
      m.now = { t: h0.t, tempC: h0.tempC, feelsC: null, cond: h0.cond, text: h0.text,
        windKph: h0.windKph, windDir: h0.windDir, gustKph: null, rh: h0.rh, hPa: null,
        dewC: h0.dewC, observed: false };
    } else if (p0) {
      m.now = { t: Date.parse(p0.startTime), tempC: toC(p0.temperature, p0.temperatureUnit),
        feelsC: null, cond: CORE.nwsCond(p0.icon, p0.shortForecast), text: p0.shortForecast || '',
        windKph: nwsWind(p0.windSpeed), windDir: p0.windDirection || null, gustKph: null,
        rh: null, hPa: null, dewC: null, observed: false };
    }
    fillFeels(m.now);

    const byKey = new Map();
    for (const p of periods) {
      const t = Date.parse(p.startTime);
      if (!Number.isFinite(t)) continue;
      const key = CORE.dayKey(t, m.tz);
      let d = byKey.get(key);
      if (!d) { d = { key, hiC: null, loC: null, cond: null, text: '', nightCond: null, nightText: '', pop: null, onlyNight: false }; byKey.set(key, d); }
      const tC = toC(p.temperature, p.temperatureUnit);
      const cond = CORE.nwsCond(p.icon, p.shortForecast);
      const text = p.detailedForecast || p.shortForecast || '';
      if (p.isDaytime) { d.cond = cond; d.text = text; d.hiC = tC; }
      else { d.nightCond = cond; d.nightText = text; d.loC = tC; }
      d.pop = maxPop(d.pop, p.probabilityOfPrecipitation ? num(p.probabilityOfPrecipitation.value) : null);
    }
    m.days = Array.from(byKey.values()).map((d) => {
      if (!d.cond) { d.onlyNight = true; d.cond = d.nightCond; }
      return d;
    });

    m.alerts = (((alerts && alerts.features) || []).map((f) => {
      const a = f.properties || {};
      return {
        title: a.event || 'Weather alert',
        level: NWS_SEVERITY[a.severity] || 'grey',
        text: [a.headline, a.description, a.instruction].filter(Boolean)
          .map((t) => String(t).replace(/([^\n])\n(?![\n*])/g, '$1 ')).join('\n\n'),
        expires: Date.parse(a.ends || a.expires) || null,
        url: null,
      };
    }));
    return m;
  };

  CORE.fromOpenMeteo = function (j, q) {
    const m = blankModel('openmeteo', 'Open-Meteo', q);
    m.tz = j.timezone || 'UTC';
    const c = j.current || {};
    if (c.time != null) {
      const code = c.weather_code;
      m.now = {
        t: c.time * 1000, tempC: num(c.temperature_2m), feelsC: num(c.apparent_temperature),
        cond: CORE.wmoCond(code), text: CORE.wmoText(code, c.is_day !== 0),
        windKph: num(c.wind_speed_10m), windDir: CORE.compass(num(c.wind_direction_10m)),
        gustKph: num(c.wind_gusts_10m), rh: num(c.relative_humidity_2m),
        hPa: num(c.pressure_msl), dewC: null, observed: false,
      };
      m.issuedAt = m.now.t;
    }
    fillFeels(m.now);
    const h = j.hourly || {};
    m.hours = (h.time || []).map((t, i) => ({
      t: t * 1000,
      tempC: num(h.temperature_2m && h.temperature_2m[i]),
      cond: CORE.wmoCond(h.weather_code && h.weather_code[i]),
      text: CORE.wmoText(h.weather_code && h.weather_code[i], !h.is_day || h.is_day[i] !== 0),
      pop: num(h.precipitation_probability && h.precipitation_probability[i]),
      windKph: num(h.wind_speed_10m && h.wind_speed_10m[i]),
    }));
    if (j.minutely_15) m.nowcast = CORE.fromOmMinutely(j);
    const d = j.daily || {};
    m.days = (d.time || []).map((t, i) => {
      const code = d.weather_code && d.weather_code[i];
      return {
        key: CORE.dayKey(t * 1000 + 12 * 3600000, m.tz),  // noon: immune to DST edges
        hiC: num(d.temperature_2m_max && d.temperature_2m_max[i]),
        loC: num(d.temperature_2m_min && d.temperature_2m_min[i]),
        cond: CORE.wmoCond(code), text: CORE.wmoText(code, true),
        nightCond: null, nightText: '',
        pop: num(d.precipitation_probability_max && d.precipitation_probability_max[i]),
        onlyNight: false,
      };
    });
    return m;
  };

  // ════════════════════════════════════════════════════════════════════
  // AIR QUALITY, UV, RAIN IN THE NEXT 2 HOURS (loaded with the forecast)
  // ════════════════════════════════════════════════════════════════════
  //   m.air     = { kind: 'aqhi' | 'usaqi', hours: [{ t, v }], place?, distKm? }
  //   m.uv      = { hours: [{ t, v }] }
  //   m.nowcast = { steps: [{ t, mm, snowCm }] }   15-minute steps
  CORE.fromOmAir = function (j) {
    const h = (j && j.hourly) || {};
    const series = (key) => (h.time || []).map((t, i) => ({ t: t * 1000, v: num(h[key] && h[key][i]) }))
      .filter((x) => x.v != null);
    const aq = series('us_aqi'), uv = series('uv_index');
    return { air: aq.length ? { kind: 'usaqi', hours: aq } : null, uv: uv.length ? { hours: uv } : null };
  };
  // Environment Canada's hourly AQHI forecast: the newest publication for the
  // nearest forecast city (they publish ~37 hours, twice a day).
  CORE.fromAqhi = function (j, q) {
    const rows = ((j && j.features) || []).map((f) => ({ p: f.properties || {}, c: f.geometry && f.geometry.coordinates }))
      .filter((r) => r.p.aqhi_type === 'AQHI-Forecast' && r.p.forecast_datetime && r.c);
    let best = null;
    for (const r of rows) {
      const km = CORE.km(q.lat, q.lon, r.c[1], r.c[0]);
      if (!best || km < best.km) best = { id: r.p.location_id, name: r.p.location_name_en || null, km };
    }
    if (!best || best.km > 80) return null;
    const mine = rows.filter((r) => r.p.location_id === best.id);
    const pub = mine.reduce((a, r) => (r.p.publication_datetime > a ? r.p.publication_datetime : a), '');
    const hours = mine.filter((r) => r.p.publication_datetime === pub)
      .map((r) => ({ t: Date.parse(r.p.forecast_datetime), v: num(r.p.aqhi) }))
      .filter((x) => Number.isFinite(x.t) && x.v != null)
      .sort((a, b) => a.t - b.t);
    return hours.length ? { kind: 'aqhi', hours, place: best.name, distKm: best.km } : null;
  };
  CORE.fromOmMinutely = function (j) {
    const n = (j && j.minutely_15) || {};
    const steps = (n.time || []).map((t, i) => ({
      t: t * 1000,
      mm: num(n.precipitation && n.precipitation[i]) || 0,
      snowCm: num(n.snowfall && n.snowfall[i]) || 0,
    }));
    return steps.length ? { steps } : null;
  };

  // Risk bands: [upper bound, label, colour]. AQHI is Canada's 1-10+ index,
  // usaqi the US EPA 0-500 AQI, uv the WHO UV index.
  const SCALES = {
    aqhi: { min: 1, max: 11, bands: [[3, 'Low risk', '#3d8fe0'], [6, 'Moderate risk', '#e8b400'],
      [10, 'High risk', '#e5484d'], [Infinity, 'Very high risk', '#8e1b3c']], walk: [0, 10, 35, 55] },
    usaqi: { min: 0, max: 300, bands: [[50, 'Good', '#2fb36b'], [100, 'Moderate', '#e8b400'],
      [150, 'Unhealthy for sensitive groups', '#f08a24'], [200, 'Unhealthy', '#e5484d'],
      [300, 'Very unhealthy', '#8b4fc7'], [Infinity, 'Hazardous', '#7e1f3a']], walk: [0, 6, 18, 35, 50, 60] },
    uv: { min: 0, max: 11, bands: [[2, 'Low', '#2fb36b'], [5, 'Moderate', '#e8b400'], [7, 'High', '#f08a24'],
      [10, 'Very high', '#e5484d'], [Infinity, 'Extreme', '#8b4fc7']] },
  };
  CORE.SCALES = SCALES;
  CORE.band = function (scale, v) {
    const S = SCALES[scale];
    const r = Math.round(v);  // indexes are reported as whole numbers
    for (let i = 0; i < S.bands.length; i++) {
      if (r <= S.bands[i][0]) return { level: i, label: S.bands[i][1], color: S.bands[i][2] };
    }
    return null;
  };
  // The hourly value covering ms (or the nearest one within the hour).
  CORE.valueAt = function (hours, ms) {
    if (!hours || !hours.length) return null;
    let best = null;
    for (const h of hours) {
      if (ms >= h.t && ms < h.t + 3600000) return h;
      const d = Math.abs(h.t - ms);
      if (d <= 3600000 && (!best || d < Math.abs(best.t - ms))) best = h;
    }
    return best;
  };
  CORE.maxBetween = function (hours, from, to) {
    let best = null;
    for (const h of (hours || [])) if (h.t + 3600000 > from && h.t < to && (!best || h.v > best.v)) best = h;
    return best;
  };
  // UV peak for the rest of today, or tomorrow's once today's sun is spent.
  CORE.uvPeak = function (hours, nowMs, tz) {
    const today = CORE.dayKey(nowMs, tz);
    const ahead = (hours || []).filter((h) => h.t + 3600000 > nowMs);
    const on = (key) => ahead.filter((h) => CORE.dayKey(h.t, tz) === key);
    let list = on(today), tomorrow = false;
    if (!list.some((h) => h.v >= 0.5)) {
      const next = on(CORE.addDays(today, 1));
      if (next.length) { list = next; tomorrow = true; }
    }
    if (!list.length) return null;
    const top = list.reduce((a, h) => (h.v > a.v ? h : a), list[0]);
    return { v: top.v, t: top.t, tomorrow };
  };

  // What the next 2 hours of 15-minute precipitation add up to.
  // { state: dry | starting | stopping | all, at, kind: rain | snow | mix,
  //   intensity: light | moderate | heavy, steps } or null when stale.
  CORE.nowcastSummary = function (nc, nowMs) {
    if (!nc || !nc.steps) return null;
    const steps = nc.steps.filter((s) => s.t + 15 * 60000 > nowMs).slice(0, 8);
    if (steps.length < 4) return null;  // too old to say anything about "now"
    const wet = (s) => s.mm >= 0.05 || s.snowCm >= 0.05;
    const isSnow = (s) => s.snowCm > 0 && s.snowCm * 0.7 >= s.mm * 0.5;
    const wets = steps.filter(wet);
    const nSnow = wets.filter(isSnow).length;
    const kind = !wets.length || !nSnow ? 'rain' : nSnow === wets.length ? 'snow' : 'mix';
    const peak = Math.max(0, ...steps.map((s) => Math.max(s.mm, s.snowCm * 0.7)));
    const intensity = peak >= 1 ? 'heavy' : peak >= 0.25 ? 'moderate' : 'light';
    let state = 'dry', at = null;
    if (wets.length && wet(steps[0])) {
      const dry = steps.find((s) => !wet(s));
      state = dry ? 'stopping' : 'all';
      at = dry ? dry.t : null;
    } else if (wets.length) {
      state = 'starting';
      at = wets[0].t;
    }
    return { state, at, kind, intensity, steps };
  };

  // How nice one forecast hour is for a walk, 0-100: dry, mild, calm, clean air.
  const WALK_COND = {
    tornado: 100, thunder: 60, hail: 60, 'freezing-rain': 60, 'heavy-rain': 45, 'heavy-snow': 40,
    smoke: 40, rain: 30, mix: 30, dust: 30, showers: 20, drizzle: 15, snow: 12, fog: 8, windy: 8,
    flurries: 6, haze: 5,
  };
  CORE.walkScore = function (h, ctx) {
    ctx = ctx || {};
    let s = 100 - (WALK_COND[h.cond] || 0);
    if (Number.isFinite(h.pop)) s -= h.pop * 0.5;
    const wind = Number.isFinite(h.windKph) ? h.windKph : ctx.windKph;
    const feels = CORE.feelsLike(h.tempC, ctx.rh, wind);
    // Comfiest around 16-21 °C: cool days favour the warm afternoon, hot
    // days the cool morning.
    if (Number.isFinite(feels)) {
      if (feels < 16) s -= (16 - feels) * 1.6 + Math.max(0, 8 - feels) * 1.4;
      else if (feels > 21) s -= (feels - 21) * 3;
    }
    if (Number.isFinite(wind) && wind > 22) s -= (wind - 22) * 1.2;
    const air = ctx.air && CORE.valueAt(ctx.air.hours, h.t);
    if (air) { const b = CORE.band(ctx.air.kind, air.v); if (b) s -= SCALES[ctx.air.kind].walk[b.level] || 0; }
    const uv = ctx.uv && CORE.valueAt(ctx.uv.hours, h.t);
    if (uv) s -= uv.v >= 8 ? 8 : uv.v >= 6 ? 3 : 0;
    return Math.max(0, Math.min(100, s));
  };

  // The best stretch of daylight left today for a walk (tomorrow's once the
  // sun has set): 2 hours, 3 when the next hour is as nice, 1 if that's all
  // there is. Works off the stored forecast, so it moves with the clock.
  CORE.bestWalk = function (m, nowMs) {
    if (!m || !m.hours || !m.hours.length) return null;
    const tz = m.tz, today = CORE.dayKey(nowMs, tz);
    const ctx = { rh: m.now && m.now.rh, windKph: m.now && m.now.windKph, air: m.air, uv: m.uv };
    const daylightHours = (key, ref) => {
      const st = CORE.sunTimes(ref, m.lat, m.lon, tz);
      if (st.rise == null && st.set == null && !st.up) return [];  // polar night
      return m.hours.filter((h) => {
        const mid = h.t + 30 * 60000;
        return CORE.dayKey(mid, tz) === key && mid >= nowMs
          && (st.rise == null || mid >= st.rise) && (st.set == null || mid <= st.set)
          && Number.isFinite(h.tempC);
      });
    };
    let tomorrow = false;
    let cand = daylightHours(today, nowMs);
    if (!cand.length) { cand = daylightHours(CORE.addDays(today, 1), nowMs + 86400000); tomorrow = true; }
    if (!cand.length) return null;
    // Where the 15-minute precipitation covers an hour, it's sharper than the
    // hourly chance: wet quarters set the chance, a dry hour isn't rainy.
    const Q = 15 * 60000;
    const ncSteps = ((m.nowcast && m.nowcast.steps) || []).filter((s) => s.t + Q > nowMs);
    const wetStep = (s) => s.mm >= 0.05 || s.snowCm >= 0.05;
    const quarters = (h, from) => ncSteps.filter((s) => s.t >= Math.max(h.t, from || 0) && s.t < h.t + 3600000);
    // Only an hour the nowcast (nearly) covers from here on: the rest of the
    // current hour, or at least 3 of a later hour's 4 quarters.
    const covered = (h, from) => {
      const q = quarters(h, from);
      const start = Math.max(h.t, from || 0, nowMs - (((nowMs % Q) + Q) % Q));
      const need = Math.round((h.t + 3600000 - start) / Q);
      return q.length >= Math.min(2, need) && q.length >= need - 1 ? q : null;
    };
    const blend = (h, from) => {
      const q = covered(h, from);
      if (!q) return h;
      const frac = q.filter(wetStep).length / q.length;
      return Object.assign({}, h, { pop: Math.round(frac * 100),
        cond: frac === 0 && RANK[h.cond] >= RANK.drizzle ? 'cloudy' : h.cond });
    };
    const raw = new Map(cand.map((h) => [h.t, h]));
    cand = cand.map((h) => blend(h));
    const sc = cand.map((h) => ({ h, s: CORE.walkScore(h, ctx) }));
    const next = (a, b) => b && b.h.t - a.h.t === 3600000;
    let best = null;
    const consider = (run, i) => {
      const avg = run.reduce((a, x) => a + x.s, 0) / run.length;
      const eff = run.length === 1 && sc.length > 1 ? avg - 3 : avg;  // a proper walk wins near-ties
      if (!best || eff > best.eff + 1e-9) best = { run, avg, eff, i };  // earliest wins ties
    };
    for (let i = 0; i < sc.length; i++) {
      if (next(sc[i], sc[i + 1])) consider([sc[i], sc[i + 1]], i);
      consider([sc[i]], i);
    }
    const after = sc[best.i + best.run.length];
    if (best.run.length === 2 && next(best.run[1], after) && after.s >= best.avg - 4) {
      best.run.push(after);
      best.avg = best.run.reduce((a, x) => a + x.s, 0) / best.run.length;
    }
    const hs = best.run.map((x) => x.h);
    // Rain clearing partway into the first hour: start when it stops, and
    // describe the walk from there.
    let start = hs[0].t;
    const q0 = quarters(hs[0]);
    if (q0.length && wetStep(q0[0])) {
      const dry = q0.find((s) => !wetStep(s));
      if (dry) { start = dry.t; hs[0] = blend(raw.get(hs[0].t), start); }
    }
    const vals = (k) => hs.map((h) => h[k]).filter(Number.isFinite);
    const pops = vals('pop'), temps = vals('tempC'), winds = vals('windKph');
    const worst = hs.reduce((a, h) => (h.cond && (!a || RANK[h.cond] > RANK[a]) ? h.cond : a), null);
    let airBand = null;
    if (m.air) {
      const top = CORE.maxBetween(m.air.hours, hs[0].t, hs[hs.length - 1].t + 3600000);
      if (top) airBand = CORE.band(m.air.kind, top.v);
    }
    const uvTop = m.uv ? CORE.maxBetween(m.uv.hours, hs[0].t, hs[hs.length - 1].t + 3600000) : null;
    const avg = Math.round(best.avg);
    return {
      start, end: hs[hs.length - 1].t + 3600000, startsNow: !tomorrow && start <= nowMs,
      tomorrow, score: avg,
      quality: avg >= 80 ? 'great' : avg >= 60 ? 'good' : avg >= 40 ? 'okay' : 'poor',
      cond: worst,
      wetCond: hs.some((h) => RANK[h.cond] >= RANK.drizzle),
      popMax: pops.length ? Math.max(...pops) : null,
      tMin: temps.length ? Math.min(...temps) : null, tMax: temps.length ? Math.max(...temps) : null,
      windMax: winds.length ? Math.max(...winds) : null,
      air: airBand && airBand.level > 0 ? airBand : null,
      uvMax: uvTop ? uvTop.v : null,
    };
  };

  // ════════════════════════════════════════════════════════════════════
  // LOADERS (network). Only CORE.load reaches these, and only the Load
  // button calls CORE.load.
  // ════════════════════════════════════════════════════════════════════
  function wxErr(kind, msg, extra) {
    const e = new Error(msg);
    e.kind = kind;
    return Object.assign(e, extra || {});
  }
  CORE.wxErr = wxErr;

  // JSON GET with a timeout. Errors carry .kind: offline | timeout | http |
  // parse | nodata. No credentials, no referrer; Accept is a CORS-safelisted
  // header, so these stay "simple" requests (no preflight).
  CORE.makeFetchJson = function (fetchFn, timeoutMs) {
    return async function fetchJson(url) {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs || 20000) : null;
      let res;
      try {
        res = await fetchFn(url, {
          cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
          headers: { Accept: 'application/geo+json, application/json' },
          signal: ctl ? ctl.signal : undefined,
        });
      } catch (e) {
        throw wxErr(e && e.name === 'AbortError' ? 'timeout' : 'offline', String((e && e.message) || e));
      } finally {
        if (timer) clearTimeout(timer);
      }
      // The service worker answers a failed fetch with an empty 504.
      if (!res.ok) throw wxErr(res.status === 504 ? 'offline' : 'http', 'HTTP ' + res.status, { status: res.status });
      try { return await res.json(); }
      catch (_) { throw wxErr('parse', 'unreadable response'); }
    };
  };

  const ECCC_ITEMS = 'https://api.weather.gc.ca/collections/citypageweather-realtime/items';
  async function loadEccc(q, F) {
    let best = null;
    // Widen the search until a forecast place turns up (the far north is sparse).
    for (const r of [0.4, 1.2, 3]) {
      const dLon = r / Math.max(0.2, Math.cos(q.lat * D2R));
      const bbox = [q.lon - dLon, q.lat - r, q.lon + dLon, q.lat + r].map((x) => x.toFixed(2)).join(',');
      const j = await F(ECCC_ITEMS + '?f=json&properties=identifier&limit=100&bbox=' + bbox);
      for (const f of ((j && j.features) || [])) {
        const c = f.geometry && f.geometry.coordinates;
        const id = f.id || (f.properties && f.properties.identifier);
        if (!c || !id) continue;
        const km = CORE.km(q.lat, q.lon, c[1], c[0]);
        if (!best || km < best.km) best = { id: String(id), km };
      }
      if (best) break;
    }
    if (!best || best.km > 250) throw wxErr('nodata', 'no Environment Canada forecast near here');
    const item = await F(ECCC_ITEMS + '/' + encodeURIComponent(best.id) + '?f=json');
    return CORE.fromEccc(item, q, best.km);
  }

  async function loadNws(q, F) {
    const points = await F('https://api.weather.gov/points/' + q.lat + ',' + q.lon);
    const pp = (points && points.properties) || {};
    const ok = (u) => typeof u === 'string' && /^https:\/\/api\.weather\.gov\//.test(u);
    if (!ok(pp.forecast)) throw wxErr('nodata', 'no NWS forecast here');
    const [fc, hr, al] = await Promise.all([
      F(pp.forecast),
      ok(pp.forecastHourly) ? F(pp.forecastHourly).catch(() => null) : null,
      F('https://api.weather.gov/alerts/active?point=' + q.lat + ',' + q.lon).catch(() => null),
    ]);
    return CORE.fromNws(points, fc, hr, al, q);
  }

  const OM_MINUTELY = '&minutely_15=precipitation,snowfall&forecast_minutely_15=10';
  async function loadOpenMeteo(q, F) {
    const j = await F('https://api.open-meteo.com/v1/forecast?latitude=' + q.lat + '&longitude=' + q.lon
      + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,'
      + 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl'
      + '&hourly=temperature_2m,weather_code,precipitation_probability,is_day,wind_speed_10m'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + OM_MINUTELY
      + '&forecast_days=7&forecast_hours=48&timezone=auto&timeformat=unixtime&wind_speed_unit=kmh');
    if (!j || !j.hourly) throw wxErr('nodata', 'empty forecast');
    return CORE.fromOpenMeteo(j, q);
  }
  const LOADERS = { eccc: loadEccc, nws: loadNws, openmeteo: loadOpenMeteo };

  // Air quality + UV (Open-Meteo, everywhere; Environment Canada's AQHI wins
  // in Canada) and the next 2 hours of 15-minute rain. Run after the forecast
  // succeeded, in parallel; each is optional and never fails the load.
  CORE.loadExtras = async function (m, q, F) {
    let aqhi = null;
    const jobs = [
      F('https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + q.lat + '&longitude=' + q.lon
        + '&hourly=us_aqi,uv_index&forecast_days=2&timezone=auto&timeformat=unixtime')
        .then((j) => { const r = CORE.fromOmAir(j); if (r.air) m.air = r.air; if (r.uv) m.uv = r.uv; })
        .catch(() => {}),
    ];
    if (!m.nowcast) {
      jobs.push(F('https://api.open-meteo.com/v1/forecast?latitude=' + q.lat + '&longitude=' + q.lon
        + OM_MINUTELY + '&timezone=auto&timeformat=unixtime')
        .then((j) => { m.nowcast = CORE.fromOmMinutely(j); })
        .catch(() => {}));
    }
    if (CORE.inCanada(q.lat, q.lon)) {
      const r = 0.6, dLon = r / Math.max(0.2, Math.cos(q.lat * D2R));
      const bbox = [q.lon - dLon, q.lat - r, q.lon + dLon, q.lat + r].map((x) => x.toFixed(2)).join(',');
      jobs.push(F('https://api.weather.gc.ca/collections/aqhi-forecasts-realtime/items?f=json&limit=150'
        + '&sortby=-publication_datetime&bbox=' + bbox)
        .then((j) => { aqhi = CORE.fromAqhi(j, q); })
        .catch(() => {}));
    }
    await Promise.all(jobs);
    if (aqhi) m.air = aqhi;
    return m;
  };

  // The one network entry point. loc = { lat, lon }.
  // opts = { fetch (required), timeoutMs, now }.
  CORE.load = async function (loc, opts) {
    opts = opts || {};
    if (typeof opts.fetch !== 'function') throw wxErr('offline', 'no fetch');
    const F = CORE.makeFetchJson(opts.fetch, opts.timeoutMs);
    const q = CORE.roundLoc(loc);
    const primary = CORE.routeFor(q.lat, q.lon);
    const order = primary === 'openmeteo' ? ['openmeteo'] : [primary, 'openmeteo'];
    let firstErr = null;
    for (const src of order) {
      try {
        const m = await LOADERS[src](q, F);
        await CORE.loadExtras(m, q, F);
        m.fetchedAt = opts.now || Date.now();
        if (src !== primary) m.fellBackFrom = primary;
        return m;
      } catch (e) {
        if (!firstErr) firstErr = e;
        if (e.kind === 'offline') break;  // no other host will answer either
      }
    }
    throw firstErr;
  };

  // ════════════════════════════════════════════════════════════════════
  // ART
  // ════════════════════════════════════════════════════════════════════
  // Hand-built SVG in the app's item-art style: radial-gradient fills,
  // darker same-hue outlines, a white highlight, cute faces where they fit.
  // Every SVG gets its own id prefix so gradients never collide, and the
  // animations are CSS classes (defined in the panel CSS; .wx-anim scopes
  // them, prefers-reduced-motion turns them off).
  const r2 = (n) => Math.round(n * 100) / 100;
  let _uid = 0;
  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  }
  function hexRgb(h) {
    const m = /^#?([0-9a-f]{6})$/i.exec(h);
    const n = m ? parseInt(m[1], 16) : 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // Mix two hex colours: t=0 -> a, t=1 -> b.
  function mix(a, b, t) {
    const A = hexRgb(a), B = hexRgb(b);
    return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
  }
  CORE._mix = mix;

  function Art() {
    const prefix = 'wx' + (++_uid).toString(36) + '-';
    const defs = new Map();
    return {
      prefix,
      def(k, build) {
        if (!defs.has(k)) defs.set(k, build(prefix + k));
        return 'url(#' + prefix + k + ')';
      },
      defsSvg() { return defs.size ? '<defs>' + Array.from(defs.values()).join('') + '</defs>' : ''; },
    };
  }
  const stopsSvg = (stops) => stops.map((s) => '<stop offset="' + s[0] + '" stop-color="' + s[1] + '"'
    + (s[2] != null ? ' stop-opacity="' + s[2] + '"' : '') + '/>').join('');
  function lin(A, k, stops, x1, y1, x2, y2, user) {
    return A.def(k, (id) => '<linearGradient id="' + id + '" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"'
      + (user ? ' gradientUnits="userSpaceOnUse"' : '') + '>' + stopsSvg(stops) + '</linearGradient>');
  }
  function rad(A, k, stops, cx, cy, r) {
    return A.def(k, (id) => '<radialGradient id="' + id + '" cx="' + cx + '" cy="' + cy + '" r="' + r + '">'
      + stopsSvg(stops) + '</radialGradient>');
  }
  const anim = (cls, dur, delay, inner) => '<g class="' + cls + '" style="animation-duration:' + r2(dur)
    + 's;animation-delay:' + r2(delay) + 's">' + inner + '</g>';

  // ── faces ──
  function face(kind, ink, cx, cy, k, o) {
    o = o || {};
    const sw = r2(1.7 * k);
    const P = (x, y) => r2(cx + x * k) + ' ' + r2(cy + y * k);
    const line = (d) => '<path d="' + d + '" fill="none" stroke="' + ink + '" stroke-width="' + sw
      + '" stroke-linecap="round" stroke-linejoin="round"/>';
    const dot = (x, y, r) => '<circle cx="' + r2(cx + x * k) + '" cy="' + r2(cy + y * k) + '" r="' + r2((r || 1.8) * k) + '" fill="' + ink + '"/>';
    const spread = o.blush == null ? 12 : o.blush;
    const blush = (a) => spread ? ['-', ''].map((s) => '<ellipse cx="' + r2(cx + (s ? -spread : spread) * k)
      + '" cy="' + r2(cy + 4.2 * k) + '" rx="' + r2(3.4 * k) + '" ry="' + r2(2 * k)
      + '" fill="#ff7d9c" opacity="' + a + '"/>').join('') : '';
    const smile = line('M' + P(-3, 4.5) + ' Q' + P(0, 7.5) + ' ' + P(3, 4.5));
    switch (kind) {
      case 'happy':  // ^^ closed eyes
        return blush(0.55) + line('M' + P(-9, 1) + ' Q' + P(-6, -3.2) + ' ' + P(-3, 1))
          + line('M' + P(3, 1) + ' Q' + P(6, -3.2) + ' ' + P(9, 1)) + smile;
      case 'sleepy':  // gently closed
        return blush(0.5) + line('M' + P(-9, 0) + ' Q' + P(-6, 2.6) + ' ' + P(-3, 0))
          + line('M' + P(3, 0) + ' Q' + P(6, 2.6) + ' ' + P(9, 0))
          + line('M' + P(-2, 5) + ' Q' + P(0, 6.4) + ' ' + P(2, 5));
      case 'grumpy':
        return line('M' + P(-10.5, -4.6) + ' L' + P(-3.6, -2.4)) + line('M' + P(10.5, -4.6) + ' L' + P(3.6, -2.4))
          + dot(-6, 0.6) + dot(6, 0.6) + line('M' + P(-3.6, 6.8) + ' Q' + P(0, 4.6) + ' ' + P(3.6, 6.8));
      case 'brr':
        return blush(0.75) + dot(-6, 0) + dot(6, 0)
          + line('M' + P(-4.5, 5.4) + ' L' + P(-2.2, 4.1) + ' L' + P(0, 5.4) + ' L' + P(2.2, 4.1) + ' L' + P(4.5, 5.4));
      case 'oh':
        return blush(0.45) + dot(-6, 0) + dot(6, 0)
          + '<ellipse cx="' + r2(cx) + '" cy="' + r2(cy + 5.4 * k) + '" rx="' + r2(1.9 * k) + '" ry="' + r2(2.3 * k)
          + '" fill="none" stroke="' + ink + '" stroke-width="' + sw + '"/>';
      case 'sweat':
        return blush(0.6) + line('M' + P(-9, 1) + ' Q' + P(-6, -3.2) + ' ' + P(-3, 1))
          + line('M' + P(3, 1) + ' Q' + P(6, -3.2) + ' ' + P(9, 1)) + smile
          + '<path d="M' + P(11.5, -6) + ' q' + r2(-1.6 * k) + ' ' + r2(2.8 * k) + ' 0 ' + r2(3.6 * k)
          + ' q' + r2(1.6 * k) + ' ' + r2(-0.8 * k) + ' 0 ' + r2(-3.6 * k) + 'Z" fill="#9fdcff" stroke="#4a9ad6" stroke-width="' + r2(0.6 * k) + '"/>';
      default: // calm
        return blush(0.5) + dot(-6, 0) + dot(6, 0) + smile;
    }
  }

  // ── sun ──
  const SUN_PALS = {
    sun: { c0: '#fffbd6', c1: '#ffdc4e', c2: '#ffb529', line: '#e58f17', ray: '#ffcf3d', rayLine: '#e59a1c', glow: '#ffe27a', ink: '#8a4b10' },
    hot: { c0: '#fff3c0', c1: '#ffb640', c2: '#ff7a1f', line: '#d9560f', ray: '#ff9e35', rayLine: '#d0600f', glow: '#ffb35c', ink: '#7a2e08' },
    pale: { c0: '#fffdf0', c1: '#ffefc2', c2: '#f7d49a', line: '#d9ad72', ray: '#ffe8b0', rayLine: '#d9b27a', glow: '#fff3d6', ink: '#7a5a30' },
    smoke: { c0: '#ffd7a6', c1: '#ff9d5c', c2: '#ea6a3a', line: '#b94c2b', ray: '#ff9d5c', rayLine: '#b94c2b', glow: '#ff9d5c', ink: '#6e2a14' },
  };
  function sun(A, x, y, r, o) {
    o = o || {};
    const pal = SUN_PALS[o.pal || 'sun'];
    const pk = o.pal || 'sun';
    const body = rad(A, 'sun-' + pk, [[0, pal.c0], [0.5, pal.c1], [1, pal.c2]], 0.38, 0.33, 0.78);
    let s = '';
    if (o.glow !== false) {
      const glow = rad(A, 'sglow-' + pk, [[0, pal.glow, 0.6], [0.45, pal.glow, 0.22], [1, pal.glow, 0]], 0.5, 0.5, 0.5);
      s += '<circle cx="' + r2(x) + '" cy="' + r2(y) + '" r="' + r2(r * 2.3) + '" fill="' + glow + '"/>';
    }
    if (o.rays !== false) {
      const n = 12, w = Math.max(1.6, r * 0.17);
      let outl = '', fill = '';
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const a0 = r * 1.3, a1 = r * (i % 2 ? 1.55 : 1.72);
        const d = 'M' + r2(Math.cos(a) * a0) + ' ' + r2(Math.sin(a) * a0) + ' L' + r2(Math.cos(a) * a1) + ' ' + r2(Math.sin(a) * a1);
        outl += d; fill += d;
      }
      let rays = '<path d="' + outl + '" stroke="' + pal.rayLine + '" stroke-width="' + r2(w + Math.max(1, r * 0.07) * 2) + '" stroke-linecap="round"/>'
        + '<path d="' + fill + '" stroke="' + pal.ray + '" stroke-width="' + r2(w) + '" stroke-linecap="round"/>';
      if (o.spin) rays = '<g class="wx-spin">' + rays + '</g>';
      s += '<g transform="translate(' + r2(x) + ' ' + r2(y) + ')">' + rays + '</g>';
    }
    s += '<circle cx="' + r2(x) + '" cy="' + r2(y) + '" r="' + r2(r) + '" fill="' + body + '" stroke="' + pal.line
      + '" stroke-width="' + r2(Math.max(1, r * 0.08)) + '"/>';
    s += '<ellipse cx="' + r2(x - r * 0.36) + '" cy="' + r2(y - r * 0.42) + '" rx="' + r2(r * 0.3) + '" ry="' + r2(r * 0.16)
      + '" transform="rotate(-32 ' + r2(x - r * 0.36) + ' ' + r2(y - r * 0.42) + ')" fill="#fff" opacity="0.75"/>';
    if (o.face) s += face(o.face, pal.ink, x, y + r * 0.08, r / 16);
    return s;
  }

  // ── moon (a crescent cut by an offset circle) ──
  function crescentPath(R, bx, by, Rb) {
    const d = Math.hypot(bx, by), ux = bx / d, uy = by / d;
    const a = (R * R - Rb * Rb + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, R * R - a * a));
    const px = a * ux, py = a * uy;
    const i1 = [px - h * uy, py + h * ux], i2 = [px + h * uy, py - h * ux];
    // Pick each arc's sweep so the outer arc passes the far side of the moon
    // and the inner arc passes the side of the cutting circle facing it.
    const ang = (p, c) => Math.atan2(p[1] - c[1], p[0] - c[0]);
    const passes = (c, from, to, via) => {
      const norm = (v) => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const t = norm(ang(to, c) - ang(from, c)), v = norm(ang(via, c) - ang(from, c));
      return v < t;  // going in the +angle (clockwise on screen) direction
    };
    const farA = [-ux * R, -uy * R];
    const sweepA = passes([0, 0], i1, i2, farA) ? 1 : 0;
    const nearB = [bx - ux * Rb, by - uy * Rb];
    const sweepB = passes([bx, by], i2, i1, nearB) ? 1 : 0;
    const largeA = a > 0 ? 1 : 0;
    const largeB = a > d ? 1 : 0;
    return 'M' + r2(i1[0]) + ' ' + r2(i1[1])
      + ' A' + r2(R) + ' ' + r2(R) + ' 0 ' + largeA + ' ' + sweepA + ' ' + r2(i2[0]) + ' ' + r2(i2[1])
      + ' A' + r2(Rb) + ' ' + r2(Rb) + ' 0 ' + largeB + ' ' + sweepB + ' ' + r2(i1[0]) + ' ' + r2(i1[1]) + 'Z';
  }
  CORE._crescentPath = crescentPath;
  function moon(A, x, y, R, o) {
    o = o || {};
    const fill = rad(A, 'moon', [[0, '#fffef5'], [0.55, '#fcf0c6'], [1, '#efd78c']], 0.32, 0.4, 0.85);
    let s = '';
    if (o.glow !== false) {
      const glow = rad(A, 'mglow', [[0, '#fff4c4', 0.45], [0.5, '#fff4c4', 0.14], [1, '#fff4c4', 0]], 0.5, 0.5, 0.5);
      s += '<circle cx="' + r2(x) + '" cy="' + r2(y) + '" r="' + r2(R * 2.3) + '" fill="' + glow + '"/>';
    }
    s += '<g transform="translate(' + r2(x) + ' ' + r2(y) + ')">'
      + '<path d="' + crescentPath(R, R * 0.5, -R * 0.32, R * 0.86) + '" fill="' + fill + '" stroke="#c7a24c" stroke-width="'
      + r2(Math.max(1, R * 0.075)) + '" stroke-linejoin="round"/>'
      + '<ellipse cx="' + r2(-R * 0.55) + '" cy="' + r2(-R * 0.38) + '" rx="' + r2(R * 0.16) + '" ry="' + r2(R * 0.09)
      + '" transform="rotate(-50 ' + r2(-R * 0.55) + ' ' + r2(-R * 0.38) + ')" fill="#fff" opacity="0.8"/>'
      + '<circle cx="' + r2(-R * 0.62) + '" cy="' + r2(R * 0.5) + '" r="' + r2(R * 0.09) + '" fill="#e6cf8a" opacity="0.8"/>'
      + (o.face ? face(o.face, '#7a5a26', -R * 0.52, R * 0.2, R / 32, { blush: 9 }) : '')
      + '</g>';
    return s;
  }

  // ── stars ──
  function sparkle(x, y, s, fill) {
    const p = (dx, dy) => r2(x + dx) + ' ' + r2(y + dy);
    return '<path d="M' + p(0, -s) + ' Q' + p(0, 0) + ' ' + p(s, 0) + ' Q' + p(0, 0) + ' ' + p(0, s)
      + ' Q' + p(0, 0) + ' ' + p(-s, 0) + ' Q' + p(0, 0) + ' ' + p(0, -s) + 'Z" fill="' + fill + '"/>';
  }

  // ── clouds: four puffs on a flat base, ~100 x 56 at scale 1 ──
  const PUFFS = [[24, 38, 17], [46, 26, 23], [71, 31, 19], [87, 42, 13]];
  const CLOUD_SHAPES = PUFFS.map((p) => '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + p[2] + '"/>').join('')
    + '<rect x="8" y="36" width="90" height="20" rx="10"/>';
  const CLOUD_TONES = {
    white: { top: '#ffffff', bot: '#dde8f4', line: '#9aaec5', ink: '#3a4558', hi: 0.85 },
    light: { top: '#f4f7fb', bot: '#c5d1de', line: '#8293a7', ink: '#36404f', hi: 0.7 },
    grey: { top: '#c4cfdb', bot: '#8796a9', line: '#5a687b', ink: '#262e3b', hi: 0.5 },
    dark: { top: '#8f93ab', bot: '#53586f', line: '#323649', ink: '#181b26', hi: 0.32 },
    snow: { top: '#ffffff', bot: '#e2eaf7', line: '#a1b3cf', ink: '#3a4558', hi: 0.9 },
    haze: { top: '#f7ead3', bot: '#d9c09b', line: '#a98e68', ink: '#4a3b28', hi: 0.6 },
    night: { top: '#bcc6de', bot: '#7d8bac', line: '#4b5778', ink: '#252d44', hi: 0.45 },
    nightgrey: { top: '#838ea7', bot: '#525c76', line: '#30384d', ink: '#171b28', hi: 0.3 },
    nightdark: { top: '#5d627c', bot: '#363a51', line: '#1e2132', ink: '#cfd5e6', hi: 0.2 },
  };
  const NIGHT_TONE = { white: 'night', light: 'nightgrey', grey: 'nightgrey', dark: 'nightdark', snow: 'night', haze: 'nightgrey' };
  function cloud(A, x, y, s, tone, o) {
    o = o || {};
    const T = CLOUD_TONES[tone] || CLOUD_TONES.white;
    const fill = lin(A, 'c-' + tone, [[0, T.top], [1, T.bot]], 0, 6, 0, 56, true);
    const sw = o.sw || 2.4;
    let g = '<g transform="translate(' + r2(x) + ' ' + r2(y) + ') scale(' + r2(s) + ')">'
      + '<g fill="' + T.line + '" stroke="' + T.line + '" stroke-width="' + r2(sw * 2) + '" stroke-linejoin="round">' + CLOUD_SHAPES + '</g>'
      + '<g fill="' + fill + '">' + CLOUD_SHAPES + '</g>'
      + '<ellipse cx="39" cy="12.5" rx="10" ry="4.4" transform="rotate(-20 39 12.5)" fill="#fff" opacity="' + T.hi + '"/>'
      + '<ellipse cx="66" cy="17" rx="4.5" ry="2.4" transform="rotate(-10 66 17)" fill="#fff" opacity="' + r2(T.hi * 0.7) + '"/>'
      + (o.face ? face(o.face, T.ink, 55, 41, o.faceK || 1) : '')
      + '</g>';
    if (o.anim) g = anim(o.anim, o.dur || 12, o.delay || 0, g);
    return g;
  }

  // ── precipitation bits (centred on 0,0) ──
  const DROP_D = 'M0 -7 C1.6 -4.4 4.2 -1.3 4.2 1.6 A4.2 4.2 0 0 1 -4.2 1.6 C-4.2 -1.3 -1.6 -4.4 0 -7Z';
  function drop(A, x, y, k, icy, sy) {
    const g = icy ? lin(A, 'dropi', [[0, '#f4feff'], [1, '#9de2f4']], 0, 0, 0, 1)
      : lin(A, 'drop', [[0, '#d6eeff'], [1, '#4aa2ef']], 0, 0, 0, 1);
    return '<g transform="translate(' + r2(x) + ' ' + r2(y) + ') scale(' + r2(k) + ' ' + r2(k * (sy || 1)) + ')">'
      + '<path d="' + DROP_D + '" fill="' + g + '" stroke="' + (icy ? '#5eb3cb' : '#2f7ec6') + '" stroke-width="1.1"/>'
      + '<ellipse cx="-1.5" cy="1.2" rx="0.9" ry="1.6" fill="#fff" opacity="0.85"/></g>';
  }
  function flakePath(r) {
    let d = '';
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI;
      const c = Math.cos(a), s = Math.sin(a);
      const P = (px, py) => r2(px * c - py * s) + ' ' + r2(px * s + py * c);
      d += 'M' + P(0, -r) + ' L' + P(0, r);
      const b = r * 0.32, m = r * 0.55;
      d += 'M' + P(-b, -m - b) + ' L' + P(0, -m) + ' L' + P(b, -m - b);
      d += 'M' + P(-b, m + b) + ' L' + P(0, m) + ' L' + P(b, m + b);
    }
    return d;
  }
  function flake(x, y, r, o) {
    o = o || {};
    const w = Math.max(0.9, r * 0.22);
    const d = flakePath(r);
    return '<g transform="translate(' + r2(x) + ' ' + r2(y) + ')">'
      + '<path d="' + d + '" stroke="' + (o.line || '#8fa6c8') + '" stroke-width="' + r2(w + Math.max(0.8, r * 0.16) * 2) + '" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
      + '<path d="' + d + '" stroke="' + (o.fill || '#ffffff') + '" stroke-width="' + r2(w) + '" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
      + '</g>';
  }
  function hailBall(A, x, y, r) {
    const g = rad(A, 'hail', [[0, '#ffffff'], [0.6, '#e8f4fc'], [1, '#b9d6ea']], 0.35, 0.3, 0.8);
    return '<circle cx="' + r2(x) + '" cy="' + r2(y) + '" r="' + r2(r) + '" fill="' + g + '" stroke="#6a8fae" stroke-width="' + r2(Math.max(0.8, r * 0.24)) + '"/>'
      + '<circle cx="' + r2(x - r * 0.35) + '" cy="' + r2(y - r * 0.35) + '" r="' + r2(r * 0.28) + '" fill="#fff"/>';
  }
  const BOLT_D = 'M3 -15 L-7.5 2.5 L-1 2.5 L-4.5 15.5 L8.5 -3 L2 -3 L6.5 -15Z';
  function bolt(A, x, y, k) {
    const g = lin(A, 'bolt', [[0, '#fffbd0'], [0.45, '#ffe34d'], [1, '#ffbf1a']], 0, 0, 0, 1);
    return '<g transform="translate(' + r2(x) + ' ' + r2(y) + ') scale(' + r2(k) + ')">'
      + '<path d="' + BOLT_D + '" fill="' + g + '" stroke="#cf8c00" stroke-width="1.6" stroke-linejoin="round"/>'
      + '<path d="M2.6 -12 L-2.8 -1.2" stroke="#fff" stroke-width="1.3" stroke-linecap="round" opacity="0.85"/></g>';
  }
  function icicles(A, x, y, w, n, k) {
    const g = lin(A, 'ice', [[0, '#ffffff'], [1, '#a8e4f6']], 0, 0, 0, 1);
    let s = '';
    for (let i = 0; i < n; i++) {
      const cx = x + (i + 0.5) * (w / n), len = (i % 2 ? 7 : 11) * k, hw = 2.4 * k;
      s += '<path d="M' + r2(cx - hw) + ' ' + r2(y) + ' L' + r2(cx + hw) + ' ' + r2(y) + ' L' + r2(cx) + ' ' + r2(y + len) + 'Z" fill="' + g
        + '" stroke="#69b9d2" stroke-width="' + r2(0.9 * k) + '" stroke-linejoin="round"/>';
    }
    return s;
  }
  // a gust line with a curl at the end; pathLength=100 lets CSS sweep it
  function gust(x, y, len, curl, color, w, cls, dur, delay) {
    const d = 'M' + r2(x) + ' ' + r2(y) + ' H' + r2(x + len) + ' C' + r2(x + len + curl * 0.9) + ' ' + r2(y) + ' '
      + r2(x + len + curl) + ' ' + r2(y - curl * 0.95) + ' ' + r2(x + len + curl * 0.2) + ' ' + r2(y - curl * 1.05)
      + ' C' + r2(x + len - curl * 0.35) + ' ' + r2(y - curl * 1.1) + ' ' + r2(x + len - curl * 0.4) + ' ' + r2(y - curl * 0.45)
      + ' ' + r2(x + len) + ' ' + r2(y - curl * 0.35);
    const p = '<path d="' + d + '" pathLength="100" fill="none" stroke="' + color + '" stroke-width="' + r2(w)
      + '" stroke-linecap="round"' + (cls ? ' class="' + cls + '" style="animation-duration:' + r2(dur) + 's;animation-delay:' + r2(delay) + 's"' : '') + '/>';
    return p;
  }
  function leaf(x, y, k, color) {
    return '<g transform="translate(' + r2(x) + ' ' + r2(y) + ') scale(' + r2(k) + ')"><g class="wx-leafspin">'
      + '<path d="M0 -5 C4 -4 5 1 0 5 C-5 1 -4 -4 0 -5Z" fill="' + color + '" stroke="' + mix(color, '#000000', 0.35) + '" stroke-width="0.9"/>'
      + '<path d="M0 -4 L0 4" stroke="' + mix(color, '#000000', 0.35) + '" stroke-width="0.7"/></g></g>';
  }

  // ── landscape ──
  const SEASON_PALS = {
    spring: { far: ['#addf86', '#86c964', '#5d9e45'], near: ['#93d56f', '#6cb750', '#4a943a'], trees: ['#ffb9d4', '#9edc7b', '#ffd1e3'], treeLine: '#6d9a4e', kind: 'round' },
    summer: { far: ['#8fd174', '#64b658', '#428c3d'], near: ['#71c35e', '#4ca34a', '#347d35'], trees: ['#4fad4f', '#6cc35c', '#3f9a48'], treeLine: '#2f6f33', kind: 'round' },
    autumn: { far: ['#ccb96d', '#ad9b54', '#837338'], near: ['#bda45c', '#9a8244', '#6d5a2c'], trees: ['#ff9f43', '#e8573f', '#ffc94a'], treeLine: '#9a4a28', kind: 'round' },
    winter: { far: ['#adb8a0', '#8e9b84', '#6a7762'], near: ['#9da98f', '#7f8b73', '#5e6955'], trees: ['#3f6e55', '#4c7d61', '#3a6650'], treeLine: '#284a39', kind: 'pine' },
    snowy: { far: ['#ffffff', '#dfe8f4', '#a7b9d2'], near: ['#f7fbff', '#d2deed', '#99aeca'], trees: ['#3f6e55', '#4c7d61', '#3a6650'], treeLine: '#284a39', kind: 'pine', snow: true },
    icy: { far: ['#f4fbff', '#cfe6f2', '#94b8cf'], near: ['#eaf7ff', '#c2dcec', '#89aec6'], trees: ['#3f6e55', '#4c7d61', '#3a6650'], treeLine: '#284a39', kind: 'pine', snow: true, glaze: true },
    desert: { far: ['#ecca8e', '#d8ad6a', '#a9824a'], near: ['#e2bb78', '#c99a58', '#987140'], trees: [], treeLine: '#6b5232', kind: 'none' },
  };
  CORE.SEASON_PALS = SEASON_PALS;
  // Smooth closed path through sampled points (quadratic midpoint smoothing).
  function smoothFill(pts, H) {
    let d = 'M0 ' + H + ' L' + r2(pts[0][0]) + ' ' + r2(pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      d += ' Q' + r2(pts[i][0]) + ' ' + r2(pts[i][1]) + ' ' + r2(mx) + ' ' + r2(my);
    }
    const last = pts[pts.length - 1];
    return d + ' L' + r2(last[0]) + ' ' + r2(last[1]) + ' L320 ' + H + 'Z';
  }
  function smoothTop(pts) {
    let d = 'M' + r2(pts[0][0]) + ' ' + r2(pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      d += ' Q' + r2(pts[i][0]) + ' ' + r2(pts[i][1]) + ' ' + r2(mx) + ' ' + r2(my);
    }
    const last = pts[pts.length - 1];
    return d + ' L' + r2(last[0]) + ' ' + r2(last[1]);
  }
  const farY = (x) => 124 + 6 * Math.sin(x / 46 + 0.6) + 3.5 * Math.sin(x / 19 + 2.1);
  const nearY = (x) => 149 + 5 * Math.sin(x / 58 + 2.4) + 2.5 * Math.sin(x / 23 + 0.4);
  function tree(x, base, k, color, line, kind, snow) {
    if (kind === 'pine') {
      const h = 18 * k, w = 7 * k;
      let s = '<rect x="' + r2(x - 0.9 * k) + '" y="' + r2(base - 3 * k) + '" width="' + r2(1.8 * k) + '" height="' + r2(4 * k) + '" fill="#6b4a2f"/>';
      for (let i = 0; i < 3; i++) {
        const top = base - h + i * h * 0.26, bw = w * (0.55 + i * 0.25);
        s += '<path d="M' + r2(x) + ' ' + r2(top) + ' L' + r2(x + bw) + ' ' + r2(top + h * 0.42) + ' L' + r2(x - bw) + ' ' + r2(top + h * 0.42) + 'Z" fill="' + color
          + '" stroke="' + line + '" stroke-width="' + r2(0.9 * k) + '" stroke-linejoin="round"/>';
        if (snow) s += '<path d="M' + r2(x) + ' ' + r2(top) + ' L' + r2(x + bw * 0.5) + ' ' + r2(top + h * 0.2) + ' Q' + r2(x) + ' ' + r2(top + h * 0.26) + ' ' + r2(x - bw * 0.5) + ' ' + r2(top + h * 0.2) + 'Z" fill="#ffffff"/>';
      }
      return s;
    }
    const r = 6.2 * k;
    return '<rect x="' + r2(x - 1.1 * k) + '" y="' + r2(base - 6 * k) + '" width="' + r2(2.2 * k) + '" height="' + r2(7 * k) + '" rx="' + r2(0.8 * k) + '" fill="#7a5233"/>'
      + '<circle cx="' + r2(x) + '" cy="' + r2(base - 6 * k - r * 0.7) + '" r="' + r2(r) + '" fill="' + color + '" stroke="' + line + '" stroke-width="' + r2(0.9 * k) + '"/>'
      + '<circle cx="' + r2(x - r * 0.35) + '" cy="' + r2(base - 6 * k - r * 1.05) + '" r="' + r2(r * 0.3) + '" fill="#fff" opacity="0.45"/>';
  }
  // Moonlit ground at night: the season's colours pulled toward a night blue
  // (snow stays pale), trees darker still.
  const NIGHT_GROUND = { far: ['#3b4b6d', '#2b3957', '#1b2640'], near: ['#314061', '#24314d', '#161f35'] };
  const NIGHT_SNOW = { far: ['#9aaacb', '#7a8ab0', '#53618a'], near: ['#8d9dc2', '#6e7ea6', '#4a587e'] };
  function landscape(A, palName, tint, night) {
    const base = SEASON_PALS[palName] || SEASON_PALS.summer;
    const P = night ? Object.assign({}, base, base.snow ? NIGHT_SNOW : {
      far: base.far.map((c, i) => mix(c, NIGHT_GROUND.far[i], 0.88)),
      near: base.near.map((c, i) => mix(c, NIGHT_GROUND.near[i], 0.88)),
    }) : base;
    const T = (c) => (tint ? mix(c, tint.color, tint.amount) : c);
    const TT = (c) => (night ? mix(c, '#0f1a3d', 0.55) : T(c));
    const farPts = [], nearPts = [];
    for (let x = 0; x <= 320; x += 10) { farPts.push([x, farY(x)]); nearPts.push([x, nearY(x)]); }
    const farFill = lin(A, 'far', [[0, T(P.far[0])], [1, T(P.far[1])]], 0, 112, 0, 160, true);
    const nearFill = lin(A, 'near', [[0, T(P.near[0])], [1, T(P.near[1])]], 0, 138, 0, 180, true);
    let s = '<path d="' + smoothFill(farPts, 180) + '" fill="' + farFill + '" stroke="' + T(P.far[2]) + '" stroke-width="1.6" stroke-linejoin="round"/>';
    s += '<path d="' + smoothTop(farPts) + '" fill="none" stroke="#ffffff" stroke-width="1.4" opacity="' + (night ? 0.18 : 0.35) + '"/>';
    // a few trees along the far ridge, clear of the left text column's bottom
    const spots = [[198, 0.95], [212, 0.8], [254, 1.05], [270, 0.85], [300, 1]];
    if (P.kind !== 'none') {
      spots.forEach((sp, i) => {
        s += tree(sp[0], farY(sp[0]) + 1.5, sp[1], TT(P.trees[i % P.trees.length]), TT(P.treeLine), P.kind, P.snow);
      });
    }
    s += '<path d="' + smoothFill(nearPts, 180) + '" fill="' + nearFill + '" stroke="' + T(P.near[2]) + '" stroke-width="1.6" stroke-linejoin="round"/>';
    s += '<path d="' + smoothTop(nearPts) + '" fill="none" stroke="#ffffff" stroke-width="1.4" opacity="' + (P.glaze ? 0.9 : 0.35) + '"/>';
    if (P.glaze) {
      s += sparkle(64, nearY(64) + 6, 3, '#ffffff') + sparkle(150, nearY(150) + 9, 2.4, '#ffffff') + sparkle(236, nearY(236) + 5, 3.2, '#ffffff');
    }
    return s;
  }

  // ── sky ──
  const SKIES = {
    clear: { d: ['#3e9cff', '#7cc5ff', '#cdeeff'], n: ['#0a1238', '#1b2a66', '#3c4c8e'] },
    fair: { d: ['#4ca4f5', '#8dcbf7', '#d6eeff'], n: ['#0f1a44', '#22336e', '#45568f'] },
    grey: { d: ['#8399b0', '#a9bccd', '#d4dde6'], n: ['#1a2233', '#2c3648', '#475267'] },
    rain: { d: ['#5f7389', '#8697aa', '#b3c0cd'], n: ['#121a28', '#222c3d', '#3a4557'] },
    storm: { d: ['#3b3c54', '#585a79', '#80809d'], n: ['#0d0b1c', '#1d1a36', '#353050'] },
    snow: { d: ['#9db4d0', '#c4d4e6', '#eef3f9'], n: ['#1e2a45', '#33415f', '#56658a'] },
    fog: { d: ['#b3bdc7', '#ccd4db', '#e7ebef'], n: ['#272d36', '#3a414b', '#555d68'] },
    haze: { d: ['#c9ad82', '#dcc49e', '#efe0c4'], n: ['#2e2620', '#45392e', '#615041'] },
    smoke: { d: ['#9c8070', '#bf977a', '#e0b68e'], n: ['#2a201c', '#3e2e27', '#5a4034'] },
    dust: { d: ['#c4955a', '#d8b07a', '#ecd2a4'], n: ['#33261a', '#4a3825', '#6a5135'] },
    hot: { d: ['#ff9f4f', '#ffc570', '#ffe8aa'], n: ['#2a1640', '#4a2357', '#7a3a5e'] },
    cold: { d: ['#7fc0ff', '#b7dcff', '#eef8ff'], n: ['#0c1a3f', '#1d3268', '#3d5a96'] },
    tornado: { d: ['#4e5a4c', '#6f7d68', '#9aa58a'], n: ['#141a14', '#252e24', '#3d4838'] },
  };
  CORE.SKIES = SKIES;

  // What each condition's scene contains. Clouds: [x, y, scale, tone, face].
  function recipe(cond, day) {
    const R = { sky: 'fair', body: null, stars: 0, clouds: [], precip: null, bolt: null,
      fog: 0, haze: null, gusts: 0, leaves: 0, tornado: false, heat: false, frost: false,
      icicles: false, ink: 'light', ground: null };
    const body = (x, y, r, faceDay, faceNight, pal) => (day
      ? { kind: 'sun', x, y, r, face: faceDay, pal: pal || 'sun' }
      : { kind: 'moon', x, y, r: r * 0.95, face: faceNight || 'sleepy' });
    switch (cond) {
      case 'clear': R.sky = 'clear'; R.body = body(240, 62, 30, 'happy'); R.stars = 18; break;
      case 'few': R.sky = 'fair'; R.body = body(240, 56, 27, 'happy'); R.stars = 14;
        R.clouds = [[168, 10, 0.34, 'white'], [190, 74, 0.6, 'white', 'calm']]; break;
      case 'partly': R.sky = 'fair'; R.body = body(234, 50, 27, 'happy'); R.stars = 10;
        R.clouds = [[160, 8, 0.38, 'white'], [194, 56, 0.98, 'white', 'happy']]; break;
      case 'mostly': R.sky = 'grey'; R.body = body(262, 38, 22, 'calm'); R.stars = 4;
        R.clouds = [[160, 12, 0.56, 'light'], [176, 44, 1.12, 'light', 'calm']]; break;
      case 'cloudy': R.sky = 'grey';
        R.clouds = [[152, 8, 0.56, 'light'], [228, 16, 0.72, 'light'], [168, 46, 1.16, 'light', 'calm']]; break;
      case 'fog': R.sky = 'fog'; R.body = body(236, 54, 24, 'sleepy', 'sleepy', 'pale'); R.fog = 5; R.ink = day ? 'dark' : 'light'; break;
      case 'haze': R.sky = 'haze'; R.body = body(236, 56, 26, 'calm', 'sleepy', 'pale'); R.haze = '#fff3dc'; R.ink = day ? 'dark' : 'light'; break;
      case 'smoke': R.sky = 'smoke'; R.body = body(236, 58, 24, 'oh', 'oh', 'smoke'); R.haze = '#d9c2b0'; break;
      case 'dust': R.sky = 'dust'; R.body = body(240, 54, 24, 'oh', 'oh', 'pale'); R.gusts = 4; R.haze = '#f3dcb4'; R.ground = 'desert'; R.ink = day ? 'dark' : 'light'; break;
      case 'drizzle': R.sky = 'rain';
        R.clouds = [[156, 10, 0.58, 'light'], [180, 42, 1.12, 'grey', 'calm']];
        R.precip = { kind: 'drizzle', n: 18, x0: 188, x1: 296, y0: 96 }; break;
      case 'showers': R.sky = 'fair'; R.body = body(260, 38, 22, 'happy');
        R.clouds = [[176, 46, 1.08, 'light', 'calm']];
        R.precip = { kind: 'rain', n: 12, x0: 190, x1: 288, y0: 100 }; break;
      case 'rain': R.sky = 'rain';
        R.clouds = [[152, 8, 0.62, 'grey'], [176, 38, 1.18, 'grey', 'happy']];
        R.precip = { kind: 'rain', n: 22, x0: 184, x1: 300, y0: 98 }; R.ground = 'wet'; break;
      case 'heavy-rain': R.sky = 'storm';
        R.clouds = [[118, 0, 0.7, 'dark'], [212, 10, 0.8, 'grey'], [160, 36, 1.26, 'dark', 'happy']];
        R.precip = { kind: 'heavy', n: 30, x0: 118, x1: 320, y0: 92 }; R.ground = 'wet'; break;
      case 'freezing-rain': R.sky = 'rain';
        R.clouds = [[156, 10, 0.58, 'grey'], [178, 38, 1.15, 'grey', 'brr']];
        R.icicles = true; R.precip = { kind: 'icy', n: 16, x0: 188, x1: 296, y0: 104 }; R.ground = 'icy'; break;
      case 'mix': R.sky = 'rain';
        R.clouds = [[156, 10, 0.58, 'light'], [178, 38, 1.15, 'grey', 'brr']];
        R.precip = { kind: 'mix', n: 20, x0: 186, x1: 298, y0: 98 }; R.ground = 'snowy'; break;
      case 'flurries': R.sky = 'snow'; R.body = body(258, 38, 22, 'happy');
        R.clouds = [[176, 46, 1.08, 'snow', 'happy']];
        R.precip = { kind: 'snow', n: 12, x0: 180, x1: 300, y0: 100 }; R.ground = 'snowy'; R.ink = day ? 'dark' : 'light'; break;
      case 'snow': R.sky = 'snow';
        R.clouds = [[152, 8, 0.6, 'snow'], [174, 38, 1.16, 'snow', 'brr']];
        R.precip = { kind: 'snow', n: 28, x0: 40, x1: 320, y0: 96 }; R.ground = 'snowy'; R.ink = day ? 'dark' : 'light'; break;
      case 'heavy-snow': R.sky = 'grey';
        R.clouds = [[120, 0, 0.7, 'grey'], [168, 32, 1.22, 'grey', 'brr']];
        R.precip = { kind: 'blizzard', n: 36, x0: 30, x1: 380, y0: 70 }; R.gusts = 2; R.ground = 'snowy'; break;
      case 'hail': R.sky = 'storm';
        R.clouds = [[128, 2, 0.66, 'dark'], [168, 34, 1.2, 'dark', 'grumpy']];
        R.precip = { kind: 'hail', n: 14, x0: 176, x1: 296, y0: 96 }; break;
      case 'thunder': R.sky = 'storm';
        R.clouds = [[124, 0, 0.7, 'dark'], [214, 10, 0.78, 'dark'], [158, 34, 1.26, 'dark', 'grumpy']];
        R.bolt = { x: 226, y: 116, k: 1.45 }; R.precip = { kind: 'rain', n: 18, x0: 166, x1: 300, y0: 100 }; R.ground = 'wet'; break;
      case 'windy': R.sky = 'fair'; R.body = body(252, 44, 22, 'oh'); R.stars = 8;
        R.clouds = [[178, 64, 0.72, 'white', 'oh']]; R.gusts = 4; R.leaves = 3; break;
      case 'tornado': R.sky = 'tornado';
        R.clouds = [[70, 0, 0.92, 'dark'], [190, -2, 1.12, 'dark'], [128, 12, 1.3, 'dark', 'grumpy']];
        R.tornado = true; break;
      case 'hot': R.sky = 'hot'; R.body = body(238, 60, 32, 'sweat', 'sleepy', 'hot'); R.stars = 10; R.heat = true; R.ink = day ? 'dark' : 'light'; break;
      case 'cold': R.sky = 'cold'; R.body = body(226, 60, 25, 'brr', 'brr'); R.stars = 18; R.frost = true; R.ground = 'snowy'; R.ink = day ? 'dark' : 'light'; break;
      default: R.sky = 'fair'; R.body = body(234, 50, 27, 'happy');
    }
    if (!day) {
      R.ink = 'light';
      R.clouds = R.clouds.map((c) => [c[0], c[1], c[2], NIGHT_TONE[c[3]] || c[3], c[4]]);
    } else {
      R.stars = 0;
    }
    return R;
  }

  function seasonFor(ms, lat) {
    const m = new Date(ms).getUTCMonth() + 1;  // close enough for a season
    const mm = lat < 0 ? ((m + 5) % 12) + 1 : m;
    return mm <= 2 || mm === 12 ? 'winter' : mm <= 5 ? 'spring' : mm <= 8 ? 'summer' : 'autumn';
  }
  CORE.seasonFor = seasonFor;

  // opts = { at (ms), lat, tempC, motion (default true) }
  CORE.scene = function (cond, day, opts) {
    opts = opts || {};
    if (!RANK.hasOwnProperty(cond)) cond = 'partly';
    const motion = opts.motion !== false;
    const A = Art();
    const R = recipe(cond, day);
    const rand = rng(97 + RANK[cond]);
    const SK = SKIES[R.sky][day ? 'd' : 'n'];
    let s = '<rect width="320" height="180" fill="' + lin(A, 'sky', [[0, SK[0]], [0.58, SK[1]], [1, SK[2]]], 0, 0, 0, 1) + '"/>';

    // stars
    for (let i = 0; i < R.stars; i++) {
      const x = 8 + rand() * 304, y = 6 + rand() * 96;
      if (R.body && Math.hypot(x - R.body.x, y - R.body.y) < R.body.r * 1.9) continue;
      if (i % 3 === 0) {
        const st = sparkle(x, y, 2.2 + rand() * 2, '#fff7d1');
        s += motion ? anim('wx-twinkle', 2.4 + rand() * 2.2, -rand() * 4, st) : st;
      } else {
        s += '<circle cx="' + r2(x) + '" cy="' + r2(y) + '" r="' + r2(0.6 + rand() * 0.8) + '" fill="#fff" opacity="' + r2(0.45 + rand() * 0.5) + '"/>';
      }
    }

    // sun / moon
    if (R.body) {
      const b = R.body;
      if (b.kind === 'sun') {
        s += sun(A, b.x, b.y, b.r, { pal: b.pal, face: b.face, spin: motion,
          rays: b.pal !== 'pale' && b.pal !== 'smoke' });
      } else {
        s += moon(A, b.x, b.y, b.r, { face: b.face });
      }
    }

    // heat shimmer rises behind the land
    if (R.heat) {
      for (let i = 0; i < 6; i++) {
        const x = 20 + i * 52 + rand() * 16, y = 104 + rand() * 16;
        const w = 'M' + r2(x) + ' ' + r2(y) + ' q4 -4 0 -8 q-4 -4 0 -8';
        const p = '<path d="' + w + '" fill="none" stroke="#fff6d9" stroke-width="2" stroke-linecap="round" opacity="0.7"/>';
        s += motion ? anim('wx-rise', 2.6 + rand() * 1.4, -rand() * 3, p) : p;
      }
    }

    // ground
    let ground = R.ground;
    const season = seasonFor(opts.at || Date.now(), opts.lat || 45);
    const coldNow = Number.isFinite(opts.tempC) && opts.tempC <= 0;
    if (ground == null || ground === 'wet') ground = (season === 'winter' && coldNow) ? 'snowy' : season;
    let tint = null;
    if (!day) tint = R.fog ? { color: SK[2], amount: 0.35 } : null;
    else if (R.ground === 'wet' || R.sky === 'storm' || R.sky === 'rain') tint = { color: '#506274', amount: 0.22 };
    else if (R.fog) tint = { color: SK[2], amount: 0.5 };
    else if (R.haze) tint = { color: R.haze, amount: 0.3 };
    s += landscape(A, ground, tint, !day);

    // precipitation, behind the clouds so it falls out of them
    if (R.precip) {
      const P = R.precip;
      for (let i = 0; i < P.n; i++) {
        const x = P.x0 + rand() * (P.x1 - P.x0), y = P.y0 + rand() * 18;
        const delay = -rand() * 3, kind = P.kind === 'mix' ? (i % 2 ? 'snow' : 'rain') : P.kind;
        let el, cls, dur;
        if (kind === 'rain' || kind === 'icy') { el = drop(A, x, y, 0.62, kind === 'icy', 1.5); cls = 'wx-rain'; dur = 0.85 + rand() * 0.3; }
        else if (kind === 'heavy') { el = drop(A, x, y, 0.62, false, 1.9); cls = 'wx-rainh'; dur = 0.6 + rand() * 0.2; }
        else if (kind === 'drizzle') { el = drop(A, x, y, 0.36, false, 1.2); cls = 'wx-drz'; dur = 1.5 + rand() * 0.6; }
        else if (kind === 'hail') { el = hailBall(A, x, y, 2.6 + rand() * 1.2); cls = 'wx-hail'; dur = 1.3 + rand() * 0.4; }
        else if (kind === 'blizzard') { el = flake(x, y - rand() * 40, 2.4 + rand() * 2.2); cls = 'wx-blz'; dur = 1.6 + rand() * 0.8; }
        else { el = flake(x, y, 2.6 + rand() * 2.6); cls = 'wx-snow'; dur = 3.4 + rand() * 1.8; }
        if (!motion) {
          // spread the field through the air instead of bunching at the top
          const off = rand() * (kind === 'blizzard' ? 80 : 60);
          s += '<g transform="translate(0 ' + r2(off) + ')">' + el + '</g>';
        } else if (cls === 'wx-snow') {
          s += anim('wx-snow', dur, delay, anim('wx-sway', 1.6 + rand(), -rand() * 2, el));
        } else {
          s += anim(cls, dur, delay, el);
        }
      }
    }

    // icicles hang from the big cloud's base
    if (R.icicles && R.clouds.length) {
      const c = R.clouds[R.clouds.length - 1];
      s += icicles(A, c[0] + 14 * c[2], c[1] + 55 * c[2], 80 * c[2], 7, 1);
    }

    // tornado funnel, from the cloud deck to the ground
    if (R.tornado) {
      const g = lin(A, 'funnel', [[0, day ? '#8b8f9e' : '#4b4f60'], [1, day ? '#5f6475' : '#2c2f3c']], 0, 0, 0, 1);
      let f = '';
      const rings = 9;
      for (let i = 0; i < rings; i++) {
        const t = i / (rings - 1);
        const cy = 78 + t * 70, rx = 34 - t * 28, ry = 5.5 - t * 2.4;
        const sx = Math.sin(t * 3) * 6;
        const e = '<ellipse cx="' + r2(226 + sx) + '" cy="' + r2(cy) + '" rx="' + r2(rx) + '" ry="' + r2(ry) + '" fill="' + g
          + '" stroke="' + (day ? '#454a5a' : '#1c1f2a') + '" stroke-width="1.4"/>';
        f += motion ? anim('wx-swirl', 0.9 + t * 0.4, -t * 1.2, e) : e;
      }
      s += f;
      for (let i = 0; i < 6; i++) {
        const dx = 214 + rand() * 24, dy = 140 + rand() * 12;
        const d = '<rect x="' + r2(dx) + '" y="' + r2(dy) + '" width="3" height="2" rx="0.6" fill="' + (i % 2 ? '#7b5a3c' : '#5a4a3a') + '"/>';
        s += motion ? anim('wx-orbit', 1.4 + rand() * 0.8, -rand() * 2, d) : d;
      }
    }

    // clouds
    R.clouds.forEach((c, i) => {
      s += cloud(A, c[0], c[1], c[2], c[3], { face: c[4], anim: motion ? 'wx-drift' : null,
        dur: (R.gusts ? 5 : 11) + i * 2.5, delay: -i * 3.1 });
    });

    // lightning + sky flash
    if (R.bolt) {
      const b = bolt(A, R.bolt.x, R.bolt.y, R.bolt.k);
      s += motion ? '<g class="wx-bolt">' + b + '</g>' : b;
      if (motion) s += '<rect class="wx-flash" width="320" height="180" fill="#ffffff" opacity="0"/>';
    }

    // fog / haze bands
    if (R.fog || R.haze) {
      const n = R.fog || 3;
      for (let i = 0; i < n; i++) {
        const y = (R.fog ? 70 : 92) + i * (R.fog ? 18 : 22) + rand() * 6;
        const x = -30 + rand() * 60, w = 200 + rand() * 140;
        const band = '<rect x="' + r2(x) + '" y="' + r2(y) + '" width="' + r2(w) + '" height="' + (R.fog ? 9 : 7) + '" rx="4.5" fill="'
          + (R.fog ? (day ? '#ffffff' : '#9aa3b2') : R.haze) + '" opacity="' + (R.fog ? 0.62 : 0.5) + '"/>';
        s += motion ? anim('wx-fog', 8 + rand() * 6, -rand() * 8, band) : band;
      }
    }

    // gusts + tumbling leaves
    for (let i = 0; i < R.gusts; i++) {
      const y = 70 + i * 22 + rand() * 8, x = 18 + rand() * 120;
      const col = R.sky === 'dust' ? '#fff1d6' : '#ffffff';
      s += gust(x, y, 70 + rand() * 50, 9 + rand() * 4, col, 3, motion ? 'wx-gust' : '', 2.6 + rand(), -rand() * 2.6);
    }
    for (let i = 0; i < R.leaves; i++) {
      const colors = season === 'autumn' ? ['#ff9f43', '#e8573f', '#ffc94a'] : ['#7fcf5f', '#5fb24f', '#a3dd76'];
      const l = leaf(0, 96 + i * 18, 1.3, colors[i % 3]);
      s += motion ? anim('wx-leaf', 4 + i * 0.9, -i * 1.6, l) : '<g transform="translate(' + (70 + i * 70) + ' 0)">' + l + '</g>';
    }

    // frost in the corners for "cold"
    if (R.frost) {
      s += flake(304, 16, 9, { fill: '#ffffff', line: '#a7c6e6' }) + flake(284, 9, 5, { fill: '#ffffff', line: '#a7c6e6' })
        + flake(310, 38, 4.5, { fill: '#ffffff', line: '#a7c6e6' });
      for (let i = 0; i < 4; i++) {
        const sp = sparkle(150 + i * 40, 22 + (i % 2) * 64, 3, '#ffffff');
        s += motion ? anim('wx-twinkle', 2.2 + i * 0.5, -i, sp) : sp;
      }
    }

    return '<svg class="wx-scene' + (motion ? ' wx-anim' : '') + '" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" role="img" aria-label="'
      + CORE.condLabel(cond, day) + '" xmlns="http://www.w3.org/2000/svg">' + A.defsSvg() + s + '</svg>';
  };
  CORE.sceneInk = (cond, day) => recipe(RANK.hasOwnProperty(cond) ? cond : 'partly', day).ink;

  // ── icons: 40 x 40, static ──
  CORE.icon = function (cond, day, size) {
    if (!RANK.hasOwnProperty(cond)) cond = 'partly';
    const A = Art();
    const N = !day;
    const tone = (t) => (N ? (NIGHT_TONE[t] || t) : t);
    // ~1px outline and a face big enough to read at icon size
    const C = (x, y, s, t, f) => cloud(A, x, y, s, tone(t), { sw: 1.25 / s, face: f, faceK: 1.7 });
    const sunOr = (x, y, r, f) => (N ? moon(A, x, y, r * 1.1, { glow: false, face: f ? 'sleepy' : null })
      : sun(A, x, y, r, { glow: false, face: f ? 'happy' : null }));
    const drops = (pts, icy, k) => pts.map((p) => drop(A, p[0], p[1], k || 0.62, icy, 1.15)).join('');
    const flakes = (pts, r) => pts.map((p) => flake(p[0], p[1], r || 3.4)).join('');
    let s = '';
    switch (cond) {
      case 'clear':
        s = N ? moon(A, 20, 20, 11, { glow: false, face: 'sleepy' }) + sparkle(33, 9, 2.6, '#ffe9a0') + sparkle(8, 31, 1.8, '#ffe9a0')
          : sun(A, 20, 20, 9.5, { glow: false, face: 'happy' });
        break;
      case 'few': s = sunOr(16, 15, 8, true) + C(15, 21, 0.24, 'white'); break;
      case 'partly': s = sunOr(14, 13, 7.5, false) + C(6, 15, 0.31, 'white', 'calm'); break;
      case 'mostly': s = sunOr(28, 11.5, 5.5, false) + C(17, 7, 0.2, 'light') + C(2, 13, 0.34, 'light', 'calm'); break;
      case 'cloudy': s = C(15, 5, 0.24, 'light') + C(2, 13, 0.35, 'light', 'calm'); break;
      case 'fog': s = C(5, 3, 0.3, 'light')
        + ['M6 27 H30', 'M10 32 H34', 'M6 37 H24'].map((d) => '<path d="' + d + '" stroke="' + (N ? '#9aa6b8' : '#a9b6c4') + '" stroke-width="2.6" stroke-linecap="round"/>').join('');
        break;
      case 'haze': case 'smoke': case 'dust': {
        const pal = cond === 'smoke' ? 'smoke' : 'pale';
        const lineCol = cond === 'smoke' ? '#b59a88' : cond === 'dust' ? '#d4a865' : '#d9c29a';
        s = (N ? moon(A, 20, 15, 9, { glow: false }) : sun(A, 20, 15, 8.5, { glow: false, rays: false, pal }))
          + ['M5 28 H27', 'M12 33 H35'].map((d) => '<path d="' + d + '" stroke="' + lineCol + '" stroke-width="2.6" stroke-linecap="round"/>').join('');
        if (cond === 'dust') s += gust(4, 38, 18, 4, '#c99a58', 2, '', 0, 0);
        break;
      }
      case 'drizzle': s = C(4, 3, 0.32, 'grey') + drops([[12, 29], [20, 33], [28, 29]], false, 0.4); break;
      case 'showers': s = sunOr(28, 9, 6, false) + C(3, 8, 0.31, 'light') + drops([[14, 31], [24, 32]]); break;
      case 'rain': s = C(4, 3, 0.32, 'grey', 'happy') + drops([[11, 30], [20, 34], [29, 30]]); break;
      case 'heavy-rain': s = C(3, 2, 0.34, 'dark') + drops([[9, 29], [17, 33], [25, 29], [33, 33]], false, 0.6); break;
      case 'freezing-rain': s = C(4, 3, 0.32, 'grey') + icicles(A, 9, 20.5, 22, 4, 0.55) + drops([[13, 32], [26, 32]], true); break;
      case 'mix': s = C(4, 3, 0.32, 'grey') + drop(A, 11, 31, 0.6, false, 1.15) + flake(20, 33, 3.4) + drop(A, 29, 31, 0.6, false, 1.15); break;
      case 'flurries': s = sunOr(28, 9, 6, false) + C(3, 8, 0.31, 'snow') + flakes([[13, 32], [24, 33]]); break;
      case 'snow': s = C(4, 3, 0.32, 'snow', 'brr') + flakes([[11, 30], [20, 34], [29, 30]]); break;
      case 'heavy-snow': s = C(3, 2, 0.34, 'grey') + flakes([[9, 29], [18, 34], [27, 29], [33, 35]], 3.2); break;
      case 'hail': s = C(4, 3, 0.32, 'dark') + hailBall(A, 12, 31, 2.6) + hailBall(A, 21, 35, 2.6) + hailBall(A, 29, 30, 2.6); break;
      case 'thunder': s = C(3, 2, 0.34, 'dark', 'grumpy') + bolt(A, 20, 29, 0.62) + drop(A, 9, 31, 0.5, false, 1.1) + drop(A, 32, 31, 0.5, false, 1.1); break;
      case 'windy':
        s = gust(4, 15, 20, 5, N ? '#b9c4dc' : '#7fa6c9', 2.6, '', 0, 0) + gust(9, 25, 22, 5, N ? '#b9c4dc' : '#7fa6c9', 2.6, '', 0, 0)
          + gust(4, 35, 14, 4, N ? '#b9c4dc' : '#7fa6c9', 2.6, '', 0, 0);
        break;
      case 'tornado': {
        const g = lin(A, 'tf', [[0, '#9a9fae'], [1, '#626778']], 0, 0, 0, 1);
        for (let i = 0; i < 6; i++) {
          const t = i / 5;
          s += '<ellipse cx="' + r2(20 + Math.sin(t * 3) * 2.5) + '" cy="' + r2(8 + t * 26) + '" rx="' + r2(15 - t * 12) + '" ry="' + r2(3 - t * 1.2)
            + '" fill="' + g + '" stroke="#474c5c" stroke-width="1"/>';
        }
        break;
      }
      case 'hot': s = N ? moon(A, 20, 20, 11, { glow: false }) : sun(A, 20, 20, 10, { glow: false, pal: 'hot', face: 'sweat' }); break;
      case 'cold': s = flake(20, 20, 13, { fill: '#ffffff', line: N ? '#8fb0dd' : '#6fa3dc' }) + sparkle(33, 8, 2.4, '#bfe3ff') + sparkle(7, 33, 2, '#bfe3ff'); break;
    }
    const px = size || 32;
    return '<svg class="wx-icon" width="' + px + '" height="' + px + '" viewBox="0 0 40 40" role="img" aria-label="'
      + CORE.condLabel(cond, day) + '" xmlns="http://www.w3.org/2000/svg">' + A.defsSvg() + s + '</svg>';
  };

  global.WeatherCore = CORE;

  if (typeof document === 'undefined' || typeof global.ExtrasRegisterTool !== 'function') return;

  // ════════════════════════════════════════════════════════════════════
  // UI
  // ════════════════════════════════════════════════════════════════════
  const RT = global.ExtrasRegisterTool;
  const U = global.ExtrasUtil || {};
  const STORE = 'cc.weather.v1';
  const PREFS = 'cc.weather.prefs.v1';

  const style = document.createElement('style');
  style.textContent = `
  .wx [hidden] { display: none !important; }
  .wx-hero {
    position: relative; overflow: hidden;
    border-radius: 18px; height: 0; padding-top: 56.25%;
    box-shadow: var(--ui-shadow);
    background: #8dcbf7;
  }
  .wx-hero .wx-scene { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .wx-hero-text { position: absolute; left: 14px; top: 10px; right: 45%; line-height: 1.15; pointer-events: none; }
  .wx-ink-light { color: #ffffff; text-shadow: 0 1px 3px rgba(10, 20, 40, 0.45); }
  .wx-ink-dark { color: #17202c; text-shadow: 0 1px 2px rgba(255, 255, 255, 0.55); }
  .wx-temp { font-size: 46px; font-weight: 700; letter-spacing: -1px; font-variant-numeric: tabular-nums; }
  .wx-temp .wx-unit { font-size: 20px; font-weight: 600; vertical-align: top; position: relative; top: 7px; margin-left: 1px; }
  .wx-cond { font-size: 15px; font-weight: 650; margin-top: 2px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .wx-sub { font-size: 12.5px; margin-top: 3px; opacity: 0.95; }
  .wx-hero-place {
    position: absolute; left: 10px; bottom: 9px; max-width: calc(100% - 112px);
    padding: 3px 9px; border-radius: 999px;
    background: rgba(12, 18, 32, 0.38); color: #fff;
    font-size: 11.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .wx-hero-place:empty { display: none; }
  /* °C / °F toggle, the place pill's twin in the other corner */
  .wx .wx-units {
    position: absolute; right: 10px; bottom: 8px; display: flex; gap: 2px;
    padding: 2px; border-radius: 999px; background: rgba(12, 18, 32, 0.38);
  }
  .wx .wx-units button {
    min-width: 36px; margin: 0; padding: 5px 10px; border: 0; border-radius: 999px;
    background: transparent; color: rgba(255, 255, 255, 0.82); box-shadow: none;
    font-family: inherit; font-size: 12px; font-weight: 650; line-height: 1; cursor: pointer;
  }
  .wx .wx-units button[aria-pressed="true"] { background: #ffffff; color: #17202c; }
  .wx .wx-units button:focus-visible { outline: 2px solid #ffffff; outline-offset: 1px; }
  .wx-alerts { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  .wx-alerts:empty { display: none; }
  .wx-alert {
    display: block; width: 100%; text-align: left; cursor: pointer;
    padding: 8px 11px; border-radius: 12px; border: none;
    font-family: inherit; font-size: 13px; font-weight: 650; line-height: 1.3;
    color: #2b1d00; background: #ffd34d;
  }
  .wx-alert.red { background: #e5484d; color: #fff; }
  .wx-alert.orange { background: #f5a03c; color: #2b1400; }
  .wx-alert.grey { background: var(--ui-hover); color: var(--ui-text); }
  .wx-alert .wx-alert-sub { display: block; font-weight: 500; font-size: 12px; opacity: 0.9; margin-top: 2px; }
  .wx-alert .wx-alert-body { display: block; font-weight: 450; font-size: 12.5px; margin-top: 6px; white-space: pre-wrap; }
  .wx-controls { margin-top: 12px; }
  .wx-locs { display: flex; gap: 8px; justify-content: center; margin-bottom: 9px; }
  .wx-locs .xt-chip[disabled] { opacity: 0.45; cursor: default; }
  .wx-load {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%; padding: 11px 12px;
    font-family: inherit; font-size: 15px; font-weight: 650;
    color: var(--ui-accent-text); background: var(--ui-accent);
    border: 1px solid var(--ui-accent-border); border-radius: 14px;
    cursor: pointer;
  }
  .wx-load:disabled { opacity: 0.7; cursor: progress; }
  .wx-load .wx-load-sub { font-size: 12px; font-weight: 500; opacity: 0.85; }
  .wx-status { margin-top: 7px; text-align: center; font-size: 12px; color: var(--ui-muted); line-height: 1.4; min-height: 1.4em; }
  .wx-status.err { color: var(--ui-danger, #d33); }
  .wx-status.stale { color: var(--ui-text); }
  .wx-hours {
    display: flex; gap: 4px; overflow-x: auto; overscroll-behavior-x: contain;
    padding: 6px 2px 8px; margin: 0 -2px;
    scrollbar-width: thin; scrollbar-color: rgba(127, 127, 127, 0.35) transparent;
  }
  .wx-hours::-webkit-scrollbar { height: 4px; }
  .wx-hours::-webkit-scrollbar-thumb { background: rgba(127, 127, 127, 0.35); border-radius: 2px; }
  .wx-hour {
    flex: 0 0 auto; width: 50px; padding: 7px 2px 6px; border-radius: 14px;
    background: var(--ui-hover); text-align: center;
    display: flex; flex-direction: column; align-items: center; gap: 2px;
  }
  .wx-hour.now { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
  .wx-h-t { font-size: 11px; color: var(--ui-muted); white-space: nowrap; }
  .wx-h-temp { font-size: 14px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .wx-pop { font-size: 11px; font-weight: 600; color: #2f7ed8; font-variant-numeric: tabular-nums; }
  html[data-ui-dark="1"] .wx-pop { color: #7cb9ff; }
  .wx-pop.zero { visibility: hidden; }
  /* the week: one column per day; the high/low bar sits on a scale shared
     by the whole week, with its labels riding on the bar's ends */
  .wx-week { display: grid; gap: 2px; margin-top: 2px; }
  .wx-wd {
    display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0;
    margin: 0; padding: 6px 0 2px; border: 0; border-radius: 12px; background: none; box-shadow: none;
    color: var(--ui-text); font-family: inherit; cursor: pointer;
  }
  .wx-wd[aria-pressed="true"] { background: var(--ui-hover); }
  .wx-wd:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
  .wx-wd-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; font-weight: 650; }
  .wx-wd .wx-pop { line-height: 13px; }
  .wx-wd-range { position: relative; width: 100%; height: 86px; }
  .wx-wd-track { position: absolute; left: 50%; top: 15px; bottom: 15px; width: 6px; margin-left: -3px; border-radius: 3px; }
  .wx-wd-track i { position: absolute; left: 0; right: 0; border-radius: 3px; }
  .wx-wd-hi, .wx-wd-lo { position: absolute; left: 0; right: 0; text-align: center; font-size: 12.5px; line-height: 13px; font-variant-numeric: tabular-nums; }
  .wx-wd-hi { font-weight: 700; }
  .wx-wd-lo { color: var(--ui-muted); }
  .wx-week-text { margin-top: 6px; padding: 9px 11px; border-radius: 12px; background: var(--ui-hover); font-size: 12.5px; line-height: 1.45; }
  .wx-week-text b { font-weight: 650; }
  .wx-sub-hint { font-weight: 500; letter-spacing: 0; text-transform: none; }
  .wx-details { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .wx-det { background: var(--ui-hover); border-radius: 12px; padding: 8px 10px; }
  .wx-det span { display: block; font-size: 11px; color: var(--ui-muted); }
  .wx-det b { display: block; font-size: 15px; font-weight: 650; margin-top: 1px; font-variant-numeric: tabular-nums; }
  /* next 2 hours, best walk, air & sun */
  .wx-card { background: var(--ui-hover); border-radius: 14px; padding: 10px 12px; }
  .wx-nc-text { font-size: 14px; font-weight: 650; margin-bottom: 8px; }
  .wx-nc.dry { display: flex; align-items: center; gap: 10px; }
  .wx-nc.dry .wx-nc-text { margin: 0; }
  .wx-nc-bars { display: block; width: 100%; height: auto; }
  .wx-nc-zero { fill: currentColor; opacity: 0.2; }
  .wx-nc-ticks { display: flex; justify-content: space-between; margin-top: 4px; font-size: 10.5px; color: var(--ui-muted); }
  .wx-walk { display: flex; align-items: center; gap: 12px; }
  .wx-walk-main { flex: 1; min-width: 0; }
  .wx-walk-time { display: flex; align-items: center; justify-content: space-between; gap: 8px;
    font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .wx-walk-q { flex: 0 0 auto; padding: 3px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 700; color: #ffffff; }
  .wx-walk-q.q-great { background: #2a9d5c; }
  .wx-walk-q.q-good { background: #2a8fa3; }
  .wx-walk-q.q-okay { background: #c98a00; }
  .wx-walk-q.q-poor { background: #7d8796; }
  .wx-walk-why { margin-top: 3px; font-size: 12.5px; line-height: 1.4; color: var(--ui-muted); }
  .wx-walk-note { margin-top: 4px; font-size: 12px; }
  .wx-airsun { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .wx-gauge { min-width: 0; padding: 9px 10px; border-radius: 12px; background: var(--ui-hover); }
  .wx-g-title, .wx-g-sub { display: block; font-size: 11px; line-height: 1.35; color: var(--ui-muted); }
  .wx-g-val { display: flex; align-items: baseline; gap: 6px; margin-top: 2px; }
  .wx-g-val b { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .wx-g-val span { display: inline-flex; align-items: center; gap: 4px; min-width: 0; font-size: 12px; font-weight: 650; }
  .wx-g-val span i { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; }
  .wx-g-scale { position: relative; height: 6px; margin: 8px 6px 6px; border-radius: 3px; }
  .wx-g-scale i { position: absolute; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 -6px; box-sizing: border-box;
    border-radius: 50%; background: #ffffff; border: 2px solid #1d2633; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3); }
  .wx-g-aqhi { background: linear-gradient(90deg, #6fc6f2 0%, #3d8fe0 20%, #f2c40f 30%, #f08a24 50%, #e5484d 60%, #c0303c 90%, #8e1b3c 100%); }
  .wx-g-usaqi { background: linear-gradient(90deg, #2fb36b 0%, #2fb36b 12%, #e8b400 28%, #f08a24 45%, #e5484d 62%, #8b4fc7 82%, #7e1f3a 100%); }
  .wx-g-uv { background: linear-gradient(90deg, #2fb36b 0%, #2fb36b 14%, #e8b400 30%, #f08a24 55%, #e5484d 75%, #8b4fc7 100%); }
  .wx-attrib { margin-top: 12px; font-size: 11px; color: var(--ui-muted); text-align: center; line-height: 1.45; }
  .wx-empty { margin-top: 12px; font-size: 13px; color: var(--ui-muted); text-align: center; line-height: 1.5; }
  .wx-icon { display: block; flex: 0 0 auto; }

  /* scene motion — scoped to .wx-anim, off for reduced motion */
  .wx-anim .wx-spin { transform-box: fill-box; transform-origin: center; animation: wx-spin 48s linear infinite; }
  .wx-anim .wx-drift { animation: wx-drift 12s ease-in-out infinite alternate; }
  .wx-anim .wx-twinkle { transform-box: fill-box; transform-origin: center; animation: wx-twinkle 3s ease-in-out infinite; }
  .wx-anim .wx-rain { animation: wx-rain 1s linear infinite; }
  .wx-anim .wx-rainh { animation: wx-rainh 0.7s linear infinite; }
  .wx-anim .wx-drz { animation: wx-drz 1.8s linear infinite; }
  .wx-anim .wx-snow { animation: wx-snow 4s linear infinite; }
  .wx-anim .wx-sway { animation: wx-sway 2s ease-in-out infinite alternate; }
  .wx-anim .wx-blz { animation: wx-blz 2s linear infinite; }
  .wx-anim .wx-hail { animation: wx-hail 1.5s cubic-bezier(0.45, 0, 1, 1) infinite; }
  .wx-anim .wx-bolt { animation: wx-bolt 6s linear infinite; }
  .wx-anim .wx-flash { animation: wx-flash 6s linear infinite; }
  .wx-anim .wx-fog { animation: wx-fog 10s ease-in-out infinite alternate; }
  .wx-anim .wx-gust { stroke-dasharray: 34 200; animation: wx-gust 3s ease-in-out infinite; }
  .wx-anim .wx-rise { animation: wx-rise 3s ease-in infinite; }
  .wx-anim .wx-leaf { animation: wx-leaf 4.5s linear infinite; }
  .wx-anim .wx-leafspin { transform-box: fill-box; transform-origin: center; animation: wx-spin 1.6s linear infinite; }
  .wx-anim .wx-swirl { animation: wx-swirl 1s ease-in-out infinite alternate; }
  .wx-anim .wx-orbit { animation: wx-orbit 1.6s linear infinite; }
  @keyframes wx-spin { to { transform: rotate(360deg); } }
  @keyframes wx-drift { from { transform: translateX(-5px); } to { transform: translateX(7px); } }
  @keyframes wx-twinkle { 0%, 100% { opacity: 0.35; transform: scale(0.7); } 50% { opacity: 1; transform: scale(1.1); } }
  @keyframes wx-rain { 0% { transform: translate(0, 0); opacity: 0; } 12% { opacity: 1; } 85% { opacity: 1; } 100% { transform: translate(-7px, 84px); opacity: 0; } }
  @keyframes wx-rainh { 0% { transform: translate(0, 0); opacity: 0; } 10% { opacity: 1; } 88% { opacity: 1; } 100% { transform: translate(-16px, 98px); opacity: 0; } }
  @keyframes wx-drz { 0% { transform: translate(0, 0); opacity: 0; } 15% { opacity: 0.9; } 85% { opacity: 0.9; } 100% { transform: translate(-3px, 66px); opacity: 0; } }
  @keyframes wx-snow { 0% { transform: translateY(0); opacity: 0; } 12% { opacity: 1; } 88% { opacity: 1; } 100% { transform: translateY(86px); opacity: 0; } }
  @keyframes wx-sway { from { transform: translateX(-5px); } to { transform: translateX(5px); } }
  @keyframes wx-blz { 0% { transform: translate(0, 0); opacity: 0; } 10% { opacity: 1; } 90% { opacity: 1; } 100% { transform: translate(-90px, 120px); opacity: 0; } }
  @keyframes wx-hail { 0% { transform: translateY(0); opacity: 0; } 8% { opacity: 1; } 74% { transform: translateY(74px); } 84% { transform: translateY(64px); } 94% { transform: translateY(74px); opacity: 1; } 100% { transform: translateY(74px); opacity: 0; } }
  @keyframes wx-bolt { 0%, 74% { opacity: 0; } 75% { opacity: 1; } 77% { opacity: 0.15; } 79% { opacity: 1; } 86%, 100% { opacity: 0; } }
  @keyframes wx-flash { 0%, 74% { opacity: 0; } 75% { opacity: 0.32; } 77% { opacity: 0.04; } 79% { opacity: 0.26; } 88%, 100% { opacity: 0; } }
  @keyframes wx-fog { from { transform: translateX(-16px); } to { transform: translateX(16px); } }
  @keyframes wx-gust { 0% { stroke-dashoffset: 34; } 100% { stroke-dashoffset: -100; } }
  @keyframes wx-rise { 0% { transform: translateY(6px); opacity: 0; } 30% { opacity: 0.75; } 100% { transform: translateY(-20px); opacity: 0; } }
  @keyframes wx-leaf { 0% { transform: translate(-20px, 0); opacity: 0; } 8% { opacity: 1; } 50% { transform: translate(160px, 16px); } 92% { opacity: 1; } 100% { transform: translate(340px, -8px); opacity: 0; } }
  @keyframes wx-swirl { from { transform: translateX(-5px); } to { transform: translateX(5px); } }
  @keyframes wx-orbit { 0% { transform: translate(-16px, 2px); } 25% { transform: translate(0, 6px); } 50% { transform: translate(16px, 0); } 75% { transform: translate(0, -5px); } 100% { transform: translate(-16px, 2px); } }
  @media (prefers-reduced-motion: reduce) { .wx-anim, .wx-anim * { animation: none !important; } }
  `;
  document.head.appendChild(style);

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const imperial = () => localStorage.getItem('cc.units') === 'mi';
  const motionOK = () => !(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const tempUnit = () => CORE.tempUnit(readPrefs().temp, localStorage.getItem('cc.units'));
  const tempStr = (c) => (Number.isFinite(c) ? Math.round(CORE.tempIn(c, tempUnit())) + '°' : '—');
  const windStr = (kph) => (Number.isFinite(kph) ? (imperial() ? Math.round(kph / 1.609344) + ' mph' : Math.round(kph) + ' km/h') : '—');
  const pressStr = (hPa) => (Number.isFinite(hPa) ? (imperial() ? (hPa * 0.02953).toFixed(2) + ' inHg' : Math.round(hPa) + ' hPa') : '—');
  const clock12 = () => (U.clock12 ? U.clock12() : (localStorage.getItem('cc.clockFormat') || '24h') === '12h');
  function fmtHour(ms, tz) {
    try {
      return new Intl.DateTimeFormat(undefined, clock12()
        ? { timeZone: tz, hour: 'numeric', hour12: true }
        : { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
    } catch (_) { return new Date(ms).getHours() + 'h'; }
  }
  function fmtClock(ms, tz) {
    try {
      return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: clock12() }).format(ms);
    } catch (_) { return new Date(ms).toTimeString().slice(0, 5); }
  }
  function ago(ms) {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 36) return h + ' h ago';
    return Math.round(h / 24) + ' days ago';
  }
  // Blue (cold) -> green -> yellow -> red (hot) for the day range bars.
  function tempColor(c) {
    const t = Math.max(0, Math.min(1, (c + 20) / 55));
    const stops = [[0, '#5b8cff'], [0.35, '#4cc3d9'], [0.55, '#8fd16a'], [0.72, '#ffd24d'], [0.86, '#ff9a3c'], [1, '#ff5a4f']];
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const a = stops[i - 1], b = stops[i];
        return mix(a[1], b[1], (t - a[0]) / (b[0] - a[0]));
      }
    }
    return stops[stops.length - 1][1];
  }

  function readStore() {
    try {
      const m = JSON.parse(localStorage.getItem(STORE) || 'null');
      return m && m.v === 1 && Array.isArray(m.hours) ? m : null;
    } catch (_) { return null; }
  }
  function writeStore(m) { try { localStorage.setItem(STORE, JSON.stringify(m)); } catch (_) { /* full */ } }
  function readPrefs() { try { return JSON.parse(localStorage.getItem(PREFS) || '{}') || {}; } catch (_) { return {}; } }
  function writePrefs(p) { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch (_) { /* ignore */ } }

  // Location sources: the app's ONE shared GPS watch (never a second one),
  // or the map centre from the URL hash. Neither prompts or fetches.
  function gpsLoc() {
    const f = global._ccLatestFix, c = f && f.coords;
    if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return null;
    return { lat: c.latitude, lon: c.longitude };
  }
  const mapLoc = () => (U.getMapLoc ? U.getMapLoc() : null);
  function placeName(m) {
    if (m.place) return m.place;
    try {
      const api = global.CreatureCollectAPI;
      const p = api && api.findNearestPlace ? api.findNearestPlace(m.lat, m.lon) : null;
      if (p && (p.city || p.country)) return [p.city, p.country].filter(Boolean).join(', ');
    } catch (_) { /* ignore */ }
    return Math.abs(m.lat).toFixed(2) + '°' + (m.lat >= 0 ? 'N' : 'S') + ' ' + Math.abs(m.lon).toFixed(2) + '°' + (m.lon >= 0 ? 'E' : 'W');
  }

  // The row to treat as "now": the observation while it's fresh, else the
  // forecast hour we're in (a cached forecast keeps working offline).
  function currentFor(m, nowMs) {
    if (m.now && m.now.observed && nowMs - (m.now.t || m.fetchedAt) < 90 * 60000) return m.now;
    const h = (m.hours || []).find((x) => nowMs >= x.t - 30 * 60000 && nowMs < x.t + 30 * 60000);
    if (h) return Object.assign({}, m.now || {}, h, { feelsC: CORE.feelsLike(h.tempC, (m.now || {}).rh, h.windKph != null ? h.windKph : (m.now || {}).windKph), observed: false });
    return m.now;
  }

  function buildWeather(view) {
    view.innerHTML = '<div class="wx">'
      + '<div class="wx-hero"></div>'
      + '<div class="wx-alerts"></div>'
      + '<div class="wx-controls">'
      + '<div class="wx-locs" role="group" aria-label="Forecast for">'
      + '<button type="button" class="xt-chip" data-loc="gps">&#128205; My location</button>'
      + '<button type="button" class="xt-chip" data-loc="map">&#128506;&#65039; Map centre</button>'
      + '</div>'
      + '<button type="button" class="wx-load">Load forecast <span class="wx-load-sub">(uses data)</span></button>'
      + '<div class="wx-status" role="status" aria-live="polite"></div>'
      + '</div>'
      + '<div class="wx-body"></div>'
      + '</div>';
    const $ = (sel) => view.querySelector(sel);
    const hero = $('.wx-hero'), alertsEl = $('.wx-alerts'), body = $('.wx-body');
    const loadBtn = $('.wx-load'), statusEl = $('.wx-status');
    const chips = Array.from(view.querySelectorAll('.wx-locs .xt-chip'));
    let model = readStore();
    let busy = false;
    let note = null;  // one-off { text, err } (errors, fallbacks) shown as the status

    function chosenSource() {
      const pref = readPrefs().loc;
      if (pref === 'map') return 'map';
      return gpsLoc() ? 'gps' : 'map';
    }
    // Where to load for: the chosen source, else whichever exists, else the
    // last forecast's spot (the desktop workbench has no map or GPS).
    function chosenLoc() {
      const src = chosenSource();
      return (src === 'gps' ? gpsLoc() : mapLoc()) || gpsLoc() || mapLoc()
        || (model ? { lat: model.lat, lon: model.lon } : null);
    }
    function syncChips() {
      const src = chosenSource(), hasGps = !!gpsLoc();
      for (const c of chips) {
        c.classList.toggle('active', c.dataset.loc === src);
        c.disabled = c.dataset.loc === 'gps' && !hasGps;
        c.title = c.disabled ? 'No GPS fix yet' : '';
      }
    }
    chips.forEach((c) => c.addEventListener('click', () => {
      if (c.disabled) return;
      const p = readPrefs(); p.loc = c.dataset.loc; writePrefs(p);
      syncChips();
    }));
    // °C / °F pill (re-drawn with the hero, so listen on the hero itself)
    hero.addEventListener('click', (e) => {
      const b = e.target.closest('.wx-units button');
      if (!b || b.getAttribute('aria-pressed') === 'true') return;
      const p = readPrefs(); p.temp = b.dataset.u; writePrefs(p);
      render();
    });

    function renderStatus() {
      statusEl.className = 'wx-status';
      if (busy) { statusEl.textContent = 'Loading the forecast…'; return; }
      if (note) { statusEl.textContent = note.text; if (note.err) statusEl.classList.add('err'); return; }
      if (!model) { statusEl.textContent = 'Nothing downloads until you tap Load.'; return; }
      const age = Date.now() - model.fetchedAt;
      statusEl.textContent = 'Loaded ' + ago(model.fetchedAt) + (age > 6 * 3600000 ? ' — tap Load for a fresh one' : '');
      if (age > 6 * 3600000) statusEl.classList.add('stale');
    }

    function renderHero() {
      const nowMs = Date.now();
      let cond = 'partly', day, ink, html, place = '';
      const loc = model ? { lat: model.lat, lon: model.lon } : (gpsLoc() || mapLoc());
      day = loc ? CORE.isDay(nowMs, loc.lat, loc.lon) : (new Date().getHours() >= 7 && new Date().getHours() < 19);
      if (model) {
        const cur = currentFor(model, nowMs) || {};
        cond = cur.cond || 'partly';
        const today = model.days.find((d) => d.key === CORE.dayKey(nowMs, model.tz));
        const hl = today ? [today.hiC != null ? 'H ' + tempStr(today.hiC) : '', today.loC != null ? 'L ' + tempStr(today.loC) : ''].filter(Boolean).join('  ') : '';
        const feels = Number.isFinite(cur.feelsC) && Math.round(cur.feelsC) !== Math.round(cur.tempC) ? 'Feels like ' + tempStr(cur.feelsC) : '';
        const unit = tempUnit();
        html = '<div class="wx-temp">' + (Number.isFinite(cur.tempC) ? Math.round(CORE.tempIn(cur.tempC, unit)) : '—')
          + '<span class="wx-unit">°' + unit.toUpperCase() + '</span></div>'
          + '<div class="wx-cond">' + esc(cur.text || CORE.condLabel(cond, day)) + '</div>'
          + '<div class="wx-sub">' + esc([feels, hl].filter(Boolean).join(' · ')) + '</div>';
        place = '&#128205; ' + esc(placeName(model));
        ink = CORE.sceneInk(cond, day);
        hero.innerHTML = CORE.scene(cond, day, { at: nowMs, lat: model.lat, tempC: cur.tempC, motion: motionOK() })
          + '<div class="wx-hero-text wx-ink-' + ink + '">' + html + '</div><div class="wx-hero-place">' + place + '</div>'
          + '<div class="wx-units" role="group" aria-label="Temperature unit">'
          + ['c', 'f'].map((u) => '<button type="button" data-u="' + u + '" aria-pressed="' + (u === unit) + '">°' + u.toUpperCase() + '</button>').join('')
          + '</div>';
      } else {
        ink = CORE.sceneInk(cond, day);
        hero.innerHTML = CORE.scene(cond, day, { at: nowMs, lat: loc ? loc.lat : 45, motion: motionOK() })
          + '<div class="wx-hero-text wx-ink-' + ink + '"><div class="wx-cond" style="font-size:20px">Weather</div>'
          + '<div class="wx-sub">Tap Load for the forecast where you are.</div></div><div class="wx-hero-place"></div>';
      }
    }

    function renderAlerts() {
      const now = Date.now();
      const list = model ? (model.alerts || []).filter((a) => !a.expires || a.expires > now) : [];
      alertsEl.innerHTML = list.map((a, i) => '<button type="button" class="wx-alert ' + esc(a.level) + '" data-i="' + i + '" aria-expanded="false">&#9888;&#65039; '
        + esc(a.title) + (a.expires ? '<span class="wx-alert-sub">until ' + esc(fmtClock(a.expires, model.tz)) + '</span>' : '')
        + (a.text ? '<span class="wx-alert-body" hidden>' + esc(a.text) + '</span>' : '') + '</button>').join('');
      alertsEl.querySelectorAll('.wx-alert').forEach((b) => b.addEventListener('click', () => {
        const bodyEl = b.querySelector('.wx-alert-body');
        if (!bodyEl) return;
        bodyEl.hidden = !bodyEl.hidden;
        b.setAttribute('aria-expanded', String(!bodyEl.hidden));
      }));
    }

    // "Next 2 hours": a sentence + eight 15-minute bars.
    function nowcastHtml(nc, tz) {
      const word = { rain: 'rain', snow: 'snow', mix: 'rain and snow' }[nc.kind];
      const strong = (nc.intensity === 'light' ? 'Light ' : nc.intensity === 'heavy' ? 'Heavy ' : '') + word;
      const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
      const text = nc.state === 'dry' ? 'No rain or snow for the next 2 hours'
        : nc.state === 'all' ? cap(strong) + ' for the next 2 hours'
          : nc.state === 'starting' ? cap(strong) + ' starting around ' + fmtClock(nc.at, tz)
            : cap(word) + ' stopping around ' + fmtClock(nc.at, tz);
      const W = 280, H = 44, gap = 6, n = nc.steps.length, bw = (W - gap * (n - 1)) / n;
      let bars = '';
      nc.steps.forEach((st, i) => {
        const x = r2(i * (bw + gap));
        const v = Math.max(st.mm, st.snowCm * 0.7);
        const snow = st.snowCm > 0 && st.snowCm * 0.7 >= st.mm * 0.5;
        if (v < 0.05) {
          bars += '<rect class="wx-nc-zero" x="' + x + '" y="' + (H - 3) + '" width="' + r2(bw) + '" height="3" rx="1.5"/>';
        } else {
          const bh = r2(Math.max(6, Math.min(1, Math.sqrt(v / 2)) * (H - 2)));
          bars += '<rect x="' + x + '" y="' + r2(H - bh) + '" width="' + r2(bw) + '" height="' + bh + '" rx="4" fill="'
            + (snow ? '#e8f1ff' : '#4aa2ef') + '" stroke="' + (snow ? '#8fa6c8' : '#2f7ec6') + '" stroke-width="1.2"/>';
        }
      });
      // A dry forecast is just the sentence; an empty chart says nothing more.
      if (nc.state === 'dry') {
        return '<div class="xt-subhead">Next 2 hours</div><div class="wx-card wx-nc dry">'
          + CORE.icon('few', true, 28) + '<div class="wx-nc-text">' + esc(text) + '</div></div>';
      }
      return '<div class="xt-subhead">Next 2 hours</div><div class="wx-card wx-nc">'
        + '<div class="wx-nc-text">' + esc(text) + '</div>'
        + '<svg class="wx-nc-bars" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(text) + '">' + bars + '</svg>'
        + '<div class="wx-nc-ticks"><span>Now</span><span>30 min</span><span>1 h</span><span>1½ h</span><span>2 h</span></div></div>';
    }

    // "Best time for a walk": the window, how good it is, and why.
    function walkHtml(w, tz) {
      const onHour = (w.end - w.start) % 3600000 === 0;  // else it starts when rain stops
      const range = (w.startsNow ? 'Now' : onHour ? fmtHour(w.start, tz) : fmtClock(w.start, tz)) + ' – ' + fmtHour(w.end, tz);
      const why = [];
      if (w.popMax != null && w.popMax >= 40) why.push((['flurries', 'snow', 'heavy-snow'].includes(w.cond) ? 'Snow' : 'Rain') + ' likely (' + Math.round(w.popMax) + '%)');
      else if (w.popMax != null && w.popMax >= 20) why.push('Small chance of rain (' + Math.round(w.popMax) + '%)');
      else if (!w.wetCond) why.push('Dry');
      else why.push(CORE.condLabel(w.cond, true));
      if (w.tMin != null) why.push(Math.round(CORE.tempIn(w.tMin, tempUnit())) === Math.round(CORE.tempIn(w.tMax, tempUnit()))
        ? tempStr(w.tMin) : tempStr(w.tMin).replace('°', '') + '–' + tempStr(w.tMax));
      if (w.windMax != null) why.push(w.windMax >= 30 ? 'Windy (' + windStr(w.windMax) + ')' : w.windMax >= 20 ? 'Breezy' : 'Light wind');
      if (w.air) why.push('Air: ' + w.air.label.toLowerCase());
      if (w.uvMax != null && w.uvMax >= 6) why.push('UV ' + Math.round(w.uvMax) + ', wear sunscreen');
      const q = { great: 'Great', good: 'Good', okay: 'Okay', poor: 'Not great' }[w.quality];
      return '<div class="xt-subhead">Best time for a walk' + (w.tomorrow ? ' tomorrow' : '') + '</div>'
        + '<div class="wx-card wx-walk">' + CORE.icon(w.cond || 'partly', true, 42)
        + '<div class="wx-walk-main"><div class="wx-walk-time"><span>' + esc(range) + '</span>'
        + '<span class="wx-walk-q q-' + w.quality + '">' + q + '</span></div>'
        + '<div class="wx-walk-why">' + esc(why.join(' · ')) + '</div>'
        + (w.quality === 'poor' ? '<div class="wx-walk-note">' + (w.tomorrow ? 'Tomorrow' : 'Today') + ' isn’t a great day for it — this is the best of it.</div>' : '')
        + '</div></div>';
    }

    // The week at a glance: a column per day (name, icon, rain chance, and a
    // high/low bar on one temperature scale for the whole week), so it fits
    // the width with no scrolling and the trend reads at a glance. The words
    // stay one tap away.
    function weekHtml(days, todayKey) {
      let lo = Infinity, hi = -Infinity;
      for (const d of days) for (const v of [d.loC, d.hiC]) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      if (!(hi > lo)) hi = lo + 1;
      const TRACK = 56, PAD = 15;  // px: bar track, room above/below for labels
      const yOf = (v) => PAD + (1 - (v - lo) / (hi - lo)) * TRACK;  // top of the track = warmest
      let cols = '';
      days.forEach((d, i) => {
        const name = weekdayName(d, todayKey);
        const hasHi = Number.isFinite(d.hiC), hasLo = Number.isFinite(d.loC);
        const a = hasLo ? d.loC : d.hiC, b = hasHi ? d.hiC : d.loC;
        let range = '';
        if (Number.isFinite(a) && Number.isFinite(b)) {
          let top = yOf(b), bot = yOf(a);
          if (bot - top < 6) { const mid = (top + bot) / 2; top = mid - 3; bot = mid + 3; }  // a single temperature is a dot
          range = '<span class="wx-wd-track"><i style="top:' + r2(top - PAD) + 'px;bottom:' + r2(PAD + TRACK - bot) + 'px;background:linear-gradient(0deg,'
            + tempColor(a) + ',' + tempColor(b) + ')"></i></span>'
            + (hasHi ? '<span class="wx-wd-hi" style="top:' + r2(top - 14) + 'px">' + tempStr(d.hiC) + '</span>' : '')
            + (hasLo ? '<span class="wx-wd-lo" style="top:' + r2(bot + 2) + 'px">' + tempStr(d.loC) + '</span>' : '');
        }
        const pop = Number.isFinite(d.pop) && d.pop >= 10 ? Math.round(d.pop) + '%' : '0%';
        cols += '<button type="button" class="wx-wd" data-i="' + i + '" aria-pressed="false" aria-label="'
          + esc(name + ': ' + (d.text || CORE.condLabel(d.cond, true))) + '">'
          + '<span class="wx-wd-name">' + esc(name) + '</span>'
          + CORE.icon(d.cond || 'partly', !d.onlyNight, 30)
          + '<span class="wx-pop' + (pop === '0%' ? ' zero' : '') + '">' + pop + '</span>'
          + '<span class="wx-wd-range">' + range + '</span></button>';
      });
      return '<div class="xt-subhead">' + days.length + '-day forecast <span class="wx-sub-hint">· tap a day</span></div>'
        + '<div class="wx-week" style="grid-template-columns:repeat(' + days.length + ',minmax(0,1fr))">' + cols + '</div>'
        + '<div class="wx-week-text" hidden></div>';
    }
    function weekdayName(d, todayKey) {
      return d.key === todayKey ? (d.onlyNight ? 'Tonight' : 'Today')
        : new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(new Date(d.key + 'T12:00:00Z'));
    }
    function dayTextHtml(d, todayKey) {
      const today = d.key === todayKey;
      const lines = [];
      if (d.text && !d.onlyNight) lines.push('<b>' + (today ? 'Today' : 'Day') + ':</b> ' + esc(d.text));
      if (d.nightText) lines.push('<b>' + (today ? 'Tonight' : 'Night') + ':</b> ' + esc(d.nightText));
      if (!lines.length) lines.push(esc(d.text || CORE.condLabel(d.cond, true)));
      const title = today ? '' : '<b>' + esc(new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })
        .format(new Date(d.key + 'T12:00:00Z'))) + '</b><br>';
      return title + lines.join('<br>');
    }

    // "Air & sun": AQHI / AQI and UV on their colour scales.
    function gaugeHtml(scale, title, v, sub) {
      const S = CORE.SCALES[scale], b = CORE.band(scale, v);
      if (!b) return '';
      const pos = Math.max(0, Math.min(1, (v - S.min) / (S.max - S.min))) * 100;
      return '<div class="wx-gauge"><span class="wx-g-title">' + esc(title) + '</span>'
        + '<div class="wx-g-val"><b>' + Math.round(v) + '</b><span><i style="background:' + b.color + '"></i>' + esc(b.label) + '</span></div>'
        + '<div class="wx-g-scale wx-g-' + scale + '"><i style="left:' + r2(pos) + '%"></i></div>'
        + (sub ? '<span class="wx-g-sub">' + esc(sub) + '</span>' : '') + '</div>';
    }
    function airSunHtml(m, nowMs, tz) {
      let g = '';
      if (m.air) {
        const a = CORE.valueAt(m.air.hours, nowMs);
        const top = CORE.maxBetween(m.air.hours, nowMs, nowMs + 24 * 3600000);
        if (a) {
          g += gaugeHtml(m.air.kind, m.air.kind === 'aqhi' ? 'Air quality (AQHI)' : 'Air quality (AQI)', a.v,
            top && Math.round(top.v) > Math.round(a.v) ? 'Up to ' + Math.round(top.v) + ' in the next 24 h' : 'Steady for the next 24 h');
        }
      }
      if (m.uv) {
        const u = CORE.valueAt(m.uv.hours, nowMs);
        const pk = CORE.uvPeak(m.uv.hours, nowMs, tz);
        if (u) {
          g += gaugeHtml('uv', 'UV index', u.v, pk && pk.v >= 0.5
            ? (pk.tomorrow ? 'Tomorrow: up to ' : 'Up to ') + Math.round(pk.v) + ' around ' + fmtHour(pk.t, tz)
            : 'No sunburn risk today');
        }
      }
      return g ? '<div class="xt-subhead">Air &amp; sun</div><div class="wx-airsun">' + g + '</div>' : '';
    }

    function renderBody() {
      if (!model) {
        body.innerHTML = '<div class="wx-empty">Forecasts come from Environment Canada, the US National Weather Service, or Open-Meteo, '
          + 'depending on where you are. The last one you load stays here to read offline.</div>';
        return;
      }
      const m = model, nowMs = Date.now(), tz = m.tz;
      const loc = { lat: m.lat, lon: m.lon };
      let h = '';

      // rain in the next 2 hours (15-minute steps)
      const nc = CORE.nowcastSummary(m.nowcast, nowMs);
      if (nc) h += nowcastHtml(nc, tz);

      // best time for a walk
      const walk = CORE.bestWalk(m, nowMs);
      if (walk) h += walkHtml(walk, tz);

      // the week, compact and above the hourly strip so it's in view
      const todayKey = CORE.dayKey(nowMs, tz);
      const days = m.days.filter((d) => d.key >= todayKey).slice(0, 7);
      if (days.length) h += weekHtml(days, todayKey);

      // hourly — led by a "Now" cell (Environment Canada's hours start at the
      // next hour, so "now" comes from the observation)
      const cur = currentFor(m, nowMs) || {};
      const hours = m.hours.filter((x) => x.t > nowMs - 45 * 60000).slice(0, 24);
      if (Number.isFinite(cur.tempC) && (!hours.length || hours[0].t - nowMs > 30 * 60000)) {
        hours.unshift({ t: nowMs, tempC: cur.tempC, cond: cur.cond, text: cur.text, pop: null });
      }
      if (hours.length) {
        h += '<div class="xt-subhead">Next hours</div><div class="wx-hours">';
        hours.forEach((x, i) => {
          const isNow = i === 0 && nowMs >= x.t - 30 * 60000;
          const day = CORE.isDay(x.t + 30 * 60000, loc.lat, loc.lon);
          const pop = Number.isFinite(x.pop) && x.pop >= 10 ? Math.round(x.pop) + '%' : '0%';
          h += '<div class="wx-hour' + (isNow ? ' now' : '') + '" title="' + esc(x.text || '') + '">'
            + '<div class="wx-h-t">' + (isNow ? 'Now' : esc(fmtHour(x.t, tz))) + '</div>'
            + CORE.icon(x.cond || 'partly', day, 34)
            + '<div class="wx-h-temp">' + tempStr(x.tempC) + '</div>'
            + '<div class="wx-pop' + (pop === '0%' ? ' zero' : '') + '">' + pop + '</div></div>';
        });
        h += '</div>';
      }

      // air quality + UV
      h += airSunHtml(m, nowMs, tz);

      // details
      const st = CORE.sunTimes(nowMs, loc.lat, loc.lon, tz);
      const det = [
        ['Feels like', tempStr(cur.feelsC)],
        ['Humidity', Number.isFinite(cur.rh) ? Math.round(cur.rh) + '%' : '—'],
        ['Wind', Number.isFinite(cur.windKph) ? (cur.windDir ? esc(cur.windDir) + ' ' : '') + windStr(cur.windKph) : '—'],
        ['Gusts', Number.isFinite(cur.gustKph) && cur.gustKph > 0 ? windStr(cur.gustKph) : '—'],
        ['Pressure', pressStr(cur.hPa)],
        ['Dew point', tempStr(cur.dewC)],
        ['Sunrise', st.rise ? esc(fmtClock(st.rise, tz)) : (st.up ? 'up all day' : '—')],
        ['Sunset', st.set ? esc(fmtClock(st.set, tz)) : (st.up ? '—' : 'down all day')],
      ].filter((r) => r[1] !== '—');
      if (det.length) {
        h += '<div class="xt-subhead">Details</div><div class="wx-details">'
          + det.map((r) => '<div class="wx-det"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>').join('') + '</div>';
      }

      // attribution
      const from = m.src === 'eccc' ? 'Environment and Climate Change Canada'
        : m.src === 'nws' ? 'US National Weather Service (NOAA)'
          : 'Open-Meteo.com (CC BY 4.0)';
      const where = m.place ? esc(m.place) + (Number.isFinite(m.distKm) && m.distKm >= 1 ? ' (' + Math.round(imperial() ? m.distKm / 1.609344 : m.distKm) + (imperial() ? ' mi' : ' km') + ' away)' : '') : '';
      const airFrom = !m.air ? '' : m.air.kind === 'aqhi'
        ? 'Environment Canada AQHI' + (m.air.place ? ' for ' + m.air.place : '')
        : 'Open-Meteo (Copernicus CAMS)';
      h += '<div class="wx-attrib">Forecast: ' + esc(from) + (where ? '<br>for ' + where : '')
        + (cur.observed && cur.station ? '<br>Now: observed at ' + esc(cur.station) : '')
        + (airFrom ? '<br>Air quality: ' + esc(airFrom) : '')
        + (m.uv || m.nowcast ? '<br>UV and the next 2 hours: Open-Meteo' : '') + '</div>';

      body.innerHTML = h;
      // tap a day for its words; tap it again (or another day) to switch
      const weekText = body.querySelector('.wx-week-text');
      body.querySelectorAll('.wx-wd').forEach((b) => b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') !== 'true';
        body.querySelectorAll('.wx-wd').forEach((x) => x.setAttribute('aria-pressed', String(x === b && on)));
        weekText.hidden = !on;
        if (on) weekText.innerHTML = dayTextHtml(days[+b.dataset.i], todayKey);
      }));
    }

    function render() {
      syncChips();
      renderHero();
      renderAlerts();
      renderBody();
      renderStatus();
    }

    // The ONLY path to the network in this tool.
    async function onLoadClick() {
      if (busy) return;
      const loc = chosenLoc();
      if (!loc) {
        note = { text: 'No location yet — turn on GPS or pan the map to your spot.', err: true };
        renderStatus();
        return;
      }
      busy = true; note = null;
      loadBtn.disabled = true;
      renderStatus();
      try {
        const m = await CORE.load(loc, { fetch: global.fetch.bind(global) });
        model = m;
        writeStore(m);
        if (m.fellBackFrom) {
          note = { text: (m.fellBackFrom === 'eccc' ? 'Environment Canada' : 'The National Weather Service')
            + " didn't answer, so this is Open-Meteo's forecast.", err: false };
        }
      } catch (e) {
        const k = e && e.kind;
        note = { err: true, text: k === 'offline' ? "Couldn't reach the weather service — are you online?"
          : k === 'timeout' ? 'The weather service took too long to answer. Try again in a bit.'
            : k === 'nodata' ? 'No forecast is available for this spot.'
              : 'The weather service had a problem' + (e && e.status ? ' (HTTP ' + e.status + ')' : '') + '. Try again in a bit.' };
      } finally {
        busy = false;
        loadBtn.disabled = false;
        render();
      }
    }
    loadBtn.addEventListener('click', onLoadClick);

    view._wxRender = function () { note = null; render(); };
    render();
  }

  // The same tool, mounted somewhere else (Stats -> Weather, on the panel's
  // view stack). Mounts are independent views over the shared stored
  // forecast and prefs; render() redraws one (e.g. when its page reshows).
  global.ExtrasWeather = {
    mount(container) {
      buildWeather(container);
      return { render: () => { if (container._wxRender) container._wxRender(); } };
    },
  };

  RT({
    id: 'weather',
    name: 'Weather',
    label: 'Weather',
    icon: CORE.icon('showers', true, 30),
    build: buildWeather,
    onShow: function () {
      const v = document.getElementById('extras_weather');
      if (v && v._wxRender) v._wxRender();
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
