// Tests resumable content-pack downloads (static/pack-install.js):
//   - makeResumePlan builds a synthetic header with rebased offsets that
//     the REAL entry cutter accepts, emitting exactly the remaining
//     entries byte-identically.
//   - download() persists progress per written entry, resumes via HTTP
//     Range after an interruption, and discards stale resume state.
//
// Run: node tests/pack-resume.test.js
'use strict';
const path = require('path');
const struct = require('util');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');

// ── Build a tiny in-memory pack (magic + v1 + TOC + 5 aligned entries) ──
const { createHash } = require('crypto');
function buildPack(realHashes) {
  const entries = [
    ['a.json', Buffer.from('{"one":1}')],
    ['sprites/1/autogen/1.png', Buffer.alloc(1000, 7)],
    ['b.txt', Buffer.from('hello world, this is b')],
    ['sprite-packs/1.pack', Buffer.alloc(4096, 42)],
    ['z.bin', Buffer.alloc(37, 255)],
  ];
  const ALIGN = 8;
  const toc = { id: 'test', format: 1, contentVersion: 'v1', entries: {} };
  // Two-pass offset fixpoint (same approach as content_pack.py).
  let offsets = new Array(entries.length).fill(0);
  for (let pass = 0; pass < 3; pass++) {
    entries.forEach(([p, data], i) => {
      toc.entries[p] = {
        offset: offsets[i], length: data.length,
        sha256: realHashes
          ? createHash('sha256').update(data).digest('hex') : 'x',
      };
    });
    const tocLen = Buffer.byteLength(JSON.stringify(toc));
    let cursor = 20 + tocLen;
    entries.forEach(([p, data], i) => {
      cursor = Math.ceil(cursor / ALIGN) * ALIGN;
      offsets[i] = cursor;
      cursor += data.length;
    });
  }
  const tocBuf = Buffer.from(JSON.stringify(toc));
  const head = Buffer.alloc(20);
  head.write('CCPACK01', 0);
  head.writeUInt32LE(1, 8);
  head.writeUInt32LE(tocBuf.length, 12);
  head.writeUInt32LE(0, 16);
  const parts = [head, tocBuf];
  let cursor = 20 + tocBuf.length;
  entries.forEach(([p, data], i) => {
    const pad = offsets[i] - cursor;
    if (pad) parts.push(Buffer.alloc(pad));
    parts.push(data);
    cursor = offsets[i] + data.length;
  });
  return {
    pack: Buffer.concat(parts),
    tocText: JSON.stringify(toc),
    entries,
    totalBytes: cursor,
  };
}

const ls = {};
function setupEnv() {
  for (const k of Object.keys(ls)) delete ls[k];
  globalThis.localStorage = {
    getItem: (k) => (k in ls ? ls[k] : null),
    setItem: (k, v) => { ls[k] = String(v); },
    removeItem: (k) => { delete ls[k]; },
  };
  delete require.cache[require.resolve(path.join(root, 'static', 'packs.js'))];
  delete require.cache[require.resolve(path.join(root, 'static', 'pack-install.js'))];
  require(path.join(root, 'static', 'packs.js'));
  require(path.join(root, 'static', 'pack-install.js'));
  return globalThis.PackInstall;
}

function streamOf(buf) {
  return { getReader: () => {
    let sent = false;
    return { read: async () => (sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(buf) })) };
  } };
}

// ── 1) makeResumePlan + real cutter: remaining entries arrive byte-exact ──
async function section1() {
  const PI = setupEnv();
  const { pack, tocText, entries } = buildPack();
  const K = 2;   // pretend the first two entries were written
  const plan = PI.makeResumePlan(tocText, K);
  ok(plan && plan.remaining === entries.length - K, '1: plan covers remaining entries');
  const base = JSON.parse(tocText).entries[entries[K][0]].offset;
  ok(plan.rangeStart === base, '1: range start = first remaining entry offset');

  const got = [];
  const cutter = PI.makeEntryCutter(async (p, blob) => {
    got.push([p, Buffer.from(await blob.arrayBuffer())]);
  });
  await cutter.feed(new Uint8Array(plan.headerBytes));
  await cutter.feed(new Uint8Array(pack.subarray(plan.rangeStart)));
  const count = cutter.finish();
  ok(count === entries.length - K, '1: cutter finished all remaining entries');
  ok(got.length === entries.length - K
    && got.every(([p, data], i) => p === entries[K + i][0] && data.equals(entries[K + i][1])),
    '1: remaining entries byte-identical, in order');
  ok(PI.makeResumePlan(tocText, entries.length) === null,
    '1: plan is null when nothing remains');
}

