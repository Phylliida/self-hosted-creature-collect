// render-demo.mjs — render a deep-zoom Mandelbox frame to PNG using the
// perturbation raymarcher across worker threads.
//
//   node static/mandelbox/tools/render-demo.mjs [depthBits] [W] [H] [workers]
//
// Phase A (scout): several candidate surface rays are bisected and
// tiny-rendered in parallel; each locale is scored for visual interest
// (normal variance + depth variance + silhouette mix — the Mandelbox has
// large flat fold-faces that render as blank walls, so a random ray needs
// vetting). Phase B: the winning locale is rendered at full size.
//
// Scene scaling per the rule learned in testing: stand off ~2^-(depth-7)
// from the bisected point, then derive epsilon floor and tMax from the
// MEASURED DE at the camera (clearance) — deep Mandelbox geometry is foamy
// and the visible scene sits at clearance scale, not standoff scale.

import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };

const CAM_CANDS = [[0.8, 0.5, 0.33], [-0.7, 0.6, -0.4], [0.25, -0.9, 0.42], [0.6, 0.2, -0.75], [-0.3, -0.5, 0.8], [13, 8, 3], [-13, -8, -3]];

async function buildLocale(ray, depthBits, tilt) {
  const FE = await import(join(HERE, '../src/math/floatexp.js'));
  const REF = await import(join(HERE, '../src/math/reference.js'));
  const PER = await import(join(HERE, '../src/math/perturb.js'));
  const LOC = await import(join(HERE, '../src/math/locate.js'));
  const { fe } = FE;
  const prec = depthBits + 110;
  const maxIter = depthBits + 500;
  const { c: C, mu } = LOC.bisectSurface(ray.map(BigInt), 16, depthBits, prec, depthBits + 200);
  const ref = REF.computeMbReference({ ...C, prec }, maxIter);
  const sE = -(depthBits - 7);
  let best = null;
  for (const cand of CAM_CANDS) {
    const v = norm3(cand);
    const o = [fe(v[0], sE), fe(v[1], sE), fe(v[2], sE)];
    const r = PER.perturbDE(ref, { x: o[0], y: o[1], z: o[2] }, maxIter, {});
    if (r.interior || r.capped || r.de.m === 0) continue;
    if (!best || r.de.e > best.camDeE) best = { v, o, camDeE: r.de.e };
  }
  if (!best) return null;
  const v = best.v;
  const perp = norm3([-v[2], 0, v[0]]);
  const look = norm3([-v[0] + tilt * perp[0], -v[1] + tilt * perp[1], -v[2] + tilt * perp[2]]);
  const fwd = look;
  const upHint = Math.abs(fwd[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
  const cr = norm3([fwd[1] * upHint[2] - fwd[2] * upHint[1], fwd[2] * upHint[0] - fwd[0] * upHint[2], fwd[0] * upHint[1] - fwd[1] * upHint[0]]);
  const up = [cr[1] * fwd[2] - cr[2] * fwd[1], cr[2] * fwd[0] - cr[0] * fwd[2], cr[0] * fwd[1] - cr[1] * fwd[0]];
  const cam = { o: best.o.map((x) => ({ m: x.m, e: x.e })), fwd, right: cr, up, planeScale: 1.0 };
  const sceneE = best.camDeE;
  const opts = {
    maxIter, maxSteps: 300, relax: 0.85,
    epsAbs: { m: 1, e: sceneE - 14 }, tMax: { m: 1, e: sceneE + 8 },
  };
  const refPlain = {
    prec: ref.prec, len: ref.len, escaped: ref.escaped,
    zx: ref.zx.slice(), zy: ref.zy.slice(), zz: ref.zz.slice(),
    boxReg: ref.boxReg.slice(),
    uM: ref.uM.slice(), uE: ref.uE.slice(), wM: ref.wM.slice(), wE: ref.wE.slice(),
    bx: ref.bx.slice(), by: ref.by.slice(), bz: ref.bz.slice(),
    rho2: ref.rho2.slice(), sphReg: ref.sphReg.slice(),
    rMM: ref.rMM.slice(), rME: ref.rME.slice(),
    rFM: ref.rFM.slice(), rFE: ref.rFE.slice(),
  };
  return { ref: refPlain, cam, opts, sceneE, sE, mu: mu.toString(), prec, maxIter };
}

if (!isMainThread) {
  const { renderRows } = await import(join(HERE, '../src/math/march.js'));
  if (workerData.mode === 'scout') {
    const { ray, depthBits, tilt, SW, SH } = workerData;
    const loc = await buildLocale(ray, depthBits, tilt);
    if (!loc) { parentPort.postMessage({ ray, score: -1 }); process.exit(0); }
    const r = renderRows(loc.ref, loc.cam, SW, SH, 0, SH, loc.opts);
    // Interest score: normal variance (1 - |mean n|), depth variance, and a
    // strong bonus for a hit/miss mix (silhouettes).
    let mx = 0, my = 0, mz = 0, hits = 0, tsum = 0, tsq = 0;
    const N = SW * SH;
    for (let i = 0; i < N; i++) {
      if (!r.hit[i]) continue;
      hits++;
      mx += r.nx[i]; my += r.ny[i]; mz += r.nz[i];
      tsum += r.tlog[i]; tsq += r.tlog[i] * r.tlog[i];
    }
    let score = -1;
    if (hits > N * 0.05) {
      const nvar = 1 - Math.hypot(mx, my, mz) / hits;
      const tstd = Math.sqrt(Math.max(0, tsq / hits - (tsum / hits) ** 2));
      const missFrac = 1 - hits / N;
      score = nvar * 2 + Math.min(2, tstd) + 6 * missFrac * (1 - missFrac) + (missFrac > 0.02 ? 1 : 0);
    }
    parentPort.postMessage({ ray, score, hits, N, sceneE: loc.sceneE });
    process.exit(0);
  } else {
    const { ref, cam, W, H, opts } = workerData;
    parentPort.on('message', (msg) => {
      if (msg === 'done') { process.exit(0); }
      const r = renderRows(ref, cam, W, H, msg.y0, msg.y1, opts);
      parentPort.postMessage(r, [r.hit.buffer, r.nx.buffer, r.ny.buffer, r.nz.buffer, r.steps.buffer, r.tlog.buffer]);
    });
  }
} else {
  const t0 = Date.now();
  const { encodePNG } = await import(join(HERE, 'png.mjs'));

  const depthBits = parseInt(process.argv[2] || '1040', 10);
  const W = parseInt(process.argv[3] || '256', 10);
  const H = parseInt(process.argv[4] || '192', 10);
  const nWorkers = parseInt(process.argv[5] || String(Math.min(40, os.cpus().length - 2)), 10);
  const TILT = 0.8;

  // ---- Phase A: scout candidate rays in parallel ----
  const RAYS = [[13, 8, 3], [7, 11, 2], [3, 5, 14], [15, 2, 9], [6, 13, 10], [1, 9, 4], [11, 3, 12], [5, 15, 7]];
  console.log(`scouting ${RAYS.length} rays at depth 2^-${depthBits}...`);
  const scouts = await Promise.all(RAYS.map((ray) => new Promise((resolve) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { mode: 'scout', ray, depthBits, tilt: TILT, SW: 24, SH: 18 } });
    w.on('message', resolve);
    w.on('error', (e) => { console.error(`scout [${ray}] error:`, e.message); resolve({ ray, score: -1 }); });
  })));
  scouts.sort((a, b) => b.score - a.score);
  for (const s of scouts) console.log(`  ray [${s.ray}]: score ${s.score.toFixed(2)}${s.hits !== undefined ? ` (${s.hits}/${s.N} hits, clearance 2^${s.sceneE})` : ''}`);
  const winner = scouts[0];
  if (winner.score < 0) { console.error('no viable locale found'); process.exit(1); }
  console.log(`winner: ray [${winner.ray}] (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // ---- Phase B: full render of the winner ----
  const loc = await buildLocale(winner.ray, depthBits, TILT);
  const { ref: refPlain, cam, opts, sceneE, sE, mu, prec, maxIter } = loc;
  const { fwd, right: cr, up } = cam;
  console.log(`camera: standoff 2^${sE}, clearance 2^${sceneE}, ref len ${refPlain.len}`);

  const hit = new Uint8Array(W * H);
  const nx = new Float32Array(W * H), ny = new Float32Array(W * H), nz = new Float32Array(W * H);
  const steps = new Uint16Array(W * H);
  const tlog = new Float32Array(W * H);
  const CHUNK = 2;
  let nextRow = 0, doneRows = 0, totDegen = 0, totEvals = 0;
  const tRender = Date.now();

  await new Promise((resolve, reject) => {
    const workers = [];
    const feed = (w) => {
      if (nextRow >= H) { w.postMessage('done'); return; }
      const y0 = nextRow, y1 = Math.min(H, y0 + CHUNK);
      nextRow = y1;
      w.postMessage({ y0, y1 });
    };
    for (let k = 0; k < nWorkers; k++) {
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { mode: 'render', ref: refPlain, cam, W, H, opts } });
      workers.push(w);
      w.on('error', reject);
      w.on('message', (r) => {
        const off = r.y0 * W, n = (r.y1 - r.y0) * W;
        hit.set(r.hit.subarray(0, n), off);
        nx.set(r.nx.subarray(0, n), off); ny.set(r.ny.subarray(0, n), off); nz.set(r.nz.subarray(0, n), off);
        steps.set(r.steps.subarray(0, n), off);
        tlog.set(r.tlog.subarray(0, n), off);
        totDegen += r.stats.degen; totEvals += r.stats.evals;
        doneRows += r.y1 - r.y0;
        if (doneRows % 24 === 0) process.stdout.write(`\r  rows ${doneRows}/${H} (${((Date.now() - tRender) / 1000).toFixed(0)}s)`);
        if (doneRows >= H) { workers.forEach((x) => x.postMessage('done')); resolve(); }
        else feed(w);
      });
      feed(w);
    }
  });
  console.log(`\nmarching done in ${((Date.now() - tRender) / 1000).toFixed(1)}s (${totEvals} evals, ${totDegen} degen normals)`);

  // ---- shading (camera-relative key + fill, AO, depth fog, gamma) ----
  const rgb = new Uint8Array(W * H * 3);
  const L1 = norm3([
    -fwd[0] + 0.55 * up[0] + 0.4 * cr[0],
    -fwd[1] + 0.55 * up[1] + 0.4 * cr[1],
    -fwd[2] + 0.55 * up[2] + 0.4 * cr[2],
  ]);
  const L2 = norm3([
    -0.25 * fwd[0] - 0.5 * up[0] - 0.8 * cr[0],
    -0.25 * fwd[1] - 0.5 * up[1] - 0.8 * cr[1],
    -0.25 * fwd[2] - 0.5 * up[2] - 0.8 * cr[2],
  ]);
  let tmin = Infinity, tmax = -Infinity;
  for (let i = 0; i < W * H; i++) if (hit[i]) { if (tlog[i] < tmin) tmin = tlog[i]; if (tlog[i] > tmax) tmax = tlog[i]; }
  const tspan = Math.max(1e-6, tmax - tmin);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const idx = j * W + i;
      let r, g, b; // linear 0..1
      if (!hit[idx]) {
        const ty = j / H;
        const glow = Math.min(1, steps[idx] / 120);
        r = 0.015 + 0.03 * (1 - ty) + 0.10 * glow;
        g = 0.02 + 0.035 * (1 - ty) + 0.09 * glow;
        b = 0.045 + 0.06 * (1 - ty) + 0.17 * glow;
      } else {
        const n = [nx[idx], ny[idx], nz[idx]];
        const lam1 = Math.max(0, n[0] * L1[0] + n[1] * L1[1] + n[2] * L1[2]);
        const lam2 = Math.max(0, n[0] * L2[0] + n[1] * L2[1] + n[2] * L2[2]);
        const ao = 0.35 + 0.65 / (1 + steps[idx] * 0.012);
        const fog = (tlog[idx] - tmin) / tspan;
        const a0 = 0.72 + 0.22 * n[0], a1 = 0.68 + 0.18 * n[1], a2 = 0.74 + 0.24 * n[2];
        const kd = 0.3 + 0.8 * lam1;
        r = (a0 * kd + 0.30 * lam2 * 0.5) * ao;
        g = (a1 * kd + 0.40 * lam2 * 0.5) * ao;
        b = (a2 * kd + 0.65 * lam2 * 0.6) * ao;
        r = r * (1 - 0.3 * fog) + 0.04 * fog;
        g = g * (1 - 0.3 * fog) + 0.05 * fog;
        b = b * (1 - 0.3 * fog) + 0.09 * fog;
      }
      const gam = (x) => Math.round(255 * Math.pow(Math.max(0, Math.min(1, x)), 1 / 1.9));
      rgb[idx * 3] = gam(r);
      rgb[idx * 3 + 1] = gam(g);
      rgb[idx * 3 + 2] = gam(b);
    }
  }

  const outDir = join(HERE, '..', 'renders');
  mkdirSync(outDir, { recursive: true });
  const png = encodePNG(rgb, W, H);
  const name = `mandelbox-2p${depthBits}`;
  writeFileSync(join(outDir, `${name}.png`), png);
  const hits = hit.reduce((a, x) => a + x, 0);
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify({
    depthBits, W, H, prec, maxIter, sceneE, standoffE: sE,
    mu, dir: winner.ray, dirDen: 16, tilt: TILT,
    camera: { o: cam.o, fwd, planeScale: cam.planeScale },
    hits, renderSeconds: (Date.now() - tRender) / 1000,
  }, null, 2));
  console.log(`wrote renders/${name}.png (${(png.length / 1024).toFixed(0)}KB), ${hits}/${W * H} hits, total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
