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
