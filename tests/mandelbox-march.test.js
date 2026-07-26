// Raymarcher validation for static/mandelbox/src/math/march.js.
//
//   1. Shallow cross-check (2^-25 standoff): render the same 64×48 frame with
//      the perturbation marcher and the independent plain-double marcher
//      (identical constants). Hit masks, hit distances, and normals must
//      agree up to grazing-ray noise — validates camera math, cone-tracing
//      epsilon, dr-cap hit logic, and tetrahedron normals end to end.
//   2. Deep smoke (2^-595 standoff around a 2^-640 surface point): rays must
//      hit with sane step counts, and a hit point converted back to BigInt
//      must have oracle DE below the marcher's epsilon (with slack for the
//      chaotic-tail DE noise documented in the README).
//
// Run: node tests/mandelbox-march.test.js
'use strict';

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

async function main() {
  const t0 = Date.now();
  const base = '../static/mandelbox/src/math/';
  const FE = await import(base + 'floatexp.js');
  const BN = await import(base + 'bignum.js');
  const REF = await import(base + 'reference.js');
  const ORA = await import(base + 'oracle.js');
  const PER = await import(base + 'perturb.js');
  const MAR = await import(base + 'march.js');
  const LOC = await import(base + 'locate.js');
  const { fe, feMulD, feAdd, feToD } = FE;

  const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };

  // Pick the candidate outward direction with the most DE clearance at the
  // camera. IMPORTANT SCALE RULE (learned the hard way): Mandelbox DE
  // reflects escape-time scale, so a camera must stand off at roughly the
  // surface point's bisection scale (2^-(targetBits-10) or so). Farther out,
  // every nearby orbit takes many more folds and DE collapses to the deep
  // scale ("foam") — marching from there would take ~2^30 steps.
  function placeCamera(ref, sE, minDeE, maxIter) {
    const candidates = [[0.8, 0.5, 0.33], [-0.7, 0.6, -0.4], [0.25, -0.9, 0.42], [0.6, 0.2, -0.75], [-0.3, -0.5, 0.8], [13, 8, 3], [-13, -8, -3]];
    let best = null;
    for (const cand of candidates) {
      const v = norm3(cand);
      const o = [fe(v[0], sE), fe(v[1], sE), fe(v[2], sE)];
      const r = PER.perturbDE(ref, { x: o[0], y: o[1], z: o[2] }, maxIter, {});
      if (r.interior || r.capped || r.de.m === 0) continue;
      if (!best || r.de.e > best.camDeE) best = { v, o, camDeE: r.de.e };
    }
    return best && best.camDeE >= minDeE ? best : null;
  }

  // ---------- 1. shallow cross-check ----------
  // Deep enough that DE scales are marchable at the standoff, shallow enough
  // that the plain-double marcher still resolves t (positions are O(1), so
  // doubles run out of t-resolution near 2^-50).
  {
    const prec = 160, maxIter = 400;
    const t = Date.now();
    const { c: C } = LOC.bisectSurface([13n, 8n, 3n], 16, 45, prec, 200);
    const ref = REF.computeMbReference({ ...C, prec }, maxIter);
    ok(ref.len > 40, `[1] shallow reference len ${ref.len}`);

    const sE = -38; // camera standoff ~2^-(target-7) for a 45-bit surface point
    const placed = placeCamera(ref, sE, sE - 30, maxIter);
    ok(!!placed, '[1] found an outward camera direction');
    if (!placed) return finish(t0);
    // SCENE SCALE RULE: the geometry the camera can actually see sits at the
    // measured-clearance scale (DE at the camera), which in foamy locales is
    // finer than the standoff. Epsilon floor and tMax derive from camDeE.
    const sceneE = placed.camDeE;
    // Oblique view (look tilted off the inward axis) so part of the frame
    // can graze off into background.
    const v = placed.v;
    const perp = norm3([v[1] * 0 - v[2] * 1, v[2] * 0 - v[0] * 0, v[0] * 1 - v[1] * 0]); // v × ŷ
    const look = norm3([-v[0] + 1.1 * perp[0], -v[1] + 1.1 * perp[1], -v[2] + 1.1 * perp[2]]);
    const cam = MAR.makeCamera(placed.o, look, 0.8);

    const W = 64, H = 48;
    const opts = { maxIter, maxSteps: 300, relax: 0.85, epsAbs: fe(1, sceneE - 14), tMax: fe(1, sceneE + 8) };
    const tp0 = Date.now();
    const rp = MAR.renderRows(ref, cam, W, H, 0, H, opts);
    const perturbMs = Date.now() - tp0;

    const Cd = [BN.toDouble(C.x, prec), BN.toDouble(C.y, prec), BN.toDouble(C.z, prec)];
    const camPos = [Cd[0] + feToD(placed.o[0]), Cd[1] + feToD(placed.o[1]), Cd[2] + feToD(placed.o[2])];
    const dopts = { maxIter, maxSteps: 300, relax: 0.85, epsAbsD: 2 ** (sceneE - 14), tMaxD: 2 ** (sceneE + 8) };
    const rd = MAR.renderRowsDouble(camPos, cam, W, H, 0, H, dopts);

    let hitsP = 0, hitsD = 0, maskAgree = 0, common = 0, tAgree = 0, nAgree = 0;
    for (let i = 0; i < W * H; i++) {
      hitsP += rp.hit[i]; hitsD += rd.hit[i];
      if (rp.hit[i] === rd.hit[i]) maskAgree++;
      if (rp.hit[i] && rd.hit[i]) {
        common++;
        if (Math.abs(rp.tlog[i] - rd.tlog[i]) < 0.15) tAgree++;
        const dot = rp.nx[i] * rd.nx[i] + rp.ny[i] * rd.ny[i] + rp.nz[i] * rd.nz[i];
        if (dot > 0.9) nAgree++;
      }
    }
    ok(hitsP > W * H * 0.05, `[1] scene has hits (perturb hits ${hitsP}/${W * H})`);
    ok(maskAgree >= W * H * 0.95, `[1] hit masks agree ${maskAgree}/${W * H}`);
    ok(common > 0 && tAgree >= common * 0.9, `[1] hit distances agree ${tAgree}/${common}`);
    ok(common > 0 && nAgree >= common * 0.85, `[1] normals agree ${nAgree}/${common}`);

    // renderSpan (the worker's interruptible slicing unit) must reproduce
    // renderRows exactly when its pieces are assembled.
    {
      const PER2 = await import(base + 'perturb.js');
      const rowsN = 4, n = W * rowsN;
      const out = {
        hit: new Uint8Array(n), nx: new Float32Array(n), ny: new Float32Array(n), nz: new Float32Array(n),
        steps: new Uint16Array(n), tlog: new Float32Array(n),
      };
      const o2 = { ...opts, scratch: PER2.makePerturbScratch() };
      for (let j = 0; j < rowsN; j++) {
        for (let x = 0; x < W; x += 7) {
          MAR.renderSpan(ref, cam, W, H, j, x, Math.min(W, x + 7), o2, out, j * W + x);
        }
      }
      let same = true;
      for (let i = 0; i < n && same; i++) {
        if (out.hit[i] !== rp.hit[i] || out.steps[i] !== rp.steps[i] || out.tlog[i] !== rp.tlog[i]
          || out.nx[i] !== rp.nx[i] || out.ny[i] !== rp.ny[i] || out.nz[i] !== rp.nz[i]) same = false;
      }
      ok(same, '[1] renderSpan slices assemble bit-identical to renderRows');
    }
    console.log(`  [1] shallow 64x48: perturb ${hitsP} hits vs double ${hitsD}; mask ${maskAgree}, t ${tAgree}/${common}, n ${nAgree}/${common}`
      + ` — perturb frame ${perturbMs}ms, ${rp.stats.evals} evals, ${rp.stats.iters} iters (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  }

  // ---------- 2. deep smoke at 2^-632 (around a 640-bit surface point) ----------
  {
    const prec = 700, maxIter = 1600;
    const t = Date.now();
    const { c: C } = LOC.bisectSurface([13n, 8n, 3n], 16, 640, prec, 900);
    const ref = REF.computeMbReference({ ...C, prec }, maxIter);
    ok(ref.len > 300, `[2] deep reference len ${ref.len}`);

    const sE = -633;
    const placed = placeCamera(ref, sE, sE - 40, maxIter);
    ok(!!placed, '[2] found an outward camera direction at depth');
    if (!placed) return finish(t0);
    const sceneE = placed.camDeE;
    console.log(`  [2] camera clearance 2^${sceneE} at standoff 2^${sE}`);

    const epsAbs = fe(1, sceneE - 14), tMax = fe(1, sceneE + 8);
    const opts = { maxIter, maxSteps: 300, relax: 0.85, pixFactor: 0.03, epsAbs, tMax, scratch: PER.makePerturbScratch() };
    let rng = 31337;
    const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    let hits = 0, totalSteps = 0, checkedOracle = false;
    for (let k = 0; k < 8; k++) {
      const dir = norm3([
        -placed.v[0] + 0.25 * (rand() * 2 - 1),
        -placed.v[1] + 0.25 * (rand() * 2 - 1),
        -placed.v[2] + 0.25 * (rand() * 2 - 1),
      ]);
      const r = MAR.marchRay(ref, placed.o, dir, opts);
      totalSteps += r.steps;
      if (!r.hit) continue;
      hits++;
      if (!checkedOracle) {
        checkedOracle = true;
        // Convert the hit point back to exact fixed point, ask the oracle.
        const P = [0, 1, 2].map((i) => {
          const TT = fe(), Pi = fe();
          feMulD(TT, r.t, dir[i]); feAdd(Pi, placed.o[i], TT);
          return Pi;
        });
        const cHit = { x: C.x + BN.feToBig(P[0], prec), y: C.y + BN.feToBig(P[1], prec), z: C.z + BN.feToBig(P[2], prec) };
        const od = ORA.oracleDE(cHit, prec, maxIter);
        // Compare in log2 space — these magnitudes underflow doubles.
        const tLog = Math.log2(Math.abs(r.t.m)) + r.t.e;
        const hepsLog = Math.max(Math.log2(0.03) + tLog, sceneE - 14);
        const oDeLog = od.interior ? -Infinity : Math.log2(Math.abs(od.de.m)) + od.de.e;
        // Slack 6 bits (×64) for chaotic-tail DE noise; the point of the check
        // is "the marcher stopped somewhere the oracle also calls surface-close".
        ok(oDeLog <= hepsLog + 6, `[2] oracle DE at hit 2^${oDeLog.toFixed(1)} vs eps 2^${hepsLog.toFixed(1)}`);
        console.log(`  [2] oracle spot check: DE(hit)=2^${oDeLog.toFixed(1)}, eps=2^${hepsLog.toFixed(1)}, oracle n=${od.n}${od.interior ? ' (interior)' : ''}`);
      }
    }
    ok(hits >= 2, `[2] deep rays hit (${hits}/8)`);
    ok(totalSteps < 8 * 250, `[2] step counts sane (${totalSteps})`);
    console.log(`  [2] deep 2^-595: ${hits}/8 rays hit, ${totalSteps} total steps (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  }

  finish(t0);
}

function finish(t0) {
  console.log(`\n${passed} passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
