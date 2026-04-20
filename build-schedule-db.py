#!/usr/bin/env python3
"""Parse GTFS zip(s) into an interned, pattern-normalized schedule.sqlite.

Usage: build-schedule-db.py <agency_slug> <input.zip> [<agency_slug2> <input2.zip> ...] <output.sqlite>

Compact schema:
  pattern           — unique stop sequences (many trips share one)
  pattern_stop      — reverse index: stop -> [pattern, seq]
  trip_time         — deduplicated times_blob library
  headsign          — interned headsign strings
  service           — interned service_ids (GTFS calendar)
  service_exception — calendar_dates referencing service.id (INTEGER FK)
  trip              — compact row: all INTEGER FKs + first_departure_sec
"""
import csv
import io
import sqlite3
import sys
import time
import zipfile


def time_to_sec(s):
    if not s:
        return None
    parts = s.split(":")
    if len(parts) != 3:
        return None
    try:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    except ValueError:
        return None


def varint_pack(values):
    out = bytearray()
    for v in values:
        if v is None or v < 0:
            v = 0
        while v >= 0x80:
            out.append((v & 0x7F) | 0x80)
            v >>= 7
        out.append(v & 0x7F)
    return bytes(out)


def ensure_schema(db):
    db.executescript("""
    CREATE TABLE IF NOT EXISTS agency(
        id TEXT PRIMARY KEY,
        slug TEXT, name TEXT, url TEXT, timezone TEXT, lang TEXT
    );
    CREATE TABLE IF NOT EXISTS route(
        id TEXT PRIMARY KEY,
        agency_id TEXT, short_name TEXT, long_name TEXT,
        mode INTEGER, colour TEXT, text_colour TEXT
    );
    CREATE TABLE IF NOT EXISTS stop(
        id_num INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        agency_slug TEXT, code TEXT, name TEXT,
        lng REAL, lat REAL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS stop_rtree USING rtree(
        id_num, minX, maxX, minY, maxY
    );
    CREATE TABLE IF NOT EXISTS pattern(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id TEXT NOT NULL,
        stop_count INTEGER NOT NULL,
        stops_blob BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pattern_route ON pattern(route_id);
    CREATE TABLE IF NOT EXISTS pattern_stop(
        stop_num INTEGER NOT NULL,
        pattern_id INTEGER NOT NULL,
        stop_seq INTEGER NOT NULL,
        PRIMARY KEY (stop_num, pattern_id, stop_seq)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS trip_time(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        times_blob BLOB UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS headsign(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS service(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id TEXT UNIQUE NOT NULL,
        monday INTEGER, tuesday INTEGER, wednesday INTEGER, thursday INTEGER,
        friday INTEGER, saturday INTEGER, sunday INTEGER,
        start_date TEXT, end_date TEXT
    );
    CREATE TABLE IF NOT EXISTS service_exception(
        service_num INTEGER NOT NULL,
        date TEXT NOT NULL,
        exception_type INTEGER NOT NULL,
        PRIMARY KEY (service_num, date)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS trip(
        pattern_id INTEGER NOT NULL,
        timing_id INTEGER NOT NULL,
        service_num INTEGER NOT NULL,
        headsign_id INTEGER NOT NULL,
        direction INTEGER NOT NULL,
        first_departure_sec INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trip_pattern ON trip(pattern_id);
    CREATE INDEX IF NOT EXISTS idx_trip_service ON trip(service_num);
    CREATE TABLE IF NOT EXISTS feed_meta(
        slug TEXT PRIMARY KEY,
        url TEXT,
        ingested_at TEXT NOT NULL,
        n_trips INTEGER, n_patterns INTEGER, n_stops INTEGER
    );
    """)


def already_ingested(db, slug):
    row = db.execute("SELECT 1 FROM feed_meta WHERE slug=?", (slug,)).fetchone()
    return row is not None


def record_feed(db, slug, url, n_trips, n_patterns, n_stops):
    import datetime
    ts = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    db.execute(
        "INSERT OR REPLACE INTO feed_meta VALUES (?, ?, ?, ?, ?, ?)",
        (slug, url or "", ts, n_trips, n_patterns, n_stops),
    )


