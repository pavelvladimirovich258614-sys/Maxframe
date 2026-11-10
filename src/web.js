import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { ROOT, config } from './config.js';
import { all, get, run, now, kvGet, addLog } from './db.js';
import { bus } from './bus.js';
// Порядок импортов важен: agent.js ↔ dispatcher.js образуют круг (agent → mcp →
// recall → groups → dispatcher → agent), и dispatcher.js на верхнем уровне зовёт
// onRunFinished. Если начать с agent.js, тот вызов попадёт в ещё не инициализированную
// const и модуль не загрузится. Начинаем с dispatcher.js — круг разрывается.
// Модуль целиком: имя функции сессий поменялось при переходе на MiniMax,
// а старое имя ещё может встретиться в старом agent.js.
import { forwardItem, replyItem, ignoreItem, classify, restoreItem, chatHistory, suggestReply } from './dispatcher.js';
import * as agent from './agent.js';
import { startRun, stopRun, stopAll, resumeAll, isPaused, activeRuns, pastMessages } from './agent.js';
import { createTask, updateTask, deleteTask, fireTask, nextRuns, validateCron } from './scheduler.js';
import { mcpSummary } from './mcp.js';
import { maxState } from './max-chats.js';
import { botState, ownerId } from './max-bot.js';
import { tunnelState } from './tunnel.js';
import { voiceState } from './voice.js';
import { mailState } from './mail.js';
import { financeSummary, addExpense, deleteExpense, rates } from './finance.js';
import * as linkedin from './linkedin.js';
import * as content from './content.js';
import * as memory from './memory.js';
import { recall, recallOpen, recallStats } from './recall.js';
import { saveUpload } from './uploads.js';
import { channelStats, socialState, refreshReport } from './social.js';
import { agenda, upcomingReminders, completeReminder, createReminder, createEvent, notesList, noteBody, createNote } from './apple.js';

const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

// ---------- auth ----------
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k));
}

function isLocal(req) {
  const ip = req.socket.remoteAddress || '';
  const proxied = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['cf-ray'];
  return !proxied && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
}

// Mini App MAX: та же двухшаговая проверка подписи, что была у Telegram.
// Ключ = HMAC-SHA256("WebAppData", токен бота), сообщение = отсортированные
// пары "key=value", соединённые переводом строки (без самого "hash"),
// результат = hex и сравнивается с параметром hash.
// В данных пользователя Mini App поле id (у объектов Bot API — user_id).
function maxUser(initData) {
  if (!initData || !config.max.token) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(config.max.token).digest();
  const calc = crypto.createHmac('sha256', key).update(dataCheck).digest('hex');
  if (!safeEq(calc, hash)) return null;
  if (now() / 1000 - Number(params.get('auth_date') || 0) > 86400) return null;
  try {
    const user = JSON.parse(params.get('user'));
    // Принимаем оба имени поля: в initData Mini App это id, в объектах Bot API — user_id.
    const uid = user?.user_id ?? user?.id;
    if (uid === undefined || uid === null) return null;
    return { ...user, user_id: uid };
  } catch {
    return null;
  }
}

// Заголовок с initData Mini App. Основной — x-max-init-data, остальные
// приняты как запасные варианты написания того же имени.
const MAX_INIT_HEADERS = ['x-max-init-data', 'x-max-initdata', 'x-max-init'];

function maxInitData(req) {
  for (const h of MAX_INIT_HEADERS) {
    const v = req.headers[h];
    if (v) return String(v);
  }
  return null;
}

