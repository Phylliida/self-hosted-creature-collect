// Tests the "pick a Pokémon as the tracing reference" picker added to
// static/pixelart/app.js. The picker reaches the host frame's Species +
// Sprites, renders the chosen sprite to a PNG data URL, and feeds it to
// setReference. We extract the picker block and run it in a vm with a tiny
// hand-rolled DOM/host stub (no jsdom), mirroring the repo's other tests.
//
// Run: node tests/pixelart-poke-reference.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'pixelart', 'app.js'), 'utf8');
const START = '// ── Pick a Pokémon as the tracing reference ──';
const END = '  // ── Resize ──';
const s = src.indexOf(START), e = src.indexOf(END);
if (s < 0 || e < 0) { console.error('FAIL: could not locate picker block'); process.exit(1); }
const block = src.slice(s, e);

// ── DOM / host stubs ─────────────────────────────────────────────────────
function makeEl() {
  const el = {
    value: '', checked: false, disabled: false, hidden: false, textContent: '',
    _html: '', src: '', onclick: null, listeners: {},
    style: {}, classes: new Set(),
    childNodes: [{ nodeValue: 'Pokémon' }],
    classList: { add: (c) => el.classes.add(c), remove: (c) => el.classes.delete(c),
      toggle: (c, on) => (on ? el.classes.add(c) : el.classes.delete(c)), contains: (c) => el.classes.has(c) },
    addEventListener: (t, fn) => { (el.listeners[t] || (el.listeners[t] = [])).push(fn); },
    appendChild: (c) => {
      const list = (el.children || (el.children = []));
      if (c && c.__frag) { c.children.forEach((x) => list.push(x)); } else { list.push(c); }
      return c;
    },
    removeAttribute: () => { el.src = ''; },
    focus: () => {}, select: () => {},
    dispatch: (t, ev) => { (el.listeners[t] || []).forEach((fn) => fn(ev || {})); },
  };
  Object.defineProperty(el, 'innerHTML', { get: () => el._html, set: (v) => { el._html = v; } });
  return el;
}
const els = {};
['refPickPoke', 'pokeDialog', 'pokeHead', 'pokeBody', 'pokeHeadLbl', 'pokeBodyLbl',
 'pokeFusion', 'pokePreview', 'pokePreviewMsg', 'pokeNames', 'pokeUse', 'pokeCancel']
  .forEach((id) => { els[id] = makeEl(); });
const $ = (id) => els[id] || null;

const doc = {
  createElement: (tag) => {
    if (tag === 'canvas') {
      return { width: 0, height: 0,
        getContext: () => ({ imageSmoothingEnabled: true, drawImage: () => {} }),
        toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANS' };
    }
    if (tag === 'option') return { value: '' };
    return makeEl();
  },
  createDocumentFragment: () => ({ __frag: true, children: [], appendChild(c) { this.children.push(c); } }),
};
function ImageStub() {
  this.onload = null; this.onerror = null; this.naturalWidth = 40; this.naturalHeight = 30;
  let _src = '';
  Object.defineProperty(this, 'src', { get: () => _src, set: (v) => { _src = v; setTimeout(() => { if (this.onload) this.onload(); }, 0); } });
}
const URLStub = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} };

// Host frame the picker reaches for Species + Sprites.
const NAMES = ['bulbasaur', 'ivysaur', 'venusaur', 'charmander', 'pikachu'];
let blobRequests = [];
function makeHost() {
  return {
    Species: {
      ensureLoaded: async () => {},
      allSpecies: () => NAMES.map((n, i) => ({ id: i + 1, name: n[0].toUpperCase() + n.slice(1) })),
    },
    Sprites: {
      getDefaultSpriteBlob: async (a, b) => { blobRequests.push([a, b]); return { size: 10 }; },
    },
  };
}

const setRefCalls = [];
const setReference = (url, persist) => setRefCalls.push({ url, persist });
const closeMenus = () => {};

