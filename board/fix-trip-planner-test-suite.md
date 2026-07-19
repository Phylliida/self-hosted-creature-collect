---
title: tests/trip-planner.test.js fails — global.TripPlanner is undefined
status: todo
claimed_by: 
created: 2026-07-19T20:40:00Z
updated: 2026-07-19T20:40:00Z
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
