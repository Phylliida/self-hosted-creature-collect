// Settings → Upload logs, driven through the real button handler.
//
// tests/upload-logs.test.js covers the HTTP half; this one runs the block
// that wires the buttons against a stub DOM and asserts what the status
// line actually says — the part people were missing ("click and nothing
// happens"). It also pins the two things that made the old version
// unhelpful: no live progress, and no trace of the outcome afterwards.
//
// Run: node tests/upload-logs-ui.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');

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

const blockStart = src.indexOf("{\n    const btn = document.getElementById('copyLogsBtn');");
const blockEnd = src.indexOf('  function haversineM(');
ok(blockStart > 0 && blockEnd > blockStart, 'index.html: the Copy/Upload block is findable');
const blockSrc = src.slice(blockStart, blockEnd);

const timeoutMs = Number((src.match(/const LOGS_UPLOAD_TIMEOUT_MS = (\d+);/) || [])[1] || 20000);
// The small helpers between the upload function and the button block
// (_logsKb, _logsHost, the upload history ring) come along verbatim.
const helpersStart = src.indexOf('  const _logsKb = ');
ok(helpersStart > 0 && helpersStart < blockStart, 'index.html: the helpers sit before the block');
const code = [
  `const LOGS_UPLOAD_TIMEOUT_MS = ${timeoutMs};`,
  extract('async function uploadLogsToServer') + ';',
  src.slice(helpersStart, blockStart),
  blockSrc,
].join('\n');

function stubEl() {
  return {
    textContent: '', dataset: {}, style: {}, disabled: false, hidden: false,
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    classList: { contains: () => false, add() {}, remove() {} },
  };
}

// A sandbox: fresh DOM, storage, window, and a fetch stub. Returns the
// pieces a test needs to pretend it's the user.
function boot(opts = {}) {
  const els = {};
  const byId = (id) => (els[id] = els[id] || stubEl());
  const document = {
    getElementById: byId,
    querySelectorAll: () => [],
    createElement: () => stubEl(),
    body: { appendChild() {}, removeChild() {} },
    execCommand: () => true,
  };
  const store = new Map(Object.entries(opts.storage || {}));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const navigator = { userAgent: 'test-ua', clipboard: opts.clipboard };
  const win = {
    Capacitor: null,
    _ccUploadLog: [],
    _ccServerUrl: opts.serverUrl || ((kind, p) => p),
  };
  if (opts.localStorage) for (const [k, v] of Object.entries(opts.localStorage)) store.set(k, v);
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    if (opts.fetchThrows) throw opts.fetchThrows;
    return { ok: opts.status ? (opts.status >= 200 && opts.status < 300) : true,
      status: opts.status || 200,
      text: async () => opts.body === undefined ? '{"ok":true,"saved":"logs/Grak_1.txt"}' : opts.body };
  };
  new Function('window', 'document', 'localStorage', 'navigator', 'fetch',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    code)(win, document, localStorage, navigator, fetchStub,
      setTimeout, clearTimeout, setInterval, clearInterval);
  const status = () => els.copyLogsStatus.textContent;
  const click = async (id) => {
    const fns = (els[id] && els[id].listeners.click) || [];
    if (!fns.length) throw new Error('no click handler on ' + id);
    for (const fn of fns) await fn();
  };
  return { els, byId, store, win, status, click, calls, document, localStorage, navigator };
}

