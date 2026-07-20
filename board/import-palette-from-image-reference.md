---
title: Import palette from image reference
status: done
claimed_by: claude-opus
created: 2026-07-20T16:29:35Z
updated: 2026-07-20T16:29:35Z
taiga_id: 169
taiga_version: 3
synced_hash: 9ed79093ab357a17
---

## Description
In the Pixel Art editor, let the user build a colour palette from the currently
loaded **reference image** (the tracing underlay). Distinct from the existing
"Import…" button in the palette panel, which imports a palette *file* (ASE/ACT/
GPL/etc.) or reads the unique colours out of a palette-strip image. A photo or
artwork reference has thousands of unique colours, so it needs quantization
(median cut) down to a small, usable set.

Done = a control in the reference panel that extracts ~N representative colours
from the reference image and saves them as a new named palette.

## Progress
- (2026-07-20) Oriented in `static/pixelart/app.js` + `index.html`. Found the
  existing file-import path (`importPaletteFile` → `parseImageColors` /
  `finishImport`) and confirmed palettes persist to the GLOBAL `pixelart.palettes.v1`
  localStorage key via `finishImport`, NOT into the per-drawing save (`serializeDoc`)
  — so extracting to a palette adds zero bytes to the save file / backup. That
  resolves the storage-bloat fork: reuse `finishImport`.
- (2026-07-20) The reference image lives at `state.refImg` (already downscaled to
  REF_MAX=1024 on load). Plan: median-cut quantize `state.refImg` → N colours →
  `finishImport(cols, 'Reference palette')`.

## Writeup
Added an **Extract** control to the Pixel Art reference-image panel (only visible
once a reference is loaded, since it lives inside `#refControls`). It builds a
colour palette from the currently loaded reference underlay and saves it as a new
named palette.

### How it works (`static/pixelart/app.js`)
- `quantizeImage(img, k)` — median-cut colour quantization. Downscales the ref to
  ≤128px on its long edge into an offscreen canvas, reads opaque pixels
  (alpha ≥ 8), then repeatedly splits the box with the widest colour spread along
  its widest RGB channel at the median until there are `k` boxes (or every box is
  uniform/a singleton — so a 2-colour image yields 2 swatches, not `k` dupes).
  Each box is averaged to its representative colour; the result is sorted by
  luminance (dark→light) so the palette reads sensibly. Returns `#rrggbb` strings.
- `paletteFromReference(k)` — guards on `state.refImg`, quantizes, and hands the
  colours to the **existing** `finishImport(cols, 'Reference palette')`.
- UI: `#refPalette` button + `#refPalCount` number input (2–64, default 16) wired
  in `wireUI()` next to the existing `#refReset` handler. After extracting it
  closes the ref popover and opens the palette panel so the new swatches show.

### Storage-bloat fork (the thing flagged as a possible design question)
Resolved by reuse: `finishImport` persists palettes to the **global**
`pixelart.palettes.v1` localStorage key and switches the active palette to it.
That store is entirely separate from the per-drawing save (`serializeDoc` →
`pixelart.doc.v1` and the host-folder named saves). So extracting a palette adds
**zero bytes** to the artwork/backup — the palette is editor-global, shared across
all drawings, exactly like the built-in presets and file-imported palettes.

### Why quantization (vs. the existing "Import…" image path)
The palette panel's **Import…** already reads colours out of an image, but via
`parseImageColors`, which keeps *unique* colours (ideal for a Lospec palette
strip). A photographic/artwork reference has thousands of unique colours, so it
needs reducing — hence median cut here. The two paths are complementary.

### Verification
- Node harness replicating the median-cut algorithm passed all edge cases: empty
  input → `[]`; single colour → 1 swatch; two colours at k=16 → exactly 2; 256-step
  grey gradient at k=8 → 8 evenly-spaced greys ordered dark→light; k > pixel count
  → 3 distinct swatches, no crash/dupes.
- `node --check` passes on app.js; all new element IDs present in index.html.
- Not driven in a real browser (no Playwright/Puppeteer in this env). The wiring
  mirrors the sibling reference-panel handlers exactly, and all touched
  functions/DOM (`finishImport`, `_hex`, `state.refImg`, `closeMenus`,
  `#palettePanel`) were confirmed present.

### Assumptions
- 16 default colours and a 2–64 range felt right for pixel-art work; easy to tweak.
- 128px working-size cap keeps quantization fast on mobile WebViews while giving a
  representative colour sample (the ref itself is already ≤1024px from load).
