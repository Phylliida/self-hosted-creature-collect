// Regression test: fractals2 ignores soft-keyboard viewport shrinks.
//
// In the extras "Fractals 2" tool the Save dialog focuses a text input, which
// pulls up the soft keyboard and shrinks the embedding iframe's height. That
// fired a window 'resize' -> viewer.resize(), re-deriving the backing and
// re-rendering the (possibly deep, slow) fractal — only to throw it away when
// the keyboard dismissed. onViewportResize() detects a keyboard-shaped shrink
// (coarse pointer, same width, shorter height) and pins the canvas box instead
// of resizing. This pins that behavior so a future edit can't reintroduce the
// wasteful rerender, while keeping genuine resizes (rotation, desktop drag)
// reflowing.
//
// Run: node tests/fractal2-keyboard-resize.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const src = fs.readFileSync(
  path.join(__dirname, '..', 'static', 'fractals2', 'src', 'main.js'), 'utf8');

// Slice the resize block (declarations + onViewportResize) out of main.js so the
// test exercises the real source, not a copy.
const startMarker = 'let stableVpW = window.innerWidth';
const endMarker = '\nwindow.addEventListener(\'resize\'';
const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker);
ok(start >= 0 && end > start, 'resize block located in main.js');
const block = src.slice(start, end);

// Build a fresh sandbox for a scenario. `coarse` toggles the soft-keyboard gate.
function makeCtx(coarse, w, h) {
  const calls = { resize: 0 };
  const canvas = { style: { height: '' } };
  const sandbox = {
    window: { innerWidth: w, innerHeight: h },
    matchMedia: (q) => ({ matches: coarse && /coarse/.test(q) }),
    canvas,
    viewer: { resize: () => { calls.resize++; } },
  };
  const ctx = vm.createContext(sandbox);
  // Prepend `resizeTimer` (declared earlier in main.js) and expose the fn out.
  vm.runInContext('let resizeTimer = 0;\n' + block + '\nthis.__fire = onViewportResize;', ctx);
  return { ctx, sandbox, calls, canvas };
}

// 1) Soft keyboard opens: coarse pointer, same width, shorter height.
{
  const t = makeCtx(true, 400, 900);
  t.sandbox.window.innerHeight = 500;          // keyboard up
  t.ctx.__fire();
  ok(t.calls.resize === 0, 'keyboard open does NOT call viewer.resize()');
  ok(t.canvas.style.height === '900px', 'keyboard open pins canvas to pre-keyboard height');
}

// 2) Keyboard dismisses: height returns to the stable value. The backing was
//    never touched while pinned, so closing drops the pin WITHOUT any resize.
{
  const t = makeCtx(true, 400, 900);
  t.sandbox.window.innerHeight = 500; t.ctx.__fire();   // open (pinned)
  t.sandbox.window.innerHeight = 900; t.ctx.__fire();   // close
  ok(t.calls.resize === 0, 'keyboard close does NOT re-render (never resized while pinned)');
  ok(t.canvas.style.height === '', 'keyboard close drops the height pin');
}

// 3) Desktop (fine pointer) vertical-only shrink still reflows.
{
  const t = makeCtx(false, 1200, 900);
  t.sandbox.window.innerHeight = 700; t.ctx.__fire();
  ok(t.calls.resize === 1, 'fine-pointer height shrink DOES resize (no keyboard there)');
  ok(t.canvas.style.height === '', 'fine-pointer shrink leaves the box unpinned');
}

// 4) A width change (rotation) is a genuine resize even on a coarse pointer.
{
  const t = makeCtx(true, 400, 900);
  t.sandbox.window.innerWidth = 900; t.sandbox.window.innerHeight = 400; t.ctx.__fire();
  ok(t.calls.resize === 1, 'rotation (width change) resizes despite coarse pointer');
  ok(t.canvas.style.height === '', 'rotation leaves the box unpinned');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
