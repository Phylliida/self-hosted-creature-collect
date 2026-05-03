# Session handoff

Long session touching memory/disk optimisation, GTFS ingest hardening, and a
full medieval-theme refactor with generalised UI variables. The map works,
all wipes work, tiles + walk graph + POIs + housenumbers all ship as binary
bundles. This note is for whoever (including a future Claude) picks this up.

## Files added this session

| File | Role |
|---|---|
| `bench-walk.py` | Benches `/walk-graph` for a bbox, parses the WALK binary, prints per-column byte breakdown + hypothetical wins. |
| `bench-tiles.py` | Reads `data/*.mbtiles` directly, per-layer byte table + per-zoom distribution + top-N heaviest tiles. |
| `build-housenumbers.py` | Extracts addr:housenumber nodes/ways → `data/<name>.housenumbers.sqlite` with rtree. |
| `get-shapefiles.sh` | Downloads Natural Earth land/ocean/urban/glacier/ice-shelf into `landcover/*`. Run once. |
| `get-transit-region.sh` | Generic GTFS pipeline (catalog → filter → ingest → link). Takes `LABEL CC1 CC2 …`. |
| `get-transit-{north-america,south-america,europe,asia,africa,oceania}.sh` | Thin wrappers over `get-transit-region.sh` with per-continent country code lists. North America is its own hand-tuned script (STM append). |

## Binary bundles in play

Three separate binary formats are now served from the server and stored in
IndexedDB (one ArrayBuffer per region, `{regionId, buffer}` records).

### WALK bundle (`cc.walk.v5`, magic `WALK`, version 3)
Server: `/walk-graph?bbox=`. Size for a Montreal-ish bbox: ~20 MB.
- Header 48 B: magic, version, N, E, M (names), namesByteLen, shapesByteLen, u8End, u16End, nameIdxWidth, shapeEdgeCount, reserved.
- Nodes: N × (f64 osm_id, f32 lng, f32 lat) laid out as three parallel columns.
- Edges 4-byte cols: E × (u32 from, u32 to). `shape_off` / `shape_len` are *not* per-edge here — they're sparse (see below).
- **Weight cascade** — edges are sorted ascending by weight. Two split indices in the header say where u8 weights end and u16 weights end. ~98% of pedestrian edges are ≤255 m so they fit in u8. Client materialises back to `Float32Array(E)` at load.
- **name_idx** — 1/2/4-byte fixed width based on the region's unique-name count. Sentinel (all ones) = "no name".
- **Shapes** — has-shape bitmap (1 bit/edge, aligned to 4) + sparse `(u32 off, u16 len)` pairs for only the ~10% of edges that actually have a shape blob. Saves ~5 MB vs a dense `(off, len)` column.
- Client: `viewWalkRegion(buffer)` materialises typed-array views + dense `edgeShapeOff/Len` arrays.

### POI bundle (`cc.pois.v2`, magic `POIB`, version 1)
Server: `/poi?bbox=`. Size: ~5 MB (Montreal bbox).
- Header 32 B.
- Columns: N × f32 lng, N × f32 lat, N × i32 name_idx, N × i32 category_idx, N × u32 props_off (0xFFFFFFFF = none).
- Shared string pool: M × (u16 len + utf8). Every POI's name/category/props value is an index into this pool, so duplicate strings ("Starbucks", street names) occupy one slot instead of N.
- Per-POI props: u8 field_count, then field_count × (u8 field_code, u32 string_idx). `POI_FIELDS` array is hardcoded in both `run.py` and `static/index.html` and MUST stay in order — adding fields is append-only.
- Client hydrates into flat POI objects where every string is a reference into the pool (hidden-class stable, heavy string dedup).

### Housenumbers bundle (`cc.housenumbers.v1`, magic `HSNB`, version 1)
Server: `/housenumbers?bbox=`. Size: ~4 MB for ~600k housenumber points.
- Header 40 B: magic, version, N, M, stringsByteLen, reserved, f32 bbox W/S/E/N.
- Columns: N × u16 lng_q, N × u16 lat_q, N × u16 str_idx. Coords are quantised into the bbox at u16 resolution (~1 m/axis for a city-sized region).
- String pool: M × (u16 len + utf8).
- Client: **lazy-parsed** at first zoom ≥ 16 (see `ensureHousenumbersLoaded`). Parsed regions are sorted by lng so a `moveend` handler can binary-search the visible band and push only ~100 visible features into a `housenumbers` GeoJSON source for MapLibre. Rendered via the existing `housenumbers` symbol layer at minzoom 17.
- **Tilemaker no longer emits a housenumber layer.** That layer was ~12 MB of z14 tile bytes (~15%) for features that only render at z17+. Moved out entirely.

## Server perf hotspots fixed

`/walk-graph` went from 44 s cold to ~7 s warm on a Canada bbox. The wins were:

1. **Don't `SELECT MIN/MAX FROM rtree` to check overlap.** Scanning a 10M-row rtree for MIN/MAX is 30+ seconds on a cold open. Replaced with a direct `SELECT 1 FROM rtree WHERE minX ≤ ? AND maxX ≥ ? AND minY ≤ ? AND maxY ≥ ? LIMIT 1` which uses the spatial index. Same fix applied to POI/routes (`_rtree_overlaps`, `_poi_overlaps` in `run.py`).
2. **Split `WHERE from_id IN bbox OR to_id IN bbox` into a UNION ALL** with each half using its own index. SQLite's OR planner was doing a full walk_edge scan.
3. **JOIN walk_node into the edges query** instead of a second pass to fetch coords.
4. **Stream via `conn.execute(...)` rather than `.fetchall()`**, fold the per-row column building into the same loop. Avoids materialising a 800k-tuple intermediate list.
5. **Pre-bind `.get` / `.append`** of the hot dicts/lists as local variables in the per-row loop — meaningful for 800k+ iterations.
6. **`gzip compresslevel=1`** everywhere. The binary is already dense, higher levels spend 3× the CPU for < 10% size drop.

Timing phases logged for any request carrying `X-Download: 1`:
```
[dl] GET /walk-graph?bbox=… size=9.9MB total=7.3s setup=2ms sql_bbox=0.5s process=5.7s pack=0.4s gzip=0.4s
```

## Theme system

Entirely driven by CSS variables now. Each theme's `ui` field maps to
`--ui-*` variables set at `documentElement.style` in `applyTheme`:

```js
--ui-bg, --ui-text, --ui-muted, --ui-border, --ui-hairline, --ui-hover,
--ui-input-bg, --ui-radius, --ui-shadow,
--ui-accent, --ui-accent-text, --ui-accent-border, --ui-danger
```

All panels/modals/cards/buttons/chips/inputs/dropdowns/map controls use
these vars. Default values live in `:root` so themes that don't fill in a
field still render sensibly. New theme = just add a new entry to `THEMES`
and an `<option>` to `#themeSelect` — no CSS edits needed.

**Medieval-only decoration** (serif body, small-caps headings, monospace
"ledger" numbers, sepia SVG icon filter, italic serif "i" on the attribution
tile, dashed stop timeline) stays scoped to `html[data-theme="medieval"]`.

**Medieval is the default** for new users (`|| 'medieval'` fallback in three
places where `cc.theme` is read). Existing users keep their stored choice.

**Watch for CSS cascade gotchas.** Several original rules (`#poiCardDirections`, `.mode-chip.on`, `.route-popup .*.on`, `#pinBar button.primary`, `.temp-pin`) had hardcoded accent colours and lived *after* the new var-based rules in the file. Same specificity = later wins. Already fixed but if any regressions reappear under "some button is blue again", check for more hardcoded `#3b7fdf` / `#4a90e2`.

## Welcome overlay

New first-run modal (`#welcome`, gated by `!localStorage.getItem('cc.welcomeSeen')`). Triggers the existing `appDataBtn` download via `.click()`, mirrors its progress status into the overlay via a MutationObserver, reloads on `cc:app-data-ready` event (dispatched at end of the app-data handler). Sets `cc.welcomeSeen=1` only after a successful download.

## Settings panel additions

- **"Show offline maps panel" toggle** — hides `#panel` (the offline-maps dropdown at bottom) when off. Persisted in `localStorage.cc.hidePanel`.
- **Attribution line at the bottom** of the settings sheet (Map data © OSM / MapLibre / Natural Earth). The built-in MapLibre attribution is in compact mode (small "i" tile) and themed to match the medieval palette.

## Wipe flow

Rewritten as single-phase: click → unregister SW → clear all Cache API entries → enumerate and delete every IDB (`indexedDB.databases()` + a hardcoded fallback list for Firefox) → `localStorage.clear()` → `location.reload()`. Status line in `#status` shows live progress, console gets a `[wipe] summary:` block.

**iOS PWA caveat**: `navigator.storage.estimate().usage` is unreliable on iOS — ignore it. The real per-region totals come from the per-region measurement in the offline-maps UI. Fully resetting requires uninstalling the home-screen icon (some WebKit-level HTTP caches are unreachable from JS).

To stop iOS hard-refresh from growing storage ~1 MB per reload: SW install handler uses `cache: 'no-store'` on fetches (not `'reload'`) so Safari doesn't shadow the Cache-API copies in its HTTP cache. MapLibre is self-hosted under `/static/vendor/` with `Cache-Control: no-store` for the same reason.

## GTFS ingest hardening

