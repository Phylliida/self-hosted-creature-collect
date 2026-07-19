---
title: the selection box for preferred art in the pokedex gets clipped by the white border
status: done
claimed_by: claude-opus
created: 2026-07-13T21:52:20Z
updated: 2026-07-13T22:07:32Z
taiga_id: 51
taiga_version: 1
synced_hash: 1f7f3ea34faf1c36
---

make it on top of that in the z index so it doesn't get clipped

## Progress
- (2026-07-13T22:07Z) Traced the "selection box" to the favorite-art accent ring:
  `#creatureInventory .variant-cell.favorited { box-shadow: 0 0 0 2px accent }`
  (static/creatures.js ~line 4789). It's an **outward** 2px ring drawn around
  the chosen art/shiny cell in the fusion detail view's `.variant-grid`.
- The grid sits flush (no horizontal padding) inside `.body-slot`
  (`overflow-x: hidden`) and `.fusion-view` (`overflow: hidden`). So a favorited
  cell in the first/last grid column has its outer ring clipped by those
  overflow boundaries — the "white border" the report describes.
- A pure z-index bump can't defeat `overflow: hidden`, so I gave the grids a
  few px of breathing room (keeps the exact outer-ring look) AND raised the
  favorited cell's stacking so the ring always paints above its neighbours.

## Writeup
**Fix (static/creatures.js CSS in the injected style block):**
1. `#creatureInventory .variant-grid` — added `padding: 2px 4px;`. This insets
   the grid a few px from the `overflow-x: hidden` edges of `.body-slot` /
   `.fusion-view`, so an edge-column cell's outward 2px selection ring now
   falls *inside* the clip region instead of being sliced off. The
   `minmax(80px,1fr)` columns just recompute against the slightly narrower
   content box — no visible layout change, grid still aligns under the centered
   header art.
2. `#creatureInventory .variant-cell.favorited` — added
   `position: relative; z-index: 1;` so the accent ring stacks above adjacent
   cells (honors the "make it on top in z-index" request and guards against any
   neighbour background painting over the ring).

Both the art grid and the shiny grid share the `.variant-grid` class, so the
fix covers both selection rings.

**Why not an inset ring?** Switching to `box-shadow: inset ...` would also be
clip-proof but changes the look (ring moves inside the border). The report asked
to keep the box and just stop the clipping, so I preserved the outward ring.

**Verification:** CSS-only change; `grep` confirms the two edited rules. No JS
logic touched, so existing favorite-art tests are unaffected. Visual behavior
not exercised in a live browser this turn (no headless render harness for the
detail sheet), but the clipping cause (outer ring at a zero-padding overflow
edge) is addressed directly.
