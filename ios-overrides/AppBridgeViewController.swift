// CAPBridgeViewController subclass that boots the local HTTP file
// server before Capacitor reads the instance descriptor, then sets
// `descriptor.serverURL` to the server's URL. This makes the WebView
// load from `http://localhost:<port>/`, which Apple treats as a
// secure context — Service Workers register cleanly and every fetch
// is same-origin.
//
// Wired up via Main.storyboard (customClass="AppBridgeViewController").
// Workflow patches the storyboard during build.

import UIKit
import AVFoundation
import Capacitor
import WebKit

@objc(AppBridgeViewController)
class AppBridgeViewController: CAPBridgeViewController {

    override open func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        do {
            let url = try LocalServer.shared.start()
            descriptor.serverURL = url.absoluteString
            NSLog("[AppBridgeVC] serverURL set to \(url.absoluteString)")
        } catch {
            NSLog("[AppBridgeVC] LocalServer start failed: \(error)")
        }
        // Background audio for the Extras soundscapes sleep tool: the
        // .playback category (paired with UIBackgroundModes audio in
        // Info.plist, added by the build workflow) lets the WebView's
        // WebAudio keep playing after the screen locks. .mixWithOthers
        // keeps us polite toward other apps' audio; recent iOS lets
        // WKWebView manage its own session while capturing (tuner/mic
        // meter), so this doesn't fight getUserMedia.
        do {
            try AVAudioSession.sharedInstance().setCategory(
                .playback, mode: .default, options: [.mixWithOthers])
        } catch {
            NSLog("[AppBridgeVC] AVAudioSession category failed: \(error)")
        }
        return descriptor
    }

    /// Register our custom in-app plugin. capacitorDidLoad runs after
    /// the bridge is created (so `bridge` is non-nil) but before the
    /// WebView begins loading, which is the right window for plugin
    /// registration — the plugin's JS proxy gets injected into the
    /// page's Capacitor.Plugins map automatically.
    override open func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(BundleAccessPlugin())
        bridge?.registerPluginInstance(MemoryProbePlugin())
        bridge?.registerPluginInstance(LocalServerDiagPlugin())
        bridge?.registerPluginInstance(MotionPedometerPlugin())
        bridge?.registerPluginInstance(HapticPatternPlugin())
        bridge?.registerPluginInstance(SensorProbePlugin())
        bridge?.registerPluginInstance(SaveImagePlugin())
        bridge?.registerPluginInstance(FocusMonitorPlugin())
        NotificationCenter.default.addObserver(
            self, selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    // ── Resume watchdog (Oct 2026 white screen) ────────────────────
    // Players saw the app come back from the background as a pure white
    // screen that ignored taps until they reloaded by hand. Whatever wedges
    // the page, the WebView recovers when reloaded — so do it for them: a
    // few seconds after every return to the foreground, ask the page for a
    // trivial value. No answer in time (the page is frozen) or no page at
    // all → reload from the local server. LocalServer's own foreground
    // check restarts the listener ~2 s after resume, so we probe after it.
    private var resumeProbeToken = 0

    @objc private func appDidBecomeActive() {
        resumeProbeToken += 1
        let token = resumeProbeToken
        DispatchQueue.main.asyncAfter(deadline: .now() + 4.0) { [weak self] in
            self?.probePage(token: token)
        }
    }

    private func probePage(token: Int) {
        guard token == resumeProbeToken, let webView = webView else { return }
        guard UIApplication.shared.applicationState == .active else { return }
        var answered = false
        webView.evaluateJavaScript("document.readyState") { result, error in
            answered = true
            let state = result as? String
            if error != nil || state == nil {
                self.recoverPage(webView, reason: "no page (\(error?.localizedDescription ?? "nil"))")
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4.0) { [weak self] in
            guard let self = self, token == self.resumeProbeToken, !answered else { return }
            self.recoverPage(webView, reason: "page frozen (no answer in 4 s)")
        }
    }

    private func recoverPage(_ webView: WKWebView, reason: String) {
        NSLog("[AppBridgeVC] resume watchdog: \(reason); reloading")
        LocalServer.shared.recordLifecycle("watchdog-reload: \(reason)")
        // A frozen page may never yield its main thread to a plain reload;
        // loading the app URL afresh is the strongest in-process reset.
        if let s = bridge?.config.serverURL {
            webView.load(URLRequest(url: s))
        } else {
            webView.reload()
        }
    }
}
