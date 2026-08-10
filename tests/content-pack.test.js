// Guards the creature content pack format (content_pack.py writer ↔
// static/pack-reader.js reader round-trip) and its wiring.
//
//   (1) Round-trip — a fixture pack built in Python is opened in Node:
//       TOC parses, entries slice BYTE-EXACT vs sources, .json()
//       round-trips, .has/.list work, sha256 verification passes,
//       offsets are 8-byte aligned.
//   (2) Rejection — bad magic and truncated files fail loudly.
//   (3) Builder — build-content-pack.py produces the generated
//       artifacts (types/categories/specials) with the right shape
//       (run against a tiny --max-entries pack so the test stays fast).
//   (4) Wiring — script tag, refresh list, run.py, build-capacitor,
//       upload script defaults to TessaCoil/creature-pack.
//
// Run: node tests/content-pack.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
require(path.join(root, 'static', 'pack-reader.js'));
const PackReader = globalThis.PackReader;
ok(!!PackReader, 'PackReader exported under Node');

function py(script) {
  return execFileSync('python3', ['-c', script], { cwd: root, encoding: 'utf8' });
}

// --- 1) writer ↔ reader round-trip ----------------------------------------------
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pack-test-'));
  const files = {
    'types.json': JSON.stringify({ order: ['NORMAL', 'FIRE'], types: { NORMAL: {}, FIRE: {} } }),
    'sprites/4/autogen/4.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]).toString('binary'),
    'sprite-packs/4.pack': 'PACK-PACK-PACK',
    'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    'z-last.bin': '\x00\x01\x02\x03',
  };
  const srcDir = path.join(tmp, 'src');
  for (const [logical, content] of Object.entries(files)) {
    const p = path.join(srcDir, logical);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(content, 'binary'));
  }
  const binPath = path.join(tmp, 'pack.bin');
  const manPath = path.join(tmp, 'pack.json');
  py(
    'import content_pack\n'
    + 'from pathlib import Path\n'
    + 'src = Path(' + JSON.stringify(srcDir) + ')\n'
    + 'entries = [(str(p.relative_to(src)).replace(chr(92), "/"), p) for p in sorted(src.rglob("*")) if p.is_file()]\n'
    + 'content_pack.write_pack(entries, ' + JSON.stringify(binPath) + ', ' + JSON.stringify(manPath) + ')\n'
  );

  const blob = new Blob([fs.readFileSync(binPath)]);
  const reader = await PackReader.open(blob);
  ok(reader.toc.id === 'creature-fusion' && reader.toc.format === 1,
    '1: TOC parses (id + format)');
  ok(reader.list().length === Object.keys(files).length, '1: every file is in the TOC');

  for (const [logical, content] of Object.entries(files)) {
    ok(reader.has(logical), '1: has ' + logical);
    const slice = reader.get(logical);
    const got = Buffer.from(await slice.arrayBuffer());
    const want = Buffer.from(content, 'binary');
    ok(got.equals(want), '1: ' + logical + ' slices byte-exact');
    const e = reader.entries[logical];
    ok(e.offset % 8 === 0, '1: ' + logical + ' offset is 8-byte aligned');
    const v = await reader.getVerified(logical);
    ok(!!v, '1: ' + logical + ' passes sha256 verification');
  }
  const types = await reader.json('types.json');
  ok(types && types.order.join() === 'NORMAL,FIRE', '1: .json() round-trips');
  ok(reader.get('nope.json') === null && (await reader.text('nope.json')) === null,
    '1: missing entry -> null');
  ok(reader.list('sprites/').join() === 'sprites/4/autogen/4.png', '1: list(prefix) filters');

  const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
  ok(man.entryCount === Object.keys(files).length
    && typeof man.sha256 === 'string' && man.sha256.length === 64
    && man.totalBytes === fs.statSync(binPath).size,
    '1: pack.json manifest agrees with the file');

  // --- 2) rejection ------------------------------------------------------------
  let threw = false;
  try { await PackReader.open(new Blob([Buffer.from('not a pack at all.....')])); }
  catch (e) { threw = /magic|small/.test(e.message); }
  ok(threw, '2: bad magic rejected');
  threw = false;
  try { await PackReader.open(new Blob([fs.readFileSync(binPath).subarray(0, 10)])); }
  catch (e) { threw = true; }
  ok(threw, '2: truncated header rejected');

  // --- 3) builder artifacts (tiny pack) ------------------------------------------
  const outDir = path.join(tmp, 'out');
  execFileSync('python3', ['build-content-pack.py', '--out', outDir, '--max-entries', '40'],
    { cwd: root, encoding: 'utf8' });
  const small = await PackReader.open(new Blob([fs.readFileSync(path.join(outDir, 'pack.bin'))]));
  const tj = await small.json('types.json');
  ok(tj && Array.isArray(tj.order) && tj.order.length === 18
    && tj.types.FIRE && tj.types.FIRE.color === '#EE8130'
    && tj.types.ELECTRIC.immune.join() === 'GROUND',
    '3: types.json dumps the canonical registry');
  const cats = await small.json('categories.json');
  ok(cats && Array.isArray(cats.categories) && cats.categories.length > 150,
    '3: categories.json has one category per supported species + specials');
  const bulb = cats.categories.find((c) => c.id === 'species:1');
  const mewtwo = cats.categories.find((c) => c.id === 'species:150');
  const glitch = cats.categories.find((c) => c.id === 'glitch');
  ok(bulb && bulb.name === 'Bulbasaur' && bulb.legendary === false && bulb.evolved === false,
    '3: Bulbasaur category shape');
  ok(mewtwo && mewtwo.legendary === true, '3: legendary flag lands (Mewtwo)');
  ok(glitch && glitch.special === true && cats.soloCategories.missingno.join() === 'glitch',
    '3: glitch category + solo membership');
  const venusaur = cats.categories.find((c) => c.id === 'species:3');
  const bulbaEvolved = cats.categories.find((c) => c.id === 'species:1').evolved;
  ok(venusaur && venusaur.evolved === true && bulbaEvolved === false,
    '3: evolved flags match candy-root semantics (Venusaur yes, Bulbasaur no)');
  const specials = await small.json('specials.json');
  ok(Array.isArray(specials) && specials[0].id === 'missingno',
    '3: specials.json dumps the registry');
  const logo = await small.text('logo.svg');
  ok(logo && logo.includes('<svg'), '3: logo.svg (poke-ball) included');
  ok(small.has('species-types.json') && small.has('shiny-palettes.bin')
    && small.has('eggs.png') && small.has('candies.png'),
    '3: root bundled files present (species types, shiny, eggs, candy)');

  // --- 3b) --native build: full + native variant in one run, shared version --------
  const nativeDir = path.join(tmp, 'native-out');
  execFileSync('python3', ['build-content-pack.py', '--out', nativeDir, '--native', '--max-entries', '40'],
    { cwd: root, encoding: 'utf8' });
  const nativeSmall = await PackReader.open(new Blob([fs.readFileSync(path.join(nativeDir, 'pack-native.bin'))]));
  ok(!nativeSmall.list('sprites/').length,
    '3b: native variant drops sprites/');
  ok(nativeSmall.has('candies.png') && nativeSmall.has('eggs.png'),
    '3b: native variant keeps the root bundled files');
  ok(fs.existsSync(path.join(nativeDir, 'pack-native.json')), '3b: pack-native.json manifest written');
  // The same run also wrote the full pack, with sprites/ intact.
  ok(fs.existsSync(path.join(nativeDir, 'pack.bin')), '3b: full pack.bin written in the same run');
  const fullSmall = await PackReader.open(new Blob([fs.readFileSync(path.join(nativeDir, 'pack.bin'))]));
  ok(fullSmall.list('sprites/').length > 0, '3b: full pack keeps sprites/');
  const fullMan = JSON.parse(fs.readFileSync(path.join(nativeDir, 'pack.json'), 'utf8'));
  const natMan = JSON.parse(fs.readFileSync(path.join(nativeDir, 'pack-native.json'), 'utf8'));
  ok(fullMan.contentVersion === natMan.contentVersion,
    '3b: full + native manifests share contentVersion');

  // --- 3c) filter_pack derivation (native variant from an existing pack) -----------
  // Same content as the source pack minus dropped prefixes, byte-identical
  // entries, source contentVersion preserved (so installed full packs do
  // not read as out-of-date against the variant manifest).
  const derivedDir = path.join(tmp, 'derived-out');
  fs.mkdirSync(derivedDir, { recursive: true });
  execFileSync('python3', ['-c',
    'import content_pack\n'
    + 'content_pack.filter_pack(' + JSON.stringify(path.join(outDir, 'pack.bin')) + ', '
    + JSON.stringify(path.join(derivedDir, 'pack-native.bin')) + ', '
    + JSON.stringify(path.join(derivedDir, 'pack-native.json')) + ',\n'
    + '  drop_prefixes=("sprites/",))\n',
  ], { cwd: root, encoding: 'utf8' });
  const srcManifest = JSON.parse(fs.readFileSync(path.join(outDir, 'pack.json'), 'utf8'));
  const derivedManifest = JSON.parse(fs.readFileSync(path.join(derivedDir, 'pack-native.json'), 'utf8'));
  ok(derivedManifest.contentVersion === srcManifest.contentVersion,
    '3c: derived pack keeps the source contentVersion');
  ok(derivedManifest.file === 'pack-native.bin', '3c: manifest file field names the native bin');
  const derived = await PackReader.open(new Blob([fs.readFileSync(path.join(derivedDir, 'pack-native.bin'))]));
  const srcNames = srcManifest.toc.entries ? Object.keys(srcManifest.toc.entries) : [];
  const dropped = srcNames.filter((n) => n.startsWith('sprites/'));
  const kept = srcNames.filter((n) => !n.startsWith('sprites/'));
  ok(dropped.length > 0 && dropped.every((n) => !derived.has(n)),
    '3c: every sprites/ entry dropped');
  ok(kept.every((n) => derived.has(n)), '3c: every non-sprites entry kept');
  for (const n of kept) {
    const want = srcManifest.toc.entries[n].sha256;
    const gotBuf = Buffer.from(await (await derived.get(n)).arrayBuffer());
    const gotSha = require('crypto').createHash('sha256').update(gotBuf).digest('hex');
    if (gotSha !== want) { ok(false, '3c: entry bytes differ: ' + n); break; }
  }
  ok(true, '3c: kept entries byte-identical (sha256 spot-check)');

  // --- 4) wiring ------------------------------------------------------------------
  const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
  ok(indexSrc.includes('<script src="/static/pack-reader.js"></script>'),
    '4: index.html: pack-reader script tag present');
  ok(indexSrc.includes("'/static/pack-reader.js'"),
    '4: index.html: pack-reader in the refresh cache-delete list');
  const runPy = fs.readFileSync(path.join(root, 'run.py'), 'utf8');
  ok(/_TRACKED_JS = \{[\s\S]*?pack-reader\.js[\s\S]*?\}/.test(runPy)
    && /_SCRIPT_VERSION_FILES = \[[\s\S]*?pack-reader\.js[\s\S]*?\]/.test(runPy),
    '4: run.py: pack-reader tracked');
  const buildCap = fs.readFileSync(path.join(root, 'scripts', 'build-capacitor.sh'), 'utf8');
  ok(buildCap.includes('"pack-reader.js"'), '4: build-capacitor.sh: pack-reader stamped');
  const up = fs.readFileSync(path.join(root, 'scripts', 'upload-content-pack.sh'), 'utf8');
  ok(up.includes('TessaCoil/creature-pack') && up.includes('upload-large-folder'),
    '4: upload script targets TessaCoil/creature-pack via upload-large-folder');

  // Slim bundle: build-capacitor.sh ships ONLY map essentials by
  // default; the full creature tree is behind --full-data.
  const bcs = fs.readFileSync(path.join(root, 'scripts', 'build-capacitor.sh'), 'utf8');
  ok(bcs.includes('--full-data'), '4: build-capacitor.sh has a --full-data escape hatch');
  const fullCopyCount = (bcs.match(/cp -R data\/BundledData\/\. /g) || []).length;
  ok(fullCopyCount === 1 && bcs.includes('if [ "$FULL_DATA" = "1" ]; then'),
    '4: the full BundledData copy exists ONLY inside the --full-data branch');
  for (const keep of ['icons', 'fonts', 'tiles']) {
    ok(new RegExp('BundledData/' + keep).test(bcs),
      '4: slim bundle keeps map essential dir: ' + keep);
  }
  ok(/for f in regions\.json icons-list\.json fonts-list\.json/.test(bcs),
    '4: slim bundle keeps the map manifests (regions/icons-list/fonts-list)');
  for (const drop of ['sprites', 'sprite-packs', 'species-names', 'eggs.png', 'candies.png', 'shiny-palettes']) {
    ok(!new RegExp('cp .*BundledData/' + drop).test(bcs),
      '4: slim bundle does NOT copy creature path: ' + drop);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
