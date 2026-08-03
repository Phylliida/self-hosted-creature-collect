// Test: shiny-store.js decodes shiny-palettes.bin format v3 (shared
// codebook + per-pair u8 indices — build-shiny-codebook.py) while still
// accepting legacy v2 (per-pair triples — shiny-palettes-to-bin.py).
//
// v3 is the append-only master-codebook format: each family pair stores
// 12 indices into a frozen K-entry codebook, so adding new art/species
// never changes an existing pair's shinies.
//
// Run: node tests/shiny-codebook.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'static', 'shiny-store.js'), 'utf8');

// ── Bin fixture builders (mirror the Python encoders) ──────────────
const DL_RANGE = 0.20, KAPPA_MIN = 0.5, KAPPA_SPAN = 1.0;

function encodeTriple(view, off, phi, dl, kp) {
  view.setInt16(off, Math.max(-32767, Math.min(32767,
    Math.round(phi / Math.PI * 32767))), true);
  view.setInt8(off + 2, Math.max(-127, Math.min(127,
    Math.round(dl / DL_RANGE * 127))));
  view.setUint8(off + 3, Math.round(
    (Math.max(KAPPA_MIN, Math.min(1.5, kp)) - KAPPA_MIN) / KAPPA_SPAN * 255));
}

function buildV2(entries) {
  // entries: [{a, b, triples: [[phi,dl,kp]×12]}]
  const buf = Buffer.alloc(16 + entries.length * 52);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  buf.write('SHIN', 0, 'ascii');
  v.setUint32(4, 2, true);
  v.setUint32(8, entries.length, true);
  v.setUint32(12, 0, true);
  let off = 16;
  for (const e of entries) {
    v.setUint16(off, e.a, true);
    v.setUint16(off + 2, e.b, true);
    for (let j = 0; j < 12; j++) {
      encodeTriple(v, off + 4 + j * 4, ...e.triples[j]);
    }
    off += 52;
  }
  return buf;
}

function buildV3(codebook, entries) {
  // codebook: [[phi,dl,kp]×K]; entries: [{a, b, indices: [u8×12]}]
  const K = codebook.length;
  const buf = Buffer.alloc(16 + K * 4 + entries.length * 16);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  buf.write('SHIN', 0, 'ascii');
  v.setUint32(4, 3, true);
  v.setUint32(8, entries.length, true);
  v.setUint32(12, K, true);
  let off = 16;
  for (const t of codebook) {
    encodeTriple(v, off, ...t);
    off += 4;
  }
  for (const e of entries) {
    v.setUint16(off, e.a, true);
    v.setUint16(off + 2, e.b, true);
    for (let j = 0; j < 12; j++) v.setUint8(off + 4 + j, e.indices[j]);
    off += 16;
  }
  return buf;
}

// Fresh ShinyStore per fixture (load() caches internally).
async function loadStore(binBuf) {
  const ctx = {
    console,
    fetch: async () => ({
      ok: true,
      arrayBuffer: async () =>
        binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength),
    }),
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const store = ctx.ShinyStore;
  await store.load();
  return store;
}

function near(a, b, tol, msg) {
  ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ≈${b})`);
}

(async () => {
  // ── v3: codebook + indices decode ──────────────────────────────
  const T0 = [Math.PI / 2, 0.1, 1.25];
  const T1 = [-Math.PI, -0.2, 0.5];
  const store3 = await loadStore(buildV3(
    [T0, T1],
    [{ a: 4, b: 7, indices: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1] }]));
  ok(store3.isReady(), 'v3: ready after load');
  const q = 0.002;  // quantization tolerance (encoding round-trip)
  let t = store3.getTriple(4, 7, 0);
  near(t.phi, T0[0], q, 'v3: slot0 phi from codebook');
  near(t.deltaL, T0[1], q, 'v3: slot0 deltaL from codebook');
  near(t.kappa, T0[2], q, 'v3: slot0 kappa from codebook');
  t = store3.getTriple(4, 7, 1);
  near(t.phi, T1[0], q, 'v3: slot1 phi from codebook');
  near(t.kappa, T1[2], q, 'v3: slot1 kappa from codebook');
  ok(store3.getTriple(4, 7, 12) === null, 'v3: variant 12 out of range');
  ok(store3.getTriple(4, 7, -1) === null, 'v3: variant -1 out of range');
  ok(store3.getTriple(9, 9, 0) === null, 'v3: unknown pair → null');

  // ── v2: legacy format still decodes ────────────────────────────
  const T2 = [-Math.PI / 4, -0.05, 0.9];
  const store2 = await loadStore(buildV2(
    [{ a: 1, b: 2, triples: Array.from({ length: 12 }, () => T2) }]));
  t = store2.getTriple(1, 2, 5);
  near(t.phi, T2[0], q, 'v2: phi decodes');
  near(t.deltaL, T2[1], q, 'v2: deltaL decodes');
  near(t.kappa, T2[2], q, 'v2: kappa decodes');

  // ── v3: out-of-range codebook index is rejected ────────────────
  let threw = false;
  try {
    await loadStore(buildV3(
      [T0],
      [{ a: 1, b: 1, indices: [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }]));
  } catch { threw = true; }
  ok(threw, 'v3: codebook index ≥ K rejects the bin');

  // ── unsupported version rejected ───────────────────────────────
  const bad = buildV2([]);
  new DataView(bad.buffer, bad.byteOffset).setUint32(4, 99, true);
  threw = false;
  try { await loadStore(bad); } catch { threw = true; }
  ok(threw, 'version 99 rejects the bin');

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
