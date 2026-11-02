// Community Day pass log + report (static/creatures.js):
//   - activateCommunityPass logs each pass as the hour it covers (a fresh
//     session's first hour; an extension's added hour).
//   - _communityLogCatch files a catch under the pass whose hour holds it;
//     a running session with no record gets one made from its state; a
//     catch just after the end joins the last pass.
//   - mergeCommunityLog (save import) unions passes by start, catches by id.
//   - renderCommunity / renderCommunityPass list this week's passes (used,
//     unused, untracked) and earlier weeks, with the catch totals.
//
// Run: node tests/community-log.test.js
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

const HOUR = 3600000, WEEK_KEY = 2966, SPECIES = 114;
const T0 = Date.UTC(2026, 10, 10, 15, 0, 0);
function makeCtx() {
  const store = new Map();
  const ctx = {
    Object, Array, Math, String, Number, JSON, Map, Set, Date, Promise,
    console,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    COMMUNITY_PASS_DURATION_MS: HOUR,
    COMMUNITY_WEEKLY_PASSES: 2,
    errors: [],
    _logCreatureError: (where, e) => ctx.errors.push(where + ': ' + (e && e.message)),
    cdState: { weekKey: WEEK_KEY, count: 2, active: null },
    nowMs: T0,
    global: {
      Spawns: {
        communityDayInfo: (now) => ({ weekKey: now < T0 - 3 * 86400000 ? WEEK_KEY - 2 : WEEK_KEY, speciesId: SPECIES, weekEndMs: T0 + 4 * 86400000 }),
      },
    },
    noteStat: () => {},
    _hardRefreshSpawns: () => {},
    _scheduleCommunityExpiry: () => {},
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    _communitySpeciesName: (id) => (id === SPECIES ? 'Tangela' : 'Species ' + id),
    _fmtExpiryDh: (ms) => Math.round(ms / 60000) + 'm',
    pushed: [],
    pushView: (f) => ctx.pushed.push(f),
    pokes: [],
    _sessionPokesInto: (el, panel, list) => ctx.pokes.push(list.length),
  };
  ctx.readCommunityDay = () => {
    const s = ctx.cdState;
    if (s.active && ctx.nowMs >= s.active.endMs) s.active = null;
    return s;
  };
  ctx._writeCommunityRaw = (s) => { ctx.cdState = s; };
  ctx.store = store;
  vm.createContext(ctx);
  // Date.now inside the sandbox follows ctx.nowMs.
  vm.runInContext('Date = class extends Date { static now() { return nowMs; } };', ctx);
  for (const m of ['const COMMUNITY_LOG_KEY', 'const COMMUNITY_LOG_MAX']) {
    const start = src.indexOf(m);
    vm.runInContext(src.slice(start, src.indexOf('\n', start)).replace(/^const /, 'var '), ctx);
  }
  for (const m of [
    'function _communityLogRead(', 'function _communityLogWrite(', 'function _communityLogAddPass(',
    'function _communityPassFor(', 'function _communityLogCatch(', 'function mergeCommunityLog(',
    'function activateCommunityPass(', 'function _communityCatchSummary(', 'function _communityTimeRange(',
    'function _communityDate(', 'function _communityLauncherVisible(', 'function renderCommunity(',
    'function renderCommunityPass(',
  ]) vm.runInContext(extract(m), ctx);
  return ctx;
}
const run = (ctx, expr) => vm.runInContext(expr, ctx);
const log = (ctx) => run(ctx, '_communityLogRead()');
let n = 0;
const catchAt = (ctx, t, extra = {}) => {
  ctx.__e = Object.assign({ id: 'c' + (++n), speciesA: SPECIES, speciesB: 7, variant: 'auto', shinyVariant: null,
    level: 5, caughtAt: { timestamp: t }, communitySpecies: SPECIES }, extra);
  ctx.nowMs = t;
  run(ctx, '_communityLogCatch(__e, __e.fresh)');
};

