// Tests that Settings-menu preferences round-trip through the save file.
//
// Backups used to carry only 9 of 23 settings — both map locks, the whole
// Visibility section, clock, timezone and more were dropped on the floor, so
// loading your save onto a fresh device gave you your creatures but not your
// preferences. buildBackupPayload now emits a `settings` object driven by the
// SAVED_SETTINGS table, importData validates it back in, and
// _applySettingsFromStorage re-syncs the UI (import does NOT reload the page).
//
// Same extraction trick as tests/compass-rotate-lock.test.js: the code lives in
// an inline <script> in index.html, so we brace-match it out and run it in a vm
// sandbox with stub DOM / localStorage / map-layer functions.
//
// Run: node tests/settings-persistence.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const src = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf8');

// Bracket-match a block starting at `marker`, comment/string aware. `open` is
// '{' for functions, '[' for the SAVED_SETTINGS array literal.
function matchBlock(marker, open) {
  const close = open === '[' ? ']' : '}';
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('not found in index.html: ' + marker);
  let i = src.indexOf(open, at), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === '`') { const q = c; for (i++; i < src.length && src[i] !== q; i++) { if (src[i] === '\\') i++; } continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error('could not bracket-match: ' + marker);
}

// --- stub environment ------------------------------------------------------
function makeEnv() {
  const store = new Map();
  const els = new Map();
  const calls = [];
  const el = (id, kind) => {
    const e = kind === 'select'
      ? { id, value: '', options: [] }
      : { id, checked: false };
    els.set(id, e);
    return e;
  };
  // Checkboxes + selects the apply function touches.
  ['wifiOnlyToggle', 'steadyCatchToggle', 'actionIconsToggle', 'lockZoomToggle',
   'lockRotateToggle', 'memBadgeToggle', 'debugConsoleToggle', 'buildingPoisToggle',
   'renderBuildingsToggle', 'renderTransitLinesToggle', 'renderHousenumbersToggle',
   'showPanelToggle'].forEach((id) => el(id, 'checkbox'));
  ['clockFormatSelect', 'timezoneSelect', 'routingWalkWeight', 'routingTransferMin']
    .forEach((id) => el(id, 'select'));
  // The timezone <select> is populated from this device's Intl data; the
  // validator only accepts a zone that's actually offered.
  els.get('timezoneSelect').options = [
    { value: 'America/Montreal' }, { value: 'UTC' }, { value: 'Asia/Tokyo' },
  ];

  const sandbox = {
    console,
    document: { getElementById: (id) => els.get(id) || null },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    window: {},
    CustomEvent: function (name) { this.type = name; },
    // Side-effect stubs — the real ones live elsewhere in index.html.
    applyPanelVisibility() {
      calls.push('applyPanelVisibility');
      const hidden = store.get('cc.hidePanel') === '1';
      els.get('showPanelToggle').checked = !hidden;
    },
    applyZoomLock: (v) => calls.push('applyZoomLock:' + v),
    applyRotateLock: (v) => calls.push('applyRotateLock:' + v),
    addBuildingPokestopsLayer: () => calls.push('addBuildingPokestops'),
    removeBuildingPokestopsLayer: () => calls.push('removeBuildingPokestops'),
    applyBuildingsLayerVisibility: () => calls.push('applyBuildings'),
    applyTransitLinesVisibility: () => calls.push('applyTransit'),
    applyHousenumbersVisibility: () => calls.push('applyHousenumbers'),
  };
  sandbox.window.dispatchEvent = () => calls.push('dispatchEvent');
  vm.createContext(sandbox);
  const code = [
    matchBlock("const _ONOFF = ['0', '1']", '['),
    matchBlock('const SAVED_SETTINGS = [', '['),
    matchBlock('function collectSavedSettings()', '{'),
    matchBlock('function restoreSavedSettings(settings)', '{'),
    matchBlock('window._applySettingsFromStorage = function ()', '{'),
    // `const`/`function` at the top level of a vm script don't attach to the
    // sandbox global, so hand them over explicitly.
    'this.SAVED_SETTINGS = SAVED_SETTINGS;',
    'this.collectSavedSettings = collectSavedSettings;',
    'this.restoreSavedSettings = restoreSavedSettings;',
  ].join('\n;\n');
  vm.runInContext(code, sandbox);
  return { sandbox, store, els, calls };
}

