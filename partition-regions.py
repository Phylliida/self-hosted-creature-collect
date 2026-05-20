#!/usr/bin/env python3
"""Adaptive quad-tree region partitioner — fast variant.

For each candidate bbox, estimates the size of every artifact (walk
graph, POIs, housenumbers, vector tiles) and recursively subdivides
into quadrants until every leaf's largest artifact fits the per-file
budget. Outputs `regions.json` listing every leaf with its bbox + per-
artifact byte estimates, plus aggregate stats.

This is a SIZING prototype only — it does not write the actual region
files. The point is to answer:
  - How many regions cover a given area at a 30 MB budget?
  - Which artifact dominates the size budget?
  - Roughly how much total static storage will North America need?

Speed design (default tile-only mode):
  Tile bytes dominate per-region size (~95% in the Quebec measurement).
  Default mode measures tile bytes exactly from mbtiles via direct
  SQLite, and estimates the other artifacts (walk + poi + housenumbers)
  as a fixed fraction of tile bytes (--tile-fraction, default 0.3 =
  ~6× the actually-observed 5%). No HTTP, no calibration, no Flask
  needed. Full continental NA partitions run in minutes against just
  the mbtiles file.

Alternative modes:
  --calibrate           Run a live calibration pass against Flask first
                        (fits bytes-per-row constants from HTTP probes).
                        Slower but more accurate non-tile estimates.
  --calibration-from F  Load fits from a previous regions.json. Useful
                        when re-partitioning the same dataset at a
                        different budget.
  --actual-sizes        HTTP-probe Flask for true packed bytes per leaf.
                        Most precise; needs Flask alive for the entire
                        run.
  --skip-calibration    Use hardcoded bytes-per-row constants (rough).

Examples:
  # Probe a single bbox without partitioning (sanity check):
  python partition-regions.py --bbox=-74.1,45.4,-73.4,45.7 --dry-run

  # Calibrate + partition Montreal metro area:
  python partition-regions.py --bbox=-74.5,45.2,-73.0,45.9

  # Partition Quebec province at 20 MB budget:
  python partition-regions.py --bbox=-79.7,44.9,-57.1,62.6 --budget-mb=20

The Flask dev server (`python run.py`) must be reachable on startup so
calibration probes can run. After calibration completes the server is
not used again — the partitioner runs entirely against the local
SQLite files.
"""

import argparse
import json
import math
import random
import sqlite3
import sys
import time
import urllib.error
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen


SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "data"
DEFAULT_MBTILES = DATA_DIR / "north-america-latest.mbtiles"
DEFAULT_WALK_DB = DATA_DIR / "north-america-latest.walk.sqlite"
DEFAULT_POI_DB = DATA_DIR / "north-america-latest.pois.sqlite"
DEFAULT_HN_DB = DATA_DIR / "north-america-latest.housenumbers.sqlite"
DEFAULT_SERVER = "http://localhost:8464"
DEFAULT_BUDGET_MB = 30.0
DEFAULT_MIN_DEG = 0.02       # ~2 km — stop subdividing below this
DEFAULT_MAX_DEPTH = 14
DEFAULT_MIN_ZOOM = 0
DEFAULT_MAX_ZOOM = 14
# Skip subdivision once total estimated bytes drop below this — region
# is mostly water/empty and the leaf gets tagged "empty".
EMPTY_REGION_THRESHOLD_BYTES = 64 * 1024
# How many calibration probes per artifact. Each is one HTTP request
# (~1-5 s); we want enough variety to fit a meaningful slope.
DEFAULT_CALIBRATION_SAMPLES = 6


# ---------- Tile-coord math (XYZ ↔ TMS, lng/lat → tile xy) ----------


def lng_to_tile_x(lng: float, z: int) -> int:
    return int(math.floor((lng + 180.0) / 360.0 * (1 << z)))


def lat_to_tile_y_xyz(lat: float, z: int) -> int:
    lat = max(-85.05112878, min(85.05112878, lat))
    rad = math.radians(lat)
    return int(math.floor(
        (1.0 - math.log(math.tan(rad) + 1.0 / math.cos(rad)) / math.pi) / 2.0
        * (1 << z)
    ))


