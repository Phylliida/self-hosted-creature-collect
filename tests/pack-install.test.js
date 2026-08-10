// Guards the creature-pack client flow (static/pack-install.js) and
// its native serving overlay (ios-overrides/LocalServer.swift).
//
//   (1) sourceForMode — the Region-data-source dropdown mapping:
//       static-hf → the exact Hugging Face URLs; flask modes → the
//       local /content-pack route (CC_API_BASE on Capacitor).
//   (2) makeEntryCutter — the streaming extractor: feed a real
//       python-built pack in small odd-sized chunks, entries come out
//       byte-exact, in file order; truncation + bad magic rejected.
//   (3) checkForUpdate — none / available / up-to-date logic.
//   (4) Native overlay + no-SW-machinery — LocalServer serves
//       /bundled-data/* from Library/CCContentPack; sw.js stays OUT of
//       the pack business (the "stick the data where it was" rule).
//   (5) Wiring — script tags, refresh list, run.py (route + tracked),
//       build-capacitor, settings ids.
//
// Run: node tests/pack-install.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
require(path.join(root, 'static', 'pack-install.js'));
const PI = globalThis.PackInstall;
ok(!!PI, 'PackInstall exported under Node');

// --- 1) sourceForMode ------------------------------------------------------------
{
  const hf = PI.sourceForMode('static-hf', 'https://poke.example.org');
  ok(hf.source === 'hf'
    && hf.packBinUrl === 'https://huggingface.co/datasets/TessaCoil/creature-pack/resolve/main/pack.bin'
    && hf.packJsonUrl === 'https://huggingface.co/datasets/TessaCoil/creature-pack/resolve/main/pack.json',
    '1: static-hf → the creature-pack dataset URLs');
  for (const m of ['bbox-flask', 'static-flask']) {
    const local = PI.sourceForMode(m, 'https://poke.example.org');
    ok(local.source === 'local'
      && local.packBinUrl === 'https://poke.example.org/pack-files/creature-fusion/pack.bin',
      '1: ' + m + ' → server /pack-files/<id> route (CC_API_BASE)');
  }
  const web = PI.sourceForMode('bbox-flask', '');
  ok(web.packBinUrl === '/pack-files/creature-fusion/pack.bin', '1: empty apiBase → same-origin relative');

  // Native variant URLs append `-native` to pack filenames.
  const hfNative = PI.sourceForMode('static-hf', 'https://poke.example.org', null, null, true);
  ok(hfNative.packBinUrl.endsWith('/pack-native.bin')
    && hfNative.packJsonUrl.endsWith('/pack-native.json'),
    '1: static-hf native → pack-native.* URLs');
  const localNative = PI.sourceForMode('bbox-flask', 'https://poke.example.org', null, null, true);
  ok(localNative.packBinUrl === 'https://poke.example.org/pack-files/creature-fusion/pack-native.bin',
    '1: local native → /pack-files/creature-fusion/pack-native.bin');
}

