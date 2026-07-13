// Smoke-tests the generic info-modal view-stack control flow in
// static/creatures.js (_openInfoModal / _pushInfoView / _infoModalBack /
// _closeInfoModal / _renderInfoModalTop). This is the one piece of the
// incense-info work with no daycare-modal precedent — a small internal
// view stack so a popup can drill into a sub-view and ← pops back (or
// closes at the root). Runs against a tiny hand-rolled DOM stub (no jsdom).
//
// Run: node tests/info-modal.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'creatures.js'), 'utf8');
function extract(marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++) { if (src[i] === '\\') i++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

// ── Minimal DOM stub — enough surface for the modal helpers. querySelector
// returns a stable per-selector fake so `.cc-modal-title`.textContent etc.
// persist across renders; querySelectorAll returns stable fake button lists.
function makeEl(tag) {
  const el = {
    tagName: tag, id: '', scrollTop: 0,
    classes: new Set(), children: [], listeners: {},
    _html: '', _text: '', _sel: {}, _selAll: {}, _updateFloat: null,
    classList: {
      add: (c) => el.classes.add(c), remove: (c) => el.classes.delete(c),
      toggle: (c, on) => { if (on) el.classes.add(c); else el.classes.delete(c); },
      contains: (c) => el.classes.has(c),
    },
    addEventListener: (t, fn) => { (el.listeners[t] || (el.listeners[t] = [])).push(fn); },
    appendChild: (c) => { el.children.push(c); return c; },
    querySelector: (s) => (el._sel[s] || (el._sel[s] = makeEl('div'))),
    querySelectorAll: (s) => (el._selAll[s] || (el._selAll[s] = [makeEl('button'), makeEl('button')])),
  };
  Object.defineProperty(el, 'innerHTML', { get: () => el._html, set: (v) => { el._html = v; } });
  Object.defineProperty(el, 'textContent', { get: () => el._text, set: (v) => { el._text = v; } });
  return el;
}
const documentStub = { createElement: (t) => makeEl(t), body: makeEl('body') };

const ctx = {
  Object, Array, document: documentStub,
  _infoModalEl: null, _infoModalStack: [],
};
vm.createContext(ctx);
for (const m of [
  'function _ensureInfoModalEl(',
  'function _renderInfoModalTop(',
  'function _openInfoModal(',
  'function _pushInfoView(',
  'function _infoModalBack(',
  'function _closeInfoModal(',
]) vm.runInContext(extract(m), ctx);

const run = (expr, extra) => vm.runInContext(expr, Object.assign(ctx, extra || {}));
const stackLen = () => run('_infoModalStack.length');
const shown = () => run('_infoModalEl && _infoModalEl.classList.contains("show")');
const titleText = () => run('_infoModalEl.querySelector(".cc-modal-title").textContent');

// Two views; the second (pushed) records the args its onWire receives.
let wiredArgs = null;
ctx.__viewA = { title: 'Root view', html: '<p>root</p>' };
ctx.__viewB = { title: 'Sub view', html: () => '<p>sub</p>',
  onWire: function (root, content) { wiredArgs = { root: !!root, content: !!content }; } };

// ── 1. Open at the root ──
run('_openInfoModal(__viewA)');
ok(stackLen() === 1, '1: opening seeds a one-entry stack');
ok(shown() === true, '1: modal gets the .show class');
ok(titleText() === 'Root view', '1: root title rendered');

// ── 2. Push a sub-view ──
run('_pushInfoView(__viewB)');
ok(stackLen() === 2, '2: pushing grows the stack');
ok(titleText() === 'Sub view', '2: sub-view title rendered on top');
ok(wiredArgs && wiredArgs.root && wiredArgs.content, '2: onWire got (root, content)');
ok(run('typeof __viewB.html') === 'function', '2: html-as-function view is supported');

// ── 3. Back pops to the root (does NOT close) ──
run('_infoModalBack()');
ok(stackLen() === 1, '3: back from a sub-view pops one level');
ok(shown() === true, '3: still open after popping to root');
ok(titleText() === 'Root view', '3: root title restored');

// ── 4. Back at the root closes ──
run('_infoModalBack()');
ok(shown() === false, '4: back at the root closes the modal');
ok(stackLen() === 0, '4: closing clears the stack');

// ── 5. Reopen reuses the singleton element, fresh stack ──
run('_openInfoModal(__viewA)');
ok(stackLen() === 1 && shown() === true, '5: reopen works after close');
run('_closeInfoModal()');
ok(shown() === false && stackLen() === 0, '5: explicit close clears show + stack');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
