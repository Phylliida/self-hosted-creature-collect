#!/usr/bin/env python3
"""Materialize the actual region files from a regions.json plan.

Reads the output of `partition-regions.py`, then for each substantive
leaf region:
  1. HTTP-fetches walk.bin / poi.bin / housenumbers.bin from the Flask
     dev server (re-uses the existing bbox endpoints — they already
     produce the exact packed binary the client expects).
  2. Extracts tiles intersecting the region's bbox directly from the
     mbtiles file and writes them into a PMTiles v3 archive.

Output layout:
  regions/
    index.json              — root manifest the client downloads first
    region-0000/walk.bin
    region-0000/poi.bin
    region-0000/housenumbers.bin
    region-0000/tiles.pmtiles
    region-0001/...
    ...

The Flask dev server must be running for the entire build (HTTP probes
hit it for every region). Tile extraction is local-only (mbtiles +
SQLite). Resumable: existing region directories are skipped, so a
Ctrl+C and re-run picks up where the previous build left off.

Example:
  # Partition first (run.py must be running):
  python partition-regions.py --bbox=-170,7,-52,84 --budget-mb=50 \\
      --out=regions-na.json

  # Then build the actual files:
  python build-regions.py --plan=regions-na.json --out-dir=regions

The PMTiles v3 encoder is implemented inline below. Reference spec:
https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
Tiles are stored without content-dedup (every directory entry is
unique). For a per-region archive of ~1000 tiles this costs ~few KB
of directory overhead vs a fully-deduped encoding — not worth the
complexity in a build script. MapLibre + the pmtiles JS protocol
read both shapes identically.
"""

import argparse
import gzip
import io
import json
import math
import sqlite3
import struct
import sys
import time
import urllib.error
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen


# ---------- PMTiles v3 encoder (inline; ~150 lines) ----------

PMTILES_MAGIC = b"PMTiles"
PMTILES_VERSION = 3
HEADER_BYTES = 127

# Compression enum values from the PMTiles spec.
COMPRESSION_NONE = 0x01
COMPRESSION_GZIP = 0x02

# Tile type enum.
TILE_TYPE_MVT = 0x01


def _write_varint(buf: bytearray, n: int) -> None:
    """LEB128-style unsigned varint, matching the PMTiles spec."""
    if n < 0:
        raise ValueError("varint must be non-negative")
    while n >= 0x80:
        buf.append((n & 0x7F) | 0x80)
        n >>= 7
    buf.append(n & 0x7F)


def zxy_to_tile_id(z: int, x: int, y: int) -> int:
    """PMTiles tile_id = Hilbert-curve position at zoom z + accumulator
    for prior zooms (so each zoom occupies a contiguous tile_id range).

    Hilbert math from the standard Wikipedia algorithm. Verified against
    the protomaps reference: z=0 → 0; z=1, (0,0) → 1; etc.
    """
    acc = ((1 << (2 * z)) - 1) // 3  # (4^z - 1) / 3
    if z == 0:
        return acc
    n = 1 << z
    d = 0
    s = n >> 1
    while s > 0:
        rx = 1 if (x & s) > 0 else 0
        ry = 1 if (y & s) > 0 else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                x = s - 1 - x
                y = s - 1 - y
            x, y = y, x
        s >>= 1
    return acc + d


def _serialize_directory(entries) -> bytes:
    """Pack a list of (tile_id, offset, length, run_length) → spec bytes.
    Entries MUST be pre-sorted by tile_id ascending.
    """
    buf = bytearray()
    _write_varint(buf, len(entries))
    # 1) tile_id deltas
    prev = 0
    for tid, _, _, _ in entries:
        _write_varint(buf, tid - prev)
        prev = tid
    # 2) run lengths
    for _, _, _, rl in entries:
        _write_varint(buf, rl)
    # 3) lengths
    for _, _, ln, _ in entries:
        _write_varint(buf, ln)
    # 4) offsets — sentinel 0 means "contiguous with previous entry's end";
    #    any other value is (offset + 1) so 0 stays special.
    for i, (_, off, _, _) in enumerate(entries):
        if i > 0 and off == entries[i - 1][1] + entries[i - 1][2]:
            _write_varint(buf, 0)
        else:
            _write_varint(buf, off + 1)
    return bytes(buf)


