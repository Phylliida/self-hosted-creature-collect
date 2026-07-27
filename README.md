# self-hosted-creature-collect
idk some self hosted creature collecting game

## Features

A Pokémon-style walking game built on top of a real, fully-offline
OpenStreetMap stack. Designed to work end-to-end without making
unprompted network requests — the only auto-fetches happen during
explicit downloads (saving an offline region, downloading app data,
pressing refresh in the IPA). The whole thing self-hosts on a single
Flask process behind a Cloudflare tunnel.

### Map & navigation

- **Vector basemap** rendered by MapLibre GL with road / building /
  water / landcover / park / POI / housenumber / transit-line layers
  drawn from a trimmed openmaptiles schema. Low-zoom land + ocean
  polygons come from Natural Earth so the world looks right at
  z0–z8.
- **Offline map regions** — pan/zoom to where you live, tap "save
  current view" to download every tile + POI + walk graph + GTFS
  schedule + housenumber + address record + transit-route shape for
  that bbox into IndexedDB. Choice of max zoom (1–14). From then on
  the app works offline forever; no auto-refetches. Per-region
  storage size is reported in the panel.
- **Refresh region** to pull updates for an existing saved bbox in
  place, or **delete region** to free storage.
- **Region naming** — auto-named after the largest place inside the
  bbox (city / town / country fall-through); rename inline.
- **Search box** ranks results by distance from the user's current
  position (or map center if no GPS yet); filterable by POI category
  via a dynamically-populated dropdown showing per-category counts
  for downloaded regions.  Three things flow through the same UI:
  - **POIs** — every named OSM feature in your downloaded regions
    (cafés, parks, schools, transit stops, …). Substring match on
    name. Tapping opens a card with address, opening hours, phone,
    website, accessibility, brand, operator, cuisine, description,
    Wikipedia / Wikidata, internet access — plus "Save as favorite"
    and "Directions" buttons.
  - **Addresses** — full street-address search via
    `<housenumber> <street>` matching, token-based and word-order-
    independent. "1996 Allison Way" finds "1996 South Allison Way";
    "Allison 1996" works too. Powered by a dedicated `/addresses`
    binary bundle per region (~480 KB / city) with interned street
    names.
  - **Favorites** (custom pins) — anything you've starred via the POI
    card or pinned manually. Tappable in both the main search and the
    trip planner's From / To boxes; rendered with a `★ favorite`
    label so they're easy to distinguish.
- **Drop a pin anywhere** — long-press on the map (or hit the pin
  affordance on the bottom bar) to drop a draggable temporary
  marker, fine-tune its position, then save it as a favorite with a
  custom icon (~215 Maki options) and any of 8 colors. Useful for
  marking your apartment, friends' houses, "where I parked", etc.
- **POI cooldown overlays** — once you've collected from a pokéstop,
  a fading countdown overlay appears on its marker so you can see
  at a glance which stops are ready to be tapped again.
- **Trip planner** — walk + transit routing over a typed-array walk
  graph + a stop-pattern-indexed GTFS schedule, all client-side via
  a time-dependent Dijkstra (`static/trip-planner.js`). Supports
  "Leave now / Depart at / Arrive by", configurable walk-cost weight,
  and a transfer minimum. Shows top-3 alternates with step-by-step
  instructions, route shapes drawn on the map, and live next-
  departure times for transit legs. **Save routes** for later
  one-tap recall via a dedicated saved-routes panel.
- **Tap a stop on a route** to see real-time-ish next departures
  drawn from the GTFS calendar / schedule, organized by direction.
- **Geolocation** ("where am I" button) auto-activates on launch but
  the very first fix doesn't fly the camera if there's a saved view —
  preserves the user's last-viewed location. Falls back to GPS shim
  through Capacitor's Geolocation plugin in the IPA so iOS doesn't
  intermittently drop fixes.
- **Saved view** persists across reloads (lng/lat/zoom/bearing/pitch).

### Creatures

- **Deterministic, server-free spawning.** A Brent xor4096 PRNG seeded
  by `(cell, minute-tick, day_salt)` decides which creatures appear
  where. Two devices in the same place at the same time see the same
  creatures — no server roundtrips, no dependency on real time being
  synced beyond minute precision. Cell size is ~11 m at the equator.
