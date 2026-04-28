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
  // v2 bumped from v1: icon entries changed from raw SVG text blobs to
  // pre-rasterized RGBA pixel blobs (skip the runtime SVG decode that
  // was hogging the main thread for 500-1500ms on every page load).
  // Upgrade wipes the icons store so old SVG entries don't get fed
  // into the new pixel-decoder; user re-downloads via the missing-data
  // banner. Fonts store is untouched.
  const DB_VERSION = 2;
  const STORE_ICONS = 'icons';
  const STORE_FONTS = 'fonts';

  // Pre-rasterized icon blob format:
  //   byte 0       : magic 0xC1 (high-bit set so it can never be SVG)
  //   bytes 1-2    : width  (u16 LE)
  //   bytes 3-4    : height (u16 LE)
  //   byte 5       : pixelRatio (u8)
  //   bytes 6+     : RGBA pixel data (width * height * 4 bytes)
  const ICON_MAGIC = 0xC1;
  const ICON_HEADER_BYTES = 6;

  let _dbPromise = null;
  function openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (db.objectStoreNames.contains(STORE_ICONS) && (e.oldVersion || 0) < 2) {
          db.deleteObjectStore(STORE_ICONS);
        }
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

  // Rasterize an SVG string to a 48×48 RGBA buffer (24px logical with
  // pixelRatio 2 — matches what svgToImageData in index.html produced
  // for SDF icons). Returns { width, height, pixelRatio, data } or
  // null if anything blows up (decoder, canvas, etc.).
  async function _rasterizeSvg(svgText, size = 24, dpr = 2) {
    const blob = new Blob([svgText], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const w = size * dpr;
      const h = size * dpr;
      const canvas = (typeof OffscreenCanvas !== 'undefined')
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const id = ctx.getImageData(0, 0, w, h);
      return { width: w, height: h, pixelRatio: dpr, data: id.data };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function _serializeIcon(ras) {
    const buf = new ArrayBuffer(ICON_HEADER_BYTES + ras.data.length);
    const view = new DataView(buf);
    view.setUint8(0, ICON_MAGIC);
    view.setUint16(1, ras.width, true);
    view.setUint16(3, ras.height, true);
    view.setUint8(5, ras.pixelRatio);
    new Uint8Array(buf, ICON_HEADER_BYTES).set(ras.data);
    return new Blob([buf], { type: 'application/octet-stream' });
  }

  async function _deserializeIcon(blob) {
    if (!blob) return null;
    const buf = await blob.arrayBuffer();
    if (buf.byteLength < ICON_HEADER_BYTES) return null;
    const view = new DataView(buf);
    if (view.getUint8(0) !== ICON_MAGIC) return null;  // legacy SVG entry
    const width = view.getUint16(1, true);
    const height = view.getUint16(3, true);
    const pixelRatio = view.getUint8(5);
    const expected = ICON_HEADER_BYTES + width * height * 4;
    if (buf.byteLength < expected) return null;
    // Use Uint8Array (not Uint8ClampedArray) for the pixel buffer —
    // MapLibre's addImage path accepts both via duck-typing in recent
    // versions, but some older code paths and the maplibre-gl.js
    // type checks specifically test for Uint8Array. Cheap to be safe.
    const data = new Uint8Array(buf, ICON_HEADER_BYTES, width * height * 4);
    return { width, height, pixelRatio, data };
  }

  // Returns the parsed RGBA buffer ready to feed to map.addImage.
  // null if the icon isn't present OR the stored entry is in the
  // legacy SVG format (caller should treat as missing → user
  // re-downloads via the missing-data banner).
  async function getIconImageData(name) {
    const blob = await iconGet(name);
    return _deserializeIcon(blob);
  }

  // Bulk variant — opens ONE readonly transaction and reads every
  // requested icon inside it. iOS Safari serializes IDB transactions,
  // so this turns ~150 separate transactions into one pipelined
  // batch, cutting startup icon registration from seconds to
  // milliseconds. Returns Map<name, ImageData|null>.
  async function getIconImageDataBatch(names) {
    if (!names || !names.length) return new Map();
    const db = await openDb();
    const blobs = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_ICONS, 'readonly');
      const store = tx.objectStore(STORE_ICONS);
      const out = new Array(names.length);
      let pending = names.length;
      names.forEach((n, i) => {
        const r = store.get(n);
        r.onsuccess = () => { out[i] = r.result || null; if (--pending === 0) resolve(out); };
        r.onerror   = () => { out[i] = null;            if (--pending === 0) resolve(out); };
      });
      tx.onerror = () => reject(tx.error);
    });
    // Parallelize the per-blob arrayBuffer() reads so a 200-entry
    // batch doesn't serialize 200 microtasks before the first
    // addImage runs.
    const decoded = await Promise.all(blobs.map((b) => _deserializeIcon(b)));
    const result = new Map();
    let firstByteSample = null;
    let nullCount = 0;
    for (let i = 0; i < names.length; i++) {
      result.set(names[i], decoded[i]);
      if (decoded[i] == null) nullCount++;
      if (firstByteSample == null && blobs[i] && blobs[i].size > 0) {
        const sample = new Uint8Array(await blobs[i].slice(0, 1).arrayBuffer());
        firstByteSample = `0x${sample[0].toString(16).padStart(2, '0')}`;
      }
    }
    // Diagnostic — surface how many entries failed to deserialize so
    // the Settings badge can show "decode-fail: X" when icons aren't
    // registering. firstByteSample tells us if it's a stale-format
    // problem (SVG blobs start with 0x3C '<', rasterized start with
    // 0xC1).
    window._iconDecodeStats = {
      requested: names.length,
      decoded: names.length - nullCount,
      nullCount,
      firstByteSample,
    };
    return result;
  }

  // Backwards-compatible accessor — returns the raw stored Blob.
  // Useful for diagnostics; new callers should use getIconImageData.
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
        const svg = await r.text();
        // Rasterize NOW (once, during download) instead of every page
        // load — this is the whole point of the v2 schema bump.
        // ~5-15ms per icon × ~150 icons = ~1-2 extra seconds added to
        // the one-time download in exchange for ~500-1500ms faster
        // every subsequent startup.
        const ras = await _rasterizeSvg(svg);
        if (!ras) continue;
        await iconPut(name, _serializeIcon(ras));
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
      const keys = (await fontKeys()).filter((k) => typeof k === 'string');
      // Drop any blob URLs whose source is gone (cache clear, etc.).
      for (const url of _fontBlobUrls.keys()) {
        try { URL.revokeObjectURL(_fontBlobUrls.get(url)); } catch {}
      }
      _fontBlobUrls.clear();
      if (!keys.length) return _fontBlobUrls;
      // Batch-read every font in ONE transaction — iOS Safari
      // serializes IDB transactions, so 50 sequential fontGet calls
      // (one per glyph range) was a measurable startup hit. Single
      // pipelined transaction is ~50× faster.
      const db = await openDb();
      const blobs = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_FONTS, 'readonly');
        const store = tx.objectStore(STORE_FONTS);
        const out = new Array(keys.length);
        let pending = keys.length;
        keys.forEach((k, i) => {
          const r = store.get(k);
          r.onsuccess = () => { out[i] = r.result || null; if (--pending === 0) resolve(out); };
          r.onerror   = () => { out[i] = null;            if (--pending === 0) resolve(out); };
        });
        tx.onerror = () => reject(tx.error);
      });
      for (let i = 0; i < keys.length; i++) {
        const blob = blobs[i];
        if (!blob) continue;
        _fontBlobUrls.set(_fontKeyToUrl(keys[i]), URL.createObjectURL(blob));
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
    getIconBlob, getIconImageData, getIconImageDataBatch,
    iconNames, iconBulkDownload,
    preloadFontBlobUrls, fontBlobUrlFor, fontBulkDownload,
    getDownloadStatus, deleteAll,
  };
})(typeof window !== 'undefined' ? window : globalThis);
