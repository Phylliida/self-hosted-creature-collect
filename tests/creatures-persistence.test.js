// Integration test: the REAL creatures.js collection persistence code
// (the CSTORE block, _capStore, _seenStore, writeSeenFusions), extracted
// and run against fake-indexeddb + a Map-backed localStorage with the real
// idb-util.js / collection-store.js loaded first — like index.html does.
//
// Reproduces the Oct-2026 lost-catches bug end to end: iOS closes the
// IndexedDB connection while the app is suspended; the player keeps
// catching; the app is later killed. Before the fix every one of those
// catches was gone on relaunch.
//
// Run: node tests/creatures-persistence.test.js
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
const src = fs.readFileSync(path.join(root, 'static', 'creatures.js'), 'utf8');

function between(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error('marker not found: ' + (a < 0 ? startMarker : endMarker));
  return src.slice(a, b);
}
function sliceFn(marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced: ' + marker);
}
const segPersist = between('  // ── Collection store: IndexedDB + write-ahead journal',
                           '  // ── Inventory + pokédex performance metrics');
const segCap = between('  const _capStore = (() => {', "  if (typeof window !== 'undefined') window._capStore");
const segSeen = between('  const _seenStore = (() => {', "  if (typeof window !== 'undefined') window._seenStore");
const segWriteSeen = sliceFn('function writeSeenFusions(map, key)');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeLs() {
  const m = new Map();
  return {
    _m: m,
    get length() { return m.size; },
    key(i) { return Array.from(m.keys())[i] ?? null; },
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
  };
}
function makeDevice() { return { factory: new fdb.IDBFactory(), ls: makeLs() }; }

// One app launch. opts.breakReads: every indexedDB.open throws (degraded).
function launch(dev, opts = {}) {
  const openDbs = [];
  const idb = {
    open(...a) {
      if (opts.breakReads) throw new Error('storage unavailable');
      const req = dev.factory.open(...a);
      const prev = req.onsuccess;
      req.addEventListener('success', () => openDbs.push(req.result));
      void prev;
      return req;
    },
  };
  const body = { children: [], appendChild(el) { this.children.push(el); } };
  const listeners = {};
  const document = {
    body,
    visibilityState: 'visible',
    addEventListener: (t, cb) => { (listeners[t] = listeners[t] || []).push(cb); },
    getElementById: (id) => body.children.find((c) => c.id === id) || null,
    createElement: () => ({
      style: {}, setAttribute() {}, addEventListener() {}, appendChild() {}, remove() {},
    }),
  };
  const errs = [];
  const ctx = {
    indexedDB: idb, localStorage: dev.ls, document,
    setTimeout, clearTimeout, DOMException, console, performance, Date,
    errs,
  };
  // Like a browser: window IS the global object.
  ctx.addEventListener = (t, cb) => { (listeners[t] = listeners[t] || []).push(cb); };
  vm.createContext(ctx);
  ctx.window = ctx;
  if (!opts.noHelpers) {
    vm.runInContext(idbSrc, ctx);
    vm.runInContext(csSrc, ctx);
  }
  vm.runInContext(`
    const global = this;
    const CAPTURED_KEY = 'cc.capturedCreatures';
    const SEEN_FUSIONS_KEY = 'cc.seenFusions';
    function _logCreatureError(where, e) { errs.push(where + ': ' + (e && e.message)); }
    function _perfMark() {}
    ${sliceFn('function isSoloCreature(')}
    const _invPerf = { fn: new Proxy({}, { get: () => ({}) }) };
    ${segPersist}
    ${segCap}
    ${segSeen}
    ${segWriteSeen}
    _hydrateCStore();
    this.api = {
      cap: _capStore, seen: _seenStore, whenReady: _whenReady,
      writeSeenFusions, status: persistenceStatus,
      persist: () => _cstorePersistInst,
    };
  `, ctx);
  const fire = (t) => (listeners[t] || []).forEach((cb) => cb());
  return { ctx, api: ctx.api, openDbs, errs, body, document, fire };
}

