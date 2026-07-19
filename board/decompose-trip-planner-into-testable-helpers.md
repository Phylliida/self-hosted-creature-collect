---
title: (optional refactor) decompose trip planner into pure, testable helpers
status: todo
claimed_by: 
created: 2026-07-19T21:25:00Z
updated: 2026-07-19T21:25:00Z
taiga_id: 76
taiga_version: 1
synced_hash: 645a941aabe0f3b9
---

## Description

Captured while closing `fix-trip-planner-test-suite`. The deleted
`tests/trip-planner.test.js` was an **aspirational spec** for a trip-planner API
that was never built. It's worth keeping the design intent on record in case we
ever want to make the planner properly modular.

The intended shape (from the old test file — see git history for the full 606-line
spec, last present at commit `0622e47e`):

- `TripPlanner.helpers` — pure, independently unit-testable functions:
  - `groupLegs(steps)` — collapse the raw origin→dest step chain into walk/access/
    transit/egress **legs** (this logic currently lives INLINE in `index.html`
    around line ~9640 as an anonymous `flushWalk()` loop).
  - `retimeLegs(legs, startSec)` — pack slack out of walk legs while keeping transit
    legs on their scheduled times; returns `{ legs, endSec }`.
  - `costOfPlan(plan, walkWeight)` — walk seconds × weight + non-walk seconds × 1.
  - `makeTripLookup(tripsByPattern, dayOffsetFn, serviceSets)` — the memoized
    active-trips closure (currently `makeActiveTrips` inline in `index.html` ~9702).
  - `pickBestTrip(trips, transferSec, dir, bound, cum)` — earliest-dep / latest-arr
    selection (currently inline in the planner's board loop).
  - `initSearch`, `relax`, `reconstruct` — extract the PQ seed / edge-relax /
    traceback primitives out of `planForward`/`planReverse`.
- `TripPlanner.constants` — the magic numbers (walk speed, default weights, etc.).
- `create(deps).planTransitTrip(origin, dest, Date, walkWeight, transferSec)` and
  `.planTransitTripArriveBy(...)` — high-level wrappers that take a `Date`, run the
  low-level `planForward`/`planReverse`, then `groupLegs` + `retimeLegs`, returning
  `{ legs, startSec, endSec, totalSec }`. Today `index.html`'s `planAlternatives`
  does this glue inline.

**Why this is optional, not urgent:** the shipped planner works and its core
(`planForward`/`planReverse`) is well covered by `tests/trip-planner-search.test.js`
(golden fixtures + yield/stress checks). This task is purely about testability /
code health — extracting the `index.html` glue into `trip-planner.js` so it can be
unit-tested without a browser. Only take it on as a deliberate refactor, not to
satisfy a broken test.

Done = the leg-grouping / retiming / trip-lookup / alternatives logic moves out of
`index.html` into exported `trip-planner.js` helpers, `index.html` calls them, and a
new test file exercises the pure helpers directly.
