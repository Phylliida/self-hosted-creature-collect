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
}
