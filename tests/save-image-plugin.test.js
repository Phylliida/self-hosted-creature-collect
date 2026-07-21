// Guards the native "save sprite to photo library" path (long-press a
// creature's art → Save image). Mostly wiring invariants: the feature
// lives across two native plugins + two CI workflows + the web layer,
// and any one of them drifting silently breaks saving on device.
//
//   (1) iOS plugin — exists, exposes jsName "SaveImage" + saveImage,
//       registered in AppBridgeViewController, added to the Xcode
//       project by inject-into-xcodeproj.rb, copied by ios-build.yml,
//       and NSPhotoLibraryAddUsageDescription is patched into Info.plist
//       (without it the save silently never lands).
//   (2) Android plugin — exists, same jsName/contract, registered in the
//       MainActivity template, and WRITE_EXTERNAL_STORAGE (maxSdk 28,
//       pre-scoped-storage devices only) is injected into the manifest.
//   (3) Web layer — creatures.js prefers Capacitor.Plugins.SaveImage,
//       handles DENIED distinctly, and has the result-notice UI.
//   (4) Contract parity — both plugins resolve {saved} and reject with
//       the same DENIED / BAD_INPUT / SAVE_FAILED codes (the JS branches
//       on these, so they must match on both platforms).
//
// Run: node tests/save-image-plugin.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// --- 1) iOS plugin ------------------------------------------------------------
const ios = read('ios-overrides/SaveImagePlugin.swift');
ok(ios.includes('public let jsName = "SaveImage"'), 'iOS: plugin exposed as Capacitor.Plugins.SaveImage');
ok(ios.includes('CAPPluginMethod(name: "saveImage"'), 'iOS: saveImage method declared');
ok(/authorizationStatus\(for: \.addOnly\)/.test(ios), 'iOS: checks add-only photo authorization');
ok(ios.includes('UIImageWriteToSavedPhotosAlbum'), 'iOS: saves via UIImageWriteToSavedPhotosAlbum (self-prompting add-only write)');

const vc = read('ios-overrides/AppBridgeViewController.swift');
ok(vc.includes('registerPluginInstance(SaveImagePlugin())'), 'iOS: plugin registered in AppBridgeViewController');
const rb = read('ios-overrides/inject-into-xcodeproj.rb');
ok(rb.includes("'SaveImagePlugin.swift'"), 'iOS: plugin added to the Xcode project by inject-into-xcodeproj.rb');
const iosYml = read('.github/workflows/ios-build.yml');
ok(iosYml.includes('cp ios-overrides/SaveImagePlugin.swift'), 'ios-build.yml: plugin copied into the generated project');
ok(iosYml.includes('Add :NSPhotoLibraryAddUsageDescription string'),
  'ios-build.yml: NSPhotoLibraryAddUsageDescription patched into Info.plist');

// --- 2) Android plugin ----------------------------------------------------------
const kt = read('android-overrides/SaveImagePlugin.kt');
ok(kt.includes('name = "SaveImage"'), 'Android: plugin exposed as Capacitor.Plugins.SaveImage');
ok(kt.includes('fun saveImage(call: PluginCall)'), 'Android: saveImage method declared');
ok(kt.includes('MediaStore.Images'), 'Android: saves via MediaStore.Images (gallery-visible)');
ok(kt.includes('WRITE_EXTERNAL_STORAGE') && kt.includes('SDK_INT <= 28'),
  'Android: legacy storage permission only requested on API ≤ 28');
const andYml = read('.github/workflows/android-build.yml');
ok(andYml.includes('registerPlugin(SaveImagePlugin.class)'),
  'android-build.yml: plugin registered in the MainActivity template');
ok(/WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28"/.test(andYml),
  'android-build.yml: WRITE_EXTERNAL_STORAGE (maxSdkVersion 28) injected into the manifest');

// --- 3) web layer ---------------------------------------------------------------
const js = read('static/creatures.js');
ok(js.includes('Capacitor.Plugins.SaveImage'), 'creatures.js: prefers the native SaveImage plugin');
ok(js.indexOf('Capacitor.Plugins.SaveImage') < js.indexOf('navigator.canShare'),
  'creatures.js: plugin path runs BEFORE the share-sheet/download fallbacks');
ok(js.includes("'DENIED'") && /Settings/.test(js),
  'creatures.js: DENIED handled with a point-at-Settings message');
ok(js.includes('save-image-notice'), 'creatures.js: save-result notice styled + used');

// --- 4) contract parity -----------------------------------------------------------
for (const code of ['DENIED', 'BAD_INPUT', 'SAVE_FAILED']) {
  ok(ios.includes(`"${code}"`), `iOS: rejects with code ${code}`);
  ok(kt.includes(`"${code}"`), `Android: rejects with code ${code}`);
}
ok(ios.includes('"saved": true') && kt.includes('"saved", true'),
  'both: resolve a saved:true result');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
