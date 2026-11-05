// Settings → Upload logs: the HTTP half (static/index.html
// uploadLogsToServer) plus the wiring guards for the status line.
//
// Why this exists: the button used to fire a fetch and flash "✓ uploaded"
// for two seconds — or nothing at all, when the tunnel hung. It reported
// success on any 2xx reply, including an HTML error page from a proxy,
// and its failures were invisible afterwards. These checks pin the
// behaviour that replaced it: a hard timeout, a reason for every failure
// kind, and no success without the server's own confirmation.
//
// Run: node tests/upload-logs.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');

// Same brace-matching extractor the other index.html-aware tests use
// (it skips strings and comments, which this file is full of).
function extract(marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++) { if (src[i] === '\\') i++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const timeoutConst = src.match(/const LOGS_UPLOAD_TIMEOUT_MS = (\d+);/);
ok(!!timeoutConst, 'index.html: LOGS_UPLOAD_TIMEOUT_MS is a named constant');
const timeoutMs = timeoutConst ? Number(timeoutConst[1]) : 20000;
ok(timeoutMs > 0 && timeoutMs <= 30000, `upload timeout is sane (${timeoutMs} ms)`);

const fnSrc = `const LOGS_UPLOAD_TIMEOUT_MS = ${timeoutMs};\n`
  + extract('async function uploadLogsToServer');

// Build the function with a stubbed fetch; everything else it touches
// (AbortController, setTimeout, JSON, Date, Math, String, Object) is a
// real global under node.
function build(fetchStub) {
  return new Function('fetch', fnSrc + '\nreturn uploadLogsToServer;')(fetchStub);
}

// A fetch stub that answers with one canned response and records the call.
function answering(status, body, opts = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    if (opts.throws) throw opts.throws;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    };
  };
  f.calls = calls;
  return f;
}

