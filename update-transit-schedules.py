#!/usr/bin/env python3
"""One-shot transit SCHEDULE refresh — safe to run from cron.

Bus/train times come from a static GTFS snapshot. GTFS feeds only publish a
few months of forward calendar, so the snapshot expires: once every service
calendar for an agency is in the past, stop popups show "no upcoming" and the
transit trip planner (which reads the same schedule index) finds no rides.

This script rebuilds that snapshot and re-exports it — and ONLY that. It does
the whole pipeline end to end:

  0. Refresh the feeds-*.tsv files from the live Mobility Database catalog
     (new agencies, moved URLs, replacements for deprecated ids; manual
     entries like `stm` are preserved). Skip with --no-refresh-feeds.
  1. Re-ingest current GTFS feeds into a fresh temporary schedule DB
     (ingest-gtfs.py). The feed URLs already serve the current feed, so a
     fresh download == fresh calendars.
  2. Re-link GTFS stops to OSM nodes (link-gtfs-to-osm.py -> gtfs_osm_link).
  3. Sanity-check the rebuilt DB, then atomically swap it into
     data/schedule.sqlite (keeping a .bak for rollback).
  4. Re-export every regions/<id>/schedule.json straight from the new DB
     (no running server needed — uses schedule_query, the same code the
     /schedule endpoint uses, so the output can't drift).

It touches NOTHING else: walk.bin, poi.bin, housenumbers.bin, addresses.bin,
tiles.pmtiles and poi-trigram.bin are never read or written. Fixing transit
does not require regenerating the (expensive) map/walk/POI artifacts.

Exit code is 0 on success, non-zero on any failure (so cron/monitoring can
alert). On failure before the swap, the live data/schedule.sqlite is left
untouched.

Examples:
  # Full refresh (Canada feeds only — fast, covers STM/exo/STL/etc.):
  python update-transit-schedules.py --feeds feeds-ca.tsv

  # Full refresh preserving all current coverage (CA+US+MX; big download):
  python update-transit-schedules.py

  # Re-export region files from the CURRENT db only (no download, no swap):
  python update-transit-schedules.py --skip-rebuild

  # Preview everything, write nothing, don't swap:
  python update-transit-schedules.py --skip-rebuild --dry-run

  # Example crontab (03:30 on the 1st of each month), logging to a file:
  #   30 3 1 * *  cd /path/to/app && /usr/bin/python3 update-transit-schedules.py \\
  #                 --feeds feeds-ca.tsv >> logs/transit-refresh.log 2>&1
"""
import argparse
import gzip
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

from schedule_query import build_schedule_payload
import gtfs_catalog

HERE = Path(__file__).resolve().parent
EMPTY_SCHEDULE_MAX_BYTES = 160   # a transit-free region gzips to ~this or less


def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def die(msg, code=1):
    log(f"ERROR: {msg}")
    sys.exit(code)


# ---------- schedule payload helpers (shared shape with /schedule) ----------

def gzip_payload(payload):
    """Match run.py's gzip_json body exactly (compresslevel 5, compact JSON)."""
    return gzip.compress(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"),
        compresslevel=5,
    )


def gunzip(raw):
    if not raw:
        return b""
    try:
        return gzip.decompress(raw)
    except Exception:
        return None


def feed_ends(plain_bytes):
    """{feed prefix -> latest real service end_date} for one schedule.json.

    Per-FEED so a single long-calendar agency can't mask an expired sibling
    in the same region (e.g. STM expired while a commuter-rail feed runs to
    2032). Skips the far-future sentinels some feeds use.
    """
    try:
        doc = json.loads(plain_bytes.decode("utf-8"))
    except Exception:
        return {}
    out = {}
    for svc in doc.get("services") or []:
        if not isinstance(svc, dict):
            continue
        end = svc.get("end")
        if not end or end >= "20990101":
            continue
        pfx = str(svc.get("id", "")).split(":", 1)[0] or "?"
        if pfx not in out or end > out[pfx]:
            out[pfx] = end
    return out


def merge_max(dst, src):
    for k, v in src.items():
        if k not in dst or v > dst[k]:
            dst[k] = v


# ---------- feeds TSV refresh (pick up new feeds + URL changes) ----------

