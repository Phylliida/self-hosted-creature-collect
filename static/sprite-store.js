// Sprite URL store: memoized Promise<url | null> per (a, b, variant) key.
//
// Replaces the layered useSpriteInto / _spriteCache / _applySpriteEntry
// machinery (in sprites.js) for consumers that need to put a fusion
// sprite into a DOM element. The underlying fetch cascade still lives
// in Sprites.getSpriteBlob (pack → IDB → lazy-crop); this module is
// purely the in-memory URL layer + the DOM binder.
//
// Why this exists: the older API tried to use `<img>.onload` (and three
// other reveal paths) as the source of truth for "sprite is ready",
// which is unreliable on iOS WKWebView and confused two questions:
//   (1) Is the blob available?         — answered by Sprites.getSpriteBlob
//   (2) Has the browser painted yet?   — irrelevant; the blob URL is
//                                        already-decoded data, browser
//                                        paints within one frame of
//                                        img.src assignment.
// This module owns (1) via a Promise<url> cache. Consumers don't have
// to listen for any DOM event — they just await the Promise.
//
// Public API:
//   SpriteStore.spriteUrl(a, b, variant)             → Promise<url | null>
//   SpriteStore.preload([{a,b,variant}, ...])        → Promise (kicks off
//                                                     one batched IDB read)
//   SpriteStore.showSprite(img, a, b, variant, opts) → Promise
//                                                     (assigns src + opt. onReady)
//   SpriteStore.bestVariantFor(a, b)                 → Promise<number|null>
//   SpriteStore.invalidate(a, b, variant)
//   SpriteStore.clearAll()
//
// Every consumer (world map markers, battle screen, inventory cards,
// pokédex tiles, family grid, evolution previews, fusion variant grid,
// daycare slot art) routes through SpriteStore.showSprite — the older
// Sprites.useSpriteInto / _spriteCache / _applySpriteEntry plumbing
// was deleted once all call sites migrated.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';
  global._scriptVersions = global._scriptVersions || {};
  global._scriptVersions['sprite-store.js'] = SCRIPT_VERSION;

  // Cap mirrors the previous _spriteCache. With ~50 visible markers +
  // a few inventory carousels + ~20 pokédex tiles + family grid +
  // battle screen, 256 is comfortable headroom.
  const MAX_ENTRIES = 256;

  // cache: Map<key, Promise<url | null>>
  // Map iteration order is insertion order; we exploit that for LRU
  // (touch on access = delete + re-insert, evict from the front).
  const cache = new Map();

  function keyOf(a, b, variant, shinyVariant) {
    const v = (typeof variant === 'number' && variant >= 0) ? variant : 'auto';
    const s = (typeof shinyVariant === 'number' && shinyVariant >= 0)
      ? `:s${shinyVariant}` : '';
    return `${a}-${b}:${v}${s}`;
  }

  function evictUntilUnder(target) {
    while (cache.size >= target) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      const old = cache.get(oldestKey);
      cache.delete(oldestKey);
      missAt.delete(oldestKey);
      // Revoking an evicted URL is harmless to <img>s that already
      // loaded from it — the browser keeps the decoded bitmap. The URL
      // handle simply becomes unresolvable for fresh assignments.
      old.then((u) => u && URL.revokeObjectURL(u)).catch(() => {});
    }
  }

  function touch(key) {
    const p = cache.get(key);
    cache.delete(key);
    cache.set(key, p);
  }

  // A sprite load that hasn't settled after this long is treated as a
  // transient failure (evicted + retried). Without it, one fetch that
  // never settles — e.g. issued just as iOS suspended the app — pinned
  // its cache entry (and every marker/card sharing the key) forever.
  const ATTEMPT_TIMEOUT_MS = 20000;
  function _withTimeout(p, ms, what) {
    let t;
    return Promise.race([
      p,
      new Promise((_, rej) => {
        t = setTimeout(() => rej(new Error(what + ' timed out')), ms);
      }),
    ]).finally(() => clearTimeout(t));
  }

  // Keys whose cache entry resolved to null ('missing'), with when.
  // Lets recovery passes drop just those entries (see retryMisses).
  const missAt = new Map();

  // Cache policy:
  //   - status='ok'        → Promise<url>     stored
  //   - status='missing'   → Promise<null>    stored (genuine absence;
  //                                            don't hammer the server
  //                                            forever for files that
  //                                            aren't there) — but
  //                                            re-checked occasionally
  //                                            and after an app resume
  //                                            (retryMisses), as cheap
  //                                            insurance against a
  //                                            misclassified failure.
  //   - status='transient' → Promise rejected, entry removed from cache,
  //                          caller (showSprite) registers the img for
  //                          retryPoll to revisit with backoff.
  function spriteUrl(a, b, variant, shinyVariant) {
    const key = keyOf(a, b, variant, shinyVariant);
    if (cache.has(key)) {
      touch(key);
      return cache.get(key);
    }
    evictUntilUnder(MAX_ENTRIES);
    const p = (async () => {
      const r = await _withTimeout(
        global.Sprites.getSpriteBlobAttempt(a, b, variant),
        ATTEMPT_TIMEOUT_MS, 'sprite fetch ' + key);
      if (r.status === 'missing') return null;
      if (r.status !== 'ok') throw new Error('sprite fetch transient: ' + key);
      const isShiny = typeof shinyVariant === 'number' && shinyVariant >= 0;
      if (!isShiny || !global.ShinyStore) return URL.createObjectURL(r.blob);
      // Apply the shiny transform on a cache miss. On failure
      // (palette bundle not loaded, family pair not in the bake,
      // canvas decode error) fall back to the base sprite — the user
      // still sees the creature, just non-shiny.
      try {
        const shinyUrl = await global.ShinyStore.transformBlob(
          r.blob, a, b, shinyVariant);
        if (shinyUrl) return shinyUrl;
      } catch { /* fall through */ }
      return URL.createObjectURL(r.blob);
    })();
    cache.set(key, p);
    // On rejection, evict so the next call kicks off a fresh fetch.
    p.then((u) => { if (u === null && cache.get(key) === p) missAt.set(key, Date.now()); },
      () => { if (cache.get(key) === p) cache.delete(key); });
    return p;
  }

  // Batched preload: a single IDB transaction reads every missing key
  // in one go. iOS Safari serialises IDB transactions, so 50 concurrent
  // spriteUrl() calls would block on each other — this collapses them
  // to one. Cache entries are seeded synchronously, so any spriteUrl()
  // call for the same key while preload's IDB read is in flight reuses
  // the same Promise rather than kicking off its own fetch.
  //
  // Each entry settles on its OWN result (Sprites.getSpriteBlobsEach):
  // waiting for the whole batch meant one slow or hung pack read kept
  // every marker in it a red dot until the batch timed out (Oct 2026).
  function preload(reqs) {
    if (!reqs || !reqs.length) return Promise.resolve();
    const misses = [];
    for (const r of reqs) {
      const key = keyOf(r.a, r.b, r.variant, r.shinyVariant);
      if (cache.has(key)) continue;
      misses.push({
        a: r.a, b: r.b, variant: r.variant,
        shinyVariant: r.shinyVariant, key,
      });
    }
    if (!misses.length) return Promise.resolve();
    evictUntilUnder(MAX_ENTRIES - misses.length);
    // Sprites.getSpriteBlobsEach / getSpriteBlobsBatch cascade pack →
    // IDB → lazy-crop per request; on the web they open ONE transaction
    // for the IDB reads of the whole batch.
    const blobReqs = misses.map((r) => ({ a: r.a, b: r.b, variant: r.variant }));
    const each = global.Sprites.getSpriteBlobsEach
      ? global.Sprites.getSpriteBlobsEach(blobReqs) : null;
    const batchP = each ? null : _withTimeout(
      global.Sprites.getSpriteBlobsBatch(blobReqs), ATTEMPT_TIMEOUT_MS, 'sprite batch');
    const urlPs = [];
    misses.forEach((m, i) => {
      const resultP = each
        ? _withTimeout(each[i], ATTEMPT_TIMEOUT_MS, 'sprite ' + m.key)
        : batchP.then((results) => results && results[i]);
      // Same caching policy as spriteUrl: cache successes + permanent
      // misses, reject on transient so the cache evicts and the retry
      // loop kicks in via showSprite's catch.
      const urlP = resultP.then(
        async (r) => {
          if (r && r.status === 'missing') return null;
          if (!r || !r.blob) {
            throw new Error('sprite preload transient: ' + m.key);
          }
          const isShiny = typeof m.shinyVariant === 'number' && m.shinyVariant >= 0;
          if (!isShiny || !global.ShinyStore) return URL.createObjectURL(r.blob);
          try {
            const shinyUrl = await global.ShinyStore.transformBlob(
              r.blob, m.a, m.b, m.shinyVariant);
            if (shinyUrl) return shinyUrl;
          } catch { /* fall through */ }
          return URL.createObjectURL(r.blob);
        },
        () => { throw new Error('sprite preload rejected: ' + m.key); },
      );
      cache.set(m.key, urlP);
      urlP.then((u) => { if (u === null && cache.get(m.key) === urlP) missAt.set(m.key, Date.now()); },
        () => { if (cache.get(m.key) === urlP) cache.delete(m.key); });
      urlPs.push(urlP);
    });
    return Promise.all(urlPs.map((p) => p.catch(() => null))).then(() => undefined);
  }

  // "Best available" variant resolver — mirrors the old useSpriteInto's
  // `variant === undefined` semantics: custom slot 0 if any custom art
  // exists, else autogen.
  async function bestVariantFor(a, b) {
    if (!global.Sprites || !global.Sprites.getCellVariantCount) return null;
    try {
      const count = await global.Sprites.getCellVariantCount(a, b);
      return count > 0 ? 0 : null;
    } catch {
      return null;
    }
  }

  // Bind a sprite to an <img>. Cancellation is per-element: each call
  // bumps img._spriteGen; the async path checks before any DOM mutation
  // or onReady so a newer showSprite call on the same element wins.
  //
  // opts:
  //   onReady(img)   — invoked after src is assigned. Use this to flip
  //                    your own "ready" state (e.g. reveal a parent
  //                    container, hide a placeholder).
  //   readyClass     — optional class to add to the img itself once src
  //                    lands. Default: no class added (most consumers
  //                    drive their own state via onReady).
  //
  // No img.onload / img.decode race: setting src on a blob URL is a
  // synchronous assignment, and the bytes are already-decoded data in
  // memory. The browser paints within one frame.

  // Pending-retry registry. Populated when a showSprite call hits a
  // transient failure (e.g. 504 during LocalServer's restart window).
  // Polled every ~500ms; each entry retries on an exponential backoff
  // (0.5 s → 8 s) so a long outage doesn't hammer the local server with
  // every visible marker twice a second. Entries whose imgs have left
  // the DOM or were superseded by a newer showSprite call get pruned.
  //
  // Each entry: { img, a, b, variant, opts, gen, attempt, dueAt }.
  // gen pins the entry to the showSprite call that registered it — a
  // later call on the same img bumps img._spriteGen, which the retry
  // loop notices and skips the stale entry.
  const pendingRetries = new Map();  // img → entry
  const RETRY_BASE_MS = 500;
  const RETRY_MAX_MS = 8000;

  function registerRetry(img, a, b, variant, opts, gen) {
    const prev = pendingRetries.get(img);
    const attempt = prev ? prev.attempt + 1 : 0;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, attempt));
    pendingRetries.set(img, {
      img, a, b, variant, opts, gen, attempt, dueAt: Date.now() + delay,
    });
  }

  // Imgs whose sprite resolved to 'missing' (null). Re-checked by
  // retryMisses — on a slow timer, and right after the app returns from
  // the background (when a resume-window failure is most likely to have
  // been misread as an absence).
  const pendingMisses = new Map();   // img → { a, b, variant, opts, gen, at }
  // Native packs hold every sprite the app asks for (checked against
  // cells.json, Oct 2026), so a 'missing' there is almost certainly a
  // misread failure: re-check it soon. On the web a miss usually means
  // the sprite data simply isn't downloaded.
  const MISS_RECHECK_MS = (typeof window !== 'undefined' && window.Capacitor)
    ? 30 * 1000 : 2 * 60 * 1000;

  async function showSprite(img, a, b, variant, opts) {
    if (!img) return;
    opts = opts || {};
    const gen = (img._spriteGen || 0) + 1;
    img._spriteGen = gen;
    if (variant === undefined) {
      variant = await bestVariantFor(a, b);
      if (img._spriteGen !== gen) return;
    }
    const shinyVariant = (typeof opts.shinyVariant === 'number' && opts.shinyVariant >= 0)
      ? opts.shinyVariant : null;
    let url;
    try { url = await spriteUrl(a, b, variant, shinyVariant); }
    catch {
      // Transient failure — register for retry instead of giving up.
      if (img._spriteGen === gen) registerRetry(img, a, b, variant, opts, gen);
      return;
    }
    if (img._spriteGen !== gen) return;
    pendingRetries.delete(img);
    if (!url) {
      // 'missing' — treated as absent, but re-checked now and then.
      pendingMisses.set(img, { a, b, variant, opts, gen, at: Date.now() });
      return;
    }
    pendingMisses.delete(img);
    img.src = url;
    if (opts.readyClass) img.classList.add(opts.readyClass);
    if (typeof opts.onReady === 'function') {
      try { opts.onReady(img); }
      catch (e) { console.error('SpriteStore.showSprite/onReady', e); }
    }
  }

  // Drain pending transient failures, re-attempt each. Successes flow
  // through the normal showSprite path (cache hit on the now-resolved
  // spriteUrl, src assignment, onReady). Re-failures naturally re-add
  // to pendingRetries via registerRetry, picked up on the next tick.
  function retryPoll(force) {
    if (!pendingRetries.size) return;
    const now = Date.now();
    for (const r of Array.from(pendingRetries.values())) {
      if (!r.img.isConnected || r.img._spriteGen !== r.gen) {
        pendingRetries.delete(r.img);         // detached / superseded
        continue;
      }
      if (!force && r.dueAt > now) continue;  // backing off
      // Keep the entry (and its attempt count) until showSprite settles:
      // success deletes it, another failure re-registers with a longer
      // delay. Push dueAt out so this poll doesn't double-fire it.
      r.dueAt = now + RETRY_MAX_MS;
      showSprite(r.img, r.a, r.b, r.variant, r.opts);
      // showSprite bumped the img's generation synchronously; follow it
      // so the in-flight retry isn't mistaken for a superseded one (that
      // would reset the backoff on every failure).
      r.gen = r.img._spriteGen;
    }
  }
  const RETRY_INTERVAL_MS = 500;
  if (typeof setInterval === 'function') setInterval(retryPoll, RETRY_INTERVAL_MS);

  // Re-check 'missing' results: drop their null cache entries (all of
  // them when forced, else only ones older than MISS_RECHECK_MS) and
  // re-run showSprite for the imgs still showing a placeholder.
  function retryMisses(force) {
    const now = Date.now();
    for (const [key, at] of Array.from(missAt)) {
      if (force || now - at >= MISS_RECHECK_MS) {
        missAt.delete(key);
        const p = cache.get(key);
        if (p) cache.delete(key);
      }
    }
    for (const [img, m] of Array.from(pendingMisses)) {
      if (!img.isConnected || img._spriteGen !== m.gen) {
        pendingMisses.delete(img);
        continue;
      }
      if (!force && now - m.at < MISS_RECHECK_MS) continue;
      pendingMisses.delete(img);
      showSprite(img, m.a, m.b, m.variant, m.opts);
    }
  }
  if (typeof setInterval === 'function') setInterval(() => retryMisses(false), 15000);

  // Coming back from the background: iOS restarts LocalServer and storage
  // connections then, so failures from just before/around the suspension
  // are likely stale. After a short settle delay, retry everything that's
  // waiting — transients immediately (skipping their backoff) and misses
  // too. Short trips (< 5 s) don't count.
  if (typeof document !== 'undefined' && document.addEventListener) {
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = 0;
      if (away < 5000) return;
      setTimeout(() => { retryMisses(true); retryPoll(true); }, 3000);
    });
  }

  function invalidate(a, b, variant) {
    const key = keyOf(a, b, variant);
    const p = cache.get(key);
    if (!p) return;
    cache.delete(key);
    missAt.delete(key);
    p.then((u) => u && URL.revokeObjectURL(u)).catch(() => {});
  }

  function clearAll() {
    for (const p of cache.values()) {
      p.then((u) => u && URL.revokeObjectURL(u)).catch(() => {});
    }
    cache.clear();
    missAt.clear();
  }

  global.SpriteStore = {
    spriteUrl, preload, showSprite, bestVariantFor,
    invalidate, clearAll,
    retryPoll, retryMisses,
    pendingRetryCount: () => pendingRetries.size,
    // For the Settings diagnostic dump ([sprites] block).
    stats: () => ({
      cached: cache.size,
      misses: missAt.size,
      pendingRetries: pendingRetries.size,
      pendingMisses: pendingMisses.size,
    }),
  };
})(typeof window !== 'undefined' ? window : globalThis);
