---
title: Remove force shiny catches testing settings
status: done
claimed_by: claude-opus
created: 2026-07-13T18:25:09Z
updated: 2026-07-13T19:45:00Z
---

In settings we have a "force shiny catch", remove this setting (we can keep the code intact for testing, just remove it from settings menu)

## Progress

- (2026-07-13) Located the setting. Visible UI: `static/index.html:3395-3398`
  (a `.row` with `<label for="forceShinyToggle">` + the checkbox). Wiring:
  `static/index.html:16293-16303` (reads/writes `localStorage cc.forceShiny`).
  The actual test hook `_forceShinyOn()` lives in `static/creatures.js:673`
  and reads `cc.forceShiny` from localStorage — that stays intact so testers
  can still flip the flag manually.
- Removed the HTML row and the JS toggle wiring; left the creatures.js reader
  untouched. Verified no `forceShinyToggle` references remain; test hook still
  present. Full suite 18/19 (only pre-existing `trip-planner.test.js` fails).

## Writeup

**What changed (all in `static/index.html`):**

1. Deleted the settings `.row` (was ~3395-3398): the
   `<label for="forceShinyToggle">Force shiny catches (testing)</label>` +
   its checkbox `<input id="forceShinyToggle">`. The settings menu now goes
   straight from "Debug console" to "Guaranteed catch (accessibility)".
2. Deleted the JS wiring block (was ~16293-16303) that initialized the
   checkbox from `localStorage 'cc.forceShiny'` and wrote it back on change.
   Replaced it with a 3-line comment noting the toggle was removed and that
   the underlying hook still reads the flag.

**What was intentionally kept (the "code intact for testing" part):**

- `static/creatures.js:673` `_forceShinyOn()` — reads
  `localStorage.getItem('cc.forceShiny') === '1'`.
- Its two call sites at `creatures.js:801` and `:814` (the shiny roll:
  `const hit = _forceShinyOn() || (Math.random() < rate)`).

So the mechanism is fully functional; a tester can still force shinies by
setting `localStorage.setItem('cc.forceShiny','1')` in a devtools console.
Only the discoverable settings-menu toggle is gone.

**Verification:**
- `grep forceShinyToggle static/` → no matches (UI fully removed).
- `grep 'cc.forceShiny\|_forceShinyOn' static/` → only the creatures.js
  reader/call-sites remain (plus the explanatory comment in index.html).
- Both edits were whole-block deletions (a complete `<div class="row">` and a
  complete comment+`const`+`if` block), so surrounding HTML/JS structure is
  unchanged — confirmed by reading the adjacent regions.
- Full test suite: 18/19 test files pass. The lone failure,
  `tests/trip-planner.test.js`, is pre-existing and unrelated (documented on
  the previous task); no test touches index.html.

**Assumptions:**
- "Remove from settings menu" means removing the visible row and its toggle
  wiring, not the localStorage-flag mechanism — the task explicitly says to
  keep the code for testing. Removing the wiring (rather than leaving a dead
  `getElementById` on a now-missing element) is the cleaner reading.
- Not verified in a running browser; this is a static markup/JS removal
  reviewed by inspection + grep + the unit suite.
