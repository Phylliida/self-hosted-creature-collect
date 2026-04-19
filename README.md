# self-hosted-creature-collect
idk some self hosted creature collecting game

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

## Convert `.osm.pbf` to tiles + POI index

```
./make-tiles.sh
```

For each `osmpbf/<name>.osm.pbf` this produces:
- `data/<name>.mbtiles` — vector tiles (via tilemaker)
- `data/<name>.pois.sqlite` — big server-side POI index via
  `osmium tags-filter n/name w/name` (covers nodes AND named ways like
  buildings), then `osmium export` → `build-poi-db.py`. Polygon features get a
  centroid. Stores lng, lat, name, category, and a JSON `props` blob (address,
  opening_hours, phone, website, wheelchair, brand, cuisine, description,
  wikipedia/wikidata, internet_access).

Already-built files are skipped. On `/poi?bbox=`, the server does a fast
indexed SQL query (`WHERE lng BETWEEN … AND lat BETWEEN …`) and returns JSON.
The client stores the subset in IndexedDB so further POI search is fully
offline.

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

## On iPhone: install as a PWA

Open the HTTPS URL in Safari → tap **Share** → **Add to Home Screen**. Launch
from the home-screen icon (not from Safari) — this is what keeps offline tiles
from being evicted by iOS after ~7 days.