def refresh_feeds_tsvs(feeds, catalog_url, catalog_cache):
    """Refresh each feeds-<cc>.tsv in `feeds` from the live Mobility
    Database catalog, so new agencies and moved URLs are picked up
    automatically instead of going stale between manual regenerations.

    Merge rules per file:
      * existing slugs keep their row, with the URL/name updated from the
        fresh catalog when present
      * existing slugs the catalog marks deprecated (or redirected) are
        dropped — their replacements arrive as new catalog ids
      * brand-new feeds are added only when active (mirrors of inactive
        feeds serve stale schedules, so we don't grow the ingest with them)
      * an entry whose URL another kept entry already serves is skipped,
        so the same agency is never ingested twice under two slugs
        (e.g. manual `stm` vs the catalog's mdb-2126, same zip URL)
    A truncated/failed catalog fetch never clobbers a good TSV: on any
    doubt the existing file is kept."""
    import re
    targets = []
    for tsv in feeds:
        m = re.fullmatch(r"feeds-([a-z]{2})\.tsv", Path(tsv).name)
        if m:
            targets.append((Path(tsv), m.group(1).upper()))
    if not targets:
        return
    try:
        text = gtfs_catalog.fetch_catalog(catalog_url)
    except Exception as e:
        log(f"  WARNING: catalog fetch failed ({e}) — keeping existing feeds TSVs")
        return
    catalog_rows = {row.get("id", ""): row for row in csv_reader(text)}
    try:
        catalog_cache = Path(catalog_cache)
        catalog_cache.parent.mkdir(parents=True, exist_ok=True)
        catalog_cache.write_text(text, encoding="utf-8")
    except OSError:
        pass

    for tsv, country in targets:
        if not tsv.exists():
            continue
        fresh = gtfs_catalog.entries_from_catalog(text, country)
        fresh_by_slug = {e[0]: e for e in fresh}
        existing = gtfs_catalog.read_feeds_tsv(tsv)
        active_new = [e for e in fresh if e[0] not in {s for s, _, _, _ in existing}]
        if len(fresh) < 0.5 * max(len(existing), 1):
            log(f"  WARNING: fresh catalog has only {len(fresh)} active {country} feeds "
                f"vs {len(existing)} in {tsv.name} — keeping existing file")
            continue
        merged = []
        seen_urls = set()
        n_updated = n_dropped = 0
        for slug, url, name, fallback in existing:
            row = catalog_rows.get(slug)
            if row and (row.get("status") == "deprecated" or row.get("redirect.id")):
                n_dropped += 1
                continue
            e = fresh_by_slug.get(slug)
            if e and e[1] != url:
                n_updated += 1
            entry = e or (slug, url, name, fallback)
            if entry[1] in seen_urls:
                continue
            seen_urls.add(entry[1])
            merged.append(entry)
        n_added = 0
        for e in active_new:
            if e[1] in seen_urls:
                continue
            seen_urls.add(e[1])
            merged.append(e)
            n_added += 1
        if merged != existing:
            gtfs_catalog.write_feeds_tsv(tsv, merged)
            log(f"  refreshed {tsv.name}: {len(existing)} -> {len(merged)} feeds "
                f"({n_updated} URLs updated, {n_added} new, {n_dropped} deprecated dropped)")
        else:
            log(f"  {tsv.name}: already up to date ({len(existing)} feeds)")


def csv_reader(text):
    import csv as _csv
    return _csv.DictReader(text.splitlines())


# ---------- pipeline steps ----------

def run_script(script, *script_args):
    """Run a sibling python script as a subprocess, streaming its output.
    Returns its exit code — the caller decides what's fatal."""
    argv = [sys.executable, str(HERE / script), *map(str, script_args)]
    log(f"$ {' '.join(argv)}")
    return subprocess.run(argv).returncode


