---
title: player dot should not have any collisions
status: done
claimed_by: claude-opus
created: 2026-07-20T16:33:44Z
updated: 2026-07-20T16:33:44Z
taiga_id: 175
taiga_version: 3
synced_hash: 4499cea987719221
---

## Description
The player-location dot on the map (with its custom heading cone) should not
"collide" — i.e. it must not intercept taps/clicks that are meant for POIs
(poké-stops, spawns) sitting under or near it. Right now the dot's marker
element likely captures pointer events, making POIs beneath it unclickable.
"Done" = the player dot is purely visual and passes all pointer events through
to whatever is underneath.

## Progress
- (2026-07-20) Claimed. Investigating how the player dot marker + heading cone
  are created and whether they capture pointer events.
- (2026-07-20) Root-caused and fixed. See Writeup.

## Writeup
**Root cause.** The player dot is MapLibre's stock `GeolocateControl`
user-location dot — a DOM `Marker` (element `div.maplibregl-user-location-dot`,
created at `static/index.html:6569-6590`, `showAccuracyCircle:false`,
`showUserHeading:true`). MapLibre layers all DOM markers *above* the WebGL map
canvas. POIs (poké-stops / spawns / transit) are NOT DOM markers — they're
WebGL map layers (`poi-icons`, `building-pokestops`, tappable-halo circle
layer) rendered on the canvas, and they're clicked through a single delegated
`map.on('click')` handler (`static/index.html:10905`) that runs
`queryRenderedFeatures`. So a POI tap only registers if the pointer event
reaches the canvas.

Neither the vendored MapLibre CSS nor our overrides set `pointer-events` on the
dot, so it defaulted to `auto`: the ~19px dot (its `::after` white ring is the
effective hit area) swallowed every tap that landed on it and never let it
reach the canvas → any POI sitting under the player was uncatchable. The custom
heading cone child (`.cc-user-heading`) was already `pointer-events:none`, so
it was not the culprit — the bare dot element was.

**Fix.** CSS-only, in `static/index.html` (~line 1892). Added
`pointer-events: none` to `.maplibregl-user-location-dot` (and, defensively,
`.maplibregl-user-location-accuracy-circle`, though the accuracy circle is
currently disabled). This mirrors the exact pattern the creature/spawn markers
already use (`creatures.js` `.creature-marker`). The dot has no interactive
children, so nothing needs to re-enable events.

**Why it's correctly scoped.** Verified against the vendored MapLibre source
that when a `Marker` is given an `element`, it uses that element directly
(`this._element = t.element`) and merely adds the `maplibregl-marker` class to
it — there is NO separate wrapper div. So the rule targets the actual marker
element, and there's no blanket `.maplibregl-marker { pointer-events }` rule, so
creature / favorite / selected markers (which must stay clickable) are
untouched. No rule re-enables pointer events on the dot later in the file.

**Assumptions / not verified.** Change is a pointer-events CSS tweak; I did not
drive it on a live map with a real GPS fix (requires device geolocation + a POI
under the dot, impractical headless). Confidence is from code inspection of the
click path and MapLibre's marker/DOM behavior. Heading-cone rendering is
unaffected (its visibility is driven by JS transforms, not pointer events).

**Related task.** The sibling "Put clickable POIs on a higher z-layer than
non-clickable POIs" is separate: all POIs currently share the `poi-icons`
layer and clickable-vs-not is decided only by `isRealPoi()`
(`static/index.html:10893`) at query time. Implementing it would mean splitting
`poi-icons` into two GL layers filtered by `TRANSIT_INFRA_CATS` and ordering
the clickable one above. Left for that task.
