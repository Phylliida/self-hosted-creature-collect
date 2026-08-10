// Guards the IF2 generation-subset pack feature: subset enumeration,
// gen→PIF-id pool computation, IF2 dat decryption, slicer primitives,
// variant download URLs, gen-toggle UI wiring, and the pack-driven
// species pool.
//
// Run: node tests/if2-packs.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');

function py(code) {
  return execFileSync('python3', ['-c', code], { cwd: root, encoding: 'utf8' });
}

// --- 1) subset enumeration (31 gen combos × 2 family flags = 62) -----------------
{
  const out = execFileSync('python3', ['build-if2-packs.py', '--list-subsets'],
    { cwd: root, encoding: 'utf8' });
  const keys = JSON.parse(out);
  ok(keys.length === 62, `1: 62 variants (got ${keys.length})`);
  ok(keys.includes('gen-1') && keys.includes('gen-1-2-3-4-5') && keys.includes('gen-2-4'),
    '1: singles, full union, and sparse combos present');
  ok(keys.includes('gen-1-fam') && keys.includes('gen-1-2-3-4-5-fam')
    && keys.includes('gen-2-4-fam'), '1: family variants present');
  ok(new Set(keys).size === keys.length, '1: subset keys unique');
}

// --- 2) gen→PIF-id pool computation --------------------------------------------
{
  const splitnames = 'data/InfiniteFusion2/Data/Scripts/052_InfiniteFusion/Fusion/Data/SplitNames.rb';
  const hasIf2 = fs.existsSync(path.join(root, splitnames));
  if (hasIf2) {
    const env = `CC_SPLITNAMES_RB=${splitnames}`;
    const g1 = JSON.parse(execFileSync('python3', ['-c',
      'import species_pool as sp, json; print(json.dumps(sp.ALLOWED_SPECIES))'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, CC_SPECIES_GENS: '1', CC_SPLITNAMES_RB: splitnames } }));
    ok(g1.length === 151 && g1[0] === 1 && g1[150] === 151, '2: gen 1 = PIF 1..151');
    const g5 = JSON.parse(execFileSync('python3', ['-c',
      'import species_pool as sp, json; print(json.dumps(sorted(sp.ALLOWED_SET)))'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, CC_SPECIES_GENS: '5', CC_SPLITNAMES_RB: splitnames } }));
    ok([566, 567, 568, 569, 570].every((i) => g5.includes(i)),
      '2: gen 5 includes IF2-only PIF ids 566-570 (Woobat/Tynamo lines)');
    ok(!g5.includes(571) && !g5.includes(572), '2: gen-6 ids 571/572 excluded from gen 5');
    const union = JSON.parse(execFileSync('python3', ['-c',
      'import species_pool as sp, json; print(json.dumps([len(sp.ALLOWED_SPECIES), sp.MAX_SPECIES, sorted(sp.LEGENDARY_SPECIES)]))'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, CC_SPECIES_GENS: '1,2,3,4,5,6,7', CC_SPLITNAMES_RB: splitnames } }));
    ok(union[0] === 572 && union[1] === 572, `2: full roster = 572 species, max 572 (got ${union[0]}/${union[1]})`);
    ok(union[2].length === 42, `2: full-roster legendaries = 42 (got ${union[2].length})`);
    ok(JSON.parse(execFileSync('python3', ['-c',
      'import species_pool as sp, json; print(json.dumps(339 in sp.ALLOWED_SET))'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, CC_SPECIES_GENS: '1,2,3,4,5,6,7', CC_SPLITNAMES_RB: splitnames } })) === true,
      '2: Sylveon (PIF 339, gen 6) in full roster for family closures');
    void env;
  } else {
    ok(true, '2: (skipped — data/InfiniteFusion2 not present)');
  }
}

