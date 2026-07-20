---
title: In pixel art have a way to replace x color with y colpr
status: done
claimed_by: claude-opus
created: 2026-07-20T16:29:35Z
updated: 2026-07-20T16:29:35Z
taiga_id: 166
taiga_version: 2
synced_hash: d8634bd16a729d04
---

## Description
Pixel-art editor: let the user replace one colour (X) with another (Y) across the
whole artwork in one action. X = a palette swatch; Y = the current colour
(`state.color`, e.g. one eyedropped off the art). Should apply to every layer, be a
single undoable step, and keep the palette coherent (the swatch becomes Y).

## Progress
- (2026-07-20) Mapped the plumbing. `state.color` is the current colour Y. The
  palette-edit list (`renderPalettePanel` → `#palEditList`) already renders one
  `.paledit` button per palette colour with a `×` remove badge — that's the natural
  home for a "replace this colour with the current colour" action, since each swatch
  is a well-defined X. Pixels live in per-layer `L.cells` arrays; `rebuildLayerBuf`
  repaints a layer's blit buffer; `pushHistory({t:'layers', before, after})` +
  `layerSnapshot()` give a proven one-step multi-layer undo entry.

## Writeup
Added a per-swatch "replace this colour everywhere" action to the pixel-art
palette panel (`static/pixelart/`). X = the palette swatch you click; Y = the
current colour (`state.color`, typically eyedropped).

**UX:** In the palette popover's edit list (`#palEditList`), every swatch already
had a `×` remove badge (top-right). Each now also gets a `⇄` badge (bottom-right)
titled "Replace <hex> with the current colour everywhere". The badge is hidden on
the swatch that already *is* the current colour (that'd be a no-op). A one-line
hint under the list documents both badges (tooltips don't show on touch). The
typical flow: eyedrop/pick Y → open the palette panel → tap the `⇄` on the X you
want gone.

**Behaviour (`replaceColor(from, to)` in `app.js`, after `removePaletteColor`):**
1. Walks every layer's `L.cells`, rewrites cells equal to `from` (case-insensitive)
   to `to`, and `rebuildLayerBuf`s each layer that changed.
2. Records the whole thing as ONE undoable step via the existing
   `pushHistory({t:'layers', before, after})` + `layerSnapshot()` machinery
   (proven multi-layer snapshot path used by layer ops). Undo/redo restore the art
   in a single tap.
3. Keeps the palette coherent: the X slot is repointed to Y, or spliced out if Y is
   already a swatch (no duplicates). `persistIfNamed()` writes back to the active
   named palette (the built-in default stays pristine, matching existing add/remove
   semantics). Palette edits are intentionally *not* in the undo stack — same as
   `addPaletteColor`/`removePaletteColor` — so undo restores pixels but leaves the
   palette; noted inline.
4. `setActiveColor(to)` makes Y current, then rebuilds the palette row + panel and
   re-renders.

**Design decisions / assumptions:**
- Scoped to palette colours (X is always a swatch) rather than a canvas "replace
  tool", to keep it unambiguous and avoid overlap with the separate board task
  "magic select flood fill global or local" (which owns the canvas fill-by-region
  interaction). A colour present in the art but not the palette isn't directly
  targetable here — acceptable, since the eyedrop→save-swatch flow (prior task)
  puts any art colour into the palette first.
- Replace applies across **all** layers (hidden ones included), matching the
  intent "get rid of colour X in this artwork".

**Verification:** `node --check app.js` passes. The three branches of the palette
update (Y-not-in-palette → repoint; Y-already-present → splice; from==to → no-op)
and case-insensitive matching were exercised with a standalone Node harness of the
core loop — all correct. **Not** driven in a real browser (no headless-browser
tooling in this env), so a human should give it a quick click-test: eyedrop a
colour, open Palettes, tap a swatch's `⇄`, confirm the art recolours in one step
and Undo reverts it. Change is additive and reuses existing helpers
(`layerSnapshot`, `rebuildLayerBuf`, `pushHistory`, `persistIfNamed`,
`setActiveColor`), so risk is low. Nothing hits the network.
