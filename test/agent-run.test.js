// The executor end to end: the tool loop, the continuation of the conversation
// and the cancellation. MiniMax is replaced by a local stub, so the run goes
// through the same code as in production - only the network is different.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxframe-run-'));
process.env.DATA_DIR = dir;
process.env.WORKSPACE_DIR = dir;
process.env.MINIMAX_API_KEY = 'test-key';
process.env.MAX_BOT_TOKEN = 'test-token';

const requests = [];
let answers = [];
let holdUntilAbort = false;

globalThis.fetch = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ url: String(url), body });
  if (holdUntilAbort) {
    // Never answers: the run has to be stopped by the owner.
    await new Promise((_resolve, reject) => {
      const signal = options.signal;
      if (!signal) return;
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  }
  const next = answers.shift() || { choices: [{ message: { content: 'готово' }, finish_reason: 'stop' }] };
  return { ok: true, status: 200, text: async () => JSON.stringify(next) };
};

const { startRun, stopRun } = await import('../src/agent.js');
const { get, all, run: dbRun, now } = await import('../src/db.js');

const project = () => get('SELECT * FROM projects WHERE is_default = 1');
const waitFor = async (runId, timeout = 8000) => {
  const started = Date.now();
  for (;;) {
    const row = get('SELECT * FROM runs WHERE id = ?', runId);
    if (row && !['queued', 'running'].includes(row.status)) return row;
    if (Date.now() - started > timeout) throw new Error(`Задача ${runId} не закончилась`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('the executor calls a tool, feeds the result back and finishes', async () => {
  requests.length = 0;
  answers = [
    {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: '',
          reasoning_content: 'прочитаю файл',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"note.txt"}' } }],
        },
      }],
    },
    { choices: [{ finish_reason: 'stop', message: { content: 'Файл прочитан: привет' } }] },
  ];
  fs.writeFileSync(path.join(dir, 'note.txt'), 'привет\n');

  const runId = startRun({ projectId: project().id, prompt: 'прочитай note.txt', origin: 'bot' });
  const row = await waitFor(runId);

  assert.equal(row.status, 'done');
  assert.match(row.result, /Файл прочитан/);

  // The model was asked twice: the tool call, then the answer with the result.
  assert.equal(requests.length, 2);
  const second = requests[1].body;
  const toolMessage = second.messages.find((m) => m.role === 'tool');
  assert.ok(toolMessage, 'результат инструмента должен уйти модели обратно');
  assert.equal(toolMessage.tool_call_id, 'call-1');
  assert.match(toolMessage.content, /привет/);

  // The thinking of the model comes back in the next request unchanged.
  const assistant = second.messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.reasoning_content, 'прочитаю файл');
  assert.equal(assistant.tool_calls[0].id, 'call-1');
});

test('the conversation continues in the next message', async () => {
  requests.length = 0;
  answers = [{ choices: [{ finish_reason: 'stop', message: { content: 'второй ответ' } }] }];
  const runId = startRun({ projectId: project().id, prompt: 'а теперь ещё', origin: 'bot' });
  await waitFor(runId);

  const messages = requests[0].body.messages;
  assert.ok(messages.length > 2, 'история диалога должна уйти в запрос');
  assert.equal(messages[0].role, 'system', 'первым идёт системный промпт');
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /прочитай note\.txt/);
  assert.ok(messages.some((m) => m.role === 'assistant' && /Файл прочитан/.test(m.content || '')));
});

test('the history of the session is stored in the database', async () => {
  const sessionId = get('SELECT session_id FROM projects WHERE is_default = 1').session_id;
  assert.ok(sessionId, 'у проекта должен быть id сессии');
  const rows = all('SELECT role, content, tool_calls FROM agent_messages WHERE session_id = ? ORDER BY id', sessionId);
  assert.ok(rows.some((r) => r.role === 'user' && /прочитай/.test(r.content)));
  assert.ok(rows.some((r) => r.role === 'tool'));
});

test('the owner can stop a running task', async () => {
  requests.length = 0;
  holdUntilAbort = true;
  answers = [];
  const runId = startRun({ projectId: project().id, prompt: 'долгая задача', origin: 'bot' });
  await new Promise((r) => setTimeout(r, 150));
  const stopped = stopRun(runId);
  const row = await waitFor(runId);
  holdUntilAbort = false;
  assert.equal(stopped, true);
  assert.equal(row.status, 'stopped');
});
