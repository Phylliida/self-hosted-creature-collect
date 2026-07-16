// Extras -> Sensors: a live dashboard of everything the phone can sense.
//
// One scrolling view of cards, each streaming a hardware sensor in real
// time: motion (accelerometer + gyroscope), orientation & compass (with a
// bubble level), barometer & magnetometer (via the native SensorProbe
// plugin), ambient light / proximity (Android), battery & thermal state,
// GPS (fed from the app's ONE shared geolocation watch — this tool must
// never open a second one), an opt-in microphone level meter, today's
// steps (MotionPedometer plugin, same jsName both platforms), and a
// device/display card (screen, storage, memory footprint, connection).
//
// Sensors that don't exist on the current platform/build stay visible as
// dimmed "not available" rows — seeing what the device can and cannot
// feel is part of the point of the tool.
//
// Zero-network by design: nothing here ever fetches. The mic meter is
// local-only analysis (getUserMedia -> AnalyserNode) and is started ONLY
// by an explicit tap, stopped the moment the tool is hidden.
//
// Native half: ios-overrides/SensorProbePlugin.swift and
// android-overrides/SensorProbePlugin.kt (jsName "SensorProbe"), streaming
// 4 Hz 'reading' events: { pressureHPa?, relAltM?, magX/Y/Z?, lux?,
// proximityCm?/proximityNear?, batteryPct?, batteryCharging?, thermal?,
// lowPower? }. Missing plugin (web, or an old app build) degrades to the
// web-API subset with a "needs app rebuild" note on native.
//
// Pressure history persists in localStorage (cc.baro.v1, 48 h) so the
// trend classifier ("falling fast" etc.) can work across sessions even
// though we only sample while the dashboard is open.
//
// Plugs into the Extras launcher via global.ExtrasRegisterTool exactly
// like extras-skymap.js. Pure math/formatting lives on global.SensorsCore
// so tests/sensors.test.js can exercise it headless under Node.
//
// NOTE: the CSS below lives inside a template literal -- never put a
// backtick inside it (even in a comment), it terminates the string and
// breaks the whole file.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve (if tracked)
  if (global._scriptVersions) global._scriptVersions['extras-sensors.js'] = SCRIPT_VERSION;

  // ────────────────────────────────────────────────────────────
  // CORE — pure helpers, headless-testable under Node
  // ────────────────────────────────────────────────────────────
  const COMPASS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const CORE = {
    norm360: (d) => ((d % 360) + 360) % 360,
    compassPoint: (deg) => COMPASS16[Math.round(CORE.norm360(deg) / 22.5) % 16],

    // Device-orientation event -> compass heading (deg CW from north), or
    // null when the event carries no absolute reference. Mirrors the
    // heading-cone logic in index.html.
    headingFrom: (e, screenAngle) => {
      if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)
          && e.webkitCompassHeading >= 0) {
        return e.webkitCompassHeading;            // iOS: already CW-from-north
      }
      if (e.alpha != null && (e.absolute || e.type === 'deviceorientationabsolute')) {
        return CORE.norm360(360 - e.alpha + (screenAngle || 0));
      }
      return null;
    },

    // beta (front-back, -180..180) / gamma (left-right, -90..90) -> a
    // clamped pitch/roll pair for the bubble level (deg).
    tiltFrom: (beta, gamma) => ({
      pitch: Math.max(-90, Math.min(90, beta || 0)),
      roll: Math.max(-90, Math.min(90, gamma || 0)),
    }),

    // RMS of a [-1,1] signal -> dBFS, floored at -90 (silence).
    rmsToDb: (rms) => (rms > 0 ? Math.max(-90, 20 * Math.log10(rms)) : -90),

    // Least-squares slope over {t (ms), hPa} samples -> barometric trend.
    // Convention: classify by the equivalent change over 3 hours (the
    // standard "pressure tendency" window). Needs >= 5 samples spanning
    // >= 30 min, else { label: null } ("still gathering").
    pressureTrend: (samples, nowMs) => {
      const cutoff = nowMs - 3 * 3600e3;
      const pts = samples.filter((s) => s.t >= cutoff && Number.isFinite(s.hPa));
      if (pts.length < 5) return { rate3h: null, label: null };
      const span = pts[pts.length - 1].t - pts[0].t;
      if (span < 30 * 60e3) return { rate3h: null, label: null };
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      const t0 = pts[0].t;
      for (const p of pts) {
        const x = (p.t - t0) / 3600e3;            // hours
        sx += x; sy += p.hPa; sxx += x * x; sxy += x * p.hPa;
      }
      const n = pts.length;
      const denom = n * sxx - sx * sx;
      if (Math.abs(denom) < 1e-9) return { rate3h: null, label: null };
      const slope = (n * sxy - sx * sy) / denom;  // hPa per hour
      const rate3h = slope * 3;
      const a = Math.abs(rate3h);
      let label;
      if (a < 0.5) label = 'steady';
      else if (a < 1.5) label = rate3h > 0 ? 'rising slowly' : 'falling slowly';
      else if (a < 3.5) label = rate3h > 0 ? 'rising' : 'falling';
      else label = rate3h > 0 ? 'rising fast' : 'falling fast';
      return { rate3h, label };
    },

    fmt: (v, d) => (Number.isFinite(v) ? v.toFixed(d == null ? 1 : d) : '—'),
    fmtBytes: (b) => {
      if (!Number.isFinite(b)) return '—';
      if (b >= 1024 * 1024 * 1024) return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
      if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
      return Math.round(b / 1024) + ' KB';
    },
  };
  global.SensorsCore = CORE;

  if (typeof document === 'undefined' || typeof global.ExtrasRegisterTool !== 'function') return;

  const RT = global.ExtrasRegisterTool;
  const Cap = global.Capacitor;
  const platform = (Cap && Cap.getPlatform && Cap.getPlatform()) || 'web';
  const Plugins = (Cap && Cap.Plugins) || {};
  const Probe = Plugins.SensorProbe || null;
  const Pedo = Plugins.MotionPedometer || null;
  const Mem = Plugins.MemoryProbe || null;

  // ── CSS (no backticks inside this template literal!) ──
  const style = document.createElement('style');
  style.textContent = `
  #extras_sensors [hidden] { display: none !important; }
  .sns-card {
    border: 1px solid var(--ui-border); border-radius: var(--ui-radius, 12px);
    background: var(--ui-input-bg); padding: 10px 12px; margin: 8px 0;
  }
  .sns-card h4 {
    margin: 0 0 6px; font-size: 13.5px; display: flex; align-items: center; gap: 7px;
  }
  .sns-card h4 .sns-live {
    width: 7px; height: 7px; border-radius: 50%; background: var(--ui-accent);
    opacity: 0; transition: opacity .3s;
  }
  .sns-card h4 .sns-live.on { opacity: 1; }
  .sns-row { display: flex; justify-content: space-between; gap: 10px;
    font-size: 13px; padding: 1.5px 0; }
  .sns-row .k { color: var(--ui-muted); }
  .sns-row .v { font-variant-numeric: tabular-nums; text-align: right; }
  .sns-note { font-size: 12px; color: var(--ui-muted); font-style: italic; margin: 3px 0 1px; }
  .sns-spark { display: block; width: 100%; height: 44px; margin-top: 5px;
    border-radius: 8px; background: rgba(0,0,0,0.12); }
  .sns-level-wrap { display: flex; justify-content: center; margin: 6px 0 2px; }
  .sns-level { width: 110px; height: 110px; }
  .sns-btn {
    padding: 5px 12px; font-size: 12.5px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--ui-accent); background: var(--ui-input-bg);
    color: var(--ui-text); font-family: inherit; margin: 4px 0 2px;
  }
  .sns-meter { height: 12px; border-radius: 6px; background: rgba(0,0,0,0.18);
    overflow: hidden; margin-top: 6px; position: relative; }
  .sns-meter .fill { height: 100%; width: 0%; background: var(--ui-accent);
    border-radius: 6px; transition: width .08s linear; }
  .sns-meter .peak { position: absolute; top: 0; bottom: 0; width: 2px;
    background: var(--ui-text); opacity: .7; }
  `;
  document.head.appendChild(style);

  // ────────────────────────────────────────────────────────────
  // Shared live-state + external hooks
  // ────────────────────────────────────────────────────────────
  const latest = {};           // one bag of most-recent readings
  let active = false;          // dashboard visible and streaming

  // GPS: fed by index.html from the SINGLE GeolocateControl watch.
  // Registered at script load so a fix that lands before the first open
  // is not lost (index.html also stashes window._ccLatestFix).
  global.ExtrasSensors = {
    onLocationFix: (pos) => { latest.fix = pos; },
  };
  if (global._ccLatestFix) latest.fix = global._ccLatestFix;

  // Ring buffers for sparklines.
  const accelHist = [];        // |a|-g magnitude, last ~18 s
  const micHist = [];          // dBFS, last ~18 s
  const PRESS_KEY = 'cc.baro.v1';
  let pressHist = [];          // {t, hPa} persisted 48 h
  try { pressHist = JSON.parse(localStorage.getItem(PRESS_KEY) || '[]'); } catch (_) {}
  if (!Array.isArray(pressHist)) pressHist = [];
  let lastPressSave = 0;
  function pushPressure(hPa) {
    const now = Date.now();
    const last = pressHist[pressHist.length - 1];
    if (last && now - last.t < 30e3) { last.hPa = hPa; return; }   // 30 s cadence
    pressHist.push({ t: now, hPa });
    while (pressHist.length && pressHist[0].t < now - 48 * 3600e3) pressHist.shift();
    if (pressHist.length > 800) pressHist.splice(0, pressHist.length - 800);
    if (now - lastPressSave > 60e3) {
      lastPressSave = now;
      try { localStorage.setItem(PRESS_KEY, JSON.stringify(pressHist)); } catch (_) {}
    }
  }

  // ────────────────────────────────────────────────────────────
  // Web sensor listeners
  // ────────────────────────────────────────────────────────────
  let motionSeen = false, orientSeen = false;

  function onMotion(e) {
    motionSeen = true;
    const g = e.accelerationIncludingGravity || {};
    const l = e.acceleration || {};
    const r = e.rotationRate || {};
    latest.acc = { x: g.x, y: g.y, z: g.z };
    latest.lin = { x: l.x, y: l.y, z: l.z };
    latest.rot = { a: r.alpha, b: r.beta, g: r.gamma };
    latest.motionInterval = e.interval;
    const mag = Math.sqrt((g.x || 0) ** 2 + (g.y || 0) ** 2 + (g.z || 0) ** 2);
    accelHist.push(mag);
    if (accelHist.length > 300) accelHist.shift();
  }
  function onOrient(e) {
    orientSeen = true;
    const sa = (screen.orientation && screen.orientation.angle) || 0;
    const h = CORE.headingFrom(e, sa);
    if (h != null) latest.heading = h;
    if (typeof e.webkitCompassAccuracy === 'number' && e.webkitCompassAccuracy >= 0) {
      latest.headingAcc = e.webkitCompassAccuracy;
    }
    if (e.beta != null) latest.tilt = CORE.tiltFrom(e.beta, e.gamma);
    if (e.alpha != null) latest.euler = { a: e.alpha, b: e.beta, g: e.gamma };
  }

  function addWebSensors() {
    window.addEventListener('devicemotion', onMotion, true);
    window.addEventListener('deviceorientationabsolute', onOrient, true);
    window.addEventListener('deviceorientation', onOrient, true);
  }
  function removeWebSensors() {
    window.removeEventListener('devicemotion', onMotion, true);
    window.removeEventListener('deviceorientationabsolute', onOrient, true);
    window.removeEventListener('deviceorientation', onOrient, true);
  }

  // ────────────────────────────────────────────────────────────
  // Native SensorProbe stream
  // ────────────────────────────────────────────────────────────
  let probeHandle = null;
  function startProbe() {
    if (!Probe || probeHandle) return;
    try {
      const h = Probe.addListener('reading', (r) => {
        if (!r) return;
        Object.assign(latest, r);
        if (Number.isFinite(r.pressureHPa)) pushPressure(r.pressureHPa);
      });
      probeHandle = (h && typeof h.then === 'function') ? null : h;
      if (h && typeof h.then === 'function') h.then((real) => { probeHandle = real; });
      Probe.start().catch(() => {});
    } catch (_) { /* plugin misbehaving — card just stays empty */ }
  }
  function stopProbe() {
    if (!Probe) return;
    try { Probe.stop().catch(() => {}); } catch (_) {}
    if (probeHandle && probeHandle.remove) { try { probeHandle.remove(); } catch (_) {} }
    probeHandle = null;
  }

  // ────────────────────────────────────────────────────────────
  // Mic level meter (explicit opt-in, torn down on hide)
  // ────────────────────────────────────────────────────────────
  let micStream = null, micCtx = null, micAnalyser = null, micData = null, micPeak = -90;
  async function startMic() {
    if (micStream) return;
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) { latest.micErr = 'microphone API not available here'; return; }
    try {
      micStream = await md.getUserMedia({ audio: { echoCancellation: false } });
      const AC = global.AudioContext || global.webkitAudioContext;
      micCtx = new AC();
      const src = micCtx.createMediaStreamSource(micStream);
      micAnalyser = micCtx.createAnalyser();
      micAnalyser.fftSize = 2048;
      src.connect(micAnalyser);
      micData = new Float32Array(micAnalyser.fftSize);
      micPeak = -90;
      latest.micErr = null;
    } catch (e) {
      latest.micErr = 'mic unavailable (' + ((e && e.name) || 'denied') + ')';
      stopMic();
    }
  }
  function stopMic() {
    if (micStream) { try { micStream.getTracks().forEach((t) => t.stop()); } catch (_) {} }
    if (micCtx) { try { micCtx.close(); } catch (_) {} }
    micStream = null; micCtx = null; micAnalyser = null; micData = null;
    micHist.length = 0;
  }
  function sampleMic() {
    if (!micAnalyser || !micData) return null;
    if (micAnalyser.getFloatTimeDomainData) micAnalyser.getFloatTimeDomainData(micData);
    else {
      const b = new Uint8Array(micData.length);
      micAnalyser.getByteTimeDomainData(b);
      for (let i = 0; i < b.length; i++) micData[i] = (b[i] - 128) / 128;
    }
    let sum = 0;
    for (let i = 0; i < micData.length; i++) sum += micData[i] * micData[i];
    const db = CORE.rmsToDb(Math.sqrt(sum / micData.length));
    micPeak = Math.max(micPeak - 0.15, db);      // slow-decay peak hold
    micHist.push(db);
    if (micHist.length > 300) micHist.shift();
    return db;
  }

  // ────────────────────────────────────────────────────────────
  // Slow pollers (battery web API, storage, memory, steps)
  // ────────────────────────────────────────────────────────────
  let webBattery = null;
  function pollSlow() {
    if (!Probe && navigator.getBattery && !webBattery) {
      navigator.getBattery().then((b) => { webBattery = b; }).catch(() => {});
    }
    if (webBattery) {
      latest.batteryPct = webBattery.level * 100;
      latest.batteryCharging = webBattery.charging;
    }
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then((est) => { latest.storage = est; }).catch(() => {});
    }
    if (Mem && Mem.getFootprint) {
      Mem.getFootprint().then((m) => { latest.mem = m; }).catch(() => {});
    }
    if (Pedo && latest.stepsAvail !== false) {
      const from = new Date(); from.setHours(0, 0, 0, 0);
      Pedo.getDistanceMeters({ fromMs: from.getTime(), toMs: Date.now() })
        .then((r) => { latest.steps = r; })
        .catch(() => { latest.stepsAvail = false; });
    }
  }

  // ────────────────────────────────────────────────────────────
  // Drawing helpers
  // ────────────────────────────────────────────────────────────
  function prepCanvas(cv) {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = cv.clientWidth || 260, h = cv.clientHeight || 44;
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }
  function accentColor() {
    try {
      return getComputedStyle(document.documentElement).getPropertyValue('--ui-accent').trim() || '#7f8cff';
    } catch (_) { return '#7f8cff'; }
  }
  function drawSpark(cv, arr, lo, hi) {
    const { ctx, w, h } = prepCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    if (!arr.length) return;
    let mn = lo, mx = hi;
    if (mn == null || mx == null) {
      mn = Math.min(...arr); mx = Math.max(...arr);
      const pad = Math.max((mx - mn) * 0.15, 0.01);
      mn -= pad; mx += pad;
    }
    ctx.strokeStyle = accentColor();
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < arr.length; i++) {
      const x = (i / Math.max(arr.length - 1, 1)) * (w - 4) + 2;
      const y = h - 3 - ((arr[i] - mn) / (mx - mn || 1)) * (h - 6);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  function drawLevel(cv, tilt) {
    const { ctx, w, h } = prepCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 4;
    ctx.strokeStyle = 'rgba(128,140,160,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, R / 3, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();
    if (!tilt) return;
    const bx = cx + Math.max(-1, Math.min(1, tilt.roll / 45)) * (R - 8);
    const by = cy + Math.max(-1, Math.min(1, tilt.pitch / 45)) * (R - 8);
    const flat = Math.abs(tilt.pitch) < 2 && Math.abs(tilt.roll) < 2;
    ctx.fillStyle = flat ? '#5ecc7a' : accentColor();
    ctx.beginPath(); ctx.arc(bx, by, 7, 0, Math.PI * 2); ctx.fill();
  }

  // ────────────────────────────────────────────────────────────
  // View
  // ────────────────────────────────────────────────────────────
  const els = {};              // live element refs, filled in build
  function card(title) {
    return '<div class="sns-card"><h4><span class="sns-live"></span>' + title + '</h4>';
  }
  function row(id, label) {
    return '<div class="sns-row"><span class="k">' + label +
      '</span><span class="v" id="sns_' + id + '">—</span></div>';
  }

  function buildSensors(view) {
    const needsMotionPerm = typeof global.DeviceMotionEvent !== 'undefined'
      && typeof global.DeviceMotionEvent.requestPermission === 'function';

    view.innerHTML =
      card('&#128241; Motion') +
        (needsMotionPerm ? '<button class="sns-btn" id="snsMotionBtn">Enable motion &amp; compass</button>' : '') +
        row('acc', 'accelerometer (m/s²)') +
        row('lin', 'linear accel (m/s²)') +
        row('rot', 'gyroscope (°/s)') +
        row('mrate', 'update rate') +
        '<canvas class="sns-spark" id="snsAccSpark"></canvas>' +
        '<div class="sns-note" id="snsMotionNote" hidden>no motion events — sensor absent or permission not granted</div>' +
      '</div>' +

      card('&#129517; Orientation &amp; compass') +
        row('head', 'compass heading') +
        row('headacc', 'compass accuracy') +
        row('euler', 'alpha / beta / gamma') +
        row('tilt', 'pitch / roll') +
        '<div class="sns-level-wrap"><canvas class="sns-level" id="snsLevel"></canvas></div>' +
      '</div>' +

      card('&#127777;&#65039; Barometer') +
        row('press', 'pressure') +
        row('trend', 'trend (3 h)') +
        row('relalt', 'altitude change (session)') +
        '<canvas class="sns-spark" id="snsPressSpark"></canvas>' +
        '<div class="sns-note" id="snsProbeNote"></div>' +
      '</div>' +

      card('&#129522; Magnetometer &amp; environment') +
        row('mag', 'magnetic field (µT)') +
        row('magmag', 'field strength') +
        row('lux', 'ambient light') +
        row('prox', 'proximity') +
      '</div>' +

      card('&#128205; Location (app GPS watch)') +
        row('coords', 'position') +
        row('gacc', 'accuracy') +
        row('galt', 'altitude') +
        row('gspd', 'speed') +
        row('gcrs', 'course') +
        row('gage', 'fix age') +
        '<div class="sns-note">fed by the map’s single shared GPS watch — enable the blue-dot control if idle</div>' +
      '</div>' +

      card('&#127908; Sound level') +
        '<button class="sns-btn" id="snsMicBtn">Start microphone meter</button>' +
        row('mic', 'level') +
        row('micpeak', 'peak') +
        '<div class="sns-meter"><div class="fill" id="snsMicFill"></div><div class="peak" id="snsMicPeak" style="left:0%"></div></div>' +
        '<canvas class="sns-spark" id="snsMicSpark"></canvas>' +
        '<div class="sns-note" id="snsMicNote">local analysis only — nothing is recorded or sent</div>' +
      '</div>' +

      card('&#128694; Steps today') +
        row('steps', 'steps') +
        row('stepdist', 'distance') +
        '<div class="sns-note" id="snsStepNote"></div>' +
      '</div>' +

      card('&#128267; Power &amp; device') +
        row('batt', 'battery') +
        row('thermal', 'thermal state') +
        row('lowpower', 'battery saver') +
        row('screen', 'screen') +
        row('orient', 'display orientation') +
        row('conn', 'connection') +
        row('memuse', 'app memory') +
        row('store', 'offline storage') +
      '</div>';

    const $ = (id) => view.querySelector('#' + id);
    ['acc', 'lin', 'rot', 'mrate', 'head', 'headacc', 'euler', 'tilt', 'press', 'trend',
      'relalt', 'mag', 'magmag', 'lux', 'prox', 'coords', 'gacc', 'galt', 'gspd', 'gcrs',
      'gage', 'mic', 'micpeak', 'steps', 'stepdist', 'batt', 'thermal', 'lowpower',
      'screen', 'orient', 'conn', 'memuse', 'store'].forEach((id) => { els[id] = $('sns_' + id); });
    els.accSpark = $('snsAccSpark'); els.pressSpark = $('snsPressSpark');
    els.micSpark = $('snsMicSpark'); els.level = $('snsLevel');
    els.micFill = $('snsMicFill'); els.micPeakEl = $('snsMicPeak');
    els.micBtn = $('snsMicBtn'); els.micNote = $('snsMicNote');
    els.motionBtn = $('snsMotionBtn'); els.motionNote = $('snsMotionNote');
    els.probeNote = $('snsProbeNote'); els.stepNote = $('snsStepNote');
    els.lives = view.querySelectorAll('.sns-live');

    if (els.motionBtn) {
      els.motionBtn.onclick = () => {
        const reqs = [];
        try { reqs.push(global.DeviceMotionEvent.requestPermission()); } catch (_) {}
        try {
          if (global.DeviceOrientationEvent
              && typeof global.DeviceOrientationEvent.requestPermission === 'function') {
            reqs.push(global.DeviceOrientationEvent.requestPermission());
          }
        } catch (_) {}
        Promise.allSettled(reqs).then((rs) => {
          if (rs.some((r) => r.status === 'fulfilled' && r.value === 'granted')) {
            els.motionBtn.hidden = true;
          }
        });
      };
    }
    els.micBtn.onclick = () => {
      if (micStream) { stopMic(); els.micBtn.textContent = 'Start microphone meter'; }
      else {
        startMic().then(() => {
          if (micStream) els.micBtn.textContent = 'Stop microphone meter';
          renderMicNote();
        });
      }
    };

    if (!Probe) {
      els.probeNote.textContent = platform === 'web'
        ? 'barometer / magnetometer / light need the phone app'
        : 'needs an app rebuild to add the SensorProbe plugin';
    } else {
      Probe.getInfo().then((info) => { latest.probeInfo = info; }).catch(() => {});
    }
    if (!Pedo) {
      els.stepNote.textContent = platform === 'web'
        ? 'step data needs the phone app' : 'pedometer plugin not available';
    }

    // Stop streaming whenever the view is hidden (tool switch), the panel
    // closes, or the page hides; restart when it all becomes visible again.
    const panel = document.getElementById('extrasPanel');
    const check = () => {
      const vis = !view.hidden && panel && panel.classList.contains('show')
        && document.visibilityState === 'visible';
      if (vis && !active) start();
      else if (!vis && active) stop();
    };
    new MutationObserver(check).observe(view, { attributes: true, attributeFilter: ['hidden'] });
    if (panel) new MutationObserver(check).observe(panel, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', check);
    view._snsCheck = check;
    // Headless-verification hook (firefox --screenshot runs no timers):
    // lets a synchronous driver force one render pass.
    view._snsRender = () => { if (active) render(); };
  }

  // ────────────────────────────────────────────────────────────
  // Lifecycle + render loop
  // ────────────────────────────────────────────────────────────
  let renderTimer = 0, slowTimer = 0;
  function start() {
    if (active) return;
    active = true;
    motionSeen = false; orientSeen = false;
    addWebSensors();
    startProbe();
    pollSlow();
    renderTimer = setInterval(render, 150);
    slowTimer = setInterval(pollSlow, 5000);
  }
  function stop() {
    if (!active) return;
    active = false;
    removeWebSensors();
    stopProbe();
    stopMic();
    if (els.micBtn) els.micBtn.textContent = 'Start microphone meter';
    clearInterval(renderTimer); renderTimer = 0;
    clearInterval(slowTimer); slowTimer = 0;
    try { localStorage.setItem(PRESS_KEY, JSON.stringify(pressHist)); } catch (_) {}
  }

  function renderMicNote() {
    els.micNote.textContent = latest.micErr
      ? latest.micErr : 'local analysis only — nothing is recorded or sent';
  }

  const F = CORE.fmt;
  function triple(o, ks, d) {
    if (!o) return '—';
    return ks.map((k) => F(o[k], d)).join(' / ');
  }

  function render() {
    if (!active) return;
    const L = latest;

    // Motion
    els.acc.textContent = triple(L.acc, ['x', 'y', 'z'], 2);
    els.lin.textContent = triple(L.lin, ['x', 'y', 'z'], 2);
    els.rot.textContent = triple(L.rot, ['a', 'b', 'g'], 1);
    els.mrate.textContent = Number.isFinite(L.motionInterval) && L.motionInterval > 0
      ? Math.round(1000 / L.motionInterval) + ' Hz' : '—';
    drawSpark(els.accSpark, accelHist);
    if (els.motionBtn && motionSeen) els.motionBtn.hidden = true;
    // Note shows only when events are absent AND there's no pending
    // enable button explaining why.
    els.motionNote.hidden = motionSeen || (!!els.motionBtn && !els.motionBtn.hidden);

    // Orientation
    els.head.textContent = L.heading != null
      ? Math.round(L.heading) + '° ' + CORE.compassPoint(L.heading) : '—';
    els.headacc.textContent = L.headingAcc != null ? '±' + Math.round(L.headingAcc) + '°' : '—';
    els.euler.textContent = triple(L.euler, ['a', 'b', 'g'], 0);
    els.tilt.textContent = L.tilt
      ? F(L.tilt.pitch, 1) + '° / ' + F(L.tilt.roll, 1) + '°' : '—';
    drawLevel(els.level, L.tilt);

    // Barometer
    if (Number.isFinite(L.pressureHPa)) {
      els.press.textContent = F(L.pressureHPa, 1) + ' hPa · ' +
        F(L.pressureHPa * 0.02953, 2) + ' inHg';
    } else els.press.textContent = '—';
    const tr = CORE.pressureTrend(pressHist, Date.now());
    els.trend.textContent = tr.label
      ? tr.label + ' (' + (tr.rate3h > 0 ? '+' : '') + F(tr.rate3h, 1) + ' hPa)'
      : (Number.isFinite(L.pressureHPa) ? 'measuring…' : '—');
    els.relalt.textContent = Number.isFinite(L.relAltM)
      ? (L.relAltM > 0 ? '+' : '') + F(L.relAltM, 1) + ' m' : '—';
    drawSpark(els.pressSpark, pressHist.slice(-240).map((p) => p.hPa));

    // Magnetometer & environment
    if (Number.isFinite(L.magX)) {
      els.mag.textContent = F(L.magX, 1) + ' / ' + F(L.magY, 1) + ' / ' + F(L.magZ, 1);
      const bm = Math.sqrt(L.magX ** 2 + L.magY ** 2 + L.magZ ** 2);
      els.magmag.textContent = F(bm, 1) + ' µT' + (bm > 100 ? ' (magnet nearby?)' : '');
    } else { els.mag.textContent = '—'; els.magmag.textContent = '—'; }
    els.lux.textContent = Number.isFinite(L.lux) ? Math.round(L.lux) + ' lux' : '—';
    els.prox.textContent = typeof L.proximityNear === 'boolean'
      ? (L.proximityNear ? 'near' : 'far')
        + (Number.isFinite(L.proximityCm) ? ' (' + F(L.proximityCm, 0) + ' cm)' : '')
      : '—';

    // Location
    const fx = L.fix && L.fix.coords ? L.fix : null;
    if (fx) {
      const c = fx.coords;
      const mi = localStorage.getItem('cc.units') === 'mi';
      els.coords.textContent = c.latitude.toFixed(5) + ', ' + c.longitude.toFixed(5);
      els.gacc.textContent = '±' + F(c.accuracy, 0) + ' m';
      els.galt.textContent = Number.isFinite(c.altitude)
        ? F(c.altitude, 0) + ' m' + (Number.isFinite(c.altitudeAccuracy)
          ? ' ±' + F(c.altitudeAccuracy, 0) : '') : '—';
      els.gspd.textContent = Number.isFinite(c.speed) && c.speed >= 0
        ? F(c.speed, 1) + ' m/s · ' + (mi ? F(c.speed * 2.23694, 1) + ' mph'
          : F(c.speed * 3.6, 1) + ' km/h') : '—';
      els.gcrs.textContent = Number.isFinite(c.heading) && c.heading >= 0
        ? Math.round(c.heading) + '° ' + CORE.compassPoint(c.heading) : '—';
      const age = (Date.now() - (fx.timestamp || 0)) / 1000;
      els.gage.textContent = fx.timestamp ? (age < 1.5 ? 'live' : F(age, 0) + ' s ago') : '—';
    } else {
      ['coords', 'gacc', 'galt', 'gspd', 'gcrs', 'gage'].forEach((k) => { els[k].textContent = '—'; });
    }

    // Mic
    const db = sampleMic();
    if (db != null) {
      els.mic.textContent = F(db, 1) + ' dBFS';
      els.micpeak.textContent = F(micPeak, 1) + ' dBFS';
      const pct = Math.max(0, Math.min(100, (db + 90) / 90 * 100));
      els.micFill.style.width = pct + '%';
      els.micPeakEl.style.left = Math.max(0, Math.min(100, (micPeak + 90) / 90 * 100)) + '%';
      drawSpark(els.micSpark, micHist, -90, 0);
    } else if (!micStream) {
      els.mic.textContent = '—'; els.micpeak.textContent = '—';
      els.micFill.style.width = '0%';
    }
    renderMicNote();

    // Steps
    if (L.steps && L.steps.ok !== false) {
      els.steps.textContent = (L.steps.steps != null) ? String(L.steps.steps) : '—';
      els.stepdist.textContent = Number.isFinite(L.steps.meters)
        ? (L.steps.meters / 1000).toFixed(2) + ' km' : '—';
      els.stepNote.textContent = '';
    } else if (L.steps && L.steps.ok === false) {
      els.stepNote.textContent = 'pedometer: ' + (L.steps.error || 'no permission');
    }

    // Power & device
    els.batt.textContent = Number.isFinite(L.batteryPct)
      ? Math.round(L.batteryPct) + '%' + (L.batteryCharging ? ' ⚡ charging' : '') : '—';
    els.thermal.textContent = L.thermal || '—';
    els.lowpower.textContent = typeof L.lowPower === 'boolean' ? (L.lowPower ? 'on' : 'off') : '—';
    els.screen.textContent = screen.width + '×' + screen.height +
      ' @' + (window.devicePixelRatio || 1) + 'x';
    els.orient.textContent = (screen.orientation && screen.orientation.type
      ? screen.orientation.type.replace('-primary', '').replace('-secondary', ' (flipped)')
      : '—') + (screen.orientation ? ' · ' + screen.orientation.angle + '°' : '');
    const conn = navigator.connection;
    els.conn.textContent = navigator.onLine
      ? 'online' + (conn && conn.effectiveType ? ' · ' + conn.effectiveType : '')
        + (conn && conn.type ? ' · ' + conn.type : '')
      : 'offline';
    els.memuse.textContent = L.mem && Number.isFinite(L.mem.physFootprint)
      ? CORE.fmtBytes(L.mem.physFootprint) : '—';
    els.store.textContent = L.storage
      ? CORE.fmtBytes(L.storage.usage) + ' of ' + CORE.fmtBytes(L.storage.quota) : '—';

    // Live dots: pulse each card that has fresh data this tick.
    const liveFlags = [motionSeen, orientSeen, Number.isFinite(L.pressureHPa),
      Number.isFinite(L.magX) || Number.isFinite(L.lux), !!fx, !!micStream,
      !!(L.steps && L.steps.ok !== false), true];
    els.lives.forEach((el, i) => el.classList.toggle('on', !!liveFlags[i]));
  }

  RT({
    id: 'sensors',
    name: 'Sensors',
    label: 'Sensors',
    icon: '\u{1F4E1}',
    build: buildSensors,
    onShow: function () {
      const v = document.getElementById('extras_sensors');
      if (v && v._snsCheck) v._snsCheck();
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
