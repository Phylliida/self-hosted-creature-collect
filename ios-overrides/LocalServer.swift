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

@objc class LocalServer: NSObject {
    @objc static let shared = LocalServer()

    private let server = GCDWebServer()
    private var bundleDir: URL?
    @objc private(set) var liveDir: URL?

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

        // Restore any previously-set live dir from prior session.
        if let saved = UserDefaults.standard.string(forKey: "cc.localServer.liveDir") {
            let url = URL(fileURLWithPath: saved, isDirectory: true)
            if FileManager.default.fileExists(atPath: url.path) {
                liveDir = url
            }
        }

        // Single catch-all handler. We use processBlock (sync) rather
        // than asyncProcessBlock since file lookup + GCDWebServerFileResponse
        // are both fast and run on a background queue anyway.
        server.addHandler(forMethod: "GET",
                          pathRegex: ".*",
                          request: GCDWebServerRequest.self) { [weak self] req in
            return self?.handle(req) ?? GCDWebServerErrorResponse(statusCode: 500)
        }

        // BindToLocalhost so the server is unreachable from outside
        // the device (no NSLocalNetworkUsageDescription required).
        // Port 0 lets the OS pick a free port — read it back via .port.
        try server.start(options: [
            GCDWebServerOption_Port: 0,
            GCDWebServerOption_BindToLocalhost: true,
            GCDWebServerOption_AutomaticallySuspendInBackground: false,
        ])
        guard let url = server.serverURL else {
            throw NSError(domain: "LocalServer", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Server started but no URL"])
        }
        NSLog("[LocalServer] listening at \(url.absoluteString)")
        return url
    }

    /// Update the liveDir override and persist for next launch. Pass
    /// nil to clear.
    @objc func setLiveDir(_ path: String?) {
        if let path = path {
            liveDir = URL(fileURLWithPath: path, isDirectory: true)
            UserDefaults.standard.set(path, forKey: "cc.localServer.liveDir")
        } else {
            liveDir = nil
            UserDefaults.standard.removeObject(forKey: "cc.localServer.liveDir")
        }
    }

    private func handle(_ req: GCDWebServerRequest) -> GCDWebServerResponse {
        let rawPath = req.path
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
                return resp ?? GCDWebServerErrorResponse(statusCode: 500)
            }
        }
        return GCDWebServerErrorResponse(statusCode: 404)
    }
}
