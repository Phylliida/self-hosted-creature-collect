// Capacitor plugin: focus-mode event timeline — the iOS mirror of
// android-overrides/FocusMonitorPlugin.kt.
//
// Focus mode (static/creatures.js) accrues rewards while the app is
// foreground OR the device is asleep/locked; backgrounding the app
// while the device is unlocked pauses accrual. The WebView is suspended
// in the background, so JS can't observe these transitions itself —
// this plugin records a timestamped event log natively and hands it to
// JS on demand:
//
//   startSession() -> { screenOff, appForeground }
//       Begins recording; returns the current state so JS can seed its
//       replay. Idempotent — restarting a session clears the buffer.
//   getEvents([ sinceMs ]) -> { events: [{ t, type }] }
//       Events with t > sinceMs, oldest first; the returned events are
//       dropped from the buffer (consumptive read). Types:
//         locked / unlocked   (protected-data notifications)
//         app_fg / app_bg     (willEnterForeground / didEnterBackground)
//   endSession()  -> stops recording, clears the buffer.
//
// Notes:
//   - iOS has no screen on/off API. The lock state comes from
//     UIApplication.protectedDataWillBecomeUnavailable /
//     protectedDataDidBecomeAvailable, which track the lock screen on
//     any passcode-protected device (near-universal). Without a
//     passcode these never fire and lock time reads as paused — a
//     safe-direction miss.
//   - Locking also backgrounds the app (didEnterBackground fires
//     slightly after protectedDataWillBecomeUnavailable), so a sleep
//     transition arrives as locked + app_bg; the JS replay treats
//     either as sufficient for qualifying, so ordering doesn't matter.
//   - No Info.plist entries or permissions required.
//   - Buffer is capped like the Android mirror; overflow sheds the
//     oldest events, which at worst under-counts qualifying time.
//
// Registered from AppBridgeViewController.capacitorDidLoad() via
// bridge?.registerPluginInstance(FocusMonitorPlugin()), and added to
// the Xcode project by ios-overrides/inject-into-xcodeproj.rb like the
// other override plugins.

import Foundation
import UIKit
import Capacitor

@objc(FocusMonitorPlugin)
public class FocusMonitorPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FocusMonitorPlugin"
    public let jsName = "FocusMonitor"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getEvents", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endSession", returnType: CAPPluginReturnPromise)
    ]

    // ~4 days of aggressive lock toggling; far beyond any real session
    // between settles (JS pulls every 60s while foreground).
    private let maxEvents = 500
    private var events: [[String: Any]] = []
    private var observing = false

    private func record(_ type: String) {
        if events.count >= maxEvents { events.removeFirst() }
        events.append(["t": Int64(Date().timeIntervalSince1970 * 1000), "type": type])
    }

    @objc func startSession(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.events.removeAll()
            self.startObservingIfNeeded()
            call.resolve([
                "screenOff": !UIApplication.shared.isProtectedDataAvailable,
                // If JS is calling us, the WebView is alive — foreground.
                "appForeground": true
            ])
        }
    }

    @objc func getEvents(_ call: CAPPluginCall) {
        let sinceMs = Int64(call.getInt("sinceMs") ?? 0)
        var out: [[String: Any]] = []
        var kept: [[String: Any]] = []
        for e in events {
            let t = (e["t"] as? Int64) ?? 0
            if t > sinceMs { out.append(e) } else { kept.append(e) }
        }
        events = kept
        call.resolve(["events": out])
    }

    @objc func endSession(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.stopObserving()
            self.events.removeAll()
            call.resolve()
        }
    }

    private func startObservingIfNeeded() {
        if observing { return }
        observing = true
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(onLocked),
                       name: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil)
        nc.addObserver(self, selector: #selector(onUnlocked),
                       name: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil)
        nc.addObserver(self, selector: #selector(onBackground),
                       name: UIApplication.didEnterBackgroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(onForeground),
                       name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    private func stopObserving() {
        if !observing { return }
        observing = false
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func onLocked() { record("locked") }
    @objc private func onUnlocked() { record("unlocked") }
    @objc private func onBackground() { record("app_bg") }
    @objc private func onForeground() { record("app_fg") }
}
