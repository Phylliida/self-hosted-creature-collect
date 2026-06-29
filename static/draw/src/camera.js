import { clamp } from './util.js';

/**
 * The camera maps between world space (where drawing geometry lives, in
 * unbounded f64 coordinates) and screen space (CSS pixels).
 *
 *   screen = R(rot) * (world - center) * scale + viewport/2
 *   world  = R(-rot) * (screen - viewport/2) / scale + center
 *
 * `scale` is pixels-per-world-unit. center.{x,y} is the world point shown at
 * the middle of the screen. `rot` (radians) rotates the *view* about the screen
 * centre — turning the canvas like a sheet of paper, independent of any item's
 * own rotation. Zoom is "infinite" in the sense that scale can range across ~30
 * orders of magnitude before f64 precision degrades; the app rebases the origin
 * (see Scene) to push that limit much further.
 */
export class Camera {
  constructor(width = 1, height = 1) {
    this.x = 0;          // world coord at screen center
    this.y = 0;
    this.scale = 1;      // pixels per world unit
    this.rot = 0;        // view rotation (radians); 0 = north-up
    this.width = width;  // viewport size in CSS px
    this.height = height;
    this.minScale = 1e-12;
    // Extreme zoom (2^400 ≈ 2.6e120). The renderer switches to a screen-space JS
    // transform above DEEP_ZOOM_SCALE (≈2^23) so the huge scale never enters the
    // Canvas2D CTM (which quantises at 2^28 / float32-overflows at 2^128), and
    // floating-origin rebasing keeps the coords feeding worldToScreen precise.
    // Before part 2 this was 1e12 (≈2^40) to avoid zooming into a render void.
    this.maxScale = 2 ** 400;
  }

  setViewport(w, h) { this.width = w; this.height = h; }

  worldToScreen(wx, wy) {
    const cos = Math.cos(this.rot), sin = Math.sin(this.rot);
    const dx = wx - this.x, dy = wy - this.y;
    return {
      x: this.scale * (cos * dx - sin * dy) + this.width / 2,
      y: this.scale * (sin * dx + cos * dy) + this.height / 2,
    };
  }

  screenToWorld(sx, sy) {
    const cos = Math.cos(this.rot), sin = Math.sin(this.rot);
    const dx = (sx - this.width / 2) / this.scale;
    const dy = (sy - this.height / 2) / this.scale;
    // inverse rotation R(-rot)
    return {
      x: cos * dx + sin * dy + this.x,
      y: -sin * dx + cos * dy + this.y,
    };
  }

  /** Distance/length conversions (rotation-invariant — pure scale). */
  worldToScreenLen(l) { return l * this.scale; }
  screenToWorldLen(l) { return l / this.scale; }

  /**
   * The 2D affine matrix mapping world → screen (CSS px), as a
   * setTransform-style tuple {a,b,c,d,e,f} where
   *   sx = a*wx + c*wy + e,  sy = b*wx + d*wy + f.
   */
  matrix() {
    const cos = Math.cos(this.rot), sin = Math.sin(this.rot), s = this.scale;
    const a = s * cos, b = s * sin, c = -s * sin, d = s * cos;
    return {
      a, b, c, d,
      e: this.width / 2 - (a * this.x + c * this.y),
      f: this.height / 2 - (b * this.x + d * this.y),
    };
  }

  /** Apply this camera as a 2D context transform so geometry can be drawn in world coords. */
  applyTo(ctx) {
    const m = this.matrix();
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  }

