// Standalone Pixel Art editor — a focused, self-contained tool that runs in
// its own iframe inside the creature-collect "Extras → Pixel Art" window.
// Separate from (and simpler than) the drawing app's built-in pixel mode.
//
// Model: a w×h grid; each cell is a hex colour string or null (transparent).
// Drawing is constrained to the grid; you can still zoom/pan freely. State is
// autosaved to localStorage so reopening resumes; named saves go to the host's
// IndexedDB folder via the window.PixelApp bridge at the bottom of this file.
(function () {
  'use strict';

  // PICO-8 palette as the default swatches (same set the draw app's pixel mode
  // uses). `PALETTE` is the live working palette; the palette manager can switch
  // to / edit / save named palettes stored globally (across all drawings).
  const DEFAULT_PALETTE = ['#000000', '#1D2B53', '#7E2553', '#008751', '#AB5236', '#5F574F',
    '#C2C3C7', '#FFF1E8', '#FF004D', '#FFA300', '#FFEC27', '#00E436',
    '#29ADFF', '#83769C', '#FF77A8', '#FFCCAA'];
  let PALETTE = DEFAULT_PALETTE.slice();
  let savedPalettes = {};        // { name: [hex, ...] } — user palettes, persisted globally
  let activePaletteName = '';    // '' = the built-in PICO-8 default

  // Built-in preset palettes — famous pixel-art palettes (values from lospec.com),
  // ordered small→large. Read-only: selecting one loads it as the working palette;
  // editing it is session-only unless you "Save as…" (like the default).
  const BUILTIN_PALETTES = {
    '1-bit Monitor Glow': ['#222323', '#f0f6f0'],
    'Kirokaze Gameboy': ['#332c50', '#46878f', '#94e344', '#e2f3e4'],
    'Ice Cream GB': ['#7c3f58', '#eb6b6f', '#f9a875', '#fff6d3'],
    '2-bit Demichrome': ['#211e20', '#555568', '#a0a08b', '#e9efec'],
    'Oil 6': ['#fbf5ef', '#f2d3ab', '#c69fa5', '#8b6d9c', '#494d7e', '#272744'],
    'Ammo-8': ['#040c06', '#112318', '#1e3a29', '#305d42', '#4d8061', '#89a257', '#bedc7f', '#eeffcc'],
    'SLSO8': ['#0d2b45', '#203c56', '#544e68', '#8d697a', '#d08159', '#ffaa5e', '#ffd4a3', '#ffecd6'],
    'NYX8': ['#08141e', '#0f2a3f', '#20394f', '#f6d6bd', '#c3a38a', '#997577', '#816271', '#4e495f'],
    'DawnBringer 16': ['#140c1c', '#442434', '#30346d', '#4e4a4e', '#854c30', '#346524', '#d04648', '#757161', '#597dce', '#d27d2c', '#8595a1', '#6daa2c', '#d2aa99', '#6dc2ca', '#dad45e', '#deeed6'],
    'Sweetie 16': ['#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070', '#38b764', '#257179', '#29366f', '#3b5dc9', '#41a6f6', '#73eff7', '#f4f4f4', '#94b0c2', '#566c86', '#333c57'],
    'Endesga 16': ['#e4a672', '#b86f50', '#743f39', '#3f2832', '#9e2835', '#e53b44', '#fb922b', '#ffe762', '#63c64d', '#327345', '#193d3f', '#4f6781', '#afbfd2', '#ffffff', '#2ce8f4', '#0484d1'],
    'NA16': ['#8c8fae', '#584563', '#3e2137', '#9a6348', '#d79b7d', '#f5edba', '#c0c741', '#647d34', '#e4943a', '#9d303b', '#d26471', '#70377f', '#7ec4c1', '#34859d', '#17434b', '#1f0e1c'],
    'Steam Lords': ['#213b25', '#3a604a', '#4f7754', '#a19f7c', '#77744f', '#775c4f', '#603b3a', '#3b2137', '#170e19', '#2f213b', '#433a60', '#4f5277', '#65738c', '#7c94a1', '#a0b9ba', '#c0d1cc'],
    'Bubblegum 16': ['#16171a', '#7f0622', '#d62411', '#ff8426', '#ffd100', '#fafdff', '#ff80a4', '#ff2674', '#94216a', '#430067', '#234975', '#68aed4', '#bfff3c', '#10d275', '#007899', '#002859'],
    'Commodore 64': ['#000000', '#626262', '#898989', '#adadad', '#ffffff', '#9f4e44', '#cb7e75', '#6d5412', '#a1683c', '#c9d487', '#9ae29b', '#5cab5e', '#6abfc6', '#887ecb', '#50459b', '#a057a3'],
    'Vinik24': ['#000000', '#6f6776', '#9a9a97', '#c5ccb8', '#8b5580', '#c38890', '#a593a5', '#666092', '#9a4f50', '#c28d75', '#7ca1c0', '#416aa3', '#8d6268', '#be955c', '#68aca9', '#387080', '#6e6962', '#93a167', '#6eaa78', '#557064', '#9d9f7f', '#7e9e99', '#5d6872', '#433455'],
    'DawnBringer 32': ['#000000', '#222034', '#45283c', '#663931', '#8f563b', '#df7126', '#d9a066', '#eec39a', '#fbf236', '#99e550', '#6abe30', '#37946e', '#4b692f', '#524b24', '#323c39', '#3f3f74', '#306082', '#5b6ee1', '#639bff', '#5fcde4', '#cbdbfc', '#ffffff', '#9badb7', '#847e87', '#696a6a', '#595652', '#76428a', '#ac3232', '#d95763', '#d77bba', '#8f974a', '#8a6f30'],
    'Endesga 32': ['#be4a2f', '#d77643', '#ead4aa', '#e4a672', '#b86f50', '#733e39', '#3e2731', '#a22633', '#e43b44', '#f77622', '#feae34', '#fee761', '#63c74d', '#3e8948', '#265c42', '#193c3e', '#124e89', '#0099db', '#2ce8f5', '#ffffff', '#c0cbdc', '#8b9bb4', '#5a6988', '#3a4466', '#262b44', '#181425', '#ff0044', '#68386c', '#b55088', '#f6757a', '#e8b796', '#c28569'],
    'Pear36': ['#5e315b', '#8c3f5d', '#ba6156', '#f2a65e', '#ffe478', '#cfff70', '#8fde5d', '#3ca370', '#3d6e70', '#323e4f', '#322947', '#473b78', '#4b5bab', '#4da6ff', '#66ffe3', '#ffffeb', '#c2c2d1', '#7e7e8f', '#606070', '#43434f', '#272736', '#3e2347', '#57294b', '#964253', '#e36956', '#ffb570', '#ff9166', '#eb564b', '#b0305c', '#73275c', '#422445', '#5a265e', '#80366b', '#bd4882', '#ff6b97', '#ffb5b5'],
    'Lospec500': ['#10121c', '#2c1e31', '#6b2643', '#ac2847', '#ec273f', '#94493a', '#de5d3a', '#e98537', '#f3a833', '#4d3533', '#6e4c30', '#a26d3f', '#ce9248', '#dab163', '#e8d282', '#f7f3b7', '#1e4044', '#006554', '#26854c', '#5ab552', '#9de64e', '#008b8b', '#62a477', '#a6cb96', '#d3eed3', '#3e3b65', '#3859b3', '#3388de', '#36c5f4', '#6dead6', '#5e5b8c', '#8c78a5', '#b0a7b8', '#deceed', '#9a4d76', '#c878af', '#cc99ff', '#fa6e79', '#ffa2ac', '#ffd1d5', '#f6e8e0', '#ffffff'],
    'Apollo': ['#172038', '#253a5e', '#3c5e8b', '#4f8fba', '#73bed3', '#a4dddb', '#19332d', '#25562e', '#468232', '#75a743', '#a8ca58', '#d0da91', '#4d2b32', '#7a4841', '#ad7757', '#c09473', '#d7b594', '#e7d5b3', '#341c27', '#602c2c', '#884b2b', '#be772b', '#de9e41', '#e8c170', '#241527', '#411d31', '#752438', '#a53030', '#cf573c', '#da863e', '#1e1d39', '#402751', '#7a367b', '#a23e8c', '#c65197', '#df84a5', '#090a14', '#10141f', '#151d28', '#202e37', '#394a50', '#577277', '#819796', '#a8b5b2', '#c7cfcc', '#ebede9'],
    'AAP-64': ['#060608', '#141013', '#3b1725', '#73172d', '#b4202a', '#df3e23', '#fa6a0a', '#f9a31b', '#ffd541', '#fffc40', '#d6f264', '#9cdb43', '#59c135', '#14a02e', '#1a7a3e', '#24523b', '#122020', '#143464', '#285cc4', '#249fde', '#20d6c7', '#a6fcdb', '#ffffff', '#fef3c0', '#fad6b8', '#f5a097', '#e86a73', '#bc4a9b', '#793a80', '#403353', '#242234', '#221c1a', '#322b28', '#71413b', '#bb7547', '#dba463', '#f4d29c', '#dae0ea', '#b3b9d1', '#8b93af', '#6d758d', '#4a5462', '#333941', '#422433', '#5b3138', '#8e5252', '#ba756a', '#e9b5a3', '#e3e6ff', '#b9bffb', '#849be4', '#588dbe', '#477d85', '#23674e', '#328464', '#5daf8d', '#92dcba', '#cdf7e2', '#e4d2aa', '#c7b08b', '#a08662', '#796755', '#5a4e44', '#423934'],
    'Resurrect 64': ['#2e222f', '#3e3546', '#625565', '#966c6c', '#ab947a', '#694f62', '#7f708a', '#9babb2', '#c7dcd0', '#ffffff', '#6e2727', '#b33831', '#ea4f36', '#f57d4a', '#ae2334', '#e83b3b', '#fb6b1d', '#f79617', '#f9c22b', '#7a3045', '#9e4539', '#cd683d', '#e6904e', '#fbb954', '#4c3e24', '#676633', '#a2a947', '#d5e04b', '#fbff86', '#165a4c', '#239063', '#1ebc73', '#91db69', '#cddf6c', '#313638', '#374e4a', '#547e64', '#92a984', '#b2ba90', '#0b5e65', '#0b8a8f', '#0eaf9b', '#30e1b9', '#8ff8e2', '#323353', '#484a77', '#4d65b4', '#4d9be6', '#8fd3ff', '#45293f', '#6b3e75', '#905ea9', '#a884f3', '#eaaded', '#753c54', '#a24b6f', '#cf657f', '#ed8099', '#831c5d', '#c32454', '#f04f78', '#f68181', '#fca790', '#fdcbb0'],
    'Journey': ['#050914', '#110524', '#3b063a', '#691749', '#9c3247', '#d46453', '#f5a15d', '#ffcf8e', '#ff7a7d', '#ff417d', '#d61a88', '#94007a', '#42004e', '#220029', '#100726', '#25082c', '#3d1132', '#73263d', '#bd4035', '#ed7b39', '#ffb84a', '#fff540', '#c6d831', '#77b02a', '#429058', '#2c645e', '#153c4a', '#052137', '#0e0421', '#0c0b42', '#032769', '#144491', '#488bd4', '#78d7ff', '#b0fff1', '#faffff', '#c7d4e1', '#928fb8', '#5b537d', '#392946', '#24142c', '#0e0f2c', '#132243', '#1a466b', '#10908e', '#28c074', '#3dff6e', '#f8ffb8', '#f0c297', '#cf968c', '#8f5765', '#52294b', '#0f022e', '#35003b', '#64004c', '#9b0e3e', '#d41e3c', '#ed4c40', '#ff9757', '#d4662f', '#9c341a', '#691b22', '#450c28', '#2d002e'],
  };
  function paletteColorsFor(name) { return savedPalettes[name] || BUILTIN_PALETTES[name] || DEFAULT_PALETTE; }
  const MAX_DIM = 256;
  const MIN_SCALE = 1, MAX_SCALE = 64;
  const DOC_KEY = 'pixelart.doc.v1';
  const COLOR_KEY = 'pixelart.color.v1';
  const BRUSH_KEY = 'pixelart.brush.v1';
  const FILL_KEY = 'pixelart.fillMode.v1';         // 'local' (contiguous) | 'global'
  const BRUSH_MAX = 8;
  const PALETTES_KEY = 'pixelart.palettes.v1';     // { name: [hex,...] }, global
  const ACTIVE_PAL_KEY = 'pixelart.activePalette.v1';
  const REF_KEY = 'pixelart.ref.v1';            // reference image (data URL)
  const REF_OPACITY_KEY = 'pixelart.refOpacity.v1';
  const REF_ASPECT_KEY = 'pixelart.refAspect.v1';  // fit vs. stretch the reference
  const REF_OFF_KEY = 'pixelart.refOff.v1';        // drag offset, in grid-cell units
  const REF_XFORM_KEY = 'pixelart.refXform.v1';    // reference flip/rotate: { fh, fv, rot }
  const BG_KEY = 'pixelart.bg.v1';                 // canvas background behind transparency; '' = checker
  const REF_MAX = 1024;                          // downscale cap for the stored reference

  // ── DOM ──
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const canvas = $('px');
  const ctx = canvas.getContext('2d');
  const paletteEl = $('palette');
  const curColorTop = $('curColorTop');
  const saveColorBtn = $('saveColorBtn');
  const colorInput = $('colorInput');
  const zoomLabel = $('zoomLabel');
  const newDialog = $('newDialog');
  const newW = $('newW'), newH = $('newH');

  // ── State ──
  // Layers: each layer is its own w×h `cells` array (hex-or-null per grid cell)
  // plus a 1px-per-cell offscreen buffer for fast blitting. Layers composite
  // bottom→top; opaque cells in an upper layer cover the ones below, null cells
  // reveal them. `state.cells` is an accessor onto the ACTIVE layer, so all the
  // existing single-layer draw/flood/eyedropper code keeps working unchanged.
  const state = { w: 16, h: 16, scale: 24, panX: 0, panY: 0,
    tool: 'pencil', color: '#FF004D', brush: 1, fillMode: 'local',
    layers: [], active: 0, sel: null,
    refImg: null, refOpacity: 0.5, refAspect: false, refOffX: 0, refOffY: 0, refMove: false,
    refFlipH: false, refFlipV: false, refRot: 0,   // reference reflect (mirror) + rotation in 90° steps
    bg: null };   // canvas background colour behind transparent cells; null = transparency checker
  const EMPTY_CELLS = [];
  Object.defineProperty(state, 'cells', {
    get() { const L = state.layers[state.active]; return L ? L.cells : EMPTY_CELLS; },
    set(v) { const L = state.layers[state.active]; if (L) L.cells = v; },
  });
  let layerSeq = 0;              // monotonic id source for layer objects
  // Down-sampled (w×h) copy of the reference so the eyedropper can read a
  // per-cell colour without re-reading the full-res image each pick.
  let refSample = null, refSampleCtx = null;
  let dpr = 1;
  // History entries: {t:'cells', layer, ch:[[i,before,after]], selBefore?, selAfter?}
  //              or  {t:'layers', before, after}   (full layer-stack snapshots)
  const undoStack = [], redoStack = [];
  let pending = null;            // Map(index -> beforeColor) during a stroke
  let drawing = false, panning = false, sampling = false, movingRef = false;
  // Selection (marquee) and its in-progress drag/move.
  let selecting = false, movingSel = false, selStartCell = null;
  let selOrig = null, selDX = 0, selDY = 0, selFloat = null, selMoveBefore = null;
  let lastCell = null, startCell = null, lastPan = null, lastRefPt = null, preview = null, hover = null;
  const pointers = new Map();    // pointerId -> {x,y}
  let gesture = null;            // {d, mx, my} during a two-finger pinch

  let checkerPat = null;

  // ── Helpers ──
  const clampDim = (n) => { n = Math.round(Number(n) || 1); return n < 1 ? 1 : n > MAX_DIM ? MAX_DIM : n; };
  const inBounds = (cx, cy) => cx >= 0 && cy >= 0 && cx < state.w && cy < state.h;
  const drawColor = () => (state.tool === 'eraser' ? null : state.color);

  function ptOf(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function ptToCell(p) {
    return [Math.floor((p.x - state.panX) / state.scale), Math.floor((p.y - state.panY) / state.scale)];
  }
  // Integer-snapped screen rect of one cell — adjacent cells share edges exactly
  // so there are no seams or overlaps at fractional zoom.
  function cellRect(cx, cy) {
    const x0 = Math.round(state.panX + cx * state.scale);
    const y0 = Math.round(state.panY + cy * state.scale);
    const x1 = Math.round(state.panX + (cx + 1) * state.scale);
    const y1 = Math.round(state.panY + (cy + 1) * state.scale);
    return [x0, y0, x1 - x0, y1 - y0];
  }

  // ── Layers + buffers ──
  function AL() { return state.layers[state.active]; }
  function layerById(id) { return state.layers.find((L) => L.id === id) || null; }
  function makeLayer(name, cells) {
    const b = document.createElement('canvas');
    const L = { id: 'L' + (++layerSeq), name: name || ('Layer ' + layerSeq),
      hidden: false, opacity: 1, cells: cells || new Array(state.w * state.h).fill(null),
      buf: b, bctx: b.getContext('2d') };
    rebuildLayerBuf(L);
    return L;
  }
  function rebuildLayerBuf(L) {
    L.buf.width = state.w; L.buf.height = state.h;
    L.bctx.clearRect(0, 0, state.w, state.h);
    const cells = L.cells;
    for (let i = 0; i < cells.length; i++) { const c = cells[i]; if (c) { L.bctx.fillStyle = c; L.bctx.fillRect(i % state.w, (i / state.w) | 0, 1, 1); } }
  }
  // Paint one cell in a layer's buffer (col null → clear to transparent).
  function paintBuf(L, i, col) {
    const x = i % state.w, y = (i / state.w) | 0;
    if (col) { L.bctx.fillStyle = col; L.bctx.fillRect(x, y, 1, 1); } else L.bctx.clearRect(x, y, 1, 1);
  }
  function setBuf(i, col) { paintBuf(AL(), i, col); }
  // Flatten the visible layers into a fresh 1px-per-cell canvas (thumbnail/export).
  function compositeCanvas() {
    const c = document.createElement('canvas'); c.width = Math.max(1, state.w); c.height = Math.max(1, state.h);
    const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
    for (const L of state.layers) { if (L.hidden || L.opacity <= 0) continue; g.globalAlpha = L.opacity; g.drawImage(L.buf, 0, 0); }
    g.globalAlpha = 1; return c;
  }
  // Flattened per-cell colours (top visible layer wins) — a single-layer fallback
  // for the host bridge / any consumer that only understands a flat `cells` array.
  function compositeCells() {
    const out = new Array(state.w * state.h).fill(null);
    for (const L of state.layers) { if (L.hidden) continue; const cs = L.cells; for (let i = 0; i < cs.length; i++) if (cs[i]) out[i] = cs[i]; }
    return out;
  }
  // Top-most visible painted colour at a cell (used by the eyedropper).
  function topCellColor(cx, cy) {
    const i = cy * state.w + cx;
    for (let k = state.layers.length - 1; k >= 0; k--) { const L = state.layers[k]; if (L.hidden) continue; const c = L.cells[i]; if (c) return c; }
    return null;
  }

  // ── Render ──
  function makeChecker() {
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const g = c.getContext('2d');
    g.fillStyle = '#1b1c22'; g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#23242b'; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8);
    return c;
  }
  function render() {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#14151a'; ctx.fillRect(0, 0, W, H);
    if (!state.cells.length) return;
    const ax = Math.round(state.panX), ay = Math.round(state.panY);
    const aw = Math.round(state.panX + state.w * state.scale) - ax;
    const ah = Math.round(state.panY + state.h * state.scale) - ay;
    // Underlay: the transparency checker, then the reference image on top (at
    // its opacity) when one is loaded. The reference honours the fit mode and
    // drag offset (see refRectCells); a dark backing under it keeps the tracing
    // contrast identical to fill mode, while the checker shows in any grid area
    // the reference doesn't cover. Then the cells on top — opaque cells cover
    // the underlay; transparent cells reveal it.
    // A chosen background colour replaces the checker behind transparent cells
    // (purely an editor aid — exports and thumbnails keep real transparency).
    if (state.bg) { ctx.fillStyle = state.bg; ctx.fillRect(ax, ay, aw, ah); }
    else if (checkerPat) { ctx.fillStyle = checkerPat; ctx.fillRect(ax, ay, aw, ah); }
    if (state.refImg && state.refOpacity > 0) {
      const [cx, cy, cw, ch] = refRectCells();
      const rx = state.panX + cx * state.scale, ry = state.panY + cy * state.scale;
      const rw = cw * state.scale, rh = ch * state.scale;
      ctx.fillStyle = state.bg || '#14151a'; ctx.fillRect(rx, ry, rw, rh);
      ctx.save();
      ctx.globalAlpha = state.refOpacity;
      // Point (nearest-neighbour) sampling so the reference stays crisp when the
      // canvas is zoomed in — matches the pixel-art workflow, and every other
      // draw in this file already samples this way.
      ctx.imageSmoothingEnabled = false;
      drawRefTransformed(ctx, rx, ry, rw, rh);
      ctx.restore();
    }
    ctx.imageSmoothingEnabled = false;
    // Composite the layers bottom→top, each at its own opacity. During a
    // selection drag the active layer has its lifted pixels cleared out; the
    // floating copy is drawn by drawSelection() at the end.
    for (const L of state.layers) {
      if (L.hidden || L.opacity <= 0) continue;
      ctx.globalAlpha = L.opacity;
      ctx.drawImage(L.buf, 0, 0, state.w, state.h, ax, ay, aw, ah);
    }
    ctx.globalAlpha = 1;
    // Tool preview (line / rect) in the active colour.
    if (preview && preview.length) {
      ctx.globalAlpha = 0.8; ctx.fillStyle = state.color;
      for (const [cx, cy] of preview) { if (!inBounds(cx, cy)) continue; const [x, y, w, h] = cellRect(cx, cy); ctx.fillRect(x, y, w, h); }
      ctx.globalAlpha = 1;
    }
    // Grid lines once cells are large enough to be useful.
    if (state.scale >= 11) {
      ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1; ctx.beginPath();
      for (let cx = 0; cx <= state.w; cx++) { const x = Math.round(state.panX + cx * state.scale) + 0.5; ctx.moveTo(x, ay); ctx.lineTo(x, ay + ah); }
      for (let cy = 0; cy <= state.h; cy++) { const y = Math.round(state.panY + cy * state.scale) + 0.5; ctx.moveTo(ax, y); ctx.lineTo(ax + aw, y); }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1;
    ctx.strokeRect(ax + 0.5, ay + 0.5, aw - 1, ah - 1);
    if (hover && !drawing && inBounds(hover[0], hover[1])) {
      // Brush-size-aware footprint for the pencil/eraser; a single cell otherwise.
      const bs = (state.tool === 'pencil' || state.tool === 'eraser') ? state.brush : 1;
      const o = bs >> 1;
      const p0 = cellRect(hover[0] - o, hover[1] - o), p1 = cellRect(hover[0] - o + bs - 1, hover[1] - o + bs - 1);
      const X = p0[0], Y = p0[1], Wd = (p1[0] + p1[2]) - p0[0], Hd = (p1[1] + p1[3]) - p0[1];
      ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.strokeRect(X + 0.5, Y + 0.5, Wd - 1, Hd - 1);
    }
    if (state.sel) drawSelection();
  }

  // ── Cell ops + history ──
  function paintCell(cx, cy, col) {
    if (!inBounds(cx, cy)) return;
    const i = cy * state.w + cx;
    if (state.cells[i] === col) return;
    if (pending && !pending.has(i)) pending.set(i, state.cells[i]);
    state.cells[i] = col; setBuf(i, col);
  }
  function beginStroke() { pending = new Map(); }
  function pushHistory(entry) { undoStack.push(entry); if (undoStack.length > 150) undoStack.shift(); redoStack.length = 0; }
  function commitStroke() {
    if (pending && pending.size) {
      const L = AL(), ch = [];
      for (const [i, before] of pending) { if (before !== L.cells[i]) ch.push([i, before, L.cells[i]]); }
      if (ch.length) { pushHistory({ t: 'cells', layer: L.id, ch }); scheduleSave(); }
    }
    pending = null;
  }
  function cancelStroke() {
    if (movingRef) { movingRef = false; buildRefSample(); saveRefTransform(); }
    if (movingSel) { const L = AL(); if (selMoveBefore) { L.cells = selMoveBefore; rebuildLayerBuf(L); } movingSel = false; selFloat = null; selMoveBefore = null; }
    selecting = false;
    if (pending) { for (const [i, before] of pending) { state.cells[i] = before; setBuf(i, before); } pending = null; }
    drawing = false; sampling = false; preview = null; lastCell = startCell = null; render();
  }
  // Apply a cells diff to its recorded layer (by id), restoring the marquee too
  // when the step carries one (selection moves/deletes).
  function applyCellsOp(entry, useBefore) {
    const L = layerById(entry.layer); if (!L) return;
    for (const [i, before, after] of entry.ch) { const v = useBefore ? before : after; L.cells[i] = v; paintBuf(L, i, v); }
    const sv = useBefore ? entry.selBefore : entry.selAfter;
    if (sv) state.sel = { x: sv.x, y: sv.y, w: sv.w, h: sv.h };
    else if (entry.selBefore || entry.selAfter) state.sel = null;
  }
  function layerSnapshot() {
    return { active: state.active, layers: state.layers.map((L) => ({ id: L.id, name: L.name, hidden: L.hidden, opacity: L.opacity, cells: L.cells.slice() })) };
  }
  function restoreSnapshot(snap) {
    state.layers = snap.layers.map((s) => { const L = makeLayer(s.name, s.cells.slice()); L.id = s.id; L.hidden = s.hidden; L.opacity = s.opacity; return L; });
    state.active = Math.min(Math.max(0, snap.active), state.layers.length - 1);
  }
  function applyHistory(entry, useBefore) {
    if (entry.t === 'layers') restoreSnapshot(useBefore ? entry.before : entry.after);
    else applyCellsOp(entry, useBefore);
  }
  function afterHistory() { renderLayerPanel(); updateSelUI(); render(); scheduleSave(); }
  function undo() { const e = undoStack.pop(); if (!e) return; applyHistory(e, true); redoStack.push(e); afterHistory(); }
  function redo() { const e = redoStack.pop(); if (!e) return; applyHistory(e, false); undoStack.push(e); afterHistory(); }
  function clearHistory() { undoStack.length = 0; redoStack.length = 0; pending = null; }

  // Pixel geometry helpers.
  function lineCells(x0, y0, x1, y1) {
    const pts = []; let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx - dy;
    for (;;) { pts.push([x0, y0]); if (x0 === x1 && y0 === y1) break; const e2 = 2 * err; if (e2 > -dy) { err -= dy; x0 += sx; } if (e2 < dx) { err += dx; y0 += sy; } }
    return pts;
  }
  function rectCells(x0, y0, x1, y1) {
    const xa = Math.min(x0, x1), xb = Math.max(x0, x1), ya = Math.min(y0, y1), yb = Math.max(y0, y1), pts = [];
    for (let x = xa; x <= xb; x++) { pts.push([x, ya], [x, yb]); }
    for (let y = ya + 1; y < yb; y++) { pts.push([xa, y], [xb, y]); }
    return pts;
  }
  function floodFill(cx, cy, col) {
    const i0 = cy * state.w + cx, target = state.cells[i0];
    if (target === col) return;
    const stack = [[cx, cy]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (!inBounds(x, y)) continue;
      if (state.cells[y * state.w + x] !== target) continue;
      paintCell(x, y, col);
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  }
  // "Global" fill (magic-wand-by-colour): recolour EVERY cell on the active layer
  // that matches the clicked colour, not just the contiguous region. Same
  // active-layer scope + single-undo-step as floodFill (paintCell records to
  // `pending`). Colour match is strict (===), identical to floodFill's contiguity
  // test, so Local/Global differ only in reach, not in what counts as "same".
  function fillGlobal(cx, cy, col) {
    const target = state.cells[cy * state.w + cx];
    if (target === col) return;
    const w = state.w, cells = state.cells;
    for (let i = 0; i < cells.length; i++) if (cells[i] === target) paintCell(i % w, (i / w) | 0, col);
  }

  // ── Brush ──
  // Square stamp centred on the cursor cell; size 1 = single pixel. Used by the
  // pencil/eraser only (line/rect stay 1px-precise). paintCell dedups repeats
  // within a stroke, so overlapping stamps along a drag don't double-record.
  function stampCells(cx, cy, col) {
    const bs = state.brush | 0;
    if (bs <= 1) { paintCell(cx, cy, col); return; }
    const o = bs >> 1;
    for (let y = 0; y < bs; y++) for (let x = 0; x < bs; x++) paintCell(cx - o + x, cy - o + y, col);
  }

  // ── Selection (marquee move) ──
  const clampCell = (v, n) => (v < 0 ? 0 : v > n - 1 ? n - 1 : v);
  const normRect = (a, b) => ({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]) + 1, h: Math.abs(a[1] - b[1]) + 1 });
  const inSel = (c, s) => !!s && c[0] >= s.x && c[1] >= s.y && c[0] < s.x + s.w && c[1] < s.y + s.h;
  // Copy the region's colours into a flat w×h array (out-of-bounds → null).
  function extractRegion(cells, s) {
    const out = new Array(s.w * s.h).fill(null);
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) { const sx = s.x + x, sy = s.y + y; if (inBounds(sx, sy)) out[y * s.w + x] = cells[sy * state.w + sx]; }
    return out;
  }
  function clearRegion(cells, s) {
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) { const sx = s.x + x, sy = s.y + y; if (inBounds(sx, sy)) cells[sy * state.w + sx] = null; }
  }
  // Composite the region back in at an offset (null cells skipped, so overlaps
  // don't erase what's beneath).
  function blitRegion(cells, region, s, nx, ny) {
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) { const col = region[y * s.w + x]; if (!col) continue; const dx = nx + x, dy = ny + y; if (inBounds(dx, dy)) cells[dy * state.w + dx] = col; }
  }
  function diffCh(before, after) { const ch = []; for (let i = 0; i < after.length; i++) if (before[i] !== after[i]) ch.push([i, before[i], after[i]]); return ch; }
  // Record a cells change on a layer as one undo step, optionally carrying the
  // marquee so undo/redo also restore where it sat.
  function pushCellsChange(L, before, after, selBefore, selAfter) {
    const ch = diffCh(before, after);
    if (!ch.length) return;
    pushHistory({ t: 'cells', layer: L.id, ch, selBefore, selAfter });
    scheduleSave();
  }
  // Nudge the selection + the pixels under it by whole cells (one undo step each).
  function nudgeSelection(dx, dy) {
    const s = state.sel; if (!s || (!dx && !dy)) return;
    const L = AL(); const before = L.cells.slice();
    const region = extractRegion(before, s);
    const base = before.slice(); clearRegion(base, s);
    const selBefore = { x: s.x, y: s.y, w: s.w, h: s.h };
    const nx = s.x + dx, ny = s.y + dy;
    blitRegion(base, region, s, nx, ny);
    L.cells = base; rebuildLayerBuf(L);
    s.x = nx; s.y = ny;
    pushCellsChange(L, before, base, selBefore, { x: nx, y: ny, w: s.w, h: s.h });
    render();
  }
  // Clear the pixels inside the selection on the active layer.
  function deleteSelection() {
    const s = state.sel; if (!s) return;
    const L = AL(); const before = L.cells.slice(); const after = before.slice();
    clearRegion(after, s);
    L.cells = after; rebuildLayerBuf(L);
    pushCellsChange(L, before, after);
    render();
  }
  function deselect() { if (!state.sel && !movingSel) return; state.sel = null; movingSel = false; selFloat = null; updateSelUI(); render(); }
  function drawSelection() {
    const s = state.sel; if (!s) return;
    let rx = s.x, ry = s.y;
    if (movingSel) {
      rx = selOrig.x + selDX; ry = selOrig.y + selDY;
      // The lifted pixels, floating at the dragged position.
      for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
        const col = selFloat[y * s.w + x]; if (!col) continue;
        const cx = rx + x, cy = ry + y; if (!inBounds(cx, cy)) continue;
        const [sx, sy, sw, sh] = cellRect(cx, cy); ctx.fillStyle = col; ctx.fillRect(sx, sy, sw, sh);
      }
    }
    // Marching-ants outline (static dash: dark base + bright dashes).
    const p0 = cellRect(rx, ry), p1 = cellRect(rx + s.w - 1, ry + s.h - 1);
    const X = p0[0], Y = p0[1], Wd = (p1[0] + p1[2]) - p0[0], Hd = (p1[1] + p1[3]) - p0[1];
    ctx.save(); ctx.lineWidth = 1;
    ctx.setLineDash([]); ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.strokeRect(X + 0.5, Y + 0.5, Wd - 1, Hd - 1);
    ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.strokeRect(X + 0.5, Y + 0.5, Wd - 1, Hd - 1);
    ctx.restore();
  }

  // ── Layer operations ──
  // Structural changes (add/dup/delete/move/rename) snapshot the whole stack so
  // they undo/redo as a single step; view toggles (hide, opacity) are live and
  // not pushed to history.
  function layerStructOp(mutate) {
    const before = layerSnapshot(); mutate(); const after = layerSnapshot();
    pushHistory({ t: 'layers', before, after });
    renderLayerPanel(); render(); scheduleSave();
  }
  function addLayer() {
    layerStructOp(() => {
      const L = makeLayer('Layer ' + (state.layers.length + 1));
      state.layers.splice(state.active + 1, 0, L);   // just above the active layer
      state.active += 1; state.sel = null;
    });
  }
  function duplicateLayer() {
    layerStructOp(() => {
      const src = AL(); const L = makeLayer(src.name + ' copy', src.cells.slice());
      L.opacity = src.opacity; L.hidden = src.hidden;
      state.layers.splice(state.active + 1, 0, L); state.active += 1; state.sel = null;
    });
  }
  function deleteLayer() {
    if (state.layers.length <= 1) return;   // always keep at least one layer
    layerStructOp(() => {
      state.layers.splice(state.active, 1);
      state.active = Math.min(state.active, state.layers.length - 1);
      state.sel = null;
    });
  }
  function moveLayer(dir) {   // dir: +1 = up the stack, -1 = down
    const i = state.active, j = i + dir;
    if (j < 0 || j >= state.layers.length) return;
    layerStructOp(() => { const t = state.layers[i]; state.layers[i] = state.layers[j]; state.layers[j] = t; state.active = j; });
  }
  function setActiveLayer(i) {
    if (i < 0 || i >= state.layers.length) { renderLayerPanel(); return; }
    state.active = i; renderLayerPanel(); render();
  }
  function toggleLayerHidden(i) { const L = state.layers[i]; if (!L) return; L.hidden = !L.hidden; renderLayerPanel(); render(); scheduleSave(); }
  function setLayerOpacity(v) { const L = AL(); if (!L) return; L.opacity = Math.max(0, Math.min(1, v)); render(); scheduleSave(); }
  function renameLayer(i) {
    const L = state.layers[i]; if (!L) return;
    let name = null; try { name = prompt('Layer name', L.name); } catch (_) {}
    if (name == null) return;
    layerStructOp(() => { L.name = name.trim() || L.name; });
  }

  // ── Layer panel + selection/brush UI sync ──
  const EYE_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.8 17.8 0 0 1-3.3 4.1M6.1 6.1A17.8 17.8 0 0 0 2 12s3.5 7 10 7a10.9 10.9 0 0 0 3.5-.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  function drawLayerThumb(cv, L) {
    const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#1b1c22'; g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#2a2b33';
    for (let y = 0; y < cv.height; y += 6) for (let x = 0; x < cv.width; x += 6) if ((((x / 6) | 0) + ((y / 6) | 0)) & 1) g.fillRect(x, y, 6, 6);
    g.imageSmoothingEnabled = false;
    const s = Math.max(1, Math.floor(Math.min(cv.width / state.w, cv.height / state.h)) || 1);
    const w = state.w * s, h = state.h * s, ox = ((cv.width - w) / 2) | 0, oy = ((cv.height - h) / 2) | 0;
    g.globalAlpha = L.hidden ? 0.25 : 1;
    try { g.drawImage(L.buf, 0, 0, state.w, state.h, ox, oy, w, h); } catch (_) {}
    g.globalAlpha = 1;
  }
  function renderLayerPanel() {
    const list = $('layersList'); if (!list) return;
    list.innerHTML = '';
    for (let k = state.layers.length - 1; k >= 0; k--) {   // top of the stack first
      const L = state.layers[k];
      const row = document.createElement('div');
      row.className = 'layerrow' + (k === state.active ? ' active' : '');
      const eye = document.createElement('button');
      eye.className = 'layereye' + (L.hidden ? ' off' : '');
      eye.innerHTML = L.hidden ? EYE_OFF : EYE_ON; eye.title = L.hidden ? 'Show layer' : 'Hide layer';
      eye.onclick = (e) => { e.stopPropagation(); toggleLayerHidden(k); };
      const th = document.createElement('canvas'); th.className = 'layerthumb'; th.width = 30; th.height = 30;
      drawLayerThumb(th, L);
      const nm = document.createElement('span'); nm.className = 'layername'; nm.textContent = L.name;
      nm.title = 'Double-tap to rename';
      nm.ondblclick = (e) => { e.stopPropagation(); renameLayer(k); };
      row.appendChild(eye); row.appendChild(th); row.appendChild(nm);
      row.onclick = () => setActiveLayer(k);
      list.appendChild(row);
    }
    const op = $('layerOpacity'); if (op) op.value = Math.round((AL() ? AL().opacity : 1) * 100);
    const del = $('layerDelete'); if (del) del.disabled = state.layers.length <= 1;
    const btn = $('layersBtn'); if (btn) btn.classList.toggle('multi', state.layers.length > 1);
  }
  function updateSelUI() { const bar = $('selBar'); if (bar) bar.style.display = state.sel ? 'flex' : 'none'; }
  // Fill-mode bar: only visible while the fill tool is active; segmented Local/Global.
  function updateFillUI() {
    const bar = $('fillBar'); if (bar) bar.style.display = state.tool === 'fill' ? 'flex' : 'none';
    const lo = $('fillLocal'), gl = $('fillGlobal');
    if (lo) lo.classList.toggle('active', state.fillMode !== 'global');
    if (gl) gl.classList.toggle('active', state.fillMode === 'global');
  }
  function setFillMode(m) {
    state.fillMode = (m === 'global') ? 'global' : 'local';
    try { localStorage.setItem(FILL_KEY, state.fillMode); } catch (_) {}
    updateFillUI();
  }
  function updateBrushUI() {
    const sl = $('brushSize'); if (sl) sl.value = state.brush;
    const v = $('brushSizeVal'); if (v) v.textContent = state.brush + ' px';
    const badge = $('brushBadge'); if (badge) badge.textContent = state.brush;
  }

  // ── Zoom / pan ──
  function setZoomLabel() { zoomLabel.textContent = Math.round(state.scale) + 'px'; }
  function zoomAround(sx, sy, f) {
    const ns = Math.max(MIN_SCALE, Math.min(MAX_SCALE, state.scale * f));
    if (ns === state.scale) return;
    state.panX = sx - (sx - state.panX) * (ns / state.scale);
    state.panY = sy - (sy - state.panY) * (ns / state.scale);
    state.scale = ns; setZoomLabel();
  }
  function zoomButton(f) { zoomAround(canvas.clientWidth / 2, canvas.clientHeight / 2, f); render(); }
  function fitView() {
    const W = canvas.clientWidth, H = canvas.clientHeight, m = 28;
    const s = Math.min((W - m * 2) / state.w, (H - m * 2) / state.h);
    state.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.floor(s) || 1));
    state.panX = Math.round((W - state.w * state.scale) / 2);
    state.panY = Math.round((H - state.h * state.scale) / 2);
    setZoomLabel();
  }

  // ── Pointer input ──
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function startGesture() { const p = [...pointers.values()]; gesture = { d: dist(p[0], p[1]) || 1, mx: (p[0].x + p[1].x) / 2, my: (p[0].y + p[1].y) / 2 }; }
  function updateGesture() {
    const p = [...pointers.values()]; if (p.length < 2) return;
    const d = dist(p[0], p[1]) || 1, mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2;
    zoomAround(gesture.mx, gesture.my, d / gesture.d);
    state.panX += mx - gesture.mx; state.panY += my - gesture.my;
    gesture = { d, mx, my }; render();
  }

  // Pick the colour under a cell: a painted cell → its colour, otherwise the
  // reference image underneath. Used on eyedropper press AND drag.
  function sampleAt(c) {
    if (!inBounds(c[0], c[1])) return;
    const col = topCellColor(c[0], c[1]);   // top-most visible painted layer
    if (col) setActiveColor(col);
    else { const rc = sampleReference(c[0], c[1]); if (rc) setActiveColor(rc); }
  }
  function onDown(e) {
    const p = ptOf(e), c = ptToCell(p);
    // Middle-mouse always pans, whatever the tool.
    if (e.pointerType === 'mouse' && e.button === 1) { panning = true; lastPan = p; return; }
    // Reference-move mode: a drag repositions the tracing underlay, not the pixels.
    if (state.refMove && state.refImg) { movingRef = true; lastRefPt = p; return; }
    if (state.tool === 'pan') { panning = true; lastPan = p; return; }
    if (state.tool === 'select') {
      if (inSel(c, state.sel)) {
        // Drag started inside the marquee → lift its pixels off the active layer
        // into a floating copy; the drop is committed on pointer-up.
        const L = AL(); movingSel = true; selStartCell = c;
        selMoveBefore = L.cells.slice();
        selFloat = extractRegion(selMoveBefore, state.sel);
        const base = selMoveBefore.slice(); clearRegion(base, state.sel);
        L.cells = base; rebuildLayerBuf(L);
        selOrig = { x: state.sel.x, y: state.sel.y }; selDX = 0; selDY = 0;
        render(); return;
      }
      // Otherwise rubber-band a new rectangle.
      selecting = true; selStartCell = [clampCell(c[0], state.w), clampCell(c[1], state.h)];
      state.sel = normRect(selStartCell, selStartCell); updateSelUI(); render(); return;
    }
    if (state.tool === 'eyedropper') {
      // Keep sampling while the finger/mouse is held + dragged.
      sampling = true; hover = c; sampleAt(c); render(); return;
    }
    if (state.tool === 'fill') { if (inBounds(c[0], c[1])) { beginStroke(); (state.fillMode === 'global' ? fillGlobal : floodFill)(c[0], c[1], drawColor()); commitStroke(); render(); } return; }
    if (state.tool === 'line' || state.tool === 'rect') { drawing = true; startCell = c; preview = [c]; render(); return; }
    // pencil / eraser
    drawing = true; beginStroke(); lastCell = c; stampCells(c[0], c[1], drawColor()); render();
  }
  function onMove(e) {
    const p = ptOf(e), c = ptToCell(p);
    if (panning) { state.panX += p.x - lastPan.x; state.panY += p.y - lastPan.y; lastPan = p; render(); return; }
    if (movingRef) {
      state.refOffX += (p.x - lastRefPt.x) / state.scale;
      state.refOffY += (p.y - lastRefPt.y) / state.scale;
      lastRefPt = p; render(); return;
    }
    if (movingSel) { selDX = c[0] - selStartCell[0]; selDY = c[1] - selStartCell[1]; render(); return; }
    if (selecting) { state.sel = normRect(selStartCell, [clampCell(c[0], state.w), clampCell(c[1], state.h)]); render(); return; }
    if (sampling) { hover = c; sampleAt(c); render(); return; }   // live colour pick while dragging
    if (!drawing) { hover = c; render(); return; }
    if (state.tool === 'line') { preview = lineCells(startCell[0], startCell[1], c[0], c[1]); render(); return; }
    if (state.tool === 'rect') { preview = rectCells(startCell[0], startCell[1], c[0], c[1]); render(); return; }
    if (c[0] !== lastCell[0] || c[1] !== lastCell[1]) {
      for (const [x, y] of lineCells(lastCell[0], lastCell[1], c[0], c[1])) stampCells(x, y, drawColor());
      lastCell = c; render();
    }
  }
  function onUp() {
    if (panning) { panning = false; return; }
    if (movingRef) { movingRef = false; buildRefSample(); saveRefTransform(); return; }
    if (movingSel) {
      const L = AL(); const nx = selOrig.x + selDX, ny = selOrig.y + selDY;
      blitRegion(L.cells, selFloat, state.sel, nx, ny); rebuildLayerBuf(L);
      const selBefore = { x: selOrig.x, y: selOrig.y, w: state.sel.w, h: state.sel.h };
      state.sel = { x: nx, y: ny, w: state.sel.w, h: state.sel.h };
      pushCellsChange(L, selMoveBefore, L.cells, selBefore, { x: nx, y: ny, w: state.sel.w, h: state.sel.h });
      movingSel = false; selFloat = null; selMoveBefore = null; render(); return;
    }
    if (selecting) {
      selecting = false;
      // A plain tap (no drag) clears the selection instead of leaving a 1×1 one.
      if (state.sel && state.sel.w === 1 && state.sel.h === 1) state.sel = null;
      updateSelUI(); render(); return;
    }
    if (sampling) { sampling = false; return; }
    if (!drawing) return;
    if (preview && (state.tool === 'line' || state.tool === 'rect')) {
      beginStroke(); for (const [x, y] of preview) paintCell(x, y, drawColor()); commitStroke();
    } else {
      commitStroke();
    }
    drawing = false; preview = null; lastCell = startCell = null; render();
  }

  function wirePointer() {
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      pointers.set(e.pointerId, ptOf(e));
      if (pointers.size === 2) { cancelStroke(); startGesture(); return; }
      if (pointers.size > 2) return;
      onDown(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) { if (pointers.size === 0 && e.pointerType === 'mouse') { hover = ptToCell(ptOf(e)); render(); } return; }
      pointers.set(e.pointerId, ptOf(e));
      if (pointers.size >= 2) { updateGesture(); return; }
      onMove(e);
    });
    const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) gesture = null; if (pointers.size === 0) onUp(e); };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', () => { if (!drawing && hover) { hover = null; render(); } });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomAround(ptOf(e).x, ptOf(e).y, Math.exp(-e.deltaY * 0.0015)); render(); }, { passive: false });
  }

  // ── Palette / colour ──
  const hasColor = (col) => PALETTE.some((c) => c.toLowerCase() === col.toLowerCase());
  function buildPalette() {
    // Keep the current-colour chip (first child); rebuild only the swatches.
    paletteEl.querySelectorAll('.swatch').forEach((s) => s.remove());
    for (const col of PALETTE) {
      const b = document.createElement('button');
      b.className = 'swatch'; b.style.background = col; b.title = col;
      b.dataset.col = col;
      b.onclick = () => setActiveColor(col);
      paletteEl.appendChild(b);
    }
    markActiveSwatch();
  }
  function markActiveSwatch() {
    paletteEl.querySelectorAll('.swatch').forEach((s) =>
      s.classList.toggle('active', s.dataset.col.toLowerCase() === state.color.toLowerCase()));
    // The "save current colour" button is only useful when the colour isn't
    // already a swatch — disable it (with a hint) once it's been saved.
    if (saveColorBtn) {
      const saved = hasColor(state.color);
      saveColorBtn.disabled = saved;
      saveColorBtn.title = saved ? 'Current colour is already in the palette' : 'Save current colour to palette';
    }
  }
  function setActiveColor(col) {
    state.color = col;
    curColorTop.style.background = col;
    try { colorInput.value = col; } catch (_) {}
    // If we're on the eraser, picking a colour flips back to the pencil.
    if (state.tool === 'eraser') selectTool('pencil');
    markActiveSwatch();
    try { localStorage.setItem(COLOR_KEY, col); } catch (_) {}
  }
  function addCustomColor(col) { addPaletteColor(col); setActiveColor(col); }

  // ── Palette manager (global, named palettes) ──
  function persistPalettes() { try { localStorage.setItem(PALETTES_KEY, JSON.stringify(savedPalettes)); } catch (_) {} }
  function persistActivePaletteName() { try { localStorage.setItem(ACTIVE_PAL_KEY, activePaletteName); } catch (_) {} }
  // Edits to a *named* palette write straight back to the global store; the
  // built-in default stays a pristine baseline (edit then "Save as…" to keep).
  function persistIfNamed() { if (activePaletteName && savedPalettes[activePaletteName]) { savedPalettes[activePaletteName] = PALETTE.slice(); persistPalettes(); } }
  const isKnownPalette = (name) => !!(name && (savedPalettes[name] || BUILTIN_PALETTES[name]));
  function loadPalettes() {
    try { const s = JSON.parse(localStorage.getItem(PALETTES_KEY) || 'null'); if (s && typeof s === 'object') savedPalettes = s; } catch (_) {}
    let a = ''; try { a = localStorage.getItem(ACTIVE_PAL_KEY) || ''; } catch (_) {}
    activePaletteName = isKnownPalette(a) ? a : '';
    PALETTE = activePaletteName ? paletteColorsFor(activePaletteName).slice() : DEFAULT_PALETTE.slice();
  }
  function selectPalette(name) {
    activePaletteName = isKnownPalette(name) ? name : '';
    PALETTE = activePaletteName ? paletteColorsFor(activePaletteName).slice() : DEFAULT_PALETTE.slice();
    persistActivePaletteName();
    buildPalette(); renderPalettePanel();
  }
  function addPaletteColor(col) {
    if (hasColor(col)) return;
    PALETTE.push(col); persistIfNamed(); buildPalette(); renderPalettePanel();
  }
  function removePaletteColor(i) {
    if (i < 0 || i >= PALETTE.length || PALETTE.length <= 1) return;
    PALETTE.splice(i, 1); persistIfNamed(); buildPalette(); renderPalettePanel();
  }
  // Replace every pixel of colour `from` with `to` across all layers, in one
  // undoable step, then repoint the palette swatch from→to. `to` defaults to the
  // current colour Y, so the flow is: eyedrop/pick Y, then hit a swatch's ⇄.
  function replaceColor(from, to) {
    if (!from || !to) return;
    const f = from.toLowerCase(), t = to.toLowerCase();
    if (f === t) return;                                   // nothing to do
    const before = layerSnapshot();
    let changed = 0;
    for (const L of state.layers) {
      const cs = L.cells; let dirty = false;
      for (let i = 0; i < cs.length; i++) { if (cs[i] && cs[i].toLowerCase() === f) { cs[i] = to; dirty = true; changed++; } }
      if (dirty) rebuildLayerBuf(L);
    }
    if (changed) pushHistory({ t: 'layers', before, after: layerSnapshot() });
    // Keep the palette coherent: the X slot becomes Y (or is dropped if Y is
    // already a swatch). Palette edits aren't in the undo stack (matching
    // add/removePaletteColor), so undo restores the art but leaves the palette.
    const idx = PALETTE.findIndex((c) => c.toLowerCase() === f);
    if (idx >= 0) {
      if (PALETTE.some((c, k) => k !== idx && c.toLowerCase() === t)) PALETTE.splice(idx, 1);
      else PALETTE[idx] = to;
      persistIfNamed();
    }
    setActiveColor(to); buildPalette(); renderPalettePanel(); render(); scheduleSave();
  }
  function savePaletteAsPrompt() {
    let name = null; try { name = prompt('Save palette as', activePaletteName || 'My palette'); } catch (_) {}
    if (name == null) return; name = name.trim(); if (!name) return;
    savedPalettes[name] = PALETTE.slice(); activePaletteName = name;
    persistPalettes(); persistActivePaletteName(); renderPalettePanel();
  }
  function deleteActivePalette() {
    if (!savedPalettes[activePaletteName]) return;   // only user palettes are deletable
    delete savedPalettes[activePaletteName]; persistPalettes();
    selectPalette('');   // fall back to the default
  }
  function renderPalettePanel() {
    const sel = $('paletteSelect');
    if (sel) {
      sel.innerHTML = '';
      const mk = (val, label) => { const o = document.createElement('option'); o.value = val; o.textContent = label; return o; };
      const grp = (label, names) => { const g = document.createElement('optgroup'); g.label = label; for (const n of names) g.appendChild(mk(n, n)); return g; };
      sel.appendChild(mk('', 'PICO-8 (default)'));
      sel.appendChild(grp('Presets', Object.keys(BUILTIN_PALETTES)));
      const saved = Object.keys(savedPalettes).sort();
      if (saved.length) sel.appendChild(grp('Saved', saved));
      sel.value = activePaletteName;
    }
    const del = $('paletteDelete'); if (del) del.disabled = !savedPalettes[activePaletteName];
    const list = $('palEditList');
    if (list) {
      list.innerHTML = '';
      PALETTE.forEach((col, i) => {
        const b = document.createElement('button'); b.className = 'paledit'; b.style.background = col; b.title = col;
        b.onclick = () => setActiveColor(col);
        const x = document.createElement('span'); x.className = 'paledit-x'; x.textContent = '×'; x.title = 'Remove colour';
        x.onclick = (e) => { e.stopPropagation(); removePaletteColor(i); };
        // Replace this colour (X) everywhere with the current colour (Y). Hidden
        // when the swatch already IS the current colour (no-op).
        const isCur = col.toLowerCase() === state.color.toLowerCase();
        const r = document.createElement('span'); r.className = 'paledit-r'; r.textContent = '⇄';
        r.title = 'Replace ' + col + ' with the current colour everywhere';
        if (isCur) r.style.display = 'none';
        r.onclick = (e) => { e.stopPropagation(); replaceColor(col, state.color); };
        b.appendChild(x); b.appendChild(r); list.appendChild(b);
      });
    }
  }

  // ── Palette import (standard palette files) ──
  // Auto-detects by magic bytes / extension and pulls out an ordered list of
  // hex colours: Adobe .ase / .aco / .act, Microsoft RIFF .pal, GIMP .gpl,
  // JASC .pal, Paint.NET / hex / CSS text, and palette images (PNG/GIF/… — the
  // unique colours left→right, e.g. a Lospec strip). All parsing is on a
  // user-picked local file; nothing hits the network.
  const _hex = (r, g, b) => '#' + [r, g, b].map((x) => { x = x < 0 ? 0 : x > 255 ? 255 : x | 0; return x.toString(16).padStart(2, '0'); }).join('');
  const _v255 = (r, g, b) => [r, g, b].every((x) => x >= 0 && x <= 255);
  function _dedupeHex(cols) {
    const seen = new Set(), out = [];
    for (let c of cols) { if (!c) continue; c = String(c).toLowerCase(); if (!/^#[0-9a-f]{6}$/.test(c)) continue; if (!seen.has(c)) { seen.add(c); out.push(c); } }
    return out;
  }
  function _baseName(fn) { return String(fn || 'palette').replace(/\.[^.]+$/, '').trim() || 'palette'; }
  function _decodeText(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes); } catch (_) {}
    let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s;
  }
  function parseGPL(text) {
    const cols = []; let name = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line[0] === '#' || /^GIMP Palette/i.test(line) || /^Columns\s*:/i.test(line)) continue;
      const nm = line.match(/^Name\s*:\s*(.+)$/i); if (nm) { name = nm[1].trim(); continue; }
      const n = line.match(/\d+/g); if (n && n.length >= 3 && _v255(+n[0], +n[1], +n[2])) cols.push(_hex(+n[0], +n[1], +n[2]));
    }
    return { colors: cols, name };
  }
  function parseJASC(text) {
    const lines = text.split(/\r?\n/), cols = [];   // line 0: JASC-PAL, 1: version, 2: count
    for (let i = 3; i < lines.length; i++) { const n = lines[i].trim().match(/\d+/g); if (n && n.length >= 3 && _v255(+n[0], +n[1], +n[2])) cols.push(_hex(+n[0], +n[1], +n[2])); }
    return { colors: cols, name: null };
  }
  // Hex lists, CSS, Paint.NET (AARRGGBB), and headerless "R G B" text.
  function parseGenericText(text) {
    const cols = [];
    for (let raw of text.split(/\r?\n/)) {
      const line = raw.replace(/;.*$/, '').replace(/\/\/.*$/, '').trim();
      if (!line) continue;
      const m = line.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      if (m) { cols.push(_hex(+m[1], +m[2], +m[3])); continue; }
      const hexm = line.match(/#?[0-9a-fA-F]{6,8}\b/g);
      if (hexm) { for (let t of hexm) { t = t.replace('#', ''); if (t.length === 8) cols.push('#' + t.slice(2).toLowerCase()); else if (t.length === 6) cols.push('#' + t.toLowerCase()); } continue; }
      const n = line.match(/-?\d+/g);
      if (n && n.length >= 3 && _v255(+n[0], +n[1], +n[2])) cols.push(_hex(+n[0], +n[1], +n[2]));
    }
    return { colors: cols, name: null };
  }
  function parseTextPalette(text) {
    const first = (text.split(/\r?\n/).find((l) => l.trim()) || '').trim();
    if (/^GIMP Palette/i.test(first)) return parseGPL(text);
    if (/^JASC-PAL/i.test(first)) return parseJASC(text);
    return parseGenericText(text);
  }
  // Adobe Color Table: raw big-endian RGB triples; CS2 appends a uint16 count at 768.
  function parseACT(buf) {
    const v = new DataView(buf), cols = [];
    let count = Math.floor(buf.byteLength / 3);
    if (buf.byteLength >= 772) { const c = v.getUint16(768, false); if (c > 0 && c <= 256) count = c; }
    count = Math.min(count, 256);
    for (let i = 0; i < count; i++) { const o = i * 3; cols.push(_hex(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2))); }
    return cols;
  }
  // Adobe Color Swatch v1 section (uint16 ver, uint16 count, 10-byte entries).
  function parseACO(buf) {
    const v = new DataView(buf), cols = [];
    if (buf.byteLength < 4) return cols;
    const count = v.getUint16(2, false); let o = 4;
    for (let i = 0; i < count && o + 10 <= buf.byteLength; i++) {
      const space = v.getUint16(o, false), w0 = v.getUint16(o + 2, false), w1 = v.getUint16(o + 4, false), w2 = v.getUint16(o + 6, false);
      o += 10;
      if (space === 0) cols.push(_hex(Math.round(w0 / 257), Math.round(w1 / 257), Math.round(w2 / 257)));       // RGB (0–65535)
      else if (space === 8) { const g = Math.round((w0 / 10000) * 255); cols.push(_hex(g, g, g)); }             // Gray (0–10000)
    }
    return cols;
  }
  // Adobe Swatch Exchange: 'ASEF' header + N big-endian blocks; colour blocks (0x0001).
  function parseASE(buf) {
    const v = new DataView(buf), cols = [];
    if (buf.byteLength < 12 || v.getUint32(0, false) !== 0x41534546) return cols;   // 'ASEF'
    const blocks = v.getUint32(8, false); let o = 12;
    for (let b = 0; b < blocks && o + 6 <= buf.byteLength; b++) {
      const type = v.getUint16(o, false), len = v.getUint32(o + 2, false); o += 6; const end = o + len;
      if (type === 0x0001) {
        let p = o; const nameLen = v.getUint16(p, false); p += 2 + nameLen * 2;   // skip UTF-16 name (incl. terminator)
        const sp = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3)); p += 4;
        if (sp === 'RGB ') cols.push(_hex(Math.round(v.getFloat32(p, false) * 255), Math.round(v.getFloat32(p + 4, false) * 255), Math.round(v.getFloat32(p + 8, false) * 255)));
        else if (sp === 'Gray') { const g = Math.round(v.getFloat32(p, false) * 255); cols.push(_hex(g, g, g)); }
        else if (sp === 'CMYK') { const c = v.getFloat32(p, false), m = v.getFloat32(p + 4, false), y = v.getFloat32(p + 8, false), k = v.getFloat32(p + 12, false); cols.push(_hex(Math.round(255 * (1 - c) * (1 - k)), Math.round(255 * (1 - m) * (1 - k)), Math.round(255 * (1 - y) * (1 - k)))); }
      }
      o = end;
    }
    return cols;
  }
  // Microsoft RIFF palette: little-endian LOGPALETTE inside the 'data' chunk.
  function parseRIFFPAL(buf) {
    const v = new DataView(buf), cols = [];
    let d = -1;
    for (let i = 12; i + 12 <= buf.byteLength; i++) { if (v.getUint32(i, false) === 0x64617461) { d = i; break; } }   // 'data'
    if (d < 0) return cols;
    const count = v.getUint16(d + 10, true); let o = d + 12;   // ver@d+8, count@d+10, entries@d+12
    for (let i = 0; i < count && o + 4 <= buf.byteLength; i++) { cols.push(_hex(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2))); o += 4; }
    return cols;
  }
  const _isImageMagic = (b) => (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) || (b[0] === 0xFF && b[1] === 0xD8) || (b[0] === 0x42 && b[1] === 0x4D);
  // Unique colours from a palette image (row-major, so a horizontal strip reads left→right).
  function parseImageColors(src, done) {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(img, 0, 0);
      let data; try { data = g.getImageData(0, 0, w, h).data; } catch (_) { done([]); return; }
      const cols = [], seen = new Set();
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 8) continue;
        const hex = _hex(data[i], data[i + 1], data[i + 2]);
        if (!seen.has(hex)) { seen.add(hex); cols.push(hex); if (cols.length >= 256) break; }
      }
      done(cols);
    };
    img.onerror = () => done([]);
    img.src = src;
  }
  function finishImport(cols, palName) {
    cols = _dedupeHex(cols);
    if (!cols.length) { try { alert('Could not read any colours from that file.'); } catch (_) {} return; }
    PALETTE = cols.slice(0, 1024);
    let base = _baseName(palName), name = base, k = 2;
    while (savedPalettes[name] || BUILTIN_PALETTES[name]) name = base + ' ' + (k++);   // don't clobber a preset or existing palette
    savedPalettes[name] = PALETTE.slice(); activePaletteName = name;
    persistPalettes(); persistActivePaletteName();
    buildPalette(); renderPalettePanel();
  }
  function importPaletteFile(file) {
    if (!file) return;
    const ext = (file.name || '').split('.').pop().toLowerCase();
    const reader = new FileReader();
    reader.onload = () => {
      const buf = reader.result, bytes = new Uint8Array(buf);
      if (_isImageMagic(bytes) || /^(png|gif|jpg|jpeg|bmp|webp)$/.test(ext)) {
        const url = URL.createObjectURL(new Blob([buf]));
        parseImageColors(url, (cols) => { try { URL.revokeObjectURL(url); } catch (_) {} finishImport(cols, file.name); });
        return;
      }
      let cols = [], name = file.name;
      try {
        const m4 = String.fromCharCode(bytes[0] || 0, bytes[1] || 0, bytes[2] || 0, bytes[3] || 0);
        if (m4 === 'ASEF') cols = parseASE(buf);
        else if (m4 === 'RIFF') cols = parseRIFFPAL(buf);
        else if (ext === 'act') cols = parseACT(buf);
        else if (ext === 'aco') cols = parseACO(buf);
        else { const r = parseTextPalette(_decodeText(bytes)); cols = r.colors; if (r.name) name = r.name; }
      } catch (_) { cols = []; }
      finishImport(cols, name);
    };
    reader.readAsArrayBuffer(file);
  }

  // ── Palette from the reference image (median-cut quantization) ──
  // Photos/artwork have thousands of unique colours, so unlike parseImageColors
  // (which keeps them all — great for a Lospec strip) this reduces the reference
  // down to `k` representative colours. Sampled at reduced resolution to bound
  // the work; opaque pixels only. Colours come out roughly dark→light so the
  // saved palette reads sensibly.
  function quantizeImage(img, k) {
    if (!img || !img.width || !img.height) return [];
    const MAXS = 128;                                   // cap the working size
    const scale = Math.min(1, MAXS / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = true;
    g.drawImage(img, 0, 0, w, h);
    let data; try { data = g.getImageData(0, 0, w, h).data; } catch (_) { return []; }
    const px = [];
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] >= 8) px.push([data[i], data[i + 1], data[i + 2]]);
    if (!px.length) return [];
    k = Math.max(1, Math.min(64, k | 0));
    // Repeatedly split the box with the widest colour spread along its widest
    // channel at the median — the classic median-cut palette algorithm.
    let boxes = [px];
    while (boxes.length < k) {
      let bi = -1, bestRange = -1, bestCh = 0;
      for (let b = 0; b < boxes.length; b++) {
        const box = boxes[b]; if (box.length < 2) continue;
        const mn = [255, 255, 255], mx = [0, 0, 0];
        for (const p of box) for (let ch = 0; ch < 3; ch++) { if (p[ch] < mn[ch]) mn[ch] = p[ch]; if (p[ch] > mx[ch]) mx[ch] = p[ch]; }
        for (let ch = 0; ch < 3; ch++) { const r = mx[ch] - mn[ch]; if (r > bestRange) { bestRange = r; bi = b; bestCh = ch; } }
      }
      if (bi < 0 || bestRange <= 0) break;              // every box is uniform/singleton
      const box = boxes[bi]; box.sort((a, b) => a[bestCh] - b[bestCh]);
      const mid = box.length >> 1;
      boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
    }
    // Average each box → its representative colour; order by luminance.
    const out = boxes.map((box) => {
      let r = 0, gg = 0, bb = 0; for (const p of box) { r += p[0]; gg += p[1]; bb += p[2]; }
      const n = box.length; return [Math.round(r / n), Math.round(gg / n), Math.round(bb / n)];
    });
    out.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
    return out.map((p) => _hex(p[0], p[1], p[2]));
  }
  // Build a palette from the loaded reference and adopt it as a new named palette.
  function paletteFromReference(k) {
    if (!state.refImg) { try { alert('Load a reference image first.'); } catch (_) {} return; }
    const cols = quantizeImage(state.refImg, k);
    if (!cols.length) { try { alert('Could not read any colours from the reference.'); } catch (_) {} return; }
    finishImport(cols, 'Reference palette');
  }

  // ── Tools ──
  function selectTool(t) {
    state.tool = t;
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    updateSelUI(); updateFillUI(); render();
  }

  // ── Popover menus (reference / brush / layers) — one open at a time ──
  const MENU_IDS = ['refPanel', 'brushMenu', 'layersPanel', 'palettePanel', 'exportMenu'];
  const MENU_TRIGGERS = ['refBtn', 'brushBtn', 'layersBtn', 'paletteBtn', 'exportBtn'];
  function closeMenus(except) { for (const id of MENU_IDS) if (id !== except) { const m = $(id); if (m) m.hidden = true; } }
  function toggleMenu(id) { const m = $(id); if (!m) return; const willOpen = m.hidden; closeMenus(willOpen ? id : null); m.hidden = !willOpen; }

  // ── New / load / save ──
  function fitCells(src, n) {
    const cells = new Array(n).fill(null);
    if (Array.isArray(src)) for (let i = 0; i < n && i < src.length; i++) cells[i] = src[i] || null;
    return cells;
  }
  function newDoc(w, h) {
    state.w = clampDim(w); state.h = clampDim(h);
    layerSeq = 0; state.sel = null;
    state.layers = [makeLayer('Layer 1')]; state.active = 0;
    buildRefSample(); clearHistory(); renderLayerPanel(); updateSelUI(); fitView(); render(); scheduleSave();
  }
  // Accepts the new layered format ({layers:[{name,hidden,opacity,cells}], active})
  // and the legacy flat format ({cells}); the latter becomes a single layer.
  function loadDoc(d) {
    state.w = clampDim(d.w); state.h = clampDim(d.h);
    const n = state.w * state.h;
    layerSeq = 0; state.sel = null;
    if (Array.isArray(d.layers) && d.layers.length) {
      state.layers = d.layers.map((ld, k) => {
        const L = makeLayer(ld.name || ('Layer ' + (k + 1)), fitCells(ld.cells, n));
        L.hidden = !!ld.hidden;
        L.opacity = (typeof ld.opacity === 'number' && ld.opacity >= 0 && ld.opacity <= 1) ? ld.opacity : 1;
        return L;
      });
      state.active = Math.min(Math.max(0, d.active | 0), state.layers.length - 1);
    } else {
      state.layers = [makeLayer('Layer 1', fitCells(d.cells, n))]; state.active = 0;
    }
    buildRefSample(); clearHistory(); renderLayerPanel(); updateSelUI(); fitView(); render();
  }

  // ── Reference image (tracing underlay) ──
  // Drawn behind the cells in render(); the eyedropper can sample it. Kept
  // global (one at a time), persisted to localStorage, and deliberately NOT
  // part of the saved drawing / backup — it's a working aid, not the artwork.
  // Reference placement in grid-cell units. Fill mode (default) covers the grid
  // exactly; aspect mode fits the image inside it (contain), centred. The drag
  // offset then shifts it. render() scales this to the screen and buildRefSample()
  // paints it into grid space, so the eyedropper always samples what's shown.
  function refRot() { return ((state.refRot % 360) + 360) % 360; }   // normalised 0/90/180/270
  function refRectCells() {
    let rx = 0, ry = 0, rw = state.w, rh = state.h;
    const img = state.refImg;
    if (state.refAspect && img && img.width && img.height) {
      // A 90°/270° rotation puts the image on its side, so fit the grid using the
      // image's swapped dimensions — the on-screen footprint keeps the true aspect.
      const quarter = refRot() === 90 || refRot() === 270;
      const iw = quarter ? img.height : img.width;
      const ih = quarter ? img.width : img.height;
      const s = Math.min(state.w / iw, state.h / ih);
      rw = iw * s; rh = ih * s;
      rx = (state.w - rw) / 2; ry = (state.h - rh) / 2;
    }
    return [rx + state.refOffX, ry + state.refOffY, rw, rh];
  }
  // Draw the reference into the footprint [rx,ry,rw,rh] applying the reflect/rotate
  // transform, so render() and the eyedropper's buildRefSample() stay in lockstep.
  // Mirror is applied in screen space (Flip H always mirrors left↔right on screen),
  // then rotation; for 90°/270° the pre-rotation box uses swapped dims so the
  // rotated image still fills the same footprint.
  function drawRefTransformed(g, rx, ry, rw, rh) {
    const img = state.refImg; if (!img) return;
    const rot = refRot();
    g.save();
    g.translate(rx + rw / 2, ry + rh / 2);
    if (state.refFlipH || state.refFlipV) g.scale(state.refFlipH ? -1 : 1, state.refFlipV ? -1 : 1);
    if (rot) g.rotate(rot * Math.PI / 180);
    let dw = rw, dh = rh;
    if (rot === 90 || rot === 270) { dw = rh; dh = rw; }
    g.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    g.restore();
  }
  function buildRefSample() {
    if (!state.refImg) { refSample = null; refSampleCtx = null; return; }
    const c = document.createElement('canvas');
    c.width = Math.max(1, state.w); c.height = Math.max(1, state.h);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    try { const [rx, ry, rw, rh] = refRectCells(); drawRefTransformed(g, rx, ry, rw, rh); refSample = c; refSampleCtx = g; }
    catch (_) { refSample = null; refSampleCtx = null; }
  }
  function sampleReference(cx, cy) {
    if (!refSampleCtx || !inBounds(cx, cy)) return null;
    try {
      const d = refSampleCtx.getImageData(cx, cy, 1, 1).data;
      if (d[3] < 8) return null;  // transparent reference pixel → nothing to pick
      return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    } catch (_) { return null; }
  }
  function setReference(dataUrl, persist) {
    const img = new Image();
    img.onload = () => { state.refImg = img; buildRefSample(); updateRefUI(); render(); };
    img.onerror = () => { state.refImg = null; updateRefUI(); render(); };
    img.src = dataUrl;
    if (persist) {
      state.refOffX = 0; state.refOffY = 0;   // a freshly chosen image starts un-nudged
      state.refFlipH = false; state.refFlipV = false; state.refRot = 0;   // …and un-flipped/un-rotated
      try { localStorage.setItem(REF_KEY, dataUrl); } catch (_) {}
      saveRefTransform();
    }
  }
  function clearReference() {
    state.refImg = null; refSample = null; refSampleCtx = null;
    state.refMove = false; state.refOffX = 0; state.refOffY = 0;
    state.refFlipH = false; state.refFlipV = false; state.refRot = 0;
    try { localStorage.removeItem(REF_KEY); } catch (_) {}
    try { localStorage.removeItem(REF_OFF_KEY); } catch (_) {}
    try { localStorage.removeItem(REF_XFORM_KEY); } catch (_) {}
    updateRefUI(); render();   // leave the panel open so a new image can be chosen
  }
  function saveRefTransform() {
    try { localStorage.setItem(REF_ASPECT_KEY, state.refAspect ? '1' : '0'); } catch (_) {}
    try { localStorage.setItem(REF_OFF_KEY, JSON.stringify({ x: state.refOffX, y: state.refOffY })); } catch (_) {}
    try { localStorage.setItem(REF_XFORM_KEY, JSON.stringify({ fh: state.refFlipH, fv: state.refFlipV, rot: refRot() })); } catch (_) {}
  }
  // Reflect the reference (mirror). Rebuilds the eyedropper sample so it matches.
  function setRefFlip(axis, on) {
    if (axis === 'h') state.refFlipH = !!on; else state.refFlipV = !!on;
    buildRefSample(); saveRefTransform(); updateRefUI(); render();
  }
  // Rotate the reference by ±90°. Aspect-fit re-fits to the new orientation.
  function rotateRef(dir) {
    state.refRot = (((state.refRot + dir * 90) % 360) + 360) % 360;
    buildRefSample(); saveRefTransform(); updateRefUI(); render();
  }
  function applyRefCursor() { try { canvas.style.cursor = (state.refMove && state.refImg) ? 'move' : ''; } catch (_) {} }
  // Read a chosen file, downscale to REF_MAX (keeps localStorage small), and
  // adopt it. JPEG flattens any alpha onto a dark fill ≈ the canvas bg.
  function loadReferenceFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const probe = new Image();
      probe.onload = () => {
        const scale = Math.min(1, REF_MAX / Math.max(probe.width, probe.height));
        const w = Math.max(1, Math.round(probe.width * scale));
        const h = Math.max(1, Math.round(probe.height * scale));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.fillStyle = '#14151a'; g.fillRect(0, 0, w, h);  // match canvas bg under any alpha
        g.imageSmoothingEnabled = true;
        g.drawImage(probe, 0, 0, w, h);
        let url; try { url = c.toDataURL('image/jpeg', 0.8); } catch (_) { url = reader.result; }
        setReference(url, true);
      };
      probe.onerror = () => {};
      probe.src = reader.result;
    };
    reader.readAsDataURL(file);
  }
  function updateRefUI() {
    const has = !!state.refImg;
    const btn = $('refBtn'); if (btn) btn.classList.toggle('active', has);
    const controls = $('refControls'); if (controls) controls.style.display = has ? '' : 'none';
    const choose = $('refChoose'); if (choose) choose.textContent = has ? 'Replace image…' : 'Choose image…';
    const slider = $('refOpacity'); if (slider) slider.value = Math.round(state.refOpacity * 100);
    const val = $('refOpacityVal'); if (val) val.textContent = Math.round(state.refOpacity * 100) + '%';
    const mv = $('refMoveToggle'); if (mv) mv.checked = state.refMove;
    const asp = $('refAspectToggle'); if (asp) asp.checked = state.refAspect;
    const fh = $('refFlipH'); if (fh) fh.classList.toggle('active', state.refFlipH);
    const fv = $('refFlipV'); if (fv) fv.classList.toggle('active', state.refFlipV);
    applyRefCursor();
  }
  // ── Canvas background (behind transparent cells) ──
  // A global editor preference, not part of the saved drawing: exports and
  // thumbnails deliberately keep real transparency. null → transparency checker.
  function setBgColor(col) {
    state.bg = col || null;
    try { localStorage.setItem(BG_KEY, state.bg || ''); } catch (_) {}
    updateBgUI(); render();
  }
  function updateBgUI() {
    const sw = $('bgSwatch');
    // Solid colour when set; empty string restores the CSS checker swatch.
    if (sw) sw.style.background = state.bg || '';
    const inp = $('bgColorInput');
    if (inp && state.bg) { try { inp.value = state.bg; } catch (_) {} }
    const clr = $('bgClear'); if (clr) clr.disabled = !state.bg;
  }
  // Serialize the doc: layers (name/hidden/opacity/cells) + active index.
  function serializeDoc() {
    return { w: state.w, h: state.h, active: state.active,
      layers: state.layers.map((L) => ({ name: L.name, hidden: L.hidden, opacity: L.opacity, cells: L.cells })) };
  }
  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(DOC_KEY, JSON.stringify(serializeDoc())); } catch (_) {}
    }, 400);
  }
  function loadSaved() {
    try { const s = JSON.parse(localStorage.getItem(DOC_KEY) || 'null'); return (s && s.w && (Array.isArray(s.cells) || Array.isArray(s.layers))) ? s : null; }
    catch (_) { return null; }
  }

  // New-art dialog. `cancelable` hides Cancel on the very first open (no doc yet).
  function showNewDialog(cancelable) {
    newW.value = state.w; newH.value = state.h;
    $('newCancel').style.display = cancelable ? '' : 'none';
    newDialog.classList.add('show');
    setTimeout(() => { try { newW.focus(); newW.select(); } catch (_) {} }, 30);
  }
  function hideNewDialog() { newDialog.classList.remove('show'); }
  function wireDialog() {
    $('newCreate').onclick = () => { newDoc(clampDim(newW.value), clampDim(newH.value)); hideNewDialog(); };
    $('newCancel').onclick = hideNewDialog;
    document.querySelectorAll('.presets button').forEach((b) =>
      b.onclick = () => { newW.value = b.dataset.preset; newH.value = b.dataset.preset; });
    [newW, newH].forEach((inp) => inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('newCreate').click(); }));
  }

  // ── Thumbnail (host folder preview) ──
  function makeThumb() {
    const max = 128;
    const s = Math.max(1, Math.min(8, Math.floor(max / Math.max(state.w, state.h)) || 1));
    const tw = state.w * s, th = state.h * s;
    const c = document.createElement('canvas'); c.width = tw; c.height = th;
    const g = c.getContext('2d');
    g.fillStyle = '#1b1c22'; g.fillRect(0, 0, tw, th);
    g.fillStyle = '#23242b';
    for (let y = 0; y < th; y += 8) for (let x = 0; x < tw; x += 8) if ((((x / 8) | 0) + ((y / 8) | 0)) & 1) g.fillRect(x, y, 8, 8);
    g.imageSmoothingEnabled = false;
    g.drawImage(compositeCanvas(), 0, 0, state.w, state.h, 0, 0, tw, th);
    try { return c.toDataURL('image/png'); } catch (_) { return null; }
  }

  // ── Export PNG (true transparency preserved) ──
  // Draws the 1px-per-cell buffer onto a fresh, fully-transparent canvas with
  // nearest-neighbour upscaling — null cells stay transparent (alpha 0), so the
  // PNG carries real transparency, NOT the on-screen checkerboard. Upscaled so a
  // tiny grid still exports as a viewable image; edges stay hard (no smoothing).
  const EXPORT_MAX_SIDE = 8192;   // cap the output so huge factors don't OOM the canvas
  function exportMaxScale() { return Math.max(1, Math.floor(EXPORT_MAX_SIDE / Math.max(state.w, state.h))); }
  // scale = integer upscale factor (nearest-neighbour, crisp pixels). If it's
  // unspecified we fall back to an auto ~512px scale, so the host bridge's plain
  // exportPNG() still works.
  function exportPNG(scale) {
    if (!state.layers.length) return;
    let s = Math.round(Number(scale) || 0);
    if (!(s >= 1)) s = Math.max(1, Math.round(512 / Math.max(state.w, state.h)));
    s = Math.max(1, Math.min(exportMaxScale(), s));
    const ew = state.w * s, eh = state.h * s;
    const c = document.createElement('canvas'); c.width = ew; c.height = eh;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(compositeCanvas(), 0, 0, state.w, state.h, 0, 0, ew, eh);
    let url; try { url = c.toDataURL('image/png'); } catch (_) { return; }
    downloadDataUrl(url, 'pixel-art-' + ew + 'x' + eh + '.png');
  }
  // Export-menu helpers: keep the input in range and show the resulting size.
  function updateExportDims() {
    const inp = $('exportScale'), ms = exportMaxScale();
    if (inp) inp.max = ms;
    let s = Math.round(Number(inp && inp.value) || 0); s = Math.max(1, Math.min(ms, s));
    const d = $('exportDims'); if (d) d.textContent = state.w + '×' + state.h + '  →  ' + (state.w * s) + ' × ' + (state.h * s) + ' px';
    return s;
  }
  function setExportScale(s) { const inp = $('exportScale'); if (inp) inp.value = Math.max(1, Math.min(exportMaxScale(), Math.round(s) || 1)); updateExportDims(); }
  function doExport() { exportPNG(updateExportDims()); closeMenus(null); }
  function downloadDataUrl(url, filename) {
    // Capacitor (native WebView): the <a download> + data-URL trick is a no-op,
    // so write the file and hand it to the OS share sheet — same approach as the
    // host app's exportData. The bridge may only live on the parent frame (this
    // app runs in a same-origin iframe), so check both.
    const cap = window.Capacitor || (window.parent && window.parent.Capacitor);
    if (cap && cap.isNativePlatform && cap.isNativePlatform()) { nativeShare(cap, url, filename); return; }
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function nativeShare(cap, url, filename) {
    try {
      const Fs = cap.Plugins && cap.Plugins.Filesystem;
      const Share = cap.Plugins && cap.Plugins.Share;
      const base64 = url.split(',')[1];
      if (!Fs || !Share || !base64) throw new Error('Filesystem/Share plugin unavailable');
      const res = await Fs.writeFile({ path: filename, data: base64, directory: 'CACHE' });
      await Share.share({ title: filename, files: [res.uri], dialogTitle: 'Export pixel art' });
    } catch (e) { alert('Export failed: ' + (e && e.message ? e.message : e)); }
  }

  // ── Pick a Pokémon as the tracing reference ──
  // This app runs as a same-origin iframe inside the host, which exposes
  // window.Species (name list) and window.Sprites.getDefaultSpriteBlob(head,
  // body) → Blob. We reach those on the host frame, render the sprite to a PNG
  // data URL here (keeping alpha + crisp pixels), and feed it to setReference —
  // exactly like a chosen file. Standalone (no host), the button stays hidden.
  let pokeNameToId = null;      // lowercased name → 1-indexed species id
  let pokeNamesLoaded = false;
  let pokePreviewToken = 0;     // guards against out-of-order async previews
  let pokePendingUrl = null;    // data URL of the currently-previewed sprite
  let pokePreviewTimer = null;

  // The host frame carrying Species + Sprites, or null when running standalone.
  function pokeHost() {
    try {
      if (window.Species && window.Sprites &&
          typeof window.Sprites.getDefaultSpriteBlob === 'function') return window;
    } catch (_) {}
    try {
      const p = window.parent;
      if (p && p !== window && p.Species && p.Sprites &&
          typeof p.Sprites.getDefaultSpriteBlob === 'function') return p;
    } catch (_) { /* cross-origin parent — treat as no host */ }
    return null;
  }

  // Accepts a name ("Bulbasaur", case-insensitive), a dex number, or "#25".
  function resolvePokeId(str) {
    const s = (str || '').trim();
    if (!s) return null;
    const num = s.replace(/^#/, '');
    if (/^\d+$/.test(num)) { const n = +num; return n >= 1 ? n : null; }
    if (!pokeNameToId) return null;
    return pokeNameToId.get(s.toLowerCase()) || null;
  }

  // Draw a sprite Blob to a canvas at native size (no smoothing → crisp pixels)
  // and return a PNG data URL, which preserves the sprite's transparency.
  function pokeBlobToPngDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const objUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth || img.width || 1;
          c.height = img.naturalHeight || img.height || 1;
          const g = c.getContext('2d');
          g.imageSmoothingEnabled = false;
          g.drawImage(img, 0, 0);
          const url = c.toDataURL('image/png');
          URL.revokeObjectURL(objUrl);
          resolve(url);
        } catch (e) { URL.revokeObjectURL(objUrl); reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error('sprite decode failed')); };
      img.src = objUrl;
    });
  }

  function setPokePreviewMsg(msg) {
    const el = $('pokePreviewMsg');
    if (el) { el.textContent = msg || ''; el.style.display = msg ? '' : 'none'; }
    const img = $('pokePreview'); if (img && msg) { img.hidden = true; }
  }

  // Resolve the current inputs → fetch the sprite → preview it. Debounced and
  // token-guarded so fast typing doesn't flash stale sprites.
  async function updatePokePreview() {
    const host = pokeHost();
    const useBtn = $('pokeUse');
    const fusion = $('pokeFusion') && $('pokeFusion').checked;
    if (useBtn) { useBtn.disabled = true; }
    pokePendingUrl = null;
    if (!host) { setPokePreviewMsg('Sprites are only available inside the app.'); return; }
    const head = resolvePokeId($('pokeHead') ? $('pokeHead').value : '');
    const body = fusion ? resolvePokeId($('pokeBody') ? $('pokeBody').value : '') : head;
    if (!head || (fusion && !body)) { setPokePreviewMsg('Type a name to preview a sprite.'); return; }
    const token = ++pokePreviewToken;
    setPokePreviewMsg('Loading…');
    let blob = null;
    try { blob = await host.Sprites.getDefaultSpriteBlob(head, body); } catch (_) { blob = null; }
    if (token !== pokePreviewToken) return;   // superseded by a newer keystroke
    if (!blob) { setPokePreviewMsg('No sprite for that pick. (Download sprites first?)'); return; }
    let url = null;
    try { url = await pokeBlobToPngDataUrl(blob); } catch (_) { url = null; }
    if (token !== pokePreviewToken) return;
    if (!url) { setPokePreviewMsg('Could not read that sprite.'); return; }
    pokePendingUrl = url;
    const img = $('pokePreview');
    if (img) { img.src = url; img.hidden = false; }
    setPokePreviewMsg('');
    if (useBtn) useBtn.disabled = false;
  }
  function schedulePokePreview() {
    if (pokePreviewTimer) clearTimeout(pokePreviewTimer);
    pokePreviewTimer = setTimeout(updatePokePreview, 220);
  }

  // Populate the <datalist> + name→id map once, from the host's Species list.
  // ensureLoaded may fetch in web mode — fine, this runs from an explicit tap.
  async function ensurePokeNames() {
    if (pokeNamesLoaded) return;
    const host = pokeHost(); if (!host) return;
    try { if (host.Species.ensureLoaded) await host.Species.ensureLoaded(); } catch (_) {}
    let list = [];
    try { list = host.Species.allSpecies() || []; } catch (_) { list = []; }
    if (!list.length) return;   // leave unloaded so a later open retries
    pokeNameToId = new Map();
    const dl = $('pokeNames');
    if (dl) dl.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const sp of list) {
      if (!sp || !sp.name) continue;
      pokeNameToId.set(String(sp.name).toLowerCase(), sp.id);
      const opt = document.createElement('option');
      opt.value = sp.name;
      frag.appendChild(opt);
    }
    if (dl) dl.appendChild(frag);
    pokeNamesLoaded = true;
  }

  function openPokeDialog() {
    const dlg = $('pokeDialog'); if (!dlg) return;
    pokePendingUrl = null; pokePreviewToken++;
    const img = $('pokePreview'); if (img) { img.hidden = true; img.removeAttribute('src'); }
    const useBtn = $('pokeUse'); if (useBtn) useBtn.disabled = true;
    setPokePreviewMsg('Type a name to preview a sprite.');
    dlg.classList.add('show');
    ensurePokeNames();
    setTimeout(() => { const h = $('pokeHead'); if (h) { try { h.focus(); h.select(); } catch (_) {} } }, 30);
  }
  function closePokeDialog() { const dlg = $('pokeDialog'); if (dlg) dlg.classList.remove('show'); }

  function wirePokePicker() {
    const btn = $('refPickPoke');
    if (!btn) return;
    if (!pokeHost()) { btn.hidden = true; return; }   // standalone → no picker
    btn.hidden = false;
    btn.onclick = () => { closeMenus(null); openPokeDialog(); };

    const fusion = $('pokeFusion');
    if (fusion) fusion.addEventListener('change', () => {
      const on = fusion.checked;
      const bodyLbl = $('pokeBodyLbl'); if (bodyLbl) bodyLbl.hidden = !on;
      const headLbl = $('pokeHeadLbl');
      // Relabel the first field so the fusion roles are unambiguous.
      if (headLbl) headLbl.childNodes[0].nodeValue = on ? 'Head' : 'Pokémon';
      updatePokePreview();
    });
    ['pokeHead', 'pokeBody'].forEach((id) => {
      const inp = $(id);
      if (inp) inp.addEventListener('input', schedulePokePreview);
      if (inp) inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); const u = $('pokeUse'); if (u && !u.disabled) u.click(); }
      });
    });
    const useBtn = $('pokeUse');
    if (useBtn) useBtn.onclick = () => {
      if (!pokePendingUrl) return;
      setReference(pokePendingUrl, true);   // persists like any chosen reference
      closePokeDialog();
    };
    const cancel = $('pokeCancel'); if (cancel) cancel.onclick = closePokeDialog;
    const dlg = $('pokeDialog');
    if (dlg) dlg.addEventListener('click', (e) => { if (e.target === dlg) closePokeDialog(); });
  }

  // ── Resize ──
  function resizeCanvas() {
    const r = stage.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    render();
  }

  // ── Wire UI ──
  function wireUI() {
    document.querySelectorAll('.tool').forEach((b) => b.onclick = () => selectTool(b.dataset.tool));
    $('zoomIn').onclick = () => zoomButton(1.25);
    $('zoomOut').onclick = () => zoomButton(0.8);
    $('zoomFit').onclick = () => { fitView(); render(); };
    // Export opens a popout to choose the upscale factor.
    $('exportBtn').onclick = (e) => { e.stopPropagation(); toggleMenu('exportMenu'); if (!$('exportMenu').hidden) setExportScale(Number($('exportScale').value) || 8); };
    $('exportScale').addEventListener('input', updateExportDims);
    $('exportScale').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doExport(); } });
    ['1', '2', '4', '8', '16'].forEach((s) => { const b = $('exp' + s); if (b) b.onclick = () => setExportScale(+s); });
    $('exportGo').onclick = doExport;
    colorInput.addEventListener('input', (e) => setActiveColor(e.target.value));
    colorInput.addEventListener('change', (e) => addCustomColor(e.target.value));
    // Save the current colour (e.g. one eyedropped off the art/reference) as a swatch.
    if (saveColorBtn) saveColorBtn.onclick = () => addPaletteColor(state.color);
    // Canvas background: colour picker sets it live; "Checker" reverts to transparent.
    const bgInput = $('bgColorInput');
    if (bgInput) bgInput.addEventListener('input', (e) => setBgColor(e.target.value));
    const bgClearBtn = $('bgClear');
    if (bgClearBtn) bgClearBtn.onclick = () => setBgColor(null);
    // Reference image: the button opens the popout; everything lives in there.
    $('refBtn').onclick = (e) => { e.stopPropagation(); toggleMenu('refPanel'); };
    $('refChoose').onclick = () => $('refFile').click();
    $('refFile').addEventListener('change', (e) => {
      loadReferenceFile(e.target.files && e.target.files[0]);
      e.target.value = '';  // allow re-picking the same file
    });
    $('refOpacity').addEventListener('input', (e) => {
      state.refOpacity = (Number(e.target.value) || 0) / 100;
      const val = $('refOpacityVal'); if (val) val.textContent = e.target.value + '%';
      try { localStorage.setItem(REF_OPACITY_KEY, String(state.refOpacity)); } catch (_) {}
      render();
    });
    $('refRemove').onclick = clearReference;
    $('refMoveToggle').addEventListener('change', (e) => {
      state.refMove = !!e.target.checked;
      applyRefCursor();
    });
    $('refAspectToggle').addEventListener('change', (e) => {
      state.refAspect = !!e.target.checked;
      buildRefSample(); saveRefTransform(); render();
    });
    $('refFlipH').onclick = () => setRefFlip('h', !state.refFlipH);
    $('refFlipV').onclick = () => setRefFlip('v', !state.refFlipV);
    $('refRotCcw').onclick = () => rotateRef(-1);
    $('refRotCw').onclick = () => rotateRef(1);
    $('refReset').onclick = () => {
      state.refOffX = 0; state.refOffY = 0;
      state.refFlipH = false; state.refFlipV = false; state.refRot = 0;
      buildRefSample(); saveRefTransform(); updateRefUI(); render();
    };
    // Build a palette from the reference, then swap to the palette panel so the
    // new swatches are visible.
    $('refPalette').onclick = () => {
      const n = Math.max(2, Math.min(64, Math.round(Number($('refPalCount').value) || 16)));
      paletteFromReference(n);
      if (state.refImg) { closeMenus('palettePanel'); const pp = $('palettePanel'); if (pp) pp.hidden = false; }
    };

    // Brush size popover.
    $('brushBtn').onclick = (e) => { e.stopPropagation(); toggleMenu('brushMenu'); };
    $('brushSize').addEventListener('input', (e) => {
      state.brush = Math.max(1, Math.min(BRUSH_MAX, Number(e.target.value) || 1));
      updateBrushUI(); render();
      try { localStorage.setItem(BRUSH_KEY, String(state.brush)); } catch (_) {}
    });

    // Layers panel.
    $('layersBtn').onclick = (e) => { e.stopPropagation(); toggleMenu('layersPanel'); };
    $('layerAdd').onclick = addLayer;
    $('layerDup').onclick = duplicateLayer;
    $('layerDelete').onclick = deleteLayer;
    $('layerUp').onclick = () => moveLayer(1);
    $('layerDown').onclick = () => moveLayer(-1);
    $('layerOpacity').addEventListener('input', (e) => setLayerOpacity((Number(e.target.value) || 0) / 100));

    // Selection action bar.
    $('selDeselect').onclick = deselect;
    $('selDelete').onclick = deleteSelection;

    // Fill-mode (Local / Global) segmented toggle — shown while the fill tool is active.
    $('fillLocal').onclick = () => setFillMode('local');
    $('fillGlobal').onclick = () => setFillMode('global');

    // Palette manager: switch / save / delete named palettes, edit colours.
    $('paletteBtn').onclick = (e) => { e.stopPropagation(); toggleMenu('palettePanel'); };
    $('paletteSelect').addEventListener('change', (e) => selectPalette(e.target.value));
    $('paletteSaveAs').onclick = savePaletteAsPrompt;
    $('paletteDelete').onclick = deleteActivePalette;
    $('paletteImport').onclick = () => $('paletteFile').click();
    $('paletteFile').addEventListener('change', (e) => { importPaletteFile(e.target.files && e.target.files[0]); e.target.value = ''; });

    // Dismiss any open popover on a tap outside it (capture phase beats the canvas).
    document.addEventListener('pointerdown', (e) => {
      const open = MENU_IDS.some((id) => { const m = $(id); return m && !m.hidden; });
      if (!open) return;
      const insideMenu = MENU_IDS.some((id) => { const m = $(id); return m && !m.hidden && m.contains(e.target); });
      const onTrigger = MENU_TRIGGERS.some((id) => e.target.closest && e.target.closest('#' + id));
      if (insideMenu || onTrigger) return;
      closeMenus(null);
    }, true);

    window.addEventListener('keydown', (e) => {
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (meta && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      // Selection keys: nudge with arrows, clear with Delete, drop with Escape.
      if (state.sel && !meta) {
        if (e.key === 'Escape') { e.preventDefault(); deselect(); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
        if (e.key.indexOf('Arrow') === 0) {
          e.preventDefault(); const st = e.shiftKey ? 5 : 1; let dx = 0, dy = 0;
          if (e.key === 'ArrowLeft') dx = -st; else if (e.key === 'ArrowRight') dx = st;
          else if (e.key === 'ArrowUp') dy = -st; else dy = st;
          nudgeSelection(dx, dy); return;
        }
      }
      const map = { b: 'pencil', p: 'pencil', e: 'eraser', g: 'fill', i: 'eyedropper', l: 'line', r: 'rect', m: 'select', h: 'pan' };
      if (map[e.key.toLowerCase()] && !meta) selectTool(map[e.key.toLowerCase()]);
    });
    if (window.ResizeObserver) new ResizeObserver(() => resizeCanvas()).observe(stage);
    else window.addEventListener('resize', resizeCanvas);
  }

  // ── Init ──
  function init() {
    checkerPat = ctx.createPattern(makeChecker(), 'repeat');
    try { const c = localStorage.getItem(COLOR_KEY); if (c) state.color = c; } catch (_) {}
    try { const bnum = parseInt(localStorage.getItem(BRUSH_KEY), 10); if (bnum >= 1 && bnum <= BRUSH_MAX) state.brush = bnum; } catch (_) {}
    try { const fm = localStorage.getItem(FILL_KEY); if (fm === 'global' || fm === 'local') state.fillMode = fm; } catch (_) {}
    try { const bg = localStorage.getItem(BG_KEY); if (bg) state.bg = bg; } catch (_) {}
    curColorTop.style.background = state.color;
    try { colorInput.value = state.color; } catch (_) {}
    loadPalettes();
    buildPalette(); wireUI(); wireDialog(); wirePokePicker(); wirePointer(); updateBrushUI(); updateFillUI(); renderPalettePanel(); updateBgUI();
    resizeCanvas();
    // Restore a persisted reference image + opacity (a working aid that
    // survives reopening; not part of any saved drawing).
    try {
      const o = parseFloat(localStorage.getItem(REF_OPACITY_KEY));
      if (o >= 0 && o <= 1) state.refOpacity = o;
    } catch (_) {}
    try { state.refAspect = localStorage.getItem(REF_ASPECT_KEY) === '1'; } catch (_) {}
    try {
      const off = JSON.parse(localStorage.getItem(REF_OFF_KEY) || 'null');
      if (off && isFinite(off.x) && isFinite(off.y)) { state.refOffX = off.x; state.refOffY = off.y; }
    } catch (_) {}
    try {
      const xf = JSON.parse(localStorage.getItem(REF_XFORM_KEY) || 'null');
      if (xf) {
        state.refFlipH = !!xf.fh; state.refFlipV = !!xf.fv;
        if (xf.rot === 90 || xf.rot === 180 || xf.rot === 270) state.refRot = xf.rot;
      }
    } catch (_) {}
    try {
      const ref = localStorage.getItem(REF_KEY);
      if (ref) setReference(ref, false);
    } catch (_) {}
    updateRefUI();
    const saved = loadSaved();
    if (saved) { loadDoc(saved); }
    else { newDoc(16, 16); showNewDialog(false); }   // first run → ask W/H

    // Bridge for the host's Extras → Pixel Art window (same-origin iframe):
    // save/restore the doc, render a folder preview, start a New canvas, undo/redo.
    window.PixelApp = {
      // `cells` is the flattened composite (back-compat for consumers that only
      // understand a flat array / thumbnails); `layers` carries full fidelity.
      getDrawing() {
        return { w: state.w, h: state.h, active: state.active, cells: compositeCells(),
          layers: state.layers.map((L) => ({ name: L.name, hidden: L.hidden, opacity: L.opacity, cells: L.cells.slice() })) };
      },
      loadDrawing(d) { if (d && d.w && d.h && (Array.isArray(d.cells) || Array.isArray(d.layers))) { hideNewDialog(); loadDoc(d); scheduleSave(); } },
      thumbnail() { return makeThumb(); },
      exportPNG() { exportPNG(); },
      newDrawing() { showNewDialog(true); },
      promptNew() { showNewDialog(true); },
      undo() { undo(); },
      redo() { redo(); },
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
