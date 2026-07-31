// Headless tests for the draw app's BY-REFERENCE transform copies (fold / spin)
// — static/draw/src/scene.js geometry, bbox, hit-test, cycle safety and SVG
// export. Run: node tests/draw-fold-spin.test.mjs

import {
  Scene, makeRect, makeLine, makeFold, makeSpin,
  foldMatrix, spinMatrix, applyAffine, spinCopyCount, refSources,
  itemBBox, hitTest, translateItem, scaleItemAbout, rotateItemsAbout,
  reflectItemsAbout, shiftItem,
} from '../static/draw/src/scene.js';
import { sceneToSVG } from '../static/draw/src/svg.js';

let failed = 0, passed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL: ' + msg); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---- foldMatrix: reflection across a vertical line x = 10 ----
{
  const f = makeFold([], { x: 10, y: -5 }, { x: 10, y: 25 });
  const m = foldMatrix(f);
  const p = applyAffine(m, 4, 7);
  ok(near(p.x, 16) && near(p.y, 7), 'foldMatrix reflects x across vertical line');
  const q = applyAffine(m, p.x, p.y);
  ok(near(q.x, 4) && near(q.y, 7), 'foldMatrix is self-inverse');
}

// ---- foldMatrix: reflection across the diagonal y = x ----
{
  const f = makeFold([], { x: 0, y: 0 }, { x: 10, y: 10 });
  const p = applyAffine(foldMatrix(f), 3, 8);
  ok(near(p.x, 8) && near(p.y, 3), 'foldMatrix swaps x/y across y=x');
}

// ---- spinMatrix: rotation about a pivot ----
{
  const s = makeSpin([], 5, 5, Math.PI / 2, 3);
  const p = applyAffine(spinMatrix(s, 1), 8, 5);   // 90° about (5,5)
  ok(near(p.x, 5) && near(p.y, 8), 'spinMatrix rotates 90° about the pivot');
  const p2 = applyAffine(spinMatrix(s, 2), 8, 5);  // k=2 → 180°
  ok(near(p2.x, 2) && near(p2.y, 5), 'spinMatrix k=2 doubles the angle');
}

// ---- fold itemBBox includes the mirrored copy (via resolver) ----
{
  const scene = new Scene();
  const r = scene.add(makeRect(2, 2, 4, 4, { color: '#fff', width: 0 }));
  const f = scene.add(makeFold([r.id], { x: 10, y: -5 }, { x: 10, y: 25 }));
  const b = itemBBox(f, id => scene.byId(id));
  // copy of rect [2..6]² across x=10 lands at [14..18]; bbox also covers the line
  ok(b.minX <= 10 && b.maxX >= 18 && b.minY <= 2 && b.maxY >= 6,
     `fold bbox covers line + mirrored copy (got ${JSON.stringify(b)})`);
  ok(!itemBBox(f).maxX || itemBBox(f).maxX < 14, 'fold bbox without resolver falls back to the line');
}

// ---- spin rosette bbox covers all copies (the original renders itself) ----
{
  const scene = new Scene();
  const r = scene.add(makeRect(8, -1, 4, 2, { color: '#fff', width: 0 })); // arm at +x
  const s = scene.add(makeSpin([r.id], 0, 0, Math.PI / 2, 3));
  const b = itemBBox(s, id => scene.byId(id));
  // copies: 90° → y 8..12, 180° → x −12..−8, 270° → y −12..−8; pivot (0,0) included
  ok(b.minX <= -12 + 1e-6 && b.maxX >= 0 && b.minY <= -12 + 1e-6 && b.maxY >= 12 - 1e-6,
     `spin bbox covers every rotated copy (got ${JSON.stringify(b)})`);
  ok(b.maxX < 8, 'spin bbox does not claim the original (it hit-tests itself)');
  const sb = scene.bounds();
  ok(sb.maxX >= 12 - 1e-6, 'scene bounds still cover the original via its own item');
}

// ---- hitTest: a click on a copy selects the fold/spin, not the source space ----
{
  const scene = new Scene();
  const r = scene.add(makeRect(2, 2, 4, 4, { color: '#fff', width: 1, fill: '#fff' }));
  const f = scene.add(makeFold([r.id], { x: 10, y: -5 }, { x: 10, y: 25 }));
  const byId = id => scene.byId(id);
  ok(hitTest(f, 16, 4, 0.1, byId), 'fold hit-tests its mirrored copy');
  ok(!hitTest(f, 4, 4, 0.1, byId), 'fold does not hit on the source (the source itself does)');
  ok(hitTest(f, 10, 20, 0.1, byId), 'fold line itself is grabbable');
  const s = makeSpin([r.id], 0, 0, Math.PI, 1);   // 180° about origin → copy at [-6..-2]²
  ok(hitTest(s, -4, -4, 0.1, byId), 'spin hit-tests its rotated copy');
  ok(hitTest(s, 0.05, 0, 0.1, byId), 'spin pivot is grabbable');
}

