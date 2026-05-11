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

  function keyOf(a, b, variant) {
    const v = (typeof variant === 'number' && variant >= 0) ? variant : 'auto';
    return `${a}-${b}:${v}`;
  }

  function evictUntilUnder(target) {
    while (cache.size >= target) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      const old = cache.get(oldestKey);
      cache.delete(oldestKey);
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

  function spriteUrl(a, b, variant) {
    const key = keyOf(a, b, variant);
    if (cache.has(key)) {
      touch(key);
      return cache.get(key);
    }
    evictUntilUnder(MAX_ENTRIES);
    const p = (async () => {
      try {
        const blob = await global.Sprites.getSpriteBlob(a, b, variant);
        return blob ? URL.createObjectURL(blob) : null;
      } catch {
        return null;
      }
    })();
    cache.set(key, p);
    return p;
  }

  // Batched preload: a single IDB transaction reads every missing key
  // in one go. iOS Safari serialises IDB transactions, so 50 concurrent
  // spriteUrl() calls would block on each other — this collapses them
  // to one. Cache entries are seeded synchronously, so any spriteUrl()
  // call for the same key while preload's IDB read is in flight reuses
  // the same Promise rather than kicking off its own fetch.
  function preload(reqs) {
    if (!reqs || !reqs.length) return Promise.resolve();
    const misses = [];
    for (const r of reqs) {
      const key = keyOf(r.a, r.b, r.variant);
      if (cache.has(key)) continue;
      misses.push({ a: r.a, b: r.b, variant: r.variant, key });
    }
    if (!misses.length) return Promise.resolve();
    evictUntilUnder(MAX_ENTRIES - misses.length);
    // Sprites.getSpriteBlobsBatch already cascades pack → IDB → lazy-
    // crop per request; on iOS it opens ONE transaction for the IDB
    // reads of the whole batch.
    const batchP = global.Sprites.getSpriteBlobsBatch(
      misses.map((r) => ({ a: r.a, b: r.b, variant: r.variant }))
    );
    misses.forEach((m, i) => {
      const urlP = batchP.then(
        (results) => {
          const blob = results && results[i] && results[i].blob;
          return blob ? URL.createObjectURL(blob) : null;
        },
        () => null,
      );
      cache.set(m.key, urlP);
    });
    return batchP.then(() => undefined, () => undefined);
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
  async function showSprite(img, a, b, variant, opts) {
    if (!img) return;
    opts = opts || {};
    const gen = (img._spriteGen || 0) + 1;
    img._spriteGen = gen;
    if (variant === undefined) {
      variant = await bestVariantFor(a, b);
      if (img._spriteGen !== gen) return;
    }
    let url;
    try { url = await spriteUrl(a, b, variant); }
    catch { return; }
    if (img._spriteGen !== gen) return;
    if (!url) return;
    img.src = url;
    if (opts.readyClass) img.classList.add(opts.readyClass);
    if (typeof opts.onReady === 'function') {
      try { opts.onReady(img); }
      catch (e) { console.error('SpriteStore.showSprite/onReady', e); }
    }
  }

  function invalidate(a, b, variant) {
    const key = keyOf(a, b, variant);
    const p = cache.get(key);
    if (!p) return;
    cache.delete(key);
    p.then((u) => u && URL.revokeObjectURL(u)).catch(() => {});
  }

  function clearAll() {
    for (const p of cache.values()) {
      p.then((u) => u && URL.revokeObjectURL(u)).catch(() => {});
    }
    cache.clear();
  }

  global.SpriteStore = {
    spriteUrl, preload, showSprite, bestVariantFor,
    invalidate, clearAll,
  };
})(typeof window !== 'undefined' ? window : globalThis);
