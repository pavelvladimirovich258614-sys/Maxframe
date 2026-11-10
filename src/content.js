// Content studio for the Social tab: drafts per network, calendar and publishing, idea bank,
// post analysis, competitors, a subscriber goal and course attribution (leads and payments
// from the course bot's notifications, matched to UTM-tagged links in our posts).
// MAX and LinkedIn are published directly: the bot writes into the channel it is in and
// LinkedIn through its own access. The other networks go through Metricool, which only a
// session can reach, so they are handed to the «Соцсети» project.
import { config } from './config.js';
import { all, get, run, now, kvGet, kvSet, addLog } from './db.js';
import { bus } from './bus.js';
import * as maxChats from './max-chats.js';
import { structured, startRun } from './agent.js';
import * as linkedin from './linkedin.js';
import { ensureSocialTask, channelStats } from './social.js';
import { ownerContext } from './memory.js';
import { MaxKeyboard } from './max-keyboard.js';

run(`CREATE TABLE IF NOT EXISTS content_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch TEXT, topic TEXT, network TEXT NOT NULL, text TEXT NOT NULL, notes TEXT,
  idea_id INTEGER, status TEXT NOT NULL DEFAULT 'draft', scheduled_at INTEGER, published_at INTEGER,
  url TEXT, ext_id TEXT, error TEXT, track TEXT, created_at INTEGER, updated_at INTEGER)`);
run(`CREATE TABLE IF NOT EXISTS content_ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, angle TEXT, why TEXT, source TEXT, score INTEGER, status TEXT NOT NULL DEFAULT 'new', created_at INTEGER)`);

export const NETWORKS = {
  max: 'MAX', linkedin: 'LinkedIn', instagram: 'Instagram', threads: 'Threads', tiktok: 'TikTok', youtube: 'YouTube Shorts', facebook: 'Facebook',
};
const DIRECT = new Set(['max', 'linkedin']);
// The network of a post. The posts made before the move to MAX lie in the base with the old
// key, and such a post belongs to the channel: an unknown network is read as the channel.
const netKey = (network) => (NETWORKS[network] ? network : 'max');
// MAX does not give the views and the reactions of a message, so the analysis of the posts
// can count the formats and the lengths, but cannot rank the posts by reach.
const hasMedia = (text) => /\[(фото|видео|голосовое|файл|стикер|контакт|геометка)/i.test(String(text || ''));
const contentModel = () => process.env.CONTENT_MODEL || 'sonnet';
const change = () => bus.change('content');
const day = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const trackedLink = (network, track) => `${config.owner.siteUrl}?utm_source=${network}&utm_campaign=mf&utm_content=${track}`;

const STYLE = () => `Ты пишешь посты от имени ${config.owner.name}${config.social.chatId ? ` (канал в MAX, chat_id ${config.social.chatId})` : ''}.${config.owner.about ? ` ${config.owner.about}` : ''} Кто он, что продаёт и как говорит, смотри в разделе «О владельце» ниже.
Стиль: от первого лица, просто и живо, как владелец говорит. Короткие абзацы. Без длинных тире (символ — запрещён, ставь запятую, точку или двоеточие). Без канцелярита и штампов вроде «в современном мире», «давайте разберёмся», «погрузимся», «не просто X, а Y». Без лишних англицизмов. Только факты и цифры из исходных данных, ничего не выдумывай: ни кейсов, ни цифр, ни отзывов. Без обещаний и гарантий результата.
Под сети:
- max: 400–1200 знаков, 0–2 эмодзи. Концовка разная: короткий вывод, совет, мнение, иногда вопрос. Не заканчивай каждый пост вопросом «А у вас…?» и смайликом.
- linkedin: деловой тон, 700–1500 знаков, первая строка цепляет, до 3 хэштегов в конце.
- instagram: подпись до 900 знаков; в notes сценарий рилс на 30–45 секунд по кадрам или 5–7 слайдов карусели.
- threads: до 450 знаков, одна мысль.
- tiktok и youtube: в text подпись до 150 знаков; в notes сценарий 30–45 секунд: хук в первые 3 секунды, суть, призыв.
- facebook: как max.
Поле notes заполняй только для instagram, tiktok и youtube (сценарий или слайды), для остальных сетей оставь пустым.
Ссылку (${config.owner.offerCta}) ставь меткой {{link}} (ровно одна на пост), только если её просят.`;

const DRAFTS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['posts'],
  properties: { posts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['network', 'text'], properties: { network: { type: 'string', enum: Object.keys(NETWORKS) }, text: { type: 'string' }, notes: { type: 'string' } } } } },
};

