---
title: Put POIs that are clickable on a higher z-layer than POIS not clickable
status: done
claimed_by: claude-opus
created: 2026-07-20T16:34:35Z
updated: 2026-07-20T16:34:35Z
taiga_id: 176
taiga_version: 3
synced_hash: 1e8f6e7ce52707b0
---

## Description
Clickable POIs (real POIs that open the POI card) should render on top of
non-clickable ones (transit infrastructure: stop_position / platform / station,
which instead open a transit schedule popup). Currently every POI lives in one
`poi-icons` symbol layer with `icon-allow-overlap: true`, so when a clickable POI
overlaps a transit stop, whichever draws last visually wins — sometimes hiding the
tappable pin behind a non-tappable stop icon.

"Done" = the clickable pin always draws on top of an overlapping non-clickable one.

## Progress
- (2026-07-20) Mapped the coupling. `isRealPoi(f)` (line ~10906) defines
  "clickable": category (`subclass || class`) NOT in {stop_position, platform,
  station}. The click handler (line ~10965) already prioritises real POIs over
  stops for the *tap* itself, so this task is purely about **visual** z-order.
- Weighed two approaches:
  - Two filtered layers (clickable above transit): unambiguous z, but the
    single `poi-icons` layer is coupled to cooldown recolor (deliberately a
    single-layer design, see comment ~8680), `updateFavPoiFilter` setFilter,
    the tappable-halo `beforeId` anchor, and the click-handler query. High
    breakage risk for real users.
  - `symbol-sort-key` on the one layer: MapLibre draws symbols in ascending
    sort-key order, so a higher key draws on top. Verified from the vendored
    source (`this.features.sort((t,e)=>t.sortKey-e.sortKey)` then drawn in that
    order; `symbol-z-order: auto` switches to key-order once a key is set).
    Zero coupling changes. Chose this.
- Implemented: added `symbol-sort-key` to `poi-icons` layout — transit infra → 0
  (bottom), everything else → 1 (top).

## Writeup
**What changed:** Added a `symbol-sort-key` to the single `poi-icons` symbol
layer in `static/index.html` (the map style, ~line 5885):

```
'symbol-sort-key': ['case',
  ['in', ['coalesce', ['get', 'subclass'], ['get', 'class'], ''],
    ['literal', ['stop_position', 'platform', 'station']]],
  0, 1]
```

Transit-infrastructure POIs (stop_position / platform / station — the
non-clickable ones that open a transit schedule instead of the POI card) get
sort-key 0; every other (clickable) POI gets 1.

**Why this works:** All POIs share one layer with `icon-allow-overlap: true`, so
overlapping icons all render and draw order decides which is visible on top.
MapLibre sorts symbols ascending by `symbol-sort-key` and draws them in that
order (verified in the vendored bundle: `this.features.sort((t,e)=>t.sortKey-
e.sortKey)`, then features are drawn in buffer order → higher key drawn last →
on top). `symbol-z-order` defaults to `auto`, which switches to sort-key order
as soon as a key is set. So key 1 (clickable) always paints over key 0 (transit).

**Why not two layers:** The obvious alternative — a separate clickable layer
stacked above a transit layer — would give unambiguous z-order, but the single
`poi-icons` layer is coupled to a lot: the cooldown recolor is *deliberately* a
single-layer design (see comment ~line 8680), `updateFavPoiFilter` calls
`setFilter('poi-icons', …)`, the tappable-halo layer anchors via `beforeId:
'poi-icons'`, and the click handler queries `['poi-icons']`. Splitting the layer
would force all of those to be updated and kept in sync (and the fav filter would
have to be *combined* with a static clickable/transit filter). `symbol-sort-key`
achieves the same visual result with zero coupling changes — lower risk for the
live users.

**The tap itself was already correct:** the click handler (~line 10965) already
prefers real POIs over transit stops (`!realPoiHits.length`, then `realPoiHits[0]
|| stopPoiHits[0]`), so this was purely a *visual* layering fix. As a bonus,
`queryRenderedFeatures` returns topmost-first, so the higher sort-key also makes
the real POI come first in the query — reinforcing the existing preference.

**`isRealPoi` parity:** the filter mirrors `isRealPoi()` exactly — it keys off
`subclass || class` (via `coalesce`, matching the JS `||`) against the same
`TRANSIT_INFRA_CATS` set {stop_position, platform, station}. If that set ever
changes, both should be updated together.

**Verification (honest):**
- `node --check` on all 7 inline `<script>` blocks of `static/index.html` — no
  syntax errors introduced.
- Expression operators (`case`, `in`, `coalesce`, `get`, `literal`) are all
  already used elsewhere in this same file, and `symbol-sort-key` accepts a
  feature-driven number expression per the style spec — so it's a valid style.
- Draw-order direction confirmed by reading the vendored MapLibre source.
- **Not** visually confirmed in a running map — verifying the actual pixel
  stacking needs the app booted with map tiles + WebGL and a real overlapping
  POI/transit pair on screen, which wasn't run here. The logic is sound but a
  quick in-app spot-check (find a bus stop sitting under a shop pin and confirm
  the shop pin is on top) would fully close it.

**Deploy note:** edited `static/` only. Web users get it on reload; the native
iOS/Android bundle in `dist/` is regenerated from `static/` by
`scripts/build-capacitor.sh` at the next mobile build (per HANDOFF3.md), so no
hand-edit of `dist/` — consistent with how prior board tasks were shipped.
