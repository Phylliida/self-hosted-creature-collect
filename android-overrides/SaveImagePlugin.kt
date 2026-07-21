// Capacitor plugin: save a creature sprite straight into the Android
// photo gallery — the mirror of ios-overrides/SaveImagePlugin.swift.
//
// Why this exists: the web "Save image" flow (static/creatures.js
// saveImageToPhone) falls back to an <a download> click outside the
// share sheet, which in the Capacitor WebView either does nothing or
// drops the file into Downloads where the gallery never finds it.
// MediaStore.Images is the gallery-visible path on every API level.
//
// Permission model: on API 29+ (scoped storage) writing to
// Pictures/CreatureCollect via MediaStore needs NO permission at all.
// On API 26–28 (our minSdk is 26) WRITE_EXTERNAL_STORAGE is still
// required — declared in the manifest with android:maxSdkVersion="28"
// and requested at runtime here, only on those old devices.
//
// Contract (mirrors the iOS plugin exactly, so JS needs no branch):
//   saveImage({ base64, filename? }) -> { saved: true }
//   rejects with code "DENIED" (user refused storage access),
//   "BAD_INPUT" (undecodable data) or "SAVE_FAILED" (everything else).
//
// Registered from MainActivity's onCreate via
// registerPlugin(SaveImagePlugin.class), like the other plugins here.
// Copied into the generated package tree by the android-overrides step
// of .github/workflows/android-build.yml.

package org.phylliidaassets.creaturecollect

import android.Manifest
import android.content.ContentValues
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

@CapacitorPlugin(
    name = "SaveImage",
    permissions = [
        Permission(strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE], alias = "storageWrite"),
    ],
)
class SaveImagePlugin : Plugin() {

    @PluginMethod
    fun saveImage(call: PluginCall) {
        val base64 = call.getString("base64")
        if (base64.isNullOrEmpty()) {
            call.reject("No image data", "BAD_INPUT")
            return
        }
        if (Build.VERSION.SDK_INT <= 28 && ContextCompat.checkSelfPermission(
                context, Manifest.permission.WRITE_EXTERNAL_STORAGE
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            // Old devices only: ask, then continue in storageWriteCallback.
            requestPermissionForAlias("storageWrite", call, "storageWriteCallback")
            return
        }
        doSave(call, base64)
    }

    @PermissionCallback
    private fun storageWriteCallback(call: PluginCall) {
        if (getPermissionState("storageWrite") == PermissionState.GRANTED) {
            val base64 = call.getString("base64")
            if (base64 != null) doSave(call, base64) else call.reject("No image data", "BAD_INPUT")
        } else {
            call.reject("Storage permission denied — enable it in Settings", "DENIED")
        }
    }

    private fun doSave(call: PluginCall, base64: String) {
        val bytes = try {
            Base64.decode(base64, Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
            call.reject("Undecodable image data", "BAD_INPUT")
            return
        }
        val name = call.getString("filename")?.takeIf { it.isNotBlank() }
            ?: "creature-${System.currentTimeMillis()}"
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, "$name.png")
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
            if (Build.VERSION.SDK_INT >= 29) {
                put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/CreatureCollect")
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
        if (uri == null) {
            call.reject("MediaStore insert failed", "SAVE_FAILED")
            return
        }
        try {
            resolver.openOutputStream(uri)?.use { it.write(bytes) }
                ?: throw java.io.IOException("could not open output stream")
            if (Build.VERSION.SDK_INT >= 29) {
                values.clear()
                values.put(MediaStore.Images.Media.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
            }
            call.resolve(JSObject().put("saved", true))
        } catch (e: Exception) {
            // Don't leave a dangling empty gallery entry behind.
            try { resolver.delete(uri, null, null) } catch (_: Exception) {}
            call.reject("Save failed: ${e.message}", "SAVE_FAILED")
        }
    }
}
