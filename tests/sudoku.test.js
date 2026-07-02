// Headless tests for the Sudoku CORE (static/extras-sudoku.js).
// Run: node tests/sudoku.test.js
// The file bails out before any DOM work under Node, so loading it just
// populates globalThis.SudokuCore.

'use strict';
const path = require('path');
require(path.join(__dirname, '..', 'static', 'extras-sudoku.js'));
const S = globalThis.SudokuCore;

let failed = 0, passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL: ' + msg); }
}

const toArr = (str) => str.replace(/[^0-9]/g, '').split('').map(Number);
function validComplete(v) {
  if (v.length !== 81 || v.some((x) => x < 1 || x > 9)) return false;
  for (const u of S.UNITS) {
    let m = 0;
    for (const i of u) m |= 1 << (v[i] - 1);
    if (m !== 0x1FF) return false;
  }
  return true;
}

// ── solver against the classic Project Euler #96 grid 01 ──
const euler = toArr(
  '003020600' + '900305001' + '001806400' +
  '008102900' + '700000008' + '006708200' +
  '002609500' + '800203009' + '005010300');
{
  const res = S.countSolutions(euler, 2);
  ok(res.count === 1, 'Euler grid 01 has exactly one solution, got ' + res.count);
  const sol = S.solveOne(euler);
  ok(!!sol && validComplete(sol), 'Euler grid 01 solution is a valid complete grid');
  ok(sol.slice(0, 3).join('') === '483', 'Euler grid 01 top-left is 483 (the published answer)');
  ok(euler.every((d, i) => d === 0 || d === sol[i]), 'solution respects the givens');
}

// ── countSolutions edges ──
ok(S.countSolutions(new Array(81).fill(0), 2).count === 2, 'empty board caps at 2 (many solutions)');
{
  const bad = new Array(81).fill(0);
  bad[0] = 5; bad[1] = 5; // same row twice
  ok(S.countSolutions(bad, 2).count === 0, 'contradictory board has zero solutions');
}

// ── full-grid filler ──
{
  const rng = S.mulberry32(7);
  const full = S.fillFull(rng);
  ok(validComplete(full), 'fillFull produces a valid complete grid');
  ok(S.grade(full) === 1, 'a complete grid grades as easy');
}

// ── techSolve agrees with the backtracker when it claims a solve ──
{
  const g = S.generate('easy', 5);
  const t = S.techSolve(g.puzzle, false);
  ok(t.solved, 'easy puzzle solves with singles only');
  ok(t.v.join('') === g.solution.join(''), 'technique solver reaches the same solution as the backtracker');
}

// ── the generator guarantee: unique, consistent, right-shaped, graded ──
const WANT = { easy: 1, medium: 2, hard: 3, expert: 4 };
const CLUES = { easy: [36, 48], medium: [26, 35], hard: [19, 33], expert: [19, 33] };
for (const diff of ['easy', 'medium', 'hard', 'expert']) {
  for (const seed of [1, 2, 3]) {
    const t0 = Date.now();
    const g = S.generate(diff, seed);
    const ms = Date.now() - t0;
    const tag = diff + '/seed' + seed;
    ok(validComplete(g.solution), tag + ': solution is a valid complete grid');
    ok(g.puzzle.every((d, i) => d === 0 || d === g.solution[i]), tag + ': puzzle is a subset of its solution');
    ok(S.countSolutions(g.puzzle, 2).count === 1, tag + ': puzzle has EXACTLY one solution');
    ok(g.clues >= CLUES[diff][0] && g.clues <= CLUES[diff][1],
      tag + ': clue count ' + g.clues + ' in [' + CLUES[diff] + ']');
    ok(g.grade === WANT[diff], tag + ': grade ' + g.grade + ' matches requested ' + WANT[diff]);
    ok(ms < 5000, tag + ': generated in ' + ms + 'ms (<5s)');
    console.log('  ' + tag + ': ' + g.clues + ' clues, grade ' + g.grade + ', ' + ms + 'ms');
  }
}

// ── determinism: same seed, same deal ──
{
  const a = S.generate('medium', 42), b = S.generate('medium', 42);
  ok(a.puzzle.join('') === b.puzzle.join(''), 'same seed deals the same puzzle');
  const c = S.generate('medium', 43);
  ok(a.puzzle.join('') !== c.puzzle.join(''), 'different seed deals a different puzzle');
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
