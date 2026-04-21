#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

RESOURCES="$(dirname "$(dirname "$(readlink -f "$(which tilemaker)")")")/share/tilemaker"
mkdir -p data

shopt -s nullglob
pbfs=()
for p in osmpbf/*.osm.pbf; do
  # Skip the merged helper file so we don't feed it back into itself.
  case "$(basename "$p")" in
    .merged.osm.pbf) ;;
    *) pbfs+=("$p") ;;
  esac
done
shopt -u nullglob

if [ ${#pbfs[@]} -eq 0 ]; then
  echo "no .osm.pbf files found in osmpbf/"
  exit 0
fi

# ---- tiles: always a single merged mbtiles -------------------------------
# With multiple per-country PBFs the old setup produced one mbtiles per
# country and the /tiles handler picked whichever happened to be biggest
# for each (z,x,y), silently dropping the other country's features on any
# tile that straddled a border. Merging at the PBF level fixes that once
# and for all: tilemaker sees every feature in one pass, emits one mbtiles
# with all of them, and the server has a single source of truth.
if [ ${#pbfs[@]} -eq 1 ]; then
  tile_input="${pbfs[0]}"
else
  tile_input="osmpbf/.merged.osm.pbf"
  needs_merge=0
  if [ ! -e "$tile_input" ]; then
    needs_merge=1
  else
    for p in "${pbfs[@]}"; do
      if [ "$p" -nt "$tile_input" ]; then
        needs_merge=1
        break
      fi
    done
  fi
  if [ "$needs_merge" = 1 ]; then
    echo "==> merging ${#pbfs[@]} PBF(s) -> $tile_input"
    osmium merge "${pbfs[@]}" -o "$tile_input" --overwrite
  else
    echo "skip merge: $tile_input is up to date"
  fi
fi

merged_mbtiles="data/merged.mbtiles"
if [ ! -e "$merged_mbtiles" ] || [ "$tile_input" -nt "$merged_mbtiles" ]; then
  echo "==> tiles: $tile_input -> $merged_mbtiles"
  # Slim config/lua strip layers and fields the client never reads.
  TILEMAKER_SHARE="$RESOURCES" tilemaker --input "$tile_input" --output "$merged_mbtiles" \
    --config tilemaker-slim.json \
    --process tilemaker-slim.lua
  # Delete per-country mbtiles left over from the old build flow so the
  # /tiles handler doesn't keep serving their stale content.
  for p in "${pbfs[@]}"; do
    stale="data/$(basename "$p" .osm.pbf).mbtiles"
    if [ -e "$stale" ]; then
      echo "   removing stale $stale"
      rm -f "$stale"
    fi
  done
else
  echo "skip tiles: $merged_mbtiles is up to date"
fi

# ---- per-PBF data stays split -------------------------------------------
# walk / POIs / routes / housenumbers are bbox-queried on the server, so
# keeping them per-country is fine (and faster to rebuild when only one
# country's PBF changes).
for pbf in "${pbfs[@]}"; do
  name="$(basename "$pbf" .osm.pbf)"
  pois_db="data/${name}.pois.sqlite"

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

  hn_db="data/${name}.housenumbers.sqlite"
  if [ ! -e "$hn_db" ]; then
    echo "==> housenumbers: $pbf -> $hn_db"
    TMP=$(mktemp -d)
    osmium tags-filter "$pbf" n/addr:housenumber w/addr:housenumber \
      -o "$TMP/hn.osm.pbf" --overwrite
    python3 build-housenumbers.py "$TMP/hn.osm.pbf" "$hn_db"
    rm -rf "$TMP"
  else
    echo "skip housenumbers: $hn_db already exists"
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

# Transit schedules (GTFS). Independent of per-PBF loop — one aggregated db.
schedule_db="data/schedule.sqlite"
shopt -s nullglob
gtfs_zips=(gtfs/*.zip)
if [ ${#gtfs_zips[@]} -gt 0 ]; then
  if [ ! -e "$schedule_db" ]; then
    echo "==> building schedule db from ${#gtfs_zips[@]} GTFS zip(s)"
    args=()
    for z in "${gtfs_zips[@]}"; do
      slug="$(basename "$z" .zip)"
      args+=("$slug" "$z")
    done
    python3 build-schedule-db.py "${args[@]}" "$schedule_db"

    # Link GTFS stops to OSM nodes for every routes.sqlite we built
    route_dbs=(data/*.routes.sqlite)
    if [ ${#route_dbs[@]} -gt 0 ]; then
      echo "==> linking GTFS stops to OSM nodes"
      python3 link-gtfs-to-osm.py "$schedule_db" "${route_dbs[@]}"
    fi
  else
    echo "skip schedule: $schedule_db already exists"
  fi
fi
