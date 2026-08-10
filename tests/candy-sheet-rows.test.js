// Tests that candy / egg sprite-sheet geometry adapts to the active pack.
// The base creature-fusion pack has 43 rows; IF2 packs bake 58 rows.
// Run: node tests/candy-sheet-rows.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); }
}

const root = path.join(__dirname, '..');
const creaturesSrc = fs.readFileSync(path.join(root, 'static', 'creatures.js'), 'utf8');

// ── 1. IF2 bundled sheets must actually be 58 rows tall ───────────
function rowsIn(pngPath, cellPx) {
  try {
    // PNG IHDR: width 4 bytes at offset 16, height 4 bytes at offset 20.
    const buf = fs.readFileSync(pngPath);
    const h = buf.readUInt32BE(20);
    return Math.round(h / cellPx);
  } catch (e) {
    return null;
  }
}
const if2CandyRows = rowsIn(path.join(root, 'data', 'BundledData-if2', 'candies.png'), 40);
const if2EggRows = rowsIn(path.join(root, 'data', 'BundledData-if2', 'eggs.png'), 160);
ok(if2CandyRows === 58, `IF2 candies.png should be 58 rows, got ${if2CandyRows}`);
ok(if2EggRows === 58, `IF2 eggs.png should be 58 rows, got ${if2EggRows}`);

// ── 2. creatures.js background-size strings must use CSS vars ─────
// All candy/egg sheet background-size declarations now reference the
// runtime-detected custom properties instead of the hardcoded 43 rows.
const candyBgSizes = creaturesSrc.match(/background-size:\s*[^;]*var\(--cc-candy-sheet-rows[^;]*;/g) || [];
const eggBgSizes = creaturesSrc.match(/background-size:\s*[^;]*var\(--cc-egg-sheet-rows[^;]*;/g) || [];
ok(candyBgSizes.length >= 3,
  `expected at least 3 candy background-size var() uses, got ${candyBgSizes.length}`);
ok(eggBgSizes.length >= 2,
  `expected at least 2 egg background-size var() uses, got ${eggBgSizes.length}`);
// The hardcoded constants should still exist as var() fallbacks.
ok(/var\(--cc-candy-sheet-rows, \$\{CANDY_SHEET_ROWS\}\)/.test(creaturesSrc),
  'candy var() should fall back to CANDY_SHEET_ROWS');
ok(/var\(--cc-egg-sheet-rows, \$\{EGGS_SHEET_ROWS\}\)/.test(creaturesSrc),
  'egg var() should fall back to EGGS_SHEET_ROWS');

// ── 3. _probeSheetRows sets the CSS custom property on image load ─
function extractFunction(name) {
  const marker = `function ${name}`;
  const start = creaturesSrc.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  let i = creaturesSrc.indexOf('{', start), depth = 0;
  for (; i < creaturesSrc.length; i++) {
    const c = creaturesSrc[i];
    if (c === '/' && creaturesSrc[i + 1] === '/') { while (i < creaturesSrc.length && creaturesSrc[i] !== '\n') i++; continue; }
    if (c === '/' && creaturesSrc[i + 1] === '*') { i = creaturesSrc.indexOf('*/', i + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (i++; i < creaturesSrc.length && creaturesSrc[i] !== q; i++) { if (creaturesSrc[i] === '\\') i++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return creaturesSrc.slice(start, i + 1);
}

const setProps = {};
const fakeDocument = {
  documentElement: {
    style: {
      setProperty: (name, value) => { setProps[name] = value; }
    }
  }
};
let capturedImg = null;
const fakeWindow = {
  Image: class FakeImage {
    set src(u) {
      this._src = u;
      capturedImg = this;
      // Defer load so onload can be assigned first.
      setTimeout(() => {
        if (this.onload) {
          // naturalHeight derived from the URL: candies=58 rows, eggs=58 rows.
          const isCandy = /candies\.png/.test(u);
          this.naturalHeight = isCandy ? 58 * 40 : 58 * 160;
          this.onload();
        }
      }, 0);
    }
    get src() { return this._src; }
  }
};

const probeCtx = { window: fakeWindow, document: fakeDocument, console, Image: fakeWindow.Image };
vm.createContext(probeCtx);
vm.runInContext(extractFunction('_probeSheetRows'), probeCtx);
vm.runInContext(`_probeSheetRows('/bundled-data/candies.png', 40, '--cc-candy-sheet-rows', 43)`, probeCtx);

// Wait for the fake async image load.
setTimeout(() => {
  ok(setProps['--cc-candy-sheet-rows'] === '58',
    `probe should set --cc-candy-sheet-rows to 58, got ${setProps['--cc-candy-sheet-rows']}`);
  ok(capturedImg && /candies\.png/.test(capturedImg.src),
    `probe should load candies.png, got ${capturedImg && capturedImg.src}`);

  console.log(`candy-sheet-rows: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}, 10);
