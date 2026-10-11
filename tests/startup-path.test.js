// Guards the cold-start critical path (Oct 2026 startup work). The
// Settings dump's [boot timeline] showed a Pixel 4a needing 7–12 s to
// reach "map idle + first creature sprite": every step waited on the
// one before it. Each check below pins one link of that chain open.
//
// Run: node tests/startup-path.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');

// Brace-matched slice of `function name(` … `}` from a source string.
function sliceFn(src, head) {
  const start = src.indexOf(head);
  if (start < 0) throw new Error('not found: ' + head);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced: ' + head);
}

// ── 1. Static tiles: overlapping regions are tried first ──────────────
// Trying regions in download order made the first tile of a boot open
// (and parse) regions nowhere near the view — 372 ms of a 437 ms tile.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(sliceFn(indexSrc, 'function _regionsForTile(') +
    '\nthis._regionsForTile = _regionsForTile;', ctx);
  const order = (regions, z, x, y) => ctx._regionsForTile(regions, z, x, y).map((r) => r.id);
  // Bees' first tile on 2026-10-11: z14 2588/5954 (Eugene, OR).
  const eugene = { id: 'eugene', bbox: [-123.3, 43.9, -122.9, 44.2] };
  const portland = { id: 'portland', bbox: [-122.9, 45.3, -122.4, 45.7] };
  const seattle = { id: 'seattle', bbox: [-122.5, 47.4, -122.2, 47.8] };
  const noBbox = { id: 'legacy' };
  ok(order([portland, seattle, eugene], 14, 2588, 5954)[0] === 'eugene',
    'the region containing the tile is tried first');
  ok(order([portland, seattle, eugene], 14, 2588, 5954).join() === 'eugene,portland,seattle',
    'non-overlapping regions stay as a fallback, in their original order');
  ok(order([portland, noBbox, eugene], 14, 2588, 5954).join() === 'legacy,eugene,portland',
    'a record without a bbox counts as overlapping (old behaviour)');
  ok(order([], 14, 2588, 5954).length === 0, 'no regions → empty list');
  // z5 5/11 spans lon -123.75..-112.5, lat 40.98..48.92 — all three.
  ok(order([portland, seattle, eugene], 5, 5, 11).join() === 'portland,seattle,eugene',
    'a tile overlapping several regions keeps their order');
  // z6 10/22 spans lat 45.09..48.92: Portland + Seattle, not Eugene.
  ok(order([eugene, seattle, portland], 6, 10, 22).join() === 'seattle,portland,eugene',
    'a region just outside the tile moves behind the overlapping ones');
}

