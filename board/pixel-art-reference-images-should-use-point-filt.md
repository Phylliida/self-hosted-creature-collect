---
title: pixel art reference images should use point filtering
status: done
claimed_by: claude-opus
created: 2026-07-20T16:29:35Z
updated: 2026-07-20T16:29:35Z
taiga_id: 170
taiga_version: 3
synced_hash: 2dc4a8323c327ee9
---

## Description
In the pixel art tool, the reference image (the photo/sprite the user traces
over) is drawn with bilinear smoothing enabled. When the canvas is zoomed in,
this makes the reference blurry. It should use point/nearest-neighbor filtering
so reference pixels stay crisp — matching the pixel-art workflow.

## Progress
- (2026-07-20) Located the render path in static/pixelart/app.js. The reference
  image is drawn in render() at ~line 201-211. Line 208 explicitly set
  `ctx.imageSmoothingEnabled = true;` immediately before `drawImage(state.refImg,...)`.
  Everything else in the file draws with smoothing off (lines 160, 212, 464, 844).
  So the reference was the lone exception. Flipped it to false.
- (2026-07-20) Confirmed there is no dist/static/pixelart copy — static/ is the
  served source. `node --check` passes.

## Writeup
**Change:** one line in `static/pixelart/app.js` render(). The reference-image
draw block set `ctx.imageSmoothingEnabled = true` just before drawing the
reference; changed it to `false` (with a comment). The draw is wrapped in
`ctx.save()`/`ctx.restore()`, so the flag doesn't leak; line 212 also re-asserts
`false` for the layer composite afterward, unchanged.

**Effect:** when the canvas is zoomed in (state.scale large), the reference is
scaled up with nearest-neighbour sampling, so its pixels stay crisp instead of
blurring — matching the pixel-art tracing workflow. This mirrors how the layer
buffers and everything else in the file already render.

**Scope / assumptions:**
- Only the on-screen display sampling changed. The eyedropper reads from a
  separate down-sampled copy (`refSample`, built elsewhere) and is untouched.
- The stored reference is capped at REF_MAX=1024px. If a user loads a large
  photo and views it *smaller* than native (zoomed out), point sampling can look
  slightly more aliased than bilinear would. That's the deliberate trade the
  task asks for (crisp pixels > smooth photos) and is consistent with the rest
  of the tool.
- Not driven in a live browser this turn; verification was static-source
  inspection + `node --check`. The change is a single well-understood flag flip
  on an existing, working draw call.
