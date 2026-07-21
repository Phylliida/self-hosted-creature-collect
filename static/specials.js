// Specials: the single source of truth for SOLO (non-fusion) creatures —
// static/specials.js.
//
// Every regular creature is a fusion of two species (speciesA ×
// speciesB). Specials are single-entity creatures outside the species
// registry entirely: no PIF id, no fusion sprite cell, no evolution
// family. The first is Missingno (category 'glitch'). Content packs add
// their own via Specials.register() — the same seam as Types.register.
//
// A special's art is a plain full-PNG under bundled-data/specials/
// (normalized to a centered 96×96 RGBA canvas by build-bundled-data.py's
// build_specials()) — NOT the (head, body) sheet/pack key space.
//
// Pure data, no DOM — safe to require() under Node.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve (if tracked)
  if (global._scriptVersions) global._scriptVersions['specials.js'] = SCRIPT_VERSION;

  const BUNDLED_BASE = (global.CC_BUNDLED_DATA_BASE || '/bundled-data')
    .replace(/\/$/, '');

  // Registry order = display order (dex Glitch section).
  const _DEFS = [
    {
      id: 'missingno',
      name: 'Missingno',
      category: 'glitch',
      types: ['NORMAL'],
      sprite: 'specials/missingno.png',
      blurb: 'A glitch pokémon. It was never supposed to exist — and yet.',
    },
  ];

  const _specials = new Map();  // id -> def
  const _order = [];
  function _define(def) {
    _specials.set(def.id, def);
    _order.push(def.id);
  }
  for (const d of _DEFS) _define(d);

  // ── queries ──

  function get(id) { return _specials.get(id) || null; }
  function isSolo(id) { return _specials.has(id); }
  function list() { return _order.map((id) => _specials.get(id)); }
  function byCategory(cat) { return list().filter((d) => d.category === cat); }

  function spriteUrl(id) {
    const d = _specials.get(id);
    return d ? `${BUNDLED_BASE}/${d.sprite}` : null;
  }

  // ── pack extension point ──
  // register({ id, name, category, types, sprite, blurb? }) -> bool.
  // ids are lowercase strings ('missingno'); types reference global.Types
  // ids (unknown ones are dropped). New specials are appended.
  function register(def) {
    if (!def || typeof def.id !== 'string' || typeof def.name !== 'string') return false;
    const id = def.id.toLowerCase();
    if (!/^[a-z][a-z0-9_-]*$/.test(id) || _specials.has(id)) return false;
    const types = (Array.isArray(def.types) ? def.types : [])
      .filter((t) => global.Types && global.Types.isValid(t));
    _define({
      id,
      name: def.name,
      category: typeof def.category === 'string' && def.category ? def.category : 'special',
      types,
      sprite: typeof def.sprite === 'string' ? def.sprite : '',
      blurb: typeof def.blurb === 'string' ? def.blurb : '',
    });
    return true;
  }

  global.Specials = { get, isSolo, list, byCategory, spriteUrl, register };

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
