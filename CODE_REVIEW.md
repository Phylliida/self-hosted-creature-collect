# CODE_REVIEW.md

Read-pass findings from a thorough walk of `static/` (every line of `creatures.js`, `index.html`, `sprites.js`, `appdata.js`, `species.js`, `spawns.js`, `sw.js`, `live-update.js`, `trip-planner.js`, `dex.html`).

No code changes. Findings + an ordered extraction plan.

---

## 1. What's actually in there

### Static files, by line count

| file                | lines  | role                                        |
|---------------------|--------|---------------------------------------------|
| `index.html`        | 11321  | shell HTML, ~2400 lines CSS, ~7800 lines inline `<script>` |
| `creatures.js`      |  9294  | creature UI panel + map markers + battle + daycare + eggs + tags + ~2100 lines inline CSS |
| `sprites.js`        |  1769  | fusion-sprite IDB + pack-direct + shared sprite-URL cache |
| `dex.html`          |   785  | server-rendered standalone sprite browser   |
| `appdata.js`        |   448  | icons + fonts IDB store                     |
| `spawns.js`         |   371  | deterministic spawn PRNG                    |
| `sw.js`             |   313  | service worker (tile cache + region download) |
| `trip-planner.js`   |   239  | pure Dijkstra factory                       |
| `live-update.js`    |   230  | Capacitor live-update flow                  |
| `species.js`        |   244  | species names + types + evolutions          |
| `appdata.js`        |   448  | (counted above)                             |

Total ~25 k lines, ~80% of which lives in two files (`index.html`, `creatures.js`).

### `index.html` structural skeleton

```
   1– 14   head meta
  15–2424  <style>  (2410 lines of CSS)
            ├─ shared panel theming + utility CSS  (~160 lines)
            ├─ per-theme decoration: ~50 themes × 20–60 lines each  (~1900 lines)
            └─ panel-specific CSS (#poiCard, #routingPanel, etc.)   (~350 lines)
 2425–2625 <script>  flash-prevention theme bootstrap + window.THEMES dict (50 themes × ~3 lines)
 2627–2748 debug-console DOM + capture IIFE
 2749–2814 emergency-refresh button (pure HTML + inline onclick)
 2815–3195 panels HTML  (transit, pin bar, POI card, routing, directions, saved routes, schedule, fav, settings, install, app-data-missing, welcome, offline-maps)
 3196–3510 Capacitor setup IIFE  (geolocation shim, fetch interceptor, memBadge)
 3511–3518 external <script src>s (maplibre + 7 of our modules)
 3519–11319 the main app IIFE  (7800 lines, see below)
```

### The 7800-line `(async () => {...})()` in `index.html`

Roughly ordered top-to-bottom:

```
 3520–4034  POI / Routes / Schedule / Walk / HN / Addresses / Favorites IDB stores
            ├─ POI binary hydrate (POIB magic, string pool)
            └─ Address binary hydrate (ADDR magic, two string pools)
 4035–4068  tile math + region helpers
 4069–4204  startup: SW registration, font preload, Capacitor icon preload
 4205–4481  map construction + style + layers
 4482–4549  pin tool (PinControl + startAddPin / cancelAddPin / confirmAddPin)
 4552–4742  transit panel (modes, routes, search)
 4744–4882  themes (THEMES dict reference, applyTheme — full layer recolor)
 4883–4917  control classes (SettingsControl, RoutingControl)
 4919–5106  GeolocateControl + startup phase timing
 5109–5375  icon system: svgToImageData, ICON_ALIAS_MAP, safeAddImage, loadIcon, loadAllIcons
 5377–5501  theme picker grid (renderThemeGrid + previewSVG)
 5503–5546  units / clock / timezone selects
 5547–5945  backup payload: buildBackupPayload, exportData, importData, saveToServer, loadFromServer
 5949–6499  POI cooldowns (read/write, polygon expressions, building distance expr, marker style)
 6500–6709  POI card render + sync collect button + per-second countdown
 6710–6913  selectedMarker management + favorites system (modal, save, color picker)
 6915–7290  walk route rendering + saved routes panel + schedule modal flow
 7297–7340  alternatives planner, makeActiveTrips
 7344–7679  multimodal directions render + route choices strip + transit step HTML
 7677–7847  routing panel + endpoint autocomplete (favorites + POIs + addresses)
 7851–7929  POI card → directions, "Collect items" pokéstop flow + cooldown propagation
 7931–7989  wipe button (delete all data)
 7991–8210  click-on-map dispatch (transit popup vs POI vs building pokéstop)
 8222–8297  loadAllPois + window.CreatureCollectAPI (findNearestNamedPoi, findNearestPlace)
 8299–8511  search box (virtualized scroll, POI + address + favorite matching)
 8512–8869  region-download flow + fetchAndSavePois / fetchAndSaveWalkGraph
 8870–9013  housenumbers (parse, lazy-load, viewport-bounded render)
 9014–9202  walk-graph binary parsing (v3) + shape blob decoding + clipShapeBetweenStops
 9204–9450  rebuildWalkGraph (multi-region merge, CSR adjacency) + lazy-load + viewport-aware cull
 9451–9685  memory probe + sprite-inflight badge + startup-phase dump + MinHeap
 9686–9742  TripPlanner.create wiring + A* fallback
 9743–10119 multimodal coord builders + collectTripStops + multimodalInstructions + tripTotalsHtml
 10120–10333 timing cache + scheduleIdx + rebuildScheduleIndex
 10334–10455 walltimeInTz / todayInfo / nextDeparturesForOsmNodes / formatDepartureTime
 10457–10578 viewedRoutes, refreshStopsSource, refreshRoutesSource, rebuildTransitFromSchedule
 10580–10735 wifiGate, performRegionDownload, refreshRegion, downloadBtn
 10737–10840 app-data download flow (fonts → icons → tiles → sprites)
 10843–10947 welcome card + appDataMissing banner
 10950–11318 settings toggles (panel, wifi, creature mode, action icons, lock zoom/rotate, mem badge, debug console, building POIs, visibility info, render buildings/transit/HN, backup name, sprites status, remark autogen, repopulate daycare loot)
```

