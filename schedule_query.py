#!/usr/bin/env python3
"""Shared GTFS schedule query — the single source of truth for the bbox
schedule payload.

Both the live `/schedule` endpoint (run.py) and the offline region exporter
(update-transit-schedules.py) call `build_schedule_payload()` so the two can
never drift. The function takes an already-open read-only sqlite connection
and a bbox, and returns the exact dict the client expects (patterns, trips,
interned timings/headsigns/services, shapes, routes, calendar exceptions).

Keep this behaviourally identical to what the client hydrates — if you change
the shape here, both producers change together.
"""


# Empty payload for a bbox with no transit. NOTE: intentionally omits the
# "shapes" key (the client treats a missing shapes list as empty) to stay
# byte-identical with the historical endpoint response.
EMPTY_PAYLOAD = {
    "stops": {}, "patterns": {}, "stop_patterns": {},
    "timings": [], "headsigns": [], "services": [],
    "trips": [], "routes": {}, "service_exceptions": [],
}


def _in_chunks(iterable, size=500):
    buf = list(iterable)
    for start in range(0, len(buf), size):
        yield buf[start:start + size]


def build_schedule_payload(conn, w, s, e, n):
    """Return the schedule payload dict for bbox (w, s, e, n).

    `conn` is an open sqlite3 connection to a schedule.sqlite (read-only is
    fine). Returns EMPTY_PAYLOAD (a fresh copy) when the bbox holds no stops.
    """
    import base64

    stop_rows = conn.execute(
        "SELECT s.id, s.id_num, s.name, s.code, s.lng, s.lat "
        "FROM stop s JOIN stop_rtree r ON r.id_num = s.id_num "
        "WHERE r.minX <= ? AND r.maxX >= ? AND r.minY <= ? AND r.maxY >= ?",
        (e, w, n, s),
    ).fetchall()
    if not stop_rows:
        return dict(EMPTY_PAYLOAD)

    stop_nums = [row[1] for row in stop_rows]
    num_to_id = {row[1]: row[0] for row in stop_rows}
    stops = {}
    for sid, _num, nm, code, lng, lat in stop_rows:
        stops[sid] = {"name": nm, "code": code, "lng": lng, "lat": lat,
                      "osm_nodes": []}

    stop_ids = list(stops.keys())
    stop_id_ph = ",".join("?" * len(stop_ids))
    # lng/lat columns exist only after link-gtfs-to-osm.py's coord-bearing
    # rebuild; feature-detect so older schedule DBs keep working.
    link_cols = {r[1] for r in conn.execute("PRAGMA table_info(gtfs_osm_link)")}
    has_link_coords = {"lng", "lat"} <= link_cols
    link_sel = (
        "gtfs_stop_id, osm_node_id, distance_m, name_score, lng, lat"
        if has_link_coords else
        "gtfs_stop_id, osm_node_id, distance_m, name_score, NULL, NULL"
    )
    best_link = {}  # gid -> (sort_key, osm_lng, osm_lat)
    for gid, osm_nid, d_m, n_score, olng, olat in conn.execute(
        f"SELECT {link_sel} FROM gtfs_osm_link "
        f"WHERE gtfs_stop_id IN ({stop_id_ph})",
        tuple(stop_ids),
    ):
        if gid not in stops:
            continue
        stops[gid]["osm_nodes"].append(osm_nid)
        if olng is None:
            continue
        key = (d_m if d_m is not None else 1e9, -(n_score or 0))
        if gid not in best_link or key < best_link[gid][0]:
            best_link[gid] = (key, olng, olat)
    # Best linked OSM node per stop (smallest distance, best name score) —
    # its coordinates are the exact POI icon position for the bubble snap.
    for gid, (_key, olng, olat) in best_link.items():
        stops[gid]["osm_lng"] = olng
        stops[gid]["osm_lat"] = olat

    # Reverse index: stop -> [[pattern, seq], ...]
    stop_patterns = {}
    needed_pattern_ids = set()
    for chunk in _in_chunks(stop_nums):
        ph = ",".join("?" * len(chunk))
        for stop_num, pattern_id, seq in conn.execute(
            f"SELECT stop_num, pattern_id, stop_seq "
            f"FROM pattern_stop WHERE stop_num IN ({ph})",
            tuple(chunk),
        ):
            sid_text = num_to_id.get(stop_num)
            if not sid_text:
                continue
            stop_patterns.setdefault(sid_text, []).append([pattern_id, seq])
            needed_pattern_ids.add(pattern_id)

    patterns = {}
    needed_route_ids = set()
    for chunk in _in_chunks(needed_pattern_ids):
        ph = ",".join("?" * len(chunk))
        for pid, route_id, stop_count, stops_blob in conn.execute(
            f"SELECT id, route_id, stop_count, stops_blob "
            f"FROM pattern WHERE id IN ({ph})",
            tuple(chunk),
        ):
            patterns[str(pid)] = {
                "route_id": route_id,
                "stop_count": stop_count,
                "stops_b64": base64.b64encode(stops_blob).decode("ascii"),
            }
            if route_id:
                needed_route_ids.add(route_id)

    # Trips on those patterns — all INT refs + first_departure_sec
    trip_rows = []
    needed_timing_ids = set()
    needed_service_nums = set()
    needed_headsign_ids = set()
    needed_shape_nums = set()
    # shape_num may be absent on older DBs; feature-detect the column.
    has_shape_col = any(
        r[1] == "shape_num"
        for r in conn.execute("PRAGMA table_info(trip)")
    )
    trip_sel = (
        "pattern_id, timing_id, service_num, headsign_id, "
        "direction, first_departure_sec"
        + (", shape_num" if has_shape_col else ", NULL")
    )
    for chunk in _in_chunks(needed_pattern_ids):
        ph = ",".join("?" * len(chunk))
        for row in conn.execute(
            f"SELECT {trip_sel} FROM trip WHERE pattern_id IN ({ph})",
            tuple(chunk),
        ):
            trip_rows.append(list(row))
            needed_timing_ids.add(row[1])
            needed_service_nums.add(row[2])
            needed_headsign_ids.add(row[3])
            if row[6] is not None:
                needed_shape_nums.add(row[6])

    # Interned lookups (dense local remap so client can use flat arrays)
    timing_map = {}
    timings = []  # indexed by local_timing_id
    for chunk in _in_chunks(needed_timing_ids):
        ph = ",".join("?" * len(chunk))
        for tid, blob in conn.execute(
            f"SELECT id, times_blob FROM trip_time WHERE id IN ({ph})",
            tuple(chunk),
        ):
            timing_map[tid] = len(timings)
            timings.append(base64.b64encode(blob).decode("ascii"))

    headsign_map = {}
    headsigns = []
    for chunk in _in_chunks(needed_headsign_ids):
        ph = ",".join("?" * len(chunk))
        for hid, text in conn.execute(
            f"SELECT id, text FROM headsign WHERE id IN ({ph})",
            tuple(chunk),
        ):
            headsign_map[hid] = len(headsigns)
            headsigns.append(text or "")

    service_map = {}
    services = []
    for chunk in _in_chunks(needed_service_nums):
        ph = ",".join("?" * len(chunk))
        for row in conn.execute(
            f"SELECT id, service_id, monday, tuesday, wednesday, thursday, "
            f"friday, saturday, sunday, start_date, end_date "
            f"FROM service WHERE id IN ({ph})",
            tuple(chunk),
        ):
            sid_num, sid, mo, tu, we, th, fr, sa, su, sd, ed = row
            service_map[sid_num] = len(services)
            services.append({
                "id": sid,
                "dow": [mo, tu, we, th, fr, sa, su],
                "start": sd, "end": ed,
            })

    service_exceptions = []
    for chunk in _in_chunks(needed_service_nums):
        ph = ",".join("?" * len(chunk))
        for svc_num, date, et in conn.execute(
            f"SELECT service_num, date, exception_type "
            f"FROM service_exception WHERE service_num IN ({ph})",
            tuple(chunk),
        ):
            local = service_map.get(svc_num)
            if local is None:
                continue
            service_exceptions.append([local, date, et])

    shape_map = {}
    shapes = []
    if has_shape_col and needed_shape_nums:
        for chunk in _in_chunks(needed_shape_nums):
            ph = ",".join("?" * len(chunk))
            for sid_num, blob in conn.execute(
                f"SELECT id, points_blob FROM shape WHERE id IN ({ph})",
                tuple(chunk),
            ):
                shape_map[sid_num] = len(shapes)
                shapes.append(base64.b64encode(blob).decode("ascii"))

    # Remap trip_rows using local indices
    trips = []
    for row in trip_rows:
        pat_id, timing_id, svc_num, hs_id, direction, first_dep, shape_num = row
        local_shape = shape_map.get(shape_num) if shape_num is not None else None
        trips.append([
            pat_id,
            timing_map[timing_id],
            service_map[svc_num],
            headsign_map[hs_id],
            direction, first_dep,
            local_shape if local_shape is not None else -1,
        ])

    routes = {}
    for chunk in _in_chunks(needed_route_ids):
        ph = ",".join("?" * len(chunk))
        for rid, short, long_, mode, colour in conn.execute(
            f"SELECT id, short_name, long_name, mode, colour "
            f"FROM route WHERE id IN ({ph})",
            tuple(chunk),
        ):
            routes[rid] = {
                "short": short or "", "long": long_ or "",
                "mode": mode, "colour": colour or "",
            }

    return {
        "stops": stops,
        "patterns": patterns,
        "stop_patterns": stop_patterns,
        "timings": timings,
        "headsigns": headsigns,
        "services": services,
        "trips": trips,
        "shapes": shapes,
        "routes": routes,
        "service_exceptions": service_exceptions,
    }
