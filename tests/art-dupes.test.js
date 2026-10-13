// cells-dupes.bin: about half of all hand-drawn art slots are byte-for-
// byte copies of another slot of the same cell (Charmander × Ditto lists
// one picture twice). The file maps each slot to its canonical slot so
// the species dex's all-art ring and the Summary's art % count distinct
// pictures, as the fusion view's art grid shows them.
//   1. data/BundledData/cells-dupes.bin is well formed and lines up with
//      cells.json (one byte per slot, compact-table order, canonical
//      slots point at themselves);
//   2. where the sprite packs are present (they aren't tracked), it
//      matches the packs' bytes for a sample of heads;
//   3. static/art-dupes.txt (the Refresh copy for packs installed before
//      the .bin existed) is the same bytes, gzipped + base64;
//   4. Sprites.getArtCanon loads the pack's file, else the Refresh copy,
//      answers per cell, and refuses a file built for other cells (shape
//      hash) — null when nothing fits.
//
// Run: node tests/art-dupes.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const bundled = path.join(root, 'data', 'BundledData');
const cellsBuf = fs.readFileSync(path.join(bundled, 'cells.json'));
const cells = JSON.parse(cellsBuf);
const dupesBuf = fs.readFileSync(path.join(bundled, 'cells-dupes.bin'));
const refreshTxt = fs.readFileSync(path.join(root, 'static', 'art-dupes.txt'), 'utf8');
const zlib = require('zlib');
const HEADER = 16;

// ── 1. Format ──
const order = Object.keys(cells).filter((k) => Array.isArray(cells[k]) && cells[k].length)
  .map((k) => { const [a, b] = k.split('-').map(Number); return { k, a, b, n: cells[k].length, ord: a * 65536 + b }; })
  .sort((x, y) => x.ord - y.ord);
const totalSlots = order.reduce((s, c) => s + c.n, 0);
ok(dupesBuf.slice(0, 4).toString('latin1') === 'CRDP', '1: magic CRDP');
ok(dupesBuf.readUInt32LE(4) === totalSlots && dupesBuf.length === HEADER + totalSlots,
  `1: one byte per slot (${totalSlots} slots)`);
ok(dupesBuf.readUInt32LE(8) === order.length, `1: cell count ${order.length}`);
{
  let h = 0x811c9dc5;
  const mix = (x) => { h = Math.imul(h ^ x, 0x01000193) >>> 0; };
  for (const c of order) { const k = c.ord >>> 0; mix(k & 255); mix((k >>> 8) & 255); mix((k >>> 16) & 255); mix(k >>> 24); mix(c.n & 255); }
  ok(dupesBuf.readUInt32LE(12) === h, '1: shape hash matches cells.json');
}
const canonOf = new Map();
{
  let off = HEADER, bad = 0, dupCells = 0;
  for (const c of order) {
    const canon = Array.from(dupesBuf.subarray(off, off + c.n));
    off += c.n;
    canonOf.set(c.k, canon);
    if (canon.some((r, i) => r > i || canon[r] !== r)) bad++;
    if (canon.some((r, i) => r !== i)) dupCells++;
  }
  ok(bad === 0, `1: every slot points at an earlier-or-same canonical slot (${bad} bad cells)`);
  ok(dupCells > 0, `1: has duplicate cells (${dupCells})`);
  ok(JSON.stringify(canonOf.get('4-132')) === '[0,0]' && JSON.stringify(canonOf.get('132-4')) === '[0,0]',
    '1: Charmander × Ditto: one picture under two slots, both ways round');
}

