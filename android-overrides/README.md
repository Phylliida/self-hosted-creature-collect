# android-overrides

Native Android plugin source files that the build workflow copies into
the freshly-generated Capacitor Android project. Mirrors `ios-overrides/`
in shape and intent.

## Why this exists

The `android/` directory is gitignored — it's regenerated on every CI
build via `npx cap add android` + `npx cap sync android` (see
`.github/workflows/android-build.yml`). Anything we want to land in the
generated tree has to be applied as a build-time patch or copy.

Historically those patches lived inline in the workflow YAML as Python
heredoc-generated Java strings. Workable but unreadable. New native
files should live here as real `.java` files and be `cp`'d into the
right package directory by the workflow.

## Layout convention

```
android-overrides/
  <PluginName>.java         standalone Capacitor plugin
  <SupportingClass>.java    helper / service classes used by the plugin
  README.md                 this file
```

Each `.java` file declares
`package org.phylliidaassets.creaturecollect;` at the top, matching the
`appId` in `capacitor.config.json`. If the appId ever changes, both
these files and the workflow's `MainActivity.java` template need to
update in lockstep.

## How the workflow consumes them

In `android-build.yml`, after `cap sync android` finishes, there's a
copy step like:

```bash
for f in android-overrides/*.java; do
  cp "$f" "android/app/src/main/java/org/phylliidaassets/creaturecollect/$(basename "$f")"
done
```

The plugin then needs to be registered in `MainActivity.java`'s
`onCreate` — also handled by the workflow's MainActivity template
(search for `registerPlugin(...)`).

## Migrating existing inline plugins

`BackgroundLocationPlugin` and `LocationForegroundService` are still
inline-in-YAML at the time of writing. They can move here without
behavioural change — just lift the source out of the heredoc, drop
into this directory, and replace the heredoc with a `cp` step.
