// Capacitor plugin reading step/distance from CMPedometer (Core Motion).
//
// Why CMPedometer over HealthKit: same data source (the M-series motion
// coprocessor) but no entitlement required. HealthKit's entitlement
// needs a paid Apple Developer membership + App ID registration in
// the developer portal; CMPedometer needs only NSMotionUsageDescription
// in Info.plist and works with the free-cert sideload flow (AltStore /
// SideStore re-signing).
//
// CMPedometer retains roughly seven days of historical pedometer data
// queryable at any time, even when our app wasn't running. The data
// covers the iPhone's onboard pedometer only — not Apple Watch, not
// manual entries — which for a "phone in pocket while walking" game
// is exactly the right scope.
//
// Used by the page on every visibility=visible transition to credit
// the user's daycare slots / incubator eggs with meters walked while
// the app was closed. See the visibility handler in static/index.html
// (search "MotionPedometer.getDistanceMeters").
//
// Registered manually from AppBridgeViewController.capacitorDidLoad
// via `bridge.registerPluginInstance(...)`. No CAP_PLUGIN macro / .m
// file or capacitor.config.json packageClassList entry needed.

import Foundation
import Capacitor
import CoreMotion

@objc(MotionPedometerPlugin)
public class MotionPedometerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MotionPedometerPlugin"
    public let jsName = "MotionPedometer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuth",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDistanceMeters", returnType: CAPPluginReturnPromise),
    ]

    // CMPedometer keeps its own internal queue; we hold a single instance
    // because docs say creating many is wasteful, and queries are quick.
    private let pedometer = CMPedometer()

    /// Snapshot capability + current authorization status.
    /// Resolved shape: { stepsAvailable, distanceAvailable, authStatus }.
    ///   authStatus: "notDetermined" | "restricted" | "denied" | "authorized" | "unknown"
    /// stepsAvailable / distanceAvailable are static per-device; cache on the JS side.
    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(currentSnapshot())
    }

    /// Trigger the system motion-permission prompt. CMPedometer prompts
    /// implicitly on the first data query; we kick off a trivial one-minute
    /// query and resolve once the callback returns. The callback only fires
    /// AFTER the user has dismissed the prompt, so the resolved snapshot
    /// reflects the new authStatus.
    @objc func requestAuth(_ call: CAPPluginCall) {
        guard CMPedometer.isStepCountingAvailable() else {
            call.resolve(currentSnapshot())
            return
        }
        let end = Date()
        let start = end.addingTimeInterval(-60)
        pedometer.queryPedometerData(from: start, to: end) { [weak self] _, _ in
            // Always resolve from the main thread — Capacitor's bridge is
            // technically thread-safe, but main keeps post-resolve JS hops
            // predictable for the consumer.
            DispatchQueue.main.async {
                guard let self = self else { call.resolve(["authStatus": "unknown"]); return }
                call.resolve(self.currentSnapshot())
            }
        }
    }

    /// Query the on-device pedometer for the window [fromMs, toMs] (epoch
    /// milliseconds). Resolves with:
    ///   { meters: Double, steps: Int, ok: Bool, error?: String }
    /// `ok` is false if the query failed (permission denied, window outside
    /// the ~7-day retention, etc.) — callers must NOT advance their lastSync
    /// marker in that case, or movement will be silently lost on next sync.
    @objc func getDistanceMeters(_ call: CAPPluginCall) {
        guard let fromMs = call.getDouble("fromMs"),
              let toMs   = call.getDouble("toMs") else {
            call.reject("fromMs and toMs (epoch milliseconds) are required")
            return
        }
        let from = Date(timeIntervalSince1970: fromMs / 1000.0)
        let to   = Date(timeIntervalSince1970: toMs   / 1000.0)
        // CMPedometer throws if from > to. Resolve a zero-meters success
        // for empty windows so callers can advance their lastSync marker
        // without special-casing.
        guard to > from else {
            call.resolve(["meters": 0.0, "steps": 0, "ok": true])
            return
        }
        pedometer.queryPedometerData(from: from, to: to) { data, error in
            DispatchQueue.main.async {
                if let error = error {
                    call.resolve([
                        "meters": 0.0,
                        "steps":  0,
                        "ok":     false,
                        "error":  error.localizedDescription,
                    ])
                    return
                }
                let meters = data?.distance?.doubleValue ?? 0.0
                let steps  = data?.numberOfSteps.intValue ?? 0
                call.resolve([
                    "meters": meters,
                    "steps":  steps,
                    "ok":     true,
                ])
            }
        }
    }

    private func currentSnapshot() -> [String: Any] {
        let status: String
        switch CMPedometer.authorizationStatus() {
        case .notDetermined: status = "notDetermined"
        case .restricted:    status = "restricted"
        case .denied:        status = "denied"
        case .authorized:    status = "authorized"
        @unknown default:    status = "unknown"
        }
        return [
            "stepsAvailable":    CMPedometer.isStepCountingAvailable(),
            "distanceAvailable": CMPedometer.isDistanceAvailable(),
            "authStatus":        status,
        ]
    }
}
