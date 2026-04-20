import base64
import gzip
import json
import pathlib
import sqlite3
from flask import Flask, send_from_directory, Response, abort, request, jsonify


def gzip_json(data):
    body = gzip.compress(
        json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8"),
        compresslevel=5,
    )
    resp = Response(body, mimetype="application/json")
    resp.headers["Content-Encoding"] = "gzip"
    resp.headers["Vary"] = "Accept-Encoding"
    return resp


_FILE_BOUNDS_CACHE = {}


def _cached_bounds(path, key, sql):
    ck = (str(path), key)
    if ck in _FILE_BOUNDS_CACHE:
        return _FILE_BOUNDS_CACHE[ck]
    try:
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            row = conn.execute(sql).fetchone()
    except sqlite3.DatabaseError:
        row = None
    out = row if row and row[0] is not None else None
    _FILE_BOUNDS_CACHE[ck] = out
    return out


def _rtree_bounds(path, table):
    return _cached_bounds(
        path, f"rtree:{table}",
        f"SELECT MIN(minX), MAX(maxX), MIN(minY), MAX(maxY) FROM {table}",
    )


def _poi_bounds(path):
    return _cached_bounds(
        path, "poi",
        "SELECT MIN(lng), MAX(lng), MIN(lat), MAX(lat) FROM poi",
    )


def _overlaps(file_bounds, w, s, e, n):
    if not file_bounds:
        return False
    fw, fe, fs, fn = file_bounds
    return fw <= e and fe >= w and fs <= n and fn >= s


def _relevant_files(glob_pattern, bounds_fn, w, s, e, n):
    if not DATA_DIR.exists():
        return []
    out = []
    for path in sorted(DATA_DIR.glob(glob_pattern)):
        if _overlaps(bounds_fn(path), w, s, e, n):
            out.append(path)
    return out

ROOT = pathlib.Path(__file__).parent
DATA_DIR = ROOT / "data"
SCHEDULE_PATH = DATA_DIR / "schedule.sqlite"

app = Flask(__name__, static_folder="static")


@app.route("/")
def index():
    resp = send_from_directory("static", "index.html")
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return resp


@app.route("/sw.js")
def sw():
    resp = send_from_directory("static", "sw.js", mimetype="application/javascript")
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return resp


@app.route("/manifest.webmanifest")
def manifest():
    return send_from_directory("static", "manifest.webmanifest")


@app.route("/fonts/<fontstack>/<filename>")
def fonts(fontstack, filename):
    path = ROOT / "fonts" / fontstack / filename
    if not path.is_file():
        abort(404)
    resp = send_from_directory(path.parent, path.name, mimetype="application/x-protobuf")
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.route("/fontslist/<fontstack>")
def fonts_list(fontstack):
    d = ROOT / "fonts" / fontstack
    if not d.is_dir():
        abort(404)
    return {"files": sorted(f.name for f in d.iterdir() if f.name.endswith(".pbf"))}


@app.route("/icons/<name>")
def icons(name):
    path = ROOT / "icons" / name
    if not path.is_file():
        abort(404)
    resp = send_from_directory(path.parent, path.name, mimetype="image/svg+xml")
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.route("/iconslist")
def icons_list():
    d = ROOT / "icons"
    if not d.is_dir():
        abort(404)
    return {"files": sorted(f.name for f in d.iterdir() if f.name.endswith(".svg"))}


@app.route("/poi")
def poi():
    try:
        parts = [float(x) for x in request.args.get("bbox", "").split(",")]
    except ValueError:
        abort(400)
    if len(parts) != 4:
        abort(400)
    w, s, e, n = parts
    results = []
    for path in _relevant_files("*.pois.sqlite", _poi_bounds, w, s, e, n):
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            rows = conn.execute(
                "SELECT lng, lat, name, category, props FROM poi "
                "WHERE lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?",
                (w, e, s, n),
            ).fetchall()
            for lng, lat, name, category, props_json in rows:
                props = {}
                if props_json:
                    try:
                        props = json.loads(props_json)
                    except json.JSONDecodeError:
                        pass
                results.append({
                    "lng": lng, "lat": lat, "name": name,
                    "category": category, "props": props,
                })
    return jsonify({"pois": results})


