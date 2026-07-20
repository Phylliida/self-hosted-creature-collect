---
title: Reflect and rotate background image options
status: done
claimed_by: claude-opus
created: 2026-07-20T16:29:35Z
updated: 2026-07-20T17:10:00Z
taiga_id: 172
taiga_version: 2
synced_hash: 3e7051413c2f4c47
---

## Description
The pixel-art editor has a "Reference image (tracing underlay)" popout. Add
controls to reflect (mirror horizontally / vertically) and rotate the reference
image in 90° steps, so it can be aligned to whatever the user is drawing. Must
keep the eyedropper's per-cell sampling of the reference in lockstep with what's
shown, and the transform should persist across reopening (it's a working aid,
never baked into saves/exports).

## Progress
- (2026-07-20) Mapped the reference feature in `static/pixelart/app.js`: it is
  drawn in `render()` and sampled in `buildRefSample()`, both using the rect from
  `refRectCells()`. Placement already supports opacity, aspect-fit and a drag
  offset (`refOffX/Y`).
- (2026-07-20) Implemented flip H/V + rotate ±90°. Verified the transform math
  with a Node harness (matrix replication): the drawn image box maps exactly onto
  the intended footprint `[rx,ry,rw,rh]` for all 4 rotations × 4 flip combos
  (no distortion / no gaps), and the 16 control combinations resolve to the 8
  distinct orientations of the rectangle dihedral group (flipH+flipV == rot180,
  which is correct). `node --check` passes.

## Writeup
**What changed** — two files, `static/pixelart/app.js` and `.../index.html`.

New state on `state`: `refFlipH`, `refFlipV` (booleans) and `refRot` (0/90/180/270).
Persisted under a new key `REF_XFORM_KEY = 'pixelart.refXform.v1'` (`{fh,fv,rot}`),
saved by the existing `saveRefTransform()` and restored in `init()`.

**Rendering.** Both the on-screen draw (`render()`) and the eyedropper's
downsampled copy (`buildRefSample()`) now go through one shared helper
`drawRefTransformed(g, rx, ry, rw, rh)`. It centres on the footprint, mirrors in
*screen space* (Flip H always mirrors left↔right regardless of rotation), then
rotates; for 90°/270° it draws into a dimension-swapped box so the rotated image
still fills the exact same footprint. Because render and sampling use the same
helper, the eyedropper keeps sampling exactly the pixels shown.

`refRectCells()` was made rotation-aware: in "keep aspect ratio" mode a 90°/270°
rotation fits the grid using the image's swapped width/height, so the footprint
preserves the true aspect of the sideways image. In stretch (fill) mode the
footprint is the whole grid, unchanged.

**UI.** In the reference popout: a row of four buttons — Flip H (⇆), Flip V (⇅),
Rotate 90° left (↺), Rotate 90° right (↻). The two flip buttons show an active
(accent) state that `updateRefUI()` keeps in sync. "Reset position" was renamed
"Reset transform" and now also clears flips + rotation. Choosing/replacing an
image and removing the reference both reset the transform to identity.

**Persistence & purity.** The transform is a global editor preference persisted in
localStorage alongside opacity/aspect/offset. It only affects the underlay draw
and eyedropper — `serializeDoc()`, `makeThumb()` and `exportPNG()` are untouched,
so saves/thumbnails/exports keep true transparency and the drawn art, exactly as
the reference underlay itself does.

**Verification.** Transform correctness verified numerically via a Node matrix
harness (footprint coverage exact for all 16 combos; 8 distinct rectangle
orientations). `node --check static/pixelart/app.js` passes.

**Assumptions / not done.** Rotation is 90° steps only (matches a tracing
workflow; arbitrary-angle rotation wasn't requested and would complicate
aspect-fit + eyedropper alignment). No in-browser visual check was run (the tool
is an iframe app with no headless harness set up here); the render path is a
standard nested canvas save/rotate/scale/drawImage and the math is validated, but
a human glance in the app is worth a moment on next use.
