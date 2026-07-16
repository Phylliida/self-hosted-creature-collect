// Capacitor plugin: stream every native-only ambient sensor the web
// layer can't reach — barometer (CMAltimeter), raw magnetometer
// (CMMotionManager), battery level/state, thermal state, Low Power
// Mode — for the Extras "Sensors" dashboard (static/extras-sensors.js).
// The Android mirror is android-overrides/SensorProbePlugin.kt; both
// register as jsName "SensorProbe" with the same contract so the JS
// side needs no platform branches:
//
//   getInfo() -> { barometer, magnetometer, light, proximity, thermal }
//       (availability booleans; light/proximity are Android-only and
//        always false here — iOS has no public API for either)
//   start()  -> begins 4 Hz 'reading' events (notifyListeners) with the
//        current snapshot: { pressureHPa?, relAltM?, magX/Y/Z?,
//        batteryPct?, batteryCharging?, thermal, lowPower }
//   stop()   -> tears the sensors down (the JS side calls this whenever
//        the dashboard is hidden, so nothing streams in the background)
//
// Notes:
//   - CMAltimeter reports pressure in kPa; converted to hPa here so the
//     JS side only ever sees hPa. relativeAltitude is metres since
//     start() (reset each session — surfaced as "altitude change").
//   - The altimeter rides the existing Motion & Fitness permission
//     (NSMotionUsageDescription is already in Info.plist for the
//     pedometer); magnetometer and the rest need no permission.
//   - UIDevice.batteryLevel needs isBatteryMonitoringEnabled = true;
//     it reports -1 until monitoring is on, which we skip over.
//
// Registered from AppBridgeViewController.capacitorDidLoad() via
// bridge?.registerPluginInstance(SensorProbePlugin()), and added to the
// Xcode project by ios-overrides/inject-into-xcodeproj.rb like the
// other override plugins.

import Foundation
import CoreMotion
import UIKit
import Capacitor

@objc(SensorProbePlugin)
public class SensorProbePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SensorProbePlugin"
    public let jsName = "SensorProbe"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private let altimeter = CMAltimeter()
    private let motion = CMMotionManager()
    private var timer: Timer?
    private var running = false
    private var pressureHPa: Double?
    private var relAltM: Double?

    @objc func getInfo(_ call: CAPPluginCall) {
        call.resolve([
            "barometer": CMAltimeter.isRelativeAltitudeAvailable(),
            "magnetometer": motion.isMagnetometerAvailable,
            "light": false,
            "proximity": false,
            "thermal": true
        ])
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.running { call.resolve(); return }
            self.running = true
            self.pressureHPa = nil
            self.relAltM = nil
            UIDevice.current.isBatteryMonitoringEnabled = true
            if CMAltimeter.isRelativeAltitudeAvailable() {
                self.altimeter.startRelativeAltitudeUpdates(to: OperationQueue.main) { data, _ in
                    guard let d = data else { return }
                    self.pressureHPa = d.pressure.doubleValue * 10.0   // kPa -> hPa
                    self.relAltM = d.relativeAltitude.doubleValue
                }
            }
            if self.motion.isMagnetometerAvailable {
                self.motion.magnetometerUpdateInterval = 0.25
                self.motion.startMagnetometerUpdates()
            }
            self.timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                self?.emit()
            }
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.teardown()
            call.resolve()
        }
    }

    private func teardown() {
        guard running else { return }
        running = false
        timer?.invalidate()
        timer = nil
        altimeter.stopRelativeAltitudeUpdates()
        if motion.isMagnetometerAvailable { motion.stopMagnetometerUpdates() }
    }

    private func emit() {
        guard running else { return }
        var out = JSObject()
        if let p = pressureHPa { out["pressureHPa"] = p }
        if let a = relAltM { out["relAltM"] = a }
        if let m = motion.magnetometerData {
            out["magX"] = m.magneticField.x
            out["magY"] = m.magneticField.y
            out["magZ"] = m.magneticField.z
        }
        let level = UIDevice.current.batteryLevel
        if level >= 0 { out["batteryPct"] = Double(level) * 100.0 }
        let state = UIDevice.current.batteryState
        out["batteryCharging"] = (state == .charging || state == .full)
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: out["thermal"] = "nominal"
        case .fair: out["thermal"] = "fair"
        case .serious: out["thermal"] = "serious"
        case .critical: out["thermal"] = "critical"
        @unknown default: out["thermal"] = "unknown"
        }
        out["lowPower"] = ProcessInfo.processInfo.isLowPowerModeEnabled
        notifyListeners("reading", data: out)
    }
}
