// A focus-mode grant registers its creature in the Pokédex at once, art
// included — like a wild catch (marked at the encounter screen) or a
// hatch (hatchEgg).
//
// The bug: _focusGrantCreature recorded the capture but never marked the
// dex, so the fusion only appeared after the next app start (via
// backfillSeenFromCaptures, as a row with no art).
//
// Run: node tests/focus-grant-seen.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

function setup(enc, opts = {}) {
  const calls = { fusion: [], solo: [], errors: [], label: null };
  const ctx = {
    Date, Math,
    _userLat: 45.5, _userLng: -73.6,
    global: { Spawns: { rollWildEncounter: () => enc } },
    recordCaptureFromSpawn: async (spawn) => ({
      id: 'c-1', speciesA: spawn.speciesA, speciesB: spawn.speciesB,
      solo: spawn.solo, variant: opts.variant, shinyVariant: null,
    }),
    markFusionSeen: (a, b, spawn, variant) => {
      if (opts.throwOnMark) throw new Error('boom');
      calls.fusion.push({ a, b, lat: spawn && spawn.lat, variant });
    },
    markSoloSeen: (id, variant) => { calls.solo.push({ id, variant }); },
    // New/Fresh label for the results view, decided before the capture.
    newFreshLabelFor: (a, b, seenF) => { calls.label = { a, b, seenF }; return opts.label === undefined ? 'New' : opts.label; },
    _logCreatureError: (where) => { calls.errors.push(where); },
  };
  vm.createContext(ctx);
  vm.runInContext(extract('async function _focusGrantCreature'), ctx);
  const a = { earned: { creatures: [], items: {} } };
  return { ctx, calls, a };
}

(async () => {
  {
    const { ctx, calls, a } = setup({ speciesA: 325, speciesB: 1, level: 3, sizeM: 1 }, { variant: 2 });
    ctx.__a = a;
    const r = await vm.runInContext('_focusGrantCreature(__a)', ctx);
    ok(r === true && a.earned.creatures.length === 1, 'sanity: grant recorded');
    ok(eq(calls.fusion, [{ a: 325, b: 1, lat: 45.5, variant: 2 }]),
      'fusion marked seen once, with the art it was granted at and where');
    ok(a.earned.creatures[0].fresh === 'New', 'the New/Fresh label rides on the earned entry');
  }
  {
    const { ctx, calls, a } = setup({ speciesA: 9, speciesB: 8, level: 3, sizeM: 1 }, { variant: 0, label: 'Fresh' });
    ctx.__a = a; ctx.__seen = { '9-8': { caught: true } };
    await vm.runInContext('_focusGrantCreature(__a, null, __seen)', ctx);
    ok(a.earned.creatures[0].fresh === 'Fresh' && calls.label && calls.label.a === 9 && calls.label.b === 8
       && calls.label.seenF === ctx.__seen, 'the label uses the payout\'s dex snapshot');
  }
  {
    const { ctx, calls, a } = setup({ speciesA: 4, speciesB: 7, level: 3, sizeM: 1 }, { variant: 'auto' });
    ctx.__a = a;
    await vm.runInContext('_focusGrantCreature(__a)', ctx);
    ok(calls.fusion.length === 1 && calls.fusion[0].variant === 'auto', 'autogen art recorded as such');
  }
  {
    const { ctx, calls, a } = setup({ solo: 'missingno', level: 3, sizeM: 1 }, { variant: 'auto' });
    ctx.__a = a;
    await vm.runInContext('_focusGrantCreature(__a)', ctx);
    ok(eq(calls.solo, [{ id: 'missingno', variant: 'auto' }]) && calls.fusion.length === 0,
      'solo grant marks its solo dex row');
    ok(a.earned.creatures[0].fresh === '' && calls.label === null, 'solos get no New/Fresh label');
  }
  {
    const { ctx, calls, a } = setup({ speciesA: 1, speciesB: 2, level: 3, sizeM: 1 }, { variant: 0, throwOnMark: true });
    ctx.__a = a;
    const r = await vm.runInContext('_focusGrantCreature(__a)', ctx);
    ok(r === true && a.earned.creatures.length === 1, 'a dex failure never loses the grant');
    ok(eq(calls.errors, ['focus/markSeen']), '…and is logged');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
