---
title: imported save should win for units / creature sort / trainer name too
status: done
claimed_by: claude-opus
created: 2026-07-19T20:40:00Z
updated: 2026-07-19T21:20:00Z
---

## Description

Follow-up from `lock-rotate-and-all-other-settings-stored-to-sav`.

The settings added to the new `SAVED_SETTINGS` table now let the imported save win
over whatever is in local storage. But several older settings still use a
first-write-only guard in `importData()` (`static/index.html`):

- `cc.units` — `if (data.units && !localStorage.getItem('cc.units'))`
- `cc.creatureSortBy`, `cc.creatureSortDir`, `cc.creatureMode`
- `cc.backupName`

Effect: load your backup onto a device where you have *ever* touched Units, and the
saved value is silently ignored. `cc.theme` was already fixed for exactly this reason
(there's a comment in the code about it) — these were just missed.

Separately, `cc.creatureMode` has an asymmetry: its default is `'1'` when unset
(`creatures.js`, `v === null || v === '1'`), but the payload writes the raw
`getItem` result, so a never-touched toggle serializes as `null` and is skipped on
import. Only an explicitly-flipped value round-trips.

Not done in the original task because it changes the behaviour of already-shipped
settings for real users, which deserves its own deliberate change.

Done = these settings follow the same "the save wins" policy as everything else, the
`creatureMode` default is serialized explicitly, and `tests/settings-persistence.test.js`
grows cases for them.

## Progress
- (2026-07-19) Implemented. Added `restoreLegacyTopLevelSettings(data)` in
  `static/index.html`, next to `restoreSavedSettings`. It restores `cc.units`,
  `cc.creatureSortBy`, `cc.creatureSortDir`, `cc.creatureMode`, and
  `cc.backupName` with the same "the save wins" policy as `cc.theme` /
  SAVED_SETTINGS, and validates each value against its reader (units m/mi; sort
  keys level/size/name/species/recent; dirs asc/desc; mode 0/1; backupName
  trimmed + capped at 40). Replaced the two inline first-write-only guard blocks
  in `importData()` with a single call to the helper.
- (2026-07-19) Export now serializes the creatureMode default explicitly
  (`localStorage.getItem('cc.creatureMode') || '1'`) so a never-touched ON toggle
  crosses the wire instead of serializing as null (which the restore skips).
- (2026-07-19) Grew `tests/settings-persistence.test.js` (+3 sections, 85
  assertions total, all pass): save-wins override, junk/blank/non-string
  rejection + trim/cap, and source-level guards that the explicit default and
  helper wiring are in place and the old first-write-only guards are gone.
- (2026-07-19) Full suite: 35/36 files pass; the only red is `bridges.test.js`,
  a main-thread-yield *timing* test that's flaky under machine load (passed on
  re-run) and untouched by this change.

## Writeup
The old `importData()` restored these five legacy top-level settings behind a
`!localStorage.getItem(key)` guard — so once you'd touched Units (or sort/mode/
name) on a device, re-loading your backup there silently kept the local value.
`cc.theme` had already been fixed to "the save wins" for the same reason; these
were just missed.

**Change:** a new `restoreLegacyTopLevelSettings(data)` helper (grouped with the
other restore logic) writes each key when the incoming value validates, always
overriding the local value. It mirrors each key's own reader for validation, so
a hand-edited/older save can't inject junk. UI side effects that used to sit
inline (units `<select>` + map scale control; the backup-name input) moved into
the helper, each wrapped in its own `try` since import doesn't reload the page —
a missing control can't abort the localStorage write. The two inline guard
blocks in `importData()` collapsed into a single call.

**creatureMode asymmetry fix:** its default is ON when unset
(`readEnabled: v === null || v === '1'`), but the payload wrote the raw
`getItem()` (null for a never-touched toggle), and the restore skips null — so an
implicit ON never round-tripped. The export now writes the effective value
(`... || '1'`); explicit '0' still round-trips.

**Tests:** extended `tests/settings-persistence.test.js` — extracts the helper
+ its three validation-list consts into the vm sandbox (with `unitsSelect` /
`scaleCtrl` / `backupName` stubs so the inline UI side effects are observable),
and adds sections 9–11 covering override-wins, validation/rejection/trim-cap, and
source-level assertions for the explicit default and helper wiring.

**Assumptions / notes:**
- Backup name is trimmed and capped at 40 (matching the input's `maxlength`); the
  live input handler already stores trimmed values, so this only guards
  hand-edited saves.
- This deliberately changes behaviour for already-shipped settings on real users'
  devices (the whole point): loading a save is now an explicit "make this device
  match" for these keys too.
- Not touched: pedometer / autoBackup / regionsMode / radarAutogenLabels keep
  their bespoke restore paths (pedometer's is bound to a native permission prompt
  and a sync-marker seed and must not be flipped on blindly).
