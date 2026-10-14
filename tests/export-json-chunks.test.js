// Tests the export serializer in static/index.html (the <export-json-chunks>
// block): Export writes a save a couple of MB at a time instead of as one
// giant string, and the pieces must join to exactly what JSON.stringify
// would have produced — same keys dropped, same nulls, same toJSON calls —
// so the file imports like any other save.
//
// Run: node tests/export-json-chunks.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
const a = src.indexOf('// <export-json-chunks>'), b = src.indexOf('// </export-json-chunks>');
ok(a > 0 && b > a, 'serializer block found in index.html');
const S = new Function(src.slice(a, b) + '\nreturn { _jsonPieces, _jsonChunks };')();

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

console.log(`export-json-chunks: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
