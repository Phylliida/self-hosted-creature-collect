const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve
const APP_CACHE = 'app-v1';
const TILES_CACHE = 'tiles-v1';
// Shell bump 2026-06-13 (#4): housenumber counting sort + chunked
// schedule-index build. APP_SHELL entries are cache-first, so this
// comment exists to change sw.js's bytes → reinstall → re-precache.
// Shell bump 2026-07-02 (#5): stall marks on the multi-graph route
// path (multi-build, routing-backfill, route-astar, trip-plan,
// walk-nearest) + poi-halos moveend pass; sprite lazy-crop moved to
// a worker (sprites.js is no-store, but index.html carries marks);
// "Upload logs" button next to Copy logs (POSTs the diagnostic dump
// to /upload-logs → saves/logs/<trainer>_<ms>.txt); bridge builders
// (legacy + multi) switched to integer grid keys + elapsed-time
// yields (dump-convicted ~810ms stall) + bridges/bridges-multi marks
// + bridge-result cache (repeat routes skip the ~1.5s stop relink);
// trip-planner searches yield (3.0s freeze on a 95km plan) and
// traceback is linear (was O(n^2) unshift). trip-planner.js is in
// APP_SHELL, so this bump re-precaches it too.
// Shell bump 2026-07-21 (#6): creature content pack — types/specials/
// pack-reader/pack-install modules, the slim-bundle first-run pack
// prompt, and the Settings → Creature pack row all live in index.html,
// which is cache-first in APP_SHELL. Without this bump existing
// installs keep serving the OLD index.html from the precache and
// never see the pack flow.
// Shell bump 2026-07-22 (#7): Android stale-code fix — the boot
// cache-bust now also clears /static/* live-update overlay entries
// from the app-v1 cache on bundle change (they shadowed the fresh
// bundle's JS across APK installs). The cleanup lives in index.html,
// so this bump is required for it to propagate: without an sw.js byte
// change the SW never reinstalls, never re-precaches '/', and the old
// boot script (without the cleanup) keeps running.
// Shell bump 2026-07-22 (#8): Capacitor stale-code fix, take 2 — the
// #7 cleanup lives in index.html, which is itself served cache-first,
// so it only runs AFTER a launch that already loaded stale code (the
// "relaunch once to see the update" bug). The same cleanup now runs
// in the SW install handler itself (Capacitor only), guaranteed to
// complete before any page load: every code entry ('/', '/dex.html',
// '/sw.js', '/static/*') is dropped from app-v1 before re-precache,
// so a new APK/IPA serves its own bundled code on the FIRST launch,
// offline included (precache fetches hit WebViewAssetLoader /
// LocalServer, not the network). Data entries (/fonts, /icons,
// /bundled-data, tiles) are kept.
// Same build: the Settings → Creature pack row now passes the ACTIVE
// pack id to readMeta/currentSource/checkForUpdate/deletePackData
// (was hardcoded to the creature-fusion default), so a broken
// non-default pack can actually be deleted + re-downloaded from the
// UI. That change lives in cache-first index.html → this bump.

