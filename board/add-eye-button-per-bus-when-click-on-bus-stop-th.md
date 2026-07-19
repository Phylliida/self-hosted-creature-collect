---
title: add eye button per-bus when click on bus stop that you can click to toggle viewing that line on the map or not
status: done
claimed_by: claude-opus
created: 2026-07-19T19:28:21Z
updated: 2026-07-19T19:28:21Z
taiga_id: 70
taiga_version: 2
synced_hash: 0802f860420abd6d
---

this is for when i click on a transit stop poi, it should be right aligned eye at the right edge using a custom simple eye svg

## Progress
- (2026-07-19) Implemented Option A: replaced the left-side `✓` line-visibility
  toggle in the transit stop popup with a right-aligned custom SVG eye button.
  Open eye = line shown on map, slashed eye = line hidden. Kept the separate
  `👁 view-btn` (shows the route's stops) untouched, per the human's scope
  ("removing the redundant checkmark" only).

## Writeup
**What "done" looks like:** clicking a transit stop POI opens the route popup;
each route row now has a single clean SVG eye at the right edge that toggles
whether that route's line is drawn on the map.

**How the code works** (all in `static/index.html`):
- `showTransitPopup(...)` builds one `.route-item` row per route. The row is a
  flexbox: `[ref][name flex:1][mode][👁 view-btn][eye-toggle]`. Because `.name`
  has `flex:1`, the trailing eye button sits flush against the right edge.
- New helper `eyeSvg(on)` (defined just above `showTransitPopup`) returns a small
  inline SVG eye (feather-style almond + pupil). When `on` is false it appends a
  diagonal `<line>` slash to signal "hidden".
- The eye is a `<button data-action="toggle">`. The existing delegated
  `[data-action]` click handler already routes `toggle` → flips
  `transitState.routes[rid]` / `routeOn(rid)`, saves state, and calls
  `refreshRoutesSource()` to redraw the `bus-routes` layer. I updated that
  handler to swap the icon via `el.innerHTML = eyeSvg(nowOn)` (was
  `el.textContent = '✓'`) and to keep `aria-pressed` / `title` in sync.
- CSS: `.route-popup .toggle-vis` rules removed; added `.route-popup .eye-toggle`
  (28×22 button, muted stroke normally, accent fill + accent-text when `.on`).
  The `on` state uses the existing `--ui-accent*` theme vars so it works in
  light/dark.
- Updated the no-stop-name fallback popup title from "✓ toggles line" to
  "eye toggles line".

**Assumptions / scope:**
- Kept the distinct `👁 view-btn` (toggles showing the route's *stops* via
  `viewedRoutes` / `refreshStopsSource`). It's a separate feature from the line
  toggle; the human's instruction only asked to remove the redundant checkmark.
  Note both are eye-ish now (SVG eye = line, emoji 👁 = stops) — flag if that's
  confusing and the stops button should be restyled/relabeled.

**Verification:** change is a localized template-string + CSS + helper swap; the
delegated toggle handler path is unchanged apart from the icon swap. Not
exercised in the live map (requires clicking a real transit stop with MapLibre
loaded), so runtime-untested but low-risk.
