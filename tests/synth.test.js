// Headless tests for the synth (static/synth.html) recorder/looper state machine.
// Run: node tests/synth.test.js
//
// The synth is a standalone page with one inline script; we stub just enough
// DOM + WebAudio + timers to run it deterministically under Node. Timers and
// the AudioContext clock share a single virtual clock, so scheduling behavior
// (loop cycles, metronome, throttled-tab catch-up) is fully reproducible.

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL: ' + msg); }
}

/* ── virtual clock + timers (seconds) ── */
let now = 0;
let timers = [], timerSeq = 1;
global.setTimeout = (fn, d) => { const id = timerSeq++; timers.push({ id, fn, at: now + Math.max(0, d || 0) / 1000 }); return id; };
global.clearTimeout = (id) => { timers = timers.filter(t => t.id !== id); };
function advance(sec) {          // run due timers in order while moving the clock
  const target = now + sec;
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const t = timers.find(x => x.at <= target);
    if (!t) break;
    timers = timers.filter(x => x !== t);
    now = Math.max(now, t.at);
    t.fn();
  }
  now = target;
}
function jump(sec) { now += sec; } // move the clock WITHOUT running timers (≈ background-tab throttle)

/* ── minimal DOM ── */
function findSel(root, sel, out) {
  out = out || [];
  for (const c of root.children) {
    if (sel === 'button' ? c.tagName === 'button' : sel[0] === '.' && c.classList.contains(sel.slice(1))) out.push(c);
    findSel(c, sel, out);
  }
  return out;
}
function parseMini(html) {
  const els = []; const re = /<(div|button)([^>]*)>/g; let m;
  while ((m = re.exec(html))) {
    const e = makeEl(m[1]);
    const cm = /class="([^"]*)"/.exec(m[2]);
    if (cm) { e.className = cm[1]; cm[1].split(/\s+/).forEach(c => c && e.classList.add(c)); }
    els.push(e);
  }
  return els;
}
function makeEl(tag) {
  const el = {
    tagName: tag, children: [], style: {}, textContent: '', className: '', id: '',
    parentNode: null, value: '', _listeners: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, f) {
        if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }
        else { f ? this._s.add(c) : this._s.delete(c); }
        return this._s.has(c);
      },
      contains(c) { return this._s.has(c); },
    },
    appendChild(ch) { el.children.push(ch); ch.parentNode = el; return ch; },
    remove() { if (el.parentNode) el.parentNode.children = el.parentNode.children.filter(c => c !== el); },
    addEventListener(ev, fn) { (el._listeners[ev] = el._listeners[ev] || []).push(fn); },
    removeEventListener(ev, fn) { if (el._listeners[ev]) el._listeners[ev] = el._listeners[ev].filter(f => f !== fn); },
    querySelector(sel) { return findSel(el, sel)[0] || null; },
    querySelectorAll(sel) { return findSel(el, sel); },
    set innerHTML(v) { el._html = v; el.children = parseMini(v); el.children.forEach(c => { c.parentNode = el; }); },
    get innerHTML() { return el._html || ''; },
  };
  return el;
}

const ids = {};
['soundPad', 'drumGrid', 'tempoSlider', 'tempoValue', 'metronomeBtn', 'metronomeLight', 'barCounter',
 'beatIndicator', 'recordBtn', 'playAllBtn', 'stopBtn', 'clearBtn', 'recordingsToggle', 'dropdownArrow',
 'recordingsPanel', 'recordingsList', 'recordingBadge', 'instrumentBtn'].forEach(id => { ids[id] = makeEl('div'); ids[id].id = id; });
ids.soundPad.clientWidth = 800; ids.soundPad.clientHeight = 600;
ids.tempoSlider.value = '120';

function byIdDeep(root, id) {
  for (const c of root.children) {
    if (c.id === id) return c;
    const r = byIdDeep(c, id); if (r) return r;
  }
  return null;
}
let domReady = null;
const docListeners = {};
global.document = {
  getElementById: (id) => ids[id] || byIdDeep(ids.recordingsList, id),
  createElement: makeEl,
  addEventListener(ev, fn) {
    if (ev === 'DOMContentLoaded') { domReady = fn; return; }
    (docListeners[ev] = docListeners[ev] || []).push(fn);
  },
  removeEventListener(ev, fn) { if (docListeners[ev]) docListeners[ev] = docListeners[ev].filter(f => f !== fn); },
};

