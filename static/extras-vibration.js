// Extras → Vibration: a configurable haptic "massage" generator.
//
// Self-contained: this whole feature lives in this one file plus the native
// plugins — ios-overrides/HapticPatternPlugin.swift and
// android-overrides/HapticPatternPlugin.kt. It plugs into the Extras launcher
// via the generic global.ExtrasRegisterTool(...) hook in extras.js, so nothing
// else needs to know it exists.
//
// How it drives vibration:
//   - iOS + Android: a native HapticPattern Capacitor plugin (Core Haptics on
//     iOS; VibrationEffect amplitude waveforms on Android). We compute a
//     normalized amplitude envelope (sine/triangle/saw/square/pulse/heartbeat)
//     for one seamless loop and hand it to the plugin, which plays it as a
//     continuous, looping haptic whose intensity follows the envelope. The
//     "speed" slider sets how fast the envelope cycles; the waveform sets its
//     shape. Both plugins register under the same jsName ("HapticPattern"), so
//     this file has no platform branches. iPad / Simulator / no-vibrator
//     devices report unsupported. Android sharpness is accepted but ignored
//     (no carrier control in the public API).
//   - Web / older builds: falls back to navigator.vibrate() with a coarse
//     on/off pattern (no intensity control). Needs android.permission.VIBRATE
//     in the APK manifest either way (injected by the Android build workflow).
//
// All settings persist to localStorage. The tool always stops vibration when
// its view is hidden / the app backgrounds, so the phone never keeps buzzing.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';
  global._scriptVersions = global._scriptVersions || {};
  global._scriptVersions['extras-vibration.js'] = SCRIPT_VERSION;

  const STORE_KEY = 'cc.vibration.v1';
  const SAVED_KEY = 'cc.vibration.saved.v1';
  const TARGET_WINDOW = 2.0; // seconds; loop holds ~this many seconds of cycles

  const DEFAULTS = {
    waveform: 'sine',
    freq: 1.2,        // Hz (envelope cycles per second)
    intensity: 0.85,  // 0..1
    sharpness: 0.4,   // 0..1  (soft hum -> crisp buzz)
    depth: 0.85,      // 0..1  (envelope modulation depth; 0 = constant buzz)
    duty: 0.5,        // 0..1  (square/pulse "on" fraction)
    autostopMin: 0,   // 0 = off
  };

  const WAVEFORMS = [
    { id: 'sine', label: 'Sine' },
    { id: 'triangle', label: 'Triangle' },
    { id: 'sawtooth', label: 'Saw' },
    { id: 'square', label: 'Square' },
    { id: 'pulse', label: 'Pulse' },
    { id: 'heartbeat', label: 'Heartbeat' },
  ];

  const PRESETS = [
    { id: 'calm', name: 'Calm wave', s: { waveform: 'sine', freq: 0.6, intensity: 0.7, sharpness: 0.3, depth: 0.85, duty: 0.5 } },
    { id: 'ocean', name: 'Ocean', s: { waveform: 'sine', freq: 0.25, intensity: 0.8, sharpness: 0.2, depth: 1.0, duty: 0.5 } },
    { id: 'heartbeat', name: 'Heartbeat', s: { waveform: 'heartbeat', freq: 1.1, intensity: 0.95, sharpness: 0.6, depth: 1.0, duty: 0.5 } },
    { id: 'rolling', name: 'Rolling', s: { waveform: 'triangle', freq: 1.5, intensity: 0.8, sharpness: 0.4, depth: 0.9, duty: 0.5 } },
    { id: 'throb', name: 'Deep throb', s: { waveform: 'sine', freq: 2.4, intensity: 1.0, sharpness: 0.25, depth: 0.95, duty: 0.5 } },
    { id: 'buzz', name: 'Buzzy', s: { waveform: 'square', freq: 9, intensity: 0.7, sharpness: 0.85, depth: 1.0, duty: 0.5 } },
    { id: 'tap', name: 'Pulse', s: { waveform: 'pulse', freq: 2.5, intensity: 0.95, sharpness: 0.75, depth: 1.0, duty: 0.22 } },
    { id: 'ramp', name: 'Ramp', s: { waveform: 'sawtooth', freq: 0.8, intensity: 0.85, sharpness: 0.5, depth: 1.0, duty: 0.5 } },
  ];

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ── persisted state ──
  const state = Object.assign({}, DEFAULTS, load());
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  // ── saved named patterns ──
  let saved = readSaved();
  function readSaved() {
    try { return JSON.parse(localStorage.getItem(SAVED_KEY)) || []; }
    catch (e) { return []; }
  }
  function persistSaved() {
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(saved)); } catch (e) {}
  }
  // The "feel" fields that make up a pattern (everything except session prefs
  // like the auto-stop timer).
  const FEEL_KEYS = ['waveform', 'freq', 'intensity', 'sharpness', 'depth', 'duty'];
  function featureSettings() {
    const o = {};
    FEEL_KEYS.forEach(k => { o[k] = state[k]; });
    return o;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── runtime ──
  let nativeSupported = false;
  let webFallback = false;
  let playing = false;
  let autostopTimer = null;
  let webTimer = null;
  let applyThrottleTs = 0;
  let els = {};
  let viewEl = null;

  function plugin() {
    return (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.HapticPattern) || null;
  }

  // ────────────────────────────────────────────────────────────
  // Waveform → amplitude envelope (one seamless loop)
  // ────────────────────────────────────────────────────────────
  function waveShape(wf, phase, duty) {
    switch (wf) {
      case 'triangle': return 1 - Math.abs(2 * phase - 1);
      case 'sawtooth': return phase;
      case 'square':
      case 'pulse': return phase < duty ? 1 : 0;
      case 'heartbeat': {
        const bump = (c, w) => Math.exp(-((phase - c) * (phase - c)) / (2 * w * w));
        return Math.min(1, 1.0 * bump(0.10, 0.045) + 0.72 * bump(0.27, 0.055));
      }
      case 'sine':
      default: return (1 - Math.cos(2 * Math.PI * phase)) / 2;
    }
  }

  function computeEnvelope(s) {
    const freq = clamp(s.freq, 0.1, 30);
    let cycles = Math.max(1, Math.round(freq * TARGET_WINDOW));
    let duration = Math.min(30, cycles / freq);
    cycles = Math.max(1, Math.round(duration * freq));
    duration = cycles / freq;

    const depth = clamp(s.depth, 0, 1);
    const duty = clamp(s.duty, 0.02, 0.98);
    const floor = 1 - depth;
    const wf = s.waveform;
    const raw = [];
    const push = (t, v) => raw.push({ t: clamp(t, 0, 1), i: clamp(floor + depth * v, 0, 1) });

    if (wf === 'square' || wf === 'pulse') {
      const eps = 0.003;
      for (let c = 0; c < cycles; c++) {
        const s0 = c / cycles;
        const e0 = (c + 1) / cycles;
        const on = s0 + duty / cycles;
        push(s0, 1);
        push(Math.min(on - eps, e0 - eps), 1);
        push(on, 0);
        push(Math.max(on + eps, e0 - eps), 0);
      }
      push(1, 0);
    } else {
      const perCycle = clamp(Math.round(256 / cycles), 6, 28);
      const N = cycles * perCycle;
      for (let k = 0; k <= N; k++) {
        const t = k / N;
        const phase = (t * cycles) % 1;
        push(t, waveShape(wf, phase, duty));
      }
    }

    // Core Haptics requires strictly increasing control-point times.
    const points = [];
    let lastT = -1;
    for (const p of raw) {
      if (p.t > lastT + 1e-6) { points.push(p); lastT = p.t; }
    }
    return { duration, points };
  }

  // ────────────────────────────────────────────────────────────
  // Playback
  // ────────────────────────────────────────────────────────────
  async function apply() {
    const env = computeEnvelope(state);
    drawViz(env);
    if (!playing) return;
    const p = plugin();
    if (p && nativeSupported) {
      try {
        await p.play({
          duration: env.duration,
          intensity: state.intensity,
          sharpness: state.sharpness,
          loop: true,
          points: env.points,
        });
      } catch (e) { console.error('HapticPattern.play failed', e); }
    } else if (webFallback) {
      startWebFallback();
    }
  }

  function throttledApply() {
    const now = Date.now();
    if (now - applyThrottleTs < 90) return;
    applyThrottleTs = now;
    apply();
  }

  function liveUpdate() {
    const p = plugin();
    if (playing && p && nativeSupported) {
      p.update({ intensity: state.intensity, sharpness: state.sharpness }).catch(() => {});
    } else if (playing && webFallback) {
      startWebFallback();
    }
  }

  async function start() {
    if (playing) return;
    playing = true;
    reflectPlay();
    await apply();
    armAutostop();
  }
  function stop() {
    playing = false;
    reflectPlay();
    clearAutostop();
    const p = plugin();
    if (p && nativeSupported) p.stop().catch(() => {});
    stopWebFallback();
  }
  function toggle() { playing ? stop() : start(); }

  // ── auto-stop timer ──
  function armAutostop() {
    clearAutostop();
    if (state.autostopMin > 0) {
      autostopTimer = setTimeout(stop, state.autostopMin * 60000);
    }
  }
  function clearAutostop() {
    if (autostopTimer) { clearTimeout(autostopTimer); autostopTimer = null; }
  }

  // ── web (Android) fallback ──
  function startWebFallback() {
    stopWebFallback();
    if (!global.navigator || !navigator.vibrate) return;
    const period = 1000 / clamp(state.freq, 0.5, 20);
    const on = Math.max(10, period * clamp(state.duty, 0.1, 0.9));
    const off = Math.max(0, period - on);
    const fire = () => { try { navigator.vibrate([Math.round(on), Math.round(off)]); } catch (e) {} };
    fire();
    webTimer = setInterval(fire, Math.max(40, Math.round(period)));
  }
  function stopWebFallback() {
    if (webTimer) { clearInterval(webTimer); webTimer = null; }
    try { if (global.navigator && navigator.vibrate) navigator.vibrate(0); } catch (e) {}
  }

  // ────────────────────────────────────────────────────────────
  // UI
  // ────────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('vib-css')) return;
    const css = `
    #extras_vibration { --vib-accent: #7aa2ff; }
    .vib-viz { width: 100%; height: 84px; display: block; border-radius: 10px;
      background: rgba(127,127,127,0.10); margin-bottom: 12px; }
    .vib-play { width: 100%; padding: 13px; font-size: 16px; font-weight: 600;
      border: none; border-radius: 10px; cursor: pointer; margin-bottom: 12px;
      color: #fff; background: var(--vib-accent); transition: filter .15s; }
    .vib-play:hover { filter: brightness(1.08); }
    .vib-play.on { background: #e05a6b; }
    .vib-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
    .vib-chip { padding: 7px 11px; border-radius: 999px; border: 1px solid rgba(127,127,127,0.35);
      background: transparent; color: inherit; font-size: 13px; cursor: pointer; }
    .vib-chip.on { background: var(--vib-accent); color: #fff; border-color: transparent; }
    .vib-sub { font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
      opacity: .6; margin: 4px 0 6px; }
    .vib-row { margin-bottom: 11px; }
    .vib-row .vib-lbl { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 3px; }
    .vib-row .vib-val { opacity: .75; font-variant-numeric: tabular-nums; }
    .vib-row input[type="range"] { width: 100%; accent-color: var(--vib-accent); margin: 0; }
    .vib-foot { display: flex; align-items: center; justify-content: space-between;
      gap: 8px; margin-top: 6px; }
    .vib-foot select { padding: 7px; font-size: 13px; }
    .vib-note { font-size: 12px; opacity: .65; margin: 10px 0 0; line-height: 1.4; }
    .vib-unsupported { font-size: 14px; opacity: .8; line-height: 1.5; text-align: center; padding: 18px 6px; }
    .vib-saverow { display: flex; gap: 6px; margin-bottom: 8px; }
    .vib-saverow input { flex: 1; min-width: 0; }
    .vib-savebtn { padding: 8px 14px; border: none; border-radius: 8px; cursor: pointer;
      color: #fff; background: var(--vib-accent); font-size: 13px; }
    .vib-saved-item { display: inline-flex; align-items: stretch; }
    .vib-saved-item .vib-chip { border-radius: 999px 0 0 999px; }
    .vib-del { border: 1px solid rgba(127,127,127,0.35); border-left: none;
      border-radius: 0 999px 999px 0; background: transparent; color: inherit;
      cursor: pointer; padding: 0 9px; font-size: 14px; opacity: .7; }
    .vib-del:hover { color: #e05a6b; opacity: 1; }
    .vib-empty { font-size: 12px; opacity: .55; }
    `;
    const style = document.createElement('style');
    style.id = 'vib-css';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function build(view) {
    viewEl = view;
    injectCss();

    const presetChips = PRESETS.map(p =>
      `<button class="vib-chip" data-preset="${p.id}" type="button">${p.name}</button>`).join('');
    const waveChips = WAVEFORMS.map(w =>
      `<button class="vib-chip" data-wave="${w.id}" type="button">${w.label}</button>`).join('');

    view.innerHTML = `
      <div class="vib-unsupported" hidden></div>
      <div class="vib-main">
        <canvas class="vib-viz" width="640" height="168"></canvas>
        <button class="vib-play" type="button">&#9654;&nbsp; Start</button>

        <div class="vib-sub">Presets</div>
        <div class="vib-chips vib-presets">${presetChips}</div>

        <div class="vib-sub">Wave pattern</div>
        <div class="vib-chips vib-waves">${waveChips}</div>

        <div class="vib-row">
          <div class="vib-lbl"><span>Speed</span><span class="vib-val" data-out="freq"></span></div>
          <input type="range" data-k="freq" min="0.1" max="20" step="0.1">
        </div>
        <div class="vib-row">
          <div class="vib-lbl"><span>Intensity</span><span class="vib-val" data-out="intensity"></span></div>
          <input type="range" data-k="intensity" min="0" max="1" step="0.01">
        </div>
        <div class="vib-row">
          <div class="vib-lbl"><span>Texture</span><span class="vib-val" data-out="sharpness"></span></div>
          <input type="range" data-k="sharpness" min="0" max="1" step="0.01">
        </div>
        <div class="vib-row">
          <div class="vib-lbl"><span>Wave depth</span><span class="vib-val" data-out="depth"></span></div>
          <input type="range" data-k="depth" min="0" max="1" step="0.01">
        </div>
        <div class="vib-row vib-duty" hidden>
          <div class="vib-lbl"><span>Pulse width</span><span class="vib-val" data-out="duty"></span></div>
          <input type="range" data-k="duty" min="0.05" max="0.95" step="0.01">
        </div>

        <div class="vib-foot">
          <span style="font-size:13px;">Auto-stop</span>
          <select class="vib-autostop" aria-label="auto-stop timer">
            <option value="0">Off</option>
            <option value="5">5 min</option>
            <option value="10">10 min</option>
            <option value="15">15 min</option>
            <option value="20">20 min</option>
            <option value="30">30 min</option>
          </select>
        </div>
        <p class="vib-note"></p>

        <div class="vib-sub">Saved patterns</div>
        <div class="vib-saverow">
          <input class="vib-savename" type="text" maxlength="28" placeholder="name this pattern" aria-label="pattern name">
          <button class="vib-savebtn" type="button">Save</button>
        </div>
        <div class="vib-chips vib-savedlist"></div>
      </div>
    `;

    els = {
      main: view.querySelector('.vib-main'),
      unsupported: view.querySelector('.vib-unsupported'),
      canvas: view.querySelector('.vib-viz'),
      play: view.querySelector('.vib-play'),
      presets: view.querySelector('.vib-presets'),
      waves: view.querySelector('.vib-waves'),
      dutyRow: view.querySelector('.vib-duty'),
      autostop: view.querySelector('.vib-autostop'),
      note: view.querySelector('.vib-note'),
      saveName: view.querySelector('.vib-savename'),
      saveBtn: view.querySelector('.vib-savebtn'),
      savedList: view.querySelector('.vib-savedlist'),
      ranges: Array.from(view.querySelectorAll('input[type="range"]')),
      outs: {},
    };
    view.querySelectorAll('[data-out]').forEach(el => { els.outs[el.dataset.out] = el; });

    // ── wiring ──
    els.play.addEventListener('click', toggle);

    els.presets.addEventListener('click', (e) => {
      const b = e.target.closest('[data-preset]');
      if (!b) return;
      const preset = PRESETS.find(p => p.id === b.dataset.preset);
      if (!preset) return;
      Object.assign(state, preset.s);
      persist(); syncInputs();
      playing ? throttledApply() : drawViz(computeEnvelope(state));
    });

    els.waves.addEventListener('click', (e) => {
      const b = e.target.closest('[data-wave]');
      if (!b) return;
      state.waveform = b.dataset.wave;
      persist(); syncInputs();
      playing ? throttledApply() : drawViz(computeEnvelope(state));
    });

    els.ranges.forEach(r => {
      r.addEventListener('input', () => {
        const k = r.dataset.k;
        state[k] = parseFloat(r.value);
        persist();
        updateReadout(k);
        if (k === 'intensity' || k === 'sharpness') {
          liveUpdate();
        } else if (playing) {
          throttledApply();
        } else {
          drawViz(computeEnvelope(state));
        }
      });
    });

    els.autostop.addEventListener('change', () => {
      state.autostopMin = parseInt(els.autostop.value, 10) || 0;
      persist();
      if (playing) armAutostop();
    });

    // ── saved patterns ──
    els.saveBtn.addEventListener('click', () => {
      const name = (els.saveName.value || '').trim();
      if (!name) { els.saveName.focus(); return; }
      saveCurrent(name);
      els.saveName.value = '';
    });
    els.saveName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); els.saveBtn.click(); }
    });
    els.savedList.addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) { deleteSaved(del.dataset.del); return; }
      const item = e.target.closest('[data-load]');
      if (item) loadSaved(item.dataset.load);
    });

    // ── lifecycle: always stop when leaving / backgrounding ──
    new MutationObserver(() => { if (view.hidden && playing) stop(); })
      .observe(view, { attributes: true, attributeFilter: ['hidden'] });
    document.addEventListener('visibilitychange', () => { if (document.hidden && playing) stop(); });
    global.addEventListener('pagehide', () => { if (playing) stop(); });

    syncInputs();
    renderSaved();
    detectSupport();
  }

  function detectSupport() {
    const p = plugin();
    if (p && typeof p.isSupported === 'function') {
      p.isSupported().then(r => {
        nativeSupported = !!(r && r.supported);
        webFallback = !nativeSupported && !!(global.navigator && navigator.vibrate);
        reflectSupport(r && r.reason);
      }).catch(() => {
        nativeSupported = false;
        webFallback = !!(global.navigator && navigator.vibrate);
        reflectSupport('');
      });
    } else {
      nativeSupported = false;
      webFallback = !!(global.navigator && navigator.vibrate);
      reflectSupport('');
    }
  }

  function reflectSupport(reason) {
    if (!nativeSupported && !webFallback) {
      els.main.hidden = true;
      els.unsupported.hidden = false;
      els.unsupported.textContent = 'Vibration isn’t available on this device. '
        + (reason || 'It needs an iPhone with a Taptic Engine.');
      return;
    }
    els.main.hidden = false;
    els.unsupported.hidden = true;
    els.note.textContent = nativeSupported
      ? 'Tip: hold the phone in your palm or rest it against you. “Texture” goes from a soft hum to a crisp buzz; “Wave depth” sets how much it pulses vs. a steady buzz.'
      : 'Using basic vibration for this device — intensity/texture aren’t adjustable here, only speed and pattern.';
  }

  function reflectPlay() {
    if (!els.play) return;
    els.play.classList.toggle('on', playing);
    els.play.innerHTML = playing ? '&#9632;&nbsp; Stop' : '&#9654;&nbsp; Start';
  }

  function updateReadout(k) {
    const out = els.outs[k];
    if (!out) return;
    if (k === 'freq') out.textContent = state.freq.toFixed(1) + ' Hz';
    else out.textContent = Math.round(state[k] * 100) + '%';
  }

  function syncInputs() {
    els.ranges.forEach(r => {
      const k = r.dataset.k;
      if (typeof state[k] === 'number') r.value = state[k];
      updateReadout(k);
    });
    // active chips
    els.waves.querySelectorAll('[data-wave]').forEach(b =>
      b.classList.toggle('on', b.dataset.wave === state.waveform));
    els.presets.querySelectorAll('[data-preset]').forEach(b => {
      const p = PRESETS.find(x => x.id === b.dataset.preset);
      const match = p && Object.keys(p.s).every(key => state[key] === p.s[key]);
      b.classList.toggle('on', !!match);
    });
    // duty only matters for square/pulse
    els.dutyRow.hidden = !(state.waveform === 'square' || state.waveform === 'pulse');
    if (els.autostop) els.autostop.value = String(state.autostopMin);
    drawViz(computeEnvelope(state));
  }

  // ── saved patterns: render / save / load / delete ──
  function renderSaved() {
    if (!els.savedList) return;
    if (!saved.length) {
      els.savedList.innerHTML =
        '<span class="vib-empty">No saved patterns yet — dial in a feel you like and tap Save.</span>';
      return;
    }
    els.savedList.innerHTML = saved.map(r =>
      '<span class="vib-saved-item">'
      + '<button class="vib-chip" data-load="' + r.id + '" type="button">' + escapeHtml(r.name) + '</button>'
      + '<button class="vib-del" data-del="' + r.id + '" type="button" aria-label="delete ' + escapeHtml(r.name) + '">&times;</button>'
      + '</span>').join('');
  }
  function saveCurrent(name) {
    const id = 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    saved.unshift({ id: id, name: name, s: featureSettings() });
    if (saved.length > 50) saved = saved.slice(0, 50);
    persistSaved();
    renderSaved();
  }
  function loadSaved(id) {
    const rec = saved.find(r => r.id === id);
    if (!rec) return;
    Object.assign(state, rec.s);
    persist();
    syncInputs();
    playing ? throttledApply() : drawViz(computeEnvelope(state));
  }
  function deleteSaved(id) {
    saved = saved.filter(r => r.id !== id);
    persistSaved();
    renderSaved();
  }

  // ── visualization ──
  function drawViz(env) {
    if (!els.canvas) return;
    const ctx = els.canvas.getContext('2d');
    const W = els.canvas.width, H = els.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const pts = env.points;
    if (!pts || !pts.length) return;

    const accent = (getComputedStyle(viewEl).getPropertyValue('--vib-accent') || '#7aa2ff').trim() || '#7aa2ff';
    const y = (i) => H - (i * (H - 8)) - 4;

    // baseline
    ctx.strokeStyle = 'rgba(127,127,127,0.30)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H - 1); ctx.lineTo(W, H - 1); ctx.stroke();

    // filled area
    ctx.beginPath();
    ctx.moveTo(0, H);
    pts.forEach(p => ctx.lineTo(p.t * W, y(p.i)));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = 'rgba(122,162,255,0.22)';
    ctx.fill();

    // wave line
    ctx.beginPath();
    pts.forEach((p, idx) => {
      const px = p.t * W, py = y(p.i);
      idx ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ────────────────────────────────────────────────────────────
  // Register with the Extras launcher (retries until the hook exists)
  // ────────────────────────────────────────────────────────────
  function register() {
    if (!global.ExtrasRegisterTool) { setTimeout(register, 50); return; }
    global.ExtrasRegisterTool({
      id: 'vibration',
      name: 'Vibration',
      icon: '&#128243;',          // 📳 vibration mode
      label: 'Vibration',
      build: build,
      onShow: () => { if (els.canvas) drawViz(computeEnvelope(state)); },
    });
  }
  register();

})(typeof window !== 'undefined' ? window : this);
