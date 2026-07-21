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

# Stamp the bundle-id sentinel in index.html. The inline boot script
# in <head> reads `<meta name="cc-bundle-id">`, compares against
# localStorage["cc.bundleId"], and wipes the bundle-derived caches
# (localStorage species lists + IDB sprite-credit / split-name /
# manifest / cells blobs) when they don't match. Without this stamp
# the sentinel stays `__BUNDLE_ID__` and the boot script no-ops —
# fine for Flask dev, broken for the user-visible APK/IPA paths.
#
# We stamp every build (not just bundled-data changes) — a fresh
# bundle-id forces a wipe on each user-visible release. The wipe is
# cheap (re-fetches a few MB of JSON from the bundle, which is local
# storage on Capacitor) and erring on the side of busting too often
# is much safer than the inverse.
BUNDLE_ID="$(date -u +%Y%m%dT%H%M%SZ)"
if grep -q "__BUNDLE_ID__" "$DIST/index.html"; then
  sed -i.bak "s|__BUNDLE_ID__|$BUNDLE_ID|g" "$DIST/index.html"
  rm -f "$DIST/index.html.bak"
  echo "Stamped bundle-id: $BUNDLE_ID"
else
  echo "WARN: no __BUNDLE_ID__ sentinel found in index.html — cache-bust will no-op for this build" >&2
fi
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

# Stamp tracked JS / HTML files with mtime versions, mirroring what
# run.py does at serve time. Without this, the bundled index.html has
# no `window._serverScriptVersions`, the bundled JS files all have
# literal `SCRIPT_VERSION = 'auto'`, and live-update.js's first-launch
# check sees `cc.installedVersions = {}` vs `latest = {…real values…}`,
# concludes everything is stale, downloads everything, and reloads —
# even when bundled and server are at the same versions. Stamping at
# build time gives the page real versions to seed from.
python3 - <<PY
import json, pathlib, re, time
DIST = pathlib.Path("$DIST")
STATIC_SRC = pathlib.Path("static")
# Keep these in sync with run.py's _TRACKED_JS / _TRACKED_HTML — a file
# tracked by the server but not stamped here reads as "stale" on first
# launch and gets needlessly re-downloaded by the first refresh.
TRACKED_JS = {
    "creatures.js", "sprites.js", "sprite-store.js", "appdata.js",
    "species.js", "spawns.js", "trip-planner.js",
    "live-update.js", "sw.js", "extras.js",
    "extras-apps.js", "extras-almanac.js", "extras-vibration.js",
    "extras-skymap.js", "extras-sudoku.js", "extras-sensors.js",
    "extras-tuner.js", "extras-scapes.js", "extras-todos.js",
}
# Extras mini-app subtrees (Pixel Art, Draw, both fractal viewers) —
# same lists as run.py's _SUBTREE_JS / _SUBTREE_HTML / _SUBTREE_CSS.
SUBTREE_JS = [
    "pixelart/app.js",
    "draw/src/animexport.js", "draw/src/app.js", "draw/src/camera.js",
    "draw/src/commands.js", "draw/src/frieze.js", "draw/src/generators.js",
    "draw/src/gif.js", "draw/src/hat.js", "draw/src/history.js",
    "draw/src/laves.js", "draw/src/minimap.js", "draw/src/penrose.js",
    "draw/src/pixel.js", "draw/src/renderer.js", "draw/src/scene.js",
    "draw/src/spectre.js", "draw/src/storage.js", "draw/src/svg.js",
    "draw/src/uniform.js", "draw/src/util.js", "draw/src/wallpaper.js",
    "fractals2/src/flightRecorder.js", "fractals2/src/main.js",
    "fractals2/src/palette.js", "fractals2/src/pngMetadata.js",
    "fractals2/src/viewer.js", "fractals2/src/worker.js",
    "fractals2/src/gpu/glsl.js", "fractals2/src/gpu/gpu-worker-client.js",
    "fractals2/src/gpu/gpu-worker.js", "fractals2/src/gpu/renderer.js",
    "fractals2/src/gpu/validate.js",
    "fractals2/src/math/bignum.js", "fractals2/src/math/bla.js",
    "fractals2/src/math/naive.js", "fractals2/src/math/perturb.js",
    "fractals2/src/math/reference.js", "fractals2/src/math/render.js",
    "fractals2/src/math/series.js",
    "mandelbrot/favorites.js", "mandelbrot/flightRecorder.js",
    "mandelbrot/fxp.js", "mandelbrot/index.js",
    "mandelbrot/mandelbrotAbsFamily.js",
    "mandelbrot/mandelbrotAbsFamilyPerturbation.js",
    "mandelbrot/mandelbrotBurningShip.js",
    "mandelbrot/mandelbrotBurningShipPerturbation.js",
    "mandelbrot/mandelbrotFloat.js", "mandelbrot/mandelbrotFxP.js",
    "mandelbrot/mandelbrotGyre.js",
    "mandelbrot/mandelbrotGyrePerturbation.js",
    "mandelbrot/mandelbrotKali.js",
    "mandelbrot/mandelbrotKaliPerturbation.js",
    "mandelbrot/mandelbrotLyra.js", "mandelbrot/mandelbrotMirage.js",
    "mandelbrot/mandelbrotMiragePerturbation.js",
    "mandelbrot/mandelbrotMultibrot.js",
    "mandelbrot/mandelbrotMultibrotPerturbation.js",
    "mandelbrot/mandelbrotPerturbation.js",
    "mandelbrot/mandelbrotPerturbationExtFloat.js",
    "mandelbrot/mandelbrotPhoenix.js",
    "mandelbrot/mandelbrotPhoenixPerturbation.js",
    "mandelbrot/mandelbrotTricorn.js",
    "mandelbrot/mandelbrotTricornPerturbation.js",
    "mandelbrot/mandelbrotWebGPU.js", "mandelbrot/palette.js",
    "mandelbrot/pngMetadata.js", "mandelbrot/referencePointProvider.js",
    "mandelbrot/sharedCalculations.js", "mandelbrot/workerContext.js",
    "mandelbrot/worker.js",
]
SUBTREE_HTML = [
    "pixelart/index.html", "draw/index.html",
    "fractals2/index.html", "mandelbrot/index.html",
]
# Version-map only — CSS is never stamped (it has no SCRIPT_VERSION and
# injecting the HTML snippet would corrupt it), but it must be in the
# bundled map or the first refresh would re-download it as "stale".
SUBTREE_CSS = [
    "draw/style.css", "fractals2/styles.css", "mandelbrot/style.css",
]
TRACKED_JS |= set(SUBTREE_JS)
TRACKED_HTML = {"index.html", "dex.html", "synth.html", "quiver.html", *SUBTREE_HTML}
ALL_FILES = sorted(TRACKED_JS | TRACKED_HTML | set(SUBTREE_CSS))
SV_RE = re.compile(r"""((?:const|let|var)\s+)SCRIPT_VERSION\s*=\s*['"]([^'"]+)['"]""")
HEAD_RE = re.compile(r"<head\b[^>]*>", re.IGNORECASE)
def vfor(p):
    try: return time.strftime("%Y-%m-%d %H:%M", time.gmtime(p.stat().st_mtime))
    except OSError: return "unknown"
