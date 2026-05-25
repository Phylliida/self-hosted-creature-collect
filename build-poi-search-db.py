#!/usr/bin/env python3
"""Build a SQLite FTS5 search index for one region's POIs.

Size + query-latency estimator for the "move POI search to per-region
SQLite + FTS5 trigram" idea. Reads poi.bin and produces a sibling
poi-search.sqlite file. Doesn't modify any existing files.

Schema:
  poi          — base table (id, lng, lat, name, category)
  poi_fts      — FTS5 contentless-rowid index over (name, category)
                  using the `trigram` tokenizer. Trigram FTS5 supports
                  substring queries via MATCH:
                      SELECT id FROM poi_fts WHERE poi_fts MATCH 'starb'
  poi_geo      — R*Tree over (lng, lat) for bbox queries. Used by the
                  runtime to do viewport-bounded result ranking
                  without scanning every POI:
                      SELECT id FROM poi_geo
                       WHERE min_lng <= ? AND max_lng >= ?
                         AND min_lat <= ? AND max_lat >= ?

The id column is the POI's index in poi.bin's columnar arrays — the
runtime can look up display-only fields (props, exact strings) from
poi.bin without duplicating them into SQLite.

Usage:
    python3 build-poi-search-db.py regions/region-0361
    python3 build-poi-search-db.py regions/region-0361/poi.bin   # also accepted
"""
import argparse
import gzip
import struct
import sqlite3
import sys
from pathlib import Path


# ── poi.bin reader (mirrors hydratePoiRegion in static/index.html) ───

def _read_poi_bin(path: Path):
    """Parse poi.bin → list of (lng, lat, name, category) tuples.
    Skips per-POI props blobs (not searchable; runtime resolves them
    from poi.bin directly by id when needed)."""
    data = path.read_bytes()
    if len(data) >= 2 and data[0] == 0x1F and data[1] == 0x8B:
        data = gzip.decompress(data)
    if data[:4] != b'POIB':
        raise ValueError(f'{path}: bad magic {data[:4]!r}')
    version = struct.unpack_from('<I', data, 4)[0]
    if version != 1:
        raise ValueError(f'{path}: unsupported version {version}')
    N = struct.unpack_from('<I', data, 8)[0]
    S = struct.unpack_from('<I', data, 12)[0]
    # stringsByteLen at offset 16; we don't need it explicitly because
    # the strings section starts right after the columnar arrays.
    col_start = 32
    lng_arr = struct.unpack_from(f'<{N}f', data, col_start)
    lat_arr = struct.unpack_from(f'<{N}f', data, col_start + 4 * N)
    name_idx = struct.unpack_from(f'<{N}i', data, col_start + 8 * N)
    category_idx = struct.unpack_from(f'<{N}i', data, col_start + 12 * N)
    # propsOff at col_start + 16*N — we skip past it.
    strings_start = col_start + 20 * N
    pool = [None] * S
    p = strings_start
    for i in range(S):
        length = struct.unpack_from('<H', data, p)[0]
        p += 2
        pool[i] = data[p:p + length].decode('utf-8')
        p += length
    out = []
    for i in range(N):
        ni = name_idx[i]
        ci = category_idx[i]
        name = pool[ni] if 0 <= ni < S else ''
        cat = pool[ci] if 0 <= ci < S else ''
        out.append((lng_arr[i], lat_arr[i], name, cat))
    return out


# ── sqlite builder ──────────────────────────────────────────────────

def _check_trigram_support(conn: sqlite3.Connection) -> None:
    """Bail with a clear error if the SQLite build lacks FTS5 trigram.
    Added in SQLite 3.34 (2020-12); most modern distros include it,
    but Python on macOS or older systems may not."""
    try:
        conn.execute(
            'CREATE VIRTUAL TABLE _trigram_probe USING fts5(x, tokenize=trigram)'
        )
        conn.execute('DROP TABLE _trigram_probe')
    except sqlite3.OperationalError as exc:
        raise SystemExit(
            f'sqlite3 build doesn\'t support FTS5 trigram tokenizer: {exc}\n'
            f'  Python version: {sys.version.split()[0]}\n'
            f'  sqlite version: {sqlite3.sqlite_version}\n'
            f'  Need SQLite ≥ 3.34 with FTS5 enabled.'
        )