// ---- Scene.pick integration: pick on the mirrored copy returns the fold ----
{
  const scene = new Scene();
  const r = scene.add(makeRect(2, 2, 4, 4, { color: '#fff', width: 1, fill: '#fff' }));
  const f = scene.add(makeFold([r.id], { x: 10, y: -5 }, { x: 10, y: 25 }));
  ok(scene.pick(16, 4, 0.2)?.id === f.id, 'pick on the mirrored copy returns the fold');
  ok(scene.pick(4, 4, 0.2)?.id === r.id, 'pick on the original returns the source');
  // dangling source: fold degrades to its line, still grabbable, nothing explodes
  scene.remove(r.id);
  ok(scene.pick(16, 4, 0.2) === null, 'dangling fold does not hit ghost copies');
  ok(scene.pick(10, 20, 0.2)?.id === f.id, 'dangling fold still grabs on its line');
}

// ---- cycle safety: fold A ↔ fold B must terminate everywhere ----
{
  const scene = new Scene();
  const r = scene.add(makeRect(0, 0, 2, 2, { color: '#fff', width: 0 }));
  const A = scene.add(makeFold([r.id], { x: 10, y: 0 }, { x: 10, y: 10 }));
  const B = scene.add(makeFold([r.id, A.id], { x: 20, y: 0 }, { x: 20, y: 10 }));
  A.ids.push(B.id);   // hand-forged cycle
  const byId = id => scene.byId(id);
  const b = itemBBox(B, byId);
  ok(isFinite(b.minX) && isFinite(b.maxX), 'cyclic fold bbox terminates and stays finite');
  ok(hitTest(B, 18, 1, 0.5, byId) === true || hitTest(B, 18, 1, 0.5, byId) === false,
     'cyclic fold hit-test terminates');
  ok(scene.bounds() !== null, 'scene.bounds() survives a reference cycle');
  ok(refSources(A, byId, [B.id]).every(s => s.id !== B.id), 'refSources prunes stacked ids');
}

// ---- transforms move the guide (and thus the copies), not the sources ----
{
  const f = makeFold([], { x: 0, y: 0 }, { x: 4, y: 0 });
  translateItem(f, 1, 2);
  ok(f.ax === 1 && f.ay === 2 && f.bx === 5 && f.by === 2, 'translateItem moves the fold line');
  scaleItemAbout(f, 0, 0, 2);
  ok(f.ax === 2 && f.bx === 10, 'scaleItemAbout scales the fold line');
  const s = makeSpin([], 3, 4, 0.5, 2);
  rotateItemsAbout([s], 0, 0, Math.PI / 2);
  ok(near(s.cx, -4) && near(s.cy, 3) && near(s.angle, 0.5), 'rotateItemsAbout swings the pivot, keeps the angle');
  reflectItemsAbout([s], 0, 0, 0);   // mirror across the x-axis
  ok(near(s.cy, -3) && near(s.angle, -0.5), 'reflectItemsAbout mirrors the pivot and flips chirality');
  shiftItem(s, 1, 1);
  ok(near(s.cx, -3) && near(s.cy, -2), 'shiftItem moves the spin pivot');
}

// ---- spinCopyCount clamp ----
{
  ok(spinCopyCount(makeSpin([], 0, 0, 1, 3)) === 3, 'spinCopyCount passes through a sane count');
  ok(spinCopyCount(makeSpin([], 0, 0, 1, 99999)) === 720, 'spinCopyCount clamps absurd counts');
  ok(spinCopyCount(makeSpin([], 0, 0, 1, -4)) === 0, 'spinCopyCount floors at zero');
}

// ---- SVG export: copies are transform groups, cycle-safe, guides omitted ----
{
  const scene = new Scene();
  const r = scene.add(makeRect(2, 2, 4, 4, { color: '#ff0000', width: 1 }));
  scene.add(makeFold([r.id], { x: 10, y: -5 }, { x: 10, y: 25 }));
  scene.add(makeSpin([r.id], 0, 0, Math.PI / 2, 3));
  const svg = sceneToSVG(scene);
  const groups = (svg.match(/<g transform="matrix\(/g) || []).length;
  ok(groups === 4, `SVG export emits 1 fold + 3 spin copy groups (got ${groups})`);
  ok(svg.includes('<rect'), 'SVG export still emits the source rect');
  const A = makeFold([], { x: 0, y: 0 }, { x: 1, y: 1 });
  const B = makeFold([A.id], { x: 2, y: 2 }, { x: 3, y: 3 });
  A.ids.push(B.id);
  scene.add(A); scene.add(B);
  ok(typeof sceneToSVG(scene) === 'string', 'SVG export survives a fold cycle');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
