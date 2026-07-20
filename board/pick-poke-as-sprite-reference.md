---
title: pick poke as sprite reference
status: done
claimed_by: claude-opus
created: 2026-07-20T16:29:35Z
updated: 2026-07-20T16:29:35Z
taiga_id: 164
taiga_version: 4
synced_hash: a118aedd12775411
---

## Description
In the Pixel Art editor, let the user pick a Pokémon (species or fusion) and use
its sprite as the tracing **reference image** — the same underlay that
"Choose image…" currently loads from a file. This builds on the recently-added
reference-image system (opacity, flip/rotate, extract palette).

"Done" looks like: a "Pick a Pokémon…" button in the reference popover that opens
a small picker (search by name, optionally head + body for a fusion), previews the
sprite, and on confirm sets it as the reference (persisted like any other ref).

## Progress
- (2026-07-20) Oriented. Pixel Art runs as a same-origin iframe
  (`/static/pixelart/index.html`) inside Extras; it already reaches
  `window.parent.Capacitor` (app.js:1298), so parent APIs are reachable.
  - Parent exposes `window.Species` (allSpecies / ensureLoaded / nameFor) and
    `window.Sprites.getDefaultSpriteBlob(a,b)` (a=head, b=body, both 1-indexed;
    a===b = pure species). Returns a Blob (best variant, autogen fallback).
  - Reference setter is `setReference(dataUrl, persist)` in app.js; popover menu
    system is `toggleMenu('refPanel')`, IDs in MENU_IDS. Wiring at app.js:1345+.
  - Plan: add "Pick a Pokémon…" button in refPanel → small modal with Head/Body
    name inputs (datalist autocomplete from parent Species) + preview + "Use as
    reference". Fetch blob from parent, convert to PNG data URL in the child
    (preserve alpha, native size, no smoothing), then setReference(url, true).
    Guard when there's no parent/Sprites (standalone) → hide the button.
- (2026-07-20) Implemented + tested. Bounced the UX off the local model — it
  recommended a single field + "Fusion" toggle over always-two-inputs (less
  cognitive load for the common case), which I adopted.

## Writeup
**What shipped.** A "Pick a Pokémon…" button in the Pixel Art reference popover
opens a small modal (reusing the app's existing `.overlay`/`.card` styling) that
lets you set a Pokémon sprite as the tracing reference underlay — the same slot
"Choose image…" fills from a file.

**UX.** One name field ("Pokémon") + a "Fusion — trace a head + body pair"
checkbox. Ticking it relabels the first field to "Head" and reveals a "Body"
field. Both fields autocomplete off a `<datalist>` of species names. A live,
debounced (220 ms) preview shows the resolved sprite on a checkerboard; "Use as
reference" is enabled only once a valid sprite is loaded. Names resolve
case-insensitively; a bare dex number or `#25` also works.

**How it works (the cross-frame bit).** Pixel Art runs as a same-origin iframe,
so it reaches the host frame via `window.parent` (there was already precedent —
`app.js` grabs `window.parent.Capacitor`). `pokeHost()` returns whichever frame
carries `Species` + `Sprites.getDefaultSpriteBlob` (checks `window` first, then
`window.parent`), or `null` when run standalone — in which case the button stays
hidden. On confirm we:
  1. `host.Species.ensureLoaded()` + `allSpecies()` → build the name→id map +
     datalist (once; behind the explicit tap, so it respects the "no automatic
     network" rule — and it's local data in the Capacitor builds anyway).
  2. `host.Sprites.getDefaultSpriteBlob(head, body)` → a `Blob` (best variant,
     autogen fallback; `head===body` for a pure species).
  3. Convert **in the child frame**: `URL.createObjectURL(blob)` → `<img>` →
     draw to a canvas at native size with `imageSmoothingEnabled=false` →
     `toDataURL('image/png')`. PNG (not the file path's JPEG) preserves the
     sprite's transparency, and native size + no smoothing keeps it crisp for
     tracing. We deliberately pass the **Blob** across the frame boundary (not
     the parent's object URL) and re-create the object URL locally, so the URL
     lives in the child's registry.
  4. `setReference(dataUrl, true)` — persists to `localStorage` (REF_KEY) and
     flows through the existing opacity / flip / rotate / extract-palette
     controls unchanged.

**Files.** `static/pixelart/index.html` (button, modal, CSS),
`static/pixelart/app.js` (picker module + `wirePokePicker()` in `init`),
`tests/pixelart-poke-reference.test.js` (new).

**Verification.** `tests/pixelart-poke-reference.test.js` extracts the picker
block and runs it against a hand-rolled DOM/host stub (same style as the repo's
other tests): 23 assertions covering host detection, name/number/# resolution,
datalist population, pure-species vs fusion blob requests, the incomplete-fusion
guard, the confirm→`setReference` PNG-data-URL handoff, and the no-sprite path.
All pass. `node --check` passes on app.js.

**Assumptions / notes (unverified in a real browser here).**
- Passing a parent-realm `Blob` to child `URL.createObjectURL` and drawing it to
  a canvas is standard for same-origin frames and shouldn't taint the canvas;
  not exercised in a live WebView this session.
- In web builds with sprites not yet downloaded, `getDefaultSpriteBlob` returns
  null and the modal shows "No sprite for that pick. (Download sprites first?)".
  The real users are on the bundled iOS/Android builds, so sprites are local.
- The picker offers any species/fusion by name (not limited to seen/caught), on
  the assumption a tracing reference should let you draw anything. Easy to
  restrict to `seenFusions` later if that's preferred.
