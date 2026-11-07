// Session lifecycle of Extras → Vibration (static/extras-vibration.js)
// against a stubbed HapticPattern plugin.
// Run: node tests/vibration-lifecycle.test.js
//
// Pins the Android fix: play() asks for a `sustained` session and hands the
// auto-stop deadline to the plugin; with a plugin that reports
// backgroundPlay, backgrounding (screen lock) no longer stops the session
// from JS, and the plugin's "stopped" event flips the button back to Start;
// older plugins keep the old stop-on-hidden behaviour; a rejected play()
// shows its error instead of silently doing nothing; a slider burst always
// lands its final value. Runs against a tiny hand-rolled DOM stub.

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL: ' + msg); }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'static', 'extras-vibration.js'), 'utf8');
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeEl(extra) {
  const listeners = {};
  return Object.assign({
    hidden: false, textContent: '', innerHTML: '', value: '', dataset: {},
    classList: { toggle() {} },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    fire(t, ev) { (listeners[t] || []).forEach((fn) => fn(Object.assign({ target: this }, ev || {}))); },
    querySelectorAll() { return []; },
    getContext() {
      return new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
    },
    focus() {},
  }, extra || {});
}

// Boots the module in a fresh context; returns handles to drive it.
function boot({ plugin, platform = 'android' }) {
  const docListeners = {};
  const document = {
    hidden: false,
    head: { appendChild() {} },
    getElementById() { return null; },
    createElement() { return {}; },
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
  };
  const range = fakeEl({ dataset: { k: 'intensity' }, value: '0.85' });
  const els = {};
  const view = fakeEl({
    querySelector(sel) { return (els[sel] = els[sel] || fakeEl()); },
    querySelectorAll(sel) { return sel === 'input[type="range"]' ? [range] : []; },
  });
  let observer = null;
  let tool = null;
  const store = {};
  const win = {
    document,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    navigator: {},
    Capacitor: { getPlatform: () => platform, Plugins: { HapticPattern: plugin } },
    ExtrasRegisterTool: (t) => { tool = t; },
    MutationObserver: function (cb) { observer = cb; this.observe = () => {}; },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval, Math,
    console: { log() {}, warn() {}, error() {} }, Date, JSON, Promise, Object, Array, String,
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SRC, win);
  tool.build(view);
  return {
    view, els, range, document,
    play: () => els['.vib-play'],
    err: () => els['.vib-err'],
    note: () => els['.vib-note'],
    autostop: () => els['.vib-autostop'],
    setHidden(h) { document.hidden = h; (docListeners.visibilitychange || []).forEach((fn) => fn()); },
    leaveTool() { view.hidden = true; observer && observer(); },
  };
}

function fakePlugin({ backgroundPlay, failPlay } = {}) {
  const calls = [];
  const listeners = {};
  return {
    calls, listeners,
    isSupported() {
      const r = { supported: true, reason: '' };
      if (backgroundPlay) r.backgroundPlay = true;
      return Promise.resolve(r);
    },
    play(o) { calls.push(['play', o]); return failPlay ? Promise.reject(new Error(failPlay)) : Promise.resolve(); },
    update(o) { calls.push(['update', o]); return Promise.resolve(); },
    stop() { calls.push(['stop']); return Promise.resolve(); },
    addListener(ev, fn) { listeners[ev] = fn; return Promise.resolve({ remove() {} }); },
  };
}
const count = (calls, name) => calls.filter((c) => c[0] === name).length;
const lastOf = (calls, name) => calls.filter((c) => c[0] === name).pop();

