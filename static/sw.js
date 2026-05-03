const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve
const APP_CACHE = 'app-v1';
const TILES_CACHE = 'tiles-v1';

const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/static/icon.svg',
  '/static/poke-ball.svg',
  '/static/great-ball.svg',
  '/static/ball-seam-glow.svg',
  '/static/trip-planner.js',
  '/static/vendor/maplibre-gl.css',
  '/static/vendor/maplibre-gl.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then(async (c) => {
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
// and are served by LocalServer when MapLibre / <img> fetches the
// path — so the SW must fall through to network on cache miss
// (the "network" goes to LocalServer, instantaneous, no Wi-Fi).
// In the web PWA the SW returns 204 on miss to honour the
// no-automatic-network-requests rule (user explicitly downloads
// via the welcome flow).
const IS_CAPACITOR = self.location.hostname === 'localhost';
function _missResponse(req) {
  return IS_CAPACITOR ? fetch(req) : new Response(null, { status: 204 });
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
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
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