@app.route("/routes")
def routes():
    try:
        parts = [float(x) for x in request.args.get("bbox", "").split(",")]
    except ValueError:
        abort(400)
    if len(parts) != 4:
        abort(400)
    w, s, e, n = parts
    features = []
    routes_map = {}
    stops_map = {}
    for path in _relevant_files("*.routes.sqlite",
                                 lambda p: _rtree_bounds(p, "route_rtree"),
                                 w, s, e, n):
        file_key = path.name[:-len(".routes.sqlite")]
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            rows = conn.execute(
                "SELECT d.coords, d.route_ids FROM route_data d "
                "JOIN route_rtree r ON d.id = r.id "
                "WHERE r.minX <= ? AND r.maxX >= ? AND r.minY <= ? AND r.maxY >= ?",
                (e, w, n, s),
            ).fetchall()
            needed_rids = set()
            for coords_json, rids_json in rows:
                try:
                    coords = json.loads(coords_json)
                    local_rids = json.loads(rids_json) if rids_json else []
                except json.JSONDecodeError:
                    continue
                compound_rids = [f"{file_key}:{r}" for r in local_rids]
                features.append({
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": coords},
                    "properties": {"route_ids": compound_rids},
                })
                for r in local_rids:
                    needed_rids.add(r)
            if needed_rids:
                placeholder = ",".join("?" * len(needed_rids))
                meta_rows = conn.execute(
                    f"SELECT id, ref, name, network, operator, colour, mode "
                    f"FROM route_meta WHERE id IN ({placeholder})",
                    tuple(needed_rids),
                ).fetchall()
                for row in meta_rows:
                    rid, ref, name, network, operator, colour, mode = row
                    routes_map[f"{file_key}:{rid}"] = {
                        "ref": ref, "name": name, "network": network,
                        "operator": operator, "colour": colour, "mode": mode,
                    }
                stop_rows = conn.execute(
                    f"SELECT route_id, node_id, ord, lng, lat, name, role "
                    f"FROM route_stop WHERE route_id IN ({placeholder}) "
                    f"ORDER BY route_id, ord",
                    tuple(needed_rids),
                ).fetchall()
                for rid, node_id, ord_, lng, lat, name, role in stop_rows:
                    stops_map.setdefault(f"{file_key}:{rid}", []).append({
                        "node_id": node_id,
                        "ord": ord_,
                        "lng": lng, "lat": lat,
                        "name": name, "role": role,
                    })
    return gzip_json({
        "type": "FeatureCollection",
        "features": features,
        "routes": routes_map,
        "stops": stops_map,
    })


@app.route("/walk-graph")
def walk_graph():
    try:
        parts = [float(x) for x in request.args.get("bbox", "").split(",")]
    except ValueError:
        abort(400)
    if len(parts) != 4:
        abort(400)
    w, s, e, n = parts
    # Globally unique ids: prefix each walk sqlite's local ids with an offset
    # so multiple files can contribute to the same response without collisions.
    nodes_out = {}   # global_id -> [lng, lat]
    edges_out = []   # [global_from, global_to, weight_m, name_idx, shape_b64]
    names_out = []   # dense array of unique name strings
    name_map = {}    # name text -> idx
    offset = 0
    for path in _relevant_files("*.walk.sqlite",
                                 lambda p: _rtree_bounds(p, "walk_node_rtree"),
                                 w, s, e, n):
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            # Detect new vs old schema
            cols = {r[1] for r in conn.execute("PRAGMA table_info(walk_node)")}
            new_schema = "lng_u" in cols
            max_local_id = conn.execute(
                "SELECT COALESCE(MAX(id), 0) FROM walk_node"
            ).fetchone()[0]

            conn.execute("CREATE TEMP TABLE bbox_ids (id INTEGER PRIMARY KEY)")
            conn.execute(
                "INSERT INTO bbox_ids(id) "
                "SELECT id FROM walk_node_rtree "
                "WHERE minX <= ? AND maxX >= ? AND minY <= ? AND maxY >= ?",
                (e, w, n, s),
            )

            if new_schema:
                edge_sql = (
                    "SELECT e.from_id, e.to_id, e.weight_m, "
                    "       COALESCE(nm.text, ''), e.shape_blob "
                    "FROM walk_edge e "
                    "LEFT JOIN walk_name nm ON nm.id = e.name_id "
                    "WHERE e.from_id IN (SELECT id FROM bbox_ids) "
                    "   OR e.to_id IN (SELECT id FROM bbox_ids)"
                )
                node_sql = "SELECT id, lng_u, lat_u FROM walk_node WHERE id = ?"
            else:
                edge_sql = (
                    "SELECT e.from_id, e.to_id, e.weight, "
                    "       COALESCE(e.name, ''), NULL "
                    "FROM walk_edge e "
                    "WHERE e.from_id IN (SELECT id FROM bbox_ids)"
                )
                node_sql = "SELECT id, lng, lat FROM walk_node WHERE id = ?"

            need_nodes = set()
            local_edges = []
            for from_id, to_id, weight_m, name_text, shape_blob in conn.execute(edge_sql):
                local_edges.append((from_id, to_id, weight_m, name_text, shape_blob))
                need_nodes.add(from_id); need_nodes.add(to_id)

            node_rows = {}
            for nid in need_nodes:
                row = conn.execute(node_sql, (nid,)).fetchone()
                if not row:
                    continue
                if new_schema:
                    node_rows[nid] = (row[1] / 1e6, row[2] / 1e6)
                else:
                    node_rows[nid] = (row[1], row[2])

            # Emit with global offset
            for nid, (lng, lat) in node_rows.items():
                nodes_out[nid + offset] = [lng, lat]
            for from_id, to_id, weight_m, name_text, shape_blob in local_edges:
                name_idx = name_map.get(name_text)
                if name_idx is None:
                    name_idx = len(names_out)
                    names_out.append(name_text)
                    name_map[name_text] = name_idx
                edges_out.append([
                    from_id + offset, to_id + offset,
                    int(round(float(weight_m))),
                    name_idx,
                    base64.b64encode(shape_blob).decode("ascii") if shape_blob else None,
                ])
            conn.execute("DROP TABLE bbox_ids")
            offset += max_local_id + 1
    return gzip_json({
        "nodes": [[nid, lng, lat] for nid, (lng, lat) in nodes_out.items()],
        "edges": edges_out,
        "names": names_out,
    })


