// Guards the Extras recurring-todo tool (static/extras-todos.js).
//
//   (1) TodoCore state logic — add/complete/remove, due vs upcoming
//       computation across simulated local-day indices (due when never
//       done, resurfaces exactly N days after completion, one-off tasks
//       vanish once done), persistence round-trip, backup importMerge
//       (union by id, newer completion wins).
//   (2) Source/wiring invariants — script registered everywhere it must
//       be (index.html script tag, refresh cache-delete list, run.py
//       live-update tracking).
//
// Run: node tests/todos.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + msg); } }

const root = path.join(__dirname, '..');
require(path.join(root, 'static', 'extras-todos.js'));
const C = globalThis.TodoCore;
ok(!!C, 'TodoCore exported under Node');

const DAY0 = 20000;  // arbitrary local day index for the simulation

// --- 1) core state logic -----------------------------------------------------
{
  const s = C.createState();
  const a = C.addTask(s, 'Water plants', 3, DAY0);
  const b = C.addTask(s, 'Take out trash', 0, DAY0);
  ok(!!a && !!b && s.tasks.length === 2, 'addTask: two tasks added');
  ok(C.addTask(s, '   ', 1, DAY0) === null && s.tasks.length === 2,
    'addTask: blank name rejected');
  ok(a.lastDoneDay === null && a.everyDays === 3 && a.createdDay === DAY0,
    'addTask: fields initialised (never done, everyDays kept)');

  // never done -> due immediately
  ok(C.dueTasks(s, DAY0).length === 2, 'dueTasks: never-done tasks are due');
  ok(C.upcomingTasks(s, DAY0).length === 0, 'upcomingTasks: nothing upcoming before first completion');

  // complete the recurring task today -> not due, upcoming with daysLeft = 3
  C.completeTask(s, a.id, DAY0);
  ok(C.dueTasks(s, DAY0).length === 1 && C.dueTasks(s, DAY0)[0].id === b.id,
    'completeTask: recurring task not due on completion day');
  {
    const up = C.upcomingTasks(s, DAY0);
    ok(up.length === 1 && up[0].id === a.id && up[0].daysLeft === 3,
      'upcomingTasks: daysLeft = full interval on completion day (got ' +
      (up[0] && up[0].daysLeft) + ')');
  }
  ok(C.upcomingTasks(s, DAY0 + 1)[0].daysLeft === 2, 'upcomingTasks: daysLeft counts down');
  ok(C.dueTasks(s, DAY0 + 2).length === 1, 'dueTasks: still not due one day early');
  ok(C.dueTasks(s, DAY0 + 3).some((t) => t.id === a.id),
    'dueTasks: due again exactly N days later');

  // completing the one-off task removes it entirely
  C.completeTask(s, b.id, DAY0);
  ok(s.tasks.length === 1 && !s.tasks.some((t) => t.id === b.id),
    'completeTask: one-off task disappears once done');

  ok(C.removeTask(s, a.id) === true && s.tasks.length === 0, 'removeTask: removes');
  ok(C.removeTask(s, a.id) === false, 'removeTask: unknown id -> false');
}
{
  // clamping / validation of everyDays
  const s = C.createState();
  ok(C.addTask(s, 'x', -5, DAY0).everyDays === 0, 'addTask: negative interval clamps to one-off');
  ok(C.addTask(s, 'y', 9999, DAY0).everyDays === 365, 'addTask: huge interval clamps to 365');
  ok(C.addTask(s, 'z', 2.7, DAY0).everyDays === 2, 'addTask: fractional interval floors');
}
{
  // localDayIdx: fixed timestamp -> stable index; respects local offset math
  const ms = Date.UTC(2026, 0, 15, 12, 0, 0);
  const expect = Math.floor((ms - new Date(ms).getTimezoneOffset() * 60000) / 86400000);
  ok(C.localDayIdx(ms) === expect, 'localDayIdx: matches local-midnight day math');
}

