// Validation suite for the Mandelbox deep-zoom perturbation engine
// (static/mandelbox/src/math/). Proves the core claim end-to-end:
//
//   perturbation + rebasing + floatexp reproduces the EXACT BigInt oracle,
//   iteration by iteration, for as long as the delta is genuinely small —
//   at zoom depths down to 2^-1000 around a real Mandelbox surface point.
//
// What is (and isn't) asserted, and why: once δ grows to O(1) the engine is
// in permanent-rebase mode — direct double-class iteration — and the
// Mandelbox's bounded chaotic wandering (unlike Mandelbrot's fast
// post-divergence escape) amplifies ordinary rounding at λ~2/iter, so
// FORWARD values necessarily drift from the oracle there. That phase is
// backward-stable (the result is exact for a point displaced ~2^-50 of the
// pixel scale — the rendered image is correct), so the suite asserts:
//   • exact-oracle agreement per iteration through the TRACKED phase
//     (|δ| ≤ 2^-25·|z|) — this is where every piece of the novel machinery
//     (residual algebra, region classification, rebasing) must be perfect;
//   • the tracked phase lasts as long as the depth demands (δ can only grow
//     ~16×/iter, so n* ≥ (D−40)/4 — catches any early delta blowup);
//   • deterministic crossing tests: centers engineered so box-fold and
//     sphere-fold region crossings fire in iteration 1-2 WHILE δ is tiny,
//     where a wrong branch formula breaks agreement at 2^-25 scale;
//   • escape iteration + DE match the oracle whenever the chaotic tail is
//     short enough (≤ 8 iterations) for forward comparison to be meaningful.
//
// Sections:
//   1. floatexp arithmetic
//   2. BigInt oracle vs an independent plain-double implementation
//   3. engineered fold-crossing centers (deterministic branch validation)
//   4. deep zoom: surface bisection to ~2^-1040, then oracle-vs-perturbation
//      at depths 2^-8 .. 2^-1000
//
// Run: node tests/mandelbox-perturb.test.js
'use strict';

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

