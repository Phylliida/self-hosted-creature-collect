#!/usr/bin/env python3
import json
import os
import shutil
import sqlite3
import sys
import tempfile

PRIORITY = [
    "amenity", "shop", "tourism", "leisure", "historic",
    "craft", "office", "public_transport", "railway", "highway",
]

EXTRA_FIELDS = [
    "addr:housenumber", "addr:street", "addr:city", "addr:postcode",
    "opening_hours",
    "phone", "contact:phone",
    "website", "contact:website",
    "wheelchair",
    "brand", "operator",
    "cuisine",
    "description",
    "wikipedia", "wikidata",
    "internet_access",
]

ADDR_MATCH_EPS = 0.0005  # ~55 m at mid latitudes


def center(feat):
    geom = feat.get("geometry") or {}
    gtype = geom.get("type")
    coords = geom.get("coordinates") or []
    if gtype == "Point" and len(coords) >= 2:
        return coords[0], coords[1]
    try:
        if gtype == "Polygon" and coords and coords[0]:
            ring = coords[0]
        elif gtype == "MultiPolygon" and coords and coords[0] and coords[0][0]:
            ring = coords[0][0]
        else:
            return None, None
        if not ring:
            return None, None
        sx = sum(p[0] for p in ring)
        sy = sum(p[1] for p in ring)
        n = len(ring)
        return sx / n, sy / n
    except Exception:
        return None, None


def iter_features(src):
    with open(src, "r", encoding="utf-8") as f:
        for line in f:
            line = line.lstrip("\x1e").strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def main(src, dst):
    tmp_dir = tempfile.mkdtemp()
    addr_db_path = os.path.join(tmp_dir, "addr.sqlite")

    try:
        addr_db = sqlite3.connect(addr_db_path)
        addr_db.execute(
            "CREATE VIRTUAL TABLE addr USING rtree(id, minX, maxX, minY, maxY)"
        )
        addr_db.execute(
            "CREATE TABLE addr_data(id INTEGER PRIMARY KEY, props TEXT)"
        )

        # Pass 1: load every feature with any addr:* tag into an R-tree.
        addr_count = 0
        for feat in iter_features(src):
            props = feat.get("properties") or {}
            addr = {k: v for k, v in props.items() if k.startswith("addr:") and v}
            if not addr:
                continue
            lng, lat = center(feat)
            if lng is None:
                continue
            addr_db.execute(
                "INSERT INTO addr VALUES (?, ?, ?, ?, ?)",
                (addr_count, lng, lng, lat, lat),
            )
            addr_db.execute(
                "INSERT INTO addr_data VALUES (?, ?)",
                (addr_count, json.dumps(addr, ensure_ascii=False)),
            )
            addr_count += 1
        addr_db.commit()

        # Pass 2: build POI DB, merging nearest-addr fallback for ones without.
        db = sqlite3.connect(dst)
        db.execute("DROP TABLE IF EXISTS poi")
        db.execute("""CREATE TABLE poi(
            lng REAL, lat REAL, name TEXT, category TEXT, props TEXT
        )""")
        db.execute("CREATE INDEX idx_lng ON poi(lng)")
        db.execute("CREATE INDEX idx_lat ON poi(lat)")

        poi_count = 0
        enriched = 0
        for feat in iter_features(src):
            props = feat.get("properties") or {}
            name = (props.get("name:latin") or props.get("name") or "").strip()
            if not name:
                continue
            lng, lat = center(feat)
            if lng is None:
                continue

            category = ""
            for k in PRIORITY:
                if k in props:
                    category = props[k]
                    break

            extra = {k: props[k] for k in EXTRA_FIELDS if k in props and props[k]}
            has_addr = any(k.startswith("addr:") for k in extra)
            if not has_addr:
                row = addr_db.execute(
                    "SELECT a.props FROM addr_data a JOIN addr r ON a.id = r.id "
                    "WHERE r.minX BETWEEN ? AND ? AND r.minY BETWEEN ? AND ? "
                    "ORDER BY (r.minX - ?) * (r.minX - ?) "
                    "       + (r.minY - ?) * (r.minY - ?) "
                    "LIMIT 1",
                    (lng - ADDR_MATCH_EPS, lng + ADDR_MATCH_EPS,
                     lat - ADDR_MATCH_EPS, lat + ADDR_MATCH_EPS,
                     lng, lng, lat, lat),
                ).fetchone()
                if row:
                    nearby = json.loads(row[0])
                    for k, v in nearby.items():
                        if k in EXTRA_FIELDS and k not in extra:
                            extra[k] = v
                    if any(k.startswith("addr:") for k in nearby):
                        enriched += 1

            db.execute(
                "INSERT INTO poi(lng, lat, name, category, props) VALUES (?, ?, ?, ?, ?)",
                (lng, lat, name, category,
                 json.dumps(extra, ensure_ascii=False) if extra else ""),
            )
            poi_count += 1
        db.commit()
        db.close()
        addr_db.close()
        print(f"  indexed {poi_count} POIs ({enriched} got nearby address) → {dst}")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: build-poi-db.py input.geojsonseq output.sqlite", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