def ingest_feeds(tmp_db, tsv, retries, browser_fallback):
    """Ingest one feeds TSV into tmp_db.

    ingest-gtfs.py exit codes: 0 = every feed OK; 2 = some feeds failed to
    download/validate/ingest but the rest succeeded and ARE in the DB
    (normal — agency servers go down, URLs move); 1/other = fatal setup
    error. Exit 2 is NOT fatal: ingest is resumable (skips feeds already in
    feed_meta), so we retry just the un-ingested feeds up to `retries` times
    to sweep up transient download failures, then proceed with what landed.
    validate_db() is the real guard against a too-small rebuild.
    """
    name = Path(tsv).name
    extra = [] if browser_fallback else ["--no-browser-fallback"]
    for attempt in range(retries + 1):
        code = run_script("ingest-gtfs.py", tmp_db, "--feeds", tsv, *extra)
        if code == 0:
            return
        if code == 2:
            if attempt < retries:
                log(f"  some {name} feeds failed to download (exit 2); "
                    f"retrying the un-ingested ones "
                    f"(attempt {attempt + 2}/{retries + 1})…")
                continue
            log(f"  WARNING: some {name} feeds still unreachable after "
                f"{retries} retr{'y' if retries == 1 else 'ies'} — proceeding "
                f"with the feeds that succeeded (validate_db will guard).")
            return
        die(f"ingest-gtfs.py exited {code} (fatal) on {name}")


def rebuild_db(tmp_db, feeds, routes_db, retries, resume, browser_fallback=False):
    """Ingest every feed file, then link to OSM. Fresh build unless
    --resume (which keeps an existing tmp_db so ingest can skip feeds
    already ingested — handy after a partial/interrupted run)."""
    if not resume:
        for p in (tmp_db,
                  tmp_db.with_name(tmp_db.name + "-wal"),
                  tmp_db.with_name(tmp_db.name + "-shm")):
            if p.exists():
                p.unlink()
    elif tmp_db.exists():
        log(f"(--resume) continuing from existing {tmp_db.name} "
            f"(already-ingested feeds will be skipped)")
    for tsv in feeds:
        if not Path(tsv).exists():
            die(f"feeds file not found: {tsv}")
        log(f"--- ingesting feeds: {tsv} ---")
        ingest_feeds(tmp_db, tsv, retries, browser_fallback)
    if not Path(routes_db).exists():
        die(f"routes db (for OSM linking) not found: {routes_db}")
    log("--- linking GTFS stops to OSM nodes ---")
    code = run_script("link-gtfs-to-osm.py", tmp_db, routes_db)
    if code != 0:
        die(f"link-gtfs-to-osm.py exited {code}")


def db_counts(db):
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as c:
        def one(q):
            try:
                return c.execute(q).fetchone()[0]
            except sqlite3.Error:
                return 0
        return {
            "stops": one("SELECT COUNT(*) FROM stop"),
            "services": one("SELECT COUNT(*) FROM service"),
            "trips": one("SELECT COUNT(*) FROM trip"),
            "links": one("SELECT COUNT(*) FROM gtfs_osm_link"),
        }


def validate_db(tmp_db, live_db):
    """Refuse to swap in an obviously-broken rebuild (e.g. a network failure
    that produced an empty or truncated DB), which would wipe good data."""
    c = db_counts(tmp_db)
    log(f"rebuilt DB: stops={c['stops']} services={c['services']} "
        f"trips={c['trips']} osm_links={c['links']}")
    if c["stops"] == 0 or c["services"] == 0 or c["trips"] == 0:
        die("rebuilt DB is empty — refusing to swap (keeping current data)")
    if c["links"] == 0:
        die("rebuilt DB has no gtfs_osm_link rows — did OSM linking run?")
    if live_db.exists():
        old = db_counts(live_db)
        if old["trips"] and c["trips"] < 0.5 * old["trips"]:
            die(f"rebuilt DB has {c['trips']} trips vs {old['trips']} in the "
                f"current DB (<50%) — looks like a partial ingest; refusing "
                f"to swap. Re-run, or pass --allow-shrink to override.")
    return c


def swap_db(tmp_db, live_db, backup):
    """Atomically replace live_db with tmp_db, keeping a .bak (copy-first so
    the DB is never briefly absent for a concurrent /schedule request)."""
    live_db.parent.mkdir(parents=True, exist_ok=True)
    if backup and live_db.exists():
        bak = live_db.with_name(live_db.name + ".bak")
        log(f"backing up current DB -> {bak.name}")
        shutil.copy2(live_db, bak)
    os.replace(tmp_db, live_db)          # atomic on same filesystem
    for suffix in ("-wal", "-shm"):      # stale WAL from the temp build
        stale = tmp_db.with_name(tmp_db.name + suffix)
        if stale.exists():
            stale.unlink()
    log(f"swapped in new schedule DB -> {live_db}")


