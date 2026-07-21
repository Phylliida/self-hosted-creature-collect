// Packs: the multi-pack registry — which creature pack is active, what
// each pack is called, and (in pack mode) loading the active pack's
// data into the runtime registries at boot.
//
// Today there are two packs:
//   creature-fusion — the builtin default. All existing code paths
//     (fusion pairs, species.json, sprite packs, shiny bin) are its
//     data model. Its records carry no explicit `pack` (legacy =
//     creature-fusion).
//   neopets       — a GMS-imported solo pack. Monsters are solo
//     creatures (id 'neo:<gmsId>') flowing through the Missingno
//     machinery.
//
// Active pack is `cc.activePack` in localStorage. Switching packs sets
// it (+ the native active marker) and RELOADS: the app boots fresh
// against the now-active content tree, so state never bleeds across
// packs. Inventory/eggs/daycare/dex are isolated per pack via the
// `pack` field on records + namespaced dex/candy keys.
//
// Headless-safe: registry/queries are pure; boot loading is no-op
// without fetch/document.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve (if tracked)
  if (global._scriptVersions) global._scriptVersions['packs.js'] = SCRIPT_VERSION;

  const ACTIVE_KEY = 'cc.activePack';
  const DEFAULT_PACK = 'creature-fusion';

  // Pack catalog. `remote.hfRepo` feeds pack-install's HF source; logo
  // for non-active packs is a static placeholder (never fetched without
  // a tap). New packs = new entry here (+ a build-gms-pack.py run).
  const CATALOG = [
    {
      id: 'creature-fusion',
      name: 'Pokémon',
      logo: '/static/poke-ball.svg',
      builtin: true,
      hfRepo: 'TessaCoil/creature-pack',
      solo: false,
    },
    {
      id: 'neopets',
      name: 'Neopets',
      logo: null,   // pack logo.png is shown once it's the active pack
      builtin: false,
      hfRepo: 'TessaCoil/neopets-pack',
      solo: true,
    },
  ];

  function list() { return CATALOG.slice(); }
  function get(id) { return CATALOG.find((p) => p.id === id) || null; }
  function active() {
    try {
      const v = localStorage.getItem(ACTIVE_KEY);
      return get(v) ? v : DEFAULT_PACK;
    } catch { return DEFAULT_PACK; }
  }
  function setActive(id) {
    if (!get(id)) return false;
    try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* ignore */ }
    // Point the native layer at the newly-active pack's files
    // (iOS: active.txt marker LocalServer reads; Android: cache
    // re-overlay). Fire-and-forget — the caller reloads anyway.
    if (global.PackInstall && global.PackInstall.setActiveNative) {
      try { global.PackInstall.setActiveNative(id).catch(() => {}); } catch { /* ignore */ }
    }
    return true;
  }
  function activeDef() { return get(active()) || CATALOG[0]; }
  function activeName() { return activeDef().name; }
  function isSoloMode() { return !!activeDef().solo; }

  // The pack a record belongs to: explicit field wins, legacy records
  // (pairs, missingno grants) are creature-fusion.
  function packOfRecord(rec) {
    if (rec && typeof rec.pack === 'string' && get(rec.pack)) return rec.pack;
    return DEFAULT_PACK;
  }

  // ── pack-mode data (loaded at boot for solo packs) ──
  // Filled by loadActivePackData(); empty in fusion mode.
  const _packData = {
    loaded: false,
    species: [],      // species.json entries
    speciesById: new Map(),
    categories: null, // categories.json
    items: [],        // items.json entries
    types: [],        // pack type ids (registry order)
  };
  function packData() { return _packData; }

  // Fetch the active solo pack's JSON registries and fold them into the
  // runtime: types -> global.Types.register, monsters -> global.Specials
  // .register, spawn pools -> global.Spawns.setPack. Fusion mode calls
  // Spawns.setPack(null) (default behavior). Safe to call once at boot.
  async function loadActivePackData() {
    if (_packData.loaded) return _packData;
    if (!isSoloMode()) {
      if (global.Spawns && global.Spawns.setPack) global.Spawns.setPack(null);
      _packData.loaded = true;
      return _packData;
    }
    const base = (global.CC_BUNDLED_DATA_BASE || '/bundled-data').replace(/\/$/, '');
    const fetchJson = async (name) => {
      const r = await fetch(`${base}/${name}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
      return r.json();
    };
    const [typesDoc, species, categories, items] = await Promise.all([
      fetchJson('types.json'), fetchJson('species.json'),
      fetchJson('categories.json'), fetchJson('items.json'),
    ]);

    // Types: register each pack type (appended after the builtin 18 —
    // the spawns module swaps weather to pack types via setPack, so the
    // contractual pokémon order is untouched).
    if (global.Types && typesDoc && Array.isArray(typesDoc.order)) {
      for (const tid of typesDoc.order) {
        const row = typesDoc.types[tid] || {};
        if (!global.Types.isValid(tid)) {
          global.Types.register({
            id: tid,
            color: row.color,
            strong: row.strong, weak: row.weak, immune: row.immune,
          });
        }
      }
      _packData.types = typesDoc.order.slice();
    }

    // Monsters: solo registry entries. Sprite path points into the
    // pack's image tree (served from the active pack content dir).
    const soloCategories = (categories && categories.soloCategories) || {};
    if (global.Specials && Array.isArray(species)) {
      for (const s of species) {
        if (!global.Specials.isSolo(s.id)) {
          const icon = (s.forms && s.forms[0] && s.forms[0].icon) || '';
          global.Specials.register({
            id: s.id,
            name: s.name,
            category: (soloCategories[s.id] || ['special'])[0],
            types: s.types,
            // Art lives in the pack's image tree, served from the
            // active pack content dir at /bundled-data/sprites/.
            sprite: icon ? 'sprites/' + icon : '',
            blurb: s.dexentry || '',
          });
        }
        _packData.speciesById.set(s.id, s);
      }
      _packData.species = species;
    }
    _packData.categories = categories || null;
    _packData.items = Array.isArray(items) ? items : [];
    // Fold the pack's items (paintbrushes) into the item catalog so
    // bag/daycare/bag surfaces can display them. Icons resolve into
    // the pack's image tree.
    if (global.Creatures && global.Creatures.registerPackItems) {
      const base = (global.CC_BUNDLED_DATA_BASE || '/bundled-data').replace(/\/$/, '');
      global.Creatures.registerPackItems(
        _packData.items.map((it) => ({
          key: it.key,
          name: it.name,
          kind: it.kind,
          icon: it.icon ? `${base}/sprites/${it.icon}` : '',
        })));
    }

    // Spawn pools: monsters with at least one type, rare families as
    // the legendary tier.
    if (global.Spawns && global.Spawns.setPack) {
      const monsters = _packData.species
        .filter((s) => s.types && s.types.length)
        .map((s) => ({
          key: s.id,
          types: s.types,
          forms: s.forms || [],
          genders: s.genders || [50, 50],
        }));
      const legendaryIds = new Set();
      for (const c of (_packData.categories && _packData.categories.categories) || []) {
        if (c.legendary) for (const m of c.members || []) legendaryIds.add(m);
      }
      const commons = monsters.filter((m) => !legendaryIds.has(m.key));
      const rares = monsters.filter((m) => legendaryIds.has(m.key));
      global.Spawns.setPack({
        id: active(),
        types: _packData.types,
        monsters: commons,
        rares,
      });
    }

    _packData.loaded = true;
    return _packData;
  }

  global.Packs = {
    list, get, active, setActive, activeDef, activeName, isSoloMode,
    packOfRecord, packData, loadActivePackData,
    ACTIVE_KEY, DEFAULT_PACK,
  };

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
