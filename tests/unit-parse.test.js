// Tests the smart natural-language unit parser in static/extras.js:
//   ucBuildParser(UC_CATEGORIES)  →  { parse, resolve, convertAll, ... }
//
// This backs the "type 2 tsp / 5 cm to in / convert 2 tsp to cup" field
// added to the Unit conversions extra. The parser slice is fully
// self-contained (only standard built-ins + its categories arg — no DOM,
// no $), so we eval just that slice in a vm sandbox and drive it.
//
// Run: node tests/unit-parse.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }
function near(a, b, tol, msg) { ok(Math.abs(a - b) <= (tol || 1e-6), msg + ' (got ' + a + ', want ' + b + ')'); }

const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'extras.js'), 'utf8');
// Slice from the `lin` helper (top of the unit tables) through the parser
// export line — a closed region that defines UC_CATEGORIES + ucBuildParser
// and assigns them onto `global`.
const start = src.indexOf('const lin = (id, label, f)');
const endMarker = 'global.ucBuildParser = ucBuildParser;';
const end = src.indexOf(endMarker) + endMarker.length;
if (start < 0 || end < endMarker.length) throw new Error('parser slice markers not found');
const sandbox = { global: {} };
vm.runInNewContext(src.slice(start, end), sandbox, { filename: 'extras-unitparse-slice.js' });
const P = sandbox.global.ExtrasUnitParse;
ok(P && typeof P.parse === 'function', 'ExtrasUnitParse.parse exported');

// ── resolve(): alias coverage ───────────────────────────────────────────
const R = (t) => P.resolve(t);
ok(R('tsp') && R('tsp').cat === 'volume' && R('tsp').unit === 'tsp', 'tsp → volume/tsp');
ok(R('teaspoons').unit === 'tsp', 'teaspoons (plural word)');
ok(R('TSP').unit === 'tsp', 'case-insensitive');
ok(R('fl oz').unit === 'floz' && R('fl oz').cat === 'volume', 'fl oz → volume/floz (space dropped)');
ok(R('fluid ounce').unit === 'floz', 'fluid ounce');
ok(R('oz').cat === 'mass', 'bare oz → mass ounce (not fluid)');
ok(R('cup').unit === 'cup', 'cup');
ok(R('°C').unit === 'c' && R('°C').cat === 'temp', 'degree sign stripped');
ok(R('celsius').unit === 'c', 'celsius word');
ok(R('degrees celsius').unit === 'c', 'degrees-prefix stripped');
ok(R('fahrenheit').unit === 'f', 'fahrenheit');
ok(R('kelvin').unit === 'k', 'kelvin');
ok(R('metres per second').unit === 'ms' && R('metres per second').cat === 'speed', 'm/s spelled out');
ok(R('km/h').unit === 'kmh', 'km/h');
ok(R('kph').unit === 'kmh', 'kph');
ok(R('mph').unit === 'mph', 'mph');
ok(R('knots').unit === 'kn', 'knots');
ok(R('sq ft').unit === 'sqft' && R('sq ft').cat === 'area', 'sq ft → area');
ok(R('square metres').unit === 'sqm', 'square metres');
ok(R('pounds').unit === 'lb', 'pounds');
ok(R('lbs').unit === 'lb', 'lbs');
ok(R('tonnes').unit === 't', 'tonnes');
ok(R('"').unit === 'in', 'double-quote → inch');
ok(R("'").unit === 'ft', 'single-quote → foot');
ok(R('in').cat === 'length' && R('in').unit === 'in', 'bare in → inch');
// Ambiguity: "ms" is milliseconds (time), NOT metres/second (speed).
ok(R('ms').cat === 'time' && R('ms').unit === 'ms2', 'ms → time/millisecond (ambiguity resolved)');
ok(R('b').cat === 'data' && R('b').unit === 'byte', 'b → data/byte');
ok(R('bits').unit === 'bit', 'bits');
ok(R('bananas') === null, 'unknown token → null');
ok(R('') === null, 'empty → null');

// ── parse(): the phrasings from the task ─────────────────────────────────
let p;
p = P.parse('2 tsp');
ok(p.ok && p.value === 2 && p.from.unit === 'tsp' && p.to === null, '"2 tsp"');
p = P.parse('5 cm');
ok(p.ok && p.value === 5 && p.from.cat === 'length' && p.from.unit === 'cm', '"5 cm"');
p = P.parse('5cm');
ok(p.ok && p.value === 5 && p.from.unit === 'cm', '"5cm" (no space)');
p = P.parse('convert 2 tsp to cup');
ok(p.ok && p.value === 2 && p.from.unit === 'tsp' && p.to && p.to.unit === 'cup' && !p.mismatch,
   '"convert 2 tsp to cup"');
