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
 'recordingsPanel', 'recordingsList', 'recordingBadge', 'instrumentBtn',
 'scaleSel', 'rootSel', 'scaleGrid', 'scaleLabels', 'info', 'scrubSlider'].forEach(id => { ids[id] = makeEl('div'); ids[id].id = id; });
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
global.localStorage = { _o: {}, getItem(k) { return k in this._o ? this._o[k] : null; },
  setItem(k, v) { this._o[k] = String(v); }, removeItem(k) { delete this._o[k]; } };

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

/* ── T1: recording without the metronome anchors at the Rec press ──
   (deliberate user preference: beat 0 = the press, so off-beat starts work) */
recordBtn.onclick();
ok(recordBtn.textContent === 'Rec*', 'T1: recording armed');
advance(0.25);                   // an intentional off-beat start — must be preserved
mouseDown(400, 300);
advance(0.5);
mouseUp();
advance(0.1);
recordBtn.onclick();             // stop → auto-play
const ev1 = song().recordings[0].events;
ok(ev1.length >= 2 && ev1[0].type === 'start', 'T1: start event recorded');
ok(Math.abs(ev1[0].beatPos - 0.5) < 0.02, 'T1: beatPos anchored to Rec press (got ' + ev1[0].beatPos + ', want ~0.5)');
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

/* ── T11: quantize — notes snap to the chosen scale and project onto its lines ── */
clearBtn.onclick();
const BASE = 130.81, PENT_D = [2, 4, 6, 9, 11];      // D major pentatonic pitch classes
ids.scaleSel.value = 'majpent'; ids.scaleSel.onchange();
ids.rootSel.value = '2'; ids.rootSel.onchange();
ok(ids.scaleGrid.style.display === 'block', 'T11: grid overlay shown');
ok((ids.scaleGrid.innerHTML.match(/<line/g) || []).length === 23, 'T11: one line per reachable scale note (23)');
ok((ids.scaleLabels.innerHTML.match(/scale-label/g) || []).length === 5, 'T11: only root lines labelled (D3..D7)');
recordBtn.onclick();
[[123, 456], [700, 80], [400, 300], [200, 150], [600, 400]].forEach(([x, y]) => {
  advance(0.05); mouseDown(x, y); advance(0.05); mouseUp();
});
recordBtn.onclick(); stopBtn.onclick();
const evq = song().recordings[0].events.filter(e => e.type === 'start');
ok(evq.length === 5, 'T11: five notes recorded');
ok(evq.every(e => {
  const s = 12 * Math.log2(e.f / BASE), k = Math.round(s);
  return Math.abs(s - k) < 1e-6 && PENT_D.includes(((k % 12) + 12) % 12);
}), 'T11: every recorded pitch is an exact D-pentatonic note');
ok(evq.every(e => {
  const k = Math.round(12 * Math.log2(e.f / BASE));
  return Math.abs(35 * e.nx + 20 * e.ny - k) < 0.05;
}), 'T11: recorded positions sit on the iso-pitch lines');
ids.scaleSel.value = 'off'; ids.scaleSel.onchange();
ok(ids.scaleGrid.style.display === 'none', 'T11: grid hidden when quantize off');
recordBtn.onclick();
advance(0.05); mouseDown(123, 456); advance(0.05); mouseUp();
recordBtn.onclick(); stopBtn.onclick();
const evFree = song().recordings[1].events.find(e => e.type === 'start');
const sFree = 12 * Math.log2(evFree.f / BASE);
ok(Math.abs(sFree - Math.round(sFree)) > 0.05, 'T11: quantize off leaves pitch continuous');

/* ── T12: scale + root ride through getSong/loadSong ── */
ids.scaleSel.value = 'majpent'; ids.scaleSel.onchange();
ids.rootSel.value = '2'; ids.rootSel.onchange();
const s12 = song();
ok(s12.scale === 'majpent' && s12.root === 2, 'T12: getSong carries scale + root');
global.SynthApp.loadSong({ v: 1, tempo: 100, recordings: [] });   // legacy song: no scale fields
ok(String(ids.scaleSel.value) === 'majpent', 'T12: legacy song leaves quantize prefs alone');
global.SynthApp.loadSong({ v: 1, tempo: 120, scale: 'blues', root: 7, recordings: [] });
ok(String(ids.scaleSel.value) === 'blues' && String(ids.rootSel.value) === '7', 'T12: loadSong applies saved scale');
ok(ids.scaleGrid.style.display === 'block', 'T12: grid re-rendered after load');
ids.scaleSel.value = 'off'; ids.scaleSel.onchange();

/* ── T13: loop position ticker drives the beat dots without the metronome ── */
clearBtn.onclick();
recordBtn.onclick();             // beat 0 = the Rec press
advance(0.6);                    // past the beat-1 boundary (0.5s) + one 80ms ticker period
ok(ids.beatIndicator.children[1].classList.contains('active'), 'T13: dot tracks from the Rec press');
mouseDown(300, 300); advance(0.05); mouseUp();
advance(1.3);                    // ≈3.9 beats since the press
const active13 = ids.beatIndicator.children.findIndex(c => c.classList.contains('active'));
ok(active13 === 3, 'T13: dot tracks loop position (got ' + active13 + ', want 3)');
ok(String(ids.barCounter.textContent) === '1.4', 'T13: bar counter follows (got ' + ids.barCounter.textContent + ')');
recordBtn.onclick();             // stop → auto-play; ticker keeps running
advance(0.3);
ok(ids.beatIndicator.children.some(c => c.classList.contains('active')), 'T13: ticker active during playback');
stopBtn.onclick();
advance(0.3);
ok(!ids.beatIndicator.children.some(c => c.classList.contains('active')), 'T13: dots cleared when idle');

/* ── T14: time scrubber — auto-follows, scrubs live, Play resumes from playhead ── */
clearBtn.onclick();
ok(String(ids.scrubSlider.value) === '0', 'T14: playhead cleared to 0');
recordBtn.onclick();
ok(ids.scrubSlider.disabled === true, 'T14: scrubbing disabled while recording');
advance(0.5); mouseDown(300, 300); advance(0.2); mouseUp(); advance(0.1);
recordBtn.onclick();             // stop → auto-play from the top
ok(ids.scrubSlider.disabled === false, 'T14: scrubbing re-enabled after recording');
advance(0.9);
ok(Math.abs(+ids.scrubSlider.value - 1.8) < 0.3, 'T14: slider auto-follows playback (got ' + ids.scrubSlider.value + ')');
ids.scrubSlider.value = '16'; ids.scrubSlider.oninput({ target: ids.scrubSlider });   // live scrub
advance(0.2);
ok(Math.abs(+ids.scrubSlider.value - 16.4) < 0.4, 'T14: live scrub jumps the playhead (got ' + ids.scrubSlider.value + ')');
ok(String(ids.barCounter.textContent) === '5.1', 'T14: bar counter follows the scrub (got ' + ids.barCounter.textContent + ')');
stopBtn.onclick();
advance(0.5);
const frozen14 = +ids.scrubSlider.value;
advance(1.0);
ok(+ids.scrubSlider.value === frozen14, 'T14: playhead freezes when stopped');
ids.scrubSlider.value = '8'; ids.scrubSlider.oninput({ target: ids.scrubSlider });    // scrub while stopped
playBtn.onclick();
advance(0.3);
ok(+ids.scrubSlider.value > 8 && +ids.scrubSlider.value < 8.8, 'T14: Play resumes from scrubbed position (got ' + ids.scrubSlider.value + ')');
stopBtn.onclick();
advance(0.3);

console.log('synth tests: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
