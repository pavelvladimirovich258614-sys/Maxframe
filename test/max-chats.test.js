import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The database lives in DATA_DIR; point it to a throwaway folder before the
// module is loaded.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mainframe-max-'));

const { rememberChat, knownChats, knownChat, chatAllowed, audience, reach, learnChatFromMessage } = await import('../src/max-chats.js');
const { run, now } = await import('../src/db.js');

test('a chat learned from an event is remembered', () => {
  rememberChat({ chat_id: '100', type: 'chat', title: 'Рабочая группа', participants_count: 12 });
  const chat = knownChat('100');
  assert.equal(chat.type, 'chat');
  assert.equal(chat.title, 'Рабочая группа');
  assert.equal(chat.participants_count, 12);
});

test('a chat learned from a message carries its type', () => {
  learnChatFromMessage({ recipient: { chat_id: '200', chat_type: 'dialog' }, timestamp: 1710000000 });
  assert.equal(knownChat('200').type, 'dialog');
});

test('the chats of the bot are listed', () => {
  const list = knownChats();
  assert.ok(list.length >= 2);
  assert.ok(list.some((c) => c.chat_id === '100'));
});

test('without a whitelist every known chat is allowed', () => {
  assert.equal(chatAllowed('100'), true);
  assert.equal(chatAllowed(''), false);
});

test('the audience is the union of the members of the chats', async () => {
  rememberChat({ chat_id: '300', type: 'channel', title: 'Канал' });
  // The member list is filled by the API; here it is written directly.
  run(
    'INSERT OR REPLACE INTO max_members (chat_id, user_id, first_name, last_name, username, is_bot, is_admin, is_owner, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    '300', 'u-1', 'Аня', 'Иванова', 'anya', 0, 1, 0, now(),
  );
  const people = audience();
  const anna = people.find((p) => p.userId === 'u-1');
  assert.equal(anna.name, 'Аня Иванова');
  assert.equal(anna.username, 'anya');
  assert.ok(anna.chats.includes('300'));
});

test('the reach lists the chats and how many people the bot sees', () => {
  const r = reach();
  assert.ok(r.chats.length >= 3);
  assert.ok(r.chats.every((c) => c.chatId && c.title));
  assert.ok(r.people >= 1);
});