@app.route("/tiles/<int:z>/<int:x>/<int:y>.pbf")
def tile(z, x, y):
    paths = sorted(DATA_DIR.glob("*.mbtiles")) if DATA_DIR.exists() else []
    if not paths:
        abort(404)
    y_tms = (1 << z) - 1 - y
    best = None
    for path in paths:
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            row = conn.execute(
                "SELECT tile_data FROM tiles "
                "WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                (z, x, y_tms),
            ).fetchone()
        if row is not None and (best is None or len(row[0]) > len(best)):
            best = row[0]
    if best is None:
        return Response(status=204)
    resp = Response(best, mimetype="application/x-protobuf")
    resp.headers["Content-Encoding"] = "gzip"
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


def _in_chunks(iterable, size=500):
    buf = list(iterable)
    for start in range(0, len(buf), size):
        yield buf[start:start + size]


@app.route("/schedule")
def schedule():
    try:
        parts = [float(x) for x in request.args.get("bbox", "").split(",")]
    except ValueError:
        abort(400)
    if len(parts) != 4:
        abort(400)
    w, s, e, n = parts
    empty = {"stops": {}, "patterns": {}, "stop_patterns": {},
             "timings": [], "headsigns": [], "services": [],
             "trips": [], "routes": {}, "service_exceptions": []}
    if not SCHEDULE_PATH.exists():
        return gzip_json(empty)

    with sqlite3.connect(f"file:{SCHEDULE_PATH}?mode=ro", uri=True) as conn:
        stop_rows = conn.execute(
            "SELECT s.id, s.id_num, s.name, s.code, s.lng, s.lat "
            "FROM stop s JOIN stop_rtree r ON r.id_num = s.id_num "
            "WHERE r.minX <= ? AND r.maxX >= ? AND r.minY <= ? AND r.maxY >= ?",
            (e, w, n, s),
        ).fetchall()
        if not stop_rows:
            return gzip_json(empty)

        stop_nums = [row[1] for row in stop_rows]
        num_to_id = {row[1]: row[0] for row in stop_rows}
        stops = {}
        for sid, _num, nm, code, lng, lat in stop_rows:
            stops[sid] = {"name": nm, "code": code, "lng": lng, "lat": lat,
                          "osm_nodes": []}

        stop_ids = list(stops.keys())
        stop_id_ph = ",".join("?" * len(stop_ids))
        for gid, osm_nid in conn.execute(
            f"SELECT gtfs_stop_id, osm_node_id FROM gtfs_osm_link "
            f"WHERE gtfs_stop_id IN ({stop_id_ph})",
            tuple(stop_ids),
        ):
            if gid in stops:
                stops[gid]["osm_nodes"].append(osm_nid)

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
                if not sid_text: continue
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
                if route_id: needed_route_ids.add(route_id)

        # Trips on those patterns — all INT refs + first_departure_sec
        trip_rows = []
        needed_timing_ids = set()
        needed_service_nums = set()
        needed_headsign_ids = set()
        for chunk in _in_chunks(needed_pattern_ids):
            ph = ",".join("?" * len(chunk))
            for row in conn.execute(
                f"SELECT pattern_id, timing_id, service_num, headsign_id, "
                f"direction, first_departure_sec FROM trip "
                f"WHERE pattern_id IN ({ph})",
                tuple(chunk),
            ):
                trip_rows.append(list(row))
                needed_timing_ids.add(row[1])
                needed_service_nums.add(row[2])
                needed_headsign_ids.add(row[3])

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
                if local is None: continue
                service_exceptions.append([local, date, et])

        # Remap trip_rows using local indices
        trips = []
        for pat_id, timing_id, svc_num, hs_id, direction, first_dep in trip_rows:
            trips.append([
                pat_id,
                timing_map[timing_id],
                service_map[svc_num],
                headsign_map[hs_id],
                direction, first_dep,
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

    return gzip_json({
        "stops": stops,
        "patterns": patterns,
        "stop_patterns": stop_patterns,
        "timings": timings,
        "headsigns": headsigns,
        "services": services,
        "trips": trips,
        "routes": routes,
        "service_exceptions": service_exceptions,
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8465)
