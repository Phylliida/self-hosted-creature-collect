// Tests for the encounter "Fresh Art" badge tier (openBattleScreen).
//
// The badge string is decided by decideArtBadge(variant), which — when we own
// the fusion (via SOME art) — picks between three tiers:
//   ''          we own THIS exact art (nothing new)
//   'Fresh Art' we've SEEN this art before but don't own it (e.g. evolved away)
//   'New Art'   we've never seen this art of a fusion we own
//
// decideArtBadge is a closure inside openBattleScreen, so it can't be extracted
// verbatim. What CAN be extracted are the real helpers it leans on
// (readSeenVariants, ownsVariant) and the real markFusionSeen, plus the ordering
// hazard the fix hinges on: markFusionSeen runs BEFORE decideArtBadge and records
// the current variant, so the "had we seen it coming in?" question must be
// answered from a snapshot taken BEFORE the mark. We reproduce that exact
// sequence here and assert the resulting tier.
//
// Run: node tests/fresh-art-badge.test.js
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

// ── fake world ──
let seen = {};
// captured-variant index per fusion key -> Set of owned variant keys.
let ownedVariants = {};   // e.g. { '1-4': new Set(['0']) }
const ctx = {
  Date: { now: () => 1000 },
  readSeenFusions: () => seen,
  writeSeenFusions: (m) => { seen = m; },
  // Minimal _capStore: returns a FRESH set each call (readSeenVariants mutates it).
  _capStore: {
    variantKeysForFusion: (a, b) => new Set(ownedVariants[`${a}-${b}`] || []),
  },
};
vm.createContext(ctx);
for (const m of ['function readSeenVariants', 'function ownsVariant', 'function markFusionSeen']) {
  vm.runInContext(extract(m), ctx);
}
const call = (name, ...args) => { ctx.__a = args; return vm.runInContext(`${name}(...__a)`, ctx); };

// Mirror of openBattleScreen's tier decision, run through the SAME sequence the
// real code does: snapshot seen-variants -> markFusionSeen (records current) ->
// decideArtBadge. Returns the badge string that would be shown.
function badgeForEncounter(a, b, variant) {
  const key = `${a}-${b}`;
  const ownsFusion = !!ownedVariants[key] && ownedVariants[key].size > 0;
  // snapshot BEFORE markFusionSeen (the crux of the fix)
  const seenVariantsBefore = call('readSeenVariants', a, b);
  const hadSeenVariant = (v) => {
    if (typeof v === 'number' && v >= 0) return seenVariantsBefore.has(String(v));
    return seenVariantsBefore.has('auto');
  };
  // the real code marks the fusion + current variant seen here
  call('markFusionSeen', a, b, { }, variant);
  // decideArtBadge:
  if (!ownsFusion) return ownsFusion; // (fusion-tier handled elsewhere; N/A here)
  if (call('ownsVariant', a, b, variant)) return '';
  if (hadSeenVariant(variant)) return 'Fresh Art';
  return 'New Art';
}

// ── A. own THIS art -> no badge ──
{
  seen = { '1-4': { variants: { '0': 500 } } };
  ownedVariants = { '1-4': new Set(['0']) };
  ok(badgeForEncounter(1, 4, 0) === '', 'A: owning this exact art shows no badge');
}

// ── B. own fusion (art 0), re-encounter a DIFFERENT art we've seen -> Fresh Art ──
{
  // We own art 0, and art 1 is in the dex (seen previously, e.g. caught then
  // evolved away) but not currently owned.
  seen = { '1-4': { variants: { '0': 500, '1': 600 } } };
  ownedVariants = { '1-4': new Set(['0']) };
  ok(badgeForEncounter(1, 4, 1) === 'Fresh Art', 'B: seen-but-unowned art shows Fresh Art');
}

// ── C. own fusion, encounter an art we've NEVER seen -> New Art ──
{
  seen = { '1-4': { variants: { '0': 500 } } };   // only art 0 ever seen
  ownedVariants = { '1-4': new Set(['0']) };
  const badge = badgeForEncounter(1, 4, 2);
  ok(badge === 'New Art', 'C: never-seen art of an owned fusion shows New Art');
  // regression: markFusionSeen just recorded art 2, but the pre-mark snapshot
  // means we still (correctly) called it New, not Fresh.
  ok(seen['1-4'].variants['2'] != null, 'C: markFusionSeen did record art 2 (snapshot beat it)');
}

// ── D. autogen art parity: 'auto'/null variant normalizes the same way ──
{
  seen = { '1-4': { variants: { '0': 500, 'auto': 700 } } };
  ownedVariants = { '1-4': new Set(['0']) };
  ok(badgeForEncounter(1, 4, null) === 'Fresh Art', 'D: seen autogen art (null) -> Fresh Art');
}
{
  seen = { '1-4': { variants: { '0': 500 } } };   // autogen never seen
  ownedVariants = { '1-4': new Set(['0']) };
  ok(badgeForEncounter(1, 4, null) === 'New Art', 'D: unseen autogen art (null) -> New Art');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
