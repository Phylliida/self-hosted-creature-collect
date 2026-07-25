// Extras workbench (/extras): payload round-trip core + page wiring.
//
//   (1) ExtrasWorkbench.mergePayload — the safety property the whole
//       page rests on: NON-extras fields pass through byte-identical
//       (creatures, eggs, GPS history, settings, writeToken, …); only
//       extras slices present in the captured object are overlaid.
//   (2) pickWriteToken precedence: loaded save's token > local map >
//       freshly generated.
//   (3) EXTRA_KEYS stays in lockstep with index.html's buildBackupPayload
//       extras slices — a slice added there but not here would be
//       silently DROPPED from saves made through the workbench (well,
//       passed through stale, but edits to it would be lost).
//   (4) extras.html loads every extras script index.html does (plus the
//       workbench), has the top-bar controls, and Save starts disabled.
//   (5) run.py serves /extras gated (behavioral half in
//       tests/tofu-claims.test.py).
//
// Run: node tests/extras-workbench.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
require(path.join(root, 'static', 'extras-workbench.js'));
const W = globalThis.ExtrasWorkbench;
ok(!!W && typeof W.mergePayload === 'function', 'ExtrasWorkbench core exported under Node');

// ── (1) pass-through safety ──
const pristine = {
  version: 1, backupName: 'Bees', writeToken: 'tok_original_1234567890',
  captured: [{ id: 'c-1', speciesA: 25 }], seenFusions: { '1-2': {} },
  candy: { 1: 50 }, daycare: { paths: ['gps-blob'] }, settings: { 'cc.theme': 'x' },
  fractals: [{ id: 'f-old' }], anki: { format: 'oss-anki-backup', notes: [1] },
  todos: { tasks: [1, 2] }, unknownFutureField: { keep: 'me' },
};
const captured = { anki: { format: 'oss-anki-backup', notes: [1, 2, 3] }, drawings: [{ id: 'd-new' }] };
const out = W.mergePayload(pristine, captured, '2026-07-25T00:00:00Z');
ok(out.captured === pristine.captured && out.daycare === pristine.daycare
  && out.seenFusions === pristine.seenFusions && out.candy === pristine.candy
  && out.settings === pristine.settings && out.unknownFutureField === pristine.unknownFutureField,
  'non-extras fields pass through untouched (same references)');
ok(out.writeToken === 'tok_original_1234567890' && out.backupName === 'Bees',
  'identity fields pass through');
ok(out.anki.notes.length === 3 && out.drawings[0].id === 'd-new',
  'captured slices overlay the pristine ones');
ok(out.fractals === pristine.fractals && out.todos === pristine.todos,
  'slices NOT captured (API missing / import failed) keep the pristine value');
ok(out.exportedAt === '2026-07-25T00:00:00Z', 'exportedAt refreshed');
ok(pristine.anki.notes.length === 1, 'pristine object is not mutated');

// ── (2) token precedence ──
const gen = () => 'tok_generated';
ok(W.pickWriteToken({ writeToken: 'tok_save' }, { Bees: 'tok_local' }, 'Bees', gen) === 'tok_save',
  'loaded save token wins');
ok(W.pickWriteToken({}, { Bees: 'tok_local' }, 'Bees', gen) === 'tok_local',
  'local map token is the fallback');
ok(W.pickWriteToken({}, {}, 'Bees', gen) === 'tok_generated',
  'fresh token generated when neither exists');

// ── (3) EXTRA_KEYS ↔ buildBackupPayload lockstep ──
const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
for (const k of W.EXTRA_KEYS) {
  ok(new RegExp('^\\s*' + k + ':', 'm').test(indexSrc),
    `index.html buildBackupPayload has the "${k}" slice`);
}
// reverse: every extras-slice import hook in importData is covered here
for (const api of ['ExtrasFractals', 'ExtrasFractals2', 'ExtrasSongs', 'ExtrasQuivers',
                   'ExtrasDrawings', 'ExtrasPixelArt', 'ExtrasAnki']) {
  ok(fs.readFileSync(path.join(root, 'static', 'extras-workbench.js'), 'utf8').includes(api),
    `workbench captures/applies ${api}`);
}

// ── (4) page wiring ──
const page = fs.readFileSync(path.join(root, 'static', 'extras.html'), 'utf8');
const scriptTags = [...indexSrc.matchAll(/<script src="\/static\/(extras[^"]*\.js)"><\/script>/g)]
  .map((m) => m[1]);
ok(scriptTags.length >= 10, `found the extras script list in index.html (${scriptTags.length})`);
for (const s of scriptTags) {
  ok(page.includes(`/static/${s}`), `extras.html loads ${s}`);
}
ok(page.includes('/static/extras-workbench.js'), 'extras.html loads the workbench');
ok(page.includes('id="extrasBtn"'), 'extras.html provides #extrasBtn (extras.js hard-requires it)');
ok(page.includes('id="wbSave"') && page.includes('disabled'), 'Save present and starts disabled');
ok(page.includes('cc-x-btn') && page.includes('#extrasPanel .sheet'),
  'extras.html carries the host-page CSS the suite expects');
// The bar stays reachable inside every tool: all three fullscreen overlay
// containers are pushed below it, and the workbench keeps --wb-top synced
// to the bar's real (wrappable) height.
ok(/#extrasPanel, \.fractals-window, \.exapp-win \{\s*top: var\(--wb-top\) !important;/.test(page),
  'extras.html pins every fullscreen overlay below the top bar');
const wbSrc = fs.readFileSync(path.join(root, 'static', 'extras-workbench.js'), 'utf8');
ok(wbSrc.includes("setProperty('--wb-top'") && wbSrc.includes('ResizeObserver'),
  'workbench syncs --wb-top to the bar height');

// ── (5) server route ──
const runPy = fs.readFileSync(path.join(root, 'run.py'), 'utf8');
ok(runPy.includes('@app.route("/extras")'), 'run.py serves /extras');
ok(/def extras_workbench\(\):[\s\S]{0,900}?if _PUBLIC_INSTANCE:/.test(runPy),
  'run.py gates /extras to the home instance');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