// --- 2) persistence round-trip ----------------------------------------------
{
  const s = C.createState();
  const a = C.addTask(s, 'Stretch', 1, DAY0);
  C.addTask(s, 'Read', 7, DAY0);
  C.completeTask(s, a.id, DAY0);
  const back = C.load(C.save(s));
  ok(back.tasks.length === 2 && back.seq === s.seq, 'load(save): task count + seq survive');
  ok(back.tasks[0].name === 'Stretch' && back.tasks[0].lastDoneDay === DAY0 &&
     back.tasks[1].name === 'Read' && back.tasks[1].lastDoneDay === null,
    'load(save): fields survive the round-trip');
  ok(C.load('not json').tasks.length === 0, 'load: garbage JSON -> empty state');
  ok(C.load(null).tasks.length === 0 && C.load('{}').tasks.length === 0,
    'load: null / shapeless -> empty state');
  {
    // malformed task entries are dropped, good ones kept
    const j = JSON.stringify({ tasks: [{ name: 'ok', everyDays: 1, id: 'k1' }, { nope: 1 }, null] });
    const st = C.load(j);
    ok(st.tasks.length === 1 && st.tasks[0].id === 'k1' && st.tasks[0].lastDoneDay === null,
      'load: malformed entries dropped, missing fields defaulted');
  }
}

// --- 3) backup importMerge ----------------------------------------------------
{
  const s1 = C.createState(), s2 = C.createState();
  const shared1 = C.addTask(s1, 'Shared', 1, DAY0);
  C.addTask(s1, 'OnlyA', 2, DAY0);
  C.addTask(s2, 'OnlyB', 3, DAY0);
  // same task id on both sides, s2 has the newer completion
  s2.tasks.push({ id: shared1.id, name: 'Shared', everyDays: 1, lastDoneDay: DAY0 + 5, createdDay: DAY0 });
  C.completeTask(s1, shared1.id, DAY0 + 2);

  const merged = C.load(C.importMerge(C.save(s1), C.save(s2)));
  ok(merged.tasks.length === 3, 'importMerge: union by id (3 unique tasks)');
  const sh = merged.tasks.find((t) => t.id === shared1.id);
  ok(sh && sh.lastDoneDay === DAY0 + 5, 'importMerge: newer lastDoneDay wins');
  ok(merged.tasks.some((t) => t.name === 'OnlyA') && merged.tasks.some((t) => t.name === 'OnlyB'),
    'importMerge: tasks unique to either side kept');
  // one side empty / garbage
  ok(C.load(C.importMerge(null, C.save(s1))).tasks.length === 2,
    'importMerge: null existing side -> incoming tasks');
  ok(C.load(C.importMerge('junk', 'junk')).tasks.length === 0,
    'importMerge: garbage both sides -> empty');
}

// --- 4) source/wiring invariants ----------------------------------------------
const src = fs.readFileSync(path.join(root, 'static', 'extras-todos.js'), 'utf8');
ok(/ExtrasRegisterTool\(\{[\s\S]*?id: 'todos'/.test(src),
  'todos: registered as an inline extras tool');
ok(src.includes("localStorage.setItem(global.TodoCore.KEY") || src.includes('cc.todos.v1'),
  'todos: persists to localStorage');

const indexSrc = fs.readFileSync(path.join(root, 'static', 'index.html'), 'utf8');
ok(indexSrc.includes('<script src="/static/extras-todos.js"></script>'),
  'index.html: todos script tag present');
ok(indexSrc.indexOf('<script src="/static/extras-todos.js"></script>') >
   indexSrc.indexOf('<script src="/static/extras.js"></script>'),
  'index.html: todos loads AFTER extras.js (registration hook must exist)');
ok(indexSrc.includes("'/static/extras-todos.js'"),
  'index.html: todos in the refresh cache-delete list');
ok(indexSrc.includes("localStorage.getItem('cc.todos.v1')"),
  'index.html: todos included in the backup payload');
ok(/data\.todos/.test(indexSrc), 'index.html: todos restored on import');

const runPy = fs.readFileSync(path.join(root, 'run.py'), 'utf8');
ok(/_TRACKED_JS = \{[\s\S]*?extras-todos\.js[\s\S]*?\}/.test(runPy)
  && /_SCRIPT_VERSION_FILES = \[[\s\S]*?extras-todos\.js[\s\S]*?\]/.test(runPy),
  'run.py: todos tracked for live-update');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
