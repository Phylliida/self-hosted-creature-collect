// Capacitor plugin reading background step + distance data — the
// Android analogue of iOS's CMPedometer/HealthKit. Two backends,
// tried in order on every read:
//
//   1. Health Connect (preferred). While the app is closed (or even
//      after the OS killed it), Health Connect keeps aggregating step
//      counts from every registered source (phone pedometer, Wear OS
//      watch, Google Fit if it's still alive, etc.).
//   2. TYPE_STEP_COUNTER hardware sensor (fallback). The phone's
//      sensor hub counts steps continuously — screen off, Doze, app
//      dead — as a cumulative-since-boot counter, at effectively zero
//      battery cost. We persist a baseline (SharedPreferences) and
//      credit the diff on each sync, so movement while the app was
//      closed is recovered WITHOUT needing a foreground service. This
//      is the same trick classic FOSS pedometers (Paseo, j4velin's
//      Pedometer) use, and it's what keeps "count steps while closed"
//      working on de-Googled ROMs (/e/OS, microG) where Health Connect
//      itself is installed but no app ever writes steps into it
//      (aggregate() would return zero forever).
//
//      Caveats: the counter resets at every reboot (detected when the
//      current value drops below the saved baseline — we then credit
//      only what's accumulated since boot), and the first-ever read
//      just establishes the baseline (credits nothing — we can't know
//      which pre-existing steps fall inside the sync window).
//
// Baseline invariant: the sensor baseline is advanced on every sync
// that resolves ok=true — including ones served by Health Connect —
// so steps are never double-credited when the serving backend changes.
// It is NOT advanced on ok=false (the page must not advance its
// lastSync marker either — same "never lose movement" contract as the
// iOS plugin).
//
// Written in Kotlin because Health Connect's 1.0.x API is genuinely
// Kotlin-first: getReadPermission takes a KClass, aggregate() and
// getGrantedPermissions() are suspend functions, getSdkStatus lives
// on the Companion object. Calling these from Java requires verbose
// interop (JvmClassMappingKt etc.) and the async/Future wrappers
// only landed in 1.1+ (which requires compileSdk 35 we don't have).
//
// Why this masquerades as "MotionPedometer" via @CapacitorPlugin:
//   The page-side bridge in static/index.html looks up
//     window.Capacitor.Plugins.MotionPedometer
//   regardless of platform. iOS's MotionPedometerPlugin.swift uses
//   the same jsName. Keeping the names aligned means the JS doesn't
//   need a platform branch — the same _pedometerSync code path
//   works on both.
//
// Registered from MainActivity.java's onCreate via
//   registerPlugin(HealthConnectStepPlugin.class);
//
// Build-side wiring lives in .github/workflows/android-build.yml — it
// applies the kotlin-android Gradle plugin, adds Kotlin stdlib +
// coroutines + Health Connect deps, declares the read permissions in
// AndroidManifest.xml, and copies this file into the generated
// android/app/src/main/java/<pkg>/ tree.
//
// User-visible flow:
//   1. Settings → "Count steps while app is closed" toggle (the same
//      one iOS uses). Tap to enable.
//   2. The page calls Ped.requestAuth(); we ask for the runtime
//      ACTIVITY_RECOGNITION permission first (sensor fallback), then
//      launch the Health Connect permission grant intent.
//   3. The user picks which data types to share.
//   4. On every subsequent visibility=visible transition the page
//      calls Ped.getDistanceMeters({fromMs, toMs, strideMeters?}); we
//      aggregate StepsRecord + DistanceRecord (or diff the sensor
//      baseline) and resolve {meters, steps, ok, source}.
//      strideMeters is an optional per-user stride (Settings height
//      knob × 0.413) used only for steps→meters estimation when no
//      real distance record exists.
//
// IMPORTANT: appId in capacitor.config.json is currently
//   org.phylliidaassets.creaturecollect
// — if that ever changes, both this file's `package` line and the
// generated MainActivity.java's `package` line have to move together.

package org.phylliidaassets.creaturecollect

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import androidx.activity.result.ActivityResult
import androidx.core.content.ContextCompat
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import java.time.Instant
import kotlin.coroutines.resume

@CapacitorPlugin(
    name = "MotionPedometer",
    permissions = [
        Permission(
            alias = "activityRecognition",
            strings = [Manifest.permission.ACTIVITY_RECOGNITION],
        ),
    ],
)
class HealthConnectStepPlugin : Plugin() {

