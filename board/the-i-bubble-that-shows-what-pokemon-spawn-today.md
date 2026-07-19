---
title: the i bubble that shows what pokemon spawn today improvements
status: done
claimed_by: claude-opus
created: 2026-07-13T20:42:17Z
updated: 2026-07-13T21:40:00Z
taiga_id: 59
taiga_version: 1
synced_hash: 21d88e86a38f468f
---

it should show more detailed info of prs of daily x _ and _ x daily and weekly x _ and _ x weekly and daily x weekly and weekly x daily and _ x _

## Progress
- (2026-07-13) Picked up. Builds directly on the completed theme-odds dropdown
  (`can-tap-on-daily-weekly-theme-types-to-get-a-dro`). The current modal shows
  only the per-slot marginal bar (today / this week / other). This task wants the
  **joint pair** breakdown: since every spawn is a two-type fusion (primary=slot A,
  secondary=slot B), enumerate the odds over the 3×3 grid of {daily, weekly, other}
  × {daily, weekly, other} = exactly the 9 mixture buckets in `_composePairSampler`.
- Plan: add `Spawns.typePairOdds(nowMs)` (reads the live sampler, classifies each
  entry's a/b type into daily/weekly/other, sums realized weights into a 3×3 grid),
  then render it as a heat-map matrix diagram in `_themeOddsHtml` below the existing
  summary bar. Same-weather day collapses to a 2×2 grid.
- (2026-07-13) Implemented + tested. Extended tests/theme-odds.test.js: 6417
  assertions pass (up from 3216). Full suite: 27/28 suites green; the only failure
  is the pre-existing, unrelated trip-planner.test.js (`planTransitTrip is not a
  function`), which does not touch spawns.js/creatures.js. `node --check` clean on
  both edited files.

## Writeup
**What it does:** The "Today's spawn odds" info modal (opened by tapping the
weather chips at the top of the browse view) now has a new **"Both type-halves"**
section below the existing summary bar. It's a heat-map matrix showing the *joint*
odds over the two type-halves of a spawn — i.e. the detailed daily×daily,
daily×weekly, weekly×daily, daily×other, other×daily, weekly×weekly, weekly×other,
other×weekly, other×other breakdown the task asked for. Rows are the first
(primary) half, columns the second (secondary) half; darker cells = more likely;
all cells sum to 100%. On a same-weather day (daily === weekly) the grid collapses
to 2×2 (boosted type / Other).

**Odds source (honest, reads the live sampler):** Added `Spawns.typePairOdds(nowMs)`
in static/spawns.js. It builds the actual `_composePairSampler` for the current
weather, classifies each entry's primary/secondary type as `daily` / `weekly` /
`other`, sums the realized weights into a `grid[rowClass][colClass]`, and normalizes
so the whole grid sums to 1. Because it reads the real sampler, empty species pools
are baked in honestly — e.g. STEEL has no *secondary*-slot species in the gen-1 set,
so on a STEEL-weekly day the entire "STEEL second-half" column realizes 0%. Returns
`{ daily, weekly, same, classes, grid }`; `classes` is `['daily','weekly','other']`
(or `['daily','other']` when same). `typeOdds` (the per-slot marginal bar) is
unchanged and still drives the summary section.

**Invariant tying the two together:** the per-slot marginals of the joint grid
reconstruct the `typeOdds` shares exactly. For any class C,
`(rowMarginal(C) + colMarginal(C)) / 2 === typeOdds share of C`, because `typeOdds`
is defined as the average of the primary- and secondary-slot marginals. The test
asserts this every day of a 400-day sweep — a strong cross-check that the joint
distribution is consistent with the marginal one.

**UI:** creatures.js `_ccOddsGrid(pair)` renders the matrix as a CSS grid
(`grid-template-columns: minmax(40px,auto) repeat(N,1fr)`) with an oriented corner
cell ("1st ↓ / 2nd →"), type-colored row/column header swatches (reusing
`_titleCaseType` + `TYPE_COLORS`), and heat-mapped cells (`rgba(109,90,192,α)` where
α scales 0.06→0.60 with the cell's share relative to the busiest cell; α>0.4 flips
text to white via a `.hot` class). New `.cc-oddsgrid*` CSS lives in the `#ccInfoModal`
style block next to `.cc-oddsbar`. `_themeOddsHtml` fetches `typePairOdds()` and
inserts the section between the summary bar and the "How the boost works" section,
guarded so it's simply omitted if pair odds aren't available. An explanatory "0%
cell" note appears only when the grid actually contains an exact-0 cell.

**Tests:** tests/theme-odds.test.js — new Part 1b sweeps 400 days asserting
typePairOdds returns a valid distribution (cells ≥0, sum to 1), `classes` tracks the
same-flag, both distinct and same days occur, determinism, and the marginal-
reconstruction invariant above. Part 2 adds render cases: distinct → 3×3 (9 cells,
6 headers, oriented corner, joint %s, a `.hot` cell, no empty-pool note), same → 2×2
(4 cells, 4 headers), a zero-cell grid → shows the empty-pool note, and
`typePairOdds` null → grid omitted but the summary bar still renders. 6417
assertions total, all pass.

**Assumptions / notes:** (1) I kept the existing per-slot summary bar and *added*
the joint grid beneath it, since the summary is the quickest read and the grid is
the "more detailed" view the task asked for. (2) "Other" is a single aggregated
class covering all 16 non-boosted types (matching the existing bar's catch-all), so
the grid stays a legible 3×3 rather than an 18×18 matrix. (3) Cells show rounded
integer percentages; a tiny non-zero share can round to 0%, so the empty-pool note
is worded to cover "off the table (or vanishingly rare)". (4) Not verified in a real
browser — no device available in this environment; verified via the vm-extracted
render harness and a real-data end-to-end render dump instead.
