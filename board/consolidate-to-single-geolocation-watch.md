---
title: Consolidate to a single geolocation watch
status: todo
claimed_by:
created: 2026-07-13T19:25:00Z
updated: 2026-07-13T19:25:00Z
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

## Writeup
