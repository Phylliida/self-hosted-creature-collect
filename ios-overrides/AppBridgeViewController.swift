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
import Capacitor

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
    }
}
