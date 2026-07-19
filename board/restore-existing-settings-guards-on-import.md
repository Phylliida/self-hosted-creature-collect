---
title: imported save should win for units / creature sort / trainer name too
status: todo
claimed_by: 
created: 2026-07-19T20:40:00Z
updated: 2026-07-19T20:40:00Z
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
