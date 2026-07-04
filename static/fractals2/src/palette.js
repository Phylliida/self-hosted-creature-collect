// palette.js — map smooth iteration counts to RGB. Coloring is cheap and runs
// on the main thread from the worker's `sn` data, so palette/shift changes are
// instant without recomputing the fractal.
//
// Convention: sn === -1 (or < 0) means "inside the set" -> drawn as the interior
// color. Otherwise sn is the fractional smooth escape count.

// Smooth interpolation between gradient control points (each [r,g,b] 0..255).
function gradient(stops, t) {
  // t in [0,1), cyclic
  const n = stops.length;
  const x = (t - Math.floor(t)) * n;
  const i = Math.floor(x);
  const f = x - i;
  const a = stops[i % n];
  const b = stops[(i + 1) % n];
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
}

// Classic Ultra-Fractal-style blue/white/orange/black cycle.
const UF = [
  [0, 7, 100], [32, 107, 203], [237, 255, 255],
  [255, 170, 0], [0, 2, 0], [0, 7, 100],
];
// Fiery
const FIRE = [
  [0, 0, 0], [120, 20, 0], [220, 90, 0], [255, 200, 40], [255, 255, 220], [120, 20, 0],
];
// Grayscale
const GRAY = [[0, 0, 0], [255, 255, 255]];
// Deep ocean — teal/navy with a bright foam crest.
const OCEAN = [
  [2, 8, 30], [8, 40, 78], [16, 96, 130], [80, 190, 200],
  [225, 255, 250], [30, 120, 150], [6, 24, 55],
];
// Lava — black through ember red to bright yellow.
const LAVA = [
  [0, 0, 0], [60, 0, 0], [160, 20, 0], [240, 90, 10],
  [255, 190, 60], [255, 250, 200], [90, 10, 0],
];
// Forest — deep green canopy to gold light.
const FOREST = [
  [4, 18, 8], [16, 60, 24], [46, 120, 44], [130, 190, 70],
  [230, 240, 160], [70, 130, 60], [10, 34, 16],
];
// Dusk-to-dawn — violet night to warm sunrise.
const DUSK = [
  [12, 6, 40], [60, 24, 92], [150, 60, 120], [230, 120, 110],
  [255, 200, 130], [255, 245, 210], [40, 16, 60],
];
// Jewellery — saturated amethyst/emerald/citrine facets over black.
const JEWEL = [
  [0, 0, 0], [110, 20, 150], [0, 0, 0], [20, 170, 120],
  [0, 0, 0], [240, 200, 40], [0, 0, 0], [40, 90, 220],
];
// Rainbow via HSV done analytically below (paletteId 'rainbow')

export const PALETTES = {
  ultra: { name: 'Ultra', stops: UF, interior: [0, 0, 0] },
  fire: { name: 'Fire', stops: FIRE, interior: [10, 0, 0] },
  ocean: { name: 'Ocean', stops: OCEAN, interior: [1, 4, 16] },
  lava: { name: 'Lava', stops: LAVA, interior: [0, 0, 0] },
  forest: { name: 'Forest', stops: FOREST, interior: [3, 12, 6] },
  dusk: { name: 'Dusk', stops: DUSK, interior: [8, 4, 24] },
  jewel: { name: 'Jewellery', stops: JEWEL, interior: [0, 0, 0] },
  gray: { name: 'Gray', stops: GRAY, interior: [0, 0, 0] },
  rainbow: { name: 'Rainbow', stops: null, interior: [0, 0, 0] },
};

// ---------- custom palettes (Spawn 42) ----------
// A custom palette is { name, colors: ["#rrggbb" | "#rrggbb:weight", ...], mirror }.
// Weight = relative span of a stop before it blends to the next (default 1); mirror
// reflects the gradient into a palindrome. The registry lives in this module so BOTH
// threads (main + GPU worker, separate module instances) resolve custom ids the same
// way — the viewer registers from localStorage; the worker registers from the render
// plan's paletteDef. Ids are `custom_<index>` (saved list) or `custom_shared`/`custom_url`
// (a palette that arrived via a shared link, registered transiently).
const CUSTOM = new Map();   // id -> { def, stops: [[r,g,b], ... expanded], mirror }

// Parse "#rrggbb" or "#rrggbb:weight" -> [r, g, b, weight].
function parseColor(c) {
  if (Array.isArray(c)) return c.length >= 4 ? c : [c[0], c[1], c[2], 1];
  const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
  const wi = c.indexOf(':');
  const w = wi !== -1 ? parseFloat(c.slice(wi + 1)) : 1;
  return [r || 0, g || 0, b || 0, isFinite(w) && w > 0 ? w : 1];
}

// Expand weighted stops into an equally-spaced stop list the cyclic `gradient()` can
// sample (a stop of weight w contributes ~w slots before transitioning). mirror doubles
// the list into a palindrome. Resolution SLOTS is fine enough that weights read smoothly.
const SLOTS = 256;
function expandStops(colors, mirror) {
  const parsed = (colors && colors.length ? colors : ['#000000', '#ffffff']).map(parseColor);
  const total = parsed.reduce((s, c) => s + c[3], 0) || parsed.length;
  const out = [];
  for (let s = 0; s < SLOTS; s++) {
    const pos = (s / SLOTS) * total;       // position in weight units, [0,total)
    let acc = 0, i = 0;
    while (i < parsed.length - 1 && acc + parsed[i][3] <= pos) { acc += parsed[i][3]; i++; }
    const a = parsed[i], b = parsed[(i + 1) % parsed.length];
    const f = a[3] > 0 ? (pos - acc) / a[3] : 0;
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
  }
  if (mirror) {                            // palindrome: forward then reversed
    const rev = out.slice(0, -1).reverse();
    return out.concat(rev);
  }
  return out;
}