function readIdb(factory, key) {
  return new Promise((resolve, reject) => {
    const req = factory.open('creature-collection-v1');
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => {
      const db = req.result;
      const g = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      g.onsuccess = () => { db.close(); resolve(g.result); };
      g.onerror = () => { db.close(); reject(g.error); };
    };
    req.onerror = () => reject(req.error);
  });
}
const mkCatch = (id, a = 1, b = 4) => ({ id, speciesA: a, speciesB: b, variant: 0, level: 5,
  caughtAt: { timestamp: 1 } });

(async () => {
  // ── fresh device: catch, flush, relaunch ───────────────────────────
  const dev = makeDevice();
  let app = launch(dev);
  await app.api.whenReady();
  ok(app.api.status().hydrated && !app.api.status().degraded,
     'fresh device hydrates (not degraded) ' + JSON.stringify(app.api.status()) + ' ' + app.errs.join('; '));
  app.api.cap.add(mkCatch('c1'));
  ok(Array.from(dev.ls._m.keys()).some((k) => k.startsWith('cc.cjournal.v1.')),
     'a catch is journaled to localStorage immediately');
  ok(await app.api.persist().flush(), 'checkpoint succeeds');
  const blob = await readIdb(dev.factory, 'captured');
  ok(Array.isArray(blob) && blob.length === 1 && blob[0].id === 'c1',
     'blob format unchanged: plain array at kv/"captured" (old builds can read it)');

  // ── THE BUG: connection dropped, keep catching, app killed ─────────
  for (const db of app.openDbs) db.close();  // iOS drops every connection
  for (let i = 2; i <= 7; i++) app.api.cap.add(mkCatch('c' + i));
  // Kill the app before any checkpoint lands (no flush, no lifecycle).
  app.api.persist().stop();
  app = launch(dev);
  await app.api.whenReady();
  const ids = app.api.cap.list().map((c) => c.id).join(',');
  ok(ids === 'c1,c2,c3,c4,c5,c6,c7', 'all 6 catches after the dropped connection survive a relaunch (' + ids + ')');

  // ── dropped connection mid-session: the next checkpoint reconnects ──
  for (const db of app.openDbs) db.close();
  app.api.cap.add(mkCatch('c8'));
  ok(await app.api.persist().flush(), 'checkpoint after a dropped connection re-opens and succeeds');
  ok((await readIdb(dev.factory, 'captured')).length === 8, 'IndexedDB has all 8 after the reconnect');
  ok(app.errs.filter((e) => /cstore/.test(e)).length === 0,
     'no cstore errors logged (the stale connection was retried transparently)');

  // ── granular ops: evolution (replaceById), tags (update), seen key ──
  const evolved = Object.assign({}, app.api.cap.byId('c3'), { speciesA: 2, speciesB: 5, name: 'X' });
  ok(app.api.cap.replaceById('c3', evolved) === true, 'replaceById swaps in the evolved record');
  app.api.cap.update('c4', (c) => { c.tags = ['fav']; });
  const seen = app.api.seen.get();
  seen['2-5'] = { firstSeen: 7, variants: { '0': 7 } };
  app.api.writeSeenFusions(seen, '2-5');
  app.api.cap.removeById('c5');
  // Relaunch without a checkpoint — everything must replay.
  app.api.persist().stop();
  app = launch(dev);
  await app.api.whenReady();
  ok(app.api.cap.byId('c3') && app.api.cap.byId('c3').speciesA === 2, 'evolution replays');
  ok(JSON.stringify(app.api.cap.byId('c4').tags) === '["fav"]', 'tag toggle replays');
  ok(!app.api.cap.byId('c5'), 'release (removeById) replays');
  ok(app.api.seen.get()['2-5'] && app.api.seen.get()['2-5'].firstSeen === 7, 'seen-mark (commitKey) replays');
  ok(app.api.cap.ownsFusion(2, 5), 'indices rebuilt from the replayed list');

  // ── bulk write (replaceAll) checkpoints immediately ────────────────
  const before = await readIdb(dev.factory, 'captured');
  app.api.cap.replaceAll(app.api.cap.list().slice(0, 2));
  await sleep(80);
  const after = await readIdb(dev.factory, 'captured');
  ok(after.length === 2 && before.length !== 2, 'replaceAll (bulk) checkpoints right away');

  // ── degraded launch: unreadable storage ────────────────────────────
  const dev2 = makeDevice();
  let a2 = launch(dev2);
  await a2.api.whenReady();
  for (let i = 0; i < 4; i++) a2.api.cap.add(mkCatch('r' + i));
  const s2 = a2.api.seen.get(); s2['9-9'] = { firstSeen: 1, variants: { auto: 1, '3': 2 } };
  a2.api.writeSeenFusions(s2, '9-9');
  await a2.api.persist().flush();
  a2 = launch(dev2, { breakReads: true });
  await a2.api.whenReady();
  ok(a2.api.status().degraded, 'unreadable storage → degraded');
  ok(a2.body.children.some((el) => el.id === 'ccStorageWarning'), 'degraded shows the storage warning banner');
  a2.api.cap.add(mkCatch('new-in-degraded'));
  const s3 = a2.api.seen.get(); s3['9-9'] = { firstSeen: 99 };
  a2.api.writeSeenFusions(s3, '9-9');            // must NOT be journaled
  a2.api.cap.replaceAll([]);                      // must NOT be written
  await sleep(80);
  ok((await readIdb(dev2.factory, 'captured')).length === 4,
     'degraded session never overwrote the real collection (old code would have written [] / [1 item])');
  a2 = launch(dev2);
  await a2.api.whenReady();
  const ids2 = a2.api.cap.list().map((c) => c.id).join(',');
  ok(ids2 === 'r0,r1,r2,r3,new-in-degraded', 'recovery launch has the collection + the degraded-session catch (' + ids2 + ')');
  ok(a2.api.seen.get()['9-9'].variants['3'] === 2, 'degraded seen-mark did not clobber the real entry');

  // ── legacy localStorage migration still works ──────────────────────
  const dev3 = makeDevice();
  dev3.ls.setItem('cc.capturedCreatures', JSON.stringify([mkCatch('ls1'), mkCatch('ls2')]));
  dev3.ls.setItem('cc.seenFusions', JSON.stringify({ '1-4': { firstSeen: 3 } }));
  const a3 = launch(dev3);
  await a3.api.whenReady();
  ok(a3.api.cap.list().length === 2, 'legacy localStorage collection loaded');
  ok((await readIdb(dev3.factory, 'captured')).length === 2, 'migrated into IndexedDB');
  ok(dev3.ls.getItem('cc.capturedCreatures') === null, 'legacy LS key dropped after the migration checkpoint');
  ok(dev3.ls.getItem('cc.seenFusions') === null, 'legacy LS seen key dropped too');

  // ── app backgrounded → checkpoint ──────────────────────────────────
  const dev4 = makeDevice();
  const a4 = launch(dev4);
  await a4.api.whenReady();
  a4.api.cap.add(mkCatch('bg1'));
  a4.document.visibilityState = 'hidden';
  a4.fire('visibilitychange');
  await sleep(60);
  ok((await readIdb(dev4.factory, 'captured')).length === 1, 'going to the background checkpoints immediately');

  // ── helper scripts missing (failed to load) → loud, not silent ─────
  const dev5 = makeDevice();
  const a5 = launch(dev5, { noHelpers: true });
  await a5.api.whenReady();
  ok(a5.body.children.some((el) => el.id === 'ccStorageWarning'),
     'missing storage helpers → warning banner (never a silent no-persist session)');
  ok(a5.errs.some((e) => /cstore\/init/.test(e)), 'missing helpers logged to the diagnostic error ring');
  ok(!a5.api.status().hydrated, 'missing helpers → stays un-hydrated (cannot overwrite anything)');

  console.log(`creatures-persistence: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