# ---------- Direct SQL probes (the fast path) ----------


def tile_bytes(mbtiles_conn, bbox, min_zoom, max_zoom):
    """Sum bytes of tile_data rows whose (z,x,y) intersects bbox."""
    w, s, e, n = bbox
    total = 0
    tile_count = 0
    for z in range(min_zoom, max_zoom + 1):
        x0 = lng_to_tile_x(w, z)
        x1 = lng_to_tile_x(e, z)
        y_top = lat_to_tile_y_xyz(n, z)
        y_bot = lat_to_tile_y_xyz(s, z)
        zmax = (1 << z) - 1
        # mbtiles uses TMS Y (origin bottom). Convert.
        tms_a = zmax - y_top
        tms_b = zmax - y_bot
        tms_lo, tms_hi = (tms_b, tms_a) if tms_a > tms_b else (tms_a, tms_b)
        x_lo, x_hi = (x0, x1) if x0 <= x1 else (x1, x0)
        x_lo = max(0, x_lo)
        x_hi = min(zmax, x_hi)
        tms_lo = max(0, tms_lo)
        tms_hi = min(zmax, tms_hi)
        row = mbtiles_conn.execute(
            "SELECT COALESCE(SUM(LENGTH(tile_data)), 0), COUNT(*) FROM tiles "
            "WHERE zoom_level=? "
            "AND tile_column BETWEEN ? AND ? "
            "AND tile_row BETWEEN ? AND ?",
            (z, x_lo, x_hi, tms_lo, tms_hi),
        ).fetchone()
        total += int(row[0] or 0)
        tile_count += int(row[1] or 0)
    return total, tile_count


def walk_row_count(walk_conn, bbox):
    """Count walk edges that touch a node inside bbox, plus node count.

    Matches the Flask server's edge-selection logic (union of
    from_id IN bbox_nodes and to_id IN bbox_nodes with overlap removed).
    Uses a temp table populated from the rtree so each half of the
    union can hit its own (from_id, to_id) index.
    """
    w, s, e, n = bbox
    walk_conn.execute("DROP TABLE IF EXISTS bbox_ids")
    walk_conn.execute("CREATE TEMP TABLE bbox_ids (id INTEGER PRIMARY KEY)")
    walk_conn.execute(
        "INSERT INTO bbox_ids(id) "
        "SELECT id FROM walk_node_rtree "
        "WHERE minX <= ? AND maxX >= ? AND minY <= ? AND maxY >= ?",
        (e, w, n, s),
    )
    n_nodes = walk_conn.execute("SELECT COUNT(*) FROM bbox_ids").fetchone()[0]
    if n_nodes == 0:
        return 0, 0
    n_edges_a = walk_conn.execute(
        "SELECT COUNT(*) FROM walk_edge WHERE from_id IN (SELECT id FROM bbox_ids)"
    ).fetchone()[0]
    n_edges_b = walk_conn.execute(
        "SELECT COUNT(*) FROM walk_edge "
        "WHERE to_id IN (SELECT id FROM bbox_ids) "
        "  AND from_id NOT IN (SELECT id FROM bbox_ids)"
    ).fetchone()[0]
    return n_nodes, n_edges_a + n_edges_b


def poi_row_count(poi_conn, bbox):
    w, s, e, n = bbox
    return poi_conn.execute(
        "SELECT COUNT(*) FROM poi_rtree "
        "WHERE minX <= ? AND maxX >= ? AND minY <= ? AND maxY >= ?",
        (e, w, n, s),
    ).fetchone()[0]


def hn_row_count(hn_conn, bbox):
    w, s, e, n = bbox
    return hn_conn.execute(
        "SELECT COUNT(*) FROM hn_rtree "
        "WHERE minX <= ? AND maxX >= ? AND minY <= ? AND maxY >= ?",
        (e, w, n, s),
    ).fetchone()[0]


