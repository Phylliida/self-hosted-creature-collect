// Regression test for "preferred art should also show up in family tree".
//
// The family-tree mosaic already picks each cell's sprite from
// favoriteArtFor at render time. The gap was the LIVE update path:
// _refreshFavoriteArt (fired when the user taps a new favorite art/shiny
// cell) re-rendered the header art but NOT the already-expanded family
// grid, so the current fusion's mosaic cell kept the old art until the
// entry was reopened. This test drives _refreshFavoriteArt against a
// minimal fake DOM and asserts it now re-loads the matching family cell
// with the freshly chosen favorite variant.
//
// Run: node tests/favorite-art-family-tree.test.js
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

// ── Minimal fake DOM ────────────────────────────────────────────────
function fakeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    toggle: (c, on) => { if (on) set.add(c); else set.delete(c); },
    contains: (c) => set.has(c),
    _set: set,
  };
}
function fakeEl(extra) {
  return Object.assign({ classList: fakeClassList(), style: {} }, extra);
}

// showSprite spy — records every (img, a, b, variant, opts) call.
const calls = [];
const SpriteStore = {
  showSprite: (img, a, b, variant, opts) => {
    calls.push({ img, a, b, variant, opts });
    if (opts && opts.onReady) opts.onReady();   // simulate immediate load
  },
};

// Build a body whose querySelector answers exactly the selectors
// _refreshFavoriteArt uses. `familyPresent` toggles whether the mosaic
// cell for (a,b) exists (i.e. family tree expanded vs collapsed).
function makeBody({ familyPresent, a, b }) {
  const headerImg = fakeEl({ _tag: 'headerImg' });
  const headerPh = fakeEl({ _tag: 'headerPh' });
  const art = fakeEl({ _tag: 'art' });
  const famCell = fakeEl({ _tag: 'famCell' });
  const famImg = fakeEl({ _tag: 'famImg', closest: (sel) => (sel === '.family-cell' ? famCell : null) });
  const famSelector = `.family-grid .family-cell[data-a="${a}"][data-b="${b}"] img`;
  return {
    _famCell: famCell,
    querySelector: (sel) => {
      if (sel === '.detail-art-img') return headerImg;
      if (sel === '.detail-art-placeholder') return headerPh;
      if (sel === '.detail-art') return art;
      if (sel === famSelector) return familyPresent ? famImg : null;
      return null;
    },
  };
}

const ctx = {
  global: { SpriteStore },
  readSeenFusions: () => ctx.__seen,
  writeSeenFusions: (m) => { ctx.__seen = m; },
  pickPreferredSeenVariant: () => undefined,
  _markFavoriteCells: () => {},   // exercised by favorite-art.test.js; stub here
  __seen: {},
};
vm.createContext(ctx);
vm.runInContext(extract('function favoriteArtFor'), ctx);
vm.runInContext(extract('function _refreshFavoriteArt'), ctx);
const refresh = (body, a, b) => { ctx.__b = [body, a, b]; return vm.runInContext('_refreshFavoriteArt(...__b)', ctx); };

// ── 1. Expanded family tree: current cell re-renders with new favorite ──
{
  calls.length = 0;
  ctx.__seen = { '1-4': { favoriteArt: { variant: 5, shinyVariant: null } } };
  const body = makeBody({ familyPresent: true, a: 1, b: 4 });
  refresh(body, 1, 4);
  const famCall = calls.find((c) => c.img && c.img._tag === 'famImg');
  ok(!!famCall, '1: family cell sprite was re-rendered');
  ok(famCall && famCall.variant === 5, '1: family cell uses the new favorite variant (5)');
  ok(famCall && famCall.opts && famCall.opts.shinyVariant === null, '1: shinyVariant passed through');
  ok(body._famCell.classList.contains('ready'), '1: onReady re-marked the cell .ready');
}

// ── 2. Shiny favorite propagates to the family cell too ──
{
  calls.length = 0;
  ctx.__seen = { '1-4': { favoriteArt: { variant: 2, shinyVariant: 7 } } };
  const body = makeBody({ familyPresent: true, a: 1, b: 4 });
  refresh(body, 1, 4);
  const famCall = calls.find((c) => c.img && c.img._tag === 'famImg');
  ok(famCall && famCall.variant === 2 && famCall.opts.shinyVariant === 7,
     '2: family cell gets the favorited shiny (variant 2, shiny 7)');
}

// ── 3. Collapsed family tree: no crash, only the header re-renders ──
{
  calls.length = 0;
  ctx.__seen = { '1-4': { favoriteArt: { variant: 3, shinyVariant: null } } };
  const body = makeBody({ familyPresent: false, a: 1, b: 4 });
  refresh(body, 1, 4);
  const famCall = calls.find((c) => c.img && c.img._tag === 'famImg');
  ok(!famCall, '3: no family cell call when the mosaic is collapsed');
  const headerCall = calls.find((c) => c.img && c.img._tag === 'headerImg');
  ok(!!headerCall && headerCall.variant === 3, '3: header still re-renders (variant 3)');
}

// ── 4. Only the (a,b) cell is targeted (selector is fusion-specific) ──
{
  calls.length = 0;
  ctx.__seen = { '1-4': { favoriteArt: { variant: 9, shinyVariant: null } } };
  // Body reports a family cell only for a DIFFERENT pair (2,4) → the
  // (1,4) refresh must NOT match it.
  const body = makeBody({ familyPresent: true, a: 2, b: 4 });
  refresh(body, 1, 4);
  const famCall = calls.find((c) => c.img && c.img._tag === 'famImg');
  ok(!famCall, '4: a mismatched-pair cell is not touched');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
