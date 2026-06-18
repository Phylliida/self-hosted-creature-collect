// Capacitor plugin: configurable continuous haptic patterns via Core Haptics.
//
// Why Core Haptics (CHHapticEngine) and not the Web Vibration API or the
// UIFeedbackGenerator family:
//   - navigator.vibrate() is a no-op in iOS Safari / WKWebView, so the web
//     layer cannot drive vibration on iPhone at all.
//   - UIImpactFeedbackGenerator / UINotificationFeedbackGenerator only fire
//     fixed, canned taps — no continuous output, no parameter control.
//   - Core Haptics is the only API that plays a *continuous* haptic event
//     whose intensity/sharpness we can modulate over time. The Taptic Engine
//     has no user-settable carrier frequency (it buzzes near its mechanical
//     resonance), so "frequency" here means the rate at which we modulate the
//     amplitude envelope — i.e. how fast the buzz swells/pulses.
//
// Design: this plugin is a *generic* envelope player. The JS side computes a
// normalized amplitude envelope (an array of {t, i [, s]} control points over
// one loop) for whatever waveform/preset it wants, and hands it here. Keeping
// the pattern math in JS means new waveforms/presets need no native rebuild.
//
// Methods (all Promise-returning):
//   isSupported() -> { supported: Bool, reason: String }
//   play({ duration, intensity, sharpness, loop, points:[{t,i,s?}] })
//   update({ intensity?, sharpness? })   // smooth live tweak, no restart
//   stop()
//
// No "Full Access" / entitlement needed. Haptics are unavailable on iPad and
// the Simulator (capabilitiesForHardware().supportsHaptics == false); callers
// get supported:false and should fall back / disable the UI.
//
// Registered manually from AppBridgeViewController.capacitorDidLoad via
// bridge.registerPluginInstance(...), like the other plugins here.

import Foundation
import Capacitor
import CoreHaptics

