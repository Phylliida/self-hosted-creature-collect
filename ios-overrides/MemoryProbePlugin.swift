// Capacitor plugin exposing memory footprints for our own (host) process
// AND every reachable child process. The host process — what
// task_info(mach_task_self_, ...) reports — is just the Capacitor
// shell. The actual heavyweight memory consumer is the separate
// WKWebView "WebContent" process where all JS runs (typed arrays,
// MapLibre tile cache, etc.). Reporting only the host hides the
// real memory pressure and makes "page reloaded due to OOM" bugs
// undebuggable.
//
// `phys_footprint` is the value iOS uses for memory-limit kills, i.e.
// the ground truth for "how close is this process to OOM". `resident_size`
// (RSS) is reported alongside for context — usually close, can diverge
// under compression.
//
// We use proc_listallpids + proc_pid_rusage / proc_pidpath, all public
// APIs. iOS sandbox restricts proc_pid_rusage to the calling app's
// own processes, so the returned list is { host process } + { our
// WebContent processes } + { any other helper processes WebKit spawns
// like Networking, GPU }. That's exactly the scope we want.
//
// Registered manually from AppBridgeViewController.capacitorDidLoad
// via `bridge.registerPluginInstance(...)`. No CAP_PLUGIN macro / .m
// file or capacitor.config.json packageClassList entry needed.

import Foundation
import Capacitor
import Darwin.Mach
import Darwin

@objc(MemoryProbePlugin)
public class MemoryProbePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MemoryProbePlugin"
    public let jsName = "MemoryProbe"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getFootprint", returnType: CAPPluginReturnPromise),
    ]

    @objc func getFootprint(_ call: CAPPluginCall) {
        // ---- Host (current) process via task_info — same as before.
        var hostPhys: UInt64 = 0
        var hostRss: UInt64 = 0
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) { ptr -> kern_return_t in
            ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { intPtr in
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), intPtr, &count)
            }
        }
        if kr == KERN_SUCCESS {
            hostPhys = info.phys_footprint
            hostRss = info.resident_size
        }

        // ---- Enumerate sibling processes (WebContent, Networking, GPU,
        // any other helpers we spawned). proc_listallpids → proc_name →
        // proc_pid_rusage. Sandbox limits this to processes we have
        // permission to inspect, which on iOS is our own + our spawned
        // helpers — exactly what we want.
        var processes: [[String: Any]] = []

        // Always include the host entry first.
        processes.append([
            "pid": Int(getpid()),
            "name": "host",
            "physFootprint": Double(hostPhys),
            "residentSize":  Double(hostRss),
        ])

        // Get all PIDs on the system (sandbox will gate which ones we
        // can actually inspect). First call with nil buffer to learn
        // size; second to fill.
        let needed = proc_listallpids(nil, 0)
        if needed > 0 {
            let cap = Int(needed) + 32  // a little headroom in case the list grew
            var pids = [pid_t](repeating: 0, count: cap)
            let got = pids.withUnsafeMutableBufferPointer { buf -> Int32 in
                proc_listallpids(buf.baseAddress,
                                 Int32(buf.count * MemoryLayout<pid_t>.size))
            }
            if got > 0 {
                let myPid = getpid()
                let n = Int(got)
                for i in 0..<n {
                    let pid = pids[i]
                    if pid <= 0 || pid == myPid { continue }
                    // Best-effort name (truncated to 16 bytes by the OS,
                    // path is the full executable path).
                    var nameBuf = [CChar](repeating: 0, count: 64)
                    let nameLen = nameBuf.withUnsafeMutableBufferPointer { buf -> Int32 in
                        proc_name(pid, buf.baseAddress, UInt32(buf.count))
                    }
                    let name = nameLen > 0 ? String(cString: nameBuf) : ""
                    if name.isEmpty { continue }
                    // proc_pid_rusage with the v4/current flavor.
                    var rusage = rusage_info_current()
                    let rr = withUnsafeMutablePointer(to: &rusage) { ptr -> Int32 in
                        ptr.withMemoryRebound(to: Optional<UnsafeMutableRawPointer>.self,
                                              capacity: 1) { rebound in
                            proc_pid_rusage(pid, RUSAGE_INFO_CURRENT, rebound)
                        }
                    }
                    if rr != 0 { continue }  // not readable from our sandbox
                    processes.append([
                        "pid": Int(pid),
                        "name": name,
                        "physFootprint": Double(rusage.ri_phys_footprint),
                        "residentSize":  Double(rusage.ri_resident_size),
                    ])
                }
            }
        }

        // Roll up the WebContent processes (one or more) into a summary
        // so the JS caller can read it cheaply without iterating.
        var webPhys: Double = 0
        var webRss: Double = 0
        var webCount = 0
        for p in processes {
            let name = (p["name"] as? String) ?? ""
            if name.contains("WebContent") {
                webPhys += (p["physFootprint"] as? Double) ?? 0
                webRss  += (p["residentSize"]  as? Double) ?? 0
                webCount += 1
            }
        }

        call.resolve([
            // Back-compat: top-level physFootprint/residentSize stay as the
            // HOST process so existing JS keeps showing the same shell-level
            // metric (the on-screen mem badge for instance). The WebContent
            // values are exposed separately so callers can opt in.
            "physFootprint": Double(hostPhys),
            "residentSize":  Double(hostRss),
            "webPhysFootprint": webPhys,
            "webResidentSize":  webRss,
            "webProcessCount":  webCount,
            "processes": processes,
        ])
    }
}
