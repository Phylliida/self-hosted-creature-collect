// Tests the guaranteed-catch (accessibility) explainer copy in
// static/creatures.js:
//   _steadyCatchInfoHtml  (the "Guaranteed catch" popup body)
//
// The popup opens from the Settings "i" bubble via
// Creatures.showSteadyCatchInfo(); this checks the copy actually explains
// the mechanic + why it stays balanced (same balls, same odds, ~10% slower,
// breaks free when the bag runs out).
//
// Run: node tests/steady-catch-info.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

// comment-aware brace extractor (same approach as tests/incense-info.test.js)
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

const ctx = { Object, Array, String };
vm.createContext(ctx);
vm.runInContext(extract('function _steadyCatchInfoHtml('), ctx);
const call = (expr) => vm.runInContext(expr, ctx);

// ── 1. Only one exported entry point is used; verify wiring exists ──
ok(src.indexOf('showSteadyCatchInfo: _showSteadyCatchInfo') >= 0,
  '1: Creatures.showSteadyCatchInfo is exposed on the module surface');
ok(src.indexOf('function _showSteadyCatchInfo(') >= 0,
  '1: _showSteadyCatchInfo opener exists');

// ── 2. Explainer copy covers the mechanic ──
{
  const h = call('_steadyCatchInfoHtml()');
  ok(/accessibility/i.test(h), '2: framed as an accessibility option');
  ok(/real ball/i.test(h), '2: says each hidden re-throw spends a real ball');
  ok(/10% longer/i.test(h), '2: mentions the ~10% longer pacing (no speed advantage)');
  ok(/same odds|catch rate is unchanged/i.test(h), '2: makes clear the odds are unchanged');
  ok(/breaks free/i.test(h), '2: covers the bag-empty → breaks free case');
  ok(/less tapping|repeated tapping/i.test(h), '2: names the actual benefit (less tapping)');
}

// ── 3. Uses the shared info-modal content classes (renders in the popup) ──
{
  const h = call('_steadyCatchInfoHtml()');
  ok(h.indexOf('cc-info-section') >= 0, '3: uses cc-info-section blocks');
  ok(h.indexOf('cc-info-row') >= 0, '3: uses cc-info-row rows');
  ok((h.match(/cc-info-section-title/g) || []).length === 2,
    '3: two sections — "what happens" and "why it\'s balanced"');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
