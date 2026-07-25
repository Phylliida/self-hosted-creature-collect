// Wiring guards for the split save/load server + TOFU write-token flow.
//
// The behavioral half (claims, public-mode gating, size cap) lives in
// tests/tofu-claims.test.py against a real Flask test client. This file
// guards the CLIENT plumbing in static/index.html at the string level
// (same style as extras-refresh-coverage.test.js): the pieces are easy
// to drop accidentally in later edits, and each one failing silently
// re-opens a privacy hole or bricks saving for a claimed name.
//
// Run: node tests/save-server-urls.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
const runPy = fs.readFileSync(path.join(root, 'run.py'), 'utf8');

// ── client: split server routing ──
ok(indexSrc.includes('function _serverUrl(kind, path)'), 'index.html: _serverUrl helper exists');
ok(indexSrc.includes("fetch(_serverUrl('save', '/save')"), 'index.html: /save routed via save server');
ok(indexSrc.includes("_serverUrl('load', `/load?name="), 'index.html: /load routed via load server');
ok(indexSrc.includes("_ccServerUrl('save', '/upload-logs')"), 'index.html: /upload-logs routed via save server');
ok(indexSrc.includes("kind === 'load' ? (load || save) : save"),
  'index.html: load URL falls back to save URL');
ok(indexSrc.includes('id="saveServerUrl"') && indexSrc.includes('id="loadServerUrl"'),
  'index.html: both Settings inputs exist');
ok(indexSrc.includes("'cc.saveServerUrl'") && indexSrc.includes("'cc.loadServerUrl'"),
  'index.html: both URL prefs persisted');
// the friendly hint depends on the server actually 403ing loads publicly
ok(indexSrc.includes('resp.status === 403'), 'index.html: Load surfaces the home-network hint on 403');

// ── client: TOFU write token ──
ok(indexSrc.includes('function _writeTokenFor(name)'), 'index.html: _writeTokenFor helper exists');
ok(indexSrc.includes('crypto.getRandomValues'), 'index.html: tokens come from a CSPRNG');
ok(/writeToken:[\s\S]{0,200}_writeTokenFor/.test(indexSrc),
  'index.html: buildBackupPayload carries writeToken');
ok(/data\.writeToken[\s\S]{0,400}cc\.writeTokens\.v1/.test(indexSrc),
  'index.html: importData restores the token (a home load re-grants write access)');
ok(indexSrc.includes("data['saveServerUrl']") || /\['saveServerUrl', 'cc\.saveServerUrl'\]/.test(indexSrc),
  'index.html: importData restores the server URL fields');

// ── server: gates + claims (redundant with the python test, but these
// string anchors catch a refactor that silently drops the wiring) ──
ok(runPy.includes('_PUBLIC_INSTANCE = os.environ.get("CC_LAN") != "1"'),
  'run.py: reads gated by default — only CC_LAN=1 serves /load');
// run_as_lan.py is the explicit opt-in wrapper; the env var must be set
// BEFORE run.py is imported or the import-time flag won't see it.
const lanPy = fs.readFileSync(path.join(root, 'run_as_lan.py'), 'utf8');
ok(lanPy.indexOf('os.environ["CC_LAN"] = "1"') > -1
  && lanPy.indexOf('os.environ["CC_LAN"] = "1"') < lanPy.indexOf('import run'),
  'run_as_lan.py: sets CC_LAN before importing run.py');
ok((runPy.match(/if _PUBLIC_INSTANCE:/g) || []).length >= 2,
  'run.py: both /load and /save-names check the public flag');
ok(runPy.includes('bounce = _check_write_claim(name, payload, millis)'),
  'run.py: /save enforces the TOFU claim');
ok(runPy.includes('hmac.compare_digest'), 'run.py: constant-time token compare');
ok(runPy.includes('MAX_CONTENT_LENGTH'), 'run.py: request size cap set');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
