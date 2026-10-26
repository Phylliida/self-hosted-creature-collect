// Theme editor core (window.CCUserThemes, in index.html's early <head>
// script between the [user-themes-core begin/end] markers). A user theme is
// 8 key colours + name + style; everything else is derived. Checks:
//   1. clean() accepts good themes and rejects / sanitises bad input
//      (imported .json files are untrusted),
//   2. toTheme() yields a complete THEMES entry with valid colours and a
//      readable accent text colour,
//   3. auroraTokens() covers every --au-* token the Aurora stylesheet in
//      creatures.js defines (so custom Aurora themes can't miss one),
//   4. register/store keep window.THEMES + the generated token <style> in
//      sync, and applyAttrs drives html[data-ui-style],
//   5. the Aurora rules in creatures.js match html[data-ui-style="aurora"].
//
// Run: node tests/user-themes.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
const creatures = fs.readFileSync(path.join(root, 'static', 'creatures.js'), 'utf8');

const a = src.indexOf('// [user-themes-core begin]');
const b = src.indexOf('// [user-themes-core end]');
ok(a > 0 && b > a, 'found the user-themes core markers');
const core = src.slice(a, b);

// Minimal DOM + storage for the core to run against.
function makeEnv(themes) {
  const store = new Map();
  const styles = {};
  const attrs = {};
  const head = { appendChild(el) { styles[el.id] = el; } };
  const document = {
    head,
    documentElement: {
      setAttribute(k, v) { attrs[k] = String(v); },
      removeAttribute(k) { delete attrs[k]; },
      getAttribute(k) { return k in attrs ? attrs[k] : null; },
    },
    getElementById(id) { return styles[id] || null; },
    createElement() { return { id: '', textContent: '' }; },
  };
  const window = { THEMES: themes };
  const localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
  };
  vm.runInNewContext(core, { window, document, localStorage, JSON, Math, Date, String, Array, Object, parseInt });
  return { UT: window.CCUserThemes, window, document, localStorage, styles, attrs };
}

const HEX = /^#[0-9a-f]{6}$/i;
const good = {
  id: 'u-test1', name: 'Sunset', style: 'aurora', updated: 5,
  c: { land: '#1d2236', water: '#0b2a4a', road: '#3a4170', building: '#2a2f52',
       panel: '#161a33', text: '#ece8ff', accent: '#ff8a5c', accent2: '#5eead4' },
};

// 1. clean()
{
  const { UT } = makeEnv({ default: { ui: { panelBg: '#ffffff' } } });
  const c = UT.clean(good);
  ok(c && c.id === 'u-test1' && c.style === 'aurora' && c.name === 'Sunset', 'clean keeps a good theme');
  ok(UT.clean({ ...good, c: { ...good.c, accent: 'red' } }) === null, 'clean rejects a non-hex colour');
  ok(UT.clean({ ...good, c: { ...good.c, water: undefined } }) === null, 'clean rejects a missing colour');
  ok(UT.clean(null) === null && UT.clean('x') === null, 'clean rejects junk');
  const odd = UT.clean({ ...good, id: 'evil"><script>', style: 'weird', name: 'x'.repeat(99) });
  ok(odd && odd.id === null, 'clean drops an unsafe id');
  ok(odd && odd.style === 'aurora', 'unknown style falls back to aurora');
  ok(odd && odd.name.length === 40, 'name is capped');
  ok(UT.clean({ ...good, c: { ...good.c, panel: '#ABCDEF' } }).c.panel === '#abcdef', 'colours are lower-cased');
}

// 2. toTheme()
{
  const { UT } = makeEnv({ default: { ui: { panelBg: '#ffffff' } } });
  const MAP_KEYS = ['bg', 'landcover', 'landuse', 'water', 'building', 'road', 'roadLabel', 'roadHalo',
    'placeLabel', 'placeHalo', 'poiLabel', 'poiHalo', 'poiIcon'];
  const UI_HEX = ['panelBg', 'panelText', 'muted', 'hairline', 'hover', 'inputBg', 'accent', 'accentText',
    'accentBorder', 'accent2', 'danger'];
  for (const style of ['aurora', 'classic']) {
    for (const panel of ['#ffffff', '#f6f3ff', '#17133c', '#000000']) {
      const u = UT.clean({ ...good, style, c: { ...good.c, panel, text: UT.isDark(panel) ? '#eeeeee' : '#222222' } });
      const t = UT.toTheme(u);
      ok(t.user === true && t.style === style && t.label === 'Sunset', `toTheme flags (${style} ${panel})`);
      for (const k of MAP_KEYS) ok(HEX.test(t[k]), `map ${k} is hex (${style} ${panel}): ${t[k]}`);
      for (const k of UI_HEX) ok(HEX.test(t.ui[k]), `ui.${k} is hex (${style} ${panel}): ${t.ui[k]}`);
      ok(typeof t.ui.border === 'string' && typeof t.ui.shadow === 'string' && /px$/.test(t.ui.radius), `ui strings (${style} ${panel})`);
    }
  }
  // Accent text stays readable across the colour wheel.
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (h) => { const c = [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16)); return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); };
  const contrast = (x, y) => { const p = lum(x), q = lum(y); return (Math.max(p, q) + 0.05) / (Math.min(p, q) + 0.05); };
  let worst = 99;
  for (let i = 0; i < 4096; i += 37) {
    const accent = '#' + [i >> 8, (i >> 4) & 15, i & 15].map(v => (v * 17).toString(16).padStart(2, '0')).join('');
    const t = UT.toTheme(UT.clean({ ...good, c: { ...good.c, accent } }));
    worst = Math.min(worst, contrast(accent, t.ui.accentText));
  }
  ok(worst >= 4, `accent text contrast ≥ 4 for every accent (worst ${worst.toFixed(2)})`);
  // Built-in → 8 colours → theme keeps the key colours.
  const aurora = { landcover: '#dcf2e2', water: '#9fd8f6', road: '#ffffff', building: '#e4dcf6',
    ui: { panelBg: '#f6f3ff', panelText: '#2b2357', accent: '#7c5cff', accent2: '#e8358a' } };
  const back = UT.toTheme({ ...good, c: UT.fromTheme(aurora) });
  ok(back.landcover === '#dcf2e2' && back.ui.panelBg === '#f6f3ff' && back.ui.accent === '#7c5cff', 'fromTheme → toTheme keeps the key colours');
}

