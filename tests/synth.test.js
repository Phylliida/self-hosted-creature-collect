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
const ctxStub = new Proxy({}, { get: () => () => {}, set: () => true });
function makeEl(tag) {
  const el = {
    tagName: tag, children: [], style: {}, textContent: '', className: '', id: '',
    parentNode: null, value: '', _listeners: {},
    getContext: () => ctxStub,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 54, height: 600, right: 54, bottom: 600 }),
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
    contains(n) {
      if (n === el) return true;
      return el.children.some(c => c.contains && c.contains(n));
    },
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
 'beatIndicator', 'recordBtn', 'playAllBtn', 'stopBtn', 'recordingsToggle', 'dropdownArrow',
 'recordingsPanel', 'recordingsList', 'recordingBadge', 'instrumentBtn',
 'scaleSel', 'rootSel', 'scaleGrid', 'scaleLabels', 'info', 'scrubSlider',
 'edoSel', 'hexGrid', 'synthCfgBtn', 'synthCfgPanel', 'baseOctSel', 'hexSizeSel',
 'edgeInsetSel', 'bottomStack', 'hexEastSel', 'hexNESel',
 'barsSel', 'timeSigSel', 'voiceSel', 'voiceLabBtn', 'voiceLabPanel',
 'vlCount', 'vlCountV', 'vlStretch', 'vlStretchV', 'vlTilt', 'vlTiltV',
 'vlSieve', 'vlWidth', 'vlWidthV', 'vlAttack', 'vlAttackV', 'vlDecay', 'vlDecayV',
 'vlMatch', 'vlSpec', 'labToggle', 'vlClose', 'vlName', 'vlSave', 'vlList',
 'vlBreath', 'vlBreathV', 'vlFormantF', 'vlFormantFV', 'vlFormantA', 'vlFormantAV',
 'vlDamping', 'vlDampingV', 'vlMotion', 'vlMotionV', 'vlChiff', 'vlChiffV',
 'vlPresets', 'vlPad', 'vlPadNote', 'vlRandom', 'vlPadOct',
 'vlStrikeF', 'vlStrikeFV', 'vlStrikeT', 'vlStrikeTV'].forEach(id => { ids[id] = makeEl('div'); ids[id].id = id; });
ids.synthCfgPanel.hidden = true;         // markup ships with the hidden attribute
ids.voiceLabPanel.hidden = true;
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
let oscCount = 0, compCount = 0, bufMade = 0;
const oscMade = [], filtMade = [];
function fakeParam() { return { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} }; }
function fakeNode() { const n = { type: '', buffer: null, frequency: fakeParam(), stopped: false, connect() {}, start() {}, stop() { n.stopped = true; } }; return n; }
class FakeCtx {
  constructor() { this.state = 'running'; this.destination = {}; this.sampleRate = 512; }
  get currentTime() { return now; }
  resume() {}
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
  createBufferSource() { bufMade++; return fakeNode(); }
  createOscillator() { oscCount++; const n = fakeNode(); oscMade.push(n); return n; }
  createGain() { const n = fakeNode(); n.gain = fakeParam(); return n; }
  createBiquadFilter() { const n = fakeNode(); n.Q = fakeParam(); n.gain = fakeParam(); filtMade.push(n); return n; }
  createDynamicsCompressor() {
    compCount++;
    const n = fakeNode();
    n.threshold = fakeParam(); n.knee = fakeParam(); n.ratio = fakeParam();
    n.attack = fakeParam(); n.release = fakeParam();
    return n;
  }
}
global.window = global;
global.AudioContext = FakeCtx;
let confirmResult = true;
global.confirm = () => confirmResult;
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
      // Clear moved to the extras window's top bar — the shim calls the bridge
      // the bar button uses, keeping the existing clearBtn.onclick() call sites
      clearBtn = { onclick: () => global.SynthApp.clearAll() },
      stopBtn = ids.stopBtn, instBtn = ids.instrumentBtn,
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
instBtn.onclick(); instBtn.onclick();   // synth → hex → drums
ok(instBtn.textContent === 'Drums', 'T6: drums mode reached via 3-way cycle');
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
ids.metronomeBtn.onclick();      // met mode on (idle → silent; ticks once a session starts)
recordBtn.onclick();             // recording session → ticking begins
advance(1.5);                    // a few normal ticks
const osc9 = oscCount;
jump(20);                        // clock leaps forward with timers frozen (backgrounded tab)
advance(0.6);                    // timers get to run again
ok(oscCount - osc9 <= 3, 'T9: throttled met catches up without burst-firing (' + (oscCount - osc9) + ' ticks)');
const bc = ids.barCounter.textContent;
advance(10);
ok(ids.barCounter.textContent !== bc, 'T9: metronome still ticking after catch-up');
recordBtn.onclick();             // empty take discards, session ends
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

/* ── T15: microtonal tunings — 13-EDO snapping + chain-of-fifths Lydian ── */
clearBtn.onclick();
ids.edoSel.value = '13'; ids.edoSel.onchange();
ids.scaleSel.value = 'chromatic'; ids.scaleSel.onchange();
ids.rootSel.value = '0'; ids.rootSel.onchange();
recordBtn.onclick();
[[123, 456], [700, 80], [400, 300], [200, 150]].forEach(([x, y]) => {
  advance(0.05); mouseDown(x, y); advance(0.05); mouseUp();
});
recordBtn.onclick(); stopBtn.onclick();
const ev15 = song().recordings[0].events.filter(e => e.type === 'start');
ok(ev15.every(e => {
  const s = 13 * Math.log2(e.f / BASE);
  return Math.abs(s - Math.round(s)) < 1e-6;
}), 'T15: chromatic 13-EDO snaps to exact 13-EDO steps');
ok(ev15.every(e => {
  const k = Math.round(13 * Math.log2(e.f / BASE));
  return Math.abs(40 * e.nx + 20 * e.ny - k) < 0.05;   // 13-EDO axes: X=5·8, Y=5·4
}), 'T15: positions sit on 13-EDO iso-pitch lines');
// Lydian as a chain of 7 fifths generalizes: in 13-EDO (fifth=8) the pitch
// classes are {0,1,3,6,8,9,11}
ids.scaleSel.value = 'lydian'; ids.scaleSel.onchange();
const LYD13 = [0, 1, 3, 6, 8, 9, 11];
recordBtn.onclick();
[[123, 456], [700, 80], [400, 300], [640, 220], [90, 90]].forEach(([x, y]) => {
  advance(0.05); mouseDown(x, y); advance(0.05); mouseUp();
});
recordBtn.onclick(); stopBtn.onclick();
const ev15b = song().recordings[1].events.filter(e => e.type === 'start');
ok(ev15b.every(e => {
  const k = Math.round(13 * Math.log2(e.f / BASE));
  return LYD13.includes(((k % 13) + 13) % 13);
}), 'T15: 13-EDO Lydian only yields chain-scale pitch classes');
// 12-EDO regression: chain-based Major must equal the classic set
ids.edoSel.value = '12'; ids.edoSel.onchange();
ids.scaleSel.value = 'major'; ids.scaleSel.onchange();
ids.rootSel.value = '0'; ids.rootSel.onchange();
const MAJ12 = [0, 2, 4, 5, 7, 9, 11];
recordBtn.onclick();
[[123, 456], [700, 80], [400, 300], [500, 500], [250, 250]].forEach(([x, y]) => {
  advance(0.05); mouseDown(x, y); advance(0.05); mouseUp();
});
recordBtn.onclick(); stopBtn.onclick();
const ev15c = song().recordings[2].events.filter(e => e.type === 'start');
ok(ev15c.every(e => {
  const k = Math.round(12 * Math.log2(e.f / BASE));
  return Math.abs(12 * Math.log2(e.f / BASE) - k) < 1e-6 && MAJ12.includes(((k % 12) + 12) % 12);
}), 'T15: chain-based Major in 12-EDO = classic major scale');

