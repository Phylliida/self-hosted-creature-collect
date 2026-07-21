// Extras -> Todo: a recurring task list.
//
// Add tasks with a recurrence (once, daily, every N days, weekly, ...). The
// main view shows DUE tasks; tapping one marks it done and it resurfaces
// after its interval, measured in whole LOCAL days from completion. One-off
// tasks disappear once done.
//
// Persists to localStorage 'cc.todos.v1'. The pure state logic lives on
// global.TodoCore and runs headless (returns before touching the DOM under
// Node) so tests/todos.test.js can require() this file directly.
//
// NOTE: the CSS/HTML further down lives inside template literals -- never put
// a backtick inside them (even in a comment), it terminates the string and
// breaks the file. Normal JS template strings elsewhere are fine.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve (if tracked)
  if (global._scriptVersions) global._scriptVersions['extras-todos.js'] = SCRIPT_VERSION;

  // ════════════════════════════════════════════════════════════════════
  // CORE  (pure state logic, no DOM)  ->  global.TodoCore
  // ════════════════════════════════════════════════════════════════════
  // State: { tasks: [{id, name, everyDays, lastDoneDay, createdDay}], seq }
  //   everyDays: 0 = one-off, N>0 = repeats N local days after completion
  //   lastDoneDay: local day index of last completion, null = never done
  // Day index: whole days since epoch in LOCAL time, so "daily" resets at
  // the user's own midnight. All functions take dayIdx explicitly (the UI
  // computes it via localDayIdx(Date.now())) so tests can simulate time.

  const MS_PER_DAY = 86400000;
  const KEY = 'cc.todos.v1';

  function localDayIdx(nowMs) {
    return Math.floor((nowMs - new Date(nowMs).getTimezoneOffset() * 60000) / MS_PER_DAY);
  }

  function createState() { return { tasks: [], seq: 0 }; }

  // Tolerant parse: anything unexpected -> fresh empty state.
  function load(raw) {
    try {
      const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!j || !Array.isArray(j.tasks)) return createState();
      const tasks = [];
      for (const t of j.tasks) {
        if (!t || typeof t.name !== 'string' || !t.name) continue;
        tasks.push({
          id: typeof t.id === 'string' && t.id ? t.id : newId(),
          name: t.name,
          everyDays: clampDays(t.everyDays),
          lastDoneDay: Number.isFinite(t.lastDoneDay) ? t.lastDoneDay : null,
          createdDay: Number.isFinite(t.createdDay) ? t.createdDay : 0,
        });
      }
      return { tasks, seq: Number.isFinite(j.seq) ? j.seq : 0 };
    } catch (_) { return createState(); }
  }

  function save(state) { return JSON.stringify(state); }

  function clampDays(n) {
    n = Math.floor(Number(n));
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, 365);
  }

  function newId() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // Returns the new task, or null for a blank name.
  function addTask(state, name, everyDays, dayIdx) {
    name = String(name == null ? '' : name).trim();
    if (!name) return null;
    state.seq = (state.seq || 0) + 1;
    const t = { id: newId(), name, everyDays: clampDays(everyDays), lastDoneDay: null, createdDay: dayIdx };
    state.tasks.push(t);
    return t;
  }

  // One-off tasks are removed outright; recurring ones get stamped with
  // dayIdx and resurface after their interval. Returns the task (or null).
  function completeTask(state, id, dayIdx) {
    const i = state.tasks.findIndex((t) => t.id === id);
    if (i < 0) return null;
    const t = state.tasks[i];
    if (t.everyDays === 0) state.tasks.splice(i, 1);
    else t.lastDoneDay = dayIdx;
    return t;
  }

  function removeTask(state, id) {
    const i = state.tasks.findIndex((t) => t.id === id);
    if (i < 0) return false;
    state.tasks.splice(i, 1);
    return true;
  }

  function isDue(t, dayIdx) {
    if (t.lastDoneDay == null) return true;
    if (t.everyDays === 0) return false;
    return dayIdx - t.lastDoneDay >= t.everyDays;
  }

  function dueTasks(state, dayIdx) {
    return state.tasks.filter((t) => isDue(t, dayIdx));
  }

  // Recurring tasks done recently enough that they're still waiting; each
  // entry is the task plus a daysLeft (1..everyDays-1... can be 0 on the
  // boundary day if everyDays rounding lands here -- isDue handles that, so
  // daysLeft is always >= 1 here).
  function upcomingTasks(state, dayIdx) {
    const out = [];
    for (const t of state.tasks) {
      if (t.everyDays === 0 || t.lastDoneDay == null || isDue(t, dayIdx)) continue;
      out.push(Object.assign({}, t, { daysLeft: t.everyDays - (dayIdx - t.lastDoneDay) }));
    }
    return out;
  }

  // Backup merge: union by task id; on conflict the record with the newer
  // lastDoneDay wins (never-done counts as oldest). Takes and returns raw
  // JSON strings (either side may be null/garbage).
  function importMerge(existingRaw, incomingRaw) {
    const a = load(existingRaw), b = load(incomingRaw);
    const byId = new Map();
    for (const t of a.tasks.concat(b.tasks)) {
      const cur = byId.get(t.id);
      if (!cur || (t.lastDoneDay == null ? -1 : t.lastDoneDay) > (cur.lastDoneDay == null ? -1 : cur.lastDoneDay)) {
        byId.set(t.id, t);
      }
    }
    return save({ tasks: Array.from(byId.values()), seq: Math.max(a.seq, b.seq) });
  }

  global.TodoCore = {
    KEY, localDayIdx, createState, load, save, addTask, completeTask,
    removeTask, isDue, dueTasks, upcomingTasks, importMerge,
  };

  // ════════════════════════════════════════════════════════════════════
  // UI  (browser only — bail out cleanly under Node / before the hook loads)
  // ════════════════════════════════════════════════════════════════════
  if (typeof document === 'undefined' || typeof global.ExtrasRegisterTool !== 'function') return;

  // ── CSS (no backticks inside this template literal!) ──
  const style = document.createElement('style');
  style.textContent = `
  #extras_todos .td-form { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  #extras_todos .td-name {
    flex: 1 1 140px; min-width: 0; padding: 8px; font-size: 14px; font-family: inherit;
    border-radius: var(--ui-radius); border: 1px solid var(--ui-border);
    background: var(--ui-input-bg); color: var(--ui-text);
  }
  #extras_todos select, #extras_todos .td-custom {
    padding: 8px; font-size: 13px; font-family: inherit;
    border-radius: var(--ui-radius); border: 1px solid var(--ui-border);
    background: var(--ui-input-bg); color: var(--ui-text);
  }
  #extras_todos .td-custom { width: 66px; }
  .td-row {
    display: flex; align-items: center; gap: 10px; padding: 11px 12px; margin: 6px 0;
    border: 1px solid var(--ui-border); border-radius: var(--ui-radius);
    cursor: pointer; font-size: 14.5px; -webkit-tap-highlight-color: transparent;
  }
  .td-row:active { border-color: var(--ui-accent); }
  .td-row .td-t { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .td-row .td-meta { color: var(--ui-muted); font-size: 12px; white-space: nowrap; }
  .td-dot {
    width: 22px; height: 22px; flex: 0 0 auto; border-radius: 50%;
    border: 2px solid var(--ui-accent); display: inline-flex;
    align-items: center; justify-content: center; color: transparent; font-size: 13px;
  }
  .td-row.td-flash .td-dot { background: var(--ui-accent); color: #fff; }
  .td-up-row { opacity: 0.72; }
  .td-del {
    border: none; background: none; color: var(--ui-muted); font-size: 15px;
    padding: 4px 6px; cursor: pointer; flex: 0 0 auto;
  }
  .td-del:hover { color: var(--ui-text); }
  .td-empty { color: var(--ui-muted); font-size: 13px; text-align: center; padding: 8px 0; }
  `;
  document.head.appendChild(style);

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function freqLabel(everyDays) {
    if (everyDays === 0) return 'once';
    if (everyDays === 1) return 'daily';
    if (everyDays === 7) return 'weekly';
    if (everyDays === 14) return 'every 2 weeks';
    if (everyDays === 30) return 'monthly';
    return 'every ' + everyDays + ' days';
  }

  function buildTodo(view) {
    view.innerHTML = `
    <div class="xt-card">
      <div class="td-form">
        <input type="text" class="td-name" placeholder="New task…" maxlength="80">
        <select class="td-freq">
          <option value="0">Once</option>
          <option value="1" selected>Daily</option>
          <option value="2">Every 2 days</option>
          <option value="3">Every 3 days</option>
          <option value="7">Weekly</option>
          <option value="14">Every 2 weeks</option>
          <option value="30">Monthly</option>
          <option value="custom">Custom…</option>
        </select>
        <input type="number" class="td-custom" min="1" max="365" value="4" title="every N days" hidden>
        <button type="button" class="xt-mini td-add">Add</button>
      </div>
    </div>
    <div class="xt-subhead">Due</div>
    <div class="td-due"></div>
    <div class="xt-subhead">Upcoming</div>
    <div class="td-upcoming"></div>`;

    const nameEl = view.querySelector('.td-name');
    const freqEl = view.querySelector('.td-freq');
    const customEl = view.querySelector('.td-custom');
    const addEl = view.querySelector('.td-add');
    const dueEl = view.querySelector('.td-due');
    const upEl = view.querySelector('.td-upcoming');

    let state = null;
    try { state = global.TodoCore.load(localStorage.getItem(global.TodoCore.KEY)); }
    catch (_) { state = global.TodoCore.createState(); }

    function persist() {
      try { localStorage.setItem(global.TodoCore.KEY, global.TodoCore.save(state)); } catch (_) {}
    }

    function rowH(t, meta, flash) {
      return '<div class="td-row' + (flash ? ' td-flash' : '') + '" data-id="' + esc(t.id) + '">'
        + '<span class="td-dot">✓</span>'
        + '<span class="td-t">' + esc(t.name) + '</span>'
        + '<span class="td-meta">' + esc(meta) + '</span>'
        + '<button type="button" class="td-del" data-del="' + esc(t.id) + '" title="delete task">✕</button>'
        + '</div>';
    }

    let flashId = null;
    function render() {
      const dayIdx = global.TodoCore.localDayIdx(Date.now());
      const due = global.TodoCore.dueTasks(state, dayIdx);
      const up = global.TodoCore.upcomingTasks(state, dayIdx);
      dueEl.innerHTML = due.length
        ? due.map((t) => rowH(t, freqLabel(t.everyDays), t.id === flashId)).join('')
        : '<div class="td-empty">Nothing due — all done! 🎉</div>';
      upEl.innerHTML = up.length
        ? up.map((t) => rowH(t, 'in ' + t.daysLeft + (t.daysLeft === 1 ? ' day' : ' days')).replace('td-row', 'td-row td-up-row')).join('')
        : '<div class="td-empty">Nothing scheduled.</div>';
    }

    function complete(id) {
      const dayIdx = global.TodoCore.localDayIdx(Date.now());
      if (!global.TodoCore.completeTask(state, id, dayIdx)) return;
      persist();
      flashId = id;           // brief green-check flash before the row moves
      render();
      setTimeout(() => { flashId = null; render(); }, 350);
    }

    function add() {
      let days = freqEl.value === 'custom' ? parseInt(customEl.value, 10) : parseInt(freqEl.value, 10);
      if (!Number.isFinite(days) || days < 0) days = 0;
      const t = global.TodoCore.addTask(state, nameEl.value, days, global.TodoCore.localDayIdx(Date.now()));
      if (!t) return;
      nameEl.value = '';
      persist();
      render();
      nameEl.focus();
    }

    addEl.onclick = add;
    nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    freqEl.addEventListener('change', () => { customEl.hidden = freqEl.value !== 'custom'; });

    view.addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        const row = del.closest('.td-row');
        const name = row ? row.querySelector('.td-t').textContent : '';
        if (global.confirm('Delete "' + name + '"?')) { global.TodoCore.removeTask(state, del.dataset.del); persist(); render(); }
        return;
      }
      const row = e.target.closest('.td-row');
      if (row) complete(row.dataset.id);
    });

    // Pick up day rollovers when the app comes back to the foreground.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

    render();
    return { render };
  }

  let T = null;
  global.ExtrasRegisterTool({
    id: 'todos', name: 'Todo', icon: '✅', label: 'Todo',
    build(v) { T = buildTodo(v); },
    onShow() { if (T) T.render(); },
  });

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