// --- 3) IF2 dat decryption ------------------------------------------------------
{
  const dat = path.join(root, 'data', 'InfiniteFusion2', 'Data', 'species.dat');
  if (fs.existsSync(dat)) {
    const out = execFileSync('ruby', ['extract-pif-dat.rb', dat],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const d = JSON.parse(out);
    ok(d['566'] && d['566'].real_name === 'Woobat'
      && d['566'].type1 === 'PSYCHIC' && d['566'].type2 === 'FLYING',
      '3: encrypted species.dat decrypts (Woobat at 566)');
    // Plain (IF1) dat still decodes via the magic-bytes passthrough.
    const if1 = path.join(root, 'data', 'InfiniteFusion', 'Data', 'species.dat');
    if (fs.existsSync(if1)) {
      const out1 = execFileSync('ruby', ['extract-pif-dat.rb', if1],
        { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      ok(JSON.parse(out1)['1'].real_name === 'Bulbasaur', '3: plain IF1 dat still decodes');
    }
  } else {
    ok(true, '3: (skipped — data/InfiniteFusion2 not present)');
  }
}

// --- 4) slicer primitives (CRPP filter, SHIN filter, sheet blanking) ------------
{
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'if2-slice-'));
  const script = `
import json, struct, sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(root)})
import importlib.util
spec = importlib.util.spec_from_file_location('drv', ${JSON.stringify(path.join(root, 'build-if2-packs.py'))})
drv = importlib.util.module_from_spec(spec); spec.loader.exec_module(drv)
from PIL import Image

tmp = Path(${JSON.stringify(tmp)}); keep = frozenset({1, 3})

# CRPP: 3 entries (a=1,2,3) -> keep a in {1,3}
payloads = [b'PNG1png1', b'PNG2png2longer', b'PNG3']
entries = [(1, -1, payloads[0]), (2, 0, payloads[1]), (3, 2, payloads[2])]
buf = bytearray(b'CRPP'); buf += struct.pack('<I', len(entries))
off = 0; idx = bytearray(); blob = bytearray()
for a, v, p in entries:
    idx += struct.pack('<IiII', a, v, off, len(p)); blob += p; off += len(p)
(tmp / 'in.pack').write_bytes(bytes(buf + idx + blob))
assert drv.slice_sprite_pack(tmp / 'in.pack', tmp / 'out.pack', keep)
out = (tmp / 'out.pack').read_bytes()
assert out[:4] == b'CRPP'
(n,) = struct.unpack_from('<I', out, 4); assert n == 2, n
a0, v0, o0, l0 = struct.unpack_from('<IiII', out, 8)
a1, v1, o1, l1 = struct.unpack_from('<IiII', out, 24)
payload = out[8 + 2*16:]
assert (a0, v0, payload[o0:o0+l0]) == (1, -1, payloads[0])
assert (a1, v1, payload[o1:o1+l1]) == (3, 2, payloads[2])
assert not drv.slice_sprite_pack(tmp / 'in.pack', tmp / 'none.pack', frozenset({9}))

# SHIN: 2 entries (1,3) and (1,9) -> rekey maps union roots to pack-local
# roots; unmapped families are dropped
e = struct.pack('<HH', 1, 3) + b'\\x00' * 48
f = struct.pack('<HH', 1, 9) + b'\\x11' * 48
(tmp / 'in.bin').write_bytes(b'SHIN' + struct.pack('<III', 2, 2, 0) + e + f)
drv.slice_shin(tmp / 'in.bin', tmp / 'out.bin', {1: [1], 3: [3]})
ob = (tmp / 'out.bin').read_bytes()
assert ob[:4] == b'SHIN'
ver, cnt, _ = struct.unpack_from('<III', ob, 4)
assert cnt == 1 and ob[16:] == e, (cnt, len(ob))

# SHIN re-key: union root 9 resolves to pack-local 113 (baby-family case)
drv.slice_shin(tmp / 'in.bin', tmp / 'out-rk.bin', {1: [1], 3: [3], 9: [113]})
obrk = (tmp / 'out-rk.bin').read_bytes()
ver, cnt, _ = struct.unpack_from('<III', obrk, 4)
ra, rb = struct.unpack_from('<HH', obrk, 16 + 52)  # second entry
assert cnt == 2 and (ra, rb) == (1, 113), (cnt, ra, rb)
assert obrk[16 + 52 + 4:16 + 104] == b'\\x11' * 48  # payload carried over

# SHIN v3: shared codebook (K=2) + 16B u8-index entries — the codebook
# must be copied verbatim and only entries filtered
cb = bytes(range(8))
e3 = struct.pack('<HH', 1, 3) + bytes(range(12))
f3 = struct.pack('<HH', 1, 9) + bytes(range(12, 24))
(tmp / 'in3.bin').write_bytes(b'SHIN' + struct.pack('<III', 3, 2, 2) + cb + e3 + f3)
drv.slice_shin(tmp / 'in3.bin', tmp / 'out3.bin', {1: [1], 3: [3]})
ob3 = (tmp / 'out3.bin').read_bytes()
assert ob3[:4] == b'SHIN'
ver3, cnt3, k3 = struct.unpack_from('<III', ob3, 4)
assert (ver3, cnt3, k3) == (3, 1, 2), (ver3, cnt3, k3)
assert ob3[16:24] == cb and ob3[24:] == e3, (len(ob3),)

# shin_rekey_map: pack-local resolution — union root for Pichu's family is
# 25 (Pikachu); a pack holding only the baby resolves it to 172 instead
pevos = {}                            # pack-local: Pichu's evo link was sliced away
ufwd = {172: [25], 25: [26]}          # union: Pichu -> Pikachu -> Raichu
rk = drv.shin_rekey_map(frozenset({172}), pevos, {172}, ufwd, {172})
assert rk == {25: [172]}, rk
rk2 = drv.shin_rekey_map(frozenset({25, 26}), {'25': [[26, 'Level', 1]]}, set(), ufwd, {172})
assert rk2 == {25: [25]}, rk2

# Sheet blanking: 10-col sheet, 2 rows; body 1 kept, body 2 blanked
img = Image.new('RGBA', (960, 192), (0, 0, 0, 0))
for b in (1, 2):
    for x in range(96):
        for y in range(96):
            img.putpixel(((b % 10) * 96 + x, (b // 10) * 96 + y), (255, 0, 0, 255))
img.save(tmp / 'sheet.png')
drv.blank_and_crop_sheet(tmp / 'sheet.png', tmp / 'sheet-out.png', 10, 1, keep)
res = Image.open(tmp / 'sheet-out.png')
assert res.height == 96, res.size
assert res.getpixel((96 + 48, 48)) == (255, 0, 0, 255)   # body 1 kept
assert res.getpixel((2 * 96 + 48, 48)) == (0, 0, 0, 0)     # body 2 blanked

# family_closure: undirected closure over evolution families
evos = {'25': [[26, 'Level', 1]], '172': [[25, 'Level', 1]],
        '133': [[271, 'Item', 'X']], '571': [[572, 'Level', 48]]}
assert drv.family_closure({25}, evos) == {25, 26, 172}, drv.family_closure({25}, evos)
assert drv.family_closure({133}, evos) == {133, 271}
assert drv.family_closure({25}, evos) - {25, 26, 172} == set()  # no bleed into other families
assert drv.family_closure({572}, evos) == {571, 572}            # reverse direction closes too
print('ok')
`;
  try {
    py(script);
    ok(true, '4: slicer primitives (CRPP/SHIN/sheet blanking)');
  } catch (e) {
    ok(false, '4: slicer primitives: ' + e.message);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- 5) variant pack registry + download URLs ----------------------------------
function section5() {
  const ls = {};
  globalThis.localStorage = {
    getItem: (k) => (k in ls ? ls[k] : null),
    setItem: (k, v) => { ls[k] = String(v); },
    removeItem: (k) => { delete ls[k]; },
  };
  require(path.join(root, 'static', 'packs.js'));
  require(path.join(root, 'static', 'pack-install.js'));
  const P = globalThis.Packs, PI = globalThis.PackInstall;

  const def = P.get('creature-if2');
  ok(def && def.hfRepo === 'TessaCoil/creature-pack-if2' && def.solo === false
    && def.genRange && def.genRange[0] === 1 && def.genRange[1] === 5,
    '5: creature-if2 catalog entry with genRange 1-5');
  ok(P.get('creature-fusion').genRange === undefined, '5: default pack has no genRange');

  ok(P.selectedGens('creature-if2').join(',') === '1', '5: default selection is gen 1');
  P.setSelectedGens('creature-if2', [3, 1, 2, 2]);
  ok(P.selectedGens('creature-if2').join(',') === '1,2,3', '5: selection sorted + deduped');
  P.setSelectedGens('creature-if2', []);
  ok(P.selectedGens('creature-if2').join(',') === '1,2,3', '5: empty selection rejected');
  P.setSelectedGens('creature-if2', [1, 9]);
  ok(P.selectedGens('creature-if2').join(',') === '1', '5: out-of-range gens dropped');
  ok(P.subdirFor('creature-if2') === 'gen-1', '5: subdir from selection');
  ok(P.subdirFor('creature-fusion') === '', '5: no subdir for plain packs');
  ok(P.subdirFor('neopets') === '', '5: no subdir for solo packs');

  // families flag
  ok(P.selectedFamilies('creature-if2') === false, '5: families default off');
  P.setSelectedFamilies('creature-if2', true);
  ok(P.selectedFamilies('creature-if2') === true, '5: families toggle on');
  P.setSelectedGens('creature-if2', [1, 2]);
  ok(P.subdirFor('creature-if2') === 'gen-1-2-fam', '5: subdir includes -fam');
  ok(P.variantLabel('creature-if2') === 'gens 1,2 +fam', '5: variant label');
  P.setSelectedFamilies('creature-if2', false);
  ok(P.subdirFor('creature-if2') === 'gen-1-2', '5: families off removes -fam');

  const hf = PI.sourceForMode('static-hf', '', 'TessaCoil/creature-pack-if2', 'creature-if2');
  ok(hf.packBinUrl === 'https://huggingface.co/datasets/TessaCoil/creature-pack-if2/resolve/main/gen-1-2/pack.bin',
    '5: HF pack.bin URL includes gen-1-2 subdir: ' + hf.packBinUrl);
  ok(hf.packJsonUrl === hf.packBinUrl.replace('pack.bin', 'pack.json'), '5: HF pack.json URL matches');
  const local = PI.sourceForMode('bbox-flask', 'http://x', null, 'creature-if2');
  ok(local.packBinUrl === 'http://x/pack-files/creature-if2/gen-1-2/pack.bin',
    '5: local URL includes subdir: ' + local.packBinUrl);
  const plain = PI.sourceForMode('static-hf', '', 'TessaCoil/creature-pack', 'creature-fusion');
  ok(plain.packBinUrl === 'https://huggingface.co/datasets/TessaCoil/creature-pack/resolve/main/pack.bin',
    '5: default pack URL unchanged');
  const localPlain = PI.sourceForMode('bbox-flask', '', null, 'creature-fusion');
  ok(localPlain.packBinUrl === '/pack-files/creature-fusion/pack.bin', '5: default local URL unchanged');

  // Native variant URLs include both the gen subdir and the -native suffix.
  const hfNative = PI.sourceForMode('static-hf', '', 'TessaCoil/creature-pack-if2', 'creature-if2', true);
  ok(hfNative.packBinUrl === 'https://huggingface.co/datasets/TessaCoil/creature-pack-if2/resolve/main/gen-1-2/pack-native.bin',
    '5: HF native URL includes subdir + -native: ' + hfNative.packBinUrl);
  const localNative = PI.sourceForMode('bbox-flask', 'http://x', null, 'creature-if2', true);
  ok(localNative.packBinUrl === 'http://x/pack-files/creature-if2/gen-1-2/pack-native.bin',
    '5: local native URL includes subdir + -native: ' + localNative.packBinUrl);

  // checkForUpdate: same contentVersion/sha but different variant subdir
  // → 'available'. meta.gens stores the installed variant's subdir.
  ls['cc.contentPack.creature-if2.v1'] = JSON.stringify({
    packId: 'creature-if2', contentVersion: 'v1', sha256: 'abc', gens: 'gen-1',
    installedAt: 1,
  });
  globalThis.fetch = async () => ({
    ok: true, json: async () => ({ contentVersion: 'v1', sha256: 'abc' }),
  });
  return (async () => {
    P.setSelectedGens('creature-if2', [1, 2]);
    const r1 = await PI.checkForUpdate('creature-if2');
    ok(r1.state === 'available', '5: variant mismatch → update available (got ' + r1.state + ')');
    P.setSelectedGens('creature-if2', [1]);
    const r2 = await PI.checkForUpdate('creature-if2');
    ok(r2.state === 'up-to-date', '5: matching variant → up-to-date (got ' + r2.state + ')');
    P.setSelectedFamilies('creature-if2', true);
    const r2b = await PI.checkForUpdate('creature-if2');
    ok(r2b.state === 'available', '5: families toggle → update available (got ' + r2b.state + ')');
    P.setSelectedFamilies('creature-if2', false);
    const r3 = await PI.checkForUpdate('creature-fusion');
    ok(r3.state === 'none', '5: no meta for default pack → none (got ' + r3.state + ')');
    delete globalThis.localStorage;
    delete globalThis.fetch;
  })().catch((e) => { ok(false, '5: checkForUpdate threw: ' + e.message); });
}

// --- 6) picker gear UI wiring ----------------------------------------------------
function section6() {
  const src = fs.readFileSync(path.join(root, 'static', 'creatures.js'), 'utf8');
  ok(src.includes('pack-pick-gear') && src.includes('data-gear'),
    '6: gear icon present in pack picker rows');
  ok(src.includes('_showGenPicker') && src.includes('data-gen'),
    '6: generation toggle dialog present');
  ok(src.includes('pick at least one generation'), '6: empty selection guarded');
  ok(src.includes('data-fam') && src.includes('Whole evolution families'),
    '6: families toggle present in gen dialog');
  ok(src.includes('gensChanged'), '6: variant switch re-downloads on gens change');
  // Re-download badge must be available for the ACTIVE pack too (it was
  // gated on installed && !isActive, leaving no way to force a
  // re-download of the pack in use).
  ok(!/installed && !isActive[\s\S]{0,120}data-redl/.test(src),
    '6: ↻ re-download badge not gated on !isActive');
  ok(src.includes("'already active'"),
    '6: plain tap on the active row is a no-op guard');
  const indexHtml = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
  ok(indexHtml.includes('tap again to re-download anyway'),
    '6: settings row offers a force re-download second tap');
  const packsSrc = fs.readFileSync(path.join(root, 'static', 'packs.js'), 'utf8');
  ok(packsSrc.includes('genRange') && packsSrc.includes('cc.packGens.')
    && packsSrc.includes('cc.packGensFam.'),
    '6: packs.js genRange + cc.packGens(Fam) storage');
}

// --- 7) pack-driven species pool (Species.pool) -----------------------------------
function section7() {
  const ls = {
    'cc.speciesPool': JSON.stringify({
      species: [1, 2, 3, 144], legendaries: [144], babies: [172],
      spawnable: [1, 4, 7], maxSpecies: 429,
    }),
  };
  globalThis.localStorage = {
    getItem: (k) => (k in ls ? ls[k] : null),
    setItem: (k, v) => { ls[k] = String(v); },
    removeItem: (k) => { delete ls[k]; },
  };
  require(path.join(root, 'static', 'species.js'));
  const pool = globalThis.Species.pool();
  ok(pool && pool.has(3) && !pool.has(9), '7: pool.has from species-pool.json');
  ok(pool.isLegendary(144) && !pool.isLegendary(1), '7: pool.isLegendary');
  ok(pool.nonlegCount === 3, '7: nonlegCount excludes legendaries');
  ok(pool.max === 429 && pool.spawnable.join(',') === '1,4,7' && pool.babies.has(172),
    '7: max/spawnable/babies surfaced');
  delete globalThis.localStorage;
  delete globalThis.Species;
  // No cache → pool() is null (callers use their hardcoded fallback).
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  delete require.cache[require.resolve(path.join(root, 'static', 'species.js'))];
  require(path.join(root, 'static', 'species.js'));
  ok(globalThis.Species.pool() === null, '7: null pool without cache (fallback path)');
  delete globalThis.localStorage;
  delete globalThis.Species;
  delete require.cache[require.resolve(path.join(root, 'static', 'species.js'))];
}

// --- 8) default pack pool file == hardcoded client constants ----------------------
function section8() {
  const poolPath = path.join(root, 'data', 'BundledData', 'species-pool.json');
  if (fs.existsSync(poolPath)) {
    const pool = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
    ok(pool.maxSpecies === 429, '8: default pool maxSpecies = 429');
    ok(pool.legendaries.join(',') === '144,145,146,150,151',
      '8: default legendaries match LEGENDARY_SPECIES_SET');
    ok(pool.babies.join(',') === '172,173,174,175,236,238,239,240',
      '8: default babies match CANDY_ROOT_BABIES');
    ok(pool.species.length === 199 && pool.spawnable.length === 95,
      '8: default pool 199 species / 95 spawnable');
    ok(pool.spawnable[0] === 1 && pool.spawnable.includes(325),
      '8: spawnable mirrors SPAWNVABLE_SPECIES_A');
  } else {
    ok(false, '8: data/BundledData/species-pool.json missing — run build-bundled-data.py');
  }
}

// --- 7b) Species cache namespace is per gen-variant -------------------------------
// Regression: species.js/sprites.js used to namespace their caches by
// pack id only, so switching IF2 gen subsets kept serving the previous
// variant's species-pool (wrong spawn list / completion counts).
function section7b() {
  const speciesJs = path.join(root, 'static', 'species.js');
  function loadSpeciesWith(ls) {
    delete require.cache[require.resolve(speciesJs)];
    delete globalThis.Species;
    globalThis.localStorage = {
      getItem: (k) => (k in ls ? ls[k] : null),
      setItem: (k, v) => { ls[k] = String(v); },
      removeItem: (k) => { delete ls[k]; },
    };
    require(speciesJs);
    return globalThis.Species;
  }
  const poolJson = JSON.stringify({
    species: [1, 2, 3], legendaries: [], babies: [], spawnable: [1], maxSpecies: 151,
  });
  // Variant key populated → pool loads from the variant slot.
  let S = loadSpeciesWith({
    'cc.activePack': 'creature-if2',
    'cc.packGens.creature-if2': '1',
    'cc.speciesPool.creature-if2.1': poolJson,
  });
  ok(S.pool() && S.pool().max === 151, '7b: pool read from per-variant cache slot');
  // Only the OLD pack-level slot populated (the stale-cache scenario) →
  // must NOT be picked up under a variant selection.
  S = loadSpeciesWith({
    'cc.activePack': 'creature-if2',
    'cc.packGens.creature-if2': '1',
    'cc.speciesPool.creature-if2': poolJson,
  });
  ok(S.pool() === null, '7b: stale pack-level cache ignored after variant switch');
  // Different gens selection → different slot.
  S = loadSpeciesWith({
    'cc.activePack': 'creature-if2',
    'cc.packGens.creature-if2': '1,2',
    'cc.speciesPool.creature-if2.1,2': poolJson,
  });
  ok(S.pool() && S.pool().max === 151, '7b: gens list participates in the namespace');
  // -fam flag participates too.
  S = loadSpeciesWith({
    'cc.activePack': 'creature-if2',
    'cc.packGens.creature-if2': '1',
    'cc.packGensFam.creature-if2': '1',
    'cc.speciesPool.creature-if2.1f': poolJson,
  });
  ok(S.pool() && S.pool().max === 151, '7b: -fam flag participates in the namespace');
  // sprites.js applies the same namespacing to its IDB keys.
  const spritesSrc = fs.readFileSync(path.join(root, 'static', 'sprites.js'), 'utf8');
  ok(spritesSrc.includes("cc.packGens.' + v") && spritesSrc.includes("cc.packGensFam.' + v"),
    '7b: sprites.js namespaces its IDB caches per variant too');
  delete globalThis.localStorage;
  delete globalThis.Species;
  delete require.cache[require.resolve(speciesJs)];
}

function finish() {
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// Sections 1-4 ran synchronously above; 5-8 run in order via this
// chain (5 returns a promise for its checkForUpdate asserts).
(async () => {
  await section5();
  section6();
  section7();
  section7b();
  section8();
})().then(finish, (e) => { ok(false, 'unexpected: ' + (e && e.message)); finish(); });
