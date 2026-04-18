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
  out="data/${name}.mbtiles"
  if [ -e "$out" ]; then
    echo "skip: $out already exists"
    continue
  fi
  echo "==> $pbf -> $out"
  tilemaker --input "$pbf" --output "$out" \
    --config "$RESOURCES/config-openmaptiles.json" \
    --process "$RESOURCES/process-openmaptiles.lua"
done

if [ "$found" = 0 ]; then
  echo "no .osm.pbf files found in osmpbf/"
fi
