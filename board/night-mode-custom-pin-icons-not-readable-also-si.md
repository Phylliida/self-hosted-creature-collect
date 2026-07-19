---
title: Night mode custom pin icons not readable also signal poke
status: done
claimed_by: claude-opus
created: 2026-07-19T19:19:00Z
updated: 2026-07-19T21:05:00Z
taiga_id: 62
taiga_version: 3
synced_hash: 27db0a1a669468a3
---

the radar poke hard to see in night mode give them white outilne, also the custom pin icon menu is hard to see on dark mode probably use different colors, by dark mode i mean a specific theme dark

## Progress
- (2026-07-19) Claimed. Mapped the three surfaces via an Explore agent:
  radar blip CSS is injected inside `creatures.js` (hardcoded colors, does NOT
  read `--ui-*`); the pin-icon menu is `#favPanel`'s `renderFavIconGrid()` in
  `index.html`; themes are `window.THEMES` + `applyTheme()`, current theme on
  `<html data-theme>`. **Key gap found:** there is no "is this a dark theme"
  helper anywhere — detection was per-exact-name only, and ~50 themes are dark.
- (2026-07-19) Added a luminance-based dark detector + `data-ui-dark` flag,
  the radar white-outline rule, and the pin-menu invert. Full suite green
  (41 files, incl. a new `theme-is-dark.test.js`, 13/13). Committed.

## Writeup

**Two complaints, one root cause:** several dark themes (the user named `dark`,
but `night`, `garage`, and others share the problem) render (a) the black
radar silhouettes into the near-black map and (b) the pin-icon menu's dark SVG
icons onto dark cell backgrounds. The blocker was that neither surface could
cheaply ask "is the current theme dark?" — the radar CSS lives inside
`creatures.js` and can't read the `--ui-*` vars, and there was no dark-theme
grouping at all (I grepped for `isDark`/`DARK_THEMES` — none).

**Foundation — a real dark-theme flag (`static/index.html`):**
- New `window._themeIsDark(t)` (just after the `THEMES` object, ~line 2882):
  perceived-luminance test (`0.299R+0.587G+0.114B < 0.5`) on the theme's
  `ui.panelBg` (falling back to top-level `bg` for custom themes). Handles
  3-digit hex and returns `false` on junk input.
- Surfaced on `<html>` as `data-ui-dark="1"|"0"` in BOTH places that already
  set `data-theme`: the early flash-prevention script (~2908) and `applyTheme()`
  (~6337). So it's correct before first paint and updates on every theme switch,
  and covers *every* dark theme rather than only the one literally named `dark`.

**Fix 1 — radar poké white outline (`static/creatures.js`, ~6206):**
Added `html[data-ui-dark="1"] .radar-marker.silhouette:not(.radar-legendary)
.radar-marker-img { filter: brightness(0) + 4× white drop-shadow }` — the exact
outline technique the legendary rule already uses, but white and only on dark
themes. `:not(.radar-legendary)` leaves legendaries on their gold outline
(bright enough on black, and it's a deliberate rarity signal). Higher
specificity + later position means it overrides the base silhouette rule in
dark mode and reverts cleanly on light themes.

**Fix 2 — pin-icon menu readability (`static/index.html`, `renderFavIconGrid`
~9340):** unselected icons used to render with inline `filter:none` (raw dark
SVG ink) on the dark `--ui-hover` cell → invisible. Now, in dark mode, the
unselected filter becomes `brightness(0) invert(1)` (white), matching how the
selected icon is already drawn. Selected vs. unselected still read apart via
the color-swatch background + accent border. Did it in the JS (not CSS) because
the existing inline `filter` would otherwise beat a stylesheet rule without an
`!important` hack.

**Tests:** new `tests/theme-is-dark.test.js` vm-extracts `_themeIsDark` and
pins the classification of real themes (dark/night/garage → dark; default/sepia
→ light), the `bg` fallback, 3-digit hex, and junk-input safety (13/13). This
is the piece that could silently regress and re-break both fixes, so it's the
one worth locking. Full suite: 41/41 files pass, 0 failures.

**Assumptions / not automated:**
- The actual pixel rendering (WebGL map + `SpriteStore`) can't run headless —
  same limitation prior map/radar tasks noted — so the two visual overrides
  (outline geometry, icon inversion) are reviewed by reading, not screenshotted.
- Dark-vs-light is decided by panel-bg luminance with a 0.5 cutoff; every
  current theme lands unambiguously (darkest light-theme panelBg is beige
  ~0.87, lightest dark-theme panelBg is garage ~0.23). A future mid-tone theme
  near the boundary would just pick a side; no theme is close today.
- `night` map already gives the countdown/autogen pills dark-bg/light-text, so
  those stayed untouched — only the silhouette needed help.
