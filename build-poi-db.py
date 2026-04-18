#!/usr/bin/env python3
import json
import sqlite3
import sys

PRIORITY = [
    "amenity", "shop", "tourism", "leisure", "historic",
    "craft", "office", "public_transport", "railway", "highway",
]

def main(src, dst):
    db = sqlite3.connect(dst)
    db.execute("""CREATE TABLE IF NOT EXISTS poi(
        lng REAL, lat REAL, name TEXT, category TEXT
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_lnglat ON poi(lng, lat)")
    db.execute("DELETE FROM poi")

    count = 0
    with open(src, "r", encoding="utf-8") as f:
        for line in f:
            line = line.lstrip("\x1e").strip()
            if not line:
                continue
            try:
                feat = json.loads(line)
            except json.JSONDecodeError:
                continue
            geom = feat.get("geometry") or {}
            if geom.get("type") != "Point":
                continue
            coords = geom.get("coordinates") or []
            if len(coords) < 2:
                continue
            lng, lat = coords[0], coords[1]
            props = feat.get("properties") or {}
            name = (props.get("name:latin") or props.get("name") or "").strip()
            if not name:
                continue
            category = ""
            for k in PRIORITY:
                if k in props:
                    category = props[k]
                    break
            db.execute(
                "INSERT INTO poi(lng, lat, name, category) VALUES (?, ?, ?, ?)",
                (lng, lat, name, category),
            )
            count += 1
    db.commit()
    db.close()
    print(f"  indexed {count} POIs → {dst}")

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: build-poi-db.py input.geojsonseq output.sqlite", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