/* ── T16: hex keys — isomorphic translation invariance ── */
clearBtn.onclick();
ids.scaleSel.value = 'off'; ids.scaleSel.onchange();
instBtn.onclick();                                    // synth → hex
ok(instBtn.textContent === 'Hex', 'T16: hex mode entered');
ok(ids.hexGrid.style.display === 'block', 'T16: hex grid shown');
// hex geometry at 800×600 — mirrors hexParams (bottomStack height = 0 in the stub)
const S16 = Math.max(22, Math.min(52, Math.max(160, 600 - 8) / 11.4, 800 / 9.6));
const EAST = Math.sqrt(3) * S16, NEX = Math.sqrt(3) * S16 / 2, NEY = -1.5 * S16;
const stepOf = (f, n) => Math.round(n * Math.log2(f / BASE));
recordBtn.onclick();
advance(0.05); mouseDown(200, 400); advance(0.05); mouseUp();          // base key
advance(0.05); mouseDown(200 + EAST, 400); advance(0.05); mouseUp();   // one key east
advance(0.05); mouseDown(200 + NEX, 400 + NEY); advance(0.05); mouseUp(); // one key NE
recordBtn.onclick(); stopBtn.onclick();
const ev16 = song().recordings[0].events.filter(e => e.type === 'start');
ok(ev16.length === 3, 'T16: three hex taps recorded');
const st0 = stepOf(ev16[0].f, 12), stE = stepOf(ev16[1].f, 12), stNE = stepOf(ev16[2].f, 12);
ok(stE - st0 === 2, 'T16: east neighbour = +2 steps (whole tone) in 12-EDO (got ' + (stE - st0) + ')');
ok(stNE - st0 === 7, 'T16: NE neighbour = +5th (7 steps) in 12-EDO (got ' + (stNE - st0) + ')');
// chord translation: a 3-finger shape moved one key east transposes EVERY
// note by the same interval — the user's requested invariance property
const shape = [[200, 400], [200 + NEX, 400 + NEY], [200 + EAST + NEX, 400 + NEY]];
const chordAt = (dx) => {
  recordBtn.onclick();
  advance(0.05);
  fire(pad, 'touchstart', { type: 'touchstart', preventDefault() {},
    changedTouches: shape.map(([x, y], i) => ({ identifier: 10 + i, clientX: x + dx, clientY: y })) });
  advance(0.1);
  fire(pad, 'touchend', { type: 'touchend',
    changedTouches: shape.map(([x, y], i) => ({ identifier: 10 + i, clientX: x + dx, clientY: y })) });
  advance(0.05);
  recordBtn.onclick(); stopBtn.onclick();
  const r = song().recordings[song().recordings.length - 1];
  return r.events.filter(e => e.type === 'start').map(e => stepOf(e.f, 12)).sort((a, b) => a - b);
};
const c0 = chordAt(0), c1 = chordAt(EAST);
ok(c0.length === 3 && c1.length === 3 &&
   c1.every((s, i) => s - c0[i] === 2), 'T16: translated finger shape = same chord transposed (+2 each; got [' +
   c0.join(',') + '] → [' + c1.join(',') + '])');
// drag onto a neighbouring key retriggers (gliss)
recordBtn.onclick();
advance(0.05); mouseDown(200, 400); advance(0.05);
(docListeners.mousemove || []).slice().forEach(f => f({ type: 'mousemove', clientX: 200 + EAST, clientY: 400, preventDefault() {} }));
advance(0.05); mouseUp();
recordBtn.onclick(); stopBtn.onclick();
const ev16d = song().recordings[song().recordings.length - 1].events;
ok(ev16d.filter(e => e.type === 'start').length === 2 && ev16d.filter(e => e.type === 'end').length === 2,
   'T16: dragging across a key boundary retriggers');
// 13-EDO: east = 2·fifth−octave = 3 steps
ids.edoSel.value = '13'; ids.edoSel.onchange();
recordBtn.onclick();
advance(0.05); mouseDown(200, 400); advance(0.05); mouseUp();
advance(0.05); mouseDown(200 + EAST, 400); advance(0.05); mouseUp();
recordBtn.onclick(); stopBtn.onclick();
const ev16e = song().recordings[song().recordings.length - 1].events.filter(e => e.type === 'start');
ok(stepOf(ev16e[1].f, 13) - stepOf(ev16e[0].f, 13) === 3,
   'T16: 13-EDO east neighbour = +3 steps (2·fifth−octave)');

/* ── T17: edo rides through save/load ── */
const s17 = song();
ok(s17.edo === 13, 'T17: getSong carries edo');
global.SynthApp.loadSong({ v: 1, tempo: 120, scale: 'major', root: 2, recordings: [] });  // legacy: no edo
ok(String(ids.edoSel.value) === '12', 'T17: legacy song with a scale falls back to 12-EDO');
global.SynthApp.loadSong({ v: 1, tempo: 120, edo: 19, scale: 'lydian', root: 3, recordings: [] });
ok(String(ids.edoSel.value) === '19' && String(ids.scaleSel.value) === 'lydian' && String(ids.rootSel.value) === '3',
   'T17: loadSong applies saved edo + chain scale');
// restore defaults
global.SynthApp.loadSong({ v: 1, tempo: 120, edo: 12, scale: 'off', root: 0, recordings: [] });
instBtn.onclick(); instBtn.onclick();                 // hex → drums → synth

/* ── T18: ⚙ options — low note + hex key size ── */
clearBtn.onclick();
ids.synthCfgBtn.onclick();
ok(ids.synthCfgPanel.hidden === false, 'T18: options panel opens');
ids.synthCfgBtn.onclick();
ok(ids.synthCfgPanel.hidden === true, 'T18: options panel closes');
recordBtn.onclick();
advance(0.05); mouseDown(300, 300); advance(0.05); mouseUp();
recordBtn.onclick(); stopBtn.onclick();
const f18a = song().recordings[0].events.find(e => e.type === 'start').f;
ids.baseOctSel.value = '1'; ids.baseOctSel.onchange();          // low note C1
recordBtn.onclick();
advance(0.05); mouseDown(300, 300); advance(0.05); mouseUp();
recordBtn.onclick(); stopBtn.onclick();
const f18b = song().recordings[1].events.find(e => e.type === 'start').f;
ok(Math.abs(f18b / f18a - 0.25) < 1e-9, 'T18: low note C1 = two octaves down (ratio ' + (f18b / f18a).toFixed(4) + ')');
// huge hex keys: lattice scales but translation invariance is untouched
ids.hexSizeSel.value = '1.6'; ids.hexSizeSel.onchange();
instBtn.onclick();                                              // → hex
const S18 = Math.min(96, S16 * 1.6), EAST18 = Math.sqrt(3) * S18;
recordBtn.onclick();
advance(0.05); mouseDown(300, 400); advance(0.05); mouseUp();
advance(0.05); mouseDown(300 + EAST18, 400); advance(0.05); mouseUp();
recordBtn.onclick(); stopBtn.onclick();
const ev18 = song().recordings[2].events.filter(e => e.type === 'start');
ok(stepOf(ev18[1].f, 12) - stepOf(ev18[0].f, 12) === 2, 'T18: huge keys keep east = +2 steps');
ok(ev18.every(e => Math.abs(12 * Math.log2(e.f / (BASE / 4)) - Math.round(12 * Math.log2(e.f / (BASE / 4)))) < 1e-9),
   'T18: hex pitches anchored to the C1 base');
