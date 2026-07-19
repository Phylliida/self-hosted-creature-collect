---
title: Setting in setting menu (persisted in save file) that labels radar pokemon as autogen when they are autogen
status: done
claimed_by: claude-opus
created: 2026-07-13T18:24:31Z
updated: 2026-07-13T22:12:00Z
taiga_id: 67
taiga_version: 1
synced_hash: bb441346c01612c5
---

Match the autogen labeling styling we use elsewhere

## Progress
- (2026-07-13) Claimed. Mapped the radar feature in creatures.js:
  - `_radarMakeMarkerEl(sp)` (~13661) builds each blip: a black-silhouette
    `.radar-marker` with a `.radar-marker-label` countdown pill + `.radar-marker-img`.
  - Blips come from `Spawns.nearestRadar(...)`; each `sp` has `speciesA`/`speciesB`.
  - "autogen-ness" of a fusion = `Sprites.getCellVariantCount(a,b) === 0` (async, but
    O(1) after the variant summary loads). Same test the pokedex uses at
    creatures.js:10152/10163 to render its `variant-cell autogen` badge (label "autogen").
- Save-file-persisted settings pattern (index.html): stored in a `cc.*` localStorage
  key, added to `buildBackupPayload()` (~7435) and the import apply block (~7876), with
  a toggle row in the Settings panel + wiring near line 16300 (mirrors `autoBackup`,
  `steadyCatch`, `pedometerEnabled`).
- Consulted the local model on the radar-labeling UX: it confirmed (1) put the pill
  directly on the blip, (2) default OFF (opt-in — map clutter is the enemy, and the
  mystery adds a little discovery), (3) keep the pill visually distinct from the
  countdown timer and reuse the pokedex autogen accent.
- Implemented (below). All tests pass, incl. the new radar-autogen-label gate test and
  the radar-tag regression.

## Writeup
Added a save-file-persisted Settings toggle **"Show autogen labels on radar"** (default
OFF). When on, any poké-radar blip whose fusion has *no* hand-drawn art gets a small
"autogen" pill under its countdown, so the player can decide whether a distant target is
worth the walk. This reuses the exact autogen signal the pokedex art grid uses.

### How it works
- **Autogen detection** — a fusion is autogen when `Sprites.getCellVariantCount(a,b)`
  is `0`. That's async but O(1) once the sprite variant-summary blob has loaded (same
  call, with the same `.catch(() => 0)`, the pokedex uses at creatures.js:10152/10163).
- **creatures.js**
  - `RADAR_AUTOGEN_LABEL_KEY = 'cc.radarAutogenLabels'` + `_radarAutogenLabelsOn()`
    (reads localStorage live, so the toggle can flip mid-session).
  - `_radarShouldLabelAutogen(settingOn, variantCount)` — a tiny pure gate
    (`settingOn === true && variantCount === 0`) so the decision is unit-tested and
    can't be silently inverted. The strict `=== true` guards against a truthy
    non-boolean (e.g. a stray `'1'`) sneaking the label in.
  - `_radarMakeMarkerEl` — when the setting is on, fires the count lookup and, if the
    fusion is autogen, inserts a `.radar-marker-autogen` pill *between* the countdown
    pill and the silhouette (countdown stays the top/primary read). No lookup fires at
    all when the setting is off, so blips stay free when the feature is unused. The pill
    hides with the blip when the real in-range marker takes over (the whole
    `.radar-marker` el is `display:none`'d there).
  - `.radar-marker-autogen` CSS — a small uppercase pill filled with
    `var(--ui-accent, #b6896c)` (the same accent that marks the pokedex autogen badge),
    smaller than the countdown pill and clearly distinct from the dark timer pill.
  - `rerenderRadarMarkers()` (exposed as `Creatures.rerenderRadar`) — blips are cached
    and reused across refreshes, so toggling the setting rebuilds live blips at once.
- **index.html**
  - New Settings row `#radarAutogenToggle` "Show autogen labels on radar" (with a
    `title=` explainer), placed just after the Guaranteed-catch row.
  - Wiring near the steady-catch wiring: read/write `cc.radarAutogenLabels`, and call
    `Creatures.rerenderRadar()` on change for an immediate live update.
  - `buildBackupPayload()` carries `radarAutogenLabels`; the import-apply block restores
    it (`'1'`/`'0'` only), matching the `autoBackup` / `pedometerEnabled` pattern — the
    post-import reload makes the checkbox reflect it.

### Tests
- `tests/radar-autogen-label.test.js` (new) — pins the gate: OFF never labels; ON labels
  iff count is exactly 0; only literal `true` counts as "on".
- Re-ran the full `tests/*.test.js` suite — all pass (incl. `radar-tag.test.js`).

### Assumptions / notes
- Default OFF (opt-in) per the local-model design sync and to keep the map uncluttered;
  existing users see zero behavior change until they enable it.
- "Match the styling we use elsewhere" is interpreted as: same *word* ("autogen") and
  same *accent token* as the pokedex badge, restyled as an on-map pill for legibility
  (a muted grey-bordered badge like `evo-autogen-only` would be low-contrast over map
  tiles). Not a pixel-identical clone of the pokedex cell.
- Not verified in a live browser (needs Flask + map data); the change is additive,
  gated, and default-off, and `_radarMakeMarkerEl`'s pill insertion mirrors the existing
  countdown-pill DOM construction. `node --check static/creatures.js` passes.
- `dist/` is an untracked build artifact; only `static/` was edited (matches prior commits).
