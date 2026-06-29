// src/gif.js — a tiny, dependency-free GIF89a encoder.
//
// Turns a stack of RGBA frame buffers (the flipbook pages, rendered offscreen)
// into a single animated, looping .gif — the shareable artifact for the
// stop-motion animation mode. Pure JS: median-cut colour quantization into one
// global ≤256-colour palette, then standard variable-width LZW compression.
//
// Why a global palette + full opaque frames (no transparency, disposal = "do
// not dispose"): the drawing canvas is repainted whole every page, so each GIF
// frame is a complete opaque image. That sidesteps the classic partial-frame
// "ghosting" bugs entirely and keeps the encoder small and robust. A vector
// drawing typically uses few distinct colours, so quantization is usually
// lossless (palette built from the exact colours present); anti-aliased edges
// add a handful of blends that median-cut folds into the nearest bucket.
//
// For gradient-heavy art that exceeds 256 colours, an optional Floyd–Steinberg
// dithering pass (encodeGIF({dither:true})) scatters the quantization error to
// neighbouring pixels so smooth ramps stop banding — a no-op when the palette
// already covers every colour exactly (the flat-vector case).

/** Build a histogram of distinct RGB colours (alpha ignored — frames are
 *  opaque) across every frame: packed 0xRRGGBB → pixel count. */
function buildHistogram(frames) {
  const hist = new Map();
  for (const data of frames) {
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      hist.set(key, (hist.get(key) || 0) + 1);
    }
  }
  return hist;
}

/**
 * Median-cut quantization. Returns { palette: [[r,g,b],…] (≤maxColors), lookup:
 * Map<packedRGB,index> } where the lookup covers EVERY colour in the histogram
 * exactly (each input colour falls in exactly one box), so mapping pixels later
 * is an O(1) table hit — no nearest-colour search needed. Deterministic: box
 * selection and splits use only counts/ranges, no randomness.
 */
export function quantize(hist, maxColors = 256) {
  const colors = [];
  for (const [key, count] of hist) {
    colors.push({ r: (key >> 16) & 255, g: (key >> 8) & 255, b: key & 255, count });
  }
  if (!colors.length) return { palette: [[0, 0, 0]], lookup: new Map() };

  const rangeOf = (box) => {
    let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
    for (const c of box) {
      if (c.r < rmin) rmin = c.r; if (c.r > rmax) rmax = c.r;
      if (c.g < gmin) gmin = c.g; if (c.g > gmax) gmax = c.g;
      if (c.b < bmin) bmin = c.b; if (c.b > bmax) bmax = c.b;
    }
    return { r: rmax - rmin, g: gmax - gmin, b: bmax - bmin };
  };
  const pixels = (box) => { let n = 0; for (const c of box) n += c.count; return n; };

  let boxes = [colors];
  while (boxes.length < maxColors) {
    // Split the box with the greatest (longest-axis × pixel-population) score;
    // skip boxes that can't be split (a single colour). Ties resolve by the
    // earlier box, so the result is stable.
    let bi = -1, best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.length < 2) continue;
      const rg = rangeOf(box);
      const score = Math.max(rg.r, rg.g, rg.b) * pixels(box);
      if (score > best) { best = score; bi = i; }
    }
    if (bi < 0) break; // every box is a single colour — done early

    const box = boxes[bi];
    const rg = rangeOf(box);
    const ch = rg.r >= rg.g && rg.r >= rg.b ? 'r' : (rg.g >= rg.b ? 'g' : 'b');
    box.sort((a, b) => a[ch] - b[ch]);
    const total = pixels(box);
    let acc = 0, split = 1;
    for (let i = 0; i < box.length; i++) {
      acc += box[i].count;
      if (acc * 2 >= total) { split = i + 1; break; }
    }
    if (split < 1) split = 1;
    if (split > box.length - 1) split = box.length - 1;
    boxes.splice(bi, 1, box.slice(0, split), box.slice(split));
  }

  const palette = [];
  const lookup = new Map();
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    let r = 0, g = 0, b = 0, n = 0;
    for (const c of box) { r += c.r * c.count; g += c.g * c.count; b += c.b * c.count; n += c.count; }
    n = n || 1;
    palette.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
    for (const c of box) lookup.set((c.r << 16) | (c.g << 8) | c.b, i);
  }
  return { palette, lookup };
}

