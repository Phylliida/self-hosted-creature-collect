# Session Summary: Creature Collect — Game Loop Buildout

This session built the entire creature-collecting game on top of the existing
PWA map. Everything from "no creatures exist" → "you can catch fusion pokémon
in the wild, see them in your inventory and pokédex, with type-weather rotating
the spawn composition daily and weekly".

## What got built

### Spawn system (`static/spawns.js`)
- Ported Brent's xor4096 PRNG from the user's prior project (verbatim).
- Sliding-window spawn algorithm: each `(cell, minute-tick)` is a deterministic
  PRNG slot; if the roll is below `SPAWN_CHANCE_PER_TICK` (0.0032) a creature
  is born at that minute and lives 5 minutes. `LIFETIME_TICKS = 5`.
- All devices reading the same minute-tick get the same hit/miss → two players
  in the same place see the same creatures.
- Cells are ~11 m (`SCALE = 10000`).
- Spawnable list is restricted to evolution roots and excludes legendaries.
  Pre-evolutions added in later gens (Cleffa→Clefairy etc.) don't disqualify
  the gen-1 form because the player can never catch the gen-2 baby anyway.
- Asymmetric A/B pool architecture supports a wider A range (1-509) but is
  currently constrained to gen 1 (1-150) for both — `SPAWNABLE_SPECIES_A_FULL`
  is the toggle for later.

### Type weather (in `spawns.js` + inventory header)
- Daily type rotates every UTC day, weekly every UTC week, both deterministic
  (xor4096 seeded by date + salt).
- Two weighted pools: A is weighted by each species' **primary** type (what A
  contributes to the fusion), B by each species' **secondary** (or primary if
  single-typed). Critical insight — the fusion typing rule is "primary from A,
  secondary from B", so Scyther (BUG/FLYING) only gets the FLYING boost when in
  slot B, not slot A.
- Each match multiplies weight by 25× (so a species hitting both daily and
  weekly is 625× weight; a fusion where both A and B max out is 625×625 vs an
  unrelated × unrelated).
- Density stays constant; only composition shifts.
- "Today: 🔥 Fire · Week: ☠ Poison" chips at top of inventory; warning banner
  if types JSON not downloaded (spawning silently disabled).

### Sprite pipeline (`static/sprites.js`)
- Each fusion sprite is a 96×96 crop from a 960×4896 sheet (10 cols × 51 rows
  = 510 slots per file, 150 files for our scope).
- Bulk download: fetch each sheet, decode once, crop every (a, b) needed,
  store each crop as its own PNG blob in IndexedDB keyed `"a-b"`. Resume-aware
  via a localStorage tracker plus a one-time idempotent IDB key scan.
- Cropping trims to the opaque-pixel bbox (alpha threshold 8) so creatures
  are pinned correctly in markers — the un-trimmed 96×96 PNG was the source
  of "creatures drift below the lat/lng" because each species has its art at
  a different position in the cell.
- Per-icon storage in IDB (~22 500 entries, ~150 MB total) so loading squirtle
  × caterpie reads only that ~10 KB blob — no sheet ever touched after
  download.
- Sheet LRU cache reduced 8 → 2 (only matters during bulk download; saves
  ~108 MB of held ImageBitmaps).
- One-time "repair" pass migrates pre-trim (legacy 96×96 padded) PNGs in IDB
  to trimmed crops without re-fetching. Skipped on subsequent downloads via
  `cc.spritesRepairDone` flag.

### Marker / battle / catch flow (`static/creatures.js`)
- HTML markers via MapLibre's `Marker` API, anchor `'center'`. Critical bug
  fixed: any `position` rule on the marker root overrides MapLibre's
  `position: absolute` and puts the element in normal document flow, where
  successive markers stack and accumulate Y-offsets that ride on top of the
  per-marker translate. Symptom was "all markers pivoting around the first
  one". Fix: do not set `position` on `.creature-marker`.
- Marker root is `pointer-events: none` with `pointer-events: auto` only on
  the sprite img + placeholder dot, so map gestures (pinch, wheel, pan) pass
  through the transparent area surrounding the sprite. `touch-action: none`
  on the sprite tells the browser to leave gesture handling to MapLibre.
- Click on a marker calls `e.stopPropagation()` so the map's POI click
  handler doesn't fire underneath.
- Markers visible only within 100 m of the GPS fix. First-fix accuracy filter
  (skip fixes > 50 m for the first 5 s) prevents the coarse-Wi-Fi-then-GPS
  switcheroo where the user briefly sees the wrong neighbourhood's spawns.
