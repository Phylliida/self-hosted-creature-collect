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
//   isSupported() -> { supported, reason, amplitudeControl, backgroundPlay }
//   play({ duration, intensity, sharpness, loop, points:[{t,i,s?}],
//          sustained?, stopAfterMs? })
//   update({ intensity?, sharpness?, stopAfterMs? })
//   stop()
//   event "stopped" { reason }  — the session ended without JS asking
//     (left the app, unlocked into another app, or the stopAfterMs timer)
//
// `sustained` (the Extras massage; the Focus slider tick leaves it off):
//   - Plays with ALARM usage attributes. A vibration with no attributes
//     is USAGE_UNKNOWN, and Android silently drops those — vibrate()
//     returns normally, nothing buzzes — while Battery Saver is on, while
//     Settings → Vibration & haptics → Media vibration is off (UNKNOWN
//     follows the media slider since Android 13), and once the app is no
//     longer in the foreground. Alarm is on the system's allowlist for
//     all three. That's what "press Start, no buzz" was on Android.
//   - Keeps going behind the lock screen (the point of the tool is to
//     lock the phone and hold it against you). Leaving for another app
//     with the screen on still stops it, as does unlocking into some
//     other app, and `stopAfterMs` runs here so the auto-stop timer
//     doesn't depend on the WebView's timers while the screen is off.
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

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationAttributes
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
        // How long after onPause to decide whether the screen went off
        // (keep a sustained session going) or the user left the app
        // (stop). Gives the screen-off transition time to settle.
        private const val PAUSE_SETTLE_MS = 600L
        // After an unlock, how long the activity gets to come back to
        // the front before a session running behind the lock screen is
        // stopped (they unlocked into some other app).
        private const val UNLOCK_GRACE_MS = 2500L
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
    // JS resending the envelope. @Volatile: plugin methods run on
    // Capacitor's plugin thread, lifecycle + timers on the main thread.
    @Volatile private var lastEnvelope: DoubleArray? = null
    @Volatile private var lastLoop = true
    @Volatile private var lastIntensity = 1.0
    @Volatile private var lastSustained = false

    @Volatile private var resumed = true
    private val main = Handler(Looper.getMainLooper())
    private val autoStop = Runnable { endSession("timer") }
    private val pauseCheck = Runnable { if (!resumed && !keepBehindLock()) endSession("left") }
    private val unlockCheck = Runnable { if (!resumed) endSession("left") }
    private var unlockReceiver: BroadcastReceiver? = null

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
        // Lets the JS skip its stop-on-hidden: sustained sessions keep
        // going behind the lock screen (older builds don't send this).
        ret.put("backgroundPlay", ok)
        call.resolve(ret)
    }

    @PluginMethod
    fun play(call: PluginCall) {
        val v = vib
        if (v == null || !v.hasVibrator()) { call.reject("haptics-unsupported"); return }

        val duration = clamp(call.getDouble("duration") ?: 1.0, MIN_DURATION_S, MAX_DURATION_S)
        val baseIntensity = clamp(call.getDouble("intensity") ?: 1.0, 0.0, 1.0)
        val loop = call.getBoolean("loop", true) ?: true
        val sustained = call.getBoolean("sustained", false) ?: false

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
        lastSustained = sustained && loop
        try {
            startWaveform(v, env, baseIntensity, loop, lastSustained)
            scheduleAutoStop(call.getDouble("stopAfterMs"))
            if (lastSustained) watchUnlock() else unwatchUnlock()
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
            try { startWaveform(v, env, lastIntensity, lastLoop, lastSustained) } catch (e: Exception) { /* keep old */ }
        }
        if (call.data.has("stopAfterMs")) scheduleAutoStop(call.getDouble("stopAfterMs"))
        // sharpness: no Android analogue — accepted and ignored
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        endSession(null)
        call.resolve()
    }

    // Never keep buzzing in the background — except a sustained session
    // behind the lock screen. The decision waits PAUSE_SETTLE_MS so the
    // screen-off transition has finished; leaving for another app with
    // the screen on (or any one-off tick) stops, as it always did.
    override fun handleOnPause() {
        resumed = false
        main.removeCallbacks(pauseCheck)
        if (lastSustained && lastEnvelope != null) {
            main.postDelayed(pauseCheck, PAUSE_SETTLE_MS)
        } else {
            endSession("left")
        }
        super.handleOnPause()
    }

    override fun handleOnResume() {
        resumed = true
        main.removeCallbacks(pauseCheck)
        main.removeCallbacks(unlockCheck)
        super.handleOnResume()
    }

    override fun handleOnDestroy() {
        endSession(null)
        super.handleOnDestroy()
    }

    // ── session plumbing ─────────────────────────────────────────────

    // Stop everything. `reason` != null tells the JS (the session ended
    // without it asking, so its Start/Stop button needs to catch up).
    private fun endSession(reason: String?) {
        val wasPlaying = lastEnvelope != null
        lastEnvelope = null
        lastSustained = false
        main.removeCallbacks(autoStop)
        main.removeCallbacks(pauseCheck)
        main.removeCallbacks(unlockCheck)
        unwatchUnlock()
        try { vib?.cancel() } catch (e: Exception) { /* ignore */ }
        if (reason != null && wasPlaying) {
            val d = JSObject()
            d.put("reason", reason)
            notifyListeners("stopped", d)
        }
    }

    private fun keepBehindLock(): Boolean {
        if (!lastSustained || lastEnvelope == null) return false
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        return pm != null && !pm.isInteractive
    }

    // Main-looper timer. The vibrator service holds its own wakelock
    // while it plays, so uptime (and this timer) keeps running with the
    // screen off.
    private fun scheduleAutoStop(ms: Double?) {
        main.removeCallbacks(autoStop)
        if (ms != null && ms > 0.0) main.postDelayed(autoStop, ms.toLong())
    }

    // Unlocking while a session plays behind the lock screen: if the app
    // doesn't come back to the front (they unlocked into something else),
    // stop instead of buzzing on from the background.
    private fun watchUnlock() {
        if (unlockReceiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                if (!resumed) {
                    main.removeCallbacks(unlockCheck)
                    main.postDelayed(unlockCheck, UNLOCK_GRACE_MS)
                }
            }
        }
        try {
            // ACTION_USER_PRESENT is a protected system broadcast, so no
            // RECEIVER_(NOT_)EXPORTED flag is needed even on API 34.
            context.registerReceiver(r, IntentFilter(Intent.ACTION_USER_PRESENT))
            unlockReceiver = r
        } catch (e: Exception) { /* no unlock watch; pause/timer still stop it */ }
    }

    private fun unwatchUnlock() {
        val r = unlockReceiver ?: return
        unlockReceiver = null
        try { context.unregisterReceiver(r) } catch (e: Exception) { /* ignore */ }
    }

    // ── waveform plumbing ────────────────────────────────────────────

    private fun startWaveform(v: Vibrator, env: DoubleArray, intensity: Double, loop: Boolean, sustained: Boolean) {
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
                    // no amplitude control: threshold the envelope so the
                    // rhythm survives even though depth can't (not
                    // intensity × envelope — that went silent for good
                    // whenever the intensity slider sat below 50%)
                    if (e >= 0.5 && intensity > 0.0) 255 else 0
                }
                if (timings.isNotEmpty() && amps[amps.size - 1] == a) {
                    timings[timings.size - 1] = timings[timings.size - 1] + STEP_MS
                } else {
                    timings.add(STEP_MS)
                    amps.add(a)
                }
            }
            v.cancel()
            // Intensity 0 (or a flat-zero envelope): nothing to play, and
            // createWaveform rejects an all-zero pattern.
            if (amps.all { it == 0 }) return
            val effect = VibrationEffect.createWaveform(
                timings.toLongArray(),
                amps.toIntArray(),
                if (loop) 0 else -1
            )
            if (!sustained) {
                v.vibrate(effect)
            } else if (Build.VERSION.SDK_INT >= 33) {
                v.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM))
            } else {
                @Suppress("DEPRECATION")
                v.vibrate(effect, alarmAudioAttributes())
            }
        } else {
            // Pre-26 fallback: on/off pattern via the deprecated API.
            @Suppress("DEPRECATION")
            run {
                val pattern = ArrayList<Long>()
                pattern.add(0L) // initial delay
                var on = false
                var run = 0L
                for (e in env) {
                    val nowOn = e >= 0.5 && intensity > 0.0
                    if (nowOn == on) { run += STEP_MS } else {
                        pattern.add(run); on = nowOn; run = STEP_MS
                    }
                }
                pattern.add(run)
                v.cancel()
                if (sustained) v.vibrate(pattern.toLongArray(), if (loop) 0 else -1, alarmAudioAttributes())
                else v.vibrate(pattern.toLongArray(), if (loop) 0 else -1)
            }
        }
    }

    // API 26–32 spelling of USAGE_ALARM (AudioAttributes map onto
    // vibration usages there; VibrationAttributes arrived in 33).
    private fun alarmAudioAttributes(): AudioAttributes =
        AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

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