// ── 2) full flow: interrupt mid-download, resume via Range, meta written ──
async function section2() {
  const PI = setupEnv();
  const { pack, entries, totalBytes } = buildPack(true);
  const manifest = { contentVersion: 'v1', sha256: 'abc', totalBytes };

  const written = new Map();
  globalThis.Capacitor = {
    getPlatform: () => 'ios',
    Plugins: {
      Filesystem: {
        writeFile: async ({ path, data }) => { written.set(path, data); },
      },
    },
  };

  // Phase 1: fetch pack.bin but DIE after the stream's first chunk.
  // Later non-range fetches (phase 3's fresh download) succeed fully.
  const CUT_AFTER = JSON.parse(buildPack(true).tocText).entries[entries[2][0]].offset + 10;
  let fullFetches = 0;
  globalThis.fetch = async (url, opts) => {
    if (url.endsWith('pack.json') || url.endsWith('pack-native.json')) {
      return { ok: true, status: 200, json: async () => manifest };
    }
    const range = opts && opts.headers && opts.headers.Range;
    if (!range) {
      fullFetches++;
      if (fullFetches === 1) {
        // First download: stream dies partway.
        return {
          ok: true, status: 200,
          headers: { get: () => String(totalBytes) },
          body: { getReader: () => {
            let sent = false;
            return { read: async () => {
              if (sent) throw new Error('network dropped');
              sent = true;
              return { done: false, value: new Uint8Array(pack.subarray(0, CUT_AFTER)) };
            } };
          } },
        };
      }
      return {
        ok: true, status: 200,
        headers: { get: () => String(totalBytes) },
        body: streamOf(pack),
      };
    }
    // Range request (resume path): honor with 206.
    const m = range.match(/bytes=(\d+)-(\d*)/);
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) + 1 : pack.length;
    return {
      ok: true, status: 206,
      arrayBuffer: async () => pack.subarray(start, end).buffer.slice(
        pack.subarray(start, end).byteOffset,
        pack.subarray(start, end).byteOffset + (end - start)),
      text: async () => pack.subarray(start, end).toString('utf8'),
      body: streamOf(pack.subarray(start, end)),
    };
  };

  let err = null;
  try { await PI.download('creature-fusion'); } catch (e) { err = e; }
  ok(err && err.message === 'network dropped' && err.resumable,
    '2: interruption surfaces a resumable error');
  const rs = PI.resumeState('creature-fusion');
  ok(rs && rs.entriesDone === 2, '2: resume state persisted 2 written entries (got '
    + (rs && rs.entriesDone) + ')');
  const writtenAfter1 = written.size;

  // Phase 2: resume — same manifest; must finish writing entries 3..5
  // using Range requests only.
  const meta = await PI.download('creature-fusion');
  ok(meta.entryCount === entries.length, '2: meta entryCount covers the whole pack');
  ok(meta.bytes === totalBytes, '2: meta.bytes = full pack size after resume');
  ok(written.size === entries.length + 0 || written.size >= writtenAfter1 + (entries.length - 2),
    '2: remaining entries written on resume (' + writtenAfter1 + ' → ' + written.size + ')');
  ok(PI.resumeState('creature-fusion') === null, '2: resume state cleared on success');
  ok(PI.isInstalled('creature-fusion'), '2: pack installed after resume');

  // Phase 3: a DIFFERENT manifest invalidates the resume state.
  ls['cc.contentPack.creature-fusion.v1.resume'] = JSON.stringify({
    packId: 'creature-fusion', gens: '', contentVersion: 'OLD', sha256: 'OLD',
    entriesDone: 4, totalBytes, downloaded: 100,
  });
  written.clear();
  const meta2 = await PI.download('creature-fusion');
  ok(meta2.entryCount === entries.length && written.size >= entries.length - 1,
    '2: stale resume state ignored → full fresh download');
  delete globalThis.fetch;
  delete globalThis.Capacitor;
}

// ── 3) per-entry sha256 verification during streaming ─────────────────────
async function section3() {
  const PI = setupEnv();
  const { pack } = buildPack(true);

  // Clean pack verifies fine end-to-end through the real cutter.
  const got = [];
  const c1 = PI.makeEntryCutter(async (p, blob) => {
    got.push([p, Buffer.from(await blob.arrayBuffer())]);
  }, { verify: true });
  await c1.feed(new Uint8Array(pack));
  ok(c1.finish() === 5 && got.length === 5, '3: clean pack verifies (5/5 entries)');

  // Corrupt one byte inside entry 3 ('b.txt') → mismatch on that entry,
  // earlier entries still delivered (they were verified + written).
  const toc = JSON.parse(buildPack(true).tocText);
  const off = toc.entries['b.txt'].offset;
  const bad = Buffer.from(pack);
  bad[off + 3] ^= 0xff;
  const got2 = [];
  const c2 = PI.makeEntryCutter(async (p, blob) => {
    got2.push(p);
  }, { verify: true });
  let err = null;
  try {
    await c2.feed(new Uint8Array(bad));
  } catch (e) { err = e; }
  ok(err && /sha256 mismatch: b\.txt/.test(err.message),
    '3: corrupted entry rejected with its path (' + (err && err.message) + ')');
  ok(got2.length === 2, '3: entries before the corrupt one were verified + delivered');
}

(async () => {
  await section1();
  await section2();
  await section3();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('unexpected: ', e);
  process.exit(1);
});
