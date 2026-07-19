---
title: can't tap away once throw pokeball
status: done
claimed_by: claude-opus
created: 2026-07-19T19:21:03Z
updated: 2026-07-19T20:05:00Z
taiga_id: 61
taiga_version: 1
synced_hash: 75c632ce0c1b7481
---

## Description
it should force user into the encounter screen until poke is caught or pokeball breaks out, right now it lets you click away (and then caught poke are still caught async and they pop up) which doesn't feel polished. You should be able to click away if pokeball isn't thrown yet tho

## Progress
- (2026-07-19) Traced the encounter ("battle screen") flow in `static/creatures.js`.
  The overlay `#battleScreen` is built in `ensureBattleScreen()`; two dismiss
  paths were wired there — the **Flee** button and a **backdrop tap-away**
  (`if (e.target === el) closeBattleScreen()`).
- The throw lifecycle is gated by module-scoped `_throwInFlight` (set true in the
  `throwBall` wrapper, reset in its `finally`), true for the *entire* animation
  chain — arc → wobble → caught/breakout. The `.throwing` CSS class already
  blanks `.battle-actions` (Flee + ball buttons) via `pointer-events:none`, but
  the backdrop handler lives on the root `el`, so it was NOT covered — a backdrop
  tap mid-throw ran `closeBattleScreen()` while the async catch kept resolving,
  and the caught creature popped up over the map. That's the reported bug.
- Fix: guard both dismiss handlers on `!_throwInFlight`. Before a throw the flag
  is false → dismiss freely; once a ball is thrown it stays true until the
  creature is caught or breaks out. The caught path calls `closeBattleScreen()`
  directly (not through these handlers), so navigating to the catch detail view
  is unaffected.
- Added `tests/encounter-throw-lock.test.js` (extracts the real handler wiring
  from `creatures.js` and runs it in a vm sandbox). 8 assertions, all pass. Full
  suite (37 files) green.

## Writeup
**What changed:** `static/creatures.js`, `ensureBattleScreen()` — the Flee and
backdrop click handlers now bail when `_throwInFlight` is true.

- Flee handler: `if (_throwInFlight) return;` before `closeBattleScreen()`
  (defense-in-depth; it was already blocked by the `.throwing` CSS, but now the
  lock is explicit in JS and independent of CSS timing).
- Backdrop handler: `if (e.target === el && !_throwInFlight) closeBattleScreen();`

**Why this is the right seam:** `_throwInFlight` is the single synchronous flag
that already bounds the whole throw→resolve window (`throwBall` sets it true,
its `finally` resets it). On **caught**, `_throwBallImpl` calls
`closeBattleScreen()` itself at the end of the animation — a direct call, so the
guard doesn't interfere and the player still lands on the catch detail view. On
**breakout**, `finally` flips the flag false and the encounter stays open, so the
player can throw again or flee — and tap-away/Flee work again immediately.

**Behaviour now:**
- Ball not thrown yet → tap backdrop or Flee dismisses the encounter (unchanged).
- Ball in flight → backdrop taps and Flee are ignored; the player is held in the
  encounter until the creature is caught or breaks out.

**Assumptions / scope:** There is no Escape-key or hardware-back dismiss path for
the battle screen (confirmed — the only `closeBattleScreen()` callers are these
two handlers plus the internal caught path), so no other entry point needed a
guard. Verified via the new headless test; not exercised in a live browser this
session (no runtime harness available here), but the change is a pure predicate
guard on an existing, well-understood flag.
