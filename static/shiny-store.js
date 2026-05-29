// Shiny palette store: eager-loads shiny-palettes.bin on first call,
// applies the per-family-pair (φ, ΔL, κ) OKLAB transform to source
// sprite blobs to produce shiny variants.
//
// Bin layout (mirrored from shiny-palettes-to-bin.py):
//   0  4   magic 'SHIN'
//   4  4   version (u32 = 1)
//   8  4   entry count (u32)
//   12 4   reserved
//   16 …   entries (50 bytes each), sorted by (rootA, rootB)
//     Per entry:
//       rootA u8
//       rootB u8
//       12 × { phi int16, deltaL int8, kappa u8 }
//
// φ ∈ [-π, π], ΔL ∈ [-0.20, 0.20] in OKLAB L, κ ∈ [0.5, 1.5].
// All round-trip errors well under perceptual JND — see HANDOFF.md.
//
// Public API:
//   ShinyStore.load()                              → Promise<bool>
//   ShinyStore.isReady()                           → bool
//   ShinyStore.RATE = 0.001
//   ShinyStore.VARIANT_COUNT = 12
//   ShinyStore.setRootResolver(fn)                 // fn(speciesId) → rootSpeciesId
//   ShinyStore.getTriple(rootA, rootB, variantIdx) → {phi, deltaL, kappa} | null
//   ShinyStore.transformBlob(blob, speciesA, speciesB, shinyVariant)
//                                                  → Promise<blobUrl | null>

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';
  global._scriptVersions = global._scriptVersions || {};
  global._scriptVersions['shiny-store.js'] = SCRIPT_VERSION;

  const BUNDLED_BASE = (global.CC_BUNDLED_DATA_BASE || '/bundled-data')
    .replace(/\/$/, '');

  const MAGIC = 'SHIN';
  const VERSION = 1;
  const HEADER_BYTES = 16;
  const ENTRY_BYTES = 50;
  const TRIPLES_PER_ENTRY = 12;
  const DELTA_L_RANGE = 0.20;
  const KAPPA_MIN = 0.5;
  const KAPPA_SPAN = 1.0;

  const SHINY_RATE = 0.001;
  // Pixels with OKLAB chroma below this are treated as structural
  // (outlines, near-grays) and pass through unchanged. Matches the
  // Python reference in probe-shiny-hue.py.
  const CHROMA_THRESHOLD = 0.04;
  // Alpha cutoff for "this pixel is opaque enough to color-shift".
  // Mirror the Python `if a < 200: continue` filter.
  const ALPHA_OPAQUE = 200;

  // Decoded palettes: Map<rootA * 256 + rootB, Float32Array of length 36>
  // (12 triples × 3 floats each, flat layout for fast indexed access).
  const _palettes = new Map();
  let _ready = false;
  let _loadPromise = null;

  // Defaults to identity — creatures.js calls setRootResolver with
  // candyRootFor once Species data is loaded. Until then any lookup
  // for a non-base species silently misses; only base-form lookups
  // (rootA === speciesA) succeed, which is fine for early-boot calls.
  let _rootResolver = (idx) => idx;
  function setRootResolver(fn) {
    if (typeof fn === 'function') _rootResolver = fn;
  }

  function _key(rootA, rootB) { return rootA * 256 + rootB; }

  async function load() {
    if (_ready) return true;
    if (_loadPromise) return _loadPromise;
    _loadPromise = (async () => {
      const url = `${BUNDLED_BASE}/shiny-palettes.bin`;
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`shiny-palettes.bin: HTTP ${resp.status}`);
      }
      const buf = await resp.arrayBuffer();
      const view = new DataView(buf);
      const magic = String.fromCharCode(
        view.getUint8(0), view.getUint8(1),
        view.getUint8(2), view.getUint8(3));
      if (magic !== MAGIC) {
        throw new Error(`shiny-palettes.bin: bad magic "${magic}"`);
      }
      const version = view.getUint32(4, true);
      if (version !== VERSION) {
        throw new Error(`shiny-palettes.bin: unsupported version ${version}`);
      }
      const count = view.getUint32(8, true);
      const expectedSize = HEADER_BYTES + count * ENTRY_BYTES;
      if (buf.byteLength < expectedSize) {
        throw new Error(
          `shiny-palettes.bin: truncated (got ${buf.byteLength}, ` +
          `expected ${expectedSize})`);
      }
      let off = HEADER_BYTES;
      for (let i = 0; i < count; i++) {
        const rootA = view.getUint8(off);
        const rootB = view.getUint8(off + 1);
        const triples = new Float32Array(TRIPLES_PER_ENTRY * 3);
        let tOff = off + 2;
        for (let j = 0; j < TRIPLES_PER_ENTRY; j++) {
          triples[j * 3 + 0] = view.getInt16(tOff,     true) / 32767 * Math.PI;
          triples[j * 3 + 1] = view.getInt8 (tOff + 2)         / 127   * DELTA_L_RANGE;
          triples[j * 3 + 2] = KAPPA_MIN
                             + view.getUint8(tOff + 3) / 255 * KAPPA_SPAN;
          tOff += 4;
        }
        _palettes.set(_key(rootA, rootB), triples);
        off += ENTRY_BYTES;
      }
      _ready = true;
      return true;
    })();
    _loadPromise.catch(() => { _loadPromise = null; });
    return _loadPromise;
  }

  function isReady() { return _ready; }

  function getTriple(rootA, rootB, variantIdx) {
    if (!_ready) return null;
    if (typeof variantIdx !== 'number'
        || variantIdx < 0
        || variantIdx >= TRIPLES_PER_ENTRY) return null;
    const triples = _palettes.get(_key(rootA, rootB));
    if (!triples) return null;
    const base = variantIdx * 3;
    return {
      phi:    triples[base],
      deltaL: triples[base + 1],
      kappa:  triples[base + 2],
    };
  }

  // ── OKLAB ────────────────────────────────────────────────────────
  // Direct port of probe-shiny-hue.py's rgb_to_oklab / oklab_to_rgb /
  // gamut_clip_oklab. Same constants, same bisection iteration count.

  function _srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function _linearToSrgb(c) {
    return c <= 0.0031308 ? c * 12.92
                          : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }

  function rgbToOklab(r, g, b) {
    const rl = _srgbToLinear(r / 255);
    const gl = _srgbToLinear(g / 255);
    const bl = _srgbToLinear(b / 255);
    const L = 0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl;
    const M = 0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl;
    const S = 0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl;
    const Lc = Math.cbrt(L);
    const Mc = Math.cbrt(M);
    const Sc = Math.cbrt(S);
    return [
      0.2104542553 * Lc + 0.7936177850 * Mc - 0.0040720468 * Sc,
      1.9779984951 * Lc - 2.4285922050 * Mc + 0.4505937099 * Sc,
      0.0259040371 * Lc + 0.7827717662 * Mc - 0.8086757660 * Sc,
    ];
  }

  function oklabToLinearRgb(L, a, b) {
    const Lc = L + 0.3963377774 * a + 0.2158037573 * b;
    const Mc = L - 0.1055613458 * a - 0.0638541728 * b;
    const Sc = L - 0.0894841775 * a - 1.2914855480 * b;
    const Ll = Lc * Lc * Lc;
    const Ml = Mc * Mc * Mc;
    const Sl = Sc * Sc * Sc;
    return [
      +4.0767416621 * Ll - 3.3077115913 * Ml + 0.2309699292 * Sl,
      -1.2684380046 * Ll + 2.6097574011 * Ml - 0.3413193965 * Sl,
      -0.0041960863 * Ll - 0.7034186147 * Ml + 1.7076147010 * Sl,
    ];
  }

  function oklabToRgb(L, a, b) {
    const [rl, gl, bl] = oklabToLinearRgb(L, a, b);
    return [
      Math.max(0, Math.min(255, Math.round(_linearToSrgb(rl) * 255))),
      Math.max(0, Math.min(255, Math.round(_linearToSrgb(gl) * 255))),
      Math.max(0, Math.min(255, Math.round(_linearToSrgb(bl) * 255))),
    ];
  }

  function _inGamut(linRgb) {
    const eps = 1e-4;
    return linRgb[0] >= -eps && linRgb[0] <= 1 + eps
        && linRgb[1] >= -eps && linRgb[1] <= 1 + eps
        && linRgb[2] >= -eps && linRgb[2] <= 1 + eps;
  }

  // Bisect chroma along (L, hue)-const until the result fits in sRGB.
  // Identity at chroma=0, target at chroma=1; converge to the
  // largest chroma scale in [0, 1] that still fits. 20 iterations
  // matches the Python reference and gets us ~1e-6 precision on the
  // scale factor.
  function gamutClipOklab(L, a, b) {
    if (_inGamut(oklabToLinearRgb(L, a, b))) return [L, a, b];
    let lo = 0, hi = 1;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (_inGamut(oklabToLinearRgb(L, a * mid, b * mid))) lo = mid;
      else hi = mid;
    }
    return [L, a * lo, b * lo];
  }

  // Apply the (phi, deltaL, kappa) transform per-pixel in OKLAB.
  // Mutates `data` in place. Skips fully-transparent and structural
  // (low-chroma) pixels to preserve outlines and near-grays.
  function _applyTransformInPlace(data, phi, deltaL, kappa) {
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < ALPHA_OPAQUE) continue;
      const [L, oa, ob] = rgbToOklab(data[i], data[i + 1], data[i + 2]);
      const chroma = Math.sqrt(oa * oa + ob * ob);
      if (chroma < CHROMA_THRESHOLD) continue;
      const newL = Math.max(0, Math.min(1, L + deltaL));
      const newChroma = chroma * kappa;
      // Rotate (oa, ob) by phi via the rotation matrix — avoids the
      // atan2/cos/sin round-trip for every pixel.
      const unitA = oa / chroma;
      const unitB = ob / chroma;
      const rotA = unitA * cosPhi - unitB * sinPhi;
      const rotB = unitA * sinPhi + unitB * cosPhi;
      const newA = newChroma * rotA;
      const newB = newChroma * rotB;
      const [, ca, cb] = gamutClipOklab(newL, newA, newB);
      const [r, g, bOut] = oklabToRgb(newL, ca, cb);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = bOut;
    }
  }

  function _makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function _canvasToBlob(canvas) {
    if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/png' });
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  // Decode the source blob, apply the transform, return a fresh blob
  // URL. Returns null on any failure — caller (SpriteStore) should
  // fall back to the base sprite URL in that case.
  async function transformBlob(blob, speciesA, speciesB, shinyVariant) {
    if (!blob) return null;
    if (!_ready) {
      try { await load(); }
      catch { return null; }
    }
    const rootA = _rootResolver(speciesA);
    const rootB = _rootResolver(speciesB);
    const triple = getTriple(rootA, rootB, shinyVariant);
    if (!triple) return null;
    let bmp;
    try {
      bmp = await createImageBitmap(blob);
    } catch { return null; }
    try {
      const w = bmp.width, h = bmp.height;
      const canvas = _makeCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const imgData = ctx.getImageData(0, 0, w, h);
      _applyTransformInPlace(imgData.data, triple.phi, triple.deltaL, triple.kappa);
      ctx.putImageData(imgData, 0, 0);
      const outBlob = await _canvasToBlob(canvas);
      if (!outBlob) return null;
      return URL.createObjectURL(outBlob);
    } finally {
      if (bmp.close) bmp.close();
    }
  }

  global.ShinyStore = {
    RATE: SHINY_RATE,
    VARIANT_COUNT: TRIPLES_PER_ENTRY,
    load, isReady, setRootResolver, getTriple, transformBlob,
    // Exposed for tests / debug only:
    _internals: { rgbToOklab, oklabToRgb, gamutClipOklab },
  };
})(typeof window !== 'undefined' ? window : globalThis);
