// The index of the chats: the id of a message in MAX is a string, and the
// cursor of the API is a timestamp. Both were wrong, and the index kept one
// message per chat.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxframe-recall-'));
process.env.DATA_DIR = dir;
process.env.WORKSPACE_DIR = dir;
process.env.MAX_BOT_TOKEN = 'test-token';

const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  if (!href.startsWith('https://platform-api2.max.ru')) return realFetch(url, options);
  const query = new URL(href).searchParams;
  calls.push({ href, after: query.get('after'), count: query.get('count') });
  const messages = [1, 2, 3].map((n) => ({
    body: { mid: `mid-${n}`, seq: n, text: `сообщение номер ${n}` },
    recipient: { chat_id: 'chat-1', chat_type: 'dialog' },
    sender: { user_id: 7, first_name: 'Знакомый' },
    timestamp: 1700000000 + n,
  }));
  return { ok: true, status: 200, text: async () => JSON.stringify({ messages }) };
};

const { rememberChat } = await import('../src/max-chats.js');
const { indexMax } = await import('../src/recall.js');
const { all, kvGet } = await import('../src/db.js');

after(() => {
  globalThis.fetch = realFetch;
});

test('every message of a chat gets into the index', async () => {
  rememberChat({ chat_id: 'chat-1', type: 'dialog', title: 'Знакомый' });
  await indexMax();
  const rows = all('SELECT * FROM recall_tg WHERE chat = ?', 'chat-1');
  assert.equal(rows.length, 3, 'все три сообщения должны попасть в индекс');
  assert.deepEqual(rows.map((r) => r.msg_id).sort(), ['mid-1', 'mid-2', 'mid-3']);
});

test('the cursor of the chat is a timestamp, and the next read uses it', async () => {
  const cursor = kvGet('recall_tg_last', {});
  assert.ok(cursor['max:chat-1'] >= 1e9, 'курсор должен быть временем, а не id сообщения');
  calls.length = 0;
  await indexMax();
  assert.equal(calls[0].after, String(cursor['max:chat-1']));
});
