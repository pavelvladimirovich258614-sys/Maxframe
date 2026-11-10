import { Cron } from 'croner';
import { all, get, run, now, addLog, defaultProject } from './db.js';
import { bus } from './bus.js';
import { startRun, isPaused, onRunFinished } from './agent.js';

const jobs = new Map();

export function validateCron(expr) {
  // Five fields only: a sixth (seconds) field would let a task fire every second.
  if (String(expr || '').trim().split(/\s+/).length !== 5) throw new Error('Неверное расписание: нужно 5 полей «мин час день месяц день_недели»');
  try {
    const c = new Cron(expr, { paused: true });
    const next = c.nextRun();
    c.stop();
    return next ? next.getTime() : null;
  } catch (e) {
    throw new Error(`Неверное расписание: ${e.message}`);
  }
}

export function fireTask(id, manual = false) {
  const t = get('SELECT * FROM tasks WHERE id = ?', Number(id));
  if (!t) throw new Error('Нет такой задачи');
  if (!manual && isPaused()) {
    addLog('cron', `Пропуск «${t.name}»: автоматика на паузе`);
    return null;
  }
  // The previous run of this task is still going: don't pile up a queue of copies.
  const busy = all("SELECT key FROM kv WHERE key LIKE 'task_run_%' AND value = ?", String(t.id))
    .some((k) => get("SELECT id FROM runs WHERE id = ? AND status IN ('queued', 'running')", Number(k.key.slice(9))));
  if (busy) {
    addLog('cron', `Пропуск «${t.name}»: прошлый запуск ещё работает`);
    if (manual) throw new Error('Прошлый запуск этой задачи ещё работает');
    return null;
  }
  const projectId = t.project_id && get('SELECT id FROM projects WHERE id = ?', t.project_id) ? t.project_id : defaultProject().id;
  const runId = startRun({ projectId, prompt: `[Задача по расписанию «${t.name}»]\n${t.prompt}`, origin: 'cron' });
  run("UPDATE tasks SET last_run_at = ?, last_status = 'running' WHERE id = ?", now(), t.id);
  run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', `task_run_${runId}`, String(t.id));
  bus.change('task', t.id);
  return runId;
}

// Runs cut off by a restart never report back: their tasks would show "running" forever.
run("UPDATE tasks SET last_status = 'stopped' WHERE last_status = 'running'");
run("DELETE FROM kv WHERE key LIKE 'task_run_%'");

export function reloadTasks() {
  for (const j of jobs.values()) j.stop();
  jobs.clear();
  for (const t of all('SELECT * FROM tasks WHERE enabled = 1')) {
    try {
      jobs.set(t.id, new Cron(t.cron, { protect: true }, () => {
        try { fireTask(t.id); } catch (e) { addLog('error', `Задача «${t.name}»: ${e.message}`); }
      }));
    } catch (e) {
      addLog('error', `Задача «${t.name}»: ${e.message}`);
    }
  }
  bus.change('task');
}

export function nextRuns() {
  return Object.fromEntries([...jobs].map(([id, j]) => [id, j.nextRun()?.getTime() ?? null]));
}

export function createTask({ name, cron, prompt, project_id = null, enabled = 1 }) {
  if (!name || !cron || !prompt) throw new Error('Нужны название, расписание и текст задачи');
  validateCron(cron);
  const res = run('INSERT INTO tasks (name, cron, prompt, project_id, enabled) VALUES (?, ?, ?, ?, ?)', name, cron, prompt, project_id || null, enabled ? 1 : 0);
  addLog('cron', `Новая задача «${name}» (${cron})`);
  reloadTasks();
  return Number(res.lastInsertRowid);
}

export function updateTask(id, patch) {
  const allowed = ['name', 'cron', 'prompt', 'project_id', 'enabled'];
  const keys = Object.keys(patch).filter((k) => allowed.includes(k));
  if (patch.cron) validateCron(patch.cron);
  if (keys.length) run(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => (k === 'enabled' ? (patch[k] ? 1 : 0) : patch[k])), Number(id));
  reloadTasks();
}

export function deleteTask(id) {
  run('DELETE FROM tasks WHERE id = ?', Number(id));
  reloadTasks();
}

onRunFinished((r) => {
  const row = get('SELECT value FROM kv WHERE key = ?', `task_run_${r.id}`);
  if (!row) return;
  run('UPDATE tasks SET last_status = ? WHERE id = ?', r.status, Number(JSON.parse(row.value)));
  run('DELETE FROM kv WHERE key = ?', `task_run_${r.id}`);
  bus.change('task');
});