### `creatures.js` structural skeleton

```
    1–  100  module preamble, constants (CANDY_*, EGGS_*, INCUBATOR_*, DAYCARE_*, BUILTIN_TAG, etc.)
  100–  180  ITEMS catalog (poke_ball / great_ball / test_orb + 17 evo items)
  180–  300  capture storage + candy storage + family-root + lazy migration
  300–  335  item bag (read / write / grant / consume)
  336–  555  daycare slots + eggs + incubator (storage + add/remove/swap + hatch)
  555–  825  daycare loot rolls (cross-breed eggs) + grant logic + pill icon CSS
  826– 1110  built-in tags (Pure, Daycare) + tag predicate dispatch
 1112– 1235  user tags storage + caught spawn IDs
 1235– 1505  inventory normalization + seen fusions + variant backfill migrations
 1505– 1640  fusionName, type chips, candy tally HTML
 1640– 1820  virtualizeGrid (windowed grid renderer) + family-tree grid
 1820– 1920  evolution-method formatter + size formatter + escapeHtml
 1920– 2050  attachSpeciesAutocomplete + nicknames + findCreature
 2050– 2200  sort/filter readers, TYPE_COLORS, applyTypeSelectColor
 2207– 4337  injectStyles — 2100 lines of inline CSS for every UI surface
 4341– 4878  ensurePanel — DOM construction, every event handler wiring
 4878– 5450  view stack (_viewStack), applyTopView, push/pop, filter capture/restore, swipe drag, slot cache
 5450– 5625  eggs view + incubator render
 5625– 5755  egg drag-drop (pointer events, ghost element)
 5755– 5830  tags view
 5835– 5940  bag view + candy view + speciesNameFor
 5942– 6225  daycare view (calendar, today's distance, slot rows, loot tick animations, show-on-map)
 6228– 6300  variant grid (sprite + credits)
 6300– 6545  fusion view (header, captures list, encounter info, family tree, art variants)
 6545– 6770  filter indicators + pokedex tag filter row + renderPokedex
 6770– 7036  renderDetail + enterRenameMode + _exitRenameMode
 7036– 7180  header actions (text vs icons), weather bar, save reminder, openSettingsFromInventory
 7180– 7340  renderInvTagFilterRow + renderList
 7340– 7400  show/hide
 7340– 7920  spawn-marker management + battle screen scaffolding + GPS daycare distance + IDB tracker + path overlay
 7950– 8580  battle screen (throwBall animation, arc + suck-in + wobble + caught/break)
 8580– 8900  marker batch loading, refreshSpawnOverlay, attachSpawnOverlay
 8900– 9170  daycare path map overlay (line layer + bubble control + style.load re-add)
 9170– 9290  install() + exports
```

---

## 2. The biggest single win: CSS extraction (mechanical, low risk)