// edge taps snap inward to a real key instead of a sliced one
recordBtn.onclick();
let threw18 = false;
try { advance(0.05); mouseDown(799, 599); advance(0.05); mouseUp(); } catch (e) { threw18 = true; }
recordBtn.onclick(); stopBtn.onclick();
ok(!threw18 && song().recordings[3].events.some(e => e.type === 'start'), 'T18: corner tap plays a clamped key');
// prefs round-trip
const p18 = JSON.parse(global.localStorage.getItem('synth.quant.v1'));
ok(p18.baseOct === 1 && p18.hexScale === 1.6, 'T18: baseOct + hexScale persisted');
// restore defaults
ids.baseOctSel.value = '3'; ids.baseOctSel.onchange();
ids.hexSizeSel.value = '1'; ids.hexSizeSel.onchange();
instBtn.onclick(); instBtn.onclick();                           // hex → drums → synth

/* ── T19: multi-touch at the pad edges + gesture-nav edge margin ── */
clearBtn.onclick();
instBtn.onclick();                                              // → hex
recordBtn.onclick();
advance(0.05);
// hold one finger mid-pad, then land a SECOND finger at the extreme right
// edge — our code path must voice both (the on-device Android failure is the
// system back-gesture zone eating the event before it reaches the page)
fire(pad, 'touchstart', { type: 'touchstart', preventDefault() {},
  changedTouches: [{ identifier: 21, clientX: 400, clientY: 300 }] });
advance(0.1);
fire(pad, 'touchstart', { type: 'touchstart', preventDefault() {},
  changedTouches: [{ identifier: 22, clientX: 799, clientY: 300 }] });
advance(0.1);
fire(pad, 'touchend', { type: 'touchend',
  changedTouches: [{ identifier: 21, clientX: 400, clientY: 300 },
                   { identifier: 22, clientX: 799, clientY: 300 }] });
advance(0.05);
recordBtn.onclick(); stopBtn.onclick();
const ev19 = song().recordings[0].events;
ok(ev19.filter(e => e.type === 'start').length === 2 && ev19.filter(e => e.type === 'end').length === 2,
   'T19: second finger at the pad edge voices a key while the first is held');
// edge margin pulls keys inward: with inset 40 an edge tap lands ≥ 40+rx from the edge
ids.edgeInsetSel.value = '40'; ids.edgeInsetSel.onchange();
recordBtn.onclick();
advance(0.05); mouseDown(799, 300); advance(0.05); mouseUp();
recordBtn.onclick(); stopBtn.onclick();
const e19b = song().recordings[1].events.find(e => e.type === 'start');
ok(!!e19b && e19b.nx * 800 <= 800 - 40 - Math.sqrt(3) / 2 * S16 + 1,
   'T19: with edge margin, edge taps land on an inset key (marker at ' + (e19b ? (e19b.nx * 800).toFixed(0) : '—') + 'px)');
const p19 = JSON.parse(global.localStorage.getItem('synth.quant.v1'));
ok(p19.edgeInset === 40, 'T19: edge margin persisted');
ids.edgeInsetSel.value = '0'; ids.edgeInsetSel.onchange();
instBtn.onclick(); instBtn.onclick();                           // hex → drums → synth

/* ── T20: 3-finger drags route through one limiter bus, retrigger cleanly ── */
clearBtn.onclick();
instBtn.onclick();                                              // → hex
recordBtn.onclick();
advance(0.05);
const row20 = [[150, 400], [150 + EAST, 400], [150 + 2 * EAST, 400]];  // three adjacent keys
fire(pad, 'touchstart', { type: 'touchstart', preventDefault() {},
  changedTouches: row20.map(([x, y], i) => ({ identifier: 30 + i, clientX: x, clientY: y })) });
advance(0.1);
fire(pad, 'touchmove', { type: 'touchmove', preventDefault() {},    // all three cross one key east
  changedTouches: row20.map(([x, y], i) => ({ identifier: 30 + i, clientX: x + EAST, clientY: y })) });
advance(0.1);
fire(pad, 'touchend', { type: 'touchend',
  changedTouches: row20.map(([x, y], i) => ({ identifier: 30 + i, clientX: x + EAST, clientY: y })) });
advance(0.05);
recordBtn.onclick(); stopBtn.onclick();
const ev20 = song().recordings[0].events;
ok(ev20.filter(e => e.type === 'start').length === 6 && ev20.filter(e => e.type === 'end').length === 6,
   'T20: 3-finger drag retriggers all voices (6 starts / 6 ends)');
ok(compCount === 1, 'T20: single shared limiter bus (got ' + compCount + ' compressors)');
instBtn.onclick(); instBtn.onclick();                           // hex → drums → synth

/* ── T21: gutter taps snap to DRAWN keys — no phantom culled-key hits ── */
clearBtn.onclick();
instBtn.onclick();                                              // → hex
// tap hard against the left edge on six consecutive rows (the cull boundary
// staggers per row — culled lattice keys used to win the nearest-key vote)
const RX21 = Math.sqrt(3) / 2 * S16, OY21 = Math.max(160, 600 - 8) - S16 - 2;
recordBtn.onclick();
for (let r21 = 0; r21 < 6; r21++) {
  const y21 = OY21 - 1.5 * S16 * r21;
  advance(0.05); mouseDown(1, y21); advance(0.05); mouseUp();
}
// and the top-left corner (vertical overshoot used to reach an undrawn row)
advance(0.05); mouseDown(1, 1); advance(0.05); mouseUp();
recordBtn.onclick(); stopBtn.onclick();
const ev21 = song().recordings[0].events.filter(e => e.type === 'start');
ok(ev21.length === 7, 'T21: all edge taps voiced');
ok(ev21.every(e => e.nx * 800 >= RX21 - 1.5 && e.nx * 800 <= 800 - RX21 + 1.5),
   'T21: every hit lands on a drawn key column (worst x=' +
   Math.min(...ev21.map(e => (e.nx * 800))).toFixed(1) + 'px)');
ok(ev21.every(e => (1 - e.ny) * 600 >= S16 - 1.5),
   'T21: no hits above the top drawn row');
instBtn.onclick(); instBtn.onclick();                           // hex → drums → synth

/* ── T22: configurable layout steps (→ / ↗), persisted ── */
clearBtn.onclick();
instBtn.onclick();                                              // → hex
ids.hexEastSel.value = '3'; ids.hexEastSel.onchange();          // custom: minor 3rd east...
ids.hexNESel.value = '4'; ids.hexNESel.onchange();              // ...major 3rd up-right
recordBtn.onclick();
advance(0.05); mouseDown(300, 400); advance(0.05); mouseUp();
advance(0.05); mouseDown(300 + EAST, 400); advance(0.05); mouseUp();
advance(0.05); mouseDown(300 + NEX, 400 + NEY); advance(0.05); mouseUp();
recordBtn.onclick(); stopBtn.onclick();
const ev22 = song().recordings[0].events.filter(e => e.type === 'start');
ok(stepOf(ev22[1].f, 12) - stepOf(ev22[0].f, 12) === 3, 'T22: custom east step (+3) honoured');
ok(stepOf(ev22[2].f, 12) - stepOf(ev22[0].f, 12) === 4, 'T22: custom NE step (+4) honoured');
const p22 = JSON.parse(global.localStorage.getItem('synth.quant.v1'));
ok(p22.hexEast === 3 && p22.hexNE === 4, 'T22: layout steps persisted');
// back to auto: Wicki–Hayden per current EDO
ids.hexEastSel.value = 'auto'; ids.hexEastSel.onchange();
ids.hexNESel.value = 'auto'; ids.hexNESel.onchange();
recordBtn.onclick();
advance(0.05); mouseDown(300, 400); advance(0.05); mouseUp();
advance(0.05); mouseDown(300 + EAST, 400); advance(0.05); mouseUp();
recordBtn.onclick(); stopBtn.onclick();
const ev22b = song().recordings[1].events.filter(e => e.type === 'start');
ok(stepOf(ev22b[1].f, 12) - stepOf(ev22b[0].f, 12) === 2, 'T22: auto restores Wicki–Hayden (+2 east)');
instBtn.onclick(); instBtn.onclick();                           // hex → drums → synth

