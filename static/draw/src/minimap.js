import { itemBBox } from './scene.js';
import { withAlpha } from './util.js';

/**
 * A small overview that shows the document bounds, every item as a dot/box,
 * and the current viewport rectangle. Clicking recenters the camera.
 */
export class Minimap {
  constructor(canvas, camera, scene) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = camera;
    this.scene = scene;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.enabled = true;
    this._lastWorld = null; // mapping cache for click handling
    // Offscreen bitmap of every item, drawn in DOC-BOUNDS space (view-
    // independent) and rebuilt only when the document changes. Each frame we
    // just blit it (one scaled drawImage) instead of re-drawing all N items, so
    // panning/zooming a huge scene costs O(1) on the minimap, not O(N).
    this._layer = null;       // offscreen canvas
    this._layerKey = null;    // `${rev}|${W}|${H}` the layer was built for
    this._layerRegion = null; // padded doc-bounds rect the layer spans
    this._resize();
  }

  /** Padded document-bounds rect (independent of the current view) — the world
   *  region the cached item-layer spans. Null when the document is empty. */
  _docRegion() {
    const r = this.scene.bounds();
    if (!r) return null;
    const w = Math.max(r.maxX - r.minX, 1e-6), h = Math.max(r.maxY - r.minY, 1e-6);
    const pad = 0.15;
    return { minX: r.minX - w * pad, minY: r.minY - h * pad,
             maxX: r.maxX + w * pad, maxY: r.maxY + h * pad };
  }

  /** Rebuild the cached item-layer if the doc revision or canvas size changed.
   *  The layer maps its `region` linearly across the whole W×H bitmap (no
   *  letterbox) so a single drawImage can later place it under any view mapping. */
  _ensureLayer(W, H) {
    const region = this._docRegion();
    const key = region ? `${this.scene._rev}|${W}|${H}` : null;
    if (key && key === this._layerKey) return;
    this._layerKey = key;
    this._layerRegion = region;
    if (!region) { this._layer = null; return; }
    if (!this._layer) this._layer = document.createElement('canvas');
    this._layer.width = W; this._layer.height = H;
    const lc = this._layer.getContext('2d');
    lc.clearRect(0, 0, W, H);
    const rw = region.maxX - region.minX, rh = region.maxY - region.minY;
    const sx = W / rw, sy = H / rh;
    for (const it of this.scene.items) {
      if (it.hidden) continue;
      const b = itemBBox(it, id => this.scene.byId(id));   // resolver ⇒ fold/spin copies included
      const x0 = (b.minX - region.minX) * sx, y0 = (b.minY - region.minY) * sy;
      lc.fillStyle = withAlpha(it.color || '#e8e8ef', 0.85);
      lc.fillRect(x0, y0, Math.max((b.maxX - b.minX) * sx, 1.2), Math.max((b.maxY - b.minY) * sy, 1.2));
    }
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
  }

  /** Union of document bounds and current view, with padding — the mapped region. */
  _worldRegion() {
    const view = this.camera.visibleWorldRect();
    let r = this.scene.bounds();
    if (!r) r = { ...view };
    else {
      r = {
        minX: Math.min(r.minX, view.minX), minY: Math.min(r.minY, view.minY),
        maxX: Math.max(r.maxX, view.maxX), maxY: Math.max(r.maxY, view.maxY),
      };
    }
    const w = Math.max(r.maxX - r.minX, 1e-6), h = Math.max(r.maxY - r.minY, 1e-6);
    const pad = 0.15;
    return { minX: r.minX - w * pad, minY: r.minY - h * pad,
             maxX: r.maxX + w * pad, maxY: r.maxY + h * pad };
  }

  render() {
    if (!this.enabled) return;
    const { ctx } = this;
    if (this.canvas.width !== Math.round(this.canvas.getBoundingClientRect().width * this.dpr)) this._resize();
    const W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const region = this._worldRegion();
    this._lastWorld = region;
    const rw = region.maxX - region.minX, rh = region.maxY - region.minY;
    const s = Math.min(W / rw, H / rh);
    const offX = (W - rw * s) / 2, offY = (H - rh * s) / 2;
    const map = (wx, wy) => ({ x: (wx - region.minX) * s + offX, y: (wy - region.minY) * s + offY });

    // items: blit the cached doc-bounds bitmap, scaled/placed into the current
    // region mapping. The layer linearly spans `_layerRegion`, so mapping that
    // rect's corners gives the destination — one drawImage for any item count.
    this._ensureLayer(W, H);
    if (this._layer && this._layerRegion) {
      const lr = this._layerRegion;
      const a = map(lr.minX, lr.minY), c = map(lr.maxX, lr.maxY);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this._layer, 0, 0, this._layer.width, this._layer.height,
                    a.x, a.y, c.x - a.x, c.y - a.y);
    }

    // viewport rect
    const v = this.camera.visibleWorldRect();
    const a = map(v.minX, v.minY), c = map(v.maxX, v.maxY);
    ctx.strokeStyle = withAlpha('#5b8cff', 0.95);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y);
    ctx.fillStyle = withAlpha('#5b8cff', 0.08);
    ctx.fillRect(a.x, a.y, c.x - a.x, c.y - a.y);
  }

  /** Map a click (canvas-local px) back to a world point; null if not ready. */
  clickToWorld(localX, localY) {
    if (!this._lastWorld) return null;
    const region = this._lastWorld;
    const W = this.canvas.width / this.dpr, H = this.canvas.height / this.dpr;
    const rw = region.maxX - region.minX, rh = region.maxY - region.minY;
    const s = Math.min(W / rw, H / rh);
    const offX = (W - rw * s) / 2, offY = (H - rh * s) / 2;
    return { x: (localX - offX) / s + region.minX, y: (localY - offY) / s + region.minY };
  }
}