// ---------- The owner's voice and the anti-slop pass ----------
// Real posts from the channel are the style reference; every draft is checked for the usual
// machine-text tells and rewritten once if any are found, then dashes are removed mechanically.
const SLOP = [
  [/—|\s–\s/, 'длинное тире'],
  [/не просто [^.,!?]{1,50}, а /i, 'конструкция «не просто X, а Y»'],
  [/давайте|разберёмся|разберемся|погрузимся|погружаемся/i, '«давайте», «разберёмся», «погрузимся»'],
  [/в современном мире|в эпоху|в наше время|стремительно развива/i, 'вступление про «современный мир»'],
  [/важно (отметить|понимать|помнить)|стоит отметить|следует отметить/i, '«важно отметить»'],
  [/ключев(ой|ая|ое|ые) (роль|момент|фактор)|играет (важную|ключевую) роль/i, '«ключевая роль»'],
  [/революци|прорыв|меняет правила игры|game.?changer|игра ?чейнджер|новая эра/i, 'громкие слова («революция», «прорыв», «новая эра»)'],
  [/уникальн|инновацион|беспрецедент/i, '«уникальный», «инновационный»'],
  [/в заключение|подводя итог|итак,|таким образом,/i, '«в заключение», «итак», «таким образом»'],
  [/(^|\n)\s*(💡|🔥|✅|👉|🚀|📌|⚡️?)[^\n]*\n\s*(💡|🔥|✅|👉|🚀|📌|⚡️?)/u, 'эмодзи в начале строк списком'],
  [/(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}].*){4,}/su, 'больше трёх эмодзи'],
  [/это (не )?(просто )?(магия|волшебство)|звучит как магия/i, '«это магия»'],
  [/представьте(,| себе)/i, '«представьте себе»'],
  [/не секрет, что|ни для кого не секрет/i, '«не секрет, что»'],
  [/[🤔🙂😊👇]\s*$/u, 'смайлик в самом конце поста'],
  [/что я бы делал на вашем месте/i, 'шаблон «что я бы делал на вашем месте»'],
];
export const slopCheck = (text) => SLOP.filter(([re]) => re.test(String(text))).map(([, name]) => name);

let styleCache = { at: 0, text: '' };
async function styleExamples() {
  if (styleCache.text && Date.now() - styleCache.at < 24 * 3600000) return styleCache.text;
  try {
    if (!config.social.chatId) return styleCache.text;
    // The newest posts of the channel: the bot reads the chats it is in.
    const posts = (await maxChats.listMessages(config.social.chatId, { count: 80 }))
      .filter((m) => String(m.text || '').length > 250).slice(-8);
    styleCache = { at: Date.now(), text: posts.map((m, i) => `Пример ${i + 1}:\n${String(m.text).slice(0, 900)}`).join('\n\n') };
  } catch { /* the style rules still apply without examples */ }
  return styleCache.text;
}
async function styleSystem() {
  const ex = await styleExamples();
  return `${STYLE()}${ownerContext() ? `\n\nО владельце (из его памяти):\n${ownerContext()}` : ''}${ex ? `\n\nНастоящие посты владельца из его канала. Пиши так же: такая же длина фраз, такие же слова, такая же интонация, так же мало пафоса. Не копируй их содержание.\n\n${ex}` : ''}`;
}
const REWRITE_SCHEMA = { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } };
export async function writeClean(prompt) {
  const system = await styleSystem();
  const out = await structured({ prompt, schema: DRAFTS_SCHEMA, system, tools: [], maxTurns: 3, model: contentModel() });
  for (const p of out.posts) {
    const issues = slopCheck(p.text);
    if (issues.length) {
      try {
        const r = await structured({ system, tools: [], maxTurns: 3, model: contentModel(), schema: REWRITE_SCHEMA,
          prompt: `Перепиши пост для ${p.network} так, чтобы он звучал как живой владелец, а не как текст нейросети. Убери: ${issues.join('; ')}. Мысль, факты, ссылки и длину сохрани, остальное не трогай.\n\n"""\n${p.text}\n"""` });
        if (r.text && slopCheck(r.text).length < issues.length) p.text = r.text;
      } catch { /* keep the first version */ }
    }
    p.text = p.text.replace(/\s*—\s*/g, ', ').replace(/\s–\s/g, ', ');
  }
  return out;
}

