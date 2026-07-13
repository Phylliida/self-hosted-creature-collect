---
title: Add a fresh annotation instead of new
status: done
claimed_by: claude-opus
created: 2026-07-13T21:07:44Z
updated: 2026-07-13T22:05:00Z
---

If a pokemon has already been caught but then evolved we shouldn't annotate catching it as "New" instead we can call it "Fresh" (otherwise same styling), so like just have A, evolved it to B, then caught another A it is annotated as fresh, but if we already have another A then it has no annotation like before

## Progress
- (2026-07-13) Traced the encounter "New" badge. It lives in `static/creatures.js`
  `openBattleScreen()` (~line 12550): `.battle-new-badge` showed `ownsFusion ? '' : 'New'`
  (and `'New Art'` when the fusion is owned but not this variant). `isFusionOwned`
  (line ~2825) = fusion present in the captured-creatures store. When you evolve
  A→B, `performEvolution` transforms the capture record in place (~line 3865), so you
  no longer "own" A — hence the current "New" on re-catch.
- Design: distinguish "ever caught, evolved away" from "never caught" via a persisted
  `caught: true` flag on the pre-evolution's seenFusions entry, set at *evolve time*
  (exactly correct — you can only evolve a creature you caught), plus a one-time
  best-effort backfill for pre-existing evolutions.
- Implemented + tested (`tests/fresh-annotation.test.js`, 14/14). Related regressions
  green (shiny-lineage 23/23, merge-seen 10/10). Verified no collision with the
  pokédex ✓ `caught-badge`: that view-model field (line ~10661) is built from
  `caughtFusionsSet()` (current ownership), not by spreading the seen entry.

## Writeup

### What changed (all in `static/creatures.js`)
Three-way encounter badge in `openBattleScreen`:
- **"New"** — never caught this fusion (`!ownsFusion && !caught`).
- **"Fresh"** — caught before but evolved our copy away (`!ownsFusion && caught`).
- **no badge / "New Art"** — currently own it (`ownsFusion`), unchanged.

Same `.battle-new-badge` pill (text-agnostic CSS: uppercase, nowrap), so "Fresh"
renders identically to "New"/"New Art" — matching the "otherwise same styling" ask.

### Mechanism
- New persisted field `caught: true` on a `seenFusions[key]` entry, meaning "the
  trainer had a captured copy of this fusion that has since left the collection."
- `markFusionCaughtAway(a, b)` (new helper, ~line 2484): sets the flag on an
  *already-seen* entry only (never mints a phantom dex row); idempotent.
- Evolve hook (`performEvolution`, ~line 3882): calls `markFusionCaughtAway(c.speciesA,
  c.speciesB)` right after marking the new form seen. Precisely correct by construction
  — you can only evolve something you caught. Setting it even while you still own
  another copy is harmless (the read is gated behind `!ownsFusion`).
- Badge read (`openBattleScreen`): `caughtAway = !ownsFusion && (seenEntry||{}).caught`.
- Backup restore (`mergeSeenFusions`): ORs the flag in monotonically so a restore
  never loses/clears it.
- One-time backfill `backfillCaughtAwayLineage` (~line 2755, wired into the boot
  `Species.ensureLoaded()` chain next to `backfillShinyLineage`): for trainers who
  evolved things *before* this shipped, reconstructs each current capture's evolve
  path via the existing `_shinyLineageAncestors` walk and flags the seen ancestor
  rows. Skips `E:` (radar/already-evolved) spawns, since their earlier forms were
  never actually caught by the trainer — same rule `backfillShinyLineage` uses.

### Assumptions / limitations
- **"Caught" ≠ merely "seen".** Opening a wild encounter marks a fusion *seen* even
  if you flee. The `caught` flag is set only by evolution (and the lineage backfill of
  currently-owned creatures), so a saw-and-fled fusion you never caught still reads
  "New" — faithful to the task's "already been caught".
- The backfill is **best-effort** for history: on a fully-ambiguous evolve lattice it
  reconstructs one plausible path (identical behavior to the shiny backfill). Going
  forward, the evolve-time hook is exact. Backfill runs once (`cc.caughtAwayBackfill.v1`)
  and only after evolution data has loaded.
- Did **not** touch the pokédex ✓ caught-badge (still current-ownership only) — the
  task scoped only the encounter annotation.
- Release-then-re-encounter isn't a case here (no release feature found); if one is
  added later, set the flag there too (or at catch time) for full generality.
