// main.js — wire the Viewer to the DOM controls, status line, and URL hash.
import { Viewer, SS_DEEP_CAP_RADIUS } from './viewer.js';
import { autoMaxIter } from './math/render.js';
import { PALETTES, setCustomPalettes, registerPalette, customPaletteDef, isCustomPalette, paletteRgbAt } from './palette.js';
import { embedText, extractText } from './pngMetadata.js';
import { recordFlight } from './flightRecorder.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');

// `?offscreen=0` forces the legacy on-main-thread GPU renderer (default: the OffscreenCanvas
// worker path when supported). A query param, not a hash key — the hash is reserved for the
// shareable view state, and this is a session/debug choice, not part of a bookmark.
const _q = new URLSearchParams(location.search);
const viewer = new Viewer(canvas, {
  onStatus: updateStatus,
  onView: (s) => { updateView(s); scheduleHash(); },
  offscreen: _q.get('offscreen') === '0' ? false : undefined,
});

// expose for tests / debugging
window.__viewer = viewer;

// ---------- status / readouts ----------
function updateStatus(s) {
  const el = $('status');
  if (s.error) { el.textContent = '⚠ ' + s.error.split('\n')[0]; return; }
  if (s.phase === 'maxdepth') { el.textContent = '⚠ maximum zoom depth reached (double-precision limit)'; return; }
  if (s.phase === 'gpuverify' && s.ok === false) {
    const kind = s.flips >= 2
      ? `${s.flips} sampled pixels read interior on the GPU but escape on the CPU`
      : `${Math.round(s.mismFrac * 100)}% of sampled pixels differ from the CPU reference`;
    el.textContent = `⚠ GPU precision self-test failed (${kind}` +
      `${s.cached ? '; cached-reference frame' : ''}) — deep detail may be off; ` +
      `toggle "GPU acceleration" off to compare`;
    return;
  }
  if (s.phase === 'start') el.textContent = `rendering · ${s.engine} · ${s.maxIter} it`;
  else if (s.phase === 'reference') el.textContent = `reference orbit ${pct(s.i, s.total)}`;
  else if (s.phase === 'render') el.textContent = `rendering ${pct(s.i, s.total)}`;
  else if (s.phase === 'done') {
    el.textContent = `${s.engine} · done${s.glitches ? ' · ' + s.glitches + ' glitch?' : ''}` +
      (s.gpuVerify === 'fail' ? ' · ⚠ GPU self-test failed' : '');
    $('debug').textContent = debugText(s);
    window.__lastDone = s;
    window.__doneCount = (window.__doneCount || 0) + 1; // test sync signal
  }
}
function pct(i, t) { return t ? Math.min(100, Math.round((i / t) * 100)) + '%' : ''; }
// Annotate the supersample readout: capped down for depth, or HQ-forced past the cap.
function ssNote() {
  if (viewer._effSS < viewer.ss) return ` (capped from ${viewer.ss}× for depth)`;
  if (viewer.forceHighQuality && viewer.radius < SS_DEEP_CAP_RADIUS && viewer._effSS > 1) {
    return ' (HQ: depth cap overridden)';
  }
  return '';
}
function debugText(s) {
  const v = viewer.getState();
  const gpu = viewer.gpuInfo();
  return [
    `engine     ${s.engine}`,
    `gpu        ${gpu ? gpu.replace(/^ANGLE \(/, '').slice(0, 48) : 'off (CPU workers)'}`,
    `zoom       2^${v.zoom.toFixed(2)}  (radius ${v.radius.toExponential(3)})${v.atMinRadius ? '  · AT PRECISION WALL' : ''}`,
    `maxIter    ${v.maxIter}`,
    `supersample ${viewer._effSS}×${ssNote()}  (compute ${viewer.cW}×${viewer.cH})`,
    `precision  ${viewer.prec} bits`,
    `refLen     ${s.refLen}  relocations ${s.relocations}${s.saSkip ? `  · SA skip ${s.saSkip} (${(100 * s.saSkip / Math.max(1, v.maxIter)).toFixed(0)}%)` : ''}`,
    `glitches   ${s.glitches}`,
    `backing    ${viewer.backingW}×${viewer.backingH} @dpr${viewer.dpr.toFixed(2)}${viewer.lowPower ? '  · low power' : ''}`,
    `selftest   ${viewer._gpuVerifyLast
      ? (viewer._gpuVerifyLast.ok ? 'ok' : `FAIL ${Math.round(viewer._gpuVerifyLast.mismFrac * 100)}%`) +
        (viewer._gpuVerifyLast.cached ? ' (cached ref)' : ' (fresh ref)')
      : '—'}`,
  ].join('\n');
}
function updateView(s) {
  $('zoom').textContent = '2^' + s.zoom.toFixed(1) + (s.atMinRadius ? ' (max)' : '');
  // Always-on center readout in complex "a + bi" form — orientation while exploring;
  // the panel's Re/Im fields keep the full precision.
  const re = shortCoord(s.cx), im = shortCoord(s.cy);
  const op = im.startsWith('−') ? '−' : '+';
  $('coords').textContent = `${re} ${op} ${im.replace(/^−/, '')}i`;
  if (document.activeElement !== $('reIn')) $('reIn').value = s.cx;
  if (document.activeElement !== $('imIn')) $('imIn').value = s.cy;
  if (document.activeElement !== $('radIn')) $('radIn').value = s.radius.toExponential(6);
  setIterUI(s.maxIter);
}

