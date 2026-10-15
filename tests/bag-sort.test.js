// Tests bag item ordering (_bagEntryRank / _sortedBagEntries in
// static/creatures.js): incense first, then evolution items, then poké
// balls, then anything else — with count-desc / name-asc inside a category.
// Also (section 5) that every evolution item the default pack ships art
// for has a bag entry, and that the bag reads item info through
// getItemMeta (pack paintbrushes, IF2-only items) — KINGSROCK, METALCOAT,
// UPGRADE etc. used to show as bare text: raw key, no icon, no desc.
//
// Run: node tests/bag-sort.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

// comment-aware brace extractor (same approach as tests/daycare-odds.test.js)
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

// Representative catalog: berries (bonusIncense), incense (incenseType)
// and the community pass, evo items (evoItem), balls (catchShakeRate),
// and a placeholder "other".
const ITEMS = {
  candy_berry: { name: 'Candy Berry', bonusIncense: true },
  calm_berry: { name: 'Calm Berry', bonusIncense: true },
  community_pass: { name: 'Community Day Pass', communityDay: true },
  poke_ball: { name: 'Poké Ball', catchShakeRate: 0.8879 },
  great_ball: { name: 'Great Ball', catchShakeRate: 0.9655 },
  test_orb: { name: 'Test Orb' },
  THUNDERSTONE: { name: 'Thunder Stone', evoItem: true },
  FIRESTONE: { name: 'Fire Stone', evoItem: true },
  incense_fire: { name: 'Fire Incense', incenseType: 'FIRE' },
  incense_water: { name: 'Water Incense', incenseType: 'WATER' },
};
// Pack items (registerPackItems) live outside ITEMS.
const PACK_ITEMS = { neo_paintbrush_red: { name: 'Red Paintbrush', evoItem: true } };
const getItemMeta = (k) => ITEMS[k] || PACK_ITEMS[k] || null;

const ctx = { Object, Set, Array, Math, String, Number, ITEMS, getItemMeta };
vm.createContext(ctx);
vm.runInContext(extract('function _bagEntryRank('), ctx);
vm.runInContext(extract('function _sortedBagEntries('), ctx);
vm.runInContext(src.slice(src.indexOf('const BAG_SECTION_LABELS'), src.indexOf(';', src.indexOf('const BAG_SECTION_LABELS')) + 1)
  .replace('const ', 'var '), ctx);
vm.runInContext(extract('function _bagSections('), ctx);
const sections = (entries) => vm.runInContext('_bagSections(__e)', Object.assign(ctx, { __e: entries }));
const rank = (k) => vm.runInContext('_bagEntryRank(__k)', Object.assign(ctx, { __k: k }));
const sorted = (bag) => vm.runInContext('_sortedBagEntries(__bag)', Object.assign(ctx, { __bag: bag }));

// ── 1. Category ranks ──
ok(rank('community_pass') === 0, '1: the community day pass is rank 0 (always on top)');
ok(rank('candy_berry') === 1, '1: berries are rank 1');
ok(rank('incense_fire') === 2, '1: incense is rank 2');
ok(rank('THUNDERSTONE') === 3, '1: evo item is rank 3');
ok(rank('poke_ball') === 4, '1: poké ball is rank 4');
ok(rank('test_orb') === 5, '1: other item is rank 5');
ok(rank('totally_unknown_key') === 5, '1: unknown key falls to rank 5');

// ── 2. Full ordering across categories ──
{
  const entries = sorted({
    poke_ball: 5,
    incense_water: 1,
    THUNDERSTONE: 2,
    test_orb: 3,
    incense_fire: 1,
    FIRESTONE: 2,
    great_ball: 10,
    incense_grass: 0,   // zero count → dropped
    calm_berry: 1,
    community_pass: 2,
    candy_berry: 1,
  });
  const keys = entries.map(([k]) => k);
  ok(JSON.stringify(keys) === JSON.stringify([
    'community_pass',                  // the pass, always on top
    'calm_berry', 'candy_berry',       // berries: same count → name asc
    'incense_fire', 'incense_water',   // incense: same count → name asc
    'FIRESTONE', 'THUNDERSTONE',       // evo: same count → name asc (Fire < Thunder)
    'great_ball', 'poke_ball',         // balls: count desc (10 > 5)
    'test_orb',                        // other, last
  ]), '2: ordered pass → berries → incense → evo → balls → other, tiebroken by count then name');
  ok(!keys.includes('incense_grass'), '2: zero-count entry filtered out');
  // The list's section headers: one per category present, in order.
  const secs = sections(entries);
  ok(JSON.stringify(secs.map((s) => s.label))
     === JSON.stringify(['Passes', 'Berries', 'Incense', 'Evolution items', 'Poké Balls', 'Other']),
     '2: a header per category, in list order (' + secs.map((s) => s.label) + ')');
  ok(JSON.stringify(secs.map((s) => s.entries.map(([k]) => k)).flat()) === JSON.stringify(keys),
     '2: the sections hold every entry, in the same order');
  const few = sections(sorted({ poke_ball: 3, FIRESTONE: 1, neo_paintbrush_red: 2 }));
  ok(JSON.stringify(few.map((s) => [s.label, s.entries.length])) === JSON.stringify([['Evolution items', 2], ['Poké Balls', 1]]),
     '2: only categories you have get a header; pack paintbrushes count as evolution items');
}

