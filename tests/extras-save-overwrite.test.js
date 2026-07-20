// Tests the Save / Save New split added to the Extras mini-app window factory
// (makeAppWindow in static/extras-apps.js), used by Pixel Art, Draw, Synth and
// Quiver. The contract:
//   - "Save New" always creates a fresh named record and adopts it as current.
//   - "Save" overwrites the current record in place (same id) — no prompt.
//   - "Save" with nothing loaded yet opens the name overlay (acts like Save New).
//   - Loading a record from the browse list makes it current.
//   - "New" clears the current record so a blank canvas can't clobber a save.
//
// We load the whole IIFE in a vm with a selector-keyed DOM stub and an
// in-memory fake IndexedDB, then drive the real button handlers — mirroring the
// repo's other DOM-free harness tests (see pixelart-poke-reference.test.js).
//
// Run: node tests/extras-save-overwrite.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }
const tick = () => new Promise((r) => setTimeout(r, 5));

// ── Minimal in-memory IndexedDB matching idbPut/idbAll/idbGet/idbDel usage ──
function fakeIndexedDB() {
  const stores = {};
  const ensure = (n) => stores[n] || (stores[n] = new Map());
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => {},
    transaction(name) {
      const map = ensure(name);
      const tx = { oncomplete: null, onerror: null };
      const done = () => setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
      tx.objectStore = () => ({
        put(rec) { map.set(rec.id, JSON.parse(JSON.stringify(rec))); done(); },
        delete(id) { map.delete(id); done(); },
        getAll() { const rq = {}; setTimeout(() => { rq.result = [...map.values()]; if (rq.onsuccess) rq.onsuccess(); }, 0); return rq; },
        get(id) { const rq = {}; setTimeout(() => { rq.result = map.get(id); if (rq.onsuccess) rq.onsuccess(); }, 0); return rq; },
      });
      return tx;
    },
  };
  return {
    _stores: stores,
    open() {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: db };
      setTimeout(() => { if (req.onupgradeneeded) req.onupgradeneeded(); if (req.onsuccess) req.onsuccess(); }, 0);
      return req;
    },
  };
}

// ── Generic DOM element stub with a caching querySelector ──
function makeStub() {
  const s = {
    value: '', textContent: '', innerHTML: '', src: '', className: '', id: '', tagName: '',
    onclick: null, dataset: {}, contentWindow: null, listeners: {}, _sel: {},
    focus() {}, select() {}, appendChild(c) { return c; }, removeAttribute() { s.src = ''; },
    addEventListener(t, fn) { (s.listeners[t] || (s.listeners[t] = [])).push(fn); },
    dispatch(t, ev) { (s.listeners[t] || []).forEach((fn) => fn(ev)); },
    querySelector(sel) { return s._sel[sel] || (s._sel[sel] = makeStub()); },
    querySelectorAll() { return []; },
    get offsetWidth() { return 0; },
  };
  const set = new Set();
  s.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c),
    contains: (c) => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
  return s;
}

// ── Build the sandbox, load extras-apps.js, register + open the Pixel Art app ──
function boot() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'extras-apps.js'), 'utf8');
  const state = { cells: ['v1'] };   // the "working doc"; we mutate it between saves
  const pixelApp = {
    getDrawing: () => ({ w: 4, h: 4, cells: state.cells.slice(), layers: [], active: 0 }),
    thumbnail: () => 'data:thumb',
    loadDrawing: () => {},
    promptNew: () => {}, undo: () => {}, redo: () => {},
  };
  let win = null;
  const document = {
    getElementById: () => null,
    head: { appendChild() {} },
    body: { appendChild: (el) => { if (el.tagName === 'div') win = el; } },
    createElement: (tag) => { const el = makeStub(); el.tagName = tag; return el; },
    addEventListener() {},
  };
  const tools = {};
  const sandbox = {
    document, indexedDB: fakeIndexedDB(), console,
    setTimeout, clearTimeout, JSON, Math, Date, Promise, Set, Map,
    Array, Object, String, Number, ExtrasRegisterTool: (t) => { tools[t.id] = t; },
    addEventListener() {},
  };
  sandbox.window = sandbox; sandbox.self = sandbox;
  vm.runInNewContext(src, sandbox);
  ok(!!tools.pixelart, 'Pixel Art tool registered');
  tools.pixelart.open();
  ok(!!win, 'app window built on open()');
  // The iframe's frame stub — give it the PixelApp bridge capture() reads.
  win.querySelector('.exapp-frame').contentWindow = { PixelApp: pixelApp };
  return { win, state, store: sandbox.ExtrasPixelArt };
}