def export_regions(db, index_path, out_dir, dry_run, only_transit, update_index):
    """Re-export each region's schedule.json straight from `db`."""
    idx = json.loads(index_path.read_text())
    regions = idx.get("regions") if isinstance(idx, dict) else idx
    if not isinstance(regions, list):
        die(f"{index_path} has no 'regions' list")

    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    total = len(regions)
    changed = written = with_transit = skipped_empty = 0
    feeds_old, feeds_new = {}, {}
    t0 = time.time()

    for i, region in enumerate(regions):
        rid = region.get("id") or f"region-{i:04d}"
        bbox = region.get("bbox")
        if not bbox or len(bbox) != 4:
            continue
        rel = (region.get("files") or {}).get("schedule") or f"{rid}/schedule.json"
        out_path = out_dir / rel

        old = out_path.read_bytes() if out_path.exists() else b""
        old_plain = gunzip(old)
        if old_plain:
            merge_max(feeds_old, feed_ends(old_plain))
        if only_transit and len(old) <= EMPTY_SCHEDULE_MAX_BYTES:
            skipped_empty += 1
            continue

        payload = build_schedule_payload(conn, *bbox)
        new_plain = json.dumps(payload, separators=(",", ":"),
                               ensure_ascii=False).encode("utf-8")
        merge_max(feeds_new, feed_ends(new_plain))
        if len(new_plain) > EMPTY_SCHEDULE_MAX_BYTES:
            with_transit += 1

        if new_plain != (old_plain or b""):
            changed += 1
            if not dry_run:
                body = gzip_payload(payload)
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_bytes(body)
                written += 1
                if update_index:
                    region.setdefault("sizes", {})["schedule"] = len(body)

        if (i + 1) % 100 == 0 or i + 1 == total:
            rate = (i + 1) / max(time.time() - t0, 1e-9)
            log(f"  export [{i + 1}/{total}] changed={changed} "
                f"transit={with_transit} ({rate:.0f}/s)")

    conn.close()
    if update_index and not dry_run:
        idx["schedule_refreshed_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        index_path.write_text(json.dumps(idx, indent=1, ensure_ascii=False))
        log(f"  updated {index_path}")

    return {
        "total": total, "changed": changed, "written": written,
        "with_transit": with_transit, "skipped_empty": skipped_empty,
        "feeds_old": feeds_old, "feeds_new": feeds_new,
    }


def print_summary(res, dry_run, only_transit):
    today = time.strftime("%Y%m%d")
    exp_old = [p for p, e in res["feeds_old"].items() if e < today]
    exp_new = sorted((e, p) for p, e in res["feeds_new"].items() if e < today)
    log("=" * 58)
    log(f"regions          : {res['total']}")
    log(f"changed          : {res['changed']}"
        + ("  (dry-run: nothing written)" if dry_run else f"  written={res['written']}"))
    log(f"with transit     : {res['with_transit']}")
    if only_transit:
        log(f"skipped (empty)  : {res['skipped_empty']}")
    log(f"feeds seen       : {len(res['feeds_new'])}")
    log(f"expired feeds    : {len(exp_old)} (before) -> {len(exp_new)} (after)")
    if not exp_new:
        log("                   OK - every feed's calendar now reaches today or later")
    else:
        log(f"                   WARNING - {len(exp_new)} feed(s) still expired "
            f"(agency may not have published a newer GTFS yet):")
        for end, pfx in exp_new[:15]:
            log(f"                     {end}  {pfx}")
        if len(exp_new) > 15:
            log(f"                     ... and {len(exp_new) - 15} more")
    log("=" * 58)


def default_feeds():
    return [str(HERE / f) for f in ("feeds-ca.tsv", "feeds-us.tsv", "feeds-mx.tsv")
            if (HERE / f).exists()]


def main():
    ap = argparse.ArgumentParser(
        description="Rebuild + re-export ONLY the transit schedule data",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--feeds", action="append", default=None,
                    help="GTFS feeds .tsv (repeatable). Default: all feeds-*.tsv present")
    ap.add_argument("--routes-db", default=str(HERE / "data" / "north-america-latest.routes.sqlite"),
                    help="OSM routes sqlite used for stop<->node linking")
    ap.add_argument("--db", type=Path, default=HERE / "data" / "schedule.sqlite",
                    help="live schedule DB to replace (default data/schedule.sqlite)")
    ap.add_argument("--index", type=Path, default=HERE / "regions" / "index.json",
                    help="region manifest (default regions/index.json)")
    ap.add_argument("--out-dir", type=Path, default=HERE / "regions",
                    help="region output directory (default ./regions)")
    ap.add_argument("--skip-rebuild", action="store_true",
                    help="skip ingest/link/swap; just re-export region files from the current DB")
    ap.add_argument("--dry-run", action="store_true",
                    help="don't write region files and don't swap the DB; report only")
    ap.add_argument("--only-transit", action="store_true",
                    help="skip regions whose current schedule.json is empty (faster)")
    ap.add_argument("--update-index", action="store_true",
                    help="also refresh sizes.schedule in index.json")
    ap.add_argument("--no-backup", action="store_true",
                    help="don't keep a .bak of the replaced DB")
    ap.add_argument("--allow-shrink", action="store_true",
                    help="swap even if the rebuilt DB has far fewer trips than the current one")
    ap.add_argument("--ingest-retries", type=int, default=2,
                    help="retry passes to sweep up feeds that failed to download (default 2)")
    ap.add_argument("--no-browser-fallback", action="store_true",
                    help="don't retry bot-blocked feeds through a real browser "
                         "(default: browser fallback on — only feeds whose plain "
                         "download failed get the browser attempt)")
    ap.add_argument("--no-refresh-feeds", action="store_true",
                    help="don't refresh feeds-*.tsv from the Mobility Database "
                         "catalog before ingesting (default: refresh)")
    ap.add_argument("--catalog-url", default=gtfs_catalog.DEFAULT_CATALOG_URL,
                    help="catalog CSV URL (default: Mobility Database feeds_v2.csv)")
    ap.add_argument("--resume", action="store_true",
                    help="keep an existing *.rebuild.sqlite and resume ingest (skips feeds already done)")
    ap.add_argument("--keep-temp", action="store_true",
                    help="keep the temporary rebuild DB on success")
    args = ap.parse_args()

    if not args.index.exists():
        die(f"index not found: {args.index}")

    export_db = args.db          # which DB the region export reads from
    t_start = time.time()

    if not args.skip_rebuild:
        tmp_db = args.db.with_name(args.db.stem + ".rebuild.sqlite")
        feeds = args.feeds or default_feeds()
        if not feeds:
            die("no feeds .tsv found (looked for feeds-ca/us/mx.tsv); pass --feeds")
        if not args.no_refresh_feeds:
            log("--- refreshing feeds TSVs from the Mobility Database catalog ---")
            refresh_feeds_tsvs(feeds, args.catalog_url,
                               HERE / "data" / "mdb-catalog.csv")
        log(f"REBUILD: feeds={[Path(f).name for f in feeds]} routes_db={Path(args.routes_db).name}")
        rebuild_db(tmp_db, feeds, args.routes_db, args.ingest_retries, args.resume,
                   browser_fallback=not args.no_browser_fallback)

        # Validate; --allow-shrink relaxes the shrink guard only.
        try:
            validate_db(tmp_db, args.db)
        except SystemExit:
            if args.allow_shrink:
                log("(--allow-shrink) proceeding despite validation shrink warning")
            else:
                if not args.keep_temp and tmp_db.exists():
                    log(f"leaving rebuilt DB for inspection: {tmp_db}")
                raise

        if args.dry_run:
            log("(dry-run) NOT swapping the DB; exporting from the rebuilt temp DB")
            export_db = tmp_db
        else:
            swap_db(tmp_db, args.db, backup=not args.no_backup)
            export_db = args.db
    else:
        log("(--skip-rebuild) re-exporting region files from the current DB")

    if not export_db.exists():
        die(f"schedule DB not found: {export_db}")

    log(f"EXPORT: region schedule.json from {export_db}")
    res = export_regions(export_db, args.index, args.out_dir,
                         dry_run=args.dry_run, only_transit=args.only_transit,
                         update_index=args.update_index)
    print_summary(res, args.dry_run, args.only_transit)

    if (not args.skip_rebuild) and (not args.dry_run) and (not args.keep_temp):
        tmp_db = args.db.with_name(args.db.stem + ".rebuild.sqlite")
        if tmp_db.exists():
            tmp_db.unlink()

    log(f"done in {time.time() - t_start:.0f}s")


if __name__ == "__main__":
    main()
