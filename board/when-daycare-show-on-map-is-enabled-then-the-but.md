---
title: When daycare show on map is enabled then the button to show on map should instead be "hide on map" to toggle off
status: done
claimed_by: claude-opus
created: 2026-07-13T18:28:58Z
updated: 2026-07-13T19:45:00Z
---

(this is in addition to the calendar button on the map to toggle off, either will work)

## Progress

- (2026-07-13) Located the two daycare buttons in `renderDaycare()`
  (`static/creatures.js:9360-9361`): "Show on map" (selected day) and
  "Show all on map" (every day). Their click handlers (9498-9513) call
  `showDaycarePathOnMap(selDay)` / `showAllDaycarePathsOnMap()`.
- Overlay state is tracked module-side in `_activeDaycareOverlay`
  (creatures.js:13222): `null` | `{ dayKey }` | `{ allDays: true }`. The
  map calendar bubble already clears it via `_clearDaycarePathOverlay()`.
- `_daycareCalState.selDay` is a `YYYY-MM-DD` key (same format the overlay
  stores), so an exact `===` match tells us if the *currently selected day*
  is the one on the map.
- Implemented the toggle, parse-checked, ran the suite.

## Writeup

**What changed (all in `static/creatures.js`, inside `renderDaycare()`):**

1. Just before the panel's `body.innerHTML` (after `selMeters`), computed two
   flags from the module-side overlay state:
   - `dayOverlayActive` — `_activeDaycareOverlay.dayKey === selDay` (the
     currently-selected day's route is the one on the map).
   - `allOverlayActive` — `_activeDaycareOverlay.allDays` (the combined
     all-days route is on the map).
2. The two buttons now render their label from those flags:
   - `.daycare-show-on-map` → `"Hide on map"` when `dayOverlayActive`, else
     `"Show on map"`.
   - `.daycare-show-all-on-map` → `"Hide all on map"` when `allOverlayActive`,
     else `"Show all on map"`.
3. Each click handler became a toggle: if its overlay is already active it
   calls `_clearDaycarePathOverlay()` then `renderDaycare(opts)` (so the label
   flips straight back); otherwise it does the existing show call.

**How the flow works / why this is correct:**
- Tapping "Show on map" calls `showDaycarePathOnMap()`, which sets
  `_activeDaycareOverlay` and then `hide()`s the inventory panel. So the button
  isn't visible while the route is up — the user sees the map + the existing
  calendar bubble. The "Hide on map" state is what they get when they *reopen*
  the daycare: `renderDaycare` re-reads `_activeDaycareOverlay` on every render,
  so the label is always in sync with what's actually on the map.
- Both un-toggle paths remain: the map calendar bubble (`_clearDaycarePathOverlay`)
  and now the daycare button. They share the same clear function, so state stays
  consistent no matter which one the user uses ("either will work", per the task).
- The re-render-after-clear (`renderDaycare(opts)`) mirrors the existing month-nav
  and calendar-cell handlers, which already re-render this way — `opts` is
  captured from the `renderDaycare(opts)` closure.
- Reading `_activeDaycareOverlay` (a `let` declared textually later at
  creatures.js:13222) from `renderDaycare` is safe: the function only runs on
  user action, long after module init. The existing code already calls the
  later-declared `showDaycarePathOnMap` / `_clearDaycarePathOverlay` from here.

**Edge cases considered:**
- All-days overlay active + user taps single-day "Show on map": replaces the
  all-days overlay with that day's route (`_activeDaycareOverlay` becomes
  `{ dayKey }`). Reasonable — it's a view switch, not a no-op.
- Overlay cleared via the map bubble while the panel is closed: next open reads
  `_activeDaycareOverlay === null` → both buttons show "Show …". Correct.

**Verification:** `node --check static/creatures.js` clean. Full unit suite run
individually: 18/19 pass — the one failure (`tests/trip-planner.test.js`) is
**pre-existing and unrelated** (calls a removed `planTransitTrip` API), same as
noted in the bag-sort task. `tests/daycare-odds.test.js`, which extracts and
exercises `renderDaycare` helpers, passes.

**Assumptions / not done:**
- Not verified in a running browser (parse-check + unit tests only), consistent
  with prior tasks' verification level. The change is a label swap + a guarded
  early-return in two click handlers, so behavioral risk is low.
- Kept the CSS classes/styling untouched — only the text content and click
  behavior change, so "Hide on map" reuses the accent-filled button style and
  "Hide all on map" the outlined one.
