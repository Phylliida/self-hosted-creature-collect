# Partner-on-Android sprite bug — diagnostic plan

## Symptoms

1. **Custom art missing for some fusions**: where I see hand-drawn variants, partner only sees autogen. The "Download sprite data" button reports done.
2. **Encounter sprite breaks intermittently**: starts working, eventually stops rendering even though the pokéball animation still plays. A few-frame "flash" visible when the ball hits the (invisible) creature.
3. **After capture**, the captured creature shows the autogen sprite in inventory + pokédex; pokédex variants list says autogen is the only art available for that fusion.

## Theory 1 — variants IDB store partially populated

`bulkDownload` pass-2 walks every species and writes one entry per cell into the `variants` object store, then sets `localStorage['cc.spritesCustomDone.v2']` flag. If pass-2 was interrupted between writes (Android Chrome backgrounding, storage quota, transaction abort) the flag may be set even though some entries are missing.

Once the flag is set, the Settings click handler short-circuits at:
```js
if (iconsRemaining === 0 && customRemaining === 0) { ... return; }
```
so re-pressing Download doesn't help. Meanwhile `getCellVariantCount(a, b)` returns 0 for the missing cells → fallback to autogen → pokédex's variant grid agrees because both read the same store.

This would explain bugs 1 + 3 simultaneously (they're really the same bug).

## Theory 2 — battle-screen reuses a stale-revoked objectUrl

`openBattleScreen` reuses the marker's blob URL when one is loaded:
```js
const rec = _markers.get(spawn.id);
if (rec && rec.objectUrl) {
  img.onload = () => el.classList.add('battle-sprite-ready');
  img.src = rec.objectUrl;
}
```

`removeMarker(id)` revokes `rec.objectUrl` but doesn't null the field, and the rec is removed from the `_markers` map only afterward. If markers churn (spawn refresh, scroll-driven recycling) between the tap and the battle-screen render, we could be holding a revoked URL on a still-mapped rec for one frame. `img.src = url` fails silently → `onload` never fires → `.battle-sprite-ready` never gets added → CSS keeps the sprite at `display: none`.

The "few-frame flash" matches: the throwing animation pulls `.battle-flash` (white pulse overlay) into view briefly even though the creature `<img>` is hidden.

This would explain bug 2.

## Data to collect from partner's Settings panel

Have him open Settings and screenshot / paste these blocks:

1. **`[script versions]`** — any line showing `⚠ STALE`?
   - If yes: his browser cached an older copy of one of the JS files; that's a confound for any other diagnosis. Hit the Refresh button and re-test.

2. **`[sprites]`** block — what does `cached=` show?
   - **Healthy**: `cached=17600` (or close — every fusion in the 1-150 × 1-150 grid).
   - **Confirms theory 1**: significantly lower number (e.g. `cached=4200`).

3. **`[sprite errors]`** block — `count=` and any error lines.
   - Quota/transaction errors in here would also confirm theory 1.

4. **`[credit lookup]`** block — `calls=` / `hits=`. Less directly useful but tells us if the credits bundle (which downloads alongside variants) ran successfully.

## Decision tree

```
[script versions] shows ⚠ STALE
  → hit Refresh, retest from scratch.

[sprites].cached << 17600
  → theory 1 confirmed. Force full re-download (recipe below).

[sprites].cached ≈ 17600 and bug 2 still triggers
  → theory 2 confirmed. Fix openBattleScreen to refetch from IDB
    when the cached URL fails to load (small code change — see
    "Code fix" below).

[sprites].cached ≈ 17600 AND no bug 2
  → bug self-resolved between sessions. Re-collect data when it
    next manifests.
```

## Recipe — forced full re-download (theory 1)

In the browser DevTools console, or in any quick-action UI we wire up:

```js
localStorage.removeItem('cc.spritesCustomDone.v2');
localStorage.removeItem('cc.spritesDownloaded');
```

Then click "Download sprite data" in Settings. The pre-flight status will now report all 150 species as undone, and bulkDownload will write every variants entry (and the summary blob, and the credits bundle) from scratch.

Worth verifying afterwards via the same `[sprites].cached` reading — should land at ~17,600.

## Code fix sketch — battle-screen objectUrl race (theory 2)

Currently `openBattleScreen` falls through to the IDB-fetch path **only when no cached URL is on the rec**. The fix is to also fall back when the cached URL fails to decode:

```js
img.onerror = () => {
  // Cached marker URL was stale-revoked. Refetch from IDB.
  resolveSpawnVariant(spawn)
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
};
```

Wire this onto the img regardless of which path set the src. Bonus: also catches IDB-fetched URLs that fail to decode for any other reason.

We should ALSO fix `removeMarker` to null `rec.objectUrl` after revoking, so the "is it valid" check at battle-screen time is meaningful:

```js
function removeMarker(id) {
  ...
  if (rec.objectUrl) {
    URL.revokeObjectURL(rec.objectUrl);
    rec.objectUrl = null;  // <-- add this
  }
  ...
}
```

## Followups regardless of which theory wins

- Add an integrity check at app boot: if `cc.spritesCustomDone.v2` is set but the variants store has fewer than (say) 90% of the expected entries, clear the flag automatically and surface a "re-download recommended" hint in Settings. Catches the partial-write failure mode without requiring user-driven debugging.
- Record `_spriteDiag.errorsByCode` so we know whether the partial-write was a quota error vs. a transaction abort vs. a different IDB failure mode.
