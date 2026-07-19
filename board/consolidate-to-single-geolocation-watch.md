---
title: Consolidate to a single geolocation watch
status: done
claimed_by: claude-opus
created: 2026-07-13T19:25:00Z
updated: 2026-07-13T20:30:00Z
taiga_id: 73
taiga_version: 1
synced_hash: 4cbe9b59547e3104
---

## Description
The app currently runs **two** simultaneous `navigator.geolocation.watchPosition`
streams, both `enableHighAccuracy:true`:

1. MapLibre `GeolocateControl` (blue dot) — internal watch, `static/index.html`.
2. `startLocationWatch()` (spawns + daycare distance) — `static/creatures.js`.

Two independent high-accuracy watches double the GPS radio churn and, on iOS
via the Capacitor bridge, invite callback-starvation / throttling races between
the two consumers (surfaced while investigating "GPS being weird on iOS").

"Done" = one location source (a small singleton) that watches once and fans the
fixes out to both the dot and the game logic, with no behavioural regression to
the marker interpolation, first-fix accuracy gate, or daycare distance
accumulation.

Notes / gotchas:
- The MapLibre GeolocateControl owns its watch internally and drives its own
  button state machine + marker; feeding it externally means either subclassing
  it or letting IT be the single source and having creatures.js subscribe to its
  `geolocate` event instead of running its own watch. The latter is likely
  simpler and lower-risk.
- Preserve the `timeout:10000` added in the "Fix GPS being weird on iOS" task.
- Keep the Capacitor bridge monkey-patch behaviour intact.

## Progress
- (2026-07-13) Mapped both watches + the index.html↔creatures.js bridge.
  GeolocateControl is a `const` in index.html's map scope; creatures.js only
  gets `map` (via `attachSpawnOverlay(map)`) and talks back through
  `window.Creatures` (already used for the pedometer/fitness bridge). So the
  natural wiring is: index.html pushes fixes into a new `Creatures.onLocationFix`.
- (2026-07-13) Settled the two risks the task flagged, from the *vendored*
  maplibre source (`static/vendor/maplibre-gl.js`), not guesswork:
  - **Event payload** — the control fires `new Event("geolocate", position)`;
    Event's ctor does a `for…in` extend (`g(this,e)`), which copies `coords`
    AND `timestamp` (both enumerable on the real `GeolocationPosition` and on
    the Capacitor plain-object path). The shipped focus-follow handler already
    reads `e.coords.latitude`, proving `e.coords` flows; `onLocationFix` also
    uses `pos.timestamp || Date.now()` defensively.
  - **Can the watch stop?** Yes — `trigger()` from any active state → `OFF`
    clears the internal watch. The native geolocate button is NOT hidden by
    CSS, so it's reachable. Decided (and confirmed with the companion model)
    that "tracking OFF ⇒ spawns/daycare pause on last fix" is correct, not a
    regression: it matches the dot vanishing, and one tap back ON resumes.
- (2026-07-13) Verified no `maxBounds` on the map (so MapLibre never swaps the
  `geolocate` event for `outofmaxbounds`) and that the single surviving watch
  keeps the exact options creatures.js used (`enableHighAccuracy:true,
  maximumAge:0, timeout:10000`) → identical fix cadence/freshness, no stream
  regression.
- (2026-07-13) Implemented + tested. All 3 GPS/focus/egg tests green; full
  suite green except a pre-existing, unrelated `trip-planner.test.js`
  (`groupLegs` — fails identically on clean HEAD, verified by stashing).

## Writeup

### What changed (single OS-level watch)
The app now runs **exactly one** geolocation watch — MapLibre's
`GeolocateControl` (the blue dot), in `static/index.html`. `creatures.js` no
longer opens its own second `navigator.geolocation.watchPosition`; it
subscribes to the control's stream instead.

1. **`static/creatures.js`**
   - Deleted the `watchPosition` in `startLocationWatch()`. It now just *arms*
     the module to accept fixes (sets `_geoListening = true` and starts the
     first-fix accuracy-gate clock). Renamed the dead `_geoWatchId` state var
     to `_geoListening`.
   - Added **`onLocationFix(pos)`** — the former watch-success body, verbatim:
     the first-fix accuracy gate (skip >50 m for the first 5 s), coordinate
     update, `_accumulateDaycareDistance(...)`, and `refreshSpawnOverlay()`.
     No-ops unless attached + listening, so its lifetime matches the old
     watch's attach/detach exactly.
   - `stopLocationWatch()` no longer calls `clearWatch` (there's no OS watch to
     clear); it clears `_geoListening` + last position + deadline.
   - Exposed `onLocationFix` on the `window.Creatures` public API (next to the
     fitness bridge).
2. **`static/index.html`** — added one `geolocate.on('geolocate', e => …)`
   handler that forwards each fix into `window.Creatures.onLocationFix(e)`
   (guarded + try/caught, non-fatal). Placed right after the existing
   focus-follow `geolocate` handler. `Creatures.install(map)` runs before the
   control is created/triggered, so arming precedes the first fix.
3. **`tests/geolocation-timeout.test.js`** — part 1 (GeolocateControl keeps
   `enableHighAccuracy:true` + a bounded `timeout`) is unchanged; that control
   is now the *sole* watch, so the timeout guard matters more than ever. Part 2
   was rewritten from "creatures.js watch has a timeout" to the **single-watch
   invariant**: creatures.js must NOT contain `navigator.geolocation.watchPosition`,
   must `define onLocationFix`, must expose it on the public API, and index.html
   must forward into it. (Had to reword one creatures.js comment that literally
   contained `navigator.geolocation.watchPosition` so the guard tests behaviour,
   not prose.)

### Why this direction
The GeolocateControl owns its watch deeply (marker, camera, heading cone,
focus-follow, auto-activation monkey-patch, state machine). creatures.js's watch
was simple and self-contained. So going 2→1 by *removing the creatures watch*
and subscribing to the control's `geolocate` event — exactly what the task
recommended — is far lower-risk than feeding the control externally (which would
mean subclassing it or poking private methods). The surviving watch keeps the
identical options creatures.js used, so the fix stream (cadence, freshness,
accuracy) is unchanged.

### Behavioural notes / assumptions
- **Tracking OFF pauses the game.** If the user taps the native geolocate
  button to OFF, the single watch stops and spawns + daycare distance freeze on
  the last fix until they re-enable it. This is a deliberate, defensible change
  (it matches the dot disappearing; today's second watch keeps silently moving
  spawns around a frozen position, which is arguably the buggier behaviour). If
  we ever decide gameplay must persist through tracking-OFF, the follow-up is a
  standalone `LocationService` singleton both the control and creatures.js
  subscribe to — **not** re-adding a second watch.
- **daycare accumulation** now happens whenever `onLocationFix` runs while
  attached — the same condition as the old watch (which started/stopped with
  attach/detach), so no accounting change.

### Honesty / limitations
- **Not device-verified on iOS.** Reasoned from the vendored MapLibre source,
  the W3C geolocation semantics, and the existing (working) focus-follow
  handler that already consumes the same `geolocate` event. Needs a real
  iPhone walk-test to confirm the churn/race reduction in practice — same
  caveat the timeout fix carried.
- On the Capacitor iOS build the single watch flows through the same
  `@capacitor/geolocation` shim as before; consolidation strictly *reduces* the
  number of concurrent bridge watch subscriptions from 2 to 1, which is the win.
