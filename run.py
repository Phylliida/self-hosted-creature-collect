import array
import base64
import contextlib
import gzip
import json
import pathlib
import re
import sqlite3
from schedule_query import build_schedule_payload, EMPTY_PAYLOAD
import struct
import sys
import time
from io import BytesIO
from flask import Flask, g, send_from_directory, Response, abort, redirect, request, jsonify

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


# Overlap checks use the rtree's native spatial index (O(log n)) instead of
# a MIN/MAX scan that would read the entire index on cold starts. Each file's
# open() connection is cheap; the rtree lookup returns in ~ms even on huge
# countries.
def _rtree_overlaps(path, table, w, s, e, n):
    try:
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            row = conn.execute(
                f"SELECT 1 FROM {table} "
                f"WHERE minX <= ? AND maxX >= ? AND minY <= ? AND maxY >= ? "
                f"LIMIT 1",
                (e, w, n, s),
            ).fetchone()
        return row is not None
    except sqlite3.DatabaseError:
        return False


def _poi_overlaps(path, w, s, e, n):
    # Prefer the rtree if it's present (built via add-poi-rtree.py); fall
    # back to the flat lat/lng indexes for DBs that haven't been migrated.
    try:
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            has_rtree = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='poi_rtree'"
            ).fetchone()
            if has_rtree:
                row = conn.execute(
                    "SELECT 1 FROM poi_rtree "
                    "WHERE minX <= ? AND maxX >= ? AND minY <= ? AND maxY >= ? "
                    "LIMIT 1",
                    (e, w, n, s),
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT 1 FROM poi "
                    "WHERE lng BETWEEN ? AND ? AND lat BETWEEN ? AND ? LIMIT 1",
                    (w, e, s, n),
                ).fetchone()
        return row is not None
    except sqlite3.DatabaseError:
        return False


def _relevant_files(glob_pattern, overlap_fn, w, s, e, n):
    if not DATA_DIR.exists():
        return []
    out = []
    for path in sorted(DATA_DIR.glob(glob_pattern)):
        if overlap_fn(path, w, s, e, n):
            out.append(path)
    return out

ROOT = pathlib.Path(__file__).parent
DATA_DIR = ROOT / "data"
SCHEDULE_PATH = DATA_DIR / "schedule.sqlite"

# static_folder=None: we register our own /static/<path> handler so we
# can stamp SCRIPT_VERSION constants in served JS / HTML with the
# file's mtime. Stops the user having to bump version strings by hand.
app = Flask(__name__, static_folder=None)


# Files tracked by the version-stamping system. JS files have a
# `SCRIPT_VERSION = '...'` constant the server replaces on serve;
# HTML files get a tiny registration <script> injected after <head>.
_TRACKED_JS = {
    "creatures.js", "sprites.js", "sprite-store.js", "appdata.js",
    "species.js", "spawns.js", "trip-planner.js",
    "live-update.js", "extras.js",
    # Extras add-on siblings — tracked so the Refresh button / live-update
    # pick up changes (they already have the SCRIPT_VERSION='auto' hook).
    "extras-apps.js", "extras-almanac.js", "extras-vibration.js", "extras-skymap.js",
    "extras-sudoku.js", "extras-sensors.js",
}
# synth.html / quiver.html are the flat single-file mini-apps loaded in
# Extras iframes — tracked so the Refresh button / native live-update
# picks up edits without an IPA/APK rebuild (the multi-file subtrees
# like static/draw and static/mandelbrot still need a rebuild on native).
_TRACKED_HTML = {"index.html", "dex.html", "synth.html", "quiver.html"}
# Authoritative list (ordered) of every file the version system tracks.
# Used both to build the HTML-injected `_serverScriptVersions` map and
# by the /script-versions fallback endpoint.
_SCRIPT_VERSION_FILES = [
    "creatures.js", "sprites.js", "sprite-store.js", "appdata.js",
    "species.js", "spawns.js", "trip-planner.js", "live-update.js", "extras.js",
    "extras-apps.js", "extras-almanac.js", "extras-vibration.js", "extras-skymap.js",
    "extras-sudoku.js", "extras-sensors.js",
    "synth.html", "quiver.html",
    "sw.js", "index.html", "dex.html",
]
# Capture the declaration keyword (group 1) so we can preserve it
# during substitution — strict-mode JS rejects bare assignment to an
# undeclared identifier, so dropping the `const` would break every
# script's IIFE.
_SCRIPT_VERSION_RE = re.compile(
    r"""((?:const|let|var)\s+)SCRIPT_VERSION\s*=\s*['"]([^'"]+)['"]"""
)
_HEAD_TAG_RE = re.compile(r"<head\b[^>]*>", re.IGNORECASE)
_DOCTYPE_RE = re.compile(r"<!DOCTYPE[^>]*>", re.IGNORECASE)


def _file_version(path):
    """Compact UTC mtime string — minute precision is plenty for
    catching stale browser caches and stays stable across page loads
    that happen seconds apart."""
    try:
        ts = path.stat().st_mtime
    except OSError:
        return "unknown"
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(ts))


def _stamp_js(content, version):
    """Replace the first `<keyword> SCRIPT_VERSION = '...'` declaration
    with the given version string. Preserves the leading `const` /
    `let` / `var` keyword (group 1) so strict-mode JS doesn't choke
    on an undeclared identifier. Idempotent: re-stamping rewrites
    the same value."""
    return _SCRIPT_VERSION_RE.sub(
        lambda m: f"{m.group(1)}SCRIPT_VERSION = '{version}'",
        content, count=1,
    )


def _all_tracked_versions():
    """Snapshot mtime-version for every tracked file. Used to bake
    the server's "expected" versions into HTML so the client can
    detect stale-cache mismatches without a follow-up network call."""
    out = {}
    for n in _SCRIPT_VERSION_FILES:
        p = ROOT / "static" / n
        if p.is_file():
            out[n] = _file_version(p)
    return out


def _stamp_html(content, name, version):
    """Inject a tiny registration <script> right after the opening
    <head> tag. Carries:
      - this HTML's own version → window._scriptVersions[name]
      - the full server-side version map for every tracked file
        → window._serverScriptVersions
    The pre-baked map means the Settings diagnostic can compare
    loaded-vs-server versions with zero network requests at runtime —
    the comparison happens entirely from data shipped with the page.
    Files with no <head> (e.g. quiver.html) get the script injected
    right after the doctype instead — prepending BEFORE a doctype would
    flip the page into quirks mode. Headless no-doctype files fall back
    to a plain prepend."""
    server_map = _all_tracked_versions()
    server_map_json = json.dumps(server_map, separators=(",", ":"))
    snippet = (
        f'<script>'
        f'window._scriptVersions=window._scriptVersions||{{}};'
        f'window._scriptVersions["{name}"]="{version}";'
        f'window._serverScriptVersions={server_map_json};'
        f'</script>'
    )
    m = _HEAD_TAG_RE.search(content) or _DOCTYPE_RE.search(content)
    if not m:
        return snippet + content
    insert_at = m.end()
    return content[:insert_at] + snippet + content[insert_at:]


