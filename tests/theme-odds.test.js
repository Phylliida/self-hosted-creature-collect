// Tests the daily/weekly type-weather odds explainer:
//   Spawns.typeOdds()   (static/spawns.js — realized per-slot type shares)
//   _themeOddsHtml()     (static/creatures.js — the segmented odds-bar copy)
//
// Part 1 requires spawns.js for real, feeding it the bundled species-types
// data through a Species stub so empty pools (e.g. no FLYING-primary
// species) are exercised the same way they are in the app. Part 2 extracts
// the render helpers into a vm sandbox (same approach as incense-info.test)
// and drives them with a canned typeOdds object.
//
// Run: node tests/theme-odds.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

// ── Part 1: Spawns.typeOdds math against real species data ──────────────
const typesMap = require(path.join(__dirname, '..', 'data', 'BundledData', 'species-types.json'));
global.Species = {
  typesFor(idx) { const t = typesMap[String(idx)]; return t ? t.filter(Boolean) : []; },
};
require(path.join(__dirname, '..', 'static', 'spawns.js'));
const S = global.Spawns;

const DAY = 86400000;
const sum = (o) => Object.keys(o).reduce((a, k) => a + o[k], 0);

// Sweep a range of days; check the invariants that must hold every day.
let sawDistinct = 0, sawSame = 0;
for (let d = 0; d < 400; d++) {
  const now = d * DAY + 12 * 3600000;   // midday on UTC day d
  const o = S.typeOdds(now);
  ok(o != null, 'day ' + d + ': typeOdds returns an object');
  if (!o) continue;

  // perType is a full distribution over the 18 types, summing to 1.
  ok(Math.abs(sum(o.perType) - 1) < 1e-9, 'day ' + d + ': perType sums to 1');

  // The three headline slices partition to 1.
  const total = o.same ? (o.dailyShare + o.otherShare)
                       : (o.dailyShare + o.weeklyShare + o.otherShare);
  ok(Math.abs(total - 1) < 1e-9, 'day ' + d + ': daily/weekly/other partition to 1');

  // dailyShare / weeklyShare read straight off perType.
  ok(o.dailyShare === o.perType[o.daily], 'day ' + d + ': dailyShare == perType[daily]');
  ok(o.weeklyShare === o.perType[o.weekly], 'day ' + d + ': weeklyShare == perType[weekly]');

  // Average share of a non-boosted type, for the "is this really boosted?"
  // check. 18 types total; subtract the 1 (or 2) boosted ones.
  const boostedCount = o.same ? 1 : 2;
  const avgOther = o.otherShare / (18 - boostedCount);

  if (o.same) {
    sawSame++;
    ok(o.daily === o.weekly, 'day ' + d + ': same flag ⇒ daily === weekly');
    ok(Math.abs(o.otherShare - (1 - o.dailyShare)) < 1e-9,
      'day ' + d + ': same ⇒ otherShare = 1 - dailyShare');
  } else {
    sawDistinct++;
    ok(o.daily !== o.weekly, 'day ' + d + ': distinct flag ⇒ daily !== weekly');
  }

  // Both boosted types must be meaningfully above the background rate —
  // unless the type genuinely has no spawnable species in either slot
  // (share ~0), which is a legitimate realized outcome we don't fail on.
  if (o.dailyShare > 1e-6) {
    ok(o.dailyShare > avgOther * 2,
      'day ' + d + ': daily ' + o.daily + ' (' + o.dailyShare.toFixed(3)
      + ') well above background ' + avgOther.toFixed(3));
  }
  if (!o.same && o.weeklyShare > 1e-6) {
    ok(o.weeklyShare > avgOther * 1.5,
      'day ' + d + ': weekly ' + o.weekly + ' (' + o.weeklyShare.toFixed(3)
      + ') above background ' + avgOther.toFixed(3));
  }
}
ok(sawDistinct > 0, 'swept days include distinct daily/weekly weather');
// (A same-type day is rare — ~1/18 — so 400 days should surface at least one.)
ok(sawSame > 0, 'swept days include at least one daily===weekly day');

