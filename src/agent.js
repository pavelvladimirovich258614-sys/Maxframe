// The executor: the personal agent that works in a project folder.
//
// It used to run on the Claude Agent SDK. Now it runs on MiniMax, and the parts
// the SDK provided are here: project sessions with a real history, tool calls,
// MCP servers, cancellation, an event journal and structured answers.
//
// One run = one MiniMax conversation with a tool loop. The history of a project
// lives in SQLite (agent_messages) under the project's session id, so a
// conversation continues exactly where it stopped.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { memoryPrompt } from './memory.js';
import { config, ROOT } from './config.js';
import { all, get, run, now, addLog, kvGet, kvSet } from './db.js';
import { bus } from './bus.js';
import { mainframeTools, mcpTools } from './mcp.js';
import { localTools, kbGuard } from './agent-tools.js';
import { macConfigured, macExec, macRead, macWrite } from './mac-remote.js';
import { MiniMaxClient, toolDefinition, parseToolArguments } from './minimax.js';

const active = new Map(); // runId -> { abort, projectId }
const queues = new Map(); // projectId -> [runId]
const listeners = new Set(); // fn(run) on finish

export const onRunFinished = (fn) => listeners.add(fn);
export const isPaused = () => kvGet('paused', false);
export const activeRuns = () => [...active.keys()];

const HISTORY_LIMIT = 40;      // messages kept for the model
const HISTORY_KEEP = 400;       // messages kept in the database

const MAINFRAME_PROMPT = `
Ты работаешь внутри личного мейнфрейма владельца (${config.owner.name}). Мейнфрейм это исполнитель на моделях MiniMax.
Тебе доступны инструменты: main frame (уведомить владельца, поставить cron-задачу, память, поиск по истории, финансы, соцсети), работа с файлами и терминалом, а также MCP-серверы, подключенные в mcp.json (Apple-приложения, управление Mac, браузер).
Пиши по-русски, коротко и по делу. Без длинных тире. Только реальные цифры.
Когда задача сделана, закончи ответ короткой сводкой: что сделано и что осталось.
У тебя есть терминал владельца: команды выполняй сам, не проси владельца запускать их, кроме тех, что требуют его пароля (sudo) или входа в аккаунт.
Чеки, квитанции и переводы, которые владелец присылает фото или текстом, записывай в его финансы через main frame add_expense (сумма, валюта, где, категория, дата из чека). Скриншоты банков и бирж с балансом: обнови остаток через main frame set_balance.
Память и история: «запомни…» от владельца сохраняй сразу через main frame memory_save и отвечай одной строкой, что запомнил; «забудь…» через memory_delete; «что ты помнишь про X» и вопросы о прошлом («что решили», «что писал», «когда обсуждали») сначала ищи через main frame recall (история всех сессий, входящих, почты и переписки в MAX), потом отвечай с датами.
Если менял код самого мейнфрейма (${ROOT}/src), проверь синтаксис (node --check) и вызови main frame restart_mainframe: он перезапустит мейнфрейм после твоего ответа. Сам службу мейнфрейма не перезапускай: это оборвёт текущую задачу.
`.trim();

// Tools an untrusted incoming message may not use. The text of a message from
// another person is data, not an instruction: such a session may not publish,
// schedule or send mail. Replies to people go through the owner.
const INBOX_BLOCKED = new Set([
  'mcp__mainframe__create_cron_task',
  'mcp__mainframe__linkedin_post',
  'mcp__apple__send_mail', 'mcp__apple__reply_all', 'mcp__apple__forward_mail',
  'mcp__apple__mail_reply', 'mcp__apple__trash_mail',
  'mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__reply', 'mcp__claude_ai_Gmail__forward',
]);
// Whole groups of tools that drive the owner's machine.
const INBOX_BLOCKED_PREFIX = ['mcp__computer__', 'mcp__browser__'];

const isBlocked = (name) => INBOX_BLOCKED.has(name) || INBOX_BLOCKED_PREFIX.some((p) => name.startsWith(p));

// A message that went into a session without the owner reading it (AUTO_FORWARD)
// may not touch the machine at all: no shell, no browser, no computer. The
// owner has to press the button first, and then the session works as usual.
export const isUnattendedBlocked = (name, tool) => Boolean(tool?.dangerous) || INBOX_BLOCKED_PREFIX.some((p) => name.startsWith(p));

const AUTH_RE = /Failed to authenticate|OAuth session expired|login reached its time limit|Invalid API key|401|403|unauthorized|invalid api key/i;

