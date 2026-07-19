---
title: Some way to view dex percent of only non-evolved poke (so you can see what you still need to catch or hatch)
status: done
claimed_by: claude-opus
created: 2026-07-13T22:15:32Z
updated: 2026-07-13T22:25:00Z
taiga_id: 65
taiga_version: 1
synced_hash: a4a60d75d5e38215
---

probably some toggle towards the top or something, make sure to respect styling patterns we have elsewhere about toggles

## Progress
- (2026-07-13) Claimed. Reading completion view + evolution data model.
- (2026-07-13) Found `_isEvolvedSpecies(idx)` (creatures.js ~1933): a species is
  "evolved" iff reachable forward from its candy root — so base forms AND pre-evo
  babies (Pichu/Cleffa) are NOT evolved, only Raichu-style post-base forms are.
  That's exactly the "catch or hatch" set: `!_isEvolvedSpecies(id)`.
- (2026-07-13) Added a `.completion-filter` toggle chip to the completion view,
  tests green, committed.

## Writeup

**Goal:** in the pokédex Completion view, let the trainer flip the % (and the
list) to count **only non-evolved species** — the ones you actually catch in the
wild or hatch from eggs — so it's clear what's left to *find* vs. what you'll get
later by evolving.

**What "non-evolved" means here:** reused the existing `_isEvolvedSpecies(idx)`
helper (creatures.js ~1933). It BFS-walks forward from a species' *candy root*, so
pre-evolution babies (Pichu, Cleffa) and base forms count as non-evolved, and only
post-base forms (Raichu) count as evolved. Non-evolved = `!_isEvolvedSpecies(id)`,
which is precisely the catch/hatch pool. No new evolution data needed.

**Changes (all in `static/creatures.js`):**
1. `computeSpeciesCompletion()` now tags each row with `evolved: _isEvolvedSpecies(id)`
   (alongside the existing `legendary`).
2. New view-local flag `_completionNonEvolvedOnly` (defaults off, not persisted —
   same lifetime model as the family-tree expand toggle).
3. `renderCompletion()`:
   - when the flag is on, filters the list to `!r.evolved` before sorting, so the
     grid shows only catchable species;
   - the headline recomputes over that same filtered set (still skipping
     legendaries, which are non-evolved and stay in the list but never count);
   - the headline label switches "overall" ⇄ "non-evolved";
   - updates the toggle button's label + `is-active`/`aria-pressed` state.
4. A `.completion-filter` toggle button in the `completion-view` skeleton, between
   the title and the stats line ("towards the top"). Styling matches the existing
   `.family-toggle` idiom (outlined text button) but centered like a filter pill,
   with an accent-filled active state using the standard
   `var(--ui-accent)` / `var(--ui-accent-text, #fff)` convention. Off label:
   "Show non-evolved only"; on: "Non-evolved only (to catch / hatch)".
5. Click handler toggles the flag, resets `.sheet` scroll to top (the row set
   changes length), and re-renders.

**Legendaries:** unchanged — they're non-evolved so they remain visible in both
modes, but they're still excluded from the headline % / "complete" tally exactly
as before (the `if (r.legendary) continue` in the aggregate loop).

**Tests:** new `tests/completion-nonevolved.test.js` (vm-extract of
`computeSpeciesCompletion`, same pattern as `completion-legendaries.test`): verifies
each row carries the right `evolved` flag; the list filter drops exactly the
evolved species; and the headline aggregate differs between full-pool (10/32→31%)
and non-evolved-only (6/16→38%) on a stub 3-stage line + lone base. Also added an
`_isEvolvedSpecies: () => false` stub to `completion-legendaries.test.js` so it
keeps passing with the new field. `node --check` clean. Full suite: 26/27 test
files green; the one failure is the pre-existing, unrelated `trip-planner.test.js`
(`groupLegs`/`planTransitTrip` not a function — no creatures.js reference).

**Not automated / assumptions:**
- The DOM render path (`renderCompletion` → `virtualizeGrid` → `SpriteStore`) can't
  run headless (MapLibre/WebGL dies), same limitation the earlier completion tasks
  noted; the button-label/headline DOM writes are simple and reviewed by reading,
  not screenshotted this pass.
- Filter state is session-local (resets when the app reloads). If persistence in
  the save file is wanted (like the radar-autogen toggle), that's a small
  follow-up — left out to keep this a view-local filter, matching other in-panel
  toggles.
- The per-species **speciesdex** detail page (`renderSpeciesDex`) is untouched;
  this filter only affects the top-level completion overview, which is what the
  task asked for.
