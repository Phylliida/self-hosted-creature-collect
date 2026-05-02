# Dev shell for self-hosted-creature-collect.
#
# Two toolchains coexist here:
#   1. Python + Flask + tile/POI tooling — runs the web app
#      (python3 run.py).
#   2. Node + JDK + Android SDK + libimobiledevice — for the
#      Capacitor wrapper that bundles the same site as a native
#      Android (and eventually iOS) app.
#
# The Python side is required just to run the existing PWA. The
# Capacitor side is only exercised when you want to build the
# native wrapper:
#   nix-shell             # drop into the shell
#   npm install           # one-time, after entering shell
#   npx cap add android   # one-time, generates the android/ project
#   cd android && ./gradlew assembleDebug
#   adb install android/app/build/outputs/apk/debug/app-debug.apk
#
# NOTES on iOS:
#   - The IPA *build* step still needs a Mac (Xcode + signing). Use
#     a cloud Mac / GitHub Actions runner for that.
#   - The libimobiledevice tools below let a Linux host TALK to an
#     iPhone over USB (idevice_id, ideviceinstaller, ifuse). They're
#     used by AltServer-Linux / SideStore for sideloading.
#   - usbmuxd has to run system-wide; it's NOT in this dev shell.
#     Add to /etc/nixos/configuration.nix:
#       services.usbmuxd.enable = true;
#       users.users.<you>.extraGroups = [ "usbmuxd" ];
#
# Android SDK is unfree-licensed; the import below opts in via
# config.android_sdk.accept_license = true. Drop that line if you'd
# rather review the license interactively.

{ pkgs ? import <nixpkgs> {
    config.allowUnfree = true;
    config.android_sdk.accept_license = true;
  }
}:

let
  # iLoader — Linux iOS sideloader (nab138/iloader on GitHub),
  # pulled in via flake. Requires flakes enabled in your nix config:
  #   nix.settings.experimental-features = [ "nix-command" "flakes" ];
  # To pin a specific revision (recommended once it's working), use
  #   "github:nab138/iloader/<commit-sha>"
  iloader = (builtins.getFlake "github:nab138/iloader").packages.${pkgs.system}.default;

  # Pin to a recent, stable Android API level + build-tools. Bump
  # together with Capacitor major version updates.
  androidPlatformVersion = "34";
  androidBuildToolsVersion = "34.0.0";

  androidComposition = pkgs.androidenv.composeAndroidPackages {
    platformVersions = [ androidPlatformVersion ];
    buildToolsVersions = [ androidBuildToolsVersion ];
    # Skip the emulator + system images — we install on a real
    # phone via USB. Cuts the SDK download from ~5GB to a few
    # hundred MB.
    includeEmulator = false;
    includeSystemImages = false;
    # arm64-v8a covers all modern phones; keep x86_64 in case
    # someone later wants the emulator.
    abiVersions = [ "arm64-v8a" "x86_64" ];
  };
  androidSdk = androidComposition.androidsdk;
in
pkgs.mkShell {
  packages = with pkgs; [
    # ── Python / Flask web app side ────────────────────────────
    python3
    python3Packages.flask
    python3Packages.shapely
    python3Packages.pyosmium
    tilemaker
    cloudflared
    git
    osmium-tool

    # ── Capacitor / Node toolchain ─────────────────────────────
    nodejs_20

    # ── Android build toolchain ────────────────────────────────
    jdk17
    androidSdk
    android-tools  # adb, fastboot
    gradle         # the project ships a wrapper, but a system gradle
                   # is handy for `gradle tasks` and one-off invocations

    # ── iOS device USB communication (sideloading via
    #    AltServer-Linux / SideStore later — IPA build still needs a Mac)
    libimobiledevice
    ifuse

    # ── iLoader — sideloads IPAs onto a connected iPhone. Built
    #    via Nix from the upstream flake, so no NixOS dynamic-
    #    linking workaround is needed (steam-run/nix-ld).
    iloader

    # ── GitHub CLI (used by install-ipa.sh to fetch the latest
    #    workflow artifact). One-time: `gh auth login`.
    gh
  ];

  shellHook = ''
    # Capacitor / Android env wiring.
    export ANDROID_HOME="${androidSdk}/libexec/android-sdk"
    export ANDROID_SDK_ROOT="$ANDROID_HOME"
    export JAVA_HOME="${pkgs.jdk17.home}"

    # Gradle's Maven-bundled aapt2 isn't ELF-compatible with NixOS;
    # redirect it at the SDK's own aapt2 binary.
    export GRADLE_OPTS="-Dorg.gradle.project.android.aapt2FromMavenOverride=$ANDROID_HOME/build-tools/${androidBuildToolsVersion}/aapt2"

    # Put adb + build-tools on PATH for convenience.
    export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/build-tools/${androidBuildToolsVersion}:$PATH"
  '';
}
