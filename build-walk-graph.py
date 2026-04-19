#!/usr/bin/env python3
import math
import sqlite3
import sys
import time
import osmium

WALKABLE_HIGHWAYS = {
    "footway", "path", "pedestrian", "residential", "service",
    "tertiary", "tertiary_link", "secondary", "secondary_link",
    "primary", "primary_link", "track", "steps", "cycleway",
    "living_street", "unclassified", "road", "corridor",
}

EXCLUDED_HIGHWAYS = {
    "motorway", "motorway_link", "trunk", "trunk_link",
    "construction", "proposed", "abandoned", "raceway",
}


def is_walkable(tags):
    foot = tags.get("foot", "")
    if foot == "no" or foot == "private":
        return False
    if tags.get("access") in ("no", "private"):
        return foot in ("yes", "designated", "permissive")
    if foot in ("yes", "designated", "permissive"):
        return True
    highway = tags.get("highway", "")
    if not highway:
        return False
    if highway in EXCLUDED_HIGHWAYS:
        return False
    return highway in WALKABLE_HIGHWAYS


def haversine_m(lon1, lat1, lon2, lat2):
    R = 6371000.0
    rlat1 = math.radians(lat1)
    rlat2 = math.radians(lat2)
    dlat = rlat2 - rlat1
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


class WalkHandler(osmium.SimpleHandler):
    def __init__(self, db):
        super().__init__()
        self.db = db
        self.node_seen = set()
        self.edge_count = 0
        self.node_count = 0
        self.way_count = 0
        self.last_tick = time.time()

    def _emit_node(self, nid, lng, lat):
        if nid in self.node_seen:
            return
        self.node_seen.add(nid)
        self.db.execute(
            "INSERT INTO walk_node(id, lng, lat) VALUES (?, ?, ?)",
            (nid, lng, lat),
        )
        self.db.execute(
            "INSERT INTO walk_node_rtree(id, minX, maxX, minY, maxY) VALUES (?, ?, ?, ?, ?)",
            (nid, lng, lng, lat, lat),
        )
        self.node_count += 1

    def way(self, w):
        tags = {t.k: t.v for t in w.tags}
        if not is_walkable(tags):
            return
        name = tags.get("name", "")
        prev_id = prev_lng = prev_lat = None
        try:
            nodes = list(w.nodes)
        except Exception:
            return
        self.way_count += 1
        for n in nodes:
            if not n.location.valid():
                continue
            nid = n.ref
            lng = n.location.lon
            lat = n.location.lat
            self._emit_node(nid, lng, lat)
            if prev_id is not None:
                weight = haversine_m(prev_lng, prev_lat, lng, lat)
                if weight > 0:
                    self.db.execute(
                        "INSERT INTO walk_edge(from_id, to_id, weight, name) VALUES (?, ?, ?, ?)",
                        (prev_id, nid, weight, name),
                    )
                    self.db.execute(
                        "INSERT INTO walk_edge(from_id, to_id, weight, name) VALUES (?, ?, ?, ?)",
                        (nid, prev_id, weight, name),
                    )
                    self.edge_count += 2
            prev_id, prev_lng, prev_lat = nid, lng, lat
        if time.time() - self.last_tick > 1.0:
            sys.stderr.write(
                f"\r\033[K  ways: {self.way_count:,}  "
                f"nodes: {self.node_count:,}  edges: {self.edge_count:,}"
            )
            sys.stderr.flush()
            self.last_tick = time.time()


def main(pbf, dst):
    db = sqlite3.connect(dst)
    db.execute("DROP TABLE IF EXISTS walk_node")
    db.execute("DROP TABLE IF EXISTS walk_edge")
    db.execute("DROP TABLE IF EXISTS walk_node_rtree")
    db.execute("CREATE TABLE walk_node(id INTEGER PRIMARY KEY, lng REAL, lat REAL)")
    db.execute(
        "CREATE VIRTUAL TABLE walk_node_rtree USING rtree(id, minX, maxX, minY, maxY)"
    )
    db.execute("CREATE TABLE walk_edge(from_id INTEGER, to_id INTEGER, weight REAL, name TEXT)")
    db.commit()

    t = time.time()
    h = WalkHandler(db)
    h.apply_file(pbf, locations=True)
    db.commit()
    sys.stderr.write(
        f"\r\033[K  {h.way_count:,} ways  "
        f"{h.node_count:,} nodes  {h.edge_count:,} edges  "
        f"({time.time() - t:.1f}s)\n"
    )
    sys.stderr.flush()
    sys.stderr.write("  creating edge index…\n"); sys.stderr.flush()
    t = time.time()
    db.execute("CREATE INDEX idx_edge_from ON walk_edge(from_id)")
    db.commit()
    sys.stderr.write(f"  edge index built in {time.time() - t:.1f}s\n")
    sys.stderr.write(f"  → {dst}\n")
    sys.stderr.flush()
    db.close()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: build-walk-graph.py input.osm.pbf output.sqlite", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