def write_pmtiles(
    out_path: Path,
    tiles,
    bbox,
    min_zoom: int,
    max_zoom: int,
    tile_compression: int = COMPRESSION_GZIP,
) -> None:
    """Write a PMTiles v3 archive.

    tiles: iterable of (z, x, y, tile_bytes). tile_bytes must already be
           in the compression encoding declared by `tile_compression`
           (our mbtiles stores tiles as gzipped MVT — pass through).
    bbox: (west, south, east, north) in degrees, used for the header's
           geographic bounds.
    """
    # Compute tile_ids and group identical content so we can use the
    # PMTiles "tile_contents" optimization (a directory entry can point
    # at content shared with another entry).
    indexed = []
    for z, x, y, blob in tiles:
        indexed.append((zxy_to_tile_id(z, x, y), z, x, y, blob))
    indexed.sort(key=lambda t: t[0])

    # Lay out tile data section: each unique content blob written once.
    # Map content-hash → (offset, length) so duplicate tiles point to
    # the same bytes. For per-region archives the dedup is small but
    # essentially free.
    tile_data_buf = bytearray()
    content_index = {}      # hash(blob) → (offset, length)
    dir_entries = []        # (tile_id, offset, length, run_length)
    for tid, z, x, y, blob in indexed:
        h = hash(blob)
        if h in content_index:
            off, ln = content_index[h]
        else:
            off = len(tile_data_buf)
            ln = len(blob)
            tile_data_buf.extend(blob)
            content_index[h] = (off, ln)
        # No run-length compression across consecutive tile_ids in this
        # encoder — each entry has run_length=1. (Run-length compression
        # is a bonus optimization; spec-correct without it.)
        dir_entries.append((tid, off, ln, 1))

    # Serialize root directory + gzip it (internal_compression=gzip).
    root_dir_uncompressed = _serialize_directory(dir_entries)
    root_dir = gzip.compress(root_dir_uncompressed)

    # JSON metadata (tilejson-ish). Required field per spec is just
    # "vector_layers" for MVT; we leave layer fields empty since the
    # tilemaker mbtiles already documents them and clients pull schema
    # from one global place if needed.
    metadata_obj = {"vector_layers": []}
    metadata_bytes = gzip.compress(json.dumps(metadata_obj).encode("utf-8"))

    # Layout offsets — header is fixed 127 bytes, then root dir, then
    # metadata, then leaves (we have none), then tile data.
    root_dir_offset = HEADER_BYTES
    root_dir_length = len(root_dir)
    json_metadata_offset = root_dir_offset + root_dir_length
    json_metadata_length = len(metadata_bytes)
    leaf_dirs_offset = json_metadata_offset + json_metadata_length
    leaf_dirs_length = 0  # all entries fit in root dir
    tile_data_offset = leaf_dirs_offset + leaf_dirs_length
    tile_data_length = len(tile_data_buf)

    w, s, e, n = bbox
    center_lon = (w + e) / 2.0
    center_lat = (s + n) / 2.0
    center_zoom = min_zoom  # arbitrary; viewer picks anyway

    header = bytearray(HEADER_BYTES)
    # bytes 0-6: magic
    header[0:7] = PMTILES_MAGIC
    # byte 7: version
    header[7] = PMTILES_VERSION
    # The remaining fields are little-endian. Use struct to pack at the
    # documented offsets.
    struct.pack_into("<Q", header, 8,   root_dir_offset)
    struct.pack_into("<Q", header, 16,  root_dir_length)
    struct.pack_into("<Q", header, 24,  json_metadata_offset)
    struct.pack_into("<Q", header, 32,  json_metadata_length)
    struct.pack_into("<Q", header, 40,  leaf_dirs_offset)
    struct.pack_into("<Q", header, 48,  leaf_dirs_length)
    struct.pack_into("<Q", header, 56,  tile_data_offset)
    struct.pack_into("<Q", header, 64,  tile_data_length)
    struct.pack_into("<Q", header, 72,  len(dir_entries))   # num_addressed_tiles
    struct.pack_into("<Q", header, 80,  len(dir_entries))   # num_tile_entries
    struct.pack_into("<Q", header, 88,  len(content_index)) # num_tile_contents (unique blobs)
    header[96] = 1  # clustered (tiles in tile_id order)
    header[97] = COMPRESSION_GZIP  # internal_compression (directory + metadata)
    header[98] = tile_compression
    header[99] = TILE_TYPE_MVT
    header[100] = min_zoom
    header[101] = max_zoom
    struct.pack_into("<i", header, 102, int(round(w * 1e7)))
    struct.pack_into("<i", header, 106, int(round(s * 1e7)))
    struct.pack_into("<i", header, 110, int(round(e * 1e7)))
    struct.pack_into("<i", header, 114, int(round(n * 1e7)))
    header[118] = center_zoom
    struct.pack_into("<i", header, 119, int(round(center_lon * 1e7)))
    struct.pack_into("<i", header, 123, int(round(center_lat * 1e7)))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(header)
        f.write(root_dir)
        f.write(metadata_bytes)
        f.write(tile_data_buf)


