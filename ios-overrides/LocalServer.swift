// Local HTTP file server backed by GCDWebServer. Serves static
// assets from two roots:
//   1. liveDir  — optional override directory (Library/NoCloud/...);
//                 used by the live-update flow to swap in newer code
//                 without requiring an IPA rebuild.
//   2. bundleDir — the IPA's `App.app/public/` folder (read-only,
//                  ships with the build).
//
// On every request we try liveDir first, fall back to bundleDir.
// Live updates only need to ship the small set of changed files;
// large bundled assets (sprites, tiles, fonts) stay in the IPA's
// public folder.
//
// Why an HTTP server instead of Capacitor's WKURLSchemeHandler:
// WKWebView blocks `navigator.serviceWorker.register()` unless the
// page's URL scheme is http/https AND the origin is "potentially
// trustworthy" (https or localhost). A real local HTTP listener at
// http://localhost:<port> satisfies both — SW registers cleanly and
// every fetch is same-origin so CORS goes away.

import Foundation
import GCDWebServer
import UIKit

@objc class LocalServer: NSObject {
    @objc static let shared = LocalServer()

    private let server = GCDWebServer()
    private var bundleDir: URL?
    // Read-public, write-private: BundleAccessPlugin reads `.path`
    // off this for getLiveDir() but mutation flows through setLiveDir
    // so the UserDefaults persistence stays in one place. No @objc —
    // private(set) can't coexist with @objc property exposure.
    private(set) var liveDir: URL?

    // ─── Diagnostic state ────────────────────────────────────────────
    //
    // GCDWebServer runs request handlers on its own dispatch queue.
    // These counters are touched from both that queue (via record*
    // helpers) and from the main thread (via diagnosticsSnapshot
    // — called by LocalServerDiagPlugin in response to a JS bridge
    // call). Serialised via diagQueue.
    //
    // Why this exists: when GCDWebServer wedges, HTTP fetches stop
    // resolving — the page can't probe the server over HTTP. But the
    // Capacitor plugin bridge is in-process and routes around the
    // wedge, so JS can still read these counters and figure out
    // WHICH part of the server is stuck (no requests arriving =
    // socket dead; lots of in-flight = worker pool exhausted;
    // recentSlow piling up = file I/O stalling; recentErrors
    // populated = handler throwing).
    private let diagQueue = DispatchQueue(label: "cc.localServer.diag")
    private var _totalRequests = 0
    private var _inFlight = 0
    private var _peakInFlight = 0
    private var _totalErrors = 0
    private var _serverStartedAt: Date?
    private var _lastRequestStartedAt: Date?
    private var _lastResponseFinishedAt: Date?
    private var _recentErrors: [DiagEvent] = []
    private var _recentSlow:   [DiagEvent] = []
    // Per-request tracking. Keyed by monotonic request id, so the
    // snapshot can show WHICH paths are currently stuck and HOW LONG
    // each has been pending. When `_inFlight` is pinned > 0, the
    // contents of this dict are the smoking gun.
    private var _inFlightRequests: [Int: InFlightEntry] = [:]
    private var _nextRequestId = 0
    // Self-ping — repeating timer that has the server fetch its own
    // /__ping__ endpoint via URLSession.shared. URLSession.shared and
    // WKWebView's internal URLSession use different connection pools,
    // so this distinguishes "server is alive, WebView's URLSession is
    // stale" (self-ping succeeds, page fetches fail) from "server is
    // wedged" (both fail).
    private var pingTimer: DispatchSourceTimer?
    private var _lastSelfPingAt: Date?
    private var _lastSelfPingDurMs: Int = 0
    private var _lastSelfPingResult: String = ""
    private var _consecutiveSelfPingFails: Int = 0
    private var _selfPingsTotal: Int = 0
    private var _selfPingsOk: Int = 0
    // App lifecycle + memory pressure. iOS sends memory warnings
    // before it suspends or kills the app; backgrounding can suspend
    // dispatch sources. A wedge that lines up in time with one of
    // these events points at the OS, not at our code.
    private var _memoryWarnings: [Date] = []
    private var _lifecycleEvents: [LifecycleEvent] = []
    // Restart tracking. iOS sometimes tears down GCDWebServer's
    // listen socket during background suspension despite our
    // `AutomaticallySuspendInBackground: false` flag — the library's
    // internal `isRunning` flag stays true but new connects refuse.
    // The didBecomeActive hook runs a foreground health check; if it
    // fails, we stop+start the server to re-bind. The manual
    // LocalServerDiag.restart() also flows through here. These
    // counters surface both pathways in the diagnostic dump.
    private var _restartCount: Int = 0
    private var _lastRestartAt: Date?
    private var _lastRestartError: String?
    private var _lastForegroundCheckAt: Date?
    private var _lastForegroundCheckResult: String = ""
    // Anything taking longer than this ms threshold goes into
    // recentSlow. Healthy file reads on iOS are sub-10ms; >100ms
    // is usually file-system contention or a hung worker.
    private static let SLOW_THRESHOLD_MS = 100
    private static let RING_BUFFER_CAP = 30
    private static let SELF_PING_PATH = "/__ping__"
    private static let SELF_PING_INTERVAL_S: Double = 5.0
    private static let SELF_PING_TIMEOUT_S: TimeInterval = 5.0