def _serve_stamped(path, name):
    """Read `path`, stamp it as JS or HTML, return a Flask Response.
    Caller is responsible for picking a path inside static/."""
    if not path.is_file():
        abort(404)
    version = _file_version(path)
    text = path.read_text(encoding="utf-8")
    if name in _TRACKED_JS or name == "sw.js":
        body = _stamp_js(text, version)
        resp = Response(body, mimetype="application/javascript")
    elif name in _TRACKED_HTML:
        body = _stamp_html(text, name, version)
        resp = Response(body, mimetype="text/html")
    else:
        # Caller asked us to stamp something we don't know how to
        # handle — return raw bytes to be safe.
        return send_from_directory(str(path.parent), path.name)
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/static/<path:fname>")
def serve_static(fname):
    """Replaces Flask's auto-static handler so we can stamp tracked
    files with the file mtime. Untracked files (sprites, fonts, vendor
    bundles, etc.) fall through to send_from_directory unchanged."""
    static_root = (ROOT / "static").resolve()
    path = (static_root / fname).resolve()
    # Path-traversal defense: ensure the resolved path is inside
    # static/ before opening it.
    try:
        path.relative_to(static_root)
    except ValueError:
        abort(404)
    if fname in _TRACKED_JS or fname in _TRACKED_HTML:
        return _serve_stamped(path, fname)
    if not path.is_file():
        abort(404)
    return send_from_directory(str(static_root), fname)


@contextlib.contextmanager
def _phase(name):
    """Record wall-clock duration of a code block under `g.phases[name]`.
    Works only during a Flask request (no-op if `g` has no phases dict)."""
    start = time.perf_counter()
    try:
        yield
    finally:
        try:
            g.phases[name] = (time.perf_counter() - start) * 1000.0
        except (AttributeError, RuntimeError):
            pass


@app.before_request
def _download_timing_start():
    g.t0 = time.perf_counter()
    g.phases = {}  # name -> ms
    g.meta = {}    # name -> scalar (counts, etc.)


@app.after_request
def _cors_for_capacitor(resp):
    # The Capacitor-bundled iOS/Android app loads from
    # capacitor://localhost (iOS) or https://localhost (Android) and
    # cross-origins to this Flask backend for /save, /load,
    # /save-names, /poi, /walk-graph, etc. Allow * here since these
    # are user-data endpoints that already accept any caller (no
    # auth) — same trust model as the existing self-hosted PWA. If
    # auth gets added later, switch this to an explicit allowlist
    # of capacitor://localhost + https://localhost.
    origin = request.headers.get("Origin", "")
    if origin.startswith("capacitor://") or origin.startswith("https://localhost") \
            or origin.startswith("http://localhost"):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Download"
        resp.headers["Vary"] = "Origin"
    return resp


@app.route("/<path:_>", methods=["OPTIONS"])
def _cors_preflight(_):
    # Empty 204 with the headers _cors_for_capacitor adds — handles
    # the preflight for any cross-origin POST (e.g. /save).
    return ("", 204)


@app.after_request
def _no_http_cache_for_js(resp):
    # Tell Safari not to HTTP-cache our own JS. The service-worker Cache API
    # already holds a canonical copy, so the browser HTTP cache is pure
    # duplicate — and on iOS Safari each hard refresh retains the old entry
    # alongside the new one, growing storage.estimate() ~1 MB per refresh.
    if (request.path.startswith("/static/")
        and (request.path.endswith(".js") or request.path.endswith(".css")
             or request.path.endswith(".html"))):
        # .html covers the mini-app shells (synth/quiver/draw/pixelart/
        # mandelbrot) so an edited page is never revived from HTTP cache.
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.after_request
def _download_timing_log(resp):
    # Only log requests initiated by a download flow (client adds this header
    # for POI/schedule/walk/tile fetches triggered by "save current view").
    if request.headers.get("X-Download") != "1":
        return resp
    elapsed_ms = (time.perf_counter() - g.t0) * 1000.0
    size = resp.calculate_content_length()
    size_str = f"{size / 1024:.1f}KB" if size is not None else "?KB"
    phases = getattr(g, "phases", {})
    meta = getattr(g, "meta", {})
    phase_str = (" " + " ".join(f"{k}={v:.0f}ms" for k, v in phases.items())) if phases else ""
    meta_str = (" " + " ".join(f"{k}={v}" for k, v in meta.items())) if meta else ""
    qs = ("?" + request.query_string.decode("ascii", "replace")) if request.query_string else ""
    if len(qs) > 80:
        qs = qs[:77] + "..."
    print(f"[dl] {request.method} {request.path}{qs} "
          f"size={size_str} total={elapsed_ms:.0f}ms{phase_str}{meta_str}", flush=True)
    return resp


@app.route("/")
def index():
    resp = _serve_stamped(ROOT / "static" / "index.html", "index.html")
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return resp


@app.route("/dex")
def dex():
    # Standalone art browser — separate page, fetches sprite sheets
    # live on demand. Not part of the main app's no-network rule;
    # this is a developer-facing tool for browsing the full sprite
    # catalog (autogen + every custom variant per fusion).
    resp = _serve_stamped(ROOT / "static" / "dex.html", "dex.html")
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return resp


@app.route("/sw.js")
def sw():
    resp = _serve_stamped(ROOT / "static" / "sw.js", "sw.js")
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


_SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\- ]{0,63}$")


@app.route("/save", methods=["POST"])
def save_backup():
    """Save the client's exported backup JSON to saves/<name>_<ms>.json.

    The trainer name comes from the body's `backupName` field (a mirror
    of the Settings text field, also stored client-side). Names are
    sanitized to prevent path traversal — letters, digits, dot, dash,
    underscore, and space; can't start with a separator. The trailing
    `_<millis>` (milliseconds since epoch, taken from the request time)
    means every save creates a new file rather than overwriting, so the
    user has a full history they can roll back through.
    """
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "expected JSON object"}), 400
    name = (payload.get("backupName") or "").strip()
    if not name:
        return jsonify({"error": "missing backupName"}), 400
    if not _SAFE_NAME_RE.fullmatch(name):
        return jsonify({"error": "invalid name (use letters/digits/._- and spaces)"}), 400
    saves_dir = ROOT / "saves"
    saves_dir.mkdir(exist_ok=True)
    millis = int(time.time() * 1000)
    path = saves_dir / f"{name}_{millis}.json"
    # Atomic-ish write so a crash mid-save doesn't corrupt the file.
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    tmp.replace(path)
    return jsonify({"ok": True, "saved": path.name})


