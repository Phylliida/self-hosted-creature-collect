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

  // Quiver bubble icon: three nodes in a triangle with a directed arrow from one
  // to another. Inline SVG, uses currentColor so it matches the theme/text.
  const QUIVER_ICON =
    '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" style="display:block">'
    + '<circle cx="12" cy="5" r="2.4" fill="currentColor"/>'
    + '<circle cx="5" cy="18" r="2.4" fill="currentColor"/>'
    + '<circle cx="19" cy="18" r="2.4" fill="currentColor"/>'
    + '<g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
    + '<line x1="7.8" y1="18" x2="15.8" y2="18"/>'
    + '<path d="M14.4 16.4 L16.2 18 L14.4 19.6"/>'
    + '</g></svg>';

  // ────────────────────────────────────────────────────────────
  // IndexedDB store (songs + quivers)
  // ────────────────────────────────────────────────────────────
  const DB_NAME = 'cc-extras-apps-v1';
  const DB_VER = 1;
  const STORE_NAMES = ['songs', 'quivers'];

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
  // Exposed for index.html's backup export/import (mirrors window.ExtrasFractals).
  global.ExtrasSongs = songsStore;
  global.ExtrasQuivers = quiversStore;

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
    .exapp-title { flex: 1; text-align: center; font-size: 14px; font-weight: 600; opacity: .9;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .exapp-btn { padding: 6px 12px; font-size: 13px; font-weight: 600; color: #fff;
      background: rgba(255,255,255,0.16); border: none; border-radius: 6px; cursor: pointer; }
    .exapp-btn:hover { background: rgba(255,255,255,0.26); }
    .exapp-close { background: rgba(224,90,107,0.55); }
    .exapp-overlay { position: absolute; left: 0; right: 0; top: var(--exapp-bar); bottom: 0;
      display: none; align-items: flex-start; justify-content: center; background: rgba(0,0,0,0.5); z-index: 2; }
    .exapp-overlay.show { display: flex; }
    .exapp-card { margin-top: 28px; width: min(92%, 360px); max-height: 78%; overflow-y: auto;
      background: #1c1c1f; color: #fff; border-radius: 12px; padding: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    .exapp-card h4 { margin: 0 0 12px; font-size: 15px; text-align: center; }
    .exapp-name { width: 100%; box-sizing: border-box; padding: 10px; font-size: 15px;
      border-radius: 8px; border: 1px solid rgba(255,255,255,0.2); background: #111; color: #fff; margin-bottom: 12px; }
    .exapp-card-row { display: flex; gap: 8px; }
    .exapp-card-row .exapp-btn { flex: 1; text-align: center; }
    .exapp-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
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
  //           apply(iframeEl, iframeWin, data) }
  // ────────────────────────────────────────────────────────────
  function makeAppWindow(cfg) {
    injectCss();
    const win = document.createElement('div');
    win.className = 'exapp-win';
    win.innerHTML = `
      <div class="exapp-bar">
        <button class="exapp-btn exapp-save" type="button">Save</button>
        <button class="exapp-btn exapp-browse" type="button">Saved</button>
        <div class="exapp-title">${escapeHtml(cfg.title)}</div>
        <button class="exapp-btn exapp-close" type="button">Close</button>
      </div>
      <iframe class="exapp-frame" title="${escapeHtml(cfg.title)}"></iframe>
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
      if (!loaded) { frame.src = cfg.src; loaded = true; }
      win.classList.add('show');
    }
    function close() {
      win.classList.remove('show');
      saveOverlay.classList.remove('show');
      browseOverlay.classList.remove('show');
    }
    win.querySelector('.exapp-close').onclick = close;

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
      if (del) { try { await cfg.store.del(del.dataset.del); } catch (_) {} renderList(); return; }
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

  function register() {
    if (!global.ExtrasRegisterTool) { setTimeout(register, 50); return; }
    global.ExtrasRegisterTool({
      id: 'quiver', name: 'Quiver', label: 'Quiver', icon: QUIVER_ICON,
      open: () => {
        if (!quiverWin) quiverWin = makeAppWindow({
          title: 'Quiver', noun: 'quiver', nounPlural: 'quivers',
          src: QUIVER_SRC, store: quiversStore, capture: captureQuiver, apply: applyQuiver,
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
        });
        synthWin.open();
      },
    });
  }
  register();

})(typeof window !== 'undefined' ? window : this);
