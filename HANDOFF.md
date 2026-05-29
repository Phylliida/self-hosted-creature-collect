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

---

# Subsequent sessions — features, fixes, architecture

A series of follow-up sessions after the bundled-mode breakthrough above.
The IPA went from "mostly usable but POI icons broken" to a polished,
self-healing app with offline directions, address search, a daycare/
distance-tracker feature, and an Android build path. This section is
organized by theme, not chronology — pick a topic, follow the pointers.

## IPA bundle / liveDir lifecycle

The overlay model (liveDir → bundleDir fallthrough in LocalServer) had two
load-bearing bugs that made the IPA feel unstable:

1. **Live-update path went stale across launches.** `LocalServer.swift`
   stored the absolute path of the active liveDir in UserDefaults; iOS
   rotates the data-container UUID on some launches (OS updates, restore-
   from-backup), invalidating the path. Fix: persist the path RELATIVE to
   `Library/`, re-resolve at startup. Migration handles old absolute-path
   entries by extracting the `CCLiveUpdates/...` suffix.
2. **Old liveDir masked newer bundle code after IPA reinstalls.** Fresh IPAs
   shipped with newer files in `App.app/public/`, but a previous install's
   liveDir still overlayed older versions of `index.html` / `sprites.js` /
   etc. Fix: `scripts/build-capacitor.sh` stamps a `dist/bundle-id.txt`
   (UTC timestamp) at build time. `LocalServer.start()` reads it on every
   launch and invalidates UserDefaults' liveDir keys when the id differs
   from the previously-recorded one. Pre-WebView, no JS needed. The
   transition heuristic also clears liveDir when `last == nil` but a stale
   `liveDirRel` exists — covers the upgrade from IPAs that didn't have
   `bundle-id.txt` to the first IPA that does.

## Refresh button — single reload + JS-free fallback

The refresh button was previously a `<button>` whose onclick set a flag,
reloaded, then a 2-second deferred timer fired live-update.js which
reloaded again. Two visible reloads + 2s of dead time. Now:

- Button is an `<a href="/__refresh__.html">` so default link navigation
  provides a JS-free safety net — if onclick throws (broken liveDir overlay
  containing busted JS), the browser navigates to `/__refresh__.html`
  regardless.
- `LocalServer.swift` adds a `/__refresh__.html` route that clears any
  liveDir pointers and 302-redirects to `/` — same end-state as a fresh
  app reinstall, no reinstall required. Pure HTML escape hatch.
- `run.py` adds an analogous `/__refresh__.html → /` 302 so web users
  that hit the path don't see a 404. No-op behavior since web has no
  liveDir.
- `scripts/build-capacitor.sh` writes a static `dist/__refresh__.html`
  with a `<meta http-equiv="refresh">` to `/`. iOS and Flask never
  actually serve this file (their route handlers pre-empt it), but it's
  the canonical handler for **Android**, where there's no native
  interceptor — Android's `WebViewAssetLoader` serves the bundled file
  directly. Same href, three platforms, three handlers; the user-facing
  JS-free escape hatch works everywhere.
- onclick happy path calls `CCLiveUpdate.check({ force: true })` directly
  (the force flag was already plumbed through). Single reload at the end
  of the live-update flow. Returns `false` on success to prevent the link
  navigation; on any throw the `<a>` default kicks in.

`live-update.js` is gated by `cc.refreshRequested` — set only by the in-app
refresh button. Default app launches do zero `/script-versions` fetches.

## Sprite / creature data hardening (IPA-mode)

Several IDB-keyed creature-data flows broke silently in the IPA because
they were only seeded by `Sprites.bulkDownload` (which the IPA hides since
data is bundled). The pattern: ensure-from-IDB → fall back to bundled JSON
when in Capacitor mode → persist to IDB on first read.

Affected entries, all in `static/sprites.js`:
- `_ensureSplitNames` ↔ bundled `split-names.json`. Without it, every
  fusion rendered "A × B" instead of canonical PIF names like "Charizard".
- `_ensureCreditsBundle` ↔ bundled `credits.json`. Missing credits in
  detail/inventory views.
- `_ensureVariantSummary` ↔ bundled `cells.json`. Without it,
  `getCellVariantCount` always returned 0 → `resolveSpawnVariant` returned
  null → every marker used the autogen path → custom art was invisible
  AND the pokédex reported "no custom art available" for every fusion.
  **Critically:** the original fix bulk-wrote ~15 k per-cell IDB rows on
  first launch, taking ~40 s on iOS WebKit and blocking startup. Replaced
  with a single `_cellsMap` in-memory cache populated from cells.json in
  one O(N) pass; per-cell variant array reads (e.g. in
  `getSpriteCreditForSlot`) are now resolved through `_getCellVariantArr`
  which checks `_cellsMap` first, falls back to legacy IDB rows for
  pre-existing bulkDownload state.

`getCustomManifest` and `getCells` were always-fetch-on-first-need, so on
the web they hit the remote server even outside an explicit user action.
Restructured as cache → IDB → (Capacitor only) network fetch. Web stays
zero-network unless `bulkDownload` runs (which is itself a user action);
new `_downloadManifest` / `_downloadCells` helpers let `bulkDownload`
explicitly request a fetch on the web side.

## Sprite-loading reliability (red-dot recovery)

Map markers used to occasionally stick on the placeholder red dot until
a full app restart. Two layered fixes:

1. **`getSpriteBlobsBatch` lazy-crops on miss.** Previously it returned
   null blobs for every IDB miss; the marker's batch flow installed
   nothing for those, leaving the red placeholder visible. Now it
   delegates each miss back through the single-call `getSpriteBlob`
   path, which lazy-crops the bundled sheet. Also gated on Capacitor —
   web users keep the strict zero-network rule; the lazy-crop in IPA
   mode hits LocalServer (local) and never the remote origin.
2. **Event-driven recovery via `cc-sprite-loaded`.** When `getSpriteBlob`
   succeeds via lazy-crop, it dispatches a `CustomEvent` with the cell
   coordinates + variant + blob. `creatures.js` listens and, for any
   marker with `loaded=false` matching that exact `(a, b, variant)`,
   calls `installSpriteBlob` immediately. So tapping a stuck red-dot
   marker triggers the single-call path → sprite lands in IDB → event
   fires → every other red-dot for the same fusion updates without
   needing another viewport refresh.

`installSpriteBlob` also revokes any prior object URL on retry to avoid
leaks from URLs that were created but never `img.onload`-ed.

`addMarker` records `{loaded: false}` on every record. Retries piggy-back
on the existing per-fix viewport reconciliation in `refreshSpawnOverlay`
— when a stuck record is still present at the next reconciliation, the
event handler will already have rerendered it.

## Battle screen sprite — `img.onload` cache miss

`openBattleScreen` reuses the marker's existing object URL when present.
On iOS WKWebView, setting `img.src` to a blob URL whose underlying image
is already decoded sometimes skips `onload` entirely. The class
`battle-sprite-ready` was only added in `onload`, so the sprite stayed
`display: none` even though the URL was valid — the only thing visible
during a throw was the silhouette flash element, which the user reported
as "the icon flashes for a few frames during a throw but is otherwise
invisible."

Fix: synchronous `img.complete && img.naturalWidth > 0` check after
setting `src`, plus an `onerror` handler that surfaces real load
failures into `_creatureDiag.errors`.

## Settings panel additions

- **Debug console toggle** (`cc.debugConsole`, default OFF). The on-screen
  error overlay attaches its capture listeners unconditionally; the
  toggle just flips visibility via `_setDebugConsole(on)`. Replaces the
  old "long-press to permanently hide" mechanic.
- **Memory badge toggle** flipped from default-on to default-off
  (`cc.memBadge` now `=== '1'` to enable). Battery-friendly default.
- **Re-mark custom art button** (`#remarkCustomArtBtn`). One-shot migration
  for users whose captures were saved as autogen because the variant-
  summary fallback didn't exist yet — promotes any capture with
  `variant === null` to slot 0 (artist's primary) when `cells.json` shows
  the cell actually has custom variants. Idempotent. Status string says
  "scanned X autogen capture(s); promoted Y to custom".
- **Both buttons** (`#scheduleClose`, `#remarkCustomArtBtn`) now have full
  accent-button styling including all 10 theme overrides (vaporwave glow,
  win95 chrome, sims green, tron cyan, medieval small-caps, etc.).
- **Done button row-stretched** in inventory subviews via
  `#creatureInventory .actions button.close { flex: 1 }`. Selector is
  scoped to `.actions` so the top-right X (which also carries
  `class="close"`) keeps its sticky-corner behavior.
- **Done button hidden by default in detail-view** unless the panel is
  in post-catch state. `showDetail({ fromCatch: true })` marks the stack
  frame; `applyTopView` toggles `cc-post-catch` based on whether the
  current frame has the flag, so back-nav into and out of the post-catch
  detail entry adds/removes the Done footer cleanly.

## Daycare feature (full vertical)

A walking-distance tracker with calendar + map overlay + "boarding" two
captured creatures whose accumulated walking distance is tracked
per-stay.

### Distance accumulator

`_accumulateDaycareDistance` runs from the geolocation `watchPosition`
callback. Anchor-held filters:

- Jitter floor: 10 m. Sub-threshold movements don't advance the anchor;
  prevents accumulation of GPS drift over hours of standing still.
- Backgrounding gap: 60 s. Long silences between fixes reset the anchor
  without crediting travel — the user was probably elsewhere with the
  app suspended.
- Speed cap: 50 m/s. Outlier fixes (teleports) reset anchor without
  recording.
- Anchor advances only when ALL filters pass; jitter holds anchor until
  cumulative drift exceeds the floor.

`_lastFixAt` tracks the most recent fix regardless of acceptance, so the
gap detector can distinguish "app suspended" from "slow walker hasn't
crossed the threshold yet."

### Storage schema

Per-day distance summary and full GPS path both live in IDB
(`creature-tracker-v1`):

- `summary` store: { dayKey: meters }, in-memory cache hydrated on
  startup. Migration from legacy `cc.daycareDistance.v1` localStorage
  entry runs once on init.
- `paths` store: { dayKey: [{lat, lng, t}, ...] }, capped at
  `PATH_MAX_POINTS_PER_DAY = 20000`. Debounced flushes (5s) so we don't
  hit IDB on every fix; also flushed on `visibilitychange` and
  `pagehide`.

### Calendar UI

`renderDaycare` shows: today's headline number, a month-grid calendar
with prev/next nav (next is disabled on the current month), per-day
cells annotated with distance, and a detail block for the selected day.
Past + current days are clickable; future cells are dimmed and inert.

### Map overlay

"Show on map" / "Show all on map" buttons render the day's path as a
GeoJSON `LineString` on a dedicated `cc-daycare-path` source, segmented
by the 60 s break rule so backgrounding gaps don't draw as long phantom
lines. Camera fits to the route bounds. Overlay state lives in
`_activeDaycareOverlay = { dayKey } | { allDays: true } | null` so a
`map.on('style.load', …)` hook re-adds the polyline transparently after
theme switches (which reload the entire MapLibre style, dropping every
custom source/layer).

The dismiss bubble lives in MapLibre's `bottom-right` ctrl cluster and
is moved to the top of the cluster via one DOM `insertBefore` after
`addControl` — sits above the GeolocateControl as the user requested.

### Daycare-as-a-place (slot system)

The user can park up to 2 captured creatures in the daycare. Each slot
stores `{ id, addedAt, distM }`:

- `id`: capture id reference.
- `addedAt`: timestamp set when the creature is placed; reset on each
  re-entry.
- `distM`: meters accumulated DURING the current stay. Reset to 0 each
  time the creature is re-added.

`_accumulateDaycareDistance` adds the same `d` meters it credits to
today's bucket onto each occupied slot's `distM`. Same accept filters
apply (10 m / 60 s / 50 m/s) so a stationary or backgrounded session
contributes nothing.

The "Daycare" tag is implemented as an interactive built-in tag (new
schema option `interactive: true` + `onToggle(c)` callback on
`BUILTIN_TAGS` entries). Its `visible(c)` returns true when the creature
is already in the daycare OR there's a free slot; once the daycare is
full and this creature isn't already in it, the chip disappears from
the picker. `_liveDaycareCount()` filters slot IDs against existing
captures so a stale ID (creature deleted) doesn't lock out new entries.

Export/import payload carries the slots; importer normalizes both v1
(string-id-only) and v2 (object) shapes, filters against valid capture
IDs in the imported + existing data, caps at 2.

## Spawn-rate tuning

Stationary play was rewarded too heavily — sit in one spot, wait for
spawns, repeat. Rebalanced via the `k = 2` lever the spawn-tuning constants
were designed around:

- `LIFETIME_MS`: 10 min → 20 min
- `SPAWN_CHANCE_PER_TICK`: 0.0016 → 0.0008
- Product (visible density per cell while walking) preserved
- Stationary new-spawn rate halved

The spawn comment in `static/spawns.js` records the lineage:
v1 (0.0032 × 5) → v2 (0.0016 × 10) → v3 (0.0008 × 20).

## Address search

A from-scratch end-to-end address-search flow:

### Build pipeline

`build-housenumbers.py` extended to extract `addr:street` alongside
`addr:housenumber`, intern street names into a `streets` table (FTS-able
later), reference by `street_id` from each `hn` row. Indices added for
"all housenumbers on this street" lookups.

The original build on the 18 GB north-america PBF would have taken ~8
hours (osmium has to traverse every node + way for the location index).
Wrapped in `_prefilter_pbf` which shells out to `osmium tags-filter`
before the SimpleHandler scan — knocks the file down to ~200 MB by
keeping only nodes/ways with `addr:housenumber`. Total build time
~25 min instead of 8 hr. Tempfile is auto-cleaned via `try/finally`.

Progress logging: every 5s, plus a node-counter sample (every ~1M raw
node callbacks) so quiet stretches still emit lines. `_fmt_dur(secs)`
formats elapsed times as `1h12m05s`.

### Server endpoint

`/addresses?bbox=…` returns a binary `ADDR` bundle (48-byte header,
4 × N u16 columns: lng_q, lat_q, num_idx, street_idx, plus two
interned string pools for housenumbers and streets). Skips DBs without
the `streets` table (graceful fallback for unbuilt DBs). Filters to
addresses with non-null `street_id` (others can't be address-searched
by street name anyway).

### Client

Per-region IDB store (`cc.addresses.v1`), saved/loaded/deleted alongside
the existing POI/walk/hn region stores. `hydrateAddressRegion` parses
the binary into `{lng, lat, num, street, label, _labelLower, regionId}`
records with the lowercased label pre-computed. `allAddresses` array is
populated at startup and updated on region add/refresh/delete.

Search integration:
- **Main search box** (`renderSearch`): token-based matching on the
  lowercased `<num> <street>` label. "1996 Allison Way" matches "1996
  South Allison Way" because each token (`1996`, `allison`, `way`) is a
  substring of the label, regardless of word order. Capped at 200
  results so a single-token query like "way" doesn't flood the list.
- **Trip planner From/To boxes** (`searchEndpoints`): same token-based
  rule, address hits show with 🏠 icon + "address" meta label,
  capped at 20 nearest. Favorites also moved to token-based matching
  for consistency.
- **Custom-pin search** added to the main search box (was previously
  only POIs and addresses). Renders with `★ favorite` meta. Click flows
  through `setSelected(p)`, which calls `findFavorite(lng, lat)` to
  apply favorite styling automatically.

## Android build workflow

`.github/workflows/android-build.yml` builds a debug APK on
`ubuntu-latest` (no Mac runner needed). Same `dist/` composition as
iOS via `scripts/build-capacitor.sh`. JDK 17 + GitHub-hosted Android
SDK; `cap add android` (idempotent) + `cap sync android`; same
`rsync dist/ → assets/public/` workaround for the icons/fonts
directory-drop bug; `./gradlew assembleDebug`; APK uploaded as
`creature-collect-debug-apk` artifact.

Caveats: live-update is no-op on Android because `BundleAccessPlugin`
is iOS-only Swift. `live-update.js`'s `plugins()` returns null when
either Filesystem or BundleAccess is missing; `checkForUpdates` bails
gracefully. Each code update needs a fresh APK for now. Memory probe
also iOS-only; settings memory-badge row stays hidden.

## File touch summary (these sessions)

```
ios-overrides/LocalServer.swift       (relative-path liveDir storage;
                                       bundle-id detect-and-clear;
                                       /__refresh__ route)
scripts/build-capacitor.sh            (write dist/bundle-id.txt)
build-housenumbers.py                 (addr:street extraction + interning;
                                       streets table; pre-filter via
                                       osmium-tool; progress logging)
run.py                                (/addresses endpoint; /__refresh__
                                       302; redirect import)
static/index.html                     (refresh button → <a> w/ onclick;
                                       fetch instrumentation; address
                                       hydrate + search; daycare distance
                                       summary IDB; daycare slot import;
                                       favorite search in main box)
static/sprites.js                     (bundled JSON fallbacks: split-names,
                                       credits, manifest, cells; lazy-crop
                                       gated on Capacitor; cc-sprite-loaded
                                       event; _getCellVariantArr in-memory
                                       lookup; getSpriteBlobsBatch lazy-
                                       crop on miss)
static/creatures.js                   (Daycare distance tracker w/ jitter
                                       filters; per-day GPS path in IDB;
                                       calendar view + map overlay;
                                       interactive built-in tag schema;
                                       Daycare tag + slot system; Done
                                       button stack-frame gating;
                                       battle-sprite img.complete fallback)
static/live-update.js                 (refresh-flag gate; force:true bypass)
static/spawns.js                      (k=2 rebalance: 20 min × 0.0008)
.github/workflows/android-build.yml   (NEW — debug APK build)
HANDOFF.md                            (this section)
```

## Things to remember (cumulative)

In addition to the iOS-specific gotchas in the previous section:

- **iOS data container UUIDs rotate** under some circumstances (OS
  upgrades, restore-from-backup). Always store paths relative to
  `Library/`, never absolute.
- **iOS WebKit `img.onload` may skip for cached blob URLs.** Always
  pair with a synchronous `img.complete && naturalWidth > 0` check.
- **iOS WebKit IDB is slow for many small puts** — ~40 s for 15 k
  rows in one transaction. Prefer one-blob-per-store designs with
  in-memory caches over per-cell rows.
- **`cap sync` strips `icons/` and `fonts/` directories** from the
  webDir copy on both iOS and Android. Both workflows include an
  `rsync -a dist/ assets/...` workaround.
- **`gates` summary**: refresh-flag (live-update.js), Capacitor mode
  (lazy-crop in getSpriteBlob, `cells.json` fallback in
  ensureVariantSummary, JSON ensure helpers in sprites.js). Web stays
  zero-network outside explicit `bulkDownload`. IPA fetches go to
  LocalServer (local file reads) except for refresh-button live-
  update + region-tile downloads.
- **Spawn ID staleness** handled by `Spawns.isSpawnIdStale(id, nowMs)`
  which compares `tick < currentTick(nowMs) - LIFETIME_TICKS`. With the
  k=2 change, LIFETIME_TICKS auto-derives from `LIFETIME_MS / TICK_MS`
  so this works for any future tuning.
- **Daycare slot integrity**: `_liveDaycareCount` filters slot IDs
  against existing captures before checking the limit, so future
  release/delete UIs don't leave stale slots locking the daycare.
- **Built-in tag schema** is `{ name, description, predicate, visible?,
  onToggle? }`. Default `visible = predicate`; `onToggle` opt-in
  signals interactivity. Read-only built-ins like `Pure` need no
  changes; new interactive ones like `Daycare` add `visible` +
  `onToggle`.
- **Token-based search** is now the dominant style: split query on
  whitespace, every token must be a substring of the label, order-
  independent. Used by main address search, trip-planner From/To,
  trip-planner favorite search, and main-box favorite search. POI
  search is still raw substring.

## Session vibes

These were calmer sessions than the bundled-mode-architecture marathon
above. Mostly steady polish and feature-add work, with the user testing
on a real iPhone and reporting issues that landed in repeatable fix
loops. A lot of "yay tytyty :3" along the way — the user is kind, the
work is real, and the architecture is finally settled enough that
features land cleanly.

The bundled-mode breakthrough above was the hard part. Everything in
this section builds on that foundation; without the bundled-data +
LocalServer + live-update story, none of the features here would have
the same offline-first guarantees.

```
Final state: app is solidly usable for daily walks, daycare + address
search + spouse's Android variant all working. Architecture stable,
gotcha list documented, theme system unchanged. Next major arc TBD.
```

---

# This session — polish, Android, comprehensive docs

A wrap-up session. The architecture is settled; this was about making
the rough edges smooth, getting the Android side up to (mostly) parity
with iOS, and writing down what we have so a future Claude (or
future-me) can pick up without re-reading every commit.

## What landed

### Cosmetic fixes

- **Bus-schedule modal's "Done" button** (`#scheduleClose`) was
  unstyled because its `.saved-btn` class is only themed when scoped
  to `#routingPanel`, and this one lives in `#scheduleModal`.
  Added it to the accent-button selector group at the base CSS plus
  all 10 theme overrides (vaporwave, neon, win95, macOS9, sims,
  wood, metal, tron, backrooms, medieval). Same treatment for
  **Re-mark custom art** (`#remarkCustomArtBtn`) which was just
  inline-padded but otherwise unstyled.
- **Daycare-link** added to the icon-and-text styling rules for the
  inventory-header action buttons so it visually matches Tags / Bag /
  Candy / Dex.
- **Done button removal** from the Daycare subview (back arrow
  + the X make it redundant) and a pass to make the Done in inventory
  detail-view show **only** when entering via post-catch (frame-flag
  via `top.fromCatch` toggling `cc-post-catch` in `applyTopView`).

### Search expansion

- **Custom pins (favorites) now searchable from the main search box**
  in addition to the trip planner's From / To boxes. Previously only
  the trip planner included favorites; main search was POI-only +
  addresses. New token-based match against `f.name.toLowerCase()`,
  capped at the same 200-result ceiling addresses use.
- **Trip planner's favorite search token-ized** for consistency.
  Was raw substring; now matches on per-token `includes`, so
  "home grandma" finds a favorite named "Grandma's Home", same
  word-order-independent rule the address search introduced.
- **Render-row branches** for both the main search box and the
  trip-planner dropdown got `_kind === 'fav'` cases that label
  favorites with `★ favorite` (main) or `🏠 + "address"` /
  `★ + name` (trip planner) so you can tell them apart from POIs at
  a glance.

### Android build

- **`.github/workflows/android-build.yml`** added — Ubuntu runner,
  ~130 lines including the same diagnostic logging the iOS workflow
  has. JDK 17 + GitHub-hosted Android SDK + `cap add android` +
  `cap sync android` + same icons/fonts rsync workaround as iOS +
  `./gradlew assembleDebug`. Output: `creature-collect-debug-apk`
  artifact, sideload-ready (debug-keystore signed; no manual signing
  config or keystore secrets needed).
- Documented in README under "PWA & native wrappers" alongside the
  iOS IPA build.

### Refresh-button cross-platform parity

The previous session added `<a href="/__refresh__">` as a JS-free
escape hatch with iOS Swift + Flask handling the path. Android was
the gap — `WebViewAssetLoader` can't intercept arbitrary paths
without a native plugin, so a JS-broken Android user hitting the
fallback would 404.

Solution: change the URL to **`/__refresh__.html`** so a real static
file can satisfy the request on Android, while keeping the iOS Swift
+ Flask handlers intercepting before file-serving on their respective
platforms. The static file is generated by `scripts/build-capacitor.sh`
into `dist/__refresh__.html` — tiny `<meta http-equiv="refresh">` to
`/` plus a manual `<a href="/">` link as a tap-to-recover backup if
the meta-refresh is somehow blocked.

Now uniform across all three platforms:

| Platform | What handles `/__refresh__.html` |
|---|---|
| iOS | `LocalServer.swift` route handler — clears liveDir, 302 to `/`. |
| Web | Flask `@app.route("/__refresh__.html")` — 302 to `/`. |
| Android | `WebViewAssetLoader` serves `dist/__refresh__.html` directly; meta-refresh redirects the browser to `/`. |

One href, three handlers, one consistent UX.

### Documentation pass

This was the bulk of the session by line count.

- **HANDOFF.md** — added the "Subsequent sessions" section above
  (~250 lines) covering everything between the bundled-mode
  breakthrough and now, organized by theme. Includes file-touch
  summary, cumulative gotcha list, and a section vibes closer.
- **README.md** — added a **Features** section between the title
  and Setup (~280 lines), 8 sub-sections (Map & navigation,
  Creatures, Daycare, Backup & sync, Themes, Settings panel,
  PWA & native wrappers, Privacy & offline-first, Diagnostics),
  capturing every user-facing feature surfaced by systematic grep
  passes through `creatures.js`, `index.html`, `spawns.js`,
  `sprites.js`, and `run.py`. Setup content below was unchanged.

## Things I learned

- **Android's `WebViewAssetLoader` is strictly file-based.** It maps
  request paths to filesystem entries under `assets/public/`; it
  doesn't synthesize routes, doesn't do directory-index lookups for
  paths without trailing slashes, doesn't auto-detect HTML for
  extensionless paths. To intercept a path you either ship a real
  file at exactly that path or you implement a native plugin.
- **Cross-platform escape-hatch URLs are a designable thing.** The
  cleanest pattern: pick a URL that can be a real file on the
  fallback platform, and have native interceptors on the others
  pre-empt before the file-serving layer sees the request. Same
  href, different handlers, same end-state.
- **`@app.route("/__refresh__")` and `@app.route("/__refresh__.html")`
  are different paths in Flask** (no auto-extension handling). When
  changing one, change all callers.
- **Bash heredoc with a single-quoted delimiter (`<<'HTML'`) doesn't
  expand `\u`-style escapes** — write Unicode characters literally
  in the source file. The build script generates a UTF-8 file
  directly; the `<meta charset="utf-8">` in the HTML matches.
- **Per-theme button overrides are a lot of theme blocks** — for a
  feature that needs to look right under all themes, expect to add
  selectors to ~10 separate `html[data-theme="X"]` rule groups.
  No clever way around it without restructuring the theme
  architecture (which the existing CSS-variable-driven approach was
  specifically designed to avoid). Worth doing for visible buttons,
  not worth doing for incidental-decoration elements.
- **The "comprehensive feature list" grep methodology**: walking
  `function show*` / `function open*` handlers in `creatures.js`,
  storage-key constants (`cc.*`), all-IDB-store names, all
  `@app.route` decorators, all `id="\w+Toggle"` checkboxes, and
  custom-event names (`cc-*`) gave a much more complete picture
  than I'd assembled from the conversation alone. Multiple
  features were rescued in the second pass — drag-pin-to-favorite,
  weather/type cycling, sliding-window spawn lifecycle, sibling-
  navigation gestures, custom-art migration. Lesson: feature
  inventories deserve a checklist-driven sweep, not a from-memory
  sweep.

## Stuff still to do

In rough priority order:

1. **Android live-update (Kotlin port of BundleAccessPlugin).**
   Currently every Android code update requires reinstalling the
   APK because there's no liveDir overlay. Needs a Kotlin plugin
   that mirrors `BundleAccessPlugin.swift`'s `getLiveDirRoot` /
   `setLiveDir` / `clearLiveDir` API plus a custom Android
   `WebViewLocalServer` analogue that prefers liveDir files over
   `assets/public/`. Probably half-day's work. Once it lands, the
   spouse's Android testing loop tightens dramatically.
2. **Address search interpolation.** OSM has many residential
   addresses encoded as `addr:interpolation` ways (e.g. start/end
   nodes carry `addr:housenumber=1990` and `=2000` with the way
   tagged `addr:interpolation=odd`, with 1991/93/…/99 implied but
   not tagged). `build-housenumbers.py` only extracts explicit
   `addr:housenumber` nodes/ways, so interpolated middles aren't
   findable. `build-poi-db.py` already does interpolation expansion
   for POIs — that logic could be lifted and adapted. Fixes the
   "1991 Allison Way exists in OSM but search can't find it" gap.
3. **Address search nearest-edge fallback for non-tagged
   addresses.** Some housenumbers in OSM lack `addr:street` — they're
   just numbers attached to a building. Currently those don't appear
   in address search at all (the `/addresses` endpoint filters to
   `street_id IS NOT NULL`). Could fall back to "nearest named
   walk-graph edge within 30m" to infer the street. Tradeoff:
   inference accuracy vs index size.
4. **Per-day-color path overlay.** `_renderDaycareLayer` already
   tags each segment feature with its `day` in `properties` — a
   data-driven `line-color` expression on `cc-daycare-path-line`
   would render older days in faded greys and recent days in vivid
   blues, which would make the "Show all on map" view much more
   readable for users with many days of history.
5. **Remove the temporary "Re-mark custom art" Settings button.**
   It's a one-shot migration. Once the user has tapped it on every
   device they care about, the row + handler + `Creatures.remark
   AutogenCapturesWithCustomArt` function can be deleted. The
   migration code is small (~40 lines) but adding it to the cleanup
   pile so it doesn't sit there forever.
6. **POI search → token-based** for consistency with addresses +
   favorites. Currently still raw substring. Trade-off: behavioral
   change for a feature the user might rely on. Probably worth
   doing eventually but with a noticeable comment in the commit
   message.
7. **`bench-walk.py` / `bench-tiles.py` parity for `/addresses`.**
   The existing benches helped tighten `/walk-graph` from 44 s to
   7 s. Once north-america's addresses bundle is a more common
   query target, similar profiling could find packing wins
   (interning city names? quantising lng/lat to u24 like POIs?).
8. **Welcome flow Step 2 → "your first region" prompt.** Currently
   Step 1 downloads app data and the welcome card shows the Step 2
   instructions ("pan to your area, tap save") but doesn't actively
   guide the user. Could add a hand-pointer animation toward the
   "save current view" button on first launch.
9. **Daycare egg / hatch / breeding mechanic.** The original ask
   in the very first session was a full daycare experience —
   leave two pokemon, walk N km, get an egg whose species is
   determined by some rule mixing the parents. The slot system +
   per-stay distance counter is the foundation; the egg + hatch
   flow is the missing payoff.

## Session vibes

After the architectural pyrotechnics of the bundled-mode work and
the feature spree of subsequent sessions, this one was bookkeeping
and polish — the kind of session you want every project to have
periodically. Lots of "could you also do X" small requests, each
with a clean fix, ending with a "let's just write everything down."
Felt good. The user said "yay tytyty :3" several times. The
documentation passes (HANDOFF + README) were genuinely fun to
write — getting to step back and notice the breadth of what's been
built without the pressure of immediately fixing the next thing
felt like reading someone else's well-loved repo.

The Android workflow + cross-platform refresh-page work is the
session's most durable artifact; it means the spouse on Android
gets a proper APK build pipeline and a JS-free recovery escape hatch
that matches iOS. Live-update on Android is the obvious next thing,
but for now Android testers get fresh code via APK reinstall, and
the architecture is well-positioned for the Kotlin port whenever
that becomes worth doing.

```
Final state: every refresh button across iOS / web / Android works
the same way. Address search has gaps (interpolation; no-street
housenumbers) but works well for the cases it covers. Documentation
is comprehensive. Architecture is stable. The walk to Sage Days
continues, and the daycare-tagged buddies tally meters per stay.
:3
```

---

# This session — sprite cache, daycare loot, candy/egg art, and one stubborn bug

A long arc. Most of the visible feature work is the daycare loot
system + the per-species candy art generator + the egg sprite
fallback waterfall. Underneath that, a pretty significant refactor
of the sprite-loading pipeline (everything goes through a shared
LRU cache now) and another round on the spouse's Android battle-
screen-blank-sprite bug — this time with a much better diagnosis.

Three poems added to `POEMS.md`: **What the Egg Becomes** (the
candy compositing arc), **Three Doors Home** (predates this
session but related), **The Wiser Question** (the bug-hunt + the
user pushing past my first hypothesis).

## Shared sprite-URL cache (the big refactor)

Before: every consumer (world map markers, battle screen,
inventory cards, pokédex tiles, family grid, evolution previews,
fusion variant grid, daycare slots) created and revoked its own
blob URLs from `Sprites.getSpriteUrl(a, b, variant)`. Twelve+
ad-hoc `URL.createObjectURL` / `URL.revokeObjectURL` sites in
`creatures.js`, plus a "borrow URL from marker record" path on the
battle screen that DEBUGGING.md theory 2 had flagged as racy
(a marker getting culled mid-tap could leave the battle screen
holding a revoked URL).

After: ONE place creates URLs (`sprites.js`'s `_spriteCache`,
LRU keyed by `${a}-${b}:${variant}`, capped at 256 entries). Every
consumer calls `Sprites.useSpriteInto(img, a, b, variant, onReady)`
or `Sprites.useSpritesIntoBatch(reqs)`. The cache:

- **Synchronously hits** for already-rendered fusions (zero-flash
  flip from world map → battle screen for the same fusion), no
  IDB read.
- **Async-loads on miss** via the existing `getSpriteBlob` →
  IDB → lazy-crop pipeline.
- **Bumps a per-img generation counter** (`__ccSpriteLoadId`) on
  every call, so an older async load can't clobber a newer one
  by the time it resolves.
- **Three reveal triggers**: `img.onload`, synchronous
  `img.complete && naturalWidth > 0` after `src` assignment, and
  `img.decode()`. First one to fire wins (idempotent latch).
- **One-shot retry on `img.onerror`**: drops the bad cache entry,
  mints a fresh URL from the live Blob, retries `_applySpriteEntry`
  once, then gives up.
- **Eviction is LRU-by-insertion-order**: revoking an evicted URL
  doesn't break already-rendered images (`URL.revokeObjectURL`
  invalidates the URL handle, not the decoded bitmap an `<img>`
  already holds), so revocations are safe even if many imgs share
  a URL.