// Compact a high-precision decimal coord string for the always-on HUD readout. Keeps the
// sign + integer part + up to `digits` fractional digits, trims trailing zeros, and only
// appends an ellipsis when a *significant* (non-zero) digit was actually dropped — so an
// exact value like -0.5 shows "−0.5", not "−0.5000000000…". Real minus sign; "0" for zero.
function shortCoord(str, digits = 10) {
  const s = String(str).trim();
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf('.');
  const intPart = dot < 0 ? body : body.slice(0, dot);
  const frac = dot < 0 ? '' : body.slice(dot + 1);
  const kept = frac.slice(0, digits).replace(/0+$/, '');   // shown digits, trailing zeros trimmed
  const lost = /[1-9]/.test(frac.slice(digits));            // dropped a non-zero digit -> ellipsis
  if (intPart.replace(/^0+/, '') === '' && kept === '' && !lost) return '0'; // true zero
  return (neg ? '−' : '') + intPart + (kept ? '.' + kept : '') + (lost ? '…' : '');
}

// Keep the iteration slider + number field in sync with the current maxIter,
// without clobbering whichever control the user is actively editing. The slider
// is clamped to its track; the number field shows the true value (can exceed it).
function setIterUI(v) {
  const slider = $('iter'), num = $('iterNum');
  if (document.activeElement !== slider) {
    slider.value = Math.min(+slider.max, Math.max(+slider.min, v));
  }
  if (document.activeElement !== num) num.value = v;
}

