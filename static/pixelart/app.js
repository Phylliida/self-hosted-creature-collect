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
  // uses), plus a custom-colour picker that appends new swatches.
  const PALETTE = ['#000000', '#1D2B53', '#7E2553', '#008751', '#AB5236', '#5F574F',
    '#C2C3C7', '#FFF1E8', '#FF004D', '#FFA300', '#FFEC27', '#00E436',
    '#29ADFF', '#83769C', '#FF77A8', '#FFCCAA'];
  const MAX_DIM = 256;
  const MIN_SCALE = 1, MAX_SCALE = 64;
  const DOC_KEY = 'pixelart.doc.v1';
  const COLOR_KEY = 'pixelart.color.v1';
  const REF_KEY = 'pixelart.ref.v1';            // reference image (data URL)
  const REF_OPACITY_KEY = 'pixelart.refOpacity.v1';
  const REF_MAX = 1024;                          // downscale cap for the stored reference

  // ── DOM ──
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const canvas = $('px');
  const ctx = canvas.getContext('2d');
  const paletteEl = $('palette');
  const curColorTop = $('curColorTop');
  const colorInput = $('colorInput');
  const zoomLabel = $('zoomLabel');
  const newDialog = $('newDialog');
  const newW = $('newW'), newH = $('newH');

  // ── State ──
  const state = { w: 16, h: 16, cells: [], scale: 24, panX: 0, panY: 0,
    tool: 'pencil', color: '#FF004D', refImg: null, refOpacity: 0.5 };
  // Down-sampled (w×h) copy of the reference so the eyedropper can read a
  // per-cell colour without re-reading the full-res image each pick.
  let refSample = null, refSampleCtx = null;
  let dpr = 1;
  const undoStack = [], redoStack = [];
  let pending = null;            // Map(index -> beforeColor) during a stroke
  let drawing = false, panning = false, sampling = false;
  let lastCell = null, startCell = null, lastPan = null, preview = null, hover = null;
  const pointers = new Map();    // pointerId -> {x,y}
  let gesture = null;            // {d, mx, my} during a two-finger pinch

  // Off-screen 1px-per-cell buffer — drawn scaled with smoothing off so even a
  // 256² grid renders in a single nearest-neighbour blit (fast + crisp).
  const buf = document.createElement('canvas');
  const bctx = buf.getContext('2d');
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

  // ── Buffer ──
  function rebuildBuf() {
    buf.width = state.w; buf.height = state.h;
    bctx.clearRect(0, 0, state.w, state.h);
    for (let i = 0; i < state.cells.length; i++) {
      const c = state.cells[i];
      if (c) { bctx.fillStyle = c; bctx.fillRect(i % state.w, (i / state.w) | 0, 1, 1); }
    }
  }
  function setBuf(i, col) {
    const x = i % state.w, y = (i / state.w) | 0;
    if (col) { bctx.fillStyle = col; bctx.fillRect(x, y, 1, 1); }
    else bctx.clearRect(x, y, 1, 1);
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
    // Underlay: the reference image (stretched to the grid, at its opacity)
    // when one is loaded, otherwise the transparency checker. Then the cells
    // on top — opaque cells cover the underlay; transparent cells reveal it.
    if (state.refImg && state.refOpacity > 0) {
      ctx.save();
      ctx.globalAlpha = state.refOpacity;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(state.refImg, ax, ay, aw, ah);
      ctx.restore();
    } else if (checkerPat) {
      ctx.fillStyle = checkerPat; ctx.fillRect(ax, ay, aw, ah);
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buf, 0, 0, state.w, state.h, ax, ay, aw, ah);
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
      const [x, y, w, h] = cellRect(hover[0], hover[1]);
      ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }
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
  function commitStroke() {
    if (pending && pending.size) {
      const ch = [];
      for (const [i, before] of pending) ch.push([i, before, state.cells[i]]);
      undoStack.push(ch); if (undoStack.length > 150) undoStack.shift();
      redoStack.length = 0; scheduleSave();
    }
    pending = null;
  }
  function cancelStroke() {
    if (pending) { for (const [i, before] of pending) { state.cells[i] = before; setBuf(i, before); } pending = null; }
    drawing = false; sampling = false; preview = null; lastCell = startCell = null; render();
  }
  function applyOp(ch, useBefore) {
    for (const [i, before, after] of ch) { const v = useBefore ? before : after; state.cells[i] = v; setBuf(i, v); }
  }
  function undo() { const ch = undoStack.pop(); if (!ch) return; applyOp(ch, true); redoStack.push(ch); render(); scheduleSave(); }
  function redo() { const ch = redoStack.pop(); if (!ch) return; applyOp(ch, false); undoStack.push(ch); render(); scheduleSave(); }
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
    const col = state.cells[c[1] * state.w + c[0]];
    if (col) setActiveColor(col);
    else { const rc = sampleReference(c[0], c[1]); if (rc) setActiveColor(rc); }
  }
  function onDown(e) {
    const p = ptOf(e), c = ptToCell(p);
    // Middle-mouse always pans, whatever the tool.
    if (e.pointerType === 'mouse' && e.button === 1) { panning = true; lastPan = p; return; }
    if (state.tool === 'pan') { panning = true; lastPan = p; return; }
    if (state.tool === 'eyedropper') {
      // Keep sampling while the finger/mouse is held + dragged.
      sampling = true; hover = c; sampleAt(c); render(); return;
    }
    if (state.tool === 'fill') { if (inBounds(c[0], c[1])) { beginStroke(); floodFill(c[0], c[1], drawColor()); commitStroke(); render(); } return; }
    if (state.tool === 'line' || state.tool === 'rect') { drawing = true; startCell = c; preview = [c]; render(); return; }
    // pencil / eraser
    drawing = true; beginStroke(); lastCell = c; paintCell(c[0], c[1], drawColor()); render();
  }
  function onMove(e) {
    const p = ptOf(e), c = ptToCell(p);
    if (panning) { state.panX += p.x - lastPan.x; state.panY += p.y - lastPan.y; lastPan = p; render(); return; }
    if (sampling) { hover = c; sampleAt(c); render(); return; }   // live colour pick while dragging
    if (!drawing) { hover = c; render(); return; }
    if (state.tool === 'line') { preview = lineCells(startCell[0], startCell[1], c[0], c[1]); render(); return; }
    if (state.tool === 'rect') { preview = rectCells(startCell[0], startCell[1], c[0], c[1]); render(); return; }
    if (c[0] !== lastCell[0] || c[1] !== lastCell[1]) {
      for (const [x, y] of lineCells(lastCell[0], lastCell[1], c[0], c[1])) paintCell(x, y, drawColor());
      lastCell = c; render();
    }
  }
  function onUp() {
    if (panning) { panning = false; return; }
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
  function buildPalette() {
    paletteEl.innerHTML = '';
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
  function addCustomColor(col) {
    if (!PALETTE.some((c) => c.toLowerCase() === col.toLowerCase())) {
      PALETTE.push(col); buildPalette();
    }
    setActiveColor(col);
  }

  // ── Tools ──
  function selectTool(t) {
    state.tool = t;
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  }

  // ── New / load / save ──
  function newDoc(w, h) {
    state.w = clampDim(w); state.h = clampDim(h);
    state.cells = new Array(state.w * state.h).fill(null);
    rebuildBuf(); buildRefSample(); clearHistory(); fitView(); render(); scheduleSave();
  }
  function loadDoc(d) {
    state.w = clampDim(d.w); state.h = clampDim(d.h);
    const n = state.w * state.h;
    const cells = new Array(n).fill(null);
    if (Array.isArray(d.cells)) for (let i = 0; i < n && i < d.cells.length; i++) cells[i] = d.cells[i] || null;
    state.cells = cells;
    rebuildBuf(); buildRefSample(); clearHistory(); fitView(); render();
  }

  // ── Reference image (tracing underlay) ──
  // Drawn behind the cells in render(); the eyedropper can sample it. Kept
  // global (one at a time), persisted to localStorage, and deliberately NOT
  // part of the saved drawing / backup — it's a working aid, not the artwork.
  function buildRefSample() {
    if (!state.refImg) { refSample = null; refSampleCtx = null; return; }
    const c = document.createElement('canvas');
    c.width = Math.max(1, state.w); c.height = Math.max(1, state.h);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    try { g.drawImage(state.refImg, 0, 0, c.width, c.height); refSample = c; refSampleCtx = g; }
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
    if (persist) { try { localStorage.setItem(REF_KEY, dataUrl); } catch (_) {} }
  }
  function clearReference() {
    state.refImg = null; refSample = null; refSampleCtx = null;
    try { localStorage.removeItem(REF_KEY); } catch (_) {}
    updateRefUI(); render();
  }
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
    const row = $('refRow'); if (row) row.style.display = has ? 'flex' : 'none';
    const btn = $('refBtn'); if (btn) btn.classList.toggle('active', has);
    const slider = $('refOpacity'); if (slider) slider.value = Math.round(state.refOpacity * 100);
    const val = $('refOpacityVal'); if (val) val.textContent = Math.round(state.refOpacity * 100) + '%';
  }
  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(DOC_KEY, JSON.stringify({ w: state.w, h: state.h, cells: state.cells })); } catch (_) {}
    }, 400);
  }
  function loadSaved() {
    try { const s = JSON.parse(localStorage.getItem(DOC_KEY) || 'null'); return (s && s.w && Array.isArray(s.cells)) ? s : null; }
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
    g.drawImage(buf, 0, 0, state.w, state.h, 0, 0, tw, th);
    try { return c.toDataURL('image/png'); } catch (_) { return null; }
  }

  // ── Export PNG (true transparency preserved) ──
  // Draws the 1px-per-cell buffer onto a fresh, fully-transparent canvas with
  // nearest-neighbour upscaling — null cells stay transparent (alpha 0), so the
  // PNG carries real transparency, NOT the on-screen checkerboard. Upscaled so a
  // tiny grid still exports as a viewable image; edges stay hard (no smoothing).
  function exportPNG() {
    if (!state.cells.length) return;
    const scale = Math.max(1, Math.round(512 / Math.max(state.w, state.h)));
    const ew = state.w * scale, eh = state.h * scale;
    const c = document.createElement('canvas'); c.width = ew; c.height = eh;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(buf, 0, 0, state.w, state.h, 0, 0, ew, eh);
    let url; try { url = c.toDataURL('image/png'); } catch (_) { return; }
    downloadDataUrl(url, 'pixel-art-' + state.w + 'x' + state.h + '.png');
  }
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
    $('exportBtn').onclick = exportPNG;
    colorInput.addEventListener('input', (e) => setActiveColor(e.target.value));
    colorInput.addEventListener('change', (e) => addCustomColor(e.target.value));
    // Reference image: pick a file → underlay; slider sets its opacity.
    $('refBtn').onclick = () => $('refFile').click();
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
    window.addEventListener('keydown', (e) => {
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (meta && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      const map = { b: 'pencil', p: 'pencil', e: 'eraser', g: 'fill', i: 'eyedropper', l: 'line', r: 'rect', h: 'pan' };
      if (map[e.key.toLowerCase()] && !meta) selectTool(map[e.key.toLowerCase()]);
    });
    if (window.ResizeObserver) new ResizeObserver(() => resizeCanvas()).observe(stage);
    else window.addEventListener('resize', resizeCanvas);
  }

  // ── Init ──
  function init() {
    checkerPat = ctx.createPattern(makeChecker(), 'repeat');
    try { const c = localStorage.getItem(COLOR_KEY); if (c) state.color = c; } catch (_) {}
    curColorTop.style.background = state.color;
    try { colorInput.value = state.color; } catch (_) {}
    buildPalette(); wireUI(); wireDialog(); wirePointer();
    resizeCanvas();
    // Restore a persisted reference image + opacity (a working aid that
    // survives reopening; not part of any saved drawing).
    try {
      const o = parseFloat(localStorage.getItem(REF_OPACITY_KEY));
      if (o >= 0 && o <= 1) state.refOpacity = o;
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
      getDrawing() { return { w: state.w, h: state.h, cells: state.cells.slice() }; },
      loadDrawing(d) { if (d && d.w && d.h && Array.isArray(d.cells)) { hideNewDialog(); loadDoc(d); scheduleSave(); } },
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