    private struct DiagEvent {
        let timestamp: Date
        let path: String
        let message: String
        let durationMs: Int
    }

    private struct InFlightEntry {
        let path: String
        let startedAt: Date
    }

    private struct LifecycleEvent {
        let type: String
        let at: Date
    }

    /// Returns the request id so recordRequestEnd can remove the
    /// matching in-flight entry.
    private func recordRequestStart(path: String) -> Int {
        return diagQueue.sync {
            _totalRequests += 1
            _inFlight += 1
            if _inFlight > _peakInFlight { _peakInFlight = _inFlight }
            _lastRequestStartedAt = Date()
            _nextRequestId += 1
            let id = _nextRequestId
            _inFlightRequests[id] = InFlightEntry(path: path, startedAt: Date())
            return id
        }
    }

    private func recordRequestEnd(id: Int, path: String, durationMs: Int, statusCode: Int) {
        diagQueue.sync {
            _inFlight = max(0, _inFlight - 1)
            _lastResponseFinishedAt = Date()
            _inFlightRequests.removeValue(forKey: id)
            if durationMs > LocalServer.SLOW_THRESHOLD_MS {
                _recentSlow.append(DiagEvent(
                    timestamp: Date(), path: path,
                    message: "HTTP \(statusCode)", durationMs: durationMs))
                if _recentSlow.count > LocalServer.RING_BUFFER_CAP {
                    _recentSlow.removeFirst()
                }
            }
            if statusCode >= 400 {
                _totalErrors += 1
                _recentErrors.append(DiagEvent(
                    timestamp: Date(), path: path,
                    message: "HTTP \(statusCode)", durationMs: durationMs))
                if _recentErrors.count > LocalServer.RING_BUFFER_CAP {
                    _recentErrors.removeFirst()
                }
            }
        }
    }

    private func recordLifecycle(_ type: String) {
        diagQueue.sync {
            _lifecycleEvents.append(LifecycleEvent(type: type, at: Date()))
            if _lifecycleEvents.count > 10 { _lifecycleEvents.removeFirst() }
        }
    }

    private func recordMemoryWarning() {
        diagQueue.sync {
            _memoryWarnings.append(Date())
            if _memoryWarnings.count > 10 { _memoryWarnings.removeFirst() }
        }
    }

