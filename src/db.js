import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, config } from './config.js';
import { bus } from './bus.js';

export const db = new DatabaseSync(path.join(DATA_DIR, 'mainframe.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  session_id TEXT,
  description TEXT DEFAULT '',
  keywords TEXT DEFAULT '',
  is_default INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  chat_id TEXT PRIMARY KEY,
  name TEXT,
  username TEXT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  mode TEXT DEFAULT 'ask',
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  chat_id TEXT,
  name TEXT,
  username TEXT,
  text TEXT,
  last_message_id INTEGER,
  status TEXT DEFAULT 'new',
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  decision TEXT,
  draft TEXT,
  run_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT,
  prompt TEXT,
  origin TEXT,
  status TEXT DEFAULT 'queued',
  result TEXT,
  cost REAL,
  inbox_id INTEGER,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT,
  content TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  prompt TEXT NOT NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  enabled INTEGER DEFAULT 1,
  last_run_at INTEGER,
  last_status TEXT
);
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT,
  message TEXT,
  run_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS bot_msgs (
  message_id INTEGER PRIMARY KEY,
  inbox_id INTEGER,
  project_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
`);

// Chats and channels the MAX bot is in. MAX has no "list my chats" endpoint anymore,
// so the set is learned from incoming events and refreshed from GET /chats/{id}.
db.exec(`
CREATE TABLE IF NOT EXISTS max_chats (
  chat_id TEXT PRIMARY KEY,
  type TEXT,
  title TEXT,
  username TEXT,
  status TEXT,
  participants_count INTEGER,
  is_public INTEGER DEFAULT 0,
  is_admin INTEGER DEFAULT 0,
  messages_count INTEGER,
  last_event_time INTEGER,
  first_seen INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS max_members (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  username TEXT,
  is_bot INTEGER DEFAULT 0,
  is_admin INTEGER DEFAULT 0,
  is_owner INTEGER DEFAULT 0,
  join_time INTEGER,
  last_access_time INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_max_members_chat ON max_members(chat_id);
`);

// Conversation history of the executor. The Claude Agent SDK kept sessions on disk;
// with MiniMax the history lives here, keyed by the project's session id.
db.exec(`
CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project_id INTEGER,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  extra TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, id);
`);

// Webhook deliveries are retried by MAX, so every update id is remembered.
db.exec(`
CREATE TABLE IF NOT EXISTS max_updates (
  update_id TEXT PRIMARY KEY,
  update_type TEXT,
  created_at INTEGER NOT NULL
);
`);

// Columns added after the first release.
const inboxCols = db.prepare('PRAGMA table_info(inbox)').all().map((c) => c.name);
if (!inboxCols.includes('external_id')) db.exec('ALTER TABLE inbox ADD COLUMN external_id TEXT');
if (!inboxCols.includes('meta')) db.exec('ALTER TABLE inbox ADD COLUMN meta TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_inbox_ext ON inbox(source, external_id)');

export const now = () => Date.now();

export const all = (sql, ...args) => db.prepare(sql).all(...args);
export const get = (sql, ...args) => db.prepare(sql).get(...args);
export const run = (sql, ...args) => db.prepare(sql).run(...args);

export function kvGet(key, fallback = null) {
  const row = get('SELECT value FROM kv WHERE key = ?', key);
  return row ? JSON.parse(row.value) : fallback;
}
export function kvSet(key, value) {
  run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  bus.change('kv', key);
}

export function addLog(kind, message, runId = null) {
  const text = String(message).slice(0, 2000);
  run('INSERT INTO log (kind, message, run_id, created_at) VALUES (?, ?, ?, ?)', kind, text, runId, now());
  bus.change('log');
}

export function defaultProject() {
  let p = get('SELECT * FROM projects WHERE is_default = 1');
  if (!p) {
    run('INSERT INTO projects (name, cwd, description, is_default, created_at) VALUES (?, ?, ?, 1, ?)',
      'Мейнфрейм', config.workspaceDir, 'Общие задачи, команды из бота, cron без проекта', now());
    p = get('SELECT * FROM projects WHERE is_default = 1');
  }
  return p;
}
defaultProject();

// Keep the database small: 30 days of journal and session details are enough.
export function pruneOld() {
  const cutoff = now() - 30 * 86400000;
  run('DELETE FROM log WHERE created_at < ?', cutoff);
  run('DELETE FROM run_events WHERE created_at < ?', cutoff);
}
pruneOld();
setInterval(pruneOld, 86400000).unref();

// Interrupted runs from a previous process are no longer alive.
run("UPDATE runs SET status = 'stopped', finished_at = ? WHERE status IN ('running', 'queued')", now());
// Messages whose session was cut off go back to the owner instead of hanging "in progress".
run("UPDATE inbox SET status = 'routed' WHERE status = 'forwarded' AND run_id IN (SELECT id FROM runs WHERE status = 'stopped')");
