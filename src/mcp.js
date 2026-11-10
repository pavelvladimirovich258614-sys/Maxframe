// Tools of the mainframe.
//
// The Claude Agent SDK used to build the in-process "mainframe" MCP server and
// to mount the servers from mcp.json. With MiniMax the model calls plain
// functions, so the same tools are described here in one registry and the
// external MCP servers are bridged through the MCP SDK client.
//
// Tool contract:
//   { name, description, parameters (JSON Schema), handler(args) -> string, dangerous? }

import fs from 'node:fs';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from './config.js';
import { all, addLog } from './db.js';
import { saveMemory, deleteMemory, listMemory } from './memory.js';
import { recall, recallOpen, formatRecall } from './recall.js';

const handlers = {
  notify: async () => { throw new Error('Бот не настроен'); },
  createTask: async () => { throw new Error('Планировщик не запущен'); },
};
export const setMainframeHandlers = (h) => Object.assign(handlers, h);

export function readMcpConfig() {
  if (!fs.existsSync(config.mcpFile)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(config.mcpFile, 'utf8'));
    const servers = raw.mcpServers || raw;
    return Object.fromEntries(Object.entries(servers).filter(([name, s]) => !name.startsWith('_') && s && !s.disabled));
  } catch (e) {
    addLog('error', `mcp.json не читается: ${e.message}`);
    return {};
  }
}

