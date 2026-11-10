// Проверки дефектов, найденных при аудите миграции на MAX и MiniMax.
// Каждая проверка повторяет то, что ломалось.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// База и рабочая папка — во временную, чтобы тест не трогал данные владельца.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'maxframe-regress-'));
process.env.WORKSPACE_DIR = process.env.DATA_DIR;
process.env.INBOX_BURST_MS = '300';
process.env.MAX_BOT_TOKEN = 'test-token';

const { mainframeTools } = await import('../src/mcp.js');
const { MiniMaxClient } = await import('../src/minimax.js');
const { linkedBotMessage, handleMaxUpdate } = await import('../src/max-bot.js');
const { isUnattendedBlocked } = await import('../src/agent.js');
const { handleMaxMessage, flushBursts } = await import('../src/dispatcher.js');
const { all, get, run, now, kvSet, kvGet } = await import('../src/db.js');

const schemaOf = (name) => mainframeTools().find((t) => t.name.endsWith(name)).parameters;

// ---------- 1. Схемы инструментов: Zod 4 ломал их молча ----------

test('the schema of a tool keeps the real types (Zod 4)', () => {
  const p = schemaOf('add_expense').properties;
  assert.equal(p.amount.type, 'number');
  assert.equal(p.currency.type, 'string');
  assert.deepEqual(schemaOf('add_expense').required, ['amount']);
});

test('enums stay enums in the schema', () => {
  const p = schemaOf('memory_save').properties;
  assert.equal(p.type.type, 'string');
  assert.deepEqual(p.type.enum, ['user', 'feedback', 'people', 'project', 'reference']);
  assert.equal(p.pending.type, 'boolean');
});

test('arrays of objects keep their inner schema', () => {
  const posts = schemaOf('content_save_drafts').properties.posts;
  assert.equal(posts.type, 'array');
  assert.equal(posts.items.type, 'object');
  assert.ok(posts.items.properties.network);
  assert.deepEqual(posts.items.required, ['network', 'text']);

  const networks = schemaOf('save_social_report').properties.networks;
  assert.equal(networks.type, 'array');
  assert.equal(networks.items.type, 'object');
  assert.ok(networks.items.properties.followers);
});

// ---------- 2. MiniMax: ошибка приходит и в HTTP 200 ----------

test('a failed call with HTTP 200 raises a clear error', async () => {
  const api = new MiniMaxClient({
    apiKey: 'k',
    fetchImpl: async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'invalid api key' }, choices: [] }),
    }),
  });
  await assert.rejects(
    api.chat({ messages: [{ role: 'user', content: 'x' }] }),
    (e) => e.code === 1004 && /MINIMAX_API_KEY/.test(e.message),
  );
});

test('the thinking is asked to be separate and never reaches the answer', async () => {
  let body = null;
  const api = new MiniMaxClient({
    apiKey: 'k',
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: '<think>размышление</think>Ответ', reasoning_content: 'размышление' }, finish_reason: 'stop' }] }),
      };
    },
  });
  const out = await api.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(body.reasoning_split, true);
  assert.equal(out.content, 'Ответ');
  assert.equal(out.reasoning, 'размышление');
});

test('an unsupported reasoning_effort is not sent', async () => {
  let body = null;
  const api = new MiniMaxClient({
    apiKey: 'k',
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
    },
  });
  await api.chat({ messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'none' });
  assert.equal(body.reasoning_effort, undefined);
  await api.chat({ messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'high' });
  assert.equal(body.reasoning_effort, 'high');
});

// ---------- 3. MAX: ссылка на сообщение бота ----------

test('the id of the replied message is read from link.message.mid', () => {
  run('INSERT OR REPLACE INTO bot_msgs (message_id, inbox_id, project_id, created_at) VALUES (?, ?, ?, ?)', 'mid-42', 7, null, now());
  const found = linkedBotMessage({ link: { type: 'reply', message: { mid: 'mid-42' } } });
  assert.ok(found, 'сообщение бота должно найтись по link.message.mid');
  assert.equal(found.inbox_id, 7);
  assert.equal(linkedBotMessage({ link: { type: 'reply', message: { mid: 'mid-42' } } }).message_id, 'mid-42');
  assert.equal(linkedBotMessage({}), null);
});

// ---------- 4. MAX: свои сообщения и кнопки ----------

test('the bot does not make a card of its own message', async () => {
  kvSet('max_bot_id', '999');
  const before = all("SELECT id FROM inbox WHERE source IN ('max','group')").length;
  await handleMaxUpdate({
    update_type: 'message_created',
    message: {
      body: { mid: 'own-1', text: 'мой ответ' },
      recipient: { chat_id: '555', chat_type: 'dialog' },
      sender: { user_id: 999, first_name: 'Бот' },
    },
  });
  await flushBursts();
  const after = all("SELECT id FROM inbox WHERE source IN ('max','group')").length;
  assert.equal(after, before, 'собственное сообщение бота не должно становиться входящим');
});

