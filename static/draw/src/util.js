// Small dependency-free helpers shared across modules.

let _idCounter = 0;
/** Monotonic, collision-resistant id. Deterministic-ish but unique per session. */
export function uid(prefix = 'i') {
  _idCounter += 1;
  return `${prefix}_${_idCounter.toString(36)}_${Math.floor(performance.now()).toString(36)}`;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a, b, t) => a + (b - a) * t;

export const dist2 = (ax, ay, bx, by) => {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
};

export const dist = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));

/** Distance from point p to segment ab (all in same coordinate space). */
export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(px, py, ax, ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = clamp(t, 0, 1);
  return dist(px, py, ax + t * dx, ay + t * dy);
}

/** Rotate point (px,py) by `ang` radians about centre (cx,cy). */
export function rotatePoint(px, py, cx, cy, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const dx = px - cx, dy = py - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/** Axis-aligned bbox of a list of {x,y} points. */
export function bboxOfPoints(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Closed outline (world points) of a variable-width "ribbon" swept along
 * `points`, where `halfAt(i)` returns the half-width at point i. The outline
 * runs up one side and back the other, ready to fill as a single polygon.
 * Normals use a central difference so the band stays smooth along curves.
 * Returns [] for an empty list and null for a single point (caller draws a dot).
 */
export function ribbonOutline(points, halfAt) {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) return null;
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(n - 1, i + 1)];
    // normal = perpendicular to the local tangent (prev→next)
    let nx = -(next.y - prev.y), ny = next.x - prev.x;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    const h = halfAt(i);
    left.push({ x: points[i].x + nx * h, y: points[i].y + ny * h });
    right.push({ x: points[i].x - nx * h, y: points[i].y - ny * h });
  }
  right.reverse();
  return left.concat(right);
}

/**
 * Resample a polyline through a uniform Catmull-Rom spline so it reads as a
 * smooth curve rather than straight chords between (often RDP-thinned) control
 * points. The curve passes through every input point; `segs` interpolated
 * points are emitted per span. Per-point pressure `p` (used by the brush) is
 * carried along, linearly across each span. Endpoints use duplicated phantom
 * neighbours so the curve doesn't overshoot at the tips.
 * Returns a copy for < 3 points (nothing to smooth).
 */
export function catmullRom(points, segs = 12) {
  const n = points.length;
  if (n < 3 || segs < 2) return points.slice();
  const at = i => points[Math.max(0, Math.min(n - 1, i))];
  const pr = pt => (pt.p == null ? 1 : pt.p);
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let s = 0; s < segs; s++) {
      const t = s / segs, t2 = t * t, t3 = t2 * t;
      const x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push({ x, y, p: pr(p1) + (pr(p2) - pr(p1)) * t });
    }
  }
  const end = at(n - 1);
  out.push({ x: end.x, y: end.y, p: pr(end) });
  return out;
}

