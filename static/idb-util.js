// Shared IndexedDB connection helper: one cached connection per database
// that RE-OPENS itself when the browser closes it out from under us.
//
//   const getDb = CCIdb.opener('my-db', 1, (db, ev, req) => { ...upgrade... });
//   const value = await CCIdb.run(getDb, (db) => new Promise(...use db...));
//
// Why this exists: iOS suspends the app in the background and WebKit then
// drops the page's IndexedDB connections (the storage backend lives in a
// separate process that iOS is free to stop). Every opener in the app used
// to cache its IDBDatabase forever, so after such a resume every
// transaction threw "InvalidStateError: The database connection is
// closing" until the app was killed — which silently lost every catch made
// in that session (Oct 2026, Grak's iPhone). This helper:
//   - drops the cached connection when it fires 'close' (closed by the
//     browser) or 'versionchange' (another context wants to upgrade or
//     delete — we close so that can proceed instead of being blocked),
//   - CCIdb.run() retries an operation once on a fresh connection when it
//     fails with a stale-connection error,
//   - times out an open() that never settles (a known WebKit failure mode
//     after the storage process restarts) so the next call can try again,
//   - after the page has been hidden for RESUME_INVALIDATE_MS (an iOS
//     suspension), proactively drops EVERY cached connection so the next
//     use re-opens — covers call sites that don't go through run() and
//     cases where the browser never delivered a 'close' event,
//   - keeps per-database counters for the Settings diagnostic dump.
//
// Loaded before every script that touches IndexedDB (see index.html /
// extras.html). No dependencies.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';
  global._scriptVersions = global._scriptVersions || {};
  global._scriptVersions['idb-util.js'] = SCRIPT_VERSION;

  const DEFAULT_OPEN_TIMEOUT_MS = 15000;
  // Hidden at least this long → treat the return as a resume from
  // suspension and drop all cached connections (re-opened lazily).
  const RESUME_INVALIDATE_MS = 10000;
  // Every getDb() created by opener(), for invalidateAll().
  const _openers = new Set();

  // name -> counters. Read by stats() for the diagnostic dump.
  const _stats = new Map();
  function _stat(name) {
    let s = _stats.get(name);
    if (!s) {
      s = {
        opens: 0, closes: 0, versionChanges: 0, staleRetries: 0,
        openTimeouts: 0, openErrors: 0, blocked: 0,
        lastOpenAt: 0, lastCloseAt: 0, lastErrorAt: 0, lastError: null,
      };
      _stats.set(name, s);
    }
    return s;
  }
  function _noteError(s, e) {
    s.lastErrorAt = Date.now();
    s.lastError = String((e && (e.name ? e.name + ': ' : '') + (e.message || '')) || e).slice(0, 160);
  }

  // Errors that mean "this connection is dead — a fresh one may work":
  //   InvalidStateError  — db.transaction() on a closing/closed connection
  //                        ("The database connection is closing.")
  //   UnknownError       — WebKit's "Connection to Indexed Database server
  //                        lost. Refresh the page to try again."
  //   AbortError         — a transaction aborted because its connection
  //                        was force-closed mid-flight
  // Retrying once on a fresh connection is harmless for the others too:
  // every caller's operation is an idempotent get/put/delete.
  function isStaleConnectionError(e) {
    if (!e) return false;
    const name = e.name || '';
    if (name === 'InvalidStateError' || name === 'UnknownError'
        || name === 'AbortError') return true;
    return /connection is closing|server lost|connection.*(lost|closed)/i
      .test(String(e.message || ''));
  }

  // opener(name, version, onUpgrade, opts) → getDb()
  //
  // getDb() returns a Promise<IDBDatabase>, sharing one connection between
  // callers until it dies. onUpgrade(db, event, request) runs inside
  // onupgradeneeded (request.transaction is the versionchange tx).
  // version may be null/undefined to open the current version.
  // opts.timeoutMs overrides the open timeout.
  //
  // getDb.invalidate(db?) forgets (and closes) the cached connection —
  // only if it is still `db` when one is passed, so a late failure on an
  // old connection can't throw away a newer healthy one.
  function opener(name, version, onUpgrade, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || DEFAULT_OPEN_TIMEOUT_MS;
    const st = _stat(name);
    let cur = null;  // { promise, db }

    function getDb() {
      if (cur) return cur.promise;
      const entry = { promise: null, db: null };
      entry.promise = new Promise((resolve, reject) => {
        let settled = false;
        let req;
        try {
          req = (version == null) ? indexedDB.open(name) : indexedDB.open(name, version);
        } catch (e) {
          st.openErrors++; _noteError(st, e);
          reject(e);
          return;
        }
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          st.openTimeouts++;
          const e = new Error(`IndexedDB open timed out after ${timeoutMs}ms: ${name}`);
          e.name = 'TimeoutError';
          _noteError(st, e);
          reject(e);
        }, timeoutMs);
        req.onupgradeneeded = (ev) => {
          if (typeof onUpgrade === 'function') onUpgrade(req.result, ev, req);
        };
        req.onblocked = () => { st.blocked++; };
        req.onsuccess = () => {
          const db = req.result;
          if (settled) {
            // Succeeded after we gave up on it — don't leak the handle
            // (an open connection blocks future upgrades/deletes).
            try { db.close(); } catch (_) {}
            return;
          }
          settled = true;
          clearTimeout(timer);
          entry.db = db;
          db.onclose = () => {
            st.closes++;
            st.lastCloseAt = Date.now();
            if (cur === entry) cur = null;
          };
          db.onversionchange = () => {
            st.versionChanges++;
            try { db.close(); } catch (_) {}
            if (cur === entry) cur = null;
          };
          st.opens++;
          st.lastOpenAt = Date.now();
          resolve(db);
        };
        req.onerror = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          st.openErrors++;
          _noteError(st, req.error);
          reject(req.error);
        };
      });
      cur = entry;
      // A failed open must not be cached — the next call tries again.
      entry.promise.catch(() => { if (cur === entry) cur = null; });
      return entry.promise;
    }

    getDb.invalidate = function (db) {
      if (!cur) return;
      if (db && cur.db && cur.db !== db) return;
      const old = cur.db;
      cur = null;
      if (old) { try { old.close(); } catch (_) {} }
    };
    getDb.dbName = name;
    _openers.add(getDb);
    return getDb;
  }

  // Drop every cached connection (each re-opens on its next use).
  // In-flight transactions on a dropped connection still complete —
  // IDBDatabase.close() waits for them.
  let _resumeInvalidations = 0;
  function invalidateAll() {
    for (const g of _openers) {
      try { g.invalidate(); } catch (_) {}
    }
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt >= RESUME_INVALIDATE_MS) {
        _resumeInvalidations++;
        invalidateAll();
      }
      hiddenAt = 0;
    });
  }

  // run(getDb, fn) → fn(db)'s result, retried ONCE on a fresh connection if
  // it fails with a stale-connection error (thrown synchronously by
  // db.transaction() or rejected by the operation). fn must be safe to
  // re-run — true for get/put/delete. A non-stale error propagates as-is.
  async function run(getDb, fn) {
    const db = await getDb();
    try {
      return await fn(db);
    } catch (e) {
      if (!isStaleConnectionError(e)) throw e;
      const st = _stat(getDb.dbName || '?');
      st.staleRetries++;
      _noteError(st, e);
      if (typeof getDb.invalidate === 'function') getDb.invalidate(db);
      const db2 = await getDb();
      return await fn(db2);
    }
  }

  // Promise for a single IDBRequest's result.
  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Promise that settles when the transaction does. Rejects on error OR
  // abort — an abort with no error object (connection force-closed) gets a
  // synthetic AbortError so callers (and run()) can classify it.
  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      const fail = () => {
        const e = tx.error || (typeof DOMException === 'function'
          ? new DOMException('Transaction aborted', 'AbortError')
          : Object.assign(new Error('Transaction aborted'), { name: 'AbortError' }));
        reject(e);
      };
      tx.onerror = fail;
      tx.onabort = fail;
    });
  }

  // Snapshot of the per-database counters (plain objects, safe to log).
  function stats() {
    const out = {};
    for (const [name, s] of _stats) out[name] = Object.assign({}, s);
    Object.defineProperty(out, '_resumeInvalidations',
      { value: _resumeInvalidations, enumerable: false });
    return out;
  }
  function resumeInvalidations() { return _resumeInvalidations; }

  global.CCIdb = {
    opener, run, request, txDone, isStaleConnectionError,
    invalidateAll, stats, resumeInvalidations,
  };
})(typeof window !== 'undefined' ? window : globalThis);