// ── 2. Addresses: searchable index instead of one object per address ──
// 2.7 M address objects (+ two label strings each) were built at boot
// for the search box: a 2.5 s freeze and hundreds of MB. The index
// keeps the columns as typed arrays and must match exactly what the
// old per-record scan matched: every whitespace-split token is a
// substring of "<num> <street>".toLowerCase().
{
  const ctx = { TextDecoder, Uint8Array, Uint16Array, Uint32Array, DataView };
  vm.createContext(ctx);
  vm.runInContext(sliceFn(indexSrc, 'function _addressRegionIndex(') + '\n' +
    sliceFn(indexSrc, 'function searchAddressIndexes(') +
    '\nthis._addressRegionIndex = _addressRegionIndex;' +
    '\nthis.searchAddressIndexes = searchAddressIndexes;', ctx);

  // Build an ADDR v1 buffer (layout: run.py /addresses).
  function buildAddr(rows, bbox) {
    const nums = [], streets = [], ni = new Map(), si = new Map();
    const intern = (pool, idx, v) => {
      if (!idx.has(v)) { idx.set(v, pool.length); pool.push(v); }
      return idx.get(v);
    };
    const enc = new TextEncoder();
    const N = rows.length;
    const numIdx = rows.map((r) => intern(nums, ni, r.num));
    const streetIdx = rows.map((r) => intern(streets, si, r.street));
    const poolBytes = (pool) => pool.map((x) => enc.encode(x));
    const nb = poolBytes(nums), sb = poolBytes(streets);
    const len = (bs) => bs.reduce((n, b) => n + 2 + b.length, 0);
    const buf = new ArrayBuffer(48 + 8 * N + len(nb) + len(sb));
    const dv = new DataView(buf);
    'ADDR'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
    dv.setUint32(4, 1, true); dv.setUint32(8, N, true);
    dv.setUint32(12, nums.length, true); dv.setUint32(16, len(nb), true);
    dv.setUint32(20, streets.length, true); dv.setUint32(24, len(sb), true);
    bbox.forEach((v, i) => dv.setFloat32(32 + 4 * i, v, true));
    const [w, s, e, n] = bbox;
    rows.forEach((r, i) => {
      dv.setUint16(48 + 2 * i, Math.round((r.lng - w) / (e - w) * 65535), true);
      dv.setUint16(48 + 2 * N + 2 * i, Math.round((r.lat - s) / (n - s) * 65535), true);
      dv.setUint16(48 + 4 * N + 2 * i, numIdx[i], true);
      dv.setUint16(48 + 6 * N + 2 * i, streetIdx[i], true);
    });
    let off = 48 + 8 * N;
    for (const b of nb.concat(sb)) {
      dv.setUint16(off, b.length, true); off += 2;
      new Uint8Array(buf, off, b.length).set(b); off += b.length;
    }
    return buf;
  }
  const rows = [
    { num: '1996', street: 'South Allison Way', lng: -123.1, lat: 44.05 },
    { num: '533', street: 'Northwest 19th Street', lng: -123.09, lat: 44.06 },
    { num: '19', street: 'Main Street', lng: -123.08, lat: 44.04 },
    { num: '1900A', street: 'Main Street', lng: -123.07, lat: 44.03 },
    { num: '12', street: 'Café Lane', lng: -123.06, lat: 44.02 },
    { num: '7', street: 'Allison Court', lng: -123.05, lat: 44.01 },
  ];
  const bbox = [-123.2, 43.9, -122.9, 44.2];
  const ix = ctx._addressRegionIndex('r1', buildAddr(rows, bbox));
  ok(ix.N === rows.length && ix.regionId === 'r1', 'index reads the header');
  const r0 = ix.record(0);
  ok(r0.label === '1996 South Allison Way' && r0.num === '1996'
     && Math.abs(r0.lng - -123.1) < 1e-3 && Math.abs(r0.lat - 44.05) < 1e-3,
     'record(i) rebuilds the old address shape (label, num, lng/lat)');

  const oldScan = (q) => {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    return rows.map((r) => `${r.num} ${r.street}`)
      .filter((label) => tokens.every((t) => label.toLowerCase().includes(t)));
  };
  const newScan = (q, limit) => {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    ctx.searchAddressIndexes([ix], tokens, (a) => { out.push(a.label); return !limit || out.length < limit; });
    return out;
  };
  for (const q of ['allison', 'Allison 1996', '1996 allison way', '19', '19th', 'main 19',
                   'MAIN street 1900', 'café', 'cafe', 'way south', 'nope', '7 court', '9 st']) {
    ok(JSON.stringify(newScan(q)) === JSON.stringify(oldScan(q)),
      `address query "${q}" matches the old scan (${JSON.stringify(oldScan(q))})`);
  }
  ok(newScan('main', 1).length === 1, 'onHit returning false stops the scan');
  ok(newScan('').length === 0, 'no tokens → no hits');
}

// ── 3. Nothing awaited between map creation and releasing static tiles ─
// Street-level tiles queue on _staticReadyPromise until the static block
// (near the end of the boot IIFE) calls _markStaticReady(); MapLibre's
// 'load' — and with it GPS, icons, spawns — waits on those tiles. A
// top-level `await` anywhere in between (favorites, POIs, addresses,
// trigrams all used to sit there) holds the whole first screen hostage.
{
  const lines = indexSrc.split('\n');
  const from = lines.findIndex((l) => l.includes("_bootMark('map:ctor')"));
  const to = lines.findIndex((l) => /^\s*window\._markStaticReady\(\);/.test(l));
  ok(from > 0 && to > from, 'found map construction and the _markStaticReady() call');
  const blocking = [];
  for (let i = from; i < to; i++) {
    // Two-space indent = top level of the boot IIFE.
    if (/^  (?![ /]).*\bawait\b/.test(lines[i])) blocking.push(`${i + 1}: ${lines[i].trim()}`);
  }
  ok(blocking.length === 0,
    `no top-level await between map construction and _markStaticReady (found: ${blocking.join(' | ')})`);
  ok(/_bootSettled\.then\(async \(\) => \{[\s\S]*ensurePoisLoaded\(\)/.test(indexSrc),
    'POIs load from the post-boot queue');
}

// ── 4. GPS starts when the locate control is ready, not on map 'load' ──
// MapLibre's 'load' waits for every visible tile; spawns need a fix.
{
  const at = (needle) => indexSrc.indexOf(needle);
  const wrap = at('geolocate._finishSetupUI = (supported) => {');
  const add = at("map.addControl(geolocate, 'bottom-right');");
  ok(wrap > 0 && add > wrap, '_finishSetupUI is wrapped before the control is added');
  const start = sliceFn(indexSrc, 'function startGeolocate(');
  ok(/geolocate\.trigger\(\)/.test(start) && /_onSuccess/.test(start),
    'startGeolocate triggers the watch (with the saved-view guard)');
  const loadHandler = indexSrc.slice(indexSrc.indexOf("map.on('load', () => {\n    // Tappable-POI halo"));
  ok(/startGeolocate\(\);/.test(loadHandler.slice(0, 800)), "map 'load' keeps startGeolocate as a fallback");
}

// ── 4b. Off the first screen: extras scripts, schedule index ──────────
{
  ok(!/<script src="\/static\/extras[^"]*\.js"><\/script>/.test(indexSrc),
    'no extras script is a parser-blocking tag');
  const backup = sliceFn(indexSrc, 'async function buildBackupPayload(');
  ok(/await _loadDeferredScripts\(\)/.test(backup.slice(0, 400)),
    'buildBackupPayload loads the extras before reading their stores');
  const imp = sliceFn(indexSrc, 'async function importData(');
  ok(/await _loadDeferredScripts\(\)/.test(imp.slice(0, 600)),
    'importData loads the extras before merging into them');
  const loadHandler = indexSrc.slice(indexSrc.indexOf("map.on('load', async () => {"));
  ok(!/rebuildScheduleIndex\(\)/.test(loadHandler.slice(0, loadHandler.indexOf("map.on('styledata'"))),
    "the schedule index no longer runs inside map 'load'");
  const queue = indexSrc.slice(indexSrc.indexOf("_bootMark('iife:end');"));
  const order = ['_loadDeferredScripts()', 'ensurePoisLoaded()', 'rebuildScheduleIndex()']
    .map((n) => queue.indexOf(n));
  ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2],
    'post-boot queue: extras, then POIs, then the schedule index (it snaps stops to POIs)');
}

