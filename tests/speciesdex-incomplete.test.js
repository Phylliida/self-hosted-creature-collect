// Tests the species dex "Incomplete only" toggle: it hides partner rows whose
// two fusions (X×P and P×X) are both seen. A row with one seen and one unseen
// fusion stays. With a type filter on, the unseen fusion has to be the one
// that passes it, so the rows are the ones with something of that type left.
//
// The row rule is the pure _speciesDexShownPartners, brace-matched out of
// static/creatures.js and run in a vm sandbox; the wiring (button, state,
// handler, render call) is checked against the source.
//
// Run: node tests/speciesdex-incomplete.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'creatures.js'), 'utf8');
function matchFn(marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('not found in creatures.js: ' + marker);
  let i = src.indexOf(') {', at) + 2, depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') { const q = c; for (i++; i < src.length && src[i] !== q; i++) { if (src[i] === '\\') i++; } continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error('could not brace-match: ' + marker);
}

// ── the row rule ─────────────────────────────────────────────────────────
const NAMES = { 132: 'Ditto', 1: 'Bulbasaur', 4: 'Charmander', 7: 'Squirtle', 25: 'Pikachu' };
const ctx = vm.createContext({ speciesNameFor: (id) => NAMES[id] });
vm.runInContext(matchFn('function _speciesDexShownPartners('), ctx);
const shownFor = (opts) => vm.runInContext('_speciesDexShownPartners', ctx)(132, [1, 4, 7, 25, 132], opts);

// Seen: Ditto×Bulbasaur both ways (complete row); Charmander one way only;
// Squirtle neither way; Pikachu neither; Ditto×Ditto seen.
const SEEN = new Set(['132-1', '1-132', '132-4', '132-132']);
const seenIt = (a, b) => SEEN.has(`${a}-${b}`);
const anyType = () => true;

ok(JSON.stringify(shownFor({ q: '', typeOk: anyType, seenIt, incompleteOnly: false })) === '[1,4,7,25,132]',
   'off: every row shows');
const inc = shownFor({ q: '', typeOk: anyType, seenIt, incompleteOnly: true });
ok(!inc.includes(1), 'on: a row with both fusions seen is hidden');
ok(inc.includes(4), 'on: a row with one seen and one unseen fusion stays');
ok(inc.includes(7) && inc.includes(25), 'on: rows with nothing seen stay');
ok(!inc.includes(132), 'on: a seen self-fusion row (X×X both cells) is hidden');
ok(JSON.stringify(inc) === '[4,7,25]', 'on: order kept');

// The other direction of a half-seen row counts too (P×X seen, X×P not).
SEEN.add('7-132');
ok(shownFor({ q: '', typeOk: anyType, seenIt, incompleteOnly: true }).includes(7),
   'on: half-seen the other way round still shows');
SEEN.delete('7-132');

// Name search still applies on top.
ok(JSON.stringify(shownFor({ q: ' CHAR ', typeOk: anyType, seenIt, incompleteOnly: true })) === '[4]',
   'on: name search narrows the incomplete rows');
ok(JSON.stringify(shownFor({ q: 'bulba', typeOk: anyType, seenIt, incompleteOnly: true })) === '[]',
   'on: a complete row stays hidden even when searched for');

// Type filter: Charmander's unseen fusion is Charmander×Ditto (4-132). If only
// the seen one (132-4) has the type, the row has nothing of that type left.
const onlySeenHalfTyped = (a, b) => a === 132 && b === 4;
ok(!shownFor({ q: '', typeOk: onlySeenHalfTyped, seenIt, incompleteOnly: true }).includes(4),
   'type + incomplete: hidden when the only unseen fusion fails the type filter');
ok(shownFor({ q: '', typeOk: onlySeenHalfTyped, seenIt, incompleteOnly: false }).includes(4),
   'type alone: that row still shows (its seen half matches)');
const onlyUnseenHalfTyped = (a, b) => a === 4 && b === 132;
ok(shownFor({ q: '', typeOk: onlyUnseenHalfTyped, seenIt, incompleteOnly: true }).includes(4),
   'type + incomplete: shown when the unseen fusion passes the type filter');