/* ── T23: spam-wiggle retriggers mid-attack — every voice still closed ── */
clearBtn.onclick();
instBtn.onclick();                                              // → hex
recordBtn.onclick();
advance(0.02); mouseDown(300, 400);
for (let i = 0; i < 20; i++) {                                  // 4ms per crossing — inside the 8ms attack ramp
  advance(0.004);
  (docListeners.mousemove || []).slice().forEach(f =>
    f({ type: 'mousemove', clientX: 300 + (i % 2 ? 0 : EAST), clientY: 400, preventDefault() {} }));
}
advance(0.02); mouseUp();
recordBtn.onclick(); stopBtn.onclick();
const ev23 = song().recordings[0].events;
const st23 = ev23.filter(e => e.type === 'start').length, en23 = ev23.filter(e => e.type === 'end').length;
ok(st23 === 21 && en23 === 21, 'T23: 20 crossings = 21 voices, all released (' + st23 + '/' + en23 + ')');
instBtn.onclick(); instBtn.onclick();                           // hex → drums → synth

/* ── T24: configurable loop shape (measures × beats per measure) ── */
clearBtn.onclick();
ids.barsSel.value = '2'; ids.barsSel.onchange();
ids.timeSigSel.value = '3'; ids.timeSigSel.onchange();          // 2 measures of 3/4 → 6-beat loop
ok(ids.beatIndicator.children.length === 6, 'T24: 6 beat dots (got ' + ids.beatIndicator.children.length + ')');
ok(ids.beatIndicator.children[0].className.includes('accent') &&
   ids.beatIndicator.children[3].className.includes('accent') &&
   !ids.beatIndicator.children[1].className.includes('accent'), 'T24: accents on measure starts');
ok(String(ids.scrubSlider.max) === '6', 'T24: scrubber spans the 6-beat loop');
recordBtn.onclick();
advance(0.25); mouseDown(300, 300); advance(0.2); mouseUp();
advance(3.0);                                                   // past one full 3s loop
mouseDown(300, 300); advance(0.2); mouseUp();                   // this one wraps
advance(0.05);
recordBtn.onclick();                                            // stop → auto-play
const ev24 = song().recordings[0].events.filter(e => e.type === 'start');
ok(ev24.every(e => e.beatPos >= 0 && e.beatPos < 6), 'T24: beatPos wraps inside the 6-beat loop');
const osc24 = oscCount;
advance(3.4);                                                   // ≥ one loop + a bit: first note replays twice
ok(oscCount - osc24 >= 3, 'T24: 6-beat loop cycles every 3s (osc delta ' + (oscCount - osc24) + ')');
stopBtn.onclick();
const s24 = song();
ok(s24.timeSig === 3 && s24.bars === 2, 'T24: loop shape rides in getSong');
const p24 = JSON.parse(global.localStorage.getItem('synth.quant.v1'));
ok(p24.timeSig === 3 && p24.bars === 2, 'T24: loop shape persisted in prefs');
// very long loops collapse the strip to one dot per measure
ids.barsSel.value = '16'; ids.barsSel.onchange();
ids.timeSigSel.value = '9'; ids.timeSigSel.onchange();          // 144 beats
ok(ids.beatIndicator.children.length === 16, 'T24: long loop shows per-measure dots');
// legacy songs restore the classic 4×8
global.SynthApp.loadSong({ v: 1, tempo: 120, recordings: [] });
ok(String(ids.timeSigSel.value) === '4' && String(ids.barsSel.value) === '8' &&
   ids.beatIndicator.children.length === 32, 'T24: legacy song loads as 4 beats × 8 measures');

/* ── T25: per-track instruments — each note replays with its recorded voice ── */
clearBtn.onclick();
instBtn.onclick();                                              // → hex
ids.voiceSel.value = 'organ'; ids.voiceSel.onchange();
recordBtn.onclick();
let mark25 = oscMade.length;
advance(0.05); mouseDown(300, 400); advance(0.05); mouseUp();
ok(oscMade.length - mark25 === 4, 'T25: organ voice = 4 partial oscillators (got ' + (oscMade.length - mark25) + ')');
advance(0.05);
recordBtn.onclick(); stopBtn.onclick();                          // keep track, no auto-play
ok(song().recordings[0].events[0].inst === 'organ', 'T25: instrument stamped on recorded note');
ids.voiceSel.value = 'saw'; ids.voiceSel.onchange();             // switch voice, overdub a second track
recordBtn.onclick();
advance(0.1); mouseDown(500, 400); advance(0.05); mouseUp();
advance(0.05);
recordBtn.onclick(); stopBtn.onclick();
ok(song().recordings[1].events[0].inst === 'saw', 'T25: second track carries its own instrument');
ids.scrubSlider.value = '0';                                     // rewind the playhead to the loop top
ids.scrubSlider.oninput({ target: ids.scrubSlider });
mark25 = oscMade.length;
playBtn.onclick();                                               // both tracks active → layered playback
advance(1.2);
const types25 = oscMade.slice(mark25).map(o => o.type);
ok(types25.filter(t => t === 'sine').length === 4 && types25.filter(t => t === 'sawtooth').length === 1,
   'T25: playback layers organ + strings simultaneously (' + JSON.stringify(types25) + ')');
stopBtn.onclick();
const s25 = song();
global.SynthApp.loadSong(JSON.parse(JSON.stringify(s25)));
ok(song().recordings[0].events[0].inst === 'organ' && song().recordings[1].events[0].inst === 'saw',
   'T25: instruments survive save/load');
const p25 = JSON.parse(global.localStorage.getItem('synth.quant.v1'));
ok(p25.voice === 'saw', 'T25: voice pref persisted');
ids.voiceSel.value = 'sine'; ids.voiceSel.onchange();
instBtn.onclick(); instBtn.onclick();                            // hex → drums → synth

/* ── T26: Rec implies Play — overdubs are heard against the loop ── */
clearBtn.onclick();
recordBtn.onclick();                                             // first take: nothing to play along to
ok(playBtn.textContent === 'Play', 'T26: first take does not fake-start playback');
advance(0.1); mouseDown(300, 300); advance(0.2); mouseUp(); advance(0.05);
recordBtn.onclick();                                             // stop → auto-play
stopBtn.onclick();                                               // full stop, track stays active
ok(playBtn.textContent === 'Play', 'T26: stopped');
ids.scrubSlider.value = '0'; ids.scrubSlider.oninput({ target: ids.scrubSlider });
const osc26 = oscCount;
recordBtn.onclick();                                             // overdub: Rec should engage Play
ok(playBtn.textContent === 'Playing' && recordBtn.textContent === 'Rec*',
   'T26: pressing Rec with active tracks starts playback');
advance(1.0);                                                    // track 1's note (beat ~0.2) replays under the overdub
ok(oscCount > osc26, 'T26: existing loop audible while recording');
mouseDown(500, 300); advance(0.1); mouseUp(); advance(0.05);
recordBtn.onclick();                                             // finish overdub — playback keeps rolling
ok(playBtn.textContent === 'Playing' && song().recordings.length === 2, 'T26: overdub lands as second track, loop still playing');
stopBtn.onclick();

/* ── T27: tapping outside the ⚙ panel dismisses it ── */
const docDown = (target) => (docListeners.pointerdown || []).slice().forEach(f => f({ target }));
ids.synthCfgBtn.onclick();                                       // open
ok(ids.synthCfgPanel.hidden === false, 'T27: panel open');
docDown(ids.synthCfgPanel);                                      // tap ON the panel
ok(ids.synthCfgPanel.hidden === false, 'T27: tapping the panel keeps it open');
docDown(ids.synthCfgBtn);                                        // tap the gear (click handler toggles separately)
ok(ids.synthCfgPanel.hidden === false, 'T27: gear tap excluded from outside-close');
docDown(ids.soundPad);                                           // tap the pad / notes
ok(ids.synthCfgPanel.hidden === true, 'T27: tapping away closes the panel');

