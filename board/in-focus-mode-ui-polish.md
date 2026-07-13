---
title: in focus mode ui polish
status: done
claimed_by: claude-opus
created: 2026-07-13T21:27:38Z
updated: 2026-07-13T22:40:00Z
---

in focus mode double tap to zoom should be disabled and rotate and zoom lock should be applied if enabled in settings

## Progress
- (2026-07-13) Claimed. Located focus mode in static/index.html (~line 6333):
  `_applyFocusMode` swaps MapLibre's native pan/rotate/pinch for a custom
  two-finger pinch (`_focusTouchStart` / `_focusTouchMove`) that zooms/rotates
  around the map centre (= player). Found the "Lock zoom" / "Lock rotate"
  Settings toggles (localStorage `cc.lockZoom` / `cc.lockRotate`, applied via
  `applyZoomLock` / `applyRotateLock` ~line 16259).
- (2026-07-13) Found three gaps: (1) `_applyFocusMode` never disabled
  `map.doubleClickZoom`, so double-tap still zoomed toward the tap point and
  dragged the centre off the player; (2) the custom pinch's `setZoom` /
  `setBearing` calls bypass MapLibre's own handlers, so they ignored the locks
  entirely; (3) exiting focus mode unconditionally re-enabled dragRotate /
  touchZoomRotate, silently undoing an active lock.
- (2026-07-13) Implemented + added tests/focus-mode-locks.test.js (15 assertions,
  all passing). Ran full suite: only pre-existing trip-planner.test.js fails
  (unrelated — it exercises static/trip-planner.js, untouched here).

## Writeup

**What changed** (all in `static/index.html`, focus-mode block ~line 6350):

1. **Double-tap zoom disabled in focus mode.** `_applyFocusMode(true)` now also
   calls `map.doubleClickZoom.disable()`. MapLibre's double-tap/double-click
   zoom targets the tap point, which pulls the viewport off the player — exactly
   what focus mode is meant to prevent.

2. **Locks honoured by the custom pinch.** `_focusTouchStart` now snapshots the
   two Settings flags into `_pinchZoomLocked` / `_pinchRotateLocked` (read once
   per gesture, not per touchmove). `_focusTouchMove` skips its `setZoom` call
   when zoom is locked and its `setBearing` call when rotate is locked. The two
   axes are independent, so e.g. lock-rotate-only still lets you pinch-zoom.

3. **Lock-aware restore on exit.** `_applyFocusMode(false)` re-enables dragPan
   and touchZoomRotate as before, but now only re-enables `dragRotate` /
   `doubleClickZoom` when the matching lock is *off*; when a lock is on it
   re-asserts the disabled state (`dragRotate.disable()` +
   `touchZoomRotate.disableRotation()` for rotate, `doubleClickZoom.disable()`
   for zoom). Previously, entering then leaving focus mode quietly broke a lock.

**How it fits together.** The locks were already wired end-to-end for normal
(non-focus) map use via `applyZoomLock`/`applyRotateLock`. Focus mode replaces
the native gesture handlers with custom ones, so those handlers had to be taught
about the locks separately — that's what this change does. `toggleFocus` already
respected `cc.lockZoom` for the initial activation zoom (keep current zoom vs.
snap to 16), so this makes the rest of focus mode consistent with that.

**Testing.** tests/focus-mode-locks.test.js extracts the focus-mode source block
from index.html by brace-matching (same trick as bag-sort.test.js) and runs it
in a `vm` sandbox with a mock `map` + `localStorage`. It verifies the full
lock matrix for the pinch (zoom/rotate applied only when unlocked) and the
enter/exit handler state for `_applyFocusMode`. `node tests/focus-mode-locks.test.js`
→ 15 passed, 0 failed.

**Assumptions / notes.**
- Locks are snapshotted at pinch start; toggling a lock in Settings *mid-pinch*
  won't affect the in-flight gesture (it applies from the next gesture). This is
  the natural flow (set locks, then use the map) and matches how `toggleFocus`
  reads the flag once at activation.
- Changing a lock toggle *while focus mode is already active* still routes
  through `applyRotateLock`/`applyZoomLock`, which touch the native handlers.
  Since focus mode has those native handlers disabled anyway, and the custom
  pinch re-reads the flag each gesture, the pinch behaviour stays correct. The
  one untidy edge is desktop mouse drag-rotate if you toggle lock-rotate *off*
  during focus mode — a negligible case (focus mode is a touch feature). Left
  as-is to avoid over-coupling the two subsystems.
