// Validates static/scala-db.json — the bundled Scala scale archive that the
// synth's Tuning Explorer browses. Guards the build-scala-db.py output shape
// so a bad regeneration can't ship a DB the explorer chokes on.
// Run: node tests/scala-db.test.js

'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL: ' + msg); }
}

const db = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'static', 'scala-db.json'), 'utf8'));

ok(db.v === 2, 'version field');
ok(typeof db.credit === 'string' && db.credit.indexOf('huygens-fokker') >= 0,
   'credit line names the archive source');
ok(Array.isArray(db.scales) && db.scales.length >= 5000,
   'at least 5000 scales (got ' + (db.scales || []).length + ')');

// every entry: [name, description, fam 0-10, into 0-3, cents[] with finite
// values and a positive final period — the invariants sanitizeScl/parseDB rely on
let shapeOk = true, centsOk = true, periodOk = true, first = null;
const names = new Set();
for (const s of db.scales) {
  if (!Array.isArray(s) || s.length !== 5 ||
      typeof s[0] !== 'string' || !s[0] ||
      typeof s[1] !== 'string' ||
      !Number.isInteger(s[2]) || s[2] < 0 || s[2] > 10 ||
      !Number.isInteger(s[3]) || s[3] < 0 || s[3] > 3 ||
      !Array.isArray(s[4]) || !s[4].length) {
    shapeOk = false; first = first || s; continue;
  }
  names.add(s[0]);
  for (const c of s[4]) {
    if (typeof c !== 'number' || !isFinite(c) || c < -24000 || c > 24000) { centsOk = false; first = first || s; }
  }
  if (!(s[4][s[4].length - 1] > 0)) { periodOk = false; first = first || s; }
}
ok(shapeOk, 'every scale is [name, desc, fam, into, cents[]]' + (first ? ' (first bad: ' + JSON.stringify(first).slice(0, 80) + ')' : ''));
ok(centsOk, 'all cents finite and within [-24000, 24000]');
ok(periodOk, 'every period (last cents value) is positive');
ok(names.size === db.scales.length, 'scale names unique (' + names.size + ' vs ' + db.scales.length + ')');

// distribution sanity — the archive's well-known shape
const twelve = db.scales.filter(s => s[4].length === 12).length;
ok(twelve > 1000, '12-note bin is the biggest (got ' + twelve + ')');
const fams = {};
db.scales.forEach(s => { fams[s[2]] = (fams[s[2]] || 0) + 1; });
ok([0, 1, 6, 7, 8, 10].every(f => fams[f] > 50), 'main families populated (' + JSON.stringify(fams) + ')');
const intos = [0, 0, 0, 0];
db.scales.forEach(s => intos[s[3]]++);
ok(intos.every(t => t > 100), 'every intonation class is populated (' + intos.join(', ') + ')');

// spot-checks against known scales
const byName = new Map(db.scales.map(s => [s[0], s]));
const meanquar = byName.get('meanquar');
ok(!!meanquar && Math.abs(meanquar[4][3] - 386.31) < 0.01,
   'meanquar (1/4-comma meantone) has the pure major third at degree 4');
ok(!!meanquar && Math.abs(meanquar[4][meanquar[4].length - 1] - 1200) < 0.01,
   'meanquar period is the octave');
ok(!!meanquar && meanquar[2] === 10, 'meanquar tagged historical temperament');
const alpha = byName.get('carlos_alpha');
ok(!!alpha && alpha[2] === 5 && alpha[3] === 3 && Math.abs(alpha[4][alpha[4].length - 1] - 1200) > 1,
   'carlos_alpha is Carlos, equal-step, non-octave period');
const bp = byName.get('bohlen-p_lambda') || byName.get('bohlen-p_et');
ok(!!bp && bp[2] === 3 && Math.abs(bp[4][bp[4].length - 1] - 1901.96) < 1,
   'Bohlen-Pierce family repeats at the twelfth (~1902c)');
ok(db.scales.some(s => s[0].indexOf('slendro') >= 0 && s[2] === 1),
   'slendro scales tagged gamelan');
const pyth = byName.get('pyth_12');
ok(!!pyth && pyth[3] === 1, 'pythagorean 12 classified just (all ratios)');
const alfarabi = byName.get('al-farabi_g1');
ok(!!alfarabi && alfarabi[2] === 7, 'al-Farabi tagged Middle Eastern, not Greek');

console.log('scala-db tests: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