/* ── T28: met is session-gated, met implies play, and stays loop-synced ── */
clearBtn.onclick();
recordBtn.onclick();                                             // lay down a track
advance(0.1); mouseDown(300, 300); advance(0.2); mouseUp(); advance(0.05);
recordBtn.onclick(); stopBtn.onclick();                          // track active, all stopped
ids.scrubSlider.value = '0'; ids.scrubSlider.oninput({ target: ids.scrubSlider });
ids.metronomeBtn.onclick();                                      // met on while idle WITH a track
ok(playBtn.textContent === 'Playing', 'T28: met implies play');
advance(0.12);
ok(String(ids.barCounter.textContent) === '1.1', 'T28: first tick lands on the loop top (synced)');
stopBtn.onclick();
ok(ids.metronomeBtn.textContent === 'Met:On', 'T28: met mode stays armed after stop');
const osc28 = oscCount;
advance(5);
ok(oscCount === osc28, 'T28: no ticking while idle (delta ' + (oscCount - osc28) + ')');
playBtn.onclick();                                               // play again → ticking resumes in sync
advance(1.2);
ok(oscCount > osc28 + 2, 'T28: ticking resumes with playback');
stopBtn.onclick();
// empty session: met on plays nothing, but the click starts AT the Rec press
clearBtn.onclick();
ok(ids.metronomeBtn.textContent === 'Met:On', 'T28: met still armed');
ok(playBtn.textContent === 'Play', 'T28: nothing to play in an empty session');
const osc28b = oscCount;
advance(3);
ok(oscCount === osc28b, 'T28: armed met is silent with no session');
recordBtn.onclick();                                             // first take → click begins at beat 0
advance(1.1);
ok(oscCount > osc28b + 1, 'T28: click starts with the first take');
ok(String(ids.barCounter.textContent) === '1.3', 'T28: click grid anchored at the Rec press (got ' + ids.barCounter.textContent + ')');
recordBtn.onclick(); stopBtn.onclick();
ids.metronomeBtn.onclick();                                      // met off, tidy up

/* ── T29: track toggle is a MUTE — immediate, transport-neutral; delete confirms ── */
clearBtn.onclick();
recordBtn.onclick();                                             // note lands around beat 2
advance(1.0); mouseDown(300, 300); advance(0.1); mouseUp(); advance(0.05);
recordBtn.onclick();                                             // stop → auto-play from top
const row29 = recordingsList.children[recordingsList.children.length - 1];
const tog29 = row29.querySelectorAll('button')[0], del29 = row29.querySelectorAll('button')[1];
ok(tog29.textContent === '🔊', 'T29: active track shows unmuted');
advance(0.1);
tog29.onclick();                                                 // mute right away (t≈0.1s, note due at 1.0s)
ok(playBtn.textContent === 'Playing', 'T29: muting does not stop the transport');
let osc29 = oscCount;
advance(1.4);                                                    // past the note position
ok(oscCount === osc29, 'T29: mute cancels this cycle\'s pending notes immediately');
tog29.onclick();                                                 // unmute mid-cycle (t≈1.5s of a 16s loop)
ok(playBtn.textContent === 'Playing', 'T29: unmute leaves transport running');
stopBtn.onclick();
tog29.onclick();                                                 // mute while stopped
ok(playBtn.textContent === 'Play', 'T29: muting while stopped stays stopped');
tog29.onclick();                                                 // unmute while stopped
ok(playBtn.textContent === 'Play', 'T29: unmuting no longer auto-plays');
// unmute joins the CURRENT cycle: start playback muted, unmute before the note
tog29.onclick();                                                 // mute
ids.scrubSlider.value = '0'; ids.scrubSlider.oninput({ target: ids.scrubSlider });
playBtn.onclick();                                               // transport rolls even with everything muted
ok(playBtn.textContent === 'Playing', 'T29: Play works with all tracks muted');
tog29.onclick();                                                 // unmute — joins the rolling cycle
advance(0.2);
tog29.onclick(); tog29.onclick();                                // mute + immediately unmute at t≈0.2s
osc29 = oscCount;
advance(1.2);                                                    // note at 1.0s should play THIS cycle
ok(oscCount > osc29, 'T29: unmute rejoins the current cycle (no wait for wrap)');
stopBtn.onclick();
confirmResult = false;
del29.onclick();
ok(song().recordings.length === 1, 'T29: delete cancelled by confirm');
confirmResult = true;
del29.onclick();
ok(song().recordings.length === 0, 'T29: delete proceeds when confirmed');
// loaded songs arrive unmuted
global.SynthApp.loadSong({ v: 1, tempo: 120, recordings: [{ name: 'T', events: [{ type: 'drum', kind: 'kick', x: .5, gy: .5, localP: .5, beatPos: 0 }] }] });
ok(String(badge.textContent) === '1', 'T29: loaded track is unmuted by default');

/* ── T30: full voice catalog — partial counts, stamping, clean release ── */
clearBtn.onclick();
instBtn.onclick();                                              // → hex
const CATALOG = { sine: 1, tri: 1, saw: 1, square: 1, organ: 4, pluck: 2,
  bell: 4, choir: 4, epiano: 3, mbox: 2, bass: 2, brass: 2, accordion: 3 };
recordBtn.onclick();
let allOk = true, allStamped = true;
for (const [key, nParts] of Object.entries(CATALOG)) {
  ids.voiceSel.value = key; ids.voiceSel.onchange();
  const m30 = oscMade.length;
  advance(0.05); mouseDown(300, 400); advance(0.3); mouseUp();  // long enough to outlast choir's 150ms attack
  if (oscMade.length - m30 !== nParts) { allOk = false; console.error('  voice ' + key + ': ' + (oscMade.length - m30) + ' oscs, want ' + nParts); }
}
advance(2.0);                                                   // bell tail (1.8s) elapses without error
recordBtn.onclick(); stopBtn.onclick();
const ev30 = song().recordings[0].events.filter(e => e.type === 'start');
Object.keys(CATALOG).forEach((key, i) => { if (ev30[i].inst !== key) allStamped = false; });
ok(allOk, 'T30: every voice creates its exact partial count');
ok(allStamped, 'T30: all 13 voices stamp their instrument');
ok(ev30.length === 13 && song().recordings[0].events.filter(e => e.type === 'end').length === 13,
   'T30: every voice releases cleanly (13 starts / ends)');
ids.voiceSel.value = 'sine'; ids.voiceSel.onchange();
instBtn.onclick(); instBtn.onclick();                           // hex → drums → synth

/* ── T31: ⚗ Voice Lab — spectral genome, sieves, tuning-match, round-trip ── */
clearBtn.onclick();
instBtn.onclick();                                              // → hex
ids.voiceLabBtn.onclick();                                      // open lab (also previews)
ok(ids.voiceLabPanel.hidden === false && String(ids.voiceSel.value) === 'lab', 'T31: lab opens and selects the lab voice');
ok(typeof ids.vlSpec.width === 'number' && ids.vlSpec.width > 0, 'T31: spectrum view rendered on open');
// genome: 5 odd harmonics, no stretch/width, pure sustain
ids.vlCount.value = '5'; ids.vlCount.oninput();
ids.vlStretch.value = '0'; ids.vlStretch.oninput();
ids.vlTilt.value = '10'; ids.vlTilt.oninput();
ids.vlWidth.value = '0'; ids.vlWidth.oninput();
ids.vlAttack.value = '0'; ids.vlAttack.oninput();
ids.vlDecay.value = '0'; ids.vlDecay.oninput();
ids.vlSieve.value = 'odd'; ids.vlSieve.onchange();              // previews
// default genome ships matched — ensure OFF for the pure-harmonic assertions
if (JSON.parse(global.localStorage.getItem('synth.quant.v1')).labGen.match) ids.vlMatch.onclick();
advance(3);                                                     // drain preview tails
recordBtn.onclick();
let m31 = oscMade.length;
advance(0.05); mouseDown(300, 400); advance(0.1); mouseUp();
recordBtn.onclick(); stopBtn.onclick();
const ev31 = song().recordings[0].events.find(e => e.type === 'start');
const made31 = oscMade.slice(m31, m31 + 5);
ok(oscMade.length - m31 === 5, 'T31: genome generates exactly 5 partials (got ' + (oscMade.length - m31) + ')');
const ratios31 = made31.map(o => Math.round(o.frequency.value / ev31.f)).join(',');
ok(ratios31 === '1,3,5,7,9', 'T31: odd sieve yields harmonics 1,3,5,7,9 (got ' + ratios31 + ')');
ok(ev31.inst === 'lab' && ev31.gen && ev31.gen.count === 5 && ev31.gen.sieve === 'odd',
   'T31: genome snapshot stamped on the note');
