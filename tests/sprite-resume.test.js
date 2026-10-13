// Stuck red dots after an iOS resume (Oct 2026, Grak's iPhone).
//
// After a resume, iOS has killed LocalServer's listen socket; for a few
// seconds every local fetch fails (the service worker answers 504) until
// the native health check restarts it. A marker sprite requested in that
// window used to go: sprite-pack fetch 504 → _loadPack returned null ("no
// pack") → fall back to cropping the sprite out of a bundled sheet → the
// downloaded HF pack ships no sprites/ dir, so once LocalServer is back the
// sheet answers 404 → classified 'missing' → SpriteStore cached null
// forever → a red dot until the app was restarted (and the same key blank
// in the inventory).
//
// (1) sprites.js getSpriteBlobAttempt against a mock LocalServer that
//     serves real Range requests over real pack binaries:
//     - pack 504 then sheet 404 (the race) → 'transient', not 'missing'
//     - pack fetch rejected (connection refused)  → 'transient'
//     - ranged cell read 504 with the index cached → 'transient'
//     - no pack for the partner + no sheet        → 'missing' (genuine)
//     - pack present, cell absent, no sheet       → 'missing' (genuine)
//     - healthy                                   → 'ok' with the right bytes
// (2) sprite-store.js SpriteStore.showSprite:
//     - transient failures retry (with backoff) until the sprite lands
//     - a 'missing' result is re-checked by retryMisses (resume path)
//     - a fetch that never settles times out and is retried
// (3) hangs below SpriteStore (Oct 2026, red dots for 20-30 s, then a
//     restart): a pack fetch that never settles must not pin that
//     partner's shared index load; the native variant table loads from
//     the bundled cells.json when IndexedDB is unusable and retries
//     (without caching a 0) when that fetch hangs; one hung sprite in a
//     preload doesn't hold back the others; addMarkersBatch doesn't wait
//     for the whole preload before showing markers.
//
// Run: node tests/sprite-resume.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const spritesSrc = fs.readFileSync(path.join(root, 'static', 'sprites.js'), 'utf8');
const storeSrc = fs.readFileSync(path.join(root, 'static', 'sprite-store.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pack format (generate_sprite_packs.py): 'CRPP' magic (BE u32), u32 LE
// cell count, then per cell (u32 a, i32 variant, u32 offset, u32 length),
// then the PNG payloads. variant -1 = autogen.
function buildPack(cells) {
  const header = 8 + cells.length * 16;
  const total = header + cells.reduce((s, c) => s + c.bytes.length, 0);
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x43525050, false);
  dv.setUint32(4, cells.length, true);
  let off = 0;
  cells.forEach((c, i) => {
    const o = 8 + i * 16;
    dv.setUint32(o, c.a, true);
    dv.setInt32(o + 4, c.variant, true);
    dv.setUint32(o + 8, off, true);
    dv.setUint32(o + 12, c.bytes.length, true);
    new Uint8Array(buf, header + off, c.bytes.length).set(c.bytes);
    off += c.bytes.length;
  });
  return new Uint8Array(buf);
}
const PNG_1_25 = Uint8Array.from([137, 80, 78, 71, 1, 25, 7, 7, 7]);

function makeServer() {
  const server = {
    packs: { 25: buildPack([{ a: 1, variant: -1, bytes: PNG_1_25 }]) },
    down: false,        // every request → SW synthetic 504
    refuse: false,      // every request → fetch rejects
    failNext: 0,        // next N requests → 504, then healthy
    hang: null,         // RegExp: matching requests never settle (once each)
    cells: '{}',
    log: [],
  };
  server.fetch = async (url, init) => {
    url = String(url);
    server.log.push(url);
    if (server.hang && server.hang.test(url)) {
      server.hang = null;
      return new Promise(() => {});   // ignores abort too — worst case
    }
    if (server.refuse) throw new TypeError('Load failed');
    if (server.down || server.failNext > 0) {
      if (server.failNext > 0) server.failNext--;
      return new Response(null, { status: 504, headers: { 'X-CC-SW': 'fetch-failed' } });
    }
    const m = url.match(/sprite-packs\/(\d+)\.pack/);
    if (m) {
      const pk = server.packs[m[1]];
      if (!pk) return new Response(null, { status: 404 });
      const range = init && init.headers && init.headers.Range;
      if (range) {
        const [, s, e] = range.match(/bytes=(\d+)-(\d+)/);
        return new Response(pk.slice(+s, Math.min(+e + 1, pk.length)), { status: 206 });
      }
      return new Response(pk, { status: 200 });
    }
    if (/\/sprites\//.test(url)) return new Response(null, { status: 404 });  // HF pack: no sheets
    if (/cells\.json/.test(url)) return new Response(server.cells, { status: 200 });
    if (/manifest\.json/.test(url)) return new Response('{}', { status: 200 });
    return new Response(null, { status: 404 });
  };
  return server;
}

// Short deadlines so the hang cases run fast.
const fastSpritesSrc = spritesSrc
  .replace(/const LOCAL_FETCH_TIMEOUT_MS = \d+;/, 'const LOCAL_FETCH_TIMEOUT_MS = 150;')
  .replace(/const IDB_READ_TIMEOUT_MS = \d+;/, 'const IDB_READ_TIMEOUT_MS = 150;')
  .replace(/const VARIANT_SUMMARY_RETRY_MS = \d+;/, 'const VARIANT_SUMMARY_RETRY_MS = 200;');

function loadSprites(server, src) {
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Blob, URL, Response, performance, AbortController,
    fetch: (...a) => server.fetch(...a),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Capacitor: {},
  };
  vm.createContext(ctx);
  ctx.window = ctx;
  vm.runInContext(src || spritesSrc, ctx);
  return ctx.Sprites;
}

(async () => {
  // ── (1) classification ─────────────────────────────────────────────
  {
    const server = makeServer();
    const S = loadSprites(server);

    server.failNext = 1;  // pack index → 504, then sheet → 404 (server back)
    let r = await S.getSpriteBlobAttempt(1, 25, null);
    ok(r.status === 'transient',
       `pack 504 + sheet 404 (LocalServer restart race) → transient (got ${r.status})`);

    server.refuse = true;
    r = await S.getSpriteBlobAttempt(1, 25, null);
    ok(r.status === 'transient', `pack fetch rejected → transient (got ${r.status})`);
    server.refuse = false;

    r = await S.getSpriteBlobAttempt(1, 25, null);
    ok(r.status === 'ok' && r.blob, 'healthy server → ok');
    const bytes = r.blob ? new Uint8Array(await r.blob.arrayBuffer()) : null;
    ok(bytes && bytes.length === PNG_1_25.length && bytes[5] === 25, 'ok blob carries the cell bytes');

    // Index is cached now (ranged mode); the per-cell read fails.
    server.failNext = 1;
    r = await S.getSpriteBlobAttempt(1, 25, null);
    ok(r.status === 'transient', `cached index + cell read 504 → transient (got ${r.status})`);
    r = await S.getSpriteBlobAttempt(1, 25, null);
    ok(r.status === 'ok', 'and recovers on the next attempt');

    r = await S.getSpriteBlobAttempt(1, 99, null);
    ok(r.status === 'missing', `no pack for partner + no sheet → missing (got ${r.status})`);

    r = await S.getSpriteBlobAttempt(2, 25, null);
    ok(r.status === 'missing', `pack present but lacks the cell + no sheet → missing (got ${r.status})`);

    // getSpriteBlobsBatch (the marker preload path) classifies the same way.
    // A blip can't be told apart from "no pack" until the server answers,
    // so it's transient; the retry then gets the real 404 → missing.
    server.failNext = 1;
    let batch = await S.getSpriteBlobsBatch([{ a: 1, b: 26, variant: null }]);
    ok(batch[0] && batch[0].status === 'transient', 'batch: blip on an unknown partner → transient');
    batch = await S.getSpriteBlobsBatch([{ a: 1, b: 26, variant: null }]);
    ok(batch[0] && batch[0].status === 'missing', 'batch: retry with the server up → genuine miss');
    server.packs[27] = buildPack([{ a: 1, variant: -1, bytes: PNG_1_25 }]);
    server.failNext = 1;
    const batch2 = await S.getSpriteBlobsBatch([{ a: 1, b: 27, variant: null }]);
    ok(batch2[0] && batch2[0].status === 'transient',
       `batch: pack blip → transient (got ${batch2[0] && batch2[0].status})`);
  }

  // ── (2) SpriteStore recovery ───────────────────────────────────────
  {
    // Shorten the attempt timeout so the hung-fetch case runs fast.
    const src = storeSrc.replace(/const ATTEMPT_TIMEOUT_MS = \d+;/, 'const ATTEMPT_TIMEOUT_MS = 150;');
    ok(src !== storeSrc, 'found ATTEMPT_TIMEOUT_MS to shorten for the test');
    const script = {};   // key → array of scripted results (consumed in order)
    let calls = 0;
    const ctx = {
      console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date,
      URL: { createObjectURL: (b) => 'blob:' + b.tag, revokeObjectURL() {} },
    };
    ctx.Sprites = {
      getSpriteBlobAttempt: (a, b) => {
        calls++;
        const q = script[`${a}-${b}`] || [];
        const next = q.length ? q.shift() : { status: 'ok', blob: { tag: `${a}-${b}` } };
        if (next === 'hang') return new Promise(() => {});
        return Promise.resolve(next);
      },
      getSpriteBlobsBatch: async () => [],
    };
    vm.createContext(ctx);
    ctx.window = ctx;
    vm.runInContext(src, ctx);
    const SS = ctx.SpriteStore;
    const img = () => ({ isConnected: true, src: '' });

    // transient ×2 → lands after retries
    script['3-4'] = [{ status: 'transient', blob: null }, { status: 'transient', blob: null }];
    const i1 = img();
    await SS.showSprite(i1, 3, 4, null);
    ok(i1.src === '' && SS.pendingRetryCount() === 1, 'transient → queued for retry, placeholder stays');
    await sleep(2200);
    ok(i1.src === 'blob:3-4', 'transient failures retry with backoff until the sprite lands');
    ok(SS.pendingRetryCount() === 0, 'retry entry cleared after success');

    // missing → re-checked on resume
    script['5-6'] = [{ status: 'missing', blob: null }];
    const i2 = img();
    await SS.showSprite(i2, 5, 6, null);
    ok(i2.src === '' && SS.stats().pendingMisses === 1, 'missing → placeholder, tracked for re-check');
    SS.retryMisses(true);   // what the resume handler does
    await sleep(20);
    ok(i2.src === 'blob:5-6', 'resume re-check drops the cached null and the sprite lands');
    ok(SS.stats().misses === 0, 'null cache entry gone');

    // hung fetch → times out → retried
    script['7-8'] = ['hang'];
    const i3 = img();
    const before = calls;
    SS.showSprite(i3, 7, 8, null);
    await sleep(1000);
    ok(i3.src === 'blob:7-8', 'a fetch that never settles times out and is retried');
    ok(calls - before >= 2, 'the hung attempt was followed by a fresh one');

    // detached img is dropped, not retried forever
    script['9-9'] = Array(50).fill({ status: 'transient', blob: null });
    const i4 = img();
    await SS.showSprite(i4, 9, 9, null);
    i4.isConnected = false;
    await sleep(700);
    ok(SS.pendingRetryCount() === 0, 'retry for a detached img is pruned');
  }


  // ── (3) hangs below SpriteStore ────────────────────────────────────
  {
    ok(fastSpritesSrc.includes('LOCAL_FETCH_TIMEOUT_MS = 150')
      && fastSpritesSrc.includes('IDB_READ_TIMEOUT_MS = 150')
      && fastSpritesSrc.includes('VARIANT_SUMMARY_RETRY_MS = 200'),
      '3: found the deadlines to shorten');
    const server = makeServer();
    server.packs[30] = buildPack([{ a: 1, variant: -1, bytes: PNG_1_25 }]);
    const S = loadSprites(server, fastSpritesSrc);

    // Pack index fetch never settles: the attempt fails on its own...
    server.hang = /sprite-packs\/30\.pack/;
    let t0 = Date.now();
    let r = await S.getSpriteBlobAttempt(1, 30, null);
    ok(r.status === 'transient', `3: hung pack index → transient (got ${r.status})`);
    ok(Date.now() - t0 < 1000, `3: …within the deadline (${Date.now() - t0} ms)`);
    // ...and the next attempt makes a FRESH request instead of getting
    // the stuck shared promise back (that pinned the partner until restart).
    r = await S.getSpriteBlobAttempt(1, 30, null);
    ok(r.status === 'ok', `3: next attempt recovers (got ${r.status})`);

    // Per-cell ranged read hangs (index already cached).
    server.packs[31] = buildPack([{ a: 1, variant: -1, bytes: PNG_1_25 }]);
    r = await S.getSpriteBlobAttempt(1, 31, null);   // caches the index
    server.hang = /sprite-packs\/31\.pack/;
    r = await S.getSpriteBlobAttempt(1, 31, null);
    ok(r.status === 'transient', `3: hung cell read → transient (got ${r.status})`);
    r = await S.getSpriteBlobAttempt(1, 31, null);
    ok(r.status === 'ok', '3: cell read recovers');
  }
  {
    // IndexedDB unusable (no CCIdb here → every open rejects): the
    // native variant table still loads, from the bundled cells.json.
    // Before, a failed open marked the load done with NO table, and
    // every spawn that session got autogen art.
    const server = makeServer();
    server.cells = JSON.stringify({ '1-25': [0, 1], '2-25': [0] });
    const S = loadSprites(server, fastSpritesSrc);
    ok(await S.getCellVariantCount(1, 25) === 2, '3: counts load from cells.json when IDB fails');
    ok(await S.getCellVariantCount(2, 25) === 1, '3: …for every cell');
    ok(await S.getCellVariantCount(3, 25) === 0, '3: a cell without custom art → 0');
  }
  {
    // cells.json fetch hangs once: counts are unknown for a moment
    // (answered 0, NOT cached), then the retry loads the real table.
    const server = makeServer();
    server.cells = JSON.stringify({ '1-25': [0, 1, 2] });
    server.hang = /cells\.json/;
    const S = loadSprites(server, fastSpritesSrc);
    const t0 = Date.now();
    const first = await S.getCellVariantCount(1, 25);
    ok(first === 0 && Date.now() - t0 < 1500,
      `3: hung cells.json → unknown answered promptly (${first}, ${Date.now() - t0} ms)`);
    await sleep(260);   // past VARIANT_SUMMARY_RETRY_MS
    ok(await S.getCellVariantCount(1, 25) === 3, '3: the retry loads the table; the 0 was not cached');
    const batch = await S.getCellVariantCountsBatch([[1, 25], [9, 25]]);
    ok(batch.get('1-25') === 3 && batch.get('9-25') === 0, '3: batch counts agree');
  }
  {
    // SpriteStore.preload: one hung entry doesn't hold back the rest.
    const ctx = {
      console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date,
      URL: { createObjectURL: (b) => 'blob:' + b.tag, revokeObjectURL() {} },
    };
    ctx.Sprites = {
      getSpriteBlobsEach: (reqs) => reqs.map((r) => (r.a === 3
        ? new Promise(() => {})
        : Promise.resolve({ status: 'ok', blob: { tag: `${r.a}-${r.b}` } }))),
      getSpriteBlobsBatch: () => new Promise(() => {}),
      getSpriteBlobAttempt: () => new Promise(() => {}),
    };
    vm.createContext(ctx);
    ctx.window = ctx;
    vm.runInContext(storeSrc, ctx);
    const SS = ctx.SpriteStore;
    SS.preload([{ a: 3, b: 4, variant: null }, { a: 5, b: 6, variant: null }]);
    const fast = { isConnected: true, src: '' };
    await Promise.race([SS.showSprite(fast, 5, 6, null), sleep(300)]);
    ok(fast.src === 'blob:5-6', '3: a ready sprite shows while another in the same preload hangs');
  }
  {
    const creaturesSrc = fs.readFileSync(path.join(root, 'static', 'creatures.js'), 'utf8');
    const i = creaturesSrc.indexOf('async function addMarkersBatch(');
    const body = creaturesSrc.slice(i, creaturesSrc.indexOf('\n  function removeMarker(', i));
    ok(i > 0 && body.includes('SpriteStore.preload(pairEntries)'), '3: found addMarkersBatch');
    ok(!/await\s+global\.SpriteStore\.preload/.test(body),
      '3: addMarkersBatch shows markers without waiting for the whole preload');
  }

  console.log(`sprite-resume: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
