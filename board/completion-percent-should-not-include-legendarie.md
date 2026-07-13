---
title: completion percent should not include legendaries
status: done
claimed_by: claude-opus
created: 2026-07-13T19:19:38Z
updated: 2026-07-13T22:05:00Z
---

legendaries can still be displayed in the completion dex but the percent is about non-legendaries only (since legendaries are hard to get)

## Progress
- (2026-07-13) Mapped the completion model in static/creatures.js:
  - `computeSpeciesCompletion()` (~10791): each species X is "complete" when
    seen fused with every supported species (199) in both slots → denominator
    `2 * 199`. 4 of those 199 are legendaries (144/145/146/150; Mew 151 isn't a
    supported species), and legendary spawns are ~1/16000 → 100% was unreachable.
  - `renderCompletion()` (~10810): aggregates overall % + "N/M species complete".
  - `renderSpeciesDex()` (~10872): per-species detail page, "% · seen/total".
  - `_fusionShinyMultiplier`/`_speciesShinyBonus` (~743) read the same per-species
    pct → completion % also drives the shiny-rate bonus (100%→10×).
- Design (confirmed with local companion model): exclude legendaries from the
  PARTNER POOL used for counting, not just from the aggregate. A fusion only
  advances species X when the partner is non-legendary; denominator = `2 * 195`.
  Legendary species still get their own (uncounted) row in the completion list,
  and legendary partner cells still render in the detail grid as un-counted bonus.
  The shiny bonus rising to a reachable 10× is an intended consequence.

## Writeup

**What changed (all in `static/creatures.js`):**

1. New module-level constants next to `SUPPORTED_SPECIES_SET` (~line 3163):
   `LEGENDARY_SPECIES_SET = {144,145,146,150,151}`, `isLegendarySpecies(id)`,
   and `SUPPORTED_NONLEG_COUNT` (supported species minus the legendaries in the
   pool). Kept in lockstep with `GEN1_LEGENDARY_IDS` in spawns.js via a comment,
   matching the existing "keep in lockstep with species_pool.py" pattern — no
   new cross-module runtime dependency / load-order risk. Of the 5 gen-1
   legendaries only 4 (144/145/146/150) are actually in the supported pool; Mew
   (151) isn't a supported species, so `SUPPORTED_NONLEG_COUNT` = 199 − 4 = 195.

2. `computeSpeciesCompletion()`: a seen fusion now only advances a species when
   its **partner** is non-legendary (`if (!isLegendarySpecies(b)) head…`,
   `if (!isLegendarySpecies(a)) body…`). Denominator is `2 * SUPPORTED_NONLEG_COUNT`
   (was `2 * SUPPORTED_SPECIES_SET.size`). Each row now carries `legendary:<bool>`.

3. `renderCompletion()` headline: the overall % and the "N/M species complete"
   tally skip legendary rows (`if (r.legendary) continue`) and use a `counted`
   denominator (195) instead of `rows.length` (199). Legendary rows are **still
   rendered** in the grid list — displayed, just not counted.

4. `renderSpeciesDex()` per-species "% · seen/total" stat skips legendary
   partners so it agrees with that species' completion-dex row. The detail grid
   still iterates all partners, so legendary fusion cells still show as
   (uncounted) bonus cells.

**Why 100% is now reachable:** completion is a "seen every fusion in both slots"
goal. Because legendary spawns are ~1/16000, the old denominator (which required
fusions with all 4 in-pool legendaries) made 100% — and its rewards —
effectively impossible. Dropping legendaries from the partner pool makes the
goal attainable while still letting legendary species show up in the dex.

**Deliberate side effect (confirmed with the local companion model):** the same
per-species `pct` feeds `_speciesShinyBonus`/`_fusionShinyMultiplier` (completion
% → shiny-rate multiplier, 100%→10×). Excluding legendary partners raises `pct`,
so the top shiny bonus becomes actually reachable. This is the intended reward
for full completion — a "dead" bonus becoming a real end-game goal — not a
regression. Legendary spawns keep their separate flat 10× shiny rate; this only
changes the completion-derived morph bonus.

**Tests:** `tests/completion-legendaries.test.js` (13 assertions, vm-extract
pattern like theme-odds.test) verifies: denominator excludes legendaries;
legendary species still appear as rows flagged `legendary:true`; a legendary
partner does not advance a non-legendary species; a legendary's own row still
accrues its non-legendary partners; self-fusion counts both sides; out-of-pool
partners ignored; and the non-legendary aggregate the render code filters on.
All 13 pass; full suite green except pre-existing, unrelated `trip-planner.test.js`
(`planTransitTrip is not a function`, no reference to creatures.js).

**Assumptions / possible follow-ups (not done):**
- Legendary rows are shown unmarked. Could add a small "legendary — bonus"
  badge on the completion row / a tint on legendary partner cells so users see
  why those don't move the %. Left out to keep the change minimal.
- Existing saves are unaffected (completion is derived from seenFusions each
  render, nothing stored), so no migration needed.