// --- 2) streaming entry cutter ------------------------------------------------------
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-packinst-'));
  const files = {
    'a.json': '{"hello":"world"}',
    'b/pic.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]).toString('binary'),
    'c/big.pack': 'x'.repeat(5000),
  };
  const srcDir = path.join(tmp, 'src');
  for (const [logical, content] of Object.entries(files)) {
    const p = path.join(srcDir, logical);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(content, 'binary'));
  }
  const binPath = path.join(tmp, 'pack.bin');
  execFileSync('python3', ['-c',
    'import content_pack\n'
    + 'from pathlib import Path\n'
    + 'src = Path(' + JSON.stringify(srcDir) + ')\n'
    + 'entries = [(str(p.relative_to(src)).replace(chr(92), "/"), p) for p in sorted(src.rglob("*")) if p.is_file()]\n'
    + 'content_pack.write_pack(entries, ' + JSON.stringify(binPath) + ', ' + JSON.stringify(path.join(tmp, 'pack.json')) + ')\n',
  ], { cwd: root });

  const packBytes = fs.readFileSync(binPath);
  const got = [];
  const cutter = PI.makeEntryCutter(async (logical, blob) => {
    got.push([logical, Buffer.from(await blob.arrayBuffer())]);
  });
  // Feed in odd-sized chunks (1, 7, 64, 1000, rest) to stress reassembly.
  let pos = 0;
  for (const step of [1, 7, 64, 1000, 13, 4096]) {
    if (pos >= packBytes.length) break;
    const end = Math.min(pos + step, packBytes.length);
    await cutter.feed(packBytes.subarray(pos, end));
    pos = end;
  }
  if (pos < packBytes.length) await cutter.feed(packBytes.subarray(pos));
  const count = cutter.finish();
  ok(count === Object.keys(files).length, '2: finish() reports every entry');
  ok(got.length === Object.keys(files).length, '2: every entry emitted');
  // File order = sorted-by-offset = sorted-by-path here.
  const wantOrder = Object.keys(files).sort();
  ok(JSON.stringify(got.map((g) => g[0])) === JSON.stringify(wantOrder),
    '2: entries emitted in file order');
  for (const [logical, buf] of got) {
    ok(buf.equals(Buffer.from(files[logical], 'binary')), '2: ' + logical + ' byte-exact');
  }

  // Bad magic
  {
    const c2 = PI.makeEntryCutter(async () => {});
    let threw = false;
    try { await c2.feed(Buffer.from('definitely not a pack........')); }
    catch (e) { threw = /magic/.test(e.message); }
    ok(threw, '2: bad magic rejected');
  }
  // Truncated stream
  {
    const c3 = PI.makeEntryCutter(async () => {});
    let threw = false;
    try {
      await c3.feed(packBytes.subarray(0, Math.floor(packBytes.length / 2)));
      c3.finish();
    } catch (e) { threw = /truncated/.test(e.message); }
    ok(threw, '2: truncation rejected at finish()');
  }

  // --- 3) checkForUpdate ---------------------------------------------------------
  {
    const manifest = { contentVersion: 'v1', sha256: 'abc' };
    const lsStore = {};
    globalThis.localStorage = {
      getItem: (k) => (k in lsStore ? lsStore[k] : null),
      setItem: (k, v) => { lsStore[k] = String(v); },
      removeItem: (k) => { delete lsStore[k]; },
    };
    globalThis.fetch = async () => ({ ok: true, json: async () => manifest });
    globalThis.CC_API_BASE = 'https://poke.example.org';
    lsStore['cc.regionsMode'] = 'static-hf';

    let r = await PI.checkForUpdate();
    ok(r.state === 'none' && r.source.source === 'hf', '3: nothing installed → none');

    PI.readMeta && (lsStore[PI.META_KEY] = JSON.stringify(
      { contentVersion: 'v0', sha256: 'old', installedAt: 1 }));
    r = await PI.checkForUpdate();
    ok(r.state === 'available', '3: older version → update available');

    lsStore[PI.metaKey('creature-fusion')] = JSON.stringify(
      { contentVersion: 'v1', sha256: 'abc', installedAt: 2 });
    r = await PI.checkForUpdate();
    ok(r.state === 'up-to-date', '3: same version+hash → up-to-date');

    globalThis.fetch = async () => { throw new Error('offline'); };
    r = await PI.checkForUpdate();
    ok(r.state === 'unknown', '3: offline → unknown');
    delete globalThis.localStorage;
    delete globalThis.fetch;
    delete globalThis.CC_API_BASE;
  }

  // --- 3b) checkForUpdate: native-variant rollout fallback -------------------------
  // A client holding the FULL pack (installed before pack-native.* existed)
  // must report up-to-date when the native manifest differs but the full
  // manifest still matches the install — same content, bigger transport.
  {
    const lsStore = {};
    globalThis.localStorage = {
      getItem: (k) => (k in lsStore ? lsStore[k] : null),
      setItem: (k, v) => { lsStore[k] = String(v); },
      removeItem: (k) => { delete lsStore[k]; },
    };
    globalThis.CC_API_BASE = 'https://poke.example.org';
    globalThis.Capacitor = { getPlatform: () => 'ios' };
    lsStore['cc.regionsMode'] = 'static-hf';
    const nativeManifest = { contentVersion: 'v1', sha256: 'nativesha' };
    const fullManifest = { contentVersion: 'v1', sha256: 'fullsha' };
    globalThis.fetch = async (url) => {
      if (url.endsWith('pack-native.json')) {
        return { ok: true, json: async () => nativeManifest };
      }
      if (url.endsWith('pack.json')) {
        return { ok: true, json: async () => fullManifest };
      }
      return { ok: false, status: 404 };
    };
    lsStore[PI.metaKey('creature-fusion')] = JSON.stringify(
      { contentVersion: 'v1', sha256: 'fullsha', installedAt: 2 });

    let r = await PI.checkForUpdate();
    ok(r.state === 'up-to-date',
      '3b: native manifest differs, full matches install → up-to-date (got ' + r.state + ')');

    // Installed the NATIVE variant → matches the native manifest directly.
    lsStore[PI.metaKey('creature-fusion')] = JSON.stringify(
      { contentVersion: 'v1', sha256: 'nativesha', installedAt: 3 });
    r = await PI.checkForUpdate();
    ok(r.state === 'up-to-date', '3b: native install matches native manifest → up-to-date');

    // Content actually changed (both manifests bumped) → update flagged.
    nativeManifest.contentVersion = 'v2'; nativeManifest.sha256 = 'nativesha2';
    fullManifest.contentVersion = 'v2'; fullManifest.sha256 = 'fullsha2';
    r = await PI.checkForUpdate();
    ok(r.state === 'available', '3b: real content change → update available');

    // Server has no native variant (404) → falls back to full manifest.
    lsStore[PI.metaKey('creature-fusion')] = JSON.stringify(
      { contentVersion: 'v2', sha256: 'fullsha2', installedAt: 4 });
    globalThis.fetch = async (url) => {
      if (url.endsWith('pack-native.json')) return { ok: false, status: 404 };
      if (url.endsWith('pack.json')) {
        return { ok: true, json: async () => ({ contentVersion: 'v2', sha256: 'fullsha2' }) };
      }
      return { ok: false, status: 404 };
    };
    r = await PI.checkForUpdate();
    ok(r.state === 'up-to-date', '3b: no native variant on server → full manifest decides');
    delete globalThis.localStorage;
    delete globalThis.fetch;
    delete globalThis.CC_API_BASE;
    delete globalThis.Capacitor;
  }

  // --- 4) native overlay + no-SW-machinery -----------------------------------------
  {
    const swift = fs.readFileSync(path.join(root, 'ios-overrides', 'LocalServer.swift'), 'utf8');
    ok(swift.includes('CCContentPack') && swift.includes('contentPackDir'),
      '4: LocalServer resolves the content-pack directory');
    ok(swift.includes('path.hasPrefix("/bundled-data/")'),
      '4: LocalServer overlays /bundled-data/* from the pack');
    const sw = fs.readFileSync(path.join(root, 'static', 'sw.js'), 'utf8');
    ok(!sw.includes('cc-content-pack') && !sw.includes("importScripts('/static/pack-reader.js')"),
      '4: sw.js stays OUT of the pack business (data goes where it already lived)');
    const iosYml = fs.readFileSync(path.join(root, '.github', 'workflows', 'ios-build.yml'), 'utf8');
    ok(iosYml.includes('cp ios-overrides/LocalServer.swift'),
      '4: ios-build.yml still copies LocalServer.swift (overlay ships)');
  }

  // --- 5) wiring --------------------------------------------------------------------
  {
    const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
    ok(indexSrc.includes('<script src="/static/pack-install.js"></script>')
      && indexSrc.indexOf('<script src="/static/pack-reader.js"></script>')
         < indexSrc.indexOf('<script src="/static/pack-install.js"></script>'),
      '5: pack-install loads after pack-reader');
    ok(indexSrc.includes("'/static/pack-install.js'"),
      '5: pack-install in the refresh cache-delete list');
    ok(indexSrc.includes('id="creaturePackBtn"') && indexSrc.includes('id="creaturePackStatus"')
      && indexSrc.includes('id="creaturePackDeleteBtn"'),
      '5: settings row present (button, status, remove)');
    ok(indexSrc.includes('regionsModeSelect')
      && indexSrc.includes("addEventListener('change', _refreshCreaturePackRow)"),
      '5: row re-checks when the source dropdown flips');
    const runPy = fs.readFileSync(path.join(root, 'run.py'), 'utf8');
    ok(/@app\.route\("\/content-pack\/<path:fname>"\)/.test(runPy),
      '5: run.py: /content-pack route exists');
    ok(/_TRACKED_JS = \{[\s\S]*?pack-install\.js[\s\S]*?\}/.test(runPy)
      && /_SCRIPT_VERSION_FILES = \[[\s\S]*?pack-install\.js[\s\S]*?\]/.test(runPy),
      '5: run.py: pack-install tracked');
    const buildCap = fs.readFileSync(path.join(root, 'scripts', 'build-capacitor.sh'), 'utf8');
    ok(buildCap.includes('"pack-install.js"'), '5: build-capacitor.sh: pack-install stamped');
    ok(PI.SKIP_PREFIXES.includes('sprites/'),
      '5: sprite sheets skipped on native (packs are the cell source)');
  }

  // --- 7) per-pack skip rule: sprites/ skipped ONLY for creature-fusion ---------
  {
    const writes = [];
    globalThis.Capacitor = {
      getPlatform: () => 'ios',
      Plugins: {
        Filesystem: {
          writeFile: async (args) => { writes.push(args.path); },
        },
      },
    };
    const neoSink = PI.makeEntrySink('neopets');
    await neoSink('sprites/acar_yellow_m.png', new Blob(['x']));
    ok(writes.length === 1 && writes[0].includes('neopets/sprites/acar_yellow_m.png'),
      '7: neopets keeps its sprites/ art (the missing-icons regression)');
    const fusionSink = PI.makeEntrySink('creature-fusion');
    await fusionSink('sprites/1/autogen/1.png', new Blob(['x']));
    ok(writes.length === 1, '7: creature-fusion still skips sheets');
    await fusionSink('sprite-packs/1.pack', new Blob(['x']));
    ok(writes.length === 2 && writes[1].includes('creature-fusion/sprite-packs/1.pack'),
      '7: creature-fusion keeps sprite-packs');
    delete globalThis.Capacitor;
  }

  // --- 6) zero-network rule + first-load prompt ---------------------------------------
  {
    const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
    // The settings row label must be local-only: _refreshCreaturePackRow
    // performs NO update probe (checkForUpdate fetches pack.json).
    const fnStart = indexSrc.indexOf('async function _refreshCreaturePackRow');
    const fnEnd = indexSrc.indexOf('creaturePackBtn.onclick', fnStart);
    const fnBody = indexSrc.slice(fnStart, fnEnd);
    ok(fnStart > 0 && !fnBody.includes('checkForUpdate'),
      '6: settings row label is local-only (no probe on open/dropdown-flip)');
    // The probe happens inside the button handler instead.
    ok(indexSrc.includes("creaturePackStatus.textContent = 'checking for updates…';"),
      '6: update check runs on tap (user-initiated)');
    // First-load prompt card exists, gated on Capacitor + not-installed,
    // and its own show path performs no fetch before the tap.
    ok(indexSrc.includes('id="packWelcome"') && indexSrc.includes('id="packWelcomeStart"'),
      '6: first-load prompt card present');
    ok(/window\.Capacitor && window\.PackInstall\s*&& !window\.PackInstall\.isInstalled\(\)/.test(indexSrc),
      '6: prompt gated on mobile + pack-not-installed');
    {
      const pStart = indexSrc.indexOf('packWelcomeStart.onclick');
      const pEnd = indexSrc.indexOf('packWelcomeLater.onclick');
      ok(pStart > 0 && indexSrc.slice(pStart, pEnd).includes('PackInstall.download'),
        '6: prompt download starts only from the tap');
    }
    // pack-install: web platform is refused outright.
    const piSrc = fs.readFileSync(path.join(root, 'static', 'pack-install.js'), 'utf8');
    ok(/mobile \(Capacitor\) flow/.test(piSrc), '6: web platform refused in download()');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