// ── 3. Count-desc dominates name within a category ──
{
  const entries = sorted({ incense_water: 9, incense_fire: 1 });
  ok(entries[0][0] === 'incense_water', '3: higher count sorts first despite later name');
}

// ── 4. Empty / all-zero bag → no entries ──
{
  ok(sorted({}).length === 0, '4: empty bag yields no entries');
  ok(sorted({ poke_ball: 0, THUNDERSTONE: 0 }).length === 0, '4: all-zero bag yields no entries');
}

// ── 5. Every evolution item gets a bag entry ──
{
  ok(rank('neo_paintbrush_red') === 3, '5: pack paintbrush ranks with evolution items');
  const keys = sorted({ neo_paintbrush_red: 1, THUNDERSTONE: 1, FIRESTONE: 1 }).map(([k]) => k);
  ok(JSON.stringify(keys) === JSON.stringify(['FIRESTONE', 'neo_paintbrush_red', 'THUNDERSTONE']),
    '5: pack items sort by display name (Fire < Red < Thunder) — got ' + keys.join(','));

  const listSrc = src.slice(src.indexOf('const EVO_ITEM_KEYS = ['));
  const listed = new Set(listSrc.slice(0, listSrc.indexOf('];')).match(/'([A-Z0-9]+)'/g).map((q) => q.slice(1, -1)));
  const shipped = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'data', 'BundledData', 'evo-items-list.json'), 'utf8')).items;
  const unlisted = shipped.filter((k) => !listed.has(k));
  ok(shipped.length > 0 && !unlisted.length,
    '5: every evo item the default pack ships art for is in EVO_ITEM_KEYS (missing: ' + unlisted.join(',') + ')');
  const noArt = [...listed].filter((k) => !shipped.includes(k));
  ok(!noArt.length, '5: no EVO_ITEM_KEYS entry without shipped art (' + noArt.join(',') + ')');

  const bag = extract('function renderBag(');
  ok(/getItemMeta\(key\)/.test(bag) && !/ITEMS\[key\]/.test(bag),
    '5: bag rows read item info through getItemMeta (pack + on-demand items)');
  ok(/_evoItemOnDemand\(key\)/.test(extract('function getItemMeta(')),
    '5: getItemMeta falls back to evolution items the active data set uses');
}

// ── 6. An evolution item only another data set uses (IF2) ──
{
  const evos = { 1: [{ target: 2, method: 'Item', param: 'GALARICACUFF' }], 2: [{ target: 3, method: 'Level', param: 30 }] };
  const c6 = {
    Set, ITEMS: {}, BUNDLED_BASE: '/bundled-data', _packItems: new Map(),
    _EVO_ITEM_METHODS: new Set(['Item', 'TradeItem', 'DayHoldItem']),
    _formatItemName: (k) => k.charAt(0) + k.slice(1).toLowerCase(),
    global: { Species: { allSpecies: () => [{ id: 1 }, { id: 2 }], evolutionsFor: (id) => evos[id] || [] } },
  };
  vm.createContext(c6);
  for (const m of ['function _addEvoItem(', 'function getItemMeta(', 'function _evoItemOnDemand(', 'function _evoItemParams(']) vm.runInContext(extract(m), c6);
  vm.runInContext('let _evoParamSet = null;', c6);
  const meta = vm.runInContext('getItemMeta("GALARICACUFF")', c6);
  ok(meta && meta.evoItem && meta.icon === '/bundled-data/evo-items/GALARICACUFF.png' && meta.desc,
    '6: an item the data set\'s evolutions use gets an evo entry with its icon on demand');
  ok(vm.runInContext('getItemMeta("NOTANITEM")', c6) === null, '6: an unknown key still has no entry');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
