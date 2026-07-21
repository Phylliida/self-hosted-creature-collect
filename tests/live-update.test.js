// Guards live-update.js's bundle-wins-unless-server-is-newer rule.
// A plain "different = update" lets a refresh overlay OLDER server
// files over a NEWER bundle (the stale-code-after-app-update bug).
//
// Run: node tests/live-update.test.js
'use strict';
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');

async function runCheck(latest, installedSeed) {
  const logs = [];
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  globalThis._serverScriptVersions = installedSeed;
  globalThis.Capacitor = { Plugins: {} };   // no BundleAccess → early return
  globalThis.document = { readyState: 'loading', addEventListener: () => {} };
  globalThis.window = Object.assign(globalThis, { addEventListener: () => {} });
  delete globalThis.caches;
  const origErr = console.error;
  console.error = (...a) => { logs.push(a.map(String).join(' ')); };
  globalThis.fetch = async () => ({ ok: true, json: async () => latest });
  try {
    delete require.cache[require.resolve(path.join(root, 'static', 'live-update.js'))];
    require(path.join(root, 'static', 'live-update.js'));
    await globalThis.CCLiveUpdate.check({ force: true });
  } finally {
    console.error = origErr;
    delete globalThis.localStorage;
    delete globalThis._serverScriptVersions;
    delete globalThis.Capacitor;
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.fetch;
  }
  return logs.join('\n');
}

async function main() {
  // 1) Server OLDER than the bundle → must NOT "update" (the bug).
  let logs = await runCheck(
    { 'pack-install.js': '2026-07-21 23:21', 'extras.js': '2026-07-21 20:00' },
    { 'pack-install.js': '2026-07-21 23:32', 'extras.js': '2026-07-21 20:00' });
  ok(logs.includes('all up to date') && !logs.includes('update available'),
    '1: older server never overlays a newer bundle');

  // 2) Server strictly newer → update proceeds.
  logs = await runCheck(
    { 'pack-install.js': '2026-07-21 23:33', 'extras.js': '2026-07-21 20:00' },
    { 'pack-install.js': '2026-07-21 23:32', 'extras.js': '2026-07-21 20:00' });
  ok(logs.includes('update available') && logs.includes('pack-install.js'),
    '2: strictly-newer server still updates');

  // 3) File unknown to the bundle → treated as an update.
  logs = await runCheck(
    { 'brand-new.js': '2026-07-21 23:00', 'extras.js': '2026-07-21 20:00' },
    { 'extras.js': '2026-07-21 20:00' });
  ok(logs.includes('update available') && logs.includes('brand-new.js'),
    '3: unknown file counts as an update');

  // 4) Equal versions → quiet.
  logs = await runCheck(
    { 'extras.js': '2026-07-21 20:00' },
    { 'extras.js': '2026-07-21 20:00' });
  ok(logs.includes('all up to date'), '4: equal versions are quiet');

  // 5) Boot cache-bust drops the stale installed-version map on bundle change.
  const indexSrc = require('fs').readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
  ok(indexSrc.includes("localStorage.removeItem('cc.installedVersions')"),
    '5: bundle-change boot script clears cc.installedVersions');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
