// Extras -> Soundscapes: a procedural ambient noise machine.
//
// Nine layerable scapes -- rain (with baked droplets + distant thunder),
// ocean waves, wind, crackling fire, stream, crickets, and plain
// brown/pink/white noise -- ALL synthesized from seeded noise + filters
// + LFOs. No samples, no data files, zero network.
//
// Robustness-by-construction for sleep use:
//   - Every "event" texture (droplets, crackles, chirps, thunder) is
//     baked into a long looping AudioBuffer up front, so steady-state
//     playback needs NO JavaScript timers at all -- pure WebAudio graph.
//     Backgrounded/locked phones keep playing even when JS is throttled
//     or suspended (iOS additionally needs the UIBackgroundModes audio
//     key, added by ios-build.yml).
//   - The sleep timer's fade-out is scheduled on the AUDIO clock
//     (linearRampToValueAtTime at arm time), so it fires at the exact
//     deadline even if JS is asleep; a best-effort setTimeout does the
//     node cleanup when JS wakes.
//   - Unlike other Extras tools, closing the panel deliberately does
//     NOT stop playback (it's the product); the Stop-all button, the
//     sleep timer, or toggling tiles off are the exits.
//
// Noise generators + texture bakers live on global.ScapesCore with a
// seeded xorshift RNG, headless-testable under Node (tests verify
// spectral ordering white > pink > brown via zero-crossing rate,
// bounds, determinism, and that baked textures actually contain
// events).
//
// NOTE: the CSS below lives inside a template literal -- never put a
// backtick inside it (even in a comment), it terminates the string and
// breaks the whole file.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve (if tracked)
  if (global._scriptVersions) global._scriptVersions['extras-scapes.js'] = SCRIPT_VERSION;

  // ────────────────────────────────────────────────────────────
  // CORE — seeded noise + texture bakers (headless-testable)
  // ────────────────────────────────────────────────────────────
  const CORE = {
    makeRng: (seed) => {
      let s = (seed >>> 0) || 0x9e3779b9;
      return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5; s >>>= 0;
        return s / 4294967296;
      };
    },

    fillWhite: (arr, rng) => {
      for (let i = 0; i < arr.length; i++) arr[i] = rng() * 2 - 1;
      return arr;
    },

    // Paul Kellet's economy pink-noise filter over seeded white noise,
    // normalized to ~0.8 peak (the raw filter can overshoot unity).
    fillPink: (arr, rng) => {
      let b0 = 0, b1 = 0, b2 = 0, peak = 0;
      for (let i = 0; i < arr.length; i++) {
        const w = rng() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        arr[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
        const a = Math.abs(arr[i]);
        if (a > peak) peak = a;
      }
      if (peak > 0) { const k = 0.8 / peak; for (let i = 0; i < arr.length; i++) arr[i] *= k; }
      return arr;
    },

    // Leaky-integrator brown noise, normalized to ~0.8 peak. The pole
    // (1/1.008 ≈ 0.992) puts the corner around 55 Hz — a deeper rumble
    // than the classic 0.02/1.02 recipe, which measures more red-pink.
    fillBrown: (arr, rng) => {
      let last = 0, peak = 0;
      for (let i = 0; i < arr.length; i++) {
        const w = rng() * 2 - 1;
        last = (last + 0.008 * w) / 1.008;
        arr[i] = last;
        const a = Math.abs(last);
        if (a > peak) peak = a;
      }
      if (peak > 0) { const k = 0.8 / peak; for (let i = 0; i < arr.length; i++) arr[i] *= k; }
      return arr;
    },

    // Bake decaying sine "plip" droplets onto a silent buffer.
    addDroplets: (arr, sr, rng, perSec, gain) => {
      const count = Math.floor(arr.length / sr * (perSec || 14));
      for (let d = 0; d < count; d++) {
        const at = Math.floor(rng() * (arr.length - sr * 0.1));
        const f = 900 + rng() * 3200;
        const dur = 0.015 + rng() * 0.05;
        const n = Math.floor(dur * sr);
        const g = (0.15 + rng() * 0.5) * (gain || 1);
        for (let i = 0; i < n && at + i < arr.length; i++) {
          const t = i / sr;
          arr[at + i] += Math.sin(2 * Math.PI * f * t) * Math.exp(-t / (dur * 0.3)) * g;
        }
      }
      return arr;
    },

    // Bake sharp fire crackles (filtered noise bursts + occasional pops).
    addCrackles: (arr, sr, rng, perSec, gain) => {
      const count = Math.floor(arr.length / sr * (perSec || 9));
      for (let c = 0; c < count; c++) {
        const at = Math.floor(rng() * (arr.length - sr * 0.06));
        const pop = rng() < 0.12;
        const dur = pop ? 0.02 + rng() * 0.03 : 0.004 + rng() * 0.014;
        const n = Math.floor(dur * sr);
        const g = (pop ? 0.7 : 0.3 + rng() * 0.3) * (gain || 1);
        let hp = 0, lastW = 0;
        for (let i = 0; i < n && at + i < arr.length; i++) {
          const w = rng() * 2 - 1;
          hp = 0.92 * (hp + w - lastW);          // crude highpass for snap
          lastW = w;
          const t = i / sr;
          arr[at + i] += hp * Math.exp(-t / (dur * 0.35)) * g;
        }
      }
      return arr;
    },

    // Bake cricket chirp trains: ~4.3 kHz carrier pulsed ~26 Hz, in
    // groups of 3-5 pulses, scattered with silences between.
    addChirps: (arr, sr, rng, gain) => {
      let at = Math.floor(rng() * sr * 0.8);
      while (at < arr.length - sr * 0.5) {
        const pulses = 3 + Math.floor(rng() * 3);
        const f = 4100 + rng() * 500;
        for (let p = 0; p < pulses; p++) {
          const pn = Math.floor(0.022 * sr);
          for (let i = 0; i < pn && at + i < arr.length; i++) {
            const t = i / sr;
            const env = Math.sin(Math.PI * i / pn);      // smooth pulse
            arr[at + i] += Math.sin(2 * Math.PI * f * t) * env * env * 0.22 * (gain || 1);
          }
          at += Math.floor(0.038 * sr);
        }
        at += Math.floor((0.4 + rng() * 2.2) * sr);      // gap to next chirp group
      }
      return arr;
    },

    // Bake sparse distant thunder: long lowpassed brown swells.
    addThunder: (arr, sr, rng, gain) => {
      const events = Math.max(1, Math.floor(arr.length / sr / 18));
      for (let e = 0; e < events; e++) {
        const at = Math.floor(rng() * Math.max(1, arr.length - sr * 6));
        const dur = 2.5 + rng() * 3;
        const n = Math.floor(dur * sr);
        let last = 0, lp = 0;
        for (let i = 0; i < n && at + i < arr.length; i++) {
          const w = rng() * 2 - 1;
          last = (last + 0.04 * w) / 1.04;
          lp = lp + 0.002 * (last - lp);                 // deep lowpass rumble
          const t = i / n;
          const env = Math.pow(Math.sin(Math.PI * Math.min(t * 1.4, 1)), 2) * Math.exp(-t * 2.2);
          arr[at + i] += lp * env * 40 * (gain || 1);
        }
      }
      return arr;
    },

    zeroCrossRate: (arr) => {
      let z = 0;
      for (let i = 1; i < arr.length; i++) if ((arr[i - 1] < 0) !== (arr[i] < 0)) z++;
      return z / arr.length;
    },

    peak: (arr) => {
      let p = 0;
      for (let i = 0; i < arr.length; i++) { const a = Math.abs(arr[i]); if (a > p) p = a; }
      return p;
    },
  };
  global.ScapesCore = CORE;

  if (typeof document === 'undefined' || typeof global.ExtrasRegisterTool !== 'function') return;

  const RT = global.ExtrasRegisterTool;

  // ── CSS (no backticks inside this template literal!) ──
  const style = document.createElement('style');
  style.textContent = `
  #extras_scapes [hidden] { display: none !important; }
  .scp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 4px; }
  .scp-tile {
    border: 1px solid var(--ui-border); border-radius: var(--ui-radius, 12px);
    background: var(--ui-input-bg); padding: 9px 10px; cursor: pointer;
    -webkit-user-select: none; user-select: none;
  }
  .scp-tile.on { border-color: var(--ui-accent);
    box-shadow: 0 0 0 1px var(--ui-accent) inset; }
  .scp-tile .t { font-size: 14px; display: flex; gap: 7px; align-items: center; }
  .scp-tile input[type=range] { width: 100%; margin: 8px 0 0; accent-color: var(--ui-accent); }
  .scp-master { display: flex; gap: 10px; align-items: center; margin-top: 10px;
    font-size: 13px; }
  .scp-master input[type=range] { flex: 1; accent-color: var(--ui-accent); }
  .scp-pills { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap;
    margin-top: 10px; }
  .scp-pills button, .scp-stop {
    padding: 5px 12px; font-size: 12.5px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--ui-border); background: var(--ui-input-bg);
    color: var(--ui-muted); font-family: inherit;
  }
  .scp-pills button.on { border-color: var(--ui-accent); color: var(--ui-text);
    background: rgba(127,140,255,0.12); }
  .scp-stop { color: var(--ui-text); display: block; margin: 10px auto 0; }
  .scp-note { font-size: 12px; color: var(--ui-muted); font-style: italic;
    text-align: center; margin-top: 8px; }
  .scp-count { text-align: center; font-size: 13px; margin-top: 6px;
    font-variant-numeric: tabular-nums; min-height: 17px; }
  `;
  document.head.appendChild(style);

  // ── prefs ──
  const PREF_KEY = 'cc.scapes.v1';
  let prefs = { master: 0.8, vols: {} };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (_) {}
  if (!prefs.vols || typeof prefs.vols !== 'object') prefs.vols = {};
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (_) {} };

  // ── engine ──
  let ctx = null, master = null;
  const playing = new Map();     // id -> { tileGain, nodes: [] }
  const bufCache = {};           // name -> AudioBuffer
  let sleepDeadline = 0;         // ctx.currentTime deadline, 0 = off
  let sleepCleanup = 0;

  function ensureCtx() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return; }
    const AC = global.AudioContext || global.webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = prefs.master;
    master.connect(ctx.destination);
  }

  function noiseBuffer(kind, seconds, seed, bake) {
    const key = kind + ':' + seconds + ':' + seed;
    if (bufCache[key]) return bufCache[key];
    const sr = ctx.sampleRate;
    const buf = ctx.createBuffer(1, Math.floor(sr * seconds), sr);
    const arr = buf.getChannelData(0);
    const rng = CORE.makeRng(seed);
    if (kind === 'white') CORE.fillWhite(arr, rng);
    else if (kind === 'pink') CORE.fillPink(arr, rng);
    else if (kind === 'brown') CORE.fillBrown(arr, rng);
    // 'silence' left as zeros for pure event textures
    if (bake) bake(arr, sr, rng);
    // safety headroom
    const p = CORE.peak(arr);
    if (p > 0.95) { const k = 0.95 / p; for (let i = 0; i < arr.length; i++) arr[i] *= k; }
    bufCache[key] = buf;
    return buf;
  }

  function loopSrc(buf) {
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    // slight start offset so layered copies of a texture never phase-align
    s.start(0, Math.random() * buf.duration);
    return s;
  }
  function biquad(type, freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    if (q != null) f.Q.value = q;
    return f;
  }
  function gain(v) { const g = ctx.createGain(); g.gain.value = v; return g; }
  function lfo(freq, depth, param, base) {
    const o = ctx.createOscillator();
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = depth;
    o.connect(g); g.connect(param);
    if (base != null) param.value = base;
    o.start();
    return o;
  }
  function chain(nodes, out) {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    nodes[nodes.length - 1].connect(out);
    return nodes;
  }

  // Each build(out) wires its graph into `out` (the tile gain) and
  // returns every node that needs stop()/disconnect() on teardown.
  const SCAPES = [
    { id: 'rain', icon: '\u{1F327}\u{FE0F}', name: 'Rain', build: (out) => {
      const hiss = loopSrc(noiseBuffer('white', 6, 101));
      const n1 = chain([hiss, biquad('highpass', 380), biquad('lowpass', 6200), gain(0.32)], out);
      const drops = loopSrc(noiseBuffer('silence', 9, 102,
        (a, sr, rng) => CORE.addDroplets(a, sr, rng, 16, 0.8)));
      const n2 = chain([drops, gain(0.6)], out);
      const thun = loopSrc(noiseBuffer('silence', 36, 103,
        (a, sr, rng) => CORE.addThunder(a, sr, rng, 0.8)));
      const n3 = chain([thun, gain(0.7)], out);
      return [...n1, ...n2, ...n3];
    } },
    { id: 'ocean', icon: '\u{1F30A}', name: 'Ocean', build: (out) => {
      const src = loopSrc(noiseBuffer('brown', 8, 201));
      const washGain = gain(0.5);
      const nodes = chain([src, biquad('lowpass', 850), washGain], out);
      const l1 = lfo(0.07, 0.3, washGain.gain, 0.5);
      const l2 = lfo(0.115, 0.18, washGain.gain);
      return [...nodes, l1, l2];
    } },
    { id: 'wind', icon: '\u{1F32C}\u{FE0F}', name: 'Wind', build: (out) => {
      const src = loopSrc(noiseBuffer('pink', 8, 301));
      const bp = biquad('bandpass', 700, 0.65);
      const g = gain(0.55);
      const nodes = chain([src, bp, g], out);
      const l1 = lfo(0.05, 320, bp.frequency, 750);
      const l2 = lfo(0.083, 0.22, g.gain);
      return [...nodes, l1, l2];
    } },
    { id: 'fire', icon: '\u{1F525}', name: 'Fire', build: (out) => {
      const bed = loopSrc(noiseBuffer('brown', 6, 401));
      const n1 = chain([bed, biquad('lowpass', 420), gain(0.4)], out);
      const crk = loopSrc(noiseBuffer('silence', 8, 402,
        (a, sr, rng) => CORE.addCrackles(a, sr, rng, 10, 1)));
      const n2 = chain([crk, gain(0.8)], out);
      return [...n1, ...n2];
    } },
    { id: 'stream', icon: '\u{1FAB7}', name: 'Stream', build: (out) => {
      const src = loopSrc(noiseBuffer('white', 7, 501));
      const split = gain(1);
      src.connect(split);
      const nodes = [src, split];
      [[520, 0.62, 0.24], [1150, 0.95, 0.2], [2300, 1.4, 0.13]].forEach(([f, lf, gv], i) => {
        const bp = biquad('bandpass', f, 2.2);
        const g = gain(gv);
        split.connect(bp); bp.connect(g); g.connect(out);
        const l = lfo(lf, gv * 0.55, g.gain);
        const lf2 = lfo(lf * 0.31, f * 0.08, bp.frequency);
        nodes.push(bp, g, l, lf2);
      });
      return nodes;
    } },
    { id: 'crickets', icon: '\u{1F997}', name: 'Crickets', build: (out) => {
      const ch = loopSrc(noiseBuffer('silence', 13, 601,
        (a, sr, rng) => CORE.addChirps(a, sr, rng, 1)));
      const n1 = chain([ch, gain(0.8)], out);
      const bed = loopSrc(noiseBuffer('pink', 9, 602));
      const n2 = chain([bed, biquad('lowpass', 1400), gain(0.05)], out);
      return [...n1, ...n2];
    } },
    { id: 'brown', icon: '\u{1F7EB}', name: 'Brown noise', build: (out) => {
      return chain([loopSrc(noiseBuffer('brown', 8, 701)), gain(0.65)], out);
    } },
    { id: 'pink', icon: '\u{1F338}', name: 'Pink noise', build: (out) => {
      return chain([loopSrc(noiseBuffer('pink', 8, 801)), gain(0.5)], out);
    } },
    { id: 'white', icon: '\u{2B1C}', name: 'White noise', build: (out) => {
      return chain([loopSrc(noiseBuffer('white', 6, 901)), gain(0.3)], out);
    } },
  ];

  function startScape(def) {
    ensureCtx();
    if (playing.has(def.id)) return;
    const tileGain = gain(prefs.vols[def.id] != null ? prefs.vols[def.id] : 0.7);
    tileGain.connect(master);
    const nodes = def.build(tileGain);
    playing.set(def.id, { tileGain, nodes });
  }
  function stopScape(id) {
    const p = playing.get(id);
    if (!p) return;
    playing.delete(id);
    for (const n of p.nodes) {
      try { if (n.stop) n.stop(); } catch (_) {}
      try { n.disconnect(); } catch (_) {}
    }
    try { p.tileGain.disconnect(); } catch (_) {}
  }
  function stopAll() {
    for (const id of [...playing.keys()]) stopScape(id);
    cancelSleep();
  }

  function armSleep(mins) {
    ensureCtx();
    cancelSleep();
    if (!mins) return;
    const now = ctx.currentTime;
    sleepDeadline = now + mins * 60;
    // Audio-clock fade: guaranteed silence at the deadline even if JS
    // is suspended; 30 s gentle fade before it.
    master.gain.setValueAtTime(master.gain.value, Math.max(now, sleepDeadline - 30));
    master.gain.linearRampToValueAtTime(0.0001, sleepDeadline);
    // Best-effort node cleanup when JS wakes at/after the deadline.
    sleepCleanup = setTimeout(() => {
      stopAll();
      master.gain.cancelScheduledValues(0);
      master.gain.value = prefs.master;
    }, mins * 60e3 + 2000);
  }
  function cancelSleep() {
    sleepDeadline = 0;
    if (sleepCleanup) { clearTimeout(sleepCleanup); sleepCleanup = 0; }
    if (master) {
      master.gain.cancelScheduledValues(0);
      master.gain.value = prefs.master;
    }
  }

  // ── view ──
  function buildScapes(view) {
    let tiles = '';
    for (const s of SCAPES) {
      const v = prefs.vols[s.id] != null ? prefs.vols[s.id] : 0.7;
      tiles += '<div class="scp-tile" data-id="' + s.id + '">' +
        '<div class="t"><span>' + s.icon + '</span><span>' + s.name + '</span></div>' +
        '<input type="range" min="0" max="1" step="0.01" value="' + v + '" data-vol="' + s.id + '">' +
        '</div>';
    }
    view.innerHTML =
      '<div class="scp-grid">' + tiles + '</div>' +
      '<div class="scp-master">&#128266; master' +
        '<input type="range" min="0" max="1" step="0.01" id="scpMaster" value="' + prefs.master + '">' +
      '</div>' +
      '<div class="scp-pills" id="scpSleep">' +
        '<span style="align-self:center;font-size:12.5px;color:var(--ui-muted)">sleep timer</span>' +
        '<button data-min="0" class="on">off</button>' +
        '<button data-min="15">15 m</button>' +
        '<button data-min="30">30 m</button>' +
        '<button data-min="60">60 m</button>' +
      '</div>' +
      '<div class="scp-count" id="scpCount"></div>' +
      '<button class="scp-stop" id="scpStop">Stop all</button>' +
      '<div class="scp-note">keeps playing when you close this panel — stop here or via the sleep timer</div>';

    const grid = view.querySelector('.scp-grid');
    const countEl = view.querySelector('#scpCount');
    const sleepRow = view.querySelector('#scpSleep');

    grid.addEventListener('click', (ev) => {
      if (ev.target.matches('input[type=range]')) return;
      const tile = ev.target.closest('.scp-tile');
      if (!tile) return;
      const def = SCAPES.find((s) => s.id === tile.dataset.id);
      if (!def) return;
      if (playing.has(def.id)) { stopScape(def.id); tile.classList.remove('on'); }
      else { startScape(def); tile.classList.add('on'); }
    });
    grid.addEventListener('input', (ev) => {
      const id = ev.target.dataset.vol;
      if (!id) return;
      prefs.vols[id] = parseFloat(ev.target.value);
      savePrefs();
      const p = playing.get(id);
      if (p) p.tileGain.gain.value = prefs.vols[id];
    });
    view.querySelector('#scpMaster').addEventListener('input', (ev) => {
      prefs.master = parseFloat(ev.target.value);
      savePrefs();
      if (master && !sleepDeadline) master.gain.value = prefs.master;
    });
    sleepRow.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      sleepRow.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      armSleep(parseInt(b.dataset.min, 10));
    });
    view.querySelector('#scpStop').onclick = () => {
      stopAll();
      view.querySelectorAll('.scp-tile.on').forEach((t) => t.classList.remove('on'));
      sleepRow.querySelectorAll('button').forEach((x) =>
        x.classList.toggle('on', x.dataset.min === '0'));
    };

    // UI ticker (tile sync + countdown) — only while visible; the AUDIO
    // deliberately does not depend on this.
    let timer = 0;
    const tick = () => {
      view.querySelectorAll('.scp-tile').forEach((t) =>
        t.classList.toggle('on', playing.has(t.dataset.id)));
      if (sleepDeadline && ctx) {
        const left = Math.max(0, sleepDeadline - ctx.currentTime);
        countEl.textContent = left > 0
          ? 'fading out in ' + Math.floor(left / 60) + ':' + String(Math.floor(left % 60)).padStart(2, '0')
          : '';
        if (left <= 0) sleepRow.querySelectorAll('button').forEach((x) =>
          x.classList.toggle('on', x.dataset.min === '0'));
      } else countEl.textContent = '';
    };
    const panel = document.getElementById('extrasPanel');
    const check = () => {
      const vis = !view.hidden && panel && panel.classList.contains('show')
        && document.visibilityState === 'visible';
      if (vis && !timer) { timer = setInterval(tick, 1000); tick(); }
      else if (!vis && timer) { clearInterval(timer); timer = 0; }
    };
    new MutationObserver(check).observe(view, { attributes: true, attributeFilter: ['hidden'] });
    if (panel) new MutationObserver(check).observe(panel, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', check);
    view._scpCheck = check;
  }

  RT({
    id: 'scapes',
    name: 'Soundscapes',
    label: 'Sound<br>scapes',
    icon: '\u{1F343}',
    build: buildScapes,
    onShow: function () {
      const v = document.getElementById('extras_scapes');
      if (v && v._scpCheck) v._scpCheck();
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