// JSON Schema for the model, derived from the same zod shapes the old server used.
const schemaOf = (shape) => {
  const properties = {};
  const required = [];
  for (const [key, def] of Object.entries(shape)) {
    const optional = def.isOptional();
    const inner = def.isOptional() ? def.unwrap() : def;
    const type = inner._def?.typeName;
    if (type === 'ZodNumber') properties[key] = { type: 'number' };
    else if (type === 'ZodBoolean') properties[key] = { type: 'boolean' };
    else if (type === 'ZodArray') {
      const item = inner._def?.type;
      const itemType = item?._def?.typeName === 'ZodNumber' ? 'number' : 'string';
      properties[key] = { type: 'array', items: { type: itemType } };
    } else if (type === 'ZodEnum') {
      properties[key] = { type: 'string', enum: inner._def?.values || [] };
    } else properties[key] = { type: 'string' };
    if (!optional) required.push(key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
};

const tool = (name, description, shape, handler) => ({
  name: `mcp__mainframe__${name}`,
  description,
  parameters: schemaOf(shape),
  handler,
});

// ---- the mainframe's own tools ---------------------------------------------
export function mainframeTools() {
  return [
    tool('notify_owner', 'Отправить владельцу сообщение в его бот управления (итог, вопрос, напоминание).',
      { text: z.string().describe('Текст сообщения') },
      async ({ text }) => { await handlers.notify(text); return 'Отправлено владельцу'; }),

    tool('create_cron_task', 'Создать задачу по расписанию в мейнфрейме. cron в формате "мин час день месяц день_недели", часовой пояс сервера.',
      {
        name: z.string(),
        cron: z.string().describe('Например "0 9 * * 1-5"'),
        prompt: z.string().describe('Что сделать при запуске'),
        project_id: z.number().int().optional().describe('ID проекта; без него задача идёт в общий проект'),
      },
      async (args) => { const id = await handlers.createTask(args); return `Задача создана, id ${id}`; }),

    tool('save_social_report', 'Сохранить сводку по соцсетям для вкладки «Соцсети» в пульте. Вызывай в конце задачи «Сводка по соцсетям».',
      {
        period: z.string().describe('Например "1–7 ноября"'),
        summary: z.string().describe('Итог в 1-3 предложения'),
        networks: z.array(z.object({
          network: z.string().describe('instagram, tiktok, youtube, threads, facebook, max'),
          handle: z.string().optional(),
          followers: z.number().nullable().optional(),
          followers_change: z.number().nullable().optional().describe('Прирост за 7 дней'),
          views: z.number().nullable().optional().describe('Просмотры или показы за 7 дней'),
          reach: z.number().nullable().optional(),
          posts: z.number().nullable().optional().describe('Публикаций за 7 дней'),
          engagement: z.number().nullable().optional().describe('Вовлечённость, %'),
          change_note: z.string().optional().describe('Сравнение с прошлой неделей словами'),
          note: z.string().optional(),
        })),
        best_times: z.array(z.object({ network: z.string(), slots: z.array(z.string()).describe('Например "вт 19:00"') })).optional(),
        scheduled: z.array(z.object({ network: z.string(), when: z.string(), text: z.string() })).optional(),
        advice: z.array(z.string()).describe('3-5 конкретных советов из цифр'),
      },
      async (report) => { handlers.saveSocial(report); return 'Сводка сохранена, вкладка «Соцсети» обновлена'; }),

    tool('restart_mainframe', 'Перезапустить мейнфрейм, чтобы применить изменения в его коде (src/*.js). Перезапуск произойдёт сам, когда закончатся все текущие задачи, включая эту: сначала закончи ответ.', {},
      async () => { handlers.requestRestart(); return 'Перезапуск запланирован: мейнфрейм перезапустится, когда закончатся все задачи (около 5 секунд после последней).'; }),

    tool('add_expense', 'Записать расход владельца во вкладку «Финансы» (чек, перевод, наличные). Сумма числом, валюта кодом (VND, RUB, USD, KZT).',
      {
        amount: z.number(),
        currency: z.string().default('VND'),
        merchant: z.string().optional().describe('Где или кому'),
        category: z.string().optional().describe('Например еда, транспорт и доставка, жильё, сервисы и подписки'),
        note: z.string().optional(),
        at: z.string().optional().describe('Дата и время ISO; без него сейчас'),
      },
      async (e) => { const r = handlers.addExpense({ ...e, at: e.at ? Date.parse(e.at) : undefined, source: 'сессия' }); return r.added ? `Записано, id ${r.id}` : 'Такой расход уже есть'; }),

    tool('set_balance', 'Обновить остаток на счёте владельца во вкладке «Финансы» (по скриншоту банка или биржи). account: понятное имя счёта, например «Т-Банк Black», «BIDV», «Bybit (все активы)».',
      { account: z.string(), amount: z.number(), currency: z.string(), note: z.string().optional() },
      async (b) => { handlers.setBalance(b); return 'Остаток обновлён'; }),

    tool('list_expenses', 'Расходы владельца за период и итоги по валютам и категориям за месяц.',
      { days: z.number().int().default(1).describe('За сколько последних дней') },
      async ({ days }) => JSON.stringify(handlers.financeSummaryFor(days), null, 1)),

    tool('linkedin_post', 'Опубликовать пост в LinkedIn от имени владельца. ВЫЗЫВАЙ ТОЛЬКО после того, как показал владельцу итоговый текст и он явно ответил «да»/«публикуй». Можно со ссылкой (появится карточка ссылки).',
      { text: z.string().max(3000), link: z.string().url().optional() },
      async (a) => { const r = await handlers.linkedinPost(a); return r.url ? `Опубликовано: ${r.url}` : 'Опубликовано'; }),

    tool('linkedin_status', 'Подключён ли LinkedIn владельца и сколько дней осталось до переподключения.', {},
      async () => JSON.stringify(handlers.linkedinStatus())),

    tool('content_save_drafts', 'Сохранить черновики постов в студию вкладки «Соцсети» (владелец поправит, запланирует или опубликует сам). Используй, когда владелец просит написать посты. В тексте можно поставить {{link}}: подставится ссылка на бесплатный урок с меткой этого поста.',
      { topic: z.string(), posts: z.array(z.object({ network: z.enum(['max', 'linkedin', 'instagram', 'threads', 'tiktok', 'youtube', 'facebook']), text: z.string(), notes: z.string().optional().describe('Сценарий рилс или слайды карусели') })) },
      async (a) => { const ids = handlers.contentSaveDrafts(a); return `Сохранено черновиков: ${ids.length}. Они во вкладке «Соцсети» → «Студия».`; }),

    tool('content_mark', 'Отметить результат постановки поста студии в Metricool.',
      { id: z.number().int(), status: z.enum(['scheduled', 'metricool_draft', 'published', 'failed']), url: z.string().optional(), error: z.string().optional() },
      async (a) => { handlers.contentMark(a); return 'Отмечено'; }),

    tool('content_add_competitors', 'Добавить MAX-каналы в список наблюдения во вкладке «Соцсети» → «Конкуренты». Канал должен быть числовым chat_id: бот читает только те каналы, где он состоит.',
      { chat_ids: z.array(z.string()).describe('Числовые chat_id каналов MAX, где состоит бот') },
      async ({ chat_ids }) => { const out = []; for (const c of chat_ids) { try { await handlers.contentAddCompetitor(c); out.push(`${c}: ок`); } catch (e) { out.push(`${c}: ${e.message}`); } } return out.join('\n'); }),

    tool('content_save_ideas', 'Добавить темы в банк идей вкладки «Соцсети».',
      { ideas: z.array(z.object({ title: z.string(), angle: z.string().optional(), why: z.string().optional(), score: z.number().int().min(1).max(10).optional() })) },
      async ({ ideas }) => { for (const i of ideas) handlers.contentAddIdea({ ...i, source: 'сессия' }); return `Добавлено идей: ${ideas.length}`; }),

    tool('memory_save', 'Сохранить или обновить заметку в общей памяти владельца (видна всем сессиям мейнфрейма). Одна заметка на факт; та же name перезаписывает заметку. type: user (кто владелец), feedback (правило работы, с причиной), people (человек и отношения), project (проект, решение, договорённость, с датой), reference (где что лежит, ссылки).',
      { name: z.string().describe('короткий slug, латиница или кириллица через дефис'), title: z.string(), description: z.string().describe('одна строка: о чём заметка, для оглавления'), type: z.enum(['user', 'feedback', 'people', 'project', 'reference']), body: z.string().describe('сам факт; для правил и решений добавь «Почему:» и «Как применять:»; даты абсолютные'), pending: z.boolean().optional().describe('true: не сразу в память, а владельцу на проверку (для ночной выжимки)') },
      async (a) => { const r = saveMemory(a); return r.pending ? `Отправлено владельцу на проверку: ${r.file}` : r.updated ? `Обновлено: ${r.file}` : `Сохранено: ${r.file}`; }),

    tool('memory_delete', 'Убрать устаревшую или неверную заметку из общей памяти владельца.', { name: z.string() },
      async ({ name }) => { deleteMemory(name); return 'Убрано'; }),

    tool('memory_list', 'Оглавление общей памяти владельца: файлы, типы, описания, даты обновления.', {},
      async () => listMemory().map((n) => `${n.file} [${n.type}, ${n.updated}] ${n.title}: ${n.description}`).join('\n') || 'Память пуста'),

    tool('recall', 'Поиск по всей истории владельца: сессии мейнфрейма (его запросы и ответы), входящие, почта, рабочие группы, переписка в MAX по дням, общая память. Для вопросов «что решили», «что писал X», «когда обсуждали». Ищет по словам (основа слова, регистр не важен). Результаты с датой и источником; полный текст через recall_open.',
      { query: z.string().describe('ключевые слова, например «Аня договор оплата»'), kind: z.enum(['session', 'max', 'mail', 'group', 'chat', 'memory']).optional().describe('chat: переписка в MAX по дням; max: входящие из MAX'), days: z.number().int().optional().describe('только за последние N дней'), limit: z.number().int().optional() },
      async (a) => formatRecall(recall(a))),

    tool('recall_open', 'Открыть целиком запись из поиска recall по её ref (переписка за день, сессия, письмо).', { ref: z.string() },
      async ({ ref }) => { const d = recallOpen(ref); return `${d.title} (${new Date(d.at || 0).toLocaleString('ru')})\n\n${d.body.slice(0, 30000)}`; }),

    tool('list_projects', 'Список проектов мейнфрейма с их папками.', {},
      async () => JSON.stringify(all('SELECT id, name, cwd, description FROM projects'), null, 1)),
  ];
}

// ---- external MCP servers --------------------------------------------------
const mcpState = { servers: {}, error: null };

const clients = new Map(); // server name -> { client, tools }

async function connectServer(name, spec) {
  if (clients.has(name)) return clients.get(name);
  const client = new Client({ name: `mainframe-${name}`, version: '0.1.0' });
  let transport;
  if (spec.url) {
    transport = new StreamableHTTPClientTransport(new URL(spec.url));
  } else if (spec.command) {
    transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args || [],
      env: { ...process.env, ...(spec.env || {}) },
    });
  } else {
    throw new Error('В mcp.json сервер должен иметь url или command');
  }
  await client.connect(transport);
  const listed = await client.listTools();
  const tools = (listed.tools || []).map((t) => ({
    name: `mcp__${name}__${t.name}`,
    description: t.description || '',
    parameters: t.inputSchema || { type: 'object', properties: {} },
    mcpServer: name,
    mcpTool: t.name,
    handler: async (args) => {
      const res = await client.callTool({ name: t.name, arguments: args || {} });
      const body = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (res.isError) throw new Error(body || `${t.name} вернул ошибку`);
      return body;
    },
  }));
  const entry = { client, tools, error: null };
  clients.set(name, entry);
  mcpState.servers[name] = { connected: true, tools: tools.length };
  return entry;
}

// The tools of every configured MCP server. A server that fails to start is
// reported and skipped: one broken server must not kill the session.
export async function mcpTools() {
  const config_ = readMcpConfig();
  const out = [];
  for (const [name, spec] of Object.entries(config_)) {
    try {
      const entry = await connectServer(name, spec);
      out.push(...entry.tools);
    } catch (e) {
      clients.delete(name);
      mcpState.servers[name] = { connected: false, error: e.message };
      mcpState.error = e.message;
      addLog('error', `MCP ${name}: ${e.message.slice(0, 200)}`);
    }
  }
  return out;
}

export function mcpSummary() {
  const list = Object.keys(readMcpConfig());
  const state = Object.values(mcpState.servers);
  return {
    servers: list,
    connected: state.filter((s) => s.connected).length,
    failed: state.filter((s) => !s.connected).length,
  };
}

export async function closeMcp() {
  for (const entry of clients.values()) {
    await entry.client.close().catch(() => {});
  }
  clients.clear();
}
