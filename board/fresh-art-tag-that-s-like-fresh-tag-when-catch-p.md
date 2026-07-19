---
title: Fresh art tag that's like Fresh tag (when catch poke) except for Art that we've seen but then evolved so we don't have any
status: done
claimed_by: claude-opus
created: 2026-07-19T19:22:09Z
updated: 2026-07-19T20:55:00Z
taiga_id: 69
taiga_version: 4
synced_hash: 2be9077039254cbd
---

## Description

The encounter (battle) screen shows a corner badge:
- **New** — never caught this fusion
- **Fresh** — caught it before but evolved our copy away (re-catch of a fusion we
  no longer own)
- **New Art** — we own the fusion but not *this* art variant

The request: add a **Fresh Art** badge that is to "New Art" what "Fresh" is to
"New" — for an art variant we've *seen before* but no longer own (e.g. we caught
it, then evolved it away, so we don't have that art anymore).

## Progress

- (2026-07-19) Traced the badge logic to `openBattleScreen` in
  `static/creatures.js` (~12740). Badge string is set by `showNewBadge()`; the
  art tier is decided by `decideArtBadge(variant)` which today does
  `ownsVariant(...) ? '' : 'New Art'` when `ownsFusion` is true.
- Key gotcha: `markFusionSeen(...)` runs *before* `decideArtBadge(...)` in both
  the sync and async branches, and it records the current variant into the seen
  store. So a live `hasSeenVariant()` call inside `decideArtBadge` would ALWAYS
  be true. Must snapshot the seen-variants set BEFORE `markFusionSeen`, exactly
  like the existing `caughtAway` snapshot does for the fusion-level Fresh badge.
- Decision (seen-based, matches the user's wording "Art that we've *seen*"):
  Fresh Art = own the fusion via some other art, don't own this art, but had
  already seen this exact art coming in. No new persisted data, no backfill.
- CSS: `.battle-new-badge` is `white-space: nowrap` + auto width; "New Art"
  already exists, so "Fresh Art" needs no style change.

## Writeup

**What I did:** Added a **Fresh Art** badge tier to the encounter screen, sitting
between "New Art" and "no badge", exactly parallel to how the fusion-level
"Fresh" sits between "New" and nothing.

**Where:** `static/creatures.js`, `openBattleScreen` (~12750). Two changes:
1. Snapshot `seenVariantsBefore = readSeenVariants(a, b)` up front (right after
   the existing `caughtAway` snapshot), plus a `hadSeenVariant(variant)` helper
   that normalizes the variant key ('auto' for null/autogen, stringified int for
   a custom slot) the same way `hasSeenVariant` does.
2. `decideArtBadge(variant)` now has three tiers when we own the fusion:
   - own this exact art → `''`
   - `hadSeenVariant(variant)` but don't own it → `'Fresh Art'`
   - otherwise → `'New Art'`

**The one non-obvious bit (why the snapshot):** `markFusionSeen()` runs *before*
`decideArtBadge()` in both the sync and async branches of openBattleScreen, and
it records the just-encountered variant into `seen[key].variants`. A live
`hasSeenVariant()` call inside `decideArtBadge` would therefore always be true
for the current art, collapsing "New Art" into "Fresh Art". So "had we seen this
art coming in?" must be answered from a snapshot taken before the mark — the same
pattern the existing `caughtAway` read uses ("what did we know coming in").

**CSS:** none needed. `.battle-new-badge` is `white-space: nowrap` with padding
auto-width; "New Art" was already a two-word label, so "Fresh Art" fits.

**Semantics / assumption (a deliberate fork):** I implemented this as
**seen-based**, matching the user's own wording ("Art that we've *seen* but then
evolved so we don't have any") and the existing dex data model, which is
seen-based throughout. Concretely: Fresh Art = we own the fusion via some other
art, we don't own *this* art, and this art was already in our dex.
- `readSeenVariants` unions the captures store with `seen[key].variants`. Because
  Fresh Art only fires when `!ownsVariant`, the current art can't be coming from
  the captures store — its presence in the snapshot is purely "encountered/seen
  before", which is exactly the intent.
- **Imprecision to be aware of:** an art you merely *encountered* before (opened
  a battle screen for, then fled) but never actually caught will also read
  "Fresh Art" on re-encounter. The strictly-parallel-to-"Fresh" alternative
  would be *caught*-then-evolved-away, but that needs a new per-variant
  "caught away" flag (the current `caught` flag is fusion-level only) plus a
  one-time backfill — a materially bigger change. If you want that stricter
  version, it's a clean follow-up; say the word.

**Tests:** added `tests/fresh-art-badge.test.js` (6 assertions) — extracts the
real `readSeenVariants` / `ownsVariant` / `markFusionSeen` from source and runs
the actual snapshot→mark→decide sequence to prove all three tiers, the
autogen(null) parity, and specifically the regression that a first-time art
still reads "New Art" even though markFusionSeen records it a line earlier. Full
suite: 43/43 green. `node --check static/creatures.js` clean.

**Not verified on-device:** logic is covered by the headless harness; I could not
run the full app (MapLibre WebGL won't init headless), so the visual badge on a
real encounter is unconfirmed, though it reuses the existing `.battle-new-badge`
element and animation unchanged.
