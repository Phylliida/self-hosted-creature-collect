// Capacitor plugin exposing the app's current memory footprint to JS.
// Used by the bottom-left on-screen badge to watch memory while
// scrolling captured pokes / browsing the dex on a real device — we
// don't have Instruments on the dev machine (Linux), so in-app
// reporting is the only practical signal.
//
// `phys_footprint` is the value iOS uses for memory-limit kills, i.e.
// the ground truth for "how close is this app to OOM". `resident_size`
// (RSS) is reported alongside for context — usually close, can diverge
// under compression.
//
// Registered manually from AppBridgeViewController.capacitorDidLoad
// via `bridge.registerPluginInstance(...)`. No CAP_PLUGIN macro / .m
// file or capacitor.config.json packageClassList entry needed.

import Foundation
import Capacitor
import Darwin.Mach

@objc(MemoryProbePlugin)
public class MemoryProbePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MemoryProbePlugin"
    public let jsName = "MemoryProbe"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getFootprint", returnType: CAPPluginReturnPromise),
    ]

    @objc func getFootprint(_ call: CAPPluginCall) {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) { ptr -> kern_return_t in
            ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { intPtr in
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), intPtr, &count)
            }
        }
        if kr != KERN_SUCCESS {
            call.reject("task_info failed: \(kr)")
            return
        }
        // Bytes. JS Number has 53-bit precision — 9 PB headroom, fine
        // for any plausible memory size.
        call.resolve([
            "physFootprint": Double(info.phys_footprint),
            "residentSize":  Double(info.resident_size),
        ])
    }
}
