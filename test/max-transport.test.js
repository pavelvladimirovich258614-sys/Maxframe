// The transport and the dispatcher against a local stub: the webhook of MAX,
// the answering of the owner and the structured answer of the dispatcher.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxframe-transport-'));
process.env.DATA_DIR = dir;
process.env.WORKSPACE_DIR = dir;
process.env.PORT = '7893';
process.env.MAX_BOT_TOKEN = 'test-token';
process.env.MAX_WEBHOOK_SECRET = 's3cret';
process.env.MINIMAX_API_KEY = 'test-key';

const apiCalls = [];
const realFetch = globalThis.fetch;

globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  if (href.startsWith('http://127.0.0.1')) return realFetch(url, options);
  apiCalls.push({ url: href, body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {} });
  // The bot info and an empty answer of the model.
  if (href.endsWith('/me')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ user_id: 999, username: 'frame_bot', is_bot: true, first_name: 'Frame' }) };
  }
  // The model answers with the tool the schema asks for.
  const body = options.body ? JSON.parse(options.body) : null;
  const submit = body?.tools?.find((t) => t.function?.name === 'submit_result');
  if (submit && !body.messages?.some((m) => m.role === 'tool')) {
    const answer = {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: '',
          tool_calls: [{ id: 'call-json', type: 'function', function: { name: 'submit_result', arguments: JSON.stringify({ action: 'note', confidence: 0.9 }) } }],
        },
      }],
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(answer) };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) };
};

const { startWeb } = await import('../src/web.js');
const { structured } = await import('../src/agent.js');
const { handleMaxUpdate } = await import('../src/max-bot.js');
const { get, all, kvSet } = await import('../src/db.js');

const server = await startWeb();
const post = (path, body, headers = {}) => realFetch(`http://127.0.0.1:7893${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('the webhook takes an event with the right secret', async () => {
  const res = await post('/max/webhook', { update_type: 'bot_started', chat_id: 1, user: { user_id: 2 } }, { 'x-max-bot-api-secret': 's3cret' });
  assert.equal(res.status, 200);
});

test('the webhook refuses a wrong secret and a missing one', async () => {
  const wrong = await post('/max/webhook', { update_type: 'bot_started' }, { 'x-max-bot-api-secret': 'wrong' });
  assert.equal(wrong.status, 401);
  const none = await post('/max/webhook', { update_type: 'bot_started' });
  assert.equal(none.status, 401);
});

test('the webhook refuses a foreign method', async () => {
  const res = await realFetch('http://127.0.0.1:7893/max/webhook', { method: 'GET' });
  assert.equal(res.status, 405);
});

test('an event of the owner reaches the session and the answer goes back', async () => {
  apiCalls.length = 0;
  kvSet('owner_max_id', '42');
  kvSet('owner_max_chat_id', '42');
  await handleMaxUpdate({
    update_type: 'message_created',
    message: {
      body: { mid: 'mid-owner-1', text: 'привет' },
      recipient: { chat_id: '42', chat_type: 'dialog' },
      sender: { user_id: 42, first_name: 'Владелец' },
    },
  });
  // The run goes to the session; the answer is sent back to the chat.
  await new Promise((r) => setTimeout(r, 400));
  const sent = apiCalls.filter((c) => c.url.includes('/messages'));
  assert.ok(sent.length >= 1, 'бот должен ответить владельцу');
  assert.equal(sent[0].url.includes('chat_id=42'), true);
});

test('the dispatcher answers with the schema', async () => {
  apiCalls.length = 0;
  const schema = {
    type: 'object',
    properties: { action: { type: 'string', enum: ['forward', 'reply', 'note', 'ask'] }, confidence: { type: 'number' } },
    required: ['action', 'confidence'],
  };
  const out = await structured({
    prompt: 'что делать с сообщением',
    schema,
    system: 'ты диспетчер',
    tools: [],
  });
  assert.ok(out && typeof out === 'object');
  assert.ok('action' in out);
});

test('the dashboard is closed to a request from the outside', async () => {
  // A local request is allowed by design (the machine of the owner).
  const local = await realFetch('http://127.0.0.1:7893/api/state', { headers: { 'x-mf-client': '1' } });
  assert.equal(local.status, 200);

  // A request that came through a proxy is remote, even from 127.0.0.1.
  const remote = await realFetch('http://127.0.0.1:7893/api/state', {
    headers: { 'x-mf-client': '1', 'x-forwarded-for': '203.0.113.7' },
  });
  assert.equal(remote.status, 401);
});

after(() => {
  globalThis.fetch = realFetch;
  // The keep-alive sockets of the test would keep the server open.
  server?.closeAllConnections?.();
  server?.close();
});
