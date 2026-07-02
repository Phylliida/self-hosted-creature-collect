// Capacitor plugin: configurable continuous haptic patterns via
// VibrationEffect waveforms — the Android mirror of
// ios-overrides/HapticPatternPlugin.swift.
//
// Why a native plugin and not navigator.vibrate():
//   - navigator.vibrate() in the WebView is coarse on/off only — no
//     amplitude control, so intensity envelopes (swells, heartbeats,
//     depth) all flatten into identical buzzing.
//   - VibrationEffect.createWaveform(timings, amplitudes, repeat) plays
//     an amplitude-stepped waveform on the system vibrator. On hardware
//     with amplitude control (every Pixel, most modern flagships —
//     Vibrator.hasAmplitudeControl()) this reproduces the JS-computed
//     envelope faithfully; without it we threshold to on/off so the
//     rhythm at least survives.
//
// The JS side (static/extras-vibration.js) is platform-agnostic: it
// computes a normalized amplitude envelope (array of {t, i} control
// points over one loop, t and i both 0..1) and hands it to whichever
// plugin registered as "HapticPattern". This class mirrors the iOS
// method contract exactly so no JS branch is needed:
//   isSupported() -> { supported, reason, amplitudeControl }
//   play({ duration, intensity, sharpness, loop, points:[{t,i,s?}] })
//   update({ intensity?, sharpness? })
//   stop()
//
// Mapping notes vs Core Haptics:
//   - Control points are linearly interpolated (same as
//     CHHapticParameterCurve) and sampled into fixed 20ms amplitude
//     steps; amplitude = 255 × baseIntensity × envelope(t).
//   - `sharpness` has no Android analogue (no user-settable carrier /
//     texture on LRA motors via public API) — accepted and ignored.
//   - `update` can't retune a waveform in flight (Android has no
//     equivalent of CHHapticDynamicParameter), so it re-renders the
//     stored envelope at the new intensity and restarts the loop. The
//     phase jump is minor and the composer re-plays on slider release
//     anyway.
//
// Requires android.permission.VIBRATE (injected into the manifest by
// .github/workflows/android-build.yml). Registered from MainActivity's
// onCreate via registerPlugin(HapticPatternPlugin.class), like the
// other plugins here. This file is copied into the generated package
// tree by the android-overrides step of the same workflow.

package org.phylliidaassets.creaturecollect

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

@CapacitorPlugin(name = "HapticPattern")
class HapticPatternPlugin : Plugin() {

    companion object {
        // Envelope sampling resolution. 20ms steps = 50Hz envelope
        // modulation — comfortably above what the swell/pulse presets
        // need, and coarse enough that the vibrator HAL tracks each
        // step cleanly.
        private const val STEP_MS = 20L
        private const val MAX_DURATION_S = 30.0
        private const val MIN_DURATION_S = 0.05
    }

