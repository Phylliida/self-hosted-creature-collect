import { polygonVertices, rotCenter, ROTATABLE } from './scene.js';
import { ribbonOutline, catmullRom } from './util.js';

// Serialize the whole document to a standalone SVG string. World coordinates
// map 1:1 to SVG user units (both are y-down), so the export is resolution
// independent — the vector analogue of the infinite canvas.

const escAttr = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ptsAttr(points) {
  return points.map(p => `${round(p.x)},${round(p.y)}`).join(' ');
}
const round = n => (Math.abs(n) < 1e-4 ? 0 : +n.toFixed(4));

function arrowHead(a, b, width) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const head = Math.min(len * 0.4, Math.max(width * 3.5, len * 0.12));
  return {
    head,
    shaftEnd: { x: b.x - Math.cos(ang) * head * 0.8, y: b.y - Math.sin(ang) * head * 0.8 },
    tri: [b,
      { x: b.x - Math.cos(ang - 0.5) * head, y: b.y - Math.sin(ang - 0.5) * head },
      { x: b.x - Math.cos(ang + 0.5) * head, y: b.y - Math.sin(ang + 0.5) * head }],
  };
}

// Unrotated, local fill bbox of a fillable item (rotation is applied by the
// wrapping <g transform=rotate>, which also rotates the userSpaceOnUse gradient).
function fillBBoxLocal(it) {
  if (it.type === 'rect' || it.type === 'ellipse') {
    const x = Math.min(it.x, it.x + it.w), y = Math.min(it.y, it.y + it.h);
    const w = Math.abs(it.w), h = Math.abs(it.h);
    return { cx: x + w / 2, cy: y + h / 2, hw: w / 2, hh: h / 2 };
  }
  const pts = it.type === 'polygon' ? polygonVertices(it) : it.type === 'stroke' ? it.points : null;
  if (!pts || !pts.length) return null;
  let nx = Infinity, ny = Infinity, xx = -Infinity, xy = -Infinity;
  for (const p of pts) { if (p.x < nx) nx = p.x; if (p.y < ny) ny = p.y; if (p.x > xx) xx = p.x; if (p.y > xy) xy = p.y; }
  return { cx: (nx + xx) / 2, cy: (ny + xy) / 2, hw: (xx - nx) / 2, hh: (xy - ny) / 2 };
}

// Resolve a fill (string | gradient-object | null) to an SVG fill value, pushing
// any gradient <defs> into `defs`. Conic gradients have no portable SVG analogue,
// so they fall back to their first stop colour.
function resolveFillSVG(it, defs) {
  const f = it.fill;
  if (!f) return 'none';
  if (typeof f === 'string') return escAttr(f);
  const stops = (f.stops && f.stops.length >= 2) ? f.stops : [{ t: 0, color: '#000' }, { t: 1, color: '#fff' }];
  const bb = fillBBoxLocal(it);
  if (!bb || f.type === 'conic') return escAttr(stops[0].color);
  const id = 'g-' + it.id;
  const stopStr = stops.map(s =>
    `<stop offset="${round(Math.min(1, Math.max(0, s.t)) * 100)}%" stop-color="${escAttr(s.color)}"/>`).join('');
  if (f.type === 'radial') {
    const r = Math.hypot(bb.hw, bb.hh);
    defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${round(bb.cx)}" cy="${round(bb.cy)}" r="${round(r)}">${stopStr}</radialGradient>`);
  } else {
    const a = f.angle || 0, dx = Math.cos(a), dy = Math.sin(a);
    const ext = Math.abs(bb.hw * dx) + Math.abs(bb.hh * dy) || Math.max(bb.hw, bb.hh);
    defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${round(bb.cx - dx * ext)}" y1="${round(bb.cy - dy * ext)}" x2="${round(bb.cx + dx * ext)}" y2="${round(bb.cy + dy * ext)}">${stopStr}</linearGradient>`);
  }
  return `url(#${id})`;
}

