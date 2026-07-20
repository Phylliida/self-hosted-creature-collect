---
title: in pixel art have Magic select flood fill global or local
status: done
claimed_by: claude-opus
created: 2026-07-20T16:29:35Z
updated: 2026-07-20T16:29:35Z
taiga_id: 168
taiga_version: 3
synced_hash: 8e63e55d4688b5a9
---

## Description
Pixel-art fill (bucket) tool: add a **Local** vs **Global** mode.
- **Local** (current behaviour): contiguous 4-connected flood fill on the active
  layer — only the connected region of the clicked colour is filled.
- **Global** ("magic select"): fill *every* pixel on the active layer that matches
  the clicked colour, regardless of contiguity — like a magic-wand select-by-colour
  + fill. Same single-undoable-step + palette scope as local (active layer only).

## Progress
- (2026-07-20) Read the whole editor (`static/pixelart/app.js` + `index.html`).
  `floodFill(cx,cy,col)` already does the local, contiguous, active-layer flood via
  `paintCell` (which records the stroke into `pending`/history). The clean addition
  is a sibling `fillGlobal` that recolours every matching cell on the active layer,
  plus a `state.fillMode` toggle. UI pattern: mirror `#selBar` — a `#fillBar` row
  that appears only while the fill tool is active, with a Local/Global segmented
  toggle. Distinct from the prior `replaceColor` task (palette-scoped, all layers).
- (2026-07-20) Implemented + verified. Done.

## Writeup
Gave the pixel-art fill (bucket) tool a **Local / Global** mode
(`static/pixelart/`).

**Behaviour:**
- **Local** = the existing `floodFill(cx,cy,col)` — 4-connected contiguous flood on
  the active layer. Only the connected blob of the clicked colour changes. Default.
- **Global** ("magic select") = new `fillGlobal(cx,cy,col)`: recolours *every* cell
  on the active layer whose colour matches the clicked cell, regardless of
  contiguity (one pass over `state.cells`). Also fills transparent (null) target
  cells — e.g. click any empty cell in Global to flood the whole layer's background.

Both funnel through the same `beginStroke()`/`paintCell`/`commitStroke()` path, so
each fill is a single undoable step scoped to the **active layer** (mirrors Local
exactly). Colour match is strict `===`, identical to `floodFill`'s contiguity test,
so the two modes differ only in *reach*, never in what counts as "the same colour".
This is deliberately distinct from the earlier `replaceColor` palette action, which
is palette-swatch-scoped and spans *all* layers.

**UX:** New `#fillBar` row, styled/behaved like `#selBar` — it appears only while
the fill tool is active (shown/hidden in `updateFillUI`, called from `selectTool`
and `init`). It holds a segmented Local/Global toggle (`.seg` + `.fillmode`
buttons). The choice persists to `localStorage` (`pixelart.fillMode.v1`) via
`setFillMode`, so it survives reopening. State lives on `state.fillMode`
('local'|'global'), and `onDown`'s fill branch dispatches
`state.fillMode === 'global' ? fillGlobal : floodFill`.

**Design decisions / assumptions:**
- Global stays **active-layer-only** (like Local), not all-layers. Filling by
  colour across every layer would collide conceptually with the all-layer
  `replaceColor` action and be surprising for a per-layer bucket. If a cross-layer
  "recolour X everywhere" is wanted, that's the palette `⇄` action, not this.
- Chose a bar-that-appears-with-the-tool over a popover so the mode is visible and
  one-tap while filling (a hidden popover would bury a frequently-toggled option).
- Local remains the default (least-surprising, matches every other pixel editor's
  bucket); Global is opt-in.

**Verification:** `node --check app.js` passes. Extracted the two fill algorithms
into a standalone Node harness (`/tmp/fill_test.js`) over a hand-built grid with two
disjoint same-colour regions + a barrier column: confirmed Local fills only the
connected region, Global fills all matching cells (incl. the disjoint one), Global
fills nulls, both are no-ops when target==colour — 6/6 passed. **Not** driven in a
real browser (no headless-browser/jsdom tooling here, and installing would hit the
network, which this project forbids). Suggested human click-test: select the bucket,
confirm the Fill bar appears, draw two separate blobs of one colour, and verify
Local recolours only the clicked blob while Global recolours both in one undoable
step; reopen the editor to confirm the mode stuck. Change is additive and reuses
existing helpers (`floodFill`, `paintCell`, `beginStroke`/`commitStroke`,
`selectTool`), so risk is low. Nothing hits the network.
