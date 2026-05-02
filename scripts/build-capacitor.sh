#!/usr/bin/env bash
# Build the Capacitor webDir (`dist/`) for bundled-asset native apps.
#
# In server-url mode the IPA's WebView simply loaded the live Flask
# site. In bundled mode we have to lay out a directory whose paths
# match every absolute URL the client expects — Flask routes don't
# exist inside the IPA, so anything that's normally served by Flask
# from a non-static path has to be physically present at that path.
#
# Layout produced:
#   dist/index.html               ← entry, served by Capacitor as `/`
#   dist/sw.js                    ← service worker (registered as /sw.js)
#   dist/manifest.webmanifest     ← PWA manifest (Flask serves it at /)
#   dist/static/*                 ← everything in static/ (sprites.js, vendor/, …)
#   dist/bundled-data/*           ← entire data/BundledData/ tree
#   dist/icons/*                  ← img <src="/icons/X.svg"> targets
#   dist/fonts/*                  ← MapLibre font ranges (.pbf)
#   dist/tiles/*                  ← z0..z5 base map tiles
#
# The /icons /fonts /tiles trees come from data/BundledData/ — the
# build-bundled-data.py script already extracted them into the right
# shape, we just expose them at the URL paths the client + SW expect.
#
# Run this from the repo root before `npx cap sync` so the iOS/
# Android project picks up the latest static + bundled data.

set -euo pipefail

DIST="${1:-dist}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -d static ]; then
  echo "ERROR: static/ not found in $REPO_ROOT" >&2
  exit 1
fi
if [ ! -d data/BundledData ]; then
  echo "ERROR: data/BundledData/ not found — run build-bundled-data.py first" >&2
  exit 1
fi

rm -rf "$DIST"
mkdir -p "$DIST/static" "$DIST/bundled-data"

# Root-level entry points. index.html and sw.js are referenced as
# absolute root paths by the client, so they live at webDir root.
cp static/index.html "$DIST/index.html"
cp static/sw.js "$DIST/sw.js"
[ -f static/manifest.webmanifest ] && cp static/manifest.webmanifest "$DIST/manifest.webmanifest"

# The full static tree under /static. We keep the duplicated index.html
# / sw.js inside /static too so any code that happens to reference the
# /static/-prefixed path still works (run.py does, for the version
# stamping check).
cp -R static/. "$DIST/static/"

# The full BundledData tree at /bundled-data.
cp -R data/BundledData/. "$DIST/bundled-data/"

# /icons, /fonts, /tiles are aliases of subtrees inside BundledData.
# The client's <img src="/icons/X.svg"> + MapLibre's /fonts/ + tile
# requests need them at these short paths. Hard copy (instead of
# symlink) for cross-platform Capacitor packaging.
[ -d data/BundledData/icons ] && cp -R data/BundledData/icons "$DIST/icons"
[ -d data/BundledData/fonts ] && cp -R data/BundledData/fonts "$DIST/fonts"
[ -d data/BundledData/tiles ] && cp -R data/BundledData/tiles "$DIST/tiles"

echo "Built $(du -sh "$DIST" | cut -f1) at $DIST/"
echo "  - $(find "$DIST/static" -type f 2>/dev/null | wc -l) static files"
echo "  - $(find "$DIST/bundled-data" -type f 2>/dev/null | wc -l) bundled-data files"
echo "  - $(find "$DIST/tiles" -type f 2>/dev/null | wc -l) tile files"
echo "  - $(find "$DIST/icons" -type f 2>/dev/null | wc -l) icon files"
echo "  - $(find "$DIST/fonts" -type f 2>/dev/null | wc -l) font files"