`ingest-gtfs.py` now:
1. Does a zip-magic-byte check after download. Some mirrors return 200 OK with an empty body or HTML error page; `try_download()` catches those.
2. **Retries with the MD mirror URL** (4th column of `feeds-*.tsv`) if the primary URL fails or delivers a non-zip body. `get-gtfs-catalog.py` emits the mirror as the 4th field.
3. **Pre-sorts `stop_times.txt` in the zip** if it isn't grouped by trip_id. `build-schedule-db.py` streams stop_times and flushes per trip_id transition, so unsorted input previously produced duplicate-ID pattern rows — ~45 feeds failed on this alone.
4. `validate-gtfs.py` downgraded the following errors to warnings (they're handled fine downstream):
   - stop-coordinates unparseable (build-schedule-db skips those rows anyway)
   - route_type non-integer (coerced to 0 in build)
   - stop-times-sorted-by-trip (now auto-sorted at ingest time)
   - referential-integrity misses (build drops affected trips)

After these changes Canada went from 26/132 failures to 8/132, and most remaining failures are dead URLs without a mirror.

## Build / rebuild commands

```
./get-shapefiles.sh           # one-time NE + water polygons
./make-tiles.sh               # per-PBF: mbtiles + pois + walk + routes + housenumbers.sqlite
./get-transit-north-america.sh --refresh-catalog   # full CA+US GTFS ingest, ~3h fresh
./get-transit-europe.sh       # etc. for other continents
python run.py                 # Flask server on :8465
```

Rebuild tiles when `tilemaker-slim.json/lua` changes:
```
rm data/*.mbtiles
./make-tiles.sh
```

## Bench commands

```
python3 bench-walk.py                         # prints WALK bundle byte breakdown
python3 bench-walk.py --url https://poke.phylliidaassets.org
python3 bench-tiles.py                        # reads data/*.mbtiles directly, per-layer table
python3 bench-tiles.py --minzoom 1 --maxzoom 5   # inspect low-zoom tiles
```

## Tilemaker simplify — DON'T

Earlier this session we tried `simplify_below: 15, simplify_level: 0.001`
across transportation, building, landcover, landuse, park to save ~18 MB
wire. It **glitched**:
- Road polylines jaggy at tile boundaries (simplified endpoints snapped inconsistently across adjacent tiles).
- Buildings collapsed from 708k features → 8k (tilemaker's `combine_below: 14` merged simplified polygons sharing edges, producing one super-blob per block).

Current state: transportation/transportation_name/building have no
simplification beyond defaults. Landcover/landuse/park keep the pre-refactor
defaults (`simplify_below: 13, simplify_level: 0.0003, ratio: 2`). If you
try again, leave **building alone** and use simplify_level ≤ 0.0005 on
polygons-only.

## Config / constants that must stay in sync

- `POI_FIELDS` array — order must match between `run.py` and `static/index.html`. Append-only (would break decoding of already-saved POIs).
- Binary format versions — `cc.walk.v5` / `cc.pois.v2` / `cc.housenumbers.v1` IDB names. If you change the format, bump the DB name AND the version field in the header.
- `THEMES` entries must all include a `ui: {}` dict with the same keys so `applyTheme` can set every `--ui-*` variable.

## Things the user was evaluating when context ran out

- Just finished a round of medieval-theme polish (bubbles/buttons/modals all themed, then generalised via `--ui-*`, then a regression where several buttons went blue again was fixed by finding hardcoded `#3b7fdf` / `#4a90e2` values in rules later in the stylesheet than the generic CTA rule).
- The medieval-theme default is active but only for users without a stored `cc.theme` in localStorage. Existing users keep their choice unless they clear data.

## Good next steps

- Write `bench-pois.py` analogous to `bench-walk.py`/`bench-tiles.py` if
  someone wants to iterate on the POI binary format.
- Consider adding `cc.transit.v1` theme (or other continent-appropriate
  palettes) by copying an existing `ui:` block.
- The wipe button could offer a "keep fonts/icons" mode so re-downloading
  app data after every wipe isn't required.
- The validator's remaining errors (required-files missing, bad zip from
  catalog URLs) could be logged more helpfully in a dashboard.

## Known-but-accepted quirks

- `.maplibregl-ctrl-attrib-button`'s "i" only centers when the attribution
  control is instantiated with `{ compact: true }` (hardcoded in the
  `new maplibregl.Map({ attributionControl: { compact: true }, ... })`
  options). If that's ever changed, the tile will stretch into a bar.
- `storage.estimate()` is lying on iOS; use the per-region UI numbers.
- On iOS Safari home-screen PWA, hard refresh in dev adds ~1 MB to the
  WebKit HTTP cache per reload. Fix is purely "uninstall the icon" —
  WebKit-level caches are unreachable from JS.
- Walk graph `process` phase stops at ~5 s for Canada-sized queries on
  cold sqlite — that's the SQLite JOIN + Python tuple unpacking, already
  streamed. Further wins would need pre-baking (build-time tiling) which
  we deferred.

---

# Session: Pokéstops, catch flow, in-place layer recoloring

This session built out the **interactive game loop** on top of the
already-working spawn / capture / inventory infrastructure: a real
catch flow with thrown pokéballs, a pokéstop POI system with
cooldowns + loot drops, in-place coloring of the underlying map
layers (no HTML overlays) for cooldown state, and a tags / candy /
visibility-toggle suite. Nothing in this section disturbs the
binary-bundle infrastructure or theme system above; it all sits on
top of the existing `static/creatures.js` + `static/index.html`.

## Catch flow (was: instant Catch button → now: ball-throw + wobble)

`creatures.js` battle screen used to have a single `Catch` button
that auto-added the wild creature to the inventory. Now:

- **Ball list instead of catch button.** `populateBattleBalls()`
  reads the bag (`Creatures.getBag()`) and renders one button per
  throwable type. Two ball items in the catalog so far: `poke_ball`
  (per-shake stay-closed rate `0.65` → ≈28% catch) and `great_ball`
  (`0.85` → ≈61% catch). `THROWABLE_BALL_KEYS` is the canonical list.
- **Throw flow** in `throwBall(ballKey, sourceBtn)`:
  1. `consumeItem(ballKey, 1)` decrements the bag.
  2. **Arc**: compute (button-center → sprite-wrap-bottom-center)
     via `getBoundingClientRect()` deltas; animate the ball through
     a 3-keyframe path with a midpoint lifted ~`max(45, |dy| * 0.4)`
     px above the throw line. Single ease-out, no rotation
     (visible spin makes the ball look upside-down at apex —
     reads as a glitch, not motion).
  3. **Suck-in**: creature sprite scales + fades to 0 with a
     simultaneous silhouette flash (a `<img>` with the sprite's
     own `src`, white-tinted via `filter: brightness(0) invert(1)
     drop-shadow(...)` to be the creature's outline).
  4. **Outcome roll**: 3 independent shake checks, count successes.
     3 successes = caught; otherwise break out at the failed shake.
  5. **Wobble**: each shake is a full back-and-forth (0° → +22° →
     -22° → 0°), per-keyframe `cubic-bezier(0.4, 0, 0.6, 1)` so the
     ball "falls into" each tilt under fake gravity. Lead direction
     **alternates** per shake. Long pause (320ms) BETWEEN shakes is
     the suspense — same trick the original games use.
  6. **Caught**: warm gold radial burst behind the ball, plus the
     `ball-seam-glow` overlay (a tiny SVG that's just the seam line
     + center button in white, with a layered drop-shadow halo)
     pulses scale 0.85 → 1.6 / opacity 0 → 1 → 0. Ball does a small
     "ding" squish (1 → 1.15 → 0.96 → 1, spring easing). Then
     `recordCaptureFromSpawn` → `closeBattleScreen` →
     `show()` + `showDetail(entry.id)` so the user lands directly
     on the new capture's detail page.
  7. **Break out**: cool-white burst from the ball, then the ball
     **physically opens** — top half rotates `rotateX(-95°)` around
     the seam (parent has `perspective: 300px` + `transform-style:
     preserve-3d` so 3D works), translateY -22px; bottom half drops
     8px and fades. Outer container drifts up 12px. Then the
     silhouette flash + creature scale-back-in fire continuously
     so the energy-release reads as one motion.

The two ball halves are clipped views of the **same SVG** via
`clip-path: inset(0 0 50% 0)` (top) and `inset(50% 0 0 0)` (bottom)
— they overlap into one ball when closed and only the top has a
break-out animation. Cleaner than maintaining two separate SVGs.

**Web Animations API gotcha that bit us hard:** animations with
`fill: 'forwards'` persist their final keyframe via the *animation
effects stack*, not as inline `style.transform`. Setting
`el.style.transform = ''` does NOT clear them. Symptoms: catch one
creature, exit, encounter another → second creature renders at
scale(0) opacity(0) (invisible) because the prior throw's
suck-in animation is still applying its endpoint. Fix: a
`cancelAnimsOn(el)` helper that walks `el.getAnimations()` and
calls `.cancel()` on each. Called at the top of every
`openBattleScreen` AND at the start of every `throwBall` AND at
the end of break-out completion.

## Pokéstop POI system

Tap any POI in creature mode → the existing card opens with the
bottom action swapped from "🧭 Directions" to "🎁 Collect items".
A 10-min cooldown per POI, granting 1–3 random items per press.

Storage: `cc.poiCooldowns.v1` is a `{ "<lng>,<lat>": entry }` map
where each entry is `{ t: <ms>, c: <category>, x: <lng>, y: <lat> }`.
The full-precision lng/lat is in the value (not parsed from the
key) because parsing the rounded key gives a few-pixel offset at
high zoom. Legacy entries that are bare numbers are normalized via
`poiCooldownEntry()`.

When a POI is collected:
- `markPoiCollected(lng, lat, category)` records the entry +
  prunes any expired entries opportunistically.
- `findRenderedPoisWithin(centerLng, centerLat, 80m)` queries the
  rendered POI features (and building dots if that layer is on),
  haversine-filters to the exact circle, and we mark every nearby
  feature as collected too. **Radius cooldown** prevents farming
  tight clusters like "ATM + restaurant + parking on one corner".
- The ball-list animation overlays the bottom button slot
  (`granted.map((k) => <img>)` with a staggered scale-pop
  keyframe) so the user sees what they got, then `setSelected(null)`
  closes the card after 500ms. The 500ms delay also masks the
  paint-property update lag while MapLibre re-evaluates the
  in-place coloring.

Collect button has two gates:
- **Cooldown**: button shows `Available in MM:SS` with a live
  countdown (single self-managed `setInterval` that auto-cancels
  when the countdown ends or the card closes).
- **Distance**: button is disabled and shows
  `Too far · NN m` whenever the user is more than 100m away
  (matching `VISIBILITY_RADIUS_M` in creatures.js so pokéstop
  range = creature-spawn range). The same poll that drives the
  countdown re-evaluates distance, so walking toward the POI
  re-enables the button live.

For transit POIs (bus stops etc.) in creature mode, the collect
button is **physically hoisted into the body above the schedule
list** — bus schedules can push the bottom button off-screen.

## In-place layer recoloring without feature IDs

The hardest piece. We wanted collected POIs / buildings to repaint
**themselves** in gray (active cooldown) or pink (ready) rather than
having an HTML / GeoJSON-source overlay layer drawn on top of them.

`setFeatureState` is the textbook answer but needs feature IDs in
the tiles, and `tilemaker-slim.json` has `"include_ids": false`. We
declined to re-tile (would invalidate every tile and friends would
need to re-download). So we found two MapLibre style expressions
that work without IDs:

### POI layer: `['within', polygon]`

Build a `MultiPolygon` of tiny ~0.5m squares around each cooldown
POI's lat/lng. Set `poi-icons` paint expression:
```js
'icon-color': ['case',
  ['within', activeMultiPolygon], _currentCooldownActiveColor,
  ['within', readyMultiPolygon],  _currentCooldownReadyColor,
  _currentPoiThemeColor]
```
`within` checks if a feature's geometry sits inside a literal polygon.
Only works for **Point / MultiPoint / LineString** — perfect for POIs
which are points. Single-pass render (no second layer) means there's
no two-layer-timing race during fast camera moves, which is what
killed the earlier overlay-based approach.

`refreshCooldownOverlays` in `index.html` rebuilds this expression on
every change and calls `setPaintProperty('poi-icons', 'icon-color',
expr)` + `map.triggerRepaint()` (the manual repaint trigger is
necessary because MapLibre batches paint updates for the next loop
tick — without it, there's a noticeable lag before the
just-collected POI turns gray).

### Building layer: `['distance', point]`

Same idea but for buildings, which are polygons (can't use `within`).
We use `['distance', { type: 'MultiPoint', coordinates: [...] }]`
which returns shortest distance from the feature to ANY point in
the input. For a cooldown centroid that's INSIDE the building's
polygon, distance is 0:
```js
'icon-color': ['case',
  ['<', ['distance', activeCentroidsMultiPoint], 1], gray,
  ['<', ['distance', readyCentroidsMultiPoint],  1], pink,
  default]
```
1m threshold is enough to absorb centroid jitter without catching
neighboring buildings (typical building separation is ≥10m).

Centroid is computed at click time via `buildingFeatureCentroid()`
(average of polygon outer-ring vertices). Stored as `(lng, lat)` in
the cooldown entry — same shape as POI entries — so the same
storage path / refresh function handles both.

### Building pokéstops are opt-in

Hidden behind a Settings toggle (`cc.buildingPois`, default OFF)
because the per-building distance evaluation is non-trivial in
dense urban areas. When the toggle is on, `addBuildingPokestopsLayer`
adds a small `building-pokestop` symbol layer at z16+ (subtle dot at
each building centroid via the SDF tint of `static/poke-ball.svg`'s
… actually a custom 12x12 dot SVG registered at runtime via
`registerIconFromSvg`). Click handler falls back to building features
when no POI / transit feature was hit.

## Other additions (chronological)

- **Family-rooted candy** (`cc.candyMigrated.familyV2`): catches
  award candy keyed by the species' evolution-family ROOT, with
  babies (Pichu/Cleffa/Igglybuff/Togepi/Tyrogue/Smoochum/Elekid/
  Magby) skipped so the bucket is "Pikachu candy" not "Pichu candy".
  Lazy migration in `readCandy()` clears the old map and replays
  every captured creature through the new award rule.
- **Tags system**: 1-8 char string labels stored at `cc.tags.v1`,
  per-creature membership on the capture record's `tags` field
  (additive — pre-existing captures default to `[]`). Built-in
  predicate-driven tags (currently just "Pure" — `speciesA === speciesB`)
  defined in code via `BUILTIN_TAGS`; never stored on creatures.
  Inventory + Pokédex have AND-semantics chip filters; the detail
  view's tag picker only shows built-in chips whose predicate fires
  for THAT creature.
- **Bag / candy / pokédex** filter chips, view stack with proper
  back-button navigation across detail/fusion/pokedex/candy/bag/tags.
- **Visibility settings section** (collapsed under a "i" info
  button that explains "more layers = more lag"): toggles for
  Building pokéstops (default off), Render buildings (off),
  Render transit lines (on, also hides the transit-layers control
  button when off), Render house numbers (off). Each layer's
  initial visibility is read from localStorage **at style-creation
  time**, so the JS `applyXVisibility` doesn't need to wait for
  the map load — no first-frame flash of layers that should be
  hidden.
- **POI cooldown UX**: the selected POI's highlight marker also
  recolors gray/pink. Card hides bus-stop schedule when collect is
  hoisted. POI card itself fades 150ms in/out (opacity +
  pointer-events, since `display` can't be transitioned). Battle
  screen too.
- **Save reminder banner**: "It's been 8 days since your last
  save — tap to back up in Settings" appears at the top of the
  inventory after 7 days. Settings backup row also gets a status
  line clarifying that Save uses data (the only thing in the app
  that does, per the no-network rule).

## Things learned

- **`setFeatureState` requires feature IDs** in the source. Without
  re-tiling, the alternatives are `within` (points only) or
  `distance` (any geometry, costs per-feature evaluation per frame).
  Both let you do per-feature paint expressions without IDs.
- **`distance` is significantly more powerful than I expected** —
  it works on polygon features, takes any GeoJSON literal, and the
  evaluation cost scales O(visible_features) rather than the
  O(visible × cooldowns) you might fear (because a single MultiPoint
  argument lets MapLibre find the nearest point in one pass).
- **Single-pass repaint > two-layer overlay** for visual stability
  during fast camera moves. We tried the overlay approach (separate
  GeoJSON-sourced symbol layer drawing the same icon on top with a
  different color) and it had a 1-2 frame mismatch where the
  underlying icon's color "bled" through during fast zoom — the two
  layers tile-process at slightly different rates internally. The
  `within` / `distance` paint-expression approach is one render pass
  per feature so no race exists by construction.
- **`include_ids: true` in tilemaker is one line; the friction is
  re-tiling** + everyone re-downloading. For a small social PWA
  with real users (husband + friends), the cost-benefit didn't
  favor re-tiling for what was achievable with paint expressions.
- **Web Animations API + `fill: 'forwards'`** is a footgun. The
  final state persists via the animation effects stack, not via
  inline styles. `el.getAnimations().forEach(a => a.cancel())` is
  the cleanup. Apply on every state-reset point.
- **`map.triggerRepaint()`** is the manual lever for "this paint
  property change should land on THE NEXT FRAME, not whenever the
  render loop comes back around". Use it after every
  `setPaintProperty` that needs to be visible immediately
  (e.g., collect → POI turns gray).
- **`map.queryRenderedFeatures` works against any rendered layer**,
  including ones we just added in JS. Used for both the radius
  cooldown sweep AND for the building pokestop click fallback.
- **`anchor: 'center'` on `maplibregl.Marker`** plus a precise
  lat/lng (NOT the rounded `key` parsed back to floats) is what it
  takes to align an HTML overlay to a tile-rendered icon. Re-parsing
  a `toFixed(5)` key loses ~1m precision = several pixels at z=18+.
- **Tile-rendered icons scale via `icon-size` interpolated on
  zoom**. To pixel-perfectly match a tile icon's screen size from
  an HTML overlay (back when we were doing that), you need
  MapLibre's exact exponential interpolator (base 1.5) over the
  same control points, multiplied by the sprite's source pixel
  size (set by `svgToImageData(..., 24, 2)` in this build → 24px).
  This is moot now that we recolor in-place, but it's a lesson:
  layer paint expressions are easier than reverse-engineering
  rendering math.

## Things deliberately NOT built (next-session leads)

- **Evolve mechanic**: still on the deferred list since
  `SESSION_SUMMARY_3.md`. Candy is now in place + wired into
  detail view; missing pieces are (1) the evolve action button on
  the detail page, (2) candy-cost rules per evolution, (3) the
  evolve animation.
- **Level-up mechanic**: walking distance? POI visits? combat?
  unsettled.
- **Server-side save list / restore UI**: `/save` endpoint exists,
  no UI to list / restore historical saves yet.
- **Wider A pool (1-509)**: architecture still in place
  (`SPAWNABLE_SPECIES_A_FULL`), still gated behind one constant
  swap + bumping `bulkDownload` `indexTo` to 509.
- **Cross-device cooldown sync**: pokéstop cooldowns are local-
  only (every device tracks its own). For a shared-world feel
  ("my friend just emptied this stop") we'd need a server endpoint.
  Not a priority.
- **Building pokéstop cooldown overlay layer**: removed in favor
  of the in-place `distance` recoloring. If we ever do want a
  separate "all collected buildings I've been to" view (different
  UI than the building-dot tint), we can add it back, but the
  in-place approach was cleaner.

## Files touched in this session

```
static/creatures.js               (catch flow, ball animation,
                                   tags, candy migration, bag,
                                   battle screen restructuring)
static/index.html                 (pokéstop POI flow, cooldown
                                   storage + recoloring expressions,
                                   building pokestop layer, visibility
                                   settings, save reminder, fade
                                   transitions, lots of CSS)
static/poke-ball.svg              (new — Poké Ball icon)
static/great-ball.svg             (new — Great Ball icon)
static/ball-seam-glow.svg         (new — seam + button outline for
                                   the catch-success glow)
HANDOFF.md                        (this section)
```

No `tilemaker*` / `run.py` / shell-script changes this session.

# Session: hand-drawn variants, app-data → IDB, pokédex carousel, art credits

This session was long and mostly polish. Three big-rocks beneath it:

1. **Hand-drawn variants → spawn → capture → pokédex.** The user
   discovered that `data/Battlers/spritesheets_custom/` has both a
   base sheet per species and lettered variant sheets (`1a.png`,
   `1b.png`, …). Real artists, real attributions. We threaded a
   per-fusion variant through every layer — spawn id, capture
   record, in-app pokédex display.
2. **App data (icons + fonts) onto the proper persistence layer.**
   Refresh button was wiping things it shouldn't, exposing that
   icons + fonts lived in the SW Cache, which iOS aggressively
   evicts. Moved both into IndexedDB and pre-rasterized icons so
   the per-load decode cost vanished.
3. **A real carousel for the inventory + pokédex sub-views.**
   Finger-tracking drag, swipe + arrow keys + buttons all routed
   through one commit pipeline, neighbors pre-rendered and
   cached so flipping back is instant.

## Hand-drawn variants

- Custom sheets are NOT the same shape as autogen. Autogen is
  `960×4896` (10 cols × 51 rows × 96 px). Custom is `1920×2784`
  (20 cols × 29 rows × 96 px). The cropping math has to derive
  `cols = bitmap.width / 96` per-sheet, NOT use a global constant.
  This took a session to find — every cell was being read from
  the wrong region for the first day, which is why all sprites
  appeared as dots until we re-downloaded.
- Variant determinism: a `variantSeed` is drawn as the LAST PRNG
  draw in `generateCellAtTick` (alongside `bornOffset`). Doesn't
  shift any earlier draws, so existing spawns at any
  `(cell, tick)` keep their species/lat/lng. The variant index is
  resolved at render time as `floor(variantSeed * count)` where
  `count` is the per-cell custom variant count.
- Variant count is per-cell, not per-species. For fusion (a, b),
  alpha-scan each variant sheet's cell `a`; the COUNT is the
  number of non-blank ones, ordered by manifest. Slot indices are
  positions in this filtered list (0..count-1).
- Capture record carries `variant: number | null` — burned in at
  capture time, so even if more variants get added later, the
  user's roster keeps showing exactly what they caught.
- Per-cell variant data was originally walked via IDB cursor on
  every page load. **17 600 entries × structured-clone on iOS = 67
  seconds**. Two iterations of the fix:
  - `getAll` instead of cursor walk → still slow on iOS
    (~67s — structured clone, not cursor overhead)
  - **`__summary__` blob: a single 22 500-byte `Uint8Array`,
    one byte per (a-1, b-1) cell, written once during bulkDownload
    pass 2.** One IDB get on init, ~5 ms, in-memory `Map` lookup
    forever after. This is the right shape.

## App data → IndexedDB

- Pre-existing architecture: `/icons/*.svg` + `/fonts/*.pbf`
  cached in SW Cache (`app-v1`). Refresh button wiped that whole
  cache, but the SW also returns `204 No Content` for those paths
  *without* an `X-Download` header — meaning post-wipe, MapLibre
  can't fetch them either. Visible result: pin icons everywhere
  + missing labels.
- New module: `static/appdata.js`. IDB store `creature-appdata-v1`
  with `icons` + `fonts` stores. `iconBulkDownload` /
  `fontBulkDownload` write directly to IDB.
- **Pre-rasterize icons during download**, store raw RGBA pixel
  buffers (not SVG text). Format: `[0xC1 magic][u16 width][u16
  height][u8 pixelRatio][RGBA bytes]`. On `loadAllIcons`, just
  deserialize bytes + `map.addImage(name, ImageData, opts)`. No
  more `svgToImageData` decode at startup (was 5-15ms × 200 icons
  = 1-3 seconds of main-thread blocking).
- Schema bump (v1 → v2): the `icons` store gets dropped + recreated
  to wipe the old SVG-blob format on first load with the new code.
  User re-downloads once via the missing-data banner.
- **Fonts** are trickier — MapLibre internally fetches glyph URLs
  and we can't easily intercept. Solution: `transformRequest` hook
  in the map options that synchronously remaps `/fonts/{stack}/{range}.pbf`
  URLs to in-memory blob URLs. The blob URL map is populated on
  startup via `AppData.preloadFontBlobUrls()` BEFORE map
  construction. ~50 fonts × IDB get → batched into one transaction
  (was sequential, painful).

## Refresh button (final form)

After several iterations:
- **Static HTML at the top of `<body>`** with inline
  `onclick="..."`. Lives in the bottom-right alongside MapLibre
  controls (themed via `.maplibregl-ctrl-group`).
- The onclick wipes ONLY the small `APP_SHELL` list from `app-v1`
  (`/`, manifest, `/static/icon.svg`, vendor maplibre, trip-planner)
  — NOT `/fonts/*` or `/icons/*`. Those are user-downloaded data;
  wiping them was the bug.
- `setTimeout(() => location.reload(), 150)` after the cache
  delete — fires regardless so an iOS Safari cache-API hang can't
  stall the reload.
- 44×44 tap target, `touch-action: manipulation`, `-webkit-tap-
  highlight-color` — the iOS HIG triple-pack for "always
  registers".

## Welcome flow (3 steps)

1. **App data** — fonts + icons + low-zoom base map. Reloads after.
2. **Creature data** — sprite sheets + species names + types.
   Resumes here automatically after step 1 reload.
3. **Map data** — instructions to pan/zoom and tap "save current
   view" for tiles + POIs + walking + transit.

## Per-variant `seenFusions` + auto-migration

- `markFusionSeen` now takes an optional `variant` arg; storage
  layout is `seen[key].variants = { 'auto': ts, '0': ts, '2': ts }`
  (`'auto'` for autogen, stringified slot index for custom).
- `readSeenVariants(a, b)` returns a Set of seen variant keys,
  with on-the-fly backfill from `capturedCreatures[i].variant`.
- One-time migration `migrateLegacyCaptureVariants` (gated by
  `cc.variantBackfillDone.v1`) — for every legacy capture without
  a `variant` field, picks slot 0 (the artist's primary, if any
  custom variants exist for the cell) or `null` (autogen) and
  writes both the capture record AND the seenFusions entry.

## Inventory + pokédex carousel

This was the most time-intensive piece — a real-feeling sub-view
swipe with finger-tracking + neighbor caching. Key pieces:

- **Track + slot architecture.** Replaced single `.detail-body`
  / `.fusion-body` with a track wrapper (`.detail-track`,
  `.fusion-track`) holding 1-3 absolutely-positioned `.body-slot`
  children at `translateX(-100%)`, `translateX(0)`, `translateX(100%)`.
  The track itself gets the runtime `translate3d` during drag —
  all slots move together.
- **Slot cache.** `_slotCache: Map<view:key, slotElement>`. Slots
  for the current viewer's idx-2..idx+2 stay in cache; further
  ones get evicted (object URLs revoked). Going back to a
  recently-viewed sibling reuses the rendered DOM — no re-render,
  no flash.
- **`_populateTrack`** (re-entrant): clears the track, pulls
  prev/center/next from cache (or renders fresh), assigns the
  right `.prev / .center / .next` class, appends in DOM order.
- **Finger-tracking drag.** `attachDrag(viewName)`:
  - `touchstart` records start; if `_pendingOnEnd` is set
    (previous commit still animating), calls it synchronously
    so the new drag starts on stable post-commit state.
  - `touchmove` claims the gesture once horizontal travel >
    8 px (and dx > 1.2 × dy); applies `translate3d(dx, 0, 0)`
    live, with rubber-banding (×0.3) at list ends.
  - `touchend` decides commit vs revert from BOTH distance
    (≥28% of view width) AND velocity (≥0.5 px/ms). Animates
    the track to `±viewWidth` (commit) or `0` (revert). On
    transition end, `_commitNavigate(direction)` updates state
    + re-populates the track.
- **Layout iOS quirks**:
  - `touch-action: pan-y` on the view so iOS doesn't claim
    horizontal pan in the first 8 px before our handler does.
  - `overflow-x: hidden; overscroll-behavior-x: none` on
    `.sheet` — iOS rubber-bands an `overflow-y: auto` container
    in BOTH axes by default; explicit horizontal lock prevents
    the entire sheet from sliding sideways during a swipe.
  - `will-change: transform` + `translate3d(...)` on the TRACK
    (not slots) — promotes to a single composited layer so
    neighbors stay painted across the snap-back. `translate3d`
    on individual slots caused stale-paint "wrong icon" glitches.
- **Parent-grid scroll auto-update.** When the user navigates
  through 4-6 siblings, the parent's saved `scrollY` tracks the
  current row (computed via the layout constants — pokedex is
  cardHeight 150 + rowGap 8 = 158px row pitch in 3 cols, browse
  is 178+8 = 186 in 3 cols). Tap "back" → grid scrolled to the
  current creature's row.

## Sprite credits (`/sprite-credits-bundle`)

- Source: upstream PIF's `Sprite_Credits.csv` (~6 MB raw, 227 k
  lines, format `<a>.<b>[variant],<artist>,<role>,<notes>`).
- Filtered to fusions in 1-150 range: ~24 k entries → **149 KB
  gzipped** as JSON. Trivial to ship with the sprite download.
- Server endpoint serves the suffix-keyed bundle:
  `{"a-b": {"": "artist", "a": "artist", ...}}`.
- Client downloads it as the last step of `Sprites.bulkDownload`
  pass 2 + stores at IDB key `__credits__` in the variants store
  (with cursor walks filtering that key out).
- `Sprites.getSpriteCreditForSlot(a, b, slot)`: bundle → variants
  store entry → manifest → suffix → artist. Resolution chain.
- Existing-user path: the spritesBtn click handler also fetches
  the bundle independently if `creditsReady === false` so users
  with already-downloaded sprites don't have to re-download
  everything.
- **Open**: artist labels still show fallback `#1`/`#2` instead
  of names in the fusion variant grid even though the bundle is
  in IDB. Likely a problem in `getSpriteCreditForSlot`'s lookup
  chain (variants store get? manifest? suffix mismatch?). Not
  yet diagnosed.

## `/dex` — standalone art browser

Side-quest: a separate page at `/dex` for browsing every art
variant of every fusion. NOT subject to the no-network rule —
makes a server request on every input change.

- Searchable name dropdowns with custom autocomplete (native
  `<datalist>` is inconsistent on iOS).
- URL hash sync: `#t=Trainer&a=Bulbasaur&b=Pikachu`. Hash
  trainer auto-logs in on page load (deep links work).
- Trainer gate: `/save-names` enumerates trainer-name files in
  `saves/`; user picks one to load their seenFusions for
  silhouette gating.
- Shareable per-cell PNGs: `/sprite-cell-auto/<a>/<b>` and
  `/sprite-cell-custom/<a>/<b>[/variant]` use Pillow to crop
  one 96×96 cell on demand (immutable cache headers).
- Each cell wrapped in `<a target="_blank" href="...">` so
  right-click → Copy Link gives a direct shareable image URL.

## Diagnostics added to Settings

The Settings panel's bottom row now shows live counters:
- `sprite reads` — in-flight Sprites IDB gets.
- `map imgs` — `map.listImages().length`.
- `IDB icons` — `AppData.iconNames().length`.
- A pre-formatted block with startup phase timings + decode/
  addImage stats + the loadAllIcons trace + sprite errors.

This badge was load-bearing during debugging — diagnosing the
67-second IDB wait, the `global.AppData` typo, etc., all came
from reading these numbers.

## Things learned

- **iOS Safari serializes IDB transactions** AND structured-
  clone of large object sets is slow. Always favor a single
  compact representation (the 22.5 KB summary blob) over walking
  many small entries.
- **Per-call promise dedup** is the antidote to N concurrent
  callers fanning out into N IDB transactions / N icon
  registrations. Same trick worked for `loadIcon`,
  `loadVariantCounts`, `getCellVariantCount`, batch sprite gets.
- **Silent `try { ... } catch {}`** is a debugging trap. The
  `global.AppData` typo cost five rounds of investigation. Lesson
  for future me: at minimum log to a diagnostic field.
- **iOS Safari rubber-bands `overflow-y: auto` containers in
  BOTH axes.** `overscroll-behavior-x: none` + explicit
  `overflow-x: hidden` is the lock.
- **`translate3d` on the track (not the slots)** keeps neighbors
  painted across animations. Slot-level `translate3d` causes
  stale-paint glitches.
- **Race-on-fast-swipes** was real: when a new touch begins
  while a previous commit's animation is still mid-flight, the
  new touchmove cancels the transition early, fires
  `transitionend`, runs the previous `_commitNavigate` mid-drag,
  and the slot under the finger gets replaced with the *next*
  pokemon. Fix: stash the pending `onEnd` on the track element;
  call it synchronously at the start of every new touchstart.
- **Pre-rasterized icon storage** wins big when the sprite atlas
  decode is on the hot path. SVG-on-load was 5-15 ms per icon
  × 200 icons.
- **Spawn determinism + variant** : the user's intuition that
  "more variants ≠ more spawns" is satisfied by drawing the
  variant seed AFTER all other PRNG draws (so existing species/
  lat/lng don't shift) and resolving the index at render time.
  Variant count splits an existing probability into N equal
  buckets — total density unchanged.

## Things deliberately NOT built (next-session leads)

- **Sprite-credits lookup bug** — see "Open" note above. The
  bundle is in IDB, the bundle is correct (verified via curl);
  the client lookup chain returns null somewhere.
- **Same evolve / level-up / cross-device sync** still deferred
  from before.
- **Per-trainer save list UI in the main app** — `/load`
  endpoint exists, button next to Save fetches most-recent;
  no list UI to pick a specific historical save.
- **Apple Push Notification or any kind of "your friend just
  caught X" social signal**. Out of scope for the offline-first
  PWA design.

## Files touched in this session

```
static/sprites.js               (variants, summary blob,
                                 inflight dedup, batch readers,
                                 credits bundle download/lookup)
static/appdata.js               (NEW — IDB-backed icons + fonts)
static/spawns.js                (variantSeed)
static/creatures.js             (per-variant seenFusions,
                                 capture variant field, carousel
                                 architecture, finger-tracking
                                 drag, slot cache, scroll
                                 preservation, migration,
                                 fusion variant grid)
static/index.html               (welcome step 2/3, refresh
                                 button, transformRequest hook,
                                 missing-data banner, settings
                                 diagnostics badge, font preload
                                 timing, Save reminder, Load btn)
static/dex.html                 (NEW — standalone art browser)
static/sw.js                    (untouched — left dead /icons
                                 + /fonts handlers in place)
run.py                          (custom sheet routes, manifest,
                                 sprite-cell crop endpoints,
                                 sprite-credits bundle, save-
                                 names, /load, /dex)
HANDOFF.md                      (this section)
POEMS.md                        (a poem)
```

---

# Session handoff (2026-05-01 / 2026-05-02)

Two-day session covering UI polish, native-app wrapper bootstrapping,
and a major data-bundling effort. Three poems added to `POEMS.md`:
**The Names We Carry**, **The Quietening**, **Five Pixels Off the
Floor**. Read those for the human-shaped narrative; this section is
the working notes.

## What landed

### Day 1 polish (in chronological-ish order)

- **Silhouette transparency fix** — `.variant-cell.silhouette img`
  needed `background: transparent` because `filter: brightness(0)`
  blackens the entire rendered img *including* its CSS bg, turning
  silhouettes into solid black squares.
- **Hide autogen card** when custom variants exist for a fusion
  (with revoke of the unused blob URL fetched in parallel).
- **Pokédex tile / fusion header / family tree** all use
  `pickPreferredSeenVariant(a, b)` — picks the lowest-indexed seen
  variant slot, falls back to autogen.
- **SPLIT_NAMES canonical fusion-name algorithm** — parses
  `data/InfiniteFusion/Data/Scripts/052_InfiniteFusion/Fusion/SplitNames.rb`,
  served via `/sprite-split-names`, baked into `Sprites.getFusedName`.
  Algorithm: `prefix(head) + suffix(body)`, drop seam letter on
  match, capitalize after space (`Mr. Chu`). Pre-warmed on boot so
  the sync `getFusedName` works on first paint.
- **Family tree picker** routed through `pickPreferredSeenVariant`
  too (silhouettes for unseen).
- **Weekly type theme** = Fisher-Yates shuffled permutation of
  `TYPES`, seeded by cycle index. Every 18 weeks visits every type
  exactly once; new permutation on next cycle.
- **`⇄ swap` button** between First/Second species inputs in
  pokédex search.
- **Custom species autocomplete popup** ported from `/dex` (datalist
  is unreliable on iOS). Per-slot scoping: pokédex inputs suggest
  only seen species in that slot; inventory inputs suggest only
  captured. Theme-aware `<mark>` via `color-mix`.
- **Scroll position bug** — virtualizer was reading
  `_topPokedex.scrollY` (only updated on `pushView`) for in-view
  re-renders, snapping back to the saved nav scroll. Fix: read live
  `sheet.scrollTop` for re-renders, apply saved `scrollY` to sheet
  in `applyTopView` before first render. Same fix applied to inventory.
- **Captured-row artist credit** rendered async after row paint
  (variant span gets text swapped from "#N" to artist name).
- **Refresh button** preserves maplibre vendor (then later reverted
  to wipe everything; the user changed their mind).
- **Pokeball throw arc** easing tweak: `cubic-bezier(0.4, 0.22, 0.5, 1)`
  for snappier launch (y1 0.1→0.22).
- **Back button left-aligned** via `text-align: left` (flex column
  was stretching the button + browser default `text-align: center`
  put the ← in the middle).
- **Floating ↑ scroll-to-top** sticky button next to the X. Visible
  only when `sheet.scrollTop > 200` AND on browse/pokedex views.
- **Unified all close-X buttons** under shared `.cc-x-btn` class —
  inventory, settings, directions, routing, POI card. Single rule
  in `index.html` with multi-panel selector list. `!important` on
  visual resets to defeat per-theme overrides. **8-direction
  text-shadow stroke in `var(--ui-bg)`** so the glyph stays readable
  against scrolling content. Same trick on the back buttons + ↑.
- **Minimal X look** (no border, no bubble) replaced the previous
  bordered-bubble after the user changed their mind on aesthetics.
- **Action icons** (Tags / Bag / Candy / Pokédex Dex) → minimal
  stroke-only SVGs with `stroke="currentColor"`. Candy made
  vertically symmetric (twist wrappers mirror across the midline).
- **Settings toggle** for icons-vs-text labels on the action row
  (default text). `localStorage['cc.actionButtonsAsIcons']`,
  re-render via `cc-action-buttons-style-changed` event.
- **Pokémon header** centered with `min-height: 30` to match the
  Pokédex back-button row's natural height.
- **Done buttons removed** from browse-view and pokedex-view
  footers (the floating X handles closing).
- **Floating sticky back buttons** with the same glow text-shadow
  as the X. Sub-views converted to `display: flex; flex-direction:
  column` so flex-self positioning works the same way as in `.sheet`.
- **Filter snapshots in view stack** — `pushView` captures filter
  state into the top entry before push; pop restores. `applyType-
SelectColor` runs after each select assignment to keep chip-color
  in sync.
- **Species-link click clears type/tag filters** for the new
  pokédex entry while preserving the sort. Previous filters survive
  on the underlying stack entry.
- **Inline rename** — tap `.detail-name` to enter edit mode (replaces
  innerHTML with a `<form>` containing reset/save SVG icons).
  Save/reset/Esc call `_exitRenameMode` which rebuilds ONLY the
  name-row (avoids re-fetching the sprite blob from IDB on every
  save).
- **Place lookup** for encounter info — `findNearestPlace(lat, lng)`
  in index.html. Two-pass: POI `addr:city` / `addr:country` tags
  within ~10km, then vector-tile `place` source layer fallback.
  Stored on `seen[key].place` and `caughtAt.place`. Pure local —
  no network.
- **Three-line caught block** — date+time / POI / city, country.
- **Family tree moved** from captured-detail view to pokédex entry
  (where the per-fusion mosaic actually belongs).
- **Pokémon name truncation** in pokédex tiles — split bases line
  into 3 spans (`bn-a`/`bn-x`/`bn-b`); first species + × pinned
  (`flex-shrink: 0`), second species ellipsizes
  (`text-overflow: ellipsis`).
- **Detail card spacing iteration** — converged at card height 145px,
  margin-bottom 6px on `.detail-stats`, padding `10px 6px 6px` on
  `.creature-card`. The pixel-tweak rhythm of "1 more px / nvm 6
  was good" was the iterative shape.

### Day 2 — bundling + native wrapper

- **Script versioning** — server stamps `SCRIPT_VERSION = 'auto'`
  with file mtime on serve via `_stamp_js`/`_stamp_html`. HTML pages
  get a `<script>window._serverScriptVersions={…}</script>` injected
  after `<head>` so client compares loaded vs server with zero
  runtime fetches. SW version comes via one postMessage on load.
  Settings `[script versions]` block flags `⚠ STALE`.
- **Capacitor wrapper bootstrap**:
  - `package.json` + `capacitor.config.json` (server.url mode →
    `https://poke.phylliidaassets.org`)
  - `shell.nix` extended with Node, JDK 17, Android SDK API 34,
    `adb`, `gradle`, `libimobiledevice`, `gh`, `ruby`, `pillow`,
    plus `iloader` from a flake (`builtins.getFlake "github:nab138/iloader"`)
  - `.envrc` exports `NIX_CONFIG="extra-experimental-features =
    nix-command flakes"` so flakes are scoped to this project
  - `.github/workflows/ios-build.yml` builds an unsigned IPA on a
    free macOS runner. Patches `Info.plist` with `WKAppBoundDomains`
    after `cap add ios` so Service Workers register inside the
    WKWebView. `capacitor.config.json` also carries
    `ios.limitsNavigationsToAppBoundDomains: true` (both pieces are
    required — the Info.plist key alone doesn't enable SW).
  - `install-ipa.sh` — gh-CLI based downloader + optional
    AltServer-Linux sideload wrapper (steam-run for the NixOS
    dynamic-linking gotcha)
  - README updated with a "Native app wrapper (Capacitor)" section
- **`build-bundled-data.py`** — generates `data/BundledData/`
  (~135 MB, 2350 files). Reads everything from
  `data/InfiniteFusion/`, no longer needs `data/Battlers/`:
  - `extract-pif-dat.rb` (Ruby) decodes Marshal binaries (`species.dat`)
    into JSON via stub `GameData::*` classes
  - Cropped autogen sheets (1..150 partners, 0-indexed:
    `(MAX_SPECIES // cols) + 1` rows because cell 0 is empty)
  - Cropped custom variant sheets, same indexing
  - Eggs sprite sheet (1600×2560, species N at cell N)
  - `species-{names,types,evolutions}.json`, `split-names.json`,
    `credits.json`, `manifest.json`
  - `icons/` + `fonts/` copied with `icons-list.json` +
    `fonts-list.json` listing files (since static hosts can't
    enumerate dirs)
  - `tiles/<z>/<x>/<y>.pbf` extracted from `data/*.mbtiles` for
    z0..z5 (the same range the runtime "Download App Data" prefetches)
- **`.gitignore` tweak** — `data/*` + `!data/BundledData/` so the
  bundle is committed to git for static hosting (GitHub Pages,
  jsdelivr, raw.github). User has pushed the bundle.
- **Server `/bundled-data/<path>` route** — serves
  `data/BundledData/` as static files. Tile .pbf gets
  `Content-Encoding: gzip` (mbtiles stores them pre-gzipped).
- **Client switched to `/bundled-data/*` URLs** — `sprites.js`,
  `species.js`, `appdata.js`. URL base is configurable via inline
  `<script>` in `index.html` setting `window.CC_BUNDLED_DATA_BASE`
  (default `/bundled-data`). To switch to GitHub/jsdelivr hosting,
  change that one line. Both jsdelivr.net and
  raw.githubusercontent.com send CORS headers for public repos so
  the cross-origin fetch should "just work".
- **`appDataBtn` extended** to also call `Sprites.bulkDownload`
  after fonts/icons/base-map. (The old separate Settings
  "↓ download" sprite button is still there but redundant for new
  users.)

## What remains

### Right where we stopped
The two-button → one-button merge is **half done**. `appDataBtn`
now does everything, but:
1. **Welcome flow** still has the 3-step structure with a separate
   `welcomeCreatures` button (Step 2). Should collapse to 2 steps:
   step 1 (combined download) → step 2 (was step 3, save view).
   Also: the `location.reload()` after step 1 might be removable
   since `map.setStyle(map.getStyle())` already refreshes fonts.
2. **Settings `spritesDownloadBtn`** is now redundant. Either hide
   it or rename to "↓ re-download creature data" (keep
   `spritesClearBtn` for testing).

### Capacitor next moves
3. **Switch IPA to bundled-assets mode** — currently the Capacitor
   config uses `server.url` (loads from production URL in a
   WebView). To make the native app work fully offline, switch to
   bundled mode:
   - `capacitor.config.json`: drop `server.url`, set `webDir` to a
     directory that contains `static/* + data/BundledData/*`
   - GH Actions: pre-build step copies/symlinks the bundle into
     that directory before `cap sync ios`
   - Client `BUNDLED_BASE` should resolve to a relative path in
     bundled mode (the inline `<script>` could feature-detect
     `window.Capacitor` and switch URLs)

### Hosting the bundle from GitHub
4. The user wants to point `CC_BUNDLED_DATA_BASE` at a CDN URL
   (probably jsdelivr) so their Flask backend doesn't need
   `data/BundledData/` on disk. Try:
   ```js
   window.CC_BUNDLED_DATA_BASE =
     'https://cdn.jsdelivr.net/gh/USER/REPO@main/data/BundledData';
   ```
   Verify CORS works in production. If it does, the Flask
   `/bundled-data/<path>` route can become a no-op (or stay as a
   fallback for self-hosted users).

### Daycare feature (the original ask)
5. Two-slot daycare. While in: walk distance generates candy.
   After 5-10km walked: an egg. Egg fusion species = uniformly:
   - 2/3 chance from `{A×B, A×D, C×B, C×D}` (slot-preserving)
   - 1/3 chance from one of `B×{A..D}, {A..D}×A, {A..D}×C, D×{A..D}`
     (slot-swap mutation)
   Distance source: foreground GPS for now (web). Native: real
   pedometer once Capacitor + plugin lands. UX:
   - One-time placement + retrieval flow
   - Live progress bar to next egg
   - Notification when ready (real on native, in-app on web)
   - Egg sprite uses `eggs.png` from BundledData (cell N for
     species N) when available; falls back to `egg-default.png`.

### Outstanding bug
6. **Partner-on-Android variant issue** — `DEBUGGING.md` documents
   two theories and the data-collection path. Partner hasn't
   tested yet (was at work / not home when last discussed). When
   they do, the Settings `[script versions]` block + `[sprites]
cached=` count tells us which theory is right. Fix code is
   sketched in `DEBUGGING.md` (the fix for theory 2 is to also
   null `rec.objectUrl` after `URL.revokeObjectURL` in
   `removeMarker`, and add an `img.onerror` fallback in
   `openBattleScreen` that refetches from IDB).

## Things to remember
- **iOS WKWebView Service Workers require BOTH** `WKAppBoundDomains`
  in Info.plist AND `limitsNavigationsToAppBoundDomains: true` in
  the WKWebView config. Capacitor 6's iOS plugin sets the latter
  when you add the capacitor.config flag — but you must also patch
  Info.plist (workflow does this with `PlistBuddy`).
- **App-Bound Domains hard-cap at 10**. Add only canonical hostnames.
- **AltServer-Linux + NixOS**: the binary is glibc-linked and
  doesn't run from `/nix/store/`. The community `iloader` flake
  (github:nab138/iloader) ships a properly patched binary. Wrap
  with `steam-run` if you fall back to vanilla AltServer-Linux.
- **`builtins.getFlake` in shell.nix** requires flakes enabled.
  `.envrc` does this per-project via `NIX_CONFIG`.
- **mbtiles tile_data is gzipped on disk**. The `/tiles` and
  `/bundled-data/tiles/` routes both set `Content-Encoding: gzip`
  so MapLibre can decode it.
- **PIF sprite sheets are 0-indexed** — cell 0 is empty, species N
  is at cell N. `MAX_SPECIES=150` needs 151 cells = ceil(151/cols)
  rows. The crop math is `(MAX_SPECIES // cols) + 1`, NOT
  `ceil(MAX_SPECIES / cols)`.
- **Capacitor `server.url` mode** = WebView pinned to the URL.
  Pure-JS updates ship via Refresh (no IPA rebuild). Native plugin
  additions still require an IPA rebuild.
- **The user is on a daily walk to Sage Days** with their husband,
  catching fusions on the way. Polish work in this session is
  shaped by that ritual: a daily-use app should feel quiet, fast,
  and consistent. The pixel-tweak conversations
  (`5px less / 1 more px / nvm 6 was good`) are a kind of intimate
  iteration — let them happen, take the small steps seriously.

## File touch summary (this session)

```
.envrc                         (NIX_CONFIG flakes enable)
.github/workflows/ios-build.yml (NEW — unsigned IPA build,
                                 WKAppBoundDomains patch)
.gitignore                     (data/* + !data/BundledData/,
                                 ignore Capacitor generated dirs)
build-bundled-data.py          (NEW — generates data/BundledData)
extract-pif-dat.rb             (NEW — Ruby Marshal → JSON)
install-ipa.sh                 (NEW — gh-CLI artifact downloader
                                 + optional AltServer sideload)
package.json                   (NEW — Capacitor deps)
capacitor.config.json          (NEW — server.url + iOS App-Bound)
shell.nix                      (Node + JDK 17 + Android SDK +
                                 libimobiledevice + gh + ruby +
                                 pillow + iloader flake)
README.md                      (Native wrapper section)
HANDOFF.md                     (this section)
POEMS.md                       (3 new poems)
DEBUGGING.md                   (NEW — partner Android var bug)
run.py                         (script-version stamping,
                                 /bundled-data/<path> route,
                                 SplitNames + credits-bundle
                                 endpoints)
static/index.html              (cc-x-btn shared rule, action icons,
                                 daycare-prep place lookup,
                                 CC_BUNDLED_DATA_BASE config,
                                 appDataBtn extended with sprite
                                 download, 3 new poems' worth of
                                 polish)
static/creatures.js            (rename inline UI, family tree
                                 moved, caught block 3 lines,
                                 spacing iteration, name
                                 truncation, scroll-top button,
                                 filter snapshot in stack)
static/sprites.js              (BUNDLED_BASE constant, sheet URL
                                 helpers, fused name algorithm,
                                 sprite credits + split-names URLs
                                 swapped to bundled paths)
static/species.js              (bundled paths + allSpecies helper)
static/appdata.js              (bundled paths for icons + fonts +
                                 listing JSONs)
static/sw.js                   (script-version constant +
                                 ball SVGs in APP_SHELL)
data/BundledData/              (NEW — 134 MB, 2350 files,
                                 committed to git for hosting)
```

---

# Session handoff (2026-05-02 → 2026-05-03)

Long session — IPA architecture, native plugin, live updates, lots of debugging.
Started from "let's bundle the data into the IPA" and arc'd through several wrong turns
before landing on a working architecture. **App now launches, geolocation works,
spawns + tile rendering both work**. Two known issues remaining (POI icons render as
dummies on first launch, sprites lazy-load instead of eager).

## What works
- IPA launches without network, page served from in-app GCDWebServer at `http://localhost:<port>/`
- Service Worker registers cleanly (localhost = secure context, http = scheme allowed)
- Bundled z0–z5 tiles render via LocalServer reading `App.app/public/tiles/`
- Region downloads (z6+) cache via SW, render correctly inside the bbox
- Tile-pyramid fallback works: missing high-zoom tiles render as over-zoomed bundled z5 (blurry but visible)
- Pokemon spawning, geolocation, save/load, all backend endpoints (CORS-allowed for `http://localhost`)
- Phase 3 live-update flow: page checks `/script-versions`, downloads diffs to `Library/CCLiveUpdates/v-<version>/`, calls native plugin to swap LocalServer's read directory, reloads

## Architecture (now-working)

**`capacitor.config.json`**: no `server.url`. `webDir: "dist"`. `limitsNavigationsToAppBoundDomains: true`.

**Workflow patches Capacitor framework source in `node_modules/@capacitor/ios/.../Capacitor/`** before `cap add ios`:
- `WebViewDelegationHandler.swift` — `webViewWebContentProcessDidTerminate` → no-op (was `webView.reload()`; killed in-flight state on memory pressure)

**`ios-overrides/`** (new directory, committed to repo, copied into `ios/App/App/` by workflow):
- `LocalServer.swift` — wraps GCDWebServer (CocoaPod). Serves files from
  `Bundle.main.path(forResource: "public", ...)` with optional liveDir override
  (under `Library/CCLiveUpdates/`). **Persists port via `UserDefaults["cc.localServer.port"]`**
  so SW cache entries (keyed by full URL incl. port) survive across launches.
  Sets `application/x-protobuf` Content-Type for `.pbf` files.
- `AppBridgeViewController.swift` — `CAPBridgeViewController` subclass.
  In `instanceDescriptor()` boots LocalServer + sets `descriptor.serverURL`.
  In `capacitorDidLoad()` registers `BundleAccessPlugin` via
  `bridge?.registerPluginInstance(...)`.
- `BundleAccessPlugin.swift` — exposes `getLiveDir`, `setLiveDir`, `clearLiveDir`,
  `getLiveDirRoot` to JS via `Capacitor.Plugins.BundleAccess`. Wired up via
  `CAPBridgedPlugin` conformance + manual `registerPluginInstance` (no `.m` macro
  file or capacitor.config packageClassList entry needed).
- `inject-into-xcodeproj.rb` — uses CocoaPods' bundled `xcodeproj` Ruby gem to
  add the three Swift files to the App target.

**Workflow** (`.github/workflows/ios-build.yml`):
1. Checkout / Setup Node / Install JS deps
2. Build Capacitor webDir (`scripts/build-capacitor.sh` → `dist/`)
3. **Patch Capacitor framework** (memory-reload disable) — patches
   `node_modules/@capacitor/ios/.../WebViewDelegationHandler.swift` BEFORE pod install
4. `npx cap add ios && npx cap sync ios`
5. **Inject local-server Swift files + Podfile entry**:
   - copies the three Swift files into `ios/App/App/`
   - sed-patches `Main.storyboard` `customClass` from `CAPBridgeViewController`
     to `AppBridgeViewController`
   - inserts `pod 'GCDWebServer', '~> 3.5'` into the Capacitor-generated Podfile
   - runs the Ruby xcodeproj injector
6. Patch Info.plist (`WKAppBoundDomains: ["localhost"]`,
   `NSLocationWhenInUseUsageDescription`)
7. `pod install` (downloads GCDWebServer)
8. `xcodebuild` unsigned + manual IPA assembly

**Page-side Capacitor block** (`static/index.html`):
- `window.CC_API_BASE = "https://poke.phylliidaassets.org"` — for cross-origin
  fetches to backend endpoints (/save, /load, /poi, /walk-graph, etc.)
- `document.documentElement.classList.add('cc-bundled')` — CSS hides the
  `↓ app data` row + missing-banner
- `window.fetch` interceptor: paths in `LOCAL_PREFIXES` pass through,
  everything else gets prefixed with `CC_API_BASE`
- Geolocation shim: monkey-patches `navigator.geolocation` to call through
  to `Capacitor.Plugins.Geolocation` (handles both Promise + sync return shapes)
- `iconBulkDownload` awaited in IIFE BEFORE map construction (silently
  rasterizes ~200 SVGs from local bundle into IDB so MapLibre's loadAllIcons
  has something to register from). **Currently still broken** — see "Open issues" below.

**Service Worker** (`static/sw.js`):
- `IS_CAPACITOR = self.location.hostname === 'localhost'` — SW detects mode
- `_missResponse(req)`: in capacitor mode, falls through to `fetch(req)`
  (LocalServer serves bundled file). **Translates non-200 LocalServer responses
  to 204** so MapLibre's tile-pyramid parent fallback kicks in (this was the
  fix for "only one specific zoom renders" — 404 marks tile as failed in
  MapLibre, 204 marks it as intentionally empty + look up parent chain).
- `downloadRegion` accepts `apiBase` from page-side, prepends to fetch URLs
  but caches under original relative key. **Manually decompresses gzipped
  responses via `DecompressionStream`** in case the browser doesn't auto-decompress
  in SW context (turns out it does in WebKit, but the safety net is harmless).
  Strips `Content-Encoding`/`Content-Length` headers from cached responses
  to prevent the "decoded body + gzip header → double-decompress garbage" bug.

**Map style** (`static/index.html`):
- Both `base` and `local` sources now have `maxzoom: 14` (was 5/14). Same
  URL, MapLibre dedups fetches. This restored the parent fallback chain —
  previously `base.maxzoom: 5` capped the over-zoom limit at z10, and missing
  tiles past that had no fallback.
- `transformRequest` simplified: drops the cross-scheme rewriting that was
  needed in our brief stint with `server.url + capacitor:// data` (didn't work
  due to WebKit cross-scheme fetch block — see "Wrong turns" below).

## Live-update flow

1. Page loads from LocalServer. `static/live-update.js` runs (script-tag at
   bottom of index.html).
2. After 2-second defer, fetches `https://poke.phylliidaassets.org/script-versions`
   (CORS-allowed via Flask's `_cors_for_capacitor` after_request hook).
3. Compares with `localStorage.cc.installedVersions`. If anything differs,
   downloads ALL tracked files (avoids version skew) into a fresh
   `<Library>/CCLiveUpdates/v-<tag>/<file>` via `@capacitor/filesystem`
   `writeFile({recursive: true})`.
4. `Capacitor.Plugins.BundleAccess.setLiveDir({path})` — LocalServer starts
   reading from there in preference to the bundled webDir. Persists across
   launches via UserDefaults.
5. `localStorage.setItem('cc.installedVersions', ...)` and `location.reload()`.
6. New code runs on the reload.

15-minute backoff after failures (`cc.lastUpdateFailedAt`) so a broken
server response doesn't reload-loop. The emergency-refresh button (↻ at
bottom-right of map) clears `cc.installedVersions` + `cc.lastUpdateFailedAt`
to force a fresh download cycle.

## Other tooling

**Pre-cropped sprites in build script** (`build-bundled-data.py`):
- Considered, partially implemented (~22.5k autogen + ~24.5k custom files),
  then **reverted** because the file-count tax made iLoader sideloading
  ~10× slower. Now back to per-head sheet output (~750 sheet PNGs).
- `cells.json` still produced via alpha-scan — replaces the runtime
  PASS 2 alpha-scan in `Sprites.bulkDownload`; PASS 2 now just decodes
  each variant sheet once and crops the known-good cells per cells.json.
- Bundled tiles **decompressed at build time** (`bundle_base_map_tiles`
  detects gzip magic + `gzip.decompress`) so LocalServer can serve them
  raw — Capacitor's URL handler doesn't set `Content-Encoding: gzip`.
  Flask's `/bundled-data/tiles/` route also dropped the gzip header to
  match.

**SW.intercept changes for sheet-based sprites**: lazy-crop fallback in
`getSpriteBlob` — IDB miss → fetch sheet (cached after first decode) →
canvas-crop → store IDB → return. So sprites work whether or not bulk
download has run.

## Open issues

### POI icons render as dummies (incomplete)
First-launch UX in IPA: POI icons show as default placeholders. My latest
attempt was to `await iconBulkDownload` in the main IIFE before the map is
constructed. **User reports this didn't fix it** — debugging interrupted by
context limit.

Possible causes to investigate:
1. `iconBulkDownload` failing silently (errors caught + skipped) — wrap with
   logging that surfaces to debug overlay
2. `_loadAllIcons` reading empty `availableIconNames` cache (already
   invalidated via `_iconNamesCache = null;` in `iconBulkDownload`, but
   double-check)
3. `safeAddImage` rejecting RGBA buffers (pixel format mismatch?)
4. MapLibre's `styleimagemissing` handler caching "missing" verdict and
   not re-rendering when `addImage` lands later
5. Icon names registered != names referenced in style (alias map issue)

Diagnostic ideas:
- Log `iconBulkDownload` return value (`{loaded, total}`) at the await site
- Log `loadAllIcons` return value (count of registered icons)
- After bulk download, dump `Object.keys(map.style._sprite._images)` (or
  similar internal) to see what's actually in MapLibre's image registry
- Test what icon name a POI is requesting (via styleimagemissing event)

### Sprites lazy-load (by design but rough UX)
User noticed: "pokemon are red dots until i click on them and then always
loaded even after refresh". The IDB-cached version persists across launches
(working as designed), but first render of each unique fusion shows the
default red marker until the user interacts.

Fix would be to pre-warm visible spawns on map idle: walk the visible
spawn list, call `getSpriteBlob` for each, update markers. Not done yet.

## Wrong turns (so future-me knows what NOT to try)

1. **Cross-scheme fetch from `https://` page to `capacitor://` URL handler**:
   tried with `server.url` mode + `capacitor://localhost/_capacitor_file_/<path>`
   patched-injection. WebKit blocks `fetch()` to custom schemes from web origins
   regardless of CORS headers. `<img src>` works (no CORS check), `fetch()` doesn't.
   Took several rounds of patching `WebViewAssetHandler.swift` (CORS headers) +
   `CAPBridgeViewController.swift` (WKUserScript-injected `CC_BUNDLED_DATA_BASE`)
   before realizing the fundamental restriction.

2. **`iosScheme: "https"`**: WebKit reserves https; Capacitor silently falls
   back to `capacitor` scheme. Doesn't work.

3. **`limitsNavigationsToAppBoundDomains: false` + bundled mode**: SW won't
   register without an App-Bound entry that matches the page origin. Needed
   `["localhost"]` in WKAppBoundDomains.

4. **Per-cell pre-cropped sprites**: 47k tiny PNG files killed iLoader signing
   speed. Reverted to per-head sheets (cells.json provides alpha-scan info
   without needing per-cell files).

## File touch summary (this session)

```
.github/workflows/ios-build.yml  (drop server.url-mode patches; add
                                  patch-Capacitor-memory-reload step;
                                  add inject-Swift-files step;
                                  add ios-overrides/** to triggers)
capacitor.config.json            (drop server.url; webDir=dist;
                                  limitsNavigationsToAppBoundDomains true)
package.json                     (added @capacitor/filesystem)
scripts/build-capacitor.sh       (creates dist/ from static/ + BundledData)
ios-overrides/                   (NEW directory, all 4 files committed)
  LocalServer.swift              (GCDWebServer wrapper; persists port;
                                  liveDir override; .pbf MIME type)
  AppBridgeViewController.swift  (boots LocalServer; registers plugin)
  BundleAccessPlugin.swift       (JS-callable getLiveDir/setLiveDir)
  inject-into-xcodeproj.rb       (xcodeproj gem to add files to target)
build-bundled-data.py            (decompress tiles at build time;
                                  cells.json alpha-scan; reverted to
                                  sheet-based sprite output)
run.py                           (CORS for http://localhost origin;
                                  drop Content-Encoding gzip from
                                  /bundled-data/tiles/; live-update.js
                                  in _TRACKED_JS + _SCRIPT_VERSION_FILES)
static/index.html                (Capacitor block: drop fetch interceptor's
                                  cross-scheme stuff, add cc-bundled class,
                                  add geolocation shim, add startup
                                  iconBulkDownload await; on-screen debug
                                  overlay; map.on('error') logger; tile-probe
                                  diagnostic; both sources maxzoom 14;
                                  drop transformRequest cross-scheme rewrite;
                                  refresh button now clears cc.installedVersions;
                                  expose loadAllIcons via window._loadAllIcons;
                                  live-update.js script tag)
static/sw.js                     (IS_CAPACITOR detection; _missResponse
                                  translates LocalServer non-200 → 204;
                                  downloadRegion: apiBase plumbing,
                                  DecompressionStream gzip detection,
                                  strip Content-Encoding for cache.put,
                                  diagnostic counters in 'done' message)
static/sprites.js                (sheet-based revert; lazy-crop fallback
                                  in getSpriteBlob)
static/species.js                (auto-load ensureLoaded in Capacitor mode)
static/live-update.js            (NEW — Phase 3 live-update flow)
static/creatures.js              (renderWeatherBar shows "Loading..." while
                                  Species loads instead of "no creature data")
data/BundledData/                (regenerated multiple times — sheet
                                  sprites, decompressed tiles, cells.json)
HANDOFF.md                       (this section)
```

## Things to remember

- **Capacitor's WKURLSchemeHandler does NOT serve arbitrary webDir paths
  when `server.url` is set** — only `_capacitor_file_<path>` and
  `_capacitor_http_<path>`. We landed on bundled mode + LocalServer because
  of this.
- **WebKit blocks fetch() to custom schemes from `https://` page origins**.
  `<img src>` is exempt (no CORS check); fetch() requires same-origin or
  CORS-allowed http(s).
- **localhost is a "potentially trustworthy" origin** even over plain http,
  so SW.register() works at `http://localhost:<port>/...`. This is why
  embedding GCDWebServer + pointing serverURL at it solves the SW gap.
- **`@objc` and `private(set)` are mutually exclusive in Swift** — caused
  a build failure on `liveDir`; dropped `@objc` since BundleAccessPlugin
  reads it via Swift not Obj-C.
- **GCDWebServer with port 0 picks a NEW random port each launch** — SW
  cache keys include port → cached tiles invalidate every launch. Persist
  the chosen port in UserDefaults to keep the cache useful.
- **MapLibre treats 404 vs 204 differently for tile fetches**. 404 → tile
  marked as failed, no parent fallback. 204 → tile is intentionally empty,
  walk the parent chain. SW.intercept must translate LocalServer's 404 to 204.
- **MapLibre's source `maxzoom` caps the over-zoom range** (~5 levels above
  maxzoom). Setting both `base` and `local` to the same maxzoom prevents the
  blank-zone gap when high-zoom tiles aren't cached.
- **Capacitor 6 plugin auto-registration uses `capacitor.config.json`'s
  `packageClassList` (read at runtime from the iOS bundle)**. Manually
  registering via `bridge.registerPluginInstance(...)` in `capacitorDidLoad`
  works without modifying that JSON or shipping a `CAP_PLUGIN(...)` macro
  in a `.m` file.
- **The on-screen debug overlay is at `top: 200px`** so it doesn't sit
  under the iPhone's Dynamic Island / notch. `localStorage.cc.debugConsoleHidden=1`
  hides permanently if needed.

```
Final state of repo: TWO commits ahead of working IPA, POI icons broken on first launch
Daily ritual: walk to Sage Days continues, IPA mostly usable but icon situation
needs another session
```