def build_sqlite(poi_bin: Path, out_path: Path) -> dict:
    pois = _read_poi_bin(poi_bin)
    print(f'  read {len(pois)} POIs from {poi_bin}')

    if out_path.exists():
        out_path.unlink()

    conn = sqlite3.connect(out_path)
    try:
        _check_trigram_support(conn)
        # Build-time pragmas: small page size matches mobile; turn off
        # journaling/sync for fastest bulk insert (we re-VACUUM at the
        # end which fsyncs anyway).
        conn.execute('PRAGMA journal_mode = OFF')
        conn.execute('PRAGMA synchronous = OFF')
        conn.execute('PRAGMA page_size = 4096')
        conn.execute('PRAGMA auto_vacuum = 0')

        conn.execute('''
            CREATE TABLE poi (
                id       INTEGER PRIMARY KEY,
                lng      REAL    NOT NULL,
                lat      REAL    NOT NULL,
                name     TEXT,
                category TEXT
            )
        ''')
        # FTS5 with trigram tokenizer. content=poi makes it a
        # "contentless-rowid" virtual table — the FTS5 index doesn't
        # duplicate the actual name/category text, just the trigram
        # postings. Smaller on disk; queries return rowids that we
        # join back to `poi` for the real values.
        conn.execute('''
            CREATE VIRTUAL TABLE poi_fts USING fts5(
                name, category,
                content='poi',
                content_rowid='id',
                tokenize='trigram'
            )
        ''')
        # R*Tree for "POIs in this bbox". Point R*Tree uses min==max.
        conn.execute('''
            CREATE VIRTUAL TABLE poi_geo USING rtree(
                id,
                min_lng, max_lng,
                min_lat, max_lat
            )
        ''')

        # Bulk insert into base table.
        conn.executemany(
            'INSERT INTO poi (id, lng, lat, name, category) VALUES (?, ?, ?, ?, ?)',
            ((i, lng, lat, name, cat)
             for i, (lng, lat, name, cat) in enumerate(pois))
        )

        # Bulk insert into spatial index. R*Tree needs min<=max even
        # for points — pass lng/lat twice.
        conn.executemany(
            'INSERT INTO poi_geo (id, min_lng, max_lng, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)',
            ((i, lng, lng, lat, lat)
             for i, (lng, lat, _, _) in enumerate(pois))
        )

        # Build the FTS5 index in one shot from the base table.
        # `rebuild` is faster than per-row INSERT triggers.
        conn.execute("INSERT INTO poi_fts(poi_fts) VALUES ('rebuild')")
        conn.commit()
        conn.execute('VACUUM')
        conn.commit()
    finally:
        conn.close()

    raw_size = out_path.stat().st_size

    # Per-table page breakdown so we can see where the bytes go.
    conn = sqlite3.connect(out_path)
    try:
        per_table = {}
        cur = conn.execute(
            'SELECT name, SUM(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC'
        )
        for name, size in cur:
            per_table[name] = size
    except sqlite3.OperationalError:
        # dbstat is a compile-time option; not always present
        per_table = {}
    finally:
        conn.close()

    return {
        'pois': len(pois),
        'bytes': raw_size,
        'per_table': per_table,
    }


def _format_mb(n: int) -> str:
    return f'{n / 1048576:.2f} MB'


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('path', help='region directory OR a poi.bin file')
    args = ap.parse_args()

    p = Path(args.path)
    if p.is_dir():
        poi_bin = p / 'poi.bin'
    else:
        poi_bin = p
    if not poi_bin.is_file():
        print(f'no poi.bin at {poi_bin}', file=sys.stderr)
        sys.exit(2)

    out_path = poi_bin.parent / 'poi-search.sqlite'
    stats = build_sqlite(poi_bin, out_path)

    print()
    print(f'wrote {out_path}')
    print(f'  {stats["pois"]:>7} POIs')
    print(f'  {_format_mb(stats["bytes"])}  total')
    if stats['per_table']:
        print(f'  per-table page bytes:')
        for name, size in stats['per_table'].items():
            print(f'    {name:.<30} {_format_mb(size)}')


if __name__ == '__main__':
    main()
