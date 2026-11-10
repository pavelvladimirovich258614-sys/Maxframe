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
process.env.MAX_LONG_POLLING = '0';
process.env.PUBLIC_URL = '';
process.env.MAX_GROUP_INBOX = '0';
process.env.SEARXNG_URL = 'https://search.example';
process.env.YANDEX_WEATHER_KEY = 'fake-yandex-key';

const apiCalls = [];
const realFetch = globalThis.fetch;

globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  if (href.startsWith('http://127.0.0.1')) return realFetch(url, options);
  apiCalls.push({ url: href, body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {} });
  if (href.startsWith('https://search.example/search?')) {
    const query = new URL(href).searchParams.get('q');
    if (query === 'проверенный выпуск') {
      return { ok: true, json: async () => ({ results: [
        { title: 'Сегодня', url: 'https://example.org/today', publishedDate: new Date().toISOString().slice(0, 10) },
        { title: 'Вчера', url: 'https://example.net/yesterday', publishedDate: new Date(Date.now() - 86400000).toISOString().slice(0, 10) },
        { title: 'Архив', url: 'https://example.org/archive', publishedDate: '2001-01-01' },
      ] }) };
    }
    const date = query === 'архивная новость' ? '2001-01-01' : '2026-11-10';
    return { ok: true, json: async () => ({ results: [{ title: 'Местная новость', url: 'https://example.org/news', publishedDate: date }] }) };
  }
  // The bot info and an empty answer of the model.
  if (href.endsWith('/me')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ user_id: 999, username: 'frame_bot', is_bot: true, first_name: 'Frame' }) };
  }
  // The model answers with the tool the schema asks for.
  const body = options.body ? JSON.parse(options.body) : null;
  const current = body?.messages?.findLast((m) => m.role === 'user')?.content;
  if (current === 'Напиши последние новости по нейросетям за вчера и сегодня' || current === 'Новости математики за вчера и сегодня') {
    const query = current.startsWith('Напиши') ? 'архивная новость' : 'проверенный выпуск';
    const message = body.messages.some((m) => m.role === 'tool') ? { content: 'https://example.org/news' } : {
      content: '',
      tool_calls: [{ id: 'dated-news', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query, category: 'news', period: 'day' }) } }],
    };
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message }] }) };
  }
  if (current === 'Новости по нейросетям' || current?.startsWith('Ответь на мой предыдущий вопрос по этим данным.')) {
    const message = body.tools ? {
      content: '',
      tool_calls: [1, 1, 2, 3, 4, 5].map((query, i) => ({
        id: `news-${i}`, type: 'function',
        function: { name: 'web_search', arguments: JSON.stringify({ query: `нейросети ${query}`, category: 'news', period: 'day' }) },
      })),
    } : { content: '' };
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message }] }) };
  }
  if (body?.messages?.findLast((m) => m.role === 'user')?.content === 'Найди свежие новости Владивостока') {
    const result = body.messages.find((m) => m.role === 'tool');
    const message = result
      ? { content: `📰 ${JSON.parse(result.content).results[0].url} 🔎` }
      : {
          content: '',
          reasoning_content: 'поиск',
          tool_calls: [{ id: 'news', type: 'function', function: { name: 'web_search', arguments: '{"query":"Владивосток","category":"news","period":"day"}' } }],
        };
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message }] }) };
  }
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
const { handleMaxUpdate, startBot } = await import('../src/max-bot.js');
const { get, all, kvSet, kvGet } = await import('../src/db.js');

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