let client = null;
export function minimax() {
  if (!config.minimax.apiKey) throw new Error('MINIMAX_API_KEY не задан');
  if (!client) {
    client = new MiniMaxClient({
      apiKey: config.minimax.apiKey,
      baseUrl: config.minimax.baseUrl,
      model: config.minimax.model,
    });
  }
  return client;
}

function addEvent(runId, kind, content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  run('INSERT INTO run_events (run_id, kind, content, created_at) VALUES (?, ?, ?, ?)', runId, kind, text.slice(0, 20000), now());
  bus.change('run_event', runId, { kind });
}

function briefInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = input.command || input.file_path || input.path || input.url || input.pattern || input.query || input.message || input.text || input.prompt || input.old_string;
  const s = pick ? String(pick) : JSON.stringify(input);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

export function setAuthError(message) {
  kvSet('auth_error', message ? { message: message.slice(0, 300), at: now() } : null);
}

// ---------- session history -------------------------------------------------

const newSessionId = () => `mm_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;

// A conversation may not start in the middle of a tool round, and it may not
// end with an unanswered tool call: both make the API reject the history.
function trimHistory(messages) {
  let out = [...messages];
  const firstUser = out.findIndex((m) => m.role === 'user');
  if (firstUser > 0) out = out.slice(firstUser);
  while (out.length && out[out.length - 1].role === 'tool') out.pop();
  const last = out[out.length - 1];
  if (last?.role === 'assistant' && last.tool_calls?.length) out.pop();
  return out;
}

function loadHistory(project) {
  const rows = all(
    'SELECT role, content, tool_calls, tool_call_id, extra FROM agent_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    project.session_id, HISTORY_LIMIT,
  );
  return trimHistory(rows.reverse().map((r) => {
    const msg = { role: r.role, content: r.content || '' };
    if (r.tool_calls) {
      try { msg.tool_calls = JSON.parse(r.tool_calls); } catch { /* ignore a broken row */ }
    }
    if (r.tool_call_id) msg.tool_call_id = r.tool_call_id;
    if (r.extra) {
      try { Object.assign(msg, JSON.parse(r.extra)); } catch { /* ignore a broken row */ }
    }
    return msg;
  }));
}

function saveMessage(sessionId, projectId, message) {
  const extra = {};
  if (message.reasoning_content) extra.reasoning_content = message.reasoning_content;
  run(
    'INSERT INTO agent_messages (session_id, project_id, role, content, tool_calls, tool_call_id, extra, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    sessionId, projectId, message.role,
    typeof message.content === 'string' ? message.content : (message.content ?? ''),
    message.tool_calls ? JSON.stringify(message.tool_calls) : null,
    message.tool_call_id || null,
    Object.keys(extra).length ? JSON.stringify(extra) : null,
    now(),
  );
  // Keep the table bounded: the tail is what the model needs.
  run('DELETE FROM agent_messages WHERE session_id = ? AND id NOT IN (SELECT id FROM agent_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?)', sessionId, sessionId, HISTORY_KEEP);
}

// ---------- tool set --------------------------------------------------------

// Every tool the executor may use, as one map. The mainframe's own tools, the
// MCP servers from mcp.json and the local file/shell tools.
async function buildTools({ cwd, allowShell = true, remote = null }) {
  const list = [...mainframeTools(), ...(await mcpTools()), ...localTools({ cwd, allowShell, remote })];
  const map = new Map();
  for (const t of list) map.set(t.name, t);
  return map;
}

function permissionAllows(tool, mode) {
  if (mode === 'deny') return tool.dangerous ? false : true;
  if (mode === 'ask') return !tool.dangerous;
  return true;
}

// ---------- the run ---------------------------------------------------------

export function startRun({ projectId, prompt, origin = 'ui', inboxId = null }) {
  const project = get('SELECT * FROM projects WHERE id = ?', projectId);
  if (!project) throw new Error('Проект не найден');
  if (!prompt || !prompt.trim()) throw new Error('Пустое сообщение');
  const res = run(
    'INSERT INTO runs (project_id, session_id, prompt, origin, status, inbox_id, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    projectId, project.session_id, prompt.trim(), origin, 'queued', inboxId, now(),
  );
  const runId = Number(res.lastInsertRowid);
  addLog('run', `[${project.name}] ${origin}: ${prompt.trim().slice(0, 200)}`, runId);
  bus.change('run', runId);
  const q = queues.get(projectId) || [];
  q.push(runId);
  queues.set(projectId, q);
  pump(projectId);
  return runId;
}

function pump(projectId) {
  if ([...active.values()].some((a) => a.projectId === projectId)) return;
  const q = queues.get(projectId) || [];
  const next = q.shift();
  if (!next) return;
  execute(next)
    .then((r) => {
      // The Mac is off: put the run back at the head of the queue and look again in a minute.
      if (r === 'wait') { (queues.get(projectId) || queues.set(projectId, []).get(projectId)).unshift(next); setTimeout(() => pump(projectId), 60000); return 'wait'; }
      return null;
    })
    .catch((e) => addLog('error', `Запуск ${next}: ${e.message}`))
    .then((r) => { if (r !== 'wait') pump(projectId); });
}

async function execute(runId) {
  const r = get('SELECT * FROM runs WHERE id = ?', runId);
  if (!r || r.status !== 'queued') return;
  const project = get('SELECT * FROM projects WHERE id = ?', r.project_id);
  if (!project) {
    run("UPDATE runs SET status = 'error', result = 'Проект удалён', finished_at = ? WHERE id = ?", now(), runId);
    bus.change('run', runId);
    return;
  }
  const onMac = isMacProject(project.cwd);
  if (onMac && !(await macOnline())) {
    addEvent(runId, 'system', 'Жду Mac: файлы этого проекта на Mac, а он сейчас выключен. Запущу сам, как только он включится.');
    addLog('run', `[${project.name}] ждёт Mac`, runId);
    return 'wait';
  }
  const abortController = new AbortController();
  active.set(runId, { abort: abortController, projectId: project.id });
  run("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?", now(), runId);
  bus.change('run', runId);

  let status = 'error';
  let result = '';
  let sessionId = project.session_id;
  let tools = new Map();
  try {
    if (!path.isAbsolute(project.cwd || '')) throw new Error(`Папка проекта должна быть полным путём, сейчас: «${project.cwd || ''}»`);
    if (!fs.existsSync(project.cwd)) fs.mkdirSync(project.cwd, { recursive: true });

    // A project without a session starts a new one.
    if (!sessionId) {
      sessionId = newSessionId();
      run('UPDATE projects SET session_id = ? WHERE id = ?', sessionId, project.id);
      run('UPDATE runs SET session_id = ? WHERE id = ?', sessionId, runId);
      bus.change('project', project.id);
    }

    tools = await buildTools({ cwd: project.cwd, remote: remoteFor(project.cwd) });
    const blocked = r.origin === 'inbox' || r.origin === 'inbox-auto';
    // The message went into the session on its own: nobody read it before.
    const unattended = r.origin === 'inbox-auto';
    const allowed = [...tools.values()].filter((t) => permissionAllows(t, config.permissionMode));
    const definitions = allowed.map(toolDefinition);

    const system = `${MAINFRAME_PROMPT}\n${memoryPrompt()}`;
    const messages = loadHistory(project);
    messages.push({ role: 'user', content: r.prompt });
    saveMessage(sessionId, project.id, messages[messages.length - 1]);

    addEvent(runId, 'system', `Сессия запущена · ${config.minimax.model} · инструментов: ${definitions.length}`);

    let finalText = '';
    const maxTurns = config.minimax.maxTurns;
    for (let turn = 0; turn < maxTurns; turn += 1) {
      if (abortController.signal.aborted) throw new Error('__aborted__');
      const answer = await minimax().chat({
        messages,
        system,
        tools: definitions,
        model: config.minimax.model,
        maxTokens: config.minimax.maxTokens,
        reasoningEffort: config.minimax.reasoningEffort || undefined,
        signal: abortController.signal,
      });

      // The assistant message is echoed back unchanged: MiniMax puts its
      // reasoning next to the content and expects both to return.
      const assistant = {
        role: 'assistant',
        content: answer.content || '',
        ...(answer.toolCalls.length ? { tool_calls: answer.toolCalls } : {}),
        ...(answer.reasoning ? { reasoning_content: answer.reasoning } : {}),
      };
      messages.push(assistant);
      saveMessage(sessionId, project.id, assistant);

      if (!answer.toolCalls.length) {
        finalText = answer.content || '';
        if (answer.content) addEvent(runId, 'text', answer.content);
        break;
      }

      for (const call of answer.toolCalls) {
        if (abortController.signal.aborted) throw new Error('__aborted__');
        const name = call.function?.name || '';
        const args = parseToolArguments(call.function?.arguments);
        const tool = tools.get(name);
        let output;
        if (!tool) {
          output = `Инструмент ${name} недоступен в этой сессии.`;
        } else if (blocked && isBlocked(name)) {
          output = `Инструмент ${name} заблокирован: это сообщение пришло от другого человека, а решение должен принять владелец.`;
        } else if (unattended && isUnattendedBlocked(name, tool)) {
          output = `Инструмент ${name} заблокирован: сообщение попало в сессию без владельца. Он должен сначала прочитать его и подтвердить перенос в проект.`;
        } else if (!permissionAllows(tool, config.permissionMode)) {
          output = `Инструмент ${name} недоступен при текущем режиме прав (${config.permissionMode}).`;
        } else {
          try {
            output = await tool.handler(args, { cwd: project.cwd, signal: abortController.signal });
          } catch (e) {
            output = `Ошибка в ${name}: ${e.message}`;
          }
        }
        const text = typeof output === 'string' ? output : JSON.stringify(output);
        addEvent(runId, 'tool', { name, input: briefInput(name, args) });
        addLog('tool', `${name}: ${briefInput(name, args)}`, runId);
        const toolMessage = { role: 'tool', tool_call_id: call.id, name, content: text.slice(0, 40000) };
        messages.push(toolMessage);
        saveMessage(sessionId, project.id, toolMessage);
      }
      if (turn === maxTurns - 1) finalText = 'Достигнут лимит шагов. Работа не закончена.';
    }

    status = 'done';
    result = finalText || 'Задача выполнена без текстового ответа.';
    if (AUTH_RE.test(result)) setAuthError(result);
    else setAuthError(null);
  } catch (e) {
    if (abortController.signal.aborted || e.message === '__aborted__') {
      status = 'stopped';
      result = 'Остановлено';
    } else {
      status = 'error';
      result = e.message;
      if (AUTH_RE.test(e.message)) setAuthError(e.message);
      addEvent(runId, 'error', e.message);
    }
  } finally {
    active.delete(runId);
  }

  const lastText = get("SELECT content FROM run_events WHERE run_id = ? AND kind = 'text' ORDER BY id DESC LIMIT 1", runId)?.content || '';
  if (status === 'error' && (!lastText || !result.includes(lastText.slice(0, 60)))) addEvent(runId, 'error', result);
  run('UPDATE runs SET status = ?, result = ?, finished_at = ? WHERE id = ?', status, result, now(), runId);
  addLog('run', `[${project.name}] ${status === 'done' ? 'готово' : status}: ${result.slice(0, 200)}`, runId);
  bus.change('run', runId);
  const finished = get('SELECT * FROM runs WHERE id = ?', runId);
  // Notifications and reply drafts run in the background: the next queued run starts now.
  for (const fn of listeners) {
    Promise.resolve().then(() => fn(finished, project)).catch((e) => addLog('error', `onRunFinished: ${e.message}`));
  }
}

export function stopRun(runId) {
  const a = active.get(Number(runId));
  if (a) {
    a.abort.abort();
    return true;
  }
  const r = get("SELECT * FROM runs WHERE id = ? AND status = 'queued'", Number(runId));
  if (r) {
    const q = queues.get(r.project_id) || [];
    queues.set(r.project_id, q.filter((id) => id !== r.id));
    run("UPDATE runs SET status = 'stopped', finished_at = ? WHERE id = ?", now(), r.id);
    bus.change('run', r.id);
    return true;
  }
  return false;
}

// Kill switch: stop everything and pause automatic actions until resumed.
export function stopAll() {
  for (const [id] of active) stopRun(id);
  for (const [pid, q] of queues) {
    for (const id of q) run("UPDATE runs SET status = 'stopped', finished_at = ? WHERE id = ?", now(), id);
    queues.set(pid, []);
  }
  kvSet('paused', true);
  addLog('system', 'Всё остановлено. Автоматика на паузе.');
}

export function resumeAll() {
  kvSet('paused', false);
  addLog('system', 'Автоматика снова включена.');
}

// ---------- projects that live on the Mac (server mode) ----------
export const isMacProject = (cwd) => Boolean(config.macRunner) && !config.serverDirs.some((d) => cwd === d || String(cwd || '').startsWith(`${d}/`));

// A Mac project is worked on over SSH: the files and the commands live there.
function remoteFor(cwd) {
  if (!isMacProject(cwd) || !macConfigured()) return null;
  return {
    exec: (command, options = {}) => macExec(command, { cwd, ...options }),
    read: (filePath) => macRead(filePath),
    write: (filePath, content) => macWrite(filePath, content),
  };
}

export function macOnline() {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: Number(process.env.MAC_SSH_PORT || 2222) });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(2500, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// ---------- structured answers ----------------------------------------------

// A one-shot call that must answer with JSON. The model is asked to call a
// single tool whose parameters are the schema; if it answers with plain text
// instead, the JSON is parsed out of it.
export async function structured({ prompt, schema, system, cwd = config.kbDir, tools = ['read_file', 'search_files', 'list_files'], maxTurns = 8, model = config.minimax.dispatchModel }) {
  const root = fs.existsSync(cwd) ? cwd : config.workspaceDir;
  const guard = kbGuard(root);
  const local = localTools({ cwd: root, allowShell: false });
  const byName = new Map(local.map((t) => [t.name, t]));
  const available = tools.map((n) => byName.get(n)).filter(Boolean);

  const submit = {
    name: 'submit_result',
    description: 'Отдать ответ по схеме. Вызови этот инструмент с готовым результатом.',
    parameters: schema,
    handler: async (args) => JSON.stringify(args),
  };

  const definitions = [toolDefinition(submit), ...available.map(toolDefinition)];
  const messages = [{ role: 'user', content: prompt }];
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 120000);
  let out = null;
  let lastText = '';
  try {
    for (let turn = 0; turn < Math.max(1, maxTurns); turn += 1) {
      const answer = await minimax().chat({
        messages,
        system: `${system}\nОтвет верни через инструмент submit_result.`,
        tools: definitions,
        model,
        maxTokens: config.minimax.maxTokens,
        signal: abortController.signal,
      });
      messages.push({ role: 'assistant', content: answer.content || '', ...(answer.toolCalls.length ? { tool_calls: answer.toolCalls } : {}) });
      lastText = answer.content || lastText;
      const submitCall = answer.toolCalls.find((c) => c.function?.name === 'submit_result');
      if (submitCall) {
        out = parseToolArguments(submitCall.function.arguments);
        break;
      }
      const other = answer.toolCalls.filter((c) => c.function?.name !== 'submit_result');
      if (!other.length) {
        // No tool call: the model answered with text. Try to read JSON out of it.
        const parsed = tryParseJson(lastText);
        if (parsed) { out = parsed; break; }
        if (turn === Math.max(1, maxTurns) - 1) break;
        messages.push({ role: 'user', content: 'Ответь только JSON по схеме, без других слов.' });
        continue;
      }
      for (const call of other) {
        const tool = byName.get(call.function?.name);
        let output;
        try {
          guard(call.function?.name, parseToolArguments(call.function?.arguments));
          output = tool ? await tool.handler(parseToolArguments(call.function?.arguments)) : 'Инструмент недоступен';
        } catch (e) {
          output = `Ошибка: ${e.message}`;
        }
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.function?.name, content: String(output).slice(0, 20000) });
      }
    }
  } catch (e) {
    if (abortController.signal.aborted) throw new Error('Диспетчер не ответил за 2 минуты');
    if (AUTH_RE.test(e.message)) setAuthError(e.message);
    throw new Error(e.message);
  } finally {
    clearTimeout(timer);
  }
  if (!out) {
    const parsed = tryParseJson(lastText);
    if (parsed) return parsed;
    throw new Error(lastText ? 'Модель не вернула ответ по схеме' : 'Пустой ответ');
  }
  setAuthError(null);
  return out;
}

function tryParseJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---------- session history for the dashboard --------------------------------

// The sessions of the mainframe: one per project, with the last activity.
export function sessions(limit = 60) {
  const list = all(`
    SELECT p.id AS project_id, p.name, p.cwd, p.session_id, p.created_at,
           (SELECT MAX(created_at) FROM agent_messages m WHERE m.session_id = p.session_id) AS last_activity,
           (SELECT COUNT(*) FROM agent_messages m WHERE m.session_id = p.session_id) AS messages
    FROM projects p
    WHERE p.session_id IS NOT NULL
    ORDER BY last_activity DESC
    LIMIT ?`, limit);
  return list.map((s) => ({
    sessionId: s.session_id,
    title: s.name,
    cwd: s.cwd,
    lastModified: s.last_activity || s.created_at,
    branch: null,
    projectId: s.project_id,
    messages: s.messages,
  }));
}

// The last messages of a project session, both sides, oldest first.
export function pastMessages(project, limit = 60) {
  if (!project?.session_id) return { total: 0, items: [] };
  const rows = all(
    'SELECT role, content, tool_calls FROM agent_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    project.session_id, Math.min(limit * 2, 400),
  );
  const items = [];
  for (const m of rows.reverse()) {
    if (m.role === 'user' && m.content) items.push({ role: 'user', text: m.content.slice(0, 4000) });
    else if (m.role === 'assistant' && m.content) items.push({ role: 'ai', text: m.content.slice(0, 6000) });
    else if (m.role === 'tool') items.push({ role: 'tool', text: 'инструмент' });
  }
  const out = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (it.role === 'tool' && prev?.role === 'tool') { prev.count = (prev.count || 1) + 1; continue; }
    out.push({ ...it });
  }
  return { total: out.length, items: out.slice(-limit) };
}
