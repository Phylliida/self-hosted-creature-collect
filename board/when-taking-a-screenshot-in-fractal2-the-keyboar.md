---
title: when taking a screenshot in fractal2 the keyboard is pulled up and it resizes the canvas, prevent the canvas from resizing (since it has to rerender)
status: done
claimed_by: claude-opus
created: 2026-07-19T20:38:55Z
updated: 2026-07-19T20:52:00Z
sync: orphaned
---

## Description
I'd rather not have to rerender it that's annoying


## Progress
- Traced the "screenshot" flow: the extras **Fractals 2** tool (`makeFractalTool`
  in `static/extras.js`) is an iframe wrapper. Its 💾 Save button
  (`openSavePrompt`, extras.js ~L981) shows a name card and calls
  `nameInput.focus()` — that pulls up the soft keyboard.
- The keyboard shrinks the layout viewport, so `.fractals-window` (fixed,
  `inset:0`) and its iframe (`height:100%`) get shorter. Inside the iframe,
  `#view` is `height:100vh`, so its `getBoundingClientRect()` shrinks and the
  `window 'resize'` handler in `static/fractals2/src/main.js` fired
  `viewer.resize()` — which re-derives the backing resolution and re-renders
  the whole (possibly deep-zoom, slow) fractal. That render is thrown away the
  moment the keyboard dismisses. That's the "annoying rerender."
- Fixed at the fractal2 layer (the viewer should be resilient to transient
  soft-keyboard height changes no matter who embeds it).

## Writeup
**What changed** (`static/fractals2/src/main.js`, the `window 'resize'` handler):

Replaced the unconditional `setTimeout(() => viewer.resize(), 150)` with a
keyboard-aware `onViewportResize()`:
- Tracks a "stable" viewport size (`stableVpW/stableVpH`) = the layout size with
  no keyboard up.
- **Keyboard open** — coarse pointer AND width unchanged AND height shrank: pin
  the canvas box to its pre-keyboard height (`canvas.style.height = stableVpH+'px'`)
  and `return` without resizing. The keyboard just covers the bottom of the
  (still full-size, still-rendered) canvas. No backing change, no render.
- **Keyboard close** — pin active and box back to the stable size: just clear the
  pin. Because we never touched the backing while pinned, there's nothing to
  re-render. Zero rerenders across the whole open→close cycle.
- **Genuine resize** (rotation / desktop window drag): adopt the new size as the
  baseline, drop the pin, and `viewer.resize()` as before.

The coarse-pointer gate (`matchMedia('(pointer: coarse)')`) means a desktop
vertical-only window drag still reflows normally — soft keyboards only exist on
touch devices, so only there do we treat a same-width height shrink as "keyboard."

**Why the pin (vs. just skipping resize):** `#view` is CSS `height:100vh`, so if we
skipped the resize but left the CSS alone, the shorter viewport would squash the
(taller) backing bitmap. Pinning the CSS height keeps the aspect correct; the
overflow past the shrunk viewport is clipped by `body { overflow:hidden }` and is
behind the keyboard/save-card anyway. Bonus: the save thumbnail (`_captureThumb`)
is now grabbed from the crisp full-res canvas instead of a re-rendered/shrunk one.

**Test:** `tests/fractal2-keyboard-resize.test.js` slices the real resize block out
of main.js and drives four scenarios (keyboard open pins + no resize; keyboard
close drops pin + no resize; desktop fine-pointer shrink still resizes; rotation
width-change still resizes). Run: `node tests/fractal2-keyboard-resize.test.js`.

**Assumptions / limits:**
- Assumes the keyboard shrinks height while keeping width constant (the normal
  docked-keyboard case). If a device also nudges the width by even 1px, it falls
  through to the genuine-resize branch — i.e. it degrades to the *old* behavior
  (one rerender), never anything worse.
- Did not change the app's own 💾 Save (`main.js` `$('save')`, a direct PNG
  download) — that never opens a keyboard.
- Not device-tested (no iOS/Android here); verified by the node regression test
  and by static tracing of the resize chain.
