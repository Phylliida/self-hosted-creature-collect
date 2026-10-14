// Tests the export serializer in static/index.html (the <export-json-chunks>
// block): Export writes a save a couple of MB at a time instead of as one
// giant string, and the pieces must join to exactly what JSON.stringify
// would have produced — same keys dropped, same nulls, same toJSON calls —
// so the file imports like any other save. The gzip pieces (the .json.gz
// export) must concatenate to one valid gzip of that same JSON, and the
// base64 the native write sends must decode back to the same bytes.
//
// Run: node tests/export-json-chunks.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
const a = src.indexOf('// <export-json-chunks>'), b = src.indexOf('// </export-json-chunks>');
ok(a > 0 && b > a, 'serializer block found in index.html');
const S = new Function(src.slice(a, b) + '\nreturn { _jsonPieces, _jsonChunks, _gzipChunks, _bytesToBase64 };')();

const join = (v, size) => Array.from(S._jsonChunks(v, size)).join('');

// ── Same output as JSON.stringify, edge cases at every walked level ──
const nullProto = Object.create(null);
nullProto.x = 1; nullProto.y = undefined;
const cases = {
  empty: {},
  scalars: { n: 1.5, z: -0, s: 'a "quoted"\nline   é ♀ 🐛', t: true, f: false, nul: null },
  nonFinite: { a: NaN, b: Infinity, c: [NaN, -Infinity] },
  dropped: { u: undefined, fn() {}, sym: Symbol('s'), keep: 1 },
  arrayHoles: { list: [1, undefined, () => 0, Symbol('x'), null, [undefined]] },
  // eslint-disable-next-line no-sparse-arrays
  sparse: { list: [1, , 3] },
  dates: { at: new Date(0), list: [new Date(86400000)], deep: { d: new Date(5) } },
  toJSON: {
    custom: { toJSON(k) { return 'key:' + k; } },
    gone: { toJSON() { return undefined; } },
    list: [{ toJSON(k) { return { idx: k }; } }, { toJSON() { return undefined; } }],
  },
  boxed: { n: new Number(3), s: new String('x'), list: [new Boolean(false)] },
  nullProto: { o: nullProto, list: [nullProto] },
  emptyContainers: { a: [], o: {}, deep: { a: [], o: {} }, list: [[], {}] },
  nested: { captured: [{ id: 'c1', head: 1, body: 2, tags: ['a'], meta: { x: [1, { y: 2 }] } }],
            seenFusions: { '1:2': { at: 5, n: 2 }, '3:4': 1 } },
  numericKeys: { o: { 2: 'b', 1: 'a', x: 'c' } },
  deeperThanWalked: { a: { b: { c: { u: undefined, d: new Date(0), f() {}, l: [undefined] } } } },
};
for (const [name, v] of Object.entries(cases)) {
  const want = JSON.stringify(v);
  for (const size of [1, 7, 64, 1 << 20]) {
    ok(join(v, size) === want, `${name} (size ${size}) matches JSON.stringify`);
  }
}
// Top-level values that aren't plain objects go straight to JSON.stringify.
for (const v of [null, 3, 'str', [1, 2], new Date(1)]) {
  ok(join(v, 4) === JSON.stringify(v), `top-level ${JSON.stringify(v)} matches`);
}
ok(join(undefined, 4) === 'null', 'top-level undefined → null');

// ── Chunk sizes: every chunk but the last reaches the target, none is
// much bigger than target + one leaf, and nothing is lost ──
{
  const big = {
    version: 1,
    captured: Array.from({ length: 5000 }, (_, i) => ({ id: 'c' + i, head: i % 500, body: (i * 7) % 500, nick: i % 3 ? null : 'Mon ' + i })),
    seenFusions: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [i + ':' + (i * 3), { at: i }])),
    daycare: { days: Array.from({ length: 200 }, (_, i) => ({ d: i, path: Array.from({ length: 50 }, (_, j) => [45 + j / 1e4, -73 - i / 1e4]) })) },
  };
  const want = JSON.stringify(big);
  const size = 10000;
  const chunks = Array.from(S._jsonChunks(big, size));
  ok(chunks.join('') === want, 'big save joins to JSON.stringify');
  ok(chunks.length > 10, `big save splits into many chunks (${chunks.length})`);
  ok(chunks.slice(0, -1).every((c) => c.length >= size), 'every chunk but the last reaches the target size');
  // The largest leaf here is one daycare day (~2 KB).
  const maxLeaf = Math.max(...big.daycare.days.map((d) => JSON.stringify(d).length));
  ok(chunks.every((c) => c.length < size + maxLeaf + 64), 'no chunk overshoots by more than one leaf');
  ok(JSON.parse(chunks.join('')).captured.length === 5000, 'round-trips through JSON.parse');
}

