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

  // The 'auto' placeholder is rewritten by the server on every serve
  // with the file's mtime — see run.py's _stamp_js / _serve_stamped.
  // Settings compares this runtime value against /script-versions so
  // a stale browser cache surfaces as a visible mismatch.
  const SCRIPT_VERSION = 'auto';
  global._scriptVersions = global._scriptVersions || {};
  global._scriptVersions['creatures.js'] = SCRIPT_VERSION;

  // Mirrors sprites.js / appdata.js — BundledData lives under this
  // prefix on every platform: Flask catch-all on web, GCDWebServer
  // on iOS, WebViewAssetLoader on Android. Override via inline
  // `<script>window.CC_BUNDLED_DATA_BASE = ...</script>` in
  // index.html (e.g. to point at a CDN).
  const BUNDLED_BASE = (global.CC_BUNDLED_DATA_BASE || '/bundled-data')
    .replace(/\/$/, '');

  // Candy sprite-sheet geometry — kept in sync with
  // generate_candy_images.py (CANDY_PX = EGG_PX // 4 = 40,
  // CANDY_COLS = EGG_COLS = 10). Cell N is at column N % cols,
  // row N // cols, same indexing as eggs.png.
  const CANDY_CELL_PX = 40;
  const CANDY_SHEET_COLS = 10;
  // Row count must match (MAX_SPECIES // 10) + 1 in species_pool.py.
  // With MAX_SPECIES=429 the sheet is 43 rows × 40px = 1720px tall.
  // Bump this whenever the species set extends to a higher PIF id —
  // otherwise CSS background-size scales the sheet wrong and cells
  // land on the wrong rows.
  const CANDY_SHEET_ROWS = 43;

  const STORAGE_KEY = 'cc.creatureMode';
  // The captured collection and the seen-fusions pokédex used to live in
  // localStorage under these keys. They now live in IndexedDB (see the
  // CSTORE_* block below) because the collection grows past the ~5 MB
  // localStorage budget and was throwing QuotaExceededError on catch —
  // the catch then silently failed to persist (creature lost on reload)
  // and could be re-caught repeatedly. The keys are still referenced for
  // the one-time localStorage→IDB migration and the legacy read fallback.
  const CAPTURED_KEY = 'cc.capturedCreatures';
  const CAUGHT_SPAWNS_KEY = 'cc.caughtSpawnIds';
  const SEEN_FUSIONS_KEY = 'cc.seenFusions';

  // ── Collection store: IndexedDB ──────────────────────────────
  // A single key-value object store holding the two big blobs that no
  // longer fit in localStorage: the captured array and the seenFusions
  // map. IDB's quota is hundreds of MB–GB, so the collection can grow
  // without hitting the wall. Values are stored as live structured
  // objects (IDB structured-clone), not JSON strings — no parse/stringify
  // round-trip. Mirrors the tracker-DB helper pattern further down.
  const CSTORE_DB = 'creature-collection-v1';
  const CSTORE_DB_VERSION = 1;
  const CSTORE_STORE = 'kv';
  const CSTORE_CAPTURED = 'captured';
  const CSTORE_SEEN = 'seenFusions';

  let _cstoreDbPromise = null;
  function _openCStoreDb() {
    if (_cstoreDbPromise) return _cstoreDbPromise;
    _cstoreDbPromise = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(CSTORE_DB, CSTORE_DB_VERSION); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(CSTORE_STORE)) {
          db.createObjectStore(CSTORE_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _cstoreDbPromise;
  }
  function _cstoreGet(key) {
    return _openCStoreDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(CSTORE_STORE, 'readonly');
      const r = tx.objectStore(CSTORE_STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  }
  function _cstorePut(key, value) {
    return _openCStoreDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(CSTORE_STORE, 'readwrite');
      tx.objectStore(CSTORE_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  // Coalesced, last-write-wins async writer for one IDB key. Mutations
  // call schedule(); a single transaction is ever in flight, and if more
  // mutations land while a write is running the next flush picks up the
  // latest snapshot. No lost updates, no overlapping transactions, and a
  // failed write is logged (not thrown) so a catch can never abort on it.
  function _makeIdbWriter(key, getSnapshot) {
    let writing = false;
    let dirty = false;
    async function flush() {
      writing = true;
      try {
        while (dirty) {
          dirty = false;
          // getSnapshot() returns the live in-memory object; put() clones
          // it synchronously at call time, so this captures the latest
          // committed state.
          await _cstorePut(key, getSnapshot());
        }
      } catch (e) {
        _logCreatureError('cstore/write/' + key, e);
      } finally {
        writing = false;
      }
    }
    return function schedule() {
      dirty = true;
      if (!writing) flush();
    };
  }

  // Hydration gate. Reads stay synchronous (the stores cache everything
  // in memory); this preloads that cache from IDB once at boot, runs the
  // one-time localStorage→IDB migration, and only then lets writes touch
  // IDB (so an early write can't clobber not-yet-loaded data).
  let _cstoreHydrated = false;
  let _cstoreHydratePromise = null;
  function _safeLsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function _safeLsRemove(k) { try { localStorage.removeItem(k); } catch (_) {} }
  function _hydrateCStore() {
    if (_cstoreHydratePromise) return _cstoreHydratePromise;
    _cstoreHydratePromise = (async () => {
      let capIdb, seenIdb;
      try { capIdb = await _cstoreGet(CSTORE_CAPTURED); }
      catch (e) { _logCreatureError('cstore/hydrate/captured', e); }
      try { seenIdb = await _cstoreGet(CSTORE_SEEN); }
      catch (e) { _logCreatureError('cstore/hydrate/seen', e); }

      // Pick the source: IDB if present, else migrate from localStorage.
      let cap, capFromLs = false;
      if (Array.isArray(capIdb)) {
        cap = capIdb;
      } else {
        const raw = _safeLsGet(CAPTURED_KEY);
        let parsed = null;
        if (raw) { try { parsed = JSON.parse(raw); } catch { parsed = null; } }
        if (Array.isArray(parsed)) { cap = parsed; capFromLs = true; }
        else cap = [];
      }
      let seen, seenFromLs = false;
      if (seenIdb && typeof seenIdb === 'object') {
        seen = seenIdb;
      } else {
        const raw = _safeLsGet(SEEN_FUSIONS_KEY);
        let parsed = null;
        if (raw) { try { parsed = JSON.parse(raw); } catch { parsed = null; } }
        if (parsed && typeof parsed === 'object') { seen = parsed; seenFromLs = true; }
        else seen = {};
      }

      // Open the write gate now that we know what to load: from here on
      // user mutations may persist to IDB. loadFromArray itself doesn't
      // write — it returns whether legacy-variant normalization changed
      // anything, so we fold that into the single migration write below.
      _cstoreHydrated = true;
      const capDirty = _capStore.loadFromArray(cap);
      _seenStore.loadFromMap(seen);

      // Persist + free localStorage. We write IDB and only delete the LS
      // key after the write resolves, so a failed migration leaves the
      // original data intact in localStorage as a fallback.
      if (capFromLs || capDirty) {
        try {
          await _cstorePut(CSTORE_CAPTURED, _capStore.list());
          if (capFromLs) _safeLsRemove(CAPTURED_KEY);
        } catch (e) { _logCreatureError('cstore/migrate/captured', e); }
      }
      if (seenFromLs) {
        try {
          await _cstorePut(CSTORE_SEEN, _seenStore.get());
          _safeLsRemove(SEEN_FUSIONS_KEY);
        } catch (e) { _logCreatureError('cstore/migrate/seen', e); }
      }
    })();
    return _cstoreHydratePromise;
  }
  function _whenReady() { return _cstoreHydratePromise || _hydrateCStore(); }

  // ── Inventory + pokédex performance metrics ──
  // Counters + per-call timing for the hot functions that fire on
  // every search keystroke / filter chip toggle / sort change. Read
  // from the Settings diagnostic dump ([inventory perf] block in
  // index.html) to surface where the time is actually going as the
  // capture count grows.
  //
  // Overhead per wrapped call: one performance.now() pair + a few
  // arithmetic ops (~0.5-1 µs). Negligible vs. the work being timed.
  //
  // Each fn slot tracks { calls, totalMs, lastMs, maxMs } so the dump
  // can show avg = total/calls, last, and max. The per-render slots
  // additionally carry { lastBreakdown, recent[] } — a ring buffer of
  // the last 10 renders with their phase breakdown for outlier
  // investigation.
  const _INV_PERF_RING = 10;
  const _invPerf = {
    fn: {
      readCaptured:    { calls: 0, totalMs: 0, lastMs: 0, maxMs: 0, lastSize: 0 },
      readNicknames:   { calls: 0, totalMs: 0, lastMs: 0, maxMs: 0 },
      getInventory:    { calls: 0, totalMs: 0, lastMs: 0, maxMs: 0, lastSize: 0 },
      sortedCreatures: { calls: 0, totalMs: 0, lastMs: 0, maxMs: 0, lastSize: 0 },
      capStoreLoad:    { calls: 0, totalMs: 0, lastMs: 0, maxMs: 0, lastSize: 0 },
      variantIndex:    { calls: 0, totalMs: 0, lastMs: 0, maxMs: 0 },
      seenStoreLoad:   { calls: 0, totalMs: 0, lastMs: 0, maxMs: 0, lastSize: 0 },
      readSeenFusions: { calls: 0, totalMs: 0, lastMs: 0, maxMs: 0, lastSize: 0 },
      effectiveTags:   { calls: 0, totalMs: 0, lastMs: 0, maxMs: 0 },
    },
    // Per-built-in-tag stats. Keyed by tag name; populated right after
    // BUILTIN_TAGS is defined further down. builtinTagsForCreature
    // updates them per predicate call so we can see which tag is the
    // hot one in a filter pass.
    tagPredicates: {},
    // One slot for the tag-filter chunk of the inventory render. Lets
    // us isolate "the tag filter took X ms" from the total filterMs
    // (which also includes name + type + species filters).
    tagFilter: {
      calls: 0, totalMs: 0, lastMs: 0, maxMs: 0,
      lastInputN: 0, lastOutputN: 0, lastSelected: [],
    },
    renders: {
      list: {
        calls: 0, totalMs: 0, lastMs: 0, maxMs: 0,
        lastBreakdown: null, recent: [],
      },
      pokedex: {
        calls: 0, totalMs: 0, lastMs: 0, maxMs: 0,
        lastBreakdown: null, recent: [],
      },
      // Detail-view "tap to open" timing. totalMs = click → header
      // sprite ready (the moment the panel actually looks finished).
      // The breakdown carries each phase so we can see which segment
      // dominates: dispatch (click → renderDetail start), sync (body
      // construction), header sprite paint, slowest evo-row settle.
      detail: {
        calls: 0, totalMs: 0, lastMs: 0, maxMs: 0,
        lastBreakdown: null, recent: [],
      },
    },
  };
  if (typeof window !== 'undefined') window._invPerf = _invPerf;

  function _perfMark(slot, t0, extra) {
    const dt = performance.now() - t0;
    slot.calls++;
    slot.totalMs += dt;
    slot.lastMs = dt;
    if (dt > slot.maxMs) slot.maxMs = dt;
    if (extra) Object.assign(slot, extra);
    return dt;
  }
  function _perfMarkRender(slot, breakdown) {
    slot.calls++;
    slot.totalMs += breakdown.totalMs;
    slot.lastMs = breakdown.totalMs;
    if (breakdown.totalMs > slot.maxMs) slot.maxMs = breakdown.totalMs;
    slot.lastBreakdown = breakdown;
    slot.recent.push(breakdown);
    if (slot.recent.length > _INV_PERF_RING) slot.recent.shift();
  }

  // Idle-time scheduler. Used to defer non-critical sprite loads
  // (evo-row previews especially) until after the panel has actually
  // painted — the header sprite gets to fire first, then the evo
  // previews stream in instead of blocking initial paint.
  //
  // iOS 16.4+ ships requestIdleCallback. Older WebKit falls back to
  // setTimeout with a tiny delay — close enough to "after this frame"
  // for our purposes.
  function _scheduleIdle(fn) {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(fn, { timeout: 500 });
    } else {
      setTimeout(fn, 50);
    }
  }
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

  // Daycare distance tracker. Per-day "meters travelled" summary
  // and full GPS path are both persisted to IDB (creature-tracker-v1)
  // so the data is durable across SW cache evictions, included in
  // the user's export/import flow, and not bound by the localStorage
  // size budget. Local date keys (YYYY-MM-DD) so a midnight bucket
  // flip matches the user's actual day boundary, not UTC. Distances
  // accumulate ONLY while the app is open and the GPS watch is
  // delivering fixes — backgrounding/standby produces no data
  // (geolocation suspends), and we drop segments with large time
  // gaps so the next foreground fix isn't credited as travel.
  // Legacy localStorage key for the summary; read once on init for
  // migration to IDB, then dropped.
  const DAYCARE_LEGACY_LS_KEY = 'cc.daycareDistance.v1';
  // GPS-jitter / outlier filters for the distance accumulator.
  // 10 m matches phone GPS drift in open conditions (and what Pokémon
  // GO uses) — anything smaller is treated as the user standing still
  // with a wandering dot. These fixes are dropped from BOTH the daily
  // distance total and the recorded path so the route view stays
  // clean instead of being a cloud of dwell points.
  const DAYCARE_DIST_MIN_M     = 10;    // ignore < 10 m segments (jitter floor)
  const DAYCARE_DIST_MAX_GAP_MS = 60000;// drop segments after a >60 s gap
  const DAYCARE_DIST_MAX_SPEED  = 50;   // m/s (~180 km/h) — drop teleports
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
    test_orb: {
      name: 'Test Orb',
      desc: 'Placeholder daycare drop. Settings → "Repopulate daycare test loot" resets claimed indices so they reappear.',
      icon: '/static/test-orb.svg',
    },
  };

  // Format a PIF item identifier (FIRESTONE, KINGSROCK, LINKINGCORD)
  // into a human-readable display name (Fire Stone, Kings Rock,
  // Linking Cord). Used by both the evolution-method formatter and
  // the dynamic ITEMS-catalog registration for evo items below.
  function _formatItemName(s) {
    if (typeof s !== 'string') return String(s);
    // Common compound suffixes — split out so e.g. FIRESTONE renders
    // as "Fire Stone" rather than "Firestone".
    const tail = ['STONE', 'ROCK', 'SCALE', 'COAT', 'CHIP', 'SCROLL', 'CORD', 'DISC', 'CLOTH'];
    let s2 = s;
    for (const t of tail) {
      const re = new RegExp(`(\\w+)${t}$`, 'i');
      s2 = s2.replace(re, (_, w) => `${w} ${t}`);
    }
    return s2.toLowerCase()
      .split(/[\s_]+/)
      .map((p) => p ? p[0].toUpperCase() + p.slice(1) : '')
      .join(' ').trim();
  }

  // Register evolution-item bag entries derived from the bundled
  // evo-items/ directory. The set is intentionally hardcoded so the
  // module loads quickly without needing the bundle JSON in memory.
  // MUST stay in sync with data/BundledData/evo-items-list.json — i.e.
  // the PNGs that build-bundled-data.py actually ships under evo-items/.
  // (An out-of-sync list is why DUSKSTONE/DAWNSTONE/REAPERCLOTH had no
  // bag icons while phantom keys with no PNG were listed instead.) Each
  // gets a name, an icon URL pointing at the bundled PNG, and a desc —
  // slotting into the bag UI the same way poke_ball / great_ball do.
  const EVO_ITEM_KEYS = [
    'DAWNSTONE', 'DUSKSTONE', 'FIRESTONE', 'ICESTONE', 'LEAFSTONE',
    'LINKINGCORD', 'MAGNETSTONE', 'MOONSTONE', 'REAPERCLOTH', 'SHINYSTONE',
    'SUNSTONE', 'THUNDERSTONE', 'WATERSTONE',
  ];
  for (const key of EVO_ITEM_KEYS) {
    if (ITEMS[key]) continue;
    ITEMS[key] = {
      name: _formatItemName(key),
      desc: 'Evolution item — usable when the right pokémon is ready.',
      icon: `${BUNDLED_BASE}/evo-items/${key}.png`,
    };
  }
  // Fast membership test for bag ordering (see _bagEntryRank).
  const EVO_ITEM_SET = new Set(EVO_ITEM_KEYS);
  // Items the pokéstop "Collect items" button can grant. Each press
  // samples 1-3 items uniformly from this list (with replacement).
  const COLLECTIBLE_ITEM_KEYS = ['poke_ball', 'great_ball'];
  // Items the player can throw at a wild creature. Order here drives
  // the order they appear in the battle screen's ball list.
  const THROWABLE_BALL_KEYS = ['poke_ball', 'great_ball'];
  // Starter items granted on first-ever bag read (anyone who's played
  // before gets these too on next load).
  const STARTER_BAG = { poke_ball: 2 };

  // ── Captures store ──
  // The single source of truth for the captured-creatures array AND
  // the derived indices that point into it (byId, variantsByFusion).
  // Discipline is enforced by the API: there's no other path to
  // mutate localStorage[CAPTURED_KEY], so indices physically cannot
  // get out of sync with the array.
  //
  // Reads return the live in-memory array — no JSON.parse per call,
  // no full-array scan per index lookup. Writes go through replaceAll
  // (rebuilds indices, used by the existing array-mutation pattern)
  // or the granular add/update/removeById methods (in-place index
  // maintenance for hot paths).
  //
  // Variant index is a counted multiset — Map<"a-b", Map<vk, count>>.
  // The count tracks how many captures currently share a (fusion,
  // variant) pair, so removeById can decrement without rescanning to
  // check whether another capture still uses that variant.
  //
  // Captures' `variant` field is normalized to 'auto' | <number> at
  // load time — null and undefined (legacy autogen captures) both
  // become 'auto', and the (one-time) normalization persists, so
  // every downstream consumer can rely on the canonical shape.
  const _capStore = (() => {
    let _list = null;
    let _byId = null;
    let _variantsByFusion = null;  // Map<"a-b", Map<vk, count>>

    function _variantKey(v) {
      if (typeof v === 'number' && v >= 0) return String(v);
      return 'auto';
    }
    function _normalizeVariant(c) {
      if (c && (c.variant === null || c.variant === undefined)) {
        c.variant = 'auto';
        return true;
      }
      return false;
    }
    function _addToIndices(c) {
      if (!c) return;
      if (c.id != null) _byId.set(c.id, c);
      if (isSoloCreature(c)) {
        // Solos index under 'solo:<id>' — a single art variant ('auto').
        const k = creatureKeyOf(c);
        let bucket = _variantsByFusion.get(k);
        if (!bucket) { bucket = new Map(); _variantsByFusion.set(k, bucket); }
        bucket.set('auto', (bucket.get('auto') || 0) + 1);
        return;
      }
      if (c.speciesA == null || c.speciesB == null) return;
      const k = `${c.speciesA}-${c.speciesB}`;
      let bucket = _variantsByFusion.get(k);
      if (!bucket) { bucket = new Map(); _variantsByFusion.set(k, bucket); }
      const vk = _variantKey(c.variant);
      bucket.set(vk, (bucket.get(vk) || 0) + 1);
    }
    function _removeFromIndices(c) {
      if (!c) return;
      if (c.id != null) _byId.delete(c.id);
      if (isSoloCreature(c)) {
        const k = creatureKeyOf(c);
        const bucket = _variantsByFusion.get(k);
        if (!bucket) return;
        const count = bucket.get('auto');
        if (count == null) return;
        if (count <= 1) bucket.delete('auto');
        else bucket.set('auto', count - 1);
        if (bucket.size === 0) _variantsByFusion.delete(k);
        return;
      }
      if (c.speciesA == null || c.speciesB == null) return;
      const k = `${c.speciesA}-${c.speciesB}`;
      const bucket = _variantsByFusion.get(k);
      if (!bucket) return;
      const vk = _variantKey(c.variant);
      const count = bucket.get(vk);
      if (count == null) return;
      if (count <= 1) bucket.delete(vk);
      else bucket.set(vk, count - 1);
      if (bucket.size === 0) _variantsByFusion.delete(k);
    }
    const _writeIdb = _makeIdbWriter(CSTORE_CAPTURED, () => _list);
    function _persist() {
      // Never write before hydration completes — an early write would
      // clobber the not-yet-loaded collection in IDB. Mutations happen on
      // user gestures well after boot, so this only guards the
      // theoretical race; the catch path also awaits _whenReady().
      if (!_cstoreHydrated) return;
      _writeIdb();
    }
    // Authoritative load from a structured array (IDB hydrate, or the
    // legacy localStorage bootstrap below). Rebuilds indices, normalizes
    // legacy variants, and returns whether normalization changed anything
    // so the caller can persist once. Does NOT itself persist.
    function loadFromArray(arr) {
      const t0 = performance.now();
      _list = Array.isArray(arr) ? arr : [];
      _byId = new Map();
      _variantsByFusion = new Map();
      let dirty = false;
      for (const c of _list) {
        if (_normalizeVariant(c)) dirty = true;
        _addToIndices(c);
      }
      _perfMark(_invPerf.fn.capStoreLoad, t0, { lastSize: _list.length });
      return dirty;
    }
    function _ensureLoaded() {
      if (_list !== null) return;
      // Hydration hasn't populated the cache yet (a read raced ahead of
      // the async IDB load — near-impossible in practice). Bootstrap
      // synchronously from localStorage: correct on a first run where the
      // data hasn't migrated yet, harmlessly empty afterwards (hydrate
      // overwrites this the moment it resolves).
      let parsed = [];
      try {
        const raw = _safeLsGet(CAPTURED_KEY);
        parsed = raw ? JSON.parse(raw) : [];
      } catch { parsed = []; }
      loadFromArray(parsed);
    }

    return {
      // Hydrate entry point — called once by _hydrateCStore with the
      // authoritative array read from IDB (or migrated from LS).
      loadFromArray,
      list() { _ensureLoaded(); return _list; },
      byId(id) { _ensureLoaded(); return _byId.get(id) || null; },
      // Returns a fresh Set of variant keys ('auto' | '0' | '1' | ...)
      // currently captured for this fusion. Caller may union with
      // seenFusions[key].variants to get the full "ever-seen" set.
      // Empty Set when no captures of this fusion exist yet.
      variantKeysForFusion(a, b) {
        _ensureLoaded();
        const t0 = performance.now();
        const bucket = _variantsByFusion.get(`${a}-${b}`);
        const out = bucket ? new Set(bucket.keys()) : new Set();
        _perfMark(_invPerf.fn.variantIndex, t0);
        return out;
      },
      // Granular mutations — O(1) index maintenance. Use these in
      // hot paths (capture from spawn, evolve, daycare claim, etc.)
      // for the perf win. The existing read-mutate-replaceAll pattern
      // also works and goes through this same store, just with O(N)
      // index rebuild via replaceAll.
      add(capture) {
        _ensureLoaded();
        _normalizeVariant(capture);
        _list.push(capture);
        _addToIndices(capture);
        _persist();
      },
      removeById(id) {
        _ensureLoaded();
        const idx = _list.findIndex((c) => c && c.id === id);
        if (idx < 0) return null;
        const removed = _list.splice(idx, 1)[0];
        _removeFromIndices(removed);
        _persist();
        return removed;
      },
      update(id, mutator) {
        _ensureLoaded();
        const c = _byId.get(id);
        if (!c) return null;
        // Remove from indices first so we can re-add against the
        // post-mutation species/variant (which may have changed).
        _removeFromIndices(c);
        mutator(c);
        _normalizeVariant(c);
        _addToIndices(c);
        _persist();
        return c;
      },
      // Bulk replace — for import / wipe flows AND for the legacy
      // "read mutate write" pattern via writeCapturedCreatures(arr).
      // O(N) index rebuild; runs ~1-3ms at 2K captures.
      replaceAll(arr) {
        _list = Array.isArray(arr) ? arr.slice() : [];
        _byId = new Map();
        _variantsByFusion = new Map();
        for (const c of _list) {
          _normalizeVariant(c);
          _addToIndices(c);
        }
        _persist();
      },
    };
  })();
  if (typeof window !== 'undefined') window._capStore = _capStore;

  // Captured inventory: thin wrappers that route through the store.
  // The original API surface is preserved so every existing call site
  // (read-mutate-replaceAll, findCreature, save-export, etc.) keeps
  // working unchanged. The wrappers also bump the readCaptured perf
  // counter so the Settings dump shows how many times we'd have
  // re-parsed the JSON under the pre-cache implementation.
  function readCapturedCreatures() {
    const t0 = performance.now();
    const out = _capStore.list();
    _perfMark(_invPerf.fn.readCaptured, t0, { lastSize: out.length });
    return out;
  }
  function writeCapturedCreatures(arr) {
    _capStore.replaceAll(arr);
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
  // Test-only override toggle (Settings → "Force shiny catches"). When
  // on, every shiny roll succeeds; the variant index is still uniformly
  // random so different captures show different shinies. Reads
  // localStorage each call — settings can flip mid-session.
  function _forceShinyOn() {
    try { return localStorage.getItem('cc.forceShiny') === '1'; }
    catch { return false; }
  }

  // Accessibility toggle (Settings → "Guaranteed catch"). When on, one
  // physical throw always ends in a catch — but the normal odds still
  // run underneath: hidden re-rolls consume real extra balls until the
  // catch lands, and the shake phase is slowed so the whole sequence
  // takes ~10% LONGER than those individual throws' animations would
  // have (plus a re-aim allowance per hidden throw). Strain relief for
  // repeated tapping, deliberately NOT a time or resource advantage.
  function _guaranteedCatchOn() {
    try { return localStorage.getItem('cc.steadyCatch') === '1'; }
    catch { return false; }
  }
  // Pure planner for guaranteed-catch mode. rollShakes() returns 0-3
  // successful shakes (3 = caught) at the ball's normal odds;
  // tryConsume() pays for one hidden re-throw and returns false when
  // the bag is empty (the FIRST ball is paid by the caller before this
  // runs, matching the manual path). Returns the visible throw's
  // wobble count + pacing.
  //
  // Pacing math: the durations below estimate the manual path's stage
  // animations (arc, suck-in, per-shake wobble+pause, catch ding,
  // break-out) plus a small re-aim allowance between manual throws.
  // The single visible sequence keeps arc/suck-in/ding at normal speed
  // and stretches only the shake phase so that
  //     visible total ≥ MARGIN × (manual animation total)
  // holds for every outcome — verified in tests/guaranteed-catch.test.js.
  function _guaranteedThrowPlan(rollShakes, tryConsume) {
    const ARC = 650, SUCK = 480, SHAKE = 700, CATCH_END = 540,
      BREAK = 700, REAIM = 400, MARGIN = 1.1;
    let shakes = rollShakes();
    let caught = shakes === 3;
    let ballsUsed = 1;
    let totalShakes = shakes;
    let normalMs = ARC + SUCK + shakes * SHAKE + (caught ? CATCH_END : BREAK);
    while (!caught && tryConsume()) {
      ballsUsed++;
      shakes = rollShakes();
      caught = shakes === 3;
      totalShakes += shakes;
      normalMs += REAIM + ARC + SUCK + shakes * SHAKE + (caught ? CATCH_END : BREAK);
    }
    if (!caught) {
      // Bag ran dry with no successful roll: the creature breaks out
      // at normal pacing. Every rolled ball was genuinely spent — the
      // same balls manual throwing would have burned.
      return { caught: false, wobbles: shakes, wobbleMs: 380, pauseMs: 320, ballsUsed };
    }
    // One slowed sequence: every hidden shake is shown, and the pace
    // stretches so the total runs past the manual-time margin. per is
    // the full wobble+pause slot; split in the same 380/320 ratio the
    // manual path uses. Never faster than a normal shake.
    const wobbles = Math.max(3, totalShakes);
    const target = normalMs * MARGIN - (ARC + SUCK + CATCH_END);
    const per = Math.max(SHAKE, target / wobbles);
    return {
      caught: true, wobbles, ballsUsed,
      wobbleMs: per * (380 / 700), pauseMs: per * (320 / 700),
    };
  }

  // Completion-dex shiny bonus. A fusion morph's Completion % maps to a
  // multiplier in 10% bands: 20%→+2×, 30%→+3×, … 90%→+9×, 100%→+10× (below
  // 20% gives nothing). The two morphs' bonuses ADD (e.g. a 40% head + 20%
  // body → 4 + 2 = 6× shiny), so two low-completion species stay at the base
  // rate. Banded off the ROUNDED % the Completion dex shows, so the number on
  // a dex row is exactly what that morph is worth.
  function _speciesShinyBonus(pct) {
    const shown = Math.round(pct * 100); // match the % printed on the dex row
    if (shown < 20) return 0;            // 10% band (and below) gives no bonus
    return Math.min(10, Math.floor(shown / 10)); // 20→2, 30→3, … 90→9, 100→10
  }
  function _fusionShinyMultiplier(speciesA, speciesB) {
    const byId = new Map(computeSpeciesCompletion().map((r) => [r.id, r.pct]));
    let m = 0;
    if (speciesA != null) m += _speciesShinyBonus(byId.get(speciesA) || 0);
    if (speciesB != null) m += _speciesShinyBonus(byId.get(speciesB) || 0);
    return m || 1; // 0 (both morphs below 20%) → base rate
  }

  // A shiny decision, once made for a spawn, must outlive the map marker: the
  // spawn refresh can tear a marker down and rebuild it (GPS loss, or the spawn
  // drifting out of range) between engaging the encounter and finishing the
  // catch. The old code stored the decision only on the ephemeral marker
  // record, so a rebuilt marker made the catch re-roll fresh — quietly dropping
  // a shiny the player just saw. We cache it per spawn id instead. Value: null
  // (decided not-shiny) or an integer variant index. FIFO-capped; the entry is
  // removed once the spawn is caught (it's persisted on the creature by then).
  const _shinyBySpawn = new Map();
  const _SHINY_CACHE_CAP = 1000;
  function _cacheShiny(spawnId, variant) {
    if (spawnId == null) return;
    _shinyBySpawn.set(spawnId, variant);
    if (_shinyBySpawn.size > _SHINY_CACHE_CAP) {
      const oldest = _shinyBySpawn.keys().next().value;   // Map keeps insertion order
      if (oldest !== undefined) _shinyBySpawn.delete(oldest);
    }
  }

  // Per-player shiny roll. Unlike the rest of the encounter RNG (which
  // is deterministic in spawn id so two players see the same level /
  // size / variant), shinies are independent per player and decided at
  // the moment the user opens the encounter screen. The roll is
  // persisted on the marker record AND the per-spawn cache so re-tapping
  // the same encounter (even after its marker was rebuilt) doesn't re-roll.
  //
  // rec.shinyVariant resolves to either null (not shiny — vast majority
  // of cases) or an integer in [0, 11] (which of the 12 shiny styles
  // for the family pair). Idempotent: once set, never re-rolled.
  function _rollShinyForRecord(rec) {
    if (!rec || rec.shinyVariant !== undefined) return;
    const sid = rec.spawn && rec.spawn.id;
    // Reuse a decision already made for this spawn (e.g. the marker was rebuilt
    // by a refresh), so shininess is stable from "tap" through to "caught".
    if (sid != null && _shinyBySpawn.has(sid)) { rec.shinyVariant = _shinyBySpawn.get(sid); return; }
    let rate = (global.ShinyStore && global.ShinyStore.RATE) || 0.001;
    // Legendaries get 10× the base shiny rate (1/100 at the default
    // 1/1000); incense spawns get 2×. The roll itself uses Math.random,
    // so WHO sees a shiny varies per trainer — only which/where the
    // legendary spawns is deterministic and shared.
    if (rec.spawn && rec.spawn.legendary) rate *= 10;
    else if (rec.spawn && rec.spawn.incense) rate *= 2;
    // Completion-dex bonus: the two morphs' per-species bonuses add on top.
    rate *= _fusionShinyMultiplier(rec.spawn && rec.spawn.speciesA, rec.spawn && rec.spawn.speciesB);
    const count = (global.ShinyStore && global.ShinyStore.VARIANT_COUNT) || 12;
    const hit = _forceShinyOn() || (Math.random() < rate);
    rec.shinyVariant = hit ? Math.floor(Math.random() * count) : null;
    _cacheShiny(sid, rec.shinyVariant);
  }

  // Standalone roll for capture paths that don't have a marker record
  // (egg hatch, daycare loot). Same per-player semantics — independent
  // chance, decided at the moment the creature comes into being.
  function _rollFreshShinyVariant(speciesA, speciesB) {
    let rate = (global.ShinyStore && global.ShinyStore.RATE) || 0.001;
    // Completion-dex bonus, same as the marker roll (see _fusionShinyMultiplier).
    rate *= _fusionShinyMultiplier(speciesA, speciesB);
    const count = (global.ShinyStore && global.ShinyStore.VARIANT_COUNT) || 12;
    const hit = _forceShinyOn() || (Math.random() < rate);
    return hit ? Math.floor(Math.random() * count) : null;
  }

  // Resolve shininess for a catch, in priority order: the live marker record,
  // then the per-spawn cache (survives a marker being rebuilt by a refresh
  // mid-encounter), and only a fresh roll if the encounter was never engaged
  // (instant-catch debug path). This is what keeps "saw a shiny" == "caught a
  // shiny" even when the marker churns between tapping and catching.
  function _resolveShinyForCatch(spawn) {
    if (!spawn) return _rollFreshShinyVariant(undefined, undefined);
    const rec = _markers.get(spawn.id);
    if (rec && rec.shinyVariant !== undefined) return rec.shinyVariant;
    if (spawn.id != null && _shinyBySpawn.has(spawn.id)) return _shinyBySpawn.get(spawn.id);
    return _rollFreshShinyVariant(spawn.speciesA, spawn.speciesB);
  }

  // Special captures haul extra candy: evolved poké-radar targets pay
  // 10× the normal 2-candy capture (20), legendaries pay 50, and egg
  // hatches pay 10. Each unit is sampled independently between the two
  // morphs' family roots (see awardCandyForCapture's `total > 2` branch).
  const CANDY_EVOLVED_CAPTURE = 20;
  const CANDY_LEGENDARY_CAPTURE = 50;
  const CANDY_HATCH_CAPTURE = 10;
  // Derive a capture's candy haul from its spawn id namespace ('L:'
  // legendary, 'E:' evolved). Used by the migration replay, which only
  // has the persisted record; recordCapture uses the live spawn flags.
  function candyTotalForSpawnId(id) {
    if (typeof id === 'string') {
      if (id.startsWith('L:')) return CANDY_LEGENDARY_CAPTURE;
      if (id.startsWith('E:')) return CANDY_EVOLVED_CAPTURE;
    }
    return 2;
  }

  function awardCandyForCapture(speciesA, speciesB, total) {
    if (speciesA == null || speciesB == null) return;
    const rootA = candyRootFor(speciesA);
    const rootB = candyRootFor(speciesB);    // Special captures (evolved / legendary) pass a larger haul; each
    // unit is sampled independently between the two morphs' roots.
    if (typeof total === 'number' && total > 2) {
      if (rootA === rootB) {
        bumpCandy(rootA, total);
        return;
      }
      let a = 0;
      for (let i = 0; i < total; i++) {
        if (Math.random() < 0.5) a++;
      }
      if (a) bumpCandy(rootA, a);
      if (total - a) bumpCandy(rootB, total - a);
      return;
    }
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
  // Solo creatures have no evolution family — each special is its own
  // candy bucket, keyed 'solo:<id>' (bumpCandy keys by string already).
  function awardCandyForSolo(soloId, total) {
    if (!soloId) return;
    bumpCandy('solo:' + soloId, (typeof total === 'number' && total > 0) ? total : 2);
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
      awardCandyForCapture(c.speciesA, c.speciesB, candyTotalForSpawnId(c.spawnId));
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

  // === Daycare slots ===
  // The user can park up to DAYCARE_SLOT_COUNT captured creatures in
  // the daycare. State is a flat array stored in localStorage. Each
  // entry is an object { id, addedAt, distM }:
  //   id     : capture id (string)
  //   addedAt: ms-since-epoch when this creature was placed in the
  //            slot. Resets each time a creature is removed and
  //            re-added — that's how distance accumulation restarts
  //            from zero on re-entry, matching the user's mental
  //            model ("the daycare counter is the distance walked
  //            *during this stay*, not lifetime in the daycare").
  //   distM  : meters travelled while this slot was occupied,
  //            updated by _accumulateDaycareDistance on every
  //            accepted GPS fix.
  // Legacy shape was a flat array of capture-id strings. The reader
  // migrates strings → objects on first read after upgrade so old
  // saves keep working without a separate migration step.
  const DAYCARE_SLOTS_KEY = 'cc.daycareSlots.v1';
  const DAYCARE_SLOT_COUNT = 2;

  // Egg inventory. Each entry is an unhatched fusion egg dropped
  // from the daycare loot rolls (or, in the future, traded /
  // gifted). Shape: { id, speciesA, speciesB, sizeM, createdAt } —
  // or, for a solo (special) egg from daycare duplication:
  // { id, solo, sizeM, createdAt } with no speciesA/B.
  // sizeM is rolled at drop time and burned in so the eventual
  // hatched creature's size is deterministic in the egg's PRNG seed.
  // The incubator (which slots eggs hatch into + a per-egg distance
  // counter) is layered in a separate slice; for v1 eggs are just
  // collected and viewable in the new Eggs sub-view.
  const EGGS_KEY = 'cc.eggs.v1';

  function readEggs() {
    try {
      const raw = localStorage.getItem(EGGS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return arr.filter((e) =>
        e && typeof e === 'object'
        && typeof e.id === 'string' && e.id
        && ((Number.isInteger(e.speciesA) && Number.isInteger(e.speciesB))
          // Solo eggs (daycare duplication of a special creature).
          || (typeof e.solo === 'string' && e.solo)));
    } catch { return []; }
  }
  function writeEggs(arr) {
    try { localStorage.setItem(EGGS_KEY, JSON.stringify(arr)); }
    catch {}
  }
  function addEgg(egg) {
    if (!egg) return null;
    const isSoloEgg = typeof egg.solo === 'string' && egg.solo;
    if (!isSoloEgg && (!Number.isInteger(egg.speciesA) || !Number.isInteger(egg.speciesB))) {
      return null;
    }
    const arr = readEggs();
    const id = `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      id,
      sizeM: typeof egg.sizeM === 'number' ? egg.sizeM : 1.0,
      // Incubation distance — meters walked while this egg occupied
      // an incubator slot. Persists across slot swaps; capped at
      // INCUBATOR_HATCH_M when the egg is ready.
      incubatedM: 0,
      createdAt: Date.now(),
    };
    if (isSoloEgg) {
      record.solo = egg.solo;
    } else {
      record.speciesA = egg.speciesA;
      record.speciesB = egg.speciesB;
      // displaySpecies is the egg's depicted-art species — independent
      // of the hatching content but still normalised to baby form.
      // Older pre-cross-breed eggs don't have it; the eggs view falls
      // back to speciesA when missing.
      if (Number.isInteger(egg.displaySpecies)) {
        record.displaySpecies = egg.displaySpecies;
      }
    }
    arr.push(record);
    writeEggs(arr);
    return record;
  }

  // Incubator: two slots a player can place eggs into. While
  // occupied, an egg accumulates walked distance toward
  // INCUBATOR_HATCH_M; the count lives on the egg itself
  // (`incubatedM`), so swapping out for another egg and coming
  // back later resumes from the same distance. Storage here is
  // just the slot bindings — the per-egg state lives on the egg
  // record in cc.eggs.v1.
  const INCUBATOR_KEY = 'cc.incubator.v1';
  const INCUBATOR_HATCH_M = 5000;
  const INCUBATOR_SLOTS = 2;

  function readIncubator() {
    try {
      const raw = localStorage.getItem(INCUBATOR_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      const out = new Array(INCUBATOR_SLOTS).fill(null);
      if (Array.isArray(arr)) {
        for (let i = 0; i < INCUBATOR_SLOTS; i++) {
          const v = arr[i];
          if (typeof v === 'string' && v) out[i] = v;
        }
      }
      // Drop slot bindings whose egg no longer exists (deleted /
      // hatched / cleared via wipe). Keeps the visible state honest
      // without needing every egg-mutation path to also touch the
      // incubator key.
      const liveIds = new Set(readEggs().map((e) => e.id));
      let needsWrite = false;
      for (let i = 0; i < INCUBATOR_SLOTS; i++) {
        if (out[i] && !liveIds.has(out[i])) {
          out[i] = null;
          needsWrite = true;
        }
      }
      if (needsWrite) {
        try { localStorage.setItem(INCUBATOR_KEY, JSON.stringify(out)); } catch {}
      }
      return out;
    } catch { return new Array(INCUBATOR_SLOTS).fill(null); }
  }

  function writeIncubator(slots) {
    const norm = new Array(INCUBATOR_SLOTS).fill(null);
    for (let i = 0; i < INCUBATOR_SLOTS; i++) {
      const v = slots && slots[i];
      if (typeof v === 'string' && v) norm[i] = v;
    }
    try { localStorage.setItem(INCUBATOR_KEY, JSON.stringify(norm)); }
    catch {}
  }

  // Place eggId in slot idx. If the egg is already in another
  // slot, that slot is cleared first so the same egg never
  // double-incubates. Pass eggId=null to empty a slot.
  function setIncubatorSlot(idx, eggId) {
    if (idx !== 0 && idx !== 1) return;
    const slots = readIncubator();
    if (eggId) {
      for (let i = 0; i < INCUBATOR_SLOTS; i++) {
        if (slots[i] === eggId && i !== idx) slots[i] = null;
      }
    }
    slots[idx] = eggId || null;
    writeIncubator(slots);
  }

  // Swap whichever eggs are in slots a and b (either may be null).
  function swapIncubatorSlots(a, b) {
    if (a === b) return;
    if ((a !== 0 && a !== 1) || (b !== 0 && b !== 1)) return;
    const slots = readIncubator();
    const tmp = slots[a]; slots[a] = slots[b]; slots[b] = tmp;
    writeIncubator(slots);
  }

  function removeFromIncubator(eggId) {
    if (!eggId) return;
    const slots = readIncubator();
    let changed = false;
    for (let i = 0; i < INCUBATOR_SLOTS; i++) {
      if (slots[i] === eggId) { slots[i] = null; changed = true; }
    }
    if (changed) writeIncubator(slots);
  }

  function eggIncubatedM(egg) {
    if (!egg) return 0;
    const v = egg.incubatedM;
    return (typeof v === 'number' && v >= 0) ? v : 0;
  }
  function eggReadyToHatch(egg) {
    return eggIncubatedM(egg) >= INCUBATOR_HATCH_M;
  }

  // Hatch a fully-incubated egg: create a level-1 capture record
  // matching the egg's content species + size, remove the egg, and
  // free its incubator slot. Returns the capture record on success,
  // null if the egg doesn't exist or isn't ready yet. Capture shape
  // mirrors recordCaptureFromSpawn's so downstream UIs (inventory,
  // pokédex, candy) see hatched-from-egg captures the same as
  // wild-caught ones, with a `fromEgg: true` flag for any future
  // origin-aware rendering.
  // Pick a custom-art variant for a hatching egg. Deterministic in
  // the egg id so re-hatching the same egg (shouldn't happen, but
  // safer) always lands on the same variant. Falls back to 'auto'
  // when the cell has no custom variants or the sprites module isn't
  // ready yet.
  async function _pickHatchVariant(speciesA, speciesB, eggId) {
    if (!global.Sprites || !global.Sprites.getCellVariantCount) return 'auto';
    try {
      const count = await global.Sprites.getCellVariantCount(speciesA, speciesB);
      if (!count || count <= 0) return 'auto';
      const seed = `hatch|${eggId}|${speciesA}-${speciesB}`;
      const rng = (global.Spawns && global.Spawns.getRng)
        ? global.Spawns.getRng(seed)
        : Math.random;
      return Math.floor(rng() * count);
    } catch (e) {
      _logCreatureError(`pickHatchVariant/${speciesA}-${speciesB}`, e);
      return 'auto';
    }
  }

  async function hatchEgg(eggId) {
    if (!eggId) return null;
    const eggs = readEggs();
    const idx = eggs.findIndex((e) => e.id === eggId);
    if (idx < 0) return null;
    const egg = eggs[idx];
    if (!eggReadyToHatch(egg)) return null;
    // Pick the variant BEFORE mutating any state so a transient
    // sprites-module failure doesn't leave us with a half-hatched
    // egg. Uniform pick across all custom variants for this fusion
    // (falls back to 'auto' if there are none, same as wild catches).
    const isSoloEgg = typeof egg.solo === 'string' && egg.solo;
    const variant = isSoloEgg
      ? 'auto'
      : await _pickHatchVariant(egg.speciesA, egg.speciesB, egg.id);
    const entry = {
      id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      spawnId: null,
      fromEgg: true,
      speciesA: isSoloEgg ? null : egg.speciesA,
      speciesB: isSoloEgg ? null : egg.speciesB,
      variant,
      // Per-player shiny roll happens at hatch (the moment the player
      // first sees the creature) — independent of any other player who
      // had a sibling egg from the same daycare loot.
      shinyVariant: _rollFreshShinyVariant(egg.speciesA, egg.speciesB),
      level: 1,
      sizeM: typeof egg.sizeM === 'number' ? egg.sizeM : 1.0,
      caughtAt: (() => {
        // Stamp the player's current GPS position at the moment of
        // hatch (typically: standing somewhere meaningful — home, a
        // park, a Pokéstop). The egg's incubation happened across
        // many points, but the hatch event is the one moment we can
        // pin to a place. Falls back to null lat/lng when location
        // isn't available (denied permission, no fix yet) — the
        // encounter-info panel renders "Hatched from egg" in that
        // case, same as before.
        const poiApi = global.CreatureCollectAPI;
        const lat = (typeof _userLat === 'number') ? _userLat : null;
        const lng = (typeof _userLng === 'number') ? _userLng : null;
        const poi = (lat != null && lng != null && poiApi && poiApi.findNearestNamedPoi)
          ? poiApi.findNearestNamedPoi(lat, lng)
          : null;
        const place = (lat != null && lng != null && poiApi && poiApi.findNearestPlace)
          ? poiApi.findNearestPlace(lat, lng)
          : null;
        return {
          timestamp: Date.now(),
          lat, lng,
          poi: poi || null,
          place: place || null,
        };
      })(),
    };
    if (isSoloEgg) entry.solo = egg.solo;
    const list = readCapturedCreatures();
    list.push(entry);
    writeCapturedCreatures(list);
    // Register the hatched fusion (+ its variant) in the Pokédex NOW.
    // Wild catches get marked seen at the encounter (openBattleScreen);
    // a hatch has no encounter, so without this the fusion only reaches
    // seenFusions via the load-time backfillSeenFromCaptures() — meaning
    // it wouldn't show in the dex until an app restart, and evolving it
    // before that restart would overwrite the record's species, losing
    // the pre-evolution dex entry for good.
    try {
      if (isSoloEgg) {
        markSoloSeen(egg.solo, 'auto');
      } else {
        markFusionSeen(egg.speciesA, egg.speciesB,
          { lat: entry.caughtAt.lat, lng: entry.caughtAt.lng }, variant);
      }
    } catch {}
    if (isSoloEgg) awardCandyForSolo(egg.solo, CANDY_HATCH_CAPTURE);
    else awardCandyForCapture(egg.speciesA, egg.speciesB, CANDY_HATCH_CAPTURE);
    eggs.splice(idx, 1);
    writeEggs(eggs);
    removeFromIncubator(eggId);
    // Any hatch (map bubble, eggs-view "Tap to hatch", future callers) may have
    // been the last ready egg — re-evaluate the map's hatch bubble so it hides
    // once nothing is left to hatch (and stays up if a sibling is still ready).
    _updateEggBubble();
    return entry;
  }

  // Daycare loot. Each slot earns one milestone of loot every
  // DAYCARE_LOOT_MILESTONE_M metres walked while occupied. Milestone
  // N's loot is deterministic in (slot.id, slot.addedAt, N) — no roll
  // history is stored, just the list of milestone indices the user
  // has already claimed. Removing the slot wipes both, so
  // removeFromDaycare auto-claims any outstanding loot before
  // deletion.
  //
  // The table is intentionally small for v1: a single "test orb" item
  // so the surface area (UI, animations, claim flow, settings reset)
  // can be exercised end-to-end before we layer in real drops.
  // Settings → "Repopulate daycare test loot" wipes claimed indices
  // across all slots, regenerating the same loot stream (same seed
  // → same items) so the user can re-tap them.
  //
  // Rate history: was 1000 m (1 milestone/km) → 500 m (2/km). Table
  // history: 0.75/0.15/0.10 → 0.70/0.15/0.15 (2026-07, evo items
  // bumped to 15%). Eggs unchanged: 0.30 per km per slot, 0.60/km
  // combined when both slots are filled (one egg every ~1.67 km).
  // NOTE: milestones are deterministic in (slot, addedAt, N), so a
  // threshold change re-maps any still-unclaimed milestones' kinds
  // (one-time shift, no stored history to migrate).
  const DAYCARE_LOOT_MILESTONE_M = 500;
  // Daycare loot is one of three kinds, rolled deterministically per
  // milestone via the slot's seed. Probabilities sum to 1.0:
  //   0.00–0.70  candy   — 1 candy in the daycare pokémon's family
  //                        bucket (50/50 between A and B's roots)
  //   0.70–0.85  egg     — same fusion as the parent, level 1, with
  //                        a randomized size baked in at drop time
  //   0.85–1.00  evo_item — uniform pick from items that can evolve
  //                        either side's family. Falls back to candy
  //                        if neither family has an Item evolution.
  const DAYCARE_PROB_CANDY = 0.70;
  const DAYCARE_PROB_EGG = 0.15;  // implicit upper bound = 0.85

  function _evoItemsForFamily(speciesId) {
    if (speciesId == null) return [];
    if (!global.Species || !global.Species.familyOf) return [];
    const family = global.Species.familyOf(speciesId) || [speciesId];
    const items = new Set();
    for (const id of family) {
      const evos = (global.Species.evolutionsFor && global.Species.evolutionsFor(id)) || [];
      for (const evo of evos) {
        if (evo.method === 'Item' && typeof evo.param === 'string') {
          items.add(evo.param);
        }
      }
    }
    return Array.from(items);
  }

  function _daycareLootAt(slot, n) {
    if (!slot || !Number.isInteger(n) || n < 1) return null;
    const creature = findCreature(slot.id);
    if (!creature) return null;
    const a = creature.speciesA;
    const b = creature.speciesB;
    if (!isSoloCreature(creature) && (!Number.isInteger(a) || !Number.isInteger(b))) return null;
    if (!global.Spawns || !global.Spawns.getRng) return null;

    // Cross-breed pool: pull every daycare slot's species into two
    // sets — firstPool from each slot's speciesA, secondPool from
    // each slot's speciesB. Used by the egg roll below to mix
    // across slots. With two slots of (a1, b1) + (a2, b2):
    //   firstPool  = { a1, a2 }
    //   secondPool = { b1, b2 }
    //   naturals   = firstPool × secondPool  → 4 ordered pairs
    //                  { a1×b1, a1×b2, a2×b1, a2×b2 }
    //                (two same-as-parent + two cross-mixes)
    //   others     = (allSpecies × allSpecies) − naturals
    //                  where allSpecies = firstPool ∪ secondPool
    //                → up to 12 "weirder" pairs (A×A, B×A, D×C, ...)
    // With one slot or fully-overlapping pools the buckets shrink
    // gracefully (single-slot collapse: 1 natural / 3 others), and
    // the 70/30 ratio still holds, just over smaller buckets.
    const firstPool = new Set();
    const secondPool = new Set();
    for (const s of readDaycareSlots()) {
      const c = findCreature(s.id);
      if (!c) continue;
      if (Number.isInteger(c.speciesA)) firstPool.add(c.speciesA);
      if (Number.isInteger(c.speciesB)) secondPool.add(c.speciesB);
    }
    // Defensive — this slot's species should always be in the pool
    // even if readDaycareSlots somehow doesn't include it.
    if (Number.isInteger(a)) firstPool.add(a);
    if (Number.isInteger(b)) secondPool.add(b);
    const allSpeciesSet = new Set([...firstPool, ...secondPool]);

    // Six independent uniform draws from the per-milestone seed.
    // Append-only — never reorder or insert in the middle, since
    // older milestones' kind/species choices are pinned by the
    // exact draw sequence:
    //   u1: kind selector (candy / egg / evo)
    //   u2: candy species OR evo item index
    //   u3: egg size
    //   u4: egg natural-vs-other gate (70/30)
    //   u5: egg pair index within its bucket
    //   u6: egg display-art species index
    const seed = `dc|${slot.id}|${slot.addedAt}|${n}`;
    const rng = global.Spawns.getRng(seed);
    const draw = () => (rng.int32() >>> 0) / 0x100000000;
    const u1 = draw();
    const u2 = draw();
    const u3 = draw();
    const u4 = draw();
    const u5 = draw();
    const u6 = draw();

    // Solo parent in daycare: the Missingno duplication fantasy. Loot
    // is solo candy or a solo EGG (hatches into the same special);
    // solos have no evolution items, so the evo branch collapses to
    // candy. Uses only u1 (kind) and u3 (size) — the pair draws below
    // are untouched, so pool construction above is inert for solos.
    if (isSoloCreature(creature)) {
      const soloDef = global.Specials && global.Specials.get(creature.solo);
      const soloName = soloDef ? soloDef.name : creature.solo;
      if (u1 < DAYCARE_PROB_CANDY + DAYCARE_PROB_EGG && u1 >= DAYCARE_PROB_CANDY) {
        const sizeM = Math.round((0.5 + u3 * 1.5) * 100) / 100;
        return { kind: 'egg', solo: creature.solo, sizeM, label: `${soloName} egg` };
      }
      return { kind: 'candy', solo: creature.solo, label: `${soloName} candy` };
    }

    const rootA = candyRootFor(a);
    const rootB = candyRootFor(b);
    const candySpeciesPick = () =>
      (rootA === rootB) ? rootA : (u2 < 0.5 ? rootA : rootB);
    const candyLoot = () => {
      const species = candySpeciesPick();
      return {
        kind: 'candy',
        species,
        label: `${speciesNameFor(species)} candy`,
      };
    };

    if (u1 < DAYCARE_PROB_CANDY) {
      return candyLoot();
    }
    if (u1 < DAYCARE_PROB_CANDY + DAYCARE_PROB_EGG) {
      // Cross-breed egg. 70% uniformly across naturals, 30%
      // uniformly across others. Display species is rolled
      // separately from the combined pool — the egg might depict
      // any species regardless of what's inside, matching the
      // "you don't know what'll hatch" feel. Size in 0.5–2.0 m,
      // rounded to 0.01 m — placeholder until a real distribution
      // is wired in.
      const naturals = [];
      for (const x of firstPool) {
        for (const y of secondPool) {
          naturals.push([x, y]);
        }
      }
      const allSpeciesArr = Array.from(allSpeciesSet);
      const naturalKeys = new Set(naturals.map(([x, y]) => `${x},${y}`));
      const others = [];
      for (const x of allSpeciesArr) {
        for (const y of allSpeciesArr) {
          if (!naturalKeys.has(`${x},${y}`)) others.push([x, y]);
        }
      }
      const useNatural = others.length === 0 || u4 < 0.7;
      const pool = useNatural ? naturals : others;
      const [rawA, rawB] = pool[Math.floor(u5 * pool.length)] || [a, b];
      const rawDisplay = allSpeciesArr[Math.floor(u6 * allSpeciesArr.length)] || rawA;
      // Eggs always contain the baby form of whatever species got
      // picked — Raichu and Pikachu both hatch as Pikachu, all
      // three Charmander-line evos hatch as Charmander, etc. Same
      // applies to the display art so the egg's appearance matches
      // its eventual contents. candyRootFor walks the evolution
      // family and returns the earliest gen-1 form (skipping gen-2+
      // babies like Pichu that aren't in our 1–150 dataset).
      const eggA = candyRootFor(rawA);
      const eggB = candyRootFor(rawB);
      const displaySpecies = candyRootFor(rawDisplay);
      const sizeM = Math.round((0.5 + u3 * 1.5) * 100) / 100;
      return {
        kind: 'egg',
        a: eggA,
        b: eggB,
        displaySpecies,
        sizeM,
        label: `${fusionName(eggA, eggB)} egg`,
      };
    }
    // Evo item branch — gather all items either family could
    // graduate via, uniformly pick one. Fallback to candy if there's
    // no evolution-by-item path on either side (Bulbasaur×Squirtle
    // etc. — both families evolve by level only).
    const possible = Array.from(new Set(
      _evoItemsForFamily(a).concat(_evoItemsForFamily(b))
    ));
    if (!possible.length) return candyLoot();
    const itemKey = possible[Math.floor(u2 * possible.length)] || possible[0];
    const meta = ITEMS[itemKey];
    return {
      kind: 'evo_item',
      itemKey,
      label: (meta && meta.name) || _formatItemName(itemKey),
    };
  }

  // CSS background-* values for a loot pill button. Each kind has
  // its own icon source: candies + eggs are sprite-sheet cells
  // (background-image + background-position), evo items are full
  // PNGs (background-image + background-size: contain). Pill cells
  // render at PILL_CELL_PX so the sheet's per-cell math is uniform
  // across all kinds.
  const PILL_CELL_PX = 28;
  // eggs.png layout — kept in sync with build-bundled-data.py. Row
  // count must match (MAX_SPECIES // 10) + 1. With MAX_SPECIES=429 the
  // sheet is 43 rows × 160px = 6880px tall. Bump this whenever the
  // species set extends to a higher PIF id.
  const EGGS_SHEET_COLS = 10;
  const EGGS_SHEET_ROWS = 43;

  function _lootIconStyle(loot) {
    if (!loot) return '';
    const noRepeat = 'background-repeat: no-repeat;'
      + 'image-rendering: pixelated;'
      + 'image-rendering: crisp-edges;';
    // Solo loot (special candy / duplication egg): the special's own
    // full-PNG sprite, no sheet math.
    if (loot.solo) {
      const url = (global.Specials && global.Specials.spriteUrl(loot.solo)) || '';
      return (
        `background-image: url('${url}');`
        + `background-size: contain;`
        + `background-position: center;`
        + noRepeat
      );
    }
    if (loot.kind === 'candy') {
      const id = loot.species;
      const col = id % CANDY_SHEET_COLS;
      const row = Math.floor(id / CANDY_SHEET_COLS);
      return (
        `background-image: url('${BUNDLED_BASE}/candies.png');`
        + `background-size: ${PILL_CELL_PX * CANDY_SHEET_COLS}px ${PILL_CELL_PX * CANDY_SHEET_ROWS}px;`
        + `background-position: -${col * PILL_CELL_PX}px -${row * PILL_CELL_PX}px;`
        + noRepeat
      );
    }
    if (loot.kind === 'egg') {
      // Render eggs.png at a 60px-display cell so the visible art
      // (~60×60 of a 160×160 cell, centered with transparent
      // padding) shows at roughly the same on-pill footprint as
      // a candy. Centering the cell's bbox on the pill needs an
      // inset of (60 − 28) / 2 = 16 px on each axis.
      // Egg art is the displaySpecies (sampled separately from
      // the contents, then normalised to baby form). Older eggs
      // pre-cross-breed didn't carry displaySpecies — fall back
      // to loot.a so existing pills keep rendering.
      const id = Number.isInteger(loot.displaySpecies) ? loot.displaySpecies : loot.a;
      const col = id % EGGS_SHEET_COLS;
      const row = Math.floor(id / EGGS_SHEET_COLS);
      const cellPx = 60;
      const insetX = (cellPx - PILL_CELL_PX) / 2;
      // 1 px less than insetX → image shifts down 1 px in the
      // pill (smaller |bg-position-y| pulls the rendered image's
      // top edge closer to the pill's top edge).
      const insetY = insetX - 1;
      return (
        `background-image: url('${BUNDLED_BASE}/eggs.png');`
        + `background-size: ${cellPx * EGGS_SHEET_COLS}px ${cellPx * EGGS_SHEET_ROWS}px;`
        + `background-position: -${col * cellPx + insetX}px -${row * cellPx + insetY}px;`
        + noRepeat
      );
    }
    if (loot.kind === 'evo_item') {
      const meta = ITEMS[loot.itemKey];
      const url = (meta && meta.icon) || `${BUNDLED_BASE}/evo-items/${loot.itemKey}.png`;
      return (
        `background-image: url('${url}');`
        + `background-size: contain;`
        + `background-position: center;`
        + noRepeat
      );
    }
    return '';
  }

  // Apply a single loot drop to the player's inventory: candy goes
  // to the family bucket, eggs land in cc.eggs.v1, evo items in
  // the bag. Returns truthy on a successful grant so callers can
  // distinguish "actually granted" from "skipped because already
  // claimed / not yet earned".
  function _grantLoot(loot) {
    if (!loot) return false;
    if (loot.kind === 'candy') {
      if (loot.solo) awardCandyForSolo(loot.solo, 1);
      else bumpCandy(loot.species, 1);
      return true;
    }
    if (loot.kind === 'egg') {
      if (loot.solo) {
        return !!addEgg({ solo: loot.solo, sizeM: loot.sizeM });
      }
      return !!addEgg({
        speciesA: loot.a,
        speciesB: loot.b,
        displaySpecies: loot.displaySpecies,
        sizeM: loot.sizeM,
      });
    }
    if (loot.kind === 'evo_item') {
      grantItem(loot.itemKey, 1);
      return true;
    }
    return false;
  }

  function _daycareEarnedCount(slot) {
    if (!slot) return 0;
    return Math.floor((slot.distM || 0) / DAYCARE_LOOT_MILESTONE_M);
  }

  // Resolve a slot's family roots from the capture record. Returns
  // { rootA, rootB } or null when the creature is gone, the species
  // data isn't loaded yet, or the two halves share a root (Pure
  // fusion — there's nothing to convert between).
  function _daycareConversionRoots(slot) {
    if (!slot || !slot.id) return null;
    const c = findCreature(slot.id);
    if (!c || c.speciesA == null || c.speciesB == null) return null;
    const rootA = candyRootFor(c.speciesA);
    const rootB = candyRootFor(c.speciesB);
    if (rootA == null || rootB == null || rootA === rootB) return null;
    return { rootA, rootB };
  }

  // Ditto is the wildcard: its candy converts INTO any other family
  // at 1-for-1 instead of 2-for-1, reflecting Ditto's "becomes
  // anything" identity. The discount only applies when Ditto is the
  // SOURCE — converting other-family candy INTO Ditto candy stays
  // at the regular 2:1 rate.
  const DITTO_SPECIES_ID = 132;
  function _daycareConvertCost(fromRoot) {
    return fromRoot === DITTO_SPECIES_ID ? 1 : 2;
  }

  // Apply any pending candy conversions for one slot. Mutates the
  // slot's convertedCount* counters in place; also mutates persistent
  // candy state via writeCandy when a conversion fires. Returns true
  // if the slot was touched (so the caller knows to persist).
  //
  // Conversion semantics:
  //   - convertDir='A' → spend N × rootA candy for 1 × rootB candy
  //   - convertDir='B' → spend N × rootB candy for 1 × rootA candy
  //     where N = 1 when source is Ditto, 2 otherwise
  //   - 1 milestone = 1 conversion attempt
  //   - Milestones expire silently if source candy is insufficient
  //     (the counter still advances; the conversion just doesn't fire)
  function _applyDaycareConversionsToSlot(slot) {
    if (!slot || !slot.convertDir) return false;
    const roots = _daycareConversionRoots(slot);
    if (!roots) return false;
    const earned = _daycareEarnedCount(slot);
    const dir = slot.convertDir;
    const counterKey = (dir === 'A') ? 'convertedCountA' : 'convertedCountB';
    const consumed = slot[counterKey] || 0;
    const pending = earned - consumed;
    if (pending <= 0) return false;
    const fromRoot = (dir === 'A') ? roots.rootA : roots.rootB;
    const toRoot   = (dir === 'A') ? roots.rootB : roots.rootA;
    const candy = readCandyRaw();
    const have = candy[String(fromRoot)] || 0;
    const cost = _daycareConvertCost(fromRoot);
    const possible = Math.min(pending, Math.floor(have / cost));
    if (possible > 0) {
      const spent = possible * cost;
      const next = have - spent;
      if (next > 0) candy[String(fromRoot)] = next;
      else delete candy[String(fromRoot)];
      candy[String(toRoot)] = (candy[String(toRoot)] || 0) + possible;
      writeCandy(candy);
    }
    // Consume all pending milestones whether or not they fired — the
    // toggle means "convert if able at each tick", not "bank
    // conversions for later".
    slot[counterKey] = earned;
    return true;
  }

  // CSS for a single candy cell from candies.png at an arbitrary
  // display size — _lootIconStyle hardcodes PILL_CELL_PX (28), but
  // the daycare convert buttons want smaller (22). Same math, just
  // parameterised.
  function _candyIconStyle(rootId, px) {
    const col = (rootId || 0) % CANDY_SHEET_COLS;
    const row = Math.floor((rootId || 0) / CANDY_SHEET_COLS);
    return `background-image: url('${BUNDLED_BASE}/candies.png');`
      + `background-size: ${px * CANDY_SHEET_COLS}px ${px * CANDY_SHEET_ROWS}px;`
      + `background-position: -${col * px}px -${row * px}px;`
      + `background-repeat: no-repeat;`
      + `image-rendering: pixelated;`
      + `image-rendering: crisp-edges;`
      + `width: ${px}px; height: ${px}px;`
      + `display: inline-block;`;
  }

  // One conversion toggle button. `side` is 'A' (left, A→B) or 'B'
  // (right, B→A). Visualises the conversion rate explicitly: N source
  // candies stacked on top, an arrow, one target candy below — where
  // N = _daycareConvertCost(fromRoot) (1 for Ditto, 2 otherwise).
  // Active state is set via `slot.convertDir`. Icons shrink to 18 px
  // so the stack stays compact enough to flank the 72 px sprite.
  function _convertBtnHtml(slot, rootA, rootB, side) {
    const isActive = slot && slot.convertDir === side;
    const fromRoot = (side === 'A') ? rootA : rootB;
    const toRoot   = (side === 'A') ? rootB : rootA;
    const cost = _daycareConvertCost(fromRoot);
    const cls = 'daycare-convert-btn' + (isActive ? ' active' : '');
    const ICON_PX = 18;
    const fromStyle = _candyIconStyle(fromRoot, ICON_PX);
    const toStyle   = _candyIconStyle(toRoot, ICON_PX);
    const fromName = global.Species ? global.Species.nameFor(fromRoot) : `#${fromRoot}`;
    const toName   = global.Species ? global.Species.nameFor(toRoot)   : `#${toRoot}`;
    const label = `Convert ${fromName} candy to ${toName} candy (${cost} → 1 per 500 m)`;
    let sourceIcons = '';
    for (let i = 0; i < cost; i++) {
      sourceIcons += `<span class="convert-icon" style="${fromStyle}" aria-hidden="true"></span>`;
    }
    return `<button class="${cls}" type="button" data-convert-side="${side}"`
      + ` aria-pressed="${isActive ? 'true' : 'false'}"`
      + ` aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">`
      + sourceIcons
      + `<span class="convert-arrow" aria-hidden="true">↓</span>`
      + `<span class="convert-icon" style="${toStyle}" aria-hidden="true"></span>`
      + `</button>`;
  }

  function _daycareUnclaimedLoot(slot) {
    const claimed = new Set((slot && slot.claimed) || []);
    const total = _daycareEarnedCount(slot);
    const out = [];
    for (let n = 1; n <= total; n++) {
      if (claimed.has(n)) continue;
      const loot = _daycareLootAt(slot, n);
      if (loot) out.push({ n, loot });
    }
    return out;
  }

  // Click handler for individual loot pills — module-scope so the
  // initial render's queryAll-and-bind pass AND the
  // cc-daycare-loot-tick listener (which dynamically inserts
  // pills) can share the same function.
  function _onPillClick(e, pill) {
    e.stopPropagation();
    if (pill.classList.contains('claimed')) return;
    const slotEl = pill.closest('.daycare-slot[data-id]');
    if (!slotEl) return;
    const slotId = slotEl.dataset.id;
    const n = parseInt(pill.dataset.n, 10);
    if (!Number.isFinite(n)) return;
    const granted = claimDaycareLoot(slotId, n);
    if (!granted) return;
    pill.classList.add('claimed');
    let removed = false;
    const finish = () => {
      if (removed) return;
      removed = true;
      if (pill.parentNode) pill.parentNode.removeChild(pill);
    };
    pill.addEventListener('transitionend', (ev) => {
      if (ev.propertyName === 'width') finish();
    });
    // Safety net (reduced-motion, ancestor display:none, etc.).
    setTimeout(finish, 320);
  }

  // Per-slot loot row: a horizontal strip of pills below the
  // creature's name + distance. The strip is width-capped so only
  // the first ~4 pills fit; any extras are clipped by the row's
  // overflow:hidden, with a "···" ellipsis overlay at the right
  // edge (toggled via the .has-overflow class added in JS after
  // measuring the rendered row's scroll width). Empty row still
  // rendered when no loot pending so the slot's vertical layout
  // doesn't jitter when the last pill is claimed.
  function _daycareLootRowHtml(slot) {
    const visible = _daycareUnclaimedLoot(slot);
    if (!visible.length) {
      return `<div class="daycare-slot-loot" aria-label="no daycare loot ready"></div>`;
    }
    const pills = visible.map(({ n, loot }) => {
      const style = _lootIconStyle(loot);
      const cls = `daycare-loot-pill loot-kind-${loot.kind}`;
      return `<button class="${cls}" type="button" data-n="${n}" `
        + `style="${style}" `
        + `title="${escapeHtml(loot.label)}" `
        + `aria-label="claim ${escapeHtml(loot.label)}"></button>`;
    }).join('');
    return `<div class="daycare-slot-loot">${pills}</div>`;
  }


  // Claim every unclaimed milestone on this slot in one shot.
  // Returns the list of granted item metas (most recent first) so
  // the caller can surface a brief confirmation if desired.
  function claimAllDaycareLoot(slotId) {
    if (!slotId) return [];
    const arr = readDaycareSlots();
    const idx = arr.findIndex((s) => s.id === slotId);
    if (idx < 0) return [];
    const slot = arr[idx];
    const total = _daycareEarnedCount(slot);
    const claimed = new Set(slot.claimed || []);
    const granted = [];
    const newClaimed = [...claimed];
    for (let n = 1; n <= total; n++) {
      if (claimed.has(n)) continue;
      const loot = _daycareLootAt(slot, n);
      if (!_grantLoot(loot)) continue;
      newClaimed.push(n);
      granted.push(loot);
    }
    if (!granted.length) return [];
    arr[idx] = {
      ...slot,
      claimed: newClaimed.sort((a, b) => a - b),
    };
    writeDaycareSlots(arr);
    return granted;
  }

  function _normalizeSlot(v) {
    if (typeof v === 'string' && v) {
      return {
        id: v, addedAt: Date.now(), distM: 0, claimed: [],
        convertDir: null, convertedCountA: 0, convertedCountB: 0,
      };
    }
    if (v && typeof v === 'object' && typeof v.id === 'string' && v.id) {
      // `claimed` is the set of milestone indices (1, 2, 3, ...) the
      // user has tapped to collect. Stored as a sorted dedup'd array
      // so the JSON shape stays small and stable across saves.
      const rawClaimed = Array.isArray(v.claimed) ? v.claimed : [];
      const claimed = Array.from(new Set(
        rawClaimed.filter((n) => Number.isInteger(n) && n >= 1)
      )).sort((a, b) => a - b);
      // Candy conversion: tri-state direction toggle. When non-null,
      // each milestone tick (every DAYCARE_LOOT_MILESTONE_M metres)
      // attempts to spend 2 of the source family's candy for 1 of the
      // target's. Mutually exclusive — at most one direction active.
      // The two `convertedCount*` counters track how many milestones
      // each direction has consumed (regardless of whether the
      // conversion succeeded — milestones expire silently if the
      // player ran out of source candy at that moment).
      const dir = (v.convertDir === 'A' || v.convertDir === 'B') ? v.convertDir : null;
      return {
        id: v.id,
        addedAt: typeof v.addedAt === 'number' ? v.addedAt : Date.now(),
        distM: typeof v.distM === 'number' && v.distM >= 0 ? v.distM : 0,
        claimed,
        convertDir: dir,
        convertedCountA: Number.isInteger(v.convertedCountA) && v.convertedCountA >= 0
          ? v.convertedCountA : 0,
        convertedCountB: Number.isInteger(v.convertedCountB) && v.convertedCountB >= 0
          ? v.convertedCountB : 0,
      };
    }
    return null;
  }

  function readDaycareSlots() {
    try {
      const raw = localStorage.getItem(DAYCARE_SLOTS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      const cleaned = [];
      const seen = new Set();
      for (const v of arr) {
        const slot = _normalizeSlot(v);
        if (!slot || seen.has(slot.id)) continue;
        seen.add(slot.id);
        cleaned.push(slot);
        if (cleaned.length >= DAYCARE_SLOT_COUNT) break;
      }
      return cleaned;
    } catch { return []; }
  }
  function writeDaycareSlots(arr) {
    // Any write invalidates the id-snapshot used by isInDaycare so a
    // subsequent read sees the new state immediately, not the stale
    // cached Set from before the mutation.
    _daycareIdsCache = null;
    try {
      localStorage.setItem(DAYCARE_SLOTS_KEY,
        JSON.stringify(arr.slice(0, DAYCARE_SLOT_COUNT)));
    } catch {}
  }
  // Microtask-scoped Set of currently-occupied slot ids. Built once per
  // filter pass instead of paying the full readDaycareSlots cost (JSON
  // parse + normalize + dedup) on every isInDaycare check. Profile pre-
  // cache showed Daycare predicate at ~30µs/call dominating the tag-
  // filter pass; post-cache should drop to one parse per pass.
  let _daycareIdsCache = null;
  function _daycareIds() {
    if (_daycareIdsCache) return _daycareIdsCache;
    const ids = new Set();
    for (const s of readDaycareSlots()) ids.add(s.id);
    _daycareIdsCache = ids;
    queueMicrotask(() => { _daycareIdsCache = null; });
    return _daycareIdsCache;
  }
  function isInDaycare(id) {
    if (!id) return false;
    return _daycareIds().has(id);
  }
  function addToDaycare(id) {
    if (!id) return false;
    const arr = readDaycareSlots();
    if (arr.some((s) => s.id === id)) return false;
    if (arr.length >= DAYCARE_SLOT_COUNT) return false;
    arr.push({ id, addedAt: Date.now(), distM: 0, claimed: [] });
    writeDaycareSlots(arr);
    return true;
  }
  function removeFromDaycare(id) {
    if (!id) return false;
    const arr = readDaycareSlots();
    const idx = arr.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    // Auto-claim any unclaimed loot before deletion — the slot's
    // loot stream is keyed by (id, addedAt, n), so removing wipes
    // both the seed and the user's progress. Harvesting the
    // remaining items first matches the "you earned this by
    // walking" mental model.
    const slot = arr[idx];
    const total = _daycareEarnedCount(slot);
    const claimed = new Set(slot.claimed || []);
    for (let n = 1; n <= total; n++) {
      if (claimed.has(n)) continue;
      _grantLoot(_daycareLootAt(slot, n));
    }
    arr.splice(idx, 1);
    writeDaycareSlots(arr);
    return true;
  }
  function toggleDaycare(id) {
    if (isInDaycare(id)) { removeFromDaycare(id); return false; }
    return addToDaycare(id);
  }

  // Claim milestone N's loot from the slot's stream. Idempotent
  // (claiming an already-claimed N or a not-yet-earned N is a no-op).
  // Returns the item meta on success so the caller can animate +
  // surface a confirmation, or null if nothing was granted.
  function claimDaycareLoot(slotId, n) {
    if (!slotId || !Number.isInteger(n) || n < 1) return null;
    const arr = readDaycareSlots();
    const idx = arr.findIndex((s) => s.id === slotId);
    if (idx < 0) return null;
    const slot = arr[idx];
    if (n > _daycareEarnedCount(slot)) return null;
    const claimed = Array.isArray(slot.claimed) ? slot.claimed : [];
    if (claimed.includes(n)) return null;
    const loot = _daycareLootAt(slot, n);
    if (!_grantLoot(loot)) return null;
    arr[idx] = {
      ...slot,
      claimed: [...claimed, n].sort((a, b) => a - b),
    };
    writeDaycareSlots(arr);
    return loot;
  }

  // Settings → "Repopulate daycare test loot": wipe `claimed` on
  // every slot. Same `addedAt` → same loot stream → the user sees
  // the items reappear and can tap them again. Granted items stay
  // in the bag (this regenerates AVAILABLE drops, not deletes
  // already-collected ones — symmetry with how a "reset" UI is
  // typically expected to work).
  function repopulateDaycareTestLoot() {
    const arr = readDaycareSlots();
    let touched = 0;
    for (const s of arr) {
      if (Array.isArray(s.claimed) && s.claimed.length) {
        s.claimed = [];
        touched++;
      }
    }
    writeDaycareSlots(arr);
    return touched;
  }
  // Count of slots currently occupied by captures that STILL EXIST.
  // No release/delete UI exists today, but defensive against future
  // additions (or manual storage edits): a stale ID shouldn't lock
  // out new daycare entries by counting toward the limit.
  function _liveDaycareCount() {
    const slots = readDaycareSlots();
    let n = 0;
    for (const s of slots) if (findCreature(s.id)) n++;
    return n;
  }

  // Built-in tags are NOT stored on the capture record — they're
  // computed from a predicate (or from external state, in the case
  // of interactive ones like Daycare). They render alongside user
  // tags everywhere (Tags menu, detail-view picker, inventory filter
  // row). Schema:
  //   name        : display label and stable identifier.
  //   description : copy shown in the Tags menu.
  //   predicate(c): returns whether the tag is APPLIED to this
  //                 creature right now. Used for "applied" styling
  //                 on chips and for filtering.
  //   visible(c)  : (optional) returns whether the tag should be
  //                 SHOWN in the detail picker. Defaults to
  //                 `predicate` — same as the legacy behavior where
  //                 a non-matching predicate also means the chip is
  //                 hidden. Override for interactive tags whose
  //                 displayed condition is different from their
  //                 applied condition (e.g. Daycare shows a chip
  //                 even when the creature isn't yet in the daycare,
  //                 as long as there's a free slot).
  //   onToggle(c) : (optional) called when the user taps the chip.
  //                 Implies the chip is interactive (built-ins
  //                 without onToggle stay read-only).
  // Add new ones by appending here.
  // "Evolved" predicate helper. A species counts as evolved iff it's
  // reachable forward from its candy root — so Pichu (pre-base baby)
  // is NOT evolved, Pikachu (candy root, base) is NOT evolved, and
  // Raichu (post-candy-root) IS evolved. The candyRootFor() walk
  // already encodes "babies are skipped"; we just lift that into a
  // boolean. Memoized per species id because the tag predicate runs
  // across every capture during filter re-renders.
  const _isEvolvedCache = new Map();
  function _isEvolvedSpecies(idx) {
    if (idx == null) return false;
    if (_isEvolvedCache.has(idx)) return _isEvolvedCache.get(idx);
    if (!global.Species || !global.Species.evolutionsFor
        || !global.Species.familyOf) return false;
    const root = candyRootFor(idx);
    if (root == null || root === idx) {
      _isEvolvedCache.set(idx, false);
      return false;
    }
    // BFS forward from the candy root. Reaching idx means it's a
    // post-base form; not reaching it means it's a pre-base baby
    // (Pichu, Cleffa, etc.) which we deliberately don't count.
    const seen = new Set([root]);
    const queue = [root];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === idx) {
        _isEvolvedCache.set(idx, true);
        return true;
      }
      for (const e of global.Species.evolutionsFor(cur)) {
        if (seen.has(e.target)) continue;
        seen.add(e.target);
        queue.push(e.target);
      }
    }
    _isEvolvedCache.set(idx, false);
    return false;
  }

  const BUILTIN_TAGS = [
    {
      name: 'Pure',
      description: 'Same species on both sides (no fusion).',
      predicate: (c) => c && c.speciesA != null && c.speciesA === c.speciesB,
    },
    {
      name: 'Glitch',
      description: 'A glitch pokémon — a solo special, not a fusion.',
      predicate: (c) => isSoloCreature(c),
    },
    {
      name: 'Shiny',
      description: 'Rolled shiny when first encountered (rare).',
      predicate: (c) => c && typeof c.shinyVariant === 'number',
    },
    {
      name: 'Hatched',
      description: 'Hatched from an egg rather than caught in the wild.',
      predicate: (c) => c && c.fromEgg === true,
    },
    {
      name: 'Evolvable',
      description: 'Has an available evolution you can afford right now.',
      predicate: (c) => {
        if (!c || c.speciesA == null || c.speciesB == null) return false;
        const evos = fusionEvolutionsFor(c.speciesA, c.speciesB);
        if (!evos.length) return false;
        return evos.some((e) => {
          const srcSpeciesId = e.source === 'A' ? c.speciesA : c.speciesB;
          return _canAffordEvolution(srcSpeciesId, e.method, e.param);
        });
      },
    },
    {
      name: 'Evolved',
      description: 'At least one side is past its base form.',
      predicate: (c) => c
        && (_isEvolvedSpecies(c.speciesA) || _isEvolvedSpecies(c.speciesB)),
    },
    {
      name: 'Radar',
      description: 'Caught from a poké-radar evolved spawn.',
      // Evolved poké-radar spawns mint 'E:'-namespaced spawn ids
      // (see spawns.js); recordCapture persists that on the record,
      // so the namespace is a stable marker. Egg hatches store a null
      // spawnId, so they can't collide.
      predicate: (c) => c && typeof c.spawnId === 'string'
        && c.spawnId.startsWith('E:'),
    },
    {
      name: 'Daycare',
      description: 'In the daycare. Tap on a creature’s detail page to add or remove (max 2 at a time).',
      predicate: (c) => c && c.id != null && isInDaycare(c.id),
      visible: (c) => {
        if (!c || c.id == null) return false;
        // Show the chip when the creature is already in the daycare
        // (so it can be tapped to remove) OR when there's space for
        // it (so it can be tapped to add). Hides itself once the
        // daycare is full and this creature isn't already in it —
        // exactly the gating the user asked for. _liveDaycareCount
        // is used (not raw .length) so a stale ID — slot referencing
        // a deleted capture — doesn't keep the chip hidden.
        return isInDaycare(c.id) || _liveDaycareCount() < DAYCARE_SLOT_COUNT;
      },
      onToggle: (c) => {
        if (!c || c.id == null) return;
        toggleDaycare(c.id);
      },
    },
  ];
  const BUILTIN_TAG_NAMES = new Set(BUILTIN_TAGS.map((b) => b.name));
  // Seed the per-tag perf slot for every built-in declared above.
  // Done here (not at _invPerf init) because BUILTIN_TAGS is defined
  // later in the file.
  for (const b of BUILTIN_TAGS) {
    _invPerf.tagPredicates[b.name] =
      { calls: 0, totalMs: 0, lastMs: 0, maxMs: 0, hits: 0 };
  }
  function isBuiltinTag(name) { return BUILTIN_TAG_NAMES.has(name); }
  function builtinByName(name) {
    return BUILTIN_TAGS.find((b) => b.name === name) || null;
  }
  // Per-predicate timing here is hot — N captures × M built-ins
  // predicates per filter pass, ~10K calls for 2K captures. Inlining
  // performance.now() bookends costs ~100 ns per call (~1 ms per
  // pass), worth it for the visibility into which built-in dominates.
  function builtinTagsForCreature(c) {
    const out = [];
    for (const b of BUILTIN_TAGS) {
      const t0 = performance.now();
      const hit = b.predicate(c);
      const dt = performance.now() - t0;
      const s = _invPerf.tagPredicates[b.name];
      s.calls++;
      s.totalMs += dt;
      s.lastMs = dt;
      if (dt > s.maxMs) s.maxMs = dt;
      if (hit) { s.hits++; out.push(b.name); }
    }
    return out;
  }
  // Whether a built-in tag's CHIP should appear in the picker for a
  // given creature. Defaults to the predicate (matches the legacy
  // "tag only shows when applied" behavior); interactive tags
  // override `visible` to keep the chip available even when the tag
  // isn't currently applied.
  function builtinVisibleForCreature(b, c) {
    const fn = (typeof b.visible === 'function') ? b.visible : b.predicate;
    try { return !!fn(c); } catch { return false; }
  }
  // The full set of tags currently on a creature, combining the user-
  // applied stored tags with any built-ins whose predicate matches.
  // Stored entries that happen to collide with a built-in name (e.g.
  // legacy data from before Pure existed) are filtered out so the
  // built-in's predicate stays authoritative.
  function effectiveTagsForCreature(c) {
    const t0 = performance.now();
    const stored = Array.isArray(c.tags) ? c.tags : [];
    const builtin = builtinTagsForCreature(c);
    const out = Array.from(new Set([
      ...builtin,
      ...stored.filter((t) => !BUILTIN_TAG_NAMES.has(t)),
    ]));
    _perfMark(_invPerf.fn.effectiveTags, t0);
    return out;
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
    const t0 = performance.now();
    const out = readCapturedCreatures().map((e) => ({
      id: e.id,
      // Carry spawnId through so the 'Radar' built-in tag predicate
      // (spawnId starts with 'E:') can see it. Same trap as fromEgg below:
      // the predicates run on THIS normalized object, not the raw stored
      // record, so a dropped field silently disables the tag.
      spawnId: e.spawnId,
      solo: (typeof e.solo === 'string') ? e.solo : null,
      speciesA: e.speciesA,
      speciesB: e.speciesB,
      variant: (typeof e.variant === 'number') ? e.variant : 'auto',
      shinyVariant: (typeof e.shinyVariant === 'number') ? e.shinyVariant : null,
      // Carry the egg-origin flag through so the 'Hatched' built-in tag
      // predicate (c.fromEgg === true) can see it — the predicates run on
      // this normalized object, not the raw stored record, so a dropped
      // field silently disables the tag.
      fromEgg: e.fromEgg === true,
      // Incense-origin flags, for the "From <type> Incense" detail line.
      fromIncense: e.fromIncense === true,
      incenseType: (typeof e.incenseType === 'string') ? e.incenseType : null,
      level: e.level,
      sizeM: e.sizeM,
      name: creatureName(e),
      caughtAt: e.caughtAt,
      tags: Array.isArray(e.tags) ? e.tags.slice() : [],
    }));
    _perfMark(_invPerf.fn.getInventory, t0, { lastSize: out.length });
    return out;
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

  // ── Seen-fusions store ──
  // Pokédex storage: every fusion we've ever opened the battle screen
  // for, even if it wasn't caught. Like _capStore, this is a closure
  // around the in-memory parsed object — readSeenFusions returns the
  // live reference, writeSeenFusions updates cache + persists. There's
  // no other path to localStorage[SEEN_FUSIONS_KEY], so the cache can
  // never get out of sync.
  //
  // The existing read-mutate-write pattern continues to work: callers
  // get the live object, mutate it in place, then writeSeenFusions to
  // commit. With no derived indices to maintain, this is simpler than
  // _capStore — just a cached parse.
  //
  // Captured creatures are backfilled into this set on first read so
  // existing players don't lose history.
  const _seenStore = (() => {
    let _map = null;
    const _writeIdb = _makeIdbWriter(CSTORE_SEEN, () => _map);
    // Authoritative load from a structured object (IDB hydrate, or the
    // legacy localStorage bootstrap in _ensureLoaded).
    function loadFromMap(map) {
      const t0 = performance.now();
      _map = (map && typeof map === 'object') ? map : {};
      _perfMark(_invPerf.fn.seenStoreLoad, t0,
                { lastSize: Object.keys(_map).length });
    }
    function _ensureLoaded() {
      if (_map !== null) return;
      // Pre-hydration safety net — see _capStore._ensureLoaded.
      let parsed = null;
      try {
        const raw = _safeLsGet(SEEN_FUSIONS_KEY);
        parsed = raw ? JSON.parse(raw) : {};
      } catch { parsed = {}; }
      loadFromMap(parsed);
    }
    function _persist() {
      if (!_cstoreHydrated) return;  // never clobber before hydrate
      _writeIdb();
    }
    return {
      loadFromMap,
      get() { _ensureLoaded(); return _map; },
      set(map) {
        // Used by callers that build a fresh object (rare). The live-
        // reference + mutate-then-commit pattern uses commit() instead.
        _map = (map && typeof map === 'object') ? map : {};
        _persist();
      },
      // Persist the current cache. Callers that mutated the live ref
      // returned by get() call this to commit.
      commit() { _ensureLoaded(); _persist(); },
    };
  })();
  if (typeof window !== 'undefined') window._seenStore = _seenStore;

  // Both stores now exist — start the async IDB hydration (+ one-time
  // localStorage→IDB migration) immediately, at script-eval time. This is
  // many seconds before any user gesture can mutate the collection, so
  // the in-memory caches are populated well before the first catch/read.
  _hydrateCStore();

  function readSeenFusions() {
    const t0 = performance.now();
    const out = _seenStore.get();
    _perfMark(_invPerf.fn.readSeenFusions, t0,
              { lastSize: Object.keys(out).length });
    return out;
  }
  function writeSeenFusions(map) {
    // If the caller passed back the live reference (the read-mutate-
    // write pattern), this is just commit + persist. If they passed a
    // fresh object, replace the cache.
    if (map === _seenStore.get()) _seenStore.commit();
    else _seenStore.set(map);
  }
  // Resolve + persist a first-sighting's POI/place during idle time, off
  // the encounter critical path (see markFusionSeen). Re-reads the store
  // so it writes onto the latest state; bails if the entry vanished or was
  // already enriched.
  function _deferSeenPlaceEnrich(key, lat, lng) {
    const run = () => {
      const poiApi = global.CreatureCollectAPI;
      if (!poiApi) return;
      const seen = readSeenFusions();
      const rec = seen[key];
      if (!rec || rec.poi !== undefined) return; // gone, or already enriched
      rec.poi = poiApi.findNearestNamedPoi ? (poiApi.findNearestNamedPoi(lat, lng) || null) : null;
      rec.place = poiApi.findNearestPlace ? (poiApi.findNearestPlace(lat, lng) || null) : null;
      writeSeenFusions(seen);
    };
    const ric = global.requestIdleCallback;
    if (typeof ric === 'function') ric(run, { timeout: 2000 });
    else setTimeout(run, 0);
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
        // POI + place resolution is a linear scan over every loaded POI
        // (haversine each) — up to ~1s with a big POI set. It only feeds
        // the pokédex "first seen here" sub-view, which is read much
        // later, so running it here would stall the battle screen from
        // even appearing on the first sighting of a fusion. Defer it to
        // idle time; it persists itself once resolved.
        _deferSeenPlaceEnrich(key, spawn.lat, spawn.lng);
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
  // custom variant indices. Sources: seenFusions[key].variants (every
  // fusion the trainer has opened a battle screen for) ∪ the captures
  // store's variant index (every variant they've actually caught).
  // O(1) per fusion lookup — used to be a full scan of the captures
  // array per call, which was the pokédex first-render hotspot.
  function readSeenVariants(a, b) {
    const seen = readSeenFusions();
    const key = `${a}-${b}`;
    const out = _capStore.variantKeysForFusion(a, b);
    if (seen[key] && seen[key].variants) {
      for (const k of Object.keys(seen[key].variants)) out.add(k);
    }
    return out;
  }
  // Shiny styles (0-based palette indices) the trainer has for a fusion:
  // the shinyVariant of every capture of (a, b), UNIONed with any persisted
  // in seenFusions[key].shinyVariants. The persisted set is how an
  // evolved-away shiny (whose capture is no longer stored as (a, b)) still
  // lights up the pre-evolution's dex row. Mirrors readSeenVariants.
  // Normalize a persisted shiny entry to { variant, shinyVariant }. Tolerates
  // the legacy bare-number form (art variant unknown → null = best-available).
  function _normShinyEntry(e) {
    if (typeof e === 'number') return { variant: null, shinyVariant: e };
    if (e && typeof e.shinyVariant === 'number') {
      return {
        variant: (typeof e.variant === 'number') ? e.variant : null,
        shinyVariant: e.shinyVariant,
      };
    }
    return null;
  }
  // Add a (art variant, shiny style) pair to a seenFusions entry's
  // shinyVariants list, deduped by the pair. Returns true if it changed.
  function _addShinyToEntry(entry, variant, shinyVariant) {
    if (typeof shinyVariant !== 'number') return false;
    if (!Array.isArray(entry.shinyVariants)) entry.shinyVariants = [];
    const v = (typeof variant === 'number') ? variant : null;
    for (const e of entry.shinyVariants) {
      const n = _normShinyEntry(e);
      if (n && n.shinyVariant === shinyVariant && n.variant === v) return false;
    }
    entry.shinyVariants.push({ variant: v, shinyVariant });
    return true;
  }
  // Shiny (art variant, shiny style) pairs the trainer has for a fusion, so
  // each shiny renders at the ART variant it was actually caught at — not a
  // generic one. Live captures of (a, b) carry their own variant; persisted
  // credits (evolved-away shinies) carry the pre-evolution art variant when
  // known (null → best-available). Deduped by (variant, shinyVariant).
  // Returns [{ variant, shinyVariant }, ...].
  function readSeenShinyVariants(a, b) {
    const out = [];
    const keys = new Set();
    const push = (variant, shinyVariant) => {
      if (typeof shinyVariant !== 'number') return;
      const v = (typeof variant === 'number') ? variant : null;
      const k = `${v}|${shinyVariant}`;
      if (keys.has(k)) return;
      keys.add(k);
      out.push({ variant: v, shinyVariant });
    };
    for (const c of readCapturedCreatures()) {
      if (c && c.speciesA === a && c.speciesB === b && typeof c.shinyVariant === 'number') {
        push(c.variant, c.shinyVariant);
      }
    }
    const seen = readSeenFusions();
    const arr = seen[`${a}-${b}`] && seen[`${a}-${b}`].shinyVariants;
    if (Array.isArray(arr)) {
      for (const e of arr) { const n = _normShinyEntry(e); if (n) push(n.variant, n.shinyVariant); }
    }
    return out;
  }
  // Persist a shiny (art variant + style) onto an ALREADY-SEEN fusion's dex
  // entry (no-op for unseen fusions, so we never mint phantom entries). Used
  // by the evolve hook — so evolving a shiny doesn't erase the shiny from the
  // pre-evolution dex row — and by the one-time lineage backfill.
  function markFusionShinySeen(a, b, variant, shinyVariant) {
    if (a == null || b == null || typeof shinyVariant !== 'number') return;
    const seen = readSeenFusions();
    const entry = seen[`${a}-${b}`];
    if (!entry) return;
    if (_addShinyToEntry(entry, variant, shinyVariant)) writeSeenFusions(seen);
  }
  // Mark a fusion as one the trainer HAS caught but no longer owns — because
  // they evolved their only copy away (performEvolution transforms the capture
  // in place, so isFusionOwned goes false). Drives the encounter screen's
  // "Fresh" badge: re-catching such a fusion is a re-acquisition, not a first
  // catch. Only augments an already-seen entry (the pre-evolution form was seen
  // when it was caught), so it never mints a phantom dex row. Not set for
  // still-owned fusions — those are covered by isFusionOwned directly.
  function markFusionCaughtAway(a, b) {
    if (a == null || b == null) return;
    const seen = readSeenFusions();
    const entry = seen[`${a}-${b}`];
    if (!entry || entry.caught) return;
    entry.caught = true;
    writeSeenFusions(seen);
  }
  // Losslessly merge an imported seenFusions map into the current one (backup
  // restore). New fusions are copied whole; for a fusion already known we keep
  // the earliest firstSeen / latest lastSeen, UNION the art variants and shiny
  // variants, adopt an imported favorite only when there's no local one, and
  // fill in the "first seen here" location when the local side lacks it.
  // Mutates and returns `current`.
  function mergeSeenFusions(current, incoming) {
    if (!current || typeof current !== 'object') current = {};
    if (!incoming || typeof incoming !== 'object') return current;
    for (const key of Object.keys(incoming)) {
      const val = incoming[key];
      if (!val || typeof val !== 'object') continue;
      const cur = current[key];
      if (!cur) { current[key] = val; continue; }
      if (val.firstSeen && (!cur.firstSeen || val.firstSeen < cur.firstSeen)) cur.firstSeen = val.firstSeen;
      if (val.lastSeen && (!cur.lastSeen || val.lastSeen > cur.lastSeen)) cur.lastSeen = val.lastSeen;
      // Union art variants (map vKey -> earliest-seen timestamp).
      if (val.variants && typeof val.variants === 'object') {
        if (!cur.variants || typeof cur.variants !== 'object') cur.variants = {};
        for (const vk of Object.keys(val.variants)) {
          const ts = val.variants[vk];
          if (cur.variants[vk] == null || (typeof ts === 'number' && ts < cur.variants[vk])) {
            cur.variants[vk] = ts;
          }
        }
      }
      // Union shiny (art variant, style) pairs; tolerate legacy bare numbers.
      if (Array.isArray(val.shinyVariants)) {
        if (!Array.isArray(cur.shinyVariants)) cur.shinyVariants = [];
        for (const e of val.shinyVariants) {
          const n = _normShinyEntry(e);
          if (!n) continue;
          const dup = cur.shinyVariants.some((x) => {
            const m = _normShinyEntry(x);
            return m && m.variant === n.variant && m.shinyVariant === n.shinyVariant;
          });
          if (!dup) cur.shinyVariants.push({ variant: n.variant, shinyVariant: n.shinyVariant });
        }
      }
      // Adopt an imported favorite only when there's no local choice.
      if (val.favoriteArt && !cur.favoriteArt) cur.favoriteArt = val.favoriteArt;
      // "Caught then evolved away" is a monotonic fact — OR it in (drives the
      // encounter "Fresh" badge; see markFusionCaughtAway).
      if (val.caught) cur.caught = true;
      // Fill in "first seen here" location when the local side lacks it.
      if (cur.lat == null && val.lat != null) {
        cur.lat = val.lat; cur.lng = val.lng;
        if (val.poi != null) cur.poi = val.poi;
        if (val.place != null) cur.place = val.place;
      }
    }
    return current;
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
      // Variant is now canonicalized to 'auto' | <number> at store
      // load time, so anything already in either shape is migrated.
      if (typeof c.variant === 'number' || c.variant === 'auto') continue;
      if (c.speciesA == null || c.speciesB == null) continue;
      const cnt = await countFor(c.speciesA, c.speciesB);
      const slot = cnt > 0 ? 0 : 'auto';
      c.variant = slot;
      const fkey = `${c.speciesA}-${c.speciesB}`;
      if (!seen[fkey]) seen[fkey] = { firstSeen: (c.caughtAt && c.caughtAt.timestamp) || Date.now() };
      if (!seen[fkey].variants) seen[fkey].variants = {};
      const vKey = slot === 'auto' ? 'auto' : String(slot);
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

  // Manual migration helper exposed via Settings → "Re-mark custom
  // art" button. For every capture currently flagged as autogen
  // (c.variant === 'auto') where the cell now reports custom variants,
  // promote the capture to slot 0 (the artist's primary) and mark
  // that variant as seen in seenFusions. Idempotent: re-running does
  // nothing once every capture is in sync. Temporary — added to clean
  // up legacy captures created before getCellVariantCount could
  // consult the bundled cells.json. Safe to remove once the user has
  // run it. Returns { scanned, promoted } so the button can show a
  // result count.
  async function remarkAutogenCapturesWithCustomArt() {
    if (!global.Sprites || !global.Sprites.getCellVariantCount) {
      return { scanned: 0, promoted: 0 };
    }
    const list = readCapturedCreatures();
    const seen = readSeenFusions();
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
    let scanned = 0, promoted = 0;
    for (const c of list) {
      if (c.variant !== 'auto') continue;
      if (c.speciesA == null || c.speciesB == null) continue;
      scanned++;
      const cnt = await countFor(c.speciesA, c.speciesB);
      if (!cnt || cnt <= 0) continue;
      c.variant = 0;
      const fkey = `${c.speciesA}-${c.speciesB}`;
      if (!seen[fkey]) seen[fkey] = { firstSeen: (c.caughtAt && c.caughtAt.timestamp) || Date.now() };
      if (!seen[fkey].variants) seen[fkey].variants = {};
      if (!seen[fkey].variants['0']) {
        seen[fkey].variants['0'] = (c.caughtAt && c.caughtAt.timestamp) || Date.now();
      }
      promoted++;
    }
    if (promoted > 0) {
      writeCapturedCreatures(list);
      writeSeenFusions(seen);
    }
    return { scanned, promoted };
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
  // Linear chain of a species' pre-evolutions, most-evolved first:
  // [x, pre(x), pre(pre(x)), ..., root]. Evolution branches going FORWARD
  // (Eevee → many), but each form has a single direct pre-evolution, so
  // walking backward is always linear. Returns [x] when data isn't loaded.
  function _ancestorChain(x) {
    const S = global.Species;
    if (!S || !S.familyOf || !S.evolutionsFor) return [x];
    const fam = S.familyOf(x);
    const directPre = (t) => {
      for (const f of fam) {
        if (f === t) continue;
        for (const e of S.evolutionsFor(f)) if (e.target === t) return f;
      }
      return null;
    };
    const chain = [x];
    const guard = new Set([x]);
    let cur = x;
    for (;;) {
      const p = directPre(cur);
      if (p == null || guard.has(p)) break;
      chain.push(p); guard.add(p); cur = p;
    }
    return chain;
  }
  // The pre-evolution fusions a shiny (a, b) capture passed through, on the
  // path the trainer actually took. Per-side ancestor chains are linear; the
  // only branching is the ORDER the two sides were evolved. Every form the
  // trainer evolved through was marked seen, so we walk the 2-D lattice back
  // from (a, b) preferring pre-evo nodes that are SEEN — reconstructing the
  // real path. On genuine ambiguity (both branch nodes seen) we pick one.
  // Returns [[a', b'], ...], excluding (a, b) itself.
  function _shinyLineageAncestors(a, b, seenHas) {
    const chainA = _ancestorChain(a);   // [a, ..., rootA]
    const chainB = _ancestorChain(b);
    let ia = 0, ib = 0;
    const out = [];
    while (ia < chainA.length - 1 || ib < chainB.length - 1) {
      const canA = ia < chainA.length - 1;
      const canB = ib < chainB.length - 1;
      let goA;
      if (canA && canB) {
        const seenA = seenHas(chainA[ia + 1], chainB[ib]);
        const seenB = seenHas(chainA[ia], chainB[ib + 1]);
        goA = seenA || !seenB;   // follow the seen branch; tie / neither → pick A
      } else {
        goA = canA;
      }
      if (goA) ia++; else ib++;
      out.push([chainA[ia], chainB[ib]]);
    }
    return out;
  }
  // One-time backfill: for every shiny the trainer evolved themselves (a
  // non-radar spawn id — an evolved 'E:' spawn was caught pre-evolved, not
  // evolved by us), credit the shiny style to the earlier lineage forms that
  // are already in the dex. So a shiny caught as a base form still shows on
  // that base form's shiny row after it was evolved. Batched (one write).
  // Gated on the evolution data being loaded AND a flag, so it runs once.
  const SHINY_LINEAGE_BACKFILL_KEY = 'cc.shinyLineageBackfill.v2';
  function backfillShinyLineage() {
    if (localStorage.getItem(SHINY_LINEAGE_BACKFILL_KEY) === '1') return;
    const S = global.Species;
    if (!S || !S.familyOf) return;
    // familyOf collapses to [x] until the evolutions JSON loads; probe a
    // known multi-stage line (Bulbasaur) so we don't flip the flag early.
    if (S.familyOf(1).length <= 1) return;   // data not ready — retry next boot
    const seen = readSeenFusions();
    const seenHas = (x, y) =>
      Object.prototype.hasOwnProperty.call(seen, `${x}-${y}`);
    let changed = false;
    for (const c of readCapturedCreatures()) {
      if (!c || typeof c.shinyVariant !== 'number') continue;
      if (typeof c.spawnId === 'string' && c.spawnId.startsWith('E:')) continue;
      if (c.speciesA == null || c.speciesB == null) continue;
      for (const [a2, b2] of _shinyLineageAncestors(c.speciesA, c.speciesB, seenHas)) {
        const entry = seen[`${a2}-${b2}`];
        if (!entry) continue;   // only credit fusions already in the dex
        // The base-form art variant was overwritten when the creature evolved,
        // so it's unrecoverable here — credit with null (best-available art).
        // Shinies evolved from now on keep their exact art variant via the
        // evolve hook's markFusionShinySeen(c.variant, ...).
        if (_addShinyToEntry(entry, null, c.shinyVariant)) changed = true;
      }
    }
    if (changed) writeSeenFusions(seen);
    localStorage.setItem(SHINY_LINEAGE_BACKFILL_KEY, '1');
  }
  // One-time backfill: trainers who evolved things BEFORE the "Fresh" badge
  // shipped have pre-evolution forms that were caught-then-evolved-away but
  // carry no `caught` flag (that's only set by the evolve hook going forward).
  // Reconstruct them from the lineage of every current capture and flag their
  // dex rows, so re-encounters read "Fresh" instead of "New". Best-effort:
  // mirrors backfillShinyLineage, including the `E:` skip (an already-evolved
  // spawn was caught post-evolution, so its earlier forms were never caught by
  // the trainer). Batched (one write); gated on the evolution data + a flag.
  const CAUGHT_AWAY_BACKFILL_KEY = 'cc.caughtAwayBackfill.v1';
  function backfillCaughtAwayLineage() {
    if (localStorage.getItem(CAUGHT_AWAY_BACKFILL_KEY) === '1') return;
    const S = global.Species;
    if (!S || !S.familyOf) return;
    if (S.familyOf(1).length <= 1) return;   // data not ready — retry next boot
    const seen = readSeenFusions();
    const seenHas = (x, y) =>
      Object.prototype.hasOwnProperty.call(seen, `${x}-${y}`);
    let changed = false;
    for (const c of readCapturedCreatures()) {
      if (!c || c.speciesA == null || c.speciesB == null) continue;
      if (typeof c.spawnId === 'string' && c.spawnId.startsWith('E:')) continue;
      for (const [a2, b2] of _shinyLineageAncestors(c.speciesA, c.speciesB, seenHas)) {
        const entry = seen[`${a2}-${b2}`];
        if (!entry || entry.caught) continue;   // only credit fusions already in the dex
        entry.caught = true;
        changed = true;
      }
    }
    if (changed) writeSeenFusions(seen);
    localStorage.setItem(CAUGHT_AWAY_BACKFILL_KEY, '1');
  }
  function isFusionSeen(a, b) {
    return readSeenFusions().hasOwnProperty(`${a}-${b}`);
  }
  // Has the trainer seen this exact (a, b, variant) combination? Used
  // by the evolution preview to silhouette future variants the trainer
  // hasn't witnessed yet, even when other variants of the same fusion
  // are known. `variant` is the canonical capture shape — 'auto' for
  // autogen, numeric for a custom slot. Legacy callers passing null
  // (pre-normalization) are still tolerated.
  function hasSeenVariant(a, b, variant) {
    const seen = readSeenVariants(a, b);
    if (variant === 'auto' || variant === null) return seen.has('auto');
    if (typeof variant === 'number' && variant >= 0) return seen.has(String(variant));
    return false;
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
  // The single sprite to show for a fusion wherever it appears as one image
  // (dex header, pokédex grid, completion dex): the trainer's chosen favorite
  // art if set, else the default — the lowest seen art variant (non-shiny),
  // or best-available when nothing's been discovered. Returns
  // { variant, shinyVariant }: variant is a number|null|undefined that
  // SpriteStore.showSprite understands, shinyVariant is a number|null.
  function favoriteArtFor(a, b) {
    const entry = readSeenFusions()[`${a}-${b}`];
    const fav = entry && entry.favoriteArt;
    if (fav && typeof fav === 'object' && ('variant' in fav || 'shinyVariant' in fav)) {
      return {
        variant: (typeof fav.variant === 'number') ? fav.variant : null,
        shinyVariant: (typeof fav.shinyVariant === 'number') ? fav.shinyVariant : null,
      };
    }
    return { variant: pickPreferredSeenVariant(a, b), shinyVariant: null };
  }
  // Set (or replace) a fusion's favorite art. Only an already-seen fusion can
  // have one; `variant` is an art variant (number, or null/'auto' for autogen)
  // and `shinyVariant` is null (normal) or a shiny style index. Returns true
  // when it changed the store.
  function setFavoriteArt(a, b, variant, shinyVariant) {
    const seen = readSeenFusions();
    const entry = seen[`${a}-${b}`];
    if (!entry) return false;
    entry.favoriteArt = {
      variant: (typeof variant === 'number') ? variant : null,
      shinyVariant: (typeof shinyVariant === 'number') ? shinyVariant : null,
    };
    writeSeenFusions(seen);
    return true;
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
  // Do we already own (have captured) this fusion?
  function isFusionOwned(a, b) {
    return caughtFusionsSet().has(`${a}-${b}`);
  }
  // Do we own (have captured) this specific variant ("art") of a fusion?
  // `variant`: a non-negative number (custom slot) or 'auto'/null (autogen) —
  // keyed the same way as the seen/captured variant stores.
  function ownsVariant(a, b, variant) {
    const owned = _capStore.variantKeysForFusion(a, b);
    if (typeof variant === 'number' && variant >= 0) return owned.has(String(variant));
    return owned.has('auto');
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

  // ── Solo (special) creatures ──────────────────────────────────────
  // A creature is either a fusion pair (speciesA × speciesB) or a SOLO
  // special: `solo: '<id>'` with speciesA/speciesB null. Solo defs live
  // in static/specials.js (global.Specials). These helpers are the ONLY
  // sanctioned way to branch on the distinction — pairs flow through
  // them unchanged.
  function isSoloCreature(c) { return !!(c && typeof c.solo === 'string' && c.solo); }
  // Composite key for dex/variant indexing: pairs 'a-b', solos 'solo:<id>'.
  function creatureKeyOf(c) {
    if (isSoloCreature(c)) return 'solo:' + c.solo;
    return c ? `${c.speciesA}-${c.speciesB}` : '';
  }
  function creatureName(c) {
    if (isSoloCreature(c)) {
      const s = global.Specials && global.Specials.get(c.solo);
      return s ? s.name : c.solo;
    }
    return fusionName(c.speciesA, c.speciesB);
  }
  function creatureTypes(c) {
    if (isSoloCreature(c)) {
      const s = global.Specials && global.Specials.get(c.solo);
      return s ? s.types.slice() : [];
    }
    return fusionTypesFor(c.speciesA, c.speciesB);
  }
  // Art routing: solos render the bundled full-PNG (optional shiny
  // transform via the solo palette table); pairs go through SpriteStore.
  // Mirrors showSprite's generation guard + readyClass/onReady opts.
  async function showCreatureArt(img, c, opts) {
    if (!img) return;
    if (!isSoloCreature(c)) {
      return global.SpriteStore.showSprite(img, c.speciesA, c.speciesB, c.variant, opts);
    }
    opts = opts || {};
    const gen = (img._spriteGen || 0) + 1;
    img._spriteGen = gen;
    const url = global.Specials && global.Specials.spriteUrl(c.solo);
    if (!url) return;
    let finalUrl = url;
    const sv = (typeof opts.shinyVariant === 'number' && opts.shinyVariant >= 0)
      ? opts.shinyVariant
      : ((typeof c.shinyVariant === 'number' && c.shinyVariant >= 0) ? c.shinyVariant : null);
    if (sv != null && global.ShinyStore && global.ShinyStore.transformSoloBlob) {
      try {
        const blob = await (await fetch(url)).blob();
        const shinyUrl = await global.ShinyStore.transformSoloBlob(blob, c.solo, sv);
        if (shinyUrl) finalUrl = shinyUrl;
      } catch (_) { /* fall back to base art */ }
    }
    if (img._spriteGen !== gen) return;
    img.src = finalUrl;
    if (opts.readyClass) img.classList.add(opts.readyClass);
    if (typeof opts.onReady === 'function') {
      try { opts.onReady(img); }
      catch (e) { console.error('showCreatureArt/onReady', e); }
    }
  }

  // Dex bookkeeping for a solo sighting/catch — same seenFusions entry
  // shape as fusions, keyed 'solo:<id>'.
  function markSoloSeen(soloId, variant) {
    if (!soloId) return;
    const seen = readSeenFusions();
    const key = 'solo:' + soloId;
    const now = Date.now();
    if (!seen[key]) seen[key] = { firstSeen: now };
    seen[key].lastSeen = now;
    if (variant !== undefined) {
      if (!seen[key].variants) seen[key].variants = {};
      const vKey = (typeof variant === 'number' && variant >= 0) ? String(variant) : 'auto';
      if (!seen[key].variants[vKey]) seen[key].variants[vKey] = now;
    }
    writeSeenFusions(seen);
  }

  // Pokémon types, colors and the effectiveness chart live in ONE place:
  // static/types.js (global.Types). The old local copies (TYPE_COLORS,
  // _TYPE_REDUCED, _TYPE_STRONG) were deleted — use the Types API.
  // ALL_TYPES is a local snapshot for the loops below; list order is
  // contractual (see types.js).
  const ALL_TYPES = global.Types.list();

  // One of the egg's types being neutral-or-effective vs the incense type
  // qualifies it (a dual-type egg only needs one workable type).
  function eggTypesNeutralOrEffectiveVs(eggTypes, incenseType) {
    if (!eggTypes || !eggTypes.length) return false;
    for (const et of eggTypes) {
      // Unknown attacking type → treat as neutral (don't hide eggs).
      if (!global.Types.isValid(et) || !global.Types.isReduced(et, incenseType)) return true;
    }
    return false;
  }
  // Incense yield from an egg: 1 base, +1 for each of the egg's (deduped)
  // types that is super-effective against the incense type → 1× / 2× / 3×.
  function craftMultiplier(eggTypes, incenseType) {
    let mult = 1;
    if (!eggTypes) return mult;
    for (const et of eggTypes) {
      if (global.Types.isSuperEffective(et, incenseType)) mult += 1;
    }
    return mult;
  }

  // ── Incense items (one per type) ──
  // Crafted from eggs (Bag → Craft). The capture/use mechanic lands
  // later; for now they're collectible bag items whose art is a shaded
  // orb in the type colour.
  function _incenseKey(type) { return 'incense_' + type.toLowerCase(); }
  function _incenseOrbIcon(color) {
    // Shaded orb: a top-left highlight, the type colour, and a dark rim.
    const svg =
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'>" +
      "<defs>" +
      "<radialGradient id='o' cx='35%' cy='30%' r='75%'>" +
      "<stop offset='0%' stop-color='#ffffff' stop-opacity='0.95'/>" +
      "<stop offset='42%' stop-color='" + color + "'/>" +
      "<stop offset='100%' stop-color='" + color + "'/>" +
      "</radialGradient>" +
      "<radialGradient id='r' cx='50%' cy='50%' r='50%'>" +
      "<stop offset='62%' stop-color='#000000' stop-opacity='0'/>" +
      "<stop offset='100%' stop-color='#000000' stop-opacity='0.5'/>" +
      "</radialGradient>" +
      "</defs>" +
      "<circle cx='20' cy='20' r='18' fill='url(#o)'/>" +
      "<circle cx='20' cy='20' r='18' fill='url(#r)'/>" +
      "</svg>";
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }
  for (const t of ALL_TYPES) {
    ITEMS[_incenseKey(t)] = {
      name: global.Types.displayName(t) + ' Incense',
      desc: 'Use it for 30 min of extra ' + global.Types.displayName(t)
        + '-type spawns (double shiny rate). Crafted from eggs.',
      icon: _incenseOrbIcon(global.Types.color(t)),
      incenseType: t,
    };
  }

  // ── Active incense state ──
  // Which incense is currently burning + when it started. Lives in
  // localStorage (tiny) AND the save file, so it keeps running across app
  // restarts until its 30 min are up. Pushed to the spawn engine via
  // Spawns.setActiveIncense; the engine handles expiry + generation.
  const ACTIVE_INCENSE_KEY = 'cc.activeIncense.v1';
  function _incenseDurationMs() {
    return (global.Spawns && global.Spawns.INCENSE_DURATION_MS) || (30 * 60 * 1000);
  }
  function readActiveIncense() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(ACTIVE_INCENSE_KEY) || 'null'); } catch { s = null; }
    if (!s || typeof s.type !== 'string' || typeof s.startMs !== 'number') return null;
    if (!global.Types.isValid(s.type)) return null;
    if (Date.now() >= s.startMs + _incenseDurationMs()) {
      // Expired — clean up so the bag/overlay stop treating it as active.
      try { localStorage.removeItem(ACTIVE_INCENSE_KEY); } catch (_) {}
      if (global.Spawns && global.Spawns.setActiveIncense) global.Spawns.setActiveIncense(null);
      return null;
    }
    return { type: s.type, startMs: s.startMs };
  }
  function incenseRemainingMs() {
    const a = readActiveIncense();
    return a ? Math.max(0, a.startMs + _incenseDurationMs() - Date.now()) : 0;
  }
  function _pushActiveIncenseToSpawns() {
    if (global.Spawns && global.Spawns.setActiveIncense) {
      global.Spawns.setActiveIncense(readActiveIncense());
    }
  }
  // Consume one incense of `type` from the bag and start a fresh 30-min
  // window (replacing any active incense — only one burns at a time).
  function activateIncense(type) {
    const key = _incenseKey(type);
    const bag = readBag();
    if ((bag[key] || 0) < 1) return false;
    bag[key] -= 1;
    if (bag[key] <= 0) delete bag[key];
    writeBag(bag);
    const state = { type, startMs: Date.now() };
    try { localStorage.setItem(ACTIVE_INCENSE_KEY, JSON.stringify(state)); } catch (_) {}
    if (global.Spawns && global.Spawns.setActiveIncense) global.Spawns.setActiveIncense(state);
    if (typeof refreshSpawnOverlay === 'function') refreshSpawnOverlay();
    return true;
  }
  // Save-import hook (index.html): adopt an active incense from a backup,
  // honouring its original start time so the remaining window is correct.
  function setActiveIncenseState(state) {
    if (!state || typeof state.type !== 'string' || typeof state.startMs !== 'number') return;
    if (!global.Types.isValid(state.type)) return;
    if (Date.now() >= state.startMs + _incenseDurationMs()) return; // already expired
    try { localStorage.setItem(ACTIVE_INCENSE_KEY, JSON.stringify({ type: state.type, startMs: state.startMs })); } catch (_) {}
    _pushActiveIncenseToSpawns();
    if (typeof refreshSpawnOverlay === 'function') refreshSpawnOverlay();
  }

  function typeChipsHtml(types) {
    if (!types || !types.length) return '';
    return `<div class="type-chips">` + types.map((t) => {
      const bg = global.Types.color(t);
      const label = global.Types.displayName(t);
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
    // Built-ins to show: any whose `visible` (defaulting to predicate)
    // returns true for this creature. Interactive built-ins (Daycare)
    // keep their chip in the picker even when not currently applied,
    // so the user can tap to add.
    const visibleBuiltins = BUILTIN_TAGS
      .filter((b) => builtinVisibleForCreature(b, creature))
      .map((b) => b.name);
    const userTags = readTags().filter((t) => !isBuiltinTag(t));
    const names = [...visibleBuiltins, ...userTags];
    if (!names.length) {
      return `<div class="detail-tags-empty">No tags yet \u2014 create some in the Tags menu.</div>`;
    }
    const applied = new Set(effectiveTagsForCreature(creature));
    const chips = names.map((t) => {
      const builtin = builtinByName(t);
      const isUser = !builtin;
      const interactive = !!(builtin && typeof builtin.onToggle === 'function');
      const classes = ['detail-tag-chip'];
      if (applied.has(t)) classes.push('applied');
      if (builtin) classes.push('builtin');
      if (interactive) classes.push('interactive');
      // Read-only built-ins intentionally have no data-tag so the
      // click handler bails — they're visual-only chips. User tags
      // and interactive built-ins both carry data-tag and rely on
      // the dispatch in the click handler to do the right thing.
      const attrs = (isUser || interactive)
        ? `data-tag="${escapeHtml(t)}"` : '';
      return `<button class="${classes.join(' ')}" type="button" ${attrs}>${escapeHtml(t)}</button>`;
    }).join('');
    return `<div class="detail-tags">${chips}</div>`;
  }

  // Inline candy tally for an opened pokémon. Pivots both species to
  // their family roots first, then dedupes — so Charizard×Charmander
  // shows a single Charmander-candy pip (both sides share a root)
  // and Growlithe×Vulpix shows both. Uses readCandy so opening a
  // detail/fusion view triggers the lazy schema migration.
  //
  // Visual: icon-only — `<candy icon> ×N` for each root. The icon
  // is a CSS sprite slice from the bundled candies.png sheet,
  // sized down (24px) to fit inline alongside the surrounding
  // detail view text. Species name lives in title/aria-label for
  // hover tooltips and screen readers.
  function candyTallyHtml(speciesA, speciesB) {
    if (speciesA == null || speciesB == null) return '';
    const candy = readCandy();
    const rootA = candyRootFor(speciesA);
    const rootB = candyRootFor(speciesB);
    const roots = (rootA === rootB) ? [rootA] : [rootA, rootB];
    const parts = roots.map((idx) => {
      const name = speciesNameFor(idx);
      const count = candy[String(idx)] || 0;
      const label = `${name} candy`;
      const col = idx % CANDY_SHEET_COLS;
      const row = Math.floor(idx / CANDY_SHEET_COLS);
      // Tally-icon CSS uses a 24px cell; positions scale to that.
      const TALLY_PX = 24;
      return `<span class="candy-tally-pip">`
        + `<span class="candy-tally-icon" `
        + `style="background-position: -${col * TALLY_PX}px -${row * TALLY_PX}px" `
        + `title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></span>`
        + ` <b>×${count}</b>`
        + `</span>`;
    });
    return `<div class="candy-tally">${parts.join(' · ')}</div>`;
  }

  // Detail-view candy line for ANY creature: pairs use the family-root
  // tally above; solos show their own 'solo:<id>' bucket with the
  // special's sprite as the icon (it's not in the candies.png sheet).
  function candyTallyForCreature(c) {
    if (!isSoloCreature(c)) return candyTallyHtml(c.speciesA, c.speciesB);
    const candy = readCandy();
    const count = candy['solo:' + c.solo] || 0;
    const s = global.Specials && global.Specials.get(c.solo);
    const name = s ? s.name : c.solo;
    const url = (global.Specials && global.Specials.spriteUrl(c.solo)) || '';
    const label = `${name} candy`;
    return `<div class="candy-tally"><span class="candy-tally-pip">`
      + `<img class="candy-tally-icon-solo" src="${escapeHtml(url)}" `
      + `title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" alt="">`
      + ` <b>×${count}</b>`
      + `</span></div>`;
  }

  // The bundled data set covers gen 1 (1-150) PLUS specific gen-2/3/4
  // additions chosen to bring every type to >=5 base-form non-legendary
  // representatives. The pool is sparse (gen 1 contiguous + scattered
  // extras using PIF's internal ids, which diverge from national dex
  // numbering for gen 3+ — see species_pool.py for the canonical
  // mapping). Keep this in lockstep with species_pool.py +
  // SPAWNABLE_SPECIES_A in spawns.js.
  const SUPPORTED_SPECIES_EXTRAS = [
    // Gen 2 families (PIF id = national for these)
    179, 180, 181,    // Mareep, Flaaffy, Ampharos
    200, 255,         // Misdreavus, Mismagius
    214,              // Heracross
    215, 262,         // Sneasel, Weavile
    220, 221, 274,    // Swinub, Piloswine, Mamoswine
    227,              // Skarmory
    209, 210,         // Snubbull, Granbull
    198, 256,         // Murkrow, Honchkrow
    228, 229,         // Houndour, Houndoom
    // Gen 3 families (PIF ids — diverge from national)
    300,              // Mawile
    390, 391, 333,    // Aron, Lairon, Aggron
    405, 357,         // Shuppet, Banette
    311, 312, 313,    // Duskull, Dusclops, Dusknoir
    427, 428, 429,    // Snorunt, Glalie, Froslass
    395, 396, 336,    // Bagon, Shelgon, Salamence
    291, 292, 293,    // Beldum, Metang, Metagross
    310,              // Absol         (Dark, standalone)
    421,              // Sableye       (Dark/Ghost, standalone)
    // Gen 4 families
    295,              // Spiritomb
    297, 298, 299,    // Gible, Gabite, Garchomp
    // Eeveelutions — completes Eevee's family (Vaporeon/Jolteon/Flareon
    // already in gen 1).
    196,              // Espeon        (Psychic)
    197,              // Umbreon       (Dark)
    271,              // Leafeon       (Grass)
    272,              // Glaceon       (Ice)
    339,              // Sylveon       (Fairy)
    // Nosepass line
    325, 326,         // Nosepass, Probopass
  ];
  const SUPPORTED_SPECIES_SET = (() => {
    const s = new Set();
    for (let i = 1; i <= 150; i++) s.add(i);
    for (const id of SUPPORTED_SPECIES_EXTRAS) s.add(id);
    return s;
  })();
  const SUPPORTED_SPECIES_MAX = 429;  // max id in the set, for callers that need a numeric ceiling

  // Gen-1 legendaries (Articuno/Zapdos/Moltres/Mewtwo/Mew). Kept in lockstep
  // with GEN1_LEGENDARY_IDS in spawns.js. Completion is scored against
  // NON-legendary partners only: legendary spawns are ~1/16000, so requiring
  // their fusions would make 100% (and its shiny bonus) unreachable. Legendary
  // species still get their own — uncounted — row in the completion dex.
  const LEGENDARY_SPECIES_SET = new Set([144, 145, 146, 150, 151]);
  function isLegendarySpecies(id) { return LEGENDARY_SPECIES_SET.has(id); }
  // How many supported species actually count toward completion — the partner
  // pool and the aggregate %. Excludes the legendaries in the pool
  // (Articuno/Zapdos/Moltres/Mewtwo; Mew 151 isn't a supported species anyway).
  const SUPPORTED_NONLEG_COUNT = (() => {
    let n = 0;
    for (const id of SUPPORTED_SPECIES_SET) if (!isLegendarySpecies(id)) n++;
    return n;
  })();

  function fusionEvolutionsFor(a, b) {
    if (!global.Species || !global.Species.fusionEvolutionsFor) return [];
    const all = global.Species.fusionEvolutionsFor(a, b);
    // Drop any evolution whose target species is outside the supported
    // pool. Both sides of the resulting fusion must be in-pool — even
    // one out-of-pool half breaks sprite / type / name lookups.
    return all.filter((e) =>
      SUPPORTED_SPECIES_SET.has(e.newA) && SUPPORTED_SPECIES_SET.has(e.newB));
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

  // Hygiene: clear `<img>` src attributes on detaching elements so a
  // recycled row doesn't briefly show its old sprite when it scrolls
  // back into view. URLs themselves are owned by SpriteStore — no
  // revoke happens here, since the same URL may still be in use by
  // other consumers (the world map, the battle screen, the pokédex).
  // SpriteStore evicts URLs via LRU on its own.
  function revokeObjectUrlsIn(el) {
    if (!el) return;
    el.querySelectorAll('img').forEach((img) => {
      const src = img.src;
      if (src && src.startsWith('blob:')) {
        img.removeAttribute('src');
      }
    });
  }

  function famHasContent(famA, famB) {
    return Array.isArray(famA) && Array.isArray(famB)
      && (famA.length > 1 || famB.length > 1);
  }

  // Build the family-tree grid: rows are B's family, columns are A's
  // family. Each cell is a small fusion sprite. Sprites load via the
  // shared cache — same URL flows through map markers, battle screen,
  // inventory and pokédex tiles, so re-opening a previously-viewed
  // family tree is instant.
  function renderFamilyGrid(gridEl, famA, famB, currentA, currentB) {
    revokeObjectUrlsIn(gridEl);
    gridEl.style.gridTemplateColumns = `repeat(${famA.length}, 1fr)`;
    const cells = [];
    for (let row = 0; row < famB.length; row++) {
      for (let col = 0; col < famA.length; col++) {
        const a = famA[col];
        const b = famB[row];
        const isCurrent = a === currentA && b === currentB;
        // Use the real seen status (NOT isCurrent) so the cell for the
        // fusion you're viewing silhouettes when you haven't seen it —
        // matching the black silhouette shown at the top of the entry.
        const seen = isFusionSeen(a, b);
        const title = (global.Species && seen)
          ? `${global.Species.nameFor(a)} × ${global.Species.nameFor(b)}`
          : '???';
        const cls = `family-cell`
          + (isCurrent ? ' current' : '')
          + (seen ? '' : ' silhouette')
          + (isCurrent ? '' : ' tappable');
        // Non-current cells become buttons that navigate to the
        // corresponding fusion's pokédex entry. Silhouettes are still
        // tappable — the destination view will show ??? data, which is
        // consistent with the cell itself being a silhouette.
        const tapAttrs = isCurrent ? '' : ' role="button" tabindex="0"';
        cells.push(`<div class="${cls}" `
          + `data-a="${a}" data-b="${b}" `
          + `title="${escapeHtml(title)}"${tapAttrs}>`
          + `<span class="family-cell-placeholder" aria-hidden="true">·</span>`
          + `<img alt="">`
          + `</div>`);
      }
    }
    gridEl.innerHTML = cells.join('');
    // Wire up tap-to-navigate. Pulls the cell's (a, b) and pushes the
    // fusion sub-view onto the stack — the existing carousel + back-
    // button machinery handles popping back to this entry. Pass
    // expandFamily so the destination opens with its OWN family tree
    // already unfolded — the user is obviously interested in the
    // family relationships if they just tapped a family tile.
    gridEl.querySelectorAll('.family-cell.tappable').forEach((cell) => {
      const a = +cell.dataset.a;
      const b = +cell.dataset.b;
      const navigate = () => showFusionView(a, b, null, null, { expandFamily: true });
      cell.addEventListener('click', navigate);
      cell.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          navigate();
        }
      });
    });
    if (!global.SpriteStore) return;
    gridEl.querySelectorAll('.family-cell').forEach((cell) => {
      const a = +cell.dataset.a;
      const b = +cell.dataset.b;
      const img = cell.querySelector('img');
      if (!img) return;
      // Honor the fusion's favorite art (falls back to lowest seen variant)
      // so the family-tree mosaic matches what's shown up top / in the dex,
      // including a favorited shiny.
      const fav = favoriteArtFor(a, b);
      global.SpriteStore.showSprite(img, a, b, fav.variant, {
        shinyVariant: fav.shinyVariant,
        onReady: () => cell.classList.add('ready'),
      });
    });
  }

  // Render an evolution method (Level 16, Item THUNDERSTONE, etc.) into
  // a short, human-readable label. Best-effort formatting — unrecognized
  // methods fall back to "<Method> <param>".
  function formatEvolutionMethod(method, param) {
    const item = _formatItemName;
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

  // ── Evolution requirements ──
  // We replace PIF's native level / item / move conditions with a flat
  // candy economy. Cost scales with where the source sits in its
  // evolution line:
  //   3+ stage chain (e.g. Bulbasaur → Ivysaur → Venusaur):
  //     base form's evolution costs  25 candy
  //     middle form's evolution     50 candy
  //     (a hypothetical 4-stage line's third evolution would cost 100)
  //   2-stage chain (e.g. Tangela / Lapras / Magikarp):
  //     50 candy default, with Magikarp → Gyarados special-cased to 100
  //     as the "rare big payoff" so the cheap fishing-rod catch doesn't
  //     make the legendary trivial.
  // Methods that natively require an item (`Item`, `TradeItem`,
  // `DayHoldItem`) keep the item requirement on top of the candy cost.
  // Level / move / stat-based methods drop their condition entirely —
  // candy is the only currency.
  const MAGIKARP_SPECIES_ID = 129;
  const _EVO_ITEM_METHODS = new Set(['Item', 'TradeItem', 'DayHoldItem']);

  // BFS forward from the family root, recording each species' depth
  // from root and the max depth reached. Used to bucket the evolving
  // species into 25 / 50 / 100 candy tiers.
  function _chainPositionFor(srcSpeciesId) {
    if (!global.Species || !global.Species.familyOf || !global.Species.evolutionsFor) {
      return { totalStages: 1, depthFromRoot: 0 };
    }
    const family = global.Species.familyOf(srcSpeciesId);
    if (!family || !family.length) return { totalStages: 1, depthFromRoot: 0 };
    const root = family[0];
    const depth = new Map();
    depth.set(root, 0);
    const queue = [root];
    let maxDepth = 0;
    while (queue.length) {
      const cur = queue.shift();
      const d = depth.get(cur);
      if (d > maxDepth) maxDepth = d;
      for (const e of global.Species.evolutionsFor(cur)) {
        const t = e.target;
        if (depth.has(t)) continue;
        depth.set(t, d + 1);
        queue.push(t);
      }
    }
    return {
      totalStages: maxDepth + 1,
      depthFromRoot: depth.has(srcSpeciesId) ? depth.get(srcSpeciesId) : 0,
    };
  }

  function _evolutionCandyCost(srcSpeciesId) {
    if (srcSpeciesId === MAGIKARP_SPECIES_ID) return 100;
    const { totalStages, depthFromRoot } = _chainPositionFor(srcSpeciesId);
    if (totalStages >= 3) {
      const tier = [25, 50, 100];
      return tier[depthFromRoot] != null ? tier[depthFromRoot] : 100;
    }
    return 50;
  }

  function _evolutionItemRequirement(method, param) {
    if (!_EVO_ITEM_METHODS.has(method)) return null;
    if (typeof param !== 'string' || !param) return null;
    return param;
  }

  // ── Hold-to-confirm evolve overlay ──
  // One DOM node, lazily built on first use, reused for every
  // confirmation. Hold-to-confirm semantics: yes button drives a CSS
  // ring fill over EVOLVE_CONFIRM_HOLD_MS; releasing early cancels;
  // full hold fires the committed evolve action. Keep the CSS
  // transition duration on .evolve-yes.holding .ring-progress in
  // sync with this constant so the ring completes exactly as the
  // timer fires.
  const EVOLVE_CONFIRM_HOLD_MS = 2500;
  let _evolveConfirmEl = null;
  let _evolveHoldTimer = null;
  let _evolveCurrent = null;

  function _ensureEvolveConfirmEl() {
    if (_evolveConfirmEl) return _evolveConfirmEl;
    const root = document.createElement('div');
    root.id = 'ccEvolveConfirm';
    root.innerHTML = `
      <div class="evolve-card" role="dialog" aria-modal="true">
        <div class="evolve-title" data-evolve-title></div>
        <div class="evolve-arrow" data-evolve-arrow></div>
        <div class="evolve-cost" data-evolve-cost></div>
        <div class="evolve-actions">
          <button type="button" class="evolve-no" data-evolve-no>No</button>
          <button type="button" class="evolve-yes" data-evolve-yes>
            <svg viewBox="0 0 100 100" aria-hidden="true">
              <circle class="ring-track" cx="50" cy="50" r="40"></circle>
              <circle class="ring-progress" cx="50" cy="50" r="40"></circle>
            </svg>
            <span>Yes</span>
          </button>
        </div>
        <div class="evolve-hint">Hold "Yes" to confirm</div>
      </div>
    `;
    document.body.appendChild(root);

    const noBtn = root.querySelector('[data-evolve-no]');
    const yesBtn = root.querySelector('[data-evolve-yes]');
    noBtn.addEventListener('click', closeEvolveConfirm);
    // Cancel-on-backdrop: tap outside the card dismisses.
    root.addEventListener('click', (e) => {
      if (e.target === root) closeEvolveConfirm();
    });

    const cancelHold = () => {
      if (_evolveHoldTimer) {
        clearTimeout(_evolveHoldTimer);
        _evolveHoldTimer = null;
      }
      yesBtn.classList.remove('holding');
    };
    const startHold = (e) => {
      // Ignore extra pointers (e.g. second finger) once a hold is live.
      if (_evolveHoldTimer) return;
      e.preventDefault();
      yesBtn.classList.add('holding');
      _evolveHoldTimer = setTimeout(async () => {
        _evolveHoldTimer = null;
        const current = _evolveCurrent;
        closeEvolveConfirm();
        if (!current) return;
        try {
          const updated = await performEvolution({
            creatureId: current.creatureId,
            srcSpeciesId: current.srcSpeciesId,
            method: current.method,
            param: current.param,
            newA: current.newA,
            newB: current.newB,
          });
          if (!updated) return;
          // Re-render the detail view in place so the player sees the
          // evolved creature immediately. findCreature re-reads the
          // capture record we just rewrote, so the rendered species /
          // sprite / evolution options all reflect the new state.
          const fresh = findCreature(current.creatureId);
          if (fresh) {
            try { renderDetail(fresh); } catch (e) {
              _logCreatureError('evolve/renderDetail', e);
            }
          }
        } catch (e) {
          _logCreatureError('evolve/perform', e);
        }
      }, EVOLVE_CONFIRM_HOLD_MS);
    };
    // Pointer events cover mouse + touch + pen; the cancel variants
    // catch finger-slide-off-button and gesture interruptions.
    yesBtn.addEventListener('pointerdown', startHold);
    yesBtn.addEventListener('pointerup', cancelHold);
    yesBtn.addEventListener('pointercancel', cancelHold);
    yesBtn.addEventListener('pointerleave', cancelHold);
    yesBtn.addEventListener('lostpointercapture', cancelHold);

    // Esc to close — useful on desktop where the user has a keyboard.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && root.classList.contains('show')) {
        closeEvolveConfirm();
      }
    });

    _evolveConfirmEl = root;
    return root;
  }

  function openEvolveConfirm({ creatureId, srcSpeciesId, targetName, method, param, newA, newB }) {
    const root = _ensureEvolveConfirmEl();
    const cost = _evolutionCandyCost(srcSpeciesId);
    const rootId = candyRootFor(srcSpeciesId);
    const rootName = (rootId != null && speciesNameFor) ? speciesNameFor(rootId) : '';
    const srcName = speciesNameFor ? speciesNameFor(srcSpeciesId) : `#${srcSpeciesId}`;
    root.querySelector('[data-evolve-title]').textContent = 'Evolve?';
    root.querySelector('[data-evolve-arrow]').textContent =
      `${srcName} → ${targetName}`;

    const item = _evolutionItemRequirement(method, param);
    const ICON_PX = 24;
    const col = (rootId || 0) % CANDY_SHEET_COLS;
    const row = Math.floor((rootId || 0) / CANDY_SHEET_COLS);
    const candyIcon =
      `<span class="candy-tally-icon" `
      + `style="background-position: -${col * ICON_PX}px -${row * ICON_PX}px" `
      + `title="${escapeHtml(rootName + ' candy')}" `
      + `aria-label="${escapeHtml(rootName + ' candy')}"></span>`
      + ` <b>×${cost}</b>`;
    const costEl = root.querySelector('[data-evolve-cost]');
    if (item) {
      costEl.innerHTML = `${escapeHtml(_formatItemName(item))} + ${candyIcon}`;
    } else {
      costEl.innerHTML = candyIcon;
    }

    _evolveCurrent = { creatureId, srcSpeciesId, targetName, method, param, newA, newB };
    root.classList.add('show');
  }

  function closeEvolveConfirm() {
    if (!_evolveConfirmEl) return;
    if (_evolveHoldTimer) {
      clearTimeout(_evolveHoldTimer);
      _evolveHoldTimer = null;
    }
    const yesBtn = _evolveConfirmEl.querySelector('[data-evolve-yes]');
    if (yesBtn) yesBtn.classList.remove('holding');
    _evolveConfirmEl.classList.remove('show');
    _evolveCurrent = null;
  }

  // Caches `{candy, bag}` for one synchronous chunk of work, then
  // clears itself via a microtask so the next event-loop turn (post-
  // capture, post-evolve, etc.) gets fresh state. Lets the "Evolvable"
  // builtin tag's predicate run across thousands of captures during a
  // filter pass without re-parsing localStorage per check.
  let _affordSnapshot = null;
  function _affordabilitySnapshot() {
    if (_affordSnapshot) return _affordSnapshot;
    _affordSnapshot = { candy: readCandy(), bag: readBag() };
    queueMicrotask(() => { _affordSnapshot = null; });
    return _affordSnapshot;
  }

  // Does the player currently have enough candy + (item if required)
  // to evolve from this species via this method? Used to gate the
  // tap handler on each "Evolves to" row.
  function _canAffordEvolution(srcSpeciesId, method, param) {
    if (srcSpeciesId == null) return false;
    const cost = _evolutionCandyCost(srcSpeciesId);
    const rootId = candyRootFor(srcSpeciesId);
    const { candy, bag } = _affordabilitySnapshot();
    const have = (rootId != null && candy[String(rootId)]) || 0;
    if (have < cost) return false;
    const itemKey = _evolutionItemRequirement(method, param);
    if (itemKey && (bag[itemKey] || 0) < 1) return false;
    return true;
  }

  // Pick the variant slot for the evolved creature, deterministically.
  // The same creature passed in twice (e.g. silhouette preview during
  // detail-view render + actual evolution on confirm) returns the same
  // slot — so the "what you'll evolve into" silhouette matches the
  // sprite the user actually gets.
  //
  // Returns { variant: number|null, autogenOnly: bool }:
  //   - variant is the slot index, or null when the target fusion has
  //     no custom variants at all (autogen).
  //   - autogenOnly mirrors the null-variant case as a boolean so the
  //     caller can render the "autogen art only" badge without
  //     another lookup.
  //
  // Variant selection rule:
  //   - If the source variant has an attributed artist AND the target
  //     fusion has a variant by the SAME artist (string equality),
  //     keep that artist.
  //   - Otherwise pick uniformly via a deterministic PRNG seeded from
  //     the capture id + species pair, so re-running for the same
  //     creature gives the same answer.
  async function _pickEvolvedVariant(c, oldA, oldB, oldVariant, newA, newB) {
    if (!global.Sprites || !global.Sprites.getCellVariantCount) {
      return { variant: 'auto', autogenOnly: true };
    }
    let newCount = 0;
    try { newCount = await global.Sprites.getCellVariantCount(newA, newB); }
    catch { newCount = 0; }
    if (!newCount || newCount <= 0) {
      return { variant: 'auto', autogenOnly: true };
    }

    let oldArtist = null;
    if (typeof oldVariant === 'number' && oldVariant >= 0
        && global.Sprites.getSpriteCreditForSlot) {
      try {
        oldArtist = await global.Sprites.getSpriteCreditForSlot(oldA, oldB, oldVariant);
      } catch { oldArtist = null; }
    }
    if (oldArtist && global.Sprites.getSpriteCreditForSlot) {
      const credits = await Promise.all(
        Array.from({ length: newCount }, (_, s) =>
          global.Sprites.getSpriteCreditForSlot(newA, newB, s).catch(() => null))
      );
      for (let s = 0; s < credits.length; s++) {
        if (credits[s] && credits[s] === oldArtist) {
          return { variant: s, autogenOnly: false };
        }
      }
    }
    // Deterministic uniform pick. Capture id (for spawn captures this
    // already encodes cell + tick, i.e. location + time) plus the
    // species transition makes the seed unique per evolution step.
    const seed = c && c.id != null
      ? `evo|${c.id}|${oldA}-${oldB}|${newA}-${newB}`
      : `evo|anon|${oldA}-${oldB}|${newA}-${newB}|${Math.random()}`;
    const rng = (global.Spawns && global.Spawns.getRng)
      ? global.Spawns.getRng(seed)
      : Math.random;
    return { variant: Math.floor(rng() * newCount), autogenOnly: false };
  }

  // Apply an evolution: deduct candy + (item if required), mutate the
  // capture record's species + variant, mark the new fusion seen.
  // Returns the updated creature object on success, null on failure
  // (e.g. affordability changed mid-confirm). Async because variant
  // picking awaits Sprites.getSpriteCreditForSlot lookups.
  async function performEvolution({ creatureId, srcSpeciesId, method, param, newA, newB }) {
    if (creatureId == null || srcSpeciesId == null) return null;
    if (!_canAffordEvolution(srcSpeciesId, method, param)) return null;

    const list = readCapturedCreatures();
    const idx = list.findIndex((x) => x && x.id === creatureId);
    if (idx < 0) return null;
    const c = list[idx];

    // Resolve the new variant BEFORE mutating anything — if it throws
    // we want to bail without having charged the player. The
    // deterministic seed comes from the capture id, so this returns
    // the same slot the silhouette preview already showed.
    let newVariant = null;
    try {
      const resolved = await _pickEvolvedVariant(
        c, c.speciesA, c.speciesB, c.variant, newA, newB);
      newVariant = resolved.variant;
    } catch (e) {
      _logCreatureError('performEvolution/pickVariant', e);
      return null;
    }

    // Deduct cost. Item first because consumeItem is atomic + returns
    // false on shortfall; candy second so the order matches the
    // affordability check above.
    const itemKey = _evolutionItemRequirement(method, param);
    if (itemKey) {
      if (!consumeItem(itemKey, 1)) return null;
    }
    const cost = _evolutionCandyCost(srcSpeciesId);
    const rootId = candyRootFor(srcSpeciesId);
    if (rootId != null) {
      const candy = readCandyRaw();
      const k = String(rootId);
      const next = (candy[k] || 0) - cost;
      if (next > 0) candy[k] = next;
      else delete candy[k];
      writeCandy(candy);
    }

    // Mutate the capture. Nickname / size / tags / caughtAt all carry
    // over since they're keyed on c.id (untouched). c.name re-derives
    // to the new fusion's canonical name (nicknames still take priority
    // wherever displayName is consulted).
    const updated = {
      ...c,
      speciesA: newA,
      speciesB: newB,
      variant: newVariant,
      name: fusionName(newA, newB),
    };
    list[idx] = updated;
    writeCapturedCreatures(list);

    // Pokédex gets the new fusion (+ its variant) on first evolution.
    try { markFusionSeen(newA, newB, null, newVariant); } catch {}
    // We just evolved our copy of the OLD fusion away. If that was our last one
    // (isFusionOwned(old) now false), a future re-catch of it should read as
    // "Fresh", not "New" — flag its dex row so the encounter screen knows.
    try { markFusionCaughtAway(c.speciesA, c.speciesB); } catch {}
    // If we just evolved a shiny, its capture no longer exists as the OLD
    // fusion — persist the shiny style onto that pre-evolution's dex row so
    // its "Shiny variants" section doesn't lose it. (c still holds the old
    // speciesA/speciesB + shinyVariant; markFusionShinySeen only augments an
    // already-seen entry, and the old form was seen when it was caught.)
    try {
      if (typeof c.shinyVariant === 'number') {
        markFusionShinySeen(c.speciesA, c.speciesB, c.variant, c.shinyVariant);
      }
    } catch {}

    return updated;
  }

  // Compose the requirement HTML shown in the detail-view "Evolves to"
  // rows. Returns HTML (NOT plain text) because we render the family-
  // rooted candy as the same CSS-sprite icon used in the candy tally.
  // The caller must NOT escapeHtml() the result.
  // Examples (rendered):
  //   [candy-icon] ×25
  //   Fire Stone + [candy-icon] ×25
  function formatEvolutionRequirementHtml(srcSpeciesId, method, param) {
    const cost = _evolutionCandyCost(srcSpeciesId);
    const rootId = candyRootFor(srcSpeciesId);
    const rootName = (rootId != null && speciesNameFor)
      ? speciesNameFor(rootId) : '';
    // Same sprite math as candyTallyHtml — 24px cells in the bundled
    // candies.png sheet, positioned by background-position.
    const ICON_PX = 24;
    const col = (rootId || 0) % CANDY_SHEET_COLS;
    const row = Math.floor((rootId || 0) / CANDY_SHEET_COLS);
    const candyLabel = rootName ? `${rootName} candy` : 'candy';
    const tooltip = `${cost} ${candyLabel}`;
    const iconHtml =
      `<span class="candy-tally-icon" `
      + `style="background-position: -${col * ICON_PX}px -${row * ICON_PX}px" `
      + `title="${escapeHtml(tooltip)}" aria-label="${escapeHtml(tooltip)}"></span>`
      + ` <b>×${cost}</b>`;
    const item = _evolutionItemRequirement(method, param);
    if (item) {
      return `${escapeHtml(_formatItemName(item))} + ${iconHtml}`;
    }
    return iconHtml;
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

  // --- Long-press → "Save image" → save a sprite to the phone ----------
  // The detail-view art is a blob: object URL. In the native app the save
  // goes through our SaveImage Capacitor plugin (ios-overrides /
  // android-overrides), which writes straight to the photo library and
  // requests "add photos" access on first use. On mobile web, iOS Safari
  // ignores <a download> for blob URLs *and* the OS's own long-press
  // "Save Image" fails on blob: URLs, so the fallback path there is the
  // Web Share sheet. navigator.share() requires transient user activation,
  // which a setTimeout-driven long-press would have already spent — so the
  // long-press only *reveals* a "Save image" button, and the actual save
  // fires from that button's own tap (a fresh activation). Desktop /
  // Android Chrome fall back to a real download.
  function _safeFileName(s) {
    const base = String(s || 'creature')
      .normalize('NFKD').replace(/[^\w.\- ]+/g, '').trim()
      .replace(/\s+/g, '-').slice(0, 60);
    return base || 'creature';
  }

  // Transient bottom-of-screen notice for save results (no app-wide toast
  // system exists, and this is the only place that needs one).
  function _saveImageNotice(text, ms) {
    const el = document.createElement('div');
    el.className = 'save-image-notice';
    el.textContent = text;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, ms || 2200);
  }

  function _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(r.error || new Error('read failed'));
      r.readAsDataURL(blob);
    });
  }

  async function saveImageToPhone(img, filename) {
    const src = img && img.src;
    if (!src) return;
    const name = _safeFileName(filename) + '.png';
    let blob = null;
    try { blob = await (await fetch(src)).blob(); } catch (_) { /* ignore */ }
    // Native app (iOS/Android Capacitor): save straight into the photo
    // library via our SaveImage plugin — one tap, no share sheet. The
    // plugin requests photo-library ("add photos") access on first use.
    const savePlugin = window.Capacitor && window.Capacitor.Plugins
      && window.Capacitor.Plugins.SaveImage;
    if (blob && savePlugin && typeof savePlugin.saveImage === 'function') {
      try {
        const base64 = await _blobToBase64(blob);
        await savePlugin.saveImage({ base64, filename: name.replace(/\.png$/, '') });
        _saveImageNotice('Saved to Photos ✓');
        return;
      } catch (e) {
        if (e && (e.code === 'DENIED' || /denied/i.test(e.message || ''))) {
          _saveImageNotice('Photo access denied — allow it in Settings to save images', 4200);
          return;
        }
        /* else fall through to share/download */
      }
    }
    // Native share sheet — the reliable "Save to Photos" path on mobile web.
    if (blob && typeof navigator.canShare === 'function') {
      try {
        const file = new File([blob], name, { type: blob.type || 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: name });
          return;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return; // user dismissed the sheet
        /* else fall through to download */
      }
    }
    // Fallback: a real file download (desktop, Android Chrome).
    try {
      const dlUrl = blob ? URL.createObjectURL(blob) : src;
      const a = document.createElement('a');
      a.href = dlUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Only revoke a URL we minted here — never the sprite store's URL.
      if (dlUrl !== src) setTimeout(() => URL.revokeObjectURL(dlUrl), 10000);
    } catch (e) { console.error('saveImageToPhone', e); }
  }

  // Reveal a transient "Save image" button centered over `artEl` after a
  // long press on it. `getFilename()` is read lazily at save time.
  function attachLongPressSave(artEl, img, getFilename) {
    if (!artEl || !img || artEl._lpSaveWired) return;
    artEl._lpSaveWired = true;
    const HOLD_MS = 480;
    const CANCEL_MOVE = 12; // px of drift that counts as a scroll, not a hold
    let timer = null, sx = 0, sy = 0, btn = null, dismissTimer = null;
    let lastPointerType = '';

    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const hide = () => {
      if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
      if (btn) { btn.remove(); btn = null; }
      document.removeEventListener('pointerdown', onOutside, true);
    };
    const onOutside = (e) => { if (btn && !btn.contains(e.target)) hide(); };
    const reveal = () => {
      if (!img.src || btn) return;
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'detail-art-save-btn';
      btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/></svg><span>Save image</span>';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        saveImageToPhone(img, getFilename());
        hide();
      });
      artEl.appendChild(btn);
      dismissTimer = setTimeout(hide, 4000);
      // Bind the outside-tap dismiss on the next tick so this gesture's own
      // trailing pointer events don't immediately close the button.
      setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
    };
    const onDown = (e) => {
      lastPointerType = e.pointerType || '';
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (btn) return; // already showing
      sx = e.clientX; sy = e.clientY;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        try { if (navigator.vibrate) navigator.vibrate(12); } catch (_) { /* no-op */ }
        reveal();
      }, HOLD_MS);
    };
    const onMove = (e) => {
      if (!timer) return;
      if (Math.abs(e.clientX - sx) > CANCEL_MOVE
          || Math.abs(e.clientY - sy) > CANCEL_MOVE) clearTimer();
    };
    artEl.addEventListener('pointerdown', onDown);
    artEl.addEventListener('pointermove', onMove);
    artEl.addEventListener('pointerup', clearTimer);
    artEl.addEventListener('pointercancel', clearTimer);
    // Suppress the native long-press callout (Android WebView / touch) so it
    // doesn't fight our button. Leave desktop right-click ("Save image as")
    // alone — that already works for blob URLs there.
    artEl.addEventListener('contextmenu', (e) => {
      if (lastPointerType && lastPointerType !== 'mouse') e.preventDefault();
    });
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
    // True only during the synthetic `input` event dispatched by
    // pick(). The autocomplete's own input listener checks it and
    // skips paint(), which would otherwise re-show the dropdown
    // immediately (the freshly-filled species name matches itself).
    // Other input listeners (renderPokedex, renderInventory) still
    // fire and re-render the grid normally.
    let _pickInFlight = false;
    function pick(name) {
      input.value = name;
      list.classList.remove('show');
      list.innerHTML = '';
      // Fire `input` so the existing renderPokedex listener re-runs,
      // gated against our own paint re-show.
      _pickInFlight = true;
      try { input.dispatchEvent(new Event('input', { bubbles: true })); }
      finally { _pickInFlight = false; }
    }
    function setActive(idx) {
      const items = list.querySelectorAll('.ac-item');
      items.forEach((el, i) => el.classList.toggle('active', i === idx));
      const el = items[idx];
      if (el) el.scrollIntoView({ block: 'nearest' });
      activeIdx = idx;
    }
    input.addEventListener('input', () => {
      if (_pickInFlight) return;
      paint();
    });
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
    const t0 = performance.now();
    let out;
    try {
      const raw = localStorage.getItem('cc.creatureNicknames');
      out = raw ? JSON.parse(raw) : {};
    } catch { out = {}; }
    _perfMark(_invPerf.fn.readNicknames, t0);
    return out;
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
  // both the Pokédex and the inventory comes from global.Types (the
  // single source of truth — see static/types.js). Pokédex's hardcoded
  // options pre-date this helper and stay as-is to avoid noisy diffs;
  // new surfaces (inventory) use this.
  function typeFilterSelectHtml(id) {
    const opts = ['<option value="">Any</option>'].concat(
      global.Types.list().map((t) => {
        const label = global.Types.displayName(t);
        return `<option value="${t}">${label}</option>`;
      })
    );
    return `<select id="${id}" class="type-filter-select">${opts.join('')}</select>`;
  }
  // Paint a type-filter <select> with the type's canonical color when
  // a real type is selected, or strip the inline styles back to the
  // theme's defaults when it's "any". Defined after the Types registry
  // but referenced by name later — function declaration so it hoists.
  function applyTypeSelectColor(selectEl) {
    if (!selectEl) return;
    const v = selectEl.value;
    const bg = global.Types.isValid(v) ? global.Types.color(v) : undefined;
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
    const t0 = performance.now();
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
    _perfMark(_invPerf.fn.sortedCreatures, t0, { lastSize: copy.length });
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
      /* Sticky corner-cluster buttons: the close X and the back-to-
         top arrow. Both share the same shape, theming, and sticky-
         corner footprint trick (zero layout cost via negative bottom
         margin) so they read as a unified right-edge action cluster.
         Only the horizontal margin and visibility differ. */
      /* Inventory X + scroll-top: shared sticky-corner positioning.
         Visual styling for the X comes from the global .cc-x-btn
         rule (in index.html); the scroll-top isn't a close button
         so it carries its own visual styling below. flex-shrink: 0
         pins both against the column flex container that would
         otherwise compress their heights. */
      #creatureInventory .inventory-x,
      #creatureInventory .scroll-top-btn {
        position: sticky;
        top: 0;
        align-self: flex-end;
        flex-shrink: 0;
      }
      /* Inventory X — only positioning. Negative right margin pushes
         it 8px past the sheet's content edge so it hugs the corner;
         negative bottom margin matches its height (30px) so it
         contributes zero vertical space to the column flow. */
      #creatureInventory .inventory-x {
        margin: 0 -8px -30px 0;
      }
      /* Scroll-top button — minimal: just the ↑ glyph, no border or
         background bubble (matching the close-X minimal look). 25×25
         hit area for tap reliability; the visible arrow is the only
         thing rendered. The 8-direction text-shadow in the sheet's
         bg color keeps the glyph readable when content scrolls
         underneath (this button is sticky-positioned). Hidden until
         .show is added. */
      #creatureInventory .scroll-top-btn {
        display: none;
        background: transparent;
        border: none;
        font-size: 22px;
        line-height: 1;
        cursor: pointer;
        color: var(--ui-text, #111);
        text-shadow:
          -1px -1px 0 var(--ui-bg, #fff), 0 -1px 0 var(--ui-bg, #fff),  1px -1px 0 var(--ui-bg, #fff),
          -1px  0   0 var(--ui-bg, #fff),                                1px  0   0 var(--ui-bg, #fff),
          -1px  1px 0 var(--ui-bg, #fff), 0  1px 0 var(--ui-bg, #fff),  1px  1px 0 var(--ui-bg, #fff);
        box-sizing: border-box;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        min-height: 30px;
        padding: 0;
        font-family: inherit;
        z-index: 5;
        /* 35px right margin leaves room for the X (30px wide + 8px
           offset + small gap) to its right. -30px bottom margin
           matches the height so it contributes zero vertical space. */
        margin: 0 35px -30px 0;
      }
      #creatureInventory .scroll-top-btn.show { display: inline-flex; }
      #creatureInventory .scroll-top-btn:hover {
        color: var(--ui-muted, #888);
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
        display: flex; flex-direction: column; align-items: center;
        /* Pin art at top, stats at bottom; the name floats between
           them. With a fixed card height + justify-content:
           space-between, short names no longer leave a slab of
           empty whitespace under their text — the gap is split
           between art→name and name→stats so it reads balanced.
           Asymmetric vertical padding (10px top / 6px bottom)
           tightens the gap below the stats line. */
        justify-content: space-between;
        gap: 0;
        padding: 10px 6px 6px;
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border-radius: var(--ui-radius, 8px);
        cursor: pointer;
        border: 1px solid transparent;
        transition: transform 0.08s ease, border-color 0.08s ease;
        /* Hardcoded to match virtualizeGrid({ cardHeight: 145 }) — keeps
           the row pitch correct without dynamic measurement. Excess
           content is clipped (rare; happens only on unusually wide
           screens or large fonts). */
        height: 145px;
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
        /* Cap at 2 lines so very long names truncate, but let
           single-line names take only 1.2em — combined with
           justify-content: space-between on the card, the spare
           vertical space splits into balanced gaps above and below
           the name rather than piling up under it. */
        max-height: 2.4em;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        /* Bias the name a touch lower so the gap above it reads
           larger than the gap below — the stats line below feels
           "anchored" to the name, while the art breathes a bit. */
        margin-top: 5px;
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
        display: flex; margin-top: 14px;
      }
      /* Scoped to .actions so the bottom Done button stretches without
         affecting the top-right X (which also carries class="close"
         via .cc-x-btn .inventory-x). */
      #creatureInventory .actions button.close {
        flex: 1;
        padding: 10px 14px; font-size: 14px; cursor: pointer;
      }
      /* Done button only makes sense right after a successful catch,
         when the post-catch detail screen pops up. Every other entry
         to detail-view (taps from inventory, pokédex, fusion view,
         etc.) already has the X close button + back arrow, so the
         Done button would just be redundant. We hide the .actions row
         everywhere by default and only re-show it when the panel
         carries cc-post-catch (set in showDetail({ fromCatch: true })
         and cleared on hide / when popped past the post-catch view). */
      #creatureInventory .detail-view .actions { display: none; }
      #creatureInventory.cc-post-catch .detail-view .actions {
        display: flex;
      }
      #creatureInventory .detail-view { display: none; }
      /* .show -> display:flex via the column-layout rule below. */
      #creatureInventory .detail-back,
      #creatureInventory .pokedex-back,
      #creatureInventory .fusion-back,
      #creatureInventory .candy-back,
      #creatureInventory .daycare-back,
      #creatureInventory .eggs-back,
      #creatureInventory .bag-back,
      #creatureInventory .craft-back,
      #creatureInventory .tags-back,
      #creatureInventory .completion-back,
      #creatureInventory .speciesdex-back {
        background: none;
        border: none;
        color: var(--ui-text, #111);
        /* 8-direction stroke in the panel's bg color so the ← stays
           readable when content scrolls under the sticky button —
           same trick used by the X and scroll-top arrow. */
        text-shadow:
          -1px -1px 0 var(--ui-bg, #fff), 0 -1px 0 var(--ui-bg, #fff),  1px -1px 0 var(--ui-bg, #fff),
          -1px  0   0 var(--ui-bg, #fff),                                1px  0   0 var(--ui-bg, #fff),
          -1px  1px 0 var(--ui-bg, #fff), 0  1px 0 var(--ui-bg, #fff),  1px  1px 0 var(--ui-bg, #fff);
        font-size: 22px;
        line-height: 1;
        cursor: pointer;
        /* Sticky in the top-left corner of the .sheet (matches the
           top-right X / scroll-top arrow). Negative bottom margin
           collapses the layout footprint to zero so the title sits
           at the same Y as the back button (the back floats over
           the title's left edge — short titles never collide). */
        position: sticky;
        top: 0;
        z-index: 5;
        align-self: flex-start;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        min-height: 30px;
        flex-shrink: 0;
        padding: 0;
        margin: 0 0 -30px -4px;
        font-family: inherit;
        /* In flex-column parents (.detail-view / .fusion-view) the
           button stretches to full container width by default, and
           the browser default text-align center on the button puts
           the back arrow in the visual middle. text-align: left
           keeps the full-width hit target while moving the icon
           back to the top-left corner — matches the candy/bag/tags
           layout where the button sits as a natural-width inline
           element in a display:block container. */
        text-align: left;
      }
      #creatureInventory .detail-back:hover,
      #creatureInventory .pokedex-back:hover,
      #creatureInventory .fusion-back:hover,
      #creatureInventory .candy-back:hover,
      #creatureInventory .daycare-back:hover,
      #creatureInventory .eggs-back:hover,
      #creatureInventory .bag-back:hover,
      #creatureInventory .craft-back:hover,
      #creatureInventory .tags-back:hover,
      #creatureInventory .completion-back:hover,
      #creatureInventory .speciesdex-back:hover {
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
        /* Breathing room so an edge-column cell's outward favorite ring
           (box-shadow below) isn't sliced off by the overflow:hidden edges
           of .body-slot / .fusion-view. */
        padding: 2px 4px;
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
      /* Tap a discovered art/shiny cell to make it the fusion's favorite art
         (shown up top + in the pokedex + completion dex). The current
         favorite gets an accent ring. */
      #creatureInventory .variant-cell[data-fav-selectable] { cursor: pointer; }
      #creatureInventory .variant-cell.favorited {
        border-color: var(--ui-accent, #b6896c);
        box-shadow: 0 0 0 2px var(--ui-accent, #b6896c);
        /* Sit above sibling cells so the accent ring is never painted over
           or clipped by a neighbour's white background. */
        position: relative;
        z-index: 1;
      }
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
      /* Sits at the very top of the detail/fusion view, in the
         same Y slot as "Pokémon"/"Pokédex" h3 in their views.
         min-height matches the back-button height (30) so vertical
         alignment is identical across views. */
      #creatureInventory .detail-name-row {
        display: flex; align-items: center; justify-content: center;
        gap: 8px; margin: 0 0 6px;
        min-height: 30px;
      }
      /* When a canonical fused name is present we stack the rows
         vertically: fused name on top, "A × B" species pair below. */
      #creatureInventory .detail-name-row:has(.detail-fused-name) {
        flex-direction: column; gap: 2px;
      }
      /* Match #creatureInventory h3 sizing (16px) so this header
         reads identical to "Pokémon" / "Pokédex". */
      #creatureInventory .detail-name {
        font-size: 16px; font-weight: 700;
        word-break: break-word; text-align: center;
      }
      #creatureInventory .detail-fused-name {
        font-size: 16px; font-weight: 700;
        word-break: break-word; text-align: center;
        color: var(--ui-text, #111);
      }
      /* When the fused name is the primary, the species pair becomes
         a secondary subtitle. */
      #creatureInventory .detail-name.detail-name-sub {
        font-size: 12px; font-weight: 500;
        color: var(--ui-muted, #666);
      }
      /* Below-image species-pair row in the fusion view (when a
         fused name is the primary title above the image). */
      #creatureInventory .detail-species-row {
        text-align: center;
        margin: -4px 0 8px;
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
        font-size: 13px; margin: 6px 0 5px;
      }
      #creatureInventory .detail-stats .sep { opacity: 0.5; }
      #creatureInventory .detail-caught {
        text-align: center; font-size: 12px;
        color: var(--ui-muted, #666); margin: 0 0 6px;
      }
      #creatureInventory .detail-caught-where {
        font-size: 11px;
        margin-top: 1px;
        opacity: 0.85;
      }
      #creatureInventory .detail-caught-place {
        font-size: 11px;
        margin-top: 1px;
        opacity: 0.7;
      }
      #creatureInventory .detail-incense-row {
        display: flex; align-items: center; justify-content: center; gap: 5px;
        font-size: 12px; margin-top: 0; margin-bottom: 7px;
      }
      #creatureInventory .detail-incense-orb { width: 16px; height: 16px; }
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
        display: inline-flex; align-items: center; gap: 3px;
      }
      #creatureInventory .evo-row .evo-req b {
        color: var(--ui-text, #111); font-weight: 600; font-size: 12px;
      }
      /* AUTOGEN ART ONLY badge — appears left of the cost in the
         evo-req cell when the evolution target has no custom variants.
         Heads-up that the user won't get any hand-drawn art for this
         particular evolution. */
      #creatureInventory .evo-row .evo-req .evo-autogen-only {
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        font-weight: 600;
        color: var(--ui-muted, #888);
        opacity: 0.9;
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: 4px;
        padding: 1px 4px;
        margin-right: 4px;
        line-height: 1.2;
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
      #creatureInventory .family-cell.tappable {
        cursor: pointer;
        transition: background 120ms ease, transform 120ms ease;
      }
      #creatureInventory .family-cell.tappable:hover,
      #creatureInventory .family-cell.tappable:focus-visible {
        background: color-mix(in srgb, var(--ui-accent, #3b7fdf) 14%, var(--ui-hover, rgba(0,0,0,0.04)));
        outline: none;
      }
      #creatureInventory .family-cell.tappable:active {
        transform: scale(0.95);
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
      /* Evolution row is tappable when the player can actually afford
         the evolution (right candy + item). Touch devices don't show
         :hover, so we render the affordable state with a persistent
         accent border AND a trailing tap chevron so the user knows
         the row is interactive without having to test-tap it. */
      #creatureInventory .evo-row.evo-ready {
        cursor: pointer;
        border: 1px solid var(--ui-accent, #3b7fdf);
        background: color-mix(in srgb, var(--ui-accent, #3b7fdf) 8%, var(--ui-hover, rgba(0,0,0,0.04)));
        transition: background 120ms ease, transform 120ms ease;
      }
      #creatureInventory .evo-row.evo-ready::after {
        content: '›';
        color: var(--ui-accent, #3b7fdf);
        font-size: 18px;
        font-weight: 700;
        line-height: 1;
        margin-left: 2px;
        flex-shrink: 0;
      }
      #creatureInventory .evo-row.evo-ready:hover,
      #creatureInventory .evo-row.evo-ready:focus-visible {
        background: color-mix(in srgb, var(--ui-accent, #3b7fdf) 16%, transparent);
        outline: none;
      }
      #creatureInventory .evo-row.evo-ready:active {
        transform: scale(0.98);
      }
      /* Hold-to-confirm overlay. Sits above the inventory sheet
         (which is already z-index: 30-ish); inside this overlay we
         keep things simple — centered card, no-button left, yes-button
         on the right with an SVG progress ring that fills as the user
         holds. Releasing before the ring completes cancels. */
      #ccEvolveConfirm {
        position: fixed; inset: 0;
        z-index: 60;
        background: rgba(0, 0, 0, 0.55);
        display: none;
        align-items: center;
        justify-content: center;
        opacity: 0;
        pointer-events: none;
        transition: opacity 150ms ease;
      }
      #ccEvolveConfirm.show {
        display: flex;
        opacity: 1;
        pointer-events: auto;
      }
      #ccEvolveConfirm .evolve-card {
        background: var(--ui-bg, #fff);
        color: var(--ui-text, #111);
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 12px);
        padding: 18px 20px;
        max-width: 320px;
        width: calc(100% - 32px);
        text-align: center;
        box-shadow: var(--ui-shadow, 0 6px 24px rgba(0,0,0,0.25));
      }
      #ccEvolveConfirm .evolve-title {
        font-size: 15px;
        font-weight: 600;
        margin: 0 0 4px;
      }
      #ccEvolveConfirm .evolve-arrow {
        font-size: 13px;
        color: var(--ui-muted, #666);
        margin: 0 0 14px;
      }
      #ccEvolveConfirm .evolve-cost {
        display: inline-flex; align-items: center; gap: 4px;
        margin: 0 0 18px;
        font-size: 13px;
      }
      #ccEvolveConfirm .evolve-cost b {
        font-weight: 600;
        color: var(--ui-text, #111);
        font-size: 14px;
      }
      #ccEvolveConfirm .evolve-actions {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 24px;
      }
      #ccEvolveConfirm .evolve-no {
        background: transparent;
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        color: var(--ui-text, #111);
        border-radius: var(--ui-radius, 8px);
        padding: 8px 14px;
        font-size: 13px;
        font-family: inherit;
        cursor: pointer;
      }
      /* Hold-to-confirm button: SVG ring around a Yes label. The ring
         is two circles — a faint track + the foreground stroke whose
         dashoffset animates from circumference to 0 over the hold
         duration. CSS transition handles the animation; JS only
         toggles a .holding class on press/release. */
      #ccEvolveConfirm .evolve-yes {
        position: relative;
        width: 108px; height: 108px;
        background: var(--ui-accent, #3b7fdf);
        color: var(--ui-accent-text, #fff);
        border: 1px solid var(--ui-accent-border, transparent);
        border-radius: 50%;
        font-size: 15px;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        touch-action: none;     /* prevent scroll-while-hold on iOS */
        user-select: none;
        -webkit-user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
      #ccEvolveConfirm .evolve-yes svg {
        position: absolute; inset: -9px;
        width: calc(100% + 18px); height: calc(100% + 18px);
        transform: rotate(-90deg);  /* progress starts at 12 o'clock */
        pointer-events: none;
      }
      #ccEvolveConfirm .evolve-yes .ring-track {
        fill: none;
        stroke: var(--ui-border, rgba(0,0,0,0.15));
        stroke-width: 3;
      }
      #ccEvolveConfirm .evolve-yes .ring-progress {
        fill: none;
        stroke: var(--ui-accent, #3b7fdf);
        stroke-width: 4;
        stroke-linecap: round;
        /* circumference of r=40 → 2πr ≈ 251.33; full = no progress */
        stroke-dasharray: 251.33;
        stroke-dashoffset: 251.33;
        transition: stroke-dashoffset 0ms linear;
      }
      #ccEvolveConfirm .evolve-yes.holding .ring-progress {
        stroke-dashoffset: 0;
        /* Keep in sync with EVOLVE_CONFIRM_HOLD_MS. */
        transition: stroke-dashoffset 2500ms linear;
      }
      #ccEvolveConfirm .evolve-hint {
        font-size: 11px;
        color: var(--ui-muted, #666);
        margin: 12px 0 0;
      }
      #creatureInventory .pokedex-view { display: none; }
      #creatureInventory .pokedex-view.show { display: flex; flex-direction: column; }
      #creatureInventory .candy-view { display: none; }
      #creatureInventory .candy-view.show { display: flex; flex-direction: column; }
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
      /* Per-species candy icon: a 40x40 cell of /bundled-data/candies.png,
         positioned via inline background-position. image-rendering keeps
         the chunky pixel-art look intact when the cell is upscaled by
         the device's pixel ratio. flex-shrink so the icon doesn't get
         squashed when the row is narrow. */
      #creatureInventory .candy-row .candy-icon {
        width: ${CANDY_CELL_PX}px;
        height: ${CANDY_CELL_PX}px;
        background-image: url('${BUNDLED_BASE}/candies.png');
        background-size: ${CANDY_CELL_PX * CANDY_SHEET_COLS}px ${CANDY_CELL_PX * CANDY_SHEET_ROWS}px;
        background-repeat: no-repeat;
        image-rendering: pixelated;
        image-rendering: crisp-edges;
        flex-shrink: 0;
      }
      /* Species name shown alongside the icon for the family root —
         small, secondary, doesn't shout. Helpful as both a fallback
         (when an empty cell renders blank) and an accessibility aid. */
      #creatureInventory .candy-row .candy-name-sub {
        font-size: 13px; font-weight: 500;
        color: var(--ui-muted, #666);
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
      #creatureInventory .daycare-view { display: none; }
      #creatureInventory .daycare-view.show { display: flex; flex-direction: column; }
      #creatureInventory .eggs-view { display: none; }
      #creatureInventory .eggs-view.show { display: flex; flex-direction: column; }
      #creatureInventory .eggs-subtitle {
        font-size: 12px; color: var(--ui-muted, #666);
        text-align: center; margin: 0 0 12px;
      }
      #creatureInventory .eggs-empty {
        padding: 24px 14px;
        text-align: center;
        color: var(--ui-muted, #666);
        font-size: 13px;
        line-height: 1.5;
      }
      #creatureInventory .eggs-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      #creatureInventory .egg-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.08));
        border-radius: var(--ui-radius, 8px);
      }
      #creatureInventory .egg-icon {
        flex: 0 0 auto;
        width: 48px;
        height: 48px;
      }
      #creatureInventory .egg-meta {
        display: flex;
        flex-direction: column;
        min-width: 0;
        flex: 1 1 auto;
      }
      #creatureInventory .egg-name {
        font-size: 14px; font-weight: 600;
        color: var(--ui-text, #111);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #creatureInventory .egg-sub {
        font-size: 12px; color: var(--ui-muted, #666);
        font-variant-numeric: tabular-nums;
      }
      /* Incubator section — sits above the egg grid in the eggs view.
         Two slots side-by-side. Each slot is a drop target; when
         filled, also a drag source. The slot card sizes by content;
         empty slots show a dashed placeholder, filled slots show the
         egg's art + a progress bar tracking incubatedM / 5km. */
      #creatureInventory .incubator {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        margin-bottom: 14px;
      }
      #creatureInventory .incubator-slot {
        position: relative;
        min-height: 96px;
        padding: 10px 8px;
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.08));
        border-radius: var(--ui-radius, 8px);
        background: var(--ui-hover, rgba(0,0,0,0.04));
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        text-align: center;
        transition: border-color 120ms ease, background 120ms ease;
      }
      #creatureInventory .incubator-slot.empty {
        border-style: dashed;
        color: var(--ui-muted, #666);
        font-size: 12px;
      }
      #creatureInventory .incubator-slot.drop-active {
        border-color: var(--ui-accent, #888);
        background: var(--ui-hover, rgba(0,0,0,0.08));
      }
      #creatureInventory .incubator-slot .slot-progress {
        width: 100%;
        height: 6px;
        background: var(--ui-hairline, rgba(0,0,0,0.10));
        border-radius: 999px;
        overflow: hidden;
      }
      #creatureInventory .incubator-slot .slot-progress > .fill {
        height: 100%;
        background: var(--ui-accent, #888);
        transition: width 240ms ease;
      }
      #creatureInventory .incubator-slot .slot-distance {
        font-size: 11px;
        color: var(--ui-muted, #666);
        font-variant-numeric: tabular-nums;
      }
      #creatureInventory .incubator-slot.ready {
        border-color: var(--ui-accent, #888);
        box-shadow: 0 0 0 1px var(--ui-accent, #888);
      }
      #creatureInventory .incubator-slot .slot-hatch {
        margin-top: 2px;
        padding: 6px 10px;
        font-size: 12px;
        font-weight: 600;
        border: 1px solid var(--ui-accent-border, #555);
        background: var(--ui-accent, #888);
        color: var(--ui-accent-text, #fff);
        border-radius: var(--ui-radius, 6px);
        cursor: pointer;
      }
      /* Egg grid — one tile per egg not currently in a slot. Tiles
         are drag sources and the grid container is also a drop zone
         (dropping into the grid removes the egg from a slot). */
      #creatureInventory .eggs-grid-zone {
        min-height: 60px;
        border-radius: var(--ui-radius, 8px);
        transition: background 120ms ease;
      }
      #creatureInventory .eggs-grid-zone.drop-active {
        background: var(--ui-hover, rgba(0,0,0,0.06));
      }
      #creatureInventory .eggs-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(86px, 1fr));
        gap: 8px;
      }
      #creatureInventory .egg-tile {
        position: relative;
        padding: 8px 6px;
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.08));
        border-radius: var(--ui-radius, 8px);
        background: var(--ui-hover, rgba(0,0,0,0.04));
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        cursor: grab;
        /* Disable native scroll/zoom gestures starting on a tile
           so pointer drags can capture cleanly. */
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
      }
      #creatureInventory .egg-tile.dragging {
        opacity: 0.35;
      }
      #creatureInventory .egg-tile .tile-art {
        width: 48px;
        height: 48px;
        flex: 0 0 auto;
      }
      #creatureInventory .egg-tile .tile-name {
        font-size: 11px;
        font-weight: 600;
        color: var(--ui-text, #111);
        text-align: center;
        line-height: 1.2;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #creatureInventory .egg-tile .tile-progress {
        width: 100%;
        height: 3px;
        background: var(--ui-hairline, rgba(0,0,0,0.10));
        border-radius: 999px;
        overflow: hidden;
      }
      #creatureInventory .egg-tile .tile-progress > .fill {
        height: 100%;
        background: var(--ui-accent, #888);
      }
      /* Floating ghost element that follows the pointer during a
         drag. Created on demand; size matches the source tile's
         art (48 px) so the inline background-size/position copied
         from the tile renders cleanly without rescaling. */
      .egg-drag-ghost {
        position: fixed;
        pointer-events: none;
        z-index: 10000;
        opacity: 0.85;
        transform: translate(-50%, -50%);
        width: 48px;
        height: 48px;
        background-repeat: no-repeat;
        image-rendering: pixelated;
        image-rendering: crisp-edges;
      }
      #creatureInventory .daycare-slots {
        display: grid;
        /* Use minmax(0, 1fr), not bare 1fr — bare 1fr is implicitly
           minmax(auto, 1fr), which means the column will GROW past
           its 1fr share if a child has wide intrinsic content. The
           pill row's flex children have a natural total width of
           (N * 28) + gaps, and with 10+ pills that exceeded the
           slot's intended half-width, stretching the slot column
           horizontally and defeating overflow:hidden. min=0 forces
           the column to honor 1fr regardless of content width. */
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 8px;
        margin: 0 0 10px;
      }
      #creatureInventory .daycare-slot {
        /* Same intrinsic-width-floor mitigation as the grid columns:
           min-width: 0 lets the slot ignore its children's natural
           widths so the pill row's overflow:hidden actually clips. */
        min-width: 0;
      }
      #creatureInventory .daycare-slot {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 12px 8px;
        min-height: 110px;
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.08));
        border-radius: var(--ui-radius, 8px);
        /* Clip children to the rounded bubble shape so the loot
           row's full-width divider line doesn't bleed past the
           slot's rounded corners. The pill row extends edge-to-
           edge via negative margins; without this, the divider
           visually overshoots the curve. */
        overflow: hidden;
        /* Slot itself isn't clickable — only the .daycare-slot-art
           opens the creature detail, so a misclick on the loot row
           or the empty padding around it doesn't navigate away. */
      }
      #creatureInventory .daycare-slot[data-id] .daycare-slot-art {
        cursor: pointer;
      }
      #creatureInventory .daycare-slot.daycare-slot-empty {
        border-style: dashed;
      }
      #creatureInventory .daycare-slot-empty-label {
        font-size: 12px;
        color: var(--ui-muted, #666);
        font-style: italic;
      }
      #creatureInventory .daycare-slot-art-row {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
      }
      #creatureInventory .daycare-slot-art {
        position: relative;
        width: 72px;
        height: 72px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      /* Conversion toggle — two stacked 22px candy icons with a tiny
         arrow between (so the button visually narrates "this becomes
         that"). Default state is dim; tap promotes to an accented
         ring and full opacity. Mutually exclusive across the two
         buttons in a slot; the click handler toggles the .active
         class locally. */
      #creatureInventory .daycare-convert-btn {
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 1px;
        padding: 4px 3px;
        border: 1px solid transparent;
        border-radius: 8px;
        background: transparent;
        cursor: pointer;
        /* Default "off" state: reduced opacity + grayscale so the
           candy icons read as obviously disabled, not just dim. iOS
           WKWebView's sticky :hover would otherwise keep the button
           looking faintly bright after a tap-to-disable; gating the
           hover bump behind @media(hover:hover) below avoids that. */
        opacity: 0.4;
        filter: grayscale(0.85);
        transition: opacity 0.12s ease, filter 0.12s ease,
                    border-color 0.12s ease, background-color 0.12s ease,
                    transform 0.08s ease;
        -webkit-tap-highlight-color: transparent;
      }
      @media (hover: hover) {
        #creatureInventory .daycare-convert-btn:hover {
          opacity: 0.75;
          filter: grayscale(0.5);
        }
      }
      #creatureInventory .daycare-convert-btn:active {
        transform: scale(0.94);
      }
      #creatureInventory .daycare-convert-btn.active {
        opacity: 1;
        filter: none;
        border-color: var(--ui-accent, #2a8);
        background: color-mix(in srgb, var(--ui-accent, #2a8) 12%, transparent);
      }
      #creatureInventory .daycare-convert-btn .convert-arrow {
        font-size: 10px;
        line-height: 1;
        color: var(--ui-muted, #888);
      }
      #creatureInventory .daycare-convert-btn.active .convert-arrow {
        color: var(--ui-accent, #2a8);
      }
      #creatureInventory .daycare-slot-art-placeholder {
        width: 16px; height: 16px;
        border-radius: 50%;
        background: var(--ui-hairline, rgba(0,0,0,0.18));
      }
      #creatureInventory .daycare-slot-art-img {
        max-width: 100%;
        max-height: 100%;
        image-rendering: pixelated;
        image-rendering: crisp-edges;
      }
      #creatureInventory .daycare-slot-name {
        font-size: 12px;
        font-weight: 600;
        color: var(--ui-text, #111);
        text-align: center;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #creatureInventory .daycare-slot-dist {
        font-size: 11px;
        color: var(--ui-muted, #666);
        font-variant-numeric: tabular-nums;
        margin-top: 1px;
      }
      /* Per-slot loot row: pills flow horizontally, anything past
         the slot's right edge is clipped by overflow:hidden. As
         pills get claimed (width-collapse to 0) the row's content
         shrinks and previously-clipped pills shift leftward into
         view. The row spans the slot edge-to-edge (negative
         horizontal margins cancel the slot's 8px side padding) so
         (a) the divider line above the row is full-width, visually
         separating the loot zone from the creature info, and (b)
         the cutoff sits at the slot's actual right edge — fitting
         one more pill than a padded row would. */
      #creatureInventory .daycare-slot-loot {
        position: relative;
        display: flex;
        flex-direction: row;
        gap: 4px;
        align-items: center;
        height: 32px;
        overflow: hidden;
        margin-top: 6px;
        /* Negative margins extend the row toward the slot's edges
           so the divider line spans nearly the full bubble width
           and the cutoff sits as far right as possible. We stop 2px
           short of the border on each side so iOS WebKit's
           sub-pixel rounding on overflow:hidden + border-radius
           doesn't let a partially-clipped pill peek past the
           bubble's curved edge. */
        margin-left: -6px;
        margin-right: -6px;
        width: calc(100% + 12px);
        padding: 4px 4px 0;
        border-top: 1px solid var(--ui-border, var(--ui-hairline, rgba(0,0,0,0.18)));
      }
      #creatureInventory .daycare-loot-pill {
        flex: 0 0 auto;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 0 solid transparent;
        background-color: transparent;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        transition:
          width 240ms ease,
          opacity 200ms ease,
          transform 200ms ease,
          margin 240ms ease;
      }
      #creatureInventory .daycare-loot-pill:hover:not(.claimed):not(.appearing) {
        transform: scale(1.08);
      }
      /* Claimed: collapse width to zero so the items to its right
         shift leftward smoothly. transitionend on the width
         property removes the element from DOM, and the row's
         overflow class is re-evaluated so the ellipsis can hide
         once everything fits. */
      #creatureInventory .daycare-loot-pill.claimed {
        width: 0;
        margin: 0 -2px;
        transform: scale(0);
        opacity: 0;
        pointer-events: none;
      }
      /* Appearing: a freshly-earned milestone slides in. New pills
         arrive at the END of the row — extras past the visible cap
         are clipped by the row's overflow:hidden. */
      #creatureInventory .daycare-loot-pill.appearing {
        animation: daycare-loot-slide-in 320ms ease forwards;
      }
      @keyframes daycare-loot-slide-in {
        0%   { width: 0; opacity: 0; transform: scale(0.4); }
        60%  { width: 28px; opacity: 1; transform: scale(1.12); }
        100% { width: 28px; opacity: 1; transform: scale(1); }
      }
      #creatureInventory .daycare-today {
        display: flex; flex-direction: column; align-items: center;
        padding: 12px 10px 14px;
        margin: 0 0 10px;
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.08));
        border-radius: var(--ui-radius, 8px);
      }
      #creatureInventory .daycare-today-label {
        font-size: 11px; color: var(--ui-muted, #666);
        text-transform: uppercase; letter-spacing: 0.06em;
      }
      #creatureInventory .daycare-today-value {
        font-size: 26px; font-weight: 700;
        color: var(--ui-text, #111);
        font-variant-numeric: tabular-nums;
        margin-top: 2px;
      }
      #creatureInventory .daycare-cal-header {
        display: flex; align-items: center; justify-content: space-between;
        margin: 4px 0 6px;
      }
      #creatureInventory .daycare-cal-title {
        font-size: 14px; font-weight: 600;
        color: var(--ui-text, #111);
      }
      #creatureInventory .daycare-cal-nav {
        background: none; border: none;
        color: var(--ui-text, #111);
        font-size: 18px; line-height: 1;
        padding: 4px 10px; cursor: pointer;
        border-radius: var(--ui-radius, 8px);
      }
      #creatureInventory .daycare-cal-nav:hover {
        background: var(--ui-hover, rgba(0,0,0,0.06));
      }
      #creatureInventory .daycare-cal-nav:disabled {
        opacity: 0.35; cursor: default;
      }
      #creatureInventory .daycare-cal-grid {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 3px;
      }
      #creatureInventory .daycare-cal-dow {
        text-align: center;
        font-size: 10px;
        color: var(--ui-muted, #666);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        padding: 2px 0;
      }
      #creatureInventory .daycare-cal-cell {
        position: relative;
        aspect-ratio: 1 / 1;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        font-size: 11px;
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.08));
        border-radius: 6px;
        color: var(--ui-text, #111);
      }
      #creatureInventory .daycare-cal-cell.empty {
        background: transparent;
        border-color: transparent;
      }
      #creatureInventory .daycare-cal-cell.future {
        opacity: 0.3;
      }
      #creatureInventory .daycare-cal-cell.has-data {
        cursor: pointer;
      }
      #creatureInventory .daycare-cal-cell.today {
        outline: 2px solid var(--ui-accent, #888);
        outline-offset: -2px;
      }
      #creatureInventory .daycare-cal-cell.selected {
        background: var(--ui-accent, #888);
        color: var(--ui-bg, #fff);
      }
      #creatureInventory .daycare-cal-day {
        font-weight: 600;
        font-size: 13px;
        line-height: 1;
      }
      #creatureInventory .daycare-cal-dist {
        font-size: 9px;
        margin-top: 2px;
        font-variant-numeric: tabular-nums;
        opacity: 0.85;
      }
      #creatureInventory .daycare-detail {
        margin-top: 12px;
        padding: 10px;
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.08));
        border-radius: var(--ui-radius, 8px);
        font-size: 13px;
      }
      #creatureInventory .daycare-detail-title {
        font-weight: 600; margin-bottom: 4px;
      }
      #creatureInventory .daycare-detail-empty {
        color: var(--ui-muted, #666); font-style: italic;
      }
      /* Round "i" info button (next to a subview title) + its popup. Shared
         between the daycare-odds button (.dc-odds-info) and any other explainer
         (.cc-info-btn, e.g. the craft/incense one). */
      #creatureInventory .dc-odds-info,
      #creatureInventory .cc-info-btn {
        -webkit-appearance: none; appearance: none;
        margin-left: 8px; width: 20px; height: 20px; padding: 0;
        border-radius: 50%; border: 1px solid var(--ui-border, rgba(0,0,0,0.2));
        background: rgba(128,128,128,0.14); color: var(--ui-muted, #666);
        font-size: 12px; font-style: italic; font-weight: 700; line-height: 18px;
        text-align: center; cursor: pointer; vertical-align: middle;
      }
      #creatureInventory .dc-odds-info:hover,
      #creatureInventory .cc-info-btn:hover { color: var(--ui-text, #111); }
      #ccDaycareOdds {
        position: fixed; inset: 0; z-index: 60; padding: 16px;
        background: rgba(0,0,0,0.55);
        display: none; align-items: center; justify-content: center;
        opacity: 0; pointer-events: none; transition: opacity 150ms ease;
      }
      #ccDaycareOdds.show { display: flex; opacity: 1; pointer-events: auto; }
      #ccDaycareOdds .dc-odds-card {
        position: relative;
        background: var(--ui-bg, #fff); color: var(--ui-text, #111);
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 12px);
        box-shadow: var(--ui-shadow, 0 6px 24px rgba(0,0,0,0.25));
        width: calc(100% - 8px); max-width: 380px; max-height: 82vh; overflow-y: auto;
        padding: 16px 18px 18px;
      }
      /* Top-of-card back/close — same bare stroked glyphs as the app's other
         sticky back/close controls (and as the floating cluster below). */
      #ccDaycareOdds .dc-odds-back,
      #ccDaycareOdds .dc-odds-close {
        position: absolute; top: 8px; z-index: 2;
        width: 30px; height: 30px; min-height: 30px; padding: 0;
        border: none; background: transparent; color: var(--ui-text, #111);
        text-shadow:
          -1px -1px 0 var(--ui-bg, #fff), 0 -1px 0 var(--ui-bg, #fff),  1px -1px 0 var(--ui-bg, #fff),
          -1px  0   0 var(--ui-bg, #fff),                                1px  0   0 var(--ui-bg, #fff),
          -1px  1px 0 var(--ui-bg, #fff), 0  1px 0 var(--ui-bg, #fff),  1px  1px 0 var(--ui-bg, #fff);
        line-height: 1; cursor: pointer; box-sizing: border-box;
        display: inline-flex; align-items: center; justify-content: center;
      }
      #ccDaycareOdds .dc-odds-back { left: 8px; font-size: 22px; }
      #ccDaycareOdds .dc-odds-close { right: 8px; font-size: 26px; padding-bottom: 2px; }
      #ccDaycareOdds .dc-odds-back:hover,
      #ccDaycareOdds .dc-odds-close:hover { color: var(--ui-accent, #888); }
      /* Floating back/close cluster — overlays the top of the scrolling card
         (height:0 so it takes no flow space) and shows once scrolled down. */
      #ccDaycareOdds .dc-odds-floatbar {
        position: sticky; top: 6px; z-index: 3; height: 0;
        display: none; justify-content: space-between;
        pointer-events: none;
      }
      #ccDaycareOdds .dc-odds-floatbar.show { display: flex; }
      /* Match the app's sticky back/close glyphs: bare, transparent, with an
         8-direction bg-color stroke so they read over scrolling content. */
      #ccDaycareOdds .dc-odds-floatbar button {
        pointer-events: auto;
        background: transparent; border: none; padding: 0;
        color: var(--ui-text, #111);
        text-shadow:
          -1px -1px 0 var(--ui-bg, #fff), 0 -1px 0 var(--ui-bg, #fff),  1px -1px 0 var(--ui-bg, #fff),
          -1px  0   0 var(--ui-bg, #fff),                                1px  0   0 var(--ui-bg, #fff),
          -1px  1px 0 var(--ui-bg, #fff), 0  1px 0 var(--ui-bg, #fff),  1px  1px 0 var(--ui-bg, #fff);
        line-height: 1; cursor: pointer; box-sizing: border-box;
        display: inline-flex; align-items: center; justify-content: center;
        width: 30px; height: 30px; min-height: 30px; flex-shrink: 0;
      }
      #ccDaycareOdds .dc-odds-floatbar .dc-odds-float-back { font-size: 22px; }
      #ccDaycareOdds .dc-odds-floatbar .dc-odds-float-x { font-size: 26px; padding-bottom: 2px; }
      #ccDaycareOdds .dc-odds-floatbar button:hover { color: var(--ui-accent, #888); }
      #ccDaycareOdds .dc-odds-title { margin: 0 0 8px; font-size: 16px; padding: 0 30px; text-align: center; }
      #ccDaycareOdds .dc-odds-intro { font-size: 13px; margin: 0 0 12px; }
      #ccDaycareOdds .dc-odds-empty { font-size: 13px; margin: 4px 0; color: var(--ui-muted, #666); }
      #ccDaycareOdds .dc-odds-slot {
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.08));
        border-radius: var(--ui-radius, 8px); padding: 10px 12px; margin-bottom: 10px;
      }
      #ccDaycareOdds .dc-odds-slot-name { font-weight: 600; margin-bottom: 6px; }
      #ccDaycareOdds .dc-odds-split { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
      #ccDaycareOdds .dc-tag {
        font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 999px;
        background: rgba(128,128,128,0.18); color: var(--ui-text, #111);
      }
      #ccDaycareOdds .dc-tag.candy { background: rgba(255,193,7,0.22); }
      #ccDaycareOdds .dc-tag.egg   { background: rgba(91,140,255,0.24); }
      #ccDaycareOdds .dc-tag.evo   { background: rgba(0,200,120,0.22); }
      #ccDaycareOdds .dc-odds-line { font-size: 12.5px; display: flex; gap: 8px; margin-top: 3px; }
      #ccDaycareOdds .dc-odds-k { color: var(--ui-muted, #666); flex: 0 0 64px; }
      #ccDaycareOdds .dc-odds-v { flex: 1 1 auto; }
      #ccDaycareOdds .dc-odds-note { color: var(--ui-muted, #666); font-size: 12px; font-style: italic; }
      #ccDaycareOdds .dc-odds-eggs-title { font-weight: 600; margin: 2px 0 4px; }
      #ccDaycareOdds .dc-odds-egglist {
        list-style: none; margin: 8px 0 0; padding: 0;
        display: flex; flex-direction: column; gap: 3px;
      }
      #ccDaycareOdds .dc-odds-egglist li {
        display: flex; align-items: center; gap: 8px;
        font-size: 13px; padding: 4px 8px; border-radius: 6px; background: rgba(128,128,128,0.10);
      }
      #ccDaycareOdds .dc-odds-egglist li.dc-egg { cursor: pointer; }
      #ccDaycareOdds .dc-odds-egglist li.dc-egg:hover { background: rgba(128,128,128,0.20); }
      #ccDaycareOdds .dc-odds-egglist li.cross { opacity: 0.82; }
      #ccDaycareOdds .dc-egg-icon {
        flex: 0 0 30px; width: 30px; height: 30px;
        display: flex; align-items: center; justify-content: center;
      }
      #ccDaycareOdds .dc-egg-icon img {
        max-width: 30px; max-height: 30px; object-fit: contain;
        image-rendering: pixelated; image-rendering: crisp-edges; display: none;
      }
      #ccDaycareOdds .dc-odds-egglist li.ready .dc-egg-icon img { display: block; }
      #ccDaycareOdds .dc-egg-icon.silhouette img { filter: brightness(0); }
      #ccDaycareOdds .dc-egg-name { flex: 1 1 auto; }
      #ccDaycareOdds .dc-egg-pct { color: var(--ui-muted, #666); font-variant-numeric: tabular-nums; }

      /* ── Generic info modal (reusable explainer popup) ──
         Same full-screen card chrome as #ccDaycareOdds, but content-agnostic
         and with a back button that pops an internal view stack (or closes at
         the root). Used by the craft "How incense works" explainer + its type
         chart sub-view; reusable by future "i" popups. */
      #ccInfoModal {
        position: fixed; inset: 0; z-index: 60; padding: 16px;
        background: rgba(0,0,0,0.55);
        display: none; align-items: center; justify-content: center;
        opacity: 0; pointer-events: none; transition: opacity 150ms ease;
      }
      #ccInfoModal.show { display: flex; opacity: 1; pointer-events: auto; }
      #ccInfoModal .cc-modal-card {
        position: relative;
        background: var(--ui-bg, #fff); color: var(--ui-text, #111);
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 12px);
        box-shadow: var(--ui-shadow, 0 6px 24px rgba(0,0,0,0.25));
        width: calc(100% - 8px); max-width: 380px; max-height: 82vh; overflow-y: auto;
        padding: 16px 18px 18px;
      }
      #ccInfoModal .cc-modal-back,
      #ccInfoModal .cc-modal-close {
        position: absolute; top: 8px; z-index: 2;
        width: 30px; height: 30px; min-height: 30px; padding: 0;
        border: none; background: transparent; color: var(--ui-text, #111);
        text-shadow:
          -1px -1px 0 var(--ui-bg, #fff), 0 -1px 0 var(--ui-bg, #fff),  1px -1px 0 var(--ui-bg, #fff),
          -1px  0   0 var(--ui-bg, #fff),                                1px  0   0 var(--ui-bg, #fff),
          -1px  1px 0 var(--ui-bg, #fff), 0  1px 0 var(--ui-bg, #fff),  1px  1px 0 var(--ui-bg, #fff);
        line-height: 1; cursor: pointer; box-sizing: border-box;
        display: inline-flex; align-items: center; justify-content: center;
      }
      #ccInfoModal .cc-modal-back { left: 8px; font-size: 22px; }
      #ccInfoModal .cc-modal-close { right: 8px; font-size: 26px; padding-bottom: 2px; }
      #ccInfoModal .cc-modal-back:hover,
      #ccInfoModal .cc-modal-close:hover { color: var(--ui-accent, #888); }
      #ccInfoModal .cc-modal-floatbar {
        position: sticky; top: 6px; z-index: 3; height: 0;
        display: none; justify-content: space-between; pointer-events: none;
      }
      #ccInfoModal .cc-modal-floatbar.show { display: flex; }
      #ccInfoModal .cc-modal-floatbar button {
        pointer-events: auto; background: transparent; border: none; padding: 0;
        color: var(--ui-text, #111);
        text-shadow:
          -1px -1px 0 var(--ui-bg, #fff), 0 -1px 0 var(--ui-bg, #fff),  1px -1px 0 var(--ui-bg, #fff),
          -1px  0   0 var(--ui-bg, #fff),                                1px  0   0 var(--ui-bg, #fff),
          -1px  1px 0 var(--ui-bg, #fff), 0  1px 0 var(--ui-bg, #fff),  1px  1px 0 var(--ui-bg, #fff);
        line-height: 1; cursor: pointer; box-sizing: border-box;
        display: inline-flex; align-items: center; justify-content: center;
        width: 30px; height: 30px; min-height: 30px; flex-shrink: 0;
      }
      #ccInfoModal .cc-modal-floatbar .cc-modal-float-back { font-size: 22px; }
      #ccInfoModal .cc-modal-floatbar .cc-modal-float-x { font-size: 26px; padding-bottom: 2px; }
      #ccInfoModal .cc-modal-floatbar button:hover { color: var(--ui-accent, #888); }
      #ccInfoModal .cc-modal-title { margin: 0 0 10px; font-size: 16px; padding: 0 30px; text-align: center; }
      /* Content typography — mirrors the daycare-odds body scale. */
      #ccInfoModal .cc-modal-content { font-size: 13px; }
      #ccInfoModal .cc-info-p { font-size: 13px; margin: 0 0 12px; line-height: 1.5; }
      #ccInfoModal .cc-info-section {
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.08));
        border-radius: var(--ui-radius, 8px); padding: 10px 12px; margin-bottom: 10px;
      }
      #ccInfoModal .cc-info-section-title { font-weight: 600; margin-bottom: 6px; }
      #ccInfoModal .cc-info-row { display: flex; gap: 8px; margin-top: 4px; font-size: 12.5px; }
      #ccInfoModal .cc-info-k { color: var(--ui-muted, #666); flex: 0 0 96px; }
      #ccInfoModal .cc-info-v { flex: 1 1 auto; }
      #ccInfoModal .cc-info-note { color: var(--ui-muted, #666); font-size: 12px; font-style: italic; }
      #ccInfoModal .cc-info-mult { font-weight: 700; }
      /* Odds bar — a stacked horizontal bar for the "other slot" split. */
      #ccInfoModal .cc-oddsbar {
        display: flex; height: 22px; border-radius: 6px; overflow: hidden;
        margin: 8px 0 4px; border: 1px solid var(--ui-hairline, rgba(0,0,0,0.10));
      }
      #ccInfoModal .cc-oddsbar-seg {
        display: flex; align-items: center; justify-content: center;
        font-size: 10.5px; font-weight: 700; color: #fff;
        text-shadow: 0 1px 2px rgba(0,0,0,0.35); overflow: hidden; white-space: nowrap;
        min-width: 0;
      }
      #ccInfoModal .cc-oddsbar-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; }
      #ccInfoModal .cc-oddsbar-legend span {
        display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px;
        color: var(--ui-muted, #666);
      }
      #ccInfoModal .cc-oddsbar-legend i {
        width: 10px; height: 10px; border-radius: 2px; display: inline-block; flex-shrink: 0;
      }
      /* Odds grid — a heat-map matrix of the joint two-type-half odds. Rows are
         the primary (first) half, columns the secondary (second) half. */
      #ccInfoModal .cc-oddsgrid { display: grid; gap: 3px; margin: 8px 0 4px; font-size: 11px; }
      #ccInfoModal .cc-oddsgrid-corner {
        display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-end;
        gap: 1px; padding: 2px 2px 4px; font-size: 9.5px; line-height: 1.1;
        color: var(--ui-muted, #666);
      }
      #ccInfoModal .cc-oddsgrid-head {
        display: inline-flex; align-items: center; justify-content: center; gap: 4px;
        font-weight: 600; padding: 3px 3px; min-width: 0; white-space: nowrap; overflow: hidden;
      }
      #ccInfoModal .cc-oddsgrid-head i {
        width: 9px; height: 9px; border-radius: 2px; display: inline-block; flex-shrink: 0;
      }
      #ccInfoModal .cc-oddsgrid-cell {
        display: flex; align-items: center; justify-content: center; padding: 7px 2px;
        border-radius: 4px; font-weight: 700; color: var(--ui-text, #111);
      }
      #ccInfoModal .cc-oddsgrid-cell.hot { color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.35); }
      /* "Open type chart" launcher row. */
      #ccInfoModal .cc-info-link {
        -webkit-appearance: none; appearance: none;
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        width: 100%; margin-top: 4px; padding: 11px 12px;
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.10));
        border-radius: var(--ui-radius, 8px);
        font-family: inherit; font-size: 13px; font-weight: 600;
        color: var(--ui-text, #111); cursor: pointer; text-align: left;
      }
      #ccInfoModal .cc-info-link:hover { background: var(--ui-hover, rgba(0,0,0,0.08)); }
      #ccInfoModal .cc-info-link .cc-info-link-arrow { color: var(--ui-muted, #666); font-size: 16px; }
      /* Type chips (reuse the app's colored type-chip look at a compact size). */
      #ccInfoModal .cc-typechips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 4px; }
      #ccInfoModal .cc-typechip {
        font-size: 11px; font-weight: 700; letter-spacing: 0.02em;
        padding: 3px 8px; border-radius: 999px; color: #fff;
        text-shadow: 0 1px 1px rgba(0,0,0,0.25); white-space: nowrap;
      }
      #ccInfoModal .cc-typechip.dim { opacity: 0.42; }
      /* Type picker grid for the type-chart explorer. */
      #ccInfoModal .cc-typegrid {
        display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 8px 0 12px;
      }
      #ccInfoModal .cc-typegrid button {
        -webkit-appearance: none; appearance: none; font-family: inherit;
        padding: 7px 4px; border-radius: 8px; border: 2px solid transparent;
        font-size: 11.5px; font-weight: 700; color: #fff;
        text-shadow: 0 1px 2px rgba(0,0,0,0.3); cursor: pointer; min-width: 0;
      }
      #ccInfoModal .cc-typegrid button.sel {
        border-color: var(--ui-text, #111);
        box-shadow: 0 0 0 2px var(--ui-bg, #fff) inset;
      }
      #ccInfoModal .cc-typedetail {
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.10));
        border-radius: var(--ui-radius, 8px); padding: 12px; margin-top: 4px;
      }
      #ccInfoModal .cc-typedetail-head {
        display: flex; align-items: center; gap: 8px; margin-bottom: 4px;
      }
      #ccInfoModal .cc-typedot {
        width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0;
        display: inline-block; box-shadow: 0 0 0 1px rgba(0,0,0,0.18) inset;
      }
      #ccInfoModal .cc-typedetail-name { font-size: 15px; font-weight: 700; }
      #ccInfoModal .cc-typedetail-block { margin-top: 10px; }
      #ccInfoModal .cc-typedetail-block .cc-tdb-label {
        font-size: 12px; font-weight: 600; margin-bottom: 2px;
        display: flex; align-items: center; gap: 6px;
      }
      #ccInfoModal .cc-typedetail-block .cc-tdb-mult {
        font-size: 10.5px; font-weight: 800; padding: 1px 6px; border-radius: 999px;
        color: #fff;
      }
      #ccInfoModal .cc-tdb-mult.good { background: #2ca05a; }
      #ccInfoModal .cc-tdb-mult.bad  { background: #b06a3a; }
      #ccInfoModal .cc-tdb-mult.craft { background: #5b8cff; }
      #ccInfoModal .cc-typedetail-block .cc-tdb-none { font-size: 12px; color: var(--ui-muted, #666); font-style: italic; }
      #creatureInventory .daycare-empty {
        padding: 20px 8px; text-align: center;
        color: var(--ui-muted, #666); font-size: 13px;
      }
      #creatureInventory .daycare-show-on-map {
        display: block;
        width: 100%;
        margin-top: 14px;
        padding: 10px 12px;
        background: var(--ui-accent, #888);
        color: var(--ui-bg, #fff);
        border: none;
        border-radius: var(--ui-radius, 8px);
        font-family: inherit;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
      }
      #creatureInventory .daycare-show-on-map:hover {
        filter: brightness(1.05);
      }
      #creatureInventory .daycare-show-on-map:active {
        filter: brightness(0.95);
      }
      #creatureInventory .daycare-show-all-on-map {
        display: block;
        width: 100%;
        margin-top: 8px;
        padding: 9px 12px;
        background: transparent;
        color: var(--ui-text, #111);
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 8px);
        font-family: inherit;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
      }
      #creatureInventory .daycare-show-all-on-map:hover {
        background: var(--ui-hover, rgba(0,0,0,0.04));
      }
      #creatureInventory .bag-view { display: none; }
      #creatureInventory .bag-view.show { display: flex; flex-direction: column; }
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
      /* Active-incense banner + per-item Use button. */
      #creatureInventory .bag-incense-banner {
        display: flex; align-items: center; gap: 10px; padding: 10px;
        margin: 0 0 12px; border-radius: var(--ui-radius, 8px);
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border: 1px solid var(--ui-accent, #b06cff);
      }
      #creatureInventory .bag-incense-banner .bag-icon { width: 30px; height: 30px; align-self: center; }
      #creatureInventory .bag-row-right {
        display: flex; flex-direction: column; align-items: flex-end;
        gap: 6px; align-self: center;
      }
      #creatureInventory .bag-use {
        padding: 4px 12px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
        color: #fff; border: none; border-radius: var(--ui-radius, 8px);
        background: var(--ui-accent, #b06cff);
      }
      #creatureInventory .bag-use:active { transform: scale(0.96); }
      /* ── Craft ── */
      /* Matches the header nav buttons (Tags / Bag / Candy / …). */
      #creatureInventory .bag-craft {
        display: flex; align-items: center; justify-content: center;
        width: fit-content; margin: 0 auto 12px; padding: 5px 10px;
        font-family: inherit; font-size: 12px; line-height: 1; cursor: pointer;
        background: transparent; color: var(--ui-text, #111);
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 8px);
      }
      #creatureInventory .bag-craft:hover { background: var(--ui-hover, rgba(0,0,0,0.04)); }
      #creatureInventory .craft-view { display: none; }
      #creatureInventory .craft-view.show { display: flex; flex-direction: column; }
      .radar-marker { display: flex; flex-direction: column; align-items: center; pointer-events: none; }
      .radar-marker-label {
        font-size: 11px; font-weight: 700; color: #fff; background: rgba(20,24,36,0.82);
        padding: 1px 6px; border-radius: 999px; white-space: nowrap; margin-bottom: 3px;
        font-variant-numeric: tabular-nums; box-shadow: 0 1px 3px rgba(0,0,0,0.4);
      }
      .radar-marker-img {
        width: 44px; height: 44px; object-fit: contain; image-rendering: pixelated; display: none;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5)); pointer-events: auto; cursor: pointer;
      }
      .radar-marker.ready .radar-marker-img { display: block; }
      .radar-marker.silhouette .radar-marker-img { filter: brightness(0) drop-shadow(0 1px 2px rgba(0,0,0,0.35)); }
      .radar-marker.radar-legendary .radar-marker-img {
        filter: brightness(0)
          drop-shadow(1.3px 0 0 #ffcb2e) drop-shadow(-1.3px 0 0 #ffcb2e)
          drop-shadow(0 1.3px 0 #ffcb2e) drop-shadow(0 -1.3px 0 #ffcb2e);
      }
      .radar-marker.radar-legendary .radar-marker-label { background: rgba(184,134,11,0.94); }
      /* On dark themes a pure-black silhouette vanishes into the near-black
         map, so give non-legendary blips a white outline (legendaries keep
         their gold one). Keyed off the theme-agnostic data-ui-dark flag that
         applyTheme() sets in index.html. */
      html[data-ui-dark="1"] .radar-marker.silhouette:not(.radar-legendary) .radar-marker-img {
        filter: brightness(0)
          drop-shadow(1.3px 0 0 #fff) drop-shadow(-1.3px 0 0 #fff)
          drop-shadow(0 1.3px 0 #fff) drop-shadow(0 -1.3px 0 #fff);
      }
      /* Autogen status pill (Settings → "Show autogen labels on radar"). Uses
         the same accent that marks the pokedex autogen art badge, and is
         smaller than the countdown pill so the timer stays the primary read. */
      .radar-marker-autogen {
        font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px;
        color: #fff; background: var(--ui-accent, #b6896c);
        padding: 0 5px; border-radius: 999px; white-space: nowrap; margin-bottom: 3px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.4); pointer-events: none;
      }
      #creatureInventory .craft-hint {
        font-size: 12px; color: var(--ui-muted, #666);
        text-align: center; margin: 0 0 12px;
      }
      #creatureInventory .craft-strip {
        display: flex; gap: 10px; overflow-x: auto; padding: 4px 2px 12px;
        scroll-snap-type: x proximity; -webkit-overflow-scrolling: touch;
      }
      #creatureInventory .craft-orb {
        flex: 0 0 auto; scroll-snap-align: center;
        display: flex; flex-direction: column; align-items: center; gap: 4px;
        width: 92px; padding: 10px 6px; cursor: pointer;
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.08));
        border-radius: var(--ui-radius, 10px); font: inherit;
      }
      #creatureInventory .craft-orb:active { transform: scale(0.96); }
      #creatureInventory .craft-orb-img { width: 54px; height: 54px; }
      #creatureInventory .craft-orb-name {
        font-size: 13px; font-weight: 600; color: var(--ui-text, #111);
      }
      #creatureInventory .craft-orb-count { font-size: 11px; color: var(--ui-muted, #666); }
      #creatureInventory .craft-chosen { text-align: center; margin: 0 0 10px; }
      #creatureInventory .craft-chip {
        display: inline-flex; align-items: center; gap: 6px;
        font-size: 14px; font-weight: 600; color: var(--ui-text, #111);
      }
      #creatureInventory .craft-chip-orb { width: 22px; height: 22px; }
      #creatureInventory .craft-empty {
        padding: 20px 12px; text-align: center;
        color: var(--ui-muted, #666); font-size: 13px;
      }
      #creatureInventory .craft-egg-list { display: flex; flex-direction: column; gap: 6px; }
      #creatureInventory .craft-egg {
        display: flex; align-items: center; gap: 10px; width: 100%;
        padding: 8px 10px; cursor: pointer; text-align: left; font: inherit;
        background: var(--ui-hover, rgba(0,0,0,0.04));
        border: 1px solid var(--ui-hairline, rgba(0,0,0,0.08));
        border-radius: var(--ui-radius, 8px);
      }
      #creatureInventory .craft-egg:active { transform: scale(0.99); }
      #creatureInventory .craft-egg-art {
        width: 56px; height: 56px; flex: 0 0 auto; position: relative;
      }
      #creatureInventory .craft-egg-art.big { width: 72px; height: 72px; }
      /* 2×/3× yield badge in the top-right of the egg art (and the
         confirm orb). */
      #creatureInventory .craft-egg-mult {
        position: absolute; top: -4px; right: -4px;
        min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box;
        display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 700; line-height: 1; color: #fff;
        background: #e6a400; border: 1.5px solid #fff; border-radius: 9px;
        box-shadow: 0 1px 2px rgba(0,0,0,0.35);
      }
      #creatureInventory .craft-orb-wrap { position: relative; display: inline-block; }
      #creatureInventory .craft-egg-mult.on-orb { top: -2px; right: -2px; }
      #creatureInventory .craft-egg-info { flex: 1; display: flex; flex-direction: column; gap: 4px; }
      #creatureInventory .craft-egg-name {
        font-size: 14px; font-weight: 600; color: var(--ui-text, #111);
      }
      #creatureInventory .craft-confirm { text-align: center; padding: 10px 8px; }
      #creatureInventory .craft-confirm-row {
        display: flex; align-items: center; justify-content: center; gap: 14px; margin-bottom: 14px;
      }
      #creatureInventory .craft-arrow { font-size: 26px; color: var(--ui-muted, #888); }
      #creatureInventory .craft-confirm-orb, #creatureInventory .craft-done-orb { width: 72px; height: 72px; }
      #creatureInventory .craft-confirm-text, #creatureInventory .craft-done-text {
        font-size: 14px; color: var(--ui-text, #111); line-height: 1.4; margin-bottom: 16px;
      }
      #creatureInventory .craft-warn { font-size: 12px; color: #c0392b; }
      #creatureInventory .craft-confirm-actions {
        display: flex; gap: 10px; justify-content: center;
      }
      #creatureInventory .craft-confirm-actions button {
        padding: 9px 18px; font: inherit; font-weight: 600; cursor: pointer;
        border-radius: var(--ui-radius, 8px); border: 1px solid var(--ui-hairline, rgba(0,0,0,0.15));
        background: var(--ui-input-bg, #f2f2f2); color: var(--ui-text, #111);
      }
      #creatureInventory .craft-confirm-actions .craft-do,
      #creatureInventory .craft-confirm-actions .craft-more {
        background: linear-gradient(135deg, #7a5cff, #b06cff); color: #fff; border: none;
      }
      #creatureInventory .craft-done { text-align: center; padding: 16px 8px; }
      #creatureInventory .craft-done-orb { margin-bottom: 12px; }
      #creatureInventory .tags-view { display: none; }
      #creatureInventory .tags-view.show { display: flex; flex-direction: column; }
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
      /* Sub-view titles: full-width centered headings. The back
         button floats sticky in the top-left corner via its own
         rule (with -30px bottom margin to collapse layout space),
         so titles sit at the same Y as the back button without
         needing a grid wrapper. min-height matches the back
         button's 30px so vertical alignment is identical to the
         "Pokémon" header in the browse view. */
      #creatureInventory .pokedex-title,
      #creatureInventory .subview-title {
        margin: 0 0 6px;
        min-height: 30px;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
      }
      #creatureInventory .pokedex-stats {
        text-align: center;
        font-size: 12px; color: var(--ui-muted, #666);
        margin: 0 0 10px;
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
      /* Completion button at the top of the pokédex reuses .bag-craft. */
      #creatureInventory .pokedex-completion-btn { margin: 0 auto 10px; }
      /* ── Completion view + species-dex view ───────────────────── */
      #creatureInventory .completion-view { display: none; }
      #creatureInventory .completion-view.show { display: flex; flex-direction: column; }
      /* ── Glitch dex: solo (non-fusion) creatures ── */
      #creatureInventory .glitch-view { display: none; }
      #creatureInventory .glitch-view.show { display: flex; flex-direction: column; }
      #creatureInventory .glitch-stats { text-align: center; font-size: 12px; opacity: 0.8; margin: 2px 0 10px; }
      #creatureInventory .glitch-grid { display: flex; flex-direction: column; gap: 10px; padding: 0 2px 14px; }
      #creatureInventory .glitch-card {
        border: 1px solid rgba(127, 127, 127, 0.35); border-radius: 12px;
        padding: 12px; text-align: center;
      }
      #creatureInventory .glitch-card.glitch-focus { outline: 2px solid #6d5ac0; }
      #creatureInventory .glitch-art img {
        width: 96px; height: 96px; object-fit: contain; image-rendering: pixelated;
      }
      #creatureInventory .glitch-art img.silhouette { filter: brightness(0); opacity: 0.85; }
      #creatureInventory .glitch-name { font-weight: 700; margin-top: 4px; }
      #creatureInventory .glitch-blurb { font-size: 12.5px; opacity: 0.8; margin-top: 6px; }
      #creatureInventory .glitch-when { font-size: 11.5px; opacity: 0.6; margin-top: 4px; }
      /* Solo candy icon (special sprite, not the candies.png sheet). */
      #creatureInventory .candy-tally-icon-solo {
        width: 24px; height: 24px; object-fit: contain; vertical-align: middle;
        image-rendering: pixelated;
      }
      #creatureInventory .speciesdex-view { display: none; }
      #creatureInventory .speciesdex-view.show { display: flex; flex-direction: column; }
      #creatureInventory .completion-stats,
      #creatureInventory .speciesdex-stats {
        text-align: center; font-size: 12px; opacity: 0.8; margin: 2px 0 10px;
      }
      /* Non-evolved filter chip — a plain outlined button by default,
         accent-filled when the filter is active (aria-pressed). Matches
         the .family-toggle idiom but centered like a filter pill. */
      #creatureInventory .completion-filter,
      #creatureInventory .speciesdex-filter {
        align-self: center; background: transparent;
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 8px);
        color: var(--ui-text, #111);
        padding: 5px 12px; margin: 2px 0 8px;
        font-size: 12px; font-family: inherit; cursor: pointer;
      }
      #creatureInventory .completion-filter:hover,
      #creatureInventory .speciesdex-filter:hover {
        background: var(--ui-hover, rgba(0,0,0,0.04));
      }
      #creatureInventory .completion-filter.is-active,
      #creatureInventory .speciesdex-filter.is-active {
        background: var(--ui-accent, #3b7fdf);
        border-color: var(--ui-accent, #3b7fdf);
        color: var(--ui-accent-text, #fff);
      }
      #creatureInventory .completion-row {
        box-sizing: border-box; height: 60px; display: flex; align-items: center; gap: 10px;
        padding: 6px 10px; cursor: pointer;
        border: 1px solid var(--ui-border, rgba(0,0,0,0.12)); border-radius: var(--ui-radius, 8px);
      }
      #creatureInventory .completion-row:hover { background: var(--ui-hover, rgba(0,0,0,0.04)); }
      #creatureInventory .completion-icon {
        width: 44px; height: 44px; flex: none; display: flex; align-items: center; justify-content: center;
      }
      #creatureInventory .completion-icon img {
        max-width: 100%; max-height: 100%; object-fit: contain;
        image-rendering: pixelated; image-rendering: crisp-edges; display: none;
      }
      #creatureInventory .completion-row.ready .completion-icon img { display: block; }
      /* "Consistent pixel width" setting (cc.consistentIconWidth). Sprite
         blobs are cropped to their opaque bbox; the rules above scale each
         crop up to fill its box (object-fit: contain on a width/height of
         100%), which makes small creatures look zoomed and inconsistent from
         view to view. When the setting is on we add cc-consistent-icons to
         <html> and render every sprite at its intrinsic resolution instead:
         capped to the box but never upscaled, exactly like the map marker
         (max-width/max-height: 100%). One sprite pixel is then the same
         physical size in every view. Off by default, so the rules above
         (the current behaviour) stay the norm. No cache invalidation is
         needed — the blob is unchanged, only its layout box. */
      html.cc-consistent-icons #battleScreen img.battle-sprite,
      html.cc-consistent-icons #creatureInventory .pokedex-card .pokedex-art img,
      html.cc-consistent-icons #creatureInventory .detail-art img,
      html.cc-consistent-icons #creatureInventory .variant-cell img,
      html.cc-consistent-icons #creatureInventory .family-cell img,
      html.cc-consistent-icons #creatureInventory .evo-row .evo-art img {
        width: auto; height: auto;
        max-width: 100%; max-height: 100%;
        object-fit: contain;
        image-rendering: pixelated;
        image-rendering: crisp-edges;
      }
      #creatureInventory .completion-info { flex: 1 1 auto; min-width: 0; }
      #creatureInventory .completion-name {
        font-size: 14px; font-weight: 600; margin-bottom: 5px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      #creatureInventory .completion-bar {
        height: 7px; border-radius: 4px; overflow: hidden;
        background: var(--ui-border, rgba(0,0,0,0.14));
      }
      #creatureInventory .completion-bar-fill {
        height: 100%; border-radius: 4px; min-width: 2px;
        background: var(--ui-accent, #5b8cff);
      }
      #creatureInventory .completion-pct {
        flex: none; width: 54px; text-align: right; font-size: 13px; font-weight: 700; line-height: 1.15;
      }
      #creatureInventory .completion-frac { display: block; font-size: 10px; font-weight: 400; opacity: 0.6; }
      #creatureInventory .completion-bonus {
        margin-top: 4px; font-size: 10.5px; font-weight: 700; line-height: 1;
        color: var(--ui-accent, #5b8cff);
      }
      #creatureInventory .speciesdex-head-row {
        display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; align-items: end;
        padding: 0 2px 6px; font-size: 11px; opacity: 0.65;
      }
      #creatureInventory .speciesdex-col-head { text-align: left; }
      #creatureInventory .speciesdex-col-body { text-align: right; }
      #creatureInventory .speciesdex-col-mid { text-align: center; min-width: 64px; }
      #creatureInventory .speciesdex-row {
        box-sizing: border-box; height: 84px;
        display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; align-items: center;
      }
      #creatureInventory .speciesdex-cell {
        position: relative; height: 100%; min-width: 0; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        border: 1px solid var(--ui-border, rgba(0,0,0,0.12)); border-radius: var(--ui-radius, 8px);
      }
      #creatureInventory .speciesdex-cell:hover { background: var(--ui-hover, rgba(0,0,0,0.04)); }
      #creatureInventory .speciesdex-cell img {
        max-width: 92%; max-height: 72px; object-fit: contain;
        image-rendering: pixelated; image-rendering: crisp-edges; display: none;
      }
      #creatureInventory .speciesdex-cell.ready img { display: block; }
      #creatureInventory .speciesdex-cell-ph {
        position: absolute; opacity: 0.25; font-size: 22px; pointer-events: none;
      }
      #creatureInventory .speciesdex-cell.ready .speciesdex-cell-ph { display: none; }
      #creatureInventory .speciesdex-cell.silhouette img { filter: brightness(0); }
      #creatureInventory .speciesdex-cell .caught-badge {
        position: absolute; top: 4px; right: 4px;
        background: var(--ui-accent, #2a8); color: #fff; border-radius: 999px;
        width: 16px; height: 16px; font-size: 10px; line-height: 16px;
        text-align: center; font-weight: bold; z-index: 2;
      }
      /* "auto" tag (top-left, opposite the caught ✓) — same pill shape as the
         encounter screen's "New" badge, muted since it's just informational. */
      #creatureInventory .speciesdex-cell .speciesdex-auto-tag {
        display: none;   /* flex when .is-auto (below) */
        position: absolute; top: 4px; left: 4px; z-index: 2;
        height: 13px; padding: 0 5px; box-sizing: border-box;
        align-items: center; justify-content: center;
        font-size: 9px; line-height: 1; font-weight: 700; letter-spacing: 0.06em;
        text-transform: uppercase; color: #fff; background: rgba(0,0,0,0.6);
        border-radius: 999px; pointer-events: none; white-space: nowrap;
      }
      #creatureInventory .speciesdex-cell.is-auto .speciesdex-auto-tag { display: flex; }
      #creatureInventory .speciesdex-partner { text-align: center; min-width: 64px; line-height: 1.2; }
      #creatureInventory .speciesdex-partner .sd-num { display: block; font-size: 10px; opacity: 0.55; }
      #creatureInventory .speciesdex-partner .sd-name {
        display: block; font-size: 12px; font-weight: 600; max-width: 80px; margin: 0 auto;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
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
        height: 1.1em;
        /* Flex layout: first species (.bn-a) and × stay full-width;
           second species (.bn-b) shrinks with ellipsis when the line
           overflows. Result: "Squirtle × Bulbasaur" → "Squirtle ×
           Bulba…" when narrow. */
        display: flex;
        justify-content: center;
        align-items: baseline;
        max-width: 100%;
        overflow: hidden;
      }
      #creatureInventory .pokedex-card .pokedex-bases .bn-a,
      #creatureInventory .pokedex-card .pokedex-bases .bn-x {
        flex-shrink: 0;
        white-space: nowrap;
      }
      #creatureInventory .pokedex-card .pokedex-bases .bn-b {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      /* Same truncation when the bases pair is the primary (i.e.
         the canonical fused name isn't loaded yet). */
      #creatureInventory .pokedex-card .pokedex-name.pokedex-name-bases {
        display: flex;
        justify-content: center;
        align-items: baseline;
        max-width: 100%;
      }
      #creatureInventory .pokedex-card .pokedex-name.pokedex-name-bases .bn-a,
      #creatureInventory .pokedex-card .pokedex-name.pokedex-name-bases .bn-x {
        flex-shrink: 0;
        white-space: nowrap;
      }
      #creatureInventory .pokedex-card .pokedex-name.pokedex-name-bases .bn-b {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
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
      /* Browse header: centered "Pokémon" title. The sticky X
         overlays the right corner, but "Pokémon" is short enough
         to comfortably sit centered without colliding.
         min-height matches the .pokedex-title-row's natural height
         (driven by the back button's 22px font + 4px+4px vertical
         padding ≈ 30px) so the title sits at the same Y position
         as "Pokédex" — without the height match, this row was
         shorter and the title appeared a few px higher than the
         pokédex title in its grid row. */
      #creatureInventory .browse-header {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 30px;
        margin: 0 0 6px;
      }
      #creatureInventory .browse-header h3 { margin: 0; }
      /* Action icon row — centered on its own line below the
         "Pokémon" title. Tags / Bag / Candy / Pokédex. */
      #creatureInventory .header-actions {
        display: flex; gap: 6px;
        justify-content: center;
        margin: 0 0 8px;
      }
      #creatureInventory .pokedex-link,
      #creatureInventory .candy-link,
      #creatureInventory .daycare-link,
      #creatureInventory .eggs-link,
      #creatureInventory .bag-link,
      #creatureInventory .tags-link {
        background: transparent;
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 8px);
        color: var(--ui-text, #111);
        cursor: pointer;
        font-family: inherit;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
      }
      /* Icon-mode: square-ish padding around the 21×21 SVG. */
      #creatureInventory .header-actions-icons .pokedex-link,
      #creatureInventory .header-actions-icons .candy-link,
      #creatureInventory .header-actions-icons .daycare-link,
      #creatureInventory .header-actions-icons .eggs-link,
      #creatureInventory .header-actions-icons .bag-link,
      #creatureInventory .header-actions-icons .tags-link {
        padding: 4px 5px 2px 5px;
      }
      /* Text-mode: text labels need horizontal room and the same
         vertical rhythm as the icon variant. */
      #creatureInventory .header-actions-text .pokedex-link,
      #creatureInventory .header-actions-text .candy-link,
      #creatureInventory .header-actions-text .daycare-link,
      #creatureInventory .header-actions-text .eggs-link,
      #creatureInventory .header-actions-text .bag-link,
      #creatureInventory .header-actions-text .tags-link {
        padding: 5px 10px;
        font-size: 12px;
      }
      #creatureInventory .pokedex-link svg,
      #creatureInventory .candy-link svg,
      #creatureInventory .daycare-link svg,
      #creatureInventory .eggs-link svg,
      #creatureInventory .bag-link svg,
      #creatureInventory .tags-link svg {
        display: block;
        width: 21px;
        height: 21px;
      }
      #creatureInventory .pokedex-link:hover,
      #creatureInventory .candy-link:hover,
      #creatureInventory .daycare-link:hover,
      #creatureInventory .eggs-link:hover,
      #creatureInventory .bag-link:hover,
      #creatureInventory .tags-link:hover {
        background: var(--ui-hover, rgba(0,0,0,0.04));
      }
      #creatureInventory .weather-bar {
        margin: 0 0 12px;
        text-align: center;
      }
      /* The weather row is a button: tap it for the spawn-odds explainer. */
      #creatureInventory .weather-row {
        display: inline-flex; align-items: center;
        justify-content: center;
        gap: 6px;
        font-size: 12px;
        color: var(--ui-muted, #666);
        flex-wrap: wrap;
        -webkit-appearance: none; appearance: none;
        background: none; border: none; font-family: inherit;
        margin: 0 auto; padding: 4px 10px; cursor: pointer;
        border-radius: 999px; max-width: 100%;
      }
      #creatureInventory .weather-row:hover { background: var(--ui-hover, rgba(0,0,0,0.05)); }
      #creatureInventory .weather-row .label {
        color: var(--ui-muted, #666);
      }
      #creatureInventory .weather-row .weather-info {
        font-size: 12px; opacity: 0.55; margin-left: 2px;
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
      /* Long-press-to-save: kill the native callout / selection so our own
         "Save image" button is the single behavior on the art box. */
      #creatureInventory .detail-art {
        -webkit-touch-callout: none;
        -webkit-user-select: none; user-select: none;
      }
      #creatureInventory .detail-art .detail-art-save-btn {
        position: absolute; left: 50%; top: 50%;
        transform: translate(-50%, -50%); z-index: 6;
        display: inline-flex; align-items: center; gap: 6px;
        padding: 7px 13px; border: none; border-radius: 999px;
        font: inherit; font-size: 13px; font-weight: 600; line-height: 1;
        color: #fff; background: rgba(0, 0, 0, 0.74);
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
        cursor: pointer; white-space: nowrap;
        -webkit-tap-highlight-color: transparent;
        animation: detailArtSavePop 120ms ease-out;
      }
      #creatureInventory .detail-art .detail-art-save-btn svg { flex: 0 0 auto; }
      @keyframes detailArtSavePop {
        from { opacity: 0; transform: translate(-50%, -50%) scale(0.85); }
        to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      }
      /* Transient "Saved to Photos" / error notice after a sprite save. */
      .save-image-notice {
        position: fixed; left: 50%; bottom: 90px; z-index: 60;
        transform: translateX(-50%) translateY(8px);
        padding: 9px 16px; border-radius: 999px; max-width: 82vw;
        font-size: 13.5px; font-weight: 600; text-align: center;
        color: #fff; background: rgba(0, 0, 0, 0.8);
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
        opacity: 0; pointer-events: none;
        transition: opacity 200ms ease, transform 200ms ease;
      }
      .save-image-notice.show { opacity: 1; transform: translateX(-50%) translateY(0); }
      #creatureInventory .rename-form {
        display: flex; gap: 6px; justify-content: center;
        align-items: center;
        flex-wrap: nowrap;
      }
      /* Bordered input matching the rest of the panel's text fields,
         but typographically tuned to the title (16px bold centered)
         so the inline edit reads as the title becoming editable.
         outline:none + matching focus border kills the browser's
         default focus ring (which on most platforms paints a thicker
         second border on top of ours when focused). */
      #creatureInventory .rename-form input {
        flex: 1; min-width: 0; max-width: 170px;
        padding: 4px 8px;
        font-size: 16px;
        font-weight: 700;
        text-align: center;
        background: var(--ui-bg, #fff);
        color: var(--ui-text, #111);
        border: 1px solid var(--ui-border, rgba(0,0,0,0.15));
        border-radius: var(--ui-radius, 8px);
        font-family: inherit;
        outline: none;
      }
      #creatureInventory .rename-form input:focus,
      #creatureInventory .rename-form input:focus-visible {
        outline: none;
        border-color: var(--ui-border, rgba(0,0,0,0.15));
        box-shadow: none;
      }
      /* SVG icon buttons inside the rename form — small square hits
         next to the input, matching the minimal style of the rest
         of the panel's icon buttons. */
      #creatureInventory .rename-form .icon-btn {
        flex-shrink: 0;
        padding: 4px 5px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
      }
      #creatureInventory .rename-form .icon-btn svg {
        display: block;
        width: 18px;
        height: 18px;
      }
      /* Clickable name in view mode — subtle hover affordance so the
         user knows the title is interactive. No underline / button
         styling so it stays clean as a header. */
      #creatureInventory .detail-name-clickable {
        cursor: pointer;
        border-radius: var(--ui-radius, 8px);
        padding: 0 6px;
        transition: background 120ms ease;
      }
      #creatureInventory .detail-name-clickable:hover,
      #creatureInventory .detail-name-clickable:focus-visible {
        background: var(--ui-hover, rgba(0,0,0,0.06));
        outline: none;
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
      #battleScreen .battle-incense {
        position: absolute; top: 8px; right: 8px;
        width: 26px; height: 26px;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3));
      }
      #battleScreen .battle-new-badge {
        position: absolute;
        top: -10px; left: -8px;
        padding: 3px 9px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: #fff;
        background: var(--ui-accent, #b6896c);
        border-radius: 999px;
        box-shadow: 0 2px 6px rgba(0,0,0,0.35);
        text-shadow: 0 1px 1px rgba(0,0,0,0.35);
        transform: rotate(-8deg);
        transform-origin: center;
        pointer-events: none;
        white-space: nowrap;
        animation: battleNewPop 0.32s ease;
      }
      @keyframes battleNewPop {
        0%   { transform: rotate(-8deg) scale(0.5);  opacity: 0; }
        70%  { transform: rotate(-8deg) scale(1.12); opacity: 1; }
        100% { transform: rotate(-8deg) scale(1);    opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        #battleScreen .battle-new-badge { animation: none; }
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
      .candy-tally-pip {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        vertical-align: middle;
      }
      /* Inline candy icon for the per-pokémon tally — smaller than
         the candy-menu icon (24 vs 40) so it sits comfortably
         alongside the surrounding detail-view text. The sheet is
         scaled down to match (background-size shrinks the whole
         image proportionally so positions in 24px cells line up). */
      .candy-tally-icon {
        display: inline-block;
        width: 24px;
        height: 24px;
        background-image: url('${BUNDLED_BASE}/candies.png');
        background-size: ${24 * CANDY_SHEET_COLS}px ${24 * CANDY_SHEET_ROWS}px;
        background-repeat: no-repeat;
        image-rendering: pixelated;
        image-rendering: crisp-edges;
        flex-shrink: 0;
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

      /* Shiny indicator: small twinkling sparkle in the corner of the
         art container. The shiny color shift itself lives in the
         sprite blob (baked offline + applied via ShinyStore at render
         time); this badge is just a hint so the player knows what
         they're looking at. */
      #creatureInventory .creature-card { position: relative; }
      #creatureInventory .detail-art { position: relative; }
      #creatureInventory .creature-card .shiny-badge,
      #creatureInventory .detail-art .shiny-badge {
        position: absolute;
        top: 4px; right: 4px;
        width: 16px; height: 16px;
        z-index: 3;
        pointer-events: none;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.45));
      }
      #creatureInventory .detail-art .shiny-badge {
        top: 8px; right: 8px;
        width: 26px; height: 26px;
      }
      #battleScreen .battle-sprite-wrap .shiny-badge {
        position: absolute;
        top: -4px; right: -6px;
        width: 30px; height: 30px;
        opacity: 0;
        pointer-events: none;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5));
        transition: opacity 0.2s ease;
      }
      #battleScreen.battle-sprite-ready.battle-sprite-shiny
        .battle-sprite-wrap .shiny-badge {
        opacity: 1;
      }
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
        <button class="scroll-top-btn" type="button" aria-label="scroll to top" title="scroll to top">↑</button>
        <button class="close cc-x-btn inventory-x" type="button" aria-label="close">×</button>
        <div class="browse-view">
          <div class="browse-header">
            <h3>Pokémon</h3>
          </div>
          <div class="header-actions"></div>
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
        </div>
        <div class="pokedex-view">
          <button class="pokedex-back" type="button" aria-label="back">←</button>
          <h3 class="pokedex-title">Pokédex</h3>
          <div class="pokedex-stats"></div>
          <button class="bag-craft pokedex-completion-btn" type="button">Completion</button>
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
        </div>
        <div class="candy-view">
          <button class="candy-back" type="button" aria-label="back">←</button>
          <h3 class="subview-title">Candy</h3>
          <div class="candy-body"></div>
        </div>
        <div class="daycare-view">
          <button class="daycare-back" type="button" aria-label="back">←</button>
          <h3 class="subview-title">Daycare<button class="dc-odds-info" type="button" aria-label="Daycare odds" title="Egg, candy &amp; item odds">i</button></h3>
          <div class="daycare-body"></div>
        </div>
        <div class="eggs-view">
          <button class="eggs-back" type="button" aria-label="back">←</button>
          <h3 class="subview-title">Eggs</h3>
          <div class="eggs-body"></div>
        </div>
        <div class="bag-view">
          <button class="bag-back" type="button" aria-label="back">←</button>
          <h3 class="subview-title">Bag</h3>
          <div class="bag-body"></div>
        </div>
        <div class="craft-view">
          <button class="craft-back" type="button" aria-label="back">←</button>
          <h3 class="subview-title craft-title"><span class="craft-title-text">Craft</span><button class="cc-info-btn craft-info" type="button" aria-label="How incense works" title="How incense works">i</button></h3>
          <div class="craft-body"></div>
        </div>
        <div class="tags-view">
          <button class="tags-back" type="button" aria-label="back">←</button>
          <h3 class="subview-title">Tags</h3>
          <div class="tags-body"></div>
        </div>
        <div class="completion-view">
          <button class="completion-back" type="button" aria-label="back">←</button>
          <h3 class="subview-title">Completion</h3>
          <button class="completion-filter" type="button" aria-pressed="false">Show non-evolved only</button>
          <div class="completion-stats"></div>
          <div class="completion-grid"></div>
        </div>
        <div class="speciesdex-view">
          <button class="speciesdex-back" type="button" aria-label="back">←</button>
          <h3 class="subview-title speciesdex-title">Dex</h3>
          <button class="speciesdex-filter" type="button" aria-pressed="false">Show non-evolved only</button>
          <div class="speciesdex-stats"></div>
          <div class="speciesdex-head-row">
            <span class="speciesdex-col-label speciesdex-col-head"></span>
            <span class="speciesdex-col-mid">#</span>
            <span class="speciesdex-col-label speciesdex-col-body"></span>
          </div>
          <div class="speciesdex-grid"></div>
        </div>
        <div class="glitch-view">
          <button class="glitch-back" type="button" aria-label="back">←</button>
          <h3 class="subview-title">Glitch</h3>
          <div class="glitch-stats"></div>
          <div class="glitch-grid"></div>
        </div>
      </div>
    `;
    panel.addEventListener('click', (e) => {
      if (e.target === panel) hide();
    });
    panel.querySelectorAll('button.close').forEach((btn) => {
      btn.addEventListener('click', hide);
    });

    // Back-to-top button — appears in the corner cluster (left of
    // the X) when the sheet is scrolled past 200px AND the current
    // view is the inventory list or pokédex grid. Other views are
    // either short (candy/bag/tags) or have their own navigation
    // (detail/fusion).
    const scrollTopBtn = panel.querySelector('.scroll-top-btn');
    const sheetEl = panel.querySelector('.sheet');
    if (scrollTopBtn && sheetEl) {
      const updateBtn = () => {
        const top = _viewStack[_viewStack.length - 1];
        const scrollableView = top && (top.view === 'browse' || top.view === 'pokedex');
        const shouldShow = scrollableView && sheetEl.scrollTop > 200;
        scrollTopBtn.classList.toggle('show', shouldShow);
      };
      sheetEl.addEventListener('scroll', updateBtn, { passive: true });
      // Re-check on view changes — switching from pokédex to a
      // detail view should hide the button immediately, not wait
      // for the next scroll event.
      panel.addEventListener('cc-view-changed', updateBtn);
      scrollTopBtn.addEventListener('click', () => {
        sheetEl.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

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
    panel.querySelector('.daycare-back').addEventListener('click', popView);
    {
      const dcInfo = panel.querySelector('.dc-odds-info');
      if (dcInfo) dcInfo.addEventListener('click', (e) => { e.stopPropagation(); _showDaycareOdds(); });
    }
    panel.querySelector('.eggs-back').addEventListener('click', popView);
    panel.querySelector('.bag-back').addEventListener('click', popView);
    panel.querySelector('.craft-back').addEventListener('click', _craftBack);
    {
      const craftInfo = panel.querySelector('.craft-info');
      if (craftInfo) craftInfo.addEventListener('click', (e) => { e.stopPropagation(); _showIncenseInfo(); });
    }
    panel.querySelector('.tags-back').addEventListener('click', popView);
    panel.querySelector('.completion-back').addEventListener('click', popView);
    panel.querySelector('.speciesdex-back').addEventListener('click', popView);
    panel.querySelector('.glitch-back').addEventListener('click', popView);
    // Completion button (top of the pokédex) → species-completion list.
    panel.querySelector('.pokedex-completion-btn').addEventListener('click',
      () => pushView({ view: 'completion' }));
    // Non-evolved filter toggle in the completion header. Reset scroll so the
    // (now shorter/longer) list starts from the top after re-rendering.
    panel.querySelector('.completion-filter').addEventListener('click', () => {
      _completionNonEvolvedOnly = !_completionNonEvolvedOnly;
      const sheet = panel.querySelector('.sheet');
      if (sheet) sheet.scrollTop = 0;
      renderCompletion();
    });
    // Same non-evolved filter for a species' partner grid. Re-render the
    // species currently on top of the view stack; reset scroll so the
    // (now shorter/longer) grid starts from the top.
    panel.querySelector('.speciesdex-filter').addEventListener('click', () => {
      _speciesdexNonEvolvedOnly = !_speciesdexNonEvolvedOnly;
      const sheet = panel.querySelector('.sheet');
      if (sheet) sheet.scrollTop = 0;
      const top = _viewStack[_viewStack.length - 1];
      if (top && top.view === 'speciesdex') renderSpeciesDex(top.species);
    });
    // Delegated row taps. Listeners live on the (persistent) grid element;
    // virtualizeGrid swaps the rows underneath them as the user scrolls.
    panel.querySelector('.completion-grid').addEventListener('click', (e) => {
      const row = e.target.closest && e.target.closest('.completion-row');
      if (!row) return;
      const id = +row.dataset.species;
      if (id) pushView({ view: 'speciesdex', species: id });
    });
    const _speciesdexOpen = (cell) => {
      const a = +cell.dataset.a, b = +cell.dataset.b;
      if (a && b) showFusionView(a, b);
    };
    panel.querySelector('.speciesdex-grid').addEventListener('click', (e) => {
      const cell = e.target.closest && e.target.closest('.speciesdex-cell');
      if (cell) _speciesdexOpen(cell);
    });
    renderHeaderActions(panel);
    // Re-render when the user toggles the icon-vs-text preference in
    // Settings (event dispatched from index.html).
    window.addEventListener('cc-action-buttons-style-changed', () => {
      renderHeaderActions(panel);
    });
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
    // Notify view-aware UI (back-to-top button, etc.) that the active
    // view changed so they can re-evaluate their visibility.
    panel.dispatchEvent(new CustomEvent('cc-view-changed'));
    panel.querySelector('.browse-view').style.display = 'none';
    panel.querySelector('.detail-view').classList.remove('show');
    panel.querySelector('.pokedex-view').classList.remove('show');
    panel.querySelector('.fusion-view').classList.remove('show');
    panel.querySelector('.candy-view').classList.remove('show');
    panel.querySelector('.daycare-view').classList.remove('show');
    panel.querySelector('.eggs-view').classList.remove('show');
    panel.querySelector('.bag-view').classList.remove('show');
    panel.querySelector('.craft-view').classList.remove('show');
    panel.querySelector('.tags-view').classList.remove('show');
    panel.querySelector('.completion-view').classList.remove('show');
    panel.querySelector('.speciesdex-view').classList.remove('show');
    panel.querySelector('.glitch-view').classList.remove('show');
    // Post-catch context follows the active stack frame: the Done
    // button surfaces ONLY while the user is on the specific detail
    // entry that was opened by a successful catch (top.fromCatch).
    // Navigating away (back to browse, into fusion, etc.) hides Done;
    // back-arrow into the post-catch detail re-shows it.
    panel.classList.toggle('cc-post-catch',
      top.view === 'detail' && !!top.fromCatch);
    switch (top.view) {
      case 'browse': {
        panel.querySelector('.browse-view').style.display = '';
        // Rehydrate filter state captured before the user navigated
        // away (no-op on first entry — top.filters is undefined).
        if (top.filters) _applyInventoryFilters(panel, top.filters);
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
        // Filter rehydration order:
        //   1. If we captured filters on a previous push (back-nav)
        //      → restore them verbatim.
        //   2. Otherwise this is a fresh push — seed the search
        //      inputs from the showPokedex(opts) initial state.
        if (top.filters) {
          _applyPokedexFilters(panel, top.filters);
        } else {
          const sAny = panel.querySelector('#pokedexSearchAny');
          const sa = panel.querySelector('#pokedexSearchA');
          const sb = panel.querySelector('#pokedexSearchB');
          if (sAny) sAny.value = opts.searchAny || '';
          if (sa)   sa.value   = opts.searchA   || '';
          if (sb)   sb.value   = opts.searchB   || '';
        }
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
      case 'daycare':
        renderDaycare(top.opts || {});
        panel.querySelector('.daycare-view').classList.add('show');
        return;
      case 'eggs':
        renderEggs();
        panel.querySelector('.eggs-view').classList.add('show');
        return;
      case 'bag':
        renderBag();
        panel.querySelector('.bag-view').classList.add('show');
        return;
      case 'craft':
        renderCraft();
        panel.querySelector('.craft-view').classList.add('show');
        return;
      case 'tags':
        renderTags();
        panel.querySelector('.tags-view').classList.add('show');
        return;
      case 'completion': {
        // Show first so virtualizeGrid's offsetParent check passes, then
        // restore any saved scroll before the grid's first paint.
        panel.querySelector('.completion-view').classList.add('show');
        const sheet = panel.querySelector('.sheet');
        if (sheet) sheet.scrollTop = (top.scrollY || 0);
        renderCompletion();
        return;
      }
      case 'speciesdex': {
        panel.querySelector('.speciesdex-view').classList.add('show');
        const sheet = panel.querySelector('.sheet');
        if (sheet) sheet.scrollTop = (top.scrollY || 0);
        renderSpeciesDex(top.species);
        return;
      }
      case 'glitch': {
        panel.querySelector('.glitch-view').classList.add('show');
        renderGlitch(top.focus);
        return;
      }
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

  // Capture/apply pairs for the pokédex and inventory filter state.
  // Each pushView() snapshots the current top entry's filters into
  // its own stack entry; popping back into a captured pokédex /
  // browse entry rehydrates those filters before render — so the
  // user navigating back through the history sees each view's
  // filters as they were when they navigated AWAY from it.
  // Type filters / sort / tags persist via localStorage at run-time,
  // so the snapshot writes those keys on apply (the entry being
  // restored is the user's "current" filter state).
  // Strip any tag names from a stored filter snapshot that no longer
  // exist (user deleted the tag while the snapshot was sitting in a
  // _viewStack frame). Without this guard, _applyInventoryFilters /
  // _applyPokedexFilters write the stale snapshot back to localStorage
  // on re-entry to the view, resurrecting a filter for a tag no
  // capture has — which leaves the inventory permanently empty until
  // the user manually deselects the chip (which doesn't render
  // because the tag is gone). Argument shape: the JSON-stringified
  // array localStorage stores. Returns the same shape with deleted
  // tags filtered out, or the input verbatim if it doesn't parse.
  function _validateStoredTagFilter(raw) {
    if (!raw) return raw;
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return raw;
      const valid = new Set(allTagNames());
      const filtered = arr.filter((t) => typeof t === 'string' && valid.has(t));
      if (filtered.length === arr.length) return raw;
      return JSON.stringify(filtered);
    } catch { return raw; }
  }

  function _capturePokedexFilters(panel) {
    return {
      searchAny: (panel.querySelector('#pokedexSearchAny') || {}).value || '',
      searchA: (panel.querySelector('#pokedexSearchA') || {}).value || '',
      searchB: (panel.querySelector('#pokedexSearchB') || {}).value || '',
      filterType: localStorage.getItem('cc.pokedexFilterType') || '',
      filterTypeA: localStorage.getItem('cc.pokedexFilterTypeA') || '',
      filterTypeB: localStorage.getItem('cc.pokedexFilterTypeB') || '',
      sortBy: localStorage.getItem('cc.pokedexSortBy') || '',
      sortDir: localStorage.getItem('cc.pokedexSortDir') || '',
      tags: localStorage.getItem('cc.pokedexTagFilter') || '',
    };
  }
  function _applyPokedexFilters(panel, f) {
    if (!f) return;
    const sAny = panel.querySelector('#pokedexSearchAny');
    if (sAny) sAny.value = f.searchAny || '';
    const sa = panel.querySelector('#pokedexSearchA');
    if (sa) sa.value = f.searchA || '';
    const sb = panel.querySelector('#pokedexSearchB');
    if (sb) sb.value = f.searchB || '';
    localStorage.setItem('cc.pokedexFilterType', f.filterType || '');
    localStorage.setItem('cc.pokedexFilterTypeA', f.filterTypeA || '');
    localStorage.setItem('cc.pokedexFilterTypeB', f.filterTypeB || '');
    if (f.sortBy) localStorage.setItem('cc.pokedexSortBy', f.sortBy);
    if (f.sortDir) localStorage.setItem('cc.pokedexSortDir', f.sortDir);
    localStorage.setItem('cc.pokedexTagFilter', _validateStoredTagFilter(f.tags) || '');
    // Sync DOM selects so they reflect the restored values, and
    // re-apply the type-color background trick so a select set
    // back to "any" loses its themed color and one set to a type
    // re-paints to that type's chip color.
    const ft = panel.querySelector('#pokedexFilterType');
    if (ft) { ft.value = f.filterType || ''; applyTypeSelectColor(ft); }
    const fta = panel.querySelector('#pokedexFilterTypeA');
    if (fta) { fta.value = f.filterTypeA || ''; applyTypeSelectColor(fta); }
    const ftb = panel.querySelector('#pokedexFilterTypeB');
    if (ftb) { ftb.value = f.filterTypeB || ''; applyTypeSelectColor(ftb); }
    const sortBy = panel.querySelector('#pokedexSortBy');
    if (sortBy && f.sortBy) sortBy.value = f.sortBy;
  }
  function _captureInventoryFilters(panel) {
    return {
      search: (panel.querySelector('#creatureSearch') || {}).value || '',
      searchAny: (panel.querySelector('#creatureSearchAny') || {}).value || '',
      searchA: (panel.querySelector('#creatureSearchA') || {}).value || '',
      searchB: (panel.querySelector('#creatureSearchB') || {}).value || '',
      filterType: localStorage.getItem('cc.invFilterType') || '',
      filterTypeA: localStorage.getItem('cc.invFilterTypeA') || '',
      filterTypeB: localStorage.getItem('cc.invFilterTypeB') || '',
      sortBy: localStorage.getItem('cc.creatureSortBy') || '',
      sortDir: localStorage.getItem('cc.creatureSortDir') || '',
      tags: localStorage.getItem('cc.invTagFilter') || '',
    };
  }
  function _applyInventoryFilters(panel, f) {
    if (!f) return;
    const s = panel.querySelector('#creatureSearch');
    if (s) s.value = f.search || '';
    const sAny = panel.querySelector('#creatureSearchAny');
    if (sAny) sAny.value = f.searchAny || '';
    const sa = panel.querySelector('#creatureSearchA');
    if (sa) sa.value = f.searchA || '';
    const sb = panel.querySelector('#creatureSearchB');
    if (sb) sb.value = f.searchB || '';
    localStorage.setItem('cc.invFilterType', f.filterType || '');
    localStorage.setItem('cc.invFilterTypeA', f.filterTypeA || '');
    localStorage.setItem('cc.invFilterTypeB', f.filterTypeB || '');
    if (f.sortBy) localStorage.setItem('cc.creatureSortBy', f.sortBy);
    if (f.sortDir) localStorage.setItem('cc.creatureSortDir', f.sortDir);
    localStorage.setItem('cc.invTagFilter', _validateStoredTagFilter(f.tags) || '');
    const ft = panel.querySelector('#creatureFilterType');
    if (ft) { ft.value = f.filterType || ''; applyTypeSelectColor(ft); }
    const fta = panel.querySelector('#creatureFilterTypeA');
    if (fta) { fta.value = f.filterTypeA || ''; applyTypeSelectColor(fta); }
    const ftb = panel.querySelector('#creatureFilterTypeB');
    if (ftb) { ftb.value = f.filterTypeB || ''; applyTypeSelectColor(ftb); }
    const sortBy = panel.querySelector('#creatureSortBy');
    if (sortBy && f.sortBy) sortBy.value = f.sortBy;
  }
  function _captureCurrentFilters() {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const top = _viewStack[_viewStack.length - 1];
    if (!top) return;
    if (top.view === 'pokedex') {
      top.filters = _capturePokedexFilters(panel);
    } else if (top.view === 'browse') {
      top.filters = _captureInventoryFilters(panel);
    }
  }

  function pushView(state) {
    _captureCurrentScroll();
    _captureCurrentFilters();
    _viewStack.push(state);
    applyTopView();
  }

  function popView() {
    if (_viewStack.length > 1) {
      const popped = _viewStack.pop();
      applyTopView();
      // If we're leaving a fusion view that was opened from the daycare odds
      // popup, re-open that popup (restoring its scroll) so back returns the
      // user to the egg-outcome list, not the bare daycare menu.
      if (popped && popped.fromDaycareOdds) {
        _showDaycareOdds();
        const card = _dcOddsEl && _dcOddsEl.querySelector('.dc-odds-card');
        if (card) card.scrollTop = popped.dcOddsScrollY || 0;
        if (_dcOddsEl && _dcOddsEl._updateOddsFloat) _dcOddsEl._updateOddsFloat();
      }
    } else {
      // Already at the root view — nothing to pop. Stay put.
      applyTopView();
    }
  }

  function showBrowse() {
    _viewStack = [{ view: 'browse' }];
    applyTopView();
  }

  function showDetail(id, list, idx, opts) {
    // Stamp the moment the user tapped (or whatever code called us)
    // so renderDetail's perf instrumentation can split out "dispatch
    // overhead" (push view → applyTopView → _populateTrack → ...)
    // from the actual sync render cost. Reset to null after each
    // renderDetail consumes it to keep stamps from leaking across
    // unrelated entries.
    _invPerf._detailOpenStart = performance.now();
    const state = { view: 'detail', id };
    if (Array.isArray(list) && typeof idx === 'number') {
      state.list = list;
      state.idx = idx;
    }
    // Mark the post-catch context on the stack frame, not the panel,
    // so back-nav into and out of this detail entry adds/removes the
    // .cc-post-catch class via applyTopView. That way the Done
    // button only surfaces for THIS specific catch entry, not later
    // detail visits during the same panel session.
    if (opts && opts.fromCatch) state.fromCatch = true;
    pushView(state);
  }

  function showFusionView(a, b, list, idx, opts) {
    const state = { view: 'fusion', a, b };
    if (Array.isArray(list) && typeof idx === 'number') {
      state.list = list;
      state.idx = idx;
    }
    // Optional UX flags carried on the state so they survive carousel
    // navigation through cached slots. expandFamily: open the family
    // tree by default (used when navigating in from a family-tree
    // tile — the user obviously already cares about the family).
    if (opts && opts.expandFamily) state.expandFamily = true;
    // Opened by tapping an egg outcome in the daycare odds popup — remember so
    // popping back re-opens that popup (at its saved scroll) instead of just
    // dropping to the daycare menu.
    if (opts && opts.fromDaycareOdds) {
      state.fromDaycareOdds = true;
      state.dcOddsScrollY = opts.dcOddsScrollY || 0;
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
    browse:  { cols: 3, rowPitch: 153 },  // cardHeight 145 + rowGap 8
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
      renderFusionView(item.a, item.b, body, { expandFamily: !!item.expandFamily });
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
    // When called with a search seed (species-link click from a
    // fusion entry), embed a CLEARED filter snapshot directly in
    // the new entry — type / sort / tag filters from the previous
    // pokédex would otherwise carry over via localStorage and
    // mask the user's intent ("show me all fusions of THIS
    // species"). The previous pokédex's filters are still saved
    // on its own stack entry by pushView's _captureCurrentFilters
    // call, so back-navigation restores them.
    const o = opts || {};
    const isSpeciesClick = (o.searchAny || o.searchA || o.searchB);
    if (isSpeciesClick) {
      pushView({
        view: 'pokedex',
        opts: o,
        filters: {
          searchAny: o.searchAny || '',
          searchA: o.searchA || '',
          searchB: o.searchB || '',
          filterType: '',
          filterTypeA: '',
          filterTypeB: '',
          // sort/tags use empty so _applyPokedexFilters wipes them.
          sortBy: localStorage.getItem('cc.pokedexSortBy') || '',
          sortDir: localStorage.getItem('cc.pokedexSortDir') || '',
          tags: '',
        },
      });
    } else {
      pushView({ view: 'pokedex', opts: o });
    }
  }

  function showCandy() {
    pushView({ view: 'candy' });
  }

  function showDaycare() {
    pushView({ view: 'daycare' });
  }

  function showEggs() {
    pushView({ view: 'eggs' });
  }

  // Eggs view: shows the two incubator slots at the top + a grid of
  // available (un-incubated) eggs below. Eggs drag between the grid
  // and the slots; while in a slot they accumulate walked distance
  // toward INCUBATOR_HATCH_M, persisted on the egg record so swaps
  // are non-destructive. When an egg's incubatedM hits the
  // threshold, the slot card surfaces a "Tap to hatch" CTA which
  // creates a level-1 capture record from the egg's content +
  // size, removes the egg, and frees the slot.
  // Resolve which species' egg cell to render for a given egg.
  // Cross-breed eggs sample displaySpecies separately and store it;
  // pre-cross-breed records don't have it and fall back to speciesA
  // (which was the parent's first species, identical to content).
  function _eggArtSpecies(egg) {
    return Number.isInteger(egg && egg.displaySpecies)
      ? egg.displaySpecies
      : (egg && egg.speciesA);
  }

  // CSS background-* string for a single eggs.png cell sized to
  // `cellPx` × `cellPx`. Each cell in eggs.png is 160 px native;
  // eggs.png contains a mostly-empty bottom area plus the visible
  // art clustered ~25–60 % of the cell, so we render a slightly
  // bigger window than `cellPx` and offset upward so the visible
  // egg sits centred. (Same trick the daycare loot pill uses, just
  // parameterised on cellPx so slot icons can be ~56 px while grid
  // tiles are ~48 px.)
  function _eggArtBackgroundCss(speciesId, cellPx) {
    if (!Number.isInteger(speciesId)) return '';
    const sheetCellPx = Math.round(cellPx * (160 / 60));
    const col = speciesId % EGGS_SHEET_COLS;
    const row = Math.floor(speciesId / EGGS_SHEET_COLS);
    const inset = Math.round((sheetCellPx - cellPx) / 2);
    return (
      `background-image: url('${BUNDLED_BASE}/eggs.png');`
      + `background-size: ${sheetCellPx * EGGS_SHEET_COLS}px ${sheetCellPx * EGGS_SHEET_ROWS}px;`
      + `background-position: -${col * sheetCellPx + inset}px -${row * sheetCellPx + inset - 1}px;`
      + `background-repeat: no-repeat;`
      + `image-rendering: pixelated;`
      + `image-rendering: crisp-edges;`
    );
  }

  // ── Solo-egg aware helpers (eggs from daycare duplication of a
  // special creature). Pair eggs flow through unchanged.
  function _isSoloEgg(egg) { return !!(egg && typeof egg.solo === 'string' && egg.solo); }
  function _eggName(egg) {
    if (_isSoloEgg(egg)) return creatureName(egg);
    return fusionName(egg.speciesA, egg.speciesB);
  }
  function _eggTypes(egg) {
    if (_isSoloEgg(egg)) return creatureTypes(egg);
    return global.Species ? global.Species.fusionTypesFor(egg.speciesA, egg.speciesB) : [];
  }
  // Art for ANY egg: solo eggs render the special's full-PNG sprite;
  // pair eggs render their eggs.png sheet cell as before.
  function _eggArtCss(egg, cellPx) {
    if (_isSoloEgg(egg)) {
      const url = (global.Specials && global.Specials.spriteUrl(egg.solo)) || '';
      return (
        `background-image: url('${url}');`
        + `background-size: contain;`
        + `background-position: center;`
        + `background-repeat: no-repeat;`
        + `image-rendering: pixelated;`
        + `image-rendering: crisp-edges;`
      );
    }
    return _eggArtBackgroundCss(_eggArtSpecies(egg), cellPx);
  }

  function _formatIncubationKm(meters) {
    const km = (meters || 0) / 1000;
    return `${km.toFixed(2)} / ${(INCUBATOR_HATCH_M / 1000).toFixed(0)} km`;
  }

  function _incubatorSlotHtml(idx, egg) {
    if (!egg) {
      return (
        `<div class="incubator-slot empty" data-slot="${idx}" data-zone="slot">`
        + `Drop an egg here`
        + `</div>`
      );
    }
    const ready = eggReadyToHatch(egg);
    const incubatedM = eggIncubatedM(egg);
    const pct = Math.min(100,
      Math.round((incubatedM / INCUBATOR_HATCH_M) * 100));
    const artStyle = _eggArtCss(egg, 48);
    const name = _eggName(egg);
    const cls = `incubator-slot${ready ? ' ready' : ''}`;
    const hatchBtn = ready
      ? `<button class="slot-hatch" type="button" data-hatch-id="${escapeHtml(egg.id)}">Tap to hatch</button>`
      : '';
    return (
      `<div class="${cls}" data-slot="${idx}" data-zone="slot">`
      + `<div class="egg-tile slot-egg-tile" data-egg-id="${escapeHtml(egg.id)}" data-from-slot="${idx}" aria-label="${escapeHtml(name)} egg">`
      +   `<div class="tile-art" style="${artStyle}"></div>`
      +   `<div class="tile-name">${escapeHtml(name)}</div>`
      + `</div>`
      + `<div class="slot-progress" aria-hidden="true"><div class="fill" style="width:${pct}%"></div></div>`
      + `<div class="slot-distance">${_formatIncubationKm(incubatedM)}</div>`
      + hatchBtn
      + `</div>`
    );
  }

  function _eggTileHtml(egg) {
    const artStyle = _eggArtCss(egg, 48);
    const name = _eggName(egg);
    const incubatedM = eggIncubatedM(egg);
    const pct = Math.min(100,
      Math.round((incubatedM / INCUBATOR_HATCH_M) * 100));
    const progress = incubatedM > 0
      ? `<div class="tile-progress" aria-hidden="true"><div class="fill" style="width:${pct}%"></div></div>`
      : '';
    return (
      `<div class="egg-tile" data-egg-id="${escapeHtml(egg.id)}" aria-label="${escapeHtml(name)} egg">`
      + `<div class="tile-art" style="${artStyle}"></div>`
      + `<div class="tile-name">${escapeHtml(name)}</div>`
      + progress
      + `</div>`
    );
  }

  function renderEggs() {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const body = panel.querySelector('.eggs-body');
    if (!body) return;
    // Once-per-body listener: walking ticks up incubatedM on
    // occupied eggs, which dispatches cc-incubator-tick. Re-render
    // the whole eggs view on each tick — the view's small (two
    // slots + a grid) so a full rebuild is cheap and keeps the
    // progress bars + "ready to hatch" CTAs in lockstep.
    if (!body._incubatorTickHandler) {
      const handler = () => {
        // Only re-render if the eggs-view is currently visible —
        // otherwise the next showEggs() naturally picks up the
        // updated state.
        const view = panel.querySelector('.eggs-view');
        if (view && view.classList.contains('show')) renderEggs();
      };
      body._incubatorTickHandler = handler;
      window.addEventListener('cc-incubator-tick', handler);
    }
    const eggs = readEggs();
    if (!eggs.length) {
      body.innerHTML = `
        <div class="eggs-empty">
          No eggs yet — keep walking with a pokémon in the daycare and one will eventually drop.
        </div>
      `;
      return;
    }
    const incubSlots = readIncubator();
    const eggById = new Map(eggs.map((e) => [e.id, e]));
    const incubatorHtml = (
      `<div class="incubator">`
      + _incubatorSlotHtml(0, eggById.get(incubSlots[0]) || null)
      + _incubatorSlotHtml(1, eggById.get(incubSlots[1]) || null)
      + `</div>`
    );
    const slottedSet = new Set(incubSlots.filter((id) => !!id));
    const remainingEggs = eggs
      .filter((e) => !slottedSet.has(e.id))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const subtitle = `${eggs.length} egg${eggs.length === 1 ? '' : 's'}`;
    const tiles = remainingEggs.map(_eggTileHtml).join('');
    const gridHtml = (
      `<div class="eggs-grid-zone" data-zone="grid">`
      + `<div class="eggs-grid">${tiles}</div>`
      + `</div>`
    );
    body.innerHTML = (
      `<div class="eggs-subtitle">${escapeHtml(subtitle)}</div>`
      + incubatorHtml
      + gridHtml
    );
    // Wire pointer-based drag-and-drop for the incubator + grid.
    // Re-bound on every render — innerHTML wipes prior listeners
    // automatically, no manual cleanup needed.
    _setupEggDragDrop(body);
    // Hatch buttons.
    body.querySelectorAll('.slot-hatch').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const eggId = btn.dataset.hatchId;
        // hatchEgg is async — it awaits the per-cell custom-variant
        // count so the rolled variant lands on the entry before
        // first persist.
        const entry = await hatchEgg(eggId);
        if (!entry) return;
        renderEggs();
        // Send the user to the new capture's detail page, matching
        // the post-capture flow for wild catches. show() ensures the
        // inventory is open in the right view stack.
        try { showDetail(entry.id); } catch {}
      });
    });
  }

  // ── Egg drag-and-drop ──────────────────────────────────────────
  // Pointer-event-based drag system for the eggs view. Egg tiles
  // are draggable; slots and the grid container are drop zones.
  // Drop semantics:
  //   tile → empty slot:   egg moves into slot
  //   tile → filled slot:  swap (kicks out the existing occupant
  //                        back to the grid)
  //   tile (in slot) → grid: egg returns to grid (slot empties)
  //   anywhere invalid:    snap back, no state change
  // No HTML5 DnD — that API is unreliable on touch devices and
  // would need a polyfill. Pointer events work uniformly across
  // mouse + touch + pen, on Capacitor Android, iOS, and desktop.
  let _eggDragState = null;
  function _setupEggDragDrop(rootEl) {
    if (!rootEl) return;
    const tiles = rootEl.querySelectorAll('.egg-tile');
    tiles.forEach((tile) => {
      tile.addEventListener('pointerdown', (ev) => _onEggPointerDown(ev, tile, rootEl));
    });
  }

  function _onEggPointerDown(ev, tile, rootEl) {
    if (ev.button !== undefined && ev.button !== 0) return;
    const eggId = tile.dataset.eggId;
    if (!eggId) return;
    // Threshold-based drag start: track the pointer until it moves
    // more than DRAG_THRESHOLD px before committing visuals. Below
    // that, treat the gesture as a tap (no-op for now).
    const DRAG_THRESHOLD = 5;
    const startX = ev.clientX;
    const startY = ev.clientY;
    let started = false;
    let ghost = null;
    let lastDropZone = null;
    // Auto-scroll the view when the drag nears the top/bottom edge, so the
    // incubator slots (scrolled off the top) can be reached mid-drag.
    const scrollEl = rootEl.closest('.sheet');
    let pointerX = 0, pointerY = 0, scrollRAF = 0;
    const fromSlotAttr = tile.dataset.fromSlot;
    const fromSlot = (fromSlotAttr === '0' || fromSlotAttr === '1')
      ? Number(fromSlotAttr) : null;

    const setDropTarget = (el) => {
      if (lastDropZone === el) return;
      if (lastDropZone) lastDropZone.classList.remove('drop-active');
      lastDropZone = el;
      if (el) el.classList.add('drop-active');
    };

    const findDropZone = (x, y) => {
      // elementFromPoint returns the topmost element under the
      // pointer; walk up until we find a [data-zone] ancestor (slot
      // or grid). The ghost has pointer-events:none so it doesn't
      // shadow itself.
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      return el.closest('[data-zone]');
    };

    // While the pointer sits in the top/bottom EDGE band, scroll the sheet
    // (speed ramps with proximity to the edge) and keep the drop target under
    // the now-moving content in sync. Self-perpetuating via rAF so it keeps
    // scrolling even when the finger is held still at the edge.
    const EDGE = 64;
    const MAX_SPEED = 14;   // px per frame at the very edge
    const autoScrollStep = () => {
      scrollRAF = 0;
      if (!started || !scrollEl) return;
      const rect = scrollEl.getBoundingClientRect();
      let dv = 0;
      if (pointerY < rect.top + EDGE) dv = -MAX_SPEED * Math.min(1, (rect.top + EDGE - pointerY) / EDGE);
      else if (pointerY > rect.bottom - EDGE) dv = MAX_SPEED * Math.min(1, (pointerY - (rect.bottom - EDGE)) / EDGE);
      if (dv === 0) return;  // pointer left the edge band
      const before = scrollEl.scrollTop;
      const max = scrollEl.scrollHeight - scrollEl.clientHeight;
      scrollEl.scrollTop = Math.max(0, Math.min(max, before + dv));
      if (scrollEl.scrollTop === before) return;  // hit the scroll end
      if (ghost) { ghost.style.left = `${pointerX}px`; ghost.style.top = `${pointerY}px`; }
      setDropTarget(findDropZone(pointerX, pointerY));
      scrollRAF = requestAnimationFrame(autoScrollStep);
    };

    const onMove = (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!started && (dx * dx + dy * dy) < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      if (!started) {
        started = true;
        tile.classList.add('dragging');
        // Try to capture so subsequent events come straight to us
        // even if the finger leaves the tile bbox.
        try { tile.setPointerCapture(e.pointerId); } catch {}
        // Ghost mirrors the tile's art at a slightly larger size so
        // the user can see what they're dragging.
        ghost = document.createElement('div');
        ghost.className = 'egg-drag-ghost';
        const art = tile.querySelector('.tile-art');
        if (art) ghost.style.cssText = art.style.cssText;
        document.body.appendChild(ghost);
      }
      pointerX = e.clientX;
      pointerY = e.clientY;
      if (ghost) {
        ghost.style.left = `${e.clientX}px`;
        ghost.style.top = `${e.clientY}px`;
      }
      setDropTarget(findDropZone(e.clientX, e.clientY));
      if (!scrollRAF) scrollRAF = requestAnimationFrame(autoScrollStep);
    };

    const onUp = (e) => {
      cleanup();
      if (!started) return;
      const drop = findDropZone(e.clientX, e.clientY);
      if (!drop) return;  // Snap back: no state change, re-render not needed.
      const zone = drop.dataset.zone;
      if (zone === 'slot') {
        const targetSlot = Number(drop.dataset.slot);
        if (targetSlot !== 0 && targetSlot !== 1) return;
        const incub = readIncubator();
        if (fromSlot !== null) {
          // Slot → slot: swap.
          if (fromSlot === targetSlot) return;
          swapIncubatorSlots(fromSlot, targetSlot);
        } else {
          // Grid → slot: drop in. If the slot was occupied, that
          // egg automatically returns to the grid because
          // setIncubatorSlot replaces the binding.
          setIncubatorSlot(targetSlot, eggId);
        }
        renderEggs();
      } else if (zone === 'grid') {
        if (fromSlot !== null) {
          // Slot → grid: empty the slot.
          setIncubatorSlot(fromSlot, null);
          renderEggs();
        }
        // Grid → grid: no state change needed, no re-render.
      }
    };

    const onCancel = () => cleanup();

    const cleanup = () => {
      if (scrollRAF) { cancelAnimationFrame(scrollRAF); scrollRAF = 0; }
      tile.classList.remove('dragging');
      if (lastDropZone) lastDropZone.classList.remove('drop-active');
      if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
      ghost = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
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
  // Category rank for the bag list: incense first, then evolution
  // items, then poké balls, then anything else (e.g. the test_orb
  // placeholder). Lower rank sorts higher in the list.
  function _bagEntryRank(key) {
    const meta = ITEMS[key] || {};
    if (meta.incenseType) return 0;         // incense
    if (EVO_ITEM_SET.has(key)) return 1;    // evolution items
    if (meta.catchShakeRate) return 2;      // poké balls
    return 3;                               // everything else
  }
  // Bag entries ([key, count]) with empties dropped, ordered by
  // category (incense → evo → balls → other), then count-desc, then
  // display name. Pulled out of renderBag so it can be unit-tested.
  function _sortedBagEntries(bag) {
    return Object.entries(bag)
      .filter(([, n]) => n > 0)
      .sort((a, b) => {
        const ra = _bagEntryRank(a[0]), rb = _bagEntryRank(b[0]);
        if (ra !== rb) return ra - rb;
        if (b[1] !== a[1]) return b[1] - a[1];
        const na = (ITEMS[a[0]] && ITEMS[a[0]].name) || a[0];
        const nb = (ITEMS[b[0]] && ITEMS[b[0]].name) || b[0];
        return na.localeCompare(nb);
      });
  }
  function renderBag() {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const body = panel.querySelector('.bag-body');
    if (!body) return;
    // Craft launcher — always available (you craft from eggs, not from
    // bag contents), so it shows even when the bag is empty.
    const craftBtnHtml = `<button class="bag-craft" type="button">Craft incense</button>`;
    // Active-incense banner (if one is burning).
    const active = readActiveIncense();
    let bannerHtml = '';
    if (active) {
      const meta = ITEMS[_incenseKey(active.type)] || {};
      const mins = Math.ceil(incenseRemainingMs() / 60000);
      const tn = global.Types.displayName(active.type);
      bannerHtml = `<div class="bag-incense-banner">`
        + (meta.icon ? `<img class="bag-icon" src="${escapeHtml(meta.icon)}" alt="">` : '')
        + `<div class="bag-info"><div class="bag-name">${escapeHtml(tn)} Incense active</div>`
        + `<div class="bag-desc">~${mins} min left · extra ${escapeHtml(tn)} spawns, double shiny</div></div>`
        + `</div>`;
    }
    const wire = () => {
      const cb = body.querySelector('.bag-craft');
      if (cb) cb.addEventListener('click', showCraft);
      body.querySelectorAll('.bag-use').forEach((btn) => {
        btn.addEventListener('click', () => _confirmUseIncense(btn.dataset.incense));
      });
    };
    const bag = readBag();
    const entries = _sortedBagEntries(bag);
    if (!entries.length) {
      body.innerHTML = craftBtnHtml + bannerHtml + `
        <div class="bag-empty">Bag is empty.</div>
      `;
      wire();
      return;
    }
    const total = entries.reduce((sum, [, n]) => sum + n, 0);
    const subtitle = `${total} item${total === 1 ? '' : 's'} across ${entries.length} type${entries.length === 1 ? '' : 's'}`;
    const rows = entries.map(([key, n]) => {
      const meta = ITEMS[key] || { name: key, desc: '' };
      const iconHtml = meta.icon
        ? `<img class="bag-icon" src="${escapeHtml(meta.icon)}" alt="">`
        : '';
      const useBtn = meta.incenseType
        ? `<button class="bag-use" type="button" data-incense="${escapeHtml(meta.incenseType)}">Use</button>`
        : '';
      return `
        <div class="bag-row${meta.incenseType ? ' bag-row-incense' : ''}">
          ${iconHtml}
          <div class="bag-info">
            <div class="bag-name">${escapeHtml(meta.name)}</div>
            ${meta.desc ? `<div class="bag-desc">${escapeHtml(meta.desc)}</div>` : ''}
          </div>
          <div class="bag-row-right">
            <div class="bag-count">×${n}</div>
            ${useBtn}
          </div>
        </div>
      `;
    }).join('');
    body.innerHTML = craftBtnHtml + bannerHtml + `
      <div class="bag-subtitle">${escapeHtml(subtitle)}</div>
      <div class="bag-list">${rows}</div>
    `;
    wire();
  }
  function _confirmUseIncense(type) {
    if (!type || !global.Types.isValid(type)) return;
    const tn = global.Types.displayName(type);
    const active = readActiveIncense();
    let msg = `Use ${tn} Incense?\n\nFor 30 minutes you'll see extra ${tn}-type spawns, with double the shiny rate.`;
    if (active) {
      const mins = Math.ceil(incenseRemainingMs() / 60000);
      msg += `\n\nThis replaces your active ${global.Types.displayName(active.type)} Incense (~${mins} min left).`;
    }
    if (!confirm(msg)) return;
    if (activateIncense(type)) renderBag();
    else alert(`You have no ${tn} Incense.`);
  }

  // ── Craft: convert an egg into incense ──
  // 3 steps inside one 'craft' view: pick an incense type (swipe the
  // orb strip), pick a valid egg (its type must be neutral-or-effective
  // against the chosen incense type), confirm. Eggs currently in an
  // incubator slot are excluded (they're committed to hatching). The
  // craft-view back button steps backward, then exits to the bag.
  let _craftState = { step: 1, type: null, eggId: null };
  function showCraft() {
    _craftState = { step: 1, type: null, eggId: null };
    pushView({ view: 'craft' });
  }
  function _craftBack() {
    if (_craftState.step > 1) {
      _craftState.step -= 1;
      if (_craftState.step < 2) _craftState.type = null;
      if (_craftState.step < 3) _craftState.eggId = null;
      renderCraft();
    } else {
      popView();
    }
  }
  function removeEggById(id) {
    const arr = readEggs();
    const idx = arr.findIndex((e) => e && e.id === id);
    if (idx < 0) return false;
    arr.splice(idx, 1);
    writeEggs(arr);
    return true;
  }
  // Eggs eligible to be crafted into incense of `type`: not currently in
  // an incubator slot, and at least one of the egg's fusion types is
  // neutral-or-effective against `type`.
  function _craftableEggsFor(type) {
    const slotted = new Set((readIncubator() || []).filter(Boolean));
    return readEggs().filter((e) => {
      if (slotted.has(e.id)) return false;
      return eggTypesNeutralOrEffectiveVs(_eggTypes(e), type);
    });
  }
  function _craftSetTitle(text) {
    const panel = document.getElementById('creatureInventory');
    // Only the text span is overwritten — the ".craft-info" (i) button lives
    // alongside it in the header and must survive per-step title changes.
    const t = panel && panel.querySelector('.craft-view .craft-title-text');
    if (t) t.textContent = text;
  }
  function renderCraft() {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const body = panel.querySelector('.craft-body');
    if (!body) return;
    const st = _craftState;

    // Step 1 — choose an incense type from the swipeable orb strip.
    if (st.step === 1 || !st.type) {
      _craftSetTitle('Choose incense');
      const orbs = ALL_TYPES.map((t) => {
        const color = global.Types.color(t);
        const n = _craftableEggsFor(t).length;
        return `
          <button class="craft-orb" type="button" data-type="${t}">
            <img class="craft-orb-img" src="${escapeHtml(_incenseOrbIcon(color))}" alt="">
            <span class="craft-orb-name">${escapeHtml(global.Types.displayName(t))}</span>
            <span class="craft-orb-count">${n} egg${n === 1 ? '' : 's'}</span>
          </button>`;
      }).join('');
      body.innerHTML = `
        <div class="craft-hint">Swipe and tap an incense to craft.</div>
        <div class="craft-strip">${orbs}</div>
      `;
      body.querySelectorAll('.craft-orb').forEach((b) => {
        b.addEventListener('click', () => {
          _craftState = { step: 2, type: b.dataset.type, eggId: null };
          renderCraft();
        });
      });
      return;
    }

    // Step 2 — choose a valid egg for the chosen incense type.
    if (st.step === 2) {
      _craftSetTitle(global.Types.displayName(st.type) + ' Incense');
      const eggs = _craftableEggsFor(st.type);
      if (!eggs.length) {
        body.innerHTML = `
          <div class="craft-chosen">${_incenseChipHtml(st.type)}</div>
          <div class="craft-empty">No eggs whose type is neutral or effective against
            ${escapeHtml(global.Types.displayName(st.type))}. (Eggs in the incubator can't be crafted.)</div>
        `;
        return;
      }
      const tiles = eggs.map((e) => {
        const artStyle = _eggArtCss(e, 56);
        const name = _eggName(e);
        const types = _eggTypes(e);
        const mult = craftMultiplier(types, st.type);
        const badge = mult > 1
          ? `<span class="craft-egg-mult">${mult}&times;</span>` : '';
        return `
          <button class="craft-egg" type="button" data-egg="${escapeHtml(e.id)}">
            <div class="craft-egg-art" style="${artStyle}">${badge}</div>
            <div class="craft-egg-info">
              <div class="craft-egg-name">${escapeHtml(name)}</div>
              ${typeChipsHtml(types)}
            </div>
          </button>`;
      }).join('');
      body.innerHTML = `
        <div class="craft-chosen">${_incenseChipHtml(st.type)}</div>
        <div class="craft-hint">Tap an egg to convert it. A type super-effective against
          ${escapeHtml(global.Types.displayName(st.type))} yields <b>2&times;</b> incense; two
          super-effective types yield <b>3&times;</b>.</div>
        <div class="craft-egg-list">${tiles}</div>
      `;
      body.querySelectorAll('.craft-egg').forEach((b) => {
        b.addEventListener('click', () => {
          _craftState = { step: 3, type: st.type, eggId: b.dataset.egg };
          renderCraft();
        });
      });
      return;
    }

    // Step 3 — confirm conversion.
    _craftSetTitle('Confirm');
    const egg = readEggs().find((e) => e.id === st.eggId);
    if (!egg) { _craftState = { step: 1, type: null, eggId: null }; renderCraft(); return; }
    const name = _eggName(egg);
    const artStyle = _eggArtCss(egg, 72);
    const eggTypes = _eggTypes(egg);
    const mult = craftMultiplier(eggTypes, st.type);
    const yieldLabel = mult + '× ' + global.Types.displayName(st.type) + ' Incense';
    const orbMult = mult > 1 ? `<span class="craft-egg-mult on-orb">${mult}&times;</span>` : '';
    body.innerHTML = `
      <div class="craft-confirm">
        <div class="craft-confirm-row">
          <div class="craft-egg-art big" style="${artStyle}"></div>
          <span class="craft-arrow">&rarr;</span>
          <span class="craft-orb-wrap">
            <img class="craft-confirm-orb" src="${escapeHtml(_incenseOrbIcon(global.Types.color(st.type)))}" alt="">
            ${orbMult}
          </span>
        </div>
        <div class="craft-confirm-text">Convert <b>${escapeHtml(name)}</b> egg into
          <b>${escapeHtml(yieldLabel)}</b>?<br>
          <span class="craft-warn">This permanently consumes the egg.</span></div>
        <div class="craft-confirm-actions">
          <button class="craft-cancel" type="button">Cancel</button>
          <button class="craft-do" type="button">Convert</button>
        </div>
      </div>
    `;
    body.querySelector('.craft-cancel').addEventListener('click', () => {
      _craftState = { step: 2, type: st.type, eggId: null };
      renderCraft();
    });
    body.querySelector('.craft-do').addEventListener('click', () => {
      if (!removeEggById(st.eggId)) {
        // Egg vanished (hatched/crafted in another tab) — bail gracefully.
        _craftState = { step: 1, type: st.type, eggId: null };
        renderCraft();
        return;
      }
      grantItem(_incenseKey(st.type), mult);
      _craftSetTitle('Crafted!');
      body.innerHTML = `
        <div class="craft-done">
          <img class="craft-done-orb" src="${escapeHtml(_incenseOrbIcon(global.Types.color(st.type)))}" alt="">
          <div class="craft-done-text">Crafted <b>${escapeHtml(yieldLabel)}</b>!
            It's in your bag.</div>
          <div class="craft-confirm-actions">
            <button class="craft-more" type="button">Craft another</button>
            <button class="craft-tobag" type="button">Back to bag</button>
          </div>
        </div>
      `;
      body.querySelector('.craft-more').addEventListener('click', () => {
        _craftState = { step: 1, type: null, eggId: null };
        renderCraft();
      });
      body.querySelector('.craft-tobag').addEventListener('click', popView);
    });
  }
  // Small inline incense chip (orb + label) for the chosen incense.
  function _incenseChipHtml(type) {
    return `<span class="craft-chip">`
      + `<img class="craft-chip-orb" src="${escapeHtml(_incenseOrbIcon(global.Types.color(type)))}" alt="">`
      + `${escapeHtml(global.Types.displayName(type))} Incense</span>`;
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
        <div class="candy-empty">No candy yet — catch some creatures to earn family candy!</div>
      `;
      return;
    }
    const rows = entries.map(([key, n]) => {
      const id = parseInt(key, 10);
      const col = Number.isFinite(id) ? id % CANDY_SHEET_COLS : 0;
      const row = Number.isFinite(id) ? Math.floor(id / CANDY_SHEET_COLS) : 0;
      const name = speciesNameFor(key);
      const label = `${name} candy`;
      // Icon is a CSS sprite — background-position picks the cell
      // for this species out of the bundled candies.png sheet.
      // Name is shown alongside the icon so the user can scan the
      // list quickly even for species whose candy art looks
      // similar (or for empty-cell candies that render blank).
      return `
        <div class="candy-row">
          <div class="candy-icon"
               style="background-position: -${col * CANDY_CELL_PX}px -${row * CANDY_CELL_PX}px"
               title="${escapeHtml(label)}"
               aria-label="${escapeHtml(label)}"></div>
          <span class="candy-name">${escapeHtml(name)}</span>
          <span class="candy-count">×${n}</span>
        </div>
      `;
    }).join('');
    body.innerHTML = `
      <div class="candy-subtitle">${escapeHtml(subtitle)}</div>
      <div class="candy-list">${rows}</div>
    `;
  }

  // === Daycare view ===
  // Top: today's distance number (large).
  // Middle: month-grid calendar with prev/next navigation. Cells show
  //   the day-of-month and (when > 0) that day's distance below.
  //   Today is outlined; past days with data are clickable; future
  //   days are dimmed.
  // Bottom: detail block for the selected (or today's) day.
  // Display state lives in `_daycareCalState` so navigation between
  // months survives transient re-renders. Click handlers are wired
  // imperatively after innerHTML so they survive layout passes.
  let _daycareCalState = null;  // { y, m, selDay } — y/m = displayed month
  function _formatMeters(m) {
    if (!m || m <= 0) return '0';
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(2)} km`;
  }
  function _formatMetersShort(m) {
    if (!m || m <= 0) return '';
    if (m < 1000) return `${Math.round(m)}m`;
    if (m < 10000) return `${(m / 1000).toFixed(1)}k`;
    return `${Math.round(m / 1000)}k`;
  }
  function _padDayKey(y, m, d) {
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // === Daycare odds ("i" popup) ===
  // Mirrors _daycareLootAt's exact model so the numbers shown are the real
  // ones, computed against whatever is currently in the daycare:
  //   • each occupied slot rolls one drop per DAYCARE_LOOT_MILESTONE_M walked;
  //   • candy 70% (this slot's roots, 50/50 or 100% if the same root);
  //   • egg 15% (cross-breed pool shared across slots, 70% natural / 30% cross);
  //   • evo item 15% (this slot's item-evolutions, uniform) — but if the pair
  //     has no item evolution, that branch becomes candy (so candy → 85%).
  function _daycareOddsModel() {
    const rawSlots = readDaycareSlots();
    const nickMap = readNicknames();
    const occ = [];
    const firstPool = new Set(), secondPool = new Set();
    for (const s of rawSlots) {
      const c = s && findCreature(s.id);
      if (!c || !Number.isInteger(c.speciesA) || !Number.isInteger(c.speciesB)) continue;
      occ.push({ slot: s, c });
      firstPool.add(c.speciesA);
      secondPool.add(c.speciesB);
    }
    if (!occ.length) return { empty: true, milestoneM: DAYCARE_LOOT_MILESTONE_M };

    // Per-slot candy + evo-item odds (these read only that slot's own pair).
    const slots = occ.map(({ c }) => {
      const name = nickMap[c.id] || c.name || fusionName(c.speciesA, c.speciesB);
      const rootA = candyRootFor(c.speciesA), rootB = candyRootFor(c.speciesB);
      const candyShares = (rootA === rootB)
        ? [{ species: rootA, share: 1 }]
        : [{ species: rootA, share: 0.5 }, { species: rootB, share: 0.5 }];
      const items = Array.from(new Set(
        _evoItemsForFamily(c.speciesA).concat(_evoItemsForFamily(c.speciesB))));
      const evoPct = items.length ? (1 - DAYCARE_PROB_CANDY - DAYCARE_PROB_EGG) : 0;
      const candyPct = 1 - DAYCARE_PROB_EGG - evoPct;   // 0.70 with items, 0.85 without
      return {
        name, candyPct, eggPct: DAYCARE_PROB_EGG, evoPct,
        candy: candyShares.map((cd) => ({ name: speciesNameFor(cd.species), pct: cd.share * candyPct })),
        evo: items.map((k) => ({ name: (ITEMS[k] && ITEMS[k].name) || _formatItemName(k), pct: evoPct / items.length })),
      };
    });

    // Shared egg-content distribution, conditional on an egg dropping.
    const F = Array.from(firstPool), S = Array.from(secondPool);
    const naturals = [];
    for (const x of F) for (const y of S) naturals.push([x, y]);
    const U = Array.from(new Set([...F, ...S]));
    const natKeys = new Set(naturals.map(([x, y]) => x + ',' + y));
    const others = [];
    for (const x of U) for (const y of U) if (!natKeys.has(x + ',' + y)) others.push([x, y]);
    const natShare = others.length ? 0.7 : 1.0;
    const othShare = others.length ? 0.3 : 0;
    // Aggregate by the baby-form pair the egg actually hatches into.
    const agg = new Map();
    const add = (x, y, p, natural) => {
      const a = candyRootFor(x), b = candyRootFor(y);
      const key = a + ',' + b;
      const cur = agg.get(key) || { a, b, pct: 0, natural: false };
      cur.pct += p; cur.natural = cur.natural || natural;
      agg.set(key, cur);
    };
    for (const [x, y] of naturals) add(x, y, natShare / naturals.length, true);
    for (const [x, y] of others) add(x, y, othShare / others.length, false);
    const eggContents = Array.from(agg.values())
      .map((e) => ({ a: e.a, b: e.b, name: fusionName(e.a, e.b), pct: e.pct, natural: e.natural }))
      .sort((p, q) => q.pct - p.pct);

    return {
      empty: false, milestoneM: DAYCARE_LOOT_MILESTONE_M, slots, eggContents,
      naturalPairs: new Set(eggContents.filter((e) => e.natural).map((e) => e.name)).size,
      crossPairs: new Set(eggContents.filter((e) => !e.natural).map((e) => e.name)).size,
    };
  }

  function _fmtPct(x) {
    const v = Math.round(x * 1000) / 10;   // one decimal
    return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + '%';
  }
  function _daycareOddsHtml() {
    const m = _daycareOddsModel();
    if (m.empty) {
      return '<p class="dc-odds-empty">Put a pokémon in the daycare (via the <b>Daycare</b> tag on its detail page) '
        + 'to see its egg, candy and evolution-item odds here.</p>';
    }
    const dist = (m.milestoneM % 1000 === 0) ? (m.milestoneM / 1000) + ' km' : m.milestoneM + ' m';
    let h = '<p class="dc-odds-intro">Every <b>' + dist + '</b> your daycare walks earns one loot drop '
      + 'per pokémon inside. For each drop:</p>';
    for (const s of m.slots) {
      h += '<div class="dc-odds-slot"><div class="dc-odds-slot-name">' + escapeHtml(s.name) + '</div>';
      h += '<div class="dc-odds-split">'
        + '<span class="dc-tag candy">Candy ' + _fmtPct(s.candyPct) + '</span>'
        + '<span class="dc-tag egg">Egg ' + _fmtPct(s.eggPct) + '</span>'
        + (s.evoPct > 0 ? '<span class="dc-tag evo">Evo item ' + _fmtPct(s.evoPct) + '</span>' : '')
        + '</div>';
      h += '<div class="dc-odds-line"><span class="dc-odds-k">Candy</span><span class="dc-odds-v">'
        + s.candy.map((cd) => escapeHtml(cd.name) + ' ' + _fmtPct(cd.pct)).join(' · ') + '</span></div>';
      if (s.evoPct > 0) {
        h += '<div class="dc-odds-line"><span class="dc-odds-k">Evo item</span><span class="dc-odds-v">'
          + s.evo.map((ev) => escapeHtml(ev.name) + ' ' + _fmtPct(ev.pct)).join(' · ') + '</span></div>';
      } else {
        h += '<div class="dc-odds-line dc-odds-note">No item evolutions for this pair — those rolls become extra candy.</div>';
      }
      h += '</div>';
    }
    h += '<div class="dc-odds-eggs"><div class="dc-odds-eggs-title">If an egg drops, what hatches</div>';
    h += '<div class="dc-odds-note">'
      + m.naturalPairs + ' natural pairing' + (m.naturalPairs !== 1 ? 's' : '')
      + (m.crossPairs
          ? ' share 70%, ' + m.crossPairs + ' cross pairing' + (m.crossPairs !== 1 ? 's' : '') + ' share 30%.'
          : ' (100%).')
      + ' Eggs hatch the baby form; the egg’s artwork is random.</div>';
    h += '<ul class="dc-odds-egglist">'
      + m.eggContents.map((e) => {
          const seen = isFusionSeen(e.a, e.b) || isFusionOwned(e.a, e.b);
          return '<li class="dc-egg ' + (e.natural ? 'natural' : 'cross') + '" '
            + 'data-a="' + e.a + '" data-b="' + e.b + '" role="button" tabindex="0" '
            + 'title="' + escapeHtml(e.name) + ' — open dex entry">'
            + '<span class="dc-egg-icon' + (seen ? '' : ' silhouette') + '"><img alt=""></span>'
            + '<span class="dc-egg-name">' + escapeHtml(e.name) + '</span>'
            + '<span class="dc-egg-pct">' + _fmtPct(e.pct) + '</span></li>';
        }).join('')
      + '</ul></div>';
    return h;
  }

  let _dcOddsEl = null;
  function _ensureDaycareOddsEl() {
    if (_dcOddsEl) return _dcOddsEl;
    const root = document.createElement('div');
    root.id = 'ccDaycareOdds';
    root.className = 'dc-odds-overlay';
    root.innerHTML = '<div class="dc-odds-card" role="dialog" aria-modal="true" aria-label="Daycare odds">'
      + '<button type="button" class="dc-odds-back" aria-label="back">←</button>'
      + '<button type="button" class="dc-odds-close" aria-label="close">×</button>'
      + '<div class="dc-odds-floatbar">'
      +   '<button type="button" class="dc-odds-float-back" aria-label="back">←</button>'
      +   '<button type="button" class="dc-odds-float-x" aria-label="close">×</button>'
      + '</div>'
      + '<h3 class="dc-odds-title">Daycare odds</h3>'
      + '<div class="dc-odds-content"></div></div>';
    document.body.appendChild(root);
    root.addEventListener('click', (e) => { if (e.target === root) _hideDaycareOdds(); });
    root.querySelectorAll('.dc-odds-back, .dc-odds-close, .dc-odds-float-back, .dc-odds-float-x')
      .forEach((b) => b.addEventListener('click', _hideDaycareOdds));
    // Floating back/close cluster — appears once the card is scrolled past its
    // header, mirroring the main sheet's on-scroll floating controls.
    const card = root.querySelector('.dc-odds-card');
    const floatbar = root.querySelector('.dc-odds-floatbar');
    if (card && floatbar) {
      const updateFloat = () => floatbar.classList.toggle('show', card.scrollTop > 60);
      card.addEventListener('scroll', updateFloat, { passive: true });
      root._updateOddsFloat = updateFloat;   // re-checked after a scroll restore
    }
    _dcOddsEl = root;
    return root;
  }
  // Load each egg-outcome sprite (favorite art if the pure/baby fusion is
  // seen/caught, else a best-available silhouette — no spoilers) and make each
  // row tap-to-open its dex entry.
  function _wireDaycareOddsEggs(root) {
    if (!root) return;
    root.querySelectorAll('li.dc-egg[data-a][data-b]').forEach((li) => {
      const a = +li.dataset.a, b = +li.dataset.b;
      const img = li.querySelector('img');
      if (img && global.SpriteStore) {
        const seen = isFusionSeen(a, b) || isFusionOwned(a, b);
        const fav = seen ? favoriteArtFor(a, b) : { variant: undefined, shinyVariant: null };
        global.SpriteStore.showSprite(img, a, b, fav.variant, {
          shinyVariant: fav.shinyVariant,
          onReady: () => li.classList.add('ready'),
        });
      }
      const open = () => {
        const card = root.querySelector('.dc-odds-card');
        const scrollY = card ? card.scrollTop : 0;
        _hideDaycareOdds();
        showFusionView(a, b, null, null, { fromDaycareOdds: true, dcOddsScrollY: scrollY });
      };
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }
  function _showDaycareOdds() {
    const root = _ensureDaycareOddsEl();
    root.querySelector('.dc-odds-content').innerHTML = _daycareOddsHtml();
    _wireDaycareOddsEggs(root);
    const card = root.querySelector('.dc-odds-card');
    if (card) card.scrollTop = 0;               // fresh opens start at the top
    if (root._updateOddsFloat) root._updateOddsFloat();
    root.classList.add('show');
  }
  function _hideDaycareOdds() { if (_dcOddsEl) _dcOddsEl.classList.remove('show'); }

  // ── Generic info modal ──────────────────────────────────────────────
  // A reusable explainer popup with the same card chrome as the daycare
  // odds modal, but content-agnostic and with a small internal view stack
  // so a popup can drill into a sub-view (e.g. incense info → type chart)
  // and the ← button pops back (or closes at the root). A "view" is
  //   { title, html, onWire? } where html is a string or () => string and
  //   onWire(root, contentEl) runs after the content is painted.
  let _infoModalEl = null;
  let _infoModalStack = [];
  function _ensureInfoModalEl() {
    if (_infoModalEl) return _infoModalEl;
    const root = document.createElement('div');
    root.id = 'ccInfoModal';
    root.innerHTML = '<div class="cc-modal-card" role="dialog" aria-modal="true">'
      + '<button type="button" class="cc-modal-back" aria-label="back">←</button>'
      + '<button type="button" class="cc-modal-close" aria-label="close">×</button>'
      + '<div class="cc-modal-floatbar">'
      +   '<button type="button" class="cc-modal-float-back" aria-label="back">←</button>'
      +   '<button type="button" class="cc-modal-float-x" aria-label="close">×</button>'
      + '</div>'
      + '<h3 class="cc-modal-title"></h3>'
      + '<div class="cc-modal-content"></div></div>';
    document.body.appendChild(root);
    root.addEventListener('click', (e) => { if (e.target === root) _closeInfoModal(); });
    root.querySelectorAll('.cc-modal-close, .cc-modal-float-x')
      .forEach((b) => b.addEventListener('click', _closeInfoModal));
    root.querySelectorAll('.cc-modal-back, .cc-modal-float-back')
      .forEach((b) => b.addEventListener('click', _infoModalBack));
    const card = root.querySelector('.cc-modal-card');
    const floatbar = root.querySelector('.cc-modal-floatbar');
    if (card && floatbar) {
      const updateFloat = () => floatbar.classList.toggle('show', card.scrollTop > 60);
      card.addEventListener('scroll', updateFloat, { passive: true });
      root._updateFloat = updateFloat;
    }
    _infoModalEl = root;
    return root;
  }
  function _renderInfoModalTop() {
    const root = _infoModalEl;
    const view = _infoModalStack[_infoModalStack.length - 1];
    if (!root || !view) return;
    root.querySelector('.cc-modal-title').textContent = view.title || '';
    const content = root.querySelector('.cc-modal-content');
    content.innerHTML = (typeof view.html === 'function') ? view.html() : (view.html || '');
    if (typeof view.onWire === 'function') view.onWire(root, content);
    const card = root.querySelector('.cc-modal-card');
    if (card) card.scrollTop = 0;
    if (root._updateFloat) root._updateFloat();
  }
  function _openInfoModal(view) {
    _infoModalStack = [view];
    const root = _ensureInfoModalEl();
    _renderInfoModalTop();
    root.classList.add('show');
  }
  function _pushInfoView(view) { _infoModalStack.push(view); _renderInfoModalTop(); }
  function _infoModalBack() {
    if (_infoModalStack.length > 1) { _infoModalStack.pop(); _renderInfoModalTop(); }
    else _closeInfoModal();
  }
  function _closeInfoModal() {
    if (_infoModalEl) _infoModalEl.classList.remove('show');
    _infoModalStack = [];
  }

  // ── Incense explainer + type-chart explorer ─────────────────────────
  function _ccTypeChip(t, dim) {
    return '<span class="cc-typechip' + (dim ? ' dim' : '') + '" style="background:'
      + global.Types.color(t) + '">' + escapeHtml(global.Types.displayName(t)) + '</span>';
  }
  function _ccTypeChips(types) {
    if (!types || !types.length) return '<span class="cc-tdb-none">none</span>';
    return '<div class="cc-typechips">' + types.map((t) => _ccTypeChip(t)).join('') + '</div>';
  }
  function _incenseInfoHtml() {
    const mins = Math.round(_incenseDurationMs() / 60000);
    let h = '';
    h += '<p class="cc-info-p">Incense is a scented lure you craft from eggs and burn to '
      + 'draw out a specific <b>type</b> of pokémon. Only one incense burns at a time — '
      + 'lighting a new one replaces the current one.</p>';

    // While burning
    h += '<div class="cc-info-section">';
    h += '<div class="cc-info-section-title">While it\'s burning (~' + mins + ' min)</div>';
    h += '<div class="cc-info-row"><span class="cc-info-k">Extra spawns</span>'
      + '<span class="cc-info-v">A second wave of pokémon layers on top of the usual ones — '
      + 'about <b>+50% more</b> to catch — for the whole window.</span></div>';
    h += '<div class="cc-info-row"><span class="cc-info-k">Guaranteed half</span>'
      + '<span class="cc-info-v">Every incense spawn is a fusion with your incense type on '
      + 'one half. The other half is:</span></div>';
    // Other-half odds bar: 40% any / 30% weekly / 30% daily.
    h += '<div class="cc-oddsbar">'
      + '<div class="cc-oddsbar-seg" style="flex:40;background:#8a8f98">40%</div>'
      + '<div class="cc-oddsbar-seg" style="flex:30;background:#6d5ac0">30%</div>'
      + '<div class="cc-oddsbar-seg" style="flex:30;background:#c06a8a">30%</div>'
      + '</div>';
    h += '<div class="cc-oddsbar-legend">'
      + '<span><i style="background:#8a8f98"></i>Any type</span>'
      + '<span><i style="background:#6d5ac0"></i>This week\'s theme type</span>'
      + '<span><i style="background:#c06a8a"></i>Today\'s theme type</span>'
      + '</div>';
    h += '<div class="cc-info-row"><span class="cc-info-k">Shiny rate</span>'
      + '<span class="cc-info-v">Incense spawns roll shiny at <b>2×</b> the normal rate.</span></div>';
    h += '</div>';

    // Crafting
    h += '<div class="cc-info-section">';
    h += '<div class="cc-info-section-title">Crafting incense</div>';
    h += '<p class="cc-info-p" style="margin-bottom:6px">Craft from an egg whose type is '
      + '<b>neutral or super-effective</b> against the incense type. An egg that only '
      + '<i>resists</i> that type can\'t be used.</p>';
    h += '<div class="cc-info-row"><span class="cc-info-k">Yield</span>'
      + '<span class="cc-info-v"><span class="cc-info-mult">1×</span> base. Each of the egg\'s '
      + 'types that\'s <b>super-effective</b> against the incense type adds +1 — so '
      + '<span class="cc-info-mult">2×</span> for one match, <span class="cc-info-mult">3×</span> '
      + 'for two.</span></div>';
    h += '</div>';

    h += '<button class="cc-info-link cc-open-typechart" type="button">'
      + '<span>See the type chart</span><span class="cc-info-link-arrow">›</span></button>';
    return h;
  }
  function _showIncenseInfo() {
    _openInfoModal({
      title: 'How incense works',
      html: () => _incenseInfoHtml(),
      onWire: (root, content) => {
        const btn = content.querySelector('.cc-open-typechart');
        if (btn) btn.addEventListener('click', () => _pushTypeChartView(
          (_craftState && _craftState.type) || null));
      },
    });
  }

  // ── Daily/weekly type-weather odds explainer ────────────────────────
  // Opened by tapping the weather chips at the top of the browse view.
  // Reads the realized per-slot type shares from Spawns.typeOdds() (which
  // already accounts for empty species pools) and draws a segmented bar:
  // today's type / this week's type / everything else. Deliberately does
  // NOT enumerate individual species — just the relative odds by type,
  // per the board task ("all other types" catch-all).
  function _ccOddsSeg(share, color, label) {
    // flex proportional to the share; floor the flex so a slice never
    // collapses to an unreadable sliver but still stays roughly to scale.
    const flex = Math.max(3, Math.round(share * 100));
    return '<div class="cc-oddsbar-seg" style="flex:' + flex + ';background:'
      + color + '">' + escapeHtml(label) + '</div>';
  }
  function _ccOddsLegend(color, text) {
    return '<span><i style="background:' + color + '"></i>' + escapeHtml(text) + '</span>';
  }
  // Renders Spawns.typePairOdds() as a heat-map matrix: rows = the primary
  // (first) type-half, columns = the secondary (second) half, each cell the
  // joint chance of that exact combo. Cell tint scales with the busiest cell so
  // the grid reads as a heatmap; honest 0% cells (a boosted type with no
  // eligible species in that slot today) stay visible.
  function _ccOddsGrid(pair) {
    const OTHER = '#8a8f98';
    const colOf = (c) => c === 'daily' ? (global.Types.isValid(pair.daily) ? global.Types.color(pair.daily) : '#6d5ac0')
      : c === 'weekly' ? (global.Types.isValid(pair.weekly) ? global.Types.color(pair.weekly) : '#c06a8a') : OTHER;
    const labelOf = (c) => c === 'daily' ? global.Types.displayName(pair.daily)
      : c === 'weekly' ? global.Types.displayName(pair.weekly) : 'Other';
    const classes = pair.classes;
    const pct = (x) => Math.round(x * 100);
    let max = 0;
    for (const rc of classes) for (const cc of classes) max = Math.max(max, pair.grid[rc][cc]);
    const head = (c) => '<div class="cc-oddsgrid-head"><i style="background:'
      + colOf(c) + '"></i>' + escapeHtml(labelOf(c)) + '</div>';
    const cols = 'minmax(40px,auto) repeat(' + classes.length + ',1fr)';
    let h = '<div class="cc-oddsgrid" style="grid-template-columns:' + cols + '">';
    h += '<div class="cc-oddsgrid-corner"><span>1st ↓</span><span>2nd →</span></div>';
    for (const cc of classes) h += head(cc);
    for (const rc of classes) {
      h += head(rc);
      for (const cc of classes) {
        const share = pair.grid[rc][cc];
        const a = max > 0 ? 0.06 + 0.54 * (share / max) : 0.06;
        const hot = a > 0.4 ? ' hot' : '';
        h += '<div class="cc-oddsgrid-cell' + hot + '" style="background:rgba(109,90,192,'
          + a.toFixed(3) + ')">' + pct(share) + '%</div>';
      }
    }
    h += '</div>';
    return h;
  }
  function _themeOddsHtml() {
    const odds = (global.Spawns && global.Spawns.typeOdds)
      ? global.Spawns.typeOdds() : null;
    const pair = (global.Spawns && global.Spawns.typePairOdds)
      ? global.Spawns.typePairOdds() : null;
    if (!odds) {
      return '<p class="cc-info-p">Today\'s spawn odds aren\'t available yet — '
        + 'creature data is still loading. Try again in a moment.</p>';
    }
    const pct = (x) => Math.round(x * 100);
    const dName = global.Types.displayName(odds.daily);
    const wName = global.Types.displayName(odds.weekly);
    const OTHER = '#8a8f98';
    const dCol = global.Types.isValid(odds.daily) ? global.Types.color(odds.daily) : '#6d5ac0';
    const wCol = global.Types.isValid(odds.weekly) ? global.Types.color(odds.weekly) : '#c06a8a';

    let h = '';
    h += '<p class="cc-info-p">Every day the world runs a <b>type weather</b>: '
      + 'one <b>daily</b> type and one <b>weekly</b> type get a big spawn boost. '
      + 'Wild spawns are two-type fusions, so this shows how the two type-halves '
      + 'you\'ll run into today break down.</p>';

    h += '<div class="cc-info-section">';
    h += '<div class="cc-info-section-title">Type mix of today\'s spawns</div>';
    if (odds.same) {
      // Daily and weekly landed on the same type — one extra-strong boost.
      h += '<div class="cc-oddsbar">'
        + _ccOddsSeg(odds.dailyShare, dCol, pct(odds.dailyShare) + '%')
        + _ccOddsSeg(odds.otherShare, OTHER, pct(odds.otherShare) + '%')
        + '</div>';
      h += '<div class="cc-oddsbar-legend">'
        + _ccOddsLegend(dCol, dName + ' — today & this week')
        + _ccOddsLegend(OTHER, 'All other types')
        + '</div>';
      h += '<p class="cc-info-note" style="margin-top:8px">Today\'s and this '
        + 'week\'s weather both landed on <b>' + escapeHtml(dName) + '</b>, so it\'s '
        + 'boosted extra hard.</p>';
    } else {
      h += '<div class="cc-oddsbar">'
        + _ccOddsSeg(odds.dailyShare, dCol, pct(odds.dailyShare) + '%')
        + _ccOddsSeg(odds.weeklyShare, wCol, pct(odds.weeklyShare) + '%')
        + _ccOddsSeg(odds.otherShare, OTHER, pct(odds.otherShare) + '%')
        + '</div>';
      h += '<div class="cc-oddsbar-legend">'
        + _ccOddsLegend(dCol, dName + ' — today')
        + _ccOddsLegend(wCol, wName + ' — this week')
        + _ccOddsLegend(OTHER, 'All other types')
        + '</div>';
    }
    h += '<p class="cc-info-note" style="margin-top:8px">Percentages are of '
      + 'type-halves across all wild spawns. "All other types" is split over the '
      + 'remaining ' + (odds.same ? 17 : 16) + ' types, so any single one of them '
      + 'is uncommon today.</p>';
    h += '</div>';

    if (pair) {
      const combo = pair.same
        ? escapeHtml(dName) + ' or another type'
        : escapeHtml(dName) + ', ' + escapeHtml(wName) + ' or another type';
      h += '<div class="cc-info-section">';
      h += '<div class="cc-info-section-title">Both type-halves</div>';
      h += '<p class="cc-info-p">Each spawn fuses a <b>first</b> and a <b>second</b> '
        + 'type-half. This grid is the chance of every combo (' + combo + ') — read a '
        + 'row for the first half, a column for the second. Darker means more likely; '
        + 'all cells add up to 100%.</p>';
      h += _ccOddsGrid(pair);
      let hasZero = false;
      for (const rc of pair.classes) for (const cc of pair.classes) {
        if (pair.grid[rc][cc] === 0) hasZero = true;
      }
      if (hasZero) {
        h += '<p class="cc-info-note" style="margin-top:8px">A <b>0%</b> cell means that '
          + 'boosted type has no eligible species for that half today, so it only shows '
          + 'up in the other slot.</p>';
      }
      h += '</div>';
    }

    h += '<div class="cc-info-section">';
    h += '<div class="cc-info-section-title">How the boost works</div>';
    h += '<div class="cc-info-row"><span class="cc-info-k">Today\'s type</span>'
      + '<span class="cc-info-v">The strongest pull — creatures carrying '
      + '<b>' + escapeHtml(dName) + '</b> flood in for the whole UTC day.</span></div>';
    h += '<div class="cc-info-row"><span class="cc-info-k">This week\'s type</span>'
      + '<span class="cc-info-v">A steadier, lighter boost for '
      + '<b>' + escapeHtml(wName) + '</b> that holds all week.</span></div>';
    h += '<div class="cc-info-row"><span class="cc-info-k">Everything else</span>'
      + '<span class="cc-info-v">Still rolls at a low background rate, so rarer '
      + 'types never fully disappear.</span></div>';
    h += '</div>';
    return h;
  }
  function _showThemeOdds() {
    _openInfoModal({ title: 'Today\'s spawn odds', html: () => _themeOddsHtml() });
  }

  // ── Guaranteed-catch (accessibility) explainer ──────────────────────
  // Opens from the Settings toggle's "i" bubble via
  // Creatures.showSteadyCatchInfo(). Copy mirrors the mechanic in
  // _guaranteedThrowPlan: one visible throw always lands the catch, but the
  // ball's normal odds still run underneath — every hidden re-roll spends a
  // real ball, and the shake phase is stretched (MARGIN 1.1 → ~10% longer)
  // so it costs the same balls and a touch more time than throwing by hand.
  // If the bag empties before a roll succeeds, the creature breaks free.
  function _steadyCatchInfoHtml() {
    let h = '';
    h += '<p class="cc-info-p">An accessibility option: with it on, a single '
      + 'throw always lands the catch, so you don\'t have to tap through misses '
      + 'and re-throws. It\'s built to cost <b>exactly the same</b> as catching '
      + 'the normal way — it just spares your hands the repeated tapping.</p>';

    h += '<div class="cc-info-section">';
    h += '<div class="cc-info-section-title">What actually happens</div>';
    h += '<div class="cc-info-row"><span class="cc-info-k">Under the hood</span>'
      + '<span class="cc-info-v">Behind that one animation the game keeps throwing '
      + 'at the ball\'s normal odds until a throw sticks — you just see it as one '
      + 'smooth sequence instead of many separate taps.</span></div>';
    h += '<div class="cc-info-row"><span class="cc-info-k">Ball cost</span>'
      + '<span class="cc-info-v">Every hidden re-throw spends a <b>real ball</b>, '
      + 'exactly as if you\'d thrown them yourself. A stubborn catch still burns '
      + 'through balls at the normal rate.</span></div>';
    h += '<div class="cc-info-row"><span class="cc-info-k">If your bag runs out</span>'
      + '<span class="cc-info-v">Run out of that ball before a throw succeeds and the '
      + 'creature <b>breaks free</b> — same as missing every manual throw. It\'s '
      + '"guaranteed" only while you have balls to spend.</span></div>';
    h += '</div>';

    h += '<div class="cc-info-section">';
    h += '<div class="cc-info-section-title">Why it\'s still balanced</div>';
    h += '<div class="cc-info-row"><span class="cc-info-k">Same odds</span>'
      + '<span class="cc-info-v">The catch rate is unchanged. A Great Ball still '
      + 'catches at Great Ball odds; rarer creatures are no cheaper to land.</span></div>';
    h += '<div class="cc-info-row"><span class="cc-info-k">Same-ish time</span>'
      + '<span class="cc-info-v">The shakes are slowed so the whole sequence runs '
      + 'about <b>10% longer</b> than those throws would have by hand (plus a beat '
      + 'to re-aim each hidden throw). There\'s no speed advantage.</span></div>';
    h += '<div class="cc-info-row"><span class="cc-info-k">Just less tapping</span>'
      + '<span class="cc-info-v">The only thing it removes is the repeated tapping — '
      + 'helpful if that\'s uncomfortable or difficult.</span></div>';
    h += '</div>';

    h += '<p class="cc-info-note">In short: same balls, same odds, a touch slower — '
      + 'one tap instead of many.</p>';
    return h;
  }
  function _showSteadyCatchInfo() {
    _openInfoModal({
      title: 'Guaranteed catch',
      html: () => _steadyCatchInfoHtml(),
    });
  }

  // Type-chart explorer: tap an attacking type to see what it beats / is
  // resisted by, plus (crafting-relevant) which egg types make the best
  // incense of that type. All chart data comes from global.Types
  // (static/types.js) — strongAgainst(T) is the inverse lookup, the set
  // of types super-effective *against* T.
  let _typeChartSel = null;
  function _typeDetailHtml(T) {
    const row = global.Types.attackRow(T);
    const strong = row.strong;
    const weak = row.reduced;
    const bestEggs = global.Types.strongAgainst(T);
    let h = '<div class="cc-typedetail">';
    h += '<div class="cc-typedetail-head">'
      + '<span class="cc-typedot" style="background:' + global.Types.color(T) + '"></span>'
      + '<span class="cc-typedetail-name">' + escapeHtml(global.Types.displayName(T)) + '</span></div>';
    h += '<div class="cc-typedetail-block">'
      + '<div class="cc-tdb-label"><span class="cc-tdb-mult good">2×</span>Super-effective against</div>'
      + _ccTypeChips(strong) + '</div>';
    h += '<div class="cc-typedetail-block">'
      + '<div class="cc-tdb-label"><span class="cc-tdb-mult bad">½× / 0×</span>Resisted / no effect</div>'
      + _ccTypeChips(weak) + '</div>';
    h += '<div class="cc-typedetail-block">'
      + '<div class="cc-tdb-label"><span class="cc-tdb-mult craft">2×–3×</span>Best eggs for '
      + escapeHtml(global.Types.displayName(T)) + ' Incense</div>'
      + _ccTypeChips(bestEggs)
      + '<div class="cc-info-note" style="margin-top:5px">Eggs of these types are super-effective '
      + 'against ' + escapeHtml(global.Types.displayName(T)) + ', so they craft extra incense.</div></div>';
    h += '</div>';
    return h;
  }
  function _typeChartHtml() {
    let h = '<p class="cc-info-p">Tap a type to see what it\'s strong and weak against. '
      + 'When crafting, an egg type that\'s super-effective against the incense type '
      + 'yields more (2×, or 3× when both of a fusion\'s types match).</p>';
    h += '<div class="cc-typegrid">'
      + ALL_TYPES.map((t) => '<button type="button" data-type="' + t + '"'
          + (t === _typeChartSel ? ' class="sel"' : '')
          + ' style="background:' + global.Types.color(t) + '">'
          + escapeHtml(global.Types.displayName(t)) + '</button>').join('')
      + '</div>';
    h += '<div class="cc-typedetail-wrap">' + _typeDetailHtml(_typeChartSel) + '</div>';
    return h;
  }
  function _wireTypeChart(content) {
    const grid = content.querySelector('.cc-typegrid');
    const wrap = content.querySelector('.cc-typedetail-wrap');
    if (!grid || !wrap) return;
    grid.querySelectorAll('button[data-type]').forEach((b) => {
      b.addEventListener('click', () => {
        _typeChartSel = b.dataset.type;
        grid.querySelectorAll('button[data-type]').forEach((x) =>
          x.classList.toggle('sel', x.dataset.type === _typeChartSel));
        wrap.innerHTML = _typeDetailHtml(_typeChartSel);
      });
    });
  }
  function _pushTypeChartView(defaultType) {
    _typeChartSel = (defaultType && global.Types.isValid(defaultType)) ? defaultType : ALL_TYPES[0];
    _pushInfoView({
      title: 'Type chart',
      html: () => _typeChartHtml(),
      onWire: (root, content) => _wireTypeChart(content),
    });
  }

  function renderDaycare(opts) {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const body = panel.querySelector('.daycare-body');
    if (!body) return;
    // Make sure the IDB → in-memory cache is warm before we paint.
    // First paint may show 0 m if this is the very first daycare
    // open in the session; we re-render once the load resolves.
    let map = readDaycareDistances();
    if (!_summaryCache) {
      _ensureSummaryLoaded().then(() => {
        // Only re-render if the user is still on the daycare view.
        const top = _viewStack[_viewStack.length - 1];
        if (top && top.view === 'daycare') renderDaycare(opts);
      }).catch(() => {});
    }
    const today = new Date();
    if (!_daycareCalState) {
      _daycareCalState = {
        y: today.getFullYear(),
        m: today.getMonth(),
        selDay: _localDayKey(today),
      };
    }
    const todayMeters = map[_localDayKey(today)] || 0;
    const { y, m, selDay } = _daycareCalState;
    const monthName = new Date(y, m, 1).toLocaleString(undefined,
      { month: 'long', year: 'numeric' });
    const firstDow = new Date(y, m, 1).getDay();   // 0 = Sun
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    // Disable next-month nav when we're already on the current month
    // (no future days to look at).
    const onCurrentMonth = (y === today.getFullYear() && m === today.getMonth());
    const dowLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const dowHtml = dowLabels.map((d) =>
      `<div class="daycare-cal-dow">${d}</div>`).join('');
    const cells = [];
    for (let i = 0; i < firstDow; i++) {
      cells.push('<div class="daycare-cal-cell empty"></div>');
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const key = _padDayKey(y, m, d);
      const meters = map[key] || 0;
      const isToday = (key === _localDayKey(today));
      const isFuture = (
        y > today.getFullYear()
        || (y === today.getFullYear() && m > today.getMonth())
        || (y === today.getFullYear() && m === today.getMonth()
            && d > today.getDate())
      );
      const isSelected = (key === selDay);
      const cls = ['daycare-cal-cell'];
      if (isToday) cls.push('today');
      if (isFuture) cls.push('future');
      // Any past or current day is selectable — even 0 m days, since
      // the user wants to see "no travel recorded" for those too.
      // Future days stay non-clickable (nothing to display yet).
      if (!isFuture) cls.push('has-data');
      if (isSelected) cls.push('selected');
      const distText = meters > 0 ? _formatMetersShort(meters) : '';
      cells.push(
        `<div class="${cls.join(' ')}" data-day-key="${key}">`
        + `<span class="daycare-cal-day">${d}</span>`
        + (distText ? `<span class="daycare-cal-dist">${distText}</span>` : '')
        + `</div>`
      );
    }
    const selMeters = map[selDay] || 0;
    // Is a route overlay currently on the map, and does it match this
    // button? `_activeDaycareOverlay` is tracked module-side (see the
    // "Daycare path overlay" section). When it matches, the button
    // becomes a "Hide …" toggle instead of "Show …".
    const dayOverlayActive = !!(_activeDaycareOverlay
      && _activeDaycareOverlay.dayKey === selDay);
    const allOverlayActive = !!(_activeDaycareOverlay
      && _activeDaycareOverlay.allDays);
    const selDate = (() => {
      const parts = selDay.split('-').map(Number);
      const d = new Date(parts[0], parts[1] - 1, parts[2]);
      return d.toLocaleDateString(undefined,
        { weekday: 'short', month: 'short', day: 'numeric' });
    })();
    const detailHtml = selMeters > 0
      ? `<div class="daycare-detail-title">${escapeHtml(selDate)}</div>`
        + `<div>${_formatMeters(selMeters)}</div>`
      : `<div class="daycare-detail-title">${escapeHtml(selDate)}</div>`
        + `<div class="daycare-detail-empty">no travel recorded</div>`;
    // Daycare slots: render two boxes at the top, each either holding
    // a captured creature (sprite + name, tap → its detail view) or
    // empty (placeholder text, hint to add via the Daycare tag on a
    // creature's detail page). readDaycareSlots is filtered against
    // currently-existing captures so a slot whose creature was
    // deleted shows up as empty rather than a dangling reference.
    const rawSlots = readDaycareSlots();
    const nickMap = readNicknames();
    const slotItems = [];
    for (let i = 0; i < DAYCARE_SLOT_COUNT; i++) {
      const slot = rawSlots[i] || null;
      const c = slot ? findCreature(slot.id) : null;
      slotItems.push(c ? { c, slot } : null);
    }
    const slotsHtml = `
      <div class="daycare-slots">
        ${slotItems.map((it) => {
          if (!it) {
            return `<div class="daycare-slot daycare-slot-empty">`
              + `<span class="daycare-slot-empty-label">empty</span>`
              + `</div>`;
          }
          const c = it.c;
          // Same name resolution detail-view uses: nickname overrides
          // canonical fused name when present.
          const name = nickMap[c.id] || c.name
            || creatureName(c);
          // Distance walked while THIS occupancy lasted. Resets to 0
          // each time the creature is removed and re-added — see
          // addToDaycare. Format with the same _formatMeters helper
          // used by the calendar / today's-distance card.
          const distLabel = _formatMeters(it.slot.distM || 0);
          // Convert toggles surface only when the two halves have
          // distinct candy roots — Pure fusions have nothing to swap
          // between. Roots resolve via candyRootFor so e.g.
          // Charmeleon × Squirtle still reads as Charmander/Squirtle.
          const rootA = candyRootFor(c.speciesA);
          const rootB = candyRootFor(c.speciesB);
          const convertable = rootA != null && rootB != null && rootA !== rootB;
          const leftBtn = convertable ? _convertBtnHtml(it.slot, rootA, rootB, 'A') : '';
          const rightBtn = convertable ? _convertBtnHtml(it.slot, rootA, rootB, 'B') : '';
          return `<div class="daycare-slot" data-id="${escapeHtml(c.id)}">`
            + `<div class="daycare-slot-art-row">`
            + leftBtn
            + `<div class="daycare-slot-art">`
            + `<div class="daycare-slot-art-placeholder"></div>`
            + `<img class="daycare-slot-art-img" alt="" hidden>`
            + `</div>`
            + rightBtn
            + `</div>`
            + `<div class="daycare-slot-name">${escapeHtml(name)}</div>`
            + `<div class="daycare-slot-dist">${distLabel}</div>`
            + _daycareLootRowHtml(it.slot)
            + `</div>`;
        }).join('')}
      </div>
    `;
    body.innerHTML = `
      ${slotsHtml}
      <div class="daycare-today">
        <span class="daycare-today-label">Today</span>
        <span class="daycare-today-value">${_formatMeters(todayMeters)}</span>
      </div>
      <div class="daycare-cal-header">
        <button class="daycare-cal-nav" type="button" data-nav="prev"
                aria-label="previous month">‹</button>
        <span class="daycare-cal-title">${escapeHtml(monthName)}</span>
        <button class="daycare-cal-nav" type="button" data-nav="next"
                ${onCurrentMonth ? 'disabled' : ''}
                aria-label="next month">›</button>
      </div>
      <div class="daycare-cal-grid">${dowHtml}${cells.join('')}</div>
      <div class="daycare-detail">${detailHtml}</div>
      <button class="daycare-show-on-map" type="button">${dayOverlayActive ? 'Hide on map' : 'Show on map'}</button>
      <button class="daycare-show-all-on-map" type="button">${allOverlayActive ? 'Hide all on map' : 'Show all on map'}</button>
    `;
    // Slot click → open the creature's detail. Async sprite hydration
    // mirrors detail-view's pattern: drop a placeholder, then swap in
    // the cropped variant once the sprite blob URL resolves. Only
    // populated slots are clickable (data-id is present).
    body.querySelectorAll('.daycare-slot[data-id]').forEach((slot) => {
      const id = slot.dataset.id;
      // Only the sprite tile opens the creature detail — a click on
      // the slot's name, distance, loot row, or empty padding does
      // nothing, so a misclick around the loot pills doesn't yank
      // the user into the detail view.
      const artEl = slot.querySelector('.daycare-slot-art');
      if (artEl) {
        artEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (id) showDetail(id);
        });
      }
      // Conversion toggles — tap to enable that direction, tap again to
      // disable. Mutually exclusive: enabling one direction disables
      // the other. State persists per-slot in localStorage; the active
      // class flips locally without re-rendering the whole panel.
      slot.querySelectorAll('.daycare-convert-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const side = btn.dataset.convertSide;
          if (side !== 'A' && side !== 'B') return;
          const slots = readDaycareSlots();
          const target = slots.find((s) => s && s.id === id);
          if (!target) return;
          const nextDir = (target.convertDir === side) ? null : side;
          target.convertDir = nextDir;
          // Snap the counter for the newly-enabled direction to the
          // current earned-milestone count so future ticks count from
          // *now* — no retroactive conversions for milestones that
          // accumulated while the toggle was off.
          if (nextDir === 'A') target.convertedCountA = _daycareEarnedCount(target);
          if (nextDir === 'B') target.convertedCountB = _daycareEarnedCount(target);
          writeDaycareSlots(slots);
          // Local UI update: flip active on both buttons in this slot.
          slot.querySelectorAll('.daycare-convert-btn').forEach((other) => {
            const otherSide = other.dataset.convertSide;
            const active = otherSide === nextDir;
            other.classList.toggle('active', active);
            other.setAttribute('aria-pressed', active ? 'true' : 'false');
          });
        });
      });
      const c = findCreature(id);
      if (!c || !global.SpriteStore) return;
      if (!isSoloCreature(c) && (c.speciesA == null || c.speciesB == null)) return;
      const img = slot.querySelector('.daycare-slot-art-img');
      const ph = slot.querySelector('.daycare-slot-art-placeholder');
      if (!img) return;
      // Numeric variant for captures; undefined → "best available"
      // for legacy captures saved before per-capture variant tracking.
      const v = (typeof c.variant === 'number') ? c.variant : undefined;
      showCreatureArt(img, Object.assign({}, c, { variant: v }), {
        shinyVariant: c.shinyVariant,
        onReady: () => {
          if (ph) ph.style.display = 'none';
          img.removeAttribute('hidden');
        },
      });
    });
    // Per-pill click → claim that single milestone. The pill
    // collapses to width 0 (width transition pulls later pills
    // leftward), and once it's removed from DOM any pills that
    // were clipped past the slot's right edge slide into view.
    body.querySelectorAll('.daycare-slot[data-id] .daycare-loot-pill').forEach((btn) => {
      btn.addEventListener('click', (e) => _onPillClick(e, btn));
    });
    // Mid-walk new milestones: when distM crosses a milestone
    // boundary (DAYCARE_LOOT_MILESTONE_M), _accumulateDaycareDistance
    // dispatches cc-daycare-loot-tick with the slot id + new milestone
    // numbers.
    // Append a fresh pill (with .appearing slide-in) for each new
    // milestone so the user sees it without a full re-render. If
    // the slot already had its visible-pill quota filled, the new
    // pill is appended past the slot's right edge and gets clipped
    // by overflow:hidden until earlier pills are claimed.
    if (!body._daycareLootTickHandler) {
      const handler = (e) => {
        const d = e && e.detail;
        if (!d || !d.slotId || !Array.isArray(d.newNs)) return;
        const slotEl = body.querySelector(
          `.daycare-slot[data-id="${CSS.escape(d.slotId)}"]`,
        );
        if (!slotEl) return;
        const row = slotEl.querySelector('.daycare-slot-loot');
        if (!row) return;
        const slot = readDaycareSlots().find((s) => s.id === d.slotId);
        if (!slot) return;
        for (const n of d.newNs) {
          if ((slot.claimed || []).includes(n)) continue;
          const loot = _daycareLootAt(slot, n);
          if (!loot) continue;
          if (row.querySelector(`.daycare-loot-pill[data-n="${n}"]`)) continue;
          const pill = document.createElement('button');
          pill.type = 'button';
          pill.className = `daycare-loot-pill loot-kind-${loot.kind} appearing`;
          pill.dataset.n = String(n);
          pill.title = loot.label;
          pill.setAttribute('aria-label', `claim ${loot.label}`);
          // Inline background style mirrors what _daycareLootRowHtml
          // emits for cells that already exist at render time.
          pill.style.cssText = _lootIconStyle(loot);
          pill.addEventListener('animationend', () => {
            pill.classList.remove('appearing');
          }, { once: true });
          pill.addEventListener('click', (ev) => _onPillClick(ev, pill));
          row.appendChild(pill);
        }
      };
      body._daycareLootTickHandler = handler;
      window.addEventListener('cc-daycare-loot-tick', handler);
    }
    body.querySelectorAll('.daycare-cal-nav').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const dir = btn.dataset.nav === 'prev' ? -1 : 1;
        let ny = _daycareCalState.y;
        let nm = _daycareCalState.m + dir;
        if (nm < 0) { nm = 11; ny--; }
        if (nm > 11) { nm = 0; ny++; }
        _daycareCalState.y = ny;
        _daycareCalState.m = nm;
        renderDaycare(opts);
      });
    });
    body.querySelectorAll('.daycare-cal-cell.has-data').forEach((cell) => {
      cell.addEventListener('click', () => {
        _daycareCalState.selDay = cell.dataset.dayKey;
        renderDaycare(opts);
      });
    });
    const showBtn = body.querySelector('.daycare-show-on-map');
    if (showBtn) {
      showBtn.addEventListener('click', () => {
        // Toggle: if the selected day's route is already overlaid, clear
        // it (and re-render so the label flips back to "Show on map").
        if (_activeDaycareOverlay
            && _activeDaycareOverlay.dayKey === _daycareCalState.selDay) {
          _clearDaycarePathOverlay();
          renderDaycare(opts);
          return;
        }
        showDaycarePathOnMap(_daycareCalState.selDay).catch((e) => {
          console.error('showDaycarePathOnMap failed', e);
        });
      });
    }
    const showAllBtn = body.querySelector('.daycare-show-all-on-map');
    if (showAllBtn) {
      showAllBtn.addEventListener('click', () => {
        // Toggle: if the combined all-days route is already overlaid,
        // clear it (and re-render so the label flips back).
        if (_activeDaycareOverlay && _activeDaycareOverlay.allDays) {
          _clearDaycarePathOverlay();
          renderDaycare(opts);
          return;
        }
        showAllDaycarePathsOnMap().catch((e) => {
          console.error('showAllDaycarePathsOnMap failed', e);
        });
      });
    }
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
    if (!global.Sprites || !global.SpriteStore) {
      gridEl.innerHTML = '<div class="variant-empty">Sprites unavailable.</div>';
      return;
    }
    // Variant count gates autogen visibility (autogen is shown only
    // when there are no custom variants; otherwise the hand-drawn
    // ones stand on their own). Credits run in parallel since they
    // come from a different IDB key.
    const variantCount = await global.Sprites.getCellVariantCount(a, b).catch(() => 0);
    const slotCredits = await Promise.all(
      Array.from({ length: variantCount }, (_, i) =>
        global.Sprites.getSpriteCreditForSlot
          ? global.Sprites.getSpriteCreditForSlot(a, b, i).catch(() => null)
          : Promise.resolve(null))
    );
    // Each card description includes the variant identity so the
    // post-render walk can fire SpriteStore.showSprite with the right
    // key. `variant: null` = autogen card; `variant: i` = custom slot i.
    const cards = [];
    if (variantCount === 0) {
      cards.push({
        cls: `variant-cell autogen ${!fusionSeen ? 'silhouette' : ''}`,
        variant: null,
        label: !fusionSeen ? '???' : 'autogen',
        selectable: fusionSeen,   // can favorite the autogen art once seen
      });
    }
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
        variant: i,
        label,
        selectable: isSeen,       // only a discovered variant can be favorited
      });
    }
    if (!cards.length) {
      gridEl.innerHTML = '<div class="variant-empty">No variants found.</div>';
      return;
    }
    gridEl.innerHTML = cards.map((c) => `
      <div class="${c.cls}"${c.selectable ? ' data-fav-selectable' : ''} data-variant="${c.variant === null ? 'auto' : c.variant}" data-shiny="">
        <img alt="">
        <div class="label">${escapeHtml(c.label)}</div>
      </div>
    `).join('');
    const cellEls = gridEl.querySelectorAll('.variant-cell');
    cards.forEach((c, i) => {
      const img = cellEls[i] && cellEls[i].querySelector('img');
      if (!img) return;
      // No onReady — cards whose blob isn't loadable (rare; cells.json
      // says it exists but bulkDownload missed it) get a faded
      // placeholder via the dim opacity already set, and SpriteStore
      // simply doesn't assign src in that case.
      global.SpriteStore.showSprite(img, a, b, c.variant);
      img.style.opacity = '';
    });
  }

  // Renders the "Shiny variants" grid: one cell per shiny style the trainer
  // owns for this fusion (readSeenShinyVariants — live captures ∪ persisted
  // lineage credits). Hides itself AND its section label when there are none,
  // so the row only appears once you've actually got a shiny of the fusion.
  function _populateFusionShinyGrid(gridEl, labelEl, a, b) {
    if (!gridEl) return;
    // Each entry is { variant, shinyVariant } — render at its OWN art variant
    // so a shiny caught at variant #2 shows as variant #2, not a generic one.
    const entries = readSeenShinyVariants(a, b).sort((x, y) =>
      (x.shinyVariant - y.shinyVariant)
      || ((x.variant == null ? -1 : x.variant) - (y.variant == null ? -1 : y.variant)));
    if (!entries.length || !global.SpriteStore) {
      gridEl.innerHTML = '';
      gridEl.style.display = 'none';
      if (labelEl) labelEl.style.display = 'none';
      return;
    }
    gridEl.style.display = '';
    if (labelEl) labelEl.style.display = '';
    // No label — shiny cells are just the sprites, appearing as you get them.
    gridEl.innerHTML = entries.map((e) => `
      <div class="variant-cell shiny-cell" data-fav-selectable data-variant="${e.variant === null ? 'auto' : e.variant}" data-shiny="${e.shinyVariant}">
        <img alt="">
      </div>
    `).join('');
    const cellEls = gridEl.querySelectorAll('.variant-cell');
    entries.forEach((e, i) => {
      const img = cellEls[i] && cellEls[i].querySelector('img');
      if (!img) return;
      const artVariant = (typeof e.variant === 'number') ? e.variant : undefined;
      global.SpriteStore.showSprite(img, a, b, artVariant, { shinyVariant: e.shinyVariant });
      img.style.opacity = '';
    });
  }

  // Normalize a variant/shiny value for favorite comparison (undefined → null).
  function _favNorm(x) { return (typeof x === 'number') ? x : null; }
  // Highlight the grid cell (art or shiny) that is the fusion's current
  // favorite — the one shown up top. Cells carry data-variant / data-shiny.
  function _markFavoriteCells(body, a, b) {
    if (!body) return;
    const fav = favoriteArtFor(a, b);
    const fv = _favNorm(fav.variant), fs = _favNorm(fav.shinyVariant);
    body.querySelectorAll('.variant-cell[data-fav-selectable]').forEach((cell) => {
      const cv = cell.dataset.variant === 'auto' ? null : Number(cell.dataset.variant);
      const cs = cell.dataset.shiny === '' ? null : Number(cell.dataset.shiny);
      cell.classList.toggle('favorited', _favNorm(cv) === fv && _favNorm(cs) === fs);
    });
  }
  // Re-render the fusion header art from the current favorite (used after a
  // tap changes it, without rebuilding the whole sub-view / losing scroll).
  function _refreshFavoriteArt(body, a, b) {
    if (!body || !global.SpriteStore) return;
    const fav = favoriteArtFor(a, b);
    const img = body.querySelector('.detail-art-img');
    const ph = body.querySelector('.detail-art-placeholder');
    const art = body.querySelector('.detail-art');
    if (img) {
      global.SpriteStore.showSprite(img, a, b, fav.variant, {
        shinyVariant: fav.shinyVariant,
        onReady: () => { if (ph) ph.style.display = 'none'; img.style.display = 'block'; },
      });
    }
    if (art) art.classList.toggle('shiny', fav.shinyVariant != null);
    // Keep the family-tree mosaic in sync. Each cell's sprite is picked
    // from favoriteArtFor at grid-render time, and the grid isn't rebuilt
    // on a favorite tap — so without this the current fusion's cell would
    // keep showing the old art until the entry is reopened. Only the (a,b)
    // cell can change (favoriteArt is per-fusion). No-op when the family
    // tree is collapsed / never expanded (no matching cell rendered yet).
    const famImg = body.querySelector(
      `.family-grid .family-cell[data-a="${a}"][data-b="${b}"] img`);
    if (famImg) {
      global.SpriteStore.showSprite(famImg, a, b, fav.variant, {
        shinyVariant: fav.shinyVariant,
        onReady: () => famImg.closest('.family-cell').classList.add('ready'),
      });
    }
    _markFavoriteCells(body, a, b);
  }
  // Wire tap-to-favorite on every selectable art/shiny cell in a fusion
  // sub-view, and mark the one currently in use. Cells opt in with a
  // data-fav-selectable attribute (silhouetted/unseen art cells don't).
  function _wireFavoriteCells(body, a, b) {
    if (!body) return;
    body.querySelectorAll('.variant-cell[data-fav-selectable]').forEach((cell) => {
      cell.addEventListener('click', () => {
        const v = cell.dataset.variant === 'auto' ? null : Number(cell.dataset.variant);
        const s = cell.dataset.shiny === '' ? null : Number(cell.dataset.shiny);
        if (setFavoriteArt(a, b, v, s)) _refreshFavoriteArt(body, a, b);
      });
    });
    _markFavoriteCells(body, a, b);
  }

  function renderFusionView(a, b, targetBody, opts) {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const expandFamily = !!(opts && opts.expandFamily);
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
          // Variant attribution: starts as "autogen" (when 'auto') or
          // "#N" (when a numeric custom slot). For numeric slots we
          // async-resolve the artist credit below and swap the text
          // in place once the credits bundle returns the name.
          let variantLabel = '';
          if (cap.variant === 'auto') variantLabel = 'autogen';
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
      // City, Country line — assembled from whichever of the two
      // were resolvable at encounter time. Older encounters predating
      // the place capture have no `seen.place`, so this stays empty
      // for them (graceful degradation, no backfill needed).
      const placeBits = [];
      if (seen.place) {
        if (seen.place.city) placeBits.push(seen.place.city);
        if (seen.place.country) placeBits.push(seen.place.country);
      }
      const placeStr = placeBits.join(', ');
      const lines = [];
      if (when) lines.push(`<div>First encountered ${escapeHtml(when)}</div>`);
      if (where) lines.push(`<div class="row-meta">${escapeHtml(where)}</div>`);
      if (placeStr) lines.push(`<div class="row-meta">${escapeHtml(placeStr)}</div>`);
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

    // Layout: fused name → image → species pair (links). When the
    // canonical name isn't available yet (SPLIT_NAMES still loading)
    // the species pair stands in as the primary title above the
    // image instead. The species links are rendered with the same
    // markup either way so the click handler below picks them up
    // regardless of their position.
    const speciesPairHtml = `
      <div class="detail-name${fusedName ? ' detail-name-sub' : ''}">
        <span class="species-link" data-side="A">${escapeHtml(nameA)}</span>
        <span> × </span>
        <span class="species-link" data-side="B">${escapeHtml(nameB)}</span>
      </div>
    `;
    // Family tree: shown only when there's at least one row/column
    // beyond the current fusion. Lives here in the pokédex entry
    // (used to be on the captured-detail view) since the family
    // mosaic is fundamentally about the fusion species pair.
    let familyHtml = '';
    let famA = null, famB = null;
    if (global.Species && global.Species.familyOf) {
      // Trim the family arrays to the supported species set so the
      // mosaic doesn't render tiles for fusions we have no data for
      // (Lickilicky, Sylveon, Steelix, etc.). Matches the
      // fusionEvolutionsFor filter — both gates extend together by
      // editing SUPPORTED_SPECIES_EXTRAS.
      famA = global.Species.familyOf(a)
        .filter((id) => SUPPORTED_SPECIES_SET.has(id));
      famB = global.Species.familyOf(b)
        .filter((id) => SUPPORTED_SPECIES_SET.has(id));
      if (famA.length > 1 || famB.length > 1) {
        const ariaExp = expandFamily ? 'true' : 'false';
        const toggleText = expandFamily
          ? 'Hide family tree'
          : `View family tree (${famA.length}×${famB.length})`;
        const gridHiddenAttr = expandFamily ? '' : ' hidden';
        familyHtml = `<div class="detail-family">
          <button class="family-toggle" type="button" aria-expanded="${ariaExp}">
            ${toggleText}
          </button>
          <div class="family-grid"${gridHiddenAttr}></div>
        </div>`;
      }
    }
    // When the trainer hasn't seen this fusion at all (now reachable
    // via the family-tree tile navigation — previously the pokédex
    // grid only listed seen entries), silhouette the header art the
    // same way the variant grid + family-tree cells silhouette unseen
    // entries. The catch-all `.silhouette img` CSS rule blackens any
    // descendant img.
    const headerSilhouette = !isFusionSeen(a, b);
    body.innerHTML = `
      <div class="detail-name-row">
        ${fusedName ? `<div class="detail-fused-name">${escapeHtml(fusedName)}</div>` : speciesPairHtml}
      </div>
      <div class="detail-art${headerSilhouette ? ' silhouette' : ''}">
        <span class="detail-art-placeholder" aria-hidden="true">•</span>
        <img class="detail-art-img" alt="" style="display:none">
      </div>
      ${fusedName ? `<div class="detail-species-row">${speciesPairHtml}</div>` : ''}
      ${typesHtml}
      ${capturedHtml}
      ${encounterHtml}
      ${familyHtml}
      <div class="fusion-section-label">Art variants</div>
      <div class="variant-grid"></div>
      <div class="fusion-section-label shiny-variants-label" style="display:none">Shiny variants</div>
      <div class="variant-grid shiny-variant-grid" style="display:none"></div>
    `;
    // Populate the variant grid asynchronously — server tells us
    // which variant suffixes are non-blank for this cell, then we
    // render thumbnails for each. Variants the trainer hasn't seen
    // (per readSeenVariants — sourced from per-spawn tracking +
    // captures-with-variant) render as silhouettes.
    const variantGrid = body.querySelector('.variant-grid');
    // Shiny variants row: one cell per shiny style owned for this fusion.
    // Self-hides (label + grid) when there are none. Sync (unlike the art
    // grid), so its cells exist before we wire favorites below.
    const shinyGrid = body.querySelector('.shiny-variant-grid');
    const shinyLabel = body.querySelector('.shiny-variants-label');
    if (shinyGrid) _populateFusionShinyGrid(shinyGrid, shinyLabel, a, b);
    // Tap any discovered art/shiny cell to make it this fusion's favorite art
    // (shown up top + in the pokédex + completion dex). Wire after the async
    // art grid renders so both grids' cells are present.
    const wireFav = () => _wireFavoriteCells(body, a, b);
    if (variantGrid) {
      // .then(wireFav, wireFav): wire regardless of whether the art grid
      // populated cleanly, so the (already-rendered) shiny cells are always tappable.
      Promise.resolve(_populateFusionVariantGrid(variantGrid, a, b)).then(wireFav, wireFav);
    } else {
      wireFav();
    }
    body.querySelectorAll('.species-link').forEach((link) => {
      link.addEventListener('click', () => {
        if (link.dataset.side === 'A') showPokedex({ searchA: nameA });
        else showPokedex({ searchB: nameB });
      });
    });

    // Family-tree expand/collapse: lazy-renders the grid on first
    // expand so we don't pay for it on entries the user never
    // unfolds. When the caller asked for expandFamily (e.g. when
    // navigating in from a family-tree tile elsewhere) we render
    // eagerly so the grid is visible on first paint.
    if (famA && famB && famHasContent(famA, famB)) {
      const toggle = body.querySelector('.family-toggle');
      const grid = body.querySelector('.family-grid');
      if (toggle && grid) {
        if (expandFamily) {
          renderFamilyGrid(grid, famA, famB, a, b);
          grid.dataset.rendered = '1';
        }
        toggle.addEventListener('click', () => {
          const expanded = toggle.getAttribute('aria-expanded') === 'true';
          if (expanded) {
            grid.hidden = true;
            toggle.setAttribute('aria-expanded', 'false');
            toggle.textContent = `View family tree (${famA.length}×${famB.length})`;
          } else {
            if (!grid.dataset.rendered) {
              renderFamilyGrid(grid, famA, famB, a, b);
              grid.dataset.rendered = '1';
            }
            grid.hidden = false;
            toggle.setAttribute('aria-expanded', 'true');
            toggle.textContent = 'Hide family tree';
          }
        });
      }
    }

    // Fusion sprite for the header: the trainer's favorite art if set, else
    // the default (lowest seen variant, non-shiny; best-available when nothing
    // seen). favoriteArtFor returns { variant, shinyVariant }.
    if (global.SpriteStore) {
      const img = body.querySelector('.detail-art-img');
      const ph = body.querySelector('.detail-art-placeholder');
      const art = body.querySelector('.detail-art');
      if (img) {
        const fav = favoriteArtFor(a, b);
        if (art) art.classList.toggle('shiny', fav.shinyVariant != null);
        global.SpriteStore.showSprite(img, a, b, fav.variant, {
          shinyVariant: fav.shinyVariant,
          onReady: () => {
            if (ph) ph.style.display = 'none';
            img.style.display = 'block';
          },
        });
        if (art) {
          attachLongPressSave(art, img,
            () => fusedName || `${nameA}-${nameB}`);
        }
      }
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

  // Whether a pokédex entry (an abstract seen-fusion, { key, a, b, ... })
  // passes the selected built-in tag predicates. Fusion-intrinsic tags
  // (Pure/Evolved/Evolvable) are satisfied by a synthesized (a, b) stub;
  // per-capture tags (Radar/Shiny/Hatched/Daycare) read fields that only
  // exist on real captures, so they're matched against the trainer's actual
  // captures of this fusion (capsByFusion: fusion key -> [captures]). A tag
  // passes on the stub OR any real capture of the fusion; AND across preds.
  function pokedexEntryPassesTags(e, preds, capsByFusion) {
    const synthetic = { speciesA: e.a, speciesB: e.b };
    const caps = capsByFusion.get(e.key) || [];
    return preds.every((b) =>
      b.predicate(synthetic) || caps.some((c) => b.predicate(c)));
  }

  function renderPokedex() {
    const _tTotal = performance.now();
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    updateFilterIndicators(panel, POKEDEX_FILTER_SELECTORS);
    renderPokedexTagFilterRow();
    const _tData = performance.now();
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
    const _dataMs = performance.now() - _tData;
    const _inputN = entries.length;
    // Full-library totals for the header summary — captured BEFORE any
    // type/tag/search filter narrows `entries`, so "caught · encountered"
    // stays stable when a filter is applied (it summarizes the whole dex,
    // not the filtered view). Using the post-filter length here made the
    // encountered count clamp to 0 as soon as any filter was active.
    const totalSeenAll = entries.length;
    const _tFilter = performance.now();

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
    // Built-in tag filter (e.g. "Pure"). Fusion-intrinsic predicates
    // (Pure/Evolved/Evolvable) read only speciesA/B, so a synthesized
    // (a, b) stub satisfies them. Per-capture predicates (Radar/Shiny/
    // Hatched/Daycare) read fields that live ONLY on real captures
    // (spawnId/shinyVariant/fromEgg/id), which the stub lacks — so those
    // must be evaluated against the trainer's actual captures of this
    // fusion. A tag passes when the stub matches OR any real capture of
    // the fusion matches; AND semantics across selected tags. The capture
    // index is built only while a tag filter is active (off the common
    // render path), keyed by fusion so each lookup is O(1).
    const selectedPokedexTags = readPokedexTagFilter();
    if (selectedPokedexTags.length) {
      const preds = selectedPokedexTags
        .map((name) => BUILTIN_TAGS.find((b) => b.name === name))
        .filter(Boolean);
      if (preds.length) {
        const capsByFusion = new Map();
        for (const c of readCapturedCreatures()) {
          if (c.speciesA == null || c.speciesB == null) continue;
          const k = `${c.speciesA}-${c.speciesB}`;
          let arr = capsByFusion.get(k);
          if (!arr) { arr = []; capsByFusion.set(k, arr); }
          arr.push(c);
        }
        entries = entries.filter((e) => pokedexEntryPassesTags(e, preds, capsByFusion));
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
    const _filterMs = performance.now() - _tFilter;
    const _tSort = performance.now();

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
    const _sortMs = performance.now() - _tSort;

    const totalCaught = caught.size;
    const encounteredOnly = Math.max(0, totalSeenAll - totalCaught);
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
      _perfMarkRender(_invPerf.renders.pokedex, {
        t: Date.now(),
        dataMs: _dataMs, filterMs: _filterMs, sortMs: _sortMs, virtualizeMs: 0,
        totalMs: performance.now() - _tTotal,
        inputN: _inputN, outputN: 0, empty: true,
      });
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
    const _tVirt = performance.now();
    virtualizeGrid({
      scrollEl: sheet,
      gridEl: grid,
      items: entries,
      cols: 3,
      rowGap: 8,
      cardHeight: 162,
      initialScrollTop: sheet ? sheet.scrollTop : 0,
      makeCardEl(entry) {
        const baseAName = global.Species ? global.Species.nameFor(entry.a) : `#${entry.a}`;
        const baseBName = global.Species ? global.Species.nameFor(entry.b) : `#${entry.b}`;
        // Bases rendered as 3 inline-flex spans so .bn-a (first
        // species) can ellipsize while .bn-x (×) and .bn-b (second
        // species) stay fully visible — see .pokedex-bases CSS.
        const basesHtml =
          `<span class="bn-a">${escapeHtml(baseAName)}</span>`
          + `<span class="bn-x"> × </span>`
          + `<span class="bn-b">${escapeHtml(baseBName)}</span>`;
        // Canonical fused name (e.g. "Jigglyish") falls back to the
        // bases pair when SPLIT_NAMES isn't loaded yet.
        const fused = (global.Sprites && global.Sprites.getFusedName)
          ? global.Sprites.getFusedName(entry.a, entry.b) : null;
        const card = document.createElement('div');
        card.className = 'pokedex-card';
        card.dataset.key = entry.key;
        const primaryHtml = fused
          ? `<div class="pokedex-name">${escapeHtml(fused)}</div>`
            + `<div class="pokedex-bases">${basesHtml}</div>`
          : `<div class="pokedex-name pokedex-name-bases">${basesHtml}</div>`
            + `<div class="pokedex-bases"></div>`;
        card.innerHTML =
          (entry.caught ? '<span class="caught-badge" title="caught">✓</span>' : '')
          + `<div class="pokedex-art"><img alt=""></div>`
          + primaryHtml;
        return card;
      },
      loadSpriteFor(card, entry) {
        if (!global.SpriteStore) return;
        const img = card.querySelector('img');
        if (!img) return;
        // The fusion's favorite art (falls back to the lowest seen variant),
        // so the tile matches what's shown up top in the fusion view — and
        // reflects a shiny favorite when the trainer picked one.
        const fav = favoriteArtFor(entry.a, entry.b);
        global.SpriteStore.showSprite(img, entry.a, entry.b, fav.variant, {
          shinyVariant: fav.shinyVariant,
          onReady: () => card.classList.add('ready'),
        });
      },
    });
    const _virtMs = performance.now() - _tVirt;
    _perfMarkRender(_invPerf.renders.pokedex, {
      t: Date.now(),
      dataMs: _dataMs, filterMs: _filterMs, sortMs: _sortMs, virtualizeMs: _virtMs,
      totalMs: performance.now() - _tTotal,
      inputN: _inputN, outputN: entries.length,
    });
  }

  // ── Completion: per-species discovery progress ─────────────────
  // For a species X, the "morphs" are every supported fusion with X in
  // either slot — X×P (head) for all supported P, and P×X (body). Total
  // is 2·N (N = supported species). The self-fusion X×X counts once per
  // side, matching the two columns the species-dex shows. Percent =
  // fusions seen / 2N, keyed off isFusionSeen — the same discovery
  // signal that drives the silhouettes.
  let _supSpeciesSortedCache = null;
  function supportedSpeciesSorted() {
    if (!_supSpeciesSortedCache) {
      _supSpeciesSortedCache = Array.from(SUPPORTED_SPECIES_SET).sort((x, y) => x - y);
    }
    return _supSpeciesSortedCache;
  }
  // One pass over seenFusions → per-species head/body seen counts.
  function computeSpeciesCompletion() {
    const seen = readSeenFusions();
    const head = new Map(), body = new Map();
    for (const key in seen) {
      if (!Object.prototype.hasOwnProperty.call(seen, key)) continue;
      const dash = key.indexOf('-');
      if (dash < 0) continue;
      const a = +key.slice(0, dash), b = +key.slice(dash + 1);
      if (!SUPPORTED_SPECIES_SET.has(a) || !SUPPORTED_SPECIES_SET.has(b)) continue;
      // Legendaries are far too rare to fairly gate completion, so a fusion
      // only advances a species when its PARTNER is non-legendary. (The
      // legendary morph still lights up in the species-dex grid — it just
      // doesn't count toward the %.)
      if (!isLegendarySpecies(b)) head.set(a, (head.get(a) || 0) + 1);
      if (!isLegendarySpecies(a)) body.set(b, (body.get(b) || 0) + 1);
    }
    const total = 2 * SUPPORTED_NONLEG_COUNT;
    return supportedSpeciesSorted().map((id) => {
      const s = (head.get(id) || 0) + (body.get(id) || 0);
      return {
        id, seen: s, total, pct: total ? s / total : 0,
        legendary: isLegendarySpecies(id), evolved: _isEvolvedSpecies(id),
      };
    });
  }

  // Completion view: when true, only non-evolved species (base forms +
  // pre-evo babies — the ones you actually CATCH or HATCH) are listed and
  // counted, so the % reflects "how much of the catchable pool have I found".
  // View-local (not persisted), like the family-tree expand toggle.
  let _completionNonEvolvedOnly = false;
  // Same idea for a species' partner grid: when true, only non-evolved
  // partners (the ones you can catch / hatch to make the fusion) are listed
  // and counted. Independent of the completion-list toggle above.
  let _speciesdexNonEvolvedOnly = false;

  // ── Glitch dex: solo (special, non-fusion) creatures ───────────
  // Separate section with its own progress bar; does NOT feed the
  // fusion completion % (solo keys carry no '-' and are skipped by
  // computeSpeciesCompletion's pair parsing).
  function renderGlitch(focusId) {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const specials = (global.Specials && global.Specials.byCategory('glitch')) || [];
    const seen = readSeenFusions();
    const seenCount = specials.filter((s) => seen['solo:' + s.id]).length;
    const statsEl = panel.querySelector('.glitch-stats');
    if (statsEl) statsEl.innerHTML = `<b>${seenCount}</b> / ${specials.length} discovered`;
    const grid = panel.querySelector('.glitch-grid');
    if (!grid) return;
    if (!specials.length) {
      grid.innerHTML = '<div class="creature-empty">No glitch pokémon known.</div>';
      return;
    }
    grid.innerHTML = specials.map((s) => {
      const entry = seen['solo:' + s.id];
      const isSeen = !!entry;
      const when = isSeen && entry.firstSeen
        ? new Date(entry.firstSeen).toLocaleDateString() : '';
      return `<div class="glitch-card" data-solo="${escapeHtml(s.id)}">`
        + `<div class="glitch-art"><img alt=""${isSeen ? '' : ' class="silhouette"'} data-solo-img="${escapeHtml(s.id)}"></div>`
        + `<div class="glitch-name">${escapeHtml(isSeen ? s.name : '???')}</div>`
        + (isSeen ? typeChipsHtml(s.types) : '')
        + (isSeen && s.blurb ? `<div class="glitch-blurb">${escapeHtml(s.blurb)}</div>` : '')
        + (when ? `<div class="glitch-when">First seen ${escapeHtml(when)}</div>` : '')
        + `</div>`;
    }).join('');
    grid.querySelectorAll('[data-solo-img]').forEach((img) => {
      const url = global.Specials.spriteUrl(img.dataset.soloImg);
      if (url) img.src = url;
    });
    if (focusId) {
      const el = grid.querySelector(`[data-solo="${focusId}"]`);
      if (el) {
        el.classList.add('glitch-focus');
        el.scrollIntoView({ block: 'center' });
      }
    }
  }
  // "View dex entry →" from a solo's detail view: the glitch grid
  // scrolled to (and highlighting) this special's card.
  function showSoloView(soloId) {
    pushView({ view: 'glitch', focus: soloId });
  }

  function renderCompletion() {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const nonEvoOnly = _completionNonEvolvedOnly;
    // In "non-evolved only" mode drop evolved forms entirely — you can't catch
    // or hatch those directly, so hiding them shows exactly what's left to find
    // in the wild / from eggs. Legendaries are non-evolved so they stay in the
    // list, but (as elsewhere) never count toward the headline %.
    const allRows = computeSpeciesCompletion();
    const rows = nonEvoOnly ? allRows.filter((r) => !r.evolved) : allRows;
    // Most-complete first; ties fall back to dex order (id asc).
    rows.sort((x, y) => (y.pct - x.pct) || (x.id - y.id));

    const filterBtn = panel.querySelector('.completion-filter');
    if (filterBtn) {
      filterBtn.classList.toggle('is-active', nonEvoOnly);
      filterBtn.setAttribute('aria-pressed', nonEvoOnly ? 'true' : 'false');
      filterBtn.textContent = nonEvoOnly
        ? 'Non-evolved only (to catch / hatch)'
        : 'Show non-evolved only';
    }

    const statsEl = panel.querySelector('.completion-stats');
    if (statsEl) {
      // Legendaries are shown in the list but excluded from the headline % and
      // the "complete" tally — they're too rare to fairly count against you.
      // (In non-evolved mode `rows` is already the non-evolved set.)
      let seenAll = 0, totalAll = 0, done = 0, counted = 0;
      for (const r of rows) {
        if (r.legendary) continue;
        counted++;
        seenAll += r.seen; totalAll += r.total;
        if (r.seen >= r.total) done++;
      }
      const overall = totalAll ? Math.round(seenAll / totalAll * 100) : 0;
      statsEl.innerHTML =
        `<b>${overall}%</b> ${nonEvoOnly ? 'non-evolved' : 'overall'}`
        + ` · <b>${done}</b>/${counted} species complete`;
    }

    const grid = panel.querySelector('.completion-grid');
    if (!grid) return;
    const sheet = panel.querySelector('.sheet');
    virtualizeGrid({
      scrollEl: sheet, gridEl: grid, items: rows,
      cols: 1, rowGap: 6, cardHeight: 60,
      initialScrollTop: sheet ? sheet.scrollTop : 0,
      makeCardEl(r) {
        const pct = Math.round(r.pct * 100);
        const bonus = _speciesShinyBonus(r.pct);
        const card = document.createElement('div');
        card.className = 'completion-row';
        card.dataset.species = r.id;
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        // Silhouette the X×X icon until the pure form is actually seen/caught,
        // so the completion list doesn't spoil sprites you haven't found yet.
        const pureSeen = isFusionSeen(r.id, r.id) || isFusionOwned(r.id, r.id);
        card.innerHTML =
          `<div class="completion-icon${pureSeen ? '' : ' silhouette'}"><img alt=""></div>`
          + `<div class="completion-info">`
          +   `<div class="completion-name">${escapeHtml(speciesNameFor(r.id))}</div>`
          +   `<div class="completion-bar"><div class="completion-bar-fill" style="width:${pct}%"></div></div>`
          +   (bonus ? `<div class="completion-bonus">${bonus}× shiny</div>` : ``)
          + `</div>`
          + `<div class="completion-pct">${pct}%<span class="completion-frac">${r.seen}/${r.total}</span></div>`;
        return card;
      },
      loadSpriteFor(card, r) {
        if (!global.SpriteStore) return;
        const img = card.querySelector('img');
        if (!img) return;
        // Self-fusion (X×X) ≈ the species' "pure" sprite — a stable icon.
        // Honor the trainer's favorite art (incl. a favorited shiny) for X×X.
        const fav = favoriteArtFor(r.id, r.id);
        global.SpriteStore.showSprite(img, r.id, r.id, fav.variant, {
          shinyVariant: fav.shinyVariant,
          onReady: () => card.classList.add('ready'),
        });
      },
    });
  }

  // Per-species fusion list: every partner P in dex order, with X×P on the
  // left (X as head) and P×X on the right (X as body). Un-seen fusions show
  // as silhouettes; tapping a cell opens that fusion's pokédex entry.
  function renderSpeciesDex(speciesId) {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const X = parseInt(speciesId, 10);
    if (!isFinite(X)) return;
    const name = speciesNameFor(X);
    const nonEvoOnly = _speciesdexNonEvolvedOnly;
    // In "non-evolved only" mode drop evolved partners — those fusions can't be
    // made by catching/hatching a partner directly, so the grid (and its %)
    // shows exactly the pairings still worth chasing in the wild / from eggs.
    const partners = supportedSpeciesSorted()
      .filter((p) => !nonEvoOnly || !_isEvolvedSpecies(p));

    const filterBtn = panel.querySelector('.speciesdex-filter');
    if (filterBtn) {
      filterBtn.classList.toggle('is-active', nonEvoOnly);
      filterBtn.setAttribute('aria-pressed', nonEvoOnly ? 'true' : 'false');
      filterBtn.textContent = nonEvoOnly
        ? 'Non-evolved only (to catch / hatch)'
        : 'Show non-evolved only';
    }

    const titleEl = panel.querySelector('.speciesdex-title');
    if (titleEl) titleEl.textContent = `${name} dex`;
    const headLbl = panel.querySelector('.speciesdex-col-head');
    const bodyLbl = panel.querySelector('.speciesdex-col-body');
    if (headLbl) headLbl.textContent = `${name} × …`;
    if (bodyLbl) bodyLbl.textContent = `… × ${name}`;

    // Legendary partners still render in the grid below (as uncounted bonus
    // cells), but they don't count toward this page's % — matching the
    // completion-dex row for X.
    let seenHead = 0, seenBody = 0, counted = 0;
    for (const p of partners) {
      if (isLegendarySpecies(p)) continue;
      counted++;
      if (isFusionSeen(X, p)) seenHead++;
      if (isFusionSeen(p, X)) seenBody++;
    }
    const total = 2 * counted;
    const seenAll = seenHead + seenBody;
    const statsEl = panel.querySelector('.speciesdex-stats');
    if (statsEl) {
      const pct = total ? Math.round(seenAll / total * 100) : 0;
      statsEl.innerHTML = `<b>${pct}%</b> · ${seenAll}/${total} seen`;
    }

    const grid = panel.querySelector('.speciesdex-grid');
    if (!grid) return;
    const sheet = panel.querySelector('.sheet');
    virtualizeGrid({
      scrollEl: sheet, gridEl: grid, items: partners,
      cols: 1, rowGap: 6, cardHeight: 84,
      initialScrollTop: sheet ? sheet.scrollTop : 0,
      makeCardEl(p) {
        const cell = (a, b, seenIt) =>
          `<div class="speciesdex-cell${seenIt ? '' : ' silhouette'}" `
          + `data-a="${a}" data-b="${b}" role="button" tabindex="0" `
          + `title="${escapeHtml(seenIt ? speciesNameFor(a) + ' × ' + speciesNameFor(b) : '???')}">`
          + `<span class="speciesdex-cell-ph" aria-hidden="true">·</span><img alt="">`
          // "auto" tag — hidden until loadSpriteFor resolves the ACTUAL
          // rendered variant (shown via .is-auto), so it works for silhouettes
          // whose underlying art is autogen too.
          + `<span class="speciesdex-auto-tag">auto</span>`
          // ✓ overlay when caught (owned ⊆ seen, so never on a silhouette) —
          // mirrors the pokédex card's caught badge.
          + (isFusionOwned(a, b) ? '<span class="caught-badge" title="caught">✓</span>' : '')
          + `</div>`;
        const row = document.createElement('div');
        row.className = 'speciesdex-row';
        row.innerHTML =
          cell(X, p, isFusionSeen(X, p))
          + `<div class="speciesdex-partner"><span class="sd-num">#${p}</span>`
          +   `<span class="sd-name">${escapeHtml(speciesNameFor(p))}</span></div>`
          + cell(p, X, isFusionSeen(p, X));
        return row;
      },
      loadSpriteFor(row, p) {
        if (!global.SpriteStore) return;
        const cells = row.querySelectorAll('.speciesdex-cell');
        const pairs = [[X, p], [p, X]];
        cells.forEach((cell, i) => {
          const img = cell.querySelector('img');
          if (!img) return;
          const a = pairs[i][0], b = pairs[i][1];
          const fav = favoriteArtFor(a, b);
          global.SpriteStore.showSprite(img, a, b, fav.variant, {
            shinyVariant: fav.shinyVariant,
            onReady: () => cell.classList.add('ready'),
          });
          // Flag the "auto" tag against the ACTUAL rendered ART variant: the
          // favorite/seen variant when there is one, else showSprite's
          // best-available fallback (bestVariantFor → custom slot 0 if it
          // exists, else autogen → null). null === autogen, so it tags
          // silhouettes too.
          const seenVar = fav.variant;
          const resolved = (seenVar !== undefined)
            ? Promise.resolve(seenVar)
            : (global.SpriteStore.bestVariantFor
                ? global.SpriteStore.bestVariantFor(a, b) : Promise.resolve(null));
          resolved.then((v) => { cell.classList.toggle('is-auto', v === null); }).catch(() => {});
        });
      },
    });
  }

  function renderDetail(c, targetBody) {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    // Perf tracking — consume the showDetail tap timestamp (if any)
    // and stamp local landmarks. `_dispatchMs` = click → renderDetail
    // start. We finalize the metric record once the header sprite +
    // every expected evo-row sprite have either painted or errored.
    const _tStart = performance.now();
    const _tClick = _invPerf._detailOpenStart;
    _invPerf._detailOpenStart = null;
    const _dispatchMs = (_tClick != null) ? (_tStart - _tClick) : 0;
    let _committed = false;
    const _perfState = {
      t: Date.now(),
      dispatchMs: _dispatchMs,
      syncMs: 0,
      headerSpriteMs: null,
      slowestEvoSpriteMs: null,
      evoRowCount: 0,
      headerReady: false,
      evoRowsReady: 0,
      totalMs: 0,
    };
    function _commitDetailPerf() {
      if (_committed) return;
      // Commit when header is ready AND every evo-row has either
      // signalled ready or errored. headerSpriteMs and slowestEvoSpriteMs
      // are relative to renderDetail start, not to the click — to
      // get user-perceived latency add dispatchMs.
      if (!_perfState.headerReady) return;
      if (_perfState.evoRowsReady < _perfState.evoRowCount) return;
      _committed = true;
      _perfState.totalMs = (performance.now() - _tStart)
        + _perfState.dispatchMs;
      _perfMarkRender(_invPerf.renders.detail, _perfState);
    }
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
    // The species name was previously shown as a "Species: ..." line
    // when a nickname was set — but the species pair below the image
    // (clickable links) already conveys the same info less obtrusively,
    // so we drop this line entirely.
    const speciesLine = '';
    let caughtLine = '';
    let caughtClickable = false;
    if (c.caughtAt) {
      // Date + time-of-day on a single line. toLocaleDateString gives
      // the locale's date format; toLocaleTimeString trimmed to
      // hour:minute for compactness (seconds noise on a date stamp).
      let when = '';
      if (c.caughtAt.timestamp) {
        const d = new Date(c.caughtAt.timestamp);
        const datePart = d.toLocaleDateString();
        const timePart = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        when = `${datePart} ${timePart}`;
      }
      // Hatched-from-egg captures have no specific lat/lng (the
      // player walked across many points to incubate the egg, so a
      // single coordinate would be misleading) — show an explicit
      // origin label instead. Otherwise prefer the nearest POI's
      // name; fall back to coordinates; final fallback is a generic
      // "Unknown location" so a missing lat/lng never throws.
      let where;
      if (c.fromEgg) {
        where = 'Hatched from egg';
      } else if (c.caughtAt.poi && c.caughtAt.poi.name) {
        where = `${c.caughtAt.poi.name} (${Math.round(c.caughtAt.poi.distanceM)} m away)`;
      } else if (c.caughtAt.lat != null && c.caughtAt.lng != null) {
        where = `${c.caughtAt.lat.toFixed(5)}, ${c.caughtAt.lng.toFixed(5)}`;
      } else {
        where = 'Unknown location';
      }
      // City, Country line — only present on captures from after
      // the place-capture change. Older captures keep their two-line
      // format (where · when) without an extra place line.
      const placeBits = [];
      if (c.caughtAt.place) {
        if (c.caughtAt.place.city) placeBits.push(c.caughtAt.place.city);
        if (c.caughtAt.place.country) placeBits.push(c.caughtAt.place.country);
      }
      const placeStr = placeBits.join(', ');
      caughtClickable = c.caughtAt.lat != null && c.caughtAt.lng != null;
      const cls = `detail-caught${caughtClickable ? ' detail-caught-clickable' : ''}`;
      const attrs = caughtClickable
        ? ` role="button" tabindex="0" title="show on map"`
        : '';
      // Three-line layout:
      //   1. "<date> · <time>"
      //   2. "<POI/coords>"
      //   3. "<City>, <Country>"  (when known)
      caughtLine = `<div class="${cls}"${attrs}>`
        + escapeHtml(when)
        + (where ? `<div class="detail-caught-where">${escapeHtml(where)}</div>` : '')
        + (placeStr ? `<div class="detail-caught-place">${escapeHtml(placeStr)}</div>` : '')
        + `</div>`;
    }
    // "From <type> Incense" — its own row, between the Lv·size stats and
    // the caught-location block.
    const incenseHtml = c.fromIncense
      ? `<div class="detail-incense-row">`
        + ((c.incenseType && global.Types.isValid(c.incenseType))
          ? `<img class="detail-incense-orb" src="${escapeHtml(_incenseOrbIcon(global.Types.color(c.incenseType)))}" alt="">`
          : '')
        + 'From ' + escapeHtml((c.incenseType ? global.Types.displayName(c.incenseType) + ' ' : '') + 'Incense')
        + `</div>`
      : '';
    const typesHtml = typeChipsHtml(creatureTypes(c));
    let evosHtml = '';
    let evoEntries = [];
    if (c.speciesA != null && c.speciesB != null) {
      evoEntries = fusionEvolutionsFor(c.speciesA, c.speciesB);
      if (evoEntries.length) {
        evosHtml = `<div class="detail-evos">
          <div class="detail-evos-label">Evolves to</div>
          ${evoEntries.map((e, i) => {
            const seen = isFusionSeen(e.newA, e.newB);
            // Canonical fused name ("Eekuna") via SPLIT_NAMES, falling
            // back to "A × B" when the name table isn't loaded yet.
            const targetName = seen ? fusionName(e.newA, e.newB) : '???';
            // The side that's actually evolving (A or B) determines
            // which species' candy bucket gets billed.
            const srcSpeciesId = e.source === 'A' ? c.speciesA : c.speciesB;
            // formatEvolutionRequirementHtml returns raw HTML (candy
            // icon sprite); the caller is responsible for any user-
            // input escaping inside the helper itself.
            const reqHtml = formatEvolutionRequirementHtml(srcSpeciesId, e.method, e.param);
            // Affordable rows become tappable buttons that open the
            // hold-to-confirm overlay. Unaffordable rows render as
            // passive (no cursor change, no hover state). Note: we
            // intentionally don't gate on `seen` — the user can spend
            // their candy on an unseen target; the confirm dialog
            // shows "???" as the target name in that case, matching
            // the row's own silhouette presentation.
            const affordable = _canAffordEvolution(srcSpeciesId, e.method, e.param);
            const cls = ['evo-row'];
            if (!seen) cls.push('silhouette');
            if (affordable) cls.push('evo-ready');
            const tapAttrs = affordable
              ? ` role="button" tabindex="0" aria-label="Evolve into ${escapeHtml(targetName)}"`
              : '';
            return `<div class="${cls.join(' ')}" data-evo-idx="${i}"${tapAttrs}>
              <span class="evo-arrow">→</span>
              <div class="evo-art">
                <span class="evo-art-placeholder" aria-hidden="true">•</span>
                <img alt="">
              </div>
              <div class="evo-name">${escapeHtml(targetName)}</div>
              <div class="evo-req">${reqHtml}</div>
            </div>`;
          }).join('')}
        </div>`;
      }
    }
    const pokedexLinkHtml = (isSoloCreature(c) || (c.speciesA != null && c.speciesB != null))
      ? `<button class="detail-pokedex-link" type="button">View dex entry →</button>`
      : '';
    body.innerHTML = `
      <div class="detail-name-row" data-mode="view">
        <div class="detail-name detail-name-clickable" role="button" tabindex="0" title="tap to rename">${escapeHtml(name)}</div>
      </div>
      <div class="detail-art${c.shinyVariant != null ? ' shiny' : ''}">
        <span class="detail-art-placeholder" aria-hidden="true">${escapeHtml(c.emoji || '•')}</span>
        <img class="detail-art-img" alt="" style="display:none">
        ${c.shinyVariant != null ? '<svg class="shiny-badge" aria-label="shiny"><use href="#shinyIcon"/></svg>' : ''}
      </div>
      ${pokedexLinkHtml}
      ${speciesLine}
      ${typesHtml}
      ${statsHtml}
      ${incenseHtml}
      ${caughtLine}
      ${candyTallyForCreature(c)}
      ${detailTagsHtml(c)}
      ${evosHtml}
    `;
    const pokedexLink = body.querySelector('.detail-pokedex-link');
    if (pokedexLink) {
      pokedexLink.addEventListener('click', () => {
        if (isSoloCreature(c)) showSoloView(c.solo);
        else showFusionView(c.speciesA, c.speciesB);
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
    // Perf — sync DOM + event-listener wiring is done; anything
    // after this point is async (sprite loads + evo-row Promise
    // chains). Set syncMs + evoRowCount BEFORE any fallback commits
    // so the metric record has the correct counts even when fallback
    // fires before the evo loop runs.
    _perfState.syncMs = performance.now() - _tStart;
    _perfState.evoRowCount = evoEntries.length;
    // If no header sprite is going to fire (no SpriteStore loaded,
    // or no img element), commit the header phase now so the metric
    // can still finalize.
    if (!global.SpriteStore || (!isSoloCreature(c) && (c.speciesA == null || c.speciesB == null))
        || !body.querySelector('.detail-art-img')) {
      _perfState.headerReady = true;
      _perfState.headerSpriteMs = _perfState.syncMs;
      _commitDetailPerf();
    }
    // Lazy-load each evolution row's sprite. The variant resolve +
    // sprite load are deferred to an idle callback so the panel paints
    // first (header sprite + the rest of the body) — evo previews
    // then stream in as cold sprite-pack downloads complete, instead
    // of blocking the panel-open feel for the ~1-2s it takes to fetch
    // them all. Same idea as the inventory virtualizer's
    // load-sprite-per-visible-card pattern, just adapted for the
    // detail view (which doesn't virtualize but still benefits from
    // staging the work).
    //
    // Click handlers are attached SYNCHRONOUSLY below so affordable
    // evo rows are tappable immediately on panel open — only the
    // sprite preview waits for idle.
    if (evoEntries.length) {
      for (let i = 0; i < evoEntries.length; i++) {
        const e = evoEntries[i];
        const row = body.querySelector(`.evo-row[data-evo-idx="${i}"]`);
        if (!row) { _perfState.evoRowsReady++; _commitDetailPerf(); continue; }
        // Resolve the deterministic variant slot the user will get if
        // they evolve. Used for the preview sprite here AND inside
        // performEvolution — same seed both sides, same slot. The
        // silhouette (when target is unseen) thus blackens the SPECIFIC
        // future sprite, not an arbitrary best-available variant.
        let _evoCommitted = false;
        const markEvoRowReady = () => {
          if (_evoCommitted) return;
          _evoCommitted = true;
          const elapsed = performance.now() - _tStart;
          if (_perfState.slowestEvoSpriteMs == null
              || elapsed > _perfState.slowestEvoSpriteMs) {
            _perfState.slowestEvoSpriteMs = elapsed;
          }
          _perfState.evoRowsReady++;
          _commitDetailPerf();
        };
        _scheduleIdle(() => {
        _pickEvolvedVariant(c, c.speciesA, c.speciesB, c.variant, e.newA, e.newB)
          .then(({ variant, autogenOnly }) => {
            // Silhouette the preview when the SPECIFIC variant the user
            // will evolve into hasn't been seen — even if other variants
            // of the same fusion are known. The initial-render
            // `silhouette` class (added when isFusionSeen was false) is
            // re-derived here against the resolved variant.
            if (hasSeenVariant(e.newA, e.newB, variant)) {
              row.classList.remove('silhouette');
            } else {
              row.classList.add('silhouette');
            }
            if (global.SpriteStore) {
              const img = row.querySelector('.evo-art img');
              if (img) {
                global.SpriteStore.showSprite(img, e.newA, e.newB, variant, {
                  // Shiny stays consistent across the evolution — same
                  // family pair, same triple, just on the evolved sprite.
                  shinyVariant: c.shinyVariant,
                  onReady: () => {
                    row.classList.add('evo-art-ready');
                    markEvoRowReady();
                  },
                });
              } else {
                markEvoRowReady();
              }
            } else {
              markEvoRowReady();
            }
            // Autogen-only badge: shown left of the cost when the target
            // fusion has no custom variants at all. Idempotent — bail if
            // the badge is already there (defensive against re-renders).
            if (autogenOnly) {
              const req = row.querySelector('.evo-req');
              if (req && !req.querySelector('.evo-autogen-only')) {
                const badge = document.createElement('span');
                badge.className = 'evo-autogen-only';
                badge.textContent = 'autogen art only';
                req.prepend(badge);
              }
            }
          })
          .catch((err) => {
            _logCreatureError(
              `renderDetail/evoRow/${e.newA}-${e.newB}`, err);
            markEvoRowReady();
          });
        });  // _scheduleIdle
        if (row.classList.contains('evo-ready')) {
          const srcSpeciesId = e.source === 'A' ? c.speciesA : c.speciesB;
          const seen = isFusionSeen(e.newA, e.newB);
          // Same canonical-fused-name treatment as the row label so the
          // confirm dialog shows "Eekuna" not "Eevee × Kakuna".
          const targetName = seen ? fusionName(e.newA, e.newB) : '???';
          const openConfirm = () => openEvolveConfirm({
            creatureId: c.id, srcSpeciesId, targetName,
            method: e.method, param: e.param,
            newA: e.newA, newB: e.newB,
          });
          row.addEventListener('click', openConfirm);
          row.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              openConfirm();
            }
          });
        }
      }
    }
    const nameEl = body.querySelector('.detail-name-clickable');
    if (nameEl) {
      nameEl.addEventListener('click', () => enterRenameMode(c));
      nameEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enterRenameMode(c); }
      });
    }
    body.querySelectorAll('.detail-tag-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const tag = chip.dataset.tag;
        if (!tag) return;
        // Dispatch: an interactive built-in routes through its
        // onToggle handler (which is the source-of-truth for that
        // tag's state — e.g. mutating Daycare slots). User-created
        // tags fall through to the existing toggleCreatureTag path
        // which mutates the capture's `tags` array. Read-only
        // built-ins never reach here because they don't carry a
        // data-tag attribute.
        const builtin = builtinByName(tag);
        if (builtin && typeof builtin.onToggle === 'function') {
          try { builtin.onToggle(c); } catch (e) { console.error(e); }
        } else {
          toggleCreatureTag(c.id, tag);
        }
        // Re-render so chip styling reflects the new applied state.
        const fresh = findCreature(c.id);
        if (fresh) renderDetail(fresh);
      });
    });
    if (global.SpriteStore && (isSoloCreature(c) || (c.speciesA != null && c.speciesB != null))) {
      const img = body.querySelector('.detail-art-img');
      const ph = body.querySelector('.detail-art-placeholder');
      const art = body.querySelector('.detail-art');
      if (img) {
        // Captured creature → render the variant burned in at capture
        // time. Legacy captures (no variant field) and explicit-null
        // both fall back to the default-variant picker (custom v0 /
        // autogen) via undefined.
        const v = (typeof c.variant === 'number') ? c.variant : undefined;
        showCreatureArt(img, Object.assign({}, c, { variant: v }), {
          shinyVariant: c.shinyVariant,
          onReady: () => {
            if (ph) ph.style.display = 'none';
            img.style.display = 'block';
            // Perf — first paint of the main creature sprite. This is
            // the visual "the detail view has loaded" moment.
            if (_perfState.headerSpriteMs == null) {
              _perfState.headerSpriteMs = performance.now() - _tStart;
              _perfState.headerReady = true;
              _commitDetailPerf();
            }
          },
        });
        if (art) attachLongPressSave(art, img, () => name);
      }
    }
  }

  // Rebuild ONLY the name-row's view-mode HTML in place, without
  // re-rendering the rest of the detail body. Lets save/reset/Esc
  // exit edit mode without re-fetching the sprite blob.
  function _exitRenameMode(c) {
    const panel = document.getElementById('creatureInventory');
    if (!panel) return;
    const row = panel.querySelector('.detail-name-row');
    if (!row) return;
    const fresh = findCreature(c.id) || c;
    const name = readNicknames()[fresh.id] || fresh.name;
    row.dataset.mode = 'view';
    row.innerHTML = `<div class="detail-name detail-name-clickable" role="button" tabindex="0" title="tap to rename">${escapeHtml(name)}</div>`;
    const nameEl = row.querySelector('.detail-name-clickable');
    if (nameEl) {
      nameEl.addEventListener('click', () => enterRenameMode(fresh));
      nameEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enterRenameMode(fresh); }
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
    // Reset = circular-arrow undo glyph; Save = checkmark glyph.
    // Both use stroke="currentColor" so they pick up theming.
    row.innerHTML = `
      <form class="rename-form">
        <button class="icon-btn rename-reset" type="button" aria-label="reset to species name" title="reset to species name">
          <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 3-6.7"/>
            <polyline points="3 3 3 9 9 9"/>
          </svg>
        </button>
        <input type="text" maxlength="40" value="${escapeHtml(current)}" aria-label="nickname">
        <button class="icon-btn rename-save" type="submit" aria-label="save" title="save">
          <svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
            <polyline points="5 12 10 17 19 7"/>
          </svg>
        </button>
      </form>
    `;
    const form = row.querySelector('form');
    const input = row.querySelector('input');
    input.focus();
    input.select();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      writeNickname(c.id, input.value);
      _exitRenameMode(c);
    });
    row.querySelector('.rename-reset').addEventListener('click', () => {
      writeNickname(c.id, '');
      _exitRenameMode(c);
    });
    // Esc still backs out without saving (keyboard ergonomics) —
    // there's no visible Cancel button per the new design, but
    // unintentional taps deserve a graceful exit on desktop.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); _exitRenameMode(c); }
    });
  }

  // SVG markup for the four action icons. Used when the
  // "Action buttons as icons" Settings toggle is on (default off).
  const _ACTION_ICON_SVG = {
    tags: '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M21 13l-9 9-9-9V3h9z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
    bag: '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
    candy: '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><ellipse cx="12" cy="12" rx="5" ry="4"/><path d="M7 12 L3 9 L3 15 Z"/><path d="M17 12 L21 9 L21 15 Z"/></svg>',
    daycare: '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="9" r="3"/><path d="M5 21c0-3.5 3-6 7-6s7 2.5 7 6"/></svg>',
    // Egg outline — a stylized vertical oval (taller than wide) with
    // a tiny zigzag at the top suggesting the upcoming crack.
    eggs: '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M12 3c-3.5 0-6.5 4.5-6.5 9 0 4.5 3 7 6.5 7s6.5-2.5 6.5-7c0-4.5-3-9-6.5-9z"/><path d="M9 11l1.5-1.5L12 11l1.5-1.5L15 11"/></svg>',
    dex: '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="2"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="6" y1="17" x2="14" y2="17"/></svg>',
  };
  // Renders the inventory header's Tags / Bag / Candy / Pokédex
  // buttons as either SVG icons or plain text labels, based on the
  // 'cc.actionButtonsAsIcons' localStorage flag (default off → text).
  // Re-attaches click handlers each call so toggling at runtime
  // works without losing interactivity.
  function renderHeaderActions(panel) {
    const container = panel.querySelector('.header-actions');
    if (!container) return;
    const asIcons = localStorage.getItem('cc.actionButtonsAsIcons') === '1';
    const items = [
      { cls: 'tags-link', label: 'Tags', svg: _ACTION_ICON_SVG.tags, onClick: showTags },
      { cls: 'bag-link', label: 'Bag', svg: _ACTION_ICON_SVG.bag, onClick: showBag },
      { cls: 'candy-link', label: 'Candy', svg: _ACTION_ICON_SVG.candy, onClick: showCandy },
      { cls: 'daycare-link', label: 'Daycare', svg: _ACTION_ICON_SVG.daycare, onClick: showDaycare },
      { cls: 'eggs-link', label: 'Eggs', svg: _ACTION_ICON_SVG.eggs, onClick: showEggs },
      { cls: 'pokedex-link', label: 'Dex', svg: _ACTION_ICON_SVG.dex, onClick: showPokedex },
    ];
    container.classList.toggle('header-actions-text', !asIcons);
    container.classList.toggle('header-actions-icons', asIcons);
    container.innerHTML = items.map((it) =>
      `<button class="${it.cls}" type="button" aria-label="${it.label.toLowerCase()}" title="${it.label}">`
      + (asIcons ? it.svg : escapeHtml(it.label))
      + `</button>`
    ).join('');
    items.forEach((it) => {
      const btn = container.querySelector(`.${it.cls}`);
      if (btn) btn.addEventListener('click', it.onClick);
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
      // Species data isn't in memory yet. Kick off the load and
      // re-render once it's ready — runs both in the IPA (auto-
      // loaded from bundled JSON) and the web PWA (after the user
      // taps the download button). Show a quiet "loading…" hint
      // until then; only fall back to the heavy "no data" warning
      // if the load actually fails or takes more than 8 seconds.
      bar.innerHTML = `<div class="weather-warning weather-loading">Loading creature data…</div>`;
      if (global.Species && global.Species.ensureLoaded && !bar._cc_loadingHooked) {
        bar._cc_loadingHooked = true;
        const fail = setTimeout(() => {
          if ((global.Species.typesFor(1) || []).length === 0) {
            bar.innerHTML = `<div class="weather-warning">
              <b>No creature data available.</b><br>
              Try refreshing the app.
            </div>`;
          }
        }, 8000);
        global.Species.ensureLoaded().finally(() => {
          clearTimeout(fail);
          bar._cc_loadingHooked = false;
          renderWeatherBar();
        });
      }
      return;
    }
    const w = (global.Spawns && global.Spawns.currentWeather)
      ? global.Spawns.currentWeather() : null;
    if (!w) { bar.innerHTML = ''; return; }
    const chip = (type) => {
      const bg = global.Types.color(type);
      const label = type.charAt(0) + type.slice(1).toLowerCase();
      return `<span class="type-chip" style="background:${bg}">${escapeHtml(label)}</span>`;
    };
    bar.innerHTML = `<button type="button" class="weather-row" aria-label="Show today's spawn odds">
      <span class="label">Today:</span>${chip(w.daily)}
      <span class="label" style="margin-left:6px;">Week:</span>${chip(w.weekly)}
      <span class="weather-info" aria-hidden="true">ⓘ</span>
    </button>`;
    const oddsBtn = bar.querySelector('.weather-row');
    if (oddsBtn) oddsBtn.addEventListener('click', () => _showThemeOdds());
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
    const _tTotal = performance.now();
    renderWeatherBar();
    renderSaveReminder();
    const panel = document.getElementById('creatureInventory');
    if (panel) updateFilterIndicators(panel, INV_FILTER_SELECTORS);
    renderInvTagFilterRow();
    const searchEl = document.getElementById('creatureSearch');
    const q = (searchEl && searchEl.value || '').trim().toLowerCase();
    const _tData = performance.now();
    let items = sortedCreatures();
    const _dataMs = performance.now() - _tData;
    const _inputN = items.length;
    const _tFilter = performance.now();
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
        const types = isSoloCreature(c)
          ? creatureTypes(c)
          : ((c.speciesA == null || c.speciesB == null) ? null : fusionTypesFor(c.speciesA, c.speciesB));
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
    const _tTagFilter = performance.now();
    const _tagInputN = items.length;
    if (selectedTags.length) {
      items = items.filter((c) => {
        const eff = effectiveTagsForCreature(c);
        return selectedTags.every((t) => eff.includes(t));
      });
    }
    const _tagFilterMs = performance.now() - _tTagFilter;
    {
      const tf = _invPerf.tagFilter;
      tf.calls++;
      tf.totalMs += _tagFilterMs;
      tf.lastMs = _tagFilterMs;
      if (_tagFilterMs > tf.maxMs) tf.maxMs = _tagFilterMs;
      tf.lastInputN = _tagInputN;
      tf.lastOutputN = items.length;
      tf.lastSelected = selectedTags.slice();
    }
    const _filterMs = performance.now() - _tFilter;
    if (!items.length) {
      if (listEl._virtCleanup) listEl._virtCleanup();
      const filteredOut = q || qA || qB || filterType || filterTypeA || filterTypeB || selectedTags.length;
      const msg = filteredOut
        ? 'No creatures match those filters.'
        : 'No creatures yet — go exploring!';
      listEl.innerHTML = `<div class="creature-empty">${msg}</div>`;
      _perfMarkRender(_invPerf.renders.list, {
        t: Date.now(),
        dataMs: _dataMs, filterMs: _filterMs, tagFilterMs: _tagFilterMs, virtualizeMs: 0,
        totalMs: performance.now() - _tTotal,
        inputN: _inputN, outputN: 0, empty: true,
      });
      return;
    }
    const sheet = listEl.closest('.sheet');
    // Live sheet scrollTop preserves the user's position across
    // in-view re-renders (filter chip toggles, sort change, search
    // input). The view-stack's saved scrollY is applied to the sheet
    // in applyTopView's 'browse' case before the first render so the
    // live value is already correct on re-entry from a sub-view.
    _lastInventoryItems = items;
    const _tVirt = performance.now();
    virtualizeGrid({
      scrollEl: sheet,
      gridEl: listEl,
      items,
      cols: 3,
      rowGap: 8,
      initialScrollTop: sheet ? sheet.scrollTop : 0,
      cardHeight: 145,
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
        const shinyBadgeHtml = (c.shinyVariant != null)
          ? `<svg class="shiny-badge" aria-label="shiny"><use href="#shinyIcon"/></svg>`
          : '';
        if (c.shinyVariant != null) card.classList.add('shiny');
        card.innerHTML =
          `<div class="art">`
          + `<span class="art-placeholder" aria-hidden="true">${escapeHtml(c.emoji || '•')}</span>`
          + `<img class="art-img" alt="">`
          + `</div>`
          + shinyBadgeHtml
          + `<div class="name">${escapeHtml(displayName(c))}</div>`
          + statsHtml;
        return card;
      },
      loadSpriteFor(card, c) {
        if (!global.SpriteStore) return;
        if (!isSoloCreature(c) && (c.speciesA == null || c.speciesB == null)) return;
        const img = card.querySelector('.art-img');
        const ph = card.querySelector('.art-placeholder');
        if (!img) return;
        // Captured creature → render the variant burned in at capture
        // time so the player's roster looks identical across sessions.
        // Legacy captures and explicit-null both fall back to the
        // default-variant picker (custom v0 / autogen) via undefined.
        const v = (typeof c.variant === 'number') ? c.variant : undefined;
        showCreatureArt(img, Object.assign({}, c, { variant: v }), {
          shinyVariant: c.shinyVariant,
          onReady: () => {
            if (ph) ph.style.display = 'none';
            img.style.display = 'block';
          },
        });
      },
    });
    const _virtMs = performance.now() - _tVirt;
    _perfMarkRender(_invPerf.renders.list, {
      t: Date.now(),
      dataMs: _dataMs, filterMs: _filterMs, tagFilterMs: _tagFilterMs, virtualizeMs: _virtMs,
      totalMs: performance.now() - _tTotal,
      inputN: _inputN, outputN: items.length,
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
    if (panel) {
      panel.classList.remove('show');
      // Clear the post-catch context so re-opening the panel (from
      // the inventory creature-ball, the pokédex, etc.) doesn't
      // accidentally surface the Done button.
      panel.classList.remove('cc-post-catch');
    }
  }

  // Spawn rendering: each deterministic spawn becomes a MapLibre HTML
  // marker with the cropped fusion sprite (SpriteStore.showSprite). Only
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
  // Whether we're attached and accepting position fixes. The app runs a
  // single OS-level geolocation watch (MapLibre's GeolocateControl, in
  // index.html); we no longer own a watch id — see onLocationFix.
  let _geoListening = false;
  let _userLat = null;
  let _userLng = null;
  // _markers: spawn.id -> { marker, spawn, firstShownAt, loaded, variant? }
  // No URL stored on the record — sprite URLs are owned by SpriteStore.
  const _markers = new Map();
  // Dedupe cache: skip a refresh if the user has moved < 1 m AND the
  // last refresh was very recent. We can't dedupe by tick alone because
  // spawns expire mid-tick (a spawn born at tick T expires at T+5min,
  // which lands between ticks), so we cap the gap at REFRESH_MIN_GAP_MS
  // — GPS-fix storms collapse but new births / expirations land quickly.
  // Kept below SPAWN_REFRESH_MS so the stationary timer is never deduped.
  const REFRESH_MIN_GAP_MS = 2000;
  // How often the stationary timer re-checks for new births / expiries.
  // The refresh is cheap when nothing changed (memoized scan + a marker
  // diff), so a few seconds keeps spawns appearing promptly without churn.
  const SPAWN_REFRESH_MS = 3000;
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

  // === Daycare distance tracker ===
  // All data lives in IDB (creature-tracker-v1):
  //   * `summary` store — { dayKey -> meters }, one record per day.
  //     In-memory cache (`_summaryCache`) holds the full map so the
  //     UI can read totals synchronously after init.
  //   * `paths` store — { dayKey -> [{lat,lng,t}, ...] }. Larger,
  //     queried only when a calendar day is opened.
  // We treat `summary` as a derived cache over `paths` — they can't
  // get out of sync as long as every accepted-distance segment also
  // pushes the arrival point onto the path. Distance only counts
  // segments that pass jitter/gap/speed filters; the path captures
  // every delivered fix INCLUDING those filtered out, so a stationary
  // session still records "I was here" pinpoints.
  let _distAnchorLat = null;
  let _distAnchorLng = null;
  let _distAnchorAt = 0;
  // Timestamp of the most recent fix delivered, regardless of whether
  // it was accepted. Lets the gap detector distinguish "the app was
  // backgrounded for 10 minutes" from "a slow walker hasn't crossed
  // the 10 m threshold for 30 seconds" — the anchor's age alone
  // can't tell those two apart since the anchor is held when sub-
  // threshold movements are rejected.
  let _lastFixAt = 0;

  function _localDayKey(d) {
    const dt = (d instanceof Date) ? d : new Date(d || Date.now());
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // --- IDB schema for tracker ---
  // bumped to v2 to add the `summary` store alongside the original
  // `paths` store. The upgrade only adds the new store; existing
  // path records are untouched.
  const TRACKER_DB = 'creature-tracker-v1';
  const TRACKER_DB_VERSION = 2;
  const TRACKER_STORE = 'paths';
  const TRACKER_SUMMARY_STORE = 'summary';
  // Hard cap so a misbehaving GPS (or a multi-day foreground session)
  // can't grow a single day's record without bound. ~20 k points at
  // 3 m granularity covers ~60 km of walking with healthy headroom.
  const PATH_MAX_POINTS_PER_DAY = 20000;

  let _trackerDbPromise = null;
  function _openTrackerDb() {
    if (_trackerDbPromise) return _trackerDbPromise;
    _trackerDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(TRACKER_DB, TRACKER_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(TRACKER_STORE)) {
          db.createObjectStore(TRACKER_STORE);
        }
        if (!db.objectStoreNames.contains(TRACKER_SUMMARY_STORE)) {
          db.createObjectStore(TRACKER_SUMMARY_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _trackerDbPromise;
  }
  async function _idbGetPath(dayKey) {
    try {
      const db = await _openTrackerDb();
      return await new Promise((resolve) => {
        const tx = db.transaction(TRACKER_STORE, 'readonly');
        const r = tx.objectStore(TRACKER_STORE).get(dayKey);
        r.onsuccess = () => resolve(Array.isArray(r.result) ? r.result : []);
        r.onerror = () => resolve([]);
      });
    } catch { return []; }
  }
  async function _idbPutPath(dayKey, points) {
    try {
      const db = await _openTrackerDb();
      return await new Promise((resolve) => {
        const tx = db.transaction(TRACKER_STORE, 'readwrite');
        tx.objectStore(TRACKER_STORE).put(points, dayKey);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch { /* swallow — best-effort persistence */ }
  }

  // Read every entry in the summary store as a plain { day -> meters }
  // map. Used at init (to seed the in-memory cache) and by the
  // export flow (to bundle the user's full daycare history).
  async function _idbGetAllSummary() {
    try {
      const db = await _openTrackerDb();
      return await new Promise((resolve) => {
        const tx = db.transaction(TRACKER_SUMMARY_STORE, 'readonly');
        const out = {};
        const cur = tx.objectStore(TRACKER_SUMMARY_STORE).openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) { resolve(out); return; }
          if (typeof c.key === 'string' && typeof c.value === 'number') {
            out[c.key] = c.value;
          }
          c.continue();
        };
        cur.onerror = () => resolve(out);
      });
    } catch { return {}; }
  }
  async function _idbPutSummary(dayKey, meters) {
    try {
      const db = await _openTrackerDb();
      return await new Promise((resolve) => {
        const tx = db.transaction(TRACKER_SUMMARY_STORE, 'readwrite');
        tx.objectStore(TRACKER_SUMMARY_STORE).put(meters, dayKey);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch { /* best-effort */ }
  }
  async function _idbBulkPutSummary(map) {
    try {
      const db = await _openTrackerDb();
      return await new Promise((resolve) => {
        const tx = db.transaction(TRACKER_SUMMARY_STORE, 'readwrite');
        const store = tx.objectStore(TRACKER_SUMMARY_STORE);
        for (const k of Object.keys(map)) {
          const v = map[k];
          if (typeof v === 'number' && v > 0) store.put(v, k);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch { /* best-effort */ }
  }
  async function _idbBulkPutPaths(map) {
    try {
      const db = await _openTrackerDb();
      return await new Promise((resolve) => {
        const tx = db.transaction(TRACKER_STORE, 'readwrite');
        const store = tx.objectStore(TRACKER_STORE);
        for (const k of Object.keys(map)) {
          const v = map[k];
          if (Array.isArray(v) && v.length) store.put(v, k);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch { /* best-effort */ }
  }
  async function _idbGetAllPaths() {
    try {
      const db = await _openTrackerDb();
      return await new Promise((resolve) => {
        const tx = db.transaction(TRACKER_STORE, 'readonly');
        const out = {};
        const cur = tx.objectStore(TRACKER_STORE).openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) { resolve(out); return; }
          if (typeof c.key === 'string' && Array.isArray(c.value)) {
            out[c.key] = c.value;
          }
          c.continue();
        };
        cur.onerror = () => resolve(out);
      });
    } catch { return {}; }
  }

  // In-memory summary cache: { dayKey -> meters }. Populated lazily
  // on first read (one IDB cursor walk + a one-time legacy-LS
  // migration), kept in sync with IDB by the accumulator.
  let _summaryCache = null;
  let _summaryLoadPromise = null;
  function _ensureSummaryLoaded() {
    if (_summaryCache) return Promise.resolve(_summaryCache);
    if (_summaryLoadPromise) return _summaryLoadPromise;
    _summaryLoadPromise = (async () => {
      const fromIdb = await _idbGetAllSummary();
      // One-shot migration: pull the legacy localStorage map into IDB
      // and clear the LS entry so we don't keep two copies.
      try {
        const raw = localStorage.getItem(DAYCARE_LEGACY_LS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            const merged = {};
            for (const k of Object.keys(parsed)) {
              const v = parsed[k];
              if (typeof v === 'number' && v > 0) {
                // IDB wins on conflict (it's the authoritative store
                // going forward), but pick legacy if IDB is missing.
                merged[k] = (typeof fromIdb[k] === 'number') ? fromIdb[k] : v;
              }
            }
            await _idbBulkPutSummary(merged);
            for (const k of Object.keys(merged)) fromIdb[k] = merged[k];
            localStorage.removeItem(DAYCARE_LEGACY_LS_KEY);
          }
        }
      } catch { /* swallow */ }
      _summaryCache = fromIdb;
      _summaryLoadPromise = null;
      return _summaryCache;
    })();
    return _summaryLoadPromise;
  }

  // Synchronous read — returns an empty map if the cache hasn't been
  // populated yet. Callers that care about freshness should await
  // `_ensureSummaryLoaded()` first (the daycare view does).
  function readDaycareDistances() {
    return _summaryCache ? Object.assign({}, _summaryCache) : {};
  }
  function getDaycareTodayMeters() {
    if (!_summaryCache) return 0;
    return _summaryCache[_localDayKey()] || 0;
  }

  // In-memory mirror of today's path. Loaded once on first append,
  // appended to in place by every accepted fix, and flushed back to
  // IDB on a debounce so we don't write 100s of KB on every GPS tick.
  let _currentPathDay = null;
  let _currentPathPoints = [];
  let _currentPathLoaded = false;
  let _pathDirty = false;
  let _pathFlushTimer = null;
  const PATH_FLUSH_DEBOUNCE_MS = 5000;

  function _scheduleFlush() {
    if (_pathFlushTimer != null) return;
    _pathFlushTimer = setTimeout(() => {
      _pathFlushTimer = null;
      if (_pathDirty && _currentPathDay) {
        const day = _currentPathDay;
        const snapshot = _currentPathPoints.slice();
        _pathDirty = false;
        _idbPutPath(day, snapshot).catch(() => {});
      }
    }, PATH_FLUSH_DEBOUNCE_MS);
  }

  // Synchronous flush helper for visibilitychange / pagehide. We
  // can't await IDB during pagehide on iOS Safari, but firing the
  // put without await still has a high chance of landing — IDB
  // queues the transaction before the page suspends.
  function _flushPathNow() {
    if (_pathFlushTimer != null) {
      clearTimeout(_pathFlushTimer);
      _pathFlushTimer = null;
    }
    if (_pathDirty && _currentPathDay) {
      const day = _currentPathDay;
      const snapshot = _currentPathPoints.slice();
      _pathDirty = false;
      _idbPutPath(day, snapshot).catch(() => {});
    }
  }

  let _pathHandlersInstalled = false;
  function _installPathFlushHandlers() {
    if (_pathHandlersInstalled) return;
    _pathHandlersInstalled = true;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') _flushPathNow();
      });
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', _flushPathNow);
    }
  }

  // Append one fix to today's in-memory path. Fire-and-forget — the
  // caller is the geolocation handler and shouldn't await IDB.
  function _appendPathPoint(lat, lng, ts) {
    const day = _localDayKey(ts);
    if (_currentPathDay === day && _currentPathLoaded) {
      if (_currentPathPoints.length >= PATH_MAX_POINTS_PER_DAY) return;
      _currentPathPoints.push({ lat, lng, t: ts });
      _pathDirty = true;
      _scheduleFlush();
      return;
    }
    // First call OR midnight rollover: load (or swap) the day's path
    // before appending. Subsequent calls in the same day take the
    // synchronous fast path above.
    (async () => {
      // Flush the outgoing day before we overwrite our in-memory
      // pointer — otherwise points captured right at midnight could
      // be lost.
      if (_currentPathDay && _currentPathDay !== day && _pathDirty) {
        await _idbPutPath(_currentPathDay, _currentPathPoints.slice());
        _pathDirty = false;
      }
      const existing = await _idbGetPath(day);
      _currentPathDay = day;
      _currentPathPoints = existing;
      _currentPathLoaded = true;
      if (_currentPathPoints.length < PATH_MAX_POINTS_PER_DAY) {
        _currentPathPoints.push({ lat, lng, t: ts });
        _pathDirty = true;
        _scheduleFlush();
      }
      _installPathFlushHandlers();
    })().catch(() => {});
  }

  // Public read API for future path-rendering UI. Today's record
  // returns the in-memory snapshot (so the data is fresh even between
  // debounced flushes); past days come from IDB.
  async function getDaycarePath(dayKey) {
    if (!dayKey) dayKey = _localDayKey();
    if (_currentPathDay === dayKey && _currentPathLoaded) {
      return _currentPathPoints.slice();
    }
    return _idbGetPath(dayKey);
  }

  // Export the entire daycare history (summary + every per-day path)
  // as a plain JSON-safe object so the backup payload can ship it.
  // Today's path is flushed to IDB before snapshotting so the export
  // includes any in-memory points not yet written. Excluded from
  // export only when the user has never recorded any travel — the
  // settings round-trip should otherwise be lossless.
  async function exportDaycareData() {
    _flushPathNow();
    const [summary, paths] = await Promise.all([
      _idbGetAllSummary(),
      _idbGetAllPaths(),
    ]);
    return { v: 1, summary, paths };
  }
  // Merge an exportDaycareData payload into local IDB. Strategy:
  //   - summary: per-day MAX (so a re-import is idempotent and merging
  //     two devices keeps the higher distance — an arbitrary but
  //     consistent rule that won't double-count walks already
  //     reflected on both devices).
  //   - paths: incoming wins for days that don't already have a local
  //     path; otherwise kept as-is (avoid stitching two GPS streams
  //     into a chimera). Future improvement: timestamp-merge.
  async function importDaycareData(data) {
    if (!data || typeof data !== 'object') return { merged: 0 };
    let merged = 0;
    if (data.summary && typeof data.summary === 'object') {
      await _ensureSummaryLoaded();
      const incoming = data.summary;
      const toWrite = {};
      for (const k of Object.keys(incoming)) {
        const v = Number(incoming[k]) || 0;
        if (v <= 0) continue;
        const local = (_summaryCache && _summaryCache[k]) || 0;
        if (v > local) {
          toWrite[k] = v;
          if (!_summaryCache) _summaryCache = {};
          _summaryCache[k] = v;
          merged++;
        }
      }
      if (Object.keys(toWrite).length) await _idbBulkPutSummary(toWrite);
    }
    if (data.paths && typeof data.paths === 'object') {
      const local = await _idbGetAllPaths();
      const toWrite = {};
      for (const k of Object.keys(data.paths)) {
        const v = data.paths[k];
        if (Array.isArray(v) && v.length && !(local[k] && local[k].length)) {
          toWrite[k] = v;
        }
      }
      if (Object.keys(toWrite).length) await _idbBulkPutPaths(toWrite);
    }
    return { merged };
  }

  // Credit `d` meters at time `ts` to: today's distance summary, every
  // occupied daycare slot (firing cc-daycare-loot-tick on milestone
  // crossings — DAYCARE_LOOT_MILESTONE_M m apart), and every occupied
  // incubator egg (firing cc-incubator-tick on hatch completion). The
  // shared write path for both GPS-driven (haversine between fixes)
  // and pedometer-driven (CMPedometer cumulative meters while the app
  // was closed) accumulation.
  function _creditMeters(d, ts) {
    if (!Number.isFinite(d) || d <= 0) return;
    const k = _localDayKey(ts);
    if (!_summaryCache) _summaryCache = {};
    _summaryCache[k] = (_summaryCache[k] || 0) + d;
    _idbPutSummary(k, _summaryCache[k]).catch(() => {});
    const slots = readDaycareSlots();
    if (slots.length) {
      const ticks = [];
      for (const s of slots) {
        const before = Math.floor((s.distM || 0) / DAYCARE_LOOT_MILESTONE_M);
        s.distM += d;
        const after = Math.floor(s.distM / DAYCARE_LOOT_MILESTONE_M);
        if (after > before) {
          const newNs = [];
          for (let n = before + 1; n <= after; n++) newNs.push(n);
          ticks.push({ slotId: s.id, newNs });
        }
        // Candy conversion (independent of loot — both share the same
        // milestone heartbeat but track their own counters).
        _applyDaycareConversionsToSlot(s);
      }
      writeDaycareSlots(slots);
      if (ticks.length && typeof window !== 'undefined') {
        for (const t of ticks) {
          try {
            window.dispatchEvent(new CustomEvent('cc-daycare-loot-tick', {
              detail: { slotId: t.slotId, newNs: t.newNs },
            }));
          } catch { /* best-effort */ }
        }
      }
    }
    const incubSlots = readIncubator();
    if (incubSlots.some((s) => !!s)) {
      const eggs = readEggs();
      let eggsChanged = false;
      const ready = [];
      for (const slotEggId of incubSlots) {
        if (!slotEggId) continue;
        const i = eggs.findIndex((e) => e.id === slotEggId);
        if (i < 0) continue;
        const before = eggIncubatedM(eggs[i]);
        if (before >= INCUBATOR_HATCH_M) continue;
        const after = Math.min(before + d, INCUBATOR_HATCH_M);
        if (after !== before) {
          eggs[i] = { ...eggs[i], incubatedM: after };
          eggsChanged = true;
          if (after >= INCUBATOR_HATCH_M && before < INCUBATOR_HATCH_M) {
            ready.push(slotEggId);
          }
        }
      }
      if (eggsChanged) {
        writeEggs(eggs);
        if (typeof window !== 'undefined') {
          try {
            window.dispatchEvent(new CustomEvent('cc-incubator-tick', {
              detail: { ready },
            }));
          } catch { /* best-effort */ }
        }
      }
    }
  }

  // Persist the timestamp through which movement has been credited (by
  // either GPS or pedometer). The pedometer sync uses this as the lower
  // bound of its next "since last sync" query, so we never double-count
  // intervals the GPS already credited. Stored in localStorage as ms
  // since epoch.
  const LAST_FITNESS_SYNC_KEY = 'cc.lastFitnessSyncMs';
  function _markFitnessSynced(ts) {
    if (!Number.isFinite(ts) || ts <= 0) return;
    try {
      const cur = parseInt(localStorage.getItem(LAST_FITNESS_SYNC_KEY), 10) || 0;
      // Monotonic: never move the marker backward. The pedometer resolver
      // and the GPS callback can race on the foreground transition; max()
      // makes whichever sees a higher ts win.
      if (ts > cur) localStorage.setItem(LAST_FITNESS_SYNC_KEY, String(ts));
    } catch { /* localStorage full / disabled — pedometer sync degrades to no-op */ }
  }
  function _readLastFitnessSync() {
    try {
      const v = parseInt(localStorage.getItem(LAST_FITNESS_SYNC_KEY), 10);
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch { return null; }
  }

  // Public entry point for the pedometer bridge (see index.html's
  // visibility handler). `meters` is the cumulative distance the
  // CMPedometer query reported for [lastFitnessSync, now]; we forward
  // straight to the shared credit path. The caller is responsible for
  // advancing lastFitnessSync only on a successful query (ok:true).
  function creditPedometerMeters(meters) {
    _creditMeters(meters, Date.now());
  }

  // When the pedometer toggle is on, the CMPedometer bridge is the
  // sole distance source — GPS fixes still drive the on-map path
  // polyline, the anchor-based jitter filter, and the spawn-proximity
  // logic, but they stop crediting daycare slots / incubator eggs /
  // the daily summary. The pedometer query (which sees the M-series
  // coprocessor's reading directly) is more accurate than haversine
  // anyway, and avoids the double-counting that would otherwise need
  // careful interleaving between the two streams.
  function _isPedometerActive() {
    try { return localStorage.getItem('cc.pedometerEnabled') === '1'; }
    catch { return false; }
  }

  // Called from the geolocation watchPosition callback. The anchor
  // is HELD across sub-threshold fixes (so jitter doesn't compound
  // even though no individual segment exceeds the 10 m floor) — only
  // an accepted fix advances the anchor. Path points are recorded
  // ONLY for accepted fixes plus session boundaries (first fix and
  // post-gap resume), so the stored route is a clean polyline rather
  // than a cloud of dwell points.
  function _accumulateDaycareDistance(lat, lng, ts) {
    const prevFixAt = _lastFixAt;
    _lastFixAt = ts;
    if (_distAnchorLat == null) {
      _distAnchorLat = lat;
      _distAnchorLng = lng;
      _distAnchorAt = ts;
      _appendPathPoint(lat, lng, ts);
      return;
    }
    // Backgrounding gap: a long silence between fixes means the user
    // probably went elsewhere with the app suspended. Reset the
    // anchor so we don't credit the teleport as travel, and log a
    // resume point so the path renderer shows a break here.
    if (prevFixAt > 0 && (ts - prevFixAt) > DAYCARE_DIST_MAX_GAP_MS) {
      _distAnchorLat = lat;
      _distAnchorLng = lng;
      _distAnchorAt = ts;
      _appendPathPoint(lat, lng, ts);
      return;
    }
    const d = metersBetween(_distAnchorLat, _distAnchorLng, lat, lng);
    if (d < DAYCARE_DIST_MIN_M) return;  // jitter — hold the anchor
    const dt = ts - _distAnchorAt;
    if (dt <= 0) return;
    if ((d * 1000) / dt > DAYCARE_DIST_MAX_SPEED) {
      // Outlier fix: reset anchor here without recording.
      _distAnchorLat = lat;
      _distAnchorLng = lng;
      _distAnchorAt = ts;
      return;
    }
    // Accept: advance anchor, record path. When pedometer is the
    // distance source, skip the credit + sync-marker updates — the
    // pedometer's periodic foreground query owns distance accounting.
    // The anchor / path-polyline / spawn-radius logic still runs so
    // gameplay (markers, halos, "where I've been today" view) keeps
    // working unchanged.
    if (!_isPedometerActive()) {
      _creditMeters(d, ts);
      _markFitnessSynced(ts);
    }
    _distAnchorLat = lat;
    _distAnchorLng = lng;
    _distAnchorAt = ts;
    _appendPathPoint(lat, lng, ts);
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
  // Re-entry guard for throwBall — see the wrapper below the impl
  // for why. Set true while an animation chain is in flight; rapid
  // double-taps and multi-button mashes are rejected at the door.
  let _throwInFlight = false;

  function ensureBattleScreen() {
    let el = document.getElementById('battleScreen');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'battleScreen';
    el.innerHTML = `
      <div class="battle-sprite-wrap">
        <div class="battle-sprite-placeholder"></div>
        <img class="battle-sprite" alt="" draggable="false">
        <svg class="shiny-badge" aria-label="shiny"><use href="#shinyIcon"/></svg>
        <div class="battle-thrown-ball" hidden>
          <img class="ball-half ball-bottom" alt="">
          <img class="ball-half ball-top" alt="">
          <img class="ball-seam-glow" src="/static/ball-seam-glow.svg" alt="">
        </div>
        <img class="battle-flash" alt="" hidden>
        <div class="battle-burst" hidden></div>
      </div>
      <div class="battle-info">
        <div class="battle-new-badge" hidden>New</div>
        <img class="battle-incense" alt="from incense" hidden>
        <div class="battle-name"></div>
        <div class="battle-stats"></div>
        <div class="battle-types"></div>
      </div>
      <div class="battle-actions">
        <button type="button" class="flee">Flee</button>
        <div class="battle-balls"></div>
      </div>
    `;
    el.querySelector('button.flee').addEventListener('click', () => {
      // Once a ball is in flight the encounter is locked (see below);
      // the .throwing CSS already blanks this panel, but guard here too
      // so the close can never fire mid-throw regardless of CSS timing.
      if (_throwInFlight) return;
      closeBattleScreen();
    });
    el.addEventListener('click', (e) => {
      // Click on backdrop (outside the info/actions) dismisses — but NOT
      // once a ball has been thrown. The encounter is locked until the
      // creature is caught or breaks out; otherwise the player can tap
      // away mid-throw and the async catch still resolves, popping the
      // caught creature up over the map. Before a throw (_throwInFlight
      // false) the backdrop dismisses freely. See _throwInFlight.
      if (e.target === el && !_throwInFlight) closeBattleScreen();
    });
    document.body.appendChild(el);
    return el;
  }

  function openBattleScreen(spawn) {
    const el = ensureBattleScreen();
    _currentBattleSpawn = spawn;
    // "New" badge on the info bubble's top-left corner:
    //   • "New"     — we've never caught this fusion
    //   • "Fresh"   — we caught it before but evolved our copy away (re-catch)
    //   • "New Art" — we own the fusion but not this variant (art)
    // The variant can resolve asynchronously, so the badge is finalised once
    // it's known (defaults to hidden for an owned fusion until then).
    const isSoloSpawn = typeof spawn.solo === 'string' && spawn.solo;
    const ownsFusion = !isSoloSpawn && isFusionOwned(spawn.speciesA, spawn.speciesB);
    // Caught-then-evolved-away flag on the dex row (see markFusionCaughtAway).
    // Read before markFusionSeen below (which never touches `caught`, so order
    // is not load-bearing, but the intent is "what did we know coming in").
    const caughtAway = !ownsFusion
      && !!(readSeenFusions()[`${spawn.speciesA}-${spawn.speciesB}`] || {}).caught;
    // Which art variants had we seen coming IN? markFusionSeen (below) records
    // the current one, so a live hasSeenVariant() inside decideArtBadge would
    // always be true — snapshot it here, mirroring the caughtAway read above.
    // Drives the "Fresh Art" badge: an art we've seen before but no longer own.
    const seenVariantsBefore = readSeenVariants(spawn.speciesA, spawn.speciesB);
    const hadSeenVariant = (variant) => {
      if (typeof variant === 'number' && variant >= 0) return seenVariantsBefore.has(String(variant));
      return seenVariantsBefore.has('auto');
    };
    const newBadge = el.querySelector('.battle-new-badge');
    const showNewBadge = (text) => {
      if (!newBadge) return;
      if (!text) { newBadge.hidden = true; return; }
      newBadge.textContent = text;
      newBadge.hidden = false;
      newBadge.style.animation = 'none';
      void newBadge.offsetWidth; // restart the pop animation
      newBadge.style.animation = '';
    };
    showNewBadge(ownsFusion ? '' : (caughtAway ? 'Fresh' : 'New'));
    const decideArtBadge = (variant) => {
      if (!ownsFusion) return;
      if (ownsVariant(spawn.speciesA, spawn.speciesB, variant)) {
        showNewBadge('');            // own this exact art — nothing new
      } else if (hadSeenVariant(variant)) {
        showNewBadge('Fresh Art');   // seen this art before but don't own it (e.g. evolved it away)
      } else {
        showNewBadge('New Art');     // never seen this art of a fusion we own
      }
    };
    // Mark fusion seen + record which variant the user actually saw, so the
    // pokédex can silhouette variants they haven't yet seen. Variant
    // resolution is async; do it in the background.
    const _seenRec = _markers.get(spawn.id);
    // Decide shininess for THIS player at the moment they engage the
    // encounter. Lives on the marker record so the battle sprite, the
    // post-throw capture record, and any re-open of the same encounter
    // all see the same answer.
    _rollShinyForRecord(_seenRec);
    if (isSoloSpawn) {
      markSoloSeen(spawn.solo, 'auto');
    } else if (_seenRec && 'variant' in _seenRec) {
      markFusionSeen(spawn.speciesA, spawn.speciesB, spawn, _seenRec.variant);
      decideArtBadge(_seenRec.variant);
    } else {
      markFusionSeen(spawn.speciesA, spawn.speciesB, spawn);
      resolveSpawnVariant(spawn).then((v) => {
        markFusionSeen(spawn.speciesA, spawn.speciesB, null, v);
        decideArtBadge(v);
      }).catch(() => {});
    }
    const nameEl = el.querySelector('.battle-name');
    const statsEl = el.querySelector('.battle-stats');
    nameEl.textContent = isSoloSpawn ? creatureName(spawn) : fusionName(spawn.speciesA, spawn.speciesB);
    statsEl.textContent = `Lv ${spawn.level} · ${formatSize(spawn.sizeM)}`;
    const typesEl = el.querySelector('.battle-types');
    if (typesEl) {
      typesEl.innerHTML = typeChipsHtml(creatureTypes(spawn));
    }
    // Incense badge — a little type-coloured orb in the info bubble's
    // top-right when this spawn came from an active incense.
    const incEl = el.querySelector('.battle-incense');
    if (incEl) {
      if (spawn.incense && spawn.incenseType && global.Types.isValid(spawn.incenseType)) {
        incEl.src = _incenseOrbIcon(global.Types.color(spawn.incenseType));
        incEl.title = global.Types.displayName(spawn.incenseType) + ' Incense';
        incEl.hidden = false;
      } else {
        incEl.hidden = true;
        incEl.removeAttribute('src');
      }
    }
    const img = el.querySelector('img.battle-sprite');
    // Reset previous state — animation transforms, throwing flag —
    // so a fresh encounter starts clean. Cancel any lingering Web
    // Animations first so their `fill:'forwards'` contribution
    // doesn't keep the sprite invisible / shrunk.
    //
    // We do NOT revoke any URL here — sprite URLs are owned by
    // SpriteStore and can be safely reused across map / battle /
    // inventory contexts.
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

    // Single sprite-load path via SpriteStore. When the marker for
    // this spawn just rendered the same fusion, the cache hits
    // immediately (zero-flash flip from world map → battle screen).
    // On miss the underlying Sprites.getSpriteBlob cascade reads
    // from the bundled pack / IDB / lazy-crop, and the URL Promise
    // resolves once the blob is in hand.
    //
    // The onReady callback gates on `_currentBattleSpawn === spawn`
    // so a slow load resolving after the user fled or moved on
    // doesn't reveal the wrong sprite. SpriteStore also bumps
    // img._spriteGen on every call, so an even-older load (e.g. from
    // a marker that pre-rendered into this same img — shouldn't
    // happen, but defensively) can't clobber the current bind either.
    if (global.SpriteStore) {
      const rec = _markers.get(spawn.id);
      const shinyVariant = (rec && typeof rec.shinyVariant === 'number')
        ? rec.shinyVariant : null;
      const onSpriteReady = () => {
        if (_currentBattleSpawn !== spawn) return;
        el.classList.add('battle-sprite-ready');
        if (shinyVariant != null) el.classList.add('battle-sprite-shiny');
        else el.classList.remove('battle-sprite-shiny');
      };
      if (isSoloSpawn) {
        // Solo spawn (future stream): full-PNG art, no variant resolve.
        showCreatureArt(img, { solo: spawn.solo, shinyVariant }, { onReady: onSpriteReady });
      } else {
      const variantPromise = (rec && 'variant' in rec)
        ? Promise.resolve(rec.variant)
        : resolveSpawnVariant(spawn);
      variantPromise.then((variant) => {
        if (_currentBattleSpawn !== spawn) return;
        global.SpriteStore.showSprite(
          img, spawn.speciesA, spawn.speciesB, variant, {
            shinyVariant,
            onReady: onSpriteReady,
          },
        );
      }).catch((e) => {
        _logCreatureError(`openBattleScreen/load/${spawn.speciesA}-${spawn.speciesB}`, e);
      });
      }
    }
    el.classList.add('show');
  }

  function closeBattleScreen() {
    const el = document.getElementById('battleScreen');
    if (el) {
      el.classList.remove('show');
      // Symmetric reset so the next open starts from a clean state
      // even if the open path is interrupted before it can reset
      // these. URL ownership is the cache's problem now — nothing to
      // revoke here.
      el.classList.remove('battle-sprite-ready');
      el.classList.remove('battle-sprite-shiny');
      el.classList.remove('throwing');
      // Cancel + reset every element the throw flow animates with
      // fill:'forwards'. The break-out path already does this at
      // the end of throwBall, but the CAUGHT path skips straight
      // to closeBattleScreen with the sprite still at scale(0) +
      // opacity(0) (the suck-in's lingering fill state). Without
      // this cleanup the next encounter's sprite inherits the
      // invisible state — its animation effect competes with the
      // new openBattleScreen's reset, and the only guaranteed
      // cleanup point (cancelAnimsOn in the next open) sometimes
      // races with the new sprite load on mobile browsers, leaving
      // the user with an invisible sprite for the entire next
      // encounter. Doing the reset HERE — in the same synchronous
      // call as the close — guarantees a clean state regardless of
      // the next-open timing.
      const sprite = el.querySelector('img.battle-sprite');
      if (sprite) {
        cancelAnimsOn(sprite);
        sprite.style.transform = '';
        sprite.style.opacity = '';
      }
      const ball = el.querySelector('.battle-thrown-ball');
      if (ball) {
        cancelAnimsOn(ball);
        ball.style.transform = '';
        ball.style.opacity = '';
        ball.setAttribute('hidden', '');
        ball.querySelectorAll('.ball-half').forEach((half) => {
          cancelAnimsOn(half);
          half.style.transform = '';
          half.style.opacity = '';
        });
        const seamGlow = ball.querySelector('.ball-seam-glow');
        if (seamGlow) {
          cancelAnimsOn(seamGlow);
          seamGlow.style.transform = '';
          seamGlow.style.opacity = '';
        }
      }
      const flash = el.querySelector('.battle-flash');
      if (flash) {
        cancelAnimsOn(flash);
        flash.style.opacity = '';
        flash.setAttribute('hidden', '');
      }
      const burst = el.querySelector('.battle-burst');
      if (burst) {
        cancelAnimsOn(burst);
        burst.style.opacity = '';
        burst.setAttribute('hidden', '');
      }
    }
    _currentBattleSpawn = null;
  }

  // Add the spawn to the inventory + side effects (candy, mark caught,
  // remove marker, request storage persistence). Returns the new
  // capture entry — the caller decides whether to close the battle
  // screen and/or open the inventory detail view.
  async function recordCaptureFromSpawn(spawn) {
    // Make sure the collection has finished hydrating from IDB before we
    // read-modify-write it, so a catch in the first moments after launch
    // can't build on (and then persist) an empty list. No-op once loaded.
    await _whenReady();
    const poiApi = global.CreatureCollectAPI;
    const poi = (poiApi && poiApi.findNearestNamedPoi)
      ? poiApi.findNearestNamedPoi(spawn.lat, spawn.lng)
      : null;
    // City + country at capture time, same source as the encounter
    // info (POI address tags first, vector-tile place layer second).
    const place = (poiApi && poiApi.findNearestPlace)
      ? poiApi.findNearestPlace(spawn.lat, spawn.lng)
      : null;
    // Capture the variant the player saw at the moment of catching,
    // so the inventory always shows that exact sprite even if the
    // per-cell variant table later changes (e.g., new artist sheets).
    // Reuses the marker record's cached variant when present.
    const rec = _markers.get(spawn.id);
    const variant = (rec && 'variant' in rec)
      ? rec.variant
      : await resolveSpawnVariant(spawn);
    // shinyVariant was decided in openBattleScreen when the player tapped the
    // spawn. Resolve it robustly (marker record → per-spawn cache → fresh roll)
    // so a marker rebuilt by a spawn refresh mid-catch can't drop a shiny the
    // player saw. The cache entry is no longer needed once it's persisted here.
    const shinyVariant = _resolveShinyForCatch(spawn);
    if (spawn && spawn.id != null) _shinyBySpawn.delete(spawn.id);
    const isSolo = typeof spawn.solo === 'string' && spawn.solo;
    const entry = {
      id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      spawnId: spawn.id,
      // Solo spawn (future stream): speciesA/B stay null, solo id set.
      solo: isSolo ? spawn.solo : undefined,
      speciesA: isSolo ? null : spawn.speciesA,
      speciesB: isSolo ? null : spawn.speciesB,
      variant,
      shinyVariant,
      level: spawn.level,
      sizeM: spawn.sizeM,
      caughtAt: {
        timestamp: Date.now(),
        lat: spawn.lat,
        lng: spawn.lng,
        poi: poi || null,
        place: place || null,
      },
    };
    if (!isSolo) delete entry.solo;
    // Tag incense-spawned catches so the detail view can show "From
    // <type> Incense" (parallel to fromEgg's "Hatched from egg").
    if (spawn.incense) {
      entry.fromIncense = true;
      if (typeof spawn.incenseType === 'string') entry.incenseType = spawn.incenseType;
    }
    const list = readCapturedCreatures();
    list.push(entry);
    writeCapturedCreatures(list);  // persists to IDB — no quota wall
    // Candy + caught-spawn bookkeeping write small keys to localStorage.
    // Guard each independently: a failure here (e.g. a transient quota
    // error from some other oversized key) must NOT abort the catch and
    // leave the spawn un-marked — that was the "catches it repeatedly"
    // bug. The creature is already recorded above; just log and continue.
    try {
      const candyTotal = spawn.legendary
        ? CANDY_LEGENDARY_CAPTURE
        : (spawn.evolved ? CANDY_EVOLVED_CAPTURE : 2);
      if (isSolo) awardCandyForSolo(spawn.solo, candyTotal);
      else awardCandyForCapture(spawn.speciesA, spawn.speciesB, candyTotal);
    }
    catch (e) { _logCreatureError('recordCapture/awardCandy', e); }
    try { markSpawnCaught(spawn.id); }
    catch (e) { _logCreatureError('recordCapture/markSpawnCaught', e); }
    removeMarker(spawn.id);
    if (list.length === 1 && navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    return entry;
  }

  // Dev/admin grant for solo (special) creatures — the ONLY way to
  // obtain one until solo spawn streams land. Builds the same record
  // shape a solo catch would, marks the dex entry seen, awards candy.
  // Returns the new capture record, or null for an unknown solo id.
  async function grantSolo(soloId, opts) {
    if (!(global.Specials && global.Specials.isSolo(soloId))) return null;
    opts = opts || {};
    await _whenReady();
    const entry = {
      id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      spawnId: null,
      solo: soloId,
      speciesA: null,
      speciesB: null,
      variant: 'auto',
      shinyVariant: (typeof opts.shinyVariant === 'number' && opts.shinyVariant >= 0)
        ? opts.shinyVariant : null,
      level: (typeof opts.level === 'number' && opts.level > 0) ? opts.level : 5,
      sizeM: null,
      caughtAt: { timestamp: Date.now() },
    };
    const list = readCapturedCreatures();
    list.push(entry);
    writeCapturedCreatures(list);
    try { markSoloSeen(soloId, 'auto'); }
    catch (e) { _logCreatureError('grantSolo/markSoloSeen', e); }
    try { awardCandyForSolo(soloId, 2); }
    catch (e) { _logCreatureError('grantSolo/awardCandy', e); }
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
  // Re-entry-guarded wrapper. Two rapid taps on a ball button (or
  // taps on two different ball buttons before the .throwing CSS class
  // applies pointer-events:none) used to both reach this function on
  // the same event-loop tick — each consumed a ball AND each
  // eventually called recordCaptureFromSpawn(spawn), resulting in two
  // captures of the same spawn from a single ball-tap session. The
  // CSS gate doesn't help because clicks already dispatched in the
  // current tick aren't suppressed by a same-tick pointer-events
  // change. _throwInFlight is the synchronous gate that does.
  async function throwBall(ballKey, sourceBtn) {
    if (_throwInFlight) return;
    _throwInFlight = true;
    try {
      await _throwBallImpl(ballKey, sourceBtn);
    } finally {
      _throwInFlight = false;
    }
  }

  async function _throwBallImpl(ballKey, sourceBtn) {
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
      // y1 raised from 0.1 → 0.22 so the ball kicks off the hand a
      // touch faster at the start of the arc — no hang at the launch
      // moment. End of the curve is unchanged so the landing-into-
      // suck-in handoff still reads smooth.
      { duration: 650, easing: 'cubic-bezier(0.4, 0.22, 0.5, 1)', fill: 'forwards' });
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
    const rollShakes = () => {
      let n = 0;
      for (let i = 0; i < 3; i++) {
        if (Math.random() < rate) n++;
        else break;
      }
      return n;
    };
    let shakes, caught, wobbleMs = 380, pauseMs = 320;
    if (_guaranteedCatchOn()) {
      // Guaranteed-catch accessibility mode: same odds and same balls
      // (hidden re-rolls consume extras via consumeItem), slower
      // shakes so total time stays above the manual expectation —
      // just one physical throw. See _guaranteedThrowPlan.
      const plan = _guaranteedThrowPlan(rollShakes, () => consumeItem(ballKey, 1));
      shakes = plan.wobbles;
      caught = plan.caught;
      wobbleMs = plan.wobbleMs;
      pauseMs = plan.pauseMs;
    } else {
      shakes = rollShakes();
      caught = shakes === 3;
    }

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
        { duration: wobbleMs });
      await wobble.finished.catch(() => {});
      // Suspense pause — longer than the wobble itself. (Both this and
      // the wobble duration stretch in guaranteed-catch mode.)
      await delay(pauseMs);
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
      // fromCatch flips on .cc-post-catch so the Done button surfaces
      // for THIS specific entry into the detail view. Inventory taps
      // hit the same view but without the flag, so they don't get
      // the redundant footer.
      showDetail(entry.id, undefined, undefined, { fromCatch: true });
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
    const msg = (err && err.message) ? err.message : String(err);
    window._spriteDiag = window._spriteDiag || {};
    window._spriteDiag.errorCount = (window._spriteDiag.errorCount || 0) + 1;
    window._spriteDiag.errors = window._spriteDiag.errors || [];
    if (window._spriteDiag.errors.length < 10) {
      window._spriteDiag.errors.push(`${where}: ${msg}`);
    }
    // Also surface in the shared error ring that the Settings diagnostic
    // dump renders (defined in index.html's <head>). Best-effort.
    try {
      if (typeof window !== 'undefined' && window._ccLogError) {
        window._ccLogError('creatures:' + where, msg, err && err.stack);
      }
    } catch (_) {}
  }

  // Build the onReady callback that flips a marker from placeholder
  // to "ready" once its sprite decodes. Closes over the record so
  // stale callbacks (record removed before sprite arrived) bail out.
  function _markerOnReady(record) {
    return () => {
      if (!_markers.has(record.spawn.id) || _markers.get(record.spawn.id) !== record) return;
      record.marker.getElement().classList.add('creature-marker-ready');
      record.loaded = true;
      window._spriteDiag = window._spriteDiag || {};
      if (window._spriteDiag.firstSpriteVisibleAt == null) {
        window._spriteDiag.firstSpriteVisibleAt = performance.now();
      }
    };
  }

  function loadMarkerSprite(record) {
    if (!global.SpriteStore) return;
    const { spawn } = record;
    // Solo spawn (future stream): full-PNG art, no variant resolution.
    if (typeof spawn.solo === 'string' && spawn.solo) {
      record.variant = 'auto';
      const img = record.marker.getElement().querySelector('img.creature-sprite');
      if (!img) return;
      showCreatureArt(img, { solo: spawn.solo, shinyVariant: record.shinyVariant },
        { onReady: _markerOnReady(record) });
      return;
    }
    resolveSpawnVariant(spawn)
      .then((variant) => {
        record.variant = variant;
        if (!_markers.has(spawn.id) || _markers.get(spawn.id) !== record) return;
        const img = record.marker.getElement().querySelector('img.creature-sprite');
        if (!img) return;
        window._spriteDiag = window._spriteDiag || {};
        if (window._spriteDiag.firstSpriteInstallAt == null) {
          window._spriteDiag.firstSpriteInstallAt = performance.now();
        }
        // Marker reveal class lives on the OUTER .creature-marker div,
        // applied by _markerOnReady — we don't want SpriteStore touching
        // the img's class list.
        global.SpriteStore.showSprite(
          img, spawn.speciesA, spawn.speciesB, variant,
          { onReady: _markerOnReady(record) },
        );
      })
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
    const record = {
      marker, spawn, firstShownAt: Date.now(),
      // True once the marker's sprite has landed in the img and the
      // `creature-marker-ready` class has flipped on (revealing the
      // sprite, hiding the placeholder dot). Set by _markerOnReady,
      // which fires from SpriteStore.showSprite's onReady callback.
      // A marker stuck at false means SpriteStore resolved to a null
      // URL (no blob available); the cc:app-data-ready listener below
      // wakes those once the web build's sprite download lands.
      loaded: false,
    };
    // If this spawn's shininess was already decided before a refresh rebuilt
    // its marker, carry it onto the new record so every reader stays consistent.
    if (_shinyBySpawn.has(spawn.id)) record.shinyVariant = _shinyBySpawn.get(spawn.id);
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

  // Bulk add: place all markers in a single layout pass, then preload
  // every sprite via ONE batched SpriteStore.preload call. Preload opens
  // a single IDB transaction for the underlying blob reads and lazy-crops
  // the rest in parallel — on iOS Safari this turns ~50 individual
  // transactions into one pipelined one, so icons appear in a single
  // frame instead of staggering over seconds.
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
      if (!global.SpriteStore) {
        for (const { rec } of records) loadMarkerSprite(rec);
        return;
      }
      // Pre-batch the variant-count IDB reads into ONE transaction —
      // without this, 50 concurrent resolveSpawnVariant calls open 50
      // separate iOS IDB transactions (slow). With the summary blob
      // loaded this is all in-memory anyway; without it, this is one
      // pipelined read.
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
      records.forEach((r, i) => { r.rec.variant = variants[i]; });
      window._spriteDiag = window._spriteDiag || {};
      if (window._spriteDiag.firstSpriteInstallAt == null) {
        window._spriteDiag.firstSpriteInstallAt = performance.now();
      }
      // One batched IDB read seeds SpriteStore's cache for every marker;
      // the subsequent showSprite calls await per-entry Promises that
      // resolve from that single read.
      try {
        await global.SpriteStore.preload(
          records.map(({ spawn }, i) => ({
            a: spawn.speciesA, b: spawn.speciesB, variant: variants[i],
          }))
        );
      } catch (e) {
        _logCreatureError('addMarkersBatch/preload', e);
      }
      for (let i = 0; i < records.length; i++) {
        const { rec, spawn } = records[i];
        const img = rec.marker.getElement().querySelector('img.creature-sprite');
        if (!img) continue;
        global.SpriteStore.showSprite(
          img, spawn.speciesA, spawn.speciesB, variants[i],
          { onReady: _markerOnReady(rec) },
        );
      }
    } catch (e) {
      _logCreatureError('addMarkersBatch/outer', e);
    }
  }

  function removeMarker(id) {
    const rec = _markers.get(id);
    if (!rec) return;
    rec.marker.remove();
    // No URL to revoke — sprite URLs are owned by SpriteStore. The
    // img element going out of DOM releases its reference; SpriteStore
    // eventually evicts the URL via LRU, and revoking an evicted URL
    // is harmless to images that already decoded from it.
    _markers.delete(id);
  }

  function clearMarkers() {
    for (const id of Array.from(_markers.keys())) removeMarker(id);
  }

  function refreshSpawnOverlay() {
    if (!_overlayMap || !global.Spawns) return;
    // Radar ghosts live at fixed spawn locations (no GPS needed) — refresh
    // their countdowns / pruning every tick, before the GPS-gated spawn logic.
    refreshRadarMarkers();
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
    const _t0 = performance.now();
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
    if (global._ccStalls) {
      global._ccStalls.mark('spawn-refresh', performance.now() - _t0);
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

  // Single-watch architecture. The app runs exactly ONE OS-level
  // geolocation watch — MapLibre's GeolocateControl (the blue dot), in
  // index.html. This module used to open a *second*, independent
  // high-accuracy geolocation watch of its own right here. Two
  // simultaneous watches doubled the GPS radio churn and, over the iOS
  // Capacitor bridge, invited callback-starvation / throttling races
  // between the two consumers (surfaced while investigating "GPS being
  // weird on iOS"). Instead, index.html forwards every GeolocateControl
  // 'geolocate' fix into onLocationFix() below, so spawns + daycare
  // distance track the same stream that drives the dot.
  //
  // startLocationWatch just arms us to accept fixes and starts the
  // first-fix accuracy-gate clock; it no longer owns a watch. If the user
  // turns the GeolocateControl OFF, its watch stops and no fixes arrive —
  // spawns + daycare distance pause on the last position until tracking is
  // re-enabled. That's the intended "location off" state (and matches the
  // dot vanishing), not a regression.
  function startLocationWatch() {
    if (_geoListening) return;
    _geoListening = true;
    _firstFixDeadline = Date.now() + FIRST_FIX_TIMEOUT_MS;
  }

  // Consume one position fix pushed from index.html's GeolocateControl
  // 'geolocate' handler. Runs the former watch-success body: the first-fix
  // accuracy gate, coordinate update, daycare travel accumulation, and a
  // spawn-overlay refresh. No-ops unless we're attached + listening
  // (creature mode on), matching the old watch's attach/detach lifetime.
  function onLocationFix(pos) {
    if (!_geoListening || !pos || !pos.coords) return;
    const acc = pos.coords.accuracy;
    // Ignore an imprecise (network / cell-tower) first fix for a short
    // window so the initial spawn set isn't placed 50-200 m off and then
    // jumps once a real GPS fix lands. After the deadline we accept
    // whatever accuracy we have so low-signal users still see something.
    if (_userLat == null
        && acc != null
        && acc > FIRST_FIX_MIN_ACCURACY_M
        && Date.now() < _firstFixDeadline) {
      return;
    }
    _userLat = pos.coords.latitude;
    _userLng = pos.coords.longitude;
    // Accumulate trainer travel into today's daycare bucket.
    // pos.timestamp is preferred over Date.now() because it reflects
    // when the OS captured the fix (not when JS ran).
    _accumulateDaycareDistance(_userLat, _userLng, pos.timestamp || Date.now());
    refreshSpawnOverlay();
  }

  function stopLocationWatch() {
    // No OS watch to clear — index.html owns the single watch. Just stop
    // accepting fixes and forget our last position so a later re-attach
    // re-runs the first-fix accuracy gate cleanly.
    _geoListening = false;
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

  // ── Poké-radar: show the nearest evolved ("radar") spawns on the map ──────
  // The evolved-spawn stream (spawns.js) is folded into spawnsInBbox, so an
  // evolved spawn becomes a normal catchable marker once you're within
  // VISIBILITY_RADIUS_M. The radar is a DISCOVERY toggle: while ON it drops the
  // few nearest evolved spawns onto the map as black silhouettes ("blips") with
  // a live countdown above each, so you can navigate toward one. A radar-scope
  // bubble button (above the focus button) turns it off. State persists.
  const RADAR_ACTIVE_KEY = 'cc.radar.v1';
  const RADAR_AUTOGEN_LABEL_KEY = 'cc.radarAutogenLabels';  // Settings toggle, carried in the save file
  const RADAR_COUNT = 5;                 // how many nearest blips to show
  const RADAR_RESCAN_MS = 8000;          // throttle the nearest-set recompute
  const _radarMarkers = new Map();       // spawn.id -> { marker, el, spawn }
  let _radarActive = false;
  let _radarLastScanAt = 0;

  function fmtRemain(ms) {
    if (ms == null || ms <= 0) return 'gone';
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm';
    return '<1m';
  }

  // Settings → "Show autogen labels on radar" (persisted in the save file).
  // When on, a radar blip whose fusion has no custom art gets a small
  // "autogen" pill — the same signal the pokedex art grid uses — so a player
  // can tell at a glance whether a distant target is worth walking to.
  // Read live each call so the toggle can flip mid-session.
  function _radarAutogenLabelsOn() {
    try { return localStorage.getItem(RADAR_AUTOGEN_LABEL_KEY) === '1'; }
    catch { return false; }
  }
  // Pure gate: label a blip "autogen" only when the setting is on AND the
  // fusion has zero custom variants. Mirrors the pokedex, which treats a
  // 0 (or failed → 0) variant count as autogen. Kept tiny + pure so
  // tests/radar-autogen-label.test.js can pin the decision.
  function _radarShouldLabelAutogen(settingOn, variantCount) {
    return settingOn === true && variantCount === 0;
  }

  // Radar-scope bubble button — mirrors the daycare route bubble: joins the
  // bottom-right control cluster, reordered ABOVE the focus button. ALWAYS
  // visible; tapping it TOGGLES the radar on/off (accent-tinted while on).
  let _radarBubbleCtrl = null;
  class _RadarBubbleControl {
    onAdd(map) {
      this._map = map;
      const container = document.createElement('div');
      container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cc-radar-bubble-btn';
      btn.title = 'Toggle Poké-radar';
      btn.setAttribute('aria-label', 'Toggle Poké-radar');
      btn.style.cssText = 'display:flex;align-items:center;justify-content:center;'
        + 'background:transparent;border:none;cursor:pointer;width:29px;height:29px;padding:0;';
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor"'
        + ' stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>'
        + '<line x1="12" y1="12" x2="19" y2="6"/>'
        + '<circle cx="16.5" cy="8.5" r="1.15" fill="currentColor" stroke="none"/></svg>';
      btn.addEventListener('click', () => setRadarActive(!_radarActive));
      container.appendChild(btn);
      this._container = container;
      this._btn = btn;
      return container;
    }
    onRemove() {
      if (this._container && this._container.parentNode) this._container.parentNode.removeChild(this._container);
      this._map = null;
    }
  }
  function _ensureRadarBubble() {
    if (_radarBubbleCtrl) return _radarBubbleCtrl;
    if (!_installedMap) return null;
    _radarBubbleCtrl = new _RadarBubbleControl();
    _installedMap.addControl(_radarBubbleCtrl, 'bottom-right');
    // Reorder to the top of the bottom-right cluster so it sits above the
    // focus / geolocate buttons.
    try {
      const cluster = _installedMap.getContainer().querySelector('.maplibregl-ctrl-bottom-right');
      if (cluster && _radarBubbleCtrl._container && cluster.firstChild) {
        cluster.insertBefore(_radarBubbleCtrl._container, cluster.firstChild);
      }
    } catch (e) { /* best-effort */ }
    return _radarBubbleCtrl;
  }
  function _updateRadarBubble() {
    const ctrl = _ensureRadarBubble();
    if (ctrl && ctrl._btn) {
      ctrl._btn.style.color = _radarActive ? 'var(--ui-accent, #5b8cff)' : 'var(--ui-text, #444)';
    }
  }

  // Egg-ready bubble button — mirrors the radar / daycare route bubbles: joins
  // the bottom-right control cluster, reordered to the top. HIDDEN unless at
  // least one incubated egg has finished (eggReadyToHatch === true). Tapping it
  // hatches the ready egg and jumps straight to the new creature's detail page —
  // the one-tap "your egg hatched!" shortcut, so the user doesn't have to open
  // Eggs → incubator → "Tap to hatch". Accent-tinted since it only ever appears
  // when it's actionable (it's a call-to-action, not an always-on toggle).
  let _eggBubbleCtrl = null;
  let _eggBubbleTickWired = false;
  let _eggHatchInFlight = false;
  class _EggReadyBubbleControl {
    onAdd(map) {
      this._map = map;
      const container = document.createElement('div');
      container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      container.style.display = 'none';   // shown only while an egg is ready
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cc-egg-bubble-btn';
      btn.title = 'Hatch ready egg';
      btn.setAttribute('aria-label', 'Hatch ready egg');
      btn.style.cssText = 'display:flex;align-items:center;justify-content:center;'
        + 'background:transparent;border:none;cursor:pointer;width:29px;height:29px;padding:0;'
        + 'color:var(--ui-accent, #5b8cff);';
      // Egg outline with a small hatch-crack zigzag across the middle so the
      // glyph reads as "ready to hatch" rather than a plain egg.
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor"'
        + ' stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path d="M12 2.5c-4 0-6.6 6-6.6 10.5a6.6 6.6 0 0 0 13.2 0C18.6 8.5 16 2.5 12 2.5Z"/>'
        + '<path d="M9.3 11.3l1.7-1.2 1 1.8 1.7-1.2"/></svg>';
      btn.addEventListener('click', _hatchReadyEggFromMap);
      container.appendChild(btn);
      this._container = container;
      this._btn = btn;
      return container;
    }
    onRemove() {
      if (this._container && this._container.parentNode) this._container.parentNode.removeChild(this._container);
      this._map = null;
    }
  }
  function _ensureEggBubble() {
    if (_eggBubbleCtrl) return _eggBubbleCtrl;
    if (!_installedMap) return null;
    _eggBubbleCtrl = new _EggReadyBubbleControl();
    _installedMap.addControl(_eggBubbleCtrl, 'bottom-right');
    // Reorder to the top of the bottom-right cluster (above the radar / focus /
    // geolocate buttons) so the hatch CTA is the most prominent bubble.
    try {
      const cluster = _installedMap.getContainer().querySelector('.maplibregl-ctrl-bottom-right');
      if (cluster && _eggBubbleCtrl._container && cluster.firstChild) {
        cluster.insertBefore(_eggBubbleCtrl._container, cluster.firstChild);
      }
    } catch (e) { /* best-effort */ }
    return _eggBubbleCtrl;
  }
  // Pure predicate (kept tiny for tests/egg-ready-bubble.test.js): does any egg
  // in the list qualify as ready-to-hatch? This is exactly the bubble's
  // visibility rule, isolated from localStorage / the map so it can be pinned.
  function _anyEggReadyToHatch(eggs) {
    return Array.isArray(eggs) && eggs.some(eggReadyToHatch);
  }
  // Toggle the bubble's visibility from the current egg state. Cheap + safe to
  // call from any incubation / hatch path (no-op before the map installs).
  function _updateEggBubble() {
    const ctrl = _ensureEggBubble();
    if (!ctrl || !ctrl._container) return;
    let ready = false;
    try { ready = _anyEggReadyToHatch(readEggs()); } catch (e) { ready = false; }
    ctrl._container.style.display = ready ? '' : 'none';
  }
  // Bubble click: hatch the oldest ready egg and open the new creature. Mirrors
  // the eggs-view "Tap to hatch" flow (hatchEgg → showDetail) but from the map,
  // so it opens the inventory panel (show()) before pushing the detail view.
  async function _hatchReadyEggFromMap() {
    if (_eggHatchInFlight) return;
    const ready = readEggs().find(eggReadyToHatch);
    if (!ready) { _updateEggBubble(); return; }
    _eggHatchInFlight = true;
    let entry = null;
    try { entry = await hatchEgg(ready.id); }
    finally { _eggHatchInFlight = false; }
    _updateEggBubble();   // hatchEgg also refreshes; belt-and-suspenders
    if (!entry) return;
    show();
    try { showDetail(entry.id); } catch (e) { /* ignore */ }
  }

  function _radarMakeMarkerEl(sp) {
    // Always a black silhouette on the map (a "radar blip"); the real sprite
    // only appears once you're in range and the normal marker takes over.
    // Legendaries get a gold outline (radar-legendary) to stand out.
    const el = document.createElement('div');
    el.className = 'radar-marker silhouette' + (sp.legendary ? ' radar-legendary' : '');
    el.innerHTML = '<div class="radar-marker-label">' + fmtRemain(sp.expireMs - Date.now())
      + '</div><img class="radar-marker-img" alt="" draggable="false">';
    el.querySelector('.radar-marker-img').addEventListener('click', (e) => {
      e.stopPropagation();
      // If it's already a real in-range marker, open its catch screen.
      const real = _markers.get(sp.id);
      if (real) { openBattleScreen(real.spawn); return; }
      // In focus mode the view is locked to the player — don't recenter on the
      // blip (cc.focusFollow is kept in sync with the map's _focusActive).
      let focusOn = false;
      try { focusOn = localStorage.getItem('cc.focusFollow') === '1'; } catch (e2) { /* ignore */ }
      if (focusOn) return;
      if (_overlayMap) { try { _overlayMap.easeTo({ center: [sp.lng, sp.lat], duration: 600 }); } catch (_) { /* ignore */ } }
    });
    if (global.SpriteStore) {
      const img = el.querySelector('.radar-marker-img');
      // best-available sprite; the .silhouette filter blacks it out to a shape
      if (typeof sp.solo === 'string' && sp.solo) {
        showCreatureArt(img, { solo: sp.solo }, { onReady: () => el.classList.add('ready') });
      } else {
        global.SpriteStore.showSprite(img, sp.speciesA, sp.speciesB, undefined, {
          onReady: () => el.classList.add('ready'),
        });
      }
    }
    // "autogen" pill (Settings-gated): the variant count is O(1) once the
    // sprite summary has loaded, so resolve it async and drop the pill under
    // the countdown when the fusion has no hand-drawn art. Re-check the
    // setting inside .then() in case it flipped while the lookup was pending.
    // Solos have a single fixed art — never labelled.
    if (!(typeof sp.solo === 'string' && sp.solo)
        && _radarAutogenLabelsOn() && global.Sprites && global.Sprites.getCellVariantCount) {
      global.Sprites.getCellVariantCount(sp.speciesA, sp.speciesB)
        .catch(() => 0)
        .then((count) => {
          if (!_radarShouldLabelAutogen(_radarAutogenLabelsOn(), count)) return;
          if (el.querySelector('.radar-marker-autogen')) return;
          const pill = document.createElement('div');
          pill.className = 'radar-marker-autogen';
          pill.textContent = 'autogen';
          const img = el.querySelector('.radar-marker-img');
          el.insertBefore(pill, img);   // between the countdown pill and the silhouette
        });
    }
    return el;
  }
  function _radarEnsureMarker(sp) {
    if (!_overlayMap || !global.maplibregl) return null;
    let rec = _radarMarkers.get(sp.id);
    if (!rec) {
      const el = _radarMakeMarkerEl(sp);
      const marker = new global.maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([sp.lng, sp.lat]).addTo(_overlayMap);
      rec = { marker, el, spawn: sp };
      _radarMarkers.set(sp.id, rec);
    }
    return rec;
  }
  function _radarRemoveMarker(id) {
    const rec = _radarMarkers.get(id);
    if (rec) { try { rec.marker.remove(); } catch (e) { /* ignore */ } _radarMarkers.delete(id); }
  }
  function _radarClearMarkers() {
    for (const id of Array.from(_radarMarkers.keys())) _radarRemoveMarker(id);
  }

  // Reconcile radar blips to the current nearest set (while active): add the
  // nearest RADAR_COUNT alive & uncaught, drop the rest, refresh countdown
  // labels, and hide a blip while its real in-range marker is up. The nearest
  // recompute is throttled (RADAR_RESCAN_MS); countdown/visibility refresh every
  // call. `force` recomputes immediately (on activation).
  function refreshRadarMarkers(force) {
    if (!_overlayMap) return;
    if (!_radarActive || _userLat == null || _userLng == null
        || !global.Spawns || !global.Spawns.nearestRadar) {
      if (_radarMarkers.size) _radarClearMarkers();
      return;
    }
    const now = Date.now();
    const caught = (typeof readCaughtSpawnIds === 'function') ? readCaughtSpawnIds() : new Set();
    if (force || now - _radarLastScanAt > RADAR_RESCAN_MS) {
      _radarLastScanAt = now;
      const near = global.Spawns.nearestRadar(_userLat, _userLng, RADAR_COUNT);
      const desired = new Set();
      for (const sp of near) {
        if (caught.has(sp.id) || sp.expireMs <= now) continue;
        desired.add(sp.id);
        _radarEnsureMarker(sp);
      }
      for (const id of Array.from(_radarMarkers.keys())) {
        if (!desired.has(id)) _radarRemoveMarker(id);
      }
    }
    for (const pair of _radarMarkers) {
      const id = pair[0], rec = pair[1];
      const left = rec.spawn.expireMs - now;
      if (left <= 0 || caught.has(id)) { _radarRemoveMarker(id); continue; }
      const label = rec.el.querySelector('.radar-marker-label');
      if (label) label.textContent = fmtRemain(left);
      // Hide the blip while the real (in-range, catchable) marker is present.
      rec.el.style.display = _markers.has(id) ? 'none' : '';
    }
  }

  // Toggle the radar on/off (from the always-on map bubble button). No auto-zoom
  // — the blips just appear/disappear at their world positions.
  function setRadarActive(on) {
    _radarActive = !!on;
    try { localStorage.setItem(RADAR_ACTIVE_KEY, _radarActive ? '1' : '0'); } catch (e) { /* ignore */ }
    _updateRadarBubble();
    if (!_radarActive) _radarClearMarkers();
    else refreshRadarMarkers(true);
  }
  function _radarRestore() {
    try { _radarActive = localStorage.getItem(RADAR_ACTIVE_KEY) === '1'; } catch (e) { _radarActive = false; }
    _ensureRadarBubble();      // the toggle button is always on the map
    _updateRadarBubble();
    refreshRadarMarkers(true);
  }
  // Rebuild every live blip from scratch. Markers are cached + reused across
  // refreshes, so a setting that changes a blip's contents (the autogen label)
  // won't show on existing blips until they're recreated — the Settings toggle
  // calls this so the change is visible immediately while the radar is on.
  function rerenderRadarMarkers() {
    if (!_radarActive) return;
    _radarClearMarkers();
    refreshRadarMarkers(true);
  }

  function attachSpawnOverlay(map) {
    if (_overlayMap === map) return;
    _overlayMap = map;
    startLocationWatch();
    updateMarkerScale();
    _zoomHandler = updateMarkerScale;
    map.on('zoom', _zoomHandler);
    // Drives spawn appearance for a stationary user — GPS updates handle
    // the moving case, but standing still we need new births / expiries to
    // land promptly. Dedupe in refresh keeps this near-free when nothing
    // has changed (warm memoized scan + a no-op marker diff).
    _overlayTimer = setInterval(refreshSpawnOverlay, SPAWN_REFRESH_MS);
    _radarRestore();   // re-create a followed radar ghost after (re)attach
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

  // === Daycare path overlay ===
  // Renders the selected day's GPS path as a polyline on top of the
  // base map (one feature per session segment — segments split where
  // consecutive fixes are >60 s apart, so backgrounding gaps don't
  // get joined into long phantom lines). Activated from the Daycare
  // view's "Show on map" button. A small calendar bubble appears in
  // the bottom-right (above the refresh button) — tapping it removes
  // the overlay and the bubble itself.
  const DAYCARE_SOURCE_ID = 'cc-daycare-path';
  const DAYCARE_LAYER_ID = 'cc-daycare-path-line';
  // Anything longer than this is treated as a session break and
  // splits the polyline (don't draw a line connecting "where I left
  // off yesterday" to "where I opened the app this morning").
  const DAYCARE_PATH_BREAK_MS = 60000;
  // MapLibre IControl wrapper for the bubble — this joins the same
  // bottom-right cluster as the navigation / geolocate / creature-mode
  // controls (no fragile fixed-position math). After addControl we
  // reorder our DOM node to the top of the cluster so it sits ABOVE
  // the geolocate button, per the user's request.
  let _daycareBubbleCtrl = null;
  // What's currently overlaid on the map.
  //   null              — nothing
  //   { dayKey: 'YYYY-MM-DD' }  — one day's route
  //   { allDays: true } — every recorded day combined
  // Tracked module-side so the `style.load` hook (theme switches
  // reload the entire MapLibre style and drop every custom source/
  // layer) can re-add the polyline transparently.
  let _activeDaycareOverlay = null;

  class _DaycareBubbleControl {
    onAdd(map) {
      this._map = map;
      const container = document.createElement('div');
      container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      container.style.display = 'none';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cc-daycare-bubble-btn';
      btn.title = 'Hide route overlay';
      btn.setAttribute('aria-label', 'Hide route overlay');
      // Match the visual size of the other maplibregl-ctrl buttons
      // (29 × 29). The SVG is centered via flex so it lines up with
      // the navigation/geolocate icons in the same cluster.
      btn.style.cssText =
        'display: flex; align-items: center; justify-content: center;'
        + ' background: transparent; border: none; cursor: pointer;'
        + ' width: 29px; height: 29px; padding: 0;';
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"'
        + ' stroke="currentColor" stroke-width="2" fill="none"'
        + ' stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">'
        + '<rect x="3" y="5" width="18" height="16" rx="2"/>'
        + '<line x1="16" y1="2" x2="16" y2="6"/>'
        + '<line x1="8" y1="2" x2="8" y2="6"/>'
        + '<line x1="3" y1="10" x2="21" y2="10"/>'
        + '</svg>';
      btn.addEventListener('click', _clearDaycarePathOverlay);
      container.appendChild(btn);
      this._container = container;
      return container;
    }
    onRemove() {
      if (this._container && this._container.parentNode) {
        this._container.parentNode.removeChild(this._container);
      }
      this._map = null;
    }
  }

  function _ensureDaycareBubble() {
    if (_daycareBubbleCtrl) return _daycareBubbleCtrl;
    if (!_installedMap) return null;
    _daycareBubbleCtrl = new _DaycareBubbleControl();
    _installedMap.addControl(_daycareBubbleCtrl, 'bottom-right');
    // MapLibre appends new controls at the BOTTOM of the cluster
    // (visually closest to the corner). Move our element to the top
    // of the bottom-right cluster so it sits above the geolocate
    // (and nav) buttons. One-shot DOM reorder; subsequent show/hide
    // toggles only flip display so the position sticks.
    try {
      const cluster = _installedMap.getContainer()
        .querySelector('.maplibregl-ctrl-bottom-right');
      if (cluster && _daycareBubbleCtrl._container && cluster.firstChild) {
        cluster.insertBefore(_daycareBubbleCtrl._container, cluster.firstChild);
      }
    } catch { /* best-effort */ }
    return _daycareBubbleCtrl;
  }
  function _setDaycareBubbleVisible(visible) {
    const ctrl = _ensureDaycareBubble();
    if (ctrl && ctrl._container) {
      ctrl._container.style.display = visible ? '' : 'none';
    }
  }

  // Split a flat array of {lat,lng,t} fixes into per-session line
  // segments. Returns an array of [[lng,lat], ...] coordinate arrays,
  // with each segment requiring at least 2 points to be drawable.
  function _segmentDaycarePoints(points) {
    const segs = [];
    let cur = [];
    let lastT = 0;
    for (const p of points) {
      if (cur.length > 0 && (p.t - lastT) > DAYCARE_PATH_BREAK_MS) {
        if (cur.length >= 2) segs.push(cur);
        cur = [];
      }
      cur.push([p.lng, p.lat]);
      lastT = p.t;
    }
    if (cur.length >= 2) segs.push(cur);
    return segs;
  }

  // Pure layer/source side-effect: gather the requested paths, build
  // the FeatureCollection, and add (or update) it on the map. No
  // camera moves, no panel/bubble toggling — those live in the
  // `show…` wrappers. Returns the flat list of segment coord arrays
  // (each [[lng,lat], ...]) so callers can fit bounds, or null when
  // there's nothing to draw.
  // `opts`: { dayKey } for one day | { allDays: true } for everything.
  async function _renderDaycareLayer(opts) {
    if (!_installedMap || !global.maplibregl || !opts) return null;
    /** @type {Array<{ coords: number[][], day: string }>} */
    const features = [];
    if (opts.allDays) {
      const allPaths = await _idbGetAllPaths();
      // Today's in-memory path may not have been flushed yet — prefer
      // it when present so "all days" really does mean ALL days
      // including the one in progress.
      const today = _localDayKey();
      if (_currentPathDay === today && _currentPathLoaded
          && _currentPathPoints.length) {
        allPaths[today] = _currentPathPoints.slice();
      }
      for (const day of Object.keys(allPaths).sort()) {
        const segs = _segmentDaycarePoints(allPaths[day]);
        for (const coords of segs) features.push({ coords, day });
      }
    } else if (opts.dayKey) {
      const points = await getDaycarePath(opts.dayKey);
      for (const coords of _segmentDaycarePoints(points)) {
        features.push({ coords, day: opts.dayKey });
      }
    }
    if (!features.length) return null;
    const map = _installedMap;
    const fc = {
      type: 'FeatureCollection',
      features: features.map(({ coords, day }) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { day },
      })),
    };
    if (map.getSource(DAYCARE_SOURCE_ID)) {
      map.getSource(DAYCARE_SOURCE_ID).setData(fc);
    } else {
      map.addSource(DAYCARE_SOURCE_ID, { type: 'geojson', data: fc });
      map.addLayer({
        id: DAYCARE_LAYER_ID,
        type: 'line',
        source: DAYCARE_SOURCE_ID,
        paint: {
          'line-color': '#3b82f6',
          'line-width': 4,
          'line-opacity': 0.85,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
    }
    return features.map((f) => f.coords);
  }

  async function showDaycarePathOnMap(dayKey) {
    if (!_installedMap || !global.maplibregl) return;
    const day = dayKey || _localDayKey();
    const segs = await _renderDaycareLayer({ dayKey: day });
    if (!segs) {
      alert('No path recorded for this day.');
      return;
    }
    const bounds = new global.maplibregl.LngLatBounds();
    for (const seg of segs) for (const c of seg) bounds.extend(c);
    _installedMap.fitBounds(bounds, { padding: 60, duration: 600, maxZoom: 17 });
    _activeDaycareOverlay = { dayKey: day };
    hide();
    _setDaycareBubbleVisible(true);
  }

  async function showAllDaycarePathsOnMap() {
    if (!_installedMap || !global.maplibregl) return;
    const segs = await _renderDaycareLayer({ allDays: true });
    if (!segs) {
      alert('No paths recorded yet.');
      return;
    }
    const bounds = new global.maplibregl.LngLatBounds();
    for (const seg of segs) for (const c of seg) bounds.extend(c);
    _installedMap.fitBounds(bounds, { padding: 60, duration: 600, maxZoom: 17 });
    _activeDaycareOverlay = { allDays: true };
    hide();
    _setDaycareBubbleVisible(true);
  }

  function _clearDaycarePathOverlay() {
    _activeDaycareOverlay = null;
    if (_installedMap) {
      const map = _installedMap;
      if (map.getLayer(DAYCARE_LAYER_ID)) map.removeLayer(DAYCARE_LAYER_ID);
      if (map.getSource(DAYCARE_SOURCE_ID)) map.removeSource(DAYCARE_SOURCE_ID);
    }
    _setDaycareBubbleVisible(false);
  }

  function install(map) {
    injectStyles();
    // Resume any incense still within its 30-min window from a previous
    // session (state lives in localStorage / the save file).
    _pushActiveIncenseToSpawns();
    // These read the captured + seenFusions stores, which now load
    // asynchronously from IndexedDB. Defer them until hydration resolves
    // so they operate on the real collection, not the empty pre-load
    // cache. (Both are idempotent and re-run safely each boot.)
    _whenReady().then(() => {
      backfillSeenFromCaptures();
      // Backfills the `variant` field on legacy captures (and
      // seenFusions[key].variants). Idempotent via localStorage flag.
      migrateLegacyCaptureVariants().catch(() => {});
      // One-time: credit self-evolved shinies to their earlier lineage forms'
      // dex rows. Needs the evolution data, so chain off Species.ensureLoaded
      // (backfillShinyLineage re-checks readiness and only flips its flag once
      // it truly runs, so a failed evolutions fetch just retries next boot).
      if (global.Species && global.Species.ensureLoaded) {
        global.Species.ensureLoaded().then(() => {
          backfillShinyLineage();
          // Same lineage-walk infra: flag pre-existing evolved-away forms so
          // re-encounters show "Fresh" (see backfillCaughtAwayLineage).
          backfillCaughtAwayLineage();
        }).catch(() => {});
      }
    });
    // Warm the in-memory daycare summary cache + run the legacy
    // localStorage→IDB migration for the per-day distance map.
    _ensureSummaryLoaded().catch(() => {});
    // Pre-warm SPLIT_NAMES into memory so synchronous `getFusedName`
    // returns the proper canonical name on first paint. No-op when
    // the table isn't downloaded yet — display falls back to "A × B".
    if (global.Sprites && global.Sprites.ensureSplitNamesLoaded) {
      global.Sprites.ensureSplitNamesLoaded().catch(() => {});
    }
    // Eager-load the shiny palette bundle so the shiny transform path
    // through SpriteStore has its lookup table ready by the time any
    // capture renders. Also wire candyRootFor as the family resolver
    // so per-family shinies stay coherent across evolutions.
    if (global.ShinyStore) {
      global.ShinyStore.setRootResolver(candyRootFor);
      global.ShinyStore.load().catch((e) => {
        console.warn('shiny palettes failed to load', e);
      });
    }
    _installedMap = map;
    // Egg-ready hatch bubble: a one-tap shortcut in the bottom-right cluster
    // that appears whenever an incubated egg has finished. Evaluate once now
    // (an egg may already be ready from a previous session) and on every
    // incubation tick (crossing 5 km flips it on; hatching flips it off via
    // hatchEgg). Independent of creature mode — hatching should always be
    // reachable when an egg is ready.
    _updateEggBubble();
    if (typeof window !== 'undefined' && !_eggBubbleTickWired) {
      _eggBubbleTickWired = true;
      window.addEventListener('cc-incubator-tick', _updateEggBubble);
    }
    // Theme switches reload the entire MapLibre style, which drops
    // every custom source/layer (including the daycare path). When
    // an overlay is active, transparently re-add it after the new
    // style finishes loading so the user doesn't have to reopen the
    // calendar and tap "Show on map" again.
    map.on('style.load', () => {
      if (_activeDaycareOverlay) {
        _renderDaycareLayer(_activeDaycareOverlay).catch(() => {});
      }
    });
    // App-data download (web build) lands fresh sprite blobs in IDB.
    // Any markers that resolved to a null URL earlier (because IDB was
    // empty) are now waking up: clear SpriteStore's cache so the next
    // showSprite re-fetches against the now-populated IDB, then retry
    // every unloaded marker.
    //
    // Capacitor never fires this event (sprites are bundled), so this
    // is web-only by construction. With the new SpriteStore pattern
    // there's no `cc-sprite-loaded` / `cc-sprites-bulk-ready` wake-up
    // needed: every marker's bind awaits its URL Promise to settle,
    // and a settled-null Promise is the only state that requires
    // outside help — exactly the state this handler addresses.
    if (typeof window !== 'undefined') {
      window.addEventListener('cc:app-data-ready', () => {
        if (global.SpriteStore && global.SpriteStore.clearAll) {
          global.SpriteStore.clearAll();
        }
        for (const rec of _markers.values()) {
          if (rec.loaded) continue;
          loadMarkerSprite(rec);
        }
      });
    }
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
    // Settings "i" bubble → guaranteed-catch explainer popup (reuses the
    // generic info modal). Called from index.html's settings wiring.
    showSteadyCatchInfo: _showSteadyCatchInfo,
    // Settings → "Show autogen labels on radar": rebuild live blips so the
    // toggle takes effect immediately (see rerenderRadarMarkers).
    rerenderRadar: rerenderRadarMarkers,
    // Collection persistence now lives in IndexedDB (creature-collection-v1).
    // ready() resolves when the in-memory caches have hydrated + the
    // one-time localStorage→IDB migration has run. Export/import in
    // index.html await this, then read/write the collection through these
    // accessors instead of touching localStorage directly.
    ready: _whenReady,
    getAllCaptured: () => readCapturedCreatures(),
    replaceAllCaptured: (arr) => writeCapturedCreatures(arr),
    getSeenFusions: () => readSeenFusions(),
    setSeenFusions: (map) => { _seenStore.set(map); },
    mergeSeenFusions: (current, incoming) => mergeSeenFusions(current, incoming),
    // Active incense (carried in the save file so the 30-min window
    // survives device hops + app restarts).
    getActiveIncense: readActiveIncense,
    setActiveIncenseState,
    getCandy: readCandy, getBag: readBag, getTags: readTags,
    grantItem, consumeItem, rollCollectibleItem, getItemMeta,
    timeSinceLastSave,
    remarkAutogenCapturesWithCustomArt,  // temp: see fn comment
    // Daycare distance tracker.
    getDaycareTodayMeters,
    getDaycareDistances: readDaycareDistances,
    ensureDaycareLoaded: _ensureSummaryLoaded,
    getDaycarePath,
    exportDaycareData,
    importDaycareData,
    // Location bridge — single-watch architecture. index.html owns the
    // one OS-level geolocation watch (MapLibre's GeolocateControl) and
    // forwards each 'geolocate' fix here so spawns + daycare distance
    // track the same stream as the blue dot (no second watchPosition).
    onLocationFix,
    // Fitness bridge — page-side pedometer sync (iOS) calls these to
    // credit closed-app movement and to read the last-synced marker.
    creditPedometerMeters,
    readLastFitnessSync: _readLastFitnessSync,
    markFitnessSynced: _markFitnessSynced,
    // Daycare loot. claimDaycareLoot grants a single milestone;
    // claimAllDaycareLoot grants every outstanding milestone in
    // one shot (what the in-panel "···" indicator uses).
    // repopulateDaycareTestLoot is the Settings reset hook.
    claimDaycareLoot,
    claimAllDaycareLoot,
    repopulateDaycareTestLoot,
    // Eggs — read-only for v1 (the incubator + hatch flow lands
    // in a follow-up slice). addEgg is exposed for completeness so
    // future code (gifting, trade, debug populators) can drop eggs
    // into the collection without going through the daycare roll.
    getEggs: readEggs,
    addEgg,
    // Solo (special, non-fusion) creatures — dev/admin grant; the only
    // source of solos until spawn streams exist.
    grantSolo,
  };
})(typeof window !== 'undefined' ? window : globalThis);