/**
 * Linear nearest-colour search over a (≤256-entry) palette by squared RGB
 * distance. O(palette) per call — fine at export sizes, and the dither pass
 * caches results per distinct adjusted colour so flat regions cost nothing.
 */
export function nearestIndex(palette, r, g, b) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const dr = r - p[0], dg = g - p[1], db = b - p[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = i; if (d === 0) break; }
  }
  return best;
}

/**
 * Map one RGBA frame to palette indices with Floyd–Steinberg error diffusion.
 * Instead of snapping each pixel to its nearest palette colour and discarding
 * the rounding error (which bands gradients), we spread that error to the
 * not-yet-visited neighbours (7/16 right, 3/16 below-left, 5/16 below, 1/16
 * below-right), so the LOCAL AVERAGE colour is preserved — the eye reads the
 * scattered dots as the in-between shade. Each frame is diffused independently
 * (GIF frames are whole opaque images; error must not cross frame boundaries).
 *
 * When the palette already contains every colour in the frame (the common case
 * for flat vector art), every nearest match is exact, the error is zero, and
 * this returns the same indices as the plain lookup — so dithering is a no-op
 * on simple drawings and only changes >256-colour / gradient frames.
 */
export function ditherFrame(data, width, height, palette) {
  const n = width * height;
  // Float channel buffers so diffused error accumulates without being clamped
  // to 0..255 mid-flight (clamping only happens at the nearest-colour lookup).
  const rb = new Float32Array(n), gb = new Float32Array(n), bb = new Float32Array(n);
  for (let i = 0, q = 0; q < n; i += 4, q++) { rb[q] = data[i]; gb[q] = data[i + 1]; bb[q] = data[i + 2]; }

  const indices = new Uint8Array(n);
  const cache = new Map(); // packed adjusted RGB → palette index (flat-region fast path)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const q = y * width + x;
      const r = rb[q], g = gb[q], b = bb[q];
      // Clamp + round only for the lookup; the error below uses the unclamped value.
      const ri = (r < 0 ? 0 : r > 255 ? 255 : r) + 0.5 | 0;
      const gi = (g < 0 ? 0 : g > 255 ? 255 : g) + 0.5 | 0;
      const bi = (b < 0 ? 0 : b > 255 ? 255 : b) + 0.5 | 0;
      const key = (ri << 16) | (gi << 8) | bi;
      let pi = cache.get(key);
      if (pi === undefined) { pi = nearestIndex(palette, ri, gi, bi); cache.set(key, pi); }
      indices[q] = pi;

      const p = palette[pi];
      const er = r - p[0], eg = g - p[1], eb = b - p[2];
      if (x + 1 < width) {
        rb[q + 1] += er * 7 / 16; gb[q + 1] += eg * 7 / 16; bb[q + 1] += eb * 7 / 16;
      }
      if (y + 1 < height) {
        const row = q + width;
        if (x > 0) { rb[row - 1] += er * 3 / 16; gb[row - 1] += eg * 3 / 16; bb[row - 1] += eb * 3 / 16; }
        rb[row] += er * 5 / 16; gb[row] += eg * 5 / 16; bb[row] += eb * 5 / 16;
        if (x + 1 < width) { rb[row + 1] += er * 1 / 16; gb[row + 1] += eg * 1 / 16; bb[row + 1] += eb * 1 / 16; }
      }
    }
  }
  return indices;
}

/**
 * GIF-variant LZW compression of a stream of palette indices. Codes are packed
 * LSB-first into a byte stream; the code width grows from minCodeSize+1 up to 12
 * bits, and the dictionary is reset (clear code re-emitted) when it fills at
 * 4096 entries. Follows the standard (non-"early-change") timing used by GIF
 * decoders in every browser. Returns a plain array of bytes (pre sub-blocking).
 */
export function lzwEncode(minCodeSize, indexStream) {
  const out = [];
  let cur = 0, curShift = 0, codeSize = minCodeSize + 1;
  const emit = (code) => {
    cur |= code << curShift;
    curShift += codeSize;
    while (curShift >= 8) { out.push(cur & 0xff); cur >>= 8; curShift -= 8; }
  };
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let nextCode = eoiCode + 1;
  let table = new Map();

  emit(clearCode);
  if (indexStream.length === 0) { emit(eoiCode); if (curShift > 0) out.push(cur & 0xff); return out; }

  let ib = indexStream[0];
  for (let i = 1; i < indexStream.length; i++) {
    const k = indexStream[i];
    const key = (ib << 8) | k;
    const code = table.get(key);
    if (code !== undefined) {
      ib = code;
    } else {
      emit(ib);
      if (nextCode === 4096) {
        emit(clearCode);
        codeSize = minCodeSize + 1;
        nextCode = eoiCode + 1;
        table = new Map();
      } else {
        if (nextCode >= (1 << codeSize) && codeSize < 12) codeSize++;
        table.set(key, nextCode++);
      }
      ib = k;
    }
  }
  emit(ib);
  emit(eoiCode);
  if (curShift > 0) out.push(cur & 0xff);
  return out;
}