# ---------- HTTP probes (calibration only) ----------


def fetch_bytes(url: str, timeout_s: float = 600.0):
    try:
        with urlopen(url, timeout=timeout_s) as resp:
            return len(resp.read())
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return 0
        raise


def fetch_actual_sizes(server, bbox):
    """HTTP-fetch actual packed bytes for each artifact at bbox."""
    w, s, e, n = bbox
    bbox_str = f"{w:.6f},{s:.6f},{e:.6f},{n:.6f}"
    q = urlencode({"bbox": bbox_str})
    return {
        "walk": fetch_bytes(f"{server}/walk-graph?{q}"),
        "poi": fetch_bytes(f"{server}/poi?{q}"),
        "housenumbers": fetch_bytes(f"{server}/housenumbers?{q}"),
    }


# ---------- Calibration ----------


def calibration_bboxes(root, n_samples):
    """Pick a spread of small bboxes inside `root` at varying scales.

    Every sample is capped at CALIBRATION_MAX_SIDE_DEG (~50 km) per side
    so the HTTP probes against the dev server stay fast + low-memory,
    even when the root bbox is continental. The fitted slope doesn't
    care about absolute size — it just needs a range of feature counts
    across samples, which small-bbox-only sampling provides.

    Half the samples are sized in a logarithmic ladder (large→small) so
    we capture a range of densities. The other half are uniformly
    placed across the root at a small fixed scale to make sure we
    include sparse/empty areas (giving the linear fit a near-origin
    point).
    """
    CALIBRATION_MAX_SIDE_DEG = 0.5    # ~50 km — bounds the slowest probe
    CALIBRATION_MIN_SIDE_DEG = 0.02   # ~2 km — bounds the smallest probe
    w, s, e, n = root
    rng = random.Random(0)  # determinism: same calibration on re-runs
    out = []
    # Logarithmic ladder of sizes — different orders of magnitude of
    # feature count in the fit, which makes the slope estimate robust.
    n_ladder = n_samples // 2 + 1
    for i in range(n_ladder):
        # Geometric interpolation between max and min side lengths.
        t = i / max(1, n_ladder - 1)
        side = CALIBRATION_MAX_SIDE_DEG * (
            (CALIBRATION_MIN_SIDE_DEG / CALIBRATION_MAX_SIDE_DEG) ** t
        )
        side = max(min(side, (e - w) * 0.9), CALIBRATION_MIN_SIDE_DEG * 0.5)
        cw = rng.uniform(w, e - side)
        cs = rng.uniform(s, n - side)
        out.append((cw, cs, cw + side, cs + side))
    # Uniformly-placed small samples — catch sparse/empty regions.
    target_side = CALIBRATION_MIN_SIDE_DEG * 2  # ~4 km
    target_side = min(target_side, (e - w) * 0.9, (n - s) * 0.9)
    while len(out) < n_samples:
        cw = rng.uniform(w, e - target_side)
        cs = rng.uniform(s, n - target_side)
        out.append((cw, cs, cw + target_side, cs + target_side))
    return out


def fit_linear(xs, ys):
    """Least-squares fit y = a*x + b. Returns (a, b, r_squared)."""
    n = len(xs)
    if n < 2:
        return (0.0, 0.0, 0.0)
    sx = sum(xs)
    sy = sum(ys)
    sxx = sum(x * x for x in xs)
    sxy = sum(x * y for x, y in zip(xs, ys))
    denom = n * sxx - sx * sx
    if denom == 0:
        return (0.0, sy / n, 0.0)
    a = (n * sxy - sx * sy) / denom
    b = (sy - a * sx) / n
    # R^2
    mean_y = sy / n
    ss_tot = sum((y - mean_y) ** 2 for y in ys)
    ss_res = sum((y - (a * x + b)) ** 2 for x, y in zip(xs, ys))
    r2 = 1.0 - (ss_res / ss_tot) if ss_tot > 0 else 1.0
    return (a, b, r2)