// ── 5. Capacitor variant counts: compact cells table persisted ────────
// The first sprite batch used to rebuild per-cell variant counts from
// the full cells.json object (~99 k keys) on every boot — ~0.9 s on a
// Pixel 4a. The first boot now stores a compact typed-array copy; later
// boots read that back and never touch cells.json for counts.
async function compactCellsTest() {
  const fdb = require(path.join(root, 'static', 'anki', 'node_modules', 'fake-indexeddb'));
  const idbSrc = fs.readFileSync(path.join(root, 'static', 'idb-util.js'), 'utf8');
  const spritesSrc = fs.readFileSync(path.join(root, 'static', 'sprites.js'), 'utf8');
  const cells = { '1-2': [0, 3, 5], '7-9': [1], '300-12': [2, 4], '45-45': [] };
  const factory = new fdb.IDBFactory();
  let cellsFetches = 0;
  const launch = () => {
    const ctx = {
      console: { log() {}, warn() {}, error() {} },
      setTimeout, clearTimeout, Blob, URL, Response, performance, DOMException,
      Uint8Array, Uint16Array, Uint32Array, Array, Object,
      indexedDB: factory,
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      document: { addEventListener() {}, visibilityState: 'visible' },
      addEventListener() {},
      Capacitor: {},
      fetch: async (url) => {
        if (/cells\.json/.test(String(url))) {
          cellsFetches++;
          return new Response(JSON.stringify(cells), { status: 200 });
        }
        return new Response(null, { status: 404 });
      },
    };
    vm.createContext(ctx);
    ctx.window = ctx;
    vm.runInContext(idbSrc, ctx);
    vm.runInContext(spritesSrc, ctx);
    return ctx;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const counts = async (ctx) => {
    const m = await ctx.Sprites.getCellVariantCountsBatch([[1, 2], [7, 9], [300, 12]]);
    return [m.get('1-2'), m.get('7-9'), m.get('300-12')].join(',');
  };

  const first = launch();
  ok(await counts(first) === '3,1,2', 'first boot: counts derived from cells.json');
  ok(cellsFetches === 1, `first boot reads cells.json once (got ${cellsFetches})`);
  ok(first._spriteDiag.variantSource === 'compact-built',
    `first boot builds the compact table (got ${first._spriteDiag.variantSource})`);
  ok(await first.Sprites.getCellVariantCount(300, 12) === 2, 'single lookup agrees');
  await sleep(50);  // the background varPut lands

  const second = launch();
  ok(await counts(second) === '3,1,2', 'second boot: same counts');
  ok(cellsFetches === 1, `second boot never re-reads cells.json (fetches: ${cellsFetches})`);
  ok(second._spriteDiag.variantSource === 'compact-idb',
    `second boot reads the stored compact table (got ${second._spriteDiag.variantSource})`);
  const miss = await second.Sprites.getCellVariantCountsBatch([[2, 2]]);
  ok(miss.get('2-2') === 0, 'a cell absent from cells.json still counts 0');
}

compactCellsTest().catch((e) => { failed++; console.error('FAIL: compact cells test threw', e); })
  .then(() => {
    console.log(`startup-path: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
