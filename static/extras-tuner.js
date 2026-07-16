// Extras -> Tuner: a chromatic AND microtonal instrument tuner.
//
// Listens on the microphone (explicit tap to start, torn down on hide),
// detects pitch with a YIN-style normalized-difference autocorrelation,
// and shows a cents needle against the selected tuning system:
//
//   - any EDO (12 by default -- a normal chromatic tuner -- but also
//     19, 24, 31, 53, ... matching the synth's tuning machinery), or
//   - ANY scale from the bundled Scala archive (static/scala-db.json,
//     5399 tunings, the same DB the synth's Tuning Explorer uses) --
//     including non-octave scales like Bohlen-Pierce (1902 cent period):
//     the nearest-degree search stacks the scale's own period.
//
// Reference pitch (A4) is calibrable (415..444 or free-typed), and the
// scale root is any 12-EDO note. A secondary readout always shows the
// nearest standard 12-EDO note so you stay oriented inside exotic
// scales. The needle gauge marks a green +-3 cent in-tune zone; a
// cents-drift sparkline underneath shows vibrato/drift over time.
//
// Zero-network: the only fetch is the local /static/scala-db.json
// asset, lazy-loaded the first time the Scala picker is opened (same
// pattern as synth.html; tests can preload window.SCALA_DB instead).
// Audio never leaves the device and nothing is recorded.
//
// Pitch/scale math lives on global.TunerCore, headless-testable under
// Node (tests/tuner.test.js synthesizes waveforms and checks detection
// to sub-cent accuracy).
//
// NOTE: the CSS below lives inside a template literal -- never put a
// backtick inside it (even in a comment), it terminates the string and
// breaks the whole file.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve (if tracked)
  if (global._scriptVersions) global._scriptVersions['extras-tuner.js'] = SCRIPT_VERSION;

  // ────────────────────────────────────────────────────────────
  // CORE — pure pitch + scale math (headless-testable)
  // ────────────────────────────────────────────────────────────
  const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

  const CORE = {
    // YIN pitch detector (cumulative mean normalized difference).
    // buf: Float32Array time-domain samples in [-1,1]. Returns
    // { freq, clarity } or null (silence / no periodicity).
    detectPitch: (buf, sampleRate, opts) => {
      const o = opts || {};
      const fMin = o.fMin || 50, fMax = o.fMax || 1800;
      const thresh = o.threshold || 0.15;
      const n = buf.length;
      let rms = 0;
      for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
      rms = Math.sqrt(rms / n);
      if (rms < (o.rmsGate != null ? o.rmsGate : 0.004)) return null;

      const tauMin = Math.max(2, Math.floor(sampleRate / fMax));
      const tauMax = Math.min(Math.floor(sampleRate / fMin), n >> 1);
      if (tauMax <= tauMin) return null;

      // Difference function + cumulative mean normalization. The FULL
      // cmnd array is computed before any threshold search: the YIN
      // "walk to the local minimum" step reads cmnd[tau+1], so breaking
      // out of this loop early would walk into uninitialized zeros and
      // report ~5-10% sharp (found the hard way in tests).
      const cmnd = new Float32Array(tauMax + 1);
      cmnd[0] = 1;
      let runningSum = 0;
      const lim = n - tauMax;
      for (let tau = 1; tau <= tauMax; tau++) {
        let d = 0;
        for (let i = 0; i < lim; i++) {
          const diff = buf[i] - buf[i + tau];
          d += diff * diff;
        }
        runningSum += d;
        cmnd[tau] = runningSum > 0 ? (d * tau) / runningSum : 1;
      }
      // absolute-threshold rule: first dip under the threshold, then
      // follow it down to its local minimum
      let bestTau = -1;
      for (let tau = tauMin; tau <= tauMax; tau++) {
        if (cmnd[tau] < thresh) {
          while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
          bestTau = tau;
          break;
        }
      }
      if (bestTau < 0) {
        // fall back to the global minimum if it's convincing
        let mn = 1, at = -1;
        for (let t = tauMin; t <= tauMax; t++) if (cmnd[t] < mn) { mn = cmnd[t]; at = t; }
        if (at < 0 || mn > 0.35) return null;
        bestTau = at;
      }
      // parabolic interpolation around bestTau: vertex of the parabola
      // through (tau-1, a), (tau, b), (tau+1, c) is at tau + (a-c)/(2(a-2b+c))
      let tau = bestTau;
      if (tau > 1 && tau < tauMax) {
        const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[tau + 1];
        const denom = a + c - 2 * b;
        if (Math.abs(denom) > 1e-12) tau += (a - c) / (2 * denom);
      }
      const freq = sampleRate / tau;
      if (freq < fMin || freq > fMax) return null;
      return { freq, clarity: 1 - cmnd[bestTau] };
    },

    // Normalize a Scala cents list into pitch classes within [0, period).
    // cents: scale degrees with the LAST entry being the period.
    scaleDegrees: (cents) => {
      const period = cents[cents.length - 1];
      if (!(period > 0)) return null;
      const degs = [0];
      for (let i = 0; i < cents.length - 1; i++) {
        let c = cents[i] % period;
        if (c < 0) c += period;
        degs.push(c);
      }
      const uniq = [...new Set(degs.map((c) => Math.round(c * 1000) / 1000))];
      uniq.sort((a, b) => a - b);
      return { degrees: uniq, period };
    },

    // Nearest scale degree to frequency f, stacking the scale's period.
    // scale: { edo: N } or { degrees: [...], period } (from scaleDegrees).
    // Returns { deg, degCents, periodIndex, targetHz, off } (off in cents,
    // positive = sharp of target).
    nearestDegree: (f, rootHz, scale) => {
      if (!(f > 0) || !(rootHz > 0)) return null;
      let degrees, period;
      if (scale.edo) {
        period = 1200;
        degrees = [];
        for (let i = 0; i < scale.edo; i++) degrees.push(i * 1200 / scale.edo);
      } else {
        degrees = scale.degrees; period = scale.period;
      }
      const cents = 1200 * Math.log2(f / rootHz);
      let pi = Math.floor(cents / period);
      const pc = cents - pi * period;                 // [0, period)
      let best = null;
      for (let i = 0; i < degrees.length; i++) {
        const off = pc - degrees[i];
        if (best == null || Math.abs(off) < Math.abs(best.off)) {
          best = { deg: i, degCents: degrees[i], off };
        }
      }
      // wrap: degree 0 of the NEXT period may be closer
      const offUp = pc - period;
      if (Math.abs(offUp) < Math.abs(best.off)) {
        best = { deg: 0, degCents: 0, off: offUp };
        pi += 1;
      }
      const targetHz = rootHz * Math.pow(2, (pi * period + best.degCents) / 1200);
      return { deg: best.deg, degCents: best.degCents, periodIndex: pi, targetHz, off: best.off };
    },

    // Nearest standard 12-EDO note for orientation. Returns
    // { name, octave, off, targetHz }.
    freqToNote12: (f, a4) => {
      const ref = a4 || 440;
      const idx = Math.round(12 * Math.log2(f / ref)) + 57;   // C0-based index
      const targetHz = ref * Math.pow(2, (idx - 57) / 12);
      return {
        name: NOTE_NAMES[((idx % 12) + 12) % 12],
        octave: Math.floor(idx / 12),
        off: 1200 * Math.log2(f / targetHz),
        targetHz,
      };
    },

    NOTE_NAMES,
  };
  global.TunerCore = CORE;

  if (typeof document === 'undefined' || typeof global.ExtrasRegisterTool !== 'function') return;

  const RT = global.ExtrasRegisterTool;

  // ── CSS (no backticks inside this template literal!) ──
  const style = document.createElement('style');
  style.textContent = `
  #extras_tuner [hidden] { display: none !important; }
  .tun-gauge { display: block; width: 100%; height: 150px; }
  .tun-note { text-align: center; font-size: 34px; font-weight: 700; margin: 0;
    font-variant-numeric: tabular-nums; min-height: 44px; }
  .tun-note .cents { font-size: 16px; font-weight: 500; color: var(--ui-muted); }
  .tun-sub { text-align: center; font-size: 13px; color: var(--ui-muted);
    min-height: 18px; font-variant-numeric: tabular-nums; }
  .tun-hz { text-align: center; font-size: 14px; margin: 2px 0;
    font-variant-numeric: tabular-nums; min-height: 18px; }
  .tun-spark { display: block; width: 100%; height: 40px; margin-top: 6px;
    border-radius: 8px; background: rgba(0,0,0,0.12); }
  .tun-controls { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center;
    margin: 10px 0 2px; align-items: center; }
  .tun-controls select, .tun-controls input {
    padding: 7px 8px; font-size: 13px; border-radius: var(--ui-radius, 10px);
    border: 1px solid var(--ui-border); background: var(--ui-input-bg);
    color: var(--ui-text); font-family: inherit;
  }
  .tun-controls input { width: 62px; }
  .tun-btn {
    padding: 7px 16px; font-size: 13.5px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--ui-accent); background: var(--ui-input-bg);
    color: var(--ui-text); font-family: inherit;
  }
  .tun-btn.live { background: var(--ui-accent); color: #fff; }
  .tun-note.intune { color: #5ecc7a; }
  .tun-scl-panel { border: 1px solid var(--ui-border); border-radius: var(--ui-radius, 12px);
    background: var(--ui-input-bg); padding: 8px; margin-top: 8px; }
  .tun-scl-panel input { width: 100%; box-sizing: border-box; padding: 8px;
    font-size: 14px; border-radius: 8px; border: 1px solid var(--ui-border);
    background: rgba(0,0,0,0.15); color: var(--ui-text); font-family: inherit; }
  .tun-scl-list { max-height: 220px; overflow-y: auto; margin-top: 6px; }
  .tun-scl-item { padding: 7px 6px; border-bottom: 1px solid var(--ui-border);
    cursor: pointer; font-size: 13px; }
  .tun-scl-item .d { color: var(--ui-muted); font-size: 12px; display: block;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tun-note-hint { text-align: center; font-size: 12.5px; color: var(--ui-muted);
    font-style: italic; margin-top: 6px; }
  `;
  document.head.appendChild(style);

  // ── prefs ──
  const PREF_KEY = 'cc.tuner.v1';
  let prefs = { a4: 440, root: 'C4', edo: 12, scl: null };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (_) {}
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (_) {} };

  function rootHz() {
    const m = /^([A-G]♯?)(\d)$/.exec(prefs.root) || [null, 'C', '4'];
    const pc = NOTE_NAMES.indexOf(m[1]);
    const idx = (parseInt(m[2], 10)) * 12 + (pc < 0 ? 0 : pc);
    return prefs.a4 * Math.pow(2, (idx - 57) / 12);
  }
  function activeScale() {
    if (prefs.scl && Array.isArray(prefs.scl.cents)) {
      const s = CORE.scaleDegrees(prefs.scl.cents);
      if (s) return s;
    }
    return { edo: prefs.edo || 12 };
  }

  // ── mic + analysis ──
  let stream = null, ctx = null, analyser = null, data = null;
  let running = false, rafTimer = 0;
  const drift = [];                      // cents-off history for the sparkline

  async function startMic(btn, note) {
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) { note.textContent = 'microphone API not available here'; return; }
    try {
      stream = await md.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const AC = global.AudioContext || global.webkitAudioContext;
      ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      src.connect(analyser);
      data = new Float32Array(analyser.fftSize);
      running = true;
      btn.textContent = 'Stop';
      btn.classList.add('live');
      note.textContent = 'audio is analyzed on-device only — nothing is recorded';
    } catch (e) {
      note.textContent = 'mic unavailable (' + ((e && e.name) || 'denied') + ')';
      stopMic(btn);
    }
  }
  function stopMic(btn) {
    running = false;
    if (stream) { try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {} }
    if (ctx) { try { ctx.close(); } catch (_) {} }
    stream = null; ctx = null; analyser = null; data = null;
    drift.length = 0;
    if (btn) { btn.textContent = 'Start'; btn.classList.remove('live'); }
  }

  // ── gauge drawing ──
  function prep(cv) {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = cv.clientWidth || 300, h = cv.clientHeight || 150;
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { c, w, h };
  }
  function accent() {
    try {
      return getComputedStyle(document.documentElement).getPropertyValue('--ui-accent').trim() || '#7f8cff';
    } catch (_) { return '#7f8cff'; }
  }
  function drawGauge(cv, off, live) {
    const { c, w, h } = prep(cv);
    c.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h - 8, R = Math.min(w / 2 - 10, h - 22);
    const angOf = (cents) => Math.PI + (cents + 50) / 100 * Math.PI;
    // green in-tune wedge
    c.beginPath();
    c.arc(cx, cy, R, angOf(-3), angOf(3));
    c.strokeStyle = 'rgba(94,204,122,0.85)';
    c.lineWidth = 7;
    c.stroke();
    // arc
    c.beginPath();
    c.arc(cx, cy, R, Math.PI, 2 * Math.PI);
    c.strokeStyle = 'rgba(128,140,160,0.5)';
    c.lineWidth = 2;
    c.stroke();
    // ticks each 10 cents
    c.fillStyle = 'rgba(128,140,160,0.9)';
    c.font = '10px system-ui, sans-serif';
    c.textAlign = 'center';
    for (let t = -50; t <= 50; t += 10) {
      const a = angOf(t);
      const x1 = cx + Math.cos(a) * (R - 6), y1 = cy + Math.sin(a) * (R - 6);
      const x2 = cx + Math.cos(a) * (R + (t % 50 === 0 ? 4 : 1)), y2 = cy + Math.sin(a) * (R + (t % 50 === 0 ? 4 : 1));
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2);
      c.strokeStyle = 'rgba(128,140,160,0.8)'; c.lineWidth = t === 0 ? 2 : 1; c.stroke();
      if (t % 25 === 0) {
        c.fillText((t > 0 ? '+' : '') + t, cx + Math.cos(a) * (R - 18), cy + Math.sin(a) * (R - 18) + 3);
      }
    }
    if (off == null) return;
    const clamped = Math.max(-50, Math.min(50, off));
    const a = angOf(clamped);
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + Math.cos(a) * (R - 12), cy + Math.sin(a) * (R - 12));
    c.strokeStyle = Math.abs(off) <= 3 ? '#5ecc7a' : (live ? accent() : 'rgba(128,140,160,0.6)');
    c.lineWidth = 3;
    c.lineCap = 'round';
    c.stroke();
    c.beginPath(); c.arc(cx, cy, 5, 0, Math.PI * 2); c.fillStyle = c.strokeStyle; c.fill();
  }
  function drawDrift(cv) {
    const { c, w, h } = prep(cv);
    c.clearRect(0, 0, w, h);
    // center line = in tune
    c.strokeStyle = 'rgba(94,204,122,0.5)';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, h / 2); c.lineTo(w, h / 2); c.stroke();
    if (drift.length < 2) return;
    c.strokeStyle = accent();
    c.lineWidth = 1.5;
    c.beginPath();
    for (let i = 0; i < drift.length; i++) {
      const x = (i / Math.max(drift.length - 1, 1)) * (w - 4) + 2;
      const v = drift[i];
      const y = v == null ? null : h / 2 - Math.max(-50, Math.min(50, v)) / 50 * (h / 2 - 3);
      if (y == null) { c.stroke(); c.beginPath(); continue; }
      c.lineTo(x, y);
    }
    c.stroke();
  }

  // ── Scala picker ──
  let db = null, dbLoading = false;
  function loadDb(cb, note) {
    if (db) { cb(); return; }
    if (global.SCALA_DB) { db = global.SCALA_DB; cb(); return; }
    if (dbLoading) return;
    dbLoading = true;
    note.textContent = 'loading scale archive…';
    fetch('/static/scala-db.json')
      .then((r) => r.json())
      .then((j) => { db = j; global.SCALA_DB = j; dbLoading = false; note.textContent = ''; cb(); })
      .catch(() => { dbLoading = false; note.textContent = 'could not load scala-db.json'; });
  }

  // ── view ──
  function buildTuner(view) {
    view.innerHTML =
      '<canvas class="tun-gauge" id="tunGauge"></canvas>' +
      '<div class="tun-note" id="tunNote">—</div>' +
      '<div class="tun-hz" id="tunHz">&nbsp;</div>' +
      '<div class="tun-sub" id="tunSub">&nbsp;</div>' +
      '<canvas class="tun-spark" id="tunSpark"></canvas>' +
      '<div class="tun-controls">' +
        '<button class="tun-btn" id="tunStart">Start</button>' +
        '<label>A4 <input id="tunA4" type="number" min="380" max="500" step="0.1"></label>' +
        '<select id="tunRoot" title="scale root"></select>' +
        '<select id="tunScale" title="tuning system"></select>' +
      '</div>' +
      '<div class="tun-scl-panel" id="tunSclPanel" hidden>' +
        '<input id="tunSclSearch" placeholder="search 5399 Scala tunings…">' +
        '<div class="tun-scl-list" id="tunSclList"></div>' +
      '</div>' +
      '<div class="tun-note-hint" id="tunHint">tap Start, then play or sing a note</div>';

    const $ = (id) => view.querySelector('#' + id);
    const gauge = $('tunGauge'), noteEl = $('tunNote'), hzEl = $('tunHz'), subEl = $('tunSub');
    const spark = $('tunSpark'), startBtn = $('tunStart'), a4In = $('tunA4');
    const rootSel = $('tunRoot'), scaleSel = $('tunScale');
    const sclPanel = $('tunSclPanel'), sclSearch = $('tunSclSearch'), sclList = $('tunSclList');
    const hint = $('tunHint');

    // root options C2..B6
    let rootHtml = '';
    for (let o = 2; o <= 6; o++) {
      for (let p = 0; p < 12; p++) {
        const nm = NOTE_NAMES[p] + o;
        rootHtml += '<option value="' + nm + '">root ' + nm + '</option>';
      }
    }
    rootSel.innerHTML = rootHtml;
    rootSel.value = prefs.root;
    if (rootSel.selectedIndex < 0) rootSel.value = 'C4';

    const EDOS = [12, 5, 7, 13, 15, 17, 19, 22, 24, 26, 31, 34, 41, 53];
    function rebuildScaleSel() {
      let h = '';
      for (const n of EDOS) h += '<option value="edo:' + n + '">' + n + '-EDO' + (n === 12 ? ' (standard)' : '') + '</option>';
      if (prefs.scl) h += '<option value="scl">✦ ' + prefs.scl.name + '</option>';
      h += '<option value="browse">Scala archive…</option>';
      scaleSel.innerHTML = h;
      scaleSel.value = prefs.scl ? 'scl' : 'edo:' + (prefs.edo || 12);
      if (scaleSel.selectedIndex < 0) scaleSel.value = 'edo:12';
    }
    rebuildScaleSel();
    a4In.value = prefs.a4;

    a4In.oninput = () => {
      const v = parseFloat(a4In.value);
      if (v >= 380 && v <= 500) { prefs.a4 = v; savePrefs(); }
    };
    rootSel.onchange = () => { prefs.root = rootSel.value; savePrefs(); };
    scaleSel.onchange = () => {
      const v = scaleSel.value;
      if (v === 'browse') {
        sclPanel.hidden = false;
        loadDb(() => renderScl(''), hint);
        rebuildScaleSel();          // snap the select back to the active entry
        return;
      }
      sclPanel.hidden = true;
      if (v.startsWith('edo:')) { prefs.scl = null; prefs.edo = parseInt(v.slice(4), 10); }
      savePrefs();
    };

    function renderScl(q) {
      if (!db) return;
      const needle = q.trim().toLowerCase();
      let html = '';
      let shown = 0;
      for (let i = 0; i < db.length && shown < 60; i++) {
        const e = db[i];                 // [name, desc, fam, into, cents[]]
        if (needle && e[0].toLowerCase().indexOf(needle) < 0
            && e[1].toLowerCase().indexOf(needle) < 0) continue;
        html += '<div class="tun-scl-item" data-i="' + i + '"><b>' + e[0] + '</b> · ' +
          (e[4].length) + ' notes<span class="d">' + (e[1] || '') + '</span></div>';
        shown++;
      }
      sclList.innerHTML = html || '<div class="tun-scl-item">no matches</div>';
    }
    sclSearch.oninput = () => renderScl(sclSearch.value);
    sclList.onclick = (ev) => {
      const it = ev.target.closest('.tun-scl-item');
      if (!it || it.dataset.i == null) return;
      const e = db[+it.dataset.i];
      if (!e) return;
      prefs.scl = { name: e[0], cents: e[4] };
      savePrefs();
      sclPanel.hidden = true;
      rebuildScaleSel();
    };

    startBtn.onclick = () => {
      if (running) stopMic(startBtn);
      else startMic(startBtn, hint);
    };

    // ── analysis loop ──
    let smoothOff = null;
    function tick() {
      if (!view._tunActive) return;
      if (running && analyser && data) {
        if (analyser.getFloatTimeDomainData) analyser.getFloatTimeDomainData(data);
        const res = CORE.detectPitch(data, ctx.sampleRate);
        if (res && res.clarity > 0.5) {
          const scale = activeScale();
          const nd = CORE.nearestDegree(res.freq, rootHz(), scale);
          const n12 = CORE.freqToNote12(res.freq, prefs.a4);
          smoothOff = smoothOff == null ? nd.off : smoothOff * 0.6 + nd.off * 0.4;
          drift.push(nd.off);
          if (drift.length > 200) drift.shift();
          const cents = (nd.off >= 0 ? '+' : '') + nd.off.toFixed(1) + '¢';
          if (scale.edo === 12) {
            noteEl.innerHTML = n12.name + n12.octave + ' <span class="cents">' + cents + '</span>';
          } else if (scale.edo) {
            noteEl.innerHTML = nd.deg + '\\' + scale.edo + ' <span class="cents">' + cents + '</span>';
          } else {
            noteEl.innerHTML = 'deg ' + nd.deg + ' (' + Math.round(nd.degCents) + '¢)' +
              ' <span class="cents">' + cents + '</span>';
          }
          noteEl.classList.toggle('intune', Math.abs(nd.off) <= 3);
          hzEl.textContent = res.freq.toFixed(2) + ' Hz → target ' + nd.targetHz.toFixed(2) + ' Hz';
          subEl.textContent = (scale.edo === 12 ? '' :
            'nearest 12-EDO: ' + n12.name + n12.octave + ' ' +
            (n12.off >= 0 ? '+' : '') + n12.off.toFixed(0) + '¢');
        } else {
          drift.push(null);
          if (drift.length > 200) drift.shift();
          if (drift.slice(-8).every((v) => v == null)) {
            noteEl.textContent = '—';
            noteEl.classList.remove('intune');
            hzEl.innerHTML = '&nbsp;';
            smoothOff = null;
          }
        }
        drawGauge(gauge, smoothOff, true);
        drawDrift(spark);
      } else {
        drawGauge(gauge, null, false);
      }
    }
    view._tunTick = tick;

    // lifecycle: run only while visible; mic dies the moment we hide
    const panel = document.getElementById('extrasPanel');
    let timer = 0;
    const check = () => {
      const vis = !view.hidden && panel && panel.classList.contains('show')
        && document.visibilityState === 'visible';
      if (vis && !view._tunActive) {
        view._tunActive = true;
        timer = setInterval(tick, 100);
        drawGauge(gauge, null, false);
      } else if (!vis && view._tunActive) {
        view._tunActive = false;
        clearInterval(timer); timer = 0;
        stopMic(startBtn);
      }
    };
    new MutationObserver(check).observe(view, { attributes: true, attributeFilter: ['hidden'] });
    if (panel) new MutationObserver(check).observe(panel, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', check);
    view._tunCheck = check;
  }

  RT({
    id: 'tuner',
    name: 'Tuner',
    label: 'Tuner',
    icon: '\u{1F3BB}',
    build: buildTuner,
    onShow: function () {
      const v = document.getElementById('extras_tuner');
      if (v && v._tunCheck) v._tunCheck();
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