    private val vib: Vibrator? by lazy {
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                val vm = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                vm?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }
        } catch (e: Exception) {
            null
        }
    }

    // Retained so update() can re-render at a new intensity without the
    // JS resending the envelope.
    private var lastEnvelope: DoubleArray? = null
    private var lastLoop = true
    private var lastIntensity = 1.0

    @PluginMethod
    fun isSupported(call: PluginCall) {
        val v = vib
        val ok = v != null && v.hasVibrator()
        val ret = JSObject()
        ret.put("supported", ok)
        ret.put("reason", if (ok) "" else "This device has no vibrator.")
        // hasAmplitudeControl() itself requires API 26
        ret.put("amplitudeControl",
            ok && v != null && Build.VERSION.SDK_INT >= 26 && v.hasAmplitudeControl())
        call.resolve(ret)
    }

    @PluginMethod
    fun play(call: PluginCall) {
        val v = vib
        if (v == null || !v.hasVibrator()) { call.reject("haptics-unsupported"); return }

        val duration = clamp(call.getDouble("duration") ?: 1.0, MIN_DURATION_S, MAX_DURATION_S)
        val baseIntensity = clamp(call.getDouble("intensity") ?: 1.0, 0.0, 1.0)
        val loop = call.getBoolean("loop", true) ?: true

        // Parse {t, i} control points (sharpness `s` is ignored — see
        // the mapping notes in the header).
        val arr = call.getArray("points")
        val ts = ArrayList<Double>()
        val vs = ArrayList<Double>()
        if (arr != null) {
            for (k in 0 until arr.length()) {
                val o = arr.optJSONObject(k) ?: continue
                ts.add(clamp(o.optDouble("t", 0.0), 0.0, 1.0))
                vs.add(clamp(o.optDouble("i", 1.0), 0.0, 1.0))
            }
        }
        if (ts.isEmpty()) { call.reject("points-required"); return }

        // Sample the piecewise-linear envelope at STEP_MS resolution
        // (sampling at each segment's midpoint). Points arrive sorted
        // and strictly increasing from the JS side; the interpolation
        // below only assumes sorted.
        val steps = max(1, ((duration * 1000.0) / STEP_MS).roundToInt())
        val env = DoubleArray(steps)
        for (k in 0 until steps) {
            env[k] = envelopeAt(ts, vs, (k + 0.5) / steps)
        }

        lastEnvelope = env
        lastLoop = loop
        lastIntensity = baseIntensity
        try {
            startWaveform(v, env, baseIntensity, loop)
            call.resolve()
        } catch (e: Exception) {
            call.reject("play-failed: " + (e.message ?: e.toString()))
        }
    }

    @PluginMethod
    fun update(call: PluginCall) {
        val v = vib
        val env = lastEnvelope
        if (v == null || env == null) { call.resolve(); return }
        val i = call.getDouble("intensity")
        if (i != null) {
            lastIntensity = clamp(i, 0.0, 1.0)
            try { startWaveform(v, env, lastIntensity, lastLoop) } catch (e: Exception) { /* keep old */ }
        }
        // sharpness: no Android analogue — accepted and ignored
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        lastEnvelope = null
        try { vib?.cancel() } catch (e: Exception) { /* ignore */ }
        call.resolve()
    }

    // Safety net: never keep buzzing from the background. The JS layer
    // also stops on visibilitychange/pagehide; double-cancel is harmless.
    override fun handleOnPause() {
        try { vib?.cancel() } catch (e: Exception) { /* ignore */ }
        super.handleOnPause()
    }

    // ── waveform plumbing ────────────────────────────────────────────

    private fun startWaveform(v: Vibrator, env: DoubleArray, intensity: Double, loop: Boolean) {
        if (Build.VERSION.SDK_INT >= 26) {
            val hasAmp = v.hasAmplitudeControl()  // API 26+ — inside the guard
            // Run-length-encode consecutive equal amplitudes so the HAL
            // gets a compact pattern (a 30s sine at 20ms steps is 1500
            // raw segments; RLE typically collapses plateaus).
            val timings = ArrayList<Long>()
            val amps = ArrayList<Int>()
            for (e in env) {
                val a = if (hasAmp) {
                    clampInt((255.0 * intensity * e).roundToInt(), 0, 255)
                } else {
                    // no amplitude control: threshold so the rhythm
                    // survives even though depth can't
                    if (intensity * e >= 0.5) 255 else 0
                }
                if (timings.isNotEmpty() && amps[amps.size - 1] == a) {
                    timings[timings.size - 1] = timings[timings.size - 1] + STEP_MS
                } else {
                    timings.add(STEP_MS)
                    amps.add(a)
                }
            }
            val effect = VibrationEffect.createWaveform(
                timings.toLongArray(),
                amps.toIntArray(),
                if (loop) 0 else -1
            )
            v.cancel()
            v.vibrate(effect)
        } else {
            // Pre-26 fallback: on/off pattern via the deprecated API.
            @Suppress("DEPRECATION")
            run {
                val pattern = ArrayList<Long>()
                pattern.add(0L) // initial delay
                var on = false
                var run = 0L
                for (e in env) {
                    val nowOn = intensity * e >= 0.5
                    if (nowOn == on) { run += STEP_MS } else {
                        pattern.add(run); on = nowOn; run = STEP_MS
                    }
                }
                pattern.add(run)
                v.cancel()
                v.vibrate(pattern.toLongArray(), if (loop) 0 else -1)
            }
        }
    }

    /// Piecewise-linear interpolation over sorted control points —
    /// same semantics as CHHapticParameterCurve: hold the first value
    /// before the first point and the last value after the last.
    private fun envelopeAt(ts: List<Double>, vs: List<Double>, t: Double): Double {
        if (t <= ts[0]) return vs[0]
        for (k in 1 until ts.size) {
            if (t <= ts[k]) {
                val span = ts[k] - ts[k - 1]
                if (span <= 0.0) return vs[k]
                val f = (t - ts[k - 1]) / span
                return vs[k - 1] + (vs[k] - vs[k - 1]) * f
            }
        }
        return vs[vs.size - 1]
    }

    private fun clamp(x: Double, lo: Double, hi: Double): Double = max(lo, min(hi, x))
    private fun clampInt(x: Int, lo: Int, hi: Int): Int = max(lo, min(hi, x))
}