Both giant files have an embedded `<style>` (index.html) or `injectStyles` template literal (creatures.js) that together account for **~4500 lines** of CSS sitting inside JS or HTML. Pulling them into real `.css` files would shrink the JS we have to reason about by ~30% with no semantic change.

- `creatures.js:2207–4337` → `static/creatures.css`. The only template-interpolated values are `CANDY_CELL_PX`, `CANDY_SHEET_COLS`, `CANDY_SHEET_ROWS`, `BUNDLED_BASE` — all derivable from CSS custom properties or from per-element `style="background-position: ..."` attributes the JS already sets. ~2100 lines extracted.
- `index.html:175–1267` (per-theme decoration blocks) → `static/themes.css`. ~1100 lines extracted.
- `index.html:15–175 + 1267–2424` (shared panel CSS) → `static/index.css`. ~1300 lines extracted.

After phase A: `index.html` becomes ~7800 lines, `creatures.js` becomes ~7200 lines. Plus we get hot CSS reloading and the styles become greppable separately from the JS.

---

## 3. Extraction candidates inside `creatures.js`

In order of independence (least coupled first):

| Proposed file        | Pulls in                                                                                       | Lines  | Notes                                                                                            |
|----------------------|------------------------------------------------------------------------------------------------|--------|--------------------------------------------------------------------------------------------------|
| `tags.js`            | `BUILTIN_TAGS`, `readTags`/`writeTags`, `addTag`/`deleteTag`/`toggleCreatureTag`, helpers      | ~200   | Already a self-contained slice. Built-in `Daycare` tag references daycare slots — that callback would move when daycare moves. |
| `pokedex-data.js`    | `seenFusions`/`readSeenVariants`, variant-backfill migrations, `caughtFusionsSet`              | ~250   | Pure data. Migrations should land here with their own `cc.variantBackfillDone.v1` flag.          |
| `eggs.js`            | egg storage (read/write/addEgg/hatchEgg) + incubator slot storage                              | ~250   | The egg-tile drag-drop UI stays in the inventory panel layer; the data slice is portable.        |
| `daycare-state.js`   | `readDaycareSlots`/`addToDaycare`/`_accumulateDaycareDistance`, IDB tracker, loot rolls + grants | ~700  | GPS distance accumulation feeds incubator + slot distM + loot milestones — load-bearing for both.|
| `markers.js`         | `_markers` map, `addMarker`/`addMarkersBatch`/`removeMarker`, `refreshSpawnOverlay`, `attachSpawnOverlay`, GeolocateControl wiring, MIN_DISPLAY_MS, deferred refresh | ~700 | Biggest single extract. The `cc-sprite-loaded` listener wakes red dots — keep that wiring with markers. |
| `battle.js`          | `openBattleScreen`/`closeBattleScreen`/`throwBall`/`_throwBallImpl`, ball animations, `populateBattleBalls`, `cancelAnimsOn`, `_throwInFlight` | ~700 | Largely independent — talks to capture/candy storage and to the inventory `showDetail`.        |
| `inventory-ui.js`    | `ensurePanel`, view stack, swipe drag, slot cache, all the sub-view renderers (`renderEggs`/`renderTags`/`renderBag`/`renderCandy`/`renderDaycare`/`renderFusionView`/`renderDetail`/`renderPokedex`/`renderList`) | ~3000 | The hardest extract because every sub-view both reads from and writes to the storage slices above. Probably second-to-last. |
| `virt-grid.js`       | `virtualizeGrid` + `revokeObjectUrlsIn`                                                        | ~200   | Reusable utility. Could also become a shared module for any future virtualized list.            |

Caveats:
- `BUILTIN_TAGS` defines the `Daycare` tag with an `onToggle` that calls `toggleDaycare`. After extraction, `tags.js` needs to either (a) accept a registration API and have `daycare.js` register the built-in, or (b) accept a dispatch hook. The cleanest seam IMO is `tags.js` exposes `registerBuiltinTag(spec)` and `daycare.js` calls it on init.
- Most of these modules are mutually reachable today through `window.Creatures` and direct closures. Splitting forces us to draw real boundaries — that's the point of doing this.

---

## 4. Extraction candidates inside `index.html`

The 7800-line IIFE is much harder than `creatures.js` because most of it interlocks with `map` and several shared mutable maps (`scheduleIdx`, `walkGraph`, `routeMetaIndex`, `allPois`, `allAddresses`, `favorites`). The right approach is probably to dump the whole IIFE into one `static/app.js` first (single mechanical move, no semantic change), then carve modules out of *that*.

