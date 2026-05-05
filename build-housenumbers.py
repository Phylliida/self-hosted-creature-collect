#!/usr/bin/env python3
"""Extract addr:housenumber features from an OSM .pbf into a sqlite db
consumed by the /housenumbers endpoint. Writes an rtree over the point
locations so bbox queries stay fast on city-sized regions.

Schema v2 (current) also captures addr:street, interned into a
`streets` table. The `hn` row carries street_id (nullable — many
housenumbers in OSM omit addr:street). Used by /housenumbers in two
ways:
  * Map rendering: ignores street_id; just renders the number.
  * Address search: joins hn → streets, returns "<num> <street>"
    formatted entries to the client's per-region offline search.

Progress is logged every PROGRESS_INTERVAL_SEC seconds: rows
processed, unique streets so far, elapsed time, instantaneous rate,
and read-position percentage of the input PBF when osmium exposes a
file pointer (falls back to a count-based "I'm alive" line otherwise).
osmium's apply_file is a single C++ call with no progress callback,
so we sample from inside the per-record handler — cheap, no overhead.

Usage: python3 build-housenumbers.py input.osm.pbf output.sqlite
"""
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time

import osmium

PROGRESS_INTERVAL_SEC = 5.0


def _fmt_dur(secs):
    secs = int(secs)
    h, rem = divmod(secs, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h{m:02d}m{s:02d}s"
    if m:
        return f"{m}m{s:02d}s"
    return f"{s}s"


def _prefilter_pbf(src):
    """Run osmium-tool's tags-filter to produce a small PBF containing
    only nodes/ways that carry an addr:housenumber tag (plus the node
    references each filtered way needs to compute its centroid).

    Order-of-magnitude wins for big inputs: a continent-scale 18 GB
    PBF prefilters down to ~200 MB in 10–20 minutes, then our handler
    runs through the filtered file in a couple of minutes instead of
    8+ hours. For city-scale inputs it's still strictly faster — the
    overhead is the cost of one fast pass over an already-small file.

    Returns the path to the filtered tempfile. The caller is expected
    to delete it after use. Raises RuntimeError if osmium-tool isn't
    available; main() falls back to scanning the raw input in that
    case (slow, but functional).
    """
    if not shutil.which("osmium"):
        raise RuntimeError("osmium-tool not found in PATH")
    fd, filtered = tempfile.mkstemp(suffix=".osm.pbf", prefix="hn-prefilter-")
    os.close(fd)
    try:
        size_gb = os.path.getsize(src) / (1 << 30)
        print(f"pre-filtering {src} ({size_gb:.1f} GB) for addr:housenumber …",
              flush=True)
        t0 = time.monotonic()
        # `nw/addr:housenumber` keeps every node + way carrying the
        # tag. osmium-tool implicitly pulls in the node references each
        # surviving way needs so centroids resolve correctly.
        subprocess.run(
            ["osmium", "tags-filter", src, "nw/addr:housenumber",
             "-o", filtered, "--overwrite", "--progress"],
            check=True,
        )
        out_mb = os.path.getsize(filtered) / (1 << 20)
        elapsed = time.monotonic() - t0
        print(f"  pre-filter complete in {_fmt_dur(elapsed)} "
              f"({out_mb:.1f} MB output)", flush=True)
        return filtered
    except Exception:
        try:
            os.unlink(filtered)
        except OSError:
            pass
        raise


class Handler(osmium.SimpleHandler):
    """Collect (lng, lat, num, street_id) rows for every node/way
    carrying an addr:housenumber tag. Ways are reduced to their
    centroid. Street names are interned at extraction time so the
    on-disk row carries an integer reference, not the duplicated
    text — that's the bulk of the size savings vs storing the
    literal street string per row."""

    def __init__(self, db, started_at, total_bytes=0):
        super().__init__()
        self.db = db
        self.batch = []
        self.count = 0
        # Maps street name -> sequential integer id. Insertion order
        # determines the id, which is ALSO the rowid in the streets
        # table (we insert in the same order at the end of the run).
        self.streets = {}
        self.started_at = started_at
        self.total_bytes = total_bytes
        self.next_progress_at = started_at + PROGRESS_INTERVAL_SEC
        self.last_progress_count = 0
        self.last_progress_at = started_at
        # Counter sampled on every node/way callback so progress
        # ticks even through long runs where no housenumbers are
        # being emitted (e.g. scanning Alaska or open ocean tiles).
        # Bitmask check is ~1 ns per call; far cheaper than calling
        # time.monotonic() on every node.
        self._scan_counter = 0

    def _flush(self):
        if self.batch:
            self.db.executemany(
                "INSERT INTO hn(lng_u, lat_u, text, street_id) "
                "VALUES (?, ?, ?, ?)",
                self.batch,
            )
            self.count += len(self.batch)
            self.batch.clear()
            self._maybe_log()

    def _maybe_log(self):
        now = time.monotonic()
        if now < self.next_progress_at:
            return
        elapsed = now - self.started_at
        delta_count = self.count - self.last_progress_count
        delta_secs = max(now - self.last_progress_at, 1e-6)
        rate = delta_count / delta_secs
        self.last_progress_count = self.count
        self.last_progress_at = now
        self.next_progress_at = now + PROGRESS_INTERVAL_SEC
        print(
            f"  {self.count:>12,} housenumbers · "
            f"{len(self.streets):>8,} streets · "
            f"elapsed {_fmt_dur(elapsed)} · "
            f"{rate:>8,.0f}/s",
            flush=True,
        )

    def _street_id(self, name):
        if not name:
            return None
        sid = self.streets.get(name)
        if sid is None:
            sid = len(self.streets) + 1   # 1-based to match SQLite rowid
            self.streets[name] = sid
        return sid

    def _emit(self, lng, lat, text, street_name):
        self.batch.append((
            round(lng * 1_000_000),
            round(lat * 1_000_000),
            text,
            self._street_id(street_name),
        ))
        if len(self.batch) >= 20000:
            self._flush()

    def node(self, n):
        self._scan_counter += 1
        # Sample progress every ~1M node callbacks so quiet sections
        # (rural areas, open ocean) still emit lines.
        if (self._scan_counter & 0xFFFFF) == 0:
            self._maybe_log()
        text = n.tags.get("addr:housenumber")
        if not text or not n.location.valid():
            return
        street = n.tags.get("addr:street")
        self._emit(n.location.lon, n.location.lat, text, street)

    def way(self, w):
        self._scan_counter += 1
        if (self._scan_counter & 0xFFFFF) == 0:
            self._maybe_log()
        text = w.tags.get("addr:housenumber")
        if not text:
            return
        street = w.tags.get("addr:street")
        sx = sy = 0.0
        cnt = 0
        try:
            for nref in w.nodes:
                if nref.location.valid():
                    sx += nref.location.lon
                    sy += nref.location.lat
                    cnt += 1
        except Exception:
            return
        if cnt == 0:
            return
        self._emit(sx / cnt, sy / cnt, text, street)


def main():
    if len(sys.argv) != 3:
        print("usage: build-housenumbers.py input.osm.pbf output.sqlite", file=sys.stderr)
        sys.exit(1)
    src, dst = sys.argv[1], sys.argv[2]

    # Try to pre-filter the PBF down to addr:housenumber-tagged
    # features only. Falls back to scanning the raw input if
    # osmium-tool isn't installed (slow but functional). The
    # filtered tempfile is removed in the `finally` block whether
    # or not the build succeeds.
    filtered_pbf = None
    try:
        try:
            filtered_pbf = _prefilter_pbf(src)
            scan_src = filtered_pbf
        except RuntimeError as e:
            print(f"warning: pre-filter unavailable ({e}); "
                  f"scanning raw PBF (this will be much slower)",
                  file=sys.stderr, flush=True)
            scan_src = src

        db = sqlite3.connect(dst)
        db.execute("PRAGMA journal_mode = WAL")
        db.execute("PRAGMA synchronous = NORMAL")
        db.executescript("""
            DROP TABLE IF EXISTS hn;
            DROP TABLE IF EXISTS hn_rtree;
            DROP TABLE IF EXISTS streets;
            CREATE TABLE streets (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE
            );
            CREATE TABLE hn (
                id INTEGER PRIMARY KEY,
                lng_u INTEGER NOT NULL,
                lat_u INTEGER NOT NULL,
                text TEXT NOT NULL,
                street_id INTEGER REFERENCES streets(id)
            );
            CREATE VIRTUAL TABLE hn_rtree USING rtree(
                id, minX, maxX, minY, maxY
            );
        """)

        started_at = time.monotonic()
        try:
            total_bytes = os.path.getsize(scan_src)
        except OSError:
            total_bytes = 0
        print(f"scanning {scan_src} ({total_bytes / (1 << 20):.1f} MB) …",
              flush=True)
        h = Handler(db, started_at, total_bytes)
        h.apply_file(scan_src, locations=True)
        h._flush()
        elapsed = time.monotonic() - started_at
        print(f"  scan complete in {_fmt_dur(elapsed)}; "
              f"finalising rtree + streets table …", flush=True)

        # Materialize the streets table from the in-memory dict in
        # insertion order so streets.id matches the integer we wrote
        # into hn.street_id during extraction.
        if h.streets:
            db.executemany(
                "INSERT INTO streets(id, name) VALUES (?, ?)",
                ((sid, name) for name, sid in h.streets.items()),
            )

        db.execute(
            "INSERT INTO hn_rtree(id, minX, maxX, minY, maxY) "
            "SELECT id, lng_u/1000000.0, lng_u/1000000.0, "
            "       lat_u/1000000.0, lat_u/1000000.0 FROM hn"
        )
        # Index for "all housenumbers on this street" lookups (used by
        # the address-search server query when the user types a street
        # name).
        db.execute("CREATE INDEX hn_street_idx ON hn(street_id) "
                   "WHERE street_id IS NOT NULL")
        db.commit()
        db.close()
        print(f"{h.count:,} housenumbers, "
              f"{len(h.streets):,} unique streets -> {dst}")
    finally:
        if filtered_pbf and os.path.exists(filtered_pbf):
            try:
                os.unlink(filtered_pbf)
            except OSError:
                pass


if __name__ == "__main__":
    main()
