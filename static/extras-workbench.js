// Extras workbench (/extras on the LAN instance) — desktop/PC access to
// the Extras mini-apps with savefile round-tripping.
//
// The page (static/extras.html) loads the SAME extras scripts the main
// app does (extras.js + all siblings incl. the anki bridge); this file
// adds the Load / Save top-bar flow:
//
//   Load  = GET /load?name=X (works because the LAN instance serves
//           reads), keep the ENTIRE payload as `pristine`, and merge
//           only the extras slices (fractals, songs, drawings, todos,
//           anki, …) into this browser's localStorage / IndexedDB via
//           each tool's own importMerge — the same functions the main
//           app's importData uses.
//   Save  = re-capture those same slices, overlay them onto the
//           pristine payload (creatures, eggs, settings, GPS history …
//           pass through byte-untouched), refresh exportedAt, POST
//           /save with the save's writeToken. The page can therefore
//           never wipe non-extras data — and Save is disabled until a
//           Load has succeeded, so it can't create a stripped save
//           lineage from an empty browser either.
//
// A slice whose import FAILED on load is excluded from the overlay on
// save (the pristine value passes through instead), so a broken tool
// can't silently shrink that slice. A slice whose capture API is
// missing (script not loaded) is likewise left at the pristine value.
//
// Pure payload logic lives on global.ExtrasWorkbench (Node-testable,
// tests/extras-workbench.test.js); DOM wiring below the guard.