    companion object {
        // Fallback stride length used when DistanceRecord isn't
        // available for the window (some sources only emit steps) —
        // and for every step-sensor read, which has no distance notion
        // at all. 0.74 m is the average adult walking stride
        // (~0.413 × 179 cm). The page passes a per-user override as
        // `strideMeters` (derived from the Settings height knob,
        // height × 0.413); the call param wins when present.
        private const val STRIDE_METERS = 0.74
        // Step-sensor fallback state. The hardware counter is
        // cumulative since boot; we persist the value seen at the last
        // successful sync and credit the diff. Float matches the
        // sensor's own delivery (SensorEvent.values[0]); the reboot
        // reset keeps real-world values far below float's exact-integer
        // ceiling (~16.7M steps).
        private const val PREFS_NAME = "cc.stepfallback"
        private const val KEY_BASELINE = "baseline"
        // Registration with this on-change sensor fires one event with
        // the current count immediately; the timeout only covers a
        // pathological sensor hub that never delivers.
        private const val SENSOR_READ_TIMEOUT_MS = 3000L
    }

    private var client: HealthConnectClient? = null

    // Both data types we want to read. Health Connect's permission
    // model is per-type, so denying one and granting the other is
    // a real state we report as "partial".
    private val permissions: Set<String> = setOf(
        HealthPermission.getReadPermission(StepsRecord::class),
        HealthPermission.getReadPermission(DistanceRecord::class),
    )