/* ── fake WebAudio ── */
let oscCount = 0;
function fakeParam() { return { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} }; }
function fakeNode() { return { type: '', buffer: null, frequency: fakeParam(), connect() {}, start() {}, stop() {} }; }
class FakeCtx {
  constructor() { this.state = 'running'; this.destination = {}; this.sampleRate = 512; }
  get currentTime() { return now; }
  resume() {}
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
  createBufferSource() { return fakeNode(); }
  createOscillator() { oscCount++; return fakeNode(); }
  createGain() { const n = fakeNode(); n.gain = fakeParam(); return n; }
  createBiquadFilter() { return fakeNode(); }
}
global.window = global;
global.AudioContext = FakeCtx;
global.confirm = () => true;
global.addEventListener = () => {};

/* ── load the synth script ── */
const html = fs.readFileSync(path.join(__dirname, '..', 'static', 'synth.html'), 'utf8');
const src = /<script>([\s\S]*)<\/script>/.exec(html)[1];
vm.runInThisContext(src, { filename: 'synth.html#inline' });
now = 7.3;                       // pretend the page sat idle a while before first use
domReady();

const pad = ids.soundPad, recordBtn = ids.recordBtn, playBtn = ids.playAllBtn,
      stopBtn = ids.stopBtn, clearBtn = ids.clearBtn, instBtn = ids.instrumentBtn,
      badge = ids.recordingBadge, recordingsList = ids.recordingsList;
const fire = (el, ev, e) => (el._listeners[ev] || []).forEach(f => f(e));
const mouseDown = (x, y) => fire(pad, 'mousedown', { type: 'mousedown', clientX: x, clientY: y, preventDefault() {} });
const mouseUp = () => (docListeners.mouseup || []).slice().forEach(f => f({ type: 'mouseup' }));
const song = () => global.SynthApp.getSong();

/* ── T1: recording without the metronome anchors at record start ── */
recordBtn.onclick();
ok(recordBtn.textContent === 'Rec*', 'T1: recording armed');
advance(0.25);
mouseDown(400, 300);
advance(0.5);
mouseUp();
advance(0.1);
recordBtn.onclick();             // stop → auto-play
const ev1 = song().recordings[0].events;
ok(ev1.length >= 2 && ev1[0].type === 'start', 'T1: start event recorded');
ok(Math.abs(ev1[0].beatPos - 0.5) < 0.02, 'T1: beatPos anchored to record start (got ' + ev1[0].beatPos + ', want ~0.5)');
ok(ev1[ev1.length - 1].type === 'end' && Math.abs(ev1[ev1.length - 1].beatPos - 1.5) < 0.02, 'T1: end event at ~beat 1.5');
ok(ev1.every(e => e.beatPos >= 0), 'T1: no negative beatPos');
ok(playBtn.textContent === 'Playing', 'T1: auto-play started after stop');

/* ── T2: playback fires promptly from the loop top (not after a 16s wait) ── */
const osc2 = oscCount;
advance(0.4);                    // note plays ~0.27s in, held until ~0.77s
ok(oscCount > osc2, 'T2: recorded note replayed within 0.4s of stopping recording');
ok(pad.children.some(c => c.className === 'playback-marker'), 'T2: playback marker shown');
advance(0.6);

/* ── T3: Stop button ends recording WITHOUT starting playback ── */
clearBtn.onclick();
ok(playBtn.textContent === 'Play' && song().recordings.length === 0, 'T3: clear resets everything');
recordBtn.onclick();
advance(0.2); mouseDown(200, 200); advance(0.3); mouseUp(); advance(0.1);
stopBtn.onclick();
ok(recordBtn.textContent === 'Rec', 'T3: stop button ended recording');
ok(playBtn.textContent === 'Play', 'T3: stop button did NOT start playback');
ok(song().recordings.length === 1, 'T3: track kept');
ok(String(badge.textContent) === '1' && badge.classList.contains('visible'), 'T3: track active in badge');