    /// Register notification observers for memory + lifecycle. Called
    /// once from start(). The observers are intentionally kept until
    /// the LocalServer instance dies, which is process-lifetime in
    /// practice (singleton).
    private func observeLifecycle() {
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification,
                       object: nil, queue: nil) { [weak self] _ in
            self?.recordMemoryWarning()
        }
        for (name, label) in [
            (UIApplication.didEnterBackgroundNotification,  "didEnterBackground"),
            (UIApplication.willEnterForegroundNotification, "willEnterForeground"),
            (UIApplication.willResignActiveNotification,    "willResignActive"),
            (UIApplication.didBecomeActiveNotification,     "didBecomeActive"),
        ] {
            nc.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
                self?.recordLifecycle(label)
                if name == UIApplication.didBecomeActiveNotification {
                    self?.scheduleForegroundHealthCheck()
                }
            }
        }
    }

    /// Schedule a one-shot self-ping shortly after foregrounding. If
    /// the ping fails, the listen socket likely died during iOS
    /// suspension — auto-restart the server to re-bind. The delay
    /// gives the runtime a moment to settle (URLSession in particular
    /// is flaky for the first ~second after wake-up).
    private func scheduleForegroundHealthCheck() {
        let q = DispatchQueue.global(qos: .utility)
        q.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            self?.foregroundHealthCheck()
        }
    }

    private func foregroundHealthCheck() {
        guard let baseURL = server.serverURL else { return }
        let url = baseURL.appendingPathComponent("__ping__")
        var req = URLRequest(url: url)
        req.timeoutInterval = 2.0
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { [weak self] _, response, error in
            guard let self = self else { return }
            let ok: Bool
            let resultStr: String
            if let r = response as? HTTPURLResponse, (200..<400).contains(r.statusCode) {
                ok = true
                resultStr = "ok HTTP \(r.statusCode)"
            } else if let err = error {
                ok = false
                let nsErr = err as NSError
                resultStr = "error: \(nsErr.code) \(nsErr.localizedDescription)"
            } else {
                ok = false
                resultStr = "no response"
            }
            self.diagQueue.sync {
                self._lastForegroundCheckAt = Date()
                self._lastForegroundCheckResult = resultStr
            }
            if ok {
                NSLog("[LocalServer] foreground health check OK")
            } else {
                NSLog("[LocalServer] foreground health check failed (\(resultStr)); auto-restarting")
                _ = self.restartServer()
            }
        }.resume()
    }

    /// Stop + restart the listen socket. Used by the foreground
    /// health-check recovery path and by the LocalServerDiag.restart()
    /// plugin method (debug button in Settings). Returns true on
    /// success. Safe to call from any thread — `server.stop()` and
    /// `server.start(options:)` are both synchronous and serialise
    /// internally, but we run from a background queue so main isn't
    /// blocked during stop()'s in-flight drain.
    @objc func restartServer() -> Bool {
        NSLog("[LocalServer] restart requested (current isRunning=\(server.isRunning))")
        if server.isRunning {
            server.stop()
        }
        do {
            let url = try bindListener()
            diagQueue.sync {
                _restartCount += 1
                _lastRestartAt = Date()
                _lastRestartError = nil
                _serverStartedAt = Date()
            }
            NSLog("[LocalServer] restart succeeded: \(url.absoluteString)")
            return true
        } catch {
            let msg = String(describing: error)
            diagQueue.sync {
                _restartCount += 1
                _lastRestartAt = Date()
                _lastRestartError = msg
            }
            NSLog("[LocalServer] restart failed: \(msg)")
            return false
        }
    }

    /// Bind the listen socket on the saved port (falling back to OS-
    /// assigned). Shared between initial start() and restartServer().
    /// Does NOT register the handler or lifecycle observers — those
    /// are one-time setup that survives stop/start.
    private func bindListener() throws -> URL {
        let savedPort = UserDefaults.standard.integer(forKey: "cc.localServer.port")
        let portsToTry: [UInt] = savedPort > 0
            ? [UInt(savedPort), 0]
            : [0]
        var lastError: Error?
        var bound = false
        for port in portsToTry {
            do {
                try server.start(options: [
                    GCDWebServerOption_Port: port,
                    GCDWebServerOption_BindToLocalhost: true,
                    GCDWebServerOption_AutomaticallySuspendInBackground: false,
                ])
                bound = true
                break
            } catch {
                lastError = error
                NSLog("[LocalServer] port \(port) failed: \(error); trying next")
            }
        }
        if !bound {
            throw lastError ?? NSError(domain: "LocalServer", code: 2,
                userInfo: [NSLocalizedDescriptionKey: "no port available"])
        }
        guard let url = server.serverURL else {
            throw NSError(domain: "LocalServer", code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Server started but no URL"])
        }
        let actualPort = Int(server.port)
        if actualPort != savedPort {
            UserDefaults.standard.set(actualPort, forKey: "cc.localServer.port")
        }
        return url
    }

    /// Repeating timer that fires a GET to the server's own
    /// /__ping__ endpoint. Runs on a utility-priority global queue so
    /// it doesn't compete with the main thread or with GCDWebServer's
    /// own queue.
    private func startSelfPing() {
        pingTimer?.cancel()
        let q = DispatchQueue.global(qos: .utility)
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now() + LocalServer.SELF_PING_INTERVAL_S,
                   repeating: LocalServer.SELF_PING_INTERVAL_S)
        t.setEventHandler { [weak self] in self?.performSelfPing() }
        pingTimer = t
        t.resume()
    }

    private func performSelfPing() {
        guard let baseURL = server.serverURL else { return }
        let url = baseURL.appendingPathComponent("__ping__")
        var req = URLRequest(url: url)
        req.timeoutInterval = LocalServer.SELF_PING_TIMEOUT_S
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let started = Date()
        URLSession.shared.dataTask(with: req) { [weak self] _, response, error in
            guard let self = self else { return }
            let durMs = Int(Date().timeIntervalSince(started) * 1000)
            self.diagQueue.sync {
                self._selfPingsTotal += 1
                self._lastSelfPingAt = Date()
                self._lastSelfPingDurMs = durMs
                if let err = error {
                    let nsErr = err as NSError
                    self._lastSelfPingResult =
                        "error: \(nsErr.code) \(nsErr.localizedDescription)"
                    self._consecutiveSelfPingFails += 1
                } else if let r = response as? HTTPURLResponse {
                    self._lastSelfPingResult = "HTTP \(r.statusCode)"
                    if (200..<400).contains(r.statusCode) {
                        self._selfPingsOk += 1
                        self._consecutiveSelfPingFails = 0
                    } else {
                        self._consecutiveSelfPingFails += 1
                    }
                } else {
                    self._lastSelfPingResult = "no response"
                    self._consecutiveSelfPingFails += 1
                }
            }
        }.resume()
    }

    /// In-process snapshot for the LocalServerDiag plugin. Safe to
    /// call from any thread; serialised through diagQueue. Returns a
    /// JSObject-compatible dict.
    @objc func diagnosticsSnapshot() -> [String: Any] {
        // Capture server-state fields outside diagQueue (they have
        // their own internal synchronisation), then merge with the
        // diagQueue-protected counters.
        let isRunning = server.isRunning
        let port = Int(server.port)
        return diagQueue.sync {
            let fmt: (DiagEvent) -> [String: Any] = { e in
                [
                    "t": e.timestamp.timeIntervalSince1970,
                    "path": e.path,
                    "msg": e.message,
                    "durMs": e.durationMs,
                ]
            }
            // Sort in-flight oldest-first so the longest-stuck request
            // is the first thing the user sees. Cap at 20 — anything
            // more is wallpaper.
            let inflightSorted = _inFlightRequests
                .sorted { $0.value.startedAt < $1.value.startedAt }
                .prefix(20)
                .map { (id, entry) -> [String: Any] in
                    [
                        "id": id,
                        "path": entry.path,
                        "startedAt": entry.startedAt.timeIntervalSince1970,
                    ]
                }
            let memWarnings = _memoryWarnings.map { ["t": $0.timeIntervalSince1970] }
            let lifecycle = _lifecycleEvents.map {
                ["t": $0.at.timeIntervalSince1970, "type": $0.type] as [String: Any]
            }
            return [
                "isRunning": isRunning,
                "port": port,
                "serverStartedAt": _serverStartedAt?.timeIntervalSince1970 ?? 0,
                "now": Date().timeIntervalSince1970,
                "totalRequests": _totalRequests,
                "inFlight": _inFlight,
                "peakInFlight": _peakInFlight,
                "totalErrors": _totalErrors,
                "lastRequestStartedAt": _lastRequestStartedAt?.timeIntervalSince1970 ?? 0,
                "lastResponseFinishedAt": _lastResponseFinishedAt?.timeIntervalSince1970 ?? 0,
                "slowThresholdMs": LocalServer.SLOW_THRESHOLD_MS,
                "recentErrors": _recentErrors.map(fmt),
                "recentSlow": _recentSlow.map(fmt),
                "inFlightDetails": Array(inflightSorted),
                "selfPing": [
                    "total": _selfPingsTotal,
                    "ok": _selfPingsOk,
                    "consecutiveFailures": _consecutiveSelfPingFails,
                    "lastAt": _lastSelfPingAt?.timeIntervalSince1970 ?? 0,
                    "lastDurMs": _lastSelfPingDurMs,
                    "lastResult": _lastSelfPingResult,
                    "intervalS": LocalServer.SELF_PING_INTERVAL_S,
                ] as [String: Any],
                "memoryWarnings": memWarnings,
                "lifecycle": lifecycle,
                "restart": [
                    "count": _restartCount,
                    "lastAt": _lastRestartAt?.timeIntervalSince1970 ?? 0,
                    "lastError": _lastRestartError ?? "",
                    "lastForegroundCheckAt": _lastForegroundCheckAt?.timeIntervalSince1970 ?? 0,
                    "lastForegroundCheckResult": _lastForegroundCheckResult,
                ] as [String: Any],
            ]
        }
    }

    /// Start the server. Idempotent — calling start() twice returns
    /// the same URL. Throws if the bundled `public/` folder can't be
    /// located in the app's main bundle.
    @objc func start() throws -> URL {
        if server.isRunning, let url = server.serverURL {
            return url
        }
        guard let bundlePath = Bundle.main.path(forResource: "public", ofType: nil) else {
            throw NSError(domain: "LocalServer", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "No `public` folder in app bundle"])
        }
        bundleDir = URL(fileURLWithPath: bundlePath, isDirectory: true)

        // Detect a fresh IPA install (or any bundle replacement) and
        // invalidate any stale liveDir from a prior IPA's live-update
        // session. Without this, the overlay model (liveDir served
        // first, bundleDir as fallback) means a newly-installed IPA's
        // bundled code can be MASKED by older files lingering in the
        // previous installation's liveDir — the user sees a confusing
        // mix of "reverted" pages alongside genuinely-new ones.
        // bundle-id.txt is stamped at build time and never live-updated,
        // so any change between launches means the bundle was replaced.
        invalidateLiveDirIfBundleChanged()

        // Restore any previously-set live dir from prior session.
        // Stored value is a path RELATIVE to Library/ (e.g.
        // "CCLiveUpdates/v-2026_05_03_12_00"). iOS rotates the data
        // container UUID across some launches (OS updates, restore
        // from backup) — an absolute path stored at write time would
        // point into a now-stale container and silently fail the
        // fileExists check, falling back to bundle-only and making
        // refreshes appear to "not stick" across app kills.
        liveDir = resolveSavedLiveDir()

        // Single catch-all handler. We use processBlock (sync) rather
        // than asyncProcessBlock since file lookup + GCDWebServerFileResponse
        // are both fast and run on a background queue anyway.
        //
        // The wrapper records per-request diagnostic state so
        // LocalServerDiagPlugin can surface "what is the server
        // actually doing" to the page. `defer` guarantees we
        // decrement inFlight + record duration on every code path,
        // including the early `self == nil` return.
        server.addHandler(forMethod: "GET",
                          pathRegex: ".*",
                          request: GCDWebServerRequest.self) { [weak self] req in
            guard let self = self else {
                return GCDWebServerErrorResponse(statusCode: 500)
            }
            let path = req.path
            // Self-ping is internal — don't count it against the
            // public request counters; it has its own dedicated
            // tracking under selfPing.* in the snapshot.
            if path == LocalServer.SELF_PING_PATH {
                return GCDWebServerDataResponse(jsonObject: [
                    "ok": true,
                    "t": Date().timeIntervalSince1970,
                ]) ?? GCDWebServerErrorResponse(statusCode: 500)
            }
            let started = Date()
            let id = self.recordRequestStart(path: path)
            let resp = self.handle(req)
            let durMs = Int(Date().timeIntervalSince(started) * 1000)
            self.recordRequestEnd(
                id: id, path: path, durationMs: durMs,
                statusCode: Int(resp.statusCode))
            return resp
        }

        // Bind the listen socket. Port-fallback logic lives in
        // bindListener() so restartServer() can reuse it. Persist the
        // resolved port across launches — the Service Worker's
        // TILES_CACHE keys responses by full URL (including port), so
        // a fresh port every launch would invalidate every cached
        // tile from prior sessions and break "save current view".
        let url = try bindListener()
        diagQueue.sync { _serverStartedAt = Date() }
        observeLifecycle()
        startSelfPing()
        NSLog("[LocalServer] listening at \(url.absoluteString)")
        return url
    }

    /// Update the liveDir override and persist for next launch. Pass
    /// nil to clear. `path` is the absolute path the JS side just
    /// wrote files to; we keep that as the in-memory URL but persist
    /// only the Library-relative portion so the next launch re-resolves
    /// against whatever the current data container UUID happens to be.
    @objc func setLiveDir(_ path: String?) {
        if let path = path {
            liveDir = URL(fileURLWithPath: path, isDirectory: true)
            if let rel = libraryRelativePath(path) {
                UserDefaults.standard.set(rel, forKey: "cc.localServer.liveDirRel")
            } else {
                NSLog("[LocalServer] setLiveDir: path not under Library/, persistence skipped: \(path)")
                UserDefaults.standard.removeObject(forKey: "cc.localServer.liveDirRel")
            }
            // Drop any stale absolute-path entry from the old scheme.
            UserDefaults.standard.removeObject(forKey: "cc.localServer.liveDir")
        } else {
            liveDir = nil
            UserDefaults.standard.removeObject(forKey: "cc.localServer.liveDirRel")
            UserDefaults.standard.removeObject(forKey: "cc.localServer.liveDir")
        }
    }

    /// Resolve the saved live-dir reference into an absolute URL using
    /// the *current* Library directory. Returns nil if nothing is
    /// saved, or the resolved path no longer exists on disk.
    private func resolveSavedLiveDir() -> URL? {
        guard let lib = FileManager.default
            .urls(for: .libraryDirectory, in: .userDomainMask).first else {
            return nil
        }
        let defaults = UserDefaults.standard

        // Preferred: relative-path entry written by the current code.
        if let rel = defaults.string(forKey: "cc.localServer.liveDirRel") {
            let url = lib.appendingPathComponent(rel, isDirectory: true)
            if FileManager.default.fileExists(atPath: url.path) {
                return url
            }
            // Stale (deleted manually, or never-existed). Clear it.
            defaults.removeObject(forKey: "cc.localServer.liveDirRel")
            return nil
        }

        // Migration: older builds wrote an absolute path. If the
        // CCLiveUpdates suffix still exists under the *current*
        // Library, adopt it and rewrite the entry as relative.
        if let abs = defaults.string(forKey: "cc.localServer.liveDir") {
            defaults.removeObject(forKey: "cc.localServer.liveDir")
            if let rel = extractCCLiveUpdatesSuffix(abs) {
                let url = lib.appendingPathComponent(rel, isDirectory: true)
                if FileManager.default.fileExists(atPath: url.path) {
                    defaults.set(rel, forKey: "cc.localServer.liveDirRel")
                    return url
                }
            }
        }
        return nil
    }

    /// Convert an absolute path into one relative to Library/, or nil
    /// if it isn't under Library/ at all.
    private func libraryRelativePath(_ absolute: String) -> String? {
        guard let lib = FileManager.default
            .urls(for: .libraryDirectory, in: .userDomainMask).first else {
            return nil
        }
        let libPath = lib.standardizedFileURL.path
        let absStd = URL(fileURLWithPath: absolute).standardizedFileURL.path
        let prefix = libPath.hasSuffix("/") ? libPath : libPath + "/"
        guard absStd.hasPrefix(prefix) else { return nil }
        return String(absStd.dropFirst(prefix.count))
    }

    /// Migration helper: pull the "CCLiveUpdates/..." suffix out of an
    /// absolute path that may have been written under a now-stale data
    /// container UUID. Returns nil if the marker isn't present.
    private func extractCCLiveUpdatesSuffix(_ absolute: String) -> String? {
        let marker = "/CCLiveUpdates/"
        guard let range = absolute.range(of: marker) else { return nil }
        return String(absolute[range.lowerBound...].dropFirst())  // drop leading /
    }

    /// Read the build-time bundle identifier (one line of ASCII text)
    /// from `App.app/public/bundle-id.txt`. Returns nil if the file is
    /// missing — the case for IPAs built before this mechanism existed,
    /// where we deliberately skip the freshness check rather than
    /// invalidate liveDir on every launch.
    private func readBundleId() -> String? {
        guard let dir = bundleDir else { return nil }
        let url = dir.appendingPathComponent("bundle-id.txt")
        guard let data = try? Data(contentsOf: url),
              let raw = String(data: data, encoding: .utf8) else {
            return nil
        }
        let id = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return id.isEmpty ? nil : id
    }

    /// Compare the on-disk bundle's identifier to whatever we last
    /// recorded. If they differ, drop every UserDefaults key that
    /// pointed at the previous bundle's liveDir overlay so this
    /// launch reads the new bundle directly. Stores the new id only
    /// after the cleanup so a crash mid-cleanup retries on next
    /// launch instead of silently leaving the old liveDir active.
    private func invalidateLiveDirIfBundleChanged() {
        guard let bid = readBundleId() else { return }
        let defaults = UserDefaults.standard
        let lastKey = "cc.localServer.bundleId"
        let last = defaults.string(forKey: lastKey)
        if last == bid { return }
        // Treat any of the following as "bundle changed":
        //   * `last` exists but differs (steady-state IPA replacement)
        //   * `last` is nil AND we have a stale liveDir configured
        //     — this catches the upgrade from an IPA without bundle-id.txt
        //     to one with it; nil-vs-nonnil isn't really "first launch"
        //     when there's clearly a previous live-update overlay
        //     pointing somewhere.
        let hasLive = defaults.object(forKey: "cc.localServer.liveDirRel") != nil
            || defaults.object(forKey: "cc.localServer.liveDir") != nil
        if last != nil || hasLive {
            defaults.removeObject(forKey: "cc.localServer.liveDirRel")
            defaults.removeObject(forKey: "cc.localServer.liveDir")
            NSLog("[LocalServer] bundle changed (\(last ?? "nil") -> \(bid)); cleared liveDir")
        } else {
            NSLog("[LocalServer] first launch; recording bundle id \(bid)")
        }
        defaults.set(bid, forKey: lastKey)
    }

    private func handle(_ req: GCDWebServerRequest) -> GCDWebServerResponse {
        let rawPath = req.path

        // Emergency-refresh route: pure-HTML escape hatch the
        // refresh button's <a href="/__refresh__.html"> falls back
        // to when its onclick JS doesn't run (live-update.js failed
        // to parse, an earlier script crash poisoned the page,
        // etc.). Clears any liveDir overlay so the BUNDLED code
        // starts serving on the redirect — equivalent state to a
        // fresh app reinstall, without the reinstall. From bundled
        // code the user can press refresh again to pull updates
        // via the normal in-page live-update flow.
        //
        // The path matches `/__refresh__.html` (not `/__refresh__`
        // alone) so a single href works across platforms — Android,
        // which has no native interceptor, can serve the bundled
        // static file at that exact path via WebViewAssetLoader.
        if rawPath == "/__refresh__.html" {
            setLiveDir(nil)
            // HTML response with both an HTTP 302 (preferred) and
            // a meta-refresh fallback — covers older WKWebView
            // edge cases where the redirect header isn't honored
            // for navigations from a same-origin <a> click.
            let html = "<!doctype html><html><head>"
                + "<meta http-equiv=\"refresh\" content=\"0;url=/\">"
                + "<title>Refreshing\u{2026}</title></head><body>"
                + "<p>Refreshing\u{2026} <a href=\"/\">tap here</a> if this page does not redirect.</p>"
                + "</body></html>"
            let resp = GCDWebServerDataResponse(html: html)
                ?? GCDWebServerErrorResponse(statusCode: 500)
            resp.statusCode = 302
            resp.setValue("/", forAdditionalHeader: "Location")
            resp.cacheControlMaxAge = 0
            return resp
        }

        // SPA-ish: bare `/` serves index.html.
        let path = (rawPath == "/" || rawPath.isEmpty) ? "/index.html" : rawPath

        // Try each root in order; first hit wins. Path is URL-decoded
        // by GCDWebServer before reaching us, so spaces / unicode
        // file names work without further escaping.
        for root in [liveDir, bundleDir].compactMap({ $0 }) {
            let candidate = root.appendingPathComponent(path)
            // Path-traversal defense: resolve and verify it stays
            // inside the root after symlink resolution.
            let resolved = candidate.standardizedFileURL.path
            let rootResolved = root.standardizedFileURL.path
            if !resolved.hasPrefix(rootResolved) { continue }
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: resolved, isDirectory: &isDir),
               !isDir.boolValue {
                let resp = GCDWebServerFileResponse(file: resolved)
                resp?.cacheControlMaxAge = 0  // mtime-stamped versions handle caching
                // GCDWebServer's mimeType inference doesn't know .pbf
                // (vector tile protobuf), defaulting to application/
                // octet-stream — MapLibre is fussy and prefers an
                // explicit type. Override for the file extensions we
                // actually serve as something other than the default.
                if resolved.hasSuffix(".pbf") {
                    resp?.contentType = "application/x-protobuf"
                }
                return resp ?? GCDWebServerErrorResponse(statusCode: 500)
            }
        }
        return GCDWebServerErrorResponse(statusCode: 404)
    }
}