export function rectsIntersect(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function rectContains(outer, inner) {
  return outer.minX <= inner.minX && outer.maxX >= inner.maxX &&
         outer.minY <= inner.minY && outer.maxY >= inner.maxY;
}

export function pointInRect(px, py, r) {
  return px >= r.minX && px <= r.maxX && py >= r.minY && py <= r.maxY;
}

/**
 * Ramer–Douglas–Peucker simplification. Reduces freehand point count while
 * keeping shape. epsilon is in the same units as the points.
 */
export function simplify(points, epsilon) {
  if (points.length < 3) return points.slice();
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxD = 0, idx = -1;
    const a = points[first], b = points[last];
    for (let i = first + 1; i < last; i++) {
      const d = distToSegment(points[i].x, points[i].y, a.x, a.y, b.x, b.y);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > epsilon && idx !== -1) {
      keep[idx] = true;
      stack.push([first, idx], [idx, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Format a zoom scale (pixels per world unit) as a friendly percentage/multiplier. */
export function formatZoom(scale) {
  const pct = scale * 100;
  if (pct >= 100000) return (scale).toExponential(1) + '×';
  if (pct >= 1000) return Math.round(scale) + '×';
  if (pct >= 10) return Math.round(pct) + '%';
  if (pct >= 1) return pct.toFixed(1) + '%';
  return pct.toPrecision(2) + '%';
}

/** Format a world coordinate compactly across many magnitudes. */
export function formatCoord(n) {
  const a = Math.abs(n);
  if (a === 0) return '0';
  if (a >= 1e6 || a < 1e-3) return n.toExponential(2);
  if (a >= 100) return n.toFixed(0);
  if (a >= 1) return n.toFixed(1);
  return n.toFixed(3);
}

/** Debounce a function by `ms`. */
export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
  wrapped.flush = () => { if (t) { clearTimeout(t); t = null; } };
  return wrapped;
}

// --- Supersample downsampling (gamma-correct, alpha-weighted box filter) ----
// Exporters can render a frame at an integer SS× the target size and average
// each SS×SS block back down to one pixel. The averaging is done in LINEAR light
// (sRGB is a perceptual curve; averaging it directly makes antialiased edges dip
// darker than they should) and is ALPHA-WEIGHTED / premultiplied (so a half-
// covered edge pixel doesn't fringe). That is what turns a supersampled export's
// diagonal edges into clean grey gradients instead of the stair-step shimmer you
// get rasterising one straight edge at two slightly different camera scales.
const _SRGB2LIN = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();
function _lin2srgb(l) {
  if (l <= 0) return 0;
  if (l >= 1) return 255;
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.round(c * 255);
}
/**
 * Box-downsample an RGBA buffer by an integer factor `ss`, averaging in linear
 * light with premultiplied alpha. `sw`/`sh` are the SOURCE dimensions and MUST be
 * divisible by `ss`. Returns a fresh Uint8ClampedArray of the (sw/ss)×(sh/ss)
 * result; returns `src` unchanged when ss ≤ 1. Pure (no DOM) so it's reusable and
 * node-testable.
 */
export function downsampleRGBA(src, sw, sh, ss) {
  ss = Math.round(ss) || 1;
  if (ss <= 1) return src;
  const dw = Math.floor(sw / ss), dh = Math.floor(sh / ss);
  const out = new Uint8ClampedArray(dw * dh * 4);
  const blockInv = 1 / (ss * ss);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      // accumulate premultiplied linear RGB (lin·a) and the alpha sum
      let rl = 0, gl = 0, bl = 0, aSum = 0;
      const sx0 = x * ss, sy0 = y * ss;
      for (let by = 0; by < ss; by++) {
        let p = ((sy0 + by) * sw + sx0) * 4;
        for (let bx = 0; bx < ss; bx++) {
          const a = src[p + 3];
          rl += _SRGB2LIN[src[p]] * a;
          gl += _SRGB2LIN[src[p + 1]] * a;
          bl += _SRGB2LIN[src[p + 2]] * a;
          aSum += a;
          p += 4;
        }
      }
      const o = (y * dw + x) * 4;
      if (aSum > 0) {                       // un-premultiply (divide by Σa, not block size)
        out[o] = _lin2srgb(rl / aSum);
        out[o + 1] = _lin2srgb(gl / aSum);
        out[o + 2] = _lin2srgb(bl / aSum);
      }                                     // else fully-transparent block ⇒ leave RGB 0
      out[o + 3] = Math.round(aSum * blockInv);
    }
  }
  return out;
}

/** Convert "#rrggbb" + alpha to rgba() string. */
export function withAlpha(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Rotate the HUE of a hex colour by `deg` degrees, returning a fresh '#rrggbb'.
 * The conversion runs through HSL, so a GREY (saturation 0) comes back the same
 * grey — rotating an achromatic colour's hue is a no-op, never a flicker into a
 * stray tint. Inputs that aren't a 3/6-digit hex (named colours, rgb()/rgba(),
 * null, gradients) pass through UNCHANGED, so a caller can blindly map it over a
 * mix of colour fields. Powers the recursive stamp's "chromatic vortex" — a
 * per-level hue step that paints each nested copy a shade further round the wheel.
 */
export function shiftHue(color, deg) {
  if (typeof color !== 'string') return color;
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color.trim());
  if (!m) return color;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let hue = 0, s = 0;
  if (d > 1e-9) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hue = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue /= 6;
  }
  hue = ((hue + deg / 360) % 1 + 1) % 1;   // wrap into [0,1)
  if (s === 0) {                            // grey in → grey out (no spurious tint)
    const v = Math.round(l * 255).toString(16).padStart(2, '0');
    return '#' + v + v + v;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t) => {
    t = (t % 1 + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const to2 = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return '#' + to2(hue2rgb(hue + 1 / 3)) + to2(hue2rgb(hue)) + to2(hue2rgb(hue - 1 / 3));
}

/**
 * Return a copy of `it` with its ink hue rotated by `deg` degrees — the stroke
 * `color`, a flat string `fill`, AND every stop of a gradient fill. Greys stay
 * grey and any non-hex colour passes through untouched (see shiftHue). When
 * `deg` is 0 (or falsy) the ORIGINAL item is returned unchanged (no clone), so a
 * no-op shift is byte-identical and allocation-free. The clone is shallow:
 * geometry arrays (points/pts/etc.) are shared by reference — callers must treat
 * the result as read-only geometry. The single source of truth for the chromatic
 * vortex, shared by the recursive STAMP (app._shiftItemHue) and the live Droste
 * PORTAL renderer (renderer._drosteSrcForLevel).
 */
export function hueShiftedItem(it, deg) {
  if (!deg) return it;
  const c = { ...it };
  if (c.color) c.color = shiftHue(c.color, deg);
  if (typeof c.fill === 'string') c.fill = shiftHue(c.fill, deg);
  else if (c.fill && Array.isArray(c.fill.stops)) {
    c.fill = { ...c.fill, stops: c.fill.stops.map(st => ({ ...st, color: shiftHue(st.color, deg) })) };
  }
  return c;
}
