// Capacitor plugin: stream every native-only ambient sensor the web
// layer can't reach — barometer (TYPE_PRESSURE), raw magnetometer
// (TYPE_MAGNETIC_FIELD), ambient light (TYPE_LIGHT), proximity
// (TYPE_PROXIMITY), battery level/state, thermal status, Battery Saver —
// for the Extras "Sensors" dashboard (static/extras-sensors.js). The
// iOS mirror is ios-overrides/SensorProbePlugin.swift; both register as
// jsName "SensorProbe" with the same contract so the JS side needs no
// platform branches:
//
//   getInfo() -> { barometer, magnetometer, light, proximity, thermal }
//   start()  -> begins 4 Hz 'reading' events (notifyListeners) with the
//        current snapshot: { pressureHPa?, magX/Y/Z?, lux?,
//        proximityCm?/proximityNear?, batteryPct?, batteryCharging?,
//        thermal?, lowPower }
//   stop()   -> tears the sensors down (the JS side calls this whenever
//        the dashboard is hidden, so nothing streams in the background;
//        handleOnPause is a native safety net for the same)
//
// Mapping notes vs the iOS half:
//   - relAltM (CMAltimeter's session altitude delta) has no Android
//     analogue and is simply absent — the JS row shows an em-dash.
//   - Thermal statuses are folded onto the iOS vocabulary so the JS
//     shows one scale: NONE->nominal, LIGHT/MODERATE->fair,
//     SEVERE->serious, CRITICAL/EMERGENCY/SHUTDOWN->critical.
//     currentThermalStatus needs API 29+; omitted below that.
//   - proximityNear uses the value < maximumRange convention (most
//     hardware reports a binary far==max / near==0).
//
// None of these sensors need a manifest permission. Registered from
// MainActivity's onCreate via registerPlugin(SensorProbePlugin.class)
// (a line the android-build.yml workflow injects); this file itself is
// picked up by the workflow's android-overrides/*.kt copy step.

package org.phylliidaassets.creaturecollect

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "SensorProbe")
class SensorProbePlugin : Plugin(), SensorEventListener {

    private var running = false
    private var pressureHPa: Float? = null
    private var lux: Float? = null
    private var proximityCm: Float? = null
    private var proximityMax = 5f
    private var mag: FloatArray? = null
    private val handler = Handler(Looper.getMainLooper())
    private val emitter = object : Runnable {
        override fun run() {
            if (!running) return
            emit()
            handler.postDelayed(this, 250)
        }
    }

    private fun sensorManager(): SensorManager =
        context.getSystemService(Context.SENSOR_SERVICE) as SensorManager

    @PluginMethod
    fun getInfo(call: PluginCall) {
        val sm = sensorManager()
        val out = JSObject()
        out.put("barometer", sm.getDefaultSensor(Sensor.TYPE_PRESSURE) != null)
        out.put("magnetometer", sm.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD) != null)
        out.put("light", sm.getDefaultSensor(Sensor.TYPE_LIGHT) != null)
        out.put("proximity", sm.getDefaultSensor(Sensor.TYPE_PROXIMITY) != null)
        out.put("thermal", Build.VERSION.SDK_INT >= 29)
        call.resolve(out)
    }

    @PluginMethod
    fun start(call: PluginCall) {
        if (!running) {
            running = true
            pressureHPa = null; lux = null; proximityCm = null; mag = null
            val sm = sensorManager()
            for (type in intArrayOf(
                Sensor.TYPE_PRESSURE, Sensor.TYPE_MAGNETIC_FIELD,
                Sensor.TYPE_LIGHT, Sensor.TYPE_PROXIMITY
            )) {
                val s = sm.getDefaultSensor(type) ?: continue
                if (type == Sensor.TYPE_PROXIMITY) proximityMax = s.maximumRange
                sm.registerListener(this, s, SensorManager.SENSOR_DELAY_UI)
            }
            handler.postDelayed(emitter, 250)
        }
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        teardown()
        call.resolve()
    }

    // Safety net: never keep sensors registered while the app is
    // backgrounded (the JS side also stops on visibilitychange).
    override fun handleOnPause() {
        teardown()
    }

    private fun teardown() {
        if (!running) return
        running = false
        sensorManager().unregisterListener(this)
        handler.removeCallbacks(emitter)
    }

    override fun onSensorChanged(e: SensorEvent) {
        when (e.sensor.type) {
            Sensor.TYPE_PRESSURE -> pressureHPa = e.values[0]
            Sensor.TYPE_LIGHT -> lux = e.values[0]
            Sensor.TYPE_PROXIMITY -> proximityCm = e.values[0]
            Sensor.TYPE_MAGNETIC_FIELD -> mag = e.values.clone()
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    private fun emit() {
        val out = JSObject()
        pressureHPa?.let { out.put("pressureHPa", it.toDouble()) }
        lux?.let { out.put("lux", it.toDouble()) }
        proximityCm?.let {
            out.put("proximityCm", it.toDouble())
            out.put("proximityNear", it < proximityMax)
        }
        mag?.let {
            out.put("magX", it[0].toDouble())
            out.put("magY", it[1].toDouble())
            out.put("magZ", it[2].toDouble())
        }
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        if (pct in 0..100) out.put("batteryPct", pct.toDouble())
        val sticky = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val status = sticky?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        out.put(
            "batteryCharging",
            status == BatteryManager.BATTERY_STATUS_CHARGING
                || status == BatteryManager.BATTERY_STATUS_FULL
        )
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (Build.VERSION.SDK_INT >= 29) {
            out.put(
                "thermal",
                when (pm.currentThermalStatus) {
                    PowerManager.THERMAL_STATUS_NONE -> "nominal"
                    PowerManager.THERMAL_STATUS_LIGHT,
                    PowerManager.THERMAL_STATUS_MODERATE -> "fair"
                    PowerManager.THERMAL_STATUS_SEVERE -> "serious"
                    else -> "critical"
                }
            )
        }
        out.put("lowPower", pm.isPowerSaveMode)
        notifyListeners("reading", out)
    }
}
