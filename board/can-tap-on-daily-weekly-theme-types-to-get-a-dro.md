---
title: Can tap on daily weekly theme types to get a dropdown (similar styling as the daycare i dropdown) that explains the odds of pokemon dropping that day in a helpful diagram
status: done
claimed_by: claude-opus
created: 2026-07-13T18:32:15Z
updated: 2026-07-13T18:32:15Z
---

Doesn't need to describe all the pokemon available just the relative probabilities of each type of pokemon on that day (with an "all other types" category for the catch all things)

## Progress
- (2026-07-13) Investigated. Weather chips render in `renderWeatherBar()` (creatures.js:~11391): "Today: <chip>  Week: <chip>". Spawn odds live in spawns.js `_composePairSampler` — a 9-bucket mixture over (primaryType, secondaryType) pairs; every spawn is a two-type fusion whose primary=slotA type, secondary=slotB type. Buckets are symmetric in A/B. Nominal per-slot marginal ≈ Daily 41% / Weekly 29% / Other 30%, BUT empty pools (e.g. no FLYING-primary species) shift realized odds a lot, so computing from the actual sampler is the honest approach.
- Plan: add `Spawns.typeOdds(nowMs)` (realized per-slot type shares from the live sampler) → render a segmented odds bar (reuse `cc-oddsbar` + `_openInfoModal`) opened by tapping the weather chips.
- (2026-07-13) Implemented + tested. All 3216 assertions in tests/theme-odds.test.js pass; full suite green (pre-existing unrelated trip-planner.test.js failure `planTransitTrip is not a function` untouched).

## Writeup
**What it does:** The "Today: <chip> Week: <chip>" weather row at the top of the
Pokémon browse view is now a tappable button (with a small ⓘ affordance). Tapping
it opens the shared info modal (`_openInfoModal`) titled "Today's spawn odds" with a
segmented bar showing the realized type mix of today's spawns: **today's type /
this week's type / all other types**, plus a short "how the boost works" section.

**Odds source (honest, not nominal):** Added `Spawns.typeOdds(nowMs)` in
static/spawns.js. Every wild spawn is a two-type fusion (primary = sampler slot A,
secondary = slot B), so each spawn contributes two "type slots". `typeOdds` builds
the *actual* pair sampler (`_composePairSampler`) for the current weather and sums
each entry's raw weight into both its slot-A and slot-B type, then normalizes by
`2 * total`. This yields the true per-slot marginal, which already accounts for
empty species pools — e.g. FLYING has no gen-1 primary species, so on a FLYING day
the realized primary-slot share is 0 and the renormalization is honest. Nominal
bucket weights (~Daily 41 / Weekly 29 / Other 30) would have over-promised. Returns
`{daily, weekly, same, dailyShare, weeklyShare, otherShare, perType}`; `same` marks
daily===weekly (one type boosted on both channels → single merged segment).

**UI:** creatures.js `_themeOddsHtml()` / `_showThemeOdds()` build the copy and open
the modal, reusing the existing `cc-oddsbar` / `cc-info-section` styling from the
incense explainer. `_ccOddsSeg` / `_ccOddsLegend` are small render helpers (segment
flex = round(share*100), floored at 3 so a boosted-but-tiny slice stays visible).
The weather-row was changed from a `<div>` to a `<button>` (CSS reset + hover pill);
`renderWeatherBar()` wires the click. The modal appends to `document.body` and
stacks above the inventory panel, same as the incense/guaranteed-catch popups.

**Tests:** tests/theme-odds.test.js. Part 1 loads spawns.js for real against the
bundled species-types.json (via a `Species.typesFor` stub) and sweeps 400 UTC days
asserting: perType sums to 1, the 3 headline slices partition to 1, shares mirror
perType, boosted types sit well above the background rate, and both the distinct and
same-type weather cases occur. Part 2 vm-extracts the render helpers and checks the
distinct (3 segments) / same (2 segments, merged legend) / loading (null) branches,
type names, percentages, colors, and the "N other types" note.

**Assumptions / notes:** (1) Odds are per *type-slot* (a fusion counts twice), which
I judged the most legible honest framing for a two-type-fusion game; the copy says so
explicitly. (2) Percentages are rounded and, in rare same-weather-with-sparse-pool
cases, the two shown segments still sum to 100 by construction. (3) The modal only
opens from the browse view, where species data is already loaded, so the null branch
is a safety net rather than a common path.