// ✨ tuning match: in 13-EDO every partial must land on a power of the step
ids.edoSel.value = '13'; ids.edoSel.onchange();
ids.vlStretch.value = '30'; ids.vlStretch.oninput();            // stretched → would be inharmonic without match
ids.vlMatch.onclick();                                          // match ON (previews)
advance(3);
recordingsList.children[0].querySelectorAll('button')[0].onclick();   // mute track 1 — keep the osc stream clean
recordBtn.onclick();
m31 = oscMade.length;
advance(0.05); mouseDown(300, 400); advance(0.1); mouseUp();
recordBtn.onclick(); stopBtn.onclick();
const ev31b = song().recordings[1].events.find(e => e.type === 'start');
const aligned = oscMade.slice(m31, m31 + 5).every(o => {
  const steps = 13 * Math.log2(o.frequency.value / ev31b.f);
  return Math.abs(steps - Math.round(steps)) < 1e-9;
});
ok(aligned, 'T31: ✨ matched partials land exactly on 13-EDO steps');
ok(ev31b.gen.match === true && Math.abs(ev31b.gen.stretch - 0.3) < 1e-9, 'T31: stretched+matched genome recorded');
// playback + save/load reproduce the genome exactly
ids.voiceSel.value = 'sine'; ids.voiceSel.onchange();           // lab edits later shouldn't matter
global.SynthApp.loadSong(JSON.parse(JSON.stringify(song())));
ids.scrubSlider.value = '0'; ids.scrubSlider.oninput({ target: ids.scrubSlider });
m31 = oscMade.length;
playBtn.onclick();
advance(1.0);
const played31 = oscMade.slice(m31).filter(o => o.type === 'sine');
ok(played31.length === 10, 'T31: both lab notes replay through their genomes (got ' + played31.length + ' oscs)');
stopBtn.onclick();
const p31 = JSON.parse(global.localStorage.getItem('synth.quant.v1'));
ok(p31.labGen && p31.labGen.count === 5 && p31.labGen.match === true, 'T31: genome persisted in prefs');
ids.vlClose.onclick();                                          // tidy: close the lab
instBtn.onclick(); instBtn.onclick();                           // hex → drums → synth
global.SynthApp.loadSong({ v: 1, tempo: 120, edo: 12, scale: 'off', root: 0, recordings: [] });

/* ── T32: voice library — save, select, play, ride in song files ── */
clearBtn.onclick();
instBtn.onclick();                                              // → hex
ids.labToggle.onclick();                                        // the tab toggle opens the lab
ok(ids.voiceLabPanel.hidden === false, 'T32: ⚗ Lab tab opens');
ids.vlCount.value = '3'; ids.vlCount.oninput();
ids.vlSieve.value = 'oct'; ids.vlSieve.onchange();
advance(3);
ids.vlName.value = 'Bella'; ids.vlSave.onclick();               // save the genome
advance(3);
ok(String(ids.voiceSel.value) === 'v:Bella', 'T32: saved voice becomes the selection');
ok(ids.vlList.children.length === 1, 'T32: library lists the voice');
ok(ids.voiceSel.innerHTML.includes('v:Bella'), 'T32: saved voice appears in the ⚙ Voice picker');
recordBtn.onclick();
advance(0.05); mouseDown(300, 400); advance(0.1); mouseUp();
recordBtn.onclick(); stopBtn.onclick();
const ev32 = song().recordings[0].events.find(e => e.type === 'start');
ok(ev32.inst === 'lab' && ev32.gen && ev32.gen.count === 3 && ev32.gen.sieve === 'oct',
   'T32: notes played with a saved voice stamp its genome');
ids.vlCount.value = '7'; ids.vlCount.oninput();                 // tweaking detaches to the live Lab voice
ok(String(ids.voiceSel.value) === 'lab', 'T32: slider edits switch back to the live Lab voice');
ids.vlList.children[0].querySelectorAll('button')[0].onclick(); // pick Bella again
advance(3);
ok(String(ids.voiceSel.value) === 'v:Bella', 'T32: picking from the library reselects it');
const p32 = JSON.parse(global.localStorage.getItem('synth.quant.v1'));
ok(p32.labGen.count === 3, 'T32: picking loads the genome into the sliders');
ok(Array.isArray(p32.voiceLib) && p32.voiceLib.length === 1 && p32.voiceLib[0].name === 'Bella',
   'T32: library persisted in prefs');
const s32 = song();
ok(Array.isArray(s32.voices) && s32.voices.length === 1 && s32.voices[0].name === 'Bella',
   'T32: library rides in the song file');
// merging: a loaded song contributes voices it carries (existing names win)
global.SynthApp.loadSong({ v: 1, tempo: 120, recordings: [],
  voices: [{ name: 'Bella', gen: { count: 9 } }, { name: 'Imported', gen: { count: 2, sieve: 'odd' } }] });
const p32b = JSON.parse(global.localStorage.getItem('synth.quant.v1'));
ok(p32b.voiceLib.length === 2 && p32b.voiceLib[0].gen.count === 3 &&
   p32b.voiceLib[1].name === 'Imported' && p32b.voiceLib[1].gen.count === 2,
   'T32: song voices merge in without clobbering yours');
ok(ids.voiceSel.innerHTML.includes('Imported'), 'T32: merged voice selectable');
// delete respects confirm and falls back to the live lab voice
confirmResult = false;
ids.vlList.children[1].querySelectorAll('button')[1].onclick();
ok(JSON.parse(global.localStorage.getItem('synth.quant.v1')).voiceLib.length === 2, 'T32: delete cancelled keeps the voice');
confirmResult = true;
ids.vlList.children[0].querySelectorAll('button')[1].onclick(); // delete Bella (currently selected)
const p32c = JSON.parse(global.localStorage.getItem('synth.quant.v1'));
ok(p32c.voiceLib.length === 1 && p32c.voice === 'lab', 'T32: deleting the selected voice falls back to Lab');
ids.vlClose.onclick();
ok(ids.voiceLabPanel.hidden === true, 'T32: × closes the tab');
ids.voiceSel.value = 'sine'; ids.voiceSel.onchange();
instBtn.onclick(); instBtn.onclick();                           // hex → drums → synth