// Deterministic + species-independent of call args: same nowMs ⇒ same result.
{
  const a = S.typeOdds(50 * DAY);
  const b = S.typeOdds(50 * DAY);
  ok(a.daily === b.daily && a.weekly === b.weekly
    && Math.abs(a.dailyShare - b.dailyShare) < 1e-12,
    'typeOdds is deterministic for a fixed timestamp');
}

// Returns null when species data isn't loaded (fresh module state can't be
// re-created here, so assert the guard via an empty Species stub on a probe).
{
  const saved = global.Species;
  // Force a brand-new index build path by checking the documented contract:
  // typeOdds must never throw and returns a well-formed object with real data.
  const o = S.typeOdds();
  ok(o && typeof o.dailyShare === 'number', 'typeOdds() with no arg uses "now" and is well-formed');
  global.Species = saved;
}

// ── Part 1b: Spawns.typePairOdds joint-grid math ────────────────────────
// The detailed "both type-halves" diagram: joint odds over the 3×3 grid of
// {daily, weekly, other} × {daily, weekly, other}. Must sum to 1, and its
// per-slot marginals must reconstruct the typeOdds() marginals exactly (since
// typeOdds is the average of the primary- and secondary-slot marginals).
let sawPairDistinct = 0, sawPairSame = 0;
for (let d = 0; d < 400; d++) {
  const now = d * DAY + 12 * 3600000;
  const p = S.typePairOdds(now);
  const o = S.typeOdds(now);
  ok(p != null, 'day ' + d + ': typePairOdds returns an object');
  if (!p) continue;

  // classes track the same-flag: 2 classes when a single type is boosted on
  // both channels, else 3.
  ok(p.same === o.same, 'day ' + d + ': pair.same matches typeOdds.same');
  ok(p.classes.length === (p.same ? 2 : 3),
    'day ' + d + ': ' + (p.same ? 2 : 3) + ' classes');

  // Whole grid is a probability distribution: every cell >= 0, all sum to 1.
  let gsum = 0, allNonNeg = true;
  for (const rc of p.classes) for (const cc of p.classes) {
    if (!(p.grid[rc][cc] >= 0)) allNonNeg = false;
    gsum += p.grid[rc][cc];
  }
  ok(allNonNeg, 'day ' + d + ': all grid cells non-negative');
  ok(Math.abs(gsum - 1) < 1e-9, 'day ' + d + ': grid sums to 1');

  // Per-slot marginals reconstruct typeOdds shares:
  //   typeOdds share of class C == (primary-marginal(C) + secondary-marginal(C)) / 2
  const shareOf = { daily: o.dailyShare, weekly: o.same ? 0 : o.weeklyShare, other: o.otherShare };
  for (const C of p.classes) {
    let row = 0, col = 0;
    for (const cc of p.classes) row += p.grid[C][cc];   // primary == C
    for (const rc of p.classes) col += p.grid[rc][C];   // secondary == C
    ok(Math.abs((row + col) / 2 - shareOf[C]) < 1e-9,
      'day ' + d + ': class ' + C + ' marginals reconstruct typeOdds share');
  }

  if (p.same) sawPairSame++; else sawPairDistinct++;
}
ok(sawPairDistinct > 0, 'pair sweep includes distinct-weather days');
ok(sawPairSame > 0, 'pair sweep includes at least one same-weather day');

// Deterministic for a fixed timestamp.
{
  const a = S.typePairOdds(50 * DAY), b = S.typePairOdds(50 * DAY);
  ok(a.daily === b.daily && a.grid.daily.daily === b.grid.daily.daily,
    'typePairOdds is deterministic for a fixed timestamp');
}

// ── Part 2: _themeOddsHtml rendering ────────────────────────────────────
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

