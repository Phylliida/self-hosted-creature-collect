---
name: reference-info-modal
description: Reusable explainer-popup primitive (_openInfoModal + view stack) in creatures.js, for "i"-button info dialogs
metadata:
  type: reference
---

`static/creatures.js` has TWO "i"-info popups. The daycare-odds one
(`#ccDaycareOdds` / `_showDaycareOdds` / `_daycareOddsHtml`) is bespoke and
single-view. The **generic reusable** one (added for the incense explainer) is
what to build new info dialogs on:

- `_openInfoModal({ title, html, onWire? })` — opens `#ccInfoModal` (same card
  chrome as the daycare popup: `.cc-modal-*` classes, back/close, scroll floatbar).
  `html` is a string or `() => string`; `onWire(root, contentEl)` runs after paint
  (wire buttons here).
- `_pushInfoView(view)` drills into a sub-view; the ← button (`_infoModalBack`)
  pops one level, or closes at the root. `_closeInfoModal()` closes + clears.
- The round "i" button style is shared: selector `#creatureInventory .dc-odds-info,
  .cc-info-btn`. Put `class="cc-info-btn"` on a new button; if it sits in a
  `.subview-title` h3 whose text gets overwritten (like `.craft-title`), wrap the
  text in its own span so the button survives.

Content builders for the incense case: `_incenseInfoHtml`, `_typeChartHtml`,
`_typeDetailHtml`, `_typeStrongAgainst` (inverse of `_TYPE_STRONG`),
`_ccTypeChip/_ccTypeChips`. Type-chart data lives in `_TYPE_STRONG` /
`_TYPE_REDUCED` / `TYPE_COLORS` (~creatures.js:2840-2914) — reuse, don't duplicate.

**DONE (2026-07-13): the "daily/weekly theme types dropdown" task.** The weather
row (`renderWeatherBar`, "Today:/Week:" chips) is now a `<button class="weather-row">`
that opens `_showThemeOdds()` → `_themeOddsHtml()` via `_openInfoModal`. Odds come
from **`Spawns.typeOdds(nowMs)`** (added to static/spawns.js, exported) — realized
per-*type-slot* shares (each spawn is a 2-type fusion → 2 slots) read off the live
`_composePairSampler`, so empty pools (e.g. no FLYING-primary) are already baked in;
returns `{daily, weekly, same, dailyShare, weeklyShare, otherShare, perType}`.
Render helpers `_ccOddsSeg`/`_ccOddsLegend` reuse the `cc-oddsbar` styling. Tested in
tests/theme-odds.test.js. Reuse `Spawns.typeOdds` for any future "what spawns today"
UI rather than recomputing bucket weights. See [[reference-pokedex-architecture]].
