// Regression test: the `_themeIsDark` luminance classifier.
//
// applyTheme() (and the early flash-prevention script) tag <html> with
// data-ui-dark="1" for dark themes, computed from the perceived luminance of
// the theme's panel background. That flag drives two night-mode readability
// fixes that can't read the --ui-* vars directly:
//   - radar silhouette blips get a white outline (CSS in creatures.js), and
//   - unselected pin-icon-menu icons get inverted to white (renderFavIconGrid).
// This pins the classifier so a future edit can't silently flip a dark theme
// to "light" (which would re-break both fixes) or vice-versa.
//
// Run: node tests/theme-is-dark.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

// comment-aware brace extractor (same approach as radar-autogen-label.test.js)
const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf8');
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

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(extract('window._themeIsDark = function'), ctx);
const isDark = ctx.window._themeIsDark;
ok(typeof isDark === 'function', 'extracted _themeIsDark is a function');

// ── A. Real themes from THEMES{} classify correctly (panelBg drives it) ──
ok(isDark({ ui: { panelBg: '#2a2a30' } }) === true,  'A: dark theme (#2a2a30) → dark');
ok(isDark({ ui: { panelBg: '#0d1524' } }) === true,  'A: night theme (#0d1524) → dark');
ok(isDark({ ui: { panelBg: '#3a3a38' } }) === true,  'A: garage theme (#3a3a38) → dark');
ok(isDark({ ui: { panelBg: '#ffffff' } }) === false, 'A: default (#ffffff) → light');
ok(isDark({ ui: { panelBg: '#f0e3bf' } }) === false, 'A: sepia (#f0e3bf) → light');

// ── B. Falls back to top-level bg when no ui palette (e.g. custom map bg) ──
ok(isDark({ bg: '#05070f' }) === true,  'B: bg-only near-black → dark');
ok(isDark({ bg: '#f5f5dc' }) === false, 'B: bg-only beige → light');

// ── C. 3-digit hex shorthand is expanded before parsing ──
ok(isDark({ ui: { panelBg: '#000' } }) === true,  'C: #000 → dark');
ok(isDark({ ui: { panelBg: '#fff' } }) === false, 'C: #fff → light');

// ── D. Robust to junk / missing input → defaults to light (no crash) ──
ok(isDark(null) === false, 'D: null → light (no throw)');
ok(isDark({}) === false, 'D: empty object → light (uses #ffffff default)');
ok(isDark({ ui: { panelBg: 'not-a-color' } }) === false, 'D: unparseable → light (NaN < 0.5 is false)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
