"""Add nearest grocery stores (walk + bus time) to each listing.

Uses the repo POI db (supermarket/greengrocer/grocery) and the LTD GTFS
routing helpers from bustime.py.
"""
import json
import sqlite3

import bustime
from bustime import hav, WALK_M_PER_MIN

POI_DB = "../data/north-america-latest.pois.sqlite"
GROCERY_CATS = ("supermarket", "greengrocer", "grocery")
DETOUR = 1.3          # straight-line -> street distance fudge
STORE_STOP_R = 500    # bus stops within this of a store count as "serves the store"


def load_stores():
    conn = sqlite3.connect(POI_DB)
    cats = ",".join("?" * len(GROCERY_CATS))
    rows = conn.execute(
        f"""SELECT p.name, p.lat, p.lng, p.category FROM poi p
            JOIN poi_rtree r ON p.rowid = r.id
            WHERE r.minX >= -123.5 AND r.maxX <= -122.6
              AND r.minY >= 43.75 AND r.maxY <= 44.35
              AND p.category IN ({cats}) AND p.name != ''""",
        GROCERY_CATS).fetchall()
    laundries = conn.execute(
        """SELECT p.name, p.lat, p.lng, p.category FROM poi p
           JOIN poi_rtree r ON p.rowid = r.id
           WHERE r.minX >= -123.5 AND r.maxX <= -122.6
             AND r.minY >= 43.75 AND r.maxY <= 44.35
             AND p.category = 'laundry' AND p.name != ''""").fetchall()
    # dedupe same name at ~same spot
    seen = set()
    stores = []
    for name, la, lo, cat in rows + laundries:
        key = (name, round(la, 3), round(lo, 3))
        if key not in seen:
            seen.add(key)
            stores.append({"name": name, "lat": la, "lng": lo, "cat": cat})
    return stores


def main():
    stores = load_stores()
    print(f"{len(stores)} grocery stores")
    stops, trip_route, trip_stops, stop_trips = bustime.load()
    downtown = {s for s, (la, lo, nm) in stops.items()
                if "eugene sta" in nm.lower() or hav(la, lo, 44.0506, -123.0922) <= 250}

    listings = json.load(open("listings.json"))
    groceries = [s for s in stores if s["cat"] in GROCERY_CATS]
    laundries = [s for s in stores if s["cat"] == "laundry"]
    for i, l in enumerate(listings):
        if not (l.get("lat") and l.get("lng")):
            l["groceries"] = []
            l["laundry"] = None
            continue
        near = sorted(groceries, key=lambda s: hav(l["lat"], l["lng"], s["lat"], s["lng"]))[:3]
        out = []
        for s in near:
            d_m = hav(l["lat"], l["lng"], s["lat"], s["lng"])
            walk_min = round(d_m * DETOUR / WALK_M_PER_MIN)
            bus_min, _, bus_parts = bustime.bus_time(l["lat"], l["lng"], stops, trip_route, trip_stops,
                                                     stop_trips, None, downtown,
                                                     dest=(s["lat"], s["lng"]), dest_radius=STORE_STOP_R)
            out.append({"name": s["name"], "walk_min": walk_min, "bus_min": bus_min,
                        "bus_parts": bus_parts, "dist_m": round(d_m)})
        l["groceries"] = out
        if laundries:
            s = min(laundries, key=lambda s: hav(l["lat"], l["lng"], s["lat"], s["lng"]))
            d_m = hav(l["lat"], l["lng"], s["lat"], s["lng"])
            l["laundry"] = {"name": s["name"], "walk_min": round(d_m * DETOUR / WALK_M_PER_MIN),
                            "dist_m": round(d_m)}
        if (i + 1) % 50 == 0:
            print(f"{i+1}/{len(listings)}")
    json.dump(listings, open("listings.json", "w"), indent=1)
    have = sum(1 for l in listings if l.get("groceries"))
    print(f"groceries added for {have}/{len(listings)}")


if __name__ == "__main__":
    main()
