---
title: Add a little i bubble next to guaranteed catch option in settings that makes a popup that explains how it works (and why it is still balanced etc.)
status: done
claimed_by: claude-opus
created: 2026-07-13T19:15:46Z
updated: 2026-07-13T19:15:46Z
taiga_id: 64
taiga_version: 1
synced_hash: 5b09e3f73114d503
---

## Description

The Settings menu has a "Guaranteed catch (accessibility)" toggle. Add a small
round "i" bubble next to it that opens an explainer popup describing how the
feature works and why it's still balanced (same balls, same odds, slightly
slower — one tap instead of many).

"Done" looks like: an "i" button in the settings row that opens a themed popup
(reusing the generic `_openInfoModal` primitive) explaining the mechanic.

## Progress

- (2026-07-13) Reused the generic info-modal primitive (`_openInfoModal`) that
  the incense explainer added. Key facts:
  - `#ccInfoModal` + all `.cc-info-*` content classes are styled at top level
    (creatures.js CSS ~5824-5967), NOT scoped under `#creatureInventory`, and
    the modal root is appended to `document.body` — so it renders fine when
    triggered from the settings panel. z-index 60 > settings panel's 30.
  - Guaranteed-catch mechanic lives in `_guaranteedThrowPlan` (creatures.js
    ~703) + `_guaranteedCatchOn` (~685). Settings toggle wiring is in
    index.html ~16297 (`steadyCatchToggle`, localStorage key `cc.steadyCatch`).
    MARGIN=1.1 → sequence runs ~10% longer than manual; each hidden re-roll
    spends a real ball; bag-empty → creature breaks free.
- (2026-07-13) Implemented `_steadyCatchInfoHtml()` + `_showSteadyCatchInfo()`
  in creatures.js, exposed as `Creatures.showSteadyCatchInfo`, added the "i"
  button (`#steadyCatchInfoBtn`, reusing `.settings-info-btn` style) to the
  settings row + click wiring in index.html. Added tests/steady-catch-info.test.js.

## Writeup

Added an "i" info bubble beside the **Guaranteed catch (accessibility)** toggle
in Settings; tapping it opens a themed explainer popup.

**What was built**
- `static/creatures.js`:
  - `_steadyCatchInfoHtml()` — builds the popup body using the shared
    `.cc-info-*` content classes (same look as the incense explainer). Two
    sections: "What actually happens" (under the hood / ball cost / bag runs
    out) and "Why it's still balanced" (same odds / same-ish time / just less
    tapping), plus a one-line summary.
  - `_showSteadyCatchInfo()` — opens it via the generic `_openInfoModal({ title,
    html })` primitive. No `onWire` needed (no interactive elements); the modal's
    ← at the root simply closes.
  - Exposed as `Creatures.showSteadyCatchInfo` on the `global.Creatures` surface
    so the Settings menu (index.html) can trigger it.
- `static/index.html`:
  - Added `<button id="steadyCatchInfoBtn" class="settings-info-btn">` in the
    toggle's `.row`, placed **outside** the `<label>` so tapping it doesn't flip
    the checkbox.
  - Wired its click to `window.Creatures.showSteadyCatchInfo()` (guarded by a
    typeof check), right after the existing `steadyCatchToggle` wiring.
- `tests/steady-catch-info.test.js` — extracts `_steadyCatchInfoHtml` via the
  same comment-aware brace extractor the incense test uses and asserts the copy
  covers the mechanic (real ball cost, ~10% longer, unchanged odds, breaks free
  when the bag empties, less tapping) and uses the shared modal classes. Also
  greps the source to confirm the `Creatures.showSteadyCatchInfo` export wiring.

**How it works / why it renders from Settings**
- `#ccInfoModal` and all `.cc-info-*` / `.cc-modal-*` styles are defined at top
  level (creatures.js CSS ~5824-5967), not scoped under `#creatureInventory`,
  and the modal root is appended to `document.body`. So it renders correctly no
  matter what triggers it. z-index 60 sits above the Settings panel's 30, so the
  popup stacks over the open Settings sheet; closing it returns to Settings.

**Copy accuracy** — mirrors `_guaranteedThrowPlan` (creatures.js ~703):
every hidden re-roll spends a real ball at the ball's normal odds; MARGIN=1.1 →
the visible sequence runs ~10% longer than the equivalent manual throws; and if
the bag empties before a roll succeeds the creature breaks free (so it's
"guaranteed" only while you have balls).

**Verification** — `node tests/steady-catch-info.test.js` (11 passed) and the
full suite runs green except the pre-existing, unrelated `trip-planner.test.js`
failure (`planTransitTrip` no longer exists in `static/`; that test touches
neither creatures.js nor index.html). `node --check static/creatures.js` passes.

**Not done / assumptions**
- Not visually verified in a running browser (the PWA needs map/GPS); confidence
  rests on the unit tests + syntax checks + the fact that the modal CSS/plumbing
  is already proven by the shipped incense explainer.
- Reused `.settings-info-btn` styling for the bubble (matches the existing
  Visibility "i" button). Didn't set `aria-expanded` since this opens a modal
  rather than an inline note; kept the row's existing `title` tooltip as a
  quick desktop hover hint.
