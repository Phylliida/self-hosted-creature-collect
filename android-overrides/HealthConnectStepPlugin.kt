// Capacitor plugin reading background step + distance from Health
// Connect — the Android analogue of iOS's CMPedometer/HealthKit. While
// the app is closed (or even after the OS killed it), Health Connect
// keeps aggregating step counts from every registered source (phone
// pedometer, Wear OS watch, Google Fit if it's still alive, etc.).
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
//   2. The page calls Ped.requestAuth(); we launch the Health Connect
//      permission grant intent.
//   3. The user picks which data types to share.
//   4. On every subsequent visibility=visible transition the page
//      calls Ped.getDistanceMeters({fromMs, toMs}); we aggregate
//      StepsRecord + DistanceRecord and resolve {meters, steps, ok}.
//
// IMPORTANT: appId in capacitor.config.json is currently
//   org.phylliidaassets.creaturecollect
// — if that ever changes, both this file's `package` line and the
// generated MainActivity.java's `package` line have to move together.

package org.phylliidaassets.creaturecollect

import android.content.Intent
import androidx.activity.result.ActivityResult
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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.time.Instant

@CapacitorPlugin(name = "MotionPedometer")
class HealthConnectStepPlugin : Plugin() {

    companion object {
        // Fallback stride length used when DistanceRecord isn't
        // available for the window (some sources only emit steps).
        // 0.74 m is the average adult walking stride; could be wired
        // to a Settings knob later if users find their daycare
        // distances feel off.
        private const val STRIDE_METERS = 0.74
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
    // Launches Health Connect's permission grant UI (separate activity,
    // not an in-app dialog). Resolves with the post-prompt snapshot
    // once control returns to our activity.
    @PluginMethod
    fun requestAuth(call: PluginCall) {
        tryInitClient()
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
    // Aggregate Health Connect for the [fromMs, toMs] window and
    // report { ok, meters, steps, error? }. ok=false means the
    // caller MUST NOT advance its lastSync marker (otherwise movement
    // is silently lost — same invariant as the iOS plugin).
    //
    // Distance comes from DistanceRecord.DISTANCE_TOTAL when present
    // (most accurate — sourced from the original device's pedometer).
    // Falls back to steps × stride when no Distance records exist.
    @PluginMethod
    fun getDistanceMeters(call: PluginCall) {
        tryInitClient()
        val c = client
        if (c == null) {
            call.resolve(failRet("health_connect_unavailable"))
            return
        }
        val fromMs = call.getLong("fromMs")
        val toMs = call.getLong("toMs")
        if (fromMs == null || toMs == null || toMs <= fromMs) {
            call.resolve(failRet("invalid_window"))
            return
        }
        val range = TimeRangeFilter.between(
            Instant.ofEpochMilli(fromMs),
            Instant.ofEpochMilli(toMs),
        )
        val req = AggregateRequest(
            metrics = setOf(StepsRecord.COUNT_TOTAL, DistanceRecord.DISTANCE_TOTAL),
            timeRangeFilter = range,
            dataOriginFilter = emptySet(),
        )
        scope.launch {
            try {
                val agg = c.aggregate(req)
                val steps: Long = agg[StepsRecord.COUNT_TOTAL] ?: 0L
                val distance = agg[DistanceRecord.DISTANCE_TOTAL]
                val meters: Double = distance?.inMeters
                    ?: (steps.toDouble() * STRIDE_METERS)
                val ret = JSObject()
                ret.put("ok", true)
                ret.put("meters", meters)
                ret.put("steps", steps)
                call.resolve(ret)
            } catch (t: Throwable) {
                call.resolve(failRet(t.message ?: t.javaClass.simpleName))
            }
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
        // `client != null` is our availability signal in 1.0.x — see
        // tryInitClient. Newer Health Connect versions expose a richer
        // tri-state (available / not_installed / update_required) via
        // getSdkStatus; when we bump the dep we can plumb that through.
        val available = (client != null)
        val ret = JSObject()
        ret.put("stepsAvailable", available)
        ret.put("distanceAvailable", available)
        ret.put("authStatus", resolveAuthStatus(available))
        ret.put("sdkStatus", if (available) "available" else "unavailable")
        return ret
    }

    private fun resolveAuthStatus(available: Boolean): String {
        if (!available) return "unknown"
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
