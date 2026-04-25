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
  const LIFETIME_MS = 5 * 60 * 1000;     // each spawn lives 5 min
  const LIFETIME_TICKS = Math.ceil(LIFETIME_MS / TICK_MS);  // 5
  const DAY_SALT = 0x1F3B2C;             // bump to invalidate every seed
  // Probability a given (cell, tick) hosts a spawn. Tuned so expected
  // active count ≈ pHit × LIFETIME_TICKS roughly matches the prior
  // fixed-bucket density (~2% of cells active at any time).
  const SPAWN_CHANCE_PER_TICK = 0.0032;
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
    1, 4, 7, 10, 13, 16, 19, 21, 23, 25, 27, 29, 32, 35, 37, 39, 41,
    43, 46, 48, 50, 52, 54, 56, 58, 60, 63, 66, 69, 72, 74, 77, 79,
    81, 83, 84, 86, 88, 90, 92, 95, 96, 98, 100, 102, 104, 106, 107,
    108, 109, 111, 113, 114, 115, 116, 118, 120, 122, 123, 124, 125,
    126, 127, 128, 129, 131, 132, 133, 137, 138, 140, 142, 143, 147,
  ];
  const SPAWNABLE_SPECIES_B = SPAWNABLE_SPECIES_A;
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
  // where species whose own types include the daily type get 5× the
  // chance, weekly type 5×, both 25×. Density stays the same — only
  // composition shifts.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEK_MS = 7 * DAY_MS;
  const DAILY_SALT = 0xA1D4;
  const WEEKLY_SALT = 0x7EE7;
  const TYPES = [
    'NORMAL', 'FIRE', 'WATER', 'GRASS', 'ELECTRIC', 'ICE',
    'FIGHTING', 'POISON', 'GROUND', 'FLYING', 'PSYCHIC', 'BUG',
    'ROCK', 'GHOST', 'DRAGON', 'DARK', 'STEEL', 'FAIRY',
  ];

  function currentWeather(nowMs) {
    const now = nowMs == null ? Date.now() : nowMs;
    const dayIdx = Math.floor(now / DAY_MS);
    const weekIdx = Math.floor(now / WEEK_MS);
    const dailyRng = getxor4069((dayIdx ^ DAILY_SALT) | 0);
    const weeklyRng = getxor4069((weekIdx ^ WEEKLY_SALT) | 0);
    return {
      daily: TYPES[Math.floor(dailyRng() * TYPES.length)],
      weekly: TYPES[Math.floor(weeklyRng() * TYPES.length)],
    };
  }

  // Build (and cache) two weighted species pools for the current
  // weather — one for slot A, one for slot B. Per Infinite Fusion
  // typing rules the fusion's primary type comes from A and its
  // secondary from B (or B's primary if B is single-typed). So each
  // slot is weighted by the type it actually CONTRIBUTES to the fusion:
  //   - poolA: weight by species.primary
  //   - poolB: weight by species.secondary || species.primary
  // This way Scyther (BUG/FLYING) is FLYING-boosted only when in slot
  // B, and BUG-boosted only when in slot A. Returns null when types
  // data isn't loaded — callers should treat that as "spawning
  // disabled until data is downloaded".
  let _cachedPoolKey = null;
  let _cachedPools = null;
  function getWeightedPools() {
    const Species = global.Species;
    if (!Species || !Species.typesFor) return null;
    const w = currentWeather();
    const key = `${w.daily}|${w.weekly}`;
    if (key === _cachedPoolKey && _cachedPools) return _cachedPools;
    const probe = Species.typesFor(SPAWNABLE_SPECIES_A[0]);
    if (!probe || !probe.length) return null;
    const poolA = [];
    for (const sp of SPAWNABLE_SPECIES_A) {
      const types = Species.typesFor(sp) || [];
      const primary = types[0];
      let wA = 1;
      if (primary === w.daily)  wA *= 25;
      if (primary === w.weekly) wA *= 25;
      for (let i = 0; i < wA; i++) poolA.push(sp);
    }
    const poolB = [];
    for (const sp of SPAWNABLE_SPECIES_B) {
      const types = Species.typesFor(sp) || [];
      const secondary = types[1] || types[0];
      let wB = 1;
      if (secondary === w.daily)  wB *= 25;
      if (secondary === w.weekly) wB *= 25;
      for (let i = 0; i < wB; i++) poolB.push(sp);
    }
    _cachedPoolKey = key;
    _cachedPools = { poolA, poolB };
    return _cachedPools;
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
  // existing caught-spawn keys.
  function generateCellAtTick(cellX, cellY, tick) {
    const arng = getxor4069(cellTickSeed(cellX, cellY, tick));
    if (arng() >= SPAWN_CHANCE_PER_TICK) return null;
    const fx = arng();
    const fy = arng();
    const lat = (cellX + fx) / SCALE - 90;
    const lng = (cellY + fy) / SCALE - 180;
    // Type-weather sampling: A is picked from a pool weighted by each
    // species' primary type (what A contributes to the fusion); B from
    // a pool weighted by secondary types (what B contributes). Pools
    // are null when types data isn't loaded — bail with no spawn so
    // the user is nudged to download data; creatures.js shows a banner.
    const pools = getWeightedPools();
    if (!pools) return null;
    const speciesA = pools.poolA[Math.floor(arng() * pools.poolA.length)];
    const speciesB = pools.poolB[Math.floor(arng() * pools.poolB.length)];
    const level = expDistr(5, 50, arng()) + 1;
    const sizeM = 0.15 + arng() * 2.0;
    const startMs = tick * TICK_MS;
    return {
      id: `${cellX}:${cellY}:${tick}:0`,
      lat, lng, speciesA, speciesB, level, sizeM,
      startMs, expireMs: startMs + LIFETIME_MS,
    };
  }

  // bbox is [west, south, east, north] (lng/lat MapLibre order).
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

    const firstTick = curTick - LIFETIME_TICKS + 1;
    const out = [];
    for (let cx = minLatCell; cx <= maxLatCell; cx++) {
      for (let cy = minLngCell; cy <= maxLngCell; cy++) {
        for (let t = firstTick; t <= curTick; t++) {
          const p = generateCellAtTick(cx, cy, t);
          if (!p) continue;
          if (now < p.startMs || now >= p.expireMs) continue;
          if (p.lat < south || p.lat > north
              || p.lng < west || p.lng > east) continue;
          out.push(p);
        }
      }
    }
    return out;
  }

  // Caught-spawn IDs include the birth-tick. Once the tick is older
  // than the sliding window, the creature is gone and the ID just
  // bloats localStorage — return true so creatures.js can prune it.
  function isSpawnIdStale(id, nowMs) {
    if (typeof id !== 'string') return true;
    const parts = id.split(':');
    if (parts.length < 3) return true;
    const tick = +parts[2];
    if (!Number.isFinite(tick)) return true;
    return tick < currentTick(nowMs) - LIFETIME_TICKS + 1;
  }

  global.Spawns = {
    spawnsInBbox, generateCellAtTick, currentTick, isSpawnIdStale,
    currentWeather,
    TICK_MS, LIFETIME_MS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