p = P.parse('1 tsp to cm');
ok(p.ok && p.from.unit === 'tsp' && p.to.unit === 'cm' && p.mismatch === true,
   '"1 tsp to cm" flagged as a mismatch (volume vs length)');
p = P.parse('3 mi to km');
ok(p.ok && p.from.unit === 'mi' && p.to.unit === 'km' && !p.mismatch, '"3 mi to km"');
p = P.parse('100 kph to mph');
ok(p.ok && p.from.unit === 'kmh' && p.to.unit === 'mph', '"100 kph to mph"');
p = P.parse('5 cm in inches');
ok(p.ok && p.from.unit === 'cm' && p.to.unit === 'in', '"5 cm in inches" ("in" as separator)');
p = P.parse('5 in');
ok(p.ok && p.from.unit === 'in' && p.to === null, '"5 in" stays whole → inches');

// reversed "how many X in Y"
p = P.parse('how many cups in 2 tsp');
ok(p.ok && p.value === 2 && p.from.unit === 'tsp' && p.to && p.to.unit === 'cup',
   '"how many cups in 2 tsp" (reversed form)');

// numbers: negatives, fractions, mixed, decimals, commas
p = P.parse('-40 c to f');
ok(p.ok && p.value === -40 && p.from.unit === 'c' && p.to.unit === 'f', 'negative "-40 c to f"');
p = P.parse('2 1/2 cups');
ok(p.ok && p.value === 2.5 && p.from.unit === 'cup', 'mixed fraction "2 1/2 cups"');
p = P.parse('1/2 cup');
ok(p.ok && p.value === 0.5 && p.from.unit === 'cup', 'fraction "1/2 cup"');
p = P.parse('.5 l');
ok(p.ok && p.value === 0.5 && p.from.unit === 'l', 'leading-dot ".5 l"');
p = P.parse('1,234 m');
ok(p.ok && p.value === 1234 && p.from.unit === 'm', 'thousands "1,234 m"');
p = P.parse('tsp to cup');
ok(p.ok && p.value === 1 && p.from.unit === 'tsp' && p.to.unit === 'cup', 'no number → assume 1');

// failure modes
ok(!P.parse('   ').ok, 'whitespace → not ok');
ok(!P.parse('5').ok, 'bare number → not ok');
p = P.parse('2 bananas');
ok(!p.ok && p.reason === 'unit', 'unknown unit → reason:unit');
p = P.parse('2 tsp to flurbs');
ok(!p.ok && p.reason === 'target', 'unknown target → reason:target');

// ── convertAll(): the actual arithmetic ──────────────────────────────────
function get(rows, id) { return rows.find((r) => r.id === id); }
let rows = P.convertAll(1000, { cat: 'length', unit: 'm' });
near(get(rows, 'km').value, 1, 1e-9, '1000 m = 1 km');
near(get(rows, 'cm').value, 100000, 1e-6, '1000 m = 100000 cm');
rows = P.convertAll(1, { cat: 'mass', unit: 'kg' });
near(get(rows, 'lb').value, 2.2046226218, 1e-6, '1 kg ≈ 2.2046 lb');
rows = P.convertAll(2, { cat: 'volume', unit: 'tsp' });
near(get(rows, 'ml').value, 9.8578431875, 1e-6, '2 tsp ≈ 9.8578 mL');
near(get(rows, 'cup').value, 2 * 0.00492892159375 / 0.2365882365, 1e-9, '2 tsp in cups');
// affine temperature round-trips through the celsius base
rows = P.convertAll(100, { cat: 'temp', unit: 'c' });
near(get(rows, 'f').value, 212, 1e-9, '100 °C = 212 °F');
near(get(rows, 'k').value, 373.15, 1e-9, '100 °C = 373.15 K');
rows = P.convertAll(32, { cat: 'temp', unit: 'f' });
near(get(rows, 'c').value, 0, 1e-9, '32 °F = 0 °C');

// every category converts cleanly (self-consistency: identity == input)
for (const c of P.categories) {
  for (const u of c.units) {
    const rr = P.convertAll(7, { cat: c.id, unit: u.id });
    const self = rr.find((r) => r.id === u.id);
    near(self.value, 7, 1e-9, c.id + '/' + u.id + ' identity conversion');
  }
}

console.log((failed ? 'FAILED ' : 'OK ') + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
