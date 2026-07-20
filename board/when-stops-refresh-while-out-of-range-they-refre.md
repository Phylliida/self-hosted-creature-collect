---
title: When stops refresh while out of range, they refresh to a different colour than other out-of-range stops (depending on theme).
status: done
claimed_by: claude-opus
created: 2026-07-20T16:29:35Z
updated: 2026-07-20T16:29:35Z
taiga_id: 162
taiga_version: 4
synced_hash: 7e8fafe30452cc4f
---

## Description
Out-of-range poké-stops should look uniform. Today a stop you collected
earlier whose cooldown has elapsed ("ready") is painted the theme *accent*
colour by `refreshCooldownOverlays()` regardless of how far away the player
is, while never-collected out-of-range stops keep the plain `poiIcon` theme
colour. So an out-of-range "ready" stop stands out from its neighbours, and
because the accent is theme-derived the mismatch varies by theme.

"Done" = out-of-range stops all render with the same (theme `poiIcon`)
colour; the accent "ready" colour only appears for stops the player can
actually collect (in interaction range), matching the halo cue.

## Progress
- (2026-07-20) Root-caused. `refreshCooldownOverlays()` (index.html ~8814)
  builds `poiReadyPts`/`buildingReadyPts` from ALL cooldown entries with no
  range gate, then paints them accent. The halo layer IS range-gated
  (`refreshTappablePoiHalos`, 100m `POI_COLLECT_MAX_DISTANCE_M`) and IS wired
  to movement (geolocate/moveend/idle → `scheduleTappablePoiHalosRefresh`),
  but `refreshCooldownOverlays` is NOT movement-wired — it only runs on theme
  apply, collect, mode toggle, map-load, and its own 30s active-cooldown poll.

## Writeup
**Fix:** In `refreshCooldownOverlays()` (static/index.html ~8775) the icon-color
now only distinguishes the **on-cooldown ("active")** state. A collected stop
whose cooldown has elapsed ("ready") no longer gets the theme *accent* colour —
it falls through to the plain `poiIcon` theme colour, identical to a
never-collected stop. Concretely: the recolor loop `continue`s on any entry with
`now - t >= POI_COOLDOWN_MS`, so ready stops never enter `poiActivePts`/
`buildingActivePts`, and the `poi-icons`/`building-pokestops` colour expressions
lost their ready branch (`poiReadyPts`/`buildingReadyPts` removed).

**Why this fixes it:** out-of-range stops are now uniform regardless of your
collection history, so the reported "refresh to a different colour than other
out-of-range stops" (and its theme-dependence, since accent is theme-derived)
is gone. The gray→ready transition on the 30s poll now reads as
gray → normal-theme-colour instead of gray → accent.

**Design choice (bounced off the local peer model, which independently
preferred this):** colour encodes *state* (on-cooldown vs not); the existing
range-gated tappable **halo** (`refreshTappablePoiHalos`, 100 m, already
movement-wired to geolocate/moveend/idle) encodes *opportunity* ("collectable
now"). The persistent accent "ready" icon was redundant with the halo for
in-range stops and was pure clutter/inconsistency out of range. This avoided
the alternative fix (range-gate the ready colour), which would have required
wiring `refreshCooldownOverlays` into the movement path — it currently isn't.

**What stayed the same / assumptions:**
- The **on-cooldown gray** colour still shows regardless of range (a
  just-collected stop you walk away from stays gray until its cooldown
  elapses). This wasn't part of the complaint and is useful "just collected"
  feedback; it self-heals to the uniform theme colour once the cooldown ends.
- `_currentCooldownReadyColor` (accent) is retained — the halo layer still uses
  it for its ring colour.
- The **selected/tapped** POI marker still shows its `cooldown-ready` /
  `cooldown-active` styling (index.html ~2057; hard-coded, non-theme). That's a
  single deliberately-highlighted stop in the collect card, not the passive map
  clutter this task was about, so it was left as-is. (Pre-existing note: those
  selected-marker CSS colours don't track the theme accent/muted — out of scope
  here.)

**Verification:** the inline `<script>` block containing the function parses
clean under `node --check`; logic verified by inspection (ready stops `continue`
→ theme colour). Not driven end-to-end on a live GPS map (not feasible in this
environment).