/* ── T33: genome v2 — breath / formant / damping / vibrato / chiff ── */
clearBtn.onclick();
instBtn.onclick();                                              // → hex
ids.labToggle.onclick();
ids.vlCount.value = '4'; ids.vlCount.oninput();
ids.vlSieve.value = 'all'; ids.vlSieve.onchange();
ids.vlWidth.value = '0'; ids.vlWidth.oninput();
ids.vlBreath.value = '30'; ids.vlBreath.oninput();              // 0.30 noise mix
ids.vlFormantA.value = '8'; ids.vlFormantA.oninput();           // body resonance on
ids.vlDamping.value = '50'; ids.vlDamping.oninput();            // spectral flux
ids.vlMotion.value = '8'; ids.vlMotion.oninput();               // vibrato → +1 LFO osc
ids.vlChiff.value = '40'; ids.vlChiff.oninput();                // attack transient
advance(3);
recordBtn.onclick();
let m33o = oscMade.length, m33b = bufMade;
advance(0.05); mouseDown(300, 400); advance(0.2); mouseUp();
recordBtn.onclick(); stopBtn.onclick();
ok(oscMade.length - m33o === 5, 'T33: 4 partials + 1 vibrato LFO (got ' + (oscMade.length - m33o) + ' oscs)');
ok(bufMade - m33b === 2, 'T33: breath + chiff noise sources (got ' + (bufMade - m33b) + ')');
const ev33 = song().recordings[0].events.find(e => e.type === 'start');
ok(Math.abs(ev33.gen.breath - 0.3) < 1e-9 && ev33.gen.formantA === 8 &&
   Math.abs(ev33.gen.damping - 0.5) < 1e-9 && ev33.gen.motion === 8 && Math.abs(ev33.gen.chiff - 0.4) < 1e-9,
   'T33: v2 genes stamped on the note');
const p33 = JSON.parse(global.localStorage.getItem('synth.quant.v1'));
ok(Math.abs(p33.labGen.breath - 0.3) < 1e-9 && p33.labGen.motion === 8, 'T33: v2 genes persisted');
// v1 genomes (no v2 fields) still play — and sound as before (no extra nodes)
m33o = oscMade.length; m33b = bufMade;
global.SynthApp.loadSong({ v: 1, tempo: 120, recordings: [
  { name: 'Old', events: [
    { type: 'start', id: 'n1', nx: .5, ny: .5, f: 261.6, name: 'C4', inst: 'lab', gen: { count: 3, sieve: 'all', tilt: 1, stretch: 0, width: 0, attack: 0, decay: 0, match: false }, beatPos: 0 },
    { type: 'end', id: 'n1', beatPos: 1 }] }] });
ids.scrubSlider.value = '0'; ids.scrubSlider.oninput({ target: ids.scrubSlider });
playBtn.onclick();
advance(0.8);
ok(oscMade.length - m33o === 3 && bufMade === m33b,
   'T33: v1 genome replays bit-identically (3 oscs, no v2 nodes; got ' + (oscMade.length - m33o) + '/' + (bufMade - m33b) + ')');
stopBtn.onclick();
ids.vlClose.onclick();
ids.voiceSel.value = 'sine'; ids.voiceSel.onchange();
instBtn.onclick(); instBtn.onclick();                           // hex → drums → synth

/* ── T34: built-in presets — rendered, in-range, loadable, playable ── */
clearBtn.onclick();
instBtn.onclick();                                              // → hex
ids.labToggle.onclick();
ok(ids.vlPresets.children.length === 18, 'T34: 18 presets rendered (got ' + ids.vlPresets.children.length + ')');
// every preset genome must already be within sanitize bounds (no silent clamping)
// — verified by playing EVERY preset and checking the stamped genome matches
recordBtn.onclick();
let allClean = true;
for (let i = 0; i < ids.vlPresets.children.length; i++) {
  ids.vlPresets.children[i].onclick();
  advance(0.4);
  mouseDown(300, 400); advance(0.05); mouseUp(); advance(0.05);
}
recordBtn.onclick(); stopBtn.onclick();
const ev34 = song().recordings[0].events.filter(e => e.type === 'start');
ok(ev34.length === 18 && ev34.every(e => e.inst === 'lab' && e.gen), 'T34: every preset plays and stamps a genome');
// every preset genome must sit inside sanitize bounds — no silent clamping on load
ok(ev34.every(e => { const g = e.gen;
  return g.count >= 1 && g.count <= 10 && g.stretch >= -.3 && g.stretch <= .5 &&
    g.tilt >= 0 && g.tilt <= 3 && ['all', 'odd', 'oct', '3rd'].includes(g.sieve) &&
    g.width >= 0 && g.width <= 25 && g.attack >= 0 && g.attack <= .3 &&
    g.decay >= 0 && g.decay <= 1.5 && g.breath >= 0 && g.breath <= .6 &&
    g.formantF >= 200 && g.formantF <= 4000 && g.formantA >= 0 && g.formantA <= 18 &&
    g.damping >= 0 && g.damping <= 1 && g.motion >= 0 && g.motion <= 20 &&
    g.chiff >= 0 && g.chiff <= .8;
}), 'T34: all preset genomes within sanitize bounds');
// spot-check: preset 1 (Gamelan) is matched + struck; preset 6 (Wooden Flute) breathes
ids.vlPresets.children[0].onclick(); advance(0.4);
let p34 = JSON.parse(global.localStorage.getItem('synth.quant.v1'));
ok(p34.labGen.match === true && p34.labGen.decay > 0, 'T34: Gamelan preset is matched + struck');
ids.vlPresets.children[5].onclick(); advance(0.4);
p34 = JSON.parse(global.localStorage.getItem('synth.quant.v1'));
ok(p34.labGen.breath > 0 && p34.labGen.formantA > 0, 'T34: Wooden Flute preset breathes through a body');
ok(String(ids.voiceSel.value) === 'lab', 'T34: loading a preset selects the Lab voice');
ids.vlClose.onclick();
ids.voiceSel.value = 'sine'; ids.voiceSel.onchange();
instBtn.onclick(); instBtn.onclick();                           // hex → drums → synth

/* ── T35: Play rolls the transport on an empty session (click track jam) ── */
clearBtn.onclick();
ids.metronomeBtn.onclick();                                     // arm the met (silent while idle)
ids.scrubSlider.value = '0'; ids.scrubSlider.oninput({ target: ids.scrubSlider });
const osc35 = oscCount;
playBtn.onclick();                                              // nothing recorded — transport rolls anyway
ok(playBtn.textContent === 'Playing', 'T35: Play starts with zero tracks');
advance(1.6);
ok(oscCount > osc35 + 1, 'T35: armed metronome ticks on the empty transport');
ok(+ids.scrubSlider.value > 2.5, 'T35: playhead rolls (at beat ' + (+ids.scrubSlider.value).toFixed(1) + ')');
recordBtn.onclick();                                            // arm a take against the rolling click
ok(playBtn.textContent === 'Playing' && recordBtn.textContent === 'Rec*', 'T35: recording joins the rolling grid');
advance(0.05); mouseDown(300, 300); advance(0.1); mouseUp();
const ev35 = song().recordings[0].events.find(e => e.type === 'start');
ok(ev35.beatPos > 3, 'T35: note lands at the transport position, not beat 0 (beat ' + ev35.beatPos.toFixed(1) + ')');
recordBtn.onclick(); stopBtn.onclick();
const osc35b = oscCount;
advance(3);
ok(oscCount === osc35b, 'T35: stop silences the click again');
ids.metronomeBtn.onclick();                                     // met off

/* ── T36: audition strip — pitched taps, drag retrigger, never records ── */
clearBtn.onclick();
ids.labToggle.onclick();
const padFire = (ev, y) => (ids.vlPad._listeners[ev] || []).slice().forEach(f =>
  f({ clientY: y, pointerId: 9, preventDefault() {} }));
