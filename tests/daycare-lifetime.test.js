// Tests the lifetime daycare store (cc.daycareLifetime.v1) in
// static/creatures.js: that a creature's daycare distance, claimed
// milestones, and candy-conversion state survive removal + re-entry
// so already-collected loot can't be replayed.
//
// Run: node tests/daycare-lifetime.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

// comment-aware brace extractor (same approach as tests/guaranteed-catch.test.js)
const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'creatures.js'), 'utf8');
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

// In-memory localStorage + the minimal dependency surface the daycare
// slot/lifetime functions touch. `extra` overrides per scenario (e.g.
// readCapturedCreatures, _grantLoot).
function makeCtx(extra) {
  const store = {};
  const ctx = Object.assign({
    Object, Set, Map, Array, Math, String, Number, JSON, Date, console,
    DAYCARE_SLOTS_KEY: 'cc.daycareSlots.v1',
    DAYCARE_LIFETIME_KEY: 'cc.daycareLifetime.v1',
    DAYCARE_SLOT_COUNT: 2,
    DAYCARE_LOOT_MILESTONE_M: 500,
    _cstoreHydrated: true,
    _daycareIdsCache: null,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    _store: store,
  }, extra);
  vm.createContext(ctx);
  for (const marker of [
    'function _normalizeSlot(',
    'function readDaycareSlots(',
    'function writeDaycareSlots(',
    'function _normalizeLifetimeRecord(',
    'function readDaycareLifetime(',
    'function writeDaycareLifetime(',
    'function _daycareLifetimeFor(',
    'function _daycareEarnedCount(',
    'function addToDaycare(',
    'function removeFromDaycare(',
    'function repopulateDaycareTestLoot(',
  ]) {
    vm.runInContext(extract(marker), ctx);
  }
  return ctx;
}

const CAPTURES = [{ id: 'cap1' }, { id: 'cap2' }];

// ── 1. add → accumulate → remove → re-add restores distM/steps ──
{
  const ctx = makeCtx({
    readCapturedCreatures: () => CAPTURES,
    _daycareLootAt: () => ({ kind: 'candy' }),
    _grantLoot: () => {},
  });
  ok(vm.runInContext('addToDaycare("cap1")', ctx) === true, '1: first add succeeds');
  vm.runInContext(`
    const s = readDaycareSlots();
    s[0].distM = 1200; s[0].steps = 500;
    writeDaycareSlots(s);
  `, ctx);
  ok(vm.runInContext('removeFromDaycare("cap1")', ctx) === true, '1: remove succeeds');
  ok(vm.runInContext('readDaycareSlots().length', ctx) === 0, '1: slot array empty after remove');
  ok(vm.runInContext('addToDaycare("cap1")', ctx) === true, '1: re-add succeeds');
  const slot = vm.runInContext('readDaycareSlots()[0]', ctx);
  ok(slot.distM === 1200 && slot.steps === 500,
     '1: re-added slot restores distM/steps from the lifetime record');
}

// ── 2. Claimed milestones (manual + auto-granted at removal) stay claimed ──
{
  const grants = [];
  const ctx = makeCtx({
    readCapturedCreatures: () => CAPTURES,
    _daycareLootAt: (slot, n) => ({ kind: 'candy', n }),
    _grantLoot: (loot) => { grants.push(loot.n); },
  });
  vm.runInContext('addToDaycare("cap1")', ctx);
  vm.runInContext(`
    const s = readDaycareSlots();
    s[0].distM = 1500;        // 3 earned milestones (500 m each)
    s[0].claimed = [1];       // milestone 1 already claimed by hand
    writeDaycareSlots(s);
  `, ctx);
  vm.runInContext('removeFromDaycare("cap1")', ctx);
  ok(grants.length === 2 && grants[0] === 2 && grants[1] === 3,
     '2: removal auto-grants exactly the unclaimed earned milestones (2, 3)');
  const lt = vm.runInContext('readDaycareLifetime()["cap1"]', ctx);
  ok(JSON.stringify(lt.claimed) === '[1,2,3]',
     '2: lifetime claimed banks the union of manual + auto-granted milestones');
  vm.runInContext('addToDaycare("cap1")', ctx);
  const slot = vm.runInContext('readDaycareSlots()[0]', ctx);
  ok(JSON.stringify(slot.claimed) === '[1,2,3]',
     '2: re-added slot re-seeds claimed — nothing is claimable a second time');
}