const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/static/icon.svg',
  '/static/poke-ball.svg',
  '/static/great-ball.svg',
  '/static/ball-seam-glow.svg',
  '/static/trip-planner.js',
  '/static/extras.js',
  '/static/vendor/maplibre-gl.css',
  '/static/vendor/maplibre-gl.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then(async (c) => {
    // Capacitor only: drop every CODE entry from app-v1 before
    // re-precaching. `adb install -r` / IPA sideloads keep app data,
    // so live-update overlay entries ('/static/*.js', but also '/' and
    // '/dex.html' — the boot-script cleanup in index.html only deletes
    // /static/*) survive the install and shadow the fresh bundle's
    // code, making an app update load old JS until something else
    // clears them. Doing it HERE — not in the page's boot script —
    // means it runs before any page load, so the new bundle's code is
    // served on the FIRST launch. The precache fetches below are local
    // (WebViewAssetLoader on Android, LocalServer on iOS), so this all
    // works offline. DATA entries are deliberately kept: /fonts and
    // /icons (user-downloaded, zero-network rule) and /bundled-data
    // (creature packs, not in the APK). Gated on IS_CAPACITOR so the
    // web PWA — whose precache fetches DO need the network — never
    // wipes code it might be unable to re-fetch while offline.
    // (IS_CAPACITOR is declared further down; the handler body only
    // runs after the whole script has evaluated, so no TDZ issue.)
    if (IS_CAPACITOR) {
      try {
        const keys = await c.keys();
        await Promise.all(keys.map((r) => {
          try {
            const p = new URL(r.url).pathname;
            if (p === '/' || p === '/dex.html' || p === '/sw.js' ||
                p.startsWith('/static/')) {
              return c.delete(r);
            }
          } catch {}
          return null;
        }));
      } catch {}
    }
    await Promise.all(APP_SHELL.map(async (url) => {
      try {
        // Delete first so Safari reliably frees the old response body;
        // cache.put alone sometimes leaves the old blob hanging around and
        // each hard refresh grows navigator.storage.estimate() a bit.
        await c.delete(url);
        // `no-store` skips the HTTP cache entirely on both read and write.
        // `reload` bypasses on read but still populates, which on Safari
        // causes storage.estimate() to grow ~1-2 MB per hard refresh as
        // old response blobs linger in the browser's HTTP cache.
        const res = await fetch(url, { cache: 'no-store' });
        if (res.ok) await c.put(url, res);
      } catch {}
    }));
  }));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

// Capacitor IPA = page served by LocalServer.swift on
// http://localhost:<port>. In that mode, bundled assets (tiles
// z0..z5, fonts, icons, sprites, etc.) live in the IPA's webDir
// and are served by LocalServer when the SW falls through to
// network on cache miss. In the web PWA, return 204 on miss to
// honour the no-automatic-network-requests rule.
const IS_CAPACITOR = self.location.hostname === 'localhost';
async function _missResponse(req) {
  if (!IS_CAPACITOR) return new Response(null, { status: 204 });
  // Capacitor: try LocalServer (bundled file). Crucially, MapLibre
  // treats a 404 as "tile FAILED to load" (no parent fallback) but
  // treats 204 as "tile is intentionally empty" (parent fallback
  // chain kicks in). We want the latter for missing high-zoom tiles
  // so the bundled z5 base layer over-zooms into the gap. Translate
  // any non-200 LocalServer response to 204.
  try {
    const res = await fetch(req);
    if (res.status === 200) return res;
  } catch { /* network error → treat as miss */ }
  return new Response(null, { status: 204 });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin === location.origin && url.pathname.startsWith('/tiles/')) {
    if (e.request.headers.get('X-Download') === '1') return;
    e.respondWith(
      caches.open(TILES_CACHE)
        .then(c => c.match(e.request))
        .then(hit => hit || _missResponse(e.request))
    );
    return;
  }
  if (url.origin === location.origin && url.pathname.startsWith('/poi')) {
    if (e.request.headers.get('X-Download') === '1') return;
    e.respondWith(new Response(JSON.stringify({ pois: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }));
    return;
  }
  if (url.origin === location.origin && url.pathname.startsWith('/routes')) {
    if (e.request.headers.get('X-Download') === '1') return;
    e.respondWith(new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }));
    return;
  }
  if (url.origin === location.origin && url.pathname.startsWith('/walk-graph')) {
    if (e.request.headers.get('X-Download') === '1') return;
    e.respondWith(new Response(JSON.stringify({ nodes: [], edges: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }));
    return;
  }
  if (url.origin === location.origin &&
      (url.pathname.startsWith('/fonts') || url.pathname.startsWith('/icons'))) {
    if (e.request.headers.get('X-Download') === '1') {
      e.respondWith(
        caches.open(APP_CACHE).then(async (c) => {
          const hit = await c.match(e.request);
          if (hit) return hit;
          const res = await fetch(e.request);
          if (res.ok) c.put(e.request, res.clone());
          return res;
        })
      );
      return;
    }
    e.respondWith(
      caches.open(APP_CACHE)
        .then(c => c.match(e.request))
        .then(hit => hit || _missResponse(e.request))
    );
    return;
  }
  // Default branch: cache hit, else try LocalServer / origin via
  // fetch. On iOS Capacitor this fetch is to LocalServer (GCDWebServer
  // at http://localhost:<port>) which always serves the bundled
  // webDir as long as the app is running — local file IO, not real
  // network. On Android Capacitor the same fetch goes through our
  // WebViewAssetLoader path handler. On the web PWA it goes to the
  // origin server. All three paths can be transiently flaky (Safari
  // storage pressure throwing from caches.match, brief LocalServer
  // hiccups during app resume, real offline conditions on the PWA),
  // so the outer .catch coerces any rejection — fetch, caches.match,
  // anything else — to a 504. The page never sees a thrown error,
  // and the SW never logs "FetchEvent.respondWith received an error"
  // even when something does briefly fail. Legit user-initiated
  // network requests with X-Download still bypass the SW via the
  // explicit-branch handlers.
  e.respondWith(
    caches.match(e.request)
      .then((hit) => {
        if (hit) return hit;
        return fetch(e.request).catch(() => new Response(null, { status: 504 }));
      })
      .catch(() => new Response(null, { status: 504 }))
  );
});