def read_csv(z, name):
    try:
        raw = z.read(name)
    except KeyError:
        return
    for row in csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))):
        yield row


def namespace(slug, value):
    return f"{slug}:{value}" if value else None


def ingest(db, slug, zip_path, url=""):
    if already_ingested(db, slug):
        sys.stderr.write(f"  [{slug}] already ingested, skipping\n"); sys.stderr.flush()
        return
    sys.stderr.write(f"  [{slug}] opening {zip_path}\n"); sys.stderr.flush()
    with zipfile.ZipFile(zip_path) as z:
        # agency
        agencies = list(read_csv(z, "agency.txt"))
        for a in agencies:
            aid = a.get("agency_id") or slug
            db.execute(
                "INSERT OR REPLACE INTO agency VALUES (?, ?, ?, ?, ?, ?)",
                (namespace(slug, aid), slug,
                 a.get("agency_name", ""), a.get("agency_url", ""),
                 a.get("agency_timezone", ""), a.get("agency_lang", "")),
            )
        default_agency = (agencies[0].get("agency_id") if agencies else slug)
        sys.stderr.write(f"    agency: {len(agencies)}\n")

        # routes
        n = 0
        for r in read_csv(z, "routes.txt"):
            try:
                mode = int(r.get("route_type") or 0)
            except ValueError:
                mode = 0
            db.execute(
                "INSERT OR REPLACE INTO route VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    namespace(slug, r.get("route_id", "")),
                    namespace(slug, r.get("agency_id") or default_agency),
                    r.get("route_short_name", ""),
                    r.get("route_long_name", ""),
                    mode,
                    ("#" + r["route_color"]) if r.get("route_color") else "",
                    ("#" + r["route_text_color"]) if r.get("route_text_color") else "",
                ),
            )
            n += 1
        sys.stderr.write(f"    routes: {n:,}\n")

        # stops
        stop_num_map = {}
        n = 0
        for s in read_csv(z, "stops.txt"):
            try:
                lng = float(s["stop_lon"]); lat = float(s["stop_lat"])
            except (KeyError, ValueError):
                continue
            sid = namespace(slug, s.get("stop_id", ""))
            db.execute(
                "INSERT INTO stop(id, agency_slug, code, name, lng, lat) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET "
                "agency_slug=excluded.agency_slug, code=excluded.code, "
                "name=excluded.name, lng=excluded.lng, lat=excluded.lat",
                (sid, slug, s.get("stop_code", ""),
                 s.get("stop_name", ""), lng, lat),
            )
            row = db.execute("SELECT id_num FROM stop WHERE id=?", (sid,)).fetchone()
            stop_num_map[sid] = row[0]
            db.execute(
                "INSERT OR REPLACE INTO stop_rtree VALUES (?, ?, ?, ?, ?)",
                (row[0], lng, lng, lat, lat),
            )
            n += 1
        sys.stderr.write(f"    stops: {n:,}\n")

        # services (interned from GTFS calendar)
        service_num_map = {}  # service_id_str -> service_num
        n = 0
        for c in read_csv(z, "calendar.txt"):
            sid = namespace(slug, c.get("service_id", ""))
            cur = db.execute(
                "INSERT OR IGNORE INTO service(service_id, monday, tuesday, "
                "wednesday, thursday, friday, saturday, sunday, start_date, end_date) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (sid,
                 int(c.get("monday", 0) or 0), int(c.get("tuesday", 0) or 0),
                 int(c.get("wednesday", 0) or 0), int(c.get("thursday", 0) or 0),
                 int(c.get("friday", 0) or 0), int(c.get("saturday", 0) or 0),
                 int(c.get("sunday", 0) or 0),
                 c.get("start_date", ""), c.get("end_date", "")),
            )
            row = db.execute("SELECT id FROM service WHERE service_id=?", (sid,)).fetchone()
            service_num_map[sid] = row[0]
            n += 1
        sys.stderr.write(f"    services: {n:,}\n")

        # calendar_dates (exception-only services: intern if not already)
        n = 0
        batch = []
        for cd in read_csv(z, "calendar_dates.txt"):
            try:
                et = int(cd.get("exception_type") or 0)
            except ValueError:
                continue
            sid = namespace(slug, cd.get("service_id", ""))
            if sid not in service_num_map:
                db.execute(
                    "INSERT INTO service(service_id, monday, tuesday, wednesday, "
                    "thursday, friday, saturday, sunday, start_date, end_date) "
                    "VALUES (?, 0, 0, 0, 0, 0, 0, 0, '', '')", (sid,))
                row = db.execute("SELECT id FROM service WHERE service_id=?", (sid,)).fetchone()
                service_num_map[sid] = row[0]
            batch.append((service_num_map[sid], cd.get("date", ""), et))
            n += 1
            if len(batch) >= 5000:
                db.executemany(
                    "INSERT OR IGNORE INTO service_exception VALUES (?, ?, ?)", batch)
                batch = []
        if batch:
            db.executemany(
                "INSERT OR IGNORE INTO service_exception VALUES (?, ?, ?)", batch)
        sys.stderr.write(f"    calendar_dates: {n:,}\n")

        # trips → preload route/service/headsign/direction
        trip_info = {}
        for t in read_csv(z, "trips.txt"):
            try:
                direction = int(t.get("direction_id") or 0)
            except ValueError:
                direction = 0
            tid = namespace(slug, t.get("trip_id", ""))
            svc_id = namespace(slug, t.get("service_id", ""))
            trip_info[tid] = {
                "route_id": namespace(slug, t.get("route_id", "")),
                "service_num": service_num_map.get(svc_id),
                "headsign": t.get("trip_headsign", "") or "",
                "direction": direction,
            }
        sys.stderr.write(f"    trips: {len(trip_info):,}\n")

        # stop_times: stream, detect patterns, intern blobs+headsigns, write trips
        t0 = time.time()
        last_tick = t0
        pattern_cache = {}   # (stop_num, ...) -> pattern_id
        blob_cache = {}      # bytes -> timing_id
        headsign_cache = {}  # text -> headsign_id
        pattern_stop_batch = []
        trip_batch = []
        stop_time_count = 0
        pattern_count = 0
        trip_count = 0
        dropped = 0

        def intern_headsign(text):
            if text in headsign_cache:
                return headsign_cache[text]
            cur = db.execute("INSERT INTO headsign(text) VALUES (?) "
                             "ON CONFLICT(text) DO NOTHING RETURNING id", (text,))
            row = cur.fetchone()
            if row is None:
                row = db.execute("SELECT id FROM headsign WHERE text=?", (text,)).fetchone()
            headsign_cache[text] = row[0]
            return row[0]

        def intern_blob(blob):
            if blob in blob_cache:
                return blob_cache[blob]
            cur = db.execute("INSERT INTO trip_time(times_blob) VALUES (?) "
                             "ON CONFLICT(times_blob) DO NOTHING RETURNING id", (blob,))
            row = cur.fetchone()
            if row is None:
                row = db.execute("SELECT id FROM trip_time WHERE times_blob=?", (blob,)).fetchone()
            blob_cache[blob] = row[0]
            return row[0]

        def flush_trip(trip_id, rows):
            nonlocal pattern_count, trip_count, dropped
            info = trip_info.get(trip_id)
            if not info or not rows or info["service_num"] is None:
                dropped += 1; return
            rows.sort(key=lambda r: r[0])
            seqs = [r[0] for r in rows]
            if any(seqs[i] == seqs[i - 1] for i in range(1, len(seqs))):
                dropped += 1; return
            stop_nums = tuple(r[1] for r in rows)
            departures = [r[3] for r in rows]
            if any(d is None for d in departures) or None in stop_nums:
                dropped += 1; return
            first_dep = departures[0]
            deltas = []
            prev = first_dep
            for d in departures[1:]:
                deltas.append(d - prev if d >= prev else 0)
                prev = d
            times_blob = varint_pack(deltas)
            timing_id = intern_blob(times_blob)

            pid = pattern_cache.get(stop_nums)
            if pid is None:
                stops_blob = varint_pack(stop_nums)
                cur = db.execute(
                    "INSERT INTO pattern(route_id, stop_count, stops_blob) VALUES (?, ?, ?)",
                    (info["route_id"], len(stop_nums), stops_blob),
                )
                pid = cur.lastrowid
                pattern_cache[stop_nums] = pid
                pattern_count += 1
                for seq, snum in enumerate(stop_nums):
                    pattern_stop_batch.append((snum, pid, seq))
                    if len(pattern_stop_batch) >= 2000:
                        db.executemany(
                            "INSERT OR IGNORE INTO pattern_stop VALUES (?, ?, ?)",
                            pattern_stop_batch)
                        pattern_stop_batch.clear()

            headsign_id = intern_headsign(info["headsign"])
            trip_batch.append((
                pid, timing_id, info["service_num"], headsign_id,
                info["direction"], first_dep,
            ))
            trip_count += 1
            if len(trip_batch) >= 2000:
                db.executemany(
                    "INSERT INTO trip VALUES (?, ?, ?, ?, ?, ?)", trip_batch)
                trip_batch.clear()

        prev_trip = None
        buffer = []
        for st in read_csv(z, "stop_times.txt"):
            trip_id = namespace(slug, st.get("trip_id", ""))
            stop_id = namespace(slug, st.get("stop_id", ""))
            try:
                seq = int(st.get("stop_sequence") or 0)
            except ValueError:
                continue
            stop_num = stop_num_map.get(stop_id)
            if stop_num is None:
                continue
            if prev_trip is not None and trip_id != prev_trip:
                flush_trip(prev_trip, buffer)
                buffer = []
            buffer.append((
                seq, stop_num,
                time_to_sec(st.get("arrival_time", "")),
                time_to_sec(st.get("departure_time", "")),
            ))
            prev_trip = trip_id
            stop_time_count += 1
            if time.time() - last_tick > 1.0:
                sys.stderr.write(
                    f"\r\033[K    stop_times: {stop_time_count:,}  "
                    f"patterns: {pattern_count:,}  trips: {trip_count:,}  "
                    f"blobs: {len(blob_cache):,}"
                )
                sys.stderr.flush()
                last_tick = time.time()
        if buffer:
            flush_trip(prev_trip, buffer)
        if trip_batch:
            db.executemany("INSERT INTO trip VALUES (?, ?, ?, ?, ?, ?)", trip_batch)
        if pattern_stop_batch:
            db.executemany(
                "INSERT OR IGNORE INTO pattern_stop VALUES (?, ?, ?)",
                pattern_stop_batch)
        sys.stderr.write(
            f"\r\033[K    stop_times: {stop_time_count:,}  "
            f"patterns: {pattern_count:,}  trips: {trip_count:,}  "
            f"blobs: {len(blob_cache):,}  headsigns: {len(headsign_cache):,}  "
            f"dropped: {dropped}  ({time.time() - t0:.1f}s)\n"
        )
        n_stops = len(stop_num_map)
        record_feed(db, slug, url, trip_count, pattern_count, n_stops)


def main(args):
    if len(args) < 3 or len(args) % 2 == 0:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    pairs = []
    for i in range(0, len(args) - 1, 2):
        pairs.append((args[i], args[i + 1]))
    dst = args[-1]

    db = sqlite3.connect(dst)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    ensure_schema(db)

    for slug, src in pairs:
        ingest(db, slug, src)
        db.commit()

    sys.stderr.write("  VACUUM…\n"); sys.stderr.flush()
    db.execute("VACUUM")
    sys.stderr.write("  ANALYZE…\n"); sys.stderr.flush()
    db.execute("ANALYZE")
    db.commit()
    db.close()
    sys.stderr.write(f"  → {dst}\n")


if __name__ == "__main__":
    main(sys.argv[1:])
