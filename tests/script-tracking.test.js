// Every app script index.html loads must be shipped by live-update.
//
// The native apps only receive code updates for files listed in run.py's
// _SCRIPT_VERSION_FILES (served by /script-versions, which live-update
// diffs). A file that's served/stamped (_TRACKED_JS) but missing from that
// list silently stays at the version bundled in the IPA/APK — that
// happened to shiny-store.js. build-capacitor.sh keeps its own copy of the
// tracked list for first-launch version seeding; it must match too.
//
// Also guards the load order the storage fix depends on: idb-util.js (and
// collection-store.js) come before every script that touches IndexedDB.
//
// Run: node tests/script-tracking.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const indexSrc = read('static/index.html');
const extrasSrc = read('static/extras.html');
const runPy = read('run.py');
const buildCap = read('scripts/build-capacitor.sh');

function quotedIn(src, startRe, endStr) {
  const m = src.match(startRe);
  if (!m) throw new Error('block not found: ' + startRe);
  const start = m.index + m[0].length;
  const end = src.indexOf(endStr, start);
  return new Set([...src.slice(start, end).matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}
const trackedJs = quotedIn(runPy, /^_TRACKED_JS = \{/m, '\n}');
const versionFiles = quotedIn(runPy, /^_SCRIPT_VERSION_FILES = \[/m, '\n]');
const buildTracked = quotedIn(buildCap, /^TRACKED_JS = \{/m, '\n}');

const scripts = (src) => [...src.matchAll(/<script src="\/static\/([^"?]+\.js)"/g)]
  .map((m) => m[1]).filter((n) => !n.startsWith('vendor/'));
// Scripts index.html loads after boot (window._CC_DEFERRED_SCRIPTS) are
// app scripts too: same tracking rules, and they run after the tags.
const deferredBlock = indexSrc.match(/window\._CC_DEFERRED_SCRIPTS = \[([\s\S]*?)\];/);
ok(!!deferredBlock, "found index.html's deferred script list");
const deferredScripts = deferredBlock
  ? [...deferredBlock[1].matchAll(/'\/static\/([^'?]+\.js)'/g)].map((m) => m[1]) : [];
ok(deferredScripts[0] === 'extras.js', 'extras.js is the first deferred script (defines ExtrasRegisterTool)');
const indexScripts = scripts(indexSrc).concat(deferredScripts);
ok(indexScripts.length >= 20, `found index.html's script list (${indexScripts.length})`);

for (const n of indexScripts) {
  ok(trackedJs.has(n), `${n}: in run.py _TRACKED_JS (served no-store + version-stamped)`);
  ok(versionFiles.has(n), `${n}: in run.py _SCRIPT_VERSION_FILES (shipped by live-update)`);
  ok(buildTracked.has(n), `${n}: in build-capacitor.sh TRACKED_JS (bundled version seed)`);
}
// Flat tracked JS (not mini-app subtree files) must all be live-updatable.
for (const n of trackedJs) {
  if (n.includes('/')) continue;
  ok(versionFiles.has(n), `${n}: tracked but missing from _SCRIPT_VERSION_FILES`);
}

// Load order: storage helpers before any IndexedDB user.
const idxOf = (list, n) => list.indexOf(n);
const iUtil = idxOf(indexScripts, 'idb-util.js');
const iCs = idxOf(indexScripts, 'collection-store.js');
ok(iUtil === 0, 'idb-util.js is the first app script in index.html');
ok(iCs > iUtil && iCs < idxOf(indexScripts, 'creatures.js'),
   'collection-store.js loads after idb-util.js and before creatures.js');
for (const n of ['sprites.js', 'appdata.js', 'creatures.js', 'extras.js']) {
  ok(idxOf(indexScripts, n) > iUtil, `${n} loads after idb-util.js`);
}
const extrasScripts = scripts(extrasSrc);
ok(extrasScripts.indexOf('idb-util.js') >= 0
   && extrasScripts.indexOf('idb-util.js') < extrasScripts.indexOf('extras.js'),
   'extras.html loads idb-util.js before extras.js');

console.log(`script-tracking: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