test('the owner dialogue reaches MiniMax without project history or write tools', async () => {
  apiCalls.length = 0;
  kvSet('owner_max_id', '42');
  kvSet('owner_max_chat_id', '42');
  kvSet('auth_error', { message: 'Старое ложное предупреждение' });
  const before = get('SELECT count(*) AS n FROM runs').n;
  await handleMaxUpdate({
    update_type: 'message_created',
    message: {
      body: { mid: 'mid-owner-1', text: 'Расскажи о доступных возможностях' },
      recipient: { chat_id: '42', chat_type: 'dialog' },
      sender: { user_id: 42, first_name: 'Владелец' },
    },
  });
  const sent = apiCalls.filter((c) => c.url.includes('/messages'));
  assert.ok(sent.length >= 1, 'бот должен ответить владельцу');
  assert.equal(sent[0].url.includes('chat_id=42'), true);
  const request = apiCalls.find((c) => c.url.endsWith('/chat/completions')).body;
  assert.equal(request.messages.length, 2);
  assert.deepEqual(request.tools.map((tool) => tool.function.name), ['web_search', 'get_weather', 'read_source']);
  assert.equal(get('SELECT count(*) AS n FROM runs').n, before);
  assert.equal(kvGet('auth_error', null), null);
});

test('owner news reaches the search tool and returns a source to MAX without a project run', async () => {
  apiCalls.length = 0;
  const before = get('SELECT count(*) AS n FROM runs').n;
  await handleMaxUpdate({ update_type: 'message_created', message: {
    body: { mid: 'owner-news-test', text: 'Найди свежие новости Владивостока' },
    recipient: { chat_id: '42', chat_type: 'dialog' },
    sender: { user_id: 42 },
  } });
  const modelCalls = apiCalls.filter((call) => call.url.endsWith('/chat/completions'));
  assert.equal(modelCalls.length, 2);
  assert.equal(modelCalls[1].body.messages.find((m) => m.tool_calls)?.reasoning_content, 'поиск');
  assert.equal(modelCalls[1].body.messages.at(-1).tool_call_id, 'news');
  assert.ok(apiCalls.some((call) => call.url.startsWith('https://search.example/search?') && call.url.includes('categories=news')));
  const sent = apiCalls.find((call) => call.url.includes('/messages') && call.body.text.includes('https://example.org/news'));
  assert.ok(sent);
  assert.equal(get('SELECT count(*) AS n FROM runs').n, before);
  assert.equal(JSON.stringify(modelCalls).includes('fake-yandex-key'), false);
});

test('found news sources reach MAX when the model exhausts its search budget', async () => {
  apiCalls.length = 0;
  await handleMaxUpdate({ update_type: 'message_created', message: {
    body: { mid: 'owner-news-limit-test', text: 'Новости по нейросетям' },
    recipient: { chat_id: '42', chat_type: 'dialog' },
    sender: { user_id: 42 },
  } });
  const searches = apiCalls.filter((call) => call.url.startsWith('https://search.example/search?'));
  assert.equal(searches.length, 4);
  assert.ok(searches.every((call) => new URL(call.url).searchParams.get('q') !== 'нейросети 5'));
  const lastModelCall = apiCalls.findLast((call) => call.url.endsWith('/chat/completions')).body;
  assert.equal(lastModelCall.tools, undefined);
  assert.equal(lastModelCall.messages.some((m) => m.role === 'tool' || m.tool_calls), false);
  assert.ok(apiCalls.some((call) => call.url.includes('/messages') && call.body.text.includes('https://example.org/news')));
});

test('two-day news uses a wider search but refuses out-of-period publications', async () => {
  apiCalls.length = 0;
  await handleMaxUpdate({ update_type: 'message_created', message: {
    body: { mid: 'two-day-news', text: 'Напиши последние новости по нейросетям за вчера и сегодня' },
    recipient: { chat_id: '42', chat_type: 'dialog' },
    sender: { user_id: 42 },
  } });
  const search = apiCalls.find((call) => call.url.startsWith('https://search.example/search?'));
  assert.equal(new URL(search.url).searchParams.get('time_range'), 'month');
  const sent = apiCalls.findLast((call) => call.url.includes('/messages'));
  assert.match(sent.body.text, /Не удалось подтвердить публикации/);
  assert.doesNotMatch(sent.body.text, /example\.org/);
});

