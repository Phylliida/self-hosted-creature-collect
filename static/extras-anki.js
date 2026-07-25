// Extras -> Flashcards: the bundled oss-anki spaced-repetition app.
//
// The app itself is the vendored, zero-network oss-anki build living at
// static/anki/ (canonical copy — see static/anki/README.md). This file is
// just the glue:
//
//   (1) Registers the Extras bubble and opens the app full-screen in a
//       same-origin iframe (fractals-window pattern). A "Close" button is
//       injected into the app's own header via contentDocument; the iframe
//       stays alive across close/reopen so mid-study state survives.
//
//   (2) Bridges the collection into the creature-collect savefile.
//       window.ExtrasAnki = { capture, importMerge }:
//         capture()        -> oss-anki JSON backup object (collection +
//                             media, base64) read straight from the app's
//                             own IndexedDB ("oss-anki") — works whether or
//                             not the iframe has ever been opened.
//         importMerge(obj) -> merges a backup into the local collection
//                             with oss-anki's deterministic sync engine
//                             (revlog union, notes by GUID, delete-wins,
//                             day-offset correction), so save round-trips
//                             and multi-device Load never lose reviews.
//                             Replaces wholesale when there is no local
//                             collection yet.
//       Both lazily import the oss-anki ES modules (src/storage.js,
//       src/backup.js, src/sync.js) — all local files, zero-network.
//
// Node-testable: set global.ExtrasAnkiModuleBase (file:// URL of the src/
// dir) + global.ExtrasAnkiIDB (fake-indexeddb) before requiring this file;
// tests/anki-bridge.test.js exercises capture/importMerge end-to-end.
//
// NOTE: no backticks inside CSS/HTML template literals — none used here.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve (if tracked)
  if (global._scriptVersions) global._scriptVersions['extras-anki.js'] = SCRIPT_VERSION;

  const APP_URL = 'static/anki/web/index.html';

  // Base URL for the oss-anki ES modules. import() specifiers must be
  // absolute or explicitly relative, so resolve against this script's own
  // URL (works on web and inside the Capacitor bundle alike). Tests
  // override with a file:// base.
  const scriptEl = (typeof document !== 'undefined') ? document.currentScript : null;
  const SRC_BASE = global.ExtrasAnkiModuleBase
    || (scriptEl && scriptEl.src
      ? new URL('anki/src/', scriptEl.src).href
      : new URL('static/anki/src/', (typeof document !== 'undefined' && document.baseURI) || 'http://localhost/').href);
  const mod = (name) => import(SRC_BASE + name);
  const idb = () => global.ExtrasAnkiIDB || global.indexedDB;

  // ────────────────────────────────────────────────────────────
  // Savefile bridge (headless-capable — no DOM needed)
  // ────────────────────────────────────────────────────────────

  // Read the whole collection + media as a plain JSON-able oss-anki backup
  // object, or null if the user has never created/imported anything.
  async function capture() {
    if (!idb()) return null;
    const storage = await mod('storage.js');
    const db = await storage.openCollectionDB('oss-anki', idb());
    try {
      const col = await storage.loadCollection(db);
      if (!col) return null;
      const media = await storage.loadMedia(db);
      const backup = await mod('backup.js');
      return backup.collectionToBackup(col, media);
    } finally {
      db.close();
    }
  }

  // Merge a captured backup into the local collection (or adopt it outright
  // when the device has none). Deterministic and idempotent — importing the
  // same save twice is a no-op, and newer local reviews always survive a
  // Load of an older server save. Reloads the app iframe if it has booted,
  // so its in-memory state picks up the merged collection.
  async function importMerge(obj) {
    if (!obj || typeof obj !== 'object' || obj.format !== 'oss-anki-backup') {
      throw new Error('not an oss-anki backup object');
    }
    if (!idb()) throw new Error('no IndexedDB available');
    const storage = await mod('storage.js');
    const backup = await mod('backup.js');
    const imported = backup.collectionFromBackup(obj);
    const db = await storage.openCollectionDB('oss-anki', idb());
    let cards = 0;
    try {
      const local = await storage.loadCollection(db);
      let merged;
      let media;
      if (!local) {
        merged = imported.collection;
        media = imported.media;
      } else {
        const sync = await mod('sync.js');
        merged = sync.syncMerge(local, imported.collection);
        // Local bytes win exact-name conflicts (same rule the app's own
        // static-file sync uses).
        media = sync.mergeMedia(await storage.loadMedia(db), imported.media);
      }
      await storage.saveCollection(db, merged);
      await storage.saveMedia(db, media);
      cards = merged.cards.size;
    } finally {
      db.close();
    }
    // (guarded: the window section below doesn't exist headless)
    if (typeof document !== 'undefined') reloadIfBooted();
    return { cards };
  }

  global.ExtrasAnki = { capture, importMerge };

  if (typeof document === 'undefined') return;  // Node tests stop here

  // ────────────────────────────────────────────────────────────
  // Full-screen window (reuses the shared .fractals-window chrome CSS)
  // ────────────────────────────────────────────────────────────

  let win = null;
  let frame = null;
  let booted = false;

  function ensureWindow() {
    if (win) return;
    win = document.createElement('div');
    win.className = 'fractals-window';
    win.id = 'ankiWindow';
    frame = document.createElement('iframe');
    frame.id = 'ankiFrame';
    frame.title = 'Flashcards';
    win.appendChild(frame);
    // Floating fallback close button — hidden once the in-header Close is
    // injected (the app's header buttons wrap on phones and would sit
    // under a permanently floating control).
    const bar = document.createElement('div');
    bar.className = 'fractals-bar';
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'frac-close';
    x.title = 'Close';
    x.textContent = '×';
    x.addEventListener('click', closeAnki);
    bar.appendChild(x);
    win.appendChild(bar);
    frame.addEventListener('load', () => {
      try { decorate(frame.contentDocument, bar); } catch (e) { console.error('anki decorate failed', e); }
    });
    document.body.appendChild(win);
  }

  // Same-origin reach-in: add a Close button to the app's own header (it
  // inherits the app's button styling) and pad for notches since the
  // iframe is edge-to-edge.
  function decorate(doc, bar) {
    if (!doc || !doc.querySelector) return;
    const actions = doc.querySelector('header .actions');
    if (!actions || doc.getElementById('cc-close-btn')) return;
    const btn = doc.createElement('button');
    btn.id = 'cc-close-btn';
    btn.type = 'button';
    btn.textContent = '✕ Close';
    btn.addEventListener('click', closeAnki);
    actions.appendChild(btn);
    const st = doc.createElement('style');
    st.id = 'cc-embed-style';
    st.textContent = 'header { padding-top: max(env(safe-area-inset-top), 12px); } ' +
      'footer { padding-bottom: max(env(safe-area-inset-bottom), 12px); }';
    doc.head.appendChild(st);
    bar.style.display = 'none';
  }

  function openAnki() {
    ensureWindow();
    if (!booted) {
      frame.src = APP_URL;
      booted = true;
    }
    win.classList.add('show');
  }

  function closeAnki() {
    if (win) win.classList.remove('show');
  }

  // After a savefile import rewrote IndexedDB underneath the app, reboot
  // the iframe (even while hidden) so stale in-memory state can't write
  // pre-merge data back over the merged collection.
  function reloadIfBooted() {
    if (!booted || !frame) return;
    try { frame.contentWindow.location.reload(); } catch (e) { frame.src = APP_URL; }
  }

  function register() {
    if (!global.ExtrasRegisterTool) { setTimeout(register, 50); return; }
    global.ExtrasRegisterTool({
      id: 'anki',
      name: 'Flashcards',
      icon: '🎴',
      label: 'Flashcards',
      open: openAnki,
    });
  }
  register();
})(typeof window !== 'undefined' ? window : globalThis);
