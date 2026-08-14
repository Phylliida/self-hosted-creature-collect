// Tests _missingSlotsByVariant (static/sprites.js): the per-SLOT resume
// check bulkDownload pass 2 uses to decide which custom-art cells still
// need fetching. The per-head customDone flag alone was not sufficient —
// a content update can add cells/variants under an already-done head
// (e.g. goldeen×porygon shipped in the 2026-08-10 bundle), and skipping
// the head left those slots + their variant-table rows missing forever,
// so the dex showed autogen-only despite the bundle having the art.
//
// Run: node tests/custom-download-resume.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'sprites.js'), 'utf8');
function extract(marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++) { if (src[i] === '\\') i++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const ctx = {};
vm.createContext(ctx);
for (const m of ['function customKey', 'function _missingSlotsByVariant']) {
  vm.runInContext(extract(m), ctx);
}

// Head 137's cells: body 118 has variant indices [0, 5] (slots 0 and 1),
// body 12 has [3] (slot 0).
const headCells = [[118, [0, 5]], [12, [3]]];

// 1. Nothing downloaded -> every slot missing, grouped by variant index.
{
  const out = ctx._missingSlotsByVariant(headCells, new Set(), 137);
  ok(out.size === 3, '1: three variant groups (got ' + out.size + ')');
  ok(JSON.stringify(out.get(0)) === JSON.stringify([[118, 0]])
    && JSON.stringify(out.get(5)) === JSON.stringify([[118, 1]])
    && JSON.stringify(out.get(3)) === JSON.stringify([[12, 0]]),
    '1: slots grouped under their sheet variant index');
}

// 2. Fully downloaded head -> empty map (caller skips the head entirely).
{
  const have = new Set(['118-137:c0', '118-137:c1', '12-137:c0']);
  const out = ctx._missingSlotsByVariant(headCells, have, 137);
  ok(out.size === 0, '2: all slots present -> nothing to fetch');
}

// 3. The reported bug: head previously done, content update adds a cell.
//    Slots already in IDB stay skipped; only the NEW cell is fetched.
{
  // Old bundle had only body 12's art; the update added body 118 (and a
  // second variant of it). IDB has the old slot only.
  const have = new Set(['12-137:c0']);
  const out = ctx._missingSlotsByVariant(headCells, have, 137);
  ok(out.size === 2 && !out.has(3), '3: only the new cell\'s variants are missing');
  ok(JSON.stringify(out.get(0)) === JSON.stringify([[118, 0]])
    && JSON.stringify(out.get(5)) === JSON.stringify([[118, 1]]),
    '3: new cell\'s slots fetched under the right variant indices');
}

// 4. Partial slot coverage within one cell: slot 0 present, slot 1 not.
{
  const have = new Set(['118-137:c0', '12-137:c0']);
  const out = ctx._missingSlotsByVariant(headCells, have, 137);
  ok(out.size === 1 && JSON.stringify(out.get(5)) === JSON.stringify([[118, 1]]),
    '4: only the missing slot of a partially-downloaded cell is fetched');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
