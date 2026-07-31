// Regression test: a shiny you SEE at the encounter is the shiny you GET in the
// pokédex, even when the spawn's map marker is torn down and rebuilt by a spawn
// refresh (GPS loss / drifting out of range) between tapping and catching.
//
// The bug: shininess was stored only on the ephemeral marker record, so a
// rebuilt marker made recordCaptureFromSpawn re-roll fresh — quietly dropping
// the shiny. The fix caches the decision per spawn id (_shinyBySpawn) and
// resolves catches via _resolveShinyForCatch (marker → cache → fresh roll).
//
// Run: node tests/shiny-persistence.test.js
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

// A Math whose random we can pin, while floor/min/max still work via prototype.
function mathWith(rng) { const M = Object.create(Math); M.random = rng; return M; }

function makeCtx({ forceShiny = false, rng = Math.random, cap = 1000 } = {}) {
  const ctx = {
    Math: mathWith(rng),
    global: { ShinyStore: { RATE: 0.001, VARIANT_COUNT: 12 } },
    _shinyBySpawn: new Map(),
    _markers: new Map(),
    _SHINY_CACHE_CAP: cap,
    _forceShinyOn: () => forceShiny,
    _fusionShinyMultiplier: () => 1,
    _shinyMultiplierForSpawn: () => 1,
  };
  vm.createContext(ctx);
  for (const fn of ['_cacheShiny(', '_rollShinyForRecord(', '_rollFreshShinyVariant(', '_resolveShinyForCatch(']) {
    vm.runInContext(extract('function ' + fn), ctx);
  }
  return ctx;
}
const call = (ctx, name, arg) => vm.runInContext(name + '(__a)', Object.assign(ctx, { __a: arg }));
// Mimic addMarker's seeding step when a refresh rebuilds a marker.
function rebuildMarker(ctx, spawn) {
  ctx._markers.delete(spawn.id);
  const rec = { spawn, shinyVariant: undefined };
  if (ctx._shinyBySpawn.has(spawn.id)) rec.shinyVariant = ctx._shinyBySpawn.get(spawn.id);
  ctx._markers.set(spawn.id, rec);
  return rec;
}

// ── A. Shiny survives a marker rebuild between tap and catch (the bug) ──
{
  const ctx = makeCtx({ forceShiny: true });
  const spawn = { id: 's1', speciesA: 1, speciesB: 2 };
  const rec = { spawn, shinyVariant: undefined };
  ctx._markers.set('s1', rec);
  call(ctx, '_rollShinyForRecord', rec);           // engage encounter
  ok(typeof rec.shinyVariant === 'number', 'A: encounter rolled shiny (numeric variant)');
  ok(ctx._shinyBySpawn.get('s1') === rec.shinyVariant, 'A: decision cached per spawn id');
  const decided = rec.shinyVariant;
  const rebuilt = rebuildMarker(ctx, spawn);       // spawn refresh tears down + rebuilds
  ok(rebuilt.shinyVariant === decided, 'A: rebuilt marker is seeded with the same shiny (addMarker)');
  ok(call(ctx, '_resolveShinyForCatch', spawn) === decided, 'A: catch keeps the SAME shiny after churn');
}

// ── B. Marker fully gone (GPS drop) — cache still recovers the shiny ──
{
  const ctx = makeCtx({ forceShiny: true });
  const spawn = { id: 's2', speciesA: 3, speciesB: 4 };
  const rec = { spawn, shinyVariant: undefined };
  ctx._markers.set('s2', rec);
  call(ctx, '_rollShinyForRecord', rec);
  const decided = rec.shinyVariant;
  ctx._markers.delete('s2');                        // removed and NOT re-added
  const caught = call(ctx, '_resolveShinyForCatch', spawn);
  ok(caught === decided && typeof caught === 'number', 'B: catch recovers shiny from cache when marker is gone');
}

// ── C. Not-shiny is equally stable — no accidental re-roll into shiny ──
{
  // Roll with a "never hits" rng so the decision is not-shiny (null)...
  const ctx = makeCtx({ forceShiny: false, rng: () => 0.999999 });
  const spawn = { id: 's3', speciesA: 5, speciesB: 6 };
  const rec = { spawn, shinyVariant: undefined };
  ctx._markers.set('s3', rec);
  call(ctx, '_rollShinyForRecord', rec);
  ok(rec.shinyVariant === null, 'C: rolled not-shiny (null)');
  ok(ctx._shinyBySpawn.get('s3') === null, 'C: not-shiny decision cached (null, not absent)');
  ctx._markers.delete('s3');
  // ...even though resolve would fresh-roll here, the cached null must win.
  ok(call(ctx, '_resolveShinyForCatch', spawn) === null, 'C: catch stays not-shiny from cache (no re-roll)');
}

// ── D. Never engaged (instant-catch path) — falls back to a fresh roll ──
{
  const ctx = makeCtx({ forceShiny: true });         // a fresh roll would be shiny
  const spawn = { id: 's4', speciesA: 7, speciesB: 8 };
  ok(typeof call(ctx, '_resolveShinyForCatch', spawn) === 'number', 'D: never-engaged catch does a fresh roll');
}

// ── E. Cache is FIFO-capped so abandoned encounters can't grow it forever ──
{
  const ctx = makeCtx({ cap: 3 });
  for (let i = 0; i < 5; i++) vm.runInContext(`_cacheShiny('k${i}', ${i})`, ctx);
  ok(ctx._shinyBySpawn.size === 3, 'E: cache capped at 3');
  ok(!ctx._shinyBySpawn.has('k0') && !ctx._shinyBySpawn.has('k1'), 'E: oldest entries evicted (FIFO)');
  ok(ctx._shinyBySpawn.get('k4') === 4, 'E: newest entry retained');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
