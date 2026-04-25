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

  const NAMES_KEY = 'cc.speciesNames';
  const TYPES_KEY = 'cc.speciesTypes';
  const EVOS_KEY  = 'cc.speciesEvolutions';
  let _names = null;
  let _types = null;
  let _evos = null;
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

  function ensureLoaded() {
    const namesNeeded = !(_names && _names.length);
    const typesNeeded = !(_types && Object.keys(_types).length);
    const evosNeeded  = !(_evos  && Object.keys(_evos).length);
    if (!namesNeeded && !typesNeeded && !evosNeeded) return Promise.resolve();
    if (_loadPromise) return _loadPromise;
    _loadPromise = (async () => {
      const tasks = [];
      if (namesNeeded) tasks.push((async () => {
        try {
          const resp = await fetch('/creature-names');
          if (!resp.ok) return;
          const list = await resp.json();
          if (Array.isArray(list) && list.length) {
            _names = list;
            try { localStorage.setItem(NAMES_KEY, JSON.stringify(list)); } catch {}
          }
        } catch { /* fall back to "#N" */ }
      })());
      if (typesNeeded) tasks.push((async () => {
        try {
          const resp = await fetch('/creature-types');
          if (!resp.ok) return;
          const map = await resp.json();
          if (map && typeof map === 'object') {
            _types = map;
            try { localStorage.setItem(TYPES_KEY, JSON.stringify(map)); } catch {}
          }
        } catch { /* types just won't render */ }
      })());
      if (evosNeeded) tasks.push((async () => {
        try {
          const resp = await fetch('/creature-evolutions');
          if (!resp.ok) return;
          const map = await resp.json();
          if (map && typeof map === 'object') {
            _evos = map;
            try { localStorage.setItem(EVOS_KEY, JSON.stringify(map)); } catch {}
          }
        } catch { /* evolutions just won't render */ }
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

  global.Species = {
    nameFor, typesFor, fusionTypesFor,
    evolutionsFor, fusionEvolutionsFor,
    ensureLoaded,
  };
  // Intentionally no auto-fetch. ensureLoaded() is invoked from the
  // sprite bulk-download flow so network requests only happen on an
  // explicit user action.
})(typeof window !== 'undefined' ? window : globalThis);
