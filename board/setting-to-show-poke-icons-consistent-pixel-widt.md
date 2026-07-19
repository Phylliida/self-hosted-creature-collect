---
title: Setting to show poke icons consistent pixel width
status: done
claimed_by: claude-opus
created: 2026-07-19T19:25:19Z
updated: 2026-07-19T19:25:19Z
taiga_id: 71
taiga_version: 4
synced_hash: 8e7a20226b9068da
---

on the map it is correct but the encounter and pokedex and silouettes etc right now crop and zoom, we need a global setting (toggle in settings menu, match the style) that doesn't do any crop and instead uses full res everywhere, may require invalidating any cached sprites when changed

## Progress
- (2026-07-19) Claimed by claude-opus. Goal: global settings toggle → render
  creature icons at full-res / consistent pixel width (no crop/zoom) everywhere
  except the map (already correct). May need to invalidate cached sprites on
  change. Mapping the crop/zoom render paths (encounter, pokedex, silhouettes),
  the map's correct path, the sprite cache, and the settings-toggle persistence
  pattern before touching code.
- (2026-07-19) Implemented as a CSS-only, off-by-default global toggle
  `cc.consistentIconWidth`. Root-cause was found and the fix mirrors the map.
  Syntax-checked creatures.js and all 7 inline index.html scripts (0 errors),
  verified no inline/`!important` sizing defeats the new rules, and hand-checked
  CSS specificity for every overridden selector. Done.

## Writeup

### Root cause (why sprites "crop and zoom" everywhere but the map)
Sprites are stored **tightly cropped to their opaque bounding box** (in
IndexedDB and in the Capacitor sprite packs — see `static/sprites.js` header and
`scanAndCrop`). Every view fetches the *same* cropped blob through
`SpriteStore.showSprite` — there is no separate uncropped path. The only thing
that differs per view is the `<img>` CSS:

- **Map marker** (`creatures.js` `.creature-marker img.creature-sprite`) uses
  `max-width/max-height: 100%` → the blob renders at its **intrinsic pixel
  size**, only shrinking to fit. So a sprite pixel is a fixed physical size and
  small creatures stay small = what the user calls "correct".
- **Everywhere else** (battle/encounter, Pokédex card, detail/hero art, variant
  & art-picker cells, family-tree cells, evolution rows) uses
  `width/height: 100% (or 90%/72px) + object-fit: contain` → the tight crop is
  **upscaled to fill its box**, so small creatures look zoomed/chunky and their
  apparent pixel density varies view-to-view.

Silhouettes are NOT a separate path — they are the same `<img>`s with an added
`filter: brightness(0)`, so fixing the sizing fixes them too.

### The fix (CSS-only, gated behind a global toggle)
Because the "correct" map behaviour is purely the `max-width/max-height` idiom,
no crop/cache work is needed — the underlying blob is unchanged; only its layout
box changes. So the setting is a single root class.

1. **CSS** (`static/creatures.js`, in the injected `<style>` block, just after
   the completion-icon rules): a new rule under `html.cc-consistent-icons` that
   re-styles the six zoomy selectors to `width/height: auto; max-width/
   max-height: 100%` + `image-rendering: pixelated` (the map idiom). Prefixing
   each selector with `html.cc-consistent-icons` raises specificity above every
   base rule (including `.detail-art img.detail-art-img`), so it wins without
   `!important`. The map marker and the already-correct completion icon are
   deliberately NOT targeted.
2. **Toggle UI** (`static/index.html`): a new Settings row
   `#consistentIconWidthToggle` ("Consistent poké icon size (no zoom)"), styled
   like its siblings, placed right after the radar-autogen toggle.
3. **Wiring** (`static/index.html`, next to the other toggle init): reads/writes
   `localStorage['cc.consistentIconWidth']` ('1'/'0') and calls
   `window._applyConsistentIcons(on)` which toggles the `cc-consistent-icons`
   class on `<html>`. Applied at startup and on every change — flips take effect
   live via a reflow, no re-render or cache clear.
4. **Save-file persistence**: added `{ key: 'cc.consistentIconWidth', values:
   ['0','1'] }` to the `SAVED_SETTINGS` table so it rides in save/backup exports
   and is validated on import; `restoreSavedSettings()` re-syncs the checkbox and
   re-applies the class after an import.

### Behaviour / assumptions
- **Off by default** → existing users see zero change (the current object-fit
  rules remain the norm). This is opt-in, so it is safe for the live instance.
- "Consistent pixel width" is interpreted as "render at native resolution like
  the map" (1 sprite-pixel = 1 CSS px, capped to the box), NOT "draw the full
  uncropped 96×96 cell". The full-cell interpretation would need a different
  draw path and regenerated blobs (the crop is baked into IDB + the Capacitor
  packs) — far more invasive and not what the "the map is correct" reference
  implies. Documented here so a future editor can revisit if the user wanted the
  full-cell framing instead.
- Nuance: in boxes *smaller* than a sprite (e.g. the 72px variant cells vs a
  96px sprite) the sprite is still shrunk to fit — identical to how the map caps
  large sprites. In the big boxes (140px detail, ~200px battle) sprites show at
  true native size with padding around them. This exactly matches the map idiom
  the user called correct.

### Verification (honest status)
- `node --check static/creatures.js` → OK; extracted + `node --check`'d all 7
  inline `<script>` blocks in index.html → 0 syntax errors. (Confirms the CSS
  template literal has no stray backtick — see the no-backticks-in-CSS memory.)
- Grepped: no inline `.style.width/height` on the sprite `<img>`s and no
  `!important` width/height rule that could defeat the class; specificity of
  each override hand-verified to beat its base rule (incl. the `.detail-art-img`
  variant at 6879).
- NOT verified in a real browser: no DOM/headless engine is available here
  (no jsdom/puppeteer, and installing would need network, against the
  zero-network norm). The change is CSS-only and off by default, so risk is low,
  but a human should eyeball the toggle in the encounter screen + Pokédex once.
