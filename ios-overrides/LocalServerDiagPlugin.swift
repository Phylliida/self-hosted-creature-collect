// Capacitor plugin that exposes LocalServer's in-process diagnostic
// counters to JavaScript.
//
// Why this exists: when GCDWebServer wedges, HTTP fetches from the
// page stop resolving — we can't probe the server over HTTP because
// HTTP is exactly what's broken. The Capacitor plugin bridge is
// in-process and routes around the wedge, so JS can still read the
// server's state and answer questions like:
//   * Are new requests still arriving?   (totalRequests delta)
//   * Is the worker pool exhausted?      (inFlight pinned > 0)
//   * Are file reads slow?               (recentSlow ring buffer)
//   * Are handlers throwing?             (recentErrors ring buffer)
//   * When did the last response land?   (lastResponseFinishedAt)
//
// The page polls this in the Settings diagnostic panel so the user
// can confirm whether a "permanent" wedge is really a wedge or just
// a slow burst.
//
// Registered manually from AppBridgeViewController.capacitorDidLoad
// via `bridge.registerPluginInstance(...)`. No CAP_PLUGIN macro / .m
// file or capacitor.config.json packageClassList entry needed.

import Foundation
import Capacitor

@objc(LocalServerDiagPlugin)
public class LocalServerDiagPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LocalServerDiagPlugin"
    public let jsName = "LocalServerDiag"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getDiagnostics", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restart",        returnType: CAPPluginReturnPromise),
    ]

    /// Snapshot the in-process state of the LocalServer at the moment
    /// of the call. Shape:
    ///   {
    ///     isRunning: bool,
    ///     port: int,
    ///     serverStartedAt: <epoch seconds>,
    ///     now: <epoch seconds>,
    ///     totalRequests: int,
    ///     inFlight: int,
    ///     peakInFlight: int,
    ///     totalErrors: int,
    ///     lastRequestStartedAt: <epoch seconds>,
    ///     lastResponseFinishedAt: <epoch seconds>,
    ///     slowThresholdMs: int,
    ///     recentErrors: [{ t, path, msg, durMs }],
    ///     recentSlow:   [{ t, path, msg, durMs }],
    ///   }
    @objc func getDiagnostics(_ call: CAPPluginCall) {
        let snap = LocalServer.shared.diagnosticsSnapshot()
        call.resolve(snap as! [String: Any])
    }

    /// Stop + start the GCDWebServer listen socket. Used both by the
    /// debug "Restart local server" button in Settings and (via the
    /// same path) by the foreground health-check recovery. Resolves
    /// with `{ ok: bool, snapshot: { … } }` — the post-restart
    /// snapshot makes it easy to confirm the new state.
    ///
    /// Runs `restartServer()` on a utility queue because `server.stop()`
    /// may briefly block draining in-flight requests. We don't want
    /// to stall the JS bridge / main thread on that.
    @objc func restart(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .utility).async {
            let ok = LocalServer.shared.restartServer()
            let snap = LocalServer.shared.diagnosticsSnapshot()
            call.resolve([
                "ok": ok,
                "snapshot": snap,
            ])
        }
    }
}
