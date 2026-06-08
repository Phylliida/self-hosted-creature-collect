// Capacitor plugin reading background step + distance from Health
// Connect — the Android analogue of iOS's CMPedometer/HealthKit. While
// the app is closed (or even after the OS killed it), Health Connect
// keeps aggregating step counts from every registered source (phone
// pedometer, Wear OS watch, Google Fit if it's still alive, etc.).
//
// Why Health Connect vs raw TYPE_STEP_COUNTER:
//   - No need to maintain our own "since-boot baseline" — Health
//     Connect gives us "aggregate over [from, to]" directly.
//   - No foreground service / persistent notification required.
//   - Pulls from every registered data source, so a user with a watch
//     still gets credited for walks while the phone was at home.
//
// Why this masquerades as "MotionPedometer" via @CapacitorPlugin:
//   The page-side bridge in static/index.html looks up
//     window.Capacitor.Plugins.MotionPedometer
//   regardless of platform. iOS's MotionPedometerPlugin.swift uses the
//   same jsName. Keeping the names aligned means the JS doesn't need a
//   platform branch — the same _pedometerSync code path works.
//
// Registered from MainActivity.java's onCreate via
//   registerPlugin(HealthConnectStepPlugin.class);
//
// Build-side wiring lives in .github/workflows/android-build.yml — it
// (a) adds androidx.health.connect:connect-client to app/build.gradle,
// (b) declares the read permissions + provider <queries> tag in
//     AndroidManifest.xml, and (c) copies this file into the generated
// android/app/src/main/java/<pkg>/ tree.
//
// User-visible flow:
//   1. Settings → "Count steps while app is closed" toggle (the same
//      one iOS uses). Tap to enable.
//   2. The page calls Ped.requestAuth(); we launch the Health Connect
//      permission grant intent.
//   3. The user picks which data types to share with the app.
//   4. On every subsequent visibility=visible transition the page
//      calls Ped.getDistanceMeters({fromMs, toMs}); we aggregate
//      StepsRecord + DistanceRecord and resolve {meters, steps, ok}.
//
// IMPORTANT: appId in capacitor.config.json is currently
//   org.phylliidaassets.creaturecollect
// — if that ever changes, both this file's `package` line and the
// generated MainActivity.java's `package` line have to move together.

package org.phylliidaassets.creaturecollect;

import android.content.Intent;

import androidx.activity.result.ActivityResult;
import androidx.health.connect.client.HealthConnectClient;
import androidx.health.connect.client.PermissionController;
import androidx.health.connect.client.aggregate.AggregateMetric;
import androidx.health.connect.client.aggregate.AggregationResult;
import androidx.health.connect.client.permission.HealthPermission;
import androidx.health.connect.client.records.DistanceRecord;
import androidx.health.connect.client.records.StepsRecord;
import androidx.health.connect.client.request.AggregateRequest;
import androidx.health.connect.client.time.TimeRangeFilter;
import androidx.health.connect.client.units.Length;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.FutureCallback;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

import java.time.Instant;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "MotionPedometer")
public class HealthConnectStepPlugin extends Plugin {

    // Health Connect's default provider package. Pre-installed on
    // Android 14+ and via Play Store on Android 13-. Older Android
    // (< API 26 / 8.0) has no Health Connect at all.
    private static final String PROVIDER_PACKAGE = "com.google.android.apps.healthdata";

    // Fallback stride length when DistanceRecord isn't available.
    // 0.74 m is the average adult walking stride; we could expose a
    // user-configurable knob in Settings later but a single constant
    // keeps the first cut simple. Walking-vs-running detection would
    // pull the average up; not worth optimising until a user notices
    // their daycare distances feel off.
    private static final double STRIDE_METERS = 0.74;

    private HealthConnectClient client;
    private Set<String> permissions;

