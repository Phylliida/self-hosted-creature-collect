// Savefile bridge for the Flashcards extra (static/extras-anki.js).
//
// Exercises window.ExtrasAnki.capture / importMerge end-to-end against
// fake-indexeddb — the same code path the app uses for backup export,
// server /save, and Load — plus the zero-network + wiring invariants:
//
//   (1) capture() on a never-used device -> null (savefile field stays null)
//   (2) capture() serializes the whole collection + media as the oss-anki
//       one-file backup object (JSON-able, media base64)
//   (3) importMerge() into an empty device adopts the backup wholesale
//   (4) importMerge() into a diverged device MERGES: revlog union, notes
//       by GUID, higher-reps card scheduling wins — loading an older save
//       never loses local reviews
//   (5) importMerge() is idempotent (Load twice == Load once)
//   (6) media: local bytes win name conflicts, imported-only files added
//   (7) wiring: savefile field + import hook present in index.html, and
//       the bundled anki app references no CDN
//
// Run: node tests/anki-bridge.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'static', 'anki', 'src');
const fdb = require(path.join(root, 'static', 'anki', 'node_modules', 'fake-indexeddb'));

// Point the bridge at the real modules + a swappable fake IDB factory.
global.ExtrasAnkiModuleBase = pathToFileURL(srcDir + path.sep).href;
let factory = new fdb.IDBFactory();
global.ExtrasAnkiIDB = factory;
const freshDevice = () => { factory = new fdb.IDBFactory(); global.ExtrasAnkiIDB = factory; };

require(path.join(root, 'static', 'extras-anki.js'));
const A = globalThis.ExtrasAnki;
ok(!!A && typeof A.capture === 'function' && typeof A.importMerge === 'function',
  'ExtrasAnki.{capture,importMerge} exported under Node');

