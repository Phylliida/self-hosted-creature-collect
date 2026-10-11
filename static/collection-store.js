// Durable persistence for the creature collection: a small write-ahead
// journal in localStorage + lazy checkpoints of the big IndexedDB blobs.
//
//   const persist = CollectionStore.create({ getDb, stores: {...}, ... });
//   const r = await persist.load();          // read blobs (+ checkpoint seqs)
//   list = persist.applyJournal('captured', r.blobs.captured || []);
//   ...
//   persist.journalPut('captured', c.id, c); // one record changed
//   persist.markBulk('captured');            // many records changed
//
// THE PROBLEM IT SOLVES. The collection is two big blobs in IndexedDB (the
// captured array — ~50k records / ~17 MB structured-clone for a big trainer
// — and the seenFusions map, ~5 MB). The old code rewrote BOTH blobs on
// every catch. That cost ~150 ms of serialisation plus a ~20 MB transfer to
// the storage process per catch, and when iOS dropped the IndexedDB
// connection during a background suspension, every write failed until the
// app was restarted — and the catches made in between were simply gone.
//
// HOW. Each single-record change (a catch, an evolution, a seen-mark) is
// appended to a localStorage journal as its own small key
// (`<prefix><seq>` → [storeId, 'p'|'d', key, value]). localStorage writes are
// synchronous and survived the iOS failure that killed IndexedDB. The big
// blobs are then written lazily as CHECKPOINTS (debounced, on app
// background, or when the journal grows), each tagged with the journal seq
// it covers (`<blobKey>:seq`). Loading = blob + replay of every journal
// entry newer than that blob's seq; a successful checkpoint prunes the
// entries it covers. Bulk changes (import, migrations) aren't journaled —
// they checkpoint immediately, exactly like before.
//
// STORAGE FORMAT IS UNCHANGED: the blobs stay at the same keys in the same
// object store, so an older build (e.g. a freshly installed bundle before
// its first live-update) still reads a collection that is at most one
// checkpoint behind — and when the new code returns, the journal entries
// it hasn't checkpointed yet are replayed back on top.
//
// FAILURE HANDLING.
//   - checkpoint fails → retried with backoff (1 s … 60 s), on foreground,
//     and on the next change; the journal keeps every change durable
//     meanwhile. Connections are re-opened via CCIdb (idb-util.js).
//   - load fails (couldn't READ the blobs) → retried; if it still fails we
//     enter DEGRADED mode: no checkpoint may run (it would overwrite the
//     real collection with the partial in-memory one), stores without
//     journalWhenDegraded refuse changes, and the caller is told so it can
//     warn the player. New catches are still journaled, so nothing is lost;
//     the next successful load folds them back in.
//   - the journal can't be written (localStorage quota) → every change
//     checkpoints immediately (the old behaviour) and status() says so.
//
// No dependencies besides an IndexedDB opener + runner (CCIdb); timers,
// clock and storage are injectable for tests.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';
  global._scriptVersions = global._scriptVersions || {};
  global._scriptVersions['collection-store.js'] = SCRIPT_VERSION;

  function create(cfg) {
    const getDb = cfg.getDb;
    const runOp = cfg.run || ((g, fn) => g().then(fn));
    const txDone = cfg.txDone;
    const storeName = cfg.storeName;
    const ls = cfg.localStorage;
    const prefix = cfg.journalPrefix;
    const log = cfg.log || (() => {});
    const now = cfg.now || (() => Date.now());
    const setT = cfg.setTimeout || ((f, ms) => setTimeout(f, ms));
    const clearT = cfg.clearTimeout || ((t) => clearTimeout(t));
    const debounceMs = cfg.debounceMs != null ? cfg.debounceMs : 30000;
    const maxWaitMs = cfg.maxWaitMs != null ? cfg.maxWaitMs : 120000;
    const maxJournal = cfg.maxJournal != null ? cfg.maxJournal : 300;
    const retryBaseMs = cfg.retryBaseMs != null ? cfg.retryBaseMs : 1000;
    const retryMaxMs = cfg.retryMaxMs != null ? cfg.retryMaxMs : 60000;
    const loadAttempts = cfg.loadAttempts != null ? cfg.loadAttempts : 3;
    const loadRetryMs = cfg.loadRetryMs != null ? cfg.loadRetryMs : 500;

    // storeId → { key, kind: 'list'|'map', idField, snapshot(),
    //             journalWhenDegraded, version, ckptVersion, ckptSeq,
    //             firstDirtyAt }
    const stores = {};
    for (const id of Object.keys(cfg.stores)) {
      const s = cfg.stores[id];
      stores[id] = {
        key: s.key,
        kind: s.kind === 'map' ? 'map' : 'list',
        idField: s.idField || 'id',
        snapshot: s.snapshot,
        journalWhenDegraded: !!s.journalWhenDegraded,
        version: 0, ckptVersion: 0, ckptSeq: 0, firstDirtyAt: 0,
      };
    }
    const ids = Object.keys(stores);
    const NEXT_KEY = prefix + 'next';

    let enabled = false;   // checkpoints allowed (load succeeded)
    let degraded = false;  // load failed — see header
    let stopped = false;   // stop() — data is being wiped
    let journalOk = true;
    let nextSeq = 1;
    const journalIdx = new Map();  // seq → storeId (entries still in LS)
    // Two timers: the debounce timer (reset by every journaled change, so
    // a burst of catches checkpoints once) and the flush timer (explicit
    // requests — bulk changes, retries, foreground — earliest one wins).
    let debounceTimer = null;
    let flushTimer = null, flushAt = 0;
    let writing = null;            // in-flight checkpoint promise
    let failStreak = 0, lastOkAt = 0, lastErr = null, lastErrAt = 0;
    let loadErr = null;

    // ── journal (localStorage) ──────────────────────────────────────
    function _scanJournal() {
      const out = [];
      let n;
      try { n = ls.length; } catch (_) { return out; }
      for (let i = 0; i < n; i++) {
        let k;
        try { k = ls.key(i); } catch (_) { continue; }
        if (!k || k.indexOf(prefix) !== 0 || k === NEXT_KEY) continue;
        const seq = Number(k.slice(prefix.length));
        if (!Number.isInteger(seq) || seq <= 0) continue;
        let rec = null;
        try { rec = JSON.parse(ls.getItem(k)); } catch (_) { rec = null; }
        if (!Array.isArray(rec) || !stores[rec[0]]) {
          // Unreadable / unknown-store entry — drop it so it can't pile up.
          try { ls.removeItem(k); } catch (_) {}
          continue;
        }
        out.push({ seq, store: rec[0], op: rec[1], key: rec[2], value: rec[3] });
      }
      out.sort((a, b) => a.seq - b.seq);
      return out;
    }
    function _removeEntry(seq) {
      try { ls.removeItem(prefix + seq); } catch (_) {}
      journalIdx.delete(seq);
    }
    function _pruneJournal() {
      for (const [seq, storeId] of Array.from(journalIdx)) {
        if (seq <= stores[storeId].ckptSeq) _removeEntry(seq);
      }
    }

    // ── load ────────────────────────────────────────────────────────
    function _readBlobs(db) {
      const tx = db.transaction(storeName, 'readonly');
      const os = tx.objectStore(storeName);
      const reqs = {};
      for (const id of ids) {
        reqs[id] = { blob: os.get(stores[id].key), seq: os.get(stores[id].key + ':seq') };
      }
      return txDone(tx).then(() => {
        const blobs = {}, seqs = {};
        for (const id of ids) {
          blobs[id] = reqs[id].blob.result;
          const s = reqs[id].seq.result;
          seqs[id] = (typeof s === 'number' && s > 0) ? s : 0;
        }
        return { blobs, seqs };
      });
    }
    function _sleep(ms) { return new Promise((r) => setT(r, ms)); }

    // Read both blobs and their checkpoint seqs. Resolves
    //   { ok: true, blobs: { id: value|undefined } }
    // or, after loadAttempts failed reads, enters degraded mode and resolves
    //   { ok: false, error, blobs: {} }
    // Never rejects. Call applyJournal() per store afterwards, then ready().
    async function load() {
      let err = null;
      for (let attempt = 0; attempt < loadAttempts; attempt++) {
        if (attempt) await _sleep(loadRetryMs * attempt);
        try {
          const r = await runOp(getDb, _readBlobs);
          for (const id of ids) {
            const st = stores[id];
            st.ckptSeq = r.seqs[id];
            // The caller rebuilds memory from blob + journal: that state
            // is the new clean baseline (a reload after degraded mode
            // must not keep the degraded session's dirty counters).
            st.ckptVersion = st.version;
            st.firstDirtyAt = 0;
          }
          degraded = false;
          loadErr = null;
          _initJournal();
          return { ok: true, blobs: r.blobs };
        } catch (e) {
          err = e;
          log('load', e);
        }
      }
      degraded = true;
      loadErr = err;
      _initJournal();
      return { ok: false, error: err, blobs: {} };
    }

    let _journalEntries = null;
    function _initJournal() {
      const entries = _scanJournal();
      journalIdx.clear();
      let maxSeq = 0;
      for (const e of entries) {
        journalIdx.set(e.seq, e.store);
        if (e.seq > maxSeq) maxSeq = e.seq;
      }
      let stored = 0;
      try { stored = Number(ls.getItem(NEXT_KEY)) || 0; } catch (_) {}
      let ckptMax = 0;
      for (const id of ids) ckptMax = Math.max(ckptMax, stores[id].ckptSeq);
      nextSeq = Math.max(nextSeq, stored, maxSeq + 1, ckptMax + 1);
      _journalEntries = entries;
      // Entries a checkpoint already covers are stale — drop them now
      // (only when we actually know the checkpoint seqs).
      if (!degraded) _pruneJournal();
    }

    // Replay this store's un-checkpointed journal entries onto `base` (the
    // blob from load(), or a migration/empty fallback) in seq order.
    // Mutates and returns base (a fresh []/{} if base is unusable). The
    // count applied is reported in status().lastReplay.
    function applyJournal(storeId, base) {
      const st = stores[storeId];
      const entries = (_journalEntries || []).filter(
        (e) => e.store === storeId && e.seq > st.ckptSeq);
      let applied = 0;
      if (st.kind === 'list') {
        const arr = Array.isArray(base) ? base : [];
        const idf = st.idField;
        const pos = new Map();
        const reindexFrom = (from) => {
          for (let i = from; i < arr.length; i++) {
            const r = arr[i];
            if (r && r[idf] != null) pos.set(r[idf], i);
          }
        };
        reindexFrom(0);
        for (const e of entries) {
          if (e.op === 'p') {
            if (!e.value || typeof e.value !== 'object') continue;
            const i = pos.get(e.key);
            if (i != null) arr[i] = e.value;
            else { pos.set(e.key, arr.length); arr.push(e.value); }
            applied++;
          } else if (e.op === 'd') {
            const j = pos.get(e.key);
            if (j != null) {
              arr.splice(j, 1);
              pos.delete(e.key);
              reindexFrom(j);  // deletes are rare; O(N) re-index is fine
            }
            applied++;
          }
        }
        if (applied) _noteChange(storeId);
        _lastReplay[storeId] = applied;
        return arr;
      }
      const obj = (base && typeof base === 'object' && !Array.isArray(base)) ? base : {};
      for (const e of entries) {
        if (e.op === 'p') { obj[e.key] = e.value; applied++; }
        else if (e.op === 'd') { delete obj[e.key]; applied++; }
      }
      if (applied) _noteChange(storeId);
      _lastReplay[storeId] = applied;
      return obj;
    }
    const _lastReplay = {};

    // Open the checkpoint gate after a successful load + replay. Anything
    // the replay (or a caller-side migration) marked dirty is checkpointed
    // on the normal schedule (journal-replayed changes are already durable).
    function ready() {
      _journalEntries = null;
      if (stopped || degraded) return;
      enabled = true;
      for (const id of ids) {
        if (stores[id].version !== stores[id].ckptVersion) _schedule(id, false);
      }
    }

    // ── mutation hooks ──────────────────────────────────────────────
    function _noteChange(storeId) {
      const st = stores[storeId];
      st.version++;
      if (!st.firstDirtyAt) st.firstDirtyAt = now();
    }
    function _journal(storeId, op, key, value) {
      if (stopped) return false;
      const st = stores[storeId];
      if (!st) throw new Error('unknown store ' + storeId);
      if (degraded && !st.journalWhenDegraded) return false;
      _noteChange(storeId);
      let journaled = false;
      if (journalOk) {
        const seq = nextSeq++;
        try {
          ls.setItem(prefix + seq, JSON.stringify(op === 'p'
            ? [storeId, op, key, value] : [storeId, op, key]));
          journalIdx.set(seq, storeId);
          journaled = true;
          try { ls.setItem(NEXT_KEY, String(nextSeq)); } catch (_) {}
        } catch (e) {
          journalOk = false;
          log('journal', e);
        }
      }
      if (!degraded) _schedule(storeId, !journaled);
      return true;
    }
    // One record changed (put = add or replace).
    function journalPut(storeId, key, value) { return _journal(storeId, 'p', key, value); }
    // One record removed.
    function journalDel(storeId, key) { return _journal(storeId, 'd', key); }
    // Many records changed (import, migration, legacy read-mutate-write):
    // not journaled — checkpoint as soon as possible. Refused while
    // degraded (returns false): the in-memory store isn't the real
    // collection then, so it must never be written over it.
    function markBulk(storeId) {
      if (stopped || degraded) return false;
      _noteChange(storeId);
      _schedule(storeId, true);
      return true;
    }

    // ── checkpoint scheduling ───────────────────────────────────────
    function _requestFlush(delay) {
      if (!enabled || stopped) return;
      const at = now() + Math.max(0, delay);
      if (flushTimer && flushAt <= at) return;  // an earlier one is set
      if (flushTimer) clearT(flushTimer);
      flushAt = at;
      flushTimer = setT(() => { flushTimer = null; flush(); }, Math.max(0, delay));
    }
    function _schedule(storeId, immediate) {
      if (!enabled || stopped) return;
      if (immediate) { _requestFlush(failStreak ? _retryDelay() : 0); return; }
      if (journalIdx.size >= maxJournal) {
        _requestFlush(failStreak ? _retryDelay() : 1000);
        return;
      }
      // Debounce: each journaled change pushes the checkpoint back, but
      // never past maxWaitMs after the first un-checkpointed change.
      const st = stores[storeId];
      const deadline = (st.firstDirtyAt || now()) + maxWaitMs;
      let delay = Math.min(debounceMs, Math.max(0, deadline - now()));
      if (failStreak) delay = Math.max(delay, _retryDelay());
      if (debounceTimer) clearT(debounceTimer);
      debounceTimer = setT(() => { debounceTimer = null; flush(); }, delay);
    }
    function _retryDelay() {
      return Math.min(retryMaxMs, retryBaseMs * Math.pow(2, Math.max(0, failStreak - 1)));
    }

    // Write every dirty store's blob (+ its covering seq) in ONE
    // transaction. Concurrent calls share the in-flight write and run one
    // more pass afterwards if anything changed meanwhile.
    function flush() {
      if (!enabled || stopped) return Promise.resolve(false);
      if (writing) {
        return writing.then(() => (_anyDirty() ? flush() : true));
      }
      const dirty = ids.filter((id) => stores[id].version !== stores[id].ckptVersion);
      if (!dirty.length) return Promise.resolve(true);
      if (flushTimer) { clearT(flushTimer); flushTimer = null; }
      if (debounceTimer) { clearT(debounceTimer); debounceTimer = null; }
      const snapSeq = nextSeq - 1;
      const snapVer = {};
      for (const id of dirty) snapVer[id] = stores[id].version;
      writing = (async () => {
        try {
          await runOp(getDb, (db) => {
            const tx = db.transaction(storeName, 'readwrite');
            const os = tx.objectStore(storeName);
            // put() structured-clones synchronously, so this captures the
            // in-memory state as of now; later changes bump `version` and
            // keep the store dirty for the next pass.
            for (const id of dirty) {
              os.put(stores[id].snapshot(), stores[id].key);
              os.put(snapSeq, stores[id].key + ':seq');
            }
            return txDone(tx);
          });
          for (const id of dirty) {
            const st = stores[id];
            st.ckptVersion = snapVer[id];
            if (snapSeq > st.ckptSeq) st.ckptSeq = snapSeq;
            st.firstDirtyAt = (st.version === st.ckptVersion) ? 0 : now();
          }
          _pruneJournal();
          failStreak = 0;
          lastOkAt = now();
          lastErr = null;
          return true;
        } catch (e) {
          failStreak++;
          lastErr = String((e && (e.name ? e.name + ': ' : '') + (e.message || '')) || e).slice(0, 160);
          lastErrAt = now();
          log('checkpoint', e);
          return false;
        } finally {
          writing = null;
        }
      })();
      return writing.then((okWrite) => {
        if (!okWrite) _requestFlush(_retryDelay());
        else if (_anyDirty()) {
          for (const id of ids) {
            if (stores[id].version !== stores[id].ckptVersion) _schedule(id, !journalOk);
          }
        }
        return okWrite;
      });
    }
    function _anyDirty() {
      return ids.some((id) => stores[id].version !== stores[id].ckptVersion);
    }

    // Lifecycle: checkpoint right away when the app is backgrounded (the
    // write may not finish before iOS suspends us — the journal covers
    // that), and retry soon after it comes back if anything is pending.
    function attachLifecycle(doc, win) {
      if (doc && doc.addEventListener) {
        doc.addEventListener('visibilitychange', () => {
          if (doc.visibilityState === 'hidden') flush();
          else if (_anyDirty()) _requestFlush(3000);
        });
      }
      if (win && win.addEventListener) {
        win.addEventListener('pagehide', () => { flush(); });
      }
    }

    // Data is about to be wiped: never write (or re-create the database)
    // again in this page.
    function stop() {
      stopped = true;
      enabled = false;
      if (flushTimer) { clearT(flushTimer); flushTimer = null; }
      if (debounceTimer) { clearT(debounceTimer); debounceTimer = null; }
    }

    function isClean(storeId) {
      return stores[storeId].version === stores[storeId].ckptVersion;
    }

    function status() {
      const dirty = ids.filter((id) => stores[id].version !== stores[id].ckptVersion);
      let oldestDirtyAt = 0;
      for (const id of dirty) {
        const t = stores[id].firstDirtyAt;
        if (t && (!oldestDirtyAt || t < oldestDirtyAt)) oldestDirtyAt = t;
      }
      return {
        enabled, degraded, stopped, journalOk,
        journalCount: journalIdx.size,
        dirty, oldestDirtyAt,
        failStreak, lastOkAt, lastErr, lastErrAt,
        loadError: loadErr ? String(loadErr.message || loadErr).slice(0, 160) : null,
        lastReplay: Object.assign({}, _lastReplay),
        writing: !!writing,
      };
    }

    return {
      load, applyJournal, ready,
      journalPut, journalDel, markBulk,
      flush, attachLifecycle, stop, isClean, status,
    };
  }

  global.CollectionStore = { create };
})(typeof window !== 'undefined' ? window : globalThis);
