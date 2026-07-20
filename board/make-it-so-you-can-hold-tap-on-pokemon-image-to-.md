---
title: make it so you can hold tap on pokemon image to save to phone
status: done
claimed_by: claude-opus
created: 2026-07-20T16:29:35Z
updated: 2026-07-20T16:29:35Z
taiga_id: 165
taiga_version: 2
synced_hash: 1e4128c6599a14cd
---

## Description
Long-press ("hold tap") on a pokémon's image in the detail view should let the
user save that sprite to their phone.

## Progress
- (2026-07-20) The detail-view art (`.detail-art-img`) is a `blob:` object URL
  minted by SpriteStore. Investigated save paths for the Capacitor/iOS/Android
  WebView + desktop targets. Key gotchas:
  - iOS WKWebView ignores `<a download>` for blob URLs, and the OS's own
    long-press "Save Image" also fails on `blob:` URLs → the reliable
    "Save to Photos" path on mobile is the Web Share sheet.
  - `navigator.share()` needs *transient user activation*, which a
    setTimeout-driven long-press would already have spent. So the long-press
    only *reveals* a "Save image" button; the share fires from that button's
    own tap (a fresh activation). (Confirmed this reasoning with the local
    model too.)
- (2026-07-20) Implemented in `static/creatures.js`:
  - `saveImageToPhone(img, filename)` — fetch the blob, prefer
    `navigator.share({files})`, fall back to an `<a download>` click.
  - `attachLongPressSave(artEl, img, getFilename)` — 480ms hold reveals a
    centered "Save image" pill over the art; drift >12px (a scroll) cancels;
    outside-tap / 4s auto-dismiss.
  - `_safeFileName()` — sanitizes the nickname/species name into a filename.
  - Wired into both detail views: captured-creature detail (`renderDetail`,
    filename = nickname/species name) and the fusion/species dex header
    (`renderFusionView`, filename = fused name or `A-B`).
  - CSS: `.detail-art-save-btn` pill + pop animation, and
    `-webkit-touch-callout/user-select:none` on `.detail-art` so the native
    callout doesn't fight our button. Desktop right-click "Save image as" is
    preserved (contextmenu only suppressed for touch pointers).
- (2026-07-20) Verified logic end-to-end with a DOM-mock harness exercising the
  real extracted functions. All pass: long-press reveals button → click →
  `navigator.share` with a `File`; scroll cancels the hold; canShare-absent
  falls back to `<a download>`; filenames sanitize; desktop right-click neither
  spawns our button nor suppresses the native menu. `node --check` clean.

## Writeup
**What was done:** Added a long-press-to-save gesture on the large pokémon art
in both detail views (captured-creature detail and the fusion/species dex
header).

**How it works (all in `static/creatures.js`):**
1. `attachLongPressSave(artEl, img, getFilename)` attaches pointer handlers to
   the `.detail-art` box. A ~480ms hold (that doesn't drift into a scroll)
   reveals a small centered "Save image" button over the art. Tapping it saves;
   tapping elsewhere or waiting 4s dismisses it.
2. The button's *own tap* calls `saveImageToPhone(img, filename)`, so
   `navigator.share()` runs with a fresh user activation (the reason for the
   two-step reveal-then-tap flow rather than sharing straight from the timer).
3. `saveImageToPhone` fetches the sprite blob from the img's `blob:` URL, then:
   - Mobile: `navigator.canShare({files})` → `navigator.share({files})` opens
     the native share sheet ("Save to Photos" / "Save Image"). AbortError
     (user dismissed) is swallowed.
   - Desktop / Android Chrome fallback: an `<a download="<name>.png">` click.
4. `-webkit-touch-callout/user-select:none` on `.detail-art` stops the native
   long-press callout from fighting our button on touch; desktop right-click
   "Save image as" is deliberately left working (contextmenu is only
   preventDefault'd when the last pointer was touch).

**Verified:** Core gesture + both save paths + filename sanitization + the
desktop-right-click carve-out, via a Node DOM-mock harness driving the real
extracted functions (all green), plus `node --check`.

**Not verified (needs a real device):** the actual iOS/Android native
share-sheet UX (whether "Save to Photos" appears and writes a valid PNG from
the shared File) and the on-screen look of the pill button. The blob→File→share
path is the standard, widely-working approach, but on-device confirmation is the
honest next check. Also: this only covers the two large detail-view arts, not
every sprite in the app (grid tiles, map markers, battle) — those felt out of
scope for "the pokémon image" but could be added the same way if wanted.