// --- 1. no setting is silently left out of the save ------------------------
// Regression guard: every cc.* key the settings/routing UI persists must be
// covered, either by the SAVED_SETTINGS table or by the legacy top-level
// payload fields. A new toggle added without persistence trips this.
{
  const { sandbox } = makeEnv();
  const tableKeys = new Set(sandbox.SAVED_SETTINGS.map((s) => s.key));

  // Keys that ride as top-level camelCase payload fields (pre-date the table).
  const legacy = new Set([
    'cc.theme', 'cc.themeCustom', 'cc.units', 'cc.creatureMode',
    'cc.creatureSortBy', 'cc.creatureSortDir', 'cc.backupName',
    'cc.pedometerEnabled', 'cc.regionsMode', 'cc.autoBackup',
    'cc.radarAutogenLabels',
  ]);
  // Deliberately device-local or not user-facing settings.
  const exempt = new Set([
    'cc.forceShiny',        // dev-only hook, no UI
    'cc.preferMultiGraph',  // read-only, no UI
    'cc.lastFitnessSyncMs', // device-local sync marker, must NOT travel
  ]);

  // Scan the settings-wiring region for persisted preference keys.
  const from = src.indexOf('const panelToggle = document.getElementById(\'showPanelToggle\')');
  const to = src.indexOf('const backupNameInput = document.getElementById(\'backupName\')');
  ok(from > 0 && to > from, 'located the settings-wiring region in index.html');
  const region = src.slice(from, to);
  const found = new Set();
  const re = /localStorage\.setItem\(\s*'(cc\.[A-Za-z0-9_.]+)'/g;
  let m;
  while ((m = re.exec(region))) found.add(m[1]);
  ok(found.size >= 10, `scan found a plausible number of settings keys (${found.size})`);

  const missing = [...found].filter(
    (k) => !tableKeys.has(k) && !legacy.has(k) && !exempt.has(k));
  ok(missing.length === 0,
    'every persisted settings key round-trips; not covered: ' + missing.join(', '));

  // The specific 14 the task called out.
  ['cc.clockFormat', 'cc.timezone', 'cc.hidePanel', 'cc.wifiOnly',
   'cc.actionButtonsAsIcons', 'cc.lockZoom', 'cc.lockRotate', 'cc.memBadge',
   'cc.debugConsole', 'cc.steadyCatch', 'cc.buildingPois', 'cc.renderBuildings',
   'cc.renderTransitLines', 'cc.renderHousenumbers'].forEach((k) => {
    ok(tableKeys.has(k), `${k} is in SAVED_SETTINGS`);
  });

  // The pedometer must stay out of the table: its restore needs the native
  // permission prompt + sync-marker seed, so it can't be flipped on blindly.
  ok(!tableKeys.has('cc.pedometerEnabled'),
    'cc.pedometerEnabled stays on its bespoke restore path');
}

// --- 2. collect skips unset keys, captures set ones ------------------------
{
  const { sandbox, store } = makeEnv();
  ok(Object.keys(sandbox.collectSavedSettings()).length === 0,
    'a virgin device exports no settings (all keys unset)');

  store.set('cc.lockRotate', '1');
  store.set('cc.renderHousenumbers', '0');
  const out = sandbox.collectSavedSettings();
  ok(out['cc.lockRotate'] === '1', 'collect captures cc.lockRotate');
  ok(out['cc.renderHousenumbers'] === '0', 'collect captures cc.renderHousenumbers');
  ok(!('cc.wifiOnly' in out), 'collect omits keys that were never set');
}

// --- 3. restore validates ---------------------------------------------------
{
  const { sandbox, store } = makeEnv();
  const n = sandbox.restoreSavedSettings({
    'cc.lockRotate': '1',
    'cc.lockZoom': 'yes',              // not '0'/'1' → rejected
    'cc.clockFormat': '12h',
    'cc.hidePanel': 1,                 // number, not string → rejected
    'cc.timezone': 'Asia/Tokyo',       // offered by the stub <select>
    'cc.walkWeight': '2.5',
    'cc.transferMin': '5',
    'cc.nonsenseKey': '1',             // not in the table → ignored
  });
  ok(n === 5, `restore reports the number applied (got ${n}, want 5)`);
  ok(store.get('cc.lockRotate') === '1', 'valid on/off value applied');
  ok(store.get('cc.clockFormat') === '12h', 'valid enum value applied');
  ok(store.get('cc.timezone') === 'Asia/Tokyo', 'offered timezone applied');
  ok(store.get('cc.walkWeight') === '2.5', 'numeric routing pref applied');
  ok(!store.has('cc.lockZoom'), 'junk on/off value rejected');
  ok(!store.has('cc.hidePanel'), 'non-string value rejected');
  ok(!store.has('cc.nonsenseKey'), 'unknown key ignored');

  // A zone this device does not offer must not be written.
  sandbox.restoreSavedSettings({ 'cc.timezone': 'Mars/Olympus_Mons' });
  ok(store.get('cc.timezone') === 'Asia/Tokyo', 'unoffered timezone rejected');

  // Out-of-range routing values.
  sandbox.restoreSavedSettings({ 'cc.walkWeight': '0', 'cc.transferMin': '-1' });
  ok(store.get('cc.walkWeight') === '2.5', 'walkWeight <= 0 rejected');
  ok(store.get('cc.transferMin') === '5', 'negative transferMin rejected');

  ok(sandbox.restoreSavedSettings(null) === 0, 'missing settings object is a no-op');
  ok(sandbox.restoreSavedSettings('nope') === 0, 'non-object settings is a no-op');
}

// --- 4. the save wins over an existing local value -------------------------
// Older imports guarded on `!localStorage.getItem(key)`, so re-loading a backup
// onto a device you'd already used never picked your preferences up. Loading a
// save is an explicit "make this device match" action.
{
  const { sandbox, store } = makeEnv();
  store.set('cc.lockRotate', '0');
  sandbox.restoreSavedSettings({ 'cc.lockRotate': '1' });
  ok(store.get('cc.lockRotate') === '1', 'imported value overrides the local one');
}

// --- 5. applying re-syncs the UI + fires side effects -----------------------
// Import does not reload the page, so this is what makes a restored setting
// actually visible/effective.
{
  const { sandbox, store, els, calls } = makeEnv();
  store.set('cc.lockRotate', '1');
  store.set('cc.lockZoom', '0');
  store.set('cc.wifiOnly', '1');
  store.set('cc.buildingPois', '1');
  store.set('cc.clockFormat', '12h');
  store.set('cc.timezone', 'UTC');
  store.set('cc.walkWeight', '3');
  sandbox.window._applySettingsFromStorage();

  ok(els.get('lockRotateToggle').checked === true, 'lock-rotate checkbox re-synced');
  ok(els.get('lockZoomToggle').checked === false, 'lock-zoom checkbox re-synced');
  ok(els.get('wifiOnlyToggle').checked === true, 'wifi-only checkbox re-synced');
  ok(els.get('clockFormatSelect').value === '12h', 'clock select re-synced');
  ok(els.get('timezoneSelect').value === 'UTC', 'timezone select re-synced');
  ok(els.get('routingWalkWeight').value === '3', 'walk-weight input re-synced');
  ok(els.get('routingTransferMin').value === '3', 'transfer-min falls back to its default');

  ok(calls.includes('applyRotateLock:true'), 'rotate lock actually applied to the map');
  ok(calls.includes('applyZoomLock:false'), 'zoom lock actually released on the map');
  ok(calls.includes('addBuildingPokestops'), 'building pokéstops layer added');
  ok(calls.includes('applyBuildings') && calls.includes('applyTransit')
     && calls.includes('applyHousenumbers'), 'visibility layers re-applied');
}

// --- 6. the two odd-polarity toggles ---------------------------------------
// hidePanel is inverted (checkbox = "show", key = "hide") and
// renderTransitLines defaults ON (`!== '0'`) while its neighbours default OFF.
// Getting either backwards silently flips a setting on import.
{
  const { sandbox, store, els } = makeEnv();
  store.set('cc.hidePanel', '1');
  sandbox.window._applySettingsFromStorage();
  ok(els.get('showPanelToggle').checked === false,
    'hidePanel=1 leaves the "show panel" checkbox unchecked');

  store.set('cc.hidePanel', '0');
  sandbox.window._applySettingsFromStorage();
  ok(els.get('showPanelToggle').checked === true,
    'hidePanel=0 checks the "show panel" checkbox');
}
{
  const { sandbox, store, els } = makeEnv();
  // Unset → default ON.
  sandbox.window._applySettingsFromStorage();
  ok(els.get('renderTransitLinesToggle').checked === true,
    'renderTransitLines defaults to on when unset');
  ok(els.get('renderBuildingsToggle').checked === false,
    'renderBuildings defaults to off when unset');

  store.set('cc.renderTransitLines', '0');
  sandbox.window._applySettingsFromStorage();
  ok(els.get('renderTransitLinesToggle').checked === false,
    'renderTransitLines=0 unchecks it');
}

// --- 7. full round trip -----------------------------------------------------
// Device A configures settings → export → import on device B → device B's UI
// matches. This is the actual user-visible promise of the task.
{
  const A = makeEnv();
  A.store.set('cc.lockRotate', '1');
  A.store.set('cc.lockZoom', '1');
  A.store.set('cc.hidePanel', '1');
  A.store.set('cc.renderTransitLines', '0');
  A.store.set('cc.renderHousenumbers', '1');
  A.store.set('cc.steadyCatch', '1');
  A.store.set('cc.clockFormat', '12h');
  A.store.set('cc.debugConsole', '1');
  const payload = JSON.parse(JSON.stringify(A.sandbox.collectSavedSettings()));

  const B = makeEnv();
  const n = B.sandbox.restoreSavedSettings(payload);
  ok(n === 8, `all 8 settings crossed the wire (got ${n})`);
  B.sandbox.window._applySettingsFromStorage();

  ok(B.els.get('lockRotateToggle').checked === true, 'B: lock rotate on');
  ok(B.els.get('lockZoomToggle').checked === true, 'B: lock zoom on');
  ok(B.els.get('showPanelToggle').checked === false, 'B: offline panel hidden');
  ok(B.els.get('renderTransitLinesToggle').checked === false, 'B: transit lines off');
  ok(B.els.get('renderHousenumbersToggle').checked === true, 'B: house numbers on');
  ok(B.els.get('steadyCatchToggle').checked === true, 'B: guaranteed catch on');
  ok(B.els.get('debugConsoleToggle').checked === true, 'B: debug console on');
  ok(B.els.get('clockFormatSelect').value === '12h', 'B: 12h clock');
  ok(B.calls.includes('applyRotateLock:true'), 'B: rotate lock applied to the map');

  // Re-exporting from B must reproduce A's payload exactly.
  ok(JSON.stringify(B.sandbox.collectSavedSettings()) === JSON.stringify(payload),
    'B re-exports an identical settings payload (stable round trip)');
}

// --- 8. the payload and import path are actually wired up ------------------
{
  ok(/settings:\s*collectSavedSettings\(\)/.test(src),
    'buildBackupPayload emits the settings object');
  ok(/restoreSavedSettings\(data\.settings\)/.test(src),
    'importData restores the settings object');
  ok(/window\._applySettingsFromStorage\(\)/.test(src),
    'importData re-applies settings to the live UI');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