// ── 3. convertDir + conversion counters round-trip ──
{
  const ctx = makeCtx({
    readCapturedCreatures: () => CAPTURES,
    _daycareLootAt: () => ({ kind: 'candy' }),
    _grantLoot: () => {},
  });
  vm.runInContext('addToDaycare("cap1")', ctx);
  vm.runInContext(`
    const s = readDaycareSlots();
    s[0].convertDir = 'A';
    s[0].convertedCountA = 4;
    s[0].convertedCountB = 2;
    writeDaycareSlots(s);
  `, ctx);
  vm.runInContext('removeFromDaycare("cap1")', ctx);
  vm.runInContext('addToDaycare("cap1")', ctx);
  const slot = vm.runInContext('readDaycareSlots()[0]', ctx);
  ok(slot.convertDir === 'A' && slot.convertedCountA === 4 && slot.convertedCountB === 2,
     '3: convertDir + both conversion counters survive remove/re-add');
}

// ── 4. Stale lifetime record can't rewind progress (max merge) ──
{
  const ctx = makeCtx({
    readCapturedCreatures: () => CAPTURES,
    _daycareLootAt: () => ({ kind: 'candy' }),
    _grantLoot: () => {},
  });
  vm.runInContext(`
    writeDaycareLifetime({ cap1: { distM: 2000, steps: 900, claimed: [1, 2],
      convertDir: 'B', convertedCountA: 5, convertedCountB: 6 } });
    addToDaycare("cap1");
  `, ctx);
  // Simulate a slot that somehow ended up BEHIND the banked record.
  vm.runInContext(`
    const s = readDaycareSlots();
    s[0].distM = 1200; s[0].steps = 500;
    s[0].convertedCountA = 3; s[0].convertedCountB = 4;
    writeDaycareSlots(s);
    removeFromDaycare("cap1");
  `, ctx);
  const lt = vm.runInContext('readDaycareLifetime()["cap1"]', ctx);
  ok(lt.distM === 2000 && lt.steps === 900,
     '4: banked distM/steps are max(prev, slot) — no rewind');
  ok(lt.convertedCountA === 5 && lt.convertedCountB === 6,
     '4: banked conversion counters are max(prev, slot) — no rewind');
}

// ── 5. Legacy save: no lifetime store → fresh creature starts at 0 ──
{
  const ctx = makeCtx({
    readCapturedCreatures: () => CAPTURES,
    _daycareLootAt: () => ({ kind: 'candy' }),
    _grantLoot: () => {},
  });
  ok(!('cc.daycareLifetime.v1' in ctx._store), '5: store starts absent (legacy save)');
  vm.runInContext('addToDaycare("cap2")', ctx);
  const slot = vm.runInContext('readDaycareSlots()[0]', ctx);
  ok(slot.distM === 0 && slot.steps === 0 && slot.claimed.length === 0
     && slot.convertDir === null && slot.convertedCountA === 0 && slot.convertedCountB === 0,
     '5: no lifetime record → all-default slot state');
}

