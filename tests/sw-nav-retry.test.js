// iOS white screen: a page load (navigation) that hits LocalServer while
// it's down after a resume must not end as an empty 504 (a blank white
// page nothing retries). static/sw.js retries the page fetch for a few
// seconds, then answers a tiny self-reloading page.
//
// Run: node tests/sw-nav-retry.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'sw.js'), 'utf8');

function makeSW(hostname, fetchImpl) {
  const listeners = {};
  let waited = 0;
  const ctx = {
    self: { location: { hostname }, addEventListener: (t, f) => { listeners[t] = f; }, skipWaiting() {}, clients: { claim() {} } },
    location: { origin: `http://${hostname}:1234`, hostname },
    caches: { match: async () => undefined, open: async () => ({ match: async () => undefined, put: async () => {}, keys: async () => [] }), keys: async () => [], delete: async () => true },
    fetch: fetchImpl,
    Response: class { constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; this.headers = new Map(Object.entries((init && init.headers) || {})); } },
    URL, Promise, console,
    setTimeout: (f, ms) => { waited += ms; f(); },   // fake time
  };
  ctx.self.addEventListener = (t, f) => { listeners[t] = f; };
  ctx.addEventListener = ctx.self.addEventListener;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const nav = (mode = 'navigate') => new Promise((resolve) => {
    listeners.fetch({
      request: { method: 'GET', url: `http://${hostname}:1234/`, mode, headers: { get: () => null } },
      respondWith: (p) => Promise.resolve(p).then(resolve),
    });
  });
  return { nav, waited: () => waited };
}

(async () => {
  // Server down for the first 3 tries, then back.
  {
    let calls = 0;
    const sw = makeSW('localhost', async () => { calls++; if (calls <= 3) throw new TypeError('Load failed'); return { status: 200, body: 'page' }; });
    const res = await sw.nav();
    ok(res.status === 200 && res.body === 'page', 'page load retries until LocalServer is back');
    ok(calls === 4, `stops retrying once it answers (${calls} tries)`);
  }
  // Server never comes back within the window → self-reloading page.
  {
    let calls = 0;
    const sw = makeSW('localhost', async () => { calls++; throw new TypeError('Load failed'); });
    const res = await sw.nav();
    ok(res.status === 503 && /location\.reload\(\)/.test(res.body) && /Loading/.test(res.body),
      'still down → a page that reloads itself (not an empty 504)');
    ok(res.headers.get('Content-Type').startsWith('text/html'), 'served as HTML');
    ok(calls >= 5 && sw.waited() >= 5000 && sw.waited() <= 10000, `tries for several seconds first (${calls} tries, ${sw.waited()} ms)`);
  }
  // A 5xx is retried too; a 404 is passed through.
  {
    let calls = 0;
    const sw = makeSW('localhost', async () => { calls++; return { status: calls < 2 ? 503 : 404, body: '' }; });
    const res = await sw.nav();
    ok(res.status === 404 && calls === 2, '5xx retried, 4xx returned as is');
  }
  // Non-navigation requests and the web PWA keep the old behaviour.
  {
    const sw = makeSW('localhost', async () => { throw new TypeError('Load failed'); });
    const res = await sw.nav('cors');
    ok(res.status === 504 && sw.waited() === 0, 'non-page requests: immediate 504 as before');
  }
  {
    const sw = makeSW('poke.example.org', async () => { throw new TypeError('offline'); });
    const res = await sw.nav();
    ok(res.status === 504 && sw.waited() === 0, 'web PWA (not localhost): unchanged');
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