// ---------- URL hash (bookmarks / shareable deep coords) ----------
let hashTimer = 0;
function scheduleHash() { clearTimeout(hashTimer); hashTimer = setTimeout(writeHash, 400); }
function writeHash() {
  const s = viewer.getState();
  const p = new URLSearchParams();
  p.set('re', s.cx); p.set('im', s.cy); p.set('r', s.radius.toExponential(8));
  p.set('i', s.maxIter); p.set('p', viewer.paletteOpts.paletteId);
  p.set('cy', viewer.paletteOpts.cycle); p.set('sh', viewer.paletteOpts.shift);
  p.set('ss', viewer.ss);
  p.set('res', viewer.resScale);
  if (viewer.interiorMode) p.set('in', viewer.interiorMode);
  // Custom palette (Spawn 42): a bare `custom_N` id is meaningless to a recipient (or
  // after localStorage clears), so a shared link carries the full palette definition
  // (name/colors/mirror), base64-encoded. readHash registers it transiently on load.
  const cdef = customPaletteDef(viewer.paletteOpts.paletteId);
  if (cdef) p.set('pdef', b64encode(JSON.stringify(cdef)));
  history.replaceState(null, '', '#' + p.toString());
}
function readHash() {
  if (!location.hash || location.hash.length < 2) return false;
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.get('re')) return false;
  // Custom palette from a shared link: register the carried def transiently and select it.
  if (p.get('pdef')) {
    try {
      const def = JSON.parse(b64decode(p.get('pdef')));
      if (def && Array.isArray(def.colors)) {
        registerPalette('custom_shared', def);
        viewer.paletteOpts.paletteId = 'custom_shared';
      }
    } catch { /* malformed pdef — fall through to p= */ }
  } else if (p.get('p')) viewer.paletteOpts.paletteId = p.get('p');
  if (p.get('cy')) viewer.paletteOpts.cycle = +p.get('cy');
  if (p.get('sh')) viewer.paletteOpts.shift = +p.get('sh');
  if (p.get('ss')) viewer.ss = Math.max(1, Math.min(4, +p.get('ss')));
  // Resolution setting rides in the URL too (Danielle's request — originally kept
  // per-device to avoid shared-link degradation traps; the panel select shows the
  // state, so a recipient can see + undo it). A change needs a RESIZE (backing dims),
  // not just a re-render — done below after setState; the interim render is cancelled.
  viewer.interiorMode = Math.max(0, Math.min(2, +(p.get('in') || 0)));
  let needResize = false;
  if (p.get('res')) {
    const r = Math.max(1, Math.min(4, Math.round(+p.get('res')) || 1));
    if (r !== viewer.resScale) { viewer.resScale = r; needResize = true; }
  }
  // writeHash records i= on EVERY url, so for almost all shared/bookmarked views the
  // recorded i is just the AUTO value at capture time. Pinning autoIter=false on every
  // load silently froze the iteration budget — zoom deeper from a loaded URL and the
  // view under-iterates (fine detail reads as interior), the Spawn-31 trap Danielle
  // hit live (her session carried i=26100 = auto-for-2^-103 down to 2^-251). Only pin
  // manual when i clearly DIFFERS from auto for this radius — a deliberate choice.
  const radius = +p.get('r');
  const iRaw = p.get('i') ? +p.get('i') : undefined;
  const auto = autoMaxIter(radius);
  const manualPin = iRaw !== undefined && Math.abs(iRaw - auto) > 0.02 * auto;
  viewer.setState({ cx: p.get('re'), cy: p.get('im'), radius,
                    maxIter: manualPin ? iRaw : undefined });
  if (manualPin) { viewer.autoIter = false; $('autoIter').checked = false; }
  else if (iRaw !== undefined) { viewer.autoIter = true; $('autoIter').checked = true; }
  if (needResize) viewer.resize();   // re-sizes the backing + re-renders at the new res
  syncControls();
  return true;
}

// ---------- controls ----------
function syncControls() {
  populatePaletteSelect();
  $('palette').value = viewer.paletteOpts.paletteId;
  $('cycle').value = viewer.paletteOpts.cycle;
  $('shift').value = viewer.paletteOpts.shift;
  $('cycleVal').textContent = viewer.paletteOpts.cycle;
  $('autoIter').checked = viewer.autoIter;
  $('ss').value = String(viewer.ss);
  $('resScale').value = String(viewer.resScale);
  $('interiorMode').value = String(viewer.interiorMode);
  $('showGlitch').checked = viewer.showGlitches;
  $('forceHQ').checked = viewer.forceHighQuality;
  $('lowPower').checked = viewer.lowPower;
  $('series').checked = viewer.series;
  syncQualityToggle();
}

// ---------- Explore / Draw quality toggle ----------
// A one-tap shortcut over the two look controls that cost the most: supersampling (AA) and
// render resolution. Explore = fast (1/3 res, AA off); Draw = crisp (full res, 2× AA). The
// toggle owns no state of its own — it just sets ss + resScale and reads them back, so it
// can't drift out of sync with the panel selects, and it inherits their URL persistence.
const QUALITY_MODES = {
  explore: { ss: 1, resScale: 3 },
  draw:    { ss: 2, resScale: 1 },
};
// Which preset (if any) the current ss/resScale match — null for a custom combination,
// in which case neither pill is lit.
function currentQualityMode() {
  for (const [name, m] of Object.entries(QUALITY_MODES)) {
    if (viewer.ss === m.ss && viewer.resScale === m.resScale) return name;
  }
  return null;
}
function syncQualityToggle() {
  const cur = currentQualityMode();
  document.querySelectorAll('.qmode').forEach((b) => {
    if (b.dataset.mode === cur) b.setAttribute('aria-pressed', 'true');
    else b.removeAttribute('aria-pressed');
  });
}
function setQualityMode(name) {
  const m = QUALITY_MODES[name];
  if (!m) return;
  // Set both fields directly, then re-render ONCE. A resScale change needs resize() (backing
  // dims change); an ss-only change just needs render(). We can't lean on setResScale/
  // setSupersample here — each early-returns when its own value is unchanged, which would
  // drop the sibling field's render (e.g. from a custom res=1,ss=1 state, "Draw" changes
  // only ss, so setResScale would no-op and never pick up the new AA).
  const resChanged = viewer.resScale !== m.resScale;
  viewer.ss = Math.max(1, Math.min(4, m.ss));
  viewer.resScale = Math.max(1, Math.min(4, m.resScale));
  if (resChanged) viewer.resize();   // re-sizes backing + re-renders
  else viewer.render();              // ss-only change
  syncControls();                    // reflect the ss/resScale selects + light the pill
  scheduleHash();                    // persist, exactly as the panel selects do
}
document.querySelectorAll('.qmode').forEach((b) =>
  b.addEventListener('click', () => setQualityMode(b.dataset.mode)));