  /** Multiply scale by `factor`, keeping the world point under (sx,sy) fixed on screen. */
  zoomBy(factor, sx = this.width / 2, sy = this.height / 2) {
    const before = this.screenToWorld(sx, sy);
    this.scale = clamp(this.scale * factor, this.minScale, this.maxScale);
    const after = this.screenToWorld(sx, sy);
    // shift center so the anchor world point stays under the cursor
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  /** Set absolute scale, anchored at a screen point. */
  zoomTo(scale, sx = this.width / 2, sy = this.height / 2) {
    const target = clamp(scale, this.minScale, this.maxScale);
    this.zoomBy(target / this.scale, sx, sy);
  }

  /** Rotate the view by `dRad`, keeping the world point under (sx,sy) fixed on
   *  screen (so the canvas spins about the cursor / pinch midpoint, not drifting). */
  rotateBy(dRad, sx = this.width / 2, sy = this.height / 2) {
    if (!Number.isFinite(dRad) || dRad === 0) return;
    const before = this.screenToWorld(sx, sy);
    this.rot += dRad;
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this._normalizeRot();
  }

  /** Set absolute view rotation (radians), anchored at a screen point. */
  rotateTo(rad, sx = this.width / 2, sy = this.height / 2) {
    if (!Number.isFinite(rad)) return;
    this.rotateBy(rad - this.rot, sx, sy);
  }

  /** Keep rot in (-PI, PI] so repeated spins never drift toward huge magnitudes. */
  _normalizeRot() {
    const TAU = Math.PI * 2;
    let r = this.rot % TAU;
    if (r > Math.PI) r -= TAU;
    else if (r <= -Math.PI) r += TAU;
    this.rot = r;
  }

  /** Pan by a screen-space delta (px). Under rotation the screen delta is
   *  mapped back through R(-rot) so dragging moves content the way it looks. */
  panByScreen(dxScreen, dyScreen) {
    const cos = Math.cos(this.rot), sin = Math.sin(this.rot);
    const wdx = (cos * dxScreen + sin * dyScreen) / this.scale;
    const wdy = (-sin * dxScreen + cos * dyScreen) / this.scale;
    this.x -= wdx;
    this.y -= wdy;
  }

  /** The world-space axis-aligned rectangle currently visible. Under rotation the
   *  four screen corners no longer map to opposite world corners, so take the AABB
   *  over all four (identical to TL/BR when rot===0). Used for culling — a slightly
   *  loose AABB is correct (it only ever over-includes). */
  visibleWorldRect() {
    const c0 = this.screenToWorld(0, 0);
    const c1 = this.screenToWorld(this.width, 0);
    const c2 = this.screenToWorld(this.width, this.height);
    const c3 = this.screenToWorld(0, this.height);
    return {
      minX: Math.min(c0.x, c1.x, c2.x, c3.x),
      minY: Math.min(c0.y, c1.y, c2.y, c3.y),
      maxX: Math.max(c0.x, c1.x, c2.x, c3.x),
      maxY: Math.max(c0.y, c1.y, c2.y, c3.y),
    };
  }

  /** Center the view on a world bbox with some padding (0..1 fraction of margin).
   *  Rotation is preserved: the rect's *rotated* screen extent is what we fit, so
   *  the content frames correctly at any view angle. */
  fitToRect(rect, pad = 0.12) {
    const w = Math.max(rect.maxX - rect.minX, 1e-9);
    const h = Math.max(rect.maxY - rect.minY, 1e-9);
    const cos = Math.abs(Math.cos(this.rot)), sin = Math.abs(Math.sin(this.rot));
    const projW = w * cos + h * sin;   // screen-space width of the rotated rect
    const projH = w * sin + h * cos;
    const sx = (this.width * (1 - pad)) / projW;
    const sy = (this.height * (1 - pad)) / projH;
    this.scale = clamp(Math.min(sx, sy), this.minScale, this.maxScale);
    this.x = (rect.minX + rect.maxX) / 2;
    this.y = (rect.minY + rect.maxY) / 2;
  }

  serialize() { return { x: this.x, y: this.y, scale: this.scale, rot: this.rot }; }
  restore(s) {
    if (!s) return;
    if (Number.isFinite(s.x)) this.x = s.x;
    if (Number.isFinite(s.y)) this.y = s.y;
    if (Number.isFinite(s.scale)) this.scale = clamp(s.scale, this.minScale, this.maxScale);
    if (Number.isFinite(s.rot)) { this.rot = s.rot; this._normalizeRot(); }
  }
}