    // Background scope for async Health Connect calls. Cancelled
    // automatically when the plugin's activity tears down via the
    // SupervisorJob; child failures don't take siblings down.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun load() {
        super.load()
        tryInitClient()
    }

    private fun tryInitClient() {
        if (client != null) return
        // Health Connect 1.0.0-alpha11 doesn't have a stable
        // `getSdkStatus` API (that landed in 1.1+). The robust
        // availability check across versions is just "try to create
        // the client and catch on failure" — getOrCreate throws
        // IllegalStateException (or NoClassDefFoundError on truly
        // ancient devices) when the Health Connect provider is
        // missing. Both are caught by Throwable.
        try {
            client = HealthConnectClient.getOrCreate(context)
        } catch (_: Throwable) {
            client = null
        }
    }

    // ─── step-sensor fallback helpers ──────────────────────────────

    private fun sensorManager(): SensorManager =
        context.getSystemService(Context.SENSOR_SERVICE) as SensorManager

    private fun stepSensorPresent(): Boolean = try {
        sensorManager().getDefaultSensor(Sensor.TYPE_STEP_COUNTER) != null
    } catch (_: Throwable) { false }

    // ACTIVITY_RECOGNITION is a runtime permission on API 29+; on older
    // devices the step sensors need no permission at all.
    private fun hasActivityPermission(): Boolean =
        Build.VERSION.SDK_INT < 29 ||
        ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACTIVITY_RECOGNITION,
        ) == PackageManager.PERMISSION_GRANTED

    private fun sensorBackendUsable(): Boolean =
        stepSensorPresent() && hasActivityPermission()

    // Read the current cumulative-since-boot step count. SensorManager
    // has no polling API, but registering a listener on this on-change
    // sensor delivers the current value as an immediate first event,
    // so a register → first event → unregister round-trip acts as a
    // one-shot read. Returns null when the fallback can't serve
    // (no sensor / no permission / hub never answered).
    private suspend fun readCurrentStepCount(): Float? {
        if (!sensorBackendUsable()) return null
        val sensor = sensorManager()
            .getDefaultSensor(Sensor.TYPE_STEP_COUNTER) ?: return null
        return withTimeoutOrNull(SENSOR_READ_TIMEOUT_MS) {
            suspendCancellableCoroutine<Float> { cont ->
                val listener = object : SensorEventListener {
                    override fun onSensorChanged(e: SensorEvent) {
                        sensorManager().unregisterListener(this)
                        if (cont.isActive) cont.resume(e.values[0])
                    }
                    override fun onAccuracyChanged(s: Sensor?, accuracy: Int) {}
                }
                cont.invokeOnCancellation {
                    sensorManager().unregisterListener(listener)
                }
                sensorManager().registerListener(
                    listener, sensor, SensorManager.SENSOR_DELAY_NORMAL,
                )
            }
        }
    }

    // Diff the just-read counter against the persisted baseline and
    // advance the baseline. Only call this on code paths that resolve
    // ok=true (see the header invariant) — an ok=false sync must leave
    // the baseline untouched so the movement isn't lost.
    private fun stepSensorDelta(current: Float): Long {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val steps = if (!prefs.contains(KEY_BASELINE)) {
            // First ever read: establish the baseline, credit nothing.
            0f
        } else {
            val baseline = prefs.getFloat(KEY_BASELINE, 0f)
            if (current < baseline) {
                // Counter went DOWN → the phone rebooted between syncs
                // and the counter restarted at 0. Steps between the
                // last sync and the reboot are unrecoverable; credit
                // what's accumulated since boot.
                current
            } else {
                current - baseline
            }
        }
        prefs.edit().putFloat(KEY_BASELINE, current).apply()
        return steps.toLong()
    }

    // ─── isAvailable ─────────────────────────────────────────────
    //
    // Cheap snapshot of capability + auth state. The page-side bridge
    // calls this on load to decide whether to surface the Settings
    // toggle at all.
    @PluginMethod
    fun isAvailable(call: PluginCall) {
        // Re-probe in case Health Connect was installed *after* plugin
        // load (user grabbed it from Play Store and came back).
        tryInitClient()
        call.resolve(currentSnapshot())
    }

    // ─── requestAuth ─────────────────────────────────────────────
    //
    // Asks for everything either backend needs, in order:
    //   1. ACTIVITY_RECOGNITION runtime permission (API 29+) for the
    //      sensor fallback. On de-Googled ROMs without Health Connect
    //      this grant alone is enough to reach "authorized".
    //   2. Health Connect's permission grant UI (separate activity,
    //      not an in-app dialog). Resolves with the post-prompt
    //      snapshot once control returns to our activity.
    @PluginMethod
    fun requestAuth(call: PluginCall) {
        tryInitClient()
        if (Build.VERSION.SDK_INT >= 29 && !hasActivityPermission()) {
            requestPermissionForAlias(
                "activityRecognition", call, "handleActivityPermResult",
            )
            return
        }
        launchHealthConnectAuth(call)
    }

    @PermissionCallback
    private fun handleActivityPermResult(call: PluginCall) {
        // Chain into the Health Connect grant regardless of how the
        // sensor prompt went — the snapshot reports the combined state.
        launchHealthConnectAuth(call)
    }

    private fun launchHealthConnectAuth(call: PluginCall) {
        if (client == null) {
            call.resolve(currentSnapshot())
            return
        }
        try {
            val intent: Intent = PermissionController
                .createRequestPermissionResultContract()
                .createIntent(context, permissions)
            startActivityForResult(call, intent, "handlePermResult")
        } catch (t: Throwable) {
            val ret = currentSnapshot()
            ret.put("authStatus", "unknown")
            ret.put("error", t.message ?: t.javaClass.simpleName)
            call.resolve(ret)
        }
    }

    @ActivityCallback
    private fun handlePermResult(call: PluginCall?, @Suppress("UNUSED_PARAMETER") result: ActivityResult) {
        // The ActivityResult itself doesn't tell us much — Health
        // Connect returns RESULT_OK regardless of grant outcome.
        // Re-query the granted permissions for the new state.
        call?.resolve(currentSnapshot())
    }

    // ─── getDistanceMeters ───────────────────────────────────────
    //
    // Report movement for the [fromMs, toMs] window as
    // { ok, meters, steps, source, error? }. ok=false means the caller
    // MUST NOT advance its lastSync marker (otherwise movement is
    // silently lost — same invariant as the iOS plugin).
    //
    // Health Connect is tried first: distance comes from
    // DistanceRecord.DISTANCE_TOTAL when present (most accurate —
    // sourced from the original device's pedometer), else steps ×
    // stride. When Health Connect is absent OR answers with nothing
    // (no writer app — the de-Googled-ROM case), the step-sensor
    // baseline diff takes over.
    @PluginMethod
    fun getDistanceMeters(call: PluginCall) {
        tryInitClient()
        val fromMs = call.getLong("fromMs")
        val toMs = call.getLong("toMs")
        if (fromMs == null || toMs == null || toMs <= fromMs) {
            call.resolve(failRet("invalid_window"))
            return
        }
        // Optional per-user stride for steps→meters estimation (the
        // Settings height knob). Sanity-clamped so a corrupted value
        // can't produce absurd credits; default is STRIDE_METERS.
        val strideParam = call.getDouble("strideMeters")
        val strideM = if (strideParam != null && strideParam > 0.3 && strideParam < 1.5)
            strideParam else STRIDE_METERS
        val c = client
        val range = TimeRangeFilter.between(
            Instant.ofEpochMilli(fromMs),
            Instant.ofEpochMilli(toMs),
        )
        scope.launch {
            // Backend 1: Health Connect.
            var hcSteps = 0L
            var hcDistanceM: Double? = null
            var hcError: String? = null
            if (c != null) {
                val req = AggregateRequest(
                    metrics = setOf(StepsRecord.COUNT_TOTAL, DistanceRecord.DISTANCE_TOTAL),
                    timeRangeFilter = range,
                    dataOriginFilter = emptySet(),
                )
                try {
                    val agg = c.aggregate(req)
                    hcSteps = agg[StepsRecord.COUNT_TOTAL] ?: 0L
                    hcDistanceM = agg[DistanceRecord.DISTANCE_TOTAL]?.inMeters
                } catch (t: Throwable) {
                    hcError = t.message ?: t.javaClass.simpleName
                }
            }
            // Backend 2: hardware step counter. Read it (and advance
            // the baseline) on every sync that will resolve ok=true —
            // including Health-Connect-served ones — so steps credited
            // via one backend are never re-credited by the other.
            val current = readCurrentStepCount()
            val sensorSteps = if (current != null) stepSensorDelta(current) else null

            val ret = JSObject()
            when {
                hcSteps > 0 || (hcDistanceM ?: 0.0) > 0.0 -> {
                    ret.put("ok", true)
                    ret.put("meters", hcDistanceM ?: (hcSteps.toDouble() * strideM))
                    ret.put("steps", hcSteps)
                    ret.put("source", "health_connect")
                }
                sensorSteps != null && sensorSteps > 0 -> {
                    ret.put("ok", true)
                    ret.put("meters", sensorSteps.toDouble() * strideM)
                    ret.put("steps", sensorSteps)
                    ret.put("source", "step_sensor")
                }
                c != null || current != null -> {
                    // A backend answered and there was genuinely no
                    // movement in the window.
                    ret.put("ok", true)
                    ret.put("meters", 0)
                    ret.put("steps", 0)
                    ret.put(
                        "source",
                        if (c != null) "health_connect" else "step_sensor",
                    )
                }
                else -> {
                    call.resolve(failRet(hcError ?: "no_step_source"))
                    return@launch
                }
            }
            call.resolve(ret)
        }
    }

    private fun failRet(error: String): JSObject {
        val ret = JSObject()
        ret.put("ok", false)
        ret.put("meters", 0)
        ret.put("steps", 0)
        ret.put("error", error)
        return ret
    }

    // ─── helpers ─────────────────────────────────────────────────

    private fun currentSnapshot(): JSObject {
        // `client != null` is our Health Connect availability signal in
        // 1.0.x — see tryInitClient. Newer Health Connect versions
        // expose a richer tri-state (available / not_installed /
        // update_required) via getSdkStatus; when we bump the dep we
        // can plumb that through. The step-sensor fallback has its own
        // availability probe, and either backend satisfies the page.
        val hcAvailable = (client != null)
        val sensorOk = sensorBackendUsable()
        val ret = JSObject()
        ret.put("stepsAvailable", hcAvailable || sensorOk)
        ret.put("distanceAvailable", hcAvailable)
        ret.put("sensorAvailable", sensorOk)
        ret.put(
            "backend",
            if (hcAvailable) "health_connect"
            else if (sensorOk) "step_sensor"
            else "none",
        )
        ret.put("authStatus", resolveAuthStatus(hcAvailable))
        ret.put("sdkStatus", if (hcAvailable || sensorOk) "available" else "unavailable")
        return ret
    }

    private fun resolveAuthStatus(hcAvailable: Boolean): String {
        // The page's Settings toggle only sticks on "authorized", and
        // EITHER backend is enough to serve reads — so if the sensor
        // fallback is already good to go, that's an authorize.
        if (sensorBackendUsable()) return "authorized"
        if (!hcAvailable) {
            // No Health Connect and no usable sensor. If a sensor
            // exists but the runtime grant is missing, requestAuth can
            // still fix it — that's "notDetermined".
            return if (stepSensorPresent()) "notDetermined" else "unknown"
        }
        val c = client ?: return "unknown"
        return try {
            // runBlocking is acceptable here — getGrantedPermissions is
            // an in-process IPC that returns in milliseconds. Called
            // only on load + Settings open, never on the rendering hot
            // path. Keeping the snapshot-style API synchronous matches
            // what the iOS plugin shape returns.
            runBlocking(Dispatchers.IO) {
                val granted = c.permissionController.getGrantedPermissions()
                val got = permissions.count { it in granted }
                when {
                    got == permissions.size -> "authorized"
                    got > 0 -> "partial"
                    else -> "notDetermined"
                }
            }
        } catch (_: Throwable) {
            "unknown"
        }
    }
}
