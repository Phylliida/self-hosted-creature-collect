---
title: press compass icon to align north shouldn't do anything when lock rotation is on
status: done
claimed_by: claude-opus
created: 2026-07-19T19:21:33Z
updated: 2026-07-19T19:52:00Z
---

## Description

The map's compass button (MapLibre `NavigationControl`) resets the bearing to
north when tapped. When the "Lock rotate" setting is on, the map's bearing is
supposed to be frozen — but the compass button still rotates it, which defeats
the lock.

"Done" = with Lock rotate on, the compass button is inert (no bearing change
from tapping it, and no drag-rotate off it either), and it looks visibly
non-interactive so it doesn't read as a broken button.

## Progress

- (2026-07-19) Claimed. Traced the pieces:
  - Compass is stock MapLibre: `map.addControl(new maplibregl.NavigationControl(), 'bottom-right')`
    at `static/index.html:6517`. Click handler in the vendored bundle is
    `maplibregl-ctrl-compass` → `this._map.resetNorth(...)`.
  - The compass button ALSO owns an independent drag-rotate wrapper (bound to
    `this._compass`, hence `touch-action:none` / `cursor:grab` on it in
    `static/vendor/maplibre-gl.css`). That handler is separate from
    `map.dragRotate`, so it survives `map.dragRotate.disable()`.
  - `applyRotateLock(locked)` (`static/index.html:16401`) is the single
    choke point for the setting — it snapshots the bearing and disables
    `dragRotate` / `touchZoomRotate` rotation / `touchPitch`, but never
    touched the compass. That's the whole bug.

- (2026-07-19) Implemented `_applyCompassLock` + CSS, added
  `tests/compass-rotate-lock.test.js` (14 asserts, green). Full suite re-run:
  all green except the pre-existing `trip-planner.test.js` failure, which I
  confirmed fails identically at HEAD with my changes stashed.

## Writeup

**What was wrong.** "Lock rotate" (`localStorage cc.lockRotate`) funnels through
`applyRotateLock(locked)` in `static/index.html`. It froze the bearing and tore
down `map.dragRotate`, `map.touchZoomRotate` rotation, and `map.touchPitch` — but
the compass button is part of MapLibre's stock `NavigationControl`
(`static/index.html:6517`) and doesn't go through any of those:

- Its click handler is bound directly to the `<button>` in the vendored bundle:
  `_createButton("maplibregl-ctrl-compass", t => this._map.resetNorth(...))`.
- It *also* owns a private drag-to-rotate handler bound to that same element
  (which is why `static/vendor/maplibre-gl.css` gives it `touch-action:none` and
  `cursor:grab`). That handler is constructed independently of `map.dragRotate`,
  so `map.dragRotate.disable()` does nothing to it.

So with the lock on you could still tap the compass to snap north, or drag it to
free-rotate — both silently defeating the setting.

**The fix.** Since neither path is reachable through the map's handler registry,
the button itself gets neutralised. New `_applyCompassLock(locked)` runs at the
top of `applyRotateLock` and:

- sets `button.disabled` — kills click *and* keyboard activation (it's a real
  `<button>`, verified in the bundle, so `disabled` genuinely suppresses the
  click listener), plus `aria-disabled` for screen readers;
- toggles a `.cc-compass-locked` class whose CSS sets `pointer-events: none` —
  **this** is what stops the drag-rotate, since the element stops being an event
  target at all — along with `opacity: .45` so it reads as inactive rather than
  as a button that's mysteriously broken.

**Design choice:** dim-and-disable rather than hide. The compass needle still
rotates with the map, so it stays useful as a *bearing indicator* — which is
arguably more valuable when rotation is frozen at a non-north bearing, because
it's the only on-screen cue for which way the locked map is pointing. Easy to
flip to `display:none` if you'd rather it just vanish.

**Startup ordering.** On the restore-from-settings path `applyRotateLock` can in
principle fire before the control is in the DOM, so `_applyCompassLock` returns
`false` when the button isn't found and `applyRotateLock` re-runs it on
`map.once('load')`. That deferred callback re-reads `cc.lockRotate` instead of
closing over the original argument, so a toggle flipped during load still wins
(covered by a test).

**Also checked:** `resetNorth` has no other callers in app code, and the only
other `setBearing` calls are the focus-mode pinch (already lock-gated at
`index.html:6437`) and the lock's own snapshot. So the compass was the last
remaining bypass — rotation should now be genuinely frozen while the lock is on.

**Verified:** `tests/compass-rotate-lock.test.js` (14 asserts) extracts both
functions out of `index.html` by brace-matching and drives them in a `vm`
sandbox against a mock map — covering lock on/off, idempotent re-locking, the
deferred path, the stale-argument case, and the presence of the CSS rule the
lock depends on. Selectors and `disabled`-semantics were checked against the
real `static/vendor/maplibre-gl.js` source, not just the mock.

**Not verified:** no run in a real browser. The documented headless-Firefox
harness can't help here — per the extras notes, the main script dies at MapLibre
WebGL init under headless, and this code lives inside that same map-setup block.
So the *logic* is tested but the visual result (dimmed compass, needle still
tracking) is unconfirmed on a real device. Worth a 10-second manual look:
Settings → Lock rotate on → tap the compass.
