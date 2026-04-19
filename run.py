import json
import pathlib
import sqlite3
from flask import Flask, send_from_directory, Response, abort, request, jsonify

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
    for path in sorted(DATA_DIR.glob("*.pois.sqlite")) if DATA_DIR.exists() else []:
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
    for path in sorted(DATA_DIR.glob("*.routes.sqlite")) if DATA_DIR.exists() else []:
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            rows = conn.execute(
                "SELECT d.coords FROM route_data d "
                "JOIN route_rtree r ON d.id = r.id "
                "WHERE r.minX <= ? AND r.maxX >= ? AND r.minY <= ? AND r.maxY >= ?",
                (e, w, n, s),
            ).fetchall()
            for (coords_json,) in rows:
                try:
                    coords = json.loads(coords_json)
                except json.JSONDecodeError:
                    continue
                features.append({
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": coords},
                    "properties": {},
                })
    return jsonify({"type": "FeatureCollection", "features": features})


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
