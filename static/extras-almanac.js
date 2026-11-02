// Extras -> Almanac: Sun, Astronomy and Calendar tools.
//
// A self-contained offline almanac that plugs into the Extras launcher via the
// generic global.ExtrasRegisterTool({ ..., build }) hook in extras.js, exactly
// like extras-apps.js. Everything here is pure deterministic math -- no network,
// no data files -- in keeping with the zero-data design.
//
// Three tools:
//   - Sun       (twilight, golden/blue hour, day length, solar noon, alt/az,
//                equation of time, seasons, sub-solar point, planetary hours,
//                antipode, distance to equator/pole)
//   - Astronomy (moon phase/illumination, rise/set, full/new moon, supermoon,
//                blue/black moon, eclipses w/ local visibility, planets tonight,
//                Mercury retrograde, meteor showers w/ moon interference,
//                Mars Sol Date, age/weight on other planets)
//   - Calendar  (day-of-year, ISO week, Julian Day, Easter, Friday-13th,
//                day-of-week, alternate calendars, birthstone/flower)
//
// The astronomy/calendar ENGINE is attached to global.Almanac and is written to
// run headless (it returns before touching the DOM when document is undefined),
// so it can be unit-tested in Node against reference ephemerides.
//
// NOTE: the CSS/HTML further down lives inside template literals -- never put a
// backtick inside them (even in a comment), it terminates the string and breaks
// the file. Normal JS template strings in the engine are fine.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve (if tracked)
  if (global._scriptVersions) global._scriptVersions['extras-almanac.js'] = SCRIPT_VERSION;

  // ════════════════════════════════════════════════════════════════════
  // ENGINE  (pure math, no DOM)  ->  global.Almanac
  // ════════════════════════════════════════════════════════════════════
  // Algorithms follow Jean Meeus, "Astronomical Algorithms" (2nd ed) for the
  // Sun (ch.25), sidereal time (ch.12), obliquity (ch.22) and seasons (ch.27),
  // and Dershowitz & Reingold, "Calendrical Calculations", for the calendars.

  const A = {};

  // ── angle helpers (work in degrees; trig wrappers convert) ──
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const sin = (d) => Math.sin(d * D2R);
  const cos = (d) => Math.cos(d * D2R);
  const tan = (d) => Math.tan(d * D2R);
  const asin = (x) => Math.asin(Math.max(-1, Math.min(1, x))) * R2D;
  const acos = (x) => Math.acos(Math.max(-1, Math.min(1, x))) * R2D;
  const atan2 = (y, x) => Math.atan2(y, x) * R2D;
  const norm360 = (d) => ((d % 360) + 360) % 360;
  const norm180 = (d) => { const x = norm360(d); return x > 180 ? x - 360 : x; };
  A.norm360 = norm360; A.norm180 = norm180;

  // ── time / Julian Day ──
  const J2000 = 2451545.0;
  const MS_PER_DAY = 86400000;
  // Unix epoch 1970-01-01T00:00Z == JD 2440587.5.
  A.jdFromMs = (ms) => ms / MS_PER_DAY + 2440587.5;
  A.msFromJd = (jd) => (jd - 2440587.5) * MS_PER_DAY;

  // ΔT (TT - UT), seconds. Espenak & Meeus polynomial, accurate over the
  // app's useful window (this branch covers 2005-2050 to within a second or
  // two; the fallbacks keep it sane outside that). For our ~arcminute work the
  // exact value barely matters, but the Moon moves ~0.5"/s so we carry it.
  A.deltaTSeconds = (jd) => {
    const year = 2000 + (jd - J2000) / 365.25;
    let t;
    if (year >= 2005 && year <= 2050) { t = year - 2000; return 62.92 + 0.32217 * t + 0.005589 * t * t; }
    if (year > 2050 && year <= 2150) { return -20 + 32 * Math.pow((year - 1820) / 100, 2) - 0.5628 * (2150 - year); }
    if (year >= 1986 && year < 2005) { t = year - 2000; return 63.86 + 0.3345 * t - 0.060374 * t * t + 0.0017275 * t * t * t + 0.000651814 * Math.pow(t, 4) + 0.00002373599 * Math.pow(t, 5); }
    // Generic long-range parabola (Morrison & Stephenson).
    const u = (year - 1820) / 100;
    return -20 + 32 * u * u;
  };
  // Julian Ephemeris Day (TT) from a UT Julian Day.
  A.jde = (jdUT) => jdUT + A.deltaTSeconds(jdUT) / 86400;

  // ── Sun (Meeus ch.25, low precision; ~0.01°) ──
  // Returns apparent ecliptic longitude (deg), radius vector (AU), true
  // obliquity (deg) and the bits needed for the equation of time.
  A.sunEcliptic = (jde) => {
    const T = (jde - J2000) / 36525;
    const L0 = norm360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
    const M = norm360(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
    const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sin(M)
      + (0.019993 - 0.000101 * T) * sin(2 * M)
      + 0.000289 * sin(3 * M);
    const trueLon = L0 + C;
    const trueAnom = M + C;
    const R = 1.000001018 * (1 - e * e) / (1 + e * cos(trueAnom));
    const omega = 125.04 - 1934.136 * T;
    const nutLon = -0.00478 * sin(omega);          // main nutation term (deg)
    const lonApp = trueLon - 0.00569 + nutLon;     // aberration + nutation
    const eps0 = 23.439291 - (46.8150 * T + 0.00059 * T * T - 0.001813 * T * T * T) / 3600;
    const eps = eps0 + 0.00256 * cos(omega);       // true (apparent) obliquity
    return { T, L0, M, trueLon, lonApp, R, eps, nutLon };
  };
  A.sunEquatorial = (jde) => {
    const s = A.sunEcliptic(jde);
    const ra = norm360(atan2(cos(s.eps) * sin(s.lonApp), cos(s.lonApp)));
    const dec = asin(sin(s.eps) * sin(s.lonApp));
    return { ra, dec, R: s.R, lon: s.lonApp, eps: s.eps, L0: s.L0, nutLon: s.nutLon };
  };
  // Equation of time (minutes); positive => apparent sun ahead of mean (sundial
  // ahead of clock). Meeus 28.3.
  A.equationOfTimeMin = (jde) => {
    const eq = A.sunEquatorial(jde);
    let E = eq.L0 - 0.0057183 - eq.ra + eq.nutLon * cos(eq.eps);
    E = norm180(E);
    return E * 4;
  };

  // Greenwich mean sidereal time (deg) from a UT Julian Day (Meeus 12.4).
  A.gmst = (jdUT) => {
    const T = (jdUT - J2000) / 36525;
    return norm360(280.46061837 + 360.98564736629 * (jdUT - J2000)
      + 0.000387933 * T * T - T * T * T / 38710000);
  };

  // Sun altitude/azimuth (deg). Azimuth measured from North, clockwise
  // (N=0, E=90, S=180, W=270), matching NOAA's convention.
  A.sunAltAz = (ms, lat, lon) => {
    const jdUT = A.jdFromMs(ms);
    const eq = A.sunEquatorial(A.jde(jdUT));
    const lst = A.gmst(jdUT) + lon;            // local sidereal time (deg), lon east+
    const H = norm180(lst - eq.ra);            // hour angle (deg)
    const alt = asin(sin(lat) * sin(eq.dec) + cos(lat) * cos(eq.dec) * cos(H));
    let az = acos((sin(eq.dec) - sin(lat) * sin(alt)) / (cos(lat) * cos(alt)));
    if (sin(H) > 0) az = 360 - az;
    return { alt, az, ra: eq.ra, dec: eq.dec, H };
  };

  // Sun declination + equation-of-time at the given JDE — used by rise/set.
  const sunDecEoT = (jde) => ({ dec: A.sunEquatorial(jde).dec, eot: A.equationOfTimeMin(jde) });

  // Rise/set/transit for a target altitude (deg), as UT minutes-after-midnight
  // of the given Gregorian date. Returns { rise, set, noon } or { polar:'above'|
  // 'below', noon }. lon east-positive. One refinement pass for accuracy.
  A.sunEventsUTC = (y, mo, d, lat, lon, altDeg) => {
    const jdMidUT = A.jdFromMs(Date.UTC(y, mo - 1, d, 12, 0)); // greenwich noon of date
    let { dec, eot } = sunDecEoT(A.jde(jdMidUT));
    const noon = 720 - 4 * lon - eot;          // UT minutes of local solar noon
    const ha0 = () => {
      const cosH = (sin(altDeg) - sin(lat) * sin(dec)) / (cos(lat) * cos(dec));
      if (cosH > 1) return { polar: 'below' };
      if (cosH < -1) return { polar: 'above' };
      return { ha: acos(cosH) };
    };
    let r = ha0();
    if (r.polar) return { polar: r.polar, noon };
    let rise = noon - 4 * r.ha, set = noon + 4 * r.ha;
    // refine dec/eot at the rise and set instants (sub-arcminute matters near poles)
    for (let i = 0; i < 2; i++) {
      const dr = sunDecEoT(A.jde(A.jdFromMs(Date.UTC(y, mo - 1, d) + rise * 60000)));
      const ds = sunDecEoT(A.jde(A.jdFromMs(Date.UTC(y, mo - 1, d) + set * 60000)));
      const noonR = 720 - 4 * lon - dr.eot, noonS = 720 - 4 * lon - ds.eot;
      const cR = (sin(altDeg) - sin(lat) * sin(dr.dec)) / (cos(lat) * cos(dr.dec));
      const cS = (sin(altDeg) - sin(lat) * sin(ds.dec)) / (cos(lat) * cos(ds.dec));
      if (Math.abs(cR) <= 1) rise = noonR - 4 * acos(cR);
      if (Math.abs(cS) <= 1) set = noonS + 4 * acos(cS);
    }
    return { rise, set, noon };
  };

  // Solve apparent solar longitude == targetDeg near approxJd (TT). Newton on
  // the ~0.9856°/day mean motion; used for solstices/equinoxes.
  A.solveSunLon = (targetDeg, approxJd) => {
    let jd = approxJd;
    for (let i = 0; i < 8; i++) {
      const lon = A.sunEcliptic(jd).lonApp;
      let diff = norm180(targetDeg - lon);
      if (Math.abs(diff) < 1e-6) break;
      jd += diff / 0.98564736;
    }
    return jd;
  };
  // Equinox/solstice instants (ms epoch, UT) for a Gregorian year.
  // k: 0=Mar equinox, 1=Jun solstice, 2=Sep equinox, 3=Dec solstice.
  A.seasonInstant = (year, k) => {
    // rough starting JD: the k-th season is near month 3,6,9,12 day ~20.
    const approxMs = Date.UTC(year, [2, 5, 8, 11][k], 20, 12, 0);
    const jde = A.solveSunLon(k * 90, A.jde(A.jdFromMs(approxMs)));
    return A.msFromJd(jde - A.deltaTSeconds(jde) / 86400); // back to UT
  };
  A.seasonsForYear = (year) => ({
    marEquinox: A.seasonInstant(year, 0),
    junSolstice: A.seasonInstant(year, 1),
    sepEquinox: A.seasonInstant(year, 2),
    decSolstice: A.seasonInstant(year, 3),
  });

  // Sub-solar point: latitude = solar declination, longitude = meridian where
  // the sun is currently overhead (local apparent noon). Plus the longitudes
  // experiencing solar noon / solar midnight right now.
  A.subSolarPoint = (ms) => {
    const jdUT = A.jdFromMs(ms);
    const eq = A.sunEquatorial(A.jde(jdUT));
    const gast = A.gmst(jdUT) + eq.nutLon * cos(eq.eps); // apparent ~ mean + eq.equinoxes
    const lon = norm180(eq.ra - gast);
    return { lat: eq.dec, lon, noonLon: lon, midnightLon: norm180(lon + 180) };
  };

  // ── Earth geometry ──
  const EARTH_KM_PER_DEG = 111.19492664; // mean great-circle km per degree
  A.antipode = (lat, lon) => ({ lat: -lat, lon: norm180(lon + 180) });
  A.distToEquatorKm = (lat) => Math.abs(lat) * EARTH_KM_PER_DEG;
  A.distToPoleKm = (lat) => (90 - Math.abs(lat)) * EARTH_KM_PER_DEG;
  A.nearestPole = (lat) => (lat >= 0 ? 'North' : 'South');

  // ── Planetary hours ──
  // The Chaldean order, governing each unequal hour. The day's first hour is
  // ruled by the planet of the weekday (Sun=Sunday ... Saturn=Saturday).
  const CHALDEAN = ['Saturn', 'Jupiter', 'Mars', 'Sun', 'Venus', 'Mercury', 'Moon'];
  const DAY_RULER = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn']; // Sun=0..Sat=6
  // Given today's sunrise/sunset (UT min) and the next day's sunrise (UT min,
  // +1440 frame) plus the weekday (0=Sun..6=Sat), return the 24 planetary hours
  // as {planet, startMin, endMin, night}. startMin/endMin are UT minutes in the
  // sunrise..nextSunrise frame.
  A.planetaryHours = (sunriseMin, sunsetMin, nextSunriseMin, weekday) => {
    const dayLen = (sunsetMin - sunriseMin) / 12;
    const nightLen = (nextSunriseMin - sunsetMin) / 12;
    const startPlanet = DAY_RULER[weekday];
    let idx = CHALDEAN.indexOf(startPlanet);
    const hours = [];
    for (let i = 0; i < 24; i++) {
      const night = i >= 12;
      const start = night ? sunsetMin + (i - 12) * nightLen : sunriseMin + i * dayLen;
      const end = night ? sunsetMin + (i - 11) * nightLen : sunriseMin + (i + 1) * dayLen;
      hours.push({ planet: CHALDEAN[idx], startMin: start, endMin: end, night });
      idx = (idx + 1) % 7;
    }
    return hours;
  };

  // ════════════════════════════════════════════════════════════════════
  // CALENDARS  (Dershowitz & Reingold "fixed date" / RD arithmetic)
  // ════════════════════════════════════════════════════════════════════
  // RD = Rata Die: day count where RD 1 = Gregorian 0001-01-01 (proleptic).
  // RD relates to the Julian Day Number by JDN = RD + 1721425.
  const floorDiv = (a, b) => Math.floor(a / b);
  const mod = (a, b) => a - b * Math.floor(a / b);

  A.isGregLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
  // Fixed date (RD) from a Gregorian date.
  A.gregToRD = (y, m, d) => {
    const pr = y - 1;
    return 365 * pr + floorDiv(pr, 4) - floorDiv(pr, 100) + floorDiv(pr, 400)
      + floorDiv(367 * m - 362, 12)
      + (m <= 2 ? 0 : (A.isGregLeap(y) ? -1 : -2)) + d;
  };
  A.rdToGreg = (rd) => {
    const d0 = rd - 1;
    const n400 = floorDiv(d0, 146097); let r = d0 - 146097 * n400;
    const n100 = floorDiv(r, 36524); r -= 36524 * n100;
    const n4 = floorDiv(r, 1461); r -= 1461 * n4;
    const n1 = floorDiv(r, 365);
    let year = 400 * n400 + 100 * n100 + 4 * n4 + n1;
    if (!(n100 === 4 || n1 === 4)) year += 1;
    const priorDays = rd - A.gregToRD(year, 1, 1);
    const corr = rd < A.gregToRD(year, 3, 1) ? 0 : (A.isGregLeap(year) ? 1 : 2);
    const month = floorDiv(12 * (priorDays + corr) + 373, 367);
    const day = rd - A.gregToRD(year, month, 1) + 1;
    return { y: year, m: month, d: day };
  };
  // Julian Day Number (integer, at noon) for a Gregorian date.
  A.jdn = (y, m, d) => A.gregToRD(y, m, d) + 1721425;
  // Day of week, 0=Sunday .. 6=Saturday.
  A.dayOfWeek = (y, m, d) => mod(A.gregToRD(y, m, d), 7);
  A.dayOfYear = (y, m, d) => A.gregToRD(y, m, d) - A.gregToRD(y, 1, 1) + 1;
  A.daysInYear = (y) => (A.isGregLeap(y) ? 366 : 365);

  // ISO-8601 week number + ISO week-year.
  A.isoWeek = (y, m, d) => {
    const rd = A.gregToRD(y, m, d);
    const wd = mod(rd - 1, 7); // 0=Mon..6=Sun
    const thursday = rd - wd + 3;
    const isoYear = A.rdToGreg(thursday).y;
    const week = Math.floor((thursday - A.gregToRD(isoYear, 1, 1)) / 7) + 1;
    return { week, year: isoYear };
  };

  // Easter Sunday (Gregorian) via the Anonymous Gregorian computus.
  A.easter = (y) => {
    const a = y % 19, b = floorDiv(y, 100), c = y % 100;
    const dd = floorDiv(b, 4), e = b % 4, f = floorDiv(b + 8, 25), g = floorDiv(b - f + 1, 3);
    const h = (19 * a + b - dd - g + 15) % 30;
    const i = floorDiv(c, 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const mth = floorDiv(a + 11 * h + 22 * l, 451);
    const n = h + l - 7 * mth + 114;
    return { y, m: floorDiv(n, 31), d: (n % 31) + 1 };
  };

  // Next Friday the 13th strictly after the given Gregorian date.
  A.nextFriday13 = (y, m, d) => {
    const start = A.gregToRD(y, m, d);
    let yy = y, mm = m;
    for (let i = 0; i < 60; i++) {
      const rd13 = A.gregToRD(yy, mm, 13);
      if (rd13 > start && mod(rd13, 7) === 5) return A.rdToGreg(rd13);
      mm++; if (mm > 12) { mm = 1; yy++; }
    }
    return null;
  };

  // Julian (Old Style) calendar (Dershowitz & Reingold). JULIAN_EPOCH is the RD
  // of Julian 1-01-01 (== Gregorian 1-01-03 proleptic).
  const JULIAN_EPOCH = -1;
  A.julianLeap = (y) => mod(y, 4) === (y > 0 ? 0 : 3);
  A.julianToRD = (y, m, d) => {
    const yy = y < 0 ? y + 1 : y;
    return JULIAN_EPOCH - 1 + 365 * (yy - 1) + floorDiv(yy - 1, 4)
      + floorDiv(367 * m - 362, 12)
      + (m <= 2 ? 0 : (A.julianLeap(y) ? -1 : -2)) + d;
  };
  A.rdToJulian = (rd) => {
    const approx = floorDiv(4 * (rd - JULIAN_EPOCH) + 1464, 1461);
    const year = approx <= 0 ? approx - 1 : approx;
    const priorDays = rd - A.julianToRD(year, 1, 1);
    const corr = rd < A.julianToRD(year, 3, 1) ? 0 : (A.julianLeap(year) ? 1 : 2);
    const month = floorDiv(12 * (priorDays + corr) + 373, 367);
    const day = rd - A.julianToRD(year, month, 1) + 1;
    return { y: year, m: month, d: day };
  };

  // Hebrew calendar (Dershowitz & Reingold).
  const HEBREW_EPOCH = -1373427; // RD of Hebrew 0001-07-?? start
  A.hebrewLeap = (y) => mod(7 * y + 1, 19) < 7;
  const hebrewMonthsInYear = (y) => A.hebrewLeap(y) ? 13 : 12;
  const hebrewElapsedDays = (y) => {
    const monthsElapsed = floorDiv(235 * y - 234, 19);
    const partsElapsed = 12084 + 13753 * monthsElapsed;
    let day = 29 * monthsElapsed + floorDiv(partsElapsed, 25920);
    if (mod(3 * (day + 1), 7) < 3) day += 1;
    return day;
  };
  const hebrewNewYearDelay = (y) => {
    const ny0 = hebrewElapsedDays(y - 1), ny1 = hebrewElapsedDays(y), ny2 = hebrewElapsedDays(y + 1);
    if (ny2 - ny1 === 356) return 2;
    if (ny1 - ny0 === 382) return 1;
    return 0;
  };
  const hebrewNewYear = (y) => HEBREW_EPOCH + hebrewElapsedDays(y) + hebrewNewYearDelay(y);
  const hebrewDaysInYear = (y) => hebrewNewYear(y + 1) - hebrewNewYear(y);
  const hebrewLongHeshvan = (y) => mod(hebrewDaysInYear(y), 10) === 5;
  const hebrewShortKislev = (y) => mod(hebrewDaysInYear(y), 10) === 3;
  const hebrewMonthDays = (y, m) => {
    if ([2, 4, 6, 10, 13].indexOf(m) >= 0) return 29;
    if (m === 12 && !A.hebrewLeap(y)) return 29;
    if (m === 8 && !hebrewLongHeshvan(y)) return 29;
    if (m === 9 && hebrewShortKislev(y)) return 29;
    return 30;
  };
  A.hebrewFromRD = (rd) => {
    let y = floorDiv(rd - HEBREW_EPOCH, 365) + 1;
    while (hebrewNewYear(y + 1) <= rd) y++;
    while (hebrewNewYear(y) > rd) y--;
    const start = rd < A._hebrewToRD(y, 1, 1) ? 7 : 1;
    let m = start;
    while (rd > A._hebrewToRD(y, m, hebrewMonthDays(y, m))) m = mod(m, hebrewMonthsInYear(y)) + 1;
    const d = rd - A._hebrewToRD(y, m, 1) + 1;
    return { y, m, d };
  };
  A._hebrewToRD = (y, m, d) => {
    let rd = hebrewNewYear(y) + d - 1;
    if (m < 7) {
      for (let i = 7; i <= hebrewMonthsInYear(y); i++) rd += hebrewMonthDays(y, i);
      for (let i = 1; i < m; i++) rd += hebrewMonthDays(y, i);
    } else {
      for (let i = 7; i < m; i++) rd += hebrewMonthDays(y, i);
    }
    return rd;
  };
  A.HEBREW_MONTHS = ['Nisan', 'Iyyar', 'Sivan', 'Tammuz', 'Av', 'Elul', 'Tishri',
    'Heshvan', 'Kislev', 'Tevet', 'Shevat', 'Adar', 'Adar II'];

  // Islamic (tabular / arithmetic) calendar.
  const ISLAMIC_EPOCH = 227015; // RD of 1 Muharram AH 1 (Friday) — civil epoch
  A.islamicFromRD = (rd) => {
    const y = floorDiv(30 * (rd - ISLAMIC_EPOCH) + 10646, 10631);
    const priorDays = rd - A._islamicToRD(y, 1, 1);
    const m = Math.min(12, floorDiv(11 * priorDays + 330, 325));
    const d = rd - A._islamicToRD(y, m, 1) + 1;
    return { y, m, d };
  };
  A._islamicToRD = (y, m, d) => d + 29 * (m - 1) + floorDiv(6 * m - 1, 11)
    + (y - 1) * 354 + floorDiv(3 + 11 * y, 30) + ISLAMIC_EPOCH - 1;
  A.ISLAMIC_MONTHS = ['Muharram', 'Safar', 'Rabi I', 'Rabi II', 'Jumada I', 'Jumada II',
    'Rajab', 'Shaban', 'Ramadan', 'Shawwal', 'Dhu al-Qadah', 'Dhu al-Hijjah'];

  // Persian (astronomical Solar Hijri / Jalali). Nowruz is the day on which the
  // March equinox falls before noon at Iran Standard Time (UTC+3:30), per the
  // official calendar — computed from our own sun engine, so it tracks the real
  // Iranian calendar rather than an arithmetic approximation.
  A.persianYearStartRD = (pYear) => {
    const eqMs = A.seasonInstant(pYear + 621, 0);   // March equinox (UT) of the matching Greg year
    const t = new Date(eqMs + 3.5 * 3600000);       // shift onto the Tehran clock
    let rd = A.gregToRD(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    if (t.getUTCHours() + t.getUTCMinutes() / 60 >= 12) rd += 1; // equinox after noon -> next day
    return rd;
  };
  A.persianFromRD = (rd) => {
    let y = Math.floor((rd - A.gregToRD(622, 3, 21)) / 365.2422) + 1;
    while (A.persianYearStartRD(y) > rd) y--;
    while (A.persianYearStartRD(y + 1) <= rd) y++;
    const doy = rd - A.persianYearStartRD(y);       // 0-based day of Persian year
    let m, d;
    if (doy < 186) { m = floorDiv(doy, 31) + 1; d = mod(doy, 31) + 1; }
    else { const e = doy - 186; if (e < 150) { m = floorDiv(e, 30) + 7; d = mod(e, 30) + 1; } else { m = 12; d = e - 150 + 1; } }
    return { y, m, d };
  };
  A.PERSIAN_MONTHS = ['Farvardin', 'Ordibehesht', 'Khordad', 'Tir', 'Mordad', 'Shahrivar',
    'Mehr', 'Aban', 'Azar', 'Dey', 'Bahman', 'Esfand'];

  // Chinese sexagenary year + zodiac animal (no lunar month/day — those need
  // new-moon + solar-term computation; we give the year cycle + current term).
  A.CHINESE_STEMS = ['Jiǎ', 'Yǐ', 'Bǐng', 'Dīng', 'Wù', 'Jǐ', 'Gēng', 'Xīn', 'Rén', 'Guǐ'];
  A.CHINESE_BRANCHES = ['Zǐ', 'Chǒu', 'Yín', 'Mǎo', 'Chén', 'Sì', 'Wǔ', 'Wèi', 'Shēn', 'Yǒu', 'Xū', 'Hài'];
  A.CHINESE_ANIMALS = ['Rat', 'Ox', 'Tiger', 'Rabbit', 'Dragon', 'Snake', 'Horse',
    'Goat', 'Monkey', 'Rooster', 'Dog', 'Pig'];
  A.CHINESE_ELEMENTS = ['Wood', 'Wood', 'Fire', 'Fire', 'Earth', 'Earth', 'Metal', 'Metal', 'Water', 'Water'];
  // Sexagenary index 0..59 for a Chinese year that began in Gregorian year y.
  A.chineseYear = (y) => {
    const s = mod(y - 4, 60);
    return {
      stemBranch: A.CHINESE_STEMS[mod(s, 10)] + ' ' + A.CHINESE_BRANCHES[mod(s, 12)],
      animal: A.CHINESE_ANIMALS[mod(s, 12)], element: A.CHINESE_ELEMENTS[mod(s, 10)], index: s,
    };
  };
  // 24 solar terms (jiéqì) from the sun's apparent ecliptic longitude.
  A.SOLAR_TERMS = ['Spring Begins', 'Rain Water', 'Insects Awaken', 'Spring Equinox',
    'Clear & Bright', 'Grain Rain', 'Summer Begins', 'Grain Full', 'Grain in Ear',
    'Summer Solstice', 'Slight Heat', 'Great Heat', 'Autumn Begins', 'End of Heat',
    'White Dew', 'Autumn Equinox', 'Cold Dew', 'Frost Descends', 'Winter Begins',
    'Light Snow', 'Heavy Snow', 'Winter Solstice', 'Slight Cold', 'Great Cold'];
  A.solarTerm = (ms) => {
    const lon = A.sunEcliptic(A.jde(A.jdFromMs(ms))).lonApp;
    // term 0 (Spring Begins) starts at sun longitude 315°.
    const idx = mod(Math.floor((lon - 315) / 15), 24);
    return A.SOLAR_TERMS[idx];
  };
  // Accurate Chinese New Year — the day the sexagenary/zodiac year turns over.
  // Astronomical rule (Dershowitz & Reingold): the 2nd new moon after the
  // December solstice, pushed to the 3rd when a leap month 11/12 (a month with
  // no major solar term) falls before it. Dates reckoned in China time (UTC+8).
  const SYN_MS = 29.530588861 * 86400000, DAY_MS = 86400000;
  const newMoonMsK = (k) => { const j = A.lunation(k, 0); return A.msFromJd(j - A.deltaTSeconds(j) / 86400); };
  const newMoonOnOrAfter = (ms) => { let k = Math.round(A.lunationK(ms)); while (newMoonMsK(k) >= ms) k--; while (newMoonMsK(k) < ms) k++; return newMoonMsK(k); };
  const newMoonBefore = (ms) => { let k = Math.round(A.lunationK(ms)); while (newMoonMsK(k) >= ms) k--; while (newMoonMsK(k + 1) < ms) k++; return newMoonMsK(k); };
  const majorTermIdx = (ms) => Math.floor(A.sunEcliptic(A.jde(A.jdFromMs(ms))).lonApp / 30);
  const noMajorTerm = (newMoonMs) => majorTermIdx(newMoonMs) === majorTermIdx(newMoonOnOrAfter(newMoonMs + DAY_MS));
  A.chineseNewYearMs = (gregYear) => {
    const s1 = A.seasonInstant(gregYear - 1, 3);          // December solstice (prior year)
    const s2 = A.seasonInstant(gregYear, 3);              // next December solstice
    const m12 = newMoonOnOrAfter(s1 + DAY_MS);            // first new moon after the solstice (start of month 12)
    const nextM11 = newMoonBefore(s2 + DAY_MS);           // start of the following month 11
    const m13 = newMoonOnOrAfter(m12 + DAY_MS);           // second new moon after the solstice
    const leap = Math.round((nextM11 - m12) / SYN_MS) === 12;
    if (leap && (noMajorTerm(m12) || noMajorTerm(m13))) return newMoonOnOrAfter(m13 + DAY_MS);
    return m13;
  };
  A.chineseNewYear = (gregYear) => {
    const t = new Date(A.chineseNewYearMs(gregYear) + 8 * 3600000); // China clock (UTC+8)
    return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
  };
  // Sexagenary/zodiac year for a Gregorian date, using the real new-year boundary.
  A.chineseYearForDate = (y, mo, d) => {
    const cny = A.chineseNewYear(y);
    return A.chineseYear(A.gregToRD(y, mo, d) >= A.gregToRD(cny.y, cny.mo, cny.d) ? y : y - 1);
  };

  // Maya Long Count + Tzolkin + Haab (Goodman–Martínez–Thompson correlation,
  // 0.0.0.0.0 == JD 584283 == 4 Ajaw 8 Kumkʼu).
  const MAYAN_EPOCH = 584283 - 1721425; // RD of 0.0.0.0.0 = -1137142
  A.mayanFromRD = (rd) => {
    let n = rd - MAYAN_EPOCH;
    const baktun = floorDiv(n, 144000); n = mod(n, 144000);
    const katun = floorDiv(n, 7200); n = mod(n, 7200);
    const tun = floorDiv(n, 360); n = mod(n, 360);
    const uinal = floorDiv(n, 20); const kin = mod(n, 20);
    return { longCount: [baktun, katun, tun, uinal, kin] };
  };
  A.MAYAN_TZOLKIN = ['Imix', 'Ikʼ', 'Akʼbʼal', 'Kʼan', 'Chikchan', 'Kimi', 'Manikʼ', 'Lamat',
    'Muluk', 'Ok', 'Chuwen', 'Ebʼ', 'Bʼen', 'Ix', 'Men', 'Kibʼ', 'Kabʼan', 'Etzʼnabʼ', 'Kawak', 'Ajaw'];
  A.MAYAN_HAAB = ['Pop', 'Woʼ', 'Sip', 'Sotzʼ', 'Sek', 'Xul', 'Yaxkʼin', 'Mol', 'Chʼen', 'Yax',
    'Sakʼ', 'Keh', 'Mak', 'Kʼankʼin', 'Muwan', 'Pax', 'Kʼayabʼ', 'Kumkʼu', 'Wayebʼ'];
  A.mayanTzolkin = (rd) => {
    const n = rd - MAYAN_EPOCH;
    const num = mod(n + 3, 13) + 1;
    const name = A.MAYAN_TZOLKIN[mod(n + 19, 20)];
    return { num, name };
  };
  A.mayanHaab = (rd) => {
    const n = mod(rd - MAYAN_EPOCH + 348, 365);
    const day = mod(n, 20); const month = floorDiv(n, 20);
    return { day, month: A.MAYAN_HAAB[month] };
  };

  // French Republican (arithmetic, 4/100/400-style "Romme" leap rule variant).
  const FRENCH_EPOCH = A.gregToRD(1792, 9, 22);
  A.frenchFromRD = (rd) => {
    const isFLeap = (y) => {
      const g = y + 1;
      return (mod(g, 4) === 0) && (mod(g, 100) !== 0 || mod(g, 400) === 0);
    };
    let y = floorDiv(rd - FRENCH_EPOCH, 365) + 1;
    while (A._frenchYearStart(y, isFLeap) > rd) y--;
    while (A._frenchYearStart(y + 1, isFLeap) <= rd) y++;
    const doy = rd - A._frenchYearStart(y, isFLeap);
    const m = floorDiv(doy, 30) + 1;
    const d = mod(doy, 30) + 1;
    return { y, m, d };
  };
  A._frenchYearStart = (y, isFLeap) => {
    let rd = FRENCH_EPOCH;
    for (let i = 1; i < y; i++) rd += isFLeap(i) ? 366 : 365;
    return rd;
  };
  A.FRENCH_MONTHS = ['Vendémiaire', 'Brumaire', 'Frimaire', 'Nivôse', 'Pluviôse', 'Ventôse',
    'Germinal', 'Floréal', 'Prairial', 'Messidor', 'Thermidor', 'Fructidor', 'Sansculottides'];

  // Discordian calendar (Principia Discordia).
  A.DISCORD_SEASONS = ['Chaos', 'Discord', 'Confusion', 'Bureaucracy', 'The Aftermath'];
  A.DISCORD_DAYS = ['Sweetmorn', 'Boomtime', 'Pungenday', 'Prickle-Prickle', 'Setting Orange'];
  A.discordian = (y, m, d) => {
    const doy = A.dayOfYear(y, m, d);
    const leap = A.isGregLeap(y);
    if (leap && m === 2 && d === 29) return { stTibbs: true, year: y + 1166 };
    let doy0 = doy - 1;
    if (leap && doy > 60) doy0 -= 1; // skip St Tib's day for season math
    const season = A.DISCORD_SEASONS[floorDiv(doy0, 73)];
    const dayOfSeason = mod(doy0, 73) + 1;
    const weekday = A.DISCORD_DAYS[mod(doy0, 5)];
    return { season, dayOfSeason, weekday, year: y + 1166, stTibbs: false };
  };

  // Birthstone + birth flower by month (1-12).
  A.BIRTHSTONES = ['Garnet', 'Amethyst', 'Aquamarine', 'Diamond', 'Emerald', 'Pearl',
    'Ruby', 'Peridot', 'Sapphire', 'Opal', 'Topaz', 'Turquoise'];
  A.BIRTH_FLOWERS = ['Carnation', 'Violet', 'Daffodil', 'Daisy', 'Lily of the Valley', 'Rose',
    'Larkspur', 'Gladiolus', 'Aster', 'Marigold', 'Chrysanthemum', 'Narcissus'];
  A.ZODIAC = [ // [endDay, sign] — sun-sign by date
    [19, 'Capricorn'], [18, 'Aquarius'], [20, 'Pisces'], [19, 'Aries'], [20, 'Taurus'],
    [20, 'Gemini'], [22, 'Cancer'], [22, 'Leo'], [22, 'Virgo'], [22, 'Libra'],
    [21, 'Scorpio'], [21, 'Sagittarius']];
  A.zodiacSign = (m, d) => {
    const e = A.ZODIAC[m - 1];
    if (d <= e[0]) return e[1];
    return A.ZODIAC[mod(m, 12)][1];
  };

  // ════════════════════════════════════════════════════════════════════
  // MOON  (Meeus ch.47 — full main-problem tables, ~10" longitude)
  // ════════════════════════════════════════════════════════════════════
  // Table 47.A rows: D, M, M', F, Σl(sine, 1e-6 deg), Σr(cosine, 1e-3 km).
  const M47A = [
    0, 0, 1, 0, 6288774, -20905355, 2, 0, -1, 0, 1274027, -3699111, 2, 0, 0, 0, 658314, -2955968,
    0, 0, 2, 0, 213618, -569925, 0, 1, 0, 0, -185116, 48888, 0, 0, 0, 2, -114332, -3149,
    2, 0, -2, 0, 58793, 246158, 2, -1, -1, 0, 57066, -152138, 2, 0, 1, 0, 53322, -170733,
    2, -1, 0, 0, 45758, -204586, 0, 1, -1, 0, -40923, -129620, 1, 0, 0, 0, -34720, 108743,
    0, 1, 1, 0, -30383, 104755, 2, 0, 0, -2, 15327, 10321, 0, 0, 1, 2, -12528, 0,
    0, 0, 1, -2, 10980, 79661, 4, 0, -1, 0, 10675, -34782, 0, 0, 3, 0, 10034, -23210,
    4, 0, -2, 0, 8548, -21636, 2, 1, -1, 0, -7888, 24208, 2, 1, 0, 0, -6766, 30824,
    1, 0, -1, 0, -5163, -8379, 1, 1, 0, 0, 4987, -16675, 2, -1, 1, 0, 4036, -12831,
    2, 0, 2, 0, 3994, -10445, 4, 0, 0, 0, 3861, -11650, 2, 0, -3, 0, 3665, 14403,
    0, 1, -2, 0, -2689, -7003, 2, 0, -1, 2, -2602, 0, 2, -1, -2, 0, 2390, 10056,
    1, 0, 1, 0, -2348, 6322, 2, -2, 0, 0, 2236, -9884, 0, 1, 2, 0, -2120, 5751,
    0, 2, 0, 0, -2069, 0, 2, -2, -1, 0, 2048, -4950, 2, 0, 1, -2, -1773, 4130,
    2, 0, 0, 2, -1595, 0, 4, -1, -1, 0, 1215, -3958, 0, 0, 2, 2, -1110, 0,
    3, 0, -1, 0, -892, 3258, 2, 1, 1, 0, -810, 2616, 4, -1, -2, 0, 759, -1897,
    0, 2, -1, 0, -713, -2117, 2, 2, -1, 0, -700, 2354, 2, 1, -2, 0, 691, 0,
    2, -1, 0, -2, 596, 0, 4, 0, 1, 0, 549, -1423, 0, 0, 4, 0, 537, -1117,
    4, -1, 0, 0, 520, -1571, 1, 0, -2, 0, -487, -1739, 2, 1, 0, -2, -399, 0,
    0, 0, 2, -2, -381, -4421, 1, 1, 1, 0, 351, 0, 3, 0, -2, 0, -340, 0,
    4, 0, -3, 0, 330, 0, 2, -1, 2, 0, 327, 0, 0, 2, 1, 0, -323, 1165,
    1, 1, -1, 0, 299, 0, 2, 0, 3, 0, 294, 0, 2, 0, -1, -2, 0, 8752,
  ];
  // Table 47.B rows: D, M, M', F, Σb(sine, 1e-6 deg).
  const M47B = [
    0, 0, 0, 1, 5128122, 0, 0, 1, 1, 280602, 0, 0, 1, -1, 277693, 2, 0, 0, -1, 173237,
    2, 0, -1, 1, 55413, 2, 0, -1, -1, 46271, 2, 0, 0, 1, 32573, 0, 0, 2, 1, 17198,
    2, 0, 1, -1, 9266, 0, 0, 2, -1, 8822, 2, -1, 0, -1, 8216, 2, 0, -2, -1, 4324,
    2, 0, 1, 1, 4200, 2, 1, 0, -1, -3359, 2, -1, -1, 1, 2463, 2, -1, 0, 1, 2211,
    2, -1, -1, -1, 2065, 0, 1, -1, -1, -1870, 4, 0, -1, -1, 1828, 0, 1, 0, 1, -1794,
    0, 0, 0, 3, -1749, 0, 1, -1, 1, -1565, 1, 0, 0, 1, -1491, 0, 1, 1, 1, -1475,
    0, 1, 1, -1, -1410, 0, 1, 0, -1, -1344, 1, 0, 0, -1, -1335, 0, 0, 3, 1, 1107,
    4, 0, 0, -1, 1021, 4, 0, -1, 1, 833, 0, 0, 1, -3, 777, 4, 0, -2, 1, 671,
    2, 0, 0, -3, 607, 2, 0, 2, -1, 596, 2, -1, 1, -1, 491, 2, 0, -2, 1, -451,
    0, 0, 3, -1, 439, 2, 0, 2, 1, 422, 2, 0, -3, -1, 421, 2, 1, -1, 1, -366,
    2, 1, 0, 1, -351, 4, 0, 0, 1, 331, 2, -1, 1, 1, 315, 2, -2, 0, -1, 302,
    0, 0, 1, 3, -283, 2, 1, 1, -1, -229, 1, 1, 0, -1, 223, 1, 1, 0, 1, 223,
    0, 1, -2, -1, -220, 2, 1, -1, -1, -220, 1, 0, 1, 1, -185, 2, -1, -2, -1, 181,
    0, 1, 2, 1, -177, 4, 0, -2, -1, 176, 4, -1, -1, -1, 166, 1, 0, 1, -1, -164,
    4, 0, 1, -1, 132, 1, 0, -1, -1, -119, 4, -1, 0, -1, 115, 2, -2, 0, 1, 107,
  ];
  // Geocentric ecliptic moon position (apparent λ, β in deg; Δ in km) at JDE.
  A.moonEcliptic = (jde) => {
    const T = (jde - J2000) / 36525;
    const Lp = norm360(218.3164477 + 481267.88123421 * T - 0.0015786 * T * T + T * T * T / 538841 - T * T * T * T / 65194000);
    const D = norm360(297.8501921 + 445267.1114034 * T - 0.0018819 * T * T + T * T * T / 545868 - T * T * T * T / 113065000);
    const M = norm360(357.5291092 + 35999.0502909 * T - 0.0001536 * T * T + T * T * T / 24490000);
    const Mp = norm360(134.9633964 + 477198.8675055 * T + 0.0087414 * T * T + T * T * T / 69699 - T * T * T * T / 14712000);
    const F = norm360(93.272095 + 483202.0175233 * T - 0.0036539 * T * T - T * T * T / 3526000 + T * T * T * T / 863310000);
    const A1 = norm360(119.75 + 131.849 * T), A2 = norm360(53.09 + 479264.290 * T), A3 = norm360(313.45 + 481266.484 * T);
    const E = 1 - 0.002516 * T - 0.0000074 * T * T, E2 = E * E;
    let Sl = 0, Sr = 0, Sb = 0;
    for (let i = 0; i < M47A.length; i += 6) {
      const arg = M47A[i] * D + M47A[i + 1] * M + M47A[i + 2] * Mp + M47A[i + 3] * F;
      let ef = 1; const am = Math.abs(M47A[i + 1]); if (am === 1) ef = E; else if (am === 2) ef = E2;
      Sl += ef * M47A[i + 4] * sin(arg);
      Sr += ef * M47A[i + 5] * cos(arg);
    }
    for (let i = 0; i < M47B.length; i += 5) {
      const arg = M47B[i] * D + M47B[i + 1] * M + M47B[i + 2] * Mp + M47B[i + 3] * F;
      let ef = 1; const am = Math.abs(M47B[i + 1]); if (am === 1) ef = E; else if (am === 2) ef = E2;
      Sb += ef * M47B[i + 4] * sin(arg);
    }
    Sl += 3958 * sin(A1) + 1962 * sin(Lp - F) + 318 * sin(A2);
    Sb += -2235 * sin(Lp) + 382 * sin(A3) + 175 * sin(A1 - F) + 175 * sin(A1 + F) + 127 * sin(Lp - Mp) - 115 * sin(Lp + Mp);
    const omega = 125.04 - 1934.136 * T;
    const nutLon = -0.00478 * sin(omega);
    const lon = norm360(Lp + Sl / 1000000 + nutLon);   // apparent longitude
    const lat = Sb / 1000000;
    const dist = 385000.56 + Sr / 1000;                 // km
    return { lon, lat, dist, T };
  };
  // Geocentric equatorial moon (α, δ deg; Δ km).
  A.moonEquatorial = (jde) => {
    const m = A.moonEcliptic(jde);
    const T = m.T;
    const eps = 23.439291 - (46.8150 * T + 0.00059 * T * T - 0.001813 * T * T * T) / 3600 + 0.00256 * cos(125.04 - 1934.136 * T);
    const ra = norm360(atan2(sin(m.lon) * cos(eps) - tan(m.lat) * sin(eps), cos(m.lon)));
    const dec = asin(sin(m.lat) * cos(eps) + cos(m.lat) * sin(eps) * sin(m.lon));
    return { ra, dec, dist: m.dist, lon: m.lon, lat: m.lat, eps };
  };
  // Topocentric moon alt/az (parallax-corrected, Meeus ch.40). Parallax for the
  // Moon is ~1°, so this matters for rise/set and eclipses.
  A.moonAltAz = (ms, lat, lon) => {
    const jdUT = A.jdFromMs(ms);
    const eq = A.moonEquatorial(A.jde(jdUT));
    const theta = A.gmst(jdUT);
    const piDeg = asin(6378.14 / eq.dist);             // equatorial horizontal parallax
    const u = Math.atan(0.99664719 * tan(lat)) * R2D;
    const rhoSin = 0.99664719 * sin(u), rhoCos = cos(u);
    const H = norm180(theta + lon - eq.ra);
    const dAlpha = atan2(-rhoCos * sin(piDeg) * sin(H), cos(eq.dec) - rhoCos * sin(piDeg) * cos(H));
    const raT = eq.ra + dAlpha;
    const decT = atan2((sin(eq.dec) - rhoSin * sin(piDeg)) * cos(dAlpha), cos(eq.dec) - rhoCos * sin(piDeg) * cos(H));
    const Ht = norm180(theta + lon - raT);
    const alt = asin(sin(lat) * sin(decT) + cos(lat) * cos(decT) * cos(Ht));
    let az = acos((sin(decT) - sin(lat) * sin(alt)) / (cos(lat) * cos(alt)));
    if (sin(Ht) > 0) az = 360 - az;
    // topocentric distance correction is tiny for our needs; keep geocentric dist
    return { alt, az, ra: raT, dec: decT, dist: eq.dist };
  };
  // Moon phase: elongation, phase angle, illuminated fraction, cycle position
  // (0=new .. 0.5=full .. 1=new) and waxing flag. Meeus ch.48.
  A.moonPhase = (jde) => {
    const m = A.moonEcliptic(jde);
    const s = A.sunEcliptic(jde);
    const elong = acos(cos(m.lat) * cos(m.lon - s.lonApp));      // geocentric elongation (deg)
    const Rsun = s.R * 149597870.7;                              // km
    const i = atan2(Rsun * sin(elong), m.dist - Rsun * cos(elong)); // phase angle (deg)
    const illum = (1 + cos(i)) / 2;
    const cyc = norm360(m.lon - s.lonApp) / 360;                 // 0=new .. 0.5=full
    return { elong, phaseAngle: i, illum, cycle: cyc, waxing: cyc < 0.5, dist: m.dist };
  };
  // Moonrise/moonset (UT minutes after midnight of the date) by sampling the
  // topocentric altitude across the day and bracketing crossings of the
  // standard moonrise altitude h0 = +0.125°.
  A.moonEventsUTC = (y, mo, d, lat, lon) => {
    const base = Date.UTC(y, mo - 1, d), h0 = 0.125, step = 10; // minutes
    let prev = A.moonAltAz(base, lat, lon).alt - h0, rise = null, set = null;
    for (let t = step; t <= 1440; t += step) {
      const cur = A.moonAltAz(base + t * 60000, lat, lon).alt - h0;
      if (prev < 0 && cur >= 0 && rise == null) rise = t - step * cur / (cur - prev);
      if (prev >= 0 && cur < 0 && set == null) set = t - step * cur / (cur - prev);
      prev = cur;
    }
    return { rise, set };
  };

  // ── Lunations (Meeus ch.49): mean + corrected new/full moon instants ──
  // phase: 0 = new, 0.5 = full. Returns JDE (TT).
  A.lunation = (k, phase) => {
    k = Math.floor(k) + phase;
    const T = k / 1236.85;
    let jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T * T - 0.000000150 * T * T * T + 0.00000000073 * T * T * T * T;
    const E = 1 - 0.002516 * T - 0.0000074 * T * T;
    const M = norm360(2.5534 + 29.10535670 * k - 0.0000014 * T * T - 0.00000011 * T * T * T);
    const Mp = norm360(201.5643 + 385.81693528 * k + 0.0107582 * T * T + 0.00001238 * T * T * T - 0.000000058 * T * T * T * T);
    const F = norm360(160.7108 + 390.67050284 * k - 0.0016118 * T * T - 0.00000227 * T * T * T + 0.000000011 * T * T * T * T);
    const Om = norm360(124.7746 - 1.56375588 * k + 0.0020672 * T * T + 0.00000215 * T * T * T);
    let c;
    if (phase === 0) {
      c = -0.40720 * sin(Mp) + 0.17241 * E * sin(M) + 0.01608 * sin(2 * Mp) + 0.01039 * sin(2 * F)
        + 0.00739 * E * sin(Mp - M) - 0.00514 * E * sin(Mp + M) + 0.00208 * E * E * sin(2 * M)
        - 0.00111 * sin(Mp - 2 * F) - 0.00057 * sin(Mp + 2 * F) + 0.00056 * E * sin(2 * Mp + M)
        - 0.00042 * sin(3 * Mp) + 0.00042 * E * sin(M + 2 * F) + 0.00038 * E * sin(M - 2 * F)
        - 0.00024 * E * sin(2 * Mp - M) - 0.00017 * sin(Om) - 0.00007 * sin(Mp + 2 * M)
        + 0.00004 * sin(2 * Mp - 2 * F) + 0.00004 * sin(3 * M) + 0.00003 * sin(Mp + M - 2 * F)
        + 0.00003 * sin(2 * Mp + 2 * F) - 0.00003 * sin(Mp + M + 2 * F) + 0.00003 * sin(Mp - M + 2 * F)
        - 0.00002 * sin(Mp - M - 2 * F) - 0.00002 * sin(3 * Mp + M) + 0.00002 * sin(4 * Mp);
    } else {
      c = -0.40614 * sin(Mp) + 0.17302 * E * sin(M) + 0.01614 * sin(2 * Mp) + 0.01043 * sin(2 * F)
        + 0.00734 * E * sin(Mp - M) - 0.00515 * E * sin(Mp + M) + 0.00209 * E * E * sin(2 * M)
        - 0.00111 * sin(Mp - 2 * F) - 0.00057 * sin(Mp + 2 * F) + 0.00056 * E * sin(2 * Mp + M)
        - 0.00042 * sin(3 * Mp) + 0.00042 * E * sin(M + 2 * F) + 0.00038 * E * sin(M - 2 * F)
        - 0.00024 * E * sin(2 * Mp - M) - 0.00017 * sin(Om) - 0.00007 * sin(Mp + 2 * M)
        + 0.00004 * sin(2 * Mp - 2 * F) + 0.00004 * sin(3 * M) + 0.00003 * sin(Mp + M - 2 * F)
        + 0.00003 * sin(2 * Mp + 2 * F) - 0.00003 * sin(Mp + M + 2 * F) + 0.00003 * sin(Mp - M + 2 * F)
        - 0.00002 * sin(Mp - M - 2 * F) - 0.00002 * sin(3 * Mp + M) + 0.00002 * sin(4 * Mp);
    }
    // additional planetary corrections (A1..A14)
    const A1 = 299.77 + 0.107408 * k - 0.009173 * T * T;
    const add = 0.000325 * sin(A1) + 0.000165 * sin(251.88 + 0.016321 * k) + 0.000164 * sin(251.83 + 26.651886 * k)
      + 0.000126 * sin(349.42 + 36.412478 * k) + 0.000110 * sin(84.66 + 18.206239 * k) + 0.000062 * sin(141.74 + 53.303771 * k)
      + 0.000060 * sin(207.14 + 2.453732 * k) + 0.000056 * sin(154.84 + 7.306860 * k) + 0.000047 * sin(34.52 + 27.261239 * k)
      + 0.000042 * sin(207.19 + 0.121824 * k) + 0.000040 * sin(291.34 + 1.844379 * k) + 0.000037 * sin(161.72 + 24.198154 * k)
      + 0.000035 * sin(239.56 + 25.513099 * k) + 0.000023 * sin(331.55 + 3.592518 * k);
    return jde + c + add;
  };
  // Approximate lunation number k for a given ms epoch.
  A.lunationK = (ms) => (A.jdFromMs(ms) - 2451550.09766) / 29.530588861;

  // ════════════════════════════════════════════════════════════════════
  // PLANETS  (Paul Schlyter's compact Keplerian elements; ~1-2 arcmin)
  // ════════════════════════════════════════════════════════════════════
  // Each element is [base, perDay]; angles in degrees. d = JDE - 2451543.5.
  const PL = {
    Mercury: { N: [48.3313, 3.24587e-5], i: [7.0047, 5.00e-8], w: [29.1241, 1.01444e-5], a: [0.387098, 0], e: [0.205635, 5.59e-10], M: [168.6562, 4.0923344368] },
    Venus: { N: [76.6799, 2.46590e-5], i: [3.3946, 2.75e-8], w: [54.8910, 1.38374e-5], a: [0.723330, 0], e: [0.006773, -1.302e-9], M: [48.0052, 1.6021302244] },
    Mars: { N: [49.5574, 2.11081e-5], i: [1.8497, -1.78e-8], w: [286.5016, 2.92961e-5], a: [1.523688, 0], e: [0.093405, 2.516e-9], M: [18.6021, 0.5240207766] },
    Jupiter: { N: [100.4542, 2.76854e-5], i: [1.3030, -1.557e-7], w: [273.8777, 1.64505e-5], a: [5.20256, 0], e: [0.048498, 4.469e-9], M: [19.8950, 0.0830853001] },
    Saturn: { N: [113.6634, 2.38980e-5], i: [2.4886, -1.081e-7], w: [339.3939, 2.97661e-5], a: [9.55475, 0], e: [0.055546, -9.499e-9], M: [316.9670, 0.0334442282] },
    Uranus: { N: [74.0005, 1.3978e-5], i: [0.7733, 1.9e-8], w: [96.6612, 3.0565e-5], a: [19.18171, -1.55e-8], e: [0.047318, 7.45e-9], M: [142.5905, 0.011725806] },
    Neptune: { N: [131.7806, 3.0173e-5], i: [1.7700, -2.55e-7], w: [272.8461, -6.027e-6], a: [30.05826, 3.313e-8], e: [0.008606, 2.15e-9], M: [260.2471, 0.005995147] },
  };
  A.PLANET_ORDER = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
  // Heliocentric rectangular ecliptic coords (AU) of a planet, plus r.
  const helioXYZ = (p, d) => {
    const ev = (x) => x[0] + x[1] * d;
    const N = ev(p.N), inc = ev(p.i), w = ev(p.w), a = ev(p.a), e = ev(p.e), M = norm360(ev(p.M));
    let E = M + (e * R2D) * sin(M) * (1 + e * cos(M));
    for (let it = 0; it < 8; it++) { const dE = (E - (e * R2D) * sin(E) - M) / (1 - e * cos(E)); E -= dE; if (Math.abs(dE) < 1e-7) break; }
    const xv = a * (cos(E) - e), yv = a * Math.sqrt(1 - e * e) * sin(E);
    const v = atan2(yv, xv), r = Math.hypot(xv, yv);
    const xh = r * (cos(N) * cos(v + w) - sin(N) * sin(v + w) * cos(inc));
    const yh = r * (sin(N) * cos(v + w) + cos(N) * sin(v + w) * cos(inc));
    const zh = r * (sin(v + w) * sin(inc));
    return { xh, yh, zh, r, M, N, w, v, inc };
  };
  // Sun's geocentric rectangular ecliptic coords (AU) — Schlyter's sun.
  const sunXYZ = (d) => {
    const w = 282.9404 + 4.70935e-5 * d, e = 0.016709 - 1.151e-9 * d, M = norm360(356.0470 + 0.9856002585 * d);
    let E = M + (e * R2D) * sin(M) * (1 + e * cos(M));
    for (let it = 0; it < 6; it++) { E -= (E - (e * R2D) * sin(E) - M) / (1 - e * cos(E)); }
    const xv = cos(E) - e, yv = Math.sqrt(1 - e * e) * sin(E);
    const lon = atan2(yv, xv) + w, r = Math.hypot(xv, yv);
    return { x: r * cos(lon), y: r * sin(lon), r, lon: norm360(lon), M };
  };
  // Heliocentric ecliptic position projected on the ecliptic plane (AU), plus the
  // Sun-distance r (AU) and heliocentric ecliptic longitude (deg, 0 at the vernal
  // equinox, increasing counter-clockwise as seen from ecliptic north). Earth is
  // derived from the Sun's geocentric vector (Earth_helio = -Sun_geo). Feeds the
  // top-down solar-system orrery in the Astronomy tool.
  A.PLANET_A = { Mercury: 0.3871, Venus: 0.7233, Earth: 1.0000, Mars: 1.5237, Jupiter: 5.2026, Saturn: 9.5549, Uranus: 19.2184, Neptune: 30.1104 };
  A.HELIO_ORDER = ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
  A.helio = (name, jde) => {
    const d = jde - 2451543.5;
    if (name === 'Earth') { const su = sunXYZ(d); return { x: -su.x, y: -su.y, r: su.r, lon: norm360(su.lon + 180) }; }
    const p = helioXYZ(PL[name], d);
    return { x: p.xh, y: p.yh, r: p.r, lon: norm360(atan2(p.yh, p.xh)) };
  };
  // Full geocentric report for a planet at JDE.
  // Geocentric ecliptic position of a planet at emission day dE (sun/Earth held
  // at observation day, supplied via su). Applies the Schlyter giant-planet
  // perturbations. Returns rectangular (xg,yg,zg) + r + ecliptic lon/lat + R.
  const planetGeo = (name, dE, su) => {
    const ph = helioXYZ(PL[name], dE);
    let xg = ph.xh + su.x, yg = ph.yh + su.y, zg = ph.zh;
    let lonEcl = norm360(atan2(yg, xg)), latEcl = atan2(zg, Math.hypot(xg, yg));
    if (name === 'Jupiter' || name === 'Saturn' || name === 'Uranus') {
      const Mj = norm360(PL.Jupiter.M[0] + PL.Jupiter.M[1] * dE);
      const Ms = norm360(PL.Saturn.M[0] + PL.Saturn.M[1] * dE);
      const Mu = norm360(PL.Uranus.M[0] + PL.Uranus.M[1] * dE);
      let dl = 0, db = 0;
      if (name === 'Jupiter') {
        dl = -0.332 * sin(2 * Mj - 5 * Ms - 67.6) - 0.056 * sin(2 * Mj - 2 * Ms + 21) + 0.042 * sin(3 * Mj - 5 * Ms + 21)
          - 0.036 * sin(Mj - 2 * Ms) + 0.022 * cos(Mj - Ms) + 0.023 * sin(2 * Mj - 3 * Ms + 52) - 0.016 * sin(Mj - 5 * Ms - 69);
      } else if (name === 'Saturn') {
        dl = 0.812 * sin(2 * Mj - 5 * Ms - 67.6) - 0.229 * cos(2 * Mj - 4 * Ms - 2) + 0.119 * sin(Mj - 2 * Ms - 3)
          + 0.046 * sin(2 * Mj - 6 * Ms - 69) + 0.014 * sin(Mj - 3 * Ms + 32);
        db = -0.020 * cos(2 * Mj - 4 * Ms - 2) + 0.018 * sin(2 * Mj - 6 * Ms - 49);
      } else {
        dl = 0.040 * sin(Ms - 2 * Mu + 6) + 0.035 * sin(Ms - 3 * Mu + 33) - 0.015 * sin(Mj - Mu + 20);
      }
      lonEcl = norm360(lonEcl + dl); latEcl += db;
      const rg = Math.hypot(xg, yg, zg);
      xg = rg * cos(lonEcl) * cos(latEcl); yg = rg * sin(lonEcl) * cos(latEcl); zg = rg * sin(latEcl);
    }
    return { xg, yg, zg, lonEcl, latEcl, r: ph.r, R: Math.hypot(xg, yg, zg) };
  };
  A.planet = (name, jde) => {
    const d = jde - 2451543.5;
    const ecl = 23.4393 - 3.563e-7 * d;
    const su = sunXYZ(d);
    // Light-time (planetary aberration): we see the planet where it was R light-
    // units ago. Iterate the emission time; converges in ~2 steps. ~0.0058 day/AU.
    let g = planetGeo(name, d, su);
    g = planetGeo(name, d - 0.0057755183 * g.R, su);
    g = planetGeo(name, d - 0.0057755183 * g.R, su);
    const xe = g.xg, ye = g.yg * cos(ecl) - g.zg * sin(ecl), ze = g.yg * sin(ecl) + g.zg * cos(ecl);
    const ra = norm360(atan2(ye, xe)), dec = atan2(ze, Math.hypot(xe, ye));
    const R = g.R, r = g.r, s = su.r;
    const FV = acos((r * r + R * R - s * s) / (2 * r * R)); // phase angle
    const phase = (1 + cos(FV)) / 2;
    const elong = acos((s * s + R * R - r * r) / (2 * s * R));
    return { ra, dec, distAU: R, helioAU: r, lon: g.lonEcl, lat: g.latEcl, phaseAngle: FV, phase, elong, mag: planetMag(name, r, R, FV), constellation: A.eclipticConstellation(g.lonEcl) };
  };
  const planetMag = (name, r, R, FV) => {
    const b = 5 * Math.log10(r * R);
    switch (name) {
      case 'Mercury': return +(-0.36 + b + 0.027 * FV + 2.2e-13 * Math.pow(FV, 6)).toFixed(1);
      case 'Venus': return +(-4.34 + b + 0.013 * FV + 4.2e-7 * Math.pow(FV, 3)).toFixed(1);
      case 'Mars': return +(-1.51 + b + 0.016 * FV).toFixed(1);
      case 'Jupiter': return +(-9.25 + b + 0.014 * FV).toFixed(1);
      case 'Saturn': return +(-9.0 + b + 0.044 * FV).toFixed(1);
      case 'Uranus': return +(-7.15 + b + 0.001 * FV).toFixed(1);
      case 'Neptune': return +(-6.90 + b).toFixed(1);
      default: return null;
    }
  };
  // Alt/az of a planet (geocentric; planetary parallax negligible).
  A.planetAltAz = (name, ms, lat, lon) => {
    const jdUT = A.jdFromMs(ms);
    const pl = A.planet(name, A.jde(jdUT));
    const H = norm180(A.gmst(jdUT) + lon - pl.ra);
    const alt = asin(sin(lat) * sin(pl.dec) + cos(lat) * cos(pl.dec) * cos(H));
    let az = acos((sin(pl.dec) - sin(lat) * sin(alt)) / (cos(lat) * cos(alt)));
    if (sin(H) > 0) az = 360 - az;
    return { alt, az, ra: pl.ra, dec: pl.dec, mag: pl.mag, elong: pl.elong, constellation: pl.constellation, distAU: pl.distAU };
  };
  // Zodiacal constellation containing an ecliptic longitude (IAU boundaries).
  // Each entry is the longitude where that constellation BEGINS; the wrap
  // region (351.6°..360°..28.7°) belongs to Pisces.
  const ECL_CONSTEL = [
    [28.7, 'Aries'], [53.5, 'Taurus'], [90.4, 'Gemini'], [118.3, 'Cancer'], [138.2, 'Leo'],
    [173.9, 'Virgo'], [217.8, 'Libra'], [241.1, 'Scorpius'], [247.7, 'Ophiuchus'], [266.6, 'Sagittarius'],
    [299.7, 'Capricornus'], [327.8, 'Aquarius'], [351.6, 'Pisces']];
  A.eclipticConstellation = (lon) => {
    const l = norm360(lon);
    let name = 'Pisces';
    for (const [start, nm] of ECL_CONSTEL) { if (l >= start) name = nm; }
    return name;
  };
  // Geocentric ecliptic longitude of a planet (for retrograde detection).
  A.planetEclLon = (name, jde) => A.planet(name, jde).lon;
  // Retrograde state at ms + the next station (direction-change) after it.
  A.retrograde = (name, ms) => {
    const jde = A.jde(A.jdFromMs(ms));
    const rate = (j) => norm180(A.planetEclLon(name, j + 0.5) - A.planetEclLon(name, j - 0.5)); // deg/day
    const isRetro = rate(jde) < 0;
    let j = jde, prev = rate(jde) < 0;
    for (let i = 0; i < 400; i++) { j += 1; if ((rate(j) < 0) !== prev) break; }
    return { retrograde: isRetro, nextStationMs: A.msFromJd(j - A.deltaTSeconds(j) / 86400), nextStationTo: prev ? 'direct' : 'retrograde' };
  };
  // All retrograde windows for a planet within [fromMs, toMs].
  A.retrogradeWindows = (name, fromMs, toMs) => {
    const rate = (j) => norm180(A.planetEclLon(name, j + 0.5) - A.planetEclLon(name, j - 0.5));
    let j = A.jde(A.jdFromMs(fromMs)); const end = A.jde(A.jdFromMs(toMs));
    const out = []; let inRetro = rate(j) < 0, startJ = j;
    for (; j <= end; j += 1) {
      const r = rate(j) < 0;
      if (r && !inRetro) { startJ = j; inRetro = true; }
      else if (!r && inRetro) { out.push({ startMs: A.msFromJd(startJ - A.deltaTSeconds(startJ) / 86400), endMs: A.msFromJd(j - A.deltaTSeconds(j) / 86400) }); inRetro = false; }
    }
    if (inRetro) out.push({ startMs: A.msFromJd(startJ - A.deltaTSeconds(startJ) / 86400), endMs: null });
    return out;
  };

  // ── Other worlds ──
  // Mars Sol Date + Coordinated Mars Time. (Allison & McEwen.)
  A.marsSolDate = (ms) => {
    const jdtt = A.jde(A.jdFromMs(ms));
    const msd = (jdtt - 2405522.0028779) / 1.0274912517;
    return { msd, mtcHours: ((msd % 1) + 1) % 1 * 24 };
  };
  // Sidereal orbital period (Earth days) + surface gravity (Earth g) per body.
  A.WORLDS = [
    { name: 'Mercury', days: 87.969, g: 0.378 }, { name: 'Venus', days: 224.701, g: 0.907 },
    { name: 'Earth', days: 365.256, g: 1.000 }, { name: 'Moon', days: 27.322, g: 0.1654 },
    { name: 'Mars', days: 686.980, g: 0.377 }, { name: 'Jupiter', days: 4332.59, g: 2.528 },
    { name: 'Saturn', days: 10759.22, g: 1.065 }, { name: 'Uranus', days: 30688.5, g: 0.886 },
    { name: 'Neptune', days: 60182, g: 1.137 }, { name: 'Pluto', days: 90560, g: 0.063 },
    { name: 'Sun', days: NaN, g: 27.01 },
  ];

  // ── Meteor showers (IMO working-list values; radiant at peak, J2000) ──
  // The activity window is stored as days before/after the peak; the peak
  // instant itself is solved fresh each year from the sun's apparent
  // longitude (peakLon), so it lands on the right night regardless of
  // calendar drift. `guess` = nominal peak month/day to seed the solver.
  A.METEOR_SHOWERS = [
    { name: 'Quadrantids', peakLon: 283.15, guess: [1, 3], before: 6, after: 9, ra: 230, dec: 49, zhr: 110, parent: '2003 EH1' },
    { name: 'Lyrids', peakLon: 32.32, guess: [4, 22], before: 8, after: 8, ra: 271, dec: 34, zhr: 18, parent: 'comet Thatcher' },
    { name: 'Eta Aquariids', peakLon: 45.5, guess: [5, 6], before: 17, after: 22, ra: 338, dec: -1, zhr: 50, parent: "Halley's comet" },
    { name: 'Alpha Capricornids', peakLon: 128, guess: [7, 31], before: 28, after: 15, ra: 307, dec: -10, zhr: 5, parent: 'comet 169P/NEAT' },
    { name: 'S. Delta Aquariids', peakLon: 128, guess: [7, 31], before: 19, after: 23, ra: 340, dec: -16, zhr: 25, parent: 'comet P/2008 Y12' },
    { name: 'Perseids', peakLon: 140.0, guess: [8, 13], before: 27, after: 11, ra: 48, dec: 58, zhr: 100, parent: 'comet Swift-Tuttle' },
    { name: 'Draconids', peakLon: 195.4, guess: [10, 8], before: 2, after: 2, ra: 262, dec: 54, zhr: 5, parent: 'comet Giacobini-Zinner' },
    { name: 'Orionids', peakLon: 208, guess: [10, 21], before: 19, after: 17, ra: 95, dec: 16, zhr: 20, parent: "Halley's comet" },
    { name: 'S. Taurids', peakLon: 223, guess: [11, 5], before: 46, after: 15, ra: 52, dec: 15, zhr: 5, parent: 'comet Encke' },
    { name: 'N. Taurids', peakLon: 230, guess: [11, 12], before: 23, after: 28, ra: 58, dec: 22, zhr: 5, parent: 'asteroid 2004 TG10' },
    { name: 'Leonids', peakLon: 235.27, guess: [11, 17], before: 11, after: 13, ra: 152, dec: 22, zhr: 15, parent: 'comet Tempel-Tuttle' },
    { name: 'Geminids', peakLon: 262.2, guess: [12, 14], before: 10, after: 6, ra: 112, dec: 33, zhr: 150, parent: 'asteroid Phaethon' },
    { name: 'Ursids', peakLon: 270.7, guess: [12, 22], before: 5, after: 4, ra: 217, dec: 76, zhr: 10, parent: 'comet 8P/Tuttle' },
  ];
  // Instant (ms UTC) the sun reaches the shower's peak longitude in `year`.
  A.showerPeakMs = (s, year) => {
    let t = Date.UTC(year, s.guess[0] - 1, s.guess[1], 12);
    for (let k = 0; k < 5; k++) {
      const lon = A.sunEcliptic(A.jde(A.jdFromMs(t))).lonApp;
      t += norm180(s.peakLon - lon) / 0.98565 * 86400000;
    }
    return t;
  };
  // Showers active at `ms`, closest peak first, each with the moon's
  // illumination at that peak (a bright moon washes the shower out).
  A.activeShowers = (ms) => {
    const y = new Date(ms).getUTCFullYear(), out = [];
    for (const s of A.METEOR_SHOWERS) {
      for (const yy of [y - 1, y, y + 1]) {
        const peak = A.showerPeakMs(s, yy);
        if (ms >= peak - s.before * 86400000 && ms <= peak + s.after * 86400000) {
          out.push({ shower: s, peakMs: peak, moonIllum: A.moonPhase(A.jde(A.jdFromMs(peak))).illum });
          break;
        }
      }
    }
    out.sort((a, b) => Math.abs(ms - a.peakMs) - Math.abs(ms - b.peakMs));
    return out;
  };
  // The next shower peak strictly after `ms`.
  A.nextShowerPeak = (ms) => {
    const y = new Date(ms).getUTCFullYear();
    let best = null;
    for (const s of A.METEOR_SHOWERS) {
      for (const yy of [y, y + 1]) {
        const peak = A.showerPeakMs(s, yy);
        if (peak > ms && (!best || peak < best.peakMs)) {
          best = { shower: s, peakMs: peak, moonIllum: A.moonPhase(A.jde(A.jdFromMs(peak))).illum };
        }
      }
    }
    return best;
  };

  // ════════════════════════════════════════════════════════════════════
  // ECLIPSES  (Meeus ch.54 — global circumstances; local via topocentric
  //            apparent separation, reusing the sun + moon engines)
  // ════════════════════════════════════════════════════════════════════
  // Topocentric apparent sun (parallax ~8.8", included for completeness).
  A.sunTopo = (ms, lat, lon) => {
    const jdUT = A.jdFromMs(ms);
    const eq = A.sunEquatorial(A.jde(jdUT));
    const dist = eq.R * 149597870.7;
    const theta = A.gmst(jdUT);
    const piDeg = asin(6378.14 / dist);
    const u = Math.atan(0.99664719 * tan(lat)) * R2D;
    const rhoSin = 0.99664719 * sin(u), rhoCos = cos(u);
    const H = norm180(theta + lon - eq.ra);
    const dA = atan2(-rhoCos * sin(piDeg) * sin(H), cos(eq.dec) - rhoCos * sin(piDeg) * cos(H));
    const raT = eq.ra + dA;
    const decT = atan2((sin(eq.dec) - rhoSin * sin(piDeg)) * cos(dA), cos(eq.dec) - rhoCos * sin(piDeg) * cos(H));
    const Ht = norm180(theta + lon - raT);
    const alt = asin(sin(lat) * sin(decT) + cos(lat) * cos(decT) * cos(Ht));
    let az = acos((sin(decT) - sin(lat) * sin(alt)) / (cos(lat) * cos(alt)));
    if (sin(Ht) > 0) az = 360 - az;
    return { alt, az, ra: raT, dec: decT, sdDeg: 0.2666 / eq.R };  // sun semidiameter
  };
  // Eclipse for a lunation. phase 0 = solar (new moon), 0.5 = lunar (full moon).
  A.eclipseForLunation = (k, phase) => {
    k = Math.floor(k) + phase;
    const T = k / 1236.85;
    const jdeMean = 2451550.09766 + 29.530588861 * k + 0.00015437 * T * T - 0.000000150 * T * T * T + 0.00000000073 * T * T * T * T;
    const M = norm360(2.5534 + 29.10535670 * k - 0.0000014 * T * T - 0.00000011 * T * T * T);
    const Mp = norm360(201.5643 + 385.81693528 * k + 0.0107582 * T * T + 0.00001238 * T * T * T - 0.000000058 * T * T * T * T);
    const F = norm360(160.7108 + 390.67050284 * k - 0.0016118 * T * T - 0.00000227 * T * T * T + 0.000000011 * T * T * T * T);
    const Om = norm360(124.7746 - 1.56375588 * k + 0.0020672 * T * T + 0.00000215 * T * T * T);
    if (Math.abs(sin(F)) > 0.36) return null;            // certainly no eclipse
    const E = 1 - 0.002516 * T - 0.0000074 * T * T;
    const F1 = F - 0.02665 * sin(Om);
    const A1 = 299.77 + 0.107408 * k - 0.009173 * T * T;
    const P = 0.2070 * E * sin(M) + 0.0024 * E * sin(2 * M) - 0.0392 * sin(Mp) + 0.0116 * sin(2 * Mp)
      - 0.0073 * E * sin(Mp + M) + 0.0067 * E * sin(Mp - M) + 0.0118 * sin(2 * F1);
    const Q = 5.2207 - 0.0048 * E * cos(M) + 0.0020 * E * cos(2 * M) - 0.3299 * cos(Mp)
      - 0.0060 * E * cos(Mp + M) + 0.0041 * E * cos(Mp - M);
    const W = Math.abs(cos(F1));
    const gamma = (P * cos(F1) + Q * sin(F1)) * (1 - 0.0048 * W);
    const u = 0.0059 + 0.0046 * E * cos(M) - 0.0182 * cos(Mp) + 0.0004 * cos(2 * Mp) - 0.0005 * cos(M + Mp);
    const corr = -0.4075 * sin(Mp) + 0.1721 * E * sin(M) + 0.0161 * sin(2 * Mp) - 0.0097 * sin(2 * F1)
      + 0.0073 * E * sin(Mp - M) - 0.0050 * E * sin(Mp + M) - 0.0023 * sin(Mp - 2 * F1)
      + 0.0021 * E * sin(2 * M) + 0.0012 * sin(Mp + 2 * F1) + 0.0006 * E * sin(2 * Mp + M)
      - 0.0004 * sin(3 * Mp) - 0.0003 * E * sin(M + 2 * F1) + 0.0003 * sin(A1)
      - 0.0002 * E * sin(M - 2 * F1) - 0.0002 * E * sin(2 * Mp - M) - 0.0002 * sin(Om);
    const jdeMax = jdeMean + corr;
    const ag = Math.abs(gamma);
    const dateMs = A.msFromJd(jdeMax - A.deltaTSeconds(jdeMax) / 86400);
    if (phase === 0) {
      if (ag > 1.5433 + u) return null;
      let category, magnitude;
      if (ag < 0.9972) {                                  // central (total/annular/hybrid)
        if (u < 0) category = 'total';
        else if (u > 0.0047) category = 'annular';
        else { const omega = 0.00464 * Math.sqrt(1 - gamma * gamma); category = u < omega ? 'hybrid' : 'annular'; }
        // central-line magnitude = Moon/Sun apparent-diameter ratio (Moon at zenith)
        const sunSD = 0.2666 / A.sunEcliptic(jdeMax).R;
        const moonSD = 0.2725 * asin(6378.14 / (A.moonEcliptic(jdeMax).dist - 6378.14));
        magnitude = moonSD / sunSD;
      } else { category = 'partial'; magnitude = (1.5433 + u - ag) / (0.5461 + 2 * u); }
      return { type: 'solar', jdeMax, dateMs, category, gamma, u, magnitude };
    }
    // lunar
    const magPen = (1.5573 + u - ag) / 0.5450;
    if (magPen <= 0) return null;
    const magUmb = (1.0128 - u - ag) / 0.5450;
    let category = magUmb >= 1 ? 'total' : (magUmb > 0 ? 'partial' : 'penumbral');
    const n = 0.5458 + 0.0400 * cos(Mp);                  // moon hourly motion (deg/h)
    const pHalf = 1.0128 - u, tHalf = 0.4678 - u, hHalf = 1.5573 + u;
    const sd = (x) => (x * x - gamma * gamma > 0 ? 60 / n * Math.sqrt(x * x - gamma * gamma) : 0);
    return {
      type: 'lunar', jdeMax, dateMs, category, gamma, u, magnitude: magUmb, magPenumbral: magPen,
      semiPartialMin: sd(pHalf), semiTotalMin: sd(tHalf), semiPenumbralMin: sd(hHalf),
    };
  };
  A.nextSolarEclipse = (ms) => { for (let k = Math.floor(A.lunationK(ms)); k < A.lunationK(ms) + 40; k++) { const e = A.eclipseForLunation(k, 0); if (e && e.dateMs >= ms) return e; } return null; };
  A.nextLunarEclipse = (ms) => { for (let k = Math.floor(A.lunationK(ms)); k < A.lunationK(ms) + 40; k++) { const e = A.eclipseForLunation(k, 0.5); if (e && e.dateMs >= ms) return e; } return null; };

  // Local visibility of a LUNAR eclipse: the eclipsed Moon is in the same sky
  // for the whole night side, so it's just "is the Moon above the horizon?".
  A.lunarEclipseLocal = (ecl, lat, lon) => {
    const aMax = A.moonAltAz(ecl.dateMs, lat, lon).alt;
    const half = (ecl.semiPartialMin || ecl.semiPenumbralMin || 0) * 60000;
    const aStart = A.moonAltAz(ecl.dateMs - half, lat, lon).alt;
    const aEnd = A.moonAltAz(ecl.dateMs + half, lat, lon).alt;
    return { visible: aMax > 0 || aStart > 0 || aEnd > 0, altAtMax: aMax, fullyVisible: aStart > 0 && aEnd > 0 };
  };
  // Local circumstances of a SOLAR eclipse, by stepping the topocentric
  // apparent Sun/Moon separation as seen from the observer.
  A.solarEclipseLocal = (ecl, lat, lon) => {
    const sepAt = (ms) => {
      const s = A.sunTopo(ms, lat, lon), m = A.moonAltAz(ms, lat, lon);
      const sep = acos(sin(s.alt) * sin(m.alt) + cos(s.alt) * cos(m.alt) * cos(s.az - m.az));
      const moonSD = 0.2725 * asin(6378.14 / m.dist);
      return { sep, sunSD: s.sdDeg, moonSD, sunAlt: s.alt, sumSD: s.sdDeg + moonSD };
    };
    let best = null;
    for (let t = -180; t <= 180; t += 1) {                // ±3h, 1-min steps
      const ms = ecl.dateMs + t * 60000;
      const r = sepAt(ms);
      if (!best || r.sep < best.sep) best = Object.assign({ ms }, r);
    }
    if (!best || best.sep > best.sumSD || best.sunAlt < -best.sunSD) {
      return { visible: false, type: 'none' };            // disk never overlaps, or sun down
    }
    const magnitude = (best.sunSD + best.moonSD - best.sep) / (2 * best.sunSD);
    let type = 'partial';
    if (best.sep < Math.abs(best.moonSD - best.sunSD)) type = best.moonSD >= best.sunSD ? 'total' : 'annular';
    // first/last contact: scan outward from max for the separation == sumSD crossings while sun up
    const contact = (dir) => {
      let prev = best.sep - best.sumSD;
      for (let t = 1; t <= 200; t++) {
        const ms = best.ms + dir * t * 60000;
        const r = sepAt(ms);
        const cur = r.sep - r.sumSD;
        if (r.sunAlt < -r.sunSD) return null;             // sun set before contact
        if (prev < 0 && cur >= 0) return ms - dir * 60000 * cur / (cur - prev);
        prev = cur;
      }
      return null;
    };
    return { visible: true, type, magnitude, maxMs: best.ms, altAtMax: best.sunAlt, c1Ms: contact(-1), c4Ms: contact(1) };
  };

  global.Almanac = A;

  // ════════════════════════════════════════════════════════════════════
  // ART  (SVG strings, no DOM)  ->  global.AlmanacArt
  // ════════════════════════════════════════════════════════════════════
  // The Sun and Astronomy heroes, drawn in the app's item-art style (soft
  // gradients, darker outlines, a white shine, faces). Each SVG gets its own
  // id prefix so gradients never collide. Motion is CSS (.alm-anim scopes it;
  // reduced motion turns it off) and only ever decorative.
  const ART = {};
  let artUid = 0;
  const f2 = (n) => Math.round(n * 100) / 100;
  function artRng(seed) {
    let s = (seed >>> 0) || 1;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  }
  const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const mixHex = (a, b, t) => { const x = hexRgb(a), y = hexRgb(b); return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join(''); };
  function ramp(stops, x) {
    if (x <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
      if (x <= stops[i][0]) return mixHex(stops[i - 1][1], stops[i][1], (x - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]));
    }
    return stops[stops.length - 1][1];
  }
  // Sky and ground colour for a sun altitude: night, the twilight purples,
  // pink and gold at the horizon, then day blue.
  const SKY_RAMP = [[-18, '#0a1030'], [-12, '#151d48'], [-8, '#28306a'], [-4, '#4f4682'], [-1, '#a2637f'],
    [1.5, '#e49a6d'], [5, '#eec58e'], [10, '#a8d3ef'], [25, '#78bdf0'], [60, '#4ba2ec']];
  const GROUND_RAMP = [[-12, '#141c33'], [-5, '#262b4c'], [0, '#5b5468'], [4, '#7c8f5a'], [12, '#69a65a'], [60, '#5a9c51']];
  ART.skyColor = (alt) => ramp(SKY_RAMP, alt);
  ART.groundColor = (alt) => ramp(GROUND_RAMP, alt);
  const PLANET_COL = { Mercury: '#c9c1b2', Venus: '#f3dc96', Mars: '#e2704a', Jupiter: '#e8bd8c', Saturn: '#ecd9a0', Uranus: '#9fe0e4', Neptune: '#7d8cf0' };
  const PLANET_GLYPH = { Mercury: '☿', Venus: '♀', Mars: '♂', Jupiter: '♃', Saturn: '♄', Uranus: '♅', Neptune: '♆' };
  const PLANET_R = { Mercury: 2.2, Venus: 3.4, Mars: 2.8, Jupiter: 4, Saturn: 3.4, Uranus: 2.4, Neptune: 2.4 };
  ART.PLANET_COL = PLANET_COL;

  function stop(o, c, a) { return '<stop offset="' + o + '" stop-color="' + c + '"' + (a != null ? ' stop-opacity="' + a + '"' : '') + '/>'; }
  function face(kind, ink, cx, cy, k) {
    const sw = f2(1.6 * k), P = (x, y) => f2(cx + x * k) + ' ' + f2(cy + y * k);
    const line = (d) => '<path d="' + d + '" fill="none" stroke="' + ink + '" stroke-width="' + sw + '" stroke-linecap="round"/>';
    const blush = [-11, 11].map((dx) => '<ellipse cx="' + f2(cx + dx * k) + '" cy="' + f2(cy + 4 * k) + '" rx="' + f2(3.2 * k)
      + '" ry="' + f2(1.9 * k) + '" fill="#ff7d9c" opacity="0.5"/>').join('');
    const eyes = kind === 'sleepy'
      ? line('M' + P(-9, 0) + ' Q' + P(-6, 2.6) + ' ' + P(-3, 0)) + line('M' + P(3, 0) + ' Q' + P(6, 2.6) + ' ' + P(9, 0))
      : line('M' + P(-9, 1) + ' Q' + P(-6, -3) + ' ' + P(-3, 1)) + line('M' + P(3, 1) + ' Q' + P(6, -3) + ' ' + P(9, 1));
    return blush + eyes + line('M' + P(-2.6, 4.4) + ' Q' + P(0, 7) + ' ' + P(2.6, 4.4));
  }
  // A little sun with rays and a face (sleepy and dimmed when it's set).
  function sunGlyph(P, x, y, r, up, motion) {
    let s = '<circle cx="' + f2(x) + '" cy="' + f2(y) + '" r="' + f2(r * 2.4) + '" fill="url(#' + P + 'sglow)"/>';
    if (up) {
      let d = '';
      for (let i = 0; i < 12; i++) {
        const a = i / 12 * Math.PI * 2, a0 = r * 1.3, a1 = r * (i % 2 ? 1.55 : 1.75);
        d += 'M' + f2(Math.cos(a) * a0) + ' ' + f2(Math.sin(a) * a0) + ' L' + f2(Math.cos(a) * a1) + ' ' + f2(Math.sin(a) * a1);
      }
      const rays = '<path d="' + d + '" stroke="#e59a1c" stroke-width="' + f2(r * 0.3) + '" stroke-linecap="round"/>'
        + '<path d="' + d + '" stroke="#ffcf3d" stroke-width="' + f2(r * 0.17) + '" stroke-linecap="round"/>';
      s += '<g transform="translate(' + f2(x) + ' ' + f2(y) + ')">' + (motion ? '<g class="alm-spin">' + rays + '</g>' : rays) + '</g>';
    }
    s += '<circle cx="' + f2(x) + '" cy="' + f2(y) + '" r="' + f2(r) + '" fill="url(#' + P + 'sun)" stroke="#e58f17" stroke-width="' + f2(r * 0.09) + '"/>'
      + '<ellipse cx="' + f2(x - r * 0.36) + '" cy="' + f2(y - r * 0.42) + '" rx="' + f2(r * 0.3) + '" ry="' + f2(r * 0.16)
      + '" transform="rotate(-32 ' + f2(x - r * 0.36) + ' ' + f2(y - r * 0.42) + ')" fill="#fff" opacity="0.75"/>'
      + face(up ? 'happy' : 'sleepy', '#8a4b10', x, y + r * 0.08, r / 16);
    return up ? s : '<g opacity="0.8">' + s + '</g>';
  }
  function sunDefs(P) {
    return '<radialGradient id="' + P + 'sun" cx="0.38" cy="0.33" r="0.78">' + stop(0, '#fffbd6') + stop(0.5, '#ffdc4e') + stop(1, '#ffb529') + '</radialGradient>'
      + '<radialGradient id="' + P + 'sglow" cx="0.5" cy="0.5" r="0.5">' + stop(0, '#ffe27a', 0.55) + stop(0.45, '#ffe27a', 0.2) + stop(1, '#ffe27a', 0) + '</radialGradient>';
  }
  // Find when alt(t) crosses `level` between t0 and t1 (bisection, ~1 s).
  function crossing(f, t0, t1, level) {
    let a = t0, b = t1;
    const sa = f(a) > level;
    for (let i = 0; i < 14; i++) { const m = (a + b) / 2; if ((f(m) > level) === sa) a = m; else b = m; }
    return Math.round((a + b) / 2);
  }

  // Sun path for a local day: x = clock time (midnight to midnight), y = the
  // sun's altitude, over a sky coloured by where the sun is at each moment,
  // with sunrise / sunset / solar noon marked and the sun at `nowMs`.
  //   o = { lat, lon, day0 (local midnight ms), nowMs, fmt(ms) -> clock label,
  //         hourLabel(h) -> axis label, motion }
  // Returns { svg, rise, set, noon, noonAlt } (times in ms, or null).
  ART.sunPath = function (o) {
    const P = 'alm' + (++artUid).toString(36) + '-';
    const W = 320, H = 190, HZ = 128, TOP = 16, N = 144, STEP = 86400000 / N;
    const altAt = (ms) => A.sunAltAz(ms, o.lat, o.lon).alt;
    const alt = [];
    for (let i = 0; i <= N; i++) alt.push(altAt(o.day0 + i * STEP));
    const xOf = (ms) => (ms - o.day0) / 86400000 * W;
    const yOf = (a) => (a >= 0 ? HZ - a / 90 * (HZ - TOP) : Math.min(H - 3, HZ - a / 90 * (H - HZ) * 2.2));
    // events from the samples, refined
    let rise = null, set = null;
    for (let i = 1; i <= N; i++) {
      const a = alt[i - 1] + 0.833, b = alt[i] + 0.833;
      if (a <= 0 && b > 0 && rise == null) rise = crossing(altAt, o.day0 + (i - 1) * STEP, o.day0 + i * STEP, -0.833);
      if (a > 0 && b <= 0 && set == null) set = crossing(altAt, o.day0 + (i - 1) * STEP, o.day0 + i * STEP, -0.833);
    }
    let iMax = 0;
    for (let i = 1; i <= N; i++) if (alt[i] > alt[iMax]) iMax = i;
    let lo = o.day0 + Math.max(0, iMax - 1) * STEP, hi = o.day0 + Math.min(N, iMax + 1) * STEP;
    for (let k = 0; k < 20; k++) {  // ternary search for the peak
      const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
      if (altAt(m1) < altAt(m2)) lo = m1; else hi = m2;
    }
    const noon = Math.round((lo + hi) / 2), noonAlt = altAt(noon);

    let skyStops = '', groundStops = '';
    for (let i = 0; i <= N; i++) {  // every 10 minutes, so twilight blends smoothly
      skyStops += stop(f2(i / N * 1000) / 1000, ART.skyColor(alt[i]));
      groundStops += stop(f2(i / N * 1000) / 1000, ART.groundColor(alt[i]));
    }
    let defs = '<linearGradient id="' + P + 'sky" x1="0" y1="0" x2="1" y2="0">' + skyStops + '</linearGradient>'
      + '<linearGradient id="' + P + 'gnd" x1="0" y1="0" x2="1" y2="0">' + groundStops + '</linearGradient>'
      + '<linearGradient id="' + P + 'shade" x1="0" y1="0" x2="0" y2="1">' + stop(0, '#000', 0.3) + stop(0.75, '#000', 0) + stop(1, '#fff', 0.14) + '</linearGradient>'
      + '<linearGradient id="' + P + 'gshade" x1="0" y1="0" x2="0" y2="1">' + stop(0, '#fff', 0.1) + stop(0.25, '#000', 0) + stop(1, '#000', 0.35) + '</linearGradient>'
      + '<clipPath id="' + P + 'up"><rect width="' + W + '" height="' + HZ + '"/></clipPath>'
      + '<clipPath id="' + P + 'dn"><rect y="' + HZ + '" width="' + W + '" height="' + (H - HZ) + '"/></clipPath>'
      + sunDefs(P);
    let s = '<rect width="' + W + '" height="' + HZ + '" fill="url(#' + P + 'sky)"/>'
      + '<rect width="' + W + '" height="' + HZ + '" fill="url(#' + P + 'shade)"/>';
    // stars wherever that column of sky is properly dark
    const rnd = artRng(7);
    for (let i = 0; i < 70; i++) {
      const x = rnd() * W, y = 6 + rnd() * (HZ - 30), r = 0.5 + rnd() * 0.9, tw = rnd();
      const a = alt[Math.round(x / W * N)];
      if (a > -9) continue;
      const op = f2(Math.min(1, (-9 - a) / 8) * (0.5 + rnd() * 0.5));
      s += '<circle cx="' + f2(x) + '" cy="' + f2(y) + '" r="' + f2(r) + '" fill="#fff" opacity="' + op + '"'
        + (o.motion && tw < 0.25 ? ' class="alm-twinkle" style="animation-delay:' + f2(-tw * 12) + 's"' : '') + '/>';
    }
    // the ground: flat at the horizon so altitudes read true, with a few trees
    s += '<rect y="' + HZ + '" width="' + W + '" height="' + (H - HZ) + '" fill="url(#' + P + 'gnd)" opacity="0.92"/>'
      + '<rect y="' + HZ + '" width="' + W + '" height="' + (H - HZ) + '" fill="url(#' + P + 'gshade)"/>'
      + '<path d="M0 ' + HZ + ' H' + W + '" stroke="#ffffff" stroke-opacity="0.35" stroke-width="1.2"/>';
    [[18, 1], [30, 0.75], [92, 0.9], [232, 0.8], [246, 1.05], [300, 0.85]].forEach(([x, k]) => {
      const c = mixHex(ART.groundColor(alt[Math.round(x / W * N)]), '#0b1020', 0.35);
      s += '<rect x="' + f2(x - 0.9 * k) + '" y="' + f2(HZ - 5 * k) + '" width="' + f2(1.8 * k) + '" height="' + f2(5 * k) + '" fill="' + mixHex(c, '#3a2614', 0.4) + '"/>'
        + '<circle cx="' + x + '" cy="' + f2(HZ - 8 * k) + '" r="' + f2(5 * k) + '" fill="' + c + '"/>';
    });
    // the path: solid gold above the horizon, a faint dashed line below it
    let d = '';
    for (let i = 0; i <= N; i++) d += (i ? ' L' : 'M') + f2(i / N * W) + ' ' + f2(yOf(alt[i]));
    s += '<g clip-path="url(#' + P + 'dn)"><path d="' + d + '" fill="none" stroke="#ffffff" stroke-opacity="0.4" stroke-width="1.6" stroke-dasharray="3 4"/></g>'
      + '<g clip-path="url(#' + P + 'up)"><path d="' + d + '" fill="none" stroke="#b9770f" stroke-width="5" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>'
      + '<path d="' + d + '" fill="none" stroke="#ffe58a" stroke-width="2.8" stroke-linejoin="round" stroke-linecap="round"/></g>';
    // labels (white text with a dark outline so they read on any sky)
    const label = (x, y, t, anchor) => '<text x="' + f2(x) + '" y="' + f2(y) + '" text-anchor="' + (anchor || 'middle') + '" class="alm-svg-label">' + t + '</text>';
    const clampX = (x) => Math.max(26, Math.min(W - 26, x));
    // a rise/set label drops lower when the sun itself is sitting on it
    const nowX = o.nowMs != null ? xOf(o.nowMs) : -999;
    const lblY = (t) => (Math.abs(nowX - xOf(t)) < 30 && Math.abs(altAt(o.nowMs) + 0.833) < 12 ? HZ + 33 : HZ + 15);
    if (rise != null) {
      s += '<circle cx="' + f2(xOf(rise)) + '" cy="' + HZ + '" r="3.4" fill="#fff4c8" stroke="#c98a1a" stroke-width="1.4"/>'
        + label(clampX(xOf(rise)), lblY(rise), '↑ ' + o.fmt(rise));
    }
    if (set != null) {
      s += '<circle cx="' + f2(xOf(set)) + '" cy="' + HZ + '" r="3.4" fill="#fff4c8" stroke="#c98a1a" stroke-width="1.4"/>'
        + label(clampX(xOf(set)), lblY(set), '↓ ' + o.fmt(set));
    }
    if (noonAlt > -0.833) {
      // lift the label clear of the sun when "now" is around noon
      const sunNear = o.nowMs != null && Math.abs(xOf(o.nowMs) - xOf(noon)) < 34;
      const nx = clampX(xOf(noon)), ny = Math.max(10, yOf(noonAlt) - (sunNear ? 30 : 12));
      s += label(nx, ny, o.fmt(noon) + ' · ' + Math.round(noonAlt) + '°');
    }
    for (const h of [6, 12, 18]) {
      const x = xOf(o.day0 + h * 3600000);
      s += '<path d="M' + f2(x) + ' ' + (H - 14) + ' v4" stroke="#ffffff" stroke-opacity="0.45" stroke-width="1"/>'
        + '<text x="' + f2(x) + '" y="' + (H - 3) + '" text-anchor="middle" class="alm-svg-tick">' + o.hourLabel(h) + '</text>';
    }
    // the sun, now
    if (o.nowMs != null && o.nowMs >= o.day0 && o.nowMs <= o.day0 + 86400000) {
      const a = altAt(o.nowMs), x = xOf(o.nowMs);
      s += '<path d="M' + f2(x) + ' ' + TOP + ' V' + (H - 16) + '" stroke="#ffffff" stroke-opacity="0.22" stroke-width="1" stroke-dasharray="2 3"/>';
      s += sunGlyph(P, x, yOf(a), a > -0.833 ? 11 : 9, a > -0.833, o.motion);
    }
    const svg = '<svg class="alm-scene' + (o.motion ? ' alm-anim' : '') + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="The sun\'s path today" xmlns="http://www.w3.org/2000/svg"><defs>'
      + defs + '</defs>' + s + '</svg>';
    return { svg, rise, set, noon, noonAlt };
  };

  // The lit part of the moon's disc for a phase (0 new, 0.5 full); waxing is
  // lit on the right (the northern-hemisphere view).
  function litPath(cx, cy, r, cycle) {
    const cosp = Math.cos(2 * Math.PI * cycle), rx = Math.abs(cosp) * r, waxing = cycle < 0.5;
    const semiSweep = waxing ? 1 : 0, termSweep = waxing ? (cosp > 0 ? 0 : 1) : (cosp > 0 ? 1 : 0);
    return 'M ' + f2(cx) + ' ' + f2(cy - r) + ' A ' + f2(r) + ' ' + f2(r) + ' 0 0 ' + semiSweep + ' ' + f2(cx) + ' ' + f2(cy + r)
      + ' A ' + f2(rx) + ' ' + f2(r) + ' 0 0 ' + termSweep + ' ' + f2(cx) + ' ' + f2(cy - r) + ' Z';
  }
  const CRATERS = [[-0.36, -0.3, 0.17], [0.26, -0.44, 0.1], [0.4, 0.1, 0.19], [-0.08, 0.38, 0.13], [-0.5, 0.24, 0.09], [0.08, -0.06, 0.08], [0.62, -0.18, 0.07]];
  // A moon in its real phase: earthshine on the dark side, craters, a shine,
  // and a sleepy face once there's enough moon to wear one.
  function moonPortrait(P, cx, cy, r, cycle, illum, mirror) {
    const defs = '<radialGradient id="' + P + 'mdark" cx="0.4" cy="0.35" r="0.8">' + stop(0, '#4a5478') + stop(1, '#262c48') + '</radialGradient>'
      + '<radialGradient id="' + P + 'mlit" cx="0.38" cy="0.35" r="0.85">' + stop(0, '#fffef4') + stop(0.55, '#f9ecbf') + stop(1, '#e6cb82') + '</radialGradient>'
      + '<radialGradient id="' + P + 'mglow" cx="0.5" cy="0.5" r="0.5">' + stop(0, '#fff3c4', f2(0.12 + 0.45 * illum)) + stop(0.5, '#fff3c4', f2(0.04 + 0.12 * illum)) + stop(1, '#fff3c4', 0) + '</radialGradient>'
      + '<clipPath id="' + P + 'mclip"><path d="' + litPath(cx, cy, r, cycle) + '"/></clipPath>';
    const waxing = cycle < 0.5;
    let g = '<circle cx="' + cx + '" cy="' + cy + '" r="' + f2(r * 2.5) + '" fill="url(#' + P + 'mglow)"/>'
      + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="url(#' + P + 'mdark)"/>';
    for (const c of CRATERS) g += '<circle cx="' + f2(cx + c[0] * r) + '" cy="' + f2(cy + c[1] * r) + '" r="' + f2(c[2] * r) + '" fill="#323a5a" opacity="0.8"/>';
    g += '<path d="' + litPath(cx, cy, r, cycle) + '" fill="url(#' + P + 'mlit)"/>'
      + '<g clip-path="url(#' + P + 'mclip)">';
    for (const c of CRATERS) {
      g += '<circle cx="' + f2(cx + c[0] * r) + '" cy="' + f2(cy + c[1] * r) + '" r="' + f2(c[2] * r) + '" fill="#e9d394" stroke="#d2b46a" stroke-width="' + f2(r * 0.025) + '"/>';
    }
    g += '<ellipse cx="' + f2(cx - r * 0.35) + '" cy="' + f2(cy - r * 0.55) + '" rx="' + f2(r * 0.28) + '" ry="' + f2(r * 0.12) + '" transform="rotate(-25 '
      + f2(cx - r * 0.35) + ' ' + f2(cy - r * 0.55) + ')" fill="#fff" opacity="0.7"/>';
    if (illum >= 0.45) {
      const fx = cx + (waxing ? 1 : -1) * r * (1 - illum) * 0.8;
      g += face('sleepy', '#7a5a26', fx, cy + r * 0.12, r / 24);
    }
    g += '</g><circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#5b6390" stroke-width="1.4"/>'
      + '<path d="' + litPath(cx, cy, r, cycle) + '" fill="none" stroke="#c9a54e" stroke-width="1.4" stroke-linejoin="round"/>';
    if (mirror) g = '<g transform="translate(' + (2 * cx) + ' 0) scale(-1 1)">' + g + '</g>';
    return { defs, g };
  }

  // Tonight's sky: the moon in its phase, the planets above the horizon at
  // `skyMs` placed by direction (facing south up north, north down south) and
  // height, over dark hills with a little observatory.
  //   o = { lat, lon, skyMs, cycle, illum, motion }
  // Returns { svg, planets: [{ name, alt, az }] } (the ones drawn).
  ART.nightSky = function (o) {
    const P = 'alm' + (++artUid).toString(36) + '-';
    const W = 320, H = 190, HZ = 152;
    const south = o.lat >= 0;  // which way you face to see the planets
    const center = south ? 180 : 0;
    let defs = '<linearGradient id="' + P + 'nsky" x1="0" y1="0" x2="0" y2="1">' + stop(0, '#050918') + stop(0.55, '#0f1641') + stop(0.88, '#262e66') + stop(1, '#3b3b78') + '</linearGradient>'
      + '<radialGradient id="' + P + 'band" cx="0.5" cy="0.5" r="0.5">' + stop(0, '#c9d2ff', 0.13) + stop(1, '#c9d2ff', 0) + '</radialGradient>'
      + '<linearGradient id="' + P + 'hill" x1="0" y1="0" x2="0" y2="1">' + stop(0, '#1a2247') + stop(1, '#090d1f') + '</linearGradient>';
    let s = '<rect width="' + W + '" height="' + H + '" fill="url(#' + P + 'nsky)"/>'
      + '<ellipse cx="140" cy="70" rx="190" ry="34" transform="rotate(-24 140 70)" fill="url(#' + P + 'band)"/>';
    const day = Math.floor(o.skyMs / 86400000);
    const rnd = artRng(31 + (day % 997));
    for (let i = 0; i < 90; i++) {
      const x = rnd() * W, y = rnd() * (HZ - 8), r = 0.4 + rnd() * rnd() * 1.4, tw = rnd();
      s += '<circle cx="' + f2(x) + '" cy="' + f2(y) + '" r="' + f2(r) + '" fill="' + (tw > 0.9 ? '#ffe7c4' : tw > 0.8 ? '#cfe0ff' : '#ffffff') + '" opacity="' + f2(0.35 + rnd() * 0.65) + '"'
        + (o.motion && tw < 0.2 ? ' class="alm-twinkle" style="animation-delay:' + f2(-tw * 15) + 's"' : '') + '/>';
    }
    // the moon
    const mp = moonPortrait(P, 248, 64, 38, o.cycle, o.illum, o.lat < 0);
    defs += mp.defs;
    s += mp.g;
    // the planets that are up
    const drawn = [];
    const labels = [];
    for (const name of A.PLANET_ORDER) {
      const pa = A.planetAltAz(name, o.skyMs, o.lat, o.lon);
      if (pa.alt < 1) continue;
      const dAz = norm180(pa.az - center);
      if (Math.abs(dAz) > 115) continue;  // behind you
      const x = 160 + dAz / 115 * 146, y = HZ - 6 - Math.min(pa.alt, 80) / 80 * (HZ - 22);
      const col = PLANET_COL[name], pr = PLANET_R[name];
      defs += '<radialGradient id="' + P + 'p' + name + '" cx="0.5" cy="0.5" r="0.5">' + stop(0, col, 0.7) + stop(1, col, 0) + '</radialGradient>';
      s += '<circle cx="' + f2(x) + '" cy="' + f2(y) + '" r="' + f2(pr * 3.4) + '" fill="url(#' + P + 'p' + name + ')"/>';
      if (name === 'Saturn') {
        s += '<ellipse cx="' + f2(x) + '" cy="' + f2(y) + '" rx="' + f2(pr * 2.1) + '" ry="' + f2(pr * 0.75) + '" transform="rotate(-18 ' + f2(x) + ' ' + f2(y) + ')" fill="none" stroke="' + col + '" stroke-width="1.1"/>';
      }
      s += '<circle cx="' + f2(x) + '" cy="' + f2(y) + '" r="' + f2(pr) + '" fill="' + col + '" stroke="' + mixHex(col, '#000000', 0.35) + '" stroke-width="0.8"/>'
        + '<circle cx="' + f2(x - pr * 0.35) + '" cy="' + f2(y - pr * 0.35) + '" r="' + f2(pr * 0.35) + '" fill="#fff" opacity="0.7"/>';
      labels.push({ x, y: y + pr + 10, text: PLANET_GLYPH[name] + ' ' + name, col });
      drawn.push({ name, alt: pa.alt, az: pa.az });
    }
    // hills, pines and an observatory
    let hill = 'M0 ' + (HZ + 2);
    for (let x = 0; x <= W; x += 20) hill += ' L' + x + ' ' + f2(HZ - 3 + 4 * Math.sin(x / 37 + 1.3) + 2.5 * Math.sin(x / 13));
    hill += ' L' + W + ' ' + H + ' L0 ' + H + 'Z';
    s += '<path d="' + hill + '" fill="url(#' + P + 'hill)" stroke="#2e3870" stroke-width="1.2"/>';
    for (const [x, k] of [[188, 1], [200, 0.75], [286, 0.9], [300, 1.1], [312, 0.8]]) {
      const b = HZ - 1;
      s += '<path d="M' + x + ' ' + f2(b - 15 * k) + ' L' + f2(x + 5 * k) + ' ' + f2(b) + ' L' + f2(x - 5 * k) + ' ' + f2(b) + 'Z" fill="#0c1128" stroke="#2a3366" stroke-width="0.8"/>';
    }
    const ox = 104, oy = HZ - 2;
    s += '<rect x="' + (ox - 9) + '" y="' + (oy - 9) + '" width="18" height="10" rx="1.5" fill="#cfd6ea" stroke="#6b7398" stroke-width="1"/>'
      + '<path d="M' + (ox - 10) + ' ' + (oy - 9) + ' A10 10 0 0 1 ' + (ox + 10) + ' ' + (oy - 9) + 'Z" fill="#e6ebf7" stroke="#6b7398" stroke-width="1"/>'
      + '<path d="M' + (ox + 1) + ' ' + (oy - 18.5) + ' L' + (ox + 4) + ' ' + (oy - 9.5) + ' L' + (ox + 1) + ' ' + (oy - 9.5) + 'Z" fill="#3b4270"/>'
      + '<rect x="' + (ox + 2) + '" y="' + (oy - 25) + '" width="3" height="10" rx="1" transform="rotate(28 ' + (ox + 3) + ' ' + (oy - 16) + ')" fill="#9aa3c4" stroke="#5b6390" stroke-width="0.8"/>'
      + '<rect x="' + (ox - 5) + '" y="' + (oy - 6) + '" width="4" height="5" rx="1" fill="#ffd27a"/>';
    // compass along the horizon
    const dirs = south ? [['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270]] : [['W', 270], ['NW', 315], ['N', 0], ['NE', 45], ['E', 90]];
    for (const [t, az] of dirs) {
      const x = 160 + norm180(az - center) / 115 * 146;
      s += '<text x="' + f2(x) + '" y="' + (H - 6) + '" text-anchor="middle" class="alm-svg-tick">' + t + '</text>';
    }
    // labels under their planets, nudged apart when planets crowd together
    const placed = [];
    labels.sort((a, b) => a.y - b.y);
    for (const l of labels) {
      let x = Math.max(28, Math.min(W - 28, l.x)), y = Math.min(HZ - 4, l.y);
      for (let k = 0; k < 6 && placed.some((q) => Math.abs(q.x - x) < 54 && Math.abs(q.y - y) < 11); k++) {
        y = y + 11 > HZ - 4 ? y - 22 : y + 11;
      }
      placed.push({ x, y });
      s += '<text x="' + f2(x) + '" y="' + f2(y) + '" text-anchor="middle" class="alm-svg-label" style="fill:' + l.col + '">' + l.text + '</text>';
    }
    const svg = '<svg class="alm-scene' + (o.motion ? ' alm-anim' : '') + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Tonight\'s sky" xmlns="http://www.w3.org/2000/svg"><defs>'
      + defs + '</defs>' + s + '</svg>';
    return { svg, planets: drawn };
  };
  global.AlmanacArt = ART;

  // ════════════════════════════════════════════════════════════════════
  // UI  (browser only — bail out cleanly under Node / before the hook loads)
  // ════════════════════════════════════════════════════════════════════
  if (typeof document === 'undefined' || typeof global.ExtrasRegisterTool !== 'function') return;

  const RT = global.ExtrasRegisterTool;
  const U = global.ExtrasUtil || {};
  const tz = () => (U.appTz ? U.appTz() : (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'));

  // ── CSS (no backticks inside this template literal!) ──
  const style = document.createElement('style');
  style.textContent = `
  .alm-tool input {
    padding: 8px; font-size: 14px; border-radius: var(--ui-radius);
    border: 1px solid var(--ui-border); background: var(--ui-input-bg);
    color: var(--ui-text); font-family: inherit; min-width: 0; flex: 1;
  }
  .alm-row { display: flex; justify-content: space-between; gap: 10px; margin: 3px 0; font-size: 14px; }
  .alm-row > span:first-child { color: var(--ui-muted); }
  .alm-row .v { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
  .alm-note { text-align: center; font-size: 12.5px; margin: 4px 0; color: var(--ui-muted); }
  .alm-flag { text-align: center; font-size: 13px; margin: 7px 0; padding: 7px 9px; border-radius: 9px;
    background: var(--ui-accent-soft, rgba(120,140,255,0.13)); line-height: 1.45; }
  .alm-name { text-align: center; font-size: 17px; font-weight: 700; }
  .alm-planets { width: 100%; border-collapse: collapse; font-size: 13px; margin: 4px 0; }
  .alm-planets th, .alm-planets td { padding: 3px 4px; text-align: right; font-variant-numeric: tabular-nums; }
  .alm-planets th:first-child, .alm-planets td:first-child { text-align: left; }
  .alm-planets thead th { color: var(--ui-muted); font-weight: 600; border-bottom: 1px solid var(--ui-border); }
  .alm-up { color: var(--ui-accent); font-weight: 700; }
  .alm-down { color: var(--ui-muted); }
  .orr-wrap { display: flex; justify-content: center; margin: 8px 0 4px; }
  .orr-canvas { width: 100%; max-width: 360px; height: auto; border-radius: 12px; background: #070a12; display: block; touch-action: pan-y; }
  .orr-when { text-align: center; font-size: 13px; font-weight: 600; margin: 2px 0 6px; font-variant-numeric: tabular-nums; }
  .orr-slider { width: 100%; margin: 2px 0 8px; }
  .orr-legend { display: flex; flex-wrap: wrap; gap: 3px 12px; justify-content: center; font-size: 12px; margin: 4px 0 2px; }
  .orr-leg { white-space: nowrap; }
  /* hand-drawn heroes (Sun: the day's path; Astronomy: tonight's sky) */
  .alm-hero {
    position: relative; overflow: hidden; height: 0; padding-top: 59.375%;
    border-radius: 18px; margin: 2px 0 10px; box-shadow: var(--ui-shadow); background: #151d48;
  }
  .alm-hero .alm-scene { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .alm-hero-text {
    position: absolute; left: 12px; top: 9px; right: 42%; pointer-events: none;
    color: #ffffff; text-shadow: 0 1px 3px rgba(5, 10, 30, 0.6); line-height: 1.2;
  }
  .alm-hero-text b { display: block; font-size: 17px; font-weight: 700; }
  .alm-hero-text span { display: block; font-size: 12px; opacity: 0.92; margin-top: 2px; }
  .alm-svg-label {
    font: 600 9.5px system-ui, -apple-system, sans-serif; fill: #ffffff;
    paint-order: stroke; stroke: rgba(8, 12, 32, 0.75); stroke-width: 2.6px; stroke-linejoin: round;
  }
  .alm-svg-tick { font: 600 8.5px system-ui, -apple-system, sans-serif; fill: rgba(255, 255, 255, 0.72); }
  .alm-anim .alm-spin { transform-box: fill-box; transform-origin: center; animation: alm-spin 48s linear infinite; }
  .alm-anim .alm-twinkle { animation: alm-twinkle 3.2s ease-in-out infinite; }
  @keyframes alm-spin { to { transform: rotate(360deg); } }
  @keyframes alm-twinkle { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .alm-anim, .alm-anim * { animation: none !important; } }
  `;
  document.head.appendChild(style);

  // ── shared formatting / helpers ──
  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compass = (az) => COMPASS[Math.round(norm360(az) / 22.5) % 16];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthName = (m) => MONTHS[m - 1];
  const rowH = (l, v) => '<div class="alm-row"><span>' + l + '</span><span class="v">' + v + '</span></div>';
  const subH = (t) => '<div class="xt-subhead">' + t + '</div>';
  const noteH = (t) => '<div class="alm-note">' + t + '</div>';
  const flagH = (t) => '<div class="alm-flag">' + t + '</div>';
  const fmtMs = (ms) => (U.fmtClock ? U.fmtClock(ms, tz()) : new Date(ms).toUTCString());
  const fmtDateMs = (ms) => new Intl.DateTimeFormat(undefined, { timeZone: tz(), month: 'short', day: 'numeric' }).format(ms);
  const fmtFull = (ms) => { try { return new Intl.DateTimeFormat(undefined, { timeZone: tz(), weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(ms); } catch (_) { return new Date(ms).toDateString(); } };
  const utMin = (dt, min) => fmtMs(Date.UTC(dt.y, dt.mo - 1, dt.d) + Math.round(min * 60000));
  const fmtLat = (l) => Math.abs(l).toFixed(2) + '° ' + (l >= 0 ? 'N' : 'S');
  const fmtLon = (l) => { const x = norm180(l); return Math.abs(x).toFixed(2) + '° ' + (x >= 0 ? 'E' : 'W'); };
  const hm = (min) => Math.floor(min / 60) + ' h ' + String(Math.round(min % 60)).padStart(2, '0') + ' min';
  const fmtHours = (h) => String(Math.floor(h)).padStart(2, '0') + ':' + String(Math.floor((h % 1) * 60)).padStart(2, '0');
  function deltaStr(min) {
    const s = Math.round(Math.abs(min) * 60), mm = Math.floor(s / 60), ss = s % 60;
    const mag = mm ? mm + ' min ' + String(ss).padStart(2, '0') + ' s' : ss + ' s';
    return mag + ' ' + (min >= 0 ? 'longer' : 'shorter');
  }
  function until(ms) {
    const days = (ms - Date.now()) / 86400000;
    if (days < 0) return 'now';
    if (days < 1 / 24) return 'soon';
    if (days < 1) return 'in ' + Math.round(days * 24) + ' h';
    if (days < 45) return 'in ' + Math.round(days) + ' days';
    return 'in ' + Math.round(days / 30.44) + ' months';
  }
  function roman(n) {
    if (n <= 0) return '' + n;
    const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    let out = ''; for (const [v, s] of map) while (n >= v) { out += s; n -= v; } return out;
  }
  const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };

  // location header markup + readers
  const LOC_ROW = '<div class="xt-row"><input type="number" class="alm-lat" step="any" min="-90" max="90" inputmode="decimal" placeholder="latitude" aria-label="latitude"><input type="number" class="alm-lon" step="any" min="-180" max="180" inputmode="decimal" placeholder="longitude" aria-label="longitude"><button class="xt-mini alm-loc" type="button" title="use map position">📍</button></div>';
  const DATE_ROW = '<div class="xt-row"><input type="date" class="alm-date" aria-label="date"><button class="xt-mini alm-today" type="button">today</button></div>';
  function readLoc(view) {
    const la = view.querySelector('.alm-lat'), lo = view.querySelector('.alm-lon');
    const lat = parseFloat(la.value), lon = parseFloat(lo.value);
    if (isFinite(lat) && isFinite(lon)) return { lat, lon };
    return U.getMapLoc ? U.getMapLoc() : null;
  }
  function fillLocFromMap(view) {
    const m = U.getMapLoc && U.getMapLoc();
    if (!m) return false;
    view.querySelector('.alm-lat').value = m.lat.toFixed(4);
    view.querySelector('.alm-lon').value = m.lon.toFixed(4);
    return true;
  }
  function ensureLoc(view) {
    const la = view.querySelector('.alm-lat'), lo = view.querySelector('.alm-lon');
    if (la && la.value === '' && lo.value === '') fillLocFromMap(view);
  }
  const LOC_HINT = '<span class="xt-muted">pan the map to your spot and tap 📍 — or type a lat/lon</span>';

  const PHASE_NAMES = [[0.02, '🌑', 'New moon'], [0.23, '🌒', 'Waxing crescent'], [0.27, '🌓', 'First quarter'],
    [0.48, '🌔', 'Waxing gibbous'], [0.52, '🌕', 'Full moon'], [0.73, '🌖', 'Waning gibbous'],
    [0.77, '🌗', 'Last quarter'], [0.98, '🌘', 'Waning crescent'], [1.01, '🌑', 'New moon']];
  const phaseName = (c) => { for (const [lim, e, n] of PHASE_NAMES) if (c < lim) return [e, n]; return ['🌑', 'New moon']; };
  const FULL_MOON_NAMES = ['Wolf Moon', 'Snow Moon', 'Worm Moon', 'Pink Moon', 'Flower Moon', 'Strawberry Moon',
    'Buck Moon', 'Sturgeon Moon', 'Corn Moon', 'Hunter Moon', 'Beaver Moon', 'Cold Moon'];
  const PLANET_SYM = { Mercury: '☿', Venus: '♀', Mars: '♂', Jupiter: '♃', Saturn: '♄', Uranus: '♅', Neptune: '♆', Sun: '☉', Moon: '☽' };

  // ── top-down heliocentric orrery (drawn on a canvas by the Astronomy tool) ──
  const ORR_COL = { Mercury: '#b9b2a6', Venus: '#e7cd86', Earth: '#5b8dd6', Mars: '#d15f3c', Jupiter: '#d9a878', Saturn: '#e6d29a', Uranus: '#8fd6db', Neptune: '#5566d4' };
  const ORR_SYM = { Mercury: '☿', Venus: '♀', Earth: '⊕', Mars: '♂', Jupiter: '♃', Saturn: '♄', Uranus: '♅', Neptune: '♆' };
  const ORR_DOT = { Mercury: 2.6, Venus: 3.2, Earth: 3.3, Mars: 2.8, Jupiter: 5.2, Saturn: 4.6, Uranus: 3.9, Neptune: 3.9 };
  // log radial scale so Mercury (0.39 AU) and Neptune (30 AU) both stay visible.
  const ORR_LO = Math.log(0.34), ORR_SPAN = Math.log(31) - ORR_LO;
  const orrRadius = (au, R0) => R0 * (0.11 + 0.89 * (Math.log(au) - ORR_LO) / ORR_SPAN);
  function drawOrrery(ctx, size, jde) {
    const cx = size / 2, cy = size / 2, R0 = size / 2 - 20;
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
    bg.addColorStop(0, '#141a2e'); bg.addColorStop(1, '#070a12');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, size, size);
    // reference direction: ecliptic longitude 0 deg (vernal equinox), pointing right
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + R0, cy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText('0°', cx + R0 - 1, cy - 7);
    // orbit rings
    for (const name of A.HELIO_ORDER) {
      const rr = orrRadius(A.PLANET_A[name], R0);
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, 2 * Math.PI);
      ctx.strokeStyle = name === 'Earth' ? 'rgba(120,170,235,0.55)' : 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 1; ctx.stroke();
    }
    // Sun
    const sg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 10);
    sg.addColorStop(0, '#fff4c2'); sg.addColorStop(0.5, '#ffd23f'); sg.addColorStop(1, 'rgba(255,180,40,0)');
    ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(cx, cy, 10, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = '#ffe27a'; ctx.beginPath(); ctx.arc(cx, cy, 3.2, 0, 2 * Math.PI); ctx.fill();
    // planets
    ctx.font = '12px system-ui, sans-serif'; ctx.textBaseline = 'middle';
    for (const name of A.HELIO_ORDER) {
      const h = A.helio(name, jde), rr = orrRadius(h.r, R0), ang = h.lon * Math.PI / 180;
      const px = cx + rr * Math.cos(ang), py = cy - rr * Math.sin(ang), dr = ORR_DOT[name];
      if (name === 'Saturn') {
        ctx.strokeStyle = 'rgba(230,210,154,0.85)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(px, py, dr + 3.2, (dr + 3.2) * 0.42, -0.5, 0, 2 * Math.PI); ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(px, py, dr, 0, 2 * Math.PI); ctx.fillStyle = ORR_COL[name]; ctx.fill();
      if (name === 'Earth') { ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1; ctx.stroke(); }
      // symbol label, nudged radially outward and clamped inside the canvas
      const lo = dr + 9, lx = Math.max(9, Math.min(size - 9, px + Math.cos(ang) * lo));
      const ly = Math.max(9, Math.min(size - 9, py - Math.sin(ang) * lo));
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillText(ORR_SYM[name], lx + 0.7, ly + 0.7);
      ctx.fillStyle = ORR_COL[name]; ctx.fillText(ORR_SYM[name], lx, ly);
    }
  }

  // next new/full-moon instant strictly after ms
  function nextPhaseAfter(ms, phase) {
    const k0 = Math.floor(A.lunationK(ms));
    for (let i = 0; i < 3; i++) { const j = A.lunation(k0 + i, phase); const t = A.msFromJd(j - A.deltaTSeconds(j) / 86400); if (t > ms) return t; }
    const j = A.lunation(k0 + 1, phase); return A.msFromJd(j - A.deltaTSeconds(j) / 86400);
  }
  function phaseInstantsInRange(a, b, phase) {
    const out = []; const k0 = Math.floor(A.lunationK(a)) - 1;
    for (let i = 0; i < 4; i++) { const j = A.lunation(k0 + i, phase); const t = A.msFromJd(j - A.deltaTSeconds(j) / 86400); if (t >= a && t < b) out.push(t); }
    return out.sort((x, y) => x - y);
  }
  function blueBlackMoon(ms) {
    const d = new Date(ms), y = d.getUTCFullYear(), mo = d.getUTCMonth();
    const a = Date.UTC(y, mo, 1), b = Date.UTC(y, mo + 1, 1);
    const fulls = phaseInstantsInRange(a, b, 0.5), news = phaseInstantsInRange(a, b, 0);
    if (fulls.length >= 2) return '🔵 Blue Moon this month — a 2nd full moon on ' + fmtDateMs(fulls[1]);
    if (news.length >= 2) return '⚫ Black Moon this month — a 2nd new moon on ' + fmtDateMs(news[1]);
    return null;
  }

  // ── heroes ──
  const motionOK = () => !(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const hourLabel = (h) => (U.clock12 && U.clock12() ? ((h % 12) || 12) + (h < 12 ? ' AM' : ' PM') : String(h).padStart(2, '0') + ':00');
  // Local midnight of the chosen date, and "now" moved onto that date.
  function dayFrame(dt, now) {
    const zone = tz();
    const day0 = U.epochFromWall(zone, dt.y, dt.mo, dt.d, 0, 0);
    const w = U.wallParts(now, zone);
    return { day0, at: U.epochFromWall(zone, dt.y, dt.mo, dt.d, w.h, w.mi), today: w.y === dt.y && w.mo === dt.mo && w.d === dt.d };
  }
  function renderSunHero(hero, dt, lat, lon, now) {
    const f = dayFrame(dt, now);
    const r = ART.sunPath({ lat, lon, day0: f.day0, nowMs: f.at, fmt: fmtMs, hourLabel, motion: motionOK() });
    let big, small;
    if (r.rise != null && r.set != null) big = hm((r.set - r.rise) / 60000) + ' of daylight';
    else big = r.noonAlt > 0 ? 'Midnight sun' : 'Polar night';
    const aa = A.sunAltAz(f.at, lat, lon);
    if (!f.today) small = 'Sun at ' + fmtMs(f.at) + ': ' + Math.round(aa.alt) + '°';
    else if (aa.alt > -0.833) small = 'Sun ' + Math.round(aa.alt) + '° up in the ' + compass(aa.az);
    else if (r.rise != null && r.rise > now) small = 'Sunrise in ' + hm((r.rise - now) / 60000);
    else small = 'The sun has set';
    hero.innerHTML = r.svg + '<div class="alm-hero-text"><b>' + big + '</b><span>' + small + '</span></div>';
    hero.hidden = false;
  }
  // The sky "tonight": right now if it's dark, else an hour after the evening's
  // nautical dusk (10 pm local when the sun never gets that low).
  function skyTime(dt, lat, lon, now) {
    const f = dayFrame(dt, now);
    if (f.today && A.sunAltAz(now, lat, lon).alt < -6) return { ms: now, now: true };
    const base = Date.UTC(dt.y, dt.mo - 1, dt.d);
    const nau = A.sunEventsUTC(dt.y, dt.mo, dt.d, lat, lon, -12);
    let ms = !nau.polar && nau.set != null ? base + nau.set * 60000 + 3600000 : f.day0 + 22 * 3600000;
    if (ms < f.day0 + 12 * 3600000) ms += 86400000;  // west of Greenwich the UT date's dusk can land early
    return { ms, now: false };
  }
  function renderSkyHero(hero, dt, lat, lon, now, ph, pn) {
    const st = skyTime(dt, lat, lon, now);
    const r = ART.nightSky({ lat, lon, skyMs: st.ms, cycle: ph.cycle, illum: ph.illum, motion: motionOK() });
    const up = r.planets.map((p) => p.name);
    hero.innerHTML = r.svg + '<div class="alm-hero-text"><b>' + pn[1] + '</b><span>' + Math.round(ph.illum * 100) + '% lit</span>'
      + '<span>' + (st.now ? 'The sky now' : 'Sky at ' + fmtMs(st.ms)) + (up.length ? ' · ' + up.length + ' planet' + (up.length > 1 ? 's' : '') + ' up' : '') + '</span></div>';
    hero.hidden = false;
  }

  // ════════════════════════════════ SUN TOOL ════════════════════════════════
  function buildSun(view) {
    view.classList.add('alm-tool');
    view.innerHTML = '<div class="alm-hero" hidden></div>' + DATE_ROW + LOC_ROW + '<div class="xt-card alm-out">' + LOC_HINT + '</div>';
    const out = view.querySelector('.alm-out'), dateEl = view.querySelector('.alm-date');
    const hero = view.querySelector('.alm-hero');
    dateEl.value = U.todayStr();
    function compute() {
      const dt = U.parseDateInput(dateEl.value), loc = readLoc(view);
      if (!dt || !loc) { out.innerHTML = LOC_HINT; hero.hidden = true; return; }
      const lat = loc.lat, lon = loc.lon, now = Date.now();
      renderSunHero(hero, dt, lat, lon, now);
      const E = (alt) => A.sunEventsUTC(dt.y, dt.mo, dt.d, lat, lon, alt);
      const off = E(-0.833), civ = E(-6), nau = E(-12), ast = E(-18), g6 = E(6), gm4 = E(-4);
      let h = '';
      // sun right now
      const aa = A.sunAltAz(now, lat, lon);
      h += subH('☀️ Sun right now');
      h += rowH('altitude', aa.alt.toFixed(1) + '°' + (aa.alt < 0 ? ' (below horizon)' : ''));
      h += rowH('azimuth', aa.az.toFixed(1) + '° ' + compass(aa.az));
      // twilight ladder
      h += subH('🌅 Twilight & daylight');
      if (off.polar === 'above') h += noteH('☀️ midnight sun — the sun never sets today');
      else if (off.polar === 'below') h += noteH('🌙 polar night — the sun stays below the horizon');
      if (!ast.polar) h += rowH('astronomical dawn', utMin(dt, ast.rise));
      if (!nau.polar) h += rowH('nautical dawn', utMin(dt, nau.rise));
      if (!civ.polar) h += rowH('civil dawn', utMin(dt, civ.rise));
      if (!off.polar) h += rowH('🌅 sunrise', utMin(dt, off.rise));
      const noonMs = Date.UTC(dt.y, dt.mo - 1, dt.d) + off.noon * 60000;
      h += rowH('☀️ solar noon', utMin(dt, off.noon) + ' · ' + A.sunAltAz(noonMs, lat, lon).alt.toFixed(1) + '° high');
      if (!off.polar) h += rowH('🌇 sunset', utMin(dt, off.set));
      if (!civ.polar) h += rowH('civil dusk', utMin(dt, civ.set));
      if (!nau.polar) h += rowH('nautical dusk', utMin(dt, nau.set));
      if (!ast.polar) h += rowH('astronomical dusk', utMin(dt, ast.set));
      if (!off.polar) {
        const len = off.set - off.rise;
        h += rowH('day length', hm(len));
        const yd = new Date(Date.UTC(dt.y, dt.mo - 1, dt.d) - 86400000);
        const yE = A.sunEventsUTC(yd.getUTCFullYear(), yd.getUTCMonth() + 1, yd.getUTCDate(), lat, lon, -0.833);
        if (!yE.polar) h += rowH('vs yesterday', deltaStr(len - (yE.set - yE.rise)));
      }
      // golden / blue hour
      h += subH('✨ Golden & blue hour');
      if (!off.polar && !civ.polar && !g6.polar && !gm4.polar) {
        h += rowH('morning blue', utMin(dt, civ.rise) + ' – ' + utMin(dt, gm4.rise));
        h += rowH('morning golden', utMin(dt, gm4.rise) + ' – ' + utMin(dt, g6.rise));
        h += rowH('evening golden', utMin(dt, g6.set) + ' – ' + utMin(dt, gm4.set));
        h += rowH('evening blue', utMin(dt, gm4.set) + ' – ' + utMin(dt, civ.set));
      } else h += noteH('the sun stays too low or too high for a normal golden hour');
      // sun & earth
      h += subH('🕐 Sun & Earth');
      const eot = A.equationOfTimeMin(A.jde(A.jdFromMs(now))), ea = Math.abs(eot);
      h += rowH('equation of time', (eot >= 0 ? '+' : '−') + Math.floor(ea) + ' min ' + String(Math.round((ea % 1) * 60)).padStart(2, '0') + ' s');
      h += rowH('sundial vs clock', eot >= 0 ? 'sundial runs ahead' : 'sundial runs behind');
      const ss = A.subSolarPoint(now);
      h += rowH('sub-solar point', fmtLat(ss.lat) + ', ' + fmtLon(ss.lon));
      h += rowH('solar noon now at', fmtLon(ss.noonLon) + ' meridian');
      h += rowH('solar midnight now at', fmtLon(ss.midnightLon) + ' meridian');
      // seasons
      h += subH('🍂 Seasons');
      const evs = [];
      for (const Y of [new Date(now).getUTCFullYear() - 1, new Date(now).getUTCFullYear(), new Date(now).getUTCFullYear() + 1]) {
        const s = A.seasonsForYear(Y);
        evs.push(['March equinox', s.marEquinox], ['June solstice', s.junSolstice], ['September equinox', s.sepEquinox], ['December solstice', s.decSolstice]);
      }
      evs.sort((a, b) => a[1] - b[1]);
      let prev = null, next = null;
      for (const e of evs) { if (e[1] <= now) prev = e; else { next = e; break; } }
      const NHEM = { 'March equinox': 'Spring', 'June solstice': 'Summer', 'September equinox': 'Autumn', 'December solstice': 'Winter' };
      const FLIP = { Spring: 'Autumn', Summer: 'Winter', Autumn: 'Spring', Winter: 'Summer' };
      if (prev && next) {
        let cur = NHEM[prev[0]]; if (lat < 0) cur = FLIP[cur];
        h += rowH('current season', cur + ' · ' + ((now - prev[1]) / (next[1] - prev[1]) * 100).toFixed(0) + '% through');
        h += rowH('next: ' + next[0], fmtDateMs(next[1]) + ' · ' + until(next[1]));
      }
      // planetary hour
      h += subH('🪐 Planetary hour');
      h += planetaryHourRows(lat, lon, now);
      // your place on earth
      h += subH('🌍 Your place on Earth');
      const ap = A.antipode(lat, lon);
      h += rowH('antipode', fmtLat(ap.lat) + ', ' + fmtLon(ap.lon));
      h += rowH('distance to equator', Math.round(A.distToEquatorKm(lat)).toLocaleString() + ' km');
      h += rowH('distance to ' + A.nearestPole(lat) + ' Pole', Math.round(A.distToPoleKm(lat)).toLocaleString() + ' km');
      out.innerHTML = h;
    }
    const slow = debounce(compute, 250);
    view.querySelector('.alm-today').onclick = () => { dateEl.value = U.todayStr(); compute(); };
    view.querySelector('.alm-loc').onclick = () => { fillLocFromMap(view); compute(); };
    view.querySelectorAll('.alm-date, .alm-lat, .alm-lon').forEach((el) => el.addEventListener('input', slow));
    return { compute, view };
  }
  function planetaryHourRows(lat, lon, now) {
    const dN = new Date(now), y0 = dN.getUTCFullYear(), m0 = dN.getUTCMonth() + 1, d0 = dN.getUTCDate(), base = Date.UTC(y0, m0 - 1, d0);
    const tod = A.sunEventsUTC(y0, m0, d0, lat, lon, -0.833);
    if (tod.polar) return noteH('planetary hours need a sunrise and sunset');
    const riseMs = base + tod.rise * 60000, setMs = base + tod.set * 60000;
    const tm = new Date(base + 86400000), tR = A.sunEventsUTC(tm.getUTCFullYear(), tm.getUTCMonth() + 1, tm.getUTCDate(), lat, lon, -0.833);
    const ys = new Date(base - 86400000), yR = A.sunEventsUTC(ys.getUTCFullYear(), ys.getUTCMonth() + 1, ys.getUTCDate(), lat, lon, -0.833);
    let fRise, fSet, fEnd, wd;
    if (now < riseMs && !yR.polar) {
      fRise = base - 86400000 + yR.rise * 60000; fSet = base - 86400000 + yR.set * 60000; fEnd = riseMs;
      wd = A.dayOfWeek(ys.getUTCFullYear(), ys.getUTCMonth() + 1, ys.getUTCDate());
    } else {
      fRise = riseMs; fSet = setMs; fEnd = !tR.polar ? base + 86400000 + tR.rise * 60000 : setMs + (setMs - riseMs); wd = A.dayOfWeek(y0, m0, d0);
    }
    const hrs = A.planetaryHours(0, (fSet - fRise) / 60000, (fEnd - fRise) / 60000, wd);
    const off = (now - fRise) / 60000;
    const cur = hrs.find((x) => off >= x.startMin && off < x.endMin) || hrs[hrs.length - 1];
    return rowH('ruling planet now', PLANET_SYM[cur.planet] + ' ' + cur.planet + (cur.night ? ' (night)' : ' (day)'))
      + rowH('this hour ends', fmtMs(fRise + cur.endMin * 60000));
  }

  // ════════════════════════════ ASTRONOMY TOOL ═══════════════════════════════
  function buildAstro(view) {
    view.classList.add('alm-tool');
    view.innerHTML = '<div class="alm-hero" hidden></div>' + DATE_ROW + LOC_ROW + '<div class="xt-card alm-out">' + LOC_HINT + '</div>'
      + '<div class="xt-divider"></div>'
      + subH('🪐 Solar-system map — top-down, Sun at centre')
      + noteH('where every planet sits in its orbit · distances on a log scale so all are visible')
      + '<div class="orr-wrap"><canvas class="orr-canvas"></canvas></div>'
      + '<div class="orr-when"></div>'
      + '<input type="range" class="orr-slider" min="-60" max="60" step="1" value="0" aria-label="days from the map date">'
      + '<div class="xt-row"><input type="date" class="orr-date" aria-label="map date"><button class="xt-mini orr-now" type="button">now</button></div>'
      + '<div class="orr-legend"></div>'
      + '<div class="xt-divider"></div>'
      + subH('🛸 Your age & weight across the solar system')
      + '<div class="xt-row"><input type="date" class="alm-bday" aria-label="birth date"><input type="number" class="alm-wt" step="any" min="0" inputmode="decimal" placeholder="your weight"></div>'
      + '<div class="xt-card alm-worlds"></div>';
    const out = view.querySelector('.alm-out'), dateEl = view.querySelector('.alm-date');
    const hero = view.querySelector('.alm-hero');
    const bEl = view.querySelector('.alm-bday'), wEl = view.querySelector('.alm-wt'), worlds = view.querySelector('.alm-worlds');
    dateEl.value = U.todayStr();
    try { const saved = JSON.parse(localStorage.getItem('cc.almanac') || '{}'); if (saved.bday) bEl.value = saved.bday; if (saved.wt) wEl.value = saved.wt; } catch (e) { /* ignore */ }

    // ── top-down solar-system orrery (its own map date + day slider) ──
    const orrCanvas = view.querySelector('.orr-canvas'), orrCtx = orrCanvas.getContext('2d');
    const orrSlider = view.querySelector('.orr-slider'), orrDateEl = view.querySelector('.orr-date');
    const orrWhen = view.querySelector('.orr-when'), orrLegend = view.querySelector('.orr-legend');
    orrDateEl.value = U.todayStr();
    function orrShownMs() {
      const dt = U.parseDateInput(orrDateEl.value);
      const base = dt ? Date.UTC(dt.y, dt.mo - 1, dt.d, 12) : Date.now();
      return base + parseFloat(orrSlider.value || '0') * 86400000;
    }
    function renderOrr() {
      const size = Math.min(view.clientWidth || 0, 360);
      if (size < 40) return; // hidden / not laid out yet
      const dpr = Math.min(global.devicePixelRatio || 1, 3);
      orrCanvas.style.width = size + 'px'; orrCanvas.style.height = size + 'px';
      orrCanvas.width = Math.round(size * dpr); orrCanvas.height = Math.round(size * dpr);
      orrCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const ms = orrShownMs(), off = parseFloat(orrSlider.value || '0'), jde = A.jde(A.jdFromMs(ms));
      drawOrrery(orrCtx, size, jde);
      orrWhen.textContent = fmtFull(ms) + (off ? '  (' + (off > 0 ? '+' : '−') + Math.abs(off) + ' d)' : '');
      let leg = '';
      for (const nm of A.HELIO_ORDER) {
        const hp = A.helio(nm, jde);
        leg += '<span class="orr-leg"><b style="color:' + ORR_COL[nm] + '">' + ORR_SYM[nm] + ' ' + nm + '</b> '
          + '<span class="xt-muted">' + hp.r.toFixed(2) + ' AU · ' + Math.round(hp.lon) + '°</span></span>';
      }
      orrLegend.innerHTML = leg;
    }
    orrSlider.addEventListener('input', renderOrr);
    orrDateEl.addEventListener('input', () => { orrSlider.value = '0'; renderOrr(); });
    view.querySelector('.orr-now').onclick = () => { orrDateEl.value = U.todayStr(); orrSlider.value = '0'; renderOrr(); };

    function compute() {
      const dt = U.parseDateInput(dateEl.value), loc = readLoc(view);
      if (!dt || !loc) { out.innerHTML = LOC_HINT; hero.hidden = true; return; }
      const lat = loc.lat, lon = loc.lon, now = Date.now();
      const noonMs = Date.UTC(dt.y, dt.mo - 1, dt.d, 12), jde = A.jde(A.jdFromMs(noonMs));
      let h = '';
      // moon (pictured in the hero)
      const ph = A.moonPhase(jde), pn = phaseName(ph.cycle);
      renderSkyHero(hero, dt, lat, lon, now, ph, pn);
      h += '<div class="alm-name">' + pn[0] + ' ' + pn[1] + '</div>';
      h += noteH(Math.round(ph.illum * 100) + '% illuminated' + (lat < 0 ? ' · southern-sky view' : ''));
      h += rowH('moon age', (ph.cycle * 29.53).toFixed(1) + ' days');
      const mev = A.moonEventsUTC(dt.y, dt.mo, dt.d, lat, lon);
      h += rowH('🌙 moonrise', mev.rise != null ? utMin(dt, mev.rise) : '—');
      h += rowH('🌙 moonset', mev.set != null ? utMin(dt, mev.set) : '—');
      h += rowH('distance', Math.round(ph.dist).toLocaleString() + ' km');
      const nf = nextPhaseAfter(noonMs, 0.5), nn = nextPhaseAfter(noonMs, 0);
      h += rowH('next 🌕 full', fmtDateMs(nf) + ' · ' + until(nf));
      h += rowH('next 🌑 new', fmtDateMs(nn) + ' · ' + until(nn));
      h += rowH('full moon name', FULL_MOON_NAMES[new Date(nf).getUTCMonth()]);
      const fd = A.moonPhase(A.jde(A.jdFromMs(nf))).dist;
      if (fd < 360000) h += flagH('🌝 the next full moon is a Supermoon (' + Math.round(fd).toLocaleString() + ' km — near perigee)');
      else if (fd > 405000) h += flagH('🌚 the next full moon is a Micromoon (' + Math.round(fd).toLocaleString() + ' km — near apogee)');
      const bb = blueBlackMoon(noonMs); if (bb) h += flagH(bb);
      // planets
      const dark = A.sunAltAz(now, lat, lon).alt < -6;
      h += subH('🔭 Planets ' + (dark ? 'right now' : '(positions now)'));
      h += '<table class="alm-planets"><thead><tr><th>planet</th><th>alt</th><th>dir</th><th>mag</th><th>in</th></tr></thead><tbody>';
      for (const p of A.PLANET_ORDER) {
        const pa = A.planetAltAz(p, now, lat, lon), up = pa.alt > 0;
        h += '<tr><td>' + PLANET_SYM[p] + ' ' + p + '</td>'
          + '<td class="' + (up ? 'alm-up' : 'alm-down') + '">' + pa.alt.toFixed(0) + '°</td>'
          + '<td>' + (up ? compass(pa.az) : '—') + '</td>'
          + '<td>' + pa.mag + '</td><td>' + pa.constellation + '</td></tr>';
      }
      h += '</tbody></table>' + noteH('alt = height above the horizon now; “in” = constellation');
      // mercury retrograde
      h += subH('☿ Mercury retrograde');
      const rg = A.retrograde('Mercury', now);
      h += rowH('status', rg.retrograde ? '⟲ retrograde' : 'direct');
      h += rowH(rg.retrograde ? 'goes direct' : 'next retrograde', fmtDateMs(rg.nextStationMs) + ' · ' + until(rg.nextStationMs));
      const yr = new Date(now).getUTCFullYear();
      const wins = A.retrogradeWindows('Mercury', Date.UTC(yr, 0, 1), Date.UTC(yr + 1, 0, 1));
      if (wins.length) h += noteH(yr + ': ' + wins.map((w) => fmtDateMs(w.startMs) + '–' + (w.endMs ? fmtDateMs(w.endMs) : '…')).join(', '));
      // meteor showers
      h += subH('☄️ Meteor showers');
      const act = A.activeShowers(now);
      for (const a of act) {
        const pct = Math.round(a.moonIllum * 100);
        const sky = a.moonIllum < 0.3 ? 'dark skies 🌑' : (a.moonIllum < 0.65 ? 'some moonlight' : 'moon-washed');
        h += rowH(a.shower.name, 'ZHR ~' + a.shower.zhr + ' · peak ' + fmtDateMs(a.peakMs) + ' · ' + until(a.peakMs));
        h += noteH('moon at peak ' + pct + '% — ' + sky + ' · debris of ' + a.shower.parent);
      }
      if (!act.length) {
        const nx = A.nextShowerPeak(now);
        if (nx) h += noteH('none active — next: ' + nx.shower.name + ', peak ' + fmtDateMs(nx.peakMs) + ' · ' + until(nx.peakMs));
      } else h += noteH('active radiants also appear on the Sky Map');
      // eclipses
      h += subH('🌑 Eclipses (computed for your location)');
      const se = A.nextSolarEclipse(now);
      if (se) {
        h += rowH('next solar', fmtDateMs(se.dateMs) + ' · ' + se.category + (se.magnitude ? ' (mag ' + se.magnitude.toFixed(2) + ')' : ''));
        const el = A.solarEclipseLocal(se, lat, lon);
        if (el.visible) h += flagH('☀️ visible from you — ' + el.type + ' eclipse, magnitude ' + el.magnitude.toFixed(2) + (el.maxMs ? ', max at ' + fmtMs(el.maxMs) : ''));
        else h += noteH('not visible from your location');
      }
      const le = A.nextLunarEclipse(now);
      if (le) {
        h += rowH('next lunar', fmtDateMs(le.dateMs) + ' · ' + le.category);
        const ll = A.lunarEclipseLocal(le, lat, lon);
        h += ll.visible ? flagH('🌕 visible from you — the Moon is ' + ll.altAtMax.toFixed(0) + '° up at greatest eclipse')
          : noteH('not visible — the Moon is below your horizon during it');
      }
      out.innerHTML = h;
    }
    function computeWorlds() {
      try { localStorage.setItem('cc.almanac', JSON.stringify({ bday: bEl.value, wt: wEl.value })); } catch (e) { /* ignore */ }
      const msd = A.marsSolDate(Date.now());
      let h = rowH('Mars Sol Date', Math.floor(msd.msd).toLocaleString() + ' · Mars time ' + fmtHours(msd.mtcHours));
      const bdt = U.parseDateInput(bEl.value), wt = parseFloat(wEl.value);
      if (bdt) {
        const ageDays = (Date.now() - Date.UTC(bdt.y, bdt.mo - 1, bdt.d)) / 86400000;
        h += '<table class="alm-planets"><thead><tr><th>world</th><th>your age</th>' + (isFinite(wt) ? '<th>weight</th>' : '') + '</tr></thead><tbody>';
        for (const w of A.WORLDS) {
          const ageStr = isFinite(w.days) ? (ageDays / w.days).toFixed(w.days > 3000 ? 2 : 1) + ' yr' : '—';
          h += '<tr><td>' + (PLANET_SYM[w.name] ? PLANET_SYM[w.name] + ' ' : '') + w.name + '</td><td>' + ageStr + '</td>'
            + (isFinite(wt) ? '<td>' + (wt * w.g).toFixed(1) + '</td>' : '') + '</tr>';
        }
        h += '</tbody></table>' + noteH('weight = your number × each world’s surface gravity');
      } else h += noteH('enter your birth date (and weight) above');
      worlds.innerHTML = h;
    }
    const slow = debounce(compute, 280);
    view.querySelector('.alm-today').onclick = () => { dateEl.value = U.todayStr(); compute(); };
    view.querySelector('.alm-loc').onclick = () => { fillLocFromMap(view); compute(); };
    view.querySelectorAll('.alm-date, .alm-lat, .alm-lon').forEach((el) => el.addEventListener('input', slow));
    [bEl, wEl].forEach((el) => el.addEventListener('input', debounce(computeWorlds, 200)));
    return { compute: () => { compute(); computeWorlds(); renderOrr(); }, view };
  }

  // ════════════════════════════ CALENDAR TOOL ════════════════════════════════
  function buildCal(view) {
    view.classList.add('alm-tool');
    view.innerHTML = DATE_ROW + '<div class="xt-card alm-out"></div>';
    const out = view.querySelector('.alm-out'), dateEl = view.querySelector('.alm-date');
    dateEl.value = U.todayStr();
    function compute() {
      const dt = U.parseDateInput(dateEl.value); if (!dt) return;
      const y = dt.y, mo = dt.mo, d = dt.d, rd = A.gregToRD(y, mo, d), noonMs = Date.UTC(y, mo - 1, d, 12);
      let h = '';
      h += subH('📅 ' + WEEKDAYS[A.dayOfWeek(y, mo, d)] + ', ' + monthName(mo) + ' ' + d + ', ' + y);
      const doy = A.dayOfYear(y, mo, d), diy = A.daysInYear(y);
      h += rowH('day of year', doy + ' of ' + diy + ' · ' + (doy / diy * 100).toFixed(0) + '% through');
      h += rowH('days left in year', diy - doy);
      const iso = A.isoWeek(y, mo, d);
      h += rowH('ISO week', iso.year + '-W' + String(iso.week).padStart(2, '0'));
      h += rowH('Julian Day Number', A.jdn(y, mo, d).toLocaleString());
      h += rowH('zodiac sign', A.zodiacSign(mo, d));
      h += subH('🎂 This month');
      h += rowH('birthstone', A.BIRTHSTONES[mo - 1]);
      h += rowH('birth flower', A.BIRTH_FLOWERS[mo - 1]);
      h += subH('📆 Notable dates');
      h += rowH('leap year?', A.isGregLeap(y) ? 'yes — 366 days' : 'no — 365 days');
      let nl = y + 1; while (!A.isGregLeap(nl)) nl++;
      h += rowH('next leap year', nl);
      const e1 = A.easter(y), e2 = A.easter(y + 1);
      h += rowH('Easter ' + y, monthName(e1.m) + ' ' + e1.d);
      h += rowH('Easter ' + (y + 1), monthName(e2.m) + ' ' + e2.d);
      const f13 = A.nextFriday13(y, mo, d);
      if (f13) h += rowH('next Friday the 13th', monthName(f13.m) + ' ' + f13.d + ', ' + f13.y);
      h += subH('🌍 Other calendars');
      const jul = A.rdToJulian(rd);
      h += rowH('Julian (Old Style)', monthName(jul.m) + ' ' + jul.d + ', ' + jul.y);
      const heb = A.hebrewFromRD(rd);
      h += rowH('Hebrew', heb.d + ' ' + A.HEBREW_MONTHS[heb.m - 1] + ' ' + heb.y);
      const isl = A.islamicFromRD(rd);
      h += rowH('Islamic (AH)', isl.d + ' ' + A.ISLAMIC_MONTHS[isl.m - 1] + ' ' + isl.y);
      const per = A.persianFromRD(rd);
      h += rowH('Persian (AP)', per.d + ' ' + A.PERSIAN_MONTHS[per.m - 1] + ' ' + per.y);
      const cn = A.chineseYearForDate(y, mo, d);
      h += rowH('Chinese year', cn.element + ' ' + cn.animal + ' · ' + cn.stemBranch);
      h += rowH('Chinese solar term', A.solarTerm(noonMs));
      const may = A.mayanFromRD(rd), mtz = A.mayanTzolkin(rd), mha = A.mayanHaab(rd);
      h += rowH('Maya Long Count', may.longCount.join('.'));
      h += rowH('Maya Tzolkin · Haab', mtz.num + ' ' + mtz.name + ' · ' + mha.day + ' ' + mha.month);
      const fr = A.frenchFromRD(rd);
      h += rowH('French Republican', fr.d + ' ' + A.FRENCH_MONTHS[fr.m - 1] + ' An ' + roman(fr.y));
      const dis = A.discordian(y, mo, d);
      h += rowH('Discordian', dis.stTibbs ? "St Tib's Day, YOLD " + dis.year : (dis.weekday + ', ' + dis.dayOfSeason + ' ' + dis.season + ' ' + dis.year));
      out.innerHTML = h;
    }
    view.querySelector('.alm-today').onclick = () => { dateEl.value = U.todayStr(); compute(); };
    dateEl.addEventListener('input', debounce(compute, 150));
    return { compute, view };
  }

  // The Sun / Astronomy tools mounted somewhere else (Stats, on the panel's
  // view stack). Each mount is an independent view; render() redraws it.
  global.ExtrasAlmanac = {
    mount(kind, container) {
      const t = kind === 'astro' ? buildAstro(container) : buildSun(container);
      return { render() { ensureLoc(t.view); t.compute(); } };
    },
  };

  // register the three tools
  const C = {};
  RT({ id: 'sun', name: 'Sun', icon: '☀️', label: 'Sun', build(v) { C.sun = buildSun(v); }, onShow() { if (C.sun) { ensureLoc(C.sun.view); C.sun.compute(); } } });
  RT({ id: 'astro', name: 'Astronomy', icon: '🔭', label: 'Astronomy', build(v) { C.astro = buildAstro(v); }, onShow() { if (C.astro) { ensureLoc(C.astro.view); C.astro.compute(); } } });
  RT({ id: 'cal', name: 'Calendar', icon: '📅', label: 'Calendar', build(v) { C.cal = buildCal(v); }, onShow() { if (C.cal) C.cal.compute(); } });

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
