// Guards the cold-start critical path (Oct 2026 startup work). The
// Settings dump's [boot timeline] showed a Pixel 4a needing 7–12 s to
// reach "map idle + first creature sprite": every step waited on the
// one before it. Each check below pins one link of that chain open.
//
// Run: node tests/startup-path.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');

// Brace-matched slice of `function name(` … `}` from a source string.
function sliceFn(src, head) {
  const start = src.indexOf(head);
  if (start < 0) throw new Error('not found: ' + head);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced: ' + head);
}

// ── 1. Static tiles: overlapping regions are tried first ──────────────
// Trying regions in download order made the first tile of a boot open
// (and parse) regions nowhere near the view — 372 ms of a 437 ms tile.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(sliceFn(indexSrc, 'function _regionsForTile(') +
    '\nthis._regionsForTile = _regionsForTile;', ctx);
  const order = (regions, z, x, y) => ctx._regionsForTile(regions, z, x, y).map((r) => r.id);
  // Bees' first tile on 2026-10-11: z14 2588/5954 (Eugene, OR).
  const eugene = { id: 'eugene', bbox: [-123.3, 43.9, -122.9, 44.2] };
  const portland = { id: 'portland', bbox: [-122.9, 45.3, -122.4, 45.7] };
  const seattle = { id: 'seattle', bbox: [-122.5, 47.4, -122.2, 47.8] };
  const noBbox = { id: 'legacy' };
  ok(order([portland, seattle, eugene], 14, 2588, 5954)[0] === 'eugene',
    'the region containing the tile is tried first');
  ok(order([portland, seattle, eugene], 14, 2588, 5954).join() === 'eugene,portland,seattle',
    'non-overlapping regions stay as a fallback, in their original order');
  ok(order([portland, noBbox, eugene], 14, 2588, 5954).join() === 'legacy,eugene,portland',
    'a record without a bbox counts as overlapping (old behaviour)');
  ok(order([], 14, 2588, 5954).length === 0, 'no regions → empty list');
  // z5 5/11 spans lon -123.75..-112.5, lat 40.98..48.92 — all three.
  ok(order([portland, seattle, eugene], 5, 5, 11).join() === 'portland,seattle,eugene',
    'a tile overlapping several regions keeps their order');
  // z6 10/22 spans lat 45.09..48.92: Portland + Seattle, not Eugene.
  ok(order([eugene, seattle, portland], 6, 10, 22).join() === 'seattle,portland,eugene',
    'a region just outside the tile moves behind the overlapping ones');
}

console.log(`startup-path: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