test('a stranger cannot press the buttons', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    sent.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
  try {
    // The owner is not paired: nobody may act on the buttons.
    kvSet('owner_max_id', null);
    kvSet('owner_max_chat_id', null);
    run(
      'INSERT INTO inbox (source, chat_id, name, username, text, status, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'max', '777', 'Знакомый', 'z', 'привет', 'routed', null, now(), now(),
    );
    const item = get("SELECT * FROM inbox WHERE chat_id = '777' ORDER BY id DESC LIMIT 1");
    await handleMaxUpdate({
      update_type: 'message_callback',
      callback: { callback_id: 'cb-1', payload: `r:${item.id}`, user: { user_id: 42, first_name: 'Чужой' } },
      message: { body: { mid: 'm-1' }, recipient: { chat_id: '777', chat_type: 'dialog' } },
    });
    // No message goes to the person, and the owner is told what happened.
    const toPerson = sent.find((s) => s.url.includes('/messages') && s.body && 'text' in s.body);
    assert.equal(toPerson, undefined, 'чужой не должен отправлять сообщения людям');
    const answer = sent.find((s) => s.url.includes('/answers'));
    assert.ok(answer, 'на нажатие кнопки отвечают');
    assert.match(answer.body.notification, /владельц/i);
    assert.equal(get('SELECT status FROM inbox WHERE id = ?', item.id).status, 'routed', 'карточка не должна уйти в отвеченные');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------- 5. Входящие: одна карточка на пачку ----------

test('a burst of messages becomes one card', async () => {
  const before = all("SELECT id FROM inbox WHERE source IN ('max','group')").length;
  await handleMaxMessage({ chatId: '888', text: 'первая строка', name: 'Знакомый', externalId: 'e-1', chatType: 'dialog' });
  await handleMaxMessage({ chatId: '888', text: 'вторая строка', name: 'Знакомый', externalId: 'e-2', chatType: 'dialog' });
  await new Promise((r) => setTimeout(r, 700));
  const rows = all("SELECT id FROM inbox WHERE source IN ('max','group')");
  assert.equal(rows.length - before, 1, 'пачка сообщений должна дать одну карточку');
  const card = get('SELECT * FROM inbox WHERE id = ?', rows[rows.length - 1].id);
  assert.match(card.text, /первая строка/);
  assert.match(card.text, /вторая строка/);
});

test('the same delivery twice does not make a second card', async () => {
  const before = all("SELECT id FROM inbox WHERE source IN ('max','group')").length;
  await handleMaxMessage({ chatId: '889', text: 'повтор', name: 'Знакомый', externalId: 'e-dup', chatType: 'dialog' });
  await handleMaxMessage({ chatId: '889', text: 'повтор', name: 'Знакомый', externalId: 'e-dup', chatType: 'dialog' });
  await new Promise((r) => setTimeout(r, 700));
  const rows = all("SELECT id FROM inbox WHERE source IN ('max','group')");
  assert.equal(rows.length - before, 1);
});

test('the same message is stored once, however often it arrives', async () => {
  await handleMaxMessage({ chatId: '890', text: 'одна и та же', name: 'Знакомый', externalId: 'e-once', chatType: 'dialog' });
  await handleMaxMessage({ chatId: '890', text: 'одна и та же', name: 'Знакомый', externalId: 'e-once', chatType: 'dialog' });
  await new Promise((r) => setTimeout(r, 700));
  const raw = all('SELECT * FROM inbox_raw WHERE chat_id = ?', '890');
  assert.equal(raw.length, 1, 'сообщение с тем же id должно лежать в очереди один раз');
});

test('a message that arrived before a crash becomes a card after the restart', async () => {
  const { run: dbRun, now: ts } = await import('../src/db.js');
  dbRun(
    'INSERT INTO inbox_raw (chat_id, external_id, name, text, chat_type, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    '891', 'e-crash', 'Знакомый', 'сообщение до падения', 'dialog', ts(),
  );
  const before = all("SELECT id FROM inbox WHERE source IN ('max','group')").length;
  await flushBursts();
  const rows = all("SELECT id FROM inbox WHERE source IN ('max','group')");
  assert.equal(rows.length - before, 1, 'сообщение из очереди должно стать карточкой');
  const card = get('SELECT * FROM inbox WHERE chat_id = ? ORDER BY id DESC LIMIT 1', '891');
  assert.match(card.text, /сообщение до падения/);
});

// ---------- 6. Изоляция непрочитанных сообщений ----------

test('a session without the owner may not touch the machine', () => {
  assert.equal(isUnattendedBlocked('run_command', { dangerous: true }), true);
  assert.equal(isUnattendedBlocked('mcp__browser__navigate', {}), true);
  assert.equal(isUnattendedBlocked('mcp__computer__screenshot', {}), true);
  assert.equal(isUnattendedBlocked('read_file', {}), false);
  assert.equal(isUnattendedBlocked('write_file', {}), false);
});

// ---------- 7. Модели и курсоры ----------

test('the studio asks a model of MiniMax, not of another provider', async () => {
  const { contentModel } = await import('../src/content.js');
  const { config } = await import('../src/config.js');
  assert.equal(contentModel(), config.minimax.dispatchModel);
  assert.match(contentModel(), /^MiniMax-/, 'модель другой провайдера API MiniMax не примет');
});

test('the cursor of the chat history is a timestamp, and the ids stay strings', async () => {
  const { all } = await import('../src/db.js');
  const { indexMax } = await import('../src/recall.js');
  await indexMax();
  const rows = all('SELECT * FROM recall_tg');
  for (const r of rows) {
    assert.equal(typeof r.msg_id, 'string', 'id сообщения MAX - строка');
    assert.notEqual(r.msg_id, '', 'id не должен превращаться в 0');
  }
});
