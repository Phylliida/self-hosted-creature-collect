#!/usr/bin/env python3
"""Download /walk-graph for a given bbox and dump a byte-level breakdown of
the binary bundle. Useful for spotting which column is the next best target
for compression.

    python3 bench-walk.py                  # defaults: localhost, Montreal bbox
    python3 bench-walk.py --bbox W,S,E,N
    python3 bench-walk.py --url https://poke.phylliidaassets.org
"""
import argparse
import gzip
import struct
import sys
import time
import urllib.request
from collections import Counter


def fmt(n):
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1048576:.2f} MB"


def align4(x):
    return (x + 3) & ~3


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8465")
    ap.add_argument(
        "--bbox",
        default="-73.94217484984556,45.040935177281284,"
                "-73.31660638748862,45.93918093916304",
        help="comma-separated W,S,E,N",
    )
    args = ap.parse_args()

    full = f"{args.url}/walk-graph?bbox={args.bbox}"
    req = urllib.request.Request(
        full,
        headers={"X-Download": "1", "Accept-Encoding": "gzip"},
    )

    t0 = time.perf_counter()
    with urllib.request.urlopen(req) as r:
        ce = r.headers.get("Content-Encoding", "")
        wire = r.read()
    elapsed_s = time.perf_counter() - t0
    body = gzip.decompress(wire) if ce == "gzip" else wire

    print(f"url     : {full}")
    print(f"time    : {elapsed_s:.2f} s")
    print(f"wire    : {fmt(len(wire))}  (gzip)")
    print(f"raw body: {fmt(len(body))}")
    if len(body):
        print(f"gzip    : {len(wire) / len(body):.1%} of raw")
    print()

    if len(body) < 48:
        print("body smaller than header — nothing to parse")
        sys.exit(1)

    magic, version, N, E, M, names_len, shapes_len, u8_end, u16_end, niw, _r1, _r2 = (
        struct.unpack_from("<4sIIIIIIIIIII", body, 0)
    )
    if magic != b"WALK":
        print(f"bad magic {magic!r}")
        sys.exit(1)

    print(f"version : {version}")
    print(f"N nodes : {N:,}")
    print(f"E edges : {E:,}")
    print(f"M names : {M:,}   (name_idx width: {niw} byte{'s' if niw > 1 else ''})")
    if E:
        print(
            f"weight  : u8={u8_end:,} ({u8_end / E:.1%})  "
            f"u16={u16_end - u8_end:,} ({(u16_end - u8_end) / E:.1%})  "
            f"f32={E - u16_end:,} ({(E - u16_end) / E:.1%})"
        )
    print()

    # Byte offsets match the layout produced by run.py /walk-graph v2.
    h = 48
    off_nodes_osm = h
    off_nodes_lng = h + 8 * N
    off_nodes_lat = h + 12 * N
    off_edges4 = h + 16 * N                  # from, to, shape_off, shape_len
    off_weights = off_edges4 + 16 * E
    off_name_idx = (
        off_weights
        + align4(u8_end)
        + align4(2 * (u16_end - u8_end))
        + 4 * (E - u16_end)
    )
    off_names = off_name_idx + align4(niw * E)
    off_shapes = off_names + names_len
    end = off_shapes + shapes_len

    if end != len(body):
        print(f"WARN: computed layout end {end} ≠ body {len(body)}")

    rows = [
        ("header",                               48),
        ("node osm_ids (f64)",                   8 * N),
        ("node lng (f32)",                       4 * N),
        ("node lat (f32)",                       4 * N),
        ("edge from (u32)",                      4 * E),
        ("edge to (u32)",                        4 * E),
        ("edge shape_off (u32)",                 4 * E),
        ("edge shape_len (u32)",                 4 * E),
        ("edge weight u8",                       align4(u8_end)),
        ("edge weight u16",                      align4(2 * (u16_end - u8_end))),
        ("edge weight f32",                      4 * (E - u16_end)),
        (f"edge name_idx (u{niw * 8})",          align4(niw * E)),
        ("names pool",                           names_len),
        ("shape blob",                           shapes_len),
    ]

    print(f"{'column':35s} {'bytes':>12s} {'%':>6s}")
    print("-" * 55)
    total = 0
    for name, b in rows:
        total += b
        pct = b / len(body) * 100 if body else 0
        print(f"{name:35s} {fmt(b):>12s} {pct:>5.1f}%")
    print("-" * 55)
    print(f"{'sum':35s} {fmt(total):>12s}")
    print()

    # Pull out shape_len column to see how many edges have no shape.
    no_shape = 0
    shape_len_off = h + 16 * N + 12 * E
    if E:
        lens = struct.unpack_from(f"<{E}I", body, shape_len_off)
        no_shape = sum(1 for v in lens if v == 0)
        longest_10pct = sum(sorted(lens, reverse=True)[: max(1, E // 10)])
        total_shape = sum(lens)
        print(f"edges with no shape : {no_shape:,} / {E:,} ({no_shape / E:.1%})")
        print(f"mean shape len      : {total_shape / E:.1f} B/edge")
        if total_shape:
            print(
                f"top 10% of edges carry {longest_10pct / total_shape:.0%} of shape bytes"
            )
    print()

    # Weight distribution (first 16 buckets of u8 range + three bucket summary)
    if E:
        wt_off = off_weights
        u8_weights = list(body[wt_off: wt_off + u8_end])
        if u8_weights:
            c = Counter()
            for w in u8_weights:
                c[w // 16] += 1
            print("u8 weight histogram (meters, 16-m buckets):")
            for bucket in sorted(c):
                lo, hi = bucket * 16, bucket * 16 + 15
                bar = "#" * int(c[bucket] / max(c.values()) * 40)
                print(f"  {lo:3d}-{hi:3d}m: {c[bucket]:7,d}  {bar}")
    print()

    # Hypothetical savings if we compact shape columns.
    cur_shape_cols = 8 * E
    u16_only = 2 * E              # replace off+len with u16 len only; off derived
    bitmap_sparse = (
        (E + 7) // 8              # one bit per edge
        + 4 * (E - no_shape)      # u32 off for has-shape edges only
        + 2 * (E - no_shape)      # u16 len for has-shape edges only
    )
    print("hypothetical IDB wins:")
    print(
        f"  shape cols: {fmt(cur_shape_cols)}  "
        f"→ u16-len only: {fmt(u16_only)} "
        f"(saves {fmt(cur_shape_cols - u16_only)})  "
        f"→ bitmap+sparse: {fmt(bitmap_sparse)} "
        f"(saves {fmt(cur_shape_cols - bitmap_sparse)})"
    )


if __name__ == "__main__":
    main()