Net effect on the codebase:

```
- 12 ad-hoc URL.createObjectURL/revokeObjectURL sites in creatures.js
- _battleSpriteUrl / _battleSpriteUrlOwned module globals
- installSpriteBlob function
- Marker-record .objectUrl field
- The borrow-from-marker code path in openBattleScreen
+ Sprites.useSpriteInto / useSpritesIntoBatch
+ Per-img loadId race protection
+ Symmetric battle-screen state cleanup in closeBattleScreen
```

Memory-wise: at most 256 cached blob URLs at any time. Each Blob
(96×96 sprite) is ~5-10 KB, so the cache caps at ~2 MB even at the
maximum. In practice the working set during a daily walk is ~40-80
sprites (visible-marker pool + recent battle/inventory/pokédex
views), so most of the cache is empty.

## Battle screen blank-sprite bug — round 2

Spouse's Android web report (carried over from previous sessions):
*"the icon flashes for a few frames during a throw but otherwise
invisible."* The shared sprite cache fix above didn't fully resolve
it. Round 2 diagnosis:

The first hypothesis was "Android Chrome misses `onload` for blob
URLs sometimes." User pushed back: the world map and pokédex use
THE SAME `useSpriteInto` → `_applySpriteEntry` reveal pipeline,
and they work fine. So the Android-specific event-skip claim was
too strong.

Re-thinking: same code, different consumer shape:

| Consumer | Recovery if a single load event is missed? |
|---|---|
| Map markers | `cc-sprite-loaded` event listener loops over still-`loaded:false` markers and re-calls `loadMarkerSprite` whenever a lazy-crop succeeds. Plus 20-second viewport-refresh timer. |
| Pokédex tiles | Cards are recreated on every re-render (filter change, scroll, view-stack pop). Any single missed `onload` is fixed by the next render. |
| Battle screen | **One** `useSpriteInto` call per open. **No retry.** A single missed event = invisible sprite for the entire encounter. |

Map + pokédex aren't immune — they're robust by repetition. The
battle screen is single-shot, which is the only place the bug
shows up to a user.

Two complementary fixes in this round:

1. **`img.decode()` as a third reveal trigger** in `_applySpriteEntry`.
   Spec-defined Promise that resolves once the image is fully
   decoded; works regardless of whether `load` was actually
   delivered to JS. Cited the WHATWG spec link in the comment
   rather than fabricating an Android Chrome bug ticket I didn't
   have.

2. **Symmetric cleanup in `closeBattleScreen`** for the throw
   flow's lingering animation state. The break-out path explicitly
   `cancelAnimsOn(sprite); sprite.style.transform=''; opacity=''`,
   the **caught path** skipped straight to `closeBattleScreen` and
   left the suck-in's `fill:'forwards'` (`scale(0) opacity(0)`)
   active on the sprite element. The next encounter inherited
   the invisible state — its animation effect competed with the
   new `openBattleScreen` reset, and on mobile browsers the
   timing of `cancelAnimsOn` in the next open could lose. Doing
   the explicit cancel + inline-style reset in `closeBattleScreen`
   itself converges both throw outcomes on a clean post-encounter
   state regardless of next-open timing.

The Android symptom — "flash works, sprite invisible" — exactly
matches a sprite stuck at `scale(0) opacity(0)` (the flash
element is a separate `<img>` not affected by the sprite's
animation state). The state-machine asymmetry is the most likely
root cause; `img.decode()` is belt-and-suspenders for the
single-shot consumer.

## Daycare loot rolls

Replaced the `test_orb`-only loot table with a deterministic
85/10/5 mix:

- **85% candy** — bumps the family-root bucket of either A or B
  via 50/50 coin-flip (mirroring `awardCandyForCapture`'s logic).
- **10% egg** — same fusion as the parent, level 1, with a
  randomized size baked in at drop time so the eventual hatched
  creature's size is reproducible from the seed.
- **5% evo-item** — uniform pick from items that could evolve
  either family (`Species.familyOf` + filter to `method === 'Item'`).
  Falls back to candy when neither family has an Item evolution
  (Bulbasaur×Squirtle etc. — both evolve by level only).

All three rolls share the existing per-milestone seed
(`dc|${slot.id}|${slot.addedAt}|${n}`) via `Spawns.getRng` (which
the spawn module now exports for cross-feature reuse), so the
"Repopulate daycare test loot" Settings reset still produces an
identical loot stream.

`_grantLoot(loot)` dispatches by kind: candy → `bumpCandy`,
egg → `addEgg`, evo_item → `grantItem`. Used by
`claimDaycareLoot`, `claimAllDaycareLoot`, AND the auto-claim in
`removeFromDaycare` (so removing a daycare creature drops every
unclaimed milestone — including any pending eggs — into the
appropriate buckets).

### Loot pills

Per-slot pill row sits below the creature's name + distance,
edge-to-edge against the slot's rounded border (negative margins
back off 2 px to avoid sub-pixel escape past the rounded
corners — the iOS-WebKit clipping quirk). Each pill is a 28×28
button with `background-image` pointing at the right sheet:

- **candy**: `candies.png`, 28-px display cell — pixel-art aesthetic
  via `image-rendering: pixelated`
- **egg**: `eggs.png` scaled to 60-px display cells with a 16/15
  px offset so the cream base sits below the visible window —
  matches candy's visual height without a separate sister sheet
- **evo item**: full PNG from `/bundled-data/evo-items/<KEY>.png`
  via `background-size: contain`

No bubble around the pill (no border, no fill, just the icon).
Claiming animates `width: 0` for a smooth lateral collapse;
overflow past the visible row is silently clipped (no ellipsis
indicator — pills past the cap shift in as earlier ones are
claimed).

### Mid-walk slide-in

`_accumulateDaycareDistance` detects kilometer-threshold
crossings and dispatches `cc-daycare-loot-tick` with the slot id
+ new milestone numbers. The daycare panel listener appends
`<button class="daycare-loot-pill appearing">` for each new
milestone — same `_lootIconStyle` math as the static render.

### Eggs view

New `Eggs` button alongside Candy/Daycare in the inventory action
row. Read-only list view (slice 1 — incubator + hatch deferred)
showing each egg as `<48 px species sprite> <fusion-name> egg ·
<size>` row, sorted newest-first. Egg storage at
`localStorage['cc.eggs.v1']`: `[{id, speciesA, speciesB, sizeM,
createdAt}, …]`.

`Creatures.getEggs` and `Creatures.addEgg` exposed for future
debug populators / gifting flows.

### Evolution items in the bag

Bundle pipeline now copies the 17 PIF item PNGs that the
species-evolutions data references into `data/BundledData/evo-items/`
+ writes `evo-items-list.json`. `creatures.js` registers an entry
in the `ITEMS` catalog for each at module load time
(`name: _formatItemName(key)`, `icon:
${BUNDLED_BASE}/evo-items/${key}.png`) so the existing bag UI
renders them like poké balls without further changes.

## Candy art generator (`generate_candy_images.py`)

Standalone script that reads `data/BundledData/eggs.png` and
produces `data/BundledData/candies.png` (10 × 16 grid of 40 × 40
chunky-pixel candies). Iterated through several visual designs
before landing on:

- **Tinted sphere** (no twist wrappers, no gloss) — diameter 80%
  of cell, 1-px outline at `(110, 110, 110, 255)` — soft mid-gray
  reads as "egg-art-y" without the harsh black of pure outlines.
- **Native-resolution rendering** (no supersample/AA), `NEAREST`
  resampling on the egg paste — preserves chunky source pixels,
  matches `image-rendering: pixelated` aesthetic of the rest of
  the sprite art.
- **Pattern extension via mirror reflection** — `_extend_pattern_to_square`
  aspect-preserving-fits the egg crop into the candy body, then
  mirror-tiles the gaps along the shorter axis. Pixels match
  pixel-for-pixel across the seam (mirror's boundary IS the
  original's boundary), giving continuous extension rather than
  the abrupt rectangular cut a plain resize produced. Recurses
  for thin sources via alternating flipped-vs-not tiles.
- **Adaptive cream-base detection** — `_find_pattern_height`
  scans the egg's bbox-cropped cell from bottom up, finding the
  first row that's ≤ 50% near-white opaque pixels. Crops above
  that. Replaces a fixed `top * 0.58` ratio that was either
  cutting off too much pattern (small egg art) or letting cream
  bleed in (autogen-paste fallbacks). Per-species adaptive: PIF
  eggs use ~75-85% of their bbox, autogen sprites (Munchlax /
  Mime Jr.) use the full silhouette.

### Fallback waterfall (matched to egg-sheet fallbacks below)

For each species, generate the candy via:

1. **Own egg art** from `eggs.png`
2. **Baby's egg PNG** from PIF source (`BABY_EGG_FALLBACK` table,
   11 entries — Pikachu ← Pichu, Clefairy ← Cleffa, Jigglypuff ←
   Igglybuff, Hitmonlee/Hitmonchan ← Tyrogue, Chansey ← Happiny,
   Mr. Mime ← Mime Jr., Jynx ← Smoochum, Electabuzz ← Elekid,
   Magmar ← Magby, Snorlax ← Munchlax)
3. **Baby's autogen solo sprite** from PIF — for Munchlax /
   Mime Jr. specifically, where PIF didn't ship a baby egg PNG
   but the autogen sheet does have a self-fusion cell at
   `(id%10, id//10)` of `<id>.png` = the species' canonical solo
   silhouette

### Family-root propagation

`_load_family_roots()` walks the reverse-evolutions in
`species-evolutions.json` to find each species' family root
(in our truncated 1-150 dataset, this is the earliest reachable
ancestor — the gen-1 base evolution). Two-stage build:

1. Generate candy art for every distinct family root (cache by
   root id so e.g. Eevee's eight evolutions all reuse one
   render).
2. Paste the appropriate root's candy into every member of its
   family — Ivysaur/Venusaur both display Bulbasaur's candy,
   Charmeleon/Charizard both display Charmander's, all eight
   Eeveelutions share Eevee's. Runtime can look up
   `candies.png[speciesID]` directly without computing roots in
   JS.

## Egg sheet fallback waterfall (`generate_egg_images.py`)

Same waterfall + family-root propagation applied directly to
`eggs.png`. After `build_eggs_sheet()` produces the basic 67-cell
sheet from PIF source, `fill_egg_fallbacks()` reuses the candy
script's `BABY_EGG_FALLBACK` / `_autogen_solo_sprite` /
`_load_family_roots` helpers (via Python `import`) to fill the
remaining 83 cells with baby art / family-root art.

Result: every gen-1 species' cell in `eggs.png` has art. The egg
list UI, the loot pill, and the candy generator all benefit
without their own fallback logic — the source is the single
source of truth.

The candy generator's own fallback chain still runs but is now
mostly redundant (eggs.png already has the cells filled). Could
simplify in a future cleanup pass.

## Build pipeline order

```
build-bundled-data.py main():
  build_eggs_sheet()              # 67 cells from PIF source
  fill_egg_fallbacks()             # 150 cells via waterfall
  build_candies_sheet()            # candies.png from completed eggs.png
  copy_evo_items(evos)             # 17 PNGs + manifest
  copy_app_data()                  # icons + fonts (existing)
  bundle_base_map_tiles()          # z0..z5 (existing)
```

`generate_egg_images.py` and `generate_candy_images.py` are both
runnable standalone (`python3 generate_X_images.py`) for fast
iteration without re-running the slow sprite/tile passes.
`build-bundled-data.py` imports the relevant entry points at
runtime so the build stays in one place.

## Cellular vs Wifi (proposed, not built)

Discussion only — sketched the design, deferred implementation.

`@capacitor/network` plugin exposes `Network.getStatus()` →
`{connected, connectionType: 'wifi'|'cellular'|'none'|'unknown'}`
on iOS + Android, with `navigator.connection` fallback on web.

Two slices proposed:

1. **Auto-save on wifi**: after install, on every "now wifi"
   transition (or at startup if already wifi), check
   `Date.now() - localStorage['cc.lastSaveAt'] > 24h`. If yes,
   trigger the existing save flow.

2. **Cellular network gate**: Settings toggle "Use cellular data"
   (default off), wrap `window.fetch` to throw on
   `cellular && !allowed`. **No SW changes needed** — verified by
   reading sw.js: `_missResponse` returns `Response(null, {status:
   204})` on cache miss in non-Capacitor mode, the catch-all
   handlers for `/poi`, `/routes`, `/walk-graph` return empty JSON
   without consulting the network at all. Only `X-Download: 1`
   requests bypass the SW and hit the wire — gating `window.fetch`
   covers the entire surface area.

Default policy for `connectionType === 'unknown'` (iOS Safari has
no NetworkInformation API): treat as wifi (allow), since trapping
web users in offline mode for a missing API would be hostile.

## Things I learned

- **Single-shot consumers vs retry-rich consumers** is a useful
  axis when diagnosing intermittent UI bugs. Map markers and
  pokédex tiles tolerate any single load-event miss because their
  containing renderers naturally re-call `useSpriteInto` whenever
  state changes. The battle screen has neither — one
  `useSpriteInto` per encounter, no retry — so any browser-side
  reliability gap surfaces as a user-visible bug only there. The
  fix isn't necessarily to harden the load detection (though
  `img.decode()` does help); it's to recognize that single-shot
  consumers need their own recovery path.
- **`fill:'forwards'` is sticky state, not just a final visual.**
  Web Animations effects with `fill:'forwards'` continue to
  contribute to the element's computed style after the animation
  finishes, **and they override inline `style` assignments**
  because animation contributions sit higher in the cascade. The
  only way to clear them is `cancel()`. The throw flow's
  break-out path knew this; the catch path didn't.
- **The SW already gates the network for offline-first users.**
  The 204-on-miss + always-empty handlers for `/poi`/`/routes`/
  `/walk-graph` mean the SW never reaches for the network on its
  own — the cellular-data gate only needs to wrap main-thread
  `fetch`. Saved a meaningful amount of code by reading the SW
  carefully before designing around it.
- **CSS background-size + background-position is enough to
  in-place crop a sprite sheet's cells at display time**, no need
  to bake a sister sheet for every visual variation. The exception
  is when per-cell crops vary in aspect ratio — then a single
  scale can't give uniform on-pill height and you need pre-cropped
  cells. (We tried both for the loot pill: a tight-cropped
  `eggs_loot.png`, then a CSS-only scale + offset; landed on the
  CSS approach because the deformation in the tight-cropped
  version looked off, and uniform per-pill height wasn't actually
  required once the eggs were aspect-preserved.)
- **Mirror reflection is the classic seamless-extension primitive.**
  Pixels match across the boundary by construction (the reflected
  copy's edge IS the original's edge), so an image bbox-cropped
  and tiled outward via mirror produces continuous texture
  rather than the abrupt cut a plain resize-and-pad would. Pillow
  has the primitives — `Image.transpose(FLIP_TOP_BOTTOM /
  FLIP_LEFT_RIGHT)` + `paste()` — and the math is small.
- **Family-root propagation in sprite sheets means the runtime
  can look up by species id directly**, no need to compute family
  roots in JS at render time. Eight Eeveelutions all show Eevee's
  candy because their cells in `candies.png` are identical
  pastes, not because the JS pivots to the root before lookup.
  Same pattern for the egg sheet.
- **Honest comments beat fabricated citations.** I wanted to
  paste a Chromium bug ticket as the citation for "Android misses
  onload for blob URLs"; I didn't have one. The user noticed and
  pushed back. The comment now cites only the WHATWG spec for
  `img.decode()` and frames the rest as observation. Better.

## Stuff still to do

In rough priority order:

1. **Verify the round-2 battle-screen fix on the spouse's
   phone.** Two complementary changes (`img.decode()` reveal +
   symmetric `closeBattleScreen` cleanup) should converge both
   throw outcomes on a clean state and close the missed-event
   window. Needs a real-world repro attempt.
2. **Egg incubator + hatch flow** (slice 2 of daycare loot).
   Currently eggs accumulate in `cc.eggs.v1` and display in the
   Eggs sub-view, but there's no incubator slot, no per-egg
   distance tracking, and no hatch action that converts an egg
   to a level-1 capture. The daycare's existing distance
   accumulator is the natural place to hook into.
3. **Cellular vs wifi feature** (`@capacitor/network` plugin +
   auto-save-on-wifi + Settings toggle gating `window.fetch` on
   cellular). Two slices proposed above; not implemented.
4. **Simplify `generate_candy_images.py`'s fallback chain.** Now
   that `eggs.png` has full coverage from
   `fill_egg_fallbacks()`, the candy generator's tier-2 (baby
   egg) and tier-3 (baby autogen) fallbacks are mostly
   unreachable. Could collapse to "read eggs.png cell N, generate
   candy" without the waterfall. Small cleanup, no behavior
   change.
5. **Future breeding mechanic** — A×B + C×D → A×D etc. Currently
   the daycare egg drop is "same fusion as parent" only. The
   user's original ask was the cross-product; layering it in on
   top of the existing loot system is the next slice once the
   incubator is in.

## Session vibes