@app.route("/upload-logs", methods=["POST"])
def upload_logs():
    """Write the client's diagnostic dump to saves/logs/<name>_<ms>.txt.

    Companion to the Settings "Upload logs" button (next to Copy logs) —
    same conventions as /save: the trainer name comes from the body's
    `backupName` field (mirror of the Settings text field), sanitized by
    the same _SAFE_NAME_RE, and the millisecond suffix means every
    upload lands in a new file instead of overwriting.
    """
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "expected JSON object"}), 400
    name = (payload.get("backupName") or "").strip()
    if not name:
        return jsonify({"error": "missing backupName"}), 400
    if not _SAFE_NAME_RE.fullmatch(name):
        return jsonify({"error": "invalid name (use letters/digits/._- and spaces)"}), 400
    logs = payload.get("logs")
    if not isinstance(logs, str) or not logs.strip():
        return jsonify({"error": "missing logs"}), 400
    logs_dir = ROOT / "saves" / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    millis = int(time.time() * 1000)
    path = logs_dir / f"{name}_{millis}.txt"
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(logs, encoding="utf-8")
    tmp.replace(path)
    return jsonify({"ok": True, "saved": f"logs/{path.name}"})


# Lazy-loaded sprite-credits index. Sourced from upstream Pokémon
# Infinite Fusion's Sprite_Credits.csv. Keyed by (a, b) fusion ints
# → { variant_letter or "": artist_name }. Loaded once on first
# request, cached in process memory (~10 MB for ~227 k rows).
_SPRITE_CREDITS_CACHE = None
_CREDIT_KEY_RE = re.compile(r"^(\d+)([a-z]?)$")


def _load_sprite_credits():
    global _SPRITE_CREDITS_CACHE
    if _SPRITE_CREDITS_CACHE is not None:
        return _SPRITE_CREDITS_CACHE
    path = (ROOT / "data" / "InfiniteFusion" / "Data"
            / "sprites" / "Sprite_Credits.csv")
    out = {}
    if path.is_file():
        with path.open(encoding="utf-8", errors="replace") as f:
            for raw in f:
                parts = raw.rstrip("\r\n").split(",")
                if len(parts) < 2:
                    continue
                key = parts[0].strip()
                artist = parts[1].strip()
                if not key or not artist or "." not in key:
                    continue
                a_str, rest = key.split(".", 1)
                if not a_str.isdigit():
                    continue
                m = _CREDIT_KEY_RE.match(rest)
                if not m:
                    continue
                a = int(a_str)
                b = int(m.group(1))
                variant = m.group(2)
                d = out.setdefault((a, b), {})
                # Don't clobber if multiple rows exist; first wins.
                d.setdefault(variant, artist)
    _SPRITE_CREDITS_CACHE = out
    return out


@app.route("/sprite-credit/<int:a>/<int:b>")
def sprite_credit(a, b):
    """Return { variant_suffix: artist_name } for one (a, b) fusion.
    Empty string key is the base sheet's artist; letter keys are the
    alt variants. Returns {} when nothing is on file for the pair.
    """
    creds = _load_sprite_credits()
    return jsonify(creds.get((a, b), {}))


_CREDITS_BUNDLE_CACHE = None


# SPLIT_NAMES table from data/InfiniteFusion/.../SplitNames.rb. Each
# entry is [prefix, suffix] indexed by national-dex number; the canonical
# fusion-name algorithm picks prefix from head, suffix from body.
# Parsed once, cached in process memory.
_SPLIT_NAMES_CACHE = None
_SPLIT_NAMES_RE = re.compile(r'\[\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]')


def _load_split_names():
    global _SPLIT_NAMES_CACHE
    if _SPLIT_NAMES_CACHE is not None:
        return _SPLIT_NAMES_CACHE
    path = (ROOT / "data" / "InfiniteFusion" / "Data"
            / "Scripts" / "052_InfiniteFusion" / "Fusion" / "SplitNames.rb")
    out = []
    if path.is_file():
        text = path.read_text(encoding="utf-8", errors="replace")
        for m in _SPLIT_NAMES_RE.finditer(text):
            out.append([m.group(1), m.group(2)])
    _SPLIT_NAMES_CACHE = out
    return out


@app.route("/sprite-split-names")
def sprite_split_names():
    """Return SPLIT_NAMES as a JSON array of [prefix, suffix] pairs
    indexed by national-dex number (index 0 is the unused "" entry).
    Used client-side to build canonical fusion names.
    """
    body = json.dumps(_load_split_names(), ensure_ascii=False,
                      separators=(",", ":")).encode("utf-8")
    body = gzip.compress(body, compresslevel=6)
    resp = Response(body, mimetype="application/json")
    resp.headers["Content-Encoding"] = "gzip"
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.route("/__refresh__.html")
def emergency_refresh():
    """Web-side stub for the cross-platform emergency-refresh
    fallback.

    The refresh button is rendered as `<a href="/__refresh__.html">`
    so that even if its onclick JS is broken, the browser's default
    link navigation still does *something*. Three platforms, three
    handlers for the same href:
      * iOS  — LocalServer.swift route clears any stale liveDir
        overlay, redirects to /.
      * Web  — this Flask route 302s to /.
      * Android — no native interceptor; the bundled static
        __refresh__.html (written by build-capacitor.sh) is served
        directly by WebViewAssetLoader and meta-refreshes to /.

    On the web there's no liveDir overlay to clear, so just bounce
    back to the root and the next request fetches fresh code.
    """
    return redirect("/", code=302)


@app.route("/script-versions")
def script_versions():
    """Fallback: return the live mtime-based version map. The HTML
    page already has this data baked in via _stamp_html, so the
    Settings diagnostic doesn't need to hit this endpoint at runtime
    (zero-network rule). Kept around for ad-hoc debugging — e.g.
    `curl http://host/script-versions` from another machine."""
    return jsonify(_all_tracked_versions())


@app.route("/sprite-credits-bundle")
def sprite_credits_bundle():
    """Bundle of all sprite credits for fusions where both species
    are in [1, 150]. Suffix-keyed so the client can resolve a slot
    index → suffix via its own variants/manifest data.
    Output shape: {"a-b": {"": "artist", "a": "artist", ...}, ...}.
    Roughly ~580 KB raw, ~150 KB gzipped.
    """
    global _CREDITS_BUNDLE_CACHE
    if _CREDITS_BUNDLE_CACHE is None:
        creds = _load_sprite_credits()
        out = {}
        for (a, b), variants in creds.items():
            if 1 <= a <= 150 and 1 <= b <= 150:
                out[f"{a}-{b}"] = variants
        _CREDITS_BUNDLE_CACHE = out
    body = gzip.compress(
        json.dumps(_CREDITS_BUNDLE_CACHE, separators=(",", ":"), ensure_ascii=False).encode("utf-8"),
        compresslevel=6,
    )
    resp = Response(body, mimetype="application/json")
    resp.headers["Content-Encoding"] = "gzip"
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.route("/save-names")
def save_names():
    """Return the unique trainer names with at least one save on disk.
    Used by /dex (the standalone art browser) to gate the page on a
    trainer login + populate the trainer-name autocomplete.
    """
    saves_dir = ROOT / "saves"
    if not saves_dir.is_dir():
        return jsonify([])
    names = set()
    for p in saves_dir.glob("*_*.json"):
        m = re.match(r"^(.+)_\d+\.json$", p.name)
        if m and _SAFE_NAME_RE.fullmatch(m.group(1)):
            names.add(m.group(1))
    return jsonify(sorted(names))