(async () => {
  // ── no trainer name: say so instead of doing nothing ──
  {
    const t = boot();
    t.byId('startupPhases').textContent = 'the dump';
    await t.click('uploadLogsBtn');
    ok(/set a trainer name/.test(t.status()), 'no name: the status line asks for one');
    ok(t.calls.length === 0, 'no name: nothing is posted');
    ok(t.byId('uploadLogsBtn').disabled === false, 'no name: button left clickable');
  }

  // ── success: size, where it landed, how long, and it stays on screen ──
  {
    const t = boot({ localStorage: { 'cc.backupName': 'Grak' } });
    t.byId('startupPhases').textContent = 'x'.repeat(4000);
    t.byId('versionBadge').textContent = 'v1.2.3';
    await t.click('uploadLogsBtn');
    const s = t.status();
    ok(/^✓ uploaded /.test(s), 'success: status says uploaded');
    ok(/logs\/Grak_1\.txt/.test(s), 'success: names the file the server saved');
    ok(/\d+\.\d KB/.test(s), 'success: shows the size');
    ok(/\(\d+\.\d s\)/.test(s), 'success: shows how long it took');
    ok(t.byId('uploadLogsBtn').disabled === false, 'success: button unlocked');
    ok(t.win._ccUploadLog.length === 1 && t.win._ccUploadLog[0].ok === true,
      'success: recorded in the upload history');
    ok(JSON.parse(t.store.get('cc.lastLogsUpload')).ok === true,
      'success: remembered for the next visit');
    const sent = JSON.parse(t.calls[0].init.body);
    ok(sent.backupName === 'Grak' && sent.logs.includes('xxxxxxxx'),
      'success: posts the trainer name and the dump');
    ok(sent.logs.startsWith('creature-collect v1.2.3'), 'success: dump header carries the version');
  }

  // ── unreachable server: keeps the reason and points at the host ──
  {
    const t = boot({ localStorage: { 'cc.backupName': 'Grak' },
      serverUrl: (k, p) => 'https://poke.example.org' + p,
      fetchThrows: new TypeError('Load failed') });
    await t.click('uploadLogsBtn');
    const s = t.status();
    ok(/^✕ upload failed: Load failed/.test(s), 'network: surfaces the platform message');
    ok(s.includes('poke.example.org'), 'network: names the host it could not reach');
    ok(/WiFi/.test(s), 'network: suggests what to check');
    ok(t.byId('uploadLogsBtn').disabled === false, 'network: button unlocked for a retry');
    ok(JSON.parse(t.store.get('cc.lastLogsUpload')).ok === false,
      'network: the failure is remembered too');
  }

  // ── HTTP error: server's own reason, no false success ──
  {
    const t = boot({ localStorage: { 'cc.backupName': 'Grak' }, status: 400,
      body: '{"error":"invalid name (use letters/digits/._- and spaces)"}' });
    await t.click('uploadLogsBtn');
    ok(/^✕ upload failed: invalid name/.test(t.status()), 'http 400: server error shown verbatim');
  }

  // ── an HTML page with a 2xx: never reported as uploaded ──
  {
    const t = boot({ localStorage: { 'cc.backupName': 'Grak' }, status: 200,
      body: '<html><body>just kidding</body></html>' });
    await t.click('uploadLogsBtn');
    ok(!/✓/.test(t.status()) && /did not confirm/.test(t.status()),
      'bogus 200: says the server did not confirm');
  }

  // ── the last outcome is restored when Settings is opened later ──
  {
    const t = boot({ storage: {
      'cc.lastLogsUpload': JSON.stringify({ t: Date.parse('2026-11-04T18:48:00Z'),
        ok: true, text: '✓ uploaded 31.0 KB → logs/Grak_1793.txt  (0.8 s)' }) } });
    const s = t.status();
    ok(/^last upload /.test(s), 'restore: prefixes the remembered outcome with when it happened');
    ok(/✓ uploaded 31\.0 KB/.test(s), 'restore: keeps the original message');
  }

  // ── copy still works and reports into the same line ──
  {
    const copied = [];
    const t = boot({ clipboard: { writeText: async (s) => { copied.push(s); } } });
    t.byId('startupPhases').textContent = 'dump';
    await t.click('copyLogsBtn');
    ok(copied.length === 1 && copied[0].includes('dump'), 'copy: clipboard got the dump');
    ok(/^✓ copied /.test(t.status()), 'copy: status line says copied');
  }

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
