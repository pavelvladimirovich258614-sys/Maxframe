// The rebuild of the tables must survive a crash in the middle: the leftover
// table must not stop the service from starting, and the rows must stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxframe-mig-recover-'));

// The database as it was before the migration, with the leftovers of an
// interrupted rebuild.
const db = new DatabaseSync(path.join(dir, 'mainframe.db'));
db.exec(`
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, cwd TEXT NOT NULL, session_id TEXT,
    description TEXT DEFAULT '', keywords TEXT DEFAULT '',
    is_default INTEGER DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE bot_msgs (
    message_id INTEGER PRIMARY KEY, inbox_id INTEGER, project_id INTEGER, created_at INTEGER NOT NULL
  );
  CREATE TABLE inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, chat_id TEXT, name TEXT, username TEXT,
    text TEXT, last_message_id INTEGER, status TEXT DEFAULT 'new',
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, decision TEXT, draft TEXT,
    run_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE inbox_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, chat_id TEXT, name TEXT, username TEXT,
    text TEXT, last_message_id TEXT, status TEXT DEFAULT 'new',
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, decision TEXT, draft TEXT,
    run_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, external_id TEXT, meta TEXT
  );
  INSERT INTO bot_msgs (message_id, inbox_id, project_id, created_at) VALUES (555, 3, NULL, 1000);
  INSERT INTO inbox (source, chat_id, name, text, last_message_id, status, created_at, updated_at)
    VALUES ('telegram', '66', 'Контакт', 'сообщение', 555, 'routed', 1000, 1000);
`);
db.close();

process.env.DATA_DIR = dir;
process.env.WORKSPACE_DIR = dir;

const { get, all } = await import('../src/db.js');

test('the service starts on a database with an interrupted rebuild', () => {
  const col = all('PRAGMA table_info(inbox)').find((c) => c.name === 'last_message_id');
  assert.equal(String(col.type).toUpperCase(), 'TEXT');
});

test('the rows of the interrupted rebuild are not lost', () => {
  const msg = get('SELECT * FROM bot_msgs WHERE message_id = ?', '555');
  assert.ok(msg, 'строка бота должна сохраниться');
  assert.equal(msg.inbox_id, 3);

  const item = get('SELECT * FROM inbox WHERE chat_id = ?', '66');
  assert.ok(item, 'старое входящее должно сохраниться');
  assert.equal(item.text, 'сообщение');
  assert.equal(item.last_message_id, '555');
});

test('the leftover table does not stay in the database', () => {
  const leftovers = all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_new'");
  assert.deepEqual(leftovers, [], 'временные таблицы миграции не должны оставаться');
});
