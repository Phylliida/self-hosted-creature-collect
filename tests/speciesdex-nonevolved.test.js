// Tests the per-species dex "non-evolved only" filter:
//   renderSpeciesDex() (static/creatures.js) now offers the same toggle the
//   completion list has, but applied to a single species' PARTNER grid. When
//   on, only non-evolved partners (the ones you actually CATCH or HATCH to make
//   the fusion) are listed, and the page's seen/total % is computed over that
//   filtered set.
//
// renderSpeciesDex is DOM-heavy (virtualizeGrid, sprite loads), so — like
// completion-nonevolved.test — we can't run it headless. We instead:
//   1. assert the real source carries the toggle wiring (button, state var,
//      partner filter, click handler), so removing any piece fails the test; and
//   2. replicate the two pure pieces of the toggle's behavior — the partner
//      filter `supportedSpeciesSorted().filter(p => !on || !_isEvolvedSpecies(p))`
//      and the seen/total aggregate (skipping legendary partners) — and check
//      the two modes genuinely differ.
//
// Run: node tests/speciesdex-nonevolved.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'creatures.js'), 'utf8');

// ── 1. The real source carries every piece of the toggle ────────────────
ok(/class="speciesdex-filter"/.test(src),
  'speciesdex-view has a .speciesdex-filter button');
ok(/let _nonEvolvedOnly = false;/.test(src),
  'shared _nonEvolvedOnly state exists (completion + speciesdex)');
ok(/\.filter\(\(p\) => !nonEvoOnly \|\| !_isEvolvedSpecies\(p\)\)/.test(src),
  'renderSpeciesDex filters partners by !_isEvolvedSpecies when the toggle is on');
ok(/\.speciesdex-filter'\)\.addEventListener\('click'/.test(src),
  'the .speciesdex-filter button has a click handler');
ok(/_nonEvolvedOnly = !_nonEvolvedOnly/.test(src),
  'the click handler toggles the state');
ok(/top\.view === 'speciesdex'\) renderSpeciesDex\(top\.species\)/.test(src),
  're-renders the species currently on the view stack after toggling');

// ── 2. Replicate the pure filter + aggregate ────────────────────────────
// Same stub pool as completion-nonevolved.test:
//   3-stage line {1→2→3} plus a lone base {4}. Non-evolved = {1, 4}.
const SUPPORTED = [1, 2, 3, 4];
const EVOLVED = new Set([2, 3]);
const _isEvolvedSpecies = (id) => EVOLVED.has(id);
const isLegendarySpecies = () => false;               // none in this pool
const supportedSpeciesSorted = () => SUPPORTED.slice().sort((a, b) => a - b);

// Seen head-fusions for X=1: 1×2, 1×3, 1×4 (X as head) and 2×1 (X as body).
const seen = new Set(['1-2', '1-3', '1-4', '2-1', '3-4']);
const isFusionSeen = (a, b) => seen.has(a + '-' + b);

// The pure core of renderSpeciesDex for a given species X and toggle state.
function speciesDexStats(X, nonEvoOnly) {
  const partners = supportedSpeciesSorted()
    .filter((p) => !nonEvoOnly || !_isEvolvedSpecies(p));
  let seenHead = 0, seenBody = 0, counted = 0;
  for (const p of partners) {
    if (isLegendarySpecies(p)) continue;
    counted++;
    if (isFusionSeen(X, p)) seenHead++;
    if (isFusionSeen(p, X)) seenBody++;
  }
  const total = 2 * counted;
  const seenAll = seenHead + seenBody;
  return { partners, counted, seenAll, total, pct: total ? Math.round(seenAll / total * 100) : 0 };
}

// ── Toggle OFF: all four partners; X=1 sees 1×2,1×3,1×4 (head) + 2×1 (body) ─
{
  const s = speciesDexStats(1, false);
  ok(s.partners.join(',') === '1,2,3,4', 'toggle off lists all partners {1,2,3,4}');
  ok(s.seenAll === 4 && s.total === 8, 'toggle off seen/total = 4/8 (got ' + s.seenAll + '/' + s.total + ')');
  ok(s.pct === 50, 'toggle off % = 50 (got ' + s.pct + ')');
}

// ── Toggle ON: only non-evolved partners {1,4}; X=1 sees just 1×4 (head) ────
{
  const s = speciesDexStats(1, true);
  ok(s.partners.join(',') === '1,4', 'toggle on lists only non-evolved partners {1,4} (got {' + s.partners.join(',') + '})');
  ok(s.seenAll === 1 && s.total === 4, 'toggle on seen/total = 1/4 (got ' + s.seenAll + '/' + s.total + ')');
  ok(s.pct === 25, 'toggle on % = 25 (got ' + s.pct + ')');
}

// ── The two modes genuinely differ (else the toggle is pointless) ───────────
ok(speciesDexStats(1, false).pct !== speciesDexStats(1, true).pct,
  'filtered % differs from the full-partner %');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
