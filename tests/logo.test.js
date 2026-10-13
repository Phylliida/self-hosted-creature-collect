// The app logo is drawn by scripts/make-logo.py. Guards that the committed
// SVGs are exactly what the script draws (so nobody hand-edits them, or
// changes the script without regenerating), that the drawing is
// deterministic and well-formed, and that the PNGs built from it have the
// sizes and transparency their consumers expect.
//
// Run: node tests/logo.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'make-logo.py');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logo-'));
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'logo-'));
execFileSync('python3', [script, '--out', tmp]);
execFileSync('python3', [script, '--out', tmp2]);
const read = (p) => fs.readFileSync(p, 'utf8');

const icon = read(path.join(tmp, 'icon.svg')), full = read(path.join(tmp, 'logo-full.svg'));
ok(icon === read(path.join(tmp2, 'icon.svg')) && full === read(path.join(tmp2, 'logo-full.svg')),
  'the script draws the same logo every run');
ok(icon === read(path.join(root, 'static', 'icon.svg')), 'static/icon.svg is the script\'s output (regenerate with scripts/make-logo.py)');
ok(full === read(path.join(root, 'assets', 'logo-full.svg')), 'assets/logo-full.svg is the script\'s output');

for (const [name, svg] of [['icon.svg', icon], ['logo-full.svg', full]]) {
  ok(/^<svg xmlns='http:\/\/www\.w3\.org\/2000\/svg' viewBox='0 0 1024 1024'/.test(svg) && svg.trim().endsWith('</svg>'), `${name}: a 1024 SVG`);
  const open = (svg.match(/<(?!\/)[a-zA-Z]/g) || []).length;
  const close = (svg.match(/<\/[a-zA-Z]+>|\/>/g) || []).length;
  ok(open === close, `${name}: tags balance (${open}/${close})`);
  ok(!/NaN|undefined|None/.test(svg), `${name}: no NaN/None in the drawing`);
  ok(svg.length < 140000, `${name}: stays small for the cache-first app shell (${svg.length} bytes)`);
}
ok(/clip-path='url\(#tile\)'/.test(icon) && !/clip-path='url\(#tile\)'/.test(full), 'icon.svg is the rounded tile, logo-full.svg full bleed');

// PNGs: IHDR width/height/colour type.
function ihdr(p) {
  const b = fs.readFileSync(p);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), type: b[25] };
}
for (const [p, size] of [['static/icon.png', 512], ['static/icon-maskable.png', 512], ['assets/icon-only.png', 1024]]) {
  const h = ihdr(path.join(root, p));
  ok(h.w === size && h.h === size && h.type === 6, `${p}: ${size}×${size} RGBA (got ${h.w}×${h.h} type ${h.type})`);
}
const manifest = JSON.parse(read(path.join(root, 'static', 'manifest.webmanifest')));
ok(['/static/icon.png', '/static/icon-maskable.png', '/static/icon.svg'].every((s) => manifest.icons.some((i) => i.src === s)),
  'the manifest still lists all three icons');

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(tmp2, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
