// Regression test: the radar "autogen" label gate.
//
// Settings → "Show autogen labels on radar" drops a small "autogen" pill on
// a radar blip ONLY when (a) the toggle is on AND (b) the fusion has zero
// custom art variants — mirroring the pokedex autogen badge, which treats a
// 0 (or failed → 0) variant count as autogen. This pins that decision so a
// future edit can't silently invert it or leak the label when the setting
// is off.
//
// Run: node tests/radar-autogen-label.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

// comment-aware brace extractor (same approach as radar-tag.test.js)
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

const ctx = {};
vm.createContext(ctx);
vm.runInContext(extract('function _radarShouldLabelAutogen'), ctx);
const shouldLabel = vm.runInContext('_radarShouldLabelAutogen', ctx);

// ── A. Setting OFF → never label, whatever the count ──
ok(shouldLabel(false, 0) === false, 'A: off + autogen count → no label');
ok(shouldLabel(false, 3) === false, 'A: off + custom count → no label');

// ── B. Setting ON → label iff count is exactly 0 (autogen-only fusion) ──
ok(shouldLabel(true, 0) === true, 'B: on + zero variants → label');
ok(shouldLabel(true, 1) === false, 'B: on + one custom variant → no label');
ok(shouldLabel(true, 7) === false, 'B: on + many custom variants → no label');

// ── C. Only the literal `true` counts as "on" (guards against a truthy
//        non-boolean, e.g. a stray '1' string, sneaking the label in) ──
ok(shouldLabel('1', 0) === false, 'C: truthy non-boolean is not treated as on');
ok(shouldLabel(1, 0) === false, 'C: numeric 1 is not treated as on');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
