"""Compute bus time from each listing to UO campus using LTD GTFS (Sept 2025 feed).

Method (weekday morning, service date 2026-07-29):
- campus stops = stops within 450m of University of Oregon Station (44.0459, -123.0786)
- for each listing: candidate origin stops within 900m walk (75 m/min)
- direct trips: trip serves origin stop and a campus stop, pickup before dropoff
- 1-transfer via downtown: origin -> Eugene Station stop, then Eugene Station -> campus
- wait = min(half headway of usable departures 7:00-9:30, 15 min); transfer wait = 8 min
- total = walk + wait + ride (+ transfer); best option wins
"""
import csv
import json
import math
import re
from collections import defaultdict

GTFS = "ltd/"
SERVICE_DATE = "20251001"  # a Wednesday in fall term (feed covers 2025-09-11..2026-01-31)
CAMPUS = (44.0459, -123.0786)  # UO Station
WALK_M_PER_MIN = 75.0
MAX_WALK_M = 900.0


def hav(lat1, lon1, lat2, lon2):
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def t2s(t):
    parts = t.split(":")
    if len(parts) != 3 or not all(p.strip().isdigit() for p in parts):
        return None
    h, m, s = map(int, parts)
    return h * 3600 + m * 60 + s


def load():
    stops = {}
    with open(GTFS + "stops.txt") as f:
        for r in csv.DictReader(f):
            stops[r["stop_id"]] = (float(r["stop_lat"]), float(r["stop_lon"]), r["stop_name"])
    services = set()
    with open(GTFS + "calendar_dates.txt") as f:
        for r in csv.DictReader(f):
            if r["date"] == SERVICE_DATE and r["exception_type"] == "1":
                services.add(r["service_id"])
    trip_route, ok_trips = {}, set()
    route_name = {}
    with open(GTFS + "routes.txt") as f:
        for r in csv.DictReader(f):
            route_name[r["route_id"]] = r.get("route_long_name") or r.get("route_short_name") or r["route_id"]
    with open(GTFS + "trips.txt") as f:
        for r in csv.DictReader(f):
            trip_route[r["trip_id"]] = route_name.get(r["route_id"], r["route_id"])
            if r["service_id"] in services:
                ok_trips.add(r["trip_id"])
    # trip -> [(seq, stop_id, secs)] for active trips.
    # LTD leaves arrival/departure blank at non-timepoint stops, so collect
    # raw first, then interpolate times by stop_sequence.
    raw = defaultdict(list)
    with open(GTFS + "stop_times.txt") as f:
        for r in csv.DictReader(f):
            if r["trip_id"] in ok_trips:
                raw[r["trip_id"]].append((int(r["stop_sequence"]), r["stop_id"], t2s(r["arrival_time"])))
    trip_stops = {}
    for tid, rows in raw.items():
        rows.sort()
        timed = [(i, secs) for i, (_, _, secs) in enumerate(rows) if secs is not None]
        if len(timed) < 2:
            continue
        out = []
        for i, (seq, sid, secs) in enumerate(rows):
            if secs is None:
                prev = next(((j, s) for j, s in reversed(timed) if j < i), None)
                nxt = next(((j, s) for j, s in timed if j > i), None)
                if prev and nxt:
                    frac = (i - prev[0]) / (nxt[0] - prev[0])
                    secs = int(prev[1] + frac * (nxt[1] - prev[1]))
                elif prev:
                    secs = prev[1]
                else:
                    secs = nxt[1]
            out.append((seq, sid, secs))
        trip_stops[tid] = out
    # stop -> list of (trip_id, seq, secs)
    stop_trips = defaultdict(list)
    for tid, ss in trip_stops.items():
        for seq, sid, secs in ss:
            stop_trips[sid].append((tid, seq, secs))
    return stops, trip_route, trip_stops, stop_trips


