// Deterministic, server-free spawn generator. Given (lat, lon, time),
// any two devices produce the same creatures at the same coordinates.
//
// Based on Richard Brent's xor4096 PRNG (http://arxiv.org/pdf/1104.3115.pdf),
// ported from an earlier project. Adaptations vs. the original:
//   - Time-bucketed seed (BUCKET_MS) so spawns rotate without a server.
//   - Bbox-driven cell iteration instead of a user-centered 11×11 scan,
//     so the map can paint spawns across the whole viewport.
//   - GPS/touch wrappers stripped — MapLibre owns those.
//
// Cell size is ~11 m (1/SCALE degrees of lat; longitude cells are
// narrower away from the equator, fine for v1). Density/species/level
// knobs live near the top — tune to taste.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve
  global._scriptVersions = global._scriptVersions || {};
  global._scriptVersions['spawns.js'] = SCRIPT_VERSION;

  // --- Brent xor4096 PRNG (verbatim) ---
  function XorGen(seed) {
    var me = this;
    me.next = function () {
      var w = me.w, X = me.X, i = me.i, t, v;
      me.w = w = (w + 0x61c88647) | 0;
      v = X[(i + 34) & 127];
      t = X[i = ((i + 1) & 127)];
      v ^= v << 13;
      t ^= t << 17;
      v ^= v >>> 15;
      t ^= t >>> 12;
      v = X[i] = v ^ t;
      me.i = i;
      return (v + (w ^ (w >>> 16))) | 0;
    };
    (function init(me, seed) {
      var t, v, i, j, w, X = [], limit = 128;
      if (seed === (seed | 0)) { v = seed; seed = null; }
      else { seed = seed + '\0'; v = 0; limit = Math.max(limit, seed.length); }
      for (i = 0, j = -32; j < limit; ++j) {
        if (seed) v ^= seed.charCodeAt((j + 32) % seed.length);
        if (j === 0) w = v;
        v ^= v << 10; v ^= v >>> 15; v ^= v << 4; v ^= v >>> 13;
        if (j >= 0) {
          w = (w + 0x61c88647) | 0;
          t = (X[j & 127] ^= (v + w));
          i = (0 == t) ? i + 1 : 0;
        }
      }
      if (i >= 128) X[(seed && seed.length || 0) & 127] = -1;
      i = 127;
      for (j = 4 * 128; j > 0; --j) {
        v = X[(i + 34) & 127];
        t = X[i = ((i + 1) & 127)];
        v ^= v << 13; t ^= t << 17;
        v ^= v >>> 15; t ^= t >>> 12;
        X[i] = v ^ t;
      }
      me.w = w; me.X = X; me.i = i;
    })(me, seed);
  }

  function getxor4069(seed) {
    if (seed == null) seed = +(new Date);
    var xg = new XorGen(seed);
    var prng = function () { return (xg.next() >>> 0) / ((1 << 30) * 4); };
    prng.int32 = xg.next;
    return prng;
  }

  // --- Spawn tuning constants ---
  // Spawning is a sliding window: each (cell, minute-tick) is an
  // independent deterministic slot. If the PRNG draw for that slot is
  // below SPAWN_CHANCE_PER_TICK, a creature is born at that tick and
  // lives LIFETIME_MS. A query at time t scans the LIFETIME_TICKS most
  // recent ticks per cell. The result: at any moment some spawns are
  // freshly born and others are about to expire — no synchronized mass
  // rollover the way fixed-bucket designs produce.
  const SCALE = 10000.0;                 // 1/SCALE deg ≈ 11 m at the equator
  const LAT_MOD = 5001;                  // prime wrap-around for hash
  const LON_MOD = 5503;
  const TICK_MS = 60 * 1000;             // birth-tick granularity (1 min)
  const LIFETIME_MS = 20 * 60 * 1000;    // each spawn lives 20 min
  const LIFETIME_TICKS = Math.ceil(LIFETIME_MS / TICK_MS);  // 20
  const DAY_SALT = 0x1F3B2C;             // bump to invalidate every seed
  // Probability a given (cell, tick) hosts a spawn. Visible-density
  // factor is pHit × LIFETIME_TICKS — the count of spawns active in a
  // cell at any moment averages this. Doubling lifetime + halving the
  // hit probability keeps this product constant, so walking density
  // is unchanged — but stationary players see new spawns appear half
  // as often, since each (cell, tick) roll is now half as likely to
  // hit.
  // Lineage:
  //   v1: 0.0032 × 5 ticks  = 0.016
  //   v2: 0.0016 × 10 ticks = 0.016 (halved stationary rate)
  //   v3: 0.0008 × 20 ticks = 0.016 (halved again — pulling the phone
  //       out and waiting for spawns is now ~25% as productive as v1
  //       per minute, while walking through fresh cells sees the
  //       same density of pokemon as it always has).
  const SPAWN_CHANCE_PER_TICK = 0.0008;
  const SPECIES_MAX = 150;               // v1 sprite download is sheets 1–150
  const MAX_CELLS = 40000;               // bail when zoomed out too far

  // Wild spawns are restricted to species at the root of their evolution
  // family (so the user has to evolve up to reach Charizard etc.) AND
  // exclude legendaries (those will get a separate mechanic).
  //
  // Architecture supports an asymmetric A vs B pool — the fusion's slot
  // A (head) can pull from up to 509 species since each downloaded
  // sheet contains all those slots, while slot B (body) is constrained
  // to the sheet numbers we downloaded.
  //
  // For now, both pools are restricted to gen 1 (1-150) so the bulk
  // download stays the manageable ~150 MB. To enable the wider A pool
  // (217 species across gens 1-4), swap SPAWNABLE_SPECIES_A for
  // SPAWNABLE_SPECIES_A_FULL below AND bump bulkDownload's indexTo to
  // 509 in static/index.html (three call sites).
  const SPAWNABLE_SPECIES_A = [
    // Gen 1 base forms (non-legendary, non-baby) — 74 species.
    1, 4, 7, 10, 13, 16, 19, 21, 23, 25, 27, 29, 32, 35, 37, 39, 41,
    43, 46, 48, 50, 52, 54, 56, 58, 60, 63, 66, 69, 72, 74, 77, 79,
    81, 83, 84, 86, 88, 90, 92, 95, 96, 98, 100, 102, 104, 106, 107,
    108, 109, 111, 113, 114, 115, 116, 118, 120, 122, 123, 124, 125,
    126, 127, 128, 129, 131, 132, 133, 137, 138, 140, 142, 143, 147,
    // Gen 2/3/4 type-coverage extras — 19 species. Picked to bring
    // every type to >=5 base-form representatives. IDs are PIF
    // internal — gen 3+ diverges from national dex (Mawile is PIF 300
    // not national 303, etc.). Keep in sync with
    // SUPPORTED_SPECIES_EXTRAS in creatures.js + species_pool.py.
    179,  // Mareep      (Electric)
    198,  // Murkrow     (Dark/Flying)
    200,  // Misdreavus  (Ghost)
    209,  // Snubbull    (Fairy)
    214,  // Heracross   (Bug/Fighting)
    215,  // Sneasel     (Dark/Ice)
    220,  // Swinub      (Ice/Ground)
    227,  // Skarmory    (Steel/Flying)
    228,  // Houndour    (Dark/Fire)
    291,  // Beldum      (Steel/Psychic)
    295,  // Spiritomb   (Ghost/Dark)
    297,  // Gible       (Dragon/Ground)
    300,  // Mawile      (Steel/Fairy)
    310,  // Absol       (Dark)
    311,  // Duskull     (Ghost)
    390,  // Aron        (Steel/Rock)
    395,  // Bagon       (Dragon)
    405,  // Shuppet     (Ghost)
    421,  // Sableye     (Dark/Ghost)
    427,  // Snorunt     (Ice)
    325,  // Nosepass    (Rock)
  ];
  const SPAWNABLE_SPECIES_B = SPAWNABLE_SPECIES_A;

  // Wild spawn pool: the active pack's species-pool.json wins (each
  // IF2 gen-subset pack ships its own spawnable list, computed at
  // build time); SPAWNABLE_SPECIES_A is the fallback for bundles that
  // predate the pool file. For the default pack the pool file carries
  // exactly SPAWNABLE_SPECIES_A, so behavior is unchanged.
  function _spawnPoolA() {
    const p = global.Species && global.Species.pool ? global.Species.pool() : null;
    return (p && p.spawnable && p.spawnable.length) ? p.spawnable : SPAWNABLE_SPECIES_A;
  }
  function _spawnPoolB() { return _spawnPoolA(); }
  // Drop-in replacement for SPAWNABLE_SPECIES_A when expanding to the
  // full gen 1-4 head range (requires bulkDownload indexTo: 509).
  // eslint-disable-next-line no-unused-vars
  const SPAWNABLE_SPECIES_A_FULL = [
    1, 4, 7, 10, 13, 16, 19, 21, 23, 27, 29, 32, 37, 41, 43, 46, 48,
    50, 52, 54, 56, 58, 60, 63, 66, 69, 72, 74, 77, 79, 81, 83, 84, 86,
    88, 90, 92, 95, 96, 98, 100, 102, 104, 108, 109, 111, 114, 115,
    116, 118, 120, 123, 127, 128, 129, 131, 132, 133, 137, 138, 140,
    142, 147, 152, 155, 158, 161, 163, 165, 167, 170, 172, 173, 174,
    175, 177, 179, 187, 190, 191, 193, 194, 198, 200, 201, 203, 204,
    206, 207, 209, 211, 213, 214, 215, 216, 218, 220, 222, 223, 225,
    227, 228, 231, 234, 235, 236, 238, 239, 240, 241, 246, 252, 253,
    257, 258, 259, 260, 261, 276, 279, 282, 285, 290, 291, 294, 295,
    297, 300, 301, 303, 305, 307, 310, 311, 316, 319, 322, 325, 327,
    330, 358, 365, 370, 371, 373, 375, 382, 384, 385, 387, 388, 390,
    392, 394, 395, 397, 399, 400, 402, 403, 404, 405, 406, 408, 409,
    411, 412, 413, 414, 416, 417, 419, 420, 421, 422, 425, 427, 430,
    431, 432, 433, 434, 436, 438, 440, 442, 444, 450, 451, 453, 454,
    456, 457, 459, 461, 463, 469, 470, 471, 474, 476, 478, 479, 482,
    485, 488, 489, 491, 493, 495, 498, 499, 500, 501, 502, 504, 506,
  ];

  function goodMod(a, b) { return ((a % b) + b) % b; }
  function expDistr(avg, max, v) {
    return Math.min(max, Math.round(-Math.log(v || 1e-12) * avg));
  }

  function currentTick(nowMs) {
    return Math.floor((nowMs == null ? Date.now() : nowMs) / TICK_MS);
  }

  // --- Type weather ---
  // Daily type rotates every UTC day; weekly type rotates every UTC
  // week. Both are deterministic from the date (everyone sees the same
  // weather worldwide). Spawn species are sampled from a weighted pool
  // where species whose own types match the daily type get 35× the
  // weight, weekly type 25×, both stack (35×25 = 875×). Density stays
  // the same — only composition shifts.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEK_MS = 7 * DAY_MS;
  const DAILY_SALT = 0xA1D4;
  const WEEKLY_SALT = 0x7EE7;
  // The canonical type list + effectiveness chart now lives in ONE place:
  // static/types.js (global.Types). The list order is contractual —
  // daily/weekly weather rotation and the incense spawn stream seed from
  // TYPES.indexOf, so reordering the original 18 would reshuffle every
  // player's world. Registered pack types are appended (safe).
  const TYPES = global.Types.list();

  // ── Pack mode (GMS solo packs, e.g. Neopets) ──────────────────
  // When a pack is active, the SAME deterministic streams (cells,
  // ticks, positions, levels, sizes, birth offsets, legendary
  // candidates, the full RNG draw sequence) are preserved — only the
  // species lookup changes: pack monsters are SOLOS (record.solo)
  // drawn from the pack's pools. A pokémon-mode player and a pack-mode
  // player standing in the same cell in the same minute therefore see
  // different creatures at the SAME spot — that's the co-location
  // promise, and it falls out of not touching the seed stream at all.
  let _pack = null;  // { id, types, monsters: [{key, types, forms, genders}], rares: [...] } | null
  function setPack(def) {
    _pack = def || null;
    _byPrimary = null; _bySecondary = null;
    _cachedSampler = null; _cachedSamplerKey = null;
    _ctMemo.clear(); _ctMemoSampler = null; _ctMemoOldestTick = -1;
    _incMemo.clear(); _incMemoKey = null; _incMemoOldest = -1;
  }
  function getPack() { return _pack; }
  // Weather always rotates over the ACTIVE type list — the pokémon 18
  // in fusion mode, the pack's own types in pack mode. (Each mode is a
  // consistent world; the type ORDER contract of the original 18 is
  // untouched either way.)
  function _weatherTypes() { return _pack ? _pack.types : TYPES; }

  // Deterministic Fisher-Yates shuffle of TYPES seeded by `cycleIdx`.
  // Returns a fresh permutation per cycle so every cycle visits every
  // type exactly once. Same input → same permutation for all users.
  function shuffledTypesForCycle(cycleIdx) {
    const arr = _weatherTypes().slice();
    const rng = getxor4069((cycleIdx ^ WEEKLY_SALT) | 0);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function currentWeather(nowMs) {
    const now = nowMs == null ? Date.now() : nowMs;
    const types = _weatherTypes();
    const dayIdx = Math.floor(now / DAY_MS);
    const weekIdx = Math.floor(now / WEEK_MS);
    const dailyRng = getxor4069((dayIdx ^ DAILY_SALT) | 0);
    // Weekly type cycles through a deterministic shuffled permutation
    // of TYPES — every TYPES.length weeks we exhaust the list, then
    // re-shuffle (cycleIdx bumps, new permutation). Guarantees every
    // type comes up once per cycle without back-to-back-week
    // repetition skew that pure hashing produces.
    const cycleLen = types.length;
    const cycleIdx = Math.floor(weekIdx / cycleLen);
    const weekInCycle = goodMod(weekIdx, cycleLen);
    const weeklyPerm = shuffledTypesForCycle(cycleIdx);
    return {
      daily: types[Math.floor(dailyRng() * types.length)],
      weekly: weeklyPerm[weekInCycle],
    };
  }

  // ── Community day (weekly featured species) ─────────────────
  // Every OTHER week features one species; while a player's community-day
  // session is active, every wild/radar/incense spawn is a fusion with
  // that species in one slot (the legendary stream is exempt). Weeks
  // run Monday 00:00 → Sunday 24:00 in GMT-12 — i.e. the boundary is
  // Monday 12:00 UTC for every player worldwide, so the "anywhere on
  // earth" week has fully ended before the next featured species starts.
  // Even weekKeys are community weeks; odd weeks have no event (and grant
  // no passes). The featured species permutes through the whole wild pool
  // (SPAWNABLE_SPECIES_A: base forms, no legendaries), advancing one step
  // per COMMUNITY week (off weeks don't consume permutation slots), then
  // re-shuffles; re-shuffles are rejection-sampled so no species recurs
  // within COMMUNITY_NO_REPEAT_WEEKS appearances of its previous one
  // across a cycle boundary. All deterministic from the week index —
  // no server.
  const COMMUNITY_WEEK_ANCHOR_MS = (4 * 24 + 12) * 3600 * 1000;  // Mon 1970-01-05 12:00 UTC
  const COMMUNITY_NO_REPEAT_WEEKS = 26;   // 26 appearances ≈ 1 year at the biweekly cadence

  function communityWeekKey(nowMs) {
    const now = nowMs == null ? Date.now() : nowMs;
    return Math.floor((now - COMMUNITY_WEEK_ANCHOR_MS) / WEEK_MS);
  }

  const _communityPermCache = new Map();   // cycleIdx -> permutation array
  function _communityShuffle(cycleIdx, attempt) {
    const arr = _spawnPoolA().slice();
    const rng = getxor4069('community|cycle|' + cycleIdx + '|' + attempt);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }
  function _communityPermutation(cycleIdx) {
    if (_communityPermCache.has(cycleIdx)) return _communityPermCache.get(cycleIdx);
    const n = _spawnPoolA().length;
    const prev = cycleIdx > 0 ? _communityPermutation(cycleIdx - 1) : null;
    const prevPos = new Map();
    if (prev) prev.forEach((id, i) => prevPos.set(id, i));
    let perm = null;
    for (let attempt = 0; ; attempt++) {
      const cand = _communityShuffle(cycleIdx, attempt);
      if (!prev) { perm = cand; break; }
      // A species at old position q appeared (n - q) weeks before this
      // cycle starts; at new position p it appears p weeks after. The
      // gap is p + (n - q) weeks and must exceed the no-repeat window.
      let okAll = true;
      for (let p = 0; p < n && okAll; p++) {
        if (p + (n - prevPos.get(cand[p])) <= COMMUNITY_NO_REPEAT_WEEKS) okAll = false;
      }
      if (okAll) { perm = cand; break; }
    }
    _communityPermCache.set(cycleIdx, perm);
    return perm;
  }
  function communityDayInfo(nowMs) {
    const weekKey = communityWeekKey(nowMs);
    const n = _spawnPoolA().length;
    const weekEndMs = COMMUNITY_WEEK_ANCHOR_MS + (weekKey + 1) * WEEK_MS;
    // Odd weekKeys are off weeks — no featured species, no passes.
    if (goodMod(weekKey, 2) !== 0) return { weekKey, speciesId: null, weekEndMs };
    const idx = Math.floor(weekKey / 2);        // community-week ordinal
    const cycleIdx = Math.floor(idx / n);
    return {
      weekKey,
      speciesId: _communityPermutation(cycleIdx)[goodMod(idx, n)],
      weekEndMs,
    };
  }

  // ── Type-pair sampler ──
  // Replaces the older multiplicative-weight duplicate-pool design,
  // which produced extreme concentration when daily ≈ weekly on a
  // type that only one or two species carry (e.g. Dragon-day-Dragon-
  // week → ~100% Dratini). The new design splits species selection
  // into TWO independent draws:
  //
  //   1) Draw a (typeA, typeB) pair from a 9-bucket mixture (weights
  //      defined below). Most buckets pin one or both slots to the
  //      daily or weekly type; one bucket is fully uniform.
  //
  //   2) Once typeA + typeB are chosen, uniformly sample slot A from
  //      species with primary == typeA, and slot B from species with
  //      secondary == typeB (or primary if single-typed). Matches the
  //      fusion's actual type-inheritance rule: fusion.primary =
  //      slotA.primary, fusion.secondary = slotB.secondary || primary.
  //
  // The empty-pair drop step (a pair where either pool is empty) makes
  // types like FLYING (no FLYING-primary species in gen 1) cleanly
  // divert their weight to other pairs instead of producing dead rolls.

  // Cell A: byPrimary[t] = list of spawnable species whose primary == t.
  // Cell B: bySecondary[t] = list of spawnable species whose secondary
  // (or primary, if single-typed) == t. Built once when species data
  // is available; doesn't depend on weather.
  let _byPrimary = null;
  let _bySecondary = null;
  function _buildTypeIndices() {
    if (_byPrimary && _bySecondary) return true;
    if (_pack) {
      // Pack mode: pools come from the pack's monsters (solo entries,
      // keyed objects — the spawn record uses .key).
      const byPrimary = Object.create(null);
      const bySecondary = Object.create(null);
      for (const t of _pack.types) { byPrimary[t] = []; bySecondary[t] = []; }
      for (const m of _pack.monsters) {
        if (!m.types || !m.types.length) continue;
        byPrimary[m.types[0]].push(m);
        bySecondary[m.types[1] || m.types[0]].push(m);
      }
      _byPrimary = byPrimary;
      _bySecondary = bySecondary;
      return true;
    }
    const Species = global.Species;
    if (!Species || !Species.typesFor) return false;
    const probe = Species.typesFor(_spawnPoolA()[0]);
    if (!probe || !probe.length) return false;
    const byPrimary = Object.create(null);
    const bySecondary = Object.create(null);
    for (const t of TYPES) { byPrimary[t] = []; bySecondary[t] = []; }
    for (const sp of _spawnPoolA()) {
      const types = Species.typesFor(sp) || [];
      if (!types.length) continue;
      byPrimary[types[0]].push(sp);
    }
    for (const sp of _spawnPoolB()) {
      const types = Species.typesFor(sp) || [];
      if (!types.length) continue;
      bySecondary[types[1] || types[0]].push(sp);
    }
    _byPrimary = byPrimary;
    _bySecondary = bySecondary;
    return true;
  }

  // Bucket weights — see header comment for the full table. Sums to 1.
  // Daily is the stronger signal: 65% of spawns involve DAILY in at
  // least one slot, 45% involve WEEKLY.
  const BUCKET_W_DD = 0.15;   // 1: (DAILY, DAILY)
  const BUCKET_W_DW = 0.10;   // 2: (DAILY, WEEKLY)
  const BUCKET_W_WD = 0.10;   // 3: (WEEKLY, DAILY)
  const BUCKET_W_WW = 0.10;   // 4: (WEEKLY, WEEKLY)
  const BUCKET_W_DX = 0.15;   // 5: (DAILY, uniform over not-DAILY)
  const BUCKET_W_XD = 0.15;   // 6: (uniform over not-DAILY, DAILY)
  const BUCKET_W_WX = 0.075;  // 7: (WEEKLY, uniform over not-WEEKLY)
  const BUCKET_W_XW = 0.075;  // 8: (uniform over not-WEEKLY, WEEKLY)
  const BUCKET_W_UU = 0.10;   // 9: (uniform, uniform)

  // Build a cumulative (typeA, typeB) sampler from a pair of type→species
  // pools, weighted by the weather mixture (daily/weekly). Shared by the
  // normal stream and the evolved stream (which passes evolved-form pools and
  // its own birth-tick weather). Pairs whose either pool is empty are dropped
  // (so e.g. FLYING-day diverts cleanly instead of rolling species-less), then
  // the survivors are renormalized into a cumulative distribution for fast
  // binary-search sampling.
  function _composePairSampler(byPrimary, bySecondary, daily, weekly) {
    const types = _weatherTypes();
    const N = types.length;
    const otherD = N - 1;   // count of types other than DAILY
    const otherW = N - 1;   // count of types other than WEEKLY
    // Weight of one concrete (a, b) pair under the mixture. Each bucket either
    // pins exactly one pair (buckets 1-4) or spreads uniformly over a subset
    // (buckets 5-9); we sum the contributions. When daily == weekly the daily-
    // and weekly-anchored buckets collapse onto the same pair, which is fine —
    // that's exactly how "extra-strong same-type weather" should land.
    const weightOf = (a, b) => {
      let v = 0;
      if (a === daily  && b === daily)  v += BUCKET_W_DD;
      if (a === daily  && b === weekly) v += BUCKET_W_DW;
      if (a === weekly && b === daily)  v += BUCKET_W_WD;
      if (a === weekly && b === weekly) v += BUCKET_W_WW;
      if (a === daily  && b !== daily)  v += BUCKET_W_DX / otherD;
      if (a !== daily  && b === daily)  v += BUCKET_W_XD / otherD;
      if (a === weekly && b !== weekly) v += BUCKET_W_WX / otherW;
      if (a !== weekly && b === weekly) v += BUCKET_W_XW / otherW;
      v += BUCKET_W_UU / (N * N);
      return v;
    };
    const entries = [];
    let total = 0;
    for (const a of types) {
      if (!byPrimary[a] || !byPrimary[a].length) continue;
      for (const b of types) {
        if (!bySecondary[b] || !bySecondary[b].length) continue;
        const wv = weightOf(a, b);
        if (wv <= 0) continue;
        entries.push({ a, b, w: wv });
        total += wv;
      }
    }
    if (!entries.length || total <= 0) return null;
    let cum = 0;
    for (const e of entries) { cum += e.w / total; e.cum = cum; }
    // Floating-point drift guard: pin the last cum to exactly 1 so a PRNG draw
    // of 0.9999… can never fall past the end.
    entries[entries.length - 1].cum = 1;
    return { byPrimary, bySecondary, entries };
  }

  let _cachedSamplerKey = null;
  let _cachedSampler = null;
  function getTypePairSampler() {
    if (!_buildTypeIndices()) return null;
    const w = currentWeather();
    const key = `${w.daily}|${w.weekly}`;
    if (key === _cachedSamplerKey && _cachedSampler) return _cachedSampler;
    const sampler = _composePairSampler(_byPrimary, _bySecondary, w.daily, w.weekly);
    if (!sampler) return null;
    _cachedSamplerKey = key;
    _cachedSampler = sampler;
    return sampler;
  }

  // Realized type composition of live spawns under the current weather,
  // for the weather-bar "what will I catch today?" explainer.
  //
  // Every spawn is a two-type fusion (primary = slot-A type, secondary =
  // slot-B type), so each spawn contributes two "type slots". We return
  // the fraction of all type slots that are the daily type, the weekly
  // type, and everything else — read straight off the actual pair
  // sampler, so empty pools (e.g. FLYING has no primary species in the
  // gen-1 set) are already baked in. That makes these the true odds for
  // *this* day's weather, not the nominal bucket weights.
  //
  // perType is the full realized per-slot marginal (every type → its
  // share, summing to 1). `same` flags daily === weekly (one type is
  // boosted on both channels); otherShare then excludes it only once.
  // Returns null until species data is loaded.
  function typeOdds(nowMs) {
    if (!_buildTypeIndices()) return null;
    const w = currentWeather(nowMs);
    const sampler = _composePairSampler(_byPrimary, _bySecondary, w.daily, w.weekly);
    if (!sampler) return null;
    const perType = Object.create(null);
    for (const t of _weatherTypes()) perType[t] = 0;
    let total = 0;
    for (const e of sampler.entries) {
      perType[e.a] += e.w;   // primary slot
      perType[e.b] += e.w;   // secondary slot
      total += e.w;
    }
    const denom = 2 * total;   // two type-slots per spawn
    if (denom > 0) for (const t of _weatherTypes()) perType[t] /= denom;
    const same = w.daily === w.weekly;
    const dailyShare = perType[w.daily] || 0;
    const weeklyShare = perType[w.weekly] || 0;
    const otherShare = Math.max(0, 1 - dailyShare - (same ? 0 : weeklyShare));
    return { daily: w.daily, weekly: w.weekly, same, dailyShare, weeklyShare, otherShare, perType };
  }

  // Detailed *joint* odds over the two type-halves of a spawn. Where typeOdds
  // gives per-slot marginals, this gives the full breakdown the weather-bar
  // explainer's "detailed" diagram wants: the chance a spawn is
  // daily×daily, daily×weekly, weekly×daily, daily×other, other×daily,
  // weekly×weekly, weekly×other, other×weekly, or other×other — i.e. the 3×3
  // grid of {daily, weekly, other} for (primary, secondary). Read straight off
  // the live pair sampler so empty pools are honestly baked in (e.g. if a
  // boosted type has no primary species, its whole primary row realizes ~0).
  //
  // Each entry's primary/secondary type is classified daily/weekly/other and
  // its realized weight added to the matching grid cell, then normalized so the
  // whole grid sums to 1. On a same-weather day (daily === weekly) the daily and
  // weekly classes merge, so `classes` is ['daily','other'] and the grid is 2×2.
  // Returns { daily, weekly, same, classes, grid } where grid[rowClass][colClass]
  // is the joint probability. null until species data loads.
  function typePairOdds(nowMs) {
    if (!_buildTypeIndices()) return null;
    const w = currentWeather(nowMs);
    const sampler = _composePairSampler(_byPrimary, _bySecondary, w.daily, w.weekly);
    if (!sampler) return null;
    const same = w.daily === w.weekly;
    // daily checked first so on a same-weather day both boosted halves land in
    // the single 'daily' class rather than being double-counted.
    const classOf = (t) => (t === w.daily ? 'daily' : (t === w.weekly ? 'weekly' : 'other'));
    const classes = same ? ['daily', 'other'] : ['daily', 'weekly', 'other'];
    const grid = Object.create(null);
    for (const rc of classes) { grid[rc] = Object.create(null); for (const cc of classes) grid[rc][cc] = 0; }
    let total = 0;
    for (const e of sampler.entries) {
      grid[classOf(e.a)][classOf(e.b)] += e.w;
      total += e.w;
    }
    if (total > 0) for (const rc of classes) for (const cc of classes) grid[rc][cc] /= total;
    return { daily: w.daily, weekly: w.weekly, same, classes, grid };
  }

  // Sample one (a, b) type pair given a uniform [0,1) draw r.
  function _sampleTypePair(sampler, r) {
    const entries = sampler.entries;
    let lo = 0, hi = entries.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (entries[mid].cum < r) lo = mid + 1;
      else hi = mid;
    }
    return entries[lo];
  }

  // Per-tick PRNG seed for one cell. Mixes cell coordinates with the
  // tick (XOR'd with DAY_SALT so bumping the salt invalidates everything).
  function cellTickSeed(cellX, cellY, tick) {
    const curX = goodMod(cellX, LAT_MOD);
    const curY = goodMod(cellY, LON_MOD);
    return (Math.round(
      ((curX + 1) * LAT_MOD + (curY + 1) * LAT_MOD * LON_MOD) * 7477
    ) + ((tick ^ DAY_SALT) >>> 0) * 983) | 0;
  }

  // One slot's spawn (or null). cellX/cellY are integer cell indices;
  // tick is the integer minute-tick at which the spawn was born. The
  // ID format is `${cellX}:${cellY}:${tick}:0` — the trailing 0 leaves
  // room for >1 spawn per cell-tick in the future without changing
  // existing caught-spawn keys. nowMs is the query time (defaults to
  // the real now); it only affects the query-time community-day
  // override, never the underlying deterministic identity.
  function generateCellAtTick(cellX, cellY, tick, nowMs) {
    const arng = getxor4069(cellTickSeed(cellX, cellY, tick));
    if (arng() >= SPAWN_CHANCE_PER_TICK) return null;
    const fx = arng();
    const fy = arng();
    const lat = (cellX + fx) / SCALE - 90;
    const lng = (cellY + fy) / SCALE - 180;
    // Type-weather sampling: draw a (typeA, typeB) pair from the 9-
    // bucket mixture (see getTypePairSampler), then uniformly sample
    // each slot from species of the chosen type. Sampler is null when
    // types data isn't loaded — bail with no spawn so the user is
    // nudged to download data; creatures.js shows a banner.
    const sampler = getTypePairSampler();
    if (!sampler) return null;
    const pair = _sampleTypePair(sampler, arng());
    const poolA = sampler.byPrimary[pair.a];
    const poolB = sampler.bySecondary[pair.b];
    const speciesA = poolA[Math.floor(arng() * poolA.length)];
    const speciesB = poolB[Math.floor(arng() * poolB.length)];
    const level = expDistr(5, 50, arng()) + 1;
    const sizeM = 0.15 + arng() * 2.0;
    // Deterministic intra-tick birth offset (0..TICK_MS-1 ms) so spawns
    // smear evenly across the minute instead of all appearing on the
    // UTC minute boundary. Drawn LAST so adding it doesn't shift any
    // earlier PRNG outputs — species/lat/lng/level/sizeM for any given
    // (cell, tick) stay identical to the pre-offset version. The cost
    // is one extra tick of scan window (see firstTick below) so a
    // late-offset spawn from the oldest tick is still picked up in
    // its dying seconds.
    const bornOffset = Math.floor(arng() * TICK_MS);
    const startMs = tick * TICK_MS + bornOffset;
    // Variant draw — picks WHICH hand-drawn variant of (speciesA, speciesB)
    // to render. Drawn LAST so adding it leaves species/lat/lng/level/
    // sizeM/bornOffset stable for any (cell, tick). The seed is uniform
    // [0, 1); the actual variant index is computed at render time as
    // floor(variantSeed * count) where count is the per-cell custom-
    // variant count looked up from the IDB variant table. Decoupling
    // it from spawn-time means variant count never affects density (a
    // cell with 5 variants is no more likely to spawn than one with 1).
    const variantSeed = arng();
    if (_pack) {
      // Pack mode: the A draw's monster IS the spawn (a solo). The B
      // draw is consumed (keeping the RNG stream aligned with pair
      // mode — positions/level/size/birth all identical to what pair
      // mode produces here) but unused for identity; the solo's form
      // resolves downstream from variantSeed + its gender weights.
      return {
        id: `${cellX}:${cellY}:${tick}:0`,
        lat, lng, solo: speciesA.key, level, sizeM, variantSeed,
        startMs, expireMs: startMs + LIFETIME_MS,
      };
    }
    let outA = speciesA, outB = speciesB;
    const cd = _communityActiveAt(nowMs);
    if (cd) {
      // Community day: one slot is the week's featured species, the
      // other a uniform draw from the wild pool (no type-weather bias —
      // the weather-sampled species above are overridden). Draws are
      // appended AFTER every existing draw and only consumed in this
      // branch, so an inactive session leaves the stream bit-identical.
      const slotCoin = arng();
      const poolA = _spawnPoolA();
      const other = poolA[Math.floor(arng() * poolA.length)];
      outA = slotCoin < 0.5 ? cd.speciesId : other;
      outB = slotCoin < 0.5 ? other : cd.speciesId;
    }
    return {
      id: `${cellX}:${cellY}:${tick}:0`,
      lat, lng, speciesA: outA, speciesB: outB, level, sizeM, variantSeed,
      startMs, expireMs: startMs + LIFETIME_MS,
      // Featured-species id when this spawn is a community-day morph
      // (drives the battle badge + "From Community Day" tagging).
      community: cd ? cd.speciesId : undefined,
    };
  }

  // bbox is [west, south, east, north] (lng/lat MapLibre order).
  // ── generateCellAtTick memo ─────────────────────────────────
  // generateCellAtTick is a pure function of (cellX, cellY, tick) for
  // a fixed sampler (weather bucket + species data), but each call
  // pays a full xor4096 state init — a ~160-step seed loop plus a
  // 512-step mix loop and a 128-slot array allocation — just to
  // discover ~99.9% of cell-ticks host no spawn. refreshSpawnOverlay
  // rescans the same ~440 cells × 21 ticks every few seconds, which
  // measured 100-460ms per refresh on an iPhone ([main-thread stalls]
  // mark 'spawn-refresh'). Memoizing makes steady-state refreshes Map
  // hits; only tick rollover (once a minute) and newly-entered cells
  // compute fresh. Entries are pruned as their tick leaves the scan
  // window. The memo resets whenever the sampler object changes
  // (weather rotation, species data (re)load) because species
  // selection reads it; results computed while the sampler is missing
  // are never cached, so spawns still appear once data loads.
  let _ctMemo = new Map();          // "cx:cy:t" -> spawn object | null
  let _ctMemoSampler = null;        // sampler identity memo was built against
  let _ctMemoOldestTick = -1;       // ticks below this have been pruned
  const CT_MEMO_HARD_CAP = 120000;  // teleport / zoom-out safety valve

  // ── Legendary spawns (independent deterministic pull) ──────────
  // Legendaries are deliberately NOT in the normal type/weather pool
  // (which excludes them). They get their own parallel stream so they can
  // have a very different cadence — far rarer, and lingering for a day so
  // you can travel to one — without entangling the tuned normal-spawn
  // density or its tight 20-minute scan window.
  //
  // Same fine cell grid (so a legendary lands on a precise spot), but
  // coarse 6-hour birth ticks and a 1-day lifetime, so the scan walks only
  // LEG_LIFETIME_TICKS coarse ticks. A cheap hash pre-filter skips the
  // expensive PRNG seed for the ~99.9999% of cell-ticks with no legendary,
  // so this adds negligible work to spawnsInBbox.
  //
  // Rarity is density-matched to the normal pool: a legendary is ~1/
  // LEG_RARITY as likely to be standing in a given cell as a normal spawn,
  // so of the creatures you actually encounter ~1/LEG_RARITY are legendary
  // (a ~1/16000 chance of a legendary) — regardless of how the longer lifetime
  // inflates the raw standing count.
  const LEG_TICK_MS = 6 * 60 * 60 * 1000;        // legendary birth granularity: 6 h
  const LEG_LIFETIME_MS = 24 * 60 * 60 * 1000;   // legendaries linger ~1 day
  const LEG_LIFETIME_TICKS = Math.ceil(LEG_LIFETIME_MS / LEG_TICK_MS);  // 4
  const LEG_RARITY = 16000;                       // ~1 legendary per 16000 normal spawns (4× rarer, 2026-07-04)
  const LEG_CHANCE_PER_CELLTICK =
    (SPAWN_CHANCE_PER_TICK * LIFETIME_TICKS) / (LEG_RARITY * LEG_LIFETIME_TICKS);
  const LEG_MOD = Math.max(1, Math.round(1 / LEG_CHANCE_PER_CELLTICK));
  const LEG_SALT = 0x4C45470A;                    // distinct seed namespace
  // Gen 1 legendaries (PIF id == national dex in gen 1); all <= 429 so
  // they're inside the downloaded sprite range. Filtered against the loaded
  // species list at roll time in case data isn't fully present. The active
  // pack's species-pool.json overrides this list when present.
  const GEN1_LEGENDARY_IDS = [144, 145, 146, 150, 151];

  function currentLegTick(nowMs) {
    return Math.floor((nowMs == null ? Date.now() : nowMs) / LEG_TICK_MS);
  }
  // Morph-partner pool: every loaded species (includes evolutions and the
  // other legendaries). Cached; rebuilt when the loaded count changes.
  let _legAllCache = null;
  let _legAllLen = -1;
  function _legAllSpecies() {
    const Species = global.Species;
    if (!Species || !Species.allSpecies) return null;
    const list = Species.allSpecies();
    if (!list.length) return null;
    if (!_legAllCache || _legAllLen !== list.length) {
      _legAllCache = list.map((s) => s.id);
      _legAllLen = list.length;
    }
    return _legAllCache;
  }
  function _legLegendaries(allIds) {
    const have = new Set(allIds);
    const p = global.Species && global.Species.pool ? global.Species.pool() : null;
    const ids = p ? Array.from(p.legendaries) : GEN1_LEGENDARY_IDS;
    return ids.filter((id) => have.has(id));
  }
  function legCellTickSeed(cellX, cellY, ltick) {
    const curX = goodMod(cellX, LAT_MOD);
    const curY = goodMod(cellY, LON_MOD);
    return (Math.round(
      ((curX + 1) * LAT_MOD + (curY + 1) * LAT_MOD * LON_MOD) * 7477
    ) + ((ltick ^ LEG_SALT) >>> 0) * 983) | 0;
  }
  // Cheap deterministic pre-filter — same value for every player, so
  // legendaries are global + shared. Skips the xor4096 seed init for the
  // vast majority of cell-ticks that host no legendary.
  function _legCandidate(cellX, cellY, ltick) {
    const h = (Math.imul(cellX, 73856093) ^ Math.imul(cellY, 19349663)
      ^ Math.imul(ltick, 83492791) ^ LEG_SALT) >>> 0;
    return (h % LEG_MOD) === 0;
  }
  // Legendary position snapping (opt-in, app-injected). The engine itself
  // stays pure/deterministic; the host app registers a provider that maps a
  // rolled (lat, lng) to a real-world anchor ({ lat, lng, kind }) or null
  // when nothing suitable is nearby (the legendary is then hidden — keeps
  // players from being sent somewhere they shouldn't go). Results are
  // cached per spawn id; positions may differ between devices with
  // different downloaded map data, but spawn ids are unaffected.
  let _legSnapProvider = null;
  const _legSnapCache = new Map();
  const LEG_SNAP_CACHE_MAX = 256;
  function setLegendarySnapProvider(fn) {
    _legSnapProvider = fn || null;
    _legSnapCache.clear();
  }
  function _applyLegendarySnap(p) {
    if (!_legSnapProvider) return p;
    if (_legSnapCache.has(p.id)) {
      const c = _legSnapCache.get(p.id);
      return c ? Object.assign({}, p, { lat: c.lat, lng: c.lng, snappedTo: c.kind }) : null;
    }
    let target = null;
    try { target = _legSnapProvider(p.lat, p.lng); } catch (e) { target = null; }
    if (_legSnapCache.size >= LEG_SNAP_CACHE_MAX) {
      _legSnapCache.delete(_legSnapCache.keys().next().value);
    }
    _legSnapCache.set(p.id, target || null);
    return target ? Object.assign({}, p, { lat: target.lat, lng: target.lng, snappedTo: target.kind }) : null;
  }
  function generateLegendaryAtTick(cellX, cellY, ltick) {
    if (!_legCandidate(cellX, cellY, ltick)) return null;
    if (_pack) {
      // Pack mode: the pack's rare family takes the legendary slot
      // (same cadence, same spots — a Pant Devil stands exactly where
      // a Mewtwo would in fusion mode).
      if (!_pack.rares || !_pack.rares.length) return null;
      const arng = getxor4069(legCellTickSeed(cellX, cellY, ltick));
      const fx = arng();
      const fy = arng();
      const lat = (cellX + fx) / SCALE - 90;
      const lng = (cellY + fy) / SCALE - 180;
      const rare = _pack.rares[Math.floor(arng() * _pack.rares.length)];
      arng();   // partner draw consumed for stream alignment
      const level = expDistr(8, 50, arng()) + 5;
      const sizeM = 0.15 + arng() * 2.0;
      const bornOffset = Math.floor(arng() * LEG_TICK_MS);
      const startMs = ltick * LEG_TICK_MS + bornOffset;
      const variantSeed = arng();
      return {
        id: 'L:' + cellX + ':' + cellY + ':' + ltick + ':0',
        lat, lng, solo: rare.key,
        level, sizeM, variantSeed,
        startMs, expireMs: startMs + LEG_LIFETIME_MS,
        legendary: true,
      };
    }
    const all = _legAllSpecies();
    if (!all) return null;
    const legs = _legLegendaries(all);
    if (!legs.length) return null;
    const arng = getxor4069(legCellTickSeed(cellX, cellY, ltick));
    const fx = arng();
    const fy = arng();
    const lat = (cellX + fx) / SCALE - 90;
    const lng = (cellY + fy) / SCALE - 180;
    // Head = a gen-1 legendary (uniform); body = any loaded species
    // (uniform, including the other legendaries).
    const legendary = legs[Math.floor(arng() * legs.length)];
    const partner = all[Math.floor(arng() * all.length)];
    const level = expDistr(8, 50, arng()) + 5;   // legendaries skew a bit higher
    const sizeM = 0.15 + arng() * 2.0;
    const bornOffset = Math.floor(arng() * LEG_TICK_MS);
    const startMs = ltick * LEG_TICK_MS + bornOffset;
    const variantSeed = arng();
    return {
      // 'L:' namespace keeps legendary caught-IDs distinct from normal
      // spawn IDs and is recognized by isSpawnIdStale.
      id: 'L:' + cellX + ':' + cellY + ':' + ltick + ':0',
      lat, lng, speciesA: legendary, speciesB: partner,
      level, sizeM, variantSeed,
      startMs, expireMs: startMs + LEG_LIFETIME_MS,
      legendary: true,
    };
  }
  function legendariesInBbox(bbox, nowMs) {
    const [west, south, east, north] = bbox;
    const now = nowMs == null ? Date.now() : nowMs;
    const curLT = currentLegTick(now);
    const minLatCell = Math.floor((south + 90) * SCALE);
    const maxLatCell = Math.ceil((north + 90) * SCALE);
    const minLngCell = Math.floor((west + 180) * SCALE);
    const maxLngCell = Math.ceil((east + 180) * SCALE);
    if ((maxLatCell - minLatCell + 1) * (maxLngCell - minLngCell + 1) > MAX_CELLS) return [];
    const firstLT = curLT - LEG_LIFETIME_TICKS;
    const out = [];
    for (let cx = minLatCell; cx <= maxLatCell; cx++) {
      for (let cy = minLngCell; cy <= maxLngCell; cy++) {
        for (let lt = firstLT; lt <= curLT; lt++) {
          const p = generateLegendaryAtTick(cx, cy, lt);
          if (!p) continue;
          if (now < p.startMs || now >= p.expireMs) continue;
          const sp = _applyLegendarySnap(p);
          if (!sp) continue;
          if (sp.lat < south || sp.lat > north || sp.lng < west || sp.lng > east) continue;
          out.push(sp);
        }
      }
    }
    return out;
  }

  // ── Evolved spawns ("poké-radar" stream; independent deterministic pull) ──
  // A third parallel stream (same shape/machinery as legendaries) that seeds
  // fusions whose halves are EVOLVED forms of the normal wild pool — rarer than
  // normal (~1/EVO_RARITY of the creatures you encounter) and lingering half a
  // day so you can travel to one. Density is matched exactly like legendaries:
  // longer life is cancelled by a proportionally lower per-cell-tick chance so
  // the encounter ratio stays 1/EVO_RARITY regardless of lifetime.
  //
  // Sampling: pick a (typeA, typeB) pair from the SAME weather mixture as normal
  // spawns, but from the pools chosen for this spawn's shape — 65% both halves
  // evolved, else exactly one half evolved (the other a base wild form). An
  // evolved half is drawn uniformly across a base's whole forward-evolution set
  // (chain A→B→C ⇒ uniform over {B, C}). Seeded from (cell, tick) only — no
  // player/time — so evolved spawns are global + shared like legendaries.
  const EVO_TICK_MS = 3 * 60 * 60 * 1000;         // evolved birth granularity: 3 h
  const EVO_LIFETIME_MS = 5 * 60 * 60 * 1000;     // evolved linger up to ~5 h
  const EVO_LIFETIME_TICKS = Math.ceil(EVO_LIFETIME_MS / EVO_TICK_MS);  // 2
  const EVO_RARITY = 200;                          // ~1 evolved per 200 normal spawns
  // Use the TRUE lifetime/tick ratio (not the ceil'd EVO_LIFETIME_TICKS) so the
  // 1/EVO_RARITY encounter rate stays exact even when the lifetime isn't a whole
  // multiple of the tick (5 h life / 3 h tick → 1.667 generations overlap, not 2).
  // EVO_LIFETIME_TICKS is only the integer scan window.
  const EVO_CHANCE_PER_CELLTICK =
    (SPAWN_CHANCE_PER_TICK * LIFETIME_TICKS) / (EVO_RARITY * (EVO_LIFETIME_MS / EVO_TICK_MS));
  const EVO_MOD = Math.max(1, Math.round(1 / EVO_CHANCE_PER_CELLTICK));
  const EVO_SALT = 0x45564F0A;                     // 'EVO\n' — distinct seed namespace
  const EVO_BOTH_CHANCE = 0.65;                    // else exactly one half evolved

  function currentEvoTick(nowMs) {
    return Math.floor((nowMs == null ? Date.now() : nowMs) / EVO_TICK_MS);
  }

  // Evolved-form type indices: every forward-evolution descendant of a base
  // wild species (SPAWNABLE_SPECIES_A), filtered to loaded species, bucketed by
  // primary/secondary type exactly like the normal pools. Rebuilt when the
  // loaded species count changes.
  let _evoByPrimary = null, _evoBySecondary = null, _evoIdxLen = -1, _evoFlat = null;
  function _buildEvoIndices() {
    if (_evoByPrimary && _evoBySecondary) {
      const Species0 = global.Species;
      const all0 = Species0 && Species0.allSpecies ? Species0.allSpecies() : null;
      if (all0 && _evoIdxLen === all0.length) return true;
    }
    const Species = global.Species;
    if (!Species || !Species.typesFor || !Species.evolutionsFor || !Species.allSpecies) return false;
    const all = Species.allSpecies();
    if (!all.length) return false;
    const loaded = new Set(all.map((s) => s.id));
    const evoSet = new Set();
    for (const base of _spawnPoolA()) {
      const stack = [base];
      const seen = new Set([base]);
      while (stack.length) {
        const cur = stack.pop();
        for (const e of Species.evolutionsFor(cur)) {
          const t = e.target;
          if (seen.has(t)) continue;
          seen.add(t);
          if (loaded.has(t)) evoSet.add(t);   // a descendant == an evolved form
          stack.push(t);
        }
      }
    }
    const byPrimary = Object.create(null), bySecondary = Object.create(null);
    for (const t of TYPES) { byPrimary[t] = []; bySecondary[t] = []; }
    for (const sp of evoSet) {
      const types = Species.typesFor(sp) || [];
      if (!types.length) continue;
      byPrimary[types[0]].push(sp);
      bySecondary[types[1] || types[0]].push(sp);
    }
    _evoByPrimary = byPrimary;
    _evoBySecondary = bySecondary;
    // Flat list of every evolved species — used by the community-day
    // override for uniform (non-weather) partner draws. Set iteration
    // order is insertion order, so this is deterministic.
    _evoFlat = Array.from(evoSet);
    _evoIdxLen = all.length;
    return true;
  }

  // Cheap deterministic pre-filter (same value for every player), skipping the
  // xor4096 seed init for the vast majority of cell-ticks with no evolved spawn.
  function _evoCandidate(cellX, cellY, etick) {
    const h = (Math.imul(cellX, 73856093) ^ Math.imul(cellY, 19349663)
      ^ Math.imul(etick, 83492791) ^ EVO_SALT) >>> 0;
    return (h % EVO_MOD) === 0;
  }
  function evoCellTickSeed(cellX, cellY, etick) {
    const curX = goodMod(cellX, LAT_MOD);
    const curY = goodMod(cellY, LON_MOD);
    return (Math.round(
      ((curX + 1) * LAT_MOD + (curY + 1) * LAT_MOD * LON_MOD) * 7477
    ) + ((etick ^ EVO_SALT) >>> 0) * 983) | 0;
  }
  function generateEvolvedAtTick(cellX, cellY, etick, nowMs) {
    if (!_evoCandidate(cellX, cellY, etick)) return null;
    if (!_buildTypeIndices() || !_buildEvoIndices()) return null;
    const arng = getxor4069(evoCellTickSeed(cellX, cellY, etick));
    const fx = arng();
    const fy = arng();
    const lat = (cellX + fx) / SCALE - 90;
    const lng = (cellY + fy) / SCALE - 180;
    // Shape: 65% both halves evolved, else exactly one (a coin picks the side).
    const bothEvolved = arng() < EVO_BOTH_CHANCE;
    const aEvolved = bothEvolved || arng() < 0.5;
    const bEvolved = bothEvolved || !aEvolved;
    const poolA = aEvolved ? _evoByPrimary : _byPrimary;
    const poolB = bEvolved ? _evoBySecondary : _bySecondary;
    // Weather-weighted type pair, seeded from THIS tick's weather so a spawn's
    // species stay fixed across its whole 12 h life (not shifting when the
    // daily/weekly type rolls over mid-window).
    const w = currentWeather(etick * EVO_TICK_MS);
    const sampler = _composePairSampler(poolA, poolB, w.daily, w.weekly);
    if (!sampler) return null;
    const pair = _sampleTypePair(sampler, arng());
    const listA = sampler.byPrimary[pair.a];
    const listB = sampler.bySecondary[pair.b];
    const speciesA = listA[Math.floor(arng() * listA.length)];
    const speciesB = listB[Math.floor(arng() * listB.length)];
    const level = expDistr(7, 50, arng()) + 3;   // evolved skew higher than base forms
    const sizeM = 0.15 + arng() * 2.0;
    const bornOffset = Math.floor(arng() * EVO_TICK_MS);
    const startMs = etick * EVO_TICK_MS + bornOffset;
    const variantSeed = arng();
    let outA = speciesA, outB = speciesB;
    const cd = _communityActiveAt(nowMs);
    if (cd && _evoFlat.length) {
      // Community day: one slot is the featured species, the other a
      // uniform draw across ALL evolved forms (no weather bias). Same
      // append-only draw convention as generateCellAtTick.
      const slotCoin = arng();
      const other = _evoFlat[Math.floor(arng() * _evoFlat.length)];
      outA = slotCoin < 0.5 ? cd.speciesId : other;
      outB = slotCoin < 0.5 ? other : cd.speciesId;
    }
    return {
      // 'E:' namespace keeps evolved caught-IDs distinct and is recognized by
      // isSpawnIdStale (coarse evo-tick scale + 12 h window).
      id: 'E:' + cellX + ':' + cellY + ':' + etick + ':0',
      lat, lng, speciesA: outA, speciesB: outB, level, sizeM, variantSeed,
      startMs, expireMs: startMs + EVO_LIFETIME_MS,
      evolved: true,
      community: cd ? cd.speciesId : undefined,
    };
  }
  function evolvedInBbox(bbox, nowMs) {
    const [west, south, east, north] = bbox;
    const now = nowMs == null ? Date.now() : nowMs;
    const curET = currentEvoTick(now);
    const minLatCell = Math.floor((south + 90) * SCALE);
    const maxLatCell = Math.ceil((north + 90) * SCALE);
    const minLngCell = Math.floor((west + 180) * SCALE);
    const maxLngCell = Math.ceil((east + 180) * SCALE);
    if ((maxLatCell - minLatCell + 1) * (maxLngCell - minLngCell + 1) > MAX_CELLS) return [];
    const firstET = curET - EVO_LIFETIME_TICKS;
    const out = [];
    for (let cx = minLatCell; cx <= maxLatCell; cx++) {
      for (let cy = minLngCell; cy <= maxLngCell; cy++) {
        for (let et = firstET; et <= curET; et++) {
          const p = generateEvolvedAtTick(cx, cy, et, now);
          if (!p) continue;
          if (now < p.startMs || now >= p.expireMs) continue;
          if (p.lat < south || p.lat > north || p.lng < west || p.lng > east) continue;
          out.push(p);
        }
      }
    }
    return out;
  }

  // Nearest N alive evolved spawns to a point, sorted by distance — powers the
  // poké-radar UI. Expands the search box (doubling from ~1.1 km) until it has N
  // or hits maxRadiusM, then sorts by an equirectangular metric (accurate enough
  // at these scales). The cheap hash pre-filter keeps even a wide scan light.
  function nearestEvolved(lat, lng, n, maxRadiusM) {
    if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) return [];
    const want = n || 5;
    const maxR = maxRadiusM || 5000;
    const cosLat = Math.max(0.05, Math.cos(lat * Math.PI / 180));
    const now = Date.now();
    const curET = currentEvoTick(now);
    const firstET = curET - EVO_LIFETIME_TICKS;
    const found = new Map();
    let radiusM = 2000;   // first box almost always holds ≥N at evolved density (avoids re-expansion)
    while (true) {
      const latPad = radiusM / 111000;
      const lngPad = radiusM / (111000 * cosLat);
      const minLatCell = Math.floor((lat - latPad + 90) * SCALE);
      const maxLatCell = Math.ceil((lat + latPad + 90) * SCALE);
      const minLngCell = Math.floor((lng - lngPad + 180) * SCALE);
      const maxLngCell = Math.ceil((lng + lngPad + 180) * SCALE);
      for (let cx = minLatCell; cx <= maxLatCell; cx++) {
        for (let cy = minLngCell; cy <= maxLngCell; cy++) {
          for (let et = firstET; et <= curET; et++) {
            const p = generateEvolvedAtTick(cx, cy, et, now);
            if (!p) continue;
            if (now < p.startMs || now >= p.expireMs) continue;
            if (!found.has(p.id)) found.set(p.id, p);
          }
        }
      }
      if (found.size >= want || radiusM >= maxR) break;
      radiusM *= 2;
    }
    const arr = Array.from(found.values());
    const d2 = (p) => { const dy = p.lat - lat, dx = (p.lng - lng) * cosLat; return dy * dy + dx * dx; };
    arr.sort((a, b) => d2(a) - d2(b));
    return arr.slice(0, want);
  }

  // Nearest N alive radar targets — evolved spawns AND legendaries, merged and
  // sorted by distance. Same expanding-box search as nearestEvolved, scanning
  // both streams in each box; legendaries are ~20× rarer so usually none are
  // near, but when one is closer than the Nth evolved it takes a slot. Returned
  // spawn objects keep their own `evolved:true` / `legendary:true` flags so the
  // UI can style them differently (e.g. a gold outline for legendaries).
  function nearestRadar(lat, lng, n, maxRadiusM) {
    if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) return [];
    const want = n || 5;
    const maxR = maxRadiusM || 5000;
    const cosLat = Math.max(0.05, Math.cos(lat * Math.PI / 180));
    const now = Date.now();
    const curET = currentEvoTick(now), firstET = curET - EVO_LIFETIME_TICKS;
    const curLT = currentLegTick(now), firstLT = curLT - LEG_LIFETIME_TICKS;
    const found = new Map();
    let radiusM = 2000;
    while (true) {
      const latPad = radiusM / 111000;
      const lngPad = radiusM / (111000 * cosLat);
      const minLatCell = Math.floor((lat - latPad + 90) * SCALE);
      const maxLatCell = Math.ceil((lat + latPad + 90) * SCALE);
      const minLngCell = Math.floor((lng - lngPad + 180) * SCALE);
      const maxLngCell = Math.ceil((lng + lngPad + 180) * SCALE);
      for (let cx = minLatCell; cx <= maxLatCell; cx++) {
        for (let cy = minLngCell; cy <= maxLngCell; cy++) {
          for (let et = firstET; et <= curET; et++) {
            const p = generateEvolvedAtTick(cx, cy, et, now);
            if (p && now >= p.startMs && now < p.expireMs && !found.has(p.id)) found.set(p.id, p);
          }
          for (let lt = firstLT; lt <= curLT; lt++) {
            const p = generateLegendaryAtTick(cx, cy, lt);
            if (!p || now < p.startMs || now >= p.expireMs || found.has(p.id)) continue;
            const sp = _applyLegendarySnap(p);
            if (sp) found.set(sp.id, sp);
          }
        }
      }
      if (found.size >= want || radiusM >= maxR) break;
      radiusM *= 2;
    }
    const arr = Array.from(found.values());
    const d2 = (p) => { const dy = p.lat - lat, dx = (p.lng - lng) * cosLat; return dy * dy + dx * dx; };
    arr.sort((a, b) => d2(a) - d2(b));
    return arr.slice(0, want);
  }

  // ── Incense spawns (independent deterministic pull) ───────────
  // A second normal-density stream that runs ONLY while the player has an
  // incense active, layered on top of the regular spawns (so you see ~2×
  // the pokémon). Same separate-code-path approach as legendaries — the
  // base generateCellAtTick is untouched.
  //
  // Type rule: one slot is always the incense type; the other is 40%
  // any-uniform / 30% the weekly type / 30% the daily type. Then species
  // are sampled from the same type pools as normal. Seeded from (cell,
  // tick, incenseType) — NOT the player or activation time — so any two
  // players with the same incense type active see the same pokémon at the
  // same cells/ticks (for ticks both their 30-min windows cover).
  //
  // Active window: 30 minutes from activation. The full extra stream shows
  // up immediately on activation (it fills the normal 20-min alive window
  // at once, no ramp-up) and hard-cuts when the 30 minutes are up. State
  // lives in the save file (creatures.js) and is pushed here via
  // setActiveIncense so it survives app restarts.
  const INCENSE_DURATION_MS = 30 * 60 * 1000;   // 30 min active
  // Incense spawns at this fraction of the normal per-cell-tick rate —
  // 0.5 → half the regular density (so roughly +50% pokémon while active).
  const INCENSE_RATE_FACTOR = 0.5;
  const INCENSE_SALT = 0x12CE45EE;              // 'inCENSE' — distinct seed namespace
  let _activeIncense = null;                    // { type, startMs } | null
  function setActiveIncense(state) {
    const next = (state && typeof state.type === 'string'
      && typeof state.startMs === 'number') ? { type: state.type, startMs: state.startMs } : null;
    const key = next ? next.type + '|' + next.startMs : null;
    if (key !== _incMemoKey) { _incMemo.clear(); _incMemoKey = key; _incMemoOldest = -1; }
    _activeIncense = next;
  }
  function getActiveIncense() { return _activeIncense; }
  function incenseActiveAt(nowMs) {
    if (!_activeIncense) return null;
    const now = nowMs == null ? Date.now() : nowMs;
    if (now >= _activeIncense.startMs + INCENSE_DURATION_MS) return null;
    return _activeIncense;
  }

  function incenseCellTickSeed(cellX, cellY, tick, typeIdx) {
    const curX = goodMod(cellX, LAT_MOD);
    const curY = goodMod(cellY, LON_MOD);
    return (Math.round(
      ((curX + 1) * LAT_MOD + (curY + 1) * LAT_MOD * LON_MOD) * 7477
    ) + (((tick ^ INCENSE_SALT) >>> 0) + Math.imul(typeIdx + 1, 0x9E3779B1)) * 983) | 0;
  }
  function generateIncenseCellAtTick(cellX, cellY, tick, incenseType, nowMs) {
    if (!_buildTypeIndices()) return null;
    const typeIdx = _weatherTypes().indexOf(incenseType);
    if (typeIdx < 0) return null;   // incl. pokémon incense in pack mode (v1)
    const arng = getxor4069(incenseCellTickSeed(cellX, cellY, tick, typeIdx));
    if (arng() >= SPAWN_CHANCE_PER_TICK * INCENSE_RATE_FACTOR) return null;
    const fx = arng();
    const fy = arng();
    const lat = (cellX + fx) / SCALE - 90;
    const lng = (cellY + fy) / SCALE - 180;
    // The non-incense slot: 40% any-uniform, 30% weekly, 30% daily.
    const w = currentWeather(tick * TICK_MS);
    const types = _weatherTypes();
    const rt = arng();
    let otherType;
    if (rt < 0.40) otherType = types[Math.floor(arng() * types.length)];
    else if (rt < 0.70) otherType = w.weekly;
    else otherType = w.daily;
    // Place the incense type in whichever slot yields non-empty pools
    // (some types have no primary- or no secondary-form species). When
    // both placements work, a coin flip decides; when neither does (rare
    // awkward combo), drop the spawn — same "empty pair" handling as the
    // normal sampler.
    const byP = _byPrimary, byS = _bySecondary;
    const v1 = byP[incenseType].length > 0 && byS[otherType].length > 0; // [incense, other]
    const v2 = byP[otherType].length > 0 && byS[incenseType].length > 0; // [other, incense]
    const coin = arng();
    let typeA, typeB;
    if (v1 && v2) { if (coin < 0.5) { typeA = incenseType; typeB = otherType; } else { typeA = otherType; typeB = incenseType; } }
    else if (v1) { typeA = incenseType; typeB = otherType; }
    else if (v2) { typeA = otherType; typeB = incenseType; }
    else return null;
    const poolA = byP[typeA], poolB = byS[typeB];
    const speciesA = poolA[Math.floor(arng() * poolA.length)];
    const speciesB = poolB[Math.floor(arng() * poolB.length)];
    const level = expDistr(5, 50, arng()) + 1;
    const sizeM = 0.15 + arng() * 2.0;
    const bornOffset = Math.floor(arng() * TICK_MS);
    const startMs = tick * TICK_MS + bornOffset;
    const variantSeed = arng();
    if (_pack) {
      return {
        id: 'I:' + cellX + ':' + cellY + ':' + tick + ':' + typeIdx,
        lat, lng, solo: speciesA.key, level, sizeM, variantSeed,
        startMs, expireMs: startMs + LIFETIME_MS,
        incense: true, incenseType: incenseType,
      };
    }
    let outA = speciesA, outB = speciesB;
    const cd = _communityActiveAt(nowMs);
    if (cd) {
      // Community day + incense: one slot is the featured species, the
      // other a uniform draw from the incense-type pool (the 40/30/30
      // weather mixture above is overridden — its draws were consumed
      // but go unused, keeping this branch append-only). Placement
      // follows the same non-empty-pool rule as the normal path.
      const slotCoin = arng();
      const otherDraw = arng();
      const v1 = byS[incenseType].length > 0;   // featured in A, incense-typed partner in B
      const v2 = byP[incenseType].length > 0;   // partner in A, featured in B
      if (v1 && (slotCoin < 0.5 || !v2)) {
        outA = cd.speciesId;
        outB = byS[incenseType][Math.floor(otherDraw * byS[incenseType].length)];
      } else if (v2) {
        outA = byP[incenseType][Math.floor(otherDraw * byP[incenseType].length)];
        outB = cd.speciesId;
      } else {
        return null;   // no species carry the incense type at all
      }
    }
    return {
      // typeIdx in the trailing slot (where normal/legendary ids carry a
      // 0) keeps the tick at parts[3] for isSpawnIdStale while making the
      // id unique per incense type — so catching a Fire-incense spawn
      // doesn't shadow a Water-incense spawn at the same cell/tick.
      id: 'I:' + cellX + ':' + cellY + ':' + tick + ':' + typeIdx,
      lat, lng, speciesA: outA, speciesB: outB, level, sizeM, variantSeed,
      startMs, expireMs: startMs + LIFETIME_MS,
      incense: true, incenseType: incenseType,
      community: cd ? cd.speciesId : undefined,
    };
  }
  // Memo mirrors _ctMemo — incense generation is ~normal-density, so an
  // un-memoized rescan would double the per-refresh cost while active.
  let _incMemo = new Map();
  let _incMemoKey = null;        // "type|startMs" identity the memo was built for
  let _incMemoOldest = -1;
  function incenseSpawnsInBbox(bbox, nowMs) {
    const now = nowMs == null ? Date.now() : nowMs;
    const inc = incenseActiveAt(now);
    if (!inc) return [];
    if (!_buildTypeIndices()) return [];
    const [west, south, east, north] = bbox;
    const curTick = currentTick(now);
    const minLatCell = Math.floor((south + 90) * SCALE);
    const maxLatCell = Math.ceil((north + 90) * SCALE);
    const minLngCell = Math.floor((west + 180) * SCALE);
    const maxLngCell = Math.ceil((east + 180) * SCALE);
    if ((maxLatCell - minLatCell + 1) * (maxLngCell - minLngCell + 1) > MAX_CELLS) return [];
    // Fill the whole normal alive window the instant you activate (so the
    // extra spawns show up immediately, not after a 20-minute ramp), then
    // hard-cut when the 30-minute window ends (handled by incenseActiveAt).
    const firstTick = curTick - LIFETIME_TICKS;
    if (firstTick > _incMemoOldest) {
      for (const k of _incMemo.keys()) {
        if (+k.slice(k.lastIndexOf(':') + 1) < firstTick) _incMemo.delete(k);
      }
      _incMemoOldest = firstTick;
    }
    if (_incMemo.size > CT_MEMO_HARD_CAP) _incMemo.clear();
    const out = [];
    for (let cx = minLatCell; cx <= maxLatCell; cx++) {
      for (let cy = minLngCell; cy <= maxLngCell; cy++) {
        for (let t = firstTick; t <= curTick; t++) {
          const mk = cx + ':' + cy + ':' + t;
          let p;
          if (_incMemo.has(mk)) p = _incMemo.get(mk);
          else { p = generateIncenseCellAtTick(cx, cy, t, inc.type, now); _incMemo.set(mk, p); }
          if (!p) continue;
          if (now < p.startMs || now >= p.expireMs) continue;
          if (p.lat < south || p.lat > north || p.lng < west || p.lng > east) continue;
          out.push(p);
        }
      }
    }
    return out;
  }

  // ── Community day active session ────────────────────────────
  // Per-player state (unlike the shared deterministic streams): pushed
  // here from creatures.js via setCommunityDay, where it lives in the
  // save file. The override is QUERY-TIME: a spawn is a community morph
  // iff the session is active at the moment of the query, regardless of
  // when the spawn was born. So activating instantly transforms every
  // living spawn in place (positions/levels/sizes unchanged — the
  // override draws are appended last), expiring reverts everything at
  // the next refresh, and two players with active sessions at the same
  // moment still see identical spawns (same seeds, same featured
  // species). Catches pin species at catch time, so a caught morph
  // keeps its identity after the session ends. Changing the state
  // clears the wild/incense memos so ticks are regenerated against the
  // new session.
  let _communityDay = null;   // { speciesId, startMs, endMs } | null
  let _cdMemoKey = null;      // identity the memos were built against
  function setCommunityDay(state) {
    const next = (state && typeof state.speciesId === 'number'
      && typeof state.startMs === 'number' && typeof state.endMs === 'number'
      && state.endMs > state.startMs)
      ? { speciesId: state.speciesId, startMs: state.startMs, endMs: state.endMs } : null;
    const key = next ? next.speciesId + '|' + next.startMs + '|' + next.endMs : null;
    if (key !== _cdMemoKey) {
      _ctMemo.clear(); _ctMemoSampler = null; _ctMemoOldestTick = -1;
      _incMemo.clear(); _incMemoKey = null; _incMemoOldest = -1;
      _cdMemoKey = key;
    }
    _communityDay = next;
  }
  function getCommunityDay() { return _communityDay; }
  function _communityActiveAt(nowMs) {
    if (!_communityDay) return null;
    const now = nowMs == null ? Date.now() : nowMs;
    if (now >= _communityDay.startMs && now < _communityDay.endMs) return _communityDay;
    return null;
  }

  function spawnsInBbox(bbox, nowMs) {
    const [west, south, east, north] = bbox;
    const now = nowMs == null ? Date.now() : nowMs;
    const curTick = currentTick(now);

    const minLatCell = Math.floor((south + 90) * SCALE);
    const maxLatCell = Math.ceil((north + 90) * SCALE);
    const minLngCell = Math.floor((west + 180) * SCALE);
    const maxLngCell = Math.ceil((east + 180) * SCALE);

    const cellsX = maxLatCell - minLatCell + 1;
    const cellsY = maxLngCell - minLngCell + 1;
    if (cellsX * cellsY > MAX_CELLS) return [];

    // One extra tick of scan window (vs LIFETIME_TICKS + 1) covers the
    // intra-tick birth offset: a spawn born late in the oldest tick
    // can still be alive in its dying seconds when the offset pushes
    // birth toward the end of that minute.
    const firstTick = curTick - LIFETIME_TICKS;
    // Memo maintenance — see the block comment above _ctMemo.
    const sampler = getTypePairSampler();
    if (sampler !== _ctMemoSampler) {
      _ctMemo.clear();
      _ctMemoSampler = sampler;
      _ctMemoOldestTick = firstTick;
    } else if (firstTick > _ctMemoOldestTick) {
      for (const k of _ctMemo.keys()) {
        if (+k.slice(k.lastIndexOf(':') + 1) < firstTick) _ctMemo.delete(k);
      }
      _ctMemoOldestTick = firstTick;
    }
    if (_ctMemo.size > CT_MEMO_HARD_CAP) _ctMemo.clear();
    const out = [];
    for (let cx = minLatCell; cx <= maxLatCell; cx++) {
      for (let cy = minLngCell; cy <= maxLngCell; cy++) {
        for (let t = firstTick; t <= curTick; t++) {
          const key = cx + ':' + cy + ':' + t;
          let p;
          if (_ctMemo.has(key)) {
            p = _ctMemo.get(key);
          } else {
            p = generateCellAtTick(cx, cy, t, now);
            if (sampler) _ctMemo.set(key, p);
          }
          if (!p) continue;
          if (now < p.startMs || now >= p.expireMs) continue;
          if (p.lat < south || p.lat > north
              || p.lng < west || p.lng > east) continue;
          out.push(p);
        }
      }
    }
    // Fold in the independent legendary stream (rare; cheap hash-gated
    // scan over a few coarse ticks). Legendary spawn objects share the
    // normal shape, so the marker/encounter pipeline handles them as-is.
    const legs = legendariesInBbox(bbox, now);
    for (let i = 0; i < legs.length; i++) out.push(legs[i]);
    // Fold in the evolved stream (rare; same cheap hash-gated coarse-tick scan
    // as legendaries). Evolved spawn objects share the normal shape, so the
    // marker/encounter pipeline handles them as-is. Pack mode: pokémon-only
    // stream (neopets evolve via paintbrush items, not radar) — skipped.
    if (!_pack) {
      const evos = evolvedInBbox(bbox, now);
      for (let i = 0; i < evos.length; i++) out.push(evos[i]);
    }
    // Fold in the incense stream — only non-empty while an incense is
    // active. Normal density, so this is what doubles the spawn count.
    const inc = incenseSpawnsInBbox(bbox, now);
    for (let i = 0; i < inc.length; i++) out.push(inc[i]);
    return out;
  }

  // Caught-spawn IDs include the birth-tick. Once the tick is older
  // than the sliding window, the creature is gone and the ID just
  // bloats localStorage — return true so creatures.js can prune it.
  function isSpawnIdStale(id, nowMs) {
    if (typeof id !== 'string') return true;
    // Legendary IDs ('L:cx:cy:legtick:0') age out on the coarse leg-tick
    // scale + 1-day window, not the 20-minute normal window.
    if (id.startsWith('L:')) {
      const lparts = id.split(':');
      const ltick = +lparts[3];
      if (!Number.isFinite(ltick)) return true;
      return ltick < currentLegTick(nowMs) - LEG_LIFETIME_TICKS;
    }
    // Evolved IDs ('E:cx:cy:evotick:0') age out on the coarse evo-tick scale +
    // 12-hour window, like legendaries but on their own cadence.
    if (id.startsWith('E:')) {
      const eparts = id.split(':');
      const etick = +eparts[3];
      if (!Number.isFinite(etick)) return true;
      return etick < currentEvoTick(nowMs) - EVO_LIFETIME_TICKS;
    }
    // Incense IDs ('I:cx:cy:tick:0') ride the normal minute-tick scale +
    // 20-min window (the incense activation window is enforced separately
    // at generation time).
    if (id.startsWith('I:')) {
      const iparts = id.split(':');
      const itick = +iparts[3];
      if (!Number.isFinite(itick)) return true;
      return itick < currentTick(nowMs) - LIFETIME_TICKS;
    }
    const parts = id.split(':');
    if (parts.length < 3) return true;
    const tick = +parts[2];
    if (!Number.isFinite(tick)) return true;
    // -LIFETIME_TICKS (not +1) matches the spawn scan window — see
    // generateCellAtTick's intra-tick birth offset.
    return tick < currentTick(nowMs) - LIFETIME_TICKS;
  }

  global.Spawns = {
    spawnsInBbox, generateCellAtTick, currentTick, isSpawnIdStale,
    currentWeather, typeOdds, typePairOdds,
    // Legendary stream (folded into spawnsInBbox; exposed for tests +
    // any future legendary-specific UI).
    legendariesInBbox, generateLegendaryAtTick, currentLegTick,
    LEG_TICK_MS, LEG_LIFETIME_MS,
    // Optional app-injected legendary position snap (road/POI anchoring);
    // null (default) keeps raw rolled positions.
    setLegendarySnapProvider,
    // Evolved ("poké-radar") stream — folded into spawnsInBbox; exposed for
    // tests + the future poké-radar detection UI.
    evolvedInBbox, generateEvolvedAtTick, currentEvoTick, nearestEvolved, nearestRadar,
    EVO_TICK_MS, EVO_LIFETIME_MS, EVO_RARITY,
    // Incense stream — creatures.js sets the active state (from the save
    // file); spawnsInBbox folds it in while active.
    setActiveIncense, getActiveIncense, incenseSpawnsInBbox,
    generateIncenseCellAtTick, INCENSE_DURATION_MS,
    // Community day — weekly featured-species schedule (deterministic)
    // plus the per-player active session pushed from creatures.js.
    communityDayInfo, communityWeekKey, setCommunityDay, getCommunityDay,
    SPAWNABLE_SPECIES_A,   // community-day pool; exposed for tests
    // Exposed so other deterministic features (e.g. daycare loot,
    // future event drops) can seed their own streams from a stable,
    // proven PRNG rather than each rolling their own hash.
    getRng: getxor4069,
    // Pack mode (GMS solo packs): packs.js sets the active pack's
    // types/monsters/rares; null restores fusion behavior.
    setPack, getPack,
    TICK_MS, LIFETIME_MS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
