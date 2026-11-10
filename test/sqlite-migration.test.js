// The id of a message in MAX is a string, in Telegram it was a number. The
// columns that hold it were INTEGER, and SQLite refused to put a string there.
// This check makes sure that the rebuild of the tables keeps the old rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxframe-migrate-'));
const file = path.join(dir, 'mainframe.db');

// The database as it was before the migration to MAX.
const old = new DatabaseSync(file);
old.exec(`
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cwd TEXT NOT NULL,
    session_id TEXT,
    description TEXT DEFAULT '',
    keywords TEXT DEFAULT '',
    is_default INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE bot_msgs (
    message_id INTEGER PRIMARY KEY,
    inbox_id INTEGER,
    project_id INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE inbox (
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
  INSERT INTO bot_msgs (message_id, inbox_id, project_id, created_at) VALUES (1234, 7, NULL, 1000);
  INSERT INTO inbox (source, chat_id, name, text, last_message_id, status, created_at, updated_at)
    VALUES ('telegram', '55', 'Старый контакт', 'старое сообщение', 1234, 'routed', 1000, 1000);
`);
old.close();

process.env.DATA_DIR = dir;
process.env.WORKSPACE_DIR = dir;

const { get, all, run } = await import('../src/db.js');

test('the id columns become text', () => {
  const botCol = all('PRAGMA table_info(bot_msgs)').find((c) => c.name === 'message_id');
  const inboxCol = all('PRAGMA table_info(inbox)').find((c) => c.name === 'last_message_id');
  assert.equal(String(botCol.type).toUpperCase(), 'TEXT');
  assert.equal(String(inboxCol.type).toUpperCase(), 'TEXT');
});

test('the old rows survive the rebuild', () => {
  const msg = get('SELECT * FROM bot_msgs WHERE message_id = ?', '1234');
  assert.ok(msg, 'строка бота должна сохраниться');
  assert.equal(msg.inbox_id, 7);

  const item = get('SELECT * FROM inbox WHERE chat_id = ?', '55');
  assert.ok(item, 'старое входящее должно сохраниться');
  assert.equal(item.text, 'старое сообщение');
  assert.equal(item.last_message_id, '1234');
  assert.equal(item.status, 'routed');
  assert.equal(item.source, 'telegram', 'прежний источник не переписывается');
});

test('a string id of MAX is accepted now', () => {
  run(
    'INSERT OR REPLACE INTO bot_msgs (message_id, inbox_id, project_id, created_at) VALUES (?, ?, ?, ?)',
    '0a1b2c3d-max-mid', 9, null, 2000,
  );
  const msg = get('SELECT * FROM bot_msgs WHERE message_id = ?', '0a1b2c3d-max-mid');
  assert.ok(msg, 'строка с id MAX должна записываться');
  assert.equal(msg.inbox_id, 9);
});
