// Regression test: hatching an egg registers the fusion in the Pokédex
// IMMEDIATELY (markFusionSeen), not just via the load-time backfill.
//
// The bug: hatchEgg() pushed the creature to `captured` and awarded candy
// but never called markFusionSeen. Wild catches register at the encounter;
// a hatch has no encounter, so the fusion only reached seenFusions via
// backfillSeenFromCaptures() on the next app launch. Symptoms:
//   - a freshly hatched fusion didn't appear in the dex until an app restart
//   - evolving it before that restart overwrote the record's species, so the
//     pre-evolution fusion was never registered anywhere — lost for good.
//
// Run: node tests/hatch-seen.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

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

(async () => {
  const seenCalls = [];
  let captured = [];
  let eggs = [{ id: 'e1', speciesA: 1, speciesB: 4, sizeM: 1.2 }];
  const ctx = {
    Math, Date: { now: () => 1700000000000 },
    global: { CreatureCollectAPI: null },
    CANDY_HATCH_CAPTURE: 10,
    readEggs: () => eggs,
    writeEggs: (a) => { eggs = a; },
    eggReadyToHatch: () => true,
    _pickHatchVariant: async () => 'auto',
    _rollFreshShinyVariant: () => null,
    readCapturedCreatures: () => captured,
    writeCapturedCreatures: (l) => { captured = l; },
    awardCandyForCapture: () => {},
    removeFromIncubator: () => {},
    // Stub markFusionSeen to record how it was invoked.
    markFusionSeen: (a, b, spawn, variant) => { seenCalls.push({ a, b, variant }); },
  };
  vm.createContext(ctx);
  vm.runInContext(extract('async function hatchEgg'), ctx);

  const entry = await vm.runInContext('hatchEgg("e1")', ctx);

  ok(entry && entry.fromEgg === true, 'sanity: hatch produced a fromEgg capture');
  ok(captured.length === 1, 'sanity: creature was added to captured');
  ok(seenCalls.length === 1, 'markFusionSeen was called exactly once at hatch');
  ok(seenCalls[0] && seenCalls[0].a === 1 && seenCalls[0].b === 4,
    'the hatched fusion (1-4) was registered in the Pokédex');
  ok(seenCalls[0] && seenCalls[0].variant === 'auto',
    'the hatched variant was registered too');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