// ── 6. Write path prunes dead ids; failed capture read keeps the map ──
{
  const ctx = makeCtx({
    readCapturedCreatures: () => [{ id: 'cap1' }],
    _daycareLootAt: () => ({ kind: 'candy' }),
    _grantLoot: () => {},
  });
  vm.runInContext(`
    writeDaycareLifetime({
      cap1: { distM: 100, steps: 10, claimed: [], convertDir: null,
              convertedCountA: 0, convertedCountB: 0 },
      ghost: { distM: 50, steps: 5, claimed: [], convertDir: null,
               convertedCountA: 0, convertedCountB: 0 },
    });
  `, ctx);
  const keys = vm.runInContext('Object.keys(readDaycareLifetime()).sort().join(",")', ctx);
  ok(keys === 'cap1', '6: write prunes the id whose capture no longer exists');

  const ctx2 = makeCtx({
    readCapturedCreatures: () => { throw new Error('store not loaded'); },
    _daycareLootAt: () => ({ kind: 'candy' }),
    _grantLoot: () => {},
  });
  vm.runInContext(`
    writeDaycareLifetime({
      cap1: { distM: 100, steps: 10, claimed: [], convertDir: null,
              convertedCountA: 0, convertedCountB: 0 },
      ghost: { distM: 50, steps: 5, claimed: [], convertDir: null,
               convertedCountA: 0, convertedCountB: 0 },
    });
  `, ctx2);
  const keys2 = vm.runInContext('Object.keys(readDaycareLifetime()).sort().join(",")', ctx2);
  ok(keys2 === 'cap1,ghost', '6: failed capture read skips pruning — map survives intact');

  // Captures hydrate from IndexedDB async; before that lands, the store
  // bootstraps from the legacy localStorage mirror, which is empty on a
  // migrated device. An empty read there must NOT be treated as "no
  // captures exist" — pruning on it would delete every banked counter.
  const ctx3 = makeCtx({
    _cstoreHydrated: false,
    readCapturedCreatures: () => [],
    _daycareLootAt: () => ({ kind: 'candy' }),
    _grantLoot: () => {},
  });
  vm.runInContext(`
    writeDaycareLifetime({
      cap1: { distM: 100, steps: 10, claimed: [], convertDir: null,
              convertedCountA: 0, convertedCountB: 0 },
    });
  `, ctx3);
  const keys3 = vm.runInContext('Object.keys(readDaycareLifetime()).sort().join(",")', ctx3);
  ok(keys3 === 'cap1', '6: pre-hydration empty capture read skips pruning — no data loss');
}

// ── 7. repopulateDaycareTestLoot wipes slot AND lifetime claims ──
{
  const ctx = makeCtx({
    readCapturedCreatures: () => CAPTURES,
    _daycareLootAt: () => ({ kind: 'candy' }),
    _grantLoot: () => {},
  });
  const touched = vm.runInContext(`
    addToDaycare("cap1");
    const s = readDaycareSlots();
    s[0].claimed = [1, 2];
    writeDaycareSlots(s);
    writeDaycareLifetime({ cap1: { distM: 1000, steps: 0, claimed: [1, 2],
      convertDir: null, convertedCountA: 0, convertedCountB: 0 } });
    repopulateDaycareTestLoot()
  `, ctx);
  ok(touched === 1, '7: returns the number of slots wiped');
  const slotClaimed = vm.runInContext('readDaycareSlots()[0].claimed.length', ctx);
  const ltClaimed = vm.runInContext('readDaycareLifetime()["cap1"].claimed.length', ctx);
  ok(slotClaimed === 0 && ltClaimed === 0,
     '7: slot and lifetime claimed arrays are both wiped (re-add cannot restore them)');
}

// ── 8. Garbage lifetime record normalizes to defaults ──
{
  const ctx = makeCtx({
    readCapturedCreatures: () => CAPTURES,
    _daycareLootAt: () => ({ kind: 'candy' }),
    _grantLoot: () => {},
  });
  const rec = vm.runInContext(`
    localStorage.setItem(DAYCARE_LIFETIME_KEY, JSON.stringify({
      cap1: { distM: -5, steps: 'x', claimed: 'nope', convertDir: 'Q',
              convertedCountA: -1, convertedCountB: 1.5 },
      bad: 42,
    }));
    readDaycareLifetime()['cap1']
  `, ctx);
  ok(rec && rec.distM === 0 && rec.steps === 0 && rec.claimed.length === 0
     && rec.convertDir === null && rec.convertedCountA === 0 && rec.convertedCountB === 0,
     '8: garbage fields fall back to per-field defaults');
  ok(vm.runInContext('!("bad" in readDaycareLifetime())', ctx),
     '8: non-object entries are dropped');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