@app.route("/load")
def load_backup():
    """Return the most-recent saved backup for `?name=X`.

    Save files are named `<name>_<millis>.json` (see /save above), so the
    most recent is the one with the highest numeric suffix. Falls back
    to mtime ordering if any file's name doesn't match the pattern (e.g.
    a manual upload). 404 when no save exists for that name.
    """
    name = (request.args.get("name") or "").strip()
    if not name or not _SAFE_NAME_RE.fullmatch(name):
        abort(400)
    saves_dir = ROOT / "saves"
    if not saves_dir.is_dir():
        abort(404)
    candidates = []
    for p in saves_dir.glob(f"{name}_*.json"):
        m = re.match(rf"^{re.escape(name)}_(\d+)\.json$", p.name)
        if m:
            candidates.append((int(m.group(1)), p))
        else:
            candidates.append((int(p.stat().st_mtime * 1000), p))
    if not candidates:
        abort(404)
    candidates.sort(key=lambda t: t[0], reverse=True)
    latest = candidates[0][1]
    resp = send_from_directory(saves_dir, latest.name,
                                mimetype="application/json")
    # No HTTP cache — saves are the user's data and can change at any time.
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/creature-evolutions")
def creature_evolutions():
    # Map of species idx (string) -> list of forward evolutions, each
    # [targetIdx, method, param]. `method` is e.g. "Level" / "Item" /
    # "HasMove" / "TradeItem" / "DayHoldItem" / "LevelDay" / etc;
    # `param` is the integer level or item-name string for that method.
    # Reverse evolutions (baby → adult) are stripped at extraction time.
    path = ROOT / "data" / "Battlers" / "evolutions.json"
    if not path.is_file():
        abort(404)
    resp = send_from_directory(path.parent, path.name, mimetype="application/json")
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.route("/creature-types")
def creature_types():
    # Plain JSON map of species idx (string) -> [type1, type2|null].
    # Types are uppercase strings like "GRASS", "POISON". Extracted
    # from the upstream Pokémon Infinite Fusion species.dat (Ruby
    # Marshal) into data/Battlers/types.json.
    path = ROOT / "data" / "Battlers" / "types.json"
    if not path.is_file():
        abort(404)
    resp = send_from_directory(path.parent, path.name, mimetype="application/json")
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.route("/creature-names")
def creature_names():
    # Plain-text "one species name per line", 1-indexed (line 1 == pokemon 1).
    # Returned as a JSON array so the client can store/index it trivially.
    path = ROOT / "data" / "Battlers" / "pokemon.txt"
    if not path.is_file():
        abort(404)
    names = [ln.strip() for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    resp = jsonify(names)
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.route("/creature-sprite/<int:sheet>")
def creature_sprite(sheet):
    # Each sheet is a 960×4896 PNG holding 10×51 fusion sprites at 96×96.
    # The client fetches a sheet the first time any creature in that
    # fusion "partner B" family is shown, crops the needed index, caches
    # the individual sprite in IndexedDB, and drops the sheet.
    path = ROOT / "data" / "Battlers" / "spritesheets_autogen" / f"{sheet}.png"
    if not path.is_file():
        abort(404)
    resp = send_from_directory(path.parent, path.name, mimetype="image/png")
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


# Hand-drawn (custom) fusion sheets live in `spritesheets_custom/<B>/`,
# with the base sheet at `<B>.png` and additional variants at
# `<B>{a..z}.png`. Many cells in a custom sheet are blank (artists only
# fill in some morphs); the client alpha-scans every cell during bulk
# download and falls back to the autogen sheet for blanks.
_CUSTOM_VARIANT_RE = re.compile(r"^[a-z]$")


@app.route("/creature-sprite-custom/<int:species>")
def creature_sprite_custom_base(species):
    return _send_custom_sheet(species, "")


@app.route("/creature-sprite-custom/<int:species>/<variant>")
def creature_sprite_custom_variant(species, variant):
    if not _CUSTOM_VARIANT_RE.fullmatch(variant or ""):
        abort(400)
    return _send_custom_sheet(species, variant)


def _send_custom_sheet(species, suffix):
    fname = f"{species}{suffix}.png"
    path = ROOT / "data" / "Battlers" / "spritesheets_custom" / str(species) / fname
    if not path.is_file():
        abort(404)
    resp = send_from_directory(path.parent, path.name, mimetype="image/png")
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


# Single-cell PNG crop — used by /dex's "open just this cell in a
# new tab" click. Pillow loads the sheet, crops the 96×96 region, and
# the response is cached aggressively (sheet contents are immutable
# from the user's perspective). Two layouts: autogen sheets are 10
# cols × 51 rows; custom sheets are 20 cols × 29 rows.
def _crop_sprite_cell(path, index, cols, cell_size=96):
    if not path.is_file():
        abort(404)
    try:
        from PIL import Image
    except ImportError:
        abort(503, description="Pillow not installed; run `pip install pillow`")
    col = index % cols
    row = index // cols
    with Image.open(path) as img:
        if (col + 1) * cell_size > img.width or (row + 1) * cell_size > img.height:
            abort(404)
        cell = img.crop((col * cell_size, row * cell_size,
                         (col + 1) * cell_size, (row + 1) * cell_size))
        buf = BytesIO()
        cell.save(buf, format="PNG")
    resp = Response(buf.getvalue(), mimetype="image/png")
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.route("/sprite-cell-auto/<int:a>/<int:b>")
def sprite_cell_auto(a, b):
    return _crop_sprite_cell(
        ROOT / "data" / "Battlers" / "spritesheets_autogen" / f"{b}.png",
        a, cols=10,
    )


@app.route("/sprite-cell-custom/<int:a>/<int:b>")
def sprite_cell_custom_base(a, b):
    return _crop_sprite_cell(
        ROOT / "data" / "Battlers" / "spritesheets_custom" / str(b) / f"{b}.png",
        a, cols=20,
    )


@app.route("/sprite-cell-custom/<int:a>/<int:b>/<variant>")
def sprite_cell_custom_variant(a, b, variant):
    if not _CUSTOM_VARIANT_RE.fullmatch(variant or ""):
        abort(400)
    return _crop_sprite_cell(
        ROOT / "data" / "Battlers" / "spritesheets_custom" / str(b) / f"{b}{variant}.png",
        a, cols=20,
    )


@app.route("/creature-sprite-custom-manifest")
def creature_sprite_custom_manifest():
    # Returns { "<species>": ["", "a", "b", ...] } — the list of variant
    # suffixes that have a sheet on disk for this species. Empty string
    # is the base sheet (`<species>.png`); letters are the additional
    # variants (`<species>a.png`, `<species>b.png`, …). Species without
    # any custom sheets are absent from the map (caller falls back to
    # autogen for the entire species).
    base = ROOT / "data" / "Battlers" / "spritesheets_custom"
    if not base.is_dir():
        abort(404)
    out = {}
    for d in base.iterdir():
        if not d.is_dir() or not d.name.isdigit():
            continue
        species = int(d.name)
        if species < 1 or species > 150:
            continue
        variants = []
        for f in d.iterdir():
            m = re.match(rf"^{species}([a-z]?)\.png$", f.name)
            if m:
                variants.append(m.group(1))
        if variants:
            # Base ('') first, then letters in alphabetical order so the
            # client's variant indices are stable across runs.
            variants.sort(key=lambda s: (0 if s == "" else 1, s))
            out[str(species)] = variants
    resp = jsonify(out)
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


# Field codes for binary POI props. Keys must stay in lock-step with the
# client's POI_FIELDS array — reordering here breaks existing IDB data.
POI_FIELDS = [
    "addr:housenumber", "addr:street", "addr:city", "addr:county",
    "addr:state", "addr:country", "addr:postcode", "opening_hours",
    "phone", "contact:phone", "website", "contact:website",
    "wheelchair", "brand", "operator", "cuisine", "description",
    "wikipedia", "wikidata", "internet_access",
]
POI_FIELD_CODE = {k: i for i, k in enumerate(POI_FIELDS)}


@app.route("/poi")
def poi():
    """Binary POI bundle. Layout (little-endian, 4-byte aligned):
        Header (32 bytes):
            0:  'POIB' magic
            4:  u32 version (=1)
            8:  u32 N (poi count)
            12: u32 S (string pool count)
            16: u32 stringsByteLen
            20: u32 propsByteLen
            24: u32 reserved (0)
            28: u32 reserved (0)
        Columns (20N):
            N × f32 lng
            N × f32 lat
            N × i32 name_idx      (-1 = none; else idx into string pool)
            N × i32 category_idx  (-1 = none)
            N × u32 props_off     (0xFFFFFFFF = none; else byte offset into props block)
        Strings (stringsByteLen): S × (u16 utf8_len + utf8 bytes)
        Props  (propsByteLen):    per-POI record at props_off:
            u8 field_count
            field_count × (u8 field_code, u32 string_idx)
    """
    try:
        parts = [float(x) for x in request.args.get("bbox", "").split(",")]
    except ValueError:
        abort(400)
    if len(parts) != 4:
        abort(400)
    w, s, e, n = parts

    string_pool = []
    string_to_idx = {}

    def intern(text):
        if not text:
            return -1
        idx = string_to_idx.get(text)
        if idx is None:
            idx = len(string_pool)
            string_to_idx[text] = idx
            string_pool.append(text)
        return idx

    lngs = []
    lats = []
    name_idx = []
    category_idx = []
    props_offs = []
    props_buf = BytesIO()

    for path in _relevant_files("*.pois.sqlite", _poi_overlaps, w, s, e, n):
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            has_rtree = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='poi_rtree'"
            ).fetchone()
            if has_rtree:
                rows = conn.execute(
                    "SELECT poi.lng, poi.lat, poi.name, poi.category, poi.props "
                    "FROM poi_rtree JOIN poi ON poi.rowid = poi_rtree.id "
                    "WHERE poi_rtree.minX <= ? AND poi_rtree.maxX >= ? "
                    "  AND poi_rtree.minY <= ? AND poi_rtree.maxY >= ?",
                    (e, w, n, s),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT lng, lat, name, category, props FROM poi "
                    "WHERE lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?",
                    (w, e, s, n),
                ).fetchall()
            for lng, lat, name, category, props_json in rows:
                lngs.append(lng)
                lats.append(lat)
                name_idx.append(intern(name) if name else -1)
                category_idx.append(intern(category) if category else -1)

                props = None
                if props_json:
                    try:
                        props = json.loads(props_json)
                    except json.JSONDecodeError:
                        props = None

                emitted = []
                if props:
                    for k, v in props.items():
                        code = POI_FIELD_CODE.get(k)
                        if code is None or not v:
                            continue
                        emitted.append((code, intern(str(v))))

                if emitted:
                    props_offs.append(props_buf.tell())
                    props_buf.write(struct.pack("<B", min(len(emitted), 255)))
                    for code, sidx in emitted[:255]:
                        props_buf.write(struct.pack("<BI", code, sidx))
                else:
                    props_offs.append(0xFFFFFFFF)

    N = len(lngs)
    S = len(string_pool)

    strings_buf = BytesIO()
    for s_str in string_pool:
        b = s_str.encode("utf-8")
        if len(b) > 65535:
            b = b[:65535]
        strings_buf.write(struct.pack("<H", len(b)))
        strings_buf.write(b)
    strings_bytes = strings_buf.getvalue()
    props_bytes = props_buf.getvalue()

    body = b"".join([
        struct.pack("<4sIIIIIII",
                    b"POIB", 1, N, S,
                    len(strings_bytes), len(props_bytes), 0, 0),
        _le_bytes(lngs, "f"),
        _le_bytes(lats, "f"),
        _le_bytes(name_idx, "i"),
        _le_bytes(category_idx, "i"),
        _le_bytes(props_offs, "I"),
        strings_bytes,
        props_bytes,
    ])

    compressed = gzip.compress(body, compresslevel=1)
    resp = Response(compressed, mimetype="application/octet-stream")
    resp.headers["Content-Encoding"] = "gzip"
    resp.headers["Vary"] = "Accept-Encoding"
    g.meta["N"] = N
    g.meta["S"] = S
    return resp


