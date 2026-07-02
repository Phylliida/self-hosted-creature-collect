// Extras -> Sudoku: a full offline sudoku with a verified generator.
//
// Every puzzle is generated on-device (no bundled puzzle packs, no network)
// by filling a random complete grid, then digging clues back out under a
// uniqueness check -- a backtracking solution-counter proves each puzzle has
// EXACTLY one solution before it's offered. Difficulty is graded by which
// human techniques the puzzle actually requires, not just clue count:
//   easy    naked/hidden singles, generous clues (~40)
//   medium  still singles-only, but lean clues (~30) so the chains run long
//   hard    needs pointing/claiming or naked pairs (or a short guess)
//   expert  stalls all of the above -- deeper search required
//
// Features: pencil notes, undo, conflict highlighting, mistake check against
// the stored solution, per-digit remaining counts, same-digit highlighting,
// elapsed timer, per-difficulty best times, and autosave (game + stats ride
// in localStorage cc.sudoku.v1; a closed app resumes mid-puzzle).
//
// Plugs into the Extras launcher via global.ExtrasRegisterTool({ ..., build })
// like the other siblings. The solver/generator/grader CORE is attached to
// global.SudokuCore and bails out before any DOM work under Node, so the
// uniqueness and grading guarantees are unit-tested headless
// (tests/sudoku.test.js).
//
// NOTE: the CSS below lives inside a template literal -- never put a
// backtick inside it (even in a comment), it terminates the string and
// breaks the whole file.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve (if tracked)
  if (global._scriptVersions) global._scriptVersions['extras-sudoku.js'] = SCRIPT_VERSION;

  // ════════════════════════════════════════════════════════════════════
  // CORE  (pure logic, no DOM -- exposed on global.SudokuCore for Node tests)
  //
  // Boards are arrays of 81 ints, 0 = empty, 1..9 = digit, row-major.
  // Candidate sets are 9-bit masks: bit (d-1) set means digit d is possible.
  // ════════════════════════════════════════════════════════════════════

  const ALL = 0x1FF;
  const bit = (d) => 1 << (d - 1);
  function popcount(m) { let c = 0; while (m) { m &= m - 1; c++; } return c; }

  // deterministic RNG so tests (and re-deals) are reproducible
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffled(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // units (9 rows, 9 cols, 9 boxes) and each cell's 20 peers
  const UNITS = [];
  for (let r = 0; r < 9; r++) UNITS.push(Array.from({ length: 9 }, (_, c) => r * 9 + c));
  for (let c = 0; c < 9; c++) UNITS.push(Array.from({ length: 9 }, (_, r) => r * 9 + c));
  for (let b = 0; b < 9; b++) {
    const r0 = Math.floor(b / 3) * 3, c0 = (b % 3) * 3, u = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) u.push((r0 + r) * 9 + c0 + c);
    UNITS.push(u);
  }
  const PEERS = Array.from({ length: 81 }, () => new Set());
  for (const u of UNITS) for (const i of u) for (const j of u) { if (i !== j) PEERS[i].add(j); }
  for (let i = 0; i < 81; i++) PEERS[i] = Array.from(PEERS[i]);
  const BOX_OF = (i) => Math.floor(Math.floor(i / 9) / 3) * 3 + Math.floor((i % 9) / 3);

  function candMask(v, i) {
    let used = 0;
    for (const p of PEERS[i]) { if (v[p]) used |= bit(v[p]); }
    return ALL & ~used;
  }

  // A board whose GIVENS already clash has no solutions -- and must be
  // rejected up front: the search below only constrains empty cells, so a
  // duplicated given would otherwise send it wandering a huge dead space.
  function validGivens(v) {
    for (let i = 0; i < 81; i++) {
      if (!v[i]) continue;
      for (const p of PEERS[i]) { if (p > i && v[p] === v[i]) return false; }
    }
    return true;
  }

  // Count solutions up to `limit` (2 is enough to prove/disprove uniqueness).
  // MRV branching keeps this fast even on near-minimal puzzles.
  function countSolutions(vals, limit) {
    if (!validGivens(vals)) return { count: 0, branches: 0 };
    const v = vals.slice();
    let branches = 0;
    function rec(remaining) {
      let best = -1, bestMask = 0, bestN = 10;
      for (let i = 0; i < 81; i++) {
        if (v[i]) continue;
        const m = candMask(v, i), n = popcount(m);
        if (n === 0) return 0;
        if (n < bestN) { best = i; bestMask = m; bestN = n; if (n === 1) break; }
      }
      if (best === -1) return 1;
      if (bestN > 1) branches++;
      let total = 0;
      for (let d = 1; d <= 9; d++) {
        if (!(bestMask & bit(d))) continue;
        v[best] = d;
        total += rec(remaining - total);
        v[best] = 0;
        if (total >= remaining) return total;
      }
      return total;
    }
    const n = rec(limit);
    return { count: n, branches };
  }

  // First solution found, or null. Digit order can be randomised for filling.
  function solveOne(vals, rng) {
    if (!validGivens(vals)) return null;
    const v = vals.slice();
    const order = rng ? shuffled([1, 2, 3, 4, 5, 6, 7, 8, 9], rng) : [1, 2, 3, 4, 5, 6, 7, 8, 9];
    function rec() {
      let best = -1, bestMask = 0, bestN = 10;
      for (let i = 0; i < 81; i++) {
        if (v[i]) continue;
        const m = candMask(v, i), n = popcount(m);
        if (n === 0) return false;
        if (n < bestN) { best = i; bestMask = m; bestN = n; if (n === 1) break; }
      }
      if (best === -1) return true;
      for (const d of order) {
        if (!(bestMask & bit(d))) continue;
        v[best] = d;
        if (rec()) return true;
        v[best] = 0;
      }
      return false;
    }
    return rec() ? v : null;
  }

  const fillFull = (rng) => solveOne(new Array(81).fill(0), rng);

  // Dig clues out of a full grid, keeping the solution unique. Rotationally
  // symmetric removal (classic newspaper look) unless digging for minimum.
  function dig(full, targetClues, symmetric, rng) {
    const v = full.slice();
    let clues = 81;
    for (const i of shuffled(Array.from({ length: 81 }, (_, k) => k), rng)) {
      if (clues <= targetClues) break;
      const j = symmetric ? 80 - i : i;
      if (!v[i] && !v[j]) continue;
      const si = v[i], sj = v[j];
      v[i] = 0; v[j] = 0;
      if (countSolutions(v, 2).count !== 1) { v[i] = si; v[j] = sj; continue; }
      clues = v.reduce((n, x) => n + (x ? 1 : 0), 0);
    }
    return v;
  }

  // Human-technique solver. Maintains a live candidate lattice; eliminations
  // from pointing/claiming and naked pairs persist across passes. Returns
  // whether the techniques alone finish the puzzle.
  function techSolve(vals, usePairsPointing) {
    const v = vals.slice();
    const cand = new Array(81).fill(0);
    for (let i = 0; i < 81; i++) { if (!v[i]) cand[i] = candMask(v, i); }
    function place(i, d) {
      v[i] = d; cand[i] = 0;
      for (const p of PEERS[i]) cand[p] &= ~bit(d);
    }
    for (;;) {
      let progress = false;
      // naked singles
      for (let i = 0; i < 81; i++) {
        if (v[i]) continue;
        if (cand[i] === 0) return { solved: false, contradiction: true, v };
        if (popcount(cand[i]) === 1) { place(i, 31 - Math.clz32(cand[i]) + 1); progress = true; }
      }
      if (progress) continue;
      // hidden singles
      for (const u of UNITS) {
        for (let d = 1; d <= 9; d++) {
          let spot = -1, n = 0;
          for (const i of u) { if (!v[i] && (cand[i] & bit(d))) { spot = i; n++; if (n > 1) break; } }
          if (n === 1) { place(spot, d); progress = true; }
        }
      }
      if (progress) continue;
      if (usePairsPointing) {
        // pointing/claiming: box<->line intersections
        for (let b = 0; b < 9; b++) {
          const box = UNITS[18 + b];
          for (let d = 1; d <= 9; d++) {
            const cells = box.filter((i) => !v[i] && (cand[i] & bit(d)));
            if (cells.length < 2 || cells.length > 3) continue;
            const row = Math.floor(cells[0] / 9), col = cells[0] % 9;
            if (cells.every((i) => Math.floor(i / 9) === row)) {
              for (const i of UNITS[row]) {
                if (BOX_OF(i) !== b && !v[i] && (cand[i] & bit(d))) { cand[i] &= ~bit(d); progress = true; }
              }
            } else if (cells.every((i) => i % 9 === col)) {
              for (const i of UNITS[9 + col]) {
                if (BOX_OF(i) !== b && !v[i] && (cand[i] & bit(d))) { cand[i] &= ~bit(d); progress = true; }
              }
            }
          }
        }
        // claiming: line -> box
        for (let li = 0; li < 18; li++) {
          const line = UNITS[li];
          for (let d = 1; d <= 9; d++) {
            const cells = line.filter((i) => !v[i] && (cand[i] & bit(d)));
            if (cells.length < 2 || cells.length > 3) continue;
            const b = BOX_OF(cells[0]);
            if (!cells.every((i) => BOX_OF(i) === b)) continue;
            for (const i of UNITS[18 + b]) {
              if (line.indexOf(i) === -1 && !v[i] && (cand[i] & bit(d))) { cand[i] &= ~bit(d); progress = true; }
            }
          }
        }
        // naked pairs within a unit
        for (const u of UNITS) {
          const twos = u.filter((i) => !v[i] && popcount(cand[i]) === 2);
          for (let a = 0; a < twos.length; a++) {
            for (let b2 = a + 1; b2 < twos.length; b2++) {
              if (cand[twos[a]] !== cand[twos[b2]]) continue;
              const m = cand[twos[a]];
              for (const i of u) {
                if (i === twos[a] || i === twos[b2] || v[i]) continue;
                if (cand[i] & m) { cand[i] &= ~m; progress = true; }
              }
            }
          }
        }
      }
      if (!progress) break;
    }
    return { solved: v.every((x) => x !== 0), contradiction: false, v };
  }

  // 1 easy .. 4 expert (see the header). `branches` = how much guessing a
  // backtracker needs after the techniques stall; used to split hard/expert.
  function grade(puzzle) {
    const clues = puzzle.reduce((n, x) => n + (x ? 1 : 0), 0);
    if (techSolve(puzzle, false).solved) return clues >= 36 ? 1 : 2;
    const t = techSolve(puzzle, true);
    if (t.solved) return 3;
    const br = countSolutions(t.v, 2).branches;
    return br <= 4 ? 3 : 4;
  }

  // Generate a puzzle of the requested difficulty. Deals fresh grids until
  // the grade matches (bounded), then falls back to the closest miss.
  const DIFFS = {
    easy:   { target: 40, symmetric: true,  want: 1, tries: 12 },
    medium: { target: 30, symmetric: true,  want: 2, tries: 16 },
    hard:   { target: 17, symmetric: false, want: 3, tries: 24 },
    expert: { target: 17, symmetric: false, want: 4, tries: 24 },
  };
  function generate(diff, seed) {
    const cfg = DIFFS[diff] || DIFFS.easy;
    const rng = mulberry32((seed == null ? 1 : seed) >>> 0);
    let best = null, bestGap = 99;
    for (let t = 0; t < cfg.tries; t++) {
      const full = fillFull(rng);
      const puz = dig(full, cfg.target, cfg.symmetric, rng);
      const g = grade(puz);
      const gap = Math.abs(g - cfg.want);
      if (gap < bestGap) {
        bestGap = gap;
        best = { puzzle: puz, solution: full, grade: g, clues: puz.reduce((n, x) => n + (x ? 1 : 0), 0) };
      }
      if (gap === 0) break;
    }
    return best;
  }

  global.SudokuCore = { generate, solveOne, countSolutions, grade, techSolve, fillFull, dig, mulberry32, UNITS };

  // ════════════════════════════════════════════════════════════════════
  // UI  (browser only -- bail out cleanly under Node / before the hook loads)
  // ════════════════════════════════════════════════════════════════════
  if (typeof document === 'undefined' || typeof global.ExtrasRegisterTool !== 'function') return;

  const RT = global.ExtrasRegisterTool;

  // ── CSS (no backticks inside this template literal!) ──
  const style = document.createElement('style');
  style.textContent = `
  .sud-grid { display: grid; grid-template-columns: repeat(9, 1fr); width: 100%;
    max-width: 340px; margin: 0 auto; aspect-ratio: 1; user-select: none;
    border: 2px solid var(--ui-text); border-radius: 6px; overflow: hidden;
    background: var(--ui-input-bg); }
  .sud-cell { position: relative; display: flex; align-items: center; justify-content: center;
    font-size: 19px; font-weight: 600; color: var(--ui-accent); cursor: pointer;
    border-right: 1px solid var(--ui-border); border-bottom: 1px solid var(--ui-border);
    font-variant-numeric: tabular-nums; min-width: 0; }
  .sud-cell.br3 { border-right: 2px solid var(--ui-text); }
  .sud-cell.bb3 { border-bottom: 2px solid var(--ui-text); }
  .sud-cell:nth-child(9n) { border-right: none; }
  .sud-cell.given { color: var(--ui-text); }
  .sud-cell.unit { background: rgba(125, 145, 255, 0.07); }
  .sud-cell.same { background: rgba(125, 145, 255, 0.18); }
  .sud-cell.sel { background: rgba(125, 145, 255, 0.30); }
  .sud-cell.bad { color: #d84343; }
  .sud-notes { position: absolute; inset: 0; display: grid;
    grid-template-columns: 1fr 1fr 1fr; grid-template-rows: 1fr 1fr 1fr; }
  .sud-notes span { font-size: 8.5px; font-weight: 500; color: var(--ui-muted);
    display: flex; align-items: center; justify-content: center; line-height: 1; }
  .sud-pad { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px;
    max-width: 340px; margin: 10px auto 0; }
  .sud-pad button { padding: 8px 0 6px; font-size: 17px; font-weight: 600;
    border-radius: var(--ui-radius); border: 1px solid var(--ui-border);
    background: var(--ui-input-bg); color: var(--ui-text); cursor: pointer;
    font-family: inherit; line-height: 1.1; }
  .sud-pad button small { display: block; font-size: 9px; font-weight: 500;
    color: var(--ui-muted); }
  .sud-pad button.spent { opacity: 0.35; }
  .sud-bar { display: flex; gap: 6px; justify-content: center; align-items: center;
    max-width: 340px; margin: 10px auto 0; }
  .sud-bar button { padding: 6px 12px; font-size: 13px; border-radius: 999px;
    border: 1px solid var(--ui-border); background: var(--ui-input-bg);
    color: var(--ui-text); cursor: pointer; font-family: inherit; }
  .sud-bar button.on { background: var(--ui-accent-soft, rgba(120,140,255,0.13));
    border-color: var(--ui-accent); }
  .sud-bar .sud-clock { margin-left: auto; font-size: 13px; color: var(--ui-muted);
    font-variant-numeric: tabular-nums; }
  .sud-diffs { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap;
    margin: 10px 0 2px; }
  .sud-diffs button { padding: 5px 11px; font-size: 12.5px; border-radius: 999px;
    border: 1px solid var(--ui-border); background: var(--ui-input-bg);
    color: var(--ui-muted); cursor: pointer; font-family: inherit; }
  .sud-diffs button.cur { background: var(--ui-accent-soft, rgba(120,140,255,0.13));
    color: var(--ui-text); border-color: var(--ui-accent); }
  .sud-msg { text-align: center; font-size: 13px; min-height: 18px; margin: 8px 0 0;
    color: var(--ui-muted); }
  .sud-msg b { color: var(--ui-text); }
  `;
  document.head.appendChild(style);

  const KEY = 'cc.sudoku.v1';
  const fmtT = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

  function buildSudoku(view) {
    view.innerHTML =
      '<div class="sud-grid"></div>'
      + '<div class="sud-pad"></div>'
      + '<div class="sud-bar">'
      + '<button type="button" class="sud-notes-btn" title="pencil notes">✏️</button>'
      + '<button type="button" class="sud-undo" title="undo">↶</button>'
      + '<button type="button" class="sud-check" title="check for mistakes">✓</button>'
      + '<span class="sud-clock">0:00</span>'
      + '</div>'
      + '<div class="sud-diffs">'
      + ['easy', 'medium', 'hard', 'expert'].map((d) =>
        '<button type="button" data-d="' + d + '">' + d + '</button>').join('')
      + '</div>'
      + '<div class="sud-msg"></div>';

    const gridEl = view.querySelector('.sud-grid'), padEl = view.querySelector('.sud-pad');
    const msgEl = view.querySelector('.sud-msg'), clockEl = view.querySelector('.sud-clock');
    const notesBtn = view.querySelector('.sud-notes-btn');

    // game state
    let G = null;           // {p, s, v, n, d, elapsed, done}
    let stats = {};         // per-difficulty {done, best}
    let sel = -1, notesMode = false, undoStack = [], flash = null;

    function save() {
      try {
        localStorage.setItem(KEY, JSON.stringify({
          p: G.p.join(''), s: G.s.join(''), v: G.v.join(''), n: G.n,
          d: G.d, elapsed: G.elapsed, done: G.done, stats,
        }));
      } catch (_) {}
    }
    function load() {
      try {
        const j = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (!j || !j.p || j.p.length !== 81) { stats = (j && j.stats) || {}; return false; }
        const toArr = (str) => str.split('').map(Number);
        G = { p: toArr(j.p), s: toArr(j.s), v: toArr(j.v), n: j.n || new Array(81).fill(0),
              d: j.d || 'easy', elapsed: j.elapsed || 0, done: !!j.done };
        stats = j.stats || {};
        return true;
      } catch (_) { return false; }
    }

    function newGame(diff) {
      // synchronous on purpose: measured deals are 1-130ms, it only runs on
      // an explicit tap, and sync keeps the headless harness deterministic
      const seed = (Date.now() ^ (Math.random() * 0xFFFFFFFF)) >>> 0;
      const g = global.SudokuCore.generate(diff, seed);
      G = { p: g.puzzle.slice(), s: g.solution.slice(), v: g.puzzle.slice(),
            n: new Array(81).fill(0), d: diff, elapsed: 0, done: false };
      sel = -1; undoStack = []; flash = null;
      msgEl.textContent = g.clues + ' clues';
      save();
      render();
    }

    function conflicts() {
      const bad = new Set();
      for (const u of global.SudokuCore.UNITS) {
        const seen = {};
        for (const i of u) {
          const d = G.v[i];
          if (!d) continue;
          if (seen[d] != null) { bad.add(i); bad.add(seen[d]); }
          seen[d] = i;
        }
      }
      return bad;
    }

    function pushUndo() {
      undoStack.push({ v: G.v.slice(), n: G.n.slice() });
      if (undoStack.length > 200) undoStack.shift();
    }

    function checkWin() {
      if (G.done || G.v.some((x) => !x)) return;
      for (let i = 0; i < 81; i++) { if (G.v[i] !== G.s[i]) return; }
      G.done = true;
      const st = stats[G.d] || (stats[G.d] = { done: 0, best: 0 });
      st.done++;
      if (!st.best || G.elapsed < st.best) st.best = Math.floor(G.elapsed);
      msgEl.innerHTML = '✨ <b>solved</b> in ' + fmtT(G.elapsed)
        + ' · best ' + fmtT(st.best) + ' · ' + st.done + ' × ' + G.d;
      save();
    }

    function render() {
      if (!G) return;
      const bad = conflicts();
      let h = '';
      for (let i = 0; i < 81; i++) {
        const r = Math.floor(i / 9), c = i % 9;
        const cls = ['sud-cell'];
        if (c === 2 || c === 5) cls.push('br3');
        if (r === 2 || r === 5) cls.push('bb3');
        if (G.p[i]) cls.push('given');
        if (i === sel) cls.push('sel');
        else if (sel >= 0 && G.v[sel] && G.v[i] === G.v[sel]) cls.push('same');
        else if (sel >= 0 && (Math.floor(sel / 9) === r || sel % 9 === c
          || (Math.floor(Math.floor(sel / 9) / 3) === Math.floor(r / 3) && Math.floor((sel % 9) / 3) === Math.floor(c / 3)))) cls.push('unit');
        if (bad.has(i) || (flash && flash.has(i))) cls.push('bad');
        let inner = '';
        if (G.v[i]) inner = G.v[i];
        else if (G.n[i]) {
          inner = '<span class="sud-notes">';
          for (let d = 1; d <= 9; d++) inner += '<span>' + ((G.n[i] & (1 << (d - 1))) ? d : '') + '</span>';
          inner += '</span>';
        }
        h += '<div class="' + cls.join(' ') + '" data-i="' + i + '">' + inner + '</div>';
      }
      gridEl.innerHTML = h;

      // numpad with remaining counts
      const counts = new Array(10).fill(0);
      for (const d of G.v) counts[d]++;
      let ph = '';
      for (let d = 1; d <= 9; d++) {
        const left = 9 - counts[d];
        ph += '<button type="button" data-d="' + d + '"' + (left <= 0 ? ' class="spent"' : '') + '>'
          + d + '<small>' + (left > 0 ? left : '·') + '</small></button>';
      }
      ph += '<button type="button" data-d="0" title="erase">⌫<small> </small></button>';
      padEl.innerHTML = ph;

      view.querySelectorAll('.sud-diffs button').forEach((b) => {
        b.classList.toggle('cur', b.dataset.d === G.d);
        if (!b.dataset.arm) b.textContent = b.dataset.d;
      });
      notesBtn.classList.toggle('on', notesMode);
      clockEl.textContent = fmtT(G.elapsed);
    }

    function tapDigit(d) {
      if (!G || G.done || sel < 0 || G.p[sel]) return;
      pushUndo();
      flash = null;
      if (d === 0) { G.v[sel] = 0; G.n[sel] = 0; }
      else if (notesMode && !G.v[sel]) { G.n[sel] ^= 1 << (d - 1); }
      else if (G.v[sel] === d) { G.v[sel] = 0; }
      else {
        G.v[sel] = d; G.n[sel] = 0;
        // clear this digit from notes in the row/col/box
        for (const u of global.SudokuCore.UNITS) {
          if (u.indexOf(sel) === -1) continue;
          for (const i of u) { if (i !== sel) G.n[i] &= ~(1 << (d - 1)); }
        }
      }
      checkWin();
      save();
      render();
    }

    gridEl.addEventListener('pointerdown', (ev) => {
      const cell = ev.target.closest('.sud-cell');
      if (!cell) return;
      sel = +cell.dataset.i;
      render();
    });
    padEl.addEventListener('pointerdown', (ev) => {
      const b = ev.target.closest('button');
      if (b) tapDigit(+b.dataset.d);
    });
    notesBtn.addEventListener('click', () => { notesMode = !notesMode; render(); });
    view.querySelector('.sud-undo').addEventListener('click', () => {
      const u = undoStack.pop();
      if (!u || !G) return;
      G.v = u.v; G.n = u.n; G.done = false; flash = null;
      save(); render();
    });
    view.querySelector('.sud-check').addEventListener('click', () => {
      if (!G) return;
      flash = new Set();
      for (let i = 0; i < 81; i++) { if (!G.p[i] && G.v[i] && G.v[i] !== G.s[i]) flash.add(i); }
      msgEl.textContent = flash.size ? flash.size + ' cell' + (flash.size > 1 ? 's' : '') + ' off — shown in red'
        : 'no mistakes so far ✨';
      render();
      setTimeout(() => { flash = null; render(); }, 1800);
    });
    // two-tap confirm on the difficulty pills when a game is in progress
    view.querySelector('.sud-diffs').addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      const inProgress = G && !G.done && G.v.some((x, i) => x && !G.p[i]);
      if (inProgress && !b.dataset.arm) {
        b.dataset.arm = '1';
        b.textContent = 'sure?';
        setTimeout(() => { delete b.dataset.arm; b.textContent = b.dataset.d; }, 2500);
        return;
      }
      delete b.dataset.arm;
      newGame(b.dataset.d);
    });

    // timer: ticks while the tool is visible and the puzzle is unsolved
    setInterval(() => {
      if (!G || G.done || view.hidden || !view.offsetParent) return;
      G.elapsed++;
      clockEl.textContent = fmtT(G.elapsed);
      if (G.elapsed % 15 === 0) save();
    }, 1000);

    if (load()) { msgEl.textContent = G.done ? 'solved — deal a new one below' : ''; render(); }
    else newGame('easy');
  }

  // Games live in the Games sub-menu, not the top-level bubble grid
  // (fall back to a plain tool bubble if extras.js predates the hook).
  (global.ExtrasRegisterGame || RT)({
    id: 'sudoku',
    name: 'Sudoku',
    label: 'Sudoku',
    icon: '\u{1F9E9}',
    build: buildSudoku,
  });

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