async function main() {
  const t0 = Date.now();
  const base = '../static/mandelbox/src/math/';
  const FE = await import(base + 'floatexp.js');
  const BN = await import(base + 'bignum.js');
  const MB = await import(base + 'mandelbox.js');
  const REF = await import(base + 'reference.js');
  const ORA = await import(base + 'oracle.js');
  const PER = await import(base + 'perturb.js');

  const { fe, feAdd, feSub, feMul, feMulD, feDiv, feSqrt, feCmp, feToD, feSetD } = FE;

  // Compare one point: run oracle + perturb with traces, assert per-iteration
  // agreement through the tracked phase. Returns diagnostics.
  function comparePoint(ref, cBig, dcBig, prec, maxIter, label, stats) {
    const oz = [];
    const o = ORA.oracleDE(cBig, prec, maxIter, (n, st) => {
      oz[n] = [BN.toDouble(st.nx, prec), BN.toDouble(st.ny, prec), BN.toDouble(st.nz, prec)];
    });
    const dc = { x: BN.bigToFe(dcBig[0], prec), y: BN.bigToFe(dcBig[1], prec), z: BN.bigToFe(dcBig[2], prec) };
    const pz = [];
    const p = PER.perturbDE(ref, dc, maxIter, stats, (n, m, zf, d) => {
      pz[n] = [feToD(zf[0]), feToD(zf[1]), feToD(zf[2]),
               Math.max(Math.abs(feToD(d[0])), Math.abs(feToD(d[1])), Math.abs(feToD(d[2])))];
    });

    // Tracked phase: |δ| ≤ 2^-25 · |z| for every iteration so far.
    const nBoth = Math.min(o.interior ? maxIter : o.n, p.interior ? maxIter : p.n);
    let nStar = 0;
    for (let n = 1; n <= nBoth; n++) {
      if (!oz[n] || !pz[n]) break;
      const zmax = Math.max(Math.abs(oz[n][0]), Math.abs(oz[n][1]), Math.abs(oz[n][2]), 1e-12);
      if (pz[n][3] > zmax * 2 ** -25) break;
      nStar = n;
    }
    let maxRel = 0;
    for (let n = 1; n <= nStar; n++) {
      const zmax = Math.max(Math.abs(oz[n][0]), Math.abs(oz[n][1]), Math.abs(oz[n][2]), 1e-12);
      const err = Math.max(Math.abs(oz[n][0] - pz[n][0]), Math.abs(oz[n][1] - pz[n][1]), Math.abs(oz[n][2] - pz[n][2])) / zmax;
      if (err > maxRel) maxRel = err;
    }
    ok(maxRel < 1e-8, `${label}: tracked-phase divergence ${maxRel} over n<=${nStar}`);

    // Short chaotic tail ⇒ forward escape/DE comparison is meaningful.
    const tail = (o.interior ? maxIter : o.n) - nStar;
    let deRel = null;
    if (!o.interior && tail <= 8) {
      ok(!p.interior && p.n === o.n, `${label}: short-tail escape mismatch (oracle n=${o.n}, perturb ${p.interior ? 'interior' : 'n=' + p.n})`);
      if (!p.interior && p.n === o.n) {
        deRel = Math.abs(feToD(o.de) - feToD(p.de)) / feToD(o.de);
        ok(deRel < 1e-4, `${label}: short-tail DE rel err ${deRel}`);
      }
    }
    return { o, p, nStar, tail, maxRel, deRel };
  }

  // ---------- 1. floatexp ----------
  {
    let rng = 12345;
    const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    const T = fe();
    for (let i = 0; i < 2000; i++) {
      const a = (rand() * 2 - 1) * 2 ** Math.floor(rand() * 40 - 20);
      const b = (rand() * 2 - 1) * 2 ** Math.floor(rand() * 40 - 20);
      if (a === 0 || b === 0) continue;
      const A = feSetD(fe(), a), B = feSetD(fe(), b);
      if (Math.abs(feToD(feAdd(T, A, B)) - (a + b)) > Math.abs(a + b) * 1e-13 + 1e-30) { ok(false, `feAdd ${a}+${b}`); break; }
      if (Math.abs(feToD(feSub(T, A, B)) - (a - b)) > Math.abs(a - b) * 1e-13 + 1e-30) { ok(false, `feSub ${a}-${b}`); break; }
      if (Math.abs(feToD(feMul(T, A, B)) - a * b) > Math.abs(a * b) * 1e-13) { ok(false, `feMul ${a}*${b}`); break; }
      if (Math.abs(feToD(feDiv(T, A, B)) - a / b) > Math.abs(a / b) * 1e-13) { ok(false, `feDiv ${a}/${b}`); break; }
      if (feCmp(A, B) !== Math.sign(a - b)) { ok(false, `feCmp ${a} vs ${b}`); break; }
    }
    ok(true, 'floatexp in-range arithmetic');

    const tiny = fe(3, -2000);
    const sq = feMul(fe(), tiny, tiny);   // 9·2^-4000
    ok(Math.abs(sq.m * 2 ** (sq.e + 4000) - 9) < 1e-12, `deep square: got m=${sq.m} e=${sq.e}`);
    const rt = feSqrt(fe(), sq);
    ok(Math.abs(rt.m * 2 ** (rt.e + 2000) - 3) < 1e-12, `deep sqrt: got m=${rt.m} e=${rt.e}`);
    const sum = feAdd(fe(), fe(1, -1000), fe(1, -2000));
    ok(sum.e === -1000 && sum.m === 1, 'absorption of far-smaller addend');
    const s2 = feAdd(fe(), fe(1, -1000), fe(-1, -1000));
    ok(s2.m === 0, 'exact cancellation to zero');
    const v = BN.bigToFe(3n, 2000);
    ok(Math.abs(v.m * 2 ** (v.e + 2000) - 3) < 1e-12, 'bigToFe deep value');
  }

  // ---------- 2. oracle vs independent double implementation ----------
  {
    let rng = 987;
    const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    const prec = 120;
    let tested = 0, maxRel = 0;
    for (let i = 0; i < 400 && tested < 40; i++) {
      const cx = (rand() * 2 - 1) * 7, cy = (rand() * 2 - 1) * 7, cz = (rand() * 2 - 1) * 7;
      const dbl = MB.mandelboxDEDouble(cx, cy, cz, 60);
      if (dbl.interior || dbl.n > 18) continue;
      tested++;
      const c = { x: BN.fromDouble(cx, prec), y: BN.fromDouble(cy, prec), z: BN.fromDouble(cz, prec) };
      const o = ORA.oracleDE(c, prec, 60);
      ok(!o.interior && o.n === dbl.n, `oracle n=${o.n} vs double n=${dbl.n} at (${cx.toFixed(3)},${cy.toFixed(3)},${cz.toFixed(3)})`);
      if (!o.interior && o.n === dbl.n) {
        const rel = Math.abs(feToD(o.de) - dbl.de) / dbl.de;
        maxRel = Math.max(maxRel, rel);
        ok(rel < 1e-7, `oracle DE rel err ${rel} at short orbit`);
      }
    }
    ok(tested >= 30, `oracle-vs-double sample count ${tested}`);
    console.log(`  [2] oracle vs double: ${tested} pts, max DE rel err ${maxRel.toExponential(2)}`);
  }

  // ---------- 3. engineered fold crossings while δ is tiny ----------
  // Each center puts the iteration-1 state within ~2^-30 of a fold boundary;
  // deltas of ~2^-26 then cross it during the tracked phase, so a wrong
  // branch formula shows up as an immediate 2^-26-scale divergence. (Z_1 = C
  // because Z_0 = 0 folds to 0.)
  {
    const prec = 220, maxIter = 60;
    const U = 2 ** -30;
    const cases = [
      ['box mid->above/above->mid (x near +1)', [1 - U, 0.3, 0.2]],
      ['box above-side (x just past +1)', [1 + U, 0.3, 0.2]],
      ['box mid->below (y near -1)', [0.3, -1 + U, 0.2]],
      ['box below-side (y just past -1)', [0.3, -1 - U, 0.2]],
      // |B|² = 0.25 ± ~2^-30 → sphere lin/inv boundary
      ['sphere inv-side of r2=1/4', [0.3, 0.4, 2 ** -15]],
      ['sphere lin-side of r2=1/4', [0.3, 0.4 * (1 - 2 ** -32), 0]],
      // |B|² = 1 ± ~2^-30 → sphere inv/id boundary
      ['sphere id-side of r2=1', [0.6, 0.8, 2 ** -15]],
      ['sphere inv-side of r2=1', [0.6, 0.8 * (1 - 2 ** -32), 0]],
    ];
    let rng = 777;
    const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    for (const [label, cd] of cases) {
      const C = { x: BN.fromDouble(cd[0], prec), y: BN.fromDouble(cd[1], prec), z: BN.fromDouble(cd[2], prec) };
      const ref = REF.computeMbReference({ ...C, prec }, maxIter);
      const stats = { boxCross: 0, sphCross: 0 };
      let minNStar = Infinity;
      for (let s = 0; s < 24; s++) {
        const dcBig = [0, 1, 2].map(() => {
          const mant = BigInt(Math.floor((rand() * 2 - 1) * 2 ** 30));
          return mant << BigInt(prec - 28 - 30);
        });
        const c = { x: C.x + dcBig[0], y: C.y + dcBig[1], z: C.z + dcBig[2] };
        const r = comparePoint(ref, c, dcBig, prec, maxIter, `[3] ${label} s=${s}`, stats);
        minNStar = Math.min(minNStar, r.nStar);
      }
      ok(minNStar >= 1, `[3] ${label}: tracked phase exists (min n*=${minNStar})`);
      ok(stats.boxCross + stats.sphCross > 0, `[3] ${label}: no fold crossing fired`);
    }
    console.log('  [3] engineered crossings: all cases compared');
  }

  // ---------- 3b. escape/DE path via fast-escaping references ----------
  // A reference that escapes quickly keeps δ tracked all the way to the
  // bailout (tail 0), so comparePoint's short-tail assertions — escape
  // iteration equality and DE agreement — actually fire, validating the
  // dr accumulation, bailout compare, and DE = r/dr in floatexp.
  {
    const prec = 200, maxIter = 90;
    let rng = 5150;
    const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    const candidates = [[3.2, 1.1, 0.6], [2.7, 1.9, 0.4], [4.1, 0.3, 1.2], [1.9, 2.3, 1.1], [3.6, 2.2, 0.9]];
    let used = 0, shortTails = 0;
    for (const cd of candidates) {
      const dbl = MB.mandelboxDEDouble(cd[0], cd[1], cd[2], maxIter);
      if (dbl.interior || dbl.n < 20 || dbl.n > 60) continue;
      used++;
      const C = { x: BN.fromDouble(cd[0], prec), y: BN.fromDouble(cd[1], prec), z: BN.fromDouble(cd[2], prec) };
      const ref = REF.computeMbReference({ ...C, prec }, maxIter);
      for (let s = 0; s < 16; s++) {
        const dcBig = [0, 1, 2].map(() => {
          const mant = BigInt(Math.floor((rand() * 2 - 1) * 2 ** 30));
          return mant << BigInt(prec - 48 - 30);
        });
        const c = { x: C.x + dcBig[0], y: C.y + dcBig[1], z: C.z + dcBig[2] };
        const r = comparePoint(ref, c, dcBig, prec, maxIter, `[3b] esc-ref (${cd}) s=${s}`, null);
        if (!r.o.interior && r.tail <= 8) shortTails++;
      }
      if (used >= 3) break;
    }
    ok(used >= 2, `[3b] enough fast-escaping references (${used})`);
    ok(shortTails >= 20, `[3b] short-tail escape/DE checks actually fired (${shortTails})`);
    console.log(`  [3b] escape/DE path: ${used} refs, ${shortTails} short-tail checks`);
  }

  // ---------- 4. deep zoom around a real surface point ----------
  const DN = [13n, 8n, 3n];
  const S = 1050, TARGET = 1040, PREC = 1100, MAXIT = 1300;
  function cOf(mu, p) {
    const sh = BigInt(p) - BigInt(S) - 4n;
    const mk = (dn) => sh >= 0n ? (mu * dn) << sh : (mu * dn) >> -sh;
    return { x: mk(DN[0]), y: mk(DN[1]), z: mk(DN[2]) };
  }

  let lo = 0n;                               // origin: interior (fixed point)
  let hi = 16n << BigInt(S);                 // c=(13,8,3): verified fast escaper
  {
    const t = Date.now();
    ok(ORA.oracleEscapes(cOf(hi, 200), 200, 100) > 0, 'outer bisection seed escapes');
    for (let k = 1; k <= TARGET; k++) {
      const mid = (lo + hi) >> 1n;
      const p = Math.min(PREC, k + 100);
      const n = ORA.oracleEscapes(cOf(mid, p), p, Math.min(MAXIT, k + 80));
      if (n > 0) hi = mid; else lo = mid;
    }
    console.log(`  [4] surface bisection to 2^-${TARGET}: ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }

  const C = cOf(lo, PREC);
  let ref;
  {
    const t = Date.now();
    ref = REF.computeMbReference({ x: C.x, y: C.y, z: C.z, prec: PREC }, MAXIT);
    console.log(`  [4] reference orbit: len=${ref.len} escaped=${ref.escaped} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    ok(ref.len > 200, `reference orbit long enough (len=${ref.len})`);
  }

  let rng = 424242;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  const depths = [[8, 30], [24, 12], [120, 10], [400, 10], [1000, 10]];
  const stats = { boxCross: 0, sphCross: 0 };
  let totalRebases = 0;

  for (const [D, count] of depths) {
    const t = Date.now();
    let minNStar = Infinity, shortTails = 0, interior = 0, worstTrack = 0;
    for (let s = 0; s < count; s++) {
      const dcBig = [0, 1, 2].map(() => {
        const mant = BigInt(Math.floor((rand() * 2 - 1) * 2 ** 40));
        return mant << BigInt(PREC - D - 40);
      });
      const c = { x: C.x + dcBig[0], y: C.y + dcBig[1], z: C.z + dcBig[2] };
      const r = comparePoint(ref, c, dcBig, PREC, MAXIT, `[4] depth 2^-${D} s=${s}`, stats);
      totalRebases += r.p.rebases;
      minNStar = Math.min(minNStar, r.nStar);
      worstTrack = Math.max(worstTrack, r.maxRel);
      if (r.o.interior) interior++;
      if (!r.o.interior && r.tail <= 8) shortTails++;
    }
    // δ grows at most ~16×/iteration, so from 2^-D it cannot reach 2^-25·|z|
    // before ~(D-40)/4 iterations — an early exit means the delta blew up.
    if (D >= 120) ok(minNStar >= Math.floor((D - 40) / 4), `depth 2^-${D}: tracked phase too short (min n*=${minNStar})`);
    console.log(`  [4] depth 2^-${D}: min n*=${minNStar}, worst tracked err ${worstTrack.toExponential(2)}, ${shortTails} short-tail escape checks, ${interior} interior (${((Date.now() - t) / 1000).toFixed(1)}s)`);

    // Interior-verdict agreement: rerun a few samples with the iteration cap
    // INSIDE the tracked phase (cap ≤ n*), where δ is still tiny and the
    // interior verdict is deterministic on both sides (validates the maxIter
    // path end to end). A cap beyond n* would race the chaotic tail instead.
    if (D >= 400) {
      const capIter = D >= 1000 ? 800 : 300;
      for (let s = 0; s < 3; s++) {
        const dcBig = [0, 1, 2].map(() => {
          const mant = BigInt(Math.floor((rand() * 2 - 1) * 2 ** 40));
          return mant << BigInt(PREC - D - 40);
        });
        const c = { x: C.x + dcBig[0], y: C.y + dcBig[1], z: C.z + dcBig[2] };
        const r = comparePoint(ref, c, dcBig, PREC, capIter, `[4] depth 2^-${D} interior s=${s}`, stats);
        ok(r.o.interior && r.p.interior, `[4] depth 2^-${D} capIter=${capIter}: interior verdict (oracle=${r.o.interior}, perturb=${r.p.interior})`);
      }
    }
  }

  ok(stats.boxCross > 0, `box-fold crossings exercised (${stats.boxCross})`);
  ok(stats.sphCross > 0, `sphere-fold crossings exercised (${stats.sphCross})`);
  console.log(`  [4] crossings: box=${stats.boxCross} sphere=${stats.sphCross}, rebases=${totalRebases}`);

  console.log(`\n${passed} passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