// ── 1. Passes: a fresh session's hour, then the extension's hour ─────────
{
  const ctx = makeCtx();
  ok(run(ctx, 'activateCommunityPass()') === true, '1: first pass activates');
  ctx.nowMs = T0 + 20 * 60000;
  ok(run(ctx, 'activateCommunityPass()') === true, '1: second pass extends');
  const L = log(ctx);
  ok(L.passes.length === 2, '1: two passes logged (' + L.passes.length + ')');
  ok(L.passes[0].startMs === T0 && L.passes[0].endMs === T0 + HOUR, '1: pass 1 is the first hour');
  ok(L.passes[1].startMs === T0 + HOUR && L.passes[1].endMs === T0 + 2 * HOUR, '1: pass 2 is the added hour');
  ok(L.passes.every((p) => p.weekKey === WEEK_KEY && p.speciesId === SPECIES), '1: week + species recorded');
  ok(run(ctx, 'activateCommunityPass()') === false, '1: no passes left');

  // Catches go to the pass whose hour holds them.
  catchAt(ctx, T0 + 10 * 60000, { fresh: 'New' });
  catchAt(ctx, T0 + 50 * 60000, { fresh: '', shinyVariant: 3 });
  catchAt(ctx, T0 + 70 * 60000, { fresh: 'Fresh' });
  const L2 = log(ctx);
  ok(L2.passes[0].catches.length === 2 && L2.passes[1].catches.length === 1, '1: catches split by hour');
  ok(L2.passes[0].catches[1].shiny === true && L2.passes[0].catches[0].fresh === 'New', '1: shiny + label kept');
  // Just after the session ended (encounter opened during it).
  catchAt(ctx, T0 + 2 * HOUR + 5 * 60000);
  ok(log(ctx).passes[1].catches.length === 2, '1: a catch just after the end joins the last pass');
  // Long after: not filed anywhere.
  catchAt(ctx, T0 + 5 * HOUR);
  ok(log(ctx).passes.reduce((a, p) => a + p.catches.length, 0) === 4, '1: a catch hours later is not filed');
  ok(ctx.errors.length === 0, '1: no errors (' + ctx.errors.join('; ') + ')');
}

// ── 2. A running session with no record gets one from its state ──────────
{
  const ctx = makeCtx();
  ctx.cdState = { weekKey: WEEK_KEY, count: 0, active: { speciesId: SPECIES, startMs: T0, endMs: T0 + 2 * HOUR } };
  catchAt(ctx, T0 + 30 * 60000);
  let L = log(ctx);
  ok(L.passes.length === 1 && L.passes[0].startMs === T0 && L.passes[0].endMs === T0 + 2 * HOUR,
    '2: a synthesized pass spans the session');
  ok(L.passes[0].catches.length === 1, '2: and holds the catch');
  // A session whose first hour is logged but whose extension came from a save.
  const ctx2 = makeCtx();
  run(ctx2, 'activateCommunityPass()');
  ctx2.cdState.active.endMs = T0 + 2 * HOUR;   // extended on another device
  catchAt(ctx2, T0 + 90 * 60000);
  L = log(ctx2);
  ok(L.passes.length === 2 && L.passes[1].startMs === T0 + HOUR && L.passes[1].endMs === T0 + 2 * HOUR,
    '2: the missing hour starts where the logged one ends');
}

// ── 3. Merge: union passes by start, catches by id; idempotent ──────────
{
  const a = makeCtx();
  run(a, 'activateCommunityPass()');
  catchAt(a, T0 + 60000);
  const b = makeCtx();
  run(b, 'activateCommunityPass()');
  catchAt(b, T0 + 120000);
  b.nowMs = T0 + 5 * HOUR;
  b.cdState.active = null;
  // b also has an earlier week's pass.
  b.__p = { weekKey: WEEK_KEY - 2, speciesId: 25, startMs: T0 - 14 * 86400000, endMs: T0 - 14 * 86400000 + HOUR,
    catches: [{ id: 'old1', speciesA: 25, speciesB: 1, fresh: 'New', atMs: T0 - 14 * 86400000 + 1000 }] };
  run(b, 'mergeCommunityLog({ passes: [__p] })');
  a.__inc = log(b);
  run(a, 'mergeCommunityLog(__inc)');
  run(a, 'mergeCommunityLog(__inc)');
  const L = log(a);
  ok(L.passes.length === 2, '3: passes unioned by start (' + L.passes.length + ')');
  const cur = L.passes.find((p) => p.startMs === T0);
  ok(cur && cur.catches.length === 2, '3: catches unioned by id, no duplicates on re-import');
  ok(L.passes[0].startMs < L.passes[1].startMs, '3: sorted by start');
  run(a, 'mergeCommunityLog({ passes: [null, { startMs: "x" }, { startMs: 1, endMs: 2 }] })');
  ok(log(a).passes.length === 2, '3: malformed passes ignored');
}