$('panelToggle').addEventListener('click', () => $('panel').classList.toggle('open'));
$('panelClose').addEventListener('click', () => $('panel').classList.remove('open'));

$('zoomIn').addEventListener('click', () => viewer.zoomBy(0.5));
$('zoomOut').addEventListener('click', () => viewer.zoomBy(2));
$('reset').addEventListener('click', () => {
  viewer.setState({ cx: '-0.5', cy: '0', radius: 1.5 });
  viewer.autoIter = true; $('autoIter').checked = true;
});

// Iterations: slider for quick scrubbing, number field for precise/large values.
// Both commit on `change` (slider release / Enter / blur); `input` just mirrors
// the live value to the sibling control so they always agree, without rendering.
function commitIter(v) {
  if (!isFinite(v) || v < 1) return;
  viewer.setMaxIter(Math.round(v)); // sets autoIter=false + re-renders
  $('autoIter').checked = false;
}
$('iter').addEventListener('input', (e) => { $('iterNum').value = e.target.value; });
$('iter').addEventListener('change', (e) => commitIter(+e.target.value));
$('iterNum').addEventListener('input', (e) => {
  const v = +e.target.value;
  if (isFinite(v) && v > 0) $('iter').value = Math.min(+$('iter').max, Math.max(+$('iter').min, v));
});
$('iterNum').addEventListener('change', (e) => commitIter(+e.target.value));
$('autoIter').addEventListener('change', (e) => viewer.setAutoIter(e.target.checked));
$('useGpu').addEventListener('change', (e) => viewer.setUseGpu(e.target.checked));
$('showGlitch').addEventListener('change', (e) => viewer.setShowGlitches(e.target.checked));
$('forceHQ').addEventListener('change', (e) => viewer.setForceHighQuality(e.target.checked));
$('lowPower').addEventListener('change', (e) => { viewer.setLowPower(e.target.checked); markLowPowerManual(); });
$('series').addEventListener('change', (e) => viewer.setSeries(e.target.checked));
$('ss').addEventListener('change', (e) => { viewer.setSupersample(+e.target.value); syncQualityToggle(); scheduleHash(); });
// Resolution (render pixels): full/half/third of the true canvas resolution.
// URL-persisted at Danielle's request (Spawn 34) — like ss, it rides in the hash so a
// bookmarked view reproduces its full look/perf; the panel select keeps it visible.
$('resScale').addEventListener('change', (e) => { viewer.setResScale(+e.target.value); syncQualityToggle(); scheduleHash(); });
// Interior coloring (Spawn 41): reveals structure INSIDE the set (attractor phase /
// orbit distance). URL-persisted like the other look settings.
$('interiorMode').addEventListener('change', (e) => { viewer.setInteriorMode(+e.target.value); scheduleHash(); });

$('cycle').addEventListener('input', (e) => { $('cycleVal').textContent = e.target.value; viewer.setPalette({ cycle: +e.target.value }); scheduleHash(); });
$('shift').addEventListener('input', (e) => { viewer.setPalette({ shift: +e.target.value }); scheduleHash(); });

// ---------- custom palettes (Spawn 42) ----------
// UTF-8-safe base64 for embedding palette defs in URLs / PNG metadata.
function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64decode(b64) { return decodeURIComponent(escape(atob(b64))); }

