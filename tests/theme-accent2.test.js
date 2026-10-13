// Every theme's second accent (ui.accent2 → --ui-accent2), used for the
// species dex's all-art ring/dot next to the --ui-accent ✓ badge
// (static/creatures.js). The fixed gold ring clashed with blue accents
// (dark mode) and vanished on gold ones (amber, atari, rct…), so each
// theme picks its own. Checks:
//   1. every theme has a valid accent2 that isn't its accent,
//   2. that stands out from the panel (the ring sits on it, separated
//      from the badge by a 1px panel-color gap),
//   3. it reaches the page: :root default, the early-boot script and
//      applyTheme set --ui-accent2, and the creatures.js marks use it
//      (one hollow ring rule for the ✓ ring and the not-owned mark).
//
// Run: node tests/theme-accent2.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
const creatures = fs.readFileSync(path.join(root, 'static', 'creatures.js'), 'utf8');

// Comment- and string-aware brace match (same as theme-is-dark.test.js):
// the THEMES block has comments with apostrophes in them.
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
  return src.slice(src.indexOf('{', start), i + 1);
}
const THEMES = vm.runInNewContext('(' + extract('window.THEMES = {') + ')');

const rgb = (h) => {
  h = String(h || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  return /^[0-9a-f]{6}$/i.test(h) ? [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16)) : null;
};
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const names = Object.keys(THEMES);
ok(names.length >= 40, `parsed the themes (${names.length})`);
for (const n of names) {
  const ui = THEMES[n].ui || {};
  const a2 = rgb(ui.accent2), acc = rgb(ui.accent), bg = rgb(ui.panelBg);
  ok(!!a2, `${n}: has a hex accent2 (${ui.accent2})`);
  if (!a2 || !acc || !bg) continue;
  ok(a2.join() !== acc.join(), `${n}: accent2 differs from accent`);
  const c = contrast(a2, bg);
  ok(c >= 1.8, `${n}: accent2 ${ui.accent2} stands out from the panel ${ui.panelBg} (contrast ${c.toFixed(2)})`);
}

const rootDefault = (src.match(/--ui-accent2:\s*(#[0-9a-f]{3,6});/i) || [])[1];
ok(rootDefault && rootDefault.toLowerCase() === String(THEMES.default.ui.accent2).toLowerCase(),
  ':root --ui-accent2 matches the default theme (custom themes use the :root palette)');
ok((src.match(/setProperty\('--ui-accent2',\s+t\.ui\.accent2\)/g) || []).length === 2,
  'both the early-boot script and applyTheme set --ui-accent2');
// The ring around the ✓ (16px badge, 1px gap, 2px ring) and the
// not-owned mark (hollow 18px circle, 2px ring) are the same ring: same
// centre, radius 9-11px, --ui-accent2.
{
  const rule = (sel) => { const m = creatures.match(new RegExp(sel.replace(/\./g, '\\.') + ' \\{([^}]*)\\}')); return m ? m[1] : ''; };
  const ring = rule('.speciesdex-cell .caught-badge.art-complete');
  const mark = rule('.speciesdex-cell .art-badge');
  ok(/0 0 0 1px var\(--ui-bg[^)]*\), 0 0 0 3px var\(--ui-accent2/.test(ring), 'the ✓ ring: 1px gap + ring in --ui-accent2');
  ok(/top: 3px; right: 3px/.test(mark) && /width: 18px; height: 18px/.test(mark)
    && /box-shadow: 0 0 0 2px var\(--ui-accent2/.test(mark), 'the not-owned mark: the same ring, same centre, same radius');
  ok(!/background/.test(mark), 'the not-owned mark is hollow (no fill)');
}
ok(!/#e2b33c/i.test(creatures), 'no fixed gold left in creatures.js');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
