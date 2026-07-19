---
title: tests/trip-planner.test.js fails — global.TripPlanner is undefined
status: done
claimed_by: claude-opus
created: 2026-07-19T20:40:00Z
updated: 2026-07-19T21:20:00Z
taiga_id: 52
taiga_version: 1
synced_hash: 760e58de2761cc45
---

## Description

Noticed while running the full suite for an unrelated task; **pre-existing, not caused
by that work.**

`node tests/trip-planner.test.js` fails every single case with:

    TypeError: Cannot read properties of undefined (reading 'groupLegs')

The suite does `require('../static/trip-planner.js')` and expects that IIFE to attach
to `global.TripPlanner`. It isn't attaching — either the file now guards on `window`
rather than `global`, or it moved/renamed its export.

`tests/trip-planner-search.test.js` passes, so whatever broke is specific to what
`trip-planner.test.js` reaches for.

Done = the suite runs green again (or, if the module genuinely moved, the test is
updated to match and the reason is written up).

## Progress

- (2026-07-19) Diagnosed the real cause. It is **not** a `window`-vs-`global` guard
  and **not** a renamed export. `static/trip-planner.js` exports `{ create }` →
  `{ planForward, planReverse }` and always has. The test reaches for
  `TripPlanner.helpers.{groupLegs,costOfPlan,retimeLegs,pickBestTrip,makeTripLookup,
  initSearch,reconstruct}`, `TripPlanner.constants`, and
  `create(deps).{planTransitTrip,planTransitTripArriveBy}` — **none of which exist
  anywhere in the repo** (grepped `static/`; the wrapper/leg logic lives inline in
  `index.html` under different names, e.g. the `flushWalk` loop ~L9640 and
  `makeActiveTrips` ~L9702).
- (2026-07-19) Checked git: the test was committed **already-broken** at `fd677305`
  (2026-04-20) — at that very commit the module already exported only `{ create }`
  with no `helpers`. So this file has literally never passed; it's an aspirational
  spec for an API that was never implemented, not a regression.
- (2026-07-19) Confirmed `tests/trip-planner-search.test.js` already covers the real
  `planForward`/`planReverse` API (golden fixtures + yield/stress). No coverage lost
  by dropping the orphaned file.
- (2026-07-19) Sanity-checked the delete-vs-implement fork with the local companion
  model — agreed on delete (don't let a ghost-spec drive an architecture).

## Writeup

**Resolution: removed `tests/trip-planner.test.js` (option A — the module genuinely
never had this API).** Preserved the design intent as a new optional board task,
`decompose-trip-planner-into-testable-helpers`, so nothing is lost.

Why not "fix" it in place: the file isn't testing the shipped planner at all. It's a
606-line design document, in test form, for a decomposed `TripPlanner.helpers` /
`planTransitTrip` API that was never built. Making it green would mean either
implementing ~200+ lines of new helper code to match the spec exactly (duplicating
logic that already works inline in `index.html`) or refactoring the live routing
feature — a big, risky change for real users, well outside "fix the failing test."
The core planner (`planForward`/`planReverse`) stays fully covered by
`trip-planner-search.test.js`.

**Verification:**
- `node --test tests/*.test.js` → **36 passed, 0 failed** (was red on the orphaned
  file before).
- Every test file also passes when run its documented per-file way
  (`node tests/<name>.test.js`).

**Assumption / note for the next instance:** the string `node --test tests/`
(trailing directory, with no glob) prints `Error: Cannot find module '.../tests'` on
this Node (v24.15.0) — but that error is **pre-existing and unrelated** to this task
(it reproduces on a clean HEAD). It's just the wrong invocation for this Node
version; the working forms are per-file `node tests/x.test.js` or the glob
`node --test tests/*.test.js`. I did not "fix" that because it's a harness-invocation
quirk, not a test failure, and several of these files aren't written against
`node:test` anyway (they use a custom `ok()` + `console.error` harness).