// ---------- drafts ----------
export function saveDrafts({ topic, posts, ideaId = null, batch = `b${Date.now()}` }) {
  const ids = [];
  for (const p of posts) {
    if (!NETWORKS[p.network] || !String(p.text || '').trim()) continue;
    const id = Number(run('INSERT INTO content_posts (batch, topic, network, text, notes, idea_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      batch, String(topic || '').slice(0, 300), p.network, p.text, ['instagram', 'tiktok', 'youtube'].includes(p.network) ? p.notes || null : null, ideaId, 'draft', now(), now()).lastInsertRowid);
    const track = `p${id}`;
    const text = String(p.text).replace(/—/g, ',').replace(/\{\{link\}\}/g, trackedLink(p.network, track));
    run('UPDATE content_posts SET text = ?, track = ? WHERE id = ?', text, track, id);
    ids.push(id);
  }
  if (ideaId) run("UPDATE content_ideas SET status = 'used' WHERE id = ?", ideaId);
  change();
  return ids;
}

let generating = null;
export function generate({ topic, networks, link = false, ideaId = null, source = null }) {
  const nets = (networks || []).filter((n) => NETWORKS[n]);
  if (!nets.length) throw new Error('Выбери хотя бы одну сеть');
  if (!String(topic || source || '').trim()) throw new Error('Напиши тему или вставь текст');
  if (generating) throw new Error('Уже пишу посты, подожди минуту');
  generating = { topic: String(topic || source).slice(0, 120), networks: nets, at: Date.now() };
  change();
  const prompt = `${source ? `Перепакуй этот пост владельца под другие сети. Сохрани мысль и факты, меняй форму под сеть.\n\nИсходный пост:\n"""\n${String(source).slice(0, 4000)}\n"""\n` : `Тема или черновик мысли от владельца:\n"""\n${String(topic).slice(0, 4000)}\n"""\n`}
Сети: ${nets.join(', ')}. По одному посту на каждую сеть.${link ? ` В каждый пост поставь {{link}}: ${config.owner.offerCta}, с понятным призывом перед ней.` : ' Ссылку на продукт не ставь.'}`;
  writeClean(prompt)
    .then((out) => { saveDrafts({ topic: generating.topic, posts: out.posts, ideaId }); addLog('system', `Студия: ${out.posts.length} черновиков «${generating.topic.slice(0, 60)}»`); })
    .catch((e) => { addLog('error', `Студия: ${e.message}`); kvSet('content_gen_error', { message: e.message, at: Date.now() }); })
    .finally(() => { generating = null; change(); });
  return { ok: true };
}

export function updatePost(id, patch) {
  const p = get('SELECT * FROM content_posts WHERE id = ?', id);
  if (!p) throw new Error('Пост не найден');
  if (['published', 'sending'].includes(p.status)) throw new Error('Этот пост уже ушёл');
  if (patch.text != null) run('UPDATE content_posts SET text = ?, updated_at = ? WHERE id = ?', String(patch.text).replace(/—/g, ','), now(), id);
  change();
  return { ok: true };
}
export function deletePost(id) { run("DELETE FROM content_posts WHERE id = ? AND status NOT IN ('published', 'sending')", id); change(); return { ok: true }; }

// ---------- publishing ----------
async function notifyOwner(text, extra) {
  try { const { sendOwner } = await import('./max-bot.js'); return await sendOwner(text, extra); } catch { return null; }
}
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function viaMetricool(p, at) {
  const { pid } = ensureSocialTask();
  const when = new Date(at || Date.now() + 10 * 60000);
  startRun({ projectId: pid, origin: 'system', prompt: `Владелец подтвердил публикацию кнопкой в пульте. Поставь пост в Metricool, больше ничего не публикуй и не меняй.
1. getBrandSettings: brand и часовой пояс.
2. createScheduledPost в сеть ${p.network} на ${when.toISOString()} (переведи в часовой пояс бренда). Текст ниже без изменений.${p.notes ? ' Сценарий из заметок не публикуй, это подсказка для съёмки.' : ''}
   Если сеть требует фото или видео (Instagram, TikTok, YouTube), а их нет, создай пост черновиком на эту дату, чтобы владелец добавил медиа в Metricool.
3. Вызови mainframe content_mark: id ${p.id}, status "scheduled" (или "metricool_draft", если черновик), при ошибке status "failed" и error.

Текст:
"""
${p.text}
"""` });
  run("UPDATE content_posts SET status = 'sending', scheduled_at = ?, updated_at = ? WHERE id = ?", when.getTime(), now(), p.id);
  change();
}

// The bot publishes only into the channel it is in. The channel is set by its numeric chat_id.
async function publishToChannel(text) {
  const chatId = config.social.chatId;
  if (!chatId) throw new Error('Канал не настроен: укажи SOCIAL_MAX_CHAT_ID (числовый chat_id канала MAX)');
  try {
    const res = await maxChats.sendMessage(chatId, text);
    return res?.mid || res?.message?.mid || res?.message?.body?.mid || null;
  } catch (e) {
    throw new Error(`Не отправилось в канал MAX ${chatId}: ${e.message.slice(0, 200)}. Бот должен состоять в этом канале.`);
  }
}

export async function publishNow(id) {
  const p = get('SELECT * FROM content_posts WHERE id = ?', id);
  if (!p) throw new Error('Пост не найден');
  if (['published', 'sending'].includes(p.status)) throw new Error('Пост уже ушёл');
  const network = netKey(p.network);
  if (!DIRECT.has(network)) { viaMetricool(p, null); return { ok: true, via: 'metricool' }; }
  run("UPDATE content_posts SET status = 'sending', updated_at = ? WHERE id = ?", now(), id);
  change();
  try {
    let url = null; let ext = null;
    if (network === 'max') {
      ext = await publishToChannel(p.text);
    } else {
      const r = await linkedin.post({ text: p.text });
      url = r.url; ext = r.id;
    }
    run("UPDATE content_posts SET status = 'published', published_at = ?, url = ?, ext_id = ?, error = NULL, updated_at = ? WHERE id = ?", now(), url, ext ? String(ext) : null, now(), id);
    addLog('system', `Опубликован пост #${id} в ${NETWORKS[network]}`);
    change();
    return { ok: true, url };
  } catch (e) {
    run("UPDATE content_posts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", e.message.slice(0, 300), now(), id);
    change();
    throw e;
  }
}

export function schedule(id, at) {
  const p = get('SELECT * FROM content_posts WHERE id = ?', id);
  if (!p) throw new Error('Пост не найден');
  if (['published', 'sending'].includes(p.status)) throw new Error('Пост уже ушёл');
  if (!(at > Date.now() + 60000)) throw new Error('Выбери время в будущем');
  if (!DIRECT.has(netKey(p.network))) { viaMetricool(p, at); return { ok: true, via: 'metricool' }; }
  run("UPDATE content_posts SET status = 'scheduled', scheduled_at = ?, error = NULL, updated_at = ? WHERE id = ?", at, now(), id);
  change();
  return { ok: true };
}
export function unschedule(id) {
  const p = get('SELECT * FROM content_posts WHERE id = ?', id);
  if (!p || p.status !== 'scheduled') throw new Error('Пост не запланирован');
  if (!DIRECT.has(netKey(p.network))) throw new Error('Этот пост стоит в Metricool: отмени его там');
  run("UPDATE content_posts SET status = 'draft', scheduled_at = NULL, updated_at = ? WHERE id = ?", now(), id);
  change();
  return { ok: true };
}
export function markPost({ id, status, url, error }) {
  run('UPDATE content_posts SET status = ?, url = COALESCE(?, url), error = ?, updated_at = ? WHERE id = ?', status, url || null, error || null, now(), id);
  change();
}

// ---------- ideas ----------
const IDEAS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ideas'],
  properties: { ideas: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'why', 'source', 'score'], properties: { title: { type: 'string' }, angle: { type: 'string' }, why: { type: 'string' }, source: { type: 'string' }, score: { type: 'integer', minimum: 1, maximum: 10 } } } } },
};
let ideasBusy = false;
export function addIdea({ title, angle = null, why = null, source = 'вручную', score = null }) {
  if (!String(title || '').trim()) throw new Error('Пустая идея');
  run('INSERT INTO content_ideas (title, angle, why, source, score, created_at) VALUES (?, ?, ?, ?, ?, ?)', String(title).slice(0, 300), angle, why, source, score, now());
  change();
  return { ok: true };
}
export function setIdeaStatus(id, status) { run('UPDATE content_ideas SET status = ? WHERE id = ?', status, id); change(); return { ok: true }; }

