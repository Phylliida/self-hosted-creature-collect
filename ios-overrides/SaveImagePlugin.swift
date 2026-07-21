// Capacitor plugin: save a creature sprite straight into the iOS photo
// library.
//
// Why this exists: the web "Save image" flow (static/creatures.js
// saveImageToPhone) relies on the Web Share sheet for "Save to Photos".
// Without NSPhotoLibraryAddUsageDescription in Info.plist that save
// silently never lands — and even with it, the share sheet is a clunky
// two-step. This plugin gives the JS side a one-tap path: base64 PNG in,
// photo in the Camera Roll out.
//
// Permission model: the app only ever ADDS photos, never reads the
// library, so it qualifies for the least-privileged "Add Photos Only"
// access (NSPhotoLibraryAddUsageDescription, injected into Info.plist by
// the ios-build workflow). UIImageWriteToSavedPhotosAlbum triggers the
// system add-only prompt itself when status is .notDetermined; we only
// pre-check for an already-denied/restricted state so JS gets a clean
// DENIED it can surface ("enable in Settings") instead of a save error.
//
// Contract (mirrors android-overrides/SaveImagePlugin.kt):
//   saveImage({ base64, filename? }) -> { saved: true }
//   rejects with code "DENIED" (user refused photo access),
//   "BAD_INPUT" (undecodable data) or "SAVE_FAILED" (everything else).
//
// Registered manually from AppBridgeViewController.capacitorDidLoad via
// bridge.registerPluginInstance(...), like the other plugins here.

import Foundation
import Capacitor
import Photos
import UIKit

@objc(SaveImagePlugin)
public class SaveImagePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SaveImagePlugin"
    public let jsName = "SaveImage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveImage", returnType: CAPPluginReturnPromise),
    ]

    // In-flight legacy saves, keyed by a token passed through contextInfo
    // (UIImageWriteToSavedPhotosAlbum is callback-selector based, not
    // closure based, so the call has to be stashed until the selector fires).
    private var pendingCalls: [String: CAPPluginCall] = [:]

    @objc func saveImage(_ call: CAPPluginCall) {
        guard let base64 = call.getString("base64"),
              let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters),
              let image = UIImage(data: data) else {
            call.reject("No decodable image data", "BAD_INPUT")
            return
        }
        let status: PHAuthorizationStatus
        if #available(iOS 14, *) {
            status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        } else {
            status = PHPhotoLibrary.authorizationStatus()
        }
        if status == .denied || status == .restricted {
            call.reject("Photo library access denied — enable it in Settings", "DENIED")
            return
        }
        let token = UUID().uuidString
        pendingCalls[token] = call
        // Prompts for add-only access on its own when .notDetermined.
        UIImageWriteToSavedPhotosAlbum(
            image, self,
            #selector(saveFinished(_:didFinishSavingWithError:contextInfo:)),
            Unmanaged.passRetained(token as NSString).toOpaque()
        )
    }

    @objc private func saveFinished(_ image: UIImage,
                                    didFinishSavingWithError error: NSError?,
                                    contextInfo: UnsafeRawPointer?) {
        guard let contextInfo = contextInfo else { return }
        // Balances the passRetained at the call site.
        let token = Unmanaged<NSString>.fromOpaque(contextInfo).takeRetainedValue() as String
        guard let call = pendingCalls.removeValue(forKey: token) else { return }
        if let error = error {
            // PHPhotosErrorDomain .accessUserDenied — user said no at the prompt.
            let denied = error.domain == "PHPhotosErrorDomain" && error.code == 3311
            call.reject(error.localizedDescription, denied ? "DENIED" : "SAVE_FAILED")
        } else {
            call.resolve(["saved": true])
        }
    }
}
