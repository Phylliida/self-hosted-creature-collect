// Regression guards for the Oct-2026 "native saves silently fail" bug.
//
// The gzip-save client sent `Content-Encoding: gzip` on a CROSS-ORIGIN
// POST (the native apps load from localhost and post to the backend), but
// run.py's CORS preflight only allowed `Content-Type, X-Download`. The
// browser failed the preflight, the request never left the device, and the
// service worker relayed the failure as an anonymous 504 — so every native
// save from those builds failed with nothing pointing at the cause, and
// auto-backup retried (rebuilding a multi-MB payload) on every resume.
//
// Covers:
//   (1) client/server header contract — every non-safelisted header
//       saveToServer sends is in run.py's Access-Control-Allow-Headers
//   (2) maybeAutoBackup — the live function, run in a vm: 24h gate,
//       failure backoff, success clears the backoff, thrown errors back off
//   (3) sw.js — the live fetch handler: non-GET requests bypass the SW;
//       a failed default-branch fetch answers with a TAGGED 504
//
// Run: node tests/save-resilience.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
const runPy = fs.readFileSync(path.join(root, 'run.py'), 'utf8');
const swSrc = fs.readFileSync(path.join(root, 'static', 'sw.js'), 'utf8');

// Brace-matched slice of a function body starting at `marker`. Skips
// strings, template literals and comments so braces inside them don't
// confuse the matcher.
function sliceBlock(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced block: ' + marker);
}