// Blocks DNS rebinding and cross-site requests from other pages open in the browser:
// a foreign page cannot set custom headers without a CORS preflight, which we never allow.
function sameOrigin(req) {
  if (req.headers['x-mf-client'] !== '1') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function authorized(req) {
  if (!sameOrigin(req)) return null;
  const host = (req.headers.host || '').split(':')[0];
  if (isLocal(req) && ['127.0.0.1', 'localhost'].includes(host)) return 'local';
  const token = req.headers['x-mf-token'] || cookies(req).mf_token;
  if (token && safeEq(String(token), config.dashboardToken)) return 'token';
  // Mini App MAX: пульт открывается из мессенджера, доступ только у владельца.
  const user = maxUser(maxInitData(req));
  const owner = ownerId();
  // Идентификаторы сравниваем строками: MAX отдаёт id числом, а ownerId()
  // может вернуть строку из базы. Без владельца (ownerId() === null) вход не проходит.
  if (user && owner !== null && owner !== undefined && owner !== '' && String(user.user_id ?? user.id) === String(owner)) return 'max';
  return null;
}

// ---------- helpers ----------
function send(res, code, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(code, { 'content-type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}

async function readBody(req, max = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new Error('Слишком большой запрос');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function state(req) {
  const local = isLocal(req);
  return {
    paused: isPaused(),
    authError: kvGet('auth_error', null),
    running: activeRuns(),
    counts: {
      inbox: get("SELECT COUNT(*) c FROM inbox WHERE status IN ('new','routed','error')").c,
      projects: get('SELECT COUNT(*) c FROM projects').c,
      tasks: get('SELECT COUNT(*) c FROM tasks WHERE enabled = 1').c,
    },
    // Транспорт MAX вместо Telegram: личный Telegram-аккаунт у бота не бывает.
    max: { enabled: config.max.enabled, ...maxState },
    bot: { configured: Boolean(config.max.token), owner: Boolean(ownerId()), ...botState },
    tunnel: tunnelState,
    voice: { ...voiceState, language: config.whisper.language || 'ru' },
    mail: { ...mailState, enabled: config.mail.enabled },
    linkedin: linkedin.status(),
    mcp: mcpSummary(),
    workspace: config.workspaceDir,
    // Secrets are shown only on the Mac itself.
    pairingCode: local && !ownerId() ? config.pairingCode : null,
    // Only the owner gets here (the API is authorized), so the personal link can be shown.
    dashboardLink: config.publicUrl ? `${config.publicUrl}/?token=${config.dashboardToken}` : null,
    offerUrl: config.owner.siteUrl || null,
    owner: config.owner.name,
  };
}

const projectWithStatus = (p) => ({
  ...p,
  running: Boolean(get("SELECT id FROM runs WHERE project_id = ? AND status IN ('running','queued') LIMIT 1", p.id)),
  last: get('SELECT id, status, prompt, result, finished_at, started_at FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 1', p.id) || null,
});

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/state', ({ req }) => state(req));

route('GET', '/api/inbox', ({ url }) => {
  const filter = url.searchParams.get('filter') || 'open';
  const where = filter === 'open' ? "WHERE status IN ('new','routed','error','done','forwarded')" : '';
  return all(`SELECT * FROM inbox ${where} ORDER BY id DESC LIMIT 100`).map((i) => ({ ...i, decision: i.decision ? JSON.parse(i.decision) : null }));
});
// The owner pressed the button in the dashboard: the message is approved.
route('POST', '/api/inbox/:id/forward', async ({ p, body }) => ({ runId: await forwardItem(Number(p.id), { projectId: body.project_id, task: typeof body.task === 'string' ? body.task.trim() : undefined, approved: true }) }));
route('POST', '/api/inbox/:id/restore', ({ p }) => restoreItem(Number(p.id)));
route('GET', '/api/inbox/:id/history', async ({ p }) => chatHistory(Number(p.id)));
route('POST', '/api/inbox/:id/suggest', async ({ p, body }) => suggestReply(Number(p.id), String(body.hint || '').slice(0, 1000)));
route('POST', '/api/inbox/:id/reply', async ({ p, body }) => replyItem(Number(p.id), { text: body.text }));
route('POST', '/api/inbox/:id/ignore', ({ p }) => ignoreItem(Number(p.id)));
route('POST', '/api/inbox/:id/reclassify', async ({ p }) => { await classify(Number(p.id)); return { ok: true }; });

route('GET', '/api/projects', () => all('SELECT * FROM projects ORDER BY is_default DESC, name').map(projectWithStatus));
route('POST', '/api/projects', ({ body }) => {
  if (!body.name?.trim()) throw new Error('Нужно название');
  if (body.cwd?.trim()) { checkCwd(body.cwd); body.cwd = body.cwd.trim().replace(/^~(?=\/)/, process.env.HOME); }
  const cwd = body.cwd?.trim() || path.join(config.workspaceDir, body.name.trim());
  const res = run('INSERT INTO projects (name, cwd, session_id, description, keywords, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    body.name.trim(), cwd, body.session_id || null, body.description || '', body.keywords || '', now());
  addLog('system', `Новый проект «${body.name.trim()}»`);
  bus.change('project');
  return { id: Number(res.lastInsertRowid) };
});
const checkCwd = (cwd) => {
  if (cwd !== undefined && !path.isAbsolute(String(cwd).trim().replace(/^~(?=\/)/, process.env.HOME))) throw new Error('Папка должна быть полным путём, например /Users/… или ~/…');
};
route('PATCH', '/api/projects/:id', ({ p, body }) => {
  checkCwd(body.cwd);
  if (body.cwd) body.cwd = String(body.cwd).trim().replace(/^~(?=\/)/, process.env.HOME);
  const keys = ['name', 'cwd', 'description', 'keywords', 'session_id'].filter((k) => k in body);
  if (keys.length) run(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => body[k] || (k === 'session_id' ? null : '')), Number(p.id));
  bus.change('project', Number(p.id));
  return { ok: true };
});
route('DELETE', '/api/projects/:id', ({ p }) => {
  const pr = get('SELECT * FROM projects WHERE id = ?', Number(p.id));
  if (pr?.is_default) throw new Error('Общий проект удалить нельзя');
  run('DELETE FROM projects WHERE id = ?', Number(p.id));
  bus.change('project');
  return { ok: true };
});
route('POST', '/api/projects/:id/message', ({ p, body }) => ({ runId: startRun({ projectId: Number(p.id), prompt: body.prompt, origin: 'ui' }) }));
route('POST', '/api/projects/:id/new-session', ({ p }) => {
  run('UPDATE projects SET session_id = NULL WHERE id = ?', Number(p.id));
  bus.change('project', Number(p.id));
  return { ok: true };
});
route('GET', '/api/projects/:id/timeline', ({ p }) => {
  const runs = all('SELECT * FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 15', Number(p.id)).reverse();
  return runs.map((r) => ({ ...r, events: all('SELECT id, kind, content, created_at FROM run_events WHERE run_id = ? ORDER BY id', r.id) }));
});
route('GET', '/api/projects/:id/past', async ({ p, url }) => pastMessages(get('SELECT * FROM projects WHERE id = ?', Number(p.id)), Math.min(200, Number(url.searchParams.get('limit')) || 60)));
route('POST', '/api/runs/:id/stop', ({ p }) => ({ ok: stopRun(Number(p.id)) }));

// A screenshot or file for a session: base64 in, saved path out.
route('POST', '/api/upload', ({ body }) => {
  const data = String(body.data || '').replace(/^data:[^,]*,/, '');
  if (!data) throw new Error('Пустой файл');
  return { path: saveUpload(body.name || 'file', Buffer.from(data, 'base64')) };
});
// Список сессий. После перехода на MiniMax функция называется sessions,
// но старый дашборд зовёт прежний маршрут — держим оба.
const listSessions = () => agent.sessions || agent.claudeSessions;
route('GET', '/api/claude-sessions', ({ url }) => listSessions()(Math.min(1000, Number(url.searchParams.get('limit')) || 60)));
route('GET', '/api/sessions', ({ url }) => listSessions()(Math.min(1000, Number(url.searchParams.get('limit')) || 60)));
route('POST', '/api/claude-sessions/attach', ({ body }) => {
  const existing = get('SELECT id FROM projects WHERE session_id = ?', body.sessionId);
  if (existing) return { id: existing.id };
  const res = run('INSERT INTO projects (name, cwd, session_id, created_at) VALUES (?, ?, ?, ?)', (body.name || 'Сессия').slice(0, 60), body.cwd || config.workspaceDir, body.sessionId, now());
  bus.change('project');
  return { id: Number(res.lastInsertRowid) };
});

// Social: the live MAX channel plus the latest Metricool report.
route('GET', '/api/social', async ({ url }) => {
  let channel = null;
  let channelError = null;
  try { channel = await channelStats(url.searchParams.get('force') === '1'); } catch (e) { channelError = e.message; }
  return { ...socialState(), channel, channelError, goal: content.goalState(channel?.subscribers ?? null), linkedin: { ...linkedin.status(), posts: linkedin.posts().slice(0, 10) } };
});
route('POST', '/api/social/refresh', () => ({ runId: refreshReport() }));

// Content studio (src/content.js).
route('GET', '/api/content', () => content.contentState());
route('GET', '/api/content/insights', async ({ url }) => {
  const part = url.searchParams.get('part');
  const safe = (p) => p.catch((e) => ({ error: e.message }));
  if (part === 'analysis') return safe(content.analysis());
  if (part === 'sales') return safe(content.attribution());
  if (part === 'rivals') return safe(content.competitorStats());
  throw new Error('part: analysis, sales или rivals');
});
route('POST', '/api/content/generate', ({ body }) => content.generate({ topic: body.topic, networks: body.networks, link: Boolean(body.link), ideaId: body.idea_id ? Number(body.idea_id) : null, source: body.source || null }));
route('PATCH', '/api/content/posts/:id', ({ p, body }) => content.updatePost(Number(p.id), body));
route('DELETE', '/api/content/posts/:id', ({ p }) => content.deletePost(Number(p.id)));
route('POST', '/api/content/posts/:id/publish', ({ p }) => content.publishNow(Number(p.id)));
route('POST', '/api/content/posts/:id/schedule', ({ p, body }) => content.schedule(Number(p.id), Number(body.at)));
route('POST', '/api/content/posts/:id/unschedule', ({ p }) => content.unschedule(Number(p.id)));
route('POST', '/api/content/ideas', ({ body }) => content.addIdea({ title: body.title }));
route('POST', '/api/content/ideas/refresh', () => { content.refreshIdeas().catch((e) => addLog('error', `Банк идей: ${e.message}`)); return { ok: true }; });
route('PATCH', '/api/content/ideas/:id', ({ p, body }) => content.setIdeaStatus(Number(p.id), body.status === 'dropped' ? 'dropped' : 'new'));
route('POST', '/api/content/competitors', ({ body }) => content.addCompetitor(body.username));
route('POST', '/api/content/competitors/find', () => ({ runId: content.findCompetitors() }));
route('DELETE', '/api/content/competitors/:u', ({ p }) => content.removeCompetitor(decodeURIComponent(p.u)));
route('POST', '/api/content/goal', ({ body }) => content.setGoal(body));
route('POST', '/api/content/auto', ({ body }) => content.setAutoConfig(body));
route('POST', '/api/content/auto/run', () => { content.autoFromRivals(6).catch((e) => addLog('error', `Автопосты: ${e.message}`)); return { ok: true }; });

// Finance: expenses from bank mails, receipts and manual entries.
route('GET', '/api/finance', async () => ({ ...financeSummary(), rates: await rates() }));
route('POST', '/api/finance', ({ body }) => {
  if (!(Number(body.amount) > 0)) throw new Error('Нужна сумма');
  return addExpense({ amount: Number(body.amount), currency: body.currency || 'VND', merchant: String(body.merchant || '').slice(0, 120), category: body.category || undefined, note: String(body.note || '').slice(0, 300), at: body.at ? Date.parse(body.at) : undefined, source: 'вручную' });
});
route('DELETE', '/api/finance/:id', ({ p }) => deleteExpense(Number(p.id)));

// Day view and notes (Apple apps through macos-apps-mcp).
route('GET', '/api/agenda', () => agenda());
route('GET', '/api/reminders', () => upcomingReminders());
route('POST', '/api/reminders', ({ body }) => {
  if (!String(body.title || '').trim()) throw new Error('Пустое напоминание');
  return createReminder({ title: String(body.title).trim().slice(0, 300), due: body.due || undefined });
});
route('POST', '/api/reminders/complete', ({ body }) => completeReminder(String(body.id)));
route('POST', '/api/events', ({ body }) => {
  if (!body.title || !body.start || !body.end) throw new Error('Нужны название, начало и конец');
  return createEvent({ title: String(body.title).slice(0, 200), start: body.start, end: body.end, location: body.location });
});
// Memory tab: shared notes, the approval queue, history, and search over all history.
route('GET', '/api/memory', () => ({ notes: memory.listMemory(), pending: memory.listPending(), types: memory.MEMORY_TYPES, stats: recallStats(), dir: memory.MEMORY_DIR }));
route('PUT', '/api/memory/:name', ({ p, body }) => memory.saveMemory({ name: decodeURIComponent(p.name), title: body.title, description: body.description, type: body.type, body: body.body }));
route('DELETE', '/api/memory/:name', ({ p }) => memory.deleteMemory(decodeURIComponent(p.name)));
route('GET', '/api/memory/:name/history', ({ p }) => memory.memoryHistory(decodeURIComponent(p.name)));
route('POST', '/api/memory/pending/:name/approve', ({ p }) => memory.approvePending(decodeURIComponent(p.name)));
route('DELETE', '/api/memory/pending/:name', ({ p }) => memory.rejectPending(decodeURIComponent(p.name)));
route('GET', '/api/recall', ({ url }) => recall({ query: url.searchParams.get('q'), kind: url.searchParams.get('kind') || null, limit: 20 }));
route('GET', '/api/recall/open', ({ url }) => recallOpen(String(url.searchParams.get('ref') || '')));
route('GET', '/api/notes', ({ url }) => notesList(String(url.searchParams.get('q') || '').slice(0, 100)));
route('GET', '/api/notes/body', ({ url }) => noteBody(String(url.searchParams.get('id') || '')));
route('POST', '/api/notes', ({ body }) => {
  if (!String(body.title || '').trim()) throw new Error('Нужен заголовок');
  return createNote({ title: String(body.title).slice(0, 200), body: String(body.body || '').slice(0, 20000) });
});

route('GET', '/api/tasks', () => {
  const next = nextRuns();
  return all('SELECT * FROM tasks ORDER BY id').map((t) => ({ ...t, next_run: next[t.id] ?? null }));
});
route('POST', '/api/tasks', ({ body }) => ({ id: createTask(body) }));
route('POST', '/api/tasks/validate', ({ body }) => ({ next: validateCron(body.cron) }));
route('PATCH', '/api/tasks/:id', ({ p, body }) => { updateTask(p.id, body); return { ok: true }; });
route('DELETE', '/api/tasks/:id', ({ p }) => { deleteTask(p.id); return { ok: true }; });
route('POST', '/api/tasks/:id/run', ({ p }) => ({ runId: fireTask(p.id, true) }));

route('GET', '/api/contacts', () => all('SELECT * FROM contacts ORDER BY updated_at DESC'));
route('PATCH', '/api/contacts/:id', ({ p, body }) => {
  if (body.mode && !['ask', 'auto', 'ignore'].includes(body.mode)) throw new Error('Неверный режим');
  if (body.mode) run('UPDATE contacts SET mode = ?, updated_at = ? WHERE chat_id = ?', body.mode, now(), p.id);
  if ('project_id' in body) run('UPDATE contacts SET project_id = ?, updated_at = ? WHERE chat_id = ?', body.project_id || null, now(), p.id);
  bus.change('contact');
  return { ok: true };
});

route('GET', '/api/log', () => all('SELECT * FROM log ORDER BY id DESC LIMIT 200'));
route('POST', '/api/stop-all', () => { stopAll(); return { ok: true }; });
route('POST', '/api/resume', () => { resumeAll(); return { ok: true }; });

// ---------- вебхук MAX ----------
// MAX шлёт события бота на подписанный адрес и передаёт секрет подписки
// в заголовке X-Max-Bot-Api-Secret. Сравниваем его постоянным временем:
// сперва длины, потом сами байты.
function maxSecretOk(req, secret) {
  const got = req.headers['x-max-bot-api-secret'];
  if (!got || !secret) return false;
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(secret));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Обработчик событий живёт в ./max-bot.js. Импортируем лениво: файл может
// появиться позже, и его отсутствие не должно ронять веб-сервер.
async function dispatchMaxUpdate(update) {
  try {
    const mod = await import('./max-bot.js');
    if (typeof mod.handleMaxUpdate !== 'function') {
      addLog('error', 'MAX: в ./max-bot.js нет функции handleMaxUpdate');
      return;
    }
    await mod.handleMaxUpdate(update);
  } catch (e) {
    addLog('error', `MAX: событие не обработано: ${e.message}`);
  }
}

// Публичный приёмник событий MAX: /max/webhook. Доступ не по токену пульта,
// а по секрету подписки.
async function maxWebhook(req, res) {
  const secret = config.max.webhookSecret;
  // Без секрета принимать нельзя: иначе события слал бы кто угодно.
  if (!secret) return send(res, 503, 'Вебхук MAX не настроен');
  if (!maxSecretOk(req, secret)) return send(res, 401, 'Нет доступа');
  let update;
  try {
    update = await readBody(req, 1_000_000);
  } catch (e) {
    return send(res, 400, 'Плохое событие');
  }
  if (!update || typeof update !== 'object' || Array.isArray(update)) return send(res, 400, 'Плохое событие');
  // MAX ждёт ответ не дольше 30 секунд, а обработка может быть долгой:
  // отвечаем сразу, а событие разбираем в фоне. Повторы доставки MAX
  // (до 10 раз) этим не ломаются: дедупликация по id события — в max-bot.js.
  send(res, 200, { ok: true });
  void dispatchMaxUpdate(update);
  return undefined;
}

// ---------- server ----------
const CSP = [
  "default-src 'self'",
  // Мост MAX Mini App лежит на своём домене: без него в script-src скрипт
  // моста зарежется и window.WebApp не появится.
  "script-src 'self' https://st.max.ru",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Не найдено');
  const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
  // The page holds the key to the Mac: scripts only from here.
  // The MAX Mini App bridge is connected separately, once its host is known.
  if (file.endsWith('.html')) headers['content-security-policy'] = CSP;
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

function sse(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  const onChange = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  bus.on('change', onChange);
  req.on('close', () => { clearInterval(ping); bus.off('change', onChange); });
}

export function startWeb() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      // ?token=... sets a long-lived cookie, then strips the token from the address bar.
      const t = url.searchParams.get('token');
      if (t && safeEq(t, config.dashboardToken)) {
        return send(res, 302, '', { location: '/', 'set-cookie': `mf_token=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${isLocal(req) ? '' : '; Secure'}` });
      }
      // LinkedIn login: only from this Mac (the registered callback is localhost).
      if (url.pathname.startsWith('/oauth/linkedin/')) {
        // Start: only Kai (this machine or the dashboard cookie). Callback: guarded by the one-time state.
        const tok = cookies(req).mf_token;
        const owner = isLocal(req) || (tok && safeEq(String(tok), config.dashboardToken));
        if (url.pathname === '/oauth/linkedin/start' && !owner) return send(res, 403, 'Открой пульт по личной ссылке, потом нажми «Подключить LinkedIn» в «Системе».');
        const page = (title, text) => send(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:16px -apple-system,sans-serif;display:grid;place-items:center;height:90vh;background:#0f1012;color:#eee"><div style="text-align:center;max-width:420px"><h2>${title}</h2><p style="color:#aaa">${text}</p><a href="/" style="color:#ec7a48">Вернуться в пульт</a></div>`, { 'content-type': 'text/html; charset=utf-8' });
        if (url.pathname === '/oauth/linkedin/start') {
          if (!linkedin.configured()) return page('LinkedIn не настроен', 'Впиши LINKEDIN_CLIENT_ID и LINKEDIN_CLIENT_SECRET в .env и перезапусти мейнфрейм.');
          return send(res, 302, '', { location: linkedin.authUrl() });
        }
        if (url.pathname === '/oauth/linkedin/callback') {
          if (url.searchParams.get('error')) return page('LinkedIn не подключён', url.searchParams.get('error_description') || url.searchParams.get('error'));
          try {
            const me = await linkedin.handleCallback(url.searchParams.get('code'), url.searchParams.get('state'));
            return page('LinkedIn подключён ✅', `Аккаунт ${me.name || ''}. Теперь сессии могут публиковать посты от твоего имени (только после твоего «да»).`);
          } catch (e) { return page('Не получилось', e.message); }
        }
      }
      // Вебхук MAX: подписка бота, доступ по секрету из заголовка.
      if (url.pathname === '/max/webhook') {
        if (req.method !== 'POST') return send(res, 405, 'Метод не поддерживается');
        return maxWebhook(req, res);
      }
      if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
      const who = authorized(req);
      if (!who) return send(res, 401, { error: 'Нет доступа. Открой через бота или по ссылке с токеном.' });
      if (url.pathname === '/api/events') return sse(req, res);
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) return send(res, 404, { error: 'Нет такого метода' });
      const m = url.pathname.match(r.re);
      const p = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req, req.url.startsWith('/api/upload') ? 30_000_000 : 1_000_000) : {};
      const out = await r.handler({ req, url, p, body, who });
      return send(res, 200, out ?? { ok: true });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  });
  // Resolves once the port is ours. A second copy (e.g. launchd plus a manual `npm start`)
  // fails here, before it can start a duplicate bot, tunnel or MAX connection.
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      console.log(`\n  Мейнфрейм: http://${config.host}:${config.port}`);
      if (!ownerId() && config.max.token) console.log(`  Код привязки бота: /start ${config.pairingCode}`);
      resolve(server);
    });
  });
}
