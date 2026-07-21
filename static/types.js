// Types: the single source of truth for Pokémon types and their
// interactions (the offensive effectiveness chart) — static/types.js.
//
// Before this module, the type list and chart were hardcoded in three
// places (spawns.js weather, creatures.js colors/craft, creatures.js
// filter list) plus two test mirrors. Now everything reads from
// global.Types. Pure data, no DOM — safe to require() under Node.
//
// ORDER IS LOAD-BEARING. spawns.js derives deterministic, worldwide
// seeds from this list's order (the daily/weekly weather rotation and
// the incense spawn stream's TYPES.indexOf salt). Never reorder the
// original 18; registered pack types are always APPENDED (see register)
// so existing seeds never change.
//
// Pack extension point: content packs call Types.register({...}) to add
// a custom type with its offensive row and (optionally) patches to the
// existing types' rows, so a pack type can be weak/resisted/immune in
// both directions. No backtick caution needed here — no CSS/HTML.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve (if tracked)
  if (global._scriptVersions) global._scriptVersions['types.js'] = SCRIPT_VERSION;

  // The original 18, Gen 6+ (includes Fairy), in the contractual order
  // spawns.js has always used. DO NOT REORDER (see header).
  const _ORDER = [
    'NORMAL', 'FIRE', 'WATER', 'GRASS', 'ELECTRIC', 'ICE',
    'FIGHTING', 'POISON', 'GROUND', 'FLYING', 'PSYCHIC', 'BUG',
    'ROCK', 'GHOST', 'DRAGON', 'DARK', 'STEEL', 'FAIRY',
  ];

  // Offensive chart per attacking type, Gen 6+:
  //   strong — defenders hit for 2×
  //   weak   — defenders hit for 0.5×
  //   immune — defenders hit for 0× (stored separately from weak; the
  //            craft/incense UI merges them, but the data keeps them apart)
  // Anything unlisted is neutral (1×). Colors are close-enough-to-canon
  // chip colors (migrated from the old creatures.js TYPE_COLORS).
  const _DEFS = {
    NORMAL:   { color: '#A8A77A', strong: [],                                        weak: ['ROCK', 'STEEL'],                                   immune: ['GHOST'] },
    FIRE:     { color: '#EE8130', strong: ['GRASS', 'ICE', 'BUG', 'STEEL'],          weak: ['FIRE', 'WATER', 'ROCK', 'DRAGON'],                 immune: [] },
    WATER:    { color: '#6390F0', strong: ['FIRE', 'GROUND', 'ROCK'],                weak: ['WATER', 'GRASS', 'DRAGON'],                        immune: [] },
    GRASS:    { color: '#7AC74C', strong: ['WATER', 'GROUND', 'ROCK'],               weak: ['FIRE', 'GRASS', 'POISON', 'FLYING', 'BUG', 'DRAGON', 'STEEL'], immune: [] },
    ELECTRIC: { color: '#F7D02C', strong: ['WATER', 'FLYING'],                       weak: ['ELECTRIC', 'GRASS', 'DRAGON'],                     immune: ['GROUND'] },
    ICE:      { color: '#96D9D6', strong: ['GRASS', 'GROUND', 'FLYING', 'DRAGON'],   weak: ['FIRE', 'WATER', 'ICE', 'STEEL'],                   immune: [] },
    FIGHTING: { color: '#C22E28', strong: ['NORMAL', 'ICE', 'ROCK', 'DARK', 'STEEL'], weak: ['POISON', 'FLYING', 'PSYCHIC', 'BUG', 'FAIRY'],    immune: ['GHOST'] },
    POISON:   { color: '#A33EA1', strong: ['GRASS', 'FAIRY'],                        weak: ['POISON', 'GROUND', 'ROCK', 'GHOST'],               immune: ['STEEL'] },
    GROUND:   { color: '#E2BF65', strong: ['FIRE', 'ELECTRIC', 'POISON', 'ROCK', 'STEEL'], weak: ['GRASS', 'BUG'],                              immune: ['FLYING'] },
    FLYING:   { color: '#A98FF3', strong: ['GRASS', 'FIGHTING', 'BUG'],              weak: ['ELECTRIC', 'ROCK', 'STEEL'],                       immune: [] },
    PSYCHIC:  { color: '#F95587', strong: ['FIGHTING', 'POISON'],                    weak: ['PSYCHIC', 'STEEL'],                                immune: ['DARK'] },
    BUG:      { color: '#A6B91A', strong: ['GRASS', 'PSYCHIC', 'DARK'],              weak: ['FIRE', 'FIGHTING', 'POISON', 'FLYING', 'GHOST', 'STEEL', 'FAIRY'], immune: [] },
    ROCK:     { color: '#B6A136', strong: ['FIRE', 'ICE', 'FLYING', 'BUG'],          weak: ['FIGHTING', 'GROUND', 'STEEL'],                     immune: [] },
    GHOST:    { color: '#735797', strong: ['PSYCHIC', 'GHOST'],                      weak: ['DARK'],                                            immune: ['NORMAL'] },
    DRAGON:   { color: '#6F35FC', strong: ['DRAGON'],                                weak: ['STEEL'],                                          immune: ['FAIRY'] },
    DARK:     { color: '#705746', strong: ['PSYCHIC', 'GHOST'],                      weak: ['FIGHTING', 'DARK', 'FAIRY'],                       immune: [] },
    STEEL:    { color: '#B7B7CE', strong: ['ICE', 'ROCK', 'FAIRY'],                  weak: ['FIRE', 'WATER', 'ELECTRIC', 'STEEL'],              immune: [] },
    FAIRY:    { color: '#D685AD', strong: ['FIGHTING', 'DRAGON', 'DARK'],            weak: ['FIRE', 'POISON', 'STEEL'],                         immune: [] },
  };

  // Live records: id -> { id, color, strong:Set, weak:Set, immune:Set }
  const _types = new Map();
  function _define(id, def) {
    _types.set(id, {
      id,
      color: def.color || '#888',
      strong: new Set(def.strong || []),
      weak: new Set(def.weak || []),
      immune: new Set(def.immune || []),
    });
  }
  for (const id of _ORDER) _define(id, _DEFS[id]);

  // ── queries ──

  function list() { return Array.from(_types.keys()); }
  function isValid(id) { return _types.has(id); }

  function color(id) {
    const t = _types.get(id);
    return t ? t.color : '#888';
  }

  // 'ELECTRIC' -> 'Electric'; future multiword ids ('SHADOW_MAGIC') ->
  // 'Shadow Magic'. Replaces the old _titleCaseType + inline copies.
  function displayName(id) {
    return String(id).toLowerCase().split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  // Offensive multiplier of attacking type `atk` against defender `def`.
  // Unknown attacker → 1 (neutral): callers treat pack-less unknown
  // types as harmless rather than hiding them (craft filter semantics).
  function multiplier(atk, def) {
    const t = _types.get(atk);
    if (!t) return 1;
    if (t.immune.has(def)) return 0;
    if (t.weak.has(def)) return 0.5;
    if (t.strong.has(def)) return 2;
    return 1;
  }
  function isSuperEffective(atk, def) { return multiplier(atk, def) === 2; }
  // "Reduced" = not-very-effective ∪ no-effect — the merged semantics the
  // craft filter has always used.
  function isReduced(atk, def) { const m = multiplier(atk, def); return m === 0 || m === 0.5; }

  // Offensive row of one attacking type (arrays of defenders).
  function attackRow(atk) {
    const t = _types.get(atk);
    if (!t) return { strong: [], weak: [], immune: [], reduced: [] };
    return {
      strong: Array.from(t.strong),
      weak: Array.from(t.weak),
      immune: Array.from(t.immune),
      reduced: Array.from(t.weak).concat(Array.from(t.immune)),
    };
  }

  // Inverse lookups: which attacking types hit `def` for 2× / 0.5× / 0×
  // (registry order).
  function _attackersWhere(def, key) {
    const out = [];
    for (const [id, t] of _types) { if (t[key].has(def)) out.push(id); }
    return out;
  }
  function strongAgainst(def) { return _attackersWhere(def, 'strong'); }
  function weakAgainst(def) { return _attackersWhere(def, 'weak'); }
  function immuneAgainst(def) { return _attackersWhere(def, 'immune'); }
  function reducedAgainst(def) { return weakAgainst(def).concat(immuneAgainst(def)); }

  // ── pack extension point ──
  // register({
  //   id: 'ELDRITCH', color: '#5E3A8C',
  //   strong: [...], weak: [...], immune: [...],          // offensive row
  //   defStrong: [...], defWeak: [...], defImmune: [...], // existing types
  //     that are 2× / 0.5× / 0× AGAINST the new type (patches their rows)
  // }) -> true on success, false on a duplicate/invalid id.
  // New types are appended after the original 18, so spawns seeds that
  // depend on the 18's order are untouched.
  function register(def) {
    if (!def || typeof def.id !== 'string') return false;
    const id = def.id.toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*$/.test(id) || _types.has(id)) return false;
    const known = (arr) => (Array.isArray(arr) ? arr.filter((t) => _types.has(t)) : []);
    _define(id, {
      color: typeof def.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(def.color) ? def.color : '#888',
      // The new type's own row may reference itself.
      strong: (Array.isArray(def.strong) ? def.strong : []).filter((t) => _types.has(t) || t === id),
      weak: (Array.isArray(def.weak) ? def.weak : []).filter((t) => _types.has(t) || t === id),
      immune: (Array.isArray(def.immune) ? def.immune : []).filter((t) => _types.has(t) || t === id),
    });
    // Defensive patches: existing type X listed in defStrong means
    // "X is super-effective against the new type" → add id to X's row.
    for (const t of known(def.defStrong)) _types.get(t).strong.add(id);
    for (const t of known(def.defWeak)) _types.get(t).weak.add(id);
    for (const t of known(def.defImmune)) _types.get(t).immune.add(id);
    return true;
  }

  global.Types = {
    list, isValid, color, displayName, multiplier,
    isSuperEffective, isReduced, attackRow,
    strongAgainst, weakAgainst, immuneAgainst, reducedAgainst,
    register,
  };

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
