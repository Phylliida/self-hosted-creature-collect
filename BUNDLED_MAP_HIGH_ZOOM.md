# Why the bundled map looks sparse at zoom > 5

**Status (2026-05-24):** decided not to fix. The fix costs bundle
size and we'd rather keep the IPA/APK small. This doc exists so a
future Claude (or future-us) doesn't re-investigate from scratch
when "why are zoom 12 roads/labels so sparse in undownloaded areas?"
comes up again.

## The symptom

In any region the user hasn't downloaded, the map at visual zoom > 5
shows:
- A few major highways (interstates, national trunks) and that's it.
  No primary, no secondary, no residential streets.
- A few major-city labels and state names. No towns, no villages,
  no neighborhoods.
- No road names anywhere.

Pan around a city the user hasn't downloaded at zoom 14 → mostly
empty white-ish space with the occasional motorway and city label.

Downloaded regions look fine — those have full z=0..14 detail.

## Why — two independent factors

### Factor A: the bundled z=0..5 tiles only contain low-zoom data

`tilemaker-slim.json` (the config we feed tilemaker when generating
mbtiles from OSM PBF) sets per-layer minzooms. Layers we care about
at high zoom but whose data isn't in z=5 tiles:

| Layer | tilemaker minzoom | What's missing at z=5 |
|---|---|---|
| `transportation_name` | 8 | road names (the whole layer) |
| `transportation` features at z=5 | data-driven filter | only `motorway` + `trunk` survive; primary/secondary/etc. dropped |
| `place` features at z=5 | data-driven filter | only `city`/`state`/`country` survive; town/village/hamlet dropped |
| `building` | 13 | all buildings |
| `park` | 11 | all parks |
| `poi` | 12 | all POI icons |
| `water_name` | 10 | lake/river/bay names |
| `aerodrome_label` | 10 | airport names |

We can verify by inspecting tile contents (the protobuf in
`data/BundledData/tiles/5/*/*.pbf`):

```
$ python3 [tiny mvt parser]
data/BundledData/tiles/5/8/12.pbf
  place: 197 features  (class counts: city: 186, state: 11)
  transportation: 17 features (class counts: trunk: 8, motorway: 9)
  ...
```

No towns, no primary roads, no road names — they aren't there
because tilemaker didn't write them to z=5 tiles.

**MapLibre's over-zoom does not invent data.** When MapLibre
over-zooms a z=5 parent to render visual zoom 14, it just stretches
the features that exist in the parent tile. If `transportation_name`
isn't in the parent, there are no road names to draw — no amount of
cache tuning fixes this.

### Factor B: the per-source cache cap clamps `maxTileCacheZoomLevels`

In `static/index.html` (search for `maxTileCacheSize`):

```js
base:  { ..., minzoom: 0, maxzoom: 14, maxTileCacheSize: 32 },
local: { ..., minzoom: 0, maxzoom: 14, maxTileCacheSize: 64 },
```

MapLibre's internal cache-size formula
(`vendor/maplibre-gl.js` → `updateCacheSize`):

```
s = floor(ceil(W/512+1) * ceil(H/512+1) * maxTileCacheZoomLevels)
o = (typeof maxTileCacheSize === 'number') ? min(maxTileCacheSize, s) : s
```

With `maxTileCacheZoomLevels: 16` and a typical phone viewport,
`s ≈ 96`. But `maxTileCacheSize: 32` clamps the actual cache to
**32 tiles** — the per-source cap wins.

As the user pans at high zoom, those 32 slots fill with z=12-14
tiles. The bundled z=4/5 parents get LRU-evicted. Next over-zoom
needs them → MapLibre refetches → brief blank window during latency.

So even where the bundled data DOES contain something at z=5
(motorways, city labels), the cache eviction can make it disappear
briefly while panning.

## Why we're not fixing it

The data-side fix (lower the `transportation_name` minzoom in
`tilemaker-slim.json` from 8 to ~5, similarly for `place`'s town
class, etc., then re-tile) **bloats the bundled z=0..5 tiles
substantially**. Tested locally and the bundle got "too large" —
mobile app size matters more than dense fallback rendering in
undownloaded areas.