/* ── T4: Play pressed WHILE recording → single schedule, fully stoppable ── */
clearBtn.onclick();
recordBtn.onclick();
advance(0.2); mouseDown(300, 300); advance(0.3); mouseUp(); advance(0.05);
playBtn.onclick();               // while isRec — old code double-scheduled and leaked a ghost cycle chain
ok(playBtn.textContent === 'Playing' && recordBtn.textContent === 'Rec', 'T4: play-during-rec transitions to playback');
const osc4 = oscCount;
advance(2.0);
ok(oscCount - osc4 === 1, 'T4: note dispatched exactly once per pass (got ' + (oscCount - osc4) + ')');
stopBtn.onclick();
const osc4b = oscCount;
advance(40);
ok(oscCount === osc4b, 'T4: no ghost loop after Stop (osc delta ' + (oscCount - osc4b) + ')');

/* ── T5: note still held when recording stops gets a closing end event ── */
clearBtn.onclick();
recordBtn.onclick();
advance(0.1); mouseDown(500, 200); advance(0.5);
recordBtn.onclick();             // stop while HOLDING the note
const ev5 = song().recordings[0].events;
ok(ev5.some(e => e.type === 'end' && e.id === ev5[0].id, 'T5'), 'T5: held note closed out on stop');
mouseUp();
stopBtn.onclick();

/* ── T6: drum taps at the exact grid edges don't crash ── */
clearBtn.onclick();
instBtn.onclick();               // → drums
let threw = false;
try {
  mouseDown(800, 0);             // top-right corner: nx=1, gy=1 → used to index row 3 / col 6 (out of bounds)
  mouseDown(0, 600);             // bottom-left corner
  mouseDown(799, 599);
} catch (e) { threw = true; }
ok(!threw, 'T6: edge taps in drum mode do not crash');
instBtn.onclick();               // back to synth

/* ── T7: getSong/loadSong roundtrip preserves events and names ── */
recordBtn.onclick();
advance(0.1); mouseDown(100, 100); advance(0.2); mouseUp();
recordBtn.onclick();
stopBtn.onclick();
const s7 = song();
global.SynthApp.loadSong(JSON.parse(JSON.stringify(s7)));
const s7b = song();
ok(s7b.recordings.length === s7.recordings.length &&
   s7b.recordings[0].events.length === s7.recordings[0].events.length &&
   s7b.recordings[0].name === s7.recordings[0].name, 'T7: save/load roundtrip');
ok(s7b.tempo === s7.tempo, 'T7: tempo preserved');

/* ── T8: deleting the row being recorded doesn't wedge the recorder ── */
clearBtn.onclick();
recordBtn.onclick();
advance(0.1); mouseDown(150, 150); advance(0.1); mouseUp();
const row8 = recordingsList.children[recordingsList.children.length - 1];
const del8 = row8.querySelectorAll('button')[1];
let threw8 = false;
try { del8.onclick(); } catch (e) { threw8 = true; }
ok(!threw8, 'T8: deleting active-recording row does not crash');
ok(recordBtn.textContent === 'Rec' && song().recordings.length === 0, 'T8: recorder reset, track gone');
let threw8b = false;
try { mouseDown(150, 150); mouseUp(); } catch (e) { threw8b = true; }
ok(!threw8b, 'T8: pad still usable after delete');

/* ── T9: metronome skips missed beats after tab throttling (no burst) ── */
ids.metronomeBtn.onclick();      // met on
advance(1.5);                    // a few normal ticks
const osc9 = oscCount;
jump(20);                        // clock leaps forward with timers frozen (backgrounded tab)
advance(0.6);                    // timers get to run again
ok(oscCount - osc9 <= 3, 'T9: throttled met catches up without burst-firing (' + (oscCount - osc9) + ' ticks)');
const bc = ids.barCounter.textContent;
advance(10);
ok(ids.barCounter.textContent !== bc, 'T9: metronome still ticking after catch-up');
ids.metronomeBtn.onclick();      // met off

/* ── T10: tempo change mid-playback reschedules once, still stoppable ── */
clearBtn.onclick();
recordBtn.onclick();
advance(0.2); mouseDown(300, 300); advance(0.2); mouseUp(); advance(0.05);
recordBtn.onclick();             // → auto-play
ids.tempoSlider.value = '150';
ids.tempoSlider.oninput({ target: ids.tempoSlider });
ok(ids.tempoValue.textContent === '150 BPM', 'T10: tempo label updated');
advance(30);                     // > one full loop at both tempos, exercises the rescheduled chain
stopBtn.onclick();
const osc10 = oscCount;
advance(40);
ok(oscCount === osc10, 'T10: playback fully stopped after tempo change (osc delta ' + (oscCount - osc10) + ')');

console.log('synth tests: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