# ---------- Tile extraction (mbtiles → in-memory list) ----------


def lng_to_tile_x(lng: float, z: int) -> int:
    return int(math.floor((lng + 180.0) / 360.0 * (1 << z)))


def lat_to_tile_y_xyz(lat: float, z: int) -> int:
    lat = max(-85.05112878, min(85.05112878, lat))
    rad = math.radians(lat)
    return int(math.floor(
        (1.0 - math.log(math.tan(rad) + 1.0 / math.cos(rad)) / math.pi) / 2.0
        * (1 << z)
    ))


def extract_tiles_for_bbox(conn, bbox, min_zoom, max_zoom):
    """Yield (z, x, y, gzipped_pbf) for each tile intersecting bbox.
    Tile coords yielded in XYZ (origin top-left), matching PMTiles."""
    w, s, e, n = bbox
    for z in range(min_zoom, max_zoom + 1):
        x0 = lng_to_tile_x(w, z)
        x1 = lng_to_tile_x(e, z)
        y_top = lat_to_tile_y_xyz(n, z)
        y_bot = lat_to_tile_y_xyz(s, z)
        zmax = (1 << z) - 1
        tms_a = zmax - y_top
        tms_b = zmax - y_bot
        tms_lo, tms_hi = (tms_b, tms_a) if tms_a > tms_b else (tms_a, tms_b)
        x_lo, x_hi = (x0, x1) if x0 <= x1 else (x1, x0)
        x_lo = max(0, x_lo)
        x_hi = min(zmax, x_hi)
        tms_lo = max(0, tms_lo)
        tms_hi = min(zmax, tms_hi)
        for row in conn.execute(
            "SELECT tile_column, tile_row, tile_data FROM tiles "
            "WHERE zoom_level=? "
            "AND tile_column BETWEEN ? AND ? "
            "AND tile_row BETWEEN ? AND ?",
            (z, x_lo, x_hi, tms_lo, tms_hi),
        ):
            tile_x = row[0]
            tms_y = row[1]
            xyz_y = zmax - tms_y
            yield (z, tile_x, xyz_y, bytes(row[2]))


# ---------- Per-artifact HTTP fetches ----------


def fetch_to_file(url: str, out_path: Path, timeout_s: float = 600.0) -> int:
    """GET url and stream into out_path. Returns bytes written."""
    try:
        with urlopen(url, timeout=timeout_s) as resp:
            data = resp.read()
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            # Empty bbox / no data — write a 0-byte file so the client
            # can distinguish "we built this region; there's just no
            # data of this type" from "we forgot to build it".
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(b"")
            return 0
        raise
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(data)
    return len(data)


# ---------- Build orchestrator ----------


def build_region(region, region_dir, ctx):
    """Fetch + assemble all artifacts for one region. Returns dict with
    actual byte sizes, or None if the region was already complete."""
    bbox = region["bbox"]
    w, s, e, n = bbox
    bbox_str = f"{w:.6f},{s:.6f},{e:.6f},{n:.6f}"
    q = urlencode({"bbox": bbox_str})

    walk_path = region_dir / "walk.bin"
    poi_path = region_dir / "poi.bin"
    hn_path = region_dir / "housenumbers.bin"
    pmt_path = region_dir / "tiles.pmtiles"

    # Resume support — skip regions where all four files exist already.
    if all(p.exists() for p in (walk_path, poi_path, hn_path, pmt_path)):
        return {
            "walk": walk_path.stat().st_size,
            "poi": poi_path.stat().st_size,
            "housenumbers": hn_path.stat().st_size,
            "tiles": pmt_path.stat().st_size,
            "skipped": True,
        }

    sizes = {}
    sizes["walk"] = fetch_to_file(f"{ctx['server']}/walk-graph?{q}", walk_path)
    sizes["poi"] = fetch_to_file(f"{ctx['server']}/poi?{q}", poi_path)
    sizes["housenumbers"] = fetch_to_file(f"{ctx['server']}/housenumbers?{q}", hn_path)

    # Tiles: collect from mbtiles, write a fresh pmtiles archive.
    tiles_iter = list(extract_tiles_for_bbox(
        ctx["mbtiles_conn"], bbox, ctx["min_zoom"], ctx["max_zoom"]
    ))
    write_pmtiles(
        pmt_path, tiles_iter, bbox,
        ctx["min_zoom"], ctx["max_zoom"],
        tile_compression=COMPRESSION_GZIP,
    )
    sizes["tiles"] = pmt_path.stat().st_size

    return sizes


def format_size(n: int) -> str:
    if n < 1024:
        return f"{n}B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f}KB"
    return f"{n / (1024 * 1024):.2f}MB"