test('two-day synthesis receives only dated publications from the requested days', async () => {
  apiCalls.length = 0;
  await handleMaxUpdate({ update_type: 'message_created', message: {
    body: { mid: 'two-day-confirmed-news', text: 'Новости математики за вчера и сегодня' },
    recipient: { chat_id: '42', chat_type: 'dialog' },
    sender: { user_id: 42 },
  } });
  const synthesis = apiCalls.findLast((call) => call.url.endsWith('/chat/completions')).body;
  assert.equal(synthesis.tools, undefined);
  const evidence = JSON.parse(synthesis.messages.at(-1).content.split('\n').at(-1));
  assert.deepEqual(evidence.map((source) => source.url), ['https://example.org/today', 'https://example.net/yesterday']);
  assert.ok(evidence.every((source) => source.dateFrom === 'выдача'));
  const sent = apiCalls.findLast((call) => call.url.includes('/messages'));
  assert.match(sent.body.text, /example\.org\/today/);
  assert.doesNotMatch(sent.body.text, /archive/);
});

test('a simple greeting is answered without starting a prior task', async () => {
  apiCalls.length = 0;
  const before = get('SELECT count(*) AS n FROM runs').n;
  await handleMaxUpdate({ update_type: 'message_created', message: {
    body: { mid: 'greeting-test', text: 'Привет!' },
    recipient: { chat_id: '42', chat_type: 'dialog' },
    sender: { user_id: 42, first_name: 'Владелец' },
  } });
  assert.equal(get('SELECT count(*) AS n FROM runs').n, before);
  const sent = apiCalls.find((c) => c.url.includes('/messages'));
  assert.ok(sent, 'бот должен ответить на приветствие');
});

test('capabilities answer does not revive old work or claim local computer access', async () => {
  apiCalls.length = 0;
  const before = get('SELECT count(*) AS n FROM runs').n;
  await handleMaxUpdate({ update_type: 'message_created', message: {
    body: { mid: 'identity-test', text: 'Кто ты и что умеешь?' },
    recipient: { chat_id: '42', chat_type: 'dialog' },
    sender: { user_id: 42, first_name: 'Владелец' },
  } });
  assert.equal(get('SELECT count(*) AS n FROM runs').n, before);
  const sent = apiCalls.find((c) => c.url.includes('/messages'));
  assert.ok(sent);
  assert.doesNotMatch(JSON.stringify(sent), /реестр|C:\\\\Users/i);
});