const CUSTOM_KEY = 'customPalettes';
function loadCustomRaw() { try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]'); } catch { return []; } }
function saveCustomRaw(arr) { localStorage.setItem(CUSTOM_KEY, JSON.stringify(arr)); }

// Register saved custom palettes into the palette module (both threads resolve by id).
function refreshCustomPalettes() { setCustomPalettes(loadCustomRaw()); }

// (Re)build the palette <select>: built-ins, then a "Custom" optgroup, then any transient
// shared-link palette. Keeps the current selection if it still exists.
function populatePaletteSelect() {
  const sel = $('palette');
  const want = viewer.paletteOpts.paletteId;
  sel.textContent = '';
  for (const [id, p] of Object.entries(PALETTES)) {
    const o = document.createElement('option');
    o.value = id; o.textContent = p.name; sel.appendChild(o);
  }
  const custom = loadCustomRaw();
  if (custom.length) {
    const g = document.createElement('optgroup'); g.label = 'Custom';
    custom.forEach((def, i) => {
      const o = document.createElement('option');
      o.value = `custom_${i}`; o.textContent = def.name || `Custom ${i + 1}`; g.appendChild(o);
    });
    sel.appendChild(g);
  }
  if (isCustomPalette(want) && want === 'custom_shared') {
    const o = document.createElement('option');
    o.value = 'custom_shared'; o.textContent = (customPaletteDef(want)?.name || 'Shared') + ' (link)';
    sel.appendChild(o);
  }
  sel.value = want;
}

$('palette').addEventListener('change', (e) => {
  viewer.setPalette({ paletteId: e.target.value }); scheduleHash();
  if (!$('palEditor').hidden) closeEditor();
});

// ---- the editor ----
let editStops = [];       // [{ hex, weight }]
let editMirror = false;
let editingId = null;     // custom_N being edited, or null for a new palette