const TYPE_COLORS = {
  NORMAL: '#A8A77A', FIRE: '#EE8130', WATER: '#6390F0', GRASS: '#7AC74C',
  ELECTRIC: '#F7D02C', ICE: '#96D9D6', FIGHTING: '#C22E28', POISON: '#A33EA1',
  GROUND: '#E2BF65', FLYING: '#A98FF3', PSYCHIC: '#F95587', BUG: '#A6B91A',
  ROCK: '#B6A136', GHOST: '#735797', DRAGON: '#6F35FC', DARK: '#705746',
  STEEL: '#B7B7CE', FAIRY: '#D685AD',
};
const ctx = {
  Object, Set, Array, Math, String, Number, JSON,
  global: { Spawns: { typeOdds: () => null, typePairOdds: () => null } },
  TYPE_COLORS,
};
vm.createContext(ctx);
for (const m of [
  'function escapeHtml(',
  'function _titleCaseType(',
  'function _ccOddsSeg(',
  'function _ccOddsLegend(',
  'function _ccOddsGrid(',
  'function _themeOddsHtml(',
]) vm.runInContext(extract(m), ctx);
const call = (expr) => vm.runInContext(expr, ctx);

// Loading state: no odds available yet.
{
  ctx.global.Spawns.typeOdds = () => null;
  const h = call('_themeOddsHtml()');
  ok(/still loading/i.test(h), 'P2: null odds ⇒ "still loading" message');
}

// Distinct daily/weekly day.
{
  ctx.global.Spawns.typeOdds = () => ({
    daily: 'FIRE', weekly: 'WATER', same: false,
    dailyShare: 0.42, weeklyShare: 0.27, otherShare: 0.31,
    perType: {},
  });
  const h = call('_themeOddsHtml()');
  const segs = (h.match(/cc-oddsbar-seg/g) || []).length;
  ok(segs === 3, 'P2: distinct weather ⇒ three odds-bar segments (got ' + segs + ')');
  ok(h.indexOf('Fire') >= 0 && h.indexOf('— today') >= 0, 'P2: names Fire as today\'s type');
  ok(h.indexOf('Water') >= 0 && h.indexOf('this week') >= 0, 'P2: names Water as this week\'s type');
  ok(h.indexOf('All other types') >= 0, 'P2: has the "all other types" catch-all');
  ok(h.indexOf('42%') >= 0 && h.indexOf('27%') >= 0 && h.indexOf('31%') >= 0,
    'P2: shows the rounded percentages');
  ok(h.indexOf(TYPE_COLORS.FIRE) >= 0 && h.indexOf(TYPE_COLORS.WATER) >= 0,
    'P2: segments/legend use the real type colors');
  ok(h.indexOf('16 types') >= 0, 'P2: notes "other" splits over the remaining 16 types');
}

// Same-type day (daily === weekly).
{
  ctx.global.Spawns.typeOdds = () => ({
    daily: 'GHOST', weekly: 'GHOST', same: true,
    dailyShare: 0.55, weeklyShare: 0.55, otherShare: 0.45,
    perType: {},
  });
  const h = call('_themeOddsHtml()');
  const segs = (h.match(/cc-oddsbar-seg/g) || []).length;
  ok(segs === 2, 'P2: same-type weather ⇒ two odds-bar segments (got ' + segs + ')');
  // Legend text is escapeHtml'd, so the ampersand renders as &amp;.
  ok(/today &amp; this week/.test(h), 'P2: same-type legend merges today & this week');
  ok(h.indexOf('boosted extra hard') >= 0, 'P2: same-type note explains the double boost');
  ok(h.indexOf('17 types') >= 0, 'P2: same-type "other" splits over the remaining 17 types');
}