versions = {n: vfor(STATIC_SRC / n) for n in ALL_FILES if (STATIC_SRC / n).is_file()}
versions_json = json.dumps(versions, separators=(",", ":"))
def stamp_js(text, ver):
    return SV_RE.sub(lambda m: f"{m.group(1)}SCRIPT_VERSION = '{ver}'", text, count=1)
def stamp_html(text, name, ver):
    snippet = (
        f'<script>window._scriptVersions=window._scriptVersions||{{}};'
        f'window._scriptVersions["{name}"]="{ver}";'
        f'window._serverScriptVersions={versions_json};</script>'
    )
    # No <head> (quiver.html): inject after the doctype instead —
    # prepending before it would flip the page into quirks mode.
    m = HEAD_RE.search(text) or re.search(r"<!DOCTYPE[^>]*>", text, re.IGNORECASE)
    if not m: return snippet + text
    return text[:m.end()] + snippet + text[m.end():]
# Stamp every dist copy of every tracked file. Both the root-level
# entry copies (dist/index.html, dist/sw.js) and the /static/ duplicates.
to_stamp = []
for n in ALL_FILES:
    to_stamp.append((DIST / n, n))           # root copy (only if it exists)
    to_stamp.append((DIST / "static" / n, n)) # /static/ copy
count = 0
for path, name in to_stamp:
    if not path.is_file(): continue
    if name not in TRACKED_JS and name not in TRACKED_HTML:
        continue  # CSS: version-map entry only, content left untouched
    text = path.read_text(encoding="utf-8")
    ver = versions.get(name, "unknown")
    out = stamp_js(text, ver) if name in TRACKED_JS else stamp_html(text, name, ver)
    path.write_text(out, encoding="utf-8")
    count += 1
print(f"  - stamped {count} file copies with {len(versions)} version entries")
PY

# Stamp a single-line identifier for THIS bundle build. LocalServer
# reads it at launch and clears any stale liveDir whenever it
# changes — that's how a fresh IPA install detects it should drop
# the previous live-update overlay (which would otherwise mask the
# bundled code with older files from a prior server snapshot).
# Lives at the bundle root and is NEVER in the live-update tracked
# list, so liveDir never has its own copy, and reads always resolve
# to the bundle.
date -u +%Y-%m-%dT%H:%M:%SZ > "$DIST/bundle-id.txt"

# Static fallback for the refresh button's JS-free escape hatch.
# The button is rendered as `<a href="/__refresh__.html">` so the
# browser's default link-navigation kicks in if the inline onclick
# JS fails for any reason. Per platform:
#   * iOS: LocalServer.swift intercepts /__refresh__.html, clears
#     any stale liveDir overlay, and redirects to /.
#   * Web (Flask): a /__refresh__.html route 302s to /.
#   * Android: no native interceptor exists, so the WebView's asset
#     loader serves THIS static file. The meta-refresh + manual
#     `<a href="/">` link both reload the bundled root, putting the
#     user back into the working app state. (Android has no liveDir
#     to clear — every code update arrives via a fresh APK install,
#     which already starts from clean state.)
# Kept tiny + JS-free so it works even when the rest of the app's
# JS has crashed during init.
cat > "$DIST/__refresh__.html" <<'HTML'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=/">
<title>Refreshing…</title>
</head>
<body>
<p>Refreshing… <a href="/">tap here</a> if this page does not redirect.</p>
</body>
</html>
HTML

echo "Built $(du -sh "$DIST" | cut -f1) at $DIST/"
echo "  - $(find "$DIST/static" -type f 2>/dev/null | wc -l) static files"
echo "  - $(find "$DIST/bundled-data" -type f 2>/dev/null | wc -l) bundled-data files"
echo "  - $(find "$DIST/tiles" -type f 2>/dev/null | wc -l) tile files"
echo "  - $(find "$DIST/icons" -type f 2>/dev/null | wc -l) icon files"
echo "  - $(find "$DIST/fonts" -type f 2>/dev/null | wc -l) font files"
