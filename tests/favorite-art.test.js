// Tests for per-fusion "favorite art":
//   - favoriteArtFor: favorite if set, else default (lowest seen art, non-shiny)
//   - setFavoriteArt: persists { variant, shinyVariant }; only for seen fusions
//
// Run: node tests/favorite-art.test.js
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

let seen = {};
let pref = undefined;   // what pickPreferredSeenVariant returns
const ctx = {
  readSeenFusions: () => seen,
  writeSeenFusions: (m) => { seen = m; },
  pickPreferredSeenVariant: () => pref,
};
vm.createContext(ctx);
vm.runInContext(extract('function favoriteArtFor'), ctx);
vm.runInContext(extract('function setFavoriteArt'), ctx);
const call = (name, ...args) => { ctx.__a = args; return vm.runInContext(`${name}(...__a)`, ctx); };

// ── A. default when no favorite: lowest seen art variant, non-shiny ──
{
  seen = { '1-4': {} };
  pref = 2;
  ok(eq(call('favoriteArtFor', 1, 4), { variant: 2, shinyVariant: null }),
     'A: default = lowest seen variant (2), non-shiny');
  pref = undefined;
  ok(eq(call('favoriteArtFor', 1, 4), { variant: undefined, shinyVariant: null }),
     'A: default = best-available (undefined) when nothing seen');
}

// ── B. setFavoriteArt persists a normal art variant ──
{
  seen = { '1-4': {} };
  ok(call('setFavoriteArt', 1, 4, 3, null) === true, 'B: set favorite returns true for seen fusion');
  ok(eq(seen['1-4'].favoriteArt, { variant: 3, shinyVariant: null }), 'B: stored { variant:3, shinyVariant:null }');
  pref = 0;   // default would be 0, but the favorite (3) must win
  ok(eq(call('favoriteArtFor', 1, 4), { variant: 3, shinyVariant: null }), 'B: favorite overrides default');
}

// ── C. favorite a SHINY (art variant + shiny style) ──
{
  seen = { '1-4': {} };
  call('setFavoriteArt', 1, 4, 2, 7);   // art variant 2, shiny style 7
  ok(eq(seen['1-4'].favoriteArt, { variant: 2, shinyVariant: 7 }), 'C: shiny favorite stored with both');
  ok(eq(call('favoriteArtFor', 1, 4), { variant: 2, shinyVariant: 7 }), 'C: favoriteArtFor returns the shiny');
}

// ── D. autogen favorite (null art variant) ──
{
  seen = { '1-4': {} };
  call('setFavoriteArt', 1, 4, null, null);   // autogen
  ok(eq(seen['1-4'].favoriteArt, { variant: null, shinyVariant: null }), 'D: autogen favorite stored as variant:null');
  ok(eq(call('favoriteArtFor', 1, 4), { variant: null, shinyVariant: null }), 'D: favoriteArtFor returns autogen');
}

// ── E. cannot favorite an unseen fusion (never mints an entry) ──
{
  seen = {};
  ok(call('setFavoriteArt', 9, 9, 0, null) === false, 'E: returns false for unseen fusion');
  ok(!seen['9-9'], 'E: no phantom entry created');
  pref = 5;
  ok(eq(call('favoriteArtFor', 9, 9), { variant: 5, shinyVariant: null }),
     'E: favoriteArtFor still returns the default for an unseen fusion');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