def calibrate(ctx, n_samples):
    """Probe the running server for actual bytes, count rows via SQL,
    fit a linear model per artifact. Returns dict of fits + the raw
    samples (for logging / debugging).
    """
    sys.stderr.write(f"=== Calibration: {n_samples} probes ===\n")
    bboxes = calibration_bboxes(ctx["root_bbox"], n_samples)

    # (count, bytes) per artifact across samples
    walk_pts = []   # x = edges, y = bytes (edges dominate)
    poi_pts = []    # x = pois,  y = bytes
    hn_pts = []     # x = hns,   y = bytes

    for i, bbox in enumerate(bboxes, 1):
        t = time.time()
        # SQL counts
        n_nodes, n_edges = walk_row_count(ctx["walk_conn"], bbox)
        n_pois = poi_row_count(ctx["poi_conn"], bbox)
        n_hns = hn_row_count(ctx["hn_conn"], bbox)
        # HTTP bytes
        sizes = fetch_actual_sizes(ctx["server"], bbox)
        elapsed = time.time() - t
        sys.stderr.write(
            f"  [{i}/{n_samples}] bbox=({bbox[0]:.3f},{bbox[1]:.3f},"
            f"{bbox[2]:.3f},{bbox[3]:.3f}) "
            f"edges={n_edges} pois={n_pois} hns={n_hns} "
            f"walk={format_size(sizes['walk'])} "
            f"poi={format_size(sizes['poi'])} "
            f"hn={format_size(sizes['housenumbers'])} "
            f"t={elapsed:.1f}s\n"
        )
        walk_pts.append((n_edges, sizes["walk"]))
        poi_pts.append((n_pois, sizes["poi"]))
        hn_pts.append((n_hns, sizes["housenumbers"]))

    fits = {
        "walk": fit_linear([p[0] for p in walk_pts], [p[1] for p in walk_pts]),
        "poi":  fit_linear([p[0] for p in poi_pts],  [p[1] for p in poi_pts]),
        "housenumbers": fit_linear([p[0] for p in hn_pts], [p[1] for p in hn_pts]),
    }
    sys.stderr.write("=== Fits ===\n")
    for k, (a, b, r2) in fits.items():
        sys.stderr.write(
            f"  {k:15s}  bytes ≈ {a:.2f} * count + {b:.0f}   (R²={r2:.3f})\n"
        )

    return fits, {
        "walk": walk_pts, "poi": poi_pts, "housenumbers": hn_pts,
    }


# ---------- Partitioner ----------


