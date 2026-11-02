// The artist screen:
//   - static/sprites.js _buildArtistIndex / splitArtistCredit: artist →
//     their distinct credited art (copies of an earlier slot skipped,
//     "A & B" credits count for both), checked on a tiny table and on the
//     real bundled data;
//   - static/creatures.js _artistFoundArt: only the art you've unlocked
//     (seeing or catching any copy of an image unlocks it), newest first;
//     _artistLinksHtml: one escaped link per name.
//
// Run: node tests/artist-screen.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
function extractFrom(src, marker) {
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

// ── 1. The index (sprites.js) ──
const spritesSrc = fs.readFileSync(path.join(root, 'static', 'sprites.js'), 'utf8');
const sp = { Map, Math, String, Array, Number, Uint8Array, Uint16Array, Uint32Array, Object };
vm.createContext(sp);
for (const m of ['function splitArtistCredit(', 'function _buildArtistIndex(', 'function _buildCellsCompact(']) {
  vm.runInContext(extractFrom(spritesSrc, m), sp);
}
const runS = (expr, args) => vm.runInContext(expr, Object.assign(sp, { __a: args }));
{
  ok(JSON.stringify(runS('splitArtistCredit(__a)', 'babyofdeath & barthandelus_real')) === '["babyofdeath","barthandelus_real"]',
    '1: "A & B" splits into both names');
  ok(JSON.stringify(runS('splitArtistCredit(__a)', 'solo')) === '["solo"]' && runS('splitArtistCredit(__a)', null).length === 0,
    '1: one name stays one; no credit → none');
  // Cell "1-2" (a 1, b 2): slots 0/1/2 → manifest indices 0/1/2 → suffixes '', 'a', 'b'.
  // Credits are keyed head-body ("2-1"). Slot 2 is a copy of slot 0.
  const compact = runS('_buildCellsCompact(__a)', { '1-2': [0, 1, 2], '3-4': [0] });
  const bundle = { '2-1': { '': 'x', a: 'y & z', b: 'x' }, '4-3': {} };
  const manifest = { 2: ['', 'a', 'b'], 4: [''] };
  const canonFor = (a, b) => (a === 1 && b === 2 ? new Uint8Array([0, 1, 0]) : null);
  const idx = runS('_buildArtistIndex(__a[0], __a[1], __a[2], __a[3])', [bundle, manifest, compact, canonFor]);
  const arts = (name) => (idx.byArtist.get(name) || []).map((c) => idx.artOf(c)).map((x) => `${x.a}-${x.b}#${x.slot}`).join(',');
  ok(arts('x') === '1-2#0', '1: a copied slot isn\'t counted twice (x has 1 art, got ' + arts('x') + ')');
  ok(arts('y') === '1-2#1' && arts('z') === '1-2#1', '1: a shared credit gives the art to both artists');
  ok(idx.byArtist.size === 3, '1: uncredited cells add no artist');
  const raw = runS('_buildArtistIndex(__a[0], __a[1], __a[2], null)', [bundle, manifest, compact]);
  ok((raw.byArtist.get('x') || []).length === 2, '1: without the copies table every slot counts');
}
{
  // Real bundled data: every code decodes to a real slot of a real cell.
  const B = path.join(root, 'data', 'BundledData');
  const compact = runS('_buildCellsCompact(__a)', JSON.parse(fs.readFileSync(path.join(B, 'cells.json'))));
  const idx = runS('_buildArtistIndex(__a[0], __a[1], __a[2], null)', [
    JSON.parse(fs.readFileSync(path.join(B, 'credits.json'))), JSON.parse(fs.readFileSync(path.join(B, 'manifest.json'))), compact]);
  ok(idx.byArtist.size > 1000, '1: real data has thousands of artists (' + idx.byArtist.size + ')');
  let valid = true;
  for (const codes of [...idx.byArtist.values()].slice(0, 300)) {
    for (const code of codes) {
      const { a, b, slot } = idx.artOf(code);
      if (!(a > 0 && b > 0 && slot >= 0 && slot < 256)) valid = false;
    }
  }
  ok(valid, '1: codes decode to real cells and slots');
}

// ── 2. Found art + links (creatures.js) ──
const src = fs.readFileSync(path.join(root, 'static', 'creatures.js'), 'utf8');
const ctx = {
  Object, Array, Math, Number, String, JSON, Infinity,
  escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  global: { Sprites: { splitArtistCredit: (c) => c.split(/\s+&\s+/) } },
  seen: {},
  caps: {},
};
ctx.readSeenFusions = () => ctx.seen;
ctx._capStore = { variantKeysForFusion: (a, b) => new Set(ctx.caps[`${a}-${b}`] || []) };
vm.createContext(ctx);
for (const m of ['function _artistFoundArt(', 'function _artistLinksHtml(']) vm.runInContext(extractFrom(src, m), ctx);
{
  // Art: (1,2) slot 0 [slots 0 and 3 share its image], (5,6) slot 1, (7,8) slot 0, (9,9) slot 2.
  const list = [[1, 2, 0], [5, 6, 1], [7, 8, 0], [9, 9, 2]];
  const index = { artOf: (code) => ({ a: list[code][0], b: list[code][1], slot: list[code][2] }) };
  const canonFor = (a, b) => (a === 1 && b === 2 ? new Uint8Array([0, 1, 2, 0]) : null);
  ctx.seen = {
    '1-2': { variants: { 3: 5000 } },          // saw the copy (slot 3) → unlocks slot 0
    '5-6': { variants: { 0: 9000 } },          // saw a different art of 5-6 → not this one
    '7-8': { variants: { 0: 7000, auto: 1 } },
  };
  ctx.caps = { '9-9': ['2'] };                  // caught only
  ctx.__args = [[0, 1, 2, 3], index, canonFor];
  const found = vm.runInContext('_artistFoundArt(...__args)', ctx);
  const ids = found.map((x) => `${x.a}-${x.b}#${x.slot}`).join(',');
  ok(ids === '7-8#0,1-2#0,9-9#2', '2: unlocked art only, newest first, caught-only last (' + ids + ')');
  ok(found[1].at === 5000, '2: a copy\'s sighting dates the art');
  const html = vm.runInContext('_artistLinksHtml("a<b & c")', ctx);
  ok((html.match(/class="artist-link"/g) || []).length === 2 && html.includes('a&lt;b') && html.includes(' &amp; '),
    '2: one escaped link per name, joined by &');
}
// The view is wired into the stack like the others.
ok(/case 'artist':\s*\n\s*panel\.querySelector\('\.artist-view'\)\.classList\.add\('show'\);\s*\n\s*renderArtist\(top\);/.test(src)
  && /querySelector\('\.artist-view'\)\.classList\.remove\('show'\)/.test(src)
  && /querySelector\('\.artist-back'\)\.addEventListener\('click', popView\)/.test(src),
  '3: artist view is shown / hidden / backed out of like the other views');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