self.addEventListener('message', (e) => {
  const msg = e.data || {};
  if (msg.type === 'getVersion') {
    // Page asks the running SW for its SCRIPT_VERSION (which the
    // server stamped at serve time, same as the page-context .js
    // files). The page replies via the MessageChannel port it
    // attached on send. In-process IPC — not a network request.
    const port = e.ports && e.ports[0];
    if (port) port.postMessage({ version: SCRIPT_VERSION });
  } else if (msg.type === 'download') {
    e.waitUntil(downloadRegion(msg, e.source));
  } else if (msg.type === 'deleteTiles') {
    e.waitUntil(deleteTiles(msg.urls));
  } else if (msg.type === 'refreshAppShell') {
    e.waitUntil(refreshAppShell(e.source));
  }
});

async function downloadRegion({ bbox, minZoom, maxZoom, extraUrls = [], id, workers = 6, apiBase = '' }, client) {
  // `apiBase` lets the IPA (Capacitor mode) point tile/extra fetches
  // at the live Flask backend instead of the local capacitor://localhost
  // origin, which only ships z0..z5. The cache key stays as the
  // ORIGINAL relative URL so MapLibre's same-origin tile requests
  // still match against TILES_CACHE on subsequent reads.
  const tiles = tileUrls(bbox, minZoom, maxZoom);
  const queue = [
    ...tiles.map(u => ({ fetchUrl: apiBase + u, cacheKey: u, cacheName: TILES_CACHE })),
    ...extraUrls.map(u => ({ fetchUrl: apiBase + u, cacheKey: u, cacheName: APP_CACHE }))
  ];
  const total = queue.length;
  let done = 0, failed = 0;
  // Worker count chosen by the main thread: 6 on mobile (iOS backgrounds the
  // SW aggressively, high concurrency stalls) and 60 on desktop (modern
  // browsers handle 50+ parallel connections comfortably, ~10x throughput).
  // Debug counters surfaced in the 'done' message so the page can
  // log them. Helps diagnose "downloaded but tiles don't render"
  // — distinguishes between "fetches failed", "cache.put failed",
  // and "everything cached but later lookup misses".
  let bodyBytes = 0;
  let cachePuts = 0;
  let putErrors = 0;
  let firstSampleUrl = null;
  let gunzipped = 0;       // count of tiles we had to decompress manually
  let firstSampleMagic = '';

  // WebKit's SW fetch doesn't reliably auto-decompress Content-
  // Encoding: gzip responses (window-context fetches do). Without
  // detection, we'd cache raw gzipped bytes that MapLibre can't
  // parse → "Load failed (source=local)" with blank tiles. Detect
  // the gzip magic (0x1F 0x8B) and run the body through
  // DecompressionStream when present.
  async function readDecompressed(res) {
    const buf = await res.clone().arrayBuffer();
    if (buf.byteLength < 2) return buf;
    const view = new Uint8Array(buf, 0, 2);
    if (view[0] !== 0x1f || view[1] !== 0x8b) return buf;
    if (typeof DecompressionStream === 'undefined') return buf;
    try {
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
      const out = await new Response(stream).arrayBuffer();
      gunzipped++;
      return out;
    } catch {
      return buf;  // give up, cache the gzipped bytes (likely wrong but at least non-empty)
    }
  }
  const workerPool = Array(workers).fill(0).map(async () => {
    while (queue.length) {
      const item = queue.pop();
      try {
        const res = await fetch(item.fetchUrl, { headers: { 'X-Download': '1' } });
        if (res.ok && res.status !== 204) {
          // Read the body with explicit gzip detection (some browsers
          // skip auto-decompression in SW context) AND strip the
          // Content-Encoding header so the browser doesn't try to
          // decompress AGAIN when the cached entry is served back.
          const body = await readDecompressed(res);
          bodyBytes += body.byteLength;
          if (!firstSampleMagic && body.byteLength >= 2) {
            const v = new Uint8Array(body, 0, 2);
            firstSampleMagic = `${v[0].toString(16).padStart(2,'0')}${v[1].toString(16).padStart(2,'0')}`;
          }
          const headers = new Headers(res.headers);
          headers.delete('Content-Encoding');
          headers.delete('Content-Length');
          const cleaned = new Response(body, {
            status: res.status, statusText: res.statusText, headers,
          });
          try {
            const cache = await caches.open(item.cacheName);
            await cache.put(item.cacheKey, cleaned);
            cachePuts++;
            if (firstSampleUrl == null && item.cacheName === TILES_CACHE) {
              firstSampleUrl = item.cacheKey;
            }
          } catch (e) {
            putErrors++;
          }
        } else if (res.status !== 204 && !res.ok) {
          failed++;
        }
      } catch { failed++; }
      done++;
      if (client && done % 5 === 0) {
        client.postMessage({ type: 'progress', id, done, total, failed });
      }
    }
  });
  await Promise.all(workerPool);
  // Verify a sample cached entry actually round-trips — catches the
  // "stored but unreadable" failure mode (e.g. opaque cross-origin
  // response, port mismatch between the cacheKey resolution and
  // MapLibre's later fetch).
  let sampleVerifyStatus = 'n/a';
  if (firstSampleUrl) {
    try {
      const c = await caches.open(TILES_CACHE);
      const probeUrl = new URL(firstSampleUrl, self.location.href).toString();
      const hit = await c.match(probeUrl);
      sampleVerifyStatus = hit ? `hit(${(await hit.clone().blob()).size}B)` : 'miss';
    } catch (e) {
      sampleVerifyStatus = 'err:' + (e && e.message ? e.message : e);
    }
  }
  if (client) {
    client.postMessage({
      type: 'done', id, done, total, failed,
      urls: tiles, bodyBytes, cachePuts, putErrors,
      sampleUrl: firstSampleUrl, sampleVerify: sampleVerifyStatus,
      gunzipped, firstMagic: firstSampleMagic,
    });
  }
}

async function deleteTiles(urls) {
  const cache = await caches.open(TILES_CACHE);
  for (const u of urls) await cache.delete(u);
}

async function refreshAppShell(client) {
  const cache = await caches.open(APP_CACHE);
  for (const url of APP_SHELL) {
    await cache.delete(url);
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) await cache.put(url, res);
    } catch {}
  }
  if (client) client.postMessage({ type: 'appShellRefreshed' });
}

function tileUrls(bbox, minZoom, maxZoom) {
  const [w, s, e, n] = bbox;
  const urls = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const [xMin, yMin] = lonLatToTile(w, n, z);
    const [xMax, yMax] = lonLatToTile(e, s, z);
    for (let x = Math.min(xMin, xMax); x <= Math.max(xMin, xMax); x++) {
      for (let y = Math.min(yMin, yMax); y <= Math.max(yMin, yMax); y++) {
        urls.push(`/tiles/${z}/${x}/${y}.pbf`);
      }
    }
  }
  return urls;
}

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return [Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y))];
}