    // Worker thread for the async Health Connect callbacks. Single
    // thread is plenty — each query is independent and short.
    private final ExecutorService callbackExecutor = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        super.load();
        // Build the permission set once. We need *read* access on the
        // two data types the bridge cares about. The actual permission
        // strings come from HealthPermission, which knows the right
        // Android-permission ids per data type.
        permissions = new HashSet<>();
        permissions.add(HealthPermission.getReadPermission(StepsRecord.class));
        permissions.add(HealthPermission.getReadPermission(DistanceRecord.class));
        // Defer client creation to a guarded helper so a missing
        // Health Connect provider doesn't blow up the plugin load.
        // currentSnapshot() will report stepsAvailable=false in that
        // case and the page-side bridge degrades gracefully.
        tryInitClient();
    }

    private void tryInitClient() {
        if (client != null) return;
        try {
            int sdkStatus = HealthConnectClient.getSdkStatus(getContext(), PROVIDER_PACKAGE);
            if (sdkStatus == HealthConnectClient.SDK_AVAILABLE) {
                client = HealthConnectClient.getOrCreate(getContext());
            }
        } catch (Throwable t) {
            client = null;
        }
    }

    // ─── isAvailable ────────────────────────────────────────────
    //
    // Cheap snapshot of capability + auth state. The page-side bridge
    // calls this once on load to decide whether to surface the Settings
    // toggle at all. Resolved shape mirrors the iOS plugin:
    //   { stepsAvailable, distanceAvailable, authStatus, sdkStatus }
    // sdkStatus is Android-specific and useful for telemetry; iOS
    // consumers just ignore it.
    @PluginMethod
    public void isAvailable(PluginCall call) {
        // Re-probe in case Health Connect was installed *after* plugin
        // load (e.g., the user installed it from Play Store and came
        // back). One-shot, no-op if already initialised.
        tryInitClient();
        call.resolve(currentSnapshot());
    }

    // ─── requestAuth ────────────────────────────────────────────
    //
    // Triggers Health Connect's permission grant UI (a separate
    // activity, not an in-app dialog). The user picks which data types
    // to share. Resolved when control returns to our activity, with
    // the post-prompt snapshot.
    @PluginMethod
    public void requestAuth(PluginCall call) {
        tryInitClient();
        if (client == null) {
            // No Health Connect = nothing to ask for. Return the
            // current (unavailable) snapshot so the page can show a
            // "install Health Connect" hint in Settings.
            call.resolve(currentSnapshot());
            return;
        }
        try {
            Intent intent = PermissionController
                .createRequestPermissionResultContract()
                .createIntent(getContext(), permissions);
            // Capacitor's saved-call pattern. The callback below is
            // matched by method name.
            startActivityForResult(call, intent, "handlePermResult");
        } catch (Throwable t) {
            JSObject ret = currentSnapshot();
            ret.put("authStatus", "unknown");
            ret.put("error", t.getMessage() != null
                ? t.getMessage()
                : t.getClass().getSimpleName());
            call.resolve(ret);
        }
    }

    @ActivityCallback
    private void handlePermResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        // The ActivityResult itself doesn't tell us much — Health
        // Connect always returns RESULT_OK regardless of grant.
        // Re-query the granted permissions to compute the new state.
        call.resolve(currentSnapshot());
    }

    // ─── getDistanceMeters ──────────────────────────────────────
    //
    // Query Health Connect for the [fromMs, toMs] window and report
    //   { ok: Bool, meters: Double, steps: Int, error?: String }
    // ok=false means the caller MUST NOT advance its lastSync marker
    // (otherwise movement is silently lost — same invariant as the
    // iOS plugin).
    //
    // Distance comes from DistanceRecord.DISTANCE_TOTAL when present
    // (most accurate — sourced from the original device's pedometer).
    // Falls back to steps × stride when no Distance records exist for
    // the window. The aggregate covers ALL sources Health Connect
    // knows about, so a watch + phone walk pair sums correctly.
    @PluginMethod
    public void getDistanceMeters(PluginCall call) {
        tryInitClient();
        if (client == null) {
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("meters", 0);
            ret.put("steps", 0);
            ret.put("error", "health_connect_unavailable");
            call.resolve(ret);
            return;
        }
        Long fromMs = call.getLong("fromMs");
        Long toMs = call.getLong("toMs");
        if (fromMs == null || toMs == null || toMs <= fromMs) {
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("meters", 0);
            ret.put("steps", 0);
            ret.put("error", "invalid_window");
            call.resolve(ret);
            return;
        }
        TimeRangeFilter range = TimeRangeFilter.between(
            Instant.ofEpochMilli(fromMs),
            Instant.ofEpochMilli(toMs)
        );
        Set<AggregateMetric<?>> metrics = new HashSet<>();
        metrics.add(StepsRecord.COUNT_TOTAL);
        metrics.add(DistanceRecord.DISTANCE_TOTAL);
        AggregateRequest req = new AggregateRequest(metrics, range, new HashSet<>());
        final ListenableFuture<AggregationResult> future = client.aggregateAsync(req);
        Futures.addCallback(future, new FutureCallback<AggregationResult>() {
            @Override
            public void onSuccess(AggregationResult agg) {
                long steps = 0;
                Long stepCount = agg.get(StepsRecord.COUNT_TOTAL);
                if (stepCount != null) steps = stepCount;
                double meters = 0;
                Length distance = agg.get(DistanceRecord.DISTANCE_TOTAL);
                if (distance != null) {
                    meters = distance.getMeters();
                } else if (steps > 0) {
                    meters = steps * STRIDE_METERS;
                }
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("meters", meters);
                ret.put("steps", steps);
                call.resolve(ret);
            }
            @Override
            public void onFailure(Throwable t) {
                JSObject ret = new JSObject();
                ret.put("ok", false);
                ret.put("meters", 0);
                ret.put("steps", 0);
                ret.put("error", t.getMessage() != null
                    ? t.getMessage()
                    : t.getClass().getSimpleName());
                call.resolve(ret);
            }
        }, callbackExecutor);
    }

    // ─── helpers ───────────────────────────────────────────────

    private JSObject currentSnapshot() {
        int sdkStatus = -1;
        try {
            sdkStatus = HealthConnectClient.getSdkStatus(getContext(), PROVIDER_PACKAGE);
        } catch (Throwable ignored) {
            // Older Android (< API 26) doesn't have Health Connect at
            // all. The minSdk on the Capacitor 6 project should be
            // high enough that this path is rarely hit, but defensive
            // because a Play Store install bump can change it.
        }
        boolean available = (sdkStatus == HealthConnectClient.SDK_AVAILABLE);
        JSObject ret = new JSObject();
        ret.put("stepsAvailable", available);
        ret.put("distanceAvailable", available);
        ret.put("authStatus", resolveAuthStatus(available));
        ret.put("sdkStatus", sdkStatusToString(sdkStatus));
        return ret;
    }

    @SuppressWarnings("unchecked")
    private String resolveAuthStatus(boolean available) {
        if (!available || client == null) return "unknown";
        try {
            // Cheap blocking call — getGrantedPermissions is an in-
            // process IPC that returns in milliseconds. Acceptable on
            // the calling thread since isAvailable() is called rarely
            // (load + Settings open).
            Set<String> granted = (Set<String>) client.getPermissionController()
                .getGrantedPermissionsAsync().get();
            int got = 0;
            for (String p : permissions) {
                if (granted.contains(p)) got++;
            }
            if (got == permissions.size()) return "authorized";
            if (got > 0) return "partial";
            return "notDetermined";
        } catch (Throwable t) {
            return "unknown";
        }
    }

    private String sdkStatusToString(int s) {
        if (s == HealthConnectClient.SDK_AVAILABLE) return "available";
        if (s == HealthConnectClient.SDK_UNAVAILABLE) return "unavailable";
        if (s == HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED) {
            return "update_required";
        }
        return "unknown";
    }
}