function hexOf(rgb) { return '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''); }
function defToStops(def) {
  return (def.colors || []).map((c) => {
    const wi = c.indexOf(':');
    return { hex: wi === -1 ? c : c.slice(0, wi), weight: wi === -1 ? 1 : parseFloat(c.slice(wi + 1)) || 1 };
  });
}
function stopsToColors() {
  return editStops.map((s) => s.weight === 1 ? s.hex : `${s.hex}:${s.weight}`);
}
function currentDef() { return { name: $('palName').value.trim() || 'My palette', colors: stopsToColors(), mirror: editMirror }; }

function drawPreview() {
  const cv = $('palPreview'), g = cv.getContext('2d');
  registerPalette('custom_preview', currentDef());   // parity with the render LUT
  for (let x = 0; x < cv.width; x++) {
    const rgb = paletteRgbAt('custom_preview', x / cv.width);
    g.fillStyle = `rgb(${rgb.map(Math.round).join(',')})`;
    g.fillRect(x, 0, 1, cv.height);
  }
}

function renderStopRows() {
  const box = $('palStops'); box.textContent = '';
  editStops.forEach((s, i) => {
    const row = document.createElement('div'); row.className = 'pal-stop';
    const color = document.createElement('input'); color.type = 'color'; color.value = s.hex;
    color.addEventListener('input', () => { s.hex = color.value; drawPreview(); });
    const weight = document.createElement('input'); weight.type = 'number'; weight.min = '0.1'; weight.step = '0.1';
    weight.value = String(s.weight); weight.title = 'weight (span)';
    weight.addEventListener('input', () => { s.weight = Math.max(0.1, +weight.value || 1); drawPreview(); });
    const rm = document.createElement('button'); rm.className = 'btn pal-rm'; rm.textContent = '✕'; rm.title = 'remove';
    rm.addEventListener('click', () => { if (editStops.length > 2) { editStops.splice(i, 1); renderStopRows(); drawPreview(); } });
    row.append(color, weight, rm);
    box.appendChild(row);
  });
}

function openEditor(fromExisting) {
  editingId = fromExisting && isCustomPalette(viewer.paletteOpts.paletteId) && /^custom_\d+$/.test(viewer.paletteOpts.paletteId)
    ? viewer.paletteOpts.paletteId : null;
  const def = editingId ? loadCustomRaw()[+editingId.split('_')[1]]
    : { name: '', colors: ['#000010', '#2050c0', '#ffffff', '#ffaa00', '#000000'], mirror: false };
  $('palName').value = def.name || '';
  editStops = defToStops(def).length ? defToStops(def) : [{ hex: '#000000', weight: 1 }, { hex: '#ffffff', weight: 1 }];
  editMirror = !!def.mirror; $('palMirror').checked = editMirror;
  $('palDelete').hidden = !editingId;
  renderStopRows(); drawPreview();
  $('palEditor').hidden = false;
}
function closeEditor() { $('palEditor').hidden = true; }

$('palNew').addEventListener('click', () => openEditor(false));
$('palEdit').addEventListener('click', () => {
  if (!isCustomPalette(viewer.paletteOpts.paletteId)) { $('status').textContent = 'select a custom palette to edit (or New)'; return; }
  openEditor(true);
});
$('palAddColor').addEventListener('click', () => { editStops.push({ hex: '#ffffff', weight: 1 }); renderStopRows(); drawPreview(); });
$('palMirror').addEventListener('change', (e) => { editMirror = e.target.checked; drawPreview(); });
$('palCancel').addEventListener('click', closeEditor);
$('palDelete').addEventListener('click', () => {
  if (!editingId) return closeEditor();
  const arr = loadCustomRaw(); arr.splice(+editingId.split('_')[1], 1); saveCustomRaw(arr);
  refreshCustomPalettes();
  viewer.paletteOpts.paletteId = 'ultra';
  populatePaletteSelect(); viewer.setPalette({ paletteId: 'ultra' }); closeEditor(); scheduleHash();
});
$('palSave').addEventListener('click', () => {
  const def = currentDef();
  const arr = loadCustomRaw();
  let idx;
  if (editingId) { idx = +editingId.split('_')[1]; arr[idx] = def; } else { arr.push(def); idx = arr.length - 1; }
  saveCustomRaw(arr);
  refreshCustomPalettes();
  const id = `custom_${idx}`;
  viewer.paletteOpts.paletteId = id;
  populatePaletteSelect();
  viewer.setPalette({ paletteId: id });   // registers + recolors
  closeEditor(); scheduleHash();
});

$('goto').addEventListener('click', () => {
  const re = $('reIn').value.trim(), im = $('imIn').value.trim();
  let r = parseFloat($('radIn').value.trim());
  if (!isFinite(r) || r <= 0) r = viewer.radius;
  viewer.setState({ cx: re, cy: im, radius: r });
  $('panel').classList.remove('open');
});
$('copyLink').addEventListener('click', async () => {
  writeHash();
  try { await navigator.clipboard.writeText(location.href); $('status').textContent = 'link copied'; }
  catch { $('status').textContent = location.href; }
});
// Save PNG with the full view state embedded in a tEXt chunk (Spawn 42) — "Open PNG…"
// restores the exact location/palette from a saved image. writeHash() first so the hash
// is current; the embedded text is the hash body (identical encoding to a shared link).
$('save').addEventListener('click', () => {
  writeHash();
  const meta = location.hash.slice(1);
  canvas.toBlob(async (blob) => {
    if (!blob) return;
    let bytes = new Uint8Array(await blob.arrayBuffer());
    try { bytes = embedText(bytes, 'mandelbrot', meta); } catch { /* embed best-effort */ }
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    const a = document.createElement('a');
    a.download = `mandelbrot_2e${viewer.zoomLevel().toFixed(0)}.png`;
    a.href = url; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, 'image/png');
});

// Open PNG… — restore a location from a previously-saved image's embedded metadata.
$('resumeBtn').addEventListener('click', () => $('resumeFile').click());
$('resumeFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';   // allow re-selecting the same file later
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const meta = extractText(bytes, 'mandelbrot');
    if (!meta) { $('status').textContent = 'no fractal location found in that PNG'; return; }
    location.hash = meta;   // triggers hashchange -> readHash() applies it
    if (!readHash()) $('status').textContent = 'could not read location from PNG';
    else $('panel').classList.remove('open');
  } catch { $('status').textContent = 'could not read that PNG'; }
});

