#!/usr/bin/env python3
"""Filter the Mobility Database catalog to a country and emit a feeds.tsv.

Usage: get-gtfs-catalog.py --country CA [--output feeds-ca.tsv] [--catalog PATH]
       [--use-latest]

The --use-latest flag writes Mobility Database's mirror URL (urls.latest)
instead of the direct agency URL (urls.direct_download). The MD mirror is
stabler but adds indirection.
"""
import argparse
import sys

from gtfs_catalog import (DEFAULT_CATALOG_URL, entries_from_catalog,
                          fetch_catalog)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--country", required=True,
                    help="ISO 3166-1 alpha-2 code, e.g. CA, US, GB")
    ap.add_argument("--output", default="-",
                    help="output file (default stdout)")
    ap.add_argument("--catalog", default=DEFAULT_CATALOG_URL,
                    help="catalog CSV URL or local path")
    ap.add_argument("--use-latest", action="store_true",
                    help="prefer urls.latest (MD mirror) over urls.direct_download")
    ap.add_argument("--include-auth", action="store_true",
                    help="include feeds that require API keys (default: skip)")
    ap.add_argument("--include-inactive-mirror", action="store_true",
                    help="include inactive feeds when the MD mirror still serves them "
                         "(e.g. Lane Transit District mdb-131, marked inactive only "
                         "because the agency's direct URL died)")
    args = ap.parse_args()

    text = fetch_catalog(args.catalog)
    kept = entries_from_catalog(
        text, args.country, use_latest=args.use_latest,
        include_auth=args.include_auth,
        include_inactive_mirror=args.include_inactive_mirror)

    out = sys.stdout if args.output == "-" else open(args.output, "w", encoding="utf-8")
    try:
        for slug, url, name, fallback in kept:
            # TSV: slug <TAB> url <TAB> name <TAB> fallback_url (MD mirror).
            # ingest-gtfs.py retries with the fallback when the direct URL
            # returns a non-zip body or an HTTP error.
            out.write(f"{slug}\t{url}\t{name}\t{fallback}\n")
    finally:
        if out is not sys.stdout: out.close()
    sys.stderr.write(f"wrote {len(kept)} feeds for country={args.country}\n")


if __name__ == "__main__":
    main()