// ── 2. Matches the packs' bytes (when they're here) ──
const packsDir = path.join(bundled, 'sprite-packs');
if (fs.existsSync(packsDir)) {
  let checked = 0, mismatched = 0;
  for (const b of [1, 4, 7, 25, 132, 143, 150]) {
    const p = path.join(packsDir, `${b}.pack`);
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    const count = buf.readUInt32LE(4), payload = 8 + 16 * count;
    const hashes = new Map();
    for (let i = 0; i < count; i++) {
      const o = 8 + 16 * i;
      const a = buf.readUInt32LE(o), v = buf.readInt32LE(o + 4), off = buf.readUInt32LE(o + 8), len = buf.readUInt32LE(o + 12);
      if (v < 0) continue;
      hashes.set(`${a}:${v}`, crypto.createHash('sha256').update(buf.subarray(payload + off, payload + off + len)).digest('hex'));
    }
    for (const [k, canon] of canonOf) {
      const [a, bb] = k.split('-').map(Number);
      if (bb !== b) continue;
      checked++;
      const first = new Map();
      const want = canon.map((_, s) => { const h = hashes.get(`${a}:${s}`); if (!h) return s; if (!first.has(h)) first.set(h, s); return first.get(h); });
      if (JSON.stringify(want) !== JSON.stringify(canon)) mismatched++;
    }
  }
  ok(checked > 100 && mismatched === 0, `2: matches the pack bytes (${checked} cells checked, ${mismatched} mismatched)`);
} else {
  console.log('(2: sprite packs not present here — skipped)');
}

// ── 3. Refresh copy ──
ok(zlib.gunzipSync(Buffer.from(refreshTxt.trim(), 'base64')).equals(dupesBuf),
  '3: static/art-dupes.txt is the .bin, gzipped + base64');
ok(Buffer.byteLength(refreshTxt) < 60000, `3: and small (${Buffer.byteLength(refreshTxt)} bytes)`);

// ── 4. Sprites.getArtCanon ──
const spritesSrc = fs.readFileSync(path.join(root, 'static', 'sprites.js'), 'utf8');
function loadSprites(files) {
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Blob, URL, Response, performance, AbortController,
    DecompressionStream, atob, ArrayBuffer, Uint8Array, DataView,
    fetch: async (url) => {
      const name = String(url).split('/').pop();
      return files[name] ? new Response(files[name], { status: 200 }) : new Response(null, { status: 404 });
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Capacitor: {},
  };
  vm.createContext(ctx);
  ctx.window = ctx;
  vm.runInContext(spritesSrc, ctx);
  return ctx.Sprites;
}
(async () => {
  {
    const S = loadSprites({ 'cells.json': cellsBuf, 'cells-dupes.bin': dupesBuf });
    const canonFor = await S.getArtCanon();
    ok(typeof canonFor === 'function', '4: loads the pack\'s file');
    const v = canonFor && canonFor(4, 132);
    ok(v && Array.from(v).join() === '0,0', '4: Charmander × Ditto → [0, 0]');
    const v11 = canonFor && canonFor(1, 1);
    ok(v11 && Array.from(v11).join() === canonOf.get('1-1').join(), '4: matches the file for 1-1');
    ok(canonFor && canonFor(99999, 1) === null, '4: a cell with no custom art → null');
    ok((await S.getArtCanon()) === canonFor, '4: loaded once');
  }
  {
    // A pack installed before the .bin existed: the Refresh copy fills in.
    const S = loadSprites({ 'cells.json': cellsBuf, 'art-dupes.txt': refreshTxt });
    const canonFor = await S.getArtCanon();
    const v = canonFor && canonFor(4, 132);
    ok(v && Array.from(v).join() === '0,0', '4: no .bin in the pack → the Refresh copy is used');
  }
  {
    const S = loadSprites({ 'cells.json': cellsBuf });
    ok((await S.getArtCanon()) === null, '4: neither file → null (every slot counts)');
  }
  {
    // Built for other cells (e.g. an IF2 pack): drop one cell from cells.json.
    const other = Object.assign({}, cells); delete other['4-132'];
    const S = loadSprites({ 'cells.json': Buffer.from(JSON.stringify(other)), 'cells-dupes.bin': dupesBuf, 'art-dupes.txt': refreshTxt });
    ok((await S.getArtCanon()) === null, '4: a file built for other cells is refused (pack and Refresh copy)');
  }
  {
    // Same slot total, different shape: swap two cells' slot counts.
    const other = JSON.parse(cellsBuf);
    const [k1, k2] = Object.keys(other).filter((k) => other[k].length === 1).slice(0, 1)
      .concat(Object.keys(other).filter((k) => other[k].length === 3).slice(0, 1));
    other[k1] = [0, 1]; other[k2] = [0, 1];
    const S = loadSprites({ 'cells.json': Buffer.from(JSON.stringify(other)), 'cells-dupes.bin': dupesBuf });
    ok((await S.getArtCanon()) === null, '4: same slot total but a different shape → refused (shape hash)');
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