@app.route("/housenumbers")
def housenumbers():
    """Binary housenumber bundle. Layout (little-endian):
        Header (40 B):
            0:  'HSNB' magic
            4:  u32 version = 1
            8:  u32 N (count)
            12: u32 M (unique strings)
            16: u32 stringsByteLen
            20: u32 reserved (0)
            24: f32 bbox west  (coords are quantised into bbox on server,
            28: f32 bbox south  and reconstructed by the client — ~1 m
            32: f32 bbox east   resolution over a city-sized bbox at u16)
            36: f32 bbox north
        Columns (6 * N):
            N × u16 lng_q
            N × u16 lat_q
            N × u16 str_idx
        Strings (stringsByteLen):
            M × (u16 utf8_len + utf8 bytes)
    """
    try:
        parts = [float(x) for x in request.args.get("bbox", "").split(",")]
    except ValueError:
        abort(400)
    if len(parts) != 4:
        abort(400)
    w, s, e, n = parts

    string_pool = []
    str_to_idx = {}
    lngs = []
    lats = []
    str_indices = []

    for path in _relevant_files("*.housenumbers.sqlite",
                                 lambda p, *a: _rtree_overlaps(p, "hn_rtree", *a),
                                 w, s, e, n):
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            rows = conn.execute(
                "SELECT h.lng_u, h.lat_u, h.text FROM hn h "
                "JOIN hn_rtree r ON h.id = r.id "
                "WHERE r.minX <= ? AND r.maxX >= ? AND r.minY <= ? AND r.maxY >= ?",
                (e, w, n, s),
            ).fetchall()
            for lng_u, lat_u, text in rows:
                if not text:
                    continue
                idx = str_to_idx.get(text)
                if idx is None:
                    idx = len(string_pool)
                    str_to_idx[text] = idx
                    string_pool.append(text)
                lngs.append(lng_u / 1e6)
                lats.append(lat_u / 1e6)
                str_indices.append(idx)

    N = len(lngs)
    M = len(string_pool)

    if N == 0:
        bw, bs, be, bn = 0.0, 0.0, 0.0, 0.0
    else:
        bw, bs, be, bn = min(lngs), min(lats), max(lngs), max(lats)
    lng_span = max(be - bw, 1e-9)
    lat_span = max(bn - bs, 1e-9)

    lngs_q = [max(0, min(65535, round((v - bw) / lng_span * 65535))) for v in lngs]
    lats_q = [max(0, min(65535, round((v - bs) / lat_span * 65535))) for v in lats]

    names_buf = BytesIO()
    for text in string_pool:
        b = text.encode("utf-8")
        if len(b) > 65535:
            b = b[:65535]
        names_buf.write(struct.pack("<H", len(b)))
        names_buf.write(b)
    names_bytes = names_buf.getvalue()

    header = struct.pack(
        "<4sIIIIIffff",
        b"HSNB", 1, N, M, len(names_bytes), 0,
        float(bw), float(bs), float(be), float(bn),
    )

    body = b"".join([
        header,
        _le_bytes(lngs_q, "H"),
        _le_bytes(lats_q, "H"),
        _le_bytes(str_indices, "H"),
        names_bytes,
    ])

    compressed = gzip.compress(body, compresslevel=1)
    resp = Response(compressed, mimetype="application/octet-stream")
    resp.headers["Content-Encoding"] = "gzip"
    resp.headers["Vary"] = "Accept-Encoding"
    g.meta["N"] = N
    g.meta["M"] = M
    return resp


