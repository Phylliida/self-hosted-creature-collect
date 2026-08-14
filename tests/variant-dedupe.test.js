// Tests _dedupeVariantCards (static/creatures.js): display-only dedupe
// of content-identical variant cards. Upstream ships a few byte-identical
// sheets per head (e.g. IF1's 133p == 133k); the pack keeps both slots so
// stored variant indices keep rendering, but the fusion detail grid must
// not show two identical cards with identical credits.
//
// Run: node tests/variant-dedupe.test.js
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

const ctx = {};
vm.createContext(ctx);
vm.runInContext(extract('async function _dedupeVariantCards'), ctx);

// hasSeenVariantOrDupe deps: the seen store + a Sprites stub whose
// blobs carry known content. Slots 11 and 16 share content 'DUPE'.
let seenFusions = {};
const DUPE = 'DUPE-CONTENT';
ctx.global = {
  Sprites: {
    getSpriteBlobAttempt: async (a, b, slot) => {
      if (slot === 11 || slot === 16) return { status: 'ok', blob: new Blob([DUPE]) };
      if (slot === 7) return { status: 'ok', blob: new Blob(['OTHER']) };
      return { status: 'missing', blob: null };
    },
  },
};
ctx.readSeenFusions = () => seenFusions;
ctx._capStore = {
  variantKeysForFusion: (a, b) => {
    const e = seenFusions[`${a}-${b}`];
    const out = new Set();
    if (e && e.caughtVariant != null) out.add(String(e.caughtVariant));
    return out;
  },
};
ctx.crypto = require('crypto').webcrypto;
ctx._cellHashCache = new Map();
for (const m of ['function readSeenVariants', 'function hasSeenVariant',
                 'async function _cellContentHash',
                 'async function _variantDupeOfAny',
                 'async function hasSeenVariantOrDupe']) {
  vm.runInContext(extract(m), ctx);
}

function card(variant, selectable, label) {
  return {
    cls: 'variant-cell' + (selectable ? '' : ' silhouette'),
    variant, label: label || ('v' + variant), selectable: !!selectable,
  };
}

(async () => {
  // hash map: slots 1 and 3 share content 'X', slot 2 is 'Y', 4 unreadable.
  const hashes = { 0: 'A', 1: 'X', 2: 'Y', 3: 'X' };
  const hashForSlot = async (s) => (s === 4 ? null : hashes[s]);

  // 1. Identical contents collapse to one card, keeping the first.
  let out = await ctx._dedupeVariantCards(
    [card(0, true), card(1, true), card(2, true), card(3, true)], hashForSlot);
  ok(out.length === 3 && out[1].variant === 1 && out[2].variant === 2,
    '1: dupe slot dropped, first kept (got ' + out.map((c) => c.variant) + ')');

  // 2. An unseen first card yields position to the SEEN duplicate.
  out = await ctx._dedupeVariantCards(
    [card(1, false), card(3, true, 'Artist')], hashForSlot);
  ok(out.length === 1 && out[0].variant === 3 && out[0].label === 'Artist'
    && out[0].selectable === true,
    '2: seen dupe replaces the unseen silhouette (got ' + JSON.stringify(out) + ')');

  // 3. Both unseen → first kept (order stable).
  out = await ctx._dedupeVariantCards(
    [card(1, false), card(3, false)], hashForSlot);
  ok(out.length === 1 && out[0].variant === 1, '3: both unseen → first kept');

  // 4. Unreadable blob (hash null) is kept, never merged.
  out = await ctx._dedupeVariantCards(
    [card(1, true), card(4, true)], hashForSlot);
  ok(out.length === 2, '4: unreadable card kept');

  // 5. Autogen card (variant null) never participates in dedupe.
  out = await ctx._dedupeVariantCards(
    [{ cls: 'variant-cell autogen', variant: null, label: 'autogen', selectable: true },
     card(1, true), card(3, true)], hashForSlot);
  ok(out.length === 2 && out[0].variant === null, '5: autogen card untouched');

  // ── hasSeenVariantOrDupe (evolution preview silhouettes) ─────────
  // Trainer saw slot 11; the evolution resolves slot 16 (identical
  // sheet content) → must count as seen, no black silhouette.
  seenFusions = { '1-2': { variants: { '11': 1 } } };
  ok(await ctx.hasSeenVariantOrDupe(1, 2, 16) === true,
    '6: dupe of a seen slot counts as seen');
  // Same slot directly seen → true without content checks.
  ok(await ctx.hasSeenVariantOrDupe(1, 2, 11) === true,
    '7: exact seen slot counts as seen');
  // Different content (slot 7) and not seen → silhouette stays.
  ok(await ctx.hasSeenVariantOrDupe(1, 2, 7) === false,
    '8: unseen, non-dupe slot stays silhouetted');
  // Nothing seen at all → false.
  ok(await ctx.hasSeenVariantOrDupe(1, 2, 3) === false,
    '9: no seen variants → false');
  // Autogen variant ('auto') is never dupe-resolved.
  seenFusions = { '1-2': { variants: { auto: 1 } } };
  ok(await ctx.hasSeenVariantOrDupe(1, 2, 'auto') === true
    && await ctx.hasSeenVariantOrDupe(1, 2, 16) === false,
    '10: autogen seen-state unaffected by dupe logic');

  console.log(`variant-dedupe: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