test('the three skills and relevant saved material reach the owner dialogue', async () => {
  apiCalls.length = 0;
  const ownerText = (mid, text) => handleMaxUpdate({ update_type: 'message_created', message: {
    body: { mid, text },
    recipient: { chat_id: '42', chat_type: 'dialog' },
    sender: { user_id: 42 },
  } });
  await ownerText('material-add', '/material Робототехника | Первая встреча во вторник. Факт из брифа.');
  assert.equal(kvGet('research_materials').length, 1);
  assert.equal(apiCalls.some((call) => call.url.endsWith('/chat/completions')), false);
  await ownerText('material-replace', '/material Робототехника | Встреча в четверг. Уточнено владельцем.');
  assert.equal(kvGet('research_materials').length, 1);
  await ownerText('material-social', 'Подготовь черновик поста о робототехнике для MAX.');
  const social = apiCalls.findLast((call) => call.url.endsWith('/chat/completions')).body;
  assert.match(social.messages[0].content, /# Исследователь/);
  assert.match(social.messages[0].content, /# Помощник по соцсетям/);
  assert.match(social.messages[0].content, /# Помощник по университетским задачам/);
  assert.match(social.messages.at(-2).content, /Встреча в четверг/);
  assert.doesNotMatch(social.messages.at(-2).content, /во вторник/);
  assert.equal(social.tools, undefined);
  apiCalls.length = 0;
  await ownerText('material-research', 'Найди в интернете про робототехнику и дай ссылки.');
  const research = apiCalls.filter((call) => call.url.endsWith('/chat/completions')).map(({ body }) => body);
  assert.ok(research.some((body) => body.tools));
  assert.ok(research.filter((body) => body.tools).every((body) => body.messages.every((message) => !message.content.includes('Встреча в четверг'))));
  assert.equal(research.at(-1).tools, undefined);
  assert.ok(research.at(-1).messages.some((message) => message.content.includes('Встреча в четверг')));
  await ownerText('material-university', 'Объясни, как проверить формулу для дисперсии выборки.');
  const university = apiCalls.findLast((call) => call.url.endsWith('/chat/completions')).body;
  assert.equal(university.messages.some((message) => message.content.includes('Встреча в четверг')), false);
});

test('a group owner message cannot save materials or receive private dialogue', async () => {
  const before = kvGet('research_materials');
  process.env.MAX_GROUP_INBOX = '1';
  apiCalls.length = 0;
  try {
    await handleMaxUpdate({ update_type: 'message_created', message: {
      body: { mid: 'group-material', text: '/material Частный черновик | Это сообщение из группы' },
      recipient: { chat_id: '-501', chat_type: 'chat' },
      sender: { user_id: 42 },
    } });
    assert.deepEqual(kvGet('research_materials'), before);
    assert.equal(kvGet('owner_max_chat_id'), '42');
    assert.equal(apiCalls.some((call) => call.url.includes('/messages') && call.url.includes('chat_id=-501')), false);
  } finally {
    process.env.MAX_GROUP_INBOX = '0';
  }
});

test('group messages do not enter inbox or replace owner private chat by default', async () => {
  kvSet('owner_max_id', '42');
  kvSet('owner_max_chat_id', '42');
  const before = get('SELECT count(*) AS n FROM inbox_raw').n;
  await handleMaxUpdate({ update_type: 'message_created', message: {
    body: { mid: 'group-ignore-test', text: 'новость' },
    recipient: { chat_id: '-500', chat_type: 'chat' },
    sender: { user_id: 42, first_name: 'Владелец' },
  } });
  assert.equal(get('SELECT count(*) AS n FROM inbox_raw').n, before);
  assert.equal(kvGet('owner_max_chat_id'), '42');
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

test('every registered MAX command has a working owner handler', async () => {
  let restarts = 0;
  await startBot({ requestRestart: () => { restarts += 1; } });
  const registered = apiCalls.find((call) => call.url.endsWith('/me/commands')).body.commands;
  const expected = {
    start: /Мейнфрейм/, menu: /Мейнфрейм/, status: /MiniMax/,
    inbox: /Входящие/, today: /Сегодня|Встречи/, projects: /Сессии/,
    social: /Соцсети/, tasks: /расписанию/, memory: /Память/, material: /материал/, audience: /аудитория/,
    setup: /Мейнфрейм|Работаю/, app: /Нет https-адреса/, new: /создан/,
    stop: /на паузе/, resume: /Автоматика включена/, restart: /Перезапущусь/,
  };
  assert.deepEqual(registered.map(({ name }) => name).sort(), Object.keys(expected).sort());
  const dispatch = (text, mid, chatType = 'dialog', userId = 42) => handleMaxUpdate({ update_type: 'message_created', message: {
    body: { mid, text },
    recipient: { chat_id: chatType === 'dialog' ? String(userId) : '-100', chat_type: chatType },
    sender: { user_id: userId, first_name: 'Тест' },
  } });
  for (const { name } of registered) {
    apiCalls.length = 0;
    await dispatch(name === 'new' ? '/new Тестовый проект' : `/${name}`, `command-${name}`);
    const replies = apiCalls.filter((call) => call.url.includes('/messages')).map((call) => call.body?.text).join('\n');
    assert.match(replies, expected[name], `/${name}`);
    if (name === 'new') assert.ok(get('SELECT id FROM projects WHERE name = ?', 'Тестовый проект'));
    if (name === 'stop') assert.equal(kvGet('paused'), true);
    if (name === 'resume') assert.equal(kvGet('paused'), false);
  }
  assert.equal(restarts, 1);
  await dispatch('/restart', 'restart-group', 'chat');
  await dispatch('/restart', 'restart-foreign', 'dialog', 43);
  assert.equal(restarts, 1);
});

after(() => {
  globalThis.fetch = realFetch;
  // The keep-alive sockets of the test would keep the server open.
  server?.closeAllConnections?.();
  server?.close();
});