export async function refreshIdeas() {
  if (ideasBusy) throw new Error('Уже собираю идеи');
  ideasBusy = true;
  change();
  try {
    const ch = await channelStats().catch(() => null);
    // There are no views in MAX, so the longest posts of the channel are taken as the base.
    const top = (ch?.posts || []).filter((p) => p.text).sort((a, b) => b.text.length - a.text.length).slice(0, 5);
    const questions = (await botMessages().catch(() => [])).filter((m) => /^Вопрос от/.test(m.text)).slice(0, 15).map((m) => m.text.slice(0, 300));
    const thoughts = all("SELECT prompt FROM runs WHERE origin = 'bot' AND started_at > ? ORDER BY id DESC LIMIT 40", Date.now() - 14 * 86400000)
      .map((r) => r.prompt.replace(/\s+/g, ' ').slice(0, 250)).filter((t) => t.length > 40);
    const rivals = (await competitorStats().catch(() => ({ items: [] }))).items.flatMap((c) => c.top.slice(0, 2).map((p) => `${c.title}: ${p.text.slice(0, 200)}`));
    const existing = all("SELECT title FROM content_ideas WHERE created_at > ? ", Date.now() - 30 * 86400000).map((i) => i.title);
    const out = await structured({
      system: await styleSystem(), tools: [], maxTurns: 3, model: contentModel(), schema: IDEAS_SCHEMA,
      prompt: `Предложи 8 тем для постов владельца на ближайшую неделю. Опирайся только на данные ниже. Для каждой: title (тема в одну строку, как заголовок), angle (с какой стороны зайти, 1 предложение), why (почему сработает, со ссылкой на данные), source (откуда: «посты канала», «вопросы учеников», «мысли владельца», «конкуренты»), score 1–10 (сила темы для продажи курса и роста канала).
Не повторяй темы: ${existing.join('; ').slice(0, 1500) || 'нет'}.

Посты владельца из его канала (в MAX нет просмотров, поэтому это самые длинные и свежие):
${top.map((p) => `- ${p.text.slice(0, 200)}`).join('\n') || 'нет данных'}

Вопросы людей из бота продаж:
${questions.join('\n') || 'нет'}

Мысли и задачи владельца за 2 недели (голосовые и сообщения в бот, не всё про контент, выбирай подходящее):
${thoughts.join('\n') || 'нет'}

Что пишут похожие каналы:
${rivals.join('\n') || 'нет данных'}`,
    });
    for (const i of out.ideas) addIdea(i);
    kvSet('ideas_day', day());
    addLog('system', `Банк идей: +${out.ideas.length}`);
    return { added: out.ideas.length };
  } finally {
    ideasBusy = false;
    change();
  }
}

