// Test: mergeSeenFusions (backup-restore) is lossless — new fusions copied
// whole; for known fusions it keeps earliest firstSeen / latest lastSeen,
// UNIONs art + shiny variants, adopts an imported favorite only when there's
// no local one, and fills "first seen here" location when local lacks it.
//
// Run: node tests/merge-seen.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
vm.runInContext(extract('function _normShinyEntry'), ctx);
vm.runInContext(extract('function mergeSeenFusions'), ctx);
const merge = (cur, inc) => { ctx.__c = cur; ctx.__i = inc; return vm.runInContext('mergeSeenFusions(__c, __i)', ctx); };

// ── A. new fusion copied whole ──
{
  const cur = {};
  const inc = { '1-4': { firstSeen: 5, variants: { '0': 5 }, shinyVariants: [{ variant: 2, shinyVariant: 7 }], favoriteArt: { variant: 2, shinyVariant: 7 } } };
  merge(cur, inc);
  ok(eq(cur['1-4'], inc['1-4']), 'A: new fusion copied whole (variants/shiny/favorite preserved)');
}
// ── B. firstSeen earliest, lastSeen latest ──
{
  const cur = { '1-4': { firstSeen: 10, lastSeen: 20 } };
  merge(cur, { '1-4': { firstSeen: 5, lastSeen: 30 } });
  ok(cur['1-4'].firstSeen === 5 && cur['1-4'].lastSeen === 30, 'B: earliest firstSeen, latest lastSeen');
}
// ── C. art variants unioned, earliest timestamp wins ──
{
  const cur = { '1-4': { variants: { '0': 100, 'auto': 50 } } };
  merge(cur, { '1-4': { variants: { '0': 80, '1': 200 } } });
  ok(eq(cur['1-4'].variants, { '0': 80, 'auto': 50, '1': 200 }), 'C: variants unioned, earliest ts per key');
}
// ── D. shiny variants unioned + deduped, legacy number tolerated ──
{
  const cur = { '1-4': { shinyVariants: [{ variant: 2, shinyVariant: 7 }, 3] } };  // 3 == legacy (null,3)
  merge(cur, { '1-4': { shinyVariants: [{ variant: 2, shinyVariant: 7 }, { variant: null, shinyVariant: 3 }, { variant: 5, shinyVariant: 9 }] } });
  const sv = cur['1-4'].shinyVariants;
  ok(sv.length === 3, 'D: unioned (dupes (2,7) and legacy (null,3) skipped, (5,9) added)');
  const norm = (e) => (typeof e === 'number') ? { variant: null, shinyVariant: e } : e;
  const has = (v, s) => sv.some((e) => { const n = norm(e); return n.variant === v && n.shinyVariant === s; });
  ok(has(2, 7) && has(null, 3) && has(5, 9), 'D: all three distinct pairs present');
}
// ── E. favorite: keep local on conflict; adopt imported when local has none ──
{
  let cur = { '1-4': { favoriteArt: { variant: 1, shinyVariant: null } } };
  merge(cur, { '1-4': { favoriteArt: { variant: 9, shinyVariant: 5 } } });
  ok(eq(cur['1-4'].favoriteArt, { variant: 1, shinyVariant: null }), 'E: keeps local favorite on conflict');
  cur = { '1-4': {} };
  merge(cur, { '1-4': { favoriteArt: { variant: 9, shinyVariant: 5 } } });
  ok(eq(cur['1-4'].favoriteArt, { variant: 9, shinyVariant: 5 }), 'E: adopts imported favorite when local has none');
}
// ── F. location filled when local lacks it; kept when present ──
{
  let cur = { '1-4': {} };
  merge(cur, { '1-4': { lat: 45.5, lng: -73.5, poi: { name: 'X' }, place: { city: 'Mtl' } } });
  ok(cur['1-4'].lat === 45.5 && cur['1-4'].poi.name === 'X' && cur['1-4'].place.city === 'Mtl',
     'F: fills location when local lacks it');
  cur = { '1-4': { lat: 1, lng: 2 } };
  merge(cur, { '1-4': { lat: 45.5, lng: -73.5 } });
  ok(cur['1-4'].lat === 1, 'F: keeps local location when already present');
}
// ── G. tolerates null / non-object incoming entries ──
{
  const cur = { '1-4': { firstSeen: 5 } };
  merge(cur, { '1-4': null, '9-9': 'garbage', '2-2': { firstSeen: 9 } });
  ok(cur['1-4'].firstSeen === 5 && !cur['9-9'] && cur['2-2'].firstSeen === 9, 'G: skips null/garbage incoming');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
