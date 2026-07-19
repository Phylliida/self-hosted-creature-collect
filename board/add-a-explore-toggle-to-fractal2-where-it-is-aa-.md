---
title: Add a "explore" toggle to fractal2 where it is AA off and resolution 1/3 and if it is toggled to "draw" then it is AA on at 2x and full res
status: done
claimed_by: claude-opus
created: 2026-07-19T20:40:02Z
updated: 2026-07-19T20:40:02Z
sync: orphaned
---

## Description

Add an "explore" / "draw" mode toggle to fractal2 (the Mandelbrot deep-zoom viewer at
`static/fractals2/`). Two states:
- **Explore** — AA off (supersample 1×) + resolution 1/3 → fast panning/zooming.
- **Draw** — AA on at 2× (4 samples) + full resolution → crisp final image.

## Progress

- (2026-07-19) Read the viewer. The panel already exposes the two controls this bundles:
  `#ss` (supersample/AA) and `#resScale` (render resolution), both URL-hash-persisted via
  `writeHash`/`readHash` in `src/main.js`. `viewer.ss` / `viewer.resScale` are plain
  writable fields; `viewer.setSupersample` calls `render()`, `viewer.setResScale` calls
  `resize()` (backing dims change). Plan: add a segmented Explore/Draw pill (bottom-left,
  mirroring the bottom-right panel toggle), set both fields at once + single re-render,
  derive the active pill from current ss/resScale so it stays consistent with the panel
  selects and needs no separate persistence (ss & resScale already ride in the hash).

## Writeup

**What shipped.** A segmented **Explore / Draw** pill, bottom-left (mirroring the
bottom-right ☰ panel toggle), always visible while the panel is closed.
- **Explore** → supersample 1× (AA off) + resScale 3 (1/3 resolution) — fast to pan/zoom.
- **Draw** → supersample 2× (4 samples) + resScale 1 (full resolution) — crisp image.

**How it works.** The viewer already had the two underlying controls in the panel
(`#ss`, `#resScale`), both URL-hash-persisted. The toggle is pure convenience glue over
them — it holds **no state of its own**:
- `static/fractals2/index.html` — added `#qualityToggle` with two `.qmode` buttons
  (`data-mode="explore|draw"`).
- `static/fractals2/styles.css` — `.quality-toggle` / `.qmode`; the active pill
  (`aria-pressed="true"`) fills with `--accent`. z-index below `.panel` so the bottom
  sheet covers it when open (it's for exploring with the panel closed).
- `static/fractals2/src/main.js` — `QUALITY_MODES` (the two presets), `currentQualityMode()`
  (which preset the live ss/resScale match, or `null` for a custom combo), `syncQualityToggle()`
  (lights the matching pill), and `setQualityMode()` (the click handler). `syncQualityToggle()`
  is called from `syncControls()` (so boot + `readHash` reflect it) and from the `#ss` /
  `#resScale` panel-select handlers (so a manual change re-derives the pill).

**Key implementation choice.** `setQualityMode` sets `viewer.ss` / `viewer.resScale`
directly and then re-renders **once** — `resize()` if resScale changed (backing dims move),
else `render()`. It deliberately does **not** call `viewer.setSupersample`/`setResScale`,
because each early-returns when *its own* value is unchanged; from a custom state where
only one of the two differs (e.g. ss1/res1 → "Draw" changes ss only), that early-return
would drop the sibling render. Verified this exact edge case.

**State model.** No new persistence — the mode is derived from ss/resScale, which already
ride in the URL hash, so a bookmarked/shared link reproduces the mode for free, and the
pill and panel selects can never disagree. A ss/resScale combination that matches neither
preset lights neither pill (honest "custom" state).

**Defaults.** Constructor defaults are ss 2 / resScale 1 = **Draw**, matching the panel's
pre-selected options; the HTML marks the Draw pill `aria-pressed` initially and
`syncControls()` corrects it on boot regardless.

**Verification.** `node --check` on both touched JS files. Then a headless harness that
extracts the added block verbatim and drives it against a stub document + fake viewer with
render/resize/hash spies — confirmed: default→Draw lit; Explore click → ss1/res3 + exactly
one resize + pills swap + hash written; Draw restores ss2/res1; custom ss1/res1 → null (no
pill); custom→Draw (ss-only) → exactly one bare render, no resize. All passed. Not committed
as a repo test — fractals2 has no test harness (WebGL) and this stub-heavy check wouldn't
fit the repo's `vm`-extraction style cleanly.

**Assumptions / notes.** Left `#ss` and `#resScale` in the panel as the fine-grained
controls (Explore/Draw is a shortcut, not a replacement); values other than the two presets
remain reachable there. `lowPower` / `forceHQ` are independent effects and intentionally
don't factor into the mode derivation.