// ---------- flight recorder (Spawn 42) ----------
// Record a zoom flight from the home view down to the current one as a video. Frames
// share the current full-precision center (re-derived from the high-precision decimal
// string each frame — no drift), auto-iterations per frame. The same-center zoom-in is
// exactly the reference cache's fast path, so deep flights reuse orbits as they descend.
const FLIGHT_START_RADIUS = 1.5;
let recording = false, cancelRec = false;
$('recordBtn').addEventListener('click', async () => {
  if (recording) return;
  const st = viewer.getState();   // cx/cy = full-precision decimal strings, radius, maxIter
  const targetRadius = st.radius;
  if (!(targetRadius < FLIGHT_START_RADIUS)) { $('status').textContent = 'zoom in first to record a flight'; return; }
  recording = true; cancelRec = false;
  const wasAuto = viewer.autoIter;
  $('recordRow').hidden = false; $('recordBtn').disabled = true; $('save').disabled = true;

  const renderFrame = (radius) => new Promise((resolve) => {
    const start = window.__doneCount || 0;
    viewer.autoIter = true;
    viewer.setState({ cx: st.cx, cy: st.cy, radius });
    const check = () => {
      if (cancelRec || (window.__doneCount || 0) > start) resolve();
      else requestAnimationFrame(check);
    };
    check();
  });

  try {
    const blob = await recordFlight(canvas, {
      startRadius: FLIGHT_START_RADIUS, targetRadius, renderFrame,
      onProgress: (phase, done, total) => {
        $('recordProgress').value = phase === 'rendering' ? (done / total) * 0.5 : 0.5 + (done / total) * 0.5;
        $('recordLabel').textContent = `${phase} ${done}/${total}`;
      },
      isCancelled: () => cancelRec,
    });
    if (blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.download = `mandelbrot-flight_2e${viewer.zoomLevel().toFixed(0)}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`;
      a.href = url; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 8000);
      $('status').textContent = 'flight saved';
    } else $('status').textContent = 'recording cancelled';
  } catch (err) {
    $('status').textContent = '⚠ ' + (err && (err.message || err));
  } finally {
    recording = false;
    viewer.autoIter = wasAuto;
    $('recordRow').hidden = true; $('recordBtn').disabled = false; $('save').disabled = false;
    // land back on the exact target view
    viewer.setState({ cx: st.cx, cy: st.cy, radius: targetRadius, maxIter: wasAuto ? undefined : st.maxIter });
  }
});
$('recordCancel').addEventListener('click', () => { cancelRec = true; $('recordLabel').textContent = 'cancelling…'; });

document.querySelectorAll('.place').forEach((b) => b.addEventListener('click', () => {
  viewer.setState({ cx: b.dataset.cx, cy: b.dataset.cy, radius: parseFloat(b.dataset.r) });
  $('panel').classList.remove('open');
}));

// ---------- low-power / battery auto-detect ----------
// A manual toggle is authoritative: once the user touches the Low-power checkbox we stop
// auto-managing it (so we never fight their choice). Until then, if the Battery Status API
// is available, auto-enable low-power while the device is discharging and low, and lift it
// when charging / recovered. The API is absent in many browsers (incl. headless Chromium and
// Firefox) — it's a progressive enhancement; the manual toggle is the real control.
let lowPowerManual = false;
function markLowPowerManual() { lowPowerManual = true; }
const LOW_BATTERY_LEVEL = 0.2;
async function initBatteryDetect() {
  if (typeof navigator === 'undefined' || !navigator.getBattery) return;
  let battery;
  try { battery = await navigator.getBattery(); } catch { return; }
  const apply = () => {
    if (lowPowerManual) return;                    // user took over; don't auto-manage
    const want = !battery.charging && battery.level <= LOW_BATTERY_LEVEL;
    if (want !== viewer.lowPower) { viewer.setLowPower(want); syncControls(); }
  };
  battery.addEventListener('levelchange', apply);
  battery.addEventListener('chargingchange', apply);
  apply();
}

