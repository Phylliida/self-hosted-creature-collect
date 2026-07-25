#!/bin/sh
# Refresh the Eugene housing site end-to-end:
#   scrape (zendriver) -> parse -> geocode -> bus times -> groceries -> build index.html
# Safe to re-run any time. Blocked sources (Cloudflare etc.) are skipped with a warning.
# Usage: ./refresh.sh [--skip-scrape]
set -u
cd "$(dirname "$0")"

if [ "${1:-}" != "--skip-scrape" ]; then
    echo "== scrape =="
    .venv/bin/python scrape.py
fi

echo "== parse =="
python3 parse.py || exit 1

echo "== geocode =="
python3 geocode.py || exit 1

echo "== bus times (LTD GTFS) =="
python3 bustime.py || exit 1

echo "== groceries & laundromats =="
python3 groceries.py || exit 1

echo "== build site =="
python3 build_site.py || exit 1

echo "done -> index.html"