def estimate_sizes(ctx, bbox):
    """Size estimate for a partition probe.

    Tile bytes are always measured exactly from mbtiles. For
    walk/poi/housenumbers the script has three modes:

    - tile-only (default, fastest): non-tile artifacts estimated as a
      fixed fraction of tile bytes. Empirically the actual ratio runs
      ~5% in dense areas (Quebec data); the default fraction of 0.3
      is a 6× over-estimate that keeps the partitioner conservative
      (regions slightly smaller than necessary, never larger). No
      Flask server needed.

    - calibration (`ctx["fits"]` populated, no `tile_only`): SQL row
      counts × fitted bytes-per-row constants. Modestly more accurate
      but needs a working calibration (live or loaded via
      --calibration-from).

    - actual-sizes (`ctx["actual_sizes"]` true): HTTP-probe Flask for
      true packed bytes whenever tile bytes alone wouldn't already
      force a split. Precise but slow.
    """
    tile_b, tile_n = tile_bytes(
        ctx["mbtiles_conn"], bbox, ctx["min_zoom"], ctx["max_zoom"]
    )
    counts = {"tiles": tile_n}

    if ctx.get("tile_only"):
        # Single multiplier covers all three non-tile artifacts so the
        # math stays at one knob. The split below tracks the Quebec
        # observed ratio (walk dominates, hn next, poi smallest) so the
        # per-artifact numbers in regions.json read sensibly even
        # though they're estimated.
        frac = ctx.get("tile_fraction", 0.3)
        walk_b = int(tile_b * frac * 0.40)
        hn_b = int(tile_b * frac * 0.40)
        poi_b = int(tile_b * frac * 0.20)
        return {
            "sizes": {"walk": walk_b, "poi": poi_b,
                      "housenumbers": hn_b, "tiles": tile_b},
            "counts": counts,
        }

    # Anything below this needs the per-artifact row counts.
    n_nodes, n_edges = walk_row_count(ctx["walk_conn"], bbox)
    n_pois = poi_row_count(ctx["poi_conn"], bbox)
    n_hns = hn_row_count(ctx["hn_conn"], bbox)
    counts.update({
        "walk_nodes": n_nodes,
        "walk_edges": n_edges,
        "pois": n_pois,
        "housenumbers": n_hns,
    })

    if ctx.get("actual_sizes"):
        if tile_b > ctx["budget_bytes"]:
            return {
                "sizes": {"walk": -1, "poi": -1,
                          "housenumbers": -1, "tiles": tile_b},
                "counts": counts,
                "actual_probed": False,
            }
        if (n_edges == 0 and n_pois == 0 and n_hns == 0
                and tile_b < EMPTY_REGION_THRESHOLD_BYTES):
            return {
                "sizes": {"walk": 0, "poi": 0,
                          "housenumbers": 0, "tiles": tile_b},
                "counts": counts,
                "actual_probed": False,
            }
        http_sizes = fetch_actual_sizes(ctx["server"], bbox)
        return {
            "sizes": {
                "walk": http_sizes["walk"],
                "poi": http_sizes["poi"],
                "housenumbers": http_sizes["housenumbers"],
                "tiles": tile_b,
            },
            "counts": counts,
            "actual_probed": True,
        }

    # Calibration mode — linear model from fitted constants.
    fits = ctx["fits"]
    walk_b = max(0, int(fits["walk"][0] * n_edges + fits["walk"][1]))
    poi_b = max(0, int(fits["poi"][0] * n_pois + fits["poi"][1]))
    hn_b = max(0, int(fits["housenumbers"][0] * n_hns + fits["housenumbers"][1]))
    return {
        "sizes": {
            "walk": walk_b,
            "poi": poi_b,
            "housenumbers": hn_b,
            "tiles": tile_b,
        },
        "counts": counts,
    }


def partition(bbox, depth, ctx, regions):
    info = estimate_sizes(ctx, bbox)
    sizes = info["sizes"]
    max_size = max(sizes.values())
    sum_size = sum(sizes.values())
    w, s, e, n = bbox
    width = e - w
    height = n - s

    indent = "  " * min(depth, 8)
    sizes_str = " ".join(f"{k}={format_size(v)}" for k, v in sizes.items())
    sys.stderr.write(
        f"{indent}d={depth} bbox=({w:.3f},{s:.3f},{e:.3f},{n:.3f}) "
        f"max={format_size(max_size)} {sizes_str}\n"
    )

    leaf_reason = None
    if sum_size < EMPTY_REGION_THRESHOLD_BYTES:
        leaf_reason = "empty"
    elif max_size <= ctx["budget_bytes"]:
        leaf_reason = "fits"
    elif min(width, height) <= ctx["min_deg"]:
        leaf_reason = "min_deg"
    elif depth >= ctx["max_depth"]:
        leaf_reason = "max_depth"

    if leaf_reason is not None:
        regions.append({
            "bbox": [w, s, e, n],
            "sizes": sizes,
            "counts": info["counts"],
            "depth": depth,
            "leaf_reason": leaf_reason,
        })
        return

    mw = (w + e) / 2.0
    ms = (s + n) / 2.0
    for q in [(w, s, mw, ms), (mw, s, e, ms), (w, ms, mw, n), (mw, ms, e, n)]:
        partition(q, depth + 1, ctx, regions)


# ---------- Reporting ----------


def format_size(n: int) -> str:
    if n < 1024:
        return f"{n}B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f}KB"
    return f"{n / (1024 * 1024):.2f}MB"


