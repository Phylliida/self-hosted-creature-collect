// Type-incense art (_incenseIcon in static/creatures.js): every type gets
// a censer with its own emblem; a type with no emblem (one a pack adds)
// or a colour that isn't #rrggbb keeps the plain orb; every incense icon
// in the UI goes through _incenseIcon.
//
// Run: node tests/incense-art.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
require(path.join(root, 'static', 'types.js'));
const Types = global.Types;
const src = fs.readFileSync(path.join(root, 'static', 'creatures.js'), 'utf8');
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
      for (i++; i < src.length && src[i] !== q; i++) {
        if (src[i] === '\\') i++;
        // Template literal ${…} may hold quotes; skip balanced braces.
        else if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          let dd = 0;
          for (i++; i < src.length; i++) { if (src[i] === '{') dd++; else if (src[i] === '}' && --dd === 0) break; }
        }
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const colors = { SHADOW: '#888' };   // a pack type with no art
const ctx = {
  Math, encodeURIComponent,
  global: { Types: {
    color: (t) => colors[t] || Types.color(t),
  } },
};
vm.createContext(ctx);
for (const m of ['function _mixHex(', 'function _incenseEmblem(', 'function _incenseCenserSvg(',
  'function _incenseOrbIcon(', 'function _incenseIcon(']) vm.runInContext(extract(m), ctx);
vm.runInContext('const _r2 = (n) => Math.round(n * 100) / 100; const _incenseIconCache = new Map();', ctx);
const icon = (t) => { ctx.__t = t; return vm.runInContext('_incenseIcon(__t)', ctx); };
const orb = (c) => { ctx.__c = c; return vm.runInContext('_incenseOrbIcon(__c)', ctx); };
const decode = (u) => decodeURIComponent(u.slice('data:image/svg+xml,'.length));

const types = Types.list();
ok(types.length === 18, `18 types (got ${types.length})`);
const seen = new Set();
for (const t of types) {
  const u = icon(t);
  const svg = decode(u);
  ok(u.startsWith('data:image/svg+xml,') && u !== orb(Types.color(t)), `${t}: censer art, not the orb`);
  ok(/^<svg xmlns='http:\/\/www\.w3\.org\/2000\/svg' viewBox='0 0 40 40'>[\s\S]*<\/svg>$/.test(svg), `${t}: a 40×40 SVG`);
  const open = (svg.match(/<(?!\/)[a-zA-Z]/g) || []).length;
  const close = (svg.match(/<\/[a-zA-Z]+>|\/>/g) || []).length;
  ok(open === close, `${t}: tags balance (${open}/${close})`);
  ok(!/NaN|undefined|null/.test(svg), `${t}: no NaN/undefined in the drawing`);
  ok(svg.includes(Types.color(t)) || svg.includes(Types.color(t).toLowerCase()), `${t}: drawn in its type colour`);
  // The emblem sits between the rim's far side and the bowl's near side.
  const rim = svg.indexOf("<ellipse cx='20' cy='24' rx='13.2'"), bowl = svg.indexOf("<path d='M6.8 24 A13.2 2.9");
  ok(rim > 0 && bowl > rim + 300, `${t}: emblem drawn inside the censer (rim → emblem → bowl)`);
  seen.add(svg.slice(rim, bowl));
}
ok(seen.size === types.length, 'every type has its own emblem');
ok(icon('SHADOW') === orb('#888'), 'a type with no emblem keeps the orb');
colors.FIRE = 'rgb(1,2,3)';
ctx.__t = 'FIRE'; vm.runInContext('_incenseIconCache.delete(__t)', ctx);
ok(icon('FIRE') === orb('rgb(1,2,3)'), 'a non-#rrggbb colour keeps the orb');
delete colors.FIRE;
ok(icon('WATER') === icon('WATER'), 'cached per type');

// Every incense icon in the UI goes through _incenseIcon.
ok(!/_incenseOrbIcon\(global\.Types\.color\(/.test(src), 'no call site draws the bare orb any more');
const uses = (src.match(/_incenseIcon\(/g) || []).length;
ok(uses >= 8, `bag item, craft strip/confirm/done/chip, detail row and battle badge use _incenseIcon (${uses - 1} call sites)`);
ok(/icon: _incenseIcon\(t\),/.test(src), 'the bag item uses it');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
