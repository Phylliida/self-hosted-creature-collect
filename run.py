import array
import base64
import gzip
import json
import pathlib
import sqlite3
import struct
import sys
from io import BytesIO
from flask import Flask, send_from_directory, Response, abort, request, jsonify

# array.array native int widths are platform-dependent in theory; all mainstream
# server platforms have 4-byte int / unsigned int. Fail fast if ever not true.
assert array.array('I').itemsize == 4, "unexpected native unsigned-int width"
assert array.array('i').itemsize == 4, "unexpected native int width"


def _le_bytes(values, typecode):
    a = array.array(typecode, values)
    if sys.byteorder == 'big':
        a.byteswap()
    return a.tobytes()


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
    """Binary walk-graph bundle.
    Layout (little-endian, 4-byte aligned throughout):
        Header (32 bytes):
            0:  'WALK' magic
            4:  u32 version (=1)
            8:  u32 N (node count)
            12: u32 E (edge count)
            16: u32 M (name count)
            20: u32 namesByteLen
            24: u32 shapesByteLen
            28: u32 reserved (0)
        Nodes (16N): N × f64 osm_id, N × f32 lng, N × f32 lat
        Edges (24E): E × u32 from_local, u32 to_local, f32 weight_m,
                     i32 name_idx (-1 none), u32 shape_off, u32 shape_len
        Names (namesByteLen): M × (u16 utf8_len + utf8 bytes)
        Shapes (shapesByteLen): concatenated shape bytes
    Nodes are keyed by OSM id (globally unique) for cross-response dedup.
    """
    try:
        parts = [float(x) for x in request.args.get("bbox", "").split(",")]
    except ValueError:
        abort(400)
    if len(parts) != 4:
        abort(400)
    w, s, e, n = parts

    osm_to_local = {}
    nodes_osm = []
    nodes_lng = []
    nodes_lat = []
    names_list = []
    name_to_idx = {}
    edges_from = []
    edges_to = []
    edges_weight = []
    edges_name_idx = []
    edges_shape_off = []
    edges_shape_len = []
    shape_chunks = []
    shapes_total = 0

    for path in _relevant_files("*.walk.sqlite",
                                 lambda p: _rtree_bounds(p, "walk_node_rtree"),
                                 w, s, e, n):
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(walk_node)")}
            if "osm_id" not in cols or "lng_u" not in cols:
                # Old schema lacks the globally-unique osm_id needed for
                # cross-response dedup; skip and let user rebuild.
                continue

            conn.execute("CREATE TEMP TABLE bbox_ids (id INTEGER PRIMARY KEY)")
            conn.execute(
                "INSERT INTO bbox_ids(id) "
                "SELECT id FROM walk_node_rtree "
                "WHERE minX <= ? AND maxX >= ? AND minY <= ? AND maxY >= ?",
                (e, w, n, s),
            )

            edge_rows = conn.execute(
                "SELECT e.from_id, e.to_id, e.weight_m, "
                "       COALESCE(nm.text, ''), e.shape_blob "
                "FROM walk_edge e "
                "LEFT JOIN walk_name nm ON nm.id = e.name_id "
                "WHERE e.from_id IN (SELECT id FROM bbox_ids) "
                "   OR e.to_id IN (SELECT id FROM bbox_ids)"
            ).fetchall()

            need_ids = set()
            for from_id, to_id, _, _, _ in edge_rows:
                need_ids.add(from_id)
                need_ids.add(to_id)

            walk_id_info = {}
            if need_ids:
                ids_list = list(need_ids)
                for chunk_start in range(0, len(ids_list), 900):
                    chunk = ids_list[chunk_start:chunk_start + 900]
                    placeholder = ",".join("?" * len(chunk))
                    for nid, osm_id, lng_u, lat_u in conn.execute(
                        f"SELECT id, osm_id, lng_u, lat_u FROM walk_node "
                        f"WHERE id IN ({placeholder})",
                        tuple(chunk),
                    ):
                        if osm_id is None:
                            continue
                        walk_id_info[nid] = (osm_id, lng_u / 1e6, lat_u / 1e6)

            conn.execute("DROP TABLE bbox_ids")

        def get_local(walk_id):
            rec = walk_id_info.get(walk_id)
            if rec is None:
                return None
            osm_id, lng, lat = rec
            idx = osm_to_local.get(osm_id)
            if idx is None:
                idx = len(nodes_osm)
                osm_to_local[osm_id] = idx
                nodes_osm.append(osm_id)
                nodes_lng.append(lng)
                nodes_lat.append(lat)
            return idx

        for from_id, to_id, weight_m, name_text, shape_blob in edge_rows:
            f_loc = get_local(from_id)
            t_loc = get_local(to_id)
            if f_loc is None or t_loc is None:
                continue
            if name_text:
                ni = name_to_idx.get(name_text)
                if ni is None:
                    ni = len(names_list)
                    names_list.append(name_text)
                    name_to_idx[name_text] = ni
            else:
                ni = -1
            edges_from.append(f_loc)
            edges_to.append(t_loc)
            edges_weight.append(float(weight_m))
            edges_name_idx.append(ni)
            if shape_blob:
                edges_shape_off.append(shapes_total)
                edges_shape_len.append(len(shape_blob))
                shape_chunks.append(shape_blob)
                shapes_total += len(shape_blob)
            else:
                edges_shape_off.append(0)
                edges_shape_len.append(0)

    N = len(nodes_osm)
    E = len(edges_from)
    M = len(names_list)

    names_buf = BytesIO()
    for name in names_list:
        b = name.encode("utf-8")
        if len(b) > 65535:
            b = b[:65535]
        names_buf.write(struct.pack("<H", len(b)))
        names_buf.write(b)
    names_bytes = names_buf.getvalue()
    shapes_bytes = b"".join(shape_chunks)

    body = b"".join([
        struct.pack("<4sIIIIIII",
                    b"WALK", 1, N, E, M,
                    len(names_bytes), len(shapes_bytes), 0),
        _le_bytes(nodes_osm, "d"),
        _le_bytes(nodes_lng, "f"),
        _le_bytes(nodes_lat, "f"),
        _le_bytes(edges_from, "I"),
        _le_bytes(edges_to, "I"),
        _le_bytes(edges_weight, "f"),
        _le_bytes(edges_name_idx, "i"),
        _le_bytes(edges_shape_off, "I"),
        _le_bytes(edges_shape_len, "I"),
        names_bytes,
        shapes_bytes,
    ])

    compressed = gzip.compress(body, compresslevel=5)
    resp = Response(compressed, mimetype="application/octet-stream")
    resp.headers["Content-Encoding"] = "gzip"
    resp.headers["Vary"] = "Accept-Encoding"
    return resp


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
        needed_shape_nums = set()
        # shape_num may be absent on older DBs; query it via COALESCE / feature-detect.
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
                if local is None: continue
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

    return gzip_json({
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
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8465)