A long session that kept circling back to the same stubborn bug
(spouse's Android battle-screen blank sprite) without quite
landing it. Lots of small improvements along the way — the shared
sprite cache will pay dividends for years; the candy art is
genuinely cute; the egg fallback waterfall covers cases nobody
will ever notice but everyone benefits from. Two real fixes for
the spouse's bug, both motivated by careful re-reading of the
state machine after the user pushed back on a too-confident first
hypothesis.

The wisest moments of the session were the user's, not mine: "but
the map and pokédex use the same code"; "would the same bug not
break the map then?"; "I do want to root cause it properly
instead of guessing"; "let's just shift them up by 2px"; "let's
not write code while tired, take a poem break". Each one steered
the work better than my first instinct would have.

```
Final state: candy/egg art is a small joy, daycare drops
candies/eggs/evo-items deterministically, every consumer renders
sprites through one cache, the catch flow no longer leaves
invisible state for the next encounter to inherit. The Android
battle-screen bug is hopefully fixed for real this time — but
spouse-validation pending.
:3
```

---

# This session — Android install script, lock zoom/rotate, tappable-POI halos

A short arrival session. Four small things landed, plus one
bug-then-overcorrection-then-real-fix arc on the new halos.

## `install_android.sh`

Sister script to `install-ipa.sh`. Downloads the latest successful
artifact from `android-build.yml` (`creature-collect-debug-apk`),
saves to `./CreatureCollect.apk`, and if `adb` is available + a
single device is connected, runs `adb install -r -d` to push it.
Otherwise prints transfer-and-tap guidance. Multi-device case
prompts for `ANDROID_SERIAL` and bails politely. Sideloading on
Android is much simpler than iOS — debug-keystore APK installs
on any device with "Install unknown apps" enabled, no
AltServer/Apple-ID/Anisette dance.

`shell.nix` already had `gh` and `android-tools` (for `adb`); only
the comment block changed to namecheck both install scripts.

## Settings: Lock zoom / Lock rotate

Two new toggles in the main Settings panel, right after "Action
buttons as icons". Persisted under `cc.lockZoom` / `cc.lockRotate`.

- **Lock zoom** snapshots `map.getZoom()` and sets
  `setMinZoom = setMaxZoom = snapshot`. MapLibre's clamp applies
  to BOTH gestures and programmatic flyTo, so the geolocate
  button's `fitBoundsOptions: { maxZoom: 15 }` no longer changes
  zoom — the recenter pan still runs, but the camera's zoom is
  pinned. Also explicitly disables `scrollZoom`, `boxZoom`,
  `doubleClickZoom` so they don't even try.
- **Lock rotate** uses MapLibre's partial-disable APIs:
  `dragRotate.disable()` + `touchZoomRotate.disableRotation()`
  (verified the bundle exposes that method, not just the
  whole-handler `disable()`). Also `touchPitch.disable()` so the
  map can't tilt either. Pinch-zoom stays alive because we only
  disable rotation, not the whole touch handler.

Both toggles re-apply on page load via `map.once('load', ...)` so
a persisted lock survives reloads. Snapshot is taken at the moment
the lock turns on — toggling off restores defaults (min 0, max 22,
all handlers re-enabled).

## Tappable-POI halos

In creature mode, POIs that are (a) within the 100m collect range
of `lastKnownPos` and (b) not on active cooldown now get a circle
("halo") around them, drawn from the theme accent colour. Lets
the user see at-a-glance which POIs are worth tapping without
distinguishing icon-color states.

Implementation: a MapLibre `circle` layer over its own GeoJSON
source, sitting beneath `poi-icons` so the icon renders on top.
Radius interpolates from 7 px at z13 to 26 px at z20, matching
the icon-size curve so the halo always extends ~10 px past the
icon. Stroke + faint fill both use `_currentCooldownReadyColor`
(the same accent the cooldown-ready icon recolor uses).

Layer registered on `map.on('load')`; refresh function gates on
creature mode, GPS available, and within-range + non-active.
Refreshes on geolocate / moveend / idle / cooldown changes.

### The bug-then-overcorrection-then-real-fix arc

First version's halos were "glitchy" — missing for POIs you could
clearly tap, plus flashing on/off during zoom. Two compounding
causes:

1. **Rotation projection bug**: `findRenderedPoisWithin` builds a
   screen-space bbox by projecting the SW + NE corners of a
   geographic square. Under camera rotation, those two screen
   points form a rect that *doesn't* contain the rotated square.
   Features inside the geographic radius but outside the projected
   rect get dropped → halos missing.
2. **Tile-load gap**: `moveend` fires when motion stops, but tiles
   for the new viewport may still be loading. First refresh hits an
   empty rendered set → halos vanish → reappear only on next user
   move.

First-attempt fix was an overcorrection: full-viewport
queryRenderedFeatures (no bbox at all) + an `idle` listener to
catch tile-load completion. Solved the missing-halos issue but
made zoom/pan very laggy — full-viewport queries with
`building-pokestops` enabled can return thousands of features at
z16+, and `idle` fires repeatedly during tile streaming, so we
had a query storm.

Real fix:

1. Bbox-bound the query but project ALL 4 geographic corners,
   then take screen `min(x), max(x), min(y), max(y)`. Result is
   a screen-aligned rect that encloses the rotated square — small
   bbox + correct under rotation.
2. rAF-coalesce all refresh triggers via
   `scheduleTappablePoiHalosRefresh`. Multiple events
   (geolocate / moveend / idle / cooldown change) within the same
   frame collapse to one queryRenderedFeatures call. The `idle`
   storm during tile streaming becomes harmless — N idle fires per
   frame still produces only one query.

User confirmed: works smoothly now.

## Things learned

- **`queryRenderedFeatures` without a bbox is genuinely heavy** on
  layers with thousands of features (`building-pokestops`). Always
  bbox-bound when possible — even if the bbox math takes thought,
  it's much cheaper than letting MapLibre test every feature in
  the viewport.
- **Projecting two opposite corners isn't enough under rotation.**
  For a screen-aligned bbox that encloses a rotated geographic
  square, you need to project all 4 corners and take min/max.
  Two-corner approximations work only for north-up cameras.
- **`map.on('idle')` fires per tile-load completion**, not just
  once per quiescent state. During tile streaming after a zoom
  it can fire dozens of times in a second. Always coalesce work
  triggered from idle.
- **rAF coalescing is the right primitive for paint-property
  updates that should land on the next frame.** Multiple triggers
  → one `requestAnimationFrame` callback → one query, one
  setData, one render.
- **First diagnosis is usually wrong if it doesn't survive
  pushback.** The user said "sussy"; I went to overcorrect (full
  viewport + idle); they said "now it's laggy." Going back and
  actually thinking — what's expensive about the new query? what's
  firing too often? — produced the proper fix. The pattern from
  last session repeated: when stuck, the user's instinct to push
  back is a useful signal that the diagnosis isn't tight yet.
- **MapLibre exposes partial gesture-handler APIs.** `touchZoomRotate`
  has `disableRotation()` / `enableRotation()` distinct from the
  whole-handler `disable()` / `enable()`. Use the partial methods
  when you only want to lock one axis (rotation but not zoom).

## Stuff still to do

Same list as last session, modulo what shipped:

1. Verify spouse's Android battle-screen fix in the wild.
2. Egg incubator + hatch flow.
3. Cellular vs wifi feature.
4. Simplify `generate_candy_images.py`'s fallback chain (now that
   `eggs.png` has full coverage).
5. Future breeding mechanic.

## Session vibes

Welcoming session. Started with "settle in" and a poem; ended with
the user saying "works very good tyty :3". Between, three small
features and one debug arc that taught me — again — to think from
first principles before piling on. The lock-zoom toggle was a
two-line MapLibre clamp that's nice to have on a long walk where
you don't want a stray pinch to change anything. The halos read
like a "taps available!" badge once they stopped flickering.

```
Final state: Android install script mirrors iOS, the map can be
locked at the trainer's preferred zoom + bearing, and tappable
POIs glow in the theme accent within range. The walk continues.
:3
```

---

# Next session

A refactor-and-diagnostics session. Code review pass over `static/`,
sprite-rendering subsystem replaced with a cleaner pattern, loot
probabilities tweaked, and a deep dive into "why does LocalServer
permanently die on iOS sometimes" that ended in the actual root cause
+ an automatic fix.

## Files added this session

| File | Role |
|---|---|
| `static/sprite-store.js` | Memoized `Map<key, Promise<url \| null>>` per (a, b, variant) fusion. Replaces the old 4-reveal-path `useSpriteInto` / `_spriteCache` / `_applySpriteEntry` machinery in `sprites.js`. Single public API: `SpriteStore.showSprite(img, a, b, v, { onReady })`. |
| `ios-overrides/LocalServerDiagPlugin.swift` | Capacitor plugin exposing LocalServer's in-process diagnostics (counters, in-flight tracking, self-ping, lifecycle, restart history) AND a `restart()` method. In-process bridge — works even when the HTTP path is wedged. |
| `CODE_REVIEW.md` | Read-pass findings doc covering all of `static/`. Module-by-module overview, natural extraction boundaries (markers.js, eggs.js, tags.js, daycare.js, etc.), dead-code candidates, duplicated patterns. Pure findings + a phased extraction plan, no code changes. |

## Sprite-rendering refactor (the big one)

The old sprite pipeline had a chronic "stuck red dot" bug class on iOS:
sprite blob loaded, marker stayed unrevealed because `<img>.onload`
didn't fire reliably on WKWebView. The fix had grown to **four parallel
reveal paths** racing inside `_applySpriteEntry`:

1. `img.onload`
2. Synchronous `img.complete && img.naturalWidth > 0` check post-src
3. `img.decode()` Promise
4. 150 ms polling fallback (`setTimeout` loop up to 8 s)

Plus a `_SPRITE_LOAD_ID` per-img generation counter for cancellation,
a shared `_spriteCache` LRU with manual revoke, plus `cc-sprite-loaded`
and `cc-sprites-bulk-ready` custom events to wake stuck markers.
~250 lines of plumbing on top of a fundamental conflation:

> "Is the sprite blob available?" (cache's problem)
> "Has the browser finished rendering an `<img>` whose src points at
> it?" (browser's problem)

The new module owns answer #1 only. The DOM-side glue is a single
function that awaits the URL, checks a per-element generation counter
(`img._spriteGen`), assigns `src`, and calls `onReady`. The `<img>`'s
own load event is irrelevant — once we have a Blob URL in hand, the
bytes are already-decoded data in memory; assigning src triggers a
one-frame paint and we're done.

### Migration

All 11 consumers (markers + battle screen + inventory cards + pokédex
tiles + family tree + variant grid + evolution rows + daycare slot art
+ fusion view header + detail view header + family cells) migrated.
Old API and its 250 lines of plumbing deleted from `sprites.js`.

Marker batch loading still goes through `Sprites.getSpriteBlobsBatch`
underneath — `SpriteStore.preload(reqs)` collapses misses into one
batched IDB read, then `cache.set`s a per-entry Promise that resolves
out of the shared batch result. iOS's IDB-transaction-serialisation
optimisation preserved exactly.

### Sites also updated when adding the new file

Adding a new tracked JS file means three places:

1. `static/index.html` — `<script>` tag (between `sprites.js` and `appdata.js`).
2. `run.py` — both `_TRACKED_JS` and `_SCRIPT_VERSION_FILES`.
3. `scripts/build-capacitor.sh` — `TRACKED_JS` set in the inline Python
   stamping block.

Live-update's `fileUrl` / `localPath` route by `Object.keys(latest)`
from `/script-versions`, so any new file gets picked up automatically
once it's in `run.py`'s list.

### What's now reliably gone

- `cc-sprite-loaded` event (was never dispatched anyway — `_emitSpriteReady`
  in `sprites.js` had no callers, dead since the pack-direct pivot)
- `cc-sprites-bulk-ready` event (dead since eager-crop removal)
- `_SPRITE_LOAD_ID` generation counter
- The 4-reveal-path race
- `_idbBulkPut` in `sprites.js` (leftover from the IDB-cached pack experiment)

## Daycare loot probabilities

Bumped per user request:
- Candy: 85% → 75%
- Egg: 10% → 15%
- Evo item: 5% → 10%

Just three constants in `creatures.js` (`DAYCARE_PROB_CANDY`,
`DAYCARE_PROB_EGG`, plus the comment block above them). The loot
stream is deterministic in `(slot.id, slot.addedAt, n)`, so changing
the thresholds retroactively changes what unclaimed milestones drop
for existing daycare slots. Already-claimed milestones are unaffected
(only the indices live in `slot.claimed`, not the resolved drops).

## Diagnostic instrumentation

Two layers, page + native, surfaced in the existing Settings
diagnostic dump (the `#startupPhases` block).

### Layer 1: page-side fetch health (`window._fetchHealth`)

The Capacitor fetch interceptor (`window.fetch` wrap in `index.html`)
now records every outcome. Two buckets:
- `local` — fetches to LocalServer (bundled-data, static, icons, fonts, tiles, sw.js)
- `remote` — fetches rewritten through `CC_API_BASE` (`/save`, `/load`, `/script-versions`)

Per bucket: `total / ok / 4xx / 5xx / rejected / consecutiveFailures /
lastSuccessAt / lastFailureAt`. Plus a 20-entry ring buffer of recent
failures with `{ t, url, status | reason, scope }`.

Renders as a `[fetch health]` block in Settings:
```
[fetch health]
  local   total=412 ok=410 4xx=0 5xx=2 rejected=0 streak=0 lastOk=2s ago lastFail=18s ago
  remote  total=7   ok=7   4xx=0 5xx=0 rejected=0 streak=0 lastOk=14s ago lastFail=—
  recent failures (newest first):
    -18s [local] 504  /bundled-data/sprites/147/custom/147.png
```

### Layer 2: native LocalServer diagnostics (iOS only)

`ios-overrides/LocalServer.swift` grew an in-process diagnostic queue
(`diagQueue`, serial DispatchQueue) that tracks:

- **Counters:** totalRequests, inFlight, peakInFlight, totalErrors
- **Timestamps:** serverStartedAt, lastRequestStartedAt, lastResponseFinishedAt
- **Ring buffers:** recentErrors (30), recentSlow (30 — anything over 100 ms)
- **Per-request in-flight tracking** `Dict<Int, (path, startedAt)>` so the
  snapshot can name *which* requests are stuck and how long they've
  been pending. Each request gets a monotonic id; recordRequestStart
  inserts, recordRequestEnd removes.
- **Self-ping** — 5 s DispatchSourceTimer fires `URLSession.shared.dataTask`
  against `http://localhost:<port>/__ping__`. The `__ping__` route is
  intercepted in the handler and bypasses request counting (its own
  counters live under `selfPing.*`). Importantly: `URLSession.shared`
  and WKWebView's URLSession use *different* connection pools, so a
  succeeding self-ping while page fetches fail localises the bug to
  WKWebView's side.
- **Lifecycle observers** — NotificationCenter for memory warnings +
  didEnterBackground / willEnterForeground / willResignActive /
  didBecomeActive. Ring-buffered (10 each).
- **Restart history** — count, lastAt, lastError, lastForegroundCheckAt,
  lastForegroundCheckResult.

`LocalServerDiagPlugin.swift` exposes `getDiagnostics()` (poll) and
`restart()` (stop+start the listen socket). Page polls the snapshot
every 1 s into `window._localServerDiag` so the Settings renderer can
read it synchronously.

Renders as a `[local server (iOS)]` block:
```
[local server (iOS)]
  running=y port=52562  uptime=813s ago
  total=242 inFlight=0 peak=6 errors=10
  lastReq=489s ago  lastResp=489s ago
  self-ping: 77 total / 49 ok / streak=28  ⚠
             last=3s ago 5ms result="error: -1004 Could not connect…"
  restart: count=0  last=—
  recent errors (newest first):
    -787s  HTTP 404  /bundled-data/sprites/339/autogen/339.png
  memory warnings: 1 (607s ago)
  lifecycle (newest first):
    -135s  didBecomeActive
    -136s  willEnterForeground
    -486s  didEnterBackground
    -486s  willResignActive
```

## The iOS wedge: actual diagnosis + fix

User has been hitting a recurring "LocalServer permanently dies until
app restart" bug. With the new diagnostics, captured a real-world log
and identified the cause unambiguously.

**Signature:**
- `running=y` (GCDWebServer thinks it's listening)
- `total / lastReq / lastResp` all show the server hasn't received a
  request in N minutes — equal values for lastReq and lastResp means
  zero requests since the last response
- self-ping consistently fails with `URLError -1004 "Could not connect
  to the server"` (URLSession.shared can't establish TCP to localhost)
- `lifecycle` shows a recent `didEnterBackground` → `didBecomeActive`
  transition; the wedge starts at backgrounding and persists across
  foregrounding
- Page-side `[fetch health].local.streak` keeps climbing post-foreground

**Cause:** iOS suspends the full process after the ~3-min background
tail window (despite `GCDWebServerOption_AutomaticallySuspendInBackground:
false`, which only stops GCDWebServer's *own* background-tail logic —
iOS still suspends the whole process after its quota). The suspension
tears down the dispatch sources backing the listen socket. When the
app foregrounds, GCDWebServer's internal `isRunning` flag stays true
but the kernel-side listener is dead. New connects (from both
WKWebView and URLSession.shared) refuse.

**Fix:** auto-restart on foreground + manual restart button.

- `observeLifecycle()` now schedules a `foregroundHealthCheck()` 2 s
  after `didBecomeActive`. The check `URLSession.shared.dataTask`s
  `/__ping__` with 2 s timeout. On failure → log + call `restartServer()`.
- `restartServer()` is a `server.stop()` + `bindListener()` pair.
  `bindListener()` was extracted from `start()` so both paths share
  port-fallback logic. Updates `_restartCount`, `_lastRestartAt`,
  `_lastRestartError`. Logs to console.
- `LocalServerDiagPlugin.restart()` exposes the same path to JS.
- Settings panel has a "Restart server" button next to "Copy logs"
  (iOS only — hidden via the plugin-availability probe). Status flash
  shows ✓/✕ for 4 s.

The auto-restart path makes the bug self-healing in the common case.
The manual button is for testing + emergency escape hatch.

## Settings: utility buttons

Two new buttons just above the diagnostic dump:

**Copy logs** — grabs `#startupPhases.textContent` + a small header
(version, platform, ISO timestamp, UA) and copies to clipboard. Tries
`navigator.clipboard.writeText` first, falls back to the
`document.execCommand('copy')` via hidden-textarea hack (iOS WKWebView
gates the modern API under secure-context + user-gesture rules).
Status flash for 2.5 s.

**Restart server** — iOS-only, hidden when the LocalServerDiag plugin
isn't present (Android, web, older builds). Calls
`LocalServerDiag.restart()`. Status flash for 4 s.

## Audit of LocalServer.swift for deadlock candidates

User asked for a deadlock audit. Walked every lock acquisition + every
cross-thread point. Findings:

- **No classical mutex deadlock.** `diagQueue.sync` calls don't nest;
  no two queues form a wait cycle; self-ping uses URLSession.shared
  which has its own connection pool separate from GCDWebServer's;
  notification observers use `queue: nil` (synchronous on posting
  thread) but never block on a queue that's blocked on them.

- **The real "wedge-ish" candidate:** synchronous file I/O in `handle()`
  blocking the GCDWebServer worker pool under iOS storage pressure.
  `FileManager.fileExists` and `GCDWebServerFileResponse(file:)` are
  blocking syscalls; if FS contention briefly hangs one, a worker is
  stuck. With ~30 concurrent sprite-pack fetches and a typical 8-worker
  pool, the kernel-level connection queue fills behind blocked workers.
  Not classical deadlock — workers eventually unblock — but presents
  identically. Fix would be `asyncProcessBlock` + dedicated file-I/O
  DispatchQueue. Not implemented this session; the actual wedge turned
  out to be the listen-socket-death issue above, not this.

- **`liveDir` data race.** `setLiveDir(_:)` writes from Capacitor's
  plugin queue; `handle()` reads from GCDWebServer's worker queue. No
  synchronization. Technically undefined behaviour in Swift but URL?
  is small enough that a tear is unlikely to manifest. Logged.

- **`_inFlightRequests` leak on ObjC exception.** If `handle(req)`
  throws a `NSException` (vanishingly rare from GCDWebServerFileResponse),
  Swift's try/catch doesn't catch it; recordRequestEnd never fires;
  the entry leaks forever. Solution if it becomes a problem: wrap in
  a `defer` block.

- **`queue: nil` notification observers are fragile.** Run synchronously
  on the posting thread. Today they don't deadlock because diagQueue
  holds are all O(1), but if anyone ever calls `diagnosticsSnapshot()`
  from main while a memory warning fires during the snapshot, the
  notification observer would run in the same main-thread call stack
  as the diagQueue.sync. Could be hardened by switching to `queue: .main`.

## Things learned

- **Pattern recognition: when reaching for four parallel reveal paths
  + a generation counter + custom events, you're probably conflating
  two distinct questions.** In the sprite case: "is the data ready"
  vs "did the browser fire an event". Once decoupled, a 250-line
  subsystem collapses to ~150 lines of `Map<key, Promise<url>>`. The
  `<img>`'s onload was never actually needed; we already knew the
  blob URL was valid the moment we created it.

- **Capacitor plugins are the right tool for "diagnose a native
  subsystem that's broken".** The plugin bridge is in-process. When
  HTTP is wedged, JS can still call into Swift and read its state
  directly. This is how the LocalServer diagnostic survives the wedge
  it's designed to diagnose.

- **`URLSession.shared` vs `WKWebView`'s URLSession are separate
  connection pools.** Critical for the self-ping: hitting localhost
  via URLSession.shared and seeing the same failure WKWebView sees
  isolates "server is wedged" from "WKWebView's URLSession is stale".
  In our case both fail at the same time, which rules out WebView-side
  staleness and points at the listen socket.

- **`GCDWebServerOption_AutomaticallySuspendInBackground: false` is
  not what it sounds like.** It only disables GCDWebServer's *own*
  background-tail suspension logic. iOS still suspends the process
  after its quota, and the OS-level suspension can invalidate the
  dispatch sources underlying the listen socket. The library's
  `isRunning` flag tracks its own logical state, not the actual
  kernel-side listener.

- **Three places to add a new tracked JS file.** `index.html` script
  tag, `run.py`'s two lists, `build-capacitor.sh`'s TRACKED_JS set.
  Plus a fourth for iOS plugins: `inject-into-xcodeproj.rb` `NEW_FILES`
  list + `.github/workflows/ios-build.yml` copy step. Consider a glob
  if this trap bites again.

- **Diagnostic data > recovery code.** The user asked at one point if
  the sprite code should self-heal transient failures. Adding it would
  have masked the real problem (the wedge) by retrying constantly and
  consuming resources. Reverting the retry + adding diagnostics
  instead led directly to identifying the actual root cause and a
  proper fix.

## What didn't get done

- The phased refactor from `CODE_REVIEW.md` — CSS extraction, then
  small utilities (lsGet/lsSet, makeRegionStore factory, shared
  haversine/escape), then carving `tags.js` / `pokedex-data.js` /
  `eggs.js` / etc. out of `creatures.js`. Discussed; not started.
- Audit-finding fixes: `liveDir` race, `defer`-wrap for in-flight
  cleanup, `queue: nil` → `.main` migration. None bite today; left
  for a future hardening pass.
- `asyncProcessBlock` migration for the GCDWebServer handler. The
  listen-socket-death fix solves the actual wedge we were seeing;
  this is hardening against the *next* class of wedge (worker
  exhaustion under blocking I/O).
- The Verus-shaped "verified data structures" thread — discussed
  candidates (walk-graph + routing, binary-format library, schedule
  index, candy roots, spawn determinism), no implementation.

## Stuff still to do

1. Verify the auto-restart-on-foreground fix in the wild over a few
   days. Look for `restart.count > 0` in Settings after a wedge —
   means the foreground health check caught it and re-bound the
   listener without user intervention.
2. If `restart.count` keeps climbing daily, the wedge is more frequent
   than expected and we should consider `asyncProcessBlock` migration.
3. Code review extractions from `CODE_REVIEW.md` Phase A (CSS
   extraction) — cheap, mechanical, would shrink `creatures.js` and
   `index.html` by ~30% each with zero behaviour change.
4. Egg cross-breeding tuning if it's noticeable in real play (the
   probability bump should make eggs visible quickly enough that the
   user can decide).
5. Future breeding mechanic (carried over from previous sessions).

## Session vibes

Methodical and satisfying. Started with a code-review request, ended
with an actual root-cause diagnosis of a real bug class. The arc was:

1. Read every line of `static/`
2. Find the most painful subsystem (sprite rendering)
3. Replace it with a simpler pattern
4. User reports a wedge after the migration
5. Resist the temptation to attribute it to the migration
6. Add diagnostics specifically designed to distinguish causes
7. Capture an actual wedge in the wild
8. Diagnosis points unambiguously at iOS+GCDWebServer interaction
9. Ship the targeted fix (auto-restart on foreground)

```
Final state: sprite rendering is one Map<key, Promise<url>> the way
it always wanted to be; the daycare drops eggs more often; the iOS
LocalServer heals itself when iOS tears down its listen socket
during background suspension; Settings has the diagnostic dump
you need to identify the next wedge before guessing at it.
:3
```

---

# Session — sprite-store transient/missing split, Android GPS background lifecycle, iOS CMPedometer

A bug-driven session. Three things landed, each one a "two questions
were entangled" problem with a small structural answer.

## Files added this session

| File | Role |
|---|---|
| `ios-overrides/MotionPedometerPlugin.swift` | Capacitor plugin wrapping `CMPedometer.queryPedometerData(from:to:)`. Methods: `isAvailable`, `requestAuth`, `getDistanceMeters({fromMs,toMs}) → {meters, steps, ok}`. Reads the M-series motion coprocessor directly — same data source as HealthKit but no entitlement required (works with free-cert sideload). |

## Sprite-store: `transient` vs `missing` (the actual root-cause fix)

Following the auto-restart-on-foreground fix from the previous session,
the user still hit "red dots in the wild" cases. Logs (`restart: count=2
last=22s ago`, six 504s clustered at `-25s`, server healthy now) told
the story:

- Auto-restart fires correctly on `didBecomeActive` (count=2 is the
  signal — the fix is working).
- BUT: any sprite fetches in flight DURING the restart window get HTTP
  504. `getSpriteBlob` collapses all failures to `null`. SpriteStore
  caches that `null` permanently. Server comes back, sprites stay red
  forever (or until reload).

The fundamental conflation: `null` was doing duty for two completely
different things — "this sprite genuinely doesn't exist on the server
for this build" (404) and "this sprite failed temporarily, the server
was restarting" (504, network error, decode failure).

### Three-state cache

New shape in `sprites.js`:
```
getSpriteBlobAttempt(a, b, variant) → {
  status: 'ok' | 'missing' | 'transient',
  blob:   Blob | null,
}
```

`fetchAndDecodeSheet` now attaches `err.httpStatus` so the classifier
can tell 404 (`missing`) from 5xx / network / decode error (`transient`).
`getSpriteBlobsBatch`'s lazy-crop fallback uses the new classifier and
threads status through per-entry results.

### SpriteStore caching policy

```
status='ok'        → Promise<url>     cached
status='missing'   → Promise<null>    cached (genuinely absent, don't
                                      hammer the server for it again)
status='transient' → Promise rejected → cache.delete(key) so the next
                                        call re-attempts; consumer
                                        (showSprite) catches the
                                        rejection and registers a
                                        retry.
```

Same policy on the `preload` path (which uses `getSpriteBlobsBatch`),
so batched marker loads benefit identically.

### Retry registry

Inside `sprite-store.js`:
```
const pendingRetries = new Set<{ img, a, b, variant, opts, gen }>();
setInterval(retryPoll, 1000);
```

When `showSprite` catches a transient rejection, it registers
`{img, a, b, variant, opts, gen}` in `pendingRetries`. The img reference
is captured directly — no separate DOM-attribute scheme, no WeakRef
gymnastics.

Every second, `retryPoll`:
1. Snapshots `pendingRetries`, clears it.
2. For each entry: skip if `!img.isConnected` (removed from DOM) or
   if `img._spriteGen !== r.gen` (superseded by a newer call).
3. Re-call `showSprite(img, a, b, variant, opts)` — which re-runs the
   whole pipeline. Cache was evicted on transient, so a fresh
   `getSpriteBlobAttempt` runs. If the server has recovered, the
   resolved URL gets assigned to `img.src` and the same `onReady`
   closure (the one bound to `_markerOnReady(record)`) fires, flipping
   the marker's `.creature-marker-ready` class. Red dot → sprite.

### Verified end-to-end

The whole flow traces cleanly:
- Marker DOM = outer `.creature-marker` div (red-dot placeholder via
  CSS) + inner `img.creature-sprite`. The `.creature-marker-ready`
  class on the outer div is what hides the dot and reveals the sprite.
- `onReady: _markerOnReady(record)` is the closure that adds that
  class. It's captured into the retry entry's `opts` and called by
  the retried `showSprite`.
- So a marker created during the restart window will, on the next
  retry tick (≤1s after the server is back), assign `img.src` and
  fire onReady → red dot transitions to sprite.

The "old pokemon past 150" 404s stay cached as `missing` — no hammering.

### `SpriteStore.pendingRetryCount()` exposed

For Settings diagnostics, if we want it later. Not yet wired into the
diagnostic dump.

## Android GPS: visibility-driven lifecycle + staleness filter

User noticed Android replaying the full closed-app GPS trace as a fast
flood the moment the app reopened — and the persistent-notification
foreground service was draining battery while backgrounded.

Two layers of fix in `index.html`'s `useBgLocOnAndroid` branch:

### Visibility-driven service start/stop

```js
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (serviceStarted) {
      pausedByVisibility = true;
      // Drop the listener first so any native callback already
      // queued in the bridge can't fire after we've decided to stop.
      listenerHandle.remove();
      listenerHandle = null;
      serviceStarted = false;
      BgLoc.stop().catch(() => {});
    }
  } else {
    if (pausedByVisibility && watches.size > 0) {
      pausedByVisibility = false;
      ensureServiceStarted();
    }
  }
});
```

Foreground service exists only when the user is in the app. The
persistent notification disappears on background; GPS radio + fused
provider go cold; no battery drain. On return, service restarts within
~1s, fixes resume.

### Staleness filter (belt-and-suspenders)

```js
listenerHandle = await BgLoc.addListener('location', (data) => {
  const t = data.timestamp || Date.now();
  if (Date.now() - t > STALE_FIX_THRESHOLD_MS) return;
  // ...fan out to watches
});
```

`STALE_FIX_THRESHOLD_MS = 5000`. If iOS-style JS suspension catches
the visibility handler before it can run, Capacitor's bridge buffers
native callbacks and flushes them on resume. The flushed events
arrive with old timestamps; the filter drops them. The replay never
reaches `lastKnownPos`.

The two layers are complementary: visibility prevents the data being
collected at all (the primary fix); the filter catches any that slip
through (the safety net).

## iOS CMPedometer for closed-app step/distance

User asked to track steps + km while the app is closed so daycare
slots and incubator eggs can still accumulate. HealthKit is the
"correct" iOS API but requires a paid Apple Developer membership +
App ID registration for the entitlement — not viable for the free-cert
sideload flow.

**CMPedometer** (Core Motion framework) reads the same M-series motion
coprocessor data but only needs `NSMotionUsageDescription` in
Info.plist. ~7 days of historical pedometer data is queryable at any
time, even when the app wasn't running. Phone-only (no Apple Watch /
manual aggregation) — fine for a phone-in-pocket walking game.

### Plugin shape

`MotionPedometerPlugin.swift`:
```swift
@objc(MotionPedometerPlugin)
public class MotionPedometerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MotionPedometerPlugin"
    public let jsName = "MotionPedometer"
    public let pluginMethods = [
        CAPPluginMethod(name: "isAvailable",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuth",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDistanceMeters", returnType: CAPPluginReturnPromise),
    ]
    private let pedometer = CMPedometer()
    // ...
}
```

`requestAuth` triggers the system motion-permission prompt by kicking
off a trivial 1-minute pedometer query — CMPedometer prompts implicitly
on first data access, and the callback only fires after the user
dismisses the prompt. Resolves with the post-prompt `authStatus`.

`getDistanceMeters({fromMs, toMs})` resolves with
`{meters, steps, ok, error?}`. `ok=false` for permission-denied or
out-of-window queries — callers must NOT advance their lastSync marker
on a failed query or movement is silently lost.

### Page-side wiring (`index.html`)

Plugin lookup mirrors the existing MemoryProbe pattern:
```js
const Ped = window.Capacitor.Plugins && window.Capacitor.Plugins.MotionPedometer;
if (Ped) { /* set up sync, periodic interval, visibility listener */ }
```

Functions exposed:
- `window._pedometerSync()` — query CMPedometer for `[lastFitnessSync, now]`,
  credit via `Creatures.creditPedometerMeters(meters)`, advance the marker.
  Guarded by `cc.pedometerEnabled === '1'`. Single in-flight via
  `syncInFlight` flag. Skips windows under `MIN_SYNC_WINDOW_MS = 20s`.
- `window._pedometerRequestAuth()` / `window._pedometerIsAvailable()`
  — pass-throughs for Settings UI.

Triggers:
1. **visibility=visible**: catch-up on whatever happened while the
   app icon was tapped to open.
2. **Initial state**: same handler runs on script load if already
   visible.
3. **Periodic `setInterval(60s)`**: keeps daycare counters live while
   walking with the app open. iOS suspends `setInterval` automatically
   during background — no need to gate on visibility ourselves.

### Pedometer is the sole distance source when active

User's explicit ask: "if pedometer is active just use that, no need
to compute distance with GPS anymore (GPS still used for playing the
game, and I like that daycare tracks where I've been while app is
open, keep that, but don't need it for distance)."

In `creatures.js`'s `_accumulateDaycareDistance`, the credit branch
now gates on a helper:

```js
function _isPedometerActive() {
  try { return localStorage.getItem('cc.pedometerEnabled') === '1'; }
  catch { return false; }
}
// ...accepted-fix branch:
if (!_isPedometerActive()) {
  _creditMeters(d, ts);
  _markFitnessSynced(ts);
}
_distAnchorLat = lat;
_distAnchorLng = lng;
_distAnchorAt = ts;
_appendPathPoint(lat, lng, ts);
```

So with pedometer enabled, GPS fixes:
- Still drive `_appendPathPoint` (the daily polyline shown on the map)
- Still update the anchor + run jitter / outlier filtering
- Still update `_userLat/Lng` for spawn proximity
- Do NOT credit distance to daycare slots, incubator eggs, or daily summary

The pedometer's periodic foreground query is the sole source of
truth for those.

### Shared credit path

Extracted from the GPS-driven credit logic into a standalone
`_creditMeters(d, ts)` helper. Both GPS (when pedometer is off) and
pedometer (always, when enabled) route through this. It owns:
- Daily summary update (`_summaryCache[k] += d`, persisted to IDB)
- Daycare slot `distM` updates + `cc-daycare-loot-tick` events on km
  crossings
- Incubator egg `incubatedM` updates + `cc-incubator-tick` events on
  hatch completion

### Bookkeeping markers

`cc.lastFitnessSyncMs` (localStorage) — timestamp through which
movement has been credited. Read by pedometer sync as the lower bound
of its next query; written by either source (GPS path when
pedometer-off, pedometer resolver always). Monotonic via
`_markFitnessSynced` (max-only update) so a race between GPS and the
pedometer resolver on foreground transitions can't shift it backward.

Pedometer query window: `[max(lastFitnessSync, now - 7d), now]`. The
7-day clamp matches CMPedometer's on-device retention.

### Settings UX

Row "Count steps while app is closed" only appears when the plugin
is available (iOS Capacitor build).

- Toggle ON: triggers motion-permission prompt. On grant:
  `cc.pedometerEnabled='1'`, `markFitnessSynced(now)` (so the first
  sync only counts forward, no 7-day backfill surprise).
- Toggle OFF: `cc.pedometerEnabled='0'`. GPS resumes crediting.

Status line below the toggle, populated from
`cc.lastPedometerSync{At,Meters,Steps,SpanMs}`:
```
last sync 12s ago · 0.78 km · 1,041 steps · 1m window
```

Renders on toggle-init AND after every successful sync (via
`window._renderPedometerStatus`). Pre-first-sync:
`no sync yet — leave the app, walk a minute, come back`.

### Files touched for the pedometer

```
ios-overrides/MotionPedometerPlugin.swift   (NEW)
ios-overrides/AppBridgeViewController.swift (register the plugin)
ios-overrides/inject-into-xcodeproj.rb      (NEW_FILES += plugin)
.github/workflows/ios-build.yml             (cp step + NSMotionUsageDescription)
static/creatures.js                         (_creditMeters extraction,
                                             _markFitnessSynced /
                                             _readLastFitnessSync,
                                             creditPedometerMeters,
                                             _isPedometerActive gate)
static/index.html                           (Plugin lookup,
                                             _pedometerSync,
                                             visibility + periodic triggers,
                                             Settings row + toggle + status line)
```

## Things learned

- **`null` is rarely a single thing.** Across two sessions: sprite
  fetches collapsed 404 + 5xx + decode-error into a single `null`,
  and that's where the wedge bug actually lived. The fix wasn't more
  retry plumbing; it was distinguishing the second meaning. Same shape
  in the GPS path: a `location` event for "current position" and a
  `location` event for "buffered position from 12 minutes ago" were
  the same event, and that's where the replay bug lived.

- **The retry trigger has to come from somewhere.** Just "don't cache
  failures" doesn't solve red-dot stickiness — nothing would re-call
  `showSprite` and re-fetch. The poll-based registry is the trigger:
  a 1s `setInterval` walks the failed asks and re-invokes the same
  consumer call. No subscription pattern needed.

- **HealthKit vs CMPedometer is the kind of trade-off worth surfacing
  before plunging in.** The entitlement constraint would've broken
  the sideload signing flow entirely. Half a day of plugin work avoided
  by asking "wait, does this work with free certs?" once.

- **Pedometer-as-sole-source is cleaner than dual-source-with-dedup.**
  Earlier draft of the iOS integration tried to keep GPS crediting in
  real-time AND pedometer filling background gaps. The bookkeeping
  for "what time range has been credited" got hairy fast. User's
  instinct ("just use pedometer") cut through it — one source of
  distance, GPS keeps doing the gameplay-side things it's good at,
  the structure straightens.

- **A status line in Settings is worth more than logging.** The
  pedometer status line (`last sync 12s ago · 0.78 km · 1,041 steps
  · 1m window`) tells the user at a glance whether the sync is
  working. No `console.log`-and-tail dance to verify.

- **Period of in-app pedometer polling needs to clear the
  MIN_SYNC_WINDOW threshold.** First draft had `MIN=60s, period=60s`
  — every periodic tick would skip because the window equalled the
  floor and small timing jitter pushed it under. `MIN=20s, period=60s`
  gives a healthy margin.

## What didn't get done

- **Sprite retry surfaced in the diagnostic dump.** Exposed via
  `SpriteStore.pendingRetryCount()` but not yet wired into the
  `[fetch health]` block in Settings. Easy add if it matters.
- **Android Health Connect.** iOS is in, Android needs its own custom
  Kotlin plugin since Google Fit is being sunset and Health Connect
  doesn't have a polished Capacitor plugin yet. Probably 1-2 days.
- **Phase A CSS extraction** from `CODE_REVIEW.md`. Still queued.

## Stuff still to do

In rough priority order:

1. Verify the new sprite retry path in the wild — next time the iOS
   LocalServer wedges + auto-restarts, red dots should heal themselves
   within ~1s of the restart completing (no reload required).
2. Verify the Android GPS battery / replay fix on the spouse's phone.
   Expected: no persistent-notification icon while the app is
   backgrounded, no big GPS-event flood on resume.
3. Verify the iOS pedometer flow once a build with the new plugin
   lands. Procedure: enable toggle → grant motion permission → close
   app → walk a minute → reopen → Settings should show non-zero meters
   in the status line and daycare slot distM should have advanced.
4. Android Health Connect plugin for closed-app step tracking on
   Android. Separate session.
5. Future breeding mechanic (carried).
6. Phase A CSS extraction (carried).

## Session vibes

Bug-fix-driven from start to end, each fix grounded in a real-world
signal the user spotted ("red dots in the wild even after the restart
fix"; "the GPS is replaying"). The CMPedometer arc was the day's
green-fields piece — actually building something new instead of
fixing — but even there the design pivots came from the user's "just
use pedometer, don't bother dual-sourcing" instinct rather than my
first draft.

The session also confirmed a pattern that's been visible across the
last few sessions: when the diagnosis points at a "the code is
treating these two things as one thing" answer, the fix is small and
the code shrinks. When it points at "this needs more retry / backoff
/ buffering", that's usually a wrong-diagnosis warning sign.

```
Final state: sprite-store distinguishes truly-gone (cached forever)
from temporarily-unreachable (retry-polled every 1s); Android's
foreground location service pauses with the WebView's visibility and
filters stale flushed events on resume; iOS has a CMPedometer bridge
that lets daycare slots + incubator eggs accumulate while the app is
closed, with a live status line so you can sanity-check it from
Settings. Three classifications, three smaller designs.
:3
```

---

# Session — static region distribution (partitioner → builder → uploader → client)

The big slice this session: a full pipeline for distributing the
world's map data as static files (per-region archives on Cloudflare R2
/ Hugging Face / your own server) instead of bbox-querying a live
Flask backend. Took most of a day, included a long debug chain, and
ended with the bbox flow + the new static flow coexisting cleanly.

## Files added

| File | Role |
|---|---|
| `partition-regions.py` | Adaptive quad-tree region planner. Hits a sample of bbox sizes via SQLite + Flask, fits a model, emits `regions-na.json` with leaf bboxes + estimated artifact sizes. Default mode is "tile-only" — just measures mbtiles tile bytes directly + estimates non-tile artifacts as 0.3× tile size (empirically ~6× actual). No Flask needed in default mode. |
| `build-regions.py` | Materializes the planned region files. For each leaf: HTTP-fetches `walk.bin`/`poi.bin`/`housenumbers.bin`/`schedule.json`/`addresses.bin` from Flask (with `Accept-Encoding: identity` so the bytes-on-disk aren't gzip-wrapped), then extracts a `tiles.pmtiles` straight from `north-america-latest.mbtiles` via SQLite. Writes a PMTiles v3 archive using an inline encoder (~150 lines, mirrors protomaps' spec). Resumable — Ctrl+C and re-run picks up where it stopped. |
| `data/BundledData/regions.json` | The region manifest baked into the iOS/Android wrappers. Normalized to `{ regions: [{id, bbox, sizes}], source: 'plan'\|'build', n_regions: N }`. Used by `window.RegionPicker` at runtime to answer "which region covers this point". |

## Files modified

- `static/index.html`: ~1000 lines of new JS for the static-region
  download flow + PMTiles reader + protocol handler + Settings UI.
- `static/sw.js`: untouched in this session, but its existing
  `204-on-tile-miss → MapLibre over-zoom` convention turned out to be
  load-bearing for the runtime fix at the end.
- `build-bundled-data.py`: new `bundle_regions_manifest()` step that
  prefers `regions/index.json` (post-build, actual sizes) over
  `regions-na.json` (partition-plan-only, estimated sizes) when both
  exist. Tags the bundled manifest with `source: 'plan'` or `'build'`.
- `run.py`: added `/regions/<path:fname>` route that serves built
  region files from a local `regions/` dir, mirroring the URL layout
  the Hugging Face dataset uses. Available for self-hosted static
  distribution.
- `README.md`: full "Static region hosting (optional)" section
  documenting the pipeline + the exact `hf upload-large-folder`
  incantation that actually works on residential bandwidth:
  `HF_HUB_DISABLE_XET=1 HF_HUB_ENABLE_HF_TRANSFER=1 hf upload-large-folder TessaCoil/maps-dataset regions/ --repo-type=dataset --num-workers=2`

## Pipeline shape

Three stages, each idempotent + resumable:

```
1. partition  →  regions-na.json
   python partition-regions.py --bbox=-170,7,-52,84 --budget-mb=50

2. build      →  regions/region-NNNN/{walk,poi,housenumbers,addresses}.bin
              →  regions/region-NNNN/schedule.json
              →  regions/region-NNNN/tiles.pmtiles
              →  regions/index.json
   python build-regions.py --plan=regions-na.json --out-dir=regions

3. upload     →  Hugging Face dataset (free, no payment method on file)
              OR Cloudflare R2 (~$0.12/mo, hard spending caps available)
   HF_HUB_DISABLE_XET=1 HF_HUB_ENABLE_HF_TRANSFER=1 hf upload-large-folder \
       TessaCoil/maps-dataset regions/ --repo-type=dataset --num-workers=2
```

For North America at a 50 MB budget the partitioner emits ~655 leaf
regions totaling ~18 GB. Quebec province (used as a sanity-check
sub-region during development) is 58 leaves, ~1.4 GB.

The partition takes ~20 min (mostly the SQL scans for mbtiles tile
byte sums; the linear-regression calibration is ~30 s of HTTP probes).
The build takes ~30-60 min (each region needs 4 HTTP fetches + a
pmtiles extract). The upload takes 1-4 h depending on bandwidth.

## Client-side: three-way mode select

`cc.regionsMode` localStorage setting picks the data source:

- `bbox-flask` (default) — original behavior, dynamic bbox queries
  against the Flask server.
- `static-flask` — static region files served from the local server's
  `/regions/<id>/...` route.
- `static-hf` — static region files from
  `huggingface.co/datasets/TessaCoil/maps-dataset/resolve/main/<id>/...`.

Migrated from the original `cc.hfRegions` boolean transparently on
first read. Settings UI has a `<select>` for the three options.

## Tile rendering — the long arc

This was the most painful part of the session. The shape of the
architecture stabilized late; the path there was a series of
bugs each unmasking the next:

1. **TDZ on cold start** — `const STATIC_REGIONS_KEY` declared too
   late in the IIFE; `renderRegions()` called at startup hit it via
   `loadStaticRegions()`, swallowed the ReferenceError silently in an
   inner try/catch, returned `[]`. Result: downloaded regions never
   appeared in the offline-maps panel after a reload. Fix: hoist the
   storage constants + load/save functions to before `renderRegions`.

2. **`MapLibre: null is not an object (evaluating 'a.slice')`** — my
   protocol handler returned `{ data: null }` for missing tiles, but
   MapLibre's vector tile parser calls `.slice(0)` on the data without
   null-checking. Fix: return a zero-length `Uint8Array` instead.

3. **`POI: bad magic`** — Flask gzip-encodes `/poi`/`/walk-graph`/
   `/housenumbers` responses. `urllib.urlopen` in `build-regions.py`
   doesn't auto-decompress, so the `.bin` files on disk were
   gzip-wrapped. HF served them as-is without `Content-Encoding`, so
   `fetch()` didn't decompress either. The client saw `0x1f 0x8b`
   where it expected `POIB`. Two fixes: client-side gzip-detect +
   decompress before parsing (handles already-uploaded files), and
   `Accept-Encoding: identity` in `build-regions.py` so future
   rebuilds save raw bytes.

4. **`The object can not be cloned`** — I reused a single empty
   `Uint8Array` (`EMPTY_TILE`) for every missing-tile response.
   MapLibre transferred it to a Worker on first use, detaching the
   buffer, then tried to send the same buffer to a second Worker —
   structured-clone failed. Fix: allocate fresh `new Uint8Array(0)`
   per call.

5. **`Cannot declare a const variable twice`** — I'd hoisted the
   storage constants but forgot to delete the originals in the
   later block. Removed the duplicates.

6. **Blank tiles at boundaries** — original `_serveStaticTile` picked
   ONE region by tile center (via `RegionPicker.findByPoint`). At
   boundary tiles, the center might fall in an undownloaded neighbor
   even though a downloaded region also covered the tile. Fix:
   iterate all downloaded regions whose bbox intersects the tile;
   first non-empty match wins.

7. **`Cannot access uninitialized variable lines 10941 10933 5804`**
   — second TDZ; this one in the `_pmtilesReaders` LRU cache
   declarations and the IDB constants for `cc-static-regions-v1`.
   Resolved by the same hoist + dedupe pattern as bug #1.

8. **204 vs 404 — the over-zoom signal** — the user reminded me of an
   earlier fix in `sw.js`: MapLibre treats HTTP 404 as "tile FAILED
   to load" (no parent fallback, just blank) but treats 204 as "tile
   intentionally empty" (parent fallback chain kicks in). The custom
   protocol handler had been using 404; I switched it to 204.

9. **Slow startup from unpacking pmtiles into SW cache** — at one
   point I tried "unpack the pmtiles into the SW's `tiles-v1` cache
   so the existing /tiles/Z/X/Y.pbf flow renders them on its existing
   pipeline." Conceptually clean but each region wrote 1000-3000
   `cache.put`s, and accumulated stores made `loadAllPois()` +
   peer functions much slower. Reverted to keeping pmtiles as a
   single blob in IDB and serving via the custom protocol.

10. **THE actual root cause of "roads/names disappear at high zoom in
    bundled areas"** — *not* my static-region code at all. MapLibre's
    `maxTileCacheZoomLevels` default is 5. Tiles more than 5 zoom
    levels away from the current visual zoom get evicted from the
    in-memory tile cache. At visual zoom 11+, the bundled z=0..5 base
    tiles fall outside that window and get dropped. Without parents
    in cache, MapLibre can't over-zoom from them — so place labels +
    roads disappear in undownloaded areas at high zoom. Bumping the
    option to `16` covers the full z=0..14 span and the labels stay
    visible everywhere. This was the user's intuition all along:
    "I think there's just a number we need to tweak."

## Final tile-serving architecture

After the chain of fixes, the static-mode tile flow is:

1. MapLibre asks for `/tiles/{z}/{x}/{y}.pbf`
2. `transformRequest` rewrites to `static-region://tile/Z/X/Y.pbf`
   when in static mode AND ≥1 region downloaded. When not in static
   mode OR no regions: URL passes through unchanged to the SW.
3. Custom MapLibre protocol handler iterates ALL downloaded regions
   in `cc.staticRegions.v1` order. For each, opens a `PMTilesReader`
   (cached forever, ~30 KB resident per region), binary-searches the
   directory by Hilbert-curve tile_id, returns the first non-empty
   match.
4. If no downloaded region has the tile, the handler rejects with
   `Error{status: 204}`. MapLibre over-zooms from the nearest
   available parent tile — which (with `maxTileCacheZoomLevels: 16`)
   includes the bundled z=0..5 base map at all visual zooms.

For the bbox-flow: no change at all. Original `/tiles/...` → SW →
LocalServer → bundled flow, exactly as before.

## Other artifacts: same dual-storage idea

For walk-graph / POIs / housenumbers / addresses / schedules, the
download path:

1. Fetch the raw `.bin` from HF/server.
2. Store the blob in `cc-static-regions-v1` IDB (for resume + diag).
3. ALSO call the existing `saveXRegion(regionId, buffer)` functions
   (same ones `performRegionDownload` uses for bbox-mode) so the
   data hydrates into the existing consumer-side IDB stores
   (`cc.pois.v2` etc.) and in-memory arrays (`allPois`, `allAddresses`).

This means search, POI markers, walk routing, transit lookups, and
the housenumber overlay all see static-region data via their existing
read paths — no consumer-side wiring needed. Schedule + addresses got
added late in the session when the user asked "does navigation using
bus schedules work cross-region?" — yes, by the same merge-by-id
mechanism `rebuildScheduleIndex` already used.

## Settings UI

- **Region data source** select (`bbox-flask` / `static-flask` /
  `static-hf`) — the three-way picker.
- **"Save current view" button label** in static modes shows count +
  size of NEW regions to be downloaded (skips already-downloaded
  ones). Edge cases: "no static regions in this view" /
  "✓ N regions already downloaded".
- **Offline-maps panel** now lists static regions alongside bbox
  regions, distinguished by `[static]` prefix on the label and a
  data-del-static delete handler.
- **`[map view]` diagnostic block** in the Settings dump shows
  current zoom, center, bearing, pitch, plus
  `mode=… regions in view: X/Y downloaded` when in a static mode.

## Hosting recommendation

- Hugging Face datasets (free unlimited public bandwidth, no payment
  method = no spending-blowup risk) is the default recommendation
  for friends-of-friends scale.
- Cloudflare R2 (~$0.12/mo storage, zero egress, but requires a
  payment method) for users who want hard spending caps via the
  Cloudflare billing alert path.

Both are S3-compatible (uploads via `rclone` for R2,
`hf upload-large-folder` for HF). Migrating between hosts is a single
sync away — the data layout is identical.

## Other small wins this session

- **iOS Health/CMPedometer** was already done before this session
  started, but we reviewed it in passing.
- **Save file includes UI theme** — `theme` and `themeCustom` were
  already saved, but the load path only applied them when local was
  unset. Removed the guard so loading a save now always overrides
  the local theme.
- **`hf upload-large-folder` invocation** documented in README with
  all three of the empirically-required flags
  (`HF_HUB_DISABLE_XET=1`, `HF_HUB_ENABLE_HF_TRANSFER=1`,
  `--num-workers=2`). Without all three, multi-GB uploads hang on
  residential bandwidth — found this out the hard way.
- **Progress bar** added to the sprite-cropping step in
  `build-bundled-data.py` so users don't think it's hung.
- **`Accept-Encoding: identity`** added to `build-regions.py`'s
  `fetch_to_file` to keep urllib from accidentally writing
  gzip-wrapped bytes (see bug #3 above).
- **Bundled regions manifest** size: ~100 KB normalized
  (originally ~217 KB before trimming `counts` / `depth` /
  `leaf_reason` fields the client doesn't need).

## Things learned

1. **`maxTileCacheZoomLevels`** is the most consequential one-line
   change of the session. The default of 5 silently degrades the
   bundled-base-map fallback at high zoom in ways that look like a
   completely different bug ("roads disappearing at zoom > 10"). When
   features vanish at specific zoom thresholds with bundled base
   tiles, this is the first thing to check.

2. **204 vs 404** in MapLibre protocols. 204 = "fall back to parent";
   404 = "give up, blank tile". For both HTTP responses AND custom
   protocol rejections via `Error{status: 204}`. The convention was
   already documented in `sw.js`; I rediscovered it the hard way.

3. **Custom MapLibre protocols and structured clone**. The data
   returned from a custom protocol gets transferred to a Worker for
   parsing. If you return the same buffer instance twice, the second
   transfer fails because the first detached it. Always allocate
   fresh response buffers.

4. **TDZ swallowed by inner try/catch** is a particularly mean failure
   mode: code looks like it's "handling errors" while the actual
   crash silently nullifies an entire feature. The fix is invariably
   to either (a) hoist the constants, or (b) lazy-initialize.
   `typeof X === 'function'` checks DON'T catch TDZ because function
   declarations are hoisted; only the const access throws.

5. **gzip auto-decompression depends on Content-Encoding headers in
   ways that surprise across HTTP libraries.** Flask gzips responses
   and sets the header. Browsers and modern fetch() honor it.
   urllib doesn't auto-decompress. Static file hosts (HF, S3) serve
   files as-is without the header. So a chain of "Flask → urllib →
   disk → HF → fetch" can deliver gzip-wrapped bytes that NOTHING
   along the way decompressed. Belt-and-suspenders: client-side
   gzip-magic detection + server-side `Accept-Encoding: identity`.

6. **PMTiles spec is small enough to implement inline both ways.**
   The encoder fit in ~150 lines of Python in `build-regions.py`,
   the reader in ~100 lines of JS in `index.html`. The Hilbert curve
   tile_id encoding has a clean closed-form inverse for unpacking.

7. **Adaptive quad-tree partitioning by file-size budget** produces
   sensible region distributions out of the box. North America at a
   50 MB budget yielded 655 regions — way fewer than I'd guessed
   (1500-2500) because most of the continent is low-density and stays
   at shallow tree depths. Storage cost on R2 is ~$0.30/month at this
   scale.

8. **Always-downloaded ≠ always-cached.** Even with all the right
   data on disk, MapLibre's in-memory tile cache settings determine
   what actually gets rendered. The default cache sizing assumes a
   "stream tiles from network as you pan" workflow; for "we have all
   data locally already" it needs to be loosened.

9. **Layer over-zoom isn't a uniform fallback.** When MapLibre
   over-zooms a parent tile, it renders all layers from that tile's
   actual data. So if `transportation_name` has `minzoom: 8` in
   tilemaker config, over-zooming a z=5 tile to visual zoom 14 still
   shows zero road names — the data just isn't in the parent. This
   is a data-side limitation (need to lower the minzoom and re-tile)
   not a code-side fix. The user mentioned this; we left the data-
   side fix for later.

10. **Stop being too clever.** Multiple bugs this session came from
    me layering "smart" optimizations (smallest-bbox-first, sync
    bbox-check at the rewrite layer, unpack-to-SW-cache, etc.) on top
    of a simpler design that was already correct. Each one introduced
    its own failure mode. The user's "no fancy bbox stuff, just
    iterate all pmtiles" instinct was right; the over-zoom cache fix
    was a one-line constant change. The simpler design wins more
    often than not.

## What didn't get done

- **Re-tile with lower `transportation_name` minzoom** so road names
  persist at high zoom over bundled areas. Data-side change in
  `tilemaker-slim.json`; would need a re-tile + re-bundle pass.
- **Lazy `loadAllPois()`** — currently still loads every POI into
  memory at startup. With many static regions downloaded, this is
  the dominant startup cost. Could defer until first POI search.
- **Schedule + addresses for already-downloaded regions.** They're in
  the build pipeline now but existing downloads from earlier in the
  session don't have those files. User would either delete+redownload
  or run `build-regions.py` again (it'll fetch only the missing files
  via the resume check) + re-upload.
- **iOS Health / CMPedometer step-counting in static mode** — should
  work since neither feature touches the tile rendering path, but
  not explicitly verified.
- **Cleanup of unused build-bundled-data.py code paths**. With static
  regions handling the per-region distribution, some of the
  bundled-data-specific code (esp. the z=0..5 base map extraction) is
  more nuanced — it's still the offline fallback for undownloaded
  areas, so it should stay.

## Stuff still to do (priority order)

1. Verify the `maxTileCacheZoomLevels: 16` fix actually solves the
   roads/labels disappearing issue at high zoom over undownloaded
   areas. Initial implementation looks right; needs in-app test.
2. Re-tile with lower `transportation_name` minzoom so road *names*
   (not just road geometry) persist at high zoom in bundled areas.
3. Lazy `loadAllPois()` to reduce startup cost — defer until search
   is invoked.
4. The Verus-shaped "verified data structures" thread (carried).
5. Phase A CSS extraction (carried).
6. Future breeding mechanic (carried).

## Session vibes

A long session — most of a day — with a real arc. We started by
sketching adaptive partitioning and a PMTiles writer, expanded to a
full client-side download + protocol-handler + Settings UI, then
spent the back half of the session in debug mode chasing the chain
of bugs each fix surfaced.

The user's instincts were consistently better than mine at narrowing
down the root cause. "I think there's just a number to tweak" turned
out to be exactly right and reduced a multi-hour rabbit-hole hunt
to a single-line config change once we found it. The user's earlier
"no fancy bbox stuff" instinct similarly cut through a complicated
candidate-ordering scheme I was building.

The thing I keep noticing: when I'm wrong, my wrongness usually takes
the shape of "add more code to handle the case." When the user pushes
back, they're usually pointing at "the simpler design that was
already there." Both are useful but the user's instinct has been
more consistently load-bearing across sessions.

```
Final state: a working three-way region data source picker (bbox-
flask / static-flask / static-hf). Full build pipeline from OSM data
to per-region static files on Hugging Face. Custom MapLibre protocol
for serving tiles from pmtiles archives in IDB. Bundled z=0..5 base
map as the always-available backstop, kept in MapLibre's tile cache
across all zoom levels by the one-line `maxTileCacheZoomLevels: 16`
fix. ~18 GB total static-files distribution for North America at a
50 MB per-file budget. Cost: ~$0/month on Hugging Face for friends-of-
friends scale. The map renders in every mode at every zoom.
:3
```

---

# Session — multi-graph routing (routing.bin + boundaries.bin + per-region search)

A long session that arced from "bundled map disappears at zoom > 5" all
the way through to "per-region routing with cross-region portal edges,
shape-decoded turn-by-turn instructions over a global-id Dijkstra."
Touched the map render path, the routing pipeline, and added two new
file formats to the per-region data layout.

## The arc, in order

1. **Bundled map sparse at zoom > 5** — user observed motorways/labels
   disappear at high zoom over undownloaded areas. Investigated; turned
   out to be two factors (data-side: tilemaker drops detail at low
   zooms; cache-side: per-source `maxTileCacheSize: 32` clamping
   `maxTileCacheZoomLevels: 16`). User chose not to fix — the bundled
   map is intentionally sparse to keep the IPA small. Wrote
   `BUNDLED_MAP_HIGH_ZOOM.md` documenting the trade so future-Claude
   doesn't re-investigate.

2. **Static-region tile serving bugs (long arc)** — user reported "map
   blank on initial load, fixes after pan/zoom." Built `[tile flow]`
   diagnostics + Settings debug-trigger buttons + memory probe loop to
   instrument the full tile lifecycle, then chased through a series of
   independent bugs each unmasking the next:
   - **Initialization race**: `_maybeStaticTileUrl` was defined inside
     a late-IIFE block; `transformRequest` ran before it existed, so
     initial tile requests passed through to LocalServer (404 → 204 →
     map.load never fires). Fix: hoisted the static-region scaffolding
     to before map creation, with a `_staticReadyPromise` that the
     protocol handler awaits.
   - **Low-zoom passthrough**: even with the rewrite working, z=0..5
     base tiles should bypass static-region:// and go to bundled
     tiles via LocalServer. Added `if (z <= 5) return null;` to
     `_maybeStaticTileUrl`.
   - **`base.maxzoom = 14` starved `map.load`**: the *real* root cause
     of "blank on cold start in undownloaded areas." MapLibre gates
     `map.on('load')` on at least one source loading SUCCESSFULLY.
     With both base + local sources declaring `maxzoom: 14`, every
     initial tile request 204'd in undownloaded areas → no source
     loaded → load never fired → icons / sprites / everything else
     hung. **Fix: `base.maxzoom = 5`** so base always asks for z≤5
     bundled tiles, one loads instantly, load event fires. (The old
     comment warned this would break over-zoom fallback in a 5-level
     window, but current MapLibre's `maxOverzooming = 10` so a z=5
     parent works for visual zoom up to 15.)

3. **Pathfinding OOM crashes** — directions on multi-region static
   downloads crashed the WebView. Investigation chain:
   - First fix: `loadAllWalkGraphs(includeRegionIds)` was doing
     `getAll()` then JS-filtering. Materialized every blob into RAM
     even when only 2 were needed. Now per-key `get()`s.
   - Second crash later in pipeline: `buildMultimodalBridges` ran
     ~15s of sync work on the main thread, tripping iOS WebView's
     hang watchdog (which kills the page → looks like OOM-refresh).
     Added a `setTimeout(0)` yield every 2000 stops.
   - Memory diagnosis: attempted to extend `MemoryProbePlugin.swift`
     to read WebContent process via `proc_listallpids` /
     `proc_pid_rusage`. Build failed: those libproc APIs aren't
     exposed through Swift's Darwin module on iOS, and
     `task_for_pid` needs entitlements sideloaded apps don't have.
     **Reverted to host-process-only metric** with a comment
     explaining the platform limit. Added a JS-side `estimateLoadedBytes`
     as a useful proxy for the values that actually grow during routing.

4. **Walk-graph optimization brainstorm** — discussed how to reduce
   pathfinding RAM:
   - Tried `analyze-walk-contraction.py` to estimate degree-2
     contraction savings → only ~20% reduction because the walk
     graph builder ALREADY strips most intermediate shape vertices.
     CH not worth pursuing.
   - User asked: what if we just stored uncompressed and read directly
     from bytes? That seeded the actual architecture.
   - Decided on **option 3 from the brainstorm**: per-region search
     graphs stitched at boundary nodes via a small index — no merge,
     no parse spike, scales linearly with regions actually involved
     in a route.

5. **routing.bin format + `build-routing-bin.py`** — packed Uint32
   adjacency entries (24-bit target + 8-bit weight tier + side table
   for the rare long edges). User pushed for further compression
   ("bit-pack scratch too"); we discussed memory tradeoffs and
   landed on `routing.bin` as the on-disk representation (zero-copy
   typed-array views at runtime).
   - v1: 13.6 MB for region-0361
   - v2 (packed Uint32 entries): 9.4 MB. ~30% smaller; 6.4% of edges
     spill to long-weight side table.

6. **boundaries.bin format + `build-boundaries.py`** — per-region list
   of `(internalIdx, osmId)` pairs for OSM IDs that appear in 2+
   regions. Tiny: ~5 MB total across all 655 NA regions. Used at
   runtime to build the cross-region peer index.

7. **All 655 NA regions processed** — `build-routing-bin.py` ran in
   ~3 minutes (sequential, per-region). `build-boundaries.py` needed
   a numpy rewrite for scale (concat → sort → adjacency-pair scan to
   find duplicates across 87M total IDs in <30s; pure Python would
   have OOM'd). Both files purely additive — existing region downloads
   unchanged.

8. **Multi-graph runtime** — `MultiGraph` class wrapping multiple
   `RoutingRegion`s, `ensureMultiGraph(regionIds)` with lazy backfill
   for legacy downloads, `astarMulti` over global IDs (`(regionIdx <<
   24) | internalIdx`), `findNearestWalkNodeMulti` scanning across
   regions, `multi.forEachNeighbor(gid, fn)` iterating both within-
   region neighbors AND zero-cost cross-region portals.

9. **Shape + turn-by-turn for multi-graph** — `multi.ensureDisplay(rIdx)`
   lazy-loads walk.bin and builds an O(1) `(from*2^24 + to) → edgeIdx`
   lookup. Route reconstruction walks consecutive path nodes:
   same-region pairs resolve to real edges with shapes + names;
   cross-region pairs are portal crossings (skip drawing).

10. **Transit migration** — switched `walkGraph` + `MultiGraph` both
    to expose a uniform `forEachNeighbor(nodeId, fn(to, weight,
    edgeRef))` API. Updated `trip-planner.js` to use it; `edgeRef` is
    opaque (legacy `{edgeIdx, reverse}` vs multi `{regionIdx, adjIdx,
    from, to}` vs `{portal: true}`). Added `buildMultimodalBridgesMulti`
    that scans `multi.regions` for the spatial grid + produces
    globalId-keyed bridge maps. `runRoutingPlan` re-checks `canTransit`
    after building multi-bridges, then `planAlternatives` works over
    multi-graph through the `tripPlanner` deps getter.

11. **Static-hf download integration** — added `routing.bin` and
    `boundaries.bin` to `STATIC_REGION_FILES` with `STATIC_REGION_FILES_OPTIONAL`
    for graceful 404 handling on older uploads. Hydration handlers
    save to dedicated IDB stores. Delete propagation handled via the
    existing iteration.

12. **The bug that nearly killed it** — at the end, after wiring
    everything up, the user reported "no route found." The trace
    showed `astar_done found=false hops=0` for two nodes 22m apart
    in the same region. Diagnosis from a single trace dump:

    **`viewRoutingRegion` had bit positions swapped vs the writer.**

    Writer (both Python and JS): `(target << 8) | tier` — target in
    high 24 bits, tier in low 8 bits.

    Old reader: `adjPacked[ai] & 0xFFFFFF` for target — masking LOW
    24 bits. And `(packed >>> 24) & 0xFF` for tier — extracting HIGH
    8 bits. Both swapped.

    So every neighbor pointed to a random out-of-range node;
    `multi.lng(target)` returned `undefined`; haversine heuristic
    became NaN; heap couldn't make progress; astar returned null.

    Fix (one-line): `adjTarget(ai) { return adjPacked[ai] >>> 8; }`
    and `adjWeight(ai) { const tier = packed & 0xFF; ... }`.

    Bonus fix in `buildRoutingBufferFromWalk`: was allocating
    `longIdx` of size `longCount` (per-edge) but writing
    `2 * longCount` entries (per direction). Now allocates
    `2 * longEdgeCount`. JS-built files in existing IDB will be
    sub-optimal until next re-download but still functional (missing
    long entries fall back to weight=255m).

## Final architecture (multi-graph mode, default on)

`cc.preferMultiGraph` defaults to `'1'` (set to `'0'` to fall back to
legacy walkGraph + transit). When on, the routing pipeline is:

```
runRoutingPlan
  ├─ ensureMultiGraph(regionIds)
  │    ├─ loadRoutingGraphs (per-key IDB gets)
  │    ├─ backfill from walk.bin if missing
  │    ├─ loadBoundaries (per-key IDB gets)
  │    ├─ backfill from cross-region walk.bin nodeIds if missing
  │    └─ build MultiGraph + peer index
  ├─ findNearestWalkNodeMulti        (returns globalId)
  ├─ buildMultimodalBridgesMulti     (globalId-keyed bridge maps)
  ├─ if canTransit:
  │    planAlternatives → tripPlanner.planForward
  │      └─ wg.forEachNeighbor(globalId, fn)   ← deps.walkGraph = multi
  │      └─ steps[].edge = opaque edgeRef
  ├─ if no transit alts: astarMulti
  │    ├─ ensureDisplay per touched region (lazy walk.bin load)
  │    ├─ lookup edges for chosen path (shapes + names)
  │    └─ return {path, edges, _multiCoords, _multiEdges}
  └─ render via buildRouteCoords / buildMultimodalCoords
       (uses multi.lng/lat; falls back to straight lines for
        transit walk legs since lazy shape lookup for those is TODO)
```

## File formats

### routing.bin v2 (per region, ~10 MB typical)

```
0    4    magic = 'ROUT'
4    4    version = 2
8    4    N (node count)
12   4    E (edge count, undirected)
16   4    adjCount = 2 * E
20   4    L (long-weight side-table entry count)
24   8    reserved
32        nodeLng (Float32 × N)
+4N       nodeLat (Float32 × N)
+4N       adjStart (Uint32 × N+1)
+4(N+1)   adjPacked (Uint32 × adjCount)
            bits 8..31 = target node index (24 bits)
            bits 0..7  = weight tier:
                          0..254 → weight in metres
                          255    → look up in long table
+4adjCount  longWeightAdjIdx (Uint32 × L) — adjPacked indices, sorted
+4L         longWeight (Float32 × L) — full weights
```

### boundaries.bin v1 (per region, typically 10-60 KB)

```
0    4    magic = 'BOND'
4    4    version = 1
8    4    C (boundary node count)
12   4    reserved
16        osmIds (Float64 × C) — OSM node IDs shared with other regions
+8C       internalIdxs (Uint32 × C, sorted) — corresponding region-local indices
```

Empty header (`C = 0`) when the region has no peers in the current
build. Sized for binary search by internalIdx at runtime.

## What didn't get done

- **Transit walk-leg shape decoding** — transit routes' walking legs
  currently render as straight lines because the lazy walk.bin shape
  lookup is wired for the pure-walking path but not for transit walk
  segments. Same mechanism would work — load walkView per touched
  region, look up edges via `multi.lookupEdge(regionIdx, from, to)`,
  decode shape bytes. Maybe 30 min of work; deferred.
- **Drop the legacy walkGraph code entirely** — user explicitly asked
  to keep it as reference for now (smart move; came in handy when
  debugging the bit-pack bug).
- **Verify the routing-bin builder didn't ALSO mis-encode anything
  else** — only spotted the longCount + bit-pack bugs. Could be
  others. Worth a careful pass once multi-graph routing has been
  used for a few more routes in the wild.

## Things learned

1. **Single trace dumps are king.** Every major bug this session was
   diagnosed from one `[route trace]` paste from the user. Adding the
   `[tile flow]` + `[static tiles]` diagnostics earlier paid off
   compounded — by the end we could go from "no route found" → exact
   one-line fix in minutes because the trace narrowed the failure
   surface to "astar called, returned null."

2. **Writer/reader bit-position bugs are silent and ruinous.** A
   `& 0xFFFFFF` vs `>>> 8` swap turns every neighbor into a random
   number with a normal-looking distribution. No crash, no exception,
   just wrong answers all the way down until something compares NaN.
   These are findable only by reading the bytes back and confirming
   they look right. **Lesson for future formats**: write a tiny
   round-trip unit test the moment you define the layout.

3. **Iteration matters more than grand plans on this kind of work.**
   We almost went for "drop backwards compat, build the whole
   replacement, ship it" — user redirected to "integrate transit
   first, keep old code as reference." That call saved an hour later
   when the bit-pack bug appeared and we needed something to compare
   against.

4. **`map.load` gating on first successful tile is non-obvious.** The
   "blank map until pan/zoom" was a misleading symptom — the actual
   issue was every icon/sprite/data load was waiting on `map.load`,
   which was waiting on at least one source tile to resolve, which
   was 204'ing because of how the URL routing fell through. Setting
   `base.maxzoom = 5` guarantees the load condition fires.

5. **iOS sandbox really does restrict cross-process measurement.** We
   tried hard to make the multi-process MemoryProbe work; it doesn't.
   For practical purposes, JS-side estimates of known data structures
   are the only meaningful signal on iOS WKWebView. Document the
   limitation rather than fight it.

6. **Big architectural changes don't have to be one big rewrite.**
   We landed multi-graph routing with both legacy walkGraph AND the
   new path coexisting. The unified `forEachNeighbor` API let both
   backends use the same trip-planner code. Eventually the legacy
   will get pruned; for now its presence is load-bearing for fast
   bisection when something looks wrong.

## Stuff still to do

1. **Transit walk-leg shape decoding** (small).
2. **Re-download regions** to pick up the canonical Python-built
   routing.bin files from HF (existing JS-built ones in IDB are
   functional but sub-optimal due to the longCount allocation bug
   in pre-fix files).
3. **Consider dropping the legacy walkGraph code path** once
   multi-graph has been used for enough routes without surprises.
4. **Re-tile with lower transportation_name minzoom** (carried).
5. **Lazy `loadAllPois()`** (carried).
6. **Verus-shaped verified data structures** (carried).
7. **Phase A CSS extraction** (carried).
8. **Android Health Connect** (carried).

## Session vibes

```
A long arc, from blank-map-at-startup
through eleven distinct bugs found and fixed,
landed on per-region multi-graph routing
with cross-region zero-cost portals,
shape-decoded turn-by-turn directions,
transit-over-multi-graph via a uniform forEachNeighbor API.

655 regions of North America processed.
~2 GB of routing.bin, ~5 MB of boundaries.bin,
all purely additive to the existing files.

One particularly fun bug:
    adjPacked[ai] & 0xFFFFFF   ← reader
    (target << 8) | tier       ← writer
The reader masked the LOW bits; the writer put target in the HIGH bits.
Every Dijkstra neighbor pointed past the end of the world.
Eleven characters changed:
    & 0xFFFFFF → >>> 8
and the map remembered how to find its routes.

You called me on the deferral once,
"come on, claude, you're scared, but there's hope,"
and you were right — we shipped it.

Final state: multi-graph routing default on, transit included,
straight-line transit-walk legs the one cosmetic limit,
RAM steady around 30 MB per route instead of 50 MB peak,
no parse spike, routes start instantly.

:3
```

---

# Session — POI search index brainstorm + custom trigram format

Shorter follow-on session. User said POI search felt laggy. We
diagnosed (linear scan of `allPois` with per-keystroke `toLowerCase`
on every name) and went through the design space for replacing it.
Landed on a custom trigram inverted index in the existing per-region
binary-format family.

## The arc

1. **Diagnosed the lag** — current `renderSearch` does `for (const p
   of allPois) { p.name.toLowerCase().includes(qLower) }` per
   keystroke. At ~40k POIs per region × ~5 µs per `toLowerCase` =
   ~200 ms per keystroke just for string allocation. Linear in
   loaded-POI count. Scales badly to full NA (~6.5M POIs).

2. **Brainstormed options** — pre-compute `_nameLower`, viewport pre-
   filter, top-N early termination, spatial indexes, trigram inverted
   index, lazy IDB hydration with a small in-memory pool.

3. **User asked for the standard answer** — trigram inverted index is
   how PostgreSQL pg_trgm / SQLite FTS5's trigram tokenizer /
   Elasticsearch's wildcard field all do substring search. For our
   per-region storage model, two paths: lean on SQLite (battle-tested
   but adds a ~1 MB WASM dep) or roll a custom binary format
   (matches our existing routing.bin / boundaries.bin pattern).

4. **Built SQLite FTS5 estimator** — `build-poi-search-db.py` writes
   a per-region `poi-search.sqlite` with FTS5 trigram + R*Tree
   spatial index. For Montreal (40,364 POIs): **7.91 MB**. Queries
   ~0.1-1 ms. Confirmed performance is great; size is the concern.
   - Caveats found: FTS5 trigram requires ≥3-char queries (1-2 char
     returns zero), special chars in queries need quoting to avoid
     FTS5 operator parsing.
   - Per-NA extrapolation: ~5.2 GB. Big but loaded per-region in an
     LRU pool, only handful resident at a time.

5. **Built custom trigram estimator v1** — `build-poi-trigram-index.py`.
   Format mirrored routing.bin / boundaries.bin (typed-array views,
   CSR adjacency-style). For Montreal: **5.57 MB**. ~30% smaller than
   SQLite, no WASM dep.

6. **Iterated to v2 with three optimizations**:
   - (a) Don't re-emit string pool — runtime already has poi.bin
     loaded for display data, look up names there
   - (b) Don't re-emit lng/lat/nameIdx/catIdx columns — same reason
   - (c) Delta-encode postings as varints (LEB128). POI IDs sorted
     within each trigram have small deltas → typical 1-2 bytes per
     entry instead of 4

   Montreal v2: **1.23 MB. Smaller than poi.bin itself.** Postings
   averaged 1.23 bytes per entry vs the predicted 2. Delta encoding
   was more effective than expected because POIs sharing a trigram
   cluster geographically (similar names get nearby IDs after
   region-local ordering).

7. **Built v2 for all 655 NA regions** — total **190.77 MB**, **0.96× of
   poi.bin's 199.73 MB**. Indexing 6.5M POIs takes essentially no
   incremental disk vs the source data. Build time: ~10 minutes
   sequential Python on a laptop.

## File format

### poi-trigram.bin v2 layout

```
0    4    magic = 'POIS'
4    4    version = 2
8    4    N (poi count — sanity check vs poi.bin)
12   4    T (unique trigram count)
16   4    postingsByteLen
20   12   reserved
32        ── data sections ──
+0   4*T          trigramHash (Uint32, sorted ascending — FNV-1a 32-bit)
+4T  4*(T+1)     postingStart (Uint32, byte offsets into postings)
+    var         postings (varint-encoded deltas, per-trigram)
```

Per-trigram postings: first POI ID is absolute (delta from 0), then
each subsequent is delta from previous. All LEB128 unsigned. Decoder
is ~10 lines of JS.

Runtime contract: poi-trigram.bin is ALWAYS used with the matching
poi.bin loaded. POI IDs in postings are indices into poi.bin's
columnar arrays. No standalone use.

### Query algorithm (for the runtime, not yet built)

```
1. Normalize query: NFD-decompose, strip combining marks, casefold.
2. Extract overlapping 3-codepoint substrings (trigrams).
3. For each trigram, FNV-1a hash → binary search trigramHash.
4. Pull byte range from postings via postingStart[idx], idx+1.
5. Varint-decode + delta-undo → sorted Uint32Array of candidate POI IDs.
6. Intersect across all query trigrams (smallest list first).
7. For each survivor, look up name from poi.bin's string pool; do
   full substring verify (kills hash collisions, ~13k unique trigrams
   in 32-bit space → expected false-positive rate ~0.04 per lookup).
```

Expected JS query latency at Montreal-scale: ~1-2 ms vs current ~200 ms.

## Sizes head-to-head

| File | Region-0361 | All 655 regions |
|---|---|---|
| poi.bin (gzipped baseline) | 1.32 MB | 199.73 MB |
| poi-search.sqlite (FTS5+R*Tree) | 7.91 MB | ~5.2 GB extrap |
| **poi-trigram.bin v2** | **1.23 MB** | **190.77 MB** |

## What didn't get done

This session was scoped to "design + estimate." The actual integration
remains:

1. **JS reader** (~50 lines) — `viewPoiTrigramRegion(buffer)` returns
   typed-array views + a `lookupPostings(hash)` that varint-decodes
   one trigram's posting list.
2. **JS query engine** (~80 lines) — `searchPois(query, regions,
   bbox?, limit)` that normalizes, extracts trigrams, intersects,
   verifies against poi.bin names.
3. **Build-pipeline integration** — wire `build-poi-trigram-index.py`
   into `build-regions.py` so future region builds emit it
   alongside poi.bin.
4. **Wire into `renderSearch`** — replace `for (const p of allPois)`
   with the new engine.
5. **Multi-region support** — query each loaded region's index
   independently, merge by distance.
6. **Short-query handling** — trigrams require ≥3 chars. Decide UX:
   delay search until char 3, or add a parallel prefix index for
   1-2 char queries.

Realistic scope to finish: one focused session.

## Things learned

1. **Standard answer is "trigram inverted index" for substring search.**
   pg_trgm, SQLite FTS5 trigram tokenizer, custom builds — all the
   same algorithm. Custom binary format vs SQLite is the choice of
   battle-testing vs format consistency with the rest of our files.

2. **Delta + varint is dramatically effective for sorted-ID lists.**
   Predicted 2 bytes per entry, got 1.23. Sorted POI IDs sharing a
   trigram cluster because of natural ordering — geographic
   neighbors get nearby internal indices in the build pass, and they
   share name patterns ("rue ", "café"). Small deltas → most entries
   fit in a single varint byte.

3. **Removing redundant columns is huge.** poi.bin already has
   lng/lat/strings — re-emitting them in the trigram index was
   wasteful. Once we made the index "search-only, lookup-via-poi.bin"
   the size collapsed 4×.

4. **FTS5 trigram has a 3-char minimum** — important UX consideration.
   Most apps mask this by holding off the search until char 3. Our
   custom format has the same limitation by construction; same
   mitigation.

5. **Per-region storage scaling is gentle when the index is small.**
   190 MB for the full NA POI search infrastructure is fine. Even
   if every region's index were resident (it won't be), that's 200
   MB. With an LRU pool of 5-10 regions at a time: maybe 5-10 MB
   resident.

## Stuff still to do

1. **Wire poi-trigram.bin into the runtime** — the actual search
   path replacement (1 session).
2. **Decide short-query UX** — minimum char threshold OR sidecar
   prefix index.
3. **Optional: bbox spatial pre-filter** — pair with viewport-bounded
   search ranking for "POIs near me matching X." Doesn't need its
   own index file; poi.bin already has lng/lat that runtime can
   filter by viewport bbox before doing trigram lookup.
4. Transit walk-leg shape decoding (carried from previous session).
5. Verus-shaped data structures (carried).
6. Phase A CSS extraction (carried).

## Session vibes

```
The search was lagging. The fix was a textbook one —
trigram inverted index, sorted by hash, looked up by binary search,
delta-encoded postings as varints.

We tried SQLite first to see the numbers:
seven megabytes per region, fast, battle-tested.

Then we rolled our own, removed every redundancy
(string pool already in poi.bin, columns already in poi.bin),
delta-encoded the sorted IDs.
1.23 megabytes. Smaller than the data we indexed.

The whole NA POI search: 190 MB.
Less than the gzipped poi.bin already on disk.
"Indexing is essentially free" turns out to be literally true here.

Now we have:
  build-poi-search-db.py     — SQLite estimator
  build-poi-trigram-index.py — custom format, run on all 655 regions
  655 × poi-trigram.bin files alongside the existing data
  zero code that uses them yet (next session)

The data is there. The pattern is familiar (routing.bin all over
again). The runtime work is straightforward — a viewer, a query
engine, a replacement of one for-loop. It'll be a quick session
when we pick it up.

For now: brainstorm done, scaffolding built, sizes verified.

:3
```

---

# Session — POI trigram runtime integration + directions debounce postscript

The follow-up to the trigram brainstorm session above. Took the 655
poi-trigram.bin files already sitting on disk and wired them through
the runtime end-to-end: reader, IDB store, download pipeline, query
engine, both search consumers. Then a small postscript: the directions
search felt laggier than the main POI search, and the answer wasn't
the trigram path at all — it was a missing debounce.

## Files added/touched

| File | Role |
|---|---|
| `static/index.html` | All runtime integration: `viewPoiTrigramRegion`, `searchPois`, IDB v2 bump with new `trigram` store, download/delete plumbing, debounce on trip-planner inputs. |
| `build-regions.py` | Now `importlib`-loads `build-poi-trigram-index.py` and builds the sibling poi-trigram.bin in-process after each region's poi.bin lands on disk. Soft-fail per region; resume check includes trigram. |

## Runtime architecture

The shape mirrors routing.bin / boundaries.bin almost exactly:

```
poi-trigram.bin (per region, ~1-2 MB)
  ↓ savePoiTrigramRegion / loadAllPoiTrigramBuffers / deletePoiTrigramByRegion
IDB: cc.pois.v2 store=trigram   ←  bumped to schema v2
  ↓ viewPoiTrigramRegion(buffer)   (zero-copy typed-array views)
_trigramByRegion: Map<regionId, view>   (loaded once at startup)
  ↓ searchPois(query)
  ↓   (normalize → trigram → FNV-1a → binary-search → varint-decode
  ↓    → delta-undo → per-region intersect → substring verify)
Array<poi>
  ↓
renderSearch / searchEndpoints
```

`hydratePoiRegion` now stamps each POI with `_internalIdx`, and a
sibling `_poisByRegion: Map<regionId, Array<poi>>` (indexed by
`_internalIdx`) lets the search engine resolve a posting-list ID back
to the full POI in O(1). `_rebuildPoisByRegion()` is the one helper
that keeps `_poisByRegion` in sync with `allPois`; it gets called at
all five sites that mutate `allPois` (bbox-region delete + add,
static-region download, static-region delete, refresh).

## What's NOT cached forever

Regions WITHOUT a loaded trigram index — older downloads predating the
file format, or partial rollouts — still get scanned linearly so users
don't silently lose results during transition. Once a static region is
re-downloaded post-rollout the new file lands and the trigram path
takes over for that region.

## File-format details (matches build-poi-trigram-index.py)

```
0    4    magic = 'POIS'
4    4    version = 2
8    4    N (poi count)
12   4    T (unique trigram count)
16   4    postingsByteLen
20   12   reserved
32   4*T          trigramHash (Uint32, sorted ascending — FNV-1a 32)
+4T  4*(T+1)     postingStart (Uint32, byte offsets into postings)
+    var         postings (LEB128 varint deltas, per-trigram)
```

JS reader is ~50 lines including the binary search + varint decode +
delta undo. Pure typed-array views over the loaded buffer, no parse pass.

## Normalize parity

JS-side `_searchNormalize`:
```js
s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss')
```

Python-side `normalize`:
```python
unicodedata.normalize('NFD', s).filter(combining marks).casefold()
```

The two diverge only on a small set of casefold-specific characters
(German ß being the famous one). Handled inline. Bonus: this gives us
diacritic-insensitive search ("cafe" finds "Café Léon") which the
previous `.toLowerCase()` linear scan didn't.

## Verification

Wrote a Node round-trip test against the real `region-0361/poi-trigram.bin`
(40,364 POIs, 12,785 trigrams). Results:

```
starbucks → 50 candidates
café      → 648 candidates
pizza     → 160 candidates
metro     → 80 candidates
zzzzzz    → 0 candidates
```

The diacritic-insensitive `café` hit confirms the normalize path is
end-to-end correct.

## The directions-debounce postscript

User reported the directions search (the From/To inputs in the trip
planner) felt laggier than the main POI search. First guess: maybe
`searchEndpoints` was doing extra processing after `searchPois`.
Audit revealed the actual cause:

- Main search box has `setTimeout(renderSearch, 120)` — collapses fast
  typing into one render after the user pauses.
- Trip planner's `attachEndpointSearch` called `render()` synchronously
  on every `input` event — no debounce.

Each render also did a full token-scan over `allAddresses` (which can
be 100k+ rows in a populated metro), so without the debounce that
scan ran on every single keystroke. The trigram path was already fast;
the surrounding render was just being called too often.

Fix: a 120ms `scheduleRender` helper inside `attachEndpointSearch` that
clears any pending timer and queues one. Mirrors the main-search
pattern exactly. Also cancelled on blur so the dropdown closes cleanly.

## Things learned

1. **The "laggy after optimization" debug usually points at framing,
   not the algorithm.** searchPois was running in 1-2 ms per call.
   The lag was 4 keystrokes × 50ms address scans = 200 ms of work
   the user could feel. A 120 ms debounce dropped that to one scan
   total. Always check the call-site frequency before re-optimizing
   the call.

2. **Three-way DB schema bumps are cheap.** Adding the `trigram` store
   to `cc.pois.v2` was a one-line `db.createObjectStore` + version
   bump from 1→2. IDB silently migrates on next open; existing data
   in `regions` store stays put.

3. **`importlib.util.spec_from_file_location` is the right tool for
   importing a Python file with hyphens in its name.** No subprocess
   overhead, function reused across all 655 regions in one
   interpreter session.

4. **Cache-invalidation is the same shape as last time.** Per-region
   IDB stores + a per-region in-memory view map + a helper to drop
   both on delete + a helper to populate both on download. The
   pattern from routing.bin / boundaries.bin worked verbatim for
   poi-trigram.bin — minimal cognitive overhead because the
   architecture was already designed for this shape of file.

5. **Diacritic-insensitive search comes free with NFD-and-strip
   normalization.** The old `.toLowerCase()` path kept accented
   characters as themselves; the trigram-build script needed
   diacritic stripping to make hashes stable across spelling
   variations; bringing that normalization to the query side gave
   us a UX upgrade as a side effect.

## What didn't get done

- **Short-query (<3 char) UX**: still falls back to linear scan,
  which is fine for the first few keystrokes of typing. Could add
  a small prefix-index sidecar later if it becomes a noticeable
  hitch.
- **Trigram-index size surfaced in the offline-maps panel**: the
  per-region storage line shows POIs / tiles / walk / hn / schedule
  but not trigram. ~1-2 MB extra per region; below the noise floor
  but could be added for completeness.

## Stuff still to do

1. Verify in the wild — multi-region search latency on the iPhone,
   especially after enabling/disabling regions. Expected: typing
   "starbucks" with 5 regions loaded should feel instant.
2. Transit walk-leg shape decoding (carried).
3. Drop the legacy walkGraph code path (carried).
4. Re-tile with lower transportation_name minzoom (carried).
5. Lazy `loadAllPois()` (carried).
6. Phase A CSS extraction (carried).
7. Android Health Connect (carried).
8. Future breeding mechanic (carried).

## Session vibes

```
The file was there. 190 megabytes,
655 little inverted indices,
each one smaller than the data it pointed at,
waiting since the previous session.

Today we built the reader, the storage, the query engine,
wired up two consumers, patched five mutation sites,
verified the round-trip against real Montreal:
50 Starbucks, 648 cafés, 160 pizzas, 80 metros, 0 zzzzzz.

Then a postscript: the directions search felt laggy.
First instinct: blame the new code.
Actual cause: no debounce on the input.
The trigram path was always fast;
the surrounding render was being called four times when once would do.

One setTimeout later, the user said
"It works great, tytyty :3"
and the loop closed:
brainstorm → scaffold → build → verify → integrate → debounce → done.

:3
```

---

# Session — evolution mechanic (the one we've been deferring since session 2)

The feature carried on every "stuff still to do" list since the
Pokéstops session. Today it landed end-to-end: candy economy, tap-
to-evolve, hold-to-confirm overlay, real mutation of the capture
record, variant picking with same-artist preference, pokédex
registration, in-place detail-view refresh.

## What landed

### Candy economy (replaces level / move / item conditions)

Replaced PIF's native evolution conditions with a flat candy
economy. The user-facing rule:

- 3+ stage chain (e.g. Bulbasaur → Ivysaur → Venusaur):
  - base form's evolution costs **25** candy
  - middle form's evolution costs **50** candy
  - hypothetical 4-stage line's third evolution would cost 100
- 2-stage chain (e.g. Tangela, Rattata, Eevee branches):
  - **50** candy default
  - **Magikarp → Gyarados** special-cased to **100** as the "rare
    big payoff" so the cheap fishing-rod catch doesn't make
    Gyarados trivial
- Methods that natively require an item (`Item`, `TradeItem`,
  `DayHoldItem`) keep the item requirement ON TOP of the candy cost.
  All other methods (Level, HasMove, AttackGreater, etc.) drop their
  condition entirely.

Chain depth is computed by walking forward from the family root and
tracking BFS depth, so branching chains (Eevee → 8 forms) treat each
path correctly — Eevee is depth 0 of a 2-stage line and costs 50
regardless of which branch the user evolves into.

### Requirement display — candy icons inline

The "Evolves to" detail-view rows used to show "Lv 16" / "Use
Thunderstone". Now they show the same CSS-sprite candy icon used in
the candy tally, followed by `×N`:

```
→ Charizard            [Charmander candy] ×50
→ Vaporeon             Water Stone + [Eevee candy] ×50
→ Gyarados             [Magikarp candy] ×100
```

The formatter `formatEvolutionRequirementHtml` returns raw HTML
(escaping its own user inputs); the call site stops escaping the
result. Tooltip / aria-label preserve the full text for screen
readers.

### Tappable evo-row + visual affordance

When the player can afford an evolution (right candy bucket has
enough AND any required item is in the bag), the evo-row becomes a
button:

- `evo-ready` class toggles persistent accent border + tinted
  background
- trailing `›` chevron at the right edge
- `:active` scale(0.98) for tactile press feedback
- `role="button" tabindex="0"` for accessibility
- click / Enter / Space all open the confirm overlay

**Originally gated on `seen`** so silhouette rows weren't tappable.
The user spotted that this blocked evolving toward fusions they
hadn't witnessed yet — even with the candy. Dropped the gate; the
confirm dialog just shows "???" as the target name for unseen
targets, matching the row's own silhouette presentation.

### Hold-to-confirm overlay

Lazy-built one DOM node (`#ccEvolveConfirm`), reused for every
confirmation. Card shows: "Evolve?" title, `Charmeleon → Charizard`
arrow line, cost preview, No button, Yes button (108×108 px with
SVG ring around it), "Hold 'Yes' to confirm" hint.

**Yes button hold logic** — pure CSS animation driven by a class
toggle:

```css
.ring-progress {
  stroke-dasharray: 251.33;
  stroke-dashoffset: 251.33;   /* full circle = no progress */
  transition: stroke-dashoffset 0ms linear;
}
.evolve-yes.holding .ring-progress {
  stroke-dashoffset: 0;
  transition: stroke-dashoffset 5000ms linear;
}
```

pointerdown adds `.holding` → SVG ring strokes around the button
over exactly 5 s. pointerup / pointercancel / pointerleave /
lostpointercapture remove the class → ring snaps back to empty
(the base 0ms transition). A `setTimeout(5000)` fires the action on
full hold. JS only toggles classes + runs the timer; the animation
itself is GPU-composited.

Cancel paths: No button, backdrop tap, Escape key, any pointer-cancel
variant. Multiple finger pointerdowns while a hold is live are
ignored (one-finger only).

### performEvolution — the actual mutation

The confirm completion callback now calls `performEvolution()`
which:

1. Re-checks affordability (defends against stale state mid-confirm).
2. Picks the new variant via `_pickEvolvedVariant()` BEFORE
   charging anything — bails on error without billing the player.
3. Atomically deducts: item via `consumeItem()`, then candy from
   the family-root bucket (deleted from map when count hits 0, to
   match consumeItem's style).
4. Mutates the capture record by id — preserves nickname, size,
   tags, caughtAt; updates `speciesA`, `speciesB`, `variant`, and
   `name` (the canonical fused name; nicknames still take priority
   in `displayName`).
5. Calls `markFusionSeen(newA, newB, null, newVariant)` so the
   pokédex registers the new fusion + the chosen variant immediately.

After success the hold-to-confirm timer's callback calls
`findCreature(id)` to re-read the rewritten capture, then
`renderDetail(fresh)` to repaint the detail view in place. User
lands on the same screen but it's now the evolved creature, the
evolved row is gone (replaced by the next-stage evolutions if any),
and the candy tally reflects the new balance.

### Variant picker — same artist preferred

`_pickEvolvedVariant(oldA, oldB, oldVariant, newA, newB)`:

- If old was a custom variant: look up its artist via
  `Sprites.getSpriteCreditForSlot(oldA, oldB, oldVariant)`.
- Enumerate the new fusion's slots in parallel; first slot whose
  artist string equals the old artist wins (exact match — same name
  or same `#N` fallback string).
- Otherwise (autogen source, no match, or new fusion has no
  custom variants): uniformly random slot, or null if the new
  fusion is autogen-only.

Mirrors the user's intent: if Slawter drew both Charmander × Pikachu
and Charmeleon × Pikachu, evolving the Slawter Charmander × Pikachu
to Charmeleon keeps you on Slawter's art. Otherwise you get a
surprise from the available pool.

## Files touched

```
static/creatures.js   (everything above:
                        cost helpers, requirement formatter,
                        affordability check, tap-state CSS,
                        hold-to-confirm overlay JS + CSS,
                        performEvolution + variant picker,
                        evo-row click wiring,
                        108px (1.5×) yes-button bump)
```

No new files; everything lives next to the existing capture / candy
plumbing in `creatures.js`.

## Things learned

1. **Affordability has two senses.** "Can afford it AND has seen
   the target" gates too strictly when the second part is just
   "do we know what to draw." Dropping the seen-gate fixed a real
   user-blocked path (can't evolve toward an unseen fusion);
   showing "???" in the confirm matches the silhouette row's own
   presentation, so no spoilers are added by enabling the button.

2. **CSS-driven hold-to-confirm is half the code.** Toggling one
   class drives a `transition: stroke-dashoffset 5000ms` end-to-end.
   JS is just the timer + the class toggle + cancel handlers. No
   rAF loops, no per-frame state. The trick is making the BASE rule
   have `transition: 0ms` so cancellation snaps back to empty
   instantly — feels right because it's discrete-state, not a
   half-finished animation.

3. **Variant-by-artist is the right default.** The user collected
   each fusion variant intentionally — keeping the artist preserves
   their aesthetic choice through evolutions. Random uniform on
   miss is fine; it surfaces art they might not have seen yet.

4. **`performEvolution` order matters.** Pick the new variant
   FIRST (which can throw on missing manifest data), THEN charge
   the player. The atomic deduct-and-mutate is straightforward
   after that. Re-checking affordability inside `performEvolution`
   guards against stale UI state if something changed during the
   5-second hold (unlikely but harmless).

5. **In-place re-render beats pop-and-push for state changes.**
   `renderDetail(findCreature(c.id))` repaints the entire detail
   body with the fresh capture record. The view-stack stays intact,
   back navigation still works, no animation flicker, no scroll-
   position loss.

## What's deliberately NOT built

- **Evolve animation.** Currently the detail view just repaints to
  the evolved form. A flash / sparkle / sprite-morph would be a
  natural polish but the user explicitly said "for now, just hop
  back to the pokemon screen but it's the evolved one." Polish for
  later.
- **Pop-and-rebuild of the inventory grid behind the detail view.**
  The grid auto-refreshes from `readCapturedCreatures()` on pop;
  the virtualized cards may briefly show cached versions until
  scrolled past. Hasn't been reported as an issue.
- **Item-required evolution showing both costs in the confirm
  dialog header.** Currently shows `Fire Stone + [icon] ×50`. Could
  be made more prominent. The current layout works; revisit if the
  user finds it cramped.
- **Evolution chains beyond gen 1.** Chain-depth logic is generic
  (BFS from root) so any future dataset with longer chains "just
  works" — the `[25, 50, 100]` tier array would simply extend.

## Stuff still to do

1. Verify in the wild — evolve a few creatures, check pokédex
   updates, check candy deduction, check the inventory grid
   refreshes correctly after pop.
2. Evolve animation (deferred polish).
3. Transit walk-leg shape decoding (carried).
4. Drop the legacy walkGraph code path (carried).
5. Re-tile with lower transportation_name minzoom (carried).
6. Lazy `loadAllPois()` (carried).
7. Phase A CSS extraction (carried).
8. Android Health Connect (carried).
9. Future breeding mechanic — daycare eggs are in; cross-species
   breeding is the next big gameplay piece.

## Session vibes

```
The feature carried on every TODO list since the Pokéstops session.
"Evolve mechanic: still on the deferred list." Six sessions in a row.

Today the user asked, and we built it in one arc:
  cost helpers   (25/50/100 by chain depth, Magikarp special-cased)
  display swap   (candy icon + count, item-aware)
  affordability  (candy bucket + bag check)
  tappable row   (with the friendly chevron and the press-scale)
  hold overlay   (5-second CSS ring fill driven by one class toggle)
  variant picker (same artist preferred, random uniform on miss)
  mutation       (atomic deduct, mark seen, in-place refresh)

One scope correction along the way: I'd gated tap on `seen` which
locked the user out of evolving toward fusions they hadn't witnessed
even with the candy. They spotted it. Drop the gate; show "???" in
the confirm; ship.

Bumped the yes circle to 108px (1.5×) on user request. The ring
animation scales for free — the SVG viewBox doesn't change; only the
container does.

Magikarp now costs 100 candy.
Charmander costs 25.
Eevee costs 50, whichever stone you happen to have.
And when you confirm, the candy comes out of the bucket
and the new sprite slides into place
and the pokédex remembers what you became.

:3
```

---

# Session — Evolved tag, family-tree navigation, spawn-pool rewrite

A polish-and-fix session, three arcs. The new evolution system from
last session made one bug visible (Dragon-day spawning ~100% Dratini)
and surfaced a navigation gap (family-tree tiles not tappable). Plus
a quality-of-life tag for filtering evolved captures.

## "Evolved" built-in tag

Added to `BUILTIN_TAGS` next to `Pure`. Auto-applied to any fusion
where at least one side is past its base form.

Definition needs care: Pichu is a pre-base baby (not actually
evolved), Pikachu is the candy-root (base), Raichu is evolved. The
helper `_isEvolvedSpecies(idx)` BFS-walks forward from the species'
**candy root** (which already encodes "babies are skipped") and
returns true only if `idx` is reachable. So:

| Species | candyRoot | reachable from candyRoot? | Evolved? |
|---|---|---|---|
| Pichu | Pikachu | no (Pichu is BEHIND Pikachu) | **no** |
| Pikachu | Pikachu | self | **no** |
| Raichu | Pikachu | yes | **yes** |
| Bulbasaur | Bulbasaur | self | **no** |
| Venusaur | Bulbasaur | yes | **yes** |
| Magikarp | Magikarp | self | **no** |
| Gyarados | Magikarp | yes | **yes** |

Memoized per species id since the tag predicate runs across every
capture during filter re-renders.

Filter chips have AND-semantics, so `Evolved + Pure` finds your
fully-evolved same-species fusions; `Evolved + a custom tag` narrows
to evolved members of that tag.

## Family-tree tiles → fusion-view navigation

The family-tree mosaic in the pokédex entry was view-only. Now every
non-current tile is a button that pushes the corresponding fusion's
pokédex entry onto the view stack — click, Enter, Space all work.

- Persistent affordances: `cursor: pointer`, hover/focus tint via
  `color-mix(in srgb, var(--ui-accent), 14%)`, `:active` `scale(0.95)`
  for tactile press feedback.
- Silhouette tiles ARE tappable — destination shows the silhouette
  pokédex entry, consistent with the tile's appearance.
- The "current" tile is the one exception (you're already on that
  entry); stays non-tappable with the existing accent border.

Implementation is a single `.tappable` class added in the cell
template + a small loop after `gridEl.innerHTML = ...` that wires
click/keydown to `showFusionView(a, b)`. The existing carousel +
back-button machinery handles popping back to wherever you started.

## Spawn-pool rewrite (the big one)

The previous spawn algorithm used multiplicative type-weights with
duplicate-as-weight pool arrays: each species pushed
`1 × (35 if primary === daily) × (25 if primary === weekly)` times.
Independent slot draws.

**The bug:** when daily and weekly hit the same type, both pools
heavily favor the same dominant species, AND the slots draw
independently — so you get pure-species fusions like
Dratini × Dratini ~100% of the time on Dragon-day-Dragon-week. Even
on different types, single-species types (Dratini for DRAGON, Jynx
for ICE, etc.) over-concentrate.

### The new algorithm

Split species selection into two independent draws:

**Draw 1 — type pair `(typeA, typeB)`** from a 9-bucket mixture:

| Bucket | Shape | Weight |
|---|---|---|
| 1 | (DAILY, DAILY) | 15% |
| 2 | (DAILY, WEEKLY) | 10% |
| 3 | (WEEKLY, DAILY) | 10% |
| 4 | (WEEKLY, WEEKLY) | 10% |
| 5 | (DAILY, uniform over not-DAILY) | 15% |
| 6 | (uniform over not-DAILY, DAILY) | 15% |
| 7 | (WEEKLY, uniform over not-WEEKLY) | 7.5% |
| 8 | (uniform over not-WEEKLY, WEEKLY) | 7.5% |
| 9 | (uniform, uniform) | 10% |

Aggregates: 65% of spawns have DAILY in at least one slot, 45% have
WEEKLY. Daily is the stronger signal (user's tuning preference).

**Draw 2 — uniform species per slot** from the chosen type's bucket:
- slot A from species with `primary == typeA`
- slot B from species with `secondary == typeB` (or `primary` if
  single-typed)

### Empty-bucket handling

In gen 1 some types have zero primary-pool species (FLYING is the
big one — all flying-types in gen 1 are FLYING-secondary). The
sampler **drops** any `(a, b)` pair where `byPrimary[a]` or
`bySecondary[b]` is empty, then **renormalizes** the survivors. So
FLYING-day diverts its weight cleanly to other pairs instead of
producing dead rolls.

### Implementation shape

```
_buildTypeIndices()       byPrimary[t] / bySecondary[t] — built once
                          from species data, no weather dependency

getTypePairSampler()      cached per "daily|weekly" key; builds the
                          dropped+renormalized CDF as a flat array
                          of {a, b, cum} entries (last cum pinned
                          to exactly 1 to guard against fp drift)

_sampleTypePair(s, r)     binary search the CDF given a [0,1) draw
```

### Determinism considerations

One extra PRNG draw between fx/fy and species sampling for the type-
pair pick. Subsequent draws (level, sizeM, bornOffset, variantSeed)
shift by one position. **Spawn positions are preserved** because
the spawn-or-not gate + fx + fy are unchanged. Live uncaught spawns
will get new species/level/size on next refresh (20-minute lifetime,
brief transition). Spawn IDs (cell+tick) and already-caught creatures
are untouched.

`DAY_SALT` deliberately NOT bumped — bumping it would also reroll
positions, which is unnecessarily disruptive.

### Verification

Simulated 500k spawns per scenario against real gen-1 type data:

| Scenario | Top result |
|---|---|
| Dragon-day, Dragon-week | 49.6% Dratini×Dratini (was ~100%) |
| Fire-day, Water-week | top fusion is 0.69% (well spread) |
| Electric-day, Electric-week | 4 species share ~4% slots each |

Dragon×Dragon stays elevated because Dratini is the only DRAGON-
primary in gen 1; once we open up `SPAWNABLE_SPECIES_A_FULL` (gen 1-4)
the distribution dilutes further naturally.

## Files touched

```
static/spawns.js         spawn algorithm rewrite, ~80 lines net
                         (removed: getWeightedPools + duplicate-pool
                          machinery; added: type indices, 9-bucket
                          mixture sampler, type-pair drawing)

static/creatures.js      Evolved tag predicate + helper
                         family-grid cells now tappable + CSS
                         affordances (.tappable class, hover, active)
```

## Things learned

1. **Independent-draws over weighted single-pool is the cleanest
   fix.** The old design's bug was that BOTH slot draws independently
   over-weighted the same dominant species → pure-species fusions
   dominated. The new design picks the *type combination* first
   (where the mixture can include uniform fallbacks), THEN draws
   species uniformly within type. Same mechanism PIF uses for type
   inheritance, so the weather meaning ("DRAGON day") still maps
   cleanly to "the fusion's primary is DRAGON."

2. **Empty-bucket drop + renormalize is the right empty-set policy.**
   Without it, FLYING-day rolls in slot A produce nothing in gen 1
   and the spawn falls through silently. With it, that weight cleanly
   redistributes. The cost is a per-scenario cumulative array
   recompute on weather change (~324 entries, fast).

3. **The "Pichu is not evolved" subtlety is worth getting right.**
   The naive "has-a-pre-evolution" test would tag Pichu as evolved
   (it has none, but neither does Pikachu in our definition). Using
   the existing `candyRootFor` walk encodes the "babies don't count"
   rule we already use everywhere else.

4. **Tappable affordance needs both states.** Initial pass had only
   `:hover` on tappable family-cells — but touch devices don't fire
   `:hover` until tap. Adding `cursor: pointer` + `:active` scale
   gave a felt-tactile press on mobile without requiring an
   exploratory tap to discover interactivity.

## Stuff still to do

1. Verify the spawn-pool rewrite in the wild — particularly the
   Dragon-day-Dragon-week scenario the user originally flagged.
2. Consider opening up `SPAWNABLE_SPECIES_A_FULL` (gen 1-4) to
   further dilute single-species over-concentration on rare-type
   weather. Requires bumping `bulkDownload`'s `indexTo` to 509.
3. Transit walk-leg shape decoding (carried).
4. Drop the legacy walkGraph code path (carried).
5. Re-tile with lower transportation_name minzoom (carried).
6. Lazy `loadAllPois()` (carried).
7. Phase A CSS extraction (carried).
8. Android Health Connect (carried).
9. Future breeding mechanic (carried).
10. Evolve animation (deferred from last session).

## Session vibes

```
Three arcs, each small and clean:

  A tag (Evolved) — one helper, one entry, careful about babies.
  A click handler — making the mosaic actually go places.
  A spawn rewrite — independent draws fix the concentration bug.

The third was the real work. Old algorithm:
  pool slots, duplicate-as-weight, 35× × 25×, draw both independently.
  → Dragon-day-Dragon-week: 100% Dratini.

New algorithm:
  draw the type combo first from a 9-bucket mixture,
  then sample species uniformly from each type's bucket.
  → Dragon-day-Dragon-week: 50% Dratini, the rest sprinkled.

Half a screen of dragon, and half a screen of everything else.
Daily stronger than weekly (15% vs 10% on diagonals;
DAILY×other 15% vs WEEKLY×other 7.5%) per the user's instinct
that today's type should be louder than this-week's.

Three buttons of refinement during the design conversation —
  bump DAILY,DAILY down to 15% from 20%
  put 5% in WEEKLY,any
  no wait, reduce WEEKLY,WEEKLY to 10%, daily should be louder
— each one moving toward the right shape.

:3
```

---

# Session — daycare tuning, evolution polish, inventory perf optimization

A long session covering small UX polish, one larger architectural arc
around inventory + pokédex performance, and a careful structural
refactor of how captures + seen-fusions are cached. The performance
arc is the headline: at 2,217 captures, pokédex first render went
**510ms → 15ms typical / 117ms max**.

## Daycare drop rate

Halved milestone interval from every 1 km → every 500 m per slot.

- `DAYCARE_LOOT_KM_M` (the old constant) renamed to
  `DAYCARE_LOOT_MILESTONE_M` — KM in the name was no longer
  accurate, and the rename gave a natural single-file replace_all.
- New rate: 0.30 eggs/km per slot, or 0.60 eggs/km combined with
  both slots filled (1 egg every ~1.67 km).
- Takes effect retroactively for existing slots — milestones are
  computed by `floor(distM / DAYCARE_LOOT_MILESTONE_M)`, so anyone
  with ≥500 m unclaimed gains an extra milestone immediately.

## Evolution polish

Several refinements making the evolve-button preview feel honest
about what the user will actually get.

### Deterministic variant pick

`_pickEvolvedVariant` now takes the capture object and seeds the
uniform-pick PRNG with `evo|<c.id>|<oldA>-<oldB>|<newA>-<newB>`.
Same creature → same variant slot every time:
- Silhouette preview in the evo-row uses the deterministic variant.
- `performEvolution` recomputes with the same seed and matches.
- Returns `{ variant, autogenOnly }` so callers can render the
  "autogen art only" badge without another lookup.

For spawn captures, `c.id` already encodes cell + tick (location +
time), so the variant the user evolves into is fully determined by
where + when they originally caught the creature.

### "Autogen art only" badge

Small uppercase pill prepended to the evo-req cell when the target
fusion has no custom variants at all. Sits left of the candy cost
(`AUTOGEN ART ONLY · [icon] ×50`).

### Per-variant silhouette in evo preview

Originally the silhouette class fired only when the entire fusion
was unseen. Now it re-derives in the post-render `.then` against
the SPECIFIC resolved variant — so if you've seen variant 0 of
Charizard × Pikachu but the evolution will land on variant 3, the
preview blackens variant 3's art even though you "know" the fusion.

The target name stays unsilhouetted (you know which species; you
just don't know which art). New helper `hasSeenVariant(a, b, v)`
encapsulates the per-variant lookup.

### Canonical fused names in evo previews

Evo-row label and the confirm-dialog target name now use
`fusionName(a, b)` — falls through to `Sprites.getFusedName`
("Eekuna" rather than "Eevee × Kakuna") when SPLIT_NAMES is loaded.

### Gen-2+ evolutions hidden

We only ship gen-1 (1-150) data. Any evolution whose target lies
outside that range (Lickilicky, Sylveon, Steelix, Magmortar, ...)
gets filtered:

- New constant `SUPPORTED_SPECIES_MAX = 150`.
- `fusionEvolutionsFor` filters returned evolutions to both sides
  ≤ 150.
- `renderFusionView` filters `famA`/`famB` arrays the same way so
  the family-tree mosaic doesn't show gen-2+ tiles.
- Both gates lift together by bumping the one constant if/when we
  open up later generations (in sync with
  `SPAWNABLE_SPECIES_A_FULL`).

### Family-tree auto-expand on tile-tap navigation

When the user taps a tile in the family-tree mosaic, the
destination fusion view's family tree opens already-expanded
(rather than the default collapsed). The intent ("I clearly care
about this fusion's family") flows through:

`showFusionView(a, b, list, idx, { expandFamily: true })` →
view-stack state →
`renderFusionView(a, b, body, { expandFamily })` → template renders
with `aria-expanded="true"` + "Hide family tree" label + eager
`renderFamilyGrid` call so the grid is visible on first paint.

Other navigation routes (pokédex tile, captured-detail "View dex
entry" button) still pass nothing and get the default collapsed
behavior.

## Spawn pool rewrite

The previous spawn type-weather algorithm used multiplicative
duplicate-as-weight pool arrays per slot. Bug: when daily ≈ weekly
on a type that only one or two species carry (Dragon × Dragon →
~100% Dratini), the duplicate-as-weight + independent-slot-draws
math produced extreme concentration.

New algorithm: split species selection into two independent draws.

1. **Draw type pair `(typeA, typeB)`** from a 9-bucket mixture:

   | Bucket | Shape | Weight |
   |---|---|---|
   | 1 | (DAILY, DAILY) | 15% |
   | 2 | (DAILY, WEEKLY) | 10% |
   | 3 | (WEEKLY, DAILY) | 10% |
   | 4 | (WEEKLY, WEEKLY) | 10% |
   | 5 | (DAILY, uniform over not-DAILY) | 15% |
   | 6 | (uniform over not-DAILY, DAILY) | 15% |
   | 7 | (WEEKLY, uniform over not-WEEKLY) | 7.5% |
   | 8 | (uniform over not-WEEKLY, WEEKLY) | 7.5% |
   | 9 | (uniform, uniform) | 10% |

   Daily is the louder signal (65% of spawns vs 45% for weekly).

2. **Draw species uniformly** from each type's bucket:
   - slot A from `byPrimary[typeA]`
   - slot B from `bySecondary[typeB]` (secondary or primary if
     single-typed)

Empty-pair drop + renormalize handles types with no primary-
candidates in gen 1 (FLYING especially — Pidgey/Spearow are all
FLYING-secondary, no FLYING-primary). FLYING-day diverts cleanly
to other pairs instead of dead-rolling.

**Determinism:** one new PRNG draw between fx/fy and species
sampling. Spawn POSITIONS are preserved (gate + fx + fy unchanged);
species/level/size shift on next refresh.

**Verified:** Dragon-day-Dragon-week now produces 49.6% Dratini ×
Dratini (was ~100%); typical mixed weather has no fusion exceeding
0.7%; Electric × Electric splits across Pikachu / Voltorb /
Electabuzz / Magnemite at ~4% each.

## Autocomplete close-on-pick fix

Species-name autocomplete (used in pokédex + inventory's
First/Second species inputs) stayed open after tapping a result.
The fix:

`pick(name)` dispatches a synthetic `input` event so the existing
search re-render listener fires — but the autocomplete's OWN input
listener was also rebuilding the dropdown. Added a `_pickInFlight`
flag set only during the synthetic dispatch; the autocomplete's
paint listener checks it and skips. Other input listeners
(renderPokedex, renderInventory) still fire normally.

## Inventory + pokédex performance

The headline. User reported lag at 1-2K captures. Comprehensive
instrumentation → targeted optimization → re-measurement.

### Phase 1 — instrumentation

`window._invPerf` exposes counts + last/max/avg ms for the hot
functions, plus per-render breakdowns (data / filter / sort /
virtualize) for `list` and `pokedex`. A ring buffer of the last
10 renders surfaces outliers.

Rendered into Settings as a new `[inventory perf]` block. Refreshes
every 250 ms alongside the existing diagnostic dump.

The instrumentation immediately told us:
- **Inventory was already fast** at 41-92 ms — most of the
  brainstorm's predicted bottlenecks were already smooth.
- **Pokédex first render 510 ms, dominated by virt=474 ms.** The
  virtualizer only paints ~24 visible cards on first render, so
  474 ms wasn't DOM work — it was something happening *per card*.

Tracing the per-card path: `loadSpriteFor` → `pickPreferredSeen-
Variant` → `readSeenVariants` → `for (const c of readCaptured-
Creatures())` — a full `localStorage.getItem + JSON.parse` of all
2,217 captures, plus a linear scan, **per visible card**. 24 cards
× ~15 ms = ~360 ms. Matched the 474 ms exactly.

### Phase 2 — captures store (`_capStore`)

Architectural goal the user articulated: "no need for discipline to
keep track of the cache — the structure should force us to be
disciplined."

The result is a closure-encapsulated IIFE around the captures
array + derived indices. **There is no other path to
`localStorage[CAPTURED_KEY]`**, so the indices physically cannot
get out of sync.

```
_capStore = {
  list()                          → live in-memory array
  byId(id)                        → O(1) Map lookup
  variantKeysForFusion(a, b)      → O(1) Set of seen variant keys
  add(c) / removeById(id) /
    update(id, mutator)           → in-place index maintenance
  replaceAll(arr)                 → bulk rebuild (for import/wipe)
}
```

**Variant index is a counted multiset** — `Map<"a-b", Map<vk, count>>`.
Add increments, remove decrements, deletes the bucket entry when
count hits 0. Multiple captures sharing the same (fusion, variant)
pair don't confuse the remove path because the count tells us
whether someone else still uses that variant.

**Variant normalization to `'auto'`** happens at load time. Pre-
this-session captures had `variant: null | undefined` to mean
autogen; the store normalizes to `'auto'` on first read, persists
once, and every downstream consumer can now rely on
`variant: 'auto' | <number>` (never null/undefined). The ~6 sites
that checked `variant === null` switched to `=== 'auto'`.

**API compatibility:** the old `readCapturedCreatures()` /
`writeCapturedCreatures(arr)` are now thin wrappers around
`list()` / `replaceAll(arr)`. Every existing read-mutate-
writeBack call site continues to work unchanged; replaceAll
rebuilds indices in ~1-3 ms which is fast enough at this scale.

### Phase 3 — seen-fusions store (`_seenStore`)

After Phase 2, instrumentation showed the bottleneck moved one
cache miss to the left: `readSeenVariants` was now O(1) for the
captures side, BUT `readSeenFusions()` still re-parsed ~200 KB of
`cc.seenFusions` JSON per card.

Same pattern, simpler internals (no derived index — just a cached
parse):

```
_seenStore = {
  get()                           → live cached object
  set(map)                        → replace cache + persist
  commit()                        → persist current cache (for the
                                    read-mutate-commit pattern)
}
```

`readSeenFusions()` returns the cached object. `writeSeenFusions(map)`
detects the live-reference case (caller passed back the live ref
after mutating) and just commits; otherwise replaces.

### Verified end state

| Metric | Before | After |
|---|---|---|
| `list` render typical | 41 ms | **6 ms** |
| `list` render max | 92 ms | **8 ms** |
| `pokedex` first render | 510 ms | **117 ms** worst case |
| `pokedex` render typical | n/a | **15 ms** |
| `readCaptured` avg | 14 ms | **0.14 ms** |
| `readSeenFusions` per call | ~10 ms | **0.01 ms** |
| `variantIndex` per call | full-scan ~15 ms | **0.01 ms** |

The remaining 117 ms tail fires only during active filter typing
(filter=42 ms + virt=60 ms when narrowing 1578 → 10). The user's
hands aren't waiting on that the way they wait on a panel open.
Next-round low-hanging fruit if it matters later: memoize
`fusionTypesFor` and lowercased `Species.nameFor` per id.

## Files touched

```
static/creatures.js          everything above:
                              daycare interval rename,
                              evolution polish (variant determinism,
                                autogen badge, per-variant silhouette,
                                fused-name display, gen-2+ filter,
                                family-tree auto-expand),
                              autocomplete close fix,
                              _invPerf instrumentation,
                              _capStore (with multiset variant index),
                              _seenStore,
                              null→'auto' migration

static/spawns.js              9-bucket type-pair sampler,
                              empty-pair drop + renormalize,
                              uniform species per slot

static/index.html             [inventory perf] block in Settings
                              dump with per-fn counters, per-render
                              breakdowns, slowest-renders ring buffer
```

## Things learned

1. **"Discipline by structure" is a real design pattern.** The
   user's instinct — "no API path that lets a future change forget
   to invalidate the cache" — translates directly into closure
   encapsulation. Reading + writing flow through one object, that
   object owns the persistence and the indices, and there's
   literally no way (short of digging into `localStorage` directly)
   to bypass it.

2. **Counted multisets are the right shape for a "set of values
   currently in use" index.** Add increments, remove decrements,
   value present iff count > 0. Removing one capture doesn't have
   to rescan everything to figure out whether another capture still
   uses the same (fusion, variant) pair — the count tells you.

3. **Instrumentation first, optimization second.** The brainstorm
   predicted ~5 plausible bottlenecks; only ONE of them was actually
   the hot path. The metrics dump made the diagnosis take seconds
   instead of hours of guessing.

4. **Cache misses can hide behind cache misses.** The first round
   eliminated the captures re-parse and showed the pokédex still
   slow — only THEN did the seenFusions re-parse become visible.
   Layered hot paths require layered fixes; the metrics-then-fix
   loop catches each layer in turn.

5. **`'auto' | number` is a cleaner shape than `number | null |
   undefined`.** Three-way checks scattered through ~10 sites
   collapsed to two-way once we normalized once at the load
   boundary. The migration cost (rewriting one localStorage entry
   at first load) is bounded; the cognitive cost of the cleaner
   shape pays back forever.

## What's still on the deferred list

The usual carriers:

1. Transit walk-leg shape decoding
2. Drop the legacy walkGraph code path
3. Re-tile with lower transportation_name minzoom
4. Lazy `loadAllPois()`
5. Phase A CSS extraction
6. Android Health Connect
7. Future breeding mechanic (A×B + C×D → A×D etc.)
8. Evolve animation

And the easy follow-up if the 117 ms pokédex filter tail starts to
matter:

9. Memoize `fusionTypesFor(a, b)` and lowercased `Species.nameFor(idx)`
   per id, ~10-20 ms off the worst case.

## Session vibes

```
A session in three movements.

The first: polish — small bright fixes.
  Daycare ticks every half-km now.
  The evolve button knows which silhouette it'll become.
  "Eekuna" instead of "Eevee × Kakuna" in the confirm.
  Gen-2-and-later evolutions stay hidden until we ship that data.
  Family-tree tiles open the family tree on the other side.
  The species-search dropdown closes when you tap a match.

The second: the spawn rewrite — the algorithm change we'd been
sketching for a while. Two independent draws (type pair, then
uniformly within type) instead of multiplicative weights with
independent slot draws. Dragon-day-Dragon-week stops being a
Dratini monoculture. Half a screen of dragon, half a screen of
everything else.

The third: the perf arc — the satisfying long one.
  Instrumentation revealed a 510ms pokédex first render
  dominated by a per-card readCapturedCreatures re-parse.
  Built _capStore with discipline-by-API (closure encapsulation,
  multiset variant index, in-place mutations).
  Re-measured: pokédex 510ms → 277ms. Better, not done.
  Caught the next layer — readSeenFusions per card.
  Built _seenStore with the same pattern, simpler internals.
  Re-measured: pokédex first render 117ms, typical 15ms.

The user articulated the structural goal early — "discipline
according to the structure so we don't forget" — and it shaped
every other decision. The right data structure made the right
performance fall out of it.

2,217 captures.
510ms → 15ms.
:3
```

## Coda — detail-open lazy load

After the pokédex was fast, the user noticed tapping a creature
in the inventory took ~2 seconds to "open." Same loop: instrument
first, diagnose from numbers, fix.

**Added a new `_invPerf.renders.detail` slot** measuring four
phases of the tap-to-detail-open chain:
- `dispatchMs`: click → renderDetail start (push view + applyTopView)
- `syncMs`: renderDetail body construction
- `headerSpriteMs`: main creature sprite painted
- `slowestEvoSpriteMs`: slowest evo-row sprite painted

A new `_detailOpenStart` stamp on the showDetail entry, consumed
by renderDetail. Header onReady + per-evo-row markEvoRowReady
callbacks roll into a `_commitDetailPerf()` that fires once every
expected sprite has either painted or errored.

**The metrics on first dump made the answer immediate:**

```
detail calls=9 last=1535ms max=2483ms
  [dispatch=66ms sync=96ms header=172ms evo=1469ms]
detail slowest (last 9):
  32s ago  2483ms  disp=23ms  sync=38ms  header=59ms  evo=2460ms  rows=4
  32s ago  2419ms  disp=0ms   sync=6ms   header=17ms  evo=2419ms  rows=2
   8s ago  1535ms  disp=66ms  sync=96ms  header=172ms evo=1469ms  rows=4
```

Header was already fast (~17-172ms). The 2-second wait was
entirely in `evo=`: cold sprite-pack downloads for the evolved
forms. The LocalServer slow-log confirmed:

```
recent slow (>100ms, newest first):
   -6s  252ms  /bundled-data/sprite-packs/15.pack
   -6s  253ms  /bundled-data/sprite-packs/28.pack
   -6s  253ms  /bundled-data/sprite-packs/14.pack
   -6s  253ms  /bundled-data/sprite-packs/108.pack
```

Header sprite was warm (the inventory card had just shown it); evo
targets were cold misses fanning out in parallel from disk.

**Fix: defer the evo-row variant resolve + sprite load to idle.**

Added a small `_scheduleIdle(fn)` helper (prefers
`requestIdleCallback`, falls back to `setTimeout(fn, 50)`). The
evo-row inner loop's `_pickEvolvedVariant().then(...).catch(...)`
chain wrapped in `_scheduleIdle`. Click handlers + affordability
checks stay sync — tappable evos are tappable immediately.

Same total work, just rescheduled. Panel paints with placeholders
at ~200ms (header), evo previews stream in as their packs decode.
The metric's `evo=` field still shows ~1.5-2.5s because that's the
honest "time until last evo sprite painted" measurement; the
**user-felt** "tap to open" feel collapses to ~200ms.

User confirmed: "Mk it works great!!! tyty :3"

## Pattern notes

The full session crystallized a repeatable shape for performance
investigation:

1. **Instrument first.** Add metrics for the suspected hot paths
   before optimizing anything. The metrics dump in Settings
   self-documents the shape and surfaces outliers via a ring
   buffer. Five-minute investment, hours of guessing avoided.
2. **Read the numbers.** Bottlenecks rarely live where the
   brainstorm predicts. Captures-array re-parse on every render
   (the obvious target) was actually fast at 10ms; the real cost
   was *re-doing* it 24× per pokédex render via per-card readSeen-
   Variants. Per-card cost × visible card count is what kills you.
3. **Fix the one bottleneck, re-measure.** Layers of cache miss
   hide behind layers of cache miss. The captures-parse fix
   revealed the seen-fusions parse. Each fix only becomes visible
   after the previous one. Iterate.
4. **Decouple felt latency from work.** When the work can't be
   reduced (cold sprite-pack downloads from disk), reschedule it.
   Idle callbacks let the panel paint first; the user perceives
   the work as "loading something I can see being loaded" rather
   than "the panel hasn't opened yet."
5. **Discipline by structure.** Closure-encapsulate the store
   so there's no path that lets a future change forget to
   invalidate. The cache and the persistence layer are one
   object, and there's no other API surface.

These will keep paying out as more state grows. Same pattern
would catch the egg-incubator distance summary if it ever gets
hot, or the daycare-loot rolls if they multiply, or any future
per-creature derived data.

---

# Session — shiny system design (algorithm + bake pipeline)

A long brainstorm-to-prototype arc on how to do shiny creatures. The
user pushed back on default Pokémon-style hue rotation ("imo it's
pretty bad for many of them") and wanted multiple visually distinct
shinies per fusion. We spent the session designing the algorithm,
then building offline tooling to compute the per-family palettes that
the runtime shiny transform will use.

Three poems added to `POEMS.md`. Probably. Or implicitly. The arc
felt poetic even if I didn't write one.

## Algorithm design

### The clustering attempt (and why it didn't work)

Started with: "extract logical color regions from the sprite via
k-means clustering, then permute cluster centroids." Sounds principled
and matches what shiny systems "should" do.

Several iterations on clustering quality:
- **3D OKLAB k-means**: light blue and light yellow grouped together
  because they have similar L. Wrong: same lightness ≠ same color.
- **2D (a, b) Cartesian**: better, but over-segmented heavily-shaded
  single-hue regions (Squirtle's teal body split into "warm teals"
  and "cool deep teal" because the artist used color-temperature
  shading).
- **Hue-angle only** (normalized (a, b)): perceptually correct for
  hue identity but still split Squirtle's teals because the
  artist's deliberate ~10° hue shift between highlight and shadow
  shows up as different clusters at high K.

Lower K helped (K=3 merged Squirtle's teal family into one cluster
correctly) but became inadequate for sprites with many genuine
hue families. **There's no single K that's right for every sprite.**

### The smooth-permutation reframe

User's insight: "what if we don't bother with clustering. Instead, we
just pick a hue mapping that is neighbor preserving."

Clustering imposes hard boundaries on a continuous color landscape.
Smooth permutations preserve neighbor relationships *automatically* —
the artist's color-temperature shading just rides along through the
transform. No K-tuning, no per-sprite analysis, no decision about
where to draw cluster boundaries.

The space of "smooth, orientation-preserving permutations of the hue
circle" is well-studied. Parameterizations from simplest to most
expressive:

1. Pure rotation: `h_new = h + φ` (vanilla Pokémon).
2. Rotation + sinusoidal wobble: `h_new = h + φ + ε·sin(h − θ)`. Three
   params; monotonic iff |ε| < 1. Wobble lets different hue regions
   shift differently while staying neighbor-preserving.
3. Fourier series: higher-order sinusoidal terms. More expressive,
   still smooth.
4. Spline / piecewise-linear: art-direct via anchor points.

### The 3D perceptual transform (what we settled on)

User noticed pure hue rotation, even with wobble, "always feels like
palette-swap variations." Same shape every time, just different
colors. So we generalized to full 3D perceptual transforms:

```
new_L = L + ΔL              (lightness shift)
new_C = C × κ               (chroma scale)
new_h = h + φ               (hue rotation)
```

Three perceptual axes (`OKLAB` is a proper perceptual space — that
was already settled by using it). Each shiny is a `(φ, ΔL, κ)` triple
with bounds:
- φ ∈ [−π, π]  (full hue wheel)
- ΔL ∈ [−0.20, 0.20]  (about ±15% perceived lightness)
- κ ∈ [0.5, 1.5]  (half-saturation to 1.5× saturation)

Per-pixel transform: convert RGB → OKLAB → polar (L, C, h) → apply
the transform → convert back. Out-of-gamut results get gracefully
chroma-clipped (bisection on chroma magnitude until sRGB-feasible)
instead of channel-clamped (which produces visible splotchy
artifacts).

This gives "different shinies feel different in **mood**, not just
hue" — one is pastel, one is dark and rich, one is washed-out, one is
neon-vivid. Genuine character variation, not palette swaps.

### Sampler: farthest-point in perceptual space

Per family pair, we want 12 (φ, ΔL, κ) triples that are:
- Visually distinct from each other and from the original.
- Don't produce muddy/clipped colors on the family's actual palette.

Algorithm:
1. Generate ~2000 random candidate triples.
2. **Soft-score** each by total "badness" across a test palette
   (chroma loss after gamut clip + 0.5 penalty per color landing in
   a muddy zone — heuristically `L < 0.5 ∧ hue ∈ [30°, 80°] ∧
   chroma < 0.12`, the dirty-brown band).
3. Take the top 200 by lowest badness.
4. **Farthest-point sample 12** in 4D normalized space:
   `(cos φ, sin φ, ΔL/0.20, log κ / log 1.5)`.
   Identity = (1, 0, 0, 0). First selection is farthest from identity;
   each subsequent is farthest from prior selections.

The soft-score lets us pick the best 12 even when no candidate is
*perfect* — strict pass/fail rejection failed when the cross-dex
palette had 28 test colors and almost nothing passed all of them. With
soft scoring + farthest-point, we always get 12 good options.

### Scope decision: per-family-pair (not per-fusion, not universal)

Three scoping options considered:
1. **Universal 12** (one set, applied to every fusion): tiny bake but
   tuned to nothing in particular. Some sprites' palettes get muddy
   under transforms tuned for a synthetic mid-band palette.
2. **Per-fusion** (each (a, b) gets its own 12): perfectly tuned, but
   evolutions look unrelated (your shiny Charmander becomes a totally
   differently-colored shiny Charmeleon).
3. **Per family pair** `(rootA, rootB)`: 12 triples shared across
   every member of `familyOf(rootA) × familyOf(rootB)`. Evolutions
   stay shiny-coherent. Storage ~4× smaller than per-fusion.

User chose #3. Implemented.

### Variant-aware palette merging

User's later refinement: include all *art variants* in the per-family
palette merge, not just the autogen sprite. Otherwise the chosen 12
might be tuned to autogen art but produce muddy results on custom-
artist variants of the same fusion.

Implementation: walk `cells.json[A-B]` (slot indices that exist) ×
`manifest[B]` (slot → suffix) to find every variant sheet, load
each, crop the (a, b) cell, extract its palette. Merge weighted by
pixel count.

Effect: Charmander × Charmander family went from 9 contributing
sprites (autogen only) → 42 sprites (autogen + all artist variants).
Merged palette grew from 136 → 348 entries. The chosen 12 transforms
now constrained against the full artistic range — they look good on
every painted rendition, not just the autogen baseline.

## Storage estimate

| Approach | Raw | Gzipped | Notes |
|---|---|---|---|
| Per-fusion (22500 × 144 B) | 3.24 MB | ~800 KB | Best aesthetic, no coherence across evos |
| Per-family-pair (~5500 × 144 B) | 790 KB | ~200 KB | Coherent across evos, 4× smaller |
| Per-family-pair quantized (~5500 × 36 B) | 200 KB | ~80 KB | If we squeeze the floats; future polish |

Per-family-pair fits comfortably alongside the existing
`shiny-palettes.json` slot we'll add to BundledData.

## Files added this session

| File | Role |
|---|---|
| `probe-shiny-clusters.py` | k-means clustering probe with OKLAB modes (hue, ab, lab) — the journey that led to "actually let's not cluster." Kept for reference. |
| `probe-shiny-hue.py` | The smooth-permutation prototype. Modes: `wobble` (rotation + sin), `pure` (rotation only), `3d` (full perceptual, per-sprite farthest-point), `universal` (cross-dex synthetic palette). Exposes the OKLAB helpers as a library — imported by build-shiny-palettes.py. |
| `build-shiny-palettes.py` | Family-pair sampler. Takes `--pair A B` to test a single pair (writes contact sheet + JSON entry) or `--all` to bake every family pair into the production JSON. Loads `cells.json` + `manifest.json` to merge palettes across every art variant of every family member. |

All probe outputs go to `probe-output/`. Contact-sheet PNGs show
[original | 12 shinies] (or for `build-shiny-palettes.py`, one row
per fusion in the family pair with shared columns of shinies — lets
us verify coherence across evolutions visually).

## What's still to do for the shiny feature

The algorithm is settled. Remaining work:

1. **Run the full bake** (this session): iterate all ~5500 family
   pairs, write `data/BundledData/shiny-palettes.json`. Compute time
   estimate ~1-3 hours depending on Python perf.
2. **Wire bake into build-bundled-data.py** so it runs automatically
   with other bundle steps.
3. **Port OKLAB + transform to JS** — already implemented in Python;
   ~80 lines of JS for the per-pixel transform. Uses Canvas pixel
   manipulation.
4. **Roll shinies at catch time**: 0.1% chance, then uniform pick of
   variant index 0-11. Store `shinyVariant: number | null` on the
   capture record alongside the existing `variant` field.
5. **Render path through SpriteStore**: when a capture has
   `shinyVariant != null`, look up the family-pair's 12 triples,
   apply the chosen transform on the source sprite, cache the result
   blob in IDB. ~10-20 ms first-render, ~0 ms cached.
6. **Polish**: sparkle effect on shinies, "✨" badge in the inventory,
   maybe hidden-until-encountered in the pokédex.

The runtime cost ladder (per shiny first render in JS): ~10ms OKLAB
round-trip + transform + gamut clip × ~3500 chromatic pixels. Within
frame budget. Cached afterwards, like every other sprite.

## Things learned

1. **Clustering is overkill for "perceptual palette swap."** Smooth
   permutations preserve everything clustering tries to preserve, with
   no K-tuning, no boundary decisions, no per-sprite analysis.
2. **OKLAB is already perceptual.** Hue rotation in OKLAB IS the
   perceptual operation, not a stepping stone to one. If something
   looks wrong, it's the parameter choice or the rejection bounds,
   not the color space.
3. **Per-pixel gamut clipping > channel clamping.** When OKLAB →
   sRGB lands out-of-gamut, reduce chroma along (L, h)-const via
   bisection. Always succeeds, always graceful. Channel-clamping
   produces splotchy artifacts that look like a different kind of
   bug.
4. **Soft scoring + farthest-point > strict reject + uniform sample.**
   Strict rejection fails when the test palette is large (28 colors
   across the wheel: almost no candidate passes all). Soft scoring
   ranks every candidate, then farthest-point picks 12 well-spaced
   among the best. Always returns 12 things.
5. **Family-rooted scope is the sweet spot.** Per-fusion is too
   granular (evolutions look unrelated). Universal is too coarse
   (results vary widely by sprite). Family-rooted gives coherence
   across evolutions + per-palette tuning + tractable storage.
6. **Variant inclusion in the palette merge matters.** Without it,
   the transforms work on autogen but break on artist variants —
   especially on popular fusions like (Charmander, Charmander) with
   many artists. With it, the constraint is the *artistic envelope*,
   not the algorithmic baseline.
7. **Sometimes the user's intuition is the spec.** I overcomplicated
   the clustering work for two iterations. User said "what if we
   don't cluster" and the simpler design was right. Then they said
   "instead of hue, in a proper perceptual space" → 3D transforms
   were the right next step. Then they said "per-pokemon but family-
   rooted for coherence" → the production design. Each move was
   theirs, and each was the right one.

## Session vibes

```
We tried to cluster. We tried OKLAB three different ways.
We tried hue-only, two-dimensional, full Cartesian.
Each was technically correct.
Each missed the artist's intent in a different way.

Then you said: "what if we just rotate the hue?"
And I had to stop and notice that
this whole thing wasn't a clustering problem,
it was a smooth-permutation problem,
and clustering had been a wrong shape all along.

The smooth permutation became hue rotation.
The hue rotation became hue + lightness + chroma.
The per-sprite analysis became per-family.
The per-family included all the variants.

Now there are 12 shinies for every pair of evolutionary lines,
each one a different mood —
pastel, dark and vivid, washed-out cool,
muted earth-tone, electric-bright.

Magikarp × Eevee has eight contributing sprites
across two lines and four branches,
and the 12 shinies look coherent across all of them.
A Magikarp × Eevee shiny that becomes a Gyarados × Vaporeon
keeps the same shiny family —
same kind of color shift, just on a bigger fish.

You said it looks really good.
I think so too.

Tomorrow we'll bake the JSON, port the transform to JS,
and roll the dice at 1-in-1000 catch chance.
Today we built the math.

:3
```

## Coda — bake complete

Command run:
```
python3 build-shiny-palettes.py --all --render-samples 12
```

**Completed in 52.6 minutes** (much faster than the 3-5h estimate —
turns out average family-pair size was smaller than the Charmander
big-case I used to project from). Sustained rate: ~1.8 pairs/second.

Final stats:

| Metric | Value |
|---|---|
| Family pairs baked | **5,612** |
| Family roots present (gen 1) | 78 |
| Triples per pair | 12 |
| Total triples | 67,344 |
| Raw JSON | **1,875 KB** |
| Gzipped | **676 KB** |
| Sample contact sheets rendered | 17 |

Output:
- `data/BundledData/shiny-palettes.json` — the production bake
- `probe-output/shiny-family-*.png` — 17 sample sheets spread across
  the dex (the off-by-one in `--render-samples 12` math gave us 17
  instead of exactly 12 — fine, more samples)

The gzipped size (676 KB) is a bit larger than estimated because
JSON's float-encoding (~12-15 chars per float even at 5-decimal
rounding) is verbose. We could quantize to a `.bin` format and shrink
to ~200 KB raw, but 676 KB gzipped is comfortably small alongside
`routing.bin` and the rest of the bundled data, and JSON is easier
to inspect during development. Bin-pack later if storage tightens.

**One small optimization that landed during the bake setup**:
`prepare_test_palette` precomputes the OKLAB → polar (L, C, h)
conversion for each test color once per pair, instead of inside the
2000-candidate scoring loop. Cut per-pair time from ~12s to ~7.5s
(36% reduction). Could parallelize across CPU cores for further
speedup if we need to re-bake frequently, but at the current 52-min
cost it's basically free.

Sample family pairs rendered for spot-checking include:
`1-1` Bulbasaur×Bulbasaur, `4-4` Charmander solo, `4-7` Char×Squirtle,
`25-25` Pikachu solo, `129-133` Magikarp×Eevee (the branching one),
`35-1`/`63-1`/`92-1`/`114-1`/`131-1` various ×Bulbasaur pairs,
`19-92`/`48-92`/`79-92`/`104-92`/`123-92`/`142-92` various ×Gastly
pairs. Both ×Bulbasaur and ×Gastly columns let us see how the same
12 shiny styles look across different head-species partners.

## Coda — binary format

After the JSON bake we packed the same data into a compact binary
(`shiny-palettes-to-bin.py`). Each `(φ, ΔL, κ)` triple quantizes into
4 bytes:

| Axis | Encoding | Max round-trip error | JND | Headroom |
|---|---|---|---|---|
| φ (hue rotation) | int16, ±32767 → ±π rad | 0.0027° | ~1° | ~370× |
| ΔL (lightness) | int8, ±127 → ±0.20 OKLAB L | 0.000787 | ~0.01 | ~13× |
| κ (chroma scale) | u8, 0–255 → linear 0.5–1.5 | 0.001961 | ~0.01 | ~5× |

All quantization errors well below human perception thresholds —
visually indistinguishable from the float originals.

**Binary layout** (little-endian):

```
0   4   magic 'SHIN'
4   4   version (u32 = 1)
8   4   entry count (u32) = 5612
12  4   reserved
16  …   entries (50 bytes each), sorted by (rootA, rootB)

Per entry:
  rootA   u8
  rootB   u8
  12 × { phi int16, deltaL int8, kappa u8 }   (4 bytes per triple)
```

Final size comparison:

| Format | Size | vs JSON original |
|---|---|---|
| JSON (original) | 1,875 KB | — |
| JSON gzipped | 676 KB | 37% |
| **Binary** | **274 KB** | **15%** |
| Binary gzipped | 274 KB | 15% (incompressible — already efficiently packed) |

The binary doesn't gzip-shrink further because every byte is
information-rich after quantization (good sign that the format is
efficiently packed; no redundancy left to compress).

## JS-side implementation sketch

This is the design we'd land when wiring shinies into the runtime —
sketched here so a future session can pick up the pattern. Three
pieces: a binary reader, a per-pixel transform, and a SpriteStore
hook.

### 1. Binary reader → eager-loaded Map

Mirrors the pattern we use for `routing.bin` / `poi-trigram.bin` /
`boundaries.bin`: one parse pass at module load, then O(1) lookups
forever.

```js
// static/shiny-store.js
const SHINY_MAGIC = 'SHIN';
const SHINY_VERSION = 1;
const SHINY_ENTRY_BYTES = 50;
const SHINY_TRIPLES_PER_ENTRY = 12;

// Decoded shape: Map<rootA * 256 + rootB, Float32Array of length 36>
// (12 triples × 3 floats each, flat layout for fast access).
const _shinyPalettes = new Map();
let _shinyReady = false;

async function loadShinyPalettes() {
  if (_shinyReady) return;
  const resp = await fetch(`${BUNDLED_BASE}/shiny-palettes.bin`);
  const buf = await resp.arrayBuffer();
  const view = new DataView(buf);
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1),
    view.getUint8(2), view.getUint8(3));
  if (magic !== SHINY_MAGIC) {
    throw new Error('shiny-palettes.bin: bad magic ' + magic);
  }
  const version = view.getUint32(4, true);
  if (version !== SHINY_VERSION) {
    throw new Error('shiny-palettes.bin: unsupported version ' + version);
  }
  const count = view.getUint32(8, true);
  let off = 16;
  for (let i = 0; i < count; i++) {
    const rootA = view.getUint8(off);
    const rootB = view.getUint8(off + 1);
    const triples = new Float32Array(SHINY_TRIPLES_PER_ENTRY * 3);
    let tOff = off + 2;
    for (let j = 0; j < SHINY_TRIPLES_PER_ENTRY; j++) {
      triples[j * 3 + 0] = view.getInt16(tOff,     true) / 32767 * Math.PI;
      triples[j * 3 + 1] = view.getInt8 (tOff + 2)         / 127   * 0.20;
      triples[j * 3 + 2] = 0.5 + view.getUint8(tOff + 3)   / 255   * 1.0;
      tOff += 4;
    }
    _shinyPalettes.set(rootA * 256 + rootB, triples);
    off += SHINY_ENTRY_BYTES;
  }
  _shinyReady = true;
}

function getShinyTriple(rootA, rootB, variantIdx) {
  const triples = _shinyPalettes.get(rootA * 256 + rootB);
  if (!triples) return null;
  const base = variantIdx * 3;
  return { phi: triples[base], deltaL: triples[base+1], kappa: triples[base+2] };
}
```

Memory: ~280 KB for the `_shinyPalettes` Map (5,612 entries × 144
bytes per Float32Array). Same order of magnitude as the bin file,
fine to keep resident.

### 2. Per-pixel OKLAB transform

Port of `applyShinyTransform` from the Python prototype
(`probe-shiny-hue.py`). Operates on a canvas's `ImageData` in-place
for the fast path; returns a fresh blob URL via canvas-to-blob.

```js
// static/shiny-store.js (cont.)

function _srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function _linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92
                        : 1.055 * Math.pow(c, 1/2.4) - 0.055;
}
function rgbToOklab(r, g, b) {
  const rl = _srgbToLinear(r / 255);
  const gl = _srgbToLinear(g / 255);
  const bl = _srgbToLinear(b / 255);
  const L = 0.4122214708*rl + 0.5363325363*gl + 0.0514459929*bl;
  const M = 0.2119034982*rl + 0.6806995451*gl + 0.1073969566*bl;
  const S = 0.0883024619*rl + 0.2817188376*gl + 0.6299787005*bl;
  const Lc = Math.cbrt(L), Mc = Math.cbrt(M), Sc = Math.cbrt(S);
  return [
    0.2104542553*Lc + 0.7936177850*Mc - 0.0040720468*Sc,
    1.9779984951*Lc - 2.4285922050*Mc + 0.4505937099*Sc,
    0.0259040371*Lc + 0.7827717662*Mc - 0.8086757660*Sc,
  ];
}
function oklabToRgb(L, a, b) {
  // ...mirror Python oklab_to_rgb...
}
function gamutClipOklab(L, a, b) {
  // Bisection on chroma scale (10 iterations is plenty in JS too).
  // ...mirror Python gamut_clip_oklab...
}

// Returns a fresh blob URL with the transformed sprite. Caller is
// responsible for revoking the URL when done (typical SpriteStore
// pattern — we revoke on cache eviction).
async function applyShinyTransform(sourceImg, phi, deltaL, kappa) {
  const w = sourceImg.naturalWidth, h = sourceImg.naturalHeight;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(sourceImg, 0, 0);
  const imgData = ctx.getImageData(0, 0, w, h);
  const px = imgData.data;
  const CHROMA_THRESHOLD = 0.04;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a < 200) continue;
    const [L, oa, ob] = rgbToOklab(px[i], px[i+1], px[i+2]);
    const chroma = Math.sqrt(oa*oa + ob*ob);
    if (chroma < CHROMA_THRESHOLD) continue;  // structural, preserve
    const hue = Math.atan2(ob, oa);
    const newL = Math.max(0, Math.min(1, L + deltaL));
    const newChroma = chroma * kappa;
    const newHue = hue + phi;
    let newA = newChroma * Math.cos(newHue);
    let newB = newChroma * Math.sin(newHue);
    const clipped = gamutClipOklab(newL, newA, newB);
    [px[i], px[i+1], px[i+2]] = oklabToRgb(clipped.L, clipped.a, clipped.b);
  }
  ctx.putImageData(imgData, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return URL.createObjectURL(blob);
}
```

Cost estimate: ~10-20 ms per 96×96 sprite (~3,500 chromatic pixels;
~30 FLOPs each). First-render-only; cached after.

### 3. SpriteStore hook

The minimal wiring: when SpriteStore is asked for a sprite where
`shinyVariant != null`, key the cache differently and apply the
transform on miss.

```js
// In sprite-store.js's showSprite path, before the existing IDB blob
// fetch:
function _spriteKey(a, b, variant, shinyVariant) {
  const shinyTag = shinyVariant != null ? `-s${shinyVariant}` : '';
  return `${a}-${b}-${variant}${shinyTag}`;
}

async function _resolveSprite(a, b, variant, shinyVariant) {
  const cacheKey = _spriteKey(a, b, variant, shinyVariant);
  const cached = _spriteCache.get(cacheKey);
  if (cached) return cached;

  // Resolve the base (non-shiny) sprite first via the existing path.
  const base = await _resolveBaseSprite(a, b, variant);
  if (base == null || shinyVariant == null) {
    _spriteCache.set(cacheKey, base);
    return base;
  }

  // Apply the shiny transform.
  const rootA = candyRootFor(a);
  const rootB = candyRootFor(b);
  const triple = getShinyTriple(rootA, rootB, shinyVariant);
  if (!triple) {
    // Family-pair not in the bake — fall through to base sprite.
    // Shouldn't happen for gen-1 fusions; defensive.
    _spriteCache.set(cacheKey, base);
    return base;
  }
  const img = await _decodeBlob(base);
  const shinyUrl = await applyShinyTransform(
    img, triple.phi, triple.deltaL, triple.kappa);
  _spriteCache.set(cacheKey, shinyUrl);
  return shinyUrl;
}
```

The cache key change is the only place existing call sites need to
become shiny-aware — most of `SpriteStore` doesn't care. The first
render of a shiny does ~10-20ms of OKLAB work; every subsequent
render is a cache hit.

For storage of the cache itself: same IDB-backed pattern as existing
sprite cache. Shiny blobs persist across sessions; the user only
pays the transform cost once per shiny they encounter.

## Real next steps now that the bake is in hand

The algorithm is settled and the data is baked. Remaining engineering
to ship the feature:

1. **Wire the bake into `build-bundled-data.py`.** Add a
   `bake_shiny_palettes()` step that runs build-shiny-palettes.py
   --all if the output is missing or stale. Idempotent and fast on
   warm cache (a no-op when the JSON already exists). Future
   regenerations of BundledData pick this up automatically.
2. **Port the OKLAB transform to JS.** ~80 lines for `rgbToOklab`,
   `oklabToRgb`, `gamutClipOklab`, `applyShinyTransform(img, phi, dl,
   kappa)` returning a fresh blob. Canvas2D `getImageData` /
   `putImageData` for pixel access. The Python prototype in
   `probe-shiny-hue.py` is the reference implementation.
3. **Bundle + load the JSON.** Same pattern as
   `species-evolutions.json` — `AppData` or `Sprites` module loads it
   on first need, caches in memory. ~1.8 MB load is fine on cold
   start (gzipped over LocalServer it's ~676 KB, comparable to
   sprite-pack downloads we already do).
4. **Shiny roll at catch time.** In `creatures.js`, extend the
   capture record schema: `shinyVariant: number | null`. Roll at
   capture: `Math.random() < SHINY_RATE` (0.001) → pick variant
   uniformly in 0..11. Persist on `c.shinyVariant`. Legacy captures
   default null (not shiny — same as the existing pattern for
   forward-compatible field additions).
5. **Render path through SpriteStore.** When asked for a sprite where
   `shinyVariant != null`, look up
   `shinyPalettes[\`${rootA}-${rootB}\`][shinyVariant]` → apply
   transform → cache result blob under a shiny-aware key
   (e.g. `${a}-${b}-${variant}-shiny${shinyVariant}`). Falls through
   to the source sprite normally if the family-pair isn't in the bake
   (shouldn't happen for gen 1 but defensive).
6. **Polish:** ✨ badge in inventory, sparkle particle on first
   encounter, "you found a shiny" toast, pokédex tracking of shiny
   variants seen (mirror of the variant-grid concept but for shinies
   — 12 slots, silhouette until encountered).

Each piece is bite-sized. The load-bearing pre-req (the algorithm +
bake) is done.


