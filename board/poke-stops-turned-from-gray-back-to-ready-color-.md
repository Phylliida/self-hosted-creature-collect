---
title: poke stops turned from gray back to ready color but they weren't ready
status: done
claimed_by: claude-opus
created: 2026-07-20T16:33:44Z
updated: 2026-07-20T16:33:44Z
taiga_id: 174
taiga_version: 2
synced_hash: 6b6c61172553f348
---

## Description
A pokéstop that was gray ("on cooldown") was seen turning to the "ready
colour" while the reporter judged it not actually ready to collect.

"Done" = a stop finishing its cooldown no longer flips to a stand-out
"ready" colour that misleads you into thinking it's collectable; the icon
only signals "collectable now" when you're actually in range.

## Progress
- (2026-07-20) Investigated. Pre-fix the icon had three map colours:
  on-cooldown = gray (`_currentCooldownActiveColor`, #888), cooldown-elapsed
  ("ready") = accent **pink** (`_currentCooldownReadyColor`, #f088b0), and
  never-collected = plain theme colour. Crucially the pink "ready" colour
  was painted on ANY collected stop whose 10-min timer elapsed, with **no
  range gate** — so a gray stop flipping to pink when its timer ran out read
  as "ready" even when you were >100 m away and couldn't collect it. That is
  exactly this report ("turned from gray back to ready color but they
  weren't ready").
- Root cause is identical to the sister task
  `when-stops-refresh-while-out-of-range-they-refre` (viewed from the other
  angle): the un-range-gated accent "ready" colour.
- Traced the current code after the sister fix (commit 41373068):
  `refreshCooldownOverlays()` now `continue`s on any elapsed entry, so
  `poiReadyPts`/`buildingReadyPts` are gone and the layer colour expressions
  lost their ready branch. `buildBuildingColorExpr`/`buildBuildingOpacityExpr`
  are always called with an empty `readyPts`, so their pink branch is dead.
  Verified by grep: the only surviving uses of `_currentCooldownReadyColor`
  are the range-gated tappable halo (`refreshTappablePoiHalos`) and the
  selected-marker CSS — neither is passive out-of-range map clutter.
- Pressure-tested the interpretation against the local peer model; it
  independently agreed (B) is the same root cause as (A) and that removing
  the pink resolves both, a genuine premature-timer bug being far less
  likely than simply being out of range.

## Writeup
**Resolution: fixed by the sister commit `41373068` ("Poké-stops: don't
accent-colour out-of-range 'ready' stops").** No additional code change was
needed for this report; it is the same defect as
`when-stops-refresh-while-out-of-range-they-refre` seen from the user's
other vantage point.

**Why the two reports are one bug:** the map icon's "ready" state was the
theme *accent* (pink) and was applied on the cooldown timer alone, ignoring
range. So a stop the reporter had collected would sit gray for 10 minutes
and then flip to the accent "ready" colour regardless of how far away they
were. To the reporter that colour means "collect me," but out of range they
"weren't ready" to collect — hence "turned from gray back to ready color but
they weren't ready." The (A) fix deleted the accent-ready map colour
entirely: a stop finishing cooldown now goes gray → plain theme colour
(identical to a never-collected stop), and the accent colour appears only on
the **range-gated** tappable halo, which is only shown for stops within 100 m
(`POI_COLLECT_MAX_DISTANCE_M`) that you can actually collect.

**How the colour logic works now** (static/index.html ~8780
`refreshCooldownOverlays`): it reads `cc.poiCooldowns.v1`, and for each entry
with `now - t < POI_COOLDOWN_MS` (still on cooldown) pushes it into
`poiActivePts`/`buildingActivePts`; elapsed entries `continue` and get no
special colour. The `poi-icons` layer uses a `within`-a-MultiPolygon
expression → gray for active, else theme colour. Buildings use a
`distance`-based expression via `buildBuildingColorExpr(active, [])`. Gray is
still range-independent (a just-collected stop you walk away from stays gray
until its cooldown ends), which is useful "just collected" feedback and
self-heals to the uniform theme colour — this was not part of the complaint.

**Scope / honesty notes:**
- Did NOT reproduce any *premature timer expiry* (gray → normal before the
  full 10 min). `entryTimestamp` and `markPoiCollected` both use `Date.now()`
  in ms with no unit mismatch, so I found no code path that shortens the
  cooldown. If the reporter genuinely saw a stop go non-gray well under 10
  minutes (independent of range), that would be a separate bug and needs a
  concrete repro (approx. minutes elapsed, zoom level, POI vs building) —
  file a fresh task if it recurs.
- The **selected/tapped** POI marker still adds a `cooldown-ready` CSS class
  (index.html ~9045) with a hard-coded, range-independent highlight. That is
  a single, deliberately-highlighted stop in the collect card, not the
  passive map colouring this report is about, and was left as-is (same
  decision as the sister task).

**Verification:** by code inspection + grep of every `_currentCooldownReadyColor`
/ `ReadyPts` reference (all map-icon paint paths for the accent colour are
now dead). Not driven on a live GPS map (not feasible in this environment).