- **Sliding-window spawn lifecycle.** Each (cell, tick) is an
  independent slot; a creature born at tick T expires at T + 20 min.
  No synchronized mass-rollover ("oh look, all my pokemon vanished
  and a new wave appeared at once") — at any moment some are freshly
  born, some about to expire. Tunable so stationary play is deliberately
  less rewarding than walking through fresh ground.
- **Weather / type cycling** — daily and weekly rotating type pools,
  deterministically seeded so two devices on the same day see the
  same boosted types. Surfaced as a "weather bar" of two type chips
  at the top of the inventory panel.
- **Catch mechanic** with a Poké-ball / Great Ball throw animation,
  per-ball catch rate (Poké Ball 70%, Great Ball 90% per shake^3),
  bowed-arc trajectory, three-shake reveal, break-out vs. lock-in
  with a celebratory "ding" + radial-burst animation on success.
- **Inventory** (the "Pokémon" panel) — virtualized list of every
  capture for smooth scroll on thousands of entries. Sortable by
  name / first species / second species / catch date / level / size,
  filterable by tag chips. Inline rename (long-press the title to
  edit a nickname).
- **Detail view** with arrow-key + swipe sibling navigation through
  adjacent entries in the same filtered + sorted order. Shows
  sprite, fused name, types, level, size, capture date, tagged
  with a chip picker, candy tally, and a "view dex entry" link.
- **Pokédex** — every fusion you've ever seen (or caught) tracked in
  a 3-column virtualized grid. Filterable by built-in tag (Pure
  monotypes), text-searchable by either / both species. Per-fusion
  **family-tree** sub-view shows every cross within both species'
  evolution lines. Per-variant silhouette grid (so you know which
  custom artworks you've encountered vs. not). Inline candy tally
  for the active root families.
- **Pokémon Infinite Fusion data** baked in — full custom + autogen
  sprite library, canonical fused names ("Charmander" + "Bulbasaur" =
  "Charsaur") computed via PIF's split-names rule, per-fusion artist
  credits surfaced in the detail / fusion sub-views, PIF's type-
  inheritance rules (primary from A, secondary from B, dedup'd).
- **Tags** — a flat list of short labels (max 8 chars) you can apply
  to captures. **Built-in tags** are predicate-driven and appear
  automatically when their condition fires (e.g. **Pure** for
  monotype captures, where speciesA === speciesB). **Custom tags**
  toggle membership when tapped. **Interactive built-ins** (Daycare,
  see below) act on external state via an `onToggle` hook.
- **Candy** ledger — per-evolution-family (Charmander candy covers
  Charmander-anything fusions). Earned on capture, with a one-time
  schema migration that promotes baby pokemon (Pichu, Cleffa, etc.)
  to their parent's family root so the bucket name reads as expected.
- **Bag** — Poké Ball / Great Ball inventory with a starter bag
  granted on first read. Replenished by tapping pokéstops on the map.
- **Pokéstops** — tappable POIs in creature mode with a "Collect
  items" button that grants 1–3 random items per tap. Per-stop
  cooldown timer rendered as a fading visible overlay so you know
  which stops are ready.
- **Variant tracking** — every variant you've ever seen for a given
  fusion is recorded; pokédex variant grids silhouette unseen ones,
  so completing the dex includes finding every artist's take on
  every fusion.
- **One-shot custom-art migration** — a Settings button promotes any
  legacy autogen captures whose cells now report custom variants in
  the bundled data, so older captures retroactively pick up the
  artist's primary variant.

### Daycare

- **Distance tracker** that accumulates GPS-confirmed walking distance
  while the app is open. Filters: 10 m jitter floor, 60 s
  backgrounding gap detection, 50 m/s teleport speed cap. Same
  fairness rules as commercial buddy-walking systems.
- **Calendar** with month navigation, per-day distance annotations,
  and a today-highlight. Tap any past day to see its total.
- **GPS path** stored per day (capped at 20 k points). "Show on map"
  draws the route as a polyline overlay, segmented by 60 s
  backgrounding gaps so suspended-app sessions don't render as
  phantom long lines. "Show all on map" overlays every day's route.
- **Daycare slots** — tap the **Daycare** built-in tag on any
  captured creature to park it (max 2 at a time). Each slot shows
  the creature's sprite, name, and meters walked **during this
  stay** below. Removing and re-adding resets the counter to 0. Tag
  hides automatically when the daycare is full.

### Backup & sync

- **Export to JSON** dumps every captured creature, nickname, candy,
  bag, tags, favorites, regions, theme, units, daycare slots, and
  daycare history (per-day distance + full GPS paths) to a single
  human-readable file.
- **Import** merges by capture id (idempotent re-imports), with
  per-key max merge for candy and bag so combining devices keeps
  whichever had more.
- **Save / Load to server** — same payload, stored under a trainer
  name on the Flask backend (`/save`, `/load`). 7-day "have you
  saved recently?" reminder banner in the inventory.

### Themes & customization

- **47 themes** ranging from sensible (default, dark, night, sepia,
  mono, forest, nordic, ocean, autumn, pastel, mint chocolate, coral
  reef) through nostalgic (win95, mac OS 9, gameboy, NES, Atari
  2600, The Sims, Roller Coaster Tycoon, Pac-Man, VHS, Wes Anderson,
  notebook, chalkboard, comic sans, hand-carved wood, sheet metal,
  google maps, apple maps, minecraft) to atmospheric (vaporwave,
  neon, sakura, amber, galaxy, noir, terminal, blueprint, desert,
  abyss, fogbank, haunted mansion, backrooms, poolrooms, dead mall,
  3am parking garage, bloodmoon, tron). All driven by CSS variables
  — adding a new theme is one entry in `THEMES` plus an `<option>`
  in the picker.
- **Custom theme builder** lets you set every palette color
  individually (background, land, water, building, road, label text,
  label halo, POI icon color) with live preview.
- **Per-theme decorations** — themes that ship with extra flourishes
  layer them on top of the base CSS-variable palette: medieval gets
  small-caps headings + serif body + sepia icon filter, win95 gets
  navy title bars, sims gets bright button gradients, vaporwave/neon
  get glow shadows, etc.
- **Action buttons as icons / text** toggle — show the inventory
  panel's Tags / Bag / Candy / Daycare / Dex header buttons as
  compact SVG icons instead of text labels.
- **Visibility toggles** for buildings, transit lines, housenumbers,
  pokéstops on buildings — let you trade visual richness for
  performance on dense urban areas.

### Settings panel

A single sheet covering everything user-tunable:

- **Theme** picker + custom-color sub-grid.
- **Units** — metric (km, m) / imperial (mi, ft). Drives the scale
  control + every distance display in the app.
- **Time format** — 24-hour / 12-hour. Drives schedule + transit
  arrival times.
- **Show offline-maps panel** toggle — hides the bottom-right
  "↓ save current view" panel if you don't need it visible.
- **Only download on Wi-Fi** — gates region downloads on the
  Network Information API's `connection.type` so cellular bytes are
  preserved.
- **Creature mode** toggle — wild creatures, pokéstop loot, candy/
  bag mechanics. Off = pure mapping/directions app.
- **Memory footprint badge** (iOS only, opt-in) shows live phys-
  footprint / RSS / peak via a custom MemoryProbe Capacitor plugin.
- **Debug console** toggle — on-screen overlay that captures errors,
  promise rejections, and console.error output. Useful on iOS where
  dev tools aren't accessible. Off by default.
- **Re-mark custom art** one-shot migration button (see Creatures).
- **Clear sprites** button to free IDB space.
- **Backup row** with Name field + Export / Import / Save / Load.
  Save & Load round-trip a JSON dump to the Flask backend keyed on
  trainer name; Export & Import use a file picker.
- **App data** download button — fetches sprites, fonts, icons, and
  low-zoom world tiles into IndexedDB. Welcome flow auto-runs this
  on first launch.
- **Startup phase timings** (small monospace block at the bottom)
  — first GPS fix, first marker, first sprite, font preload time,
  variant summary load, etc. Runs every launch; useful for tracking
  cold-start performance regressions.
- **Version + sprite-inflight badge** so you know what code you're
  running and whether IDB reads are bottlenecking renders.

### PWA & native wrappers

- **Browser PWA** — works on any modern browser; "Add to Home Screen"
  on iOS gives a real installable web app. Service Worker caches
  every asset locally; downloads can be re-cached aggressively.
- **iOS IPA build** via GitHub Actions on a free macOS runner — pure
  unsigned IPA, sideloadable through SideStore or AltServer-Linux. No
  paid Apple Developer account required. Custom Swift overrides bring
  Service Workers (via embedded GCDWebServer + `http://localhost`),
  plus a JS-callable `BundleAccess` plugin for live-updates.
- **Android APK build** via GitHub Actions on Ubuntu — debug-keystore
  signed, sideloadable directly. ~5-min build cycle, no Mac required.
- **Live-update** (iOS) — refresh button fetches new code from the
  server and overlays it on the bundled webDir, so iterating on the
  app no longer requires a fresh IPA reinstall. Falls back to a
  pure-HTML `/__refresh__.html` link that clears the overlay if JS
  is too broken to run, so you can always recover without
  reinstalling. The same href works on Android (served as a
  bundled static file with a meta-refresh) and the web build (Flask
  route 302s to `/`), so the JS-free escape hatch is consistent
  across all three platforms.
- **Bundle change detection** — every IPA build stamps a unique
  `bundle-id.txt`; LocalServer reads it at launch and clears any
  stale live-update overlay when a new bundle ships, preventing
  "old code masks new code" surprises after reinstalls.

### Privacy & offline-first

- **Zero-data PWA mode**: every fetch is gated behind an explicit
  user action. Default app launches make zero remote requests.
- **Wi-Fi-only download** toggle — skips region downloads when on
  cellular, so you don't accidentally pay for tile bytes.
- **All catches and walked distance** stay on device unless you
  explicitly tap Save or Export.
- **No telemetry, no analytics, no third-party CDNs** — the only
  outbound endpoints are your self-hosted Flask backend (and only
  for the explicit download / save / refresh actions above).
- **Welcome flow** on first launch walks new users through the
  one-time app-data download (sprites, fonts, icons, world basemap)
  and then through saving their first map region. After that the
  app is fully offline.

### Diagnostics

- **On-screen debug overlay** captures uncaught errors, promise
  rejections, and console.error calls — useful on iOS where dev
  tools aren't accessible. Toggleable via Settings.
- **Memory footprint badge** (iOS only) shows live phys-footprint /
  RSS / peak. Toggleable; default off.
- **Startup phase timings** in Settings — first GPS fix, first
  marker, first sprite, font preload, icon bulk download, variant
  summary load, etc.
- **Sprite + icon download diagnostics** for tracking down "POI
  rendered as red dot" issues.

## Setup

`direnv allow` to load the nix shell (python + flask + tilemaker + cloudflared).

## Get `.osm.pbf` region files

Download per-country / per-state OSM extracts from **Geofabrik**:

**https://download.geofabrik.de/**

Navigate to the continent → country → (sub-region) and grab the `.osm.pbf`.
Sizes range from a few MB (small countries) to several GB (USA, Canada, etc.).
Daily-updated; pick the `-latest.osm.pbf` link. Drop the file into `osmpbf/`.

Tip: you can narrow a large extract before conversion with
`tilemaker --bbox minlon,minlat,maxlon,maxlat ...` to avoid baking 8 GB of tiles
you'll never pan to.

## Low-zoom land polygons (one-time, before first tile build)

```
./get-shapefiles.sh
```

Downloads `ne_10m_land` from Natural Earth (~1 MB) into `landcover/` so
tilemaker has continent polygons to emit at z0–z8. Without this the base map
looks mostly empty at zoomed-out views (OSM alone has almost no content at
low zoom — no land/water fill, just sparse country labels).

The script also has commented-out fetches for `ne_10m_urban_areas`,
`ne_10m_glaciated_areas`, and `ne_10m_antarctic_ice_shelves_polys` if you
ever want richer low-zoom rendering. Tilemaker silently skips any source
whose `.shp` file is missing, so this step is optional but strongly
recommended for the "save current view" flow (which pre-caches z0–z5 tiles
for the whole world).

## Convert `.osm.pbf` to tiles + POI index

```
./make-tiles.sh
```

For each `osmpbf/<name>.osm.pbf` this produces:
- `data/<name>.mbtiles` — vector tiles (via tilemaker). Uses
  `tilemaker-slim.json` + `tilemaker-slim.lua` — a trimmed openmaptiles
  schema that drops attributes/layers the client never reads (no
  brunnel/ramp/service/oneway on roads, no building heights, no
  mountain_peak/aeroway/waterway layers). If you changed anything in those
  files you need to `rm data/*.mbtiles` first to force a rebuild (already-
  built files are skipped).
- `data/<name>.pois.sqlite` — big server-side POI index via
  `osmium tags-filter n/name w/name` (covers nodes AND named ways like
  buildings), then `osmium export` → `build-poi-db.py`. Polygon features get a
  centroid. Stores lng, lat, name, category, and a JSON `props` blob (address,
  opening_hours, phone, website, wheelchair, brand, cuisine, description,
  wikipedia/wikidata, internet_access). Viewport lookups go through a
  `poi_rtree` spatial index (JOINed back to `poi` by rowid) — empty/sparse
  regions resolve in ~1 ms, populated regions in ~60 ms. If you have an older
  pre-rtree `.pois.sqlite`, run `python3 add-poi-rtree.py <file>` to migrate
  in place (~80 s for the 6.5 M-row North America DB, adds ~0.4 GB). The
  server auto-detects the rtree and falls back to flat lat/lng indexes for
  un-migrated DBs.
- `data/<name>.walk.sqlite` — pedestrian walk graph built from `w/highway`
  features. Nodes are stored with their OSM ids (so multi-region downloads
  can dedup at tile boundaries) plus rtree-indexed lng/lat; edges carry an
  integer-meter weight, a 3-m Douglas-Peucker-simplified shape blob, and an
  interned street-name id. Consumed by the offline walk+transit router.
- `data/<name>.routes.sqlite` — transit route geometry (bus/tram/subway/
  light_rail/monorail/train) for the map's route overlay.

Already-built files are skipped. On `/poi?bbox=`, the server does a fast
rtree-indexed spatial query (`poi_rtree JOIN poi ON rowid`) and returns a
compact binary bundle (`POIB` header + columnar lng/lat/name_idx/category_idx
typed arrays + a shared string pool + packed per-POI props). The client
parses the buffer into POI objects with all strings pooled, so repeated
values like `"Starbucks"` or `"restaurant"` share one JS string instance.
`/walk-graph?bbox=` emits an equivalent `WALK` binary bundle — edges sorted
by weight so most fit in a u8 column, name indices u8/u16/u32-packed based
on the region's unique-name count, and shapes concatenated once into a
single buffer referenced by offset/length.

Both bundles are stored in IndexedDB as raw `ArrayBuffer` per region,
bypassing JSON framing entirely.

## Transit schedules (GTFS)

For the in-app trip planner to do walk + transit routing, `data/schedule.sqlite`
needs to exist. It holds every agency's routes, trips, stop_times, calendars,
and authoritative route shapes (for drawing the actual bus path on the map).

### Just one agency (quick test)

```
./get-gtfs-stm.sh
python3 build-schedule-db.py stm gtfs/stm.zip data/schedule.sqlite
python3 link-gtfs-to-osm.py data/schedule.sqlite data/canada-260417.routes.sqlite
```

This gets you ~11 MB of DB covering STM (Montreal).

### All schedules (Canada + US, or any country)

Uses the [Mobility Database](https://mobilitydatabase.org) catalog of
~2,000 GTFS feeds worldwide. Pick a country code and the catalog filter script
emits a `feeds-<cc>.tsv` with slug / URL / name per feed.

```
# 1. Wipe the old schedule (the schema may have changed; incremental rebuild
#    of old feeds doesn't backfill new fields like GTFS shapes).
rm -f data/schedule.sqlite data/schedule.sqlite-shm data/schedule.sqlite-wal

# 2. Fetch a fresh Mobility Database catalog (updated ~monthly)
curl -sSL --max-time 120 https://files.mobilitydatabase.org/feeds_v2.csv \
  -o data/mdb-catalog.csv

# 3. Generate per-country feed lists
python3 get-gtfs-catalog.py --country CA --catalog data/mdb-catalog.csv \
  --output feeds-ca.tsv
python3 get-gtfs-catalog.py --country US --catalog data/mdb-catalog.csv \
  --output feeds-us.tsv

# 4. STM isn't registered in Mobility Database — append it manually if wanted
printf 'stm\thttps://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip\tSTM\n' \
  >> feeds-ca.tsv

# 5. Ingest. Canada is ~100 feeds (~30 min); US is ~900 feeds (~2–3 hours).
#    Both stream: download one zip → validate → ingest → delete → next.
#    Peak disk = one zip at a time (~100-200 MB).
mkdir -p logs
python3 ingest-gtfs.py data/schedule.sqlite --feeds feeds-ca.tsv --tmp /tmp \
  2>&1 | tee logs/ingest-ca.log
python3 ingest-gtfs.py data/schedule.sqlite --feeds feeds-us.tsv --tmp /tmp \
  2>&1 | tee logs/ingest-us.log

# 6. Link GTFS stops to the OSM route_stop nodes (needed for "click stop → see
#    which bus is coming"). Pass every per-country routes.sqlite you have.
python3 link-gtfs-to-osm.py data/schedule.sqlite \
  data/canada-260417.routes.sqlite data/us-260417.routes.sqlite
```

**Validator**: `ingest-gtfs.py` runs `validate-gtfs.py` on each zip before
touching the DB. Feeds that fail validation get logged and skipped — nothing
corrupts the existing DB. Expect ~10% of feeds to be flagged (stale calendars,
missing `stop_times.txt`, broken references). You can inspect them with
`grep '^\[fail\]' logs/ingest-*.log`.

**Resumable**: `feed_meta` tracks each ingested slug. Re-running the same
`ingest-gtfs.py` command skips anything already done, so crashes or pauses
are harmless.

**Bot-blocked feeds**: some agencies (mostly CivicPlus-hosted city sites and
Cloudflare-fronted portals) return 403 to plain HTTP clients. Feeds whose
plain download fails are automatically retried through a real headful
chromium (`browser-download.py`, using zendriver from `housing-search/.venv`;
spawns Xvfb when there's no display). Opt out with `--no-browser-fallback`.

**Feed URL freshness**: `update-transit-schedules.py` re-fetches the Mobility
Database catalog at the start of every run and merges it into `feeds-*.tsv`
(updated URLs, new active agencies, deprecated ids dropped, manual entries
like `stm` preserved, same-URL duplicates skipped). Disable with
`--no-refresh-feeds`. The manual regeneration below is only needed for the
first-ever setup or a new country.

**Final sizes** (rough):
- ~100 Canadian feeds → ~80 MB schedule.sqlite (without shapes: ~30 MB;
  shapes add ~50 MB)
- ~900 US feeds on top → ~400 MB schedule.sqlite
- Peak during ingest: one GTFS zip in `/tmp` (~50-300 MB for big agencies)

### Other countries

Same pattern:

```
python3 get-gtfs-catalog.py --country GB --catalog data/mdb-catalog.csv \
  --output feeds-gb.tsv
python3 ingest-gtfs.py data/schedule.sqlite --feeds feeds-gb.tsv --tmp /tmp
```

Use ISO 3166-1 alpha-2 codes. Add `--include-auth` to include feeds that
require API keys (you'll need to handle those URLs separately).

## Download fonts (one-time, for labels/landmarks)

```
./get-fonts.sh
```

Shallow-clones `klokantech/klokantech-gl-fonts` (which ships pre-built glyph
PBFs) and copies **KlokanTech Noto Sans Regular** into `fonts/` (~3.7 MB).

## Download POI icons

```
./get-icons.sh
```

Shallow-clones `mapbox/maki` and copies ~215 SVG icons into `icons/` (~900 KB).
MapLibre registers them as style images; the `poi-icons` layer draws the
matching icon per feature (by `subclass`, falling back to `class`, then to a
red dot default marker).


That one fontstack is enough for road names, place names, and POI labels
(shops, cafés, schools, etc.). Without it, the map renders with no text.

Fonts are served at `/fonts/<stack>/<range>.pbf`. **The first `↓ save current
view` download also prefetches all font glyph ranges**, so after one save the
app is fully offline — no more font fetches on later zooms/pans.

## Run

```
python run.py
```

Listens on **port 8465**. Open http://localhost:8465 on the same machine.

## HTTPS is required for geolocation (a.k.a. the whole point of the game)

Browsers **silently block** `navigator.geolocation` (and thus the map's
"where am I" button) on plain HTTP *except* for `localhost`. Hitting the app
from your phone at `http://192.168.x.x:8465` → no permission prompt, just
failure. You need HTTPS for any remote access.

### Option A — quick cloudflared trial tunnel

Ephemeral URL, zero config, dies when you Ctrl-C:

```
cloudflared tunnel --url http://localhost:8465
```

Prints a `https://<random>.trycloudflare.com` URL — open that on your phone.

### Option B — named tunnel with your own domain

One-time setup:

```
cloudflared tunnel login                       # opens browser for auth
cloudflared tunnel create creature-collect
cloudflared tunnel route dns creature-collect poke.phylliidaassets.org
```

Write `~/.cloudflared/config.yml`:

```yaml
tunnel: creature-collect
credentials-file: /home/you/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: poke.phylliidaassets.org
    service: http://localhost:8465
  - service: http_status:404
```

Then:

```
cloudflared tunnel run creature-collect
```

### NixOS service (optional, for "always on")

If you run NixOS and want the tunnel to come up at boot, add to
`/etc/nixos/configuration.nix`:

```nix
services.cloudflared = {
  enable = true;
  tunnels."creature-collect" = {
    credentialsFile = "/var/lib/cloudflared/<tunnel-id>.json";
    ingress."poke.phylliidaassets.org" = "http://localhost:8465";
    default = "http_status:404";
  };
};
```

Copy the credentials JSON to `/var/lib/cloudflared/` and `nixos-rebuild switch`.

## Static region hosting (optional — alternative to running the server)

The dynamic Flask server (`run.py`) is the path of least resistance for a
self-hosted single-user deployment. If you want to share the app at scale
without keeping a Python server alive, you can pre-build per-region static
files and serve them from a free CDN. The pipeline takes the same SQLite
+ mbtiles inputs that `run.py` would use, and produces a directory of
per-region artifacts that any S3-compatible host (or Hugging Face) can
serve.

### Build region files

Two-step pipeline. Step 1 plans the region boundaries (adaptive quad-tree
that subdivides until every leaf's largest artifact fits the size
budget). Step 2 materializes the actual files (walk graph, POIs,
housenumbers, vector tile PMTiles archive) per leaf.

```bash
# 1. Partition. Default "tile-only" mode measures tile bytes exactly
#    from mbtiles and estimates other artifacts as a fixed fraction
#    of tile bytes. No Flask server needed. ~20 min for full NA.
python partition-regions.py \
    --bbox=-170,7,-52,84 \
    --budget-mb=50 \
    --out=regions-na.json

# 2. Materialize. Needs `python run.py` in another terminal — the build
#    fetches walk.bin / poi.bin / housenumbers.bin via the existing
#    Flask bbox endpoints, and writes a fresh PMTiles archive per
#    region from mbtiles directly. Resumable: re-running skips
#    regions whose 4 files already exist on disk.
python build-regions.py --plan=regions-na.json --out-dir=regions
```

For all of North America at a 50 MB budget this produces ~655 regions and
~18 GB on disk. Output shape:

```
regions/
  index.json                    — manifest the client downloads first
  region-0000/walk.bin
  region-0000/poi.bin
  region-0000/housenumbers.bin
  region-0000/tiles.pmtiles
  region-0001/...
  ...
```

Partitioner alternatives (all opt-in; the default tile-only mode is the
recommended path for most use cases):

| Flag | Behavior |
|---|---|
| (none) | Default tile-only mode — fastest, no server needed |
| `--calibrate` | Runs an HTTP-probe calibration pass to fit byte-per-row constants |
| `--calibration-from=PATH` | Loads fits from a previous `regions.json` |
| `--actual-sizes` | HTTP-probes Flask for true packed bytes per leaf — slow, precise |
| `--skip-calibration` | Hardcoded constants, no probes, no calibration |

### Upload to Hugging Face Datasets

Free unlimited public storage + bandwidth. **No payment method on file,
so no spending-blowup risk** if the app gets popular. Uses an existing CDN
under the hood and supports HTTP range requests (needed for PMTiles).

One-time setup:

```bash
pip install huggingface_hub          # or add to shell.nix
hf auth login                        # paste a write-scoped token from
                                     # huggingface.co/settings/tokens
```

Upload (parallel, resumable, re-runnable):

```bash
HF_HUB_DISABLE_XET=1 HF_HUB_ENABLE_HF_TRANSFER=1 \
hf upload-large-folder \
    TessaCoil/maps-dataset regions/ \
    --repo-type=dataset \
    --num-workers=2
```

Or use the wrapper: `scripts/upload-regions.sh [repo-id]` — same
command, with preflight checks and the env vars baked in.

The creature content pack (fusion data, sprites, shiny palettes,
egg/candy icons, types, categories — see `build-content-pack.py`) has
the same shape of wrapper:

```bash
python3 build-content-pack.py            # → packs/creature-fusion/pack.bin
scripts/upload-content-pack.sh           # → TessaCoil/creature-pack
```

For cron, `scripts/update-transit-and-upload.sh` first runs
`update-transit-schedules.py` (GTFS refresh + region `schedule.json`
re-export) and then the upload, with overlap locking and logging to
`logs/transit-refresh.log`. Example crontab in the script header.

(Substitute your HF user/repo for `TessaCoil/maps-dataset`.)

Notes on the flags — all empirically needed to actually finish a
multi-GB upload over residential bandwidth without hanging:
  - `HF_HUB_ENABLE_HF_TRANSFER=1`: routes uploads through the Rust
    `hf_transfer` library (`pip install hf_transfer`). The pure-Python
    path stalls on slow TLS handshakes when many files transfer in
    parallel.
  - `HF_HUB_DISABLE_XET=1`: disables HF's experimental Xet storage
    backend. Xet was hanging mid-upload on the regions/ payload.
  - `--num-workers=2`: caps parallelism low enough that residential
    upstreams don't saturate and trigger TLS / ISP throttling.

Resumable: re-running picks up changed files only — if it does hang,
Ctrl-C and re-run.

Files become reachable at:

```
https://huggingface.co/datasets/<your-user>/maps-datum/resolve/main/index.json
https://huggingface.co/datasets/<your-user>/maps-datum/resolve/main/region-0000/tiles.pmtiles
```

(Substitute your HF username and repo name. CORS + range requests work out
of the box for the `resolve/main/...` URLs.)

### Alternative: Cloudflare R2

If you'd rather not depend on Hugging Face (or want hard spending caps
via Cloudflare's billing alerts), R2 is the next-best option: ~$0.12/month
storage for 18 GB, zero egress. Replace the upload step with:

```bash
rclone sync regions/ r2:<bucket-name>/ --progress
```

See https://developers.cloudflare.com/r2/api/s3/tokens/ for rclone config
+ token setup. Don't forget to set CORS on the bucket (allow `GET` + `HEAD`
+ range/if-match/if-none-match headers from your PWA's origin).

### Weekly refresh via cron

OSM data churns daily-ish; refreshing static regions weekly keeps the app
current. The pipeline is fully idempotent and resumable, so a weekly run
is safe to leave unattended.

```cron
# Refresh static regions every Sunday at 03:00 UTC.
0 3 * * 0 /path/to/self-hosted-creature-collect/refresh-regions.sh \
    >> /var/log/region-refresh.log 2>&1
```

Where `refresh-regions.sh` ties the steps together. Suggested template:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# 1. Refresh OSM extract + rebuild tiles/POIs/walk/housenumbers.
#    (See the build sections higher up in this README; minimal version:)
./get-shapefiles.sh                          # idempotent
./make-tiles.sh                              # rebuilds *.mbtiles + *.sqlite

# 2. Start Flask in the background — build-regions.py needs it for the
#    walk/poi/housenumbers fetches.
python run.py &
FLASK_PID=$!
trap "kill $FLASK_PID" EXIT
sleep 5                                      # wait for Flask to be ready

# 3. Re-build region files. partition-regions.py only needs to re-run if
#    the budget or root bbox changed; otherwise reuse the existing plan.
#    build-regions.py is resumable — files that haven't changed are
#    skipped via the on-disk check.
python build-regions.py --plan=regions-na.json --out-dir=regions

# 4. Sync to the host. upload-large-folder + rclone sync both diff on
#    content hash; only changed files transfer. The two env vars +
#    --num-workers=2 mirror what the "Upload to Hugging Face Datasets"
#    section above documents; needed in practice to keep multi-GB
#    uploads from hanging on residential bandwidth.
HF_HUB_DISABLE_XET=1 HF_HUB_ENABLE_HF_TRANSFER=1 \
hf upload-large-folder \
    <your-user>/maps-dataset regions/ \
    --repo-type=dataset --num-workers=2
# OR for R2:
# rclone sync regions/ r2:<bucket-name>/ --progress
```

Make the script executable (`chmod +x refresh-regions.sh`) and verify a
manual run completes cleanly before adding the cron entry. Add a
`--limit=10` flag to `build-regions.py` for a first dry-run to confirm the
pipeline works end-to-end before committing to the full ~30-60 min
rebuild.

## On iPhone: install as a PWA

Open the HTTPS URL in Safari → tap **Share** → **Add to Home Screen**. Launch
from the home-screen icon (not from Safari) — this is what keeps offline tiles
from being evicted by iOS after ~7 days.


# Native app wrapper (Capacitor)

The Flask + `static/` PWA is the source of truth for the app. To
distribute it as a native Android / iOS app — and to unlock native
APIs the browser can't reach (background step counter, notifications,
better persistent storage) — there's a thin **Capacitor** wrapper
configured at the repo root.

The wrapper does **not** touch the existing PWA. The browser-PWA
install path keeps working unchanged for anyone who prefers it.

### What's in the wrapper

- **`package.json`** — declares Capacitor deps (`@capacitor/core`,
  `cli`, `android`, `ios`).
- **`capacitor.config.json`** — uses `server.url` mode, so the wrapped
  app loads `https://poke.phylliidaassets.org` directly in a WebView.
  The native app behaves like "browser pinned to your URL" with the
  option to wire native plugins later. Change `server.url` if you
  self-host elsewhere.
- **`shell.nix`** already has the full Android toolchain (Node, JDK
  17, Android SDK API 34, `adb`, `gradle`, `libimobiledevice`).

### One-time system-level requirements

`shell.nix` covers the dev toolchain. Two things have to live
system-wide because they're daemons / kernel-level:

```nix
# /etc/nixos/configuration.nix
services.usbmuxd.enable = true;
users.users.<you>.extraGroups = [ "usbmuxd" ];
```

Then `sudo nixos-rebuild switch` and replug your phone. `usbmuxd` is
needed for `libimobiledevice` to find an iPhone over USB; the Android
toolchain doesn't depend on it.

### First-time bootstrap

From inside the dev shell (`nix-shell` / direnv):

```bash
npm install                # one-time, installs Capacitor
npx cap add android        # one-time, generates the android/ project
```

That `android/` directory is gitignored — it's a real Android Studio
project that wraps the web app.

### Build + install Android APK

```bash
npx cap sync android       # after any web/code change (no-op for server.url mode)
cd android && ./gradlew assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

`adb` finds the phone over USB (debugging must be enabled on the
phone — Settings → Developer options → USB debugging). The APK is
unsigned-debug, so re-installs prompt for a "trust" tap on the phone.

For an installable release APK, you'd add a signing config to
`android/app/build.gradle` and run `./gradlew assembleRelease`.

### iOS — needs a Mac somewhere

The IPA *build* step (Xcode + signing) requires macOS. Linux-only
options ranked by friction:

1. **GitHub Actions free macOS runner** — push code, GHA runs
   `xcodebuild`, downloads the `.ipa`. ~zero cost, ~5 min build cycle.
2. **Cloud Mac** (MacStadium, MacInCloud, AWS EC2 Mac) — SSH in, run
   `npx cap sync ios && xcodebuild`. ~$20-100/month.
3. **Borrow / buy a used Mac mini** — even a 2018 model handles it.

To install the resulting IPA on your iPhone from Linux, use
**SideStore** (preferred over vanilla AltStore for cross-platform
support) or **AltServer-Linux**. Both:

- Use a (burner) Apple ID to sign the IPA with a 7-day free
  developer profile.
- Install onto the phone via USB the first time, then auto-refresh
  the signing weekly while the daemon runs (SideStore does this
  over a local WireGuard tunnel; AltServer needs same Wi-Fi).
- Free Apple ID limit: 3 sideloaded apps at a time, 7-day expiry.
  Upgrading to the Apple Developer Program ($99/yr) lifts both and
  unlocks TestFlight (clean invites for friends).

Both AltServer-Linux and SideStore ship as glibc-linked binaries that
don't run directly on NixOS. Wrap them with `steam-run` for one-off
use, or enable `programs.nix-ld` in configuration.nix for permanent
support.

### Adding native plugins (future)

When you want to wire a native API into the JS, install the matching
Capacitor plugin and feature-detect at runtime:

```js
if (window.Capacitor) {
  // Native: real step counter / background GPS / etc.
} else {
  // Web: existing GPS-distance fallback
}
```

This keeps both the native and PWA paths working from the same
codebase. Anything with no web equivalent (real local notifications
when the app is closed, background tracking) just gets gated behind
the `Capacitor` check.


# Download pokemon files

https://hackmd.io/@PIF-Tech/AltDownloadGuide#Download
