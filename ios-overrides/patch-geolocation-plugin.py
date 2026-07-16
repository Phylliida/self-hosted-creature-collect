#!/usr/bin/env python3
"""Patch @capacitor/geolocation's iOS plugin source in node_modules.

The stock plugin (identical in v6 and v7) misuses CoreLocation in four
ways that made the GPS dot jump around / go quiet on iOS:

  1. reportLocation() resolves `locations.first` — but CoreLocation
     batches are ordered oldest→newest (Apple docs), so whenever
     delivery batches (e.g. after a main-thread stall) it re-reports
     the STALEST fix and throws the fresh ones away. The dot lags and
     can jump backwards. → `locations.last`.
  2. One shared CLLocationManager serves every call, and
     getCurrentPosition({enableHighAccuracy:false}) sets its
     desiredAccuracy to kCLLocationAccuracyThreeKilometers — silently
     downgrading a live watch to cell-tower fixes. → while a watch is
     streaming, one-shots leave the manager untouched and resolve from
     the stream's next fix (didUpdateLocations already resolves every
     queued singleUpdate call on each update). This also stops mixing
     requestLocation() into an active startUpdatingLocation(), which
     Apple documents as unsupported.
  3. Watches run at kCLLocationAccuracyBestForNavigation — meant for
     plugged-in vehicle navigation. → kCLLocationAccuracyBest, the
     pedestrian setting.
  4. Default pausesLocationUpdatesAutomatically=true lets CoreLocation
     silently stop the stream when the user loiters (GPS "goes quiet"
     until relaunch). → false, plus activityType = .fitness.
     distanceFilter deliberately stays kCLDistanceFilterNone so the
     stream ticks ~1 Hz even when stationary — queued one-shots (fix 2)
     and daycare distance both rely on continuous delivery; stationary
     wobble is smoothed on the JS side (dot easing + stale/out-of-order
     guards in static/index.html).

Known leftover (intentionally unpatched, one-time and self-healing):
didChangeAuthorization can still fire requestLocation() next to
startUpdatingLocation() on the very first permission grant.

Run by .github/workflows/ios-build.yml right after `npm ci`, BEFORE
`cap sync ios` runs `pod install` — the plugin is a development pod
compiled straight out of node_modules, so editing the source there is
sufficient and survives every later pod install.

Anchors match @capacitor/geolocation 6.1.1 byte-for-byte. If an anchor
is missing or ambiguous (plugin upgraded / reshaped), this script exits
non-zero so CI fails loudly instead of shipping an unpatched IPA.
Re-running on a patched tree is a no-op (marker check).
"""
import glob
import sys

MARKER = "// [creature-collect] patched by ios-overrides/patch-geolocation-plugin.py"