// 3. auroraTokens() covers the Aurora stylesheet's light token block.
{
  const { UT } = makeEnv({ default: { ui: { panelBg: '#ffffff' } } });
  const s = creatures.indexOf("s.id = 'creature-styles-aurora';");
  const blockStart = creatures.indexOf('@A {', s);
  const blockEnd = creatures.indexOf('\n      }', blockStart);
  const defined = [...creatures.slice(blockStart, blockEnd).matchAll(/--au-([a-z0-9-]+):/g)].map(m => m[1]);
  ok(defined.length > 30, `parsed the Aurora token block (${defined.length} tokens)`);
  for (const panel of ['#f6f3ff', '#0c0b16']) {
    const tok = UT.auroraTokens(UT.clean({ ...good, c: { ...good.c, panel } }));
    for (const k of defined) {
      if (k === 'font') continue;
      ok(k in tok, `auroraTokens defines --au-${k} (panel ${panel})`);
    }
    for (const [k, v] of Object.entries(tok)) {
      ok(typeof v === 'string' && !/undefined|NaN/.test(v), `token --au-${k} is clean (panel ${panel})`);
    }
  }
}

// 4. register / store / applyAttrs
{
  const env = makeEnv({ default: { ui: { panelBg: '#ffffff' } }, medieval: { ui: { panelBg: '#f2e3b6' } } });
  const { UT, window, localStorage, styles, attrs, document } = env;
  const classic = { ...good, id: 'u-test2', name: 'Flat', style: 'classic' };
  const saved = UT.store([good, classic, { junk: true }]);
  ok(saved.length === 2, 'store drops invalid entries');
  ok(window.THEMES['u-test1'] && window.THEMES['u-test2'] && window.THEMES.medieval, 'store registers themes, keeps built-ins');
  ok(JSON.parse(localStorage.getItem(UT.KEY)).length === 2, 'store persists to localStorage');
  const css = styles['cc-user-themes-css'].textContent;
  ok(css.includes('html[data-theme="u-test1"] #creatureInventory') && css.includes('--au-surface:'), 'aurora theme gets a token rule');
  ok(!css.includes('u-test2'), 'classic theme gets no token rule');
  ok(UT.load().length === 2, 'load reads them back');
  UT.store([classic]);
  ok(!window.THEMES['u-test1'] && window.THEMES['u-test2'], 'removing a theme unregisters it');
  UT.applyAttrs(document.documentElement, UT.toTheme(UT.clean(good)));
  ok(attrs['data-ui-style'] === 'aurora', 'aurora user theme sets data-ui-style');
  UT.applyAttrs(document.documentElement, UT.toTheme(UT.clean(classic)));
  ok(!('data-ui-style' in attrs), 'classic user theme clears data-ui-style');
  UT.applyAttrs(document.documentElement, { ui: {} });
  ok(!('data-ui-style' in attrs), 'built-in theme clears data-ui-style');
  ok(UT.newId() !== UT.newId() && /^u-[a-z0-9]+$/.test(UT.newId()), 'newId is unique + valid');
}

// 5. creatures.js wiring
ok(/\.replace\(\/@A\/g, '[^']*html\[data-ui-style="aurora"\][^']*'\)/.test(creatures), '@A matches html[data-ui-style="aurora"]');
ok(/\.replace\(\/@H\/g, '[^']*html\[data-ui-style="aurora"\][^']*'\)/.test(creatures), '@H matches html[data-ui-style="aurora"]');
ok(/function _isAuroraTheme[\s\S]{0,300}data-ui-style/.test(creatures), '_isAuroraTheme honours data-ui-style');
// index.html wiring
ok(src.includes("window.CCUserThemes.applyAttrs(r, t)"), 'boot script sets data-ui-style');
ok(src.includes("window.CCUserThemes.applyAttrs(document.documentElement, t)"), 'applyTheme sets data-ui-style');
ok(/userThemes: window\.CCUserThemes\.load\(\)/.test(src), 'saves carry userThemes');
ok(/Array\.isArray\(data\.userThemes\)/.test(src), 'loads merge userThemes');

console.log(`user-themes: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
