// Behavioural tests for the collection persistence layer:
//   static/idb-util.js         (CCIdb — self-healing IndexedDB connections)
//   static/collection-store.js (journal + lazy checkpoints)
// run against fake-indexeddb with a Map-backed localStorage.
//
// The bug these guard against (Oct 2026, Grak's iPhone): iOS dropped the
// IndexedDB connection while the app was suspended; the cached connection
// then threw "The database connection is closing" on every write, so every
// catch made after the resume vanished on the next restart.
//
// Scenarios:
//   (1)  CCIdb.run re-opens a closed connection and retries once
//   (2)  CCIdb.opener forgets a failed open; open timeout
//   (3)  journal → checkpoint round trip; checkpoint prunes the journal
//   (4)  debounce: a burst of changes = one checkpoint
//   (5)  restart BEFORE a checkpoint: load + replay recovers everything
//   (6)  connection closed mid-session: next checkpoint re-opens
//   (7)  IndexedDB fully broken for a session: journal keeps every catch,
//        a later session with working IDB recovers them
//   (8)  load failure → degraded: no checkpoint may overwrite the real
//        collection; captured adds still journaled; bulk + seen refused
//   (9)  localStorage quota → falls back to immediate checkpoints
//   (10) change during an in-flight checkpoint stays dirty → second pass
//   (11) stop() (data wipe) — nothing is written afterwards
//   (12) old-format blob (no :seq key) loads; rollback union
//   (13) deletes replay correctly
//
// Run: node tests/collection-store.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const fdb = require(path.join(root, 'static', 'anki', 'node_modules', 'fake-indexeddb'));
const idbSrc = fs.readFileSync(path.join(root, 'static', 'idb-util.js'), 'utf8');
const csSrc = fs.readFileSync(path.join(root, 'static', 'collection-store.js'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeLs() {
  const m = new Map();
  let quota = Infinity;
  return {
    _m: m,
    setQuota(n) { quota = n; },
    get length() { return m.size; },
    key(i) { return Array.from(m.keys())[i] ?? null; },
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) {
      if (m.size >= quota && !m.has(k)) {
        const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e;
      }
      m.set(k, String(v));
    },
    removeItem(k) { m.delete(k); },
  };
}

// A "device": one IDB factory + one localStorage, shared across "app
// launches" (fresh vm contexts) to model restarts.
function makeDevice() { return { factory: new fdb.IDBFactory(), ls: makeLs() }; }

// One app launch: fresh module instances bound to the device's storage.
function launch(dev, opts = {}) {
  const ctx = {
    indexedDB: opts.indexedDB || dev.factory,
    setTimeout, clearTimeout, DOMException, console, Date, Promise, Error, Map,
  };
  vm.createContext(ctx);
  vm.runInContext(idbSrc, ctx);
  vm.runInContext(csSrc, ctx);
  const CCIdb = ctx.CCIdb;
  const getDb = CCIdb.opener('coll', 1, (db) => {
    if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
  }, { timeoutMs: opts.timeoutMs || 2000 });
  const mem = { captured: [], seen: {} };
  const logs = [];
  const persist = ctx.CollectionStore.create({
    getDb: opts.getDb || getDb,
    run: CCIdb.run, txDone: CCIdb.txDone,
    storeName: 'kv',
    localStorage: dev.ls,
    journalPrefix: 'cj.',
    stores: {
      captured: { key: 'captured', kind: 'list', idField: 'id',
                  snapshot: () => mem.captured, journalWhenDegraded: true },
      seenFusions: { key: 'seenFusions', kind: 'map', snapshot: () => mem.seen },
    },
    log: (where, e) => logs.push(where + ': ' + (e && e.message)),
    debounceMs: opts.debounceMs ?? 40,
    maxWaitMs: opts.maxWaitMs ?? 400,
    maxJournal: opts.maxJournal ?? 300,
    retryBaseMs: 20, retryMaxMs: 80,
    loadAttempts: 2, loadRetryMs: 10,
    ioTimeoutMs: opts.ioTimeoutMs ?? 5000,
  });
  return { ctx, CCIdb, getDb, persist, mem, logs };
}

// Hydrate like creatures.js does: load, replay, ready.
async function hydrate(app) {
  const r = await app.persist.load();
  app.mem.captured = app.persist.applyJournal('captured',
    Array.isArray(r.blobs.captured) ? r.blobs.captured : []);
  app.mem.seen = app.persist.applyJournal('seenFusions',
    (r.blobs.seenFusions && typeof r.blobs.seenFusions === 'object') ? r.blobs.seenFusions : {});
  app.persist.ready();
  return r;
}

function catchOne(app, id, extra) {
  const c = Object.assign({ id, speciesA: 1, speciesB: 4 }, extra || {});
  app.mem.captured.push(c);
  app.persist.journalPut('captured', id, c);
  return c;
}

// Raw read of what's ACTUALLY in IndexedDB (independent of the module).
function readIdb(factory, key) {
  return new Promise((resolve, reject) => {
    const req = factory.open('coll');
    req.onupgradeneeded = () => { req.result.createObjectStore('kv'); };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) { db.close(); resolve(undefined); return; }
      const g = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      g.onsuccess = () => { db.close(); resolve(g.result); };
      g.onerror = () => { db.close(); reject(g.error); };
    };
    req.onerror = () => reject(req.error);
  });
}
function writeIdb(factory, key, value) {
  return new Promise((resolve, reject) => {
    const req = factory.open('coll', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('kv'); };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  });
}
const journalKeys = (ls) => Array.from(ls._m.keys()).filter((k) => /^cj\.\d+$/.test(k));

