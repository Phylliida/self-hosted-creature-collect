---
title: Egg icon when egg ready on map (can click to immediately hatch it and go to hatched poke)
status: done
claimed_by: claude-opus
created: 2026-07-13T18:52:05Z
updated: 2026-07-13T22:58:00Z
---

put it in similar place as the daycare "show on map" calender icon shows up on the map

## Progress
- (2026-07-13) Oriented on the code. Map bubbles are MapLibre IControls added to
  the bottom-right cluster and reordered to the top. Templates:
  `_DaycareBubbleControl` (~line 14054) and `_RadarBubbleControl` (~13770). The
  radar bubble is the closest match — conditionally shown, accent-tinted.
- Egg model: `readEggs()` (sync localStorage `cc.eggs.v1`), `eggReadyToHatch(egg)`
  = incubated ≥ INCUBATOR_HATCH_M (5 km). Only incubator-slotted eggs accrue
  distance in `_creditMeters`, which fires `cc-incubator-tick` when an egg crosses
  the threshold. `hatchEgg(eggId)` (async) creates the level-1 capture, removes the
  egg, and the eggs-view handler then calls `showDetail(entry.id)`.
- Implemented `_EggReadyBubbleControl` + helpers, wired into `install()` and
  `hatchEgg()`. Added a pure-predicate seam + test. Full suite green (only the
  pre-existing, unrelated `trip-planner.test.js` fails — confirmed by stashing).

## Writeup

### What shipped
A new map bubble (`_EggReadyBubbleControl`) in `static/creatures.js` that appears in
the bottom-right MapLibre control cluster — the same place the daycare "show on map"
calendar bubble and the poké-radar bubble live — but **only** while at least one egg
is ready to hatch. It's an egg-with-a-crack glyph, accent-tinted (`var(--ui-accent)`)
since it's a call-to-action that only ever shows when actionable. Tapping it hatches
the ready egg and jumps straight to the new creature's detail page.

### How it works
- **Visibility rule** (`_anyEggReadyToHatch(eggs)` → `_updateEggBubble()`): the
  bubble's container `display` is toggled from `readEggs().some(eggReadyToHatch)`.
  `eggReadyToHatch` is `incubatedM >= INCUBATOR_HATCH_M` (5 km); `incubatedM`
  persists on the egg record, so a ready egg stays "ready" even if dragged out of an
  incubator slot — correct, since it can be hatched from anywhere.
- **When it refreshes**:
  1. On `install()` — one initial `_updateEggBubble()` so a resumed ready egg (from a
     previous session) shows the bubble on boot.
  2. On every `cc-incubator-tick` (dispatched by `_creditMeters` when walking bumps
     `incubatedM`) — crossing 5 km flips the bubble on. Listener wired once via
     `_eggBubbleTickWired`.
  3. At the end of `hatchEgg()` — so hatching (via the bubble OR the eggs-view
     "Tap to hatch") re-evaluates and hides the bubble once nothing is left to hatch
     (and keeps it up if a sibling egg is still ready).
- **Click flow** (`_hatchReadyEggFromMap`): finds the first ready egg, `await
  hatchEgg(id)` (async — it awaits the custom-art variant pick), then `show()` to open
  the inventory panel and `showDetail(entry.id)` to land on the hatched creature. This
  mirrors the existing eggs-view hatch handler; the extra `show()` is needed because
  from the map the panel isn't open yet. Back-nav from the detail returns to the
  collection (browse) view. An `_eggHatchInFlight` guard blocks double-taps during the
  async hatch.
- **Placement**: `_ensureEggBubble()` `addControl(..., 'bottom-right')` then reorders
  its container to the top of the cluster (`insertBefore(cluster.firstChild)`), exactly
  like the radar/daycare bubbles. Created lazily-once and cached in `_eggBubbleCtrl`.
- **No new CSS**: the button is fully inline-styled (same approach as the daycare and
  radar bubbles), so the giant `injectStyles` CSS template literal is untouched —
  sidesteps the known "no backticks in CSS template" footgun.

### Tests
- New `tests/egg-ready-bubble.test.js` (12 assertions) pins the threshold
  (`eggReadyToHatch` at/above/below 5 km, missing field) and the bubble predicate
  (`_anyEggReadyToHatch`: empty / in-progress-only / one-ready / all-ready / non-array
  defensive). Parses `INCUBATOR_HATCH_M` from source so it stays in lockstep if retuned.
- `hatchEgg` now calls `_updateEggBubble()`, so the two VM-extraction hatch tests
  (`hatch-candy`, `hatch-seen`) got a `_updateEggBubble: () => {}` stub added to their
  contexts — matching how they already stub `markFusionSeen` / `awardCandyForCapture`.
- Full suite: 28 passed, 1 failed — the 1 failure is `trip-planner.test.js`, which
  fails identically with my changes stashed (pre-existing, unrelated).

### Assumptions / notes
- Served source is `static/creatures.js` (Flask serves `static/` directly; the stale
  `dist/static/creatures.js` is a native-build artifact the human re-syncs via
  `cap sync`). No build step was needed for the web build.
- Shown independent of creature mode — hatching should always be reachable when an egg
  is ready. (The creature-ball + radar bubbles are creature-mode-gated, but hatching
  isn't a "creature mode" activity.)
- **Not verified in a live browser** — the bubble only appears once an egg has been
  walked to 5 km, which is impractical to trigger headlessly. Logic is unit-tested. To
  eyeball it manually: seed a ready egg, e.g. in the console set
  `localStorage['cc.eggs.v1'] = JSON.stringify([{id:'e1',speciesA:1,speciesB:2,incubatedM:5000}])`,
  then reload — the accent egg bubble should appear top of the bottom-right cluster;
  tapping it hatches and opens the creature.
- **Known minor edge**: a Settings "wipe eggs" doesn't fire `cc-incubator-tick`, so the
  bubble could stay shown until the next tick / reload. Same staleness class as the
  other bubbles on wipe; not worth an extra hook for a dev/testing path. Could be
  addressed later by dispatching a refresh from the wipe handler.
