import test from 'node:test';
import assert from 'node:assert/strict';
import { MaxApi, messageText, messageId } from '../src/max-api.js';

const fakeFetch = (capture, response = {}) => async (url, options) => {
  capture.url = url;
  capture.options = options;
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(response),
    json: async () => response,
  };
};

test('sends the chat id as a query parameter and the token as a raw Authorization header', async () => {
  const capture = {};
  const api = new MaxApi({ token: 'test-token', fetchImpl: fakeFetch(capture, { message: { body: { mid: '1' } } }) });
  await api.sendMessage('123', 'hi');
  assert.equal(capture.url.href, 'https://platform-api2.max.ru/messages?chat_id=123');
  assert.equal(capture.options.headers.Authorization, 'test-token');
  assert.deepEqual(JSON.parse(capture.options.body), { text: 'hi' });
});

test('never sends the token as a query parameter', async () => {
  const capture = {};
  const api = new MaxApi({ token: 'secret-token', fetchImpl: fakeFetch(capture) });
  await api.sendMessage('1', 'x');
  assert.equal(capture.url.searchParams.get('access_token'), null);
  assert.equal(capture.url.href.includes('secret-token'), false);
});

test('reports HTTP errors without disclosing credentials', async () => {
  const api = new MaxApi({ token: 'secret', fetchImpl: async () => ({
    ok: false, status: 403, text: async () => JSON.stringify({ code: 'chat.denied', message: 'Forwarding is prohibited' }),
  }) });
  await assert.rejects(
    api.getMembers('1'),
    (error) => error.status === 403
      && error.code === 'chat.denied'
      && error.message.includes('403')
      && !error.message.includes('secret'),
  );
});

test('rejects empty and oversized messages', () => {
  const api = new MaxApi({ token: 'test' });
  assert.throws(() => api.sendMessage('1', ''));
  assert.throws(() => api.sendMessage('1', 'x'.repeat(4001)));
  assert.throws(() => api.sendMessage('', 'x'));
});

test('puts the reply link into the body, not the query', async () => {
  const capture = {};
  const api = new MaxApi({ token: 't', fetchImpl: fakeFetch(capture) });
  await api.sendMessage('55', 'ответ', { format: 'html', replyTo: 'mid-9' });
  const body = JSON.parse(capture.options.body);
  assert.deepEqual(body.link, { type: 'reply', mid: 'mid-9' });
  assert.equal(body.format, 'html');
  assert.equal(capture.url.searchParams.get('disable_link_preview'), null);
});

test('subscribe sends url, secret and update types', async () => {
  const capture = {};
  const api = new MaxApi({ token: 't', fetchImpl: fakeFetch(capture, { ok: true }) });
  await api.subscribe({ url: 'https://example.com/max/webhook', secret: 's3cret', updateTypes: ['message_created'] });
  assert.equal(capture.options.method, 'POST');
  assert.equal(capture.url.pathname, '/subscriptions');
  const body = JSON.parse(capture.options.body);
  assert.equal(body.url, 'https://example.com/max/webhook');
  assert.equal(body.secret, 's3cret');
  assert.deepEqual(body.update_types, ['message_created']);
});

test('long polling asks for updates and passes the marker on', async () => {
  const capture = {};
  const api = new MaxApi({ token: 't', fetchImpl: fakeFetch(capture, { updates: [], marker: 42 }) });
  await api.getUpdates({ limit: 100, timeout: 25, marker: 7, types: ['message_created'] });
  assert.equal(capture.url.pathname, '/updates');
  assert.equal(capture.url.searchParams.get('marker'), '7');
  assert.equal(capture.url.searchParams.get('types'), 'message_created');
});

test('members are read with a count limit', async () => {
  const capture = {};
  const api = new MaxApi({ token: 't', fetchImpl: fakeFetch(capture, { members: [] }) });
  await api.getMembers('42', { count: 100 });
  assert.equal(capture.url.pathname, '/chats/42/members');
  assert.equal(capture.url.searchParams.get('count'), '100');
});

test('answering a callback passes the callback id in the query', async () => {
  const capture = {};
  const api = new MaxApi({ token: 't', fetchImpl: fakeFetch(capture) });
  await api.answerCallback('cb-1', { notification: 'Готово' });
  assert.equal(capture.url.pathname, '/answers');
  assert.equal(capture.url.searchParams.get('callback_id'), 'cb-1');
  assert.deepEqual(JSON.parse(capture.options.body), { notification: 'Готово' });
});

test('the upload flow asks for a url and then sends the binary there', async () => {
  const calls = [];
  const api = new MaxApi({
    token: 't',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).startsWith('https://platform-api2.max.ru/uploads')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ url: 'https://upload.example.com/u', token: 'tok-1' }), json: async () => ({ url: 'https://upload.example.com/u', token: 'tok-1' }) };
      }
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    },
  });
  const attachment = await api.upload('image', Buffer.from('bytes'), { filename: 'a.png' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://platform-api2.max.ru/uploads?type=image');
  assert.equal(calls[1].url, 'https://upload.example.com/u');
  assert.deepEqual(attachment, { type: 'image', payload: { token: 'tok-1' } });
});

test('reads text and id out of a MAX message', () => {
  const message = { body: { mid: 'm-1', text: 'привет', attachments: [{ type: 'image' }] } };
  assert.equal(messageText(message), 'привет');
  assert.equal(messageId(message), 'm-1');
  assert.equal(messageText({ body: { mid: 'm-2', text: '', attachments: [{ type: 'audio' }] } }), '[голосовое]');
});
