---
title: extra for unit conversion has a text field where you can type like 2 tsp or 5 cm etc. (try to be comprehensive) and it'll autodetect unit and
status: done
claimed_by: claude-opus
created: 2026-07-19T20:14:34Z
updated: 2026-07-19T20:20:00Z
taiga_id: 77
taiga_version: 2
synced_hash: 8b2fbf80005afd7d
---

then it'll display all potential conversions (with a second field where you can type what unit you wanted and it'll covnert to that) also you can type like 1 tsp to cm or "convert 2 tsp to cup" and it'll automatically convert and populate the output accordingly

## Progress
- (2026-07-19) Claimed. Plan: enhance the EXISTING Unit conversions extra
  (`#extrasUnitConv` in static/extras.js) rather than add a new bubble — reuse
  its `UC_CATEGORIES` unit tables. Adding at the top of the panel:
  - a smart free-text field ("2 tsp", "5 cm to in", "convert 3 mi to km")
  - a second "to unit" free-text field (optional target)
  - an output area listing ALL conversions in the detected unit's category,
    with the requested target highlighted, and driving the existing dropdowns.
  Pure parser lives at module scope (`ucBuildParser(categories)`) so it's
  headless-testable; exported as `global.ExtrasUnitParse`. New test:
  tests/unit-parse.test.js.
- (2026-07-19) Done. Implemented + verified end-to-end in headless Firefox.

## Writeup
Enhanced the existing **Unit conversions** extra (`#extrasUnitConv` in
`static/extras.js`) with a smart free-text front-end, rather than adding a new
bubble — it reuses the same `UC_CATEGORIES` unit tables the classic picker uses,
so there's one source of truth for factors.

**What the user sees** (top of the Unit conversions panel):
1. A big free-text field (`#ucSmart`). Type `2 tsp`, `5cm`, `5 cm to in`,
   `convert 3 mi to km`, `100 c to f`, `1/2 cup`, `2 1/2 cups`, `how many cups
   in 2 tsp`, etc.
2. A secondary "convert to…" field (`#ucSmartTo`) — type a target unit (e.g.
   `cups`) and it converts to that. An explicit target in the main expression
   (`… to cups`) also auto-fills this field.
3. An output area (`#ucSmartOut`): a headline line (`2 tsp = 0.0417 cup`) when a
   target is known, then **all** conversions in the detected category as a list,
   with the requested target row highlighted.
The old dropdown picker is still there, tucked into a `<details>` ("Or pick
units"), and the smart field **drives it** (category/from/to/values stay in
sync) so the two views never disagree.

**How it works.** The parsing is a pure, DOM-free function
`ucBuildParser(categories)` at module scope, exported as
`global.ExtrasUnitParse` (and `global.ucBuildParser`). It:
- builds a spelling→{cat,unit} index from a hand-authored synonym table (words,
  symbols, `"`/`'` for inch/foot, `#` for lb, `°C`, "metres per second", "sq
  ft"…) plus every unit's own id + parenthetical symbol (added without
  overwriting, so the hand table wins the few clashes — notably **`ms` resolves
  to milliseconds, not metres/second**);
- `parse(raw)` strips filler ("convert", "how many", "what is", "="→" to "),
  splits a target on the first `to`/`into`/`as`/`in` that has text after it
  (bare `5 in` stays whole → inches), handles the reversed "how many X in Y"
  form, parses the number (decimals, thousands commas, `1/2`, mixed `2 1/2`,
  negatives for temperature; absent number ⇒ 1), and flags cross-category
  requests as `mismatch` (e.g. `1 tsp to cm` → "those measure different
  things");
- `convertAll(value, from)` returns every unit's value in the category (affine
  temperature routes through its Celsius base like the classic converter).

**Verification.**
- `tests/unit-parse.test.js` (new, 117 asserts): alias coverage, ambiguity
  resolution, every task phrasing, number formats, failure modes, and the actual
  arithmetic (1 kg≈2.2046 lb, 2 tsp≈9.8578 mL, 100 °C=212 °F, plus a
  self-consistency sweep over every unit in every category). Passes.
- Whole `tests/*.test.js` suite still green.
- Drove the real UI in headless Firefox (temp harness, since deleted): confirmed
  `2 tsp to cup`, `5 cm to in`, the reversed form, the tsp→cm mismatch message,
  a bare `2 tsp` (full list, no headline), the secondary-field path
  (`100 c` + `f` → 212 °F), and a garbage input (`banana` → gentle hint, picker
  left intact) all behave and render correctly, with no load errors.

**Assumptions / notes.**
- Ambiguous single tokens are resolved to the most-likely intent: `oz`→mass
  ounce (use `fl oz` for volume), `c/f/k`→temperature, `b`→byte, `ms`→
  millisecond, `t`→tonne, `in`→inch, `m`→metre. Documented in the synonym table.
- `extras.js` is already tracked (run.py `_TRACKED_JS` + APP_SHELL); this is an
  in-place edit, so no new-file registration was needed. On native it picks up
  via the tracked-JS Refresh / next rebuild.
- No new bubble, no network, no new storage keys — fully offline, consistent
  with the zero-network policy.
