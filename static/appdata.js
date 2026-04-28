// IndexedDB-backed store for app data (icons, fonts) — analogous to
// sprites.js but for the things MapLibre needs to render properly.
//
// Why move off the SW Cache: iOS PWA aggressively evicts SW Cache
// under storage pressure (and refresh paths can accidentally wipe
// chunks of it), which leaves users with a half-broken map until
// they re-download. IndexedDB on iOS is far more durable, especially
// once navigator.storage.persist() has been granted.
//
// Public API:
//   AppData.getIconBlob(name)               → Promise<Blob|null>
//   AppData.iconNames()                     → Promise<string[]>
//   AppData.iconBulkDownload(opts)          → Promise<{loaded,total,cancelled}>
//   AppData.preloadFontBlobUrls(stack)      → Promise<Map<url, objectUrl>>
//                                              also memoised in module state
//   AppData.fontBlobUrlFor(url)             → string | null  (sync lookup)
//   AppData.fontBulkDownload(stack, opts)   → Promise<{loaded,total,cancelled}>
//   AppData.getDownloadStatus()             → {icons, fonts}
//   AppData.deleteAll()                     → wipe both stores

(function (global) {
  'use strict';

  const DB_NAME = 'creature-appdata-v1';
  const DB_VERSION = 1;
  const STORE_ICONS = 'icons';
  const STORE_FONTS = 'fonts';

  let _dbPromise = null;
  function openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_ICONS)) db.createObjectStore(STORE_ICONS);
        if (!db.objectStoreNames.contains(STORE_FONTS)) db.createObjectStore(STORE_FONTS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }

  function _req(store, mode, fn) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const r = fn(tx.objectStore(store));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  }
  const iconGet  = (k)    => _req(STORE_ICONS, 'readonly',  (s) => s.get(k));
  const iconPut  = (k, v) => _req(STORE_ICONS, 'readwrite', (s) => s.put(v, k));
  const iconKeys = ()     => _req(STORE_ICONS, 'readonly',  (s) => s.getAllKeys());
  const fontGet  = (k)    => _req(STORE_FONTS, 'readonly',  (s) => s.get(k));
  const fontPut  = (k, v) => _req(STORE_FONTS, 'readwrite', (s) => s.put(v, k));
  const fontKeys = ()     => _req(STORE_FONTS, 'readonly',  (s) => s.getAllKeys());

  // --- Icons ---

  async function getIconBlob(name) {
    return iconGet(name);
  }

  // Memoised list-walk so concurrent map-init callers (loadAllIcons,
  // styleimagemissing) share one IDB cursor instead of fanning out.
  // Same pattern as sprites.js loadVariantCounts.
  let _iconNamesCache = null;
  let _iconNamesPromise = null;
  function iconNames() {
    if (_iconNamesCache) return Promise.resolve(_iconNamesCache);
    if (_iconNamesPromise) return _iconNamesPromise;
    _iconNamesPromise = (async () => {
      const ks = await iconKeys();
      _iconNamesCache = (ks || []).filter((k) => typeof k === 'string').sort();
      return _iconNamesCache;
    })();
    _iconNamesPromise.finally(() => { _iconNamesPromise = null; });
    return _iconNamesPromise;
  }

  // Bulk download every icon in /iconslist into IDB. opts: { signal,
  // onProgress({loaded, total}) }. Re-entrant: skips icons already in
  // IDB so a partial run resumes cheaply.
  async function iconBulkDownload(opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const signal = opts.signal;
    const headers = { 'X-Download': '1' };
    let listResp;
    try {
      listResp = await fetch('/iconslist', { headers });
    } catch { return { loaded: 0, total: 0, cancelled: false }; }
    if (!listResp.ok) return { loaded: 0, total: 0, cancelled: false };
    const { files = [] } = await listResp.json();
    const names = files.map((f) => f.replace(/\.svg$/, ''));
    const have = new Set(await iconKeys());
    let loaded = have.size;
    const total = names.length;
    onProgress({ loaded, total });
    for (const name of names) {
      if (signal && signal.aborted) return { loaded, total, cancelled: true };
      if (have.has(name)) continue;
      try {
        const r = await fetch(`/icons/${encodeURIComponent(name)}.svg`, { headers });
        if (!r.ok) continue;
        const blob = await r.blob();
        await iconPut(name, blob);
        have.add(name);
        loaded++;
        if (loaded % 5 === 0) onProgress({ loaded, total });
      } catch { /* keep going */ }
    }
    _iconNamesCache = null;  // force re-read on next iconNames()
    onProgress({ loaded, total });
    return { loaded, total, cancelled: false };
  }

  // --- Fonts ---
  //
  // Fonts live in IDB keyed `${stack}/${range}` (e.g.
  // "KlokanTech Noto Sans Regular/0-255"). We pre-create a blob URL
  // for every cached range at preloadFontBlobUrls time so MapLibre's
  // sync transformRequest hook can look up an absolute URL like
  //   /fonts/KlokanTech%20Noto%20Sans%20Regular/0-255.pbf
  // and return the blob URL synchronously.

  const _fontBlobUrls = new Map();   // request URL -> blob URL
  let _fontPreloadPromise = null;

  function _fontKeyToUrl(key) {
    // key is "stack/range" — re-encode the stack the same way the
    // page does when building the original URL so the lookup matches
    // exactly what MapLibre asks for.
    const idx = key.lastIndexOf('/');
    const stack = key.slice(0, idx);
    const range = key.slice(idx + 1);
    return `/fonts/${encodeURIComponent(stack)}/${range}`;
  }

  async function preloadFontBlobUrls() {
    if (_fontPreloadPromise) return _fontPreloadPromise;
    _fontPreloadPromise = (async () => {
      const keys = await fontKeys();
      // Drop any blob URLs whose source is gone (cache clear, etc.).
      for (const url of _fontBlobUrls.keys()) {
        try { URL.revokeObjectURL(_fontBlobUrls.get(url)); } catch {}
      }
      _fontBlobUrls.clear();
      for (const key of keys) {
        if (typeof key !== 'string') continue;
        const blob = await fontGet(key);
        if (!blob) continue;
        const objUrl = URL.createObjectURL(blob);
        _fontBlobUrls.set(_fontKeyToUrl(key), objUrl);
      }
      return _fontBlobUrls;
    })();
    _fontPreloadPromise.finally(() => { _fontPreloadPromise = null; });
    return _fontPreloadPromise;
  }

  // Sync lookup for MapLibre's transformRequest. Strips query params /
  // fragments / .pbf extension to match how the request URL is keyed.
  function fontBlobUrlFor(url) {
    try {
      const u = new URL(url, location.origin);
      const path = u.pathname.replace(/\.pbf$/, '');
      return _fontBlobUrls.get(path) || null;
    } catch { return null; }
  }

  // Bulk download the full set of glyph ranges for one font stack
  // into IDB. opts: { onProgress({loaded, total}), signal }.
  async function fontBulkDownload(stack, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const signal = opts.signal;
    const headers = { 'X-Download': '1' };
    let listResp;
    try {
      listResp = await fetch(`/fontslist/${encodeURIComponent(stack)}`, { headers });
    } catch { return { loaded: 0, total: 0, cancelled: false }; }
    if (!listResp.ok) return { loaded: 0, total: 0, cancelled: false };
    const { files = [] } = await listResp.json();
    const have = new Set(await fontKeys());
    let loaded = 0;
    for (const k of have) if (k.startsWith(stack + '/')) loaded++;
    const total = files.length;
    onProgress({ loaded, total });
    for (const fname of files) {
      if (signal && signal.aborted) return { loaded, total, cancelled: true };
      const range = fname.replace(/\.pbf$/, '');
      const key = `${stack}/${range}`;
      if (have.has(key)) continue;
      try {
        const r = await fetch(`/fonts/${encodeURIComponent(stack)}/${fname}`, { headers });
        if (!r.ok) continue;
        const blob = await r.blob();
        await fontPut(key, blob);
        have.add(key);
        loaded++;
        if (loaded % 10 === 0) onProgress({ loaded, total });
      } catch { /* keep going */ }
    }
    onProgress({ loaded, total });
    return { loaded, total, cancelled: false };
  }

  async function getDownloadStatus() {
    const [iks, fks] = await Promise.all([iconKeys(), fontKeys()]);
    return { icons: (iks || []).length, fonts: (fks || []).length };
  }

  async function deleteAll() {
    for (const url of _fontBlobUrls.values()) {
      try { URL.revokeObjectURL(url); } catch {}
    }
    _fontBlobUrls.clear();
    _iconNamesCache = null;
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_ICONS, STORE_FONTS], 'readwrite');
      tx.objectStore(STORE_ICONS).clear();
      tx.objectStore(STORE_FONTS).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  global.AppData = {
    getIconBlob, iconNames, iconBulkDownload,
    preloadFontBlobUrls, fontBlobUrlFor, fontBulkDownload,
    getDownloadStatus, deleteAll,
  };
})(typeof window !== 'undefined' ? window : globalThis);
