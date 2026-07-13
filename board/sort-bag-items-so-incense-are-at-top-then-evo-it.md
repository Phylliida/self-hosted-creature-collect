---
title: Sort bag items so incense are at top, then evo items, then pokeballs
status: done
claimed_by: claude-opus
created: 2026-07-13T18:23:18Z
updated: 2026-07-13T19:20:00Z
---

## Description

The bag (Creatures → inventory panel, `renderBag()` in `static/creatures.js`)
sorted every item purely by count-descending then name. The player wants a
category ordering instead:

1. Incense (top)
2. Evolution items
3. Poké balls
4. (anything else — e.g. `test_orb` placeholder — falls to the bottom)

Within a category the existing count-desc / name-asc tiebreak is kept.

## Progress

- (2026-07-13) Located bag render: `renderBag()` at creatures.js:8626. Sort was
  inline (count desc, name asc).
- Classification signals: incense items have `meta.incenseType`; evo items are
  the keys in `EVO_ITEM_KEYS`; balls have `meta.catchShakeRate`
  (poke_ball/great_ball). Everything else (test_orb) is "other".
- Implemented, added a test, ran the suite. Done.

## Writeup

**What changed (all in `static/creatures.js`):**

1. Added `const EVO_ITEM_SET = new Set(EVO_ITEM_KEYS);` right after the
   `EVO_ITEM_KEYS` loop (~line 424) — a fast membership test for the ranker.
2. Added two small functions just before `renderBag()`:
   - `_bagEntryRank(key)` → category rank: incense `0`, evo item `1`, poké ball
     `2`, everything else `3`. Uses the catalog signals above (`meta.incenseType`
     / `EVO_ITEM_SET.has(key)` / `meta.catchShakeRate`).
   - `_sortedBagEntries(bag)` → the old filter+sort, now with the category rank
     as the **primary** key, then the original count-desc, then name-asc. Pulled
     out of `renderBag` so it's unit-testable.
3. `renderBag()` now just calls `const entries = _sortedBagEntries(bag);`.

**How the code works / where things live:**
- The bag is a flat `{ <key>: <count> }` map (`readBag()`), same shape as candy.
- Item metadata lives in the `ITEMS` catalog. Incense entries (registered per
  type, ~line 2956) carry `incenseType`; evo entries are registered from
  `EVO_ITEM_KEYS` (~line 411); `poke_ball`/`great_ball` carry `catchShakeRate`.
  These three signals are exactly what the ranker keys off — no separate list to
  keep in sync.
- The battle-screen ball strip (`populateBattleBalls`, ~line 12220) is a
  *separate* list driven by the explicit `THROWABLE_BALL_KEYS` order and was
  intentionally left alone — it is not the bag inventory.

**Tests:** new `tests/bag-sort.test.js` (10 assertions, all passing) covers the
category ranks, the full cross-category ordering with count/name tiebreaks, and
zero-count filtering. It uses the same `extract()`+`vm` harness as
`tests/daycare-odds.test.js`, stubbing a representative `ITEMS` catalog and
`EVO_ITEM_SET`. Full suite: 18/19 test files pass; the one failure
(`tests/trip-planner.test.js`) is **pre-existing and unrelated** — that test
calls `planTransitTrip`, an API that no longer exists on the planner module.

**Assumptions:**
- "Anything else" (currently just the `test_orb` daycare placeholder) belongs at
  the bottom, below poké balls. The task named only three tiers; this is the
  natural reading.
- Kept the prior within-category ordering (count desc, then display name) so the
  change is purely additive — items only move *between* groups, not within.
- Not verified in a running browser (JS `--check` parse-clean + unit tests only).
