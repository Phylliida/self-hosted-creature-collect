// Capacitor plugin that exposes LocalServer's liveDir override to
// JavaScript. The page-side live-update flow downloads new web
// assets (index.html, sprites.js, etc.) into a versioned directory
// under Library/, then calls `BundleAccess.setLiveDir(path)` and
// reloads — LocalServer starts serving those files in preference to
// the IPA's bundled copies on the next request.
//
// Registered manually from AppBridgeViewController.capacitorDidLoad
// via `bridge.registerPluginInstance(...)`. Doesn't need a CAP_PLUGIN
// macro / .m file or capacitor.config.json packageClassList entry.

import Foundation
import Capacitor

@objc(BundleAccessPlugin)
public class BundleAccessPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BundleAccessPlugin"
    public let jsName = "BundleAccess"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getLiveDir",     returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLiveDir",     returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearLiveDir",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLiveDirRoot", returnType: CAPPluginReturnPromise),
    ]

    /// Returns the active live directory, or empty string if none.
    @objc func getLiveDir(_ call: CAPPluginCall) {
        call.resolve(["path": LocalServer.shared.liveDir?.path ?? ""])
    }

    /// Set the live directory. Pass an absolute filesystem path.
    /// LocalServer will try this directory first for every request,
    /// falling back to the IPA's bundled copy on miss. Persists
    /// across launches.
    @objc func setLiveDir(_ call: CAPPluginCall) {
        guard let path = call.getString("path"), !path.isEmpty else {
            call.reject("path required (non-empty)")
            return
        }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir),
              isDir.boolValue else {
            call.reject("path does not exist or is not a directory: \(path)")
            return
        }
        LocalServer.shared.setLiveDir(path)
        call.resolve(["path": path])
    }

    /// Clear the live directory override. LocalServer reverts to
    /// serving exclusively from the IPA's bundled webDir.
    @objc func clearLiveDir(_ call: CAPPluginCall) {
        LocalServer.shared.setLiveDir(nil)
        call.resolve()
    }

    /// Returns an absolute path under Library/ that's safe for
    /// storing live-update versions. Created if missing. The page
    /// can mkdir <here>/v-<version>, write files into it, then
    /// `setLiveDir(<here>/v-<version>)`.
    @objc func getLiveDirRoot(_ call: CAPPluginCall) {
        guard let lib = FileManager.default
            .urls(for: .libraryDirectory, in: .userDomainMask).first else {
            call.reject("no Library directory")
            return
        }
        let root = lib.appendingPathComponent("CCLiveUpdates", isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: root, withIntermediateDirectories: true)
        } catch {
            call.reject("mkdir failed: \(error)")
            return
        }
        call.resolve(["path": root.path])
    }
}