recordBtn.onclick();                                            // even while RECORDING, the strip must not record
let m36 = oscMade.length;
padFire('pointerdown', 450);                                    // ny=0.25 → step 9 of 12-EDO over 3 octaves
const f36a = oscMade[m36] ? oscMade[m36].frequency.value : 0;   // first osc of the voice = fundamental
ok(oscMade.length > m36, 'T36: strip tap voices the lab genome');
ok(String(ids.vlPadNote.textContent) !== '♪', 'T36: note label updates (' + ids.vlPadNote.textContent + ')');
const n36 = oscMade.length;
padFire('pointermove', 150);                                    // drag up → ny=0.75 → step 27 → retrigger
ok(oscMade.length > n36, 'T36: drag retriggers at the new pitch');
const dSteps = 12 * Math.log2(oscMade[n36].frequency.value / f36a);
ok(Math.abs(dSteps - 18) < .01, 'T36: pitch follows the strip exactly (Δ ' + dSteps.toFixed(2) + ' steps, want 18)');
padFire('pointerup', 150);
advance(0.2);
recordBtn.onclick(); stopBtn.onclick();
ok(song().recordings.length === 0, 'T36: audition taps never reach the recorder');
ids.vlClose.onclick();

/* ── T37: 🎲 randomize — always in-bounds, varied, match preserved ── */
ids.labToggle.onclick();
ids.vlMatch.classList.contains('on') || ids.vlMatch.onclick();  // force match ON to check preservation
advance(2);
const genOK = (g) => g.count >= 1 && g.count <= 10 && g.stretch >= -.3 && g.stretch <= .5 &&
  g.tilt >= 0 && g.tilt <= 3 && ['all', 'odd', 'oct', '3rd'].includes(g.sieve) &&
  g.width >= 0 && g.width <= 25 && g.attack >= 0 && g.attack <= .3 &&
  g.decay >= 0 && g.decay <= 1.5 && g.breath >= 0 && g.breath <= .6 &&
  g.formantF >= 200 && g.formantF <= 4000 && g.formantA >= 0 && g.formantA <= 18 &&
  g.damping >= 0 && g.damping <= 1 && g.motion >= 0 && g.motion <= 20 && g.chiff >= 0 && g.chiff <= .8;
const seen37 = new Set();
let allOk37 = true, matchKept = true;
for (let i = 0; i < 30; i++) {
  ids.vlRandom.onclick();
  advance(2.5);                                                 // drain each preview
  const g = JSON.parse(global.localStorage.getItem('synth.quant.v1')).labGen;
  if (!genOK(g)) allOk37 = false;
  if (g.match !== true) matchKept = false;
  seen37.add(JSON.stringify(g));
}
ok(allOk37, 'T37: 30 random genomes all within sanitize bounds');
ok(matchKept, 'T37: randomize preserves the match setting');
ok(seen37.size >= 25, 'T37: randomize actually varies (' + seen37.size + '/30 distinct)');
ok(String(ids.voiceSel.value) === 'lab', 'T37: random genome selected as the playing voice');
ids.vlMatch.onclick();                                          // match back off
ids.vlClose.onclick();

/* ── T38: strip bottom note + gliss slide stays bounded ── */
ids.labToggle.onclick();
ids.vlPresets.children[0].onclick();                            // Gamelan: long-ring struck voice
advance(3);
ids.vlPadOct.value = '1'; ids.vlPadOct.onchange();              // strip bottom = C1
const n38 = oscMade.length;
padFire('pointerdown', 600);                                    // very bottom → step 0
const f38 = oscMade[n38].frequency.value;                       // first osc of the voice = fundamental
ok(Math.abs(f38 - 130.81 / 4) < .1, 'T38: strip bottom is C1 (' + f38.toFixed(1) + 'Hz)');
for (let y = 590; y >= 10; y -= 20) padFire('pointermove', y);  // fast full sweep — 30 gliss handoffs
padFire('pointerup', 10);
advance(2);
ok(true, 'T38: fast gliss sweep survives (quick-damped handoffs)');
const p38 = JSON.parse(global.localStorage.getItem('synth.quant.v1'));
ok(p38.padOct === 1, 'T38: strip bottom note persisted');
ids.vlPadOct.value = '2'; ids.vlPadOct.onchange();
ids.vlClose.onclick();

/* ── T39: strike decomposition — pitch-tracked exciter through the voice chain ── */
clearBtn.onclick();
instBtn.onclick();                                              // → hex
ids.labToggle.onclick();
ids.vlPresets.children[1].onclick(); advance(3);                // start from a clean preset
ids.vlChiff.value = '40'; ids.vlChiff.oninput();
ids.vlStrikeF.value = '3'; ids.vlStrikeF.oninput();             // mallet-ish ×3 color
ids.vlStrikeT.value = '45'; ids.vlStrikeT.oninput();            // 45ms thump
advance(3);
let m39 = filtMade.length;
recordBtn.onclick();
advance(0.05); mouseDown(300, 400); advance(0.1); mouseUp();
recordBtn.onclick(); stopBtn.onclick();
const ev39 = song().recordings[0].events.find(e => e.type === 'start');
ok(Math.abs(ev39.gen.strikeF - 3) < 1e-9 && Math.abs(ev39.gen.strikeT - .045) < 1e-9,
   'T39: strike color + time stamped on the note');
ok(filtMade.slice(m39).some(fl => Math.abs(fl.frequency.value - ev39.f * 3) < .5),
   'T39: exciter bandpass tracks the pitch (looked for ' + (ev39.f * 3).toFixed(0) + 'Hz)');
// genomes without strike fields get the new exciter at the default ×8 color
m39 = filtMade.length;
global.SynthApp.loadSong({ v: 1, tempo: 120, recordings: [
  { name: 'Old', events: [
    { type: 'start', id: 'n1', nx: .5, ny: .5, f: 261.6, name: 'C4', inst: 'lab',
      gen: { count: 2, sieve: 'all', tilt: 1, stretch: 0, width: 0, attack: 0, decay: .3, chiff: .4, match: false }, beatPos: 0 },
    { type: 'end', id: 'n1', beatPos: 1 }] }] });
ids.scrubSlider.value = '0'; ids.scrubSlider.oninput({ target: ids.scrubSlider });
playBtn.onclick();
advance(0.8);
ok(filtMade.slice(m39).some(fl => Math.abs(fl.frequency.value - 261.6 * 8) < .5),
   'T39: strike-less genomes fall back to the ×8 default color');
stopBtn.onclick();
ids.vlClose.onclick();
instBtn.onclick(); instBtn.onclick();                           // hex → drums → synth

/* ── T40: tap-spamming a long-decay voice releases every voice cleanly ── */
ids.labToggle.onclick();
ids.vlPresets.children[1].onclick(); advance(3);                // Singing Bowl: 1.5s held decay
let threw40 = false;
try {
  for (let i = 0; i < 15; i++) {                                // rapid tap up/down the strip
    padFire('pointerdown', 100 + (i % 5) * 100);
    advance(0.04);
    padFire('pointerup', 100 + (i % 5) * 100);
    advance(0.03);
  }
} catch (e) { threw40 = true; }
advance(4);                                                     // drain all the ring-outs
ok(!threw40, 'T40: tap spam on a decaying voice survives');
const m40 = oscMade.length;
padFire('pointerdown', 300); padFire('pointerup', 300);         // strip still healthy afterwards
ok(oscMade.length > m40, 'T40: strip still voices after the spam');
advance(3);
ids.vlClose.onclick();

/* ── T41: oscillators outlive the release curve — no premature hard stop ── */
ids.labToggle.onclick();
ids.vlPresets.children[3].onclick(); advance(3);                // Kalimba base
ids.vlDecay.value = '25'; ids.vlDecay.oninput();                // decay .25 → rel .25 → needs ~1.65s tail
advance(3);
const m41 = oscMade.length;
padFire('pointerdown', 300);
padFire('pointerup', 300);                                      // release at ~full amplitude
advance(0.5);                                                   // old fixed 300ms tail would have stopped here
const voice41 = oscMade.slice(m41);
ok(voice41.length > 0 && voice41.every(o => !o.stopped),
   'T41: mid-decay voice still ringing at +0.5s (old 300ms tail cut it at ~30% amplitude)');
advance(2.0);
ok(voice41.every(o => o.stopped), 'T41: and fully stopped once the release has died away');
ids.vlClose.onclick();

console.log('synth tests: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