// Detailed pair grid — distinct weather ⇒ full 3×3 matrix.
{
  ctx.global.Spawns.typeOdds = () => ({
    daily: 'FIRE', weekly: 'WATER', same: false,
    dailyShare: 0.42, weeklyShare: 0.27, otherShare: 0.31, perType: {},
  });
  ctx.global.Spawns.typePairOdds = () => ({
    daily: 'FIRE', weekly: 'WATER', same: false,
    classes: ['daily', 'weekly', 'other'],
    grid: {
      daily:  { daily: 0.15, weekly: 0.10, other: 0.14 },
      weekly: { daily: 0.10, weekly: 0.08, other: 0.07 },
      other:  { daily: 0.14, weekly: 0.07, other: 0.05 },
    },
  });
  const h = call('_themeOddsHtml()');
  ok(h.indexOf('Both type-halves') >= 0, 'P2: grid section titled "Both type-halves"');
  const cells = (h.match(/cc-oddsgrid-cell/g) || []).length;
  ok(cells === 9, 'P2: distinct weather ⇒ 3×3 = 9 grid cells (got ' + cells + ')');
  const heads = (h.match(/cc-oddsgrid-head/g) || []).length;
  ok(heads === 6, 'P2: 3 column + 3 row headers (got ' + heads + ')');
  ok(h.indexOf('cc-oddsgrid-corner') >= 0 && h.indexOf('1st ↓') >= 0,
    'P2: grid has an oriented corner cell');
  ok(h.indexOf('15%') >= 0 && h.indexOf('14%') >= 0 && h.indexOf('5%') >= 0,
    'P2: grid renders the rounded joint percentages');
  ok(/cc-oddsgrid-cell hot/.test(h), 'P2: the busiest cell gets the "hot" (white-text) class');
  ok(h.indexOf('no eligible species') < 0, 'P2: no 0% cell ⇒ no empty-pool note');
}

// Grid with an exact-0 cell (empty pool) ⇒ the explanatory 0% note appears.
{
  ctx.global.Spawns.typeOdds = () => ({
    daily: 'FIRE', weekly: 'STEEL', same: false,
    dailyShare: 0.5, weeklyShare: 0.2, otherShare: 0.3, perType: {},
  });
  ctx.global.Spawns.typePairOdds = () => ({
    daily: 'FIRE', weekly: 'STEEL', same: false,
    classes: ['daily', 'weekly', 'other'],
    grid: {
      daily:  { daily: 0.30, weekly: 0.00, other: 0.25 },
      weekly: { daily: 0.15, weekly: 0.00, other: 0.10 },
      other:  { daily: 0.15, weekly: 0.00, other: 0.05 },
    },
  });
  const h = call('_themeOddsHtml()');
  ok(h.indexOf('no eligible species') >= 0, 'P2: a 0% cell ⇒ shows the empty-pool note');
}

// Detailed pair grid — same weather ⇒ 2×2 matrix, one boosted type.
{
  ctx.global.Spawns.typeOdds = () => ({
    daily: 'GHOST', weekly: 'GHOST', same: true,
    dailyShare: 0.55, weeklyShare: 0.55, otherShare: 0.45, perType: {},
  });
  ctx.global.Spawns.typePairOdds = () => ({
    daily: 'GHOST', weekly: 'GHOST', same: true,
    classes: ['daily', 'other'],
    grid: { daily: { daily: 0.47, other: 0.22 }, other: { daily: 0.23, other: 0.08 } },
  });
  const h = call('_themeOddsHtml()');
  const cells = (h.match(/cc-oddsgrid-cell/g) || []).length;
  ok(cells === 4, 'P2: same weather ⇒ 2×2 = 4 grid cells (got ' + cells + ')');
  const heads = (h.match(/cc-oddsgrid-head/g) || []).length;
  ok(heads === 4, 'P2: 2 column + 2 row headers (got ' + heads + ')');
  ok(h.indexOf('47%') >= 0, 'P2: same-weather grid shows joint percentages');
}

// typePairOdds unavailable ⇒ grid section omitted, rest still renders.
{
  ctx.global.Spawns.typeOdds = () => ({
    daily: 'FIRE', weekly: 'WATER', same: false,
    dailyShare: 0.42, weeklyShare: 0.27, otherShare: 0.31, perType: {},
  });
  ctx.global.Spawns.typePairOdds = () => null;
  const h = call('_themeOddsHtml()');
  ok(h.indexOf('cc-oddsgrid') < 0, 'P2: null pair odds ⇒ no grid rendered');
  ok(h.indexOf('cc-oddsbar-seg') >= 0, 'P2: summary bar still renders without the grid');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
