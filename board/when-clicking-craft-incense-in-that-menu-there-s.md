---
title: When clicking craft incense in that menu there's a little i next to the top (same styling as daycare i) that explains in detail how incense works
status: in_progress
claimed_by: claude-opus
created: 2026-07-13T18:49:39Z
updated: 2026-07-13T20:15:00Z
---

It should explain odds and also have a seperate menu you can open that describes typing chart in a concise way (up to you how to best visualize it feel free to go wild with it)

## Progress

- (2026-07-13) Claimed. Explored the pieces:
  - Daycare "i" pattern = `.dc-odds-info` button (creatures.js:7117) wired at
    7456-7457 → `_showDaycareOdds()` → full-screen `#ccDaycareOdds` overlay modal
    (`_ensureDaycareOddsEl` @9139, `_daycareOddsHtml` @9091). CSS `#ccDaycareOdds`
    @5711-5813, button style `#creatureInventory .dc-odds-info` @5702.
  - Craft view header: `<h3 class="craft-title">` (creatures.js:7132), title text
    is overwritten per-step by `_craftSetTitle` (@8775, uses `textContent`) — so the
    "i" button must live OUTSIDE the overwritten text node (wrap text in a span).
  - Incense mechanics (for accurate odds copy):
    * Duration 30 min, one active at a time; activating replaces the current one
      (`activateIncense` @3000, `INCENSE_DURATION_MS` spawns.js:839).
    * While active: a 2nd spawn stream at 0.5× density layers on top (~+50% mons);
      each incense spawn = incense type in one slot + other slot 40% random /
      30% weekly theme / 30% daily theme (spawns.js:867-897); incense spawns get
      **2× shiny rate** (creatures.js:797).
    * Crafted from eggs (Bag → Craft). Egg qualifies if a type is
      neutral-or-effective vs the incense type; each egg type super-effective vs
      the incense type = +1 yield (1×/2×/3×) — `craftMultiplier` @2921,
      `_TYPE_STRONG` @2894, `_TYPE_REDUCED` @2855.

## Writeup

(pending — implementing generic reusable info modal + incense explainer + type
chart explorer)