Once it's in `static/app.js`, the natural seams:

| Proposed file        | Pulls in                                                                                  | Lines |
|----------------------|-------------------------------------------------------------------------------------------|-------|
| `idb-stores.js`      | every `openXxxDB` / `saveXxx` / `loadAllXxx` / `deleteXxxByRegion` block                  | ~500  |
| `binary-hydrate.js`  | POI / walk / HN / addresses binary decoders                                               | ~400  |
| `themes.js`          | `window.THEMES`, `applyTheme`, theme grid, theme preview SVG, custom-theme inputs         | ~600  |
| `backup.js`          | `buildBackupPayload` / `exportData` / `importData` / `saveToServer` / `loadFromServer`    | ~500  |
| `poi-card.js`        | `setSelected`, `renderPoiCard`, `selectedMarker`, fav modal, pin tool                     | ~700  |
| `poi-cooldowns.js`   | cooldown storage + polygon/distance expressions + halo layer + collect-items flow         | ~600  |
| `routing.js`         | walkgraph A*, multimodal Dijkstra wiring, route render, alternatives, saved routes, schedule modal | ~2500 |
| `region-download.js` | `performRegionDownload`, `fetchAndSave*`, walkgraph parsing + lazy-load + viewport cull   | ~1000 |
| `search.js`          | POI/address/favorite virtualized search box                                               | ~300  |
| `settings.js`        | every `getElementById('xxxToggle').addEventListener('change', ...)` block + apply fns     | ~700  |
| `transit-popup.js`   | `showTransitPopup`, schedule modal, departures rendering                                  | ~400  |
| `welcome.js`         | welcome card + app-data-missing banner + welcome-step state machine                       | ~150  |
| `app.js`             | the remaining map setup, initial wire-up, what's left after the modules above             | ~500  |

Combined with phase A's CSS extraction, `index.html` itself drops to ~500 lines of HTML + a thin orchestrator script.

---

## 5. Duplicated patterns worth a tiny utility pass

These are independent of the big extractions — could land first as low-risk cleanup.

1. **localStorage JSON read/write** — `try { JSON.parse(localStorage.getItem(K)) } catch { return default }` appears ~50 times across both files. A `lsGet(key, fallback)` / `lsSet(key, value)` helper would tighten dozens of blocks.

2. **IDB store boilerplate** — the `openXxxDB / saveXxxRegion / loadAllXxx / deleteXxxByRegion` pattern is repeated **seven times** in `index.html` with identical shape (POI / routes / schedule / walk / housenumbers / addresses / favorites). One `makeRegionStore({ name, version, store, keyPath })` factory could replace ~400 lines with ~60.

3. **Haversine** — at least three implementations in `index.html` (`haversineKm`, `haversineM`, `haversineMeters`) plus `metersBetween` in `creatures.js`. Two enough (km + m), one shared module.

4. **HTML escape** — `esc()` (one-liner regex) in `index.html`, `escapeHtml()` (object lookup) in `creatures.js`, third copy in `dex.html`. Pick one and share.

5. **Settings toggle wireup** — every checkbox in the Settings panel does:
   ```js
   const t = document.getElementById('xToggle');
   if (t) {
     t.checked = localStorage.getItem('cc.x') === '1';
     t.addEventListener('change', () => {
       localStorage.setItem('cc.x', t.checked ? '1' : '0');
       applyX(t.checked);
     });
   }
   ```
   ~12 instances. Becomes `wireToggle('xToggle', 'cc.x', applyX)`.

6. **Diagnostics dump grounds** — `window._spriteDiag`, `window._addImageStats`, `window._loadAllIconsDiag`, `window._iconDecodeStats`, `window._iconDownloadFail`, `window._creditDiag`, `window._iconProbe`, `window._lastMem`, `window._ccFetchLog`, `window._startupPhases`. These are write-only debug surface. Consolidate into `window.CC_DIAG = { startup, sprites, addImage, iconLoad, ... }`.

7. **Theme decoration CSS** — every theme block follows the same pattern: `html[data-theme="X"] button { ... }`, `html[data-theme="X"] #settingsPanel h3 { ... }`. If the THEMES dict carried these rules as data (`{ fonts: '...', heading: { transform: 'uppercase', ... }, button: { boxShadow: '...' } }`), the CSS could be generated. Probably not worth doing — CSS is mechanically extractable from existing strings and the theme dict is already 200 lines.

---

## 6. Dead / stale code to delete

