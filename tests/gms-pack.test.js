// Guards the GMS importer (build-gms-pack.py) against the real Neopets
// data pack: the converted pack.bin must carry valid types, species,
// categories, items, and byte-exact decoded sprites.
//
// Run: node tests/gms-pack.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const GMS = path.join(root, 'neopet_srlhgr_data_v2.0.gmsdp.bin');

async function main() {
  ok(fs.existsSync(GMS), 'gms source pack present at repo root');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gms-'));
  execFileSync('python3', ['build-gms-pack.py', GMS,
    '--pack-id', 'neopets', '--name', 'Neopets', '--out', tmp],
    { cwd: root, encoding: 'utf8' });

  require(path.join(root, 'static', 'pack-reader.js'));
  const r = await globalThis.PackReader.open(
    new Blob([fs.readFileSync(path.join(tmp, 'pack.bin'))]));
  ok(r.list().length > 800, 'pack has all entries (sprites + json)');

  // Types: 7, with a sane chart.
  const types = await r.json('types.json');
  ok(types.order.join() === 'PLAIN,FLUFFY,SLIPPERY,AQUATIC,FLIGHT,CUTE,TOUGH',
    'types: the 7 GMS types in order');
  ok(types.types.AQUATIC.color === '#0092ff'
    && types.types.AQUATIC.strong.includes('FLUFFY'),
    'types: aquatic row converted (color + chart)');
  let chartOk = true;
  for (const t of types.order) {
    const row = types.types[t];
    if (!row || !/^#[0-9a-fA-F]{6}$/.test(row.color)) chartOk = false;
    for (const id of [...row.strong, ...row.weak, ...row.immune]) {
      if (!types.order.includes(id)) chartOk = false;
    }
  }
  ok(chartOk, 'types: every row has a color + only known references');

  // Species: 221 solos with neo: ids, forms, evolutions.
  const sp = await r.json('species.json');
  ok(sp.length === 221, 'species: 221 monsters');
  ok(sp.every((s) => s.id.startsWith('neo:') && s.types.length >= 1
    && types.order.every((t) => s.types.includes(t) ? types.order.includes(t) : true)),
    'species: all ids namespaced + typed');
  const acar = sp.find((s) => s.id === 'neo:acar_1yellow');
  ok(acar && acar.name === 'Acara' && acar.types.join() === 'AQUATIC,CUTE'
    && acar.forms.length === 2 && acar.forms[0].icon === 'acar_yellow_m.png'
    && acar.dexentry.includes('Gormball'),
    'species: acara entry faithful (name, types, forms, dex entry)');
  ok(acar.evolutions.length === 4
    && acar.evolutions.some((e) => e.target === 'neo:acar_2red'
      && e.item === 'Red Paintbrush' && e.level === 10),
    'species: paintbrush evolution converted');

  // Categories: families + rare families (legendary), member mapping.
  const cats = await r.json('categories.json');
  ok(cats.categories.length === 88, 'categories: 43 families + 45 rare');
  ok(cats.categories.filter((c) => c.legendary).length === 45,
    'categories: rare families flagged legendary');
  ok(cats.soloCategories['neo:acar_1yellow'].join() === 'acara',
    'categories: solo membership mapped');
  const pant = cats.categories.find((c) => c.name === 'Pant Devil');
  ok(pant && pant.legendary && pant.members.includes('neo:zzzpantdevil'),
    'categories: Pant Devil is the legendary tier');

  // Items: paintbrushes only.
  const items = await r.json('items.json');
  ok(items.length === 4 && items.every((i) => i.kind === 'evo'
    && i.key.startsWith('neo_paintbrush_') && i.name.endsWith('Paintbrush')),
    'items: the 4 paintbrushes as evo items');

  // Sprites: decoded + byte-exact vs the base64 in the source.
  const text = fs.readFileSync(GMS, 'utf8').replace(/^﻿/, '');
  // The GMS file has a serial number glued after the root closing
  // brace — slice there, mirroring the importer's raw_decode tolerance.
  const gmsEnd = text.indexOf('}443685');
  const gms = JSON.parse(text.slice(0, gmsEnd + 1));
  const want = Buffer.from(gms.images['acar_yellow_m.png'], 'base64');
  const got = Buffer.from(await r.get('sprites/acar_yellow_m.png').arrayBuffer());
  ok(got.equals(want), 'sprites: acara art decodes byte-exact');
  ok(r.has('logo.png') && r.has('pack-info.json'), 'pack emblem + info present');
  const info = await r.json('pack-info.json');
  ok(info.id === 'neopets' && info.name === 'Neopets' && info.gmsVersion === '2.0',
    'pack-info: identity + GMS version carried');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
