---
title: Fix GPS being weird on iOS
status: done
claimed_by: claude-opus
created: 2026-07-13T18:30:35Z
updated: 2026-07-13T19:20:00Z
---

## Description
Checkout OpenStreetmap code into temp directory and see how they configure the GPS and use the same settings.

Symptom: GPS "being weird on iOS" (dot not appearing / stuck, no feedback).

## Progress
- (2026-07-13) Mapped the app's geolocation architecture. Two independent
  `watchPosition` streams run at once:
  1. MapLibre `GeolocateControl` (drives the blue dot) — `static/index.html`.
  2. `startLocationWatch()` in `static/creatures.js` (drives spawns + daycare
     distance).
  Plus a permission-priming `getCurrentPosition` and a Capacitor bridge that
  routes both through `@capacitor/geolocation` (iOS) / `BackgroundLocation`
  (Android). Marker interpolation already smooths iOS "burst" fixes.
- (2026-07-13) Sparse-cloned `openstreetmap/openstreetmap-website` into
  `/tmp/osm-website`. Findings on how OSM configures GPS:
  - Main slippy map uses the Leaflet **locatecontrol** plugin
    (`leaflet.locate.js` → `L.control.locate`). The plugin's `locateOptions`
    default is `{ maxZoom: Infinity, watch: true, setView: false }` and leaves
    `enableHighAccuracy`/`maximumAge` unset — so Leaflet core merges in
    **`timeout: 10000`** and passes it to `watchPosition`. Net effective
    options: `enableHighAccuracy:false, maximumAge:0, timeout:10000`.
  - Newer non-map pages use a MapLibre `GeolocateControl` subclass
    (`maplibre/controls.js`) with `positionOptions:{ enableHighAccuracy:true }`.
    MapLibre's own default positionOptions is
    `{ enableHighAccuracy:false, maximumAge:0, timeout:6000 }`.
  - **Common thread: OSM always runs geolocation with a bounded `timeout`.**
- (2026-07-13) Root cause found. **Both** of our watches run with **no
  `timeout`** (effectively Infinity):
  - Verified in the vendored `static/vendor/maplibre-gl.js` that
    `GeolocateControl` does `this.options = extend({}, defaults, opts)` — a
    *shallow* merge. Our `positionOptions:{ enableHighAccuracy:true }` therefore
    **replaces** MapLibre's default positionOptions wholesale, silently dropping
    its `timeout:6000`.
  - `creatures.js` watch set `{ enableHighAccuracy:true, maximumAge:0 }` — no
    timeout either.
  - With Infinity timeout, a slow/blocked iOS high-accuracy lock leaves
    `watchPosition` hung: neither success nor error ever fires → dot stuck,
    spawns never load, GeolocateControl spins in "waiting" forever. This is the
    "GPS weird on iOS" symptom.
- (2026-07-13) Confirmed adding a timeout is safe for the MapLibre control:
  read `_onError` in the vendored bundle — it only tears down the watch on
  `error.code===1` (PERMISSION_DENIED). A `code===3` (TIMEOUT) just calls
  `_setErrorState()`, which flips a CSS class and is cleared by the next
  successful fix; it never clears the watch or hides the dot.
- (2026-07-13) Sanity-checked the approach against the local companion model —
  it independently confirmed the "silent hang without timeout" as the #1 iOS
  cause and flagged the same secondary items (two simultaneous watches;
  `maximumAge:0` strictness).
- (2026-07-13) Implemented + guarded (see Writeup). New test passes; nearby
  `focus-mode-locks` and `egg-ready-bubble` tests still green.

## Writeup

### What changed
Mirrored OSM's one consistent geolocation setting — a **bounded `timeout`** —
onto both of our location watches (10s, matching OSM's Leaflet locate control):

1. `static/index.html` — MapLibre `GeolocateControl.positionOptions`:
   `{ enableHighAccuracy: true }` → `{ enableHighAccuracy: true, maximumAge: 0,
   timeout: 10000 }`. This restores the `timeout`/`maximumAge` that our
   override had silently clobbered off MapLibre's default.
2. `static/creatures.js` — `startLocationWatch()` watch options:
   `{ enableHighAccuracy: true, maximumAge: 0 }` →
   `{ ..., timeout: 10000 }`. Also fleshed out the previously-empty error
   callback's comment (it stays non-fatal; the watch keeps running so a later
   fix still flows through).
3. `tests/geolocation-timeout.test.js` — new static-source regression guard
   asserting both option literals declare `enableHighAccuracy:true` and a
   finite, positive `timeout <= 60000`. Added because this bug is invisible at
   runtime and was *already* introduced once (the clobbered MapLibre default).

### Why this is the right "mirror OSM" fix
OSM's locate button — the most battle-tested "where am I" control on the web —
always runs `watchPosition` with a timeout (10000 via Leaflet, 6000 via
MapLibre default). Ours ran with none. A timeout is pure upside here: outdoors
with signal, fixes land in well under 10s so it never trips; indoors / cold
start / blocked, it converts a silent perpetual "waiting" into a surfaced
error path (and, for the dot, MapLibre's built-in error styling) while the
watch keeps trying. It does **not** reduce accuracy — `enableHighAccuracy:true`
is kept because a walking game needs GPS-grade fixes (OSM's map uses `false`,
but that's a slippy-map pan aid, not a location game).

### What I deliberately did NOT change
- **`maximumAge: 0`** was left as-is. A previous instance set it deliberately
  and documented why (a non-zero value was making the GPS look like it
  "refreshes every few seconds"; smoothing is handled by the marker
  interpolation in index.html). OSM is effectively `maximumAge:0` too (browser
  default), so it's not part of the OSM mirror. The local model suggested
  bumping it to ~3000 to let iOS snap to a recent cached fix instead of blocking
  for a brand-new one — a plausible tweak, but it reverses a documented decision
  and isn't justified by the OSM comparison, so I left it for a future,
  device-tested call.

### Honesty / limitations
- **Not verified on a physical iOS device** — I can't run the iPhone build from
  here. The change is reasoned from the vendored MapLibre source, the OSM
  reference config, and the W3C geolocation semantics, and is guarded by a unit
  test, but the real-world "does the dot behave better" confirmation needs a
  device walk-test by the human.
- The `timeout` is honored by the WebKit/Safari-PWA path and the browser path
  for sure. On the Capacitor-wrapped iOS build it's forwarded to
  `@capacitor/geolocation`'s `watchPosition`; older plugin versions implement
  per-fix timeout less strictly for watches than for `getCurrentPosition`, so
  the benefit there may be partial. It is not harmful in any case.

### Recommended follow-ups (not done — bigger/riskier than this task)
1. **Consolidate to a single `watchPosition`.** We run two high-accuracy
   watches at once (GeolocateControl + creatures.js). A shared location
   singleton that fans one stream out to both consumers would halve GPS churn
   and remove any bridge-throttling/race risk. This is a real refactor (the
   GeolocateControl owns its own watch internally), so it deserves its own task.
2. **Timeout fallback to coarse accuracy.** On a timeout error, optionally retry
   once with `enableHighAccuracy:false` to at least place the user roughly
   before giving up.
3. Revisit `maximumAge` on-device (see above).
