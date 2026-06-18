# Session Handoff 3

Summary of everything changed in this session. **All code lives in `static/` (the
source of truth).** Nothing has been deployed yet.

## Deployment / rollout (read first)

- **Web / Flask (`run.py`)** serves `static/` directly → changes are live on reload.
- **Native iOS/Android** bundle `dist/`, which is **regenerated from `static/`** by
  `scripts/build-capacitor.sh` (`cp -R static/.`). So native needs:
  `scripts/build-capacitor.sh` → build app → **`adb install -r`** (the `-r` keeps
  localStorage + IndexedDB; **never uninstall**, that wipes the collection).
- **Live-update ("Refresh" button) is iOS-only.** It needs the Swift `BundleAccess`
  + `LocalServer` plugins (`ios-overrides/`); Android has no equivalent, so Android
  only updates via a new APK. iOS friends can just tap Refresh (after you deploy
  `static/` to `poke.phylliidaassets.org`, which is where live-update pulls from).
- localStorage quota is ~5 MB on **every** platform (Android WebView = Chromium too),
  which is what drove the IndexedDB migration below.

## Save-file edits already applied (Grak's newest save)

These are done on disk in `saves/` (backup in `saves/backup-before-candy-grant/`):
- **+100 Magikarp candy** (family key `"129"` → 107), **+50 Eevee candy** (`"133"` → 57).
- Restored a **shiny Exeggcute × Paras** (`speciesA:102, speciesB:46`, `shinyVariant:7`,
  tagged `Shiny`) that was lost to the quota bug.
- Grak applies these via **Settings → Load** (do it before the next server Save).

---

## 1. localStorage quota bug → IndexedDB migration (`creatures.js`, `index.html`)

Root cause of "catches don't save / can re-catch repeatedly / QuotaExceededError":
the whole save lived in localStorage (~5 MB cap) and the collection alone was >3 MB.

- `_capStore` (captured) and `_seenStore` (seenFusions) now persist to a new IDB DB
  **`creature-collection-v1`** (store `kv`, keys `captured`/`seenFusions`).
  - Reads stay synchronous (in-memory cache); `_hydrateCStore()` loads from IDB at
    boot and runs a one-time localStorage→IDB migration, then **deletes the LS keys**
    (freed ~2.9 MB). Coalesced last-write-wins IDB writer (`_makeIdbWriter`), guarded
    so nothing persists before hydration (`_whenReady()` awaited in the catch path).
- Export/import/wipe in `index.html` route through `Creatures.getAllCaptured/
  replaceAllCaptured/getSeenFusions/setSeenFusions` (LS only as fallback).
- Catch flow hardened: candy + caught-spawn writes wrapped so a write can't abort the
  catch mid-way.
- **Global error logging**: `window._ccErrors` ring + `window._ccLogError` (defined in
  `<head>`), fed by `window.onerror`/`unhandledrejection`/`console.error` and
  `_logCreatureError`. Surfaced in the Settings diagnostic dump as an `[errors]`
  section (in-memory; localStorage is the thing that fills up).
- Verified with a sandbox harness against Grak's real save (4,654 captures migrated,
  ids preserved, 2.92 MB freed).

## 2. Hatched-tag fix (`creatures.js`)

