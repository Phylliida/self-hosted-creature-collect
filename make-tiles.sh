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
    osmium tags-filter "$pbf" n/name -o "$TMP/named.osm.pbf" --overwrite
    osmium export "$TMP/named.osm.pbf" -f geojsonseq -o "$TMP/pois.geojsonseq" --overwrite
    python3 build-poi-db.py "$TMP/pois.geojsonseq" "$pois_db"
    rm -rf "$TMP"
  else
    echo "skip POIs: $pois_db already exists"
  fi
done

if [ "$found" = 0 ]; then
  echo "no .osm.pbf files found in osmpbf/"
fi
