// Creature-collect UI: the bottom-right monster-ball button and the
// inventory sheet it opens. Gated by the "Creature mode" setting
// (cc.creatureMode, default on). No spawn logic yet — the inventory is
// seeded with two dummy creatures so the UI has something to show.
//
//   Creatures.install(map) -> { setEnabled(on), isEnabled(), show(), hide() }
//
// Mirrors the trip-planner.js factory shape so index.html stays the only
// place that wires modules together.

(function (global) {
  'use strict';

  const STORAGE_KEY = 'cc.creatureMode';
  const CAPTURED_KEY = 'cc.capturedCreatures';
  const CAUGHT_SPAWNS_KEY = 'cc.caughtSpawnIds';
  const SEEN_FUSIONS_KEY = 'cc.seenFusions';
  const CANDY_KEY = 'cc.candy.v1';
  // Candy is keyed by an evolution-family ROOT species index — every
  // species in a family contributes to (and reads from) the same
  // bucket. The flag below tracks the latest schema version; if it's
  // missing on read, readCandy clears the map and replays every
  // captured creature through the current award logic. Travels in
  // the export/import payload so re-imports don't re-trigger.
  //
  // History:
  //   cc.candyMigrated.speciesV1 (deprecated): one bucket per species
  //   cc.candyMigrated.familyV1  (deprecated): family-root, no baby skip
  //   cc.candyMigrated.familyV2  (current):    family-root, babies promoted
  const CANDY_MIGRATED_KEY = 'cc.candyMigrated.familyV2';
  // Known baby species that should NOT serve as a candy root — the
  // bucket promotes past them to the next stage so e.g. a Cleffa line
  // contributes "Clefairy candy", not "Cleffa candy". Even though our
  // current spawn pool is gen-1-only, gen-2 baby pre-evolutions still
  // sit at the head of evolution chains for gen-1 species (Cleffa →
  // Clefairy, Pichu → Pikachu, etc.), so familyOf walks back to them
  // and they need to be filtered out of root selection.
  const CANDY_ROOT_BABIES = new Set([
    172, // Pichu       → Pikachu
    173, // Cleffa      → Clefairy
    174, // Igglybuff   → Jigglypuff
    175, // Togepi      → Togetic (Togepi treated as baby for consistency)
    236, // Tyrogue     → Hitmonlee/Hitmonchan/Hitmontop
    238, // Smoochum    → Jynx
    239, // Elekid      → Electabuzz
    240, // Magby       → Magmar
  ]);
  const BAG_KEY = 'cc.bag.v1';
  const TAGS_KEY = 'cc.tags.v1';
  const TAG_MAX_LEN = 8;
  const LAST_SAVE_KEY = 'cc.lastSaveAt';
  const SAVE_REMINDER_DAYS = 7;

  // Item catalog. Bag is stored as a flat `{ <key>: <count> }` map (same
  // shape as candy); this catalog maps keys to display names + an SVG
  // icon path. Future items only need a one-line entry here.
  const ITEMS = {
    poke_ball: {
      name: 'Poké Ball',
      desc: 'Standard capture device.',
      icon: '/static/poke-ball.svg',
      // Per-shake stay-closed probability. 3 shakes are checked;
      // a single failure breaks out at that shake. Catch chance
      // overall = catchShakeRate^3 (≈ 70% for 0.8879).
      catchShakeRate: 0.8879,
    },
    great_ball: {
      name: 'Great Ball',
      desc: 'Improved capture device — better catch rate.',
      icon: '/static/great-ball.svg',
      catchShakeRate: 0.9655, // ≈ 90% catch
    },
  };
  // Items the pokéstop "Collect items" button can grant. Each press
  // samples 1-3 items uniformly from this list (with replacement).
  const COLLECTIBLE_ITEM_KEYS = ['poke_ball', 'great_ball'];
  // Items the player can throw at a wild creature. Order here drives
  // the order they appear in the battle screen's ball list.
  const THROWABLE_BALL_KEYS = ['poke_ball', 'great_ball'];
  // Starter items granted on first-ever bag read (anyone who's played
  // before gets these too on next load).
  const STARTER_BAG = { poke_ball: 2 };

  // Captured inventory lives as an array of entries keyed by their own
  // `id`. We intentionally store speciesA/B (not the derived display
  // name) so names update if/when the species-names list loads later.
  function readCapturedCreatures() {
    try {
      const raw = localStorage.getItem(CAPTURED_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }
  function writeCapturedCreatures(arr) {
    localStorage.setItem(CAPTURED_KEY, JSON.stringify(arr));
  }

  // Candy: earned per-capture, keyed by EVOLUTION-FAMILY ROOT (a
  // species index). Stored as `{ <rootIdxStr>: <count> }`. Charizard
  // and Charmander both contribute to (and consume) "Charmander
  // candy" because they share a family root.
  //
  // Award rule (post-promotion to roots):
  //   rootA === rootB  → 2 candy of that one root
  //   rootA !== rootB  → uniform random over three outcomes:
  //                        2 candy of rootA, OR
  //                        2 candy of rootB, OR
  //                        1 candy of rootA and 1 candy of rootB
  //
  // No spend mechanism yet — saved against a future evolve / item
  // mechanic.
  function readCandyRaw() {
    try {
      const raw = localStorage.getItem(CANDY_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }
  function writeCandy(map) {
    localStorage.setItem(CANDY_KEY, JSON.stringify(map));
  }
  function bumpCandy(speciesIdx, n) {
    const map = readCandyRaw();
    const k = String(speciesIdx);
    map[k] = (map[k] || 0) + n;
    writeCandy(map);
  }
  // Walk a species' evolution family and return the index that all
  // members of the family share their candy bucket under: the earliest
  // non-baby form. If species data isn't loaded yet, falls back to the
  // species itself — the migration step below is gated on data being
  // loaded so a temporary fallback doesn't poison the canonical map.
  function candyRootFor(idx) {
    if (idx == null) return idx;
    if (!global.Species || !global.Species.familyOf) return idx;
    const family = global.Species.familyOf(idx);
    if (!family || !family.length) return idx;
    let i = 0;
    while (i < family.length - 1 && CANDY_ROOT_BABIES.has(family[i])) {
      i++;
    }
    return family[i];
  }
  function awardCandyForCapture(speciesA, speciesB) {
    if (speciesA == null || speciesB == null) return;
    const rootA = candyRootFor(speciesA);
    const rootB = candyRootFor(speciesB);
    if (rootA === rootB) {
      bumpCandy(rootA, 2);
      return;
    }
    const r = Math.random();
    if (r < 1 / 3) {
      bumpCandy(rootA, 2);
    } else if (r < 2 / 3) {
      bumpCandy(rootB, 2);
    } else {
      bumpCandy(rootA, 1);
      bumpCandy(rootB, 1);
    }
  }
  // One-shot lazy migration to the current candy schema (family-root
  // keyed). Triggered from readCandy on first call when the flag is
  // unset. Gated on Species data being loaded — without it,
  // candyRootFor falls back to the species idx and we'd produce a
  // bad species-keyed map. Clears any existing candy and replays
  // every captured creature through awardCandyForCapture so the user
  // ends up with a distribution matching their full play history
  // under the current rules.
  function migrateCandyIfNeeded() {
    if (localStorage.getItem(CANDY_MIGRATED_KEY) === '1') return;
    if (!global.Species || !global.Species.familyOf) return;
    writeCandy({});
    const captured = readCapturedCreatures();
    for (const c of captured) {
      if (!c) continue;
      awardCandyForCapture(c.speciesA, c.speciesB);
    }
    localStorage.setItem(CANDY_MIGRATED_KEY, '1');
    // Clean up older schema flags so a stale entry can't quietly
    // resurface if anything ever reads them by name.
    localStorage.removeItem('cc.candyMigrated.speciesV1');
    localStorage.removeItem('cc.candyMigrated.familyV1');
  }
  function readCandy() {
    migrateCandyIfNeeded();
    return readCandyRaw();
  }

  // Item bag. Same shape as candy: `{ <itemKey>: <count> }` flat map.
  // First-ever read seeds STARTER_BAG so existing players get balls
  // on next load. Subsequent reads return whatever's there (including
  // empty `{}` if the user spent everything — no auto re-seed).
  // Lazy migration: legacy `capture_sphere` entries are folded into
  // `poke_ball` (renamed item) on read.
  function readBag() {
    const raw = localStorage.getItem(BAG_KEY);
    if (raw === null) {
      const seed = { ...STARTER_BAG };
      writeBag(seed);
      return seed;
    }
    let bag;
    try { bag = JSON.parse(raw) || {}; } catch { return {}; }
    if (bag.capture_sphere && bag.capture_sphere > 0) {
      bag.poke_ball = (bag.poke_ball || 0) + bag.capture_sphere;
      delete bag.capture_sphere;
      writeBag(bag);
    }
    return bag;
  }
  function writeBag(map) {
    localStorage.setItem(BAG_KEY, JSON.stringify(map));
  }
  // Public hook for awarding items from outside this module — used by
  // the POI "Collect items" button in index.html (the start of the
  // pokestop system). Resolves the bag-read first so the lazy starter
  // pack is in place before the bump applies.
  function grantItem(itemKey, count) {
    if (!itemKey) return;
    const n = Number(count) || 0;
    if (n <= 0) return;
    const bag = readBag();
    bag[itemKey] = (bag[itemKey] || 0) + n;
    writeBag(bag);
  }
  // Decrement an item's count. Returns true on success, false if the
  // bag didn't have enough. Removes the key entirely when its count
  // hits zero so empty entries don't litter the map.
  function consumeItem(itemKey, count) {
    if (!itemKey) return false;
    const n = Number(count) || 1;
    if (n <= 0) return false;
    const bag = readBag();
    const have = bag[itemKey] || 0;
    if (have < n) return false;
    const next = have - n;
    if (next > 0) bag[itemKey] = next;
    else delete bag[itemKey];
    writeBag(bag);
    return true;
  }

  // Built-in tags are predicate-driven and never stored on a capture
  // record. They render alongside user tags everywhere (Tags menu,
  // detail-view picker, inventory filter row) but can't be created,
  // deleted, or toggled by the user. Add new ones by appending here.
  const BUILTIN_TAGS = [
    {
      name: 'Pure',
      description: 'Same species on both sides (no fusion).',
      predicate: (c) => c && c.speciesA != null && c.speciesA === c.speciesB,
    },
  ];
  const BUILTIN_TAG_NAMES = new Set(BUILTIN_TAGS.map((b) => b.name));
  function isBuiltinTag(name) { return BUILTIN_TAG_NAMES.has(name); }
  function builtinTagsForCreature(c) {
    return BUILTIN_TAGS.filter((b) => b.predicate(c)).map((b) => b.name);
  }
  // The full set of tags currently on a creature, combining the user-
  // applied stored tags with any built-ins whose predicate matches.
  // Stored entries that happen to collide with a built-in name (e.g.
  // legacy data from before Pure existed) are filtered out so the
  // built-in's predicate stays authoritative.
  function effectiveTagsForCreature(c) {
    const stored = Array.isArray(c.tags) ? c.tags : [];
    const builtin = builtinTagsForCreature(c);
    return Array.from(new Set([
      ...builtin,
      ...stored.filter((t) => !BUILTIN_TAG_NAMES.has(t)),
    ]));
  }
  // The ordered list of all tag names that should appear in pickers
  // (Tags menu, detail picker, inventory filter row): built-ins first
  // in their declaration order, then user-created tags in creation
  // order. User tags that collide with built-in names are hidden so
  // the picker never shows two "Pure" entries side-by-side.
  function allTagNames() {
    const userTags = readTags().filter((t) => !BUILTIN_TAG_NAMES.has(t));
    return [...BUILTIN_TAGS.map((b) => b.name), ...userTags];
  }

  // Tags: a flat ordered list of short label strings. Each captured
  // creature can carry zero or more of these on its `tags` field.
  // Tag names are 1..TAG_MAX_LEN chars, trimmed, deduped (case-
  // sensitive). Order is the user's creation order — not sorted.
  // Built-in tag names (BUILTIN_TAG_NAMES above) are reserved.
  function readTags() {
    try {
      const raw = localStorage.getItem(TAGS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function writeTags(arr) {
    localStorage.setItem(TAGS_KEY, JSON.stringify(arr));
  }
  function normalizeTagName(raw) {
    if (typeof raw !== 'string') return null;
    const t = raw.trim();
    if (!t) return null;
    if (t.length > TAG_MAX_LEN) return null;
    return t;
  }
  function addTag(name) {
    const t = normalizeTagName(name);
    if (!t) return false;
    if (isBuiltinTag(t)) return false;
    const list = readTags();
    if (list.includes(t)) return false;
    list.push(t);
    writeTags(list);
    return true;
  }
  // Delete a tag from the global list AND strip it from every captured
  // creature that has it. Returns the count of creatures touched so the
  // caller can surface a confirmation message. Built-in tags are
  // protected — calls with a built-in name are no-ops.
  function deleteTag(name) {
    if (isBuiltinTag(name)) return 0;
    const list = readTags();
    const idx = list.indexOf(name);
    if (idx < 0) return 0;
    list.splice(idx, 1);
    writeTags(list);
    const captured = readCapturedCreatures();
    let touched = 0;
    for (const c of captured) {
      if (!Array.isArray(c.tags)) continue;
      const j = c.tags.indexOf(name);
      if (j >= 0) {
        c.tags.splice(j, 1);
        touched++;
      }
    }
    if (touched) writeCapturedCreatures(captured);
    // Also strip from the inventory's active tag-filter selection so a
    // since-deleted tag doesn't keep the filter "stuck" inert.
    const sel = readInvTagFilter();
    const si = sel.indexOf(name);
    if (si >= 0) {
      sel.splice(si, 1);
      writeInvTagFilter(sel);
    }
    return touched;
  }
  // Tags applied to a single capture. Returns a fresh array (caller
  // can mutate without affecting storage).
  function getCreatureTags(id) {
    const c = readCapturedCreatures().find((x) => x.id === id);
    if (!c || !Array.isArray(c.tags)) return [];
    return c.tags.slice();
  }
  function toggleCreatureTag(id, tagName) {
    // Built-in tags are computed from a predicate; toggling is a no-op.
    if (isBuiltinTag(tagName)) return false;
    const list = readCapturedCreatures();
    const c = list.find((x) => x.id === id);
    if (!c) return false;
    const tags = Array.isArray(c.tags) ? c.tags.slice() : [];
    const i = tags.indexOf(tagName);
    if (i >= 0) tags.splice(i, 1); else tags.push(tagName);
    c.tags = tags;
    writeCapturedCreatures(list);
    return true;
  }

  // Caught spawn IDs — once a spawn has been captured locally, we don't
  // want its marker to keep reappearing until the time bucket rotates.
  // Other players on other devices still see the spawn (no server).
  function readCaughtSpawnIds() {
    try {
      const raw = localStorage.getItem(CAUGHT_SPAWNS_KEY);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  }
  function writeCaughtSpawnIds(set) {
    localStorage.setItem(CAUGHT_SPAWNS_KEY, JSON.stringify([...set]));
  }
  function markSpawnCaught(spawnId) {
    const set = readCaughtSpawnIds();
    set.add(spawnId);
    writeCaughtSpawnIds(set);
  }
  // Prune caught-spawn IDs whose creature has already aged out of the
  // sliding window. Spawn IDs encode the birth-tick — anything older
  // than the current tick minus LIFETIME is already invisible and
  // just bloats the Set. Runs once per refresh.
  function pruneCaughtSpawnIds() {
    if (!global.Spawns || !global.Spawns.isSpawnIdStale) return;
    const set = readCaughtSpawnIds();
    let changed = false;
    for (const id of set) {
      if (global.Spawns.isSpawnIdStale(id)) {
        set.delete(id);
        changed = true;
      }
    }
    if (changed) writeCaughtSpawnIds(set);
  }

  // Inventory view: captured creatures, normalized to the shape the
  // render/sort/search code already expects (id, name, level, sizeM,
  // plus speciesA/B, variant, and caughtAt for the detail view).
  // Legacy captures without a `variant` field render with the autogen
  // sprite (their original look — IDB still has that blob).
  function getInventoryCreatures() {
    return readCapturedCreatures().map((e) => ({
      id: e.id,
      speciesA: e.speciesA,
      speciesB: e.speciesB,
      variant: (typeof e.variant === 'number') ? e.variant : null,
      level: e.level,
      sizeM: e.sizeM,
      name: fusionName(e.speciesA, e.speciesB),
      caughtAt: e.caughtAt,
      tags: Array.isArray(e.tags) ? e.tags.slice() : [],
    }));
  }

  // Resolve a spawn's deterministic variantSeed (uniform [0,1)) to a
  // concrete variant index using the per-cell custom-variant count
  // currently in IDB. Returns null when the cell has no custom variants
  // or the sprites module isn't loaded — caller should fall back to
  // autogen. Different players see the same variant for the same spawn
  // because variantSeed is part of the deterministic spawn generation.
  async function resolveSpawnVariant(spawn) {
    if (!global.Sprites || typeof spawn.variantSeed !== 'number') return null;
    try {
      const count = await global.Sprites.getCellVariantCount(spawn.speciesA, spawn.speciesB);
      if (!count || count <= 0) return null;
      return Math.floor(spawn.variantSeed * count);
    } catch (e) {
      _logCreatureError(`resolveSpawnVariant/${spawn.speciesA}-${spawn.speciesB}`, e);
      return null;
    }
  }

  // Pokédex storage: every fusion we've ever opened the battle screen
  // for, even if it wasn't caught. Captured creatures are backfilled
  // into this set on first read so existing players don't lose history.
  function readSeenFusions() {
    try {
      const raw = localStorage.getItem(SEEN_FUSIONS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }
  function writeSeenFusions(map) {
    try { localStorage.setItem(SEEN_FUSIONS_KEY, JSON.stringify(map)); } catch {}
  }
  function markFusionSeen(a, b, spawn, variant) {
    if (a == null || b == null) return;
    const seen = readSeenFusions();
    const key = `${a}-${b}`;
    const now = Date.now();
    if (!seen[key]) seen[key] = { firstSeen: now };
    seen[key].lastSeen = now;
    if (spawn && spawn.lat != null && spawn.lng != null) {
      // Record the encounter location once (on the first sighting); the
      // sub-view shows it for fusions you've only encountered, not caught.
      if (seen[key].lat == null) {
        seen[key].lat = spawn.lat;
        seen[key].lng = spawn.lng;
        const poiApi = global.CreatureCollectAPI;
        if (poiApi && poiApi.findNearestNamedPoi) {
          seen[key].poi = poiApi.findNearestNamedPoi(spawn.lat, spawn.lng) || null;
        }
      }
    }
    // Per-variant tracking. `variant` is a number (custom variant
    // index) or null/undefined (autogen). Stored as a map keyed by
    // 'auto' or the integer index → timestamp. The fusion sub-view
    // uses this to silhouette variants the user hasn't seen.
    if (variant !== undefined) {
      if (!seen[key].variants) seen[key].variants = {};
      const vKey = (typeof variant === 'number' && variant >= 0) ? String(variant) : 'auto';
      if (!seen[key].variants[vKey]) seen[key].variants[vKey] = now;
    }
    writeSeenFusions(seen);
  }
  // Returns a Set of seen variant keys for a fusion. Set members are
  // 'auto' (for the autogen sprite) or stringified integers for
  // custom variant indices. Backfills from captures with a variant
  // field on first call (lazy migration so legacy users get
  // something sensible).
  function readSeenVariants(a, b) {
    const seen = readSeenFusions();
    const key = `${a}-${b}`;
    const out = new Set();
    if (seen[key] && seen[key].variants) {
      for (const k of Object.keys(seen[key].variants)) out.add(k);
    }
    // Backfill from captures — anything with c.variant set tells us
    // exactly which variant was seen at capture time.
    for (const c of readCapturedCreatures()) {
      if (c.speciesA !== a || c.speciesB !== b) continue;
      if (typeof c.variant === 'number' && c.variant >= 0) out.add(String(c.variant));
      else if (c.variant === null) out.add('auto');
    }
    return out;
  }
  // One-time migration for legacy captures without a `variant`
  // field. Picks slot 0 (the artist's primary variant if any custom
  // exists, else autogen) — best-guess given we can't know which
  // variant the user actually caught back then. Updates the capture
  // record AND adds an entry to seenFusions[key].variants so the
  // pokédex variant grid lights up the picked slot.
  // Async because the per-cell variant count lives in IDB; gated by
  // `cc.variantBackfillDone.v1` flag so it only runs once.
  const VARIANT_BACKFILL_KEY = 'cc.variantBackfillDone.v1';
  async function migrateLegacyCaptureVariants() {
    if (localStorage.getItem(VARIANT_BACKFILL_KEY) === '1') return;
    if (!global.Sprites || !global.Sprites.getCellVariantCount) return;
    const list = readCapturedCreatures();
    const seen = readSeenFusions();
    let touched = false;
    // Cache per-cell variant counts so we don't hit IDB once per
    // capture for the same fusion pair.
    const countCache = new Map();
    async function countFor(a, b) {
      const key = `${a}-${b}`;
      if (countCache.has(key)) return countCache.get(key);
      let c = 0;
      try { c = await global.Sprites.getCellVariantCount(a, b); }
      catch { c = 0; }
      countCache.set(key, c);
      return c;
    }
    for (const c of list) {
      if (typeof c.variant === 'number' || c.variant === null) continue;
      if (c.speciesA == null || c.speciesB == null) continue;
      const cnt = await countFor(c.speciesA, c.speciesB);
      const slot = cnt > 0 ? 0 : null;
      c.variant = slot;
      const fkey = `${c.speciesA}-${c.speciesB}`;
      if (!seen[fkey]) seen[fkey] = { firstSeen: (c.caughtAt && c.caughtAt.timestamp) || Date.now() };
      if (!seen[fkey].variants) seen[fkey].variants = {};
      const vKey = slot === null ? 'auto' : String(slot);
      if (!seen[fkey].variants[vKey]) {
        seen[fkey].variants[vKey] = (c.caughtAt && c.caughtAt.timestamp) || Date.now();
      }
      touched = true;
    }
    if (touched) {
      writeCapturedCreatures(list);
      writeSeenFusions(seen);
    }
    localStorage.setItem(VARIANT_BACKFILL_KEY, '1');
  }

  // One-time idempotent migration: anything in the captured inventory
  // is by definition seen too. Runs at install time.
  function backfillSeenFromCaptures() {
    const seen = readSeenFusions();
    let changed = false;
    for (const c of readCapturedCreatures()) {
      if (c.speciesA == null || c.speciesB == null) continue;
      const key = `${c.speciesA}-${c.speciesB}`;
      if (!seen[key]) {
        seen[key] = { firstSeen: (c.caughtAt && c.caughtAt.timestamp) || Date.now() };
        changed = true;
      }
    }
    if (changed) writeSeenFusions(seen);
  }
  function isFusionSeen(a, b) {
    return readSeenFusions().hasOwnProperty(`${a}-${b}`);
  }
  // Lowest-indexed variant slot the trainer has actually seen for this
  // fusion. Returns: a number (numeric slot), null (only autogen seen),
  // or undefined (nothing seen — caller should fall back to defaults).
  function pickPreferredSeenVariant(a, b) {
    const seen = readSeenVariants(a, b);
    if (!seen.size) return undefined;
    let lowest = Infinity;
    for (const k of seen) {
      const n = parseInt(k, 10);
      if (Number.isFinite(n) && n >= 0 && n < lowest) lowest = n;
    }
    if (lowest !== Infinity) return lowest;
    if (seen.has('auto')) return null;
    return undefined;
  }
  function caughtFusionsSet() {
    const set = new Set();
    for (const c of readCapturedCreatures()) {
      if (c.speciesA != null && c.speciesB != null) {
        set.add(`${c.speciesA}-${c.speciesB}`);
      }
    }
    return set;
  }

  // Default display name for a fusion. Prefers the canonical fused
  // name from SPLIT_NAMES (e.g. "Jigglyish") when the table is loaded,
  // falling back to "A × B" while names are still downloading or for
  // species outside the table's range. Nicknames take priority over
  // this everywhere they're checked, so user-authored renames are
  // preserved.
  function fusionName(a, b) {
    if (global.Sprites && global.Sprites.getFusedName) {
      const fused = global.Sprites.getFusedName(a, b);
      if (fused) return fused;
    }
    if (global.Species) {
      return `${global.Species.nameFor(a)} × ${global.Species.nameFor(b)}`;
    }
    return `#${a} × #${b}`;
  }

  // Standard Pokémon type colors (close-enough to canon for chips).
  const TYPE_COLORS = {
    NORMAL:   '#A8A77A', FIGHTING: '#C22E28', FLYING:   '#A98FF3',
    POISON:   '#A33EA1', GROUND:   '#E2BF65', ROCK:     '#B6A136',
    BUG:      '#A6B91A', GHOST:    '#735797', STEEL:    '#B7B7CE',
    FIRE:     '#EE8130', WATER:    '#6390F0', GRASS:    '#7AC74C',
    ELECTRIC: '#F7D02C', PSYCHIC:  '#F95587', ICE:      '#96D9D6',
    DRAGON:   '#6F35FC', DARK:     '#705746', FAIRY:    '#D685AD',
  };

  function typeChipsHtml(types) {
    if (!types || !types.length) return '';
    return `<div class="type-chips">` + types.map((t) => {
      const bg = TYPE_COLORS[t] || '#888';
      const label = t.charAt(0) + t.slice(1).toLowerCase();
      return `<span class="type-chip" style="background:${bg}">${escapeHtml(label)}</span>`;
    }).join('') + `</div>`;
  }

  function fusionTypesFor(a, b) {
    return global.Species && global.Species.fusionTypesFor
      ? global.Species.fusionTypesFor(a, b)
      : [];
  }

  // Tag picker for the detail view. Chips for:
  //   - every built-in tag whose predicate fires for THIS creature
  //     (so e.g. "Pure" only appears for monotype captures, never as
  //     a non-applicable chip on a real fusion)
  //   - every user-created tag (toggleable, applied state shown)
  // Built-in chips are non-clickable (their applied state comes from
  // a predicate, not user choice). User chips toggle membership.
  function detailTagsHtml(creature) {
    const matchedBuiltins = builtinTagsForCreature(creature);
    const userTags = readTags().filter((t) => !isBuiltinTag(t));
    const names = [...matchedBuiltins, ...userTags];
    if (!names.length) {
      return `<div class="detail-tags-empty">No tags yet \u2014 create some in the Tags menu.</div>`;
    }
    const applied = new Set(effectiveTagsForCreature(creature));
    const chips = names.map((t) => {
      const builtin = isBuiltinTag(t);
      const classes = ['detail-tag-chip'];
      if (applied.has(t)) classes.push('applied');
      if (builtin) classes.push('builtin');
      // Built-in chips intentionally don't carry a data-tag — the
      // click handler bails on missing data-tag, so it acts as a
      // visual-only chip without using the browser's disabled style
      // (which would override our custom appearance).
      const attrs = builtin ? '' : `data-tag="${escapeHtml(t)}"`;
      return `<button class="${classes.join(' ')}" type="button" ${attrs}>${escapeHtml(t)}</button>`;
    }).join('');
    return `<div class="detail-tags">${chips}</div>`;
  }

  // Inline candy tally for an opened pokémon. Pivots both species to
  // their family roots first, then dedupes — so Charizard×Charmander
  // shows a single "Charmander candy" pip (both sides share a root)
  // and Growlithe×Vulpix shows both. Uses readCandy so opening a
  // detail/fusion view triggers the lazy schema migration.
  function candyTallyHtml(speciesA, speciesB) {
    if (speciesA == null || speciesB == null) return '';
    const candy = readCandy();
    const rootA = candyRootFor(speciesA);
    const rootB = candyRootFor(speciesB);
    const roots = (rootA === rootB) ? [rootA] : [rootA, rootB];
    const parts = roots.map((idx) => {
      const name = speciesNameFor(idx);
      const count = candy[String(idx)] || 0;
      return `<span class="candy-tally-pip">${escapeHtml(name)} candy <b>×${count}</b></span>`;
    });
    return `<div class="candy-tally">${parts.join(' · ')}</div>`;
  }

  function fusionEvolutionsFor(a, b) {
    return global.Species && global.Species.fusionEvolutionsFor
      ? global.Species.fusionEvolutionsFor(a, b)
      : [];
  }

  // Windowed virtualizer for the pokédex / inventory grids. Renders
  // only the rows whose y-range overlaps the visible viewport (+ a
  // 2-row buffer above and below). Card height is measured once from
  // a hidden sample so we don't have to hardcode it across themes /
  // viewport widths.
  //
  //   opts: {
  //     scrollEl,           // element with overflow-y:auto (the .sheet)
  //     gridEl,             // the grid container we virtualize inside
  //     items,              // array of opaque item objects
  //     cols,               // column count (e.g. 3)
  //     rowGap,             // px gap between rows
  //     makeCardEl(item, i) // returns the DOM for one card
  //     loadSpriteFor(card, item) // optional async sprite hook
  //   }
  function virtualizeGrid(opts) {
    const { scrollEl, gridEl, items, cols, rowGap,
            makeCardEl, loadSpriteFor, initialScrollTop } = opts;

    // Tear down any previous virtualization on this grid before starting
    // a new one (filter / sort changes re-enter renderPokedex etc.).
    if (gridEl._virtCleanup) gridEl._virtCleanup();
    gridEl.innerHTML = '';

    if (!items.length) {
      gridEl.style.height = '';
      gridEl.style.display = '';
      gridEl.style.position = '';
      return;
    }

    // Card height is hardcoded per caller (see opts.cardHeight). We
    // tried dynamic measurement but it was unreliable on the panel's
    // first show — even with the sample card rendered as a real grid
    // item, the first measurement could come back too short and cause
    // overlap. The hardcoded value is set by each grid type to match
    // what its cards actually render at on a typical viewport. Cards
    // also have a matching explicit CSS height so they can't overflow
    // beyond their slot.
    const cardH = opts.cardHeight || 160;

    const rowPitch = cardH + rowGap;
    const numRows = Math.ceil(items.length / cols);

    gridEl.style.position = 'relative';
    gridEl.style.display = 'block';
    gridEl.style.height = (numRows * rowPitch - rowGap) + 'px';

    const renderedRows = new Map();

    function renderRow(rowIdx) {
      const row = document.createElement('div');
      row.style.cssText = `
        position: absolute; left: 0; right: 0;
        top: ${rowIdx * rowPitch}px;
        display: grid; gap: ${rowGap}px;
        grid-template-columns: repeat(${cols}, 1fr);
      `;
      for (let c = 0; c < cols; c++) {
        const idx = rowIdx * cols + c;
        if (idx >= items.length) break;
        const cardEl = makeCardEl(items[idx], idx);
        row.appendChild(cardEl);
        if (loadSpriteFor) loadSpriteFor(cardEl, items[idx]);
      }
      return row;
    }

    function recomputeWindow() {
      // Cheap escape: when this grid's view is hidden (display:none on
      // any ancestor), offsetParent is null and we can skip.
      if (gridEl.offsetParent === null) return;
      const scrollTop = scrollEl.scrollTop;
      const viewportH = scrollEl.clientHeight;
      // gridEl.offsetTop gives the grid's offset within its nearest
      // positioned ancestor (the .sheet, which is position:relative).
      const gridTop = gridEl.offsetTop;
      const localTop = Math.max(0, scrollTop - gridTop);
      const buffer = rowPitch * 2;
      const startRow = Math.max(0, Math.floor((localTop - buffer) / rowPitch));
      const endRow = Math.min(
        numRows - 1,
        Math.ceil((localTop + viewportH + buffer) / rowPitch));

      for (const [r, el] of renderedRows) {
        if (r < startRow || r > endRow) {
          revokeObjectUrlsIn(el);
          el.remove();
          renderedRows.delete(r);
        }
      }
      for (let r = startRow; r <= endRow; r++) {
        if (renderedRows.has(r)) continue;
        const rowEl = renderRow(r);
        gridEl.appendChild(rowEl);
        renderedRows.set(r, rowEl);
      }
    }

    let pending = false;
    function scheduleUpdate() {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; recomputeWindow(); });
    }
    scrollEl.addEventListener('scroll', scheduleUpdate, { passive: true });
    // Restore the caller's scroll position BEFORE the first
    // recomputeWindow so it renders the correct visible row band on
    // the first paint — avoids a 1-frame flash of "scrolled to top"
    // before settling. The full grid height is already set above so
    // assigning scrollTop is valid.
    if (initialScrollTop != null && initialScrollTop > 0) {
      scrollEl.scrollTop = initialScrollTop;
    }
    recomputeWindow();
    // Safety net: when the panel just became visible synchronously,
    // ancestor display/styles may not be fully computed yet, so the
    // first recomputeWindow's offsetParent check can bail and leave
    // the grid blank until the user scrolls. A second pass on the
    // next animation frame fixes that without anyone needing to
    // touch the wheel. Re-applies scrollTop in case display was none
    // during the first attempt (which would have clamped it to 0).
    requestAnimationFrame(() => {
      if (initialScrollTop != null && initialScrollTop > 0
          && scrollEl.scrollTop !== initialScrollTop) {
        scrollEl.scrollTop = initialScrollTop;
      }
      recomputeWindow();
    });

    gridEl._virtCleanup = () => {
      scrollEl.removeEventListener('scroll', scheduleUpdate);
      // Revoke every still-loading sprite URL before wiping the rows,
      // otherwise their blobs hang around in memory.
      revokeObjectUrlsIn(gridEl);
      renderedRows.clear();
      gridEl.innerHTML = '';
      gridEl.style.height = '';
      gridEl.style.position = '';
      gridEl.style.display = '';
      delete gridEl._virtCleanup;
    };

    // Web fonts may still be loading the very first time the inventory
    // panel opens after page load — our sample measure then uses
    // fallback-font metrics which can be shorter than the real font's,
    // producing row overlap. Re-virtualize once fonts settle so the
    // row pitch corrects itself. No-op on subsequent opens because
    // status is already 'loaded' by then.
    if (document.fonts && document.fonts.status !== 'loaded') {
      const myCleanup = gridEl._virtCleanup;
      document.fonts.ready.then(() => {
        // Bail if a different render has replaced ours since.
        if (gridEl._virtCleanup !== myCleanup) return;
        virtualizeGrid(opts);
      });
    }
  }

  // Revoke any object URLs held by `<img>` children of this element.
  // Call before detaching the element from the DOM to prevent the blob
  // it points to from leaking — img.onload is what normally revokes,
  // but onload doesn't fire if the load is interrupted (e.g. the row
  // gets virtualized out of view before the sprite finishes decoding).
  function revokeObjectUrlsIn(el) {
    if (!el) return;
    el.querySelectorAll('img').forEach((img) => {
      const src = img.src;
      if (src && src.startsWith('blob:')) {
        URL.revokeObjectURL(src);
        img.removeAttribute('src');
      }
    });
  }

  // Lazy sprite loader for grid views. Items array is
  //   [{ card, a, b }, ...]
  // and `apply(card, url)` is the per-card hook that wires the loaded
  // object-URL into the card's DOM (different markup for inventory vs
  // pokédex). IntersectionObserver fires when a card scrolls within
  // rootMargin of the viewport, so we never touch IDB for cards the
  // user hasn't scrolled to. Old observers attached to the same root
  // are disconnected so re-renders don't leak.
  function lazyLoadSpritesIntoGrid(rootEl, items, apply) {
    if (!global.Sprites || !items.length) return;
    if (rootEl._spriteObserver) {
      rootEl._spriteObserver.disconnect();
      rootEl._spriteObserver = null;
    }
    // Each item may carry a `variant` field:
    //   - number: render that custom variant index (captured creatures
    //             carry their captured variant so they stay visually
    //             stable even after future re-downloads)
    //   - null/undefined: pick the lowest-indexed variant the trainer
    //             has actually seen (so the pokédex tile shows a sprite
    //             they've encountered, not one they haven't). If none
    //             seen, fall back to the abstract default-variant
    //             picker (custom v0 / autogen).
    const fetchInto = (card, a, b, variant) => {
      let v = variant;
      if (v === undefined) v = pickPreferredSeenVariant(a, b);
      let p;
      if (typeof v === 'number') p = global.Sprites.getSpriteUrl(a, b, v);
      else if (v === null) p = global.Sprites.getSpriteUrl(a, b, null);
      else p = global.Sprites.getDefaultSpriteUrl(a, b);
      p.then((url) => {
        if (!url) return;
        apply(card, url);
      }).catch(() => { /* swallow — placeholder stays */ });
    };
    if (typeof IntersectionObserver === 'undefined') {
      for (const it of items) fetchInto(it.card, it.a, it.b, it.variant);
      return;
    }
    const byEl = new Map(items.map((it) => [it.card, it]));
    const scrollRoot = rootEl.closest('.sheet') || null;
    const obs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        obs.unobserve(entry.target);
        const it = byEl.get(entry.target);
        if (it) fetchInto(it.card, it.a, it.b, it.variant);
      }
    }, { root: scrollRoot, rootMargin: '200px 0px' });
    for (const it of items) obs.observe(it.card);
    rootEl._spriteObserver = obs;
  }

  function famHasContent(famA, famB) {
    return Array.isArray(famA) && Array.isArray(famB)
      && (famA.length > 1 || famB.length > 1);
  }

  // Build the family-tree grid: rows are B's family, columns are A's
  // family. Each cell is a small fusion sprite. Sprites load async from
  // IDB (no network — same rule as the rest of the inventory). The
  // current (a, b) cell is outlined.
  function renderFamilyGrid(gridEl, famA, famB, currentA, currentB) {
    // Revoke any sprite URLs from a prior expansion of this grid.
    revokeObjectUrlsIn(gridEl);
    gridEl.style.gridTemplateColumns = `repeat(${famA.length}, 1fr)`;
    const cells = [];
    for (let row = 0; row < famB.length; row++) {
      for (let col = 0; col < famA.length; col++) {
        const a = famA[col];
        const b = famB[row];
        const isCurrent = a === currentA && b === currentB;
        const seen = isCurrent || isFusionSeen(a, b);
        const title = (global.Species && seen)
          ? `${global.Species.nameFor(a)} × ${global.Species.nameFor(b)}`
          : '???';
        const cls = `family-cell`
          + (isCurrent ? ' current' : '')
          + (seen ? '' : ' silhouette');
        cells.push(`<div class="${cls}" `
          + `data-a="${a}" data-b="${b}" title="${escapeHtml(title)}">`
          + `<span class="family-cell-placeholder" aria-hidden="true">·</span>`
          + `<img alt="">`
          + `</div>`);
      }
    }
    gridEl.innerHTML = cells.join('');
    if (!global.Sprites) return;
    gridEl.querySelectorAll('.family-cell').forEach((cell) => {
      const a = +cell.dataset.a;
      const b = +cell.dataset.b;
      // Match what the user has actually seen so the family-tree
      // mosaic shows their unlocked variants — falls back to the
      // abstract default picker (custom v0 / autogen) for fusions
      // they haven't seen yet (those render as silhouettes).
      const v = pickPreferredSeenVariant(a, b);
      const p = (typeof v === 'number')
        ? global.Sprites.getSpriteUrl(a, b, v)
        : (v === null
            ? global.Sprites.getSpriteUrl(a, b, null)
            : global.Sprites.getDefaultSpriteUrl(a, b));
      p.then((url) => {
        if (!url) return;
        const img = cell.querySelector('img');
        if (!img) { URL.revokeObjectURL(url); return; }
        img.onload = () => {
          URL.revokeObjectURL(url);
          cell.classList.add('ready');
        };
        img.src = url;
      });
    });
  }

  // Render an evolution method (Level 16, Item THUNDERSTONE, etc.) into
  // a short, human-readable label. Best-effort formatting — unrecognized
  // methods fall back to "<Method> <param>".
  function formatEvolutionMethod(method, param) {
    const item = (s) => {
      if (typeof s !== 'string') return String(s);
      // FIRESTONE / THUNDERSTONE → Fire Stone / Thunder Stone
      // KINGSROCK / METALCOAT → Kings Rock / Metal Coat
      const tail = ['STONE', 'ROCK', 'SCALE', 'COAT', 'CHIP', 'SCROLL'];
      let s2 = s;
      for (const t of tail) {
        const re = new RegExp(`(\\w+)${t}$`, 'i');
        s2 = s2.replace(re, (_, w) => `${w} ${t}`);
      }
      return s2.toLowerCase()
        .split(/[\s_]+/)
        .map((p) => p ? p[0].toUpperCase() + p.slice(1) : '')
        .join(' ').trim();
    };
    switch (method) {
      case 'Level':           return `Lv ${param}`;
      case 'LevelDay':        return `Lv ${param} (day)`;
      case 'LevelNight':      return `Lv ${param} (night)`;
      case 'Item':            return `Use ${item(param)}`;
      case 'TradeItem':       return `Trade w/ ${item(param)}`;
      case 'DayHoldItem':     return `Hold ${item(param)} (day)`;
      case 'HasMove':         return `Knows ${item(param)}`;
      case 'AttackGreater':   return `Lv ${param}, Atk > Def`;
      case 'DefenseGreater':  return `Lv ${param}, Def > Atk`;
      case 'AtkDefEqual':     return `Lv ${param}, Atk = Def`;
      case 'Ninjask':
      case 'Silcoon':         return `Lv ${param}`;
      case 'Shedinja':
      case 'Cascoon':         return `Lv ${param} (alt)`;
      default:                return param != null ? `${method} ${param}` : method;
    }
  }

  function formatSize(sizeM) {
    if (sizeM == null) return '';
    const imperial = localStorage.getItem('cc.units') === 'mi';
    if (imperial) {
      const inches = sizeM * 39.3701;
      if (inches < 12) return `${Math.round(inches)} in`;
      const feet = inches / 12;
      return feet < 10 ? `${feet.toFixed(1)} ft` : `${Math.round(feet)} ft`;
    }
    if (sizeM < 1) return `${Math.round(sizeM * 100)} cm`;
    return sizeM < 10 ? `${sizeM.toFixed(1)} m` : `${Math.round(sizeM)} m`;
  }

  function readEnabled() {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null || v === '1';
  }

  function writeEnabled(on) {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
  }

  // Custom species-name autocomplete — same pattern as /dex (datalist
  // is unreliable on iOS; this also lets us substring-highlight). Two-
  // pass match: prefix hits first, then "contains". Picks fire `input`
  // on the underlying <input> so the existing search→render listener
  // handles the actual filtering.
  // `getAllowed` (optional): function returning a Set of species ids
  // that the autocomplete should be limited to. Re-invoked on every
  // keystroke so newly-seen / captured species appear without remount.
  // null/omit → suggest from the full species list.
  const _SPECIES_AC_MAX = 30;
  function _seenSpeciesIds(slot) {
    const seen = readSeenFusions();
    const out = new Set();
    for (const key of Object.keys(seen)) {
      const dash = key.indexOf('-');
      if (dash < 0) continue;
      const a = +key.slice(0, dash);
      const b = +key.slice(dash + 1);
      if (slot === 'a') { out.add(a); }
      else if (slot === 'b') { out.add(b); }
      else { out.add(a); out.add(b); }
    }
    return out;
  }
  function _capturedSpeciesIds(slot) {
    const out = new Set();
    for (const c of readCapturedCreatures()) {
      if (typeof c.speciesA !== 'number' || typeof c.speciesB !== 'number') continue;
      if (slot === 'a') { out.add(c.speciesA); }
      else if (slot === 'b') { out.add(c.speciesB); }
      else { out.add(c.speciesA); out.add(c.speciesB); }
    }
    return out;
  }
  function attachSpeciesAutocomplete(input, list, getAllowed) {
    if (!input || !list) return;
    let activeIdx = -1;
    let current = [];   // array of { id, name }

    function buildSuggestions(q) {
      if (!q || !global.Species || !global.Species.allSpecies) return [];
      const ql = q.trim().toLowerCase();
      if (!ql) return [];
      const all = global.Species.allSpecies();
      const allowed = (typeof getAllowed === 'function') ? getAllowed() : null;
      const prefix = [];
      const contains = [];
      for (let i = 0; i < all.length; i++) {
        const s = all[i];
        if (allowed && !allowed.has(s.id)) continue;
        const lower = s.name.toLowerCase();
        if (lower.startsWith(ql)) prefix.push(s);
        else if (lower.includes(ql)) contains.push(s);
        if (prefix.length + contains.length >= _SPECIES_AC_MAX * 2) break;
      }
      return prefix.concat(contains).slice(0, _SPECIES_AC_MAX);
    }
    function highlight(name, q) {
      const ql = (q || '').trim();
      if (!ql) return escapeHtml(name);
      const lower = name.toLowerCase();
      const i = lower.indexOf(ql.toLowerCase());
      if (i < 0) return escapeHtml(name);
      return escapeHtml(name.slice(0, i))
        + `<mark>${escapeHtml(name.slice(i, i + ql.length))}</mark>`
        + escapeHtml(name.slice(i + ql.length));
    }
    function paint() {
      current = buildSuggestions(input.value);
      activeIdx = -1;
      if (!current.length) {
        list.classList.remove('show');
        list.innerHTML = '';
        return;
      }
      list.innerHTML = current.map((s) =>
        `<li class="ac-item" role="option" data-id="${s.id}" data-name="${escapeHtml(s.name)}">`
        + `<span class="nm">${highlight(s.name, input.value)}</span>`
        + `<span class="id">#${s.id}</span>`
        + `</li>`
      ).join('');
      list.classList.add('show');
    }
    function pick(name) {
      input.value = name;
      list.classList.remove('show');
      list.innerHTML = '';
      // Fire `input` so the existing renderPokedex listener re-runs.
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function setActive(idx) {
      const items = list.querySelectorAll('.ac-item');
      items.forEach((el, i) => el.classList.toggle('active', i === idx));
      const el = items[idx];
      if (el) el.scrollIntoView({ block: 'nearest' });
      activeIdx = idx;
    }
    input.addEventListener('input', paint);
    input.addEventListener('focus', paint);
    // Delay hide so a tap on a suggestion fires before blur.
    input.addEventListener('blur', () => setTimeout(() => list.classList.remove('show'), 120));
    input.addEventListener('keydown', (e) => {
      if (!list.classList.contains('show') || !current.length) {
        if (e.key === 'ArrowDown') paint();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(Math.min(current.length - 1, activeIdx + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(Math.max(0, activeIdx - 1));
      } else if (e.key === 'Enter') {
        if (activeIdx >= 0) {
          e.preventDefault();
          pick(current[activeIdx].name);
        }
      } else if (e.key === 'Escape') {
        list.classList.remove('show');
      }
    });
    // mousedown beats blur, so the pick fires before the list hides.
    list.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.ac-item');
      if (!item) return;
      e.preventDefault();
      pick(item.dataset.name);
    });
  }

  // Nicknames are keyed by creature id and stored as a JSON map so a
  // single entry can be cleared ("reset to species name") by deleting the
  // key without disturbing the others.
  function readNicknames() {
    try {
      const raw = localStorage.getItem('cc.creatureNicknames');
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }
  function writeNickname(id, nickname) {
    const map = readNicknames();
    const trimmed = (nickname || '').trim();
    if (trimmed) map[id] = trimmed; else delete map[id];
    localStorage.setItem('cc.creatureNicknames', JSON.stringify(map));
  }
  function displayName(c) {
    return readNicknames()[c.id] || c.name;
  }
  function findCreature(id) {
    return getInventoryCreatures().find((c) => c.id === id) || null;
  }

  const SORT_KEYS = new Set(['level', 'size', 'name', 'species', 'recent']);
  const POKEDEX_SORT_KEYS = new Set(['recent', 'a', 'b', 'aId', 'bId']);

  function readPokedexSortKey() {
    const v = localStorage.getItem('cc.pokedexSortBy');
    return POKEDEX_SORT_KEYS.has(v) ? v : 'recent';
  }
  function readPokedexSortDir() {
    const v = localStorage.getItem('cc.pokedexSortDir');
    return SORT_DIRS.has(v) ? v : 'desc';
  }
  function readPokedexFilterType() {
    return localStorage.getItem('cc.pokedexFilterType') || '';
  }
  function readPokedexFilterTypeA() {
    return localStorage.getItem('cc.pokedexFilterTypeA') || '';
  }
  function readPokedexFilterTypeB() {
    return localStorage.getItem('cc.pokedexFilterTypeB') || '';
  }
  function readInvFilterType() {
    return localStorage.getItem('cc.invFilterType') || '';
  }
  function readInvFilterTypeA() {
    return localStorage.getItem('cc.invFilterTypeA') || '';
  }
  function readInvFilterTypeB() {
    return localStorage.getItem('cc.invFilterTypeB') || '';
  }
  // Inventory tag filter: array of selected tag names. Multiple
  // selected tags use AND semantics (creature must have all of them).
  function readInvTagFilter() {
    try {
      const raw = localStorage.getItem('cc.invTagFilter');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function writeInvTagFilter(arr) {
    localStorage.setItem('cc.invTagFilter', JSON.stringify(arr));
  }
  // Pokedex tag filter: only built-in tags are offered (user tags
  // apply to specific captures, not abstract fusions). AND semantics
  // — fusion must satisfy every selected tag's predicate.
  function readPokedexTagFilter() {
    try {
      const raw = localStorage.getItem('cc.pokedexTagFilter');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function writePokedexTagFilter(arr) {
    localStorage.setItem('cc.pokedexTagFilter', JSON.stringify(arr));
  }
  // Shared list used to generate the type-filter <select> options for
  // both the Pokédex and the inventory. Pokédex's hardcoded options
  // pre-date this helper and stay as-is to avoid noisy diffs; new
  // surfaces (inventory) use this.
  const TYPE_FILTER_LIST = [
    'NORMAL', 'FIRE', 'WATER', 'GRASS', 'ELECTRIC', 'ICE',
    'FIGHTING', 'POISON', 'GROUND', 'FLYING', 'PSYCHIC', 'BUG',
    'ROCK', 'GHOST', 'DRAGON', 'DARK', 'STEEL', 'FAIRY',
  ];
  function typeFilterSelectHtml(id) {
    const opts = ['<option value="">Any</option>'].concat(
      TYPE_FILTER_LIST.map((t) => {
        const label = t.charAt(0) + t.slice(1).toLowerCase();
        return `<option value="${t}">${label}</option>`;
      })
    );
    return `<select id="${id}" class="type-filter-select">${opts.join('')}</select>`;
  }
  // Paint a type-filter <select> with the type's canonical color when
  // a real type is selected, or strip the inline styles back to the
  // theme's defaults when it's "any". Defined after TYPE_COLORS but
  // referenced by name later — function declaration so it hoists.
  function applyTypeSelectColor(selectEl) {
    if (!selectEl) return;
    const v = selectEl.value;
    const bg = TYPE_COLORS[v];
    if (bg) {
      selectEl.style.backgroundColor = bg;
      selectEl.style.borderColor = bg;
      selectEl.style.color = '#fff';
      selectEl.style.fontWeight = '600';
      selectEl.style.textShadow = '0 1px 1px rgba(0,0,0,0.4)';
    } else {
      selectEl.style.backgroundColor = '';
      selectEl.style.borderColor = '';
      selectEl.style.color = '';
      selectEl.style.fontWeight = '';
      selectEl.style.textShadow = '';
    }
  }
  const SORT_DIRS = new Set(['asc', 'desc']);

  function readSortKey() {
    const v = localStorage.getItem('cc.creatureSortBy');
    return SORT_KEYS.has(v) ? v : 'level';
  }
  function readSortDir() {
    const v = localStorage.getItem('cc.creatureSortDir');
    return SORT_DIRS.has(v) ? v : 'desc';
  }

  function sortedCreatures() {
    const key = readSortKey();
    const dir = readSortDir();
    const sign = dir === 'asc' ? 1 : -1;
    const copy = getInventoryCreatures();
    copy.sort((a, b) => {
      if (key === 'name') {
        return sign * displayName(a).localeCompare(displayName(b));
      }
      if (key === 'species') {
        return sign * a.name.localeCompare(b.name);
      }
      if (key === 'recent') {
        const at = (a.caughtAt && a.caughtAt.timestamp) || 0;
        const bt = (b.caughtAt && b.caughtAt.timestamp) || 0;
        return sign * (at - bt);
      }
      const field = key === 'size' ? 'sizeM' : 'level';
      const av = a[field], bv = b[field];
      // Missing values sort to the end regardless of direction.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return sign * (av - bv);
    });
    return copy;
  }

  function injectStyles() {
    if (document.getElementById('creature-styles')) return;
    const s = document.createElement('style');
    s.id = 'creature-styles';
    s.textContent = `
      #creatureInventory {
        position: fixed; inset: 0; z-index: 30;
        background: rgba(0,0,0,0.45);
        display: none; align-items: center; justify-content: center;
      }
      #creatureInventory.show { display: flex; }
      #creatureInventory .sheet {
        position: relative;
        display: flex;
        flex-direction: column;
        width: calc(100% - 40px); max-width: 360px;
        padding: 18px 20px 14px;
        /* Fixed height (not max-height) so every sub-view — pokédex
           grid, fusion detail, inventory list, etc. — occupies the
           same vertical footprint. Without this, switching from
           pokédex to fusion-detail collapsed the sheet to fit the
           shorter inner content. */
        height: 85vh; overflow-y: auto;
        /* Lock the horizontal axis — iOS will otherwise rubber-band
           this container sideways when a horizontal gesture starts
           inside it (especially near the edges), shifting the entire
           sheet a few px during our drag. */
        overflow-x: hidden;
        overscroll-behavior-x: none;
        background: var(--ui-bg, #fff);
        color: var(--ui-text, #111);
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 8px);
        box-shadow: 0 8px 24px rgba(0,0,0,0.25);
      }
      #creatureInventory .inventory-x {
        /* Sticky to the sheet's top-right corner. Negative margins
           collapse its layout footprint so it sits in the corner
           without pushing content down. Box-model is matched 1:1 to
           .candy-link / .pokedex-link so the three buttons read as a
           single right-side action cluster. The × glyph is small at
           12px but stays recognizable in context. */
        position: sticky;
        top: 0;
        align-self: flex-end;
        /* Top margin 0 (was -8px) so the X sits at the sheet's
           padding-top, the same Y as the .browse-header that follows
           — visually a three-button row with Candy/Dex. Bottom margin
           matches the X's height (25px) so it still contributes zero
           to the column's layout (next sibling starts at the same
           Y as if the X weren't there). */
        margin: 0 -8px -25px 0;
        z-index: 5;
        background: var(--ui-bg, #fff);
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 8px);
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
        color: var(--ui-text, #111);
        /* Explicit border-box dimensions so the *box* shrinks by 4px
           in each direction (20→16 tall, 30→26 wide) without changing
           the 16px × glyph. inline-flex centers the glyph as it
           lightly overflows the smaller content area; × has no
           ascender/descender so the slight overflow is invisible. */
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 25px;
        height: 25px;
        padding: 0;
        font-family: inherit;
      }
      #creatureInventory .inventory-x:hover {
        background: var(--ui-hover, rgba(0,0,0,0.04));
      }
      #creatureInventory h3 { margin: 0 0 14px; font-size: 16px; }
      #creatureInventory .sort-row {
        display: flex; align-items: center; gap: 8px;
        margin: 0 0 10px;
        font-size: 13px;
      }
      #creatureInventory .sort-row label {
        color: var(--ui-muted, #666);
      }
      #creatureInventory .sort-row select {
        padding: 4px 6px; font-size: 13px;
        background: var(--ui-bg, #fff);
        color: var(--ui-text, #111);
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 8px);
      }
      #creatureInventory .sort-row button.dir {
        padding: 4px 10px; font-size: 13px;
        background: var(--ui-bg, #fff);
        color: var(--ui-text, #111);
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 8px);
        cursor: pointer;
        min-width: 32px;
      }
      #creatureInventory .search-row {
        margin: 0 0 10px;
      }
      #creatureInventory .search-row input {
        width: 100%; box-sizing: border-box;
        padding: 6px 10px; font-size: 13px;
        background: var(--ui-bg, #fff);
        color: var(--ui-text, #111);
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 8px);
      }
      #creatureInventory .pokedex-search-row {
        display: flex; gap: 6px; align-items: stretch;
      }
      #creatureInventory .pokedex-search-row input {
        flex: 1; min-width: 0;
      }
      /* Custom autocomplete popup — same pattern as /dex (datalist
         behaves inconsistently on iOS, and we want substring
         highlighting). The .ac-field wrapper provides the relative
         anchor; the .ac-list is absolutely positioned underneath. */
      #creatureInventory .ac-field {
        position: relative;
        flex: 1; min-width: 0;
        display: flex;
      }
      #creatureInventory .ac-field input {
        width: 100%;
      }
      #creatureInventory .ac-list {
        position: absolute;
        top: 100%; left: 0; right: 0;
        max-height: 220px; overflow-y: auto;
        margin: 2px 0 0; padding: 0;
        background: var(--ui-bg, #fff);
        color: var(--ui-text, #111);
        border: 1px solid var(--ui-border, var(--ui-hairline, rgba(0,0,0,0.15)));
        border-radius: var(--ui-radius, 8px);
        box-shadow: var(--ui-shadow, 0 2px 8px rgba(0,0,0,0.2));
        list-style: none;
        z-index: 6;
        display: none;
      }
      #creatureInventory .ac-list.show { display: block; }
      #creatureInventory .ac-item {
        padding: 6px 10px; font-size: 13px; cursor: pointer;
        display: flex; justify-content: space-between; gap: 12px;
        color: var(--ui-text, #111);
      }
      #creatureInventory .ac-item .id {
        color: var(--ui-muted, #888);
        font-family: ui-monospace, "SF Mono", Menlo, monospace;
        font-size: 12px;
      }
      #creatureInventory .ac-item:hover,
      #creatureInventory .ac-item.active {
        background: var(--ui-hover, rgba(0,0,0,0.06));
      }
      /* <mark> tints the matched substring with a translucent accent
         so it reads on every theme (medieval / terminal / blueprint /
         win95) rather than the fixed yellow /dex uses. */
      #creatureInventory .ac-item mark {
        background: color-mix(in srgb, var(--ui-accent, #3b7fdf) 28%, transparent);
        color: inherit;
        padding: 0;
        border-radius: 2px;
      }
      #creatureInventory .pokedex-swap-btn {
        flex: 0 0 auto;
        padding: 0 8px;
        font-size: 16px; line-height: 1;
        background: var(--ui-bg, #fff);
        color: var(--ui-text, #111);
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 8px);
        cursor: pointer; font-family: inherit;
      }
      #creatureInventory .pokedex-swap-btn:hover {
        background: var(--ui-hover, rgba(0,0,0,0.04));
      }
      /* "Type: Either: [▾]  First: [▾]  Second: [▾]" row. Wraps onto
         multiple lines on narrow viewports — sheet width is 360px
         max so all three pairs in one row tends to overflow. */
      #creatureInventory .type-filter-row {
        display: flex; flex-wrap: wrap;
        align-items: center;
        gap: 4px 4px;
        margin: 0 0 10px;
        font-size: 12px;
      }
      #creatureInventory .type-filter-row .type-pair {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        color: var(--ui-muted, #666);
        cursor: pointer;
      }
      #creatureInventory .type-filter-select {
        padding: 3px 1px;
        font-size: 12px;
        background: var(--ui-bg, #fff);
        color: var(--ui-text, #111);
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 8px);
        font-family: inherit;
        cursor: pointer;
      }
      /* Visual cue that a filter has been changed from its default
         "any" / blank state — accent-colored outline. Applies in any
         view (browse + pokedex both have type-filter selects now). */
      #creatureInventory input.filter-active,
      #creatureInventory select.filter-active {
        border-color: var(--ui-accent, #888);
        box-shadow: 0 0 0 1px var(--ui-accent, #888);
      }
      #creatureInventory .creature-list {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
      }
      #creatureInventory .creature-card {
        display: flex; flex-direction: column; align-items: center; gap: 6px;
        padding: 10px 6px;
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border-radius: var(--ui-radius, 8px);
        cursor: pointer;
        border: 1px solid transparent;
        transition: transform 0.08s ease, border-color 0.08s ease;
        /* Hardcoded to match virtualizeGrid({ cardHeight: 178 }) — keeps
           the row pitch correct without dynamic measurement. Excess
           content is clipped (rare; happens only on unusually wide
           screens or large fonts). */
        height: 178px;
        box-sizing: border-box;
        overflow: hidden;
      }
      #creatureInventory .creature-card:hover {
        border-color: var(--ui-accent, #888);
        transform: translateY(-1px);
      }
      #creatureInventory .creature-card .art {
        width: 100%; aspect-ratio: 1 / 1;
        display: flex; align-items: center; justify-content: center;
        background: var(--ui-bg, #fff);
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.08));
        border-radius: var(--ui-radius, 8px);
        font-size: 40px; line-height: 1;
        overflow: hidden;
      }
      #creatureInventory .creature-card .art img.art-img {
        width: 100%; height: 100%; object-fit: contain; display: none;
        image-rendering: pixelated; image-rendering: crisp-edges;
      }
      #creatureInventory .creature-card .art .art-placeholder {
        font-size: 40px; line-height: 1;
      }
      #creatureInventory .creature-card .name {
        font-size: 13px; text-align: center; line-height: 1.2;
        word-break: break-word;
        /* Always reserve 2 lines so card heights are uniform — the
           virtualizer measures one card and assumes that height for
           every row. Without this, long fusion names wrap to 2 lines
           and overlap the next row. */
        height: 2.4em;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      #creatureInventory .creature-card .stats {
        display: flex; justify-content: center; gap: 6px;
        font-size: 11px; color: var(--ui-muted, #666);
      }
      #creatureInventory .creature-card .stats .sep {
        opacity: 0.5;
      }
      #creatureInventory .creature-empty {
        text-align: center; font-size: 13px;
        color: var(--ui-muted, #666);
        padding: 24px 12px;
      }
      #creatureInventory .actions {
        display: flex; justify-content: flex-end; margin-top: 14px;
      }
      #creatureInventory button.close {
        padding: 8px 14px; font-size: 14px; cursor: pointer;
      }
      #creatureInventory .detail-view { display: none; }
      /* .show -> display:flex via the column-layout rule below. */
      #creatureInventory .detail-back,
      #creatureInventory .pokedex-back,
      #creatureInventory .fusion-back,
      #creatureInventory .candy-back,
      #creatureInventory .bag-back,
      #creatureInventory .tags-back {
        background: none;
        border: none;
        color: var(--ui-text, #111);
        font-size: 22px;
        line-height: 1;
        cursor: pointer;
        padding: 4px 8px;
        margin: 0 0 6px -4px;
        font-family: inherit;
      }
      #creatureInventory .detail-back:hover,
      #creatureInventory .pokedex-back:hover,
      #creatureInventory .fusion-back:hover,
      #creatureInventory .candy-back:hover,
      #creatureInventory .bag-back:hover,
      #creatureInventory .tags-back:hover {
        color: var(--ui-accent, #888);
      }
      /* Sub-view sibling navigation arrows. Floated to the corners
         of the .detail-view / .fusion-view scroll container so they
         stay reachable while content scrolls. Hidden when the view
         doesn't have a list (no parent grid context). */
      #creatureInventory .detail-view,
      #creatureInventory .fusion-view {
        position: relative;
        overflow: hidden;
        /* flex column so the track between header (.detail-back) and
           footer (.actions) takes the remaining height. The parent
           .sheet is now a fixed-height 85vh flex column, so flex:1
           fills it identically across pokédex / fusion / detail. */
        flex-direction: column;
        flex: 1 1 auto;
        /* Claim horizontal pan so iOS doesn't rubber-band the
           parent .sheet during the first few pixels of a swipe
           (before our touchmove handler decides to claim it). */
        touch-action: pan-y;
      }
      #creatureInventory .detail-view.show,
      #creatureInventory .fusion-view.show {
        display: flex;
      }
      #creatureInventory .nav-arrow {
        position: absolute;
        /* Align vertically with the center of .detail-art (140px tall
           with 4px top margin), sitting under the back button row
           (~30px button + 6px margin = 36px). 36 + 4 + 70 = 110px. */
        top: 110px;
        transform: translateY(-50%);
        z-index: 4;
        background: var(--ui-bg, rgba(255,255,255,0.85));
        color: var(--ui-text, #111);
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: 50%;
        width: 36px; height: 36px; padding: 0;
        font-size: 22px; line-height: 1;
        cursor: pointer; font-family: inherit;
        display: none;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 6px rgba(0,0,0,0.12);
      }
      #creatureInventory .nav-arrow.show { display: inline-flex; }
      #creatureInventory .nav-arrow:hover { background: var(--ui-hover, rgba(0,0,0,0.04)); }
      #creatureInventory .nav-arrow:disabled { opacity: 0.3; cursor: not-allowed; }
      #creatureInventory .nav-prev { left: 6px; }
      #creatureInventory .nav-next { right: 6px; }
      /* Sibling-navigation carousel. Each sub-view holds a track div
         containing 1–3 absolutely-positioned slots (prev/center/next).
         The track itself is transformed during drag (so all slots
         move together with the finger). On commit, the track animates
         to ±viewWidth, then the slots get rotated and the track snaps
         back to 0. Slots are cached across navigations so going back
         to a recently-viewed sibling is instant. */
      #creatureInventory .detail-track,
      #creatureInventory .fusion-track {
        position: relative;
        flex: 1 1 auto;
        min-height: 0;
        overflow: visible;
        /* Promote the track to a single composited layer that
           contains all its slots — keeps neighbors painted
           continuously while we animate translateX, so they don't
           drop out mid-snap-back. The runtime transform applied via
           JS uses translate3d (see _setTrackTransform) which
           preserves the layer. */
        will-change: transform;
        touch-action: pan-y;
      }
      #creatureInventory .body-slot {
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        overflow-y: auto;
        overflow-x: hidden;
        overscroll-behavior: contain;
      }
      #creatureInventory .body-slot.prev { transform: translateX(-100%); }
      #creatureInventory .body-slot.center { transform: translateX(0); }
      #creatureInventory .body-slot.next { transform: translateX(100%); }
      /* Art variants grid in the fusion sub-view. Small thumbnails of
         every non-blank art variant for a fusion (autogen + each
         custom variant). Variants the trainer hasn't seen render as
         silhouettes — same brightness(0) trick as the dex page. */
      #creatureInventory .variant-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
        gap: 8px;
        margin-top: 8px;
      }
      #creatureInventory .variant-cell {
        display: flex; flex-direction: column; align-items: center; gap: 2px;
        padding: 6px 4px;
        background: var(--ui-bg, #fff);
        border: 1px solid var(--ui-border, rgba(0,0,0,0.1));
        border-radius: 6px;
      }
      #creatureInventory .variant-cell.autogen { border-color: var(--ui-accent, #b6896c); }
      #creatureInventory .variant-cell img {
        width: 72px; height: 72px;
        /* Sprite blobs are cropped to their opaque bbox, so each one
           has a different aspect. object-fit: contain scales
           proportionally inside the 72×72 square — no squashing. */
        object-fit: contain;
        image-rendering: pixelated;
        image-rendering: crisp-edges;
        background: transparent;
      }
      #creatureInventory .variant-cell.silhouette img { filter: brightness(0) opacity(0.85); }
      #creatureInventory .variant-cell .label {
        font-size: 10px; color: var(--ui-muted, #888);
        text-align: center; max-width: 80px;
        word-wrap: break-word; line-height: 1.2;
      }
      #creatureInventory .variant-cell.silhouette .label { color: var(--ui-muted, #888); }
      #creatureInventory .variant-empty {
        font-size: 12px; color: var(--ui-muted, #888); padding: 6px 0;
      }
      #creatureInventory .nav-anim { transition: transform 320ms cubic-bezier(0.25, 0.46, 0.45, 0.94); }
      #creatureInventory .detail-art {
        width: 140px; height: 140px; margin: 4px auto 12px;
        display: flex; align-items: center; justify-content: center;
        background: var(--ui-bg, #fff);
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.08));
        border-radius: var(--ui-radius, 8px);
        font-size: 72px; line-height: 1;
        overflow: hidden;
      }
      #creatureInventory .detail-art img {
        width: 100%; height: 100%; object-fit: contain; display: block;
      }
      #creatureInventory .detail-name-row {
        display: flex; align-items: center; justify-content: center;
        gap: 8px; margin: 0 0 4px;
      }
      /* When a canonical fused name is present we stack the rows
         vertically: fused name on top, "A × B" species pair below. */
      #creatureInventory .detail-name-row:has(.detail-fused-name) {
        flex-direction: column; gap: 2px;
      }
      #creatureInventory .detail-name {
        font-size: 18px; font-weight: 600;
        word-break: break-word; text-align: center;
      }
      #creatureInventory .detail-fused-name {
        font-size: 20px; font-weight: 700;
        word-break: break-word; text-align: center;
        color: var(--ui-text, #111);
      }
      /* When the fused name is the primary, the species pair becomes
         a secondary subtitle. */
      #creatureInventory .detail-name.detail-name-sub {
        font-size: 13px; font-weight: 500;
        color: var(--ui-muted, #666);
      }
      #creatureInventory .icon-btn {
        padding: 4px 8px; font-size: 13px; cursor: pointer;
        background: transparent;
        color: var(--ui-text, #111);
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 8px);
      }
      #creatureInventory .detail-species {
        text-align: center; font-size: 12px;
        color: var(--ui-muted, #666); margin: 0 0 10px;
      }
      #creatureInventory .detail-stats {
        display: flex; justify-content: center; gap: 8px;
        font-size: 13px; margin: 0 0 14px;
      }
      #creatureInventory .detail-stats .sep { opacity: 0.5; }
      #creatureInventory .detail-caught {
        text-align: center; font-size: 12px;
        color: var(--ui-muted, #666); margin: 0 0 8px;
      }
      #creatureInventory .detail-caught-clickable,
      #creatureInventory .fusion-encounter-clickable {
        cursor: pointer;
      }
      #creatureInventory .detail-caught-clickable:hover {
        color: var(--ui-text, #111);
        text-decoration: underline;
        text-underline-offset: 3px;
      }
      #creatureInventory .fusion-encounter-clickable:hover {
        outline: 1px solid var(--ui-accent, #888);
      }
      #creatureInventory .detail-pokedex-link {
        display: block;
        margin: -2px auto 8px;
        background: transparent;
        border: none;
        color: var(--ui-accent, #888);
        cursor: pointer;
        font-family: inherit;
        font-size: 12px;
        text-decoration: underline;
        text-underline-offset: 3px;
        padding: 2px 6px;
      }
      #creatureInventory .detail-pokedex-link:hover {
        opacity: 0.8;
      }
      #creatureInventory .detail-evos {
        margin: 4px 0 8px;
      }
      #creatureInventory .detail-evos-label {
        font-size: 11px; color: var(--ui-muted, #666);
        margin: 0 0 4px;
      }
      #creatureInventory .evo-row {
        display: flex; align-items: center; gap: 8px;
        padding: 4px 6px;
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border-radius: var(--ui-radius, 8px);
        margin-bottom: 4px;
      }
      #creatureInventory .evo-row .evo-arrow {
        color: var(--ui-muted, #666); font-size: 14px; flex-shrink: 0;
      }
      #creatureInventory .evo-row .evo-art {
        width: 36px; height: 36px; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        background: var(--ui-bg, #fff);
        border-radius: var(--ui-radius, 8px);
      }
      #creatureInventory .evo-row .evo-art img {
        width: 100%; height: 100%; object-fit: contain;
        image-rendering: pixelated; image-rendering: crisp-edges;
        display: none;
      }
      #creatureInventory .evo-row.evo-art-ready .evo-art img { display: block; }
      #creatureInventory .evo-row.evo-art-ready .evo-art-placeholder { display: none; }
      #creatureInventory .evo-row .evo-art-placeholder {
        font-size: 16px; color: var(--ui-muted, #666);
      }
      #creatureInventory .evo-row .evo-name {
        flex: 1; min-width: 0; font-size: 13px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      #creatureInventory .evo-row .evo-req {
        font-size: 11px; color: var(--ui-muted, #666); flex-shrink: 0;
      }
      #creatureInventory .detail-family {
        margin: 6px 0 8px;
      }
      #creatureInventory .family-toggle {
        background: transparent;
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 8px);
        color: var(--ui-text, #111);
        padding: 6px 10px;
        font-size: 12px;
        cursor: pointer;
        font-family: inherit;
        width: 100%;
        text-align: center;
      }
      #creatureInventory .family-toggle:hover {
        background: var(--ui-hover, rgba(0,0,0,0.04));
      }
      #creatureInventory .family-grid {
        display: grid;
        gap: 4px;
        margin-top: 6px;
      }
      #creatureInventory .family-grid[hidden] { display: none; }
      #creatureInventory .family-cell {
        aspect-ratio: 1;
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border: 1px solid transparent;
        border-radius: var(--ui-radius, 8px);
        display: flex; align-items: center; justify-content: center;
        position: relative;
        overflow: hidden;
      }
      #creatureInventory .family-cell.current {
        border-color: var(--ui-accent, #888);
        box-shadow: 0 0 0 1px var(--ui-accent, #888);
      }
      #creatureInventory .family-cell .family-cell-placeholder {
        font-size: 12px; color: var(--ui-muted, #666);
      }
      #creatureInventory .family-cell img {
        width: 90%; height: 90%; object-fit: contain;
        image-rendering: pixelated; image-rendering: crisp-edges;
        display: none;
      }
      #creatureInventory .family-cell.ready img { display: block; }
      #creatureInventory .family-cell.ready .family-cell-placeholder { display: none; }
      /* Silhouette: pokémon you haven't seen yet show as black-fill,
         keeping their shape so you know "something" is there. Applied
         to family-tree cells and "Evolves to" rows. */
      #creatureInventory .silhouette img,
      #creatureInventory .evo-row.silhouette .evo-art img,
      #creatureInventory .family-cell.silhouette img {
        filter: brightness(0);
      }
      #creatureInventory .pokedex-view { display: none; }
      #creatureInventory .pokedex-view.show { display: block; }
      #creatureInventory .candy-view { display: none; }
      #creatureInventory .candy-view.show { display: block; }
      #creatureInventory .candy-title {
        font-size: 16px; font-weight: 600;
        text-align: center; margin: 0 0 4px;
      }
      #creatureInventory .candy-subtitle {
        font-size: 12px; color: var(--ui-muted, #666);
        text-align: center; margin: 0 0 14px;
      }
      #creatureInventory .candy-list {
        display: flex; flex-direction: column; gap: 6px;
      }
      #creatureInventory .candy-row {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 10px;
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.08));
        border-radius: var(--ui-radius, 8px);
      }
      #creatureInventory .candy-row .candy-name {
        font-size: 14px; font-weight: 600;
        color: var(--ui-text, #111);
      }
      #creatureInventory .candy-row .candy-count {
        margin-left: auto;
        font-size: 14px; font-weight: 600;
        color: var(--ui-text, #111);
        font-variant-numeric: tabular-nums;
      }
      #creatureInventory .candy-empty {
        padding: 20px 8px;
        text-align: center;
        color: var(--ui-muted, #666);
        font-size: 13px;
      }
      #creatureInventory .bag-view { display: none; }
      #creatureInventory .bag-view.show { display: block; }
      #creatureInventory .bag-title {
        font-size: 16px; font-weight: 600;
        text-align: center; margin: 0 0 4px;
      }
      #creatureInventory .bag-subtitle {
        font-size: 12px; color: var(--ui-muted, #666);
        text-align: center; margin: 0 0 14px;
      }
      #creatureInventory .bag-list {
        display: flex; flex-direction: column; gap: 6px;
      }
      #creatureInventory .bag-row {
        display: flex; align-items: flex-start; gap: 10px;
        padding: 10px;
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.08));
        border-radius: var(--ui-radius, 8px);
      }
      #creatureInventory .bag-row .bag-icon {
        width: 32px; height: 32px;
        flex: 0 0 auto;
        align-self: center;
      }
      #creatureInventory .bag-row .bag-info {
        flex: 1; display: flex; flex-direction: column; gap: 2px;
      }
      #creatureInventory .bag-row .bag-name {
        font-size: 14px; font-weight: 600;
        color: var(--ui-text, #111);
      }
      #creatureInventory .bag-row .bag-desc {
        font-size: 12px; color: var(--ui-muted, #666);
      }
      #creatureInventory .bag-row .bag-count {
        font-size: 14px; font-weight: 600;
        color: var(--ui-text, #111);
        font-variant-numeric: tabular-nums;
        align-self: center;
      }
      #creatureInventory .bag-empty {
        padding: 20px 8px;
        text-align: center;
        color: var(--ui-muted, #666);
        font-size: 13px;
      }
      #creatureInventory .tags-view { display: none; }
      #creatureInventory .tags-view.show { display: block; }
      #creatureInventory .tags-title {
        font-size: 16px; font-weight: 600;
        text-align: center; margin: 0 0 4px;
      }
      #creatureInventory .tags-subtitle {
        font-size: 12px; color: var(--ui-muted, #666);
        text-align: center; margin: 0 0 14px;
      }
      #creatureInventory .tags-create {
        display: block;
        width: 100%;
        padding: 8px 10px;
        margin: 0 0 12px;
        font-size: 13px;
        font-family: inherit;
        cursor: pointer;
        background: var(--ui-bg, #fff);
        color: var(--ui-text, #111);
        border: 1px dashed var(--ui-border, rgba(0,0,0,0.25));
        border-radius: var(--ui-radius, 8px);
      }
      #creatureInventory .tags-create:hover {
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border-style: solid;
      }
      #creatureInventory .tags-list {
        display: flex; flex-direction: column; gap: 6px;
      }
      #creatureInventory .tags-row {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 10px;
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.08));
        border-radius: var(--ui-radius, 8px);
      }
      #creatureInventory .tags-row .tags-name {
        flex: 1;
        font-size: 14px; font-weight: 600;
        color: var(--ui-text, #111);
      }
      #creatureInventory .tags-row-builtin .tags-name {
        flex: 0 0 auto;
        font-style: italic;
      }
      #creatureInventory .tags-row .tags-builtin-note {
        flex: 1;
        font-size: 12px;
        color: var(--ui-muted, #666);
        text-align: right;
      }
      #creatureInventory .tags-row .tags-remove {
        background: transparent;
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        color: var(--ui-muted, #666);
        padding: 2px 8px;
        font-size: 12px;
        font-family: inherit;
        border-radius: var(--ui-radius, 8px);
        cursor: pointer;
      }
      #creatureInventory .tags-row .tags-remove:hover {
        color: var(--ui-text, #111);
        background: var(--ui-bg, #fff);
      }
      #creatureInventory .tags-empty {
        padding: 20px 8px;
        text-align: center;
        color: var(--ui-muted, #666);
        font-size: 13px;
      }
      /* Tag chip picker: used both in the detail view (apply tags
         to one capture) and in the inventory's filter row (narrow
         the listing to creatures with any selected tag). "Applied"
         chips are filled with the accent; others are subdued
         outlines. */
      #creatureInventory .detail-tags {
        display: flex; flex-wrap: wrap; gap: 6px;
        justify-content: center;
        margin: 6px 0 12px;
      }
      #creatureInventory .inv-tag-filter-row,
      #creatureInventory .pokedex-tag-filter-row {
        display: flex; flex-wrap: wrap; gap: 6px;
        justify-content: flex-start;
        margin: 6px 0 12px;
      }
      #creatureInventory .inv-tag-filter-row:empty,
      #creatureInventory .pokedex-tag-filter-row:empty { display: none; }
      #creatureInventory .detail-tag-chip,
      #creatureInventory .inv-tag-chip {
        display: inline-block;
        padding: 3px 9px;
        font-size: 12px;
        font-family: inherit;
        line-height: 1.3;
        border-radius: 999px;
        cursor: pointer;
        background: transparent;
        color: var(--ui-muted, #666);
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
      }
      #creatureInventory .detail-tag-chip.applied,
      #creatureInventory .inv-tag-chip.applied {
        background: var(--ui-accent, #888);
        color: #fff;
        border-color: var(--ui-accent, #888);
        font-weight: 600;
      }
      /* Built-in chips in the detail view are predicate-driven and
         not user-toggleable. Italic + dashed outline + default cursor
         signal that they're informational. The .applied accent still
         applies on top so the user sees whether the predicate fires. */
      #creatureInventory .detail-tag-chip.builtin {
        font-style: italic;
        border-style: dashed;
        cursor: default;
      }
      #creatureInventory .detail-tag-chip.builtin.applied {
        border-style: solid;
      }
      #creatureInventory .detail-tags-empty {
        font-size: 12px; color: var(--ui-muted, #666);
        text-align: center; margin: 6px 0 12px;
      }
      #creatureInventory .pokedex-header {
        display: flex; align-items: center; gap: 8px;
        margin-bottom: 10px;
      }
      #creatureInventory .pokedex-stats {
        flex: 1; text-align: center;
        font-size: 12px; color: var(--ui-muted, #666);
        /* Align the text's vertical center with the sticky X button.
           The header row is taller than the X (back button is ~30px,
           X is 25px), so by default flex-center would put this text
           ~3px below the X. Pinning to the row top + matching the X's
           25px height + line-height puts the text center at the same
           Y as the X center. */
        align-self: flex-start;
        height: 25px;
        line-height: 25px;
      }
      #creatureInventory .pokedex-stats b {
        color: var(--ui-text, #111);
      }
      #creatureInventory .pokedex-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
      }
      #creatureInventory .pokedex-card {
        position: relative;
        display: flex; flex-direction: column; align-items: center; gap: 4px;
        padding: 8px 4px;
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border-radius: var(--ui-radius, 8px);
        /* Matches virtualizeGrid({ cardHeight: 150 }) — fixed height
           keeps the row pitch correct without dynamic measurement. */
        height: 150px;
        box-sizing: border-box;
        overflow: hidden;
      }
      #creatureInventory .pokedex-card .pokedex-art {
        width: 100%; aspect-ratio: 1;
        display: flex; align-items: center; justify-content: center;
        background: var(--ui-bg, #fff);
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.08));
        border-radius: var(--ui-radius, 8px);
        overflow: hidden;
      }
      #creatureInventory .pokedex-card .pokedex-art img {
        width: 90%; height: 90%; object-fit: contain;
        image-rendering: pixelated; image-rendering: crisp-edges;
        display: none;
      }
      #creatureInventory .pokedex-card.ready .pokedex-art img { display: block; }
      #creatureInventory .pokedex-card .pokedex-name {
        font-size: 11px; text-align: center; line-height: 1.2;
        word-break: break-word;
        font-weight: 600;
        /* Reserve 1 line for the canonical fused name; the bases
           line lives in .pokedex-bases below. Together they keep the
           card uniform height for the virtualizer. */
        height: 1.2em;
        display: -webkit-box;
        -webkit-line-clamp: 1;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      #creatureInventory .pokedex-card .pokedex-bases {
        font-size: 10px; text-align: center; line-height: 1.1;
        color: var(--ui-muted, #888);
        word-break: break-word;
        height: 1.1em;
        display: -webkit-box;
        -webkit-line-clamp: 1;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      #creatureInventory .pokedex-card .caught-badge {
        position: absolute; top: 4px; right: 4px;
        background: var(--ui-accent, #2a8);
        color: #fff;
        border-radius: 999px;
        width: 16px; height: 16px;
        font-size: 10px; line-height: 16px;
        text-align: center;
        font-weight: bold;
        z-index: 2;
      }
      #creatureInventory .pokedex-card { cursor: pointer; }
      #creatureInventory .fusion-view { display: none; }
      /* .show -> display:flex via the column-layout rule earlier. */
      #creatureInventory .fusion-section-label {
        font-size: 11px; color: var(--ui-muted, #666);
        text-transform: uppercase; letter-spacing: 0.04em;
        margin: 12px 0 6px;
      }
      #creatureInventory .fusion-caught-row {
        display: flex; align-items: center; gap: 10px;
        padding: 6px 8px;
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border-radius: var(--ui-radius, 8px);
        margin-bottom: 4px;
        cursor: pointer;
      }
      #creatureInventory .fusion-caught-row:hover {
        background: var(--ui-border, rgba(0,0,0,0.08));
      }
      #creatureInventory .fusion-caught-row .row-name {
        flex: 1; min-width: 0; font-size: 13px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      #creatureInventory .fusion-caught-row .row-meta {
        font-size: 11px; color: var(--ui-muted, #666);
        flex-shrink: 0;
      }
      #creatureInventory .fusion-encounter {
        font-size: 13px;
        line-height: 1.5;
        background: var(--ui-hover, rgba(0,0,0,0.04));
        padding: 10px 12px;
        border-radius: var(--ui-radius, 8px);
      }
      #creatureInventory .fusion-encounter .row-meta {
        font-size: 12px; color: var(--ui-muted, #666);
      }
      #creatureInventory .species-link {
        cursor: pointer;
        text-decoration: underline;
        text-decoration-style: dotted;
        text-decoration-thickness: 1px;
        text-underline-offset: 3px;
      }
      #creatureInventory .species-link:hover {
        color: var(--ui-accent, #888);
      }
      #creatureInventory .browse-header {
        display: flex; align-items: center; gap: 8px;
        margin: 0 0 14px;
        /* Leave room for the sticky X button which sits at the
           sheet's top-right corner. The +8px on top of the X's own
           ~20px footprint gives the same gap between Dex and X as
           between Candy and Dex (8px), keeping the right-side action
           cluster evenly spaced. */
        padding-right: 36px;
      }
      #creatureInventory .browse-header h3 { margin: 0; flex: 1; }
      #creatureInventory .pokedex-link,
      #creatureInventory .candy-link,
      #creatureInventory .bag-link,
      #creatureInventory .tags-link {
        background: transparent;
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 8px);
        color: var(--ui-text, #111);
        padding: 4px 10px;
        font-size: 12px;
        cursor: pointer;
        font-family: inherit;
      }
      #creatureInventory .pokedex-link:hover,
      #creatureInventory .candy-link:hover,
      #creatureInventory .bag-link:hover,
      #creatureInventory .tags-link:hover {
        background: var(--ui-hover, rgba(0,0,0,0.04));
      }
      #creatureInventory .weather-bar {
        margin: 0 0 12px;
      }
      #creatureInventory .weather-row {
        display: flex; align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--ui-muted, #666);
        flex-wrap: wrap;
      }
      #creatureInventory .weather-row .label {
        color: var(--ui-muted, #666);
      }
      #creatureInventory .weather-warning {
        font-size: 12px;
        color: var(--ui-text, #111);
        background: rgba(255, 165, 0, 0.15);
        border: 1px solid rgba(255, 165, 0, 0.4);
        border-radius: var(--ui-radius, 8px);
        padding: 8px 10px;
        line-height: 1.4;
      }
      #creatureInventory .weather-warning b { color: #c66200; }
      #creatureInventory .save-reminder {
        display: none;
        margin: 0 0 12px;
        font-size: 12px;
        color: var(--ui-text, #111);
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 8px);
        padding: 8px 10px;
        line-height: 1.4;
        cursor: pointer;
        text-align: center;
        font-family: inherit;
        width: 100%;
        box-sizing: border-box;
      }
      #creatureInventory .save-reminder.show { display: block; }
      #creatureInventory .save-reminder:hover {
        background: var(--ui-bg, #fff);
        border-color: var(--ui-text, #111);
      }
      #creatureInventory .save-reminder b { color: var(--ui-accent, #888); }
      #creatureInventory .detail-art img.detail-art-img {
        width: 100%; height: 100%; object-fit: contain;
        image-rendering: pixelated; image-rendering: crisp-edges;
      }
      #creatureInventory .rename-form {
        display: flex; gap: 6px; justify-content: center;
        flex-wrap: wrap; margin: 0 0 8px;
      }
      #creatureInventory .rename-form input {
        flex: 1; min-width: 0; max-width: 220px;
        padding: 6px 10px; font-size: 14px;
        background: var(--ui-bg, #fff);
        color: var(--ui-text, #111);
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 8px);
      }
      .creature-marker {
        width: var(--creature-marker-size, ${MARKER_SIZE_PX}px);
        height: var(--creature-marker-size, ${MARKER_SIZE_PX}px);
        /* The root must let pointer events pass through — at high zoom
           the element is up to 336×336 and would otherwise swallow
           pinch/wheel gestures that start on its transparent area. Only
           the actual sprite/placeholder children take clicks. */
        pointer-events: none;
        /* Do NOT set position here. MapLibre's .maplibregl-marker rule
           applies position:absolute; overriding it (e.g. with relative)
           leaves the element in the normal document flow, so subsequent
           markers stack vertically inside the canvas container and each
           one accumulates an extra Y offset that rides on top of the
           translate that should put it at its lat/lng. The size is
           driven by a CSS variable the JS updates on every map zoom
           event so creatures stay the same *geographic* size. */
      }
      .creature-marker .creature-placeholder {
        position: absolute;
        top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        width: 14px; height: 14px; border-radius: 50%;
        background: #ff3366; border: 2px solid #fff;
        box-shadow: 0 1px 3px rgba(0,0,0,0.45);
        pointer-events: auto;
        cursor: pointer;
        /* Don't let the browser claim native gestures (tap-zoom etc.)
           on the marker — JS owns these so MapLibre's pinch handler
           keeps receiving touchmove. Without this the browser would
           briefly co-handle the touch and the map's gesture would
           stutter when a finger crosses a creature. */
        touch-action: none;
      }
      .creature-marker img.creature-sprite {
        position: absolute;
        inset: 0;
        margin: auto;
        max-width: 100%;
        max-height: 100%;
        image-rendering: pixelated;
        image-rendering: crisp-edges;
        filter: drop-shadow(0 2px 3px rgba(0,0,0,0.45));
        display: none;
        /* Clickable so tapping the sprite opens the battle screen, but
           the transparent margin around it (everything up to the root's
           size) does not intercept. */
        pointer-events: auto;
        cursor: pointer;
        touch-action: none;
      }
      .creature-marker.creature-marker-ready img.creature-sprite {
        display: block;
      }
      .creature-marker.creature-marker-ready .creature-placeholder {
        display: none;
      }
      #battleScreen {
        position: fixed; inset: 0;
        z-index: 40;
        background: rgba(0,0,0,0.85);
        color: #fff;
        /* Fade in/out instead of jump-cut. opacity + pointer-events
           so the screen stays in the DOM but is non-interactive when
           invisible. Same pattern as #poiCard. */
        opacity: 0;
        pointer-events: none;
        transition: opacity 150ms ease;
      }
      #battleScreen.show { opacity: 1; pointer-events: auto; }
      #battleScreen .battle-sprite-wrap {
        position: absolute;
        top: 12%;
        left: 50%;
        transform: translateX(-50%);
        width: min(200px, 54vw);
        height: min(200px, 29vh);
        display: flex; align-items: center; justify-content: center;
      }
      #battleScreen .battle-sprite-placeholder {
        width: 28px; height: 28px; border-radius: 50%;
        background: #ff3366; border: 3px solid #fff;
        box-shadow: 0 2px 6px rgba(0,0,0,0.6);
      }
      #battleScreen img.battle-sprite {
        display: none;
        width: 100%; height: 100%;
        object-fit: contain;
        image-rendering: pixelated;
        image-rendering: crisp-edges;
        filter: drop-shadow(0 6px 10px rgba(0,0,0,0.6));
      }
      #battleScreen.battle-sprite-ready img.battle-sprite { display: block; }
      #battleScreen.battle-sprite-ready .battle-sprite-placeholder { display: none; }
      #battleScreen .battle-info {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translateX(-50%);
        width: calc(100% - 40px);
        max-width: 320px;
        background: var(--ui-bg, #fff);
        color: var(--ui-text, #111);
        padding: 14px 18px;
        border-radius: var(--ui-radius, 8px);
        text-align: center;
        box-shadow: 0 6px 20px rgba(0,0,0,0.35);
      }
      #battleScreen .battle-name {
        font-size: 17px; font-weight: 600;
        word-break: break-word;
      }
      #battleScreen .battle-stats {
        font-size: 13px;
        color: var(--ui-muted, #666);
        margin-top: 4px;
      }
      .type-chips {
        display: flex; justify-content: center; gap: 6px;
        margin-top: 6px;
      }
      .type-chip {
        display: inline-block;
        padding: 2px 8px;
        font-size: 11px;
        font-weight: 600;
        color: #fff;
        text-transform: capitalize;
        border-radius: 999px;
        text-shadow: 0 1px 1px rgba(0,0,0,0.4);
        line-height: 1.4;
      }
      .candy-tally {
        text-align: center;
        font-size: 12px;
        color: var(--ui-muted, #666);
        margin-top: 6px;
        line-height: 1.4;
      }
      .candy-tally b {
        color: var(--ui-text, #111);
        font-weight: 600;
      }
      #battleScreen .battle-actions {
        position: absolute;
        bottom: 8%;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
      }
      #battleScreen .battle-balls {
        display: flex; gap: 10px; flex-wrap: wrap;
        justify-content: center;
      }
      #battleScreen .battle-ball-btn {
        display: flex; flex-direction: column; align-items: center;
        gap: 2px;
        padding: 8px 14px;
        background: rgba(255,255,255,0.15);
        border: 1px solid rgba(255,255,255,0.3);
        border-radius: var(--ui-radius, 8px);
        color: #fff;
        font-family: inherit;
        cursor: pointer;
        min-width: 56px;
      }
      #battleScreen .battle-ball-btn:hover {
        background: rgba(255,255,255,0.25);
      }
      #battleScreen .battle-ball-btn:disabled {
        opacity: 0.4; cursor: default;
      }
      #battleScreen .battle-ball-btn img {
        width: 32px; height: 32px; display: block;
      }
      #battleScreen .battle-ball-btn .ball-count {
        font-size: 12px; font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      #battleScreen .battle-no-balls {
        color: rgba(255,255,255,0.7);
        font-size: 13px; font-style: italic;
        padding: 8px 14px;
      }
      #battleScreen .battle-actions button.flee {
        padding: 8px 24px;
        font-size: 13px;
        font-weight: 600;
        border-radius: var(--ui-radius, 8px);
        border: none;
        cursor: pointer;
        font-family: inherit;
        background: rgba(255,255,255,0.15);
        color: #fff;
      }
      /* Throw / capture animation elements. Both sit centered inside
         .battle-sprite-wrap and are toggled hidden by JS. The thrown
         ball is animated via the Web Animations API in throwBall(). */
      /* Ball anchored to the bottom-center of the sprite-wrap (i.e.
         the creature's feet). transform-origin at 50%/100% so the
         wobble rotates around the ball's own bottom-center, like a
         physical pokéball settling on the ground. The natural
         transform is just translateX(-50%); JS adds translateY +
         scale + rotation on top.
         The ball is composed of two halves (clipped views of the
         same SVG) so the top can physically open / flip up on
         break-out, plus a seam-glow overlay used on catch success.
         When closed they overlap perfectly and read as one ball. */
      #battleScreen .battle-thrown-ball {
        position: absolute;
        left: 50%;
        bottom: 0;
        width: 48px; height: 48px;
        transform: translateX(-50%);
        transform-origin: 50% 100%;
        pointer-events: none;
        z-index: 2;
        /* Establish 3D rendering context for the ball halves so the
           top half can tilt backward via rotateX during break-out
           (perspective + preserve-3d give the lid-hinge effect). */
        perspective: 300px;
        transform-style: preserve-3d;
      }
      #battleScreen .ball-half {
        position: absolute;
        inset: 0;
        width: 100%; height: 100%;
        pointer-events: none;
      }
      /* clip-path is applied per-half so each img only renders its
         own region of the same source SVG. */
      #battleScreen .ball-top    { clip-path: inset(0 0 50% 0); }
      #battleScreen .ball-bottom { clip-path: inset(50% 0 0 0); }
      #battleScreen .ball-seam-glow {
        position: absolute;
        inset: 0;
        width: 100%; height: 100%;
        opacity: 0;
        pointer-events: none;
        filter: drop-shadow(0 0 4px rgba(255, 255, 255, 0.95))
                drop-shadow(0 0 6px rgba(255, 240, 180, 0.8));
      }
      /* Radial burst centered on the ball's resting position
         (bottom-center of the wrap). Used for the "ball opens" pop
         on break-out and the warm "ball glows" pulse on catch
         success — neither of which should use the silhouette flash
         since the creature is either reforming or already gone. JS
         applies a CSS variable for the inner color so we can warm
         it up for the catch (gold) vs. cool for the break (white). */
      #battleScreen .battle-burst {
        position: absolute;
        left: 50%;
        bottom: 0;
        width: 240px;
        height: 240px;
        /* Translate down by (240/2 - 24)px = ~96px = 40% so the
           gradient's CENTER sits at the ball's center (~24px above
           the wrap bottom for a 48px ball anchored at bottom). */
        transform: translate(-50%, 40%);
        background: radial-gradient(circle at 50% 50%,
          var(--burst-color, rgba(255,255,255,0.95)) 0%,
          rgba(255,255,255,0.35) 28%,
          transparent 60%);
        opacity: 0;
        pointer-events: none;
        z-index: 1;
      }
      /* Silhouette flash: copies the creature's image and tints it
         pure white via filter, so the "capture flash" is the shape
         of the creature, not a rectangle. Same dimensions and
         object-fit as the underlying sprite so they overlap exactly.
         drop-shadow gives a soft glow around the silhouette edge. */
      #battleScreen .battle-flash {
        position: absolute;
        inset: 0;
        width: 100%; height: 100%;
        object-fit: contain;
        image-rendering: pixelated;
        image-rendering: crisp-edges;
        opacity: 0;
        pointer-events: none;
        z-index: 1;
        filter: brightness(0) invert(1) drop-shadow(0 0 6px rgba(255,255,255,0.9));
      }
      /* While throwing, hide the action panel so the player can't
         spam clicks during the animation. */
      #battleScreen.throwing .battle-actions { pointer-events: none; opacity: 0.4; }
    `;
    document.head.appendChild(s);
  }

  function ensurePanel() {
    let panel = document.getElementById('creatureInventory');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'creatureInventory';
    panel.innerHTML = `
      <div class="sheet">
        <button class="close inventory-x" type="button" aria-label="close">×</button>
        <div class="browse-view">
          <div class="browse-header">
            <h3>Creatures</h3>
            <button class="tags-link" type="button">Tags</button>
            <button class="bag-link" type="button">Bag</button>
            <button class="candy-link" type="button">Candy</button>
            <button class="pokedex-link" type="button">Dex</button>
          </div>
          <div class="weather-bar"></div>
          <button class="save-reminder" type="button"></button>
          <div class="search-row">
            <input id="creatureSearch" type="search" placeholder="Search by name" autocomplete="off">
          </div>
          <div class="search-row">
            <div class="ac-field">
              <input id="creatureSearchAny" type="search" placeholder="Species" autocomplete="off">
              <ul class="ac-list" id="creatureAcAny" role="listbox"></ul>
            </div>
          </div>
          <div class="search-row pokedex-search-row">
            <div class="ac-field">
              <input id="creatureSearchA" type="search" placeholder="First Species" autocomplete="off">
              <ul class="ac-list" id="creatureAcA" role="listbox"></ul>
            </div>
            <button id="creatureSwap" class="pokedex-swap-btn" type="button"
                    aria-label="swap first and second species" title="swap species">⇄</button>
            <div class="ac-field">
              <input id="creatureSearchB" type="search" placeholder="Second Species" autocomplete="off">
              <ul class="ac-list" id="creatureAcB" role="listbox"></ul>
            </div>
          </div>
          <div class="type-filter-row">
            <label class="type-pair"><span>Either:</span>${typeFilterSelectHtml('creatureFilterType')}</label>
            <label class="type-pair"><span>First:</span>${typeFilterSelectHtml('creatureFilterTypeA')}</label>
            <label class="type-pair"><span>Second:</span>${typeFilterSelectHtml('creatureFilterTypeB')}</label>
          </div>
          <div class="inv-tag-filter-row"></div>
          <div class="sort-row">
            <label for="creatureSortBy">Sort</label>
            <select id="creatureSortBy">
              <option value="recent">Recent</option>
              <option value="level">Level</option>
              <option value="size">Size</option>
              <option value="name">Name</option>
              <option value="species">Species</option>
            </select>
            <button class="dir" type="button" id="creatureSortDir" aria-label="toggle sort direction"></button>
          </div>
          <div class="creature-list"></div>
          <div class="actions"><button class="close" type="button">Done</button></div>
        </div>
        <div class="detail-view">
          <button class="detail-back" type="button" aria-label="back">←</button>
          <button class="nav-arrow nav-prev" type="button" aria-label="previous">‹</button>
          <button class="nav-arrow nav-next" type="button" aria-label="next">›</button>
          <div class="detail-track"></div>
          <div class="actions"><button class="close" type="button">Done</button></div>
        </div>
        <div class="fusion-view">
          <button class="fusion-back" type="button" aria-label="back">←</button>
          <button class="nav-arrow nav-prev" type="button" aria-label="previous">‹</button>
          <button class="nav-arrow nav-next" type="button" aria-label="next">›</button>
          <div class="fusion-track"></div>
          <div class="actions"><button class="close" type="button">Done</button></div>
        </div>
        <div class="pokedex-view">
          <div class="pokedex-header">
            <button class="pokedex-back" type="button" aria-label="back">←</button>
            <div class="pokedex-stats"></div>
          </div>
          <div class="search-row">
            <div class="ac-field">
              <input id="pokedexSearchAny" type="search" placeholder="Species" autocomplete="off">
              <ul class="ac-list" id="pokedexAcAny" role="listbox"></ul>
            </div>
          </div>
          <div class="search-row pokedex-search-row">
            <div class="ac-field">
              <input id="pokedexSearchA" type="search" placeholder="First Species" autocomplete="off">
              <ul class="ac-list" id="pokedexAcA" role="listbox"></ul>
            </div>
            <button id="pokedexSwap" class="pokedex-swap-btn" type="button"
                    aria-label="swap first and second species" title="swap species">⇄</button>
            <div class="ac-field">
              <input id="pokedexSearchB" type="search" placeholder="Second Species" autocomplete="off">
              <ul class="ac-list" id="pokedexAcB" role="listbox"></ul>
            </div>
          </div>
          <div class="type-filter-row">
            <label class="type-pair"><span>Either:</span>${typeFilterSelectHtml('pokedexFilterType')}</label>
            <label class="type-pair"><span>First:</span>${typeFilterSelectHtml('pokedexFilterTypeA')}</label>
            <label class="type-pair"><span>Second:</span>${typeFilterSelectHtml('pokedexFilterTypeB')}</label>
          </div>
          <div class="pokedex-tag-filter-row"></div>
          <div class="sort-row">
            <label for="pokedexSortBy">Sort</label>
            <select id="pokedexSortBy">
              <option value="recent">Recent</option>
              <option value="a">First name</option>
              <option value="b">Second name</option>
              <option value="aId">First ID</option>
              <option value="bId">Second ID</option>
            </select>
            <button class="dir" type="button" id="pokedexSortDir" aria-label="toggle sort direction"></button>
          </div>
          <div class="pokedex-grid"></div>
          <div class="actions"><button class="close" type="button">Done</button></div>
        </div>
        <div class="candy-view">
          <button class="candy-back" type="button" aria-label="back">←</button>
          <div class="candy-body"></div>
          <div class="actions"><button class="close" type="button">Done</button></div>
        </div>
        <div class="bag-view">
          <button class="bag-back" type="button" aria-label="back">←</button>
          <div class="bag-body"></div>
          <div class="actions"><button class="close" type="button">Done</button></div>
        </div>
        <div class="tags-view">
          <button class="tags-back" type="button" aria-label="back">←</button>
          <div class="tags-body"></div>
          <div class="actions"><button class="close" type="button">Done</button></div>
        </div>
      </div>
    `;
    panel.addEventListener('click', (e) => {
      if (e.target === panel) hide();
    });
    panel.querySelectorAll('button.close').forEach((btn) => {
      btn.addEventListener('click', hide);
    });

    const browseView = panel.querySelector('.browse-view');
    const detailView = panel.querySelector('.detail-view');
    const sortBy = panel.querySelector('#creatureSortBy');
    const sortDir = panel.querySelector('#creatureSortDir');
    const search = panel.querySelector('#creatureSearch');
    const listEl = panel.querySelector('.creature-list');
    const syncDirButton = () => {
      const dir = readSortDir();
      sortDir.textContent = dir === 'asc' ? '↑' : '↓';
      sortDir.title = dir === 'asc' ? 'ascending (low to high)' : 'descending (high to low)';
    };
    sortBy.value = readSortKey();
    syncDirButton();
    sortBy.addEventListener('change', () => {
      localStorage.setItem('cc.creatureSortBy', sortBy.value);
      renderList(listEl);
    });
    sortDir.addEventListener('click', () => {
      const next = readSortDir() === 'asc' ? 'desc' : 'asc';
      localStorage.setItem('cc.creatureSortDir', next);
      syncDirButton();
      renderList(listEl);
    });
    search.addEventListener('input', () => renderList(listEl));

    // Inventory's per-species name searches and type filters (mirror
    // the Pokédex set). Type filters persist via localStorage; the
    // species-name searches are session-only (cleared on every open()).
    const invSearchAny = panel.querySelector('#creatureSearchAny');
    const invSearchA = panel.querySelector('#creatureSearchA');
    const invSearchB = panel.querySelector('#creatureSearchB');
    if (invSearchAny) invSearchAny.addEventListener('input', () => renderList(listEl));
    if (invSearchA) invSearchA.addEventListener('input', () => renderList(listEl));
    if (invSearchB) invSearchB.addEventListener('input', () => renderList(listEl));
    if (invSearchAny) attachSpeciesAutocomplete(invSearchAny,
      panel.querySelector('#creatureAcAny'),
      () => _capturedSpeciesIds('any'));
    if (invSearchA) attachSpeciesAutocomplete(invSearchA,
      panel.querySelector('#creatureAcA'),
      () => _capturedSpeciesIds('a'));
    if (invSearchB) attachSpeciesAutocomplete(invSearchB,
      panel.querySelector('#creatureAcB'),
      () => _capturedSpeciesIds('b'));
    const invSwap = panel.querySelector('#creatureSwap');
    if (invSwap && invSearchA && invSearchB) {
      invSwap.addEventListener('click', () => {
        const a = invSearchA.value;
        invSearchA.value = invSearchB.value;
        invSearchB.value = a;
        renderList(listEl);
      });
    }
    const invFilterType = panel.querySelector('#creatureFilterType');
    const invFilterTypeA = panel.querySelector('#creatureFilterTypeA');
    const invFilterTypeB = panel.querySelector('#creatureFilterTypeB');
    if (invFilterType) {
      invFilterType.value = readInvFilterType();
      applyTypeSelectColor(invFilterType);
      invFilterType.addEventListener('change', () => {
        localStorage.setItem('cc.invFilterType', invFilterType.value);
        applyTypeSelectColor(invFilterType);
        renderList(listEl);
      });
    }
    if (invFilterTypeA) {
      invFilterTypeA.value = readInvFilterTypeA();
      applyTypeSelectColor(invFilterTypeA);
      invFilterTypeA.addEventListener('change', () => {
        localStorage.setItem('cc.invFilterTypeA', invFilterTypeA.value);
        applyTypeSelectColor(invFilterTypeA);
        renderList(listEl);
      });
    }
    if (invFilterTypeB) {
      invFilterTypeB.value = readInvFilterTypeB();
      applyTypeSelectColor(invFilterTypeB);
      invFilterTypeB.addEventListener('change', () => {
        localStorage.setItem('cc.invFilterTypeB', invFilterTypeB.value);
        applyTypeSelectColor(invFilterTypeB);
        renderList(listEl);
      });
    }

    // Delegated card click — rebinding per render would be noisier and
    // the grid is small enough that delegation is trivially fast.
    const openFromTarget = (target) => {
      const card = target.closest && target.closest('.creature-card');
      const id = card && card.getAttribute('data-id');
      if (!id) return;
      // Pass the inventory's current rendered list + clicked index so
      // the detail sub-view can offer arrow/swipe navigation through
      // siblings in the same filtered + sorted order.
      const idx = _lastInventoryItems.findIndex((it) => it.id === id);
      showDetail(id, _lastInventoryItems, idx >= 0 ? idx : null);
    };
    listEl.addEventListener('click', (e) => openFromTarget(e.target));
    listEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openFromTarget(e.target);
      }
    });

    panel.querySelector('.detail-back').addEventListener('click', popView);
    panel.querySelector('.pokedex-back').addEventListener('click', popView);
    panel.querySelector('.fusion-back').addEventListener('click', popView);
    // Sibling-navigation arrow buttons (one pair per sub-view).
    panel.querySelectorAll('.detail-view .nav-prev, .fusion-view .nav-prev')
      .forEach((b) => b.addEventListener('click', () => navigateSibling(-1)));
    panel.querySelectorAll('.detail-view .nav-next, .fusion-view .nav-next')
      .forEach((b) => b.addEventListener('click', () => navigateSibling(1)));

    // Arrow-key + swipe navigation through sibling entries while
    // viewing a detail or fusion sub-view. Keys listen at window
    // level (so they fire even when no input is focused), gated by
    // panel-visibility + correct sub-view. Swipe listens on the
    // sub-view containers only — not the parent grid views.
    window.addEventListener('keydown', (e) => {
      if (!panel.classList.contains('show')) return;
      const top = _viewStack[_viewStack.length - 1];
      if (!top || !Array.isArray(top.list)) return;
      // Don't hijack arrows from inputs / textareas (search box, etc.).
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowRight') { e.preventDefault(); navigateSibling(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); navigateSibling(-1); }
    });
    // Finger-tracking drag — track translates with the finger live;
    // on release we either commit (animate to ±viewWidth then update
    // state) or revert (animate back to 0). Vertical scrolling
    // within a slot still works because the lock-in heuristic only
    // claims the gesture once horizontal travel dominates.
    function attachDrag(viewName) {
      const viewEl = panel.querySelector(_viewSelector(viewName));
      const trackSel = _trackSelector(viewName);
      if (!viewEl) return;
      let startX = 0, startY = 0, lastX = 0, lastT = 0;
      let tracking = false, decided = false, dragging = false;
      let startTime = 0;
      const DECIDE_THRESHOLD = 8;     // px of travel before committing to a direction
      const COMMIT_FRACTION = 0.28;   // fraction of viewWidth that triggers commit
      const VELOCITY_THRESHOLD = 0.5; // px/ms after release that triggers commit

      viewEl.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        if (_navAnimating) return;
        // If a previous swipe's commit/revert animation is still
        // pending, settle it synchronously right now — runs the
        // pending onEnd which commits state + rebuilds the track.
        // Without this, the new drag would race the old animation:
        // the new finger movement cancels the transition early,
        // fires transitionend, _commitNavigate runs mid-drag, and
        // the slot under the finger gets replaced with the next
        // pokemon instead of the one being dragged toward.
        const t0 = panel.querySelector(trackSel);
        if (t0 && t0._pendingOnEnd) t0._pendingOnEnd();
        const top = _viewStack[_viewStack.length - 1];
        if (!top || !Array.isArray(top.list)) return;
        startX = lastX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        startTime = lastT = performance.now();
        tracking = true; decided = false; dragging = false;
      }, { passive: true });

      viewEl.addEventListener('touchmove', (e) => {
        if (!tracking) return;
        const t = e.touches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (!decided) {
          if (Math.abs(dx) < DECIDE_THRESHOLD && Math.abs(dy) < DECIDE_THRESHOLD) return;
          decided = true;
          if (Math.abs(dx) > Math.abs(dy) * 1.2) {
            dragging = true;
          } else {
            // Vertical scroll wins — bow out for the rest of this gesture.
            tracking = false;
            return;
          }
        }
        if (!dragging) return;
        e.preventDefault();
        const top = _viewStack[_viewStack.length - 1];
        const track = panel.querySelector(trackSel);
        if (!track) return;
        // Rubber-band at ends — drag still moves but with reduced response.
        let applied = dx;
        if ((top.idx <= 0 && dx > 0) || (top.idx >= top.list.length - 1 && dx < 0)) {
          applied = dx * 0.3;
        }
        track.style.transition = 'none';
        track.style.transform = `translate3d(${applied}px, 0, 0)`;
        lastX = t.clientX;
        lastT = performance.now();
      }, { passive: false });

      viewEl.addEventListener('touchend', () => {
        if (!tracking) { return; }
        tracking = false;
        if (!dragging) return;
        dragging = false;
        const top = _viewStack[_viewStack.length - 1];
        const track = panel.querySelector(trackSel);
        if (!top || !track) return;
        const viewWidth = viewEl.offsetWidth || 320;
        const dx = lastX - startX;
        const totalElapsed = performance.now() - startTime;
        const velocity = totalElapsed > 0 ? dx / totalElapsed : 0;  // px/ms
        let direction = 0;
        if (Math.abs(dx) > viewWidth * COMMIT_FRACTION) direction = dx > 0 ? -1 : 1;
        else if (Math.abs(velocity) > VELOCITY_THRESHOLD) direction = velocity > 0 ? -1 : 1;
        // Clamp at ends.
        if (direction !== 0) {
          const newIdx = top.idx + direction;
          if (newIdx < 0 || newIdx >= top.list.length) direction = 0;
        }
        track.classList.add('nav-anim');
        track.style.transition = '';
        if (direction === 0) {
          track.style.transform = 'translate3d(0, 0, 0)';
        } else {
          track.style.transform = `translate3d(${direction > 0 ? -viewWidth : viewWidth}px, 0, 0)`;
        }
        let settled = false;
        const onEnd = () => {
          if (settled) return;
          settled = true;
          track.removeEventListener('transitionend', onEnd);
          track.classList.remove('nav-anim');
          track.style.transition = 'none';
          if (direction !== 0) _commitNavigate(direction);
          else track.style.transform = 'translate3d(0, 0, 0)';
          track._pendingOnEnd = null;
        };
        // Stash on the track so a fresh touchstart can settle the
        // pending commit synchronously before starting a new drag —
        // otherwise rapid back-to-back swipes race the previous
        // transitionend, repopulating the track under the finger.
        track._pendingOnEnd = onEnd;
        track.addEventListener('transitionend', onEnd);
        // Belt-and-braces in case transitionend doesn't fire.
        setTimeout(() => {
          if (track.classList.contains('nav-anim')) onEnd();
        }, 500);
      }, { passive: true });

      viewEl.addEventListener('touchcancel', () => {
        if (!dragging) { tracking = false; return; }
        const track = panel.querySelector(trackSel);
        if (track) {
          track.classList.add('nav-anim');
          track.style.transition = '';
          track.style.transform = 'translate3d(0, 0, 0)';
          setTimeout(() => {
            track.classList.remove('nav-anim');
            track.style.transition = 'none';
          }, 350);
        }
        tracking = false; dragging = false; decided = false;
      }, { passive: true });
    }
    attachDrag('detail');
    attachDrag('fusion');
    panel.querySelector('.candy-back').addEventListener('click', popView);
    panel.querySelector('.bag-back').addEventListener('click', popView);
    panel.querySelector('.tags-back').addEventListener('click', popView);
    panel.querySelector('.pokedex-link').addEventListener('click', () => showPokedex());
    panel.querySelector('.candy-link').addEventListener('click', () => showCandy());
    panel.querySelector('.bag-link').addEventListener('click', () => showBag());
    panel.querySelector('.tags-link').addEventListener('click', () => showTags());
    panel.querySelector('.save-reminder').addEventListener('click', openSettingsFromInventory);

    // Pokédex card → fusion sub-view (delegated; cards are re-rendered).
    const pokedexGrid = panel.querySelector('.pokedex-grid');
    pokedexGrid.addEventListener('click', (e) => {
      const card = e.target.closest && e.target.closest('.pokedex-card');
      if (!card) return;
      const key = card.dataset.key;
      if (!key) return;
      const dash = key.indexOf('-');
      const a = +key.slice(0, dash);
      const b = +key.slice(dash + 1);
      // Pass the currently-rendered list + clicked index so the
      // fusion sub-view can offer arrow/swipe navigation to its
      // siblings in the same filtered + sorted order.
      const idx = _lastPokedexEntries.findIndex((e) => e.a === a && e.b === b);
      showFusionView(a, b, _lastPokedexEntries, idx >= 0 ? idx : null);
    });

    const pokedexSortBy = panel.querySelector('#pokedexSortBy');
    const pokedexSortDir = panel.querySelector('#pokedexSortDir');
    const syncPokedexDirButton = () => {
      const dir = readPokedexSortDir();
      pokedexSortDir.textContent = dir === 'asc' ? '↑' : '↓';
      pokedexSortDir.title = dir === 'asc'
        ? 'ascending (oldest / A→Z)'
        : 'descending (newest / Z→A)';
    };
    pokedexSortBy.value = readPokedexSortKey();
    syncPokedexDirButton();
    pokedexSortBy.addEventListener('change', () => {
      localStorage.setItem('cc.pokedexSortBy', pokedexSortBy.value);
      renderPokedex();
    });
    pokedexSortDir.addEventListener('click', () => {
      const next = readPokedexSortDir() === 'asc' ? 'desc' : 'asc';
      localStorage.setItem('cc.pokedexSortDir', next);
      syncPokedexDirButton();
      renderPokedex();
    });

    const pokedexFilterType = panel.querySelector('#pokedexFilterType');
    pokedexFilterType.value = readPokedexFilterType();
    applyTypeSelectColor(pokedexFilterType);
    pokedexFilterType.addEventListener('change', () => {
      localStorage.setItem('cc.pokedexFilterType', pokedexFilterType.value);
      applyTypeSelectColor(pokedexFilterType);
      renderPokedex();
    });

    const pokedexFilterTypeA = panel.querySelector('#pokedexFilterTypeA');
    pokedexFilterTypeA.value = readPokedexFilterTypeA();
    applyTypeSelectColor(pokedexFilterTypeA);
    pokedexFilterTypeA.addEventListener('change', () => {
      localStorage.setItem('cc.pokedexFilterTypeA', pokedexFilterTypeA.value);
      applyTypeSelectColor(pokedexFilterTypeA);
      renderPokedex();
    });

    const pokedexFilterTypeB = panel.querySelector('#pokedexFilterTypeB');
    pokedexFilterTypeB.value = readPokedexFilterTypeB();
    applyTypeSelectColor(pokedexFilterTypeB);
    pokedexFilterTypeB.addEventListener('change', () => {
      localStorage.setItem('cc.pokedexFilterTypeB', pokedexFilterTypeB.value);
      applyTypeSelectColor(pokedexFilterTypeB);
      renderPokedex();
    });

    const pokedexSearchAny = panel.querySelector('#pokedexSearchAny');
    const pokedexSearchA = panel.querySelector('#pokedexSearchA');
    const pokedexSearchB = panel.querySelector('#pokedexSearchB');
    pokedexSearchAny.addEventListener('input', renderPokedex);
    pokedexSearchA.addEventListener('input', renderPokedex);
    pokedexSearchB.addEventListener('input', renderPokedex);
    attachSpeciesAutocomplete(pokedexSearchAny, panel.querySelector('#pokedexAcAny'),
      () => _seenSpeciesIds('any'));
    attachSpeciesAutocomplete(pokedexSearchA, panel.querySelector('#pokedexAcA'),
      () => _seenSpeciesIds('a'));
    attachSpeciesAutocomplete(pokedexSearchB, panel.querySelector('#pokedexAcB'),
      () => _seenSpeciesIds('b'));
    const pokedexSwap = panel.querySelector('#pokedexSwap');
    if (pokedexSwap) {
      pokedexSwap.addEventListener('click', () => {
        const a = pokedexSearchA.value;
        pokedexSearchA.value = pokedexSearchB.value;
        pokedexSearchB.value = a;
        renderPokedex();
      });
    }

    document.body.appendChild(panel);
    return panel;
  }

  // Navigation history. Each entry is a view state object:
  //   { view: 'browse' }
  //   { view: 'detail', id }
  //   { view: 'fusion', a, b }
  //   { view: 'pokedex', opts }
  // Every show* function pushes; every Back button pops. Stack is
  // cleared (back to [browse]) when the panel is opened from outside,
  // so a fresh tap of the creature-ball gives a fresh start.
  let _viewStack = [{ view: 'browse' }];
  // Most recently rendered list/grid contents — populated by
  // renderPokedex / renderList, consumed by card click handlers
  // when entering a sub-view so the sub-view can offer left/right
  // arrow + swipe navigation through adjacent entries in the
  // same order the user just saw.
  let _lastPokedexEntries = [];
  let _lastInventoryItems = [];

  function applyTopView() {
    const panel = ensurePanel();
    const top = _viewStack[_viewStack.length - 1] || { view: 'browse' };
    panel.querySelector('.browse-view').style.display = 'none';
    panel.querySelector('.detail-view').classList.remove('show');
    panel.querySelector('.pokedex-view').classList.remove('show');
    panel.querySelector('.fusion-view').classList.remove('show');
    panel.querySelector('.candy-view').classList.remove('show');
    panel.querySelector('.bag-view').classList.remove('show');
    panel.querySelector('.tags-view').classList.remove('show');
    switch (top.view) {
      case 'browse': {
        panel.querySelector('.browse-view').style.display = '';
        // Restore the saved scroll before render — renderList uses
        // live sheet.scrollTop for in-view re-renders, so the sheet
        // must already hold the right value when re-entering.
        const sheet = panel.querySelector('.sheet');
        if (sheet) sheet.scrollTop = (top.scrollY || 0);
        renderList(panel.querySelector('.creature-list'));
        return;
      }
      case 'detail': {
        const creature = findCreature(top.id);
        if (!creature) {
          // Capture was deleted underfoot — drop this entry and re-apply
          // whatever was below it.
          _viewStack.pop();
          applyTopView();
          return;
        }
        // Drop any cached slot for this id so renderDetail re-renders
        // (covers nickname / tag changes that happen between visits).
        const k = _slotKey('detail', { id: creature.id });
        if (k) {
          const cached = _slotCache.get(k);
          if (cached) {
            const inner = cached.firstChild;
            if (inner) revokeObjectUrlsIn(inner);
            if (cached.parentNode) cached.remove();
            _slotCache.delete(k);
          }
        }
        _populateTrack('detail', top);
        panel.querySelector('.detail-view').classList.add('show');
        _updateNavArrows();
        return;
      }
      case 'fusion':
        _populateTrack('fusion', top);
        panel.querySelector('.fusion-view').classList.add('show');
        _updateNavArrows();
        return;
      case 'pokedex': {
        const opts = top.opts || {};
        const sAny = panel.querySelector('#pokedexSearchAny');
        const sa = panel.querySelector('#pokedexSearchA');
        const sb = panel.querySelector('#pokedexSearchB');
        if (sAny) sAny.value = opts.searchAny || '';
        if (sa)   sa.value   = opts.searchA   || '';
        if (sb)   sb.value   = opts.searchB   || '';
        panel.querySelector('.pokedex-view').classList.add('show');
        // Restore the navigation-saved scroll position before
        // renderPokedex runs — the renderer now uses live sheet
        // scrollTop, so the sheet must already hold the right value.
        const sheet = panel.querySelector('.sheet');
        if (sheet) sheet.scrollTop = (top.scrollY || 0);
        renderPokedex();
        return;
      }
      case 'candy':
        renderCandy();
        panel.querySelector('.candy-view').classList.add('show');
        return;
      case 'bag':
        renderBag();
        panel.querySelector('.bag-view').classList.add('show');
        return;
      case 'tags':
        renderTags();
        panel.querySelector('.tags-view').classList.add('show');
        return;
    }
  }

  // Capture the scroll position of the panel's scroll container into
  // the current top stack entry so it can be restored when the user
  // pops back to it. The panel uses a single .sheet element as the
  // scrolling container for every view — capturing/restoring its
  // scrollTop in the entry preserves "where I was" for inventory and
  // pokedex (and any sub-view that scrolls).
  function _captureCurrentScroll() {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const sheet = panel.querySelector('.sheet');
    const top = _viewStack[_viewStack.length - 1];
    if (sheet && top) top.scrollY = sheet.scrollTop;
  }

  function pushView(state) {
    _captureCurrentScroll();
    _viewStack.push(state);
    applyTopView();
  }

  function popView() {
    if (_viewStack.length > 1) {
      _viewStack.pop();
      applyTopView();
    } else {
      // Already at the root view — nothing to pop. Stay put.
      applyTopView();
    }
  }

  function showBrowse() {
    _viewStack = [{ view: 'browse' }];
    applyTopView();
  }

  function showDetail(id, list, idx) {
    const state = { view: 'detail', id };
    if (Array.isArray(list) && typeof idx === 'number') {
      state.list = list;
      state.idx = idx;
    }
    pushView(state);
  }

  function showFusionView(a, b, list, idx) {
    const state = { view: 'fusion', a, b };
    if (Array.isArray(list) && typeof idx === 'number') {
      state.list = list;
      state.idx = idx;
    }
    pushView(state);
  }

  // Per-view layout constants (mirrored from the virtualizeGrid
  // call sites). Used to keep the parent's scroll position in sync
  // with the sibling we navigated to, so popping back lands the
  // grid scrolled to that creature's row instead of where we
  // started.
  const VIEW_GRID_LAYOUT = {
    pokedex: { cols: 3, rowPitch: 158 },  // cardHeight 150 + rowGap 8
    browse:  { cols: 3, rowPitch: 186 },  // cardHeight 178 + rowGap 8
  };

  function _updateParentScrollForSibling(parentView, idx) {
    const layout = VIEW_GRID_LAYOUT[parentView];
    if (!layout) return;
    // Find the parent stack entry — the one BELOW this sub-view.
    for (let i = _viewStack.length - 2; i >= 0; i--) {
      const e = _viewStack[i];
      if (e.view === parentView) {
        const row = Math.floor(idx / layout.cols);
        // Place the row a couple rows from the top of the visible
        // area when popping back (looks better than sticking it
        // under the header).
        const target = Math.max(0, row * layout.rowPitch - layout.rowPitch);
        e.scrollY = target;
        return;
      }
    }
  }

  function _viewSelector(viewName) {
    if (viewName === 'detail') return '.detail-view';
    if (viewName === 'fusion') return '.fusion-view';
    return null;
  }
  function _trackSelector(viewName) {
    if (viewName === 'detail') return '.detail-track';
    if (viewName === 'fusion') return '.fusion-track';
    return null;
  }

  // Body-slot cache. Each cached entry is a `<div class="body-slot">`
  // containing a fully-rendered detail/fusion body. Caching means
  // when the user swipes to a sibling and back, the previous slot's
  // DOM (with its loaded sprites) is reused instead of re-rendered.
  // Eviction policy: keep entries within ±2 of the current index.
  // Beyond that, the slot is removed from the cache and any object
  // URLs inside are revoked.
  const _slotCache = new Map();
  function _slotKey(view, item) {
    if (view === 'detail') return `detail:${item.id}`;
    if (view === 'fusion') return `fusion:${item.a}-${item.b}`;
    return null;
  }
  function _evictDistantSlots(view, list, idx) {
    if (!list || idx == null) return;
    const keep = new Set();
    for (let i = -2; i <= 2; i++) {
      const j = idx + i;
      if (j >= 0 && j < list.length) keep.add(_slotKey(view, list[j]));
    }
    for (const k of [..._slotCache.keys()]) {
      if (!k.startsWith(view + ':')) continue;
      if (keep.has(k)) continue;
      const slot = _slotCache.get(k);
      if (slot) {
        const inner = slot.firstChild;
        if (inner && inner.querySelectorAll) revokeObjectUrlsIn(inner);
        if (slot.parentNode) slot.remove();
      }
      _slotCache.delete(k);
    }
  }
  function _getOrCreateSlot(view, item) {
    if (!item) return null;
    const key = _slotKey(view, item);
    if (!key) return null;
    if (_slotCache.has(key)) return _slotCache.get(key);
    const slot = document.createElement('div');
    slot.className = 'body-slot';
    slot.dataset.key = key;
    const body = document.createElement('div');
    body.className = view === 'detail' ? 'detail-body' : 'fusion-body';
    if (view === 'detail') {
      const c = findCreature(item.id);
      if (!c) return null;
      renderDetail(c, body);
    } else if (view === 'fusion') {
      renderFusionView(item.a, item.b, body);
    }
    slot.appendChild(body);
    _slotCache.set(key, slot);
    return slot;
  }

  // Populate the track for a sub-view with prev/center/next slots
  // (where they exist in the list). Idempotent — clears the track
  // first. Reset transform to translateX(0) so the center slot is
  // visible at default.
  function _populateTrack(viewName, top) {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const track = panel.querySelector(_trackSelector(viewName));
    if (!track) return;
    track.innerHTML = '';
    track.style.transition = 'none';
    track.style.transform = 'translate3d(0, 0, 0)';
    const list = Array.isArray(top.list) ? top.list : null;
    const idx = typeof top.idx === 'number' ? top.idx : null;
    // Center slot — always present. Built from the current top state
    // even when there's no list (single-item view).
    const centerItem = viewName === 'detail'
      ? { id: top.id }
      : { a: top.a, b: top.b };
    const center = _getOrCreateSlot(viewName, centerItem);
    if (center) {
      center.classList.remove('prev', 'next');
      center.classList.add('center');
      track.appendChild(center);
    }
    // Prev / next only when we have list context.
    if (list && idx !== null) {
      if (idx > 0) {
        const prev = _getOrCreateSlot(viewName, list[idx - 1]);
        if (prev) {
          prev.classList.remove('center', 'next');
          prev.classList.add('prev');
          track.appendChild(prev);
        }
      }
      if (idx < list.length - 1) {
        const next = _getOrCreateSlot(viewName, list[idx + 1]);
        if (next) {
          next.classList.remove('center', 'prev');
          next.classList.add('next');
          track.appendChild(next);
        }
      }
      _evictDistantSlots(viewName, list, idx);
    }
  }

  let _navAnimating = false;

  // Commit the navigation: update top stack entry to the new index,
  // recompute parent scroll, rebuild the track. Used by both touch
  // (after the drag's commit animation) and click/keyboard arrow.
  function _commitNavigate(delta) {
    const top = _viewStack[_viewStack.length - 1];
    if (!top || !Array.isArray(top.list) || typeof top.idx !== 'number') return;
    const newIdx = top.idx + delta;
    if (newIdx < 0 || newIdx >= top.list.length) return;
    const sibling = top.list[newIdx];
    if (!sibling) return;
    if (top.view === 'detail') { top.id = sibling.id; top.idx = newIdx; }
    else if (top.view === 'fusion') { top.a = sibling.a; top.b = sibling.b; top.idx = newIdx; }
    else return;
    top.scrollY = 0;
    const parentView =
      top.view === 'detail' ? 'browse' :
      top.view === 'fusion' ? 'pokedex' : null;
    if (parentView) _updateParentScrollForSibling(parentView, newIdx);
    _populateTrack(top.view, top);
    _updateNavArrows();
  }

  // Animated navigation for non-touch entry points (keyboard arrows,
  // arrow buttons). Touch swipe drives the animation directly via the
  // drag handlers. Animates the track to ±viewWidth, then commits.
  function navigateSibling(delta) {
    if (_navAnimating) return;
    const top = _viewStack[_viewStack.length - 1];
    if (!top || !Array.isArray(top.list) || typeof top.idx !== 'number') return;
    const newIdx = top.idx + delta;
    if (newIdx < 0 || newIdx >= top.list.length) return;
    const panel = document.getElementById('creatureInventory');
    const view = panel && panel.querySelector(_viewSelector(top.view));
    const track = panel && panel.querySelector(_trackSelector(top.view));
    if (!view || !track) return;
    _navAnimating = true;
    const viewWidth = view.offsetWidth || 320;
    track.style.transition = '';
    track.classList.add('nav-anim');
    track.style.transform = `translate3d(${delta > 0 ? -viewWidth : viewWidth}px, 0, 0)`;
    const onEnd = () => {
      track.removeEventListener('transitionend', onEnd);
      track.classList.remove('nav-anim');
      track.style.transition = 'none';
      _commitNavigate(delta);
      _navAnimating = false;
    };
    track.addEventListener('transitionend', onEnd);
    // Safety timeout in case transitionend doesn't fire (e.g. layout
    // swap interrupts).
    setTimeout(() => {
      if (_navAnimating) onEnd();
    }, 500);
  }

  // Toggle visibility + disabled state of the in-view nav arrows
  // based on whether the current sub-view has a sibling list and
  // where we are in it.
  function _updateNavArrows() {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const top = _viewStack[_viewStack.length - 1];
    const viewSel = top && _viewSelector(top.view);
    if (!viewSel) return;
    const view = panel.querySelector(viewSel);
    if (!view) return;
    const prev = view.querySelector('.nav-prev');
    const next = view.querySelector('.nav-next');
    const hasList = top && Array.isArray(top.list) && typeof top.idx === 'number';
    [prev, next].forEach((b) => { if (b) b.classList.toggle('show', !!hasList); });
    if (!hasList) return;
    if (prev) prev.disabled = top.idx <= 0;
    if (next) next.disabled = top.idx >= top.list.length - 1;
  }

  function showPokedex(opts) {
    pushView({ view: 'pokedex', opts: opts || null });
  }

  function showCandy() {
    pushView({ view: 'candy' });
  }

  function showBag() {
    pushView({ view: 'bag' });
  }

  function showTags() {
    pushView({ view: 'tags' });
  }

  // Tags view: a "Create new tag" button at the top, followed by the
  // list of all tags. Built-in tags appear first with a "(built-in)"
  // hint and no Remove button (they're predicate-driven and can't be
  // deleted). User tags can be removed via a confirm() prompt that
  // warns about removal from any creatures that have it applied.
  function renderTags() {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const body = panel.querySelector('.tags-body');
    if (!body) return;
    const userTags = readTags().filter((t) => !isBuiltinTag(t));
    const total = BUILTIN_TAGS.length + userTags.length;
    const subtitle = `${total} tag${total === 1 ? '' : 's'}`
      + (BUILTIN_TAGS.length
        ? ` · ${BUILTIN_TAGS.length} built-in, ${userTags.length} custom`
        : '');
    const builtinRows = BUILTIN_TAGS.map((b) => `
      <div class="tags-row tags-row-builtin">
        <span class="tags-name">${escapeHtml(b.name)}</span>
        <span class="tags-builtin-note">${escapeHtml(b.description)}</span>
      </div>
    `).join('');
    const userRows = userTags.map((t) => `
      <div class="tags-row" data-tag="${escapeHtml(t)}">
        <span class="tags-name">${escapeHtml(t)}</span>
        <button class="tags-remove" type="button">Remove</button>
      </div>
    `).join('');
    body.innerHTML = `
      <div class="tags-title">Tags</div>
      <div class="tags-subtitle">${escapeHtml(subtitle)}</div>
      <button class="tags-create" type="button">+ Create new tag</button>
      <div class="tags-list">${builtinRows}${userRows}</div>
    `;
    body.querySelector('.tags-create').addEventListener('click', () => {
      const raw = window.prompt(`New tag (max ${TAG_MAX_LEN} characters)`);
      if (raw == null) return;
      const t = normalizeTagName(raw);
      if (!t) {
        alert(`Tag must be 1\u2013${TAG_MAX_LEN} non-empty characters.`);
        return;
      }
      if (isBuiltinTag(t)) {
        alert(`"${t}" is a built-in tag name and can't be used.`);
        return;
      }
      if (readTags().includes(t)) {
        alert(`Tag "${t}" already exists.`);
        return;
      }
      addTag(t);
      renderTags();
    });
    body.querySelectorAll('.tags-row').forEach((row) => {
      const t = row.dataset.tag;
      if (!t) return; // built-in row, no remove button
      row.querySelector('.tags-remove').addEventListener('click', () => {
        const usedBy = readCapturedCreatures()
          .filter((c) => Array.isArray(c.tags) && c.tags.includes(t))
          .length;
        const note = usedBy > 0
          ? `\nThis will also remove "${t}" from ${usedBy} creature${usedBy === 1 ? '' : 's'}.`
          : '';
        if (!confirm(`Delete tag "${t}"?${note}`)) return;
        deleteTag(t);
        renderTags();
      });
    });
  }

  // Bag view: row per item with name + description + count. Sorted by
  // count descending so the user's stockpiles surface first; ties are
  // broken alphabetically by display name. Items with no catalog entry
  // (e.g. forward-compat from a future build) still render via their
  // raw key so nothing silently disappears.
  function renderBag() {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const body = panel.querySelector('.bag-body');
    if (!body) return;
    const bag = readBag();
    const entries = Object.entries(bag)
      .filter(([, n]) => n > 0)
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        const na = (ITEMS[a[0]] && ITEMS[a[0]].name) || a[0];
        const nb = (ITEMS[b[0]] && ITEMS[b[0]].name) || b[0];
        return na.localeCompare(nb);
      });
    if (!entries.length) {
      body.innerHTML = `
        <div class="bag-title">Bag</div>
        <div class="bag-empty">Bag is empty.</div>
      `;
      return;
    }
    const total = entries.reduce((sum, [, n]) => sum + n, 0);
    const subtitle = `${total} item${total === 1 ? '' : 's'} across ${entries.length} type${entries.length === 1 ? '' : 's'}`;
    const rows = entries.map(([key, n]) => {
      const meta = ITEMS[key] || { name: key, desc: '' };
      const iconHtml = meta.icon
        ? `<img class="bag-icon" src="${escapeHtml(meta.icon)}" alt="">`
        : '';
      return `
        <div class="bag-row">
          ${iconHtml}
          <div class="bag-info">
            <div class="bag-name">${escapeHtml(meta.name)}</div>
            ${meta.desc ? `<div class="bag-desc">${escapeHtml(meta.desc)}</div>` : ''}
          </div>
          <div class="bag-count">×${n}</div>
        </div>
      `;
    }).join('');
    body.innerHTML = `
      <div class="bag-title">Bag</div>
      <div class="bag-subtitle">${escapeHtml(subtitle)}</div>
      <div class="bag-list">${rows}</div>
    `;
  }

  // Candy view: rows of species name + cumulative count. Sorted by
  // count descending so the user's heaviest stockpiles surface at the
  // top; ties broken alphabetically by display name. Keys are species
  // indices (numeric strings); display name comes from Species.nameFor
  // and falls back to "#<idx>" if names data isn't loaded.
  function speciesNameFor(idx) {
    const n = parseInt(idx, 10);
    if (!isFinite(n)) return String(idx);
    if (global.Species && global.Species.nameFor) {
      return global.Species.nameFor(n) || `#${n}`;
    }
    return `#${n}`;
  }
  function renderCandy() {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const body = panel.querySelector('.candy-body');
    if (!body) return;
    const candy = readCandy();
    const entries = Object.entries(candy)
      .filter(([, n]) => n > 0)
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return speciesNameFor(a[0]).localeCompare(speciesNameFor(b[0]));
      });
    const total = entries.reduce((sum, [, n]) => sum + n, 0);
    const subtitle = total > 0
      ? `${total} candy across ${entries.length} famil${entries.length === 1 ? 'y' : 'ies'}`
      : '';
    if (!entries.length) {
      body.innerHTML = `
        <div class="candy-title">Candy</div>
        <div class="candy-empty">No candy yet — catch some creatures to earn family candy!</div>
      `;
      return;
    }
    const rows = entries.map(([key, n]) => `
      <div class="candy-row">
        <span class="candy-name">${escapeHtml(speciesNameFor(key))}</span>
        <span class="candy-count">×${n}</span>
      </div>
    `).join('');
    body.innerHTML = `
      <div class="candy-title">Candy</div>
      <div class="candy-subtitle">${escapeHtml(subtitle)}</div>
      <div class="candy-list">${rows}</div>
    `;
  }

  // Renders the "Art variants" grid inside a fusion sub-view from
  // the locally-cached creature sprite IDB — no network. Each card
  // is a silhouette unless that variant appears in the trainer's
  // seenVariants set. Autogen is one card; custom variants are
  // one card per slot index from sprites.js's variant store.
  async function _populateFusionVariantGrid(gridEl, a, b) {
    if (!gridEl) return;
    const seen = readSeenVariants(a, b);
    const fusionSeen = isFusionSeen(a, b);
    if (!global.Sprites) {
      gridEl.innerHTML = '<div class="variant-empty">Sprites unavailable.</div>';
      return;
    }
    // Resolve count + autogen blob URL in parallel.
    const [variantCount, autoUrl] = await Promise.all([
      global.Sprites.getCellVariantCount(a, b).catch(() => 0),
      global.Sprites.getSpriteUrl(a, b, null).catch(() => null),
    ]);
    // Each card is built inline so the grid renders in order
    // (autogen first, then slots 0..N-1) without async race.
    // Autogen is only shown when there are no custom variants —
    // otherwise the hand-drawn ones stand on their own.
    const cards = [];
    if (variantCount === 0) {
      const autoCls = !fusionSeen ? 'silhouette' : '';
      cards.push({
        cls: `variant-cell autogen ${autoCls}`,
        url: autoUrl,
        label: !fusionSeen ? '???' : 'autogen',
      });
    } else if (autoUrl) {
      // Autogen URL fetched in parallel with the count but not used —
      // revoke so the blob doesn't sit idle in memory.
      try { URL.revokeObjectURL(autoUrl); } catch {}
    }
    // Build slot URLs + credits in parallel; use Promise.all so we
    // apply them to the DOM in deterministic order.
    const [slotUrls, slotCredits] = await Promise.all([
      Promise.all(Array.from({ length: variantCount }, (_, i) =>
        global.Sprites.getSpriteUrl(a, b, i).catch(() => null))),
      Promise.all(Array.from({ length: variantCount }, (_, i) =>
        global.Sprites.getSpriteCreditForSlot
          ? global.Sprites.getSpriteCreditForSlot(a, b, i).catch(() => null)
          : Promise.resolve(null))),
    ]);
    for (let i = 0; i < variantCount; i++) {
      const isSeen = seen.has(String(i));
      // Label IS the artist name when we have it; falls back to a
      // simple variant number if the credits bundle hasn't been
      // downloaded yet. Silhouettes always show '???' (no spoiler).
      let label;
      if (!isSeen) label = '???';
      else if (slotCredits[i]) label = slotCredits[i];
      else label = `#${i + 1}`;
      cards.push({
        cls: `variant-cell ${isSeen ? '' : 'silhouette'}`,
        url: slotUrls[i],
        label,
      });
    }
    if (!cards.length) {
      gridEl.innerHTML = '<div class="variant-empty">No variants found.</div>';
      return;
    }
    // Render cards. <img> src is set to the blob URL when we have
    // one; otherwise left empty (placeholder). The img.onload
    // handler is responsible for revoking the blob URL once the
    // browser has decoded it — keeps the icon in the browser's
    // image cache without leaving the URL alive on the element.
    gridEl.innerHTML = cards.map((c) => `
      <div class="${c.cls}">
        <img alt="">
        <div class="label">${escapeHtml(c.label)}</div>
      </div>
    `).join('');
    const cellEls = gridEl.querySelectorAll('.variant-cell');
    cards.forEach((c, i) => {
      const img = cellEls[i] && cellEls[i].querySelector('img');
      if (!img) return;
      if (!c.url) { img.style.opacity = '0.2'; return; }
      img.onload = () => { try { URL.revokeObjectURL(c.url); } catch {} };
      img.src = c.url;
    });
  }

  function renderFusionView(a, b, targetBody) {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const body = targetBody || panel.querySelector('.fusion-body');
    if (!body) return;
    // Revoke leftover sprite URLs from the previous render before we
    // wipe the body — without this, navigating back into the fusion
    // view repeatedly leaks one URL per visible card.
    revokeObjectUrlsIn(body);

    const nameA = global.Species ? global.Species.nameFor(a) : `#${a}`;
    const nameB = global.Species ? global.Species.nameFor(b) : `#${b}`;
    const display = `${nameA} × ${nameB}`;
    // Canonical fused name (e.g. "Jigglyish") — null when SPLIT_NAMES
    // isn't loaded yet; header falls back to "A × B" alone.
    const fusedName = (global.Sprites && global.Sprites.getFusedName)
      ? global.Sprites.getFusedName(a, b) : null;
    const typesHtml = typeChipsHtml(fusionTypesFor(a, b));

    // All captures of this fusion, newest first.
    const myCaptures = readCapturedCreatures()
      .filter((c) => c.speciesA === a && c.speciesB === b)
      .sort((x, y) => (y.caughtAt && y.caughtAt.timestamp || 0)
                    - (x.caughtAt && x.caughtAt.timestamp || 0));

    let capturedHtml = '';
    if (myCaptures.length) {
      const nicks = readNicknames();
      // Default name = canonical fused name (e.g. "Jigglyish") when
      // SPLIT_NAMES is loaded, else the "A × B" pair.
      const defaultRowName = fusedName || display;
      capturedHtml = `<div class="fusion-section-label">Captured (${myCaptures.length})</div>`
        + myCaptures.map((cap) => {
          const nm = nicks[cap.id] || defaultRowName;
          const date = cap.caughtAt && cap.caughtAt.timestamp
            ? new Date(cap.caughtAt.timestamp).toLocaleDateString()
            : '';
          // Variant attribution: starts as "autogen" (when null) or
          // "#N" (when a numeric custom slot). For numeric slots we
          // async-resolve the artist credit below and swap the text
          // in place once the credits bundle returns the name.
          let variantLabel = '';
          if (cap.variant === null) variantLabel = 'autogen';
          else if (typeof cap.variant === 'number') variantLabel = `#${cap.variant + 1}`;
          // Ordered HTML chunks joined by " · " separators. Each chunk
          // is fully escaped so user-controlled text can't sneak in.
          const chunks = [];
          if (cap.level != null) chunks.push(escapeHtml(`Lv ${cap.level}`));
          if (cap.sizeM != null) chunks.push(escapeHtml(formatSize(cap.sizeM)));
          if (variantLabel) {
            const vAttr = (typeof cap.variant === 'number') ? cap.variant : '';
            chunks.push(`<span class="row-variant" data-variant="${vAttr}">${escapeHtml(variantLabel)}</span>`);
          }
          if (date) chunks.push(escapeHtml(date));
          return `<div class="fusion-caught-row" data-id="${escapeHtml(cap.id)}" role="button" tabindex="0">
            <div class="row-name">${escapeHtml(nm)}</div>
            <div class="row-meta">${chunks.join(' · ')}</div>
          </div>`;
        }).join('');
    }

    // Encounter info (always shown — even for caught fusions, the first
    // encounter timestamp is interesting). Clickable when we have a
    // location, to fly the map to the first sighting.
    const seen = readSeenFusions()[`${a}-${b}`] || {};
    let encounterHtml = '';
    let encounterClickable = false;
    if (seen.firstSeen || seen.lat != null) {
      const when = seen.firstSeen ? new Date(seen.firstSeen).toLocaleString() : '';
      const where = seen.poi && seen.poi.name
        ? `${seen.poi.name} (${Math.round(seen.poi.distanceM)} m away)`
        : (seen.lat != null
            ? `${seen.lat.toFixed(5)}, ${seen.lng.toFixed(5)}`
            : '');
      const lines = [];
      if (when) lines.push(`<div>First encountered ${escapeHtml(when)}</div>`);
      if (where) lines.push(`<div class="row-meta">${escapeHtml(where)}</div>`);
      if (lines.length) {
        encounterClickable = seen.lat != null && seen.lng != null;
        const cls = `fusion-encounter${encounterClickable ? ' fusion-encounter-clickable' : ''}`;
        const attrs = encounterClickable
          ? ` role="button" tabindex="0" title="show on map"`
          : '';
        encounterHtml = `<div class="fusion-section-label">Encounter</div>`
          + `<div class="${cls}"${attrs}>${lines.join('')}</div>`;
      }
    }

    body.innerHTML = `
      <div class="detail-art">
        <span class="detail-art-placeholder" aria-hidden="true">•</span>
        <img class="detail-art-img" alt="" style="display:none">
      </div>
      <div class="detail-name-row">
        ${fusedName ? `<div class="detail-fused-name">${escapeHtml(fusedName)}</div>` : ''}
        <div class="detail-name${fusedName ? ' detail-name-sub' : ''}">
          <span class="species-link" data-side="A">${escapeHtml(nameA)}</span>
          <span> × </span>
          <span class="species-link" data-side="B">${escapeHtml(nameB)}</span>
        </div>
      </div>
      ${typesHtml}
      ${capturedHtml}
      ${encounterHtml}
      <div class="fusion-section-label">Art variants</div>
      <div class="variant-grid"></div>
    `;
    // Populate the variant grid asynchronously — server tells us
    // which variant suffixes are non-blank for this cell, then we
    // render thumbnails for each. Variants the trainer hasn't seen
    // (per readSeenVariants — sourced from per-spawn tracking +
    // captures-with-variant) render as silhouettes.
    const variantGrid = body.querySelector('.variant-grid');
    if (variantGrid) _populateFusionVariantGrid(variantGrid, a, b);
    body.querySelectorAll('.species-link').forEach((link) => {
      link.addEventListener('click', () => {
        if (link.dataset.side === 'A') showPokedex({ searchA: nameA });
        else showPokedex({ searchB: nameB });
      });
    });

    // Fusion sprite for the header. Prefer the lowest-indexed variant
    // the trainer has actually seen so the header matches the variant
    // grid — falls back to the abstract default picker (custom v0 /
    // autogen) when nothing has been seen.
    if (global.Sprites) {
      const headerVariant = pickPreferredSeenVariant(a, b);
      const headerP = (typeof headerVariant === 'number')
        ? global.Sprites.getSpriteUrl(a, b, headerVariant)
        : (headerVariant === null
            ? global.Sprites.getSpriteUrl(a, b, null)
            : global.Sprites.getDefaultSpriteUrl(a, b));
      headerP.then((url) => {
        if (!url) return;
        const img = body.querySelector('.detail-art-img');
        const ph = body.querySelector('.detail-art-placeholder');
        if (!img) { URL.revokeObjectURL(url); return; }
        img.onload = () => {
          URL.revokeObjectURL(url);
          if (ph) ph.style.display = 'none';
          img.style.display = 'block';
        };
        img.src = url;
      });
    }

    if (encounterClickable) {
      const enc = body.querySelector('.fusion-encounter-clickable');
      if (enc) {
        const fly = () => flyToCaughtLocation(seen.lat, seen.lng);
        enc.addEventListener('click', fly);
        enc.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fly(); }
        });
      }
    }

    // Wire row clicks → existing detail view. The view stack pushes
    // detail on top of fusion, so detail's Back returns here naturally.
    body.querySelectorAll('.fusion-caught-row').forEach((row) => {
      const open = () => showDetail(row.dataset.id);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });

    // Async-resolve artist credit for each numeric variant in the
    // captures list. Falls back to the "#N" placeholder text already
    // rendered when the credits bundle has nothing on file.
    if (global.Sprites && global.Sprites.getSpriteCreditForSlot) {
      body.querySelectorAll('.row-variant').forEach((span) => {
        const v = span.dataset.variant;
        if (v === '' || v == null) return;  // autogen — leave as-is
        const slot = parseInt(v, 10);
        if (!Number.isFinite(slot) || slot < 0) return;
        global.Sprites.getSpriteCreditForSlot(a, b, slot)
          .then((artist) => { if (artist) span.textContent = artist; })
          .catch(() => {});
      });
    }
  }

  // Toggle a `filter-active` class on each filter control whose value
  // isn't the default "any" / blank, so it's visually obvious when
  // the grid is being narrowed by something the user might have
  // forgotten about. Used by both the Pokédex and the inventory.
  function updateFilterIndicators(panel, selectors) {
    for (const sel of selectors) {
      const el = panel.querySelector(sel);
      if (!el) continue;
      const isActive = (el.value || '').trim() !== '';
      el.classList.toggle('filter-active', isActive);
    }
  }
  const POKEDEX_FILTER_SELECTORS = [
    '#pokedexSearchAny',
    '#pokedexSearchA',
    '#pokedexSearchB',
    '#pokedexFilterType',
    '#pokedexFilterTypeA',
    '#pokedexFilterTypeB',
  ];
  const INV_FILTER_SELECTORS = [
    '#creatureSearch',
    '#creatureSearchAny',
    '#creatureSearchA',
    '#creatureSearchB',
    '#creatureFilterType',
    '#creatureFilterTypeA',
    '#creatureFilterTypeB',
  ];

  // Pokedex tag-filter chip row. Only built-in tags appear here —
  // user tags are per-capture and don't apply to abstract fusions.
  // AND semantics on click (match every selected predicate).
  function renderPokedexTagFilterRow() {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const row = panel.querySelector('.pokedex-tag-filter-row');
    if (!row) return;
    if (!BUILTIN_TAGS.length) { row.innerHTML = ''; return; }
    const selected = new Set(readPokedexTagFilter());
    row.innerHTML = BUILTIN_TAGS.map((b) => {
      const t = b.name;
      const cls = selected.has(t) ? 'inv-tag-chip applied' : 'inv-tag-chip';
      return `<button class="${cls}" data-tag="${escapeHtml(t)}" type="button">${escapeHtml(t)}</button>`;
    }).join('');
    row.querySelectorAll('.inv-tag-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const t = chip.dataset.tag;
        if (!t) return;
        const sel = readPokedexTagFilter();
        const i = sel.indexOf(t);
        if (i >= 0) sel.splice(i, 1); else sel.push(t);
        writePokedexTagFilter(sel);
        renderPokedex();
      });
    });
  }

  function renderPokedex() {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    updateFilterIndicators(panel, POKEDEX_FILTER_SELECTORS);
    renderPokedexTagFilterRow();
    const seen = readSeenFusions();
    const caught = caughtFusionsSet();
    let entries = Object.keys(seen).map((key) => {
      const dash = key.indexOf('-');
      const a = +key.slice(0, dash);
      const b = +key.slice(dash + 1);
      return {
        key, a, b,
        firstSeen: (seen[key] && seen[key].firstSeen) || 0,
        caught: caught.has(key),
      };
    });

    const filterType = readPokedexFilterType();
    const filterTypeA = readPokedexFilterTypeA();
    const filterTypeB = readPokedexFilterTypeB();
    if (filterType || filterTypeA || filterTypeB) {
      entries = entries.filter((e) => {
        const types = fusionTypesFor(e.a, e.b);
        if (!types || !types.length) return false;
        // "Either": any of the fusion's types matches.
        if (filterType && !types.includes(filterType)) return false;
        // "First": the fusion's primary slot (always types[0]).
        if (filterTypeA && types[0] !== filterTypeA) return false;
        // "Second": the fusion's secondary slot (types[1]); a fusion
        // whose A and B share the same effective type is single-typed
        // post-dedup and won't match any "Second" filter.
        if (filterTypeB && types[1] !== filterTypeB) return false;
        return true;
      });
    }
    // Built-in tag filter (e.g. "Pure"). Predicates take a creature-
    // shaped object — for the abstract pokedex entry we synthesize
    // one from the (a, b) pair. AND semantics across selected tags.
    const selectedPokedexTags = readPokedexTagFilter();
    if (selectedPokedexTags.length) {
      const preds = selectedPokedexTags
        .map((name) => BUILTIN_TAGS.find((b) => b.name === name))
        .filter(Boolean);
      if (preds.length) {
        entries = entries.filter((e) => {
          const synthetic = { speciesA: e.a, speciesB: e.b };
          return preds.every((b) => b.predicate(synthetic));
        });
      }
    }

    const nameOfLower = (idx) => global.Species
      ? global.Species.nameFor(idx).toLowerCase()
      : `#${idx}`;
    const sAny = (panel.querySelector('#pokedexSearchAny') || {}).value || '';
    const sa = (panel.querySelector('#pokedexSearchA') || {}).value || '';
    const sb = (panel.querySelector('#pokedexSearchB') || {}).value || '';
    const qAny = sAny.trim().toLowerCase();
    const qA = sa.trim().toLowerCase();
    const qB = sb.trim().toLowerCase();
    if (qAny) entries = entries.filter((e) =>
      nameOfLower(e.a).includes(qAny) || nameOfLower(e.b).includes(qAny));
    if (qA) entries = entries.filter((e) => nameOfLower(e.a).includes(qA));
    if (qB) entries = entries.filter((e) => nameOfLower(e.b).includes(qB));

    const sortKey = readPokedexSortKey();
    const sortDir = readPokedexSortDir();
    const sign = sortDir === 'asc' ? 1 : -1;
    const nameOf = (idx) => global.Species ? global.Species.nameFor(idx) : `#${idx}`;
    entries.sort((x, y) => {
      if (sortKey === 'a')   return sign * nameOf(x.a).localeCompare(nameOf(y.a));
      if (sortKey === 'b')   return sign * nameOf(x.b).localeCompare(nameOf(y.b));
      if (sortKey === 'aId') return sign * (x.a - y.a);
      if (sortKey === 'bId') return sign * (x.b - y.b);
      // 'recent': firstSeen
      return sign * (x.firstSeen - y.firstSeen);
    });

    const totalSeen = entries.length;
    const totalCaught = caught.size;
    const encounteredOnly = Math.max(0, totalSeen - totalCaught);
    const statsEl = panel.querySelector('.pokedex-stats');
    if (statsEl) {
      statsEl.innerHTML =
        `<b>${totalCaught}</b> caught · <b>${encounteredOnly}</b> encountered`;
    }

    const grid = panel.querySelector('.pokedex-grid');
    if (!grid) return;
    if (!entries.length) {
      if (grid._virtCleanup) grid._virtCleanup();
      const filteredOut = filterType || filterTypeA || filterTypeB
        || qAny || qA || qB;
      const msg = filteredOut
        ? 'No seen creatures match those filters.'
        : 'No creatures seen yet — go exploring!';
      grid.innerHTML = `<div class="creature-empty">${escapeHtml(msg)}</div>`;
      return;
    }

    const sheet = panel.querySelector('.sheet');
    // Use the live sheet scrollTop so in-view re-renders (tag chip
    // toggles, search input, sort change, etc.) preserve the user's
    // current position instead of snapping back to the view-stack's
    // navigation snapshot. The stack's scrollY is applied to the
    // sheet in applyTopView's 'pokedex' case before the first render,
    // so the live value is already correct on re-entry.
    _lastPokedexEntries = entries;
    virtualizeGrid({
      scrollEl: sheet,
      gridEl: grid,
      items: entries,
      cols: 3,
      rowGap: 8,
      cardHeight: 162,
      initialScrollTop: sheet ? sheet.scrollTop : 0,
      makeCardEl(entry) {
        const bases = global.Species
          ? `${global.Species.nameFor(entry.a)} × ${global.Species.nameFor(entry.b)}`
          : `#${entry.a} × #${entry.b}`;
        // Canonical fused name (e.g. "Jigglyish") falls back to the
        // bases pair when SPLIT_NAMES isn't loaded yet.
        const fused = (global.Sprites && global.Sprites.getFusedName)
          ? global.Sprites.getFusedName(entry.a, entry.b) : null;
        const primary = fused || bases;
        const subline = fused ? bases : '';
        const card = document.createElement('div');
        card.className = 'pokedex-card';
        card.dataset.key = entry.key;
        card.innerHTML =
          (entry.caught ? '<span class="caught-badge" title="caught">✓</span>' : '')
          + `<div class="pokedex-art"><img alt=""></div>`
          + `<div class="pokedex-name">${escapeHtml(primary)}</div>`
          + `<div class="pokedex-bases">${escapeHtml(subline)}</div>`;
        return card;
      },
      loadSpriteFor(card, entry) {
        if (!global.Sprites) return;
        // Prefer the lowest-indexed variant the trainer has actually
        // seen, so the tile they tap matches what's "unlocked" inside
        // the fusion view. Falls back to the abstract default picker
        // (custom v0 / autogen) when nothing is seen.
        const v = pickPreferredSeenVariant(entry.a, entry.b);
        const p = (typeof v === 'number')
          ? global.Sprites.getSpriteUrl(entry.a, entry.b, v)
          : (v === null
              ? global.Sprites.getSpriteUrl(entry.a, entry.b, null)
              : global.Sprites.getDefaultSpriteUrl(entry.a, entry.b));
        p.then((url) => {
          if (!url) return;
          const img = card.querySelector('img');
          if (!img) { URL.revokeObjectURL(url); return; }
          img.onload = () => {
            URL.revokeObjectURL(url);
            card.classList.add('ready');
          };
          img.src = url;
        });
      },
    });
  }

  function renderDetail(c, targetBody) {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const body = targetBody || panel.querySelector('.detail-body');
    // Revoke any in-flight sprite URLs from the previous render so
    // we don't leak blobs when the detail view is re-rendered (every
    // navigation back here re-runs renderDetail).
    revokeObjectUrlsIn(body);
    const nick = readNicknames()[c.id];
    const name = nick || c.name;
    const stats = [];
    if (c.level != null) stats.push(`Lv ${c.level}`);
    if (c.sizeM != null) stats.push(formatSize(c.sizeM));
    const statsHtml = stats.length
      ? `<div class="detail-stats">${stats.map((s, i) =>
          (i ? '<span class="sep">·</span>' : '') + `<span>${escapeHtml(s)}</span>`
        ).join('')}</div>`
      : '';
    const speciesLine = nick
      ? `<div class="detail-species">Species: ${escapeHtml(c.name)}</div>`
      : '';
    let caughtLine = '';
    let caughtClickable = false;
    if (c.caughtAt) {
      const when = c.caughtAt.timestamp
        ? new Date(c.caughtAt.timestamp).toLocaleDateString()
        : '';
      const where = c.caughtAt.poi && c.caughtAt.poi.name
        ? `${c.caughtAt.poi.name} (${Math.round(c.caughtAt.poi.distanceM)} m away)`
        : `${c.caughtAt.lat.toFixed(5)}, ${c.caughtAt.lng.toFixed(5)}`;
      const parts = [];
      if (where) parts.push(escapeHtml(where));
      if (when) parts.push(escapeHtml(when));
      caughtClickable = c.caughtAt.lat != null && c.caughtAt.lng != null;
      const cls = `detail-caught${caughtClickable ? ' detail-caught-clickable' : ''}`;
      const attrs = caughtClickable
        ? ` role="button" tabindex="0" title="show on map"`
        : '';
      caughtLine = `<div class="${cls}"${attrs}>Caught at ${parts.join(' · ')}</div>`;
    }
    const typesHtml = (c.speciesA != null && c.speciesB != null)
      ? typeChipsHtml(fusionTypesFor(c.speciesA, c.speciesB))
      : '';
    let evosHtml = '';
    let evoEntries = [];
    if (c.speciesA != null && c.speciesB != null) {
      evoEntries = fusionEvolutionsFor(c.speciesA, c.speciesB);
      if (evoEntries.length) {
        evosHtml = `<div class="detail-evos">
          <div class="detail-evos-label">Evolves to</div>
          ${evoEntries.map((e, i) => {
            const seen = isFusionSeen(e.newA, e.newB);
            const targetName = (global.Species && seen)
              ? `${global.Species.nameFor(e.newA)} × ${global.Species.nameFor(e.newB)}`
              : '???';
            return `<div class="evo-row${seen ? '' : ' silhouette'}" data-evo-idx="${i}">
              <span class="evo-arrow">→</span>
              <div class="evo-art">
                <span class="evo-art-placeholder" aria-hidden="true">•</span>
                <img alt="">
              </div>
              <div class="evo-name">${escapeHtml(targetName)}</div>
              <div class="evo-req">${escapeHtml(formatEvolutionMethod(e.method, e.param))}</div>
            </div>`;
          }).join('')}
        </div>`;
      }
    }
    let familyHtml = '';
    let famA = null, famB = null;
    if (c.speciesA != null && c.speciesB != null
        && global.Species && global.Species.familyOf) {
      famA = global.Species.familyOf(c.speciesA);
      famB = global.Species.familyOf(c.speciesB);
      // Only show the toggle if there's more than one cell to display.
      if (famA.length > 1 || famB.length > 1) {
        familyHtml = `<div class="detail-family">
          <button class="family-toggle" type="button" aria-expanded="false">
            View family tree (${famA.length}×${famB.length})
          </button>
          <div class="family-grid" hidden></div>
        </div>`;
      }
    }
    const pokedexLinkHtml = (c.speciesA != null && c.speciesB != null)
      ? `<button class="detail-pokedex-link" type="button">View dex entry →</button>`
      : '';
    body.innerHTML = `
      <div class="detail-art">
        <span class="detail-art-placeholder" aria-hidden="true">${escapeHtml(c.emoji || '•')}</span>
        <img class="detail-art-img" alt="" style="display:none">
      </div>
      <div class="detail-name-row" data-mode="view">
        <div class="detail-name">${escapeHtml(name)}</div>
        <button class="icon-btn rename-edit" type="button" aria-label="rename" title="rename">✎</button>
      </div>
      ${pokedexLinkHtml}
      ${speciesLine}
      ${typesHtml}
      ${statsHtml}
      ${caughtLine}
      ${candyTallyHtml(c.speciesA, c.speciesB)}
      ${detailTagsHtml(c)}
      ${evosHtml}
      ${familyHtml}
    `;
    const pokedexLink = body.querySelector('.detail-pokedex-link');
    if (pokedexLink) {
      pokedexLink.addEventListener('click', () => {
        showFusionView(c.speciesA, c.speciesB);
      });
    }
    if (caughtClickable) {
      const caughtEl = body.querySelector('.detail-caught-clickable');
      if (caughtEl) {
        const fly = () => flyToCaughtLocation(c.caughtAt.lat, c.caughtAt.lng);
        caughtEl.addEventListener('click', fly);
        caughtEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fly(); }
        });
      }
    }
    if (famA && famB && famHasContent(famA, famB)) {
      const toggle = body.querySelector('.family-toggle');
      const grid = body.querySelector('.family-grid');
      if (toggle && grid) {
        toggle.addEventListener('click', () => {
          const expanded = toggle.getAttribute('aria-expanded') === 'true';
          if (expanded) {
            grid.hidden = true;
            toggle.setAttribute('aria-expanded', 'false');
            toggle.textContent = `View family tree (${famA.length}×${famB.length})`;
          } else {
            if (!grid.dataset.rendered) {
              renderFamilyGrid(grid, famA, famB, c.speciesA, c.speciesB);
              grid.dataset.rendered = '1';
            }
            grid.hidden = false;
            toggle.setAttribute('aria-expanded', 'true');
            toggle.textContent = 'Hide family tree';
          }
        });
      }
    }
    // Async-load each evolution row's sprite from IDB (no network).
    if (global.Sprites && evoEntries.length) {
      for (let i = 0; i < evoEntries.length; i++) {
        const e = evoEntries[i];
        const row = body.querySelector(`.evo-row[data-evo-idx="${i}"]`);
        if (!row) continue;
        global.Sprites.getDefaultSpriteUrl(e.newA, e.newB).then((url) => {
          if (!url) return;
          const img = row.querySelector('.evo-art img');
          if (!img) { URL.revokeObjectURL(url); return; }
          img.onload = () => {
            URL.revokeObjectURL(url);
            row.classList.add('evo-art-ready');
          };
          img.src = url;
        });
      }
    }
    body.querySelector('.rename-edit').addEventListener('click', () => {
      enterRenameMode(c);
    });
    body.querySelectorAll('.detail-tag-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const tag = chip.dataset.tag;
        if (!tag) return;
        toggleCreatureTag(c.id, tag);
        // Re-render to refresh the chip styling. Re-read the creature
        // so c.tags reflects the toggle result.
        const fresh = findCreature(c.id);
        if (fresh) renderDetail(fresh);
      });
    });
    if (global.Sprites && c.speciesA != null && c.speciesB != null) {
      // Captured creature → render the variant burned in at capture
      // time. Legacy captures (no variant field) fall back to the
      // default-variant picker.
      const p = (typeof c.variant === 'number')
        ? global.Sprites.getSpriteUrl(c.speciesA, c.speciesB, c.variant)
        : global.Sprites.getDefaultSpriteUrl(c.speciesA, c.speciesB);
      p.then((url) => {
        if (!url) return;
        const img = body.querySelector('.detail-art-img');
        const ph = body.querySelector('.detail-art-placeholder');
        if (!img) { URL.revokeObjectURL(url); return; }
        img.onload = () => {
          URL.revokeObjectURL(url);
          if (ph) ph.style.display = 'none';
          img.style.display = 'block';
        };
        img.src = url;
      });
    }
  }

  function enterRenameMode(c) {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const row = panel.querySelector('.detail-name-row');
    if (!row || row.dataset.mode === 'edit') return;
    const current = readNicknames()[c.id] || c.name;
    row.dataset.mode = 'edit';
    row.innerHTML = `
      <form class="rename-form">
        <input type="text" maxlength="40" value="${escapeHtml(current)}" aria-label="nickname">
        <button class="icon-btn rename-save" type="submit">Save</button>
        <button class="icon-btn rename-cancel" type="button">Cancel</button>
        <button class="icon-btn rename-reset" type="button" title="reset to species name">Reset</button>
      </form>
    `;
    const form = row.querySelector('form');
    const input = row.querySelector('input');
    input.focus();
    input.select();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      writeNickname(c.id, input.value);
      renderDetail(c);
    });
    row.querySelector('.rename-cancel').addEventListener('click', () => {
      renderDetail(c);
    });
    row.querySelector('.rename-reset').addEventListener('click', () => {
      writeNickname(c.id, '');
      renderDetail(c);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); renderDetail(c); }
    });
  }

  function renderWeatherBar() {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const bar = panel.querySelector('.weather-bar');
    if (!bar) return;
    const typesLoaded = global.Species
      && global.Species.typesFor
      && (global.Species.typesFor(1) || []).length > 0;
    if (!typesLoaded) {
      bar.innerHTML = `<div class="weather-warning">
        <b>No creature data downloaded.</b><br>
        Wild spawns will not appear until you tap
        <b>↓ download</b> next to "Creature sprites" in Settings.
      </div>`;
      return;
    }
    const w = (global.Spawns && global.Spawns.currentWeather)
      ? global.Spawns.currentWeather() : null;
    if (!w) { bar.innerHTML = ''; return; }
    const chip = (type) => {
      const bg = TYPE_COLORS[type] || '#888';
      const label = type.charAt(0) + type.slice(1).toLowerCase();
      return `<span class="type-chip" style="background:${bg}">${escapeHtml(label)}</span>`;
    };
    bar.innerHTML = `<div class="weather-row">
      <span class="label">Today:</span>${chip(w.daily)}
      <span class="label" style="margin-left:6px;">Week:</span>${chip(w.weekly)}
    </div>`;
  }

  // Format a duration as "Xs ago", "X minutes ago", "X hours ago",
  // "X days ago" — coarse but readable. Used both in the inventory
  // save-reminder banner and the Settings backup status line.
  function formatTimeAgo(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
    const day = Math.floor(hr / 24);
    return `${day} day${day === 1 ? '' : 's'} ago`;
  }
  // Returns null if save has never run, otherwise
  // { last, ageMs, label } where label is the formatTimeAgo string.
  function timeSinceLastSave() {
    const raw = localStorage.getItem(LAST_SAVE_KEY);
    if (!raw) return null;
    const last = Number(raw);
    if (!isFinite(last) || last <= 0) return null;
    const ageMs = Date.now() - last;
    return { last, ageMs, label: formatTimeAgo(ageMs) };
  }

  // Save reminder: shown at the top of the browse view (below the
  // weather chips) when the user has never pressed Save in Settings,
  // or when the last save was more than SAVE_REMINDER_DAYS ago.
  // Tapping the banner pops the creature panel and opens Settings so
  // the user can enter a name + press Save without hunting for it.
  // The copy explicitly notes that Save uses data — Save is one of
  // the few things in this app that hits the network at all (per the
  // zero-data PWA rule everywhere else).
  function renderSaveReminder() {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const el = panel.querySelector('.save-reminder');
    if (!el) return;
    const info = timeSinceLastSave();
    const stale = !info || info.ageMs > SAVE_REMINDER_DAYS * 24 * 60 * 60 * 1000;
    if (!stale) { el.classList.remove('show'); return; }
    const msg = !info
      ? `<b>Saving uses data</b> — recommended weekly. Tap to enter your name and Save in Settings.`
      : `<b>Saving uses data</b> — last saved ${escapeHtml(info.label)}. Tap to back up in Settings.`;
    el.innerHTML = msg;
    el.classList.add('show');
  }

  function openSettingsFromInventory() {
    hide();
    const sp = document.getElementById('settingsPanel');
    if (sp) sp.classList.add('show');
  }

  // Inventory tag-filter chip row. Re-rendered on every renderList
  // call (cheap; tag list is small) so newly-created tags appear and
  // deleted tags vanish without a panel rebuild. Empty when there are
  // no tags — the empty `<div>` collapses via the `:empty` CSS rule
  // so it doesn't take vertical space.
  function renderInvTagFilterRow() {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const row = panel.querySelector('.inv-tag-filter-row');
    if (!row) return;
    const names = allTagNames();
    if (!names.length) { row.innerHTML = ''; return; }
    const selected = new Set(readInvTagFilter());
    row.innerHTML = names.map((t) => {
      const cls = selected.has(t) ? 'inv-tag-chip applied' : 'inv-tag-chip';
      return `<button class="${cls}" data-tag="${escapeHtml(t)}" type="button">${escapeHtml(t)}</button>`;
    }).join('');
    row.querySelectorAll('.inv-tag-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const t = chip.dataset.tag;
        if (!t) return;
        const sel = readInvTagFilter();
        const i = sel.indexOf(t);
        if (i >= 0) sel.splice(i, 1); else sel.push(t);
        writeInvTagFilter(sel);
        const list = panel.querySelector('.creature-list');
        if (list) renderList(list);
      });
    });
  }

  function renderList(listEl) {
    renderWeatherBar();
    renderSaveReminder();
    const panel = document.getElementById('creatureInventory');
    if (panel) updateFilterIndicators(panel, INV_FILTER_SELECTORS);
    renderInvTagFilterRow();
    const searchEl = document.getElementById('creatureSearch');
    const q = (searchEl && searchEl.value || '').trim().toLowerCase();
    let items = sortedCreatures();
    if (q) {
      // Match against both nickname (what the user sees) and species name,
      // so a renamed creature can still be found by its original name.
      items = items.filter((c) =>
        displayName(c).toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q));
    }
    // Type filters (mirror Pokédex). "Either" → any of the fusion's
    // resolved types; "First" → primary slot; "Second" → secondary slot.
    // A monotype fusion (A and B share an effective type post-dedup) has
    // no secondary, so it won't match any "Second" filter.
    const filterType = readInvFilterType();
    const filterTypeA = readInvFilterTypeA();
    const filterTypeB = readInvFilterTypeB();
    if (filterType || filterTypeA || filterTypeB) {
      items = items.filter((c) => {
        if (c.speciesA == null || c.speciesB == null) return false;
        const types = fusionTypesFor(c.speciesA, c.speciesB);
        if (!types || !types.length) return false;
        if (filterType && !types.includes(filterType)) return false;
        if (filterTypeA && types[0] !== filterTypeA) return false;
        if (filterTypeB && types[1] !== filterTypeB) return false;
        return true;
      });
    }
    // Per-species name searches.
    const sAny = (panel && panel.querySelector('#creatureSearchAny') || {}).value || '';
    const sa = (panel && panel.querySelector('#creatureSearchA') || {}).value || '';
    const sb = (panel && panel.querySelector('#creatureSearchB') || {}).value || '';
    const qAny = sAny.trim().toLowerCase();
    const qA = sa.trim().toLowerCase();
    const qB = sb.trim().toLowerCase();
    if (qAny || qA || qB) {
      const nameOfLower = (idx) => global.Species
        ? global.Species.nameFor(idx).toLowerCase()
        : `#${idx}`;
      if (qAny) items = items.filter((c) =>
        (c.speciesA != null && nameOfLower(c.speciesA).includes(qAny))
        || (c.speciesB != null && nameOfLower(c.speciesB).includes(qAny)));
      if (qA) items = items.filter((c) => c.speciesA != null && nameOfLower(c.speciesA).includes(qA));
      if (qB) items = items.filter((c) => c.speciesB != null && nameOfLower(c.speciesB).includes(qB));
    }
    // Tag filter: AND semantics — a creature passes only when its
    // effective tag set (user-applied + matching built-ins like
    // "Pure") includes EVERY selected filter tag. Selected user tags
    // that no longer exist are pruned at deleteTag() time so this
    // list is always fresh.
    const selectedTags = readInvTagFilter();
    if (selectedTags.length) {
      items = items.filter((c) => {
        const eff = effectiveTagsForCreature(c);
        return selectedTags.every((t) => eff.includes(t));
      });
    }
    if (!items.length) {
      if (listEl._virtCleanup) listEl._virtCleanup();
      const filteredOut = q || qA || qB || filterType || filterTypeA || filterTypeB || selectedTags.length;
      const msg = filteredOut
        ? 'No creatures match those filters.'
        : 'No creatures yet — go exploring!';
      listEl.innerHTML = `<div class="creature-empty">${msg}</div>`;
      return;
    }
    const sheet = listEl.closest('.sheet');
    // Live sheet scrollTop preserves the user's position across
    // in-view re-renders (filter chip toggles, sort change, search
    // input). The view-stack's saved scrollY is applied to the sheet
    // in applyTopView's 'browse' case before the first render so the
    // live value is already correct on re-entry from a sub-view.
    _lastInventoryItems = items;
    virtualizeGrid({
      scrollEl: sheet,
      gridEl: listEl,
      items,
      cols: 3,
      rowGap: 8,
      initialScrollTop: sheet ? sheet.scrollTop : 0,
      cardHeight: 178,
      makeCardEl(c) {
        const card = document.createElement('div');
        card.className = 'creature-card';
        card.dataset.id = c.id;
        card.setAttribute('role', 'button');
        card.tabIndex = 0;
        const stats = [];
        if (c.level != null) stats.push(`Lv ${c.level}`);
        if (c.sizeM != null) stats.push(formatSize(c.sizeM));
        const statsHtml = stats.length
          ? `<div class="stats">${stats.map((s, i) =>
              (i ? '<span class="sep">·</span>' : '') + `<span>${escapeHtml(s)}</span>`
            ).join('')}</div>`
          : '';
        card.innerHTML =
          `<div class="art">`
          + `<span class="art-placeholder" aria-hidden="true">${escapeHtml(c.emoji || '•')}</span>`
          + `<img class="art-img" alt="">`
          + `</div>`
          + `<div class="name">${escapeHtml(displayName(c))}</div>`
          + statsHtml;
        return card;
      },
      loadSpriteFor(card, c) {
        if (!global.Sprites) return;
        if (c.speciesA == null || c.speciesB == null) return;
        // Captured creature → render the variant burned in at capture
        // time so the player's roster looks identical across sessions.
        // Legacy captures (no `variant` field) get default-variant.
        const p = (typeof c.variant === 'number')
          ? global.Sprites.getSpriteUrl(c.speciesA, c.speciesB, c.variant)
          : global.Sprites.getDefaultSpriteUrl(c.speciesA, c.speciesB);
        p.then((url) => {
          if (!url) return;
          const img = card.querySelector('.art-img');
          const ph = card.querySelector('.art-placeholder');
          if (!img) { URL.revokeObjectURL(url); return; }
          img.onload = () => {
            URL.revokeObjectURL(url);
            if (ph) ph.style.display = 'none';
            img.style.display = 'block';
          };
          img.src = url;
        });
      },
    });
  }

  function show() {
    const panel = ensurePanel();
    const search = panel.querySelector('#creatureSearch');
    if (search) search.value = '';
    const searchAny = panel.querySelector('#creatureSearchAny');
    if (searchAny) searchAny.value = '';
    const searchA = panel.querySelector('#creatureSearchA');
    if (searchA) searchA.value = '';
    const searchB = panel.querySelector('#creatureSearchB');
    if (searchB) searchB.value = '';
    showBrowse();
    panel.classList.add('show');
  }

  function hide() {
    const panel = document.getElementById('creatureInventory');
    if (panel) panel.classList.remove('show');
  }

  // Spawn rendering: each deterministic spawn becomes a MapLibre HTML
  // marker with the cropped fusion sprite (Sprites.getSpriteUrl). Only
  // spawns within VISIBILITY_RADIUS_M of the user's GPS fix are shown —
  // you have to actually be there to see a creature. Markers reconcile
  // by spawn id so bucket rollover replaces (not duplicates) the set.
  const VISIBILITY_RADIUS_M = 100;
  const MARKER_SIZE_PX = 168;
  // Size scales like the map: at MARKER_REF_ZOOM a creature is
  // MARKER_SIZE_PX pixels; each zoom level in or out doubles/halves that
  // so the creature covers the same geographic area at every zoom.
  // Clamps keep them tappable at low zoom and sane at very high zoom.
  const MARKER_REF_ZOOM = 18;
  const MARKER_MIN_PX = 36;
  const MARKER_MAX_PX = 336;
  let _overlayMap = null;
  let _overlayTimer = null;
  let _overlayPopup = null;
  let _geoWatchId = null;
  let _userLat = null;
  let _userLng = null;
  // _markers: spawn.id -> { marker, objectUrl, spawn }
  const _markers = new Map();
  // Dedupe cache: skip a refresh if the user has moved < 1 m AND the
  // last refresh was very recent. We can't dedupe by tick alone because
  // spawns expire mid-tick (a spawn born at tick T expires at T+5min,
  // which lands between ticks), so we cap the gap at REFRESH_MIN_GAP_MS
  // — GPS-fix storms collapse but expirations land within ~5 seconds.
  const REFRESH_MIN_GAP_MS = 5000;
  let _lastRefreshLat = null;
  let _lastRefreshLng = null;
  let _lastRefreshAt = 0;
  // Once a marker has appeared on the map it's protected from removal
  // for MIN_DISPLAY_MS so a brief GPS jitter (or a quick walk past the
  // edge of the visibility radius) doesn't yank it before the user can
  // tap. After the protection window, the next refresh — or the
  // deferred re-check below — drops the marker if it's still unwanted.
  const MIN_DISPLAY_MS = 10000;
  // Single pending timeout that re-runs refreshSpawnOverlay once the
  // soonest TTL-protected marker becomes removable. Stored at module
  // scope so successive refreshes can cancel + reschedule rather than
  // stacking timers.
  let _deferredRefreshTimer = null;

  function metersBetween(lat1, lng1, lat2, lng2) {
    const R = 6371009;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLng = (lng2 - lng1) * toRad;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function makeMarkerElement(spawn) {
    const el = document.createElement('div');
    el.className = 'creature-marker';
    el.innerHTML = `
      <div class="creature-placeholder"></div>
      <img class="creature-sprite" alt="" draggable="false">
    `;
    // The root is pointer-events: none so map gestures can pass through
    // — wire click only to the two elements that are visually "the
    // creature" (placeholder dot when sprite hasn't loaded, sprite img
    // when it has). stopPropagation prevents the click from bubbling
    // to MapLibre's map-level click handler (which would otherwise
    // open the POI underneath). Pinch-zoom / wheel-zoom are handled
    // via touch/wheel events, not click, so this is safe for them.
    const onClick = (e) => {
      e.stopPropagation();
      openBattleScreen(spawn);
    };
    el.querySelector('.creature-placeholder').addEventListener('click', onClick);
    el.querySelector('img.creature-sprite').addEventListener('click', onClick);
    return el;
  }

  // --- Battle screen ---------------------------------------------------
  // Full-screen overlay with the creature sprite in the top third and a
  // [Catch] [Flee] pair at the bottom. Catching adds the creature to the
  // local inventory and marks the spawn caught so its marker disappears
  // (locally only — other players still see it).

  let _currentBattleSpawn = null;
  let _battleSpriteUrl = null;
  // True when _battleSpriteUrl was created by us (must be revoked on
  // close); false when it was borrowed from a marker record (revoked by
  // removeMarker — we leave it alone).
  let _battleSpriteUrlOwned = false;

  function ensureBattleScreen() {
    let el = document.getElementById('battleScreen');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'battleScreen';
    el.innerHTML = `
      <div class="battle-sprite-wrap">
        <div class="battle-sprite-placeholder"></div>
        <img class="battle-sprite" alt="" draggable="false">
        <div class="battle-thrown-ball" hidden>
          <img class="ball-half ball-bottom" alt="">
          <img class="ball-half ball-top" alt="">
          <img class="ball-seam-glow" src="/static/ball-seam-glow.svg" alt="">
        </div>
        <img class="battle-flash" alt="" hidden>
        <div class="battle-burst" hidden></div>
      </div>
      <div class="battle-info">
        <div class="battle-name"></div>
        <div class="battle-stats"></div>
        <div class="battle-types"></div>
      </div>
      <div class="battle-actions">
        <button type="button" class="flee">Flee</button>
        <div class="battle-balls"></div>
      </div>
    `;
    el.querySelector('button.flee').addEventListener('click', closeBattleScreen);
    el.addEventListener('click', (e) => {
      // Click on backdrop (outside the info/actions) dismisses.
      if (e.target === el) closeBattleScreen();
    });
    document.body.appendChild(el);
    return el;
  }

  function openBattleScreen(spawn) {
    const el = ensureBattleScreen();
    _currentBattleSpawn = spawn;
    // Mark fusion seen + record which variant the user actually saw,
    // so the pokédex can silhouette variants they haven't yet seen.
    // Variant resolution is async; do it in the background.
    const _seenRec = _markers.get(spawn.id);
    if (_seenRec && 'variant' in _seenRec) {
      markFusionSeen(spawn.speciesA, spawn.speciesB, spawn, _seenRec.variant);
    } else {
      markFusionSeen(spawn.speciesA, spawn.speciesB, spawn);
      resolveSpawnVariant(spawn).then((v) => {
        markFusionSeen(spawn.speciesA, spawn.speciesB, null, v);
      }).catch(() => {});
    }
    const nameEl = el.querySelector('.battle-name');
    const statsEl = el.querySelector('.battle-stats');
    nameEl.textContent = fusionName(spawn.speciesA, spawn.speciesB);
    statsEl.textContent = `Lv ${spawn.level} · ${formatSize(spawn.sizeM)}`;
    const typesEl = el.querySelector('.battle-types');
    if (typesEl) {
      typesEl.innerHTML = typeChipsHtml(fusionTypesFor(spawn.speciesA, spawn.speciesB));
    }
    const img = el.querySelector('img.battle-sprite');
    // Reset previous state — sprite blob, animation transforms,
    // throwing flag — so a fresh encounter starts clean. Cancel any
    // lingering Web Animations first so their `fill:'forwards'`
    // contribution doesn't keep the sprite invisible / shrunk.
    if (_battleSpriteUrl && _battleSpriteUrlOwned) {
      URL.revokeObjectURL(_battleSpriteUrl);
    }
    _battleSpriteUrl = null;
    _battleSpriteUrlOwned = false;
    cancelAnimsOn(img);
    img.removeAttribute('src');
    img.style.transform = '';
    img.style.opacity = '';
    el.classList.remove('battle-sprite-ready');
    el.classList.remove('throwing');
    const ballEl = el.querySelector('.battle-thrown-ball');
    if (ballEl) {
      cancelAnimsOn(ballEl);
      ballEl.setAttribute('hidden', '');
      ballEl.style.transform = '';
      ballEl.style.opacity = '';
      ballEl.querySelectorAll('.ball-half').forEach((half) => {
        cancelAnimsOn(half);
        half.removeAttribute('src');
        half.style.transform = '';
        half.style.opacity = '';
      });
      const seamGlowEl = ballEl.querySelector('.ball-seam-glow');
      if (seamGlowEl) {
        cancelAnimsOn(seamGlowEl);
        seamGlowEl.style.opacity = '';
        seamGlowEl.style.transform = '';
      }
    }
    const flashEl = el.querySelector('.battle-flash');
    if (flashEl) {
      cancelAnimsOn(flashEl);
      flashEl.setAttribute('hidden', '');
      flashEl.removeAttribute('src');
      flashEl.style.opacity = '';
    }
    const burstEl = el.querySelector('.battle-burst');
    if (burstEl) {
      cancelAnimsOn(burstEl);
      burstEl.setAttribute('hidden', '');
      burstEl.style.opacity = '';
    }
    populateBattleBalls();

    // If the marker for this spawn already has a loaded sprite, reuse
    // the same URL — same blob in memory, browser uses its decoded
    // image cache, no flash. Only fall back to a fresh IDB fetch when
    // the marker hasn't loaded yet (first paint, or sprite missing).
    const rec = _markers.get(spawn.id);
    if (rec && rec.objectUrl) {
      _battleSpriteUrl = rec.objectUrl;
      _battleSpriteUrlOwned = false;
      img.onload = () => { el.classList.add('battle-sprite-ready'); };
      img.src = rec.objectUrl;
    } else if (global.Sprites) {
      // Prefer the variant cached on the marker record (resolved when
      // the marker first painted) — saves a getCellVariantCount round-
      // trip to IDB. Fall back to re-resolving when the marker hasn't
      // loaded yet (e.g. user tapped before paint).
      const variantPromise = (rec && 'variant' in rec)
        ? Promise.resolve(rec.variant)
        : resolveSpawnVariant(spawn);
      variantPromise
        .then((variant) => global.Sprites.getSpriteUrl(spawn.speciesA, spawn.speciesB, variant))
        .then((url) => {
          if (!url || _currentBattleSpawn !== spawn) {
            if (url) URL.revokeObjectURL(url);
            return;
          }
          _battleSpriteUrl = url;
          _battleSpriteUrlOwned = true;
          img.onload = () => { el.classList.add('battle-sprite-ready'); };
          img.src = url;
        });
    }
    el.classList.add('show');
  }

  function closeBattleScreen() {
    const el = document.getElementById('battleScreen');
    if (el) el.classList.remove('show');
    if (_battleSpriteUrl && _battleSpriteUrlOwned) {
      URL.revokeObjectURL(_battleSpriteUrl);
    }
    _battleSpriteUrl = null;
    _battleSpriteUrlOwned = false;
    _currentBattleSpawn = null;
  }

  // Add the spawn to the inventory + side effects (candy, mark caught,
  // remove marker, request storage persistence). Returns the new
  // capture entry — the caller decides whether to close the battle
  // screen and/or open the inventory detail view.
  async function recordCaptureFromSpawn(spawn) {
    const poiApi = global.CreatureCollectAPI;
    const poi = (poiApi && poiApi.findNearestNamedPoi)
      ? poiApi.findNearestNamedPoi(spawn.lat, spawn.lng)
      : null;
    // Capture the variant the player saw at the moment of catching,
    // so the inventory always shows that exact sprite even if the
    // per-cell variant table later changes (e.g., new artist sheets).
    // Reuses the marker record's cached variant when present.
    const rec = _markers.get(spawn.id);
    const variant = (rec && 'variant' in rec)
      ? rec.variant
      : await resolveSpawnVariant(spawn);
    const entry = {
      id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      spawnId: spawn.id,
      speciesA: spawn.speciesA,
      speciesB: spawn.speciesB,
      variant,
      level: spawn.level,
      sizeM: spawn.sizeM,
      caughtAt: {
        timestamp: Date.now(),
        lat: spawn.lat,
        lng: spawn.lng,
        poi: poi || null,
      },
    };
    const list = readCapturedCreatures();
    list.push(entry);
    writeCapturedCreatures(list);
    awardCandyForCapture(spawn.speciesA, spawn.speciesB);
    markSpawnCaught(spawn.id);
    removeMarker(spawn.id);
    if (list.length === 1 && navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    return entry;
  }

  // Render the ball-button strip in the battle screen based on the
  // current bag. One button per throwable ball type the user has at
  // least one of. Empty bag → "no pokéballs" message (flee only).
  function populateBattleBalls() {
    const battleEl = document.getElementById('battleScreen');
    if (!battleEl) return;
    const container = battleEl.querySelector('.battle-balls');
    if (!container) return;
    const bag = readBag();
    const owned = THROWABLE_BALL_KEYS.filter((k) => (bag[k] || 0) > 0);
    if (!owned.length) {
      container.innerHTML = `<div class="battle-no-balls">No pokéballs left — flee!</div>`;
      return;
    }
    container.innerHTML = owned.map((k) => {
      const meta = ITEMS[k] || { name: k, icon: '' };
      return `<button type="button" class="battle-ball-btn" data-ball="${escapeHtml(k)}">
        ${meta.icon ? `<img src="${escapeHtml(meta.icon)}" alt="${escapeHtml(meta.name)}">` : ''}
        <span class="ball-count">×${bag[k]}</span>
      </button>`;
    }).join('');
    container.querySelectorAll('.battle-ball-btn').forEach((btn) => {
      btn.addEventListener('click', () => throwBall(btn.dataset.ball, btn));
    });
  }

  // Web Animations API persists final keyframe state via fill:'forwards'
  // even after .finished resolves — setting style.transform = '' won't
  // override it. Cancelling the animation strips its contribution.
  function cancelAnimsOn(el) {
    if (!el || !el.getAnimations) return;
    for (const a of el.getAnimations()) { try { a.cancel(); } catch {} }
  }

  function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Animation flow for throwing a ball at the current spawn:
  //  1. Consume the ball from the bag.
  //  2. Suck-in: creature shrinks + fades, ball pops in at center,
  //     white flash overlay pulses.
  //  3. Roll outcome: per-shake stay-closed rate × 3, count successes.
  //     3 successes = caught; otherwise break out at the failed shake.
  //  4. Wobble the ball N times (N = successful shakes).
  //  5a. Caught → brief celebration flash → record capture →
  //      close battle → open inventory detail for the new entry.
  //  5b. Break out → ball pops open with flash → creature reappears →
  //      re-enable buttons (and re-render in case bag is now empty).
  async function throwBall(ballKey, sourceBtn) {
    const spawn = _currentBattleSpawn;
    if (!spawn) return;
    const meta = ITEMS[ballKey];
    if (!meta) return;
    if (!consumeItem(ballKey, 1)) return;

    const battleEl = document.getElementById('battleScreen');
    if (!battleEl) return;
    battleEl.classList.add('throwing');

    const sprite = battleEl.querySelector('img.battle-sprite');
    const ball = battleEl.querySelector('.battle-thrown-ball');
    const flash = battleEl.querySelector('.battle-flash');
    const wrap = battleEl.querySelector('.battle-sprite-wrap');
    if (!sprite || !ball || !flash || !wrap) {
      battleEl.classList.remove('throwing');
      return;
    }

    // Inner ball halves + seam-glow overlay. Both halves get the
    // same source SVG; their CSS clip-paths render only the top
    // half / bottom half regions so the ball can physically open
    // (top flips up) on break-out.
    const ballTop = ball.querySelector('.ball-top');
    const ballBottom = ball.querySelector('.ball-bottom');
    const seamGlow = ball.querySelector('.ball-seam-glow');

    // Cancel any leftover keyframe contributions before re-using
    // these elements (otherwise a previous fill:'forwards' value
    // persists and the new keyframes won't appear to apply).
    cancelAnimsOn(sprite);
    cancelAnimsOn(ball);
    cancelAnimsOn(ballTop);
    cancelAnimsOn(ballBottom);
    cancelAnimsOn(seamGlow);
    cancelAnimsOn(flash);

    // Reset inline transforms / opacity / src from the previous throw.
    sprite.style.transform = '';
    sprite.style.opacity = '';
    if (meta.icon) {
      if (ballTop)    ballTop.src = meta.icon;
      if (ballBottom) ballBottom.src = meta.icon;
    }
    if (ballTop) {
      ballTop.style.transform = '';
      ballTop.style.opacity = '';
    }
    if (ballBottom) {
      ballBottom.style.transform = '';
      ballBottom.style.opacity = '';
    }
    if (seamGlow) {
      seamGlow.style.opacity = '';
      seamGlow.style.transform = '';
    }
    // Silhouette flash mirrors the sprite's image (white-tinted via
    // CSS filter) so the flash takes the creature's outline.
    if (sprite.src) flash.src = sprite.src;

    // Compute starting offset of the ball: the button's center
    // expressed relative to the ball's natural resting position
    // (the sprite-wrap's bottom-center). The ball's natural
    // transform is translateX(-50%); JS adds tx/ty deltas + scale
    // + rotation on top. Falls back to a small puff-in if no
    // button rect is available.
    let startTransform = 'translateX(-50%) scale(0.4)';
    let arcKeyframes = null;
    if (sourceBtn && sourceBtn.getBoundingClientRect) {
      const br = sourceBtn.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      const ballH = ball.offsetHeight || 48;
      const ballNaturalCx = wr.left + wr.width / 2;
      const ballNaturalCy = wr.bottom - ballH / 2;
      const dx = (br.left + br.width / 2)  - ballNaturalCx;
      const dy = (br.top  + br.height / 2) - ballNaturalCy;
      // Bowed throw path: a quadratic Bézier whose control point is
      // pushed toward the nearer screen edge AND well above the
      // straight-line midpoint. We sample the curve at many offsets
      // so the path reads as a smooth "(" rather than the |-shape
      // you get from a single midpoint keyframe.
      const startCx = br.left + br.width / 2;
      const viewportCx = window.innerWidth / 2;
      const outwardSign = startCx < viewportCx ? -1 : 1;
      const outwardKick = Math.max(120, window.innerWidth * 0.28);
      const arcLift = Math.max(80, Math.abs(dy) * 0.55);
      // Control point of the Bézier (NOT a point on the curve — the
      // curve at t=0.5 lands at 0.25*P0 + 0.5*P1 + 0.25*P2).
      const ctrlX = dx * 0.5 + outwardSign * outwardKick;
      const ctrlY = dy * 0.5 - arcLift;
      startTransform =
        `translateX(calc(-50% + ${dx.toFixed(1)}px)) translateY(${dy.toFixed(1)}px) scale(0.6)`;
      const steps = 14;
      arcKeyframes = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        const px = u * u * dx + 2 * u * t * ctrlX + t * t * 0;
        const py = u * u * dy + 2 * u * t * ctrlY + t * t * 0;
        const sc = 0.6 + t * 0.4;
        arcKeyframes.push({
          offset: t,
          transform: `translateX(calc(-50% + ${px.toFixed(1)}px)) translateY(${py.toFixed(1)}px) scale(${sc.toFixed(2)})`,
          opacity: 1,
          easing: 'linear',
        });
      }
    }
    ball.style.transform = startTransform;
    ball.style.opacity = '1';
    ball.removeAttribute('hidden');
    flash.removeAttribute('hidden');

    // Stage 0: arc the ball from button to the base of the creature.
    // Many sample keyframes traced along a quadratic Bézier so the
    // path reads as a smooth curve. Per-keyframe linear easing keeps
    // velocity continuous through every sample (no mid-flight stall).
    const arcFrames = arcKeyframes || [
      { transform: startTransform, opacity: 0 },
      { transform: 'translateX(-50%) scale(1)', opacity: 1 },
    ];
    const arc = ball.animate(arcFrames,
      { duration: 650, easing: 'cubic-bezier(0.4, 0.1, 0.5, 1)', fill: 'forwards' });
    await arc.finished.catch(() => {});

    // Stage 1: suck-in. Creature shrinks + fades, silhouette flash
    // pulses (the ball is already at center from the arc).
    const creatureOut = sprite.animate(
      [
        { transform: 'scale(1)', opacity: 1 },
        { transform: 'scale(0)', opacity: 0 },
      ],
      { duration: 280, easing: 'ease-in', fill: 'forwards' });
    const flashIn = flash.animate(
      [{ opacity: 0 }, { opacity: 0.85 }, { opacity: 0 }],
      { duration: 320 });
    await Promise.all([
      creatureOut.finished, flashIn.finished,
    ].map((p) => p.catch(() => {})));
    flash.setAttribute('hidden', '');
    await delay(80);

    // Stage 2: outcome decision (random 0-3 successful shakes).
    const rate = meta.catchShakeRate || 0.65;
    let shakes = 0;
    for (let i = 0; i < 3; i++) {
      if (Math.random() < rate) shakes++;
      else break;
    }
    const caught = shakes === 3;

    // Stage 3: wobble for each successful shake. Each shake is a
    // full back-and-forth — center → lead direction → opposite →
    // center — with the leading direction alternating per shake so
    // the rocking pattern reads as a physical struggle rather than
    // identical motions. Per-keyframe easing makes the swings feel
    // weighted: ease-out into each peak (the ball "falls" into the
    // tilt under gravity) then ease-in coming back through center.
    // Long delay BETWEEN shakes (vs. quick wobble itself) is what
    // builds suspense — same trick the real games use.
    const PEAK_DEG = 22;
    for (let i = 0; i < shakes; i++) {
      const lead = (i % 2 === 0) ? -1 : 1;
      const wobble = ball.animate(
        [
          { offset: 0,    transform: 'translateX(-50%) rotate(0deg)',
            easing: 'cubic-bezier(0.4, 0.0, 0.6, 1)' },
          { offset: 0.30, transform: `translateX(-50%) rotate(${lead * PEAK_DEG}deg)`,
            easing: 'cubic-bezier(0.4, 0.0, 0.6, 1)' },
          { offset: 0.70, transform: `translateX(-50%) rotate(${-lead * PEAK_DEG}deg)`,
            easing: 'cubic-bezier(0.4, 0.0, 0.6, 1)' },
          { offset: 1,    transform: 'translateX(-50%) rotate(0deg)' },
        ],
        { duration: 380 });
      await wobble.finished.catch(() => {});
      // Suspense pause — longer than the wobble itself.
      await delay(320);
    }

    const burst = battleEl.querySelector('.battle-burst');
    if (caught) {
      // Stage 4a: caught! The "click + lock" moment. Seam-glow
      // pulses (the line + center button glowing white-gold) +
      // a small celebratory ball squish. Warm gold radial burst
      // behind it. NO silhouette flash — the creature is sealed
      // inside; showing its outline again would read as "back out".
      if (burst) {
        burst.style.setProperty('--burst-color', 'rgba(255, 220, 130, 0.95)');
        burst.removeAttribute('hidden');
        burst.animate(
          [{ opacity: 0 }, { opacity: 0.9, offset: 0.4 }, { opacity: 0 }],
          { duration: 540, easing: 'ease-out' });
      }
      if (seamGlow) {
        seamGlow.animate(
          [
            { opacity: 0, transform: 'scale(0.85)' },
            { opacity: 1, transform: 'scale(1.25)', offset: 0.45 },
            { opacity: 0, transform: 'scale(1.6)' },
          ],
          { duration: 540, easing: 'ease-out' });
      }
      const ding = ball.animate(
        [
          { transform: 'translateX(-50%) scale(1) rotate(0deg)' },
          { transform: 'translateX(-50%) scale(1.15) rotate(0deg)', offset: 0.35 },
          { transform: 'translateX(-50%) scale(0.96) rotate(0deg)', offset: 0.7 },
          { transform: 'translateX(-50%) scale(1) rotate(0deg)' },
        ],
        { duration: 540, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
      await ding.finished.catch(() => {});
      if (burst) burst.setAttribute('hidden', '');
      const entry = await recordCaptureFromSpawn(spawn);
      closeBattleScreen();
      show();
      showDetail(entry.id);
    } else {
      // Stage 4b: break out. Sequence:
      //   1) Cool white burst radiates from the ball — the
      //      "energy release" moment.
      //   2) The ball physically splits — top half flips up + back
      //      and fades, bottom half drops slightly + fades.
      //   3) Silhouette flash + creature scales back in (the
      //      classic "white outline solidifying into the creature").
      // Step 1: burst.
      if (burst) {
        burst.style.setProperty('--burst-color', 'rgba(255, 255, 255, 0.95)');
        burst.removeAttribute('hidden');
        burst.animate(
          [{ opacity: 0 }, { opacity: 0.95, offset: 0.3 }, { opacity: 0 }],
          { duration: 320, easing: 'ease-out' });
      }
      // Step 2: physically split the ball. Top half rotates around
      // its own center (which is at the seam — the center of the
      // outer container) and lifts; bottom half drops a touch and
      // fades. Outer container also drifts up so both halves move
      // together while separating.
      const drift = ball.animate(
        [
          { transform: 'translateX(-50%) translateY(0) scale(1)' },
          { transform: 'translateX(-50%) translateY(-12px) scale(1.05)' },
        ],
        { duration: 300, easing: 'ease-out', fill: 'forwards' });
      // Top-half "lid hinge": rotateX flips it backward (its top
       // edge tilts away from the camera) while it lifts up. Pivot
       // is the element's own center, which is the seam location.
       // Combined with perspective on the parent, it reads as a
       // lid swinging open straight up rather than sideways.
      const topOpen = ballTop ? ballTop.animate(
        [
          { transform: 'translateY(0) rotateX(0deg)', opacity: 1 },
          { transform: 'translateY(-22px) rotateX(-95deg)', opacity: 0 },
        ],
        { duration: 320, easing: 'ease-out', fill: 'forwards' }) : null;
      const bottomDrop = ballBottom ? ballBottom.animate(
        [
          { transform: 'translateY(0)', opacity: 1 },
          { transform: 'translateY(8px)',  opacity: 0 },
        ],
        { duration: 300, easing: 'ease-out', fill: 'forwards' }) : null;
      // Step 3: silhouette flash + creature scales back in (start
      // overlapping with the ball split so the transition feels
      // continuous).
      flash.removeAttribute('hidden');
      flash.animate(
        [{ opacity: 0 }, { opacity: 0.7, offset: 0.4 }, { opacity: 0 }],
        { duration: 320 });
      const back = sprite.animate(
        [
          { transform: 'scale(0)', opacity: 0 },
          { transform: 'scale(1)', opacity: 1 },
        ],
        { duration: 300, easing: 'cubic-bezier(0.34, 1.4, 0.64, 1)', fill: 'forwards' });
      await Promise.all([
        drift.finished,
        topOpen ? topOpen.finished : Promise.resolve(),
        bottomDrop ? bottomDrop.finished : Promise.resolve(),
        back.finished,
      ].map((p) => p.catch(() => {})));
      // Strip lingering Web Animations fill state from the throw
      // so the next throw's keyframes start from a clean slate.
      cancelAnimsOn(ball);
      cancelAnimsOn(ballTop);
      cancelAnimsOn(ballBottom);
      cancelAnimsOn(seamGlow);
      cancelAnimsOn(sprite);
      cancelAnimsOn(flash);
      cancelAnimsOn(burst);
      flash.setAttribute('hidden', '');
      if (burst) burst.setAttribute('hidden', '');
      ball.setAttribute('hidden', '');
      ball.style.transform = '';
      ball.style.opacity = '';
      if (ballTop)    { ballTop.style.transform = '';    ballTop.style.opacity = ''; }
      if (ballBottom) { ballBottom.style.transform = ''; ballBottom.style.opacity = ''; }
      if (seamGlow)   { seamGlow.style.opacity = '';     seamGlow.style.transform = ''; }
      sprite.style.transform = '';
      sprite.style.opacity = '';
      battleEl.classList.remove('throwing');
      // Refresh ball list — we just spent one, may have hit zero.
      populateBattleBalls();
    }
  }

  // Wire an already-fetched blob into a marker record. Extracted so
  // both the single-marker path (loadMarkerSprite) and the bulk path
  // (addMarkersBatch) can share the DOM-update + URL-lifecycle code.
  function _logCreatureError(where, err) {
    window._spriteDiag = window._spriteDiag || {};
    window._spriteDiag.errorCount = (window._spriteDiag.errorCount || 0) + 1;
    window._spriteDiag.errors = window._spriteDiag.errors || [];
    if (window._spriteDiag.errors.length < 10) {
      const msg = (err && err.message) ? err.message : String(err);
      window._spriteDiag.errors.push(`${where}: ${msg}`);
    }
  }

  function installSpriteBlob(record, blob) {
    try {
      if (!blob) return;
      if (!_markers.has(record.spawn.id) || _markers.get(record.spawn.id) !== record) return;
      const el = record.marker.getElement();
      const img = el.querySelector('img.creature-sprite');
      if (!img) return;
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        el.classList.add('creature-marker-ready');
        window._spriteDiag = window._spriteDiag || {};
        if (window._spriteDiag.firstSpriteVisibleAt == null) {
          window._spriteDiag.firstSpriteVisibleAt = performance.now();
        }
      };
      img.onerror = (e) => {
        _logCreatureError(`installSpriteBlob/img.onerror/${record.spawn.speciesA}-${record.spawn.speciesB}`,
          (e && e.message) || 'image decode failed');
      };
      record.objectUrl = url;
      img.src = url;
      window._spriteDiag = window._spriteDiag || {};
      if (window._spriteDiag.firstSpriteInstallAt == null) {
        window._spriteDiag.firstSpriteInstallAt = performance.now();
      }
    } catch (e) {
      _logCreatureError('installSpriteBlob', e);
    }
  }

  function loadMarkerSprite(record) {
    if (!global.Sprites) return;
    const { spawn } = record;
    resolveSpawnVariant(spawn)
      .then((variant) => {
        record.variant = variant;
        if (!_markers.has(spawn.id) || _markers.get(spawn.id) !== record) return null;
        return global.Sprites.getSpriteBlob(spawn.speciesA, spawn.speciesB, variant);
      })
      .then((blob) => { installSpriteBlob(record, blob); })
      .catch((e) => {
        _logCreatureError(`loadMarkerSprite/${spawn.speciesA}-${spawn.speciesB}`, e);
      });
  }

  function addMarker(spawn) {
    if (!_overlayMap || !global.maplibregl) return null;
    const el = makeMarkerElement(spawn);
    const marker = new global.maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([spawn.lng, spawn.lat])
      .addTo(_overlayMap);
    const record = { marker, objectUrl: null, spawn, firstShownAt: Date.now() };
    _markers.set(spawn.id, record);
    // Diagnostic — record when the very first spawn DOM marker is
    // attached to the map, distinct from when its sprite finishes
    // loading. Useful for telling "GPS was slow" from "sprite IDB
    // was slow" in the Settings phase readout.
    if (typeof window !== 'undefined') {
      window._startupPhases = window._startupPhases || {};
      if (window._startupPhases.firstSpawnMarker == null) {
        window._startupPhases.firstSpawnMarker = performance.now();
      }
    }
    return record;
  }

  // Bulk add: place all markers in a single layout pass, then resolve
  // every variant + fetch every sprite blob in ONE IDB transaction
  // (Sprites.getSpriteBlobsBatch). On iOS Safari this turns ~50 separate
  // serialized transactions into one pipelined one — pokémon icons
  // appear in a single frame instead of staggering over seconds.
  async function addMarkersBatch(spawns) {
    try {
      if (!spawns.length) return;
      const records = [];
      for (const s of spawns) {
        try {
          const rec = addMarker(s);
          if (rec) records.push({ rec, spawn: s });
        } catch (e) {
          _logCreatureError(`addMarkersBatch/addMarker/${s.id}`, e);
        }
      }
      if (!global.Sprites || !global.Sprites.getSpriteBlobsBatch) {
        for (const { rec } of records) loadMarkerSprite(rec);
        return;
      }
      // Pre-batch the variant-count IDB reads into ONE transaction
      // — without this, 50 concurrent resolveSpawnVariant calls
      // open 50 separate iOS IDB transactions (slow). With the
      // summary blob loaded this is all in-memory anyway; without
      // it, this is one pipelined read.
      let variants;
      try {
        if (global.Sprites && global.Sprites.getCellVariantCountsBatch) {
          const cells = records.map(({ spawn }) => [spawn.speciesA, spawn.speciesB]);
          await global.Sprites.getCellVariantCountsBatch(cells);
        }
        variants = await Promise.all(
          records.map(({ spawn }) =>
            resolveSpawnVariant(spawn).catch((e) => {
              _logCreatureError(`addMarkersBatch/resolveVariant/${spawn.id}`, e);
              return null;
            }))
        );
      } catch (e) {
        _logCreatureError('addMarkersBatch/Promise.all(resolveSpawnVariant)', e);
        variants = records.map(() => null);
      }
      const requests = records.map(({ spawn }, i) => ({
        a: spawn.speciesA, b: spawn.speciesB, variant: variants[i], key: spawn.id,
      }));
      records.forEach((r, i) => { r.rec.variant = variants[i]; });
      let results;
      try {
        results = await global.Sprites.getSpriteBlobsBatch(requests);
      } catch (e) {
        _logCreatureError('addMarkersBatch/getSpriteBlobsBatch', e);
        return;
      }
      for (let i = 0; i < records.length; i++) {
        try {
          installSpriteBlob(records[i].rec, results[i] && results[i].blob);
        } catch (e) {
          _logCreatureError(`addMarkersBatch/install/${records[i].spawn.id}`, e);
        }
      }
    } catch (e) {
      _logCreatureError('addMarkersBatch/outer', e);
    }
  }

  function removeMarker(id) {
    const rec = _markers.get(id);
    if (!rec) return;
    rec.marker.remove();
    if (rec.objectUrl) URL.revokeObjectURL(rec.objectUrl);
    _markers.delete(id);
  }

  function clearMarkers() {
    for (const id of Array.from(_markers.keys())) removeMarker(id);
  }

  function refreshSpawnOverlay() {
    if (!_overlayMap || !global.Spawns) return;
    // Without a GPS fix we can't compute distance — clear any existing
    // markers rather than leaving stale ones from a previous fix.
    if (_userLat == null || _userLng == null) {
      if (_markers.size) clearMarkers();
      _lastRefreshLat = _lastRefreshLng = null;
      _lastRefreshAt = 0;
      return;
    }
    const now = Date.now();
    const moved = _lastRefreshLat == null
      || metersBetween(_userLat, _userLng, _lastRefreshLat, _lastRefreshLng) > 1;
    if (!moved && now - _lastRefreshAt < REFRESH_MIN_GAP_MS) return;
    _lastRefreshLat = _userLat;
    _lastRefreshLng = _userLng;
    _lastRefreshAt = now;

    const padM = VISIBILITY_RADIUS_M + 15;
    const latPad = padM / 111000;
    const lngPad = padM / (111000 * Math.cos(_userLat * Math.PI / 180));
    const bbox = [
      _userLng - lngPad, _userLat - latPad,
      _userLng + lngPad, _userLat + latPad,
    ];
    pruneCaughtSpawnIds();
    const caught = readCaughtSpawnIds();
    const spawns = global.Spawns.spawnsInBbox(bbox);
    const within = spawns.filter((s) =>
      !caught.has(s.id)
      && metersBetween(_userLat, _userLng, s.lat, s.lng) <= VISIBILITY_RADIUS_M
    );

    // Reconcile markers: keep existing ids, add new ones, drop stale
    // ones — but only if they've been visible for at least
    // MIN_DISPLAY_MS. Markers younger than that are TTL-protected so
    // GPS jitter can't yank them before the user has a chance to tap.
    // The soonest TTL expiry is used to schedule a deferred refresh
    // so a stuck marker eventually gets removed even if the user is
    // standing still (no GPS movement → no natural refresh trigger).
    const wanted = new Set(within.map((s) => s.id));
    if (_deferredRefreshTimer != null) {
      clearTimeout(_deferredRefreshTimer);
      _deferredRefreshTimer = null;
    }
    let soonestRemovableAt = Infinity;
    for (const id of Array.from(_markers.keys())) {
      if (wanted.has(id)) continue;
      const rec = _markers.get(id);
      const removableAt = (rec.firstShownAt || 0) + MIN_DISPLAY_MS;
      if (now >= removableAt) {
        removeMarker(id);
      } else if (removableAt < soonestRemovableAt) {
        soonestRemovableAt = removableAt;
      }
    }
    // Bulk-fetch sprites for any spawns we don't yet have markers for —
    // single IDB transaction instead of one per marker.
    const newSpawns = within.filter((s) => !_markers.has(s.id));
    if (newSpawns.length) addMarkersBatch(newSpawns);
    if (soonestRemovableAt !== Infinity) {
      // Re-run after the soonest TTL-protected marker becomes
      // removable. Bypasses dedupe by zeroing _lastRefreshAt before
      // calling, so the refresh runs even if the user is stationary.
      const delay = Math.max(50, soonestRemovableAt - now + 50);
      _deferredRefreshTimer = setTimeout(() => {
        _deferredRefreshTimer = null;
        _lastRefreshAt = 0;
        refreshSpawnOverlay();
      }, delay);
    }
  }

  // Don't render pokemon based on a coarse first fix (typically Wi-Fi
  // or cell-tower triangulation, accurate to 50-200 m). The resulting
  // markers would be in the wrong place and vanish once the real GPS
  // fix arrives a few seconds later — disappointing if the user spots
  // a cool one and goes to tap it. After the deadline we give up
  // waiting and accept whatever accuracy we have, so users in
  // low-signal areas still see something eventually.
  const FIRST_FIX_MIN_ACCURACY_M = 50;
  const FIRST_FIX_TIMEOUT_MS = 5000;
  let _firstFixDeadline = 0;

  function startLocationWatch() {
    if (_geoWatchId != null || !navigator.geolocation) return;
    _firstFixDeadline = Date.now() + FIRST_FIX_TIMEOUT_MS;
    _geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const acc = pos.coords.accuracy;
        if (_userLat == null
            && acc != null
            && acc > FIRST_FIX_MIN_ACCURACY_M
            && Date.now() < _firstFixDeadline) {
          return;
        }
        _userLat = pos.coords.latitude;
        _userLng = pos.coords.longitude;
        refreshSpawnOverlay();
      },
      () => { /* ignore — user may have denied permission */ },
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
  }

  function stopLocationWatch() {
    if (_geoWatchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(_geoWatchId);
    }
    _geoWatchId = null;
    _userLat = null;
    _userLng = null;
    _firstFixDeadline = 0;
  }

  function updateMarkerScale() {
    if (!_overlayMap) return;
    const z = _overlayMap.getZoom();
    const raw = MARKER_SIZE_PX * Math.pow(2, z - MARKER_REF_ZOOM);
    const px = Math.max(MARKER_MIN_PX, Math.min(MARKER_MAX_PX, raw));
    document.documentElement.style.setProperty('--creature-marker-size', `${px.toFixed(1)}px`);
  }

  let _zoomHandler = null;

  function attachSpawnOverlay(map) {
    if (_overlayMap === map) return;
    _overlayMap = map;
    startLocationWatch();
    updateMarkerScale();
    _zoomHandler = updateMarkerScale;
    map.on('zoom', _zoomHandler);
    // Safety net for tick rollover — GPS updates drive most refreshes,
    // but a stationary user still needs new births / expiries to land
    // promptly. Dedupe in refresh keeps this near-free when nothing
    // has changed.
    _overlayTimer = setInterval(refreshSpawnOverlay, 20 * 1000);
  }

  function detachSpawnOverlay() {
    if (!_overlayMap) return;
    clearMarkers();
    if (_overlayTimer) clearInterval(_overlayTimer);
    if (_overlayPopup) _overlayPopup.remove();
    if (_zoomHandler) _overlayMap.off('zoom', _zoomHandler);
    stopLocationWatch();
    _overlayMap = null;
    _overlayTimer = null;
    _overlayPopup = null;
    _zoomHandler = null;
    _lastRefreshLat = _lastRefreshLng = null;
    _lastRefreshAt = 0;
  }

  class CreatureBallControl {
    onAdd() {
      const c = document.createElement('div');
      c.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      this._root = c;
      const b = document.createElement('button');
      b.type = 'button';
      b.title = 'creatures';
      b.setAttribute('aria-label', 'creatures');
      // Generic monster-ball: a circle with an equator and a small center
      // dot. Deliberately not a pokeball — this project is its own thing.
      b.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" style="display:block;margin:auto">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/>
        <path d="M3 12h18" stroke="currentColor" stroke-width="1.8" fill="none"/>
        <circle cx="12" cy="12" r="2.5" fill="var(--ui-bg, #fff)" stroke="currentColor" stroke-width="1.8"/>
      </svg>`;
      b.onclick = () => show();
      c.appendChild(b);
      c.style.display = readEnabled() ? '' : 'none';
      return c;
    }
    onRemove() {
      if (this._root && this._root.parentNode) {
        this._root.parentNode.removeChild(this._root);
      }
      this._root = null;
    }
    setVisible(on) {
      if (this._root) this._root.style.display = on ? '' : 'none';
      if (!on) hide();
    }
  }

  // Map reference captured at install so the inventory's "go to caught
  // location" links can fly the camera independent of whether the spawn
  // overlay (creature mode) is currently attached.
  let _installedMap = null;

  function flyToCaughtLocation(lat, lng) {
    if (!_installedMap || lat == null || lng == null) return;
    const targetZoom = Math.max(_installedMap.getZoom(), 17);
    _installedMap.flyTo({ center: [lng, lat], zoom: targetZoom });
    hide();
  }

  function install(map) {
    injectStyles();
    backfillSeenFromCaptures();
    // Fire-and-forget: backfills the `variant` field on legacy
    // captures (and seedFusions[key].variants) on first load with
    // this code. Idempotent via localStorage flag.
    migrateLegacyCaptureVariants().catch(() => {});
    // Pre-warm SPLIT_NAMES into memory so synchronous `getFusedName`
    // returns the proper canonical name on first paint. No-op when
    // the table isn't downloaded yet — display falls back to "A × B".
    if (global.Sprites && global.Sprites.ensureSplitNamesLoaded) {
      global.Sprites.ensureSplitNamesLoaded().catch(() => {});
    }
    _installedMap = map;
    const ctrl = new CreatureBallControl();
    map.addControl(ctrl, 'bottom-right');
    if (readEnabled()) attachSpawnOverlay(map);
    return {
      setEnabled(on) {
        writeEnabled(on);
        ctrl.setVisible(on);
        if (on) attachSpawnOverlay(map);
        else detachSpawnOverlay();
      },
      isEnabled: readEnabled,
      show,
      hide,
    };
  }

  // Pick a uniform-random item key from the pokéstop loot table.
  // Exposed so the POI "Collect items" handler in index.html can
  // sample without needing the catalog details.
  function rollCollectibleItem() {
    if (!COLLECTIBLE_ITEM_KEYS.length) return null;
    const i = Math.floor(Math.random() * COLLECTIBLE_ITEM_KEYS.length);
    return COLLECTIBLE_ITEM_KEYS[i];
  }
  function getItemMeta(key) { return ITEMS[key] || null; }
  global.Creatures = {
    install, isEnabled: readEnabled,
    getCandy: readCandy, getBag: readBag, getTags: readTags,
    grantItem, consumeItem, rollCollectibleItem, getItemMeta,
    timeSinceLastSave,
  };
})(typeof window !== 'undefined' ? window : globalThis);
