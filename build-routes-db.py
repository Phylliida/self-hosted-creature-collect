#!/usr/bin/env python3
import json
import sqlite3
import sys


def main(src, dst):
    db = sqlite3.connect(dst)
    db.execute("DROP TABLE IF EXISTS route_data")
    db.execute("DROP TABLE IF EXISTS route_rtree")
    db.execute(
        "CREATE VIRTUAL TABLE route_rtree USING rtree("
        "id, minX, maxX, minY, maxY)"
    )
    db.execute("CREATE TABLE route_data(id INTEGER PRIMARY KEY, coords TEXT)")

    wid = 0
    kept = 0
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
            gtype = geom.get("type")
            coords = geom.get("coordinates") or []
            if gtype == "LineString" and len(coords) >= 2:
                segments = [coords]
            elif gtype == "MultiLineString":
                segments = [seg for seg in coords if len(seg) >= 2]
            else:
                continue
            for seg in segments:
                xs = [p[0] for p in seg]
                ys = [p[1] for p in seg]
                db.execute(
                    "INSERT INTO route_rtree VALUES (?, ?, ?, ?, ?)",
                    (wid, min(xs), max(xs), min(ys), max(ys)),
                )
                db.execute(
                    "INSERT INTO route_data(id, coords) VALUES (?, ?)",
                    (wid, json.dumps(seg, ensure_ascii=False)),
                )
                wid += 1
                kept += 1
    db.commit()
    db.close()
    print(f"  indexed {kept} route segments → {dst}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: build-routes-db.py input.geojsonseq output.sqlite", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
