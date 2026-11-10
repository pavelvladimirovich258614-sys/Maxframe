// Social: the channel in MAX live (the bot reads only the chats it is in, so it is the
// channel the bot was added to) and a daily Metricool report that a scheduled session writes
// with the save_social_report tool (Metricool is a connector, so only a session can reach it).
import { config } from './config.js';
import { get, run, now, kvGet, kvSet, addLog } from './db.js';
import { bus } from './bus.js';
import * as maxChats from './max-chats.js';
import { createTask, fireTask } from './scheduler.js';
import { onRunFinished } from './agent.js';

// The channel of the owner: the numeric chat_id of the channel in MAX.
const channelName = () => config.social.chatId;

let cache = { at: 0, data: null };
export async function channelStats(force = false) {
  if (!config.max.enabled) throw new Error('MAX не настроен: нужен MAX_BOT_TOKEN');
  const ch = channelName();
  if (!ch) throw new Error('Канал не настроен: укажи SOCIAL_MAX_CHAT_ID (числовой chat_id канала MAX)');
  if (!force && cache.data && Date.now() - cache.at < 5 * 60000) return cache.data;
  const [full, msgs] = await Promise.all([
    maxChats.getChat(ch),
    maxChats.listMessages(ch, { count: 15 }),
  ]);
  const posts = msgs.map((m) => ({
    id: m.id,
    // MAX gives the time in seconds.
    date: m.timestamp ? m.timestamp * 1000 : null,
    text: String(m.text || '').slice(0, 280),
    media: null,
    // The Bot API of MAX does not give the views, the reactions and the comments of a
    // message: the numbers stay empty instead of being made up.
    views: null,
    reactions: null,
    forwards: null,
    comments: null,
    link: null,
  }));
  const subs = full?.participants_count ?? null;
  // Subscriber history: one point per day, so the tab can show the trend.
  const hist = kvGet('channel_history', []);
  const day = new Date().toISOString().slice(0, 10);
  if (subs !== null && hist[hist.length - 1]?.day !== day) { hist.push({ day, subs }); kvSet('channel_history', hist.slice(-120)); }
  const weekAgo = hist.find((h) => h.day >= new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
  cache = {
    at: Date.now(),
    data: {
      title: full?.title || null,
      username: full?.username || null,
      // The chat id is the address of the channel in MAX: there is no public link.
      chat_id: ch,
      about: full?.description ?? full?.about ?? null,
      subscribers: subs,
      subs_change_7d: weekAgo && subs !== null && weekAgo.day !== day ? subs - weekAgo.subs : null,
      avg_views: null,
      reach_pct: null,
      er_pct: null,
      posts,
    },
  };
  return cache.data;
}

const REPORT_PROMPT = () => `Собери сводку по соцсетям владельца и сохрани её инструментом mainframe save_social_report. Только чтение: ничего не публикуй, не планируй и не меняй.

1. Metricool: getBrandSettings даст brandId и timezone. Для каждой подключённой сети (instagram, tiktok, youtube, threads, facebook) возьми последние 7 дней и предыдущие 7 дней: подписчиков (последнее значение), прирост за неделю, просмотры или охват, число публикаций, вовлечённость. Метрики ищи через getAnalyticsAvailableMetrics (connector evolution), данные через getAnalyticsDataByMetrics. Сеть без данных оставь с note.
2. Лучшее время публикаций на ближайные 7 дней: getBestTimeToPostByNetwork для instagram и tiktok, по 3 лучших слота.
3. Запланированные посты на 7 дней вперёд: getScheduledPosts.
4. Канал владельца в MAX (chat_id ${channelName() || 'не задан'}). Публичного поиска каналов и ссылок на посты в MAX нет, а просмотры и реакции бот не получает: свежие посты посмотри через mainframe recall (вид «chat») и опиши их без цифр. Подписчиков канала бери из Metricool, если сеть там подключена.
5. 3-5 советов: конкретно, из цифр (что публиковать, где и когда, что повторить, от чего отказаться). Без общих слов и без длинных тире.

Числа передавай числами. В конце коротко напиши итог.`;

export function ensureSocialTask() {
  let pid = kvGet('social_project_id', null);
  if (!pid || !get('SELECT id FROM projects WHERE id = ?', pid)) {
    pid = Number(run('INSERT INTO projects (name, cwd, description, created_at) VALUES (?, ?, ?, ?)', 'Соцсети', config.workspaceDir, 'Ежедневная сводка по соцсетям: Metricool и канал в MAX', now()).lastInsertRowid);
    kvSet('social_project_id', pid);
  }
  let tid = kvGet('social_task_id', null);
  if (!tid || !get('SELECT id FROM tasks WHERE id = ?', tid)) {
    tid = createTask({ name: 'Сводка по соцсетям', cron: '0 9 * * *', prompt: REPORT_PROMPT(), project_id: pid });
    kvSet('social_task_id', tid);
  }
  return { pid, tid };
}

// Each report starts a fresh session: yesterday's numbers must not pile up in the context.
onRunFinished((r) => {
  const pid = kvGet('social_project_id', null);
  const briefs = get("SELECT id FROM projects WHERE name = 'Сводки'")?.id;
  if ((pid && r.project_id === pid) || (briefs && r.project_id === briefs)) run('UPDATE projects SET session_id = NULL WHERE id = ?', r.project_id);
});

export function refreshReport() {
  const { tid } = ensureSocialTask();
  return fireTask(tid, true);
}

export function saveReport(report) {
  kvSet('social_report', { ...report, generated_at: Date.now() });
  addLog('system', 'Сводка по соцсетям обновлена');
  bus.change('social');
}

export function socialState() {
  const { pid, tid } = ensureSocialTask();
  const running = get("SELECT id FROM runs WHERE project_id = ? AND status IN ('running', 'queued') ORDER BY id DESC LIMIT 1", pid);
  return { report: kvGet('social_report', null), taskId: tid, projectId: pid, running: Boolean(running) };
}
