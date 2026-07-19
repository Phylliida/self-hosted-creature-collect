---
title: on ios the look direction updates only every 2-3 seconds
status: in_progress
claimed_by: claude-opus
created: 2026-07-19T20:27:09Z
updated: 2026-07-19T21:15:00Z
taiga_id: 78
taiga_version: 2
synced_hash: a79a67f71de91eb5
---

it should be faster than that, real time, please don't edit any gps settings tho those are very sensitive

## Progress
- (2026-07-19) Traced the heading pipeline. The facing cone (`static/index.html`
  ~6680–6789) is fed **only** by the WKWebView `deviceorientation` event
  (`onOrient` → `applyRotation`). The native `SensorProbePlugin.swift` streams
  raw magnetometer at 4 Hz but computes **no compass heading**, so there is no
  native heading source the cone could use without a Swift change + rebuild.
- Ruled out fake lag: `.cc-user-heading` CSS (index.html:1899) has a transition
  only on `opacity`, none on `transform` — rotation is applied instantly.
- Ruled out the GPS-course fallback as the culprit for a *stationary* user:
  `compassSeen` gates it off the moment any compass event lands, and it only
  fires when `speed >= 0.5`. So a 2–3s cadence while standing still = the
  `deviceorientation` events themselves are arriving ~every 2–3s.
- Checked with a second opinion: there is **no** documented hard 2–3s throttle
  for `deviceorientation` in WKWebView. The plausible causes for a multi-second
  cadence are: (1) iOS Low Power Mode throttling sensor callbacks — not
  JS-fixable; (2) **main-thread contention causing WebKit to coalesce sensor
  events** — JS-fixable; (3) OS magnetometer signal filtering / poor calibration
  — not JS-fixable. This app has known main-thread stalls (see freeze
  diagnosis), so (2) is the most likely *and* the only JS-addressable one.
- FIX APPLIED: made `onOrient` trivial (store the heading, schedule a render)
  and moved the expensive work — `map.getBearing()` + the CSS write — into a
  `requestAnimationFrame`-coalesced `scheduleRender()`. A near-instant event
  handler is far less likely to be coalesced/throttled by WebKit, and renders
  now happen at frame cadence instead of doing map-layout work on every raw
  sensor tick. Same wiring used for the `rotate` handler and GPS fallback.

- (2026-07-19) All 42 headless test files still pass (incl. sensors +
  compass-rotate-lock). Change is JS-only in `static/index.html`, touches no GPS
  settings. Left `status: in_progress` pending on-device confirmation.
