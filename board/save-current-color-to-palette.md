---
title: Save current color to palette
status: done
claimed_by: claude-opus
created: 2026-07-20T16:29:35Z
updated: 2026-07-20T16:29:35Z
taiga_id: 173
taiga_version: 3
synced_hash: 874e6c7384ae9f85
---

## Description
Pixel-art editor: let the user save the *current* colour (`state.color`, which may
have been set via the eyedropper off the art or reference image) into the working
palette with one tap — without having to re-open the native colour picker.

## Progress
- (2026-07-20) Mapped the palette code in `static/pixelart/`. `state.color` is the
  current colour; `addPaletteColor(col)` appends to the live `PALETTE` (dedup via
  `hasColor`) and `persistIfNamed()` writes back to a named palette. The existing
  "＋ Add colour" in the palette popover opens the native picker and adds whatever
  you pick — but there was no way to save the *current* colour after eyedropping.
- (2026-07-20) Adding a pinned "＋" save-swatch button in the main palette row,
  right after the current-colour chip, that calls `addPaletteColor(state.color)`.
- (2026-07-20) Implemented + committed.

## Writeup
Added a one-tap "save current colour" control to the pixel-art editor
(`static/pixelart/`).

**What was there already:** `state.color` holds the live colour. The palette
popover's "＋ Add colour" opens the native `<input type=color>` and, on `change`,
calls `addCustomColor` → `addPaletteColor` to append the *picked* colour. But
after setting the colour another way — most importantly the **eyedropper**, which
samples off the art or the reference image via `setActiveColor` without touching
the palette — there was no way to keep that colour short of re-opening the picker
and matching it by hand.

**Change (3 small edits, all additive):**
1. `index.html` — a `<button id="saveColorBtn" class="swatchadd">＋</button>`
   pinned inside `#palette` immediately after the current-colour chip
   (`#curColor`). It survives `buildPalette()` rebuilds because that function only
   removes/re-appends elements with class `.swatch`, and new swatches are
   `appendChild`-ed *after* it — so the ＋ stays glued to the chip.
2. `index.html` — `.swatchadd` CSS: swatch-sized, dashed border, muted ＋ glyph;
   accent-highlight on hover; dimmed when `:disabled`. Uses existing theme vars
   (`--panel2/--line/--muted/--text/--accent`), so it themes automatically.
3. `app.js` — `saveColorBtn.onclick = () => addPaletteColor(state.color)` (dedups
   via the pre-existing `hasColor`, and `persistIfNamed()` writes back to a named
   palette). Disabled/tooltip state is folded into `markActiveSwatch()`, which is
   the single chokepoint already called by both `buildPalette()` and
   `setActiveColor()` — so the ＋ enables the moment you eyedrop a fresh colour and
   greys out (tooltip "already in the palette") once it's saved.

**How it behaves:** eyedrop or otherwise land on a colour not in the palette → ＋
lights up → tap → it's appended as a swatch (and saved to the active named palette
if one is selected; the built-in PICO-8 default stays pristine, matching existing
`persistIfNamed` semantics). Nothing hits the network.

**Verification:** `node --check app.js` passes. Init order verified
(`state.color` restored → `loadPalettes` → `buildPalette`→`markActiveSwatch` sets
initial button state → `wireUI` attaches the handler). CSS vars confirmed present.
**Not** driven in a live browser — no headless-browser tooling is installed in
this env (no puppeteer/playwright/jsdom, no chromium), so this is static
verification only; a human should give it a quick click-test. The change is purely
additive and reuses existing, tested helpers (`addPaletteColor`, `hasColor`,
`markActiveSwatch`), so risk is low.