// ---------- analysis of the channel's posts ----------
let analysisCache = { at: 0, data: null };
export async function analysis() {
  if (analysisCache.data && Date.now() - analysisCache.at < 30 * 60000) return analysisCache.data;
  const chatId = config.social.chatId;
  if (!chatId) throw new Error('Канал не настроен: укажи SOCIAL_MAX_CHAT_ID (числовой chat_id канала MAX)');
  const msgs = await maxChats.listMessages(chatId, { count: 50 });
  const posts = msgs.map((m) => ({
    id: m.id, at: (m.timestamp ? m.timestamp * 1000 : 0) || null, text: String(m.text || '').slice(0, 300), len: String(m.text || '').length,
    media: hasMedia(m.text), views: null, reactions: null, forwards: null, comments: null, link: null,
  })).filter((p) => typeof p.at === 'number' && Date.now() - p.at > 86400000);
  if (!posts.length) return (analysisCache = { at: Date.now(), data: { count: 0 } }).data;
  const group = (fn, labels) => labels.map(([key, label]) => { const xs = posts.filter((p) => fn(p) === key); return { label, n: xs.length, avg: null }; }).filter((g) => g.n);
  const hour = (p) => new Date(p.at).getHours();
  const data = {
    count: posts.length, avgViews: null, best: [], worst: [],
    // MAX does not give the views and the reactions: the posts cannot be ranked by reach.
    note: 'MAX не отдаёт просмотры и реакции: ранжировать посты по охвату нельзя, показаны формат, длина и время выхода.',
    factors: [
      { title: 'Формат', rows: group((p) => (p.media ? 'm' : 't'), [['m', 'с фото или видео'], ['t', 'только текст']]) },
      { title: 'Длина', rows: group((p) => (p.len < 500 ? 's' : p.len < 1500 ? 'm' : 'l'), [['s', 'до 500 знаков'], ['m', '500–1500'], ['l', 'больше 1500']]) },
      { title: 'Время выхода', rows: group((p) => { const h = hour(p); return h < 6 ? 'n' : h < 12 ? 'm' : h < 18 ? 'd' : 'e'; }, [['m', 'утро 6–12'], ['d', 'день 12–18'], ['e', 'вечер 18–24'], ['n', 'ночь 0–6']]) },
    ],
  };
  analysisCache = { at: Date.now(), data };
  return data;
}

// ---------- course attribution from the course bot's notifications ----------
async function botMessages() {
  if (!config.owner.salesBot) return [];
  // The room of the course bot is a chat_id as well.
  const msgs = await maxChats.listMessages(config.owner.salesBot, { count: 400 });
  return msgs
    .filter((m) => !(m.senderId && m.senderId === config.max.ownerId))
    .map((m) => ({ at: (m.timestamp ? m.timestamp * 1000 : 0) || 0, text: String(m.text || '') }))
    .filter((m) => m.at > Date.now() - 60 * 86400000);
}
const parseSource = (s) => {
  const q = Object.fromEntries(String(s || '').split('&').map((kv) => kv.split('=')).filter((x) => x.length === 2));
  if (q.utm_source) return { channel: q.utm_source, post: q.utm_content || null, raw: s };
  if (/^ref=/.test(s)) return { channel: s.slice(4), post: null, raw: s };
  return { channel: s || 'сайт', post: null, raw: s };
};
let attrCache = { at: 0, data: null };
export async function attribution() {
  if (attrCache.data && Date.now() - attrCache.at < 10 * 60000) return attrCache.data;
  const msgs = await botMessages();
  const leads = []; const pays = [];
  for (const m of msgs) {
    let r = m.text.match(/^Заявка[^:\n]*: (.+?), источник: (.+)$/s);
    if (r && !/test|проверка/i.test(r[1] + r[2])) leads.push({ at: m.at, name: r[1], ...parseSource(r[2].trim()) });
    r = m.text.match(/^Оплата[^:\n]*: (.+?), ([^,]+?)(?:, товар №\d+)?(?:, пришёл из (.+))?$/s);
    if (r) pays.push({ at: m.at, name: r[1], money: r[2], ...parseSource((r[3] || '').trim()) });
  }
  const by = (xs, key) => Object.entries(xs.reduce((a, x) => { const k = x[key] || '—'; a[k] = (a[k] || 0) + 1; return a; }, {}));
  const channels = [...new Set([...leads, ...pays].map((x) => x.channel))].map((c) => ({ channel: c, leads: leads.filter((x) => x.channel === c).length, pays: pays.filter((x) => x.channel === c).length })).sort((a, b) => b.leads - a.leads);
  const posts = by([...leads, ...pays].filter((x) => x.post), 'post').map(([track]) => {
    const p = get('SELECT id, network, text, url FROM content_posts WHERE track = ?', track);
    return { track, network: p?.network, text: p?.text?.slice(0, 120), url: p?.url, leads: leads.filter((x) => x.post === track).length, pays: pays.filter((x) => x.post === track).length };
  }).sort((a, b) => b.leads - a.leads);
  const month = Date.now() - 30 * 86400000;
  const data = { leads30: leads.filter((x) => x.at > month).length, pays30: pays.filter((x) => x.at > month).length, channels, posts, recent: [...leads.map((x) => ({ ...x, kind: 'lead' })), ...pays.map((x) => ({ ...x, kind: 'pay' }))].sort((a, b) => b.at - a.at).slice(0, 12) };
  attrCache = { at: Date.now(), data };
  return data;
}