// ---------- keyboard navigation (desktop) ----------
// Arrow keys pan, +/- zoom, f fullscreen, ? help. Discrete (auto-repeat ignored) so a
// held key can't fly the preview snapshot off into black; each press settles to a sharp
// render via the same machinery as the wheel/buttons. Never hijacks a focused form field
// (so typing into the coord/iteration inputs works) or a browser shortcut (ctrl/meta/alt).
const PAN_STEP = 0.18; // fraction of the viewport panned per arrow press
window.addEventListener('keydown', (e) => {
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  let handled = true;
  switch (e.key) {
    case 'ArrowLeft':  if (!e.repeat) viewer.panByPreview(+PAN_STEP * viewer.backingW, 0); break;
    case 'ArrowRight': if (!e.repeat) viewer.panByPreview(-PAN_STEP * viewer.backingW, 0); break;
    case 'ArrowUp':    if (!e.repeat) viewer.panByPreview(0, +PAN_STEP * viewer.backingH); break;
    case 'ArrowDown':  if (!e.repeat) viewer.panByPreview(0, -PAN_STEP * viewer.backingH); break;
    case '+': case '=': if (!e.repeat) viewer.zoomBy(0.5); break;
    case '-': case '_': if (!e.repeat) viewer.zoomBy(2); break;
    case 'f': case 'F': if (!e.repeat) toggleFullscreen(); break;
    case '?':           if (!e.repeat) showHint(); break;
    default: handled = false;
  }
  if (handled) e.preventDefault();
});

// ---------- fullscreen ----------
function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  } catch { /* fullscreen may be blocked (no user gesture / unsupported) — ignore */ }
}
$('fullscreen').addEventListener('click', toggleFullscreen);

// ---------- first-run gesture hint ----------
// Shown once per device (localStorage), re-openable via the “?” button or the “?” key.
// The overlay is pointer-events:none, so the first tap/drag/scroll/key both dismisses it
// AND performs its action — we listen in the capture phase and never consume the event.
const HINT_KEY = 'mb_hintSeen';
function showHint() { $('hint').classList.add('show'); }
function hideHint(persist = true) {
  const el = $('hint');
  if (!el.classList.contains('show')) return;
  el.classList.remove('show');
  if (persist) { try { localStorage.setItem(HINT_KEY, '1'); } catch { /* private mode */ } }
}
['pointerdown', 'keydown', 'wheel'].forEach((ev) =>
  window.addEventListener(ev, () => hideHint(), { capture: true, passive: true }));
$('help').addEventListener('click', showHint);
try { if (!localStorage.getItem(HINT_KEY)) showHint(); }
catch { showHint(); }   // storage blocked: still show it (just won't persist the dismissal)

// ---------- boot ----------
refreshCustomPalettes();   // register saved custom palettes before the first render/hash
populatePaletteSelect();
syncControls();
setIterUI(viewer.maxIter);
let resizeTimer = 0;
// The "stable" viewport is the layout size with no soft keyboard up. When the app
// is embedded (e.g. the extras Fractals-2 tool) and its Save dialog focuses a text
// input, the keyboard shrinks the iframe's height only — the width stays put. That
// fires a resize, and re-deriving the backing + re-rendering a deep zoom just to
// have it thrown away when the keyboard dismisses is exactly the wasteful rerender
// we want to avoid. Detect that case (same width, shorter height) and simply pin the
// canvas box to its pre-keyboard height instead of resizing — no distortion, no render.
let stableVpW = window.innerWidth, stableVpH = window.innerHeight;
// Soft keyboards only exist on touch devices; gate the skip on a coarse pointer so a
// vertical-only window drag on desktop still reflows normally.
const hasSoftKeyboard = () => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } };
let vpPinned = false;
function onViewportResize() {
  const w = window.innerWidth, h = window.innerHeight;
  if (hasSoftKeyboard() && w === stableVpW && h < stableVpH) {
    canvas.style.height = stableVpH + 'px';   // hold the box; keyboard just covers the bottom
    vpPinned = true;
    return;
  }
  if (vpPinned && w === stableVpW && h === stableVpH) {
    // Keyboard dismissed and the box is back to its pre-keyboard size. We never
    // touched the backing while pinned, so just drop the pin — no resize, no render.
    canvas.style.height = '';
    vpPinned = false;
    return;
  }
  // A genuine resize (rotation, desktop drag): adopt the new size as the baseline,
  // drop any pin, and let resize() re-derive the backing and re-render.
  stableVpW = w; stableVpH = h;
  canvas.style.height = '';
  vpPinned = false;
  viewer.resize();
}
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(onViewportResize, 150); });
// initial size + render (after layout), then apply any bookmarked hash
requestAnimationFrame(() => {
  viewer.resize();   // sizes the canvas and renders the default view
  readHash();        // if a deep-zoom link is present, override and re-render
  initBatteryDetect(); // progressive: auto-enable low-power on a low/discharging battery
});
window.addEventListener('hashchange', () => readHash());