const pushStr = (out, s) => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };
const push16 = (out, v) => { out.push(v & 0xff, (v >> 8) & 0xff); };

/**
 * Encode an animated GIF.
 *   width, height — pixel dimensions of every frame (all equal).
 *   frames        — array of RGBA buffers (Uint8ClampedArray, length w*h*4).
 *   delayCs       — fallback per-frame delay in centiseconds (1/100 s).
 *   delays        — optional array of per-frame delays (centiseconds); enables
 *                   per-frame timing (holds/eases). Falls back to delayCs.
 *   loop          — true → loop forever (NETSCAPE2.0 ext, count 0).
 *   dither        — true → Floyd–Steinberg error diffusion per frame (smooths
 *                   gradients that exceed the 256-colour palette). No-op when
 *                   the artwork already fits the palette exactly.
 * Returns a Uint8Array of the complete .gif file.
 */
export function encodeGIF({ width, height, frames, delayCs = 10, delays = null, loop = true, dither = false }) {
  const hist = buildHistogram(frames);
  const { palette, lookup } = quantize(hist, 256);

  // Palette size must be a power of two for the colour-table descriptor; pad
  // with black. minCodeSize = bits per index (≥2, as GIF requires).
  let bits = 1;
  while ((1 << bits) < palette.length) bits++;
  bits = Math.max(2, bits);
  const minCodeSize = bits;
  const gctEntries = 1 << bits;

  const out = [];
  pushStr(out, 'GIF89a');

  // Logical Screen Descriptor
  push16(out, width);
  push16(out, height);
  out.push(0x80 | ((bits - 1) << 4) | (bits - 1)); // GCT present | colour-res | GCT size
  out.push(0);  // background colour index
  out.push(0);  // pixel aspect ratio

  // Global Colour Table
  for (let i = 0; i < gctEntries; i++) {
    const c = palette[i] || [0, 0, 0];
    out.push(c[0] & 255, c[1] & 255, c[2] & 255);
  }

  // Looping (Netscape application extension). Omitted entirely for play-once,
  // which most browsers honour as "render every frame, then stop".
  if (loop) {
    out.push(0x21, 0xFF, 0x0B);
    pushStr(out, 'NETSCAPE2.0');
    out.push(0x03, 0x01);
    push16(out, 0); // 0 = loop forever
    out.push(0x00);
  }

  for (let fi = 0; fi < frames.length; fi++) {
    const data = frames[fi];
    const delay = Math.max(1, ((delays && delays[fi] != null ? delays[fi] : delayCs) | 0) || 1);
    // Graphic Control Extension (per-frame delay; disposal = 1, no transparency)
    out.push(0x21, 0xF9, 0x04, 0x04);
    push16(out, delay);
    out.push(0x00, 0x00);

    // Image Descriptor (full frame, no local colour table)
    out.push(0x2C);
    push16(out, 0); push16(out, 0);
    push16(out, width); push16(out, height);
    out.push(0x00);

    // Map pixels → palette indices (dithered or via the O(1) exact lookup),
    // compress, sub-block.
    let indices;
    if (dither) {
      indices = ditherFrame(data, width, height, palette);
    } else {
      indices = new Uint8Array(width * height);
      for (let p = 0, q = 0; q < indices.length; p += 4, q++) {
        indices[q] = lookup.get((data[p] << 16) | (data[p + 1] << 8) | data[p + 2]) || 0;
      }
    }
    const lzw = lzwEncode(minCodeSize, indices);
    out.push(minCodeSize);
    for (let i = 0; i < lzw.length;) {
      const n = Math.min(255, lzw.length - i);
      out.push(n);
      for (let j = 0; j < n; j++) out.push(lzw[i + j]);
      i += n;
    }
    out.push(0x00); // block terminator
  }

  out.push(0x3B); // trailer
  return Uint8Array.from(out);
}