`getInventoryCreatures()` dropped `fromEgg` from the normalized object, so the
`Hatched` built-in tag predicate (`c.fromEgg === true`) never matched. Carried
`fromEgg` through. (Same class of bug fixed again for incense in #7.)

## 3. Fractals viewer (Extras) — `static/mandelbrot/`, `extras.js`

Vendored the bertbaron/mandelbrot app into **`static/mandelbrot/`** (auto-served +
auto-bundled). Made it offline-safe:
- Renamed all `.mjs` → `.js` (+ rewrote imports) to dodge ES-module MIME breakage on
  Flask / iOS GCDWebServer / Android WebViewAssetLoader.
- Vendored Bootstrap to `static/mandelbrot/vendor/`, removed Google Analytics, dropped
  the dead favicon. Stripped the ~9 MB unused example PNGs.

`extras.js` adds a **Fractals** bubble → fullscreen `#fractalsWindow` with an iframe
(same-origin, so the parent reaches into `contentDocument` directly):
- **Immersive** layout (fake the app's `.fullscreen` classes — no `requestFullscreen`,
  which iOS blocks); ☰ toggles the floating settings (pinned to the **bottom**).
- **Tap-to-zoom** in the fractal (`index.js`): single tap zooms ~2× at the point,
  distinguishing tap vs pan/pinch.
- **Save/Browse** (own IDB DB `cc-extras-v1`, store `fractals`): name + `?params=`
  permalink + small **JPEG** preview (~5 KB). Hold-to-delete (2 s). Exposed via
  `window.ExtrasFractals.{all,importMerge}`.
- **Resume last view** via `localStorage.cc.fractalLast.v1`.
- **Defaults**: Smooth **off**, Supersample **on**, the two **mutually exclusive**.
- Saved fractals + last-view ride in the save file (`index.html` export/import).

## 4. Legendary fusions (`spawns.js`)

Independent deterministic stream (NOT touching `generateCellAtTick`), merged into
`spawnsInBbox`:
- `generateLegendaryAtTick` / `legendariesInBbox`; ids `L:cx:cy:legtick:0`.
- Head = uniform gen-1 legendary (`GEN1_LEGENDARY_IDS = [144,145,146,150,151]`); body =
  uniform any loaded species (incl. other legendaries).
- Coarse **6-h ticks**, **1-day lifetime**; cheap hash pre-filter so the scan is trivial.
- Rarity **density-matched to ~1/4000** of normal spawns (`LEG_RARITY = 4000`).
- `isSpawnIdStale` handles `L:`. Deterministic by `(cell, tick)` → shared across players.

## 5. Incense crafting (Bag → Craft) (`creatures.js`)

- 18 **incense items** (`incense_<type>`) registered in `ITEMS` with a generated
  shaded-orb data-URI icon; helpers `_incenseKey`, `_incenseOrbIcon`.
- **Type chart**: `_TYPE_REDUCED` (≤1× sets) → `eggTypesNeutralOrEffectiveVs`;
  `_TYPE_STRONG` (2× sets) → `craftMultiplier`.
- A **Craft** view (`renderCraft`, `showCraft`, `_craftableEggsFor`, `removeEggById`):
  swipe incense-type orbs → pick a valid egg (its type neutral-or-effective vs the
  incense type; incubating eggs excluded) → confirm → egg consumed, incense granted.
- **Super-effective bonus**: 1 matching type → **2×**, two → **3×** incense; shown as a
  gold badge on the egg art and in the confirm/result text.

## 6. Incense activation / spawns (`spawns.js`, `creatures.js`, `index.html`)

Second independent deterministic spawn stream, active only while an incense burns:
- `spawns.js`: `setActiveIncense/getActiveIncense`, `generateIncenseCellAtTick`,
  `incenseSpawnsInBbox`; ids `I:cx:cy:tick:<typeIdx>` (type in the id so Fire/Water
  don't collide). Merged into `spawnsInBbox`; `isSpawnIdStale` handles `I:`.
  - **Type rule**: one slot = incense type; other = **40% any / 30% weekly / 30% daily**,
    then normal sampling. Seeded by `(cell, tick, incenseType)` → shared across players.
  - **Rate** = `INCENSE_RATE_FACTOR = 0.5` × normal (half-density → ~+50% pokémon).
  - **30-min window** (`INCENSE_DURATION_MS`); fills the full alive window **immediately**
    on activation (no ramp), hard-cuts at 30 min.
- `creatures.js`: `cc.activeIncense.v1` (`{type, startMs}`); `readActiveIncense`
  (prunes expired), `activateIncense` (consumes 1, pushes to Spawns, refreshes overlay),
  `setActiveIncenseState`, `_pushActiveIncenseToSpawns` (called in `install`).
  - **Bag UI**: active-incense banner + per-incense **Use** button (`_confirmUseIncense`).
  - **2× shiny** for incense spawns (`_rollShinyForRecord` checks `rec.spawn.incense`).
  - Catches tagged `fromIncense`/`incenseType` (carried through `getInventoryCreatures`).
  - **Encounter screen**: type-coloured incense orb top-right of the info bubble.
  - **Detail view**: "From <type> Incense" row (its own line between Lv·size stats and
    the location block).
- `index.html`: `activeIncense` in export/import (so the 30-min window survives device
  hops / restarts).
- Only one active at a time (using another replaces it).

## 7. Pokédex family-tree silhouette fix (`creatures.js`)

`renderFamilyGrid` forced the **current** cell to `seen = true` via `isCurrent`, so an
unseen fusion's own cell showed colour art while the top showed a black silhouette.
Now uses the real `isFusionSeen(a, b)`.

## 8. Focus / follow button (`index.html`)

New `FocusControl` map button **directly above the pokéball** (added *after*
`Creatures.install` because MapLibre prepends bottom-corner controls). Target/locate
SVG icon, accent-tinted when active (`.focus-btn.focus-active`).
- Toggle on → recenter on player at **zoom 16** (unless **Lock zoom** is on → keep
  current zoom), then re-center on every GPS fix (via the GeolocateControl's `geolocate`
  event). Disables **drag-panning** while on (zoom still works); re-enables when off.
- Persists in `localStorage.cc.focusFollow`; restored on launch (re-enters follow at
  current zoom, doesn't force the activation zoom on restore).

## Tunable constants

| What | Constant | File |
|---|---|---|
| Legendary rarity / cadence | `LEG_RARITY` (4000), `LEG_TICK_MS` (6h), `LEG_LIFETIME_MS` (1d) | spawns.js |
| Incense duration | `INCENSE_DURATION_MS` (30 min) | spawns.js |
| Incense spawn rate | `INCENSE_RATE_FACTOR` (0.5) | spawns.js |
| Gen-1 legendaries | `GEN1_LEGENDARY_IDS` | spawns.js |
| Focus zoom | inline `16` in `toggleFocus` | index.html |

## New storage keys (this session)

- IDB: `creature-collection-v1` (captured/seenFusions), `cc-extras-v1` (fractals).
- localStorage: `cc.activeIncense.v1`, `cc.fractalLast.v1`, `cc.focusFollow`.
- Save-file payload fields added: `fractals`, `fractalLast`, `activeIncense`
  (captured/seenFusions now read via the Creatures API).

## Verification

Everything was sanity-checked with `node --check` and, where feasible, Node `vm`
sandboxes loading the real modules (IDB migration vs Grak's save; legendary/incense
generation: determinism, rate, type-distribution, id-per-type, expiry; type chart /
craft multiplier; module-load smoke tests). The fractal viewer was headless-loaded
(no 404s, UI renders). UI rendering that needs the WebGL map couldn't be pixel-checked
headless — give the encounter orb, detail line, craft flow, and focus button a look on
the next build.

## Suggested follow-ups (not done)

- Web-PWA offline for fractals (native already bundles them; web would need SW precache).
- Optional: legendary marker glow / tougher catch (spawn has a `legendary:true` flag).
- Optional: manual-pan auto-exits Focus; GPS dead-zone to avoid micro-recenters.
- The actual incense *gameplay* is in; only the orb art was ever the placeholder.
