// Tests the legendary snap-provider hook in static/spawns.js:
//   - Default (no provider): legendaries keep their rolled positions
//     (engine purity — the app injects the road/POI provider at runtime).
//   - Provider returning an anchor: spawn moves to the anchor coords and
//     carries `snappedTo`; the bbox filter runs on the SNAPPED coords.
//   - Provider returning null: the legendary is hidden from both
//     legendariesInBbox and nearestRadar (nothing safe within range).
//   - Provider results are cached per spawn id (no rescans on refresh).
// The road/POI priority chain itself lives in index.html
// (legendarySnapTarget) and is not exercisable from Node.
//
// Run: node tests/legendary-snap.test.js
'use strict';
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');

// spawns.js reads global.Types at load — types.js must be required first
// (same load order as index.html), and the Species stub must be in place
// before generation calls build their indices.
require(path.join(root, 'static', 'types.js'));
const namesArr = require(path.join(root, 'data', 'BundledData', 'species-names.json'));
const typesMap = require(path.join(root, 'data', 'BundledData', 'species-types.json'));
const evosMap = require(path.join(root, 'data', 'BundledData', 'species-evolutions.json'));
global.Species = {
  typesFor(idx) { const t = typesMap[String(idx)]; return t ? t.filter(Boolean) : []; },
  evolutionsFor(idx) {
    const raw = evosMap[String(idx)];
    if (!Array.isArray(raw)) return [];
    return raw.map((e) => ({ target: e[0], method: e[1], param: e[2] }));
  },
  allSpecies() {
    const out = [];
    for (let i = 0; i < namesArr.length; i++) if (namesArr[i]) out.push({ id: i + 1, name: namesArr[i] });
    return out;
  },
};
require(path.join(root, 'static', 'spawns.js'));
const S = global.Spawns;

// ── Fixture: one legendary alive right now ──────────────────────
// nearestRadar reads Date.now() internally, so everything uses real time.
// Legendaries are ~1 in 4M cell-ticks — sweep adaptively like
// community-day.test.js §4.
const NOW = Date.now();
function findLiveLegendary() {
  const lt = S.currentLegTick(NOW);
  for (let cx = 0; cx <= 400000; cx++) {
    for (let cy = 90000; cy < 90100; cy++) {
      for (let l = lt - S.LEG_LIFETIME_MS / S.LEG_TICK_MS; l <= lt; l++) {
        const p = S.generateLegendaryAtTick(cx, cy, l);
        if (p && NOW >= p.startMs && NOW < p.expireMs) return p;
      }
    }
  }
  return null;
}
const leg = findLiveLegendary();
ok(leg, 'fixture: found a live legendary (id ' + (leg && leg.id) + ')');
if (!leg) {
  console.error('cannot continue without a live legendary');
  process.exit(1);
}
const bboxAround = (lat, lng, padDeg) => [lng - padDeg, lat - padDeg, lng + padDeg, lat + padDeg];
// legendariesInBbox bails past MAX_CELLS (40000 cells ≈ a ±0.01° box) —
// the "wide" queries below must stay under that.
const WIDE_PAD = 0.008;

// ── 1) No provider → raw rolled position ────────────────────────
{
  S.setLegendarySnapProvider(null);
  const raw = bboxAround(leg.lat, leg.lng, 0.0005);
  const out = S.legendariesInBbox(raw, NOW);
  const hit = out.find((p) => p.id === leg.id);
  ok(hit, '1: legendary present without a provider');
  ok(hit && hit.lat === leg.lat && hit.lng === leg.lng && !('snappedTo' in hit),
    '1: position is the raw rolled position, no snappedTo field');
}

// ── 2) Snap anchor → moved, flagged, bbox on snapped coords ─────
{
  const anchor = { lat: leg.lat + 0.005, lng: leg.lng + 0.003, kind: 'road' }; // ~600 m away
  let calls = 0;
  S.setLegendarySnapProvider(() => { calls++; return anchor; });
  // The query bbox must cover the RAW cell (the engine generates the spawn
  // there, then moves it); the returned position is the anchor.
  const wide = S.legendariesInBbox(bboxAround(leg.lat, leg.lng, WIDE_PAD), NOW);
  const hit = wide.find((p) => p.id === leg.id);
  ok(hit, '2: legendary found in a bbox covering the raw cell');
  ok(hit && hit.lat === anchor.lat && hit.lng === anchor.lng,
    '2: spawn moved to the anchor coords');
  ok(hit && hit.snappedTo === 'road', '2: snappedTo carries the anchor kind');
  ok(hit && hit.id === leg.id && hit.speciesA === leg.speciesA && hit.startMs === leg.startMs,
    '2: id/species/timing untouched by the snap');
  const atRaw = S.legendariesInBbox(bboxAround(leg.lat, leg.lng, 0.0005), NOW);
  ok(!atRaw.some((p) => p.id === leg.id),
    '2: bbox filter uses snapped coords (excluded when only the raw cell is queried but the anchor lies outside)');
  const callsAfterFirst = calls;
  S.legendariesInBbox(bboxAround(leg.lat, leg.lng, WIDE_PAD), NOW);
  ok(calls === callsAfterFirst, '2: provider result cached per spawn id (no rescan on refresh)');
}

// ── 3) Null target → hidden from bbox queries ───────────────────
{
  S.setLegendarySnapProvider(() => null);
  const wide = S.legendariesInBbox(bboxAround(leg.lat, leg.lng, WIDE_PAD), NOW);
  ok(!wide.some((p) => p.id === leg.id), '3: null snap target hides the legendary');
}

// ── 4) nearestRadar honors the snap ─────────────────────────────
{
  // Anchor exactly at the rolled position: distance 0 to the query point
  // guarantees the legendary a radar slot when the provider allows it.
  S.setLegendarySnapProvider(() => ({ lat: leg.lat, lng: leg.lng, kind: 'poi' }));
  const withSnap = S.nearestRadar(leg.lat, leg.lng, 5);
  const hit = withSnap.find((p) => p.id === leg.id);
  ok(hit && hit.legendary === true && hit.snappedTo === 'poi',
    '4: radar lists the snapped legendary at distance 0');
  S.setLegendarySnapProvider(() => null);
  const withoutSnap = S.nearestRadar(leg.lat, leg.lng, 5);
  ok(!withoutSnap.some((p) => p.id === leg.id),
    '4: null snap target removes the legendary from the radar');
}

S.setLegendarySnapProvider(null);
console.log((failed ? 'FAILED' : 'OK') + ' — ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
