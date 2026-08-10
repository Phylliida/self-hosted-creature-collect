// Capacitor plugin: focus-mode event timeline — the Android mirror of
// ios-overrides/FocusMonitorPlugin.swift.
//
// Focus mode (static/creatures.js) accrues rewards while the app is
// foreground OR the device is asleep; backgrounding the app while the
// screen is on pauses accrual. The WebView is suspended in the
// background (and JS timers don't run while the screen is off), so JS
// can't observe these transitions itself — this plugin records a
// timestamped event log natively and hands it to JS on demand:
//
//   startSession() -> { screenOff, appForeground }
//       Begins recording; returns the current state so JS can seed its
//       replay. Idempotent — restarting a session clears the buffer.
//   getEvents({ sinceMs }) -> { events: [{ t, type }] }
//       Events with t > sinceMs, oldest first; the returned events are
//       dropped from the buffer (consumptive read). Types:
//         screen_on / screen_off   (ACTION_SCREEN_ON / _OFF)
//         app_fg    / app_bg       (activity resume / pause)
//   endSession()  -> stops recording, clears the buffer.
//
// Notes:
//   - No manifest entry or permission needed: the receiver is registered
//     at runtime (Context-registered receivers still get screen
//     broadcasts, which are exempt from the manifest-registration ban).
//   - screen_on fires when the display wakes (lock screen visible),
//     not just on unlock — so lock-screen glance time counts as paused.
//     Deliberate: qualifying = "screen off OR app foreground".
//   - If the process dies mid-session the buffer dies with it; JS
//     treats a missing timeline as "state unchanged since last settle"
//     (safe direction: a backgrounded app reads as paused).
//   - Buffer is capped; a pathological session (days of screen toggling)
//     sheds its oldest events, which at worst under-counts qualifying
//     time slightly.
//
// Registered from MainActivity's onCreate via
// registerPlugin(FocusMonitorPlugin.class), like the other plugins
// here. Copied into the generated package tree by the
// android-overrides step of .github/workflows/android-build.yml.

package org.phylliidaassets.creaturecollect

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "FocusMonitor")
class FocusMonitorPlugin : Plugin() {

    companion object {
        // ~4 days of aggressive screen toggling; far beyond any real
        // session between settles (JS pulls every 60s while foreground).
        private const val MAX_EVENTS = 500
    }

    private val lock = Object()
    private val events = ArrayList<JSObject>()
    private var receiver: BroadcastReceiver? = null

    private fun record(type: String) {
        val e = JSObject()
        e.put("t", System.currentTimeMillis())
        e.put("type", type)
        synchronized(lock) {
            if (events.size >= MAX_EVENTS) events.removeAt(0)
            events.add(e)
        }
    }

    @PluginMethod
    fun startSession(call: PluginCall) {
        synchronized(lock) { events.clear() }
        registerReceiverIfNeeded()
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val interactive = try { pm?.isInteractive ?: true } catch (e: Exception) { true }
        val ret = JSObject()
        ret.put("screenOff", !interactive)
        // If JS is calling us, the WebView is alive — the app is foreground.
        ret.put("appForeground", true)
        call.resolve(ret)
    }

    @PluginMethod
    fun getEvents(call: PluginCall) {
        val sinceMs = call.getLong("sinceMs") ?: 0L
        val out = JSArray()
        synchronized(lock) {
            val it = events.iterator()
            while (it.hasNext()) {
                val e = it.next()
                if (e.getLong("t") > sinceMs) {
                    out.put(e)
                    it.remove()
                }
            }
        }
        val ret = JSObject()
        ret.put("events", out)
        call.resolve(ret)
    }

    @PluginMethod
    fun endSession(call: PluginCall) {
        unregisterReceiver()
        synchronized(lock) { events.clear() }
        call.resolve()
    }

    // App background / foreground — Plugin lifecycle hooks fire on the
    // hosting activity's pause/resume. Screen-off also pauses the
    // activity, so a sleep transition arrives as app_bg + screen_off
    // (order varies); the JS replay treats either as sufficient for
    // qualifying, so ordering doesn't matter.
    override fun handleOnResume() {
        if (receiver != null) record("app_fg")
        super.handleOnResume()
    }

    override fun handleOnPause() {
        if (receiver != null) record("app_bg")
        super.handleOnPause()
    }

    private fun registerReceiverIfNeeded() {
        if (receiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                when (intent.action) {
                    Intent.ACTION_SCREEN_OFF -> record("screen_off")
                    Intent.ACTION_SCREEN_ON -> record("screen_on")
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            context.registerReceiver(r, filter)
        }
        receiver = r
    }

    private fun unregisterReceiver() {
        val r = receiver ?: return
        try { context.unregisterReceiver(r) } catch (e: Exception) { /* already gone */ }
        receiver = null
    }
}