// ---------- competitors ----------
// The rivals are the channels the bot is in. There is no search of the public chats in MAX:
// the channel is set by its numeric chat_id, and the bot reads only the chats it was added to.
export const competitors = () => kvGet('content_competitors', []);
const competitorId = (c) => String(c.chat_id ?? c.username ?? '');
let compCache = { at: 0, data: null, key: '' };
export async function addCompetitor(chatId) {
  const id = String(chatId || '').trim().replace(/^@/, '');
  if (!id) throw new Error('Нужен chat_id канала MAX');
  if (!/^-?\d+$/.test(id)) throw new Error('Нужен числовый chat_id канала MAX: бот читает только те каналы, где он состоит');
  const list = competitors();
  if (list.some((c) => competitorId(c) === id)) return { ok: true };
  let chat = null;
  try {
    chat = await maxChats.getChat(id);
  } catch (e) {
    throw new Error(`Чат ${id} недоступен боту: ${e.message.slice(0, 160)}. Бот видит только те каналы, где он состоит.`);
  }
  const title = chat?.title || id;
  list.push({ username: id, chat_id: id, title });
  kvSet('content_competitors', list);
  compCache.at = 0;
  change();
  return { ok: true, title };
}
export function removeCompetitor(u) {
  const id = String(u || '').trim();
  kvSet('content_competitors', competitors().filter((c) => competitorId(c) !== id));
  compCache.at = 0; change(); return { ok: true };
}
export async function competitorStats() {
  const list = competitors();
  const key = list.map(competitorId).join(',');
  if (compCache.data && compCache.key === key && Date.now() - compCache.at < 6 * 3600000) return compCache.data;
  const since = Date.now() - 7 * 86400000;
  const items = [];
  for (const c of list) {
    const id = competitorId(c);
    try {
      const chat = await maxChats.getChat(id);
      const msgs = await maxChats.listMessages(id, { count: 50 });
      // No views in MAX: the week is given by the posts themselves, the newest first.
      const posts = msgs.filter((m) => ((m.timestamp ? m.timestamp * 1000 : 0) || 0) > since).map((m) => ({
        id: m.id, at: (m.timestamp ? m.timestamp * 1000 : 0) || null, text: String(m.text || '').slice(0, 220), views: null, reactions: null, link: null,
      })).sort((a, b) => (b.at || 0) - (a.at || 0));
      items.push({ ...c, username: id, chat_id: id, url: null, subscribers: chat?.participants_count ?? null, posts7: posts.length, avgViews: null, top: posts.slice(0, 3) });
    } catch (e) { items.push({ ...c, username: id, chat_id: id, url: null, error: e.message.slice(0, 120), top: [] }); }
  }
  compCache = { at: Date.now(), key, data: { items } };
  return compCache.data;
}
export function findCompetitors() {
  const { pid } = ensureSocialTask();
  return startRun({ projectId: pid, origin: 'system', prompt: `Подбери владельцу 6–8 похожих каналов в MAX для наблюдения. Его канал: chat_id ${config.social.chatId || 'не задан'}. О чём канал и что владелец продаёт, посмотри в общей памяти и в последних постах канала (инструмент mainframe recall).
Ищи только те каналы, где состоит бот: публичного поиска каналов в MAX нет, а бот читает лишь те чаты, куда его добавили. Возьми кандидатов из памяти владельца и из его переписки (там встречаются каналы, на которые он подписан, с их названиями и chat_id).
Проверяй каждого через mainframe content_add_competitors: если чат недоступен боту, инструмент вернёт ошибку — такой канал не добавляй и скажи почему.
Уже в списке: ${competitors().map(competitorId).join(', ') || 'никого'}.
Сохрани найденных инструментом mainframe content_add_competitors (chat_id числами). Ничего не публикуй и ни на что не подписывайся. В конце одной строкой: кого добавил и почему.` });
}