// ── Lazy: the generator doesn't serialize the whole save up front ──
{
  let touched = 0;
  const v = { list: Array.from({ length: 100 }, (_, i) => ({ toJSON() { touched++; return i; } })) };
  const it = S._jsonChunks(v, 10);
  it.next();
  ok(touched < 100, `first chunk only serializes what it needs (${touched}/100)`);
}

// ── Gzip: streamed pieces make one valid .gz of exactly the JSON ──
async function gzipTests() {
  const big = {
    version: 1,
    captured: Array.from({ length: 20000 }, (_, i) => ({ id: 'c' + i, head: i % 500, body: (i * 7) % 500, nick: i % 5 ? null : 'Mön ♀ 🐛 ' + i })),
    // Random digits so it doesn't all compress to nothing.
    daycare: { paths: Object.fromEntries(Array.from({ length: 30 }, (_, d) => ['2026-09-' + d,
      Array.from({ length: 2000 }, () => [45 + Math.random() / 100, -73 - Math.random() / 100])])) },
  };
  const want = JSON.stringify(big);
  const bytes = 64 * 1024;
  const chunks = [];
  for await (const c of S._gzipChunks(big, bytes)) chunks.push(c);
  ok(chunks.every((c) => c instanceof Uint8Array), 'gzip pieces are Uint8Arrays');
  ok(chunks.length > 3, `gzip splits into several pieces (${chunks.length})`);
  ok(chunks.slice(0, -1).every((c) => c.length >= bytes), 'every gzip piece but the last reaches the target');
  const gz = Buffer.concat(chunks);
  ok(gz[0] === 0x1f && gz[1] === 0x8b, 'starts with the gzip magic bytes');
  ok(zlib.gunzipSync(gz).toString('utf8') === want, 'gunzips to exactly JSON.stringify');
  ok(gz.length < want.length / 2, `smaller than the JSON (${gz.length} vs ${Buffer.byteLength(want)} bytes)`);
  // base64 per piece, decoded and appended one by one, as the native write does.
  const viaB64 = Buffer.concat(chunks.map((c) => Buffer.from(S._bytesToBase64(c), 'base64')));
  ok(viaB64.equals(gz), 'base64 pieces decode back to the same bytes');
  ok(S._bytesToBase64(new Uint8Array(0)) === '', 'base64 of nothing');
  const odd = new Uint8Array(100003).map((_, i) => (i * 131) & 255);
  ok(S._bytesToBase64(odd) === Buffer.from(odd).toString('base64'), 'base64 matches Buffer over the 32 KB batches');
  // Small saves come out as a single piece.
  const small = [];
  for await (const c of S._gzipChunks({ a: 1 }, bytes)) small.push(c);
  ok(small.length === 1 && zlib.gunzipSync(Buffer.from(small[0])).toString() === '{"a":1}', 'tiny save → one piece');
  // A value JSON.stringify throws on surfaces as a rejection, not a hang.
  const cyc = { list: [{}] }; cyc.list[0].self = cyc.list[0];
  let threw = false;
  try { for await (const _ of S._gzipChunks(cyc, bytes)) { /* drain */ } } catch (e) { threw = /circular/i.test(e.message); }
  ok(threw, 'circular value rejects with the stringify error');
}

gzipTests().catch((e) => { failed++; console.error('FAIL: gzip tests threw', e); }).then(() => {
  console.log(`export-json-chunks: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
