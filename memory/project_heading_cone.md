---
name: project_heading_cone
description: User-location facing cone is custom because vendored MapLibre has no heading support
metadata:
  type: project
---

The player dot's facing cone (the GPS "which way am I looking" wedge) is a **custom** child element, not MapLibre's built-in. The vendored `static/vendor/maplibre-gl.js` build ships **no heading indicator at all** — no `maplibregl-user-location-heading` class, no `deviceorientation` handling — so `showUserHeading: true` on the `GeolocateControl` (index.html ~line 6380) is a silent no-op. Don't "just enable showUserHeading"; it does nothing.

**How the cone works** (both in `static/index.html`):
- CSS `.maplibregl-user-location-dot .cc-user-heading` — a conic-gradient wedge, masked to a beam, rotated by the `--cc-heading` custom property.
- JS block "Facing cone on the user-location dot" — appends the element to `geolocate._userLocationDotMarker.getElement()` (falls back to `geolocate._dotElement`), reads the device compass (iOS `webkitCompassHeading`; Android `deviceorientationabsolute` alpha), and sets `--cc-heading = compassHeading - map.getBearing()`. Subtracting bearing keeps it correct when the map is rotated (this app confirms bearing == the compass heading shown at screen-up, per the two-finger-twist code). GPS `coords.heading` is a fallback only while moving and only until the first compass reading.
- iOS 13+ needs `DeviceOrientationEvent.requestPermission()` from a user gesture — hooked to the first `pointerdown`.

Related: [[project_freeze_diagnosis]] (other map/main-thread work).