- Marker scales with map zoom via a `--creature-marker-size` CSS variable
  updated on every `zoom` event — same *geographic* size at every zoom.
- Battle screen: full-screen overlay, sprite at top, Catch / Flee buttons.
  Reuses the marker's existing object URL when available so the sprite shows
  with no flash.
- Catch writes to `cc.capturedCreatures`, marks the spawn id in
  `cc.caughtSpawnIds` so the marker disappears locally (other players still
  see it — no server). Catch records `caughtAt: { lat, lng, poi, timestamp }`
  with the nearest named POI within 500 m via
  `window.CreatureCollectAPI.findNearestNamedPoi`.

### Inventory + Detail + Fusion sub-view + Pokédex
- Inventory grid: virtualized (windowed render), shows captured creatures with
  search, sort (Recent / Level / Size / Name / Species), rename via inline
  `✎` button, sticky `×` to close.
- Detail view: art, types, stats, caught location (clickable → flies map
  there), evolutions, family tree (collapsible grid), and "View dex entry →"
  link to the fusion sub-view.
- Fusion sub-view (between pokédex and detail): shows the fusion's sprite,
  type chips, all your captures of that fusion (each clickable to detail),
  and the encounter info. Species names in the title are clickable
  (`Grimer × Eevee`) — clicking "Grimer" pre-fills `Search first species` in
  the pokédex.
- Pokédex view: virtualized 3-col grid of every fusion ever seen. Stats
  header `N caught · M encountered`. Three search inputs (any / first /
  second species name) and three type filters (either / first / second slot).
  Active filters get an accent outline. Sort by recent / first-name /
  second-name / first-id / second-id with direction toggle.
- Real navigation history: `_viewStack` of `{ view, ... }` objects. Each
  show* pushes; every `←` button pops. So you can go inventory → pokédex
  → fusion(Grimer×Eevee) → click "Eevee" → pokédex(searchB=Eevee) → another
  fusion → ←←← back through the chain.
- Family tree silhouettes: unseen fusions render with `filter: brightness(0)`
  and name masked as `???`. Same treatment in the "Evolves to" rows.

### Settings polish
- Trainer name field on the Backup row alongside Export / Import / Save.
- Save button POSTs to `/save`; server writes
  `saves/<name>_<millis>.json` (atomic via `.tmp` + replace), so every save
  is a new history entry, not an overwrite. Sanitization: `^[A-Za-z0-9][A-Za-z0-9._\- ]{0,63}$`.
- All Settings buttons themed (Export/Import/Save + sprite Download/Clear)
  via `var(--ui-input-bg/text/border/radius)`; same for `#panel button` and
  `#panel input` in the offline-maps panel.
- Per-region size measurement now cached in localStorage
  (`cc.regionSizes.v1`), invalidated on download/refresh/delete; was running
  every panel render.
- Sizes per-region now display one bucket per line.

## Major bugs we hunted

### `position: relative` on the marker root
Symptom: all map markers appeared offset, "pivoting around the first one"
during pan/zoom. Found by reading MapLibre's vendor source: it sets
`position: absolute; left: 0; top: 0` on the marker via CSS and a
per-marker `transform: translate(...) translate(-50%, -50%)`. Same-specificity
class on our root (`.creature-marker`) overrode that to `relative`, leaving
markers in the document flow. Subsequent siblings stacked vertically and the
transforms rode on top, accumulating offsets. Fix was a one-line CSS deletion.

### Sprite drift (un-trimmed crops)
Symptom: clicking a marker opened a popup at the right place but the sprite
sat below the popup. Root cause: cropped sprites were 96×96 PNGs with
transparent padding, and each species' art is at a different position in the
cell. `object-fit: contain` centred the 96×96 box, not the actual creature
pixels. Fixed by trimming to the opaque-pixel bbox at crop time (and
self-healing legacy entries on first read via PNG IHDR sniff).

### Object-URL leaks
Symptom: long-running sessions hit RAM ceilings even after sprite download
finished. `URL.createObjectURL(blob)` keeps the blob alive; we relied on
`img.onload` to revoke, but `onload` doesn't fire when the img is removed
mid-load (e.g. virtualizer scrolling fast). Added `revokeObjectUrlsIn(el)`
helper called on every row removal in the virtualizer + before any
`innerHTML` replacement in detail / fusion / family-tree renders. Markers
were already safe (revoke on `removeMarker` regardless of `onload`).

### Virtualizer measurement
Spent way too long here. Tried: off-screen container, in-grid sample,
post-rAF re-measure, font-ready re-virtualize. None reliably worked on the
first inventory open. Final answer: hardcode `cardHeight: 178` (inventory)
and `cardHeight: 150` (pokédex) in the `virtualizeGrid` opts, and pin the
matching `height` + `overflow: hidden` in the card CSS so cards can't overflow
their slot.