// Register the saved custom-palette list (from localStorage) as ids custom_0.. (viewer).
export function setCustomPalettes(list) {
  for (const id of [...CUSTOM.keys()]) if (/^custom_\d+$/.test(id)) CUSTOM.delete(id);
  (list || []).forEach((def, i) => registerPalette(`custom_${i}`, def));
}

// Register a single palette def under an explicit id (worker plan / shared link).
export function registerPalette(id, def) {
  if (!id || !def) return;
  CUSTOM.set(id, { def, stops: expandStops(def.colors, def.mirror) });
}

// True if this id resolves to a registered custom palette.
export function isCustomPalette(id) { return CUSTOM.has(id); }
export function customPaletteDef(id) { const c = CUSTOM.get(id); return c ? c.def : null; }
// Distinguishes content changes so LUT caches re-upload when an edited palette keeps its id.
export function paletteSignature(id) { const c = CUSTOM.get(id); return c ? JSON.stringify(c.def) : String(id); }

function hsv(h, s, v) {
  h = (h % 1 + 1) % 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return [r * 255, g * 255, b * 255];
}

// One color for a smooth count. opts: { paletteId, cycle (period in iters),
// shift (0..1), interiorColor }.
export function colorFor(sn, opts) {
  const custom = CUSTOM.get(opts.paletteId);
  if (sn < 0 || !isFinite(sn)) {
    if (custom) return opts.interior || [0, 0, 0];
    const p = PALETTES[opts.paletteId] || PALETTES.ultra;
    return opts.interior || p.interior;
  }
  const cycle = opts.cycle || 64;
  const t = sn / cycle + (opts.shift || 0);
  if (custom) return gradient(custom.stops, t);
  if (opts.paletteId === 'rainbow') return hsv(t, 0.85, 1.0);
  const p = PALETTES[opts.paletteId] || PALETTES.ultra;
  return gradient(p.stops, t);
}

// Palette-shape color at phase u in [0,1) — the gradient/hue ignoring cycle/shift
// (the GPU color pass applies t = sn/cycle + shift then samples this LUT at
// fract(t), so the LUT must encode only the palette shape). Mirrors colorFor with
// cycle=1, shift=0, sn=u, so CPU and GPU coloring agree to LUT resolution.
export function paletteRgbAt(paletteId, u) {
  return colorFor(u, { paletteId, cycle: 1, shift: 0 });
}

// Glitch-overlay tint (debug). Mirrors the GPU color shader exactly: a flagged pixel
// is blended 0.6 toward magenta (255,0,255) so the fractal stays visible underneath.
// (GLSL: mix(col, vec3(1,0,1), 0.6) on [0,1] colors == this on [0,255].)
const GLITCH_RGB = [255, 0, 255];
const GLITCH_MIX = 0.6;
function tintGlitch(rgb) {
  const k = 1 - GLITCH_MIX;
  return [
    rgb[0] * k + GLITCH_RGB[0] * GLITCH_MIX,
    rgb[1] * k + GLITCH_RGB[1] * GLITCH_MIX,
    rgb[2] * k + GLITCH_RGB[2] * GLITCH_MIX,
  ];
}

// Fill an RGBA Uint8ClampedArray (full image) from an sn buffer for a region.
//   img    : Uint8ClampedArray length width*height*4 (the canvas ImageData.data)
//   sn     : Float64Array for the REGION (length region.w*region.h)
//   width  : full image width (for indexing img)
//   region : { x0, y0, w, h }
//   glitch : optional region-sized Uint8 mask; when present, flagged pixels (==1) are
//            tinted magenta (the debug overlay). Omit it (default renders) and the output
//            is byte-identical to the no-overlay path.
export function colorizeRegion(img, sn, width, region, opts, glitch) {
  const { x0, y0, w, h } = region;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const idx = j * w + i;
      let rgb = colorFor(sn[idx], opts);
      if (glitch && glitch[idx]) rgb = tintGlitch(rgb);
      const px = x0 + i, py = y0 + j;
      const o = (py * width + px) * 4;
      img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2]; img[o + 3] = 255;
    }
  }
}

// Block-fill version for progressive low-res passes: each sn sample paints a
// step x step block. snW/snH are the subsampled grid dims. `glitch` (optional) is the
// matching subsampled mask — same gating/tint as colorizeRegion.
export function colorizeBlocks(img, sn, width, height, snW, snH, step, opts, glitch) {
  for (let sy = 0; sy < snH; sy++) {
    for (let sx = 0; sx < snW; sx++) {
      const idx = sy * snW + sx;
      let rgb = colorFor(sn[idx], opts);
      if (glitch && glitch[idx]) rgb = tintGlitch(rgb);
      const px0 = sx * step, py0 = sy * step;
      for (let dy = 0; dy < step && py0 + dy < height; dy++) {
        for (let dx = 0; dx < step && px0 + dx < width; dx++) {
          const o = ((py0 + dy) * width + (px0 + dx)) * 4;
          img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2]; img[o + 3] = 255;
        }
      }
    }
  }
}
