// Guards sprite artist credits (Oct 2026). The game's credits CSV names
// a fusion "<head>.<body><suffix>"; credits.json keeps that order
// ("<head>-<body>"), the REVERSE of cells.json's "<body>-<head>". Two
// bugs made 93% of custom sprites show the wrong artist:
//   - sprites.js looked credits up as "<body>-<head>" (the mirrored
//     fusion's artist), and
//   - merge-custom-art.py re-lettered each credit row through the
//     BODY's variant list instead of the head's (wrong letters for
//     IF2/Battlers variants; IF1 rows dropped when the body species had
//     fewer variants).
//
// Run: node tests/sprite-credits.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const bundled = path.join(root, 'data', 'BundledData');
const credits = JSON.parse(fs.readFileSync(path.join(bundled, 'credits.json'), 'utf8'));
const cells = JSON.parse(fs.readFileSync(path.join(bundled, 'cells.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(bundled, 'manifest.json'), 'utf8'));

// ── 1. merge_credits re-letters through the HEAD's variant list ──────
{
  const out = execFileSync('python3', ['-B', '-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location('mca', 'merge-custom-art.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
# Head 143 (Snorlax): IF1 '' and 'a', then a Battlers sheet as merged 'b'.
# Head 11 (Metapod): IF1 '' only.
remap = {('IF1', 143, ''): 0, ('IF1', 143, 'a'): 1, ('BAT', 143, ''): 2, ('IF1', 11, ''): 0}
csvs = {'IF1': {(143, 11, ''): 'soggy', (143, 11, 'a'): 'soggy2', (11, 143, ''): 'hunter'}}
bat = [{(143, 11, ''): 'soggy-bat'}]
r = m.merge_credits(remap, csvs, bat)
print(json.dumps(sorted([[h, b, s, a] for (h, b, s), a in r.items()])))
`], { cwd: root, encoding: 'utf8' });
  const rows = JSON.parse(out).map((r) => r.join('|'));
  ok(rows.includes('143|11||soggy'), '1: IF1 base row kept');
  ok(rows.includes('143|11|a|soggy2'),
    '1: IF1 "a" row kept although the body species (11) has no "a" variant');
  ok(rows.includes('143|11|b|soggy-bat'), '1: Battlers row lands on the head\'s merged letter');
  ok(rows.includes('11|143||hunter'), '1: the mirrored fusion keeps its own artist');
  ok(rows.length === 4, `1: nothing else (${rows.length} rows)`);
}

// ── 2. credits.json is keyed head-first and matches the art ──────────
{
  const art = (head, body, s) => {
    const sufs = manifest[head] || [];
    const i = sufs.indexOf(s);
    return i >= 0 && (cells[`${body}-${head}`] || []).includes(i);
  };
  let n = 0, headFirst = 0;
  for (const [k, d] of Object.entries(credits)) {
    const [x, y] = k.split('-');
    for (const s of Object.keys(d)) { n++; if (art(x, y, s)) headFirst++; }
  }
  ok(n > 100000, `2: credits.json has entries (${n})`);
  ok(headFirst / n > 0.97, `2: credits sit on custom art read head-first (${(100 * headFirst / n).toFixed(1)}%)`);
}

// ── 3. getSpriteCreditForSlot (the real function) ────────────────────
const spritesSrc = fs.readFileSync(path.join(root, 'static', 'sprites.js'), 'utf8');
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
const ctx = {
  _ensureCreditsBundle: async () => credits,
  _getCellVariantArr: async (a, b) => cells[`${a}-${b}`] || null,
  getCustomManifest: async () => manifest,
  _bumpCreditDiag: () => {},
};
vm.createContext(ctx);
vm.runInContext(sliceFn(spritesSrc, 'async function getSpriteCreditForSlot(')
  + '\nthis.credit = getSpriteCreditForSlot;', ctx);

(async () => {
  // a = body, b = head (cells.json order). Artists per the game CSV:
  // 143.11 / 143.11a soggy_nugget, 11.143 hunter____4985,
  // 136.143 carolus__, 136.143a kulgun.
  ok(await ctx.credit(11, 143, 0) === 'soggy_nugget', '3: Snorlax head / Metapod body → soggy_nugget');
  ok(await ctx.credit(11, 143, 1) === 'soggy_nugget', '3: …its second variant too');
  ok(await ctx.credit(143, 11, 0) === 'hunter____4985', '3: Metapod head / Snorlax body → hunter____4985');
  ok(await ctx.credit(143, 136, 0) === 'carolus__', '3: Flareon head / Snorlax body → carolus__');
  ok(await ctx.credit(143, 136, 1) === 'kulgun.', '3: …second variant → kulgun.');
  // Nearly every custom slot resolves to an artist (every 7th cell).
  let slots = 0, hits = 0;
  const entries = Object.entries(cells).filter((_, i) => i % 7 === 0);
  for (const [k, v] of entries) {
    const [a, b] = k.split('-').map(Number);
    for (let s = 0; s < v.length; s++) {
      slots++;
      if (await ctx.credit(a, b, s)) hits++;
    }
  }
  ok(hits / slots > 0.99, `3: custom slots with an artist: ${hits}/${slots}`);
  console.log(`sprite-credits: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
