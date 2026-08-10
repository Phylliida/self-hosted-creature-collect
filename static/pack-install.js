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
  function sourceForMode(mode, apiBase, hfRepo, packId, native) {
    const repo = hfRepo || 'TessaCoil/creature-pack';
    const pid = packId || DEFAULT_PACK_ID;
    // Generation-subset variants live in a subfolder of the same repo /
    // local pack dir (e.g. gen-1-2/pack.bin). '' for plain packs.
    const gens = (global.Packs && global.Packs.subdirFor)
      ? global.Packs.subdirFor(pid) : '';
    const prefix = gens ? gens + '/' : '';
    const suffix = native ? '-native' : '';
    if (mode === 'static-hf') {
      return {
        source: 'hf',
        packBinUrl: `${HF_BASE}${repo}/resolve/main/${prefix}pack${suffix}.bin`,
        packJsonUrl: `${HF_BASE}${repo}/resolve/main/${prefix}pack${suffix}.json`,
      };
    }
    const base = String(apiBase || '').replace(/\/$/, '');
    return {
      source: 'local',
      packBinUrl: `${base}/pack-files/${pid}/${prefix}pack${suffix}.bin`,
      packJsonUrl: `${base}/pack-files/${pid}/${prefix}pack${suffix}.json`,
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
  function _isNativePlatform() {
    if (typeof global.Capacitor === 'undefined' || !global.Capacitor.getPlatform) {
      return false;
    }
    const p = global.Capacitor.getPlatform();
    return p === 'ios' || p === 'android';
  }
  function currentSource(packId, native) {
    return sourceForMode(_mode(), global.CC_API_BASE || '', _hfRepoFor(packId), packId, native);
  }
  async function _fetchManifest(src) {
    try {
      const resp = await fetch(src.packJsonUrl, { cache: 'no-store' });
      if (resp.ok) return await resp.json();
    } catch { /* offline */ }
    return null;
  }
  // Effective download source: native builds request pack-native.* when
  // the server has it, falling back to the full pack for older servers /
  // solo packs. Returns { src, manifest } with manifest already parsed —
  // callers reuse it instead of re-fetching.
  async function _resolveDownload(packId) {
    const fullSrc = currentSource(packId);
    if (!_isNativePlatform()) {
      return { src: fullSrc, manifest: await _fetchManifest(fullSrc) };
    }
    const nativeSrc = currentSource(packId, true);
    const nativeManifest = await _fetchManifest(nativeSrc);
    if (nativeManifest) return { src: nativeSrc, manifest: nativeManifest };
    return { src: fullSrc, manifest: await _fetchManifest(fullSrc) };
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

  // A gen-subset pack whose installed variant differs from the current
  // selection counts as "update available" even when the contentVersion
  // matches — switching gens/families means downloading the other
  // variant. Compared on the subdir ('gen-1-2-fam'), which encodes both.
  function _metaMatches(meta, remote, selGens) {
    return !!(meta && meta.installedAt
      && meta.contentVersion === remote.contentVersion
      && meta.sha256 === remote.sha256
      && (!selGens || (meta.gens || '') === selGens));
  }

  async function checkForUpdate(packId) {
    const { src, manifest: remote } = await _resolveDownload(packId);
    if (!remote) return { state: 'unknown', source: src, remote: null };
    const meta = readMeta(packId);
    const selGens = (global.Packs && global.Packs.subdirFor)
      ? global.Packs.subdirFor(packId || DEFAULT_PACK_ID) : '';
    if (_metaMatches(meta, remote, selGens)) {
      return { state: 'up-to-date', source: src, remote };
    }
    // Native-variant rollout: a client still holding the FULL pack from
    // before pack-native.* existed has the same content in a bigger
    // transport. If the full manifest matches the install, report
    // up-to-date instead of flagging a pointless re-download.
    if (_isNativePlatform() && meta && meta.installedAt) {
      const fullSrc = currentSource(packId);
      if (fullSrc.packJsonUrl !== src.packJsonUrl) {
        const fullRemote = await _fetchManifest(fullSrc);
        if (fullRemote && _metaMatches(meta, fullRemote, selGens)) {
          return { state: 'up-to-date', source: fullSrc, remote: fullRemote };
        }
      }
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

  function makeEntryCutter(onEntry, opts) {
    const verify = !!(opts && opts.verify);
    const subtle = (global.crypto && global.crypto.subtle) || null;
    let pre = [];            // pre-TOC chunks
    let preLen = 0;
    let entries = null;      // [{path, offset, length, sha256}] sorted by offset
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
        // Integrity: the TOC carries each entry's sha256 — verify as we
        // stream (native crypto, per-entry buffers are small). A
        // mismatch throws; the download's resume state lets the retry
        // refetch just the bad tail. Skipped when WebCrypto is absent.
        if (verify && subtle && e.sha256) {
          const digest = await subtle.digest('SHA-256', bytes);
          const hex = Array.from(new Uint8Array(digest))
            .map((x) => x.toString(16).padStart(2, '0')).join('');
          if (hex !== e.sha256) {
            throw new Error('pack entry sha256 mismatch: ' + e.path);
          }
        }
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
          .map((p) => ({
            path: p,
            offset: toc.entries[p].offset,
            length: toc.entries[p].length,
            sha256: toc.entries[p].sha256 || null,
          }))
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
  async function _blobToBase64(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    }
    return (typeof btoa === 'function')
      ? btoa(bin)
      : Buffer.from(bin, 'binary').toString('base64');
  }
  function _skipped(logical, packId) {
    // Sprite sheets are only the FUSION packs' web-crop input (native
    // cell art comes from sprite-packs/), so they're skipped there to
    // halve write time + disk. Solo packs keep EVERYTHING — neopets
    // monster art lives under sprites/ too, and skipping it leaves a
    // pack with no visible creatures.
    const pid = packId || DEFAULT_PACK_ID;
    if (pid !== DEFAULT_PACK_ID) {
      const def = global.Packs && global.Packs.get ? global.Packs.get(pid) : null;
      if (!def || def.solo) return false;
    }
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
        if (_skipped(logical, packId)) return;
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
      // Only the ACTIVE pack may write the live /bundled-data/* overlay.
      // Downloading a non-active pack (pack picker downloads before
      // switching) must not clobber the running pack's data — its
      // activation goes through setActiveNative once the switch happens.
      // (No Packs registry — headless tests — treats it as active.)
      const isActivePack = !global.Packs || typeof global.Packs.active !== 'function'
        || global.Packs.active() === pid;
      let cachePromise = null;
      const open = () => (cachePromise || (cachePromise = caches.open(ANDROID_CACHE)));
      return async (logical, blob) => {
        if (_skipped(logical, packId)) return;
        const cache = await open();
        const resp = () => new Response(blob, {
          headers: { 'Content-Type': mimeFor(logical) },
        });
        await cache.put('/pack-files/' + pid + '/' + logical, resp());
        if (isActivePack) await cache.put('/bundled-data/' + logical, resp());
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
  // ── resumable downloads ──
  // Progress is persisted per pack so an interrupted multi-GB download
  // can resume instead of starting over. Entries are written strictly in
  // file order, so "first K entries written" is a complete description
  // of the state. Resume works by re-fetching just the TOC (two tiny
  // range requests), building a synthetic pack header holding only the
  // REMAINING entries (offsets rebased), then Range-fetching the body
  // from the first unwritten entry and feeding the existing entry
  // cutter — byte-identical outcome to a fresh full download.
  function resumeKey(packId) { return metaKey(packId) + '.resume'; }
  function resumeState(packId) {
    try {
      const raw = localStorage.getItem(resumeKey(packId));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function _writeResume(packId, state) {
    try {
      if (state) localStorage.setItem(resumeKey(packId), JSON.stringify(state));
      else localStorage.removeItem(resumeKey(packId));
    } catch { /* ignore */ }
  }

  // Pure helper (unit-tested): given the parsed TOC JSON text and the
  // number of entries already written, produce the synthetic header
  // bytes + the absolute file offset to Range-resume the body from.
  function makeResumePlan(tocText, entriesDone) {
    const toc = JSON.parse(tocText);
    const all = Object.keys(toc.entries)
      .map((p) => ({ path: p, ...toc.entries[p] }))
      .sort((a, b) => a.offset - b.offset);
    const remaining = all.slice(entriesDone);
    if (!remaining.length) return null;   // nothing left — treat as done
    const base = remaining[0].offset;
    const toc2 = {
      id: toc.id, format: toc.format, contentVersion: toc.contentVersion,
      entries: {},
    };
    // Offsets in the synthetic TOC are absolute within the synthetic
    // stream: headerSize + (old offset − resume base). The header size
    // depends on the TOC text, which contains the offsets — same ≤3
    // pass fixpoint the pack writer uses (content_pack.py).
    let headerSize = 0;
    let toc2Bytes = null;
    for (let pass = 0; pass < 3; pass++) {
      for (const e of remaining) {
        toc2.entries[e.path] = {
          offset: headerSize + (e.offset - base),
          length: e.length, sha256: e.sha256,
        };
      }
      toc2Bytes = new TextEncoder().encode(JSON.stringify(toc2));
      headerSize = HEADER_BYTES + toc2Bytes.length;
    }
    const head = new Uint8Array(headerSize);
    head.set(MAGIC, 0);
    const view = new DataView(head.buffer);
    view.setUint32(8, 1, true);
    view.setUint32(12, toc2Bytes.length, true);   // little-endian u64
    view.setUint32(16, 0, true);
    head.set(toc2Bytes, HEADER_BYTES);
    return { headerBytes: head, rangeStart: base, remaining: remaining.length };
  }

  // Range GET helper: returns the Response only when the server honored
  // the range (206); null when it ignored Range (200) — caller falls
  // back to a full download in that case.
  async function _rangeFetch(url, start, end) {
    const resp = await fetch(url, {
      cache: 'no-store',
      headers: { Range: `bytes=${start}-${end == null ? '' : end - 1}` },
    });
    if (resp.status === 206) return resp;
    if (resp.status === 200) return null;
    throw new Error('range fetch: HTTP ' + resp.status);
  }

  async function download(packId, onStatus) {
    if (typeof packId === 'function') { onStatus = packId; packId = null; }
    packId = packId || DEFAULT_PACK_ID;
    const platform = (global.Capacitor && global.Capacitor.getPlatform
      && global.Capacitor.getPlatform()) || 'web';
    if (platform !== 'ios' && platform !== 'android') {
      throw new Error('the creature pack is a mobile (Capacitor) flow');
    }
    const resolved = await _resolveDownload(packId);
    if (!resolved.manifest) {
      throw new Error('pack manifest unreachable: ' + resolved.src.packJsonUrl);
    }
    const src = resolved.src;
    const manifest = resolved.manifest;
    const total = manifest.totalBytes || 0;
    const gens = (global.Packs && global.Packs.subdirFor)
      ? global.Packs.subdirFor(packId) : '';

    // Resume state is only valid for the EXACT same file (same version +
    // hash + variant). Anything else starts fresh.
    const prev = resumeState(packId);
    let entriesDone = (prev && prev.contentVersion === manifest.contentVersion
      && prev.sha256 === manifest.sha256 && (prev.gens || '') === gens
      && prev.entriesDone > 0) ? prev.entriesDone : 0;

    const sink = makeEntrySink(packId);
    let entries = entriesDone;
    let downloaded = 0;
    let resumePlan = null;

    const cutter = makeEntryCutter(async (logical, blob) => {
      await sink(logical, blob);
      entries++;
      // Persist per entry — a kill between entries must never lose count.
      _writeResume(packId, {
        packId, gens,
        contentVersion: manifest.contentVersion || null,
        sha256: manifest.sha256 || null,
        entriesDone: entries, totalBytes: total,
        downloaded: downloaded + (resumePlan ? resumePlan.rangeStart : 0),
        updatedAt: Date.now(),
      });
      if (onStatus) onStatus({
        phase: 'install',
        downloaded: downloaded + (resumePlan ? resumePlan.rangeStart : 0),
        total, entries,
      });
    }, { verify: true });

    try {
      let resp = null;
      if (entriesDone > 0) {
        // Resume: pull just the header+TOC via ranges, then the body
        // from the first unwritten entry.
        const headResp = await _rangeFetch(src.packBinUrl, 0, HEADER_BYTES);
        let plan = null;
        if (headResp) {
          const headBuf = new Uint8Array(await headResp.arrayBuffer());
          const view = new DataView(headBuf.buffer);
          const tocLen = view.getUint32(12, true) + view.getUint32(16, true) * 0x100000000;
          const tocResp = await _rangeFetch(src.packBinUrl, HEADER_BYTES, HEADER_BYTES + tocLen);
          if (tocResp) {
            plan = makeResumePlan(await tocResp.text(), entriesDone);
          }
        }
        if (plan) {
          resp = await _rangeFetch(src.packBinUrl, plan.rangeStart, null);
          if (resp) {
            resumePlan = plan;
            await cutter.feed(plan.headerBytes);
          }
        } else if (headResp) {
          // TOC read fine but nothing left to write — the interruption
          // happened after the last entry. Skip straight to completion
          // (meta was never written, so the pack still counts as
          // uninstalled until we write it below).
          const meta = {
            packId,
            contentVersion: manifest.contentVersion || null,
            sha256: manifest.sha256 || null,
            bytes: total,
            entryCount: entriesDone,
            installedAt: Date.now(),
            source: src.source,
            gens,
          };
          writeMeta(packId, meta);
          _writeResume(packId, null);
          const activeId = (global.Packs && global.Packs.active)
            ? global.Packs.active() : DEFAULT_PACK_ID;
          if (activeId === packId || !readMeta(activeId)) {
            try { await setActiveNative(packId); } catch (_) { /* best-effort */ }
          }
          if (onStatus) onStatus({ phase: 'done', downloaded: total, total, entries });
          return meta;
        }
        // plan/resp null → server ignored Range or nothing to resume:
        // fall through to a fresh full download (idempotent rewrites).
        if (!resp) entries = 0;
      }
      if (!resp) {
        entriesDone = 0;
        if (onStatus) onStatus({ phase: 'download', downloaded: 0, total, entries: 0 });
        resp = await fetch(src.packBinUrl, { cache: 'no-store' });
        if (!resp.ok) throw new Error('pack.bin: HTTP ' + resp.status);
      } else if (onStatus) {
        onStatus({
          phase: 'download',
          downloaded: resumePlan.rangeStart, total, entries,
        });
      }

      const reader = resp.body.getReader();
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        downloaded += r.value.length;
        if (onStatus) onStatus({
          phase: 'download',
          downloaded: downloaded + (resumePlan ? resumePlan.rangeStart : 0),
          total, entries,
        });
        await cutter.feed(r.value);
      }
      const count = cutter.finish();
      const totalEntries = count + (resumePlan ? entriesDone : 0);

      const meta = {
        packId,
        contentVersion: manifest.contentVersion || null,
        sha256: manifest.sha256 || null,
        bytes: downloaded + (resumePlan ? resumePlan.rangeStart : 0),
        entryCount: totalEntries,
        installedAt: Date.now(),
        source: src.source,
        // Which variant was downloaded ('' for non-variant packs) — the
        // subdir ('gen-1-2-fam') encodes gens + families flag, letting the
        // picker show it and checkForUpdate flag a variant switch.
        gens,
      };
      writeMeta(packId, meta);
      _writeResume(packId, null);
      // A fresh download of the ACTIVE pack re-points the native layer at
      // it (fresh installs default to creature-fusion).
      const activeId = (global.Packs && global.Packs.active)
        ? global.Packs.active() : DEFAULT_PACK_ID;
      if (activeId === packId || !readMeta(activeId)) {
        try { await setActiveNative(packId); } catch (_) { /* best-effort */ }
      }
      if (onStatus) onStatus({
        phase: 'done',
        downloaded: meta.bytes, total, entries,
      });
      return meta;
    } catch (err) {
      // Resume state already persisted per entry; mark the error so the
      // UI can offer to continue.
      if (err && typeof err === 'object') err.resumable = entries > 0;
      throw err;
    }
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
    _writeResume(packId, null);
  }

  global.PackInstall = {
    sourceForMode, currentSource, readMeta, isInstalled,
    checkForUpdate, download, deletePackData, setActiveNative,
    resumeState,
    // exposed for tests:
    makeEntryCutter, makeEntrySink, makeResumePlan, mimeFor, metaKey, META_KEY,
    CONTENT_DIR, SKIP_PREFIXES,
  };

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
