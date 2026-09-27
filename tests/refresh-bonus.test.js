// Tests the one-time refresh bonus — grantRefreshBonus /
// isRefreshBonusClaimed in static/creatures.js, wired to the bottom-right
// refresh button's inline onclick in index.html.
//
// Contract: the FIRST press of the refresh button pays out 300 Poké Balls
// + 300 Great Balls (on top of whatever's in the bag, starter pack
// included); every later press is a no-op, because the claim flag is what
// gates it. A storage failure must leave the bonus claimable rather than
// burn it, so the flag is written only after the bag write lands.
//
// Same extraction trick as tests/bag-sort.test.js: brace-match the
// functions out of creatures.js and run them in a vm sandbox with a
// stub localStorage.
//
// Run: node tests/refresh-bonus.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'creatures.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf8');

// comment/string-aware brace extractor (same approach as bag-sort.test.js)
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

// Sandbox with the bag helpers + the constants the real file closes over.
// `failNextWrite` lets a test simulate a quota/private-mode failure.
function makeEnv() {
  const store = new Map();
  const ctx = {
    Object, Set, Array, Math, String, Number, JSON,
    console: { error() {}, log() {} },
    BAG_KEY: 'cc.bag.v1',
    REFRESH_BONUS_KEY: 'cc.refreshBonus.v1',
    STARTER_BAG: { poke_ball: 2 },
    REFRESH_BONUS: { poke_ball: 300, great_ball: 300 },
    failNextWrite: false,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => {
        if (ctx.failNextWrite) { ctx.failNextWrite = false; throw new Error('QuotaExceededError'); }
        store.set(k, String(v));
      },
      removeItem: (k) => store.delete(k),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(extract('function readBag('), ctx);
  vm.runInContext(extract('function writeBag('), ctx);
  vm.runInContext(extract('function grantRefreshBonus('), ctx);
  vm.runInContext(extract('function isRefreshBonusClaimed('), ctx);
  const call = (expr) => vm.runInContext(expr, ctx);
  return {
    ctx, store,
    claim: () => call('grantRefreshBonus()'),
    claimed: () => call('isRefreshBonusClaimed()'),
    bag: () => JSON.parse(store.get('cc.bag.v1') || 'null'),
    seedBag: (bag) => store.set('cc.bag.v1', JSON.stringify(bag)),
  };
}

// ── 1. Wiring: the refresh button actually calls the grant ──
const btnAt = html.indexOf('id="emergencyRefresh"');
ok(btnAt > 0, '1: emergencyRefresh button exists in index.html');
const onclickAt = html.indexOf('onclick="', btnAt);
const onclickEnd = html.indexOf('"', onclickAt + 'onclick="'.length);
const onclick = html.slice(onclickAt + 'onclick="'.length, onclickEnd);
const callAt = onclick.indexOf('grantRefreshBonus');
ok(callAt > 0, '1: refresh onclick calls grantRefreshBonus');
ok(callAt < onclick.indexOf('location.reload'),
   '1: the grant runs before the reload (so the bag write lands)');

// ── 2. First claim pays out, on top of the starter pack ──
{
  const env = makeEnv();
  ok(env.claimed() === false, '2: unclaimed before the first press');
  ok(env.claim() === true, '2: first press returns true (paid out)');
  const bag = env.bag();
  ok(bag.poke_ball === 302, '2: 300 on top of the 2-ball starter pack → 302');
  ok(bag.great_ball === 300, '2: 300 Great Balls granted');
  ok(env.claimed() === true, '2: flag set after the grant');
}

// ── 3. Second and later presses are no-ops ──
{
  const env = makeEnv();
  env.claim();
  const after = JSON.stringify(env.bag());
  ok(env.claim() === false, '3: second press returns false');
  ok(env.claim() === false, '3: third press still false');
  ok(JSON.stringify(env.bag()) === after, '3: bag unchanged by repeat presses');
}

// ── 4. Existing bag contents are topped up, not replaced ──
{
  const env = makeEnv();
  env.seedBag({ poke_ball: 7, great_ball: 1, test_orb: 4 });
  ok(env.claim() === true, '4: claims against a non-empty bag');
  const bag = env.bag();
  ok(bag.poke_ball === 307, '4: poke_ball 7 + 300');
  ok(bag.great_ball === 301, '4: great_ball 1 + 300');
  ok(bag.test_orb === 4, '4: unrelated items untouched');
}

// ── 5. A failed bag write doesn't burn the bonus ──
{
  const env = makeEnv();
  env.seedBag({ poke_ball: 5 });          // pre-seeded so readBag doesn't write
  env.ctx.failNextWrite = true;           // the bag write inside the grant fails
  ok(env.claim() === false, '5: failed write reports false');
  ok(env.claimed() === false, '5: claim flag NOT set after a failed write');
  ok(env.claim() === true, '5: retry pays out once storage recovers');
  ok(env.bag().poke_ball === 305 && env.bag().great_ball === 300,
     '5: retry granted exactly once (305 / 300)');
}

// ── 6. The claim flag rides in the save payload ──
ok(/refreshBonusClaimed\s*:/.test(html),
   '6: export payload carries refreshBonusClaimed');
ok(/data\.refreshBonusClaimed === true[\s\S]{0,120}cc\.refreshBonus\.v1/.test(html),
   '6: import adopts the flag');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