// ── (1) client/server CORS header contract ────────────────────────────
{
  const saveFn = sliceBlock(indexSrc, 'async function saveToServer(opts)');
  const fetchCall = saveFn.slice(saveFn.indexOf("fetch(_serverUrl('save'"));
  const headersObj = fetchCall.match(/headers:\s*\{([^}]*)\}/);
  ok(!!headersObj, 'saveToServer passes an inline headers object');
  const sent = headersObj
    ? [...headersObj[1].matchAll(/['"]?([A-Za-z-]+)['"]?\s*:/g)].map((m) => m[1].toLowerCase())
    : [];
  ok(!/Content-Encoding/i.test(saveFn.replace(/\/\/.*$/gm, '')),
     'saveToServer no longer sets Content-Encoding (server sniffs gzip magic)');
  const allowLine = runPy.match(/Access-Control-Allow-Headers"\]\s*=\s*\\?\s*"([^"]+)"/);
  ok(!!allowLine, 'found Access-Control-Allow-Headers in run.py');
  const allowed = new Set((allowLine ? allowLine[1] : '').split(',').map((h) => h.trim().toLowerCase()));
  // CORS-safelisted request headers never need preflight permission
  // (Content-Type only for the three form/text types — application/json
  // is NOT safelisted, so it must be allowed explicitly).
  const SAFELISTED = new Set(['accept', 'accept-language', 'content-language']);
  for (const h of sent) {
    if (SAFELISTED.has(h)) continue;
    ok(allowed.has(h), `client header "${h}" is allowed by the server preflight`);
  }
  ok(allowed.has('content-encoding'),
     'server still allows Content-Encoding (older gzip clients in the field send it)');
}

// ── (2) maybeAutoBackup backoff (live function in a vm) ───────────────
{
  const constsStart = indexSrc.indexOf('const AUTO_BACKUP_RETRY_MS');
  ok(constsStart > 0, 'AUTO_BACKUP_RETRY_MS declared');
  const fnSrc = sliceBlock(indexSrc, 'async function maybeAutoBackup()');
  const consts = indexSrc.slice(constsStart, indexSrc.indexOf('let _autoBackupBusy', constsStart));

  function harness({ wifi = true, saveResult = true, saveThrows = false } = {}) {
    const store = new Map();
    const calls = { save: 0 };
    const ctx = {
      Date, Number, String, isFinite,
      navigator: { onLine: true },
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      },
      isConfirmedWifi: async () => wifi,
      saveToServer: async () => {
        calls.save++;
        if (saveThrows) throw new Error('payload build blew up');
        return saveResult;
      },
    };
    vm.createContext(ctx);
    vm.runInContext(consts + '\nlet _autoBackupBusy = false;\n' + fnSrc +
      '\nthis.maybeAutoBackup = maybeAutoBackup; this.RETRY = AUTO_BACKUP_RETRY_MS;' +
      '\nthis.FAIL_KEY = AUTO_BACKUP_FAIL_KEY;', ctx);
    store.set('cc.autoBackup', '1');
    store.set('cc.backupName', 'Grak');
    return { ctx, store, calls };
  }

  (async () => {
    // Failure → backoff stamp; immediate retry suppressed.
    {
      const h = harness({ saveResult: false });
      await h.ctx.maybeAutoBackup();
      ok(h.calls.save === 1, 'first auto-backup attempt runs');
      ok(h.store.has(h.ctx.FAIL_KEY), 'failed attempt records the backoff stamp');
      await h.ctx.maybeAutoBackup();
      ok(h.calls.save === 1, 'retry inside the backoff window is skipped (no payload rebuild)');
      // Expire the backoff.
      h.store.set(h.ctx.FAIL_KEY, String(Date.now() - h.ctx.RETRY - 1000));
      await h.ctx.maybeAutoBackup();
      ok(h.calls.save === 2, 'retry after the backoff window runs');
    }
    // Success clears the stamp.
    {
      const h = harness({ saveResult: true });
      h.store.set(h.ctx.FAIL_KEY, String(Date.now() - h.ctx.RETRY - 1000));
      await h.ctx.maybeAutoBackup();
      ok(h.calls.save === 1 && !h.store.has(h.ctx.FAIL_KEY), 'successful save clears the backoff stamp');
    }
    // Throwing save also backs off.
    {
      const h = harness({ saveThrows: true });
      await h.ctx.maybeAutoBackup();
      ok(h.store.has(h.ctx.FAIL_KEY), 'a thrown error also records the backoff stamp');
    }
    // 24h success gate unchanged.
    {
      const h = harness();
      h.store.set('cc.lastSaveAt', String(Date.now() - 60 * 1000));
      await h.ctx.maybeAutoBackup();
      ok(h.calls.save === 0, 'recent successful save still gates auto-backup');
    }
    // Not on confirmed WiFi → no attempt, no backoff stamp.
    {
      const h = harness({ wifi: false });
      await h.ctx.maybeAutoBackup();
      ok(h.calls.save === 0 && !h.store.has(h.ctx.FAIL_KEY), 'no WiFi → no attempt and no backoff');
    }

    // ── (3) sw.js fetch handler (live script in a vm) ─────────────────
    {
      const listeners = {};
      let fetchCalls = 0;
      const ctx = {
        URL, Response, Headers, console,
        location: new URL('http://localhost:60497/sw.js'),
        caches: {
          match: async () => undefined,
          open: async () => ({ match: async () => undefined, put: async () => {}, keys: async () => [], delete: async () => {} }),
        },
        fetch: async () => { fetchCalls++; throw new TypeError('Load failed'); },
      };
      ctx.self = {
        addEventListener: (t, cb) => { listeners[t] = cb; },
        location: ctx.location,
        skipWaiting: () => {},
        clients: { claim: async () => {} },
      };
      vm.createContext(ctx);
      vm.runInContext(swSrc, ctx);
      ok(typeof listeners.fetch === 'function', 'sw.js registers a fetch listener');

      const mkEvent = (method, url) => {
        const ev = {
          request: { method, url, headers: new Headers() },
          responded: null,
          respondWith(p) { this.responded = p; },
        };
        return ev;
      };
      const post = mkEvent('POST', 'https://poke.phylliidaassets.org/save');
      listeners.fetch(post);
      ok(post.responded === null, 'POST /save bypasses the service worker');
      const postLocal = mkEvent('POST', 'http://localhost:60497/upload-logs');
      listeners.fetch(postLocal);
      ok(postLocal.responded === null, 'same-origin POST also bypasses the service worker');

      const get = mkEvent('GET', 'http://localhost:60497/bundled-data/sprite-packs/25.pack');
      listeners.fetch(get);
      ok(get.responded !== null, 'GET still goes through the default branch');
      const resp = await get.responded;
      ok(resp.status === 504, 'failed default-branch fetch answers 504');
      ok(resp.headers.get('X-CC-SW') === 'fetch-failed', 'synthetic 504 is tagged X-CC-SW: fetch-failed');
      ok(fetchCalls === 1, 'the SW attempted exactly one fetch');
    }

    console.log(`save-resilience: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