@app.route("/addresses")
def addresses():
    """Per-region offline-search address bundle. Layout (little-endian):
        Header (48 B):
            0:  'ADDR' magic
            4:  u32 version = 1
            8:  u32 N (count)
            12: u32 M_num (unique housenumber strings)
            16: u32 numStringsByteLen
            20: u32 M_street (unique street strings)
            24: u32 streetStringsByteLen
            28: u32 reserved
            32: f32 bbox west
            36: f32 bbox south
            40: f32 bbox east
            44: f32 bbox north
        Columns (8 * N):
            N × u16 lng_q
            N × u16 lat_q
            N × u16 num_idx
            N × u16 street_idx
        Strings (numStringsByteLen):
            M_num × (u16 utf8_len + utf8 bytes)
        Strings (streetStringsByteLen):
            M_street × (u16 utf8_len + utf8 bytes)

    Only addresses with a non-null `street_id` are emitted — without
    a street name they're not searchable as "<num> <street>" anyway,
    and the existing /housenumbers endpoint already covers
    map-rendering needs for those entries.
    """
    try:
        parts = [float(x) for x in request.args.get("bbox", "").split(",")]
    except ValueError:
        abort(400)
    if len(parts) != 4:
        abort(400)
    w, s, e, n = parts

    num_pool = []
    num_to_idx = {}
    street_pool = []
    street_to_idx = {}
    lngs = []
    lats = []
    num_indices = []
    street_indices = []

    for path in _relevant_files("*.housenumbers.sqlite",
                                 lambda p, *a: _rtree_overlaps(p, "hn_rtree", *a),
                                 w, s, e, n):
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            # Skip DBs that haven't been rebuilt under the v2 schema
            # (no streets table → no address search data available).
            try:
                conn.execute("SELECT 1 FROM streets LIMIT 1")
            except sqlite3.OperationalError:
                continue
            rows = conn.execute(
                "SELECT h.lng_u, h.lat_u, h.text, s.name "
                "FROM hn h "
                "JOIN hn_rtree r ON h.id = r.id "
                "JOIN streets s ON h.street_id = s.id "
                "WHERE r.minX <= ? AND r.maxX >= ? AND r.minY <= ? AND r.maxY >= ?",
                (e, w, n, s),
            ).fetchall()
            for lng_u, lat_u, num_text, street_text in rows:
                if not num_text or not street_text:
                    continue
                ni = num_to_idx.get(num_text)
                if ni is None:
                    ni = len(num_pool)
                    num_to_idx[num_text] = ni
                    num_pool.append(num_text)
                si = street_to_idx.get(street_text)
                if si is None:
                    si = len(street_pool)
                    street_to_idx[street_text] = si
                    street_pool.append(street_text)
                lngs.append(lng_u / 1e6)
                lats.append(lat_u / 1e6)
                num_indices.append(ni)
                street_indices.append(si)

    N = len(lngs)
    M_num = len(num_pool)
    M_street = len(street_pool)

    if N == 0:
        bw, bs, be, bn = 0.0, 0.0, 0.0, 0.0
    else:
        bw, bs, be, bn = min(lngs), min(lats), max(lngs), max(lats)
    lng_span = max(be - bw, 1e-9)
    lat_span = max(bn - bs, 1e-9)

    lngs_q = [max(0, min(65535, round((v - bw) / lng_span * 65535))) for v in lngs]
    lats_q = [max(0, min(65535, round((v - bs) / lat_span * 65535))) for v in lats]

    def _pack_strings(pool):
        buf = BytesIO()
        for text in pool:
            b = text.encode("utf-8")
            if len(b) > 65535:
                b = b[:65535]
            buf.write(struct.pack("<H", len(b)))
            buf.write(b)
        return buf.getvalue()

    num_bytes = _pack_strings(num_pool)
    street_bytes = _pack_strings(street_pool)

    header = struct.pack(
        "<4sIIIIIIIffff",
        b"ADDR", 1, N,
        M_num, len(num_bytes),
        M_street, len(street_bytes),
        0,
        float(bw), float(bs), float(be), float(bn),
    )

    body = b"".join([
        header,
        _le_bytes(lngs_q, "H"),
        _le_bytes(lats_q, "H"),
        _le_bytes(num_indices, "H"),
        _le_bytes(street_indices, "H"),
        num_bytes,
        street_bytes,
    ])

    compressed = gzip.compress(body, compresslevel=1)
    resp = Response(compressed, mimetype="application/octet-stream")
    resp.headers["Content-Encoding"] = "gzip"
    resp.headers["Vary"] = "Accept-Encoding"
    g.meta["N"] = N
    g.meta["M_num"] = M_num
    g.meta["M_street"] = M_street
    return resp


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
                                 lambda p, *a: _rtree_overlaps(p, "route_rtree", *a),
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

    sql_bbox_ms = 0.0
    process_ms = 0.0
    total_edges_fetched = 0

    # Pre-bind hot dict/list methods so the per-row loop avoids attribute
    # lookups on globals.
    osm_get = osm_to_local.get
    nodes_osm_append = nodes_osm.append
    nodes_lng_append = nodes_lng.append
    nodes_lat_append = nodes_lat.append
    name_get = name_to_idx.get
    names_list_append = names_list.append
    edges_from_append = edges_from.append
    edges_to_append = edges_to.append
    edges_weight_append = edges_weight.append
    edges_name_idx_append = edges_name_idx.append
    edges_shape_off_append = edges_shape_off.append
    edges_shape_len_append = edges_shape_len.append
    shape_chunks_append = shape_chunks.append

    t_setup = time.perf_counter()
    walk_files = _relevant_files("*.walk.sqlite",
                                  lambda p, *a: _rtree_overlaps(p, "walk_node_rtree", *a),
                                  w, s, e, n)
    g.phases["setup"] = (time.perf_counter() - t_setup) * 1000.0
    g.meta["files"] = len(walk_files)

    # A single query fetches edges + both endpoint nodes + name text, joined
    # in sqlite. Split into two halves (from_id IN bbox / to_id IN bbox) so
    # each half uses its own endpoint index; the second half filters out
    # from_id-matches to keep them disjoint. UNION ALL is cheaper than UNION.
    edge_sql = (
        "SELECT e.weight_m, COALESCE(nm.text, ''), e.shape_blob, "
        "       nf.osm_id, nf.lng_u, nf.lat_u, "
        "       nt.osm_id, nt.lng_u, nt.lat_u "
        "FROM walk_edge e "
        "JOIN walk_node nf ON nf.id = e.from_id "
        "JOIN walk_node nt ON nt.id = e.to_id "
        "LEFT JOIN walk_name nm ON nm.id = e.name_id "
        "WHERE e.from_id IN (SELECT id FROM bbox_ids) "
        "UNION ALL "
        "SELECT e.weight_m, COALESCE(nm.text, ''), e.shape_blob, "
        "       nf.osm_id, nf.lng_u, nf.lat_u, "
        "       nt.osm_id, nt.lng_u, nt.lat_u "
        "FROM walk_edge e "
        "JOIN walk_node nf ON nf.id = e.from_id "
        "JOIN walk_node nt ON nt.id = e.to_id "
        "LEFT JOIN walk_name nm ON nm.id = e.name_id "
        "WHERE e.to_id IN (SELECT id FROM bbox_ids) "
        "  AND e.from_id NOT IN (SELECT id FROM bbox_ids)"
    )

    for path in walk_files:
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(walk_node)")}
            if "osm_id" not in cols or "lng_u" not in cols:
                continue

            t_bbox = time.perf_counter()
            conn.execute("CREATE TEMP TABLE bbox_ids (id INTEGER PRIMARY KEY)")
            conn.execute(
                "INSERT INTO bbox_ids(id) "
                "SELECT id FROM walk_node_rtree "
                "WHERE minX <= ? AND maxX >= ? AND minY <= ? AND maxY >= ?",
                (e, w, n, s),
            )
            sql_bbox_ms += (time.perf_counter() - t_bbox) * 1000.0

            # Stream-iterate the cursor: rows are consumed as sqlite emits
            # them, without materialising the full 800k-row tuple list first.
            # Row tuple: (weight_m, name_text, shape_blob,
            #             from_osm, from_lng_u, from_lat_u,
            #             to_osm,   to_lng_u,   to_lat_u)
            t_process = time.perf_counter()
            row_count = 0
            for row in conn.execute(edge_sql):
                row_count += 1
                from_osm = row[3]
                to_osm = row[6]
                if from_osm is None or to_osm is None:
                    continue
                f_loc = osm_get(from_osm)
                if f_loc is None:
                    f_loc = len(nodes_osm)
                    osm_to_local[from_osm] = f_loc
                    nodes_osm_append(from_osm)
                    nodes_lng_append(row[4] / 1e6)
                    nodes_lat_append(row[5] / 1e6)
                t_loc = osm_get(to_osm)
                if t_loc is None:
                    t_loc = len(nodes_osm)
                    osm_to_local[to_osm] = t_loc
                    nodes_osm_append(to_osm)
                    nodes_lng_append(row[7] / 1e6)
                    nodes_lat_append(row[8] / 1e6)
                name_text = row[1]
                if name_text:
                    ni = name_get(name_text)
                    if ni is None:
                        ni = len(names_list)
                        names_list_append(name_text)
                        name_to_idx[name_text] = ni
                else:
                    ni = -1
                edges_from_append(f_loc)
                edges_to_append(t_loc)
                edges_weight_append(row[0])
                edges_name_idx_append(ni)
                shape_blob = row[2]
                if shape_blob:
                    edges_shape_off_append(shapes_total)
                    edges_shape_len_append(len(shape_blob))
                    shape_chunks_append(shape_blob)
                    shapes_total += len(shape_blob)
                else:
                    edges_shape_off_append(0)
                    edges_shape_len_append(0)
            process_ms += (time.perf_counter() - t_process) * 1000.0
            total_edges_fetched += row_count

            conn.execute("DROP TABLE bbox_ids")

    g.phases["sql_bbox"] = sql_bbox_ms
    g.phases["process"] = process_ms
    g.meta["N"] = len(nodes_osm)
    g.meta["E"] = len(edges_from)
    g.meta["E_fetched"] = total_edges_fetched

    N = len(nodes_osm)
    E = len(edges_from)
    M = len(names_list)

    with _phase("pack"):
        # Sort edges by weight ascending so we can encode the first chunk as
        # u8 (0..255 m), the next as u16 (256..65535 m), and the tail (very
        # rare) as f32. Two split indices in the header describe the ranges.
        # All edge-parallel arrays must be reordered together.
        import bisect
        order = sorted(range(E), key=lambda i: edges_weight[i])
        edges_weight    = [edges_weight[i]    for i in order]
        edges_from      = [edges_from[i]      for i in order]
        edges_to        = [edges_to[i]        for i in order]
        edges_name_idx  = [edges_name_idx[i]  for i in order]
        edges_shape_off = [edges_shape_off[i] for i in order]
        edges_shape_len = [edges_shape_len[i] for i in order]

        u8_end  = bisect.bisect_right(edges_weight, 255)
        u16_end = bisect.bisect_right(edges_weight, 65535)

        # name_idx width. -1 ("no name") encodes as sentinel (max value of the
        # chosen width) so we can still use unsigned arrays client-side.
        if M < 0xFF:
            name_idx_width = 1
            name_sentinel = 0xFF
            name_typecode = "B"
        elif M < 0xFFFF:
            name_idx_width = 2
            name_sentinel = 0xFFFF
            name_typecode = "H"
        else:
            name_idx_width = 4
            name_sentinel = 0xFFFFFFFF
            name_typecode = "I"
        edges_name_idx_enc = [
            (ni if ni >= 0 else name_sentinel) for ni in edges_name_idx
        ]

        def _align4(b):
            pad = (-len(b)) & 3
            return b + (b"\x00" * pad) if pad else b

        weight_u8_bytes  = _align4(_le_bytes(edges_weight[:u8_end], "B"))
        weight_u16_bytes = _align4(_le_bytes(edges_weight[u8_end:u16_end], "H"))
        weight_f32_bytes = _le_bytes([float(v) for v in edges_weight[u16_end:]], "f")
        name_idx_bytes   = _align4(_le_bytes(edges_name_idx_enc, name_typecode))

        # Shape columns: replace the per-edge (u32 off, u32 len) pair (which
        # spends 8 B/edge × E regardless of whether the edge has a shape —
        # and on a typical city ~90% of edges have no shape) with:
        #   - a 1-bit-per-edge "has shape" bitmap
        #   - sparse (u32 off, u16 len) pairs, one per has-shape edge only
        # For 850k edges × 10% has-shape, this drops from ~6.5 MB to ~600 KB.
        bitmap_raw = bytearray((E + 7) // 8)
        sparse_shape_off = []
        sparse_shape_len = []
        for i, slen in enumerate(edges_shape_len):
            if slen > 0:
                bitmap_raw[i >> 3] |= 1 << (i & 7)
                sparse_shape_off.append(edges_shape_off[i])
                # shape_len fits in u16: max single-edge shape blob is a
                # short varint-encoded polyline, well under 64 KB.
                sparse_shape_len.append(min(slen, 0xFFFF))
        shape_edge_count = len(sparse_shape_off)

        bitmap_bytes     = _align4(bytes(bitmap_raw))
        sparse_off_bytes = _le_bytes(sparse_shape_off, "I")
        sparse_len_bytes = _align4(_le_bytes(sparse_shape_len, "H"))

        names_buf = BytesIO()
        for name in names_list:
            b = name.encode("utf-8")
            if len(b) > 65535:
                b = b[:65535]
            names_buf.write(struct.pack("<H", len(b)))
            names_buf.write(b)
        names_bytes = names_buf.getvalue()
        shapes_bytes = b"".join(shape_chunks)

        # v3 header (48 bytes). Nodes stay 8-aligned for f64 osm_id view.
        header = struct.pack(
            "<4sIIIIIIIIIII",
            b"WALK", 3, N, E, M,
            len(names_bytes), len(shapes_bytes),
            u8_end, u16_end, name_idx_width,
            shape_edge_count, 0,
        )

        body = b"".join([
            header,
            _le_bytes(nodes_osm, "d"),
            _le_bytes(nodes_lng, "f"),
            _le_bytes(nodes_lat, "f"),
            _le_bytes(edges_from, "I"),
            _le_bytes(edges_to, "I"),
            weight_u8_bytes,
            weight_u16_bytes,
            weight_f32_bytes,
            name_idx_bytes,
            bitmap_bytes,
            sparse_off_bytes,
            sparse_len_bytes,
            names_bytes,
            shapes_bytes,
        ])
        g.meta["u8end"] = u8_end
        g.meta["u16end"] = u16_end
        g.meta["niw"] = name_idx_width
        g.meta["sec"] = shape_edge_count

    with _phase("gzip"):
        compressed = gzip.compress(body, compresslevel=1)

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


@app.route("/regions/<path:fname>")
def regions_file(fname):
    """Serve a per-region static file from regions/ (output of
    build-regions.py). Mirrors the URL layout the client expects so
    the same `region-0000/walk.bin` path resolves whether the page
    is fetching from the local server or from the
    `TessaCoil/maps-dataset` Hugging Face dataset (toggled in
    Settings).

    Path-traversal defense: resolve the requested path inside
    regions/ and verify it stays within. Built files don't change
    until the next `build-regions.py` run, so set a long immutable
    cache header.
    """
    base = (ROOT / "regions").resolve()
    if not base.is_dir():
        abort(404)
    path = (base / fname).resolve()
    try:
        path.relative_to(base)
    except ValueError:
        abort(404)
    if not path.is_file():
        abort(404)
    resp = send_from_directory(path.parent, path.name)
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    # CORS so the PWA (which may be loaded from a different origin
    # in dev) can fetch these. Range requests are required for
    # PMTiles to work — Flask's send_from_directory handles those
    # natively.
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


@app.route("/bundled-data/<path:fname>")
def bundled_data(fname):
    """Serve files from data/BundledData/. This directory is the
    output of build-bundled-data.py and contains a self-contained
    snapshot of every static asset the client needs (sprites, eggs,
    species metadata, credits, manifest, icons, fonts, low-zoom
    tiles). Bundled into the iOS / Android wrapper IPA at build
    time, so the same /bundled-data/* URLs work both in the web
    PWA (served from Flask) and the native app (served from the
    WebView's local origin).

    Path-traversal defense: resolve the requested path inside
    BundledData and verify it stays within. Tile .pbf files in
    BundledData are stored gzipped (extracted as-is from mbtiles)
    so set the encoding header for those.
    """
    base = (ROOT / "data" / "BundledData").resolve()
    path = (base / fname).resolve()
    try:
        path.relative_to(base)
    except ValueError:
        abort(404)
    if not path.is_file():
        abort(404)
    # Bundled tile .pbf files are decompressed at build time
    # (build-bundled-data.py → bundle_base_map_tiles) so the raw
    # bytes are valid protobuf — no Content-Encoding needed. Set the
    # MIME type so MapLibre recognises the response.
    is_tile = fname.startswith("tiles/") and fname.endswith(".pbf")
    resp = send_from_directory(path.parent, path.name)
    if is_tile:
        resp.mimetype = "application/x-protobuf"
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.route("/schedule")
def schedule():
    try:
        parts = [float(x) for x in request.args.get("bbox", "").split(",")]
    except ValueError:
        abort(400)
    if len(parts) != 4:
        abort(400)
    w, s, e, n = parts
    if not SCHEDULE_PATH.exists():
        return gzip_json(dict(EMPTY_PAYLOAD))
    # Query logic lives in schedule_query.build_schedule_payload so the
    # offline region exporter (update-transit-schedules.py) produces byte-
    # identical payloads and can never drift from this endpoint.
    with sqlite3.connect(f"file:{SCHEDULE_PATH}?mode=ro", uri=True) as conn:
        payload = build_schedule_payload(conn, w, s, e, n)
    return gzip_json(payload)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8464, debug=True)
