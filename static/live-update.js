// Capacitor live-update flow.
//
// On launch in the IPA, check the live server's /script-versions
// endpoint against the locally-installed version map. If anything
// has changed, download the affected files (and any with a missing
// installed version) into a fresh directory under
// Library/CCLiveUpdates/v-<version>/, point LocalServer at it via
// the BundleAccess plugin, and reload.
//
// Why this exists: bundled-mode IPAs don't have a built-in
// "refresh to update" path the way `server.url` did — every code
// change normally needs a new IPA build + sideload. This module
// closes that gap by fetching new web assets at runtime and serving
// them in preference to the bundled versions on the next launch.
//
// Doesn't run on the web build (no window.Capacitor). Doesn't run
// in Capacitor unless both Filesystem and BundleAccess plugins are
// available. Errors are surfaced via console.error → debug overlay
// but never throw — startup must continue regardless of update state.

// Marker logged BEFORE any logic runs so we can tell if the script
// is even being parsed/executed. If you don't see this in the
// debug overlay on launch, the file isn't being served by
// LocalServer (or isn't in any bundled version of webDir).
console.error('[live-update] script-tag executing');

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';
  global._scriptVersions = global._scriptVersions || {};
  global._scriptVersions['live-update.js'] = SCRIPT_VERSION;

  const VERSION_MAP_KEY  = 'cc.installedVersions';
  const ACTIVE_DIR_KEY   = 'cc.activeLiveDir';
  const RECENT_FAIL_KEY  = 'cc.lastUpdateFailedAt';
  // Set by the in-page refresh button (pure-HTML inline onclick) to
  // request a one-shot update check on the next launch. Without this
  // flag, the check is skipped entirely — no /script-versions fetch,
  // no data usage. The flag is consumed (cleared) at the start of the
  // check so a failed update doesn't loop on every subsequent launch.
  const REFRESH_REQ_KEY  = 'cc.refreshRequested';
  const APP_CACHE_NAME   = 'app-v1';   // service-worker cache the SW serves from (Android overlay)

  if (!global.Capacitor) return;

  // console.error so the on-screen debug overlay surfaces these.
  // Phase 3 is new + finicky enough that silent operation isn't
  // useful — better to see the flow on every launch.
  function log(msg) { console.error('[live-update]', msg); }
  function warn(msg, err) { console.error('[live-update]', msg, err || ''); }

  /// Returns { Filesystem, BundleAccess } or null if either is missing.
  function plugins() {
    const fs = global.Capacitor.Plugins && global.Capacitor.Plugins.Filesystem;
    const ba = global.Capacitor.Plugins && global.Capacitor.Plugins.BundleAccess;
    return (fs && ba) ? { Filesystem: fs, BundleAccess: ba } : null;
  }

  /// Fetch /script-versions from CC_API_BASE. Returns the map or null.
  async function fetchLatestVersions() {
    const base = global.CC_API_BASE || 'https://poke.phylliidaassets.org';
    try {
      const resp = await fetch(`${base}/script-versions`, { cache: 'no-store' });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) { warn('script-versions fetch failed', e); return null; }
  }

  function loadInstalled() {
    let stored;
    try { stored = JSON.parse(localStorage.getItem(VERSION_MAP_KEY) || 'null'); }
    catch { stored = null; }
    if (stored && typeof stored === 'object' && Object.keys(stored).length) {
      return stored;
    }
    // Empty / missing — seed from what the page was actually loaded
    // with. Build-capacitor.sh stamps the bundled HTML with
    // `_serverScriptVersions` so the IPA knows what versions it
    // shipped with. Without this seed, the first launch after a
    // fresh install would see `installed = {}` vs server's full map,
    // conclude every file is stale, download all of them, and reload
    // — even when bundled and server are at the same versions.
    const seed = global._serverScriptVersions;
    if (seed && typeof seed === 'object' && Object.keys(seed).length) {
      log(`seeding installed versions from page (${Object.keys(seed).length} files)`);
      try { localStorage.setItem(VERSION_MAP_KEY, JSON.stringify(seed)); } catch {}
      return seed;
    }
    return {};
  }

  /// Resolve a tracked filename (as it appears in /script-versions)
  /// to the URL the server serves it from.
  function fileUrl(base, fname) {
    if (fname === 'index.html') return `${base}/`;
    if (fname === 'dex.html')   return `${base}/dex`;
    if (fname === 'sw.js')      return `${base}/sw.js`;
    return `${base}/static/${fname}`;
  }

  /// Where the file should land within the per-version live dir,
  /// relative to that dir. Mirrors what the server's URL→file
  /// mapping is so LocalServer can resolve it the same way.
  function localPath(fname) {
    if (fname === 'index.html') return 'index.html';
    if (fname === 'dex.html')   return 'dex.html';
    if (fname === 'sw.js')      return 'sw.js';
    return `static/${fname}`;
  }

  /// Slugify a version string into something safe for a directory
  /// name. Versions are mtimes like "2026-05-02 21:30" — replace any
  /// non-[a-z0-9] with underscore.
  function versionToDirName(v) {
    return 'v-' + String(v).replace(/[^a-zA-Z0-9]/g, '_');
  }

  /// Suppress repeated update attempts after a failure (15-min window).
  function recentlyFailed() {
    const t = parseInt(localStorage.getItem(RECENT_FAIL_KEY) || '0', 10);
    return t > 0 && (Date.now() - t) < 15 * 60 * 1000;
  }

  /// True if the user pressed refresh on the previous load. Consumes
  /// the flag so this returns true at most once per refresh press.
  function consumeRefreshRequest() {
    try {
      if (localStorage.getItem(REFRESH_REQ_KEY) !== '1') return false;
      localStorage.removeItem(REFRESH_REQ_KEY);
      return true;
    } catch { return false; }
  }

  async function checkForUpdates(opts) {
    const force = !!(opts && opts.force);
    // Gate: only run when explicitly requested. Either the page-side
    // refresh button has set cc.refreshRequested, or some caller
    // invoked CCLiveUpdate.check({force:true}) directly. Default
    // launches do nothing — zero data.
    if (!force && !consumeRefreshRequest()) {
      log('no refresh request; skipping check');
      return;
    }
    log('check started');
    if (recentlyFailed()) { log('recent failure; skipping check'); return; }

    const latest = await fetchLatestVersions();
    if (!latest) return;            // no data reachable → no-op (refresh does nothing)
    const installed = loadInstalled();

    // Take the union of file names — anything in the latest map that
    // differs (or is unknown) from installed is in scope for download.
    const fnames = Object.keys(latest);
    const changed = fnames.filter((k) => latest[k] !== installed[k]);
    if (!changed.length) { log('all up to date'); return; }
    log(`update available: ${changed.length} file(s) changed (${changed.join(', ')})`);

    const base = global.CC_API_BASE || 'https://poke.phylliidaassets.org';
    const p = plugins();
    if (!p) {
      // No native live-dir overlay — this is Android, which has no
      // BundleAccess plugin. Apply the update by overlaying the new code
      // into the service-worker cache, which the SW already serves in
      // preference to the bundled copies. updateViaCache fetches everything
      // FIRST and only commits if all of it arrives, so when no data is
      // available it touches nothing and refresh is a safe no-op.
      if (global.caches) await updateViaCache(latest, fnames, base);
      else warn('no update backend (no BundleAccess, no Cache API); skipping');
      return;
    }

    // iOS: native live-dir overlay (LocalServer serves liveDir-first).
    // Use the version of index.html (or any tracked file) as the
    // directory tag. Multiple files might change atomically; one tag
    // is fine since we re-download every changed file together.
    const tag = latest['index.html'] || latest[fnames[0]] || String(Date.now());
    const dirName = versionToDirName(tag);

    let rootResp;
    try { rootResp = await p.BundleAccess.getLiveDirRoot(); }
    catch (e) { warn('getLiveDirRoot failed', e); markFailed(); return; }
    const versionDir = `${rootResp.path}/${dirName}`;

    // Download every TRACKED file, not just the changed ones, into a
    // fresh dir. LocalServer falls back to the bundled copy on miss
    // for non-tracked files (sprites, JSON, fonts), so we only need
    // to ship code here. Writing all tracked files together avoids
    // version skew between e.g. an updated sprites.js and a stale
    // index.html that doesn't reference its new export.
    let downloaded = 0;
    for (const fname of fnames) {
      try {
        const resp = await fetch(fileUrl(base, fname), { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();
        await p.Filesystem.writeFile({
          path: `CCLiveUpdates/${dirName}/${localPath(fname)}`,
          data: text,
          directory: 'LIBRARY',
          encoding: 'utf8',
          recursive: true,
        });
        downloaded++;
      } catch (e) {
        warn(`failed to write ${fname}`, e);
        markFailed();
        return;
      }
    }
    log(`wrote ${downloaded}/${fnames.length} files to ${versionDir}`);

    // Activate the new version: tell LocalServer to read from it,
    // record the new installed-version map for next compare, then
    // reload so the WebView picks up the new index.html immediately.
    try {
      await p.BundleAccess.setLiveDir({ path: versionDir });
    } catch (e) { warn('setLiveDir failed', e); markFailed(); return; }
    localStorage.setItem(VERSION_MAP_KEY, JSON.stringify(latest));
    localStorage.setItem(ACTIVE_DIR_KEY, versionDir);
    localStorage.removeItem(RECENT_FAIL_KEY);
    log(`activated ${dirName}; reloading`);
    setTimeout(() => location.reload(), 100);
  }

  // Android update backend: overlay the updated tracked files into the
  // service-worker cache. The SW's fetch handler already serves from this
  // cache in preference to the bundled assets, so caching the remote copy
  // under each file's local URL makes the SW serve the new code. We fetch
  // ALL files first and only write to the cache once every one has arrived
  // — so a flaky/offline network aborts the whole thing with the cache
  // untouched, and the app keeps running exactly as before (refresh = no-op).
  function cacheKey(fname) {
    if (fname === 'index.html') return '/';
    if (fname === 'dex.html')   return '/dex.html';
    if (fname === 'sw.js')      return '/sw.js';
    return `/static/${fname}`;
  }
  async function updateViaCache(latest, fnames, base) {
    // Phase 1 — fetch + read everything into memory; bail (no cache writes)
    // on any miss. Each remote (cross-origin) body is rebuilt into a clean,
    // same-origin-style Response so the SW can serve it for navigations and
    // scripts without cross-origin / opaque-response quirks.
    const staged = [];
    for (const fname of fnames) {
      let resp;
      try { resp = await fetch(fileUrl(base, fname), { cache: 'no-store', mode: 'cors' }); }
      catch (e) { warn(`fetch failed for ${fname}; aborting (cache untouched)`, e); return; }
      if (!resp || !resp.ok) { warn(`bad response for ${fname} (${resp && resp.status}); aborting`); return; }
      let body;
      try { body = await resp.blob(); }
      catch (e) { warn(`read failed for ${fname}; aborting`, e); return; }
      const ct = resp.headers.get('Content-Type') || '';
      const clean = new Response(body, { status: 200, statusText: 'OK', headers: ct ? { 'Content-Type': ct } : {} });
      staged.push({ key: cacheKey(fname), resp: clean });
    }
    // Phase 2 — commit. Only reached when every file fetched cleanly.
    let cache;
    try { cache = await caches.open(APP_CACHE_NAME); }
    catch (e) { warn('caches.open failed; aborting', e); return; }
    try { for (const s of staged) await cache.put(s.key, s.resp); }
    catch (e) { warn('cache write failed', e); return; }
    localStorage.setItem(VERSION_MAP_KEY, JSON.stringify(latest));
    localStorage.removeItem(RECENT_FAIL_KEY);
    log(`cache-overlay update applied (${staged.length} files); reloading`);
    setTimeout(() => location.reload(), 100);
  }

  function markFailed() {
    localStorage.setItem(RECENT_FAIL_KEY, String(Date.now()));
  }

  // Defer the gate-check so it doesn't block first paint. The check
  // is a no-op (no network) unless the refresh flag is set, so this
  // wakes up briefly on every launch but only burns data when the
  // user actually pressed refresh on the previous load.
  if (document.readyState === 'complete') {
    setTimeout(checkForUpdates, 2000);
  } else {
    window.addEventListener('load', () => setTimeout(checkForUpdates, 2000), { once: true });
  }

  // Expose a manual trigger. Pass {force:true} from a console / dev
  // tool to bypass the refresh-flag gate without touching localStorage.
  global.CCLiveUpdate = { check: checkForUpdates };
})(typeof window !== 'undefined' ? window : globalThis);
