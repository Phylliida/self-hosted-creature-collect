// Evolving a creature away must not take its art out of the dex.
//
// The art seen for a fusion is its dex row's variants plus the variants of
// captures still of that fusion. A creature that never had an encounter
// screen (an egg hatched before hatches marked the dex, a focus-mode grant)
// had its art only on the capture; performEvolution rewrites the capture's
// species in place, so the art went with it. Grak's evolved-away Bulbasaur ×
// Nosepass egg (row 325-1: { firstSeen, caught: true }, no variants) showed
// its only art unseen, so no all-art ring.
//
//   A. _keepCaptureArt puts a capture's variant on its row
//   C. performEvolution keeps the old fusion's art before flagging it
//   D. recoverCaughtAwayArt re-credits rows that already lost it, only
//      rows minted from a capture (no lastSeen, so not just the lineage
//      walk's inferred flag) and only when the fusion has one picture
//
// Run: node tests/evolve-keeps-art.test.js
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
  // Body brace: skip a destructured parameter list like ({ a, b }).
  let i = src.indexOf(') {', start) + 2, depth = 0;
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

let seen = {};
let captures = [];
let writes = 0;
const lsStore = new Map();
const cells = new Map();   // "a-b" -> { count, canon }
let canonReady = true;
const ctx = {
  Date: { now: () => 1700000000000 },
  global: {
    Sprites: {
      getCellVariantCount: async (a, b) => (cells.get(`${a}-${b}`) || { count: 0 }).count,
      getArtCanon: async () => canonReady
        ? (a, b) => (cells.get(`${a}-${b}`) || {}).canon || null
        : null,
    },
  },
  localStorage: {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => lsStore.set(k, String(v)),
  },
  readCapturedCreatures: () => captures,
  readSeenFusions: () => seen,
  writeSeenFusions: (m) => { seen = m; writes++; },
  isFusionOwned: (a, b) => captures.some((c) => c.speciesA === a && c.speciesB === b),
};
// Stats-journal hooks (creatures.js "Stats journal") are no-ops here.
Object.assign(ctx, { noteStat() {}, _statsNoteCatch() {}, _statsNoteEncounter() {} });
vm.createContext(ctx);
for (const m of ['function _keepCaptureArt', 'function markFusionCaughtAway',
                 'function _distinctArt',
                 'async function recoverCaughtAwayArt']) {
  vm.runInContext(extract(m), ctx);
}
vm.runInContext("const CAUGHT_AWAY_ART_KEY = 'cc.caughtAwayArt.v1';", ctx);
const call = (name, ...args) => { ctx.__a = args; return vm.runInContext(`${name}(...__a)`, ctx); };
const cap = (id, a, b, variant, ts) => ({ id, speciesA: a, speciesB: b, variant, caughtAt: { timestamp: ts } });