// ---------- automatic drafts from the rivals' fresh posts ----------
export const autoConfig = () => kvGet('content_auto', { enabled: true, perDay: 3, networks: ['max'] });
export function setAutoConfig(patch) {
  const cfg = { ...autoConfig(), ...patch };
  cfg.perDay = Math.max(1, Math.min(6, Number(cfg.perDay) || 3));
  cfg.networks = (cfg.networks || ['max']).filter((n) => NETWORKS[n]);
  if (!cfg.networks.length) cfg.networks = ['max'];
  kvSet('content_auto', cfg);
  change();
  return cfg;
}
const words = (t) => new Set(String(t).toLowerCase().replace(/[^a-zа-яё0-9 ]/gi, ' ').split(/\s+/).filter((w) => w.length > 4));
const similar = (a, b) => { const A = words(a); const B = words(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); };
const AD_RE = /erid|#реклама|реклама\b|партн[её]рский материал|розыгрыш|giveaway|промокод/i;
let autoBusy = false;
export async function autoFromRivals(max = 2) {
  const cfg = autoConfig();
  if (!cfg.enabled || autoBusy) return { added: 0 };
  const today = day();
  const count = kvGet('content_auto_day', { day: today, n: 0 });
  if (count.day !== today) { count.day = today; count.n = 0; }
  const room = Math.min(max, cfg.perDay - count.n);
  if (room <= 0) return { added: 0 };
  autoBusy = true;
  change();
  try {
    const used = kvGet('content_auto_used', []);
    const cands = [];
    for (const c of competitors()) {
      try {
        const id = competitorId(c);
        const msgs = await maxChats.listMessages(id, { count: 50 });
        const posts = msgs.map((m) => ({ id: m.id, at: (m.timestamp ? m.timestamp * 1000 : 0) || 0, text: String(m.text || '') }))
          .filter((p) => p.at > Date.now() - 7 * 86400000);
        for (const p of posts) {
          const age = Date.now() - p.at;
          // MAX does not give the views: a fresh and substantial post is the signal here.
          if (age < 4 * 3600000 || age > 48 * 3600000 || p.text.length < 250 || AD_RE.test(p.text)) continue;
          const key = `${id}:${p.id}`;
          if (used.some((u) => u.key === key)) continue;
          cands.push({ key, channel: c.title, at: p.at, text: p.text });
        }
      } catch (e) { addLog('error', `Автопосты: ${c.title}: ${e.message.slice(0, 120)}`); }
    }
    cands.sort((a, b) => b.at - a.at);
    const recentMine = all('SELECT text FROM content_posts WHERE created_at > ?', Date.now() - 5 * 86400000).map((r) => r.text);
    const picked = [];
    for (const cnd of cands) {
      if (picked.length >= room) break;
      // One news story often runs in several channels at once: take it once.
      if ([...picked.map((x) => x.text), ...used.slice(-60).map((u) => u.text || ''), ...recentMine].some((t) => similar(t, cnd.text) > 0.35)) continue;
      picked.push(cnd);
    }
    let added = 0;
    for (const cnd of picked) {
      const prompt = `Повод для поста владельца: свежий большой пост в похожем канале «${cnd.channel}» от ${new Date(cnd.at).toLocaleString('ru')}. Значит, тема сейчас интересна аудитории.

Чужой пост (это только повод, не пересказывай его и не бери оттуда формулировки):
"""
${cnd.text.slice(0, 3500)}
"""

Напиши свой пост владельца на эту тему: коротко суть (только факты из поста выше, без новых цифр), потом взгляд владельца: что это значит для обычного человека или владельца бизнеса, которые хотят, чтобы ИИ работал на них, и что с этим делать. Не приписывай владельцу опыт, которого нет в данных: не пиши «я попробовал», «я протестировал», «у меня клиенты». Можно «по-моему», «я бы», «мой совет». Не упоминай чужой канал. Ссылку на курс не ставь.
Сети: ${cfg.networks.join(', ')}. По одному посту на сеть.`;
      try {
        const out = await writeClean(prompt);
        const ids = saveDrafts({ topic: `По мотивам «${cnd.channel}» (${new Date(cnd.at).toLocaleString('ru')})`, posts: out.posts });
        used.push({ key: cnd.key, text: cnd.text.slice(0, 400), at: Date.now() });
        kvSet('content_auto_used', used.slice(-300));
        count.n += 1; kvSet('content_auto_day', count);
        added += 1;
        // One message per network: each version gets its own publish button.
        await notifyOwner(`✍️ <b>Новый пост по мотивам «${esc(cnd.channel)}»</b>\nСвежий пост от ${new Date(cnd.at).toLocaleString('ru')}. Версий: ${ids.length}. Поправить или запланировать: пульт → «Соцсети» → «Студия».`, { notify: false, disableLinkPreview: true });
        for (const pid of ids) {
          const post = get('SELECT * FROM content_posts WHERE id = ?', pid);
          if (!post) continue;
          const kb = new MaxKeyboard()
            .text(`🚀 Опубликовать в ${NETWORKS[post.network]}`, `cpn:${post.id}`)
            .text('🗑 Не надо', `cpd:${post.id}`);
          await notifyOwner(`<b>${NETWORKS[post.network]}</b>${DIRECT.has(netKey(post.network)) ? '' : ' · через Metricool'}\n\n${esc(post.text.slice(0, 3800))}`, { kb, notify: false, disableLinkPreview: true });
        }
      } catch (e) { addLog('error', `Автопосты: ${e.message.slice(0, 200)}`); }
    }
    if (added) addLog('system', `Автопосты: ${added} черновиков по мотивам конкурентов`);
    return { added, candidates: cands.length };
  } finally {
    autoBusy = false;
    change();
  }
}