(async () => {
  // ── (1) CCIdb.run re-opens a closed connection ─────────────────────
  {
    const dev = makeDevice();
    const app = launch(dev);
    const db1 = await app.getDb();
    db1.close();  // model iOS closing it: transaction() now throws InvalidStateError
    let threw = null;
    try { db1.transaction('kv', 'readonly'); } catch (e) { threw = e; }
    ok(threw && app.CCIdb.isStaleConnectionError(threw),
       'closed connection throws a stale-connection error (InvalidStateError)');
    const v = await app.CCIdb.run(app.getDb, (db) => new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put('hello', 'k');
      tx.oncomplete = () => resolve('done');
      tx.onerror = () => reject(tx.error);
    }));
    ok(v === 'done', 'CCIdb.run retried on a fresh connection and succeeded');
    const db2 = await app.getDb();
    ok(db2 !== db1, 'a new connection replaced the dead one');
    ok(app.CCIdb.stats().coll.staleRetries === 1, 'stale retry counted in stats');
    ok(await readIdb(dev.factory, 'k') === 'hello', 'the retried write landed');
    // Non-stale errors are NOT retried.
    let calls = 0;
    try {
      await app.CCIdb.run(app.getDb, async () => { calls++; throw new TypeError('boom'); });
    } catch (_) {}
    ok(calls === 1, 'non-stale errors propagate without a retry');
  }

  // ── (2) failed opens aren't cached; open timeout ───────────────────
  {
    let fail = true;
    const realFactory = new fdb.IDBFactory();
    const flaky = { open: (...a) => { if (fail) throw new Error('open broke'); return realFactory.open(...a); } };
    const dev = makeDevice();
    const app = launch(dev, { indexedDB: flaky });
    let e1 = null;
    try { await app.getDb(); } catch (e) { e1 = e; }
    ok(e1 && /open broke/.test(e1.message), 'open failure rejects');
    fail = false;
    const db = await app.getDb();
    ok(!!db, 'next getDb() retries the open instead of returning the cached failure');

    const hanging = { open: () => ({}) };  // request that never settles
    const app2 = launch(makeDevice(), { indexedDB: hanging, timeoutMs: 30 });
    let e2 = null;
    try { await app2.getDb(); } catch (e) { e2 = e; }
    ok(e2 && e2.name === 'TimeoutError', 'a never-settling open times out');
    ok(app2.CCIdb.stats().coll.openTimeouts === 1, 'timeout counted in stats');
  }

  // ── (3) journal → checkpoint round trip ─────────────────────────────
  {
    const dev = makeDevice();
    const app = launch(dev);
    const r = await hydrate(app);
    ok(r.ok, 'fresh device loads ok');
    catchOne(app, 'c1');
    ok(journalKeys(dev.ls).length === 1, 'a catch writes one journal entry');
    ok(await readIdb(dev.factory, 'captured') === undefined, 'catch does NOT write the big blob immediately');
    ok(await app.persist.flush(), 'explicit flush succeeds');
    const blob = await readIdb(dev.factory, 'captured');
    ok(Array.isArray(blob) && blob.length === 1 && blob[0].id === 'c1', 'checkpoint wrote the blob');
    ok(typeof await readIdb(dev.factory, 'captured:seq') === 'number', 'checkpoint wrote the covering seq');
    ok(journalKeys(dev.ls).length === 0, 'checkpoint pruned the covered journal entry');
    ok(app.persist.isClean('captured'), 'store is clean after checkpoint');
  }

  // ── (4) debounce: burst → single checkpoint ────────────────────────
  {
    const dev = makeDevice();
    const app = launch(dev, { debounceMs: 60 });
    await hydrate(app);
    let puts = 0;
    const origOpener = app.getDb;
    for (let i = 0; i < 5; i++) { catchOne(app, 'b' + i); await sleep(10); }
    ok(await readIdb(dev.factory, 'captured') === undefined, 'no checkpoint during the burst');
    await sleep(150);
    const blob = await readIdb(dev.factory, 'captured');
    ok(Array.isArray(blob) && blob.length === 5, 'one debounced checkpoint after the burst has all 5');
    ok(journalKeys(dev.ls).length === 0, 'journal pruned after the debounced checkpoint');
    void puts; void origOpener;
  }

  // ── (5) restart before checkpoint: replay recovers ──────────────────
  {
    const dev = makeDevice();
    let app = launch(dev, { debounceMs: 10000 });
    await hydrate(app);
    catchOne(app, 'x1'); await app.persist.flush();
    catchOne(app, 'x2');
    app.mem.seen['1-4'] = { firstSeen: 1, variants: { auto: 1 } };
    app.persist.journalPut('seenFusions', '1-4', app.mem.seen['1-4']);
    // "Kill the app" — no flush. New launch on the same device.
    app = launch(dev);
    await hydrate(app);
    ok(app.mem.captured.map((c) => c.id).join(',') === 'x1,x2', 'restart replays the un-checkpointed catch');
    ok(app.mem.seen['1-4'] && app.mem.seen['1-4'].firstSeen === 1, 'restart replays the seen-mark');
    ok(app.persist.status().lastReplay.captured === 1, 'exactly the 1 newer entry was replayed (x1 was checkpointed)');
    await app.persist.flush();
    ok(journalKeys(dev.ls).length === 0, 'replayed entries pruned once checkpointed');
  }

  // ── (6) connection closed mid-session → next checkpoint re-opens ────
  {
    const dev = makeDevice();
    const app = launch(dev, { debounceMs: 10000 });
    await hydrate(app);
    catchOne(app, 'a'); await app.persist.flush();
    (await app.getDb()).close();          // iOS drops the connection
    catchOne(app, 'b');
    ok(await app.persist.flush(), 'checkpoint after the drop succeeds (re-opened)');
    const blob = await readIdb(dev.factory, 'captured');
    ok(blob.length === 2, 'both catches in IndexedDB after the reconnect');
    ok(app.persist.status().failStreak === 0, 'no failures recorded');
  }

  // ── (7) IndexedDB broken all session → journal saves the day ────────
  {
    const dev = makeDevice();
    let app = launch(dev, { debounceMs: 10000 });
    await hydrate(app);
    catchOne(app, 'k0'); await app.persist.flush();
    // From here on every open AND every existing connection fails.
    (await app.getDb()).close();
    const broken = { open: () => { const e = new Error('Connection to Indexed Database server lost'); e.name = 'UnknownError'; throw e; } };
    app.ctx.indexedDB = broken;
    for (let i = 1; i <= 3; i++) catchOne(app, 'k' + i);
    ok(!(await app.persist.flush()), 'checkpoint fails while IndexedDB is broken');
    ok(app.persist.status().failStreak >= 1, 'failure streak recorded');
    ok(journalKeys(dev.ls).length === 3, 'all 3 catches are durable in the journal');
    await sleep(120);  // let a couple of backoff retries fail
    ok(journalKeys(dev.ls).length === 3, 'failed retries never drop journal entries');
    app.persist.stop();
    // Restart with working storage.
    app = launch(dev);
    await hydrate(app);
    ok(app.mem.captured.map((c) => c.id).join(',') === 'k0,k1,k2,k3',
       'next launch recovers every catch made while IndexedDB was broken');
  }

  // ── (8) load failure → degraded mode ────────────────────────────────
  {
    const dev = makeDevice();
    let app = launch(dev);
    await hydrate(app);
    for (let i = 0; i < 3; i++) catchOne(app, 'real' + i);
    app.mem.seen['2-2'] = { firstSeen: 5, variants: { auto: 5, '0': 6 } };
    app.persist.journalPut('seenFusions', '2-2', app.mem.seen['2-2']);
    await app.persist.flush();
    // Next launch can't READ IndexedDB.
    const readBroken = { open: () => { throw new Error('read broke'); } };
    app = launch(dev, { indexedDB: readBroken });
    const r = await hydrate(app);
    ok(!r.ok && app.persist.status().degraded, 'unreadable IndexedDB → degraded mode');
    ok(app.mem.captured.length === 0, 'degraded: in-memory collection is (partially) empty');
    ok(app.persist.journalPut('captured', 'new1', { id: 'new1' }) === true,
       'degraded: a new catch is still journaled');
    app.mem.captured.push({ id: 'new1' });
    ok(app.persist.journalPut('seenFusions', '2-2', { firstSeen: 99 }) === false,
       'degraded: seen-marks are refused (would clobber the real entry on replay)');
    ok(app.persist.markBulk('captured') === false, 'degraded: bulk writes are refused');
    ok(await app.persist.flush() === false, 'degraded: no checkpoint runs');
    const blob = await readIdb(dev.factory, 'captured');
    ok(blob.length === 3, 'degraded session never overwrote the real collection');
    // Recovery launch.
    app = launch(dev);
    await hydrate(app);
    ok(app.mem.captured.map((c) => c.id).join(',') === 'real0,real1,real2,new1',
       'recovery launch: real collection + the degraded-session catch');
    ok(app.mem.seen['2-2'].variants['0'] === 6, 'recovery launch: seen entry intact');
  }

  // ── (9) localStorage quota → immediate checkpoints ──────────────────
  {
    const dev = makeDevice();
    const app = launch(dev, { debounceMs: 10000 });
    await hydrate(app);
    dev.ls.setQuota(dev.ls.length);  // LS full: no new keys
    catchOne(app, 'q1');
    ok(app.persist.status().journalOk === false, 'quota error disables the journal');
    await sleep(30);
    const blob = await readIdb(dev.factory, 'captured');
    ok(Array.isArray(blob) && blob[0].id === 'q1', 'falls back to an immediate checkpoint (old behaviour)');
  }

  // ── (10) change during an in-flight checkpoint ──────────────────────
  {
    const dev = makeDevice();
    const app = launch(dev, { debounceMs: 30 });
    await hydrate(app);
    catchOne(app, 'f1');
    const p = app.persist.flush();
    catchOne(app, 'f2');  // lands while the write is in flight
    await p;
    ok(!app.persist.isClean('captured'), 'change during the write keeps the store dirty');
    ok(journalKeys(dev.ls).length === 1, 'only the covered entry was pruned');
    await sleep(120);
    const blob = await readIdb(dev.factory, 'captured');
    ok(blob.length === 2 && app.persist.isClean('captured'), 'a second pass checkpoints the late change');
  }

  // ── (11) stop(): nothing written afterwards ─────────────────────────
  {
    const dev = makeDevice();
    const app = launch(dev, { debounceMs: 20 });
    await hydrate(app);
    app.persist.stop();
    ok(app.persist.journalPut('captured', 'z', { id: 'z' }) === false, 'journal refused after stop');
    await sleep(60);
    ok(await readIdb(dev.factory, 'captured') === undefined, 'no checkpoint after stop');
    ok(journalKeys(dev.ls).length === 0, 'no journal entry after stop');
  }

  // ── (12) old-format blob + rollback union ───────────────────────────
  {
    const dev = makeDevice();
    // A pre-journal build wrote the blob with no :seq key.
    await writeIdb(dev.factory, 'captured', [{ id: 'legacy1' }, { id: 'legacy2' }]);
    let app = launch(dev, { debounceMs: 10000 });
    await hydrate(app);
    ok(app.mem.captured.length === 2, 'old-format blob (no :seq) loads');
    catchOne(app, 'n1'); await app.persist.flush();
    catchOne(app, 'n2');  // journaled, not checkpointed
    // Roll back to an old build: it reads the blob (has n1, lacks n2),
    // catches o1, and rewrites the blob without touching :seq/journal.
    const oldView = await readIdb(dev.factory, 'captured');
    oldView.push({ id: 'o1' });
    await writeIdb(dev.factory, 'captured', oldView);
    // Back on the new build.
    app = launch(dev);
    await hydrate(app);
    const idsNow = app.mem.captured.map((c) => c.id).sort().join(',');
    ok(idsNow === 'legacy1,legacy2,n1,n2,o1', 'rollback: old-build catch AND journaled catch both survive (' + idsNow + ')');
  }

  // ── (13) deletes replay ─────────────────────────────────────────────
  {
    const dev = makeDevice();
    let app = launch(dev, { debounceMs: 10000 });
    await hydrate(app);
    ['d1', 'd2', 'd3', 'd4'].forEach((id) => catchOne(app, id));
    await app.persist.flush();
    app.mem.captured = app.mem.captured.filter((c) => c.id !== 'd2');
    app.persist.journalDel('captured', 'd2');
    const d3 = app.mem.captured.find((c) => c.id === 'd3'); d3.level = 50;
    app.persist.journalPut('captured', 'd3', d3);
    app = launch(dev);
    await hydrate(app);
    ok(app.mem.captured.map((c) => c.id).join(',') === 'd1,d3,d4', 'delete replays (order preserved)');
    ok(app.mem.captured.find((c) => c.id === 'd3').level === 50, 'update after a delete replays onto the right record');
  }

  // ── (14) CCIdb drops cached connections after a long background ─────
  {
    const listeners = {};
    let fakeNow = 1e12;
    class FakeDate extends Date {}
    FakeDate.now = () => fakeNow;
    const document = {
      visibilityState: 'visible',
      addEventListener: (t, cb) => { listeners[t] = cb; },
    };
    const ctx = { indexedDB: new fdb.IDBFactory(), setTimeout, clearTimeout,
                  DOMException, console, Date: FakeDate, document };
    vm.createContext(ctx);
    vm.runInContext(idbSrc, ctx);
    const g = ctx.CCIdb.opener('r', 1, (db) => db.createObjectStore('kv'));
    const d1 = await g();
    const bg = (ms) => {
      document.visibilityState = 'hidden'; listeners.visibilitychange();
      fakeNow += ms;
      document.visibilityState = 'visible'; listeners.visibilitychange();
    };
    bg(3000);
    ok(await g() === d1, 'short trip to the background keeps the connection');
    bg(60000);
    const d2 = await g();
    ok(d2 !== d1, 'long background (likely suspension) drops the cached connection');
    ok(ctx.CCIdb.resumeInvalidations() === 1, 'resume invalidation counted');
    let threw = null;
    try { d1.transaction('kv', 'readonly'); } catch (e) { threw = e; }
    ok(threw && threw.name === 'InvalidStateError', 'the dropped connection was closed (not leaked)');
  }

  // ── (15) a blob read that never settles → degraded, not a hang ──────
  {
    const hungDb = { transaction: () => ({ objectStore: () => ({ get: () => ({}), put() {} }) }) };
    const dev = makeDevice();
    const app = launch(dev, { getDb: () => Promise.resolve(hungDb), ioTimeoutMs: 40 });
    const t0 = Date.now();
    const r = await app.persist.load();
    ok(!r.ok && app.persist.status().degraded, 'hung load read times out → degraded');
    ok(Date.now() - t0 < 2000, 'hydration did not hang');
  }

  // ── (16) a checkpoint write that never settles → retried, journal kept ─
  {
    const dev = makeDevice();
    let hang = false;
    const realApp = launch(dev);
    const hungDb = { transaction: () => ({ objectStore: () => ({ get: () => ({}), put() {} }) }) };
    const app = launch(dev, {
      getDb: () => (hang ? Promise.resolve(hungDb) : realApp.getDb()),
      ioTimeoutMs: 60, debounceMs: 10000,
    });
    await hydrate(app);
    hang = true;
    catchOne(app, 'h1');
    ok(await app.persist.flush() === false, 'hung checkpoint times out as a failure');
    ok(journalKeys(dev.ls).length === 1, 'journal entry kept while the write hangs');
    ok(app.persist.status().writing === false, 'writer not wedged after the timeout');
    hang = false;
    ok(await app.persist.flush() === true, 'next checkpoint succeeds once storage responds');
    ok(journalKeys(dev.ls).length === 0, 'journal pruned after the successful checkpoint');
  }

  // ── (17) two tabs share the journal counter ─────────────────────────
  {
    const dev = makeDevice();
    const tabA = launch(dev, { debounceMs: 10000 });
    const tabB = launch(dev, { debounceMs: 10000 });
    await hydrate(tabA); await hydrate(tabB);
    catchOne(tabA, 'ta1');
    catchOne(tabB, 'tb1');
    catchOne(tabA, 'ta2');
    ok(journalKeys(dev.ls).length === 3, 'interleaved tabs never overwrite each other\'s journal entries');
  }

  console.log(`collection-store: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
