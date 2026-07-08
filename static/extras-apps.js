// Extras → Quiver / Synth: full-screen bundled mini-apps with named saves.
//
// Self-contained: this whole feature lives in this one file. It plugs into the
// Extras launcher via the generic global.ExtrasRegisterTool({ ..., open }) hook
// in extras.js (full-screen tools open their own window instead of an inline
// sheet view — same idea as the Fractals window).
//
// Each app runs in an <iframe> (same-origin /static/*.html, so the parent can
// read/write its state directly). Saving:
//   - Synth: window.SynthApp.getSong()/loadSong() inside synth.html.
//   - Quiver: the full state lives in the page's URL hash, so we save the hash
//     and reload the iframe to it (no quiver-internal hooks needed).
// Saved songs/quivers live in their own IndexedDB (too big for localStorage)
// and are exposed via window.ExtrasSongs / window.ExtrasQuivers so index.html's
// backup export/import carries them inside the creature-collect save file —
// exactly like saved fractals.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';
  global._scriptVersions = global._scriptVersions || {};
  global._scriptVersions['extras-apps.js'] = SCRIPT_VERSION;

  const QUIVER_SRC = '/static/quiver.html';
  const SYNTH_SRC = '/static/synth.html';
  const DRAW_SRC = '/static/draw/index.html';
  const PIXELART_SRC = '/static/pixelart/index.html';

  // Pixel Art bubble icon: a 2×2 block of pixels in palette-ish colours.
  const PIXEL_ICON =
    '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" style="display:block">'
    + '<rect x="4" y="4" width="7.4" height="7.4" rx="1" fill="#ff004d"/>'
    + '<rect x="12.6" y="4" width="7.4" height="7.4" rx="1" fill="#ffec27"/>'
    + '<rect x="4" y="12.6" width="7.4" height="7.4" rx="1" fill="#29adff"/>'
    + '<rect x="12.6" y="12.6" width="7.4" height="7.4" rx="1" fill="#00e436"/>'
    + '</svg>';

  // Draw bubble icon: a pencil drawing a stroke. Inline SVG, currentColor
  // so it matches the theme/text (same approach as the Quiver icon below).
  const DRAW_ICON =
    '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" style="display:block">'
    + '<g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M14.5 5.5 L18.5 9.5"/>'
    + '<path d="M16 4 L20 8 L9 19 L4 20.5 L5.5 15.5 Z"/>'
    + '<path d="M4 20.5 Q9 22 14 20"/>'
    + '</g>'
    + '</svg>';

  // Top-bar glyphs (currentColor line icons, matching the bar's white text).
  const ICON_UNDO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7 L4 12 L9 17"/><path d="M4 12 h10 a5 5 0 0 1 5 5 v1"/></svg>';
  const ICON_REDO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7 L20 12 L15 17"/><path d="M20 12 h-10 a5 5 0 0 0 -5 5 v1"/></svg>';
  const ICON_X = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg>';

  // Quiver bubble icon: three nodes in a triangle with directed arrows
  // left -> top and top -> right. Inline SVG; uses currentColor to match the
  // theme/text. Arrowheads are stroked chevrons (no markers) for WebKit safety.
  const QUIVER_ICON =
    '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" style="display:block">'
    + '<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'
    + '<line x1="6.5" y1="15.2" x2="10.6" y2="7.6"/>'
    + '<path d="M7.94 9.38 L10.6 7.6 L10.58 10.8"/>'
    + '<line x1="13.4" y1="7.6" x2="17.6" y2="15.4"/>'
    + '<path d="M17.58 12.2 L17.6 15.4 L14.94 13.62"/>'
    + '</g>'
    + '<circle cx="12" cy="5" r="2.4" fill="currentColor"/>'
    + '<circle cx="5" cy="18" r="2.4" fill="currentColor"/>'
    + '<circle cx="19" cy="18" r="2.4" fill="currentColor"/>'
    + '</svg>';

  // ────────────────────────────────────────────────────────────
  // IndexedDB store (songs + quivers)
  // ────────────────────────────────────────────────────────────
  const DB_NAME = 'cc-extras-apps-v1';
  const DB_VER = 4;
  // 'state' holds single-record current-state autosaves (e.g. the live quiver).
  // 'drawings' holds named saves from the Draw app (added v3).
  // 'pixelart' holds named saves from the Pixel Art app (added v4).
  const STORE_NAMES = ['songs', 'quivers', 'state', 'drawings', 'pixelart'];

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        STORE_NAMES.forEach((s) => {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function idbAll(store) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const rq = db.transaction(store, 'readonly').objectStore(store).getAll();
      rq.onsuccess = () => resolve(rq.result || []);
      rq.onerror = () => reject(rq.error);
    }));
  }
  function idbPut(store, rec) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }
  function idbDel(store, id) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }
  function idbGet(store, id) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const rq = db.transaction(store, 'readonly').objectStore(store).get(id);
      rq.onsuccess = () => resolve(rq.result || null);
      rq.onerror = () => reject(rq.error);
    }));
  }

  function makeStore(name) {
    return {
      all: () => idbAll(name),
      put: (rec) => idbPut(name, rec),
      del: (id) => idbDel(name, id),
      // Union-merge by id (used by backup import) — skip ids we already have.
      importMerge: async (arr) => {
        if (!Array.isArray(arr)) return;
        const have = new Set((await idbAll(name)).map((r) => r.id));
        for (const r of arr) {
          if (r && r.id && !have.has(r.id)) await idbPut(name, r);
        }
      },
    };
  }

  const songsStore = makeStore('songs');
  const quiversStore = makeStore('quivers');
  const drawingsStore = makeStore('drawings');
  const pixelartStore = makeStore('pixelart');
  // Exposed for index.html's backup export/import (mirrors window.ExtrasFractals).
  global.ExtrasSongs = songsStore;
  global.ExtrasQuivers = quiversStore;
  global.ExtrasDrawings = drawingsStore;
  global.ExtrasPixelArt = pixelartStore;

  // ────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtDate(ms) {
    if (!ms) return '';
    try { return new Date(ms).toLocaleDateString(); } catch (e) { return ''; }
  }
  function newId() {
    return 'x' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  }

  function injectCss() {
    if (document.getElementById('exapp-css')) return;
    const css = `
    .exapp-win { position: fixed; inset: 0; z-index: 1200; background: #0b0b0c; display: none;
      --exapp-bar: calc(44px + env(safe-area-inset-top, 0px)); }
    .exapp-win.show { display: block; }
    .exapp-frame { position: absolute; left: 0; right: 0; top: var(--exapp-bar); bottom: 0;
      width: 100%; height: calc(100% - var(--exapp-bar)); border: 0; background: #0b0b0c; }
    .exapp-bar { position: absolute; top: 0; left: 0; right: 0; height: var(--exapp-bar);
      padding-top: env(safe-area-inset-top, 0px); display: flex; align-items: center; gap: 8px;
      padding-left: 10px; padding-right: 10px; background: rgba(0,0,0,0.72); color: #fff; box-sizing: border-box; }
    .exapp-title { flex: 1; min-width: 0; text-align: center; font-size: 14px; font-weight: 600; opacity: .9;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .exapp-btn { padding: 6px 12px; font-size: 13px; font-weight: 600; color: #fff;
      background: rgba(255,255,255,0.16); border: none; border-radius: 6px; cursor: pointer; flex: none; }
    .exapp-btn:hover { background: rgba(255,255,255,0.26); }
    /* Icon-only bar buttons (undo / redo / close): square, centred glyph. */
    .exapp-iconbtn { padding: 0; width: 34px; height: 34px; display: inline-flex;
      align-items: center; justify-content: center; }
    .exapp-iconbtn svg { display: block; }
    /* Close sits apart from the undo/redo cluster so it's not fat-fingered. */
    .exapp-close { background: rgba(224,90,107,0.55); margin-left: 14px; }
    .exapp-close:hover { background: rgba(224,90,107,0.82); }
    .exapp-confirm-msg { white-space: pre-line; }
    .exapp-overlay { position: absolute; left: 0; right: 0; top: var(--exapp-bar); bottom: 0;
      display: none; align-items: flex-start; justify-content: center; background: rgba(0,0,0,0.5); z-index: 2; }
    .exapp-overlay.show { display: flex; }
    .exapp-card { margin-top: 28px; width: min(92%, 360px); max-height: 80%;
      display: flex; flex-direction: column; overflow: hidden;
      background: #1c1c1f; color: #fff; border-radius: 12px; padding: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    .exapp-card h4 { margin: 0 0 12px; font-size: 15px; text-align: center; }
    .exapp-name { width: 100%; box-sizing: border-box; padding: 10px; font-size: 15px;
      border-radius: 8px; border: 1px solid rgba(255,255,255,0.2); background: #111; color: #fff; margin-bottom: 12px; }
    .exapp-card-row { display: flex; gap: 8px; }
    .exapp-card-row .exapp-btn { flex: 1; text-align: center; }
    /* The list is the scroll container (h4 + Close stay pinned) so long
       libraries scroll instead of overflowing the screen. min-height:0 is
       required for a flex child to actually shrink + scroll. */
    .exapp-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px;
      flex: 1 1 auto; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; }
    .exapp-item { display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.08);
      border-radius: 8px; padding: 4px 4px 4px 8px; }
    .exapp-thumb { width: 54px; height: 40px; object-fit: contain; border-radius: 4px;
      background: #111; flex: none; }
    .exapp-item-name { flex: 1; min-width: 0; text-align: left; background: none; border: none;
      color: #fff; font-size: 14px; cursor: pointer; padding: 8px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .exapp-item-meta { font-size: 11px; opacity: .5; margin-right: 2px; white-space: nowrap; }
    .exapp-del { background: none; border: none; color: #fff; opacity: .6; font-size: 16px; cursor: pointer; padding: 6px 10px; }
    .exapp-del:hover { color: #ff6b6b; opacity: 1; }
    .exapp-empty { font-size: 13px; opacity: .55; text-align: center; padding: 8px; }
    /* Hold-to-delete confirm — a 2s deliberate hold (matches the Fractals
       window) so a saved item can't be lost to an accidental tap. */
    .exapp-del-name { font-size: 13px; color: rgba(255,255,255,0.55); text-align: center;
      margin-bottom: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .exapp-hold { position: relative; overflow: hidden; width: 100%; display: block; margin-bottom: 10px;
      padding: 12px 14px; border-radius: 8px; border: none; background: #e0524b; color: #fff;
      font: inherit; font-weight: 600; cursor: pointer; user-select: none; -webkit-user-select: none;
      -webkit-tap-highlight-color: transparent; touch-action: none; }
    .exapp-hold-fill { position: absolute; top: 0; left: 0; bottom: 0; width: 0; background: #9e1c16; }
    .exapp-hold.holding .exapp-hold-fill { width: 100%; transition: width 2s linear; }
    .exapp-hold-label { position: relative; z-index: 1; }
    .exapp-toast { position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%);
      background: rgba(0,0,0,0.85); color: #fff; padding: 8px 16px; border-radius: 20px; font-size: 13px;
      z-index: 3; opacity: 0; transition: opacity .2s; pointer-events: none; }
    .exapp-toast.show { opacity: 1; }
    `;
    const style = document.createElement('style');
    style.id = 'exapp-css';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ────────────────────────────────────────────────────────────
  // Full-screen app window factory
  //   cfg = { title, noun, nounPlural, src, store,
  //           capture(iframeWin) -> data|null,
  //           apply(iframeEl, iframeWin, data),
  //           leadActions, trailActions }
  //
  // leadActions / trailActions: optional per-app bar buttons. Each is
  //   { html, title, onClick(api) } where api = { frameWin(), toast,
  //   confirm(msg, okLabel, onOk), close }. Lead actions sit left (with
  //   Save/Saved); trail actions sit right of the title, before the X.
  // ────────────────────────────────────────────────────────────
  function makeAppWindow(cfg) {
    injectCss();
    const renderActions = (list, side) => (list || []).map((a, i) =>
      `<button class="exapp-btn exapp-act${a.iconBtn ? ' exapp-iconbtn' : ''}" data-act="${side}-${i}" type="button"`
      + ` title="${escapeHtml(a.title || '')}" aria-label="${escapeHtml(a.title || '')}">${a.html}</button>`
    ).join('');
    const win = document.createElement('div');
    win.className = 'exapp-win';
    win.innerHTML = `
      <div class="exapp-bar">
        ${renderActions(cfg.leadActions, 'lead')}
        <button class="exapp-btn exapp-save" type="button">Save</button>
        <button class="exapp-btn exapp-browse" type="button">Saved</button>
        <div class="exapp-title">${escapeHtml(cfg.title)}</div>
        ${renderActions(cfg.trailActions, 'trail')}
        <button class="exapp-btn exapp-iconbtn exapp-close" type="button" title="Close" aria-label="Close">${ICON_X}</button>
      </div>
      <iframe class="exapp-frame" title="${escapeHtml(cfg.title)}" allow="web-share"></iframe>
      <div class="exapp-overlay exapp-save-overlay">
        <div class="exapp-card">
          <h4>Save ${escapeHtml(cfg.noun)}</h4>
          <input class="exapp-name" type="text" maxlength="40" placeholder="name it…">
          <div class="exapp-card-row">
            <button class="exapp-btn exapp-save-ok" type="button">Save</button>
            <button class="exapp-btn exapp-save-cancel" type="button">Cancel</button>
          </div>
        </div>
      </div>
      <div class="exapp-overlay exapp-browse-overlay">
        <div class="exapp-card">
          <h4>Saved ${escapeHtml(cfg.nounPlural)}</h4>
          <div class="exapp-list"></div>
          <button class="exapp-btn exapp-browse-close" type="button">Close</button>
        </div>
      </div>
      <div class="exapp-overlay exapp-confirm-overlay">
        <div class="exapp-card">
          <h4 class="exapp-confirm-msg"></h4>
          <div class="exapp-card-row">
            <button class="exapp-btn exapp-confirm-ok" type="button">OK</button>
            <button class="exapp-btn exapp-confirm-cancel" type="button">Cancel</button>
          </div>
        </div>
      </div>
      <div class="exapp-overlay exapp-del-overlay">
        <div class="exapp-card">
          <h4>Delete this ${escapeHtml(cfg.noun)}?</h4>
          <div class="exapp-del-name"></div>
          <button class="exapp-hold" type="button">
            <span class="exapp-hold-fill"></span>
            <span class="exapp-hold-label">Hold to delete</span>
          </button>
          <div class="exapp-card-row">
            <button class="exapp-btn exapp-del-cancel" type="button">Cancel</button>
          </div>
        </div>
      </div>
      <div class="exapp-toast"></div>
    `;
    document.body.appendChild(win);

    const frame = win.querySelector('.exapp-frame');
    const saveOverlay = win.querySelector('.exapp-save-overlay');
    const browseOverlay = win.querySelector('.exapp-browse-overlay');
    const nameInput = win.querySelector('.exapp-name');
    const listEl = win.querySelector('.exapp-list');
    const toastEl = win.querySelector('.exapp-toast');
    let loaded = false;
    let toastTimer = null;

    function toast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add('show');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1700);
    }
    function frameWin() { try { return frame.contentWindow; } catch (e) { return null; } }

    function open() {
      if (!loaded) {
        loaded = true;
        if (cfg.autosaveKey) {
          // Restore the last current-state (e.g. quiver + mutation graph) so
          // closing/reopening the app returns to where you left off.
          idbGet('state', cfg.autosaveKey)
            .then((rec) => { frame.src = cfg.src + ((rec && rec.hash) ? rec.hash : ''); })
            .catch(() => { frame.src = cfg.src; });
        } else {
          frame.src = cfg.src;
        }
      }
      win.classList.add('show');
    }
    function close() {
      autosave(true);
      win.classList.remove('show');
      saveOverlay.classList.remove('show');
      browseOverlay.classList.remove('show');
      confirmOverlay.classList.remove('show');
      delOverlay.classList.remove('show');
    }
    win.querySelector('.exapp-close').onclick = close;

    // ── Reusable confirm popup (used by per-app bar actions, e.g. New) ──
    const confirmOverlay = win.querySelector('.exapp-confirm-overlay');
    const confirmMsg = win.querySelector('.exapp-confirm-msg');
    const confirmOk = win.querySelector('.exapp-confirm-ok');
    let confirmCb = null;
    function showConfirm(message, okLabel, onOk) {
      confirmMsg.textContent = message;
      confirmOk.textContent = okLabel || 'OK';
      confirmCb = onOk;
      confirmOverlay.classList.add('show');
    }
    confirmOk.onclick = () => {
      confirmOverlay.classList.remove('show');
      const cb = confirmCb; confirmCb = null;
      if (cb) cb();
    };
    win.querySelector('.exapp-confirm-cancel').onclick = () => {
      confirmOverlay.classList.remove('show'); confirmCb = null;
    };

    // ── Hold-to-delete confirm (for the saved-items × buttons) ──
    // A deliberate 2-second hold (the button fills as a progress cue) so a
    // saved item can't be lost to an accidental tap. Releasing early cancels.
    const delOverlay = win.querySelector('.exapp-del-overlay');
    const delNameEl = win.querySelector('.exapp-del-name');
    const holdBtn = win.querySelector('.exapp-hold');
    let delTargetId = null;
    let holdTimer = null;
    function resetHold() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      holdBtn.classList.remove('holding');
    }
    function openDelConfirm(id, name) {
      delTargetId = id;
      delNameEl.textContent = name || '';
      resetHold();
      delOverlay.classList.add('show');
    }
    function startHold() {
      if (holdTimer) return;
      void holdBtn.offsetWidth;            // restart the fill transition from 0
      holdBtn.classList.add('holding');
      holdTimer = setTimeout(async () => {
        holdTimer = null;
        holdBtn.classList.remove('holding');
        const id = delTargetId; delTargetId = null;
        delOverlay.classList.remove('show');
        if (id) { try { await cfg.store.del(id); } catch (_) {} renderList(); }
      }, 2000);
    }
    holdBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); startHold(); });
    holdBtn.addEventListener('pointerup', resetHold);
    holdBtn.addEventListener('pointerleave', resetHold);
    holdBtn.addEventListener('pointercancel', resetHold);
    win.querySelector('.exapp-del-cancel').onclick = () => { resetHold(); delOverlay.classList.remove('show'); delTargetId = null; };

    // ── Per-app bar actions (lead = left cluster, trail = right of title) ──
    const actionApi = { frameWin, toast, confirm: showConfirm, close };
    const wireActions = (list, side) => (list || []).forEach((a, i) => {
      const btn = win.querySelector(`[data-act="${side}-${i}"]`);
      if (btn && typeof a.onClick === 'function') btn.onclick = () => a.onClick(actionApi);
    });
    wireActions(cfg.leadActions, 'lead');
    wireActions(cfg.trailActions, 'trail');

    // ── Autosave current state (so reopening restores the same view) ──
    // Used by the quiver window (cfg.autosaveKey). The full state lives in the
    // page hash; freeze=true also pins the mutation graph node positions.
    let autosaveTimer = null;
    function autosave(freeze) {
      if (!cfg.autosaveKey || !loaded) return;
      let w; try { w = frame.contentWindow; } catch (e) { return; }
      if (!w) return;
      let hash = '';
      try {
        if (freeze && typeof w.ensureMutationGraphFrozen === 'function') w.ensureMutationGraphFrozen();
        if (freeze && typeof w.triggerURLUpdate === 'function') w.triggerURLUpdate();
        hash = w.location.hash || '';
      } catch (e) { return; }
      idbPut('state', { id: cfg.autosaveKey, hash: hash, updatedAt: Date.now() }).catch(() => {});
    }
    function scheduleAutosave() {
      if (autosaveTimer) clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => autosave(false), 600);
    }
    if (cfg.autosaveKey) {
      // Re-attach on every (re)load of the iframe (initial, reset, named load).
      frame.addEventListener('load', () => {
        let w; try { w = frame.contentWindow; } catch (e) { return; }
        if (!w) return;
        try {
          w.addEventListener('hashchange', scheduleAutosave);
          w.addEventListener('pagehide', () => autosave(true));
        } catch (e) {}
      });
      // Persist when the whole app is backgrounded / closed.
      document.addEventListener('visibilitychange', () => { if (document.hidden) autosave(true); });
      global.addEventListener('pagehide', () => autosave(true));
    }

    // ── Save ──
    win.querySelector('.exapp-save').onclick = () => {
      nameInput.value = '';
      saveOverlay.classList.add('show');
      setTimeout(() => nameInput.focus(), 50);
    };
    win.querySelector('.exapp-save-cancel').onclick = () => saveOverlay.classList.remove('show');
    async function doSave() {
      const name = (nameInput.value || '').trim();
      if (!name) { nameInput.focus(); return; }
      let data = null;
      try { data = cfg.capture(frameWin()); } catch (e) { console.error('capture failed', e); }
      if (data == null) { toast('Nothing to save yet'); return; }
      const rec = { id: newId(), name: name, createdAt: Date.now(), data: data };
      try { await cfg.store.put(rec); } catch (e) { console.error('save failed', e); toast('Save failed'); return; }
      saveOverlay.classList.remove('show');
      toast('Saved “' + name + '”');
    }
    win.querySelector('.exapp-save-ok').onclick = doSave;
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });

    // ── Browse ──
    async function renderList() {
      let items = [];
      try { items = await cfg.store.all(); } catch (e) { console.error(e); }
      items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      if (!items.length) {
        listEl.innerHTML = '<div class="exapp-empty">No saved ' + escapeHtml(cfg.nounPlural) + ' yet.</div>';
        return;
      }
      listEl.innerHTML = items.map((r) =>
        '<div class="exapp-item">'
        + ((r.data && r.data.thumb) ? '<img class="exapp-thumb" src="' + r.data.thumb + '" alt="">' : '')
        + '<button class="exapp-item-name" data-load="' + r.id + '" type="button">' + escapeHtml(r.name) + '</button>'
        + '<span class="exapp-item-meta">' + fmtDate(r.createdAt) + '</span>'
        + '<button class="exapp-del" data-del="' + r.id + '" type="button" aria-label="delete">&times;</button>'
        + '</div>').join('');
    }
    win.querySelector('.exapp-browse').onclick = async () => { await renderList(); browseOverlay.classList.add('show'); };
    win.querySelector('.exapp-browse-close').onclick = () => browseOverlay.classList.remove('show');
    listEl.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        const item = del.closest('.exapp-item');
        const nm = item ? (item.querySelector('.exapp-item-name') || {}).textContent || '' : '';
        openDelConfirm(del.dataset.del, nm);
        return;
      }
      const load = e.target.closest('[data-load]');
      if (load) {
        let items = [];
        try { items = await cfg.store.all(); } catch (_) {}
        const rec = items.find((r) => r.id === load.dataset.load);
        if (!rec) return;
        try { cfg.apply(frame, frameWin(), rec.data); }
        catch (err) { console.error('apply failed', err); toast('Load failed'); return; }
        browseOverlay.classList.remove('show');
        toast('Loaded “' + rec.name + '”');
      }
    });

    return { open };
  }

  // ────────────────────────────────────────────────────────────
  // App configs
  // ────────────────────────────────────────────────────────────
  // Synth: state via window.SynthApp inside synth.html.
  function captureSynth(win) {
    return (win && win.SynthApp && typeof win.SynthApp.getSong === 'function')
      ? win.SynthApp.getSong() : null;
  }
  function applySynth(frameEl, win, data) {
    if (win && win.SynthApp && typeof win.SynthApp.loadSong === 'function') win.SynthApp.loadSong(data);
  }

  // Quiver: full state lives in the page's URL hash. Capture the current hash;
  // load by reloading the iframe to that hash (quiver reads it on init).
  function captureQuiver(win) {
    if (!win) return null;
    // Freeze + serialize the mutation graph into the hash before reading it, so
    // saved quivers carry their mutation graph too.
    try { if (typeof win.ensureMutationGraphFrozen === 'function') win.ensureMutationGraphFrozen(); } catch (e) {}
    try { if (typeof win.triggerURLUpdate === 'function') win.triggerURLUpdate(); } catch (e) {}
    let hash = '';
    try { hash = win.location.hash || ''; } catch (e) { return null; }
    let thumb = null;
    try { if (win.QuiverApp && win.QuiverApp.thumbnail) thumb = win.QuiverApp.thumbnail(); } catch (e) {}
    return { hash: hash, thumb: thumb };
  }
  // Draw: state via window.DrawApp inside static/draw/index.html. getDrawing
  // returns {doc, camera}; we add a small JPEG preview for the folder grid.
  function captureDraw(win) {
    if (!win || !win.DrawApp || typeof win.DrawApp.getDrawing !== 'function') return null;
    let d = null;
    try { d = win.DrawApp.getDrawing(); } catch (e) { return null; }
    if (!d) return null;
    let thumb = null;
    try { if (typeof win.DrawApp.thumbnail === 'function') thumb = win.DrawApp.thumbnail(); } catch (e) {}
    return { doc: d.doc, camera: d.camera, thumb: thumb };
  }
  function applyDraw(frameEl, win, data) {
    if (win && win.DrawApp && typeof win.DrawApp.loadDrawing === 'function') {
      win.DrawApp.loadDrawing(data);
    }
  }

  // Pixel Art: state via window.PixelApp inside static/pixelart/index.html.
  // getDrawing returns {w, h, cells, layers, active}; we add a PNG preview for
  // the folder grid. `cells` is the flattened composite (kept for the folder
  // preview + older saves); `layers`/`active` carry full layer fidelity so named
  // saves round-trip. Older saved drawings simply have no `layers` field.
  function capturePixel(win) {
    if (!win || !win.PixelApp || typeof win.PixelApp.getDrawing !== 'function') return null;
    let d = null;
    try { d = win.PixelApp.getDrawing(); } catch (e) { return null; }
    if (!d) return null;
    let thumb = null;
    try { if (typeof win.PixelApp.thumbnail === 'function') thumb = win.PixelApp.thumbnail(); } catch (e) {}
    return { w: d.w, h: d.h, cells: d.cells, layers: d.layers, active: d.active, thumb: thumb };
  }
  function applyPixel(frameEl, win, data) {
    if (win && win.PixelApp && typeof win.PixelApp.loadDrawing === 'function') {
      win.PixelApp.loadDrawing(data);
    }
  }

  function applyQuiver(frameEl, win, data) {
    const hash = (data && data.hash) ? data.hash : '';
    // Prefer setting the hash on the live iframe — quiver's onhashchange runs
    // loadGraphFromHash(), which restores the quiver AND its mutation graph.
    // If the hash is unchanged, force a reload so it still re-applies.
    if (win) {
      try {
        if ((win.location.hash || '') === hash) {
          frameEl.src = QUIVER_SRC + '?t=' + Date.now() + hash;
        } else {
          win.location.hash = hash;
        }
        return;
      } catch (e) { /* cross-window issue — fall through to a full reload */ }
    }
    frameEl.src = QUIVER_SRC + hash;
  }

  // ────────────────────────────────────────────────────────────
  // Register with the Extras launcher (retry until the hook exists)
  // ────────────────────────────────────────────────────────────
  let quiverWin = null;
  let synthWin = null;
  let drawWin = null;
  let pixelWin = null;

  function register() {
    if (!global.ExtrasRegisterTool) { setTimeout(register, 50); return; }
    global.ExtrasRegisterTool({
      id: 'quiver', name: 'Quiver', label: 'Quiver', icon: QUIVER_ICON,
      open: () => {
        if (!quiverWin) quiverWin = makeAppWindow({
          title: 'Quiver', noun: 'quiver', nounPlural: 'quivers',
          src: QUIVER_SRC, store: quiversStore, capture: captureQuiver, apply: applyQuiver,
          autosaveKey: 'quiver-current',
        });
        quiverWin.open();
      },
    });
    global.ExtrasRegisterTool({
      id: 'synth', name: 'Synth', label: 'Synth', icon: '&#127929;', // 🎹
      open: () => {
        if (!synthWin) synthWin = makeAppWindow({
          title: 'Synth', noun: 'song', nounPlural: 'songs',
          src: SYNTH_SRC, store: songsStore, capture: captureSynth, apply: applySynth,
          // "Clear" up top like Draw's New — themed confirm, then the iframe
          // wipes all tracks via the SynthApp bridge.
          leadActions: [{
            html: 'Clear', title: 'Clear all tracks',
            onClick: (api) => api.confirm(
              'Clear everything?\nAll unsaved tracks will be lost.', 'Clear',
              () => { const w = api.frameWin(); if (w && w.SynthApp && w.SynthApp.clearAll) w.SynthApp.clearAll(); }),
          }],
        });
        synthWin.open();
      },
    });
    global.ExtrasRegisterTool({
      id: 'draw', name: 'Draw', label: 'Draw', icon: DRAW_ICON,
      open: () => {
        if (!drawWin) drawWin = makeAppWindow({
          title: 'Draw', noun: 'drawing', nounPlural: 'drawings',
          src: DRAW_SRC, store: drawingsStore, capture: captureDraw, apply: applyDraw,
          // No autosaveKey: the Draw app autosaves its working doc to
          // localStorage and restores it on load, so reopening already
          // resumes where you left off.
          // "New" up top (the in-app Clear is buried in the settings menu),
          // gated behind a confirm; undo/redo proxy to the draw app.
          leadActions: [{
            html: 'New', title: 'New drawing',
            onClick: (api) => api.confirm(
              'Start a new drawing?\nThis clears the current canvas.', 'New',
              () => { const w = api.frameWin(); if (w && w.DrawApp) w.DrawApp.newDrawing(); }),
          }],
          trailActions: [
            { html: ICON_UNDO, title: 'Undo', iconBtn: true,
              onClick: (api) => { const w = api.frameWin(); if (w && w.DrawApp) w.DrawApp.undo(); } },
            { html: ICON_REDO, title: 'Redo', iconBtn: true,
              onClick: (api) => { const w = api.frameWin(); if (w && w.DrawApp) w.DrawApp.redo(); } },
          ],
        });
        drawWin.open();
      },
    });
    global.ExtrasRegisterTool({
      id: 'pixelart', name: 'Pixel Art', label: 'Pixel<br>art', icon: PIXEL_ICON,
      open: () => {
        if (!pixelWin) pixelWin = makeAppWindow({
          title: 'Pixel Art', noun: 'pixel art', nounPlural: 'pixel art',
          src: PIXELART_SRC, store: pixelartStore, capture: capturePixel, apply: applyPixel,
          // New opens the pixel app's own width/height dialog (which doubles as
          // the confirm — Create discards the current canvas). Undo/redo proxy in.
          leadActions: [{
            html: 'New', title: 'New pixel art',
            onClick: (api) => { const w = api.frameWin(); if (w && w.PixelApp) w.PixelApp.promptNew(); },
          }],
          trailActions: [
            { html: ICON_UNDO, title: 'Undo', iconBtn: true,
              onClick: (api) => { const w = api.frameWin(); if (w && w.PixelApp) w.PixelApp.undo(); } },
            { html: ICON_REDO, title: 'Redo', iconBtn: true,
              onClick: (api) => { const w = api.frameWin(); if (w && w.PixelApp) w.PixelApp.redo(); } },
          ],
        });
        pixelWin.open();
      },
    });
  }
  register();

})(typeof window !== 'undefined' ? window : this);