const windowStub = {};   // host = window (self) case is exercised by attaching Species/Sprites
const factory = new Function(
  '$', 'window', 'document', 'setReference', 'closeMenus', 'setTimeout', 'clearTimeout', 'URL', 'Image', 'console',
  block + '\n return { resolvePokeId, pokeHost, updatePokePreview, ensurePokeNames, wirePokePicker, openPokeDialog };');

const P = factory($, windowStub, doc, setReference, closeMenus, setTimeout, clearTimeout, URLStub, ImageStub, console);

(async () => {
  // ── pokeHost: none present → null; present on window → window ──
  ok(P.pokeHost() === null, 'pokeHost null when no Species/Sprites anywhere');
  Object.assign(windowStub, makeHost());
  ok(P.pokeHost() === windowStub, 'pokeHost returns window when it carries Species+Sprites');

  // ── ensurePokeNames populates the name→id map + datalist ──
  await P.ensurePokeNames();
  ok((els.pokeNames.children || []).length === NAMES.length, 'datalist got one <option> per species');
  ok(P.resolvePokeId('Bulbasaur') === 1, 'name resolves case-insensitively → id 1');
  ok(P.resolvePokeId('pikachu') === 5, 'lowercase name resolves → id 5');
  ok(P.resolvePokeId('#4') === 4, '#4 resolves to dex 4');
  ok(P.resolvePokeId('3') === 3, 'bare number resolves to dex 3');
  ok(P.resolvePokeId('notapoke') === null, 'unknown name → null');
  ok(P.resolvePokeId('') === null, 'empty → null');

  // ── updatePokePreview: pure species (fusion off) ──
  blobRequests = [];
  els.pokeFusion.checked = false;
  els.pokeHead.value = 'Charmander';   // id 4
  await P.updatePokePreview();
  ok(blobRequests.length === 1 && blobRequests[0][0] === 4 && blobRequests[0][1] === 4,
    'pure species requests getDefaultSpriteBlob(4, 4)');
  ok(els.pokeUse.disabled === false, 'Use button enabled after a good preview');
  ok(/^data:image\/png/.test(els.pokePreview.src), 'preview img shows a PNG data URL');
  ok(els.pokePreview.hidden === false, 'preview img is visible');

  // ── updatePokePreview: fusion (head + body) ──
  blobRequests = [];
  els.pokeFusion.checked = true;
  els.pokeHead.value = 'Pikachu';   // 5
  els.pokeBody.value = 'Ivysaur';   // 2
  await P.updatePokePreview();
  ok(blobRequests.length === 1 && blobRequests[0][0] === 5 && blobRequests[0][1] === 2,
    'fusion requests getDefaultSpriteBlob(head=5, body=2)');
  ok(els.pokeUse.disabled === false, 'Use enabled for a valid fusion');

  // ── fusion on but body blank → no request, Use stays disabled ──
  blobRequests = [];
  els.pokeBody.value = '';
  await P.updatePokePreview();
  ok(blobRequests.length === 0, 'incomplete fusion makes no sprite request');
  ok(els.pokeUse.disabled === true, 'Use disabled when body is missing');

  // ── clicking "Use as reference" hands the data URL to setReference ──
  els.pokeFusion.checked = false;
  els.pokeHead.value = 'Venusaur';
  await P.updatePokePreview();
  P.wirePokePicker();               // wires pokeUse.onclick etc.
  ok(els.refPickPoke.hidden === false, 'picker button revealed when a host is present');
  els.pokeUse.onclick();
  ok(setRefCalls.length === 1, 'Use as reference calls setReference once');
  ok(/^data:image\/png/.test(setRefCalls[0].url), 'setReference got a PNG data URL');
  ok(setRefCalls[0].persist === true, 'reference is persisted (persist=true)');

  // ── no sprite available → message, Use disabled, no setReference ──
  windowStub.Sprites.getDefaultSpriteBlob = async () => null;
  els.pokeHead.value = 'Charmander';
  await P.updatePokePreview();
  ok(els.pokeUse.disabled === true, 'Use disabled when no sprite blob comes back');
  ok(/No sprite/.test(els.pokePreviewMsg.textContent), 'shows a "no sprite" message');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