def main():
    ap = argparse.ArgumentParser(
        description="Adaptive quad-tree region partitioner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--bbox", required=True,
                    help="west,south,east,north (geographic degrees)")
    ap.add_argument("--budget-mb", type=float, default=DEFAULT_BUDGET_MB,
                    help=f"Per-artifact size budget in MB (default {DEFAULT_BUDGET_MB})")
    ap.add_argument("--min-deg", type=float, default=DEFAULT_MIN_DEG,
                    help=f"Stop subdividing below this side length in degrees "
                         f"(default {DEFAULT_MIN_DEG}, ~2km at equator)")
    ap.add_argument("--max-depth", type=int, default=DEFAULT_MAX_DEPTH,
                    help=f"Maximum quad-tree depth (default {DEFAULT_MAX_DEPTH})")
    ap.add_argument("--calibration-samples", type=int,
                    default=DEFAULT_CALIBRATION_SAMPLES,
                    help=f"Number of HTTP probes for the calibration pass "
                         f"(default {DEFAULT_CALIBRATION_SAMPLES})")
    ap.add_argument("--server", default=DEFAULT_SERVER,
                    help=f"Flask server URL for calibration (default {DEFAULT_SERVER})")
    ap.add_argument("--mbtiles", type=Path, default=DEFAULT_MBTILES,
                    help=f"Path to mbtiles file (default {DEFAULT_MBTILES})")
    ap.add_argument("--walk-db", type=Path, default=DEFAULT_WALK_DB,
                    help=f"Path to walk sqlite (default {DEFAULT_WALK_DB})")
    ap.add_argument("--poi-db", type=Path, default=DEFAULT_POI_DB,
                    help=f"Path to pois sqlite (default {DEFAULT_POI_DB})")
    ap.add_argument("--hn-db", type=Path, default=DEFAULT_HN_DB,
                    help=f"Path to housenumbers sqlite (default {DEFAULT_HN_DB})")
    ap.add_argument("--min-zoom", type=int, default=DEFAULT_MIN_ZOOM,
                    help=f"Tile min zoom (default {DEFAULT_MIN_ZOOM})")
    ap.add_argument("--max-zoom", type=int, default=DEFAULT_MAX_ZOOM,
                    help=f"Tile max zoom (default {DEFAULT_MAX_ZOOM})")
    ap.add_argument("--out", type=Path, default=Path("regions.json"),
                    help="Output JSON path (default ./regions.json)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Calibrate + probe root bbox once; skip partitioning")
    ap.add_argument("--skip-calibration", action="store_true",
                    help="Skip calibration; assume bytes-per-row constants "
                         "(walk≈40, poi≈40, hn≈12). Use only if the server "
                         "is unreachable and rough estimates are acceptable.")
    ap.add_argument("--calibration-from", type=Path, default=None,
                    help="Load fits from a previous regions.json instead of "
                         "running fresh calibration probes. Useful when "
                         "re-partitioning the same dataset at a different "
                         "budget or root bbox — calibration only depends on "
                         "the data format, not the geographic extent, so "
                         "one calibration is reusable indefinitely.")
    ap.add_argument("--actual-sizes", action="store_true",
                    help="Use actual packed bytes (HTTP probe) for every "
                         "leaf-candidate bbox instead of count×constant "
                         "estimation. Slower (a few HTTP requests per "
                         "leaf) but precise. Continent-sized bboxes are "
                         "skipped via the local tile-byte pre-filter "
                         "(tile bytes alone exceed the budget → split "
                         "without probing), so the Flask server never "
                         "sees an OOM-sized request.")
    ap.add_argument("--tile-only", action="store_true",
                    help="Default mode (this flag is just for explicit "
                         "documentation): ignore Flask entirely, measure "
                         "tile bytes exactly from mbtiles, and estimate "
                         "walk+poi+housenumbers as a fixed fraction of "
                         "tile bytes (see --tile-fraction). No "
                         "calibration step, no HTTP probes, no server "
                         "needed. To opt into calibration-based "
                         "estimation, use --calibrate or "
                         "--calibration-from.")
    ap.add_argument("--tile-fraction", type=float, default=0.3,
                    help="In tile-only mode: total estimated size of "
                         "non-tile artifacts as a fraction of tile bytes "
                         "(default 0.3 — actual ratio is ~0.05 in dense "
                         "areas, so 0.3 is a ~6× safety margin).")
    ap.add_argument("--calibrate", action="store_true",
                    help="Run a live calibration pass before partitioning "
                         "(fits bytes-per-row constants for walk/poi/"
                         "housenumbers from HTTP probes against the Flask "
                         "server). Slower but more accurate than the "
                         "default tile-only mode. Requires `python run.py` "
                         "to be running.")
    args = ap.parse_args()

    try:
        bbox = tuple(float(x) for x in args.bbox.split(","))
        if len(bbox) != 4:
            raise ValueError
    except ValueError:
        sys.exit("ERROR: --bbox must be 4 comma-separated floats: w,s,e,n")
    w, s, e, n = bbox
    if w >= e or s >= n:
        sys.exit(f"ERROR: bbox must have w<e and s<n, got {bbox}")

    for p in [args.mbtiles, args.walk_db, args.poi_db, args.hn_db]:
        if not p.exists():
            sys.exit(f"ERROR: not found: {p}")

    ctx = {
        "root_bbox": bbox,
        "mbtiles_conn": sqlite3.connect(f"file:{args.mbtiles}?mode=ro", uri=True),
        "walk_conn": sqlite3.connect(f"file:{args.walk_db}?mode=ro", uri=True),
        "poi_conn": sqlite3.connect(f"file:{args.poi_db}?mode=ro", uri=True),
        "hn_conn": sqlite3.connect(f"file:{args.hn_db}?mode=ro", uri=True),
        "server": args.server,
        "budget_bytes": int(args.budget_mb * 1024 * 1024),
        "min_deg": args.min_deg,
        "max_depth": args.max_depth,
        "min_zoom": args.min_zoom,
        "max_zoom": args.max_zoom,
    }

    ctx["actual_sizes"] = bool(args.actual_sizes)
    ctx["tile_fraction"] = args.tile_fraction

    # Mode dispatch — tile-only is the default. The other modes are
    # explicit opt-ins (calibrate, calibration-from, actual-sizes,
    # skip-calibration). At most one of those should be specified.
    explicit_modes = [
        bool(args.actual_sizes),
        bool(args.calibration_from),
        bool(args.skip_calibration),
        bool(args.calibrate),
        bool(args.tile_only),
    ]
    if sum(explicit_modes) > 1:
        sys.exit(
            "ERROR: choose at most one of --tile-only, --calibrate, "
            "--calibration-from, --actual-sizes, --skip-calibration"
        )

    samples = {}
    if args.actual_sizes:
        ctx["tile_only"] = False
        ctx["fits"] = {
            "walk": (0.0, 0.0, 0.0),
            "poi": (0.0, 0.0, 0.0),
            "housenumbers": (0.0, 0.0, 0.0),
        }
        sys.stderr.write(
            "=== Actual-sizes mode: skipping calibration, HTTP-probing leaves ===\n"
        )
    elif args.calibration_from is not None:
        ctx["tile_only"] = False
        if not args.calibration_from.exists():
            sys.exit(f"ERROR: --calibration-from not found: {args.calibration_from}")
        prev = json.loads(args.calibration_from.read_text())
        if "calibration" not in prev or "fits" not in prev["calibration"]:
            sys.exit(f"ERROR: {args.calibration_from} has no calibration data")
        fits_data = prev["calibration"]["fits"]
        ctx["fits"] = {
            k: (v["slope"], v["intercept"], v["r_squared"])
            for k, v in fits_data.items()
        }
        sys.stderr.write(
            f"=== Calibration loaded from {args.calibration_from} ===\n"
        )
        for k, (a, b, r2) in ctx["fits"].items():
            sys.stderr.write(
                f"  {k:15s}  bytes ≈ {a:.2f} * count + {b:.0f}   (R²={r2:.3f})\n"
            )
    elif args.skip_calibration:
        ctx["tile_only"] = False
        ctx["fits"] = {
            "walk": (40.0, 0.0, 0.0),
            "poi": (40.0, 0.0, 0.0),
            "housenumbers": (12.0, 0.0, 0.0),
        }
        sys.stderr.write("=== Calibration skipped (using hardcoded constants) ===\n")
    elif args.calibrate:
        ctx["tile_only"] = False
        ctx["fits"], samples = calibrate(ctx, args.calibration_samples)
    else:
        # Default — tile-only mode.
        ctx["tile_only"] = True
        ctx["fits"] = {
            "walk": (0.0, 0.0, 0.0),
            "poi": (0.0, 0.0, 0.0),
            "housenumbers": (0.0, 0.0, 0.0),
        }
        sys.stderr.write(
            f"=== Tile-only mode (default): non-tile artifacts estimated "
            f"as {args.tile_fraction:.2f}× tile bytes (no server needed) ===\n"
        )

    if args.dry_run:
        sys.stderr.write(f"\n=== Dry run: probing root bbox ===\n")
        info = estimate_sizes(ctx, bbox)
        for k, v in info["sizes"].items():
            print(f"  {k:15s} {format_size(v):>10s}  ({v} bytes est)")
        for k, v in info["counts"].items():
            print(f"  {k:15s} {v:>10d}")
        sys.stderr.write(f"max={format_size(max(info['sizes'].values()))}\n")
        return

    sys.stderr.write(
        f"\n=== Partitioning bbox={bbox} budget={args.budget_mb}MB "
        f"min_deg={args.min_deg} max_depth={args.max_depth} ===\n"
    )
    regions = []
    t0 = time.time()
    partition(bbox, 0, ctx, regions)
    elapsed = time.time() - t0

    # Stats
    n_total = len(regions)
    n_empty = sum(1 for r in regions if r["leaf_reason"] == "empty")
    n_substantive = n_total - n_empty
    n_over_budget = sum(
        1 for r in regions
        if max(r["sizes"].values()) > ctx["budget_bytes"]
    )
    per_artifact_totals = {"walk": 0, "poi": 0, "housenumbers": 0, "tiles": 0}
    substantive_bytes = 0
    for r in regions:
        if r["leaf_reason"] == "empty":
            continue
        for k, v in r["sizes"].items():
            per_artifact_totals[k] += v
            substantive_bytes += v

    out = {
        "root_bbox": list(bbox),
        "params": {
            "budget_mb": args.budget_mb,
            "min_deg": args.min_deg,
            "max_depth": args.max_depth,
            "min_zoom": args.min_zoom,
            "max_zoom": args.max_zoom,
        },
        "calibration": {
            "fits": {k: {"slope": v[0], "intercept": v[1], "r_squared": v[2]}
                     for k, v in ctx["fits"].items()},
            "samples": samples if samples else None,
        },
        "stats": {
            "n_regions_total": n_total,
            "n_regions_substantive": n_substantive,
            "n_regions_empty": n_empty,
            "n_regions_over_budget": n_over_budget,
            "substantive_bytes_total": substantive_bytes,
            "per_artifact_total_bytes": per_artifact_totals,
            "wall_time_s": round(elapsed, 1),
        },
        "regions": regions,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=2))

    sys.stderr.write("\n=== Done ===\n")
    sys.stderr.write(f"Regions: {n_total} total, {n_substantive} substantive, "
                     f"{n_empty} empty\n")
    sys.stderr.write(f"Over budget (hit min_deg/max_depth): {n_over_budget}\n")
    sys.stderr.write(f"Total bytes (substantive): {format_size(substantive_bytes)}\n")
    for k, v in per_artifact_totals.items():
        sys.stderr.write(f"  {k:15s} {format_size(v):>10s}\n")
    sys.stderr.write(f"Wall time: {elapsed:.1f}s\n")
    sys.stderr.write(f"Output: {args.out}\n")


if __name__ == "__main__":
    main()