@objc(HapticPatternPlugin)
public class HapticPatternPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HapticPatternPlugin"
    public let jsName = "HapticPattern"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play",        returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop",        returnType: CAPPluginReturnPromise),
    ]

    private let supportsHaptics = CHHapticEngine.capabilitiesForHardware().supportsHaptics
    private var engine: CHHapticEngine?
    private var player: CHHapticAdvancedPatternPlayer?

    // Retained so we can rebuild after an engine reset (interruption / reset).
    private var lastPattern: CHHapticPattern?
    private var lastDuration: Double = 1.0
    private var lastLoop: Bool = true
    private var isPlaying = false

    @objc func isSupported(_ call: CAPPluginCall) {
        call.resolve([
            "supported": supportsHaptics,
            "reason": supportsHaptics ? "" : "This device has no Taptic Engine (Core Haptics unsupported).",
        ])
    }

    @objc func play(_ call: CAPPluginCall) {
        guard supportsHaptics else { call.reject("haptics-unsupported"); return }

        let duration = clamp(call.getDouble("duration") ?? 1.0, 0.05, 30.0)
        let baseIntensity = Float(clamp(call.getDouble("intensity") ?? 1.0, 0.0, 1.0))
        let baseSharpness = Float(clamp(call.getDouble("sharpness") ?? 0.5, 0.0, 1.0))
        let loop = call.getBool("loop") ?? true

        let rawPoints = call.getArray("points") ?? []
        var intensityCPs: [CHHapticParameterCurve.ControlPoint] = []
        var sharpnessCPs: [CHHapticParameterCurve.ControlPoint] = []
        for entry in rawPoints {
            guard let p = entry as? [String: Any] else { continue }
            let tFrac = clamp(Self.num(p["t"]) ?? 0, 0.0, 1.0)
            let rel = tFrac * duration
            let i = Float(clamp(Self.num(p["i"]) ?? 1.0, 0.0, 1.0))
            intensityCPs.append(CHHapticParameterCurve.ControlPoint(relativeTime: rel, value: i))
            if let s = Self.num(p["s"]) {
                sharpnessCPs.append(CHHapticParameterCurve.ControlPoint(
                    relativeTime: rel, value: Float(clamp(s, 0.0, 1.0))))
            }
        }
        guard !intensityCPs.isEmpty else { call.reject("points-required"); return }

        do {
            try ensureEngineStarted()

            let event = CHHapticEvent(
                eventType: .hapticContinuous,
                parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: baseIntensity),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: baseSharpness),
                ],
                relativeTime: 0,
                duration: duration)

            var curves: [CHHapticParameterCurve] = [
                CHHapticParameterCurve(parameterID: .hapticIntensityControl,
                                       controlPoints: intensityCPs, relativeTime: 0),
            ]
            if !sharpnessCPs.isEmpty {
                curves.append(CHHapticParameterCurve(parameterID: .hapticSharpnessControl,
                                                     controlPoints: sharpnessCPs, relativeTime: 0))
            }

            let pattern = try CHHapticPattern(events: [event], parameterCurves: curves)
            lastPattern = pattern
            lastDuration = duration
            lastLoop = loop
            isPlaying = true
            try startPlayer(with: pattern, loop: loop, loopEnd: duration)
            call.resolve()
        } catch {
            call.reject("play-failed: \(error.localizedDescription)")
        }
    }

    /// Smooth live adjustment of overall intensity / sharpness while a pattern
    /// is playing — avoids rebuilding the pattern on every slider tick.
    @objc func update(_ call: CAPPluginCall) {
        guard let player = player else { call.resolve(); return }
        var params: [CHHapticDynamicParameter] = []
        if let i = call.getDouble("intensity") {
            params.append(CHHapticDynamicParameter(parameterID: .hapticIntensityControl,
                                                   value: Float(clamp(i, 0, 1)), relativeTime: 0))
        }
        if let s = call.getDouble("sharpness") {
            params.append(CHHapticDynamicParameter(parameterID: .hapticSharpnessControl,
                                                   value: Float(clamp(s, 0, 1)), relativeTime: 0))
        }
        if !params.isEmpty {
            try? player.sendParameters(params, atTime: CHHapticTimeImmediate)
        }
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        isPlaying = false
        try? player?.stop(atTime: CHHapticTimeImmediate)
        player = nil
        engine?.stop(completionHandler: nil)
        call.resolve()
    }

    // MARK: - Engine plumbing

    private func ensureEngineStarted() throws {
        if engine == nil {
            let e = try CHHapticEngine()
            e.playsHapticsOnly = true
            e.isAutoShutdownEnabled = false
            e.stoppedHandler = { [weak self] reason in
                NSLog("[HapticPattern] engine stopped: \(reason.rawValue)")
                self?.isPlaying = false
                self?.player = nil
            }
            e.resetHandler = { [weak self] in
                guard let self = self else { return }
                NSLog("[HapticPattern] engine reset")
                do {
                    try self.engine?.start()
                    if self.isPlaying, let pattern = self.lastPattern {
                        try self.startPlayer(with: pattern, loop: self.lastLoop, loopEnd: self.lastDuration)
                    }
                } catch {
                    NSLog("[HapticPattern] reset-restart failed: \(error)")
                }
            }
            engine = e
        }
        try engine?.start()
    }

    private func startPlayer(with pattern: CHHapticPattern, loop: Bool, loopEnd: Double) throws {
        try? player?.stop(atTime: CHHapticTimeImmediate)
        guard let engine = engine else { throw CHHapticError(.engineNotRunning) }
        let p = try engine.makeAdvancedPlayer(with: pattern)
        p.isLoopEnabled = loop
        if loop { p.loopEnd = loopEnd }
        try p.start(atTime: CHHapticTimeImmediate)
        player = p
    }

    // MARK: - Helpers

    private func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double {
        return Swift.min(hi, Swift.max(lo, v))
    }

    /// Coerce a JS-bridged numeric value (Double / NSNumber / Int) to Double.
    private static func num(_ any: Any?) -> Double? {
        if let d = any as? Double { return d }
        if let n = any as? NSNumber { return n.doubleValue }
        if let i = any as? Int { return Double(i) }
        return nil
    }
}