(async () => {
  // ── 1. current plugin: sustained play, keeps going behind the lock screen ──
  {
    const p = fakePlugin({ backgroundPlay: true });
    const ui = boot({ plugin: p });
    await tick();
    ok(typeof p.listeners.stopped === 'function', 'subscribes to the plugin\'s "stopped" event');
    ui.play().fire('click');
    await tick();
    const pl = lastOf(p.calls, 'play');
    ok(pl && pl[1].sustained === true, 'play() asks for a sustained session');
    ok(pl && pl[1].stopAfterMs === 0, 'no auto-stop → stopAfterMs 0');
    ok(/Stop/.test(ui.play().innerHTML), 'button reads Stop while playing');
    ok(/screen locked/.test(ui.note().textContent), 'note explains it keeps going when locked');

    ui.setHidden(true);
    await tick();
    ok(count(p.calls, 'stop') === 0, 'screen lock / background does not stop from JS');
    ui.setHidden(false);
    ok(/Stop/.test(ui.play().innerHTML), 'still playing after coming back');

    p.listeners.stopped({ reason: 'left' });
    ok(/Start/.test(ui.play().innerHTML), 'plugin "stopped" event flips the button back to Start');
    ui.play().fire('click');
    await tick();
    ok(count(p.calls, 'play') === 2, 'Start works again after a native stop');

    ui.leaveTool();
    ok(count(p.calls, 'stop') === 1, 'leaving the Vibration screen still stops');
  }

  // ── 2. auto-stop deadline reaches the plugin ──
  {
    const p = fakePlugin({ backgroundPlay: true });
    const ui = boot({ plugin: p });
    await tick();
    ui.autostop().value = '5';
    ui.autostop().fire('change');
    ui.play().fire('click');
    await tick();
    const ms = lastOf(p.calls, 'play')[1].stopAfterMs;
    ok(ms > 299000 && ms <= 300000, 'play() carries the auto-stop deadline (' + ms + ' ms)');
    ui.autostop().value = '10';
    ui.autostop().fire('change');
    const up = lastOf(p.calls, 'update');
    ok(up && up[1].stopAfterMs > 599000 && up[1].stopAfterMs <= 600000,
      'changing the timer mid-session re-arms it in the plugin');
    ui.autostop().value = '0';
    ui.autostop().fire('change');
    ok(lastOf(p.calls, 'update')[1].stopAfterMs === 0, 'turning auto-stop off clears the plugin timer');
    ui.play().fire('click'); // stop
  }

  // ── 3. older plugin (no backgroundPlay): stops on hidden, as before ──
  {
    const p = fakePlugin({});
    const ui = boot({ plugin: p });
    await tick();
    ui.play().fire('click');
    await tick();
    ui.setHidden(true);
    ok(count(p.calls, 'stop') === 1, 'old plugin: backgrounding stops the session');
    ok(/Battery Saver/.test(ui.note().textContent), 'old Android build: note points at Battery Saver / Media vibration');
  }

  // ── 4. iOS: no Android hint, old lifecycle ──
  {
    const p = fakePlugin({});
    const ui = boot({ plugin: p, platform: 'ios' });
    await tick();
    ok(!/Feel nothing/.test(ui.note().textContent), 'iOS: no Android settings hint');
  }

  // ── 5. a failing play() is shown, not swallowed ──
  {
    const p = fakePlugin({ backgroundPlay: true, failPlay: 'play-failed: boom' });
    const ui = boot({ plugin: p });
    await tick();
    ui.play().fire('click');
    await tick(); await tick();
    ok(ui.err().hidden === false && /boom/.test(ui.err().textContent), 'play() rejection shows in the UI');
  }

  // ── 6. slider burst: the final value always lands ──
  {
    const p = fakePlugin({ backgroundPlay: true });
    const ui = boot({ plugin: p });
    await tick();
    ui.play().fire('click');
    await tick();
    for (const v of ['0.5', '0.4', '0.3', '0.2']) { ui.range.value = v; ui.range.fire('input'); }
    await sleep(150);
    const up = lastOf(p.calls, 'update');
    ok(up && up[1].intensity === 0.2, 'trailing throttle applies the last slider value (got ' + (up && up[1].intensity) + ')');
    ok(count(p.calls, 'update') <= 2, 'slider burst is throttled (' + count(p.calls, 'update') + ' updates for 4 inputs)');
    ui.play().fire('click');
  }

  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
