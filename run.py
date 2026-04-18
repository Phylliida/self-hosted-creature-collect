import json
import sqlite3
import pathlib
from flask import Flask, send_from_directory, Response, abort, request, jsonify

ROOT = pathlib.Path(__file__).parent
DATA_DIR = ROOT / "data"

app = Flask(__name__, static_folder="static")


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/sw.js")
def sw():
    return send_from_directory("static", "sw.js", mimetype="application/javascript")


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


@app.route("/tiles/<int:z>/<int:x>/<int:y>.pbf")
def tile(z, x, y):
    paths = sorted(DATA_DIR.glob("*.mbtiles")) if DATA_DIR.exists() else []
    if not paths:
        abort(404)
    y_tms = (1 << z) - 1 - y
    for path in paths:
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            row = conn.execute(
                "SELECT tile_data FROM tiles "
                "WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                (z, x, y_tms),
            ).fetchone()
        if row is not None:
            resp = Response(row[0], mimetype="application/x-protobuf")
            resp.headers["Content-Encoding"] = "gzip"
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            return resp
    return Response(status=204)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8465)