// ---------- subscriber goal ----------
export function setGoal({ target, deadline }) {
  if (!(Number(target) > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(deadline || '')) throw new Error('Нужны цель и дата');
  kvSet('social_goal', { target: Number(target), deadline, set_at: Date.now() });
  change();
  return { ok: true };
}
export function goalState(subs) {
  const g = kvGet('social_goal', null);
  if (!g) return null;
  const hist = kvGet('channel_history', []);
  const cur = subs ?? hist[hist.length - 1]?.subs ?? null;
  if (cur == null) return { ...g };
  const weekAgo = hist.find((h) => h.day >= day(Date.now() - 7 * 86400000)) || hist[0];
  const days = weekAgo ? Math.max(1, Math.round((Date.now() - Date.parse(weekAgo.day)) / 86400000)) : 0;
  const pace = days ? Math.round(((cur - weekAgo.subs) / days) * 10) / 10 : null;
  const daysLeft = Math.max(0, Math.ceil((Date.parse(g.deadline) - Date.now()) / 86400000));
  const need = daysLeft ? Math.round(((g.target - cur) / daysLeft) * 10) / 10 : null;
  const forecast = pace && pace > 0 ? day(Date.now() + ((g.target - cur) / pace) * 86400000) : null;
  return { ...g, current: cur, left: Math.max(0, g.target - cur), daysLeft, pace, need, forecast, onTrack: pace != null && need != null && pace >= need };
}

// ---------- state for the tab ----------
export function contentState() {
  const posts = all(`SELECT * FROM content_posts WHERE status != 'published' OR published_at > ? ORDER BY COALESCE(scheduled_at, published_at, created_at) DESC LIMIT 80`, Date.now() - 21 * 86400000)
    .map((p) => ({ ...p, network: netKey(p.network) }));
  const ideas = all("SELECT * FROM content_ideas WHERE status = 'new' ORDER BY COALESCE(score, 0) DESC, id DESC LIMIT 40");
  const err = kvGet('content_gen_error', null);
  return { posts, ideas, generating, ideasBusy, genError: err && Date.now() - err.at < 10 * 60000 ? err.message : null, networks: NETWORKS, direct: [...DIRECT], competitors: competitors(), goal: goalState(null), auto: { ...autoConfig(), today: (kvGet('content_auto_day', {}).day === day() ? kvGet('content_auto_day', {}).n : 0), busy: autoBusy } };
}

// ---------- background: due posts, morning confirmation, daily ideas ----------
export function startContent() {
  // There is no linked chat for the comments of a channel in MAX: the bot sees the channel
  // itself, so the comments are not a separate watched group anymore.
  const tick = async () => {
    for (const p of all("SELECT * FROM content_posts WHERE status = 'scheduled' AND scheduled_at <= ?", Date.now())) {
      if (!DIRECT.has(netKey(p.network))) continue;
      try {
        const r = await publishNow(p.id);
        const post = get('SELECT network FROM content_posts WHERE id = ?', p.id);
        await notifyOwner(`📣 Вышел пост в ${NETWORKS[netKey(post.network)]}${r.url ? `: <a href="${esc(r.url)}">открыть</a>` : ''}`, { notify: false });
      } catch (e) { await notifyOwner(`⚠️ Пост #${p.id} не вышел: ${esc(e.message.slice(0, 200))}`); }
    }
    const d = new Date();
    if (d.getHours() === 8 && d.getMinutes() >= 30 && kvGet('content_digest_day', '') !== day()) {
      kvSet('content_digest_day', day());
      const end = new Date(d); end.setHours(23, 59, 59, 999);
      const today = all("SELECT * FROM content_posts WHERE status IN ('scheduled', 'metricool_draft') AND scheduled_at BETWEEN ? AND ? ORDER BY scheduled_at", Date.now(), end.getTime());
      if (today.length) {
        const lines = today.map((p) => `<b>${new Date(p.scheduled_at).toTimeString().slice(0, 5)} · ${NETWORKS[netKey(p.network)]}</b>${DIRECT.has(netKey(p.network)) ? '' : ' (Metricool)'}\n<blockquote>${esc(p.text.slice(0, 600))}</blockquote>`);
        const kb = new MaxKeyboard().text('✅ Всё ок', 'cpok');
        for (const p of today.filter((x) => DIRECT.has(netKey(x.network)) && x.status === 'scheduled')) {
          kb.row()
            .text(`⏸ Снять ${NETWORKS[netKey(p.network)]} ${new Date(p.scheduled_at).toTimeString().slice(0, 5)}`, `cpx:${p.id}`)
            .text('🚀 Сейчас', `cpn:${p.id}`);
        }
        await notifyOwner(`🗓 <b>Сегодня выйдет</b>\n\n${lines.join('\n\n')}`, { kb });
      }
    }
    if ([11, 17].includes(d.getHours()) && kvGet('content_auto_slot', '') !== `${day()}-${d.getHours()}`) {
      kvSet('content_auto_slot', `${day()}-${d.getHours()}`);
      autoFromRivals(d.getHours() === 11 ? 2 : 6).catch((e) => addLog('error', `Автопосты: ${e.message}`));
    }
    if (d.getHours() === 7 && kvGet('ideas_day', '') !== day() && !ideasBusy) refreshIdeas().catch((e) => addLog('error', `Банк идей: ${e.message}`));
  };
  setTimeout(tick, 20000);
  setInterval(tick, 60000).unref();
}

// Buttons of the morning message.
export async function contentCallback(kind, id) {
  if (kind === 'cpok') return 'Принято';
  if (kind === 'cpx') { unschedule(Number(id)); return 'Снято, пост вернулся в черновики'; }
  if (kind === 'cpd') { for (const x of String(id).split(',')) deletePost(Number(x)); return 'Удалил черновик'; }
  if (kind === 'cpn') { const r = await publishNow(Number(id)); return r.url ? 'Опубликовано' : 'Отправлено'; }
  return null;
}