- (2026-07-19, fresh instance) Re-verified the committed fix in place (commit
  9768192c): `onOrient` stores `lastHeading` + `scheduleRender()`; the
  `map.getBearing()` + `--cc-heading` write are rAF-coalesced in `applyRotation`;
  same path for `map.on('rotate')` and the GPS-course fallback. Working tree
  clean. Sought a second opinion on whether any *other* JS lever exists: none —
  `deviceorientation` delivery rate in WKWebView is OS-governed, and iOS
  throttles the magnetometer while stationary to save power. The rAF decoupling
  is the correct JS ceiling (ensures we don't *add* lag), but cannot remove an
  OS-imposed throttle. Also cleared the stale Taiga conflict block (Taiga
  description was empty — nothing to merge). Keeping `in_progress` pending the
  human's on-device check, per the same blocker the prior instance hit.

- (2026-07-19, fresh instance) Scoped **Plan B** (native heading fallback) so it's
  ready if the on-device test shows the rAF fix didn't clear the 2–3s cadence.
  Did NOT write any Swift or touch index.html — this is a design note only.
  - **Where it plugs into JS:** trivial. `onOrient` already funnels into
    `compassSeen = true; lastHeading = h; scheduleRender()` (index.html ~6744–6758).
    A native heading event just needs to call that same three-line body with `h` =
    degrees clockwise from true north. No change to `applyRotation`/`scheduleRender`
    — the rAF decoupling we already shipped is reused verbatim. `compassSeen` will
    correctly suppress the GPS-course fallback once native headings arrive.
  - **Native side:** iOS has no heading in the current plugin. `SensorProbePlugin`
    streams raw magnetometer via `CMMotionManager` but computes no compass heading.
    The real heading API is `CLLocationManager.startUpdatingHeading()` →
    `locationManager(_:didUpdateHeading:)`, emitting `newHeading.trueHeading`
    (fall back to `.magneticHeading` when `trueHeading < 0`, i.e. location off).
    That stream is delivered natively and is NOT subject to the WKWebView
    `deviceorientation` coalescing/throttle — it's the one lever left after the JS
    ceiling.
  - **⚠ Critical constraint (the "don't touch GPS settings" landmine):** the
    Capacitor Geolocation plugin uses **one shared `CLLocationManager`**, and the
    entire `ios-overrides/patch-geolocation-plugin.py` exists precisely to stop
    callers from clobbering each other's `desiredAccuracy` (the "accuracy
    clobbering" bug fixed in 87ef8202). Therefore the heading source MUST use its
    **own dedicated `CLLocationManager`** that ONLY calls `startUpdatingHeading()`
    and **never** sets `desiredAccuracy` and **never** calls
    `startUpdatingLocation()`. Heading updates don't participate in the
    accuracy negotiation, so a heading-only manager stays fully orthogonal to the
    sensitive shared geolocation manager. This keeps Plan B compliant with the
    task's "don't edit GPS settings" instruction.
  - **Orientation detail:** `trueHeading` is referenced to the top of the device
    per `CLDeviceOrientation`. To match the existing `webkitCompassHeading`
    semantics the cone already expects, set `manager.headingOrientation = .portrait`
    (or track UIDevice orientation). Then the value drops straight into `lastHeading`
    with no extra math — same units the Android/`alpha` path is normalized to.
  - **Packaging:** cleanest as a small new override plugin (e.g. `HeadingProbe`,
    jsName `"HeadingProbe"`, `start()`/`stop()` + a `heading` listener event),
    registered from `AppBridgeViewController.capacitorDidLoad()` and injected via
    `inject-into-xcodeproj.rb` exactly like `SensorProbe`. Do NOT fold it into
    `SensorProbePlugin`: that only runs while the Extras "Sensors" dashboard is
    open, whereas heading must run whenever the map/cone is active — different
    lifecycle. JS wires `HeadingProbe.addListener('heading', ...)` alongside the
    existing `deviceorientation` listeners, guarded by `Capacitor.isNativePlatform()`.
  - **Cost:** Swift + a Capacitor rebuild (CI), plus the geolocation-patch
    re-derivation caveat does NOT apply here (we're adding a new file, not patching
    the vendored plugin). No permission prompt needed for heading beyond location
    already being authorized for the map.
  - Left `status: in_progress` — Plan B stays a paper design until the field test
    confirms whether the shipped JS fix is enough. If it is, none of this is needed.

## Writeup (interim — needs on-device confirmation)
**What I changed:** decoupled the compass-cone repaint from the raw sensor
event. `onOrient` now only stores `lastHeading` and calls a new
`scheduleRender()`, which coalesces the actual work (`map.getBearing()` + CSS
`--cc-heading` write) into a single `requestAnimationFrame`. The `map.rotate`
handler and the GPS-course fallback go through the same path.

**Why:** the cone is fed only by the WKWebView `deviceorientation` event (the
native SensorProbe has no heading). There is no documented hard 2–3s WKWebView
throttle. Of the plausible causes — Low Power Mode (not JS-fixable), OS
magnetometer filtering (not JS-fixable), and main-thread contention coalescing
sensor events (JS-fixable) — only the last is addressable in JS, and it fits
this app's known main-thread-stall problem. A heavy per-event handler
(forcing map layout every tick) is exactly what makes WebKit coalesce sensor
delivery, so making the handler near-instant is the right lever.

**Honest status:** this is a best-effort fix for the most likely JS-fixable
cause. I could NOT verify it on an iPhone from here, so I can't confirm it
resolves the 2–3s cadence. If it doesn't, the remaining suspects are OS-level
(Low Power Mode — note SensorProbe already reports `lowPower`, so we could
surface a "Low Power Mode is throttling your compass" hint) or a genuine need
for a native CLLocationManager heading stream (Swift + rebuild). Assumption:
the reporter was stationary (so it's the compass, not the GPS fallback).
