---
title: the unit conversion new ui is nice but it flashes back and forth as it resizes itself, let's just always have it be a window size of screen so no need to resize, with box centered at the top always
status: done
claimed_by: claude-opus
created: 2026-07-19T20:38:33Z
updated: 2026-07-19T21:05:00Z
taiga_id: 79
taiga_version: 1
synced_hash: b2358eed64e2591e
---

## Description

The Extras "Unit conversions" sheet is vertically centered inside the
`#extrasPanel` overlay and is sized to its content. The new smart
free-text converter changes the body height on every keystroke (empty →
hint → head + full conversion list), so the centered sheet grows/shrinks
*and re-centers* each time — reading as a flash/jump. Make it a fixed
screen-tall window anchored near the top so nothing resizes as you type.

## Progress

- (2026-07-19) Traced the layout: `#extrasPanel` is `display:flex;
  align-items:center; justify-content:center` and `.sheet` is
  `max-height:85vh; overflow-y:auto` sized to content → content-driven
  height + vertical centering = the flash.
- (2026-07-19) Added an opt-in `.extras-tall` modifier on `#extrasPanel`
  that anchors to the top (`align-items:flex-start`) and pins the sheet
  to a fixed `88vh` box (`margin-top:6vh`). Toggled on only for tools
  flagged `tall:true`; `unitconv` is the only one so far.
- (2026-07-19) Wired `panel.classList.toggle('extras-tall', !!t.tall)`
  into `showTool`, and `remove` into `showBubbles`, so other tools stay
  compact and centered and the grid never inherits the tall box.
- (2026-07-19) `node --check` clean; `tests/unit-parse.test.js` → 117
  passed, 0 failed (change is CSS + class toggle, orthogonal to parser).

## Writeup

**What changed** (all in `static/extras.js`):

1. New CSS block after the `#extrasPanel .sheet` rule:
   ```css
   #extrasPanel.extras-tall { align-items: flex-start; }
   #extrasPanel.extras-tall .sheet {
     height: 88vh; max-height: 88vh;
     margin-top: 6vh;
   }
   ```
   `.sheet` already has `overflow-y:auto`, so a taller body just scrolls
   inside the fixed box instead of resizing it.

2. `tools.unitconv` gained a `tall: true` flag.

3. `showTool()` now does `panel.classList.toggle('extras-tall', !!t.tall)`
   and `showBubbles()` does `panel.classList.remove('extras-tall')`, so
   the tall/top-anchored layout applies only while the Unit conversions
   tool is open and is cleared everywhere else.

**How it works:** the overlay `#extrasPanel` is a fixed full-screen flex
container. Default tools keep the original centered, content-sized sheet.
When a `tall` tool is shown, the panel switches to top alignment and the
sheet is forced to a constant `88vh` height (6vh top margin, ~94vh total,
fits the viewport). Because the box height no longer depends on the smart
converter's output, typing can't grow/shrink or re-center it — the flash
is gone; long conversion lists scroll within the box.

**Assumptions / notes:**
- The tradeoff is that when the smart field is empty the box is now a tall
  mostly-empty window with the input near the top — this is exactly what
  the task asked for ("always window size of screen so no need to
  resize, box centered at the top always"); stability over compactness.
- Only `unitconv` is flagged `tall`; other Extras tools are unaffected.
- Verified via static syntax check + the parser test suite. The visual
  behavior (no resize/flash, top anchoring) is reasoned from the CSS but
  not screenshot-verified in a live browser this session.