// ── 4. Report HTML ──────────────────────────────────────────────────────
function fakePanel(ctx) {
  const els = {};
  const body = (cls) => (els[cls] = els[cls] || { innerHTML: '', querySelectorAll: () => [], querySelector: () => null });
  ctx.document = { getElementById: () => ({ querySelector: (q) => body(q) }) };
  return els;
}
{
  const ctx = makeCtx();
  const els = fakePanel(ctx);
  run(ctx, 'activateCommunityPass()');
  catchAt(ctx, T0 + 60000, { fresh: 'New' });
  catchAt(ctx, T0 + 120000, { fresh: 'New', shinyVariant: 1 });
  catchAt(ctx, T0 + 180000, { fresh: '' });
  ctx.nowMs = T0 + 2 * HOUR;
  run(ctx, 'renderCommunity()');
  const h = els['.community-body'].innerHTML;
  ok(/<b>Tangela<\/b> Community Day/.test(h), '4: names this week\'s species');
  ok(h.includes('This week\'s passes') || h.includes('This week&#39;s passes'), '4: this week\'s passes section');
  ok((h.match(/community-pass-row/g) || []).length === 1, '4: one used pass row');
  ok(h.includes('3 pokémon · 2 new · 1 shiny'), '4: pass summary');
  ok(h.includes('Not used yet'), '4: the unused pass is listed');
  ok(!h.includes('Earlier weeks'), '4: no earlier weeks yet');
  // Untracked: passes used before the log existed.
  ctx.cdState.count = 0;
  run(ctx, 'renderCommunity()');
  ok(els['.community-body'].innerHTML.includes('Used before passes were recorded'), '4: untracked pass shown');
  // Earlier week.
  ctx.__p = { weekKey: WEEK_KEY - 2, speciesId: 25, startMs: T0 - 14 * 86400000, endMs: T0 - 14 * 86400000 + HOUR,
    catches: [{ id: 'old1', speciesA: 25, speciesB: 1, fresh: 'Fresh', atMs: T0 - 14 * 86400000 + 1000 }] };
  run(ctx, 'mergeCommunityLog({ passes: [__p] })');
  run(ctx, 'renderCommunity()');
  const h2 = els['.community-body'].innerHTML;
  ok(h2.includes('Earlier weeks') && h2.includes('Species 25 week') && h2.includes('1 pokémon · 1 fresh'),
    '4: earlier week with its totals');
  // Pass report.
  run(ctx, `renderCommunityPass({ startMs: ${T0} })`);
  const r = els['.communitypass-body'].innerHTML;
  ok(/<b>3<\/b><span>caught/.test(r) && /<b>2<\/b><span>new/.test(r) && /<b>1<\/b><span>shiny/.test(r),
    '4: pass report totals');
  ok(r.includes('3 pokémon') && ctx.pokes[ctx.pokes.length - 1] === 3, '4: pass report pokémon section + grid');
  run(ctx, 'renderCommunityPass({ startMs: 1 })');
  ok(els['.communitypass-body'].innerHTML.includes('no longer in your history'), '4: unknown pass handled');
  // Off week with no history: launcher hidden; with history: shown.
  const off = makeCtx();
  off.global.Spawns.communityDayInfo = () => ({ weekKey: WEEK_KEY + 1, speciesId: null, weekEndMs: T0 + 86400000 });
  ok(run(off, '_communityLauncherVisible()') === false, '4: off week, no history ⇒ no launcher');
  off.__p = ctx.__p;
  run(off, 'mergeCommunityLog({ passes: [__p] })');
  ok(run(off, '_communityLauncherVisible()') === true, '4: off week with history ⇒ launcher');
  const offEls = fakePanel(off);
  run(off, 'renderCommunity()');
  ok(offEls['.community-body'].innerHTML.includes('No community day this week'), '4: off-week heading');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
