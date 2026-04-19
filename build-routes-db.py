#!/usr/bin/env python3
import json
import sqlite3
import sys
import time
import osmium

TRANSIT_MODES = {
    "bus", "trolleybus", "share_taxi",
    "subway", "tram", "light_rail",
    "train", "monorail",
}


class RelationReader(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.routes = []             # [{ref, name, network, operator, colour, mode}, ...]
        self.way_to_routes = {}      # way_id -> [route_idx]

    def relation(self, r):
        tags = {t.k: t.v for t in r.tags}
        if tags.get("type") != "route":
            return
        mode = tags.get("route", "")
        if mode not in TRANSIT_MODES:
            return
        rid = len(self.routes)
        self.routes.append({
            "ref":      tags.get("ref", ""),
            "name":     tags.get("name", ""),
            "network":  tags.get("network", ""),
            "operator": tags.get("operator", ""),
            "colour":   tags.get("colour", "") or tags.get("color", ""),
            "mode":     mode,
        })
        for m in r.members:
            if m.type == "w":
                self.way_to_routes.setdefault(m.ref, []).append(rid)


class WayWriter(osmium.SimpleHandler):
    def __init__(self, way_to_routes, db):
        super().__init__()
        self.way_to_routes = way_to_routes
        self.db = db
        self.counter = 0
        self.last_tick = time.time()

    def way(self, w):
        rel_ids = self.way_to_routes.get(w.id)
        if not rel_ids:
            return
        try:
            coords = []
            for n in w.nodes:
                if n.location.valid():
                    coords.append([n.location.lon, n.location.lat])
        except Exception:
            return
        if len(coords) < 2:
            return
        xs = [c[0] for c in coords]
        ys = [c[1] for c in coords]
        self.db.execute(
            "INSERT INTO route_rtree VALUES (?, ?, ?, ?, ?)",
            (self.counter, min(xs), max(xs), min(ys), max(ys)),
        )
        self.db.execute(
            "INSERT INTO route_data(id, coords, route_ids) VALUES (?, ?, ?)",
            (self.counter, json.dumps(coords), json.dumps(rel_ids)),
        )
        self.counter += 1
        if time.time() - self.last_tick > 1.0:
            sys.stderr.write(f"\r\033[K  segments: {self.counter:,}")
            sys.stderr.flush()
            self.last_tick = time.time()


def main(pbf, dst):
    db = sqlite3.connect(dst)
    db.execute("DROP TABLE IF EXISTS route_rtree")
    db.execute("DROP TABLE IF EXISTS route_data")
    db.execute("DROP TABLE IF EXISTS route_meta")
    db.execute(
        "CREATE VIRTUAL TABLE route_rtree USING rtree(id, minX, maxX, minY, maxY)"
    )
    db.execute(
        "CREATE TABLE route_data(id INTEGER PRIMARY KEY, coords TEXT, route_ids TEXT)"
    )
    db.execute(
        "CREATE TABLE route_meta(id INTEGER PRIMARY KEY, ref TEXT, name TEXT, "
        "network TEXT, operator TEXT, colour TEXT, mode TEXT)"
    )

    t = time.time()
    sys.stderr.write("  pass 1: reading relations…\n"); sys.stderr.flush()
    rh = RelationReader()
    rh.apply_file(pbf)
    sys.stderr.write(
        f"    {len(rh.routes)} routes, "
        f"{len(rh.way_to_routes)} unique member ways "
        f"({time.time() - t:.1f}s)\n"
    )

    for i, r in enumerate(rh.routes):
        db.execute(
            "INSERT INTO route_meta VALUES (?, ?, ?, ?, ?, ?, ?)",
            (i, r["ref"], r["name"], r["network"], r["operator"], r["colour"], r["mode"]),
        )

    t = time.time()
    sys.stderr.write("  pass 2: reading ways with node locations…\n"); sys.stderr.flush()
    ww = WayWriter(rh.way_to_routes, db)
    ww.apply_file(pbf, locations=True)
    sys.stderr.write(f"\r\033[K    {ww.counter} segments ({time.time() - t:.1f}s)\n")
    sys.stderr.flush()

    db.commit()
    db.close()
    sys.stderr.write(f"  → {dst}\n"); sys.stderr.flush()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: build-routes-db.py input.osm.pbf output.sqlite", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
