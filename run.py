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
    all_nodes = {}
    all_edges = []
    for path in _relevant_files("*.walk.sqlite",
                                 lambda p: _rtree_bounds(p, "walk_node_rtree"),
                                 w, s, e, n):
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            conn.execute("CREATE TEMP TABLE bbox_ids (id INTEGER PRIMARY KEY)")
            conn.execute(
                "INSERT INTO bbox_ids(id) "
                "SELECT id FROM walk_node_rtree "
                "WHERE minX <= ? AND maxX >= ? AND minY <= ? AND maxY >= ?",
                (e, w, n, s),
            )
            for row in conn.execute(
                "SELECT e.from_id, e.to_id, e.weight, e.name "
                "FROM walk_edge e JOIN bbox_ids b ON e.from_id = b.id"
            ):
                all_edges.append(list(row))
                if row[1] not in all_nodes:
                    all_nodes[row[1]] = None
            for row in conn.execute(
                "SELECT n.id, n.lng, n.lat "
                "FROM walk_node n JOIN bbox_ids b ON n.id = b.id"
            ):
                all_nodes[row[0]] = [row[1], row[2]]
            missing = [nid for nid, v in all_nodes.items() if v is None]
            if missing:
                conn.execute("CREATE TEMP TABLE extra_ids (id INTEGER PRIMARY KEY)")
                conn.executemany("INSERT INTO extra_ids VALUES (?)", [(i,) for i in missing])
                for row in conn.execute(
                    "SELECT n.id, n.lng, n.lat "
                    "FROM walk_node n JOIN extra_ids x ON n.id = x.id"
                ):
                    all_nodes[row[0]] = [row[1], row[2]]
                conn.execute("DROP TABLE extra_ids")
            conn.execute("DROP TABLE bbox_ids")
    return gzip_json({
        "nodes": [[nid, v[0], v[1]] for nid, v in all_nodes.items() if v],
        "edges": all_edges,
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


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8465)
