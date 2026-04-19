#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

RESOURCES="$(dirname "$(dirname "$(readlink -f "$(which tilemaker)")")")/share/tilemaker"
mkdir -p data

shopt -s nullglob
found=0
for pbf in osmpbf/*.osm.pbf; do
  found=1
  name="$(basename "$pbf" .osm.pbf)"
  mbtiles="data/${name}.mbtiles"
  pois_db="data/${name}.pois.sqlite"

  if [ ! -e "$mbtiles" ]; then
    echo "==> tiles: $pbf -> $mbtiles"
    tilemaker --input "$pbf" --output "$mbtiles" \
      --config "$RESOURCES/config-openmaptiles.json" \
      --process "$RESOURCES/process-openmaptiles.lua"
  else
    echo "skip tiles: $mbtiles already exists"
  fi

  if [ ! -e "$pois_db" ]; then
    echo "==> POIs: $pbf -> $pois_db"
    TMP=$(mktemp -d)
    osmium tags-filter "$pbf" n/name w/name \
      n/addr:housenumber w/addr:housenumber \
      n/addr:street w/addr:street \
      n/place=city,town,village,suburb,hamlet \
      w/place=city,town,village,suburb,hamlet \
      w/addr:interpolation \
      r/boundary=administrative \
      -o "$TMP/named.osm.pbf" --overwrite
    osmium export "$TMP/named.osm.pbf" -f geojsonseq \
      -o "$TMP/pois.geojsonseq" --overwrite
    python3 build-poi-db.py "$TMP/pois.geojsonseq" "$pois_db"
    rm -rf "$TMP"
  else
    echo "skip POIs: $pois_db already exists"
  fi

  walk_db="data/${name}.walk.sqlite"
  if [ ! -e "$walk_db" ]; then
    echo "==> walk graph: $pbf -> $walk_db"
    TMP=$(mktemp -d)
    osmium tags-filter "$pbf" w/highway \
      -o "$TMP/walk.osm.pbf" --overwrite
    python3 build-walk-graph.py "$TMP/walk.osm.pbf" "$walk_db"
    rm -rf "$TMP"
  else
    echo "skip walk graph: $walk_db already exists"
  fi

  routes_db="data/${name}.routes.sqlite"
  if [ ! -e "$routes_db" ]; then
    echo "==> routes: $pbf -> $routes_db"
    TMP=$(mktemp -d)
    osmium tags-filter "$pbf" \
      r/route=bus,trolleybus,share_taxi,subway,tram,light_rail,train,monorail \
      -o "$TMP/routes.osm.pbf" --overwrite
    python3 build-routes-db.py "$TMP/routes.osm.pbf" "$routes_db"
    rm -rf "$TMP"
  else
    echo "skip routes: $routes_db already exists"
  fi
done

if [ "$found" = 0 ]; then
  echo "no .osm.pbf files found in osmpbf/"
fi