(async () => {
  const { win, state, store } = boot();
  const nameInput = win.querySelector('.exapp-name');
  const saveOverlay = win.querySelector('.exapp-save-overlay');
  const saveBtn = win.querySelector('.exapp-save');
  const saveNewBtn = win.querySelector('.exapp-savenew');
  const saveOk = win.querySelector('.exapp-save-ok');
  const listEl = win.querySelector('.exapp-list');
  const newBtn = win.querySelector('[data-act="lead-0"]');   // the "New" lead action

  ok(typeof saveBtn.onclick === 'function', 'Save button wired');
  ok(typeof saveNewBtn.onclick === 'function', 'Save New button wired');

  // 1) Save New "Dog" (data v1) → one record, adopted as current.
  saveNewBtn.onclick();
  ok(saveOverlay.classList.contains('show'), 'Save New opened the name overlay');
  nameInput.value = 'Dog';
  await saveOk.onclick(); await tick();
  let all = await store.all();
  ok(all.length === 1, 'Save New created one record (got ' + all.length + ')');
  ok(all[0] && all[0].name === 'Dog', 'record named Dog');
  ok(all[0] && all[0].data.cells[0] === 'v1', 'record holds v1 data');
  const dogId = all[0] && all[0].id;

  // 2) Save (overwrite current) with new data v2 → still one record, same id.
  state.cells = ['v2'];
  saveBtn.onclick(); await tick(); await tick();
  all = await store.all();
  ok(all.length === 1, 'Save overwrote in place — still one record (got ' + all.length + ')');
  ok(all[0].id === dogId, 'overwrite kept the same id');
  ok(all[0].data.cells[0] === 'v2', 'overwrite refreshed the data to v2');
  ok(typeof all[0].updatedAt === 'number', 'overwrite stamped updatedAt');

  // 3) Save New "Cat" → a second, distinct record. Current becomes Cat.
  state.cells = ['cat'];
  saveNewBtn.onclick(); nameInput.value = 'Cat';
  await saveOk.onclick(); await tick();
  all = await store.all();
  ok(all.length === 2, 'Save New added a second record (got ' + all.length + ')');

  // 4) Load "Dog" from the browse list → current becomes Dog again; a later Save
  //    overwrites Dog, not Cat.
  listEl.dispatch('click', { target: { closest: (sel) => (sel === '[data-load]' ? { dataset: { load: dogId } } : null) } });
  await tick();
  state.cells = ['v3'];
  saveBtn.onclick(); await tick(); await tick();
  all = await store.all();
  ok(all.length === 2, 'still two records after loading + overwriting Dog');
  const dog = all.find((r) => r.id === dogId);
  const cat = all.find((r) => r.name === 'Cat');
  ok(dog && dog.data.cells[0] === 'v3', 'loaded record (Dog) overwritten to v3');
  ok(cat && cat.data.cells[0] === 'cat', 'unrelated record (Cat) untouched');

  // 5) "New" clears the current record → Save now opens the overlay instead of
  //    silently overwriting the loaded drawing.
  newBtn.onclick();
  const beforeShow = saveOverlayShown(win);
  state.cells = ['blank'];
  saveBtn.onclick(); await tick();
  all = await store.all();
  ok(all.length === 2, 'Save after New did not create/overwrite a record (got ' + all.length + ')');
  ok(!beforeShow && saveOverlayShown(win), 'Save after New opened the name overlay');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

// The overlay's shown state lives in its classList; expose it via a probe that
// re-reads contains('show') (our stub keeps the Set private).
function saveOverlayShown(win) {
  return win.querySelector('.exapp-save-overlay').classList.contains('show');
}
