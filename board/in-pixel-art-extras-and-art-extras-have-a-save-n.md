---
title: in pixel art extras and art extras have a save new button and a save buttonm, save overwrites prior named save
status: done
claimed_by: claude-opus
created: 2026-07-20T16:29:35Z
updated: 2026-07-20T17:20:00Z
taiga_id: 167
taiga_version: 2
synced_hash: cf37bbac9eab75be
---

## Description
The Extras mini-apps (Pixel Art, Draw — and by extension Synth/Quiver) had a
single **Save** button that always minted a *new* record (id-keyed). Saving twice
with the same name silently created duplicates, and there was no way to update the
drawing you had loaded. Wanted: a **Save New** button (always a fresh named save)
and a **Save** button that overwrites the prior named save in place.

## Progress
- (2026-07-20) Traced the save path. All four Extras apps share one factory,
  `makeAppWindow` in `static/extras-apps.js`. The old Save button opened a name
  overlay and always did `store.put({ id: newId(), name, ... })`; records are
  keyed by `id` in IndexedDB (`cc-extras-apps-v1`), so `put` overwrites by id.
- Brainstormed the UX + edge cases with the local model (bar overflow on phones;
  the "New canvas then Save clobbers the loaded drawing" footgun; set-current-on-
  load ordering). Confirmed the `currentRec` model below.
- Implemented in the shared factory (so Pixel Art, Draw, Synth, Quiver all get it).
- Added an integration test that loads the real IIFE in a `vm` with a selector-
  keyed DOM stub + in-memory fake IndexedDB and drives the actual button handlers.
  `node tests/extras-save-overwrite.test.js` → 18 passed, 0 failed.

## Writeup
**What changed** (`static/extras-apps.js`, shared `makeAppWindow`):

- New window state `currentRec = { id, name, createdAt } | null` — the named
  record the working doc maps to. Set when you **Save New** or load one from the
  browse list; cleared by **New**.
- Bar now has **Save** + **Save New**, and the old text "Saved" button became an
  icon (folder glyph, `ICON_FOLDER`) to reclaim width. Responsive CSS
  (`@media (max-width: 430px)`) tightens button padding/gaps so the row
  (New · Save · Save New · Saved · undo/redo/close) doesn't push Close off the
  right edge on a 375px phone.
- **Save New** (`.exapp-savenew`) → always opens the name overlay → `doSaveNew()`
  creates a fresh `{ id: newId(), ... }` record and adopts it as `currentRec`.
- **Save** (`.exapp-save`) → if `currentRec`, `overwriteCurrent()` re-captures the
  doc (data + thumbnail) and `put`s it under the same id/name (stamping
  `updatedAt`), no prompt. If nothing is loaded yet, it falls back to the name
  overlay (so a first Save still works).
- Loading from the browse list sets `currentRec = { id, name, createdAt }` before
  the toast, so a subsequent Save overwrites the loaded record.
- **New** clears `currentRec` via a new `actionApi.clearCurrent()` (wired into the
  Draw "New", Synth "Clear", and Pixel Art "New" lead actions). This prevents a
  blank canvas from silently overwriting the drawing you had loaded.
- A `saving` guard blocks a double-tap from creating duplicate records.

**Design notes / assumptions:**
- The split lives in the shared factory, so it applies to all four Extras apps,
  not just Pixel Art and Draw. That's intentional (consistency) and equally
  useful for Synth songs / Quivers.
- Pixel Art's **New** opens the app's *own* size dialog inside the iframe, which
  may be cancelled. We clear `currentRec` on the New click regardless. If you
  cancel, the next Save just falls back to prompting for a name — a safe
  direction (never data loss / never a surprise overwrite).
- `updatedAt` is stored on overwrites but the browse list still sorts by
  `createdAt`, so overwriting keeps a drawing in its place (doesn't jump it to the
  top). Left as-is; easy to switch to `updatedAt || createdAt` later if desired.
- Static assets are served straight from `static/` (`run.py` `/static/<path>`), so
  no dist rebuild is needed for the web app. Native (Capacitor) builds would pick
  this up on their next bundle.

**Verification:** `tests/extras-save-overwrite.test.js` exercises the full state
machine end-to-end through the real handlers: Save New → one record; Save →
overwrite in place (same id, refreshed data, `updatedAt` set); Save New again →
second record; load Dog from the list then Save → Dog updated, Cat untouched;
New → Save opens the overlay instead of clobbering. `node --check` passes.
