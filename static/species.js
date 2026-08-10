// Species names + types lookup.
//   /creature-names -> JSON array (1-indexed: array[0] == "bulbasaur")
//   /creature-types -> JSON map "<idx>": [type1, type2|null]
// Both cached in localStorage so subsequent sessions don't re-fetch.
//
//   Species.ensureLoaded()        -> Promise (kicks off both fetches)
//   Species.nameFor(idx)          -> "Bulbasaur" or "#1" if not loaded
//   Species.typesFor(idx)         -> ["GRASS", "POISON"] or [] if not loaded
//   Species.fusionTypesFor(a, b)  -> primary from A, secondary from B
//                                   (Pokémon Infinite Fusion's rule); the
//                                   secondary collapses if it would equal
//                                   the primary, so a fusion of two
//                                   single-type same-type pokes shows as
//                                   one type.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve
  global._scriptVersions = global._scriptVersions || {};
  global._scriptVersions['species.js'] = SCRIPT_VERSION;

  // BundledData base URL — set by the inline <script> in index.html
  // (window.CC_BUNDLED_DATA_BASE). Defaults to the same-origin
  // /bundled-data Flask route when no override is in place.
  const BUNDLED_BASE = (global.CC_BUNDLED_DATA_BASE || '/bundled-data')
    .replace(/\/$/, '');

  // Species data is pack content (each pack serves its own
  // species-*.json), so the localStorage caches are namespaced per
  // pack — otherwise switching packs would keep serving the previous
  // pack's names/types/evolutions/pool. '' for the default pack (keys
  // stay exactly as before); '.<packId>' otherwise. Gen-variant packs
  // (IF2 subsets) get a further per-variant suffix: each variant serves
  // a different pool/evolutions set, so caching by pack id alone kept
  // serving the PREVIOUS variant's pool after a gen switch (wrong
  // spawn list, wrong completion counts). The raw selection values
  // suffice — the namespace only has to distinguish variants, not
  // match the pack's subdir string. Read straight from localStorage
  // because packs.js loads after this file.
  const _PACK_NS = (() => {
    try {
      const v = localStorage.getItem('cc.activePack');
      if (!v || v === 'creature-fusion') return _cvNs('creature-fusion');
      const g = localStorage.getItem('cc.packGens.' + v);
      const f = localStorage.getItem('cc.packGensFam.' + v);
      return '.' + v
        + (g ? '.' + g.replace(/[^0-9,]/g, '') : '')
        + (f === '1' ? 'f' : '')
        + _cvNs(v);
    } catch { return ''; }
    // Pack content updates (same pack, new contentVersion) replace the
    // served species-*.json, so the cache must version with the install
    // or it keeps serving the previous pack's names/types/evos/pool
    // (e.g. the 2026-08-10 pool expansion showed '#151' instead of Mew
    // from the stale cached names).
    function _cvNs(pid) {
      try {
        const raw = localStorage.getItem('cc.contentPack.' + pid + '.v1');
        const cv = raw ? (JSON.parse(raw).contentVersion || '') : '';
        return cv ? '.' + cv.replace(/[^0-9A-Za-z-]/g, '') : '';
      } catch { return ''; }
    }
  })();

  const NAMES_KEY = 'cc.speciesNames' + _PACK_NS;
  const TYPES_KEY = 'cc.speciesTypes' + _PACK_NS;
  const EVOS_KEY  = 'cc.speciesEvolutions' + _PACK_NS;
  const POOL_KEY  = 'cc.speciesPool' + _PACK_NS;
  let _names = null;
  let _types = null;
  let _evos = null;
  let _pool = null;
  let _loadPromise = null;

  try {
    const raw = localStorage.getItem(NAMES_KEY);
    if (raw) _names = JSON.parse(raw);
  } catch { /* corrupt entry — re-fetch */ }
  try {
    const raw = localStorage.getItem(TYPES_KEY);
    if (raw) _types = JSON.parse(raw);
  } catch { /* corrupt entry — re-fetch */ }
  try {
    const raw = localStorage.getItem(EVOS_KEY);
    if (raw) _evos = JSON.parse(raw);
  } catch { /* corrupt entry — re-fetch */ }
  try {
    const raw = localStorage.getItem(POOL_KEY);
    if (raw) _pool = JSON.parse(raw);
  } catch { /* corrupt entry — re-fetch */ }

  function ensureLoaded() {
    const namesNeeded = !(_names && _names.length);
    const typesNeeded = !(_types && Object.keys(_types).length);
    const evosNeeded  = !(_evos  && Object.keys(_evos).length);
    const poolNeeded  = !(_pool && Array.isArray(_pool.species) && _pool.species.length);
    if (!namesNeeded && !typesNeeded && !evosNeeded && !poolNeeded) return Promise.resolve();
    if (_loadPromise) return _loadPromise;
    _loadPromise = (async () => {
      // Explicit fetch helper that logs errors via console.error so
      // they reach the on-screen debug overlay (silent fall-back was
      // hiding real bundle/CORS failures during IPA debugging).
      async function _fetchJson(url, label) {
        try {
          const resp = await fetch(url);
          if (!resp.ok) {
            console.error(`Species ${label}: HTTP ${resp.status} ${url}`);
            return null;
          }
          return await resp.json();
        } catch (e) {
          console.error(`Species ${label} fetch threw: ${e && e.message ? e.message : e} (${url})`);
          return null;
        }
      }
      const tasks = [];
      if (namesNeeded) tasks.push((async () => {
        const list = await _fetchJson(`${BUNDLED_BASE}/species-names.json`, 'names');
        if (Array.isArray(list) && list.length) {
          _names = list;
          try { localStorage.setItem(NAMES_KEY, JSON.stringify(list)); } catch {}
        }
      })());
      if (typesNeeded) tasks.push((async () => {
        const map = await _fetchJson(`${BUNDLED_BASE}/species-types.json`, 'types');
        if (map && typeof map === 'object') {
          _types = map;
          try { localStorage.setItem(TYPES_KEY, JSON.stringify(map)); } catch {}
        }
      })());
      if (evosNeeded) tasks.push((async () => {
        const map = await _fetchJson(`${BUNDLED_BASE}/species-evolutions.json`, 'evolutions');
        if (map && typeof map === 'object') {
          _evos = map;
          try { localStorage.setItem(EVOS_KEY, JSON.stringify(map)); } catch {}
        }
      })());
      if (poolNeeded) tasks.push((async () => {
        // species-pool.json — which species/legendaries/spawnables the
        // active data set contains. Absent in older bundles: pool()
        // returns null and callers fall back to their hardcoded lists.
        const doc = await _fetchJson(`${BUNDLED_BASE}/species-pool.json`, 'pool');
        if (doc && Array.isArray(doc.species) && doc.species.length) {
          _pool = doc;
          try { localStorage.setItem(POOL_KEY, JSON.stringify(doc)); } catch {}
        }
      })());
      await Promise.all(tasks);
      _loadPromise = null;
    })();
    return _loadPromise;
  }

  // Title-case respecting spaces and hyphens: "ho-oh" -> "Ho-Oh",
  // "mr. mime" -> "Mr. Mime". Apostrophes and colons stay as-is so
  // "farfetch'd" / "type: null" come out right.
  function titleCase(s) {
    return s.replace(/(^|[\s-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
  }

  function nameFor(idx) {
    if (!_names) return `#${idx}`;
    const raw = _names[idx - 1];
    if (!raw) return `#${idx}`;
    return titleCase(raw);
  }

  function typesFor(idx) {
    if (!_types) return [];
    const t = _types[String(idx)];
    if (!t) return [];
    return t.filter((x) => x);
  }

  // Infinite Fusion: primary type from A, secondary type from B.
  // A few quirks:
  //   - if A has only one type, that's the primary (no fallback to A.type2).
  //   - the secondary uses B's secondary if present, else B's primary.
  //   - if the resulting secondary equals the primary, drop it.
  function fusionTypesFor(a, b) {
    const ta = typesFor(a);
    const tb = typesFor(b);
    if (!ta.length) return tb;  // missing data — show what we have
    if (!tb.length) return ta;
    const primary = ta[0];
    const secondary = tb[1] || tb[0];
    if (!secondary || secondary === primary) return [primary];
    return [primary, secondary];
  }

  // Forward evolutions for a single species. Each entry is
  //   { target: <idx>, method: <string>, param: <int|string> }
  function evolutionsFor(idx) {
    if (!_evos) return [];
    const raw = _evos[String(idx)];
    if (!Array.isArray(raw)) return [];
    return raw.map((e) => ({ target: e[0], method: e[1], param: e[2] }));
  }

  // Reverse index: which species evolves INTO me? Built lazily on first
  // call from the forward map. Cached for the lifetime of the page.
  let _reverseEvos = null;
  function getReverseEvos() {
    if (_reverseEvos) return _reverseEvos;
    if (!_evos) return null;
    const rev = Object.create(null);
    for (const src of Object.keys(_evos)) {
      const srcIdx = +src;
      for (const e of _evos[src]) {
        const tgt = String(e[0]);
        if (!rev[tgt]) rev[tgt] = [];
        rev[tgt].push(srcIdx);
      }
    }
    _reverseEvos = rev;
    return rev;
  }

  // Whole evolutionary family for a species: walk back to the root
  // (the earliest pre-evolution), then BFS forward from there. Returns
  // a flat list of indices in BFS order — branches like Eevee's eight
  // variants all appear at the same depth, just enumerated.
  function familyOf(idx) {
    if (!_evos) return [idx];
    const rev = getReverseEvos();
    if (!rev) return [idx];
    let cur = idx;
    const seen = new Set([cur]);
    while (true) {
      const pre = rev[String(cur)];
      if (!pre || !pre.length) break;
      const prev = pre[0];
      if (seen.has(prev)) break;
      seen.add(prev);
      cur = prev;
    }
    const root = cur;
    const family = [];
    const visited = new Set();
    const queue = [root];
    while (queue.length) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      family.push(id);
      for (const e of evolutionsFor(id)) queue.push(e.target);
    }
    return family;
  }

  // All next-step fusion evolutions for the pair (a, b). Either side
  // can evolve independently; we emit one entry per evolution path,
  // tagged with which side moved. Same shape as evolutionsFor entries
  // plus { newA, newB, source: 'A'|'B' }.
  function fusionEvolutionsFor(a, b) {
    const out = [];
    for (const e of evolutionsFor(a)) {
      out.push({ newA: e.target, newB: b, source: 'A',
                 method: e.method, param: e.param });
    }
    for (const e of evolutionsFor(b)) {
      out.push({ newA: a, newB: e.target, source: 'B',
                 method: e.method, param: e.param });
    }
    return out;
  }

  // Enumerate every loaded species as { id, name } in dex order.
  // Returns [] until the names list is populated. Used for autocomplete
  // datalists in pokédex search.
  function allSpecies() {
    if (!_names || !_names.length) return [];
    const out = [];
    for (let i = 0; i < _names.length; i++) {
      if (!_names[i]) continue;
      out.push({ id: i + 1, name: titleCase(_names[i]) });
    }
    return out;
  }

  // The active data set's species pool, or null when no
  // species-pool.json is available (older bundles / web static tree
  // from before the file existed). Callers fall back to their
  // hardcoded gen-1 lists in that case. Shape:
  //   { ids:Set, max:int, legendaries:Set, babies:Set, spawnable:[int],
  //     nonlegCount:int, has(id), isLegendary(id) }
  let _poolView = null;
  function pool() {
    if (!_pool) return null;
    if (_poolView) return _poolView;
    const ids = new Set(_pool.species || []);
    const legendaries = new Set(_pool.legendaries || []);
    let nonleg = 0;
    for (const id of ids) if (!legendaries.has(id)) nonleg++;
    _poolView = {
      ids,
      max: _pool.maxSpecies || Math.max(...ids),
      legendaries,
      babies: new Set(_pool.babies || []),
      spawnable: Array.isArray(_pool.spawnable) ? _pool.spawnable.slice() : [],
      nonlegCount: nonleg,
      has: (id) => ids.has(id),
      isLegendary: (id) => legendaries.has(id),
    };
    return _poolView;
  }

  global.Species = {
    nameFor, typesFor, fusionTypesFor,
    evolutionsFor, fusionEvolutionsFor, familyOf,
    allSpecies, pool,
    ensureLoaded,
  };
  // Intentionally no auto-fetch in web mode — ensureLoaded() is
  // invoked from the sprite bulk-download flow so network requests
  // only happen on an explicit user action. In the Capacitor IPA
  // there's no network involved (BUNDLED_BASE points at local
  // capacitor://localhost files), so kick the load off automatically
  // — the welcome card is bypassed and the user shouldn't have to
  // tap anything for bundled data to be ready.
  if (typeof global !== 'undefined' && global.Capacitor) {
    ensureLoaded().catch(() => {});
  }
})(typeof window !== 'undefined' ? window : globalThis);