// A stub that never answers until the request is aborted, like a request
// stuck on a tunnel that will not respond.
function hanging() {
  const calls = [];
  const f = (url, init) => {
    calls.push({ url, init });
    return new Promise((resolve, reject) => {
      const sig = init && init.signal;
      if (sig) sig.addEventListener('abort', () => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };
  f.calls = calls;
  return f;
}

(async () => {
  // ── success ──
  {
    const f = answering(200, JSON.stringify({ ok: true, saved: 'logs/Grak_1793.txt' }));
    const r = await build(f)({ name: 'Grak', text: 'hello logs', url: 'https://x/upload-logs' });
    ok(r.ok === true, 'success: ok true');
    ok(r.saved === 'logs/Grak_1793.txt', 'success: saved path carried back');
    ok(r.bytes === 'hello logs'.length, 'success: byte count reported');
    ok(r.status === 200, 'success: status reported');
    ok(Number.isFinite(r.ms), 'success: elapsed ms reported');
    ok(f.calls.length === 1, 'success: exactly one request');
    ok(f.calls[0].url === 'https://x/upload-logs', 'success: posts the URL it was given');
    ok(f.calls[0].init.method === 'POST', 'success: POST');
    ok(f.calls[0].init.headers['Content-Type'] === 'application/json', 'success: JSON content type');
    const sent = JSON.parse(f.calls[0].init.body);
    ok(sent.backupName === 'Grak' && sent.logs === 'hello logs', 'success: body carries name + dump');
  }

  // ── the server says why (JSON 4xx) ──
  {
    const f = answering(400, JSON.stringify({ error: 'missing logs' }));
    const r = await build(f)({ name: 'Grak', text: 'x', url: '/upload-logs' });
    ok(r.ok === false, 'http 400: not ok');
    ok(r.kind === 'http', 'http 400: kind http');
    ok(r.status === 400, 'http 400: status kept');
    ok(r.error === 'missing logs', 'http 400: server error text surfaces verbatim');
  }

  // ── a proxy/tunnel HTML page is not a success ──
  {
    const html = '<html><head><title>502 Bad Gateway</title></head><body>bad gateway</body></html>';
    const f = answering(502, html);
    const r = await build(f)({ name: 'Grak', text: 'x', url: '/upload-logs' });
    ok(r.ok === false, 'http 502 html: not ok');
    ok(r.kind === 'http', 'http 502 html: kind http');
    ok(/HTTP 502/.test(r.error), 'http 502 html: names the status');
    ok(/bad gateway/i.test(r.error), 'http 502 html: keeps a snippet of the page');
    ok(!/[<>]/.test(r.error), 'http 502 html: snippet has its markup stripped');
  }

  // ── 200 with an unparseable body is NOT a success ──
  {
    const f = answering(200, '<html>Cloudflare will not let you through</html>');
    const r = await build(f)({ name: 'Grak', text: 'x', url: '/upload-logs' });
    ok(r.ok === false, '200 html: not reported as uploaded');
    ok(r.kind === 'reply', '200 html: kind reply');
    ok(/did not confirm/.test(r.error), '200 html: says the server did not confirm');
  }
  {
    const f = answering(200, JSON.stringify({ ok: false }));
    const r = await build(f)({ name: 'Grak', text: 'x', url: '/upload-logs' });
    ok(r.ok === false && r.kind === 'reply', '200 {ok:false}: not reported as uploaded');
  }

  // ── network-level failure (WebKit's "Load failed") ──
  {
    const err = new TypeError('Load failed');
    const f = answering(200, '', { throws: err });
    const r = await build(f)({ name: 'Grak', text: 'x', url: 'https://poke.example/upload-logs' });
    ok(r.ok === false, 'network: not ok');
    ok(r.kind === 'network', 'network: kind network');
    ok(r.error === 'Load failed', 'network: keeps the platform message');
    ok(r.status === 0, 'network: no status');
  }

  // ── timeout: a request that never answers is cut off with a reason ──
  {
    const f = hanging();
    const r = await build(f)({ name: 'Grak', text: 'x', url: '/upload-logs', timeoutMs: 40 });
    ok(r.ok === false, 'timeout: not ok');
    ok(r.kind === 'timeout', 'timeout: kind timeout');
    ok(/no reply in \d+ s/.test(r.error), 'timeout: says how long it waited');
  }

  // ── the UI wiring (string guards) ──
  ok(/id="copyLogsStatus"[^>]*role="status"/.test(src),
    'index.html: the status line is a live region (screen readers announce the result)');
  ok(src.includes('flex: 1 1 100%'),
    'index.html: the status line takes its own row (long messages wrap)');
  ok(src.includes('await uploadLogsToServer('),
    'index.html: the Upload button goes through uploadLogsToServer');
  ok(src.includes('const tick = setInterval('),
    'index.html: uploads show a live "still going" readout');
  ok(/upBtn\.disabled = true/.test(src) && /upBtn\.disabled = false/.test(src),
    'index.html: the button locks while uploading and unlocks after');
  ok(src.includes('noteLogsUpload(res, host)'), 'index.html: outcomes are recorded');
  ok(src.includes("const LAST_UPLOAD_KEY = 'cc.lastLogsUpload'")
    && src.includes('rememberUpload(true, msg)') && src.includes('rememberUpload(false, msg)'),
    'index.html: the last outcome survives a reload (and says when it happened)');
  ok(src.includes('lines.push(`[upload]'), 'index.html: the dump carries the upload history');
  ok(src.includes("window._ccServerUrl('save', '/upload-logs')"),
    'index.html: /upload-logs still routed via the save server');
  ok(!src.includes('flash(`✓ uploaded as'),
    'index.html: the old flash-a-success-without-checking path is gone');
  ok(fnSrc.includes('await resp.text()') && !fnSrc.includes('await resp.json('),
    'uploadLogsToServer: replies are read as text first (an HTML page can explain a failure)');

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
