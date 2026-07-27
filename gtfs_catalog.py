#!/usr/bin/env python3
"""Shared Mobility Database catalog access: fetch the catalog CSV, filter it
to a country's GTFS feeds, and read/write the feeds-*.tsv files consumed by
ingest-gtfs.py. Used by get-gtfs-catalog.py (CLI) and
update-transit-schedules.py (automatic TSV refresh before each rebuild).
"""
import csv
import sys
import urllib.request

DEFAULT_CATALOG_URL = "https://files.mobilitydatabase.org/feeds_v2.csv"


def fetch_catalog(url_or_path):
    if url_or_path.startswith(("http://", "https://")):
        sys.stderr.write(f"fetching catalog from {url_or_path}\n")
        with urllib.request.urlopen(url_or_path, timeout=180) as resp:
            return resp.read().decode("utf-8-sig")
    with open(url_or_path, encoding="utf-8-sig") as f:
        return f.read()


def entries_from_catalog(text, country, use_latest=False, include_auth=False,
                         include_inactive_mirror=False):
    """Filter catalog CSV text to one country's GTFS feeds.
    Returns [(slug, url, name, fallback_url)] in catalog order."""
    reader = csv.DictReader(text.splitlines())
    kept = []
    for row in reader:
        if row.get("location.country_code") != country: continue
        if row.get("data_type") != "gtfs": continue
        if row.get("redirect.id"): continue
        auth = row.get("urls.authentication_type") or "0"
        if auth != "0" and not include_auth: continue
        direct = (row.get("urls.direct_download") or "").strip()
        latest = (row.get("urls.latest") or "").strip()
        # Inactive feeds are skipped unless include_inactive_mirror is set
        # and the MD mirror still serves them — some agencies (e.g. Lane
        # Transit District, mdb-131) are marked inactive only because their
        # direct URL died; the mirror keeps the last known feed.
        if row.get("status") != "active" and not (include_inactive_mirror and latest): continue
        if use_latest:
            url, fallback = latest or direct, ""
        else:
            url, fallback = direct or latest, latest if direct and latest and latest != direct else ""
        if not url: continue
        slug = row.get("id", "").strip()
        if not slug: continue
        provider = (row.get("provider") or "").strip()
        subdiv = (row.get("location.subdivision_name") or "").strip()
        muni = (row.get("location.municipality") or "").strip()
        label_parts = [p for p in (provider, muni, subdiv) if p]
        name = " / ".join(label_parts) or slug
        kept.append((slug, url, name, fallback))
    return kept


def read_feeds_tsv(path):
    """Parse a feeds TSV into [(slug, url, name, fallback)], skipping blanks
    and comments. Mirrors ingest-gtfs.py's parser."""
    feeds = []
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            slug, url = parts[0].strip(), parts[1].strip()
            name = parts[2].strip() if len(parts) > 2 else ""
            fallback = parts[3].strip() if len(parts) > 3 else ""
            if slug and url:
                feeds.append((slug, url, name, fallback))
    return feeds


def write_feeds_tsv(path, feeds):
    with open(path, "w", encoding="utf-8") as f:
        for slug, url, name, fallback in feeds:
            f.write(f"{slug}\t{url}\t{name}\t{fallback}\n")
