import test from 'node:test';
import assert from 'node:assert/strict';
import { MiniMaxClient, MiniMaxError, toolDefinition, parseToolArguments } from '../src/minimax.js';

const fakeFetch = (capture, response) => async (url, options) => {
  capture.url = String(url);
  capture.options = options;
  capture.body = JSON.parse(options.body);
  return { ok: true, status: 200, text: async () => JSON.stringify(response), json: async () => response };
};

test('sends the model, the system prompt and the tools to the OpenAI-compatible endpoint', async () => {
  const capture = {};
  const api = new MiniMaxClient({
    apiKey: 'key-1',
    model: 'MiniMax-M3.1-Flash',
    fetchImpl: fakeFetch(capture, { model: 'MiniMax-M3.1-Flash', choices: [{ message: { content: 'привет' }, finish_reason: 'stop' }] }),
  });
  const out = await api.chat({
    messages: [{ role: 'user', content: 'дай ответ' }],
    system: 'Ты исполнитель.',
    tools: [toolDefinition({ name: 'read_file', description: 'читать', parameters: { type: 'object', properties: { path: { type: 'string' } } } })],
  });
  assert.equal(capture.url, 'https://api.minimax.io/v1/chat/completions');
  assert.equal(capture.options.headers.Authorization, 'Bearer key-1');
  assert.equal(capture.body.model, 'MiniMax-M3.1-Flash');
  assert.equal(capture.body.stream, false);
  assert.equal(capture.body.messages[0].role, 'system');
  assert.equal(capture.body.messages[0].content, 'Ты исполнитель.');
  assert.equal(capture.body.messages[1].role, 'user');
  assert.equal(capture.body.tools[0].function.name, 'read_file');
  assert.equal(out.content, 'привет');
  assert.equal(out.finishReason, 'stop');
});

test('returns the tool calls of the model with their arguments', async () => {
  const capture = {};
  const api = new MiniMaxClient({
    apiKey: 'k',
    fetchImpl: fakeFetch(capture, {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: '',
          reasoning_content: 'думаю',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
        },
      }],
    }),
  });
  const out = await api.chat({ messages: [{ role: 'user', content: 'читай' }] });
  assert.equal(out.finishReason, 'tool_calls');
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].id, 'call-1');
  assert.equal(out.toolCalls[0].function.name, 'read_file');
  assert.deepEqual(parseToolArguments(out.toolCalls[0].function.arguments), { path: 'a.txt' });
  // The reasoning of the model has to come back with the answer.
  assert.equal(out.reasoning, 'думаю');
});

test('a failed call raises an error with the status and without the key', async () => {
  const api = new MiniMaxClient({
    apiKey: 'super-secret',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'invalid api key' } }) }),
  });
  await assert.rejects(
    api.chat({ messages: [{ role: 'user', content: 'x' }] }),
    (e) => e instanceof MiniMaxError && e.status === 401 && !e.message.includes('super-secret') && e.message.includes('invalid api key'),
  );
});

test('the key is required', () => {
  assert.throws(() => new MiniMaxClient({}), /MINIMAX_API_KEY/);
});

test('tool arguments survive a truncated or wrapped fragment', () => {
  assert.deepEqual(parseToolArguments('{"path":"a.txt"}'), { path: 'a.txt' });
  assert.deepEqual(parseToolArguments('вот ответ: {"path":"a.txt"} — всё'), { path: 'a.txt' });
  assert.deepEqual(parseToolArguments('мусор'), {});
  assert.deepEqual(parseToolArguments(''), {});
  assert.deepEqual(parseToolArguments({ path: 'b.txt' }), { path: 'b.txt' });
});

test('a tool definition keeps the JSON Schema of the parameters', () => {
  const def = toolDefinition({
    name: 'edit_file',
    description: 'править',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  });
  assert.equal(def.type, 'function');
  assert.equal(def.function.name, 'edit_file');
  assert.deepEqual(def.function.parameters.required, ['path']);
});
