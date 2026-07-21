// PackInstall: download the creature content pack and put its bytes
// exactly where the app data already lives — no new serving machinery.
//
//   iOS Capacitor : entries are written as real files under
//                   Library/CCContentPack/ via the Filesystem plugin;
//                   LocalServer.swift serves /bundled-data/* from
//                   there (its existing overlay style).
//   Android       : entries are overlaid into the SW app cache under
//                   their /bundled-data/* URLs — the same mechanism
//                   live-update's updateViaCache uses (SW is
//                   cache-first for those paths).
//
// MEMORY MODEL (load-bearing): the 600MB+ pack is NEVER held whole in
// memory. The download streams network → one-entry-at-a-time files
// (entries are laid out sequentially in the file, so a single pass
// suffices: header+TOC first, then each entry's bytes as they
// complete). Peak JS memory ≈ the largest single entry (a few MB).
// Sprite SHEETS (sprites/) are skipped on native — cell art comes
// from sprite-packs/ there; sheets are only the web crop flow's input.
//
// Source follows the SAME dropdown the maps use (cc.regionsMode):
//   static-hf  → Hugging Face creature-pack dataset
//   flask modes → the self-hosted server's /content-pack/* route
//                 (CC_API_BASE on Capacitor, same-origin on web).
//
// Headless-safe core (sourceForMode / makeEntryCutter are pure) —
// tests drive those under Node.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve (if tracked)
  if (global._scriptVersions) global._scriptVersions['pack-install.js'] = SCRIPT_VERSION;

  const META_KEY = 'cc.contentPack.v1';   // legacy single-pack slot (migration source)
  const META_PREFIX = 'cc.contentPack.';  // + '<packId>.v1' per-pack slots
  const DEFAULT_PACK_ID = 'creature-fusion';
  const HF_BASE = 'https://huggingface.co/datasets/';
  const CONTENT_DIR = 'CCContentPack';   // iOS: Library/ subdir served by LocalServer
  const ANDROID_CACHE = 'app-v1';        // Android: SW cache (live-update overlay model)
  const ACTIVE_FILE = 'active.txt';      // iOS: active-pack marker LocalServer reads
  // Sprite sheets are the web crop flow's input; native cell art comes
  // from sprite-packs/. Skipping them halves the write time + disk.
  const SKIP_PREFIXES = ['sprites/'];

  function metaKey(packId) { return META_PREFIX + (packId || DEFAULT_PACK_ID) + '.v1'; }

  const MIME = {
    png: 'image/png', json: 'application/json', bin: 'application/octet-stream',
    pack: 'application/octet-stream', svg: 'image/svg+xml', pbf: 'application/x-protobuf',
  };
  function mimeFor(path) {
    const dot = path.lastIndexOf('.');
    const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
    return MIME[ext] || 'application/octet-stream';
  }

  // ── source resolution (mirrors _regionBaseUrl semantics) ──
  function sourceForMode(mode, apiBase, hfRepo, packId) {
    const repo = hfRepo || 'TessaCoil/creature-pack';
    if (mode === 'static-hf') {
      return {
        source: 'hf',
        packBinUrl: `${HF_BASE}${repo}/resolve/main/pack.bin`,
        packJsonUrl: `${HF_BASE}${repo}/resolve/main/pack.json`,
      };
    }
    const base = String(apiBase || '').replace(/\/$/, '');
    const pid = packId || DEFAULT_PACK_ID;
    return {
      source: 'local',
      packBinUrl: `${base}/pack-files/${pid}/pack.bin`,
      packJsonUrl: `${base}/pack-files/${pid}/pack.json`,
    };
  }
  function _mode() {
    try { return localStorage.getItem('cc.regionsMode') || 'bbox-flask'; }
    catch { return 'bbox-flask'; }
  }
  function _hfRepoFor(packId) {
    const def = global.Packs && global.Packs.get
      ? global.Packs.get(packId || DEFAULT_PACK_ID) : null;
    return (def && def.hfRepo) || 'TessaCoil/creature-pack';
  }
  function currentSource(packId) {
    return sourceForMode(_mode(), global.CC_API_BASE || '', _hfRepoFor(packId), packId);
  }

  // ── meta (what's installed), per pack ──
  function readMeta(packId) {
    try {
      const raw = localStorage.getItem(metaKey(packId));
      if (raw) return JSON.parse(raw);
      // Legacy single-pack meta migrates into the creature-fusion slot.
      if (!packId || packId === DEFAULT_PACK_ID) {
        const legacy = localStorage.getItem(META_KEY);
        if (legacy) {
          localStorage.setItem(metaKey(DEFAULT_PACK_ID), legacy);
          localStorage.removeItem(META_KEY);
          return JSON.parse(legacy);
        }
      }
      return null;
    } catch { return null; }
  }
  function writeMeta(packId, m) {
    try { localStorage.setItem(metaKey(packId), JSON.stringify(m)); } catch { /* ignore */ }
  }
  function isInstalled(packId) {
    const m = readMeta(packId);
    return !!(m && m.installedAt);
  }

  async function checkForUpdate(packId) {
    const src = currentSource(packId);
    let remote = null;
    try {
      const resp = await fetch(src.packJsonUrl, { cache: 'no-store' });
      if (resp.ok) remote = await resp.json();
    } catch { /* offline */ }
    if (!remote) return { state: 'unknown', source: src, remote: null };
    const meta = readMeta(packId);
    if (meta && meta.installedAt
        && meta.contentVersion === remote.contentVersion
        && meta.sha256 === remote.sha256) {
      return { state: 'up-to-date', source: src, remote };
    }
    return { state: isInstalled(packId) ? 'available' : 'none', source: src, remote };
  }

  // ── streaming entry cutter (pure) ──
  // feed() download chunks (Uint8Array); the cutter parses header+TOC,
  // then emits each entry's bytes IN FILE ORDER via onEntry(path, Blob).
  // finish() validates the stream consumed every entry. Memory: at most
  // one entry + one network chunk buffered.
  const HEADER_BYTES = 20;  // magic(8) + version(u32) + tocLen(u64)
  const MAGIC = [0x43, 0x43, 0x50, 0x41, 0x43, 0x4b, 0x30, 0x31];  // 'CCPACK01'

  function makeEntryCutter(onEntry) {
    let pre = [];            // pre-TOC chunks
    let preLen = 0;
    let entries = null;      // [{path, offset, length}] sorted by offset
    let pending = [];        // post-header pending chunks
    let pendingLen = 0;
    let cursor = 0;          // absolute file offset of pending[0]'s first byte
    let idx = 0;

    function _concat(chunks, len) {
      const out = new Uint8Array(len);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    }
    // Consume exactly n bytes from pending (caller guarantees availability).
    function _take(n) {
      const out = new Uint8Array(n);
      let o = 0;
      while (n > 0) {
        const c = pending[0];
        const take = Math.min(n, c.length);
        out.set(c.subarray(0, take), o);
        o += take;
        n -= take;
        if (take === c.length) pending.shift();
        else pending[0] = c.subarray(take);
      }
      pendingLen -= o;
      cursor += o;
      return out;
    }
    async function _drain() {
      while (idx < entries.length) {
        const e = entries[idx];
        const gap = e.offset - cursor;      // 8-byte alignment padding
        if (pendingLen < gap + e.length) return;
        if (gap) _take(gap);
        const bytes = _take(e.length);
        idx++;
        await onEntry(e.path, new Blob([bytes]));
      }
    }

    async function feed(chunk) {
      if (!entries) {
        pre.push(chunk);
        preLen += chunk.length;
        if (preLen < HEADER_BYTES) return;
        const head = _concat(pre, preLen);
        for (let i = 0; i < 8; i++) {
          if (head[i] !== MAGIC[i]) throw new Error('not a content pack (bad magic)');
        }
        const view = new DataView(head.buffer, head.byteOffset, head.length);
        const version = view.getUint32(8, true);
        if (version !== 1) throw new Error('unsupported pack format version ' + version);
        const tocLen = view.getUint32(12, true) + view.getUint32(16, true) * 0x100000000;
        const total = HEADER_BYTES + tocLen;
        if (preLen < total) return;   // wait for the rest of the TOC
        const tocText = new TextDecoder().decode(head.subarray(HEADER_BYTES, total));
        const toc = JSON.parse(tocText);
        entries = Object.keys(toc.entries)
          .map((p) => ({ path: p, offset: toc.entries[p].offset, length: toc.entries[p].length }))
          .sort((a, b) => a.offset - b.offset);
        // Bytes past the TOC begin the entry area.
        pending = [head.subarray(total)];
        pendingLen = pending[0].length;
        pre = [];
        cursor = total;
        await _drain();
        return;
      }
      pending.push(chunk);
      pendingLen += chunk.length;
      await _drain();
    }

    function finish() {
      if (!entries) throw new Error('truncated pack (TOC never completed)');
      if (idx !== entries.length) {
        throw new Error('truncated pack (' + idx + '/' + entries.length + ' entries)');
      }
      return entries.length;
    }

    return { feed, finish, entries: () => entries };
  }

  // ── platform sink: where each entry's bytes go ──
  function _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(r.error || new Error('read failed'));
      r.readAsDataURL(blob);
    });
  }
  function _skipped(logical) {
    return SKIP_PREFIXES.some((p) => logical.startsWith(p));
  }
  function makeEntrySink(packId) {
    const plugins = global.Capacitor && global.Capacitor.Plugins;
    const fs = plugins && plugins.Filesystem;
    const platform = (global.Capacitor && global.Capacitor.getPlatform
      && global.Capacitor.getPlatform()) || 'web';
    if (fs && platform !== 'android') {
      // iOS: real files under Library/CCContentPack/<packId> —
      // LocalServer serves /bundled-data/<logical> from the ACTIVE
      // pack's dir (see active.txt marker + LocalServer.swift).
      const dir = CONTENT_DIR + '/' + (packId || DEFAULT_PACK_ID);
      return async (logical, blob) => {
        if (_skipped(logical)) return;
        const data = await _blobToBase64(blob);
        await fs.writeFile({
          path: dir + '/' + logical,
          data,
          directory: 'LIBRARY',
          recursive: true,
        });
      };
    }
    if (platform === 'android' && global.caches) {
      // Android: store into the SW cache under /pack-files/<packId>/,
      // then overlay the active /bundled-data/* keys (the same
      // mechanism live-update's updateViaCache uses).
      const pid = packId || DEFAULT_PACK_ID;
      let cachePromise = null;
      const open = () => (cachePromise || (cachePromise = caches.open(ANDROID_CACHE)));
      return async (logical, blob) => {
        if (_skipped(logical)) return;
        const cache = await open();
        const resp = () => new Response(blob, {
          headers: { 'Content-Type': mimeFor(logical) },
        });
        await cache.put('/pack-files/' + pid + '/' + logical, resp());
        await cache.put('/bundled-data/' + logical, resp());
      };
    }
    // Web/dev: no-op sink (browser mode isn't a pack target).
    return async () => {};
  }

  // Activate a pack at the native layer: iOS writes the active.txt
  // marker LocalServer reads per request; Android re-points the
  // /bundled-data/* cache keys at the pack's stored files.
  async function setActiveNative(packId) {
    const pid = packId || DEFAULT_PACK_ID;
    const plugins = global.Capacitor && global.Capacitor.Plugins;
    const fs = plugins && plugins.Filesystem;
    const platform = (global.Capacitor && global.Capacitor.getPlatform
      && global.Capacitor.getPlatform()) || 'web';
    if (fs && platform !== 'android') {
      await fs.writeFile({
        path: CONTENT_DIR + '/' + ACTIVE_FILE,
        data: pid,
        directory: 'LIBRARY',
        recursive: true,
      });
      return;
    }
    if (platform === 'android' && global.caches) {
      const cache = await caches.open(ANDROID_CACHE);
      const keys = await cache.keys();
      // Clear current /bundled-data overlay, then copy the pack's
      // stored entries into place (cache-to-cache, bounded per entry).
      for (const req of keys) {
        const p = new URL(req.url).pathname;
        if (p.startsWith('/bundled-data/')) await cache.delete(req);
      }
      const prefix = '/pack-files/' + pid + '/';
      for (const req of keys) {
        const p = new URL(req.url).pathname;
        if (p.startsWith(prefix)) {
          const src = await cache.match(req);
          if (src) await cache.put('/bundled-data/' + p.slice(prefix.length), src);
        }
      }
    }
  }

  // ── the download ──
  async function download(packId, onStatus) {
    if (typeof packId === 'function') { onStatus = packId; packId = null; }
    packId = packId || DEFAULT_PACK_ID;
    const platform = (global.Capacitor && global.Capacitor.getPlatform
      && global.Capacitor.getPlatform()) || 'web';
    if (platform !== 'ios' && platform !== 'android') {
      throw new Error('the creature pack is a mobile (Capacitor) flow');
    }
    const src = currentSource(packId);
    const manResp = await fetch(src.packJsonUrl, { cache: 'no-store' });
    if (!manResp.ok) throw new Error('pack.json: HTTP ' + manResp.status);
    const manifest = await manResp.json();

    if (onStatus) onStatus({ phase: 'download', downloaded: 0, total: manifest.totalBytes || 0, entries: 0 });
    const resp = await fetch(src.packBinUrl, { cache: 'no-store' });
    if (!resp.ok) throw new Error('pack.bin: HTTP ' + resp.status);
    const total = Number(resp.headers.get('content-length')) || manifest.totalBytes || 0;

    const sink = makeEntrySink(packId);
    let entries = 0;
    const cutter = makeEntryCutter(async (logical, blob) => {
      await sink(logical, blob);
      entries++;
      if (onStatus) onStatus({ phase: 'install', downloaded, total, entries });
    });

    let downloaded = 0;
    const reader = resp.body.getReader();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      downloaded += r.value.length;
      if (onStatus) onStatus({ phase: 'download', downloaded, total, entries });
      await cutter.feed(r.value);
    }
    const count = cutter.finish();

    const meta = {
      packId,
      contentVersion: manifest.contentVersion || null,
      sha256: manifest.sha256 || null,
      bytes: downloaded,
      entryCount: count,
      installedAt: Date.now(),
      source: src.source,
    };
    writeMeta(packId, meta);
    // A fresh download of the ACTIVE pack re-points the native layer at
    // it (fresh installs default to creature-fusion).
    const activeId = (global.Packs && global.Packs.active)
      ? global.Packs.active() : DEFAULT_PACK_ID;
    if (activeId === packId || !readMeta(activeId)) {
      try { await setActiveNative(packId); } catch (_) { /* best-effort */ }
    }
    if (onStatus) onStatus({ phase: 'done', downloaded, total, entries });
    return meta;
  }

  // Remove an installed pack (iOS files / Android cache entries) +
  // meta. The app falls back to whatever the bundle provides.
  async function deletePackData(packId) {
    packId = packId || DEFAULT_PACK_ID;
    const plugins = global.Capacitor && global.Capacitor.Plugins;
    const fs = plugins && plugins.Filesystem;
    const platform = (global.Capacitor && global.Capacitor.getPlatform
      && global.Capacitor.getPlatform()) || 'web';
    if (fs && platform !== 'android') {
      try {
        await fs.rmdir({ path: CONTENT_DIR + '/' + packId, directory: 'LIBRARY', recursive: true });
      } catch { /* never existed */ }
    } else if (platform === 'android' && global.caches) {
      try {
        const cache = await caches.open(ANDROID_CACHE);
        const keys = await cache.keys();
        const prefix = '/pack-files/' + packId + '/';
        for (const req of keys) {
          const p = new URL(req.url).pathname;
          if (p.startsWith(prefix) || p.startsWith('/bundled-data/')) {
            await cache.delete(req);
          }
        }
      } catch { /* best-effort */ }
    }
    try { localStorage.removeItem(metaKey(packId)); } catch { /* ignore */ }
  }

  global.PackInstall = {
    sourceForMode, currentSource, readMeta, isInstalled,
    checkForUpdate, download, deletePackData, setActiveNative,
    // exposed for tests:
    makeEntryCutter, mimeFor, metaKey, META_KEY, CONTENT_DIR, SKIP_PREFIXES,
  };

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