The cache-side fix (remove `maxTileCacheSize: 32` from the `base`
source) is cheap but only addresses Factor B. Without Factor A
addressed, the cache fix gets you "motorways and cities reliably,"
not "the full map fallback we'd want." Not worth the added RAM
pressure on iOS for that marginal improvement.

The intended UX is:
- bundled map = "you can see where you are at any zoom, with major
  context (continent, ocean, highways)"
- downloaded regions = "everything you actually need is here"

If users want detailed map in an area, they download the region.
The sparse-at-high-zoom fallback is acceptable because it nudges
toward downloading.

## What the fix would look like if we change our mind

### Data-side (Factor A — gives real road/label data at high zoom):

1. Edit `tilemaker-slim.json` minzooms. Candidate changes:
   - `transportation_name`: 8 → 5 (puts road names in z=5 tiles)
   - `place`: keep at 0 but adjust tilemaker class-filter logic to
     keep towns at z=5 (the per-class dropping is in
     `tilemaker-slim.lua` / upstream `process-openmaptiles.lua`)
   - probably leave `building`/`poi`/`park` at higher minzooms —
     those would explode tile size
2. Re-run `make-tiles.sh` (regenerates the `.mbtiles`)
3. Re-run `build-bundled-data.py` (extracts z=0..5 from mbtiles)
4. Re-run `scripts/build-capacitor.sh` then `cap sync` (rebuilds
   `dist/`), then bump APK/IPA build
5. Measure new bundle size, decide if acceptable

Past size-vs-detail tradeoff suggests this can ~2-3× the bundled
tile bytes depending on what's enabled.

### Cache-side (Factor B — keeps the parents resident):

```js
// static/index.html, around the sources block:
base:  { ..., minzoom: 0, maxzoom: 14 },  // no maxTileCacheSize cap
local: { ..., minzoom: 0, maxzoom: 14, maxTileCacheSize: 64 },
```

With `maxTileCacheZoomLevels: 16` already in the map options,
removing the per-source cap on `base` lets the computed `s ≈ 96`
prevail. That holds z=0..14 parents resident across normal panning,
so over-zoom from z=5 stays fast. iOS RAM impact: a parsed vector
tile is ~50-500 KB; 96 tiles × ~200 KB avg ≈ 20 MB per source.
Acceptable on modern devices but worth measuring.

### Combined

If you do both, you also probably want to bump `local`'s
`maxTileCacheSize` to match (or remove its cap too), since the
two sources both render layers at high zoom and you don't want
asymmetric eviction.

## Confirmation steps for future-Claude

If the symptom recurs and you want to verify before doing anything:

1. **Tile-side check** — pick a z=5 tile that should cover a city.
   Decode the protobuf and confirm layer/class contents. The mvt
   parser used during this investigation is reproducible with ~50
   lines of Python (varint reader + nested message walk). If
   `transportation_name` is absent and `transportation` only has
   motorway/trunk, that's Factor A in play (expected with current
   tilemaker config).

2. **Cache-side check** — in DevTools (web mode), set
   `window._dbgMapCache = () => map.style.sourceCaches.base._cache`
   and inspect `.max` and `.order.length` while panning at zoom 14.
   If `.max === 32` and `.order.length` saturates at 32, Factor B
   is active.

3. **In-app A/B** — temporarily comment out
   `maxTileCacheSize: 32` on the `base` source, reload, pan at
   zoom 14 over an undownloaded city. If motorways and major
   cities now persist smoothly without blank-flash, Factor B was
   the cache eviction half. If they're still sparse, that's
   Factor A (data not in z=5 tiles).

## Related context

- The `maxTileCacheZoomLevels: 16` map option (set during the
  static-regions session, 2026-05-20) was the right idea but
  incomplete — it widens the cache's zoom-level span but doesn't
  override the per-source size cap.
- The bundled-tile pipeline is intentionally tuned for "small
  ipa/apk, downloaded regions fill in details." If that calculus
  changes (e.g., we drop the bundled fallback entirely, or we
  switch to a model where everyone downloads at least one region
  on first launch), this whole tradeoff goes away.
- See HANDOFF.md → "Session — static region distribution" for the
  fuller context of how bundled-vs-downloaded coexists.
