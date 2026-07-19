---
title: Some way to view dex percent of only non-evolved poke (so you can see what you still need to catch or hatch)
status: done
claimed_by: claude-opus
created: 2026-07-19T19:23:24Z
updated: 2026-07-19T19:23:24Z
taiga_id: 49
taiga_version: 3
synced_hash: f4bfb06ce2e247e2
---

We have this but it would be nice to also be able to filter the view of like all pikachu morphs (the one with on left and right) using filter at top as well

## Progress
- (2026-07-19) The completion LIST already had a "Show non-evolved only" filter
  (commit added earlier; `_completionNonEvolvedOnly` + `.completion-filter`).
  Read the request as: add the same filter to the *per-species partner grid*
  ("all pikachu morphs, one on left and right" = `renderSpeciesDex`, X×P left /
  P×X right). Implemented it as a symmetric mirror of the completion filter.

## Writeup
**What the request meant.** The completion list ("Completion" button in the
pokédex) already filters to non-evolved species. "All pikachu morphs (the one
with on left and right)" is the *species-dex* view you reach by tapping a
species — every partner P shown as X×P (head, left) and P×X (body, right). The
ask was a filter at the top of *that* view too.

**Change (all in `static/creatures.js`).** Added a `.speciesdex-filter` toggle
button to the `speciesdex-view` DOM, right under the title — same markup/label
as `.completion-filter`. Wired it to a new view-local flag
`_speciesdexNonEvolvedOnly` (independent of the completion flag). `renderSpeciesDex`
now filters its partner list with
`supportedSpeciesSorted().filter(p => !nonEvoOnly || !_isEvolvedSpecies(p))`,
drives the button's active/text/aria state, and — because the seen%/complete
stats loop already iterates `partners` (skipping legendaries) — the headline
`N/M seen` recomputes over the filtered set for free. The click handler toggles
the flag, resets sheet scroll, and re-renders the species on top of the view
stack. CSS: extended the existing `.completion-filter{,:hover,.is-active}` rules
to also select `.speciesdex-filter` (no new styling).

**Semantics.** "Non-evolved" reuses the existing `_isEvolvedSpecies` helper
(BFS from the candy-family root; pre-evo babies like Pichu count as non-evolved,
so they're kept). Legendaries are non-evolved and stay listed but, as elsewhere,
don't count toward the %. Before the evolutions JSON loads, `_isEvolvedSpecies`
returns `false` *uncached*, so the grid simply shows all partners until data
arrives (no stale hiding) — same behavior the completion list already has.

**Verification.** `node --check` passes. New `tests/speciesdex-nonevolved.test.js`
(13 assertions) does two things: (1) source-presence asserts that fail if any
piece of the wiring is removed (button, state var, partner-filter predicate,
click handler, stack re-render), and (2) replicates the pure filter + seen/total
aggregate on a stub pool ({1→2→3} + lone base {4}) and confirms toggle-off vs
toggle-on genuinely differ (X=1: 50% over 4 partners → 25% over the 2 non-evolved
partners). Existing `completion-nonevolved` / `completion-legendaries` suites
still pass. Full-app run not attempted — MapLibre WebGL init dies headless
(known), same constraint under which the original completion filter shipped.

**Assumptions.** The two filters are intentionally independent (toggling one
doesn't move the other); the species-dex filter, like the completion one, is
view-local and not persisted across app restarts.
