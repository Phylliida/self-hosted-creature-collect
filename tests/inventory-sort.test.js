// Inventory name / species sort (static/creatures.js sortedCreatures):
// same order as a plain localeCompare sort, both directions, but with the
// nickname map read ONCE per sort — reading it per comparison (a
// localStorage get + JSON.parse each) made flipping the direction lag on
// collections of thousands.
//
// Run: node tests/inventory-sort.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'creatures.js'), 'utf8');
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

// 3000 creatures with repeated names (ties keep catch order) and a few
// nicknames, some accented so the collator matters.
const NAMES = ['Bulbasaur', 'Ivysaur', 'Éevee', 'eevee', 'Zubat', 'Abra', 'Mr. Mime', 'Ñorbit'];
const creatures = [];
for (let i = 0; i < 3000; i++) {
  creatures.push({ id: 'c' + i, name: NAMES[(i * 7) % NAMES.length], caughtAt: { timestamp: i } });
}
const nicknames = { c5: 'Zed', c10: 'aardvark', c42: 'Émile', c99: 'Bulbasaur' };
let nickReads = 0;
let sortKey = 'name', sortDir = 'asc';
const ctx = {
  Intl, performance: { now: () => 0 },
  readSortKey: () => sortKey,
  readSortDir: () => sortDir,
  getInventoryCreatures: () => creatures.slice(),
  readNicknames: () => { nickReads++; return JSON.parse(JSON.stringify(nicknames)); },
  _perfMark: () => {},
  _invPerf: { fn: {} },
};
vm.createContext(ctx);
vm.runInContext(extract('function displayName('), ctx);
vm.runInContext('const _NAME_COLLATOR = new Intl.Collator();', ctx);
vm.runInContext(extract('function sortedCreatures('), ctx);
const run = () => vm.runInContext('sortedCreatures()', ctx);

// Reference: the old comparator (localeCompare per comparison).
const ref = (key, dir) => {
  const sign = dir === 'asc' ? 1 : -1;
  const nameOf = (c) => key === 'name' ? (nicknames[c.id] || c.name) : c.name;
  return creatures.slice().sort((a, b) => sign * nameOf(a).localeCompare(nameOf(b))).map((c) => c.id).join(',');
};

for (const key of ['name', 'species']) {
  for (const dir of ['asc', 'desc']) {
    sortKey = key; sortDir = dir; nickReads = 0;
    const got = run().map((c) => c.id).join(',');
    ok(got === ref(key, dir), `${key} ${dir}: same order as localeCompare`);
    ok(nickReads <= 1, `${key} ${dir}: nicknames read at most once (got ${nickReads})`);
  }
}
sortKey = 'name'; sortDir = 'asc';
const first = run();
ok(first[0].id === 'c10', 'a nickname sorts by the nickname (aardvark first)');
sortKey = 'recent'; sortDir = 'desc';
ok(run()[0].id === 'c2999', 'recent sort unchanged');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