def main():
    ap = argparse.ArgumentParser(
        description="Materialize region files from a partition plan",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--plan", type=Path, required=True,
                    help="Path to regions.json (output of partition-regions.py)")
    ap.add_argument("--out-dir", type=Path, default=Path("regions"),
                    help="Output directory (default ./regions)")
    ap.add_argument("--server", default="http://localhost:8464",
                    help="Flask server URL (default http://localhost:8464)")
    ap.add_argument("--mbtiles", type=Path,
                    default=Path("data") / "north-america-latest.mbtiles",
                    help="Path to mbtiles file")
    ap.add_argument("--start", type=int, default=0,
                    help="Start at this region index (skip earlier ones)")
    ap.add_argument("--limit", type=int, default=0,
                    help="Stop after building this many regions (0 = no limit)")
    args = ap.parse_args()

    if not args.plan.exists():
        sys.exit(f"ERROR: plan not found: {args.plan}")
    if not args.mbtiles.exists():
        sys.exit(f"ERROR: mbtiles not found: {args.mbtiles}")

    plan = json.loads(args.plan.read_text())
    params = plan.get("params", {})
    min_zoom = params.get("min_zoom", 0)
    max_zoom = params.get("max_zoom", 14)

    substantive = [
        r for r in plan["regions"] if r.get("leaf_reason") != "empty"
    ]
    sys.stderr.write(
        f"=== Building {len(substantive)} regions "
        f"(of {len(plan['regions'])} total) into {args.out_dir} ===\n"
    )
    sys.stderr.write(f"min_zoom={min_zoom} max_zoom={max_zoom}\n")

    ctx = {
        "server": args.server,
        "mbtiles_conn": sqlite3.connect(f"file:{args.mbtiles}?mode=ro", uri=True),
        "min_zoom": min_zoom,
        "max_zoom": max_zoom,
    }

    args.out_dir.mkdir(parents=True, exist_ok=True)
    index = []
    t_start = time.time()
    n_built = 0
    n_skipped = 0
    failures = []

    for i, region in enumerate(substantive):
        if i < args.start:
            continue
        if args.limit and (n_built + n_skipped) >= args.limit:
            break

        rid = f"region-{i:04d}"
        region_dir = args.out_dir / rid
        t = time.time()
        try:
            sizes = build_region(region, region_dir, ctx)
        except Exception as exc:
            sys.stderr.write(f"  [{i}] {rid} FAILED: {exc}\n")
            failures.append({"index": i, "error": str(exc)})
            continue
        elapsed = time.time() - t

        if sizes.get("skipped"):
            n_skipped += 1
            tag = "skip"
        else:
            n_built += 1
            tag = "ok"

        bbox = region["bbox"]
        total = sum(v for k, v in sizes.items() if k != "skipped")
        sys.stderr.write(
            f"  [{i:4d}/{len(substantive)}] {rid} {tag} "
            f"bbox=({bbox[0]:.3f},{bbox[1]:.3f},{bbox[2]:.3f},{bbox[3]:.3f}) "
            f"walk={format_size(sizes['walk'])} "
            f"poi={format_size(sizes['poi'])} "
            f"hn={format_size(sizes['housenumbers'])} "
            f"tiles={format_size(sizes['tiles'])} "
            f"total={format_size(total)} t={elapsed:.1f}s\n"
        )

        index.append({
            "id": rid,
            "bbox": bbox,
            "sizes": {k: v for k, v in sizes.items() if k != "skipped"},
            "files": {
                "walk": f"{rid}/walk.bin",
                "poi": f"{rid}/poi.bin",
                "housenumbers": f"{rid}/housenumbers.bin",
                "tiles": f"{rid}/tiles.pmtiles",
            },
        })

    # Write index.json — the manifest the client downloads first to know
    # which region covers it. Sorted by id for stable diffs.
    manifest = {
        "version": 1,
        "built_at": int(time.time()),
        "tile_zoom_range": [min_zoom, max_zoom],
        "n_regions": len(index),
        "regions": sorted(index, key=lambda r: r["id"]),
    }
    if failures:
        manifest["failures"] = failures
    (args.out_dir / "index.json").write_text(json.dumps(manifest, indent=2))

    elapsed = time.time() - t_start
    sys.stderr.write(f"\n=== Done ===\n")
    sys.stderr.write(f"Built: {n_built}, Skipped (resume): {n_skipped}, "
                     f"Failed: {len(failures)}\n")
    sys.stderr.write(f"Wall time: {elapsed:.1f}s\n")
    sys.stderr.write(f"Output: {args.out_dir}/index.json\n")


if __name__ == "__main__":
    main()