function itemToSVG(it, defs) {
  const stroke = `stroke="${escAttr(it.color)}" stroke-width="${round(it.width || 1)}" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  switch (it.type) {
    case 'stroke': {
      if (it.taper) {
        // variable-width brush stroke → a single filled ribbon polygon
        const half = (it.width || 1) / 2;
        if (it.points.length === 1) {
          return `<circle cx="${round(it.points[0].x)}" cy="${round(it.points[0].y)}" r="${round(half)}" fill="${escAttr(it.color)}"/>`;
        }
        // mirror the on-canvas Catmull-Rom smoothing so the export matches
        const pts = (it.smooth && it.points.length >= 3) ? catmullRom(it.points, 16) : it.points;
        const outline = ribbonOutline(pts, i => Math.max(1e-4, half * (pts[i].p == null ? 1 : pts[i].p)));
        return `<polygon points="${ptsAttr(outline)}" fill="${escAttr(it.color)}"/>`;
      }
      return `<polyline points="${ptsAttr(it.points)}" ${stroke}/>`;
    }
    case 'line':
      return `<polyline points="${ptsAttr(it.points)}" ${stroke}/>`;
    case 'arrow': {
      const [a, b] = it.points;
      const h = arrowHead(a, b, it.width || 1);
      return `<polyline points="${ptsAttr([a, h.shaftEnd])}" ${stroke}/>` +
             `<polygon points="${ptsAttr(h.tri)}" fill="${escAttr(it.color)}"/>`;
    }
    case 'connector': {
      const a = { x: it.ax, y: it.ay }, b = { x: it.bx, y: it.by };
      if (it.arrow === false) return `<polyline points="${ptsAttr([a, b])}" ${stroke}/>`;
      const h = arrowHead(a, b, it.width || 1);
      return `<polyline points="${ptsAttr([a, h.shaftEnd])}" ${stroke}/>` +
             `<polygon points="${ptsAttr(h.tri)}" fill="${escAttr(it.color)}"/>`;
    }
    case 'rect': {
      const x = Math.min(it.x, it.x + it.w), y = Math.min(it.y, it.y + it.h);
      const fill = resolveFillSVG(it, defs);
      return `<rect x="${round(x)}" y="${round(y)}" width="${round(Math.abs(it.w))}" height="${round(Math.abs(it.h))}" fill="${fill}" stroke="${escAttr(it.color)}" stroke-width="${round(it.width || 1)}"/>`;
    }
    case 'ellipse': {
      const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
      const fill = resolveFillSVG(it, defs);
      return `<ellipse cx="${round(cx)}" cy="${round(cy)}" rx="${round(Math.abs(it.w / 2))}" ry="${round(Math.abs(it.h / 2))}" fill="${fill}" stroke="${escAttr(it.color)}" stroke-width="${round(it.width || 1)}"/>`;
    }
    case 'polygon': {
      const fill = resolveFillSVG(it, defs);
      return `<polygon points="${ptsAttr(polygonVertices(it))}" fill="${fill}" stroke="${escAttr(it.color)}" stroke-width="${round(it.width || 1)}"/>`;
    }
    case 'image': {
      const x = Math.min(it.x, it.x + it.w), y = Math.min(it.y, it.y + it.h);
      const op = (it.opacity != null && it.opacity < 1) ? ` opacity="${round(it.opacity)}"` : '';
      return `<image href="${escAttr(it.src)}" x="${round(x)}" y="${round(y)}" width="${round(Math.abs(it.w))}" height="${round(Math.abs(it.h))}" preserveAspectRatio="none"${op}/>`;
    }
    case 'text': {
      const lines = String(it.text).split('\n');
      const tspans = lines.map((l, i) =>
        `<tspan x="${round(it.x)}" dy="${i === 0 ? round(it.size) : round(it.size * 1.1)}">${escAttr(l)}</tspan>`).join('');
      return `<text x="${round(it.x)}" y="${round(it.y)}" fill="${escAttr(it.color)}" font-size="${round(it.size)}" font-family="sans-serif">${tspans}</text>`;
    }
  }
  return '';
}

export function sceneToSVG(scene, { pad = 0.06, background = '#0e0f13' } = {}) {
  const b = scene.bounds() || { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  const w = Math.max(b.maxX - b.minX, 1), h = Math.max(b.maxY - b.minY, 1);
  const px = w * pad, py = h * pad;
  const X = b.minX - px, Y = b.minY - py, W = w + 2 * px, H = h + 2 * py;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(X)} ${round(Y)} ${round(W)} ${round(H)}" width="${round(W)}" height="${round(H)}">`,
  ];
  if (background) out.push(`<rect x="${round(X)}" y="${round(Y)}" width="${round(W)}" height="${round(H)}" fill="${escAttr(background)}"/>`);
  const defs = [];                      // gradient <defs> collected from items
  const body = [];
  // Serialize one item to its (possibly rotation- / blend-wrapped) SVG, or null
  // if hidden/empty. Shared by the flat and per-layer export paths.
  const emitItem = (it) => {
    if (it.hidden) return null;        // hidden items are omitted, like on-canvas
    let s = itemToSVG(it, defs);
    if (!s) return null;
    if (it.rot && ROTATABLE.has(it.type)) {
      const c = rotCenter(it);
      s = `<g transform="rotate(${round(it.rot * 180 / Math.PI)} ${round(c.x)} ${round(c.y)})">${s}</g>`;
    }
    // Per-item blend mode → mix-blend-mode (the same 16 CSS names the canvas uses).
    // Wrapped outermost so it composites the whole (possibly rotated) element.
    if (it.blend && it.blend !== 'normal') {
      s = `<g style="mix-blend-mode:${escAttr(it.blend)}">${s}</g>`;
    }
    return s;
  };
  const layers = (scene.layers && scene.layers.length) ? scene.layers : null;
  if (layers && layers.length > 1) {
    // NAMED LAYERS: each non-hidden layer → its own group, in layer order. A layer
    // with non-default opacity/blend wraps its items in an ISOLATED compositing
    // <g> (isolation:isolate + opacity/mix-blend-mode) — the SVG analogue of the
    // renderer's offscreen-buffer layer compositing, so export ≡ canvas. Items are
    // already grouped by layer on the items array; we still filter per layer so the
    // export is correct even if that invariant ever slips.
    const baseId = layers[0].id;
    for (const L of layers) {
      if (L.hidden) continue;
      const parts = [];
      for (const it of scene.items) {
        if ((it.layerId || baseId) !== L.id) continue;
        const s = emitItem(it); if (s) parts.push(s);
      }
      if (!parts.length) continue;
      const styles = [];
      if (L.opacity != null && L.opacity < 1) styles.push(`opacity:${round(L.opacity)}`);
      if (L.blend && L.blend !== 'normal') styles.push(`mix-blend-mode:${escAttr(L.blend)}`);
      if (styles.length) body.push(`<g style="isolation:isolate;${styles.join(';')}">${parts.join('')}</g>`);
      else body.push(...parts);       // a plain layer adds no wrapper (tidy output)
    }
  } else {
    for (const it of scene.items) { const s = emitItem(it); if (s) body.push(s); }
  }
  if (defs.length) out.push(`<defs>${defs.join('')}</defs>`);
  out.push(...body);
  out.push('</svg>');
  return out.join('\n');
}