def fail(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    print("       Plugin source no longer matches the anchored 6.1.1 shape.",
          file=sys.stderr)
    print("       Re-derive the patch against the new source (see this "
          "script's docstring for the rationale of each change).",
          file=sys.stderr)
    sys.exit(1)


candidates = [
    p for p in glob.glob(
        "node_modules/@capacitor/geolocation/ios/**/GeolocationPlugin.swift",
        recursive=True)
    if "/Tests/" not in p
]
if len(candidates) != 1:
    fail(f"expected exactly one GeolocationPlugin.swift, found {candidates}")
path = candidates[0]

with open(path, encoding="utf-8") as f:
    src = f.read()

if MARKER in src:
    print(f"already patched: {path}")
    sys.exit(0)

PATCHES = [
    (
        "marker",
        "import Capacitor\n",
        "import Capacitor\n\n"
        + MARKER + "\n"
        "// (do not hand-edit; see that script for the full rationale)\n",
    ),
    (
        "getCurrentPosition: don't reconfigure the shared manager under a live watch",
        """    @objc func getCurrentPosition(_ call: CAPPluginCall) {
        bridge?.saveCall(call)
        callQueue[call.callbackId] = .singleUpdate

        DispatchQueue.main.async {
            self.locationManager.delegate = self

            if call.getBool("enableHighAccuracy", false) == true {
                self.locationManager.desiredAccuracy = kCLLocationAccuracyBest
            } else {
                self.locationManager.desiredAccuracy = kCLLocationAccuracyThreeKilometers
            }

            if CLLocationManager.authorizationStatus() == .notDetermined {
                self.locationManager.requestWhenInUseAuthorization()
            } else {
                self.locationManager.requestLocation()
            }
        }
    }
""",
        """    @objc func getCurrentPosition(_ call: CAPPluginCall) {
        bridge?.saveCall(call)
        callQueue[call.callbackId] = .singleUpdate

        DispatchQueue.main.async {
            self.locationManager.delegate = self

            // [creature-collect] One-shots share this CLLocationManager with
            // any live watch. Reconfiguring desiredAccuracy here (stock
            // behavior) silently downgrades the running watch — with
            // enableHighAccuracy:false it drops to 3 km cell-tower fixes.
            // While a watch streams, leave the manager alone entirely: the
            // queued singleUpdate call resolves on the stream's next fix in
            // didUpdateLocations. (Apple also documents requestLocation()
            // as unsupported while startUpdatingLocation() is active.)
            if !self.isUpdatingLocation {
                if call.getBool("enableHighAccuracy", false) == true {
                    self.locationManager.desiredAccuracy = kCLLocationAccuracyBest
                } else {
                    self.locationManager.desiredAccuracy = kCLLocationAccuracyThreeKilometers
                }
            }

            if CLLocationManager.authorizationStatus() == .notDetermined {
                self.locationManager.requestWhenInUseAuthorization()
            } else if !self.isUpdatingLocation {
                self.locationManager.requestLocation()
            }
        }
    }
""",
    ),
    (
        "watchPosition: pedestrian accuracy + never auto-pause the stream",
        """            if call.getBool("enableHighAccuracy", false) == true {
                self.locationManager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
            } else {
                self.locationManager.desiredAccuracy = kCLLocationAccuracyThreeKilometers
            }
""",
        """            // [creature-collect] Best, not BestForNavigation: the latter is
            // meant for plugged-in vehicle navigation and maximizes raw-fix
            // chatter; Best is the pedestrian setting.
            if call.getBool("enableHighAccuracy", false) == true {
                self.locationManager.desiredAccuracy = kCLLocationAccuracyBest
            } else {
                self.locationManager.desiredAccuracy = kCLLocationAccuracyThreeKilometers
            }
            // [creature-collect] A walking game must keep streaming while the
            // user loiters: the default pausesLocationUpdatesAutomatically=true
            // lets CoreLocation silently stop updates when stationary. .fitness
            // matches on-foot use. distanceFilter stays kCLDistanceFilterNone —
            // queued one-shots piggyback on the stream (see getCurrentPosition),
            // so delivery must not be gated on movement.
            self.locationManager.activityType = .fitness
            self.locationManager.pausesLocationUpdatesAutomatically = false
""",
    ),
    (
        "reportLocation: freshest fix of each CoreLocation batch",
        """        if let location = locations.first {
""",
        """        // [creature-collect] locations.last, not .first: CoreLocation
        // batches are ordered oldest→newest (Apple docs), so .first
        // re-reports the STALEST fix whenever delivery batches (e.g.
        // after main-thread stalls) — the dot lags and can jump
        // backwards while the fresh fixes are thrown away.
        if let location = locations.last {
""",
    ),
]

for label, old, new in PATCHES:
    n = src.count(old)
    if n != 1:
        fail(f"[{label}] anchor found {n} times (expected exactly 1)")
    src = src.replace(old, new)

with open(path, "w", encoding="utf-8") as f:
    f.write(src)

print(f"patched: {path}")
for label, _, _ in PATCHES:
    print(f"  ✓ {label}")