def best_ride(origins, dests, trip_stops, stop_trips, trip_route):
    """Best direct trip origin->dest (departures 7:00-9:30).
    Returns dict(total, walk, wait, ride, route) in seconds, or None."""
    best = None
    n_trips = 0
    for oid, walk_m in origins:
        for tid, seq_o, t_o in stop_trips.get(oid, []):
            if not (7 * 3600 <= t_o <= 9 * 3600 + 1800):
                continue
            ss = trip_stops[tid]
            for did, extra_walk_m in dests:
                hit = next(((seq, secs) for seq, sid, secs in ss if sid == did and seq > seq_o), None)
                if not hit:
                    continue
                n_trips += 1
                ride = hit[1] - t_o
                walk = (walk_m + extra_walk_m) / WALK_M_PER_MIN * 60
                if best is None or ride < best["ride"]:
                    best = {"ride": ride, "walk": walk, "route": trip_route[tid]}
    if not best:
        return None
    headway = (2.5 * 3600) / max(n_trips, 1)
    best["wait"] = min(headway / 2, 15 * 60)
    best["total"] = best["walk"] + best["wait"] + best["ride"]
    return best


def bus_time(lat, lng, stops, trip_route, trip_stops, stop_trips, campus_stops, downtown_stops,
             dest=None, dest_radius=450):
    """Bus+walk minutes from (lat,lng) to campus (default) or dest=(lat,lng)."""
    origins = [(sid, hav(lat, lng, la, lo)) for sid, (la, lo, _) in stops.items()
               if hav(lat, lng, la, lo) <= MAX_WALK_M]
    if not origins:
        return None, "no bus stop within 900m", None
    origins.sort(key=lambda x: x[1])
    origins = origins[:12]
    if dest is not None:
        anchor_stops = {sid for sid, (la, lo, _) in stops.items() if hav(la, lo, *dest) <= dest_radius}
        if not anchor_stops:
            return None, "no bus stop near destination", None
    else:
        anchor_stops = campus_stops
    dests = [(sid, hav(stops[sid][0], stops[sid][1], *(dest or CAMPUS))) for sid in anchor_stops]
    direct = best_ride(origins, dests, trip_stops, stop_trips, trip_route)
    # 1-transfer via downtown Eugene Station
    via = None
    if downtown_stops:
        dd = [(sid, 0.0) for sid in downtown_stops]
        leg1 = best_ride(origins, dd, trip_stops, stop_trips, trip_route)
        leg2 = best_ride([(sid, 0.0) for sid in downtown_stops], dests, trip_stops, stop_trips, trip_route)
        if leg1 and leg2:
            via = {
                "total": leg1["total"] + leg2["total"] + 8 * 60,
                "walk": leg1["walk"] + leg2["walk"],
                "wait": leg1["wait"] + leg2["wait"] + 8 * 60,
                "ride": leg1["ride"] + leg2["ride"],
                "route": f"{leg1['route']} → {leg2['route']}",
            }
    options = [x for x in [direct, via] if x]
    if not options:
        return None, "no weekday-morning bus path found", None
    best = min(options, key=lambda x: x["total"])
    parts = {k: round(best[k] / 60) for k in ("walk", "wait", "ride")}
    parts["route"] = best["route"]
    return round(best["total"] / 60), best["route"], parts


if __name__ == "__main__":
    stops, trip_route, trip_stops, stop_trips = load()
    campus_stops = {sid for sid, (la, lo, _) in stops.items() if hav(la, lo, *CAMPUS) <= 450}
    downtown_stops = {sid for sid, (la, lo, nm) in stops.items()
                      if "eugene sta" in nm.lower() or hav(la, lo, 44.0506, -123.0922) <= 250}
    print(f"active trips={len(trip_stops)} campus_stops={len(campus_stops)} downtown_stops={len(downtown_stops)}")
    listings = json.load(open("listings.json"))
    n_ok = 0
    for l in listings:
        if l.get("lat") and l.get("lng"):
            mins, desc, parts = bus_time(l["lat"], l["lng"], stops, trip_route, trip_stops, stop_trips,
                                         campus_stops, downtown_stops)
            l["bus_min"] = mins
            l["bus_desc"] = desc
            l["bus_parts"] = parts
            if mins:
                n_ok += 1
        else:
            l["bus_min"] = None
            l["bus_desc"] = "address not geocoded"
    json.dump(listings, open("listings.json", "w"), indent=1)
    print(f"bus times computed for {n_ok}/{len(listings)}")