// ── the wiring ───────────────────────────────────────────────────────────
ok(/<button class="speciesdex-incomplete" type="button" aria-pressed="false"[^>]*>Incomplete Only<\/button>/.test(src),
   'species dex has the Incomplete Only button');
ok(/<button class="speciesdex-filter" type="button" aria-pressed="false"[^>]*>Non-Evolved Only<\/button>/.test(src)
   && /<button class="completion-filter" type="button" aria-pressed="false"[^>]*>Non-Evolved Only<\/button>/.test(src),
   'both non-evolved buttons say Non-Evolved Only');
ok(!/textContent = (nonEvoOnly|_incompleteOnly)/.test(src), 'filter labels stay put; the accent fill shows on/off');
ok(/let _incompleteOnly = false;/.test(src), '_incompleteOnly state exists');
ok(/\.speciesdex-incomplete'\)\.addEventListener\('click', \(\) => \{\s*_incompleteOnly = !_incompleteOnly;/.test(src),
   'the button toggles _incompleteOnly');
const render = matchFn('function renderSpeciesDex(speciesId)');
ok(/rowsFor\(_incompleteOnly\)/.test(render), 'renderSpeciesDex applies the toggle to its rows');
ok(/incompleteBtn\.classList\.toggle\('is-active', _incompleteOnly\)/.test(render), 'button shows its on state');
ok(/Every fusion here is seen!/.test(render), 'all-seen empty state');
ok(/\.speciesdex-incomplete\.is-active/.test(src), 'active chip styling');

// ── Back-nav: each dex entry remembers the toggle it was left with ──
// (On in species X's dex → wander off → open X's dex again → turn it
// off → Back all the way: the first X dex is on again.)
const capture = matchFn('function _captureCurrentFilters()');
ok(/incompleteOnly: _incompleteOnly/.test(capture), 'pushing off a dex entry snapshots incompleteOnly');
const restoreSrc = matchFn('function _restoreDexToggles(f)');
for (const view of ['completion', 'speciesdex']) {
  const at = src.indexOf(`case '${view}': {`);
  ok(at > 0 && /_restoreDexToggles\(top\.filters\)/.test(src.slice(at, at + 700)), `back into ${view} restores the toggles`);
}
{
  const box = { _nonEvolvedOnly: false, _incompleteOnly: false };
  vm.createContext(box);
  vm.runInContext('var _nonEvolvedOnly = false, _incompleteOnly = false;\n' + restoreSrc
    + '\nthis.restore = _restoreDexToggles; this.get = () => [_nonEvolvedOnly, _incompleteOnly];'
    + '\nthis.set = (n, i) => { _nonEvolvedOnly = n; _incompleteOnly = i; };', box);
  // A stack walked the user's way; each push snapshots the live toggles.
  const stack = [];
  const push = (view) => { if (stack.length) { const [n, i] = box.get(); stack[stack.length - 1].filters = { nonEvolvedOnly: n, incompleteOnly: i }; } stack.push({ view }); };
  const pop = () => { stack.pop(); const top = stack[stack.length - 1]; if (top.view === 'speciesdex' || top.view === 'completion') box.restore(top.filters); return box.get()[1]; };
  push('completion'); push('speciesdex');
  box.set(false, true);                       // Incomplete Only on
  push('fusion'); push('pokedex'); push('completion'); push('speciesdex');
  ok(box.get()[1] === true, 'the second X dex opens with it still on (carried)');
  box.set(false, false);                      // turned off there
  const seen = [pop(), pop(), pop(), pop()];  // → completion, pokedex, fusion, first X dex
  ok(seen[3] === true, `Back to the first X dex: on again (${seen})`);
  ok(pop() === false && stack[stack.length - 1].view === 'completion',
    'the completion list below gets what it was left with (off: it was turned on later, in the dex)');
  box.set(true, true);
  box.restore({ nonEvolvedOnly: false });     // an entry saved before this snapshot existed
  ok(box.get()[0] === false && box.get()[1] === true, 'old entries without incompleteOnly leave it alone');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
