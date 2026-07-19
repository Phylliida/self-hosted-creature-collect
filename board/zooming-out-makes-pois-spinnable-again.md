---
title: zooming out makes pois spinnable again
status: done
claimed_by: claude-opus
created: 2026-07-19T19:29:01Z
updated: 2026-07-19T19:29:01Z
taiga_id: 72
taiga_version: 2
synced_hash: 8f44cb43e58a5bce
---

this seems wrong if used up they should be used up until countdown is finished, probably there's seperate low zoom instances or something idk

## Progress
- (2026-07-19) Diagnosed root cause. POI cooldowns were keyed on an
  exact string `${lng.toFixed(5)},${lat.toFixed(5)}` (~1.1m resolution).
  The map's `local` vector source is served at native maxzoom 14, and
  the SAME POI quantizes onto a coarser tile grid at z12/z13 than at z14
  — so its rendered lng/lat shifts a couple of meters when you zoom out.
  That changed the toFixed(5) key, the cooldown lookup missed, and the
  POI read as "never collected" again (collect button re-enabled + the
  gray/pink overlay reset to available). The reporter's guess ("separate
  low zoom instances") was right — same POI, different quantized coords.
- Fix (static/index.html):
  1. `poiCooldownRemainingMs` / `poiCooldownStatus` are now SPATIAL —
     new `poiCooldownMatches(lng,lat)` scans stored entries' full-precision
     (x,y) and matches any within `POI_COOLDOWN_RADIUS_M` (54m). This is
     consistent with the existing rule that collecting locks everything
     within 54m, so it can't over-lock. Legacy entries lacking x/y still
     work via the exact-key fallback.
  2. Bumped `COOLDOWN_POLYGON_EPS` 0.000005 → 0.00003 (~3.3m) so the
     `within`-based gray/pink icon overlay still contains the POI centroid
     when it re-quantizes on zoom-out. Still far under 54m, and any real
     neighbor that close was already locked + given its own entry, so it
     can't gray an un-locked POI.
- Added tests/poi-cooldown-zoom.test.js (12 assertions, extracts the real
  functions from index.html). Full suite green.

## Writeup
**Symptom:** A pokéstop/POI you'd already collected from would become
collectable again (and its icon reverted from gray "on cooldown" / pink
"ready" back to the default available color) simply by zooming the map out.

**Cause:** Cooldowns live in localStorage (`cc.poiCooldowns.v1`) keyed by
`"<lng.toFixed(5)>,<lat.toFixed(5)>"`. POI features come from the `local`
vector source (native maxzoom 14; POIs render z13+, bus stops z12+). The
same POI's coordinate is quantized onto the tile grid, which is coarser at
z12/z13 than z14 — so zooming across a native-tile boundary shifts the
rendered lng/lat by ~1–3m. That's enough to change the 5th decimal, so the
exact-key lookup missed and every cooldown check (`poiCooldownRemainingMs`,
`poiCooldownStatus`) reported "none".

**Fix:** Make cooldown lookups spatial instead of exact-key. Collecting
already stores each entry's full-precision `{x,y}` and already locks every
rendered POI within `POI_COOLDOWN_RADIUS_M` (54m). The new
`poiCooldownMatches(lng,lat)` returns any stored entry whose `{x,y}` is
within that same 54m radius; `poiCooldownRemainingMs` takes the max
remaining across matches (so overlapping locks expire correctly) and
`poiCooldownStatus` returns active/ready/none accordingly. Legacy entries
(bare-number timestamp, or no `x/y`) fall back to the old exact-key path.
Also widened the overlay polygon half-edge (`COOLDOWN_POLYGON_EPS`) from
~0.5m to ~3.3m so the icon-recolor `within` test keeps matching the POI
centroid after a zoom re-quantization.

**Behavior note (intended, minor):** Because the gate is now radius-based
rather than "rendered-and-locked at collect time", a POI within 54m of a
collected one is treated as on cooldown even if it wasn't on-screen when
you collected. This matches the anti-farming intent of the 54m lock and is
strictly more correct than the previous render-dependent behavior.

**Verification:** `tests/poi-cooldown-zoom.test.js` (12 assertions,
extracts the real functions from index.html) covers: exact + zoom-shifted
coordinate both stay locked; both go "ready" after 10min; far POI
unaffected; overlapping-lock max-remaining; legacy bare-number entries.
Full `tests/*.test.js` suite passes. Not driven in a live browser (no
headless MapLibre here); the tile-quantization mechanism was cross-checked
against the source's maxzoom=14 config and confirmed with the local model.
