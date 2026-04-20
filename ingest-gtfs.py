#!/usr/bin/env python3
"""Streaming GTFS ingester: download → ingest → delete, one feed at a time.

Usage:
  ingest-gtfs.py <schedule.sqlite> --feeds feeds.tsv
  ingest-gtfs.py <schedule.sqlite> --single <slug> <url>

feeds.tsv format (tab-separated): slug <TAB> url <TAB> optional_name

Resumable: skips any slug already in feed_meta. Failed downloads are logged
and skipped; rerun to retry. Peak disk usage is bounded by the largest
single GTFS zip (~100-300 MB for major metros).
"""
import argparse
import os
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


BUILD_SCRIPT = pathlib.Path(__file__).parent / "build-schedule-db.py"
VALIDATE_SCRIPT = pathlib.Path(__file__).parent / "validate-gtfs.py"


def read_feeds_tsv(path):
    feeds = []
    with open(path, encoding="utf-8") as f:
        for line_no, raw in enumerate(f, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 2:
                sys.stderr.write(f"  skip line {line_no}: need <slug>\\t<url> got {line!r}\n")
                continue
            slug = parts[0].strip()
            url = parts[1].strip()
            name = parts[2].strip() if len(parts) > 2 else ""
            if slug and url:
                feeds.append((slug, url, name))
    return feeds


def already_ingested(db_path, slug):
    if not os.path.exists(db_path):
        return False
    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
        try:
            row = conn.execute(
                "SELECT 1 FROM feed_meta WHERE slug=?", (slug,)
            ).fetchone()
            return row is not None
        except sqlite3.OperationalError:
            return False  # table may not exist yet


def download(url, dest):
    """Stream download into dest. Raises on failure."""
    req = urllib.request.Request(url, headers={"User-Agent": "creature-collect/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        with open(dest, "wb") as f:
            shutil.copyfileobj(resp, f, length=1024 * 1024)


def ingest_one(db_path, slug, url, name, tmp_root, skip_validate=False):
    if already_ingested(db_path, slug):
        sys.stderr.write(f"[skip] {slug} already ingested\n")
        return "skipped"
    label = f"{slug}" + (f" ({name})" if name else "")
    sys.stderr.write(f"[fetch] {label}\n"); sys.stderr.flush()
    t0 = time.time()

    with tempfile.NamedTemporaryFile(
        suffix=".zip", dir=tmp_root, delete=False
    ) as tmp:
        tmp_path = tmp.name
    try:
        try:
            download(url, tmp_path)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            sys.stderr.write(f"[fail] {label}: download error {e}\n")
            return "download_failed"
        zip_size = os.path.getsize(tmp_path)
        sys.stderr.write(
            f"[validate] {label}  ({zip_size / 1024 / 1024:.1f} MB, "
            f"{time.time() - t0:.1f}s download)\n"
        )
        if not skip_validate:
            vproc = subprocess.run(
                [sys.executable, str(VALIDATE_SCRIPT), tmp_path],
                stderr=subprocess.STDOUT,
                stdout=subprocess.PIPE,
            )
            sys.stderr.write(vproc.stdout.decode("utf-8", errors="replace"))
            if vproc.returncode >= 2:
                sys.stderr.write(f"[fail] {label}: validation errors — skipping. "
                                 f"Pass --skip-validate to force ingest anyway.\n")
                return "validation_failed"
        sys.stderr.write(f"[ingest] {label}\n"); sys.stderr.flush()
        proc = subprocess.run(
            [sys.executable, str(BUILD_SCRIPT), slug, tmp_path, db_path],
            stderr=subprocess.STDOUT,
            stdout=subprocess.PIPE,
        )
        sys.stderr.write(proc.stdout.decode("utf-8", errors="replace"))
        sys.stderr.flush()
        if proc.returncode != 0:
            sys.stderr.write(f"[fail] {label}: build exited {proc.returncode}\n")
            return "ingest_failed"
        with sqlite3.connect(db_path) as conn:
            conn.execute("UPDATE feed_meta SET url=? WHERE slug=?", (url, slug))
            conn.commit()
        return "ok"
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def main():
    ap = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("schedule_db")
    ap.add_argument("--feeds", help="tab-separated file of slug<TAB>url<TAB>[name]")
    ap.add_argument("--single", nargs=2, metavar=("SLUG", "URL"),
                    help="ingest one feed directly")
    ap.add_argument("--tmp", default=None, help="temp directory for zip downloads")
    ap.add_argument("--skip-validate", action="store_true",
                    help="skip format validation before ingesting")
    args = ap.parse_args()

    if not args.feeds and not args.single:
        ap.error("need --feeds FILE or --single SLUG URL")

    feeds = []
    if args.single:
        feeds.append((args.single[0], args.single[1], ""))
    if args.feeds:
        feeds.extend(read_feeds_tsv(args.feeds))
    if not feeds:
        sys.stderr.write("no feeds to process\n")
        return 1

    tmp_root = args.tmp or tempfile.gettempdir()

    counts = {"ok": 0, "skipped": 0, "download_failed": 0,
              "validation_failed": 0, "ingest_failed": 0}
    for i, (slug, url, name) in enumerate(feeds, 1):
        sys.stderr.write(f"\n=== [{i}/{len(feeds)}] {slug} ===\n")
        try:
            result = ingest_one(args.schedule_db, slug, url, name, tmp_root,
                                skip_validate=args.skip_validate)
        except KeyboardInterrupt:
            sys.stderr.write("interrupted\n")
            break
        except Exception as e:
            sys.stderr.write(f"[fail] {slug}: unexpected error {e}\n")
            result = "ingest_failed"
        counts[result] = counts.get(result, 0) + 1

    sys.stderr.write(
        f"\n=== done: ok={counts['ok']}, skipped={counts['skipped']}, "
        f"download_failed={counts['download_failed']}, "
        f"validation_failed={counts['validation_failed']}, "
        f"ingest_failed={counts['ingest_failed']} ===\n"
    )
    bad = counts["download_failed"] + counts["validation_failed"] + counts["ingest_failed"]
    return 0 if bad == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