Easy wins. None of these are load-bearing:

- **`creatures.js:5637` `let _eggDragState = null;`** — declared at module scope, never read. Each `_onEggPointerDown` invocation owns its own closure state. Delete.
- **`sprites.js:898 _emitSpriteReady`** — fires `cc-sprite-loaded`, listened to by `creatures.js:9208`. But no caller in `sprites.js` invokes `_emitSpriteReady`. Either wire it up at the lazy-crop success path (where it belongs — the listener exists for that) or delete it. I think the call sites were lost in the pack-direct pivot.
- **`creatures.js`'s `cc-sprites-bulk-ready` listener at L9235** — eager-crop flow was removed; nothing dispatches this event anymore. Listener never fires.
- **`creatures.js`'s `_idbBulkPut` at L132 in sprites.js** — leftover from the IDB-cached pack experiment. The comment even says so. Not exported, not called. Delete.
- **`creatures.js`'s `remarkAutogenCapturesWithCustomArt` + the Settings row in index.html** — its own comment says "TEMP: one-shot migration ... Remove once the user has clicked once." The user has clicked. Delete.
- **`creatures.js`'s `cc.candyMigrated.speciesV1` / `cc.candyMigrated.familyV1` cleanup** — done in `migrateCandyIfNeeded`. The keys themselves are already deleted on first family-v2 migration. Could fold the cleanup into a one-line `localStorage.removeItem` pass and stop checking forever.

---

## 7. Architectural seams worth thinking about (not urgent)

- **`window.CreatureCollectAPI`** is a circular dependency: `creatures.js` reads it for `findNearestNamedPoi` / `findNearestPlace`, both of which are defined inside `index.html`'s IIFE. Today it works because the IIFE installs the API before any creature mode action fires, but the load order is fragile. The cleanest fix is to inject these into `Creatures.install(map, { findNearestNamedPoi, findNearestPlace })`.

- **`_currentBattleSpawn`, `_currentBattleSpawn === spawn`** stale-load guard pattern is repeated. Could become a tiny `currentBattle` controller.

- **The view-stack filter snapshot/restore mechanism** (`_capturePokedexFilters` / `_captureInventoryFilters` etc.) is duplicated for two views with the same shape. If a third view ever wants this it'll be cut-paste #3. Could be `captureFilters(panel, schema)` / `applyFilters(panel, schema, snapshot)` with a small schema description.

- **Sprite cache + per-img generation counter** in `sprites.js` is a good pattern. Could promote to a generic "cancel stale async assignment into DOM" helper for the cases where we do this manually (e.g., several places in creatures.js's slot rendering).

---

## 8. Recommended order of operations

Phase A (CSS, mechanical):
1. Extract `creatures.js`'s `<style>` → `static/creatures.css`.
2. Extract `index.html`'s theme decoration CSS → `static/themes.css`.
3. Extract `index.html`'s panel/utility CSS → `static/index.css`.

Phase B (small utilities, low risk):
4. `lsGet` / `lsSet` helpers — sweep 50 sites.
5. `makeRegionStore` factory in `idb-stores.js`.
6. Consolidate `haversine*` and `esc/escapeHtml`.
7. `wireToggle(id, key, applyFn)` for the Settings block.
8. Delete the dead code in §6.

Phase C (carve modules from `creatures.js`):
9. `tags.js`, `pokedex-data.js`, `eggs.js`, `virt-grid.js` — small, mostly-pure slices first.
10. `daycare-state.js` — chunkier but isolated.
11. `markers.js` — biggest user of `Sprites`, mostly self-contained.
12. `battle.js` — animation choreography only.

Phase D (carve modules from `index.html`):
13. First: dump the entire main IIFE into `static/app.js`. No splitting, just move.
14. Then peel off `themes.js`, `idb-stores.js`, `binary-hydrate.js`, `backup.js`, `transit-popup.js`, `welcome.js`, `search.js` in any order.
15. Then `poi-card.js` + `poi-cooldowns.js` (these touch each other).
16. Then `settings.js` (touches every other module's state).
17. Then `routing.js` and `region-download.js` (biggest, but cleanly defined now).
18. What's left in `app.js` is the actual orchestration — map setup, control add, initial state load.

End state:
- `index.html` ≈ 500 lines (pure HTML + linked CSS/JS).
- `creatures.js` ≈ 2500 lines (just `inventory-ui.js`, after everything else has moved out).
- A dozen 200–700-line modules with explicit dependencies.

That last shape is reasonable to hold in one head.
