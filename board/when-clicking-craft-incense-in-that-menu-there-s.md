---
title: When clicking craft incense in that menu there's a little i next to the top (same styling as daycare i) that explains in detail how incense works
status: done
claimed_by: claude-opus
created: 2026-07-13T18:49:39Z
updated: 2026-07-13T20:55:00Z
---

It should explain odds and also have a seperate menu you can open that describes typing chart in a concise way (up to you how to best visualize it feel free to go wild with it)

## Progress

- (2026-07-13) Claimed. Explored the pieces:
  - Daycare "i" pattern = `.dc-odds-info` button (creatures.js:7267) wired at
    ~7611 → `_showDaycareOdds()` → full-screen `#ccDaycareOdds` overlay modal
    (`_ensureDaycareOddsEl`, `_daycareOddsHtml`). CSS `#ccDaycareOdds`, button
    style `#creatureInventory .dc-odds-info`.
  - Craft view header: `<h3 class="craft-title">`, whose text is overwritten
    per-step by `_craftSetTitle` (uses `textContent`) — so the "i" button had to
    live OUTSIDE the overwritten text node (wrapped the text in a span).
  - Incense mechanics gathered for accurate copy (30-min window, one active at a
    time, +50% extra spawn stream, guaranteed incense-type half + 40/30/30 other
    half, 2× shiny; craft yield 1×/2×/3× via super-effective egg types).
- (2026-07-13) Implemented + tested. `node --check` clean; new tests pass; full
  suite green except the pre-existing unrelated `trip-planner.test.js`
  (`planTransitTrip` removed API).

## Writeup

**What the user sees.** The Craft view (Bag → "Craft incense") now has a round
"i" button next to its title, styled identically to the daycare "i". Tapping it
opens a full-screen explainer popup (same card chrome as the daycare-odds popup)
titled **How incense works**, covering:

- What incense is + one-burns-at-a-time.
- *While it's burning (~30 min)*: ~+50% extra spawns; every incense spawn has the
  incense type on one half; a little stacked **odds bar** shows the other half's
  **40% any / 30% weekly theme / 30% daily theme** split; 2× shiny rate.
- *Crafting incense*: egg must be neutral-or-super-effective vs the incense type;
  yield 1× base, +1 per super-effective egg type (→ 2× / 3×).
- A **"See the type chart ›"** button that drills into a second view (the popup's
  ← now pops back to the incense info instead of closing).

**Type chart explorer.** A 3-col grid of all 18 type chips; tap one to see, for
that type: super-effective targets (2×), resisted/no-effect targets (½×/0×), and
— tying it to crafting — **"Best eggs for {Type} Incense"** (the inverse lookup:
types that are super-effective *against* that type, i.e. the egg types that craft
2×–3×). Opening the chart from mid-craft defaults the selection to the incense
type you were crafting.

**How the code works (all in `static/creatures.js`):**

1. *Header* — craft `<h3>` now wraps its title in `.craft-title-text` and holds a
   `.cc-info-btn.craft-info` "i" button. `_craftSetTitle` retargeted to the text
   span so per-step title changes don't clobber the button. The button is wired
   next to `.craft-back` → `_showIncenseInfo()`.
2. *Shared button style* — `#creatureInventory .dc-odds-info` selector generalized
   to also match `.cc-info-btn`, so the craft "i" is pixel-identical to daycare's
   with no new button CSS.
3. *Generic reusable info modal* — new `#ccInfoModal` overlay + `.cc-modal-*`
   classes mirror the daycare-odds card chrome, but content-agnostic with a small
   **internal view stack**: `_openInfoModal(view)`, `_pushInfoView(view)`,
   `_infoModalBack()` (pops, or closes at root), `_closeInfoModal()`,
   `_renderInfoModalTop()`. A "view" is `{ title, html, onWire? }` (html is a
   string or `() => string`; onWire runs after paint). Kept fully independent from
   the daycare modal (no daycare code touched → zero regression risk), and it's
   reusable for the pending **theme-types dropdown** task.
4. *Content builders* — `_incenseInfoHtml()`, `_typeDetailHtml(T)`,
   `_typeChartHtml()`, `_typeStrongAgainst(target)` (inverse of `_TYPE_STRONG`),
   plus `_ccTypeChip/_ccTypeChips`. All read the existing `_TYPE_STRONG` /
   `_TYPE_REDUCED` / `TYPE_COLORS` chart constants — no duplicated game data in
   the app.

**Tests (new):**
- `tests/incense-info.test.js` (16 assertions) — the inverse lookup (e.g. best
  eggs for Fire = Ground/Rock/Water), type-detail card structure (incl. Normal's
  "none" super-effective case), incense copy contents (30 min / 2× / +50% /
  40-30-30 / launcher), and that the chart grid renders all 18 types with the
  selected one marked `.sel`.
- `tests/info-modal.test.js` (14 assertions) — the new view-stack control flow
  end-to-end against a tiny DOM stub (open → push sub-view → back pops to root →
  back at root closes → reopen), since that stack is the one bit with no daycare
  precedent.

**Assumptions / not done:**
- Verified via `node --check` + the two new unit suites (pure logic + view-stack
  smoke), not in a running browser — consistent with the prior tasks' bar. The DOM
  wiring is a near-line-for-line copy of the proven daycare-odds modal.
- The other-half split is shown generically (Any / weekly theme / daily theme)
  rather than naming today's actual theme types — that concrete diagram is the
  separate "daily/weekly theme types dropdown" board task, which can reuse this
  same `_openInfoModal` infrastructure.
- Type effectiveness is presented single-type (attacker's own chart). Dual-type
  egg nuance (a fusion needs only ONE workable type; two super-effective types →
  3×) is explained in prose in the incense-info + chart intro copy rather than
  computed per-fusion in the chart.