(async () => {
  const storage = await import(pathToFileURL(path.join(srcDir, 'storage.js')).href);
  const backup = await import(pathToFileURL(path.join(srcDir, 'backup.js')).href);
  const model = await import(pathToFileURL(path.join(srcDir, 'model.js')).href);
  const { Collection, Note, Card, Revlog } = model;

  // ── (1) empty device ──
  ok((await A.capture()) === null, 'capture() -> null when the tool was never used');

  // ── seed a collection the way the app would ──
  function seed() {
    const col = Collection.createDefault();
    const mid = Object.values(col.models).find((m) => m.name === 'Basic').id;
    const note = new Note({ mid, fields: ['2+2', '4'], tags: ['math'] }).normalize();
    col.addNote(note);
    col.addCard(new Card({ nid: note.id, did: 1 }));
    const media = new Map([['pic.png', new Uint8Array([1, 2, 3, 250])]]);
    return { col, media, note };
  }
  const seeded = seed();
  {
    const db = await storage.openCollectionDB('oss-anki', factory);
    await storage.saveCollection(db, seeded.col);
    await storage.saveMedia(db, seeded.media);
    db.close();
  }

  // ── (2) capture serializes everything ──
  const cap = await A.capture();
  ok(cap && cap.format === 'oss-anki-backup', 'capture() returns an oss-anki backup object');
  ok(cap.notes.length === 1 && cap.cards.length === 1, 'capture() carries notes + cards');
  ok(typeof cap.media['pic.png'] === 'string', 'capture() media is base64 (JSON-able)');
  const roundtrip = JSON.parse(JSON.stringify(cap));  // through real JSON like the savefile
  ok(JSON.stringify(roundtrip) === JSON.stringify(cap), 'backup object survives JSON round-trip');

  // ── (3) adopt into an empty device ──
  freshDevice();
  const adopted = await A.importMerge(roundtrip);
  ok(adopted.cards === 1, 'importMerge into empty device adopts the collection');
  const cap2 = await A.capture();
  ok(cap2.notes.length === 1
    && cap2.notes[0][6] === cap.notes[0][6]  // fields column of the row
    && cap2.media['pic.png'] === cap.media['pic.png'],
    'empty-device adoption round-trips notes + media byte-for-byte');

  // ── (4) merge into a DIVERGED device: local reviews must survive ──
  // Local device: same base collection, but the user reviewed the card
  // (reps=1 + a revlog entry) and stashed different bytes for pic.png.
  freshDevice();
  const localSide = backup.collectionFromBackup(JSON.parse(JSON.stringify(roundtrip)));
  const localCol = localSide.collection;
  const localCard = [...localCol.cards.values()][0];
  localCard.reps = 1;
  localCard.ivl = 3;
  localCol.addRevlog(new Revlog({ id: 1700000000001, cid: localCard.id, ease: 3, ivl: 3, type: 1 }));
  {
    const db = await storage.openCollectionDB('oss-anki', factory);
    await storage.saveCollection(db, localCol);
    await storage.saveMedia(db, new Map([
      ['pic.png', new Uint8Array([9, 9, 9])],           // local bytes differ
    ]));
    db.close();
  }
  // Imported save: the OLD state (reps=0, no revlog) + an extra note the
  // other device added + an extra media file.
  const importedSide = backup.collectionFromBackup(JSON.parse(JSON.stringify(roundtrip)));
  const importedCol = importedSide.collection;
  const mid = Object.values(importedCol.models).find((m) => m.name === 'Basic').id;
  const extraNote = new Note({ mid, fields: ['Capital of France', 'Paris'], tags: [] }).normalize();
  importedCol.addNote(extraNote);
  importedCol.addCard(new Card({ nid: extraNote.id, did: 1 }));
  importedCol.addRevlog(new Revlog({ id: 1700000000002, cid: extraNote.id, ease: 2, ivl: 1, type: 0 }));
  const importedObj = JSON.parse(JSON.stringify(backup.collectionToBackup(importedCol, new Map([
    ['pic.png', new Uint8Array([1, 2, 3, 250])],
    ['extra.mp3', new Uint8Array([77, 77])],
  ]))));

  const merged = await A.importMerge(importedObj);
  ok(merged.cards === 2, 'merge adds the other device\'s new card');
  const cap3 = await A.capture();
  ok(cap3.notes.length === 2, 'merge unions notes by GUID (no duplicate of the shared note)');
  ok(cap3.revlog.length === 2, 'merge unions revlog entries from both sides');
  {
    const back = backup.collectionFromBackup(cap3);
    const c = [...back.collection.cards.values()].find((x) => x.nid !== extraNote.id);
    ok(c.reps === 1 && c.ivl === 3,
      'loading an older save keeps the local review (higher-reps scheduling wins)');
    ok([...back.media.get('pic.png')].join(',') === '9,9,9',
      'local media bytes win a name conflict');
    ok([...back.media.get('extra.mp3')].join(',') === '77,77',
      'imported-only media is added');
  }

  // ── (5) idempotence ──
  await A.importMerge(importedObj);
  const cap4 = await A.capture();
  ok(cap4.notes.length === 2 && cap4.revlog.length === 2 && cap4.cards.length === 2,
    'importing the same save twice changes nothing');

  // ── (6) bad input rejected ──
  let threw = false;
  try { await A.importMerge({ some: 'json' }); } catch (_) { threw = true; }
  ok(threw, 'importMerge rejects non-backup objects');

  // ── (7) wiring + zero-network invariants ──
  const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
  ok(indexSrc.includes('window.ExtrasAnki.capture'), 'index.html: anki field in buildBackupPayload');
  ok(indexSrc.includes('window.ExtrasAnki.importMerge'), 'index.html: anki merge in importData');
  ok(indexSrc.includes('/static/extras-anki.js'), 'index.html: extras-anki.js script tag / refresh list');
  const ankiIndex = fs.readFileSync(path.join(root, 'static', 'anki', 'web', 'index.html'), 'utf8');
  ok(!/https?:\/\//.test(ankiIndex), 'anki web/index.html references no remote URL');
  const ankiApp = fs.readFileSync(path.join(root, 'static', 'anki', 'web', 'app.js'), 'utf8');
  ok(!/cdn\.|esm\.sh|unpkg|jsdelivr/.test(ankiApp), 'anki web/app.js references no CDN');
  const buildCap = fs.readFileSync(path.join(root, 'scripts', 'build-capacitor.sh'), 'utf8');
  ok(buildCap.includes('static/anki/node_modules') && buildCap.includes('static/anki/test'),
    'build-capacitor.sh prunes the anki dev harness from the bundle');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
