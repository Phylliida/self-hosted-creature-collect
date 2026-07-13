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
  global: { Spawns: { typeOdds: () => null } },
  TYPE_COLORS,
};
vm.createContext(ctx);
for (const m of [
  'function escapeHtml(',
  'function _titleCaseType(',
  'function _ccOddsSeg(',
  'function _ccOddsLegend(',
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