### IF vs canonical Pokédex IDs
Pokémon Infinite Fusion uses canonical Pokédex numbering only for gen 1-2.
From gen 3+ it diverges (e.g. IF #252 = Azurill, canonical = Treecko).
Originally we used canonical names from `pokemon.txt`; when expanding the A
pool to 1-509 we discovered the mismatch. Regenerated `pokemon.txt` from
`species.dat` to use IF's `@real_name` for all 509 slots so names match
sprite IDs end-to-end.

### Pokédex sticky X overlap
The X button is sticky-positioned at the top-right of the `.sheet` scroll
container. The browse-header's "Dex →" button on the right edge of the row
was running into it. Added `padding-right: 28px` to the header so the action
button stays clear.

### MapLibre `_getMapTouches` filtering
Investigated whether MapLibre filters touches by target and found
`_getMapTouches` does `this._el.contains(i.target)` — markers ARE descendants
of `getCanvasContainer()`, so touches on them count. The real reason finger-
crossing-marker stopped pinch-zoom was `touch-action` defaulting to `auto` on
the sprite img, which let the browser claim the gesture before MapLibre's JS
handler could call `preventDefault`. `touch-action: none` on the marker
children fixed it.

## Things I learned

- Always grep MapLibre's vendor source before reasoning about why a marker
  misbehaves. Lots of subtle CSS the docs don't mention.
- For grids that may render thousands of items, virtualization with hardcoded
  card heights beats dynamic measurement. Dynamic measurement on the first
  open of a just-shown panel is a layout-timing minefield.
- `position: relative` on a custom `Marker` element is a footgun: same
  specificity as MapLibre's `.maplibregl-marker { position: absolute }`, and
  whichever CSS loads later wins — leaving the marker in normal flow with
  cumulative sibling offsets.
- Object-URL leaks are silent and devastating in long-running PWAs. Treat
  every `URL.createObjectURL` as needing an explicit revoke at *every* place
  the holding element gets removed, not just `img.onload`.
- iOS Safari's storage / RAM eviction is genuinely tighter than Chrome —
  multi-hundred-MB IDB usage is fine on desktop but iffy on iOS unless the
  user grants `navigator.storage.persist()` (we request it on first catch
  and during sprite download).
- For deterministic shared-world spawn algorithms, always seed with
  `(cell_coords, time_bucket, salt)` and use a real PRNG (xor4096), not
  `Math.random` or hash-string-and-modulo. The PRNG quality matters because
  the same seed regenerates every visible cell.

## Files added/touched

```
data/Battlers/types.json         (new — extracted from species.dat)
data/Battlers/evolutions.json    (new — extracted from species.dat)
data/Battlers/pokemon.txt        (regenerated with IF custom names)
static/spawns.js                 (new — sliding window spawn generator)
static/sprites.js                (new — per-icon IDB cache, bulk download)
static/species.js                (new — names/types/evolutions loader)
static/creatures.js              (new — markers, battle, inventory, pokédex,
                                  fusion sub-view, weather, virtualizer,
                                  family tree, all UI)
static/index.html                (script tags, settings rows, save button,
                                  trainer name field, themed buttons,
                                  CreatureCollectAPI hook for POI lookup)
run.py                           (added /creature-* routes, /save endpoint
                                  with timestamp-suffixed filenames)
.gitignore                       (added saves/)
```

## Things deliberately NOT built (for next session)
- **Evolve mechanic**: button to consume a captured creature and replace it
  with its evolved form. Required for the "babies only" spawn rule to feel
  rewarding; user explicitly deferred to design a level-up loop first.
- **Level-up mechanic**: walking distance? POI visits? combat? user wants to
  think about this.
- **Items / stones**: stone-evolutions can't fire without a way to acquire
  stones.
- **Legendaries**: separate mechanic TBD.
- **Wider A pool (1-509)**: architecture in place, gated behind one constant
  swap + bumping `bulkDownload` indexTo to 509 (and ~45-90 min of cropping).

## Things the user said yes to that I'd remember
- 0 data usage / WiFi-prefetch model is non-negotiable. Never auto-fetch.
  Every fetch must be gated behind an explicit user action.
- "Done is better than perfect" — when I started overthinking dynamic
  measurement, hardcoded heights were the right call.
- The user is kind, says ":3" and "tytytyty", and notices both UX and
  perf issues quickly. Worth taking their bug reports seriously and rooting
  them out instead of patching with hacks.

— and that's the session.