(function (global) {
  'use strict';

  // The savefile fields this page owns (must mirror the extras slices of
  // index.html's buildBackupPayload / importData — guarded by test).
  const EXTRA_KEYS = [
    'fractals', 'fractals2', 'fractalLast', 'fractal2Last',
    'songs', 'quivers', 'drawings', 'pixelart', 'todos', 'anki',
  ];

  // Overlay captured extras onto a pristine save payload. Only keys
  // present in `extras` are replaced; everything else passes through.
  function mergePayload(pristine, extras, nowIso) {
    const out = Object.assign({}, pristine);
    for (const k of EXTRA_KEYS) {
      if (Object.prototype.hasOwnProperty.call(extras, k)) out[k] = extras[k];
    }
    out.exportedAt = nowIso;
    return out;
  }

  // The token to save with: the loaded save's own token wins (it's the
  // one whose hash the server has on record); otherwise fall back to a
  // locally stored/generated one (TOFU-claims the name from this PC).
  function pickWriteToken(pristine, localMap, name, generate) {
    if (pristine && typeof pristine.writeToken === 'string' && pristine.writeToken) {
      return pristine.writeToken;
    }
    if (localMap && typeof localMap[name] === 'string' && localMap[name]) {
      return localMap[name];
    }
    return generate();
  }

  global.ExtrasWorkbench = { EXTRA_KEYS, mergePayload, pickWriteToken };

  if (typeof document === 'undefined') return;  // Node tests stop here

  // ────────────────────────────────────────────────────────────
  // DOM wiring
  // ────────────────────────────────────────────────────────────

  let pristine = null;       // full payload of the last successful Load
  let loadedName = '';       // name it was loaded under (Save uses this)
  let failedSlices = [];     // slices whose import failed (don't overlay)

  const $ = (id) => document.getElementById(id);
  const status = (msg, isErr) => {
    const el = $('wbStatus');
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
  };

  function genToken() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode.apply(null, bytes))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function tokenMap() {
    try { return JSON.parse(localStorage.getItem('cc.writeTokens.v1') || '{}') || {}; }
    catch (_) { return {}; }
  }

  // ── apply the extras slices of a loaded save to THIS browser ──
  async function applyExtras(data) {
    const failed = [];
    const slice = async (key, fn) => {
      try { await fn(); }
      catch (e) { failed.push(key); console.error('workbench: import ' + key + ' failed', e); }
    };
    const g = global;
    const arr = (key, api) => slice(key, async () => {
      if (Array.isArray(data[key]) && g[api] && g[api].importMerge) {
        await g[api].importMerge(data[key]);
      }
    });
    await arr('fractals', 'ExtrasFractals');
    await arr('fractals2', 'ExtrasFractals2');
    await arr('songs', 'ExtrasSongs');
    await arr('quivers', 'ExtrasQuivers');
    await arr('drawings', 'ExtrasDrawings');
    await arr('pixelart', 'ExtrasPixelArt');
    await slice('todos', async () => {
      if (data.todos && typeof data.todos === 'object' && g.TodoCore && g.TodoCore.importMerge) {
        localStorage.setItem('cc.todos.v1',
          g.TodoCore.importMerge(localStorage.getItem('cc.todos.v1'), JSON.stringify(data.todos)));
      }
    });
    await slice('anki', async () => {
      if (data.anki && typeof data.anki === 'object' && g.ExtrasAnki && g.ExtrasAnki.importMerge) {
        await g.ExtrasAnki.importMerge(data.anki);
      }
    });
    if (typeof data.fractalLast === 'string' && data.fractalLast) {
      localStorage.setItem('cc.fractalLast.v1', data.fractalLast);
    }
    if (typeof data.fractal2Last === 'string' && data.fractal2Last) {
      localStorage.setItem('cc.fractal2Last.v1', data.fractal2Last);
    }
    return failed;
  }

  // ── re-capture this browser's extras slices for saving ──
  async function collectExtras() {
    const g = global;
    const out = {};
    if (g.ExtrasFractals && g.ExtrasFractals.all) out.fractals = await g.ExtrasFractals.all();
    if (g.ExtrasFractals2 && g.ExtrasFractals2.all) out.fractals2 = await g.ExtrasFractals2.all();
    if (g.ExtrasSongs && g.ExtrasSongs.all) out.songs = await g.ExtrasSongs.all();
    if (g.ExtrasQuivers && g.ExtrasQuivers.all) out.quivers = await g.ExtrasQuivers.all();
    if (g.ExtrasDrawings && g.ExtrasDrawings.all) out.drawings = await g.ExtrasDrawings.all();
    if (g.ExtrasPixelArt && g.ExtrasPixelArt.all) out.pixelart = await g.ExtrasPixelArt.all();
    if (g.ExtrasAnki && g.ExtrasAnki.capture) out.anki = await g.ExtrasAnki.capture();
    try {
      const t = JSON.parse(localStorage.getItem('cc.todos.v1') || 'null');
      if (t) out.todos = t;
    } catch (_) {}
    const fl = localStorage.getItem('cc.fractalLast.v1');
    if (fl) out.fractalLast = fl;
    const f2 = localStorage.getItem('cc.fractal2Last.v1');
    if (f2) out.fractal2Last = f2;
    // A slice that failed to import stays pristine — never overlay it.
    for (const k of failedSlices) delete out[k];
    return out;
  }

  async function doLoad() {
    const name = $('wbName').value.trim();
    if (!name) { status('Enter a trainer name first.', true); return; }
    localStorage.setItem('cc.backupName', name);
    status('Loading…');
    $('wbLoad').disabled = true;
    try {
      const resp = await fetch('/load?name=' + encodeURIComponent(name));
      if (resp.status === 404) { status('No saves found for "' + name + '".', true); return; }
      if (resp.status === 403) {
        status('This server is the gated (public) instance — open the LAN one (run_as_lan.py).', true);
        return;
      }
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      failedSlices = await applyExtras(data);
      pristine = data;
      loadedName = name;
      // Remember the save's write token so Save (and the phone apps, if
      // this browser is ever used as one) can keep writing this name.
      if (typeof data.writeToken === 'string' && data.writeToken) {
        const map = tokenMap();
        map[name] = data.writeToken;
        localStorage.setItem('cc.writeTokens.v1', JSON.stringify(map));
      }
      $('wbSave').disabled = false;
      status('Loaded "' + name + '" — edit away, then Save.'
        + (failedSlices.length ? ' (kept as-is: ' + failedSlices.join(', ') + ')' : ''));
    } catch (e) {
      status('Load failed: ' + (e && e.message ? e.message : e), true);
    } finally {
      $('wbLoad').disabled = false;
    }
  }

  async function doSave() {
    if (!pristine) { status('Load a save first — Save round-trips it.', true); return; }
    status('Saving…');
    $('wbSave').disabled = true;
    try {
      const extras = await collectExtras();
      const payload = mergePayload(pristine, extras, new Date().toISOString());
      payload.backupName = loadedName;
      payload.writeToken = pickWriteToken(pristine, tokenMap(), loadedName, genToken);
      const resp = await fetch('/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await resp.json().catch(() => ({}));
      if (resp.status === 403) {
        status('Save rejected: ' + (body.error || 'name is claimed by another token'), true);
        return;
      }
      if (!resp.ok) throw new Error(body.error || 'HTTP ' + resp.status);
      pristine = payload;  // saved state is the new baseline
      status('Saved as ' + (body.saved || loadedName) + ' ✓');
    } catch (e) {
      status('Save failed: ' + (e && e.message ? e.message : e), true);
    } finally {
      $('wbSave').disabled = false;
    }
  }

  function boot() {
    // Keep --wb-top matched to the bar's real height so the fullscreen
    // tool overlays (top: var(--wb-top)) always start right below it,
    // even when the bar wraps to more rows on narrow screens.
    const bar = document.querySelector('.wb-bar');
    if (bar) {
      const sync = () => document.documentElement.style
        .setProperty('--wb-top', bar.offsetHeight + 'px');
      if (typeof ResizeObserver === 'function') new ResizeObserver(sync).observe(bar);
      window.addEventListener('resize', sync);
      sync();
    }
    $('wbName').value = localStorage.getItem('cc.backupName') || '';
    $('wbLoad').addEventListener('click', doLoad);
    $('wbSave').addEventListener('click', doSave);
    $('wbName').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLoad(); });
    // Open the bubble grid straight away — the page IS the extras panel.
    const btn = $('extrasBtn');
    if (btn && btn.onclick) btn.onclick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
