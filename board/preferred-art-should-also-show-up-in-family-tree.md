---
title: preferred art should also show up in family tree
status: done
claimed_by: claude-opus
created: 2026-07-19T19:23:52Z
updated: 2026-07-19T19:23:52Z
taiga_id: 75
taiga_version: 3
synced_hash: b6d24a005a9179c6
---

everywhere else it is displayed but not in pokedex family tree

## Progress
- (2026-07-19) Traced both mechanisms in static/creatures.js. "Preferred art" ==
  per-fusion `favoriteArt` (variant + shiny), read via `favoriteArtFor(a,b)`.
- The family-tree mosaic (`renderFamilyGrid`, ~line 3427) ALREADY picks each
  cell's sprite from `favoriteArtFor` — that shipped in commit 020422b3
  ("customize fav art variant and shiny in dex", 2026-07-12), which is on HEAD.
  So on *open* the family tree honors preferred art.
- Real gap: the LIVE update path. `_refreshFavoriteArt(body,a,b)` (fires when the
  user taps a new favorite art/shiny cell in the same entry) re-rendered the
  header art + the selection ring but NOT the already-expanded family grid. So
  after changing your pick, the current fusion's mosaic cell kept the OLD art
  until you reopened the entry — matching "shows everywhere else but not the
  family tree".

## Writeup
**Fix (static/creatures.js, in `_refreshFavoriteArt` ~line 10393):** after
re-rendering the header art, also re-load the family-tree mosaic's current cell.
`favoriteArt` is per-fusion, so only the `(a,b)` cell can change — we target it
with `.family-grid .family-cell[data-a="${a}"][data-b="${b}"] img` and call the
same `SpriteStore.showSprite(img, a, b, fav.variant, {shinyVariant, onReady})`
the grid uses at render time. When the family tree is collapsed / never expanded
the selector matches nothing and it's a clean no-op; the grid is rebuilt fresh
(already reading `favoriteArtFor`) whenever it's next expanded.

**Why not rebuild the whole grid?** Only one cell's art changed; reloading the
whole mosaic would flash every cell and thrash the sprite cache. Targeting the
single cell is minimal and matches the header-refresh idiom already there.

**Verification:** `node --check` clean. New harness
`tests/favorite-art-family-tree.test.js` extracts `_refreshFavoriteArt` +
`favoriteArtFor` and drives them against a minimal fake DOM: (1) an expanded
mosaic cell re-renders with the new favorite variant + `.ready` re-marked,
(2) a favorited shiny propagates (variant+shinyVariant), (3) a collapsed tree
doesn't crash and the header still updates, (4) a mismatched-pair cell is left
untouched. All 8 assertions pass; the existing `tests/favorite-art.test.js`
(12 assertions) still passes. Not exercised in a live browser (the full app
needs MapLibre WebGL, which dies headless) — verified at the DOM-effect level.

**Assumption:** the user's report is about seeing preferred art reflected after
selecting it in the entry (the live path). The on-open path was already correct
as of 2026-07-12; this closes the remaining live-update gap.