(async () => {
  // ── A. _keepCaptureArt ──
  {
    const m = { '325-1': { firstSeen: 5 } };
    ok(call('_keepCaptureArt', m, cap('x', 325, 1, 0, 7)) === true, 'A: adds art to a row without any');
    ok(eq(m['325-1'], { firstSeen: 5, variants: { 0: 7 } }), 'A: row keeps firstSeen, gains variant 0 at the catch time');
    ok(call('_keepCaptureArt', m, cap('y', 325, 1, 0, 9)) === false, 'A: same art again changes nothing');
    ok(m['325-1'].variants['0'] === 7, 'A: earliest timestamp kept');
    call('_keepCaptureArt', m, cap('z', 325, 1, 'auto', 11));
    ok(eq(Object.keys(m['325-1'].variants).sort(), ['0', 'auto']), 'A: non-number variant recorded as auto');
    ok(call('_keepCaptureArt', m, cap('n', 7, 8, 2, 3)) === true && eq(m['7-8'], { firstSeen: 3, variants: { 2: 3 } }),
      'A: missing row is created (the trainer owned it)');
    ok(call('_keepCaptureArt', m, { id: 's', solo: 'x', speciesA: null, speciesB: null, variant: 'auto' }) === false
      && !('null-null' in m), 'A: solos are left alone');
  }

  // ── C. performEvolution keeps the old art, then flags caught-away ──
  {
    seen = { '325-1': { firstSeen: 10 } };   // egg hatch before hatches marked the dex
    const old = cap('egg', 325, 1, 0, 10);
    captures = [old];
    const marked = [];
    const evoCtx = {
      ...ctx,
      readCapturedCreatures: () => captures,
      readSeenFusions: () => seen,
      writeSeenFusions: (m) => { seen = m; },
      _canAffordEvolution: () => true,
      _pickEvolvedVariant: async () => ({ variant: 0 }),
      _evolutionItemRequirement: () => null,
      consumeItem: () => true,
      _evolutionCandyCost: () => 0,
      candyRootFor: () => null,
      fusionName: () => 'Nosesaur',
      _capStore: {
        replaceById: (id, next) => {
          const i = captures.findIndex((x) => x.id === id);
          if (i < 0) return false;
          captures[i] = next; return true;
        },
      },
      _logCreatureError: () => {},
      markFusionSeen: (a, b, sp, v) => { marked.push([a, b, v]); },
      markFusionShinySeen: () => {},
    };
    // Stats-journal hooks (creatures.js "Stats journal") are no-ops here.
    Object.assign(evoCtx, { noteStat() {}, _statsNoteCatch() {}, _statsNoteEncounter() {} });
    vm.createContext(evoCtx);
    for (const m of ['function _keepCaptureArt', 'function markFusionCaughtAway', 'async function performEvolution']) {
      vm.runInContext(extract(m), evoCtx);
    }
    evoCtx.__a = [{ creatureId: 'egg', srcSpeciesId: 1, method: 'Level', param: 16, newA: 325, newB: 3 }];
    const out = await vm.runInContext('performEvolution(...__a)', evoCtx);
    ok(out && out.speciesA === 325 && out.speciesB === 3, 'C: sanity — capture evolved to 325-3');
    ok(eq(seen['325-1'].variants, { 0: 10 }), 'C: old row keeps the art the capture had');
    ok(seen['325-1'].caught === true, 'C: old row flagged caught-away');
    ok(eq(marked, [[325, 3, 0]]), 'C: new fusion still marked seen with its art');
  }

  // ── D. one-time repair of rows that already lost their art ──
  {
    cells.clear();
    cells.set('325-1', { count: 2, canon: Uint8Array.from([0, 0]) });   // two slots, one picture
    cells.set('5-6', { count: 2, canon: Uint8Array.from([0, 1]) });     // two pictures
    cells.set('7-8', { count: 1, canon: Uint8Array.from([0]) });        // still owned
    cells.set('9-10', { count: 1, canon: Uint8Array.from([0]) });       // never caught
    cells.set('13-14', { count: 1, canon: Uint8Array.from([0]) });      // flagged by inference only
    // 11-12: autogen only (count 0)
    seen = {
      '325-1': { firstSeen: 10, caught: true },
      '5-6': { firstSeen: 11, caught: true },
      '7-8': { firstSeen: 12, caught: true },
      '9-10': { firstSeen: 13 },
      '11-12': { firstSeen: 14, caught: true },
      // Seen at an encounter (lastSeen), flagged caught by the lineage walk
      // only — radar catches evolved forms without the early ones.
      '13-14': { firstSeen: 17, lastSeen: 18, caught: true },
      '1-4': { firstSeen: 15, caught: true, variants: { 1: 15 } },
      'solo:abc': { firstSeen: 16, caught: true },
    };
    captures = [cap('o', 7, 8, 0, 12)];
    const before = JSON.parse(JSON.stringify(seen));

    canonReady = false;
    lsStore.clear();
    await call('recoverCaughtAwayArt');
    ok(eq(seen, before), 'D: art data not ready — nothing changes');
    ok(lsStore.get('cc.caughtAwayArt.v1') == null, 'D: …and it retries next boot');

    canonReady = true;
    await call('recoverCaughtAwayArt');
    ok(eq(seen['325-1'].variants, { 0: 10 }), 'D: single-picture caught-away row credited (Bulbasaur × Nosepass)');
    ok(!seen['5-6'].variants, 'D: several pictures — unknown which, left alone');
    ok(!seen['7-8'].variants, 'D: owned fusions are left to the captures');
    ok(!seen['9-10'].variants, 'D: seen but never caught — left alone');
    ok(!seen['11-12'].variants, 'D: autogen-only — nothing to credit');
    ok(!seen['13-14'].variants, 'D: encounter row flagged only by inference — left alone');
    ok(eq(seen['1-4'].variants, { 1: 15 }), 'D: rows with art untouched');
    ok(!seen['solo:abc'].variants, 'D: non-fusion keys skipped');
    ok(lsStore.get('cc.caughtAwayArt.v1') === '1', 'D: flag set once it ran');

    seen['5-6'].caught = true; delete seen['325-1'].variants;
    await call('recoverCaughtAwayArt');
    ok(!seen['325-1'].variants, 'D: one-time — flag set means no second pass');

    // Nothing to repair: flag set without needing the art data.
    lsStore.clear(); canonReady = false;
    seen = { '1-4': { firstSeen: 1, variants: { 0: 1 } } };
    await call('recoverCaughtAwayArt');
    ok(lsStore.get('cc.caughtAwayArt.v1') === '1', 'D: no candidates — done immediately');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
