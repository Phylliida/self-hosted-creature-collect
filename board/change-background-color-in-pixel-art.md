---
title: Change background color in pixel art
status: done
claimed_by: claude-opus
created: 2026-07-20T16:29:35Z
updated: 2026-07-20T16:29:35Z
taiga_id: 171
taiga_version: 3
synced_hash: ff2d336e3afa3dc2
---

## Description
Let the user change the background colour of the pixel-art canvas — the area
shown behind transparent pixels while editing (currently a fixed transparency
checkerboard). Provide a colour picker plus a way to go back to the checker.

## Progress
- (2026-07-20) Read the pixelart app. The editor is `static/pixelart/app.js`
  (the live one; `static/draw/` is a separate older app). `render()` fills the
  grid area with a fixed `checkerPat` (dark transparency checker) behind the
  layers; opaque cells cover it, transparent cells reveal it. Export/thumbnail
  keep real transparency (documented contract) so the background must NOT be
  baked into exports.
- Design: treat the background as a **global editor preference** (Aseprite
  model), persisted to `localStorage` under `pixelart.bg.v1`, default = checker.
  Purely a viewing aid — not part of the saved doc, bridge payload, thumbnail,
  or exported PNG. Fewer touch points, no risk to save/export fidelity.
- Implemented: `state.bg`, `setBgColor()`/`updateBgUI()`, render swap
  (bg fill vs checker), a "Background" row in the Palettes popout (colour picker
  + "Checker" reset), restore-on-boot.

## Writeup
Added a canvas background-colour control to the pixel-art editor
(`static/pixelart/`).

**What it does:** In the Palettes popout there's now a "Background" row with a
colour picker (a swatch showing the current background) and a "Checker" button.
Picking a colour fills the drawing area behind transparent pixels with that
solid colour; "Checker" reverts to the default transparency checkerboard. Great
for previewing a sprite against a flat colour while editing.

**How it works (all in `static/pixelart/app.js` + `index.html`):**
- `state.bg` (hex string or `null`; `null` = checker). New localStorage key
  `pixelart.bg.v1`.
- `render()` — where it used to always paint `checkerPat`, it now paints
  `state.bg` if set, else the checker. The reference-image dark backing also
  follows `state.bg` (falls back to `#14151a`) so tracing contrast stays sane.
- `setBgColor(col)` updates state, persists, refreshes UI, re-renders;
  `updateBgUI()` syncs the swatch (solid colour, or an empty inline background
  that lets the CSS checker swatch show through) and disables "Checker" when
  already transparent.
- Wired in `wireUI()`; restored on boot in `init()` (read before first render;
  `updateBgUI()` called after the DOM is wired).
- HTML: `.bgrow` in the Palettes popout reusing the existing `.addcolor`
  hidden-color-input idiom; CSS `.bgswatch` renders a mini checker via two
  gradients, overridden to a solid colour inline when a colour is set.

**Design choice — global editor preference, not part of the artwork.** This
follows the Aseprite model: the background is a viewing aid, so it is
deliberately NOT written into `serializeDoc()`, the `PixelApp` bridge payload,
`makeThumb()`, or `exportPNG()`. Exports and thumbnails keep true transparency
exactly as before (that contract is documented in the export code). One
consequence: the background is shared across all drawings and does not travel
with a named save. If per-drawing backgrounds or baking-into-export are wanted
later, that's a deliberate follow-up (would touch the doc format + bridge +
export). Flagged here so it's a decision, not an oversight.

**Verification.** `node --check` passes on app.js; HTML markup balanced. I
mirrored the render-branch + persistence logic in a standalone Node harness and
asserted all four cases (default→checker, set→solid+persist, clear→checker,
empty-string-falsy-on-boot) — all pass. I did NOT drive the live PWA in a
browser (no headless canvas/browser harness available in this environment), so
the visual result is verified by static review + logic mirror rather than a real
render.
